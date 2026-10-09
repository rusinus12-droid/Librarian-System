'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const SOURCE = { sourceType: 'response', sourceId: 'reserved-source-1', sourceHash: 'reserved-source-hash-1',
  origin: 'live_chat', role: 'turn_pair', turnIndex: 1, pairIndex: 1, sourceMessageIds: ['reserve-u1', 'reserve-a1'],
  text: 'User:\nI inspect the cabinet.\n\n---\n\nAssistant:\nThe brass key opens the north cabinet. A blue ribbon is tied to its handle.' };
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(options = {}) {
  const h = await createFlashback(PROGRAM, options);
  const cfg = h.api._test.normalizeSettings({ embeddingEnabled: true, embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small', embeddingDimensions: 3, embeddingUrl: 'https://provider.invalid/v1/embeddings',
    embeddingMaxRetries: 0, fallbackHashEmbedding: false, autoEpisodeIndex: false });
  await h.api.saveSettings(cfg);
  const scope = await h.api.resolveCurrentScope(false);
  if (!options.pluginStorage) {
    const records = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(records, cfg, scope);
  }
  return { h, cfg, scope, records: () => h.api._test.loadScopeRecords(scope.scopeKey) };
}

function requireWorker(h) {
  assert.equal(typeof h.api.processPendingEmbeddingWork, 'function', 'the durable-work consumer must be wired to the product API');
  assert.equal(typeof h.api.inspectEmbeddingWork, 'function');
}
function success(init) {
  const input = JSON.parse(init.body).input;
  return { ok: true, status: 200, async json() { return { data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } };
}

test('a provider submission follows a durably readable reservation and publishes a matching completion', async () => {
  const { h, scope, records } = await setup();
  try {
    requireWorker(h);
    let calls = 0, reserved;
    h.host.nativeFetch = async (_url, init) => {
      calls++;
      const row = (await records()).records[0];
      assert.equal(row.text, SOURCE.text);
      assert.equal(row.embeddingWork.status, 'running');
      assert(row.embeddingWork.attempt?.id);
      assert(row.embeddingWork.attempt?.runtimeId);
      reserved = clone(row.embeddingWork);
      return success(init);
    };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(result.ready, 1);
    assert.equal(calls, 1);
    const row = (await records()).records[0];
    assert.deepEqual(clone(row.vector), [1, 0, 0]);
    assert.equal(row.text, SOURCE.text);
    assert.equal(row.sourceHash, SOURCE.sourceHash);
    assert.equal(row.embeddingWork == null, true);
    assert.equal(row.embeddingReceipt.status, 'ready');
    assert.equal(row.embeddingReceipt.attemptId, reserved.attempt.id);
    assert.equal(row.embeddingReceipt.sourceRevision, reserved.sourceRevision);
    const repeated = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(repeated.reused, 1);
    assert.equal(calls, 1, 'already verified model work is reused without another call');
    assert.equal((await h.api.inspectEmbeddingWork()).scopeKey, scope.scopeKey);
  } finally { await h.cleanup(); }
});

test('reservation write failure preserves raw data and submits no provider request', async () => {
  const { h, records } = await setup();
  try {
    requireWorker(h);
    let calls = 0;
    h.host.nativeFetch = async () => { calls++; throw Error('must_not_submit'); };
    const original = h.pluginStorage.setItem;
    h.pluginStorage.setItem = async (key, value) => key.endsWith(':manifest:v2') ? false : original(key, value);
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash }).catch(error => ({ reason: error.code || error.message }));
    h.pluginStorage.setItem = original;
    assert.equal(calls, 0);
    assert(result.reason);
    const row = (await records()).records[0];
    assert.equal(row.text, SOURCE.text);
    assert.equal(row.embeddingWork.status, 'pending');
    assert.equal(row.vector.length, 0);
  } finally { await h.cleanup(); }
});

