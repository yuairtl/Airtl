// Author: Airtl yu

// Contact: yuairtl@outlook.com
'use strict';
// ui_design/license.js — 授权装载：把 license 灌给原生门禁
//
// 【为什么单独一个文件】鉴权的判定全在 C++（Airtl/src/license/），JS 只做两件
// I/O：决定用哪个授权源、把内容传给原生。判定放 JS 就等于没判定——攻击者删几行
// 就过，而且 airtl.node 仍能被直接 require 跑全部算法。
//
// 【两条授权源，正式 key 优先】
//   ① C:/userconfig/rtlassistant/license.key 存在 → 灌正式授权
//      （与 config.json、system.md、skills/ 同目录，全局配置集中放置是本项目
//       既有约定，见 globalConfig.js）
//   ② 不存在 → 调 airtl.licenseUseDefault()，由 C++ 给本机发一张内置授权
// 【为什么②是程序签发而不是内置一张通用 key】签名绑定机器码，每台机器都不同，
// 随插件带一张固定 key 只会在第一台机器上通过。由 C++ 用本机机器码现算，
// 每台机器都合法，且 JS 侧拿不到签发能力（_licenseMac 按设计不导出），
// 改不了到期时间。
// 【②不是"跳过鉴权"】默认授权照样走完整判定链：签名验、五源并发取时、
// 本地/网络日差查、过期拦。它只回答"授权从哪来"。到期 2027-01-01
// （Airtl/src/license/fetch.h 的 kDefaultExpiry）。
// 【接入正式签发体系时改哪】只删 load() 里的 else 分支。C++ 判定层、
// 四个门禁点、取时逻辑都不用动——这是当初留这个入口的目的。
//
// 【失败时说什么】门禁抛出的是统一文案「请检查网络连接后再试」（不暴露撞到哪条
// 规则，那是给攻击者的探测 oracle）。真实原因只写进输出通道，方便开发者排查。
const fs = require('fs');
const path = require('path');
const airtl = require(path.join(__dirname, '..', 'Airtl', 'index.js'));

const CONFIG_DIR = 'C:/userconfig/rtlassistant';
const LICENSE_PATH = path.join(CONFIG_DIR, 'license.key');

// 读文件并灌给原生。返回 { ok, loaded, reason, machineId, path, source }
//   ok     装载成功（签名+格式对）
//   loaded 原生侧确认收到
//   source 'file' = 读到了正式 key；'default' = 没有 key，走了内置默认授权
// 绝不抛异常——激活路径上抛异常会让扩展起不来，而"没 license"是正常状态之一。
function load(opts) {
  const out = { ok: false, loaded: false, reason: '', machineId: '',
                path: LICENSE_PATH, source: '' };
  try { out.machineId = airtl.licenseMachineId(); } catch (e) { /* 原生没加载上，下面会报 */ }

  let blob = '';
  let hasFile = false;
  try {
    hasFile = fs.existsSync(LICENSE_PATH);
    if (hasFile) blob = fs.readFileSync(LICENSE_PATH, 'utf8');
  } catch (e) {
    out.reason = 'license 文件读不了: ' + e.message;
    return out;
  }

  if (hasFile && blob.trim()) {
    // ── 正式授权（优先）────────────────────────────────────────────
    // 接口预留处：等签发体系就位，这条路就是唯一的路。
    try {
      out.loaded = !!airtl.licenseSetLicense(blob);
      if (!out.loaded) {
        // 原生侧解析失败：格式错 / 缺字段 / 签名不算。具体哪一项不告诉用户，
        // 只告诉开发者（licenseState 里有逐层原因，但装载失败时四层 reason 是空的，
        // 所以这里给一句通用的）。
        out.reason = 'license 内容不合法（格式或签名不符）';
        return out;
      }
      out.source = 'file';
      out.ok = true;
      return out;
    } catch (e) {
      out.reason = '灌给原生失败: ' + e.message;
      return out;
    }
  }

  // ── 没有正式 key → 当前版本的统一授权 ───────────────────────────
  // 【为什么发默认授权而不是报错】发行体系还没建，但产品得能装上就用。
  // 默认授权到期 2027-01-01，走的是同一条判定链（签名/五源取时/日差/过期
  // 全都照跑），所以它不是一个"跳过鉴权"的开关，只是一张普通的、由程序
  // 签发的授权。
  // 【到期了会怎样】2027-01-01 之后默认授权失效，用户看到统一文案
  // 「请检查网络连接后再试」——和没有 license 时一样，不泄露是哪条规则。
  try {
    out.loaded = !!airtl.licenseUseDefault();
    out.source = 'default';
    out.ok = out.loaded;
    if (!out.ok) out.reason = '内置默认授权签发失败';
    return out;
  } catch (e) {
    out.reason = '签发默认授权失败: ' + e.message;
    return out;
  }
}

// 四层当前结论（诊断用）。别把这个的结果直接弹给用户。
function state() {
  try { return airtl.licenseState(); } catch (e) { return null; }
}

// 供设置里展示/复制机器码（用户要把机器码发给发行方换 license）
function machineId() {
  try { return airtl.licenseMachineId(); } catch (e) { return ''; }
}

module.exports = { load, state, machineId, LICENSE_PATH };
