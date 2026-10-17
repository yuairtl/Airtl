// Author: Airtl yu
// Contact: yuairtl@outlook.com

'use strict';
// webviewProvider.js — Block Design 面板（单模块作用域视图）
// 视图模型：一次只渲染一个源文件内部的例化连线图；
//   双击可展开的块 → openScope 进入该模块；面包屑返回。回写 rewire 作用于当前作用域。
// 协议（带 epoch + error）：
//   ext → webview: {type:'render', epoch, module, scope}
//                | {type:'error', message}
//   webview → ext: {type:'ready'} | {type:'openScope', module}
//                | {type:'openSource', file, line} | {type:'selectionChanged', ids}
//                | {type:'export'} | {type:'rewire', blockKey, port, newSignal}
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { t, isChinese, webviewTranslations } = require('../l10n');
const ps = require('../projectSource');
// 算法全在 C++（Airtl），rtltree.js 只做转发 + 文件 I/O。
// rtlparser.js（473 行，含算法实现）不随包发布，只留在开发树当差分测试的 JS 参照。
// 算法全在 C++（Airtl）。原先经 rtltree.js 转发，现在直接调——rtltree.js 已无消费者。
// rtlparser.js（473 行，含算法实现）不随包发布，只留在开发树当差分测试的 JS 参照。
const airtl = require(path.join(__dirname, '..', 'Airtl', 'index.js'));
const { pickTopLevelFromCands, stripComments, extractModules, looksLikePrimitive } = airtl;
const { moduleIconId, moduleKindTag } = require('../iconRules');
// 建图/渲染走 C++ 原生库（Airtl）。没有第二条路——JS 实现已被完全替代，
// 不再随包发布，只留在开发树里当差分测试的比对基准。
//
// 【本文件不 require blockgraph】blockgraph.js（202 KB）+ layout.js（67 KB）
// 整块是 C++ 已替代的 JS 实现，发布包里不再随包。exportToSim 用的
// collectSelectedSubgraph / genStubTb 走 gp.native()（原生绑定在
// Airtl/src/graph/sel_sub_graph_bind.cpp、gen_stub_tb_bind.cpp，签名一致，
// 都有差分测试）。
const gp = require('./graphProvider');
const rw = require('./rtlwriter');

let panel = null;
let epoch = 0;
let lastRender = null;
let selectedKeys = new Set();
// 总线视图开关：true = 把 AXI/SV interface/SV struct 成员折成粗 pin + 粗线（默认开）。
// 前端「总线/信号」切换按钮改这个值并重新下发 render（不重新解析工程）。
let busViewEnabled = true;
let hdlFiles = [];
let G = null;               // loadProjectGraph 结果（moduleDefs/portsMap/connsMap/paramMap）
let scopeModule = '';
let scopeParentParams = null;
let _ctx = null;
const outCh = vscode.window.createOutputChannel('Block Design');

function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// 共享状态（BD 面板与 BD 设计树共用）
// xprMissing：加载失败（工作区无 .xpr）的负标记。无此标记时，startAutoLoadTree 的守卫
// 「bdState.G && bdState.proj」在加载失败后仍为假 → 每次树刷新都重试 loadGraph → 反复弹
// 警告 + refresh → 死循环（BUG1）。加载成功时清除，手动刷新时也清除以便用户设置工程后重试。
const bdState = { proj: null, G: null, hdlFiles: [], topResolved: '', autoLoading: false, xprMissing: false };

// BD 设计源（.bd JSON）的聚合指纹：任一 .bd 的 mtime/size 变化都算「BD 已改」。
// 【为何需要】改 Block Design 后 .xpr 往往不变，此前 loadGraph 只看来源文件的 mtime
// → 一直复用旧 G，用户看到的是修改前的 BD 结构与连线。
function bdFilesStamp(bdFiles) {
  let maxM = 0, sumSize = 0, n = 0;
  for (const bf of (bdFiles || [])) {
    try {
      const s = fs.statSync(bf.path);
      if (s.mtimeMs > maxM) maxM = s.mtimeMs;
      sumSize += s.size; n++;
    } catch (e) { /* 读不到忽略（被删/无权限） */ }
  }
  return n + ':' + Math.round(maxM) + ':' + sumSize;
}

// 加载工程图（树与面板共用；G 已加载且「来源文件 + BD 文件」均未变则复用）
// opts.silent=true 时失败不弹窗（后台自动加载用；Vivado Hierarchy 树已提示过无 xpr，避免重复打扰）
async function loadGraph(opts) {
  const silent = !!(opts && opts.silent);
  // 工程来源（xpr / tcl / 源文件）统一由 projectSource 解析（与 Vivado Hierarchy 树同源同缓存）
  const roots = (vscode.workspace.workspaceFolders || []).map(w => w.uri.fsPath);
  if (!roots.length) {
    bdState.xprMissing = true;
    if (!silent) vscode.window.showWarningMessage(t('未打开工作区文件夹，无法加载 BD 工程', 'No workspace folder is open. Cannot load the Block Design project.'));
    return false;
  }
  // 来源由 Vivado Hierarchy 视图的「选择工程来源」在界面上选定并写入工作区缓存；
  // BD 图与层次树同源（不重扫、不读 settings）。
  const src = ps.resolveCachedAny(roots);
  if (!src) {
    bdState.xprMissing = true;      // 负标记：后续 startAutoLoadTree 不再反复尝试
    if (!silent) vscode.window.showWarningMessage(t('尚未选择工程来源：请先在「源码树」视图点「选择工程来源」（扫描 .xpr / tcl / 源文件后选定）', 'No project source selected. Choose one from Project Sources (scan for an XPR, Tcl script, or HDL source).'));
    return false;
  }
  const srcKey = src.mode + ':' + src.path;
  let srcMtime = 0;
  try { srcMtime = fs.statSync(src.path).mtimeMs; } catch (e) { }
  // BD 文件实时指纹：与上次加载时记录的值比较（任一 .bd 改动 → 缓存失效重载）
  const bdStampNow = bdFilesStamp(bdState.proj && bdState.proj.bdFiles);
  if (bdState.G && bdState.proj && bdState.proj.srcKey === srcKey && bdState.proj.srcMtime === srcMtime
      && bdState.proj.bdStamp === bdStampNow) {
    bdState.xprMissing = false;
    return true;
  }
  const proj = ps.loadProject(src, roots);
  proj.srcKey = srcKey; proj.srcMtime = srcMtime; proj.mode = src.mode; proj.xpr = src.path;
  proj.bdStamp = bdFilesStamp(proj.bdFiles);
  hdlFiles = proj.srcFiles.concat(proj.ipFiles, proj.simFiles);
  // 一律以 Vivado【生成后的 HDL】建网表（用户裁定 2026-09-17：不强调 GUI 同步，强调 generate 后同步）：loadProjectGraph 会把 .bd 的生成 HDL(<bd>.v) 主动并入 HDL 分析集。
  // 旧图先释放：native 后端下 G 持有 GraphStore handle，不释放就每加载一次漏一个
  const previousGraph = G;
  G = gp.loadGraph(hdlFiles, { bdFiles: proj.bdFiles || [], workspaceDir: roots[0] || null });
  if (previousGraph) gp.freeGraph(previousGraph);
  bdState.proj = proj; bdState.G = G; bdState.hdlFiles = hdlFiles;
  let top = proj.designTop || proj.top;
  if (!top || !G.moduleDefs.has(top)) {
    const picked = pickTopLevelFromCands(G.topCandidates || []);
    top = picked ? picked.name : top;
  }
  bdState.topResolved = top || '';
  bdState.xprMissing = false;
  return !!top;
}

