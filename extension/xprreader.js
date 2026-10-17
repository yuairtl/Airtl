// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';
const airtl = require('./Airtl');
module.exports = {
  getProjectFromDisk: file => airtl.projectLoad('xpr', file),
  toWinSlash: p => p ? airtl.pathSlash(p) : p,
  extractTopModule: airtl.extractTopModule,
  extractPart: airtl.extractPart,
  extractFileSetTopModule: airtl.extractFileSetTopModule,
  parseFileSets: airtl.parseFileSets,
  extractSimFiles: airtl.extractSimFiles,
  isZipBuffer: airtl.isZipBuffer,
  walk: (dir, acc) => (acc || []).concat(airtl.projectGeneratedFiles(dir)),
};
