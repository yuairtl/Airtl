// Author: Airtl yu

// Contact: yuairtl@outlook.com
'use strict';
// aiAdapter.js — AI 联动传输层：自动拉起 opencode server + 会话恢复 + 注入
// 架构（TASKS.md §6，实测验证）：
//   1. 首次即以 --port 0 打开可见 OpenCode TUI，API 与界面共用同一进程
//   2. GET /session 按 directory 过滤 → 该工程历史 session
//   3. 有历史 session → 取最新（time.updated 最大）作为"当前会话"（恢复）
//      无 → 创建新会话（POST /session，带可用 model）
//   4. 之后所有注入（子图/伪tb/仿真请求）都发到该会话
// 实测结论（2026-08-30）：
//   - 向历史 session 直接 POST message = 恢复（AI 带着旧上下文回复）
//   - POST /session 必须带 model（默认 deepseek-v4-flash-free 不存在）
//   - 可用模型：siliconflow/deepseek-ai/DeepSeek-V4-Flash（opencode 官方余额不足）
//   - server 会话全局共享，GET /session 返回所有工程会话 → 必须按 directory 过滤

const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const runtime = require('./opencodeRuntime');
// 纯计算核心（normDir / pickResumable / rankByActivity / betterList /
// modelResponseOk）在 C++（Airtl）。本文件只做进程/HTTP/会话编排。
const airtl = require(path.join(__dirname, 'Airtl', 'index.js'));

// 固定端口（扩展自己拉起的 server）
const SERVER_PORT = 4299;

// ── opencode 探测（找已装的 CLI）──
// 【为什么不能硬编码版本号】workbuddy 升级自带 node 时会换掉 versions/ 下的目录，
// 版本号带后缀漂移（实测 22.22.2 → 22.22.2-3），连里面的 opencode.cmd 一起没了
// （train.md 2026-09-29）。硬编码版本号 = 每次 workbuddy 更新就坏一次。
// 正解是读 versions/current —— 那是 workbuddy 自己维护的"当前版本"指针文件。
// base 可传入（测试用），不传则取本机真实位置。
// 【踩过的坑】曾把变量改名成 versions，函数体里却还在用 base：生产调用不传 base 时
// path.join(undefined,...) 抛错被 catch 吞掉，函数恒返回 []，等于一次都没搜过。
// 而单测全都显式传 base，正好绕开这条路径，所以全绿——见 train.md 2026-09-29。
function workbuddyNodeBinDirs(base) {
  const versions = base || path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  const seen = new Set();
  const out = [];
  const push = p => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  // ① current 指针指的版本（稳定，优先）
  try {
    const cur = fs.readFileSync(path.join(versions, 'current'), 'utf8').trim();
    if (cur) push(path.join(versions, cur));
  } catch (e) { /* current 不存在就不猜 */ }
  // ② 目录下现存的每个版本目录兜底（current 丢了也能找到）
  try {
    for (const d of fs.readdirSync(versions)) {
      if (d === '.locks' || d === 'current' || d === '.cache') continue;
      const p = path.join(versions, d);
      try { if (fs.statSync(p).isDirectory()) push(p); } catch (e) { }
    }
  } catch (e) { }
  return out;
}

// 返回 opencode CLI 路径；找不到返回 ''。
// 【必须真的校验存在】旧实现末尾 `return 'opencode'` 恒为真，等于 CLI 检查形同虚设，
// preflight 会对一个根本不存在的工具报 {ok:true}，用户到注入时才撞 ENOENT。
// 现在返回 '' 让上层明确失败，而不是假装可用。
function findOpencodeCli() {
  for (const dir of workbuddyNodeBinDirs()) {
    for (const name of ['opencode.cmd', 'opencode.exe', 'opencode']) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p)) return p; } catch (e) { }
    }
  }
  // npm 全局 / PATH：交给 where 命令解析，别直接返回裸字符串。
  // 【后缀顺序】必须 .cmd → .exe → 无后缀。npm 全局会同时落三个 shim：
  //   opencode（sh 脚本，给 git-bash 用）、opencode.cmd（Windows 批处理）、opencode.ps1
  // 而 `where opencode` 的输出顺序正是无后缀那个在前，直接取第一条会拿到 sh 脚本——
  // 它在 Windows 上 spawn 不起来。当前三处调用都只判真伪所以没暴露，但别留这个坑。
  // 顺序取自 @openagents-org/agent-launcher 的 whereBinary（实测可用的那份）。
  try {
    const { execFileSync } = require('child_process');
    for (const name of ['opencode.cmd', 'opencode.exe', 'opencode']) {
      let r = '';
      try { r = execFileSync('where.exe', [name], { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (e) { continue; }   // 这个后缀没有，试下一个
      const first = String(r).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    }
  } catch (e) { /* where 不存在 */ }
  return '';
}

// Activation uses async lookup so a slow/misconfigured PATH cannot freeze the
// extension host. One bounded where process handles all suffixes.
async function resolveOpencodeCli() {
  for (const dir of workbuddyNodeBinDirs()) {
    for (const name of ['opencode.cmd', 'opencode.exe', 'opencode']) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p)) return p; } catch (e) { }
    }
  }
  return new Promise(resolve => {
    execFile('where.exe', ['opencode.cmd', 'opencode.exe', 'opencode'], { encoding: 'utf8', timeout: 1500, windowsHide: true }, (error, stdout) => {
      // where can return exit code 1 when just one of the suffixes is absent.
      const candidates = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const p of candidates) {
        try { if (fs.existsSync(p)) return resolve(p); } catch (e) { }
      }
      resolve('');
    });
  });
}

// ── 检查端口是否已被 opencode server 占用（已在跑）──
function isServerRunning(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/session', timeout: 1500 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── HTTP 工具 ──
// timeoutMs 缺省 10s：绝不无限期挂起（旧代码 GET /session 无超时——server 卡住时
// 工作流通知条会一直转，用户没有任何反馈）。
// __delivered：响应头已回来 = 请求确实送达 server。调用方据此区分
//   「超时/响应体丢失」（请求已写出，按已发送处理）与
//   「连接被重置/拒绝」（确实没送到，必须重试或报错）——注入通道曾把后者误判为已发送。
function httpReq(method, port, p, body, timeoutMs) {
  const tmo = timeoutMs || 10000;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    let delivered = false;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, res => {
      delivered = true;
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, text: raw }); }
      });
    });
    req.on('error', e => { if (delivered) e.__delivered = true; reject(e); });
    req.setTimeout(tmo, () => {
      req.destroy(new Error('HTTP 超时 (' + tmo + 'ms): ' + method + ' ' + p));
    });
    if (data) req.write(data);
    req.end();
  });
}

