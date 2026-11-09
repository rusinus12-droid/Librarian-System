'use strict';
// 읽기 경로가 플러그인 IPC 하나로 줄었지만, "기억을 읽어도 된다"는 사용자 동의 계약은 그대로다.
// 서버 전송 테스트에만 있던 동의 계약(설정 가져오기가 동의를 가져오지 않음 / 동의 저장 중 채팅이
// 바뀌면 이전 연결이 노출되지 않음 / 언로드가 진행 중인 동의 쓰기를 기다림)과 owner 부분집합
// 계약을 IPC 경로로 옮겨 검증한다. 픽스처는 ipc_connection_fixture.cjs.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ipcHost,PREF,wait}=require('./ipc_connection_fixture.cjs');

test('IPC connect records explicit consent without touching the server transport',async t=>{
  const f=await ipcHost(t);
  const status=await f.connect();
  assert.equal(status.connection.state,'connected',JSON.stringify(status.connection));
  assert.equal(status.connection.readSource,'plugin_ipc');
  assert.deepEqual(f.requests,[],'the server transport is never used');
  const saved=JSON.parse(f.local.get(PREF));
  assert.equal(saved.explicit,true);
  assert.equal(saved.readSource,'plugin_ipc');
  assert.equal(status.status,'bound');
});

test('saved explicit IPC consent reconnects at startup without a new consent write',async t=>{
  const f=await ipcHost(t,{saved:{schema:'gradia.lib-read-connection.v2',url:'',explicit:true,readSource:'plugin_ipc',readOwners:['libra','hayaku','flashback']}});
  await wait(()=>f.status().connection?.state==='connected');
  assert.deepEqual(f.locals,[],'startup reuses consent instead of rewriting it');
  assert.equal(f.status().connection.readSource,'plugin_ipc');
});

test('settings import never imports or retains connection consent',async t=>{
  const f=await ipcHost(t);
  await f.connect();
  await f.host.plugin.debugNavigateGui('transfer','flow');
  const box=f.doc.querySelector('#mockup-import-text');assert.ok(box);
  box.value=JSON.stringify({runtime:{mode:'off',libReadConnection:{url:'',explicit:true}},
    providerPresets:{offline:{provider:'openai',model:'test-offline',url:'https://api.openai.com/v1/chat/completions'}}});
  box.dispatchEvent(new f.doc.defaultView.Event('input',{bubbles:true}));
  f.doc.querySelector('[data-manage-action="import-replace"]').click();
  const confirm=await wait(()=>f.doc.querySelector('.overlay.is-open .dialog button.btn--primary'));
  confirm.click();
  await wait(()=>f.local.get(PREF)&&JSON.parse(f.local.get(PREF)).explicit===false);
  assert.notEqual(f.status().status,'bound');
});

test('chat change during consent persistence never publishes the old binding',async t=>{
  const f=await ipcHost(t,{delayPreference:true});
  f.click('connect');
  await wait(f.preferenceWaiting);
  f.setChat('other');
  f.releasePreference();
  await wait(()=>f.status().connection.state!=='connecting');
  assert.notEqual(f.status().status,'bound');
  await wait(()=>JSON.parse(f.local.get(PREF)).explicit===false);
});

test('unload waits for the in-flight consent write and revokes it',async t=>{
  const f=await ipcHost(t,{delayPreference:true});
  f.click('connect');
  await wait(f.preferenceWaiting);
  let finished=false;
  const pending=f.unload().then(()=>{finished=true;});
  await new Promise(r=>setTimeout(r,25));
  assert.equal(finished,false,'unload must wait for the consent write');
  f.releasePreference();
  await pending;
  assert.equal(JSON.parse(f.local.get(PREF)).explicit,false);
});

test('saved consent reuses exactly the granted owner subset over IPC',async t=>{
  const f=await ipcHost(t,{saved:{schema:'gradia.lib-read-connection.v2',url:'',explicit:true,readSource:'plugin_ipc',readOwners:['libra','hayaku']}});
  await wait(()=>f.status().connection?.state==='connected');
  const owners=new Set(f.asked);
  assert.ok(owners.has('libra')&&owners.has('hayaku'),'granted owners are read');
  assert.ok(!owners.has('flashback'),'a newly available owner is never read without a grant');
  assert.deepEqual(Array.from(f.status().connection.readOwners),['libra','hayaku']);
});

test('malformed or unknown saved reader grants never establish a connection',async t=>{
  for(const readOwners of [[],['unknown-owner'],['hayaku','hayaku'],'hayaku']){
    const f=await ipcHost(t,{saved:{schema:'gradia.lib-read-connection.v2',url:'',explicit:true,readSource:'plugin_ipc',readOwners}});
    await new Promise(r=>setTimeout(r,200));
    assert.notEqual(f.status().connection.state,'connected',JSON.stringify(readOwners));
  }
});
