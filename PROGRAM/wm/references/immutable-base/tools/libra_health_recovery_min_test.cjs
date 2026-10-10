'use strict';
const assert=require('node:assert/strict');
process.env.LIBRA_GUI_TEST_FILTER='^$';
const {loadGui}=require('./libra_health_min_gui_helper.cjs');
(async()=>{
 const checks=[];async function test(name,fn){let f;try{f=await loadGui();await fn(f);checks.push({name,ok:true})}catch(e){checks.push({name,ok:false,error:e.stack});process.exitCode=1}finally{f?.close()}}
 await test('existing Scan button performs a read-only scan without canonical or host writes',async f=>{
  const before=f.store.get(f.key);await f.click('#btn-health-scan');assert.equal(f.store.get(f.key),before);assert.equal(f.calls.writes.filter(x=>x.key.startsWith('LIBRA_DATA::')).length,0);assert.equal(f.calls.hostWrites.length,0);const n=f.overlay.querySelector('#health-recovery-status');assert(n);assert.match(n.textContent,/읽기 전용/);
 });
 await test('existing health UI previews and verifies idempotent derived refresh',async f=>{
  const before=f.store.get(f.key);await f.click('#btn-health-repair-preview');assert.match(f.overlay.querySelector('#health-recovery-status').textContent,/캐시.*원문/);await f.click('#btn-health-repair-apply');assert.match(f.overlay.querySelector('#health-recovery-status').textContent,/검증 완료/);await f.click('#btn-health-repair-apply');assert.equal(f.store.get(f.key),before);assert.equal(f.calls.writes.filter(x=>x.key.startsWith('LIBRA_DATA::')).length,0);assert.equal(f.calls.hostWrites.length,0);
 });
 await test('canonical change invalidates preview before derived refresh',async f=>{
  await f.click('#btn-health-repair-preview');const before=JSON.parse(f.store.get(f.key));before.entries.push({comment:'other',content:'new'});f.store.set(f.key,JSON.stringify(before));await f.click('#btn-health-repair-apply');assert.match(f.overlay.querySelector('#health-recovery-status').textContent,/변경.*다시 검사/);assert.equal(f.calls.writes.filter(x=>x.key.startsWith('LIBRA_DATA::')).length,0);
 });
 await test('persona switch invalidates preview before derived refresh',async f=>{
  await f.click('#btn-health-repair-preview');f.control.chat.bindedPersona='persona-b';await f.click('#btn-health-repair-apply');assert(!/검증 완료/.test(f.overlay.querySelector('#health-recovery-status').textContent));assert.equal(f.calls.writes.filter(x=>x.key.startsWith('LIBRA_DATA::')).length,0);
 });
 await test('bounded read-only scans continue only the same canonical snapshot',async f=>{
  const payload=f.canonicalPayload();payload.entries.push(...Array.from({length:321},(_,i)=>({key:'scan-'+i,comment:'lmai_entity',content:JSON.stringify({id:'scan-'+i,name:'Person '+i,meta:{created:1,updated:1}})})));f.store.set(f.key,JSON.stringify(payload));const before=f.store.get(f.key);
  await f.click('#btn-health-scan');const status=f.overlay.querySelector('#health-recovery-status');assert.match(status.textContent,/일부 완료/);const first=Number(status.dataset.scannedThrough);assert(first>0);
  await f.click('#btn-health-scan');assert(Number(status.dataset.scannedThrough)>first,'read-only cursor advances instead of restarting the same work');assert.equal(f.store.get(f.key),before);assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,0);
 });
 await test('coverage is unknown before scan, incomplete through refresh, and invalidated by changed bytes',async f=>{
  const payload=f.canonicalPayload();payload.entries=Array.from({length:321},(_,i)=>({key:'scan-'+i,comment:'lmai_entity',content:JSON.stringify({id:'scan-'+i,name:'Person '+i,meta:{created:1,updated:1}})}));f.store.set(f.key,JSON.stringify(payload));
  await f.click('#btn-health-refresh');let summary=f.overlay.querySelector('#health-summary');assert.notEqual(summary.dataset.healthSeverity,'ok');assert.equal(summary.dataset.coverage,'unscanned');
  if(f.api){const h=f.api.ActivityDashboardCore.getState().healthSummary;assert.notEqual(h.severity,'ok');assert(!h.message.includes('데이터 헬스 정상'));}
  await f.click('#btn-health-scan');const progress=f.overlay.querySelector('#health-recovery-status').dataset.scannedThrough;assert.equal(summary.dataset.coverage,'incomplete');assert.notEqual(summary.dataset.healthSeverity,'ok');
  await f.click('#btn-health-refresh');assert.equal(summary.dataset.coverage,'incomplete');assert.equal(f.overlay.querySelector('#health-recovery-status').dataset.scannedThrough,progress);assert.notEqual(summary.dataset.healthSeverity,'ok');
  payload.entries[0].content=JSON.stringify({id:'scan-0',name:'Changed person',meta:{created:1,updated:2}});f.store.set(f.key,JSON.stringify(payload));await f.click('#btn-health-refresh');assert.equal(summary.dataset.coverage,'unscanned');assert.equal(f.overlay.querySelector('#health-recovery-status').dataset.scannedThrough,'0');assert.notEqual(summary.dataset.healthSeverity,'ok');
 });
 await test('completed coverage survives same-source Refresh, and reset releases old coverage and ticket',async f=>{
  await f.click('#btn-health-scan');assert.equal(f.overlay.querySelector('#health-summary').dataset.coverage,'complete');
  await f.click('#btn-health-refresh');assert.equal(f.overlay.querySelector('#health-summary').dataset.coverage,'complete');
  let ticket=null;if(f.api){const binding=await f.api.ManagementReviewCore.captureBinding({char:f.control.char,chat:f.control.chat});ticket=await f.api.ManagementReviewCore.previewRepair(binding);}
  const action=f.overlay.querySelector('#lmai-data-reset').onclick();const dialog=f.w.document.querySelector('[data-libra-dialog="true"]');assert(dialog);[...dialog.querySelectorAll('button')].find(n=>n.textContent==='확인').click();await action;
  const fresh=f.w.document.querySelector('#lmai-overlay');assert.equal(JSON.parse(f.store.get(f.key)).entries.length,0);assert.equal(fresh.querySelector('#health-summary').dataset.coverage,'complete');assert.equal(fresh.querySelector('#health-recovery-status').dataset.scannedThrough,'0');assert.equal(fresh.querySelector('#btn-health-repair-apply').disabled,true);
  if(f.api){assert.equal((await f.api.ManagementReviewCore.repairDerivedCache(ticket)).status,'blocked');assert.equal(f.api.ManagementReviewCore.healthRetention().scanMetadataCodeUnits,0);}
 });
 await test('one current proof plus scan metadata are retained; closing releases them',async f=>{
  const payload=f.canonicalPayload();payload.entries=Array.from({length:321},(_,i)=>({key:'scan-'+i,comment:'lmai_entity',content:JSON.stringify({id:'scan-'+i,name:'Person '+i,meta:{created:1,updated:1}})}));f.store.set(f.key,JSON.stringify(payload));await f.click('#btn-health-scan');
  for(let i=0;i<3;i++)await f.click('#btn-health-repair-preview');
  if(f.api){const retention=f.api.ManagementReviewCore.healthRetention();assert.equal(retention.ownedCanonicalSnapshots,1);assert.equal(retention.fullLoreSnapshotsRetained,0);assert.equal(retention.canonicalCodeUnits,f.store.get(f.key).length);assert(retention.ticket.bindingCodeUnits<32);console.log('HEALTH_RETENTION '+JSON.stringify(retention));}
  await f.click('#xbtn');if(f.api){const r=f.api.ManagementReviewCore.healthRetention();assert.equal(r.canonicalCodeUnits,0);assert.equal(r.scanMetadataCodeUnits,0);assert.equal(r.ticket.bindingCodeUnits,0);}
 });
 console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,checks},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
