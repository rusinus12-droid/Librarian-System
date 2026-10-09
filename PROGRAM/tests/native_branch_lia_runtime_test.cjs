'use strict';
const assert=require('node:assert/strict');const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const {clone,branch}=require('./fixtures/native_branch_fixture.cjs');
(async()=>{const f=await createFixture('official');try{
 const snapshot=await f.runtime.debugCaptureLiveSyncBatch({target:{characterIndex:0,chatIndex:0,scopeKey:f.scopeKey},startPair:1});
 const parent=clone(f.liveChat);for(let i=6;i<=10;i++)parent.message.push({role:'user',chatId:'u'+i,data:'U'+i},{role:'char',chatId:'a'+i,data:'A'+i});
 const child=branch(parent,7,'lia-child');const char={...clone(f.character),chats:[child,parent]};
 const binding={...clone(f.binding),lastProcessedPairCount:10,liveState:[{value:'FUTURE CURRENT HEAD'}],ledgers:[{id:'checkpoint-5',startPair:1,endPair:5,fingerprintSchema:'lia.turn_pair_fingerprint.v2',fingerprints:snapshot.fingerprints,liveStateAfter:[{value:'PAST VERIFIED CHECKPOINT'}],coreOverlayAfter:[],coreCandidateHistoryAfter:{}},{id:'future-10',startPair:6,endPair:10,fingerprintSchema:'lia.turn_pair_fingerprint.v2',fingerprints:['x','x','x','x','x'],liveStateAfter:[{value:'FUTURE'}]}]};
 // Use the actual production schema constant from the published pair observation.
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../plugins/LIA_Persona_Linker.js'),'utf8');
 const schema=/const LIVE_PERSONA_PAIR_FINGERPRINT_SCHEMA_V2\s*=\s*["']([^"']+)/.exec(src)[1];binding.ledgers.forEach(l=>l.fingerprintSchema=schema);
 const ctx={char,chat:child,charIndex:0,chatIndex:0};
 const project=b=>f.runtime.debugProjectNativeBranchPersonaState(ctx,b);
 const x=project(binding);assert.equal(x.receipt.verified,true,JSON.stringify(x));assert.equal(x.lastProcessedPairCount,5);assert.equal(x.liveState[0].value,'PAST VERIFIED CHECKPOINT');assert.equal(x.ledgers.length,1);assert.equal(x.receipt.pendingPrefixPairs,2);assert.equal(x.receipt.latestParentHeadCopied,false);
 const no=project({...binding,ledgers:[]});assert.equal(no.receipt.verified,false);assert.equal(no.liveState.length,0);
 const wrong=project({...binding,scopeKey:'char:other-owner|chat:'+parent.id});assert.equal(wrong.receipt.reason,'persona_owner_character_mismatch');assert.equal(wrong.receipt.verified,false);
 const changed=clone(binding);changed.ledgers[0].fingerprints[1]='changed';assert.equal(project(changed).receipt.verified,false);
 const beforeAnchor=project({...binding,anchorPairCount:9});assert.equal(beforeAnchor.receipt.reason,'branch_precedes_persona_anchor');
 const inherited=project({...binding,anchorPairCount:5,forkedFromScopeKey:'other'});assert.equal(inherited.receipt.reason,'inherited_persona_anchor_unverified');
 // Actual asynchronous-batch guard rejects a changed antecedent even when turns 6..10 are unchanged.
 Object.assign(f.liveChat,parent);const batch=await f.runtime.debugCaptureLiveSyncBatch({target:{characterIndex:0,chatIndex:0,scopeKey:f.scopeKey},startPair:6});f.liveChat.message[1].data+=' changed antecedent';
 const stale=await f.runtime.debugVerifyLiveSyncBatch(batch);assert.equal(stale.ok,false);assert.equal(stale.reason,'batch_antecedent_changed',JSON.stringify(stale));
 assert.equal(binding.liveState[0].value,'FUTURE CURRENT HEAD','source binding not mutated');
 console.log(JSON.stringify({test:'native_branch_lia_runtime',passed:8}));
 }finally{await f.dispose()}})().catch(e=>{console.error(e);process.exitCode=1});
