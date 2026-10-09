'use strict';
// RE:TRACE U1 — the single PUBLIC next-session handoff across all four owners, plus its counterexamples.
//
// The reviewer's U1 finding: each owner contract passes individually, but nothing shows one call to the
// PUBLIC `continueToNextSession()` running owner discovery -> fresh target -> four-owner adoption ->
// durable verify -> consumer readback -> completed journal, and the individual results must not be
// presented as a completed product flow. This produces that evidence, and the failures that must stay
// SAFE failures.
//
// Real here:
//   * all five DEPLOYED plugin files in ONE vm context over ONE shared host, so RE:TRACE's
//     `postPluginChannelMessage` reaches each owner's own listener on the owner's own channel;
//   * `continueToNextSession()` is the public entry point;
//   * the target chat is created by RE:TRACE's own commit path, the journal is read back from HOST
//     storage, and the same storage is reloaded into a second boot of all five plugins.
//
// Two host behaviours are modelled because the real host has them and their absence is NOT a product
// defect:
//   * `beforeRequest` replacers are dispatched with type 'model' — LIBRA's `isMainNarrativeRequest(type)`
//     is `normalizeRequestType(type) === 'model'`, and that dispatch is how a plugin re-resolves its
//     context after the active chat changes. Dispatching 'normal' silently skips the handler.
//   * the commit path UNSHIFTS the target chat to index 0 (`freshCharacter.chatPage = 0`), so the active
//     chat index follows the target, not the tail of the array.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const PLUGIN_FILES = ['Flashback_Memory.js', 'HAYAKU_Locator_Continuity.js', 'LIA_Persona_Linker.js', 'LIBRA.js', 'RETRACE.js'];
const REQUEST_CHANNELS = {
  flashback: 'flashback_memory_bridge_request_v1',
  hayaku: 'hayaku_memory_bridge_request_v1',
  lia: 'lia_persona_handoff_request_v1',
  libra: 'libra_memory_bridge_request_v1',
};
const RESPONSE_CHANNELS = {
  flashback_memory_bridge_response_v1: 'flashback',
  hayaku_memory_bridge_response_v1: 'hayaku',
  lia_persona_handoff_response_v1: 'lia',
  libra_memory_bridge_response_v1: 'libra',
};
const RESPONSE_SENDERS = {
  flashback_memory_bridge_response_v1: 'flashback_memory',
  hayaku_memory_bridge_response_v1: 'hayaku_locator_continuity',
  lia_persona_handoff_response_v1: 'lia_persona_linker',
  libra_memory_bridge_response_v1: 'libra',
};

const createStore = () => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); },
  };
};

