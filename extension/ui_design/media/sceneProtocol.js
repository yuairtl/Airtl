'use strict';
// Apply a native text-only patch without inferring design or layout semantics.
(function (root) {
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
  if (typeof module === 'object' && module.exports) module.exports = { applyTextPatch };
  else root.airtlSceneProtocol = { applyTextPatch };
})(typeof window === 'object' ? window : globalThis);
