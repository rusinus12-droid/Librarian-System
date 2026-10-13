'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {test}=require('node:test');
const {JSDOM}=require('jsdom');
const {createArchiveReportingFixture}=require('./fixtures/archive_reporting_fixture.cjs');
const artifacts=process.env.FLASHBACK_REPORTING_ARTIFACTS;
const kinds=artifacts?['Full','Min']:['source'];
for(const kind of kinds)for(const mixed of [false,true])test(`${kind} registered local-only GUI ${mixed?'confirmation, cancellation and result':'archive-only refusal'} uses one truthful boundary`,async t=>{
 const f=await createArchiveReportingFixture();let dom;
 try{
  const cfg=f.api._test.normalizeSettings({...f.fixtureSettings,embeddingDimensions:6,chunkChars:400,chunkOverlap:0});
  await f.api.saveSettings(cfg);const rows=mixed?await f.seedMixed(cfg):[];
  if(kind!=='source'){await f.restart(path.join(artifacts,kind,'plugins/Flashback_Memory.js'));if(kind==='Min')assert.equal(f.api._test,undefined,'official release profile excludes developer surface');else assert.equal(typeof f.api._test,'object','official Full source profile preserves developer surface');}
  dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{url:'https://fixture.invalid/',pretendToBeVisual:true});
  Object.assign(f.context,{document:dom.window.document,window:dom.window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window)});
  assert.equal(await f.api.showUi(),true,'actual public showUi mounts production controls');
  await f.api.refreshUi('import');
  const doc=dom.window.document,mode=doc.getElementById('maintenanceMode'),button=doc.getElementById('maintenanceRunBtn');
  assert(mode&&button,'actual generated controls are present');mode.value='reembed';
  await t.test('entry label and help state local pending scope',()=>{
    assert.equal(mode.selectedOptions[0].textContent,'로컬 미완료 벡터 복구');
    assert.match(mode.closest('.grid')?.textContent||mode.parentNode.parentNode.textContent,/저장된 대기 항목만 처리/);
  });
  const dialog=()=>doc.querySelector('.overlay.is-open .dialog [id$="-message"]');
  button.click();const first=await f.waitFor(dialog,'first GUI dialog');
  if(!mixed){
    assert.match(first.textContent,/아카이브 벡터 복구는 아직 지원하지 않습니다/);
    assert.match(first.textContent,/로컬 미완료 벡터/);assert.equal(f.requests,0);
    doc.querySelector('.overlay.is-open .dialog .dialog__actions button:last-child').click();await f.waitFor(()=>!dialog(),'denied dialog dismissal');
  }else{
    assert.match(first.textContent,/현재 로컬에 이미 저장된 미완료 벡터/);
    assert.match(first.textContent,/미완료 작업 수가 아닙니다/);
    assert.match(first.textContent,/아카이브 3개 레코드/);
    doc.querySelector('.overlay.is-open .dialog .dialog__actions button:first-child').click();await f.waitFor(()=>!dialog(),'cancelled confirmation');
    assert.equal(f.requests,0,'cancelled confirmation submits no request');
    button.click();await f.waitFor(dialog,'second confirmation');doc.querySelector('.overlay.is-open .dialog .dialog__actions button:last-child').click();
    const result=await f.waitFor(()=>{const d=dialog();return d&&!d.textContent.includes('확인한 대상만 실행할까요?')?d:null},'local repair result');
    assert.match(result.textContent,/로컬 대상 검증: 완료/);
    assert.match(result.textContent,/아카이브 3개 레코드 제외 · 아카이브 복구 미지원/);
    assert.match(result.textContent,new RegExp('완료 '+rows.length+' · 미완료 0'));
    assert.match(result.textContent,/전체 자료 정상 여부는 별도 점검/);
    doc.querySelector('.overlay.is-open .dialog .dialog__actions button:last-child').click();await f.waitFor(()=>!dialog(),'result dismissal');
    assert.equal((await f.api.healthRecovery.previewPhysicalRepair()).reason,'archive_repair_unsupported');
  }
  const archiveKey=[...f.protectedArchive.keys()].find(key=>key.endsWith(':manifest:v2'));
  const raw=f.pluginStorage.values.get(archiveKey),damaged=f.parseStoredValue(raw);
  f.pluginStorage.values.set(archiveKey,JSON.stringify({...damaged,archiveId:'incomplete-gui-inventory'}));
  try{
    doc.getElementById('maintenanceInspectBtn').click();
    const inspected=await f.waitFor(dialog,'unknown archive diagnostic');
    assert.match(inspected.textContent,/아카이브 확인 불가/);
    assert.doesNotMatch(inspected.textContent,/벡터 복구 0 · 로컬 0 · 아카이브 0/);
    doc.querySelector('.overlay.is-open .dialog .dialog__actions button:last-child').click();await f.waitFor(()=>!dialog(),'unknown diagnostic dismissal');
  }finally{f.pluginStorage.values.set(archiveKey,raw);}
  f.assertMapSubsetUnchanged(f.protectedArchive,f.pluginStorage.values,'archive GUI plugin bytes');
  f.assertMapSubsetUnchanged(f.archiveVectors,f.safeLocalStorage.values,'archive GUI vector bytes');
  assert.equal((await f.api.inspectMemoryMaintenance()).archiveRecordsNeedingEmbedding,3);
  await f.api.closeUi();assert.equal(f.api.uiStatus().visible,false);
 }finally{await f.dispose();dom?.window.close();}
});
