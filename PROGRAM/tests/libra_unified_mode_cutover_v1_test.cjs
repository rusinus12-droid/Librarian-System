'use strict';
const assert=require('node:assert/strict');const {fixture,artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');const results=[];
async function test(name,fn){const f=await fixture({args:{enable_character_ito:true,enable_world_ito:true,enable_plot_ito:true}});try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
(async()=>{
 const untouched=await createLibraVmHarness();try{assert.equal((await untouched.api.getLibraMemorySettings()).memoryEngine,'librarian');results.push('fresh execution policy is Librarian; old data remains separately gated');}finally{await untouched.cleanup();}
 await test('Librarian ignores old reviewer execution switches without deleting configuration',async f=>{
  const before=await f.r.api.getLibraProviderConfig();await f.run();const after=await f.r.api.getLibraProviderConfig();for(const k of ['enableCharacterAide','enableWorldAide','enablePlotAide'])assert.equal(after[k],before[k]);assert.equal(f.control.calls.length,1);
 });
 await test('legacy setting input cannot reopen old writer in a v4 scope',async f=>{
  f.control.onCall=async()=>{await f.r.api.saveLibraMemorySettings({memoryEngine:'legacy'});return {type:'success',result:JSON.stringify(f.control.artifact)};};
  const first=await f.run();assert.equal(first.completed,1);const original=f.getMemory();
  const extra=f.chat.message.slice(0,10).map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`}));f.chat.message.push(...extra);f.control.onCall=null;
  f.control.artifact=JSON.parse(JSON.stringify(artifact()).replace(/"ref":"t([1-5])-/g,(_,n)=>`"ref":"t${Number(n)+5}-`));
  const next=await f.run();assert.equal(next.completed,1,JSON.stringify(next));assert.equal(f.control.calls.length,2);assert.equal(f.getMemory(6).engineVersion,'libra.unified.v2');assert.equal(f.getMemory().artifactDigest,original.artifactDigest);assert.equal(f.getHead().throughTurn,10);
 });
 await test('verified v4 handoff preserves source and virtual same-scope fork stays blocked',async f=>{
  await f.run();const h=JSON.stringify(f.getHead()),m=f.getMemory();
  const transfer=await f.r.api.prepareSessionHandoff({transferId:'test-third-handoff'});
  assert.equal(transfer.ok!==false,true);assert.ok(transfer.archiveRef?.archiveId || transfer.archiveId,JSON.stringify(transfer));
  await assert.rejects(()=>f.r.api.setWorldManagerWorldline({worldlineId:'fork',parentId:'main',forkTurn:5}),/UNIFIED_USE_NATIVE_BRANCH_FOR_FORK/);
  assert.equal(JSON.stringify(f.getHead()),h);assert.deepEqual(f.getMemory(),m);assert.equal(f.control.calls.length,1);
 });
 console.log(JSON.stringify({test:'libra_unified_mode_cutover_v1',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1});
