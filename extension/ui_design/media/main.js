// Author: Airtl yu

// Contact: yuairtl@outlook.com
// main.js — Block Design 单模块作用域视图（Vivado 风格）
// 视觉：浅色画布、浅蓝块、pin 方块贴块缘、标签在块内、边界端口在左右轨、正交折线布线。
// 交互：双击块进入下级 / 面包屑返回 / 单击勾选 / 点已连pin→点目标pin 改连线 / 缩放平移。
'use strict';

const tr = key => (window.airtlText && window.airtlText[key]) || key;

const cv = document.getElementById('cv');
const statusEl = document.getElementById('status');
const pathEl = document.getElementById('path');
const btnBack = document.getElementById('btnBack');
const btnBus = document.getElementById('btnBus');
const btnExport = document.getElementById('btnExport');
const ctx = cv.getContext('2d');

// Geometry and display labels are delivered by the native Scene contract.
const C = {
  hl: '#1a6fe8', dim: '#9aa9c0',
  bg: '#ffffff',
  boxFill: '#e8f2fb', boxLine: '#4a90c4', boxSel: '#2fbf71',
  regFill: '#e6f4ea', regLine: '#3aa76d',   // reg 缓冲块（区别于例化块）
  title: '#1f3b57', sub: '#6b7f92', pinText: '#243a4d',
  pin: '#2c6ea5',
  net: '#234f7c', netBitsel: '#7a5ab8', warn: '#e07b00',
  bnd: '#2c6ea5', bndText: '#1f3b57', rail: '#d0dce8'
};

let scene = null;
let busViewEnabled = true;
let trail = [];
let checked = new Set();
let mode = 'idle', panStart = null;
let connectFrom = null, mouseW = null;
let lastClick = { key: null, t: 0, x: 0, y: 0 };
let focusNetId = null;   // 点击接口高亮所属网络
let focusName = '';      // 高亮网络的名称（状态栏用）
let focusBlockKey = null;   // BD 树单击定位：聚焦的块 key（UI 内位置高亮 + 居中）
let hoverNetId = null;   // 悬停连线 → 显示该网名称（网名默认隐藏）
let hoverConstKey = null;// 悬停 const 块 → 显示该例化各常量引脚的例化语句（内容由 UI 交付层给）
let hoverBusPinKey = null; // 悬停总线粗端口 → 罗列成员信号及是否连通
let hoverBusLines = null;  // 上面的成员清单（预处理层给好的文本行）
let hoverScr = null;     // 悬停时的鼠标屏幕坐标（tooltip 定位）
let view = { scale: 1, tx: 0, ty: 0 };
let dpr = 1;

function api() {
  if (!api._v) { try { const bridge = acquireVsCodeApi(); api._v = { postMessage: message => bridge.postMessage(scene ? { sceneId: scene.sceneId, ...message } : message) }; } catch (e) { } }
  return api._v;
}

// ---------- 消息 ----------
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || !m.type) return;
  try {
    if (m.type === 'render') {
      const preserve = !!(m.preserveView && scene && scene.module === m.scene.module && scene.instancePath === m.scene.instancePath);
      acceptScene(m, preserve);
      checked = new Set(m.selected || []);
      busViewEnabled = !!m.busView;
      trail = m.trail || [];
      updateChrome();
      if (m.focusInst) focusBlock(m.focusInst); else if (!preserve) fitToView();
      draw();
      updateStatus();
    } else if (m.type === 'sceneTextPatch') {
      if (!scene || m.patch.baseSceneId !== scene.sceneId) return;
      acceptScene({scene:window.airtlSceneProtocol.applyTextPatch(window.__bdscene,m.patch)},true);
      draw();
    } else if (m.type === 'focusBlock') {
      if (m.inst) focusBlock({ inst: m.inst, type: m.blockType });
    } else if (m.type === 'error') {
      statusEl.textContent = tr('错误: ') + m.message;
    }
  } catch (err) {
    statusEl.textContent = tr('渲染异常: ') + err.message;
    console.error('[bd] render error:', err);
  }
});

// ---------- 场景预编译 ----------

