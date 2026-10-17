// Author: Airtl yu

// Contact: yuairtl@outlook.com
// ui_design/graphProvider.js — 建图/渲染走 C++ 原生库（Airtl）
//
// 【这个文件是干什么的】扩展与 Airtl 之间的一层薄封装。它只做三件事：
//   ① 把 JS 侧的文件清单转成原生要的路径数组，建图拿 handle
//   ② 把 parentParams 从 Map 转成普通对象（原生绑定用 GetPropertyNames 读，
//     传 Map 进去会静默取到 0 个参数——参数化顶层的高度/位宽全错且不报错）
//   ③ 统一 handle 生命周期（loadGraph / freeGraph / invalidateFile）
//
// 【没有 JS 回退，是刻意的】blockgraph.js + layout.js 那套 JS 实现已被本模块
// 完全替代，随包发布属于源码冗余（269 KB 死代码），已从 .vscodeignore 排掉。
// 原生库加载失败时本模块直接抛错，不静默退回任何东西——产品不需要托底，
//  silently 降级比明确失败更难查。JS 实现仍留在【开发树】里，用途只有一个：
// 当差分测试的比对基准（Airtl/test/diff-*.js），不是运行时备胎。
'use strict';

const path = require('path');
const AIRTL_ROOT = path.join(__dirname, '..', 'Airtl');
const { SceneCache } = require('./sceneCache');
const { applyTextPatch } = require('./media/sceneProtocol');
const sceneCaches = new WeakMap();
function scenes(graph) { if (!sceneCaches.has(graph)) sceneCaches.set(graph, new SceneCache()); return sceneCaches.get(graph); }
function clearScenes(graph) { if (graph) { const cache = sceneCaches.get(graph); if (cache) cache.clear(); graph.sceneEpoch = (graph.sceneEpoch || 0) + 1; } }

// 原生库：加载失败不抛，记下来供诊断
let airtl = null, airtlErr = null;
try {
  airtl = require(path.join(AIRTL_ROOT, 'index.js'));
  if (!airtl.isNative()) { airtlErr = new Error('Airtl 退回了 JS 参考实现，原生库没编出来'); airtl = null; }
} catch (e) { airtlErr = e; }

// 取原生库。不在就明确抛——调用方（含 exportToSim 那条路）不该猜发生了什么。
function native() {
  if (!airtl) {
    throw new Error('原生库 Airtl 加载失败：'
      + (airtlErr ? String(airtlErr.message || airtlErr) : '未知原因')
      + '。请重新构建 Airtl（Airtl: npm run build）。');
  }
  return airtl;
}

// 供 activate 时打一行日志：原生库在不在、什么版本。
function describe() {
  return airtl
    ? 'C++ (Airtl ' + airtl.version() + ')'
    : 'C++ (Airtl) 加载失败: ' + String(airtlErr && (airtlErr.message || airtlErr));
}

// ── 建图 ────────────────────────────────────────────────────────────
// 返回 { moduleDefs: Map, instTypes: Set, topCandidates: [], handle, free() }
function loadGraph(hdlFiles, opts) {
  opts = opts || {};
  const nat = native();
  // JS 的 loadProjectGraph 收 {path} 对象数组；原生 graphLoad 收字符串路径数组。
  const paths = [];
  for (const f of hdlFiles) {
    const p = (typeof f === 'string') ? f : f.path;
    if (p) paths.push(p);
  }
  // 【graphLoad 返回的是 {handle, modules}，不是 handle 本身】第一版直接把返回值
  // 当 handle 传给 graphIndex，报 "graphIndex: handle 无效"——看着像 handle 表
  // 没共用，其实是自己把对象当数字传了。
  // VS Code supplies user settings; filesystem discovery is shared by consumers.
  let setting = '';
  try { setting = (opts.vscode || require('vscode')).workspace.getConfiguration('vivadoProjectExplorer').get('vivadoPath') || ''; }
  catch (_) { /* Native callers can run without VS Code. */ }
  const libs = require('./vivado').libDirs(setting);
  const loaded = nat.graphLoad(paths, { shared: true, vivadoUnisimDir: libs.unisimDir || '', vivadoXpmDirs: libs.xpmDirs || [] });
  const handle = loaded.handle;

  // topCandidates 直接在 C++ 内算（graphTopCandidates），不经 JS。
  // 【原先这里是一趟纯浪费的往返】graphIndex 把 183 个模块的全部例化表
  // 序列化成 118.8 KB 搬到 JS → 包成 Map/Set → 原样搬回 C++ 调
  // buildHierarchyFromDefs → 最后只用 10 个候选顶层（1469 字节）。
  // 实测那趟 4.24 ms，99% 的数据是白搬的。
  const topCandidates = nat.graphTopCandidates(handle) || [];

  // moduleDefs / instTypes 改成【懒加载】。闭包里只有树视图和 BD 面板的
  // 少数分支真需要完整模块表（webviewProvider 里 15 处 .has/.get），
  // 多数调用方只碰 topCandidates。不碰就一次 graphIndex 都不发，
  // 118.8 KB 的回传直接消失。
  let _idx = null;
  let moduleDefs = null, instTypes = null;
  let freed = false;
  function idx() {
    if (!_idx) _idx = nat.graphIndex(handle);
    return _idx;
  }

  return {
    handle,
    modules: loaded.modules,
    get disposed() { return freed; },
    paths,
    opts,
    get moduleDefs() { return moduleDefs || (moduleDefs = new Map(idx().moduleDefs)); },
    get instTypes() { return instTypes || (instTypes = new Set(idx().instTypes)); },
    get moduleCount() { return idx().moduleDefs.length; },
    topCandidates,
    free() {
      if (freed) return;
      freed = true;
      nat.graphFree(handle);
    }
  };
}