// ── 瞬时网络错误判定 + 端口自适应重试（read ECONNRESET 根因修复）──
// 事故背景：官方 opencode.openTerminal 每次拉起都是【新的随机端口】，旧实例随时可能被
// 扩展回收/退出；server 重启或换端口时，先前探测到的端口上立刻 ECONNRESET。
// 旧代码把这种原始网络错误直接抛到 UI（"① 执行仿真失败: read ECONNRESET"）。
// 本层统一消化：瞬时错误 → 重新探测 server 端口（可能已变）→ 重试；仍失败 → 抛可读错误。
const RETRYABLE_NET = /econnreset|econnrefused|epipe|etimedout|econnaborted|enotconn|socket hang up/i;
function isRetryableNetErr(e) {
  return RETRYABLE_NET.test(String((e && e.message) || e || ''));
}
function isTimeoutErr(e) {
  return /超时|timeout|timed out/i.test(String((e && e.message) || e || ''));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// GET 幂等：超时也重试（server 忙时读会话列表可能慢）；POST 超时不重试（可能重复投递）。
function isRetryableErr(e, method) {
  if (isRetryableNetErr(e)) return true;
  return method === 'GET' && isTimeoutErr(e);
}

// holder: { port } —— 重试过程中可能被刷新（server 重启换端口时自动跟随新端口）。
// opts.rediscover：自定义重探测函数（返回端口或 null）。多窗口场景传"只找本窗口的 server"，
// 避免重试时飘到别的 VSCode 窗口的实例上；不传则用全局 findRunningServer。
// 返回 httpReq 的结果；重试耗尽后抛出最后一次错误（消息可读，不再是裸 ECONNRESET）。
async function callServer(holder, method, p, body, opts) {
  const o = opts || {};
  const tries = o.tries == null ? 3 : o.tries;
  const timeoutMs = o.timeoutMs || 10000;
  const canRetry = o.retryIf || (e => isRetryableErr(e, method));
  const rediscover = o.rediscover || (async () => { const f = await findRunningServer(); return f ? f.port : null; });
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (!holder.port) {
      const p2 = await rediscover();
      if (p2) holder.port = p2;
    }
    if (!holder.port) {
      lastErr = new Error('未探测到运行中的 opencode server（请确认 opencode 已启动）');
      if (i < tries - 1) { await sleep(400); continue; }
      break;
    }
    try {
      return await httpReq(method, holder.port, p, body, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (!canRetry(e) || i === tries - 1) break;
      // 重新探测：server 可能已重启换了端口。探测不到/仍是旧端口都不影响——
      // 下一轮照常用 holder.port 重试（瞬时 ECONNRESET 往往立即重试即通）。
      try { const p2 = await rediscover(); if (p2) holder.port = p2; } catch (e2) { /* 探测失败不致命 */ }
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr || new Error('请求失败: ' + method + ' ' + p);
}

// ── 本窗口 opencode server 识别（多 VSCode 窗口根因修复）──
// 背景（实测 opencode 1.17.15）：官方 opencode.openTerminal 在【每个 VSCode 窗口】各起一个
// opencode server（各自随机端口），会话存【共享 SQLite】——GET /session 在任何实例上都能列出
// 全部工程的会话。旧代码"全局探测第一个能响应的端口 + 向所有端口广播 select-session"导致：
//   ① 新窗口的注入/建会话可能落到【别的窗口】的 server 上。POST /session 不带 directory 时，
//      会话归属写成那个 server 的 cwd（= 别的工程目录）→ 下次打开本工程按 directory 匹配
//      不到 → "这个目录已经开过 session，再次打开却识别不到"。
//   ② 广播 select-session 会把【所有】窗口的 TUI 切到本工程会话 → 老窗口界面被抢走，
//      即"新开的 vscode 往老的 vscode 里开新的 session"。
//   ③ 每次激活都无条件触发官方命令 → 每窗口每激活多一个终端+新 server，端口泛滥；
//      两个 server 抢同一 SQLite 时新的直接 "database is locked" 起不来（已复现）。
// 修法：先识别【本窗口】自己的 opencode server，只对它做 select-session / 注入 / 建会话；
// 建会话必须显式带 ?directory=<工程目录>，归属才正确。识别不到本窗口才退回全局广播。

// 从本窗口终端的 creationOptions 里读官方扩展写的端口（官方扩展 createTerminal 时塞的
// _EXTENSION_OPENCODE_PORT）。vscode.window.terminals 是【本窗口】的，故命中的端口必属本窗口。
function terminalEnvPorts(vscode) {
  const out = [];
  try {
    for (const t of (vscode.window.terminals || [])) {
      const co = t.creationOptions;
      const env = co && co.env;
      const p = env && Number(env._EXTENSION_OPENCODE_PORT);
      if (Number.isFinite(p) && p > 0) out.push(p);
    }
  } catch (e) { /* creationOptions 不可读则走进程树路径 */ }
  return out;
}

// 进程树路径（官方扩展未提供 env / creationOptions 不可读时的通用兜底）：
// 从本窗口终端的 shell PID 往下找 opencode.exe 后代进程，再取其 127.0.0.1 监听端口。
// ⚠️ Win32_Process 的 ProcessId/ParentProcessId 是 UInt32，而 JS 传来的根 PID 是 Int32——
//    Hashtable 的 ContainsKey 对装箱后不同类型不匹配，必须全程 [int] 归一，否则遍历空转。
async function opencodePortsUnderPids(pids) {
  return (await runtime.terminalProcessState(pids)).ports;
}

// 找【本窗口】的 opencode server 端口；找不到返回 null（调用方退回全局探测）。
async function findOwnWindowServer(vscode) {
  if (!vscode || !vscode.window) return null;
  // 1) 官方扩展塞在终端 env 里的端口（最快、零子进程）
  for (const p of terminalEnvPorts(vscode).reverse()) {
    if (await isServerRunning(p)) return p;
  }
  const cands = [];
  // 2) 进程树：本窗口终端的 shell PID → 后代 opencode.exe → 监听端口
  try {
    const pids = (await Promise.all((vscode.window.terminals || []).map(t => runtime.terminalPid(t))))
      .filter(pid => Number.isFinite(pid) && pid > 0);
    if (pids.length) for (const p of await opencodePortsUnderPids(pids)) cands.push(p);
  } catch (e) { /* 进程树路径失败不致命 */ }
  // 逐个验证（倒序：最新的终端最可能是用户正在看的那个）
  for (const p of [...new Set(cands)].reverse()) {
    if (await isServerRunning(p)) return p;
  }
  return null;
}

// ── 拉起 opencode ──
// 2026-10-17 用户确认：Airtl 一次带参启动同款可见 TUI，替代旧版仅调用官方
// openTerminal 的限制（该命令在 sst-dev.opencode 1.0.0 不支持传参）。
// 本窗口已有 API → 复用；否则首次启动带 --port 0；绝不新开 headless server。
// One extension host belongs to one VS Code window. API facade objects can
// differ between callers (notably extension tests), so do not key by their identity.
let starting = null;
function ensureServer(workspaceDir, vscode) {
  if (!vscode || !vscode.window) return startServer(workspaceDir, vscode);
  if (starting) return starting;
  starting = startServer(workspaceDir, vscode).finally(() => { starting = null; });
  return starting;
}

async function startServer(workspaceDir, vscode) {
  // 1) 本窗口已有 → 复用（幂等，不再新开终端/server）
  const own = await findOwnWindowServer(vscode);
  if (own) return { port: own, already: true, scoped: true };

  // 1b) CLI 不在就别白等。以前这里直接触发官方命令然后死等 20s：官方扩展装着所以
  //     cmdErr 为 null，而 CLI 没了 server 永远起不来，20s 全耗在每 500ms 一次的
  //     tasklist+netstat 上（activate 里还要重试 5 次 ≈ 150s，每次开 VSCode 都卡）。
  //     本机实例：opencode 原本装在 workbuddy 自带 node 的版本目录里，workbuddy 升级
  //     node 把旧目录连同二进制一起换掉了（train.md 2026-09-29）。
  //     但【已经在跑的 server 仍要能用】——那种情况不需要 CLI，所以先探测再决定。
  const cli = await resolveOpencodeCli();
  if (!cli) {
    const running = !vscode && await findRunningServer();
    if (running) return { port: running.port, already: true, scoped: false, cmdErr: 'CLI 不存在但复用了已运行的 server' };
    const err = new Error('opencode CLI 找不到。已搜索 PATH 与 ~/.workbuddy/binaries/node/versions/<当前版本>/'
      + '（workbuddy 升级自带 node 会换掉该目录，装在里面的 opencode.cmd 会随之消失）。'
      + '请重装 opencode，或在 settings 里给通用 CLI 适配器配命令模板。');
    err.permanent = true;   // 重试不会好，让 activate 的循环立即停
    throw err;
  }

  if (!vscode || !vscode.window) {
    const running = await findRunningServer();
    if (running) return { port: running.port, already: true, scoped: false };
    throw new Error('No OpenCode API is running; start its visible TUI with --port or use VS Code.');
  }
  if (vscode.workspace && vscode.workspace.isTrusted === false) {
    const error = new Error('OpenCode 未启动：工作区处于受限模式，请先确认并信任当前工程。');
    error.permanent = true;
    throw error;
  }
  if (!workspaceDir) throw new Error('OpenCode requires an open workspace directory.');
  const terminals = vscode.window.terminals || [];
  const existing = [...terminals].reverse().find(t => t.name === 'opencode');
  const terminal = existing || runtime.launchApiTerminal(vscode, workspaceDir, cli);
  if (existing) await runtime.enableTerminalApi(vscode, terminal, workspaceDir);

  // 3) 等【本窗口】的实例就绪（随机端口）
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(500);
    const p = await findOwnWindowServer(vscode);
    if (p) return { port: p, already: !!existing, scoped: true };
  }

  throw new Error('OpenCode TUI 已启动，但 20s 内未检测到本窗口可用的 HTTP API，请查看 OpenCode 终端报错。');
}

// 列出所有 opencode 监听端口（按 opencode.exe 进程 PID 反查其监听端口）
//  主路径：tasklist 取 opencode.exe PID + netstat -ano 匹配 LISTENING 端口（Windows 扩展宿主可靠）。
//  兜底：netstat 不可用时改用 PowerShell Get-NetTCPConnection 取同一 PID 的监听端口。
//  注：旧版用 opencode.log 正则兜底，但实测 opencode 不在日志中写端口（正则恒为 0 条），
//      且该日志含大量用户命令端口（如 18080/3000），极易误匹配 → 已彻底删除该死代码。
function listOpencodePorts() {
  return new Promise(resolve => {
    const { execFile } = require('child_process');
    const finish = (ports) => resolve([...new Set(ports)].filter(p => p > 0));
    // 1. tasklist 找 opencode 进程 PID
    execFile('tasklist', ['/FI', 'IMAGENAME eq opencode.exe', '/FO', 'CSV', '/NH'], (err, stdout) => {
      const opencodePids = new Set();
      if (!err) {
        for (const line of stdout.split('\n')) {
          const m = line.match(/"opencode\.exe","(\d+)"/);
          if (m) opencodePids.add(m[1]);
        }
      }
      if (opencodePids.size === 0) return finish([]);   // 连 PID 都拿不到，放弃
      // 2a. netstat 主路径：取这些 PID 在 127.0.0.1 上的 LISTENING 端口
      execFile('netstat', ['-ano'], (err2, stdout2) => {
        const ports = [];
        if (!err2) {
          for (const line of stdout2.split('\n')) {
            const m = line.match(/127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/);
            if (m && opencodePids.has(m[2])) ports.push(parseInt(m[1], 10));
          }
        }
        if (ports.length) return finish(ports);
        // 2b. 兜底：PowerShell Get-NetTCPConnection（netstat 被裁剪/不可用时）
        try {
          const idList = [...opencodePids].join(',');
          const ps = '(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue) | ' +
            'Where-Object { $_.LocalAddress -eq \'127.0.0.1\' -and ($_.OwningProcess.ToString()) -in @(' + idList + ') } | ' +
            'ForEach-Object { $_.LocalPort }';
          execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 8000 }, (e3, so3) => {
            const psPorts = [];
            if (!e3) {
              for (const l of so3.split('\n')) {
                const n = parseInt(l.trim(), 10);
                if (!isNaN(n) && n > 0) psPorts.push(n);
              }
            }
            finish(psPorts);
          });
        } catch (e) {
          finish([]);
        }
      });
    });
  });
}

