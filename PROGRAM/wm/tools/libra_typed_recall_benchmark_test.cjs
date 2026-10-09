'use strict';
const assert = require('node:assert/strict');
let benchmark;
try { benchmark = require('./libra_typed_recall_benchmark.cjs'); }
catch (error) { console.error('FAIL benchmark_oracle_api_exists: ' + error.code); process.exit(1); }
const data = require('./fixtures/typed-recall-measurement-v1.json');
const results = [];
function check(name, fn) { try { fn(); results.push({name, ok:true}); console.log('PASS ' + name); } catch (error) { results.push({name, ok:false, error:error.message}); console.error('FAIL ' + name + ' ' + error.message); } }
const positive = data.cases.find(c => c.gold.length === 4);
const items = positive.gold.map(g => ({...g, text:'independent fixture content'}));
const record = {caseId:positive.id, stages:{candidate:items, fusion:items, diversity:items, packing:items}, baseline:{expected:['world','entity','narrative'], present:['world','entity','narrative']}, transport:{realCalls:0, fakeCalls:1}};
check('four_types_and_roles_scored_at_each_stage', () => { const r=benchmark.score(data,[record]); assert.equal(r.cases[0].stages.packing.recall,1); for(const f of ['memory','entity','world','narrative'])assert.equal(r.cases[0].stages.packing.byType[f].recall,1); });
check('shuffled_identity_fails_independent_oracle', () => { const r=structuredClone(record);r.stages.packing=r.stages.packing.map(x=>({...x,id:'shuffled-'+x.id}));assert.equal(benchmark.score(data,[r]).cases[0].stages.packing.recall,0); });
check('baseline_preservation_is_separate_from_recall', () => { const r=structuredClone(record);r.stages.packing=[];const scored=benchmark.score(data,[r]).cases[0];assert.equal(scored.protectedCoreLost,0);assert.equal(scored.stages.packing.recall,0); });
check('no_answer_keeps_baseline_and_counts_false_positive', () => { const c=data.cases.find(c=>!c.gold.length),r={...record,caseId:c.id};const scored=benchmark.score(data,[r]).cases[0];assert.equal(scored.protectedCoreLost,0);assert.equal(scored.stages.packing.falsePositives,4);assert.equal(scored.stages.packing.abstained,false); });
check('missing_role_is_not_erased_by_same_family_identity', () => { const r=structuredClone(record);r.stages.packing=r.stages.packing.map(x=>({...x,roles:x.roles.slice(0,1)}));assert.ok(benchmark.score(data,[r]).cases[0].stages.packing.roleRecall<1); });
check('constant_fake_vectors_cannot_be_quality_evidence', () => { const r=benchmark.score(data,[record]);assert.equal(r.qualityVerdict,'unmeasured');assert.equal(r.measurementCompleted,false); });
check('type_exhaustion_and_candidate_loss_are_visible', () => { const r=structuredClone(record);r.stages.packing=r.stages.packing.filter(x=>x.family!=='world');const s=benchmark.score(data,[r]).cases[0];assert.equal(s.stages.candidate.byType.world.recall,1);assert.equal(s.stages.packing.byType.world.recall,0); });
check('unsafe_payload_and_required_drop_have_distinct_counters', () => { const r=structuredClone(record);r.baseline.present=['world'];r.stages.packing[0].text='ENTITY_SECRET_CANARY';const s=benchmark.score(data,[r]).cases[0];assert.equal(s.protectedCoreLost,2);assert.equal(s.safetyFailures,1); });
check('duplicate_or_unknown_case_contract_rejected', () => { assert.throws(()=>benchmark.score(data,[record,record]),/duplicate/);assert.throws(()=>benchmark.score(data,[{...record,caseId:'invented'}]),/unknown/); });
check('language_family_noanswer_aggregates_are_separate',()=>{const r=benchmark.score(data,[record]);assert.equal(r.aggregates.byLanguage[positive.language].cases,1);assert.equal(r.aggregates.byFamily.world.packing.hits,1);assert.equal(r.aggregates.noAnswer.cases,0);});
check('independent_corpus_and_all_twelve_cross_directions_are_explicit',()=>{const expanded=require('./fixtures/typed-recall-measurement-v2.json'),d=benchmark.distribution(expanded);assert.ok(d.events.length>=4);for(const family of ['memory','entity','world','narrative'])for(const source of ['ko','en','ja','zh'])for(const target of ['ko','en','ja','zh'])assert.ok(d.byFamily[family].directions[source+'->'+target]>=1);for(const language of ['ko','en','ja','zh']){assert.ok(d.byLanguage[language].hardNegative>=2);assert.ok(d.byLanguage[language].noAnswer>=2);}assert.ok(d.holdout>0&&d.tuning>0);assert.equal(expanded.oracleStatus,'prepared_pending_parent_review');});
console.log(JSON.stringify({passed:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,realModelCalls:0}));process.exitCode=results.some(x=>!x.ok)?1:0;
