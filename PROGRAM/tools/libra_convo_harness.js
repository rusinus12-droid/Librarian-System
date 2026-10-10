// LIBRA canonical-memory execution harness (SUCCESS path) — drives a 6-turn Korean
// conversation across the 5-turn boundary, lets the fake host answer the analysis LLM
// with a valid { type:'success', result } contract, then probes recall and isolates the
// canonical-memory-derived injection from raw Live Tail echo.
// Original plugin + tools-folder harnesses are NOT modified. Standalone extension.
// Usage: node libra_convo_harness.js "<absolute plugin path>"
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const pluginPath = process.argv[2];
if (!pluginPath) { console.error('no plugin path'); process.exit(2); }

const captured = { uncaught: [], unhandled: [] };
process.on('uncaughtException', (err) => { captured.uncaught.push({ message: String(err && err.message || err), stack: err && err.stack || null }); });
process.on('unhandledRejection', (reason) => { const e = reason instanceof Error ? reason : new Error(String(reason)); captured.unhandled.push({ message: String(e.message), stack: e.stack || null }); });

const FAIL_MODE = process.env.LIBRA_FAIL_MODE === '1';

const record = {
  hooks: { chatListeners: [], replacers: [], scriptHandlers: [] },
  handlers: { beforeRequest: null, afterRequest: null, chatOutput: null, script: {} },
  llm: { calls: 0, lastMessagesLen: null, requests: [], modes: [] },
  network: { blocked: 0, urls: [] },
  consoleErrors: [],
};

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

const src = fs.readFileSync(pluginPath, 'utf8');

function parseArgs(s) {
  const args = {}; const head = s.slice(0, 20000);
  const re = /^\s*\/\/@arg\s+(\S+)\s+(\S+)\s*(.*)$/gm; let m;
  while ((m = re.exec(head))) {
    const [, name, type, desc] = m;
    const blank = /blank uses ([^;.\n]+)/i.exec(desc || '');
    let val = ''; if (blank) val = blank[1].trim(); else if (type === 'int') val = 0;
    args[name] = (type === 'int' && val !== '') ? Number(val) : val;
  }
  return args;
}
const args = parseArgs(src);
// Force offline-safe embedding hash mode so recall's dense path works locally with no network.
args.embedding_enabled = 'false';
const pluginStorage = makeStorage();
const safeLocalStorage = makeStorage();
const localPluginStorage = makeLocalPluginStorage();

const noop = async () => {};
const uiId = (() => { let n = 0; return () => `uipart_${++n}`; })();

const CHA_ID = 'libra_char_stable_001';
const CHAT_ID = 'libra_chat_stable_001';
const liveMessages = [];
const liveChat = { id: CHAT_ID, name: 'chat-live', message: liveMessages };
const liveCharacter = {
  name: 'LIBRA Harness Char', chaId: CHA_ID, id: CHA_ID, description: 'fake', chatPage: 0,
  chats: [liveChat], chat: liveChat,
};
function charView() {
  return { name: liveCharacter.name, chaId: CHA_ID, id: CHA_ID, description: 'fake', chatPage: 0,
    chats: [ { id: CHAT_ID, name: liveChat.name, message: liveMessages } ],
    chat: { id: CHAT_ID, name: liveChat.name, message: liveMessages } };
}
function chatView() { return { id: CHAT_ID, name: liveChat.name, message: liveMessages }; }

let msgSeq = 0;
function pushMessage(role, data) {
  const id = `msg_${++msgSeq}`;
  liveMessages.push({ role, data, id, chatId: CHAT_ID });
  return id;
}