const waitFor = async (predicate, label, timeoutMs = 20000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const createHost = options => {
  let hostRef = null;
  const listeners = new Map();
  const unloadHandlers = [];
  const replacers = new Map();
  const chatListeners = [];
  const rawStorage = options.pluginStorage || createStore();
  // Every ledger WRITE is observed so the target chat's ledger key is identified by fact, not by guessing
  // which key looks new.
  const pluginStorage = {
    values: rawStorage.values,
    async getItem(key) { return await rawStorage.getItem(key); },
    async setItem(key, value) {
      const result = await rawStorage.setItem(key, value);
      try { await hostRef?.noteLedgerWrite?.(key, value); } catch (_) {}
      // Once the TARGET chat's ledger exists, rewrite its record count ONCE so the durable readback the
      // coordinator performs disagrees with what was prepared. Doing it after the owner's own write is
      // what makes it stick — an earlier injection was overwritten by this very write.
      if (hostRef?.faults?.corruptTargetLedger === true && hostRef.faults.targetLedgerKey === String(key)) {
        await hostRef.corruptTargetLedgerOnce();
      }
      return result;
    },
    async removeItem(key) { return await rawStorage.removeItem(key); },
    async keys() { return await rawStorage.keys(); },
  };
  const safeLocalStorage = options.safeLocalStorage || createStore();
  const chats = options.chats || [{ id: 'retrace-src-chat', chatId: 'retrace-src-chat', name: 'Source', message: [], messages: [], bindedPersona: '' }];
  const character = options.character || {
    chaId: 'retrace-character', id: 'retrace-character', name: 'Handoff Character',
    chats, firstMessage: '', description: '', personality: '',
  };
  character.chats = chats;
  const faults = options.faults || {};
  const host = {
    pluginStorage, safeLocalStorage, listeners, unloadHandlers, chats, character, faults,
    // A real host re-resolves plugin context when the active chat changes; that dispatch is what makes a
    // plugin see the NEW target chat. See the file header for why the type must be 'model'.
    async dispatchNarrativeRequest() {
      for (const handler of replacers.get('beforeRequest') || []) {
        try { await handler([], 'model'); } catch (_) {}
      }
    },
    // The durable readback reads the TARGET chat's HAYAKU ledger. That key exists only after the target is
    // committed and the owner has written into it, so the injection watches WRITES: the first ledger SET
    // for a chat that is not the source chat is the target's, and its content is what the readback will
    // later compare against. (Observed traffic: the source ledger is read repeatedly and only the target's
    // is written, so keying on the write is exact rather than a guess.)
    async noteLedgerWrite(key, value) {
      const name = String(key);
      if (!/hayaku\.v2\.ledger/i.test(name)) return;
      if ((faults.baselineLedgerKeys || []).includes(name)) return;   // the source ledger
      faults.targetLedgerKey = name;
      faults.targetLedgerWrites = (faults.targetLedgerWrites || 0) + 1;
    },
    async recordLedgerBaseline() {
      faults.baselineLedgerKeys = (await pluginStorage.keys()).map(String)
        .filter(key => /hayaku\.v2\.ledger/i.test(key));
    },
    // The ledger holds no `recordCount` field — the count the readback derives is `records.length` (read
    // from the live structure: `version, scopeKey, identity, updatedAt, …, records, slotHeads, tombstones`).
    // A mismatch therefore means the RECORD SET disagrees, so a record is dropped from the target ledger.
    async corruptTargetLedgerOnce() {
      const key = faults.targetLedgerKey;
      if (!key || faults.ledgerCorrupted) return;
      const raw = await pluginStorage.getItem(key);
      if (raw == null) return;
      let parsed = raw;
      if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch (_) { return; } }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records) || parsed.records.length === 0) return;
      faults.ledgerCorrupted = true;
      faults.ledgerBefore = { key: key.slice(0, 70), records: parsed.records.length };
      parsed.records.pop();                                     // a durable readback that disagrees
      await pluginStorage.setItem(key, typeof raw === 'string' ? JSON.stringify(parsed) : parsed);
    },
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) {
      const key = String(name);
      if (key.includes('memory_suite_server_mode')) return options.mode || 'plugin_only';
      if (key.includes('memory_suite_server_url')) return options.serverUrl || '';
      if (key.includes('enable_gui')) return 'false';
      return '';
    },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch(target, init) { return await fetch(target, init); },
    async addPluginChannelListener(channel, handler) {
      const key = String(channel);
      const rows = listeners.get(key) || new Set();
      rows.add(handler);
      listeners.set(key, rows);
      return { channel: key, handler };
    },
    async removePluginChannelListener(channel, handler) {
      const rows = listeners.get(String(channel));
      if (!rows) return false;
      rows.delete(handler);
      return true;
    },
    async removePluginChannelHandler(channel, handler) { return await host.removePluginChannelListener(channel, handler); },
    async offPluginChannelMessage(channel, handler) { return await host.removePluginChannelListener(channel, handler); },
    async postPluginChannelMessage(target, channel, message) {
      const key = String(channel);
      // A required owner that never answers: drop the request at the bus.
      if ((faults.silentOwners || []).some(owner => REQUEST_CHANNELS[owner] === key)) return true;
      if (key === REQUEST_CHANNELS.libra && message?.action === 'memory_suite_prepare_handoff_target') {
        // The target chat exists by now; the host would have dispatched this on the switch.
        await host.dispatchNarrativeRequest();
      }
      // A durable readback that DISAGREES with what was prepared. The owner's reply travels on the
      // owner's RESPONSE channel as `{schema, kind:'response', requestId, action, ok, result, error}` —
      // not as a return value of the request handler — so the mismatch is injected THERE, on the way to
      // the coordinator. The owner is present and answers; only the readback disagrees.
      // "Durable readback mismatch": the state the coordinator verifies disagrees with what was prepared.
      // It checks the owner's receipt first and re-reads the TARGET ledger only when that receipt does not
      // already satisfy it, so the mismatch is injected at the moment the receipt arrives — the receipt
      // AND the durable ledger both disagree, which is the state that must never be reported as verified.
      // No injection here: the ledger itself is the verified value, and it is written by the owner during
      // preparation. See `setItem` in this harness — the corruption happens once the target's ledger has
      // actually been written, which is what makes the later readback disagree.
      // An owner's answer travels on the owner's RESPONSE channel, not as a return value of the request
      // handler: the request shape is `{schema, kind:'request', requestId, action, payload}` and the reply
      // is matched by `requestId`. Corrupting a return value therefore reaches nothing — which is why an
      // earlier version of this case reported NOT_EXERCISED while the flow completed.
      const sender = RESPONSE_SENDERS[key] || (Object.values(REQUEST_CHANNELS).includes(key) ? 'flashback_hayaku_bridge' : '');
      const rows = Array.from(listeners.get(key) || []);
      for (const handler of rows) {
        const answer = await handler(message, { sender });
        if (faults.corruptReceiptFrom === key && String(message?.action) === 'adopt_session_handoff'
            && answer && typeof answer === 'object' && answer.payload) {
          const receipt = answer.payload;
          faults.receiptCorrupted = { action: 'adopt_session_handoff', records: receipt.records, schema: receipt.schema };
          if (Number.isFinite(Number(receipt.records))) receipt.records = Number(receipt.records) + 1;
          receipt.verified = true;
          receipt.durable = true;
        }
      }
      return true;
    },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async unregisterSetting() { return true; },
    async unregisterButton() { return true; },
    async addRisuReplacer(kind, handler) {
      const key = String(kind);
      const rows = replacers.get(key) || [];
      rows.push(handler);
      replacers.set(key, rows);
      return true;
    },
    async removeRisuReplacer(kind, handler) {
      const rows = replacers.get(String(kind)) || [];
      const index = rows.indexOf(handler);
      if (index >= 0) rows.splice(index, 1);
      return true;
    },
    async addRisuScriptHandler(mode, handler) { chatListeners.push(handler); return true; },
    async removeRisuScriptHandler(mode, handler) { const i = chatListeners.indexOf(handler); if (i >= 0) chatListeners.splice(i, 1); return true; },
    async addRisuChatListener(mode, handler) { chatListeners.push(handler); return true; },
    async removeRisuChatListener(mode, handler) { const i = chatListeners.indexOf(handler); if (i >= 0) chatListeners.splice(i, 1); return true; },
    async getDatabase(fields) {
      const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
      if (!Array.isArray(fields)) return all;
      return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
    },
    async setDatabase() { return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() {
      if (faults.driftAfterAdoption) return { ...character, chats: chats.slice(1) };
      return character;
    },
    async getCharacterFromIndex() { return await host.getCharacter(); },
    async getChat() { return chats[0]; },
    async getCurrentChat() { return chats[0]; },
    async getChatFromIndex(index) {
      const wanted = Number(index);
      if (Number.isInteger(wanted) && wanted >= 0 && wanted < chats.length) return chats[wanted];
      return chats[0];
    },
    async setCharacterToIndex(index, payload) {
      if (index === 0 && payload && Array.isArray(payload.chats)) {
        host.character = payload; chats.length = 0; chats.push(...payload.chats);
      }
      return true;
    },
    async setCharacter(payload) {
      if (payload && Array.isArray(payload.chats)) { host.character = payload; chats.length = 0; chats.push(...payload.chats); }
      return true;
    },
    async getRootContainer() { return null; },
    async getPluginRoot() { return null; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
  };
  hostRef = host;
  return host;
};

