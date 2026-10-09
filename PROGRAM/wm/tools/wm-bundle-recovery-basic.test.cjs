'use strict';
// FEATURE-FIRST nominal persistent job, explicit recovery and existing-rule linkage only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
const node=(f,q)=>f.overlay.querySelector(q), until=async(fn,label)=>{const end=Date.now()+7000;while(!fn()){assert(Date.now()<end,label);await new Promise(r=>setTimeout(r,5));}};
const payload=()=>({bundleVersion:1,worldItems:[{requestItemId:'herb',intent:'world_candidate',dependsOn:[],kind:'artifact',title:'Moon herb',adaptedConcept:'A fictional moon herb',canonCompatibility:{status:'compatible'}}],adaptiveItems:[{requestItemId:'mana',intent:'tracking',dependsOn:['herb'],targetType:'entity',targetIds:['mira'],kind:'state',label:'Mana',instruction:'Track fictional mana after the linked rule',valueType:'text',currentValue:'unknown',useEnabled:true}],unresolved:[]});
const stored=f=>JSON.parse(f.canonicalPayload().entries.find(x=>x.comment==='lmai_user_dlc').content);
const observations=[];
async function open(store){return loadGui({store,observeCommonAnalysis:true,...(!store?{beforeHydrate:async({store,key})=>{const data=JSON.parse(store.get(key));data.entries.push({key:'mira',comment:'lmai_entity',content:JSON.stringify({id:'mira',name:'Mira',type:'character',meta:{created:1,updated:1}})});store.set(key,JSON.stringify(data));}}:{})});}
async function preview(f){let calls=0;f.common.LLMProvider.isConfigured=()=>true;f.common.LLMProvider.call=async()=>{calls++;return {content:JSON.stringify(payload())};};node(f,'#udlc-unified-request').value='Add Moon herb and track Mira mana';await f.click('#btn-analyze-user-dlc-unified');await until(()=>node(f,'#btn-apply-user-dlc-unified'),'preview');return ()=>calls;}
async function apply(f){await f.click('#btn-apply-user-dlc-unified');await until(()=>/저장 완료|저장 미확정|처리 보류/.test(node(f,'#user-dlc-unified-status').textContent),'apply terminal');}
test('one explicit apply stages the result then publishes linked records and grouped durable outcome',async()=>{
 const f=await open();let fresh;try{
  assert(node(f,'#user-dlc-bundle-results'),'grouped persistent card container exists');const calls=await preview(f);assert.equal(f.calls.writes.length,0);await apply(f);
  const saved=stored(f),job=saved.directBundles[0];assert.equal(job.status,'applied');assert.equal(job.items.length,2);assert(job.items.every(x=>x.status==='committed'));assert.equal(job.prepared,null);assert.equal(job.result.world,1);assert.equal(job.result.waiting,1);assert.equal(calls(),1);
  const writes=f.calls.writes.filter(x=>x.key===f.key);assert.equal(writes.length,2);const first=JSON.parse(JSON.parse(writes[0].value).entries.find(x=>x.comment==='lmai_user_dlc').content);assert.equal(first.worldItems.length,0);assert.equal(first.directBundles[0].status,'prepared');assert(first.directBundles[0].items.every(x=>x.status==='pending'));
  fresh=await open(f.store);const card=node(fresh,'[data-direct-bundle-id]');assert(card);assert.equal(card.dataset.directBundleId,job.bundleId);assert.match(card.textContent,/적용 완료|설정 준비 중/);assert.equal(fresh.calls.openWrites.length,0);observations.push({case:'durable grouped outcome',fakeModelCalls:1,ownerWrites:2});
 }finally{fresh?.close();f.close();}
});
test('prepared success survives rejected publication and fresh-runtime recovery reuses it without provider calls',async()=>{
 const f=await open();let fresh;try{
  await preview(f);f.control.afterSet=async(key,value)=>{if(key!==f.key)return;const row=JSON.parse(value).entries.find(x=>x.comment==='lmai_user_dlc');if(row&&JSON.parse(row.content).directBundles?.[0]?.status==='prepared')f.control.rejectWrites=true;};await apply(f);
  const saved=stored(f);assert.equal(saved.directBundles[0].status,'prepared');assert.equal(saved.entityTrackers.length,0);const id=saved.directBundles[0].bundleId;
  fresh=await open(f.store);let calls=0;fresh.common.LLMProvider.call=async()=>{calls++;throw Error('recovery must reuse saved output');};
  assert(node(fresh,'[data-direct-bundle-recover]'));await fresh.click('[data-direct-bundle-recover]');await until(()=>stored(fresh).directBundles[0].status==='applied','prepared recovery applied');
  assert.equal(stored(fresh).directBundles[0].bundleId,id);assert.equal(stored(fresh).worldItems.length,1);assert.equal(stored(fresh).entityTrackers.length,1);assert.equal(calls,0);assert.equal(fresh.calls.writes.filter(x=>x.key===fresh.key).length,1);observations.push({case:'restart pending publication recovery',fakeModelCallsOnRecovery:0});
 }finally{fresh?.close();f.close();}
});
test('group dependency action binds a selected saved custom rule and releases only its waiting tracker',async()=>{
 const f=await open();let fresh;try{
  await preview(f);await apply(f);assert.equal(stored(f).entityTrackers[0].extensionBundle.status,'waiting_dependency');
  // Fixture represents an independently committed owner rule, never a candidate status.
  const data=f.canonicalPayload();data.entries.push({key:'lmai_world_graph::compact',comment:'lmai_world_graph',content:JSON.stringify({schema:'libra.world.graph.compact.v2',version:'6.1',rootId:'world_main',nodes:[['world_main',{id:'world_main',name:'Main world',rules:{custom:{rule_1:'Moon herb restores fictional mana.'}},meta:{created:1,updated:9,source:'user'}}]],activePath:['world_main']})});f.store.set(f.key,JSON.stringify(data));
  fresh=await open(f.store);const select=node(fresh,'[data-direct-bundle-dependency]');assert(select);assert.equal(select.value,'');assert.equal(stored(fresh).entityTrackers[0].enabled,false);assert.equal(select.options.length,2);select.value=select.options[1].value;
  await fresh.click('[data-direct-bundle-resolve]');await until(()=>stored(fresh).entityTrackers[0].extensionBundle.status==='ready','verified dependency release');const item=stored(fresh).entityTrackers[0];assert.equal(item.enabled,true);assert.equal(item.injectionDisabled,false);assert.equal(item.extensionBundle.canonicalRefs[0].nodeId,'world_main');assert.equal(item.extensionBundle.canonicalRefs[0].ruleId,'rule_1');assert(item.extensionBundle.canonicalRefs[0].version);assert.equal(stored(fresh).worldItems[0].status,'analyzed');
  const again=await open(fresh.store);try{assert.equal(stored(again).entityTrackers[0].extensionBundle.canonicalRefs[0].version,item.extensionBundle.canonicalRefs[0].version);assert.equal(again.api.UserDlcCore.getState().entityTrackers[0].enabled,true);}finally{again.close();}observations.push({case:'explicit existing owner rule link',realModelCalls:0});
 }finally{fresh?.close();f.close();}
});
test('failed item state persists beside pending items and explicit recovery uses the retained result',async()=>{
 const f=await open();let changed,restored;try{
  await preview(f);f.control.afterSet=async(key,value)=>{if(key===f.key&&JSON.parse(value).entries.some(row=>row.comment==='lmai_user_dlc'&&JSON.parse(row.content).directBundles?.[0]?.status==='prepared'))f.control.rejectWrites=true;};await apply(f);
  const data=f.canonicalPayload(),entity=data.entries.find(row=>row.comment==='lmai_entity');const original=entity.content;entity.content=JSON.stringify({...JSON.parse(original),name:'Mira renamed'});f.store.set(f.key,JSON.stringify(data));
  changed=await open(f.store);await changed.click('[data-direct-bundle-recover]');await until(()=>stored(changed).directBundles[0].status==='failed','per-item failure stored');
  const failed=stored(changed);assert.equal(failed.worldItems.length,0);assert.equal(failed.directBundles[0].items.find(row=>row.owner==='world').status,'pending');assert.equal(failed.directBundles[0].items.find(row=>row.owner==='tracker').status,'failed');assert(failed.directBundles[0].prepared.entityTrackers.length);
  const repaired=changed.canonicalPayload();repaired.entries.find(row=>row.comment==='lmai_entity').content=original;changed.store.set(changed.key,JSON.stringify(repaired));restored=await open(changed.store);let calls=0;restored.common.LLMProvider.call=async()=>{calls++;throw Error('saved result required');};await restored.click('[data-direct-bundle-recover]');await until(()=>stored(restored).directBundles[0].status==='applied','retry after target restored');assert.equal(calls,0);assert.equal(stored(restored).entityTrackers.length,1);observations.push({case:'failed/pending item restart recovery',fakeModelCallsOnRecovery:0});
 }finally{restored?.close();changed?.close();f.close();}
});
test.after(()=>{if(process.env.WM_BASIC_CHECKPOINT)fs.writeFileSync(path.join(process.env.WM_BASIC_CHECKPOINT,'BASIC-SMOKE-OBSERVATIONS.json'),JSON.stringify({observations,limits:'Nominal fake-host only; no deep failure matrix, actual model, live owner or Full/Min qualification.'},null,2)+'\n');});
