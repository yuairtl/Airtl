// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';
const airtl = require('./Airtl');
module.exports = {
  parseTclProject: file => airtl.projectLoad('tcl', file),
  hasTopDirective: airtl.hasTopDirective,
  extractTopDirective: airtl.extractTopDirective,
  extractTopDirectives: airtl.extractTopDirectives,
  stripTclComments: airtl.stripTclComments,
  collectVars: airtl.collectVars,
  expandVars: airtl.expandVars,
  stripTclQuotes: airtl.stripTclQuotes,
  normalizeTopName: airtl.normalizeTopName,
  resolveTopDirective: airtl.resolveTopDirective,
  extractFilePaths: airtl.resolveTclFilePaths,
  toWinSlash: p => p ? airtl.pathSlash(p) : p,
  isNative: airtl.isNative,
  nativeError: airtl.nativeError,
};
