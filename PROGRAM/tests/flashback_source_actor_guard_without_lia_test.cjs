'use strict';
// Flashback's source-actor guard, measured with LIA out of the picture.
//
// The question this test answers: if the person using the plugin never brings LIA into play, does a
// different Persona ID still decide whether a session handoff is accepted or refused?
//
// `Flashback_Memory.js` authorizes a source with two alternative paths:
//   directActorMatches — the source manifest's personaId equals the target scope's personaId
//   forkActorMatches   — an authenticated RETRACE/LIA continuity pair. That set is a WeakSet, so a caller
//                        cannot fabricate the evidence: only the coordinator object is ever added to it.
// This test drives the FIRST path only. LIA is loaded and never invoked, and no continuity object is
// passed, so `forkActorMatches` is false by construction and `directActorMatches` is the only thing that
// can authorize the handoff.
//
// Both cases share one fixture: same character, same source chat, the same 8 real Flashback records
// written through the plugin's own `_test.saveAllRecords`, the same bridge marker, the same target chat.
// The ONLY difference is which Persona the target chat binds — A (the Persona the source was recorded
// under) or B. That isolates the Persona ID as the deciding variable instead of correlating with it.
//
// Measured (2026-09-22):
//   target persona B -> reason 'source_actor_mismatch',                        records 0  (refused)
//   target persona A -> reason 'session_archive_link_adopted_non_destructive', records 8  (accepted)
//
// Fixture rules learned the hard way, all of which silently produce the WRONG verdict when broken:
//   * The plugin is loaded with the REAL host surface (`risuai` global + plugin channels). A hand-rolled
//     `getItem`/`getDatabase` host never boots it ("RisuAI API is unavailable").
//   * Flashback scope keys are `char:<hash>|chat:<hash>`. Passing a HAYAKU `chat_<hash>` key makes the
//     guard answer 'expected_source_scope_mismatch'.
//   * Records need `text` AND an array `vector`; `saveScopeRecordsCore` filters on both, so a record
//     without a vector is dropped silently and the readback returns 0 — which turns a refused handoff
//     into an "empty" one and hides what is being measured.
//   * Hooks must be injected at the END of the plugin file. Inserting a helper above a later `const`
//     hits a TDZ error ("Cannot access 'x' before initialization").
//   * The bridge marker must carry schema 'memory-session-bridge-v1', `includeFlashback: true`, and
//     sourceChatId/targetChatId/transferId with targetChatId equal to the ACTIVE chat.
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROGRAM = path.resolve(__dirname, '..');
const FILES = ['Flashback_Memory.js', 'HAYAKU_Locator_Continuity.js', 'LIA_Persona_Linker.js', 'LIBRA.js', 'RETRACE.js'];

const store = () => {
  const values = new Map();
  return { values,
    async getItem(k) { return values.has(String(k)) ? values.get(String(k)) : null; },
    async setItem(k, v) { values.set(String(k), v); return true; },
    async removeItem(k) { values.delete(String(k)); return true; },
    async keys() { return [...values.keys()]; } };
};

// Only the private adoption entry needs a hook, plus a re-export of the plugin's own scope resolver (the
// owner writer path calls `resolveCurrentScope`; reimplementing it here would prove nothing about the
// product). Both replacements sit deep in the file, after every `const` they close over.
const EXPOSE = source => source.replace(
  'saveAllRecords, pendingThresholds: Object.freeze({',
  'saveAllRecords, probeResolveCurrentScope: (force = false) => resolveCurrentScope(force), pendingThresholds: Object.freeze({')
  .replace(
    "        } else if (action === 'adopt_session_handoff') {",
    `        } else if (action === '__probe_adopt') {
          const p = request.payload && typeof request.payload === 'object' ? request.payload : {};
          result = await adoptSessionHandoff({ ...p, __authenticatedLiaContinuity: null });
        } else if (action === 'adopt_session_handoff') {`);

