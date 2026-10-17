'use strict';
// Stable across Node/Electron V8 versions; tagged arrays cannot collide with
// user objects because every container is encoded explicitly.
function pack(value) {
  const active = new Set();
  function encode(v, depth = 0) {
    if (depth > 512) throw new Error('Airtl RPC value exceeds nesting limit');
    if (v === undefined) return ['u'];
    if (typeof v === 'bigint') return ['b', String(v)];
    if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return ['n', Object.is(v, -0) ? '-0' : String(v)];
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
    if (typeof v !== 'object') throw new TypeError('Airtl RPC accepts data arguments only');
    if (active.has(v)) throw new TypeError('Cyclic Airtl RPC argument');
    active.add(v);
    const enc = x => encode(x, depth + 1);
    let result;
    if (Buffer.isBuffer(v)) result = ['B', v.toString('base64')];
    else if (v instanceof Map) result = ['m', [...v].map(([k, x]) => [enc(k), enc(x)])];
    else if (v instanceof Set) result = ['s', [...v].map(enc)];
    else if (Array.isArray(v)) result = ['a', v.map(enc)];
    else result = ['o', Object.entries(v).map(([k, x]) => [k, enc(x)])];
    active.delete(v); return result;
  }
  return JSON.stringify(encode(value));
}
function unpack(text) {
  function decode(v) {
    if (!Array.isArray(v)) return v;
    const [tag, data] = v;
    if (tag === 'u') return undefined;
    if (tag === 'b') return BigInt(data);
    if (tag === 'n') return data === '-0' ? -0 : Number(data);
    if (tag === 'B') return Buffer.from(data, 'base64');
    if (tag === 'a') return data.map(decode);
    if (tag === 'm') return new Map(data.map(([k, x]) => [decode(k), decode(x)]));
    if (tag === 's') return new Set(data.map(decode));
    if (tag === 'o') return Object.fromEntries(data.map(([k, x]) => [k, decode(x)]));
    throw new Error('Invalid Airtl RPC payload');
  }
  return decode(JSON.parse(text));
}
module.exports = { pack, unpack };
