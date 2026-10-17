// Author: Airtl yu
// Contact: yuairtl@outlook.com

'use strict';
// prompts.js — 注入内容组装。所有文本都从【全局配置目录的真实副本】读，仓库只带出厂默认。
//
// 【分层（2026-09-27 定案）】
//   system  全局硬规则 + 本流程技能正文   C:/userconfig/rtlassistant/system.md
//                                      + C:/userconfig/rtlassistant/skills/<名>/SKILL.md
//                            → system 字段（opencode）
//                            （曾经的 claude 走 --append-system-prompt-file，该适配器已停用）
//                            **点这次 UI 时才组装**，别的流程不带自己的技能
//   flow    Vivado 流程约定   …/flow.md → 进 user message，只对流程类功能
//   task    本次任务句        …/tasks/<feature>.md + 调用方点击时给的具体值 → 进 user message
//
// 【为什么技能正文走 system 而不是让 AI 自己 Read】
//   ① 零额外往返：内容第 1 轮就在上下文里，不依赖模型"配合去读文件"（它可能忘读/读错）；
//   ② 工具无关：每个 AI 工具都收系统提示词，不需要为每个工具单独接技能加载机制
//      （Skill 工具是 Claude Code 专属，Read 路径要对 opencode 另写一套）；
//   ③ 改技能内容下次注入立即生效——没有插件目录、没有注册、没有缓存。
//
// 【环境事实为什么在 message 不在 system】projDir / vivado 每次都可能变（切工程就变），
// 放 system 会打掉 prompt 缓存。Claude Code 自带开关 --exclude-dynamic-system-prompt-sections
// 做的就是这件事（把 cwd/env 信息从 system 移到第一条 user message）。

const fs = require('fs');
const path = require('path');
const gc = require('./globalConfig');
const { isPromptContent } = require('./promptContent');
// 占位符替换主体在 C++（Airtl fillTemplate）。
const airtl = require(path.join(__dirname, '..', 'Airtl', 'index.js'));

const PROMPT_ROOT = path.join(__dirname, '..', 'prompts');

// 只有这些功能的产物落在 rtlass/tb + rtlass/sims、且用 Vivado 批处理跑 → 需要 flow 约定。
// 新增功能时按同一判据加进来，不要图省事塞进全局层。
const FLOW_FEATURES = new Set(['simulate', 'synth', 'impl', 'bit', 'export-to-sim']);

// 读真实副本；副本不存在（首次还没同步）时退回扩展自带的出厂默认
function readLive(livePath, repoDefaultPath) {
  try {
    if (livePath && fs.existsSync(livePath)) {
      const value = fs.readFileSync(livePath, 'utf8');
      if (isPromptContent(value)) return value;
    }
  }
  catch (e) { /* 读不到就退默认 */ }
  try {
    if (repoDefaultPath && fs.existsSync(repoDefaultPath)) {
      const value = fs.readFileSync(repoDefaultPath, 'utf8');
      if (isPromptContent(value)) return value;
    }
  }
  catch (e) { }
  return '';
}

// 占位符替换：主体在 C++（Airtl fillTemplate）。
function fill(tpl, vars) {
  return airtl.fillTemplate(String(tpl || ''), vars || {});
}

// 全局硬规则（每个技能、每次任务都必须遵守的那几条）
function loadGlobalRules(o) {
  return fill(readLive(gc.getSystemPromptPath(), path.join(PROMPT_ROOT, '_base', 'system.md')), o);
}

// 本流程技能正文。livePath 不存在时退回扩展自带的 ref_skill/<名>/SKILL.md。
// 返回 '' = 没有这个技能（调用方决定是报错还是降级）。
function loadSkillBody(skill) {
  if (!skill) return '';
  return readLive(gc.getSkillPath(skill), path.join(PROMPT_ROOT, '..', 'ref_skill', skill, 'SKILL.md'));
}

function loadFlow(o) {
  return fill(readLive(gc.getFlowPromptPath(), path.join(PROMPT_ROOT, '_base', 'flow.md')), o);
}

function loadTaskTemplate(feature) {
  return readLive(gc.getTaskTemplatePath(feature), path.join(PROMPT_ROOT, feature, 'task.md'));
}

// ── 组装一次注入的提示词 ──
// opts: { projDir, vivado, vivadoDir, task, object, objectRaw, branch, extra, srcFile, skill, ... }
//   skill 缺省取 feature —— 需要技能名与功能名不一致时显式传。
// 返回 { system, message, skill, skillPath, feature, hasSkill }
//   system   给适配器的系统提示词（全局规则 + 技能正文）
//   message  user message（流程约定 + 任务句 + 环境事实）
function buildPrompt(feature, opts) {
  const o = opts || {};
  const skill = o.skill || feature;
  const skillPath = gc.getSkillPath(skill);

  // ① system 层：全局硬规则 + 本流程技能正文（点这次 UI 时才组装）
  const rules = loadGlobalRules(o);
  const body = loadSkillBody(skill);
  const system = [rules, body]
    .filter(Boolean).join('\n\n');

  // ② message 层
  const parts = [];
  if (FLOW_FEATURES.has(feature)) {
    const flow = loadFlow(o);
    if (flow) parts.push(flow);
  }
  // 任务句。调用方传的 task 文本：模板没用 {task} 消费它时就追加。
  // 【修复的静默丢失 BUG】simulate/synth/impl/bit 的 task.md 原先没有 {task} 占位符，
  // workflowProvider 拼出的「xpr 路径 + tb 文件列表 + 引脚约束路径」被整体丢弃。
  const tpl = loadTaskTemplate(feature);
  let task = fill(tpl, o);
  if (o.task && task.indexOf(o.task) < 0) task = [task, o.task].filter(Boolean).join('\n\n');
  if (!task) task = '__AIRT_PROMPT__:' + feature;
  parts.push(task);

  // ③ 运行时环境事实（每次现取，会变 → 不放 system，见文件头）
  // 这些路径是给 AI 阅读的任务上下文，不是传输协议；不要序列化成可见的 JSON。
  const env = [];
  if (o.projDir) env.push('工程目录：' + o.projDir);
  if (o.vivado) env.push('Vivado 可执行文件：' + o.vivado);
  if (o.vivadoDir) env.push('Vivado 安装目录：' + o.vivadoDir);
  if (o.extra) env.push('补充信息：' + String(o.extra));
  if (env.length) parts.push(env.join('\n'));

  return {
    system,
    message: parts.filter(Boolean).join('\n\n'),
    skill, skillPath, feature, hasSkill: !!body,
  };
}

module.exports = {
  PROMPT_ROOT, FLOW_FEATURES, buildPrompt, fill,
  loadGlobalRules, loadSkillBody, loadFlow, loadTaskTemplate, readLive,
};
