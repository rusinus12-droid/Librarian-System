'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const { createArchiveOwnerFixture, canonicalIdentity } = require('./fixtures/archive_owner_fixture.cjs');

const PROGRAM = path.resolve(__dirname, '..');

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeTurnSource(index, textOverride = '') {
  const turn = index + 1;
  return {
    sourceType: 'response',
    sourceId: `long-run-source-${turn}`,
    sourceHash: `long-run-hash-${turn}`,
    origin: 'live_chat',
    role: 'turn_pair',
    turnIndex: turn,
    pairIndex: turn,
    text:
      textOverride ||
      `User:\nInspect sector ${turn} archival vault.\n\n---\n\nAssistant:\nSector ${turn} archival vault holds artifact token-${turn} inside cabinet-${turn}.`
  };
}

async function createHarness(options = {}) {
  const h = await createFlashback(PROGRAM, {
    ...options,
    waitForLoaded: true,
    transformSource: script => {
      const anchor = '  globalThis.__FlashbackMemory = publicApi;';
      return script.replace(
        anchor,
        '  globalThis.__faultRecoveryBridge = { issueEmbeddingRecoveryOffer, acceptEmbeddingRecoveryOffer, schedulePendingEmbeddingWork, saveFinalizedChatCapture, loadRisuSnapshot, authoritativeFinalizedCandidate };\n' +
          anchor
      );
    }
  });
  return h;
}

test('Scenario 1: embedding provider timeout — request timeout, pass deadline, and uncertain sent-timeout recovery', async () => {
  const h = await createHarness();
  try {
    const cfg = h.api._test.normalizeSettings({
      embeddingEnabled: true,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 3,
      embeddingUrl: 'https://provider.invalid/v1/embeddings',
      embeddingTimeoutMs: 60,
      embeddingMaxRetries: 0,
      embeddingBatchSize: 1,
      embeddingAutoProcess: false,
      autoEpisodeIndex: false,
      episodeIndexEnabled: false
    });
    await h.api.saveSettings(cfg);
    const scope = await h.api.resolveCurrentScope(false);
    const sources = [makeTurnSource(0), makeTurnSource(1), makeTurnSource(2)];
    const raw = await h.api._test.buildRecordsFromSources(sources, cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(raw, cfg, scope);

    // 1a. Sent provider timeout transitions the in-flight source to uncertain and blocks automatic retry
    let calls = 0;
    h.host.nativeFetch = async (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('provider timed out after send'), { name: 'AbortError' })),
          { once: true }
        );
      });
    };

    const timedOut = await h.api.processPendingEmbeddingWork({ sourceHash: sources[0].sourceHash });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.uncertain, true);
    assert.equal(calls, 1);

    // Automatic pass must not resubmit an uncertain attempt without explicit user/operator recovery
    h.host.nativeFetch = async (_url, init) => {
      calls += 1;
      const input = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: input.map((_, i) => ({ index: i, embedding: [1, 0, 0] })) };
        }
      };
    };
    const blockedRetry = await h.api.processPendingEmbeddingWork({ sourceHash: sources[0].sourceHash });
    assert.equal(blockedRetry.ready, 0);
    assert.equal(calls, 1, 'uncertain attempt must remain blocked against automatic resubmission');

    // 1b. Explicit recovery offer resolves the uncertain source
    const view = await h.api.inspectEmbeddingWork();
    const uncertainGroup = view.groups.find(g => g.sourceHash === sources[0].sourceHash);
    assert.ok(uncertainGroup, 'uncertain group is surfaced in inspectEmbeddingWork');
    assert.equal(uncertainGroup.status, 'uncertain');
    const offer = await h.context.__faultRecoveryBridge.issueEmbeddingRecoveryOffer({
      ...uncertainGroup,
      scopeKey: view.scopeKey,
      profile: view.profile,
      storageBinding: view.storageBinding,
      generation: view.generation
    });
    const recovered = await h.context.__faultRecoveryBridge.acceptEmbeddingRecoveryOffer(offer.token, uncertainGroup);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.ready, 1);

    // 1c. Pass deadline stops a multi-source pass without renewing the deadline for the next source
    let passCalls = 0;
    h.context.__queueClock = Date.now();
    vm.runInContext('Date.now = () => globalThis.__queueClock;', h.context);
    h.host.nativeFetch = async (_url, init) => {
      passCalls += 1;
      h.context.__queueClock += 70;
      const input = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: input.map((_, i) => ({ index: i, embedding: [0, 1, 0] })) };
        }
      };
    };
    const passResult = await h.api.processPendingEmbeddingQueue({
      timeoutMs: 45,
      maxRequests: 8
    });
    assert.equal(passCalls, 1, 'pass deadline is not renewed for the next source after the first exceeds timeoutMs');
    assert.equal(passResult.ready, 0);
    const afterPassRecords = (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
    const remainingPending = afterPassRecords.filter(r => r.embeddingWork?.status === 'pending');
    assert.equal(remainingPending.length, 1, 'remaining source stays pending without being started after pass deadline');
  } finally {
    await h.cleanup();
  }
});

