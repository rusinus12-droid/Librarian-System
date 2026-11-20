'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const GRADIA_SRC = fs.readFileSync(path.join(ROOT, 'plugins', 'GRADIA.js'), 'utf8');
const RETRACE_SRC = fs.readFileSync(path.join(ROOT, 'plugins', 'RETRACE.js'), 'utf8');

function createPluginStorage() {
  const map = new Map();
  return {
    _map: map,
    async getItem(key) { return map.has(key) ? map.get(key) : null; },
    async setItem(key, value) { map.set(String(key), String(value)); return true; },
    async removeItem(key) { map.delete(String(key)); return true; },
    async keys() { return [...map.keys()]; }
  };
}

function createHostHarness() {
  const character = {
    chaId: 'char_gradia_retrace_1',
    name: '세연',
    chatPage: 0,
    chats: [
      {
        id: 'chat_source_001',
        name: '원본 세션',
        message: [
          { role: 'user', data: '안녕 세연아', chatId: 'm1' },
          { role: 'char', data: '안녕, 오늘도 반가워.', chatId: 'm2' }
        ]
      }
    ]
  };
  const gradiaStorage = createPluginStorage();
  const retraceStorage = createPluginStorage();
  const channels = new Map(); // pluginId -> Map(channel -> Set(fn))

  function makeApi(pluginId, pluginStorage) {
    if (!channels.has(pluginId)) channels.set(pluginId, new Map());
    return {
      apiVersion: '3.0',
      pluginStorage,
      safeLocalStorage: pluginStorage,
      async getCharacter() { return JSON.parse(JSON.stringify(character)); },
      async setCharacter(next) {
        Object.keys(character).forEach(k => delete character[k]);
        Object.assign(character, JSON.parse(JSON.stringify(next)));
        return true;
      },
      async getCurrentCharacterIndex() { return 0; },
      async getCurrentChatIndex() { return Number(character.chatPage || 0); },
      async getChatFromIndex(_ci, idx) {
        const i = Number.isInteger(idx) ? idx : Number(character.chatPage || 0);
        return character.chats[i] ? JSON.parse(JSON.stringify(character.chats[i])) : null;
      },
      async setChatFromIndex(_ci, idx, chat) {
        character.chats[idx] = JSON.parse(JSON.stringify(chat));
        return true;
      },
      async getDatabase() {
        return {
          characters: [JSON.parse(JSON.stringify(character))],
          personas: [{ id: 'p1', name: '유저' }],
          selectedPersona: 0,
          plugins: [
            { name: 'flashback_memory', enabled: true },
            { name: 'serial_gradation_agents_for_rp', enabled: true },
            { name: 'flashback_hayaku_bridge', enabled: true }
          ]
        };
      },
      async getArgument() { return ''; },
      async setArgument() { return true; },
      async registerSetting() { return { id: `${pluginId}:setting` }; },
      async registerButton() { return { id: `${pluginId}:button` }; },
      async unregisterUIPart() { return true; },
      async addRisuReplacer() { return true; },
      async removeRisuReplacer() { return true; },
      async onUnload(fn) { return fn; },
      async addPluginChannelListener(channel, fn) {
        const map = channels.get(pluginId);
        if (!map.has(channel)) map.set(channel, new Set());
        map.get(channel).add(fn);
        return () => { map.get(channel)?.delete(fn); };
      },
      async removePluginChannelListener(channel, fn) {
        channels.get(pluginId)?.get(channel)?.delete(fn);
        return true;
      },
      async postPluginChannelMessage(targetPluginId, channel, message) {
        if (!channels.has(targetPluginId)) {
          throw new Error(`Plugin not found: ${targetPluginId}`);
        }
        const listeners = channels.get(targetPluginId)?.get(channel);
        if (!listeners || listeners.size === 0) {
          throw new Error(`Plugin channel listener not found: ${targetPluginId}/${channel}`);
        }
        const payload = JSON.parse(JSON.stringify(message));
        for (const fn of [...listeners]) {
          queueMicrotask(() => { void fn(payload, { sender: pluginId, channel }); });
        }
        return true;
      }
    };
  }

  function createContext(pluginId, api) {
    const sandbox = {
      console: { log() {}, warn: (...a) => console.warn('[VM]', ...a), error: (...a) => console.error('[VM]', ...a), info() {}, debug() {} },
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      URL, TextEncoder, TextDecoder, AbortController, AbortSignal,
      crypto: {
        randomUUID: () => crypto.randomUUID(),
        subtle: crypto.webcrypto?.subtle
      },
      risuai: api,
      Risuai: api,
      RisuAI: api,
      window: null,
      globalThis: null
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    return vm.createContext(sandbox);
  }

  async function bootGradia() {
    const api = makeApi('serial_gradation_agents_for_rp', gradiaStorage);
    const ctx = createContext('serial_gradation_agents_for_rp', api);
    vm.runInContext(GRADIA_SRC, ctx, { filename: 'GRADIA.js' });
    await new Promise(r => setTimeout(r, 80));
    return { api, ctx, publicApi: ctx.__SerialGradationAgentsForRP };
  }

  async function bootRetrace() {
    const api = makeApi('flashback_hayaku_bridge', retraceStorage);
    const ctx = createContext('flashback_hayaku_bridge', api);
    vm.runInContext(RETRACE_SRC, ctx, { filename: 'RETRACE.js' });
    await new Promise(r => setTimeout(r, 80));
    return { api, ctx, publicApi: ctx.__RETRACE };
  }

  function registerMockPeerResponders() {
    // Minimal mock flashback_memory peer (0 records, plugin_only) so RE:TRACE's storage gate has a live owner.
    const fbApi = makeApi('flashback_memory', createPluginStorage());
    fbApi.addPluginChannelListener('flashback_memory_bridge_request_v1', async (req) => {
      const { requestId, action, payload } = req || {};
      let result = {};
      if (action === 'capabilities') {
        result = {
          ok: true,
          pluginVersion: '2.0.6',
          compatibility: {
            schema: 'retrace.peer_compatibility.v1',
            protocolMajor: 1,
            pluginId: 'flashback_memory',
            pluginVersion: '2.0.6',
            handoffContract: 'flashback_memory.handoff_immutable_source.v2',
            receiptSchema: 'flashback_memory.session_handoff_adoption.v4'
          }
        };
      } else if (action === 'memory_suite_storage_status') {
        const activeChat = character.chats[character.chatPage] || character.chats[0];
        result = {
          mode: 'plugin_only',
          supportedStorageModes: ['plugin_only', 'server_only'],
          scope: { scopeId: `fb_${activeChat?.id || 'chat'}`, chatId: activeChat?.id || '', canonicalChatId: activeChat?.id || '' },
          recoveryRequired: false,
          status: { state: 'ready', mode: 'plugin_only', recoveryRequired: false },
          ownerPluginId: 'flashback_memory',
          authorizedRequester: 'flashback_hayaku_bridge'
        };
      } else if (action === 'memory_suite_prepare_handoff_target') {
        result = {
          schema: 'memory-suite.target-storage-preparation.v1',
          owner: 'flashback',
          targetChatId: payload?.targetChatId || '',
          transferId: payload?.transferId || '',
          mode: payload?.mode || 'plugin_only',
          verified: true
        };
      } else if (action === 'inspect') {
        result = { ok: true, available: false, records: 0, loadedRecords: 0, shards: 0, integrityOk: true, reason: 'no_records' };
      } else if (action === 'adopt_session_handoff') {
        result = { ok: true, verified: true, durable: true, sourcePreserved: true, records: 0, handoffContract: 'flashback_memory.handoff_immutable_source.v2', reason: 'no_records' };
      }
      await fbApi.postPluginChannelMessage('flashback_hayaku_bridge', 'flashback_memory_bridge_response_v1', {
        schema: 'flashback-memory-bridge-ipc-v1',
        kind: 'response',
        requestId,
        action,
        ok: true,
        result
      });
    });
  }

  return { character, gradiaStorage, retraceStorage, channels, bootGradia, bootRetrace, registerMockPeerResponders };
}

test('RE:TRACE handoff inherits all 4 GRADIA per-chat stores, preserves source, is idempotent, and rejects forged sender', async () => {
  const host = createHostHarness();
  host.registerMockPeerResponders();
  const gradia = await host.bootGradia();
  const retrace = await host.bootRetrace();

  assert.ok(gradia.publicApi, 'GRADIA publicApi loaded');
  assert.ok(retrace.publicApi, 'RE:TRACE publicApi loaded');

  // Inspect empty source first to obtain exact canonical sourceScopeKey
  const emptyInspect = await gradia.publicApi.inspectGradiaSessionHandoff({ sourceChatId: 'chat_source_001' });
  assert.equal(emptyInspect.ok, true);
  assert.equal(emptyInspect.itemCount, 0);
  const sourceScopeKey = emptyInspect.scopeKey;
  assert.ok(sourceScopeKey, 'sourceScopeKey resolved');

  // Seed all 4 per-chat persistent stores on sourceScopeKey
  await host.gradiaStorage.setItem('serial_gradation_agents_for_rp:runtime_settings:v2', JSON.stringify({
    version: 3,
    savedAt: new Date().toISOString(),
    settings: {
      npcDisposition: {
        [sourceScopeKey]: {
          default: 'acquaintance',
          npcs: [{ id: 'nd-1', name: '세연', level: 'like', note: '신뢰 형성됨' }]
        }
      },
      forcedBondCards: {
        [sourceScopeKey]: [{ id: 'fb-1', from: '유저', to: '세연', relation: '동료', note: '서재 열쇠 공유' }]
      },
      bodyStateCards: {
        [sourceScopeKey]: [{ id: 'bs-1', name: '세연', constitution: '건강', canConceive: false, cycleLength: 28, contraception: 'none', basis: '대화 확인' }]
      }
    }
  }));
  await host.gradiaStorage.setItem('serial_gradation_agents_for_rp:lore_cards:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    cards: {
      bodyState: { [sourceScopeKey]: [{ id: 'lbs-1', name: '민아', constitution: '민감', origin: 'lore' }] },
      forcedBond: { [sourceScopeKey]: [{ id: 'lfb-1', from: '민아', to: '세연', relation: '자매', origin: 'lore' }] },
      npcDisposition: { [sourceScopeKey]: [{ id: 'lnd-1', name: '민아', level: 'dislike', origin: 'lore' }] },
      romancePrefs: {},
      dismissed: {
        bodyState: {},
        forcedBond: { [sourceScopeKey]: ['거절된제안::1'] },
        npcDisposition: { [sourceScopeKey]: ['거절된경향::1'] },
        romancePrefs: {}
      }
    }
  }));
  await host.gradiaStorage.setItem('serial_gradation_agents_for_rp:intimacy_cards:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    cards: {
      [sourceScopeKey]: [{ id: 'int-1', name: '세연', likedPositions: '기본', dislikedPositions: '없음', origin: 'user' }]
    }
  }));
  await host.gradiaStorage.setItem('serial_gradation_agents_for_rp:relationship_state:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    chats: {
      [sourceScopeKey]: {
        pairs: { '유저::세연': { intimacy: 72, trust: 80 } },
        profiles: {},
        notes: [{ at: 1700000000000, text: '서재에서 약속함' }],
        history: [],
        lastTurn: 5
      }
    }
  }));

  // 1. RE:TRACE inspectTransition discovers GRADIA via authenticated IPC
  const preview = await retrace.publicApi.inspectTransition({ includeServerData: false });
  assert.equal(preview.includeGradia, true);
  assert.ok(preview.gradiaItemCount >= 8, `expected >= 8 items, got ${preview.gradiaItemCount}`);
  assert.equal(preview.gradia.counts.npcDisposition, 2); // default + 1 npc
  assert.equal(preview.gradia.counts.forcedBondCards, 1);
  assert.equal(preview.gradia.counts.bodyStateCards, 1);
  assert.equal(preview.gradia.counts.loreCards, 3);
  assert.equal(preview.gradia.counts.dismissedLoreCards, 2);
  assert.equal(preview.gradia.counts.intimacyCards, 1);
  assert.equal(preview.gradia.counts.relationshipState, 1);

  // 2. Execute full RE:TRACE next-session handoff
  const result = await retrace.publicApi.continueToNextSession();
  assert.equal(result.ok, true, `handoff failed: ${JSON.stringify(result)}`);
  assert.equal(result.gradiaVerified, true);
  assert.equal(result.gradiaItems, preview.gradiaItemCount);
  assert.equal(result.gradiaAdoption.sourcePreserved, true);
  assert.equal(result.gradiaAdoption.durable, true);

  // 3. Verify target scope has exact cloned data & source scope is untouched
  const targetChatId = result.targetChatId;
  const targetInspect = await gradia.publicApi.inspectGradiaSessionHandoff({ sourceChatId: targetChatId });
  const sourceAfterInspect = await gradia.publicApi.inspectGradiaSessionHandoff({ sourceChatId: 'chat_source_001' });
  assert.equal(targetInspect.ok, true);
  assert.equal(targetInspect.itemCount, preview.gradiaItemCount);
  assert.equal(targetInspect.digest, preview.gradia.digest);
  assert.equal(sourceAfterInspect.digest, preview.gradia.digest);
  assert.notEqual(targetInspect.scopeKey, sourceScopeKey);

  // 4. Idempotent retry with same transferId succeeds without duplicating data
  const replay = await gradia.publicApi.adoptGradiaSessionHandoff({
    targetChatId,
    transferId: result.transferId,
    sourceScopeKey,
    expectedSourceDigest: preview.gradia.digest
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.items, preview.gradiaItemCount);

  // 5. Forged IPC sender is silently ignored
  let forgedReplyCount = 0;
  host.channels.set('evil_plugin', new Map([['gradia_memory_bridge_response_v1', new Set([() => { forgedReplyCount += 1; }])]]));
  const bridgeRespListeners = host.channels.get('flashback_hayaku_bridge')?.get('gradia_memory_bridge_response_v1');
  const spyBridge = (msg) => { if (msg?.requestId === 'forged-1') forgedReplyCount += 1; };
  bridgeRespListeners?.add(spyBridge);
  const listeners = host.channels.get('serial_gradation_agents_for_rp').get('gradia_memory_bridge_request_v1');
  for (const fn of listeners) {
    await fn({
      schema: 'gradia-retrace-ipc-v1',
      kind: 'request',
      requestId: 'forged-1',
      action: 'ping',
      payload: {}
    }, { sender: 'evil_plugin', channel: 'gradia_memory_bridge_request_v1' });
  }
  await new Promise(r => setTimeout(r, 20));
  bridgeRespListeners?.delete(spyBridge);
  assert.equal(forgedReplyCount, 0);

  // 6. When GRADIA IPC is absent, RE:TRACE inspectTransition still succeeds with includeGradia=false
  host.channels.get('serial_gradation_agents_for_rp').clear();
  host.character.chatPage = 1; // switch back to source chat
  const previewWithoutGradia = await retrace.publicApi.inspectTransition({ includeServerData: false });
  assert.equal(previewWithoutGradia.includeGradia, false);
  assert.equal(previewWithoutGradia.gradiaItemCount, 0);
});