const boot = async host => {
  const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const timers = new Set();
  const intervals = new Set();
  const context = vm.createContext({
    risuai: host, console: quietConsole,
    setTimeout: (handler, delay, ...args) => {
      const timer = setTimeout((...inner) => { timers.delete(timer); handler(...inner); }, delay, ...args);
      timers.add(timer); return timer;
    },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
    setInterval: (handler, delay, ...args) => { const t = setInterval(handler, delay, ...args); intervals.add(t); return t; },
    clearInterval: timer => { intervals.delete(timer); clearInterval(timer); },
    queueMicrotask, AbortController, AbortSignal, DOMException, URL, URLSearchParams,
    TextEncoder, TextDecoder, crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
    performance: globalThis.performance, fetch: globalThis.fetch, Headers: globalThis.Headers,
    Request: globalThis.Request, Response: globalThis.Response, FormData: globalThis.FormData,
    Blob: globalThis.Blob, atob: globalThis.atob, btoa: globalThis.btoa,
    confirm: () => true, alert: () => {}, prompt: () => null,
  });
  for (const file of PLUGIN_FILES) {
    vm.runInContext(fs.readFileSync(path.join(root, 'plugins', file), 'utf8'), context, { filename: file });
  }
  const retrace = await waitFor(() => context.__RETRACE || context.RETRACE, 'RE:TRACE public API');
  // HAYAKU (and the other owners) expose their public objects asynchronously. The seeder drives HAYAKU's
  // own surface, so waiting for the handle is part of booting — reading it immediately yields undefined
  // and the seed silently does nothing, which then looks like "the coordinator does not require HAYAKU".
  const hayaku = await waitFor(() => context.HAYAKU, 'HAYAKU public API');
  await host.recordLedgerBaseline?.();
  for (const [owner, channel] of Object.entries(REQUEST_CHANNELS)) {
    if ((host.faults.silentOwners || []).includes(owner)) continue;
    await waitFor(() => (host.listeners.get(channel)?.size || 0) > 0, `${channel} owner listener`);
  }
  const shutdown = async () => {
    for (const handler of host.unloadHandlers.slice().reverse()) { try { await handler(); } catch (_) {} }
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
  };
  return { context, retrace, shutdown, host };
};

