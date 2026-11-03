'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { create: createIsolatedRuntime } = require('./Airtl/isolated');
const vendorLint = require('./vendorLint');
const fileList = require('./fileList');
const { InactiveCodeDecorations } = require('./svInactiveCode');
const analysisContext = require('./analysisContext');
// The extension is packaged with this manifest beside the service module.
// Reaching into ../package.json only works in the development repository and
// throws in a staged or installed extension, preventing semantic indexes from
// being published at all.
const extensionVersion = require('./package.json').version || '';

function pathKey(file) {
  const key = path.resolve(file).replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function frontendPath() {
  const name = process.platform === 'win32' ? 'airtl_sv_frontend.dll'
    : process.platform === 'darwin' ? 'libairtl_sv_frontend.dylib'
      : 'libairtl_sv_frontend.so';
  const root = path.resolve(__dirname, '..');
  const candidates = [
    path.join(__dirname, 'Airtl', 'native', name),
    path.join(root, 'build', 'slang-frontend', `${process.platform}-${process.arch}`, 'bin', name),
  ];
  return candidates.find(file => fs.existsSync(file)) || '';
}

function isSystemVerilog(document) {
  const ext = path.extname(document.uri && document.uri.fsPath || '').toLowerCase();
  return ['.v', '.sv', '.vh', '.svh'].includes(ext) ||
    ['verilog', 'systemverilog'].includes(document.languageId);
}

function resultProvenance(kind, context, primaryFile, primaryVersion, generation, refreshEpoch,
                         dependencyEpoch, overlays, result, sourceDigest) {
  const normalized = analysisContext.normalize(context || {});
  const inputs = Object.entries(result?.inputDigests || {}).sort(([a], [b]) => a.localeCompare(b));
  return Object.freeze({
    kind,
    contextId: normalized.contextId,
    schemaVersion: Number.isInteger(result?.schemaVersion) ? result.schemaVersion : null,
    frontend: typeof result?.frontend === 'string' ? result.frontend : '',
    airtlVersion: extensionVersion,
    documents: [{ file: pathKey(primaryFile), version: primaryVersion, role: 'primary' },
      ...[...(overlays || [])].map(([, value]) => ({
        file: value.document?.uri?.fsPath ? pathKey(value.document.uri.fsPath) : '',
        version: value.version, role: 'overlay',
      })).filter(item => item.file)],
    generation,
    refreshEpoch,
    dependencyEpoch,
    inputDigest: sourceDigest || '',
    inputSetDigest: crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    overlays: [...(overlays || [])].map(([owner, value]) => ({ owner, version: value.version }))
      .sort((a, b) => a.owner.localeCompare(b.owner)),
  });
}

// Immutable text is the version key. All providers reuse one conversion table;
// converting a token never encodes or scans the complete document again.
const coordinateCache = new Map();
let coordinateBytes = 0;
function coordinatesFor(text) {
  const cached = coordinateCache.get(text);
  if (cached) return cached;
  const bytes = new Uint32Array(text.length + 1), lines = [0];
  let offset = 0;
  for (let i = 0; i < text.length; i++) {
    bytes[i] = offset;
    const code = text.codePointAt(i);
    if (code > 0xffff) { bytes[++i] = offset + 3; offset += 4; }
    else offset += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) lines.push(i + 1);
  }
  bytes[text.length] = offset;
  const upper = (values, value) => {
    let lo = 0, hi = values.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] <= value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const result = {
    bytes,
    byteAtCharacter: index => bytes[Math.max(0, Math.min(text.length, index))],
    byteAt(position) {
      const line = Math.max(0, Math.min(lines.length - 1, Number(position.line) || 0));
      let end = line + 1 < lines.length ? lines[line + 1] - 1 : text.length;
      if (text[end - 1] === '\r') end--;
      return bytes[Math.min(end, lines[line] + Math.max(0, Number(position.character) || 0))];
    },
    positionAt(byteOffset) {
      const index = Math.max(0, upper(bytes, Math.max(0, Math.min(offset, byteOffset))) - 1);
      const line = Math.max(0, upper(lines, index) - 1);
      let character = index - lines[line];
      if (text[index - 1] === '\r' && (index === text.length || text[index] === '\n')) character--;
      return { line, character: Math.max(0, character) };
    },
    cost: text.length * 2 + bytes.byteLength + lines.length * 8,
  };
  coordinateCache.set(text, result); coordinateBytes += result.cost;
  while (coordinateCache.size > 1 && (coordinateCache.size > 8 || coordinateBytes > 32 * 1024 * 1024)) {
    const oldest = coordinateCache.keys().next().value;
    coordinateBytes -= coordinateCache.get(oldest).cost; coordinateCache.delete(oldest);
  }
  return result;
}
function positionAtByte(text, byteOffset) { return coordinatesFor(text).positionAt(byteOffset); }

class SystemVerilogLanguageService {
  constructor(vscode, options = {}) {
    this.vscode = vscode;
    this.output = options.output || null;
    this.frontend = options.frontendPath || frontendPath();
    this.debounceMs = options.debounceMs === undefined ? 250 : options.debounceMs;
    this.enabled = options.enabled !== false;
    this.intelliSenseEnabled = options.intelliSenseEnabled !== false;
    this.intelliSenseDebounceMs = options.intelliSenseDebounceMs === undefined ? 500 : options.intelliSenseDebounceMs;
    this.standard = '1800-2017';
    this.lintMode = 'slang';
    this.vendorTrigger = 'manual';
    this.project = null;
    this.reportedFileListWarnings = new Set();
    this.semanticIndexGeneration = 1;
    this.semanticIndexes = new Map();
    this.semanticIndexRequests = new Map();
    this.dependencyWatchers = new Map();
    this.dependencyContexts = new Map();
    this.dependencyEpochs = new Map();
    this.contextOwners=new Map();this.ownerContexts=new Map();this.fileLists=new Map();
    this.partialContextFiles = new Map();
    this.semanticIndexTimer = null;
    this.semanticIndexDirtyDocuments = new Map();
    this.semanticIndexRefreshEpoch = 0;
    this.onSemanticIndexReady = null;
    this.inactiveCode = new InactiveCodeDecorations(vscode, positionAtByte);
    this.collection = vscode.languages.createDiagnosticCollection('airtl-systemverilog');
    this.timers = new Map();
    this.versions = new Map();
    this.analysisTokens = new Map();
    this.nextAnalysisToken = 1;
    this.open = new Set();
    this.publishedByOwner = new Map();
    this.ownersByFile = new Map();
    this.documentsByOwner = new Map();
    this.dependenciesByOwner = new Map();
    this.ownersByDependency = new Map();
    this.frontendUnavailableLogged = false;
    this.vendorExecutions = new Map();
    const packagedLoader = path.join(__dirname, 'Airtl', 'native.js');
    const loader = options.loader || (fs.existsSync(packagedLoader)
      ? packagedLoader : path.resolve(__dirname, '..', 'index.js'));
    this.runtime = options.runtime || null;
    this.runtimeLoader = loader;
    this.ownsRuntime = !options.runtime;
    this.configure();
  }