// ---- Analysis-LLM fake output: a VALID libra.canonical_artifact.v4 object built from the
// exact batch transcript the plugin passes (so every evidence quote is an exact source
// substring). Encodes the two planted facts as typed claims: 은열쇠 possession→유나,
// 돈 placement→서재. This satisfies LIBRA's strict validateUnifiedArtifact contract so the
// pipeline actually commits a canonical memory.
function parseBatchTurns(joined) {
  // real transcript row format: [t1-u]\n<user text>\n\n[t1-a]\n<assistant text>\n\n...
  const turns = {};
  const re = /\[t(\d+)-(u|a)\]\n([\s\S]*?)(?=\n\n\[t\d+-[ua]\]|\n*$)/g;
  let m;
  while ((m = re.exec(joined))) {
    const n = Number(m[1]); const role = m[2]; const txt = m[3].trim();
    turns[n] = turns[n] || { user: '', assistant: '' };
    if (role === 'u') turns[n].user = txt; else turns[n].assistant = txt;
  }
  return turns;
}
function firstSentenceContaining(text, needle) {
  // return the shortest exact substring (a clause) of `text` that contains `needle`,
  // clamped to <=320 normalized chars, split on Korean sentence enders.
  const parts = String(text).split(/(?<=[.。!?])\s+/);
  for (const p of parts) if (p.includes(needle) && p.trim().length >= 2 && p.trim().length <= 320) return p.trim();
  // fallback: window around needle
  const i = text.indexOf(needle);
  if (i < 0) return null;
  return text.slice(Math.max(0, i - 10), Math.min(text.length, i + 40)).trim();
}
function analysisResultFor(req) {
  const joined = (req && Array.isArray(req.messages)) ? req.messages.map(m => String(m.content || '')).join('\n') : '';
  const turns = parseBatchTurns(joined);
  const turnNums = Object.keys(turns).map(Number).sort((a, b) => a - b);
  // Determine which batch this is (facts live in turn1 assistant [은열쇠] and turn4 assistant [돈/서재]).
  const entities = [];
  const facts = [];
  const stateBindings = [];

  // Helper: build an evidenceSpan {ref, quote} for a role text if it contains needle.
  const spanFor = (turn, role, needle) => {
    const t = turns[turn];
    if (!t) return null;
    const src = role === 'a' ? t.assistant : t.user;
    const q = firstSentenceContaining(src, needle);
    return q ? { ref: `t${turn}-${role}`, quote: q } : null;
  };

  // 은열쇠 possession: find any turn whose assistant text has both 유나 and 은열쇠.
  let keyTurn = null, moneyTurn = null;
  for (const n of turnNums) {
    const a = turns[n].assistant;
    if (keyTurn === null && a.includes('은열쇠') && a.includes('유나')) keyTurn = n;
    if (moneyTurn === null && a.includes('돈') && a.includes('서재')) moneyTurn = n;
  }

  if (keyTurn !== null) {
    const yunaSpan = spanFor(keyTurn, 'a', '유나');
    const keySpan = spanFor(keyTurn, 'a', '은열쇠');
    if (yunaSpan && keySpan) {
      entities.push({ tempId: 'yuna', name: '유나', type: 'person', evidenceSpans: [yunaSpan] });
      entities.push({ tempId: 'silverkey', name: '은열쇠', type: 'world', kind: 'object', evidenceSpans: [keySpan] });
      facts.push({
        tempFactId: 'fact_possess_key', domain: 'world', subjectTempRef: 'silverkey', claimKind: 'possession',
        values: { holderRef: 'yuna' }, text: '은열쇠는 유나가 소지하고 있다.',
        temporalRole: 'current_sequence', certainty: 'confirmed',
        evidenceSpans: [keySpan, yunaSpan]
      });
      stateBindings.push({ factTempId: 'fact_possess_key', typedValueField: 'holderRef', stateDomain: 'world', stateField: 'holderRef' });
    }
  }
  if (moneyTurn !== null) {
    const moneySpan = spanFor(moneyTurn, 'a', '돈');
    const studySpan = spanFor(moneyTurn, 'a', '서재');
    if (moneySpan && studySpan) {
      entities.push({ tempId: 'money', name: '돈', type: 'world', kind: 'object', evidenceSpans: [moneySpan] });
      entities.push({ tempId: 'study', name: '서재', type: 'world', kind: 'location', evidenceSpans: [studySpan] });
      facts.push({
        tempFactId: 'fact_place_money', domain: 'world', subjectTempRef: 'money', claimKind: 'placement',
        values: { containerRef: 'study' }, text: '돈은 서재에 보관되어 있다.',
        temporalRole: 'current_sequence', certainty: 'confirmed',
        evidenceSpans: [moneySpan, studySpan]
      });
      stateBindings.push({ factTempId: 'fact_place_money', typedValueField: 'containerRef', stateDomain: 'world', stateField: 'containerRef' });
    }
  }

  // If neither planted fact is in this batch (e.g. a later batch), emit a minimal event
  // fact so the artifact still validates (facts must be non-empty).
  if (facts.length === 0 && turnNums.length) {
    const n = turnNums[0];
    const a = turns[n].assistant;
    const firstWord = (a.match(/([가-힣]{2,6})/) || [null, '인물'])[1];
    const span = firstSentenceContaining(a, firstWord) || { quote: a.slice(0, 40) }.quote;
    const q = typeof span === 'string' ? span : span;
    entities.push({ tempId: 'subj', name: firstWord, type: 'world', kind: 'object', evidenceSpans: [{ ref: `t${n}-a`, quote: q }] });
    facts.push({
      tempFactId: 'fact_evt', domain: 'event', subjectTempRef: 'subj', claimKind: 'event',
      values: { detail: q }, text: q, temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [{ ref: `t${n}-a`, quote: q }]
    });
  }

  return JSON.stringify({ schema: 'libra.canonical_artifact.v4', entities, facts, stateBindings });
}

