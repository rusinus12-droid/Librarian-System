'use strict';
// Gate: 리콜 파이프라인 무결성 — 저장된 기억이 회상 후보에서 탈락하지 않는가.
//
// 배경 (실측 결함):
//   저장된 기억이 meta 를 수정하는 유지보수 경로를 거친 뒤 integrity 체크섬이 무효화되고,
//   `getManagedEntries` 의 `isIntegrityValidMemoryEntry` 필터가 이를 **조용히** 탈락시킨다.
//   실측: 12턴 후 lmai_memory 15개 중 3개만 회상 후보로 남았다 (12개 누락).
//
//   원인 경로 (모두 meta 를 바꾸고 재스탬프하지 않음):
//     ① 10g `rewriteMemoryEntry` — entity rename 유지보수가 meta 재작성
//     ② 09b 콜드 아카이브 hydrate — imp/ttl/coldArchive 필드 추가
//     ③ 15d GUI 기억 편집
//   그리고 scopeKey 폴백이 잘못된 형식(`chat-x`)을 저장하는 경로 (10h).
//
// 이 게이트는 턴을 쌓은 뒤 `getManagedEntries` 가 **모든** 저장 기억을 반환하는지 검사한다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const {installHostProjection,admit,waitForTurn}=require('./libra_broad_baseline_host_fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

let code = fs.readFileSync(process.env.LIBRA_BROAD_TEST_DIST || path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8')
  .replace('const PENDING_FINALIZE_MIN_MS = 3500;', 'const PENDING_FINALIZE_MIN_MS = 0;')
  .replace('const PENDING_FINALIZE_REQUIRED_MATCHES = 2;', 'const PENDING_FINALIZE_REQUIRED_MATCHES = 1;')
  .replace('const REFRESH_STABILIZE_MS = 2500;', 'const REFRESH_STABILIZE_MS = 0;')
  .replace('const REFRESH_DELETE_BLOCK_MS = 15000;', 'const REFRESH_DELETE_BLOCK_MS = 0;');

const harness = fs.readFileSync(path.join(ROOT, 'tools', 'libra_97_test_harness.cjs'), 'utf8');
const stub = harness.slice(harness.indexOf('function makePair'), harness.indexOf('async function main()'));

class El {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this._id = ''; this.style = {}; this.attributes = {}; this.dataset = {}; this.textContent = ''; this._html = ''; this.value = ''; }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._r(this); } get id() { return this._id; }
  set innerHTML(v) { this._html = String(v || ''); } get innerHTML() { return this._html; }
  appendChild(e) { return e; } remove() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[k] = String(v); } getAttribute(k) { return this.attributes[k]; }
  querySelector() { return null; } querySelectorAll() { return []; }
  addEventListener() {} removeEventListener() {}
}
class Doc {
  constructor() { this._ids = {}; this.head = new El('head', this); this.body = new El('body', this); this.readyState = 'complete'; }
  _r(e) { if (e && e.id) this._ids[e.id] = e; }
  createElement(t) { return new El(t, this); }
  createTextNode(t) { const e = new El('#t', this); e.textContent = t; return e; }
  getElementById(i) { return this._ids[String(i || '')] || null; }
  querySelector() { return null; } querySelectorAll() { return []; }
  addEventListener() {} removeEventListener() {}
}

const document = new Doc();
const store = new Map();
const localStore = new Map();
const msgs = [];
const chat = { id: 'chat-rc', localLore: [], message: msgs, msgs, bindedPersona: 'p1' };
const character = { id: 'char-rc', chaId: 'char-rc', name: 'RC', chats: [chat], globalLore: [], lorebook: [] };
const replacers = { beforeRequest: [], afterRequest: [] };

