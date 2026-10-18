'use strict';
// Flashback GUI data check, step 1: write real Flashback data through its write paths with a REAL
// embedding provider, then save the host state for the browser renderer
// (flashback_gui_browser_render.cjs). Flashback makes no generation-model call.
//
//   turns 1-6   existing chat history      -> ingestLiveChatColdStart (existing-chat import)
//   turns 7-10  live turns                 -> beforeRequest / afterRequest / chat output capture
//   embedding   pending embedding queue    -> real provider vectors
//   maintenance runMemoryMaintenance('sync'), then a final embedding pass
//   manual      deleteManualEditorRecords  -> one record deleted from the editor
//   recall      one beforeRequest question -> recall packet (in-memory; re-run by the renderer)
//
// Env: RAG_EVAL_EMBED_URL (…/v1), RAG_EVAL_EMBED_KEY or VOYAGE_KEY, RAG_EVAL_EMBED_MODEL.
// Usage: node tools/rag_eval/flashback_gui_embed_check.cjs --state out.json
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..', '..');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rag_eval_ko_v1.json'), 'utf8'));
const embedUrl = String(process.env.RAG_EVAL_EMBED_URL || '').replace(/\/+$/, '');
const embedKey = process.env.RAG_EVAL_EMBED_KEY || process.env.VOYAGE_KEY || '';
const statePath = process.argv[process.argv.indexOf('--state') + 1];
if (!embedUrl || !embedKey || !process.argv.includes('--state')) { console.error('RAG_EVAL_EMBED_URL, an embedding key and --state are required'); process.exit(2); }

const args = {
  memory_suite_server_mode: 'plugin_only', mode: 'normal', enable_gui: 'false', debug_log: 'false',
  embedding_provider: 'openai_compat', embedding_url: embedUrl, embedding_model: process.env.RAG_EVAL_EMBED_MODEL || 'voyage-4-large',
  embedding_key: embedKey, embedding_dimensions: '0'
};
let lastActivityAt = Date.now();
const makeStore = () => { const map = new Map(); return { __map: map,
  getItem: async k => map.has(String(k)) ? map.get(String(k)) : null,
  setItem: async (k, v) => { lastActivityAt = Date.now(); map.set(String(k), v); return true; },
  removeItem: async k => { lastActivityAt = Date.now(); map.delete(String(k)); return true; },
  keys: async () => [...map.keys()], clear: async () => { map.clear(); return true; } }; };
const pluginStorage = makeStore(), safeLocalStorage = makeStore(), localPluginStorage = makeStore();
const handlers = { beforeRequest: [], afterRequest: [], chatOutput: [] };
const chat = { id: 'chat-fb-gui', name: '항구 마을 이야기', message: [], fmIndex: -1 };
const character = { name: '유나', chaId: 'char-fb-gui', id: 'char-fb-gui', chats: [chat], chat, chatPage: 0 };
let seq = 0;
const push = (role, data) => chat.message.push({ role, data, chatId: `m-${++seq}` });
const network = { embeddingCalls: 0, embeddingInputs: 0 };
const noop = async () => {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const Risuai = {
  apiVersion: '3.0', apiVersionCompatibleWith: ['3.0'],
  getArgument: async k => k in args ? args[k] : undefined, getArg: async k => k in args ? args[k] : undefined,
  setArgument: async (k, v) => { args[k] = v; return true; }, setArg: async (k, v) => { args[k] = v; return true; },
  pluginStorage, safeLocalStorage, getLocalPluginStorage: async () => localPluginStorage,
  addRisuChatListener: async (event, fn) => { if (event === 'output') handlers.chatOutput.push(fn); return true; }, removeRisuChatListener: async () => true,
  addRisuReplacer: async (hook, fn) => { if (handlers[hook]) handlers[hook].push(fn); return true; }, removeRisuReplacer: async () => true,
  addRisuScriptHandler: async () => true, removeRisuScriptHandler: async () => true,
  registerSetting: async () => ({ id: 'ui-1' }), registerButton: async () => ({ id: 'ui-2' }), unregisterUIPart: noop,
  showContainer: noop, hideContainer: noop, onUnload: async () => true,
  addPluginChannelListener: async () => () => {}, removePluginChannelListener: async () => true, unregisterPluginChannelListener: async () => true,
  postPluginChannelMessage: async () => null,
  nativeFetch: async (url, init = {}) => {
    if (!String(url).startsWith(embedUrl)) throw new Error('unexpected endpoint ' + url);
    network.embeddingCalls += 1;
    try { network.embeddingInputs += [].concat(JSON.parse(String(init.body || '{}')).input || []).length; } catch (_) {}
    lastActivityAt = Date.now();
    try { return await fetch(url, init); } finally { lastActivityAt = Date.now(); }
  },
  runLLMModel: async () => { throw new Error('Flashback never calls a generation model'); },
  getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'node', saveMethod: 'memory' }),
  getCharacter: async () => character, getChar: async () => character, getCharacterFromIndex: async () => character,
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, getChatFromIndex: async () => chat,
  setChatToIndex: async () => true, getDatabase: async () => null, setDatabase: noop, getRootDocument: async () => null,
  createMutationObserver: async () => ({ observe() {}, disconnect() {} })
};
for (const name of ['Risuai', 'RisuAI', 'risuai']) globalThis[name] = Risuai;
globalThis.window = globalThis.window || globalThis;
const quietWarn = console.warn, quietLog = console.log; console.warn = () => {}; console.log = () => {};
const say = (...parts) => quietLog(...parts);

