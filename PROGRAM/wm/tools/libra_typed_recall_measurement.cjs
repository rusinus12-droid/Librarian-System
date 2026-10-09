'use strict';
// Offline preflight and explicitly authorized bounded local measurement facade.
const fs=require('node:fs'),path=require('node:path'),{sha}=require('./libra_typed_recall_benchmark.cjs');
function arg(name){const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];}
function preflight(){
 const datasetPath=path.join(__dirname,'fixtures/typed-recall-measurement-v2.json'),corpusPath=path.join(__dirname,'fixtures/typed-recall-measurement-corpus-v2.json');
 const datasetBytes=fs.readFileSync(datasetPath),dataset=JSON.parse(datasetBytes),endpoint=arg('endpoint');
 if(endpoint){const u=new URL(endpoint);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('local_endpoint_only');}
 return {schema:'libra.typed_recall.preparation.v1',capturedAt:new Date().toISOString(),measurementCompleted:false,qualityVerdict:'unmeasured',productionEligible:false,realModelCalls:0,
  dataset:{path:datasetPath,sha256:sha(datasetBytes),oracleStatus:dataset.oracleStatus,cases:dataset.cases.length},corpus:{path:corpusPath,sha256:sha(fs.readFileSync(corpusPath))},
  runtimeFingerprint:{endpoint:endpoint||null,modelDigest:null,verified:false},workspaceFingerprint:{bundleSha256:arg('dist')?sha(fs.readFileSync(arg('dist'))):null},
  pilotBudget:{maxCalls:8,maxInputBytes:32768,maxInputTokens:8192,concurrency:1},
  comparisonContract:{modes:['legacy','shadow','dual'],same:['input messages','canonical corpus','provider/model digest','provider modes/options','packing budget','viewer/scope/branch'],labels:['cold','warm','partial','reload'],stages:['candidate','fusion','diversity','packing'],protectedCoreSeparateFromRecall:true},
  evidenceLadder:['registered actual beforeRequest returned messages','actual local setLorebook payload','host persistent write acknowledgement','new-instance host readback','assembled host model request bytes','independent oracle after model consumption'],
  blockers:['This offline command does not establish a fresh runtime model preflight','oracle and policy awaiting parent review/freeze','full holdout and complete index coverage not measured','durable host readback and assembled model prompt unavailable'],
  limitations:['Fake vectors verify wiring only','Prepared oracle cannot activate production policy','Local projection capture is not proof of host persistence or model consumption']};
}
async function main(){const out=arg('out-root'),mode=arg('mode');if(!out)throw new Error('out_root_required');
 if(mode==='preflight'){const report=preflight();fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'preflight.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({cases:report.dataset.cases,realModelCalls:0,qualityVerdict:report.qualityVerdict,blockers:report.blockers}));return;}
 if(!['pilot','measure'].includes(mode))throw new Error('mode_preflight_pilot_measure_required');
 if(!process.argv.includes('--gpu-returned')||!process.argv.includes('--allow-local-calls'))throw new Error('explicit_gpu_return_and_local_call_flags_required');
 const policy=arg('policy');if(!policy)throw new Error('explicit_fixture_policy_required');
 if(arg('endpoint')&&arg('endpoint')!=='http://127.0.0.1:11434')throw new Error('verified_local_endpoint_required');
 let result;if(mode==='pilot')result=await require('./libra_typed_recall_pilot.cjs').run({outRoot:path.resolve(out),policyPath:path.resolve(policy)});
 else{const source=arg('pilot-root');if(!source)throw new Error('bounded_holdout_slice_requires_pilot_root; full_corpus_measurement_not_yet_implemented');
  if(JSON.stringify(JSON.parse(fs.readFileSync(policy,'utf8')))!==JSON.stringify(JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8')).policy))throw new Error('same_captured_policy_required');
  result=await require('./libra_typed_recall_holdout_slice.cjs').run(path.resolve(source),path.resolve(out));}
 console.log(JSON.stringify(result));
}
if(require.main===module)main().then(()=>process.exit(0)).catch(error=>{console.error(error.message);process.exit(1)});
module.exports={preflight};
