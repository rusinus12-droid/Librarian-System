// Flashback end-to-end recall harness.
// Extends the read-only base harness contract: installs a fake RisuAI v3 host,
// loads Flashback_Memory.js UNMODIFIED, then DRIVES a Korean conversation through
// the registered hooks and proves store+recall works. Prints a JSON report.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const PLUGIN_PATH = process.argv[2];
if (!PLUGIN_PATH) { console.error('no plugin path'); process.exit(2); }

// ---------- crash capture ----------
const captured = { uncaught: [], unhandled: [] };
process.on('uncaughtException', (err) => {
  captured.uncaught.push({ message: String(err && err.message || err), stack: err && err.stack || null });
});
process.on('unhandledRejection', (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  captured.unhandled.push({ message: String(e.message), stack: e.stack || null });
});

const record = {
  hooks: { chatListeners: [], replacers: [], scriptHandlers: [] },
  network: { nativeFetch: 0, risuFetch: 0, lastUrls: [] },
  llm: { calls: 0 },
  consoleErrors: [],
};

// Captured handler references (base harness only counted them; we need to CALL them).
const handlers = {
  beforeRequest: [],
  afterRequest: [],
  chatOutput: [],       // 'output' listeners
  scriptOutput: [],     // addRisuScriptHandler('output', fn)
};

// ---------- parse //@arg defaults ----------
function parseArgs(src) {
  const args = {};
  const head = src.slice(0, 20000);
  const re = /^\s*\/\/@arg\s+(\S+)\s+(\S+)\s*(.*)$/gm;
  let m;
  while ((m = re.exec(head))) {
    const [, name, type, desc] = m;
    const blank = /blank uses ([^;.\n]+)/i.exec(desc || '');
    let val = '';
    if (blank) val = blank[1].trim();
    else if (type === 'int') val = 0;
    args[name] = (type === 'int' && val !== '') ? Number(val) : val;
  }
  return args;
}

// ---------- async Map-backed pluginStorage ----------
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

const src = fs.readFileSync(PLUGIN_PATH, 'utf8');
const args = parseArgs(src);
// Hash embeddings are migration-only. Exercise the current configured model
// boundary using a deterministic offline HTTP adapter; real owner retrieval and
// the original planted-fact assertions remain unchanged.
args['embedding_provider'] = process.env.FLASHBACK_HARNESS_LEGACY_HASH === '1' ? 'hash' : 'openai_compat';
args['embedding_model'] = 'offline-harness-vector-v1';
args['embedding_url'] = 'https://fixture.invalid/v1';
args['embedding_dimensions'] = 3;
args['embedding_key'] = 'offline-fixture-key';
args['mode'] = 'normal';
args['enable_gui'] = 'false';
args['debug_log'] = 'false';
args['operation_log_enabled'] = 'true';

const pluginStorage = makeStorage();
const safeLocalStorage = makeStorage();
const localPluginStorage = makeLocalPluginStorage();

const noop = async () => {};
const uiId = (() => { let n = 0; return () => `uipart_${++n}`; })();

// ---------- mutable live chat state (THE conversation) ----------
// Native RisuAI shape: message = { role: 'user'|'char', data: <string>, chatId: <stable id> }
let msgSeq = 0;
const liveChat = { id: 'chat-e2e-0', name: 'E2E Korean Chat', message: [], fmIndex: -1 };
const fakeChar = {
  name: '사서', chaId: 'char-e2e-0', id: 'char-e2e-0',
  description: 'E2E fixture character', chatPage: 0,
  chats: [liveChat],
  chat: liveChat,
};
function pushMsg(role, data) {
  const chatId = `m-${++msgSeq}`;
  liveChat.message.push({ role, data, chatId });
  return chatId;
}

