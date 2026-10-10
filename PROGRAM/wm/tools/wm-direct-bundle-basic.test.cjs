'use strict';
// Nominal FEATURE-FIRST contract/UI checks. Model responses and owner storage are fake.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const node = (f, q) => f.overlay.querySelector(q);
const until = async (fn, label) => { const end = Date.now()+5000; while (!fn()) { assert(Date.now()<end, label); await new Promise(r=>setTimeout(r,5)); } };
const world = () => ({ requestItemId:'herb', intent:'world_candidate', dependsOn:[], kind:'artifact', title:'Moon herb', userConcept:'A herb', adaptedConcept:'A fictional moon herb', canonCompatibility:{status:'compatible'} });
const tracker = (id='mana', deps=[]) => ({ requestItemId:id, intent:'tracking', dependsOn:deps, targetType:'entity', targetIds:['mira'], displayName:'Mira', kind:'state', label:id, instruction:'Track fictional mana', valueType:'text', currentValue:'unknown', trackingEnabled:true, useEnabled:true });
const bundle = () => ({ bundleVersion:1, worldItems:[world()], adaptiveItems:[tracker(), {...tracker('response'), intent:'entity_analysis', trackingEnabled:false}], unresolved:[] });
const observations=[];
async function open(store) {
 return loadGui({store,observeCommonAnalysis:true, ...(!store ? {beforeHydrate:async({store,key})=>{const data=JSON.parse(store.get(key));data.entries.push({key:'mira',comment:'lmai_entity',content:JSON.stringify({id:'mira',name:'Mira',type:'character',meta:{created:1,updated:1}})});store.set(key,JSON.stringify(data));}}:{})});
}
async function preview(f,payload) {
 assert(node(f,'#user-dlc-unified-preview'), 'combined preview container is available');
 let calls=0; f.common.LLMProvider.isConfigured=()=>true;
 f.common.LLMProvider.call=async(_config,system,user)=>{ calls++; assert.match(system,/bundleVersion/); assert.match(user,/Moon herb/); return {content:JSON.stringify(payload)}; };
 await f.click('.side-link[data-tab="world-additional"]');
 node(f,'#udlc-unified-request').value='Add Moon herb and track Mira mana and a one-time response';
 await f.click('#btn-analyze-user-dlc-unified');
 await until(()=>node(f,'#user-dlc-unified-preview')?.textContent.trim(), 'combined preview shown');
 return ()=>calls;
}
const storedDlc = f => JSON.parse(f.canonicalPayload().entries.find(x=>x.comment==='lmai_user_dlc').content);

test('one mixed preview is read-only; one explicit apply stages then persists linked world/entity/tracking records once',async()=>{
 const f=await open();let fresh;
 try {
  const payload=bundle(); Object.assign(payload.adaptiveItems[1], {enabled:true, tracking_enabled:true, history:[{from:'invented',to:'invented'}]});
  const before=f.store.get(f.key),calls=await preview(f,payload);
  assert.equal(f.store.get(f.key),before);assert.equal(f.calls.writes.length,0);assert.equal(calls(),1);
  assert.equal(node(f,'#user-dlc-unified-preview').querySelectorAll('[data-direct-preview-item]').length,3);
  assert.match(node(f,'#user-dlc-unified-preview').textContent,/세계 설정 후보/);
  assert.equal(node(f,'#btn-apply-user-dlc-unified').disabled,false);
  await f.click('#btn-apply-user-dlc-unified');
  await until(()=>/저장 완료/.test(node(f,'#user-dlc-unified-status').textContent),'owner save complete');
  const data=storedDlc(f); assert.equal(data.worldItems.length,1);assert.equal(data.entityTrackers.length,2);
  const ids=[data.worldItems[0],...data.entityTrackers].map(x=>x.extensionBundle.bundleId);assert.equal(new Set(ids).size,1);
  assert.equal(data.entityTrackers.find(x=>x.label==='mana').enabled,true);assert.equal(data.entityTrackers.find(x=>x.label==='response').enabled,false);assert.equal(data.entityTrackers.find(x=>x.label==='response').history.length,0);
  assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,2); assert.equal(calls(),1); assert.equal(f.calls.hostWrites.length,2, 'each prepared/published native owner save has its fixture chat companion');
  assert(!f.calls.hostWrites[0].localLore.some(x=>String(x.comment||'').startsWith('lmai_')), 'canonical managed rows stay in their owner store');
  fresh=await open(f.store); assert.equal(fresh.api.UserDlcCore.getState().entityTrackers.length,2);assert.equal(storedDlc(fresh).worldItems[0].extensionBundle.bundleId,ids[0]);
  observations.push({case:'mixed preview/staged owner saves/fresh runtime',fakeModelCalls:1,ownerWrites:2,fakeChatCompanionWrites:2,realHostWrites:0});
 }finally{fresh?.close();f.close();}
});

test('linked tracker persists waiting_dependency and cannot run or inject before canonical dependency resolution',async()=>{
 const f=await open();let fresh;
 try {
  const payload=bundle();payload.adaptiveItems=[tracker('herb-effect',['herb'])]; await preview(f,payload);
  assert.match(node(f,'#user-dlc-unified-preview').textContent,/설정 준비 중/);
  await f.click('#btn-apply-user-dlc-unified');await until(()=>/저장 완료/.test(node(f,'#user-dlc-unified-status').textContent),'waiting bundle saved');
  fresh=await open(f.store); const core=fresh.api.UserDlcCore, entry=core.getState().entityTrackers[0];
  assert.equal(entry.extensionBundle.status,'waiting_dependency');assert.deepEqual(Array.from(entry.extensionBundle.dependsOn),['herb']);
  assert.equal(entry.enabled,false);assert.equal(entry.updateMode,'manual');assert.equal(entry.injectionDisabled,true);
  assert.equal(core.setTrackerEnabled(entry.id,true).reason,'waiting_dependency'); assert.equal(core.setInjectionState('tracker',entry.id,true).reason,'waiting_dependency');
  assert(!core.formatTrackersForAnalysis().includes('herb-effect'));
  assert.match(node(fresh,'#user-dlc-tracker-list')?.textContent||fresh.overlay.textContent,/설정 준비 중/);
  observations.push({case:'dependency wait durable and disabled',realModelCalls:0});
 }finally{fresh?.close();f.close();}
});

test('unknown target blocks the whole preview, and cancel preserves existing owner bytes',async()=>{
 const f=await open();
 try {
  const before=f.store.get(f.key),payload=bundle();payload.adaptiveItems[0].targetIds=['unknown-person'];
  await preview(f,payload); assert.equal(node(f,'#btn-apply-user-dlc-unified').disabled,true);assert.match(node(f,'#user-dlc-unified-preview').textContent,/대상 확인/);
  assert.equal(f.store.get(f.key),before);assert.equal(f.calls.writes.length,0);
  await f.click('#btn-cancel-user-dlc-unified');assert.equal(node(f,'#user-dlc-unified-preview').textContent,'');assert.equal(f.store.get(f.key),before);assert.equal(f.calls.writes.length,0);
  observations.push({case:'unresolved target/cancel',ownerWrites:0});
 }finally{f.close();}
});
test.after(()=>{if(process.env.WM_BASIC_CHECKPOINT)fs.writeFileSync(path.join(process.env.WM_BASIC_CHECKPOINT,'BASIC-SMOKE-OBSERVATIONS.json'),JSON.stringify({observations,limits:'Three nominal fake-host cases. No real semantic-model quality, actual host, deep regression, independent or Full/Min qualification.'},null,2)+'\n');});
