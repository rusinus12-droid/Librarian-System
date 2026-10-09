'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins', 'LIA_Persona_Linker.js'), 'utf8');
assert.doesNotMatch(source, /return collectCompletedTurnPairs\(chat\)\.find/, 'output capture must not hash every historical pair');
assert.match(source, /collectCompletedTurnPairRange\(runtimeCtx\.chat, startPair, pairCount\)/, 'source revalidation hashes only the pending batch');

const hashText = value => {
  const source = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(36)}-${source.length}`;
};

const makeMessages = () => {
  const rows = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    rows.push({ role: 'user', is_user: true, chatId: `u${turn}`, data: `User turn ${turn}` });
    rows.push({ role: 'assistant', is_user: false, chatId: `a${turn}`, data: `Assistant turn ${turn}` });
  }
  return rows;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let measuredLongHotPathMs = 0;

async function createFixture(mode) {
  const values = new Map();
  const sourcePersona = { id: 'source-persona', name: 'Source Persona', personaPrompt: 'Base persona prompt', note: '' };
  const livePersonaId = 'lia-live-persona::fixture';
  const livePersona = { id: livePersonaId, name: 'Source Persona', personaPrompt: 'Base persona prompt', note: 'Managed by LIA Live Persona Sync.' };
  const liveChat = { id: 'lia-chat', chatId: 'lia-chat', name: 'Fixture Chat', bindedPersona: livePersonaId, message: makeMessages() };
  const character = { id: 'lia-char', chaId: 'lia-char', name: 'Fixture Character', chats: [liveChat], chatPage: 0 };
  const scopeKey = 'char:lia-char|chat:lia-chat';
  const binding = {
    scopeKey,
    enabled: true,
    policy: 'conservative',
    externalChangePolicy: 'safe',
    managerVersion: 6,
    displayNameVersion: 2,
    previousBinding: { hadExplicitBinding: false, personaId: '', capturedAt: new Date().toISOString(), legacyInferred: false },
    bindingStatus: 'connected',
    lastObservedBindingId: livePersonaId,
    lastBindingCheckAt: new Date().toISOString(),
    bindingError: '',
    lastObservedSelectedPersonaId: sourcePersona.id,
    lastObservedSelectedPersonaKey: `id:${sourcePersona.id}`,
    lastSelectedPersonaCheckAt: new Date().toISOString(),
    sourcePersonaId: sourcePersona.id,
    sourcePersonaIndex: 0,
    sourcePersonaName: sourcePersona.name,
    livePersonaId,
    livePersonaName: livePersona.name,
    originalSnapshot: { name: sourcePersona.name, personaPrompt: sourcePersona.personaPrompt },
    basePersonaPrompt: sourcePersona.personaPrompt,
    basePromptHash: hashText(sourcePersona.personaPrompt),
    lastAppliedPromptHash: hashText(livePersona.personaPrompt),
    anchorPairCount: 0,
    lastProcessedPairCount: 0,
    liveState: [],
    coreOverlay: [],
    coreCandidateHistory: {},
    ledgers: [],
    lastProcessedAt: '',
    lastError: '',
    disabledReason: '',
    nextRetryAt: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const storageKey = `liaPersonaLinkerLivePersonaScopeV2::${hashText(scopeKey).slice(0, 24)}`;
  const serialized = JSON.stringify(binding);
  values.set(storageKey, serialized);
  values.set('liaPersonaLinkerLivePersonaIndexV2', JSON.stringify({
    schema: 'lia.live_persona_index.v2',
    version: 2,
    updatedAt: new Date().toISOString(),
    entries: { [scopeKey]: { storageKey, digest: hashText(serialized), livePersonaId, updatedAt: binding.updatedAt } },
  }));

  const pluginStorage = {
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return [...values.keys()]; },
  };
  const safeLocalStorage = {
    async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; },
  };
  let outputListener = null;
  let scriptOutputHandler = null;
  const replacers = new Map();
  const unloadHandlers = [];
  const registrations = { chat: 0, script: 0 };
  const db = { personas: [sourcePersona, livePersona], selectedPersona: 0, characters: [character], plugins: [] };

  const api = {
    pluginStorage,
    safeLocalStorage,
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) {
      if (String(name).includes('memory_suite_server_mode')) return 'plugin_only';
      if (String(name).includes('enable_gui')) return 'false';
      return '';
    },
    async getArg(name) { return await api.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch() { throw new Error('fixture offline'); },
    async getDatabase(fields) {
      if (!Array.isArray(fields)) return db;
      return Object.fromEntries(fields.map(field => [field, db[field] ?? null]));
    },
    async setDatabase(patch) { Object.assign(db, patch || {}); return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return character; },
    async getCharacterFromIndex() { return character; },
    async getChat() { return liveChat; },
    async getCurrentChat() { return liveChat; },
    async getChatFromIndex() { return liveChat; },
    async setChatToIndex(_charIndex, _chatIndex, next) { Object.assign(liveChat, next || {}); return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async unregisterSetting() { return true; },
    async unregisterButton() { return true; },
    async addRisuReplacer(type, handler) { replacers.set(type, handler); return true; },
    async removeRisuReplacer(type, handler) { if (replacers.get(type) === handler) replacers.delete(type); return true; },
    async addPluginChannelListener() { return true; },
    async removePluginChannelListener() { return true; },
    async postPluginChannelMessage() { return true; },
    async addEventListener(type, handler) { if (type === 'unload') unloadHandlers.push(handler); return { type, handler }; },
    async requestPluginPermission(permission) { return permission === 'replacer'; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async log() { return true; },
  };
  if (mode === 'official') {
    api.addRisuChatListener = async (type, handler) => { registrations.chat += 1; if (type === 'output') outputListener = handler; return true; };
    api.removeRisuChatListener = async (type, handler) => { if (type === 'output' && outputListener === handler) outputListener = null; return true; };
    api.addRisuScriptHandler = async () => { registrations.script += 1; return true; };
    api.removeRisuScriptHandler = async () => true;
  } else if (mode === 'script') {
    api.addRisuScriptHandler = async (type, handler) => { registrations.script += 1; if (type === 'output') scriptOutputHandler = handler; return true; };
    api.removeRisuScriptHandler = async (type, handler) => { if (type === 'output' && scriptOutputHandler === handler) scriptOutputHandler = null; return true; };
  }

  const activeTimeouts = new Set();
  const trackedSetTimeout = (handler, delay, ...args) => {
    let timer = null;
    timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
    activeTimeouts.add(timer);
    return timer;
  };
  const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
  const context = vm.createContext({
    risuai: api,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval,
    clearInterval,
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
    prompt: () => null,
  });

  vm.runInContext(source, context, { filename: `LIA-${mode}.js` });
  await sleep(1800);
  const runtime = context.__lia_persona_linker_runtime_v1__;
  assert.ok(runtime, `${mode}: runtime singleton exists`);

  const dispose = async () => {
    try { await runtime.dispose(); } catch (_) {}
    for (const handler of unloadHandlers.slice().reverse()) { try { await handler(); } catch (_) {} }
    for (const timer of activeTimeouts) clearTimeout(timer);
    activeTimeouts.clear();
  };

  return { api, runtime, outputListener, scriptOutputHandler, registrations, liveChat, character, scopeKey, dispose };
}

(async () => {
  for (const mode of ['official', 'script', 'after']) {
    const f = await createFixture(mode);
    try {
      assert.equal(f.runtime.getLiveSyncCaptureState().backend, 'none');
      assert.equal(f.registrations.chat, 0); assert.equal(f.registrations.script, 0);
      assert.equal(f.outputListener, null); assert.equal(f.scriptOutputHandler, null);
      for (const event of [{}, {messageIndex:-1}, {char:f.character,chat:f.liveChat,characterIndex:0,chatIndex:0,messageIndex:9}]) {
        assert.equal(f.runtime.debugProcessChatOutput(event).reason,'manual_only');
      }
      const batch=await f.runtime.debugCaptureLiveSyncBatch({target:{characterIndex:0,chatIndex:0,scopeKey:f.scopeKey},startPair:1});
      assert.equal((await f.runtime.debugVerifyLiveSyncBatch(batch)).ok,true,'explicit snapshot revalidation remains');
      f.liveChat.message[9].data+=' + edited after manual capture';
      const stale=await f.runtime.debugVerifyLiveSyncBatch(batch);
      assert.equal(stale.ok,false);assert.equal(stale.reason,'batch_source_changed');
      const unreadableChat={get message(){throw Error('retired output path must not inspect chat contents');}};
      const start=performance.now();
      for(let i=0;i<500;i++) assert.equal(f.runtime.debugProcessChatOutput({chat:unreadableChat,messageIndex:999}).reason,'manual_only');
      measuredLongHotPathMs=Math.max(measuredLongHotPathMs,performance.now()-start);
      assert.equal(f.runtime.debugScheduleLiveSync({force:true}),false);
      await sleep(700);
      const state=f.runtime.getLiveSyncCaptureState();
      assert.equal(state.trackedTurnRevisions,0);assert.equal(state.scheduledScopes,0);assert.equal(state.requeueScopes.length,0);
    } finally { await f.dispose(); }
  }
  process.stdout.write(`lia_output_listener_revision_contract_test: PASS retired500EventsMs=${measuredLongHotPathMs.toFixed(2)}\n`);
})().catch(error=>{console.error(error);process.exitCode=1;});