// BD 树后台自动加载：打开即触发（async，不阻塞，进度条正常完成，完成后自动 refresh 树）
function startAutoLoadTree() {
  if (bdState.G && bdState.proj) return;       // 已有数据
  if (bdState.xprMissing) return;              // 已判定无 .xpr：不再反复尝试加载（BUG1 死循环根因）
  if (bdState.autoLoading) return;             // 已在加载
  bdState.autoLoading = true;
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('加载 BD 工程…', 'Loading Block Design…') },
    async () => {
      await new Promise(r => setImmediate(r));   // 让事件循环先返回，避免同步解析阻塞进度条
      try { await loadGraph({ silent: true }); } catch (e) { outCh.appendLine('[bd][auto-load] ' + e.message); }
      bdState.autoLoading = false;
      try { bdTreeProvider && bdTreeProvider.refresh(); } catch (e) { }
    }
  );
}
// 【原来这里有个后端状态栏项 + switchBackend 命令】已删。
// 它们存在的唯一前提是"有两条路可切"——而 JS 那条路已被 C++ 完全替代、
// 不再随包发布，产品里只剩一条路。给一条路配个切换器，只会让人以为
// 还有备选，出问题时先去切切换器而不是去查原生库为什么没加载。
// 引擎信息保留在 activate 的那行日志里（[engine] …），足够定位问题。
function activate(context) {
  if(vscode.workspace.onDidChangeTextDocument)context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e=>sourceChanged(e.document,false)));
  if(vscode.workspace.onDidSaveTextDocument)context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(d=>sourceChanged(d,true)));

  _ctx = context;
  context.subscriptions.push({ dispose() {
    if (G) gp.freeGraph(G);
    G = null;
    bdState.G = null;
  } });
  // 引擎一行日志：原生库在不在、什么版本。加载失败时这里是第一现场。
  outCh.appendLine('[engine] ' + gp.describe()
    + (gp.nativeAvailable() ? '' : '  原生库加载失败: ' + gp.nativeError()));
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.openBlockDesign', openBlockDesign),
    vscode.commands.registerCommand('vivadoProjectExplorer.exportSelectedFiles', () => exportSelection()),
    vscode.commands.registerCommand('vivadoBD.openScope', (arg) => {
      if (typeof arg === 'string') return openScopeFor(arg);
      const n = arg || {};
      const oi = (n.cell && n.cell.instanceFile)
        ? { file: n.cell.instanceFile, line: n.cell.instanceLine || 0 }
        : (n.instanceFile ? { file: n.instanceFile, line: n.instanceLine || 0 } : null);
      return openScopeFor(n.moduleName || n.module, oi);     // 带上「该模块在父级被例化的位置」
    }),
    vscode.commands.registerCommand('vivadoBD.focusInstance', (arg) => focusInstance(typeof arg === 'string' ? { moduleName: arg } : arg)),
    vscode.commands.registerCommand('vivadoBD.locateInstanceBg', (arg) => locateInstanceBg(arg)),
    vscode.commands.registerCommand('vivadoBD.openScopeBg', (arg) => {
      if (typeof arg === 'string') return openScopeBg(arg);
      const n = arg || {};
      const oi = (n.cell && n.cell.instanceFile)
        ? { file: n.cell.instanceFile, line: n.cell.instanceLine || 0 }
        : (n.instanceFile ? { file: n.instanceFile, line: n.instanceLine || 0 } : null);
      return openScopeBg(n.moduleName || n.module, oi);
    }),
    vscode.commands.registerCommand('vivadoBD.refresh', async () => {
      // 刷新 BD 树（含数据重载）。【利用缓存】：不 clearGraphCache 全量丢缓存——
      // loadProjectGraph 内部有文件级缓存（mtime+size 失效），源码没变时秒级复用、
      // 源码变了只重解析变化的文件；bdState.G=null 强制下次 loadGraph 重新组装树数据。
      // xprMissing 一并清除：用户可能刚在 Vivado Hierarchy 里设置了工程，允许重新尝试加载。
      bdState.G = null; bdState.proj = null; bdState.xprMissing = false;
      if (G || panel) {
        if (await loadGraph({ silent: true })) {
          if (panel) {
            const restoreContext = scopeContext && G.moduleDefs.has(scopeContext.rootModule);
            const current = restoreContext || G.moduleDefs.has(scopeModule) ? scopeModule : bdState.topResolved;
            await openScope(current, current === scopeModule ? scopeParentParams : null, null,
              current === scopeModule && lastRender ? lastRender.originInst : null, null, restoreContext ? scopeContext : undefined);
          }
        } else {
          if (G) gp.freeGraph(G);
          G = null; bdState.G = null; lastRender = null;
          if (panel) panel.webview.postMessage({ type: 'error', message: t('无法加载当前工程来源', 'Could not load the selected project source') });
        }
      }
      bdTreeProvider && bdTreeProvider.refresh();
    })
  );
  // BD 设计树（独立于 Vivado Hierarchy，共用同一份解析数据）
  bdTreeProvider = new BDBTreeProvider(bdState);
  bdTreeView = vscode.window.createTreeView('vivadoBDTree', { treeDataProvider: bdTreeProvider });
  context.subscriptions.push(bdTreeView);

  // ── 工作流任务视图（BD 设计树下方）：仿真/综合/实现/bit，调 AI 执行 ──
  const ai = require('../aiAdapter');
  const { WorkflowProvider } = require('./workflowProvider');
  workflowProvider = new WorkflowProvider(
    () => {   // 取工程根目录（优先工作区根）
      const w = vscode.workspace.workspaceFolders;
      if (w && w.length) return w[0].uri.fsPath;
      return null;
    },
    ai
  );
  workflowView = vscode.window.createTreeView('vivadoWorkflow', { treeDataProvider: workflowProvider });
  context.subscriptions.push(workflowView);
  for (const f of require('./workflowProvider').FLOWS) {
    context.subscriptions.push(
      vscode.commands.registerCommand('vivadoWorkflow.' + f.id, () => workflowProvider.run(f.id))
    );
  }
  // 打开波形（预留：仿真完成后找波形文件）
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoWorkflow.openWaveform', () => {
      const wp = workflowProvider.getWavePath();
      if (wp && fs.existsSync(wp)) {
        // .wdb → 用 Vivado xsim 打开（Vivado 波形格式）；.vcd → 用 VSCode 打开
        if (/\.wdb$/i.test(wp)) {
          const vivado = findVivadoBin();
          if (vivado) {
            const { execFile } = require('child_process');
            execFile(vivado, ['-mode', 'gui', '-source', '-'], { cwd: path.dirname(wp) }, (e) => {});
            vscode.window.showInformationMessage(t('正在用 Vivado 打开波形: ', 'Opening waveform in Vivado: ') + path.basename(wp));
          } else {
            vscode.window.showInformationMessage(t('未找到 Vivado，无法打开 .wdb（请手动用 Vivado 打开）', 'Vivado was not found. Open this .wdb file in Vivado manually.'));
          }
        } else {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(wp));
        }
      } else {
        vscode.window.showInformationMessage(t('暂无波形文件（先执行仿真）', 'No waveform file found. Run a simulation first.'));
      }
    })
  );

  // 右键 Hierarchy 树模块 → AI 读源码讲解功能 + 工程作用。
  // 统一规则：workflowProvider.explainModule 内部读 module-explain 技能（全局 skills 优先、fallback ref_skill）注入 AI。
  // node 是 Hierarchy 树的 ModuleNode：moduleName=节点模块名，cell.file=源码定义文件路径。
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.explainModule', (node) => {
      if (!node) return;
      const cell = node.cell || node;
      const moduleName = node.moduleName || cell.module || node.module;
      const srcFile = (node.cell && node.cell.file) || cell.file;
      if (!moduleName) { vscode.window.showErrorMessage(t('无法获取模块名', 'Could not determine module name')); return; }
      Promise.resolve(workflowProvider.explainModule(moduleName, srcFile)).catch(e => {
        outCh.appendLine('[explainModule] 异常: ' + (e && e.stack || e));
        vscode.window.showErrorMessage(t('讲解模块异常: ', 'Module explanation error: ') + (e && e.message || e));
      });
    })
  );

  // 撤销“双击行”附带的原生折叠/展开（双击只打开模块 UI，不折叠/展开；行为对齐 Vivado Hierarchy 树）。
  // 第一击（含单click定位）即抢先置位 bdSuppressToggle，覆盖第二击原生的折叠/展开事件。
  bdTreeView.onDidExpandElement(e => {
    const k = e.element && e.element.ctxKey ? e.element.ctxKey : null;
    if (bdSuppressToggle && bdSuppressToggle === k) { bdSuppressToggle = null; bdRevertToggle(); }
  }, null, context.subscriptions);
  bdTreeView.onDidCollapseElement(e => {
    const k = e.element && e.element.ctxKey ? e.element.ctxKey : null;
    if (bdSuppressToggle && bdSuppressToggle === k) { bdSuppressToggle = null; bdRevertToggle(); }
  }, null, context.subscriptions);
}