test('Scenario 2: pending queue 누적 — multi-pass backlog drains across failed front pass and automatic continuation', async () => {
  const h = await createHarness();
  try {
    const cfg = h.api._test.normalizeSettings({
      embeddingEnabled: true,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 3,
      embeddingUrl: 'https://provider.invalid/v1/embeddings',
      embeddingMaxRetries: 0,
      embeddingBatchSize: 1,
      embeddingAutoProcess: true,
      progressiveReembedMaxRecords: 6,
      progressiveReembedMaxRequests: 6,
      autoEpisodeIndex: false,
      episodeIndexEnabled: false
    });
    await h.api.saveSettings(cfg);
    const scope = await h.api.resolveCurrentScope(false);

    const totalTurns = 18;
    const sources = Array.from({ length: totalTurns }, (_, i) => makeTurnSource(i));
    const raw = await h.api._test.buildRecordsFromSources(sources, cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(raw, cfg, scope);

    // Front 6 turns processed by the first pass fail with definite invalid zero-vector; remaining 12 turns succeed across subsequent automatic passes
    let seenCalls = 0;
    let failFront = true;
    h.host.nativeFetch = async (_url, init) => {
      seenCalls += 1;
      const inputs = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: inputs.map((_text, index) => ({
              index,
              embedding: failFront && seenCalls <= 6 ? [0, 0, 0] : [1, 0, 0]
            }))
          };
        }
      };
    };

    // Start automatic background queue; it must traverse the failed front pass (6/6 failed) and continue to drain all 12 valid tail sources
    h.context.__faultRecoveryBridge.schedulePendingEmbeddingWork(scope.scopeKey);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const loaded = await h.api._test.loadScopeRecords(scope.scopeKey);
      const readyCount = loaded.records.filter(r => r.embeddingReceipt?.status === 'ready').length;
      if (readyCount === totalTurns - 6) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }

    const afterAutoDrain = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(
      afterAutoDrain.records.filter(r => r.embeddingReceipt?.status === 'ready').length,
      totalTurns - 6,
      'automatic continuation drained all 12 valid tail turns despite front pass failing 6/6'
    );
    assert.equal(
      afterAutoDrain.records.filter(r => r.embeddingWork?.status === 'failed').length,
      6,
      'failed front turns remain explicitly marked failed'
    );

    // Explicit retryFailed recovers the remaining 6 failed turns
    failFront = false;
    const retryResult = await h.api.processPendingEmbeddingQueue({
      retryFailed: true,
      maxSources: 12,
      maxRequests: 12
    });
    assert.equal(retryResult.ready, 6);
    const finalLoaded = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(finalLoaded.records.filter(r => r.embeddingReceipt?.status === 'ready').length, totalTurns);
  } finally {
    await h.cleanup();
  }
});

