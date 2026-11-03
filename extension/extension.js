// Author: Airtl yu

// Contact: yuairtl@outlook.com
'use strict';
// extension.js — Vivado Project Explorer 主入口（纯磁盘模式，不依赖 Vivado）
// 数据来源：
//   1) xprreader.js 解析 .xpr（未压缩 XML）拿 TopModule（顶层名）+ part；
//   2) xprreader.js 遍历 <proj>.srcs/sources_1、constrs_1 拿真实 HDL/XDC 文件清单；
//   3) rtlparser.js 自行读取上述 HDL 文本，构建模块例化层次树（top→子模块→IP 内部）。
// 整个流程不调用 Vivado，无 license 要求，不修改工程。

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { t } = require('./l10n');
const analysisContext = require('./analysisContext');

// ── 启动打点（同步落盘，硬崩溃也不丢）：诊断「打开就闪退」用 ──
// 写到 os.tmpdir()/vivado-ext-boot.log；每一步 appendFileSync，SIGABRT 前的内容也在盘上。
const _BOOTLOG = (() => { try { return require('path').join(require('os').tmpdir(), 'vivado-ext-boot.log'); } catch (e) { return null; } })();
function boot(msg) {
  try { if (_BOOTLOG) fs.appendFileSync(_BOOTLOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { }
}
// 未捕获异常/未决 Promise：先记录，避免 Node 默认 abort() 直接打挂扩展宿主（134 崩溃）
try {
  process.on('uncaughtException', (e) => boot('UNCAUGHT: ' + (e && (e.stack || e.message) || e)));
  process.on('unhandledRejection', (r) => boot('UNHANDLED-REJECTION: ' + (r && (r.stack || r.message) || r)));
} catch (e) { }
boot('--- module load start ---');

// 层次树走 rtltree.js：它只做文件 I/O + 进程级缓存 + 组合，算法全在 C++（Airtl）。
// rtlparser.js（473 行，含算法实现）不随包发布，只留在开发树当差分测试的 JS 参照。
// 树视图与 BD 面板共用同一个长驻 C++ handle（gp.loadGraph / airtl.graphHierarchy）。
// 【为什么合并】原先树视图走 rtltree.buildModuleDefs（JS 轻量解析 + 进程级缓存），
// BD 面板走 airtl.graphLoad（C++ full 解析）——两条路产出同一份 moduleDefs 却是两套
// 实现，行为还会分叉：generate-for 在 C++ 侧展开成 N 个实例、JS 侧只提 1 个，
// 用户在两个视图里看到不同的树。合并后一套实现、行为天然一致。
const gp = require('./ui_design/graphProvider');
const airtl = require(path.join(__dirname, 'Airtl', 'index.js'));
boot('require rtlparser ok');
const ps = require('./projectSource');
boot('require projectSource ok');
const { moduleIconId, isGeneratedHdlPath, moduleKindTag } = require('./iconRules');
const { SystemVerilogLanguageService } = require('./svLanguageService');
const { createProviders: createSvLanguageProviders } = require('./svLanguageFeatures');
boot('require iconRules ok');

function basename(p) {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// 判定「Vivado 生成物」路径 & 模块图标规则统一在 iconRules.js（与 BD 设计树共用，保证两棵树图标一致）。

// 节点唯一 key（与 onOpenInstance 里的判定保持一致）
function nodeKeyOf(cell) {
  return cell.path || ((cell.module || '') + '#' + (cell.instanceFile || '') + '#' + (cell.instanceLine || 0));
}

// ---------- 工程来源（xpr / tcl / 源文件 三模式，实现在 projectSource.js） ----------
// 交互全在界面：默认三模式一次全扫 → 归类展示 → 用户选显示哪一种（不依赖 settings）。
// 用户选定的来源写入工作区缓存（.vscode/vivado-project.json），后续刷新自动复用，
// 随时可再点「选择工程来源」重选。
function workspaceRoots() {
  return (vscode.workspace.workspaceFolders || []).map(w => w.uri.fsPath);
}
function workspaceRoot() { const r = workspaceRoots(); return r.length ? r[0] : null; }
function modeLabel(mode) {
  return mode === 'tcl' ? t('Tcl 脚本（含 top 指定）', 'Tcl script (with top directive)') : mode === 'source' ? t('HDL 源文件', 'HDL source file') : t('.xpr 工程', '.xpr project');
}
function modeIconId(mode) {
  return mode === 'tcl' ? 'file-code' : mode === 'source' ? 'symbol-class' : 'file';
}
function modeTag(mode) {
  return mode === 'tcl' ? '[tcl]' : mode === 'source' ? '[' + t('源文件', 'source') + ']' : '[xpr]';
}
// 同步解析当前来源（不弹窗，getChildren 显示用）：只读缓存，跨模式，校验文件仍存在。
async function resolveProjectSource() {
  const session=require('./designSession'),state=session.read()||await session.readReady();
  return state?.source||null;
}
// 兼容旧命令：返回当前来源文件路径（xpr / tcl / 源文件 统一）
async function resolveProjectXpr() {
  const s = await resolveProjectSource();
  return s ? s.path : null;
}
// 三模式全扫并归类（树顶部「工程来源」节点用）。返回 {xpr:[],tcl:[],source:[]}
async function scanAllSources() {
  const roots = workspaceRoots();
  if (!roots.length) return { xpr: [], tcl: [], source: [] };
  return ps.discoverAllAsync(roots, 3);
}

// ---------- 树节点 ----------
class InfoNode extends vscode.TreeItem {
  constructor(msg) {
    super(msg, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'info';
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

class ErrorNode extends vscode.TreeItem {
  constructor(msg, stale = false) {
    super(stale
      ? t('刷新失败，显示上次成功结果', 'Refresh failed; showing last valid result')
      : t('Vivado 读取失败', 'Vivado load failed'), vscode.TreeItemCollapsibleState.None);
    this.contextValue = stale ? 'stale' : 'error';
    this.description = msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
    this.tooltip = msg;
    this.iconPath = new vscode.ThemeIcon(stale ? 'warning' : 'error');
  }
}

// ---------- 独立的工程来源视图（与源码树、BD 树平级） ----------
class ProjectSourceTreeProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.sources = { xpr: [], tcl: [], source: [] };
    this.currentSource = null;
  }
  refresh() { this._onDidChange.fire(); }
  setSources(all, cur) {
    this.sources = all || { xpr: [], tcl: [], source: [] };
    this.currentSource = cur || null;
    this.refresh();
  }
  getTreeItem(element) { return element; }
  async getChildren(element) {
    if (element instanceof SourceGroupNode) {
      const list = this.sources[element.mode] || [];
      const cur = this.currentSource;
      const nodes = list.map(candidate => new SourceItemNode(
        element.mode, candidate, !!(cur && cur.mode === element.mode && cur.path === candidate.path)));
      if (element.mode === 'source') nodes.push(new SourceBrowseNode());
      return nodes.length ? nodes : [new InfoNode(t('（未扫描到）', '(No files found)'))];
    }
    return [
      new SourceCurrentNode(this.currentSource),
      ...['xpr', 'tcl', 'source'].map(mode => new SourceGroupNode(mode, (this.sources[mode] || []).length)),
    ];
  }
}

class SourceCurrentNode extends vscode.TreeItem {
  constructor(cur) {
    super(cur
      ? t('当前来源：', 'Current source: ') + modeTag(cur.mode) + ' ' + basename(cur.path)
      : t('尚未选择工程来源', 'No project source selected'), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sourceCurrent';
    this.iconPath = new vscode.ThemeIcon(cur ? 'check' : 'info');
    this.description = cur ? vscode.workspace.asRelativePath(cur.path) : '';
    this.tooltip = cur ? cur.path : t('选择下方的工程、Tcl 或 HDL 来源以加载工程树', 'Choose an XPR, Tcl, or HDL source below to load the project tree');
  }
}
// 类别节点：xpr 工程 (n) / Tcl 脚本 (n) / HDL 源文件 (n)
class SourceGroupNode extends vscode.TreeItem {
  constructor(mode, n) {
    super(modeLabel(mode) + '  (' + n + ')',
      n || mode === 'source' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sourceGroup';
    this.mode = mode;
    this.iconPath = new vscode.ThemeIcon(modeIconId(mode));
  }
}
// 候选文件节点：点击即用该来源
class SourceItemNode extends vscode.TreeItem {
  constructor(mode, cand, isCurrent) {
    super(basename(cand.path), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sourceItem';
    this.mode = mode;
    this.cand = cand;
    this.source = { mode, path: cand.path };
    this.iconPath = new vscode.ThemeIcon(isCurrent ? 'check' : modeIconId(mode));
    this.description = (isCurrent ? t('✓ 当前   ', '✓ Current   ') : '') + vscode.workspace.asRelativePath(cand.path);
    this.tooltip = cand.path + (cand.top ? '\ntop = ' + cand.top : '')
      + (isCurrent ? '\n' + t('（当前来源）', '(current source)') : '\n' + t('点击选用此来源', 'Click to use this source'));
    this.command = { command: 'vivadoProjectExplorer.useSource', title: t('使用此来源', 'Use this source'), arguments: [{ mode, path: cand.path }] };
  }
}
// source 类别的兜底项：浏览任意 HDL（工作区扫描可能不含目标）
class SourceBrowseNode extends vscode.TreeItem {
  constructor() {
    super(t('浏览选择源文件…', 'Browse for an HDL source…'), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sourceItem';
    this.iconPath = new vscode.ThemeIcon('folder-opened');
    this.tooltip = t('选择一个不在工作区扫描范围内的 HDL 文件作为顶层', 'Choose a top-level HDL file outside the workspace scan');
    this.command = { command: 'vivadoProjectExplorer.useSource', title: t('浏览源文件', 'Browse HDL files'), arguments: [{ mode: 'source', browse: true }] };
  }
}

class ModuleNode extends vscode.TreeItem {
  // node: { module, instance, file, kind, children }  kind: 'module' | 'primitive' | 'undefined'
  // isRoot: 该节点是某棵树的顶层（Design root / 每个仿真顶层）
  // vivadoTops: Set<string> —— Vivado 明确指定的顶层（sim_1/sources_1 fileset 的 TopModule）
  constructor(node, isRoot, vivadoTops) {
    const hasChildren = node.children && node.children.length > 0;
    const label = isRoot ? node.module : node.instance;
    super(label, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'module';
    this.moduleName = node.module;
    this.instanceName = node.instance;
    this.cell = node;
    // 图标规则统一在 iconRules.js（与 BD 设计树共用，保证同一模块两棵树图标一致）：
    //   verified 顶层 / lock 原语·加密IP·黑盒 / package IP生成 / file-code 源码有下级 / symbol-class 源码叶子
    const isTop = !!(isRoot && vivadoTops && vivadoTops.has(node.module));
    this.iconPath = new vscode.ThemeIcon(node.display?.[isRoot ? (isTop ? 'top' : 'root') : 'child'] || moduleIconId({
      kind: node.kind, file: node.file, hasChildren, isRoot, isTop,
    }));
    const kindTag = node.display?.tag ?? moduleKindTag(node.kind, node.file);
    const uri = node.file ? vscode.Uri.file(node.file) : null;
    if (uri) this.resourceUri = uri;
    // 单击跳“被例化的位置”，双击跳“module 源码定义位置”（双击判定在命令处理里 time-based 区分）
    this.command = { command: 'vivadoProjectExplorer.openInstance', title: t('单击:跳例化位置 / 双击:跳源码定义', 'Click: go to instantiation / double-click: go to definition'), arguments: [this.cell] };
    this.tooltip = `${t('模块', 'Module')}: ${node.module}\n${t('实例', 'Instance')}: ${node.instance}\n${t('类型', 'Kind')}: ${node.kind}`
      + (node.file ? `\n${t('源码定义', 'Source definition')}: ${node.file}:${node.line}` : '\n' + t('(无可读源码，不可跳转定义)', '(No readable source; definition unavailable)'))
      + (node.instanceFile ? `\n${t('例化位置', 'Instantiation')}: ${node.instanceFile}:${node.instanceLine}` : '\n' + t('(顶层，无例化位置)', '(Top-level; no instantiation)'));
    this.description = node.file
      ? (isRoot ? basename(node.file) : `: ${node.module}  (${basename(node.file)})`)
      : (isRoot ? '' : `: ${node.module}`) + kindTag;
  }
}

// 分组节点：Design Sources / Simulation Sources / Constraints（模仿 Vivado Sources 视图分组）
class SectionNode extends vscode.TreeItem {
  constructor(kind, label) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'section';
    this.kind = kind; // 'design' | 'sim' | 'xdc'
    this.iconPath = new vscode.ThemeIcon(kind === 'design' ? 'circuit-board' : kind === 'sim' ? 'beaker' : 'file-binary');
  }
}

// 文件目录树的中间目录节点（仿真/XDC 按目录层级展开）
class FolderNode extends vscode.TreeItem {
  constructor(name, sub) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'folder';
    this.sub = sub; // buildFileTree 产生的中间节点
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

// 文件叶子节点（仿真 TB / XDC 约束），单击/双击打开文件
// file: { path, display, type, isTarget? }  display 是 xprreader 算好的宏展开相对路径
class FileNode extends vscode.TreeItem {
  constructor(file) {
    super(basename(file.path), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'file';
    this.filePath = file.path;
    this.iconPath = new vscode.ThemeIcon(file.type === 'XDC' ? 'file-binary' : 'file-code');
    // Constraints 分组下：target XDC 标 [target]（Vivado Sources 视图形式），
    // description 显示相对工程目录的完整位置（constrs_1/new/xxx.xdc 或 ../SRC/xxx.xdc）
    if (file.type === 'XDC') {
      this.description = (file.isTarget ? '  [target]' : '') + (file.display ? '  ' + file.display : '');
    } else {
      this.description = '';
    }
    this.tooltip = file.path;
    const uri = vscode.Uri.file(file.path);
    this.resourceUri = uri;
    this.command = { command: 'vscode.open', title: t('打开文件', 'Open file'), arguments: [uri] };
  }
}

// 把文件列表转成目录层级树（供 XDC 等分组显示）。
// 不再猜 `.srcs/` 截取——直接使用 xprreader 算好的 display 字段（宏展开后的相对路径），
// 没有 display 时退回文件名的上一级目录（相对显示）。
// 返回中间节点数组：[{ name, children, isFile:false }, ..., { name, file, children: [], isFile:true }]
function buildFileTree(files) {
  const root = { name: '', children: [], isFile: false };
  for (const f of files) {
    const rel = (f.display || f.path).replace(/\\/g, '/');
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.children.find(c => !c.isFile && c.name === parts[i]);
      if (!child) { child = { name: parts[i], children: [], isFile: false }; node.children.push(child); }
      node = child;
    }
    node.children.push({ name: parts[parts.length - 1], file: f, children: [], isFile: true });
  }
  return root.children;
}

// ---------- 树视图共用的 C++ handle 辅助 ----------

// 从 TB 文件取顶层模块名并展开成树。对应原 rtlparser.buildSimTreeFromDefs。
// 【mtime/size 记忆在 C++ 侧】GraphStore 自己按 mtime/size 判失效，
// 不需要 JS 再维护一份 _simTopMemo。
// ---------- TreeDataProvider ----------
class VivadoTreeProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.data = null;     // buildHierarchy 的结果
    this.files = null;    // { srcFiles, simFiles, xdcFiles, ipFiles }
    this.proj = null;     // 缓存的工程清单（含 xpr 路径与 mtime），避免每次刷新都重走磁盘遍历
    this.graph = null;    // 长驻 C++ handle（gp.loadGraph 的结果）——一次解析、多树复用
    this.error = null;
    this.expanded = new Set(); // 用户通过 chevron 展开的节点 key，刷新/撤销双击时保持展开状态
    this.itemCache = new Map();  // cacheKey -> ModuleNode（跨 refresh 复用对象引用，避免整树重绘闪烁）
    this.forceFreshKey = null;   // 需要强制新建对象（撤销双击开合）的节点 key
    this.dataStamp = 0;          // setData 时自增，作废缓存（数据真变了才重建节点）
  }
  refresh() { this._onDidChange.fire(); }
  setData(d, files, graph) { this.data = d; this.files = files; this.graph = graph || null; this.error = null; this.dataStamp++; this.itemCache.clear(); this.refresh(); }
  setError(e) { this.error = e; this.refresh(); }
  getTreeItem(e) { return e; }
  // Vivado 明确指定的顶层（图标分类用）。
  // 注意：仿真树与设计树各自有独立的 top 标识——仿真树只认 sim_1 TopModule（TB），
  // 设计树只认 sources_1 TopModule。不要合并，否则 udp_look_back（design top）会在仿真树
  // 被误标为 verified。Design root 单独传 tops 覆盖。
  vivadoTops() {
    const f = this.files;
    return f && f.simTop ? new Set([f.simTop]) : new Set();
  }
  // 创建/复用节点：普通节点复用缓存对象（同引用 → VSCode 不重绘，消除闪烁）；
  // forceFreshKey 命中的节点强制新建（其 Collapsed/Expanded 状态才会被应用，用于撤销双击开合）。
  // tops: 可选覆盖 vivadoTops()——Design root 应传 {designTop}，其他默认用 {simTop}
  makeNode(cell, isRoot, tops) {
    const key = nodeKeyOf(cell);
    // 缓存键必须包含 tops 集合——否则同一个 cell（如 udp_look_back 既是 Design root 又是
    // 仿真顶层）会命中同一缓存实例，复用在 Design 树里创建的 verified 图标，串台到仿真树。
    const topsKey = tops ? Array.from(tops).sort().join('|') : 'default';
    const cacheKey = this.dataStamp + '|' + topsKey + '|' + key + '|' + (cell.kind || '') + '|' + (cell.file || '')
      + '|' + (cell.line || 0) + '|' + (cell.instanceFile || '') + '|' + (cell.instanceLine || 0)
      + '|' + (cell.children ? cell.children.length : -1);
    let mn = (this.forceFreshKey === key) ? null : this.itemCache.get(cacheKey);
    if (!mn) {
      mn = new ModuleNode(cell, isRoot, tops || this.vivadoTops());
      this.itemCache.set(cacheKey, mn);
    }
    if (this.forceFreshKey === key) this.forceFreshKey = null; // 只强制一次
    // 展开状态始终以 provider.expanded 为准（chevron 用户行为 / 双击撤销都走这里）
    if (cell.children && cell.children.length) {
      mn.collapsibleState = this.expanded.has(key)
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    } else {
      mn.collapsibleState = vscode.TreeItemCollapsibleState.None;
    }
    return mn;
  }
  async getChildren(element) {
    // 根只展示工程内容；工程来源由同一侧栏中的独立视图管理。
    if (!element) {
      const out = [];
      if (this.error) out.push(new ErrorNode(this.error, !!this.data));
      if (!this.data) {
        if (!this.error)
          out.push(new InfoNode(t('请在「工程选择」视图中选择 .xpr / Tcl / HDL 来源。', 'Choose an XPR, Tcl, or HDL source in the Project Selection view.')));
        return out;
      }
      out.push(
        new SectionNode('design', 'Design Sources'),
        new SectionNode('sim', 'Simulation Sources'),
        new SectionNode('xdc', 'Constraints'),
      );
      return out;
    }
    if (element instanceof SectionNode) {
      if (element.kind === 'design') {
        // Design Sources root 只用 designTop 标 verified（避免 simulation top 串台）
        const f = this.files;
        const designTops = f && f.designTop ? new Set([f.designTop]) : this.vivadoTops();
        return [this.makeNode(this.data.root, true, designTops)];
      }
      if (element.kind === 'sim') {
        const roots = this.treeProjection?.simulation || [];
        return roots.length ? roots.map(root => this.makeNode(root, true))
          : [new InfoNode(t('（无仿真顶层）', '(No simulation tops)'))];
      }
      // Constraints 分组：Vivado 形式——直接列 XDC 文件（不嵌套目录），target 标 [target]。
      // display 字段（xprreader 算好的宏展开相对路径）放到 description 里展示完整位置。
      const files = element.kind === 'xdc' ? ((this.files && this.files.xdcFiles) || []) : [];
      if (files.length === 0) {
        return [new InfoNode(t('（无 XDC 约束文件）', '(No XDC constraint files)'))];
      }
      return files.map(f => new FileNode(f));
    }
    if (element instanceof FolderNode) {
      return (element.sub.children || []).map(n => n.isFile ? new FileNode(n.file) : new FolderNode(n.name, n));
    }
    if (element instanceof ModuleNode) {
      return (element.cell.children || []).map(n => this.makeNode(n, false));
    }
    return [];
  }
}

// ---------- 激活 ----------
function activate(context) {
  if (airtl.__shutdown) context.subscriptions.push({ dispose: () => airtl.__shutdown() });
  boot('activate() start');
  context.subscriptions.push(vscode.commands.registerCommand('airtl.focus', () =>
    vscode.commands.executeCommand('workbench.view.extension.airtl')));
  const provider = new VivadoTreeProvider();
  const sourceProvider = new ProjectSourceTreeProvider();
  const session = require('./designSession');
  context.subscriptions.push({dispose(){session.dispose();}});
  const treeView = vscode.window.createTreeView('vivadoProjectExplorer', { treeDataProvider: provider });
  context.subscriptions.push(treeView);
  const sourceTreeView = vscode.window.createTreeView('vivadoProjectSource', { treeDataProvider: sourceProvider });
  context.subscriptions.push(sourceTreeView);
  boot('createTreeView ok');

  const outCh = vscode.window.createOutputChannel('Vivado Project Explorer');
  const svLanguageService = new SystemVerilogLanguageService(vscode, { output: outCh });
  context.subscriptions.push(session.subscribe(state=>{
    if(!state){provider.setData(null);provider.proj=null;provider.treeProjection=null;svLanguageService.setProject(null);return;}
    const {proj,graph,hierarchy,treeProjection}=state;
    provider.proj=proj;provider.treeProjection=treeProjection;svLanguageService.setProject(proj,graph.compilationContext);
    provider.setData(hierarchy,{srcFiles:proj.srcFiles,simFiles:proj.simFiles,xdcFiles:proj.xdcFiles,ipFiles:proj.ipFiles,simTop:proj.simTop,designTop:proj.designTop},graph);
  }));
  context.subscriptions.push({ dispose: () => svLanguageService.dispose() });
  context.subscriptions.push(...createSvLanguageProviders(vscode, svLanguageService));
  if (typeof vscode.workspace.onDidOpenTextDocument === 'function')
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => svLanguageService.schedule(document)));
  if (typeof vscode.workspace.onDidChangeTextDocument === 'function')
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => svLanguageService.schedule(event.document)));
  if (typeof vscode.workspace.onDidCloseTextDocument === 'function')
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => svLanguageService.close(document)));
  if (typeof vscode.workspace.onDidSaveTextDocument === 'function')
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (svLanguageService.shouldLintVendorOnSave(document))
        void svLanguageService.runVendorLint(document).catch(error => outCh.appendLine('[vendor-lint] ' + error.message));
    }));
  if (typeof vscode.workspace.onDidChangeConfiguration === 'function')
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event || typeof event.affectsConfiguration !== 'function' || event.affectsConfiguration('airtl.systemverilog'))
        svLanguageService.onConfigurationChanged();
    }));
  for (const document of vscode.workspace.textDocuments || []) svLanguageService.schedule(document);
  const cfg = () => vscode.workspace.getConfiguration('vivadoProjectExplorer');
  outCh.appendLine('[dbg] 源码树 扩展已激活');

  // ── 授权装载 ──
  // 判定在 C++（Airtl/src/license/），这里只做 I/O：决定授权源、灌给原生。
  // 【为什么放在 activate 最早】graphLoad 起有门禁，没装载则树视图和 BD 面板
  // 全都打不开。激活时装载一次，之后每次开工程由 graphLoad 内部重新鉴权。
  // 【失败不抛】装载失败是正常状态之一，抛异常会让扩展整个起不来。
  // 统一文案弹给用户；真实原因只进输出通道（暴露给 UI = 给攻击者探测 oracle）。
  // 【source 字段】'file' = 用户放了正式 key；'default' = 没放，走了内置授权
  // （到期 2027-01-01）。排查"为什么这台机器行为不一样"时先看这一行。
  const licenseReady=(async()=>{try {
    const lic = require('./ui_design/license');
    const lr = await (lic.loadAsync?lic.loadAsync():lic.load());
    outCh.appendLine('[license] machineId=' + lr.machineId + '  loaded=' + lr.loaded
      + '  source=' + (lr.source || '(无)')
      + (lr.ok ? '' : '  原因=' + lr.reason));
    if (!lr.ok) {
      vscode.window.showWarningMessage(
        t('未验证授权，请检查网络连接后再试。机器码：', 'License validation failed. Check your network and retry. Machine ID: ') + lr.machineId);
    }
  } catch (e) {
    outCh.appendLine('[license] 装载异常: ' + e.message);
  }})();
  boot('outputChannel ok');

  // 撤销“双击行”附带的原生折叠/展开（双击只跳源码，不折叠/展开）：
  //   - 第一击就先置 suppressToggle（抢在 VSCode 原生展开/折叠事件之前——该事件可能
  //     发生在第二击 command 之前，仅靠双击判定后置位会漏）；
  //   - 原生 expand/collapse 事件命中 suppressToggle 时，撤销必须走【全量 refresh()】：
  //     实测只有全量刷新会按 Collapsed/Expanded 重建被误开合的节点（局部刷新父节点时
  //     VSCode 会保留已存在子节点的展开状态，无效）；
  //   - 闪烁消除：getChildren 按 key 缓存 ModuleNode 对象引用，普通节点复用同一引用
  //     （VSCode 按引用 diff 不重绘），仅被撤销的节点 forceFreshKey 强制新建对象；
  //   - list.collapse 作为提前量：焦点仍在树上时直接折叠（不触发刷新），失效也无妨。
  // 用户点 chevron 的正常展开/折叠不受影响，且状态记入 provider.expanded，刷新后保持。
  let suppressToggle = null;
  const clearSuppress = () => { suppressToggle = null; };
  const revertToggle = (k) => {
    provider.forceFreshKey = k;
    vscode.commands.executeCommand('list.collapse').then(undefined, () => {});
    provider.refresh();
  };
  treeView.onDidExpandElement(e => {
    const k = e.element && e.element.cell ? nodeKeyOf(e.element.cell) : null;
    if (suppressToggle && suppressToggle === k) { suppressToggle = null; revertToggle(k); }
    else if (k) provider.expanded.add(k);
  }, null, context.subscriptions);
  treeView.onDidCollapseElement(e => {
    const k = e.element && e.element.cell ? nodeKeyOf(e.element.cell) : null;
    if (suppressToggle && suppressToggle === k) { suppressToggle = null; revertToggle(k); }
    else if (k) provider.expanded.delete(k);
  }, null, context.subscriptions);

  // 纯磁盘模式（不依赖 Vivado）：平时刷新只调用 rtlparser 重解析磁盘当前源文件（54ms 级）；
  // 仅当“工程文件清单”确实需要更新时才重读 .xpr + 遍历 sources_1：
  //   - 显式强制 reloadProject（命令「重新读取工程」）
  //   - 首次加载（无缓存）
  //   - .xpr 路径变了 / .xpr 修改时间变了（在 Vivado 里增删文件、改顶层会改 mtime）
  // 层次树本身永远由 rtlparser 解析 RTL 文本，Vivado 不参与。
  let refreshGeneration = 0;
  function doRefresh(opts){return airtl.withRequestBudget(()=>doRefreshRequest(opts));}
  async function doRefreshRequest(opts) {
    opts = opts || {};
    // An explicit load includes the latest saved bytes and supersedes any
    // save batch which has not started. It must not be interrupted by that
    // old timer halfway through preparing its candidate.
    if(!opts.savedFiles)saveUpdates.cancelPending();
    const token = opts.token || session.begin();
    const generation = ++refreshGeneration;
    const assertCurrent = () => {
      if (generation !== refreshGeneration || !session.valid(token)) throw Object.assign(new Error('Project request superseded'), { code: 'AIRTL_REQUEST_SUPERSEDED' });
    };
    try {
    await licenseReady;
    assertCurrent();
    gp.cancelSceneRequests(provider.graph);
    const roots = workspaceRoots();
    if (!roots.length) {
      await session.clear(token);assertCurrent();
      provider.setData(null);
      provider.proj = null;
      svLanguageService.setProject(null);
      await vscode.commands.executeCommand('vivadoBD.refresh');
      vscode.window.showWarningMessage(t('未打开工作区文件夹，无法解析工程。', 'No workspace folder is open. Cannot load the project.'));
      return;
    }
    // 1) 先三模式全扫，把结果挂到顶部「工程来源」节点（用户在此选显示哪一类，纯界面操作）
    const all = opts.savedFiles ? sourceProvider.sources : await scanAllSources();
    assertCurrent();
    // 2) 确定当前来源：显式传入 > 来源树未发布的新选择 > 磁盘缓存 / 内存已发布来源
    const publishedSrc = session.read()?.source;
    const publishedKey = publishedSrc ? publishedSrc.mode + ':' + publishedSrc.path : null;
    const uiSrc = sourceProvider.currentSource;
    const uiKey = uiSrc ? uiSrc.mode + ':' + uiSrc.path : null;
    const uiPending = uiSrc && (!publishedKey || uiKey !== publishedKey);

    let src = opts.src;
    if (!src) {
      if (opts.savedFiles) {
        src = publishedSrc || uiSrc;
      } else if (uiPending) {
        // 来源树已有新选择但尚未 publish：优先保留新选择，严防被未更新的旧磁盘缓存覆盖
        src = uiSrc;
      } else {
        // 无待发布的未提交选择：从磁盘读取当前工作区缓存
        src = await ps.resolveCachedAnyAsync(roots);
      }
    }
    assertCurrent();
    if (!src) {
      sourceProvider.setSources(all, null);
      await session.clear(token);assertCurrent();
      provider.setData(null);
      provider.proj = null;
      svLanguageService.setProject(null);
      await vscode.commands.executeCommand('vivadoBD.refresh');
      provider.refresh();
      return;
    }
    sourceProvider.setSources(all, src);
    const switching = session.read() && session.read().proj.srcKey !== src.mode+':'+src.path;
    if(switching){await session.clear(token);assertCurrent();provider.setData(null);provider.proj=null;svLanguageService.setProject(null);}
    await session.readyForLoad();assertCurrent();
    // 3) 判断是否需要重读磁盘工程清单（来源文件变了 / mtime 变了 / 强制重载）
    const srcKey = src.mode + ':' + src.path;
    let srcMtime = 0;
    try { srcMtime = (await airtl.diskIoAsync('stat-project',src.path,()=>fs.promises.stat(src.path))).mtimeMs; }
    catch (e) {if(e.code==='AIRTL_IO_TIMEOUT')throw e;}
    assertCurrent();
    let needReload = opts.reloadProject || !provider.proj
      || provider.proj.srcKey !== srcKey || provider.proj.srcMtime !== srcMtime;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: needReload ? t('读取工程（' + modeLabel(src.mode) + ' + 磁盘）...', 'Loading project (' + modeLabel(src.mode) + ' + disk)...') : t('解析模块层次树...', 'Parsing module hierarchy...') },
      async () => {
        let pendingGraph = null;
        try {
          let proj = provider.proj;
          if (needReload) {
            // 纯磁盘模式：按来源（xpr / tcl / 源文件）读取工程清单，完全不调用 Vivado
            proj = await ps.loadProjectAsync(src, roots);
            assertCurrent();
            proj.srcKey = srcKey;
            proj.srcMtime = srcMtime;
            proj.mode = src.mode;
            proj.xpr = src.path;   // 兼容字段：下游/调试统一按「来源文件」看待
          }

          outCh.appendLine(`[ok] source=${src.mode} path=${src.path}`);
          outCh.appendLine(`[ok] project=${proj.name} part=${proj.part} top=${proj.top}`
            + (needReload ? ' (已从磁盘读取工程)' : ' (复用缓存，仅重解析源文件)'));
          outCh.appendLine(`     SRC=${proj.srcFiles.length}  SIM=${proj.simFiles.length}  XDC=${proj.xdcFiles.length}  IP-HDL=${proj.ipFiles.length}`);
          // 记录当前工程来源到工作区缓存（不存全局）

          // 2) 建长驻 C++ handle，层次树从它展开（每次都跑，读当前磁盘内容）。
          // 【为什么不是 JS 侧 buildModuleDefs】那会是第二套实现——generate-for
          // 在 C++ 侧展开成 N 个实例、JS 侧只提 1 个，两个视图的树会不一致。
          // 合并后一套实现，树视图与 BD 面板看到同一棵树。
          boot('doRefresh: loadProject 完成');
          const designContext = analysisContext.forProject(proj, 'synthesis');
          const hdl = analysisContext.projectFiles(proj, 'synthesis');
          // The design hierarchy and the Slang frontend must use the same
          // selected root. Vivado can report a simulation top separately;
          // designTop is the root represented by this tree and BD view.
          const configuredTop = proj.designTop || proj.top || '';
          let top = configuredTop;
          // Retain the old view until its replacement is ready; setData releases it.
          const svFiles = designContext.files;
          const graphOptions = {
            forceReparse:!!opts.savedFiles,
            checkpoint: context.globalStorageUri?.fsPath ? {
              directory:path.join(context.globalStorageUri.fsPath,'design-checkpoints'),
              identity:JSON.stringify([srcKey,(vscode.workspace.workspaceFolders||[]).map(w=>w.uri.toString())]),
            }:undefined,
            bdFiles: proj.bdFiles || [],
            topModule: configuredTop,
            svFiles,
            includeDirs: proj.includeDirs || [],
            defines: proj.defines || [],
            fileSetContexts: proj.fileSets || [],
            parameters: proj.parameters || [],
            fileRecords: require('./sourceLoadPolicy').applyImplementationRequests(proj.fileRecords,
              vscode.workspace.getConfiguration('vivadoProjectExplorer').get('generatedIpImplementationFiles', []),
              path.dirname(proj.xpr || proj.sourceFile || (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || process.cwd())),
          };
          let graph = pendingGraph = await gp.loadGraphAsync(hdl, graphOptions); assertCurrent();
          boot('doRefresh: graphLoad 完成');
          // 【BD 补充已删】原先这里用 bddefs.loadBdModuleDefs 把 BD 内部 components
          // 塞进 JS 的 moduleDefs（因为 JS 轻量路径下 system 没有 .v 文件）。
          // graphLoad 的文件清单已含 BD 生成 HDL（getProjectFromDisk 的 genRoots
          // 扫描把它们放进 ipFiles），system 直接解析出 28 个例化——
          // 实测与 bddefs 提供的 28 个 instances 一致，补充是多余的。
          let hier = await gp.hierarchyFor(graph, top); assertCurrent();
          // top 为空或顶层模块在源码里未定义 -> 用候选顶层兜底（优先用户源，排除 IP example_design 顶层）
          if (!top || !hier.root || !['module', 'blackbox', 'encrypted'].includes(hier.root.kind)) {
            const cands = hier.topCandidates || [];
            const picked = await airtl.pickTopLevelFromCandsAsync(cands); assertCurrent();
            if (picked) {
              top = picked.name;
              // A graph loaded without a configured root has no Slang
              // hierarchy snapshot. Rebuild only this exceptional inferred-
              // top case so the production SV tree is still compiler-backed.
              if (svFiles.length && top !== graphOptions.topModule) {
                const inferredGraph = await gp.loadGraphAsync(hdl, { ...graphOptions, topModule: top });
                const previousGraph = graph;
                graph = pendingGraph = inferredGraph;
                gp.freeGraph(previousGraph);
                assertCurrent();
              }
              hier = await gp.hierarchyFor(graph, top); assertCurrent();
              outCh.appendLine(`[info] 工程未给出顶层，自动推断顶层 = ${top}（来源 ${picked.file}）`);
            }
          }
          if (svFiles.length && hier.hierarchySource !== 'slang') {
            const elaboration = await gp.native().graphSlangElaborationAsync(graph.handle); assertCurrent();
            const detail = elaboration && (elaboration.diagnostics || elaboration.failure)
              || hier.hierarchyDiagnostic || 'Slang did not return a usable hierarchy snapshot';
            throw new Error(`Slang 未能为顶层 ${top || '(未确定)'} 提供可用的展开层次；保留上次成功的工程视图。\n${detail}`);
          }
          if (hier.hierarchySource === 'slang') {
            outCh.appendLine('[info] 层次实例来自 Slang elaboration（含参数与选中的 generate 分支）');
            for(const conflict of hier.boundaryConflicts || [])outCh.appendLine(`[warning] IP 边界定义冲突 ${conflict.module}；保留未解析节点，候选：${conflict.candidates.join(', ')}`);
            for(const failure of hier.boundaryFailures || [])outCh.appendLine(`[warning] IP 边界提取失败：${failure}`);
            if(hier.sourceLoadStats)outCh.appendLine(`[info] source loading ${JSON.stringify(hier.sourceLoadStats)}`);
          } else if (hier.hierarchyDiagnostic) {
            // VHDL-only projects keep their existing frontend and are not
            // required to have a Slang hierarchy snapshot.
            outCh.appendLine(`[warning] Slang elaboration unavailable: ${hier.hierarchyDiagnostic}`);
          }
          boot('doRefresh: hierarchy 完成');
          const treeProjection = await require('./treeProjection').prepare(graph,proj,hier,assertCurrent);
          assertCurrent();

          // 联动刷新 BD 树：Vivado 树数据更新后，BD 树（vivadoBDTree）必须同步刷新，
          // 否则打开新 Vivado 树时 BD 树还是旧数据/占位（用户反馈 BUG）。
          await session.publish(token,{proj,graph,hierarchy:hier,treeProjection,source:src,
            onCheckpoint:result=>outCh.appendLine('[checkpoint] '+JSON.stringify(result))},opts.savedFiles?'save':'load');
          pendingGraph = null;
          assertCurrent();
          await ps.saveCacheAsync(roots[0], src,()=>session.valid(token));

          outCh.appendLine(`     解析到 module 定义 ${hier.moduleNames.length} 个`);
          const countNodes = (n) => 1 + (n.children ? n.children.reduce((s, cc) => s + countNodes(cc), 0) : 0);
          outCh.appendLine(`     层次树节点数 ${countNodes(hier.root)}`);
          // 未找到可读定义的 module 提示（排除预期的原语：全大写器件原语）
          const missing = [];
          (function walk(n) {
            if (n.kind === 'undefined') missing.push(n.module);
            (n.children || []).forEach(walk);
          })(hier.root);
          if (missing.length) outCh.appendLine(`     [提示] 以下模块未找到可读定义：${missing.slice(0, 20).join(', ')}`);
        } catch (e) {
          if (pendingGraph && session.read()?.graph!==pendingGraph) gp.freeGraph(pendingGraph);
          if (e.code === 'AIRTL_REQUEST_SUPERSEDED' || generation !== refreshGeneration) return;
          provider.setError(e.message);
          outCh.appendLine('[error] ' + e.message);
          vscode.window.showErrorMessage(t('读取失败，详见 Output: Vivado Project Explorer。', 'Project loading failed. See Output: Vivado Project Explorer.'));
        }
      }
    );
    } catch(error) {
      if(error.code!=='AIRTL_REQUEST_SUPERSEDED')throw error;
    } finally {session.finish(token);}
  }

  context.subscriptions.push(vscode.commands.registerCommand('vivadoProjectExplorer.refresh', async () => {
    if(!session.read())await session.readReady();provider.refresh();await vscode.commands.executeCommand('vivadoBD.refresh');
  }));
  const {SavedUpdates}=require('./savedUpdates');
  const saveUpdates=new SavedUpdates(session.read,(files,state,options)=>doRefresh({savedFiles:files,src:state.source,reloadProject:options.reloadProject}),
    error=>outCh.appendLine('[saved-update] '+error.message));
  context.subscriptions.push(saveUpdates);
  context.subscriptions.push(vscode.commands.registerCommand('vivadoProjectExplorer.updateSaved',files=>saveUpdates.submit(files||[],true)));
  const pathKey=require('./treeProjection').pathKey;
  function savedFile(file){
    const state=session.read();if(!state||!file)return;
    const configuration=[...(state.source.mode==='source'?[]:[state.source.path]),...(state.proj.bdFiles||[]).map(f=>f.path),...(state.proj.fileRecords||[]).filter(f=>/\.(?:xci|xcix)$/i.test(f.path||'')).map(f=>f.path)].filter(Boolean);
    if(configuration.some(p=>pathKey(p)===pathKey(file))){void saveUpdates.submit([file],false,{reloadProject:true}).catch(()=>{});return;}
    const dependencies=[...state.graph.paths,...(state.graph.dependencyFiles||[])];
    if(!dependencies.some(p=>pathKey(p)===pathKey(file)))return;
    void saveUpdates.submit([file]).catch(()=>{});
  }
  if(vscode.workspace.onDidSaveTextDocument)context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document=>savedFile(document?.uri?.fsPath)));
  if(vscode.workspace.onDidChangeConfiguration)context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{
    if(!event?.affectsConfiguration)return;
    if(['vivadoProjectExplorer.generatedIpImplementationFiles','vivadoProjectExplorer.vivadoPath','airtl.systemverilog.standard'].some(key=>event.affectsConfiguration(key))){
      const state=session.read();if(state)void saveUpdates.submit([state.source.path],false,{reloadProject:true}).catch(()=>{});
    }
  }));
  const diskWatchers=new Map();
  function clearDiskWatchers(){for(const watcher of diskWatchers.values())watcher.dispose();diskWatchers.clear();}
  context.subscriptions.push({dispose:clearDiskWatchers});
  context.subscriptions.push(session.subscribe(state=>{
    clearDiskWatchers();if(!state||!vscode.workspace.createFileSystemWatcher||!vscode.RelativePattern)return;
    const roots=workspaceRoots();
    const files=[...state.graph.paths,...(state.graph.dependencyFiles||[])];
    const directories=new Set(roots);
    for(const file of files)if(!roots.some(root=>pathKey(file).startsWith(pathKey(root)+'/')))directories.add(path.dirname(file));
    for(const directory of directories){
      const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory,'**/*'));
      const changed=uri=>savedFile(uri.fsPath);
      watcher.onDidChange(changed);watcher.onDidCreate(changed);watcher.onDidDelete(changed);diskWatchers.set(directory,watcher);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('airtl.systemverilog.lint', async document => {
    const target = document || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document);
    try {
      const result = await svLanguageService.runVendorLint(target);
      if (result === false) return;
      if (result && result.exitCode === 0 && result.diagnostics.length === 0)
        vscode.window.showInformationMessage(t('厂商检查完成，未发现诊断。', 'Vendor lint completed with no diagnostics.'));
    } catch (error) {
      outCh.appendLine('[vendor-lint] ' + error.message);
      vscode.window.showErrorMessage(t('厂商检查失败：', 'Vendor lint failed: ') + error.message);
    }
  }));
  // 当前工程来源解析（xpr / tcl / 源文件）——供 BD 面板等查询
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.resolveXpr', () => resolveProjectXpr()),
    vscode.commands.registerCommand('vivadoProjectExplorer.resolveProjectSource', () => resolveProjectSource())
  );
  // 「工程来源」节点里点选某个候选 → 切到该来源并重建树
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.useSource', async (arg) => {
      if (!arg) return;
      const roots = workspaceRoots();
      if (arg.browse) {   // source 类别兜底：浏览任意 HDL
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
          filters: { [t('HDL 源文件', 'HDL source files')]: ['v', 'sv', 'vhd', 'vhdl'] }, title: t('选择顶层源文件', 'Select top-level HDL source')
        });
        if (!uris || !uris[0]) return;
        arg = { mode: 'source', path: uris[0].fsPath };
      }
      if (!arg.mode || !arg.path) return;
      const token=session.begin();
      return doRefresh({ token, src: { mode: arg.mode, path: arg.path }, reloadProject: true });
    })
  );
  // 重新扫描来源列表（刷新顶部「工程来源」节点；不改变当前选择）
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.selectTreeSource', () => doRefresh())
  );
  // 强制重新读取工程（重读来源文件 + 磁盘文件清单）：切换工程/清单异常/想确保与磁盘同步时用。
  // 同步清空 rtlparser 的文件级解析缓存（mtime 失效之外的兜底，确保彻底重读磁盘）。
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.reloadProject', (arg) => {
      let src = null;
      if (arg && arg.mode && arg.path) {
        src = { mode: arg.mode, path: arg.path };
      } else if (arg && arg.source && arg.source.mode && arg.source.path) {
        src = arg.source;
      } else if (arg && arg.command?.arguments?.[0]?.path) {
        src = arg.command.arguments[0];
      } else {
        const selected = sourceTreeView?.selection?.[0];
        if (selected && selected.source) {
          src = selected.source;
        } else if (selected && selected.command?.arguments?.[0]?.path) {
          src = selected.command.arguments[0];
        }
      }
      return doRefresh({ src: src || undefined, reloadProject: true });
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.setProject', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        filters: { 'Vivado Project': ['xpr'] }, title: t('选择 Vivado 工程文件 (.xpr)', 'Select Vivado project file (.xpr)')
      });
      if (uris && uris[0]) {
        // 直接指定某个 .xpr（不经扫描）：写缓存并强制重读
        const roots = workspaceRoots();
        const src = { mode: 'xpr', path: uris[0].fsPath };
        return doRefresh({token:session.begin(),src,reloadProject:true});
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.copyPath', (node) => {
      if (node && node.resourceUri) vscode.env.clipboard.writeText(node.resourceUri.fsPath);
    })
  );

  // 跳转到树快照记录的准确源码位置，不切换到另一种导航目标。
  async function gotoDocLocation(file, line) {
    if (!file) {
      vscode.window.showInformationMessage(t('该节点无可读源码（原语/加密IP/黑盒），无法跳转。', 'This node has no readable source (primitive, encrypted IP, or black box).'));
      return false;
    }
    let stage = 'openTextDocument';
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      stage = 'showTextDocument';
      const editor = await vscode.window.showTextDocument(doc);
      stage = 'selectLocation';
      if (line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      return true;
    } catch (e) {
      const detail = `[source-navigation] ${stage} ${file}:${line}\n${e.stack || e.message || e}`;
      outCh.appendLine(detail); boot(detail);
      vscode.window.showErrorMessage(t('打开文件失败: ', 'Could not open file: ') + file + ':' + line + ' (' + stage + ': ' + e.message + ')');
      return false;
    }
  }

  async function resolveSimulationModuleSource(moduleName) {
    const files = provider.files && provider.files.simFiles || [];
    return svLanguageService.findModuleDefinition(moduleName, files, 'simulation');
  }
  async function openSimulationModuleSource(moduleName) {
    const location = await resolveSimulationModuleSource(moduleName);
    if (!location) {
      vscode.window.showInformationMessage(t('仿真源码中未找到模块定义：', 'Module definition not found in simulation sources: ') + moduleName);
      return false;
    }
    return gotoDocLocation(location.file, location.line);
  }

  // 单击：跳到“被例化的位置”（该实例在父模块里例化语句所在文件+行）；顶层退化跳自身定义
  function openInstance(node) {
    // VS Code context-menu commands receive the TreeItem wrapper, while the
    // item's default command passes the raw cell through its arguments.
    node = node && node.cell ? node.cell : node;
    const file = node.instanceFile || node.file;
    const line = node.instanceFile ? node.instanceLine : node.line;
    if (file) return gotoDocLocation(file, line);
    return resolveSimulationModuleSource(node.module).then(location => location
      ? gotoDocLocation(location.file, location.line)
      : gotoDocLocation('', 0));
  }
  // 双击 / 右键：跳到“module 源码定义位置”
  function openDefinition(node) {
    // Context-menu invocation passes ModuleNode; item.command passes its cell.
    node = node && node.cell ? node.cell : node;
    if (node.file) return gotoDocLocation(node.file, node.line);
    return resolveSimulationModuleSource(node.module).then(location => location
      ? gotoDocLocation(location.file, location.line)
      : gotoDocLocation('', 0));
  }

  // VSCode 无原生双击事件，用 time-based 区分：同一节点 350ms 内两次点击判定为双击。
  const DBL_MS = 350;
  let lastClick = { key: null, time: 0 };
  async function onOpenInstance(node) {
    if (!node) return;
    const key = nodeKeyOf(node);
    const now = Date.now();
    // Project Sources 单击只跳到例化源码；双击才打开定义源码和对应的 BD 作用域。
    if (lastClick.key === key && (now - lastClick.time) < DBL_MS) {
      // 双击：第二击立即跳源码定义位置（覆盖单击已跳的例化位置）
      lastClick.key = null;                       // 消费第二次点击
      suppressToggle = key;                       // 标记：随后原生折叠/展开需撤销
      setTimeout(clearSuppress, 500);             // 兜底，避免事件未到达时 flag 卡住
      await openDefinition(node);
      return vscode.commands.executeCommand('vivadoBD.openScopeBg', node);
    } else {
      // 单击：**立即跳例化位置**（不再等 DBL_MS——之前延时 350ms 导致点击反应慢）。
      // 双击判定仍靠 lastClick 时间戳：350ms 内第二击会走上面分支覆盖为跳定义。
      // suppressToggle 立即置位，用于撤销“双击行”时 VSCode 原生附带的折叠/展开。
      lastClick = { key, time: now };
      suppressToggle = key;
      setTimeout(() => {
        if (lastClick.key === key) { lastClick.key = null; suppressToggle = null; }
      }, DBL_MS);
      return openInstance(node); // 立即执行，不等 350ms
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.openInstance', (node) => onOpenInstance(node))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.openDefinition', (node) => openDefinition(node))
  );
  context.subscriptions.push(vscode.commands.registerCommand(
    'vivadoProjectExplorer.openSimulationModuleSource', moduleName => openSimulationModuleSource(moduleName)));

  // 激活时：始终扫描一次（三模式全扫填充「工程来源」节点）；有缓存来源则直接加载，
  // 没有则不弹窗，等用户在上方「工程来源」节点里点选。
  boot('before doRefresh');
  const refreshDone = (async () => {
    try { await doRefresh(); }
    catch (e) { boot('doRefresh rejected: ' + (e && (e.stack || e.message) || e)); }
  })();
  boot('after doRefresh (async started)');

  // ── AI 联动（aiAdapter.js）：首次即带 --port 0 打开可见 OpenCode TUI，
  //    界面/API 共用一个进程 → 恢复工程历史 session → 后续注入进入该会话。
  //    【重试恢复】：activate 时 opencode 往往还没起来（官方 TUI 启动慢）——
  //    首次失败后后台轮询重试（最多 5 次 × 10s），起来后自动恢复会话。 ──
  // ⚠️ 【必须让位于刷树】树是用户打开 VSCode 后第一眼要看到的东西，而 AI 初始化内部有
  //    最长 20s 的「等本窗口 opencode 就绪」轮询（每 500ms 一次 findOwnWindowServer，
  //    每次都要 spawn tasklist + netstat 子进程）——与树刷新抢同一个事件循环，
  //    会把刷树拖慢数秒（实测 ensureServer 单次就要 21s）。故：① 链在 doRefresh 之后；
  //    ② 再让出一个宏任务，保证树的重绘先拿到事件循环。
  // 【总开关】ai.enabled 默认 true；关掉则完全不自动初始化 AI（不拉起任何工具）
  const aiCfg = () => { try { return vscode.workspace.getConfiguration('vivadoProjectExplorer'); } catch (e) { return null; } };
  const aiEnabled = (() => { const c = aiCfg(); const v = c && c.get('ai.enabled'); return v === undefined ? true : !!v; })();
  const aiTool = (() => { const c = aiCfg(); const v = c && c.get('ai.tool'); return v || 'opencode'; })();
  boot('ai enabled=' + aiEnabled + ' tool=' + aiTool);
  if (!aiEnabled) { boot('ai 联动已在配置中关闭，跳过自动初始化'); }
  // 【只有 opencode 需要激活时初始化】下面这套是"把 opencode TUI 切回该工程的历史会话"，
  // 依赖运行中的 opencode server + TUI 在前台。dsh/zcode/generic 也没有常驻 UI 可切。
  // （曾经的 claude 是一次性 `claude -p`，同样没有；该适配器已停用，见
  //  ui_design/adapters/builtin.js 顶部。）以前没判工具，非 opencode 模式下也会去拉
  //  opencode，白等 5×10s 还弹一个"启动失败"警告。
  else if (aiTool !== 'opencode') {
    boot('工具=' + aiTool + ' 无需激活时初始化（仅 opencode 需要切回 TUI 会话），跳过');
  }
  else {
  boot('before require aiAdapter');
  const ai = require('./aiAdapter');
  boot('after require aiAdapter');
  const aiOut = outCh;   // 复用输出通道
  refreshDone.then(() => new Promise(r => setTimeout(r, 0))).then(async () => {
    const root = workspaceRoot();
    if (!root) return;   // 无工作区不拉起
    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const sess = await ai.getCurrentSession(root, null, vscode);
        // 窗口级定向信息：scoped=true = 已锁定【本窗口】的 opencode server（多窗口下不会串到别的窗口）
        const where = sess.ok
          ? `（${sess.scoped ? '本窗口 server :' + sess.port : '全局 server :' + sess.port + '（未识别到本窗口终端，多窗口时可能串台）'}）`
          : '';
        if (sess.ok) {
          if (sess.isNew) {
            // 无历史会话 → 新建（合理结果，直接返回）
            const note = '新创建';
            aiOut.appendLine(`[ai] opencode 就绪，${note} ${sess.sessionId}${sess.title ? '「' + sess.title + '」' : ''}${attempt > 1 ? '（第' + attempt + '次重试）' : ''}${where}`);
            vscode.window.setStatusBarMessage('$(check) Vivado AI: ' + note, 8000);
            return;
          }
          if (sess.resumed) {
            // 命中历史会话且 TUI 已切回 → 真正恢复成功
            const note = '已恢复上次会话';
            aiOut.appendLine(`[ai] opencode 就绪，${note} ${sess.sessionId}${sess.title ? '「' + sess.title + '」' : ''}${attempt > 1 ? '（第' + attempt + '次重试）' : ''}${where}`);
            vscode.window.setStatusBarMessage('$(check) Vivado AI: ' + note, 8000);
            return;
          }
          // ok 但 !resumed && !isNew：找到会话但 TUI 切回失败（select-session 未生效，
          // 常见于 TUI 尚未就绪）——当作可重试错误，不误报"已恢复"，继续轮询。
          lastErr = '找到会话 ' + (sess.sessionId || '').slice(0, 12) + ' 但 TUI 切回失败: ' + (sess.selectErr || '未知');
        } else {
          lastErr = sess.error;
          // permanent = 重试也不会好（CLI 不存在这类）。立即停，别把 5×10s 耗在
          // 必然失败的事上——本机 opencode 被 workbuddy 升级 node 带走时，白等过 150s。
          if (sess.permanent) {
            aiOut.appendLine('[ai] ' + lastErr);
            vscode.window.showWarningMessage(t('Vivado AI 联动不可用: ', 'Vivado AI integration is unavailable: ') + lastErr);
            return;
          }
        }
      } catch (e) {
        lastErr = e.message;
        if (e && e.permanent) {
          aiOut.appendLine('[ai] ' + lastErr);
          vscode.window.showWarningMessage(t('Vivado AI 联动不可用: ', 'Vivado AI integration is unavailable: ') + lastErr);
          return;
        }
      }
      aiOut.appendLine(`[ai] 第${attempt}次未就绪（${lastErr}），10s 后重试…`);
      if (attempt < 5) await new Promise(r => setTimeout(r, 10000));
    }
    aiOut.appendLine('[ai] opencode 启动失败（重试 5 次耗尽）: ' + lastErr);
    vscode.window.showWarningMessage(t('Vivado AI 联动启动失败: ', 'Could not start Vivado AI integration: ') + lastErr + ' ' + t('（可稍后右键"测试注入"重试）', '(right-click and choose Test AI connection to retry)'));
  });
  }   // end if(aiEnabled)
  // 命令：手动注入一条消息到当前会话（供测试/调试）
  context.subscriptions.push(
    vscode.commands.registerCommand('vivadoProjectExplorer.aiInject', async () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showInformationMessage(t('无工作区', 'No workspace')); return; }
      const msg = await vscode.window.showInputBox({ prompt: t('注入消息到 opencode 当前会话', 'Send a message to the current OpenCode session') });
      if (!msg) return;
      try {
        const res = await ai.autoInject(root, msg, null, vscode);
        vscode.window.showInformationMessage(t('已注入到 ', 'Sent to ') + (res.isNew ? t('新会话', 'new session') : t('会话', 'session')) + ` ${res.sessionId.slice(0, 12)}…`);
      } catch (e) {
        vscode.window.showErrorMessage(t('注入失败: ', 'Message injection failed: ') + e.message);
      }
    })
  );

  // 图/渲染后端：打一行，出问题能一眼看出跑的哪条路（native 还是 js）。
  // 原生库加载失败时这里是唯一能看到"为什么慢了/为什么行为变了"的地方。
  try {
    const gp = require('./ui_design/graphProvider');
    const out = (outputChannels && outputChannels.bd) || null;
    const line = '[backend] ' + gp.describe()
      + (gp.nativeAvailable() ? '' : '  原生库加载失败: ' + gp.nativeError());
    if (out) out.appendLine(line);
    _BOOT(line);
  } catch (e) { /* 诊断日志不影响激活 */ }

  // 任务B（ui_design）：Block Design 视图入口（TASKS.md D0 最小挂钩）
  boot('before webviewProvider.activate');
  try {
    require('./ui_design/webviewProvider').activate(context);
    boot('after webviewProvider.activate');
  } catch (e) {
    boot('webviewProvider.activate THREW: ' + (e && (e.stack || e.message) || e));
    throw e;
  }

  // 出厂默认 → 全局配置目录 C:/userconfig/rtlassistant/：
  //   ref_skill/<技能>/          → skills/<技能>/          真实技能副本
  //   prompts/_base/system.md    → system.md               系统提示词副本（只能内联，不走技能机制）
  //   prompts/_base/flow.md      → flow.md                 流程共享约定副本
  //   prompts/<功能>/task.md     → tasks/<功能>.md         用户层任务句模板
  // 只补缺失 / 用户没动过才更新（清单判据），不覆盖用户在全局配置里的改动。
  // 全局配置目录是任务规划指定的唯一真实副本源；AI 工具的 skills 发现目录不读它，
  // 注入消息直接给 <目录>/skills/<名>/SKILL.md 绝对路径让 AI Read，不依赖自动发现。
  try {
    const defaults = require('./ui_design/extractSkills');
    const r = defaults.installDefaults();
    outCh.appendLine('[defaults] 出厂默认 → ' + require('./ui_design/globalConfig').CONFIG_DIR +
      '：新增(' + (r.synced.join(', ') || '无') + ') 更新(' + (r.updated.join(', ') || '无') +
      ') 用户改过保留(' + (r.skipped.join(', ') || '无') + ')' +
      (r.failed.length ? ' 失败(' + r.failed.join(', ') + ')' : ''));
  } catch (e) {
    outCh.appendLine('[defaults] 同步失败(非致命): ' + e.message);
  }
  boot('activate() end');
  if (process.env.AIRTL_TEST_MODE === '1')
    return { projectTree: provider, systemVerilog: svLanguageService };
}

function deactivate() {}

module.exports = { activate, deactivate };
