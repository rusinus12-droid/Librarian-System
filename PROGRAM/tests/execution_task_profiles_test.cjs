'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const result = spawnSync(process.execPath, [path.join(root, 'tools/sync_execution_contract.cjs'), '--check'], { encoding: 'utf8' });
assert.equal(result.status, 0, 'Every designated profile must pass exact sync checks: ' + result.stderr);
console.log('PASS designated execution profiles match');
const os = require('node:os');
const sync = require('../tools/sync_execution_contract.cjs');
const manifest = require('../sdk/MemorySuiteExecutionProfiles.json');
const source = fs.readFileSync(path.join(root, 'sdk/MemorySuiteExecutionContract.source.js'), 'utf8').trim();
const standard = {
  canonical_memory:[32768,65536],reaction_brief:[12000,32768],
  sga_private_analysis:[8192,16384],sga_full_draft:[16384,32768],sga_patch:[8192,16384],
  sga_final_rewrite:[16384,32768],sga_length_rewrite:[16384,32768],
  input_candidates:[8192,16384],input_translation:[8192,16384],
  prompt_studio_dialogue:[4096,8192],prompt_studio_compile:[4096,8192],connection_probe:[2048,8192],
  hayaku_packet_recovery:[16384,32768],hayaku_cold_start:[16384,32768],hayaku_failed_analysis_resolution:[16384,32768]
};
const retired = ['sga_private_analysis','sga_full_draft','sga_patch','sga_final_rewrite','sga_length_rewrite'];
// LIBRA adds Micro memory and memory lens analysis; the other products must reject both.
const libra = {...standard,micro_memory:[2048,4096],lens_analysis:[4096,8192]}; retired.forEach(k=>delete libra[k]);
const plain = x=>JSON.parse(JSON.stringify(x));
const load = text=>vm.runInNewContext(text+';MemorySuiteExecutionContract',{URL,URLSearchParams,TextEncoder,TextDecoder,setTimeout,clearTimeout},{timeout:1000});
const expected = file=>file==='LIBRA.js'?libra:standard;
function verify(C, defaults) {
  assert.deepEqual(plain(C.TASK_DEFAULTS),defaults);
  for(const [taskKind,[visible,total]] of Object.entries(defaults)) {
    for(const provider of ['custom','otherax']) {
      const route=C.routeCapability(provider,'model','https://example.invalid/v1','openai');
      const p=C.invocationPlan({taskKind,route});
      assert.equal(p.requested.visibleHeadroom,visible); assert.equal(p.requested.total,total); assert.equal(p.requested.hardCap,total);
      assert.equal(p.effective.outputCap,provider==='otherax'?null:total);
      assert.equal(p.maxPhysicalCalls,1);
      const bounded=C.invocationPlan({taskKind,route,hardCap:1000,requestedTotal:900,modelMax:800,contextRemaining:700,aggregateRemaining:600,extraCalls:1});
      assert.equal(bounded.effective.outputCap,provider==='otherax'?null:600);assert.equal(bounded.maxPhysicalCalls,2);
    }
  }
  for(const taskKind of ['', 'unknown_task', '__proto__', ...(defaults.micro_memory?retired:['micro_memory','lens_analysis'])])
    assert.throws(()=>C.invocationPlan({taskKind,route:{}}),e=>e.code==='UNKNOWN_TASK_KIND'&&e.message===`Unregistered generation task: ${taskKind||'(missing)'}.`);
}
verify(load(source),standard);
for(const file of Object.keys(manifest.products)) {
  const original=fs.readFileSync(path.join(root,'plugins',file),'utf8');
  const block=sync.extractContract(original,file);
  assert.equal(block,sync.renderContract(source,manifest,manifest.products[file]));
  verify(load(block),expected(file));
  assert.equal(sync.withoutTaskDefaults(block),sync.withoutTaskDefaults(source),'Only the task policy bytes may differ');
}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'execution-profiles-'));
try {
  fs.mkdirSync(path.join(temp,'sdk'));fs.mkdirSync(path.join(temp,'plugins'));
  fs.writeFileSync(path.join(temp,'sdk/MemorySuiteExecutionContract.source.js'),source);
  const saveManifest=m=>fs.writeFileSync(path.join(temp,'sdk/MemorySuiteExecutionProfiles.json'),JSON.stringify(m));
  saveManifest(manifest);
  for(const file of Object.keys(manifest.products))fs.writeFileSync(path.join(temp,'plugins',file),'prefix\n'+source+'\nsuffix');
  sync.synchronize({root:temp});
  const snapshot=()=>Object.fromEntries(Object.keys(manifest.products).map(f=>[f,fs.readFileSync(path.join(temp,'plugins',f),'utf8')]));
  const first=snapshot();sync.synchronize({root:temp});assert.deepEqual(snapshot(),first);sync.synchronize({root:temp,check:true});
  verify(load(sync.extractContract(first['LIBRA.js'],'LIBRA.js')),libra);
  const failWithoutWrites=()=>{const before=snapshot();assert.throws(()=>sync.synchronize({root:temp}));assert.deepEqual(snapshot(),before);};
  // Force an earlier target to need a write; a later invalid target must leave it untouched.
  fs.writeFileSync(path.join(temp,'plugins','LIBRA.js'),'prefix\n'+source+'\nsuffix');
  assert.throws(()=>sync.synchronize({root:temp,check:true}));
  for(const bad of ['',source+'\n'+source,
    source.replace(/  const TASK_DEFAULTS = Object\.freeze\(\{[\s\S]*?\n  \}\);/, ''),
    source.replace('  const TASK_DEFAULTS =', '  const TASK_DEFAULTS=Object.freeze({});\n  const TASK_DEFAULTS ='),
    source.replace('v1.1.0 — END','v9.9.9 — END')]) {
    fs.writeFileSync(path.join(temp,'plugins','HAYAKU_Locator_Continuity.js'),bad);failWithoutWrites();
    fs.writeFileSync(path.join(temp,'plugins','HAYAKU_Locator_Continuity.js'),first['HAYAKU_Locator_Continuity.js']);
  }
  for(const change of [m=>m.products['LIBRA.js']='typo',m=>m.products['../outside.js']='libra',m=>delete m.products['LIBRA.js'],
    m=>m.profiles.libra.add.micro_memory=[0,4096],m=>m.profiles.libra.add.micro_memory=[4096,2048],
    m=>m.profiles.libra.add.canonical_memory=[1,2],m=>m.profiles.libra.remove.push('missing'),
    m=>m.profiles.libra.remove.push('sga_patch'),m=>m.profiles.libra.extra=true,m=>m.version=2]) {
    const bad=plain(manifest);change(bad);saveManifest(bad);failWithoutWrites();
  }
  saveManifest(manifest);
  for(const bad of [source+'\n'+source,
    source.replace('canonical_memory: [32768, 65536]','canonical_memory: [, 65536]'),
    source.replace('  const TASK_DEFAULTS =', '  const TASK_DEFAULTS=Object.freeze({});\n  const TASK_DEFAULTS ='),
    source.replace("  const VERSION = '1.1.0';", "  const VERSION = ;")]) {
    fs.writeFileSync(path.join(temp,'sdk/MemorySuiteExecutionContract.source.js'),bad);failWithoutWrites();
  }

} finally {fs.rmSync(temp,{recursive:true,force:true});}
console.log('PASS frozen task budgets, unknown/retired tasks, shared bytes, repeat sync and pre-write validation');
module.exports={verify,expected};