// Hydrate references once; all geometry and design relations come from C++.
const textCache = new Map();
function measureTextCached(text) {
  const key = ctx.font + '\n' + text;
  if (!textCache.has(key)) {
    if (textCache.size > 40000) textCache.clear();
    textCache.set(key, ctx.measureText(text));
  }
  return textCache.get(key);
}
function acceptScene(m, preserve = false) {
  const receiveBegin = performance.now();
  const raw = m.scene;
  if (!raw || raw.schemaVersion !== 1) throw Error('Unsupported Scene schema');
  scene = { ...raw,
    byKey: new Map(raw.blocks.map(b => [b.key, b])),
    netKey: new Map(raw.connectivity.netKey), netByPort: new Map(raw.connectivity.netByPort),
    netMeta: new Map(Object.entries(raw.connectivity.netMeta)),
  };
  pinMaps = new Map(raw.blocks.map(b => [b.key, new Map(b.pins.map(p => [p.name, p]))]));
  if (!preserve) {
    focusNetId = null; focusName = ''; focusBlockKey = null;
    hoverNetId = null; hoverConstKey = null; hoverBusPinKey = null; hoverBusLines = null;
    activeHighlight = { nets: new Set(), pins: new Set(), pads: new Set() };
  }
  visibleCache = null;
  window.__bdscene = raw; window.__bdview = view; window.__bddraw = draw;
  window.__bdstats = renderStats;
  renderStats.receiveMs = performance.now() - receiveBegin;
  if (raw.textRequests && raw.textRequests.length) {
    const id = raw.sceneId;
    Promise.resolve(document.fonts && document.fonts.ready).then(() => {
      if (!scene || scene.sceneId !== id) return;
      const widths = {};
      for (const r of raw.textRequests) { ctx.font = r.font; widths[r.key] = measureTextCached(r.text).width; }
      const a = api(); if (a) a.postMessage({ type: 'sceneTextMetrics', sceneId: id, widths });
    });
  }
}
let pinMaps = new Map(), activeHighlight = { nets: new Set(), pins: new Set(), pads: new Set() };
let visibleCache = null, paintScheduled = false, statsTimer = null;
const renderStats = { paints: 0, lastPaintMs: 0, receiveMs: 0, candidateCount: 0, visibleWires: 0, frameSamples: [] };
function draw() {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => {
    paintScheduled = false; const begin = performance.now(); paint();
    renderStats.lastPaintMs = performance.now() - begin; ++renderStats.paints;
    renderStats.frameSamples.push(renderStats.lastPaintMs);if(renderStats.frameSamples.length>120)renderStats.frameSamples.shift();
    clearTimeout(statsTimer);statsTimer=setTimeout(() => {
      const a=api();if(a&&scene)a.postMessage({type:'sceneStats',stats:{...renderStats,textComplete:scene.textComplete,nets:scene.nets.length}});
    },250);
  });
}
function candidates(x0, y0, x1, y1, kind) {
  if (!scene) return [];
  const result=[];
  for (const ix of (kind === 2 ? [scene.padIndex] : kind === undefined ? [scene.hitIndex,scene.padIndex] : [scene.hitIndex])) {
  const size = ix.cellSize, ids = new Set(ix.overflow);
  const gx0 = Math.floor(x0 / size), gx1 = Math.floor(x1 / size), gy0 = Math.floor(y0 / size), gy1 = Math.floor(y1 / size);
  if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > ix.entries.length * 2) {
    for (let i = 0; i < ix.entries.length; ++i) ids.add(i);
  } else {
    for (let y = gy0; y <= gy1; ++y) for (let x = gx0; x <= gx1; ++x) {
      const cell = ix.cells[x + ':' + y]; if (cell) for (const id of cell) ids.add(id);
    }
  }
  for(const id of [...ids].filter(id => kind === undefined || ix.entries[id][0] === kind).sort((a,b) => a-b)) result.push(ix.entries[id]);
  }
  renderStats.candidateCount = result.length;
  return result;
}
function visibleObjects(x0, y0, x1, y1) {
  const key = [x0,y0,x1,y1].join(','); if (visibleCache && visibleCache.key === key) return visibleCache;
  const blocks = new Set(), pads = new Set(), nets = new Set(), pins = new Map();
  for (const e of candidates(x0-20, y0-20, x1+20, y1+20)) {
    if (e[0] === 0) blocks.add(e[1]);
    else if (e[0] === 1) { if (!pins.has(e[1])) pins.set(e[1], new Set()); pins.get(e[1]).add(e[2]); }
    else if (e[0] === 2) pads.add(e[1]); else if (e[0] === 3) nets.add(e[1]);
  }
  visibleCache = { key, blocks: [...blocks].sort((a,b)=>a-b), pads: [...pads].sort((a,b)=>a-b), nets: [...nets].sort((a,b)=>a-b), pins };
  renderStats.visibleWires = nets.size; return visibleCache;
}
function navigate(objectId, action) { const a = api(); if (a && scene) a.postMessage({ type: 'navigate', objectId, action }); }

function fitToView() {
  resize();
  if (!scene) return;
  const sx = cv.clientWidth / Math.max(scene.width, 1);
  const sy = cv.clientHeight / Math.max(scene.height, 1);
  view.scale = Math.max(0.02, Math.min(sx, sy) * 0.92);
  view.tx = (cv.clientWidth - scene.width * view.scale) / 2;
  view.ty = (cv.clientHeight - scene.height * view.scale) / 2;
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
}
window.addEventListener('resize', () => { resize(); draw(); });

