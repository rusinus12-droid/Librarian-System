'use strict';
const assert=require('node:assert/strict'),path=require('node:path');const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM=path.resolve(__dirname,'..'),key='vector_rag_memory:maintenance_journal:v1';
const physical=(patch={})=>({version:1,operationId:'physical-repair-fixture',scopeKey:'original-scope',mode:'reembed',status:'running',stage:'preflight',startedAt:1,updatedAt:1,physicalRepair:{schema:'flashback.physical_repair.v1',state:'active',requests:1,completed:0},...patch});
const cases=[
 ['active',JSON.stringify(physical()),true,false],['unknown-other-scope',JSON.stringify(physical({scopeKey:'a-different-original-scope',status:'failed',physicalRepair:{schema:'flashback.physical_repair.v1',state:'unknown',requests:1,completed:0}})),true,false],
 ['settled',JSON.stringify(physical({status:'completed',physicalRepair:{schema:'flashback.physical_repair.v1',state:'settled',requests:1,completed:1}})),false,false],
 ['wrong-schema',JSON.stringify(physical({physicalRepair:{schema:'other',state:'active',requests:1,completed:0}})),true,true],
 ['bad-state',JSON.stringify(physical({physicalRepair:{schema:'flashback.physical_repair.v1',state:'garbled',requests:1,completed:0}})),true,true],
 ['empty-scope',JSON.stringify(physical({scopeKey:''})),true,true],['corrupt-json','{broken',true,true],['invalid-journal','{}',true,true],
 ['ordinary-completed',JSON.stringify({version:1,operationId:'legacy-normal',scopeKey:'ordinary-scope',mode:'sync',status:'completed',startedAt:1,updatedAt:1}),false,false],
 ['ordinary-running',JSON.stringify({version:1,operationId:'legacy-normal',scopeKey:'ordinary-scope',mode:'sync',status:'running',startedAt:1,updatedAt:1}),false,false],
 ['absent',null,false,false],['read-failure',JSON.stringify(physical()),true,true]
];
(async()=>{const results=[];for(const [name,raw,blocked,unverified]of cases){let reads=0,writes=0,removals=0;const values=new Map(raw==null?[]:[[key,raw]]),store={values,async getItem(k){if(k===key){reads++;if(name==='read-failure')throw Error('PRIVATE_FAILURE_SENTINEL')}return values.get(k)??null},async setItem(k,v){if(k===key)writes++;values.set(k,v);return true},async removeItem(k){if(k===key)removals++;values.delete(k);return true},async keys(){return [...values.keys()]}};const h=await createFlashback(PROGRAM,{pluginStorage:store,waitForLoaded:true});try{
 if(name==='ordinary-running'){assert.equal(JSON.parse(values.get(key)).status,'abandoned');assert.equal(writes,1)}else{assert.equal(values.get(key)??null,raw,'original journal bytes preserved');assert.equal(writes,0);}assert.equal(removals,0);assert.equal(h.audit.Runtime.maintenanceJournalReadUnverified,unverified);if(name==='active')assert.equal(h.api.maintenanceExecutionStatus().status,'abandoned','restarted work is not an active cancellable execution');if(raw&&name==='unknown-other-scope')assert.equal(h.audit.Runtime.maintenanceJournal.scopeKey,'a-different-original-scope');
 let error;try{await h.api.runMemoryMaintenance('sync',{preflight:{inspection:{coverage:'server_snapshot'}}})}catch(e){error=e}assert(error);if(blocked)assert.equal(error.code,'FLASHBACK_PHYSICAL_OUTCOME_UNRESOLVED');else assert.equal(error.inspectionReason,'HEALTH_LOCAL_MODE_REQUIRED');
 if(raw&&!name.startsWith('ordinary-'))assert.equal(reads,1,'physical/unverified local journal never enters routed read');assert.equal(h.networkCalls.length,0);results.push({name,blocked,unverified,reads,writes,removals});
 }finally{await h.cleanup()}}
 console.log(JSON.stringify({test:'physical_journal_recovery_shapes',passed:results,liveRequests:0}));
})().catch(error=>{console.error(error);process.exitCode=1});
