'use strict';
/* Opt-in semantic evaluation of the ACTUAL deployed memory pipeline.
 * The host/store is isolated in memory. With --live the model transport is real.
 * No operation touches a user's RisuAI DATA. No rubric is sent to the model.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('../tests/fixtures/libra_unified_runtime_fixture.cjs');
const corpus=require('../tests/fixtures/wm_semantic_cases_v1.json');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
function referenceContext(c){return c.referenceContext||{characterDescription:'',personaDescription:''};}
function validateBaseline(c){
 const r=referenceContext(c);if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['characterDescription','personaDescription'].includes(k))
  || Object.values(r).some(v=>typeof v!=='string'||v.length>20000))throw Error('evaluation_reference_context_invalid');
 if(c.approvedBaseline){const b=c.approvedBaseline;if(!b||b.schema!=='libra.wm_approved_baseline.v1'||!Array.isArray(b.sourceRows)||b.sourceRows.length!==10
  || b.artifact?.schema!=='libra.canonical_artifact.v4'||JSON.stringify(b).length>1000000)throw Error('evaluation_approved_baseline_invalid');
  b.sourceRows.forEach((r,i)=>{if(r.ref!==`t${1+Math.floor(i/2)}-${i%2?'a':'u'}`||!(i%2?['char','assistant']:['user']).includes(r.role)||typeof r.text!=='string'||!r.text.trim())throw Error('evaluation_baseline_exact_five_pairs_required');});
 }
}
function validateCases(cases){
 if(!Array.isArray(cases)||!cases.length||cases.length>16)throw Error('evaluation_cases_required');
 for(const c of cases){if(!/^WM-\d{2}$/.test(c.id)||!Array.isArray(c.sourceRows)||c.sourceRows.length!==10||!['character_ito','world_ito','plot_ito'].includes(c.selectedReview))throw Error('invalid_evaluation_case');
  c.sourceRows.forEach((r,i)=>{if(r.ref!==`t${1+Math.floor(i/2)}-${i%2?'a':'u'}`||!(i%2?['char','assistant']:['user']).includes(r.role)||typeof r.text!=='string'||!r.text.trim())throw Error('evaluation_exact_five_pairs_required');});
  if(c.previousState!=null||c.referenceMaterial?.length)throw Error('evaluation_nonempty_baseline_not_supported');validateBaseline(c);
 }return cases;
}
function makePlan(cases=corpus.cases,arms=['L']){
 validateCases(cases);if(!Array.isArray(arms)||!arms.length||new Set(arms).size!==arms.length||arms.some(x=>x!=='L'))throw Error('invalid_evaluation_arms');
 const expected=cases.length; // One Librarian dispatch per exact five-pair case.
 return {schema:'libra.wm_evaluation_plan.v2',analyzer:'librarian',engineVersion:'libra.unified.v2',historicalComparison:'not_in_production',caseIds:cases.map(c=>c.id),arms,sourceDigest:hash(cases.map(c=>({id:c.id,rows:c.sourceRows,approvedBaseline:c.approvedBaseline||null,referenceContext:referenceContext(c)}))),
  plannedProviderDispatches:expected,implicitRetries:0,hostBoundary:'isolated_in_memory_actual_plugin',modelEvaluation:'not_run',humanAssessment:'not_run',eligibleForDefault:false,
  safetyRubric:{unsupportedAssertionAllowed:0,wrongIdentityAllowed:0,knowledgeLeakAllowed:0,temporalPromotionAllowed:0,structuralPassIsSemanticPass:false},
  cases:cases.map(c=>({id:c.id,label:c.label,selectedReview:c.selectedReview,sourceDigest:hash(c.sourceRows),approvedBaselineDigest:hash(c.approvedBaseline||null),referenceContextDigest:hash(referenceContext(c)),expected:c.expected,forbidden:c.forbidden}))};
}
async function runEvaluation({cases=corpus.cases,arms=['L'],endpoint,model,apiKey,acknowledgePaidCalls=false,maxRequests=0,fetchImpl=fetch,transportBoundary='explicit_external_model_http',timeoutMs=120000}={}){
 const plan=makePlan(cases,arms);if(acknowledgePaidCalls!==true)throw Error('explicit_paid_call_approval_required');
 if(!Number.isSafeInteger(maxRequests)||maxRequests<plan.plannedProviderDispatches||maxRequests>112)throw Error('explicit_bounded_request_budget_required');
 const url=new URL(endpoint);if(url.username||url.password||url.search||url.hash||!(['https:'].includes(url.protocol)||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('evaluation_endpoint_must_be_https_or_loopback_without_secrets');
 if(typeof model!=='string'||!model.trim()||!apiKey)throw Error('evaluation_model_and_env_api_key_required');
 let physicalRequests=0;const results=[];const started=Date.now();
 for(const c of cases)for(const arm of arms){
  const active=[]; // Retired reviewers are never evaluated through production dispatch.
  let contextCharacter=null;const refs=referenceContext(c),persona=refs.personaDescription?{id:'wm-eval-persona',name:'평가 페르소나',personaPrompt:refs.personaDescription}:null;
  const f=await fixture({mode:'librarian',args:{enable_character_ito:active.includes('character_ito'),enable_world_ito:active.includes('world_ito'),enable_plot_ito:active.includes('plot_ito')},
   host:{getDatabase:async fields=>{const db={personas:persona?[persona]:[],selectedPersona:persona?.id||'',characters:contextCharacter?[contextCharacter]:[],plugins:[],modules:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;}}});
  contextCharacter=f.character;f.character.desc=refs.characterDescription||'';if(persona)f.chat.bindedPersona=persona.id;
  let previousStateDigest=hash(null),baselineProvenance=null;

  const requests=[],armStart=Date.now();let outcome=null,error=null;
  try{
   const offset=c.approvedBaseline?5:0;
   if(c.approvedBaseline){
    f.chat.message=c.approvedBaseline.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));f.chat.messages=f.chat.message;f.control.artifact=clone(c.approvedBaseline.artifact);
    const seed=await f.run();if(seed.completed!==1||f.getHead()?.status!=='ready')throw Error('evaluation_baseline_validation_failed');
    previousStateDigest=hash(f.r.api.getUnifiedStateReadProjection(f.getHead()));
    baselineProvenance={kind:'supplied_source_and_artifact_validated_by_production',digest:hash(c.approvedBaseline),externalModelCalls:0,localFixtureDispatches:f.control.calls.length};
    // The analyzer starts from the supplied/validated prior artifact;
    // its fixture dispatch is explicitly excluded from live model measurements.
    await f.r.api.saveLibraMemorySettings({...await f.r.api.getLibraMemorySettings(),memoryEngine:'librarian'});
   }else f.chat.message=[];
   f.chat.message.push(...c.sourceRows.map(r=>({role:r.role,chatId:r.ref.replace(/^t(\d+)/,(_,n)=>`t${Number(n)+offset}`),data:r.text})));f.chat.messages=f.chat.message;
   f.control.onCall=async args=>{
    if(physicalRequests>=maxRequests)throw Error('evaluation_request_budget_exhausted');
    const messages=clone(args[0]?.messages);if(!Array.isArray(messages)||messages.length!==2)throw Error('actual_pipeline_prompt_unavailable');
    physicalRequests++;const before=Date.now(),record={sequence:physicalRequests,promptDigest:hash(messages),model,reportedModel:null,wallMs:null,usage:null,httpStatus:null};requests.push(record);
    // Disable redirects so an explicit endpoint cannot forward the bearer key.
    const response=await fetchImpl(url.toString(),{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model,messages,temperature:0.1,max_tokens:16384}),signal:AbortSignal.timeout(timeoutMs)});
    record.wallMs=Date.now()-before;record.httpStatus=response.status;
    if(!response.ok)throw Error(`evaluation_provider_http_${response.status}`);
    const raw=await response.text();if(raw.length>4*1024*1024)throw Error('evaluation_provider_response_too_large');const body=JSON.parse(raw),choice=body.choices?.[0];
    if(typeof choice?.message?.content!=='string')throw Error('evaluation_provider_content_missing');
    record.reportedModel=typeof body.model==='string'?body.model:null;
    record.usage=body.usage&&typeof body.usage==='object'?Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens','cached_tokens'].filter(k=>Number.isFinite(body.usage[k])&&body.usage[k]>=0).map(k=>[k,body.usage[k]])):null;
    return {type:'success',result:choice.message.content,usage:record.usage,model:record.reportedModel||model,finish_reason:choice.finish_reason};
   };
   const job=await f.run(),memory=f.getMemory(offset+1),head=f.getHead();
   outcome={job:{completed:job.completed,failed:job.failed},artifact:memory?.canonicalArtifact||null,renderedMemory:memory?.text||null,
    state:head?f.r.api.getUnifiedStateReadProjection(head):null,structuralValidation:memory?.artifactValidation||null,pipelineStatus:memory?.pipelineStatus||null};
  }catch(e){error=String(e.code||e.message||e).slice(0,500).replaceAll(apiKey,'[redacted]');}
  finally{await f.r.cleanup();}
  results.push({caseId:c.id,arm,sourceDigest:hash(c.sourceRows),previousStateDigest,referenceMaterialDigest:hash(referenceContext(c)),baselineProvenance,providerModel:model,
   configuredStages:['librarian'],physicalRequests:requests.length,requests,wallMs:Date.now()-armStart,outcome,error,
   actualPriceOrCost:null,humanAssessment:{status:'pending',omissions:null,unsupportedAssertions:null,identityErrors:null,knowledgeLeaks:null,temporalErrors:null,currentStateCorrect:null,notes:''}});
 }
 return {schema:'libra.wm_evaluation_result.v2',analyzer:'librarian',plan,sourceCodeSHA256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'))).digest('hex'),
  startedAt:new Date(started).toISOString(),transportBoundary,hostBoundary:'actual_deployed_plugin_with_isolated_synthetic_host_and_storage',modelRequestsPerformed:physicalRequests,
  modelSemanticPass:false,humanAssessment:'pending',eligibleForDefault:false,wallMs:Date.now()-started,results};
}
async function main(){
 const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
 if(args.includes('--help')){console.log('node tools/evaluate_wm_semantics.cjs --plan --output-dir <dir>\nExplicit external model run: MEMORY_SUITE_EVAL_API_KEY=<secret> node tools/evaluate_wm_semantics.cjs --live --endpoint https://provider/v1/chat/completions --model <model> --case WM-01 --arms L --max-requests 1 --output-dir <dir>\nNever put the key in a CLI argument. Without --live no model is called. Human scoring is mandatory.');return;}
 const selectedCorpus=get('--corpus')?JSON.parse(fs.readFileSync(path.resolve(get('--corpus')),'utf8')):corpus;validateCases(selectedCorpus.cases);
 const ids=get('--case')?.split(','),cases=ids?selectedCorpus.cases.filter(c=>ids.includes(c.id)):selectedCorpus.cases,arms=get('--arms')?.split(',')||['L'];
 if(ids&&(cases.length!==new Set(ids).size))throw Error('unknown_evaluation_case');
 const plan=makePlan(cases,arms),outDir=path.resolve(get('--output-dir')||path.join(process.cwd(),'wm-evaluation'));fs.mkdirSync(outDir,{recursive:true});
 fs.writeFileSync(path.join(outDir,'PLAN.json'),JSON.stringify(plan,null,2));
 if(!args.includes('--live')){console.log(JSON.stringify({status:'plan_only',modelRequestsPerformed:0,planned:plan.plannedProviderDispatches,outputDir:outDir}));return;}
 const result=await runEvaluation({cases,arms,endpoint:get('--endpoint'),model:get('--model'),apiKey:process.env.MEMORY_SUITE_EVAL_API_KEY,acknowledgePaidCalls:true,maxRequests:Number(get('--max-requests'))});
 fs.writeFileSync(path.join(outDir,'RESULTS.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:'human_assessment_pending',modelRequestsPerformed:result.modelRequestsPerformed,eligibleForDefault:false,outputDir:outDir}));
}
module.exports={makePlan,runEvaluation,validateCases};
if(require.main===module)main().catch(e=>{const secret=process.env.MEMORY_SUITE_EVAL_API_KEY||'';console.error(secret?String(e.message||e).replaceAll(secret,'[redacted]'):String(e.message||e));process.exitCode=1;});
