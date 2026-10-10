// HAYAKU execution-verification harness — drives a live Korean conversation,
// authors distinct HAYAKU_STATE_PACKET packets per assistant turn, then probes recall.
// Original plugin + original harness are NOT modified. This is a standalone extension.
// Usage: node hayaku_convo_harness.js "<absolute plugin path>"
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const pluginPath = process.argv[2];
if (!pluginPath) { console.error('no plugin path'); process.exit(2); }

const captured = { uncaught: [], unhandled: [] };
process.on('uncaughtException', (err) => { captured.uncaught.push({ message: String(err && err.message || err), stack: err && err.stack || null }); });
process.on('unhandledRejection', (reason) => { const e = reason instanceof Error ? reason : new Error(String(reason)); captured.unhandled.push({ message: String(e.message), stack: e.stack || null }); });

const record = {
  hooks: { chatListeners: [], replacers: [], scriptHandlers: [] },
  handlers: { beforeRequest: null, afterRequest: null, chatOutput: null, script: {} },
  llm: { calls: 0, lastMessagesLen: null, requests: [] },
  network: { blocked: 0, urls: [] },
  consoleErrors: [],
};

// ---- pluginStorage (async, durable) ----
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

// parse //@arg defaults
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
const pluginStorage = makeStorage();
const safeLocalStorage = makeStorage();
const localPluginStorage = makeLocalPluginStorage();

const noop = async () => {};
const uiId = (() => { let n = 0; return () => `uipart_${++n}`; })();

// ---- LIVE character + chat: one stable identity, one mutable message array ----
const CHA_ID = 'harness_char_stable_001';
const CHAT_ID = 'harness_chat_stable_001';
const liveMessages = [];               // <-- updated per turn; the single source of truth
const liveChat = { id: CHAT_ID, name: 'chat-live', message: liveMessages };
const liveCharacter = {
  name: 'HAYAKU Harness Char', chaId: CHA_ID, id: CHA_ID, description: 'fake', chatPage: 0,
  chats: [liveChat], chat: liveChat,
};
// Deep-ish clone that PRESERVES the live message array reference (host returns fresh
// wrappers each call, but the message array must be the same accumulating list).
function charView() {
  return { name: liveCharacter.name, chaId: CHA_ID, id: CHA_ID, description: 'fake', chatPage: 0, chats: [ { id: CHAT_ID, name: liveChat.name, message: liveMessages } ], chat: { id: CHAT_ID, name: liveChat.name, message: liveMessages } };
}
function chatView() { return { id: CHAT_ID, name: liveChat.name, message: liveMessages }; }

// message object shaped like RisuAI native chat message
let msgSeq = 0;
function pushMessage(role, data) {
  const id = `msg_${++msgSeq}`;
  liveMessages.push({ role, data, id, chatId: CHAT_ID });
  return id;
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

  registerSetting: async (name) => ({ id: uiId() }),
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

  // RisuAI real contract: return { type:'success', result:'<text>' }
  runLLMModel: async (req) => {
    record.llm.calls++;
    try {
      record.llm.lastMessagesLen = (req && req.messages) ? req.messages.length : null;
      record.llm.requests.push({ mode: req && req.mode, msgs: (req && req.messages) ? req.messages.length : null });
    } catch (_) {}
    return { type: 'success', result: '[[HARNESS_FAKE_LLM_OUTPUT]]' };
  },

  getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'node-harness', saveMethod: 'memory' }),
  getCharacter: async () => charView(),
  getChar: async () => charView(),
  setCharacter: noop, setChar: noop,
  getCharacterFromIndex: async () => charView(),
  setCharacterToIndex: noop,
  getCurrentCharacterIndex: async () => 0,
  getCurrentChatIndex: async () => 0,
  getChatFromIndex: async () => chatView(),   // <-- live message array every call
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

// ---------- packet authoring (valid HAYAKU_STATE_PACKET current_snapshot) ----------
const PS = 'HAYAKU_STATE_PACKET_START';
const PE = 'HAYAKU_STATE_PACKET_END';
function packet(o) {
  const meta = {
    schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', packet_schema_rev: 2,
    scene_id: o.scene_id || 'scene_main',
    turn_anchor: o.turn_anchor,
    confidence: 0.92,
    summary_memory: {
      summary: o.summary,
      recallAnchors: o.anchors || [],
      recallAliases: o.aliases || {},
      canonicalAnchors: o.canon || [],
      mentionedEntityNames: o.entities || [],
      confidence: 0.9,
    },
  };
  const p = {
    meta,
    entity: o.entity || {},
    world: o.world || {},
    narrative: o.narrative || {},
    planner: o.planner || {},
    importance: { overall: o.importance != null ? o.importance : 0.8, reason: o.reason || ['established continuity outcome'] },
  };
  return `<!-- ${PS} ${JSON.stringify(p)} ${PE} -->`;
}

