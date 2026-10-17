'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const wire = require('./wire');
const { spawn } = require('child_process');

// Keep the existing synchronous extension contract and native graph cache in
// one persistent child process. Only data crosses this boundary. Atomic files
// work on Windows Node/Electron without relying on private pipe handles.
function create(loader, options = {}) {
  loader = path.resolve(loader);
  let child, directory, watcher, stopped = false, failed = false, sequence = 0, nextHandle = 1;
  let metadata, replayLicense, ipData;
  const handles = new Map(), reverse = new Map();
  const asyncQueue = [];
  let pending = null;
  const transportStats = { asyncRequests: 0, synchronousRequests: 0, synchronousDrains: 0 };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const alive = () => { try { process.kill(child.pid, 0); return true; } catch (_) { return false; } };
  function cleanup() {
    if(watcher){watcher.close();watcher=null;}
    const closed = new Error('Airtl runtime closed or changed'); closed.code = 'AIRTL_NATIVE_PROCESS_FAILED';
    if (pending) { clearTimeout(pending.timer); pending.reject(closed); pending = null; }
    for (const job of asyncQueue.splice(0)) job.reject(closed);
    if (child) { try { child.kill(); } catch (_) {} }
    child = null;
    if (directory) {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('airtl-runtime-')) throw new Error('Unsafe Airtl runtime cleanup path');
      try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (_) {}
    }
    directory = null;
  }
  function failure(reason) {
    failed = true; handles.clear(); reverse.clear(); cleanup();
    const error = new Error('Airtl 原生解析进程异常退出或超时，操作已中止。重新读取工程可重试。' + (reason ? ' ' + reason : ''));
    error.code = 'AIRTL_NATIVE_PROCESS_FAILED';
    return error;
  }
  function exchange(method, args, timeout = options.timeoutMs || 120000) {
    ++transportStats.synchronousRequests;
    // One owner for the file channel. Legacy synchronous calls may drain an
    // already dispatched async job, never overwrite its request or response.
    if (pending || asyncQueue.length) {
      ++transportStats.synchronousDrains;
      while (pending || asyncQueue.length) { pumpAsync(); if (pending) Atomics.wait(pause, 0, 0, 2); }
      if (failed) throw failure('Async request failed before synchronous call');
    }
    const id = ++sequence;
    const request = path.join(directory, 'request'), response = path.join(directory, 'response');
    const bytes = wire.pack({ id, method, args });
    fs.writeFileSync(request + '.tmp', bytes); fs.renameSync(request + '.tmp', request);
    const deadline = Date.now() + timeout;
    for (;;) {
      if (fs.existsSync(response)) {
        let result;
        try { result = wire.unpack(fs.readFileSync(response, 'utf8')); }
        catch (e) { throw failure('Invalid response: ' + e.message); }
        fs.unlinkSync(response);
        if (result.id !== id) throw failure('Response sequence mismatch');
        if (result.error) {
          const e = new Error(result.error.message); e.code = result.error.code; e.diagnostics = result.error.diagnostics; throw e;
        }
        return result.value;
      }
      if (!alive()) throw failure('Child process terminated');
      if (Date.now() >= deadline) throw failure('Timeout: ' + method);
      Atomics.wait(pause, 0, 0, 2);
    }
  }
  function enqueue(method, args) {
    return new Promise((resolve, reject) => { asyncQueue.push({ method, args, resolve, reject }); startAsync(); });
  }
  function startAsync() {
    if (pending || !asyncQueue.length) return;
    const job = asyncQueue.shift();
    try {
      if (stopped || failed || !alive()) throw failure('Native runtime unavailable');
      const entry = handles.get(job.args[0]);
      if (!entry) throw new Error('Airtl graph handle is stale or already released');
      const id = ++sequence, args = [entry.native, ...job.args.slice(1)];
      const request = path.join(directory, 'request');
      fs.writeFileSync(request + '.tmp', wire.pack({ id, method: job.method, args }));
      fs.renameSync(request + '.tmp', request);
      pending = { ...job, id, directory, deadline: Date.now() + (options.timeoutMs || 120000) };
      ++transportStats.asyncRequests;
      pending.timer = setTimeout(pumpAsync, 0);
    } catch (e) { job.reject(e); startAsync(); }
  }
  function pumpAsync() {
    if (!pending) { startAsync(); return; }
    const job = pending; clearTimeout(job.timer);
    try {
      const response = path.join(job.directory, 'response');
      if (fs.existsSync(response)) {
        const result = wire.unpack(fs.readFileSync(response, 'utf8')); fs.unlinkSync(response);
        if (result.id !== job.id) throw failure('Async response sequence mismatch');
        pending = null;
        if (result.error) { const e = new Error(result.error.message); e.code = result.error.code; e.diagnostics = result.error.diagnostics; job.reject(e); }
        else job.resolve(result.value);
        startAsync(); return;
      }
      if (!alive() || Date.now() >= job.deadline) throw failure('Async child termination or timeout');
      job.timer = setTimeout(pumpAsync, 3);
    } catch (e) { if (pending === job) { pending = null; job.reject(e); } if (!failed) failure('Invalid async response'); }
  }
  function start() {
    if (stopped) throw new Error('Airtl native runtime is disposed');
    // A non-graph call can be the first to notice a killed worker. Its new
    // native handle numbers must never reuse the previous session's mappings.
    handles.clear(); reverse.clear();
    cleanup(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airtl-runtime-'));
    try { watcher=fs.watch(directory,(_event,file)=>{if(String(file)==='response'&&pending)pumpAsync();});watcher.on('error',()=>{});watcher.unref(); } catch (_) {}
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.VSCODE_INSPECTOR_OPTIONS; delete env.NODE_OPTIONS;
    child = spawn(options.executable || process.execPath, [path.join(__dirname, 'worker.js'), directory, loader, String(process.pid)], {
      env, windowsHide: true, stdio: 'ignore'
    });
    // Spawn errors must be observable even while the caller is synchronously
    // waiting; the bounded startup deadline covers asynchronous spawn failures.
    child.on('error', () => {}); child.unref(); failed = false;
    metadata = exchange('__describe', [], options.startupTimeoutMs || 15000);
    if (replayLicense) exchange(replayLicense.method, replayLicense.args);
    if (ipData !== undefined) exchange('setIpPortData', [ipData]);
  }
  function call(method, args) {
    const graphCall = method !== 'graphLoad' && (method.startsWith('graph') || ['renderScope', 'renderScene', 'refineScene'].includes(method));
    if (stopped) throw new Error('Airtl native runtime is disposed');
    if (failed || !alive()) {
      if (method === 'graphFree') return undefined;
      if (method === 'graphLoad' || !graphCall) start();
      else throw failure('Reload the project to restart its parser');
    }
    let virtual;
    if (graphCall) {
      virtual = args[0]; const entry = handles.get(virtual);
      if (!entry) {
        if (method === 'graphFree') return undefined;
        throw new Error('Airtl graph handle is stale or already released');
      }
      args = [entry.native, ...args.slice(1)];
    }
    const value = exchange(method, args);
    if (method === 'graphLoad') {
      let key = reverse.get(value.handle);
      if (!key) { key = nextHandle++; reverse.set(value.handle, key); handles.set(key, { native: value.handle, refs: 0 }); }
      handles.get(key).refs++;
      return { ...value, handle: key };
    }
    if (method === 'graphFree') {
      const entry = handles.get(virtual);
      if (--entry.refs === 0) { handles.delete(virtual); reverse.delete(entry.native); }
    }
    if (method === 'licenseUseDefault' || method === 'licenseSetLicense') replayLicense = { method, args };
    if (method === 'setIpPortData') ipData = args[0];
    return value;
  }
  start();
  const api = { ...metadata.values };
  for (const method of metadata.functions) api[method] = (...args) => call(method, args);
  api.renderSceneAsync = (...args) => enqueue('renderScene', args);
  api.refineSceneAsync = (...args) => enqueue('refineScene', args);
  api.__runtimeInfo = () => ({ isolated: true, pid: child && child.pid, alive: alive(), session: directory && path.basename(directory), nativePath: metadata.nativePath, failed, disposed: stopped, ...transportStats });
  api.__shutdown = () => { stopped = true; cleanup(); process.removeListener('exit', exit); };
  const exit = () => cleanup();
  process.once('exit', exit);
  return api;
}
module.exports = { create };