const Risuai = {
  apiVersion: '3.0', apiVersionCompatibleWith: ['3.0'],
  getArgument: async (k) => (k in args ? args[k] : undefined),
  getArg: async (k) => (k in args ? args[k] : undefined),
  setArgument: async (k, v) => { args[k] = v; return true; },
  setArg: async (k, v) => { args[k] = v; return true; },
  pluginStorage, safeLocalStorage,
  getLocalPluginStorage: async () => localPluginStorage,

  addRisuChatListener: async (event, handler) => {
    record.hooks.chatListeners.push(String(event));
    if (String(event) === 'output') record.handlers.chatOutput = handler;
    return true;
  },
  removeRisuChatListener: async () => true,
  addRisuReplacer: async (hook, handler) => {
    record.hooks.replacers.push(String(hook));
    if (String(hook) === 'beforeRequest') record.handlers.beforeRequest = handler;
    if (String(hook) === 'afterRequest') record.handlers.afterRequest = handler;
    return true;
  },
  removeRisuReplacer: async () => true,
  addRisuScriptHandler: async (mode, handler) => {
    record.hooks.scriptHandlers.push(String(mode));
    record.handlers.script[String(mode)] = handler;
    return true;
  },
  removeRisuScriptHandler: async () => true,
  addTTSPreprocessor: noop, addTTSPostprocessor: noop,

  registerSetting: async () => ({ id: uiId() }),
  registerButton: async () => ({ id: uiId() }),
  unregisterUIPart: noop, showContainer: noop, hideContainer: noop,
  onUnload: async (fn) => { Risuai.__onUnload = fn; return true; },
  loadPlugins: noop,
  addPluginChannelListener: async () => (() => {}),
  removePluginChannelListener: async () => true,
  unregisterPluginChannelListener: async () => true,
  postPluginChannelMessage: async () => null,
  sendPluginChannelMessage: async () => null,

  nativeFetch: async (url) => { record.network.blocked++; record.network.urls.push(String(url)); const e = new Error('network blocked by harness'); e.code = 'HARNESS_NET_BLOCKED'; throw e; },
  risuFetch: async (url) => { record.network.blocked++; record.network.urls.push(String(url)); const e = new Error('network blocked by harness'); e.code = 'HARNESS_NET_BLOCKED'; throw e; },

  // RisuAI real contract. SUCCESS: {type:'success', result}. FAIL: {type:'fail', result:<error>}.
  runLLMModel: async (req) => {
    record.llm.calls++;
    try {
      record.llm.lastMessagesLen = (req && req.messages) ? req.messages.length : null;
      record.llm.modes.push(req && req.mode);
      record.llm.requests.push({ mode: req && req.mode, msgs: (req && req.messages) ? req.messages.length : null });
    } catch (_) {}
    if (process.env.LIBRA_DUMP_PROMPT) {
      try { if (process.env.MEMORY_SUITE_TEST_OUTPUT) { fs.writeFileSync(path.join(process.env.MEMORY_SUITE_TEST_OUTPUT || __dirname, 'prompt_dump.txt'), (req.messages || []).map(m => '[' + m.role + ']\n' + m.content).join('\n====\n')); } } catch (_) {}
    }
    if (FAIL_MODE) {
      return { type: 'fail', result: 'Vertex AI authentication information is missing or incomplete. Please check your settings.' };
    }
    return { type: 'success', result: analysisResultFor(req) };
  },

  getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'node-harness', saveMethod: 'memory' }),
  getCharacter: async () => charView(),
  getChar: async () => charView(),
  setCharacter: noop, setChar: noop,
  getCharacterFromIndex: async () => charView(),
  setCharacterToIndex: noop,
  getCurrentCharacterIndex: async () => 0,
  getCurrentChatIndex: async () => 0,
  getChatFromIndex: async () => chatView(),
  setChatToIndex: noop,
  getDatabase: async () => null, setDatabase: noop, setDatabaseLite: noop,
  getRootDocument: async () => null,
  createMutationObserver: async () => ({ observe: () => {}, disconnect: () => {} }),
  addProvider: noop, registerMCP: noop, unregisterMCP: noop,
  registerBodyIntercepter: async () => ({ id: uiId() }), unregisterBodyIntercepter: noop,
  requestPluginPermission: async () => true,
  getFetchLogs: async () => [],
  readImage: async () => null, saveAsset: async () => null, readInlay: async () => null,
  unwarpSafeArray: async (a) => (Array.isArray(a) ? a : []),
  searchTranslationCache: async () => [], getTranslationCache: async () => null,
  changeColorScheme: noop, getColorScheme: async () => ({ name: 'dark', scheme: {} }),
  setColorScheme: noop, changeTextTheme: noop,
  getTextTheme: async () => ({ name: 'standard', customTheme: {} }), setCustomTextTheme: noop,
};

