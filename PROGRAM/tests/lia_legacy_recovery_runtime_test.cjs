'use strict';

const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');

const expose=source=>source.replace('      getLiveSyncCaptureState:',`      auditLegacyRecovery: async (bridge,action)=>{
        const original=memorySuiteLiaValidateRestore;
        memorySuiteLiaValidateRestore=async()=>({ok:true,metrics:{visualAssetBackupChunks:0}});
        try{return await action(createLiaLegacyServerRecovery(bridge));}
        finally{memorySuiteLiaValidateRestore=original;}
      },
      getLiveSyncCaptureState:`);

function bridgeFor(rows,{owner='synthetic-owner',integrityError=null,conflict=false}={}){
  const values=new Map(rows),published=[];
  const binding={owner:'lia',scopeId:owner};
  const listing=()=>({page:{complete:true},keys:[...values.keys()],tombstones:[],records:[...values.keys()].map(key=>({key}))});
  return {published,async serverIntegrity(){if(integrityError)throw integrityError;return {ok:true};},serverBinding:()=>binding,
    async serverKeys(){return listing();},async serverGet(_space,key){return {exists:true,tombstone:false,revision:'r1',digest:`digest:${key}`,value:values.get(key)};},
    async ownerLegacyRead(_space,key){return conflict&&key==='dynamicPersonaLorebookGeneratorResultVault'?'local-conflict':null;},
    async publishLocalRecovery(input){await input.validate(input.records);published.push(...input.records);return {verified:true,restored:input.records.length};}};
}

const indexKey='liaPersonaLinkerLivePersonaIndexV2';
function hashText(value){let hash=2166136261;for(const char of String(value||'')){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}return `${(hash>>>0).toString(36)}-${String(value||'').length}`;}
const ownerScope='char:other|chat:other';
const shardKey=`liaPersonaLinkerLivePersonaScopeV2::${hashText(ownerScope).slice(0,24)}`;
const scopedIndex=(scopeId)=>`${indexKey}::memory-suite-scope:v1:${encodeURIComponent(scopeId)}`;

(async()=>{
  const f=await createFixture('official',{transformSource:expose});
  try{
    const valid=bridgeFor([[scopedIndex('synthetic-owner'),JSON.stringify({entries:{'synthetic-owner':{scopeId:'synthetic-owner',scopeKey:ownerScope,storageKey:shardKey,digest:'synthetic',livePersonaId:'foreign-live'}}})],[shardKey,JSON.stringify({scopeKey:ownerScope,livePersonaId:'foreign-live',liveState:[]})]]);
    const imported=await f.runtime.auditLegacyRecovery(valid,async recovery=>{const summary=await recovery.preview();assert.equal(summary.readOnly,true);assert.equal(summary.serverWrites,0);assert.equal(summary.conflicts.length,0);const result=await recovery.publish(summary);assert.equal(result.verified,true);return result;});
    assert.equal(imported.restored,2,'valid owner-scoped synthetic recovery publishes the validated index and shard');
    assert.equal(valid.published.length,2);assert.ok(valid.published.some(row=>JSON.parse(row.value).scopeKey==='char:other|chat:other'),'imported Live Persona shard retains its original owner scope');
    const invalid=bridgeFor([[scopedIndex('synthetic-owner'),JSON.stringify({entries:{'another-owner':{scopeId:'another-owner',scopeKey:'char:foreign|chat:foreign',storageKey:shardKey}}})],[shardKey,JSON.stringify({scopeKey:'char:foreign|chat:foreign'})]]);
    await f.runtime.auditLegacyRecovery(invalid,async recovery=>{await assert.rejects(recovery.preview(),error=>error.code==='LIA_RECOVERY_PROJECTION_INVALID');});
    assert.equal(invalid.published.length,0,'invalid owner projection never reaches local publication');
    const conflicting=bridgeFor([['dynamicPersonaLorebookGeneratorResultVault','remote-synthetic-value']],{conflict:true});
    await f.runtime.auditLegacyRecovery(conflicting,async recovery=>{const summary=await recovery.preview();assert.deepEqual([...summary.conflicts],['dynamicPersonaLorebookGeneratorResultVault']);assert.equal(summary.readOnly,true);assert.equal(summary.serverWrites,0);});
    assert.equal(conflicting.published.length,0,'local conflict is surfaced for review, never overwritten');
    const failed=bridgeFor([], {integrityError:Object.assign(new Error('synthetic integrity unavailable'),{code:'SYNTHETIC_INTEGRITY_FAILURE'})});
    await f.runtime.auditLegacyRecovery(failed,async recovery=>{await assert.rejects(recovery.preview(),error=>error.code==='SYNTHETIC_INTEGRITY_FAILURE');});
    assert.equal(failed.published.length,0,'integrity error cannot publish or alter local data');
    console.log('lia_legacy_recovery_runtime_test: PASS (owner-scoped import/readback, invalid projection, conflict and integrity failure; synthetic bridge only)');
  }finally{await f.dispose();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
