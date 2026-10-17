// Author: Airtl yu

// Contact: yuairtl@outlook.com
// Airtl — JS 侧入口
//
// 【只有一条路：原生插件】曾经这里有第二段——原生加载失败时退回 reference/ 下的
// 纯 JS 实现。已删。理由：那个回退分支根本够不着。
//   · graphProvider.js 拿到 !isNative() 就置空 airtl，之后 native() 直接抛
//   · Airtl/test/ 下 30 个差分文件全是 if (!airtl.isNative()) process.exit(1)
// 也就是说"原生不在"时没有任何调用方会继续走到 pick() 的 ref 分支，
// 它只是让 reference/ 那 324 KB 陈旧 JS 拷贝看起来还在服役。
// 原生库缺失就该明确失败——产品不需要托底。
'use strict';

const path = require('path');
const fs = require('fs');

let native = null;
let nativeErr = null;
const CANDIDATES = [
  path.join(__dirname, 'build', 'Release', 'airtl.node'),
  path.join(__dirname, 'build', 'Debug', 'airtl.node'),
  path.join(__dirname, 'prebuilds', process.platform + '-' + process.arch, 'airtl.node'),
];
for (const p of CANDIDATES) {
  if (!fs.existsSync(p)) continue;
  try {
    native = require(p);
    break;
  } catch (e) {
    nativeErr = e;   // 记下最后一个错误，别静默
  }
}

// 原生不在就当场说清楚，别等到调具体函数时才炸
function pick(fn) {
  if (native && typeof native[fn] === 'function') return native[fn].bind(native);
  throw new Error('airtl: ' + fn + ' 没有原生实现'
    + (nativeErr ? '（原生库加载失败: ' + String(nativeErr.message || nativeErr) + '）'
                 : '（原生库没找到，请先 Airtl: npm run build）'));
}

// 测试旁路不在这里做——C++ 在 addon 加载时（Init 里）检测 AIRTL_TEST_MODE 就地装好。
// 【为什么不放 JS】38 个差分套件直接 require airtl.node，不经本文件，JS 侧安装对
// 它们无效。放 C++ 的 Init 里，两条 require 路径都覆盖，且本文件不用改。
// 【不削弱产品】那个环境变量用户不设 → 门禁照常拦，_licenseTestInstall 绑定都不导出。

