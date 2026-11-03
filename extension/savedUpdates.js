'use strict';
const fs=require('fs'),crypto=require('crypto');
const {pathKey}=require('./treeProjection');
// One pending batch, one writer. Events received during a write merge into
// the next batch. Callers (including diagram edits) await this same pipeline.
class SavedUpdates {
  constructor(read,perform,report){Object.assign(this,{read,perform,report,pending:new Set(),waiters:[],running:false,disposed:false,timer:null,owner:null});}
  submit(files,immediate=false,options={}){
    if(this.disposed)return Promise.resolve();
    const state=this.read();if(!state)return Promise.resolve();
    if(this.owner&&this.owner!==state.proj)this.cancelPending();
    this.owner=state.proj;for(const file of files)this.pending.add(file);
    this.reloadProject=this.reloadProject||!!options.reloadProject;
    const promise=new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
    if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=null;void this.drain();},immediate?0:50);
    return promise;
  }
  cancelPending(){if(this.timer)clearTimeout(this.timer);this.timer=null;this.pending.clear();this.reloadProject=false;for(const waiter of this.waiters.splice(0))waiter.resolve();this.owner=null;}
  async drain(){
    if(this.running||this.disposed)return;
    this.running=true;
    try{while(this.pending.size&&!this.disposed){
      const files=[...this.pending],owner=this.owner,waiters=this.waiters.splice(0),reloadProject=this.reloadProject;this.pending.clear();this.reloadProject=false;
      try{
        const state=this.read();
        if(state?.proj===owner){
          const known=new Map(Object.entries(state.graph.inputDigests).map(([file,hash])=>[pathKey(file),hash]));
          let changed=!!reloadProject;
          for(const file of changed?[]:files){
            const expected=known.get(pathKey(file));if(!expected){changed=true;break;}
            let timer;
            try{
              const bytes=await Promise.race([fs.promises.readFile(file),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Saved-source disk I/O did not respond: '+file)),15000);})]);
              const limit=state.graph.inputDigestLimits[file];
              if(crypto.createHash('sha256').update(limit?bytes.subarray(0,limit):bytes).digest('hex')!==expected){changed=true;break;}
            }catch(error){if(['ENOENT','ENOTDIR'].includes(error.code)){changed=true;break;}throw error;}
            finally{clearTimeout(timer);}
          }
          if(changed&&this.read()?.proj===owner)await this.perform(files,this.read(),{reloadProject});
        }
        for(const waiter of waiters)waiter.resolve();
      }catch(error){for(const waiter of waiters)waiter.reject(error);this.report(error);}
    }}finally{this.running=false;}
  }
  dispose(){this.disposed=true;this.cancelPending();}
}
module.exports={SavedUpdates};