let workflowProvider = null;
let workflowView = null;

// 探测 Vivado 安装（常见路径，供打开 .wdb 波形用）
// 【已收敛到 ui_design/vivado.js】这里原来自己写了一份 bases + 版本排序，
// 与 globalConfig.probeVivado / blockgraph._vivadoLibDirs / Airtl 的 VivadoLibDirs
// 是同一逻辑四份。现在只留一处。
// 【取值顺序】vivadoProjectExplorer.vivadoPath 设置项 > config.json > 探测。
// 用户把 Vivado 装在 C/D/E 之外、或版本目录名不匹配 /^\d{4}\.\d$/ 时，
// 靠设置项就能自救——原来没有任何手段（探测失败只能"请手动用 Vivado 打开"）。
function findVivadoBin() {
  const gc = require('./globalConfig');
  const v = require('./vivado');
  const fsx = require('fs');
  let setting = '';
  try {
    const c = vscode.workspace.getConfiguration('vivadoProjectExplorer');
    setting = (c && c.get('vivadoPath')) || '';
  } catch (e) { /* 测试/无 vscode 环境下退到 config.json + 探测 */ }
  // ① 设置项显式指定 → 直接用，不再探测。允许指到 vivado.bat 本身或版本/base 根
  if (setting && String(setting).trim()) {
    const s = String(setting).trim();
    if (/vivado\.bat$/i.test(s)) return fsx.existsSync(s) ? s : null;
    const e = v.probe(s);
    if (e) return e;
    // 设置了但指的地方不对 → 不要静默退回探测，那会让用户以为设置生效了
    return null;
  }
  // ② config.json（globalConfig 内部按 setting 重新探测并优先返回）
  const fromCfg = gc.getVivado('');
  if (fromCfg) return fromCfg;
  // ③ 兜底探测
  return v.probe('');
}

// 撤销原生折叠/展开：直接折叠焦点节点（无参 list.collapse 作用于树上当前焦点项）后全量刷新恢复原状态
function bdRevertToggle() {
  vscode.commands.executeCommand('list.collapse').then(undefined, () => {});
  if (bdTreeProvider) bdTreeProvider.refresh();
}

let bdTreeProvider = null;
let bdTreeView = null;
let bdSuppressToggle = null;       // 双击行附带的原生折叠/展开需撤销（行为对齐源码树）
let pendingFocusInst = null;       // 面板首次打开时，openScope 的 focus 渲染先入队，webview ready 后用它覆盖 fit

// 把 BD 面板拉到前台（它是 BD 树点击的「主内容」）。跨树联动的编辑器跳转走 preserveFocus，留后台。
// 仅当面板已存在时 reveal；不存在时由 ensurePanel 创建并自动置前。
function revealPanel() {
  if (panel) { try { panel.reveal(panel.viewColumn); } catch (e) { /* 已 dispose 则忽略 */ } }
}

// 点击树节点 → 直接打开该模块的 UI 作用域
async function openScopeFor(moduleName, originInst) {
  if (!G || !G.moduleDefs.has(moduleName)) {
    if (!(await loadGraph())) return;
  }
  if (!G.moduleDefs.has(moduleName)) {
    vscode.window.showErrorMessage(t('未找到模块 ', 'Module not found: ') + moduleName);
    return;
  }
  selectedKeys = new Set();
  ensurePanel('BD: ' + moduleName);
  revealPanel();   // 显式打开/跳到模块 UI 时，主内容（BD 画布）置前台
  await openScope(moduleName, null, null, originInst);
  // 面板打开成功（数据已加载）→ 刷新 BD 树，使其显示真实分区/顶层/子实例
  try { bdTreeProvider && bdTreeProvider.refresh(); } catch (e) { }
}

// 单击 BD 树节点 → 在当前已打开的 UI 画布中定位（pan+高亮）该实例块；
// 双击 → 打开该实例模块自身的 UI 作用域（原单click行为）。
// 与 Vivado Hierarchy 树一致：单跳「例化位置」、双跳「源码定义(模块UI)」。
const BD_DBL_MS = 350;
let lastBDFocus = { key: null, time: 0 };
async function focusInstance(node) {
  if (!node) return;
  revealPanel();   // BD 树点击：主内容（BD 画布）置前台
  const key = (node.inst || '') + '@' + (node.moduleName || '') + '@' + (node.parentScope || '');
  const now = Date.now();
  if (lastBDFocus.key === key && (now - lastBDFocus.time) < BD_DBL_MS) {
    lastBDFocus.key = null;                       // 消费第二击
    bdSuppressToggle = key;                        // 标记：随后原生折叠/展开需撤销
    setTimeout(() => { bdSuppressToggle = null; }, 500);
    openScopeFor(node.moduleName);                // 双击：打开该节点模块自身的 UI
  } else {
    lastBDFocus = { key, time: now };
    bdSuppressToggle = key;                        // 立即置位，覆盖第二击原生折叠/展开
    setTimeout(() => { if (lastBDFocus.key === key) { lastBDFocus.key = null; bdSuppressToggle = null; } }, BD_DBL_MS);
    focusInUI(node);                              // 单击：定位到 UI 中的块位置
  }
}

