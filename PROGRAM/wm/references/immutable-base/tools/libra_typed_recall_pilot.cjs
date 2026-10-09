'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {session}=require('./libra_typed_recall_live_adapter.cjs'),{score,sha}=require('./libra_typed_recall_benchmark.cjs');
const root=path.resolve(__dirname,'..'),prep=path.join(root,'test-output/typed-recall/task6-preparation');
const json=p=>JSON.parse(fs.readFileSync(p,'utf8')),copy=x=>JSON.parse(JSON.stringify(x));
function records(out){
 const all=out.stages?.all||[],byId=new Map(all.map(u=>[u.identity,u]));
 const item=(id,text)=>{const u=byId.get(id);if(!u)throw Error('missing_canonical_stage_identity');return{family:u.family,subtype:u.subtype,id:String(u.locator.id),roles:u.roles,sourceRefs:u.sourceRefs,text:text||u.text};};
 const uniq=rows=>[...new Set(rows.map(r=>r.identity))].map(id=>item(id));
 const trace=out.trace?.retrieval?.trace||{},blocks=out.trace?.consumer?.trace?.blocks||[];
 const direct=out.trace?.consumer?.directBlocks||[],messageText=(out.output?.messages||[]).map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
 const directMissing=direct.filter(b=>!messageText.includes(b.text)).map(b=>b.identity),projectionRequired=(out.trace?.consumer?.projectionEntries||[]).length>0;
 const projectionMissing=projectionRequired?direct.filter(b=>!out.projectionEntries.some(e=>e.content===b.text)).map(b=>b.identity):[];
 const emitted=direct.filter(b=>!directMissing.includes(b.identity)&&!projectionMissing.includes(b.identity));
 const packed=emitted.filter(b=>b.kind==='recall').map(b=>item(b.identity,b.text));
 return{caseId:out.caseId,stages:{candidate:uniq([...(out.stages?.heuristic?.hits||[]),...(out.stages?.semantic?.hits||[])]),fusion:uniq(trace.fused||[]),diversity:uniq(trace.diversity?.steps||[]),packing:packed},
  baseline:{expected:['world','narrative'],present:emitted.filter(b=>b.kind==='baseline').map(b=>b.identity)},
  outputAudit:{directMissing,projectionMissing,projectionEvidence:'exact local setLorebook argument; actual host unavailable'},
  labels:{host:'synthetic_vm',hostConsumption:'unavailable',model:'actual_local_endpoint',index:'partial',policy:'unfrozen_fixture',split:out.split},
  transport:{queryCalls:out.calls.filter(c=>c.role==='query').length,documentCalls:out.calls.filter(c=>c.role==='document').length},latency:{beforeRequestMs:out.elapsedMs},coverage:out.coverage};
}
async function run({outRoot,policyPath,holdout=false}){
 if(fs.existsSync(outRoot))throw Error('fresh_run_directory_required');fs.mkdirSync(outRoot,{recursive:true});
 const checks=json(path.join(prep,'scoped-rmm-preflight-exit.json'));assert.equal(checks.exit,0);
 const raw=json(path.join(prep,'scoped-rmm-preflight-raw.json')),show=JSON.parse(raw.find(c=>c.endpoint==='/api/show').raw),vectors=JSON.parse(raw.find(c=>c.endpoint==='/api/embed').raw).embeddings;
 assert.equal(vectors[0].length,4096);assert.ok(show.capabilities?.includes('embedding'));
 const tag=json(path.join(prep,'ollama-tags.json')).models.find(m=>m.name==='qwen3-embedding:8b');
 const current=await fetch('http://127.0.0.1:11434/api/tags').then(r=>r.json());assert.equal(current.models.find(m=>m.name===tag.name)?.digest,tag.digest);
 const provider={spaceFingerprint:sha(JSON.stringify([tag.digest,4096,'input','input',{truncate:false}])),provider:'ollama',model:tag.name,modelRevision:tag.digest,endpoint:'http://127.0.0.1:11434/api/embed',dimension:4096,queryMode:'input',documentMode:'input',options:{truncate:false}};
 const datasetPath=path.join(__dirname,'fixtures/typed-recall-measurement-v2.json'),corpusPath=path.join(__dirname,'fixtures/typed-recall-measurement-corpus-v2.json');
 const dataset=json(datasetPath),corpus=json(corpusPath),policy=json(policyPath),budget={maxCalls:holdout?12:8,maxInputBytes:holdout?49152:32768,maxInputTokens:holdout?12288:8192,concurrency:1};
 assert.equal(policy.mode,'fixture');assert.equal(policy.productionEligible,false);
 const pilotIds=['ferry_permit-memory-ko','ferry_permit-entity-ko','ferry_permit-world-ko','ferry_permit-narrative-ko'];
 const holdoutIds=['reactor_reset-memory-ko','treaty_seal-entity-en','shrine_bell-world-zh','reactor_reset-narrative-ja'];
 const manifest={schema:'libra.typed-recall.actual-pilot.v1',startedAt:new Date().toISOString(),provider,policy,budget,pilotIds,holdoutIds:holdout?holdoutIds:[],productionEligible:false,qualityVerdict:'incomplete',
  hashes:Object.fromEntries([datasetPath,corpusPath,policyPath,path.join(root,'dist/LIBRA World Manager Full.js'),__filename,path.join(__dirname,'libra_typed_recall_live_adapter.cjs')].map(p=>[path.relative(root,p),sha(fs.readFileSync(p))])),
  fingerprints:json(path.join(prep,'runtime-workspace-fingerprint.json')),
  evidence:{host:'synthetic_vm; actual Risu host unavailable',model:'authorized local endpoint; endpoint digest reported, not authenticated',documents:'actual product immutable document transport and strict v3 publish, manual pilot units; not background queue',queries:'registered actual beforeRequest; query queue and 1500ms deadline',inputTokens:'conservative UTF8-byte proxy; raw endpoint prompt_eval_count also retained',baseline:'default legacy heuristic with embedding disabled',holdout:'predeclared disjoint queries; no policy tuning; partial 4/22 index; not adoption evidence',readback:'synthetic storage acknowledgement/read/second VM reload, not live host disk proof'}};
 const save=(name,x)=>fs.writeFileSync(path.join(outRoot,name),JSON.stringify(x,null,2));save('manifest.json',manifest);
 const s=await session({provider,policy,budget,live:true,corpus,authorization:{gpuSlotReturned:true,allowLocalCalls:true,modelVerified:true,modelDigest:tag.digest}}),outputs=[];
 const checkpoint=()=>{save('transport-raw.json',s.capture);save('beforeRequest-raw.json',outputs);};
 try{
  const docs=s.runtime.all.filter(u=>['memory_ferry_permit','entity_ferry_permit','world_ferry_permit','101'].includes(String(u.locator.id)));
  assert.equal(docs.length,4);save('pilot-documents.json',await s.pilotDocuments(docs.map(u=>u.identity)));checkpoint();
  for(const id of [...pilotIds,...(holdout?holdoutIds:[])]){const c=dataset.cases.find(c=>c.id===id);assert.ok(c,id);const out=await s.beforeRequest(c.query,{caseId:id,mode:'dual',injectionMode:outputs.length%2?'hybrid':'direct'});out.split=c.split;out.coverage=await s.readiness();outputs.push(out);checkpoint();console.log(JSON.stringify({case:id,queryCalls:out.calls.length,ms:out.elapsedMs,semantic:out.trace?.retrieval?.trace?.lanes?.semantic?.returned,consumer:out.trace?.consumer?.ok}));}
  const scored=outputs.map(records);save('oracle-records.json',scored);save('pilot-score.json',score(dataset,scored.filter(r=>pilotIds.includes(r.caseId))));if(holdout)save('holdout-score.json',score(dataset,scored.filter(r=>holdoutIds.includes(r.caseId))));
  const rowBytes=[...s.runtime.store].filter(([k])=>k.includes(':row:')).map(([k,v])=>({keyHash:sha(k),bytes:Buffer.byteLength(String(v))}));
  const canaryLeaks=outputs.filter(o=>dataset.forbidden.some(c=>JSON.stringify([o.output,o.projectionEntries]).includes(c))).map(o=>o.caseId);
  const summary={pilotTransportCompleted:true,holdoutSliceCompleted:holdout,fullMeasurementCompleted:false,qualityVerdict:'incomplete_partial_index_unfrozen_policy_host_unavailable',productionEligible:false,
   modelCalls:s.capture.calls.length,documentCalls:s.capture.calls.filter(c=>c.role==='document').length,queryCalls:s.capture.calls.filter(c=>c.role==='query').length,
   documentCallsDuringRequests:scored.reduce((n,r)=>n+r.transport.documentCalls,0),uncertainCalls:s.capture.calls.filter(c=>c.uncertain).length,active:s.capture.active,maxActive:s.capture.maxActive,
   storage:s.storage(),rowBytes,coverage:await s.readiness(),canaryLeaks,host:'unavailable',coldWarm:'first document load timing separated; subsequent warm-model queries against partial index; no full-corpus warm claim',oracleUnchanged:sha(fs.readFileSync(datasetPath))===manifest.hashes[path.relative(root,datasetPath)]};
  save('summary.json',summary);assert.equal(summary.active,0);assert.equal(summary.documentCallsDuringRequests,0);assert.equal(summary.canaryLeaks.length,0);return summary;
 }finally{checkpoint();await s.close();manifest.endedAt=new Date().toISOString();manifest.activeAtClose=s.capture.active;save('manifest.json',manifest);}
}
function arg(n){const i=process.argv.indexOf('--'+n);return i<0?null:process.argv[i+1];}
if(require.main===module){const out=arg('out-root'),pol=arg('policy');if(!out||!pol){console.error('out_root_and_explicit_fixture_policy_required');process.exit(1);}run({outRoot:path.resolve(out),policyPath:path.resolve(pol),holdout:process.argv.includes('--holdout-slice')}).then(result=>{console.log(JSON.stringify(result));process.exit(0);}).catch(e=>{console.error(e.stack);process.exit(1)});}
module.exports={run,records};