test('a definitive provider rejection retains raw source and records a failed attempt without hash fallback', async () => {
  const { h, records } = await setup();
  try {
    requireWorker(h);
    let calls = 0;
    h.host.nativeFetch = async () => { calls++; return { ok: false, status: 401, async json() { return { error: { message: 'synthetic auth rejection' } }; } }; };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(result.ready, 0);
    assert.equal(result.failed, 1);
    assert.equal(calls, 1);
    const row = (await records()).records[0];
    assert.equal(row.embeddingWork.status, 'failed');
    assert.equal(row.vector.length, 0);
    assert.equal(row.text, SOURCE.text);
    await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(calls, 1, 'failure status does not silently authorize another attempt');
  } finally { await h.cleanup(); }
});

for (const changed of ['source', 'profile', 'scope', 'backend', 'attempt']) {
  test(`a late model result cannot cross a changed ${changed} binding`, async () => {
    const { h, cfg, scope, records } = await setup();
    try {
      requireWorker(h);
      let submitted = 0;
      h.host.nativeFetch = async (_url, init) => {
        submitted++;
        if (changed === 'source') {
          const replacement = await h.api._test.buildRecordsFromSources([{ ...SOURCE, text: SOURCE.text + ' The user corrected this source.' }], cfg, scope, { deferEmbedding: true });
          await h.api._test.saveAllRecords(replacement, cfg, scope);
        } else if (changed === 'profile') {
          await h.api.saveSettings({ ...cfg, embeddingModel: 'text-embedding-3-large' });
        } else if (changed === 'scope') {
          const character = await h.host.getCharacter();
          const chat = { id: 'reservation-other-chat', chatId: 'reservation-other-chat', message: [], messages: [] };
          character.chats.push(chat); character.chatPage = 1;
          h.host.getCurrentChatIndex = async () => 1;
          h.host.getCurrentChat = h.host.getChat = async () => chat;
          h.host.getChatFromIndex = async (_character, index) => character.chats[index];
        } else if (changed === 'backend') {
          h.argumentValues.set('memory_suite_server_url', 'https://changed-storage.invalid');
        } else {
          const current = (await records()).records;
          const replacement = current.map(record => ({ ...record, embeddingWork: { ...record.embeddingWork,
            attempt: { ...record.embeddingWork.attempt, id: 'different-durable-attempt' } } }));
          await h.api._test.saveAllRecords(replacement, cfg, scope);
        }
        return success(init);
      };
      const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
      assert.equal(submitted, 1, 'the binding changes inside an actual provider await');
      assert.equal(result.ok, false);
      assert.equal(result.ready, 0);
      const row = (await records()).records[0];
      assert.equal(row.vector.length, 0, 'late output cannot overwrite current raw work');
      assert.equal(row.embeddingReceipt == null, true);
      if (changed === 'source') {
        assert(row.text.endsWith('The user corrected this source.'));
        assert.equal(row.embeddingWork.status, 'pending');
      } else if (changed === 'attempt') assert.equal(row.embeddingWork.attempt.id, 'different-durable-attempt');
    } finally { await h.cleanup(); }
  });
}

test('restart exposes an uncertain running reservation and never silently resubmits it', async () => {
  const first = await setup();
  const { h, scope } = first;
  const entered = deferred(), release = deferred();
  let second, pending;
  try {
    requireWorker(h);
    h.host.nativeFetch = async (_url, init) => { entered.resolve(); await release.promise; return success(init); };
    pending = h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    await entered.promise;
    const rawBefore = clone((await first.records()).records[0]);
    assert.equal(rawBefore.embeddingWork.status, 'running');
    await h.cleanup();
    second = await setup({ pluginStorage: h.pluginStorage, safeLocalStorage: h.safeLocalStorage });
    let resubmitted = 0;
    second.h.host.nativeFetch = async () => { resubmitted++; throw Error('must_not_resubmit_uncertain'); };
    const status = await second.h.api.inspectEmbeddingWork();
    assert.equal(status.jobs[0].status, 'uncertain');
    assert.equal(status.jobs[0].durableStatus, 'running');
    assert.equal(status.jobs[0].recoverable, true);
    const result = await second.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash, retryFailed: true });
    assert.equal(result.uncertain, true);
    assert.equal(resubmitted, 0);
    release.resolve();
    assert.equal((await pending).ok, false, 'the unloaded owner cannot adopt a late response');
    const after = (await second.records()).records[0];
    assert.equal(after.text, rawBefore.text);
    assert.deepEqual(clone(after.embeddingWork), rawBefore.embeddingWork);
    assert.equal(after.vector.length, 0);
    assert.equal((await second.h.api.inspectEmbeddingWork()).scopeKey, scope.scopeKey);
  } finally {
    release.resolve(); if (pending) await pending;
    await h.cleanup(); if (second) await second.h.cleanup();
  }
});

