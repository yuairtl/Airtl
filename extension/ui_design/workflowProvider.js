// Author: Airtl yu
// Contact: yuairtl@outlook.com

'use strict';
// workflowProvider.js — 工作流任务视图（BD 设计树下方）
// 4 个流程：执行仿真 / 执行综合 / 执行实现 / 生成 Bit
// 架构（用户裁定）：【AI 才是主角，插件只负责注入对应的消息】。
//   点击流程 → 注入对应消息（含 ref_skill 技能位置 + Vivado 路径）到已恢复的 opencode 会话
//   → AI 自主执行（读技能 → 跑 Vivado → 汇报）→ 插件可查波形/汇报。
// 状态显示：待执行 / 执行中 / ✅已交给AI / ❌失败（树节点描述更新）

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { t } = require('../l10n');

// 流程定义
const FLOWS = [
  { id: 'simulate', label: t('① 执行仿真', '① Run Simulation'), icon: '$(play)', skill: 'simulation' },
  { id: 'synth', label: t('② 执行综合', '② Run Synthesis'), icon: '$(sync)', skill: 'synth' },
  { id: 'impl', label: t('③ 执行实现', '③ Run Implementation'), icon: '$(gear)', skill: 'impl' },
  { id: 'bit', label: t('④ 生成 Bit', '④ Generate Bitstream'), icon: '$(chip)', skill: 'bit' },
];

// 工作流节点
class WorkflowNode extends vscode.TreeItem {
  constructor(flow, state) {
    super(flow.label + (state.desc ? '  ' + state.desc : ''), vscode.TreeItemCollapsibleState.None);
    this.id = flow.id;
    this.flow = flow;
    this.state = state;
    this.contextValue = 'workflowItem';
    this.iconPath = new vscode.ThemeIcon(state.running ? 'sync~spin' : 'play');
    this.tooltip = flow.skill ? `${t('Skill', 'Skill')}: ref_skill/${flow.skill}` : '';
    // 单击节点即执行对应流程命令（不设 command 则点击无响应——这是"点了没反应"的根因）
    this.command = { command: 'vivadoWorkflow.' + flow.id, title: flow.label };
  }
}

class WorkflowProvider {
  constructor(getProjDir, aiAdapter) {
    this._bridge = require('./aiBridge');
    this._getProjDir = getProjDir;
    this._ai = aiAdapter;
    this._states = {};   // id → {running, desc, result}
    for (const f of FLOWS) this._states[f.id] = { running: false, desc: '', result: null };
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }
  refresh() { this._onDidChange.fire(); }
  // 工作流日志（Output → Workflow 通道，用户点击后每步可见——定位"没推送"断点）
  _log(m) {
    try {
      if (!WorkflowProvider._out) {
        WorkflowProvider._out = vscode.window.createOutputChannel('Vivado Workflow');
      }
      WorkflowProvider._out.appendLine(m);
    } catch (e) { /* 日志失败忽略 */ }
  }
  getTreeItem(node) { return node; }   // 节点本身即 TreeItem（VSCode 要求 dataProvider 实现）
  getChildren() { return FLOWS.map(f => new WorkflowNode(f, this._states[f.id])); }
  getParent() { return null; }
  stateOf(id) { return this._states[id]; }