const transcript = () => [{ role: 'system', content: '너는 이야기의 진행자다.' }, ...chat.message.map(m => ({ role: m.role === 'char' ? 'assistant' : 'user', content: m.data, memo: m.chatId }))];
const before = async messages => { let out = messages; for (const fn of handlers.beforeRequest) { const next = await fn(out, 'model'); if (Array.isArray(next)) out = next; } return out; };
const quiet = async (limitMs = 180000) => { for (const deadline = Date.now() + limitMs; Date.now() < deadline && Date.now() - lastActivityAt < 4000;) await sleep(250); };
const liveTurn = async (user, assistant) => {
  push('user', user); await before(transcript());
  push('char', assistant);
  for (const fn of handlers.afterRequest) await fn(assistant, 'model');
  for (const fn of handlers.chatOutput) await fn({ char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: chat.message.length - 1 });
  await sleep(300);
};

(async () => {
  const report = { stages: {} };
  for (const [user, assistant] of fixture.turns.slice(0, 6)) { push('user', user); push('char', assistant); }
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'plugins', 'Flashback_Memory.js'), 'utf8'), { filename: 'Flashback_Memory.js' });
  for (const started = Date.now(); !globalThis.__FlashbackMemory?._test && Date.now() - started < 20000;) await sleep(100);
  await sleep(1500);
  const api = globalThis.__FlashbackMemory;
  const records = async () => { const scope = await api.resolveCurrentScope(); const loaded = await api._test.loadScopeRecords(scope.scopeKey, { readOnly: true }); return Array.from(loaded?.records || loaded?.recordsList || []); };
  const counts = list => ({ total: list.length, vectors: list.filter(r => Array.isArray(r.vector) && r.vector.length).length,
    bySource: list.reduce((acc, r) => { const k = r.sourceType || 'other'; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    turns: [...new Set(list.map(r => Number(r.turnIndex ?? r.pairIndex ?? 0)))].sort((a, b) => a - b) });

  report.stages.import = await api.ingestLiveChatColdStart({ scope: 'current', canonical: true }).then(r => ({ ok: r?.ok !== false, imported: r?.imported ?? r?.added ?? r?.records, reason: r?.reason }), e => ({ ok: false, error: String(e?.message || e) }));
  await quiet();
  for (const [user, assistant] of fixture.turns.slice(6, 10)) await liveTurn(user, assistant);
  await quiet();
  report.stages.embedding = await api.processPendingEmbeddingQueue({ maxSources: 64, maxRequests: 32 }).then(r => ({ ok: r?.ok !== false, embedded: r?.embedded ?? r?.processed, remaining: r?.remaining, reason: r?.reason }), e => ({ ok: false, error: String(e?.message || e) }));
  await quiet();
  report.stages.maintenance = await api.runMemoryMaintenance('sync').then(r => ({ ok: r?.ok !== false, mode: r?.mode, summary: String(r?.summary || r?.message || '').slice(0, 200) }), e => ({ ok: false, error: String(e?.message || e) }));
  await quiet();
  // Maintenance may re-commit a live turn as a new revision; embed it like the automatic start would.
  report.stages.embeddingFinal = await api.processPendingEmbeddingQueue({ maxSources: 64, maxRequests: 32 }).then(r => ({ ok: r?.ok !== false, ready: r?.ready, failed: r?.failed, reason: r?.reason }), e => ({ ok: false, error: String(e?.message || e) }));
  await quiet();
  const editor = await api.listManualEditorRecords();
  const rows = Array.from(editor?.records || editor?.rows || editor || []);
  const target = rows.find(row => /비단/.test(JSON.stringify(row))) || rows[0];
  const targetKey = target?.key || target?.recordKey || target?.id;
  report.stages.manualDelete = targetKey
    ? await api.deleteManualEditorRecords([targetKey]).then(r => ({ ok: r?.ok !== false, key: targetKey, deleted: r?.deleted ?? r?.count, reason: r?.reason }), e => ({ ok: false, key: targetKey, error: String(e?.message || e) }))
    : { ok: false, reason: 'no editor rows', editorKeys: Object.keys(editor || {}) };
  await quiet();
  const question = '유나가 처음에 추천한 숙소는 어디였지?';
  const asked = [...transcript(), { role: 'user', content: question }];
  const inputs = new Set(asked.map(m => String(m.content || '')));
  const out = await before(asked);
  // Messages Flashback added or rewrote around the request carry the recalled memory.
  const injected = out.map(m => String(m.content || '')).filter(t => !inputs.has(t)).join('\n');
  report.stages.recall = { question, injectedChars: injected.length, mentionsLighthouseInn: /등대 여관/.test(injected), lastRecall: !!api._test.Runtime?.lastRecall };
  const finalRecords = await records().catch(() => []);
  report.records = counts(finalRecords);
  report.network = network;
  // The synced credential copy is redacted; the renderer supplies the key on the Node side only.
  const dump = store => [...store.__map.entries()].map(([k, v]) => /embedding_secret/.test(k) ? [k, null] : [k, v]).filter(([, v]) => v !== null);
  const publicArgs = Object.entries(args).map(([k, v]) => [k, k === 'embedding_key' ? '' : v]);
  fs.writeFileSync(statePath, JSON.stringify({ chat, character: { id: character.id, name: character.name },
    pluginStorage: dump(pluginStorage), safeLocalStorage: dump(safeLocalStorage), localPluginStorage: dump(localPluginStorage),
    arguments: publicArgs, report }, null, 1));
  say(JSON.stringify(report, null, 1));
  process.exit(0);
})().catch(error => { quietWarn(error); process.exit(1); });