// 找正在运行的 opencode server（任意端口）
async function findRunningServer() {
  const ports = await listOpencodePorts();
  for (const port of ports) {
    if (await isServerRunning(port)) return { port };
  }
  return null;
}

// ── 归一化工程目录（大小写/盘符/尾斜杠）── 主体在 C++（Airtl normDir）
function normDir(p) {
  return p ? airtl.normDir(p) : '';
}


// ── 进程内会话缓存：同一进程对同一工程反复拉会话时复用，避免每次都新建空壳
//    （空壳堆积根因之一：冷启动/多次 activate 时若目录匹配或 DB 读取时序抖动，
//     每次都 POST /session 产生一个新空会话）。命中后仅做一次 select-session 切回 TUI。──
const _recentSessionByDir = new Map(); // normDir -> { id, title, ts }

// 把 TUI 切到指定会话。
//   scoped=true（已识别出本窗口的 server）→ 【只切本窗口】这一个端口。绝不动其它窗口——
//     广播会把所有 VSCode 窗口的 TUI 都抢到本工程会话上（"往老的 vscode 里开新 session"）。
//   scoped=false（识别不到本窗口，官方扩展没装等兜底场景）→ 才退化成全局广播。
// 返回 { resumed, selectErr, port } —— port 是切换成功的实例端口：后续请求优先走它，
// 因为该实例的 TUI 正在显示目标会话，SSE 事件流能把 AI 回复实时推到用户界面。
async function switchTuiSession(sessionId, port, scoped) {
  if (scoped && port != null) {
    let swErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const sw = await httpReq('POST', port, '/tui/select-session', { sessionID: sessionId }, 3000);
        if (sw.status === 200) return { resumed: true, selectErr: null, port };
        swErr = 'port=' + port + ' status=' + sw.status;
      } catch (e) { swErr = 'port=' + port + ' ' + e.message; }
      if (i < 2) await sleep(500);
    }
    return { resumed: false, selectErr: swErr, port: null };
  }
  return broadcastSelectSession(sessionId, port);
}