// ---------- 绘制 ----------
function paint() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
  if (!scene) return;
  ctx.save();
  ctx.translate(view.tx, view.ty);
  ctx.scale(view.scale, view.scale);

  const vx0 = -view.tx / view.scale, vy0 = -view.ty / view.scale;
  const vx1 = vx0 + cv.clientWidth / view.scale, vy1 = vy0 + cv.clientHeight / view.scale;

  // nets：正交折线（focusNetId 高亮该网及全部同名网，其余变淡）
  ctx.font = '9px Consolas';
  const _focus = focusNetId;
  const hlPins = activeHighlight.pins, hlPads = activeHighlight.pads;
  const visible = visibleObjects(vx0, vy0, vx1, vy1);
  for (const netIndex of visible.nets) {
    const n = scene.nets[netIndex], netHighlighted = activeHighlight.nets.has(n.id);
    let strokeStyle, dash, lw;
    if (n.style === 'warn') { strokeStyle = C.warn; dash = [6, 3]; lw = 1.2; }
    else if (n.style === 'bus') { strokeStyle = C.net; dash = []; lw = 3; }
    else if (n.style === 'bitsel') { strokeStyle = C.netBitsel; dash = [4, 3]; lw = 1.2; }
    // 常量源 / 常量+wire 组合赋值（const 模块在块外）：用户要求用虚线连入
    else if (n.style === 'const') { strokeStyle = C.warn; dash = [4, 3]; lw = 1.2; }
    else { strokeStyle = C.net; dash = []; lw = 1.2; }
    if (netHighlighted) { strokeStyle = C.hl; lw = 4.5; dash = []; }
    else if (focusNetId) { strokeStyle = C.dim; }
    ctx.strokeStyle = strokeStyle; ctx.setLineDash(dash); ctx.lineWidth = lw;
    // 分叉点：只画后端标注的真 T 分叉（枝落点在干线跨度内部）；
    // 干线端点 / L 拐角不再画方块（用户反馈：简单转折不该有点）
    for (const j of (n.junctions || [])) {
      if (j[0] < vx0 || j[0] > vx1 || j[1] < vy0 || j[1] > vy1) continue;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(j[0] - 2, j[1] - 2, 4, 4);
    }
    for (const poly of n.polys) {
      // 视口裁剪（折线包围盒）
      const [x0,y0,x1,y1] = n.polyBounds[n.polys.indexOf(poly)];
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // 网名标签：默认隐藏；点击高亮（_hl）的网在锚点显示。悬停的网名在 draw() 末尾
    // 以跟随鼠标的 tooltip 呈现（屏幕坐标）。
    if (n.name && view.scale > 0.15 && netHighlighted) {
      ctx.fillStyle = C.hl;
      ctx.fillText(n.displayLabel, n.lx + 2, n.ly - 2);
    }
    // 内部 wire 名不再显示（用户裁定：只显示输入/输出端口名，即轨道 pad 上的顶层端口
    // 名标签）。此处原为 bndEnds 处的网名标签（=父模块内部 wire 名），与 pad 端口名重复
    // 且常被截断成无法分辨的灰字。
  }

  // 单 pin net stub：短线 + 空心圆（问题2：输出信号没有连线 → 标示内部驱动/负载未展开）
  for (const s of (scene.stubs || [])) {
    if (s.y < vy0 - 10 || s.y > vy1 + 10) continue;
    const dx = s.side === 'L' ? 18 : -18;
    ctx.strokeStyle = C.net;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + dx, s.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x + dx + (s.side === 'L' ? 4 : -4), s.y, 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // boundary pads（外缘端口）+ 方向标识
  // 方向没分清修复：输入 = 空心箭头 ▷（指向设计内），输出 = 实心箭头 ▶（指向设计外），
  // inout = 空心+实心双箭头；不添加 RTL 中不存在的端口组标题。
  const drawDirArrow = (x, y, filled) => {   // 8px 右向三角（数据流方向：左→右）
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x + 8, y);
    ctx.lineTo(x, y + 4);
    ctx.closePath();
    if (filled) ctx.fill();
    else { ctx.lineWidth = 1; ctx.stroke(); }
  };
  for (const padIndex of visible.pads) {
    const p = scene.pads[padIndex];
    if (p.y < vy0 - 10 || p.y > vy1 + 10) continue;   // 所有端口常显（hide 仅分类指示）
    const padHl = hlPads.has(p.name);
    if (!padHl && _focus) ctx.globalAlpha = 0.35;   // 聚焦时未连接端口变淡，突出高亮网络
    ctx.fillStyle = padHl ? C.hl : C.bnd;
    if (p.bus) ctx.fillRect(p.x - 4, p.y - scene.geometry.busPinHeight / 2, 8, scene.geometry.busPinHeight);
    else ctx.fillRect(p.x - 4, p.y - 3, 8, 6);
    // 方向箭头：in 空心（pad 右侧，流入设计）/ out 实心（pad 左侧，流出设计）/ inout 双箭头
    if (p.dir === 'in') {
      ctx.strokeStyle = padHl ? C.hl : C.bnd;
      drawDirArrow(p.x + 7, p.y, false);
    } else if (p.dir === 'out') {
      drawDirArrow(p.x - 15, p.y, true);
    } else if (p.dir === 'inout') {
      ctx.strokeStyle = padHl ? C.hl : C.bnd;
      drawDirArrow(p.x - 15, p.y, false);
      drawDirArrow(p.x + 7, p.y, true);
    } else {   // unknown：灰色 ? ——方向未定不猜，不伪装成双向/输出样式
      ctx.fillStyle = '#9aa8b5';
      ctx.font = 'bold 10px Consolas';
      ctx.fillText('?', p.x - 12, p.y + 3.5);
    }
    ctx.fillStyle = padHl ? C.hl : C.bndText;
    ctx.font = (p.bus ? 'bold ' : '') + '10px Consolas';
    const label = p.displayLabel;
    // pad 标签 = 顶层端口名（用户裁定：只显示输入/输出端口名）——恒显示，含对齐直连的 pad
    if (p.side === 'L') {
      const w = p.labelWidth;
      ctx.fillText(label, p.x - 8 - w, p.y + 3.5);   // 标签在 pad 左侧标签带内
    } else {
      ctx.fillText(label, p.x + 8, p.y + 3.5);
    }
    // 常量驱动的边界端口：画「接常数」标签（与块 constPins 同款），BUG2 修复——
    // 一眼看清常量驱动的输出端口是「接常数」而非漏画线。
    if (p.constValue) {
      const val = String(p.constValue);
      ctx.font = '8px Consolas';
      const tw = measureTextCached(val).width;
      ctx.strokeStyle = C.warn;
      ctx.fillStyle = C.warn;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      if (p.side === 'L') {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - 16, p.y);
        ctx.stroke();
        ctx.strokeRect(p.x - 22 - tw, p.y - 6, tw + 6, 12);
        ctx.fillText(val, p.x - 19 - tw, p.y + 3);
      } else {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 16, p.y);
        ctx.stroke();
        ctx.strokeRect(p.x + 16, p.y - 6, tw + 6, 12);
        ctx.fillText(val, p.x + 19, p.y + 3);
      }
    }
    ctx.globalAlpha = 1;
  }

  // blocks（Vivado 风：浅蓝填充 + 标题栏分隔线 + 块内 pin 标签）
  for (const blockIndex of visible.blocks) {
    const b = scene.blocks[blockIndex];
    const r = b.r;
    if (r.x + r.w < vx0 || r.x > vx1 || r.y + r.h < vy0 || r.y > vy1) continue;
    const isChecked = checked.has(b.key);
    ctx.fillStyle = b.isReg ? C.regFill : C.boxFill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = isChecked ? C.boxSel : (b.isReg ? C.regLine : C.boxLine);
    ctx.lineWidth = isChecked ? 2 : 1.2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    // 标题栏
    ctx.fillStyle = C.title;
    ctx.font = 'bold 11px Consolas';
    ctx.fillText(b.title, r.x + 8, r.y + 15);
    // 底部：被例化的模块名（type，灰色小字，居中；与顶部例化名区分）
    if (b.sub) {
      ctx.fillStyle = C.sub;
      ctx.font = '9px Consolas';
      const tw = b.subWidth;
      ctx.fillText(b.sub, r.x + (r.w - tw) / 2, r.y + r.h - 6);
    }
    if (b.expandable) {
      ctx.fillStyle = C.boxLine;
      ctx.font = '9px Consolas';
      ctx.fillText('»', r.x + r.w - 12, r.y + 15);
    }
    if (b.isReg) {
      ctx.fillStyle = C.regLine;
      ctx.font = '9px Consolas';
      ctx.fillText('R', r.x + r.w - 12, r.y + 15);
    }
    ctx.strokeStyle = C.boxLine;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + scene.geometry.pinTop - 4);
    ctx.lineTo(r.x + r.w, r.y + scene.geometry.pinTop - 4);
    ctx.stroke();
    // pins：方块贴缘 + 标签在块内（bus pin 保留行间隙；字号为该块自适应值；
    //       所有端口常显——hide 仅分类指示，不据此隐藏）
    for (const pinIndex of (visible.pins.get(blockIndex) || [])) {
      const p = b.pins[pinIndex];
      // 高亮连接到高亮网络的pin
      const pinHl = hlPins.has(b.key + '\u0000' + p.name);
      ctx.fillStyle = pinHl ? C.hl : C.pin;
      if (p.bus) ctx.fillRect(p.x - 3.5, p.y - scene.geometry.busPinHeight / 2, 7, scene.geometry.busPinHeight);
      else ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
      // 方向箭头（没分清修复）：输入 pin 空心 ▷（块外左侧，指向块内）；
      // 输出 pin 实心 ▶（块外右侧，指向块外）——与边界 pad 的空心/实心语义一致
      if (view.scale > 0.25) {
        ctx.strokeStyle = pinHl ? C.hl : C.pin;
        if (p.side === 'L') drawDirArrow(p.x - 12, p.y, false);
        else if (p.dir === 'out') drawDirArrow(p.x + 4, p.y, true);
        else if (p.dir === 'inout') { drawDirArrow(p.x - 8, p.y, false); drawDirArrow(p.x + 6, p.y, true); }
        else {   // unknown：灰色 ? 标记——方向未定不猜，绝不画成输出样式（BUG 修复：原 unknown 与输出同为实心▶）
          ctx.fillStyle = '#9aa8b5';
          ctx.font = 'bold 10px Consolas';
          ctx.fillText('?', p.x + 5, p.y + 3.5);
        }
      }
      if (view.scale > 0.05) {
        ctx.fillStyle = pinHl ? C.hl : (p.dir === 'unknown' ? '#8494a4' : C.pinText);
        ctx.font = (p.bus ? 'bold ' : '') + (b.pinFontPx || 10) + 'px Consolas';
        const label = p.displayLabel;
        if (p.side === 'L') ctx.fillText(label, p.x + 8, p.y + 3.5);
        else {
          const w = p.labelWidth;
          ctx.fillText(label, p.x - 8 - w, p.y + 3.5);
        }
      }
      // 常量标记：
      //   ① 单常量驱动的端口 → 值直接画在端口旁（预处理层在该端口上带 constValue，
      //      与边界 pad 的 constValue 标注同款：短线 + 橙色值框）。不造 const 块。
      //   ② 多常量 / 「常量+信号」混合 → 由预处理层合成块外 const 块 + style='const' 虚线网连入，
      //      块的画法就是下面通用的块绘制，故此处不再需要专门的"端口打值"分支。
      //   边界端口的常量值（boundary[].constValue）同样走 pad 标注。
      if (p.constValue && view.scale > 0.2) {
        const val = String(p.constValue);
        ctx.font = '8px Consolas';
        const tw = measureTextCached(val).width;
        ctx.strokeStyle = C.warn;
        ctx.fillStyle = C.warn;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        if (p.side === 'L') {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - 14, p.y);
          ctx.stroke();
          ctx.strokeRect(p.x - 20 - tw, p.y - 6, tw + 6, 12);
          ctx.fillText(val, p.x - 17 - tw, p.y + 3);
        } else {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + 14, p.y);
          ctx.stroke();
          ctx.strokeRect(p.x + 14, p.y - 6, tw + 6, 12);
          ctx.fillText(val, p.x + 17, p.y + 3);
        }
      }
    }
    // 端口折叠提示（§11 未做5 MAX_BLOCK_PINS）：单块端口超限时底部显示 "+N more"
    if (b.morePins > 0) {
      ctx.fillStyle = C.pinText;
      ctx.font = '9px Consolas';
      ctx.fillText('+' + b.morePins + ' more', r.x + 8, r.y + r.h - 5);
    }
    // BD 树单击定位：聚焦块画一圈高亮描边（在块外，不被 pin/标题覆盖）
    if (b.key === focusBlockKey) {
      ctx.strokeStyle = C.hl;
      ctx.lineWidth = 3;
      ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    }
  }
  ctx.restore();

  // 橡皮筋
  if (connectFrom && mouseW) {
    const src = worldPin(connectFrom.blockKey, connectFrom.port);
    if (src) {
      ctx.strokeStyle = C.warn;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(mouseW.x, mouseW.y);
      ctx.stroke();
      ctx.setLineDash([]);
      statusEl.textContent = tr('连线中：源=') + connectFrom.port + tr(' → 点击目标 pin（Esc 取消）');
    }
  }

  // 悬停网名 tooltip：跟随鼠标（屏幕坐标），白底描边保证压线可读
  if (hoverNetId && hoverScr && scene) {
    const meta = scene.netMeta.get(hoverNetId);
    const nm = meta && meta.name;
    if (nm) {
      const t = trunc(nm, 44);
      ctx.font = '11px Consolas';
      const tw = measureTextCached(t).width;
      let tx = hoverScr.x + 14, ty = hoverScr.y - 26;
      if (tx + tw + 16 > cv.clientWidth) tx = hoverScr.x - tw - 20;
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.strokeStyle = C.boxLine;
      ctx.lineWidth = 1;
      ctx.fillRect(tx, ty, tw + 12, 20);
      ctx.strokeRect(tx, ty, tw + 12, 20);
      ctx.fillStyle = C.title;
      ctx.fillText(t, tx + 6, ty + 14);
    }
  }

  // 悬停 const 块 tooltip：显示【该常量块对应引脚】的例化语句（多行，白底描边）
  // 内容由 UI 交付层合成（block.tip = {header, lines}），前端只负责画 —— 本层不做任何解析/合成。
  if (hoverConstKey && hoverScr && scene) {
    const b = scene.byKey.get(hoverConstKey);
    const tip = b && b.tip;
    if (tip && Array.isArray(tip.lines)) {
      const lines = tip.lines;
      ctx.font = 'bold 11px Consolas';
      const hw = tip.header ? measureTextCached(tip.header).width : 0;
      ctx.font = '10px Consolas';
      let maxw = hw;
      for (const L of lines) maxw = Math.max(maxw, measureTextCached(L).width);
      const bw = maxw + 16;
      const lh = 14;
      const bh = 8 + (tip.header ? 16 : 0) + lines.length * lh + 6;
      let tx = hoverScr.x + 16, ty = hoverScr.y + 12;
      if (tx + bw > cv.clientWidth) tx = Math.max(4, hoverScr.x - bw - 12);
      if (ty + bh > cv.clientHeight) ty = Math.max(4, hoverScr.y - bh - 12);
      ctx.fillStyle = 'rgba(255,255,255,0.97)';
      ctx.strokeStyle = C.warn;                 // 橙色描边：与 const 语义一致
      ctx.lineWidth = 1;
      ctx.fillRect(tx, ty, bw, bh);
      ctx.strokeRect(tx, ty, bw, bh);
      let y = ty + 6;
      if (tip.header) {
        ctx.fillStyle = C.title;
        ctx.font = 'bold 11px Consolas';
        ctx.fillText(tip.header, tx + 8, y + 11);
        y += 16;
      }
      ctx.fillStyle = C.warn;
      ctx.font = '10px Consolas';
      for (const L of lines) { ctx.fillText(L, tx + 8, y + 10); y += lh; }
    }
  }

  // 悬停总线粗端口 tooltip：罗列成员信号 + 是否真实连通（多行，蓝底描边）。
  // 行内容由预处理层给（busPinTip），前端只画——不在 UI 层判定连通性。
  if (hoverBusLines && hoverScr && scene) {
    const lines = hoverBusLines;
    const head = lines[0], body = lines.slice(1);
    ctx.font = 'bold 11px Consolas';
    const hw = measureTextCached(head).width;
    ctx.font = '10px Consolas';
    let maxw = hw;
    for (const L of body) maxw = Math.max(maxw, measureTextCached(L).width);
    const bw = maxw + 18;
    const lh = 14;
    const bh = 8 + 16 + body.length * lh + 6;
    let tx = hoverScr.x + 16, ty = hoverScr.y + 12;
    if (tx + bw > cv.clientWidth) tx = Math.max(4, hoverScr.x - bw - 12);
    if (ty + bh > cv.clientHeight) ty = Math.max(4, hoverScr.y - bh - 12);
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    ctx.strokeStyle = C.hl;                     // 蓝色描边：与总线语义一致
    ctx.lineWidth = 1;
    ctx.fillRect(tx, ty, bw, bh);
    ctx.strokeRect(tx, ty, bw, bh);
    ctx.fillStyle = C.title;
    ctx.font = 'bold 11px Consolas';
    ctx.fillText(head, tx + 9, ty + 18);
    ctx.font = '10px Consolas';
    let y = ty + 8 + 16;
    for (const L of body) {
      ctx.fillStyle = L.charAt(0) === '✗' ? C.warn : C.pinText;   // 未连通的成员用橙色
      ctx.fillText(L, tx + 9, y + 10);
      y += lh;
    }
  }
}