const build = async ({ selectedPersonaIndex, targetChatBindedPersona }) => {
  const pluginStorage = store();
  const safeLocalStorage = store();
  const listeners = new Map();
  const personaA = { id: 'persona-A', name: 'Persona A' };
  const personaB = { id: 'persona-B', name: 'Persona B' };
  // TWO chats: the source the records were written under, and the handoff target.
  const sourceChat = { id: 'source-chat', chatId: 'source-chat', name: 'Source', message: [], messages: [], bindedPersona: '' };
  const targetChat = {
    id: 'target-chat', chatId: 'target-chat', name: 'Target', message: [], messages: [],
    bindedPersona: targetChatBindedPersona,
  };
  const character = {
    chaId: 'persona-guard-char', id: 'persona-guard-char', name: 'Guard Char',
    chats: [sourceChat, targetChat], chatPage: 0, firstMessage: '', description: '', personality: '',
  };
  const host = {
    pluginStorage, safeLocalStorage, listeners, unloadHandlers: [],
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(n) { const k = String(n); if (k.includes('memory_suite_server_mode')) return 'plugin_only'; if (k.includes('enable_gui')) return 'false'; return ''; },
    async getArg(n) { return await host.getArgument(n); }, async setArgument() { return true; },
    async nativeFetch() { throw new Error('offline'); }, async runLLMModel() { return { text: '', usage: {} }; },
    async addPluginChannelListener(c, h) { const k = String(c); const r = listeners.get(k) || new Set(); r.add(h); listeners.set(k, r); return { channel: k, handler: h }; },
    async removePluginChannelListener(c, h) { const r = listeners.get(String(c)); if (r) r.delete(h); return true; },
    async removePluginChannelHandler() { return true; }, async offPluginChannelMessage() { return true; },
    async postPluginChannelMessage(t, c, m) {
      const k = String(c);
      const map = { flashback_memory_bridge_response_v1: 'flashback_memory', hayaku_memory_bridge_response_v1: 'hayaku_locator_continuity', lia_persona_handoff_response_v1: 'lia_persona_linker', libra_memory_bridge_response_v1: 'libra' };
      const sender = map[k] || 'flashback_hayaku_bridge';
      for (const h of Array.from(listeners.get(k) || [])) { try { await h(m, { sender }); } catch (_) {} }
      return true;
    },
    async onUnload(h) { host.unloadHandlers.push(h); return true; },
    async registerSetting() { return true; }, async registerButton() { return true; },
    async unregisterSetting() { return true; }, async unregisterButton() { return true; },
    async addRisuReplacer() { return true; }, async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; }, async removeRisuScriptHandler() { return true; },
    async addRisuChatListener() { return true; }, async removeRisuChatListener() { return true; },
    async getDatabase(f) {
      const all = { personas: [personaA, personaB], selectedPersona: selectedPersonaIndex, characters: [character], plugins: [] };
      return Array.isArray(f) ? Object.fromEntries(f.map(x => [x, all[x] ?? null])) : all;
    },
    async setDatabase() { return true; },
    async getCurrentCharacterIndex() { return 0; },
    // The ACTIVE chat is the source while records are written, then the target for the handoff.
    async getCurrentChatIndex() { return Number(character.chatPage) || 0; },
    async getCharacter() { return character; }, async getCharacterFromIndex() { return character; },
    async getChat() { return character.chats[Number(character.chatPage) || 0]; },
    async getCurrentChat() { return character.chats[Number(character.chatPage) || 0]; },
    async getChatFromIndex(i) { return character.chats[Number(i)] || character.chats[0]; },
    async setCharacterToIndex(i, p) { if (p && Array.isArray(p.chats)) { host.character = p; } return true; },
    async setCharacter(p) { if (p && Array.isArray(p.chats)) { host.character = p; } return true; },
    async getRootContainer() { return null; }, async getPluginRoot() { return null; },
    async showContainer() { return true; }, async hideContainer() { return true; },
  };
  const context = vm.createContext({
    risuai: host, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    AbortController, AbortSignal, DOMException, URL, URLSearchParams, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, structuredClone: globalThis.structuredClone, performance: globalThis.performance,
    fetch: globalThis.fetch, Headers, Request, Response, FormData, Blob, atob, btoa,
    confirm: () => true, alert: () => {}, prompt: () => null,
  });
  for (const file of FILES) {
    let src = fs.readFileSync(path.join(PROGRAM, 'plugins', file), 'utf8');
    if (file === 'Flashback_Memory.js') src = EXPOSE(src);
    vm.runInContext(src, context, { filename: file });
  }
  return { context, host, character, sourceChat, targetChat, pluginStorage };
};