// ── 渲染：L2+L3+L4 一把出 ──────────────────────────────────────────
// 返回 { scope, layout, busView, file, module, unresolved }。
// 【曾经的 busGroups 已删】L3 产出的它是喂 FoldBusView 的内部中间产物（折叠结果
// 已在 scope.blocks/nets/boundary 里），前端 media/main.js 对它零引用。原来顶层 +
// scope 内各序列化一遍，白送 20 KB 死载荷；原生侧还为此整树深拷一次。
// 找不到模块时返回 null。
function renderScope(graph, moduleName, opts) {
  opts = opts || {};
  if (!graph) return null;
  const busView = !!opts.busView;
  // 【parentParams 必须转成普通对象】扩展那边 pp 是 Map，而原生绑定用
  // GetPropertyNames() 读它——Map 的条目不是属性，传 Map 进去会静默取到 0 个
  // 参数，表现为"参数化顶层的高度/位宽全错且不报错"。
  const pp = opts.parentParams;
  const ppObj = (pp && typeof pp === 'object' && !(pp instanceof Map)) ? pp
    : (pp instanceof Map ? Object.fromEntries(pp) : undefined);
  return native().renderScope(graph.handle, moduleName,
    Object.assign({ busView }, ppObj ? { parentParams: ppObj } : {}));
}

// 定向失效：只重析被改的那个文件（对应 JS 侧 bg.invalidateFile）
function invalidateFile(graph, file) {
  clearScenes(graph);
  if (graph && graph.handle !== undefined) native().graphInvalidate(graph.handle, [file]);
}

// 工程关闭/切换时调，释放原生 handle
function freeGraph(graph) {
  clearScenes(graph);
  if (graph && typeof graph.free === 'function') graph.free();
}

async function renderScene(graph, moduleName, options = {}) {
  if (!graph || graph.disposed) throw new Error('Scene graph has been released');
  const nat = native(), runtime = nat.__runtimeInfo();
  if (!runtime.alive || runtime.failed) { clearScenes(graph); throw new Error('Airtl parser unavailable; reload the project'); }
  const cache = scenes(graph), key = cache.key(moduleName, { ...options, session: runtime.session, epoch: graph.sceneEpoch || 0 });
  const cached = cache.get(key); if (cached) return cached;
  const epoch = graph.sceneEpoch || 0;
  const scene = await nat.renderSceneAsync(graph.handle, moduleName, options);
  if (!scene) return null;
  if (graph.disposed || (graph.sceneEpoch || 0) !== epoch || nat.__runtimeInfo().session !== runtime.session) return null;
  return Object.assign(cache.set(key, scene, runtime, graph.handle), { graphEpoch: epoch });
}
async function refineScene(graph, record, widths) {
  const nat = native(), runtime = nat.__runtimeInfo(), epoch = graph.sceneEpoch || 0;
  if (runtime.session !== record.session || !runtime.alive) throw new Error('Scene runtime expired');
  const patch = await nat.refineSceneAsync(graph.handle, record.nativeId, widths, true);
  if (graph.disposed || (graph.sceneEpoch || 0) !== epoch || nat.__runtimeInfo().session !== runtime.session) return null;
  const qualifiedPatch = { ...patch, baseSceneId: record.scene.sceneId, sceneId: runtime.session + '/' + graph.handle + '/' + patch.sceneId };
  const scene = { ...applyTextPatch({ ...record.scene, sceneId: record.nativeId }, patch), navigation: record.navigation };
  return Object.assign(scenes(graph).set(record.key, scene, runtime, graph.handle), { graphEpoch: epoch, patch: qualifiedPatch });
}
function sceneStats(graph) { const c = sceneCaches.get(graph); return c ? { hits:c.hits, misses:c.misses, bytes:c.bytes, entries:c.entries.size } : { hits:0,misses:0,bytes:0,entries:0 }; }

module.exports = {
  describe, loadGraph, renderScope, renderScene, refineScene, clearScenes, sceneStats, invalidateFile, freeGraph,
  // 只走原生路径的调用方用（原生缺失会明确抛错）
  native,
  // 诊断用：原生库到底加载上没有、失败原因
  nativeAvailable: () => !!airtl,
  nativeError: () => (airtlErr ? String(airtlErr.message || airtlErr) : null)
};
