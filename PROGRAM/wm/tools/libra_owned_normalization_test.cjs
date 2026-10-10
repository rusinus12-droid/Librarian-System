'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const {memoryEntry}=require('./libra_recall_test_runtime.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
async function setup(dist=process.env.REGRESSION_WM_FULL){
 let count=0,ticks=0,checkpoints=0,onCheckpoint;
 const r=await runtime(null,{dist,admittedHost:true,transformCode(code){
  const seam='const ctl = controller || createYieldController();', migrate='const migrateEntry = (entry = null) => {';
  assert.equal(code.split(seam).length,2);assert.equal(code.split(migrate).length,2);
  return code.replace(migrate,migrate+' globalThis.__NORM_ROW__?.();')
   .replace(seam,seam+' if(ctl.label === "lore_normalization") await globalThis.__NORM_CHECKPOINT__?.();');
 }});
 r.context.__NORM_ROW__=()=>{count++;ticks+=6;};
 r.context.__NORM_CHECKPOINT__=async()=>{checkpoints++;if(onCheckpoint)await onCheckpoint(checkpoints);};
 r.context.performance={now:()=>ticks};
 r.chat.localLore=Array.from({length:20},(_,i)=>memoryEntry(i+1,'local source '+i));
 r.char.globalLore=Array.from({length:20},(_,i)=>memoryEntry(i+101,'global source '+i));
 const timers=new Set();
 r.context.setTimeout=(fn,ms,...args)=>{let t;t=setTimeout(()=>{timers.delete(t);fn(...args);},ms);timers.add(t);return t;};
 r.context.clearTimeout=t=>{timers.delete(t);clearTimeout(t);};
 const close=r.close;r.close=async()=>{try{await close();}finally{for(const t of timers)clearTimeout(t);}};
 return Object.assign(r,{count:()=>count,checkpoints:()=>checkpoints,onCheckpoint:fn=>onCheckpoint=fn});
}
function prepare(r,isCurrent=()=>true){const char=clone(r.char),chat=char.chats[0];chat.localLore=clone(r.chat.localLore);return{char,chat,options:{cooperative:true,isCurrent,refresh:async()=>isCurrent()}};}
test('owned local and global migration yields to a real timer and preserves baseline draft bytes',async()=>{const r=await setup();let baseline;try{const draft=prepare(r);let observed;const timer=new Promise(resolve=>setTimeout(()=>{observed=r.count();resolve();},0));const changed=await r.api.MemoryEngine.normalizeLoreStorage(draft.char,draft.chat,draft.options);await timer;assert.equal(changed,true);assert.equal(r.checkpoints(),40);assert(observed>0&&observed<40,`timer observed ${observed}/40`);if(process.env.NORMALIZATION_BASELINE_DIST){baseline=await setup(process.env.NORMALIZATION_BASELINE_DIST);const b=prepare(baseline);assert.equal(await baseline.api.MemoryEngine.normalizeLoreStorage(b.char,b.chat),changed);assert.deepEqual(clone(draft.char),clone(b.char));assert.deepEqual(clone(draft.chat),clone(b.chat));}}finally{await r.close();if(baseline)await baseline.close();}});
for(const at of [1,10,20,21,30,40])test('private migration cancellation at '+at+' publishes no draft or source fields',async()=>{const r=await setup();try{let current=true;const draft=prepare(r,()=>current),before=JSON.stringify({char:draft.char,chat:draft.chat,host:r.char,store:[...r.store]});r.onCheckpoint(n=>{if(n===at)current=false;});await assert.rejects(r.api.MemoryEngine.normalizeLoreStorage(draft.char,draft.chat,draft.options),/normalization_source_invalidated/);assert.equal(r.checkpoints(),at);assert.equal(JSON.stringify({char:draft.char,chat:draft.chat,host:r.char,store:[...r.store]}),before);}finally{await r.close();}});
test('a failed fresh source check refuses before cue/index publication',async()=>{const r=await setup();try{const draft=prepare(r),before=JSON.stringify(draft.char);draft.options.refresh=async()=>false;await assert.rejects(r.api.MemoryEngine.normalizeLoreStorage(draft.char,draft.chat,draft.options),/normalization_source_invalidated/);assert.equal(JSON.stringify(draft.char),before);}finally{await r.close();}});
test('missing-source compatibility preparation retains non-yielding migration',async()=>{const r=await setup();try{const draft=prepare(r);draft.options.cooperative=false;assert.equal(await r.api.MemoryEngine.normalizeLoreStorage(draft.char,draft.chat,draft.options),true);assert.equal(r.checkpoints(),0);}finally{await r.close();}});