async function focusInUI(node) {
  // 顶层根节点：画布本身即该模块，无对应实例块 → 仅确保面板打开并 fit
  if (!node.parentScope) {
    if (!G || !G.moduleDefs.has(node.moduleName)) { if (!(await loadGraph())) return; }
    if (G && G.moduleDefs.has(node.moduleName)) {
      selectedKeys = new Set();
      ensurePanel('BD: ' + node.moduleName);
      await openScope(node.moduleName);                // 无 focusInst → fitToView
    }
    return;
  }
  // 需要 parentScope 画布包含该实例块。
  if (panel && scopeModule === node.parentScope) {
    // 当前画布就是父作用域 → 直接定位，不重渲染（保留用户当前缩放/平移）
    panel.webview.postMessage({ type: 'focusBlock', inst: node.inst, blockType: node.moduleName });
  } else {
    if (!G || !G.moduleDefs.has(node.parentScope)) { if (!(await loadGraph())) return; }
    if (G && G.moduleDefs.has(node.parentScope)) {
      selectedKeys = new Set();
      ensurePanel('BD: ' + node.parentScope);
      await openScope(node.parentScope, null, { inst: node.inst, type: node.moduleName });   // 切到父作用域并渲染后 centering 到该实例块
    } else {
      vscode.window.showErrorMessage(t('未找到父作用域 ', 'Parent scope not found: ') + node.parentScope);
    }
  }
}

// 跨树联动辅助：由「实例被例化的位置（instanceFile:instanceLine）」反推其所属父模块名。
// 同一文件内 module 顺序排布，含该例化行、且定义行最靠后的模块即父模块。
function enclosingModuleOf(file, line) {
  if (!G || !file) return null;
  const f = String(file).replace(/\\/g, '/');
  let best = null;
  for (const [name, def] of G.moduleDefs) {
    if (def.file && String(def.file).replace(/\\/g, '/') === f && def.line <= line) {
      if (!best || def.line > best.line) best = { name, line: def.line };
    }
  }
  return best ? best.name : null;
}

// 跨树联动（后台，不抢焦点）：Hierarchy 树单击/双击时调用，对应 BD 的「定位实例块 / 打开模块 UI」。
// BD 面板未开则在后台（preserveFocus）创建并定位；已开则直接后台更新——编辑器始终是当前主内容。
async function locateInstanceBg(node) {
  // node 兼容两种结构：BD 树节点 {inst, moduleName, parentScope} 与 Vivado 树 cell
  // {instance, module, instanceFile, instanceLine}
  const inst = node.inst || node.instance;
  const moduleName = node.moduleName || node.module;
  if (!node || !inst) return;
  if (!G || !G.moduleDefs) { if (!(await loadGraph())) return; }
  const parentScope = enclosingModuleOf(node.instanceFile, node.instanceLine);
  if (!panel) ensurePanel('BD: ' + (parentScope || moduleName), true);   // 后台创建，不抢编辑器焦点
  if (!parentScope) {
    // 顶层模块（无父作用域）：打开模块自身 UI（顶层无“块”可定位）
    await openScope(moduleName);
    return;
  }
  if (scopeModule === parentScope) {
    panel.webview.postMessage({ type: 'focusBlock', inst, blockType: moduleName });
  } else {
    await openScope(parentScope, null, { inst, type: moduleName });
  }
}
async function openScopeBg(moduleName, originInst) {
  // 兼容两种调用：字符串 moduleName 或 Vivado 树 cell {module}
  if (moduleName && typeof moduleName === 'object') moduleName = moduleName.module || moduleName.moduleName;
  if (!moduleName) return;
  if (!G || !G.moduleDefs.has(moduleName)) { if (!(await loadGraph())) return; }
  if (!G.moduleDefs.has(moduleName)) return;
  selectedKeys = new Set();
  if (!panel) ensurePanel('BD: ' + moduleName, true);   // 后台创建，不抢编辑器焦点
  await openScope(moduleName, null, null, originInst);
}

// ---------- BD 设计树（共用 Design/Simulation 源树结构） ----------
class BDBTreeProvider {
  constructor(state) {
    this.state = state;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(x) { return x; }
  getChildren(el) {
const st = this.state;
    // BD 树打开即【后台异步自动加载】：不阻塞、进度条正常完成；完成后自动 refresh 树出内容
    if (!el && (!st.G || !st.proj)) {
      // 已判定无 .xpr：直接显示提示，【不再触发自动加载】——否则 loadGraph 失败→refresh→
      // getChildren→再加载 会形成死循环（每次都弹警告）。用户设置工程后点刷新可重试。
      if (st.xprMissing) {
        return [this.info('未找到工程：当前工作区无 .xpr（请在「源码树」中设置工程后刷新）')];
      }
      startAutoLoadTree();
      return [this.info('正在加载 BD 工程（后台加载中）…')];
    }
    if (!el) {
      return [this.sec('design', 'Design Sources'), this.sec('sim', 'Simulation Sources')];
    }
    const cv = el.contextValue || el.ctx;
    if (cv === 'sec') {
      if (el.kind === 'design') {
        const top = st.topResolved;
        // 顶层 verified 判定与 Vivado Hierarchy 树一致：设计树认 designTop（缺省退 simTop）
        const designTopEff = (st.proj && (st.proj.designTop || st.proj.simTop)) || '';
        return top ? [this.modNode(top, top, undefined, top === designTopEff)] : [this.info('（未确定顶层）')];
      }
      // Simulation：sim_1 TopModule + 其他 sim 文件的顶层模块
      const tops = [];
      if (st.proj.simTop) tops.push(st.proj.simTop);
      for (const f of (st.proj.simFiles || [])) {
        try {
          const stripped = stripComments(fs.readFileSync(f.path, 'utf8'));
          for (const md of extractModules(stripped, 'verilog')) tops.push(md.name);
        } catch (e) { }
      }
      const uniq = [...new Set(tops)];
      // 仿真树顶层 verified 只认 sim_1 TopModule（与 Vivado Hierarchy 仿真树一致）
      return uniq.length
        ? uniq.map(t => this.modNode(t, t, undefined, t === st.proj.simTop))
        : [this.info('（无仿真顶层）')];
    }
    if (cv === 'mod') {
      const def = st.G ? st.G.moduleDefs.get(el.moduleName) : null;
      return (def ? def.instances : []).map(i => this.modNode(i.inst, i.type, el.moduleName));
    }
    return [];
  }
  sec(kind, label) {
    const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    it.ctx = 'sec'; it.contextValue = 'sec'; it.kind = kind;
    it.iconPath = new vscode.ThemeIcon(kind === 'design' ? 'circuit-board' : 'beaker');
    return it;
  }
  modNode(inst, moduleName, parentScope, isTop) {
    const def = this.state.G ? this.state.G.moduleDefs.get(moduleName) : null;
    const hasKids = !!(def && def.instances.length);
    const file = def ? (def.file || '') : '';
    const kind = def ? 'module' : (looksLikePrimitive(moduleName) ? 'primitive' : 'undefined');
    const isRoot = !parentScope;
    const it = new vscode.TreeItem(inst, hasKids ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    // 描述标签与 Vivado Hierarchy 树同词汇（[源文件]/[IP生成]/[原语]/[加密IP/黑盒]）
    it.description = moduleName + moduleKindTag(kind, file);
    // 图标规则与 Vivado Hierarchy 树完全一致（iconRules.moduleIconId）
    it.iconPath = new vscode.ThemeIcon(moduleIconId({ kind, file, hasChildren: hasKids, isRoot, isTop: !!isTop }));
    it.contextValue = 'mod';
    it.moduleName = moduleName;
    it.inst = inst;
    it.parentScope = parentScope || null;
    it.ctxKey = (inst || '') + '@' + moduleName + '@' + (parentScope || '');
    // 单击：在当前 UI 画布中定位该实例块（pan+高亮）；双击：打开该实例模块自身的 UI 作用域。
    // 行为对齐 Vivado Hierarchy 树（单跳例化位置 / 双跳源码定义）。
    it.command = { command: 'vivadoBD.focusInstance', title: t('单击:定位到UI位置 / 双击:打开模块UI', 'Click: locate in diagram / double-click: open module diagram'), arguments: [{ inst, moduleName, parentScope: parentScope || null }] };
    return it;
  }
  info(label) {
    const it = new vscode.TreeItem(label);
    it.contextValue = 'info';
    return it;
  }
}

async function openBlockDesign() {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('生成 Block Design...', 'Rendering Block Design...') },
    async () => {
      try {
        if (!(await loadGraph())) return;
        const top = bdState.topResolved;
        selectedKeys = new Set();
        ensurePanel('BD: ' + top);
        await openScope(top);
        outCh.appendLine(`[bd] top=${top} scopeBlocks=${lastRender ? lastRender.scene.blocks.length : '?'}`);
      } catch (e) {
        outCh.appendLine('[bd][error] ' + e.message);
        vscode.window.showErrorMessage(t('Block Design 打开失败：', 'Could not open Block Design: ') + e.message);
      }
    }
  );
}

