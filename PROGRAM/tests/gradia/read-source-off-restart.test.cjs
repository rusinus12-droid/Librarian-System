'use strict';
// 기억 읽기를 '끄기'로 저장한 사용자는 재시작 뒤에도 꺼진 상태여야 한다.
// 읽기 경로를 plugin_ipc 하나로 합친 뒤 start()가 저장값과 무관하게 plugin_ipc 로 덮어써서,
// 꺼 둔 기억 읽기가 다시 켜진 것처럼 보이고 응답 경로가 읽기를 시도하던 회귀를 막는다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const PREF='serial_gradation_agents_for_rp:lib_read_connection:v1';

async function restartWith(saved){
  const local=new Map([[PREF,JSON.stringify({url:'http://127.0.0.1:8787',...saved})]]);
  const localStorage={getItem:async k=>local.get(k)??null,setItem:async(k,v)=>{local.set(k,v);},removeItem:async k=>{local.delete(k);}};
  const h=await load({api:{getLocalPluginStorage:async()=>localStorage}});
  const start=Date.now();
  let status=h.plugin.getLibReadOnlyStatus().connection;
  while(Date.now()-start<3000&&status?.reason!=='LIB_READ_DISABLED'&&status?.state==='disconnected'&&!status.reason){
    await new Promise(r=>setTimeout(r,10));status=h.plugin.getLibReadOnlyStatus().connection;
  }
  await new Promise(r=>setTimeout(r,50));
  return h.plugin.getLibReadOnlyStatus().connection;
}

test('a saved "off" read source survives a restart',async()=>{
  const status=await restartWith({schema:'gradia.lib-read-connection.v2',explicit:false,readOwners:['libra'],readSource:'off'});
  assert.equal(status.readSource,'off');
  assert.equal(status.reason,'LIB_READ_DISABLED');
  assert.equal(status.state,'disconnected');
});

test('legacy server read sources still migrate to plugin_ipc on restart',async()=>{
  for(const readSource of ['unified_engine','server_logical_read']){
    const status=await restartWith({schema:'gradia.lib-read-connection.v2',explicit:false,readOwners:['libra'],readSource});
    assert.equal(status.readSource,'plugin_ipc',readSource);
  }
});