// 全局广播（仅兜底）：向所有可达 opencode 实例发 select-session。
// ⚠️ 会把它窗口的 TUI 也切走——只在无法识别本窗口 server 时使用。
async function broadcastSelectSession(sessionId, basePort) {
  const allPorts = await listOpencodePorts();
  const targets = allPorts.length ? allPorts.slice() : (basePort != null ? [basePort] : []);
  if (basePort != null && targets.indexOf(basePort) < 0) targets.push(basePort);
  let resumed = false, swErr = null, swPort = null;
  for (const tp of targets) {
    for (let i = 0; i < 3 && !resumed; i++) {
      try {
        const sw = await httpReq('POST', tp, '/tui/select-session', { sessionID: sessionId }, 3000);
        if (sw.status === 200) { resumed = true; swErr = null; swPort = tp; }
        else swErr = 'port=' + tp + ' status=' + sw.status;
      } catch (e) { swErr = 'port=' + tp + ' ' + e.message; }
      if (!resumed && i < 2) await new Promise(r => setTimeout(r, 750));
    }
    if (resumed) break;
  }
  return { resumed, selectErr: resumed ? null : swErr, port: swPort };
}

// ── 找该工程的历史 session（directory 精确匹配，取最新）──
// 返回 { sessionId, title, isNew, resumed }
// 解析【候选模型列表】，按优先级排序。必须是列表而不是单个值：
// 没有任何静态信号能判断一个模型"现在能不能用"——本机实例：config 写的
// opencode/deepseek-v4-flash-free 已从 opencode 的模型目录里消失（报"免费档已停产"）；
// commandcode 虽在 connected 列表里、模型也在目录里，但账号没额度；两者静态看都"合法"。
// 所以只能"挨个试，失败的换下一个"（见 injectToSession 的重试）。
//
// 候选来源与顺序：
//   ① 最近活跃会话自带的 model —— 用户在 opencode TUI 里 /model 选过的模型
//      【只存在于会话对象上，不写回 config 文件】。GET /session 每条都带 model 字段
//      {id, providerID, variant}。这是唯一能反映用户真实选择的来源。
//      故意【不带 directory 过滤】：用户完全可能在【另一个工程】里 /model 选了模型，
//      那才是他当前想用的。按 time.updated 倒序，全部纳入候选（不是只取第一个——
//      第一个可能是扩展自己上次建会话时写死的死模型）。
//   ② GET /config 的 model —— opencode.jsonc 里的静态默认，用户 /model 后不会更新。
//   ③ /provider 的 default[] —— opencode 给每个 provider 定的默认模型。
//   ④ connected provider 的第一个模型 —— 最后的兜底（零名字假设，不预设任何模型名）。
async function resolveModels(cs, sessions, options) {
  if (options && options.model) return airtl.modelCandidates([], {}, {}, options.model);
  let config = {}, providers = {};
  try {
    const result = await cs('GET', '/config', null, { timeoutMs: 5000, tries: 2 });
    config = result.json || {};
  } catch (_) { /* Remote configuration is optional. */ }
  try {
    const result = await cs('GET', '/provider', null, { timeoutMs: 5000, tries: 2 });
    providers = result.json || {};
  } catch (_) { /* Keep session/config candidates when provider lookup fails. */ }
  const result = airtl.modelCandidates(sessions || [], config, providers);
  if (process.env.VIVADO_AI_DEBUG && result.length) {
    console.error('[model dbg] ' + result.map(m => m.providerID + '/' + m.id).join(' -> '));
  }
  return result;
}

// 把目标会话的模型改成指定的那个。
// 【为什么需要这个】会话的 model 在建会话时定死，之后 PATCH /session/{id} 也改不了
// （schema 只准改 title/metadata/permission/time.archived——已实测确认），
// prompt_async 请求体里带的 model 也会被会话自带模型覆盖（实测：传了 omen-alpha，
// 产出的 assistant 仍是 longcat-2.0:free）。所以复用一个模型已失效的旧会话时，
// 只能想办法改它的模型，否则 AI 每次都报错、用户以为没推送（train.md 2026-09-30）。
// 正路：/tui/execute-command 在 TUI 里执行 `/model <provider>/<id>`——改的就是当前会话。
//
// 【不能只信 HTTP 状态码】headless 的 `opencode serve` 上这个路由存在且返回 200，
// 但根本没有 TUI 在执行命令，模型原封不动——早期只判 200 就返回 true，
// 结果上层以为改成功了，不建新会话，AI 照旧拿死模型跑（实测踩过）。
// 所以执行完必须回读 GET /session 校验该会话的 model 真的变了，才算成功。
async function setSessionModel(cs, sessionId, model) {
  if (!model || !model.providerID || !model.id || !sessionId) return false;
  const want = model.providerID + '/' + model.id;
  const readModel = async () => {
    try {
      const l = await cs('GET', '/session', null, { timeoutMs: 5000, tries: 1, retryIf: () => false });
      const hit = (Array.isArray(l.json) ? l.json : []).find(x => x.id === sessionId);
      return hit && hit.model ? hit.model.providerID + '/' + hit.model.id : null;
    } catch (e) { return null; }
  };
  for (const cmd of ['/model ' + want, '/model ' + want + ' default', '/models ' + want]) {
    try {
      const r = await cs('POST', '/tui/execute-command', { command: cmd },
        { timeoutMs: 5000, tries: 1, retryIf: () => false });
      if (r && r.status >= 400) continue;   // 命令不被接受，换下一种写法
    } catch (e) { continue; }
    // 校验：真的变了才算成功（给 TUI 一点落地时间）
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      if (await readModel() === want) return true;
    }
  }
  return false;
}

