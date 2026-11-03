// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';
// Project policies and scanning live in the native project service.
// JS owns the workspace cache file and exposes the existing extension contract.
const fs = require('fs');
const path = require('path');
const airtl = require('./Airtl');
const SKIP_DIRS = new Set(airtl.projectSkipDirs);
const disk=(operation,file,fn)=>airtl.diskIoAsync(operation,file,fn);
function cacheFile(root) { return root ? path.join(root, '.vscode', 'vivado-project.json') : null; }
function readCache(root) {
  try { const file = cacheFile(root); return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
  catch (_) { return null; }
}
function writeCache(root, value) {
  const file = cacheFile(root);
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
  catch (_) { /* The workspace cache is optional. */ }
}
const discover = (mode, roots, depth) => airtl.projectDiscover(roots || [], depth, mode || 'xpr');
const discoverAll = (roots, depth) => airtl.projectDiscover(roots || [], depth);
const pickTopSourceFile = (file, roots) => airtl.projectLoad('source', file, roots || []);
const loadProject = (source, roots) => airtl.projectLoad(source && source.mode || 'xpr', source && source.path || '', roots || []);
const loadProjectAsync = (source, roots) => airtl.projectLoadAsync(source && source.mode || 'xpr', source && source.path || '', roots || []);
const discoverAllAsync = (roots, depth) => airtl.projectDiscoverAsync(roots || [], depth);
const cachedPathFor = (cache, mode) => airtl.projectCachedPath(cache, mode);
const resolveSync = (mode, roots, depth) => airtl.projectSelect(discover(mode, roots, depth), mode || 'xpr', readCache((roots || [])[0]));
const resolveCachedAny = roots => airtl.projectCached(readCache((roots || [])[0]));
async function resolveCachedAnyAsync(roots) {
  let cache = null;
  const file=cacheFile((roots||[])[0]);
  try { cache = JSON.parse(await disk('read-selection',file,()=>fs.promises.readFile(file, 'utf8'))); } catch (error) {if(error.code==='AIRTL_IO_TIMEOUT')throw error;}
  return airtl.projectCachedAsync(cache);
}
const saveQueues=new Map();
function saveCacheAsync(root, source, isCurrent=()=>true) {
  const previous=saveQueues.get(root)||Promise.resolve();
  const work=previous.catch(()=>{}).then(()=>writeCacheAsync(root,source,isCurrent));
  saveQueues.set(root,work);return work.finally(()=>{if(saveQueues.get(root)===work)saveQueues.delete(root);});
}
async function writeCacheAsync(root, source, isCurrent) {
  if(!isCurrent())return;
  const file = cacheFile(root); if (!file) return;
  let previous = null;
  try { previous = JSON.parse(await disk('read-selection',file,()=>fs.promises.readFile(file, 'utf8'))); } catch (error) {if(error.code==='AIRTL_IO_TIMEOUT')throw error;}
  const value = await airtl.projectUpdateCacheAsync(previous, source, new Date().toISOString());
  const temporary=file+'.'+process.pid+'.tmp';
  try { await disk('mkdir-selection',file,()=>fs.promises.mkdir(path.dirname(file), { recursive: true }));
    await disk('write-selection',temporary,()=>fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8'));
    if(isCurrent())await disk('commit-selection',file,()=>fs.promises.rename(temporary,file));
  } catch (_) {} finally {try{await disk('cleanup-selection',temporary,()=>fs.promises.unlink(temporary));}catch(_){}}
}
const saveCache = (root, source) => writeCache(root, airtl.projectUpdateCache(readCache(root), source, new Date().toISOString()));
const walkFind = (roots, depth, predicate) => airtl.projectWalk(roots || [], depth).filter(c => predicate(c.path, path.basename(c.path)));
module.exports = {
  discover, discoverAll, discoverAllAsync, resolveSync, resolveCachedAny, loadProject, loadProjectAsync, pickTopSourceFile,
  readCache, writeCache, cachedPathFor, saveCache, saveCacheAsync, resolveCachedAnyAsync, walkFind, SKIP_DIRS,
  isGeneratedHdlPath: airtl.isGeneratedHdlPath,
  isSimHdlFile: airtl.isSimHdlFile,
  inferSimTop: airtl.inferSimTop,
};