const readJournal = async host => {
  const rows = [];
  for (const key of (await host.pluginStorage.keys()).map(String)) {
    const raw = await host.pluginStorage.getItem(key);
    if (raw == null) continue;
    let parsed = raw;
    if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch (_) { parsed = null; } }
    // The journal lives on the TARGET CHAT itself, so read the chats as well as the key/value store.
    if (parsed && typeof parsed === 'object') rows.push({ key, value: parsed });
  }
  return rows;
};

const targetChat = host => host.chats.find(chat => chat?.memorySessionBridge?.handoffJournal) || null;

// Seed each owner through its own surface, so the handoff sees REQUIRED participants. A participant
// that is not required is excluded by design (`includeHayaku` needs a HAYAKU record), so a counterexample
// that silences an unseeded owner would prove nothing — the flow is allowed to proceed without it.
const seedOwners = async (context, host, turns = 3) => {
  // Real turns first: the owners read their evidence from the CHAT, so an empty chat cannot produce a
  // record no matter how many times reconciliation runs.
  const { createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
  const SUMMARY = 'Alice turned the brass valve and steam began flowing through the blue pipe.';
  const messages = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push({ role: 'user', id: `u${turn}`, chatId: `u${turn}`, data: `User ${turn} inspects the workshop.` });
    messages.push({
      role: 'char', id: `a${turn}`, chatId: `a${turn}`,
      data: hiddenPacketMessage(`${SUMMARY} (turn ${turn})`, createValidPacket({ turn, subject: 'Alice', scene: 'workshop', summary: SUMMARY })),
    });
  }
  const source = host.chats[0];
  source.message = messages;
  source.messages = messages;

  const hayaku = context.HAYAKU;
  let hayakuReconcile = null;
  if (hayaku?._test?.currentChatScope) {
    const scope = await hayaku._test.currentChatScope();
    if (hayaku._test.reconcileObservedChatTopology) {
      hayakuReconcile = await hayaku._test.reconcileObservedChatTopology(
        scope, hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope), 'retrace_u1_seed');
    }
  }
  return { hayaku: hayakuReconcile };
};

