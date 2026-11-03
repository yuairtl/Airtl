'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { positionAtByte, coordinatesFor, isSystemVerilog } = require('./svLanguageService');

const VERILOG_KEYWORDS = new Set((`
  always and assign automatic begin buf bufif0 bufif1 case casex casez cell cmos config deassign default defparam design
  disable edge else end endcase endconfig endfunction endgenerate endmodule endprimitive endspecify endtable endtask event
  for force forever fork function generate genvar highz0 highz1 if ifnone incdir include initial inout input instance
  integer join large liblist library localparam macromodule medium module nand negedge nmos nor noshowcancelled not notif0
  notif1 or output parameter pmos posedge primitive pull0 pull1 pulldown pullup pulsestyle_ondetect pulsestyle_onevent
  rcmos real realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1 scalared showcancelled signed small specify
  specparam strong0 strong1 supply0 supply1 table task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg
  unsigned use uwire vectored wait wand weak0 weak1 while wire wor xnor xor
`).trim().split(/\s+/));

const SYSTEMVERILOG_KEYWORDS = new Set((`
  accept_on alias always_comb always_ff always_latch assert assume before bind bins binsof bit break byte chandle checker
  class clocking const constraint context continue cover covergroup coverpoint cross dist do endchecker endclass endclocking
  endgroup endinterface endpackage endprogram endproperty endsequence enum eventually expect export extends extern final
  first_match foreach forkjoin global iff ignore_bins illegal_bins implements implies import inside int interconnect
  interface intersect join_any join_none let local logic longint matches modport nettype new nexttime null package packed
  priority program property protected pure rand randc randcase randsequence ref reject_on restrict return s_always
  s_eventually s_nexttime s_until s_until_with sequence shortint shortreal soft solve static string strong struct super
  sync_accept_on sync_reject_on tagged this throughout timeprecision timeunit type typedef union unique unique0 until
  until_with untyped var virtual void wait_order weak wildcard with within
`).trim().split(/\s+/));
const SYSTEMVERILOG_KEYWORD_SET = new Set([...VERILOG_KEYWORDS, ...SYSTEMVERILOG_KEYWORDS]);
const SYSTEMVERILOG_DIRECTIVES = new Set((`
  begin_keywords celldefine default_nettype define else end_keywords endcelldefine endif ifdef ifndef include
  line pragma resetall timescale undef elsif
`).trim().split(/\s+/));

function keywordSetFor(document) {
  const ext = path.extname(document.uri && document.uri.fsPath || '').toLowerCase();
  const systemVerilog = document.languageId === 'systemverilog' || ['.sv', '.svh'].includes(ext);
  return systemVerilog ? SYSTEMVERILOG_KEYWORD_SET : VERILOG_KEYWORDS;
}

function pathKey(value) {
  const key = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function samePath(left, right) {
  const a = path.resolve(left).replace(/\\/g, '/');
  const b = path.resolve(right).replace(/\\/g, '/');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function characterOffsetAt(text, position) {
  const line = Math.max(0, Number(position && position.line) || 0);
  const character = Math.max(0, Number(position && position.character) || 0);
  let start = 0;
  for (let current = 0; current < line; current++) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) return text.length;
    start = newline + 1;
  }
  const newline = text.indexOf('\n', start);
  return Math.min(start + character, newline < 0 ? text.length : newline);
}

function tokenize(text, endOffset = text.length) {
  const source = text.slice(0, endOffset);
  const tokens = [];
  const pattern = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|\s+|"(?:\\.|[^"\\])*"|`[A-Za-z_$][A-Za-z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*|::|\S/gy;
  let match;
  while ((match = pattern.exec(source))) {
    const value = match[0];
    if (/^(?:\/\/|\/\*|\s)/.test(value) || value.startsWith('"')) continue;
    tokens.push({ value, start: match.index, end: pattern.lastIndex,
      identifier: /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) });
  }
  return tokens;
}

function activeParenthesis(tokens) {
  const stack = [];
  const matching = new Map();
  const opens = new Set(['(', '[', '{']);
  const closes = new Map([[')', '('], [']', '['], ['}', '{']]);
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (opens.has(value)) stack.push(i);
    else if (closes.has(value)) {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (tokens[stack[j]].value !== closes.get(value)) continue;
        const open = stack.splice(j, 1)[0];
        matching.set(open, i);
        matching.set(i, open);
        break;
      }
    }
  }
  const open = [...stack].reverse().find(index => tokens[index].value === '(');
  return open === undefined ? null : { open, stack, matching };
}

function moduleNameBeforeGroup(tokens, open, matching) {
  const tokenBefore = index => index >= 0 ? tokens[index] : null;
  if (tokenBefore(open - 1)?.value === '#') return tokenBefore(open - 2)?.value || '';
  let instanceIndex = open - 1;
  if (tokenBefore(instanceIndex)?.value === ']') {
    const arrayOpen = matching.get(instanceIndex);
    if (arrayOpen !== undefined) instanceIndex = arrayOpen - 1;
  }
  const instance = tokenBefore(instanceIndex);
  if (!instance || !instance.identifier) return '';
  let typeIndex = instanceIndex - 1;
  if (tokenBefore(typeIndex)?.value === ')') {
    const parameterOpen = matching.get(typeIndex);
    if (parameterOpen !== undefined && tokenBefore(parameterOpen - 1)?.value === '#')
      typeIndex = parameterOpen - 2;
  }
  const type = tokenBefore(typeIndex);
  return type && type.identifier ? type.value : '';
}

