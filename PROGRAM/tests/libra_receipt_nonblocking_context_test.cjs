'use strict';
const assert = require('node:assert/strict');
const {AsyncLocalStorage} = require('node:async_hooks');
const gateOperation = new AsyncLocalStorage();
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {countCalls} = require('./fixtures/libra_provider_call_kinds.cjs');

// Current Classic/read-only consumers replace removed embedded Planner/GRADIA/
// InputWriter endpoints. This file still drives the registered beforeRequest.
// Raw failure/preimage and the complete original-41-site map live in successor016.
const MARKER = 'TASK5_ONLY_IN_COMPLETED_ASSISTANT_4826';
const CANONICAL = '공연 허가자가 누구인지 아직 밝혀지지 않았다.';
const CANONICAL_QUERY = '공연 허가자는 밝혀졌나?';
const INPUT = 'Continue the scene';
const CALL_MS = 3500, ENTRY_MS = 5000, DRAIN_MS = 2000, CLEANUP_MS = 3000;
// Keep room for gate draining and fixture cleanup under the unchanged 60s runner.
const workDeadline = Date.now() + 52000;
const plain = value => JSON.parse(JSON.stringify(value));
const textOf = messages => messages.map(row => String(row.content || '')).join('\n');
const rows = local => [...local].flatMap(([key, raw]) => {
  try { return [{key, raw, value: JSON.parse(raw)}]; } catch { return []; }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
async function bounded(promise, ms, label, cleanup = false) {
  const allowance = cleanup ? ms : Math.min(ms, workDeadline - Date.now());
  let timer;
  try {
    if (allowance <= 0) throw Error(`${label}: fixture work budget exhausted`);
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label}: exceeded ${allowance}ms`)), allowance);
    })]);
  } finally { clearTimeout(timer); }
}
async function settleMicro(f) {
  const deadline = Math.min(workDeadline, Date.now() + 5000);
  while (f.r.api.getCaptureBackendState().microQueuedJobs !== 0) {
    if (Date.now() >= deadline) throw Error('existing Micro queue did not settle within its fixture bound');
    await delay(10);
  }
}
function uniqueRow(fx, predicate, label) {
  const found = rows(fx.local).filter(predicate);
  assert.equal(found.length, 1, `fixture has one ${label}`);
  return found[0];
}
function canonicalWitness(fx) {
  const manifest = uniqueRow(fx, row => row.value.schema === 'libra.manifest.v1'
    && row.value.memories?.['1']?.status === 'committed', 'committed manifest');
  const ref = manifest.value.memories['1'];
  const raw = fx.local.get(ref.key);
  assert.equal(typeof raw, 'string', 'Canonical ref resolves to existing local bytes');
  const memory = JSON.parse(raw);
  assert.ok(memory.canonicalArtifact?.facts?.some(fact => fact.text === CANONICAL),
    'the exact original Canonical positive is admitted before any receipt fault');
  assert.doesNotMatch(JSON.stringify(memory.canonicalArtifact), new RegExp(MARKER),
    'the raw-only marker is not a Canonical artifact fact');
  return {key: ref.key, memory};
}
async function withFixture(name, body) {
  const fx = await serverFixture({mode: 'plugin_only', args: {
    live_context_enabled: 'true', classic_live_tail_enabled: 'true', live_tail_max_turns: '4'}});
  let failure;
  try {
    fx.f.chat.message[9].data += ` ${MARKER}`;
    const run = await bounded(fx.f.run(), 15000, `${name}: cold start`);
    assert.equal(run.completed, 1, `${name}: Canonical producer completes`);
    await settleMicro(fx.f);
    await fx.f.r.api.saveLibraProviderConfig({responseFamily: 'libra', libraResponseMode: 'classic'});
    const receipt = uniqueRow(fx, row => row.value.schema === 'libra.completed_turn_receipt.v1'
      && row.value.turn === 5, 'T5 receipt');
    const head = uniqueRow(fx, row => row.value.schema === 'libra.completed_turn_head.v1'
      && row.value.turn === 5, 'T5 receipt head');
    assert.equal(head.value.receiptKey, receipt.key);
    await body(fx, {receipt, head, canonical: canonicalWitness(fx)});
  } catch (error) { failure = error; }
  finally {
    try { await bounded(fx.cleanup(), CLEANUP_MS, `${name}: cleanup`, true); }
    catch (error) { failure = failure ? new AggregateError([failure, error], name) : error; }
  }
  if (failure) throw failure;
}
function currentSnapshot(fx, messages, previousRequestId, input) {
  const context = fx.f.r.api.getLastResponseContext();
  assert.ok(context?.requestId, 'actual current consumer publishes a response context');
  assert.notEqual(context.requestId, previousRequestId, 'diagnostic belongs to this call');
  assert.equal(context.values.currentInput, input, 'current user input remains distinct');
  return {messages, context, tail: fx.f.r.api.getLastLiveTail(),
    viewer: fx.f.r.api.getLastMemoryRecallViewer()};
}
async function hook(fx, input = INPUT) {
  const previous = fx.f.r.api.getLastResponseContext()?.requestId;
  const calls = countCalls(fx.f.control);
  const messages = await bounded(fx.f.control.hooks.beforeRequest([{role: 'user', content: input}], 'model'),
    CALL_MS, 'actual beforeRequest');
  assert.deepEqual(countCalls(fx.f.control), calls, 'settled consumer adds no helper or other model calls');
  return currentSnapshot(fx, messages, previous, input);
}
function assertReady(snapshot) {
  // Original 22–25, plus a positive actual-delivery control for later non-leak checks.
  assert.equal(snapshot.context.route, 'classic');
  assert.equal(snapshot.context.receiptReadSet.status, 'complete');
  assert.deepEqual(Array.from(snapshot.context.receiptReadSet.refs, ref => ref.turn), [1,2,3,4,5]);
  assert.equal(snapshot.tail?.available, true, 'ready receipt context is available');
  assert.match(snapshot.tail?.transcript || '', new RegExp(MARKER));
  assert.match(textOf(snapshot.messages), new RegExp(MARKER), 'ready T5 actually reaches Classic');
  assert.equal(snapshot.context.receiptReadSet.readSetDigest, snapshot.tail.receiptReadSetDigest);
  assert.equal(snapshot.tail.sourceMode, 'verified_completed_receipts');
}
function assertPartial(snapshot, input = INPUT) {
  // Original 45–50,58,60–61,66,68,144,154,156,187–193; no raw-chat refill.
  const {context, tail, messages} = snapshot;
  assert.equal(context.receiptReadSet.status, 'partial');
  assert.deepEqual(Array.from(context.receiptReadSet.gaps, gap => gap.turn), [5]);
  assert.deepEqual(Array.from(context.receiptReadSet.refs, ref => ref.turn), [1,2,3,4]);
  assert.deepEqual(Array.from(tail?.sourcePairs || [], pair => pair.turn), [2,3,4]);
  assert.equal(tail.completeRequestedCoverage, false);
  assert.equal(tail.sourceMode, 'verified_completed_receipts');
  assert.equal(context.receiptReadSet.readSetDigest, tail.receiptReadSetDigest);
  assert.doesNotMatch(tail.transcript, new RegExp(MARKER));
  assert.doesNotMatch(JSON.stringify(context.values.liveTail), new RegExp(MARKER));
  assert.doesNotMatch(String(context.values.terminalScene || ''), new RegExp(MARKER));
  assert.equal(context.values.currentInput, input);
  if (messages) {
    assert.doesNotMatch(textOf(messages), new RegExp(MARKER));
    assert.ok(messages.some(row => row.role === 'user' && row.content === input),
      'the main request continues with the exact current user input');
  }
}
function assertCanonical(snapshot, witness) {
  const {context, viewer, messages} = snapshot, {memory, key} = witness;
  const blocks = messages.filter(row => row.role === 'system'
    && String(row.content || '').includes('[LIBRA CLASSIC RECALL'));
  assert.ok(blocks.length > 0, 'an actual Classic system block is delivered');
  const block = textOf(blocks);
  // Original 69–72, unchanged positive meaning and exact sentence.
  assert.match(block, /공연 허가자가 누구인지 아직 밝혀지지 않았다\./,
    'ready Canonical remains available while the latest receipt is missing or slow');
  assert.equal(context.scopeKey, memory.scopeKey);
  assert.equal(viewer.responseContextRequestId, context.requestId);
  assert.equal(viewer.responseContextDigest, context.contextDigest);
  assert.equal(context.values.currentHead, null, 'raw State is not the Canonical source');
  const delivered = Array.from(viewer.rows || []).filter(row => row.kind === 'canonical'
    && row.classicUsed === true && row.injected === true
    && String(row.selectedText || row.text || '').includes(CANONICAL));
  assert.ok(delivered.length > 0, 'the exact fact is in an actually injected Canonical row');
  for (const row of delivered) {
    for (const field of ['memoryId', 'revision', 'sourceDigest', 'artifactDigest', 'scopeKey']) {
      assert.equal(row[field], memory[field], `injected Canonical ${field} binds to admitted bytes`);
    }
    assert.ok(block.includes(String(row.selectedText || row.text)), 'whole selected Canonical text is delivered');
    const refs = Array.from(context.canonicalRefs || []).filter(ref => ref.memoryId === row.memoryId
      && ref.revision === row.revision && ref.sourceDigest === row.sourceDigest
      && ref.artifactDigest === row.artifactDigest);
    assert.equal(refs.length, 1, 'one same-request sealed Canonical identity');
    assert.equal(refs[0].key, key, 'sealed identity resolves to the pre-existing Canonical key');
  }
}
function canonicalNegativeControls(snapshot, witness) {
  // These corrupt copies of actual observations, never production data or execution.
  const absent = plain(snapshot); absent.messages = absent.messages.filter(row => row.role !== 'system');
  assert.throws(() => assertCanonical(absent, witness), assert.AssertionError,
    'the oracle rejects absent real output');
  const wrongIdentity = plain(snapshot);
  for (const row of wrongIdentity.viewer.rows || []) if (row.kind === 'canonical') row.memoryId = 'wrong-memory';
  assert.throws(() => assertCanonical(wrongIdentity, witness), assert.AssertionError,
    'the oracle rejects a fact attributed to a different memory');
  const wrongRef = plain(snapshot);
  for (const ref of wrongRef.context.canonicalRefs || []) ref.key += ':wrong';
  assert.throws(() => assertCanonical(wrongRef, witness), assert.AssertionError,
    'the oracle rejects a sealed ref pointing elsewhere');
}
function installReadGate(fx, key, admit, operationToken) {
  const originalGet = fx.backend.getItem;
  const entered = deferred(), released = deferred(), physicalDone = deferred();
  let hits = 0;
  fx.backend.getItem = async candidate => {
    if (hits === 0 && candidate === key && gateOperation.getStore() === operationToken && admit()) {
      hits += 1;
      entered.resolve({key: candidate, operationToken, requestId: fx.f.r.api.getLastResponseContext()?.requestId});
      try { await released.promise; return await originalGet(candidate); }
      finally { physicalDone.resolve(); }
    }
    return originalGet(candidate);
  };
  return {entered: entered.promise, physicalDone: physicalDone.promise, hits: () => hits,
    release: () => released.resolve(), restore: () => { fx.backend.getItem = originalGet; }};
}
async function withReadGate(fx, key, admit, call, body) {
  const operationToken = Object.freeze({id: Symbol('selected receipt consumer')});
  const gate = installReadGate(fx, key, admit, operationToken);
  let pending, settled, value, failure;
  const started = Date.now();
  try {
    pending = gateOperation.run(operationToken, () => Promise.resolve().then(call));
    // Observe rejection immediately; Promise.race is not cancellation.
    settled = pending.then(result => ({ok: true, result}), error => ({ok: false, error}));
    const entry = await bounded(Promise.race([gate.entered, settled.then(() => {
      throw Error('current consumer returned before reaching the required physical read gate');
    })]), Math.min(ENTRY_MS, CALL_MS), 'physical gate entry');
    assert.equal(entry.key, key);
    assert.equal(entry.operationToken, operationToken, 'the pending read belongs to this selected async consumer');
    assert.equal(gate.hits(), 1, 'the exact actual physical read is pending');
    const finish = () => bounded(pending, Math.max(1, CALL_MS - (Date.now() - started)), 'held consumer return');
    value = await body({gate, entry, finish});
  } catch (error) { failure = error; }
  finally {
    gate.release();
    gate.restore();
    try {
      const drains = [settled];
      if (gate.hits()) drains.push(gate.physicalDone);
      const outcomes = await bounded(Promise.all(drains), DRAIN_MS, 'held call and physical read drain', true);
      if (!failure && outcomes[0]?.ok === false) failure = outcomes[0].error;
    } catch (error) { failure = failure ? new AggregateError([failure, error], 'gate cleanup') : error; }
  }
  if (failure) throw failure;
  return value;
}
// Test-only operation attribution controls. They do not import or call a product.
async function verifyGateOperationControls() {
  const owner = Object.freeze({id: Symbol('owned control')});
  let reads = 0;
  const fake = {backend: {getItem: async key => { reads++; return `value:${key}`; }},
    f: {r: {api: {getLastResponseContext: () => ({requestId: 'control-request'})}}}};
  const original = fake.backend.getItem;
  const gate = installReadGate(fake, 'owned-head', () => true, owner);
  const pending = [], observe = promise => { pending.push(promise.then(value => ({value}), error => ({error}))); return promise; };
  try {
    assert.equal(await bounded(observe(gateOperation.run(Object.freeze({id: Symbol('other operation')}),
      () => fake.backend.getItem('owned-head'))), 1000, 'wrong-operation control'), 'value:owned-head');
    assert.equal(gate.hits(), 0, 'a different operation cannot open the same-key gate');
    assert.equal(await bounded(observe(fake.backend.getItem('owned-head')), 1000, 'unowned-read control'), 'value:owned-head');
    assert.equal(gate.hits(), 0, 'an unowned same-key read cannot open the gate');
    const selected = observe(gateOperation.run(owner, () => fake.backend.getItem('owned-head')));
    const entered = await bounded(gate.entered, 1000, 'owned-read control');
    assert.equal(entered.operationToken, owner);
    assert.equal(gate.hits(), 1);
    assert.equal(reads, 2, 'the selected physical read is still held while unrelated reads completed');
    gate.release();
    assert.equal(await bounded(selected, 1000, 'owned-read completion'), 'value:owned-head');
    assert.equal(reads, 3);
  } finally {
    gate.release(); gate.restore();
    await bounded(Promise.all(pending), DRAIN_MS, 'operation-control drains', true);
    if (gate.hits()) await bounded(gate.physicalDone, DRAIN_MS, 'operation-control physical drain', true);
    assert.equal(fake.backend.getItem, original);
  }
  console.log('PASS gate operation controls: wrong token and unowned reads rejected; owned read held and drained');
}

const observations = [];

(async () => {
  await verifyGateOperationControls();
  await withFixture('missing receipt', async (fx, prepared) => {
    const {f, local} = fx;
    assertReady(await hook(fx));
    local.delete(prepared.receipt.key);
    assert.match(f.chat.message[9].data, new RegExp(MARKER), 'raw host source remains present');
    f.character.lorebook = [{id: 'missing-receipt-trigger', name: 'Missing receipt trigger',
      content: 'LORE_ACTIVATED_ONLY_BY_MISSING_RECEIPT_6732', keys: [MARKER], priority: 100,
      enabled: true, constant: false, selective: false, excludeRecursion: false, preventRecursion: false}];
    // Original 34,42–44,63,76–77: helper endpoints/response-lore diagnostics retired.
    // Keep nonempty native lore; independent native ranking is not raw-dialogue proof.
    const missing = await hook(fx); assertPartial(missing);
    const contaminated = plain(missing); contaminated.context.values.terminalScene += ` ${MARKER}`;
    assert.throws(() => assertPartial(contaminated), assert.AssertionError,
      'the current-consumer oracle rejects raw marker contamination');
    const previous = f.r.api.getLastResponseContext()?.requestId, calls = countCalls(f.control);
    const readOnly = await bounded(f.r.api.getResponseContext({currentInput: INPUT}), CALL_MS, 'missing read-only context');
    assert.notEqual(readOnly.requestId, previous);
    assertPartial({context: readOnly, tail: f.r.api.getLastLiveTail()});
    assert.deepEqual(countCalls(f.control), calls);
    assert.equal((await bounded(f.r.api.validateResponseContext(readOnly), CALL_MS, 'partial snapshot validation')).ok, true);
    assertPartial(await hook(fx)); // Original 66–68: repeated Classic cannot resurrect T5.
    const canonical = await hook(fx, CANONICAL_QUERY);
    assertPartial(canonical, CANONICAL_QUERY); assertCanonical(canonical, prepared.canonical);
    canonicalNegativeControls(canonical, prepared.canonical);
    const frozenMissing = JSON.stringify(missing.context);
    local.set(prepared.receipt.key, prepared.receipt.raw);
    assertReady(await hook(fx));
    assert.equal(JSON.stringify(missing.context), frozenMissing, 'later restoration cannot rewrite the returned partial context');
    observations.push({case: 'missing', gaps: [5], liveTurns: [2,3,4], canonical: CANONICAL, restoredReady: true});
  });

  for (const edit of [false, true]) {
    await withFixture(`final receipt read ${edit ? 'edit' : 'no edit'}`, async (fx, prepared) => {
      const {f} = fx, input = [{role: 'user', content: INPUT}];
      const previous = f.r.api.getLastResponseContext()?.requestId, calls = countCalls(f.control);
      let changed = false;
      await withReadGate(fx, prepared.head.key, () => {
        const context = f.r.api.getLastResponseContext();
        return !!context?.requestId && context.requestId !== previous && context.route === 'classic'
          && context.receiptReadSet?.refs?.some(ref => ref.turn === 5 && ref.headKey === prepared.head.key);
      }, () => f.control.hooks.beforeRequest(input, 'model'), async ({gate, entry, finish}) => {
        const captured = f.r.api.getLastResponseContext();
        assert.equal(entry.requestId, captured.requestId);
        assert.match(captured.values.liveTail?.transcript || '', new RegExp(MARKER),
          'the awaited final read follows a marker-containing sealed projection');
        if (edit) { f.chat.message[9].data += ' EDITED_AFTER_READ'; changed = true; }
        gate.release(); // Mutate/release synchronously, within the unchanged 1500ms product guard.
        const delivered = await finish();
        assert.equal(changed, edit, 'the source-edit arm really changed source while the physical read was held');
        if (edit) {
          // Original 91–94 and109–111 retain their source-currentness outcome here.
          assert.deepEqual(plain(delivered), input, 'stale source omits augmentation and preserves the main request');
          assert.doesNotMatch(textOf(delivered), new RegExp(MARKER));
          assert.equal(f.r.api.getLastMemoryRecallViewer()?.errorCode, 'LIBRA_RECENT_RECEIPT_STALE',
            'the negative reaches current receipt rejection, not an unrelated empty recall');
        } else {
          assertReady(currentSnapshot(fx, delivered, previous, INPUT));
          assert.match(textOf(delivered), /Continue the scene/, 'the same read gate permits unchanged current source');
        }
        assert.equal(gate.hits(), 1);
      });
      assert.deepEqual(countCalls(f.control), calls, 'the race runs without a retired provider stage');
      observations.push({case: edit ? 'source_edit_refused' : 'same_gate_no_edit_delivered', physicalReadGateEntered: true});
    });
  }

  await withFixture('slow receipt', async (fx, prepared) => {
    const {f} = fx;
    assertReady(await hook(fx)); // Original126: prove prior available context before holding T5.
    f.character.lorebook = [{id: 'delayed-raw-trigger', name: 'Delayed raw trigger',
      content: 'LORE_FROM_TIMED_OUT_RAW_CHAT_9081', keys: [MARKER], priority: 100,
      enabled: true, constant: false, selective: false}];
    for (const consumer of ['hook', 'canonical_hook', 'read_only']) {
      const input = consumer === 'canonical_hook' ? CANONICAL_QUERY : INPUT;
      const previous = f.r.api.getLastResponseContext()?.requestId, calls = countCalls(f.control);
      await withReadGate(fx, prepared.receipt.key, () => true,
        () => consumer === 'read_only' ? f.r.api.getResponseContext({currentInput: input})
          : f.control.hooks.beforeRequest([{role: 'user', content: input}], 'model'),
        async ({gate, finish}) => {
          const result = await finish(); // Gate stays held: only the real receipt deadline can return.
          const snapshot = consumer === 'read_only'
            ? {context: result, tail: f.r.api.getLastLiveTail()}
            : currentSnapshot(fx, result, previous, input);
          assert.notEqual(snapshot.context.requestId, previous);
          assertPartial(snapshot, input);
          if (consumer === 'canonical_hook') assertCanonical(snapshot, prepared.canonical);
          const tailHash = snapshot.tail.hash, requestId = snapshot.context.requestId;
          const returnedBytes = JSON.stringify(snapshot.context);
          gate.release();
          await bounded(gate.physicalDone, DRAIN_MS, 'late physical receipt completion');
          await delay(100); // Original159: allow the losing completion to finish; no timer remains.
          assert.equal(f.r.api.getLastLiveTail()?.hash, tailHash,
            'a late T5 read cannot overwrite this selected partial tail');
          assert.equal(f.r.api.getLastResponseContext()?.requestId, requestId);
          assert.equal(JSON.stringify(snapshot.context), returnedBytes, 'late read cannot change the returned snapshot');
          assert.equal(gate.hits(), 1); // Original180: required delayed read was actually exercised.
        });
      assert.deepEqual(countCalls(f.control), calls, 'slow consumer does not start a helper provider');
      observations.push({case: `slow_${consumer}`, gaps: [5], liveTurns: [2,3,4], physicalReadGateEntered: true});
    }
    // Original147,150–152,195 retire only old response helper observations. Current
    // hook/read-only non-leak and bounded partial projections were executed above.
    assertReady(await hook(fx));
  });
  assert.deepEqual(observations.map(row => row.case), ['missing', 'same_gate_no_edit_delivered',
    'source_edit_refused', 'slow_hook', 'slow_canonical_hook', 'slow_read_only'],
    'all six required current-consumer cases reached their final assertions');
  console.log(JSON.stringify({test: 'libra_receipt_nonblocking_context', route: 'classic',
    completedCases: observations.length, observations}));
  console.log('PASS actual Classic/read-only receipt exclusion, Canonical availability, and executed source-currentness race');
})().catch(error => { console.error(error); process.exitCode = 1; });