globalThis.Risuai = Risuai; globalThis.RisuAI = Risuai; globalThis.risuai = Risuai;
globalThis.risuApi = Risuai; globalThis.risuAPI = Risuai;
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

const {installConsoleErrorCapture} = require('./harness_console_capture.cjs');
const origErr = installConsoleErrorCapture(record);

// ---- the six Korean turns; planted facts: 은열쇠 소유자=유나, 돈 위치=서재 ----
function buildTurns() {
  return [
    { user: '유나가 방으로 들어와서 무언가를 손에 꼭 쥐고 있었다. 그게 뭐야?',
      assistant: '유나는 방으로 천천히 들어오며 손바닥을 펼쳐 보였다. 그 안에는 은열쇠가 놓여 있었고, 그녀는 그것을 다시 주머니에 넣으며 절대 잃어버리지 않겠다고 다짐했다. 은열쇠는 이제 확실히 유나의 소지품이 되었다.' },
    { user: '지하 서고로 내려가 보자. 문 상태는 어때?',
      assistant: '두 사람은 좁은 계단을 따라 지하 서고 앞에 도착했다. 육중한 철문에는 커다란 자물쇠가 걸려 있었고, 손잡이를 아무리 돌려도 꿈쩍하지 않았다. 지하 서고는 단단히 잠긴 상태였고, 유나는 이마를 찌푸리며 열쇠 구멍을 들여다보았다.' },
    { user: '유나가 그 은열쇠를 자물쇠에 넣어 볼까?',
      assistant: '유나는 주머니에서 은열쇠를 꺼내 자물쇠 구멍에 조심스럽게 밀어 넣었다. 딸깍, 하는 맑은 소리와 함께 자물쇠가 풀렸다. 무거운 철문이 삐걱거리며 열렸고, 지하 서고는 이제 활짝 열린 상태가 되었다.' },
    { user: '서재도 확인해야겠어. 그전에, 우리가 모아둔 돈은 지금 어디 있지?',
      assistant: '유나는 잠시 기억을 더듬었다. 여비로 쓸 돈은 며칠 전 서재의 낡은 책상 서랍 안에 넣어 두었다고 말했다. 그녀는 서재로 가면 그 돈을 찾을 수 있을 거라고 확신했다. 돈은 분명히 서재에 보관되어 있는 상태다.' },
    { user: '지하 서고 안에서 뭔가 발견한 게 있어?',
      assistant: '열린 지하 서고 안을 살피던 유나는 먼지 쌓인 선반에서 붉은 표지의 낡은 일기장을 발견했다. 그녀는 그것을 조심스럽게 꺼내 품에 안았다. 붉은 일기장은 이제 유나가 소지하게 된 새로운 단서였다.' },
    { user: '유나가 서재로 가서 문을 두드렸어. 서재지기는 뭐라고 했지?',
      assistant: '서재에 도착한 유나가 문을 두드리자, 나이 든 서재지기가 문을 열어 주었다. 그는 유나에게 서재는 언제든 드나들 수 있다고 말하며 안으로 들여보냈다. 유나는 곧장 책상 서랍으로 향했다.' },
  ];
}