test('an unrelated new raw source does not invalidate the reserved source or get overwritten', async () => {
  const { h, cfg, scope, records } = await setup();
  try {
    requireWorker(h);
    h.host.nativeFetch = async (_url, init) => {
      const other = await h.api._test.buildRecordsFromSources([{ ...SOURCE, sourceId: 'unrelated-source',
        sourceHash: 'unrelated-source-hash', pairIndex: 2, turnIndex: 2, text: 'A separate unrelated completed source.' }], cfg, scope, { deferEmbedding: true });
      await h.api._test.saveAllRecords([...(await records()).records, ...other], cfg, scope);
      return success(init);
    };
    assert.equal((await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).ready, 1);
    const rows = (await records()).records;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.sourceHash === 'unrelated-source-hash').embeddingWork.status, 'pending');
  } finally { await h.cleanup(); }
});

test('profile change during completion publication cannot be reported as a current successful model result', async () => {
  const { h, cfg, records } = await setup();
  try {
    requireWorker(h);
    h.host.nativeFetch = async (_url, init) => success(init);
    const original = h.pluginStorage.setItem;
    let manifestWrites = 0, changed = false;
    h.pluginStorage.setItem = async (key, value) => {
      const result = await original(key, value);
      if (key.endsWith(':manifest:v2') && ++manifestWrites === 2) {
        changed = true;
        await h.api.saveSettings({ ...cfg, embeddingModel: 'text-embedding-3-large' });
      }
      return result;
    };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    h.pluginStorage.setItem = original;
    assert.equal(changed, true, 'profile changed inside the actual manifest-publication await');
    assert.equal(result.ok, false);
    assert.equal(result.ready, 0);
    const row = (await records()).records[0];
    assert.equal(row.text, SOURCE.text);
    assert.notEqual((await h.api.inspectEmbeddingWork()).jobs[0].status, 'ready');
  } finally { await h.cleanup(); }
});

test('a reserved attempt orphaned before submission is exposed as uncertain in the same runtime', async () => {
  const { h, cfg, records } = await setup();
  try {
    requireWorker(h);
    let submitted = 0, changed = false;
    h.host.nativeFetch = async () => { submitted++; throw Error('must_not_submit'); };
    const original = h.pluginStorage.setItem;
    h.pluginStorage.setItem = async (key, value) => {
      const result = await original(key, value);
      if (key.endsWith(':manifest:v2') && !changed) {
        changed = true;
        await h.api.saveSettings({ ...cfg, embeddingModel: 'text-embedding-3-large' });
      }
      return result;
    };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    h.pluginStorage.setItem = original;
    assert.equal(result.ok, false);
    assert.equal(submitted, 0);
    assert.equal((await records()).records[0].embeddingWork.status, 'running');
    const job = (await h.api.inspectEmbeddingWork()).jobs[0];
    assert.equal(job.status, 'uncertain', 'a dead operation is not still processing merely because its runtime ID matches');
    assert.equal(job.recoverable, true);
  } finally { await h.cleanup(); }
});

test('overlapping same-runtime requests share no provider attempt and report the active owner honestly', async () => {
  const { h } = await setup();
  const entered = deferred(), release = deferred();
  let pending;
  try {
    requireWorker(h);
    let submitted = 0;
    h.host.nativeFetch = async (_url, init) => { submitted++; entered.resolve(); await release.promise; return success(init); };
    pending = h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    await entered.promise;
    assert.equal((await h.api.inspectEmbeddingWork()).jobs[0].status, 'running');
    const duplicate = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(duplicate.ready, 0);
    assert.equal(duplicate.reason, 'FLASHBACK_EMBEDDING_ATTEMPT_RUNNING');
    assert.equal(submitted, 1);
    release.resolve();
    assert.equal((await pending).ready, 1);
  } finally { release.resolve(); if (pending) await pending; await h.cleanup(); }
});

