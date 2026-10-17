// Author: Airtl yu

// Contact: yuairtl@outlook.com
'use strict';
// adapters/index.js — AI 工具适配器注册表
//
// 【为什么要有注册表】注入点有 7 个，工具会越加越多（opencode / dsh / zcode …）。
// 如果在 aiBridge 里用 if-else 逐个分支，每加一个工具就要改核心文件，必然漂移。
// 改成：每个工具一个适配器对象，声明自己的能力，注册进这张表；aiBridge 只认表，不认工具。
//
// 【适配器契约】
//   id           string   工具标识（= 配置 vivadoProjectExplorer.ai.tool 的取值）
//   label        string   人话名（日志/报错用）
//   caps         object   能力声明：
//                          systemPrompt  能否接收独立的系统提示词（true/false）
//                          sessionResume 能否续接指定会话
//   detect()     Promise<boolean>  工具是否可用。可选收一个 ctx（aiBridge 传 vscode），
//                                  需要窗口级信息（如 opencode 找本窗口 server）的适配器用它。
//   preflight()  Object|Promise    启动前的自检（如通用 CLI 适配器的命令可达性检查）。
//                                        返回 { ok:true } 或 { ok:false, reason }
//   inject(p, ctx)  Promise<result>
//                p   = { system, message }   —— prompts.js 产出的中立结构
//                ctx = { workspaceDir, vscode, sessionId, timeoutMs }
//                返回 { ok, sessionId, reply, isNew, resumed, error }
//
// 【能力降级】caps.systemPrompt=false 的工具（极少数 CLI 不收系统提示词），
// 由 aiBridge 把 system 内容前置到 message 再交给适配器——一处处理，不在各适配器里重复。
//
// 【新增一个工具怎么接】三种路子，按已知程度选：
//   1. 接口清楚 → 写一个适配器文件，regist() 进来（opencode 走这条）
//   2. 只是个 CLI、参数未知 → 不写代码，让用户在 settings 里配命令模板（genericCli）
//   3. 完全不知道 → 别猜，先问清楚再接（占位符 detect 返回 false + 明确报错）

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── 注册表 ──
const REGISTRY = new Map();

function regist(adapter) {
  if (!adapter || !adapter.id) throw new Error('适配器缺 id');
  for (const k of ['detect', 'inject']) {
    if (typeof adapter[k] !== 'function') throw new Error('适配器 ' + adapter.id + ' 缺方法 ' + k);
  }
  REGISTRY.set(adapter.id, adapter);
  return adapter;
}

function get(id) { return REGISTRY.get(id) || null; }
function list() { return [...REGISTRY.values()]; }
function ids() { return [...REGISTRY.keys()]; }

// 按优先级探测第一个可用工具。priority 由调用方给（TASKS.md: opencode > dsh）。
// ctx 原样透传给各适配器的 detect（需要 vscode 的用）。
async function detectFirst(priority, ctx) {
  for (const id of priority || ids()) {
    const a = REGISTRY.get(id);
    if (!a) continue;
    try { if (await a.detect(ctx)) return a; } catch (e) { /* 探测失败当不可用 */ }
  }
  return null;
}

// ── 通用 CLI 适配器（零代码接新工具） ──
// 用户在 settings 里配一条命令模板，占位符由本模块替换：
//   {systemFile}  系统提示词临时文件路径（caps.systemPrompt=true 时才有意义）
//   {message}     用户消息
//   {session}     会话 ID（caps.sessionResume=true 且调用方传了才有）
//   {cwd}         工作目录
// 例："zcode --system-prompt-file {systemFile} -p {message}"
// 例（无系统提示词支持）："dsh run --prompt {message}"   → 此时 caps.systemPrompt=false，
//   aiBridge 会把 system 前置进 message。
function makeGenericCli(spec) {
  // spec: { id, label, command, systemPrompt, sessionResume, resumeArg? }
  const caps = { systemPrompt: !!spec.systemPrompt, sessionResume: !!spec.sessionResume };
  let tmpSys = null;
  return regist({
    id: spec.id,
    label: spec.label || spec.id,
    caps,
    async detect() {
      // 命令模板填了才算可用；不校验可执行文件是否真在 PATH（那是用户配的事，
      // 猜 PATH 会把"装了但不在 PATH"误判成不可用）
      return !!(spec.command && String(spec.command).trim());
    },
    preflight() { return { ok: true }; },
    async inject(p, ctx) {
      const { spawn } = require('child_process');
      let cmd = String(spec.command);
      const subs = {
        '{cwd}': ctx.workspaceDir || process.cwd(),
        '{message}': p.message,
        '{session}': (caps.sessionResume && ctx.sessionId) ? ctx.sessionId : '',
        '{systemFile}': '',
      };
      if (caps.systemPrompt && p.system) {
        tmpSys = path.join(os.tmpdir(), 'vivado-sys-' + process.pid + '-' + Date.now() + '.md');
        try { fs.writeFileSync(tmpSys, p.system, 'utf8'); subs['{systemFile}'] = tmpSys; }
        catch (e) { /* 写不了就留空，让工具自己报 */ }
      }
      for (const [k, v] of Object.entries(subs)) cmd = cmd.split(k).join(v);
      cmd = cmd.trim();
      if (!cmd) return { ok: false, error: '通用 CLI 适配器未配置命令模板（settings: vivadoProjectExplorer.ai.<id>.command）' };
      // 剩下的 {xxx} 占位符说明模板写了不支持的槽位 → 明确报错，不要静默传出去
      const left = cmd.match(/\{[a-zA-Z]+\}/g);
      if (left) return { ok: false, error: '命令模板含不支持的占位符: ' + left.join(', ') };
      const done = (r) => { if (tmpSys) { try { fs.unlinkSync(tmpSys); } catch (e) { } tmpSys = null; } return r; };
      return await new Promise(resolve => {
        // 命令模板可能带参数 → 必须过 shell；用户自己配的模板，风险自担
        const child = spawn(cmd, { cwd: ctx.workspaceDir || process.cwd(), windowsHide: true, shell: true });
        let out = '', err = '';
        const timer = ctx.timeoutMs > 0
          ? setTimeout(() => { try { child.kill(); } catch (e) { } }, ctx.timeoutMs) : null;
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => { if (timer) clearTimeout(timer); done(); resolve({ ok: false, error: '启动失败: ' + e.message }); });
        child.on('close', code => {
          if (timer) clearTimeout(timer);
          const text = (out || '').trim();
          if (code === 0 || text) return done(resolve({ ok: true, reply: text, sessionId: null, isNew: true }));
          return done(resolve({ ok: false, error: (err || out || '退出码 ' + code).slice(0, 400), code }));
        });
      });
    },
  });
}

module.exports = { regist, get, list, ids, detectFirst, makeGenericCli, REGISTRY };

// 加载内置适配器（opencode）。必须放在 module.exports 之后：
// builtin.js 开头就 require('./index')，此刻 exports 已赋值完整，循环引用拿到的是完整对象。
// 【为什么在 index 里加载而不是让调用方 require builtin】曾经放在 aiBridge 里 require，
// 结果任何只碰注册表的代码（测试、将来的 CLI 入口）拿到的都是空表——pickTool 永远报
// "没有可用的 AI 工具"，而 selftest 因为自己 require 了 builtin 把 bug 掩住了，全绿。
require('./builtin');

