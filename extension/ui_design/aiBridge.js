// Author: Airtl yu
// Contact: yuairtl@outlook.com

"use strict";
// aiBridge.js — AI 工具选择 + 提示词投递的统一入口
//
// 【为什么要有这一层】注入点有 7 个（4 个流程 + IP 端口抓取 + 模块讲解 + 导出仿真），
// 每个都要做同样四件事：读配置选工具、用 prompts.js 组装提示词、装好技能、调对应适配器。
// 散在各处必然漂移，故收口到一个函数。
//
// 【工具无关】本文件只认 adapters/ 注册表，不认识任何一个具体工具。加新工具 = 在
// adapters/ 里加一个对象（或让用户配一条命令模板走 makeGenericCli），本文件一行不用改。
//
// 【分层】system = 全局硬规则 + 本流程技能正文（点这次 UI 时才组装，走 --append-system-prompt-file
// / system 字段）；message = 流程约定 + 任务句 + 环境事实。技能正文进 system 而不是让 AI
// 自己 Read：零额外往返、不依赖模型配合、且每个工具都收系统提示词所以无需工具特异分支。
//
// 【能力降级】caps.systemPrompt=false 的工具，由本文件把 system 内容前置到 message——
// 一处处理，不在各适配器里重复。

const prompts = require('./prompts');
const gc = require('./globalConfig');
const defaults = require('./extractSkills');
const adapters = require('./adapters');

// 配置解析。三级来源，优先级从高到低：
//   ① VSCode settings（vivadoProjectExplorer.<key>）—— 能在 Settings UI 里搜到/改，
//      但【必须确认是用户显式设的】才算数：这些键在 package.json 里都有 default，
//      没设过时 get() 返回的是 default 而不是 undefined，直接采用会让 ② 永远走不到。
//   ② C:/userconfig/rtlassistant/config.json 的 ai 段 —— 全局配置集中放置，手改。
//      （TASKS.md「用户要求硬编码路径集中放置」；此前只有 vivado 路径和技能在那儿，
//        ai.* 散在 VSCode settings，同类配置两个家，现收拢。）
//   ③ 代码默认值 dft。
// 例：config.json 里写 { "ai": { "tool": "opencode", "dsh": { "command": "dsh run {message}" } } }
//     即可把工具选择/命令模板集中在 userconfig，不必碰 VSCode settings。
function cfg(vscode, key, dft) {
  // ① VSCode settings（仅显式设置过才算）
  try {
    const conf = vscode.workspace.getConfiguration('vivadoProjectExplorer');
    const ins = conf.inspect(key);
    const explicit = !!ins && (ins.globalValue !== undefined || ins.workspaceValue !== undefined
      || ins.workspaceFolderValue !== undefined);
    if (explicit) {
      const v = conf.get(key);
      if (v !== undefined && v !== null) return v;
    }
  } catch (e) { /* 拿不到 VSCode 配置（测试/CLI）就退下一步 */ }
  // ② userconfig/config.json 的 ai 段（按点号路径逐层取）
  try {
    let node = (gc.getConfig() || {}).ai;
    for (const seg of String(key).split('.')) {
      if (node === undefined || node === null) { node = undefined; break; }
      node = node[seg];
    }
    if (node !== undefined && node !== null) return node;
  } catch (e) { }
  // ③ 代码默认值
  return dft;
}

// 探测优先级（TASKS.md 定：opencode > dsh）。配置指定了工具时以配置为准，
// 配置的工具不可用且开了 ai.autoFallback 才按这个顺序自动降级。
// 【'claude' 为什么不在里面】Claude Code 适配器已停用，不再随插件交付
// （见 adapters/builtin.js 顶部说明）。留着它只会让自动降级挑一个不存在的工具。
const PRIORITY = ['opencode', 'dsh', 'zcode'];

// 曾经支持、当前版本主动停用的工具。
// 【为什么要单列一个集合】直接从注册表删掉的话，配了 ai.tool=claude 的用户会
// 看到"未知 AI 工具: claude"——那是在暗示他打错了字，而他是照着旧设置/旧文档配的。
// 但也不能把它留在注册表里：adapters.ids() 会把它列进"可用工具"报错文案，
// 等于骗人。所以在这里给它一句准确的话，并让 autoFallback 照常生效
// （用户开了自动降级，就该降级，而不是卡在一个已停用的工具上）。
const DISABLED = new Set(['claude']);

// 这些功能不绑定技能（诊断/测试类，全局规则就够）。没有技能可 ensure，也不该报错。
const NO_SKILL = new Set(['test']);

// settings 驱动的通用 CLI 适配器：dsh / zcode / generic。
// 这三个没有内置实现（本机没装、接口未实测，猜着写等于造故障），让用户配一条命令模板。
// regist 按 id 覆盖，所以每次 pickTool 重注册是幂等的——用户在 settings 里改模板立即生效。
function ensureGenericAdapters(vscode) {
  for (const id of ['dsh', 'zcode', 'generic']) {
    const command = cfg(vscode, 'ai.' + id + '.command', '');
    if (command && String(command).trim()) {
      adapters.makeGenericCli({
        id, label: id + '（通用 CLI）', command: String(command),
        // 模板里出现 {systemFile} 才认为它收系统提示词；否则降级成前置进 message
        systemPrompt: /\{systemFile\}/.test(String(command)),
        sessionResume: /\{session\}/.test(String(command)),
      });
    } else {
      adapters.REGISTRY.delete(id);   // 模板被清空 → 该工具重新变为不可用
    }
  }
}

