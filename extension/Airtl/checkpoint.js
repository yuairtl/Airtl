'use strict';
// Runs exclusively inside the native worker: semantic payloads never enter
// the extension host. This format contains IDs/values, never memory images.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const SCHEMA=1,MAX_BYTES=512*1024*1024;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const key=file=>{const p=path.resolve(file).replace(/\\/g,'/');return process.platform==='win32'?p.toLowerCase():p;};
function create(api,watch){
  const io=(operation,file,fn)=>{const ticket=watch._runtimeIoBegin?.(operation,String(file));try{return fn();}finally{if(ticket)watch._runtimeIoEnd(ticket);}};
  const read=file=>io('checkpoint-read',file,()=>fs.readFileSync(file));
  const stat=file=>io('checkpoint-stat',file,()=>{try{return fs.statSync(file);}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;}});
  const digest=(file,limit=Infinity)=>{
    const hash=crypto.createHash('sha256'),chunk=Buffer.allocUnsafe(128*1024);
    const fd=io('checkpoint-open',file,()=>fs.openSync(file,'r'));
    let offset=0;
    try{while(offset<limit){const count=io('checkpoint-read',file,()=>fs.readSync(fd,chunk,0,Math.min(chunk.length,limit-offset),null));if(!count)break;hash.update(chunk.subarray(0,count));offset+=count;}}
    finally{io('checkpoint-close',file,()=>fs.closeSync(fd));}
    return hash.digest('hex');
  };
  const compatible=options=>sha(JSON.stringify({schema:SCHEMA,platform:process.platform,arch:process.arch,
    native:digest(Object.keys(require.cache).find(p=>p.endsWith('.node'))),frontend:digest(options.svFrontendPath)}));
  const context=(paths,options,identity)=>sha(JSON.stringify({identity,paths,options:{...options,shared:undefined,forceReparse:undefined,checkpointSnapshot:undefined}}));
  function folder(directory,identity){return path.join(directory,sha(identity));}
  function save(handle,request){
    const {directory,identity,paths,options}=request;
    const text=api.graphCheckpoint(handle),snapshot=JSON.parse(text||'null');
    if(!snapshot?.hierarchyUsable||!snapshot.inputDigests||!Object.keys(snapshot.inputDigests).length)
      return {saved:false,reason:'no-compiler-input-digests'};
    const inputs=new Map(Object.entries(snapshot.inputDigests).map(([file,hash])=>[key(file),{file,hash,limit:snapshot.inputDigestLimits?.[file]}]));
    for(const extra of snapshot.additionalElaborations||[])for(const [file,hash] of Object.entries(extra.snapshot.inputDigests||{})){
      const prior=inputs.get(key(file));if(prior&&prior.hash!==hash)return {saved:false,reason:'inconsistent-input-revisions'};
      if(!prior)inputs.set(key(file),{file,hash});
    }
    // Verify against the bytes the compiler actually used. A save during
    // parsing cannot accidentally certify a new file with an old netlist.
    for(const item of inputs.values())if(digest(item.file,item.limit)!==item.hash)return {saved:false,reason:'source-changed',file:item.file};
    for(const file of request.dependencies||[]){if(inputs.has(key(file)))continue;
      const s=stat(file);if(s?.isFile()){
        // An existing but unconsumed header search candidate is recorded by
        // existence only; it must stay unconsumed on restore.
        inputs.set(key(file),{file,exists:true});
      }else inputs.set(key(file),{file,exists:false});
    }
    const bytes=zlib.gzipSync(text),hash=sha(bytes);
    if(bytes.length>MAX_BYTES)return {saved:false,reason:'capacity'};
    const dir=folder(directory,identity);io('checkpoint-mkdir',dir,()=>fs.mkdirSync(dir,{recursive:true}));
    const payload=path.join(dir,hash+'.gz'),temporary=payload+'.'+process.pid+'.tmp';
    const manifest={schema:SCHEMA,identity,compatibility:compatible(options),context:context(paths,options,identity),
      inputs:[...inputs.values()],payload:path.basename(payload),bytes:bytes.length,hash,created:Date.now(),stages:['nodes','elaboration']};
    try{
      io('checkpoint-write',temporary,()=>fs.writeFileSync(temporary,bytes));
      io('checkpoint-commit-payload',payload,()=>fs.renameSync(temporary,payload));
      const target=path.join(dir,'manifest.json'),temp=target+'.'+process.pid+'.tmp';
      io('checkpoint-write',temp,()=>fs.writeFileSync(temp,JSON.stringify(manifest)));
      io('checkpoint-commit-manifest',target,()=>fs.renameSync(temp,target));
      for(const file of io('checkpoint-list',dir,()=>fs.readdirSync(dir)))if(file!==manifest.payload&&file!=='manifest.json')
        io('checkpoint-remove',path.join(dir,file),()=>fs.rmSync(path.join(dir,file),{force:true}));
      prune(directory,dir);
      return {saved:true,bytes:bytes.length,inputCount:inputs.size};
    }finally{io('checkpoint-cleanup',temporary,()=>fs.rmSync(temporary,{force:true}));}
  }
  function prune(directory,active){
    const entries=[];
    for(const name of io('checkpoint-list',directory,()=>fs.readdirSync(directory))){
      if(!/^[a-f0-9]{64}$/.test(name))continue;
      const dir=path.join(directory,name);
      const s=stat(dir);if(!s?.isDirectory())continue;
      let bytes=0;
      for(const file of io('checkpoint-list',dir,()=>fs.readdirSync(dir))){const item=stat(path.join(dir,file));if(item?.isFile())bytes+=item.size;}
      let time=s.mtimeMs;try{const m=JSON.parse(read(path.join(dir,'manifest.json')));time=m.created||time;}catch{}
      entries.push({dir,bytes,time});
    }
    entries.sort((a,b)=>(b.dir===active)-(a.dir===active)||b.time-a.time);let size=0,count=0;
    for(const entry of entries){
      if(entry.dir===active||(count<5&&size+entry.bytes<=MAX_BYTES)){size+=entry.bytes;++count;continue;}
      if(path.dirname(path.resolve(entry.dir))!==path.resolve(directory))throw Error('Invalid checkpoint cleanup target');
      io('checkpoint-prune',entry.dir,()=>fs.rmSync(entry.dir,{recursive:true,force:true}));
    }
  }
  function load(paths,options,directory,identity){
    let reason='missing';
    try{
      const dir=folder(directory,identity),m=JSON.parse(read(path.join(dir,'manifest.json')));
      reason='incompatible';
      if(m.schema!==SCHEMA||m.identity!==identity||m.compatibility!==compatible(options)||m.context!==context(paths,options,identity))throw Error(reason);
      if(!/^[a-f0-9]{64}\.gz$/.test(m.payload)||m.bytes>MAX_BYTES)throw Error('invalid-manifest');
      reason='changed';
      for(const item of m.inputs){const s=stat(item.file);
        if(item.hash ? !s?.isFile()||digest(item.file,item.limit)!==item.hash : !!s!==item.exists)throw Error(reason);
      }
      reason='corrupt';const bytes=read(path.join(dir,m.payload));
      if(bytes.length!==m.bytes||sha(bytes)!==m.hash)throw Error(reason);
      const text=zlib.gunzipSync(bytes,{maxOutputLength:1024*1024*1024}).toString('utf8');
      const loaded=api.graphLoad(paths,{...options,checkpointSnapshot:text});
      return {...loaded,checkpointStatus:loaded.checkpointRestored?'restored':'rejected'};
    }catch(error){
      if(error.code==='AIRTL_NATIVE_PROCESS_FAILED')throw error;
      return {...api.graphLoad(paths,options),checkpointStatus:reason};
    }
  }
  return {graphSaveCheckpoint:save,graphLoadCheckpoint:load};
}
module.exports={create};