const Risuai = {
  apiVersion: '3.0',
  apiVersionCompatibleWith: ['3.0'],

  getArgument: async (k) => (k in args ? args[k] : undefined),
  getArg: async (k) => (k in args ? args[k] : undefined),
  setArgument: async (k, v) => { args[k] = v; return true; },
  setArg: async (k, v) => { args[k] = v; return true; },

  pluginStorage,
  safeLocalStorage,
  getLocalPluginStorage: async () => localPluginStorage,

  // hooks: RECORD + CAPTURE handler references
  addRisuChatListener: async (event, handler) => {
    record.hooks.chatListeners.push(String(event));
    if (String(event) === 'output' && typeof handler === 'function') handlers.chatOutput.push(handler);
    return true;
  },
  removeRisuChatListener: async (event, handler) => {
    if (String(event) === 'output') handlers.chatOutput = handlers.chatOutput.filter(h => h !== handler);
    return true;
  },
  addRisuReplacer: async (hook, handler) => {
    record.hooks.replacers.push(String(hook));
    if (String(hook) === 'beforeRequest' && typeof handler === 'function') handlers.beforeRequest.push(handler);
    if (String(hook) === 'afterRequest' && typeof handler === 'function') handlers.afterRequest.push(handler);
    return true;
  },
  removeRisuReplacer: async (hook, handler) => {
    if (String(hook) === 'beforeRequest') handlers.beforeRequest = handlers.beforeRequest.filter(h => h !== handler);
    if (String(hook) === 'afterRequest') handlers.afterRequest = handlers.afterRequest.filter(h => h !== handler);
    return true;
  },
  addRisuScriptHandler: async (mode, handler) => {
    record.hooks.scriptHandlers.push(String(mode));
    if (String(mode) === 'output' && typeof handler === 'function') handlers.scriptOutput.push(handler);
    return true;
  },
  removeRisuScriptHandler: async () => true,
  addTTSPreprocessor: async () => true,
  addTTSPostprocessor: async () => true,

  registerSetting: async () => ({ id: uiId() }),
  registerButton: async () => ({ id: uiId() }),
  unregisterUIPart: async () => true,
  showContainer: noop, hideContainer: noop,

  onUnload: async (fn) => { Risuai.__onUnload = fn; return true; },
  loadPlugins: noop,

  addPluginChannelListener: async () => (() => {}),
  removePluginChannelListener: async () => true,
  unregisterPluginChannelListener: async () => true,
  postPluginChannelMessage: async () => null,
  sendPluginChannelMessage: async () => null,

  // network BLOCKED + recorded
  nativeFetch: async (url, init = {}) => {
    record.network.nativeFetch++; record.network.lastUrls.push(String(url));
    if (String(url) !== 'https://fixture.invalid/v1/embeddings') throw new Error('UNEXPECTED_HARNESS_NETWORK_ENDPOINT');
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const body = JSON.parse(String(init.body || '{}'));
    if (body.model !== 'offline-harness-vector-v1') throw new Error('UNEXPECTED_HARNESS_MODEL');
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    if (!inputs.length || inputs.some(text => typeof text !== 'string' || !text.trim())) throw new Error('INVALID_HARNESS_EMBEDDING_INPUT');
    // Uniform vectors intentionally provide no lexical ranking clues. Owner
    // sparse search, worldline gates and actual prompt delivery choose the facts.
    return new Response(JSON.stringify({data:inputs.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});
  },
  risuFetch: async (url) => {
    record.network.risuFetch++; record.network.lastUrls.push(String(url));
    const e = new Error('network blocked by harness'); e.code = 'HARNESS_NET_BLOCKED'; throw e;
  },

  runLLMModel: async () => { record.llm.calls++; return { content: '[[HARNESS_FAKE_LLM_OUTPUT]]', model: 'harness-fake', finishReason: 'stop' }; },

  getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'node-harness', saveMethod: 'memory' }),

  // ---- live chat access: ALL return the same mutable liveChat/fakeChar ----
  getCharacter: async () => fakeChar,
  getChar: async () => fakeChar,
  setCharacter: noop, setChar: noop,
  getCharacterFromIndex: async () => fakeChar,
  setCharacterToIndex: noop,
  getCurrentCharacterIndex: async () => 0,
  getCurrentChatIndex: async () => 0,
  getChatFromIndex: async () => liveChat,
  setChatToIndex: async (_c, _i, chat) => { if (chat && Array.isArray(chat.message)) { liveChat.message = chat.message; } return true; },
  getDatabase: async () => null,
  setDatabase: noop, setDatabaseLite: noop,

  getRootDocument: async () => null,
  createMutationObserver: async () => ({ observe: () => {}, disconnect: () => {} }),

  addProvider: async () => true,
  registerMCP: async () => true,
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

globalThis.Risuai = Risuai;
globalThis.RisuAI = Risuai;
globalThis.risuai = Risuai;
globalThis.risuApi = Risuai;
globalThis.risuAPI = Risuai;
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

const {installConsoleErrorCapture} = require('./harness_console_capture.cjs');
const origErr = installConsoleErrorCapture(record);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// helper: extract injected text from returned messages that isn't in the input
function joinContent(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
  return String(m.content || '');
}
function totalChars(msgs) { return (msgs || []).reduce((n, m) => n + joinContent(m).length, 0); }

// ---------- driver ----------
const steps = [];
const stepLog = (name, ok, detail) => { steps.push({ name, ok, detail: detail || '' }); };

