'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {check:checkGuiInventory}=require('./fixtures/flashback_gui_inventory_contract.cjs');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.match(source, /^\/\/@version \d+\.\d+\.\d+\s*$/m);
assert.match(source, /const flashbackMessageRevisionProjection = \(message, index, cache\) =>/);
assert.match(source, /const normalizeStoredChatMessages = \(chat, scopeKeyInput = '', sourceInfoInput = null\) =>/);
assert.match(source, /normalizedLiveStateCache/);
assert.match(source, /LIVE_CHAT_REVISION_CACHE_MAX_RETAINED_CHARS/);

const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out while loading Flashback cache test runtime.');
};
const createStore = () => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};
const pluginStorage = createStore();
const safeLocalStorage = createStore();
let blockPluginStorageKeys = false;
let pluginStorageKeyCalls = 0;
const normalPluginStorageKeys = pluginStorage.keys.bind(pluginStorage);
pluginStorage.keys = async () => {
  pluginStorageKeyCalls += 1;
  if (blockPluginStorageKeys) return await new Promise(() => {});
  return await normalPluginStorageKeys();
};
const argumentValues = new Map([
  ['memory_suite_server_mode', 'plugin_only'],
  ['hook_recall_timeout_ms', '1000'],
  ['enable_gui', 'false']
]);
const currentChat = { id: 'flashback-host-chat', chatId: 'flashback-host-chat', name: 'Host', message: [], messages: [] };
const character = { id: 'flashback-character', chaId: 'flashback-character', name: 'Character', chats: [currentChat] };
const unloadHandlers = [];
const host = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    const key = String(name || '');
    return argumentValues.has(key) ? argumentValues.get(key) : '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument(name, value) {
    const key = String(name || '');
    const clean = value == null ? '' : String(value);
    if (clean) argumentValues.set(key, clean);
    else argumentValues.delete(key);
    return true;
  },
  async nativeFetch() { throw new Error('no server'); },
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async removePluginChannelHandler() { return true; },
  async offPluginChannelMessage() { return true; },
  async postPluginChannelMessage() { return true; },
  async onUnload(handler) { unloadHandlers.push(handler); return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async unregisterSetting() { return true; },
  async unregisterButton() { return true; },
  async unregisterUIPart() { return true; },
  async addRisuReplacer() { return true; },
  async removeRisuReplacer() { return true; },
  async addRisuScriptHandler() { return true; },
  async removeRisuScriptHandler() { return true; },
  async addRisuChatListener() { return true; },
  async removeRisuChatListener() { return true; },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
    if (!Array.isArray(fields)) return all;
    return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; },
  async getCurrentChatIndex() { return 0; },
  async getCharacter() { return character; },
  async getCharacterFromIndex() { return character; },
  async getChat() { return currentChat; },
  async getCurrentChat() { return currentChat; },
  async getChatFromIndex() { return currentChat; },
  async showContainer() { return true; },
  async hideContainer() { return true; },
  async getRootContainer() { return null; },
  async getPluginRoot() { return null; }
};
const activeTimeouts = new Set();
const activeIntervals = new Set();
const trackedSetTimeout = (handler, delay, ...args) => {
  let timer;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
const trackedSetInterval = (handler, delay, ...args) => { const timer = setInterval(handler, delay, ...args); activeIntervals.add(timer); return timer; };
const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout: trackedSetTimeout,
  clearTimeout: trackedClearTimeout,
  setInterval: trackedSetInterval,
  clearInterval: trackedClearInterval,
  queueMicrotask,
  AbortController,
  AbortSignal,
  DOMException,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone,
  performance: globalThis.performance,
  fetch: globalThis.fetch,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
  confirm: () => false,
  alert: () => {},
  prompt: () => null
});

