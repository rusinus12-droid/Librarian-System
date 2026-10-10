'use strict';
// Delay only the offline host's scheduled hydration; exact plugin bytes and gold remain intact.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {exercise,libraTerminalStatus}=require('./build_plugins_artifact_behavior_parity_test.cjs');
const dir=process.env.ULTRALIGHT_ARTIFACT_DIR;
assert.ok(dir,'exact actual artifact directory is required');
const row=['libra','LIBRA.js','__LIBRA__'];
(async()=>{
  let baselineReady,delayedReady,baselineState,delayedState;
  const baseline=await exercise(path.resolve(dir),row,{onPortalReady:state=>{baselineReady=state;},onPortalSnapshot:state=>{baselineState=state;}});
  const delayed=await exercise(path.resolve(dir),row,{libraHydrationDelayMs:250,onPortalReady:state=>{delayedReady=state;},onPortalSnapshot:state=>{delayedState=state;}});
  console.log(JSON.stringify({test:'libra_portal_readiness_observation',baselineReady,delayedReady,baselineState,delayedState,artifactSHA256:delayed.sha256,hostDelayMs:250,deadlineMs:15000}));
  assert.equal(delayedReady.terminalStatus,libraTerminalStatus,'readiness observes the existing terminal GUI event');
  assert.equal(delayedReady.hasManifest,true,'readiness then observes the exact current-scope durable libra.manifest.v1');
  assert.equal(delayedReady.receiptPanelReady,true,'readiness includes the actual current-scope T1 missing receipt panel');
  assert.equal(delayedReady.expectedScope,baselineReady.expectedScope);
  assert.equal(delayedReady.expectedManifestKey,baselineReady.expectedManifestKey);
  console.log(JSON.stringify({test:'libra_full_snapshot_delta',missingDelayedButtons:baseline.portal.buttons.filter(value=>!delayed.portal.buttons.includes(value)),extraDelayedButtons:delayed.portal.buttons.filter(value=>!baseline.portal.buttons.includes(value))}).replace(/[^\x00-\x7f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
  assert.deepEqual(delayed,baseline,'delayed readiness preserves every original API/hook/DOM/registration/storage equality field');
  const corrupted=fs.mkdtempSync(path.join(os.tmpdir(),'release-libra-manifest-negative-'));
  try {
    const original=fs.readFileSync(path.join(dir,'LIBRA.js'),'utf8');
    assert.ok(original.includes('libra.manifest.v1'),'exact positive artifact carries the unchanged manifest schema');
    fs.writeFileSync(path.join(corrupted,'LIBRA.js'),original.split('libra.manifest.v1').join('libra.manifest.CORRUPTED'));
    let negativeState;
    await assert.rejects(exercise(corrupted,row,{onPortalObservation:state=>{negativeState=state;}}),/timed out waiting for LIBRA terminal event, exact current-scope durable manifest and loaded T1 receipt panel/,'terminal UI alone cannot admit a corrupted same-scope durable manifest');
    assert.equal(negativeState.terminalWitnessed,true);
    assert.equal(negativeState.receiptPanelReady,true);
    assert.equal(negativeState.expectedManifestKey,baselineReady.expectedManifestKey);
    assert.equal(negativeState.manifestSchema,'libra.manifest.CORRUPTED');
    assert.equal(negativeState.hasManifest,false);
    console.log(JSON.stringify({test:'libra_corrupted_manifest_negative_observation',negativeState}));
  } finally {
    const resolved=fs.realpathSync(corrupted),temp=path.resolve(os.tmpdir())+path.sep;
    assert.ok(resolved.toLowerCase().startsWith(temp.toLowerCase())&&path.basename(resolved).startsWith('release-libra-manifest-negative-'),'cleanup stays in the exact owned Temp directory');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
  console.log(JSON.stringify({test:'build_plugins_artifact_libra_readiness',passed:2,exactSnapshotEquality:true,negative:'corrupted same-scope durable manifest refused under unchanged15s'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
