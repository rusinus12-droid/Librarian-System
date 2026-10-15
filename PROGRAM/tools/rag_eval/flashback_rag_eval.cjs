'use strict';
// Flashback retrieval-quality and latency evaluator.
//
// Loads plugins/Flashback_Memory.js UNMODIFIED on a fake RisuAI v3 host, drives the
// fixture conversation through the real beforeRequest/afterRequest/output hooks
// (capture + embedding + storage), then asks every fixture question through the real
// beforeRequest recall path and checks whether the gold facts were delivered.
//
// Embeddings:
//   default            offline synthetic embedder (tools/rag_eval/synthetic_embedder.cjs)
//   RAG_EVAL_EMBED_URL OpenAI-compatible base URL of a real provider (…/v1)
//   RAG_EVAL_EMBED_KEY / RAG_EVAL_EMBED_MODEL / RAG_EVAL_EMBED_DIMENSIONS
//   RAG_EVAL_EMBED_DELAY_MS adds artificial latency to the synthetic provider.
// Usage: node tools/rag_eval/flashback_rag_eval.cjs [fixture.json] [--json out.json] [--arg name=value ...]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const synthetic = require('./synthetic_embedder.cjs');

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fixturePath = argv.find(value => value.endsWith('.json') && argv[argv.indexOf(value) - 1] !== '--json')
  || path.join(__dirname, '../../tests/fixtures/rag_eval_ko_v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const pluginPath = process.env.RAG_EVAL_FLASHBACK || path.join(__dirname, '../../plugins/Flashback_Memory.js');
const realUrl = String(process.env.RAG_EVAL_EMBED_URL || '').replace(/\/+$/, '');
const delayMs = Math.max(0, Number(process.env.RAG_EVAL_EMBED_DELAY_MS || 0));
const FAKE_BASE = 'https://rag-eval.invalid/v1';
// RAG_EVAL_QUERY_FAILURE=error|slow simulates a provider outage or a 10 s stall
// during the question phase only (stored document vectors stay valid).
const queryFailure = String(process.env.RAG_EVAL_QUERY_FAILURE || '');
let questionPhase = false;

const src = fs.readFileSync(pluginPath, 'utf8');
// Blank ARGs mean product defaults; only the evaluator's own boundary is set.
const args = {};
Object.assign(args, {
  memory_suite_server_mode: 'plugin_only', mode: 'normal', enable_gui: 'false', debug_log: 'false', operation_log_enabled: 'false',
  embedding_provider: 'openai_compat',
  embedding_url: realUrl || FAKE_BASE,
  embedding_model: realUrl ? String(process.env.RAG_EVAL_EMBED_MODEL || 'text-embedding-3-small') : synthetic.name,
  embedding_key: realUrl ? String(process.env.RAG_EVAL_EMBED_KEY || '') : 'offline-eval-key',
  embedding_dimensions: realUrl ? String(process.env.RAG_EVAL_EMBED_DIMENSIONS || '0') : String(synthetic.DIM)
});
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--arg') { const [k, ...v] = String(argv[i + 1] || '').split('='); args[k] = v.join('='); }

let lastWriteAt = Date.now();
const makeStore = () => { const map = new Map(); return { __map: map, getItem: async k => map.has(String(k)) ? map.get(String(k)) : null, setItem: async (k, v) => { lastWriteAt = Date.now(); map.set(String(k), v); return true; }, removeItem: async k => { map.delete(String(k)); return true; }, keys: async () => [...map.keys()], length: async () => map.size, clear: async () => { map.clear(); return true; } }; };
const localPluginStorage = makeStore();
const handlers = { beforeRequest: [], afterRequest: [], chatOutput: [], scriptOutput: [] };
const network = { embeddingCalls: 0, embeddingInputs: 0, embeddingMs: 0 };
const liveChat = { id: 'chat-rag-eval', name: 'RAG eval', message: [], fmIndex: -1 };
const character = { name: '사서', chaId: 'char-rag-eval', id: 'char-rag-eval', chats: [liveChat], chat: liveChat, chatPage: 0 };
let seq = 0;
const push = (role, data) => liveChat.message.push({ role, data, chatId: `m-${++seq}` });
const noop = async () => {};
let uiSeq = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const embedRequest = async (url, init = {}) => {
  const started = performance.now();
  try {
    if (realUrl) {
      if (!String(url).startsWith(realUrl)) throw new Error('RAG_EVAL_UNEXPECTED_ENDPOINT ' + url);
      return await fetch(url, init);
    }
    if (String(url) !== FAKE_BASE + '/embeddings') throw new Error('RAG_EVAL_UNEXPECTED_ENDPOINT ' + url);
    if (questionPhase && queryFailure === 'error') return new Response(JSON.stringify({ error: { message: 'rag-eval simulated outage' } }), { status: 503 });
    if (questionPhase && queryFailure === 'slow') await sleep(10000);
    const body = JSON.parse(String(init.body || '{}'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    network.embeddingInputs += inputs.length;
    if (delayMs) await sleep(delayMs);
    return new Response(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: synthetic.embed(text) })) }), { status: 200 });
  } finally { network.embeddingCalls += 1; network.embeddingMs += performance.now() - started; }
};

