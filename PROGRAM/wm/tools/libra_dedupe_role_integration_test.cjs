'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }
async function loadLibra() {
  const pluginStorage = new Map();
  const chat = {
    id: 'dedupe-role-chat',
    name: 'Dedup Role Chat',
    localLore: [],
    msgs: [],
    message: []
  };
  const char = { id: 'dedupe-role-char', name: 'Dedup Role Character', chatPage: 0, chats: [chat], lorebook: [], description: '루멘 아카데미 테스트.' };
  const args = new Map(Object.entries({
    debug: 'false',
    llm_provider: 'custom_openai',
    llm_url: 'http://mock.local/v1/chat/completions',
    llm_key: 'dummy-key',
    llm_model: 'mock-primary',
    aux_llm_enabled: 'true',
    aux_llm_provider: 'custom_openai',
    aux_llm_url: 'http://mock.local/v1/chat/completions',
    aux_llm_key: 'dummy-key',
    aux_llm_model: 'mock-aux',
    embedding_enabled: 'false',
    use_lorebook_rag: 'true',
    world_additional_enabled: 'true',
    world_additional_mode: 'firm',
    cold_start_history_limit: '0',
    activity_dashboard: 'off'
  }));
  const risuai = {
    apiVersion: '3.0-test',
    async getRuntimeInfo() { return { apiVersion: '3.0-test', platform: 'node-test', saveMethod: 'mock' }; },
    async getArgument(name) { return args.get(name); },
    async requestPluginPermission() { return true; },
    async getCharacter() { return clone(char); },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex() { return clone(char); },
    async getChatFromIndex() { return clone(chat); },
    async setChatToIndex(_ci, _ti, next) { Object.assign(chat, clone(next)); chat.message = chat.msgs || chat.message || []; char.chats[0] = chat; return true; },
    async setCharacter(next) { Object.assign(char, clone(next)); return true; },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async registerBodyIntercepter() { return 'body-dedupe-role'; },
    async unregisterBodyIntercepter() { return true; },
    async onUnload() { return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getDatabase() { return { personas: [], selectedPersona: null, modules: [], enabledModules: [], moduleIntergration: [], characters: [clone(char)] }; },
    pluginStorage: { async getItem(k) { return pluginStorage.has(k) ? pluginStorage.get(k) : null; }, async setItem(k, v) { pluginStorage.set(k, String(v)); return true; }, async removeItem(k) { pluginStorage.delete(k); return true; } },
    safeLocalStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; } },
    async getLocalPluginStorage() { return { async getItem() { return null; }, async setItem() { return true; } }; },
    async nativeFetch() { throw new Error('nativeFetch should not be called in route test'); }
  };
  let code = fs.readFileSync(DIST, 'utf8');
  const exportSnippet = `\n;globalThis.__LIBRA_DEDUPE_ROLE_TEST__ = {\n` +
    `MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,\n` +
    `LLMProvider: typeof LLMProvider !== 'undefined' ? LLMProvider : null,\n` +
    `DEFAULT_LLM_ROUTE_PROFILES: typeof DEFAULT_LLM_ROUTE_PROFILES !== 'undefined' ? DEFAULT_LLM_ROUTE_PROFILES : null,\n` +
    `resolveLLMRouteProfile: typeof resolveLLMRouteProfile !== 'undefined' ? resolveLLMRouteProfile : null,\n` +
    `buildFastAnalysisProfile: typeof buildFastAnalysisProfile !== 'undefined' ? buildFastAnalysisProfile : null,\n` +
    `WorldAdditionalCore: typeof WorldAdditionalCore !== 'undefined' ? WorldAdditionalCore : null\n` +
    `};\n`;
  const idx = code.lastIndexOf('\n})();');
  if (idx < 0) throw new Error('Could not locate final IIFE close');
  code = code.slice(0, idx) + exportSnippet + code.slice(idx);
  const logs = [];
  const context = {
    console: { log: (...a) => logs.push(['log', ...a.map(String)]), warn: (...a) => logs.push(['warn', ...a.map(String)]), error: (...a) => logs.push(['error', ...a.map(String)]), debug: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, performance, crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async () => { throw new Error('fetch should not be called'); }, risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'), btoa: (s) => Buffer.from(String(s), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  let evalError = '';
  try { const result = vm.runInContext(code, context, { filename: DIST, timeout: 10000 }); if (result && typeof result.then === 'function') await result; }
  catch (e) { evalError = e?.stack || e?.message || String(e); }
  await new Promise(r => setTimeout(r, 80));
  return { api: context.__LIBRA_DEDUPE_ROLE_TEST__, evalError, logs, char, chat };
}

(async () => {
  const env = await loadLibra();
  const api = env.api || {};
  const assertions = [];
  assertions.push(assert('plugin_eval_no_error', !env.evalError, { error: env.evalError }));
  assertions.push(assert('route_helpers_exported', !!api.buildFastAnalysisProfile && !!api.resolveLLMRouteProfile && !!api.DEFAULT_LLM_ROUTE_PROFILES, {}));
  const cfg = api.MemoryEngine?.CONFIG || {};
  cfg.useLLM = true;
  cfg.llm = { ...(cfg.llm || {}), provider: 'custom_openai', url: 'http://mock.local/v1/chat/completions', key: 'dummy-key', model: 'mock-primary' };
  cfg.auxLlm = { ...(cfg.auxLlm || {}), enabled: true, provider: 'custom_openai', url: 'http://mock.local/v1/chat/completions', key: 'dummy-key', model: 'mock-aux' };
  const tasks = {
    turnCanonicalPacket: 'aux',
    coldStartChunkSummary: 'aux',
    sectionWorldInference: 'aux',
    characterStateConsolidation: 'aux',
    worldStateConsolidation: 'aux',
    liveExtraction: 'aux',
    worldCodex: 'aux',
    guiWorldReanalysis: 'aux',
    guiEntityReanalysis: 'aux',
    guiNarrativeReanalysis: 'aux',
    coldStartFinalSynthesis: 'primary',
    mergeVerification: 'primary',
    turnMaintenanceBundle: 'primary',
    storyAuthor: 'primary',
    director: 'primary'
  };
  const routes = {};
  for (const [task, expected] of Object.entries(tasks)) {
    const defaultResolved = api.buildFastAnalysisProfile(cfg, { routeKey: task, fallbackProfile: expected }).profile;
    assertions.push(assert(`route_${task}_uses_global_default`, defaultResolved === 'primary', { expected: 'primary', resolved: defaultResolved }));
    cfg.llmRouting = { ...(cfg.llmRouting || {}), [task]: expected };
    const explicitResolved = api.buildFastAnalysisProfile(cfg, { routeKey: task, fallbackProfile: expected }).profile;
    routes[task] = explicitResolved;
    assertions.push(assert(`route_${task}_explicit_${expected}`, explicitResolved === expected, { expected, resolved: explicitResolved }));
  }
  api.WorldAdditionalCore.resetState?.();
  api.WorldAdditionalCore.refreshWorldCodexFromContext?.({
    turn: 1,
    worldPrompt: '존재/비존재 체계: 마법이 존재한다. 시스템/사회 체계: 길드가 있다.',
    worldStatePrompt: '활성 위치는 루멘 아카데미 중앙정원이다.',
    narrativePrompt: '별핵 연구 금지 규칙이 갈등으로 작동한다.'
  }, cfg);
  const worldCodexPrompt = api.WorldAdditionalCore.formatWorldCodexForPrompt?.(1000, {
    uniqueAgainst: ['존재/비존재 체계: 마법이 존재한다. 시스템/사회 체계: 길드가 있다.', '활성 위치는 루멘 아카데미 중앙정원이다.', '별핵 연구 금지 규칙이 갈등으로 작동한다.'].join('\n'),
    maxItems: 8
  }) || '';
  assertions.push(assert('world_codex_dedupe_keeps_only_unique', !/존재\/비존재 체계: 마법이 존재한다/.test(worldCodexPrompt), { worldCodexPrompt }));
  assertions.push(assert('world_codex_still_available_when_unique', worldCodexPrompt === '' || /월식|시간 잠금|별핵/i.test(worldCodexPrompt), { worldCodexPrompt }));
  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions, routes, worldCodexPrompt }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
