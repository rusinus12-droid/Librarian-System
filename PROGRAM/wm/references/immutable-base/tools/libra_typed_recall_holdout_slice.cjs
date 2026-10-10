'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {session}=require('./libra_typed_recall_live_adapter.cjs'),{records}=require('./libra_typed_recall_pilot.cjs'),{score,sha}=require('./libra_typed_recall_benchmark.cjs');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
async function run(pilotRoot,outRoot){
 if(fs.existsSync(outRoot))throw Error('fresh_run_directory_required');fs.mkdirSync(outRoot,{recursive:true});
 const manifest=read(path.join(pilotRoot,'manifest.json')),transport=read(path.join(pilotRoot,'transport-raw.json')),documents=read(path.join(pilotRoot,'pilot-documents.json'));
 const provider=manifest.provider,policy=manifest.policy,corpus=read(path.join(__dirname,'fixtures/typed-recall-measurement-corpus-v2.json')),datasetPath=path.join(__dirname,'fixtures/typed-recall-measurement-v2.json'),dataset=read(datasetPath);
 assert.equal(sha(fs.readFileSync(datasetPath)),manifest.hashes[path.relative(path.resolve(__dirname,'..'),datasetPath)]);
 const budget={maxCalls:6,maxInputBytes:32768,maxInputTokens:8192,concurrency:1},caseIds=['ferry_permit-memory-en','ferry_permit-entity-ja','ferry_permit-world-zh','ferry_permit-narrative-en','negative-ja-2','negative-zh-0'];
 const shared={store:new Map(),cache:new Map()},options={provider,policy,corpus,budget,live:true,shared,authorization:{gpuSlotReturned:true,allowLocalCalls:true,modelVerified:true,modelDigest:provider.modelRevision}};
 const current=await fetch('http://127.0.0.1:11434/api/tags').then(r=>r.json());assert.equal(current.models.find(m=>m.name===provider.model)?.digest,provider.modelRevision);
 const save=(n,v)=>fs.writeFileSync(path.join(outRoot,n),JSON.stringify(v,null,2)),source={provider,documents:documents.documents,calls:transport.calls};
 let s=await session(options);save('captured-row-reconstruction.json',await s.importCapturedDocuments(source));save('storage-snapshot.json',[...shared.store]);await s.close();
 // Independent VM/storage facade reload; only fixture backing Map is shared.
 s=await session({...options,shared:{store:shared.store,cache:new Map()}});const reloaded=await s.readiness();assert.equal(reloaded.valid,4);save('reload.json',{newInstance:true,coverage:reloaded,evidence:'synthetic storage facade reload; no actual Risu disk/readback proof',newModelCalls:0});
 const outputs=[],stats=[];
 try{save('manifest.json',{startedAt:new Date().toISOString(),provider,policy,budget,caseIds,oracleSha256:sha(fs.readFileSync(datasetPath)),modelDigest:provider.modelRevision,pilotManifestSha256:sha(fs.readFileSync(path.join(pilotRoot,'manifest.json'))),productionEligible:false,qualityVerdict:'partial_unfrozen_host_unavailable',holdoutQueriesUsedForTuning:false});
  for(const caseId of caseIds){const c=dataset.cases.find(c=>c.id===caseId);assert.equal(c.split,'holdout');const out=await s.beforeRequest(c.query,{caseId,mode:'dual',injectionMode:outputs.length%2?'hybrid':'direct'});out.split=c.split;out.coverage=await s.readiness();outputs.push(out);save('beforeRequest-raw.json',outputs);save('transport-raw.json',s.capture);console.log(JSON.stringify({caseId,ms:out.elapsedMs,semantic:out.trace?.retrieval?.trace?.lanes?.semantic?.returned}));}
  const captured=outputs.map(records);save('oracle-records.json',captured);const scores=score(dataset,captured);save('holdout-score.json',scores);
  // Read-only rank diagnostic. No threshold/policy is changed using these queries.
  const docs=transport.calls.filter(c=>c.role==='document').map(c=>({inputSha256:c.inputSha256,vector:JSON.parse(c.response).embeddings[0]}));
  const cosine=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0)/Math.sqrt(a.reduce((n,x)=>n+x*x,0)*b.reduce((n,x)=>n+x*x,0));
  save('cosine-diagnostic.json',s.capture.calls.map(c=>({inputSha256:c.inputSha256,error:c.error||null,scores:c.response?docs.map(d=>({documentSha256:d.inputSha256,cosine:cosine(JSON.parse(c.response).embeddings[0],d.vector)})):null})));
  const summary={holdoutSliceCompleted:true,fullMeasurementCompleted:false,qualityVerdict:'not_accepted_partial_index_unfrozen_policy_host_unavailable',productionEligible:false,
   modelCalls:s.capture.calls.length,documentCalls:0,queryCalls:s.capture.calls.length,active:s.capture.active,uncertain:s.capture.calls.filter(c=>c.uncertain).length,
   coreLost:scores.cases.reduce((n,c)=>n+c.protectedCoreLost,0),canaryLeaks:outputs.filter(o=>dataset.forbidden.some(c=>JSON.stringify([o.output,o.projectionEntries]).includes(c))).map(o=>o.caseId),
   packed:scores.cases.map(c=>({caseId:c.caseId,gold:c.stages.packing.gold,hits:c.stages.packing.hits,returned:c.stages.packing.returned,abstained:c.stages.packing.abstained})),coverage:await s.readiness(),storage:s.storage(),oracleUnchanged:sha(fs.readFileSync(datasetPath))===manifest.hashes[path.relative(path.resolve(__dirname,'..'),datasetPath)],host:'unavailable'};
  save('summary.json',summary);assert.equal(summary.active,0);assert.equal(summary.canaryLeaks.length,0);assert.equal(summary.coreLost,0);
  // Representative matched-input legacy/shadow comparison uses the captured real
  // query vector, with NO extra endpoint call. It is explicitly replay evidence.
  const c=dataset.cases.find(c=>c.id===caseIds[0]),call=s.capture.calls[0];
  if(!call.response){save('legacy-shadow-replay.json',{status:'unavailable',reason:'actual holdout query timed out without a captured vector',newEndpointCalls:0});return summary;}
  const vectorSender=async(_url,init)=>{assert.equal(sha(JSON.parse(init.body).input),call.inputSha256);return{ok:true,status:200,text:async()=>call.response};};
  const replayOptions={provider,policy,corpus,budget,live:false,sender:vectorSender,shared:{store:shared.store,cache:new Map()}},baseline=await session(replayOptions),shadow=await session(replayOptions);
  try{const a=await baseline.beforeRequest(c.query,{mode:'legacy',caseId:c.id,injectionMode:'direct'}),b=await shadow.beforeRequest(c.query,{mode:'shadow',caseId:c.id,injectionMode:'direct'});assert.equal(JSON.stringify(b.output),JSON.stringify(a.output));save('legacy-shadow-replay.json',{legacy:a,shadow:b,byteIdentical:true,newEndpointCalls:0,modelEvidence:'exact input-SHA matched captured actual query vector replay; not live shadow transport',legacyCalls:baseline.capture.calls.length,shadowReplayCalls:shadow.capture.calls.length});}finally{await baseline.close();await shadow.close();}
  return summary;
 }finally{save('transport-raw.json',s.capture);await s.close();}
}
const arg=n=>{const i=process.argv.indexOf('--'+n);return i<0?null:process.argv[i+1];};
if(require.main===module){if(!arg('pilot-root')||!arg('out-root'))process.exit(1);run(path.resolve(arg('pilot-root')),path.resolve(arg('out-root'))).then(x=>{console.log(JSON.stringify(x));process.exit(0);}).catch(e=>{console.error(e.stack);process.exit(1)});}module.exports={run};
