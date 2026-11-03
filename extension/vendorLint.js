'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const SNAPSHOT_MARKER = '__AIRTL_UNSAVED_SOURCE__';

function samePath(left, right) {
  const a = path.resolve(left).replace(/\\/g, '/');
  const b = path.resolve(right).replace(/\\/g, '/');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function listFiles(context, currentFile) {
  const out = [];
  const seen = new Set();
  const add = value => {
    if (!value || !/\.(?:v|sv)$/i.test(value)) return;
    const resolved = path.resolve(value);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(resolved);
  };
  for (const item of context.files || []) add(typeof item === 'string' ? item : item && item.path);
  add(currentFile);
  return out;
}

function scalarArgs(templates, values) {
  return (Array.isArray(templates) ? templates : []).map(arg => String(arg).replace(
    /\{(file|projectRoot|top|target|standard|includeDirs|defines|files|libraryDirs|libraryFiles|libraryExtensions|libraryNames)\}/g,
    (_match, key) => values[key] === undefined ? '' : String(values[key])));
}

function buildInvocation({ vendor, settings, context, project, filePath, snapshotPath, workspaceRoot, cwd }) {
  const executable = String(settings.toolPath || '').trim();
  if (!executable) throw new Error('请先设置 airtl.systemverilog.lint.toolPath。');
  let sourceFiles = listFiles(context, filePath);
  if (vendor === 'verilator') {
    sourceFiles = sourceFiles.filter(file => samePath(file, filePath) ||
      !(context.libraryFiles || []).some(libraryFile => samePath(file, libraryFile)));
  }
  const files = sourceFiles.map(file => samePath(file, filePath) ? snapshotPath : file);
  const includeDirs = [...new Set([...(context.includeDirs || []), path.dirname(filePath)])];
  const defines = context.defines || [];
  const libraryDirs = context.libraryDirs || [];
  const libraryFiles = context.libraryFiles || [];
  const libraryExtensions = context.libraryExtensions || [];
  const libraryNames = context.libraryNames || [];
  const values = {
    file: snapshotPath,
    projectRoot: project && project.projectDir || workspaceRoot,
    top: context.top || project && (project.designTop || project.top) || '',
    target: settings.target || 'synthesis',
    standard: settings.standard || '1800-2017',
    includeDirs: includeDirs.join(';'),
    defines: defines.join(';'),
    files: files.join(';'),
    libraryDirs: libraryDirs.join(';'),
    libraryFiles: libraryFiles.join(';'),
    libraryExtensions: libraryExtensions.join(';'),
    libraryNames: libraryNames.join(';'),
  };
  let args;
  if (vendor === 'verilator') {
    args = ['--lint-only', '--sv', '-Wno-fatal'];
    if (values.top) args.push('--top-module', values.top);
    for (const directory of includeDirs) args.push(`-I${directory}`);
    for (const define of defines) args.push(`-D${define}`);
    for (const directory of libraryDirs) args.push('-y', directory);
    for (const file of libraryFiles) args.push('-v', file);
    if (libraryExtensions.length) args.push(`+libext+${libraryExtensions.join('+')}`);
    args.push(...files);
  } else if (vendor === 'vivado') {
    args = ['-sv', '-nolog'];
    for (const directory of includeDirs) args.push('-i', directory);
    for (const define of defines) args.push('-d', define);
    args.push(...files);
  } else if (vendor === 'custom' || vendor === 'quartus') {
    if (!Array.isArray(settings.toolArgs) || !settings.toolArgs.length)
      throw new Error(`${vendor} 检查需要在 airtl.systemverilog.lint.toolArgs 中提供参数数组。`);
    args = scalarArgs(settings.toolArgs, values);
  } else {
    throw new Error(`未实现外部检查后端：${vendor || '(none)'}`);
  }
  return { executable, args, cwd, files, includeDirs, defines, target: values.target, snapshotMarker: snapshotPath };
}

function parseDiagnostics(output, vendor) {
  const diagnostics = [];
  const lines = String(output || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Vivado VRFC reports source locations in a trailing bracket, for example:
    // ERROR: [VRFC 10-4982] syntax error near 'assign' [C:/rtl/top.sv:12]
    if (vendor === 'vivado') {
      const prefix = /^(ERROR|FATAL|WARNING|CRITICAL WARNING):\s*\[([^\]]+)\]\s*/i.exec(trimmed);
      // Keep the path capture inside the trailing location bracket. A greedy
      // capture must not cross the earlier `[VRFC ...]` diagnostic-code block.
      const location = /\s+\[([^\]\r\n]+):(\d+)(?::(\d+))?\]\s*$/.exec(trimmed);
      if (prefix && location) {
        diagnostics.push({
          file: location[1],
          line: Math.max(0, Number(location[2]) - 1),
          column: Math.max(0, Number(location[3] || 1) - 1),
          length: 1,
          severity: /^(?:ERROR|FATAL)$/i.test(prefix[1]) ? 2 : 1,
          code: `vivado:${prefix[2].trim()}`,
          source: 'vivado',
          message: trimmed.slice(prefix[0].length, location.index).trim() || trimmed,
        });
        continue;
      }
    }

    let kind = /\bfatal\b|%Fatal/i.test(trimmed) ? 'fatal'
      : /\berror\b|%Error/i.test(trimmed) ? 'error'
        : /\bwarning\b|%Warning/i.test(trimmed) ? 'warning'
          : /\bnote\b/i.test(trimmed) ? 'note' : 'info';
    let payload = trimmed
      .replace(/^(?:%?(?:fatal|error|warning|note|info))\s*:\s*/i, '')
      .replace(/^(?:critical\s+warning|error|warning):\s*/i, '')
      .replace(/^\[[^\]]+\]\s*/, '');
    // Parse the two coordinate forms separately. With one optional column,
    // the greedy path capture can absorb the line number from "file:line:col"
    // (especially on Windows paths), preventing temporary-buffer remapping.
    let match = /^(.*):(\d+):(\d+):\s*(.*)$/i.exec(payload);
    if (!match) {
      const lineOnly = /^(.*):(\d+):\s*(.*)$/i.exec(payload);
      if (lineOnly) match = [lineOnly[0], lineOnly[1], lineOnly[2], '1', lineOnly[3]];
    }
    let toolCode = '';
    if (!match && vendor === 'quartus') {
      const qmatch = /^(?:Error|Warning)\s*\(([^)]*)\):.*?\b(?:at|in)\s+(.+?)\((\d+)\)(?:\s+near\s+text\s+"([^"]*)")?.*$/i.exec(trimmed);
      if (qmatch) {
        match = [qmatch[0], qmatch[2], qmatch[3], '1', qmatch[4] || trimmed];
        toolCode = qmatch[1];
      }
    }
    if (!match) continue;
    const file = match[1];
    const lineNumber = Number(match[2]);
    const columnNumber = Number(match[3] || 1);
    diagnostics.push({
      file,
      line: Math.max(0, lineNumber - 1),
      column: Math.max(0, columnNumber - 1),
      length: 1,
      severity: kind === 'error' || kind === 'fatal' ? 2 : kind === 'warning' ? 1 : 0,
      code: `${vendor || 'custom'}:${toolCode || 'tool'}`,
      source: vendor || 'custom',
      message: (vendor === 'quartus' ? match[4] : match[4]) || trimmed,
    });
  }
  return diagnostics;
}