const Risuai = {
  apiVersion: '3.0', apiVersionCompatibleWith: ['3.0'],
  getArgument: async k => k in args ? args[k] : undefined, getArg: async k => k in args ? args[k] : undefined,
  setArgument: async (k, v) => { args[k] = v; return true; }, setArg: async (k, v) => { args[k] = v; return true; },
  pluginStorage: makeStore(), safeLocalStorage: makeStore(), getLocalPluginStorage: async () => localPluginStorage,
  addRisuChatListener: async (event, fn) => { if (event === 'output') handlers.chatOutput.push(fn); return true; },
  removeRisuChatListener: async () => true,
  addRisuReplacer: async (hook, fn) => { if (hook === 'beforeRequest') handlers.beforeRequest.push(fn); if (hook === 'afterRequest') handlers.afterRequest.push(fn); return true; },
  removeRisuReplacer: async () => true,
  addRisuScriptHandler: async (mode, fn) => { if (mode === 'output') handlers.scriptOutput.push(fn); return true; },
  removeRisuScriptHandler: async () => true, addTTSPreprocessor: noop, addTTSPostprocessor: noop,
  registerSetting: async () => ({ id: `ui-${++uiSeq}` }), registerButton: async () => ({ id: `ui-${++uiSeq}` }), unregisterUIPart: noop,
  showContainer: noop, hideContainer: noop, onUnload: async () => true, loadPlugins: noop,
  addPluginChannelListener: async () => () => {}, removePluginChannelListener: async () => true, unregisterPluginChannelListener: async () => true,
  postPluginChannelMessage: async () => null, sendPluginChannelMessage: async () => null,
  nativeFetch: embedRequest,
  risuFetch: async () => { throw Object.assign(new Error('network blocked by evaluator'), { code: 'RAG_EVAL_NET_BLOCKED' }); },
  runLLMModel: async () => { throw new Error('RAG evaluator never calls a generation model'); },
  getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'node-rag-eval', saveMethod: 'memory' }),
  getCharacter: async () => character, getChar: async () => character, setCharacter: noop, setChar: noop,
  getCharacterFromIndex: async () => character, setCharacterToIndex: noop,
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, getChatFromIndex: async () => liveChat,
  setChatToIndex: async (_c, _i, chat) => { if (Array.isArray(chat?.message)) liveChat.message = chat.message; return true; },
  getDatabase: async () => null, setDatabase: noop, setDatabaseLite: noop, getRootDocument: async () => null,
  createMutationObserver: async () => ({ observe() {}, disconnect() {} }),
  addProvider: async () => true, registerMCP: async () => true, unregisterMCP: noop,
  registerBodyIntercepter: async () => ({ id: `ui-${++uiSeq}` }), unregisterBodyIntercepter: noop, requestPluginPermission: async () => true,
  getFetchLogs: async () => [], readImage: async () => null, saveAsset: async () => null, readInlay: async () => null,
  unwarpSafeArray: async value => Array.isArray(value) ? value : [], searchTranslationCache: async () => [], getTranslationCache: async () => null,
  changeColorScheme: noop, getColorScheme: async () => ({ name: 'dark', scheme: {} }), setColorScheme: noop, changeTextTheme: noop,
  getTextTheme: async () => ({ name: 'standard', customTheme: {} }), setCustomTextTheme: noop
};
for (const name of ['Risuai', 'RisuAI', 'risuai', 'risuApi', 'risuAPI']) globalThis[name] = Risuai;
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
const quiet = console.warn; console.warn = () => {}; const quietLog = console.log; console.log = () => {};

const content = message => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.map(part => typeof part === 'string' ? part : part?.text || '').join('\n') : String(message?.content || '');
const transcript = () => [{ role: 'system', content: '너는 이야기의 진행자다.' }, ...liveChat.message.map(m => ({ role: m.role === 'char' ? 'assistant' : 'user', content: m.data }))];
const before = async messages => { let out = messages; for (const fn of handlers.beforeRequest) { const next = await fn(out, 'model'); if (Array.isArray(next)) out = next; } return out; };