const Risuai = {
  apiVersion: '3.0',
  async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'u', saveMethod: 'm' }; },
  async getArgument() { return undefined; },
  pluginStorage: {
    async getItem(k) { return store.has(k) ? store.get(k) : null; },
    async setItem(k, v) { store.set(k, String(v)); return true; },
    async removeItem(k) { store.delete(k); return true; },
    async keys() { return [...store.keys()]; }
  },
  async getLocalPluginStorage() {
    const s = {
      async getItem(k) { return localStore.has(k) ? localStore.get(k) : null; },
      async setItem(k, v) { localStore.set(k, String(v)); return true; },
      async removeItem(k) { localStore.delete(k); return true; },
      async keys() { return [...localStore.keys()]; }
    };
    return { getStore: () => s, ...s };
  },
  async getCurrentCharacterIndex() { return 0; },
  async getCurrentChatIndex() { return 0; },
  async getCharacterFromIndex() { return character; },
  async getChatFromIndex() { return chat; },
  async getCharacter() { return character; },
  async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'p1' }] }; },
  async setCharacter() {},
  async setCharacterToIndex() {},
  async setChatToIndex() {},
  async registerSetting() {},
  async registerButton() {},
  async requestPluginPermission() { return true; },
  async showContainer() {},
  async hideContainer() {},
  async onUnload() {},
  addRisuReplacer(t, fn) { (replacers[t] = replacers[t] || []).push(fn); },
  addRisuScriptHandler() {},
  async unregisterBodyIntercepter() {},
  async registerBodyInterceptor() {},
  async getLocalStorage() { return null; },
  async setLocalStorage() {}
};

