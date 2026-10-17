// Author: Airtl yu

// Contact: yuairtl@outlook.com
// rtlwriter.js — 回写引擎（薄转发层）
//
// 【这个文件是干什么的】顶替原来的实现。引擎本体已搬进 C++
// （Airtl 绑定 locatePortExpr / planRewire / applyEdits），
// 本文件只做 require 转发，不含任何字符串运算。
//
// 原理（DESIGN §9.4 修订，规则在 C++ 侧，此处仅备忘）：
// stripComments 等长替换 → 解析偏移即原文偏移。返回 edit 描述，
// 由上层转 WorkspaceEdit。
'use strict';

const path = require('path');
const airtl = require(path.join(__dirname, '..', 'Airtl', 'index.js'));

module.exports = {
  locatePortExpr: airtl.locatePortExpr,
  planRewire: airtl.planRewire,
  applyEdits: airtl.applyEdits,
  // 诊断用：确认跑的是原生而不是 JS 回退
  isNative: () => airtl.isNative(),
  nativeError: () => airtl.nativeError(),
};