async function callBefore(messages, type = 'model') {
  let out = messages;
  for (const fn of handlers.beforeRequest) {
    out = await fn(out, type);
    if (!Array.isArray(out)) out = messages; // defensive
  }
  return out;
}
async function callAfter(content, type = 'model') {
  let out = content;
  for (const fn of handlers.afterRequest) {
    const r = await fn(out, type);
    if (typeof r === 'string') out = r;
  }
  return out;
}
async function fireOutput(messageIndex) {
  const arg = { char: fakeChar, chat: liveChat, characterIndex: 0, chatIndex: 0, messageIndex };
  for (const fn of handlers.chatOutput) { await fn(arg); }
  for (const fn of handlers.scriptOutput) { try { await fn(liveChat.message[messageIndex] && liveChat.message[messageIndex].data || '', 'output'); } catch (_) {} }
}

// One full turn: user says U, we run beforeRequest (prompt incl. U), model produces A,
// append A to live chat, run afterRequest, fire output listener to finalize the U+A turn.
async function runTurn(U, A, opts = {}) {
  // 1. append user message to live chat (visible before generation)
  pushMsg('user', U);
  // 2. build prompt messages (system + full visible transcript as user/assistant)
  const promptMessages = [{ role: 'system', content: '너는 사서 캐릭터다.' }];
  for (const m of liveChat.message) {
    promptMessages.push({ role: m.role === 'char' ? 'assistant' : 'user', content: m.data });
  }
  const before = await callBefore(promptMessages, 'model');
  // 3. model produced A -> append as char and finalize
  pushMsg('char', A);
  const aIndex = liveChat.message.length - 1;
  await callAfter(A, 'model');
  await fireOutput(aIndex);
  await sleep(opts.settle || 250);
  return { before, aIndex };
}

