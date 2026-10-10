'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {test}=require('node:test');
const program=path.resolve(__dirname,'..'),tool=path.join(program,'tools/update_manifest.cjs');
const fixtureFiles=['program-manifest.json','VERSION.txt','plugins/Flashback_Memory.js','plugins/HAYAKU_Locator_Continuity.js','plugins/LIBRA.js','plugins/LIA_Persona_Linker.js','plugins/RETRACE.js','plugins/GRADIA.js','plugins/LIBRA_World_Manager.js','sdk/MemorySuiteStorageClient.source.js','sdk/MemorySuiteStorageClient.libra.source.js','sdk/MemorySuiteComputeClient.source.js','sdk/MemorySuiteExecutionContract.source.js'];
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'manifest-model-only-'));for(const rel of fixtureFiles){const dest=path.join(root,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(program,rel),dest);}return root;}
function run(root){return cp.spawnSync(process.execPath,[tool],{cwd:root,encoding:'utf8',env:{...process.env,LIBRARIAN_PROGRAM_ROOT:root}});}
test('manifest generation accepts model-only Flashback and removes the obsolete hash-vector pilot',()=>{
  const root=fixture();try{const result=run(root);assert.equal(result.status,0,result.stderr);const manifest=JSON.parse(fs.readFileSync(path.join(root,'program-manifest.json')));assert.equal(Object.hasOwn(manifest.dataContract.computePlane,'flashbackPilot'),false);assert.equal(manifest.files['plugins/Flashback_Memory.js'].sha256,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'plugins/Flashback_Memory.js'))).digest('hex'));assert.ok(manifest.dataContract.computePlane.liaWorldLorePilot.operation);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('manifest generation retains a declared legacy Flashback pilot with both identifiers',()=>{
  const root=fixture();try{fs.appendFileSync(path.join(root,'plugins/Flashback_Memory.js'),"\nconst FLASHBACK_HASH_COMPUTE_OPERATION = 'legacy.test.operation';\nconst FLASHBACK_HASH_COMPUTE_FINGERPRINT = 'legacy-test-fingerprint';\n");const result=run(root);assert.equal(result.status,0,result.stderr);const pilot=JSON.parse(fs.readFileSync(path.join(root,'program-manifest.json'))).dataContract.computePlane.flashbackPilot;assert.equal(pilot.operation,'legacy.test.operation');assert.equal(pilot.algorithmFingerprint,'legacy-test-fingerprint');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an incomplete declared legacy pilot fails without replacing the manifest',()=>{
  const root=fixture();try{const file=path.join(root,'program-manifest.json'),before=fs.readFileSync(file);fs.appendFileSync(path.join(root,'plugins/Flashback_Memory.js'),"\nconst FLASHBACK_HASH_COMPUTE_OPERATION = 'legacy.test.operation';\n");const result=run(root);assert.notEqual(result.status,0);assert.match(result.stderr,/manifest_constant_missing:flashback-fingerprint/);assert.deepEqual(fs.readFileSync(file),before);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