function ensurePanel(title, preserveFocus) {
  if (panel) { panel.title = title; return; }
  const mediaDir = path.join(__dirname, 'media');
  panel = vscode.window.createWebviewPanel('vivadoBlockDesign', title,
    { viewColumn: vscode.ViewColumn.One, preserveFocus: !!preserveFocus },
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(mediaDir)], retainContextWhenHidden: true });
  // 先挂消息监听再设 html，避免 webview 早发的 'ready' 被丢弃
  panel.webview.onDidReceiveMessage(onMessage, null, _ctx.subscriptions);
  panel.onDidDispose(() => { panel = null; lastRender = null; currentSceneRecord = null; ++epoch; }, null, _ctx.subscriptions);
  panel.webview.html = getHtml(panel.webview, mediaDir);
}

let currentSceneRecord = null, dirtyGraph = null, scopeContext = null, historyGraph = null;
let scopeHistory = [];
const dirtyDocuments = new Set();
function sourcePath(file) { return require('path').resolve(file || '').toLowerCase(); }
function sourceChanged(document, saved) {
  if (!G || !document || !document.uri) return;
  const file=sourcePath(document.uri.fsPath);
  if (!G.paths.some(p=>sourcePath(p)===file)) return;
  if (saved || document.isDirty === false) dirtyDocuments.delete(file); else dirtyDocuments.add(file);
  dirtyGraph=G;gp.clearScenes(G);++epoch;
}
async function openScope(moduleName, parentParams, focusInst, originInst, instancePath, context) {
  try {
    if (dirtyGraph === G) {
      if (G.paths.some(p=>dirtyDocuments.has(sourcePath(p)))) {
        vscode.window.showInformationMessage(t('源码有未保存修改，请保存并刷新工程后再操作', 'Save source changes and refresh the project before continuing'));return;
      }
      bdState.G=null;bdState.proj=null;if (!(await loadGraph())) return;dirtyGraph=null;
    }
    const graph=G, request=++epoch;
    if(historyGraph!==graph){historyGraph=graph;scopeHistory=[];}
    let pp=parentParams instanceof Map ? Object.fromEntries(parentParams) : parentParams || undefined;
    context=context||{rootModule:moduleName,rootParams:pp||{},instances:[],originInst:originInst||null,handle:graph.handle};
    const begin=Date.now();let record=null, resolvedOrigin=context.handle===graph.handle?context.originInst:null;
    const resolvedHistory=[];
    moduleName=context.rootModule;pp=context.rootParams;
    for(let level=0;level<=context.instances.length;++level) {
      instancePath=JSON.stringify([context.rootModule,...context.instances.slice(0,level)]);
      const options={busView:busViewEnabled,parentParams:pp,originInst:resolvedOrigin||null,isTop:moduleName===bdState.topResolved&&level===0,instancePath,
        instanceContext:{rootModule:context.rootModule,rootParams:context.rootParams,instances:context.instances.slice(0,level)}};
      record=await gp.renderScene(graph,moduleName,options);
      if(request!==epoch||G!==graph||!record)return;
      if(level===context.instances.length)break;
      resolvedHistory.push({module:moduleName,params:pp,originInst:resolvedOrigin,context:{...context,instances:context.instances.slice(0,level)}});
      const block=record.scene.blocks.find(b=>b.inst===context.instances[level]);
      const target=block&&record.navigation[block.key]&&record.navigation[block.key].enterScope;
      if(!target)throw new Error('Instance context changed; reopen its parent: '+context.instances[level]);
      moduleName=target.module;pp=target.params;resolvedOrigin=target.originInst;
    }
    if(request!==epoch||G!==graph||!record)return;
    currentSceneRecord=record;scopeContext=context;scopeHistory=resolvedHistory;scopeModule=moduleName;scopeParentParams=pp||null;
    lastRender={type:'render',epoch:request,module:moduleName,busView:busViewEnabled,originInst:resolvedOrigin||null,scene:record.scene,focusInst:focusInst||null,trail:scopeHistory.map(h=>h.module)};
    if(panel)panel.title='BD: '+moduleName;
    pendingFocusInst=focusInst||null;sendRender();lastRender.focusInst=null;
    outCh.appendLine('[bd][scene] '+moduleName+': blocks='+record.scene.blocks.length+' nets='+record.scene.nets.length+' elapsed='+ (Date.now()-begin)+'ms cache='+JSON.stringify(gp.sceneStats(graph)));
  } catch(e) {
    outCh.appendLine('[bd][scene][error] '+e.message);
    if(panel)panel.webview.postMessage({type:'error',message:e.message});
    vscode.window.showErrorMessage(t('Block Design 打开失败：','Could not open Block Design: ')+e.message);
  }
}
function currentMessage(msg, allowDirty = false) {
  return G && currentSceneRecord && lastRender && msg.sceneId === currentSceneRecord.scene.sceneId &&
    currentSceneRecord.handle === G.handle && (allowDirty || (currentSceneRecord.graphEpoch === (G.sceneEpoch||0) && dirtyGraph !== G)) &&
    currentSceneRecord.session === gp.native().__runtimeInfo().session && gp.native().__runtimeInfo().alive;
}
async function navigate(msg) {
  if(!currentMessage(msg)) { vscode.window.showInformationMessage(t('图形已过期，请刷新后重试','The diagram is outdated. Refresh and try again'));return; }
  const nav=currentSceneRecord.navigation[msg.objectId];if(!nav)return;
  if(msg.action==='enterScope') {
    const target=nav.enterScope;
    if(target) {
      const block=lastRender.scene.blocks.find(b=>b.key===msg.objectId);
      selectedKeys=new Set();await openScope(target.module,target.params,null,target.originInst,target.instancePath,{...scopeContext,instances:[...scopeContext.instances,block.inst]});
    }return;
  }
  const target=msg.action==='definition'?nav.definition:msg.action==='instantiation'?nav.instantiation:null;
  if(!target) {vscode.window.showInformationMessage(msg.action==='instantiation'?t('没有可定位的例化位置','No instantiation location is available'):t('该处无可读源码','No readable source at this location'));return;}
  const open=(vscode.workspace.textDocuments||[]).find(d=>d.uri&&sourcePath(d.uri.fsPath)===sourcePath(target.file));
  if(open&&open.isDirty) {vscode.window.showInformationMessage(t('源码有未保存修改，请保存并刷新工程后再操作','Save source changes and refresh the project before continuing'));return;}
  await gotoLocation(target.file,target.line);
}
const textRefinements=new Set();
async function refineText(msg) {
  if(!currentMessage(msg))return;
  if(textRefinements.has(msg.sceneId))return;
  textRefinements.add(msg.sceneId);
  try {
  const graph=G,request=epoch,record=currentSceneRecord;
  const next=await gp.refineScene(graph,record,msg.widths);
  if(!next||G!==graph||epoch!==request||currentSceneRecord!==record)return;
  currentSceneRecord=next;lastRender={...lastRender,scene:next.scene,preserveView:true};
  if(panel)panel.webview.postMessage({type:'sceneTextPatch',patch:next.patch});
  }finally{textRefinements.delete(msg.sceneId);}
}

