'use strict';
const assert=require('node:assert/strict');const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
(async()=>{const results=[];for(const mode of ['server_only','mirror']){const s=await serverFixture({mode});try{
 await s.f.run();await s.f.r.api.retryPendingUnifiedVectors();
 // Let the pre-existing post-commit vector flush settle before testing inspection.
 await new Promise(r=>setTimeout(r,500));
 const headRow=s.getRecords('libra.continuity_state.v2')[0],prefix=headRow.key.slice(0,-'continuity-state'.length);
 // Retained auxiliary journals are inventoried without becoming memory faults.
 await s.mutate(prefix+'source-edit-consent:v1',{schema:'memory-suite.source-edit-consent.v1',owner:'LIBRA',scopeKey:prefix.slice('libra:v1:scope:'.length,-1),tasks:{}});
 const dump=()=>JSON.stringify(s.app.repositories.libra.database.prepare('SELECT space,key,revision,digest,deleted FROM kv ORDER BY space,key').all());
 let before=dump(),calls=s.f.control.calls.length;const healthy=await s.f.r.api.getServerScopeHealth();
 assert.equal(healthy.readOnly,true);assert.equal(healthy.complete,true,JSON.stringify(healthy));assert.equal(healthy.status,'no_detected_issue',JSON.stringify(healthy));assert.equal(healthy.counts.canonicalRefs,1);assert.equal(healthy.throughTurn,5);assert.equal(dump(),before,'DB metadata must not change');assert.equal(s.f.control.calls.length,calls);
 assert.ok(!JSON.stringify(healthy).includes('민아'),'summary excludes RP content');
 assert.ok(!JSON.stringify(healthy).includes('memory-suite.source-edit-consent.v1'),'auxiliary journal bodies are outside the structural health report');
 await s.mutate(prefix+'entity-registry:v2:unified-tx:pending:1',{schema:'libra.unified_state_tx.v1',state:'prepared',scopeKey:'fixture'});
 await s.mutate(headRow.key,{...headRow.value,entityRegistryFingerprint:'mismatch'});
 before=dump();const bad=await s.f.r.api.getServerScopeHealth();assert.equal(bad.status,'attention');assert.equal(bad.counts.pendingState,1);assert.ok(bad.issues.some(x=>x.code==='HEAD_REGISTRY_FINGERPRINT_MISMATCH'));assert.equal(dump(),before,'DB metadata must not change');assert.equal(s.f.control.calls.length,calls);
 // Missing canonical referenced row, not merely an absent optional vector.
 const ref=s.getManifest().memories['1'];s.app.repositories.libra.mutate({kind:'remove',space:'plugin',key:ref.key,operationId:'health_remove_012345'});
 const missing=await s.f.r.api.getServerScopeHealth();assert.equal(missing.counts.missingCanonicalRefs,1);
 results.push(mode);
 }finally{await s.cleanup();}}
 console.log(JSON.stringify({test:'libra_scope_health_runtime',passed:results,realOwnerApi:true,realHttpSqlite:true,readOnly:true}));})().catch(e=>{console.error(e);process.exitCode=1;});