async function callBeforeRequest(messages, type = 'model') {
  const fn = record.handlers.beforeRequest;
  if (typeof fn !== 'function') return { error: 'no_beforeRequest_handler', messages };
  const out = await fn(messages, type);
  return { messages: Array.isArray(out) ? out : messages, raw: out };
}
async function callAfterRequest(content, type = 'model') {
  const fn = record.handlers.afterRequest;
  if (typeof fn !== 'function') return content;
  const out = await fn(content, type);
  return typeof out === 'string' ? out : content;
}
async function fireChatOutput(messageIndex) {
  const fn = record.handlers.chatOutput;
  if (typeof fn !== 'function') return { error: 'no_chatOutput_handler' };
  await fn({ char: charView(), chat: chatView(), characterIndex: 0, chatIndex: 0, messageIndex });
  return { ok: true };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function totalChars(messages) { return (messages || []).reduce((n, m) => n + String((m && (m.content ?? m.data)) || '').length, 0); }
function joinContent(messages) { return (messages || []).map(m => String((m && (m.content ?? m.data)) || '')).join('\n'); }

const report = { mode: FAIL_MODE ? 'FAIL_PATH' : 'SUCCESS_PATH', steps: [], probes: {}, storage: {} };

async function run() {
  await sleep(500);
  report.registration = {
    chatListeners: record.hooks.chatListeners,
    replacers: record.hooks.replacers,
    scriptHandlers: record.hooks.scriptHandlers,
    beforeRequest: !!record.handlers.beforeRequest,
    afterRequest: !!record.handlers.afterRequest,
    chatOutput: !!record.handlers.chatOutput,
  };

  const turns = buildTurns();
  const convo = [];

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    convo.push({ role: 'user', content: turn.user });
    // beforeRequest sees the pending request BEFORE the assistant reply — this is the
    // boundary-arming / recovery path for the 5-turn trigger.
    const before = await callBeforeRequest(convo.map(m => ({ ...m })), 'model');
    const llmBefore = record.llm.calls;
    pushMessage('user', turn.user);

    const afterOut = await callAfterRequest(turn.assistant, 'model');
    const aIndex = liveMessages.length;
    pushMessage('char', turn.assistant);
    convo.push({ role: 'assistant', content: turn.assistant });

    // authoritative CHAT_OUTPUT_V3 capture for this assistant message
    const fired = await fireChatOutput(aIndex);
    await sleep(600); // let capture + any triggered analysis/commit settle

    report.steps.push({
      turn: t + 1,
      userPreview: turn.user.slice(0, 24),
      beforeRequestMsgs: before.messages ? before.messages.length : null,
      llmCallsDuringTurn: record.llm.calls - llmBefore,
      chatOutputFired: fired.ok === true,
      storageKeysAfter: [...pluginStorage.__map.keys()].length,
    });
  }

  // Fire one more model beforeRequest to trigger any deferred boundary commit for the
  // completed 5-turn batch, then wait for async commit.
  convo.push({ role: 'user', content: '이제 상황을 정리해줘.' });
  await callBeforeRequest(convo.map(m => ({ ...m })), 'model');
  convo.pop();
  await sleep(2500);

  report.storage.pluginStorageKeys = [...pluginStorage.__map.keys()];
  report.storage.localPluginStorageKeys = [...localPluginStorage.__map.keys()];
  report.storage.safeLocalStorageKeys = [...safeLocalStorage.__map.keys()];

  // categorize keys
  const allKeys = [...pluginStorage.__map.keys()];
  report.storage.canonicalKeys = allKeys.filter(k => /canonical|memory/i.test(k));
  report.storage.manifestKeys = allKeys.filter(k => /manifest/i.test(k));

  // parse manifest(s) and report memories map
  report.manifests = {};
  for (const k of allKeys.filter(k => /manifest/i.test(k))) {
    try {
      const obj = JSON.parse(pluginStorage.__map.get(k));
      report.manifests[k] = {
        schema: obj.schema, scopeKey: obj.scopeKey,
        memoriesSlots: obj.memories ? Object.keys(obj.memories) : [],
        memoriesDetail: obj.memories ? Object.fromEntries(Object.entries(obj.memories).map(([slot, ref]) => [slot, { status: ref && ref.status, startTurn: ref && ref.startTurn, endTurn: ref && ref.endTurn, key: ref && ref.key, revision: ref && ref.revision }])) : {},
        inFlight: obj.inFlight || null,
      };
    } catch (e) { report.manifests[k] = { parseError: String(e) }; }
  }

  // full dump for offline reading
  const dump = {};
  for (const k of allKeys) dump[k] = pluginStorage.__map.get(k);
  const dumpFile = path.join(process.env.MEMORY_SUITE_TEST_OUTPUT || __dirname, FAIL_MODE ? 'libra_storage_dump_fail.json' : 'libra_storage_dump.json');
  try { if (process.env.MEMORY_SUITE_TEST_OUTPUT) { fs.writeFileSync(dumpFile, JSON.stringify(dump, null, 2)); report.dumpFile = dumpFile; } } catch (_) {}

  // ---- CRITICAL (FAIL path): scan EVERY storage value for the auth error string ----
  const ERR_NEEDLE = 'Vertex AI authentication';
  const errHits = [];
  for (const k of allKeys) {
    const v = String(pluginStorage.__map.get(k) || '');
    if (v.includes(ERR_NEEDLE)) errHits.push({ key: k, excerpt: v.slice(Math.max(0, v.indexOf(ERR_NEEDLE) - 60), v.indexOf(ERR_NEEDLE) + 120) });
  }
  for (const k of [...localPluginStorage.__map.keys()]) {
    const raw = localPluginStorage.__map.get(k);
    const v = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (v.includes(ERR_NEEDLE)) errHits.push({ key: 'local:' + k, excerpt: 'present' });
  }
  report.errorNeedleScan = { needle: ERR_NEEDLE, hits: errHits, cleanOfError: errHits.length === 0 };

  // ---------- RECALL PROBES ----------
  async function probeFull(query) {
    // Shape the current query as a provenance-bearing user turn (chatId + stable id + time),
    // exactly as RisuAI marks a real user message, so LIBRA's resolveSgaCurrentTurn accepts
    // it as request_provenance_user instead of skipping with no_safe_current_user_input.
    const qmsg = { role: 'user', content: query, chatId: CHAT_ID, id: `probe_${Date.now()}`, time: Date.now() };
    const q = [...convo.map(m => ({ ...m })), qmsg];
    const baselineChars = totalChars(q);
    const before = await callBeforeRequest(q, 'model');
    const joined = joinContent(before.messages);
    return { q, baselineChars, joined, returnedMsgCount: before.messages.length,
      injectedChars: totalChars(before.messages), grew: totalChars(before.messages) > baselineChars };
  }

  // Isolate the canonical-memory block from raw Live Tail echo. LIBRA labels its injected
  // recall block; probe for canonical markers vs. raw transcript markers.
  function analyzeInjection(joined, baselineChars, query) {
    const injected = joined.length > baselineChars ? joined.slice(baselineChars) : joined; // whole join; markers scanned across all
    // Find LIBRA's memory/recall block by common markers.
    const markerRe = /(정본 기억|SOURCE MEMORY|CANONICAL|기억 회상|RECALLED|LIBRA|Planner|증거|memory analysis|정본)/i;
    const liveTailRe = /(Live Tail|LIVE TAIL|최근 대화|원문|TURN \d)/i;
    const memIdx = joined.search(markerRe);
    const memBlock = memIdx >= 0 ? joined.slice(memIdx, memIdx + 3000) : '';
    return {
      query,
      grew: joined.length > baselineChars,
      contains_유나: joined.includes('유나'),
      contains_은열쇠: joined.includes('은열쇠'),
      contains_돈: joined.includes('돈'),
      contains_서재: joined.includes('서재'),
      canonicalMarkerPresent: memIdx >= 0,
      canonicalMarkerExcerpt: memBlock.slice(0, 1500),
      canonicalBlock_은열쇠: memBlock.includes('은열쇠'),
      canonicalBlock_돈: memBlock.includes('돈'),
      canonicalBlock_서재: memBlock.includes('서재'),
      liveTailMarkerPresent: liveTailRe.test(joined),
      analysisTextEcho: joined.includes('[정본 기억 분석 결과]'), // our fake analysis output surfaced
    };
  }

  const p1 = await probeFull('은열쇠 지금 누가 갖고 있지?');
  const viewer1 = (globalThis.__LIBRA__ && typeof globalThis.__LIBRA__.getLastMemoryRecallViewer === 'function') ? globalThis.__LIBRA__.getLastMemoryRecallViewer() : null;
  report.probes.silverKey = { ...analyzeInjection(p1.joined, p1.baselineChars, '은열쇠 누가 갖고 있지?'), injectedChars: p1.injectedChars, baselineChars: p1.baselineChars, recallViewer: viewer1 };
  const p2 = await probeFull('돈');
  const viewer2 = (globalThis.__LIBRA__ && typeof globalThis.__LIBRA__.getLastMemoryRecallViewer === 'function') ? globalThis.__LIBRA__.getLastMemoryRecallViewer() : null;
  report.probes.moneyOneChar = { ...analyzeInjection(p2.joined, p2.baselineChars, '돈'), injectedChars: p2.injectedChars, baselineChars: p2.baselineChars, recallViewer: viewer2 };

  // ---- direct canonical-record inspection: prove facts came from a STORED canonical memory ----
  report.canonicalRecords = [];
  for (const k of report.storage.canonicalKeys) {
    try {
      const v = pluginStorage.__map.get(k);
      const obj = JSON.parse(v);
      if (String(obj.schema || '') === 'libra.canonical_memory.v1' || /canonical_memory/.test(String(obj.schema||''))) {
        const flat = JSON.stringify(obj);
        report.canonicalRecords.push({
          key: k, schema: obj.schema, memoryId: obj.memoryId || obj.id || null,
          startTurn: obj.startTurn || (obj.turnRange && obj.turnRange.start) || null,
          revision: obj.revision, sourceDigest: obj.sourceDigest,
          rec_은열쇠: flat.includes('은열쇠'), rec_돈: flat.includes('돈'), rec_서재: flat.includes('서재'),
          rec_analysisEcho: flat.includes('[정본 기억 분석 결과]'),
          rec_authError: flat.includes('Vertex AI authentication'),
          excerpt: flat.slice(0, 400),
        });
      }
    } catch (_) {}
  }

  // half-committed check: any manifest ref pointing to a missing/garbage canonical memory?
  report.halfCommittedCheck = [];
  for (const [mk, mObj] of Object.entries(report.manifests)) {
    if (!mObj.memoriesDetail) continue;
    for (const [slot, ref] of Object.entries(mObj.memoriesDetail)) {
      const refKey = ref && ref.key;
      const present = refKey && pluginStorage.__map.has(refKey);
      let garbage = false;
      if (present) { const rv = String(pluginStorage.__map.get(refKey) || ''); garbage = rv.includes('Vertex AI authentication'); }
      report.halfCommittedCheck.push({ manifest: mk, slot, status: ref.status, refKey, present: !!present, pointsToGarbage: garbage });
    }
  }

  // ---------- diagnostics ----------
  console.error = origErr;
  const diag = (globalThis.__librarianDiag && typeof globalThis.__librarianDiag.snapshot === 'function')
    ? globalThis.__librarianDiag.snapshot() : null;

  report.plugin = path.basename(pluginPath);
  report.uncaught = captured.uncaught;
  report.unhandledRejection = captured.unhandled;
  report.llm = record.llm;
  report.network = record.network;
  report.consoleErrors = record.consoleErrors.slice(0, 40);
  report.librarianDiag = diag;
  report.liveMessageCount = liveMessages.length;
  report.llmHostFailCaught = Array.isArray(diag) ? diag.some(r => r && r.tag === 'llm.host.fail') : false;

  const reportFile = path.join(process.env.MEMORY_SUITE_TEST_OUTPUT || __dirname, FAIL_MODE ? 'libra_report_fail.json' : 'libra_report.json');
  try { if (process.env.MEMORY_SUITE_TEST_OUTPUT) { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); } } catch (_) {}
  process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify(report, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n');
  process.exit(require('./harness_assertions.cjs').validate("libra_convo_harness.js", report) ? 0 : 1);
}

let syncThrow = null;
try { vm.runInThisContext(src, { filename: pluginPath }); }
catch (e) { syncThrow = { message: String(e && e.message || e), stack: e && e.stack || null }; }
if (syncThrow) { console.error = origErr; process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify({ syncThrow }, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n'); process.exit(1); }

run().catch(e => {
  console.error = origErr;
  process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify({ runError: String(e && e.stack || e), partial: report }, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n');
  process.exit(1);
});
