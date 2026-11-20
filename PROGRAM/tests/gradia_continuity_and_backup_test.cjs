'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const GRADIA_SRC = fs.readFileSync(path.join(ROOT, 'plugins', 'GRADIA.js'), 'utf8');

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

async function bootGradiaHost() {
  const storage = createPluginStorage();
  const baseMessages = [
    { role: 'user', data: '세연아, 서재 열쇠 어디 뒀어?', chatId: 'm_u1' },
    { role: 'char', data: '책상 두 번째 서랍에 넣어뒀어.', chatId: 'm_a1' },
    { role: 'user', data: '고마워, 지금 같이 가볼래?', chatId: 'm_u2' },
    { role: 'char', data: '응, 지금 바로 가자.', chatId: 'm_a2' }
  ];
  let character = {
    chaId: 'char_gradia_cont_1',
    name: '세연',
    chatPage: 0,
    chats: [
      {
        id: 'chat_origin',
        name: '서재 에피소드',
        fmIndex: -1,
        message: JSON.parse(JSON.stringify(baseMessages))
      }
    ]
  };

  const api = {
    apiVersion: '3.0',
    pluginStorage: storage,
    safeLocalStorage: storage,
    async getCharacter() { return JSON.parse(JSON.stringify(character)); },
    async setCharacter(next) { character = JSON.parse(JSON.stringify(next)); return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return Number(character.chatPage || 0); },
    async getChatFromIndex(_ci, idx) {
      const i = Number.isInteger(idx) ? idx : Number(character.chatPage || 0);
      return character.chats[i] ? JSON.parse(JSON.stringify(character.chats[i])) : null;
    },
    async getDatabase() {
      return {
        characters: [JSON.parse(JSON.stringify(character))],
        personas: [{ id: 'p1', name: '유저' }],
        selectedPersona: 0
      };
    },
    async getArgument() { return ''; },
    async setArgument() { return true; },
    async registerSetting() { return { id: 'gradia:setting' }; },
    async registerButton() { return { id: 'gradia:button' }; },
    async unregisterUIPart() { return true; },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addPluginChannelListener() { return () => {}; },
    async removePluginChannelListener() { return true; },
    async postPluginChannelMessage() { return true; },
    async onUnload(fn) { return fn; }
  };

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
  const ctx = vm.createContext(sandbox);
  vm.runInContext(GRADIA_SRC, ctx, { filename: 'GRADIA.js' });
  await new Promise(r => setTimeout(r, 80));

  return {
    storage,
    baseMessages,
    getCharacter: () => character,
    setCharacter: next => { character = next; },
    api: ctx.__SerialGradationAgentsForRP
  };
}

async function seedAllFourStores(storage, scopeKey) {
  await storage.setItem('serial_gradation_agents_for_rp:runtime_settings:v2', JSON.stringify({
    version: 3,
    savedAt: new Date().toISOString(),
    settings: {
      npcDisposition: {
        [scopeKey]: {
          default: 'acquaintance',
          npcs: [{ id: 'nd-1', name: '세연', level: 'like', note: '신뢰 형성됨' }]
        }
      },
      forcedBondCards: {
        [scopeKey]: [{ id: 'fb-1', from: '유저', to: '세연', relation: '동료', note: '서재 열쇠 공유' }]
      },
      bodyStateCards: {
        [scopeKey]: [{ id: 'bs-1', name: '세연', constitution: '건강', canConceive: false, cycleLength: 28, contraception: 'none', basis: '대화 확인' }]
      }
    }
  }));
  await storage.setItem('serial_gradation_agents_for_rp:lore_cards:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    cards: {
      bodyState: { [scopeKey]: [{ id: 'lbs-1', name: '민아', constitution: '민감', origin: 'lore' }] },
      forcedBond: { [scopeKey]: [{ id: 'lfb-1', from: '민아', to: '세연', relation: '자매', origin: 'lore' }] },
      npcDisposition: { [scopeKey]: [{ id: 'lnd-1', name: '민아', level: 'dislike', origin: 'lore' }] },
      romancePrefs: {},
      dismissed: {
        bodyState: {},
        forcedBond: { [scopeKey]: ['거절된제안::1'] },
        npcDisposition: { [scopeKey]: ['거절된경향::1'] },
        romancePrefs: {}
      }
    }
  }));
  await storage.setItem('serial_gradation_agents_for_rp:intimacy_cards:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    cards: {
      [scopeKey]: [{ id: 'int-1', name: '세연', likedPositions: '기본', dislikedPositions: '없음', origin: 'user' }]
    }
  }));
  await storage.setItem('serial_gradation_agents_for_rp:relationship_state:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    chats: {
      [scopeKey]: {
        turn: 4,
        lastInputHash: 'abc123',
        pairs: { '유저::세연': { intimacy: 72, trust: 80 } },
        pending: [],
        notes: [{ at: 1700000000000, text: '서재에서 약속함' }]
      }
    }
  }));
}