// 选工具。返回 { ok, adapter, reason }
async function pickTool(vscode) {
  ensureGenericAdapters(vscode);
  const want = cfg(vscode, 'ai.tool', 'opencode');
  // 配了已停用的工具。两种走法：
  //   autoFallback 关 → 明说"已停用"（别让人以为打错了字），不降级；
  //   autoFallback 开 → 和"工具不可用"同等对待，继续往下走自动降级。
  // 【为什么必须让停用工具绕过下面那个 else if (want)】那一支返回"未知 AI 工具"，
  // 一返回整个函数就结束了，自动降级永远走不到。第一版就是在这儿错的：注释写着
  // "开了就接着往下走自动降级"，代码却让它掉进"未知工具"，实测 autoFallback=开
  // 时拿到的是"未知 AI 工具: claude"。停用 ≠ 拼错，两者必须分开说。
  // 【!adapters.get(want) 这个条件是防御】将来若有人把 claude 适配器注册回来
  // （开发树里文件还在），以注册表为准，不当成停用。
  const wantDisabled = DISABLED.has(want) && !adapters.get(want);
  let a = adapters.get(want);
  if (a) {
    let ok = false;
    try { ok = await a.detect(vscode); } catch (e) { ok = false; }
    if (ok) {
      const pf = a.preflight ? await a.preflight() : { ok: true };
      if (pf.ok) return { ok: true, adapter: a };
      return { ok: false, adapter: a, reason: pf.reason };
    }
    // 配置的工具不可用
    if (!cfg(vscode, 'ai.autoFallback', false)) {
      return { ok: false, adapter: a, reason: a.availabilityError || (a.label + ' 当前不可用（配置 vivadoProjectExplorer.ai.tool 可切换；'
        + '已注册工具: ' + adapters.ids().join(', ') + '）') };
    }
  } else if (want && !wantDisabled) {
    return { ok: false, adapter: null, reason: '未知 AI 工具: ' + want + '（已注册: ' + adapters.ids().join(', ') + '）' };
  } else if (wantDisabled && !cfg(vscode, 'ai.autoFallback', false)) {
    return { ok: false, adapter: null,
      reason: want + ' 当前版本已停用（不再随插件交付）。可用工具: '
        + adapters.ids().join(', ') };
  }
  // 自动降级：按优先级找第一个可用的
  const found = await adapters.detectFirst(PRIORITY, vscode);
  if (!found) {
    return { ok: false, adapter: null, reason: '没有可用的 AI 工具（已注册 ' + adapters.ids().length
      + ' 个，都探测失败）。装一个，或在 settings 里给通用 CLI 适配器配命令模板。' };
  }
  const pf = found.preflight ? await found.preflight() : { ok: true };
  if (!pf.ok) return { ok: false, adapter: found, reason: pf.reason };
  return { ok: true, adapter: found, auto: true };
}

// ── 统一注入 ──
// feature：功能名（simulate/synth/impl/bit/ip-port-fetch/module-explain/export-to-sim）
// vars  ：提示词占位符（projDir/vivado/vivadoDir/task/object/branch/extra/srcFile…）
// 返回 { ok, tool, sessionId, reply, isNew, resumed, error }
async function inject(vscode, workspaceDir, feature, vars) {
  const v = vars || {};
  if (!cfg(vscode, 'ai.enabled', true)) {
    return { ok: false, error: 'AI 联动已关闭（配置 vivadoProjectExplorer.ai.enabled）' };
  }
  const pick = await pickTool(vscode);
  if (!pick.ok) return { ok: false, error: pick.reason, tool: pick.adapter ? pick.adapter.id : undefined };

  // 环境事实每次现取（会变：工程目录 / Vivado 版本），不写死进提示词文件
  const conf = gc.getConfig() || {};
  const base = Object.assign({}, v, {
    projDir: v.projDir || workspaceDir,
    vivado: v.vivado || conf.vivado || '',
    vivadoDir: v.vivadoDir || conf.vivadoDir || '',
  });

  // 技能正文要并进 system，前提是全局配置目录里有这份副本；激活时的全量同步可能没跑到
  // （用户手动清了目录 / 换机器首次用），这里兜一次。【必须在 buildPrompt 之前】——
  // 以前放在后面，副本是真没有时只能把整个 opts 再抄一遍重组装，两处必然漂移。
  const skillName = v.skill || feature;
  const needSkill = !NO_SKILL.has(feature) && v.skill !== '';
  if (needSkill) {
    const sk = defaults.ensureSkill(skillName);
    if (!sk.ok) {
      return { ok: false, error: '技能 ' + skillName + ' 不可用：' + (sk.reason || '安装失败'), tool: pick.adapter.id };
    }
  }
  const p = prompts.buildPrompt(feature, base);
  if (needSkill && !p.hasSkill) {
    return { ok: false, error: '技能 ' + skillName + ' 正文读不到（' + p.skillPath + '）', tool: pick.adapter.id };
  }

  // 能力降级：工具不收系统提示词 → 把 system 前置进 message
  let payload = { system: p.system, message: p.message };
  if (pick.adapter.caps && pick.adapter.caps.systemPrompt === false && p.system) {
    payload = {
      system: '',
      message: ['系统规则：', p.system, '', '用户任务：', p.message].join('\n'),
    };
  }

  const r = await pick.adapter.inject(payload, {
    workspaceDir, vscode, sessionId: v.sessionId || null, timeoutMs: v.timeoutMs || 0,
  });
  return {
    ok: r.ok, tool: pick.adapter.id, sessionId: r.sessionId, reply: r.reply,
    isNew: r.isNew, resumed: r.resumed, tuiSwitched: r.tuiSwitched, error: r.error,
    auto: !!pick.auto,
  };
}

module.exports = { inject, pickTool, cfg, PRIORITY, DISABLED, NO_SKILL };
