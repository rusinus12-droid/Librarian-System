'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'program-manifest.json'),'utf8'));
const version=fs.readFileSync(path.join(root,'sdk/MemorySuiteStorageClient.source.js'),'utf8').match(/^\/\* LIBRARIAN SYSTEM STORAGE SDK v(\d+\.\d+\.\d+)/m)[1];
assert.equal(manifest.storageSdkVersion,version,'generated manifest binds the active storage SDK version');
const p=manifest.dataContract.core3GlobalModePolicy;
assert(p,'active core3 global policy is explicit rather than inferred from preserved SDK consumers');
assert.deepEqual(p.owners,['flashback','hayaku','libra']);
assert.equal(p.modeSelectionScope,'plugin-global');assert.equal(p.perChatModeSelection,false);
assert.equal(p.legacySourceRouteRetainedUntilVerified,true);assert.equal(p.allKnownChatDiscoveryRequired,true);
assert.equal(p.incompleteDiscoveryBlocksCompletion,true);assert.equal(p.sourceCommitAfterVerifiedMigration,true);
assert.equal(manifest.dataContract.legacyGlobalModeImportedIntoActiveScopeOnly,false);
assert.equal(manifest.dataContract.legacyGlobalModeArgumentResetToPluginOnly,false);
assert.equal(manifest.dataContract.serverConnectionGui.scopeOnlyModeTransition,false);
assert.deepEqual(manifest.dataContract.serverConnectionGui.globalModeOwners,p.owners);
assert.equal(manifest.dataContract.scopeSpecificStorageModesCompatibilityOnly,true,'legacy per-scope source routes remain readable for safe migration');
for(const [name,binding]of Object.entries(manifest.storageSdkBindings)){
 if(binding.synchronization==='verify-preserved-only')assert(['LIA_Persona_Linker.js','RETRACE.js','GRADIA.js'].includes(name));
}
console.log(JSON.stringify({passed:1,failed:0,contract:'current core3 global selection and preserved legacy source-route metadata'}));
