'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { fixture: libraFixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const createOwnerScopeDelete = require('../server/core/owner-scope-delete.cjs');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('Stage 2A: Source Input defaults preserve hidden reasoning tags and suite-blocks strips HAYAKU final reminder', () => {
  const code = read('sdk/MemorySuiteSourceInput.libra.source.js');
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    URL
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  const defaults = ctx.memorySuiteDefaultSourceRules('libra');
  for (const tag of ['thoughts', 'thought', 'think', 'thinking', 'reasoning', 'analysis', 'lb-xnai', 'img', 'lb-lazy', 'lb-stage', 'lb-stage-marker']) {
    assert.ok(defaults.ignoredTags.includes(tag), `default ignoredTags missing ${tag}`);
  }
  const sample = 'Hello <thought>secret</thought><think>p1</think><thinking>p2</thinking><reasoning>p3</reasoning><analysis>p4</analysis> World';
  const projected = ctx.memorySuiteProjectSourceRules(sample, defaults).text.replace(/\s+/g, ' ').trim();
  assert.equal(projected, 'Hello World');

  const withReminder = 'Body text\n[HAYAKU SIDE-WRITE FINAL REMINDER]\nDo not forget packet';
  assert.equal(ctx.memorySuiteStripInternalSource(withReminder).trim(), 'Body text');
});

test('Stage 2B: LIBRA empty-after-filter assistant does not merge u_k into u_{k+1}, swipeId invalidates slot, and transient missing chat.id fails closed', async () => {
  const expose = source => {
    let out = source.replace(
      'await LibraMemoryCore.readySourceRules();',
      'globalThis.__auditCore = LibraMemoryCore; await LibraMemoryCore.readySourceRules();'
    );
    out = out.replace(
      'const libraCanonicalSlotPreservationKind = async',
      'const libraCanonicalSlotPreservationKind = globalThis.__auditPreservation = async'
    );
    return out;
  };
  const f = await libraFixture({ transformSource: expose });
  try {
    const core = f.r.context.__auditCore;
    assert.ok(core, 'LibraMemoryCore should be exposed');

    // 1. Empty-after-filter assistant resets pendingUser so u1 does not concatenate into u2.
    const filterChat = {
      id: 'chat-empty-filter',
      message: [
        { role: 'user', chatId: 'u1', data: 'First user prompt' },
        { role: 'char', chatId: 'a1', data: '<thought>Only internal thoughts</thought>' },
        { role: 'user', chatId: 'u2', data: 'Second user prompt' },
        { role: 'char', chatId: 'a2', data: 'Visible second reply' }
      ]
    };
    const pairs = core.buildPairs(filterChat, 'scope-empty-filter');
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].user.text, 'Second user prompt');
    assert.ok(!pairs[0].user.text.includes('First user prompt'));

    // 2. Same-chatId swipeId reroll invalidates slot preservation.
    const batchForSwipe = Array.from({ length: 4 }, (_, i) => ({
      turn: i + 1,
      user: { chatId: `u_${i}`, text: `U${i}`, swipeId: '0' },
      assistant: { chatId: `a_${i}`, text: `A${i}`, swipeId: '0', generationId: `g_${i}` }
    }));
    const saved = f.r.context.__auditPreservation;
    assert.equal(typeof saved, 'function');

    // Run normal 5-turn analysis on fixture messages with swipeId='0'
    for (let i = 0; i < f.chat.message.length; i += 1) {
      f.chat.message[i].swipeId = '0';
    }
    const runResult = await f.run();
    assert.equal(runResult.completed, 1);
    const ctx = await core.resolveContext();
    const manifest = f.getManifest();
    const ref = manifest.memories['1'];
    assert.ok(ref, 'batch 1 should be committed');
    const sameSwipePairs = core.buildPairs(f.chat, ctx.scope.scopeKey).slice(0, 5);
    assert.equal(sameSwipePairs[0].assistant.swipeId, '0');
    const stillValid = await saved(ctx, ref, sameSwipePairs);
    assert.equal(stillValid, 'native_identity_verified');

    // Now change swipeId on assistant turn 1 while keeping chatId identical!
    f.chat.message[1].swipeId = '1';
    const rerolledPairs = core.buildPairs(f.chat, ctx.scope.scopeKey).slice(0, 5);
    assert.equal(rerolledPairs[0].assistant.swipeId, '1');
    const invalidated = await saved(ctx, ref, rerolledPairs);
    assert.equal(invalidated, false, 'swipeId change on same chatId must invalidate canonical slot preservation');
    void batchForSwipe;

    // 3. Transient missing chat.id triggers fail-closed transientUnstableChatIdentity when character.chats has explicit IDs
    const charChats = f.character.chats;
    const savedChatId = f.chat.id;
    assert.ok(Array.isArray(charChats) && charChats.some(c => c.id));
    delete f.chat.id;
    delete f.chat.chatId;
    try {
      const brokenCtx = await core.resolveContext(true);
      assert.equal(brokenCtx.transientUnstableChatIdentity, true);
      const scanRes = await core.scan();
      assert.equal(scanRes.skipped, true);
      assert.equal(scanRes.reason, 'transient_missing_chat_id');
    } finally {
      f.chat.id = savedChatId;
    }
  } finally {
    await f.r.cleanup();
  }
});

