'use strict';
// A previous turn's Micro often finishes while the next recall runs. That Micro was
// not part of the corpus the recall selected from, so its publication must not void
// delivery. Before the fix the whole recall was dropped with
// LIBRA_GRAPH_CORPUS_SOURCE_CHANGED (window-level owner proof) and then
// LIBRA_GRAPH_COMPILER_PHYSICAL_READSET_STALE (whole-corpus pin set).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverFixture, withLorebook } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const QUOTE = '민아가 은빛 열쇠를 준호에게 잠시 건넸다.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('server_only: a Micro published mid-recall does not void delivery', async () => {
  let listener;
  const host = { addRisuChatListener: async (_kind, handler) => { listener = handler; return true; } };
  const server = await serverFixture({ mode: 'server_only', host });
  const f = withLorebook(server.f);
  try {
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
    // Every server read during the recall takes 10 ms, so the recall outlasts the
    // provider lag below and the Micro is published while the recall is running.
    server.hooks.beforeServerRequest = async () => { await sleep(10); };
    const published = startMicro(300);
    await sleep(20);
    const out = await f.control.hooks.beforeRequest([{ role: 'user', content: QUOTE }], 'model');
    const meta = f.r.api.getRuntime().lastMemoryInjectionMeta;
    await published();
    assert.equal(meta.injected, true, JSON.stringify({ errorCode: meta.errorCode, admission: meta.admission }));
    assert.equal(meta.finalVerification.status, 'verified');
    assert.ok(out.some(row => String(row.content).includes(QUOTE)));
  } finally { await server.cleanup(); }
});
