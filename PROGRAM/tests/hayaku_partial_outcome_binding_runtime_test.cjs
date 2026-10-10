'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const source='Alice opened the cedar chest in the hall and found a blue ribbon.';
const packet=createValidPacket({turn:2,subject:'Alice',summary:source});
for(const axis of ['entity','world','narrative','planner'])for(const [key,v]of Object.entries(packet[axis]))if(Array.isArray(v))packet[axis][key]=[];
packet.entity.characters=[{name:'Alice',location:'The entrance hall',current_state:'Examining the discovery'}];
packet.entity.pov_memories=[{ownerEntityId:'ALICE_UNDECLARED',summary:'A ribbon was discovered.'}];
packet.world.active_events=[{id:'discovery',summary:'A ribbon was discovered.',location:'The entrance hall'}];
packet.meta.summary_memory={summary:source};
const envelope={schema:'hayaku.native_repair_output.v1',packet,grounding:['entity.characters[0]','entity.pov_memories[0]','world.active_events[0]','meta.summary_memory.summary'].map(path=>({path,source:'target',evidence:[source]}))};
const msg=(role,id,data)=>({role,id,chatId:id,data});
(async()=>{
const r=await createHayakuRuntime({autoRepair:false,messages:[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Open it.'),msg('assistant','a2',source)],llmResponder:async()=>({type:'success',result:JSON.stringify({answer:envelope})})});
try{
 const first=await r.hayaku.recovery.repairNow();assert.equal(first.partialMemory.durable,true);assert.equal(first.recordAdmission.rejected.length,0);assert(first.recordAdmission.derived.some(x=>x.reason==='unbound_entity_reference'));
 let debug=await r.hayaku._test.buildHayakuOperationDebugExport();const firstAtoms=debug.analysisDiagnostics.partialMemory.stored.records[0].atoms;
 const pov=firstAtoms.find(x=>x.path.startsWith('entity.pov'));assert.equal(pov.value.ownerEntityId,undefined);assert.equal(pov.value._unresolvedEntityBindings.ownerEntityId,'ALICE_UNDECLARED');
 packet.world.active_events[0].summary='The chest contained a blue ribbon.';
 const second=await r.hayaku.recovery.repairNow();assert.equal(second.partialMemory.durable,true);
 debug=await r.hayaku._test.buildHayakuOperationDebugExport();const stored=debug.analysisDiagnostics.partialMemory.stored.records[0];
 assert.equal(stored.atoms.filter(x=>x.value.id==='discovery').length,1);assert(stored.supersededAtoms.some(x=>x.value.id==='discovery'));assert.equal(stored.completeTurn,false);assert.equal(r.llmCalls.length,2);
 const recalled=await r.hayaku._test.searchAcceptedPartialMemory(await r.hayaku._test.currentChatScope(),'ribbon');assert(!JSON.stringify(recalled).includes('ALICE_UNDECLARED'));
}finally{await r.dispose();}
// Exercise the production batch finalizer with durable/failed/cancelled outcomes.
const code=fs.readFileSync(require('node:path').join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const start=code.indexOf('    const finish = result => {',code.indexOf('const results=[];let completed=0;'));
const end=code.indexOf('    const stopped =',start);
const c={hayakuRecoveryBlocked:r.hayaku._test.hayakuRecoveryBlocked,now:()=>10,clone:x=>structuredClone(x),ensureArray:x=>Array.isArray(x)?x:[],state:{},diagnostic:{jobId:"test-job"},targets:[2],completed:0,pushOperationLog:()=>{}};
vm.createContext(c);vm.runInContext(code.slice(start,end)+'globalThis.finish=finish;',c);
const saved=c.finish({ok:false,results:[{ok:false,partialMemory:{saved:true,durable:true}}]});assert.equal(saved.ok,true);assert.equal(saved.packetCompletion,'incomplete');assert.equal(saved.partialSaved,1);
assert.equal(c.finish({ok:false,results:[{ok:false,partialMemory:{saved:true,durable:false}}]}).ok,false);
assert.equal(c.finish({ok:false,cancelled:true,results:[{ok:false,partialMemory:{saved:true,durable:true}}]}).ok,false);
console.log('PASS: paraphrase admission, unbound owner, durable revision merge, recall isolation, batch partial success and write/cancel failure separation');
})().catch(e=>{console.error(e);process.exitCode=1;});
