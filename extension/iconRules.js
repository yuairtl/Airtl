// Author: Airtl yu

// Contact: yuairtl@outlook.com
// iconRules.js — 模块图标规则（薄转发层）
//
// 【这个文件是干什么的】顶替原来的实现。规则本体已搬进 C++
// （Airtl 绑定 moduleIconId / moduleKindTag / isGeneratedHdlPath），
// 本文件只做 require 转发，不含任何规则逻辑。
// Vivado Hierarchy 树（extension.js）与 BD 设计树（webviewProvider.js）
// 共用它，保证同一个模块在两棵树里图标一致。
//
// 图标语义（VSCode codicon id，规则在 C++ 侧，此处仅备忘）：
//   verified      顶层（isRoot 且是该树的 TopModule）
//   lock          原语 / 加密IP / VHDL黑盒（无可读定义）
//   package       IP 生成的可读模块（路径含 /ip/，或 bd 的 synth|sim 生成物）
//   file-code     用户源码 · 有子模块
//   symbol-class  用户源码 · 叶子模块
'use strict';

const path = require('path');
// 本文件在【仓库根】，Airtl/ 是同级目录——不要写 '..'（会跳出工作区）。
// ui_design/ 下的文件（如 rtlwriter.js）才需要 '..'。
const airtl = require(path.join(__dirname, 'Airtl', 'index.js'));

module.exports = {
  moduleIconId: airtl.moduleIconId,
  isGeneratedHdlPath: airtl.isGeneratedHdlPath,
  moduleKindTag: airtl.moduleKindTag,
  // 诊断用：确认跑的是原生而不是 JS 回退
  isNative: () => airtl.isNative(),
  nativeError: () => airtl.nativeError(),
};
