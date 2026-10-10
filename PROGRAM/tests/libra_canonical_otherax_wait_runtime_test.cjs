'use strict';
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const expose = source => source.replace('const callLLMWithPreset = async', 'const callLLMWithPreset = globalThis.__waitGateway = async');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
async function test(name, action, transformSource = expose) {
  const f = await fixture({ transformSource });
  try { await action(f); results.push(name); }
  finally { await f.r.cleanup(); }
}
async function call(f, options = {}) {
  const settings = { presets: { host: { provider: 'risuai_aux', model: '', timeout_ms: 10 } }, defaultPresetName: 'host', stagePresetNames: { librarian: 'host' } };
  return await f.r.context.__waitGateway(settings, 'librarian', 'Return a JSON object.', 'Current source.', { taskKind: 'canonical_memory', maxTokens: 16384, ...options });
}
(async () => {
  await test('a submitted canonical OtherAx request can finish after the LIBRA batch deadline', async f => {
    f.control.onCall = async () => { await sleep(75); return { type: 'success', result: '{"ok":true}' }; };
    const result = await call(f, { deadlineAt: Date.now() + 40 });
    assert.equal(result.ok, true);
    assert.equal(f.control.calls.length,1,'one direct gateway request reaches the host');
    assert.equal(result.execution.requestCount, 1);
    assert.equal(result.execution.unknownOutcomes, 0);
    assert.equal(result.content, '{"ok":true}');
    assert.deepEqual(Object.keys(f.control.calls[0][0]).sort(), ['allowPlugins', 'messages', 'mode']);
  });
  await test('an already expired pre-submission budget does not submit to the host', async f => {
    await assert.rejects(() => call(f, { deadlineAt: Date.now() - 1 }), /deadline|TIMEOUT/i);
    assert.equal(f.control.calls.length, 0);
  });
  await test('non-canonical host probes keep their existing logical deadline', async f => {
    f.control.onCall = async () => { await sleep(65); return { type: 'success', result: '{"ok":true}' }; };
    await assert.rejects(() => call(f, { taskKind: 'connection_probe', deadlineAt: Date.now() + 30 }), error => error.code === 'OUTCOME_UNKNOWN_TIMEOUT');
    assert.equal(f.control.calls.length,1,'one non-canonical probe reaches the host');
    await sleep(75);
  });
  await test('explicit cancellation keeps the physical queue and discards the late first result', async f => {
    let resolveHost, started;
    const ready = new Promise(resolve => { started = resolve; });
    f.control.onCall = async () => {
      if (f.control.calls.length === 1) { started(); return await new Promise(resolve => { resolveHost = resolve; }); }
      return { type: 'success', result: '{"fresh":true}' };
    };
    const controller = new AbortController();
    const first = call(f, { signal: controller.signal, deadlineAt: Date.now() + 1000 });
    await ready; controller.abort();
    await assert.rejects(() => first, error => error.code === 'OUTCOME_UNKNOWN_CANCELLED');
    const second = call(f, { deadlineAt: Date.now() + 1000 });
    await sleep(25);
    assert.equal(f.control.calls.length,1,'cancellation cannot release the physical host queue');
    resolveHost({ type: 'success', result: '{"late_old":true}' });
    const result = await second;
    assert.equal(result.content, '{"fresh":true}');
    assert.equal(f.control.calls.length,2,'the queued direct request submits exactly once');
    assert.equal(f.getMemory(), null);
  });
  await test('a slow canonical host response commits memory and State beyond the simulated batch wall limit', async f => {
    f.control.onCall = async args => {
      // Reach the Canonical wire before the short batch budget expires. Micro
      // is a preceding independent job, not the request whose late result is tested.
      if(classifyCall(args)==='canonical')await sleep(1200);
      return { type: 'success', result: JSON.stringify(f.control.artifact) };
    };
    const job = await f.run();
    assert.equal(job.completed, 1, JSON.stringify(job));
    assert.equal(countCalls(f.control).canonical,1);
    assert.equal(f.getMemory().status, 'committed');
    assert.equal(f.getHead().throughTurn, 5);
    const run = [...f.r.values.values()].map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value?.runId === f.getManifest().runIds[0] && value?.commit?.providerBudget);
    assert.ok(run.commit.providerBudget.elapsedMs > 1000);
    assert.equal(run.commit.providerBudget.totalCalls, 1);
    assert.equal(f.r.api.getMemoryFailureDiagnostic('Host request outcome is still unknown; no automatic resubmission.').code, 'HOST_OUTCOME_UNKNOWN');
  }, source => {
    const needle = 'const defaultMaxWallMs = activeStageCount * 240000 + 30000;';
    assert.ok(source.includes(needle));
    return source.replace(needle, 'const defaultMaxWallMs = 1000;');
  });
  await test('cancelled canonical host work must physically finish before fresh analysis can discard its records', async f => {
    let started, resolveHost;
    const ready = new Promise(resolve => { started = resolve; });
    f.control.onCall = async args => {
      if (classifyCall(args)==='canonical' && countCalls(f.control).canonical===1) { started(); return await new Promise(resolve => { resolveHost = resolve; }); }
      return { type:'success', result:JSON.stringify(f.control.artifact) };
    };
    const first = f.run();
    await ready;
    await f.r.api.cancelCanonicalJob({});
    assert.equal((await first).state, 'cancelled');
    const oldRecords = [...f.r.values.entries()].filter(([key]) => key.includes(':work:') || key.includes(':run:'));
    assert.ok(oldRecords.length >= 2);
    try {
      await assert.rejects(() => f.run(), /CANONICAL_HOST_REQUEST_PENDING/);
      assert.equal(countCalls(f.control).canonical,1);
      for (const [key, value] of oldRecords) assert.equal(f.r.values.get(key), value, 'pending host work is not discarded');
    } finally { resolveHost({ type:'success', result:JSON.stringify(f.control.artifact) }); }
    for (let i=0;i<50 && f.r.api.getRuntime().risuAuxiliary.inFlight;i++) await sleep(10);
    assert.equal(f.r.api.getRuntime().risuAuxiliary.inFlight, false);
    assert.equal(f.getMemory(), null, 'cancelled late response cannot be committed');
    assert.equal((await f.run()).completed, 1);
    assert.equal(countCalls(f.control).canonical,2);
    for (const [key] of oldRecords) assert.equal(f.r.values.has(key), false, 'new successful analysis leaves no old execution record');
  });
  console.log(`libra_canonical_otherax_wait_runtime_test: PASS (${results.length} scenarios)`);
})().catch(error => { console.error(error.message, String(error.stack).split('\n').filter(line => /^\s+at /.test(line)).join('\n')); process.exitCode = 1; });
