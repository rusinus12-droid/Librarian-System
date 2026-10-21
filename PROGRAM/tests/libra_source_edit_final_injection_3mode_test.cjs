'use strict';
// An explicit selected-source replacement must reach the real Classic request
// in all storage modes, with physical identity and publication boundaries intact.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { actualClassicPacket } = require('./fixtures/libra_actual_classic_request.cjs');
const { countCalls } = require('./fixtures/libra_provider_call_kinds.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const QUERY = '민아의 은빛 열쇠를 지금 누가 갖고 있어?';
const OLD_FACT = '지호가 열쇠를 민아에게 반환했다.';
const NEW_FACT = '지호는 은빛 열쇠를 아직 반환하지 않았다.';
const EDITED_SOURCE = '서재에서 지호는 은빛 열쇠를 민아에게 반환하지 않았다. 반환 약속은 아직 남았다. 공연 허가자는 알려지지 않았다.';
const parse = raw => raw === undefined ? null : JSON.parse(raw);
const manifestOf = (snapshot, mode) => mode === 'plugin_only'
  ? parse(snapshot.local.get([...snapshot.local.keys()].find(key => key.endsWith(':manifest'))))
  : snapshot.getManifest();
const rawOf = (snapshot, mode, key) => mode === 'plugin_only'
  ? snapshot.local.get(key)
  : snapshot.storedRows().find(row => row.key === key)?.raw;
const setDurable = async (snapshot, mode, key, value) => {
  if (mode !== 'server_only') snapshot.local.set(key, JSON.stringify(value));
  if (mode !== 'plugin_only') await snapshot.mutate(key, value);
};
const removeDurable = async (snapshot, mode, key) => {
  if (mode !== 'server_only') snapshot.local.delete(key);
  if (mode !== 'plugin_only') await snapshot.mutate(key, null, 'remove');
};
const injection = messages => {
  const blocks = messages.filter(message => String(message?.content || '').includes('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]'));
  assert.equal(blocks.length, 1, 'one Classic recall block reaches the model request');
  return String(blocks[0].content);
};
const editedArtifact = () => {
  const next = artifact();
  for (const row of [...next.entities, ...next.facts]) {
    for (const span of row.evidenceSpans || []) if (span.ref === 't5-a') span.quote = EDITED_SOURCE;
  }
  const possession = next.facts.find(row => row.tempFactId === 'f11');
  possession.values.holderRef = 'jiho';
  possession.text = NEW_FACT;
  const promise = next.facts.find(row => row.tempFactId === 'f12');
  promise.values.thread.status = 'open';
  promise.text = '반환 약속은 아직 이행되지 않았다.';
  return next;
};

const selectReplacement = async f => {
  const calls = countCalls(f.control);
  const selection = await f.r.api.listCanonicalBatchRanges();
  const ranges = selection.ranges.filter(row => row.startTurn === 1);
  assert.equal(ranges.length, 1, 'one exact saved five-turn range is selected');
  assert.equal(ranges[0].status, 'saved');
  assert.deepEqual(countCalls(f.control), calls, 'range inspection is model-free');
  return { scopeKey: selection.scopeKey, mode: 'source_edit', ranges };
};
const classic = async (f, scopeKey) => {
  const packet = await actualClassicPacket(f, QUERY, scopeKey);
  assert.equal(packet.actualClassic.block.split('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]').length - 1, 1,
    'exactly one Classic block reaches this request');
  return packet;
};

async function check(mode) {
  const options = { mode };
  const snapshot = await serverFixture(options);
  try {
    const f = snapshot.f;
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    assert.equal((await f.run()).completed, 1, `${mode}: initial canonical commits`);
    // Settle the initial derived-vector acknowledgement before pinning exact
    // canonical bytes; replacement must preserve that durable preimage.
    await f.r.api.retryPendingUnifiedVectors();
    const oldRef = manifestOf(snapshot, mode).memories['1'];
    const oldBytes = rawOf(snapshot, mode, oldRef.key);
    const initial = injection(await f.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model'));
    assert.match(initial, /지호가 열쇠를 민아에게 반환했다\./, `${mode}: control delivers the original fact`);

    // A same-slot edit retains the approved analysis until the explicit
    // selection succeeds. Requests and range inspection do no analysis.
    f.chat.message[9].data = EDITED_SOURCE;
    f.control.artifact = editedArtifact();
    const callsBefore = countCalls(f.control);
    const selection = await selectReplacement(f);
    const approved = await classic(f, selection.scopeKey);
    assert.match(approved.actualClassic.block, /지호가 열쇠를 민아에게 반환했다\./,
      `${mode}: request retains the approved same-slot canonical before replacement`);
    assert.equal(manifestOf(snapshot, mode).memories['1'].key, oldRef.key);
    assert.equal(rawOf(snapshot, mode, oldRef.key), oldBytes);
    assert.deepEqual(countCalls(f.control), callsBefore, `${mode}: observing an edit adds no provider call`);

    const result = await f.r.api.startSelectedCanonicalBatches(selection);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.job.completed, 1);
    assert.equal(result.job.failed, 0);
    assert.equal(countCalls(f.control).canonical, callsBefore.canonical + 1,
      `${mode}: only the selected replacement adds one Canonical call`);
    const firstPostEditRequestStartedAt = performance.now();
    const packet = await classic(f, selection.scopeKey);
    const firstPostEditRequestElapsedMs = Math.round(performance.now() - firstPostEditRequestStartedAt);
    const after = packet.actualClassic.block;
    const currentRef = manifestOf(snapshot, mode).memories['1'];
    const activeBodyRaw = currentRef?.key ? rawOf(snapshot, mode, currentRef.key) : null;
    const activeBody = activeBodyRaw ? parse(activeBodyRaw) : null;
    const sealedRefs = Array.from(packet.actualClassic.context.canonicalRefs || []);
    assert.equal(sealedRefs.filter(ref => ref.key === currentRef.key
      && ref.memoryId === currentRef.memoryId && ref.revision === currentRef.revision
      && ref.sourceDigest === currentRef.sourceDigest && ref.artifactDigest === currentRef.artifactDigest).length, 1,
      `${mode}: this request seals the exact durable replacement identity`);
    assert.ok(currentRef.revision > oldRef.revision, `${mode}: source edit commits a new revision`);
    assert.ok(activeBody, `${mode}: the active canonical body is physically readable`);
    assert.equal(activeBody.memoryId, currentRef.memoryId, `${mode}: durable body identity matches the active ref`);
    assert.equal(activeBody.revision, currentRef.revision, `${mode}: durable body revision matches the active ref`);
    assert.equal(activeBody.sourceDigest, currentRef.sourceDigest, `${mode}: durable body source digest matches the active ref`);
    assert.equal(activeBody.artifactDigest, currentRef.artifactDigest, `${mode}: durable body artifact digest matches the active ref`);
    assert.equal(rawOf(snapshot, mode, oldRef.key), oldBytes, `${mode}: prior canonical bytes are immutable`);
    assert.match(after, /지호는 은빛 열쇠를 아직 반환하지 않았다\./, `${mode}: final injection uses replacement`);
    assert.ok(!after.includes(OLD_FACT), `${mode}: final injection omits superseded original text`);
    const preview = await f.r.api.previewUnifiedMemoryRecall(QUERY);
    // Scope the revision assertions to CANONICAL rows. Micro rows carry their own revision numbering
    // (a one-turn Micro is revision 1 of its own record) and Canonical rows leave `kind` unset, so a
    // bare `row.memory.revision === 1` match reported "recall resolves the retired revision" while the
    // retired Canonical revision was in fact absent (measured: the only canonical row was the new
    // revision, and the 1s were Micro rows).
    const canonicalRows = Array.from(preview.memories || []).filter(row => row.memory?.kind !== 'micro');
    assert.ok(canonicalRows.some(row => Number(row.memory?.revision) === Number(currentRef.revision)),
      `${mode}: recall resolves the current canonical revision`);
    assert.ok(!canonicalRows.some(row => Number(row.memory?.revision) === Number(oldRef.revision)),
      `${mode}: recall does not resolve the retired canonical revision`);
    if (mode === 'plugin_only') assert.equal(snapshot.requests.length, 0, 'plugin_only makes no LIBRA server request');
    if (mode === 'server_only') assert.equal([...snapshot.local.keys()].some(key => key.includes(':memory:') || key.endsWith(':manifest')), false, 'server_only has no local canonical substitute');

    // The retired persisted recall catalog is never written any more: the unified engine reads the
    // active canonical directly, so a restart has no derived search hint that could go stale.
    const persistedKeys = mode === 'plugin_only' ? [...snapshot.local.keys()] : snapshot.storedRows().map(row => row.key);
    assert.equal(persistedKeys.some(key => key.endsWith(':recall-catalog:v1')), false, `${mode}: no retired recall catalog is persisted`);
    options.snapshot = { chat: f.chat };
    const restarted = await snapshot.restart();
    restarted.control.artifact = editedArtifact();
    await restarted.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    const restartedBlock = injection(await restarted.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model'));
    assert.match(restartedBlock, /지호는 은빛 열쇠를 아직 반환하지 않았다\./, `${mode}: restarted runtime delivers the current canonical`);
    assert.ok(!restartedBlock.includes(OLD_FACT), `${mode}: restarted runtime never delivers superseded text`);

    // Each corrupted variant is tested in a fresh runtime so request-local
    // caches cannot hide a loader that trusts the r2 key without checking it.
    for (const variant of [
      'wrong_memory_id', 'wrong_revision', 'wrong_source_digest',
      'missing_memory_id', 'missing_revision', 'missing_source_digest', 'missing_body'
    ]) {
      if (variant === 'missing_body') await removeDurable(snapshot, mode, currentRef.key);
      else {
        const damaged = parse(oldBytes);
        // Hold two dimensions at the active ref so each corruption tests one
        // explicit identity field rather than being rejected by another one.
        if (variant !== 'wrong_memory_id' && variant !== 'missing_memory_id') damaged.memoryId = currentRef.memoryId;
        if (variant !== 'wrong_revision' && variant !== 'missing_revision') damaged.revision = currentRef.revision;
        if (variant !== 'wrong_source_digest' && variant !== 'missing_source_digest') damaged.sourceDigest = currentRef.sourceDigest;
        if (variant === 'wrong_memory_id') damaged.memoryId = 'foreign-memory-id';
        if (variant === 'missing_memory_id') delete damaged.memoryId;
        if (variant === 'missing_revision') delete damaged.revision;
        if (variant === 'missing_source_digest') delete damaged.sourceDigest;
        await setDurable(snapshot, mode, currentRef.key, damaged);
      }
      options.snapshot = { chat: snapshot.f.chat };
      const corrupted = await snapshot.restart();
      corrupted.control.artifact = editedArtifact();
      await corrupted.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
      const corruptOutput = await corrupted.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model');
      const corruptBlocks = corruptOutput.filter(message => String(message?.content || '').includes('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]'));
      assert.ok(corruptBlocks.every(message => !String(message.content).includes(OLD_FACT)), `${mode}/${variant}: invalid active body cannot inject r1 as current`);
      const corruptPreview = await corrupted.r.api.previewUnifiedMemoryRecall(QUERY);
      // Same scoping as above: only Canonical rows carry the retired-revision question. A Micro row's
      // own revision 1 is not the retired Canonical revision.
      const corruptCanonical = Array.from(corruptPreview.memories || []).filter(row => row.memory?.kind !== 'micro');
      assert.ok(!corruptCanonical.some(row => Number(row.memory?.revision) === Number(oldRef.revision)),
        `${mode}/${variant}: invalid body cannot hydrate the retired canonical revision from the current manifest ref`);
    }
    if (mode === 'plugin_only') assert.equal(snapshot.requests.length, 0, 'plugin_only remains offline after reload and corruption checks');
    if (mode === 'server_only') assert.equal([...snapshot.local.keys()].some(key => key.includes(':memory:') || key.endsWith(':manifest')), false, 'server_only never persists a local canonical substitute');
    return { mode, oldRevision: oldRef.revision, currentRevision: currentRef.revision,
      firstPostEditRequestElapsedMs, replacementJobState: result.job.state,
      activeBodyIdentityReadback: true, restartedRuntimeDeliveredCurrent: true,
      corruptedBodyVariantsRejected: 7, finalBlock: after };
  } finally { await snapshot.cleanup(); }
}

// Hold the real mirror write acknowledgement after the new body is durable, before
// the active manifest can publish it. This tests publication, without a retired
// automatic tracker or a delay injected into production source.
async function checkPendingPublication() {
  const snapshot = await serverFixture({ mode: 'mirror' });
  const originalSet = snapshot.backend.setItem;
  let release, work;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const f = snapshot.f;
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    assert.equal((await f.run()).completed, 1);
    await f.r.api.retryPendingUnifiedVectors();
    const oldRef = manifestOf(snapshot, 'mirror').memories['1'];
    const oldBytes = rawOf(snapshot, 'mirror', oldRef.key);
    f.chat.message[9].data = EDITED_SOURCE;
    f.control.artifact = editedArtifact();
    const selection = await selectReplacement(f);
    let pendingBody = null;
    snapshot.backend.setItem = async (key, raw) => {
      const written = await originalSet(key, raw);
      let value;
      try { value = JSON.parse(raw); } catch { return written; }
      if (pendingBody || value?.schema !== 'libra.canonical_memory.v1'
        || value.status !== 'candidate' || value.revision <= oldRef.revision) return written;
      pendingBody = snapshot.storedRows().find(row => row.key === key);
      assert.ok(pendingBody, 'replacement body is physically durable before its acknowledgement');
      await gate;
      return written;
    };
    work = f.r.api.startSelectedCanonicalBatches(selection);
    await waitFor(() => pendingBody, 15000);
    assert.equal((await f.r.api.getCanonicalJobStatus()).state, 'running');
    assert.equal(snapshot.getManifest().memories['1'].key, oldRef.key,
      'an unacknowledged replacement cannot publish its active manifest ref');
    assert.ok(pendingBody.value.text.includes(NEW_FACT), 'the withheld durable body contains the replacement');
    const pendingInput = [{ role: 'user', content: QUERY }];
    const callsBeforeRequest = countCalls(f.control);
    const pendingOutput = await f.control.hooks.beforeRequest(pendingInput, 'model');
    assert.equal(pendingOutput, pendingInput, 'the bounded request returns unchanged while publication is unsettled');
    assert.equal(pendingOutput.some(row => String(row.content).includes('[LIBRA CLASSIC RECALL')), false,
      'a physically present unactivated replacement cannot reach the request');
    assert.equal(pendingOutput.some(row => String(row.content).includes(OLD_FACT)), false,
      'unsettled publication does not inject prior canonical as a fallback');
    const pendingRecall = f.r.api.getLastMemoryRecallViewer();
    assert.equal(pendingRecall.failOpen, true);
    assert.equal(pendingRecall.injectedMemories, 0);
    assert.ok(['LIBRA_RECALL_DEADLINE', 'LIBRA_RECALL_STEP_TIMEOUT'].includes(pendingRecall.errorCode),
      `suppression must be the bounded pending-publication guard: ${JSON.stringify(pendingRecall)}`);
    assert.equal(pendingRecall.timeoutPhase, 'before_branch_reconcile',
      'the held scope publication queue causes suppression, not an unrelated storage failure');
    assert.deepEqual(countCalls(f.control), callsBeforeRequest, 'pending request adds no provider work');
    assert.equal((await f.r.api.getCanonicalJobStatus()).state, 'running');
    assert.equal(snapshot.getManifest().memories['1'].key, oldRef.key);
    assert.equal(rawOf(snapshot, 'mirror', oldRef.key), oldBytes);
    release();
    const result = await work;
    assert.equal(result.ok, true, JSON.stringify(result));
    const ref = snapshot.getManifest().memories['1'];
    assert.equal(ref.key, pendingBody.key);
    const body = snapshot.getMemory();
    for (const field of ['memoryId', 'revision', 'sourceDigest', 'artifactDigest']) {
      assert.equal(body[field], ref[field], `published body binds ${field}`);
    }
    const applied = await classic(f, selection.scopeKey);
    assert.match(applied.actualClassic.block, /지호는 은빛 열쇠를 아직 반환하지 않았다\./);
    assert.equal(applied.actualClassic.block.includes(OLD_FACT), false,
      'the next request uses the committed replacement without reviving the old fact');
    assert.equal(rawOf(snapshot, 'mirror', oldRef.key), oldBytes);
    return { mode: 'mirror', durableUnpublishedBodyExcluded: true,
      approvedRefRetainedBeforePublication: true, pendingRecallInjected: pendingRecall.injectedMemories,
      pendingRecallErrorCode: pendingRecall.errorCode, pendingRecallTimeoutPhase: pendingRecall.timeoutPhase,
      publishedRevision: ref.revision,
      replacementDeliveredAfterPublication: true, priorBodyBytesPreserved: true };
  } finally {
    release();
    if (work) await work.catch(() => {});
    snapshot.backend.setItem = originalSet;
    await snapshot.cleanup();
  }
}

(async () => {
  const observations = [];
  for (const mode of MODES) observations.push(await check(mode));
  // Equal-score evidence units are ordered by a node id that depends on the storage mode, so the contract is
  // the same admitted evidence set (header, footer and every numbered unit), not the tie-break order.
  const evidenceSet = block => block.split('\n').map(line => line.replace(/^\(\d+\) /, '')).sort().join('\n');
  for (const row of observations.slice(1)) assert.equal(evidenceSet(row.finalBlock), evidenceSet(observations[0].finalBlock), `${row.mode}: final injected evidence set matches plugin_only`);
  const pendingPublication = await checkPendingPublication();
  process.stdout.write(JSON.stringify({ test: 'libra_source_edit_final_injection_3mode', observations: observations.map(({ finalBlock, ...row }) => ({ ...row, finalBlockChars: finalBlock.length })), pendingPublication }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