test('Scenario 3: 앱 재시작 후 recovery — crashed running attempt and provisional capture recovery across restart', async () => {
  const first = await createHarness();
  const entered = deferred();
  const release = deferred();
  let inFlightPromise = null;
  let second = null;
  try {
    const cfg = first.api._test.normalizeSettings({
      embeddingEnabled: true,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 3,
      embeddingUrl: 'https://provider.invalid/v1/embeddings',
      embeddingMaxRetries: 0,
      embeddingBatchSize: 1,
      embeddingAutoProcess: false,
      autoEpisodeIndex: false,
      episodeIndexEnabled: false
    });
    await first.api.saveSettings(cfg);
    const scope = await first.api.resolveCurrentScope(false);

    const s1 = makeTurnSource(0);
    const s2 = makeTurnSource(1);
    const built = await first.api._test.buildRecordsFromSources([s1, s2], cfg, scope, { deferEmbedding: true });
    await first.api._test.saveAllRecords(built, cfg, scope);

    // Also persist a provisional capture for Turn 3 before crash
    const chat = await first.host.getCurrentChat();
    chat.message = [
      { role: 'user', chatId: 'u1', data: 'Inspect sector 1 archival vault.' },
      { role: 'assistant', chatId: 'a1', data: 'Sector 1 archival vault holds artifact token-1 inside cabinet-1.' },
      { role: 'user', chatId: 'u2', data: 'Inspect sector 2 archival vault.' },
      { role: 'assistant', chatId: 'a2', data: 'Sector 2 archival vault holds artifact token-2 inside cabinet-2.' },
      { role: 'user', chatId: 'u3', data: 'Where is the emerald compass?' }
    ];
    chat.messages = chat.message;
    await first.api._test.beforeRequest([{ role: 'user', chatId: 'u3', content: 'Where is the emerald compass?' }], 'model');

    const pendingTurn = first.audit.Runtime.pendingTurns[0];
    assert.ok(pendingTurn, 'pending turn armed before response completion');
    const eventChat = {
      ...chat,
      message: [
        ...chat.message,
        { role: 'assistant', chatId: 'a3', data: 'The emerald compass is locked inside drawer-3.' }
      ]
    };
    const snapshot = {
      character: { ...(await first.host.getCharacter()), chats: [eventChat] },
      chat: eventChat,
      chatInfo: { characterIndex: 0, chatIndex: 0, source: 'risu_chat_output' }
    };
    const normalized = first.api._test.normalizeStoredChatMessages(eventChat, scope.scopeKey);
    const candidate = first.context.__faultRecoveryBridge.authoritativeFinalizedCandidate(normalized, pendingTurn);
    assert.ok(candidate, 'candidate resolved for provisional capture');
    const savedProvisional = await first.context.__faultRecoveryBridge.saveFinalizedChatCapture(
      pendingTurn,
      candidate,
      snapshot,
      cfg,
      { provisional: true, captureSource: 'risu_chat_output' }
    );
    assert.equal(savedProvisional, true);

    // Start embedding s1 and pause inside nativeFetch so s1 is durably in-flight ("running" / "submitted") when crash occurs
    first.host.nativeFetch = async (_url, init) => {
      entered.resolve();
      await release.promise;
      const inputs = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) };
        }
      };
    };
    inFlightPromise = first.api.processPendingEmbeddingWork({ sourceHash: s1.sourceHash });
    await entered.promise;

    // Crash/dispose first runtime while s1 is mid-flight, then start second runtime on the same storage
    await first.cleanup();

    second = await createHarness({
      pluginStorage: first.pluginStorage,
      safeLocalStorage: first.safeLocalStorage
    });
    let secondCalls = 0;
    second.host.nativeFetch = async (_url, init) => {
      secondCalls += 1;
      const inputs = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) };
        }
      };
    };

    const restartedChat = await second.host.getCurrentChat();
    restartedChat.message = [
      ...eventChat.message,
      { role: 'user', chatId: 'u4', data: 'Confirm all three sectors.' }
    ];
    restartedChat.messages = restartedChat.message;

    // Next beforeRequest reconciles the provisional Turn 3 capture into liveConfirmed: true
    await second.api._test.beforeRequest(
      restartedChat.message.map(m => ({ role: m.role, chatId: m.chatId, content: m.data })),
      'model'
    );

    // Run pending queue on restarted instance:
    // - Turn 1 (in-flight during crash) is skipped as uncertain (not automatically resubmitted)
    // - Turn 2 (pending) and Turn 3 (promoted from provisional to confirmed) embed to ready
    const queueResult = await second.api.processPendingEmbeddingQueue({ maxSources: 8, maxRequests: 8 });
    assert.equal(queueResult.uncertainSources, 1, 'crashed in-flight source is quarantined as uncertain');
    assert.equal(queueResult.ready, 2, 'unrelated pending Turn 2 and confirmed Turn 3 complete embedding');
    assert.ok(secondCalls >= 2);

    const afterRestartLoad = await second.api._test.loadScopeRecords(scope.scopeKey);
    const r2 = afterRestartLoad.records.find(r => r.turnIndex === 2);
    const r3 = afterRestartLoad.records.find(r => r.turnIndex === 3 && r.metadata?.captureAuthority?.liveConfirmed === true);
    assert.equal(r2?.embeddingReceipt?.status, 'ready');
    assert.ok(r3, 'provisional Turn 3 capture promoted to liveConfirmed after restart');
    assert.equal(r3?.embeddingReceipt?.status, 'ready');
  } finally {
    release.resolve();
    if (inFlightPromise) await inFlightPromise.catch(() => {});
    await first.cleanup().catch(() => {});
    if (second) await second.cleanup().catch(() => {});
  }
});