async function drive() {
  // wait for async IIFE + hook registration to settle
  await sleep(1500);
  stepLog('plugin_load', !captured.uncaught.length, `uncaught=${captured.uncaught.length}`);
  stepLog('hooks_registered',
    handlers.beforeRequest.length > 0 && handlers.afterRequest.length > 0,
    `before=${handlers.beforeRequest.length} after=${handlers.afterRequest.length} chatOutput=${handlers.chatOutput.length} scriptOutput=${handlers.scriptOutput.length}`);

  // ------- 7-turn Korean conversation planting concrete facts -------
  const turns = [
    ['안녕, 지하 서고를 조사하고 싶어.', '어서 오세요. 지하 서고는 오래된 기록으로 가득합니다. 무엇을 찾으시나요?'],
    ['지하 서고에서 붉은 표지의 장부를 발견했어.', '붉은 표지의 장부군요. 그것은 옛 관리인이 남긴 회계 기록입니다. 조심히 다루세요.'],
    ['유나가 은열쇠를 나에게 줘서 지하 서고만 열 수 있게 됐어.', '유나가 은열쇠를 건넸다니 신뢰의 표시네요. 이제 당신만이 지하 서고를 열 수 있습니다.'],
    ['그 붉은 장부 안에 숨겨진 돈의 위치가 적혀 있었어.', '돈의 위치가 장부에 적혀 있었군요. 그 정보는 매우 중요하니 아무에게도 말하지 마세요.'],
    ['정말 놀랐어 😲🔑 은열쇠가 이렇게 중요할 줄이야.', '놀라셨군요 😊 은열쇠는 이 서고의 유일한 통로를 여는 물건입니다.'],
    ['돈은 어디 있어?', '장부에 따르면 돈은 지하 서고 세 번째 서가 뒤의 벽 금고에 숨겨져 있습니다.'],
    ['고마워. 내일 다시 올게.', '언제든 환영합니다. 은열쇠를 잘 간수하세요.'],
  ];

  for (let i = 0; i < turns.length; i++) {
    await runTurn(turns[i][0], turns[i][1], { settle: 280 });
  }
  await sleep(600); // let background flush settle

  const storeKeysAfterConversation = [...pluginStorage.__map.keys()];
  stepLog('conversation_driven', true, `turns=${turns.length} storeKeys=${storeKeysAfterConversation.length} liveMsgs=${liveChat.message.length}`);

  // ------- RECALL: new user query that should pull back planted facts -------
  async function recallProbe(query) {
    // Represent a fresh request whose trailing user message is the query,
    // built from the current visible transcript + the new query.
    const base = [{ role: 'system', content: '너는 사서 캐릭터다.' }];
    for (const m of liveChat.message) base.push({ role: m.role === 'char' ? 'assistant' : 'user', content: m.data });
    // append the pending user query (not yet in live chat, as during beforeRequest)
    const withQuery = base.concat([{ role: 'user', content: query }]);
    const beforeChars = totalChars(withQuery);
    const out = await callBefore(withQuery, 'model');
    const afterChars = totalChars(out);
    // find injected text = content present in out not present in input
    const inputSet = new Set(withQuery.map(joinContent));
    let injectedText = '';
    for (const m of out) {
      const c = joinContent(m);
      if (!inputSet.has(c)) injectedText += '\n' + c;
    }
    return {
      query,
      inputMsgCount: withQuery.length,
      outputMsgCount: Array.isArray(out) ? out.length : -1,
      beforeChars, afterChars, grew: afterChars > beforeChars,
      injectedTextLen: injectedText.length,
      injectedText: injectedText.slice(0, 4000),
      contains: {
        유나: injectedText.includes('유나'),
        은열쇠: injectedText.includes('은열쇠'),
        붉은: injectedText.includes('붉은'),
        장부: injectedText.includes('장부'),
        금고: injectedText.includes('금고'),
      },
    };
  }

  const recallSilver = await recallProbe('은열쇠 누가 줬지?');
  await sleep(200);
  const recallMoney1 = await recallProbe('돈');           // 1-char Korean query test
  await sleep(200);
  const recallMoneyFull = await recallProbe('돈은 어디 있어?');

  stepLog('recall_injection_silverkey', recallSilver.grew && recallSilver.contains.은열쇠, JSON.stringify(recallSilver.contains));
  stepLog('recall_singlechar_don', recallMoney1.grew, `grew=${recallMoney1.grew} injLen=${recallMoney1.injectedTextLen}`);

  // ------- storage sample: show a stored raw U+A survives -------
  const storeKeys = [...pluginStorage.__map.keys()];
  const storeSizes = storeKeys.map(k => ({ key: k, size: (pluginStorage.__map.get(k) || '').length }));
  // find a shard-ish key holding raw text and sample it for planted facts
  let rawSample = null;
  for (const k of storeKeys) {
    if (!/records:commit/.test(k)) continue;
    const v = pluginStorage.__map.get(k) || '';
    if (v.includes('은열쇠') || v.includes('금고')) {
      // check the FULL long assistant bodies survive verbatim (untruncated)
      rawSample = {
        key: k, size: v.length,
        fullMoneyAnswerPresent: v.includes('지하 서고 세 번째 서가 뒤의 벽 금고에 숨겨져 있습니다'),
        fullSilverKeyPresent: v.includes('이제 당신만이 지하 서고를 열 수 있습니다'),
        emojiPairPresent: v.includes('😲') && v.includes('🔑') && v.includes('😊'),
        snippet: v.slice(0, 1200),
      };
      break;
    }
  }

  const diag = (globalThis.__librarianDiag && typeof globalThis.__librarianDiag.snapshot === 'function')
    ? globalThis.__librarianDiag.snapshot() : null;

  console.error = origErr;
  const out = {
    plugin: path.basename(PLUGIN_PATH),
    uncaught: captured.uncaught,
    unhandledRejection: captured.unhandled,
    consoleErrors: record.consoleErrors.slice(0, 30),
    hooks: record.hooks,
    handlersCaptured: {
      beforeRequest: handlers.beforeRequest.length,
      afterRequest: handlers.afterRequest.length,
      chatOutput: handlers.chatOutput.length,
      scriptOutput: handlers.scriptOutput.length,
    },
    network: record.network,
    llm: record.llm,
    steps,
    liveChatMessageCount: liveChat.message.length,
    pluginStorageKeys: storeKeys,
    pluginStorageSizes: storeSizes,
    rawSample,
    recall: {
      silverKey: recallSilver,
      singleCharDon: recallMoney1,
      moneyFull: recallMoneyFull,
    },
    librarianDiag: diag,
  };
  process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify(out, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n');
  process.exit(require('./harness_assertions.cjs').validate("flashback_e2e_harness.js", out) ? 0 : 1);
}

let syncThrow = null;
try {
  vm.runInThisContext(src, { filename: PLUGIN_PATH });
} catch (e) {
  syncThrow = { message: String(e && e.message || e), stack: e && e.stack || null };
}

if (syncThrow) {
  console.error = origErr;
  process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify({ plugin: path.basename(PLUGIN_PATH), syncThrow }, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n');
  process.exit(1);
} else {
  drive().catch((e) => {
    console.error = origErr;
    process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify({ plugin: path.basename(PLUGIN_PATH), driverError: { message: String(e && e.message || e), stack: e && e.stack || null }, steps }, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n');
    process.exit(1);
  });
}