test('GRADIA native branch auto-inherits full 4-store state (including full relationship history), is idempotent, and blocks diverged branch', async () => {
  const host = await bootGradiaHost();
  const originInspect = await host.api.inspectGradiaSessionHandoff({ sourceChatId: 'chat_origin' });
  const originScopeKey = originInspect.scopeKey;
  await seedAllFourStores(host.storage, originScopeKey);
  const originSnap = await host.api.readGradiaChatStateSnapshot(originScopeKey);
  assert.equal(originSnap.totalItems, 11);

  // Add a verified RisuAI native branch at message index 2 (after m_a1)
  const char = host.getCharacter();
  char.chats.push({
    id: 'chat_branch_ok',
    name: '서재 에피소드 (Branch)',
    fmIndex: -1,
    message: [
      ...JSON.parse(JSON.stringify(host.baseMessages.slice(0, 2))),
      { role: 'char', isComment: true, disabled: true, data: '{{specialcomment::branchedfrom::chat_origin::서재 에피소드::m_a1::}}' }
    ]
  });
  char.chatPage = 1;

  const res = await host.api.ensureGradiaNativeContinuity();
  assert.equal(res.ok, true);
  assert.equal(res.adopted, true);
  assert.equal(res.origin, 'native_branch');
  assert.equal(res.sourcePreserved, true);
  assert.equal(res.items, originSnap.totalItems);

  const branchSnap = await host.api.readGradiaChatStateSnapshot(res.targetScopeKey);
  assert.equal(branchSnap.digest, originSnap.digest);
  // Full relationshipState (including turn and notes) preserved per user decision
  assert.equal(branchSnap.payload.relationshipState.turn, 4);
  assert.equal(branchSnap.payload.relationshipState.notes.length, 1);

  // Idempotent replay
  const replay = await host.api.ensureGradiaNativeContinuity({ force: true });
  assert.equal(replay.ok, true);
  assert.equal(replay.adopted, false);
  assert.equal(replay.idempotentReplay, true);

  // Diverged branch (tampered prefix) must be blocked
  char.chats.push({
    id: 'chat_branch_diverged',
    name: '변조된 분기',
    fmIndex: -1,
    message: [
      { role: 'user', data: '전혀 다른 메시지', chatId: 'm_u1' },
      JSON.parse(JSON.stringify(host.baseMessages[1])),
      { role: 'char', isComment: true, disabled: true, data: '{{specialcomment::branchedfrom::chat_origin::서재 에피소드::m_a1::}}' }
    ]
  });
  char.chatPage = 2;
  const diverged = await host.api.inspectGradiaNativeContinuity();
  assert.equal(diverged.kind, 'native_branch');
  assert.equal(diverged.blocked, true);
  assert.equal(diverged.eligible, false);
});

test('GRADIA native chat copy auto-detects title copy & transcript copy, plus manual merge copy', async () => {
  const host = await bootGradiaHost();
  const originInspect = await host.api.inspectGradiaSessionHandoff({ sourceChatId: 'chat_origin' });
  const originScopeKey = originInspect.scopeKey;
  await seedAllFourStores(host.storage, originScopeKey);
  const originSnap = await host.api.readGradiaChatStateSnapshot(originScopeKey);

  const char = host.getCharacter();
  // 1. Title-marked native copy
  char.chats.push({
    id: 'chat_copy_title',
    name: '서재 에피소드 (Copy)',
    fmIndex: -1,
    message: JSON.parse(JSON.stringify(host.baseMessages))
  });
  char.chatPage = 1;
  const copyRes = await host.api.ensureGradiaNativeContinuity();
  assert.equal(copyRes.ok, true);
  assert.equal(copyRes.adopted, true);
  assert.equal(copyRes.origin, 'native_chat_copy');
  assert.equal(copyRes.reason, 'risu_native_chat_copy_immediate_title');
  assert.equal(copyRes.items, originSnap.totalItems);

  // 2. Transcript-only native copy (different title, matching U+A prefix)
  char.chats.push({
    id: 'chat_copy_transcript',
    name: '이름을 바꾼 복사 채팅',
    fmIndex: -1,
    message: JSON.parse(JSON.stringify(host.baseMessages))
  });
  char.chatPage = 2;
  const txRes = await host.api.ensureGradiaNativeContinuity();
  assert.equal(txRes.ok, true);
  assert.equal(txRes.adopted, true);
  assert.equal(txRes.origin, 'native_chat_copy');
  assert.equal(txRes.reason, 'risu_native_chat_copy_transcript');
  assert.equal(txRes.items, originSnap.totalItems);

  // 3. Manual copy with merge into a chat that already has its own card
  char.chats.push({
    id: 'chat_manual_target',
    name: '완전 새 채팅',
    fmIndex: -1,
    message: [{ role: 'user', data: '새로운 시작', chatId: 'm_new1' }]
  });
  char.chatPage = 3;
  const targetInspect = await host.api.inspectGradiaSessionHandoff({ sourceChatId: 'chat_manual_target' });
  await host.storage.setItem('serial_gradation_agents_for_rp:intimacy_cards:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    cards: {
      [originScopeKey]: [{ id: 'int-1', name: '세연', likedPositions: '기본', dislikedPositions: '없음', origin: 'user' }],
      [targetInspect.scopeKey]: [{ id: 'int-2', name: '민아', likedPositions: '선호', dislikedPositions: '없음', origin: 'user' }]
    }
  }));

  const sources = await host.api.listGradiaCopySourceChats();
  assert.ok(sources.items.some(item => item.chatId === 'chat_origin'));

  const merged = await host.api.copyGradiaChatStateFromChat({ sourceChatId: 'chat_origin', mode: 'merge' });
  assert.equal(merged.ok, true);
  assert.equal(merged.mode, 'merge');
  assert.equal(merged.counts.intimacyCards, 2); // kept 민아 + copied 세연
});