function worldPin(blockKey, portName) {
  if (!scene) return null;
  const b = scene.byKey.get(blockKey);
  return (b && pinMaps.get(blockKey).get(portName)) || null;
}

function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------- 命中 ----------
function toWorld(px, py) { return { x: (px - view.tx) / view.scale, y: (py - view.ty) / view.scale }; }
function blockAt(wx, wy) {
  for (const e of candidates(wx,wy,wx,wy,0)) {
    const b=scene.blocks[e[1]],r=b.r;
    if(wx>=r.x&&wx<=r.x+r.w&&wy>=r.y&&wy<=r.y+r.h)return b;
  }
  return null;
}
function pinAt(wx, wy) {
  const th = 6 / view.scale;
  for (const e of candidates(wx-th,wy-th,wx+th,wy+th,1)) {
    const b=scene.blocks[e[1]], p=b.pins[e[2]];
    if (Math.abs(wx-p.x)<=th && Math.abs(wy-p.y)<=th) return { blockKey:b.key,port:p.name,pin:p };
  }
  return null;
}
function padAt(wx, wy) {
  const th = 8 / view.scale;
  for (const e of candidates(wx-th,wy-th,wx+th,wy+th,2)) {
    const p=scene.pads[e[1]];if(Math.abs(wx-p.x)<=th&&Math.abs(wy-p.y)<=th)return p;
  }
  return null;
}

function distToSegSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return (px - x1) ** 2 + (py - y1) ** 2;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
}
function wireAt(wx, wy) {
  if (!scene) return null;
  const th=Math.max(4,6/view.scale);let best=null,bestD=th*th;
  for(const e of candidates(wx-th,wy-th,wx+th,wy+th,3)) {
    const n=scene.nets[e[1]],poly=n.polys[e[2]],p=poly[e[3]],q=poly[e[3]+1];
    const d=distToSegSq(wx,wy,p[0],p[1],q[0],q[1]);if(d<=bestD){bestD=d;best=n.id;}
  }
  return best;
}

function netSignalOf(blockKey, port) {
  if (!scene) return null;
  return scene.netKey.get(blockKey + '\u0000' + port) || null;
}

// 总线粗端口的成员摘要（点开总线的入口）。成员清单与「是否真实连通」全部由预处理层标好，
// 这里只罗列——两端信号集不一致时（master 有 tuser / slave 没有），未连通的成员会明确列出，
// 用户由此看出"总线上有根信号没接"，而不是整根线静默消失。
function busPinSummary(p) {
  const ms = p.busMembers || [];
  const head = (p.label || p.name) + '  [' + (p.busType || 'bus') + ']  '
    + ms.length + tr(' 成员 / ') + (p.busConnected != null ? p.busConnected : ms.length) + tr(' 连通');
  const list = ms.map(m => (m.connected ? '✓' : '✗') + (m.logical || m.port)).join('  ');
  return head + (list ? '：' + list : '');
}
// 总线粗端口悬停时鼠标旁的浮层（与悬停连线同一套 tooltip 机制）。
function busPinTip(p) {
  const ms = p.busMembers || [];
  const lines = [(p.label || p.name) + '  [' + (p.busType || 'bus') + ']'];
  for (const m of ms) {
    lines.push((m.connected ? '✓ ' : '✗ ') + (m.logical || m.port)
      + (m.width && m.width > 1 ? ' [' + m.width + ']' : '')
      + (m.connected ? '' : tr('（无对端）')));
  }
  return lines;
}

