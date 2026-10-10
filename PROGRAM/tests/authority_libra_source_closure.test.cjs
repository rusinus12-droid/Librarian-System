'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {sourceClosureFixture,digest}=require('./fixtures/authority_source_closure_fixture.cjs');
const {createAuthorityObserver}=require('../server/authority/observation.cjs');
function observer(t,f){const o=createAuthorityObserver({dataDir:f.dataDir,control:f.control});t.after(()=>o.close());assert.equal(typeof o.observeSourceClosure,'function','bounded backend source closure must exist');return o;}
function capture(o,f){const cap=o.observeSourceClosure(f.sourceRequest()),args={handle:cap.handle,requestId:'closure1'};return {cap,args,view:o.readCaptured(args)};}
test('bounded closure captures complete canonical, Micro and archive bodies with immutable backend receipt',t=>{
 const f=sourceClosureFixture(t),o=observer(t,f),{cap,args,view}=capture(o,f);
 assert.equal(cap.summary.usage,'backend-verification-only');assert.equal(cap.summary.sourceCoverage,'libra.stored-scope-prefix.v1');assert.equal(view.items.length,6);
 assert.equal(view.receipt.coverage.complete,true);assert.equal(view.receipt.coverage.archiveLayers,2);assert.equal(view.receipt.coverage.inheritedMicroArchives,1);
 assert.deepEqual(view.items.filter(x=>x.profile==='libra.canonical.memory-text.v1').map(x=>x.text).sort(),[f.memory.text,'Complete archived body 1','Complete archived body 2'].sort());
 const claims=view.items.find(x=>x.profile==='libra.micro.claims-text.v1');assert.ok(claims.text.length>600);assert.match(claims.text,/변화 10/);assert.match(claims.text,/근거: Ari opened the door\./);
 assert.equal(view.items.filter(x=>x.profile==='libra.micro.source-span.v1').length,2);for(const row of view.items){assert.equal(row.utf8Bytes,Buffer.byteLength(row.text));assert.equal(row.sha256,crypto.createHash('sha256').update(row.text).digest('hex'));}
 assert.equal(view,o.readCaptured(args));assert.ok(Object.isFrozen(view.receipt.coverage));assert.throws(()=>view.items.pop());assert.equal(o.assertCurrent(args).status,'current');
 assert.throws(()=>o.captureCorpus({...f.sourceRequest(),nativeAuthority:{verified:true},modeEpoch:1}),{code:'SOURCE_PROOF_UNAVAILABLE'});
});
test('currentness is metadata only, permits unrelated KV writes and revokes changed source records',t=>{
 const f=sourceClosureFixture(t),o=observer(t,f),{args}=capture(o,f);f.mutate('unrelated-source',{ok:true});
 const original=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){assert.doesNotMatch(sql,/json_(?:tree|each|extract|valid).*value_json|THEN CAST\(k\.value_json AS BLOB\)/);return original.call(this,sql);};
 try{assert.equal(o.assertCurrent(args).status,'current');}finally{DatabaseSync.prototype.prepare=original;}
 f.mutate(f.local[0].recordKey,{...f.local[0].record,claims:[]});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});assert.throws(()=>o.readCaptured(args),{code:'SOURCE_CHANGED'});
});
test('missing Micro receipt or archive predecessor rejects the entire declared unit',async t=>{
 for(const kind of ['receipt','archive'])await t.test(kind,t=>{const f=sourceClosureFixture(t,{mutateSeed(f,s){f.databases.libra.prepare('DELETE FROM kv WHERE key=?').run(kind==='receipt'?s.local[0].receiptKey:s.archive.rows[1].key);}}),o=observer(t,f);assert.throws(()=>o.observeSourceClosure(f.sourceRequest()),{code:'SOURCE_PROOF_UNAVAILABLE'});});
});
test('stored branch and unified cutoff decisions are explicit, with no caller exclusions',t=>{
 const f=sourceClosureFixture(t,{mutateSeed(f){f.manifest.memories['1'].artifactSchema='libra.canonical_artifact.v4';f.manifest.branchGuard={schema:'libra.branch_guard.v1',status:'bootstrap_pending',verifiedStarts:[]};f.seed(f.manifestKey,f.manifest);f.seed(`libra:v1:scope:${f.scopeKey}:state-worldline-meta:v1`,{schema:'libra.state_worldline_meta.v1',scopeKey:f.scopeKey,activeWorldlineId:'main',revision:1,worldlines:{main:{id:'main',parentId:null,forkTurn:0,cutoffTurn:6}}});}}),o=observer(t,f),{view}=capture(o,f);
 assert.equal(view.items.some(x=>x.key===f.key),false);assert.equal(view.items.some(x=>x.key===f.local[1].recordKey),false);assert.equal(view.receipt.coverage.cutoffTurn,6);assert.ok(view.receipt.exclusions.some(x=>x.reason==='branch_unverified'));
 assert.throws(()=>o.observeSourceClosure({...f.sourceRequest(),excludedKeys:[f.key]}));
});
test('durable deletion fences refuse capture and retained maintenance history prevents fence ABA',t=>{
 const f=sourceClosureFixture(t),o=observer(t,f),{args}=capture(o,f);
 function maintenance(body){const operationId=crypto.randomUUID(),fingerprint=crypto.createHash('sha256').update(operationId).digest('hex');f.coordinator.runMutation({namespace:'libra',operationId,fingerprint,operationClass:'maintenance'},body);}
 maintenance(tx=>tx.run('INSERT INTO libra_deleted_owner_keys VALUES(?,?,?)','plugin',f.key,'scope-deletion1'));
 assert.throws(()=>o.observeSourceClosure(f.sourceRequest('deleted')),{code:'SOURCE_PROOF_UNAVAILABLE'});
 maintenance(tx=>tx.run('DELETE FROM libra_deleted_owner_keys WHERE space=? AND key=?','plugin',f.key));
 assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});
 const next=o.observeSourceClosure(f.sourceRequest('after-maintenance'));assert.equal(o.readCaptured({handle:next.handle,requestId:'after-maintenance'}).items.length,6);
});
test('complete inventory and restore absence are captured, not an ordinary key-list fallback',t=>{
 const f=sourceClosureFixture(t),o=observer(t,f),{args}=capture(o,f),record=`libra:v1:scope:${f.scopeKey}:micro-memory:new:history`;
 f.mutate(record,{schema:'history'});f.mutate(record,null,{purge:true});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});
 const pending=`libra:v1:scope:${f.scopeKey}:portable-restore-journal:pending`;f.mutate(pending,{status:'pending'});assert.throws(()=>o.observeSourceClosure(f.sourceRequest('restore')),{code:'SOURCE_PROOF_UNAVAILABLE'});
});
test('stored tombstoned Micro source head cannot supply an apparently complete unit',t=>{
 const f=sourceClosureFixture(t,{mutateSeed(f,s){const row=s.local[0].rows.find(r=>r.value.schema==='libra.completed_turn_head.v1');f.seed(row.key,{...row.value,tombstone:true});}}),o=observer(t,f);
 assert.throws(()=>o.observeSourceClosure(f.sourceRequest()),{code:'SOURCE_PROOF_UNAVAILABLE'});
});
test('selected canonical with unsupported linked or typed source authority refuses, not partial success',t=>{
 const f=sourceClosureFixture(t,{mutateSeed(f){f.seed(f.key,{...f.memory,artifactSchema:'libra.canonical_artifact.v4',sourceEvidenceRef:{owner:'libra',key:'missing-approved-evidence'}});}}),o=observer(t,f);
 assert.throws(()=>o.observeSourceClosure(f.sourceRequest()),{code:'SOURCE_PROOF_UNAVAILABLE'});
});
test('archive membership checks the stored inherited session projection',t=>{
 const f=sourceClosureFixture(t,{mutateSeed(f){f.manifest.inheritedMemories[0].sessionEpoch=-99;f.seed(f.manifestKey,f.manifest);}}),o=observer(t,f);
 assert.throws(()=>o.observeSourceClosure(f.sourceRequest()),{code:'SOURCE_PROOF_UNAVAILABLE'});
});