  // 执行一个流程（调 AI）
  async run(flowId) {
    const flow = FLOWS.find(f => f.id === flowId);
    if (!flow) return;
    const st = this._states[flowId];
    if (st.running) return;   // 已在执行
    const step = (m) => { this._log('[workflow:' + flowId + '] ' + m); };
    const projDir = this._getProjDir();
    if (!projDir) { step('Failed: no project directory'); vscode.window.showErrorMessage(t('未找到工程目录', 'Project directory not found')); return; }
    step('开始，工程=' + projDir);
    const xpr = this._findXpr(projDir);
    if (!xpr) { step('Failed: no XPR'); vscode.window.showErrorMessage(t('未找到 .xpr 工程文件', 'No .xpr project file found')); return; }
    step('xpr=' + xpr);

    st.running = true; st.desc = t('执行中…', 'Running…');
    this.refresh();
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: flow.label + t('（AI 执行中…）', ' (AI running…)') }, async () => {
      try {
        // 找到 tb 文件（仿真流程）
        let tbFiles = [];
        if (flowId === 'simulate') { tbFiles = this._findTbFiles(projDir); step('tb 文件 ' + tbFiles.length + ' 个'); }
        // 综合/实现/bit 前：确保 xdc 存在（无 xdc 时从大工程 xdc 提取引脚生成）
        let xdc = '';
        if (flowId !== 'simulate') {
          xdc = this._ensureXdc(projDir);
          step('xdc ' + (xdc ? xdc : '(无，用注意提示)'));
        }
        const taskLines = [
          t('任务：', 'Task: ') + flow.label.replace(/^[①②③④]\s*/, ''),
          t('Vivado 工程文件：', 'Vivado project file: ') + xpr,
        ];
        if (flowId === 'simulate') {
          taskLines.push(tbFiles.length
            ? t('Testbench 文件：\n', 'Testbench files:\n') + tbFiles.map(f => '- ' + f).join('\n')
            : t('未发现 Testbench 文件，请从工程仿真源确认仿真顶层。', 'No testbench files found; determine the simulation top from the project simulation sources.'));
        }
        if (xdc) taskLines.push(t('约束文件：', 'Constraint file: ') + xdc);
        const task = taskLines.join('\n');
        const res = await this._bridge.inject(vscode, projDir, this._featureOf(flow), {
          task, timeoutMs: 0,
        });
        step(t('已发送到 ', 'Sent to ') + (res.tool || '?'));
        if (!res.ok) throw new Error(res.error || t('AI 注入失败', 'AI message injection failed'));
        step(t('Injection succeeded: tool=', 'Injection succeeded: tool=') + res.tool + ' session=' + res.sessionId +
             (res.resumed ? t('（已续接上次会话）', ' (resumed previous session)') : '') + (res.tuiSwitched ? ' tuiSwitched=true' : ''));
        // 注入成功即返回；AI 在会话里继续执行
        st.running = false;
        st.desc = t('✅ 已交给 AI', '✅ Sent to AI');
        st.result = { sessionId: res.sessionId, modelID: res.modelID, reply: res.reply };
        // 仿真流程后尝试找波形（AI 可能已生成）
        if (flowId === 'simulate') this._wavePath = this._findWaveform(projDir);
      } catch (e) {
        st.running = false; st.desc = t('❌ 失败', '❌ Failed');
        step(t('失败: ', 'Failed: ') + e.message);
        st.result = { error: e.message };
        vscode.window.showErrorMessage(flow.label + t('失败: ', ' failed: ') + e.message);
      }
      this.refresh();
    });
  }

  // 右键 BD 块 → AI 从官网抓取该 IP 端口手册并写入端口方向数据（工作流注入，同 simulation/synth）
  async fetchIpPorts(ipType) {
    if (!ipType) { vscode.window.showErrorMessage(t('无 IP 类型名', 'IP type is missing')); return; }
    // 规范化 IP 名直接走原生（Airtl 绑定 normalizeIpName）。
    // 【为什么不再 require ipPortData】ipPortData.js（10.4 KB）里的查找算法
    // 早已在 C++（lookupPortDir / lookupPortWidth / ipKeyCandidates / …），
    // 它的其余消费者只有 blockgraph.js（不随包发布）。出包产品里只剩这一处
    // 调用，直接调原生即可，省掉整个文件。
    const airtl = require(path.join(__dirname, '..', 'Airtl', 'index.js'));
    const norm = airtl.normalizeIpName(ipType);
    const projDir = this._getProjDir();
    if (!projDir) { vscode.window.showErrorMessage(t('未找到工程目录', 'Project directory not found')); return; }
    const gc = require('./globalConfig');
    // 选写入目标：全局配置 / 项目配置（工程级优先于全局级）
    const picked = await vscode.window.showQuickPick([
      { label: t('全局配置', 'Global settings'), desc: gc.getIpPortsPath(), value: 'global' },
      { label: t('项目配置', 'Project settings'), desc: path.join(projDir, '.vscode', 'vivado-ip-ports.json'), value: 'project' }
    ], { placeHolder: t('IP 端口方向数据写入哪里？', 'Where should IP port direction data be saved?') });
    if (!picked) return;
    const targetJson = picked.value === 'global'
      ? gc.getIpPortsPath()
      : path.join(projDir, '.vscode', 'vivado-ip-ports.json');
    // 下载/校验脚本绝对路径（随扩展安装，跨平台可用）
    const khubScript = path.join(__dirname, '..', 'ref_skill', 'xilinx-docs', 'scripts', 'khub_download.py');
    const verifyScript = path.join(__dirname, '..', 'ref_skill', 'amd-doc-pdf-download', 'references', 'verify_pdf.py');
    const coverageScript = path.join(__dirname, '..', 'ref_skill', 'ip-port-fetch', 'verify_ports_coverage.py');
    // 下载的 PDF 放到全局配置目录下的 ipdowns/ 子目录（与 ip-ports.json 同根，跨平台一致）
    const ipDownDir = gc.getIpDownloadsDir();
    try { fs.mkdirSync(ipDownDir, { recursive: true }); } catch (e) { }
    const tmpPdf = path.join(ipDownDir, norm + '_pg.pdf');
    try {
      const res = await this._bridge.inject(vscode, projDir, 'ip-port-fetch', {
        object: norm, objectRaw: ipType, branch: /^xpm_/i.test(norm) ? 'xpm' : 'catalog',
        khubScript, verifyScript, coverageScript, pdfPath: tmpPdf, targetJson,
      });
      if (!res.ok) throw new Error(res.error || t('AI 注入失败', 'AI message injection failed'));
      vscode.window.showInformationMessage(
        t('已交给 AI 抓取 ', 'AI is fetching ') + `${norm} ` + t('端口定义（会话 ', 'port definitions (session ') + `${res.sessionId.slice(0, 12)}…), ` + t('写入', 'saved to ') + (picked.value === 'global' ? t('全局配置', 'global settings') : t('项目配置', 'project settings'))
      );
    } catch (e) {
      vscode.window.showErrorMessage(t('下载 IP 端口定义失败: ', 'Failed to download IP port definitions: ') + e.message);
    }
  }

  // 统一规则：从【配置的 skill 文件】读取技能指令注入 AI 会话。
  // 读取顺序：① 全局 skills 目录（C:/userconfig/rtlassistant/skills/<name>/agent.md，
  //   由 extractSkills 在激活时从 ref_skill 同步、且不覆盖用户改动）；
  //          ② fallback 扩展自带的 ref_skill/<name>/agent.md。
  // 返回整篇 agent.md 文本（含 frontmatter），缺失则返回空串。

  // 右键 Hierarchy 树模块 → AI 读源码讲解该模块功能 + 在本工程的具体作用。
  // 与 fetchIpPorts 同走「统一规则」：读 module-explain 技能 → 拼 prompt → autoInject。
  async explainModule(moduleName, srcFile) {
    if (!moduleName) { vscode.window.showErrorMessage(t('无模块名', 'Module name is missing')); return; }
    const projDir = this._getProjDir();
    if (!projDir) { vscode.window.showErrorMessage(t('未找到工程目录', 'Project directory not found')); return; }
    try {
      const res = await this._bridge.inject(vscode, projDir, 'module-explain', {
        object: moduleName,
        srcFile: srcFile || t('(无本地可读源码，走详情文件的黑盒分支)', '(No local source; use the black-box branch)'),
      });
      if (!res.ok) throw new Error(res.error || t('AI 注入失败', 'AI message injection failed'));
      vscode.window.showInformationMessage(
        t('已交给 AI 讲解模块 ', 'AI is explaining module ') + `${moduleName} ` + t('(session ', '(session ') + `${res.sessionId.slice(0, 12)}…)`
      );
    } catch (e) {
      vscode.window.showErrorMessage(t('讲解模块失败: ', 'Module explanation failed: ') + e.message);
    }
  }

  // 右键 BD 块「导出到仿真」：把 tb 骨架位置 + 模块源码清单注入 AI，走 export-to-sim 技能。
  // 骨架由调用方（webviewProvider.exportToSim）落盘，本方法只负责注入——与其它 AI 入口同链路。
  // o: { projDir, stubPath, tbDir, simDir, srcList }
  async exportToSim(o) {
    const projDir = (o && o.projDir) || this._getProjDir();
    if (!projDir) { vscode.window.showErrorMessage(t('未找到工程目录', 'Project directory not found')); return { ok: false, error: t('无工程目录', 'No project directory') }; }
    if (!o || !o.stubPath) { vscode.window.showErrorMessage(t('无 tb 骨架路径', 'Testbench skeleton path is missing')); return { ok: false, error: t('无骨架路径', 'No skeleton path') }; }
    const step = m => this._log('[exportToSim] ' + m);
    const task = [
      t('任务：补全所选模块子图的仿真 testbench。', 'Task: complete the simulation testbench for the selected module subgraph.'),
      t('TB 骨架文件：', 'Testbench skeleton: ') + o.stubPath,
      o.tbDir ? t('Testbench 输出目录：', 'Testbench output directory: ') + o.tbDir : '',
      o.simDir ? t('仿真输出目录：', 'Simulation output directory: ') + o.simDir : '',
      o.srcList ? t('模块源码清单：\n', 'Module source files:\n') + o.srcList : '',
    ].filter(Boolean).join('\n');
    try {
      const res = await this._bridge.inject(vscode, projDir, 'export-to-sim', { task, timeoutMs: 0 });
      if (!res.ok) throw new Error(res.error || t('AI 注入失败', 'AI message injection failed'));
      step('注入成功: 工具=' + res.tool + ' 会话=' + res.sessionId);
      return res;
    } catch (e) {
      step('注入失败: ' + e.message);
      vscode.window.showErrorMessage(t('导出到仿真失败: ', 'Export to simulation failed: ') + e.message);
      return { ok: false, error: e.message };
    }
  }

  // AI 注入消息：按流程从【全局配置】取对应技能（agent.md）+ Vivado 路径（全局配置）
  // flow.skill（simulation/synth/impl/bit）→ prompts/ 下的功能目录名
  _featureOf(flow) {
    const m = { simulation: 'simulate', synth: 'synth', impl: 'impl', bit: 'bit' };
    return m[flow && flow.skill] || (flow && flow.skill) || 'simulate';
  }

  // 探测 Vivado 安装（常见路径）

  // 找工程 .xpr（先看根目录，再递归 2 层——工程可能在子目录如 prj/）
  _findXpr(dir) {
    const found = [];
    const walk = (d, depth) => {
      if (depth > 2) return;
      try {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) {
            if (/\.(cache|runs|ip_user_files|\.git|\.hw|\.sim|\.srcs)$/.test(f.name)) continue;
            walk(p, depth + 1);
          } else if (f.name.endsWith('.xpr')) found.push(p);
        }
      } catch (e) { }
    };
    walk(dir, 0);
    return found[0] || null;
  }

  // 确保工程有引脚约束（无 xdc 时从大工程 xdc 提取可用引脚生成）
  // 返回生成的 xdc 路径；已有 xdc 返回 null（不重复生成）
  _ensureXdc(projDir) {
    // 1. 工程已有 xdc？直接复用
    const existing = this._findXdc(projDir);
    if (existing) return null;
    // 2. 从大工程（上级目录的兄弟工程 / D:\AI\temp\project_vivado_DDC）xdc 提取引脚
    const bigProj = path.join(path.dirname(projDir), 'project_vivado_DDC');
    const pins = this._extractPinsFromBigXdc(bigProj);
    if (!pins || !pins.length) return null;
    // 3. 生成 led_blink.xdc：探测顶层端口名（clk/rst/led），用提取的引脚
    const portNames = this._probeTopPorts(projDir);
    if (!portNames.length) return null;
    // 分配：clk→第一个时钟引脚；rst_n→GPIO[0]；led[i]→GPIO[1..]
    const gpios = pins.filter(p => p.isGpio);
    const clks = pins.filter(p => p.isClk);
    if (!gpios.length && !clks.length) return null;
    const lines = ['# 引脚约束（自动从大工程 xdc 提取生成）'];
    let gpioIdx = 0;
    for (const port of portNames) {
      if (/clk/i.test(port) && clks.length) {
        lines.push(`set_property PACKAGE_PIN ${clks[0].pin} [get_ports ${port}]`);
        lines.push(`set_property IOSTANDARD LVCMOS18 [get_ports ${port}]`);
      } else if (/rst/i.test(port) && gpios.length) {
        lines.push(`set_property PACKAGE_PIN ${gpios[gpioIdx].pin} [get_ports ${port}]`);
        lines.push(`set_property IOSTANDARD LVCMOS18 [get_ports ${port}]`);
        gpioIdx++;
      } else if (/led/i.test(port)) {
        // led 可能是裸名（output reg [7:0] led）或 led[i]：裸名按 0..7 数组处理
        const m = port.match(/led\[(\d+)\]/);
        const isArray = m !== null;
        const count = isArray ? 1 : 8;   // 裸名默认 8 位
        for (let i = 0; i < count; i++) {
          const g = gpios[i];
          if (g) {
            lines.push(`set_property PACKAGE_PIN ${g.pin} [get_ports {led[${i}]}]`);
            lines.push(`set_property IOSTANDARD LVCMOS18 [get_ports {led[${i}]}]`);
          }
        }
      }
      // 其它端口跳过（无引脚）
    }
    if (lines.length <= 1) return null;
    // 时钟周期约束
    if (clks.length) lines.push('\ncreate_clock -period 10.000 -name sys_clk [get_ports clk]');
    // 通用命名（禁止名字假设）：xdc 名 = 顶层模块名（从 xpr/源码探测）+ 时间戳
    const base = (this._probeTopModuleName(projDir) || 'xc');
    const xdcOut = require('./naming').safeId(base) + '_auto_' + new Date().toISOString().replace(/[^\d]/g, '').slice(2, 14) + '.xdc';
    const xdcPath = path.join(projDir, xdcOut);
    fs.writeFileSync(xdcPath, lines.join('\n'));
    return xdcPath;
  }

  // 探测工程顶层模块名（从 xpr 或源文件首个 module 声明，零假设）
  _probeTopModuleName(projDir) {
    const xpr = this._findXpr(projDir);
    if (xpr) {
      try {
        const c = fs.readFileSync(xpr, 'utf8');
        const m = c.match(/TopModule\s+[Vv]al\s*=\s*"([^"]+)"/);
        if (m) return m[1];
        const m2 = c.match(/<Option Name="TopModule" Val="([^"]+)"\/>/);
        if (m2) return m2[1];
      } catch (e) { }
    }
    const ports = this._probeTopPorts(projDir);
    return ports && ports.length ? 'tb' : null;
  }

  // 找工程已有 xdc（constrs_1 或根目录）
  _findXdc(dir) {
    const found = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      try {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) {
            if (/\.(cache|runs|ip_user_files|\.git|\.hw|\.sim)$/.test(f.name)) continue;
            walk(p, depth + 1);
          } else if (f.name.endsWith('.xdc') && !/ooc|board/.test(f.name)) found.push(p);
        }
      } catch (e) { }
    };
    walk(dir, 0);
    return found[0] || null;
  }

  // 从大工程 xdc 提取可用引脚（GPIO / 时钟 / 其它通用 IO）
  _extractPinsFromBigXdc(bigProjDir) {
    const xdcs = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      try {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) {
            if (/\.(cache|runs|ip_user_files|\.git|\.hw|\.sim|\.gen|EXAMPLE)$/.test(f.name)) continue;
            walk(p, depth + 1);
          } else if (f.name.endsWith('.xdc') && !/ooc|board/.test(f.name)) xdcs.push(p);
        }
      } catch (e) { }
    };
    walk(bigProjDir, 0);
    const pins = [];
    const seen = new Set();
    for (const xdc of xdcs) {
      try {
        const content = fs.readFileSync(xdc, 'utf8');
        // set_property PACKAGE_PIN <pin> [get_ports {name}] 或 [get_ports name]
        const re = /set_property\s+PACKAGE_PIN\s+(\w+)\s+\[get_ports\s+\{?([^\]}]+?)\}?\]/g;
        let m;
        while ((m = re.exec(content))) {
          const pin = m[1], port = m[2].trim();
          if (seen.has(pin)) continue;
          seen.add(pin);
          pins.push({
            pin, port,
            isGpio: /gpio|led|key|sw/i.test(port) || /GPIO/i.test(port),
            isClk: /clk/i.test(port) && /_p$|_n$|_clk_p$/.test(port)
          });
        }
      } catch (e) { }
    }
    return pins;
  }

  // 探测工程顶层模块端口名（读顶层 .v 的 module 声明）
  _probeTopPorts(projDir) {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      try {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) {
            if (/\.(cache|runs|ip_user_files|\.git|\.hw|\.sim|\.srcs|\.gen)$/.test(f.name)) continue;
            walk(p, depth + 1);
          } else if (/\.(v|sv)$/.test(f.name) && !/tb|_tb/i.test(f.name)) {
            const content = fs.readFileSync(p, 'utf8');
            const m = content.match(/module\s+\w+\s*(?:#\s*\([^)]*\))?\s*\(\s*([\s\S]*?)\)\s*;/);
            if (m && m[1].includes('input') && m[1].includes('output')) {
              // 提取端口名
              const ports = m[1].match(/\b(input|output|inout)\b[^,;]*\b(\w+)\b/g);
              if (ports) {
                for (const pr of ports) {
                  const pm = pr.match(/\b(\w+)\s*$/);
                  if (pm && !out.includes(pm[1])) out.push(pm[1]);
                }
              }
            }
          }
        }
      } catch (e) { }
    };
    walk(projDir, 0);
    return out;
  }
  _findTbFiles(dir) {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 6) return;   // 限制深度防太慢
      try {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) {
            if (/\.(cache|runs|ip_user_files|\.git)$/.test(f.name)) continue;   // 跳过生成目录
            walk(p, depth + 1);
          } else if (/\.(v|sv)$/.test(f.name) && /tb/i.test(f.name) && !/\.cache/.test(p)) {
            out.push(p);
          }
        }
      } catch (e) { }
    };
    walk(dir, 0);
    return out.slice(0, 10);   // 最多 10 个
  }

  // 找波形文件（*.wdb / *.vcd，递归）
  _findWaveform(dir) {
    const found = [];
    const walk = (d, depth) => {
      if (depth > 6) return;
      try {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) {
            if (/\.(cache|runs|ip_user_files|\.git)$/.test(f.name)) continue;
            walk(p, depth + 1);
          } else if (/\.(wdb|vcd)$/.test(f.name)) found.push(p);
        }
      } catch (e) { }
    };
    walk(dir, 0);
    return found[0] || null;
  }
  getWavePath() { return this._wavePath; }
}

module.exports = { WorkflowProvider, FLOWS };
