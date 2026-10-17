// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';
// VS Code passes its setting; all installation and library discovery is native.
const airtl = require('../Airtl');
function probe(setting) { return airtl.vivadoLocate(setting || '').exe || null; }
function rootOf(setting) { return airtl.vivadoLocate(setting || '').dir || null; }
function libDirs(setting) {
  const result = airtl.vivadoLocate(setting || '');
  return { unisimDir: result.unisimDir || null, xpmDirs: result.xpmDirs };
}
module.exports = {
  BASES: airtl.vivadoBases,
  VER_RE: /^\d{4}\.\d$/,
  exeFrom: airtl.vivadoExecutable,
  versionsOf: airtl.vivadoVersions,
  probe, rootOf, libDirs,
};