const context = {
  console: { log() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
  globalThis: null, window: null, document, Risuai, risuai: Risuai,
  structuredClone,
  fetch: async () => { throw new Error('no network'); },
  AbortController,
  performance: { now: () => Date.now() },
  Buffer
};
installHostProjection(Risuai,character,chat,msgs);
context.TextEncoder=TextEncoder;context.TextDecoder=TextDecoder;
context.globalThis = context;
context.window = context;
vm.createContext(context);

const snip = '\n;globalThis.__LIBRA_EXPORTS__={MemoryEngine: typeof MemoryEngine!=="undefined"?MemoryEngine:null,LibraDataStorage: typeof LibraDataStorage!=="undefined"?LibraDataStorage:null,LLMProvider: typeof LLMProvider!=="undefined"?LLMProvider:null,ColdStartManager: typeof ColdStartManager!=="undefined"?ColdStartManager:null,MemoryState: typeof MemoryState!=="undefined"?MemoryState:null,PersonaRuntimeCoordinator,IntegrityMetaManager: typeof IntegrityMetaManager!=="undefined"?IntegrityMetaManager:null};\n';
const close = code.lastIndexOf('\n})();');
vm.runInContext(close < 0 ? code : code.slice(0, close) + snip + code.slice(close), context, { timeout: 30000 });

(async () => {
  await new Promise(r => setTimeout(r, 250));
  const exports_ = context.__LIBRA_EXPORTS__;
  const engine = exports_.MemoryEngine;
  if (!engine) { console.log(JSON.stringify({ ok: false, reason: 'engine_missing', assertions: [] })); process.exit(1); }

  const stubFn = new Function('TURN_COUNT', 'crypto', 'return (function(){' + stub + '; return {mockLLMCall,makePair};})()');
  const { mockLLMCall, makePair } = stubFn(97, require('crypto'));
  exports_.ColdStartManager.check = async () => false;
  exports_.LLMProvider.call = mockLLMCall;
  exports_.LLMProvider.isConfigured = () => true;

  Object.assign(engine.CONFIG, {
    debug: true, activityDashboard: 'off', useLLM: true,
    afterRequestMaintenanceMode: 'foreground', afterRequestForegroundTimeoutMs: 45000, backgroundMaintenanceDelayMs: 0,
    storyAuthorEnabled: true, storyAuthorMode: 'proactive',
    directorEnabled: true, directorMode: 'standard',
    worldAdditionalEnabled: true, worldAdditionalMode: 'firm', worldAdditionalAutoIntegrate: true,
    embed: { ...(engine.CONFIG.embed || {}), enabled: false },
    llm: { ...(engine.CONFIG.llm || {}), provider: 'custom_openai', url: 'http://mock/v1', key: 'k', model: 'm', timeout: 5000, stream: false, maxCompletionTokens: 20000 },
    auxLlm: { ...(engine.CONFIG.auxLlm || {}), enabled: false }
  });

  await admit(exports_,character,chat,store);
  const beforeRequest = replacers.beforeRequest[replacers.beforeRequest.length - 1];
  const afterRequest = replacers.afterRequest[replacers.afterRequest.length - 1];

  const TURNS = 8;
  for (let t = 1; t <= TURNS; t++) {
    const pair = makePair(t);
    // The native user message exists before Risu builds its request; the native
    // assistant is published after the response hook returns its unchanged text.
    msgs.push({ role: 'user', content: pair.user, m_id: 'live-u-' + t, id: 'live-u-' + t, time: Date.now() });
    chat.message = msgs;
    character.chats[0] = chat;
    await beforeRequest({messages:[{ role: 'system', content: 'sys' }, { role: 'user', content: pair.user }],maxContextTokens:128000,maxResponseTokens:4096}, 'model');
    await afterRequest(pair.assistant, 'model');
    msgs.push({ role: 'assistant', content: pair.assistant, m_id: 'live-a-' + t, id: 'live-a-' + t, time: Date.now() + 1 });
    await waitForTurn(store,pair.user,pair.assistant);
  }

  const lore = engine.getLorebook(character, chat) || [];
  const allMemories = lore.filter(e => String(e.comment).trim() === 'lmai_memory');
  const managed = engine.getManagedEntries(lore).filter(e => String(e.comment).trim() === 'lmai_memory');

  // ── 핵심: 저장된 기억 전부가 회상 후보여야 한다 ──
  assert('stored_memories_exist', allMemories.length > 0, { count: allMemories.length });
  assert('all_stored_memories_survive_integrity_filter', managed.length === allMemories.length, {
    stored: allMemories.length,
    managed: managed.length,
    dropped: allMemories.length - managed.length
  });

  // ── 무결성 사유 분해 (탈락이 있으면 이유를 보고) ──
  const IMM = exports_.IntegrityMetaManager;
  const scope = exports_.MemoryState?._activeScopeKey || '';
  const reasons = {};
  let badScope = 0;
  for (const e of allMemories) {
    const m = String(e.content || '').match(/^\[META:(\{[^\r\n]*\})]/);
    if (!m) { reasons.no_meta = (reasons.no_meta || 0) + 1; continue; }
    let meta = null;
    try { meta = JSON.parse(m[1]); } catch (_) { reasons.parse_fail = (reasons.parse_fail || 0) + 1; continue; }
    const body = String(e.content).replace(/^\[META:\{[^\r\n]*\}\]/, '').trim();
    const r = IMM.validateMemoryMeta(meta, body, { domain: 'memory', recordId: engine.getSafeKey ? engine.getSafeKey(e) : '', scopeKey: scope });
    if (!r?.ok) { reasons[String(r?.reason || 'unknown')] = (reasons[String(r?.reason || 'unknown')] || 0) + 1; }
    // scopeKey 형식이 정본(char::page::chat::)인가
    const saved = String(meta?.integrity?.scopeKey || '');
    if (saved && !saved.includes('::')) badScope++;
  }
  assert('no_integrity_failures', Object.keys(reasons).length === 0, reasons);
  assert('scope_key_format_canonical', badScope === 0, { off_format: badScope, activeScope: scope });

  // ── 실제 회상이 저장 기억을 반환하는가 ──
  engine.clearDerivedCaches && engine.clearDerivedCaches();
  const recalled = await engine.retrieveMemories('별핵 파편 조사 진행 상황', engine.getCurrentTurn(), managed, {
    focusNames: ['도현', '아리엘'], directFocusNames: ['도현', '아리엘'], relatedFocusNames: [],
    narrativeArcKeys: ['별핵'], embeddingAllowed: false, recallFeedbackLorebook: lore,
    scopeKey: scope, chatId: chat.id, characterId: character.id
  }, 12);
  assert('recall_returns_memories', Array.isArray(recalled) && recalled.length > 0, { count: (recalled || []).length });

  const failed = assertions.filter(a => !a.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    summary: failed.length === 0 ? `리콜 파이프라인 무결성 ${assertions.length}/${assertions.length}` : `실패 ${failed.length}/${assertions.length}`,
    assertions
  }, null, 1));
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, reason: String(err?.message || err), stack: String(err?.stack || ''), assertions }, null, 1));
  process.exit(1);
});
