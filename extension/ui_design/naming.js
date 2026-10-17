// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';
const fs = require('fs');
const airtl = require('../Airtl');
function tbOutputPath(workspaceDir, subgraph, opts) {
  const ts = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const rnd = Math.random().toString(36).slice(2, 5);
  const result = airtl.tbOutputPaths(workspaceDir, subgraph, ts, rnd);
  if (!(opts && opts.mkdir === false)) {
    try { fs.mkdirSync(result.tbDir, { recursive: true }); fs.mkdirSync(result.simDir, { recursive: true }); }
    catch (_) { /* The caller reports failures when writing the generated file. */ }
  }
  return result;
}
module.exports = { deriveBaseName: airtl.deriveTbBase, safeId: airtl.safeFileId, tbOutputPath };
