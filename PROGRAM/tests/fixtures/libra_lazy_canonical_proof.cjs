'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./libra_unified_runtime_fixture.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const transform=source=>{
 const digest='    const canonicalConsumptionDigest = memory => {';
 assert.equal(source.split(digest).length,2);
 source=source.replace(digest,digest+'\n      globalThis.__LAZY_BODY_DIGEST_CALLS__=(globalThis.__LAZY_BODY_DIGEST_CALLS__||0)+1;');
 const proof=source.includes('const getConsumedCanonicalProof =')?'getConsumedCanonicalProof(memory)':'consumedCanonicalProofsByMemory.get(memory)';
 const seam='    const removeMemoryRecord = async ref => {';assert.equal(source.split(seam).length,2);
 return source.replace(seam,`    globalThis.__LAZY_BODY_TEST__={loadMemoryRef,digest:canonicalConsumptionDigest,get:memory=>${proof},inspect:memory=>{const entry=consumedCanonicalProofsByMemory.get(memory);return {snapshotChars:entry?.bodySnapshot?.length||0,proofCached:entry?.kind==='canonical-memory'};},register:registerConsumedDataReadSet,assertCurrent:assertConsumedDataCurrent,context:resolveContext};\n${seam}`);
};
async function verifyLazyCanonicalProof(){
 const f=await fixture({transformSource:transform});
 try{
  assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();
  const api=f.r.context.__LAZY_BODY_TEST__,ref=clone(f.getManifest().memories['1']),physical=clone(f.getMemory());
  f.r.context.__LAZY_BODY_DIGEST_CALLS__=0;
  const loaded=[];for(let index=0;index<30;index++)loaded.push(await api.loadMemoryRef(ref));
  assert.equal(f.r.context.__LAZY_BODY_DIGEST_CALLS__,0,'non-consuming canonical loads must capture physical snapshots without expensive stable body digests');
  assert.ok(loaded.every(memory=>api.inspect(memory).snapshotChars>0),'every live loaded memory has a private initial snapshot');
  const initialDigest=api.digest(physical),memory=loaded[0];
  memory.sourceDigest='returned-object-mutated-before-consumption';memory.canonicalArtifact.facts[0].text='untrusted mutable return';
  const proof=api.get(memory);assert.equal(proof.recordKey,ref.key);assert.equal(proof.recordDigest,initialDigest,'lazy proof comes from initial physical bytes, never mutated returned memory');
  assert.equal(api.inspect(memory).snapshotChars,0,'promoted proof drops its raw snapshot');assert.equal(api.inspect(memory).proofCached,true);assert.ok(Object.isFrozen(proof));
  const calls=f.r.context.__LAZY_BODY_DIGEST_CALLS__;assert.equal(api.get(memory),proof);assert.equal(f.r.context.__LAZY_BODY_DIGEST_CALLS__,calls,'promoted immutable proof digest is computed once');
  const context=await api.context(),token=api.register(context.scope,[proof],null);assert.equal(await api.assertCurrent(token),true,'unchanged physical source remains current despite mutable loader return');
  const changed=clone(physical);changed.canonicalArtifact.facts[0].text='actual physical body changed';f.r.values.set(ref.key,JSON.stringify(changed));
  await assert.rejects(()=>api.assertCurrent(token),error=>error.code==='CONSUMER_CANONICAL_BODY_CHANGED','same final physical read refuses a changed durable body');f.r.values.set(ref.key,JSON.stringify(physical));
  const probes=[{z:null,a:[null,true,false,0,-0,1.25,'열쇠','é',{'10':'ten','2':'two',z:null,a:'first'}]}, {a:[{'b':2,'a':1},[],{}],embedding:{ignored:'top-level'},nested:{embedding:{retained:true}}}];
  for(const parityProbe of probes){const body={...clone(physical),parityProbe};f.r.values.set(ref.key,JSON.stringify(body));const value=await api.loadMemoryRef(ref),captured=api.get(value);assert.equal(captured.recordDigest,api.digest(body),'native snapshot preserves existing digest format for parsed JSON types/key order');const reordered=Object.fromEntries(Object.entries(body).reverse());assert.equal(api.digest(reordered),captured.recordDigest,'physical object-key order remains semantically irrelevant');}
  f.r.values.set(ref.key,JSON.stringify(physical));
  // Actual public export/import creates a physically shared predecessor body.
  const portable=f.r.context.__LIBRAPortableMemoryBackup,envelope=await portable.exportCurrentScope(),target={id:'lazy-proof-archive-target',chatId:'lazy-proof-archive-target',name:'Lazy proof target',message:[]};target.messages=target.message;
  f.character.chats.push(target);f.character.chatPage=1;const host=f.r.context.risuai;host.getCurrentChatIndex=async()=>1;host.getChatFromIndex=async(_char,index)=>f.character.chats[index];host.getChat=async()=>target;host.getCurrentChat=async()=>target;
  assert.equal((await portable.importAsPredecessorArchive(envelope)).ok,true);
  const packet=await f.r.api.getResponseContext({currentInput:'민아의 은빛 열쇠'}),archiveRef=packet.canonicalRefs.find(row=>row.inherited);assert.ok(archiveRef);
  const archivePhysical=JSON.parse(f.r.values.get(archiveRef.key)),archiveMemory=await api.loadMemoryRef({...archiveRef,archiveShared:true,sessionEpoch:-7});assert.equal(archiveMemory.sessionEpoch,-7);assert.notDeepEqual(archiveMemory,archivePhysical);
  archiveMemory.canonicalArtifact.facts[0].text='mutated archive overlay';assert.equal(api.get(archiveMemory).recordDigest,api.digest(archivePhysical),'archive proof captures physical body before session overlay and caller mutation');
  return {unconsumedLoads:30,loadDigests:0,promotedSnapshotDropped:true,cachedOnce:true,mutableReturnCannotRebaseProof:true,physicalMutationRefused:true,JSONDigestParity:true,realArchiveOverlayProof:true,retainedUnconsumedSnapshotChars:loaded.slice(1).reduce((sum,row)=>sum+api.inspect(row).snapshotChars,0)};
 }finally{await f.r.cleanup();}
}
module.exports={verifyLazyCanonicalProof};
if(require.main===module)verifyLazyCanonicalProof().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
