'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ownerFixture,envelope,OLD,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
const {createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const SECOND='Alice waited outside.';

async function start({turns=1,extraCalls=0,observeBudget=false}={}){
  const f=await ownerFixture('hayaku',{
    arguments:{hayaku_recovery_extra_calls:String(extraCalls)},
    // Observe the real invocation plan without replacing its budget checks.
    transformSource:observeBudget?source=>source.replace('    globalThis.HAYAKU = exposedApi;',
      '    globalThis.__readReanalysisPlan = () => Memory.nativeRecovery.lastInvocation?.plan;\n    globalThis.HAYAKU = exposedApi;'):undefined
  });
  let gui;
  try{
    if(turns===2){
      f.chat.message.push({role:'user',id:'u2',chatId:'u2',data:'What happens next?'},
        {role:'assistant',id:'a2',chatId:'a2',data:hiddenPacketMessage(SECOND,createValidPacket({turn:2,subject:'Alice',scene:'office',summary:SECOND}))});
      await f.r.callBeforeRequest([{role:'user',content:'Recall both turns.'}],'model');
      await f.r.callAfterRequest('','model');
    }
    gui=createColdStartGuiDocument();
    Object.assign(f.r.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,
      HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,
      getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});
    assert.equal(await f.api.showUi(),true);
    const root=gui.document.getElementById('hayaku-ledger-viewer-root');
    await waitFor(()=>root?.querySelector('.app')&&!root.querySelector('.app').classList.contains('is-busy')
      &&/세계선 원장 · 기록 [\d,]+개/.test(root.querySelector('#hayakuViewerScopeMeta')?.textContent||''),'viewer ready');
    await root.querySelector('[data-hayaku-viewer-goto="recovery"]').fire('click');
    await root.querySelector('[data-recovery-view="reanalysis"]').fire('click');
    const card=root.querySelector('#hayakuSourceEditConsent');
    await waitFor(()=>card.querySelectorAll('[data-reanalysis-ranges] input').length===turns,'stored turn inventory');
    const button=card.querySelector('[data-reanalysis-run]'),status=card.querySelector('[data-reanalysis-status]');
    const select=()=>{for(const input of card.querySelectorAll('input')){
      input.checked=true;input.dispatchEvent(new gui.dom.window.Event('change',{bubbles:true}));
    }};
    select();assert.equal(button.disabled,false);
    const inspected=await f.api.ledger.inspect({includeRecords:true});
    const ledgerKey=inspected.storageKey,ledgerBefore=f.store.values.get(ledgerKey);
    return {f,gui,root,card,button,status,select,ledgerKey,ledgerBefore,
      async open(){button.click();return waitFor(()=>root.querySelector('#hayakuSourceReanalysisConfirmOverlay'),'source reanalysis confirmation');},
      async dispose(){try{await f.dispose();}finally{gui.dom.window.close();}}};
  }catch(error){await f.dispose();gui?.dom.window.close();throw error;}
}