// 高亮焦点网络（含全部同名网）。再次点击同一网络（id 相同）→ 取消高亮。
function setFocusNet(nid, sigName) {
  focusNetId = (focusNetId === nid ? null : nid);
  focusName = focusNetId ? (tr('高亮网络: ') + sigName) : '';
  const meta = focusNetId && scene.netMeta.get(focusNetId);
  const group = meta && scene.connectivity.groups[meta.groupId];
  activeHighlight = { nets:new Set(group ? group.nets : []), pins:new Set(group ? group.pins : []), pads:new Set(group ? group.pads : []) };
  window.__bdhighlight = activeHighlight;
  draw();
  statusEl.textContent = focusName || tr('已取消高亮');
}

// BD 树单击定位：把指定实例块居中并高亮（不改变勾选/导出状态）。
// f: { inst, type } —— 先按实例名精确匹配；generate 展开后实例名被改写时，退而按类型匹配
// （同类型唯一则直接定位，多个则取前缀匹配者），避免「定位失败」。
function focusBlock(f) {
  if (!scene || !f) { statusEl.textContent = tr('尚未加载 Block Design'); return; }
  const inst = f.inst, type = f.type;
  let b = scene.blocks.find(bl => bl.inst === inst);
  if (!b && type) {
    const cand = scene.blocks.filter(bl => bl.type === type);
    if (cand.length === 1) b = cand[0];
    else if (cand.length > 1) b = cand.find(bl => (bl.inst || '').startsWith(inst)) || cand[0];
  }
  if (!b) { statusEl.textContent = tr('定位失败：当前视图无实例块 ') + (inst || ''); return; }
  focusBlockKey = b.key;
  const r = b.r;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const s = Math.max(view.scale, 0.5);   // 保证被定位块足够清晰（已放大时不强行缩放）
  view.scale = s;
  view.tx = cv.clientWidth / 2 - cx * s;
  view.ty = cv.clientHeight / 2 - cy * s;
  draw();
  statusEl.textContent = tr('定位: ') + b.inst + '  (' + b.type + ')';
}