// The six distinct Korean turns. Each assistant reply carries substantive prose (>=80 chars)
// so the coverage gate detects a finalized outcome, plus a SEMANTICALLY DISTINCT packet.
function buildTurns() {
  return [
    {
      user: '유나가 방으로 들어와서 무언가를 손에 꼭 쥐고 있었다. 그게 뭐야?',
      assistant: '유나는 방으로 천천히 들어오며 손바닥을 펼쳐 보였다. 그 안에는 은열쇠가 놓여 있었고, 그녀는 그것을 다시 주머니에 넣으며 절대 잃어버리지 않겠다고 다짐했다. 은열쇠는 이제 확실히 유나의 소지품이 되었다.',
      packet: {
        turn_anchor: '유나가 은열쇠를 획득하여 소지하게 됨',
        summary: '유나가 은열쇠를 손에 넣어 자신의 소지품으로 챙겼다. 은열쇠의 소유자는 유나다.',
        anchors: ['유나', '은열쇠', '소지', '획득'], entities: ['유나'],
        entity: { characters: [{ name: '유나', current_state: '은열쇠를 소지함', carrying: '은열쇠' }] },
        world: { active_events: [{ summary: '유나가 은열쇠를 획득함', status: 'active' }] },
      },
    },
    {
      user: '지하 서고로 내려가 보자. 문 상태는 어때?',
      assistant: '두 사람은 좁은 계단을 따라 지하 서고 앞에 도착했다. 육중한 철문에는 커다란 자물쇠가 걸려 있었고, 손잡이를 아무리 돌려도 꿈쩍하지 않았다. 지하 서고는 단단히 잠긴 상태였고, 유나는 이마를 찌푸리며 열쇠 구멍을 들여다보았다.',
      packet: {
        turn_anchor: '지하 서고가 잠긴 상태로 확인됨',
        summary: '지하 서고의 철문은 자물쇠로 잠겨 있어 열리지 않는다. 현재 지하 서고는 잠김 상태다.',
        anchors: ['지하 서고', '잠김', '자물쇠', '철문'], entities: ['유나'],
        world: { regions: [{ name: '지하 서고', current_state: '잠김', status: 'locked' }], active_events: [{ summary: '지하 서고 문이 잠겨 있음', status: 'active' }] },
      },
    },
    {
      user: '유나가 그 은열쇠를 자물쇠에 넣어 볼까?',
      assistant: '유나는 주머니에서 은열쇠를 꺼내 자물쇠 구멍에 조심스럽게 밀어 넣었다. 딸깍, 하는 맑은 소리와 함께 자물쇠가 풀렸다. 무거운 철문이 삐걱거리며 열렸고, 지하 서고는 이제 활짝 열린 상태가 되었다. 안쪽에서 오래된 종이 냄새가 흘러나왔다.',
      packet: {
        turn_anchor: '지하 서고가 은열쇠로 열림 (잠김 -> 열림 상태 변화)',
        summary: '유나가 은열쇠로 지하 서고의 자물쇠를 열었다. 지하 서고는 이제 열린 상태이며, 이전의 잠김 상태를 대체한다.',
        anchors: ['지하 서고', '열림', '은열쇠', '자물쇠 해제'], entities: ['유나'],
        world: {
          regions: [{ name: '지하 서고', current_state: '열림', status: 'open', resolved_reason: '유나가 은열쇠로 잠금을 해제함' }],
          historical_events: [{ summary: '지하 서고가 이전에 잠겨 있었으나 이제 열림', status: 'superseded', time_scope: 'past' }],
        },
      },
    },
    {
      user: '서재도 확인해야겠어. 그전에, 우리가 모아둔 돈은 지금 어디 있지?',
      assistant: '유나는 잠시 기억을 더듬었다. 여비로 쓸 돈은 며칠 전 서재의 낡은 책상 서랍 안에 넣어 두었다고 말했다. 그녀는 서재로 가면 그 돈을 찾을 수 있을 거라고 확신했다. 돈은 분명히 서재에 보관되어 있는 상태다.',
      packet: {
        turn_anchor: '돈의 보관 위치가 서재로 확정됨',
        summary: '모아둔 돈은 서재의 책상 서랍에 보관되어 있다. 돈의 현재 위치는 서재다.',
        anchors: ['돈', '서재', '책상 서랍', '보관'], entities: ['유나'],
        world: { active_events: [{ summary: '돈이 서재에 보관되어 있음', status: 'active', location: '서재' }] },
      },
    },
    {
      user: '지하 서고 안에서 뭔가 발견한 게 있어?',
      assistant: '열린 지하 서고 안을 살피던 유나는 먼지 쌓인 선반에서 붉은 표지의 낡은 일기장을 발견했다. 그녀는 그것을 조심스럽게 꺼내 품에 안았다. 붉은 일기장은 이제 유나가 소지하게 된 새로운 단서였다.',
      packet: {
        turn_anchor: '유나가 지하 서고에서 붉은 일기장을 발견하고 소지함',
        summary: '유나가 열린 지하 서고 안에서 붉은 일기장을 발견하여 소지했다.',
        anchors: ['유나', '붉은 일기장', '지하 서고', '발견'], entities: ['유나'],
        entity: { characters: [{ name: '유나', carrying: '은열쇠와 붉은 일기장' }] },
        world: { active_events: [{ summary: '유나가 붉은 일기장을 발견함', status: 'active' }] },
      },
    },
    {
      user: '유나가 서재로 가서 문을 두드렸어. 서재지기는 뭐라고 했지?',
      assistant: '서재에 도착한 유나가 문을 두드리자, 나이 든 서재지기가 문을 열어 주었다. 그는 유나에게 서재는 언제든 드나들 수 있다고 말하며 안으로 들여보냈다. 유나는 곧장 책상 서랍으로 향했고, 서재지기는 그 모습을 조용히 지켜보았다.',
      packet: {
        turn_anchor: '서재지기가 유나를 서재로 들여보냄',
        summary: '서재지기가 유나에게 서재 출입을 허락하여 안으로 들여보냈다.',
        anchors: ['서재지기', '유나', '서재', '출입 허락'], entities: ['유나', '서재지기'],
        entity: { characters: [{ name: '서재지기', current_state: '유나를 서재로 들여보냄' }] },
      },
    },
  ];
}