// ── 模型可用性探测（train.md 2026-09-30）──
// 为什么必须探测：没有任何静态信号能判断"这个模型现在能不能用"。本机实例：
//   · opencode/deepseek-v4-flash-free —— config 里写着，但已从 opencode 模型目录消失
//     （提供商下线免费档），一调用就 403 "free LongCat 2.0 tier has been retired"
//   · commandcode/glm-5.3-flash —— 在 connected 列表、目录里也有，但账号没额度，400
// 两者静态检查全过。所以只能真发一次最小的请求试。（早期不探测、直接拿会话自带的
// 死模型发 → 消息照常显示在 TUI，AI 却永远报错，用户以为"没推送出去"。）
//
// 做法：建一个一次性会话 → 用该 model 发一句废话 → 看有没有 error → 删掉该会话。
// 用完即删，不会在用户会话列表里留痕迹（也就不会污染"最近活跃会话"的模型选择）。
async function probeModel(cs, workspaceDir, model) {
  if (!model || !model.providerID || !model.id) return false;
  let sid = null;
  try {
    const c = await cs('POST', '/session?directory=' + encodeURIComponent(workspaceDir),
      { model: { providerID: model.providerID, id: model.id, variant: model.variant || 'default' } },
      { timeoutMs: 8000, tries: 1 });
    sid = c.json && c.json.id;
  } catch (e) { return false; }
  if (!sid) return false;
  try {
    let failed = null;
    try {
      const r = await cs('POST', '/session/' + sid + '/message',
        { parts: [{ type: 'text', text: 'ping' }], model: { providerID: model.providerID, modelID: model.id } },
        { timeoutMs: 20000, tries: 1, retryIf: () => false });
      if (r.status !== 200 || !r.json) {
        // 500 "Unexpected server error" 就走这里——本机 opencode-go/omen-alpha 就是这种：
        // 早先只判"没有 info.error"时把它当成可用，选上去照样跑不动，用户看到消息没响应。
        failed = String(r.text || ('HTTP ' + r.status)).slice(0, 200);
      } else {
        const err = r.json.info && r.json.info.error;
        if (err) {
          failed = String((err.data && err.data.message) || err.name || err);
        } else {
          // 200 且没 error 还不够：必须有真正的文本产出才算"这个模型现在能用"。
          // 只判 erro 与否会把"返回空内容"的模型也当可用（实测踩过）。
          const parts = r.json.parts || [];
          const text = parts.filter(x => x && x.type === 'text' && x.text).map(x => x.text).join('');
          if (!text.trim()) failed = '返回 200 但没有任何文本内容';
        }
      }
    } catch (e) {
      failed = e.message;   // 超时不算失败（可能只是慢），交给调用方判断
    }
    if (failed) {
      if (process.env.VIVADO_AI_DEBUG) {
        console.error('[model dbg] 探测失败 ' + model.providerID + '/' + model.id + ': ' + failed.slice(0, 120));
      }
      return false;
    }
    return true;
  } finally {
    // 删掉探测会话，别给用户留垃圾
    try { await cs('DELETE', '/session/' + sid, null, { timeoutMs: 5000, tries: 1 }); } catch (e) { }
  }
}

// 进程内缓存：探测很贵（每个模型一次真实请求），同一进程反复注入时没必要重复探。
const _workingModelByDir = new Map();   // normDir(workspaceDir) -> { providerID, id, variant, ts }
const WORKING_MODEL_TTL = 30 * 60 * 1000;

async function pickWorkingModel(cs, workspaceDir, models) {
  const list = (models || []).filter(m => m && m.providerID && m.id);
  if (!list.length) return null;
  const key = normDir(workspaceDir);
  const hit = _workingModelByDir.get(key);
  if (hit && Date.now() - hit.ts < WORKING_MODEL_TTL && list.some(m => m.providerID === hit.providerID && m.id === hit.id)) {
    return { providerID: hit.providerID, id: hit.id, variant: hit.variant };
  }
  // 探测个数要给够：本机候选前几个连着是死模型（没额度/已停产/500），
  // 只探 4 个会摸不到后面真能用的。6 个是权衡（每个探针都是一次真实请求）。
  for (const m of list.slice(0, 6)) {
    if (await probeModel(cs, workspaceDir, m)) {
      _workingModelByDir.set(key, { providerID: m.providerID, id: m.id, variant: m.variant, ts: Date.now() });
      return { providerID: m.providerID, id: m.id, variant: m.variant };
    }
  }
  // 全失败 → 仍返回第一个候选（至少让真正的错误暴露给用户，而不是静默不发）
  return list[0];
}