function sendRender() {
  if (panel && lastRender) {
    lastRender.selected = [...selectedKeys];
    panel.webview.postMessage(lastRender);
  }
}

async function onMessage(msg) {
  if (!msg || !msg.type) return;
  try {
    if (['rewire','exportToSim','explainModule'].includes(msg.type) && !currentMessage(msg, msg.type === 'rewire')) {
      vscode.window.showInformationMessage(t('图形已过期，请刷新后重试','The diagram is outdated. Refresh and try again'));return;
    }
    if (msg.type === 'explainModule' && msg.objectId && currentSceneRecord) {
      const nav=currentSceneRecord.navigation[msg.objectId];msg={...msg,file:nav&&nav.definition?nav.definition.file:null};
    }
    switch (msg.type) {
      case 'navigate': await navigate(msg);break;
      case 'navigateBack': {
        if(!currentMessage(msg)||!scopeHistory.length)break;
        const parent=scopeHistory.pop();selectedKeys=new Set();await openScope(parent.module,parent.params,null,parent.originInst,null,parent.context);break;
      }
      case 'sceneTextMetrics': await refineText(msg);break;
      case 'sceneStats': if(currentMessage(msg))outCh.appendLine('[bd][paint] '+JSON.stringify(msg.stats));break;
      case 'ready':
        // 面板首次加载：若本次定位携带 focus 目标，则在 fit 之后重新定位（覆盖 fit），避免定位被覆盖
        if (!lastRender) break;
        lastRender.focusInst = pendingFocusInst;
        sendRender();
        lastRender.focusInst = null;
        pendingFocusInst = null;
        break;
      case 'openScope':
        if (G && G.moduleDefs.has(msg.module)) {
          selectedKeys = new Set();
          // 双击进入子模块：带上「该子模块在【当前作用域】里被例化的位置」，供 UI 判断顶层/跳例化
          const oi = (msg.instFile && msg.instLine) ? { file: msg.instFile, line: msg.instLine } : null;
          await openScope(msg.module, msg.parentParams, null, oi);
        } else if (panel) panel.webview.postMessage({ type: 'error', message: '未知模块 ' + msg.module });
        break;
      case 'notice':
        // UI 侧信息说明（如：顶层模块没有被任何父模块例化 → 无例化位置）
        if (msg.message) vscode.window.showInformationMessage(msg.message);
        break;
      case 'setBusView':
        // Folded pins and routes differ; render the current native snapshot again.
        busViewEnabled = !!msg.on;
        if (lastRender) {
          await openScope(scopeModule, scopeParentParams, null, lastRender.originInst, lastRender.scene.instancePath, scopeContext);
          outCh.appendLine('[bd][busView] ' + (busViewEnabled ? '总线视图（成员折叠成粗 pin/粗线）' : '信号视图（逐条信号）'));
        }
        break;
      case 'selectionChanged':
        selectedKeys = new Set(msg.ids || []);
        break;

      case 'export':
        exportSelection();
        break;
      case 'exportToSim':
        // async 函数：失败必须可见（unhandled rejection 用户看不到——这是"点了没反应"的根因之一）
        Promise.resolve(exportToSim(msg.ids, msg.module)).catch(e => {
          outCh.appendLine('[exportToSim] 异常: ' + (e && e.stack || e));
        vscode.window.showErrorMessage(t('导出到仿真异常: ', 'Export to simulation error: ') + (e && e.message || e));
        });
        break;
      case 'testInject':
        Promise.resolve(testInject()).catch(e => {
          outCh.appendLine('[testInject] 异常: ' + (e && e.stack || e));
          vscode.window.showErrorMessage(t('测试注入异常: ', 'Test injection error: ') + (e && e.message || e));
        });
        break;
      case 'rewire':
        await applyRewire(msg);
        break;
      case 'fetchIpPorts':
        // 右键 BD 块 → AI 从官网抓取该 IP 端口手册并写入端口方向数据（工作流注入，同 simulation/synth）
        Promise.resolve(workflowProvider.fetchIpPorts(msg.ipType)).catch(e => {
          outCh.appendLine('[fetchIpPorts] 异常: ' + (e && e.stack || e));
          vscode.window.showErrorMessage(t('下载 IP 端口定义异常: ', 'IP port definition fetch error: ') + (e && e.message || e));
        });
        break;
      case 'explainModule':
        // 右键 BD 块 → AI 读该模块源码讲解功能 + 在本工程的作用（统一规则：读 module-explain 技能注入）
        Promise.resolve(workflowProvider.explainModule(msg.module, msg.file)).catch(e => {
          outCh.appendLine('[explainModule] 异常: ' + (e && e.stack || e));
          vscode.window.showErrorMessage(t('讲解模块异常: ', 'Module explanation error: ') + (e && e.message || e));
        });
        break;
      default:
        break;
    }
  } catch (e) {
    // 同步异常也可见化（require 失败/空引用等）
    outCh.appendLine('[onMessage] 异常 (' + msg.type + '): ' + (e && e.stack || e));
    vscode.window.showErrorMessage(t('处理消息 ', 'Error handling message ') + msg.type + t(' 异常: ', ': ') + (e && e.message || e));
  }
}

