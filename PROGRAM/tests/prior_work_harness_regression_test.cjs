'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-suite-harness-'));
// Each harness is a real plugin run: measured standalone cost is gui_verify 0.4s,
// llm_fail_gate_unit_test 0.1s, flashback_e2e_harness 5.3s, hayaku_convo_harness 3.3s,
// libra_convo_harness 6.9s, risu_plugin_harness 2.7s. The deadline was 20s, only ~3x the
// heaviest harness, so under a loaded host spawnSync killed it and the status check below read
// the kill as a failure (measured: 'actual: 1, expected: 0' twice in a row under load, while the
// same test passes standalone). The deadline is now generous - it exists to stop a hang, not to
// time the work - and a timeout is reported as its own failure instead of being smuggled in as
// the exit status the assertions below are looking for.
const HARNESS_TIMEOUT_MS=90000;
function run(tool,plugin,fail=false,extraEnv={}){
 const r=spawnSync(process.execPath,[path.join(root,'tools',tool),...(plugin?[plugin]:[])],{encoding:'utf8',timeout:HARNESS_TIMEOUT_MS,maxBuffer:4*1024*1024,env:{...process.env,MEMORY_SUITE_TEST_OUTPUT:tmp,LIBRA_FAIL_MODE:fail?'1':'0',...extraEnv}});
 assert.ifError(r.error);
 assert.notEqual(r.signal,'SIGTERM',`${tool} was killed after ${HARNESS_TIMEOUT_MS}ms - a hang, not a result`);
 return r;
}
try {
 for(const tool of ['gui_verify.js','llm_fail_gate_unit_test.js']){const r=run(tool);assert.equal(r.status,0,r.stdout+r.stderr);}
 for(const [tool,plugin]of [['flashback_e2e_harness.js','Flashback_Memory.js'],['hayaku_convo_harness.js','HAYAKU_Locator_Continuity.js'],['libra_convo_harness.js','LIBRA.js']]){
  const r=run(tool,path.join(root,'plugins',plugin));assert.equal(r.status,0,r.stdout+r.stderr);
 }
 // Retain the old hash-only fixture as an actual negative: current retrieval
 // cannot advertise model recall when its embedding model is unconfigured.
 const legacy=run('flashback_e2e_harness.js',path.join(root,'plugins/Flashback_Memory.js'),false,{FLASHBACK_HARNESS_LEGACY_HASH:'1'});assert.equal(legacy.status,1,'legacy hash-only fixture must fail its unchanged positive recall assertion');assert.match(legacy.stdout,/"name": "recall_injection_silverkey",\s+"ok": false/);
 const fail=run('libra_convo_harness.js',path.join(root,'plugins/LIBRA.js'),true);assert.equal(fail.status,0,fail.stdout+fail.stderr);
 const crash=path.join(tmp,'crash.js');fs.writeFileSync(crash,"throw new Error('EXPECTED_HARNESS_CRASH');");
 for(const tool of ['risu_plugin_harness.js','flashback_e2e_harness.js','hayaku_convo_harness.js','libra_convo_harness.js']){const r=run(tool,crash);assert.equal(r.status,1,tool+' must reject a crashed plugin');assert.match(r.stdout,/EXPECTED_HARNESS_CRASH/);}
 // Returned failure is also mandatory for bad semantic/durable results.
 const {validate}=require('../tools/harness_assertions.cjs');
 const originalError=console.error;
 try { console.error=()=>{}; assert.equal(validate('flashback_e2e_harness.js',{steps:Array.from({length:5},()=>({ok:false,name:'missing recall'}))}),false); }
 finally { console.error=originalError; }
 console.log('Prior work harness regression PASS (normal, LLM failure, crash and semantic failure)');
} finally { assert.ok(path.resolve(tmp).startsWith(path.join(path.resolve(os.tmpdir()),'memory-suite-harness-'))); fs.rmSync(tmp,{recursive:true,force:true}); }