async function resolveSession(workspaceDir, options, vscode) {
  const srv = await ensureServer(workspaceDir, vscode);
  // holder.port 端口自适应：server 重启/官方命令换端口时，重探测后自动跟随新端口
  // （旧代码把 ensureServer 那一刻的端口写死，server 一换端口后续请求全 ECONNRESET）。
  const holder = { port: srv.port };
  const already = srv.already;
  // scoped：是否已锁定【本窗口】的 server。true → select-session 只切本窗口（不劫持别的窗口）；
  //         false → 兜底路径（官方扩展没装/终端识别不到），只能广播。
  const scoped = !!srv.scoped;
  const target = normDir(workspaceDir);
  // 重探测策略：已锁定本窗口 server 时，重试也只在本窗口的 server 里找（不飘到别的窗口）；
  // 兜底路径（scoped=false）才用全局探测。
  const rediscover = (scoped && vscode)
    ? (async () => { try { return await findOwnWindowServer(vscode); } catch (e) { return null; } })
    : null;
  const cs = (method, p2, body, opts) => callServer(holder, method, p2, body, Object.assign({ rediscover }, opts));

  // 【Fix 4】进程内复用：本进程已为该工程创建/确认过会话则优先复用（避免空壳堆积）。
  // 先验证缓存的 sessionId 仍存活（GET /session 找 id），存活则直接切回 TUI 复用，
  // 不进下面的 6 轮重试循环、也不新建。
  const cached = _recentSessionByDir.get(target);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
    try {
      const list = await cs('GET', '/session', null, { timeoutMs: 3000, tries: 2 });
      const sessions = Array.isArray(list.json) ? list.json : [];
      const hit = sessions.find(s => s.id === cached.id && !s.parentID);
      if (hit) {
        const sw = await switchTuiSession(hit.id, holder.port, scoped);
        if (sw.port) holder.port = sw.port;   // 切回成功的实例：后续请求走同一端口
        const { resumed, selectErr } = sw;
        if (process.env.VIVADO_AI_DEBUG && !resumed) console.error('[select-session dbg][cache] 失败: ' + selectErr);
        return { port: holder.port, sessionId: hit.id, title: hit.title || cached.title || '历史会话', isNew: false, resumed, selectErr, scoped };
      }
    } catch (e) { /* 验证失败：忽略缓存，走常规流程 */ }
    _recentSessionByDir.delete(target);   // 缓存失效，清掉
  }

  // 1. 列出会话并匹配本工程。关键时序（bug 修复）：【刚拉起的实例 GET /session 可能暂时
  //    返回不全/为空】（opencode 启动中 DB 尚未完全加载）——立刻判定"无历史"会错建新会话
  //    且跳过恢复。重试读取（最多 6 次 × 500ms）直到匹配到历史会话或确认确实没有。
  // 【归属锚点 = VSCode 当前打开的目录】（用户裁定：opencode 只认目录，与 .xpr 无关）。
  //   实测 opencode 1.17.15：GET /session?directory=X 就是按 directory 精确过滤——所以
  //   这里也按 directory 精确匹配（大小写/斜杠归一），不做任何 worktree 上下级遍历
  //   （曾用 /project 反查 projectID 再按工程聚合，那是我自己加的层级猜测：用户这次开工程根、
  //    上次开子目录，本就是两个不同工作区，不该互认；而"同目录再开识别不到"才是真 bug）。
  // 【选择优先级】非空（tokens 有内容 = 用户上次真会话）＞ time.updated 最新。
  //   TUI 每次启动都会建一个空壳会话，若按 updated 排就会永远选中那个空壳 → 用户看到
  //   "又开了一个新 session"（这正是"乱开 session"的直接成因）。
  //   全部为空（真没历史）→ 回退选最新的空壳（那是 TUI 正在看的，恢复显示它而不新建，
  //   避免重复空会话堆积）。
  let mine = [], allMine = [], listErr = null, everListed = false;
  // sessions 必须提到循环外：模型解析要看全部会话（用户在某个工程里 /model 选过的模型
  // 只存在于该会话对象上，不写回 config 文件）。放在循环内则循环外拿不到。
  let sessions = [];
  for (let i = 0; i < 6; i++) {
    try {
      const list = await cs('GET', '/session', null, { timeoutMs: 5000, tries: 2 });
      sessions = Array.isArray(list.json) ? list.json : [];
      listErr = null;
      everListed = true;
    } catch (e) {
      // 网络层失败（server 刚拉起/重启换端口）：保留已见结果，退避后重试。
      // 【旧行为】这里直接抛出裸 ECONNRESET → UI 显示"① 执行仿真失败: read ECONNRESET"。
      listErr = e;
      if (process.env.VIVADO_AI_DEBUG) console.error('[resolveSession dbg] list fail try=' + i + ': ' + e.message);
      await sleep(400 * (i + 1));
      continue;
    }
    // 候选集 = 本目录（VSCode 打开的目录）的会话，精确匹配
    const pool = sessions.filter(s => s.directory && normDir(s.directory) === target && !s.parentID);
    const nonEmpty = s => { const t = s.tokens || {}; return !((t.input || 0) === 0 && (t.output || 0) === 0); };
    const cur = pool.slice().sort((a, b) =>
      ((nonEmpty(b) ? 1 : 0) - (nonEmpty(a) ? 1 : 0)) ||
      ((b.time && b.time.updated || 0) - (a.time && a.time.updated || 0)));
    const curNonEmpty = cur.filter(nonEmpty);
    // 「见过的最好结果」：冷启动期间各轮返回可能不全，按头部会话的优劣比较，
    // 不能用列表长度比（长≠好——多一个空壳反而更差）。
    const better = (a, b) => {
      if (!b.length) return a.length > 0;
      if (!a.length) return false;
      const d = (nonEmpty(a[0]) ? 1 : 0) - (nonEmpty(b[0]) ? 1 : 0);
      if (d) return d > 0;
      return (a[0].time && a[0].time.updated || 0) > (b[0].time && b[0].time.updated || 0);
    };
    if (better(curNonEmpty, mine)) mine = curNonEmpty;
    if (better(cur, allMine)) allMine = cur;
    if (process.env.VIVADO_AI_DEBUG) {
      console.error('[resolveSession dbg] try=' + i + ' sessions=' + sessions.length +
        ' allMine=' + allMine.length + ' nonEmpty=' + mine.length + ' target=' + target);
    }
    // 【关键修复】只在找到「非空」会话时才提前退出。
    // 原逻辑 `mine.length || allMine.length` 会在只出现空壳（TUI 刚新建的空会话）时就 break，
    // 随后回退选中空壳 → 冷启动必然恢复失败（"有时候恢复不了上次会话"的根因）。
    if (mine.length) break;
    // 已运行实例：确实一条该工程会话都没有 → 不必耗满预算
    if (already && i >= 1 && cur.length === 0) break;
    await new Promise(r => setTimeout(r, 500));
  }
  // 一次都没成功读到列表、也确实没有会话 → 是 server 不可达（不是"没有历史"），必须报可读错误。
  // （曾经读到过列表只是最后一轮抖动 → 不算不可达：那时 allMine/mine 已反映真实情况。）
  if (!everListed && !mine.length && !allMine.length && listErr) {
    throw new Error('opencode 会话读取失败（重试后仍不可达）: ' + listErr.message +
      '（请确认 opencode 正在运行；若刚启动请稍候再试）');
  }
  // 预算耗尽仍无非空 → 回退该工程最新会话（可能是空壳，也比新建一个强）
  if (!mine.length && allMine.length) mine = [allMine[0]];
  if (mine.length) {
    const s = mine[0];
    // 恢复上次会话：把 TUI 切到该会话。scoped 时只切【本窗口】（不抢别的窗口的界面）。
    const sw = await switchTuiSession(s.id, holder.port, scoped);
    if (sw.port) holder.port = sw.port;
    const { resumed, selectErr } = sw;
    if (process.env.VIVADO_AI_DEBUG && !resumed) console.error('[select-session dbg] 失败: ' + selectErr);
    // 记下本次确认的会话，供本进程后续调用复用
    _recentSessionByDir.set(target, { id: s.id, title: s.title || '历史会话', ts: Date.now() });
    // model 也要解析出来带回去：这个会话自带的模型可能已失效（提供方下线/额度没了），
    // 用最近活跃会话的模型覆盖它，AI 才跑得动（train.md 2026-09-30）。
    const resumedModels = await resolveModels(cs, sessions, options);
    return { port: holder.port, sessionId: s.id, title: s.title || '历史会话', isNew: false, resumed, selectErr, scoped, models: resumedModels, sessionModel: s.model || null };
  }
  // 3. 无历史 → 创建新会话。模型解析见 resolveModel 的顺序说明（① 最近活跃会话的模型优先，
  //    ② config 静态默认，③ provider 兜底）。两处分支都调它，避免逻辑漂移。
  const models = await resolveModels(cs, sessions, options);
  const model = models.length ? models[0] : null;
  // 新建会话。POST 非幂等：重发可能产生重复空壳——仅在"连接层失败且响应头都没回来"
  // （__delivered=false，请求很可能没送达）时才重试；响应头已回来只是 body 丢失时，
  // 改为回读该工程最新会话（session 其实已建好），绝不二次 POST。
  // 【多窗口根因修复】必须显式带 ?directory=<工程目录>：
  //   实测 opencode 1.17.15：POST /session 不传 directory 时，会话归属写成【server 进程的
  //   cwd】。多窗口下若请求落到别的窗口的 server 上，新会话就归属成【别的工程】→ 下次打开
  //   本工程按 directory 匹配不到 → "这个目录开过 session 却识别不到"。显式传入后，
  //   无论请求落到哪个实例，会话都正确归属本工程（会话存共享 DB，任何实例都能读到）。
  const createPath = '/session?directory=' + encodeURIComponent(workspaceDir);
  let created = null;
  try {
    created = await cs('POST', createPath, model ? { model } : {}, { timeoutMs: 8000, tries: 1 });
  } catch (e) {
    if (e && e.__delivered) {
      try {
        const list = await cs('GET', '/session', null, { timeoutMs: 5000, tries: 2 });
        const sessions = (Array.isArray(list.json) ? list.json : [])
          .filter(s => !s.parentID && s.directory && normDir(s.directory) === target)
          .sort((a, b) => ((b.time && b.time.created) || 0) - ((a.time && a.time.created) || 0));
        if (sessions.length) created = { json: sessions[0] };
      } catch (e2) { /* 回读也失败：走下方抛错 */ }
    }
    if (!created) throw new Error('创建会话失败: ' + e.message);
  }
  if (!created.json || !created.json.id) throw new Error('创建会话失败: ' + JSON.stringify(created.json || created.text || '').slice(0, 200));
  // 记下新会话，供本进程后续调用复用（避免同一进程重复新建空壳）
  _recentSessionByDir.set(target, { id: created.json.id, title: '新会话', ts: Date.now() });
  // 新建会话也要把 TUI 切到它（保证 GUI 显示的是这个会话）——scoped 时只切本窗口
  const swNew = await switchTuiSession(created.json.id, holder.port, scoped);
  if (swNew.port) holder.port = swNew.port;
  return { port: holder.port, sessionId: created.json.id, title: '新会话', isNew: true, models, model, scoped, sessionModel: model || null };
}