async function gotoLocation(file, line) {
  if (!file) { vscode.window.showInformationMessage(t('该处无可读源码', 'No readable source at this location')); return; }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const ed = await vscode.window.showTextDocument(doc);
    if (line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch (e) {
    vscode.window.showErrorMessage(t('打开文件失败: ', 'Could not open file: ') + e.message);
  }
}

// ---------- 导出（收集与去向解耦，DESIGN §6） ----------
function collectSelectedFiles() {
  if (!lastRender) return [];
  const byKey = currentSceneRecord && currentSceneRecord.navigation;
  const files = [];
  for (const k of selectedKeys) {
    const nav = byKey && byKey[k];
    if (nav && nav.definition) files.push(nav.definition.file);
  }
  return [...new Set(files)];
}

function exportSelection(filesArg) {
  const files = filesArg && filesArg.length ? filesArg : collectSelectedFiles();
  if (!files.length) { vscode.window.showInformationMessage(t('未勾选任何模块', 'No modules are selected')); return; }
  const cfg = vscode.workspace.getConfiguration('vivadoProjectExplorer');
  const mode = cfg.get('exportMode') || 'clipboard';
  if (mode === 'clipboard') {
    vscode.env.clipboard.writeText(files.join('\n'));
    vscode.window.showInformationMessage(t('已复制 ', 'Copied ') + files.length + t(' 个文件名到剪贴板', ' file names to the clipboard'));
  } else if (mode === 'outputChannel') {
    outCh.appendLine('[export]\n' + files.join('\n'));
    outCh.show();
  } else if (mode === 'command') {
    const cmd = cfg.get('exportCommand');
    if (cmd) vscode.commands.executeCommand(cmd, files);
  }
}

// ---------- 导出到仿真（右键菜单）：选中块 → 子图 + 伪 tb → 注入 AI 生成 testbench ----------
function exportToSim(ids, moduleName) {
  const step = (m) => outCh.appendLine('[exportToSim] ' + m);   // 每步写日志（F5 宿主失败用户可在 Output 面板定位）
  if (!ids || !ids.length) { vscode.window.showInformationMessage(t('请先选择模块', 'Select modules first')); return; }
  if (!lastRender || !lastRender.scene) { vscode.window.showInformationMessage(t('无当前作用域', 'No active scope')); return; }
  step('开始：选中 ' + ids.length + ' 块，模块=' + (moduleName || lastRender.module));
  // 1. 提取选中子图（原生 collectSelectedSubgraph——只读不改图）
  const scope = gp.renderScope(G, scopeModule, { busView: busViewEnabled, parentParams: scopeParentParams }).scope;   // UI 版（prepareScopeForUI 输出）
  const sub = gp.native().collectSelectedSubgraph(scope, ids, moduleName || scope.module || '');
  if (!sub || !sub.blocks.length) { step('Failed: subgraph is empty'); vscode.window.showInformationMessage(t('失败：未提取到子图', 'Failed to extract the subgraph')); return; }
  step('子图提取 ok: blocks=' + sub.blocks.length + ' boundary=' + sub.boundary.length);
  // 2. 生成伪 testbench（SV，网表连线已接好）
  const stub = gp.native().genStubTb(sub);
  // 3. 【骨架落盘】唯一命名（禁止任何名字假设）：基础名 = 选中块实例名组合 + 时间戳
  const workspaceDir = (vscode.workspace.workspaceFolders || [])[0] && (vscode.workspace.workspaceFolders)[0].uri.fsPath;
  if (!workspaceDir) { step('Failed: no workspace'); vscode.window.showInformationMessage(t('无工作区', 'No workspace')); return; }
  const { stubPath, tbPath, base, ts, tbDir, simDir } = require('./naming').tbOutputPath(workspaceDir, sub);
  fs.writeFileSync(stubPath, stub, 'utf8');
  step('骨架已写入: ' + stubPath + '（基础名=' + base + ' 时间戳=' + ts + '；tb 目录=' + tbDir + ' sims 目录=' + simDir + '）');
  // AI 消息（精简）：骨架位置 + 各模块源文件路径。不发 JSON（AI 要的是源码和骨架）。
  const srcList = sub.blocks.map(b => '- ' + b.inst + ' (' + b.type + ')' +
    (b.file ? ' → ' + b.file : ' → [原语/无本地源码]')).join('\n');
  // 4. 编辑器直接打开 tb 骨架文件（用户可随时查看/修改）+ 同时注入 AI（不等确认）。
  //    注入走统一入口（aiBridge + export-to-sim 技能），与其它 AI 功能同一条链路——
  //    不再自己拼技能全文调 autoInject（那条路径绕过了分层与技能安装）。
  vscode.commands.executeCommand('vscode.open', vscode.Uri.file(stubPath));
  Promise.resolve(workflowProvider.exportToSim({ projDir: workspaceDir, stubPath, tbDir, simDir, srcList }))
    .then(res => {
      if (res && res.ok) {
        step('注入成功: 会话=' + res.sessionId);
        vscode.window.showInformationMessage(t('已交给 AI 生成仿真方案（会话 ', 'Asked AI to generate a simulation plan (session ') + `${res.sessionId.slice(0, 12)}${t('…）。骨架文件：', '…). Testbench skeleton: ')}${stubPath}`);
      }
    })
    .catch(e => step('注入异常: ' + (e && e.stack || e)));
}

// ---------- 测试注入（右键菜单诊断项）：逐环节检测注入链路，结果弹窗+日志 ----------
// 走统一入口 aiBridge.inject（feature='test'，无对应技能，靠全局规则就够），
// 不再直连 aiAdapter.autoInject——那条路绕过了 prompts.js 组装和适配器选择，
// 测出来的结果和用户实际点流程时走的不是同一条链。
async function testInject() {
  const step = (m) => { outCh.appendLine('[testInject] ' + m); };
  step('开始诊断注入链路…');
  const workspaceDir = (vscode.workspace.workspaceFolders || [])[0] && (vscode.workspace.workspaceFolders)[0].uri.fsPath;
  if (!workspaceDir) { vscode.window.showErrorMessage(t('[1/4] 失败：无工作区', '[1/4] Failed: no workspace')); return; }
  step('[1/4] 工作区: ' + workspaceDir);
  const bridge = require('./aiBridge');
  const pick = await bridge.pickTool(vscode);
  step('[2/4] 工具: ' + (pick.ok ? pick.adapter.label + '（caps.systemPrompt=' + pick.adapter.caps.systemPrompt + '）'
    : '不可用 → ' + pick.reason));
  if (!pick.ok) { vscode.window.showErrorMessage(t('测试注入失败: ', 'Test injection failed: ') + pick.reason); return; }
  try {
    const res = await bridge.inject(vscode, workspaceDir, 'test', {
      task: t('这是 Airtl 与 OpenCode 的消息注入测试。请只回复 AIRTL_OPENCODE_API_OK；不调用工具，不读取或修改工程文件。',
        'This is an Airtl and OpenCode message injection test. Reply only AIRTL_OPENCODE_API_OK. Do not use tools or read or modify project files.'),
      timeoutMs: 0,
    });
    if (!res.ok) throw new Error(res.error || 'AI injection failed');
    step('[3/4] 注入 ok: 工具=' + res.tool + ' 会话=' + res.sessionId + ' isNew=' + res.isNew
      + (res.auto ? '（自动降级选中的）' : ''));
    step('[4/4] 完成 ✓');
    vscode.window.showInformationMessage(
      '测试注入成功 ✓\n工具: ' + res.tool + '\n会话: ' + String(res.sessionId).slice(0, 16) + '… ('
      + (res.isNew ? '新建' : '恢复') + ')\n'
      + (res.tuiSwitched ? 'TUI 切换: 成功' : '') + '\n请查看 AI 界面是否显示测试消息');
  } catch (e) {
    step('失败: ' + e.message);
    vscode.window.showErrorMessage(t('测试注入失败: ', 'Test injection failed: ') + e.message + ' ' + t('（详见 Output → Block Design [testInject] 日志）', '(see Output → Block Design [testInject] for details)'));
  }
}

// ---------- P5a 回写闭环：rewire → WorkspaceEdit → 定向失效 → 重开当前作用域 ----------
function offsetToPos(text, offset) {
  let line = 0, col = offset;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) { line++; col = offset - i - 1; }
  }
  return new vscode.Position(line, col);
}

