'use strict';
// A previous turn's Micro often finishes while the next recall runs. That Micro was
// not part of the corpus the recall selected from, so its publication must not void
// delivery. Before the fix the whole recall was dropped three ways:
// LIBRA_GRAPH_CORPUS_SOURCE_CHANGED (window-level owner proof),
// LIBRA_GRAPH_COMPILER_PHYSICAL_READSET_STALE (whole-corpus pin set) and
// LIBRA_GRAPH_RESOURCE_CLOSED (every owner write revoked in-flight readsets).
//
// The relaxation must stay narrow: a change to a record the recall consumed, or the
// replacement of an already published Micro head, must still refuse delivery.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverFixture, withLorebook } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const QUOTE = '민아가 은빛 열쇠를 준호에게 잠시 건넸다.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PHYSICAL = 'assertPhysicalCurrentness: async (dependencies = null, verifyContext = null) => {';
const COMPLETE = 'consumedProofComplete = !unresolved;';
const FULL_PIN = 'if (!consumedProofComplete) for (const readSet of conditionalReadSets)';

async function setup() {
  let listener;
  const host = { addRisuChatListener: async (_kind, handler) => { listener = handler; return true; } };
  const server = await serverFixture({ mode: 'server_only', host, transformSource: source => {
    assert.equal(source.split(PHYSICAL).length, 2);
    assert.equal(source.split(COMPLETE).length, 2);
    assert.equal(source.split(FULL_PIN).length, 2);
    return source.replace(FULL_PIN, 'if (!consumedProofComplete && (globalThis.__fullPinChecks = (globalThis.__fullPinChecks || 0) + 1)) for (const readSet of conditionalReadSets)')
      .replace(PHYSICAL, PHYSICAL + '\n            if (globalThis.__beforePhysicalCheck) await globalThis.__beforePhysicalCheck();')
      .replace(COMPLETE, 'if (globalThis.__forceUnresolved) unresolved = true;\n                  ' + COMPLETE
        + '\n                  (globalThis.__consumedChecks ||= []).push({ complete: consumedProofComplete,'
        + ' families: [...candidateUnits].map(u => string(u?.family || \'\')), keys: [...consumedStorageKeys],'
        + ' items: bundleItems.map(item => string(item?.nodeId || \'\')) });');
  } });
  const f = withLorebook(server.f);
  await f.run(); await f.r.api.retryPendingUnifiedVectors();
  const registry = JSON.parse(server.local.get('libra:v1:scope-registry:v1'));
  const scopeKey = Object.values(registry).find(row => row.chatId === f.chat.id).scopeKey;
  server.local.set('__memory_suite_internal_scope_routes_v1__:libra', JSON.stringify({
    schema: 'memory-suite.scope-routing.v1', namespace: 'libra', pluginId: 'LIBRA', legacyGlobalModeImported: true,
    entries: { [scopeKey]: { scopeId: scopeKey, scopeKey, mode: 'server_only', origin: 'user_explicit', updatedAt: 1 } } }));
  let turn = 6;
  const startMicro = (lagMs = 0) => {
    const t = turn++;
    f.chat.message.push({ role: 'user', chatId: `t${t}-u`, data: '열쇠는 누가 보관하지?' },
      { role: 'assistant', chatId: `t${t}-a`, data: QUOTE });
    f.chat.messages = f.chat.message;
    f.control.onCall = async args => {
      const input = JSON.parse(args[0].messages[1].content);
      if (lagMs) await sleep(lagMs);
      return { type: 'success', result: JSON.stringify({ schema: 'libra.micro_producer_envelope.v1',
        personCandidates: { spans: [], relations: [] }, micro: { schema: 'libra.micro_memory.v1', ...input.binding,
          claims: [{ changeKind: 'world', text: QUOTE, actor: '민아', target: '은빛 열쇠', temporalRole: 'current',
            certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none', evidence: {
              role: 'assistant', messageId: input.assistant.messageId, startOffset: 0, endOffset: QUOTE.length, exactQuote: QUOTE } }] } }) };
    };
    listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: f.chat.message.length - 1 });
    return () => waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === t, 60000);
  };
  for (let i = 0; i < 3; i++) await startMicro()();
  const recall = async () => {
    const out = await f.control.hooks.beforeRequest([{ role: 'user', content: QUOTE }], 'model');
    return { out, meta: f.r.api.getRuntime().lastMemoryInjectionMeta };
  };
  // Change server rows once, right before the first final physical check.
  const beforeFinalCheck = mutateRows => {
    let done = false;
    f.r.context.__beforePhysicalCheck = async () => {
      if (done) return; done = true;
      for (const row of server.storedRows().filter(mutateRows)) await server.mutate(row.key, { ...row.value, externalEdit: true });
    };
  };
  return { server, f, startMicro, recall, beforeFinalCheck };
}