for(const action of ['button','escape','backdrop'])test('source reanalysis '+action+' cancellation issues no model or canonical write',async()=>{
  const s=await start({turns:2,extraCalls:1});
  try{
    const overlay=await s.open();
    assert.equal(s.f.calls(),0,'opening a preview must not call Other Ax');
    assert.match(overlay.textContent,/T1, T2/);
    assert.match(overlay.textContent,/Other Ax 2회 \(턴당 1회\)/);
    assert.match(overlay.textContent,/전체 최대 4회/);
    assert.match(overlay.textContent,/Provider 비용/);
    assert.match(overlay.textContent,/기존 기억을 새 기억으로 자동 교체/);
    assert.equal(s.gui.document.activeElement,overlay.querySelector('[data-reanalysis-confirm="cancel"]'),'initial focus favors cancellation');
    if(action==='button')await overlay.querySelector('[data-reanalysis-confirm="cancel"]').fire('click');
    if(action==='escape')s.gui.document.dispatchEvent(new s.gui.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    if(action==='backdrop')await overlay.fire('click');
    await waitFor(()=>!s.button.disabled&&/취소/.test(s.status.textContent),'cancelled preview');
    assert.equal(s.gui.document.activeElement,s.button,'cancellation restores focus to the source action');
    assert.equal(s.root.querySelector('#hayakuSourceReanalysisConfirmOverlay'),null);
    assert.equal(s.f.calls(),0);
    assert.equal(s.f.store.values.get(s.ledgerKey),s.ledgerBefore,'cancel retains the exact canonical ledger');
    assert.deepEqual(s.gui.errors,[]);
  }finally{await s.dispose();}
});

test('source reanalysis approval reads current text and updates GUI only after verified adoption',async()=>{
  const s=await start();
  try{
    const overlay=await s.open();
    assert.match(overlay.textContent,/Other Ax 1회/);
    assert.match(overlay.textContent,/전체 최대 1회/);
    s.f.edit(NEW);const source=s.f.chat.message[1].data;
    let release;const gate=new Promise(resolve=>release=resolve);
    s.f.respond(async()=>{await gate;return {type:'success',result:JSON.stringify(envelope(NEW))};});
    try{
      const confirm=overlay.querySelector('[data-reanalysis-confirm="apply"]');
      confirm.click();confirm.click();
      await waitFor(()=>s.f.calls()===1,'approved model call');
      assert.equal(s.f.store.values.get(s.ledgerKey),s.ledgerBefore,'old canon remains while model is pending');
      assert.equal(s.root.querySelector('#hayakuSourceReanalysisConfirmOverlay'),null);
    }finally{release();}
    await waitFor(()=>/기억을 갱신했습니다/.test(s.status.textContent),'verified GUI success');
    const active=(await s.f.records()).filter(row=>row.recordState==='active');
    assert.ok(active.some(row=>JSON.stringify(row).includes(NEW)));
    assert.equal(s.f.chat.message[1].data,source);
    assert.equal(s.f.calls(),1,'repeated approval cannot submit a second ticket');
    assert.deepEqual(s.gui.errors,[]);
  }finally{await s.dispose();}
});

test('approved two-turn source reanalysis publishes one complete replacement',async()=>{
  const s=await start({turns:2});
  let release=()=>{};
  try{
    const overlay=await s.open();s.f.edit(NEW);
    const gate=new Promise(resolve=>release=resolve);
    s.f.respond(async(_call,index)=>{if(index===2)await gate;return {type:'success',result:JSON.stringify(envelope(index===1?NEW:SECOND))};});
    overlay.querySelector('[data-reanalysis-confirm="apply"]').click();
    await waitFor(()=>s.f.calls()===2,'second selected turn model call');
    assert.equal(s.f.store.values.get(s.ledgerKey),s.ledgerBefore,'the first selected turn is not published alone');
    release();
    await waitFor(()=>/기억을 갱신했습니다/.test(s.status.textContent),'atomic GUI success');
    const active=(await s.f.records()).filter(row=>row.recordState==='active');
    assert.ok(active.some(row=>row.targetPairIndex===1&&JSON.stringify(row).includes(NEW)));
    assert.ok(active.some(row=>row.targetPairIndex===2&&JSON.stringify(row).includes(SECOND)));
    assert.equal(s.f.calls(),2);
  }finally{release();await s.dispose();}
});

for(const timing of ['before_preview','after_preview'])test('source reanalysis rejects changed message identity '+timing,async()=>{
  const s=await start();
  try{
    let overlay;if(timing==='after_preview')overlay=await s.open();
    s.f.chat.message[1].id=s.f.chat.message[1].chatId='another-message';
    if(timing==='before_preview'){
      s.button.click();await waitFor(()=>!s.button.disabled&&/새로고침/.test(s.status.textContent),'stale listed identity blocked');
    }else{
      overlay.querySelector('[data-reanalysis-confirm="apply"]').click();
      await waitFor(()=>!s.button.disabled&&/재분석 중단/.test(s.status.textContent),'stale preview identity blocked');
    }
    assert.equal(s.f.calls(),0);
    assert.equal(s.f.store.values.get(s.ledgerKey),s.ledgerBefore);
    assert.equal(s.root.querySelector('#hayakuSourceReanalysisConfirmOverlay'),null);
  }finally{await s.dispose();}
});

for(const action of ['subtab','sidebar','close','unload'])test('source reanalysis preview is dismissed on '+action,async()=>{
  const s=await start();
  try{
    const overlay=await s.open(),confirm=overlay.querySelector('[data-reanalysis-confirm="apply"]');
    if(action==='subtab')await s.root.querySelector('[data-recovery-view="missing"]').fire('click');
    if(action==='sidebar')await s.root.querySelector('[data-hayaku-viewer-goto="packets"]').fire('click');
    if(action==='close')await s.f.api.closeUi();
    if(action==='unload')await s.f.dispose();
    assert.equal(s.root.querySelector('#hayakuSourceReanalysisConfirmOverlay'),null);
    confirm.click();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(s.f.calls(),0);
    assert.equal(s.f.store.values.get(s.ledgerKey),s.ledgerBefore);
    if(action==='subtab'||action==='sidebar'){
      if(action==='sidebar')await s.root.querySelector('[data-hayaku-viewer-goto="recovery"]').fire('click');
      await s.root.querySelector('[data-recovery-view="reanalysis"]').fire('click');
      await waitFor(()=>!s.button.disabled,'return to a cancelled preview');
      assert.match(s.status.textContent,/취소/);
      const fresh=await s.open();assert.notEqual(fresh,overlay);
      await fresh.querySelector('[data-reanalysis-confirm="cancel"]').fire('click');
    }
  }finally{await s.dispose();}
});

for(const turns of [1,2])test('preview pins the disclosed extra-call allowance for '+turns+' selected turns',async()=>{
  const s=await start({turns,observeBudget:true});
  try{
    const overlay=await s.open();assert.match(overlay.textContent,new RegExp(`전체 최대 ${turns}회`));
    await s.f.r.host.setArgument('hayaku_recovery_extra_calls','1');
    await s.f.api.settingsControl.current();
    const plans=[];
    s.f.respond(async(_call,index)=>{plans.push(s.f.r.context.__readReanalysisPlan());return {type:'success',finish_reason:'stop',result:turns===2&&index===1?JSON.stringify(envelope(OLD)):'not JSON'};});
    overlay.querySelector('[data-reanalysis-confirm="apply"]').click();
    await waitFor(()=>!s.button.disabled&&/재분석 중단/.test(s.status.textContent),'invalid output rejected within preview budget');
    assert.equal(s.f.calls(),turns,'settings changed after preview cannot increase the confirmed physical calls');
    assert.ok(plans.every(plan=>plan.extraCalls===0&&plan.maxPhysicalCalls===1),'every actual invocation uses the previewed allowance');
    assert.equal(s.f.store.values.get(s.ledgerKey),s.ledgerBefore,'no selected canon changes when a turn fails');
  }finally{await s.dispose();}
});

test('previewed extra allowance is an upper bound and valid output uses one call',async()=>{
  const s=await start({extraCalls:1,observeBudget:true});
  try{
    const overlay=await s.open();assert.match(overlay.textContent,/전체 최대 2회/);
    let plan;
    s.f.respond(async()=>{plan=s.f.r.context.__readReanalysisPlan();return {type:'success',finish_reason:'stop',result:JSON.stringify(envelope(OLD))};});
    overlay.querySelector('[data-reanalysis-confirm="apply"]').click();
    await waitFor(()=>/기억을 갱신했습니다/.test(s.status.textContent),'approved generation succeeds');
    assert.equal(s.f.calls(),1);
    assert.equal(plan.extraCalls,1);assert.equal(plan.maxPhysicalCalls,2);
  }finally{await s.dispose();}
});
