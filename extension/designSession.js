'use strict';
// The only publication/selection owner. Views read this state; they never
// independently resolve the persisted startup selection or load a graph.
let sequence=0,current=null,disposed=false,pending=null,checkpointJob=Promise.resolve(),retirement=Promise.resolve();
const listeners=new Set();
function begin(){
  if(disposed)throw new Error('Design session disposed');
  const token={sequence:++sequence};
  if(pending)pending.resolve();
  let resolve;const promise=new Promise(r=>resolve=r);pending={token,promise,resolve};return token;
}
const valid=token=>!disposed&&token&&token.sequence===sequence;
function finish(token){if(pending?.token===token){pending.resolve();pending=null;}}
async function publish(token,state,reason='load'){
  if(!valid(token))return false;
  const previous=current;
  current=Object.freeze({...state,epoch:sequence});
  try { await Promise.all([...listeners].map(fn=>fn(current,reason))); }
  finally {
    if(previous?.graph && previous.graph!==state.graph){await checkpointJob;await previous.graph.free();}
  }
  if(valid(token))checkpointJob=Promise.resolve().then(()=>state.graph.saveCheckpoint?.()).then(result=>state.onCheckpoint?.(result))
    .catch(error=>state.onCheckpoint?.({saved:false,reason:error.message}));
  return true;
}
async function clear(token){
  if(!valid(token))return;
  const previous=current;current=null;
  const notified=Promise.all([...listeners].map(fn=>fn(null,'switch')));
  const released=checkpointJob.then(()=>previous?.graph?.free());
  retirement=Promise.all([retirement,released]).then(()=>{});
  try{await notified;}finally{await retirement;}
}
async function readReady(){while(pending){const request=pending;await request.promise;if(request===pending)break;}return current;}
function subscribe(fn){listeners.add(fn);return{dispose:()=>listeners.delete(fn)};}
function dispose(){const previous=current;disposed=true;++sequence;if(pending)pending.resolve();pending=null;current=null;listeners.clear();retirement=checkpointJob.then(()=>previous?.graph?.free());}
module.exports={begin,valid,finish,publish,clear,read:()=>current,readReady,subscribe,dispose,checkpointReady:()=>checkpointJob,readyForLoad:()=>retirement};
