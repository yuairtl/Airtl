'use strict';
const path = require('path');
const gp = require('./ui_design/graphProvider');
const key = file => {
  const value = path.resolve(file).replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
// Prepared once by the writer. Neither tree performs I/O or invokes the
// compiler while reading these immutable hierarchy projections.
async function prepare(graph, project, hierarchy, assertCurrent) {
  const designFiles = new Set(project.srcFiles.map(f => key(f.path)));
  const simFiles = new Set(project.simFiles.map(f => key(f.path)));
  const definitions = [...graph.moduleDefs.values()];
  const referenced = new Set(definitions.filter(d => designFiles.has(key(d.file)))
    .flatMap(d => (d.instances || []).map(i => i.type)));
  const selected = definitions.filter(d => simFiles.has(key(d.file)) ||
    (designFiles.has(key(d.file)) && !referenced.has(d.name)));
  const names = [...new Set([project.simTop, ...selected.map(d => d.name)].filter(Boolean))];
  const simulation = [];
  for (const top of names) {
    const value = top === hierarchy.top ? hierarchy : await gp.hierarchyFor(graph, top);
    assertCurrent();
    if (value.root) simulation.push(value.root);
  }
  return Object.freeze({ design: hierarchy.root, simulation: Object.freeze(simulation) });
}
module.exports = { prepare, pathKey: key };
