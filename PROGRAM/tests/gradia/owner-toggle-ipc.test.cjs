'use strict';
// 오너 토글·켜기/끄기·연결 해제를 플러그인 IPC 경로로 검증한다. 서버 읽기 시절 route_memory_owner_toggle
// 테스트가 HTTP bootstrap 픽스처에 묶여 있던 계약을 그대로 옮긴 것이고, 원본은 이관 표시와 함께
// 건너뛴 상태로 남아 있다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ipcHost,PREF,wait}=require('./ipc_connection_fixture.cjs');

test('toggling a draft owner changes the connected route and persists that set',async t=>{
  const f=await ipcHost(t);
  assert.equal(f.doc.querySelectorAll('[data-lib-draft-owner]').length,3,'three owner checkboxes render');
  f.toggleDraftOwner('hayaku',false);
  const status=await f.connect();
  assert.equal(status.connection.state,'connected',JSON.stringify(status.connection));
  assert.deepEqual(Array.from(status.connection.draftReadOwners),['libra','flashback']);
  const saved=f.savedPreference();
  assert.equal(saved.schema,'gradia.lib-read-connection.v2');
  assert.deepEqual(saved.draftReadOwners,['libra','flashback']);
  assert.ok(!new Set(f.asked).has('hayaku'),'the disabled owner is never queried');
});

test('turning memory read off disconnects and persists the off state',async t=>{
  const f=await ipcHost(t);
  await f.connect();
  assert.equal(f.status().connection.state,'connected');
  f.selectSource('off');
  f.click('connect');
  await wait(()=>f.status().connection.state==='disconnected'&&f.savedPreference()?.readSource==='off');
  assert.equal(f.savedPreference().explicit,false);
  assert.notEqual(f.status().status,'bound');
});

test('a saved off preference restores quietly without connecting or requesting',async t=>{
  const f=await ipcHost(t,{saved:{schema:'gradia.lib-read-connection.v2',url:'',explicit:false,readSource:'off',readOwners:['libra']}});
  await new Promise(r=>setTimeout(r,250));
  assert.equal(f.status().connection.state,'disconnected');
  assert.equal(f.status().connection.readSource,'off');
  assert.deepEqual(f.asked,[],'an off preference never queries an owner');
  assert.deepEqual(f.requests,[],'an off preference never uses the server transport');
});

test('the disconnect button disables memory read and persists the off state',async t=>{
  const f=await ipcHost(t);
  await f.connect();
  assert.equal(f.status().status,'bound');
  f.click('disconnect');
  await wait(()=>f.status().connection.state==='disconnected'&&f.savedPreference()?.readSource==='off');
  assert.equal(f.savedPreference().explicit,false);
  assert.notEqual(f.status().status,'bound');
});
