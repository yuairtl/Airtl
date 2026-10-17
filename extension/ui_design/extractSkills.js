// Author: Airtl yu

// Contact: yuairtl@outlook.com
'use strict';
// extractSkills.js — 把扩展自带的【出厂默认】装进全局配置目录 C:/userconfig/rtlassistant/
//
//   源（扩展内，随 vsix 发布）          目标（用户可改的真实副本）
//   ref_skill/<name>/              →    skills/<name>/          （技能正文 + 同目录脚本）
//   prompts/_base/system.md        →    system.md               （全局系统提示词副本）
//   prompts/_base/flow.md          →    flow.md                 （流程共享约定副本）
//   prompts/<feature>/task.md      →    tasks/<feature>.md      （用户层任务句模板）
//
// 【为什么技能放这里而不是 AI 工具的 skills 目录】任务规划（TASKS.md）明确要求硬编码路径
// 集中放置，全局配置目录是唯一真实副本源。AI 工具自己的技能发现目录（如 Claude Code 的
// ~/.claude/skills/）不读这个位置，但注入消息会直接把 <目标>/skills/<name>/SKILL.md 的
// 绝对路径给 AI，让它 Read 后执行——本来就不依赖自动发现。
// （2026-09-27 曾改成装到 ~/.claude/skills/ 依赖 Claude Code 自动发现，属于偏离规划，已回退。）
//
// 【为什么 system.md 在这里只是副本】系统提示词经 --append-system-prompt-file 内联进请求，
// 它本身不能再触发一次技能读取（技能只能由对话里的模型调用）。所以 system/flow 存的是
// 供扩展读取并内联的副本，不走技能机制。
//
// 【更新策略】安装清单 .vivado-manifest.json 记录本次装上的内容指纹：
//   已安装 == 清单 == 扩展自带   → 已是最新，不动
//   已安装 == 清单，扩展自带变了 → 覆盖更新（用户没动过）
//   已安装 != 清单               → 用户改过，保留
//   无清单记录（一次性迁移）      → 采用扩展自带版本并补记清单

const fs = require('fs');
const path = require('path');
const gc = require('./globalConfig');
const { isPromptContent } = require('./promptContent');

// 手动递归拷贝：不用 fs.cpSync（Node 16.7+ 才有，扩展 engines.vscode ^1.60 对应 Node 14）
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const en of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, en.name);
    const d = path.join(dst, en.name);
    if (en.isDirectory()) copyDir(s, d);
    else if (en.isFile()) fs.copyFileSync(s, d);
  }
}

// 扩展自带的出厂默认根
function defaultsRoot() {
  return path.join(__dirname, '..');
}

// 内容指纹：大小 + 简单校验和（不引 crypto，保持零依赖）
function digest(p) {
  try {
    const b = fs.readFileSync(p);
    let h = 0;
    for (let i = 0; i < b.length; i++) h = ((h * 31) + b[i]) | 0;
    return b.length + ':' + (h >>> 0).toString(36);
  } catch (e) { return ''; }
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(gc.getManifestPath(), 'utf8')); }
  catch (e) { return {}; }
}

