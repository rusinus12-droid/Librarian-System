'use strict';
// 2026-10-31 live: the server answered only after Flashback started; reading the
// settings at startup hit "Librarian System bootstrap timed out after 1800ms" and
// initialization aborted for the whole session — no request hooks, no capture
// backend, so no recall and no T7 capture.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');

const startupLoad='Runtime.settings = await loadSettings(true);';
const pluginSource=()=>{
  const source=fs.readFileSync(process.env.FB_SRC||require.resolve('../plugins/Flashback_Memory.js'),'utf8');
  assert.ok(source.includes(startupLoad),'startup settings load is present');
  // Exactly the first startup attempt fails the way the live bootstrap did.
  return source.replace(startupLoad,"if((globalThis.__fbStartupFailures=(globalThis.__fbStartupFailures??1)-1)>=0)throw new Error('Librarian System bootstrap timed out after 1800ms');"+startupLoad);
};

test('flashback retries a startup that failed because the server was not reachable yet',{timeout:60000},async()=>{
  const f=await createFixture({source:pluginSource(),
    chat:{message:[{role:'user',chatId:'u1',data:'Where is the key?'},{role:'assistant',chatId:'a1',data:'The key is under the clock.'}]}});
  try{
    const deadline=Date.now()+20000;let state=null;
    while(Date.now()<deadline&&state?.startupCompleted!==true){await new Promise(r=>setTimeout(r,250));state=await f.api.debugState().catch(()=>null);}
    assert.equal(state?.startupCompleted,true,'startup completes on retry');
    assert.ok(state.startupRetry?.attempt>=1&&state.startupRetry.recoveredAt>0,'the failed first start was retried, not abandoned');
    assert.equal(state.registered?.requestHooks?.beforeRequest,true,'recall hook registered');
    assert.ok((state.activityLog||[]).some(entry=>entry.event==='startup_recovered'));
  }finally{await f.dispose();}
});