function startVendorLint({ invocation, vendor, snapshotText, snapshotName, timeoutMs, onStart }) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'airtl-vendor-lint-'));
  const snapshotPath = path.join(temporaryRoot, path.basename(snapshotName));
  fs.writeFileSync(snapshotPath, snapshotText, 'utf8');
  const args = invocation.args.map(arg => String(arg).split(invocation.snapshotMarker || SNAPSHOT_MARKER).join(snapshotPath));
  let executable = invocation.executable;
  let launchArgs = args;
  if (vendor === 'vivado') {
    // xvlog's Windows batch launcher cannot be started directly with shell:false,
    // and -d NAME=value is mis-split by some Vivado command-line versions.
    // Its documented -f response file handles both macro values and paths with spaces.
    const responsePath = path.join(temporaryRoot, 'xvlog.rsp');
    const responseArgs = args.map(value => {
      const text = String(value);
      if (/[\r\n]/.test(text) || text.includes('"'))
        throw new Error('Vivado xvlog response arguments cannot contain line breaks or embedded double quotes.');
      return `"${text}"`;
    });
    fs.writeFileSync(responsePath, responseArgs.join('\r\n') + '\r\n', 'utf8');
    launchArgs = ['-f', responsePath];
    if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(executable)) {
      // Keep HDL paths and flags in the response file; the batch wrapper only
      // sees the trusted install path and our generated temporary response path.
      if (/[\r\n%"]/.test(executable) || /[\r\n%"]/.test(responsePath))
        throw new Error('Vivado batch-launch paths cannot contain percent signs, quotes, or line breaks.');
      const launcherPath = path.join(temporaryRoot, 'launch-xvlog.cmd');
      fs.writeFileSync(launcherPath,
        `@echo off\r\ncall "${executable}" -f "${responsePath}"\r\nexit /b %ERRORLEVEL%\r\n`,
        'ascii');
      executable = process.env.ComSpec || 'cmd.exe';
      launchArgs = ['/d', '/c', launcherPath];
    }
  }
  let child;
  let timer;
  let cancelled = false;
  let timedOut = false;
  let settled = false;
  let stdout = '';
  let stderr = '';
  const promise = new Promise((resolve, reject) => {
    try {
      child = spawn(executable, launchArgs, {
        cwd: temporaryRoot,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      reject(error);
      return;
    }
    if (onStart) onStart(child);
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-2 * 1024 * 1024);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      const output = [stdout, stderr].filter(Boolean).join('\n');
      const diagnostics = parseDiagnostics(output, vendor).map(item => {
        const resolved = path.resolve(temporaryRoot, item.file);
        if (samePath(item.file, snapshotPath) || samePath(resolved, snapshotPath))
          return { ...item, file: snapshotName };
        return item;
      });
      resolve({
        cancelled,
        timedOut,
        exitCode: code,
        signal,
        output,
        diagnostics,
      });
    });
    timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        if (child.kill()) return;
        child.kill('SIGKILL');
      }
    }, Math.max(1000, Math.min(120000, Number(timeoutMs) || 30000)));
  });
  return {
    promise,
    cancel() {
      if (settled || !child) return;
      cancelled = true;
      child.kill();
    },
    snapshotPath,
  };
}

module.exports = { SNAPSHOT_MARKER, buildInvocation, parseDiagnostics, startVendorLint };