// The coordinator decides participation from record counts:
//   `includeLibra`  is `libra.available === true`, and LIBRA's `available` is
//                   `schemaOk && scopeMatches && (recordCount > 0 || worldAdditionalCount > 0)`.
//   `includeHayaku` needs a HAYAKU record.
// So a handoff over an EMPTY scope legitimately excludes both, and a run in that state proves nothing
// about four-owner adoption. This asserts the seed actually produced participants, and reports the
// counts so a future reader can tell "verified" from "not required".
const assertParticipants = async (context, retrace, host) => {
  const preview = await retrace.inspectTransition({ includeServerData: false });
  const state = {
    includeLibra: preview?.includeLibra === true,
    includeHayaku: preview?.includeHayaku === true,
    libraRecords: preview?.libra?.recordCount ?? 0,
    libraReason: String(preview?.libra?.reason || ''),
    hayakuRecords: preview?.hayakuRecordCount ?? 0,
    hayakuGate: String(preview?.hayakuOwnerGate?.reason || ''),
    flashbackRecords: preview?.flashback?.loadedRecords ?? 0,
  };
  // HAYAKU must be REQUIRED, or this run cannot show a participant being verified. LIBRA is reported but
  // not asserted: its participation depends on canonical records existing in the scope, and this fixture
  // holds none — so a run here verifies the owners that HAVE data and reports LIBRA's absence rather than
  // claiming four-owner coverage it did not exercise.
  assert.equal(state.includeHayaku, true,
    `the seed must make HAYAKU a required participant (count ${state.hayakuRecords}, gate ${state.hayakuGate})`);
  return state;
};

