'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const create=require('../tools/libra_gradia_unified_read.cjs'),createBus=require('./fixtures/libra_gradia_read_bus.cjs');
const fingerprint=v=>crypto.createHash('sha256').update(v).digest('hex');
async function fixture(t,options={}){
 const bus=createBus();let serial=0,queries=0,releases=0,current=true,boundary=1,authority;
 const api=id=>({...bus.api(id),...(options.missingRemove?{removePluginChannelListener:async()=>{throw Error('API method removePluginChannelListener not found');}}:{})});
 const owner=create({role:'owner',api:api('libra'),now:options.now,release:execution=>{releases++;options.onRelease?.(execution);},fingerprint,randomId:()=>String(++serial),
   boundary:async()=>({dataInstanceId:'A'.repeat(32),resetEpoch:0,boundary}),
   query:async(request,cap)=>{queries++;authority=cap;const receipt=cap.bindGraph({readerFrame:{},nodes:[],edges:[],bases:[]});
     assert.equal(cap.verifyReceipt(receipt),true);await options.onQuery?.();
     return {modelDispatchEligible:true,queryComplete:false,deliveryOutcome:'partial',windowRead:{limit:20},nextWindow:{microCursor:'remaining'},
       bundle:{generation:'g1'},packet:{renderedText:options.content??'TYPED OWNER EVIDENCE',packetDigest:fingerprint('packet')}};},
   verify:async()=>{await options.onVerify?.();return current;}});
 await owner.start();
 const client=create({role:'client',api:api('serial_gradation_agents_for_rp'),timeoutMs:options.timeoutMs||1000,randomId:()=>String(++serial)});
 t.after(async()=>{await client.dispose();await owner.dispose();});
 const input={scope:{scopeKey:'s',characterId:'c',chatId:'h'},queryText:'current question',maxCorpusBytes:4096};
 const proof=s=>({scope:s.scope,readIdentity:s.readIdentity,dependencies:s.dependencies,evidenceRevision:s.evidenceRevision,dataInstanceId:s.dataInstanceId,resetEpoch:s.resetEpoch});
 return {client,owner,bus,input,proof,queries:()=>queries,releases:()=>releases,authority:()=>authority,setCurrent:v=>{current=v;},changeBoundary:()=>{boundary++;}};
}
test('issued owner receipt serves one shared query and reports bounded query coverage',async t=>{
 const f=await fixture(t);const r=await f.client.capture(f.input);
 assert.equal(r.engine.source,'unified_engine');assert.equal(r.engine.queryComplete,false);assert.equal(r.complete,true);
 assert.equal(r.items[0].source.kind,'owner_issued_evidence_bundle');assert.equal(r.engine.nextWindow.microCursor,'remaining');
 assert.equal((await f.client.current({proof:f.proof(r)})).current,true);assert.equal(f.queries(),1);
 await assert.rejects(()=>f.client.current({proof:{...f.proof(r),evidenceRevision:'0'.repeat(64)}}),e=>e.code==='LIB_READ_STALE');
});
test('owner currentness and native-boundary changes reject the previously issued receipt',async t=>{
 const f=await fixture(t),r=await f.client.capture(f.input);f.setCurrent(false);
 await assert.rejects(()=>f.client.current({proof:f.proof(r)}),e=>e.code==='LIB_READ_STALE');
 f.setCurrent(true);const next=await f.client.capture(f.input);f.changeBoundary();
 await assert.rejects(()=>f.client.current({proof:f.proof(next)}),e=>e.code==='LIB_READ_BOUNDARY_CHANGED');
});
test('receipt release revokes both currentness and the private compiler callback',async t=>{
 const f=await fixture(t),r=await f.client.capture(f.input);await f.client.release(r.readIdentity.ownerReceiptId);
 await assert.rejects(()=>f.client.current({proof:f.proof(r)}),e=>e.code==='LIB_READ_STALE');
 assert.throws(()=>f.authority().verifyReceipt({}),/LIB_READ_STALE/);
});
test('a canceled capture cannot publish its late query result',async t=>{
 let release,entered;const waiting=new Promise(r=>{entered=r;});
 const f=await fixture(t,{onQuery:async()=>{entered();await new Promise(r=>{release=r;});}});
 const controller=new AbortController();const pending=f.client.capture({...f.input,signal:controller.signal});
 const rejected=assert.rejects(pending,e=>e.code==='LIB_READ_CANCELED');await waiting;controller.abort();await rejected;release();
 await new Promise(r=>setTimeout(r,10));assert.throws(()=>f.authority().verifyReceipt({}),/LIB_READ_STALE/);assert.equal(f.releases(),1);
});
test('host-authenticated sender, not a payload sender field, authorizes owner access',async t=>{
 const f=await fixture(t);const intruder=f.bus.api('other-plugin');
 await intruder.postPluginChannelMessage('libra','libra_gradia_unified_read_request_v1',{
   schema:'libra.gradia-unified-read.v1',kind:'request',requestId:'forged',action:'capture',sender:'serial_gradation_agents_for_rp',payload:f.input});
 assert.equal(f.queries(),0);assert.equal(f.bus.messages.filter(row=>row.body.kind==='response').length,0);
});
test('cancel by operation ID also revokes a completed selection with a late response',async t=>{
 const f=await fixture(t),r=await f.client.capture({...f.input,operationId:'late-operation'});
 await f.bus.api('serial_gradation_agents_for_rp').postPluginChannelMessage('libra','libra_gradia_unified_read_request_v1',{
  schema:'libra.gradia-unified-read.v1',kind:'request',requestId:'cancel-late',action:'release',payload:{operationId:'late-operation'}});
 await assert.rejects(()=>f.client.current({proof:f.proof(r)}),e=>e.code==='LIB_READ_STALE');
});
test('client disconnect revokes its issued receipt on the owner',async t=>{
 const f=await fixture(t),r=await f.client.capture(f.input);await f.client.dispose();
 const next=create({role:'client',api:f.bus.api('serial_gradation_agents_for_rp'),timeoutMs:1000});
 t.after(()=>next.dispose());await assert.rejects(()=>next.current({proof:f.proof(r)}),e=>e.code==='LIB_READ_STALE');
});

