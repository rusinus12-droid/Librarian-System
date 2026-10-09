// RisuAI fake-host harness — loads ONE MemorySuite plugin per process and reports.
// Usage: node risu_harness.js "<absolute plugin path>"
// The plugin file is NEVER modified; it is read as a string and executed via vm.runInThisContext.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const pluginPath = process.argv[2];
if (!pluginPath) { console.error('no plugin path'); process.exit(2); }

// ---- crash capture: nothing may slip past ----
const captured = { uncaught: [], unhandled: [] };
process.on('uncaughtException', (err) => {
  captured.uncaught.push({ message: String(err && err.message || err), stack: err && err.stack || null });
});
process.on('unhandledRejection', (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  captured.unhandled.push({ message: String(e.message), stack: e.stack || null });
});

// ---- record of everything the plugin touched on the host ----
const record = {
  hooks: { chatListeners: [], replacers: [], scriptHandlers: [], ttsPre: 0, ttsPost: 0 },
  ui: { settings: [], buttons: [], unregistered: [] },
  ipc: { channels: [] },
  network: { nativeFetch: 0, risuFetch: 0, lastUrls: [] },
  llm: { calls: 0, lastMessages: null },
  providers: [], mcps: [],
  consoleErrors: [],
};

// ---- parse //@arg defaults from the header so getArg returns realistic values ----
function parseArgs(src) {
  const args = {};
  const head = src.slice(0, 20000);
  const re = /^\s*\/\/@arg\s+(\S+)\s+(\S+)\s*(.*)$/gm;
  let m;
  while ((m = re.exec(head))) {
    const [, name, type, desc] = m;
    // "blank uses X" convention → use X as the effective default.
    const blank = /blank uses ([^;.\n]+)/i.exec(desc || '');
    let val = '';
    if (blank) val = blank[1].trim();
    else if (type === 'int') val = 0;
    args[name] = (type === 'int' && val !== '') ? Number(val) : val;
  }
  return args;
}

// ---- Map-backed async pluginStorage (durable, readback-honest) ----
function makeStorage() {
  const map = new Map();
  return {
    __map: map,
    getItem: async (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: async (k, v) => { map.set(String(k), typeof v === 'string' ? v : String(v)); return true; },
    removeItem: async (k) => { map.delete(String(k)); return true; },
    keys: async () => [...map.keys()],
    length: async () => map.size,
    clear: async () => { map.clear(); return true; },
  };
}
// getLocalPluginStorage keeps structured values (JSON) per docs
function makeLocalPluginStorage() {
  const map = new Map();
  return {
    __map: map,
    getItem: async (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: async (k, v) => { map.set(String(k), v); return true; },
    removeItem: async (k) => { map.delete(String(k)); return true; },
    keys: async () => [...map.keys()],
    clear: async () => { map.clear(); return true; },
  };
}

const src = fs.readFileSync(pluginPath, 'utf8');
const args = parseArgs(src);
const pluginStorage = makeStorage();
const safeLocalStorage = makeStorage();
const localPluginStorage = makeLocalPluginStorage();

const noop = async () => {};
const uiId = (() => { let n = 0; return () => `uipart_${++n}`; })();

// A minimal but faithful character/chat so getCharacter()/getChatFromIndex don't NPE.
const fakeChar = {
  name: 'Harness Character', description: 'fake', chatPage: 0,
  chats: [{ message: [], name: 'chat-0' }],
  chat: { message: [], name: 'chat-0' },
};

const Risuai = {
  apiVersion: '3.0',
  apiVersionCompatibleWith: ['3.0'],

  // --- arguments ---
  getArgument: async (k) => (k in args ? args[k] : undefined),
  getArg: async (k) => (k in args ? args[k] : undefined),
  setArgument: async (k, v) => { args[k] = v; return true; },
  setArg: async (k, v) => { args[k] = v; return true; },

  // --- storage ---
  pluginStorage,
  safeLocalStorage,
  getLocalPluginStorage: async () => localPluginStorage,

  // --- hooks (register-only) ---
  addRisuChatListener: async (event, handler) => { record.hooks.chatListeners.push(String(event)); return true; },
  removeRisuChatListener: async () => true,
  addRisuReplacer: async (hook, handler) => { record.hooks.replacers.push(String(hook)); return true; },
  removeRisuReplacer: async () => true,
  addRisuScriptHandler: async (mode, handler) => { record.hooks.scriptHandlers.push(String(mode)); return true; },
  removeRisuScriptHandler: async () => true,
  addTTSPreprocessor: async () => { record.hooks.ttsPre++; return true; },
  addTTSPostprocessor: async () => { record.hooks.ttsPost++; return true; },

  // --- UI (no-op register, but return an id like the real host) ---
  registerSetting: async (name) => { const id = uiId(); record.ui.settings.push({ name: String(name), id }); return { id }; },
  registerButton: async (opts) => { const id = uiId(); record.ui.buttons.push({ name: String(opts && opts.name || ''), id }); return { id }; },
  unregisterUIPart: async (id) => { record.ui.unregistered.push(String(id)); return true; },
  showContainer: noop, hideContainer: noop,

  // --- lifecycle ---
  onUnload: async (fn) => { Risuai.__onUnload = fn; return true; },
  loadPlugins: noop,

  // --- IPC (allowed-ipc flashback_hayaku_bridge) ---
  addPluginChannelListener: async (channel, handler) => { record.ipc.channels.push(String(channel)); return () => {}; },
  removePluginChannelListener: async () => true,
  unregisterPluginChannelListener: async () => true,
  postPluginChannelMessage: async () => null,
  sendPluginChannelMessage: async () => null,

  // --- network: BLOCKED, chain recorded ---
  nativeFetch: async (url, opts) => {
    record.network.nativeFetch++; record.network.lastUrls.push(String(url));
    const e = new Error('network blocked by harness'); e.code = 'HARNESS_NET_BLOCKED';
    throw e;
  },
  risuFetch: async (url, opts) => {
    record.network.risuFetch++; record.network.lastUrls.push(String(url));
    const e = new Error('network blocked by harness'); e.code = 'HARNESS_NET_BLOCKED';
    throw e;
  },

  // --- LLM: recorded, canned deterministic output ---
  runLLMModel: async (req) => {
    record.llm.calls++;
    try { record.llm.lastMessages = (req && req.messages) ? req.messages.length : null; } catch (_) {}
    return { content: '[[HARNESS_FAKE_LLM_OUTPUT]]', model: 'harness-fake', usage: null, finishReason: 'stop' };
  },

  // --- data access ---
  getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'node-harness', saveMethod: 'memory' }),
  getCharacter: async () => JSON.parse(JSON.stringify(fakeChar)),
  getChar: async () => JSON.parse(JSON.stringify(fakeChar)),
  setCharacter: noop, setChar: noop,
  getCharacterFromIndex: async () => JSON.parse(JSON.stringify(fakeChar)),
  setCharacterToIndex: noop,
  getCurrentCharacterIndex: async () => 0,
  getCurrentChatIndex: async () => 0,
  getChatFromIndex: async () => ({ message: [], name: 'chat-0' }),
  setChatToIndex: noop,
  getDatabase: async () => null, // simulates "no db consent" — plugins must handle this
  setDatabase: noop, setDatabaseLite: noop,

  // --- DOM: return null so plugins take their headless/no-DOM path ---
  getRootDocument: async () => null,
  createMutationObserver: async () => ({ observe: () => {}, disconnect: () => {} }),

  // --- misc registrations ---
  addProvider: async (name) => { record.providers.push(String(name)); return true; },
  registerMCP: async (meta) => { record.mcps.push(meta && meta.identifier || ''); return true; },
  unregisterMCP: noop,
  registerBodyIntercepter: async () => ({ id: uiId() }),
  unregisterBodyIntercepter: noop,
  requestPluginPermission: async () => true,
  getFetchLogs: async () => [],
  readImage: async () => null, saveAsset: async () => null, readInlay: async () => null,
  unwarpSafeArray: async (a) => (Array.isArray(a) ? a : []),
  searchTranslationCache: async () => [], getTranslationCache: async () => null,
  changeColorScheme: noop, getColorScheme: async () => ({ name: 'dark', scheme: {} }),
  setColorScheme: noop, changeTextTheme: noop,
  getTextTheme: async () => ({ name: 'standard', customTheme: {} }), setCustomTextTheme: noop,
};

