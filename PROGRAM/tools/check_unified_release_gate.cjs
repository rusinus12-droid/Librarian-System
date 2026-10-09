'use strict';
// Read-only evidence gate. Valid JSON/test counts cannot attest real host/model
// execution. This tool never changes defaults, deletes a reader or opens a mode.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const requiredHostIds=Array.from({length:8},(_,i)=>`H06-${String(i+1).padStart(2,'0')}`);
const requiredSafety=['unsupportedAssertions','identityErrors','knowledgeLeaks','temporalErrors'];
function assess(input,codeHash){
 const blockers=[],add=(id,detail)=>blockers.push({id,detail});
 if(input?.schema!=='libra.release_gate_input.v2')add('input_contract_missing','Explicit evidence input is required.');
 const host=input?.host,model=input?.model,runtime=input?.runtime,policy=input?.predeclaredPolicy;
 if(host?.boundary!=='actual_risuai_installation'||host?.status!=='pass')add('actual_host_not_passed','Synthetic iframe/API fixtures do not establish RisuAI installation or IPC.');
 if(!/^[a-f0-9]{64}$/.test(host?.hostSourceSHA256||'')||host?.pluginSHA256!==codeHash)add('host_source_binding_missing','Host and installed plugin hashes must identify the inspected bytes.');
 if(!requiredHostIds.every(id=>host?.cases?.some(c=>c.id===id&&c.status==='pass'&&c.evidenceDigest?.match(/^[a-f0-9]{64}$/))))add('host_cases_incomplete','H06-01–08 need explicit real-host evidence.');
 if(model?.transportBoundary!=='explicit_external_model_http'||model?.modelSemanticPass!==true||!(model?.modelRequestsPerformed>0)||model?.humanAssessment!=='completed')add('model_semantics_not_passed','Model transport and independent completed semantic assessment are required.');
 if(model?.sourceCodeSHA256!==codeHash)add('model_source_binding_missing','A different build is not a current semantic result.');
 const planned=model?.plan?.caseIds||[],arms=model?.plan?.arms||[];
 if(!Array.isArray(planned)||!planned.length||arms.length!==1||arms[0]!=='L')add('single_analyzer_evaluation_missing','Only the Librarian arm L is a production evaluation; historical comparisons remain external DEV evidence.');
 const rows=Array.isArray(model?.results)?model.results:[];
 for(const id of planned){
  const group=rows.filter(r=>r.caseId===id);
  if(group.length!==1||group[0]?.arm!=='L'||group[0]?.physicalRequests!==1||group[0]?.configuredStages?.length!==1||group[0]?.configuredStages?.[0]!=='librarian'||['sourceDigest','previousStateDigest','referenceMaterialDigest','providerModel'].some(k=>typeof group[0]?.[k]!=='string'||!group[0][k]))add('comparison_basis_mismatch',id);
 }
 if(!policy||policy.status!=='predeclared'||policy.sourceCodeSHA256!==codeHash||policy.corpusDigest!==model?.plan?.sourceDigest
   || !Number.isFinite(Date.parse(policy.declaredAt))||!Number.isFinite(Date.parse(model?.startedAt))||Date.parse(policy.declaredAt)>Date.parse(model.startedAt)
   || !Number.isInteger(policy.maxOmissions)||policy.maxOmissions<0||!Number.isFinite(policy.maxWallMs)||policy.maxWallMs<=0
   || !requiredSafety.every(k=>policy[k]===0))add('predeclared_quality_policy_missing','Set sample/quality/latency thresholds before looking at results, never after.');
 for(const row of rows){const h=row.humanAssessment;
  if(row.error||row.outcome?.job?.failed||h?.status!=='completed'||!h.reviewer||!h.evidenceDigest?.match(/^[a-f0-9]{64}$/)||h.currentStateCorrect!==true
    || !Number.isInteger(h.omissions)||h.omissions<0||h.omissions>policy?.maxOmissions
    || requiredSafety.some(k=>h[k]!==0)||!Number.isFinite(row.wallMs)||row.wallMs>policy?.maxWallMs)add('case_quality_not_passed',`${row.caseId}:${row.arm}`);
 }
 if(runtime?.pluginSHA256!==codeHash||runtime?.status!=='pass'||runtime?.regression?.failed!==0||!(runtime?.regression?.passed>0)
  ||runtime?.restoreVerified!==true||runtime?.sourcePreserved!==true||runtime?.modeTransitionVerified!==true)add('runtime_transition_restore_incomplete','Regression counts alone do not establish safe mode transition and restore.');
 if(!rows.length)add('no_semantic_results','No assessed comparison results were supplied.');
 return {schema:'libra.release_gate_result.v2',pluginSHA256:codeHash,status:blockers.length?'blocked':'evidence_ready_for_manual_release_review',
  blockers,targetAnalyzer:'librarian',engineVersion:'libra.unified.v2',developmentCutoverIsNotOperationalCertification:true,eligibleForAutomaticDefaultChange:false,settingsMutated:false,readersRetired:false,serverMirrorDistributedAutomaticallyEnabled:false,
  note:'Evidence declarations are not cryptographic proof of execution; inspect the referenced reports and raw observations.'};
}
function main(){const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
 const code=fs.readFileSync(path.resolve(get('--plugin')||path.join(__dirname,'../plugins/LIBRA.js'))),input=get('--evidence')?JSON.parse(fs.readFileSync(path.resolve(get('--evidence')),'utf8')):{schema:'libra.release_gate_input.v2'};
 const result=assess(input,sha(code)),out=get('--output');if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(path.resolve(out),JSON.stringify(result,null,2));}
 console.log(JSON.stringify(result,null,2));if(args.includes('--require-ready')&&result.status==='blocked')process.exitCode=3;
}
module.exports={assess,requiredHostIds};if(require.main===module)try{main();}catch(e){console.error(String(e.message||e));process.exitCode=1;}
