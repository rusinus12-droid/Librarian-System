'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {seedSnapshot,finalProofFixture,REQUEST}=require('./fixtures/libra_associative_final_proof_fixture.cjs');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const instrument=source=>source.replace('async saveLibraMemorySettings(value = {}) {',"async saveLibraMemorySettings(value = {}) { globalThis.__fixtureSettingsSaves=(globalThis.__fixtureSettingsSaves||0)+1;");
const plain=x=>JSON.parse(JSON.stringify(x));
const desired={performancePreset:'custom',candidateLimit:8,recallMaxMemories:12,recallMaxChars:12000,recallQueryMessages:1,forceCurrentScene:true,memoryEngine:'librarian',compatibilityMemoryEngine:'unified'};
(async()=>{
 const snapshot=await seedSnapshot(),f=await finalProofFixture(snapshot,false,{transformSource:instrument});
 try{
  const actual=plain(await f.r.api.getLibraMemorySettings());
  for(const [key,value]of Object.entries(desired))assert.deepEqual(actual[key],value,`effective normalized ${key}`);
  const packet=await f.control.hooks.beforeRequest([{role:'user',content:REQUEST}],'model');
  assert.ok(f.r.api.getLastMemoryRecallViewer().injectedMemories>0,'actual registered hook must still emit physically checked sources');
  assert.equal(Object.keys(f.getManifest().memories).length,10,'whole seeded corpus remains durable');
  assert.equal(f.counts.document,0);
  console.log(JSON.stringify({packetSHA256:crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex'),corpus:10,saves:f.r.context.__fixtureSettingsSaves||0}));
  assert.equal(f.r.context.__fixtureSettingsSaves||0,0,'already configured fixture must not save unchanged settings and hydrate the entire corpus');
 }finally{await f.r.cleanup();}
 const changedEngine=await fixture({snapshot,mode:'classic',transformSource:instrument});
 try{assert.equal((await changedEngine.r.api.getLibraMemorySettings()).memoryEngine,'librarian');assert.equal((await changedEngine.r.api.getLibraMemorySettings()).configurationStatus,'review_required');assert.equal(changedEngine.r.context.__fixtureSettingsSaves,1,'unsupported engine must retain original configuration validation');}finally{await changedEngine.r.cleanup();}
 if(!process.argv.includes('--policy-only')){
 const reviewSnapshot=plain(snapshot);
 const reviewRow=reviewSnapshot.values.find(([,raw])=>{try{return JSON.parse(raw)?.memoryEngine==='librarian';}catch{return false;}});
 assert.ok(reviewRow);const reviewSettings=JSON.parse(reviewRow[1]);reviewSettings.configurationStatus='review_required';reviewRow[1]=JSON.stringify(reviewSettings);
 const needsReview=await fixture({snapshot:reviewSnapshot,mode:'librarian',transformSource:instrument});
 try{assert.equal((await needsReview.r.api.getLibraMemorySettings()).configurationStatus,'review_required');assert.equal(needsReview.r.context.__fixtureSettingsSaves,1,'direct canonical match must preserve save/validation for review_required configuration');}finally{await needsReview.r.cleanup();}
 }
 // A stale getter/schema tuple must likewise reach the real setter validator.
 // The stored settings stay valid; only the test getter returns the old policy.
 const policyUnload=[];let unexpectedlyAccepted;
 try{
  await assert.rejects(async()=>{unexpectedlyAccepted=await fixture({snapshot,mode:'librarian',host:{onUnload:async handler=>{policyUnload.push(handler);return true;}},transformSource:source=>instrument(source).replace('async getLibraMemorySettings() { return await LibraMemoryCore.loadSettings(); }', 'async getLibraMemorySettings() { return {...await LibraMemoryCore.loadSettings(),librarianPolicyVersion:0}; }')});},/LIBRARIAN_CONFIG_VERSION_UNSUPPORTED/);
 }finally{if(unexpectedlyAccepted)await unexpectedlyAccepted.r.cleanup();for(const handler of policyUnload.reverse())await handler();}
 const changedSnapshot=plain(snapshot);
 const row=changedSnapshot.values.find(([,raw])=>{try{const v=JSON.parse(raw);return v?.memoryEngine==='librarian'&&v?.candidateLimit===8;}catch{return false;}});
 assert.ok(row);const settings=JSON.parse(row[1]);settings.recallMaxChars=11999;row[1]=JSON.stringify(settings);
 const changedRecall=await finalProofFixture(changedSnapshot,false,{transformSource:instrument});
 try{assert.equal((await changedRecall.r.api.getLibraMemorySettings()).recallMaxChars,12000);assert.equal(changedRecall.r.context.__fixtureSettingsSaves,1,'required recall change still uses original save/refresh');}finally{await changedRecall.r.cleanup();}
 console.log('libra_cost_fixture_settings_reuse_test: PASS (no-op skip + required changes + full corpus + actual hook)');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
