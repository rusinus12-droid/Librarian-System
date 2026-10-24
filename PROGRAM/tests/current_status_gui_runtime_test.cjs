'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const factory = require('../tools/memory_suite_current_status.cjs');
const { create, until, pause } = require('./fixtures/libra_gui_memory_dom_host.cjs');

function setup() {
  const dom = new JSDOM('<main><div class="side-foot"></div></main>');
  let config = { mode:'plugin_only', url:'http://127.0.0.1:47630', scopeId:'A' }, identity='A', visible=true, probe=async()=>({ok:true}), job=null, saved='균형';
  let subscription, reads=0, probes=0; const destinations=[];
  const bridge = {
    getConnectionSettings:async()=>{ ++reads; return {...config}; },
    testConnection:url=>{ ++probes; return probe(url); }, getSyncJob:()=>job,
    subscribeSyncJob:fn=>{subscription=fn;return()=>{subscription=null;};}
  };
  const status = factory({bridge,getRoot:()=>dom.window.document.querySelector('main'),isVisible:()=>visible,
    getIdentity:()=>identity,getRows:()=>[{id:'analysis',text:'분석: '+saved,target:'settings'}],navigate:target=>destinations.push(target)});
  const row=()=>dom.window.document.querySelector('[data-current-status="storage"]');
  return {dom,status,row,destinations,bridge,setConfig:value=>{config=value;},setIdentity:v=>{identity=v;},setVisible:v=>{visible=v;},setSaved:v=>{saved=v;},setJob:v=>{job=v;},setProbe:v=>{probe=v;},emit:()=>subscription?.(),counts:()=>({reads,probes}),close(){visible=false;status.stop();dom.window.close();}};
}

test('applied status rows navigate without model calls; plugin mode needs no server', async()=>{
  const s=setup();try {
    s.status.sync();await until(()=>s.row()?.textContent==='저장: 플러그인 모드','local mode');
    assert.equal(s.counts().probes,0);
    s.row().click();s.dom.window.document.querySelector('[data-current-status="analysis"]').click();
    assert.deepEqual(s.destinations,['server','settings']);
    s.setSaved('빠르게');s.status.sync();assert.match(s.dom.window.document.body.textContent,/분석: 빠르게/);
  } finally{s.close();}
});

test('server failures, manual reconnect and transition/recovery are distinct',async()=>{
  const s=setup();try {
    s.setConfig({mode:'server_only',url:'http://server',scopeId:'A'});
    s.setProbe(async()=>({ok:false,error:'connection_refused'}));s.status.sync();
    await until(()=>s.row()?.textContent.includes('연결 미완료'),'unavailable');
    assert.equal(s.row().dataset.warning,'true');assert.match(s.row().title,/connection_refused/);
    s.setProbe(async()=>({ok:true}));s.dom.window.document.querySelector('[data-current-status-refresh]').click();
    await until(()=>s.row()?.textContent==='저장: 서버 모드 · 연결됨','reconnected');
    assert.equal(s.row().dataset.warning,'false');
    const probes=s.counts().probes;s.setJob({status:'paused',phase:'recovery_pending'});s.status.sync();
    await until(()=>s.row()?.textContent.includes('이전 완료 확인 필요'),'migration');assert.equal(s.counts().probes,probes);
    s.setJob(null);s.setConfig({mode:'server_only',recoveryRequired:true});s.status.sync();
    await until(()=>s.row()?.textContent.includes('초기화·복원'),'restored server');assert.equal(s.counts().probes,probes);
  }finally{s.close();}
});

test('late server reply cannot overwrite a different chat or plugin mode',async()=>{
  const s=setup();try {
    let resolve; s.setProbe(()=>new Promise(r=>{resolve=r;}));
    s.setConfig({mode:'server_only',url:'http://A',scopeId:'A'});s.status.sync();
    await until(()=>resolve,'old probe');
    s.setIdentity('B');s.setConfig({mode:'plugin_only',url:'http://B',scopeId:'B'});s.status.sync();
    await until(()=>s.row()?.textContent==='저장: 플러그인 모드','new chat');resolve({ok:false,error:'old failure'});
    await pause(20);assert.equal(s.row().textContent,'저장: 플러그인 모드');
  }finally{s.close();}
});

test('config changes during a probe are rechecked; settings failure is not an offline claim',async()=>{
  const s=setup();try {
    let resolve;s.setConfig({mode:'server_only',url:'http://A',scopeId:'A'});
    s.setProbe(()=>new Promise(r=>{resolve=r;}));s.status.sync();await until(()=>resolve,'probe');
    s.setConfig({mode:'plugin_only',url:'http://A',scopeId:'A'});resolve({ok:true});
    await until(()=>s.row()?.textContent==='저장: 플러그인 모드','changed mode');
    s.bridge.getConnectionSettings=async()=>{throw Error('selection_unavailable');};s.status.sync();
    await until(()=>s.row()?.textContent==='저장: 확인 필요','config failure');assert.match(s.row().title,/selection_unavailable/);
  }finally{s.close();}
});

