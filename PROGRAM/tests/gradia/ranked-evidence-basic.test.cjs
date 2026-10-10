'use strict';
// Component mechanics with a fake size-admitting owner. Not end-to-end authority,
// real native-host admission, production qualification or a widened search test.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function factory(file,name){const full=path.join(root,file);assert.ok(fs.existsSync(full),`${name} component exists`);return Function(fs.readFileSync(full,'utf8')+`;return ${name};`)();}
function components(){
 const protocol=factory('sdk/gradia/GradiaReadV2Protocol.source.js','createGradiaReadV2Protocol')({sha256:sha});
 const creditFactory=factory('sdk/gradia/GradiaReadV2Credit.source.js','createGradiaReadV2Credit');
 const frames=factory('sdk/gradia/GradiaReadV2Frames.source.js','createGradiaReadV2Frames')({protocol,sha256:sha});
 const render=factory('sdk/GradiaEvidenceRender.v2.source.js','createGradiaEvidenceRender')({protocol});
 const budget=factory('sdk/GradiaEvidenceBudget.source.js','createGradiaEvidenceBudget')({digest:sha});
 return {protocol,creditFactory,frames,render,budget,digest:sha};
}
const item=(n,content,groupId=null)=>Object.freeze({itemId:'item-'+n,profile:'libra.canonical.memory-text.v1',sourceHandle:'source-'+n,groupId,content,contentHash:sha(content),contentBytes:Buffer.byteLength(content)});
const rank=(i,relevance=1,forced=false)=>Object.freeze({itemId:i.itemId,relevance,forced,exactScore:0,sparseEvidence:0});
const policy=()=>Object.freeze({schema:'libra.recall-mmr.v2',candidateLimit:80,mmrEnabled:true,mmrLambda:.7});
const identity=()=>Object.freeze({corpusId:'corpus-1',requestId:'request-1',issuerId:'fake-owner-1',manifestHash:sha('manifest')});
function matrix(items){return Object.freeze(items.map((_,i)=>Object.freeze(items.map((_,j)=>i===j?1:0))));}
const MODEL='gpt-4o-mini-2024-07-18',ROUTE='https://api.openai.com/v1/chat/completions';
function stage(phase='first',limit=128000){const baseBody=JSON.stringify({model:MODEL,messages:[{role:'system',content:'Native system'},{role:'user',content:'Native input '+phase}],temperature:.5,stream:false,max_tokens:1000});return {stage:'shadow_act',phase,providerId:'openai',modelId:MODEL,routeIdentity:ROUTE,requestFormat:'chat_completions',context:{source:'configured',limit,sourceIdentity:'preset:fixture',providerId:'openai',modelId:MODEL,routeIdentity:ROUTE},baseBody};}
test('shared renderer preserves complete Unicode/control items and exact escaped-byte accounting',()=>{
 const c=components(),items=Object.freeze([item(1,'Full 한글😀 e\u0301\n\u0000 <>&{}[]\u2028\u2029 " \\ END')]);
 const measure=c.render.measure({corpusId:'c',items,selectedItemIds:['item-1'],byteLimit:262144});
 const output=c.render.render({corpusId:'c',items,selectedItemIds:['item-1'],byteLimit:262144});
 assert.equal(Buffer.byteLength(output.text),measure.utf8Bytes);assert.equal(output.text.length*2,measure.utf16Bytes);
 assert.equal(output.utf8Bytes,measure.utf8Bytes);assert.equal(output.items,1);assert.match(output.text,/\\ud83d|😀/);
 assert.ok(!output.text.includes('<>&'));assert.ok(output.text.includes('Full 한글😀'));
 assert.throws(()=>c.render.render({corpusId:'c',items,selectedItemIds:['item-1'],byteLimit:measure.utf8Bytes-1}),/RENDERED_BYTES/);
 assert.throws(()=>c.render.measure({corpusId:'c',items:[item(2,'\ud800')],selectedItemIds:['item-2'],byteLimit:262144}),/UNSUPPORTED_TEXT/);
});
test('shared MMR keeps owner similarity, duplicate penalty, forced exception and score floor',()=>{
 const c=components(),items=Object.freeze([item(0,'one'),item(1,'duplicate'),item(2,'diverse'),item(3,'forced')]);
 const rankings=Object.freeze([rank(items[0],1),rank(items[1],.99),rank(items[2],.6),rank(items[3],.1,true)]);
 const similarities=Object.freeze([[1,1,0,0],[1,1,0,0],[0,0,1,0],[0,0,0,1]].map(Object.freeze));
 const chosen=c.render.rank({items,ranking:rankings,similarities,policy:policy(),countLimit:80});
 assert.deepEqual(chosen.selectedItemIds,['item-0','item-2','item-3']);
 assert.deepEqual(chosen.omissions,[{itemId:'item-1',reason:'mmr_score_floor'}]);
 assert.deepEqual(items.map(x=>x.content),['one','duplicate','diverse','forced']);
});
test('bounded fake-owner hydration reads over 48 full records and charges rejected narrative bytes',async()=>{
 const c=components(),limits=c.protocol.validateLimits({}),credit=c.creditFactory({maxManagedBytes:limits.managedBytes,maxPhysicalReads:limits.physicalReads});
 const rows=Array.from({length:60},(_,i)=>Object.freeze({key:'key-'+i}));const reads=[],inspections=[];
 const producer=factory('sdk/gradia/LibraGradiaRankedProducer.source.js','createLibraGradiaRankedProducer')({...c,credit});
 const result=await producer.capture({limits,frontier:Object.freeze(rows),owner:{
  async assertCurrent(){return true;},async inspect(ref){inspections.push(ref.key);return Object.freeze({narrativeBytes:200,serializedBytes:300,proofBytes:40,contentHash:sha('x'.repeat(200)),profile:'libra.canonical.memory-text.v1',sourceHandle:ref.key,groupId:null});},
  async materialize(ref){reads.push(ref.key);const i=Number(ref.key.slice(4));return {itemId:'item-'+i,content:'x'.repeat(200),row:{id:'item-'+i,eligible:i!==2}};},
  async scoreRows(hydrated){return hydrated.filter(row=>row.eligible).map(row=>({...row,relevance:.8,forced:false,exactScore:.5,sparseEvidence:.4}));},similarity(a,b){return a.id===b.id?1:0;}
 }});
 assert.equal(reads.length,60);assert.equal(inspections.length,60);assert.equal(result.items.length,59);assert.equal(result.coverage.hydratedNarrativeBytes,12000);assert.equal(result.coverage.returnedEligibleBytes,11800);assert.equal(result.coverage.frontierExhausted,true);assert.equal(result.coverage.visitedCount,60);assert.equal(result.coverage.stopReason,'frontier_exhausted');assert.equal(result.items[58].content.length,200);assert.equal(result.authorityQualified,false);assert.ok(Object.isFrozen(result.items));assert.equal(await result.assertCurrent(),true);result.release();assert.equal(credit.snapshot().managedBytes,0);
});
test('owner size admission stops before fetching an unfit item and reports unread prefix',async()=>{
 const c=components(),limits=c.protocol.validateLimits({contentBytes:500,items:10}),credit=c.creditFactory({maxManagedBytes:limits.managedBytes,maxPhysicalReads:4});let reads=0;
 const producer=factory('sdk/gradia/LibraGradiaRankedProducer.source.js','createLibraGradiaRankedProducer')({...c,credit});
 const result=await producer.capture({limits,frontier:Object.freeze([{key:'a'},{key:'b'},{key:'c'}].map(Object.freeze)),owner:{async assertCurrent(){return true;},async inspect(ref){return {narrativeBytes:300,serializedBytes:400,proofBytes:40,contentHash:sha('a'.repeat(300)),profile:'libra.canonical.memory-text.v1',sourceHandle:ref.key,groupId:null};},async materialize(ref){reads++;return {itemId:ref.key,content:'a'.repeat(300),row:{id:ref.key}};},async scoreRows(rows){return rows.map(x=>({...x,relevance:1,forced:false,exactScore:1,sparseEvidence:1}));},similarity(){return 0;}}});
 assert.equal(reads,1);assert.equal(result.coverage.visitedCount,1);assert.equal(result.coverage.scannedMetadataCount,2);assert.equal(result.coverage.frontierExhausted,false);assert.equal(result.coverage.stopReason,'content_limit');assert.equal(result.coverage.unreadFrontier.firstKey,'b');assert.equal(result.coverage.unreadFrontier.count,2);result.release();
});
test('verified corpus selection budgets each payload, binds owner receipts and retains all consumed stages',async()=>{
 const c=components(),items=Object.freeze([item(0,'A'.repeat(3000)),item(1,'B'.repeat(3000)),item(2,'C'.repeat(3000))]);
 const binds=[],asserted=[],identityValue=identity();
 const owner={async assertCorpusCurrent(){return true;},async bindSelection(proposal){
  const local=c.render.render({corpusId:identityValue.corpusId,items,selectedItemIds:proposal.selectedItemIds,byteLimit:262144});assert.equal(sha(local.text),proposal.renderedEvidenceHash);binds.push(proposal);
  return Object.freeze({schema:'gradia.model-evidence-selection.v2',corpusId:proposal.corpusId,requestId:proposal.requestId,stage:proposal.stage,phase:proposal.phase,selectionHash:proposal.selectionHash,receiptHandle:'receipt-'+binds.length});},async assertSelectionCurrent(receipt){asserted.push(receipt.receiptHandle);return true;}};
 const consumer=factory('sdk/gradia/GradiaEvidenceSelection.source.js','createGradiaEvidenceSelection')(c);
 const session=await consumer.openVerifiedCorpus({identity:identityValue,items,ranking:Object.freeze(items.map(x=>rank(x))),similarities:matrix(items),policy:policy(),readLimits:{},owner});
 const first=await session.selectStage(stage('first'));assert.equal(first.selectedItemIds.length,3);await session.assertDispatch(first.handle,{providerId:'openai',modelId:MODEL,routeIdentity:ROUTE,requestFormat:'chat_completions',method:'POST',body:first.body});
 const second=await session.selectStage(stage('second',6000));assert.equal(second.selectedItemIds.length,1);assert.equal(second.omissions.length,2);assert.equal(second.omissions[0].reason,'model_context_budget');await session.assertDispatch(second.handle,{providerId:'openai',modelId:MODEL,routeIdentity:ROUTE,requestFormat:'chat_completions',method:'POST',body:second.body});
 const finalized=await session.assertConsumedCurrent();assert.equal(finalized.consumedSelections,2);assert.ok(asserted.includes('receipt-1')&&asserted.includes('receipt-2'));assert.equal(binds.length,2);session.close();assert.equal(session.creditSnapshot().managedBytes,0);
});
test('semantic groups are all-or-nothing and unsupported payload cannot authorize dispatch',async()=>{
 const c=components(),items=Object.freeze([item(0,'A'.repeat(2500),'item-2'),item(1,'B'.repeat(2500),'item-2'),item(2,'C'.repeat(200))]);
 const consumer=factory('sdk/gradia/GradiaEvidenceSelection.source.js','createGradiaEvidenceSelection')(c);let bound=0;
 const owner={async assertCorpusCurrent(){return true;},async bindSelection(p){bound++;return Object.freeze({schema:'gradia.model-evidence-selection.v2',corpusId:p.corpusId,requestId:p.requestId,stage:p.stage,phase:p.phase,selectionHash:p.selectionHash,receiptHandle:'r'+bound});},async assertSelectionCurrent(){return true;}};
 const session=await consumer.openVerifiedCorpus({identity:identity(),items,ranking:Object.freeze(items.map(x=>rank(x))),similarities:matrix(items),policy:policy(),readLimits:{},owner});
 const result=await session.selectStage(stage('small',5000));assert.deepEqual(result.selectedItemIds,['item-2']);assert.deepEqual(result.omissions.map(x=>x.itemId),['item-0','item-1']);
 const unsupported=await session.selectStage({...stage('unknown'),modelId:'unknown'});assert.equal(unsupported.status,'unavailable');assert.equal(bound,1);session.close();
});
test('owner binder recomputes the pinned render and binds immutable selection receipts',async()=>{
 const c=components(),limits=c.protocol.validateLimits({}),credit=c.creditFactory({maxManagedBytes:limits.managedBytes,maxPhysicalReads:4});
 const producer=factory('sdk/gradia/LibraGradiaRankedProducer.source.js','createLibraGradiaRankedProducer')({...c,credit});
 const items=Object.freeze([item(0,'complete owner evidence')]),corpus=Object.freeze({items,ranking:Object.freeze(items.map(x=>rank(x))),similarities:matrix(items),policy:policy(),async assertCurrent(){return true;}});
 const owner=producer.createSelectionBinder({corpus,identity:identity(),renderedByteLimit:limits.renderedBytes});
 const session=await factory('sdk/gradia/GradiaEvidenceSelection.source.js','createGradiaEvidenceSelection')(c).openVerifiedCorpus({identity:identity(),...corpus,owner});
 const result=await session.selectStage(stage());assert.equal(result.status,'available');await session.assertDispatch(result.handle,{providerId:'openai',modelId:MODEL,routeIdentity:ROUTE,requestFormat:'chat_completions',method:'POST',body:result.body});
 assert.equal((await session.assertConsumedCurrent()).consumedSelections,1);session.close();
});
test('an entirely omitted model selection binds an empty evidence hash without partial source text',async()=>{
 const c=components(),limits=c.protocol.validateLimits({}),credit=c.creditFactory({maxManagedBytes:limits.managedBytes,maxPhysicalReads:4});
 const producer=factory('sdk/gradia/LibraGradiaRankedProducer.source.js','createLibraGradiaRankedProducer')({...c,credit});
 const items=Object.freeze([item(0,'A'.repeat(8000))]),corpus=Object.freeze({items,ranking:Object.freeze(items.map(x=>rank(x))),similarities:matrix(items),policy:policy(),async assertCurrent(){return true;}});
 const owner=producer.createSelectionBinder({corpus,identity:identity(),renderedByteLimit:limits.renderedBytes});
 const session=await factory('sdk/gradia/GradiaEvidenceSelection.source.js','createGradiaEvidenceSelection')(c).openVerifiedCorpus({identity:identity(),...corpus,owner});
 const input=stage('empty',4000),result=await session.selectStage(input);assert.equal(result.status,'available');assert.equal(result.evidence,'');assert.equal(result.body,input.baseBody);assert.deepEqual(result.selectedItemIds,[]);assert.equal(result.omissions[0].reason,'model_context_budget');session.close();
});
test('closing a selection retains its declared credit until an unfinished owner bind settles',async()=>{
 const c=components(),items=Object.freeze([item(0,'complete evidence')]);let releaseBind,entered;const started=new Promise(resolve=>{entered=resolve;});
 const owner={async assertCorpusCurrent(){return true;},async bindSelection(p){entered();await new Promise(resolve=>{releaseBind=resolve;});return Object.freeze({schema:p.schema,corpusId:p.corpusId,requestId:p.requestId,stage:p.stage,phase:p.phase,selectionHash:p.selectionHash,receiptHandle:'pending'});},async assertSelectionCurrent(){return true;}};
 const session=await factory('sdk/gradia/GradiaEvidenceSelection.source.js','createGradiaEvidenceSelection')(c).openVerifiedCorpus({identity:identity(),items,ranking:Object.freeze(items.map(x=>rank(x))),similarities:matrix(items),policy:policy(),owner});
 const pending=session.selectStage(stage());await started;await assert.rejects(session.selectStage(stage()),/STAGE_REUSE_OR_LIMIT/);session.close();assert.ok(session.creditSnapshot().managedBytes>0);releaseBind();await assert.rejects(pending,/CORPUS_CHANGED|CLOSED/);assert.equal(session.creditSnapshot().managedBytes,0);
});