// ---------- 交互 ----------
cv.addEventListener('mousedown', e => {
  // 仅左键参与单击/双击/勾选/连线/平移。BUG 修复：mousedown 对所有按键都触发，
  // 原先右键 mousedown 也进入本 handler —— 左键单击块后 400ms 内右键同一块（想弹菜单）
  // 会被 lastClick 双击判定误判为"双击"，直接跳进下级模块/源码。右键行为全权交给 contextmenu。
  if (e.button !== 0) return;
  const w = toWorld(e.offsetX, e.offsetY);
  const pin = pinAt(w.x, w.y);
  const pad = padAt(w.x, w.y);
  if (pin) {
    if (!connectFrom) {
      const sig = netSignalOf(pin.blockKey, pin.port);
      if (sig) {
        // 单击已连 pin → 高亮该接口所属的整条（同名）网络（再点取消）
        let nid = scene.netByPort.get(pin.blockKey + '\u0000' + pin.port);
        if (nid && scene.absorbedToBus) nid = scene.absorbedToBus.get(nid) || nid;   // 被吸收位选→总线网
        setFocusNet(nid, sig);
        // 总线粗端口：高亮之余把成员清单打进状态栏（点开总线的入口）。
        // 成员是否真实连通由预处理层标好（connected），前端只罗列，不判定。
        if (pin.pin && pin.pin.bus && pin.pin.busMembers && pin.pin.busMembers.length)
          statusEl.textContent = busPinSummary(pin.pin);
        return;
      }
      // 单常量驱动的端口没有网（值已写在端口旁）→ 说明是常量输入，不是悬空
      statusEl.textContent = pin.constValue
        ? tr('该 pin 由常量 ') + pin.constValue + tr(' 驱动（无网可高亮）')
        : tr('该 pin 未连接（悬空），只能作为连线终点');
      // 总线端口即便没有网（全部成员都无对端）也要能点开看成员
      if (pin.pin && pin.pin.bus && pin.pin.busMembers && pin.pin.busMembers.length)
        statusEl.textContent = busPinSummary(pin.pin);
    } else if (pin.blockKey === connectFrom.blockKey) {
      connectFrom = null; draw(); updateStatus();
    } else {
      const sig = netSignalOf(connectFrom.blockKey, connectFrom.port);
      const a = api();
      if (a && sig) a.postMessage({ type: 'rewire', blockKey: pin.blockKey, port: pin.port, newSignal: sig });
      connectFrom = null;
    }
    return;
  }
  if (pad) {
    if (!connectFrom) {
      const sig = scene.netKey.get(pad.name);
      let nid = scene.netByPort.get(pad.name);
      if (nid && scene.absorbedToBus) nid = scene.absorbedToBus.get(nid) || nid;
      if (nid) { setFocusNet(nid, sig); return; }
      statusEl.textContent = tr('该端口未连接');
    } else {
      connectFrom = null; draw(); updateStatus();
    }
    return;
  }
  if (connectFrom) { connectFrom = null; draw(); updateStatus(); return; }
  // 点击连线 → 高亮该网络（及全部同名网、连接的引脚）
  const wid = wireAt(w.x, w.y);
  if (wid) {
    const meta = scene.netMeta.get(wid);
    setFocusNet(wid, meta ? meta.name : '');
    return;
  }
  const b = blockAt(w.x, w.y);
  if (b) {
    const r = b.r;
    const onCheckbox = w.x >= r.x + 4 && w.x <= r.x + 18 && w.y >= r.y + 3 && w.y <= r.y + 17;
    const ctrl = e.ctrlKey || e.metaKey;
    const now = Date.now();
    // 双击打开只在【无 ctrl】时判断（ctrl 复选不触发双击，否则 Ctrl 连点会误开模块）
    const isDouble = !ctrl && lastClick.key === b.key && now - lastClick.t < 400 &&
      (w.x - lastClick.x) ** 2 + (w.y - lastClick.y) ** 2 < 100;
    if (onCheckbox || !isDouble) {
      // 单击块任意区域（含勾选框）→ 选中/取消
      if (ctrl) {
        // Ctrl 复选：toggle 该块，不影响其它
        if (checked.has(b.key)) checked.delete(b.key); else checked.add(b.key);
      } else if (checked.has(b.key) && checked.size > 1) {
        // 已多选时单击其中一块：保持多选不变（不重置为单选）
        // ——否则用户 Ctrl 多选后单击任一已选块，多选被清掉
      } else {
        // 单击未选块（或单选状态下）：单选（只选这个）
        checked = new Set([b.key]);
      }
      draw(); updateStatus();
      const a = api();
      if (a) a.postMessage({ type: 'selectionChanged', ids: [...checked] });
      if (!isDouble) lastClick = { key: b.key, t: now, x: w.x, y: w.y };
      return;
    }
    // 双击（无 ctrl，且不是勾选框）→ 打开模块
    if (b.isConst) {
      // 常量源伪块：没有源码也没有子模块，提示说明即可（不打开空文件）
      const a = api();
      if (a) a.postMessage({ type: 'notice', message: '"' + b.inst + '" ' + tr('是常量源（const），没有源码定义，也没有内部模块。') });
    } else if (b.expandable) {
      const a = api();
      // 带「该子模块在当前作用域里被例化的位置」，供后端记录 originInst（顶层/跳例化用）
      navigate(b.key, 'enterScope');
    } else {
      const a = api();
      navigate(b.key, 'definition');
    }
    lastClick = { key: null, t: 0, x: 0, y: 0 };
  } else {
    // 点击空白：无 ctrl 且有选中 → 取消选择；否则平移
    if (!e.ctrlKey && checked.size) {
      checked = new Set();
      draw(); updateStatus();
      const a = api();
      if (a) a.postMessage({ type: 'selectionChanged', ids: [] });
      return;
    }
    mode = 'panning';
    panStart = { px: e.offsetX, py: e.offsetY, tx: view.tx, ty: view.ty };
    cv.style.cursor = 'grabbing';
  }
});
let pointerEvent = null, pointerScheduled = false;
window.addEventListener('mousemove', e => {
  pointerEvent = { offsetX:e.offsetX,offsetY:e.offsetY };
  if(pointerScheduled)return;
  pointerScheduled=true;requestAnimationFrame(()=>{pointerScheduled=false;const latest=pointerEvent;pointerEvent=null;if(latest)pointerMove(latest);});
});
function pointerMove(e) {
  if (connectFrom) { mouseW = toWorld(e.offsetX, e.offsetY); draw(); }
  if (mode === 'panning') {
    view.tx = panStart.tx + (e.offsetX - panStart.px);
    view.ty = panStart.ty + (e.offsetY - panStart.py);
    draw();
    return;
  }
  // 悬停连线 → 鼠标旁 tooltip 显示该网名称（hoverNetId 变化才重绘，避免 mousemove 高频重画）
  // 悬停 const 块 → tooltip 显示该常量块对应引脚的例化语句（内容由 UI 交付层给，前端只画）
  // 悬停总线粗端口 → tooltip 罗列成员信号及是否连通（点开总线的预览）
  if (!connectFrom && scene) {
    const w = toWorld(e.offsetX, e.offsetY);
    const wid = wireAt(w.x, w.y);
    const hb = blockAt(w.x, w.y);
    const ckey = (hb && hb.isConst && hb.tip) ? hb.key : null;
    const bp = pinAt(w.x, w.y);
    const bpin = (bp && bp.pin && bp.pin.bus && bp.pin.busMembers && bp.pin.busMembers.length) ? bp.pin : null;
    const bkey = bpin ? bp.blockKey + '\u0000' + bp.port : null;
    hoverScr = { x: e.offsetX, y: e.offsetY };
    if (wid !== hoverNetId || ckey !== hoverConstKey || bkey !== hoverBusPinKey) {
      hoverNetId = wid;
      hoverConstKey = ckey;
      hoverBusPinKey = bkey;
      hoverBusLines = bpin ? busPinTip(bpin) : null;
      cv.style.cursor = (wid || ckey || bkey) ? 'pointer' : 'grab';
      const meta = wid ? scene.netMeta.get(wid) : null;
      statusEl.textContent = [focusName,
        meta && meta.name ? tr('悬停: ') + meta.name : '',
        ckey ? tr('常量 ') + (hb.inst || '') : '',
        bpin ? busPinSummary(bpin) : '',
      ].filter(Boolean).join('  |  ') || tr('就绪');
      draw();
    } else if (wid || ckey || bkey) {
      draw();   // tooltip 跟随鼠标移动
    }
  }
}
cv.addEventListener('mouseleave', () => {
  pointerEvent = null;
  if (hoverNetId || hoverConstKey || hoverBusPinKey) {
    hoverNetId = null; hoverConstKey = null; hoverBusPinKey = null; hoverBusLines = null; hoverScr = null; draw();
  }
  hoverScr = null;
});
window.addEventListener('mouseup', () => { mode = 'idle'; cv.style.cursor = 'grab'; });
// ---------- 右键菜单 ----------
const ctxMenu = document.getElementById('ctxMenu');
function showCtxMenu(x, y) {
  if (!ctxMenu) return;
  // 菜单随鼠标位置（限制在视口内）
  ctxMenu.style.display = 'block';
  ctxMenu.style.left = Math.min(x, cv.clientWidth - 170) + 'px';
  ctxMenu.style.top = Math.min(y, cv.clientHeight - 100) + 'px';
}
function hideCtxMenu() { if (ctxMenu) ctxMenu.style.display = 'none'; }
let ctxBlock = null;   // 右键菜单触发时记录的目标 block（供菜单项取 IP 类型名）
cv.addEventListener('contextmenu', e => {
  e.preventDefault();
  // 右键打断双击序列（防御）：清掉左键单击计时，防止后续误判
  lastClick = { key: null, t: 0, x: 0, y: 0 };
  // 右键点块：若该块未选中且无 ctrl → 单选它（右键操作目标）
  const w = toWorld(e.offsetX, e.offsetY);
  const b = blockAt(w.x, w.y);
  ctxBlock = b || null;
  if (b && !checked.has(b.key) && !e.ctrlKey) {
    checked = new Set([b.key]);
    draw(); updateStatus();
    const a = api();
    if (a) a.postMessage({ type: 'selectionChanged', ids: [...checked] });
  }
  showCtxMenu(e.clientX || e.offsetX, e.clientY || e.offsetY);
});
window.addEventListener('mousedown', e => {
  // 菜单内部点击不隐藏（否则 mousedown 先把菜单 display:none，后续 click 被吞——
  // 菜单项点击"没反应"的根因）
  if (ctxMenu && ctxMenu.contains(e.target)) return;
  if (e.button !== 2) hideCtxMenu();
});
// 菜单项
const ctxOpenSource = document.getElementById('ctxOpenSource');
if (ctxOpenSource) ctxOpenSource.addEventListener('click', () => {
  hideCtxMenu(); if (ctxBlock) navigate(ctxBlock.key, 'definition');
});
const ctxGotoInst = document.getElementById('ctxGotoInst');
if (ctxGotoInst) ctxGotoInst.addEventListener('click', () => {
  hideCtxMenu(); navigate(ctxBlock ? ctxBlock.key : '@scope', 'instantiation');
});
const ctxExportSim = document.getElementById('ctxExportSim');
const ctxExportFiles = document.getElementById('ctxExportFiles');
const ctxClearSel = document.getElementById('ctxClearSel');
const ctxTestInject = document.getElementById('ctxTestInject');
if (ctxTestInject) ctxTestInject.addEventListener('click', () => {
  hideCtxMenu();
  statusEl.textContent = tr('正在发送测试消息到 AI 会话…');
  const a = api();
  if (a) a.postMessage({ type: 'testInject' });
});
const ctxFetchIpPorts = document.getElementById('ctxFetchIpPorts');
if (ctxFetchIpPorts) ctxFetchIpPorts.addEventListener('click', () => {
  hideCtxMenu();
  if (!ctxBlock) { statusEl.textContent = tr('请先右键点击一个 IP 模块'); return; }
  const a = api();
  if (a) a.postMessage({ type: 'fetchIpPorts', ipType: ctxBlock.type });
});
const ctxExplainModule = document.getElementById('ctxExplainModule');
if (ctxExplainModule) ctxExplainModule.addEventListener('click', () => {
  hideCtxMenu();
  if (!ctxBlock) { statusEl.textContent = tr('请先右键点击一个模块'); return; }
  statusEl.textContent = tr('正在交给 AI 讲解模块 ') + ctxBlock.type + '…';
  const a = api();
  // module=块类型名（模块定义名）；file=该模块定义源码路径（黑盒为空 → 扩展端走黑盒分支）
  if (a) a.postMessage({ type: 'explainModule', module: ctxBlock.type, objectId: ctxBlock.key });
});
if (ctxExportSim) ctxExportSim.addEventListener('click', () => {
  hideCtxMenu();
  if (!checked.size) { statusEl.textContent = tr('请先选择模块（单击/Ctrl 多选）'); return; }
  const a = api();
  if (a) a.postMessage({ type: 'exportToSim', ids: [...checked], module: scene ? scene.module : '' });
});
if (ctxExportFiles) ctxExportFiles.addEventListener('click', () => {
  hideCtxMenu();
  const a = api();
  if (a) a.postMessage({ type: 'export', ids: [...checked] });
});
if (ctxClearSel) ctxClearSel.addEventListener('click', () => {
  hideCtxMenu();
  if (checked.size) {
    checked = new Set();
    draw(); updateStatus();
    const a = api();
    if (a) a.postMessage({ type: 'selectionChanged', ids: [] });
  }
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && connectFrom) { connectFrom = null; draw(); updateStatus(); }
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const ns = Math.max(0.02, Math.min(4, view.scale * factor));
  view.tx = e.offsetX - (e.offsetX - view.tx) * (ns / view.scale);
  view.ty = e.offsetY - (e.offsetY - view.ty) * (ns / view.scale);
  view.scale = ns;
  draw();
}, { passive: false });

// ---------- 工具栏 ----------
if (btnBus) btnBus.addEventListener('click', () => {
  const a = api();
  if (a) a.postMessage({ type: 'setBusView', on: !busViewEnabled });
});
btnBack.addEventListener('click', () => {
  const a = api();
  if (a && trail.length) a.postMessage({ type: 'navigateBack' });
});
btnExport.addEventListener('click', () => {
  const a = api();
  if (a) a.postMessage({ type: 'export' });
});

function updateChrome() {
  if (pathEl) pathEl.textContent = [...trail, scene ? scene.module : ''].join('  ›  ');
  if (btnBack) btnBack.disabled = trail.length === 0;
  if (btnBus) btnBus.setAttribute('aria-pressed', String(busViewEnabled));
}

function updateStatus() {
  statusEl.textContent = 'blocks=' + (scene ? scene.blocks.length : 0) +
    '  nets=' + (scene ? scene.nets.length : 0) +
    tr('  已勾选 ') + checked.size;
}

resize();
updateChrome();
statusEl.textContent = tr('等待数据...');
(function () { const a = api(); if (a) a.postMessage({ type: 'ready' }); })();