test('late source ownership metadata changes are not overwritten by model completion', async () => {
  const { h, cfg, scope, records } = await setup();
  try {
    requireWorker(h);
    let submitted = false;
    h.host.nativeFetch = async (_url, init) => {
      submitted = true;
      const replacement = (await records()).records.map(record => ({ ...record,
        lifecycleStatus: 'inactive_variant', turnNodeId: 'replacement-owner-node' }));
      await h.api._test.saveAllRecords(replacement, cfg, scope);
      return success(init);
    };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(submitted, true);
    assert.equal(result.ok, false);
    const row = (await records()).records[0];
    assert.equal(row.vector.length, 0);
    assert.equal(row.lifecycleStatus, 'inactive_variant');
    assert.equal(row.turnNodeId, 'replacement-owner-node');
  } finally { await h.cleanup(); }
});

test('a source change after one batch stops further provider submissions in the reserved operation', async () => {
  const { h, cfg, scope, records } = await setup();
  try {
    requireWorker(h);
    const batchCfg = h.api._test.normalizeSettings({ ...cfg, chunkChars: 400, chunkOverlap: 0, embeddingBatchSize: 1 });
    await h.api.saveSettings(batchCfg);
    const source = { ...SOURCE, text: SOURCE.text.repeat(30) };
    const raw = await h.api._test.buildRecordsFromSources([source], batchCfg, scope, { deferEmbedding: true });
    assert(raw.length > 1, 'the actual producer must create more than one provider batch');
    await h.api._test.saveAllRecords(raw, batchCfg, scope);
    let submitted = 0;
    h.host.nativeFetch = async (_url, init) => {
      submitted++;
      if (submitted === 1) {
        const changed = (await records()).records.map(record => ({ ...record, turnNodeId: 'changed-after-first-batch' }));
        await h.api._test.saveAllRecords(changed, batchCfg, scope);
      }
      return success(init);
    };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(result.ok, false);
    assert.equal(submitted, 1, 'the old attempt cannot submit later batches after its source authority changed');
    assert((await records()).records.every(row => row.vector.length === 0));
  } finally { await h.cleanup(); }
});

