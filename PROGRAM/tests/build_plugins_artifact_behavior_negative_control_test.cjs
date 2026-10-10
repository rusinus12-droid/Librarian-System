'use strict';
// A disposable corrupted artifact must fail the unchanged behavioral contract.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const candidate=process.env.ULTRALIGHT_ARTIFACT_DIR;
assert.ok(candidate&&process.env.RELEASE_PARITY_CONTROL_DIR,'exact candidate/control artifacts are required');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-artifact-negative-'));
try {
  for(const file of ['HAYAKU_Locator_Continuity.js','Flashback_Memory.js','LIBRA.js','LIA_Persona_Linker.js','RETRACE.js'])fs.copyFileSync(path.join(candidate,file),path.join(dir,file));
  const file=path.join(dir,'HAYAKU_Locator_Continuity.js'),original=fs.readFileSync(file,'utf8');
  const marker='[HAYAKU RUNTIME PACKET SHAPE]';
  assert.ok(original.includes(marker),'positive artifact contains the exact runtime contract marker');
  const altered=original.split(marker).join('[CORRUPTED RUNTIME PACKET SHAPE]');
  assert.notEqual(altered,original);fs.writeFileSync(file,altered);
  const result=spawnSync(process.execPath,[path.join(__dirname,'build_plugins_artifact_behavior_parity_test.cjs')],{encoding:'utf8',timeout:60000,windowsHide:true,env:{...process.env,ULTRALIGHT_ARTIFACT_DIR:dir}});
  assert.equal(result.error,undefined);assert.notEqual(result.status,0,'changed actual hook contract must fail');
  assert.match(result.stderr,/HAYAKU registered hook injects its runtime packet contract/,'failure must come from the meaningful hook assertion');
  console.log(JSON.stringify({test:'build_plugins_artifact_behavior_negative_control',passed:1,childExit:result.status,detected:'changed HAYAKU registered-hook runtime marker'}));
} finally {
  const resolved=fs.realpathSync(dir),temp=path.resolve(os.tmpdir())+path.sep;
  assert.ok(resolved.toLowerCase().startsWith(temp.toLowerCase())&&path.basename(resolved).startsWith('release-artifact-negative-'),'recursive cleanup remains in the exact owned Temp directory');
  fs.rmSync(resolved,{recursive:true,force:true});
}
