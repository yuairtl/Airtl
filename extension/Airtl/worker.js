'use strict';
const fs = require('fs'), path = require('path'), wire = require('./wire');
const [directory, loader, parentId] = process.argv.slice(2);
if (!directory || !loader || !parentId) throw new Error('Missing Airtl runtime arguments');
const api = require(loader);
const watch=api._native||api;
Object.assign(api,require('./checkpoint').create(api,watch));
const request = path.join(directory, 'request'), response = path.join(directory, 'response');
function describe() {
  const functions = [], values = {};
  for (const [name, value] of Object.entries(api)) {
    if (name === '_native'||name==='_runtimeRequestBegin'||name==='_runtimeRequestEnd') continue;
    if (typeof value === 'function') functions.push(name);
    else values[name] = value;
  }
  return { functions, values, nativePath: Object.keys(require.cache).find(f => f.endsWith('.node')) || '' };
}
let tick = 0, timer;
function poll() {
  clearTimeout(timer);
  if (++tick % 10 === 0) {
    try { process.kill(Number(parentId), 0); } catch (_) { process.exit(0); }
    if (!fs.existsSync(directory)) process.exit(0);
  }
  if (fs.existsSync(request)) {
    let result, item,progress;
    try {
      item = wire.unpack(fs.readFileSync(request, 'utf8')); fs.unlinkSync(request);
      if (item.method === '__describe') result = { id: item.id, value: describe() };
      else {
        if (!Object.prototype.hasOwnProperty.call(api, item.method) || typeof api[item.method] !== 'function') throw new Error('Unknown native method');
        let watching=false;
        try {
          if(typeof watch._runtimeRequestBegin==='function'&&typeof watch._runtimeRequestEnd==='function'){
            watch._runtimeRequestBegin(item.id,path.join(directory,'progress'));watching=true;
          }
          result = { id: item.id, value: api[item.method](...item.args) };
        } finally {if(watching)progress=watch._runtimeRequestEnd();}
      }
      if(progress)result.runtimeProgress=progress;
      const bytes = wire.pack(result);
      fs.writeFileSync(response + '.tmp', bytes); fs.renameSync(response + '.tmp', response);
    } catch (e) {
      const bytes = wire.pack({ id: item && item.id, runtimeProgress:progress,error: { message: e.message, code: e.code, diagnostics: e.diagnostics } });
      try { fs.writeFileSync(response + '.tmp', bytes); fs.renameSync(response + '.tmp', response); } catch (_) { process.exit(1); }
    }
  }
  const fallbackDelay = process.env.AIRTL_TEST_MODE && process.env.AIRTL_TEST_SLOW_POLL ? 2000 : 100;
  timer=setTimeout(poll, fallbackDelay);
}
// Windows timer granularity can add a whole frame to each file-RPC round trip.
// Directory notifications wake the same single-owner dispatcher immediately;
// a bounded poll remains as recovery if a notification is dropped.
let requestWatcher;
try { if (!process.env.AIRTL_TEST_MODE || !process.env.AIRTL_TEST_DISABLE_WATCH) {
  requestWatcher=fs.watch(directory,(_event,file)=>{if(String(file)==='request')poll();}); requestWatcher.on('error',()=>{});
} } catch (_) {}
// The pipe carries only wakeups; atomic files remain the request/response
// transport and the timer remains the recovery path if a wakeup is lost.
process.stdin.on('data', () => poll());
process.stdin.resume();
fs.writeFileSync(path.join(directory,'ready'),JSON.stringify(describe()));
poll();