function writeManifest(m) {
  try {
    fs.mkdirSync(gc.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(gc.getManifestPath(), JSON.stringify(m, null, 2), 'utf8');
  } catch (e) { /* 清单写失败不影响安装本身 */ }
}

// 安装一个「目录型」条目（技能：整目录拷贝，键 = 目录名）
// key 用于清单记账；srcDir 源目录；dstDir 目标目录；marker 目录内的标志文件
function installDirItem(key, srcDir, dstDir, marker) {
  const srcMarker = path.join(srcDir, marker);
  if (!fs.existsSync(srcMarker)) return { ok: false, reason: '默认源缺 ' + marker + ': ' + srcDir };
  const dstMarker = path.join(dstDir, marker);
  const man = readManifest();
  const srcD = digest(srcMarker);
  const installed = fs.existsSync(dstMarker);
  if (installed) {
    if (!isPromptContent(fs.readFileSync(srcMarker, 'utf8'))
      && isPromptContent(fs.readFileSync(dstMarker, 'utf8'))) return { ok: true, skipped: true };
    const d = digest(dstMarker);
    if (man[key] !== undefined) {
      if (d !== man[key]) return { ok: true, skipped: true };        // 用户改过 → 保留
      if (d === srcD) return { ok: true, skipped: true, upToDate: true };  // 已是最新
    }
    // 无清单记录（一次性迁移）→ 采用扩展自带版本
  }
  try {
    copyDir(srcDir, dstDir);
    if (!fs.existsSync(dstMarker)) return { ok: false, reason: '拷贝后仍未找到 ' + marker };
    man[key] = srcD;
    writeManifest(man);
    return { ok: true, skipped: false, updated: installed };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// 安装一个「单文件」条目（system.md / flow.md / tasks/<f>.md）
function installFileItem(key, srcFile, dstFile) {
  if (!fs.existsSync(srcFile)) return { ok: false, reason: '默认源不存在: ' + srcFile };
  const man = readManifest();
  const srcD = digest(srcFile);
  const installed = fs.existsSync(dstFile);
  if (installed) {
    if (!isPromptContent(fs.readFileSync(srcFile, 'utf8'))
      && isPromptContent(fs.readFileSync(dstFile, 'utf8'))) return { ok: true, skipped: true };
    const d = digest(dstFile);
    if (man[key] !== undefined) {
      if (d !== man[key]) return { ok: true, skipped: true };
      if (d === srcD) return { ok: true, skipped: true, upToDate: true };
    }
  }
  try {
    fs.mkdirSync(path.dirname(dstFile), { recursive: true });
    fs.copyFileSync(srcFile, dstFile);
    man[key] = srcD;
    writeManifest(man);
    return { ok: true, skipped: false, updated: installed };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// 全量同步出厂默认 → 全局配置目录。返回 { synced, skipped, updated, failed }
function installDefaults() {
  const root = defaultsRoot();
  const synced = [], skipped = [], updated = [], failed = [];

  // ① 技能：ref_skill 下每个含 SKILL.md 的子目录 = 一个技能，不硬编码技能名
  try {
    for (const en of fs.readdirSync(path.join(root, 'ref_skill'), { withFileTypes: true })) {
      if (!en.isDirectory()) continue;
      const src = path.join(root, 'ref_skill', en.name);
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
      const r = installDirItem('skills/' + en.name, src, path.join(gc.getSkillsDir(), en.name), 'SKILL.md');
      if (r.skipped) skipped.push('skills/' + en.name);
      else if (r.updated) updated.push('skills/' + en.name);
      else if (r.ok) synced.push('skills/' + en.name);
      else failed.push('skills/' + en.name + ':' + r.reason);
    }
  } catch (e) { failed.push('skills:' + e.message); }

  // ② 提示词副本：system.md / flow.md（单文件）
  for (const [key, src, dst] of [
    ['system.md', path.join(root, 'prompts', '_base', 'system.md'), gc.getSystemPromptPath()],
    ['flow.md', path.join(root, 'prompts', '_base', 'flow.md'), gc.getFlowPromptPath()],
  ]) {
    const r = installFileItem(key, src, dst);
    if (r.skipped) skipped.push(key);
    else if (r.updated) updated.push(key);
    else if (r.ok) synced.push(key);
    else failed.push(key + ':' + r.reason);
  }

  // ③ 用户层任务句模板：prompts/<feature>/task.md → tasks/<feature>.md
  try {
    for (const en of fs.readdirSync(path.join(root, 'prompts'), { withFileTypes: true })) {
      if (!en.isDirectory() || en.name.startsWith('_')) continue;
      const src = path.join(root, 'prompts', en.name, 'task.md');
      if (!fs.existsSync(src)) continue;
      const key = 'tasks/' + en.name;
      const r = installFileItem(key, src, gc.getTaskTemplatePath(en.name));
      if (r.skipped) skipped.push(key);
      else if (r.updated) updated.push(key);
      else if (r.ok) synced.push(key);
      else failed.push(key + ':' + r.reason);
    }
  } catch (e) { failed.push('tasks:' + e.message); }

  return { synced, skipped, updated, failed };
}

// 注入前确保某个技能的副本在全局配置目录里（激活时的全量同步可能没跑到）
function ensureSkill(name) {
  if (!name) return { ok: false, reason: '未给技能名' };
  const p = gc.getSkillPath(name);
  const configured = () => isPromptContent(fs.readFileSync(p, 'utf8'));
  const missing = () => ({ ok: false, path: p, reason: '技能正文尚未配置（文件为空或仅含“需写入prompts”占位符）: ' + p });
  try { if (fs.existsSync(p)) return configured() ? { ok: true, path: p } : missing(); } catch (e) { }
  const r = installDirItem('skills/' + name,
    path.join(defaultsRoot(), 'ref_skill', name), path.join(gc.getSkillsDir(), name), 'SKILL.md');
  if (!r.ok) return { ok: false, reason: r.reason || '安装失败' };
  try { return configured() ? { ok: true, path: p } : missing(); }
  catch (e) { return { ok: false, path: p, reason: e.message }; }
}

function main() {
  const r = installDefaults();
  console.log('出厂默认 → ' + gc.CONFIG_DIR + ' ：');
  console.log('  新增:', r.synced.join(', ') || '无');
  console.log('  更新(用户未改动):', r.updated.join(', ') || '无');
  console.log('  已存在且用户改过(保留):', r.skipped.join(', ') || '无');
  if (r.failed.length) console.log('  失败:', r.failed.join(', '));
}

module.exports = {
  installDefaults, ensureSkill, installDirItem, installFileItem,
  copyDir, digest, readManifest, writeManifest, defaultsRoot,
};
if (require.main === module) main();