// ── 注入消息到指定会话 ──
// 单通道注入 + TUI 会话切换（实测 opencode 1.17.15）：
//   1. POST /tui/select-session {sessionID} → 200 true（把【本窗口】TUI 切到目标会话，
//      用户 UI 显示的就是注入的会话——解决"UI看不到"；scoped 时绝不动其它窗口）
//   2. POST /session/:id/prompt_async {parts:[{type:'text',text}]} → 204（官方非阻塞投递：
//      立即返回，AI 在后台跑完通过 SSE 推给 TUI。实测消息落共享 DB、任何实例都能读回）
//   3. 老版本 opencode 没有 prompt_async（404/405）→ 回退同步 /message（5s 超时按已发送处理）
//   4. 【不用 append-prompt】填输入框：输入框残留文本，用户误回车会重复发送（查重结论）
// portOrHolder：端口数字或 { port }（后者可在重试中被刷新——server 换端口时自动跟随）。
// scoped：true=已锁定本窗口 server（只切本窗口）；false=兜底（广播）。
// 【已修复的静默成功 BUG】旧代码把【所有】异常都当成"已发送（AI 处理中）"返回 ok:true——
//   连接被重置（ECONNRESET）时 AI 根本没收到，UI 却报成功，用户对着空会话干等。
//   现在区分：超时/响应体丢失（请求已送达 server，按已发送处理）vs 连接类错误
//   （确实没送到 → 重探测端口重试一次 → 仍失败则抛错，让用户知道没发出去）。
async function injectToSession(portOrHolder, sessionId, message, scoped, vscode, system, models) {
  const holder = (portOrHolder && typeof portOrHolder === 'object') ? portOrHolder : { port: portOrHolder };
  // 重探测策略同 resolveSession：锁定了本窗口 server 就只在本窗口找，别飘到别的窗口
  const rediscover = (scoped && vscode)
    ? (async () => { try { return await findOwnWindowServer(vscode); } catch (e) { return null; } })
    : null;
  // 不附加任何"Vivado模块图注入"前缀——消息就是任务本身（用户要求：模板里去掉注入相关信息）
  const prefixed = message;
  // 先把 TUI 切到目标会话（用户界面可见性）。记下切换成功的端口：消息优先发到该实例，
  // 它的 TUI 正显示目标会话，SSE 才能把 AI 回复实时推到用户眼前。
  let tuiSwitched = false;
  try {
    const sw = await switchTuiSession(sessionId, holder.port, scoped);
    if (sw.port) holder.port = sw.port;
    tuiSwitched = sw.resumed;
  } catch (e) { /* TUI 不在前台/端点不可用时忽略 */ }

  // system 层：opencode 的 /session/{id}/message 与 /prompt_async 的 body 都接受 system 字段
  // （已从其二进制内嵌 schema 确认：messageID/model/agent/noReply/tools/format/system/variant/parts）。
  // 不传则退化成纯 user message，行为与旧版一致。
  const body = { parts: [{ type: 'text', text: prefixed }] };
  if (system) body.system = String(system);
  // 【必须显式带 model】schema 里 prompt_async 的 model 是 {providerID, modelID}，
  // 而 POST /session 的 model 是 {providerID, id}——两个端点字段名不一样，别搞混。
  // 不传就等于沿用【会话自带的模型】。若那个模型已失效（提供方下线免费档/额度耗尽），
  // 消息会照常显示在 TUI 里，但 AI 每次都报错、永远不产出内容——用户看到的就是
  // "消息发出去了但没有任何响应"，并且会以为是没推送（train.md 2026-09-30）。
  // models[0] 是 autoInject 探测出来的可用模型（见 pickWorkingModel）；探测整体失败时
  // 退化成候选列表的第一个，至少让真正的错误暴露出来，而不是静默沿用死模型。
  const model = (models && models.length) ? models[0] : null;
  if (model && model.providerID && model.id) {
    body.model = { providerID: model.providerID, modelID: model.id };
  }
  // 连接类错误且响应头都没回来 → 才重发（server 换端口/重启的瞬时抖动）；
  // 超时或响应体丢失说明请求已送达 server，重发会造成重复注入，坚决不重试。
  const retryIf = e => isRetryableNetErr(e) && !e.__delivered;

  // 1) 首选官方非阻塞端点（204 = 已受理，AI 后台处理）
  let r = null, sendErr = null, usedAsync = true;
  try {
    r = await callServer(holder, 'POST', '/session/' + sessionId + '/prompt_async', body,
      { timeoutMs: 5000, tries: 2, retryIf, rediscover });
  } catch (e) { sendErr = e; }
  // 端点不存在（老版本 opencode：HTTP 404/405 是【响应】，不是异常）→ 回退同步 /message
  if (r && (r.status === 404 || r.status === 405)) r = null;
  // prompt_async 真失败（网络层，没送到）→ 已送达按已发送处理，否则抛错让用户知道
  if (!r && sendErr) {
    if (sendErr.__delivered || isTimeoutErr(sendErr)) {
      return { ok: true, reply: '', modelID: null, tuiSwitched, note: '已发送（AI 处理中）' };
    }
    throw new Error('注入失败（AI 未收到该消息）: ' + sendErr.message);
  }
  // 2) 回退：同步 /message（等 AI 回复；5s 超时按已发送处理）
  if (!r) {
    usedAsync = false;
    try {
      r = await callServer(holder, 'POST', '/session/' + sessionId + '/message', body,
        { timeoutMs: 5000, tries: 1, retryIf: () => false, rediscover });
    } catch (e) {
      if (e && (e.__delivered || isTimeoutErr(e))) {
        return { ok: true, reply: '', modelID: null, tuiSwitched, note: '已发送（AI 处理中）' };
      }
      throw new Error('注入失败（AI 未收到该消息）: ' + e.message);
    }
  }
  if (r.status !== 200 && r.status !== 204) {
    // 同步 /message 的 5xx = 消息已送达、AI 执行阶段报错（如模型不存在）——不是投递失败，
    // 必须和"没发出去"区分开，否则用户会重复发送。
    if (!usedAsync && r.status >= 500) {
      throw new Error('消息已送达，但 AI 执行失败: ' + (r.text || JSON.stringify(r.json || '')).slice(0, 200));
    }
    throw new Error('注入失败: ' + (r.text || JSON.stringify(r.json || '')).slice(0, 200));
  }
  const texts = (r.json && r.json.parts || []).filter(p => p.type === 'text').map(p => p.text || '');
  return { ok: true, reply: texts.join(''), modelID: r.json && r.json.info && r.json.info.modelID, tuiSwitched, async: usedAsync };
}

