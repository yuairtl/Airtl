'use strict';
const fs=require('fs');
const now=()=>Number(process.hrtime.bigint())/1e6;
function readProgress(file){
  const bytes=fs.readFileSync(file);if(bytes.length<16||bytes.subarray(0,8).toString()!=='AIRTLIO1')return null;
  const body=bytes.subarray(16);let hash=2166136261;for(const byte of body)hash=Math.imul(hash^byte,16777619)>>>0;
  if(bytes.subarray(8,16).toString()!==hash.toString(16).padStart(8,'0'))return null;
  try{return JSON.parse(body.toString('utf8'));}catch{return null;}
}
class RequestBudget {
  constructor(id,method,file,computeMs,ioMs){Object.assign(this,{id,method,file,computeMs,ioMs,started:now(),nextRead:0,offset:Infinity,status:null});}
  finish(status){if(status&&status.id===this.id&&status.finished&&Number.isFinite(status.ioMs)&&status.ioMs>=0&&status.ioMs<=status.elapsedMs+1){this.status=status;this.observed=now();}}
  check(force=false){
    const time=now(),elapsed=time-this.started;
    if(force||time>=this.nextRead){this.nextRead=time+10;
      try{const status=readProgress(this.file);
        if(!this.status?.finished&&status&&status.id===this.id&&Number.isFinite(status.ioMs)&&Number.isFinite(status.elapsedMs)&&status.ioMs>=0&&status.ioMs<=status.elapsedMs+1&&(!this.status||status.sequence>this.status.sequence)){
          this.offset=Math.min(this.offset,Math.max(0,elapsed-status.elapsedMs));this.status=status;this.observed=time;
        }
      }catch(e){if(e.code!=='ENOENT'&&e.code!=='EACCES'&&e.code!=='EPERM')throw e;}
    }
    const s=this.status,age=s&&!s.finished?Math.max(0,elapsed-this.offset-s.elapsedMs):0;
    const excluded=s?Math.min(elapsed,s.ioMs+(s.ioOnly&&!s.finished?age:0)):0;
    if(s&&s.ioMaxGapMs>=this.ioMs)return {timeoutKind:'io',method:this.method,path:s.maxPath,operation:s.maxOperation,message:`磁盘 I/O 连续无响应：${s.maxOperation} ${s.maxPath}`};
    if(s&&!s.finished&&time-this.observed>=this.ioMs)return {timeoutKind:'progress',method:this.method,message:'原生进度通道连续无响应'};
    if(s&&s.ioPending>0&&!s.finished&&s.ioStallMs+age>=this.ioMs)return {timeoutKind:'io',method:this.method,path:s.path,operation:s.operation,message:`磁盘 I/O 连续无响应：${s.operation} ${s.path}`};
    if(elapsed-excluded>=this.computeMs)return {timeoutKind:'compute',method:this.method,message:`非 I/O 处理累计超时：${this.method}`,elapsedMs:elapsed,ioMs:excluded,progress:s};
    this.metrics={elapsedMs:elapsed,ioMs:excluded,computeMs:elapsed-excluded};return null;
  }
}
module.exports={RequestBudget,readProgress};
