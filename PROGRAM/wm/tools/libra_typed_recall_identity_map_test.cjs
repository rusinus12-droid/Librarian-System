'use strict';
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const {policy,budget}=require('./libra_typed_recall_consumers_test.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'test-output/typed-recall/task5-identity-map');fs.mkdirSync(dir,{recursive:true});
const before=process.env.IDENTITY_MAP_BASELINE||path.join(root,'test-output/typed-recall/task5-host-boundary/safety-fixed-baseline/dist/LIBRA World Manager Full.js'),after=process.env.IDENTITY_MAP_CANDIDATE||path.join(root,'dist/LIBRA World Manager Full.js');
const clone=x=>JSON.parse(JSON.stringify(x));
async function run(bundle,change='none',stage='before'){
 process.env.LIBRA_RECALL_TEST_DIST=bundle;const r=await runtime(null,{countEnumeration:true,dist:bundle,duplicateEnumeration:change==='first_match'}),c=r.context.__QUEUE_TEST__.consumers,p=policy(),all=r.all;
 const section={key:'opaque-baseline',text:'CURRENT CANONICAL CONTROL',required:true,bindings:all},com=c.compose({baseline:[section],selection:[],snapshot:r.snapshot,policy:p});
 let snapshots=0,changed=false;
 const mutate=()=>{if(changed)return;changed=true;
  if(change==='content')r.chat.localLore.find(e=>e.comment==='lmai_memory').content+=' CHANGED';
  if(change==='collision')r.chat.localLore.push(clone(r.chat.localLore.find(e=>e.comment==='lmai_memory')));
  if(change==='parent_name'||change==='parent_rule'){const e=r.chat.localLore.find(e=>e.comment==='lmai_world_graph'),g=JSON.parse(e.content);if(change==='parent_name')g.nodes[0][1].name+=' RENAME';else g.nodes[0][1].rules.custom.oath='NEW_RULE';e.content=JSON.stringify(g);}
  if(change==='secret'){const e=r.chat.localLore.find(e=>e.comment==='lmai_entity'),v=JSON.parse(e.content);v.meta.secret=true;e.content=JSON.stringify(r.signed(v,'entity',v.name));}
  if(change==='exclusion')p.exclusions={identities:[all[0].identity]};
 };
 if(stage==='before')mutate();if(change==='first_match')r.context.__DUPLICATE_ENUMERATION__=true;r.context.__ENUMERATION_COUNT__=0;
 const snapshot=()=>{snapshots++;if(stage==='after_format'&&snapshots===2)mutate();const s=r.snap();const fields={scope:'scopeKey',branch:'branchId',viewer:'viewerId',turn:'currentTurn',revision:'worldlineRevision',drift:'ephemeralDriftExclusion'};if(fields[change])return{...s,[fields[change]]:change==='turn'?999:change==='drift'?{excludedTurns:[4]}:'FOREIGN'};return s;};
 const output=c.finalize({sections:com.sections,currentSnapshot:snapshot,mode:'hybrid',policy:p,budget});
 const finalizeEnumerations=r.context.__ENUMERATION_COUNT__,finalizeSnapshots=snapshots;
 if(stage==='verified')mutate();const verified=c.verified(output),verifiedEnumerations=r.context.__ENUMERATION_COUNT__-finalizeEnumerations;
 return{output:clone(output),verified,finalizeEnumerations,verifiedEnumerations,finalizeSnapshots,totalSnapshots:snapshots,bindings:all.length};
}
async function main(){const results=[],raw=[];const check=async(name,f)=>{try{await f();results.push({name,ok:true});console.log('PASS '+name);}catch(e){results.push({name,ok:false,error:e.stack});console.error('FAIL '+name+' '+e.message);}};
 await check('one_enumeration_per_valid_call_with_many_baseline_bindings',async()=>{const b=await run(before),a=await run(after);raw.push({case:'count',before:b,after:a});assert.deepEqual(a.output,b.output);assert.equal(a.verified,b.verified);assert.equal(a.verified,true);assert.equal(a.finalizeEnumerations,3);assert.equal(a.verifiedEnumerations,1);assert.equal(a.totalSnapshots,4);assert.equal(b.finalizeEnumerations,3*b.bindings);assert.equal(b.verifiedEnumerations,b.bindings);});
 for(const change of ['none','scope','branch','viewer','turn','revision','drift','content','parent_name','parent_rule','collision','secret','exclusion'])await check('identical_result_'+change,async()=>{const b=await run(before,change),a=await run(after,change);assert.deepEqual(a.output,b.output);assert.equal(a.verified,b.verified);if(change!=='none')assert.equal(a.verified,false);raw.push({case:change,before:b,after:a});});
 await check('first_match_lookup_survives_later_duplicate_from_adapter_contract',async()=>{const b=await run(before,'first_match'),a=await run(after,'first_match');assert.deepEqual(a.output,b.output);assert.equal(a.verified,true);assert.equal(b.verified,true);raw.push({case:'first-match',before:b,after:a});});
 for(const stage of ['after_format','verified'])await check('no_map_shared_across_'+stage,async()=>{const b=await run(before,'content',stage),a=await run(after,'content',stage);assert.deepEqual(a.output,b.output);assert.equal(a.verified,b.verified);assert.equal(a.verified,false);raw.push({case:stage,before:b,after:a});});
 const phase=process.env.RECALL_TEST_PHASE||'identity-map',summary={passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,results,realModelCalls:0};fs.writeFileSync(path.join(dir,phase+'-results.json'),JSON.stringify(summary,null,2));fs.writeFileSync(path.join(dir,phase+'-raw.json'),JSON.stringify(raw,null,2));console.log(JSON.stringify({passed:summary.passed,failed:summary.failed,realModelCalls:0}));process.exitCode=summary.failed?1:0;
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