test('Scenario 4: scope 변경 중 embedding 완료 — in-flight scope switch prevents cross-scope adoption and stale recall', async () => {
  const h = await createHarness();
  try {
    const cfg = h.api._test.normalizeSettings({
      embeddingEnabled: true,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 3,
      embeddingUrl: 'https://provider.invalid/v1/embeddings',
      embeddingMaxRetries: 0,
      embeddingAutoProcess: false,
      autoEpisodeIndex: false,
      episodeIndexEnabled: false
    });
    await h.api.saveSettings(cfg);
    const scopeA = await h.api.resolveCurrentScope(false);
    const sourceA = makeTurnSource(0);
    const rawA = await h.api._test.buildRecordsFromSources([sourceA], cfg, scopeA, { deferEmbedding: true });
    await h.api._test.saveAllRecords(rawA, cfg, scopeA);

    const character = await h.host.getCharacter();
    const chatB = { id: 'scope-b-chat', chatId: 'scope-b-chat', name: 'Scope B', message: [], messages: [] };
    character.chats.push(chatB);

    const switchToChat = index => {
      character.chatPage = index;
      h.host.getCurrentChatIndex = async () => index;
      h.host.getCurrentChat = h.host.getChat = async () => character.chats[index];
      h.host.getChatFromIndex = async (_c, idx) => character.chats[idx];
    };

    // Switch from Scope A to Scope B while the embedding provider is awaiting response
    h.host.nativeFetch = async (_url, init) => {
      switchToChat(1);
      const inputs = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) };
        }
      };
    };

    const switchedResult = await h.api.processPendingEmbeddingWork({ sourceHash: sourceA.sourceHash, scope: scopeA });
    assert.equal(switchedResult.ok, false);
    assert.equal(switchedResult.reason, 'FLASHBACK_EMBEDDING_SCOPE_CHANGED');

    const scopeB = await h.api.resolveCurrentScope(false);
    assert.notEqual(scopeB.scopeKey, scopeA.scopeKey);
    const loadedB = await h.api._test.loadScopeRecords(scopeB.scopeKey);
    assert.equal(loadedB.records.length, 0, 'Scope B must not receive any records or vectors from Scope A');

    const loadedA = await h.api._test.loadScopeRecords(scopeA.scopeKey);
    assert.equal(loadedA.records[0].vector.length, 0, 'Scope A record must not adopt vector after mid-flight scope switch');

    // Switch back to Scope A, recover the uncertain attempt via explicit offer, and verify normal completion
    switchToChat(0);
    h.host.nativeFetch = async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) };
        }
      };
    };
    const viewA = await h.api.inspectEmbeddingWork();
    const groupA = viewA.groups.find(g => g.sourceHash === sourceA.sourceHash);
    assert.equal(groupA?.status, 'uncertain');
    const offer = await h.context.__faultRecoveryBridge.issueEmbeddingRecoveryOffer({
      ...groupA,
      scopeKey: viewA.scopeKey,
      profile: viewA.profile,
      storageBinding: viewA.storageBinding,
      generation: viewA.generation
    });
    const recovered = await h.context.__faultRecoveryBridge.acceptEmbeddingRecoveryOffer(offer.token, groupA);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.ready, 1);

    // Also verify in-flight scope switch during recallRecords returns 0 records
    h.host.nativeFetch = async (_url, init) => {
      switchToChat(1);
      const inputs = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) };
        }
      };
    };
    const recallAfterSwitch = await h.api.recallRecords('Inspect sector 1 archival vault.', cfg, scopeA, { currentPairIndex: 5 });
    assert.equal(recallAfterSwitch.records.length, 0, 'recall must not publish after in-flight scope switch');
  } finally {
    await h.cleanup();
  }
});

