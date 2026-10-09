'use strict';
// Gate: plugin init must COMPLETE, not merely "not throw visibly".
// Motivation (real defect): a deleted interop function was still called from the init IIFE.
// The whole init body sits inside try{}catch{}, so the ReferenceError was swallowed and
// every downstream bootstrap step (session id, scope key, lore index rebuild, turn anchor,
// secret-knowledge load) was silently skipped — yet the 97-turn harness still reported 37/37.
// This gate asserts the observable RESULT of init (session bootstrap), so a failing init
// can never again pass as green.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.LIBRA_INIT_GATE_TARGET
  ? path.resolve(process.env.LIBRA_INIT_GATE_TARGET)
  : path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }

(async () => {
  const pluginStorage = new Map();
  const chat = { id: 'init-gate-chat', name: 'Init Gate', localLore: [], msgs: [], message: [] };
  const char = { id: 'init-gate-char', name: 'Init Gate Char', chatPage: 0, chats: [chat], lorebook: [], description: 'init gate.' };
  const args = new Map(Object.entries({
    debug: 'true',
    llm_provider: 'custom_openai',
    llm_url: 'http://mock.local/v1/chat/completions',
    llm_key: 'k',
    llm_model: 'm',
    embedding_enabled: 'false',
    activity_dashboard: 'off'
  }));
  const risuai = {
    apiVersion: '3.0-test',
    async getRuntimeInfo() { return { apiVersion: '3.0-test', platform: 'node-test', saveMethod: 'mock' }; },
    async getArgument(n) { return args.get(n); },
    async requestPluginPermission() { return true; },
    async getCharacter() { return clone(char); },
    async getCurrentCharacterIndex() { return 0; },
    async getCharacterFromIndex() { return clone(char); },
    async getChatFromIndex() { return clone(chat); },
    async setChatToIndex(_a, _b, next) { Object.assign(chat, clone(next)); return true; },
    async setCharacter(next) { Object.assign(char, clone(next)); return true; },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async registerBodyIntercepter() { return 'body-init-gate'; },
    async unregisterBodyIntercepter() { return true; },
    async onUnload() { return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getDatabase() { return { personas: [], selectedPersona: null, modules: [], enabledModules: [], moduleIntergration: [], characters: [clone(char)] }; },
    pluginStorage: {
      async getItem(k) { return pluginStorage.has(k) ? pluginStorage.get(k) : null; },
      async setItem(k, v) { pluginStorage.set(k, String(v)); return true; },
      async removeItem(k) { pluginStorage.delete(k); return true; }
    },
    safeLocalStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; } },
    async getLocalPluginStorage() { return { async getItem() { return null; }, async setItem() { return true; } }; },
    async nativeFetch() { throw new Error('nativeFetch should not be called'); }
  };

  let code = fs.readFileSync(DIST, 'utf8');
  const exportSnippet = '\n;globalThis.__INIT_GATE__ = {\n'
    + "MemoryState: typeof MemoryState !== 'undefined' ? MemoryState : null,\n"
    + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,\n"
    + "getStableChatScopeKey: typeof getStableChatScopeKey !== 'undefined' ? getStableChatScopeKey : null,\n"
    + '};\n';
  const idx = code.lastIndexOf('\n})();');
  if (idx < 0) throw new Error('Could not locate final IIFE close');
  code = code.slice(0, idx) + exportSnippet + code.slice(idx);

  const captured = [];
  const push = (level, a) => captured.push({
    level,
    text: a.map(x => (typeof x === 'string' ? x : (x && x.message) ? x.message : String(x))).join(' ')
  });
  const context = {
    console: { log: (...a) => push('log', a), warn: (...a) => push('warn', a), error: (...a) => push('error', a), info: (...a) => push('info', a), debug: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID, getRandomValues: crypto.getRandomValues },
    AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async () => { throw new Error('fetch should not be called'); },
    risuai, Risuai: risuai, process: { env: {} }
  };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  vm.createContext(context);

  const assertions = [];
  let bootError = null;
  try {
    vm.runInContext(code, context, { filename: DIST, timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {
    bootError = e;
  }

  const api = context.__INIT_GATE__ || {};
  const st = api.MemoryState || {};

  assertions.push(assert('bundle_evaluates_without_throwing', !bootError, { error: bootError ? String(bootError.message || bootError) : '' }));
  assertions.push(assert('memory_engine_constructed', !!api.MemoryEngine));

  // Init emits an explicit error line via recordRuntimeDebug if its try/catch is entered.
  const initErrors = captured.filter(c => /Init Error/i.test(c.text));
  assertions.push(assert('init_reported_no_error', initErrors.length === 0, { initErrors: initErrors.map(c => c.text.slice(0, 240)) }));

  // The real signal: init must have reached past its awaits and bootstrapped the session.
  assertions.push(assert('init_completed_session_bootstrap', !!st.currentSessionId, {
    currentSessionId: st.currentSessionId || null
  }));
  assertions.push(assert('init_resolved_active_scope_key', !!st._activeScopeKey, {
    activeScopeKey: st._activeScopeKey || null
  }));
  assertions.push(assert('init_bound_active_chat', !!st._activeChatId, {
    activeChatId: st._activeChatId || null
  }));

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({
    ok,
    artifact: path.relative(ROOT, DIST),
    assertions
  }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.log(JSON.stringify({
    ok: false,
    assertions: [{ name: 'gate_harness_crashed', ok: false, details: { error: String(e && e.stack || e) } }]
  }, null, 2));
  process.exit(1);
});
