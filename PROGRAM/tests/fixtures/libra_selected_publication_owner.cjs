'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./libra_unified_runtime_fixture.cjs');
const query=[{role:'user',content:'민아의 은빛 열쇠를 누가 반환했나요?'}];
async function verifyPublicationOwner(phase='boundary'){
 let f,armed=false,hit=false,newerDiagnostics,newerRecall;
 const before="        if(responseBoundary)await assertUnifiedResponseBoundary(responseBoundary);\n\n        const responseContext=";
 const after="        if(responseBoundary)await assertUnifiedResponseBoundary(responseBoundary);\n        if (requestOwner !== latestRecallPublicationOwner) return messages;\n\n        const responseContext=";
 f=await fixture({transformSource:source=>{
  if(phase==='recall'){const seam='      consumedClosureProofsByResult.set(result, mergeConsumedProofs(recallClosureProofs));';assert.equal(source.split(seam).length,2);return source.replace(seam,seam+'\n      globalThis.risuai.armPublicationBoundary();\n      await globalThis.risuai.publicationBoundaryObserved();');}
  const needle=source.includes(after)?after:before;assert.equal(source.split(needle).length,2);
  source=source.replace(needle,'        globalThis.risuai.armPublicationBoundary();\n'+needle);
  // Await only an observation after the actual boundary capture, before its
  // existing assertion resolves. It creates no proof or replacement decision.
  const current="        unifiedAssert(digest(current)===digest(boundary),'UNIFIED_RESPONSE_AUTHORITY_CHANGED');return true;";
  const old="      unifiedAssert(digest(current)===digest(boundary),'UNIFIED_RESPONSE_AUTHORITY_CHANGED');return true;";
  const target=source.includes(current)?current:old;assert.equal(source.split(target).length,2);
  return source.replace(target,'        await globalThis.risuai.publicationBoundaryObserved();\n'+target);
 },host:{armPublicationBoundary:()=>{if(armed)hit=true;},publicationBoundaryObserved:async()=>{if(!armed||!hit)return;armed=false;const newer=await f.control.hooks.beforeRequest([{role:'user',content:query[0].content+' 새 요청'}],'model');assert.ok(JSON.stringify(newer).includes('[LIBRA CLASSIC RECALL'));newerDiagnostics=JSON.stringify(f.r.api.getLastMemoryRecallViewer());newerRecall=JSON.stringify(f.r.api.getRuntime().lastMemoryRecall);}}});
 try{
  await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();
  armed=true;const output=await f.control.hooks.beforeRequest(query,'model');
  assert.equal(hit,true);assert.ok(!JSON.stringify(output).includes('[LIBRA CLASSIC RECALL'));
  assert.equal(JSON.stringify(f.r.api.getLastMemoryRecallViewer()),newerDiagnostics,'superseded boundary continuation preserves newer delivery diagnostics');
  assert.equal(JSON.stringify(f.r.api.getRuntime().lastMemoryRecall),newerRecall,'superseded recall continuation preserves newer recall snapshot');
  return phase==='boundary'?{boundary:await verifyPublicationOwner('recall'),newerRequestPositive:true,supersededPublicationSuppressed:true}:{recallPublicationSuppressed:true};
 }finally{await f.r.cleanup();}
}
module.exports={verifyPublicationOwner};
if(require.main===module)verifyPublicationOwner().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