test('rapid renders share a probe and closing invalidates replies and unsubscribes',async()=>{
  const s=setup();try {
    let resolve;s.setConfig({mode:'server_only',url:'http://A',scopeId:'A'});s.setProbe(()=>new Promise(r=>{resolve=r;}));
    s.status.sync();await until(()=>resolve,'probe');s.status.sync();await pause(5);assert.equal(s.counts().probes,1);
    s.setVisible(false);s.status.stop();const before=s.row().textContent;resolve({ok:false});await pause(20);
    assert.equal(s.row().textContent,before);const reads=s.counts().reads;s.emit();await pause(220);assert.equal(s.counts().reads,reads);
    s.setVisible(true);s.setConfig({mode:'plugin_only'});s.status.sync();await until(()=>s.row().textContent==='저장: 플러그인 모드','reopened');
  }finally{s.close();}
});

test('a superseded probe is not reported as an offline server',async()=>{
  const s=setup();try{
    s.setConfig({mode:'server_only',url:'http://A',scopeId:'A'});
    s.setProbe(async()=>({ok:false,error:'MEMORY_SUITE_CONNECTION_STALE'}));s.status.sync();
    await until(()=>s.row()?.textContent==='저장: 연결 확인 중','superseded probe');
    assert.equal(s.row().dataset.warning,'false');
  }finally{s.close();}
});

test('manual refresh really probes even after a recent successful settings-page check',async()=>{
  const s=setup();try{
    s.setConfig({mode:'server_only',url:'http://A',scopeId:'A',status:{state:'connected',url:'http://A',at:Date.now()}});
    s.status.sync();await until(()=>s.row()?.textContent.includes('연결됨'),'recent connection');assert.equal(s.counts().probes,0);
    s.setProbe(async()=>({ok:false,error:'connection_refused'}));
    s.dom.window.document.querySelector('[data-current-status-refresh]').click();
    await until(()=>s.row()?.textContent.includes('연결 미완료'),'fresh explicit read');assert.equal(s.counts().probes,1);
    const fold=s.dom.window.document.querySelector('.current-status-panel details');fold.open=false;
    assert.match(fold.querySelector('summary').textContent,/서버 연결 미완료/,'folded window retains the warning');
  }finally{s.close();}
});

for(const name of ['HAYAKU','Flashback']) test(name+' full GUI mounts status and opens real settings destinations',async()=>{
  const s=await create(name,process.env.CURRENT_STATUS_VARIANT || 'Full');try{
    await s.open();await until(()=>s.doc.querySelector('[data-current-status="storage"]')?.textContent==='저장: 플러그인 모드','owner status',12000);
    assert.equal(s.doc.querySelectorAll('.side-foot [data-current-status]').length,3);
    assert.equal(s.doc.querySelector('.current-status-panel').parentElement.classList.contains('app'),true,'status is docked inside the GUI app, outside the mobile-hidden sidebar');
    const networkBefore=s.wire.length;
    await s.click('[data-current-status="storage"]');
    if(name==='HAYAKU')assert.equal(s.doc.querySelector('[data-page="server"]').hidden,false);
    else assert.ok(s.doc.querySelector('[data-group="c"][data-subpanel="srv"]').classList.contains('is-active'));
    await s.click('[data-current-status="recall"]');
    assert.ok(s.doc.querySelector('[data-page="settings"]').classList.contains('is-active'));
    const saved=s.doc.querySelector('[data-current-status="recall"]').textContent;
    if(name==='HAYAKU') await s.change('[name="hayaku_mode"]','deep');
    else await s.click('[data-recall-quality-preset="heavy"]');
    await s.click('[data-current-status-refresh]');
    assert.equal(s.doc.querySelector('[data-current-status="recall"]').textContent,saved,'unsaved draft does not change applied status');
    await s.click(`[data-current-status="${name==='HAYAKU'?'analysis':'search'}"]`);
    if(name==='HAYAKU')assert.ok(s.doc.querySelector('[data-page="overview"]').classList.contains('is-active'));
    else assert.ok(s.doc.querySelector('[data-group="c"][data-subpanel="emb"]').classList.contains('is-active'));
    assert.equal(s.wire.length,networkBefore,'navigation and local status do not make server/model calls');
    assert.deepEqual(s.errors,[]);
  }finally{await s.close();}
});