test('Scenario 5: 대량 archive/rebuild — multi-turn corpus ingestion, archive vector group repair, and full rebuild integrity', async () => {
  // 5a. Archive group vector repair across multiple response groups
  const archiveFixture = await createArchiveOwnerFixture({ includeEpisode: true });
  try {
    const preview1 = await archiveFixture.api.archiveRecovery.preview();
    assert.equal(preview1.allowed, true);
    assert.equal(preview1.counts.eligibleGroups, 1);
    assert.equal(preview1.counts.remainingGroups, 1);
    const repair1 = await archiveFixture.api.archiveRecovery.repair(preview1.ticket);
    assert.equal(repair1.status, 'verified');

    const preview2 = await archiveFixture.api.archiveRecovery.preview();
    assert.equal(preview2.allowed, true);
    assert.equal(preview2.counts.eligibleGroups, 1);
    assert.equal(preview2.counts.remainingGroups, 0);
    const repair2 = await archiveFixture.api.archiveRecovery.repair(preview2.ticket);
    assert.equal(repair2.status, 'verified');

    const chain = await archiveFixture.readChain();
    assert.equal(chain.verified, true);
    for (const row of chain.recordsList.filter(r => r.sourceType === 'response')) {
      assert.deepEqual(Array.from(row.vector), [0, 1, 0, 0], `archive response ${canonicalIdentity(row)} repaired`);
    }
  } finally {
    await archiveFixture.dispose();
  }

  // 5b. 24-turn live corpus ingestion, bounded multi-pass embedding drain, and full rebuild + re-embed
  const h = await createHarness();
  try {
    const cfg = h.api._test.normalizeSettings({
      embeddingEnabled: true,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 3,
      embeddingUrl: 'https://provider.invalid/v1/embeddings',
      embeddingMaxRetries: 0,
      embeddingBatchSize: 8,
      progressiveReembedMaxRecords: 12,
      progressiveReembedMaxRequests: 8,
      embeddingAutoProcess: false,
      autoEpisodeIndex: false,
      episodeIndexEnabled: false
    });
    await h.api.saveSettings(cfg);
    h.host.nativeFetch = async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) };
        }
      };
    };

    const chat = await h.host.getCurrentChat();
    const totalTurns = 24;
    chat.message = [];
    for (let i = 1; i <= totalTurns; i += 1) {
      chat.message.push(
        { role: 'user', chatId: `u-${i}`, data: `Inspect sector ${i} archival vault.` },
        { role: 'assistant', chatId: `a-${i}`, data: `Sector ${i} archival vault holds artifact token-${i} inside cabinet-${i}.` }
      );
    }
    chat.messages = chat.message;

    const scope = await h.api.resolveCurrentScope(false);
    await h.api.ingestLiveChatColdStart({ scope: 'current', canonical: true, settings: cfg, skipEpisodeRebuild: true });

    let loaded = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(loaded.records.length, totalTurns, 'all 24 turns ingested');

    // Drain all 24 turns across bounded passes
    for (let pass = 0; pass < 6; pass += 1) {
      const res = await h.api.processPendingEmbeddingQueue({ maxSources: 12, maxRequests: 8 });
      if (res.pendingSources === 0 || res.ready === 0) break;
    }
    loaded = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(loaded.records.filter(r => r.embeddingReceipt?.status === 'ready').length, totalTurns);

    // Execute full rebuild from live chat and drain any remaining pending vectors
    const rebuilt = await h.api.runMemoryMaintenance('rebuild', { settings: cfg });
    assert.equal(rebuilt.after.storedTurns, totalTurns);
    for (let pass = 0; pass < 6; pass += 1) {
      const res = await h.api.processPendingEmbeddingQueue({ maxSources: 12, maxRequests: 8 });
      if (res.pendingSources === 0 || res.ready === 0) break;
    }
    const afterRebuild = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(afterRebuild.records.length, totalTurns);
    assert.equal(
      afterRebuild.records.filter(r => r.embeddingReceipt?.status === 'ready' && r.vector.length === 3).length,
      totalTurns,
      'all 24 turns verified ready after full rebuild and queue drain'
    );
  } finally {
    await h.cleanup();
  }
});
