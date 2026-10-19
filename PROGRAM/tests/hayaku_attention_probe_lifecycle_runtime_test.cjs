'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createHayakuRuntime,createStore,waitFor} = require('./fixtures/hayaku_runtime_harness.cjs');
const messages = [{role:'user',chatId:'u1',data:'Open the gate.'},{role:'assistant',chatId:'a1',data:'The gate opens.'}];
async function disable(r) {
  const settings = await r.hayaku.settingsControl.current();
  const result = await r.hayaku.settingsControl.apply({...settings,hayaku_enabled:false});
  assert.equal(result.ok, true);
  assert.equal(r.hayaku.settings().enabled, false);
}
async function observeChatWithoutProbe(r) {
  const original = r.context.setTimeout;
  let trigger;
  r.context.setTimeout = (fn,ms,...args) => ms === 30000 ? (trigger=()=>fn(...args),{unref(){}}) : original(fn,ms,...args);
  const t = r.hayaku._test;
  t.startHayakuAttention();
  t.scheduleHayakuAttentionRefresh('chat_output',0);
  await t.refreshHayakuAttention();
  await new Promise(resolve=>r.context.setTimeout(resolve,10));
  assert.equal(trigger,undefined,'chat observation must not schedule a paid connection test');
}
test('chat attention never schedules a paid connection test, including after disabling HAYAKU', async () => {
  const r = await createHayakuRuntime({messages,transformSource:s=>s.replace('        startHayakuAttention, stopHayakuAttention,','        scheduleHayakuAttentionRefresh, startHayakuAttention, stopHayakuAttention,'),llmResponder:async()=>({type:'success',result:'HAYAKU OK'})});
  try {
    await observeChatWithoutProbe(r);
    await disable(r);
    await r.hayaku._test.refreshHayakuAttention();
    assert.equal(r.llmCalls.length, 0);
  } finally { await r.dispose(); }
});
test('disabling while the probe waits in the physical model queue blocks submission', async () => {
  let release;
  const r = await createHayakuRuntime({messages,
    // Expose the real queue entry for this test; do not replace queue/model logic.
    transformSource:s=>s.replace('        runNativeAuxiliaryProbe,','        runNativeOtherAx, runNativeAuxiliaryProbe,'),
    llmResponder:()=>new Promise(resolve=>{release=()=>resolve({type:'success',result:'HAYAKU OK'});})});
  try {
    const first = r.hayaku._test.runNativeOtherAx([{role:'user',content:'synthetic explicit request'}],{taskKind:'connection_probe'});
    await waitFor(()=>release,'first physical call');
    const automatic = r.hayaku._test.runNativeAuxiliaryProbe({automatic:true});
    await waitFor(()=>r.hayaku._test.nativeAuxiliaryProbeSnapshot()?.last?.status === 'running','queued probe');
    await disable(r);
    release(); await first; await automatic;
    assert.equal(r.llmCalls.length, 1, 'only the earlier explicit request reached the model');
    assert.equal(r.hayaku._test.nativeAuxiliaryProbeSnapshot().last.status, 'cancelled');
  } finally { release?.(); await r.dispose(); }
});
for (const authority of ['safeLocalStorage','getLocalPluginStorage']) {
  test(`auxiliary success persists across restart using ${authority} without global localStorage`, async () => {
    const pluginStorage = createStore(), device = createStore();
    const options = {pluginStorage,safeLocalStorage:device,llmResponder:async()=>({type:'success',result:'HAYAKU OK'}),
      hostOverrides:authority === 'safeLocalStorage' ? {getLocalPluginStorage:undefined} : {getLocalPluginStorage:async()=>device,safeLocalStorage:undefined}};
    const first = await createHayakuRuntime(options);
    try {
      assert.equal(first.context.localStorage, undefined);
      assert.equal((await first.hayaku.recovery.auxiliaryModel.testCall()).ok, true);
      assert.equal(first.hayaku._test.hayakuAuxiliaryReadiness(), 'ready');
      assert.ok(await device.getItem('hayaku.auxProbe.v1'));
      assert.equal(await pluginStorage.getItem('hayaku.auxProbe.v1'), null);
    } finally { await first.dispose(); }
    const second = await createHayakuRuntime(options);
    try {
      assert.equal(second.hayaku._test.hayakuAuxiliaryReadiness(), 'ready');
      assert.equal(second.llmCalls.length, 0, 'a fresh success needs no additional probe');
    } finally { await second.dispose(); }
  });
}