function instanceArgumentContext(text, position, index) {
  const cursor = characterOffsetAt(text, position);
  const tokens = tokenize(text, cursor);
  const active = activeParenthesis(tokens);
  if (!active) return null;
  // A named port connection is itself parenthesized (for example
  // `.data(signal)`), so the innermost open parenthesis at the cursor belongs
  // to the actual expression rather than the instance's formal argument list.
  // Walk outward until we find an unmatched group whose preceding tokens name
  // a module/interface/program instance. Function calls remain excluded by
  // the declaration-kind check below.
  const moduleDeclarations = semanticLookup(index).moduleDeclarations;
  const candidates = [...active.stack].reverse()
    .filter(index => tokens[index].value === '(')
    .map(open => ({ open, moduleName: moduleNameBeforeGroup(tokens, open, active.matching) }));
  const context = candidates.find(candidate => candidate.moduleName && moduleDeclarations.has(candidate.moduleName));
  if (!context) return null;
  const { open, moduleName } = context;
  const module = moduleDeclarations.get(moduleName);
  const marker = tokens[open - 1] && tokens[open - 1].value;
  const kind = marker === '#' ? 'parameter' : 'port';
  const begin = tokens[open].end;
  let depth = 0;
  let clauseStart = begin;
  const previousClauses = [];
  for (let i = open + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === '(' || token.value === '[' || token.value === '{') depth++;
    else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1);
    else if (token.value === ',' && depth === 0) {
      previousClauses.push(text.slice(clauseStart, token.start));
      clauseStart = token.end;
    }
  }
  const currentClause = text.slice(clauseStart, cursor);
  // The cursor is often inside `.port(actual_expression)`, not just between
  // the dot and the formal name. Keep the formal name available throughout
  // the actual expression so signature help can select the right argument.
  const named = /^\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)?/.exec(currentClause);
  let activeParameter = previousClauses.length;
  if (named && named[1]) {
    const names = kind === 'parameter'
      ? (index.symbols || []).filter(item => parentScope(item.scope) === module.name &&
        ['Parameter', 'TypeParameter'].includes(item.kind))
      : (index.symbols || []).filter(item => parentScope(item.scope) === module.name && item.kind === 'Port');
    const selected = names.findIndex(item => item.name === named[1]);
    if (selected >= 0) activeParameter = selected;
  }
  const records = kind === 'parameter'
    ? (index.symbols || []).filter(item => parentScope(item.scope) === module.name &&
      ['Parameter', 'TypeParameter'].includes(item.kind) && !item.isLocal)
    : (index.symbols || []).filter(item => parentScope(item.scope) === module.name && item.kind === 'Port');
  const alreadyUsed = new Set(previousClauses.map(clause => /^\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(clause))
    .filter(Boolean).map(match => match[1]));
  return { module, kind, records, currentClause, named, alreadyUsed, activeParameter, cursor };
}

function parentScope(scope) {
  const value = String(scope || '');
  const split = Math.max(value.lastIndexOf('.'), value.lastIndexOf('::'));
  return split < 0 ? '' : value.slice(0, split);
}

function completionItem(vscode, label, kindName, detail, insertText) {
  const kind = vscode.CompletionItemKind && vscode.CompletionItemKind[kindName] || 1;
  const item = typeof vscode.CompletionItem === 'function'
    ? new vscode.CompletionItem(label, kind) : { label, kind };
  item.detail = detail || '';
  if (insertText !== undefined) item.insertText = typeof vscode.SnippetString === 'function'
    ? new vscode.SnippetString(insertText) : insertText;
  return item;
}

