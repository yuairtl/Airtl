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
const fs = require('fs');
const AIRTL_ROOT = path.join(__dirname, '..', 'Airtl');
const { SceneCache } = require('./sceneCache');
const { applyTextPatch } = require('./media/sceneProtocol');
const analysisContext = require('../analysisContext');
const sceneCaches = new WeakMap();
const sceneRequests = new WeakMap();
let nextRequestOwner = 0;
let displayOwner = null;
function scenes(graph) { if (!sceneCaches.has(graph)) sceneCaches.set(graph, new SceneCache()); return sceneCaches.get(graph); }
function requests(graph) {
  if (!sceneRequests.has(graph)) sceneRequests.set(graph, { queueKey: 'scene:' + ++nextRequestOwner, display: null });
  return sceneRequests.get(graph);
}
function cancelSceneRequests(graph) {
  const owners = graph ? [graph] : [];
  // Tree and BD wrappers can hold separate references to one native snapshot.
  // Cancelling that generation through either wrapper must reach the panel.
  if (displayOwner && (!graph || displayOwner.handle === graph.handle)) {
    if (displayOwner !== graph) owners.push(displayOwner);
    displayOwner = null;
  }
  for (const owner of owners) {
    const state = sceneRequests.get(owner);
    if (!state) continue;
    if (state.display) state.display.cancelled = true;
    if (airtl) {
      airtl.cancelAsync(state.queueKey, true);
      if (state.display) airtl.cancelAsync(state.display.queueKey, true);
    }
    state.display = null;
  }
}
function beginSceneRequest(graph) {
  if (!graph || graph.disposed) throw new Error('Scene graph has been released');
  cancelSceneRequests();
  cancelSceneRequests(graph);
  const request = { graph, epoch: graph.sceneEpoch || 0, queueKey: 'display:' + ++nextRequestOwner, cancelled: false };
  requests(graph).display = request;
  displayOwner = graph;
  return request;
}
function currentRequest(graph, request) {
  return !graph.disposed && (!request || (!request.cancelled && request.graph === graph &&
    request.epoch === (graph.sceneEpoch || 0)));
}
function clearScenes(graph) {
  if (!graph) return;
  cancelSceneRequests(graph);
  const cache = sceneCaches.get(graph); if (cache) cache.clear();
  graph.sceneEpoch = (graph.sceneEpoch || 0) + 1;
}

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

