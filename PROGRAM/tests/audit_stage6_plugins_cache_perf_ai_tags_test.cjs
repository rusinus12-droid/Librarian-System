'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { fixture: libraFixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { load: loadGradia } = require('./gradia/host.cjs');
const { createFixture: createFlashbackFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('Stage 6 (#1): LIBRA enables single-stage system prompt cache without disabling native JSON schema or off policy', async () => {
  const f = await libraFixture();
  try {
    const longSystem = 'LIBRA canonical system contract.\n' + 'Rule: preserve literal speaker roles and evidence citations.\n'.repeat(160);
    const userPrompt = 'Turn 1..5 transcript.';
    const claudePreset = { provider: 'claude', model: 'claude-sonnet-4-5', prompt_cache: 'auto', temp: 0 };
    const claudeOffPreset = { ...claudePreset, prompt_cache: 'off' };
    const openaiPreset = { provider: 'openai', model: 'gpt-5.4', prompt_cache: 'auto', temp: 0 };

    const claudeDecision = f.r.api.debugBuildPromptCacheDecision({}, 'librarian', claudePreset, longSystem, userPrompt, { taskKind: 'canonical_memory' });
    assert.equal(claudeDecision.enabled, true);
    assert.equal(claudeDecision.systemOnly, true);
    assert.equal(claudeDecision.strategy, 'anthropic_system_explicit');
    assert.ok(claudeDecision.cacheKey.startsWith('libra:system:'));

    const anthropicBody = f.r.api.debugBuildAnthropicPayload(claudePreset, longSystem, userPrompt, { promptCacheDecision: claudeDecision, maxTokens: 2048 });
    assert.equal(Array.isArray(anthropicBody.system), true);
    assert.equal(anthropicBody.system[0]?.cache_control?.type, 'ephemeral');
    assert.equal(typeof anthropicBody.messages?.[0]?.content, 'string');

    const offDecision = f.r.api.debugBuildPromptCacheDecision({}, 'librarian', claudeOffPreset, longSystem, userPrompt, { taskKind: 'canonical_memory' });
    assert.equal(offDecision.enabled, false);
    assert.equal(offDecision.reason, 'disabled');

    const openaiDecision = f.r.api.debugBuildPromptCacheDecision({}, 'librarian', openaiPreset, longSystem, userPrompt, { taskKind: 'canonical_memory' });
    assert.equal(openaiDecision.enabled, true);
    assert.equal(openaiDecision.systemOnly, true);
    assert.equal(openaiDecision.strategy, 'openai_system_implicit');

    const openaiBody = f.r.api.debugBuildOpenAICompatPayload(openaiPreset, longSystem, userPrompt, { promptCacheDecision: openaiDecision, maxTokens: 2048 });
    assert.equal(openaiBody.prompt_cache_key, openaiDecision.cacheKey);

    const src = read('plugins/LIBRA.js');
    assert.match(src, /if \(promptCacheDecision\.enabled && !promptCacheDecision\.systemOnly && options\.jsonMode === true && \(provider === 'openai' \|\| mode === 'anthropic'\)\)/);
    assert.match(src, /promptCacheUnsupportedRetry:\s*true/);
  } finally {
    await f.r.cleanup();
  }
});

test('Stage 6 (#12): LIBRA coalesces concurrent resolveContext calls and uses summaryOnly scan refresh when GUI is hidden', async () => {
  let getCharacterCalls = 0;
  let gatePromise = null;
  let releaseGate = null;
  let notifyGateEntered = null;
  const transformSource = src => src.replace(
    '      getUnifiedStorageStatus,',
    '      debugResolveContext: force => resolveContext(force),\n      getUnifiedStorageStatus,'
  ).replace(
    '    async getUnifiedStorageStatus() {',
    '    debugResolveContext: force => LibraMemoryCore.debugResolveContext(force),\n    async getUnifiedStorageStatus() {'
  );
  const f = await libraFixture({
    transformSource,
    host: {
      getCharacter: async () => {
        getCharacterCalls += 1;
        if (gatePromise) {
          notifyGateEntered?.();
          await gatePromise;
        }
        return {
          chaId: 'char-1',
          name: 'Mina',
          chatPage: 0,
          chats: [{
            id: 'chat-1',
            name: 'Chat 1',
            message: [
              { role: 'user', chatId: 'u1', data: 'Hi' },
              { role: 'char', chatId: 'a1', data: 'Hello' }
            ]
          }]
        };
      }
    }
  });
  try {
    // Drain any background startup resolveContext call before arming the gate.
    await f.r.api.debugResolveContext(false);
    await new Promise(resolve => setTimeout(resolve, 15));
    await f.r.api.debugResolveContext(false);

    const gateHit = new Promise(resolve => { notifyGateEntered = resolve; });
    gatePromise = new Promise(resolve => { releaseGate = resolve; });
    const before = getCharacterCalls;
    const pending = Promise.all([
      f.r.api.debugResolveContext(false),
      f.r.api.debugResolveContext(false),
      f.r.api.debugResolveContext(false)
    ]);
    await gateHit;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(getCharacterCalls - before, 1, 'concurrent resolveContext(false) calls must share one host read while in-flight');
    gatePromise = null;
    notifyGateEntered = null;
    releaseGate?.();
    const [a, b, c] = await pending;
    assert.equal(getCharacterCalls - before, 1, 'concurrent resolveContext(false) calls must share one host read');
    assert.equal(a.scope.scopeKey, b.scope.scopeKey);
    assert.equal(b.scope.scopeKey, c.scope.scopeKey);

    // Sequential call after completion must re-read live host state (no stale TTL caching)
    const seqBefore = getCharacterCalls;
    await f.r.api.debugResolveContext(false);
    assert.equal(getCharacterCalls - seqBefore, 1, 'sequential resolveContext(false) must re-read fresh host state');

    const src = read('plugins/LIBRA.js');
    assert.match(src, /summaryOnly:\s*options\.summaryOnly \?\? !\(typeof Gui !== 'undefined' && Gui\?\.visible\)/);
  } finally {
    gatePromise = null;
    notifyGateEntered = null;
    try { releaseGate?.(); } catch (_) {}
    await f.r.cleanup();
  }
});

test('Stage 6 (#13): HAYAKU pruneStorageRecords evicts stale-epoch non-permanent historical records while preserving active, current-epoch, and permanent records', async () => {
  const h = await createHayakuRuntime();
  try {
    const _t = h.hayaku._test;
    const mkRec = (id, recordState, extra = {}) => ({
      recordId: id,
      hash: `h_${id}`,
      slotId: `slot:${id}`,
      packetType: 'current_snapshot',
      turnStart: 1,
      turnEnd: 1,
      capturedAt: extra.capturedAt || 1000,
      requestSequence: extra.requestSequence || 1,
      recordState,
      raw: JSON.stringify(createValidPacket({ turn: 1, summary: `Alice-1 ${id}` })),
      ...extra
    });
    const records = [];
    // Active & permanent & current-epoch historical must all survive even when evictables exceed cap
    const act = mkRec('act-1', 'active', { capturedAt: 10 });
    const curHist = mkRec('cur-hist-1', 'historical', { coldStartEpochId: 'epoch-2', capturedAt: 20 });
    const permHist = mkRec('perm-hist-1', 'historical', { coldStartEpochId: 'epoch-1', permanentSessionHistory: true, capturedAt: 30 });
    records.push(act, curHist, permHist);
    for (let i = 0; i < 1100; i += 1) {
      records.push(mkRec(`stale-${i}`, 'historical', { coldStartEpochId: 'epoch-1', capturedAt: 100 + i }));
    }
    const ledger = {
      coldStart: { activeEpochId: 'epoch-2' },
      slotHeads: [
        { slotId: 'slot:stale-0', state: 'historical', coldStartEpochId: 'epoch-1', selectedRecordId: 'stale-0', selectedVariantHash: 'h_stale-0' },
        { slotId: 'slot:cur-hist-1', state: 'historical', coldStartEpochId: 'epoch-2', selectedRecordId: 'cur-hist-1', selectedVariantHash: 'h_cur-hist-1' }
      ]
    };
    const kept = _t.pruneStorageRecords(records, ledger);
    const keptIds = new Set(kept.map(r => r.recordId));
    assert.equal(keptIds.has('act-1'), true);
    assert.equal(keptIds.has('cur-hist-1'), true);
    assert.equal(keptIds.has('perm-hist-1'), true);
    assert.equal(keptIds.has('stale-0'), false, 'stale-epoch historical slotHead must not pin ancient historical record');
    assert.ok(kept.filter(r => r.recordId.startsWith('stale-')).length <= 1024);
  } finally {
    await h.dispose();
  }
});

test('Stage 6 (#2): GRADIA evidenceRun extra_body_json allowlists safe tuning keys and rejects prompt/cap overrides', async () => {
  const { plugin } = await loadGradia();
  assert.equal(plugin.debugIsSafeEvidenceExtraBody({ num_ctx: 32768 }), true);
  assert.equal(plugin.debugIsSafeEvidenceExtraBody({ options: { num_ctx: 32768, top_p: 0.9, repeat_penalty: 1.1 } }), true);
  assert.equal(plugin.debugIsSafeEvidenceExtraBody({ messages: [{ role: 'user', content: 'x' }] }), false);
  assert.equal(plugin.debugIsSafeEvidenceExtraBody({ max_tokens: 100 }), false);
  assert.equal(plugin.debugIsSafeEvidenceExtraBody({ options: { num_predict: 100 } }), false);
  assert.equal(plugin.debugIsSafeEvidenceExtraBody({ options: { num_ctx: -1 } }), false);
  assert.equal(plugin.debugIsSafeEvidenceExtraBody(null), false);
});

test('Stage 6 (#3 & #8): Flashback derives Vertex URL, signs RS256 Service Account JWT, and clears pendingUser on empty-after-filter assistant', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const saJson = JSON.stringify({
    type: 'service_account',
    project_id: 'demo-proj',
    location: 'us-central1',
    client_email: 'fb@demo-proj.iam.gserviceaccount.com',
    private_key: pem
  });

  const tokenRequests = [];
  const f = await createFlashbackFixture({
    nativeFetch: async (url, init = {}) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        const params = new URLSearchParams(String(init.body || ''));
        tokenRequests.push({ url, assertion: params.get('assertion') });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'mock-vertex-oauth-token', expires_in: 3600 })
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });
  try {
    const _t = f.api._test;
    const derivedUrl = _t.vertexEmbeddingUrl({ embeddingUrl: '', embeddingModel: 'gemini-embedding-001' }, saJson);
    assert.equal(derivedUrl, 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-proj/locations/us-central1/publishers/google/models/gemini-embedding-001:predict');

    const token1 = await _t.resolveFlashbackVertexAccessToken(saJson);
    const token2 = await _t.resolveFlashbackVertexAccessToken(saJson);
    assert.equal(token1, 'mock-vertex-oauth-token');
    assert.equal(token2, 'mock-vertex-oauth-token');
    assert.equal(tokenRequests.length, 1, 'cached Vertex access token must reuse without second OAuth request');

    const parts = String(tokenRequests[0].assertion || '').split('.');
    assert.equal(parts.length, 3, 'Vertex assertion must be compact JWS');
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    );
    assert.equal(verified, true, 'JWT RS256 signature must verify with corresponding RSA public key');

    // Empty-after-filter assistant must break pendingUser so next assistant does not glue to earlier user
    const pairs = _t.liveChatPairsFromNormalized([
      { index: 0, role: 'user', contentText: 'First user prompt', rawContent: 'First user prompt' },
      { index: 1, role: 'assistant', contentText: '', rawContent: '<thought>Only internal CoT</thought>' },
      { index: 2, role: 'assistant', contentText: 'Orphan follow-up', rawContent: 'Orphan follow-up' }
    ]);
    assert.equal(pairs.length, 0);

    // Completed turn before an empty continuation must still flush before clearing pendingUser
    const pairsWithCompleted = _t.liveChatPairsFromNormalized([
      { index: 0, role: 'user', contentText: 'First user prompt', rawContent: 'First user prompt' },
      { index: 1, role: 'assistant', contentText: 'Visible reply', rawContent: 'Visible reply' },
      { index: 2, role: 'assistant', contentText: '', rawContent: '<chainofthought>Extra</chainofthought>' },
      { index: 3, role: 'assistant', contentText: 'Trailing orphan', rawContent: 'Trailing orphan' }
    ]);
    assert.equal(pairsWithCompleted.length, 1);
    assert.equal(pairsWithCompleted[0].assistantText, 'Visible reply');
  } finally {
    await f.dispose();
  }
});

test('Stage 6 (#8): Default ignoredTags include chainofthought, statusdata, sot-memo without altering presentation defaults', () => {
  const code = read('sdk/MemorySuiteSourceInput.libra.source.js');
  const ctx = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder, URL };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  for (const owner of ['libra', 'hayaku', 'flashback']) {
    const defaults = ctx.memorySuiteDefaultSourceRules(owner);
    for (const tag of ['chainofthought', 'statusdata', 'sot-memo']) {
      assert.ok(defaults.ignoredTags.includes(tag), `${owner} default ignoredTags missing ${tag}`);
    }
  }
  assert.deepEqual(Array.from(ctx.memorySuiteDefaultPresentationTags()), ['img', 'lb-lazy', 'lb-stage', 'lb-stage-marker']);
});