test('RisuAI proxy rejecting optional listener removal still revokes receipts and settles disposal',async t=>{
 const f=await fixture(t,{missingRemove:true}),r=await f.client.capture(f.input);
 await assert.doesNotReject(()=>f.client.dispose());
 const next=create({role:'client',api:f.bus.api('serial_gradation_agents_for_rp'),timeoutMs:1000});t.after(()=>next.dispose());
 await assert.rejects(()=>next.current({proof:f.proof(r)}),e=>e.code==='LIB_READ_STALE');
 assert.equal(f.releases(),1);await assert.doesNotReject(()=>f.owner.dispose());
});
test('an owner boundary changing during compiler validation cannot certify an old packet',async t=>{
 let mutate=false,f;f=await fixture(t,{onVerify:()=>{if(mutate)f.changeBoundary();}});
 const r=await f.client.capture(f.input);mutate=true;
 await assert.rejects(()=>f.client.current({proof:f.proof(r)}),e=>e.code==='LIB_READ_BOUNDARY_CHANGED');
});
test('serialized escaping and proof count against the raw response budget',async t=>{
 const f=await fixture(t,{content:'\0"\\'.repeat(30)}),r=await f.client.capture(f.input);
 assert.ok(r.rawBytes>=Buffer.byteLength(JSON.stringify(r)));
 await assert.rejects(()=>f.client.capture({...f.input,maxRawBytes:r.rawBytes-1}),e=>e.code==='LIB_READ_CORPUS_BUDGET_EXCEEDED');
 await assert.rejects(()=>f.client.capture({...f.input,maxRawBytes:'4096'}),e=>e.code==='LIB_READ_BUDGET_INVALID');
});
test('the owner seals an unsubmitted proposal as query intent and never as a fact',async t=>{
 const f=await fixture(t),proposal={schema:'gradia.input-writer-proposal.v1',purpose:'input_writer_proposal',operationId:'writer-1',
  proposalDigest:fingerprint('unsent proposal'),nativeContextDigest:fingerprint('native history'),queryTruncated:false,factAdopted:false};
 const r=await f.client.capture({...f.input,proposal});assert.equal(r.engine.purpose,'input_writer_proposal');
 assert.deepEqual(r.engine.proposal,proposal);assert.equal((await f.client.current({proof:f.proof(r)})).current,true);
 for(const bad of [{...proposal,factAdopted:true},{...proposal,proposalDigest:'invalid'},{...proposal,currentState:'caller claim'},{}])
  await assert.rejects(()=>f.client.capture({...f.input,proposal:bad}),e=>e.code==='LIB_READ_PROPOSAL_INVALID');
 assert.equal(f.queries(),1);
});

test('receipt expiry releases its private execution once even without another currentness check',async t=>{
 let clock=0;const f=await fixture(t,{now:()=>clock});await f.client.capture(f.input);assert.equal(f.releases(),0);
 clock=600001;await f.client.describe();assert.equal(f.releases(),1);await f.client.describe();assert.equal(f.releases(),1);
});
test('a response budget rejection releases the completed query authority',async t=>{
 const f=await fixture(t,{content:'x'.repeat(2048)});
 await assert.rejects(()=>f.client.capture({...f.input,maxCorpusBytes:512}),/LIB_READ_CORPUS_BUDGET_EXCEEDED/);
 assert.equal(f.releases(),1);
});

test('late cleanup of a canceled operation cannot remove a newer operation with the same ID',async t=>{
 let enteredA,enteredB,finishA,finishB,count=0;
 const readyA=new Promise(r=>{enteredA=r;}),readyB=new Promise(r=>{enteredB=r;});
 const f=await fixture(t,{onQuery:async()=>{
   if(++count===1){enteredA();await new Promise(r=>{finishA=r;});}
   else{enteredB();await new Promise(r=>{finishB=r;});}
 }});
 const a=new AbortController(),b=new AbortController(),operationId='reused-operation';
 const first=f.client.capture({...f.input,operationId,signal:a.signal});
 const rejectedA=assert.rejects(first,e=>e.code==='LIB_READ_CANCELED');
 await readyA;a.abort();await rejectedA;
 const second=f.client.capture({...f.input,operationId,signal:b.signal});
 const rejectedB=assert.rejects(second,e=>e.code==='LIB_READ_CANCELED');
 await readyB;finishA();await new Promise(r=>setTimeout(r,10));
 assert.equal(f.releases(),1);
 b.abort();await rejectedB;finishB();await new Promise(r=>setTimeout(r,10));
 assert.equal(f.releases(),2,'the newer canceled query must also release its execution');
 assert.throws(()=>f.authority().verifyReceipt({}),/LIB_READ_STALE/);
});
