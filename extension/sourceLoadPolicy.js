'use strict';
const path = require('path');
// Implementation loading is a user action and part of the immutable design
// cache key. It never changes a file's provenance or starts on text edits.
function applyImplementationRequests(records, requested, base) {
  const key = value => {
    const resolved = path.resolve(base, value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const enabled = new Set((requested || []).filter(x => typeof x === 'string').map(key));
  return (records || []).map(record => record.role === 'generated-netlist' && enabled.has(key(record.path))
    ? { ...record, loadMode: 'implementation', loadEvidence: 'user-explicit-request' } : record);
}
module.exports = { applyImplementationRequests };
