'use strict';
// The public beforeRequest that sees a source edit must deliver the replacement
// canonical, not the still retained previous revision, in every storage mode.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

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
const injection = (messages, failureDiagnostic = null) => {
  const blocks = messages.filter(message => String(message?.content || '').includes('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]'));
  if (blocks.length !== 1 && failureDiagnostic) {
    process.stderr.write(`source_edit_recall_failure ${JSON.stringify(failureDiagnostic)}\n`);
  }
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

const delaySourceEditTaskSettlement = source => {
  const anchor = 'sourceEditBasis:task.basis,sourceEditValidate:assertCurrent,maxBatches:1});\n          await assertCurrent();';
  assert.ok(source.includes(anchor), 'test-only unsettled-task delay anchor exists after the real source-edit scan');
  return source.replace(anchor,
    'sourceEditBasis:task.basis,sourceEditValidate:assertCurrent,maxBatches:1});\n          await new Promise(resolve=>setTimeout(resolve,12000));\n          await assertCurrent();');
};

async function check(mode) {
  const options = { mode };
  const snapshot = await serverFixture(options);
  try {
    const f = snapshot.f;
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    assert.equal((await f.run()).completed, 1, `${mode}: initial canonical commits`);
    const oldRef = manifestOf(snapshot, mode).memories['1'];
    const oldBytes = rawOf(snapshot, mode, oldRef.key);
    const initial = injection(await f.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model'));
    assert.match(initial, /지호가 열쇠를 민아에게 반환했다\./, `${mode}: control delivers the original fact`);

    // Keep the same message identity while changing both the source and the
    // fixed analysis result. beforeRequest itself performs automatic repair.
    f.chat.message[9].data = EDITED_SOURCE;
    f.control.artifact = editedArtifact();
    const firstPostEditRequestStartedAt = performance.now();
    const afterMessages = await f.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model');
    const firstPostEditRequestElapsedMs = Math.round(performance.now() - firstPostEditRequestStartedAt);
    const currentRef = manifestOf(snapshot, mode).memories['1'];
    const activeBodyRaw = currentRef?.key ? rawOf(snapshot, mode, currentRef.key) : null;
    const activeBody = activeBodyRaw ? parse(activeBodyRaw) : null;
    const sourceEditStatusAfterFirstRequest = f.r.api.getSourceEditSyncStatus();
    const runtime = f.r.api.getRuntime();
    const failureDiagnostic = {
      mode,
      phase: 'post-source-edit-beforeRequest',
      elapsedMs: firstPostEditRequestElapsedMs,
      elapsedPreparation: runtime.lastSourceEditPreparation || null,
      sourceEditTaskState: sourceEditStatusAfterFirstRequest,
      returnedMessages: afterMessages.map(message => ({
        role: String(message?.role || ''), keys: Object.keys(message || {}).sort(),
        chars: String(message?.content || '').length,
        hasClassicRecall: String(message?.content || '').includes('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]')
      })),
      injectionMode: runtime.lastInjectionMode || null,
      activeRef: currentRef ? {
        memoryId: currentRef.memoryId, revision: currentRef.revision, key: currentRef.key,
        sourceDigest: currentRef.sourceDigest, artifactDigest: currentRef.artifactDigest,
        sourceEditBasis: currentRef.sourceEditBasis || ''
      } : null,
      activeBodyReadback: activeBody ? {
        memoryId: activeBody.memoryId, revision: activeBody.revision,
        sourceDigest: activeBody.sourceDigest, artifactDigest: activeBody.artifactDigest,
        rawChars: activeBodyRaw.length,
        identityMatchesRef: activeBody.memoryId === currentRef?.memoryId
          && activeBody.revision === currentRef?.revision
          && activeBody.sourceDigest === currentRef?.sourceDigest
          && activeBody.artifactDigest === currentRef?.artifactDigest
      } : { present: false, rawChars: 0 },
      priorBodyBytesPreserved: rawOf(snapshot, mode, oldRef.key) === oldBytes,
      recallViewer: f.r.api.getLastMemoryRecallViewer(),
      recallResult: f.r.api.getLastMemoryRecall(),
      recallRuntime: runtime.lastRecallRuntime || null,
      sourceEditPreparation: runtime.lastSourceEditPreparation || null
    };
    if (afterMessages.filter(message => String(message?.content || '').includes('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]')).length !== 1) {
      const settleStartedAt = performance.now();
      let settledStatus = f.r.api.getSourceEditSyncStatus();
      while (settledStatus.running && performance.now() - settleStartedAt < 15000) {
        await new Promise(resolve => setTimeout(resolve, 100));
        settledStatus = f.r.api.getSourceEditSyncStatus();
      }
      const followupStartedAt = performance.now();
      const followupMessages = await f.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model');
      const followupManifest = manifestOf(snapshot, mode);
      const followupRef = followupManifest?.memories?.['1'];
      const followupBodyRaw = followupRef?.key ? rawOf(snapshot, mode, followupRef.key) : null;
      const followupBody = followupBodyRaw ? parse(followupBodyRaw) : null;
      process.stderr.write(`source_edit_recall_followup ${JSON.stringify({
        mode,
        settleWaitMs: Math.round(performance.now() - settleStartedAt),
        followupRequestMs: Math.round(performance.now() - followupStartedAt),
        taskStatus: settledStatus,
        activeRef: followupRef ? {
          memoryId: followupRef.memoryId, revision: followupRef.revision, key: followupRef.key,
          sourceDigest: followupRef.sourceDigest, artifactDigest: followupRef.artifactDigest,
          sourceEditBasis: followupRef.sourceEditBasis || ''
        } : null,
        activeBodyReadback: followupBody ? {
          memoryId: followupBody.memoryId, revision: followupBody.revision,
          sourceDigest: followupBody.sourceDigest, artifactDigest: followupBody.artifactDigest,
          identityMatchesRef: followupBody.memoryId === followupRef?.memoryId
            && followupBody.revision === followupRef?.revision
            && followupBody.sourceDigest === followupRef?.sourceDigest
            && followupBody.artifactDigest === followupRef?.artifactDigest
        } : { present: false },
        priorBodyBytesPreserved: rawOf(snapshot, mode, oldRef.key) === oldBytes,
        classicBlocks: followupMessages.filter(message => String(message?.content || '').includes('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]'))
          .map(message => String(message.content).slice(0, 1800)),
        recallViewer: f.r.api.getLastMemoryRecallViewer()
      })}\n`);
    }
    const after = injection(afterMessages, failureDiagnostic);
    assert.ok(currentRef.revision > oldRef.revision, `${mode}: source edit commits a new revision`);
    assert.ok(activeBody, `${mode}: the active canonical body is physically readable`);
    assert.equal(activeBody.memoryId, currentRef.memoryId, `${mode}: durable body identity matches the active ref`);
    assert.equal(activeBody.revision, currentRef.revision, `${mode}: durable body revision matches the active ref`);
    assert.equal(activeBody.sourceDigest, currentRef.sourceDigest, `${mode}: durable body source digest matches the active ref`);
    assert.equal(activeBody.artifactDigest, currentRef.artifactDigest, `${mode}: durable body artifact digest matches the active ref`);
    assert.equal(sourceEditStatusAfterFirstRequest.tasks.find(task => Number(task.start) === 1)?.state, 'applied',
      `${mode}: source edit is settled before Recall reaches the request`);
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

    // A persisted search hint can be stale while the active canonical is sound.
    // Keep its manifest signature so the real request actually consumes it.
    const catalogKey = (mode === 'plugin_only' ? [...snapshot.local.keys()] : snapshot.storedRows().map(row => row.key))
      .find(key => key.endsWith(':recall-catalog:v1'));
    assert.ok(catalogKey, `${mode}: public recall persisted a derived catalog`);
    const catalog = parse(rawOf(snapshot, mode, catalogKey));
    assert.equal(catalog.complete, true, `${mode}: stale-index control starts from a complete catalog`);
    const entry = catalog.entries.find(row => row.memoryKey === currentRef.key);
    assert.ok(entry, `${mode}: catalog contains the active memory`);
    entry.revision = oldRef.revision;
    entry.searchText = OLD_FACT;
    entry.summary = OLD_FACT;
    await setDurable(snapshot, mode, catalogKey, catalog);
    options.snapshot = { chat: f.chat };
    const restarted = await snapshot.restart();
    restarted.control.artifact = editedArtifact();
    await restarted.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    const staleCatalogProbe = await restarted.r.api.previewUnifiedMemoryRecall(QUERY);
    // NOTE: no assertion on `catalogSource` here. Whether the stale catalog is reused or rebuilt is a
    // performance choice, not the contract: the reuse test is the manifest-derived signature, which this
    // fixture does not control (it patches entry text, not the ref state the signature is computed from).
    // Measured across modes: plugin_only reused (its stored signature happened to still match), mirror
    // rebuilt. Both are legitimate. What the plan requires is asserted below - the stale text must never
    // become final evidence and the current canonical must be what the request uses.
    assert.equal(staleCatalogProbe.diagnostics.catalogFailedEntries, 0,
      `${mode}: a stale catalog must not make the catalog unavailable`);
    const staleIndexBlock = injection(await restarted.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model'));
    assert.match(staleIndexBlock, /지호는 은빛 열쇠를 아직 반환하지 않았다\./, `${mode}: stale catalog hydrates current canonical`);
    assert.ok(!staleIndexBlock.includes(OLD_FACT), `${mode}: stale catalog text never becomes final evidence`);

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
      firstPostEditRequestElapsedMs, sourceEditStateAfterRequest: sourceEditStatusAfterFirstRequest.tasks.find(task => Number(task.start) === 1)?.state,
      activeBodyIdentityReadback: true, staleCatalogHydratedCurrent: true,
      corruptedBodyVariantsRejected: 7, finalBlock: after };
  } finally { await snapshot.cleanup(); }
}

async function checkUnsettledTimeoutSuppression() {
  const mode = 'mirror';
  const snapshot = await serverFixture({ mode, transformSource: delaySourceEditTaskSettlement });
  try {
    const f = snapshot.f;
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    assert.equal((await f.run()).completed, 1, 'timeout control: initial canonical commits');
    const oldRef = manifestOf(snapshot, mode).memories['1'];
    const oldBytes = rawOf(snapshot, mode, oldRef.key);
    assert.match(injection(await f.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model')),
      /지호가 열쇠를 민아에게 반환했다\./, 'timeout control: old canonical works before the edit');

    f.chat.message[9].data = EDITED_SOURCE;
    f.control.artifact = editedArtifact();
    const startedAt = performance.now();
    const timedMessages = await f.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model');
    const timedElapsedMs = Math.round(performance.now() - startedAt);
    const timedBlocks = timedMessages.filter(message => String(message?.content || '').includes('[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]'));
    const pendingStatus = f.r.api.getSourceEditSyncStatus();
    const pendingRef = manifestOf(snapshot, mode).memories['1'];
    const pendingBodyRaw = rawOf(snapshot, mode, pendingRef.key);
    const pendingBody = parse(pendingBodyRaw);
    const pendingRecall = f.r.api.getLastMemoryRecallViewer();
    assert.equal(timedBlocks.length, 0, 'unsettled source-edit timeout injects no Classic evidence');
    assert.ok(timedMessages.every(message => !String(message?.content || '').includes(OLD_FACT)),
      'unsettled source-edit timeout never falls back to the superseded canonical');
    assert.equal(pendingStatus.tasks.find(task => Number(task.start) === 1)?.state, 'running',
      'source-edit task remains unsettled beyond the bounded request window');
    assert.ok(pendingRef.revision > oldRef.revision, 'timeout control already has a newer active manifest revision');
    assert.equal(pendingBody.memoryId, pendingRef.memoryId, 'pending replacement body is durably read back by memory identity');
    assert.equal(pendingBody.revision, pendingRef.revision, 'pending replacement body is durably read back by revision');
    assert.equal(pendingBody.sourceDigest, pendingRef.sourceDigest, 'pending replacement body is durably read back by source digest');
    assert.equal(pendingBody.artifactDigest, pendingRef.artifactDigest, 'pending replacement body is durably read back by artifact digest');
    assert.equal(pendingRecall.injectedMemories, 0, 'unsettled replacement remains suppressed until the task applies');
    assert.equal(rawOf(snapshot, mode, oldRef.key), oldBytes, 'timeout control preserves prior canonical bytes');
    process.stderr.write(`source_edit_timeout_suppression ${JSON.stringify({
      mode, timedElapsedMs, timeoutBudgetMs: 10000,
      pendingTaskState: pendingStatus.tasks.find(task => Number(task.start) === 1)?.state,
      pendingRevision: pendingRef.revision, pendingBodyIdentityReadback: true,
      pendingRecallInjected: pendingRecall.injectedMemories, timedBlocks: timedBlocks.length,
      oldBodyBytesPreserved: rawOf(snapshot, mode, oldRef.key) === oldBytes
    })}\n`);

    const settleStartedAt = performance.now();
    let applied = f.r.api.getSourceEditSyncStatus();
    while (applied.running && performance.now() - settleStartedAt < 15000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      applied = f.r.api.getSourceEditSyncStatus();
    }
    assert.equal(applied.tasks.find(task => Number(task.start) === 1)?.state, 'applied',
      'the delayed source-edit task eventually reaches applied');
    const followup = await f.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model');
    const followupBlock = injection(followup);
    assert.match(followupBlock, /지호는 은빛 열쇠를 아직 반환하지 않았다\./,
      'settled task injects its durable replacement on the next request');
    assert.ok(!followupBlock.includes(OLD_FACT), 'settled task never revives the old fact');
    assert.equal(rawOf(snapshot, mode, oldRef.key), oldBytes, 'settled timeout control still preserves the old body');
    return { mode, timedElapsedMs, timeoutBudgetMs: 10000, pendingTaskState: 'running',
      pendingRevision: pendingRef.revision, pendingBodyIdentityReadback: true,
      pendingRecallInjected: pendingRecall.injectedMemories, timedBlocks: timedBlocks.length,
      settleWaitMs: Math.round(performance.now() - settleStartedAt), appliedState: 'applied',
      followupDeliveredReplacement: true, oldBodyBytesPreserved: true };
  } finally { await snapshot.cleanup(); }
}

(async () => {
  const observations = [];
  for (const mode of MODES) observations.push(await check(mode));
  for (const row of observations.slice(1)) assert.equal(row.finalBlock, observations[0].finalBlock, `${row.mode}: final injected evidence matches plugin_only`);
  const timeoutSuppression = await checkUnsettledTimeoutSuppression();
  process.stdout.write(JSON.stringify({ test: 'libra_source_edit_final_injection_3mode', observations: observations.map(({ finalBlock, ...row }) => ({ ...row, finalBlockChars: finalBlock.length })), timeoutSuppression }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