function slangFrontendPath() {
  const libName = process.platform === 'win32' ? 'airtl_sv_frontend.dll'
    : process.platform === 'darwin' ? 'libairtl_sv_frontend.dylib' : 'libairtl_sv_frontend.so';
  const candidates = [
    path.join(AIRTL_ROOT, 'native', libName),
    path.join(AIRTL_ROOT, '..', '..', 'build', 'slang-frontend', `${process.platform}-${process.arch}`, 'bin', libName),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

// ── 建图 ────────────────────────────────────────────────────────────
// 返回 { moduleDefs: Map, instTypes: Set, topCandidates: [], handle, free() }
function graphInputs(hdlFiles, opts, libs) {
  opts = opts || {};
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
  const svFiles = Array.isArray(opts.svFiles) ? opts.svFiles.map(f => typeof f === 'string' ? f : f && f.path).filter(Boolean)
    : paths.filter(p => /\.(?:v|sv)$/i.test(p));
  const compilation = analysisContext.normalize({ files: svFiles, top: opts.topModule,
    includeDirs: opts.includeDirs, defines: opts.defines,
    languageStandard: languageStandardSetting(opts),
    libraryDirs: opts.libraryDirs, libraryFiles: opts.libraryFiles, libraryExtensions: opts.libraryExtensions,
    parameters: opts.parameters, fileSetContexts: opts.fileSetContexts, fileRecords: opts.fileRecords });
  return { paths, compilation, options: {
    shared: !opts.forceReparse,
    forceReparse:!!opts.forceReparse,
    vivadoUnisimDir: libs.unisimDir || '',
    vivadoXpmDirs: libs.xpmDirs || [],
    svFrontendPath: slangFrontendPath(),
    topModule: typeof opts.topModule === 'string' ? opts.topModule : '',
    svFiles: compilation.files,
    includeDirs: compilation.includeDirs, defines: compilation.defines,
    languageStandard: compilation.languageStandard,
    parameters: compilation.parameters,
    libraryDirs: compilation.libraryDirs, libraryFiles: compilation.libraryFiles, libraryExtensions: compilation.libraryExtensions,
    fileSetContexts: compilation.fileSetContexts, fileRecords: compilation.fileRecords,
  } };
}
function vivadoSetting(opts = {}) {
  try { return (opts.vscode || require('vscode')).workspace.getConfiguration('vivadoProjectExplorer').get('vivadoPath') || ''; }
  catch (_) { return ''; }
}
function languageStandardSetting(opts = {}) {
  if (opts.languageStandard) return opts.languageStandard;
  try { return (opts.vscode || require('vscode')).workspace.getConfiguration('airtl.systemverilog').get('standard', '1800-2017'); }
  catch (_) { return '1800-2017'; }
}
function loadGraph(hdlFiles, opts = {}) {
  const nat = native(), input = graphInputs(hdlFiles, opts, require('./vivado').libDirs(vivadoSetting(opts)));
  const loaded = nat.graphLoad(input.paths, input.options);
  return wrapGraph(loaded, input.paths, opts, nat.graphTopCandidates(loaded.handle), null, input.options, input.compilation);
}
async function loadGraphAsync(hdlFiles, opts = {}) {
  const nat = native(), located = await nat.vivadoLocateAsync(vivadoSetting(opts));
  const input = graphInputs(hdlFiles, opts, { unisimDir: located.unisimDir, xpmDirs: located.xpmDirs });
  const loaded = opts.checkpoint ? await nat.graphLoadCheckpointAsync(input.paths,input.options,opts.checkpoint.directory,opts.checkpoint.identity)
    : await nat.graphLoadAsync(input.paths, input.options);
  try {
    const candidates = await nat.graphTopCandidatesAsync(loaded.handle);
    const index = await nat.graphIndexAsync(loaded.handle);
    return wrapGraph(loaded, input.paths, opts, candidates, index,input.options,input.compilation);
  } catch (error) { void nat.graphFreeAsync(loaded.handle).catch(() => {}); throw error; }
}
function wrapGraph(loaded, paths, opts, candidates, index,inputOptions,compilation) {
  const nat = native();
  const handle = loaded.handle;

  // topCandidates 直接在 C++ 内算（graphTopCandidates），不经 JS。
  // 【原先这里是一趟纯浪费的往返】graphIndex 把 183 个模块的全部例化表
  // 序列化成 118.8 KB 搬到 JS → 包成 Map/Set → 原样搬回 C++ 调
  // buildHierarchyFromDefs → 最后只用 10 个候选顶层（1469 字节）。
  // 实测那趟 4.24 ms，99% 的数据是白搬的。
  const topCandidates = candidates || [];

  // moduleDefs / instTypes 改成【懒加载】。闭包里只有树视图和 BD 面板的
  // 少数分支真需要完整模块表（webviewProvider 里 15 处 .has/.get），
  // 多数调用方只碰 topCandidates。不碰就一次 graphIndex 都不发，
  // 118.8 KB 的回传直接消失。
  let _idx = index || null;
  let moduleDefs = null, instTypes = null;
  let freed = false;
  function idx() {
    if (!_idx) _idx = nat.graphIndex(handle);
    return _idx;
  }

  return {
    handle,
    compilationContext: analysisContext.normalize({ ...compilation, ...(loaded.compilationContext || {}) }),
    analysisVersion: loaded.analysisVersion || '',
    modules: loaded.modules,
    checkpointStatus:loaded.checkpointStatus,
    inputDigests:loaded.inputDigests||{},
    inputDigestLimits:loaded.inputDigestLimits||{},
    saveCheckpoint() {
      if(freed||!opts.checkpoint)return Promise.resolve({saved:false,reason:'disabled'});
      return nat.withRequestBudget(()=>nat.graphSaveCheckpointAsync(handle,{...opts.checkpoint,paths,options:inputOptions,dependencies:loaded.dependencyFiles||[]}));
    },
    get disposed() { return freed; },
    paths,
    includeFiles: loaded.includeFiles || [],
    dependencyFiles: loaded.dependencyFiles || loaded.includeFiles || [],
    opts,
    get moduleDefs() { return moduleDefs || (moduleDefs = new Map(idx().moduleDefs)); },
    get instTypes() { return instTypes || (instTypes = new Set(idx().instTypes)); },
    get moduleCount() { return idx().moduleDefs.length; },
    topCandidates,
    free() {
      if (freed) return;
      clearScenes(this);
      freed = true;
      return nat.graphFreeAsync(handle).catch(() => {});
    }
  };
}
const hierarchyCaches = new WeakMap();
function hierarchyFor(graph, top) {
  if (!graph || graph.disposed) return Promise.reject(new Error('Hierarchy graph has been released'));
  let entries = hierarchyCaches.get(graph);
  if (!entries) { entries = new Map(); hierarchyCaches.set(graph, entries); }
  if (!entries.has(top)) {
    const pending = native().graphHierarchyAsync(graph.handle, top).then(hierarchy => {
      const bind = (node, instances) => {
        if (!node) return;
        node.scopeContext = { nodeId: node.nodeId, rootModule: top, rootParams: {}, instances, handle: graph.handle,
          ...(hierarchy.analysisVersion ? { analysisVersion: hierarchy.analysisVersion } : {}),
          originInst: node.instanceFile ? { file: node.instanceFile, line: node.instanceLine } : null };
        for (const child of node.children || []) bind(child, [...instances, child.instance]);
      };
      bind(hierarchy.root, []);
      return hierarchy;
    }).catch(error => { entries.delete(top); throw error; });
    entries.set(top, pending);
  }
  return entries.get(top);
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
  const nativeOptions = Object.assign({ busView }, ppObj ? { parentParams: ppObj } : {});
  // Direct scope consumers (for example export-to-simulation) need the same
  // exact elaborated instance context as renderScene, or generate branches
  // and parameterized connections would fall back to the module-wide scan.
  if (opts.instanceContext) nativeOptions.instanceContext = opts.instanceContext;
  return native().renderScope(graph.handle, moduleName, nativeOptions);
}

// 定向失效：只重析被改的那个文件（对应 JS 侧 bg.invalidateFile）
function invalidateFile(graph, file) {
  clearScenes(graph);
  if (graph && graph.handle !== undefined) native().graphInvalidate(graph.handle, [file]);
}

// 工程关闭/切换时调，释放原生 handle
function freeGraph(graph) {
  if (graph && typeof graph.free === 'function') graph.free();
}

async function renderScene(graph, moduleName, options = {}, request) {
  if (!graph || graph.disposed) throw new Error('Scene graph has been released');
  if (!currentRequest(graph, request)) return null;
  const nat = native(), runtime = nat.__runtimeInfo();
  if (!runtime.alive || runtime.failed) { clearScenes(graph); throw new Error('Airtl parser unavailable; reload the project'); }
  const epoch = graph.sceneEpoch || 0;
  const cache = scenes(graph), key = cache.key(moduleName, { ...options, session: runtime.session, epoch });
  const cached = cache.get(key);
  if (cached) {
    const context = options.instanceContext;
    if (context?.analysisVersion) {
      const current = await nat.graphFactVersionAsync(graph.handle, {rootModule:context.rootModule, rootParams:context.rootParams || {}});
      if (!currentRequest(graph, request) || graph.disposed || (graph.sceneEpoch || 0) !== epoch || nat.__runtimeInfo().session !== runtime.session) return null;
      if (current.version !== context.analysisVersion) {
        const error = new Error('Scene context is stale; refresh the project tree and retry');
        error.code = 'AIRTL_STALE_CONTEXT'; throw error;
      }
    }
    return cached;
  }
  let scene;
  try { scene = await nat.renderSceneQueuedAsync(request ? request.queueKey : requests(graph).queueKey, graph.handle, moduleName, options); }
  catch (error) { if (error.code === 'AIRTL_REQUEST_SUPERSEDED') return null; throw error; }
  if (!scene) return null;
  if (!currentRequest(graph, request) || (graph.sceneEpoch || 0) !== epoch || nat.__runtimeInfo().session !== runtime.session) return null;
  return Object.assign(cache.set(key, scene, runtime, graph.handle), { graphEpoch: epoch });
}
async function refineScene(graph, record, widths) {
  const nat = native(), runtime = nat.__runtimeInfo(), epoch = graph.sceneEpoch || 0;
  if (runtime.session !== record.session || !runtime.alive) throw new Error('Scene runtime expired');
  let patch;
  try { patch = await nat.refineSceneQueuedAsync(requests(graph).queueKey, graph.handle, record.nativeId, widths, true); }
  catch (error) { if (error.code === 'AIRTL_REQUEST_SUPERSEDED') return null; throw error; }
  if (graph.disposed || (graph.sceneEpoch || 0) !== epoch || nat.__runtimeInfo().session !== runtime.session) return null;
  const qualifiedPatch = { ...patch, baseSceneId: record.scene.sceneId, sceneId: runtime.session + '/' + graph.handle + '/' + patch.sceneId };
  const scene = { ...applyTextPatch({ ...record.scene, sceneId: record.nativeId }, patch), navigation: record.navigation };
  return Object.assign(scenes(graph).set(record.key, scene, runtime, graph.handle), { graphEpoch: epoch, patch: qualifiedPatch });
}
function sceneStats(graph) { const c = sceneCaches.get(graph); return c ? { hits:c.hits, misses:c.misses, bytes:c.bytes, entries:c.entries.size } : { hits:0,misses:0,bytes:0,entries:0 }; }

module.exports = {
  describe, loadGraph, loadGraphAsync, hierarchyFor, renderScope, renderScene, refineScene, beginSceneRequest, cancelSceneRequests, clearScenes, sceneStats, invalidateFile, freeGraph,
  // 只走原生路径的调用方用（原生缺失会明确抛错）
  native,
  // 诊断用：原生库到底加载上没有、失败原因
  nativeAvailable: () => !!airtl,
  nativeError: () => (airtlErr ? String(airtlErr.message || airtlErr) : null)
};