test('GRADIA portable JSON backup/restore verifies SHA-256, rejects tampering, and supports same-chat, other-chat, and updated-bot restore', async () => {
  const host = await bootGradiaHost();
  const originInspect = await host.api.inspectGradiaSessionHandoff({ sourceChatId: 'chat_origin' });
  const originScopeKey = originInspect.scopeKey;
  await seedAllFourStores(host.storage, originScopeKey);
  const originSnap = await host.api.readGradiaChatStateSnapshot(originScopeKey);

  // 1. Export JSON backup
  const backup = await host.api.exportGradiaChatBackup();
  assert.equal(backup.schema, 'gradia.portable_chat_backup.v1');
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.policy.includesSecrets, false);
  assert.equal(backup.integrity.algorithm, 'SHA-256');
  assert.equal(backup.totalItems, originSnap.totalItems);
  assert.equal(backup.payloadDigest, originSnap.digest);

  // 2. Tampered backup must fail SHA-256 integrity verification
  const tampered = JSON.parse(JSON.stringify(backup));
  tampered.payload.forcedBondCards[0].note = '변조된 내용';
  await assert.rejects(
    () => host.api.inspectGradiaChatBackup(tampered),
    err => err?.code === 'GRADIA_BACKUP_INTEGRITY_MISMATCH'
  );

  // 3. Same-chat replace restore
  await host.storage.removeItem('serial_gradation_agents_for_rp:intimacy_cards:v1');
  const clearedSnap = await host.api.readGradiaChatStateSnapshot(originScopeKey);
  assert.equal(clearedSnap.counts.intimacyCards, 0);

  const sameInspect = await host.api.inspectGradiaChatBackup(backup);
  assert.equal(sameInspect.match.sameChat, true);
  assert.equal(sameInspect.recommendedMode, host.api.GRADIA_PORTABLE_RESTORE_MODES.SAME_CHAT_REPLACE);

  const sameRestore = await host.api.restoreGradiaChatBackup(backup);
  assert.equal(sameRestore.ok, true);
  assert.equal(sameRestore.verified, true);
  assert.equal(sameRestore.targetDigest, originSnap.digest);

  // 4. Updated bot (new character ID, matching transcript) restore
  host.setCharacter({
    chaId: 'char_gradia_v2_updated',
    name: '세연 v2',
    chatPage: 0,
    chats: [
      {
        id: 'chat_v2_session',
        name: '업데이트된 봇 세션',
        fmIndex: -1,
        message: JSON.parse(JSON.stringify(host.baseMessages))
      }
    ]
  });

  const botInspect = await host.api.inspectGradiaChatBackup(backup);
  assert.equal(botInspect.match.sameCharacter, false);
  assert.equal(botInspect.match.transcriptMatch, true);
  assert.equal(botInspect.recommendedMode, host.api.GRADIA_PORTABLE_RESTORE_MODES.UPDATED_BOT_REPLACE);

  const botRestore = await host.api.restoreGradiaChatBackup(backup, { mode: host.api.GRADIA_PORTABLE_RESTORE_MODES.UPDATED_BOT_REPLACE });
  assert.equal(botRestore.ok, true);
  assert.equal(botRestore.items, originSnap.totalItems);
  assert.equal(botRestore.targetDigest, originSnap.digest);
});
