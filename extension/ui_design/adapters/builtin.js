// Author: Airtl yu

// Contact: yuairtl@outlook.com
'use strict';
// adapters/builtin.js — 内置工具适配器：opencode
//
// 这里只做「包装 + 能力声明」，注入逻辑仍复用已验证的实现：
//   opencode → aiAdapter.js（HTTP API 注入运行中的 server）
// 不重写、不搬运——那 33 个适配器专项测试（_test_aiadapter*.js / _test_session_scope.js）
// 直接打这个模块，搬走就全废。
//
// 【dsh / zcode】不在这里硬编码。本机没装、接口未实测，猜着写等于造故障。
// 走 adapters/index.js 的 makeGenericCli：用户在 settings 配一条命令模板即可用，
// 接口摸清后再升级成内置适配器（照 opencode 的写法加一个对象即可）。
//
// 【Claude Code 已停用（2026-10-13）】曾经的 claude 适配器（ui_design/claudeAdapter.js，
// `claude -p` 无头模式）不再随插件交付，此处的注册块已删。三处连带改动：
//   · claudeAdapter.js 加进 .vscodeignore —— 不进发布包（文件留在开发树，
//     Airtl/test/diff-ai.js 与 _selftest.js 第 33 节仍以它为差分/单测基准）；
//   · aiBridge.js 的 PRIORITY 去掉 'claude'，另设 DISABLED 集合，
//     让"配了 ai.tool=claude"的用户得到准确提示，而不是"未知 AI 工具"；
//   · 报错文案里"把 ai.tool 改成 claude"的建议全部改掉——那是在推荐一个
//     已经不存在的工具。
// 【为什么是删注册而不是留一个 detect() 恒 false 的壳】壳会留在
// adapters.ids() 里，于是"可用工具: opencode, claude"这种谎话会出现在用户
// 看到的报错里。宁可不存在，也别冒充可用。

const reg = require('./index');

// ── opencode ──
const ai = require('../../aiAdapter');
reg.regist({
  id: 'opencode',
  label: 'opencode',
  caps: { systemPrompt: true, sessionResume: true },
  async detect(vscode) {
    this.availabilityError = '';
    this.apiReady = false;
    try {
      if (!vscode) return !!ai.findOpencodeCli();
      const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      // 保留 API 健康检查，并让激活与按钮点击共用初始化。原先只查全局端口：
      // 新版 TUI 不监听时直接拒绝，autoInject 根本没有机会恢复服务。
      this.apiReady = !!(await ai.ensureServer(root && root.uri.fsPath, vscode));
      return this.apiReady;
    } catch (e) {
      this.availabilityError = e.message;
      return false;
    }
  },
  async preflight() {
    // opencode 的认证在自己的配置里，没有等价于"API Key 占位符"的预检，
    // 这里只确认 CLI 路径解析得出来，具体连通性由 inject 内部处理。
    try {
      if (this.apiReady) return { ok: true };
      const cli = ai.findOpencodeCli && ai.findOpencodeCli();
      if (cli) return { ok: true };
      // 提示要说清找了哪、该怎么办。本机实例：opencode 原本装在 workbuddy 自带 node 的
      // 版本目录里，workbuddy 升级 node 把旧目录连同 opencode.cmd 一起换掉了（train.md 2026-09-29）。
      // 只写"PATH 里没有"会让人白找，所以把两个搜索位置都点出来。
      return {
        ok: false,
        reason: 'opencode CLI 找不到。已搜索：PATH、以及 ~/.workbuddy/binaries/node/versions/<当前版本>/'
          + '（workbuddy 升级自带 node 会换掉该目录，装在里面的 opencode.cmd 会随之消失）。'
          + '请重装 opencode，或在 settings 里给通用 CLI 适配器配命令模板。',
      };
    } catch (e) { return { ok: true }; }
  },
  async inject(p, ctx) {
    const r = await ai.autoInject(ctx.workspaceDir, p.message, null, ctx.vscode, p.system);
    return { ok: r.ok, sessionId: r.sessionId, reply: r.reply, isNew: r.isNew,
      resumed: r.resumed, tuiSwitched: r.tuiSwitched, error: r.error };
  },
});

module.exports = { opencode: reg.get('opencode') };