test('server_only: a Micro published mid-recall does not void delivery', async () => {
  const x = await setup();
  try {
    // Every server read takes 10 ms, so the recall outlasts the provider lag below
    // and the Micro is published while the recall is running.
    x.server.hooks.beforeServerRequest = async () => { await sleep(10); };
    const published = x.startMicro(300);
    await sleep(20);
    const { out, meta } = await x.recall();
    await published();
    assert.equal(meta.injected, true, JSON.stringify({ errorCode: meta.errorCode, admission: meta.admission }));
    assert.equal(meta.finalVerification.status, 'verified');
    assert.ok(out.some(row => String(row.content).includes(QUOTE)));
  } finally { await x.server.cleanup(); }
});

test('server_only: a consumed record changed before the final check refuses delivery', async () => {
  const x = await setup();
  try {
    x.beforeFinalCheck(row => /:micro-memory:/.test(row.key) && !/:micro-memory-head:/.test(row.key));
    const { meta } = await x.recall();
    assert.equal(meta.injected, false, 'changed consumed Micro bodies must not be delivered');
  } finally { await x.server.cleanup(); }
});

test('server_only: a replaced Micro head before the final check refuses delivery', async () => {
  const x = await setup();
  try {
    x.beforeFinalCheck(row => /:micro-memory-head:/.test(row.key));
    const { meta } = await x.recall();
    assert.equal(meta.injected, false, 'replacing a published Micro head is not a first publication');
  } finally { await x.server.cleanup(); }
});

test('server_only: the narrow check covers every consumed item; an unresolved item restores the full check', async () => {
  const x = await setup();
  try {
    // Normal recall: every delivered item is resolved and its records are re-read.
    x.f.r.context.__consumedChecks = [];
    const normal = await x.recall();
    assert.equal(normal.meta.injected, true);
    const checks = x.f.r.context.__consumedChecks;
    assert.ok(checks.length >= 1, 'the final consumer ran the consumed-evidence check');
    for (const check of checks) {
      assert.equal(check.complete, true, JSON.stringify(check));
      assert.ok(check.items.length >= 1);
      assert.ok(check.keys.some(storageKey => /:micro-memory:/.test(storageKey)), 'consumed Micro records are re-read');
    }
    const families = new Set(checks.flatMap(check => check.families));
    assert.ok(families.has('micro') && families.size >= 2, 'multiple families are consumed: ' + [...families]);
    // A complete consumed set skips the whole-corpus pin set; forcing one item
    // unresolved makes the final check read the whole pin set again.
    assert.equal(x.f.r.context.__fullPinChecks || 0, 0, 'complete consumed set: no full pin-set check');
    x.f.r.context.__forceUnresolved = true;
    const forced = await x.recall();
    assert.ok((x.f.r.context.__fullPinChecks || 0) >= 1, 'an incomplete consumed set falls back to the full pin-set check');
    assert.equal(forced.meta.injected, true, 'unchanged sources still deliver through the full check');
  } finally { await x.server.cleanup(); }
});
