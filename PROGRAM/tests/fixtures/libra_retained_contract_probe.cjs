'use strict';
const assert = require('node:assert/strict');
const {createLibraVmHarness} = require('./libra_vm_harness.cjs');
const {hostData} = require('./libra_consumer_test_support.cjs');
// Test-only access to shipped functions. No historical API is recreated.
function expose(source) {
  const outer = '  const loadRisuContextSnapshot = async';
  assert.equal(source.split(outer).length, 2);
  source = source.replace(outer, `  globalThis.__retainedOuter = () => ({loadSettings, loadRisuContextSnapshot, sealReferenceSourceSnapshot, translateInputAssistReviewText, updatePipelineWorkPanel, reportPipelineStageProgress, finishPipelineWorkStatus});\n${outer}`);
  const core = '      getUnifiedStorageStatus,';
  assert.equal(source.split(core).length, 2);
  return source.replace(core, `      retainedContractProbe: async (packet = {}) => {
        const context = await resolveContext(), settings = await loadSettings();
        const snapshot = sealReferenceSourceSnapshot(await loadRisuContextSnapshot(settings, []));
        const readSet = buildConsumerReadSet(packet, snapshot, settings, context.scope);
        await assertConsumerReadSet(readSet);
        return {snapshot, readSet, verify: value => assertConsumerReadSet(value || readSet), project: (head, seed) => consumerEntityProjection(head, null, seed)};
      },\n${core}`).replace('    async getUnifiedStorageStatus() {', '    retainedContractProbe: packet => LibraMemoryCore.retainedContractProbe(packet),\n    async getUnifiedStorageStatus() {');
}
async function withReferences(run, args = {}) {
  const data = hostData(), calls = [];
  const h = await createLibraVmHarness({enable_gui:'false',...args}, {...data.host, async runLLMModel(options) {calls.push(options);throw Error('reference reads must not call a provider');}}, {transformSource:expose});
  try {
    await h.api.getResponseContext();
    h.storageWrites.length=0;h.storageRemovals.length=0;
    await run(h,data,calls);
    assert.equal(calls.length,0);assert.deepEqual(h.storageWrites,[]);assert.deepEqual(h.storageRemovals,[]);
  } finally {await h.cleanup();}
}
module.exports={assert,expose,withReferences,createLibraVmHarness,hostData};
