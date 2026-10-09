'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./wm-cache-currentness-gui-support.cjs');
const cfg=()=>({enabled:true,provider:'ollama',url:'http://127.0.0.1:9999/api/embed',key:'',model:'tiny-3',timeout:120000});
async function imported(f,embed){await f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'synthetic.json',text:async()=>JSON.stringify({embed})}]}});assert.equal(f.api.MemoryEngine.CONFIG.embed.enabled,embed.enabled);}
async function waitFor(fn){const deadline=Date.now()+5000;while(!fn()){assert(Date.now()<deadline,'registered GUI publication settled');await new Promise(r=>setTimeout(r,10));}}
async function reset(f){const pending=f.overlay.querySelector('#btn-reset-settings').onclick();const modal=f.w.document.querySelector('[data-libra-dialog="true"]');assert(modal);[...modal.querySelectorAll('button')].find(n=>n.textContent==='확인').click();await pending;}
for(const kind of ['manual save','autosave','reset'])test('real '+kind+' publication ABA retires old pending legacy embedding',async()=>{
 let started,finish;const ready=new Promise(r=>started=r),gate=new Promise(r=>finish=r);let calls=0;
 const f=await loadGui({args:{embedding_enabled:''},nativeFetch:async()=>{calls++;started();await gate;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})}}});
 try {
  await imported(f,cfg());const m=f.api.MemoryEngine,identity=m.CONFIG;const old=m.EmbeddingEngine.getEmbedding('Synthetic '+kind+' config publication');await ready;
  if(kind==='reset'){await reset(f);await imported(f,cfg());}
  else for(const value of [false,true]){
   const input=f.overlay.querySelector('#seenabled');input.checked=value;
   if(kind==='manual save')f.overlay.querySelector('#btn-save-settings').onclick();
   else input.dispatchEvent(new f.w.Event('change',{bubbles:true}));
   await waitFor(()=>m.CONFIG.embed.enabled===value && f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');
  }
  finish();assert.equal(await old,null);assert.equal(m.CONFIG,identity);assert.equal(m.getCacheStats().embedding.size,0);assert.equal(calls,1);
 }finally{finish();f.close();}
});
test('unrelated successful GUI autosave preserves a completed embedding cache hit',async()=>{
 let calls=0;const f=await loadGui({args:{embedding_enabled:''},nativeFetch:async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})}}});
 try {
  await imported(f,cfg());const m=f.api.MemoryEngine,text='Synthetic unrelated GUI cache hit';assert(Array.isArray(await m.EmbeddingEngine.getEmbedding(text)));
  const input=f.overlay.querySelector('#sdebug');input.checked=true;input.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  await waitFor(()=>f.overlay.querySelector('#settings-auto-save-status').dataset.state==='saved');
  assert(Array.isArray(await m.EmbeddingEngine.getEmbedding(text)));assert.equal(calls,1);
 }finally{f.close();}
});
