'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const wire = require('./wire');
const { spawn } = require('child_process');
const {RequestBudget}=require('./request-budget');
const DEFAULT_REQUEST_TIMEOUT_MS = 50000;
const DEFAULT_IO_TIMEOUT_MS = 15000;
const isGraphLoad=method=>method==='graphLoad'||method==='graphLoadCheckpoint';
const {AsyncLocalStorage}=require('async_hooks');
const {performance}=require('perf_hooks');

// Keep the existing synchronous extension contract and native graph cache in
// one persistent child process. Only data crosses this boundary. Atomic files
// work on Windows Node/Electron without relying on private pipe handles.
function create(loader, options = {}) {
  loader = path.resolve(loader);
  const requestTimeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const ioTimeoutMs=options.ioTimeoutMs||DEFAULT_IO_TIMEOUT_MS;
  let child, directory, watcher, stopped = false, failed = false, sequence = 0, nextHandle = 1;
  let metadata=options.metadata, replayLicense, ipData,bootstrap=null;
  const handles = new Map(), reverse = new Map();
  const workflows=new AsyncLocalStorage();
  const remaining=workflow=>workflow?workflow.limit-(performance.now()-workflow.started-workflow.ioMs):requestTimeoutMs;
  const asyncQueue = [];
  let pending = null;
  const transportStats = { asyncRequests: 0, synchronousRequests: 0, synchronousDrains: 0,
    cancelledQueuedRequests: 0, cancelledRunningRequests: 0 };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const alive = () => { try { process.kill(child.pid, 0); return true; } catch (_) { return false; } };
  function cleanup(reason) {
    if(watcher){watcher.close();watcher=null;}
    const closed = reason||new Error('Airtl runtime closed or changed'); closed.code = 'AIRTL_NATIVE_PROCESS_FAILED';
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
  function failure(reason,details) {
    const error = new Error('Airtl 原生解析进程异常退出或超时，操作已中止。重新读取工程可重试。' + (reason ? ' ' + reason : ''));
    error.code = 'AIRTL_NATIVE_PROCESS_FAILED';
    if(details)Object.assign(error,{...details,message:error.message});
    failed = true; handles.clear(); reverse.clear(); cleanup(error);
    return error;
  }
  function checkBudget(budget,force=false){const issue=budget.check(force);if(issue)throw failure(issue.message,issue);}
  function exchange(method, args, timeout = requestTimeoutMs) {
    const queueStarted=Date.now();let queueIo=0;const observedIo=new Map();
    ++transportStats.synchronousRequests;
    // One owner for the file channel. Legacy synchronous calls may drain an
    // already dispatched async job, never overwrite its request or response.
    if (pending || asyncQueue.length) {
      ++transportStats.synchronousDrains;
      if(pending){checkBudget(pending.budget,true);observedIo.set(pending.id,pending.budget.metrics.ioMs);}
      while (pending || asyncQueue.length) {
        const previous=pending;
        pumpAsync();
        for(const job of new Set([previous,pending]))if(job&&job.budget.metrics){const io=job.budget.metrics.ioMs;queueIo+=Math.max(0,io-(observedIo.get(job.id)||0));observedIo.set(job.id,io);}
        if(Date.now()-queueStarted-queueIo>=timeout)throw failure('Timeout waiting for queued requests before '+method,{timeoutKind:'compute',method});
        if (pending) Atomics.wait(pause, 0, 0, 2);
      }
      if (failed) throw failure('Async request failed before synchronous call');
    }
    const id = ++sequence;
    const remaining=timeout-Math.max(0,Date.now()-queueStarted-queueIo);
    const budget=new RequestBudget(id,method,path.join(directory,'progress'),remaining,ioTimeoutMs);
    const request = path.join(directory, 'request'), response = path.join(directory, 'response');
    const bytes = wire.pack({ id, method, args });
    fs.writeFileSync(request + '.tmp', bytes); fs.renameSync(request + '.tmp', request);
    if (child.stdin?.writable) child.stdin.write('.');
    for (;;) {
      if (fs.existsSync(response)) {
        let result;
        try { result = wire.unpack(fs.readFileSync(response, 'utf8')); }
        catch (e) { throw failure('Invalid response: ' + e.message); }
        fs.unlinkSync(response);
        if (result.id !== id) throw failure('Response sequence mismatch');
        budget.finish(result.runtimeProgress);checkBudget(budget,true);
        if (result.error) {
          const e = new Error(result.error.message); e.code = result.error.code; e.diagnostics = result.error.diagnostics; throw e;
        }
        return result.value;
      }
      if (!alive()) throw failure('Child process terminated');
      checkBudget(budget);
      Atomics.wait(pause, 0, 0, 2);
    }
  }
  async function readyAsync(){
    if(stopped)throw new Error('Airtl native runtime is disposed');
    if(bootstrap)return bootstrap;
    if(child&&alive()&&!failed)return;
    bootstrap=(async()=>{
      handles.clear();reverse.clear();cleanup();
      directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'airtl-runtime-'));
      if(stopped){cleanup();throw new Error('Airtl native runtime is disposed');}
      const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.VSCODE_INSPECTOR_OPTIONS;delete env.NODE_OPTIONS;
      child=spawn(options.executable||process.execPath,[path.join(__dirname,'worker.js'),directory,loader,String(process.pid)],{env,windowsHide:true,stdio:['pipe','ignore','ignore']});
      child.stdin.on('error',()=>{});
      let spawnError;child.on('error',error=>{spawnError=error;});child.unref();failed=false;
      try{watcher=fs.watch(directory,(_event,file)=>{if(String(file)==='response'&&pending)pumpAsync();});watcher.on('error',()=>{});watcher.unref();}catch{}
      const deadline=Date.now()+(options.startupTimeoutMs||15000),readyFile=path.join(directory,'ready');
      for(;;){
        if(stopped)throw new Error('Airtl native runtime is disposed');
        if(spawnError)throw failure(spawnError.message);
        try{metadata=JSON.parse(await fs.promises.readFile(readyFile,'utf8'));break;}catch(error){if(!['ENOENT','EACCES','EPERM'].includes(error.code)&&!(error instanceof SyntaxError))throw error;}
        if(Date.now()>=deadline||!alive())throw failure('Asynchronous runtime startup failed or timed out');
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      if(replayLicense)await dispatch(replayLicense.method,replayLicense.args);
      if(ipData!==undefined)await dispatch('setIpPortData',[ipData]);
    })();
    try{return await bootstrap;}finally{bootstrap=null;}
  }
  function enqueue(method,args,queueKey){
    // Preserve queue visibility for cancellation on an already ready worker.
    // An unconditional Promise hop would hide same-tick queued Scene work.
    if(!options.defer||(!bootstrap&&child&&alive()&&!failed))return dispatch(method,args,queueKey);
    return readyAsync().then(()=>dispatch(method,args,queueKey));
  }
  function dispatch(method, args, queueKey) {
    return new Promise((resolve, reject) => {
      asyncQueue.push({ method, args, queueKey, resolve, reject,workflow:workflows.getStore() });
      startAsync();
    });
  }
  function cancelAsync(queueKey, includeRunning = false) {
    if (queueKey === undefined || queueKey === null) return 0;
    let removed = 0;
    const superseded = () => Object.assign(new Error('Airtl async request superseded'),
      { code: 'AIRTL_REQUEST_SUPERSEDED' });
    for (let i = asyncQueue.length - 1; i >= 0; --i) {
      const job = asyncQueue[i];
      if (job.queueKey !== queueKey) continue;
      asyncQueue.splice(i, 1);
      job.reject(superseded());
      ++removed;
      ++transportStats.cancelledQueuedRequests;
    }
    if (includeRunning && pending && pending.queueKey === queueKey && !pending.cancelled) {
      // Native computation cannot be interrupted without destroying its graph.
      // Settle the obsolete caller now, but retain channel ownership, deadline
      // and response draining until that computation finishes safely.
      pending.cancelled = true;
      pending.reject(superseded());
      ++removed;
      ++transportStats.cancelledRunningRequests;
    }
    return removed;
  }
  function startAsync() {
    if (pending || !asyncQueue.length) return;
    const job = asyncQueue.shift();
    try {
      const graphCall = !isGraphLoad(job.method) &&
        (job.method.startsWith('graph') || ['renderScope', 'renderScene', 'refineScene'].includes(job.method));
      if(stopped)throw failure('Native runtime unavailable');
      if(failed||!alive()){
        if(options.defer)throw failure('Native runtime changed before dispatch; reload the project');
        else if(isGraphLoad(job.method)||!graphCall)start();
        else throw failure('Reload the project to restart its parser');
      }
      let virtual;
      let args = job.args;
      if (graphCall) {
        virtual = job.args[0];
        const entry = handles.get(virtual);
        if (!entry) throw new Error('Airtl graph handle is stale or already released');
        args = [entry.native, ...job.args.slice(1)];
      }
      const id = ++sequence;
      const request = path.join(directory, 'request');
      fs.writeFileSync(request + '.tmp', wire.pack({ id, method: job.method, args }));
      fs.renameSync(request + '.tmp', request);
      if (child.stdin?.writable) child.stdin.write('.');
      const computeRemaining=remaining(job.workflow);
      if(computeRemaining<=0)throw failure('Workflow non-I/O budget exhausted before '+job.method,{timeoutKind:'compute',method:job.method});
      pending = { ...job, id, directory, virtual, budget:new RequestBudget(id,job.method,path.join(directory,'progress'),computeRemaining,ioTimeoutMs) };
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
        job.budget.finish(result.runtimeProgress);
        if(job.workflow&&Number.isFinite(result.runtimeProgress?.ioMs))job.workflow.ioMs+=result.runtimeProgress.ioMs;
        checkBudget(job.budget,true);
        pending = null;
        if (result.error) { const e = new Error(result.error.message); e.code = result.error.code; e.diagnostics = result.error.diagnostics; job.reject(e); }
        else {
          let value = result.value;
          if(job.method==='licenseUseDefault'||job.method==='licenseSetLicense')replayLicense={method:job.method,args:job.args};
          if(job.method==='setIpPortData')ipData=job.args[0];
          if (isGraphLoad(job.method)) {
            let key = reverse.get(value.handle);
            if (!key) { key = nextHandle++; reverse.set(value.handle, key); handles.set(key, { native: value.handle, refs: 0 }); }
            handles.get(key).refs++;
            value = { ...value, handle: key };
          } else if (job.method === 'graphFree') {
            const entry = handles.get(job.virtual);
            if (entry && --entry.refs === 0) { handles.delete(job.virtual); reverse.delete(entry.native); }
          }
          if (!job.cancelled) job.resolve(value);
        }
        startAsync(); return;
      }
      if (!alive()) throw failure('Async child termination');
      checkBudget(job.budget);
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
      env, windowsHide: true, stdio: ['pipe','ignore','ignore']
    });
    child.stdin.on('error',()=>{});
    // Spawn errors must be observable even while the caller is synchronously
    // waiting; the bounded startup deadline covers asynchronous spawn failures.
    child.on('error', () => {}); child.unref(); failed = false;
    metadata = exchange('__describe', [], options.startupTimeoutMs || 15000);
    if (replayLicense) exchange(replayLicense.method, replayLicense.args);
    if (ipData !== undefined) exchange('setIpPortData', [ipData]);
  }
  function call(method, args) {
    const graphCall = !isGraphLoad(method) && (method.startsWith('graph') || ['renderScope', 'renderScene', 'refineScene'].includes(method));
    if (stopped) throw new Error('Airtl native runtime is disposed');
    if (failed || !alive()) {
      if (method === 'graphFree') return undefined;
      if (isGraphLoad(method) || !graphCall) start();
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
    if (isGraphLoad(method)) {
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
  if(!options.defer)start();
  if(!metadata)throw new Error('Deferred native runtime requires its build manifest');
  const api = { ...metadata.values };
  for (const method of metadata.functions) api[method] = (...args) => call(method, args);
  if(options.defer){api.isNative=()=>true;api.version=()=>options.metadata.version;api.nativeError=()=>null;}
  api.readyAsync=readyAsync;
  api.withRequestBudget=(callback,limit=requestTimeoutMs)=>workflows.run({started:performance.now(),ioMs:0,limit},callback);
  api.diskIoAsync=async(operation,file,callback)=>{
    const workflow=workflows.getStore(),started=performance.now();let timer;
    try{return await Promise.race([callback(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`Disk I/O did not respond: ${operation} ${file}`),{code:'AIRTL_IO_TIMEOUT',timeoutKind:'io',operation,path:file})),ioTimeoutMs);})]);}
    finally{clearTimeout(timer);if(workflow)workflow.ioMs+=performance.now()-started;}
  };
  api.projectLoadAsync = (...args) => enqueue('projectLoad', args);
  // Editor syntax checks use their own isolated runtime and only enqueue the
  // fast parse-only native entry point; they never share the design graph or
  // trigger hierarchy, netlist, layout, or Scene work.
  api.svParseTextAsync = (...args) => enqueue('svParseText', args);
  api.svParseTextLatestAsync = (queueKey, ...args) => {
    cancelAsync(queueKey);
    return enqueue('svParseText', args, queueKey);
  };
  api.svIndexTextAsync = (...args) => enqueue('svIndexText', args);
  api.svIndexTextLatestAsync = (queueKey, ...args) => {
    cancelAsync(queueKey);
    return enqueue('svIndexText', args, queueKey);
  };
  api.cancelAsync = cancelAsync;
  api.graphLoadAsync = (...args) => enqueue('graphLoad', args);
  api.graphLoadCheckpointAsync=(...args)=>enqueue('graphLoadCheckpoint',args);
  api.graphSaveCheckpointAsync=(...args)=>enqueue('graphSaveCheckpoint',args);
  for(const method of ['licenseMachineId','licenseUseDefault','licenseSetLicense'])api[method+'Async']=(...args)=>enqueue(method,args);
  for (const method of ['projectDiscover', 'projectCached', 'projectUpdateCache', 'pickTopLevelFromCands', 'extractModules', 'stripComments', 'vivadoLocate', 'graphHierarchy', 'graphIndex',
    'graphTopCandidates', 'graphFree', 'graphInvalidate', 'graphSlangElaboration', 'graphFactVersion', 'graphReadNodes', 'graphReadFacts', 'renderScope'])
    api[method + 'Async'] = (...args) => enqueue(method, args);
  api.renderSceneAsync = (...args) => enqueue('renderScene', args);
  api.refineSceneAsync = (...args) => enqueue('refineScene', args);
  api.renderSceneQueuedAsync = (queueKey, ...args) => enqueue('renderScene', args, queueKey);
  api.refineSceneQueuedAsync = (queueKey, ...args) => enqueue('refineScene', args, queueKey);
  api.__runtimeInfo = () => ({ isolated: true, pid: child && child.pid, alive: alive(), session: directory && path.basename(directory), nativePath: metadata.nativePath, failed, disposed: stopped,
    queuedRequests: asyncQueue.length, runningRequest: !!pending, ...transportStats });
  api.__shutdown = () => { stopped = true; cleanup(); process.removeListener('exit', exit); };
  const exit = () => cleanup();
  process.once('exit', exit);
  return api;
}
module.exports = { create };
