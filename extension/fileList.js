'use strict';

const fs = require('fs');
const path = require('path');

function pathKey(value) {
  const result = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function tokenize(text, file) {
  const tokens = [];
  let token = '';
  let quote = '';
  let escaped = false;
  let active = false;
  const flush = () => {
    if (active) tokens.push(token);
    token = '';
    active = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      if (ch !== '\n' && ch !== '\r') token += ch;
      escaped = false;
      active = true;
      continue;
    }
    if (ch === '\\' && !quote) {
      if (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n')) {
        i += text[i + 1] === '\r' ? 2 : 1;
        continue;
      }
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else token += ch;
      active = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      active = true;
      continue;
    }
    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      flush();
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    token += ch;
    active = true;
  }
  if (escaped) token += '\\';
  if (quote) throw new Error(`${file}: unterminated ${quote} quote in file list`);
  flush();
  return tokens;
}

function loadFileList(filePath, options = {}) {
  const io=options.io||fs;
  const rootFile = path.resolve(filePath);
  const workspaceRoot = path.resolve(options.workspaceRoot || path.dirname(rootFile));
  const files = [];
  const includeDirs = [];
  const defines = [];
  const libraryDirs = [];
  const libraryFiles = [];
  const libraryExtensions = [];
  const libraryNames = [];
  const warnings = [];
  const seenFiles = new Set();
  const seenIncludes = new Set();
  const seenLibraryDirs = new Set();
  const seenLibraryFiles = new Set();
  const activeLists = new Set();

  const resolvePath = (value, base) => path.resolve(base, value);
  const addUnique = (target, seen, value, base) => {
    if (!value) return;
    const absolute = resolvePath(value, base);
    const key = pathKey(absolute);
    if (seen.has(key)) return;
    seen.add(key);
    target.push(absolute);
  };
  const addSource = (value, base, sourceList) => {
    if (!value || !/\.(?:v|sv|vh|svh)$/i.test(value)) return;
    const absolute = resolvePath(value, base);
    const key = pathKey(absolute);
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    files.push(absolute);
    if (!io.existsSync(absolute)) warnings.push(`${sourceList}: source file does not exist: ${absolute}`);
  };
  const addPlusPaths = (target, seen, value, base) => {
    for (const item of value.split('+').filter(Boolean)) addUnique(target, seen, item, base);
  };
  const addDefines = value => {
    for (const item of value.split('+').filter(Boolean)) {
      if (!/^[A-Za-z_$][\w$]*(?:=.*)?$/.test(item)) {
        warnings.push(`${rootFile}: ignored malformed define: ${item}`);
        continue;
      }
      defines.push(item);
    }
  };

  const visit = (listPath, mode) => {
    const absoluteList = path.resolve(listPath);
    const key = pathKey(absoluteList);
    if (activeLists.has(key)) {
      warnings.push(`Recursive file-list reference ignored: ${absoluteList}`);
      return;
    }
    let contents;
    try { contents = io.readFileSync(absoluteList, 'utf8'); }
    catch (error) { throw new Error(`Cannot read file list ${absoluteList}: ${error.message}`); }
    activeLists.add(key);
    const listDir = path.dirname(absoluteList);
    const sourceBase = mode === 'relative-to-list' ? listDir : workspaceRoot;
    const tokens = tokenize(contents, absoluteList);
    const optionValues = new Set(['-f', '-F', '-I', '-D', '-y', '-v', '-top', '-top-module',
      '--top-module', '-work', '-L', '-libext']);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const takeValue = option => {
        const value = tokens[++i];
        if (!value) warnings.push(`${absoluteList}: ${option} requires a value`);
        return value;
      };
      if (token === '-f' || token === '-F') {
        const nested = takeValue(token);
        if (nested) visit(resolvePath(nested, token === '-F' ? listDir : workspaceRoot),
          token === '-F' ? 'relative-to-list' : 'relative-to-workspace');
      } else if (token === '-I' || token === '-y') {
        const value = takeValue(token);
        if (value) addUnique(token === '-I' ? includeDirs : libraryDirs,
          token === '-I' ? seenIncludes : seenLibraryDirs, value, sourceBase);
      } else if (token === '-D') {
        const value = takeValue(token);
        if (value) addDefines(value);
      } else if (token === '-v') {
        const value = takeValue(token);
        if (value) {
          addSource(value, sourceBase, absoluteList);
          addUnique(libraryFiles, seenLibraryFiles, value, sourceBase);
        }
      } else if (token === '-top' || token === '-top-module' || token === '--top-module') {
        const value = takeValue(token);
        if (value) result.top = value;
      } else if (token === '-libext') {
        const value = takeValue(token);
        if (value) libraryExtensions.push(...value.split(/[+,]/).filter(Boolean).map(ext => ext.startsWith('.') ? ext : `.${ext}`));
      } else if (token === '-work' || token === '-L') {
        const value = takeValue(token);
        if (value) libraryNames.push(value);
      } else if (optionValues.has(token)) {
        takeValue(token);
      } else if (token.startsWith('+incdir+')) {
        addPlusPaths(includeDirs, seenIncludes, token.slice('+incdir+'.length), sourceBase);
      } else if (token.startsWith('+define+')) {
        addDefines(token.slice('+define+'.length));
      } else if (token.startsWith('+libext+')) {
        libraryExtensions.push(...token.slice('+libext+'.length).split('+').filter(Boolean)
          .map(ext => ext.startsWith('.') ? ext : `.${ext}`));
      } else if (/^-I.+/.test(token)) {
        addUnique(includeDirs, seenIncludes, token.slice(2), sourceBase);
      } else if (/^-D.+/.test(token)) {
        addDefines(token.slice(2));
      } else if (/^-y.+/.test(token)) {
        addUnique(libraryDirs, seenLibraryDirs, token.slice(2), sourceBase);
      } else if (/^-v.+/.test(token)) {
        const value = token.slice(2);
        addSource(value, sourceBase, absoluteList);
        addUnique(libraryFiles, seenLibraryFiles, value, sourceBase);
      } else if (/^-(?:f|F).+/.test(token)) {
        const flag = token.slice(0, 2);
        visit(resolvePath(token.slice(2), flag === '-F' ? listDir : workspaceRoot),
          flag === '-F' ? 'relative-to-list' : 'relative-to-workspace');
      } else if (/^(?:--|-[A-Za-z])/.test(token)) {
        warnings.push(`${absoluteList}: unsupported option ignored: ${token}`);
      } else {
        addSource(token, sourceBase, absoluteList);
      }
    }
    activeLists.delete(key);
  };

  const result = { path: rootFile, workspaceRoot, files, includeDirs, defines,
    libraryDirs, libraryFiles, libraryExtensions, libraryNames, warnings, top: '' };
  visit(rootFile, 'relative-to-workspace');
  return result;
}