module.exports = {
  // Unified project service: disk discovery, XPR/Tcl/source loading and BD data.
  projectLoad: pick('projectLoad'),
  vivadoLocate: pick('vivadoLocate'),
  vivadoVersions: pick('vivadoVersions'),
  vivadoExecutable: pick('vivadoExecutable'),
  vivadoBases: native ? native.vivadoBases : [],
  projectDiscover: pick('projectDiscover'),
  projectWalk: pick('projectWalk'),
  projectSelect: pick('projectSelect'),
  projectCached: pick('projectCached'),
  projectCachedPath: pick('projectCachedPath'),
  projectUpdateCache: pick('projectUpdateCache'),
  projectSkipDirs: native ? native.projectSkipDirs : [],
  isSimHdlFile: pick('isSimHdlFile'),
  inferSimTop: pick('inferSimTop'),
  loadBdModuleDefs: pick('loadBdModuleDefs'),
  hasTopDirective: pick('hasTopDirective'),
  resolveTopDirective: pick('resolveTopDirective'),
  resolveTclFilePaths: pick('resolveTclFilePaths'),
  pathSlash: pick('pathSlash'),
  safeFileId: pick('safeFileId'),
  deriveTbBase: pick('deriveTbBase'),
  tbOutputPaths: pick('tbOutputPaths'),
  modelCandidates: pick('modelCandidates'),
  parseJsonText: pick('parseJsonText'),
  isZipBuffer: pick('isZipBuffer'),
  projectGeneratedFiles: pick('projectGeneratedFiles'),
  // 诊断用：让人一眼看出当前跑的是原生还是 JS 回退
  isNative: () => !!native,
  nativeError: () => (nativeErr ? String(nativeErr.message || nativeErr) : null),
  version: () => (native ? native.version() : 'airtl (原生库未加载)'),

  // 开发期自检：JVal 往返（不随发布交付，见 util/json_probe.h）
  _jvalEcho: (v) => {
    if (!native || typeof native._jvalEcho !== 'function') throw new Error('airtl: _jvalEcho 只有原生实现');
    return native._jvalEcho(v);
  },

  // Phase 1：工程图长驻 C++（handle 式 API，见 ARCHITECTURE.md）
  // 这四个是原生独有——JS 回退没有对应物，拿不到就明说，不静默给个假的
  // 【第二参必须转发】原写法是 (v) => native.graphLoad(v)，只转第一个参数——
  // 于是 graphLoad(paths, { vivadoUnisimDir, vivadoXpmDirs }) 里的 options 被静默
  // 丢掉，C++ 永远走自己的探测。现象：设了 vivadoProjectExplorer.vivadoPath 只对
  // "打开 .wdb"生效，unisim/xpm 原语端口补全不听设置——而调用方看不出任何异常。
  // 【为什么要这个 options】C++ 读不到 VSCode 设置，"Vivado 装在哪"的唯一解析点
  // 在 JS 侧（ui_design/vivado.js）。不传，装在 C/D/E 之外的用户设置了一半。
  graphLoad: (v, opts) => { if (!native || typeof native.graphLoad !== 'function') throw new Error('airtl: graphLoad 只有原生实现'); return native.graphLoad(v, opts === undefined ? {} : opts); },
  graphFree: (v) => { if (!native || typeof native.graphFree !== 'function') throw new Error('airtl: graphFree 只有原生实现'); return native.graphFree(v); },
  graphInvalidate: (v, w) => { if (!native || typeof native.graphInvalidate !== 'function') throw new Error('airtl: graphInvalidate 只有原生实现'); return native.graphInvalidate(v, w); },
  graphStats: (v) => { if (!native || typeof native.graphStats !== 'function') throw new Error('airtl: graphStats 只有原生实现'); return native.graphStats(v); },
  graphDump: (v) => { if (!native || typeof native.graphDump !== 'function') throw new Error('airtl: graphDump 只有原生实现'); return native.graphDump(v); },
  graphIndex: (v) => { if (!native || typeof native.graphIndex !== 'function') throw new Error('airtl: graphIndex 只有原生实现'); return native.graphIndex(v); },
  // topCandidates 在 C++ 内算，不经 JS——省掉 graphIndex(C++→JS 118.8KB)
  // + 包 Map/Set + 原样搬回 C++ 这一趟往返（实测 4.24 ms，99% 数据白搬）。
  // —— 授权鉴权（见 ARCHITECTURE.md「身份验证」一节）——
  // 这五个是生产用的。_licenseMac / _licenseJudge 等测试绑定【故意不导出】——
  // 它们能造合法 license，导出等于把发行工具送出去。
  licenseSetLicense: (blob) => { if (!native || typeof native.licenseSetLicense !== 'function') throw new Error('airtl: licenseSetLicense 只有原生实现'); return native.licenseSetLicense(blob); },
  // 当前版本的统一授权（到期 2027-01-01）。只在没有 license.key 时调——
  // 有正式 key 时它优先，见 ui_design/license.js。
  licenseUseDefault: () => { if (!native || typeof native.licenseUseDefault !== 'function') throw new Error('airtl: licenseUseDefault 只有原生实现'); return native.licenseUseDefault(); },
  licenseMachineId: () => { if (!native || typeof native.licenseMachineId !== 'function') throw new Error('airtl: licenseMachineId 只有原生实现'); return native.licenseMachineId(); },
  licenseAuthNow: () => { if (!native || typeof native.licenseAuthNow !== 'function') throw new Error('airtl: licenseAuthNow 只有原生实现'); return native.licenseAuthNow(); },
  // 诊断：逐层真实原因。给输出通道用，别直接弹给用户——门禁文案是统一的，
  // 详细理由暴露给 UI 等于给攻击者一个探测 oracle。
  licenseState: () => { if (!native || typeof native.licenseState !== 'function') throw new Error('airtl: licenseState 只有原生实现'); return native.licenseState(); },

  graphTopCandidates: (v) => { if (!native || typeof native.graphTopCandidates !== 'function') throw new Error('airtl: graphTopCandidates 只有原生实现'); return native.graphTopCandidates(v); },
  // 只要 L2 层次树（树视图用）——不走 renderScope，省掉 L3/L4
  graphHierarchy: (v, w) => { if (!native || typeof native.graphHierarchy !== 'function') throw new Error('airtl: graphHierarchy 只有原生实现'); return native.graphHierarchy(v, w); },
  // Phase 2：L2(buildModuleScope)→L3(prepareScopeForUI)→L4(layoutScope) 一次调用
  renderScope: (v, w, x) => { if (!native || typeof native.renderScope !== 'function') throw new Error('airtl: renderScope 只有原生实现'); return native.renderScope(v, w, x); },
  renderScene: (v, w, x) => { if (!native || typeof native.renderScene !== 'function') throw new Error('airtl: renderScene requires native runtime'); return native.renderScene(v, w, x); },
  refineScene: (...args) => { if (!native || typeof native.refineScene !== 'function') throw new Error('airtl: refineScene requires native runtime'); return native.refineScene(...args); },

  // ② 预处理 / HDL 解析
  stripComments: pick('stripComments'),
  stripNamedBlocks: pick('stripNamedBlocks'),
  maskParamBlocks: pick('maskParamBlocks'),
  extractModules: pick('extractModules'),
  extractInstances: pick('extractInstances'),
  filePriority: pick('filePriority'),
  isGateLevelNetlist: pick('isGateLevelNetlist'),
  looksLikePrimitive: pick('looksLikePrimitive'),
  parseVerilogPorts: pick('parseVerilogPorts'),
  parseVhdlPorts: pick('parseVhdlPorts'),
  extractInstancesFull: pick('extractInstancesFull'),
  parseFileBody: pick('parseFileBody'),
  buildHierarchyFromDefs: pick('buildHierarchyFromDefs'),
  pickTopLevelFromCands: pick('pickTopLevelFromCands'),
  // ⑤ AI 联动纯计算核心（会话挑选/排序、模型探测判定、模板替换）
  normDir: pick('normDir'),
  fillTemplate: pick('fillTemplate'),
  pickResumable: pick('pickResumable'),
  rankByActivity: pick('rankByActivity'),
  betterList: pick('betterList'),
  modelResponseOk: pick('modelResponseOk'),
  isSimHdlPath: pick('isSimHdlPath'),
  pickSimTop: pick('pickSimTop'),
  // ④ tcl 脚本解析（Vivado 工程来源 = tcl 模式）
  stripTclComments: pick('stripTclComments'),
  collectVars: pick('collectVars'),
  expandVars: pick('expandVars'),
  stripTclQuotes: pick('stripTclQuotes'),
  normalizeTopName: pick('normalizeTopName'),
  extractTopDirectives: pick('extractTopDirectives'),
  extractTopDirective: pick('extractTopDirective'),
  extractFilePaths: pick('extractFilePaths'),
  // ⑥ .xpr XML 解析（工程来源 = xpr 模式）
  extractTopModule: pick('extractTopModule'),
  extractPart: pick('extractPart'),
  extractFileSetTopModule: pick('extractFileSetTopModule'),
  parseFileSets: pick('parseFileSets'),
  extractSimFiles: pick('extractSimFiles'),
  extractRegBuffers: pick('extractRegBuffers'),
  foldBusView: pick('foldBusView'),
  prepareScopeForUI: pick('prepareScopeForUI'),
  genStubTb: pick('genStubTb'),
  collectSelectedSubgraph: pick('collectSelectedSubgraph'),
  extractModules: pick('extractModules'),

  // ③ 总线判定 / BlockGraph
  matchBusPortName: pick('matchBusPortName'),
  roleByPrefix: pick('roleByPrefix'),
  inferBusRole: pick('inferBusRole'),
  inferBusInterfaces: pick('inferBusInterfaces'),
  applyBusDirections: pick('applyBusDirections'),
  BUS_DEFS: () => (native && native.BUS_DEFS ? native.BUS_DEFS : []),
  buildBlockGraph: pick('buildBlockGraph'),
  classifyExpr: pick('classifyExpr'),
  splitTopCommas: pick('splitTopCommas'),
  inferDirByName: pick('inferDirByName'),
  assignUnionFind: pick('assignUnionFind'),
  normalizeConditionalDirectives: pick('normalizeConditionalDirectives'),
  skipWs: pick('skipWs'),
  matchBalanced: pick('matchBalanced'),
  widthOfRange: pick('widthOfRange'),
  stripDefaultAssign: pick('stripDefaultAssign'),
  splitTopComma: pick('splitTopComma'),
  classifyRhs: pick('classifyRhs'),
  safeTbId: pick('safeTbId'),
  blockIdOf: pick('blockIdOf'),
  genericBusOf: pick('genericBusOf'),
  busDirByValid: pick('busDirByValid'),
  busPortDir: pick('busPortDir'),
  extractParamValues: pick('extractParamValues'),
  parseOverrideList: pick('parseOverrideList'),
  findMatchingBeginEnd: pick('findMatchingBeginEnd'),
  resolveExpr: pick('resolveExpr'),
  evalIntExpr: pick('evalIntExpr'),
  substParamsInRange: pick('substParamsInRange'),
  resolveIntLike: pick('resolveIntLike'),
  widthOfSubstRange: pick('widthOfSubstRange'),
  findModuleHeader: pick('findModuleHeader'),
  findGenerateFors: pick('findGenerateFors'),
  mergeBitselNets: pick('mergeBitselNets'),
  matchBusPort: pick('matchBusPort'),
  maskStrings: pick('maskStrings'),
  extractAlwaysBodies: pick('extractAlwaysBodies'),
  constPackBits: pick('constPackBits'),
  busLabel: pick('busLabel'),
  unrollForLoops: pick('unrollForLoops'),
  cloneSub: pick('cloneSub'),
  resolveChildParams: pick('resolveChildParams'),
  unrollConnsAroundFors: pick('unrollConnsAroundFors'),
  extractRegDecls: pick('extractRegDecls'),
  resolveModulePortWidths: pick('resolveModulePortWidths'),
  constTextOf: pick('constTextOf'),
  vhdlInstancesFull: pick('vhdlInstancesFull'),
  groupBusPorts: pick('groupBusPorts'),
  extractAssigns: pick('extractAssigns'),

  // ④ 布局
  layoutBlocks: pick('layoutBlocks'),
  layoutScope: pick('layoutScope'),

  // ③ 回写
  locatePortExpr: pick('locatePortExpr'),
  planRewire: pick('planRewire'),
  applyEdits: pick('applyEdits'),

  // 图标规则
  isGeneratedHdlPath: pick('isGeneratedHdlPath'),
  moduleIconId: pick('moduleIconId'),
  moduleKindTag: pick('moduleKindTag'),

  // ③ IP 端口数据（纯函数部分）
  normalizeIpName: pick('normalizeIpName'),
  looseIpKey: pick('looseIpKey'),
  ipFamilyKey: pick('ipFamilyKey'),
  ipKeyCandidates: pick('ipKeyCandidates'),
  lookupPortDir: pick('lookupPortDir'),
  lookupPortWidth: pick('lookupPortWidth'),
  // 表同步：JS 侧 loadExternalPortData 重建 IP_PORT_DATA 后调这个
  setIpPortData: pick('setIpPortData'),

  // 暴露原生对象本身，供差分测试直接调用（避免回退掩盖真实差异）
  _native: native,
};