async function runTurn(user, assistant) {
  push('user', user);
  await before(transcript());
  push('char', assistant);
  for (const fn of handlers.afterRequest) await fn(assistant, 'model');
  const messageIndex = liveChat.message.length - 1;
  for (const fn of handlers.chatOutput) await fn({ char: character, chat: liveChat, characterIndex: 0, chatIndex: 0, messageIndex });
  for (const fn of handlers.scriptOutput) { try { await fn(assistant, 'output'); } catch (_) {} }
  await sleep(Number(process.env.RAG_EVAL_TURN_SETTLE_MS || 300));
}

const percentile = (values, p) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]; };

async function main() {
  vm.runInThisContext(src, { filename: pluginPath });
  await sleep(1500);
  if (!handlers.beforeRequest.length) throw new Error('Flashback hooks were not registered');
  for (const [user, assistant] of fixture.turns) await runTurn(user, assistant);
  // Flashback finalizes a turn after ~4 s of stability and then embeds episode
  // records in the background. Start questions only once storage is quiet.
  for (const deadline = Date.now() + 60000; Date.now() < deadline && Date.now() - lastWriteAt < 3000;) await sleep(250);
  const captureEmbeddingCalls = network.embeddingCalls;
  questionPhase = true;
  const results = [];
  for (const question of fixture.questions) {
    const messages = transcript().concat([{ role: 'user', content: question.q }]);
    const inputs = new Set(messages.map(content));
    const callsBefore = network.embeddingCalls;
    const started = performance.now();
    const out = await before(messages);
    const elapsedMs = performance.now() - started;
    const injected = out.map(content).filter(text => !inputs.has(text)).join('\n');
    if (process.env.RAG_EVAL_DUMP === question.id) {
      // RAG_EVAL_DUMP=<question id> prints the delivered memory and Flashback's last recall diagnostics.
      const lastRecall = globalThis.__FlashbackMemory?._test?.pendingCaptureRuntimeSnapshot?.()?.lastRecall || {};
      process.stderr.write(`\n--- injected ${question.id}\n${injected}\n---\n`);
      process.stderr.write(JSON.stringify(lastRecall, (key, value) => Array.isArray(value) && value.length > 8 ? value.slice(0, 8) : value, 1) + '\n');
    }
    const found = question.expect.filter(needle => injected.includes(needle));
    results.push({ id: question.id, family: question.family, hit: found.length === question.expect.length, partial: found.length > 0,
      found: found.length, expected: question.expect.length, injectedChars: injected.length, elapsedMs: Math.round(elapsedMs),
      embeddingCalls: network.embeddingCalls - callsBefore });
    await sleep(150);
  }
  console.log = quietLog; console.warn = quiet;
  const families = {};
  for (const row of results) {
    const bucket = families[row.family] ||= { questions: 0, hits: 0 };
    bucket.questions += 1; bucket.hits += row.hit ? 1 : 0;
  }
  for (const bucket of Object.values(families)) bucket.hitRate = +(bucket.hits / bucket.questions).toFixed(3);
  const latency = results.map(row => row.elapsedMs);
  const report = {
    schema: 'memory-suite.rag-eval-report.v1', plugin: 'Flashback_Memory', fixture: path.basename(fixturePath),
    embedder: realUrl ? { kind: 'real', url: realUrl, model: args.embedding_model } : { kind: 'synthetic', model: synthetic.name, delayMs, queryFailure: queryFailure || null },
    overrides: argv.filter((v, i) => argv[i - 1] === '--arg'),
    hitRate: +(results.filter(row => row.hit).length / results.length).toFixed(3),
    partialRate: +(results.filter(row => row.partial).length / results.length).toFixed(3),
    families,
    latencyMs: { p50: percentile(latency, 50), p95: percentile(latency, 95), max: Math.max(...latency) },
    avgInjectedChars: Math.round(results.reduce((sum, row) => sum + row.injectedChars, 0) / results.length),
    embedding: { captureCalls: captureEmbeddingCalls, recallCallsPerQuestion: +((network.embeddingCalls - captureEmbeddingCalls) / results.length).toFixed(2) },
    results
  };
  const jsonPath = option('--json');
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ ...report, results: undefined, misses: results.filter(row => !row.hit).map(row => row.id) }, null, 2) + '\n');
  process.exit(0);
}
main().catch(error => { console.log = quietLog; console.error(error); process.exit(1); });