function levenshtein(left, right) {
  const a = String(left);
  const b = String(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

function byteOffsetAt(text, position) {
  return coordinatesFor(text).byteAt(position || {});
}

// Semantic results are immutable snapshots. Weak keys release the lookup index
// with the corresponding result, rather than retaining every edited version.
const semanticLookups = new WeakMap();
function semanticLookup(index) {
  const cached = semanticLookups.get(index);
  if (cached) return cached;
  const files = new Map(), symbolsById = new Map(), referencesById = new Map(),
    moduleDeclarations = new Map(), pathKeys = new Map();
  let order = 0;
  const add = (item, reference) => {
    if (!item || !item.file) return;
    let key = pathKeys.get(item.file);
    if (key === undefined) { key = pathKey(item.file); pathKeys.set(item.file, key); }
    let file = files.get(key);
    if (!file) files.set(key, file = { references: [], symbols: [], intervals: [], lines: new Map() });
    (reference ? file.references : file.symbols).push(item);
    if (!reference || item.editRole !== 'wildcard-port') {
      const interval = { item, order: order++, start: item.offset, end: item.offset + Math.max(1, item.length) };
      if (Number.isInteger(item.line) && item.line >= 0 && Number.isInteger(item.column) && item.column >= 0) {
        let line = file.lines.get(item.line);
        if (!line) file.lines.set(item.line, line = []);
        interval.start = item.column;
        interval.end = item.column + Math.max(1, item.length);
        line.push(interval);
      } else file.intervals.push(interval);
    }
  };
  for (const reference of index.references || []) {
    add(reference, true);
    if (!referencesById.has(reference.id)) referencesById.set(reference.id, []);
    referencesById.get(reference.id).push(reference);
  }
  for (const symbol of index.symbols || []) {
    add(symbol, false);
    if (!symbolsById.has(symbol.id)) symbolsById.set(symbol.id, symbol);
    if (/ModuleDeclaration|InterfaceDeclaration|ProgramDeclaration/.test(symbol.kind) &&
        !moduleDeclarations.has(symbol.name)) moduleDeclarations.set(symbol.name, symbol);
  }
  for (const file of files.values()) {
    for (const intervals of [file.intervals, ...file.lines.values()]) {
      intervals.sort((a, b) => a.start - b.start || a.order - b.order);
      intervals.maxEnds = []; let maxEnd = -1;
      for (const interval of intervals) { maxEnd = Math.max(maxEnd, interval.end); intervals.maxEnds.push(maxEnd); }
    }
  }
  const value = { files, symbolsById, referencesById, moduleDeclarations };
  semanticLookups.set(index, value); return value;
}
function entryAt(index, file, position, text) {
  const data = semanticLookup(index).files.get(pathKey(file));
  if (!data) return null;
  const select = (intervals, value, boundary) => {
    if (!intervals.length) return null;
    let low = 0, high = intervals.length;
    while (low < high) { const mid = (low + high) >>> 1; if (intervals[mid].start <= value) low = mid + 1; else high = mid; }
    let best = null;
    for (let i = low - 1; i >= 0 && (boundary ? intervals.maxEnds[i] >= value : intervals.maxEnds[i] > value); i--) {
      const candidate = intervals[i];
      if (boundary ? candidate.end !== value : candidate.end <= value) continue;
      if (!best || candidate.item.length < best.item.length ||
          (candidate.item.length === best.item.length && candidate.order < best.order)) best = candidate;
    }
    return best?.item || null;
  };
  const coordinates = coordinatesFor(text);
  const queryLine = Math.max(0, Math.min(Number(position?.line) || 0, Number.MAX_SAFE_INTEGER));
  const queryColumn = coordinates.byteAt(position || {}) - coordinates.byteAt({ line: queryLine, character: 0 });
  const lineIntervals = data.lines.get(queryLine);
  let result = lineIntervals && select(lineIntervals, queryColumn, false);
  if (!result && position && position.character > 0) {
    // Accept the end boundary of a positioned identifier, but only when the
    // caret follows its final character.
    const character = characterOffsetAt(text, position);
    const identifier = ch => !!ch && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(ch);
    if (identifier(text[character - 1]) && !identifier(text[character]))
      result = lineIntervals && select(lineIntervals, queryColumn, true);
  }
  if (result) return result;

  // Older records may not carry original-file coordinates. Keep byte-offset
  // lookup for those records only; never let a conflicting buffer offset
  // override a line/column-aware Slang fact.
  const offset = byteOffsetAt(text, position);
  result = select(data.intervals, offset, false);
  if (!result && position && position.character > 0) {
    // VS Code places the active caret just after a selected word. Accept that
    // boundary only when it is the end of an indexed identifier, not a nearby
    // whitespace position or a prefix inside a longer token.
    const character = characterOffsetAt(text, position);
    const identifier = ch => !!ch && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(ch);
    if (identifier(text[character - 1]) && !identifier(text[character]))
      result = select(data.intervals, offset, true);
  }
  return result;
}

function rangeAt(vscode, text, item) {
  // When a Slang record's buffer byte offset does not map to the text VS Code
  // opened for that path, its original-file line/column still identify the
  // intended token. Prefer those source coordinates when available,
  // converting Slang's byte column to VS Code's UTF-16 column; retain byte
  // offsets for older/incomplete records.
  let start;
  if (Number.isInteger(item.line) && item.line >= 0 && Number.isInteger(item.column) && item.column >= 0) {
    const coordinates = coordinatesFor(text);
    const lineStartByte = coordinates.byteAt({ line: item.line, character: 0 });
    start = positionAtByte(text, lineStartByte + item.column);
  } else {
    start = positionAtByte(text, item.offset);
  }
  const startByte = coordinatesFor(text).byteAt(start);
  const end = positionAtByte(text, startByte + Math.max(1, item.length));
  return new vscode.Range(start.line, start.character, end.line, end.character);
}

function symbolFor(index, item) {
  return semanticLookup(index).symbolsById.get(item.id) || null;
}

function symbolKind(vscode, kind) {
  const map = {
    ModuleDeclaration: 'Module', InterfaceDeclaration: 'Interface', ProgramDeclaration: 'Module',
    PackageDeclaration: 'Namespace', Package: 'Namespace', TypeAlias: 'TypeParameter',
    EnumType: 'Enum', EnumValue: 'EnumMember', ClassType: 'Class', ClassProperty: 'Field',
    Field: 'Field', Port: 'Variable', Net: 'Variable', Variable: 'Variable', Parameter: 'Constant',
    TypeParameter: 'TypeParameter', Subroutine: 'Function', Instance: 'Module',
  };
  const name = map[kind] || 'Variable';
  return vscode.SymbolKind && vscode.SymbolKind[name] !== undefined ? vscode.SymbolKind[name] : 13;
}

function semanticTokenKind(kind) {
  if (/Module|Interface|Program/.test(kind)) return 'class';
  if (/Package/.test(kind)) return 'namespace';
  if (/TypeParameter/.test(kind)) return 'typeParameter';
  if (/TypeAlias|EnumType|Struct/.test(kind)) return 'type';
  if (/Subroutine/.test(kind)) return 'function';
  if (/Port/.test(kind)) return 'parameter';
  if (/TransparentMember/.test(kind)) return 'enumMember';
  if (/Parameter/.test(kind)) return 'variable';
  if (/EnumValue/.test(kind)) return 'enumMember';
  if (/Field|Property/.test(kind)) return 'property';
  return 'variable';
}

function macroTokenRanges(text) {
  const tokens = tokenize(text);
  const ranges = [];
  const coordinates = coordinatesFor(text);
  const add = (offset, name, declaration = false) =>
    ranges.push({ offset: coordinates.byteAtCharacter(offset), length: Buffer.byteLength(name, 'utf8'), declaration });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value.startsWith('`')) {
      const name = token.value.slice(1);
      if (name && !SYSTEMVERILOG_DIRECTIVES.has(name)) add(token.start + 1, name);
      if (name === 'define') {
        const macro = tokens[i + 1];
        const lineEnd = text.indexOf('\n', token.end);
        if (macro && macro.identifier && (lineEnd < 0 || macro.start < lineEnd))
          add(macro.start, macro.value, true);
      } else if (['ifdef', 'ifndef', 'elsif', 'undef'].includes(name)) {
        const macro = tokens[i + 1];
        const lineEnd = text.indexOf('\n', token.end);
        if (macro && macro.identifier && (lineEnd < 0 || macro.start < lineEnd)) add(macro.start, macro.value);
      }
    }
  }
  return ranges;
}

function unresolvedInstanceTypeTokens(text, symbols) {
  const tokens = tokenize(text);
  const matching = new Map();
  const stack = [];
  const openToClose = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
  const closeToOpen = new Map([...openToClose].map(([open, close]) => [close, open]));
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (openToClose.has(value)) stack.push(i);
    else if (closeToOpen.has(value)) {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (tokens[stack[j]].value !== closeToOpen.get(value)) continue;
        const open = stack.splice(j, 1)[0];
        matching.set(open, i);
        matching.set(i, open);
        break;
      }
    }
  }
  const byteOffsetByToken = [];
  let previousEnd = 0;
  let byteOffset = 0;
  for (const token of tokens) {
    byteOffset += Buffer.byteLength(text.slice(previousEnd, token.start), 'utf8');
    byteOffsetByToken.push(byteOffset);
    byteOffset += Buffer.byteLength(token.value, 'utf8');
    previousEnd = token.end;
  }
  const indexByByteOffset = new Map(byteOffsetByToken.map((offset, index) => [offset, index]));
  const coordinates = coordinatesFor(text);
  const ranges = [];
  for (const symbol of symbols || []) {
    if (!/^(?:UninstantiatedDef|Instance)$/.test(symbol.kind || '')) continue;
    const instanceOffset = Number.isInteger(symbol.line) && symbol.line >= 0 &&
      Number.isInteger(symbol.column) && symbol.column >= 0
      ? coordinates.byteAt({ line: symbol.line, character: 0 }) + symbol.column
      : symbol.offset;
    const instanceIndex = indexByByteOffset.get(instanceOffset);
    if (instanceIndex === undefined) continue;
    let typeIndex = instanceIndex - 1;
    if (typeIndex < 0) continue;
    if (tokens[typeIndex].value === ')') {
      const parameterOpen = matching.get(typeIndex);
      if (parameterOpen === undefined || tokens[parameterOpen - 1]?.value !== '#') continue;
      typeIndex = parameterOpen - 2;
    }
    const typeToken = tokens[typeIndex];
    if (!typeToken || !typeToken.identifier || SYSTEMVERILOG_KEYWORD_SET.has(typeToken.value)) continue;
    ranges.push({ offset: byteOffsetByToken[typeIndex], length: Buffer.byteLength(typeToken.value, 'utf8') });
  }
  return ranges;
}

