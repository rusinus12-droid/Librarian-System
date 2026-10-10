'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const expose = source => {
  for (const [anchor, replacement] of [
    ['    const transcript = batch => batch.map(pair => [',
      '    globalThis.__receiptPreparation = { prepareSelectedCompletedTurnReceipts, resolveContext, buildPairs, state, receiptRecoveryIdentity, digest, captureReceiptRecoveryBoundary };\n    const transcript = batch => batch.map(pair => ['],
    ['    const reconcileCompletedTurnReceipts = async (context, pairs, options = {}) => {',
      '    const reconcileCompletedTurnReceipts = async (context, pairs, options = {}) => {\n      globalThis.__beforeReceiptReconcile?.(context, pairs, options);'],
    ['    const runReceiptRecoveryJob = async ({jobId,signal,suppressMicroResume=false}={}) => {',
      '    const runReceiptRecoveryJob = async ({jobId,signal,suppressMicroResume=false}={}) => {\n      globalThis.__onReceiptRecoveryDispatch?.(jobId);'],
    ['\n  const publicApi = Object.freeze({',
      '\n  globalThis.__receiptCore = LibraMemoryCore;\n  const publicApi = Object.freeze({']
  ]) {
    assert.equal(source.split(anchor).length, 2, 'exact test-only observation seam');
    source = source.replace(anchor, replacement);
  }
  return source;
};
const appendBatch = (f, base, start) => {
  f.chat.message.push(...base.map((row, index) => ({ ...row,
    chatId: `t${start + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}` })));
  f.chat.messages = f.chat.message;
};
const shiftArtifact = offset => {
  const out = artifact();
  for (const row of [...out.entities, ...out.facts]) for (const span of row.evidenceSpans)
    span.ref = span.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + offset}`);
  return out;
};
test('live append during tail settling still prepares the originally selected five-turn batch', async () => {
  const s = await serverFixture({ mode: 'plugin_only', transformSource: expose });
  try {
    const f = s.f, base = JSON.parse(JSON.stringify(f.chat.message));
    assert.equal((await f.run()).completed, 1);
    appendBatch(f, base, 6); f.control.artifact = shiftArtifact(5);
    let entered = false;
    f.r.context.__beforeReceiptReconcile = (_context, pairs, options) => {
      if (entered || options.reason !== 'risu_output') return;
      entered = true; assert.equal(pairs.length, 10);
      f.chat.message.push(...base.slice(0, 2).map((row, index) => ({ ...row, chatId: `t11-${index ? 'a' : 'u'}` })));
    };
    const result = await f.r.context.__receiptCore.scan({ reason: 'risu_output', maxBatches: 1, sourceStabilityDelay: 120 });
    assert.equal(entered, true);
    assert.equal(result.processed, 1, JSON.stringify(result));
    assert.equal(result.failed, 0);
    assert.equal(f.control.calls.length, 2, 'one original and one selected canonical analysis');
    for (let turn = 6; turn <= 10; turn++) assert.equal((await f.r.api.debugReadActiveCompletedTurnReceipt(turn)).status, 'verified');
    const memories = await f.r.api.getCanonicalMemories();
    assert.deepEqual(Array.from(memories, m => m.turnRange.start).sort((a, b) => a - b), [1, 6]);
  } finally { await s.cleanup(); }
});
test('cancellation during the recovery-ledger read does not dispatch an existing recovery worker', async () => {
  const s = await serverFixture({ mode: 'plugin_only', transformSource: expose });
  try {
    const f = s.f, h = f.r.context.__receiptPreparation, controller = new AbortController();
    const context = await h.resolveContext(), pairs = h.buildPairs(context.chat, context.scope.scopeKey);
    const identity = h.receiptRecoveryIdentity(context, pairs[0]);
    const jobId = 'receipt_' + h.digest(identity);
    const job = { jobId, scope: context.scope, identity,
      boundary: await h.captureReceiptRecoveryBoundary(context, pairs[0]),
      status: 'pending_write', reason: 'controlled_existing_unknown', writeOutcome: 'unknown', attempts: 1 };
    h.state.receiptRecoveryJobs.set(jobId, job);
    let dispatches = 0, ledgerRead = false;
    f.r.context.__onReceiptRecoveryDispatch = () => { dispatches++; };
    const get = s.backend.getItem;
    s.backend.getItem = async key => {
      if (key.endsWith(':receipt-recovery:v1')) { ledgerRead = true; controller.abort(); }
      return get(key);
    };
    await assert.rejects(h.prepareSelectedCompletedTurnReceipts(context, pairs, 1,
      { allowHistoricalBackfill: true, signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(ledgerRead, true);
    assert.equal(dispatches, 0, 'cancelled selected preparation must not start another recovery attempt');
    assert.equal(h.state.receiptRecoveryJobs.get(jobId), job, 'existing recovery identity and evidence stay retained');
    assert.equal(f.control.calls.length, 0);
    assert.equal([...s.local.keys()].some(key => key.includes(':source-receipt:')), false);
  } finally { await s.cleanup(); }
});
