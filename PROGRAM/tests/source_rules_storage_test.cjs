'use strict';
// Run the established durability/rollback contracts with explicit rules enabled.
const cp=require('child_process'),assert=require('assert/strict');
const mode=process.argv[2];
const rules={ignoredTags:['@html-comment'],unwrapTags:['wrapper'],sourceTags:['original']};
if(mode==='local'){
 const mod=require('./fixtures/libra_unified_runtime_fixture.cjs'),create=mod.fixture;
 mod.fixture=async(...args)=>{const f=await create(...args);await f.r.api.setSourceEditRules(rules);return f;};
 require('./libra_unified_source_edit_v2_test.cjs');
}else if(mode==='server'){
 const mod=require('./fixtures/libra_server_runtime_fixture.cjs'),create=mod.serverFixture;
 mod.serverFixture=async(...args)=>{const s=await create(...args);await s.f.r.api.setSourceEditRules(rules);return s;};
 require('./libra_unified_server_writer_v1_test.cjs');
}else if(mode==='flashback'){
 const mod=require('./fixtures/flashback_native_runtime_fixture.cjs'),create=mod.createFixture;
 mod.createFixture=async(...args)=>{const f=await create(...args);await f.api.setSourceEditRules(rules);return f;};
 require('./flashback_commit_durability_v135_test.cjs');
}else if(mode==='hayaku'){
 const mod=require('./fixtures/hayaku_runtime_harness.cjs'),create=mod.createHayakuRuntime;
 mod.createHayakuRuntime=async(...args)=>{const h=await create(...args);await h.hayaku.setSourceEditRules(rules);return h;};
 require('./source_edit_hayaku_runtime_test.cjs');
}else{
 const cases=[['local',''],['server','explicit selected source replacement'],['server','post-canonical SQLite'],['server','mirror unified path'],['flashback',''],['hayaku','']];
 // Isolated children own their stores/ports and can run concurrently. This keeps
 // the original six durability paths inside the unchanged official root limit.
 Promise.all(cases.map(([child,filter])=>new Promise((resolve,reject)=>{
  const proc=cp.spawn(process.execPath,[__filename,child],{env:{...process.env,LIBRA_SERVER_TEST_FILTER:filter},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  proc.stdout.on('data',chunk=>stdout+=chunk);proc.stderr.on('data',chunk=>stderr+=chunk);proc.on('error',reject);
  proc.on('close',status=>{process.stdout.write(stdout);process.stderr.write(stderr);try{assert.equal(status,0,child+' '+filter);if(child==='server')assert.match(stdout,/\"passed\":1/,filter+' must execute its selected case');resolve()}catch(error){reject(error)}});
 }))).then(()=>console.log('PASS explicit input rules: six isolated durability paths')).catch(error=>{console.error(error);process.exitCode=1});
}
