'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto');
const file=path.join(__dirname,'libra_multilingual_recall_harness.cjs');
if(!fs.existsSync(file)){console.error('FAIL harness_exists: offline multilingual harness has not been implemented');process.exit(1);}
const {metrics,transform,run}=require(file);
(async()=>{
  assert.deepStrictEqual(metrics(['noise','gold'],['gold'],[],2),{recall:1,mrr:0.5,ndcg:1/Math.log2(3),inappropriate:1,safetyViolations:0});
  assert.deepStrictEqual(metrics([],[],[],2),{recall:null,mrr:null,ndcg:null,inappropriate:0,safetyViolations:0});
  assert.throws(()=>transform('missing source boundaries','unicode'),/hook/);
  await assert.rejects(()=>run({initializationProbe:'fetch'}),/OFFLINE startup/);
  await assert.rejects(()=>run({initializationProbe:'nativeFetch'}),/OFFLINE startup/);
  await assert.rejects(()=>run({initializationProbe:'embedding'}),/OFFLINE startup/);
  const report=await run();
  const selectedDist=process.env.LIBRA_RECALL_TEST_DIST||path.join(__dirname,'../dist/LIBRA World Manager Full.js');
  assert.strictEqual(report.sourceSha256,crypto.createHash('sha256').update(fs.readFileSync(selectedDist)).digest('hex'));
  await assert.rejects(()=>run({expectedSourceSha256:'explicit-wrong-snapshot'}),/Explicit historical snapshot mismatch/);
  assert.deepStrictEqual(report.conditions.map(x=>x.name),['pre_unicode_anchor','unicode','intent_domain_ablation']);
  assert.strictEqual(report.externalCalls,0);assert.strictEqual(report.providerCalls,0);
  assert.strictEqual(report.conditions.length,3);
  require('./libra_multilingual_report_contract.cjs').validateNegationReport(report);
  for(const c of report.conditions){
    assert.strictEqual(c.queries.length,40);assert.strictEqual(c.summary.safetyViolations,0);
    assert.strictEqual(c.summary.externalCalls,0);assert.strictEqual(c.summary.canonicalMutations,0);
    for(const q of c.queries){assert.ok(q.trace.input);assert.ok(q.safety.checked);assert.strictEqual(q.safety.protectedRejected.length,q.safety.forbidden.length);assert.ok(q.safety.forbidden.every(key=>!(q.trace.detail||[]).includes(key)));}
    assert.ok(c.queries.some(q=>q.category==='cross_language'));
    assert.ok(c.queries.some(q=>q.category==='explicit_negation'));
    assert.ok(c.queries.some(q=>q.category==='worldline_reroll'));
    for(const id of ['negative-ko','negative-en']){
      const q=c.queries.find(x=>x.id===id);assert.ok(q.negationTerms.length>0);assert.strictEqual(q.excludedReturned.length,0);
    }
    for(const id of ['negative-ja','negative-zh'])assert.ok(c.queries.find(x=>x.id===id),'language coverage remains present');
    assert.strictEqual(c.supplementary.queries.length,4);
    for(const q of c.supplementary.queries){assert.strictEqual(q.metrics.recall,null);assert.strictEqual(q.coverage.detail,null);}
  }
  const baseline=report.conditions[0],unicode=report.conditions[1];
  assert.ok(baseline.queries.find(q=>q.id==='origin-ja-ja').anchors.length===0);
  assert.ok(unicode.queries.find(q=>q.id==='origin-ja-ja').anchors.length>0);
  console.log(JSON.stringify({ok:true,queriesPerCondition:40,conditions:3,externalCalls:0,sourceSha256:report.sourceSha256,summaries:report.conditions.map(x=>({name:x.name,...x.summary}))},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