(async () => {
  vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });
  const flashback = await waitFor(() => context.__FlashbackMemory);
  assert.equal(flashback.version, source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)[1]);
  const personaScopeA = flashback._test.resolveScopeFromSnapshot({
    character, chat: currentChat, db: { selectedPersona: 0, personas: [{ id: 'persona-a', name: 'Persona A' }] },
    chatInfo: { characterIndex: 0, chatIndex: 0 }
  });
  const personaScopeB = flashback._test.resolveScopeFromSnapshot({
    character, chat: currentChat, db: { selectedPersona: 0, personas: [{ id: 'persona-b', name: 'Persona B' }] },
    chatInfo: { characterIndex: 0, chatIndex: 0 }
  });
  const outputScopeWithoutPersonaDb = flashback._test.resolveScopeFromSnapshot({
    character, chat: currentChat, chatInfo: { characterIndex: 0, chatIndex: 0 }
  });
  assert.equal(personaScopeA.scopeIdentityVersion, 3);
  assert.equal(personaScopeA.scopeKey, personaScopeB.scopeKey, 'Persona changes do not split Flashback canonical storage');
  assert.equal(personaScopeA.scopeKey, outputScopeWithoutPersonaDb.scopeKey, 'chat_output_v3 without Persona DB resolves the same canonical scope');
  assert.notEqual(personaScopeA.legacyPersonaScopeKey, personaScopeB.legacyPersonaScopeKey, 'legacy Persona keys remain diagnostic migration aliases');
  assert.ok(!personaScopeA.scopeKey.includes('|persona:'), 'canonical Flashback scope excludes Persona identity');
  const legacySourceCandidate = await flashback._test.findSameChatPersonaScopeSource(personaScopeB, { scopes: [{
    ...personaScopeA, scopeKey: personaScopeA.legacyPersonaScopeKey, count: 3, seenAt: Date.now()
  }] });
  assert.equal(legacySourceCandidate?.source?.scopeKey, personaScopeA.legacyPersonaScopeKey, 'one exact legacy Persona scope is discoverable as the lossless migration source');
  const guiHtml = await flashback._test.buildUiHtml();
  checkGuiInventory({api:flashback,html:guiHtml,source});
  assert.match(guiHtml, /id="tab-overview"[^>]*aria-selected="true"/, 'rendered GUI opens on overview');
  assert.match(guiHtml, /id="panel-overview" class="panel active"/, 'rendered overview panel is visible');
  assert.equal((guiHtml.match(/id="lastRecallPanel"/g) || []).length, 1, 'rendered GUI has one recall detail');
  assert.equal((guiHtml.match(/<div data-portable-backup-host="flashback_memory"/g) || []).length, 1, 'rendered GUI has one Portable Memory host');
  assert.ok(guiHtml.indexOf('id="tab-overview"') < guiHtml.indexOf('id="tab-import"'), 'rendered navigation starts with overview');
  assert.match(guiHtml, /id="tab-worldline"/, 'worldline has its own navigation entry');
  assert.match(guiHtml, /id="openResponseRecordsBtn"[^>]*data-open-manual-editor="response"/, 'rendered Storage toolbar opens response records directly');
  assert.match(guiHtml, /응답 원문 목록 열기/, 'rendered empty editor exposes an in-panel entry action');
  assert.doesNotMatch(guiHtml, /왼쪽 분포 카테고리를 누르면/, 'rendered GUI does not reference a nonexistent left distribution category');
  assert.match(guiHtml, /data-edit-source-type="response"/, 'response distribution remains an editable entry point');
  assert.doesNotMatch(guiHtml, /data-edit-source-type="episode_index"/, 'derived episode index is not presented as editable');
  assert.match(guiHtml, /class="type-row type-row-readonly"[^>]*응답 파생 인덱스: 자동 생성·관리되는 읽기 전용 데이터/, 'derived episode index remains visible as read-only data');
  const recalledMemoryHtml = flashback._test.renderLastRecallPanel({
    at: Date.now(),
    selected: [{
      id: 'recall-detail',
      sourceType: 'response',
      title: '전체 본문 확인',
      preview: '접힌 미리보기…',
      detail: '첫 번째 줄 전체\n두 번째 줄도 잘리지 않음',
      score: 0.749,
      components: { anchor: 0.81 }
    }]
  }, '');
  assert.match(recalledMemoryHtml, /<details class="recall-card-item" id="fb-recall-frame-0">/, 'recalled memory renders as an expandable detail');
  assert.match(recalledMemoryHtml, /<summary class="recall-card-summary">/, 'the compact recall card remains the disclosure control');
  assert.match(recalledMemoryHtml, /<div class="recall-card-detail">[\s\S]*?<div>첫 번째 줄 전체\n두 번째 줄도 잘리지 않음<\/div>/, 'expanded recall renders the complete multiline text');
  const argumentRows = flashback._test.flashbackArgumentSettingRows();
  for (const label of ['일반 동작', '리콜 세부 조정', '장면·엔티티 보강', '저장·에피소드·인덱스', '전문가·진단']) {
    assert.match(guiHtml, new RegExp(`<span>${label}<\\/span>`), `${label} group heading is visible in rendered HTML`);
  }
  assert.match(guiHtml, /id="argumentSettingsAuditPanel"/, 'rendered GUI includes the argument source audit');
  assert.match(guiHtml, /data-argument-row="enable_gui"[\s\S]*?ARG 해제/, 'an explicit read-only ARG is visible and can release its override');
  assert.doesNotMatch(guiHtml, /id="argSetting_enableGui"/, 'the GUI cannot disable its own only recovery surface');
  const enabledRow = argumentRows.find(row => row.name === 'enable_gui');
  assert.equal(enabledRow.source, 'argument');
  assert.equal(enabledRow.editable, false);
  assert.equal(flashback._test.flashbackSettingSource('topK', {}, {}), 'default');
  assert.equal(flashback._test.flashbackSettingSource('topK', {}, { topK: 20 }), 'saved');
  assert.equal(flashback._test.flashbackSettingSource('topK', { topK: 24 }, { topK: 20 }), 'argument');
  assert.equal(flashback._test.applyArgumentOverrides({ fallbackHashEmbedding: true, embeddingFallbackProvider: 'hash' }, { overrides: { fallbackHashEmbedding: false } }).embeddingFallbackProvider, '',
    'fallback_hash_embedding=false overrides the derived stored fallback field');
  const clearResult = await flashback._test.clearFlashbackSettingArgument('enable_gui');
  assert.equal(clearResult.verified, true, 'ARG clear requires exact blank readback');
  assert.equal(argumentValues.has('enable_gui'), false, 'canonical ARG key is physically blank after clear');
  assert.equal(flashback._test.flashbackArgumentSettingRows().find(row => row.name === 'enable_gui').source, 'default', 'source falls back after durable ARG clear');
  const renderedIds = Array.from(guiHtml.matchAll(/\sid="([^"]+)"/g), match => match[1]);
  const duplicateIds = renderedIds.filter((id, index) => renderedIds.indexOf(id) !== index);
  assert.deepEqual(duplicateIds, [], 'rendered GUI IDs stay unique');
  assert.equal(flashback._test.normalizeFlashbackGuiTab('unknown'), 'overview');
  assert.equal(flashback._test.flashbackOverviewHealth({ scope: { scopeKey: '' }, manifest: {}, stats: {} }).tone, 'warning',
    'placeholder first paint does not claim healthy storage');
  assert.equal(flashback._test.flashbackOverviewHealth({ scope: { scopeKey: 'scope' }, manifest: {}, stats: {} }).tone, 'success',
    'loaded basic storage state may show the bounded healthy status');
  assert.equal(flashback._test.flashbackOverviewHealth({ scope: { scopeKey: 'scope' }, manifest: { missingShards: 1 }, stats: {} }).tone, 'danger',
    'known storage damage is visible on overview');
  const overviewRecall = flashback._test.flashbackOverviewRecallSummary(
    { at: Date.now(), selected: [{ id: 'one' }], evidenceBudgetPlan: { actualChars: 321 } },
    ''
  );
  assert.equal(overviewRecall.value, '1개 선택');
  assert.equal(overviewRecall.badge, '주입됨');
  assert.match(overviewRecall.meta, /^주입됨 · 321자 · /, 'overview recall summary uses actual evidence chars');
  const baseRecallRecord = { id: 'confirmed', lifecycleStatus: 'active', sourceType: 'response', metadata: { captureAuthority: { provisional: false, liveConfirmed: true } } };
  assert.equal(flashback._test.isRecallIndexableRecord(baseRecallRecord), true, 'confirmed response memory remains recallable');
  assert.equal(flashback._test.isRecallIndexableRecord({ ...baseRecallRecord, id: 'pending', metadata: { captureAuthority: { provisional: true, liveConfirmed: false } } }), false,
    'unconfirmed provisional committed-output memory is excluded from recall');
  assert.equal(flashback._test.isRecallIndexableRecord({ ...baseRecallRecord, id: 'confirmed-provisional', metadata: { captureAuthority: { provisional: true, liveConfirmed: true } } }), true,
    'a provisionally captured row becomes recallable only after explicit live confirmation');

  const chat = { id: 'flashback-cache-chat', message: [] };
  for (let turn = 1; turn <= 3; turn += 1) {
    chat.message.push({ role: 'user', data: `User ${turn}`, chatId: `u-${turn}` });
    chat.message.push({ role: 'assistant', data: `Assistant ${turn}`, chatId: `a-${turn}` });
  }
  chat.messages = chat.message;
  const cacheKey = 'flashback-cache-scope';
  const stats = () => flashback._test.captureBackendSnapshot().liveChatRevisionCache.stats;

  const firstNormalized = flashback._test.normalizeStoredChatMessages(chat, cacheKey);
  const firstState = flashback._test.liveChatStateFromNormalized(firstNormalized);
  assert.equal(firstState.pairCount, 3);
  let diag = stats();
  assert.equal(diag.misses, 6, 'first pass normalizes every message once');
  assert.equal(diag.normalizedBuilds, 1);
  assert.equal(diag.pairBuilds, 1);

  const secondNormalized = flashback._test.normalizeStoredChatMessages(chat, cacheKey);
  const secondState = flashback._test.liveChatStateFromNormalized(secondNormalized);
  assert.equal(secondState.pairCount, 3);
  let next = stats();
  assert.equal(next.misses, diag.misses, 'unchanged transcript has no new normalization misses');
  assert.ok(next.hits >= diag.hits + 6, 'all unchanged messages hit cache');
  assert.equal(next.normalizedReuses, diag.normalizedReuses + 1);
  assert.equal(next.pairReuses, diag.pairReuses + 1);

  chat.message[3].data = 'Assistant 2 edited';
  const editedNormalized = flashback._test.normalizeStoredChatMessages(chat, cacheKey);
  const editedState = flashback._test.liveChatStateFromNormalized(editedNormalized);
  assert.equal(editedState.pairs[1].assistantText, 'Assistant 2 edited');
  diag = stats();
  assert.equal(diag.misses, next.misses + 1, 'only edited Assistant descriptor is recomputed');
  assert.equal(diag.invalidations, next.invalidations + 1);
  assert.equal(diag.normalizedBuilds, next.normalizedBuilds + 1);
  assert.equal(diag.pairBuilds, next.pairBuilds + 1);

  chat.message = chat.message.slice(0, 4);
  chat.messages = chat.message;
  const rolledNormalized = flashback._test.normalizeStoredChatMessages(chat, cacheKey);
  const rolledState = flashback._test.liveChatStateFromNormalized(rolledNormalized);
  assert.equal(rolledState.pairCount, 2);
  next = stats();
  assert.equal(next.misses, diag.misses, 'retained prefix remains cached after rollback');
  assert.ok(next.pruned >= diag.pruned + 2, 'rollback prunes only disappeared suffix entries');

  chat.message.push({ role: 'user', data: 'User 3 new', chatId: 'u-3-new' });
  chat.message.push({ role: 'assistant', data: 'Assistant 3 new', chatId: 'a-3-new' });
  chat.messages = chat.message;
  const appended = flashback._test.normalizeStoredChatMessages(chat, cacheKey);
  assert.equal(flashback._test.liveChatStateFromNormalized(appended).pairCount, 3);
  diag = stats();
  assert.equal(diag.misses, next.misses + 2, 'append computes only new User and Assistant');

  blockPluginStorageKeys = true;
  const firstTurnStartedAt = Date.now();
  const firstTurnMessages = await flashback._test.beforeRequest([
    { role: 'system', content: 'System contract' },
    { role: 'user', content: '첫 번째 사용자 입력' }
  ], 'model');
  const firstTurnElapsedMs = Date.now() - firstTurnStartedAt;
  const firstTurnRuntime = flashback._test.pendingCaptureRuntimeSnapshot();
  assert.ok(Array.isArray(firstTurnMessages), 'first-turn beforeRequest returns the request message array');
  assert.ok(firstTurnElapsedMs < 1000, `empty first turn must return before the 1000ms hook deadline (actual ${firstTurnElapsedMs}ms)`);
  assert.equal(firstTurnRuntime.lastRecall?.reason, 'empty_scope_first_turn', 'an empty first turn is a normal no-memory result');
  assert.equal(firstTurnRuntime.pendingTurns.length, 1, 'the current response capture is armed before storage discovery');
  assert.equal(firstTurnRuntime.pendingTurns[0].latestUser, '첫 번째 사용자 입력');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(pluginStorageKeyCalls >= 1, 'registry-wide discovery may continue outside the foreground request');

  blockPluginStorageKeys = false;
  currentChat.message = [
    { role: 'user', data: '첫 번째 사용자 입력', chatId: 'scope-user-1', id: 'scope-user-1' },
    { role: 'assistant', data: '첫 번째 응답이 정본 채팅에 확정되었습니다.', chatId: 'scope-assistant-1', id: 'scope-assistant-1' }
  ];
  currentChat.messages = currentChat.message;
  const outputCapture = await flashback._test.processRisuChatOutputEvent({
    char: character, chat: currentChat, characterIndex: 0, chatIndex: 0, messageIndex: 1
  });
  assert.notEqual(outputCapture.reason, 'pending_turn_not_found', 'output listener without Persona DB binds the Persona-created pending turn');
  assert.equal(outputCapture.scopeKey, personaScopeA.scopeKey, 'output capture remains in Character+Chat canonical scope');
  assert.ok(Number(outputCapture.captured || 0) + Number(outputCapture.duplicates || 0) >= 1, 'canonical output event is captured or deduplicated');

  const migrationCharacter = { id: 'legacy-character-id', chaId: 'canonical-character-id', name: 'Migration Character' };
  const migrationChat = { id: 'migration-chat-id', name: 'Migration Chat', message: [], messages: [] };
  const migrationTarget = flashback._test.resolveScopeFromSnapshot({
    character: migrationCharacter,
    chat: migrationChat,
    db: { selectedPersona: 0, personas: [{ id: 'legacy-persona-a', name: 'Legacy Persona A' }] },
    chatInfo: { characterIndex: 9, chatIndex: 4 }
  });
  const migrationSource = { ...migrationTarget, scopeKey: migrationTarget.legacyPersonaScopeKey, storageHash: '' };
  const migrationSettings = flashback._test.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });
  const sourceRecord = flashback._test.cleanRecordForMemory({
    id: 'legacy-persona-record-1',
    scopeKey: migrationSource.scopeKey,
    sourceType: 'response',
    sourceId: 'migration-chat-id:turn:1',
    text: 'Legacy Persona A stored this exact response.',
    title: 'Migration turn 1',
    tags: ['migration'],
    tokenCount: 8,
    tokens: 8,
    vector: [1,0,0,0,0,0,0,0],
    dim: 8,
    provider: 'hash',
    model: 'hash-8',
    embeddingProvider: 'hash',
    embeddingModel: 'hash-8',
    embeddingDimensions: 8,
    turnIndex: 1,
    pairIndex: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lifecycleStatus: 'active'
  }, migrationSource, { authoritativeSource: true }).record;
  await flashback._test.saveAllRecords([sourceRecord], migrationSettings, migrationSource);
  const sourceBefore = await flashback._test.loadScopeRecords(migrationSource.scopeKey);
  const sourceBeforeRecordDigest = JSON.stringify(sourceBefore.records);
  const sourceBeforeCommitId = sourceBefore.manifest.commitId;
  const sourceBeforeVectorRefs = JSON.stringify(sourceBefore.records.map(record => record.vectorRef || null));
  const migrated = await flashback._test.cloneScopeStorage(migrationSource, migrationTarget, migrationSettings, {
    mode: 'same_chat_persona_recovery', reason: 'persona_scope_v3_test', weight: 1
  });
  assert.equal(migrated.ok, true, 'single legacy Persona scope migrates into an empty canonical target');
  const targetAfter = await flashback._test.loadScopeRecords(migrationTarget.scopeKey);
  assert.equal(targetAfter.records.length, 1, 'canonical target receives the legacy record exactly once');
  assert.equal(targetAfter.records[0].scopeKey, migrationTarget.scopeKey, 'migrated record is rebound only to the canonical scope');
  assert.equal(targetAfter.manifest.copyAdoptionMode, 'same_chat_persona_recovery');
  assert.ok(targetAfter.manifest.migratedFromScopeKeys.includes(migrationSource.scopeKey));
  assert.ok(targetAfter.manifest.legacyScopeKeys.includes(migrationSource.scopeKey));
  const sourceAfter = await flashback._test.loadScopeRecords(migrationSource.scopeKey);
  assert.equal(JSON.stringify(sourceAfter.records), sourceBeforeRecordDigest, 'legacy source records remain unchanged after migration');
  assert.equal(sourceAfter.manifest.commitId, sourceBeforeCommitId, 'legacy source commit lineage remains unchanged after migration');
  assert.equal(JSON.stringify(sourceAfter.records.map(record => record.vectorRef || null)), sourceBeforeVectorRefs, 'legacy source vector sidecar references remain unchanged after migration');
  const migratedAgain = await flashback._test.cloneScopeStorage(migrationSource, migrationTarget, migrationSettings, {
    mode: 'same_chat_persona_recovery', reason: 'persona_scope_v3_test_repeat', weight: 1
  });
  assert.equal(migratedAgain.reason, 'target_not_empty', 'repeating the same migration is idempotently refused after target activation');
  assert.equal((await flashback._test.loadScopeRecords(migrationTarget.scopeKey)).records.length, 1, 'repeat migration does not duplicate canonical records');

  for (const handler of unloadHandlers) await handler().catch(() => {});
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stdout.write('flashback_long_chat_revision_cache_test: PASS\n');
})().catch(error => {
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  console.error(error);
  process.exitCode = 1;
});
