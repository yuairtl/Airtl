'use strict';
const path = require('path');
const crypto = require('crypto');

function pathKey(file) {
  const key = path.resolve(file).replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
function sourcePath(value) { return typeof value === 'string' ? value : value?.path; }
function uniquePaths(values) {
  const seen = new Set();
  return (values || []).map(sourcePath).filter(file => {
    if (!file) return false;
    const key = pathKey(file);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
// Vivado-generated HDL can contain matching simulation and synthesis
// alternatives under parallel /sim/ and /synth/ directories. They are two
// views of one generated design element, not two definitions to compile into
// the same target. Select the requested alternative only when its counterpart
// exists; preserve standalone files so a missing implementation remains
// visible as an unresolved boundary instead of silently disappearing.
function selectTargetVariants(values, target = 'synthesis') {
  const requested = target === 'simulation' ? 'sim' : 'synth';
  const metadata = new Map();
  for (const value of values || []) {
    if (!value || typeof value !== 'object' || value.origin !== 'ip-discovery') continue;
    const file = sourcePath(value);
    if (!file) continue;
    const match = /(^|[\\/])(sim|synth)(?=[\\/])/i.exec(file);
    if (!match) continue;
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    const group = pathKey(file.slice(0, start) + '{variant}' + file.slice(end));
    const variant = match[2].toLowerCase();
    let entry = metadata.get(group);
    if (!entry) metadata.set(group, entry = new Set());
    entry.add(variant);
  }
  return (values || []).filter(value => {
    if (!value || typeof value !== 'object' || value.origin !== 'ip-discovery') return true;
    const file = sourcePath(value);
    if (!file) return true;
    const match = /(^|[\\/])(sim|synth)(?=[\\/])/i.exec(file);
    if (!match) return true;
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    const group = pathKey(file.slice(0, start) + '{variant}' + file.slice(end));
    const variants = metadata.get(group);
    return !variants || variants.size < 2 || !variants.has(requested) || match[2].toLowerCase() === requested;
  });
}
function projectFiles(project = {}, target = 'synthesis') {
  const sets = project.fileSets || [];
  const design = project.srcFiles?.length ? project.srcFiles : sets.find(set => set.type === 'DesignSrcs')?.files || [];
  const baseType = target === 'simulation' ? 'SimulationSrcs' : 'DesignSrcs';
  const base = sets.find(set => set.type === baseType && set.active) || sets.find(set => set.type === baseType) || {};
  const simulation = target === 'simulation'
    ? (base.files?.length ? base.files : project.simFiles || []) : [];
  const values = selectTargetVariants([...design, ...simulation, ...(project.ipFiles || []),
    ...sets.filter(set => set.type === 'BlockSrcs').flatMap(set => set.files || [])], target);
  const seen = new Set();
  return values.filter(value => {
    const file = sourcePath(value);
    if (!file) return false;
    const key = pathKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function normalize(input = {}) {
  const files = uniquePaths(input.files).filter(file => /\.(?:v|sv)$/i.test(file));
  const fileSetContexts = (input.fileSetContexts || []).map(set => ({
    name: set.name || '', type: set.type || '',
    files: uniquePaths(set.files).map(file => ({ path: file })),
    includeDirs: uniquePaths(set.includeDirs), defines: [...(set.defines || [])],
  }));
  const fileRecords = JSON.parse(JSON.stringify(input.fileRecords || []));
  const compilationUnits = (input.compilationUnits || []).map(unit => ({
    files: uniquePaths(unit.files), includeDirs: uniquePaths(unit.includeDirs), defines: [...(unit.defines || [])],
  }));
  const result = {
    files, includeDirs: uniquePaths(input.includeDirs), defines: [...(input.defines || [])],
    top: input.top || '', languageStandard: input.languageStandard || '1800-2017',
    parameters: Array.isArray(input.parameters) ? [...input.parameters]
      : Object.entries(input.parameters || {}).map(([name, value]) => `${name}=${value}`),
    libraryDirs: uniquePaths(input.libraryDirs), libraryFiles: uniquePaths(input.libraryFiles),
    libraryExtensions: [...(input.libraryExtensions || [])],
    fileSetContexts, fileRecords, compilationUnits,
  };
  const identity = {
    ...result, files: files.map(pathKey), includeDirs: result.includeDirs.map(pathKey),
    libraryDirs: result.libraryDirs.map(pathKey), libraryFiles: result.libraryFiles.map(pathKey),
    fileSetContexts: fileSetContexts.map(set => ({ ...set, files: set.files.map(file => pathKey(file.path)),
      includeDirs: set.includeDirs.map(pathKey) })),
    fileRecords: fileRecords.map(record => ({ ...record, path: record.path ? pathKey(record.path) : '' })),
    compilationUnits: compilationUnits.map(unit => ({ ...unit, files: unit.files.map(pathKey), includeDirs: unit.includeDirs.map(pathKey) })),
  };
  result.contextId = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return freeze(result);
}
function forProject(project = {}, target = 'synthesis', languageStandard = '1800-2017') {
  const sets = project.fileSets || [];
  const type = target === 'simulation' ? 'SimulationSrcs' : 'DesignSrcs';
  const base = sets.find(set => set.type === type && set.active) || sets.find(set => set.type === type) || {};
  const files = projectFiles(project, target);
  return normalize({
    files,
    includeDirs: base.includeDirs || project.includeDirs || [],
    defines: base.defines || project.defines || [],
    top: base.top || base.topModule || (target === 'simulation' ? project.simTop : project.designTop) || project.top || '',
    languageStandard,
    libraryDirs: project.libraryDirs, libraryFiles: project.libraryFiles, libraryExtensions: project.libraryExtensions,
    parameters: project.parameters || [], fileSetContexts: sets, fileRecords: project.fileRecords || [],
  });
}
module.exports = { normalize, forProject, projectFiles, pathKey, selectTargetVariants };
