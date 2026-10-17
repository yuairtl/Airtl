// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';

// Runtime UI follows VS Code's display language. Chinese is selected for all
// zh-* locales; English is the fallback for every other locale.
const vscode = require('vscode');

function isChinese() {
  return /^zh(?:-|$)/i.test(String(vscode.env && vscode.env.language || ''));
}

function t(chinese, english) {
  return isChinese() ? chinese : (english || chinese);
}

const WEBVIEW_EN = {
  '返回': 'Back', '总线视图': 'Bus view',
  '总线视图：把 AXI / SV interface / SV struct 成员折成一根粗 pin + 一条粗线': 'Bus view: group AXI, SV interface, and SV struct members into a single pin and wire',
  '导出所选文件名': 'Export selected file names',
  '单击pin/连线/端口=高亮同名网络 · 点已连pin→点目标pin=改连线(Esc取消) · 双击块进下级 · 滚轮缩放 · 拖拽平移 · 右键=菜单': 'Click a pin, wire, or port to highlight its net · Click a connected pin, then a target pin to rewire (Esc cancels) · Double-click a block to open it · Scroll to zoom · Drag to pan · Right-click for actions',
  '跳转模块源文件（打开定义位置）': 'Open module source (definition)',
  '跳转到例化位置（打开例化处源码）': 'Go to instantiation (open source)',
  '测试注入（发测试消息到 AI 会话）': 'Test AI connection',
  '下载 IP 端口定义（AI 抓官网手册）': 'Fetch IP port definitions',
  '让 AI 讲解此模块（读源码 + 工程作用）': 'Explain this module with AI',
  '导出到仿真（AI 生成 testbench）': 'Export to simulation (generate testbench)',
  '取消选择': 'Clear selection',
  '就绪': 'Ready', '等待数据...': 'Waiting for data...',
  '已取消高亮': 'Highlight cleared', '尚未加载 Block Design': 'Block Design is not loaded',
  '该端口未连接': 'This port is not connected', '请先右键点击一个模块': 'Right-click a module first',
  '请先右键点击一个 IP 模块': 'Right-click an IP module first',
  '请先选择模块（单击/Ctrl 多选）': 'Select one or more modules first (click/Ctrl-click)',
  '正在发送测试消息到 AI 会话…': 'Sending a test message to the AI session…',
  '请先选择模块': 'Select modules first', '成员 / ': 'members / ', ' 成员 / ': ' members / ', ' 连通': ' connected',
  '连线中：源=': 'Wiring from source=', ' → 点击目标 pin（Esc 取消）': ' → click target pin (Esc cancels)',
  '高亮网络: ': 'Highlighted net: ', '定位失败：当前视图无实例块 ': 'Cannot locate instance in the current view: ',
  '定位: ': 'Located: ', '错误: ': 'Error: ', '渲染异常: ': 'Render error: ',
  '定位失败': 'Location failed', '跳转失败': 'Navigation failed',
  '模块源文件不可用': 'Module source is unavailable', '无法获取模块名': 'Could not determine the module name',
  '测试注入完成': 'Test injection completed',
  '未找到 IP 端口定义': 'IP port definitions were not found', 'AI 不可用': 'AI is unavailable',
  '请先选择 IP 模块': 'Select an IP module first',
  '该 pin 由常量 ': 'This pin is driven by constant ', ' 驱动（无网可高亮）': ' (no net to highlight)',
  '该 pin 未连接（悬空），只能作为连线终点': 'This pin is unconnected and can only be used as a wiring target',
  '是常量源（const），没有源码定义，也没有内部模块。': ' is a constant source (const) with no source definition or child modules.',
  '是常量源（const ': ' is a constant source (const ', '），没有源码文件': ') and has no source file',
  '该模块无可读源码（原语/加密IP/黑盒），无法跳转': 'This module has no readable source (primitive/encrypted IP/black box)',
  '跳转模块源码: ': 'Module source: ', '跳转例化位置: ': 'Instantiation: ',
  '正在交给 AI 讲解模块 ': 'Asking AI to explain module ', '悬停: ': 'Hover: ', '常量 ': 'Constant ',
  '（无对端）': ' (no peer)',
  '：': ': ',
  '  已勾选 ': '  selected: ',
  '在当前作用域里没有可定位的例化行（无例化语句 / 生成块 / 伪块），无法跳转例化位置。': 'No instantiation line is available in the current scope (no statement, generated block, or synthetic block).',
  '是顶层模块，没有被任何父模块例化，所以没有例化位置。': ' is a top-level module and has no parent instantiation location.',
  '是常量源（const），不是被例化的模块，所以没有例化位置。': ' is a constant source (const), not an instantiated module, so it has no instantiation location.',
  'Block Design 打开失败：': 'Could not open Block Design: ', '讲解模块异常: ': 'Module explanation error: ',
  '导出到仿真异常: ': 'Export to simulation error: ', '测试注入异常: ': 'Test injection error: ',
  '下载 IP 端口定义异常: ': 'IP port definition fetch error: ', '处理消息 ': 'Error handling message ',
  ' 异常: ': ': ', '该处无可读源码': 'No readable source at this location', '打开文件失败: ': 'Could not open file: ',
  '未勾选任何模块': 'No modules are selected', '已复制 ': 'Copied ', ' 个文件名到剪贴板': ' file names to the clipboard',
  '无当前作用域': 'No active scope', '失败：未提取到子图': 'Failed to extract the subgraph', '无工作区': 'No workspace',
  '已交给 AI 生成仿真方案（会话 ': 'Asked AI to generate a simulation plan (session ', '…）。骨架文件：': '…). Testbench skeleton: ',
  '[1/4] 失败：无工作区': '[1/4] Failed: no workspace', '测试注入失败: ': 'Test injection failed: ',
  '（详见 Output → Block Design [testInject] 日志）': '(see Output → Block Design [testInject] for details)', '回写失败：': 'Could not write changes: ',
  '未验证授权，请检查网络连接后再试。机器码：': 'License validation failed. Check your network and retry. Machine ID: ',
  'Vivado AI 联动不可用: ': 'Vivado AI integration is unavailable: ', 'Vivado AI 联动启动失败: ': 'Could not start Vivado AI integration: ',
  '（可稍后右键"测试注入"重试）': '(right-click and choose Test AI connection to retry)',
  '该块是常量源（const ': 'This block is a constant source (const ',
  '没有可定位的例化位置（本次视图未记录其例化来源）。': 'No instantiation location is available (this view did not record its origin).',
};
function webviewTranslations() {
  return isChinese() ? {} : WEBVIEW_EN;
}

module.exports = { isChinese, t, webviewTranslations };
