'use strict';
// A host output callback can schedule its worker immediately before unload disables the runtime.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const USER = 'I check the gauge and step back.';
const REPLY = 'The needle holds at the red mark and the spare valve hangs on the north wall hook.';
const FACT = 'needle holds at the red mark';
const QUERY = 'What did the gauge show, and where is the spare valve?';
const { syntheticFetch, configure, readyForRecall } = require('./helpers/unload_recall_contract_fixture.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 7000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const run = async mode => {
  let fixture = null;
  let fresh = null;
  try {
    fixture = await createFixture({ nativeFetch: syntheticFetch, arguments: { memory_suite_server_mode: 'plugin_only' } });
    const api = fixture.api;
    await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.registered && state.backend === 'chat_output_v3' ? state : null;
    }, 'registered official output listener');
    await configure(fixture, mode);
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
    await delay(50);
    fixture.currentChat.message = [
      { role: 'user', chatId: 'u1', data: USER },
      { role: 'assistant', chatId: 'a1', data: REPLY }
    ];
    fixture.currentChat.messages = fixture.currentChat.message;
    const pluginStorage = fixture.pluginStorage;
    const localStorage = fixture.host.safeLocalStorage;
    const chat = structuredClone(fixture.currentChat);
    const character = structuredClone(fixture.character);
    const baselineRuns = api.getCaptureBackendState().observedRuns;

    const dispatch = fixture.dispatchRisuChatEvent('output', {
      char: fixture.character, chat: fixture.currentChat, characterIndex: 0, chatIndex: 0, messageIndex: 1
    });
    assert.equal(api.getCaptureBackendState().observedRuns, baselineRuns + 1,
      'the official listener synchronously observes the host output event');
    // Begin unload before dispatchRisuChatEvent resumes from its await of the fire-and-forget handler.
    const unload = fixture.dispose();
    await Promise.all([dispatch, unload]);
    fixture = null;

    fresh = await createFixture({ nativeFetch: syntheticFetch, pluginStorage, safeLocalStorage: localStorage, chat, character,
      arguments: { memory_suite_server_mode: 'plugin_only' } });
    const freshApi = fresh.api;
    await configure(fresh, mode);
    const scope = await freshApi.resolveCurrentScope();
    const beforeColdStart = await freshApi._test.loadScopeRecords(scope.scopeKey);
    assert.equal(beforeColdStart.records.some(record => String(record.text || '').includes(FACT)), false,
      'the same-tick unload closed the worker queue before it persisted a memory record');
    await freshApi.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    const restored = await waitFor(async () => {
      const readback = await freshApi._test.loadScopeRecords(scope.scopeKey);
      return readback.records.some(record => String(record.text || '').includes(FACT)) ? readback : null;
    }, 'cold-start reconciliation of the live chat after output callback race');
    const recallProof = await readyForRecall(fresh, mode, FACT);
    const messages = await freshApi._selectionTest.beforeRequest([{ role: 'user', chatId: 'u8', content: QUERY }], 'model');
    assert.equal(JSON.stringify(messages ?? null).includes(FACT), mode === 'configured',
      'raw-only recovery stays unconfigured; configured recovery injects source-bound semantic evidence');
    process.stdout.write(JSON.stringify({
      test: 'flashback_chat_output_unload_microtask_recovery',
      listenerObserved: true,
      preColdStartCanonicalCount: beforeColdStart.records.length,
      recoveredCanonicalCount: restored.records.length,
      mode, recallProof, recoveredAndInjected: JSON.stringify(messages ?? null).includes(FACT)
    }) + '\n');
  } finally {
    await fixture?.dispose?.().catch(() => null);
    await fresh?.dispose?.().catch(() => null);
  }
};
(async () => { for (const mode of ['raw-only', 'configured']) await run(mode); })().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
