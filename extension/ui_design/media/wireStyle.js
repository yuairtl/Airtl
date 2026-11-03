'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.airtlWireStyle = api;
})(typeof window === 'object' ? window : globalThis, () => {
  function net(net) {
    const style = net || {};
    // The preprocessing layer owns semantics. Rendering consumes only the
    // explicit orthogonal fields; legacy `style` must never be used to infer
    // dash, width, or warning color when a field was dropped upstream.
    const pattern = style.linePattern === 'dashed' ? 'dashed' : 'solid';
    const weight = style.lineWeight === 'bus' ? 'bus' : 'normal';
    const colorRole = ['warning', 'constant', 'bitsel'].includes(style.colorRole)
      ? style.colorRole : 'normal';
    return {
      pattern,
      weight,
      colorRole,
      dash: pattern === 'dashed' ? (colorRole === 'constant' ? [4, 3] : [6, 3]) : [],
      width: weight === 'bus' ? 3 : 1.2,
    };
  }

  function relation(net, index) {
    const item = net || {};
    return {
      kind: item.relationStyles && item.relationStyles[index] || 'normal',
      pattern: item.relationPatterns && item.relationPatterns[index] === 'dashed' ? 'dashed' : 'solid',
    };
  }

  return { net, relation };
});
