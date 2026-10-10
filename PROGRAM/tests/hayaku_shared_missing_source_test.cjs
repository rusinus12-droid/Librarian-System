'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');

(async()=>{
  const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:'Alice signed the agreement.'});
  const runtime=await createHayakuRuntime({autoRepair:false,messages:[
    {role:'user',id:'u1',chatId:'u1',data:'<original>Alice signed the agreement.</original> Translation wording.'},
    {role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage('Alice signed the agreement.',packet)}
  ]});
  try{
    const t=runtime.hayaku._test,scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope);
    await t.reconcileObservedChatTopology(scope,snapshot,'missing_source_initial');
    const evidenceKeys=(await runtime.pluginStorage.keys()).filter(key=>String(key).startsWith('hayaku.v2.source-evidence.'));
    assert.ok(evidenceKeys.length,'the baseline owner source evidence exists');
    for(const key of evidenceKeys)await runtime.pluginStorage.removeItem(key);

    await t.getHayakuSourceEdits().setSourceRules({version:1,sourceTags:[{open:'<original>',close:'</original>'}],ignoredTags:[],unwrapTags:[],controls:[]});
    const current=await t.hayakuSourceEditSnapshot(await t.currentChatScope());
    const unit=current.units[0];assert.ok(unit.originalDigest);assert.equal(unit.originalRawDigest,'');assert.equal(unit.policyUncertain,true);
    const rows=await t.loadHayakuSourceReview([{...unit,changeKind:'projection_policy_changed',policyUncertain:true}],scope.key);
    assert.equal(rows.rows[0].previousUnavailable,true);
    assert.equal(rows.rows[0].beforeText,'','missing raw evidence is not reconstructed from a hash or packet');
    assert.ok(rows.rows[0].afterText.includes('Alice signed the agreement.'));
    console.log(JSON.stringify({test:'hayaku_shared_missing_source',passed:5}));
  }finally{await runtime.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
