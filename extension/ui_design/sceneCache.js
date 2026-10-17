'use strict';
// Cache only immutable snapshots. Navigation stays in the extension process.
function canonical(value) {
  if (value instanceof Map) value = Object.fromEntries(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
class SceneCache {
  constructor(maxEntries = 8, maxBytes = 32 * 1024 * 1024) {
    this.entries = new Map(); this.byId = new Map(); this.bytes = 0;
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.hits = 0; this.misses = 0;
  }
  key(module, options) { return JSON.stringify(canonical({ module, options })); }
  get(key) {
    const record = this.entries.get(key);
    if (!record) { ++this.misses; return null; }
    ++this.hits; this.entries.delete(key); this.entries.set(key, record); return record;
  }
  set(key, scene, runtime, handle) {
    const old = this.entries.get(key); if (old) this.remove(key);
    const sceneId = runtime.session + '/' + handle + '/' + scene.sceneId;
    const { navigation, ...objects } = scene;
    const record = { key, nativeId: scene.sceneId, navigation, scene: { ...objects, sceneId },
      bytes: Buffer.byteLength(JSON.stringify(scene)), session: runtime.session, handle };
    this.entries.set(key, record); this.byId.set(sceneId, record); this.bytes += record.bytes;
    // Retain at most one oversized current scene so it can finish text refinement;
    // it replaces all older entries instead of growing an unbounded history.
    while (this.entries.size > 1 && (this.entries.size > this.maxEntries || this.bytes > this.maxBytes)) this.remove(this.entries.keys().next().value);
    return record;
  }
  remove(key) { const r = this.entries.get(key); if (!r) return; this.bytes -= r.bytes; this.byId.delete(r.scene.sceneId); this.entries.delete(key); }
  clear() { this.entries.clear(); this.byId.clear(); this.bytes = 0; }
}
module.exports = { SceneCache, canonical };