const wait = async (fn, label, ms = 25000) => {
  const started = Date.now();
  while (Date.now() - started < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
  throw new Error(`timeout ${label}`);
};

// The bridge marker Flashback requires before it will consider a handoff at all. The accepted schema set
// is `MEMORY_SESSION_BRIDGE_ACCEPTED_SCHEMAS` = {'memory-session-bridge-v1', '-v2'}.
const bridgeMarker = (targetChatId, transferId, sourceScopeKey, recordCount) => ({
  schema: 'memory-session-bridge-v1',
  includeFlashback: true,
  includeHayaku: false,
  includeLibra: false,
  includeLiaLivePersona: false,
  sourceChatId: 'source-chat',
  targetChatId,
  transferId,
  sourceFlashbackScopeKey: sourceScopeKey,
  flashbackRecordCount: recordCount,
  targetStorageMode: 'plugin_only',
  targetStoragePolicy: { participants: [{ owner: 'flashback', mode: 'plugin_only' }] },
});

(async () => {
  const built = await build({ selectedPersonaIndex: 0, targetChatBindedPersona: '' });
  const flashback = await wait(() => built.context.__FlashbackMemory, 'FlashbackMemory');
  const testApi = flashback._test;
  assert.ok(testApi && typeof testApi.saveAllRecords === 'function', 'Flashback exposes its _test writer');
  assert.ok(typeof testApi.probeResolveCurrentScope === 'function', 'the plugin scope resolver was re-exported');

  // ── write the source records while persona A is the global selection ─────────────────────────────
  built.character.chatPage = 0;
  const sourceScope = await testApi.probeResolveCurrentScope(false);
  const sourceScopeKey = String(sourceScope.scopeKey || '');
  assert.match(sourceScopeKey, /^char:.*\|chat:/, 'Flashback keys its scopes as char:<hash>|chat:<hash>');

  // `saveScopeRecordsCore` filters on `record.text && Array.isArray(record.vector)`; a record without a
  // vector is dropped silently and the readback returns 0.
  const records = Array.from({ length: 8 }, (_, index) => ({
    id: `persona-guard-${index + 1}`, hash: `persona-guard-${index + 1}`,
    type: 'response', sourceType: 'response',
    text: `Guard fixture memory ${index + 1} about the pressure gauge and the red mark.`,
    dim: 4, vector: [1, 0, 0, 0],
    turnIndex: index + 1, sourceTurn: index + 1, lifecycleStatus: 'active',
  }));
  await testApi.saveAllRecords(records, null, sourceScope);
  const readback = await testApi.loadScopeRecords(sourceScopeKey);
  assert.strictEqual(readback.records.length, 8, 'the 8 records are durable under the source scope');
  assert.strictEqual(String(readback.manifest?.personaId || ''), 'persona-A',
    'the source manifest records the persona the chat was written under');

  const targetChatId = 'target-chat';
  const transferId = 'guard-fixture-transfer';
  built.targetChat.memorySessionBridge = bridgeMarker(targetChatId, transferId, sourceScopeKey, 8);

  const responses = [];
  const origPost = built.host.postPluginChannelMessage;
  built.host.postPluginChannelMessage = async (type, channel, message) => {
    if (String(channel) === 'flashback_memory_bridge_response_v1') {
      responses.push({ ok: true, result: message?.result ?? message });
      return true;
    }
    return origPost(type, channel, message);
  };

  let personaGuardReceipt = null;
  const adopt = async (label) => {
    responses.length = 0;
    await origPost('flashback_memory', 'flashback_memory_bridge_request_v1', {
      schema: 'flashback-memory-bridge-ipc-v1', kind: 'request', requestId: label,
      action: '__probe_adopt',
      payload: { targetChatId, transferId, sourceScopeKey, expectedRecords: 8 },
    });
    for (let i = 0; i < 60 && responses.length === 0; i += 1) await new Promise(r => setTimeout(r, 50));
    const answer = responses[responses.length - 1];
    if (String(answer?.result?.reason || '') === 'source_actor_mismatch') personaGuardReceipt = answer.result;
    return answer;
  };

  // ── CASE 1: the deciding variable set to "different Persona" ─────────────────────────────────────
  built.character.chatPage = 1;
  built.targetChat.bindedPersona = 'persona-B';
  const different = await adopt('probe-different-persona');
  const differentReason = String(different?.result?.reason || '');
  assert.strictEqual(differentReason, 'source_actor_mismatch',
    `a different Persona with no LIA continuity must be refused (got '${differentReason}')`);
  // NOT `result.records`: the plugin reports `records: sourceRecordCount` in some refusal receipts (the
  // later actor check at ~22583 returns `records: sourceRecordCount`), so that field describes the SOURCE
  // and is non-zero even when nothing was copied. Asserting on it makes the test fail for the wrong reason
  // and hides what is being measured. The product-level property is the TARGET scope's own contents:
  // after a refusal it must hold nothing.
  const targetScopeAfterRefusal = testApi.resolveScopeFromSnapshot(
    { character: built.character, chat: built.targetChat, db: await built.host.getDatabase() });
  const targetAfterRefusal = await testApi.loadScopeRecords(targetScopeAfterRefusal.scopeKey);
  assert.strictEqual(targetAfterRefusal.records.length, 0,
    'a refused handoff left no records in the target scope');

  // ── CASE 2: only change is the Persona — back to the one the source was recorded under ───────────
  built.targetChat.bindedPersona = 'persona-A';
  const same = await adopt('probe-same-persona');
  const sameReason = String(same?.result?.reason || '');
  assert.notStrictEqual(sameReason, 'source_actor_mismatch', 'the same Persona must not hit the actor guard');
  assert.strictEqual(same?.ok, true, 'the same-Persona handoff is accepted');
  assert.strictEqual(same?.result?.verified, true, 'the same-Persona handoff verifies');
  const targetAfterAccept = await testApi.loadScopeRecords(targetScopeAfterRefusal.scopeKey);
  assert.strictEqual(Number(same?.result?.records || 0), 8,
    'the accepted receipt reports the copied record count');
  assert.strictEqual(targetAfterAccept.records.length, 8,
    'the accepted handoff put all 8 records in the target scope');

  // ── the refusal must be attributable to the persona comparison, not to some other check ───────────
  assert.ok(personaGuardReceipt, 'the source_actor_mismatch receipt was captured from the product itself');

  const summary = {
    test: 'flashback_source_actor_guard_without_lia_test',
    differentPersonaReason: differentReason,
    samePersonaReason: sameReason,
    personaIsTheDecidingVariable: differentReason === 'source_actor_mismatch' && sameReason !== 'source_actor_mismatch',
    sourceScopeKey,
    records: { written: 8, readBackFromSource: readback.records.length },
    // The receipt's `records` field is deliberately not used as evidence — see the comment at CASE 1.
    targetScope: {
      scopeKey: String(targetScopeAfterRefusal.scopeKey || ''),
      recordsAfterRefusal: targetAfterRefusal.records.length,
      recordsAfterAccept: targetAfterAccept.records.length,
    },
  };
  const outFile = process.env.PERSONA_GUARD_TEST_OUT || '';
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, personaGuardReceipt }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  console.log('flashback_source_actor_guard_without_lia: PASS');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