function createProviders(vscode, service) {
  const selector = [{ language: 'verilog', scheme: 'file' }, { language: 'systemverilog', scheme: 'file' }];
  const intelliSenseEnabled = () => service.intelliSenseEnabled !== false;
  const getIndex = async (document, options) => {
    if (!intelliSenseEnabled()) return null;
    if (!isSystemVerilog(document)) return null;
    const version = document.version;
    for (let attempt=0;attempt<2;attempt++) {
      try {
        const index = await service.semanticIndexFor(document, options);
        return document.version === version && !document.isClosed && intelliSenseEnabled() ? index : null;
      }
      catch (error) {
        if (error && error.code === 'AIRTL_INTELLISENSE_DISABLED') return null;
        if (error && ['AIRTL_INDEX_STALE','AIRTL_REQUEST_SUPERSEDED'].includes(error.code)) {
          // Opening a document / finishing startup can supersede an in-flight
          // query without changing its position. Rebind once to the current
          // project; edits still invalidate the old position immediately.
          if(attempt===0 && document.version===version && !document.isClosed && intelliSenseEnabled())continue;
          return null;
        }
        if (service.output) service.output.appendLine(`[sv-language] ${document.uri.fsPath}: ${error.message}`);
        return null;
      }
    }
    return null;
  };
  const locationResolver = (document, version, index) => {
    const generation = service.semanticIndexGeneration, refreshEpoch = service.semanticIndexRefreshEpoch;
    const inputs = new Map(Object.entries(index.inputDigests || {}).map(([file, digest]) => [pathKey(file), digest]));
    const pending = new Map(), snapshots = new Map();
    const openFor = file => samePath(file, document.uri.fsPath) ? document :
      (vscode.workspace.textDocuments || []).find(candidate => candidate.uri && samePath(candidate.uri.fsPath, file));
    const waiters = []; let activeReads = 0;
    const readFile = async file => {
      await new Promise(resolve => { if (activeReads < 8) { activeReads++; resolve(); } else waiters.push(resolve); });
      try {
        if (document.isClosed || document.version !== version) return null;
        return service.runtime?.diskIoAsync
          ? await service.runtime.diskIoAsync('read-semantic-location', file, () => fs.promises.readFile(file, 'utf8'))
          : await fs.promises.readFile(file, 'utf8');
      } finally {
        if (waiters.length) waiters.shift()(); else activeReads--;
      }
    };
    const read = file => {
      const key = pathKey(file);
      if (pending.has(key)) return pending.get(key);
      const promise = (async () => {
        const target = openFor(file);
        const targetVersion = target?.version;
        let text;
        try {
          text = target ? target.getText() : await readFile(file);
        } catch (_) { return null; }
        if (text === null || document.isClosed || document.version !== version || target?.isClosed ||
            target?.version !== targetVersion || openFor(file) !== target) return null;
        const expected = inputs.get(key);
        if (!expected || crypto.createHash('sha256').update(text, 'utf8').digest('hex') !== expected) return null;
        const snapshot = { file, text, target, targetVersion }; snapshots.set(key, snapshot); return snapshot;
      })();
      pending.set(key, promise); return promise;
    };
    const current = () => intelliSenseEnabled() && service.semanticIndexGeneration === generation &&
      service.semanticIndexRefreshEpoch === refreshEpoch && !document.isClosed && document.version === version && [...snapshots.values()].every(snapshot =>
      openFor(snapshot.file) === snapshot.target && !snapshot.target?.isClosed && snapshot.target?.version === snapshot.targetVersion);
    const locate = async item => {
      if (!item?.file) return null;
      const loaded = await read(item.file);
      if (!loaded || !current()) return null;
      const uri = vscode.Uri.file(item.file), range = rangeAt(vscode, loaded.text, item);
      return typeof vscode.Location === 'function' ? new vscode.Location(uri, range) : { uri, range };
    };
    locate.current = current; locate.read = read; return locate;
  };
  const macroDefinition = (text, name, beforeOffset = Infinity) => {
    const tokens = tokenize(text);
    let found = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].value !== '`define') continue;
      const candidate = tokens[i + 1];
      if (!candidate || candidate.value !== name || candidate.start >= beforeOffset) continue;
      const lineEnd = text.indexOf('\n', tokens[i].end);
      if (lineEnd >= 0 && candidate.start >= lineEnd) continue;
      found = candidate.start;
    }
    return found;
  };
  const macroDefinitionTarget = async (document, version, index, name, referenceOffset) => {
    const locate = locationResolver(document, version, index);
    const files = new Map();
    const queue = [document.uri.fsPath];
    const includeEdges = index.includes || [];
    while (queue.length) {
      const file = queue.shift(), key = pathKey(file);
      if (files.has(key)) continue;
      files.set(key, file);
      for (const include of includeEdges) {
        if (samePath(include.file, file) && include.target && !files.has(pathKey(include.target)))
          queue.push(include.target);
      }
    }
    // A macro may be defined locally before its use, or in an included header.
    // Local textual order is authoritative; included files are searched only
    // when no preceding local definition exists.
    let found = null;
    for (const file of files.values()) {
      const snapshot = await locate.read(file);
      if (!snapshot) continue;
      const limit = samePath(file, document.uri.fsPath) ? referenceOffset : Infinity;
      const charOffset = macroDefinition(snapshot.text, name, limit);
      if (charOffset < 0) continue;
      if (samePath(file, document.uri.fsPath)) found = { file, text: snapshot.text, charOffset };
      else if (!found) found = { file, text: snapshot.text, charOffset };
    }
    if (!found || !locate.current()) return null;
    const position = positionAtByte(found.text, Buffer.byteLength(found.text.slice(0, found.charOffset), 'utf8'));
    const item = { line: position.line, column: Buffer.byteLength(found.text.split('\n')[position.line].slice(0, position.character), 'utf8'), length: Buffer.byteLength(name, 'utf8') };
    return locate({ file: found.file, ...item });
  };
  const definitionProvider = {
    async provideDefinition(document, position) {
      const version = document.version;
      const index = await getIndex(document);
      if (!index || document.isClosed || document.version !== version) return null;
      const text = document.getText();
      const item = entryAt(index, document.uri.fsPath, position, text);
      if (!item) {
        const charOffset = characterOffsetAt(text, position);
        const macro = tokenize(text)
          .find(token => token.start <= charOffset && token.end >= charOffset && token.value.startsWith('`'));
        const name = macro?.value.slice(1);
        if (!name || SYSTEMVERILOG_DIRECTIVES.has(name)) return null;
        return macroDefinitionTarget(document, version, index, name, charOffset);
      }
      const symbol = symbolFor(index, item);
      const formal = item.formalTargetId && semanticLookup(index).symbolsById.get(item.formalTargetId);
      const locate = locationResolver(document, version, index);
      const targets = (await Promise.all([...new Map([symbol, formal].filter(Boolean).map(target => [target.id, target])).values()]
        .map(target => locate(target)))).filter(Boolean);
      if (!locate.current()) return null;
      if (targets.length) return targets.length > 1 ? targets : targets[0];
      const charOffset = characterOffsetAt(text, position);
      const macro = tokenize(text)
        .find(token => token.start <= charOffset && token.end >= charOffset && token.value.startsWith('`'));
      const name = macro?.value.slice(1);
      if (!name || SYSTEMVERILOG_DIRECTIVES.has(name)) return null;
      return macroDefinitionTarget(document, version, index, name, charOffset);
    },
  };
  const referenceProvider = {
    async provideReferences(document, position, context) {
      const version = document.version;
      const index = await getIndex(document);
      if (!index || document.isClosed || document.version !== version) return [];
      if (index.analysisStatus === 'partial')
        throw Object.assign(new Error('References are unavailable because project source or include files could not be read. See Airtl output.'), {code:'AIRTL_ANALYSIS_PARTIAL'});
      const item = entryAt(index, document.uri.fsPath, position, document.getText());
      if (!item) return [];
      const declaration = symbolFor(index, item);
      const entries = [...(semanticLookup(index).referencesById.get(item.id) || [])];
      if (!context || context.includeDeclaration !== false) entries.push(declaration);
      const locate = locationResolver(document, version, index);
      const locations = await Promise.all(entries.filter(Boolean).map(async entry => {
        const location = await locate(entry);
        return location && [`${entry.file}#${entry.offset}`, location];
      }));
      if (!locate.current()) return [];
      if (locations.some(location => !location)) {
        service.output?.appendLine('[sv-language] Reference results are stale or unavailable; retry after the semantic index refreshes.');
        return [];
      }
      return [...new Map(locations.filter(Boolean)).values()];
    },
  };
  const hoverProvider = {
    async provideHover(document, position) {
      const index = await getIndex(document);
      if (!index) return null;
      const item = entryAt(index, document.uri.fsPath, position, document.getText());
      const symbol = item && symbolFor(index, item);
      if (!symbol) return null;
      const detail = symbol.type ? `${symbol.type} ` : `${symbol.kind} `;
      const markdown = new vscode.MarkdownString();
      markdown.appendCodeblock(`${detail}${symbol.name}`, 'systemverilog');
      if (symbol.scope) markdown.appendMarkdown(`\n\nScope: \`${symbol.scope}\``);
      return new vscode.Hover(markdown, rangeAt(vscode, document.getText(), item));
    },
  };
  const typeDefinitionProvider = {
    async provideTypeDefinition(document, position) {
      const version = document.version;
      const index = await getIndex(document);
      if (!index || document.isClosed || document.version !== version) return null;
      const item = entryAt(index, document.uri.fsPath, position, document.getText());
      if (!item) return null;
      const symbol = symbolFor(index, item);
      const targetId = item.role === 'type' ? item.id : symbol && symbol.typeTargetId;
      const target = targetId && semanticLookup(index).symbolsById.get(targetId);
      return target ? locationResolver(document, version, index)(target) : null;
    },
  };
  const highlightProvider = {
    async provideDocumentHighlights(document, position) {
      const index = await getIndex(document);
      if (!index) return [];
      const item = entryAt(index, document.uri.fsPath, position, document.getText());
      if (!item) return [];
      const entries = (semanticLookup(index).referencesById.get(item.id) || []).filter(reference =>
        samePath(reference.file, document.uri.fsPath));
      const symbol = symbolFor(index, item);
      if (symbol && samePath(symbol.file, document.uri.fsPath)) entries.push(symbol);
      return entries.map(entry => new vscode.DocumentHighlight(rangeAt(vscode, document.getText(), entry)));
    },
  };
  const documentSymbolProvider = {
    async provideDocumentSymbols(document) {
      const index = await getIndex(document);
      if (!index) return [];
      const entries = [...(semanticLookup(index).files.get(pathKey(document.uri.fsPath))?.symbols || [])]
        .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
          (a.column ?? Number.MAX_SAFE_INTEGER) - (b.column ?? Number.MAX_SAFE_INTEGER) || a.offset - b.offset);
      const nodes = new Map();
      for (const item of entries) {
        const range = rangeAt(vscode, document.getText(), item);
        const node = new vscode.DocumentSymbol(item.name, item.type || item.scope || '',
          symbolKind(vscode, item.kind), range, range);
        nodes.set(item.id, { item, node });
      }
      const roots = [];
      for (const { item, node } of nodes.values()) {
        const scope = String(item.scope || '');
        const separator = Math.max(scope.lastIndexOf('.'), scope.lastIndexOf('::'));
        const parentPath = separator < 0 ? '' : scope.slice(0, separator);
        const parent = parentPath && [...nodes.values()].find(candidate => candidate.item.scope === parentPath);
        if (parent && parent.node !== node) parent.node.children.push(node);
        else roots.push(node);
      }
      return roots;
    },
  };
  const includeLinkProvider = {
    async provideDocumentLinks(document) {
      const version = document.version;
      const index = await getIndex(document);
      if (!index || document.isClosed || document.version !== version) return [];
      const candidates = (index.includes || []).filter(item => samePath(item.file, document.uri.fsPath) && item.target);
      const links = [];
      for (let i = 0; i < candidates.length; i += 8) {
        const batch = await Promise.all(candidates.slice(i, i + 8).map(async item => {
          try { return (await fs.promises.stat(item.target)).isFile() ? item : null; } catch (_) { return null; }
        }));
        if (document.isClosed || document.version !== version) return [];
        for (const item of batch.filter(Boolean)) {
          const link = new vscode.DocumentLink(rangeAt(vscode, document.getText(), item), vscode.Uri.file(item.target));
          link.tooltip = `Open included file: ${item.target}`; links.push(link);
        }
      }
      return links;
    },
  };
  const completionProvider = {
    async provideCompletionItems(document, position) {
      const index = await getIndex(document, { allowStale: true });
      if (!index) return [];
      const text = document.getText();
      const cursor = characterOffsetAt(text, position);
      const lineStart = text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
      const linePrefix = text.slice(lineStart, cursor);
      const macroPrefix = /`([A-Za-z_$][A-Za-z0-9_$]*)?$/.exec(linePrefix);
      const candidates = new Map();
      const add = item => {
        if (!candidates.has(item.label)) candidates.set(item.label, item);
      };
      if (macroPrefix) {
        const prefix = macroPrefix[1] || '';
        for (const symbol of index.symbols || []) {
          if (symbol.kind !== 'Macro' || !symbol.name.startsWith(prefix)) continue;
          add(completionItem(vscode, symbol.name, 'Constant', symbol.detail || 'SystemVerilog macro'));
        }
        return [...candidates.values()];
      }

      const instance = instanceArgumentContext(text, position, index);
      if (instance && (instance.named || !instance.currentClause.trim())) {
        const prefix = instance.named && instance.named[1] || '';
        const insertDot = !instance.currentClause.trim().startsWith('.');
        for (const symbol of instance.records) {
          if (instance.alreadyUsed.has(symbol.name) || !symbol.name.startsWith(prefix)) continue;
          const detail = instance.kind === 'port'
            ? `${symbol.direction ? `${symbol.direction} ` : ''}${symbol.type || 'port'}`
            : `${symbol.kind === 'TypeParameter' ? 'type parameter' : 'parameter'}${symbol.defaultValue ? ` = ${symbol.defaultValue}` : ''}`;
          const snippet = `${insertDot ? '.' : ''}${symbol.name}($1)`;
          add(completionItem(vscode, symbol.name, 'Field', detail, snippet));
        }
        return [...candidates.values()];
      }

      const wordPrefix = /([A-Za-z_$][A-Za-z0-9_$]*)?$/.exec(linePrefix);
      const prefix = wordPrefix && wordPrefix[1] || '';
      const tokens = tokenize(text, cursor);
      let currentModule = '';
      for (let i = 0; i < tokens.length; i++) {
        const value = tokens[i].value;
        if (['module', 'interface', 'program'].includes(value) && tokens[i + 1] && tokens[i + 1].identifier)
          currentModule = tokens[i + 1].value;
        else if (['endmodule', 'endinterface', 'endprogram'].includes(value)) currentModule = '';
      }
      const visible = (index.symbols || []).filter(symbol => {
        if (!symbol.name || !symbol.name.startsWith(prefix) || symbol.kind === 'Macro') return false;
        const isGlobal = /ModuleDeclaration|InterfaceDeclaration|ProgramDeclaration|PackageDeclaration|Package|TypeAlias|EnumType|ClassType/.test(symbol.kind);
        if (isGlobal) return true;
        if (samePath(symbol.file, document.uri.fsPath)) return !currentModule ||
          symbol.scope === currentModule || symbol.scope.startsWith(`${currentModule}.`) ||
          symbol.scope.startsWith(`${currentModule}::`);
        return false;
      });
      for (const symbol of visible) {
        const kindName = /Module|Interface|Program/.test(symbol.kind) ? 'Module'
          : /Package/.test(symbol.kind) ? 'Module'
            : /Type|Enum/.test(symbol.kind) ? 'Struct'
              : /Parameter/.test(symbol.kind) ? 'Constant'
                : /Subroutine/.test(symbol.kind) ? 'Function'
                  : 'Variable';
        const detail = [symbol.direction, symbol.type, symbol.kind === 'Parameter' && symbol.defaultValue
          ? `= ${symbol.defaultValue}` : ''].filter(Boolean).join(' ');
        add(completionItem(vscode, symbol.name, kindName, detail));
      }
      return [...candidates.values()];
    },
  };
  const keywordCompletionProvider = {
    provideCompletionItems(document, position) {
      if (!intelliSenseEnabled() || !isSystemVerilog(document)) return [];
      const text = document.getText();
      const cursor = characterOffsetAt(text, position);
      const lineStart = text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
      const linePrefix = text.slice(lineStart, cursor);
      const lineComment = linePrefix.indexOf('//');
      const blockStart = linePrefix.lastIndexOf('/*');
      const blockEnd = linePrefix.lastIndexOf('*/');
      if ((lineComment >= 0 && lineComment > blockEnd) || blockStart > blockEnd ||
        /`[A-Za-z_$][A-Za-z0-9_$]*?$/.test(linePrefix)) return [];
      const wordPrefix = /([A-Za-z_$][A-Za-z0-9_$]*)?$/.exec(linePrefix);
      const prefix = wordPrefix && wordPrefix[1] || '';
      if (!prefix && linePrefix && !/\s$/.test(linePrefix)) return [];
      return [...keywordSetFor(document)]
        .filter(keyword => keyword.startsWith(prefix))
        .sort()
        .map(keyword => completionItem(vscode, keyword, 'Keyword',
          document.languageId === 'systemverilog' || ['.sv', '.svh'].includes(path.extname(document.uri.fsPath).toLowerCase())
            ? 'SystemVerilog keyword' : 'Verilog keyword'));
    },
  };
  const signatureProvider = {
    async provideSignatureHelp(document, position) {
      const index = await getIndex(document, { allowStale: true });
      if (!index) return null;
      const context = instanceArgumentContext(document.getText(), position, index);
      if (!context || !context.records.length) return null;
      const parameters = context.records.map(symbol => {
        const label = context.kind === 'port'
          ? `${symbol.direction ? `${symbol.direction} ` : ''}${symbol.type || ''} ${symbol.name}`.trim()
          : `${symbol.kind === 'TypeParameter' ? 'type ' : ''}${symbol.name}${symbol.defaultValue ? ` = ${symbol.defaultValue}` : ''}`;
        return typeof vscode.ParameterInformation === 'function'
          ? new vscode.ParameterInformation(label) : { label };
      });
      const label = context.kind === 'parameter'
        ? `${context.module.name} #(${parameters.map(item => item.label).join(', ')})`
        : `${context.module.name} (${parameters.map(item => item.label).join(', ')})`;
      const signature = typeof vscode.SignatureInformation === 'function'
        ? new vscode.SignatureInformation(label) : { label };
      signature.parameters = parameters;
      const help = typeof vscode.SignatureHelp === 'function' ? new vscode.SignatureHelp() : {};
      help.signatures = [signature];
      help.activeSignature = 0;
      help.activeParameter = Math.min(context.activeParameter, Math.max(0, parameters.length - 1));
      return help;
    },
  };
  const renameableKinds = new Set(['Variable', 'Net', 'Parameter', 'TypeParameter', 'TypeAlias', 'EnumValue', 'ClassProperty', 'Field', 'Subroutine']);
  function renameRecords(index, symbol) {
    const records = [symbol, ...(semanticLookup(index).referencesById.get(symbol.id) || [])];
    const physical = record => Number.isInteger(record.line) && Number.isInteger(record.column)
      ? `${pathKey(record.file)}#${record.line}#${record.column}#${record.length}`
      : `${pathKey(record.file)}#${record.offset}#${record.length}`;
    if (records.some(record => record.editRole === 'wildcard-port' && record.fromMacro))
      throw Object.assign(new Error('Cannot safely rename a signal connected through a macro wildcard. Use explicit port connections before renaming. No changes were applied.'),
        { code: 'AIRTL_RENAME_AMBIGUOUS' });
    // A macro body (or shared include) can bind the same source token to
    // different symbols. Editing its spelling would rename all expansions.
    // Wildcard port edits are insertions of an explicit connection before .*,
    // so they deliberately preserve the other bindings at that shared range.
    const targets = new Set(records.filter(r => r.editRole !== 'wildcard-port').map(physical));
    for (const record of [...(index.symbols || []), ...(index.references || [])]) {
      if (record.id !== symbol.id && record.editRole !== 'wildcard-port' && targets.has(physical(record)))
        throw Object.assign(new Error('Cannot safely rename: shared macro or include text also refers to another symbol. No changes were applied.'),
          { code: 'AIRTL_RENAME_AMBIGUOUS' });
    }
    return [...new Map(records.map(record => [physical(record), record])).values()];
  }
  const renameProvider = {
    async prepareRename(document, position) {
      const version = document.version;
      const index = await getIndex(document);
      if (!index || document.isClosed || document.version !== version) return null;
      if (index.analysisStatus === 'partial')
        throw Object.assign(new Error('Rename is unavailable because project source or include files could not be read. See Airtl output.'), {code:'AIRTL_ANALYSIS_PARTIAL'});
      const item = entryAt(index, document.uri.fsPath, position, document.getText());
      const symbol = item && symbolFor(index, item);
      if (!symbol || !renameableKinds.has(symbol.kind)) return null;
      renameRecords(index, symbol);
      const locate = locationResolver(document, version, index);
      const location = await locate(item);
      return location && locate.current() ? location.range : null;
    },
    async provideRenameEdits(document, position, newName) {
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(String(newName || ''))) return null;
      if(SYSTEMVERILOG_KEYWORD_SET.has(newName))
        throw Object.assign(new Error('The new name is a reserved SystemVerilog keyword. No changes were applied.'),{code:'AIRTL_RENAME_RESERVED'});
      const version=document.version;
      const index = await getIndex(document);
      if (!index || document.version!==version || document.isClosed) return null;
      if (index.analysisStatus === 'partial')
        throw Object.assign(new Error('Rename is unavailable because project source or include files could not be read. See Airtl output.'), {code:'AIRTL_ANALYSIS_PARTIAL'});
      const item = entryAt(index, document.uri.fsPath, position, document.getText());
      const symbol = item && symbolFor(index, item);
      if (!symbol || !renameableKinds.has(symbol.kind)) return null;
      const scope=parentScope(symbol.scope);
      if((index.symbols||[]).some(other=>other.id!==symbol.id&&other.name===newName&&
        (parentScope(other.scope)===scope||parentScope(other.scope).startsWith(scope+'.')||
          parentScope(other.scope).startsWith(scope+'::'))))
        throw Object.assign(new Error('The new name conflicts with an existing declaration in this scope. No changes were applied.'),{code:'AIRTL_RENAME_CONFLICT'});
      const unique = renameRecords(index, symbol);
      const locate = locationResolver(document, version, index);
      const locations = await Promise.all(unique.map(record => locate(record)));
      if (locations.some(location => !location) || !locate.current()) {
        service.output?.appendLine('[sv-language] Rename cancelled because source content or analysis context changed.');
        return null;
      }
      const edit = typeof vscode.WorkspaceEdit === 'function' ? new vscode.WorkspaceEdit() : {
        entries: [], replace(uri, range, value) { this.entries.push({ uri, range, value }); },
      };
      for (let i = 0; i < unique.length; ++i) {
        const record = unique[i];
        const name = String(newName);
        let replacement = name;
        if (record.editRole === 'implicit-port') replacement = `${record.portName}(${name})`;
        else if (record.editRole === 'wildcard-port') replacement = `.${record.portName}(${name}), .*`;
        edit.replace(locations[i].uri, locations[i].range, replacement);
      }
      return edit;
    },
  };
  const codeActionProvider = {
    async provideCodeActions(document, range, context) {
      const index = await getIndex(document, { allowStale: true });
      if (!index) return [];
      const diagnostics = context && Array.isArray(context.diagnostics) ? context.diagnostics : [];
      const symbols = (index.symbols || []).filter(item => item.name);
      const actions = [];
      for (const diagnostic of diagnostics) {
        if (diagnostic.source && diagnostic.source !== 'Slang') continue;
        if (!/undeclared|unknown (?:identifier|module|name)|not declared|cannot find|could not find/i.test(diagnostic.message || '')) continue;
        const text = document.getText();
        const start = characterOffsetAt(text, diagnostic.range.start);
        const end = characterOffsetAt(text, diagnostic.range.end);
        const token = text.slice(start, end).trim() || /[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(start))?.[0] || '';
        if (!token) continue;
        const candidates = symbols.map(symbol => ({ symbol, distance: levenshtein(token, symbol.name) }))
          .filter(item => item.distance > 0 && item.distance <= Math.max(1, Math.min(2, Math.floor(token.length / 3))))
          .sort((a, b) => a.distance - b.distance).slice(0, 3);
        for (const candidate of candidates) {
          const edit = typeof vscode.WorkspaceEdit === 'function' ? new vscode.WorkspaceEdit() : {
            replace(uri, targetRange, value) { this.entry = { uri, range: targetRange, value }; },
          };
          edit.replace(document.uri, diagnostic.range, candidate.symbol.name);
          const title = `Replace with '${candidate.symbol.name}'`;
          const action = typeof vscode.CodeAction === 'function'
            ? new vscode.CodeAction(title, vscode.CodeActionKind && vscode.CodeActionKind.QuickFix)
            : { title, kind: 'quickfix' };
          action.edit = edit;
          action.diagnostics = [diagnostic];
          actions.push(action);
        }
      }
      return actions;
    },
  };
  const semanticLegend = typeof vscode.SemanticTokensLegend === 'function' &&
    typeof vscode.SemanticTokensBuilder === 'function'
    ? new vscode.SemanticTokensLegend(
      ['namespace', 'class', 'type', 'typeParameter', 'function', 'enumMember', 'macro', 'parameter', 'property', 'variable', 'airtlPort'],
      ['declaration', 'readonly'])
    : null;
  const semanticProvider = {
    onDidChange: undefined,
    async provideDocumentSemanticTokens(document) {
      if (!semanticLegend) return null;
      const version = document.version;
      const index = await getIndex(document, { allowStale: true });
      const builder = new vscode.SemanticTokensBuilder(semanticLegend);
      if (!index || document.version !== version) return builder.build();
      const typeIndex = new Map(semanticLegend.tokenTypes.map((name, i) => [name, i]));
      const modifierIndex = new Map(semanticLegend.tokenModifiers.map((name, i) => [name, i]));
      const emitted = new Set();
      const text = document.getText();
      for (const item of macroTokenRanges(text)) {
        const start = positionAtByte(text, item.offset);
        const end = positionAtByte(text, item.offset + item.length);
        const length = end.line === start.line ? end.character - start.character : 0;
        const key = `${start.line}:${start.character}:${length}`;
        if (length > 0 && !emitted.has(key)) {
          emitted.add(key);
          builder.push(start.line, start.character, length, typeIndex.get('macro'),
            item.declaration ? 1 << modifierIndex.get('declaration') : 0);
        }
      }
      // Warm indexes may be returned while a new analysis is pending. Their
      // byte offsets are valid only for the exact inputs Slang consumed.
      const inputs = new Map(Object.entries(index.inputDigests || {}).map(([file, digest]) => [pathKey(file), digest]));
      const digestMatches = (file, contents) => {
        const expected = inputs.get(pathKey(file));
        return !!expected && crypto.createHash('sha256').update(contents, 'utf8').digest('hex') === expected;
      };
      if (!digestMatches(document.uri.fsPath, text)) return builder.build();
      for (const other of vscode.workspace.textDocuments || []) {
        if (other === document || !other.isDirty || !inputs.has(pathKey(other.uri.fsPath))) continue;
        if (!digestMatches(other.uri.fsPath, other.getText())) return builder.build();
      }
      const symbols = index.symbols || [];
      const lookup = semanticLookup(index), byId = lookup.symbolsById;
      const declarations = new Set(symbols);
      const fileFacts = lookup.files.get(pathKey(document.uri.fsPath));
      const entries = [...(fileFacts?.symbols || []), ...(fileFacts?.references || []).filter(reference => reference.editRole !== 'wildcard-port').map(reference => ({
        ...reference, kind: (byId.get(reference.id) || {}).kind || 'Variable',
      }))];
      // Connection labels remain identifiable even if a vendor definition is
      // unavailable or this module is outside the selected design hierarchy.
      // Include shorthand `.signal`: the syntax still denotes a named port.
      for (const item of (index.namedPorts || []).filter(item => samePath(item.file, document.uri.fsPath))) {
        const range = rangeAt(vscode, text, item);
        const start = range.start, end = range.end;
        const length = end.line === start.line ? end.character - start.character : 0;
        const key = `${start.line}:${start.character}:${length}`;
        if (length > 0 && !emitted.has(key)) {
          emitted.add(key);
          builder.push(start.line, start.character, length, typeIndex.get('airtlPort'), 0);
        }
      }
      for (const item of entries) {
        const range = rangeAt(vscode, text, item);
        const start = range.start;
        const end = range.end;
        const length = end.line === start.line ? end.character - start.character : 0;
        if (length <= 0) continue;
        const key = `${start.line}:${start.character}:${length}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        let modifiers = 0;
        if (declarations.has(item)) modifiers |= 1 << modifierIndex.get('declaration');
        if (/Parameter|TypeParameter|TransparentMember|EnumValue/.test(item.kind || ''))
          modifiers |= 1 << modifierIndex.get('readonly');
        const tokenKind = item.role === 'port' ? 'airtlPort' : semanticTokenKind(item.kind);
        builder.push(start.line, start.character, length,
          typeIndex.get(tokenKind) ?? typeIndex.get('variable'), modifiers);
      }
      // Slang intentionally leaves unresolved vendor primitives out of the
      // reference index. Their instance declarations still identify the type
      // token structurally, so color that token as a module/class without any
      // vendor-name allowlist (e.g. OBUF, IOBUF, or project-specific cells).
      for (const item of unresolvedInstanceTypeTokens(text, symbols.filter(item => samePath(item.file, document.uri.fsPath)))) {
        const range = rangeAt(vscode, text, item);
        const start = range.start, end = range.end;
        const length = end.line === start.line ? end.character - start.character : 0;
        const key = `${start.line}:${start.character}:${length}`;
        if (length > 0 && !emitted.has(key)) {
          emitted.add(key);
          builder.push(start.line, start.character, length, typeIndex.get('class'), 0);
        }
      }
      return builder.build();
    },
  };

  const registrations = [];
  const register = (method, ...args) => {
    if (typeof vscode.languages[method] === 'function') registrations.push(vscode.languages[method](...args));
  };
  register('registerDefinitionProvider', selector, definitionProvider);
  register('registerTypeDefinitionProvider', selector, typeDefinitionProvider);
  register('registerReferenceProvider', selector, referenceProvider);
  register('registerHoverProvider', selector, hoverProvider);
  register('registerDocumentHighlightProvider', selector, highlightProvider);
  register('registerDocumentSymbolProvider', selector, documentSymbolProvider);
  register('registerDocumentLinkProvider', selector, includeLinkProvider);
  register('registerCompletionItemProvider', selector, completionProvider, '.', '`');
  register('registerCompletionItemProvider', selector, keywordCompletionProvider);
  register('registerSignatureHelpProvider', selector, signatureProvider, '(', ',');
  register('registerRenameProvider', selector, renameProvider);
  register('registerCodeActionsProvider', selector, codeActionProvider, {
    providedCodeActionKinds: vscode.CodeActionKind ? [vscode.CodeActionKind.QuickFix] : undefined,
  });
  if (typeof vscode.EventEmitter === 'function') {
    const emitter = new vscode.EventEmitter();
    semanticProvider.onDidChange = emitter.event;
    service.onSemanticIndexReady = () => emitter.fire();
    registrations.push({ dispose: () => { service.onSemanticIndexReady = null; emitter.dispose(); } });
  }
  if (semanticLegend) register('registerDocumentSemanticTokensProvider', selector, semanticProvider, semanticLegend);
  return registrations;
}

module.exports = { byteOffsetAt, createProviders, entryAt, macroTokenRanges, rangeAt, semanticTokenKind, symbolKind };