async function loadFileListAsync(filePath,options={}) {
  const cache=new Map(),rootFile=path.resolve(filePath),workspaceRoot=path.resolve(options.workspaceRoot||path.dirname(rootFile));
  const wait=async(operation,file,fn)=>{
    let timer;try{return await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`Disk I/O did not respond: ${operation} ${file}`),{code:'AIRTL_IO_TIMEOUT'})),15000);})]);}
    finally{clearTimeout(timer);}
  };
  async function readList(file){
    const absolute=path.resolve(file),key=pathKey(absolute);if(cache.has(key))return;
    if(cache.size>=4096)throw new Error('File-list nesting exceeded the supported limit');
    const contents=await wait('read',absolute,()=>fs.promises.readFile(absolute,'utf8'));cache.set(key,contents);
    const tokens=tokenize(contents,absolute),listDir=path.dirname(absolute);
    for(let i=0;i<tokens.length;i++){
      const flag=tokens[i],nested=flag==='-f'||flag==='-F'?tokens[++i]:/^-[fF].+/.test(flag)?flag.slice(2):null;
      if(nested)await readList(path.resolve(flag.startsWith('-F')?listDir:workspaceRoot,nested));
      else if(['-I','-D','-y','-v','-top','-top-module','--top-module','-work','-L','-libext'].includes(flag))++i;
    }
  }
  await readList(rootFile);
  const result=loadFileList(rootFile,{...options,io:{existsSync:()=>true,readFileSync:file=>{
    const value=cache.get(pathKey(file));if(value===undefined)throw new Error('Unprepared nested file list');return value;
  }}});
  result.dependencies=[...cache.keys()];
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(16,result.files.length)},async()=>{
    while(cursor<result.files.length){const file=result.files[cursor++];try{await wait('stat',file,()=>fs.promises.stat(file));}
      catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;result.warnings.push(`${rootFile}: source file does not exist: ${file}`);}}
  }));
  return result;
}
module.exports = { loadFileList, loadFileListAsync, tokenize };
