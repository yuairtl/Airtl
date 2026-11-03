'use strict';
// Apply a native text-only patch without inferring design or layout semantics.
(function (root) {
  // Expand a physical-net selection through STREAM value dependencies without
  // changing the net graph. The returned semantic sets let the renderer show
  // related dataflow in a different color from electrically identical nets.
  function expandStreamDataflowHighlight(scene, initial) {
    const result = {
      nets: new Set(initial && initial.nets || []),
      pins: new Set(initial && initial.pins || []),
      pads: new Set(initial && initial.pads || []),
      semanticNets: new Set(),
      semanticPins: new Set(),
    };
    if (!scene || !scene.byKey || !scene.netByPort || !scene.netMeta || !scene.connectivity) return result;

    const originalNets = new Set(result.nets);
    const originalPins = new Set(result.pins);
    const groups = scene.connectivity.groups || {};
    const visitedPins = new Set();
    const queue = [...result.pins];

    function addNetGroup(netId) {
      const meta = scene.netMeta.get(netId);
      const group = meta && groups[meta.groupId];
      if (!group) return;
      for (const id of group.nets || []) {
        result.nets.add(id);
        if (!originalNets.has(id)) result.semanticNets.add(id);
      }
      for (const id of group.pads || []) result.pads.add(id);
      for (const id of group.pins || []) {
        result.pins.add(id);
        if (!originalPins.has(id)) result.semanticPins.add(id);
        queue.push(id);
      }
    }

    while (queue.length) {
      const id = queue.pop();
      if (visitedPins.has(id)) continue;
      visitedPins.add(id);
      const split = id.indexOf('\u0000');
      if (split < 0) continue;
      const block = scene.byKey.get(id.slice(0, split));
      if (!block || block.type !== 'STREAM') continue;
      const pinName = id.slice(split + 1);
      const pin = block.pins && block.pins.find(item => item.name === pinName);
      if (!pin || pin.dependencyRole === 'control') continue;
      for (const peer of block.pins || []) {
        if (peer.dependencyRole === 'control' || peer.dir === pin.dir) continue;
        const peerId = block.key + '\u0000' + peer.name;
        result.pins.add(peerId);
        if (!originalPins.has(peerId)) result.semanticPins.add(peerId);
        const peerNet = scene.netByPort.get(peerId);
        if (peerNet) addNetGroup(peerNet);
      }
    }
    return result;
  }

  // Compute a bounded, on-demand view of operand-to-result bit ranges. The
  // Scene stores only the stream transform and operand intervals; this helper
  // does not materialize a per-bit permutation table.
  function describeStreamOperandMapping(block, pin, maxRanges = 8) {
    if (!block || block.type !== 'STREAM' || !pin || !block.streamOperandLayoutComplete ||
        !Number.isSafeInteger(pin.streamValueWidth) || pin.streamValueWidth <= 0 ||
        !Number.isSafeInteger(block.streamBitWidth) || block.streamBitWidth <= 0) return null;
    const isInputPack = block.streamDirection === 'input' && pin.dir === 'in' && Number.isSafeInteger(pin.streamValueOffset);
    const isOutputUnpack = block.streamDirection === 'output' && pin.dir === 'out' && Number.isSafeInteger(pin.streamTargetOffset);
    if (!isInputPack && !isOutputUnpack) return null;
    const start = isInputPack ? pin.streamValueOffset : pin.streamTargetOffset;
    const sourceBase = Number.isSafeInteger(pin.streamSourceBitOffset) ? pin.streamSourceBitOffset : 0;
    if (start < 0 || sourceBase < 0) return null;
    const end = start + pin.streamValueWidth;
    const total = block.streamBitWidth;
    if (end > total) return null;
    if (block.streamTransform !== 'reverseChunks') {
      return { role: isInputPack ? 'operandToResult' : 'targetFromValue', ranges: [{
        sourceStart: isInputPack ? sourceBase : start,
        targetStart: isInputPack ? start : sourceBase,
        width: pin.streamValueWidth,
      }], truncated: false, rangeCount: 1 };
    }
    const slice = block.streamSliceSize;
    if (!Number.isSafeInteger(slice) || slice <= 0) return null;
    const firstChunk = Math.floor(start / slice), lastChunk = Math.floor((end - 1) / slice);
    const rangeCount = lastChunk - firstChunk + 1;
    const ranges = [];
    for (let chunk = firstChunk; chunk <= lastChunk && ranges.length < maxRanges; chunk++) {
      const chunkStart = chunk * slice;
      const chunkEnd = Math.min(total, chunkStart + slice);
      const sourceStart = Math.max(start, chunkStart);
      const sourceEnd = Math.min(end, chunkEnd);
      const width = sourceEnd - sourceStart;
      if (width <= 0) continue;
      const targetChunkStart = total - chunkEnd;
      const targetStart = targetChunkStart + sourceStart - chunkStart;
      ranges.push({
        sourceStart: isInputPack ? sourceBase + sourceStart : sourceStart,
        targetStart: isInputPack ? targetStart : sourceBase + targetStart,
        width,
      });
    }
    return { role: isInputPack ? 'operandToResult' : 'targetFromValue', ranges, truncated: rangeCount > ranges.length, rangeCount };
  }

  function applyTextPatch(scene, patch) {
    if (!scene || patch.baseSceneId !== scene.sceneId || patch.blocks.length !== scene.blocks.length ||
        patch.pads.length !== scene.pads.length || patch.nets.length !== scene.nets.length) throw Error('Expired or malformed Scene text patch');
    const blocks = scene.blocks.map((b, i) => {
      const [fontPx, subWidth, widths] = patch.blocks[i];
      if (widths.length !== b.pins.length) throw Error('Malformed Scene pin text patch');
      return { ...b, pinFontPx: fontPx, subWidth, pins: b.pins.map((p, j) => ({ ...p, fontPx, labelWidth: widths[j] })) };
    });
    return { ...scene, sceneId: patch.sceneId, blocks,
      pads: scene.pads.map((p, i) => ({ ...p, labelWidth: patch.pads[i] })),
      nets: scene.nets.map((n, i) => ({ ...n, lx: patch.nets[i][0], ly: patch.nets[i][1] })),
      padIndex: patch.padIndex, textRequests: patch.textRequests, textComplete: patch.textComplete };
  }
  if (typeof module === 'object' && module.exports) module.exports = { applyTextPatch, expandStreamDataflowHighlight, describeStreamOperandMapping };
  else root.airtlSceneProtocol = { applyTextPatch, expandStreamDataflowHighlight, describeStreamOperandMapping };
})(typeof window === 'object' ? window : globalThis);