// ---- helpers to run one conversation turn through HAYAKU ----
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
  await fn({
    char: charView(), chat: chatView(),
    characterIndex: 0, chatIndex: 0, messageIndex,
  });
  return { ok: true };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- utilities to inspect a beforeRequest injection ----
function totalChars(messages) { return (messages || []).reduce((n, m) => n + String((m && (m.content ?? m.data)) || '').length, 0); }
function joinContent(messages) { return (messages || []).map(m => String((m && (m.content ?? m.data)) || '')).join('\n'); }

const report = { steps: [], probes: {}, storage: {} };

async function run() {
  // give the plugin's async IIFE time to register hooks + install ownership
  await sleep(400);

  report.registration = {
    chatListeners: record.hooks.chatListeners,
    replacers: record.hooks.replacers,
    scriptHandlers: record.hooks.scriptHandlers,
    beforeRequest: !!record.handlers.beforeRequest,
    afterRequest: !!record.handlers.afterRequest,
    chatOutput: !!record.handlers.chatOutput,
  };

  const turns = buildTurns();
  // running conversation as messages fed to beforeRequest (content-shaped)
  const convo = [];

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    // 1) user speaks -> beforeRequest sees the pending request
    convo.push({ role: 'user', content: turn.user });
    const before = await callBeforeRequest(convo.map(m => ({ ...m })), 'model');
    // 2) also reflect the user message into the live chat transcript
    pushMessage('user', turn.user);

    // 3) model produces assistant text WITH the hidden packet appended (what the AI "wrote")
    const assistantBody = turn.assistant + '\n' + packet(turn.packet);
    // afterRequest sanitizer/repair path sees the raw content
    const afterOut = await callAfterRequest(assistantBody, 'model');
    // 4) commit assistant message into the live transcript (source of truth for capture)
    const aIndex = liveMessages.length;
    pushMessage('char', assistantBody);
    convo.push({ role: 'assistant', content: assistantBody });

    // 5) fire the authoritative CHAT_OUTPUT_V3 capture event for this assistant message
    const fired = await fireChatOutput(aIndex);
    await sleep(220); // let the async capture worker settle

    report.steps.push({
      turn: t + 1,
      userPreview: turn.user.slice(0, 30),
      beforeRequestMsgs: before.messages.length,
      afterRequestChanged: afterOut !== assistantBody,
      chatOutputFired: fired.ok === true,
      storageKeysAfter: [...pluginStorage.__map.keys()].length,
    });
  }

  await sleep(500); // let all capture workers drain

  report.storage.pluginStorageKeys = [...pluginStorage.__map.keys()];
  report.storage.localPluginStorageKeys = [...localPluginStorage.__map.keys()];
  report.storage.safeLocalStorageKeys = [...safeLocalStorage.__map.keys()];
  // sample a few packet-bearing storage values
  const sample = {};
  for (const k of [...pluginStorage.__map.keys()]) {
    const v = pluginStorage.__map.get(k);
    sample[k] = (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 600);
  }
  report.storage.sample = sample;

  // ---------- RECALL PROBES ----------
  async function probe(label, query) {
    const q = [...convo.map(m => ({ ...m })), { role: 'user', content: query }];
    const baselineChars = totalChars(q);
    const before = await callBeforeRequest(q, 'model');
    const injectedChars = totalChars(before.messages);
    const joined = joinContent(before.messages);
    return {
      label, query,
      baselineMsgCount: q.length,
      returnedMsgCount: before.messages.length,
      baselineChars, injectedChars, grew: injectedChars > baselineChars,
      delta: injectedChars - baselineChars,
      contains_유나: joined.includes('유나'),
      contains_은열쇠: joined.includes('은열쇠'),
      contains_열림: joined.includes('열림') || joined.includes('열렸'),
      contains_잠김: joined.includes('잠김') || joined.includes('잠겨'),
      contains_돈: joined.includes('돈'),
      contains_서재: joined.includes('서재'),
      injectedExcerpt: joined.length > baselineChars ? joined.slice(baselineChars, baselineChars + 1200) : '',
    };
  }

  report.probes.silverKey = await probe('은열쇠 소지자 회상', '은열쇠 지금 누가 갖고 있지?');
  report.probes.moneyOneChar = await probe('1자 한글 "돈" 검색', '돈');
  report.probes.basementState = await probe('지하 서고 최신 상태(잠김->열림) 회상', '지하 서고 지금 어떻지?');

  // ---- deep inspection: how many packet records actually landed in the ledger ----
  // Parse every ledger value looking for stored records / packet payloads.
  report.ledgerInspect = {};
  for (const k of [...pluginStorage.__map.keys()]) {
    if (!/ledger/.test(k)) continue;
    try {
      const obj = JSON.parse(pluginStorage.__map.get(k));
      // count fields that look like record containers
      const recKeys = Object.keys(obj).filter(x => /record|packet|entr|memor|turn|pair/i.test(x));
      const counts = {};
      for (const rk of recKeys) {
        const v = obj[rk];
        counts[rk] = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : typeof v);
      }
      report.ledgerInspect[k] = {
        topKeys: Object.keys(obj),
        recordish: counts,
        migration: obj.migration || null,
        rawLen: pluginStorage.__map.get(k).length,
      };
    } catch (e) { report.ledgerInspect[k] = { parseError: String(e) }; }
  }
  // Dump every stored value in full to a side file for offline reading.
  const dump = {};
  for (const k of [...pluginStorage.__map.keys()]) dump[k] = pluginStorage.__map.get(k);
  try { if (process.env.MEMORY_SUITE_TEST_OUTPUT) { require('fs').writeFileSync(require('path').join(process.env.MEMORY_SUITE_TEST_OUTPUT || __dirname, 'hayaku_storage_dump.json'), JSON.stringify(dump, null, 2)); report.dumpFile = require('path').join(process.env.MEMORY_SUITE_TEST_OUTPUT || __dirname, 'hayaku_storage_dump.json'); } } catch (_) {}

  // ---- isolate the memory-derived injection block (distinct from raw transcript echo) ----
  function memBlock(joined) {
    const start = joined.indexOf('[SOURCE MEMORY RECORDS');
    if (start < 0) return { present: false };
    const seg = joined.slice(start, start + 4000);
    return {
      present: true,
      excerpt: seg,
      mentions_유나: seg.includes('유나'),
      mentions_은열쇠: seg.includes('은열쇠'),
      mentions_열림: seg.includes('열림') || seg.includes('열렸') || seg.includes('open'),
      mentions_잠김: seg.includes('잠김') || seg.includes('잠겨') || seg.includes('locked'),
      mentions_돈: seg.includes('돈'),
      mentions_서재: seg.includes('서재'),
    };
  }
  // re-run each probe capturing the full joined injection for memory-block isolation
  async function probeMem(query) {
    const q = [...convo.map(m => ({ ...m })), { role: 'user', content: query }];
    const before = await callBeforeRequest(q, 'model');
    return memBlock(joinContent(before.messages));
  }
  report.memoryBlocks = {
    silverKey: await probeMem('은열쇠 지금 누가 갖고 있지?'),
    moneyOneChar: await probeMem('돈'),
    basementState: await probeMem('지하 서고 지금 어떻지?'),
  };

  // ---- basement latest-state assertion (locked -> open supersession) ----
  async function fullJoin(query) {
    const q = [...convo.map(m => ({ ...m })), { role: 'user', content: query }];
    const before = await callBeforeRequest(q, 'model');
    return joinContent(before.messages);
  }
  const bj = await fullJoin('지하 서고 지금 어떻지?');
  const idxOpen = Math.max(bj.indexOf('열림'), bj.indexOf('열렸'), bj.indexOf('활짝 열린'), bj.indexOf('open'));
  const idxLocked = Math.max(bj.indexOf('잠김'), bj.indexOf('잠긴'), bj.indexOf('잠겨'), bj.indexOf('locked'));
  // find any explicit supersession/resolved marker for the region
  const openRecordPresent = bj.includes('열림') || bj.includes('활짝 열린') || bj.includes('잠금을 해제') || bj.includes('resolved_reason');
  const supersededMarker = bj.includes('superseded') || bj.includes('이제 열림') || bj.includes('이제 열린');
  report.basementLatestState = {
    openMentionIndex: idxOpen,
    lockedMentionIndex: idxLocked,
    openRecordPresent,
    supersededMarkerPresent: supersededMarker,
    openAppearsBeforeLocked: idxOpen >= 0 && (idxLocked < 0 || idxOpen < idxLocked),
    // grab the window around the region record for evidence
    regionEvidence: (() => {
      const anchor = bj.indexOf('지하 서고');
      let best = '';
      // find the memory-record occurrence of the region (after SOURCE MEMORY RECORDS)
      const src = bj.indexOf('[SOURCE MEMORY RECORDS');
      const tail = src >= 0 ? bj.slice(src) : bj;
      const ri = Math.max(tail.indexOf('열림'), tail.indexOf('활짝 열린'), tail.indexOf('resolved_reason'), tail.indexOf('지하 서고가 이전에'));
      if (ri >= 0) best = tail.slice(Math.max(0, ri - 200), ri + 400);
      return best;
    })(),
  };
  // Also: which turn-3 (open) record raw is stored, and does its region status say open?
  try {
    const dk = [...pluginStorage.__map.keys()].find(k => /ledger/.test(k));
    const L = JSON.parse(pluginStorage.__map.get(dk));
    const raws = (L.records || []).map(r => String(r.raw || '')).filter(Boolean);
    report.storedPacketRaws = raws.map((r, i) => ({
      i,
      hasOpen: r.includes('열림') || r.includes('open'),
      hasLocked: r.includes('잠김') || r.includes('locked'),
      hasSuperseded: r.includes('superseded'),
      hasMoney: r.includes('돈'),
      hasSilverKey: r.includes('은열쇠'),
      excerpt: r.slice(0, 300),
    }));
  } catch (e) { report.storedPacketRaws = { error: String(e) }; }

  // ---------- final diagnostics ----------
  console.error = origErr;
  const diag = (globalThis.__librarianDiag && typeof globalThis.__librarianDiag.snapshot === 'function')
    ? globalThis.__librarianDiag.snapshot() : null;

  report.plugin = path.basename(pluginPath);
  report.syncThrow = null;
  report.uncaught = captured.uncaught;
  report.unhandledRejection = captured.unhandled;
  report.llm = record.llm;
  report.network = record.network;
  report.consoleErrors = record.consoleErrors.slice(0, 30);
  report.librarianDiag = diag;
  report.liveMessageCount = liveMessages.length;

  try { if (process.env.MEMORY_SUITE_TEST_OUTPUT) { require('fs').writeFileSync(require('path').join(process.env.MEMORY_SUITE_TEST_OUTPUT || __dirname, 'hayaku_report.json'), JSON.stringify(report, null, 2)); } } catch (_) {}
  process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify(report, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n');
  process.exit(require('./harness_assertions.cjs').validate("hayaku_convo_harness.js", report) ? 0 : 1);
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
