'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {microReply}=require('./fixtures/libra_reanalysis_kinds_fixture.cjs');
function transformSource(source) {
  const anchor='    const microStageStatusFromWork = ';
  assert.ok(source.includes(anchor));
  return source.replace(anchor,`    globalThis.__microPlanDiagnostic = async reason => {
      const context=await resolveContext(true),scope=context.scope,pair=buildPairs(context.chat,scope.scopeKey)[0];
      await persistCompletedTurnReceipt(context,pair,'completed_pair_reconcile',{deferInventory:true});
      const active=await readActiveCompletedTurnReceipt(scope,hostWorldlineIdForScope(scope),0,pair.turn);
      const receipt=active.receipt;
      if (reason !== 'missing') await storage.setVerifiedJson(key.microWork(scope,receipt.worldlineId,0,pair.turn,receipt.revisionId,microProducerVersion),{
        schema:'libra.micro_work.v1',scopeKey:scope.scopeKey,worldlineId:receipt.worldlineId,sessionEpoch:0,
        turn:pair.turn,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,receiptKey:active.receiptKey,
        producerVersion:microProducerVersion,status:'reserved',phase:'planned',planProvenance:'risu_chat_output_fresh_receipt',
        planRuntimeToken:reason==='runtime'?'prior_runtime':state.microRuntimeToken,
        planRestoreGeneration:Number(state.microRestoreGeneration||0)+(reason==='restore'?1:0),
        attemptId:'diagnostic_test',logicalAttempts:1,physicalAttemptsUsed:0,attemptHistory:[],
        reservedAt:Date.now(),leaseExpiresAt:Date.now()+45000,result:null},scope);
      const result=await scheduleMicroForTurn(scope,receipt.worldlineId,0,pair.turn,receipt.revisionId);
      return {result,publication:state.lastMicroPublication,scopeKey:scope.scopeKey};
    };
`+anchor);
}
for (const [input,reason] of [['runtime','runtime_changed'],['restore','restore_generation_changed']])
  test(`${reason}: unproven work exposes its recovery reason and invokes no model`,async t=>{
    const x=await serverFixture({mode:'plugin_only',transformSource});t.after(()=>x.cleanup());
    x.f.chat.message=x.f.chat.message.slice(0,2);x.f.chat.messages=x.f.chat.message;
    const before=x.f.control.calls.length;
    const {result,publication,scopeKey}=await x.f.r.context.__microPlanDiagnostic(input);
    assert.equal(result.status,'unknown');assert.equal(result.reason,'micro_plan_unproven');
    assert.equal(result.recoveryAction,'manual_retry_required');assert.equal(result.planUnprovenReason,reason);
    assert.equal(publication.scopeKey,scopeKey);assert.equal(publication.planUnprovenReason,reason);
    assert.equal(x.f.control.calls.length,before);
  });

test('missing work on a saved receipt requires explicit source reanalysis and can publish afterward',async t=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});t.after(()=>x.cleanup());
  x.f.chat.message=x.f.chat.message.slice(0,2);x.f.chat.messages=x.f.chat.message;
  const {result,publication}=await x.f.r.context.__microPlanDiagnostic('missing');
  assert.equal(result.reason,'micro_work_missing');
  assert.equal(publication.recoveryAction,'source_reanalysis_required');
  assert.equal(x.f.control.calls.length,0);
  const api=x.f.r.api;
  assert.equal((await api.getReceiptRecoveryStatus()).microJobs[0].reason,'micro_work_missing');
  x.f.control.onCall=args=>microReply(args,'복구한 기억');
  const inventory=await api.listReanalysisRanges({kind:'micro'});
  const run=await api.reanalyzeSelectedRanges(inventory);
  assert.equal(run.ok,true,JSON.stringify(run));
  const active=await api.debugReadActiveMicroMemory(1);
  assert.equal(active.record.analysisStatus,'verified');
  assert.equal(x.f.control.calls.length,1);
});
