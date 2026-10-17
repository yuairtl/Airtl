// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = (vscode, zh, en) => /^zh/i.test(vscode.env && vscode.env.language || '') ? zh : en;

async function terminalPid(terminal) {
  // Restored/closing terminals can leave processId unresolved. Never let one
  // stale terminal block AI initialization (or unrelated editor actions).
  let timer;
  try {
    return await Promise.race([Promise.resolve(terminal.processId), new Promise(resolve => {
      timer = setTimeout(() => resolve(undefined), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

// Inspect only descendants of this window's terminal shells. A TUI can be healthy
// without a TCP listener: OpenCode 1.18 defaults to its in-process transport.
function terminalProcessState(pids) {
  const roots = pids.filter(p => Number.isSafeInteger(p) && p > 0);
  if (!roots.length) return Promise.resolve({ processes: [], ports: [] });
  const ps = '$ErrorActionPreference="Stop";' +
    '$roots=@(' + roots.join(',') + ');' +
    '$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine;' +
    '$kids=@{}; foreach($p in $all){ $k=[int]$p.ParentProcessId; if(-not $kids.ContainsKey($k)){ $kids[$k]=@() }; $kids[$k]+=$p };' +
    '$stack=New-Object System.Collections.Stack; foreach($r in $roots){ $stack.Push([int]$r) };' +
    '$targets=@{}; $items=@();' +
    'while($stack.Count -gt 0){ $cur=[int]$stack.Pop(); if($kids.ContainsKey($cur)){ foreach($c in $kids[$cur]){' +
    '$cid=[int]$c.ProcessId; if($c.Name -eq "opencode.exe"){ $targets[$cid]=$true; $items+=@{id=$cid; commandLine=$c.CommandLine} }; $stack.Push($cid) } } };' +
    '$ports=@(); if($targets.Count){ $ports=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.LocalAddress -eq "127.0.0.1" -and $targets.ContainsKey([int]$_.OwningProcess) } | ForEach-Object { $_.LocalPort }) };' +
    '@{processes=@($items); ports=@($ports)} | ConvertTo-Json -Compress -Depth 4';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 10000, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error('OpenCode terminal process inspection failed: ' + error.message));
      try {
        const state = JSON.parse(stdout.trim());
        if (!Array.isArray(state.processes) || !Array.isArray(state.ports)) throw new Error('invalid process state');
        resolve(state);
      } catch (e) { reject(new Error('OpenCode terminal process inspection failed: ' + e.message)); }
    });
  });
}

function apiCommand(vscode, terminal, workspaceDir, cli = 'opencode') {
  const co = terminal.creationOptions || {};
  let shell = co.shellPath || '';
  if (!shell) {
    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    shell = cfg.get('defaultProfile.windows', '') || 'powershell';
    const profile = (cfg.get('profiles.windows', {}) || {})[shell];
    if (profile && typeof profile.path === 'string') shell = profile.path;
  }
  const directory = String(workspaceDir || '');
  if (/[\r\n\0]/.test(directory)) throw new Error('Invalid OpenCode workspace directory');
  let quoted, executable;
  if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell) || /^command prompt$/i.test(shell)) {
    // %VAR% expands even inside cmd quotes. Do not silently launch in another directory.
    if (/[%!\"]/.test(directory)) throw new Error('Use a PowerShell terminal for this OpenCode workspace path');
    if (/[%!\"\r\n\0]/.test(cli)) throw new Error('Use a PowerShell terminal for this OpenCode CLI path');
    quoted = '"' + directory + '"';
    executable = '"' + cli + '"';
  } else if (/powershell|pwsh/i.test(shell)) {
    quoted = "'" + directory.replace(/'/g, "''") + "'";
    executable = cli === 'opencode' ? cli : "& '" + cli.replace(/'/g, "''") + "'";
  } else {
    quoted = "'" + directory.replace(/'/g, "'\\''") + "'";
    executable = "'" + cli.replace(/'/g, "'\\''") + "'";
  }
  // --port must be explicit, even when it is 0. This enables the HTTP API in the
  // SAME TUI process; the OS assigns a port, so multiple windows do not collide.
  return executable + ' --hostname 127.0.0.1 --port 0 ' + quoted;
}

// Launch the normal visible OpenCode TUI once, with its API enabled from the
// beginning. Its terminal name/icon match the OpenCode extension, which can then
// reuse this terminal through its own openTerminal command.
function launchApiTerminal(vscode, workspaceDir, cli) {
  // Prefer the native binary behind an npm shim when it is installed there.
  if (/\.cmd$/i.test(cli)) {
    const native = path.join(path.dirname(cli), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (fs.existsSync(native)) cli = native;
  }
  const command = apiCommand(vscode, { creationOptions: {} }, workspaceDir, cli);
  const options = { name: 'opencode', cwd: workspaceDir,
    location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false } };
  const official = vscode.extensions && vscode.extensions.getExtension('sst-dev.opencode');
  if (official) {
    options.iconPath = {
      light: vscode.Uri.file(path.join(official.extensionPath, 'images', 'button-dark.svg')),
      dark: vscode.Uri.file(path.join(official.extensionPath, 'images', 'button-light.svg')),
    };
  }
  const terminal = vscode.window.createTerminal(options);
  terminal.show();
  terminal.sendText(command, true);
  return terminal;
}

// Compatibility only for a TUI the user opened previously without an API.
// Airtl's own launcher above never needs this restart path.
async function enableTerminalApi(vscode, terminal, workspaceDir) {
  const declared = Number(terminal.creationOptions && terminal.creationOptions.env && terminal.creationOptions.env._EXTENSION_OPENCODE_PORT);
  if (declared > 0) return;
  const pid = await terminalPid(terminal);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Cannot identify the OpenCode terminal process');
  let state;
  const started = Date.now();
  do {
    state = await terminalProcessState([pid]);
    if (state.processes.length) break;
    await sleep(250);
  } while (Date.now() - started < 8000);
  if (!state.processes.length) throw new Error('OpenCode terminal opened, but its CLI process did not start');
  if (state.ports.length || state.processes.some(p => /(?:^|\s)--(?:port|hostname|mdns)(?=\s|=|$)/.test(p.commandLine || ''))) return;

  {
    const action = text(vscode, '重启 OpenCode 并启用 API', 'Restart OpenCode with API');
    const selected = await vscode.window.showWarningMessage(text(vscode,
      'OpenCode 界面已启动，但当前 TUI 未开启本地 API。需在同一终端重启并添加 --port；当前任务会中断，之后 Airtl 将恢复该工程会话。',
      'OpenCode is open, but this TUI has no local API. Restarting it in the same terminal with --port interrupts its current task; Airtl will then restore the project session.'), action);
    if (selected !== action) {
      const error = new Error(text(vscode, 'OpenCode 界面可用，但 API 未启用；请重试并选择“重启 OpenCode 并启用 API”。',
        'OpenCode UI is available, but its API is disabled. Retry and choose Restart OpenCode with API.'));
      error.permanent = true;
      throw error;
    }
  }
  // Build/validate the command before interrupting the TUI.
  const command = apiCommand(vscode, terminal, workspaceDir);
  // sendText targets this terminal, even if the user changes the focused editor.
  terminal.sendText('\u0003', false);
  await sleep(150);
  terminal.sendText('\u0003', false);
  const stopping = Date.now();
  do {
    await sleep(250);
    state = await terminalProcessState([pid]);
    if (!state.processes.length) break;
  } while (Date.now() - stopping < 8000);
  if (state.processes.length) throw new Error('OpenCode did not exit; no shell command was sent. Stop its current task and retry.');
  // Never write a shell command into an active AI prompt.
  terminal.sendText(command, true);
}

module.exports = { terminalPid, terminalProcessState, apiCommand, launchApiTerminal, enableTerminalApi };