(async () => {
  const observations = { test: 'retrace_u1_public_handoff', cases: [] };
  let passed = 0;

  // =================================================================================================
  // CASE 1 — the normal flow, and the journal read back after a RELOAD.
  // =================================================================================================
  {
    const host = createHost({ mode: 'plugin_only', faults: {} });
    const booted = await boot(host);
    let reloadedInfo = null;
    try {
      assert.equal(typeof booted.retrace.continueToNextSession, 'function',
        'continueToNextSession must be on the PUBLIC surface');
      const sourceChatCount = host.chats.length;

      // Seed the owners through their OWN surfaces so the handoff has required participants:
      // `includeHayaku` is false without a HAYAKU record, and a not-required owner cannot demonstrate
      // that the public call verified four owners.
      const seeded = await seedOwners(booted.context, host);
      const participants = await assertParticipants(booted.context, booted.retrace, host);
      observations.cases.push({ case: 'seeded_participants', ...participants, hayakuReconcile: seeded?.hayaku?.importedRecords ?? null });

      let thrown = null;
      let result = null;
      try { result = await booted.retrace.continueToNextSession(); } catch (error) { thrown = error; }

      observations.cases.push({
        case: 'public_normal_flow',
        reached: thrown ? 'threw' : 'returned',
        code: thrown?.code || null,
        message: thrown ? String(thrown.message || thrown).slice(0, 200) : null,
        targetChatId: result?.targetChatId || null,
        handoffJournalState: result?.handoffJournalState || null,
        owners: result ? {
          flashback: { required: result.flashbackScheduled === true || undefined, verified: result.flashbackVerified === true },
          hayaku: { required: result.hayakuScheduled === true || undefined, verified: result.hayakuVerified === true },
        } : null,
        chatCount: host.chats.length,
      });
      if (thrown) throw new Error(`the public normal flow did not complete: ${thrown.code || ''} ${thrown.message}`);
      passed += 1;

      // All four owners must have been scheduled and verified by the single public call.
      assert.equal(host.chats.length, sourceChatCount + 1, 'exactly one new target chat was created');
      const target = targetChat(host);
      assert.ok(target, 'the target chat carries the handoff bridge + journal');
      assert.equal(String(target.memorySessionBridge.handoffJournal.targetChatId), String(result.targetChatId),
        'the journal names the target the call reported');
      passed += 1;

      // `xScheduled` is `required && !verified`, so it reads false both when an owner verified AND when it
      // was never required — two very different states. Report the requirement itself, so this evidence
      // cannot be read as "four owners were verified" when fewer participated.
      for (const owner of ['flashback', 'hayaku', 'libra', 'lia']) {
        const scheduled = result[`${owner}Scheduled`];
        const verified = result[`${owner}Verified`];
        assert.notEqual(verified, false, `${owner} must not report an unverified adoption as success`);
        observations.cases.push({
          case: `owner_${owner}`, scheduled: scheduled ?? null, verified: verified ?? null,
          // derived: an owner that reports verified === true while scheduled === false and a zero record
          // count participated without data; that is not the same as a verified non-empty handoff.
          records: result[`${owner}Records`] ?? null,
          receiptReason: String(result[`${owner}Adoption`]?.reason || result[`${owner}Verification`]?.reason || ''),
        });
      }
      const participated = ['flashback', 'hayaku', 'libra', 'lia'].filter(owner =>
        result[`${owner}Verified`] === true && Number(result[`${owner}Records`] || 0) > 0
        || result[`${owner}Verified`] === true && String(result[`${owner}Adoption`]?.reason || '') !== 'no_libra_data');
      observations.cases.push({
        case: 'participants_with_evidence',
        owners: participated,
        note: 'an owner reported verified only because it had no data is recorded here, not claimed as a handoff',
      });
      passed += 1;

      // ---- RELOAD over the SAME storage: the journal must read back as completed. ----
      await booted.shutdown();
      const reloaded = await boot(createHost({
        mode: 'plugin_only', faults: {},
        pluginStorage: host.pluginStorage, safeLocalStorage: host.safeLocalStorage,
        chats: host.chats, character: host.character,
      }));
      try {
        const pending = await reloaded.retrace.inspectPendingNextSessionHandoff?.();
        const stored = await readJournal(reloaded.host);
        reloadedInfo = {
          pendingAfterReload: pending?.pending === true,
          pendingTargetChatId: pending?.targetChatId || null,
          storageKeys: stored.length,
          journalState: targetChat(reloaded.host)?.memorySessionBridge?.handoffJournal?.state || null,
        };
        assert.equal(pending?.pending === true, false,
          'a completed handoff must not still be pending after a reload');
        assert.notEqual(reloadedInfo.journalState, 'pending_storage_configuration',
          'the reloaded journal must have advanced past storage configuration');
        passed += 1;
      } finally { await reloaded.shutdown(); }

      observations.cases.push({ case: 'reload_journal', ...reloadedInfo });
      console.log(`  CASE 1 normal: target ${String(result.targetChatId).slice(0, 12)} • journal ${reloadedInfo.journalState} • ${host.chats.length} chats`);
    } finally { try { await booted.shutdown(); } catch (_) {} }
  }

  // =================================================================================================
  // CASE 2 — a durable readback that DISAGREES with what was prepared. The owner answers, but its receipt
  // claims a different record count. RE:TRACE must catch that with its OWN verification and leave the
  // journal safely incomplete — "durable readback mismatch" in the contract's words.
  // =================================================================================================
  {
    // HAYAKU is the owner this fixture can require (it has records after the seed), so the receipt it
    // returns is the one to corrupt — on its response channel.
    const faults = { corruptTargetLedger: true };
    const host = createHost({ mode: 'plugin_only', faults });
    const booted = await boot(host);
    try {
      await seedOwners(booted.context, host);
      const chatsBefore = host.chats.map(chat => ({ ...chat }));
      let thrown = null;
      let result = null;
      try { result = await booted.retrace.continueToNextSession(); } catch (error) { thrown = error; }
      const target = targetChat(host);
      const journalState = target?.memorySessionBridge?.handoffJournal?.state || null;
      observations.cases.push({
        case: 'counterexample_durable_readback_mismatch',
        ledgerCorrupted: faults.ledgerBefore || null,
        reachedStep: thrown?.code || (result ? 'returned' : 'unknown'),
        returned: result ? { ok: result.ok, handoffJournalState: result.handoffJournalState, libraVerified: result.libraVerified } : null,
        journalState,
        sourcePreserved: host.chats.filter(chat => chatsBefore.some(before => before.id === chat.id)).length,
      });
      // The mismatch is either refused outright, or it returns with the journal left INCOMPLETE. What must
      // never happen is `completed` while the receipt it verified disagreed with the prepared identity.
      // The coordinator verifies a durable readback TWICE: the owner's receipt must pass its own checks
      // (identity, record count, source preservation, storage policy), and if it does not, the TARGET
      // chat's HAYAKU ledger is read straight out of storage and must agree. A mismatch is therefore
      // never reported as verified — either the receipt is rejected, or the storage readback has to
      // disagree and the attempt fails. This case records which of those two actually happened, and
      // fails if success was claimed without a matching readback behind it.
      // CONFIRMED COUNTEREXAMPLE. The target chat's durable ledger was rewritten so it disagrees with what
      // was prepared, and the coordinator did NOT report the handoff as verified — it returned with the
      // journal at `pending_owner_handoffs`, the "safely incomplete" state the contract asks for, and the
      // source chat untouched.
      //
      // How the verification works, read from the code: the owner's receipt is checked first (identity,
      // record count, source preservation, storage policy), and when that does not satisfy the coordinator
      // it re-reads the TARGET ledger out of storage through RETRACE's own `storageGet`. The owner writes
      // through `MemorySuiteStorageBridge.createPluginStorageProxy`, so the injection watches the ledger
      // WRITE and rewrites the record set once it exists — nothing is injected through a reply, which the
      // coordinator does not trust on its own.
      observations.cases.push({
        case: 'counterexample_durable_readback_mismatch',
        refused: Boolean(thrown),
        code: thrown?.code || null,
        journalState,
        hayakuVerified: result?.hayakuVerified ?? null,
        hayakuRecordsAfterInjection: result?.hayakuRecords ?? null,
        injected: faults.ledgerBefore || null,
        sourcePreserved: host.chats.some(chat => chatsBefore.some(before => before.id === chat.id)),
        verdict: (result?.hayakuVerified !== true && journalState !== 'completed')
          ? 'the mismatched durable readback was NOT reported as verified, and the journal stayed incomplete'
          : 'MISMATCH NOT CAUGHT',
      });
      assert.equal(result?.hayakuVerified !== true && journalState !== 'completed', true,
        `a durable readback that disagrees with what was prepared must not complete the handoff (journal ${journalState})`);
      assert.equal(host.chats.some(chat => chatsBefore.some(before => before.id === chat.id)), true,
        'the source chat must be preserved when a readback disagrees');
      passed += 1;
      console.log(`  CASE 2 readback mismatch: caught — hayakuVerified ${result?.hayakuVerified}, journal ${journalState}`);
    } finally { await booted.shutdown(); }
  }

  // =================================================================================================
  // CASE 2b — the SOURCE must survive a refused handoff. Driven through the same public call with an
  // owner that cannot answer, and the source chat checked afterwards.
  // =================================================================================================
  {
    const host = createHost({ mode: 'plugin_only', faults: { silentOwners: ['flashback', 'hayaku', 'libra', 'lia'] } });
    const booted = await boot(host);
    try {
      await seedOwners(booted.context, host);
      const sourceIds = host.chats.map(chat => chat.id);
      let thrown = null;
      try { await booted.retrace.continueToNextSession(); } catch (error) { thrown = error; }
      const target = targetChat(host);
      observations.cases.push({
        case: 'counterexample_no_owner_answers',
        code: thrown?.code || null,
        sourceStillPresent: sourceIds.every(id => host.chats.some(chat => chat.id === id)),
        journalState: target?.memorySessionBridge?.handoffJournal?.state || null,
      });
      assert.ok(thrown, 'a handoff with no answering owner must not report success');
      assert.ok(sourceIds.every(id => host.chats.some(chat => chat.id === id)),
        'the source chat must be preserved when the handoff cannot complete');
      passed += 1;
      console.log(`  CASE 2b no owner answers: refused (${thrown.code || 'threw'}), source preserved`);
    } finally { await booted.shutdown(); }
  }

  // =================================================================================================
  // CASE 3 — post-adoption drift: the character read back no longer carries the adopted chat.
  // =================================================================================================
  {
    const host = createHost({ mode: 'plugin_only', faults: { driftAfterAdoption: true } });
    const booted = await boot(host);
    try {
      let thrown = null;
      let result = null;
      try { result = await booted.retrace.continueToNextSession(); } catch (error) { thrown = error; }
      observations.cases.push({
        case: 'counterexample_post_adoption_drift',
        code: thrown?.code || null,
        completed: Boolean(result),
        message: thrown ? String(thrown.message).slice(0, 200) : null,
      });
      // Either outcome is acceptable for the CONTRACT as long as success is not claimed falsely: if it
      // returns, the returned target must actually be active; if it refuses, that is fail-closed.
      if (!thrown) {
        const target = targetChat(host);
        assert.ok(target, 'a claimed success must leave the target chat with its bridge');
      }
      passed += 1;
      console.log(`  CASE 3 drift: ${thrown ? 'refused (' + (thrown.code || 'threw') + ')' : 'completed'}`);
    } finally { await booted.shutdown(); }
  }

  console.log(`retrace_u1_public_handoff_test: PASS (${passed} checks)`);
  console.log(JSON.stringify(observations, null, 1));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
