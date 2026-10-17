// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';
// Project policies and scanning live in the native project service.
// JS owns the workspace cache file and exposes the existing extension contract.
const fs = require('fs');
const path = require('path');
const airtl = require('./Airtl');
const SKIP_DIRS = new Set(airtl.projectSkipDirs);
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
const cachedPathFor = (cache, mode) => airtl.projectCachedPath(cache, mode);
const resolveSync = (mode, roots, depth) => airtl.projectSelect(discover(mode, roots, depth), mode || 'xpr', readCache((roots || [])[0]));
const resolveCachedAny = roots => airtl.projectCached(readCache((roots || [])[0]));
const saveCache = (root, source) => writeCache(root, airtl.projectUpdateCache(readCache(root), source, new Date().toISOString()));
const walkFind = (roots, depth, predicate) => airtl.projectWalk(roots || [], depth).filter(c => predicate(c.path, path.basename(c.path)));
module.exports = {
  discover, discoverAll, resolveSync, resolveCachedAny, loadProject, pickTopSourceFile,
  readCache, writeCache, cachedPathFor, saveCache, walkFind, SKIP_DIRS,
  isGeneratedHdlPath: airtl.isGeneratedHdlPath,
  isSimHdlFile: airtl.isSimHdlFile,
  inferSimTop: airtl.inferSimTop,
};
