'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
const families=['memory','entity','world','narrative'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const profile={enabled:true,provider:'ollama',url:'http://127.0.0.1:9999',model:'tiny-3',dimension:3,modelRevision:'rev1',key:'',timeout:120000};
async function gui(settings={},args={}){return loadGui({store:new Map([['LMAI_Config',JSON.stringify(settings)]]),args:{embedding_enabled:'',...args}});}
function edit(f,id,value){const el=f.overlay.querySelector('#'+id);assert(el,'actual markup '+id);if(el.type==='checkbox')el.checked=value;else el.value=String(value);el.dispatchEvent(new f.w.Event('change',{bubbles:true}));}
async function settle(f){for(let i=0;i<50;i++){await sleep(20);if(f.overlay.querySelector('#settings-auto-save-status')?.dataset.state==='saved')return;}assert.fail('actual settings autosave did not finish');}
test('actual GUI every Dual setting autosaves and survives reopen and fresh registered plugin startup',async()=>{
 const f=await gui({embed:profile});let fresh;
 try{
  edit(f,'sdual-mode','dual');edit(f,'sdual-hdepth',4);edit(f,'sdual-sdepth',7);edit(f,'sdual-rrf',20);edit(f,'sdual-budget',250);
  edit(f,'sedimension',5);edit(f,'serevision','explicit-rev2');edit(f,'seenabled',true);
  for(const family of families){edit(f,'sdual-'+family+'-heuristic',.03);edit(f,'sdual-'+family+'-semantic',.75);edit(f,'sdual-'+family+'-margin',.12);}
  await settle(f);const saved=JSON.parse(f.store.get('LMAI_Config')),h=f.api.TypedRecallRollout.begin();
  assert.equal(saved.embed.dimension,5);assert.equal(saved.embed.modelRevision,'explicit-rev2');assert.equal(saved.embed.enabled,true);
  assert.equal(h.provider.dimension,5);assert.equal(h.policy.heuristicDepth,4);assert.equal(h.policy.semanticDepth,7);assert.equal(h.policy.rrf.k,20);assert.equal(h.policy.queryBudgetMs,250);
  for(const family of families){assert.equal(h.policy.admission[family].heuristicMinScore,.03);assert.equal(h.policy.admission[family].semanticMinScore,.75);assert.equal(h.policy.admission[family].semanticMinMargin,.12);}
  assert.match(f.overlay.querySelector('#sdual-readiness').textContent,/configured.*true/);assert.match(f.overlay.querySelector('#sdual-readiness').textContent,/ready.*false/);
  await f.click('#xbtn');await f.callbacks.setting();assert.equal(f.w.document.querySelector('#sedimension').value,'5');
  fresh=await loadGui({store:f.store,args:{embedding_enabled:''}});assert.equal(fresh.overlay.querySelector('#serevision').value,'explicit-rev2');
  assert.equal(fresh.api.TypedRecallRollout.begin().policy.rrf.k,20);assert.equal(fresh.api.TypedRecallRollout.begin().provider.dimension,5);
  await fresh.callbacks.beforeRequest({messages:[{role:'user',content:'recall current context'}],maxContextTokens:128000},'model');assert.equal(fresh.api.TypedRecallRollout.inspect().last.mode,'dual');
 }finally{fresh?.close();f.close();}
});
for(const [id,value]of [['sedimension',9000],['serevision','x'.repeat(257)],['sdual-memory-semantic',2],['sdual-world-margin',3],['sdual-entity-heuristic',-1],['sdual-narrative-semantic','NaN']])test('invalid actual GUI field refuses save visibly: '+id,async()=>{
 const f=await gui({embed:profile});try{const before=f.store.get('LMAI_Config');edit(f,id,value);await sleep(100);assert.equal(f.store.get('LMAI_Config'),before);assert.equal(f.overlay.querySelector('#settings-auto-save-status').dataset.state,'failed');assert.ok(f.overlay.querySelector('#settings-auto-save-status').textContent.includes(id));}finally{f.close();}
});
test('actual import applies production settings, redacts auth, and preserved saved legacy yields to explicit args on fresh startup',async()=>{
 const f=await gui({embed:profile,dualRecallMode:'dual'});let fresh;
 try{
  const incoming={dualRecallMode:'legacy',dualRecallHeuristicDepth:9,embed:{...profile,key:'SYNTHETIC_PRIVATE_5689',dimension:4,modelRevision:'imported'}};
  const file={name:'settings.json',text:async()=>JSON.stringify(incoming)};
  const input=f.overlay.querySelector('#settings-file-input');Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new f.w.Event('change',{bubbles:true}));await Promise.allSettled(f.pending.splice(0));await sleep(20);
  assert.equal(f.api.TypedRecallRollout.inspect().mode,'legacy');assert.equal(f.api.TypedRecallRollout.begin(),null);assert.equal(f.overlay.querySelector('#sedimension').value,'4');
  assert.ok(!JSON.stringify(f.api.stripSettingsSecrets(incoming)).includes('SYNTHETIC_PRIVATE_5689'));assert.ok(!JSON.stringify(f.api.TypedRecallRollout.inspect()).includes('SYNTHETIC_PRIVATE_5689'));
  fresh=await loadGui({store:f.store,args:{embedding_enabled:'',dual_recall_mode:'dual',dual_recall_heuristic_depth:'2',embedding_dimension:'6',embedding_model_revision:'arg-revision'}});
  const h=fresh.api.TypedRecallRollout.begin();assert.equal(h.policy.heuristicDepth,2);assert.equal(h.provider.dimension,6);assert.equal(h.provider.modelRevision,'arg-revision');
 }finally{fresh?.close();f.close();}
});
