'use strict';
// TEST ONLY. Durable means persistent across test clients sharing this object,
// not process crash durability. All atomic sections below contain no await.
// Fault notification is deliberate test instrumentation, NOT a demonstrated
// production integrity monitor or proof that small HEAD responses cost O(1).
const crypto = require('node:crypto');
const {PROTOCOL,SCHEMA,REQUIRED_CAPABILITIES,WRITER_OPERATIONS}=require('../src/wm-versioned-snapshot.cjs');
const clone = x => structuredClone(x);
const digest = raw => crypto.createHash('sha256').update(raw===null?'':raw).digest('hex');
const stamp = head => JSON.stringify(head);
const fault = code => Object.assign(new Error(code),{code});
function createReferenceProvider({maxOperations=64}={}) {
    if(!Number.isSafeInteger(maxOperations)||maxOperations<1)throw fault("invalid_journal_budget");
    const heads=new Map(), generations=new Map(), leases=new Map(), operations=new Map();
    const authorityId='reference-only-authority', storeId='reference-only-store';
    let serial=0, blockedRead=null, readStarted=null, stageFail=false, lostAck=false, statusFail=false, violation=false;
    const metrics={};
    const resetCounters=()=>{for(const key of ['acquireCalls','headCalls','wholePayloadReads','shardReads','payloadBytesRead','prepareCalls','publishCalls','publishedCommits','statusCalls','headResponseBytes','observeHeadSetCalls','observeHeadSetScopes','providerHeadItemsScanned','providerMetadataItemsScanned','providerMetadataBytesProcessed','providerHeadPayloadBytesScanned','providerShardItemsScanned','providerStageItemsScanned','providerStageBytesProcessed'])metrics[key]=0;};
    resetCounters();
    const issue = prefix => prefix+':'+(++serial);
    const metadata = (head, isHead) => {metrics.providerMetadataItemsScanned++;metrics.providerMetadataBytesProcessed+=Buffer.byteLength(JSON.stringify(head));if(isHead){metrics.providerHeadItemsScanned++;metrics.headResponseBytes+=Buffer.byteLength(JSON.stringify(head));}};
    const shardsFor = raw => {
        if(raw===null)return [];
        const bytes=Buffer.from(raw,'utf8'), shards=[];
        for(let i=0;i<bytes.length;i+=512*1024)shards.push(Buffer.from(bytes.subarray(i,i+512*1024)));
        return shards;
    };
    const stage = (scope,raw,operation,previous) => {
        const generationId=issue('generation'), epoch=!previous||['reset','remove','restore','migration','recovery'].includes(operation)?issue('epoch'):previous.epoch;
        const shards=shardsFor(raw), head=Object.freeze({protocol:PROTOCOL,authorityId,storeId,scope,epoch,revision:issue('revision'),schema:SCHEMA,generationId,sha256:digest(raw),utf8Bytes:raw===null?0:Buffer.byteLength(raw),tombstone:raw===null});
        metrics.providerStageItemsScanned+=shards.length;metrics.providerStageBytesProcessed+=head.utf8Bytes;
        // Real provider must durably verify the whole generation before publication.
        const generation={head,shards,healthy:true,ready:!stageFail,pins:0};stageFail=false;generations.set(generationId,generation);return generation;
    };
    const ensure = scope => {if(!heads.has(scope)){const gen=stage(scope,null,'remove',null);heads.set(scope,gen.head);}return heads.get(scope);};
    const healthy = head => {const gen=generations.get(head.generationId);if(!gen||!gen.ready||!gen.healthy)throw fault('generation_unhealthy');return gen;};
    const seed = async(scope,raw)=>{if(heads.has(scope))throw fault('seed_existing');const gen=stage(scope,raw,'migration',null);heads.set(scope,gen.head);};
    const describe=()=>Object.freeze({protocol:PROTOCOL,authorityId,capabilities:[...REQUIRED_CAPABILITIES,'atomic_healthy_head_set_observation'],writers:[...WRITER_OPERATIONS],testOnly:true});
    const acquire=async scope=>{
        metrics.acquireCalls++;const head=ensure(scope),gen=healthy(head);metadata(head,false);
        const lease=Object.freeze({});leases.set(lease,gen);gen.pins++;return {head:clone(head),lease};
    };
    const readGeneration=async lease=>{
        const gen=leases.get(lease);if(!gen)throw fault('lease_invalid');
        metrics.wholePayloadReads++;if(readStarted){readStarted();readStarted=null;}
        const block=blockedRead;blockedRead=null;if(block)await block;
        if(!leases.has(lease))throw fault('lease_invalid');
        healthy(gen.head);
        const shards=gen.shards.map(part=>{metrics.providerShardItemsScanned++;metrics.shardReads++;if(!Buffer.isBuffer(part))throw fault('missing_shard');metrics.payloadBytesRead+=part.length;return part;});
        return gen.head.tombstone?null:Buffer.concat(shards).toString('utf8');
    };
    const head=async(scope,lease)=>{
        metrics.headCalls++;if(!leases.has(lease)||leases.get(lease).head.scope!==scope)return {leaseValid:false,head:null};
        const current=ensure(scope);healthy(current);metadata(current,true);return {head:clone(current),leaseValid:true};
    };
    const release=async lease=>{const gen=leases.get(lease);if(gen){gen.pins--;leases.delete(lease);}};
    const prepare=async input=>{
        metrics.prepareCalls++;const {scope,expectedHead,raw,operation,operationId,rawSha256}=input;
        if(!WRITER_OPERATIONS.includes(operation)||rawSha256!==digest(raw))throw fault('bad_stage');
        const fingerprint=JSON.stringify({scope,expectedHead,rawSha256,operation});
        const existing=operations.get(operationId);
        if(existing){if(existing.fingerprint!==fingerprint)throw fault('operation_id_conflict');return clone(existing.prepared);}
        if(operations.size>=maxOperations)throw fault('journal_full');
        if(stamp(ensure(scope))!==stamp(expectedHead))throw fault('conflict');
        const gen=stage(scope,raw,operation,expectedHead);if(!gen.ready)throw fault('stage_incomplete');
        const prepared=Object.freeze({preparedId:issue('prepared'),operationId,scope,operation,expectedHead:clone(expectedHead),rawSha256,head:clone(gen.head)});
        operations.set(operationId,{fingerprint,prepared,receipt:null});return clone(prepared);
    };
    const publish=async prepared=>{
        metrics.publishCalls++;const op=operations.get(prepared.operationId);
        if(!op||stamp(op.prepared)!==stamp(prepared))throw fault('prepared_unknown');
        if(op.receipt)return clone(op.receipt);
        // Reference-only atomic critical section: no awaited get+set emulation.
        if(stamp(ensure(prepared.scope))!==stamp(prepared.expectedHead))return {status:'conflict'};
        healthy(prepared.head);heads.set(prepared.scope,prepared.head);metrics.publishedCommits++;
        op.receipt=Object.freeze({status:'committed',operationId:prepared.operationId,operation:prepared.operation,scope:prepared.scope,rawSha256:prepared.rawSha256,expectedHead:clone(prepared.expectedHead),head:clone(prepared.head)});
        if(lostAck){lostAck=false;throw fault('ack_lost');}return clone(op.receipt);
    };
    const status=async operationId=>{metrics.statusCalls++;if(statusFail)throw fault('status_unavailable');return clone(operations.get(operationId)?.receipt||{status:'unknown'});};
    const observeHeads=async scopes=>{
        metrics.observeHeadSetCalls++;
        if(!Array.isArray(scopes)||!scopes.length||scopes.length>8||new Set(scopes).size!==scopes.length)throw fault('invalid_read_set');
        metrics.observeHeadSetScopes+=scopes.length;
        return scopes.map(scope=>{const current=heads.get(scope);if(!current)throw fault('unknown_scope');healthy(current);metadata(current,true);return clone(current);});
    };
    return Object.freeze({describe,acquire,readGeneration,head,release,prepare,publish,status,seed,observeHeads,
        peek:async scope=>clone(ensure(scope)),resetCounters,counters:()=>({...metrics}),activeLeases:()=>leases.size,
        blockNextRead:promise=>{blockedRead=promise;},waitForRead:()=>new Promise(resolve=>{readStarted=resolve;}),
        failNextStage:()=>{stageFail=true;},loseNextAck:()=>{lostAck=true;},failStatus:value=>{statusFail=value;},
        damage:(scope,kind,{lie=false}={})=>{const gen=generations.get(ensure(scope).generationId);if(kind==='missing')gen.shards[0]=null;else if(gen.shards[0]?.length)gen.shards[0][0]^=1;if(lie)violation=true;else gen.healthy=false;},
        contractViolated:()=>violation,maxShardBytes:()=>Math.max(0,...[...generations.values()].flatMap(g=>g.shards.filter(Buffer.isBuffer).map(s=>s.length))),
        collect:()=>{const live=new Set([...heads.values()].map(h=>h.generationId));for(const [id,gen]of generations)if(!live.has(id)&&!gen.pins)generations.delete(id);},
        retainedGenerationCount:()=>generations.size,retainedPayloadBytes:()=>[...generations.values()].reduce((n,g)=>n+g.shards.filter(Buffer.isBuffer).reduce((sum,p)=>sum+p.length,0),0),operationCount:()=>operations.size,
        hasGeneration:id=>generations.has(id),revokeLeases:()=>{for(const gen of leases.values())gen.pins--;leases.clear();}});
}
module.exports={createReferenceProvider};