test('ready completion survives restart and reports its current profile without another provider call', async () => {
  const first = await setup();
  let second;
  try {
    requireWorker(first.h);
    first.h.host.nativeFetch = async (_url, init) => success(init);
    assert.equal((await first.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).ready, 1);
    await first.h.cleanup();
    second = await setup({ pluginStorage: first.h.pluginStorage, safeLocalStorage: first.h.safeLocalStorage });
    let submitted = 0;
    second.h.host.nativeFetch = async () => { submitted++; throw Error('must_reuse_durable_model_vector'); };
    const job = (await second.h.api.inspectEmbeddingWork()).jobs[0];
    assert.equal(job.status, 'ready');
    assert.equal(job.profileCurrent, true);
    assert.equal((await second.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).reused, 1);
    assert.equal(submitted, 0);
    assert.equal((await second.records()).records[0].text, SOURCE.text);
  } finally { await first.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('unknown network outcome remains recoverable and cannot be retried as a definitive failure', async () => {
  const { h, records } = await setup();
  try {
    requireWorker(h);
    let submitted = 0;
    h.host.nativeFetch = async () => { submitted++; throw Error('fetch failed'); };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(result.uncertain, true);
    assert.equal((await records()).records[0].embeddingWork.status, 'uncertain');
    assert.equal((await h.api.inspectEmbeddingWork()).jobs[0].recoverable, true);
    await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash, retryFailed: true });
    assert.equal(submitted, 1);
    assert.equal((await records()).records[0].vector.length, 0);
  } finally { await h.cleanup(); }
});

test('an incomplete pending source group is preserved without spending a provider attempt', async () => {
  const { h, cfg, scope, records } = await setup();
  try {
    requireWorker(h);
    const splitCfg = h.api._test.normalizeSettings({ ...cfg, chunkChars: 400, chunkOverlap: 0 });
    await h.api.saveSettings(splitCfg);
    const raw = await h.api._test.buildRecordsFromSources([{ ...SOURCE, text: SOURCE.text.repeat(30) }], splitCfg, scope, { deferEmbedding: true });
    assert(raw.length > 1);
    await h.api._test.saveAllRecords(raw.slice(1), splitCfg, scope);
    let submitted = 0;
    h.host.nativeFetch = async (_url, init) => { submitted++; return success(init); };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(submitted, 0, 'missing source chunks must be repaired before requesting an embedding');
    assert.equal(result.reason, 'FLASHBACK_EMBEDDING_SOURCE_GROUP_INCOMPLETE');
    const preserved = (await records()).records;
    assert.equal(preserved.length, raw.length - 1);
    assert(preserved.every(row => row.embeddingWork.status === 'pending' && row.vector.length === 0));
  } finally { await h.cleanup(); }
});

test('source captured without a model can be explicitly processed after a model is configured', async () => {
  const { h, cfg, scope, records } = await setup();
  try {
    requireWorker(h);
    const disabled = h.api._test.normalizeSettings({ ...cfg, embeddingEnabled: false });
    await h.api.saveSettings(disabled);
    const raw = await h.api._test.buildRecordsFromSources([SOURCE], disabled, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(raw, disabled, scope);
    assert.equal((await h.api.inspectEmbeddingWork()).jobs[0].status, 'unconfigured');
    let submitted = 0;
    h.host.nativeFetch = async (_url, init) => { submitted++; return success(init); };
    const unconfigured = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(unconfigured.reason, 'embedding_unconfigured');
    assert.equal(submitted, 0);
    await h.api.saveSettings(cfg);
    assert.equal(submitted, 0, 'configuration alone does not start a model request');
    assert.equal((await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).ready, 1);
    assert.equal(submitted, 1);
    assert.equal((await records()).records[0].text, SOURCE.text);
    assert.equal((await records()).records[0].embeddingReceipt.sourceRevision, raw[0].embeddingWork.sourceRevision);
  } finally { await h.cleanup(); }
});

test('a completion receipt for an older source cannot certify ready status or vector reuse', async () => {
  const { h, cfg, scope, records } = await setup();
  try {
    requireWorker(h);
    h.host.nativeFetch = async (_url, init) => success(init);
    assert.equal((await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).ready, 1);
    const rows = (await records()).records.map(row => ({ ...row, text: row.text + ' A later source correction changes the claim.' }));
    await h.api._test.saveAllRecords(rows, cfg, scope);
    assert.equal((await h.api.inspectEmbeddingWork()).jobs[0].status, 'source_changed');
    let submitted = 0;
    h.host.nativeFetch = async () => { submitted++; throw Error('stale_receipt_requires_raw_reconciliation'); };
    const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(result.ok, false);
    assert.equal(result.reused, 0);
    assert.equal(submitted, 0);
  } finally { await h.cleanup(); }
});

for (const setting of ['credential', 'custom headers', 'execution timeout']) {
  test(`a ${setting} change invalidates the runtime generation without changing semantic profile`, async () => {
    const { h, cfg, records } = await setup();
    try {
      requireWorker(h);
      const beforeProfile = h.audit.embeddingProfileSettingsFingerprint(cfg);
      const beforeGeneration = h.audit.Runtime.embeddingGeneration;
      let submitted = false;
      h.host.nativeFetch = async (_url, init) => {
        submitted = true;
        if (setting === 'credential') await h.api.saveEmbeddingCredential('synthetic-replacement-key-for-test');
        else await h.api.saveSettings({ ...cfg, ...(setting === 'custom headers'
          ? { embeddingCustomHeaders: JSON.stringify({ 'X-Test-Execution': 'changed' }) }
          : { embeddingTimeoutMs: cfg.embeddingTimeoutMs + 1000 }) });
        return success(init);
      };
      const result = await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
      assert.equal(submitted, true);
      assert.equal(h.audit.embeddingProfileSettingsFingerprint(await h.api.loadSettings(true)), beforeProfile);
      assert(h.audit.Runtime.embeddingGeneration > beforeGeneration);
      assert.equal(result.ok, false);
      assert.equal((await records()).records[0].vector.length, 0);
    } finally { await h.cleanup(); }
  });
}
