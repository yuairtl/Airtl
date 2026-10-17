'use strict';
// Author: Airtl yu
// Contact: yuairtl@outlook.com
// globalConfig.js — 插件全局配置（C:/userconfig/rtlassistant/）
// 作用：集中存放【全局路径与真实副本】——vivado 路径、技能、系统提示词，与具体工程解耦，用户可改。
//
// 目录结构（用户要求硬编码路径集中放置；这里是唯一真实副本源，仓库只带出厂默认）：
//   C:/userconfig/rtlassistant/
//     config.json              ← { vivado: "…/vivado.bat", … }（首次生成，探测真实路径）
//     ip-ports.json            ← AI 抓取的 IP 端口方向数据（跨工程共享，可热更新）
//     ipdowns/                 ← IP 手册 PDF 下载目录
//     system.md                ← 全局系统提示词（真实副本）
//     flow.md                  ← Vivado 流程共享约定（真实副本）
//     tasks/<feature>.md       ← 用户层任务句模板（真实副本；文件名等具体值点击时才有）
//     skills/<name>/SKILL.md   ← 技能正文（真实副本，用户可改；同目录脚本一起拷贝）
//     .vivado-manifest.json    ← 安装清单（区分「用户改过」与「扩展更新了」，见 extractSkills.js）
//
// ⚠️ 系统提示词为什么在这里只是副本：system 层经 --append-system-prompt-file 内联进请求，
//    它本身【不能】再触发一次技能读取（技能只能由对话里的模型调用）。所以 system.md /
//    flow.md 存的是供扩展读取并内联的副本，不走技能机制。
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = 'C:/userconfig/rtlassistant';   // 用户指定全局配置目录
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// 探测 Vivado（常见安装目录，取最新版本）
// 【已收敛到 ui_design/vivado.js】这里原来自己写了一份 bases + 版本排序。
// 同一逻辑曾有 4 份（本处 / webviewProvider.findVivadoBin /
// blockgraph._vivadoLibDirs / Airtl 的 VivadoLibDirs），改一处漏三处。
// 现在只留一处，本函数作兼容壳——外部（含测试）仍在调 probeVivado()。
// 【设置项优先】vivadoProjectExplorer.vivadoPath 由调用方经 setting 传入；
// 本文件不依赖 vscode，所以设置读取留在调用方。
function probeVivado(setting) {
  const e = require('./vivado').probe(setting);
  return e ? { exe: e, dir: require('path').dirname(require('path').dirname(e)) } : null;
}

// 生成/读取全局配置（首次探测 Vivado 写入）
// 【为什么 config.json 不随插件包】它是【本机】事实（Vivado 装在哪），
// 首次运行探测生成即可，发出去反而是错的。用户可手改——只有文件不存在时才写，
// 手改不会被覆盖。
// 【vivado 路径的最终来源】vivadoProjectExplorer.vivadoPath 设置项 > config.json
// 里已存的值 > 探测。前两者由调用方（webviewProvider 等）经 setting 传进来。
function getConfig(setting) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
      const v = probeVivado(setting);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(
        { vivado: v ? v.exe : '', vivadoDir: v ? v.dir : '' }, null, 2), 'utf8');
    }
    // 设置项优先于已存文件：用户改了设置要立刻生效，不必先删 config.json
    if (setting && String(setting).trim()) {
      const v = probeVivado(setting);
      if (v) return Object.assign({}, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')), { vivado: v.exe, vivadoDir: v.dir });
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) { return {}; }
}

// 【getVivado 原来零调用方】写了没人用，等于探测白做。现在 webviewProvider
// 的 findVivadoBin 改走这里，设置项 → config.json → 探测 三级取值。
function getVivado(setting) { return getConfig(setting).vivado || ''; }

// ── 提示词与技能的真实副本位置 ──
function getSkillsDir() { return path.join(CONFIG_DIR, 'skills'); }
function getSystemPromptPath() { return path.join(CONFIG_DIR, 'system.md'); }
function getFlowPromptPath() { return path.join(CONFIG_DIR, 'flow.md'); }
function getTasksDir() { return path.join(CONFIG_DIR, 'tasks'); }
function getTaskTemplatePath(feature) { return path.join(getTasksDir(), (feature || '') + '.md'); }
// 某个技能正文的绝对路径（注入消息里直接给 AI，让它 Read）
function getSkillPath(name) { return path.join(getSkillsDir(), name || '', 'SKILL.md'); }
// 安装清单：记录「本次扩展装上时的内容指纹」
function getManifestPath() { return path.join(CONFIG_DIR, '.vivado-manifest.json'); }

// 全局级 IP 端口数据文件（跨平台兼容）：
//   Windows：沿用用户指定的全局配置目录 C:/userconfig/rtlassistant/ip-ports.json
//   Linux  ：C:/ 在 Node 下会被当相对路径建脏目录，故改用用户主目录下 rtlassistant/ip-ports.json
// 读取（ipPortData.loadExternalPortData）与写入（AI 抓取工作流）均用此路径，保证两端一致。
function getIpPortsPath() {
  if (process.platform === 'win32') return path.join(CONFIG_DIR, 'ip-ports.json');
  return path.join(os.homedir(), 'rtlassistant', 'ip-ports.json');
}

// 全局级 IP 手册 PDF 下载目录（与 ip-ports.json 同根，跨平台一致）：
//   Windows：C:/userconfig/rtlassistant/ipdowns/
//   Linux  ：~rtlassistant/ipdowns/
function getIpDownloadsDir() {
  if (process.platform === 'win32') return path.join(CONFIG_DIR, 'ipdowns');
  return path.join(os.homedir(), 'rtlassistant', 'ipdowns');
}

module.exports = {
  CONFIG_DIR, CONFIG_PATH, getConfig, getVivado,
  getSkillsDir, getSystemPromptPath, getFlowPromptPath, getTasksDir,
  getTaskTemplatePath, getSkillPath, getManifestPath,
  getIpPortsPath, getIpDownloadsDir, probeVivado,
};