// Expose under every alias the plugins probe for.
globalThis.Risuai = Risuai;
globalThis.RisuAI = Risuai;
globalThis.risuai = Risuai;
globalThis.risuApi = Risuai;
globalThis.risuAPI = Risuai;

// Minimal browser-ish globals some code paths may touch when no DOM.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

// Capture console.error (plugins log swallowed errors there too).
const {installConsoleErrorCapture} = require('./harness_console_capture.cjs');
const origErr = installConsoleErrorCapture(record);

let syncThrow = null;
try {
  // Execute the plugin exactly as-is; the file's own IIFE runs on eval.
  vm.runInThisContext(src, { filename: pluginPath });
} catch (e) {
  syncThrow = { message: String(e && e.message || e), stack: e && e.stack || null };
}

// Let the async IIFE + microtasks + short timers settle.
setTimeout(() => {
  console.error = origErr;
  const diag = (globalThis.__librarianDiag && typeof globalThis.__librarianDiag.snapshot === 'function')
    ? globalThis.__librarianDiag.snapshot() : null;

  const exposedGlobals = Object.getOwnPropertyNames(globalThis)
    .filter((k) => /^__(LIBRA|HAYAKU|Flashback|librarian|MemorySuite)/i.test(k) || /LIBRA|HAYAKU|Flashback/i.test(k))
    .filter((k) => !['RisuAI'].includes(k))
    .slice(0, 60);

  const out = {
    plugin: path.basename(pluginPath),
    syncThrow,
    uncaught: captured.uncaught,
    unhandledRejection: captured.unhandled,
    hooks: record.hooks,
    ui: record.ui,
    ipc: record.ipc,
    network: record.network,
    llm: record.llm,
    providers: record.providers,
    mcps: record.mcps,
    consoleErrors: record.consoleErrors.slice(0, 20),
    exposedGlobals,
    pluginStorageKeys: [...pluginStorage.__map.keys()],
    safeLocalStorageKeys: [...safeLocalStorage.__map.keys()],
    localPluginStorageKeys: [...localPluginStorage.__map.keys()],
    librarianDiag: diag,
    argsParsed: args,
  };
  process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify(out, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n');
  process.exit(require('./harness_assertions.cjs').validate("risu_plugin_harness.js", out) ? 0 : 1);
}, 2500);