// ── 一键：确保 server + 恢复/创建会话 + 注入（供 UI 调用）──
// 返回 { sessionId, title, isNew, reply, modelID, scoped }
async function autoInject(workspaceDir, message, options, vscode, system) {
  const sess = await resolveSession(workspaceDir, options, vscode);
  // 传 holder（而非裸端口）：注入阶段 server 若换端口，重探测后自动跟随。
  // scoped 一并传下去：决定 select-session 只切本窗口还是退化成广播。
  // system：三级提示词里的系统层（见 ui_design/prompts.js）。
  // 探明一个真能用的模型再发。静态信息（config 的 model、provider 的 connected 列表）
  // 分不出"有额度"和"没额度"，本机上两批候选静态全过、一调用就 403/400。
  // 不探的后果：消息照常显示在 TUI，AI 永远报错，用户以为没推送（train.md 2026-09-30）。
  let model = null;
  try {
    const holder = { port: sess.port };
    const cs = (m, p2, b, o) => callServer(holder, m, p2, b, Object.assign({}, o));
    model = await pickWorkingModel(cs, workspaceDir, sess.models);
  } catch (e) {
    if (process.env.VIVADO_AI_DEBUG) console.error('[model dbg] 探测整体失败: ' + e.message);
  }
  // 会话自带模型 ≠ 探测出的可用模型时，先把会话模型改掉。
  // 不改的后果：prompt_async 带 model 会被会话自带模型覆盖（实测），AI 拿死模型跑，
  // 消息照常显示在 TUI 但永远报错 —— 就是用户报的"发出去了但没响应"。
  let modelSet = false;
  let targetId = sess.sessionId;
  if (process.env.VIVADO_AI_DEBUG) {
    console.error('[model dbg] 目标会话=' + sess.sessionId + ' 会话自带模型=' + JSON.stringify(sess.sessionModel)
      + ' 探测可用模型=' + JSON.stringify(model) + ' 候选数=' + ((sess.models || []).length));
  }
  let targetIsNew = sess.isNew;
  const sameModel = sess.sessionModel && model
    && sess.sessionModel.providerID === model.providerID && sess.sessionModel.id === model.id;
  if (model && !sameModel) {
    try {
      const holder = { port: sess.port };
      const cs = (m, p2, b, o) => callServer(holder, m, p2, b, Object.assign({}, o));
      modelSet = await setSessionModel(cs, sess.sessionId, model);
      if (!modelSet) {
        // 改不动（多半是没有 TUI 实例，/tui/execute-command 无处可执行）。
        // 会话模型建时定死且 PATCH 改不了，prompt_async 带的 model 也会被覆盖（均实测）。
        // 此时只能新建一个带可用模型的会话——宁可丢历史，也不能让 AI 拿着死模型跑：
        // 那样消息照常显示在 TUI，却永远只回一句报错，用户以为没推送（train.md 2026-09-30）。
        const created = await cs('POST', '/session?directory=' + encodeURIComponent(workspaceDir),
          { model: { providerID: model.providerID, id: model.id, variant: model.variant || 'default' } },
          { timeoutMs: 8000, tries: 1 });
        if (created && created.json && created.json.id) {
          targetId = created.json.id;
          targetIsNew = true;
          modelSet = true;
          if (process.env.VIVADO_AI_DEBUG) {
            console.error('[model dbg] 改不动旧会话模型，新建会话 ' + targetId
              + ' 用 ' + model.providerID + '/' + model.id);
          }
        }
      }
    } catch (e) {
      if (process.env.VIVADO_AI_DEBUG) console.error('[model dbg] 处理会话模型异常: ' + e.message);
    }
  } else if (model && sameModel) {
    modelSet = true;
  }
  const res = await injectToSession({ port: sess.port }, targetId, message, sess.scoped, vscode, system, model ? [model] : sess.models);
  return { sessionId: targetId, title: sess.title, isNew: targetIsNew, scoped: sess.scoped, model, models: sess.models, modelSet, ...res };
}

// ── 查询当前会话状态（供 UI 显示"已连接会话 xxx"）──
async function getCurrentSession(workspaceDir, options, vscode) {
  try {
    const sess = await resolveSession(workspaceDir, options, vscode);
    return { ok: true, sessionId: sess.sessionId, title: sess.title, isNew: sess.isNew, port: sess.port,
      resumed: sess.resumed, selectErr: sess.selectErr, scoped: sess.scoped };
  } catch (e) {
    // permanent=true 表示重试也不会好（CLI 不存在、配置缺项这类）。
    // activate 的循环据此立即停，别把 5×10s 全耗在必然失败的事上。
    return { ok: false, error: e.message, permanent: !!e.permanent };
  }
}

module.exports = {
  findOpencodeCli, resolveOpencodeCli, workbuddyNodeBinDirs, ensureServer, resolveModels, probeModel, pickWorkingModel, resolveSession, injectToSession, autoInject, getCurrentSession,
  listOpencodePorts, findRunningServer, SERVER_PORT,
  // 导出供测试/诊断：HTTP 层、重试层与窗口级 server 识别（多窗口修复的验证入口）
  httpReq, callServer, isRetryableNetErr, isTimeoutErr, broadcastSelectSession, switchTuiSession,
  findOwnWindowServer, terminalEnvPorts
};
