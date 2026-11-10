'use strict';
// After a new turn's Micro is published, the runtime common index must be rebuilt and
// then used by the next recall. Two defects sent every later recall to the full cold
// corpus build instead:
//   1. a recall's background drain cleared the pending rebuild timer (and a yielded
//      build never rescheduled), so the index was never rebuilt;
//   2. each recall armed its live boundary record, and that non-source write dropped
//      the freshly built index before the graph query looked at it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture: localFixture } = require('./fixtures/libra_lore_link_index_fixture.cjs');
const { serverFixture, withLorebook } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const QUOTE = '민아가 은빛 열쇠를 준호에게 잠시 건넸다.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ['plugin_only', 'server_only']) test(`${mode}: recall after a new Micro uses the rebuilt runtime index`, async () => {
  let listener;
  const host = { addRisuChatListener: async (_kind, handler) => { listener = handler; return true; } };
  const server = mode !== 'plugin_only' ? await serverFixture({ mode, host }) : null;
  const f = server ? withLorebook(server.f) : await localFixture({ host });
  try {
    // 이 테스트는 세션(volatile) 인덱스 재사용만 검증한다. 상설 인덱스 자동 구축이 켜져 있으면
    // 첫 cold 회수 뒤 durable 인덱스가 생겨 기대값이 durable_common_index 로 바뀌므로 끈다.
    const memorySettings = await f.r.api.getLibraMemorySettings();
    if (memorySettings.autoDurableIndex !== false) {
      await f.r.api.saveLibraMemorySettings({ ...memorySettings, autoDurableIndex: false });
    }
    await f.run(); await f.r.api.retryPendingUnifiedVectors();
    const values = server?.local || f.r.values;
    const registry = JSON.parse(values.get('libra:v1:scope-registry:v1'));
    const scopeKey = Object.values(registry).find(row => row.chatId === f.chat.id).scopeKey;
    values.set('__memory_suite_internal_scope_routes_v1__:libra', JSON.stringify({
      schema: 'memory-suite.scope-routing.v1', namespace: 'libra', pluginId: 'LIBRA', legacyGlobalModeImported: true,
      entries: { [scopeKey]: { scopeId: scopeKey, scopeKey, mode, origin: 'user_explicit', updatedAt: 1 } } }));
    let turn = 6;
    const addMicro = async () => {
      const t = turn++;
      f.chat.message.push({ role: 'user', chatId: `t${t}-u`, data: '열쇠는 누가 보관하지?' },
        { role: 'assistant', chatId: `t${t}-a`, data: QUOTE });
      f.chat.messages = f.chat.message;
      f.control.onCall = async args => {
        const input = JSON.parse(args[0].messages[1].content);
        return { type: 'success', result: JSON.stringify({ schema: 'libra.micro_producer_envelope.v1',
          personCandidates: { spans: [], relations: [] }, micro: { schema: 'libra.micro_memory.v1', ...input.binding,
            claims: [{ changeKind: 'world', text: QUOTE, actor: '민아', target: '은빛 열쇠', temporalRole: 'current',
              certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none', evidence: {
                role: 'assistant', messageId: input.assistant.messageId, startOffset: 0, endOffset: QUOTE.length, exactQuote: QUOTE } }] } }) };
      };
      listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: f.chat.message.length - 1 });
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === t, 60000);
      f.control.onCall = async () => { throw new Error('recall must not invoke a provider'); };
    };
    const recall = async () => {
      const out = await f.control.hooks.beforeRequest([{ role: 'user', content: QUOTE }], 'model');
      const meta = f.r.api.getRuntime().lastMemoryInjectionMeta;
      assert.equal(meta.injected, true, JSON.stringify(meta));
      assert.equal(meta.finalVerification.status, 'verified');
      assert.ok(out.some(row => String(row.content).includes(QUOTE)));
      return f.r.api.getLastMemoryRecall().corpusRead.mode;
    };
    const waitIndex = async () => {
      for (const deadline = Date.now() + 60000; Date.now() < deadline; await sleep(200)) {
        const status = f.r.api.inspectVolatileMemoryGraphCorpus();
        if (status.available && !status.building && !status.scheduled) return status;
      }
      assert.fail('runtime index was not rebuilt: ' + JSON.stringify(f.r.api.inspectVolatileMemoryGraphCorpus()));
    };
    await addMicro();
    // Background source-read preparation can finish the runtime index before
    // this first recall, especially while other test processes are running.
    assert.ok(['request_local_corpus','volatile_common_index'].includes(await recall()));
    await waitIndex();
    assert.equal(await recall(), 'volatile_common_index');
    await addMicro();
    // Recall immediately, before the delayed rebuild: this recall may be cold, but it
    // must not lose the rebuild.
    await recall();
    const rebuilt = await waitIndex();
    assert.ok(rebuilt.builds >= 2, JSON.stringify(rebuilt));
    assert.equal(await recall(), 'volatile_common_index', 'the rebuilt index survives the recall that arms its live boundary');
    assert.equal(f.r.api.inspectVolatileMemoryGraphCorpus().failures, 0);
  } finally { if (server) await server.cleanup(); else await f.r.cleanup(); }
});