test('Stage 2C: Flashback swipe mismatch, 4096 scope registry cap, HAYAKU prefixes, RETRACE links, GRADIA signatures, and LIBRA owner-scope-delete protection/local-vector cleanup', async () => {
  const retraceSrc = read('plugins/RETRACE.js');
  assert.match(retraceSrc, /HAYAKU_CAPTURE_DELTA_PREFIX\s*=\s*'hayaku\.v2\.storage_reconciliation_journal\.capture_delta::'/);
  assert.match(retraceSrc, /HAYAKU_FAILED_ANALYSIS_CHUNK_PREFIX\s*=\s*'hayaku\.v2\.failed_analysis_chunk\.'/);
  assert.match(retraceSrc, /micro-memory:\|micro-state:\|micro-handoff-archive:\|narrative:\|continuity:\|worldline:/);
  assert.match(retraceSrc, /\(\?:source\|forkedfrom\|copiedfrom\|predecessor\|inheritedfrom\|archive\)\.\*scope\(\?:key\|id\)\$/);
  assert.match(retraceSrc, /unregisteredManifest/);

  const flashbackSrc = read('plugins/Flashback_Memory.js');
  assert.match(flashbackSrc, /\.slice\(0,\s*4096\)/);
  assert.match(flashbackSrc, /'archiveScopeKey'/);
  assert.match(flashbackSrc, /storedSwipes\.join\('\|'\)\s*!==\s*liveSwipes\.join\('\|'\)/);

  const gradiaSrc = read('plugins/GRADIA.js');
  assert.match(gradiaSrc, /memorySuiteSourceTagKey\('gradia'\)/);
  assert.match(gradiaSrc, /const extractInputAssistTerminalTail\s*=[\s\S]{0,900}memorySuiteProjectSourceRules/);

  // Real runtime check of owner-scope-delete.cjs referenced_ancestor guard & libra:v1:local-vector cleanup
  const store = {
    plugin: new Map(),
    local: new Map()
  };
  let deletedMarked = false;
  const scopeKey = 'ancestor_scope';
  const childScopeKey = 'child_scope';
  const localVecShared = 'libra:v1:local-vector:shared_hash';
  const localVecOwned = 'libra:v1:local-vector:owned_hash';

  store.plugin.set(`libra:v1:scope:${scopeKey}:manifest`, { scopeKey, schema: 'libra.manifest.v1' });
  store.plugin.set(`libra:v1:scope:${scopeKey}:vector:m1:r1:p1`, { scopeKey, localKey: localVecOwned, refs: [localVecShared] });
  store.local.set(localVecOwned, { data: [1, 2], localKey: localVecOwned });
  store.local.set(localVecShared, { data: [3, 4], localKey: localVecShared });
  store.plugin.set(`libra:v1:scope:${childScopeKey}:manifest`, { scopeKey: childScopeKey, archiveRef: { archiveScopeKey: scopeKey } });
  store.plugin.set(`libra:v1:scope:${childScopeKey}:vector:m2:r1:p1`, { scopeKey: childScopeKey, localKey: localVecShared });

  const makeRow = (space, key, value, rev = 1) => ({
    exists: value !== undefined,
    tombstone: value === null,
    space,
    key,
    value,
    revision: rev,
    digest: `dig_${key}_${rev}`,
    updatedAt: 1000
  });
  const repos = {
    libra: {
      list: (space, prefix) => ({
        records: [...store[space].entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => makeRow(space, k, v))
      }),
      get: (space, key) => makeRow(space, key, store[space].get(key)),
      isOwnerScopeDeleted: () => deletedMarked,
      applyConditionalBatch: (muts) => {
        for (const m of muts) {
          if (m.kind === 'remove') store[m.space].delete(m.key);
        }
        deletedMarked = true;
      }
    }
  };
  const ownerDelete = createOwnerScopeDelete({
    repositories: repos,
    backup: async () => ({ ok: true, result: { id: 'bk-1' } }),
    canStart: () => true,
    setMaintenance: () => {},
    advanceEpochs: () => {},
    getProtection: () => null,
    onDeleted: () => {}
  });

  // Protected while child manifest references archiveRef.archiveScopeKey === scopeKey
  await assert.rejects(
    () => ownerDelete({ namespace: 'libra' }, 'plan', { scopeKey }, scopeKey),
    /owner_scope_delete_referenced_ancestor/
  );

  // Remove child reference, now plan + execute must remove owned local-vector while keeping shared local-vector
  store.plugin.set(`libra:v1:scope:${childScopeKey}:manifest`, { scopeKey: childScopeKey });
  const plan = await ownerDelete({ namespace: 'libra' }, 'plan', { scopeKey }, scopeKey);
  const receipt = await ownerDelete({ namespace: 'libra' }, 'execute', { planId: plan.planId, scopeKey, fingerprint: plan.fingerprint }, scopeKey);
  assert.equal(receipt.ok, true);
  assert.equal(store.local.has(localVecOwned), false, 'owned local-vector must be deleted');
  assert.equal(store.local.has(localVecShared), true, 'shared local-vector still referenced by another scope must be preserved');
});