  setProject(project, compilationContext = null) {
    const next = project || null;
    if (this.project === next && this.projectCompilation === compilationContext) return;
    this.project = next;
    this.projectCompilation = compilationContext;
    this.projectContextOwner = next;
    this.projectContexts = new Map(compilationContext ? [['synthesis', compilationContext]] : []);
    this.inactiveCode.clear();
    for (const watcher of this.dependencyWatchers.values()) watcher.dispose();
    this.dependencyWatchers.clear(); this.dependencyContexts.clear(); this.dependencyEpochs.clear();
    this.contextOwners.clear();this.ownerContexts.clear();this.fileLists.clear();this.partialContextFiles.clear();
    if (this.intelliSenseEnabled) this.invalidateSemanticIndexes();
    for (const document of this.vscode.workspace.textDocuments || [])
      if (isSystemVerilog(document)) this.schedule(document);
  }

  configure() {
    let config;
    try { config = this.vscode.workspace.getConfiguration('airtl.systemverilog'); }
    catch (_) { config = null; }
    if (!config) return;
    const enabled = config.get('enabled', true);
    const previousIntelliSenseEnabled = this.intelliSenseEnabled;
    const intelliSenseEnabled = config.get('intelliSense.enabled', true);
    const intelliSenseDebounce = config.get('intelliSense.debounceMs', 500);
    const debounce = config.get('syntaxDebounceMs', 250);
    const standard = config.get('standard', '1800-2017');
    const lintMode = config.get('lint.mode', 'slang');
    const vendorTrigger = config.get('lint.vendorTrigger', 'manual');
    this.enabled = enabled !== false;
    this.intelliSenseEnabled = intelliSenseEnabled === true;
    this.intelliSenseDebounceMs = Number.isFinite(intelliSenseDebounce)
      ? Math.max(100, Math.min(5000, intelliSenseDebounce)) : 500;
    this.debounceMs = Number.isFinite(debounce) ? Math.max(0, Math.min(5000, debounce)) : 250;
    this.standard = standard === '1800-2023' ? standard : '1800-2017';
    this.lintMode = ['off', 'slang', 'vendor', 'both'].includes(lintMode) ? lintMode : 'slang';
    this.vendorTrigger = vendorTrigger === 'onSave' ? 'onSave' : 'manual';
    this.inactiveCode.clear(config.get('dimInactiveCode', true) !== false);
    if (previousIntelliSenseEnabled && !this.intelliSenseEnabled) {
      if (this.semanticIndexTimer) clearTimeout(this.semanticIndexTimer);
      this.semanticIndexTimer = null;
      this.semanticIndexDirtyDocuments.clear();
      this.semanticIndexRefreshEpoch++;
      this.invalidateSemanticIndexes();
      if (this.onSemanticIndexReady) this.onSemanticIndexReady(null);
    } else if (!previousIntelliSenseEnabled && this.intelliSenseEnabled) {
      for (const document of this.vscode.workspace.textDocuments || [])
        if (isSystemVerilog(document)) this.semanticIndexDirtyDocuments.set(document.uri.toString(), document);
      this.queueSemanticIndexRefresh();
    }
    if (!this.enabled) {
      for (const owner of [...this.vendorExecutions.keys()]) this.cancelVendor(owner);
      for (const key of [...this.publishedByOwner.keys()]) this.clearOwner(key);
    }
    if (!this.needsSyntaxAnalysis()) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      for (const owner of this.open) {
        this.analysisTokens.set(owner, this.nextAnalysisToken++);
        if (this.runtime && typeof this.runtime.cancelAsync === 'function') this.runtime.cancelAsync(owner);
      }
      for (const owner of [...this.vendorExecutions.keys()]) this.cancelVendor(owner);
      for (const key of [...this.publishedByOwner.keys()]) this.clearOwner(key);
    }
  }

  onConfigurationChanged() {
    this.fileLists.clear();
    this.configure();
    this.projectContexts = new Map(this.projectCompilation ? [['synthesis', this.projectCompilation]] : []);
    if (this.intelliSenseEnabled) this.invalidateSemanticIndexes();
    if (this.needsSyntaxAnalysis() || this.intelliSenseEnabled) {
      for (const document of this.vscode.workspace.textDocuments || [])
        if (isSystemVerilog(document)) this.schedule(document);
    }
  }

  schedule(document, propagate = true) {
    if (!document || !document.uri || !isSystemVerilog(document)) return;
    const owner = document.uri.toString();
    this.open.add(owner);
    this.documentsByOwner.set(owner, document);
    this.inactiveCode.clear();
    if (this.intelliSenseEnabled) {
      this.semanticIndexDirtyDocuments.set(owner, document);
      this.queueSemanticIndexRefresh();
    }
    const token = this.nextAnalysisToken++;
    this.analysisTokens.set(owner, token);
    this.cancelVendor(owner);
    if (this.runtime && typeof this.runtime.cancelAsync === 'function') this.runtime.cancelAsync(owner);
    const previous = this.timers.get(owner);
    if (previous) clearTimeout(previous);
    this.clearOwner(owner);
    this.clearOwner(`${owner}::vendor`);
    if (propagate) {
      const dependents = this.ownersByDependency.get(pathKey(document.uri.fsPath));
      for (const dependentOwner of dependents || []) {
        const dependent = this.documentsByOwner.get(dependentOwner);
        if (dependent && dependentOwner !== owner) this.schedule(dependent, false);
      }
    }
    if (!this.needsSyntaxAnalysis()) return;
    if (!this.frontend) {
      if (this.output && !this.frontendUnavailableLogged) {
        this.output.appendLine('[sv-lint] Slang frontend is unavailable; run the local frontend build or install its runtime library.');
        this.frontendUnavailableLogged = true;
      }
      return;
    }
    const version = document.version;
    const snapshot = document.getText();
    this.versions.set(owner, version);
    const timer = setTimeout(() => {
      this.timers.delete(owner);
      void this.analyze(document, owner, version, snapshot, token);
    }, this.debounceMs);
    this.timers.set(owner, timer);
  }

  workspaceRootFor(file, document) {
    const workspace = this.vscode.workspace || {};
    const folder = document && document.uri && typeof workspace.getWorkspaceFolder === 'function'
      ? workspace.getWorkspaceFolder(document.uri) : null;
    if (folder && folder.uri && folder.uri.fsPath) return folder.uri.fsPath;
    for (const candidate of workspace.workspaceFolders || []) {
      const root = candidate && candidate.uri && candidate.uri.fsPath;
      if (!root) continue;
      const relative = path.relative(root, file);
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
        return root;
    }
    return this.project && this.project.projectDir || path.dirname(file);
  }

  async contextFor(file, document, targetOverride = '') {
    const project = this.project || {};
    const sets = Array.isArray(project.fileSets) ? project.fileSets : [];
    const target = pathKey(file);
    const matches = sets.filter(set => (set.files || []).some(item =>
      item.path && pathKey(item.path) === target));
    const lintTarget = targetOverride || this.getLintSettings(document).target || 'synthesis';
    if (this.projectContextOwner !== project) {
      this.projectContextOwner = project; this.projectContexts = new Map();
    }
    let compilation = this.projectContexts.get(lintTarget);
    if (!compilation) {
      compilation = analysisContext.forProject(project, lintTarget, this.standard);
      this.projectContexts.set(lintTarget, compilation);
    }
    const isSimulation = set => set.type === 'SimulationSrcs';
    // An explicit generated-IP membership is more specific than sources_1.
    // A file shared by design/simulation must use the requested compilation
    // context, never whichever XML element happened to appear first.
    const selected = matches.find(set => set.type === 'BlockSrcs') ||
      matches.find(set => isSimulation(set) === (lintTarget === 'simulation')) || matches[0];
    const fallback = (lintTarget === 'simulation'
      ? (sets.find(set => set.type === 'SimulationSrcs' && set.active) || sets.find(set => set.type === 'SimulationSrcs'))
      : null) || sets.find(set => set.type === 'DesignSrcs' && set.active) ||
      sets.find(set => set.type === 'DesignSrcs') || {};
    const context = selected || fallback;
    const preparedUnit = compilation.compilationUnits.find(unit => unit.files.some(member => pathKey(member) === target));
    const effectiveIncludes = preparedUnit ? [...preparedUnit.includeDirs]
      : Array.isArray(context.includeDirs) ? [...context.includeDirs] : [...(project.includeDirs || [])];
    const effectiveDefines = preparedUnit ? [...preparedUnit.defines]
      : Array.isArray(context.defines) ? [...context.defines] : [...(project.defines || [])];
    if(!preparedUnit && context.type==='BlockSrcs') {
      for(const directory of project.includeDirs||[])if(!effectiveIncludes.some(item=>pathKey(item)===pathKey(directory)))effectiveIncludes.push(directory);
      const names=new Set(effectiveDefines.map(item=>item.split('=')[0]));
      for(const define of project.defines||[])if(!names.has(define.split('=')[0]))effectiveDefines.push(define);
    }
    const result = {
      fileSet: context.name || '',
      fileSetType: context.type || '',
      includeDirs: effectiveIncludes,
      defines: effectiveDefines,
      files: Array.isArray(context.files) ? context.files : (project.srcFiles || []),
      top: context.top || context.topModule || project.designTop || project.top || '',
      libraryDirs: [], libraryFiles: [], libraryExtensions: [], libraryNames: [],
      compilation,
      languageStandard: compilation.languageStandard,
    };
    let config;
    try { config = this.vscode.workspace.getConfiguration('airtl.systemverilog', document && document.uri); }
    catch (_) { config = null; }
    const configuredList = config && config.get('project.fileList', '');
    if (typeof configuredList !== 'string' || !configuredList.trim()) return result;
    const workspaceRoot = this.workspaceRootFor(file, document);
    const listPath = path.resolve(workspaceRoot, configuredList.trim());
    try {
      const listKey=pathKey(listPath);
      let pending=this.fileLists.get(listKey);
      if(!pending){pending=fileList.loadFileListAsync(listPath,{workspaceRoot});
        if(this.intelliSenseEnabled&&this.vscode.workspace.createFileSystemWatcher)this.fileLists.set(listKey,pending);}
      let parsed;try{parsed=await pending;}catch(error){this.fileLists.delete(listKey);throw error;}
      for (const warning of parsed.warnings) {
        if (this.reportedFileListWarnings.has(warning)) continue;
        this.reportedFileListWarnings.add(warning);
        if (this.output) this.output.appendLine(`[sv-context] ${warning}`);
      }
      return {
        includeDirs: parsed.includeDirs,
        defines: parsed.defines,
        files: parsed.files,
        top: parsed.top || result.top,
        libraryDirs: parsed.libraryDirs,
        libraryFiles: parsed.libraryFiles,
        libraryExtensions: parsed.libraryExtensions,
        libraryNames: parsed.libraryNames,
        fileList: parsed.path,
        fileListDependencies:parsed.dependencies,
        compilation: Object.freeze({ ...analysisContext.normalize({ ...parsed, top: parsed.top || result.top, languageStandard: this.standard }),
          fileList: parsed.path, fileListDependencies: parsed.dependencies }),
      };
    } catch (error) {
      const warning = `${listPath}: ${error.message}`;
      if (!this.reportedFileListWarnings.has(warning)) {
        this.reportedFileListWarnings.add(warning);
        if (this.output) this.output.appendLine(`[sv-context] ${warning}`);
      }
      return result;
    }
  }

  invalidateSemanticIndexes() {
    this.semanticIndexGeneration++;
    this.semanticIndexes.clear();
    for (const request of this.semanticIndexRequests.values()) {
      if (this.runtime && typeof this.runtime.cancelAsync === 'function') this.runtime.cancelAsync(request.requestKey);
    }
    this.semanticIndexRequests.clear();
  }

  watchDependencies(key, paths, directories, searchesComplete = false) {
    const state = { paths: new Set(paths.map(pathKey)), directories: new Set(directories.map(pathKey)), searchesComplete };
    this.dependencyContexts.set(key, state);
    const workspace = this.vscode.workspace;
    if (!workspace.createFileSystemWatcher || !this.vscode.RelativePattern) return;
    for (const directory of state.directories) {
      if (this.dependencyWatchers.has(directory)) continue;
      let watcher;
      try { watcher = workspace.createFileSystemWatcher(new this.vscode.RelativePattern(directory, '**/*')); }
      catch (_) { continue; }
      const changed = uri => {
        const file = pathKey(uri.fsPath);
        let invalidated = false;
        const ownersToSchedule = new Set(this.ownersByDependency.get(file) || []);
        for (const [contextKey, dependency] of this.dependencyContexts) {
          const sourceLike = !dependency.searchesComplete || /\.(?:v|sv|vh|svh)$/i.test(file) || [...dependency.paths].some(p => path.basename(p) === path.basename(file));
          if (!dependency.paths.has(file) && !sourceLike) continue;
          if (!dependency.paths.has(file) && ![...dependency.directories].some(dir => file.startsWith(dir + '/'))) continue;
          invalidated = true;
          for (const owner of this.contextOwners.get(contextKey) || []) ownersToSchedule.add(owner);
          this.semanticIndexes.delete(contextKey);
          this.dependencyEpochs.set(contextKey, (this.dependencyEpochs.get(contextKey) || 0) + 1);
          const request = this.semanticIndexRequests.get(contextKey);
          if (request && this.runtime?.cancelAsync) this.runtime.cancelAsync(request.requestKey);
        }
        if (!invalidated) return;
        this.fileLists.clear();
        if (this.onSemanticIndexReady) this.onSemanticIndexReady(null);
        for (const owner of ownersToSchedule) {
          const document = this.documentsByOwner.get(owner);
          if (document) this.schedule(document, false);
        }
      };
      watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed);
      this.dependencyWatchers.set(directory, watcher);
    }
    return searchesComplete && [...state.directories].every(directory => this.dependencyWatchers.has(directory));
  }

  async dependencyStamps(paths) {
    const stamps = new Map(), values = [...new Set(paths.map(pathKey))];
    // Bound outstanding network filesystem operations. This fallback also
    // protects embedders that do not provide VS Code file watcher events.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(16, values.length) }, async () => {
      while (cursor < values.length) {
        const file = values[cursor++];
        try { const s = await fs.promises.stat(file); stamps.set(file, `${s.size}:${s.mtimeMs}:${s.isDirectory()}`); }
        catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; stamps.set(file, 'missing'); }
      }
    }));
    return stamps;
  }

  hasPartialPreprocessorContext(file, result) {
    const inputs = [file, ...(result.preprocessor?.preprocessedFiles || [])].filter(Boolean).map(pathKey);
    return [...this.partialContextFiles.values()].some(paths => inputs.some(input => paths.has(input)));
  }

  queueSemanticIndexRefresh() {
    if (!this.intelliSenseEnabled) return;
    if (this.semanticIndexTimer) clearTimeout(this.semanticIndexTimer);
    const epoch = ++this.semanticIndexRefreshEpoch;
    this.semanticIndexTimer = setTimeout(() => {
      this.semanticIndexTimer = null;
      if (!this.intelliSenseEnabled || epoch !== this.semanticIndexRefreshEpoch) return;
      const changed = [...this.semanticIndexDirtyDocuments.values()];
      this.semanticIndexDirtyDocuments.clear();
      if (!changed.length) return;
      this.invalidateSemanticIndexes();
      const active = this.vscode.window && this.vscode.window.activeTextEditor &&
        this.vscode.window.activeTextEditor.document;
      if (active && isSystemVerilog(active)) {
        const index = changed.findIndex(item => item.uri && active.uri && item.uri.toString() === active.uri.toString());
        if (index > 0) changed.unshift(...changed.splice(index, 1));
      }
      // Each open document may belong to a different compilation context.
      // semanticIndexFor shares in-flight requests for identical contexts.
      for (const target of changed) void this.semanticIndexFor(target).then(() => {
        if (this.intelliSenseEnabled && epoch === this.semanticIndexRefreshEpoch && this.onSemanticIndexReady)
          this.onSemanticIndexReady(target);
      }).catch(error => {
        if (error && error.code === 'AIRTL_INDEX_STALE') return;
        if (this.output && this.intelliSenseEnabled)
          this.output.appendLine(`[sv-index] ${target.uri.fsPath}: ${error.message}`);
      });
    }, this.intelliSenseDebounceMs);
  }

  async semanticIndexFor(document, options = {}) {
    if (!this.intelliSenseEnabled) throw Object.assign(new Error('SystemVerilog IntelliSense is disabled'), {
      code: 'AIRTL_INTELLISENSE_DISABLED',
    });
    if (!document || !document.uri || !isSystemVerilog(document))
      throw new Error('SystemVerilog document is unavailable for semantic indexing');
    const owner = document.uri.toString();
    let generation = this.semanticIndexGeneration;
    let refreshEpoch = this.semanticIndexRefreshEpoch;
    const version = document.version;
    this.documentsByOwner.set(owner, document);
    const file = document.uri.fsPath;
    const documentContext = await this.contextFor(file, document, options.target || '');
    const context = documentContext.compilation || documentContext;
    const languageStandard = context.languageStandard || this.standard;
    if(this.documentsByOwner.get(owner)!==document||document.isClosed)
      throw Object.assign(new Error('Document closed while preparing its context'),{code:'AIRTL_INDEX_STALE'});
    const files = (context.files || []).map(item => typeof item === 'string' ? item : item && item.path)
      .filter(item => item && /\.(?:v|sv)$/i.test(item));
    // A header belongs to its includer's preprocessor context. Do not also
    // compile it as a standalone unit with a different macro environment.
    if (!files.some(item => pathKey(item) === pathKey(file)) &&
        (!/\.(?:vh|svh)$/i.test(file) || !files.length)) files.unshift(file);
    const contextKey = JSON.stringify({
      files: files.map(pathKey), includeDirs: (context.includeDirs || []).map(pathKey),
      defines: context.defines || [], libraryDirs: (context.libraryDirs || []).map(pathKey),
      libraryFiles: (context.libraryFiles || []).map(pathKey),
      libraryExtensions: context.libraryExtensions || [],
      top: context.top || '', standard: languageStandard,
      fileSetContexts: context.fileSetContexts || [], fileRecords: context.fileRecords || [],
      parameters: context.parameters || [],
      compilationUnits: context.compilationUnits || [],
    });
    const previousContext=this.ownerContexts.get(owner);
    if(previousContext&&previousContext!==contextKey)this.releaseContextOwner(owner);
    this.ownerContexts.set(owner,contextKey);
    if(!this.contextOwners.has(contextKey))this.contextOwners.set(contextKey,new Set());
    this.contextOwners.get(contextKey).add(owner);
    const cached = this.semanticIndexes.get(contextKey);
    if (cached && cached.generation === generation) {
      let current = true;
      if (!cached.watched && cached.stamps) {
        const stamps = await this.dependencyStamps([...cached.stamps.keys()]);
        current = [...cached.stamps].every(([file, value]) => stamps.get(file) === value);
        if (!current) this.semanticIndexes.delete(contextKey);
      }
      if (current && this.semanticIndexGeneration === generation && document.version === version &&
          (options.allowStale || !this.semanticIndexDirtyDocuments.size)) return cached.result;
    }
    // An explicit cold query already captures the latest editor overlays. Let
    // it consume the pending debounce refresh instead of allowing that timer
    // to invalidate the same up-to-date request half way through indexing.
    // Warm completion can still return its settled index above while typing.
    if (!options.allowStale && this.semanticIndexTimer && this.semanticIndexDirtyDocuments.size) {
      clearTimeout(this.semanticIndexTimer);
      this.semanticIndexTimer = null;
      this.semanticIndexDirtyDocuments.clear();
      this.invalidateSemanticIndexes();
      generation = this.semanticIndexGeneration;
      refreshEpoch = this.semanticIndexRefreshEpoch;
    }
    const existing = this.semanticIndexRequests.get(contextKey);
    if (existing && existing.generation === generation && existing.refreshEpoch === refreshEpoch &&
        existing.dependencyEpoch === (this.dependencyEpochs.get(contextKey) || 0)) return existing.promise;
    if (!this.frontend) throw new Error('Slang frontend is unavailable');
    const directories = [...new Set([...files.map(file => path.dirname(file)), ...(context.includeDirs || []), ...(context.libraryDirs || [])])];
    const previousDependencies = this.dependencyContexts.get(contextKey);
    this.watchDependencies(contextKey, [...files, ...(previousDependencies?.paths || [])],
      [...directories, ...(previousDependencies?.directories || [])]);
    const dependencyEpoch = this.dependencyEpochs.get(contextKey) || 0;
    if (!this.runtime)
      this.runtime = createIsolatedRuntime(this.runtimeLoader, { timeoutMs: 10000,defer:true,metadata:require('./Airtl/manifest.json') });
    const overlays = [];
    const overlayVersions = new Map();
    const inactiveEpoch = this.inactiveCode.epoch;
    const inactiveSnapshots = this.inactiveCode.capture([...this.documentsByOwner.values()]);
    for (const overlay of this.documentsByOwner.values()) {
      if (!overlay.isDirty || !overlay.uri || !isSystemVerilog(overlay)) continue;
      overlays.push({ path: overlay.uri.fsPath, text: overlay.getText() });
      overlayVersions.set(overlay.uri.toString(), { document: overlay, version: overlay.version });
    }
    const overlaysCurrent = () => [...overlayVersions].every(([key, captured]) =>
      this.documentsByOwner.get(key) === captured.document && captured.document.version === captured.version && !captured.document.isClosed) &&
      [...this.documentsByOwner].every(([key, overlay]) => !overlay.isDirty || !isSystemVerilog(overlay) ||
        (overlayVersions.has(key) && overlayVersions.get(key).document === overlay && overlayVersions.get(key).version === overlay.version));
    let primaryFile = files[0] || file, primaryText;
    try { primaryText = await this.textForAsync(primaryFile, owner, document.getText()); }
    catch (error) {
      // A missing project source must not become an empty source buffer. Keep
      // the original compilation-unit order and use the open document only as
      // the overlay carrier; Slang can still index the surviving units.
      if (!['ENOENT','ENOTDIR'].includes(error?.code)) throw error;
      primaryFile = file; primaryText = document.getText();
    }
    if(document.version!==version||this.documentsByOwner.get(owner)!==document||!overlaysCurrent())
      throw Object.assign(new Error('Document changed while preparing semantic inputs'),{code:'AIRTL_INDEX_STALE'});
    if (this.semanticIndexGeneration !== generation || this.semanticIndexRefreshEpoch !== refreshEpoch ||
        (this.dependencyEpochs.get(contextKey) || 0) !== dependencyEpoch)
      throw Object.assign(new Error('Semantic context changed while preparing inputs'), { code: 'AIRTL_INDEX_STALE' });
    // Another document in the same context may have launched its request
    // while this document was waiting for disk or an editor overlay.
    const preparedRequest = this.semanticIndexRequests.get(contextKey);
    if (preparedRequest && preparedRequest.generation === generation && preparedRequest.refreshEpoch === refreshEpoch &&
        preparedRequest.dependencyEpoch === dependencyEpoch) return preparedRequest.promise;
    const requestKey = `semantic:${contextKey}`;
    const index = this.runtime.svIndexTextLatestAsync || this.runtime.svIndexTextAsync;
    if (typeof index !== 'function') throw new Error('Slang semantic index is unavailable in this runtime');
    const runIndex = (inputFiles, units) => index.call(this.runtime, ...(this.runtime.svIndexTextLatestAsync ? [requestKey] : []),
      this.frontend, primaryFile, primaryText, inputFiles,
      context.includeDirs, context.defines, languageStandard, overlays, context.top || '',
      context.libraryDirs, context.libraryFiles, context.libraryExtensions,
      {fileSetContexts:context.fileSetContexts || [], fileRecords:context.fileRecords || [], parameters:context.parameters || [], compilationUnits:units});
    const promise = runIndex(files, context.compilationUnits || [])
      .catch(async error => {
        if (!/Slang semantic indexing failed/.test(error?.message || '')) throw error;
        const overlayKeys = new Set([primaryFile, ...overlays.map(item=>item.path)].map(pathKey));
        const missing = new Set();
        for (const input of files) {
          if (overlayKeys.has(pathKey(input))) continue;
          try {
            if (this.runtime?.diskIoAsync) await this.runtime.diskIoAsync('stat-semantic-input',input,()=>fs.promises.stat(input));
            else await fs.promises.stat(input);
          } catch (statError) {
            if (!['ENOENT','ENOTDIR'].includes(statError?.code)) throw statError;
            missing.add(pathKey(input));
          }
        }
        if (!missing.size) throw error;
        if (this.semanticIndexGeneration !== generation || this.semanticIndexRefreshEpoch !== refreshEpoch ||
            document.version !== version || document.isClosed || !overlaysCurrent())
          throw Object.assign(new Error('Semantic index changed while recovering missing sources'),{code:'AIRTL_INDEX_STALE'});
        const remaining = files.filter(input => !missing.has(pathKey(input)));
        const units = (context.compilationUnits || []).map(unit => ({...unit,
          files:(unit.files || []).filter(input => !missing.has(pathKey(typeof input === 'string' ? input : input.path)))})).filter(unit => unit.files.length);
        return runIndex(remaining, units);
      })
      .then(async result => {
        if (result.inputDigests && typeof result.inputDigests === 'object') {
          const consumed = new Set(Object.keys(result.inputDigests).map(pathKey));
          const failedBoundaryKeys = new Set((result.boundaryFailures || []).filter(item=>typeof item==='string').map(pathKey));
          const missingInputs = files.filter(input => !consumed.has(pathKey(input)) || failedBoundaryKeys.has(pathKey(input)));
          const missingIncludes = (result.missingIncludeSearches || []).filter(item => item?.source && item?.name);
          if (missingInputs.length || missingIncludes.length) {
            result.analysisStatus = 'partial'; result.missingInputs = missingInputs;
            result.missingIncludes = missingIncludes;
            const names = [...missingInputs, ...missingIncludes.map(item => `${item.source}: ${item.name}`)];
            this.output?.appendLine(`[sv-index] Incomplete semantic context; inputs not read: ${names.join(', ')}`);
          } else result.analysisStatus = 'complete';
        }
        const dependencies = [...files, ...(context.fileListDependencies||[]), ...(context.libraryFiles || []),
          ...(result.includes || []).flatMap(item => [item.file, item.target]).filter(Boolean),
          ...(result.symbols || []).map(item => item.file).filter(Boolean)];
        // Include names have no required extension. Track unsuccessful and
        // shadowed candidates as exact paths, including nested directories.
        for (const search of result.includeSearches || []) {
          if (!search.source || !search.name) continue;
          dependencies.push(path.resolve(path.dirname(search.source), search.name));
          for (const dir of context.includeDirs || []) dependencies.push(path.resolve(dir, search.name));
        }
        const dependencyDirectories = [...new Set([...directories, ...dependencies.map(file => path.dirname(file))])];
        const stamps = await this.dependencyStamps([...dependencies, ...dependencyDirectories]);
        if (this.semanticIndexGeneration !== generation || this.semanticIndexRefreshEpoch !== refreshEpoch ||
            document.version !== version || this.documentsByOwner.get(owner)!==document || document.isClosed ||
            !overlaysCurrent() || (this.dependencyEpochs.get(contextKey) || 0) !== dependencyEpoch)
          throw Object.assign(new Error('Semantic index is stale after document or project changes'), { code: 'AIRTL_INDEX_STALE' });
        const watched = this.watchDependencies(contextKey, dependencies, dependencyDirectories, Array.isArray(result.includeSearches));
        result.analysisProvenance = resultProvenance('semantic', context, primaryFile, version, generation,
          refreshEpoch, dependencyEpoch, overlayVersions, result);
        this.semanticIndexes.set(contextKey, { generation, version, result, stamps, watched });
        if (result.analysisStatus === 'partial') {
          this.partialContextFiles.set(contextKey,new Set([...files,...Object.keys(result.inputDigests || {})].map(pathKey)));
          this.inactiveCode.clear();
        } else {
          this.partialContextFiles.delete(contextKey);
          if (this.hasPartialPreprocessorContext(file,result)) this.inactiveCode.clear();
          else this.inactiveCode.publish(result, inactiveSnapshots, inactiveEpoch, 2);
        }
        for (const [overlayOwner, captured] of overlayVersions) {
          const overlay = this.documentsByOwner.get(overlayOwner);
          if (overlay === captured.document && overlay.version === captured.version) this.semanticIndexDirtyDocuments.delete(overlayOwner);
        }
        return result;
      })
      .finally(() => {
        const pending = this.semanticIndexRequests.get(contextKey);
        if (pending && pending.promise === promise) this.semanticIndexRequests.delete(contextKey);
      });
    this.semanticIndexRequests.set(contextKey, { generation, version, refreshEpoch, dependencyEpoch, promise, requestKey });
    return promise;
  }

  async findModuleDefinition(moduleName, candidateFiles, target = 'simulation') {
    const wanted = String(moduleName || '');
    if (!wanted || !Array.isArray(candidateFiles)) return null;
    const files = [...new Set(candidateFiles.map(item => typeof item === 'string' ? item : item?.path)
      .filter(file => file && /\.(?:v|sv)$/i.test(file)).map(file => path.resolve(file)))];
    for (const file of files) {
      let document;
      try { document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(file)); }
      catch (_) { continue; }
      if (!this.frontend) continue;
      const context = await this.contextFor(file, document, target);
      if (!this.runtime)
        this.runtime = createIsolatedRuntime(this.runtimeLoader, { timeoutMs: 10000, defer: true,
          metadata: require('./Airtl/manifest.json') });
      const index = this.runtime.svIndexTextLatestAsync || this.runtime.svIndexTextAsync;
      if (typeof index !== 'function') continue;
      const version = document.version;
      const includeDirs = context.includeDirs || [];
      const defines = context.defines || [];
      const unit = { files: [file], includeDirs, defines };
      const options = {
        fileSetContexts: [{ name: context.fileSet || '', type: context.fileSetType || target,
          files: [file], includeDirs, defines }],
        fileRecords: (context.compilation?.fileRecords || []).filter(record =>
          record.path && pathKey(record.path) === pathKey(file)),
        parameters: [], compilationUnits: [unit],
      };
      try {
        const requestKey = `module-source:${pathKey(file)}`;
        const result = await index.call(this.runtime, ...(this.runtime.svIndexTextLatestAsync ? [requestKey] : []),
          this.frontend, file, document.getText(), [file], includeDirs, defines,
          context.languageStandard || this.standard, [], wanted,
          context.libraryDirs || [], context.libraryFiles || [], context.libraryExtensions || [], options);
        if (document.isClosed || document.version !== version) continue;
        const definition = (result.symbols || []).find(item => item.name === wanted &&
          item.kind === 'ModuleDeclaration' && item.file);
        if (definition) return { file: definition.file, line: definition.line + 1,
          column: definition.column, kind: definition.kind };
      }
      catch (error) {
        if (error?.code === 'AIRTL_INDEX_STALE') continue;
        this.output?.appendLine(`[sv-index][module-source] ${file}: ${error.message}`);
        continue;
      }
    }
    return null;
  }

  async textForAsync(file,owner,snapshot){
    if(pathKey(file)===pathKey(this.ownerPath(owner)))return snapshot;
    const open=(this.vscode.workspace.textDocuments||[]).find(d=>d.uri&&pathKey(d.uri.fsPath)===pathKey(file));
    if(open)return open.getText();
    return this.runtime?.diskIoAsync
      ? await this.runtime.diskIoAsync('read-semantic-input',file,()=>fs.promises.readFile(file,'utf8'))
      : await fs.promises.readFile(file,'utf8');
  }

  ownerPath(owner) {
    const base = String(owner).split('::')[0];
    const uri = this.vscode.Uri && this.vscode.Uri.parse ? this.vscode.Uri.parse(base) : null;
    return uri && uri.fsPath || base;
  }

  needsSyntaxAnalysis() {
    return (this.enabled && ['slang', 'both'].includes(this.lintMode)) || this.inactiveCode.enabled;
  }

  async analyze(document, owner, version, snapshot, token) {
    if (!this.needsSyntaxAnalysis() ||
        !this.open.has(owner) || this.analysisTokens.get(owner) !== token ||
        this.versions.get(owner) !== version) return;
    const file = document.uri.fsPath;
    try {
      if (!this.runtime)
        this.runtime = createIsolatedRuntime(this.runtimeLoader, { timeoutMs: 10000,defer:true,metadata:require('./Airtl/manifest.json') });
      const context = await this.contextFor(file, document);
      const inactiveEpoch = this.inactiveCode.epoch;
      const inactiveSnapshots = this.inactiveCode.capture([...this.documentsByOwner.values()]);
      const unsavedFiles = [];
      const overlayVersions = new Map();
      for (const [overlayOwner, overlay] of this.documentsByOwner) {
        if (overlayOwner === owner || !overlay.isDirty || !overlay.uri || !isSystemVerilog(overlay)) continue;
        unsavedFiles.push({ path: overlay.uri.fsPath, text: overlay.getText() });
        overlayVersions.set(overlayOwner, { document: overlay, version: overlay.version });
      }
      const parse = this.runtime.svParseTextLatestAsync || this.runtime.svParseTextAsync;
      const result = await parse.call(this.runtime, ...(this.runtime.svParseTextLatestAsync
        ? [owner, this.frontend, file, snapshot, context.includeDirs, context.defines, context.languageStandard || this.standard, unsavedFiles]
        : [this.frontend, file, snapshot, context.includeDirs, context.defines, context.languageStandard || this.standard, unsavedFiles]));
      if (!this.open.has(owner) || this.versions.get(owner) !== version ||
          document.version !== version || this.analysisTokens.get(owner) !== token ||
          !this.needsSyntaxAnalysis()) return;
      const overlaysChanged = [...overlayVersions].some(([overlayOwner, captured]) => {
        const current = this.documentsByOwner.get(overlayOwner);
        return current !== captured.document || current?.version !== captured.version;
      });
      if (overlaysChanged) {
        this.schedule(document, false);
        return;
      }
      const parseContext = context.compilation || context;
      result.analysisProvenance = resultProvenance('syntax', parseContext, file, version,
        this.semanticIndexGeneration, this.semanticIndexRefreshEpoch,
        this.dependencyEpochs.get(this.ownerContexts.get(owner)) || 0, overlayVersions, result,
        crypto.createHash('sha256').update(snapshot, 'utf8').digest('hex'));
      this.replaceDependencies(owner, result.includes || []);
      const current = () => this.open.has(owner) && this.versions.get(owner) === version &&
        document.version === version && this.analysisTokens.get(owner) === token && this.needsSyntaxAnalysis() &&
        [...overlayVersions].every(([overlayOwner, captured]) => this.documentsByOwner.get(overlayOwner) === captured.document &&
          captured.document.version === captured.version && !captured.document.isClosed) &&
        [...this.documentsByOwner].every(([overlayOwner, overlay]) => overlayOwner === owner || !overlay.isDirty ||
          (overlayVersions.has(overlayOwner) && overlayVersions.get(overlayOwner).document === overlay &&
            overlayVersions.get(overlayOwner).version === overlay.version));
      if (this.enabled && ['slang', 'both'].includes(this.lintMode) &&
          !await this.publish(owner, result, snapshot, current)) return;
      // Project headers are decorated from the existing semantic pass, which
      // preprocesses their includers. Standalone headers use their own context.
      const projectHeader = /\.(?:vh|svh)$/i.test(file) && (context.files || []).some(item =>
        /\.(?:v|sv)$/i.test(typeof item === 'string' ? item : item?.path || ''));
      if (result.preprocessorComplete === false || this.hasPartialPreprocessorContext(file,result)) this.inactiveCode.clear();
      else if (!projectHeader) this.inactiveCode.publish(result, inactiveSnapshots, inactiveEpoch);
    } catch (error) {
      if (error && error.code === 'AIRTL_REQUEST_SUPERSEDED') return;
      if (this.analysisTokens.get(owner) !== token) return;
      if (this.output) this.output.appendLine(`[sv-lint] ${file}: ${error.message}`);
    }
  }

  replaceDependencies(owner, includedFiles) {
    for (const previous of this.dependenciesByOwner.get(owner) || []) {
      const owners = this.ownersByDependency.get(previous);
      if (!owners) continue;
      owners.delete(owner);
      if (!owners.size) this.ownersByDependency.delete(previous);
    }
    const dependencies = new Set((includedFiles || []).filter(Boolean).map(pathKey));
    this.dependenciesByOwner.set(owner, dependencies);
    for (const dependency of dependencies) {
      let owners = this.ownersByDependency.get(dependency);
      if (!owners) this.ownersByDependency.set(dependency, owners = new Set());
      owners.add(owner);
    }
  }

  async publish(owner, result, mainSnapshot, current = () => true) {
    const inputs = new Map(Object.entries(result.inputDigests || {}).map(([file, digest]) => [pathKey(file), digest]));
    const pending = new Map(), snapshots = new Map(), ownerKey = pathKey(this.ownerPath(owner));
    const load = file => {
      const key = pathKey(file);
      if (pending.has(key)) return pending.get(key);
      const promise = (async () => {
        const openFor = () => (this.vscode.workspace.textDocuments || []).find(document =>
          document.uri && pathKey(document.uri.fsPath) === key);
        const target = openFor(), targetVersion = target?.version;
        let text;
        try {
          text = key === ownerKey ? mainSnapshot : target ? target.getText() :
            this.runtime?.diskIoAsync ? await this.runtime.diskIoAsync('read-diagnostic-source', file, () => fs.promises.readFile(file, 'utf8')) :
              await fs.promises.readFile(file, 'utf8');
        } catch (_) { return null; }
        if (!current() || target?.isClosed || target?.version !== targetVersion || openFor() !== target) return null;
        const digest = inputs.get(key);
        if (digest && crypto.createHash('sha256').update(text, 'utf8').digest('hex') !== digest) return null;
        const value = { text, target, targetVersion, openFor }; snapshots.set(key, value); return value;
      })();
      pending.set(key, promise); return promise;
    };
    const needText = new Map();
    for (const item of result.diagnostics || []) {
      const file = item.file || this.ownerPath(owner), key = pathKey(file);
      if (!Number.isFinite(Number(item.line)) || inputs.has(key)) needText.set(key, file);
    }
    for (let i = 0, files = [...needText.values()]; i < files.length; i += 8) {
      const batch = await Promise.all(files.slice(i, i + 8).map(load));
      if (batch.some(value => !value) || !current()) return false;
    }
    if (!current() || [...snapshots.values()].some(value => value.openFor() !== value.target ||
        value.target?.isClosed || value.target?.version !== value.targetVersion)) return false;
    const byFile = new Map();
    for (const item of result.diagnostics || []) {
      const file = item.file || this.ownerPath(owner);
      const key = pathKey(file);
      let target = byFile.get(key);
      if (!target) byFile.set(key, target = { file, diagnostics: [] });
      const text = snapshots.get(key)?.text || '';
      const start = Number.isFinite(Number(item.line))
        ? { line: Math.max(0, Number(item.line)), character: Math.max(0, Number(item.column) || 0) }
        : positionAtByte(text, Number(item.offset) || 0);
      const end = Number.isFinite(Number(item.line))
        ? { line: start.line, character: start.character + Math.max(1, Number(item.length) || 1) }
        : positionAtByte(text, (Number(item.offset) || 0) + (Number(item.length) || 0));
      const range = new this.vscode.Range(start.line, start.character, end.line, end.character);
      const severity = Number(item.severity);
      const level = severity >= 2 ? this.vscode.DiagnosticSeverity.Error
        : severity === 1 ? this.vscode.DiagnosticSeverity.Warning
          : this.vscode.DiagnosticSeverity.Information;
      const diagnostic = new this.vscode.Diagnostic(range, item.message || 'Slang diagnostic', level);
      diagnostic.source = item.source || 'Slang';
      diagnostic.code = item.code || 'SV';
      target.diagnostics.push(diagnostic);
    }
    for (const { file, diagnostics } of byFile.values()) {
      const key = pathKey(file);
      let owners = this.ownersByFile.get(key);
      if (!owners) this.ownersByFile.set(key, owners = new Map());
      const uri = this.vscode.Uri.file(file);
      owners.set(owner, { uri, diagnostics });
      this.collection.set(uri, [...owners.values()].flatMap(entry => entry.diagnostics));
    }
    this.publishedByOwner.set(owner, [...byFile.keys()]);
    return true;
  }

  getLintSettings(document) {
    let config;
    try { config = this.vscode.workspace.getConfiguration('airtl.systemverilog.lint', document && document.uri); }
    catch (_) { config = null; }
    if (!config) return {};
    const get = (key, fallback) => config.get(key, fallback);
    return {
      vendor: get('vendor', 'none'),
      vendorTrigger: get('vendorTrigger', 'manual'),
      target: get('target', 'synthesis'),
      toolPath: get('toolPath', ''),
      toolArgs: get('toolArgs', []),
      timeoutMs: get('timeoutMs', 30000),
      standard: this.standard,
    };
  }

  shouldLintVendorOnSave(document) {
    const settings = this.getLintSettings(document);
    return this.enabled && ['vendor', 'both'].includes(this.lintMode) &&
      settings.vendorTrigger === 'onSave' && settings.vendor !== 'none';
  }

  cancelVendor(owner) {
    const execution = this.vendorExecutions.get(owner);
    if (!execution) return;
    this.vendorExecutions.delete(owner);
    execution.cancel();
  }

  async runVendorLint(document) {
    if (!document || !document.uri || !isSystemVerilog(document)) return false;
    const owner = document.uri.toString();
    this.open.add(owner);
    if (!this.enabled || !['vendor', 'both'].includes(this.lintMode))
      throw new Error('请将 airtl.systemverilog.lint.mode 设为 vendor 或 both 后再运行厂商检查。');
    const settings = this.getLintSettings(document);
    if (!settings.vendor || settings.vendor === 'none')
      throw new Error('请先配置 airtl.systemverilog.lint.vendor。');
    this.cancelVendor(owner);
    const vendorOwner = `${owner}::vendor`;
    this.clearOwner(vendorOwner);
    const file = document.uri.fsPath;
    const context = await this.contextFor(file, document);
    const workspaceRoot = (this.vscode.workspace.workspaceFolders || [])[0]?.uri?.fsPath || path.dirname(file);
    const marker = vendorLint.SNAPSHOT_MARKER;
    const temporaryRoot = path.join(require('os').tmpdir(), 'airtl-vendor-lint');
    const invocation = vendorLint.buildInvocation({
      vendor: settings.vendor,
      settings,
      context,
      project: this.project,
      filePath: file,
      snapshotPath: marker,
      workspaceRoot,
      cwd: temporaryRoot,
    });
    const version = document.version;
    const execution = vendorLint.startVendorLint({
      invocation,
      vendor: settings.vendor,
      snapshotText: document.getText(),
      snapshotName: file,
      timeoutMs: settings.timeoutMs,
    });
    this.vendorExecutions.set(owner, execution);
    try {
      const result = await execution.promise;
      if (this.vendorExecutions.get(owner) !== execution) return false;
      if (result.cancelled || !this.open.has(owner) || document.version !== version) {
        this.vendorExecutions.delete(owner); return false;
      }
      if (this.output) {
        this.output.appendLine(`[vendor-lint] ${settings.vendor} target=${settings.target} exit=${result.exitCode}${result.timedOut ? ' timeout' : ''}`);
        if (result.output) this.output.appendLine(result.output);
      }
      const diagnostics = [...result.diagnostics];
      if (result.timedOut) diagnostics.push({
        file, line: 0, column: 0, severity: 2, source: settings.vendor,
        code: `${settings.vendor}:timeout`, message: `检查超过 ${settings.timeoutMs} ms，进程已终止。`,
      });
      else if (result.exitCode !== 0 && diagnostics.length === 0) diagnostics.push({
        file, line: 0, column: 0, severity: 2, source: settings.vendor,
        code: `${settings.vendor}:exit`, message: `检查进程退出，代码 ${result.exitCode}。详见 Airtl 输出。`,
      });
      const published = await this.publish(vendorOwner, { diagnostics }, document.getText(), () =>
        this.vendorExecutions.get(owner) === execution && this.open.has(owner) && document.version === version &&
        this.enabled && ['vendor', 'both'].includes(this.lintMode));
      if (this.vendorExecutions.get(owner) === execution) this.vendorExecutions.delete(owner);
      if (!published) return false;
      return result;
    } catch (error) {
      if (this.vendorExecutions.get(owner) === execution) this.vendorExecutions.delete(owner);
      if (this.output) this.output.appendLine(`[vendor-lint] ${settings.vendor}: ${error.message}`);
      throw error;
    }
  }

  clearOwner(owner) {
    const files = this.publishedByOwner.get(owner) || [];
    for (const key of files) {
      const owners = this.ownersByFile.get(key);
      if (!owners) continue;
      const uri = owners.values().next().value.uri;
      owners.delete(owner);
      if (!owners.size) {
        this.ownersByFile.delete(key);
        this.collection.delete(uri);
      } else {
        const remainingUri = owners.values().next().value.uri;
        this.collection.set(remainingUri, [...owners.values()].flatMap(entry => entry.diagnostics));
      }
    }
    this.publishedByOwner.delete(owner);
  }

  releaseContextOwner(owner) {
    const key=this.ownerContexts.get(owner);this.ownerContexts.delete(owner);
    const owners=this.contextOwners.get(key);if(!owners)return;
    owners.delete(owner);if(owners.size)return;
    this.contextOwners.delete(key);this.dependencyContexts.delete(key);this.dependencyEpochs.delete(key);this.semanticIndexes.delete(key);this.partialContextFiles.delete(key);
    const pending=this.semanticIndexRequests.get(key);if(pending&&this.runtime?.cancelAsync)this.runtime.cancelAsync(pending.requestKey);
    this.semanticIndexRequests.delete(key);
    const used=new Set([...this.dependencyContexts.values()].flatMap(state=>[...state.directories]));
    for(const [directory,watcher] of this.dependencyWatchers)if(!used.has(directory)){watcher.dispose();this.dependencyWatchers.delete(directory);}
    if(!this.contextOwners.size)this.fileLists.clear();
  }

  close(document) {
    if (!document || !document.uri) return;
    const owner = document.uri.toString();
    this.inactiveCode.forget(document);
    if (this.intelliSenseEnabled && document.isDirty) this.invalidateSemanticIndexes();
    this.releaseContextOwner(owner);
    const dependents = [...(this.ownersByDependency.get(pathKey(document.uri.fsPath)) || [])];
    this.cancelVendor(owner);
    if (this.runtime && typeof this.runtime.cancelAsync === 'function') this.runtime.cancelAsync(owner);
    const timer = this.timers.get(owner);
    if (timer) clearTimeout(timer);
    this.timers.delete(owner);
    this.open.delete(owner);
    this.documentsByOwner.delete(owner);
    this.semanticIndexDirtyDocuments.delete(owner);
    this.versions.delete(owner);
    this.analysisTokens.delete(owner);
    this.clearOwner(owner);
    this.clearOwner(`${owner}::vendor`);
    this.replaceDependencies(owner, []);
    for (const dependentOwner of document.isDirty ? dependents : []) {
      const dependent = this.documentsByOwner.get(dependentOwner);
      if (dependent) this.schedule(dependent, false);
    }
  }

  dispose() {
    this.inactiveCode.dispose();
    for (const watcher of this.dependencyWatchers.values()) watcher.dispose();
    this.dependencyWatchers.clear(); this.dependencyContexts.clear(); this.dependencyEpochs.clear();
    this.contextOwners.clear();this.ownerContexts.clear();this.fileLists.clear();this.partialContextFiles.clear();
    if (this.semanticIndexTimer) clearTimeout(this.semanticIndexTimer);
    this.semanticIndexTimer = null;
    this.semanticIndexDirtyDocuments.clear();
    this.invalidateSemanticIndexes();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const owner of [...this.vendorExecutions.keys()]) this.cancelVendor(owner);
    this.open.clear();
    this.publishedByOwner.clear();
    this.ownersByFile.clear();
    this.documentsByOwner.clear();
    this.dependenciesByOwner.clear();
    this.ownersByDependency.clear();
    this.analysisTokens.clear();
    this.collection.clear();
    this.collection.dispose();
    if (this.ownsRuntime && this.runtime && this.runtime.__shutdown)
      this.runtime.__shutdown();
  }
}

module.exports = { SystemVerilogLanguageService, frontendPath, isSystemVerilog, positionAtByte, coordinatesFor };
