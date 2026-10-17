'use strict';
const fs = require('fs'), path = require('path'), wire = require('./wire');
const [directory, loader, parentId] = process.argv.slice(2);
if (!directory || !loader || !parentId) throw new Error('Missing Airtl runtime arguments');
const api = require(loader);
const request = path.join(directory, 'request'), response = path.join(directory, 'response');
function describe() {
  const functions = [], values = {};
  for (const [name, value] of Object.entries(api)) {
    if (name === '_native') continue;
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
    let result, item;
    try {
      item = wire.unpack(fs.readFileSync(request, 'utf8')); fs.unlinkSync(request);
      if (item.method === '__describe') result = { id: item.id, value: describe() };
      else {
        if (!Object.prototype.hasOwnProperty.call(api, item.method) || typeof api[item.method] !== 'function') throw new Error('Unknown native method');
        result = { id: item.id, value: api[item.method](...item.args) };
      }
      const bytes = wire.pack(result);
      fs.writeFileSync(response + '.tmp', bytes); fs.renameSync(response + '.tmp', response);
    } catch (e) {
      const bytes = wire.pack({ id: item && item.id, error: { message: e.message, code: e.code, diagnostics: e.diagnostics } });
      try { fs.writeFileSync(response + '.tmp', bytes); fs.renameSync(response + '.tmp', response); } catch (_) { process.exit(1); }
    }
  }
  timer=setTimeout(poll, 100);
}
// Windows timer granularity can add a whole frame to each file-RPC round trip.
// Directory notifications wake the same single-owner dispatcher immediately;
// a bounded poll remains as recovery if a notification is dropped.
try { fs.watch(directory,(_event,file)=>{if(String(file)==='request')poll();}).on('error',()=>{}); } catch (_) {}
poll();