async function applyRewire(msg) {
  try {
    if (!G || !lastRender) return;
    // blockKey = type@inst@line；例化语句在【当前作用域模块】的源文件里
    // 常量源伪块的 key 是 const@<目标块键>@<端口>（段数不同，且它本身不是例化语句）→ 不支持改线。
    if (String(msg.blockKey).startsWith('const@')) throw new Error('常量源（const）不参与改线');
    const target = currentSceneRecord && currentSceneRecord.navigation[msg.blockKey];
    const block = lastRender.scene.blocks.find(b => b.key === msg.blockKey);
    if (!target || !target.instantiation || !block) throw new Error('No valid instance location');
    const instName = block.inst, instLine = target.instantiation.line;
    const def = G.moduleDefs.get(scopeModule);
    if (!def || !def.file) throw new Error('当前作用域模块无源文件');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(def.file));
    const fileText = document.getText();
    const edit = rw.planRewire(fileText, { instLine, instName }, msg.port, msg.newSignal);
    if (!edit) throw new Error(`未在 ${basename(def.file)}:${instLine} 找到 .${msg.port}(...) 连接`);
    const ok = await vscode.window.showWarningMessage(
      `将修改并保存 ${basename(def.file)}：\n.${msg.port}(${edit.oldExpr}) → .${msg.port}(${msg.newSignal})`,
      { modal: true }, '应用');
    if (ok !== '应用') return;
    const wsEdit = new vscode.WorkspaceEdit();
    wsEdit.replace(vscode.Uri.file(def.file),
      new vscode.Range(offsetToPos(fileText, edit.start), offsetToPos(fileText, edit.end)),
      msg.newSignal);
    const done = await vscode.workspace.applyEdit(wsEdit);   // Ctrl+Z 可撤销
    if (!done) throw new Error('WorkspaceEdit 被拒绝');
    if (!(await document.save())) throw new Error('源文件保存失败，未重新加载连线图');
    gp.invalidateFile(G, def.file);                            // 定向失效（TASKS §2）
    outCh.appendLine(`[bd][apply] .${msg.port}(${edit.oldExpr}) -> (${msg.newSignal}) @ ${basename(def.file)}:${instLine}`);
    const oldG = G;
    G = gp.loadGraph(hdlFiles, { workspaceDir: vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri.fsPath : null });   // mtime 变化 → 只重析被改文件
    if (oldG && oldG !== G) gp.freeGraph(oldG);                 // 换后端图先释放旧 handle
    bdState.G = G;
    await openScope(scopeModule, scopeParentParams, null, lastRender.originInst, lastRender.scene.instancePath, scopeContext);
    await vscode.commands.executeCommand('vivadoProjectExplorer.refresh');
  } catch (e) {
    outCh.appendLine('[bd][error] rewire: ' + e.message);
    if (panel) panel.webview.postMessage({ type: 'error', message: e.message });  // B8 error/ack
    vscode.window.showErrorMessage(t('回写失败：', 'Could not write changes: ') + e.message);
  }
}

function getHtml(webview, mediaDir) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'main.js')));
  const protocolUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'sceneProtocol.js')));
  const language = isChinese() ? 'zh-CN' : 'en';
  const translations = JSON.stringify(webviewTranslations()).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#ffffff;color:#243a4d;
    font-family:Consolas,'Courier New',monospace;}
  #bar{height:32px;display:flex;align-items:center;gap:10px;padding:0 10px;
    background:#f2f5f8;border-bottom:1px solid #d0dce8;font-size:12px;}
  #bar button{background:#2c6ea5;color:#fff;border:none;padding:4px 12px;cursor:pointer;}
  #bar button.on{background:#17915a;}
  #bar button:disabled{background:#b8c8d8;cursor:default;}
  #btnBus[aria-pressed="true"]{background:#245b89;}
  #cv{display:block;width:100%;height:calc(100% - 32px);cursor:grab;}
  #path{color:#2c6ea5;}
  #status{color:#6b7f92;}
  #hint{color:#9aa8b5;margin-left:auto;}
  /* 右键菜单 */
  #ctxMenu{position:fixed;display:none;z-index:100;background:#fff;border:1px solid #c5d2de;
    box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:12px;min-width:160px;}
  #ctxMenu div{padding:6px 14px;cursor:pointer;color:#243a4d;}
  #ctxMenu div:hover{background:#e8f1f8;}
  #ctxMenu .sep{border-top:1px solid #e0e8f0;padding:0;margin:3px 0;cursor:default;}
  #ctxMenu div.disabled{color:#a0b0c0;cursor:default;}
  #ctxMenu div.disabled:hover{background:#fff;}
</style>
</head>
<body>
<div id="bar">
  <button id="btnBack" disabled>← ${t('返回', 'Back')}</button>
  <button id="btnBus" title="${t('总线视图：把 AXI / SV interface / SV struct 成员折成一根粗 pin + 一条粗线', 'Bus view: group AXI, SV interface, and SV struct members into a single pin and wire')}">${t('总线视图', 'Bus view')}</button>
  <button id="btnExport">${t('导出所选文件名', 'Export selected file names')}</button>
  <span id="path"></span>
  <span id="status"></span>
  <span id="hint">${t('单击pin/连线/端口=高亮同名网络 · 点已连pin→点目标pin=改连线(Esc取消) · 双击块进下级 · 滚轮缩放 · 拖拽平移 · 右键=菜单', 'Click a pin, wire, or port to highlight its net · Click a connected pin, then a target pin to rewire (Esc cancels) · Double-click a block to open it · Scroll to zoom · Drag to pan · Right-click for actions')}</span>
</div>
<canvas id="cv"></canvas>
  <div id="ctxMenu">
    <div id="ctxOpenSource">${t('跳转模块源文件（打开定义位置）', 'Open module source (definition)')}</div>
    <div id="ctxGotoInst">${t('跳转到例化位置（打开例化处源码）', 'Go to instantiation (open source)')}</div>
    <div class="sep"></div>
    <div id="ctxTestInject">${t('测试注入（发测试消息到 AI 会话）', 'Test AI connection')}</div>
    <div id="ctxFetchIpPorts">${t('下载 IP 端口定义（AI 抓官网手册）', 'Fetch IP port definitions')}</div>
    <div id="ctxExplainModule">${t('让 AI 讲解此模块（读源码 + 工程作用）', 'Explain this module with AI')}</div>
    <div class="sep"></div>
  <div id="ctxExportSim">${t('导出到仿真（AI 生成 testbench）', 'Export to simulation (generate testbench)')}</div>
  <div id="ctxExportFiles">${t('导出所选文件名', 'Export selected file names')}</div>
  <div class="sep"></div>
  <div id="ctxClearSel">${t('取消选择', 'Clear selection')}</div>
</div>
<script nonce="${nonce}">window.airtlText=${translations};</script>
<script nonce="${nonce}" src="${protocolUri}"></script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { activate, _getHtml: getHtml };
