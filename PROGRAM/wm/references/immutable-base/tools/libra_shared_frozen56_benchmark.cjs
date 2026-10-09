'use strict';
// Offline compatibility adapter. Gold never enters the product/runtime adapter.
// This first baseline maps packet summary_memory to native WM memory entries.
// It does not claim model generation, full packet ingestion, or semantic quality.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { load } = require('./libra_recall_test_runtime.cjs');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'C:/Users/rusin/AppData/Local/Temp/LIB-SearchAcceleration-20261002/benchmark';
const FIXTURE = 'C:/Users/rusin/Desktop/LIB/LIB/Librarian-System/PROGRAM/tests/fixtures/hayaku_runtime_harness.cjs';
const RUNNER = path.join(BASE, 'frozen-runner-fef4e60bbfd1.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const clone = data => JSON.parse(JSON.stringify(data));
const verified = (file, expected) => assert.equal(hash(fs.readFileSync(file)), expected, 'shared fixture hash: ' + file);
function recipe() {
  verified(RUNNER, 'fef4e60bbfd1f32d552fbbfc6974552e090985bd7bd73dbbfdc161c58ce1601a');
  verified(FIXTURE, '190f35784dd687a5a295e5b5d122713e55a97e4b06192754350f6442f596edb6');
  const frozen = require(RUNNER);
  assert.equal(hash(JSON.stringify(frozen.gold)), '9b9a9c2d00876f288375e31e68a0eacf01fd010e1d81f4ade5f2ee4fb0a80c68');
  return frozen;
}
function diskStore(root) {
  fs.mkdirSync(root, { recursive: true });
  const stats = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0, removes: 0 };
  const filename = key => path.join(root, hash(String(key)) + '.json');
  return { root, stats,
    async getItem(key) { stats.reads++; const f = filename(key); if (!fs.existsSync(f)) return null;
      const bytes = fs.readFileSync(f); stats.readBytes += bytes.length;
      const value = JSON.parse(bytes.toString('utf8')); assert.equal(value.key, key); return value.value; },
    async setItem(key, value) { const bytes = Buffer.from(JSON.stringify({ key, value: String(value) }));
      const f = filename(key), temp = f + '.new', fd = fs.openSync(temp, 'w');
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, f); stats.writes++; stats.writeBytes += bytes.length; return true; },
    async removeItem(key) { const f = filename(key); if (fs.existsSync(f)) fs.unlinkSync(f); stats.removes++; return true; }
  };
}
// Structural field conversion only. No query, expected marker, ID, or scale input.
function memoryCorpus(rows, chatId) {
  const entries = [];
  let turn = 0;
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    turn++;
    const raw = String(row.data || '').match(/<!-- HAYAKU_STATE_PACKET_START ([\s\S]*?) HAYAKU_STATE_PACKET_END -->/);
    assert.ok(raw, 'source assistant packet must be parseable');
    const packet = JSON.parse(raw[1]), text = packet.meta?.summary_memory?.summary;
    assert.equal(typeof text, 'string');
    const meta = { t: turn, ttl: -1, imp: Number(packet.importance?.overall ?? 0) * 10,
      cat: 'event', ent: clone(packet.meta.summary_memory.mentionedEntityNames || []),
      summary: text, s_id: chatId, sourceMessageIds: [row.chatId], sourceTextHash: hash(row.data) };
    entries.push({ key: 'lmai_memory::' + row.chatId, comment: 'lmai_memory', content: '[META:' + JSON.stringify(meta) + ']\n' + text });
  }
  return entries;
}
async function startAdapter(rows, scope, store, dist, importSource = true, options = {}) {
  const chat = { id: scope, chatId: scope, bindedPersona: 'wm-frozen-persona', localLore: [], message: clone(rows), isStreaming: false };
  const char = { id: 'wm-frozen-character', name: 'WM frozen corpus', chatPage: 0, chats: [chat], globalLore: [], lorebook: [] };
  const timers = new Set(), intervals = new Set(), callbacks = {}, calls = { actualModel: 0, blockedTransport: 0 };
  const rejectNetwork = async () => { calls.blockedTransport++; throw new Error('WM_SHARED_GOLD_NETWORK_FORBIDDEN'); };
  const host = { apiVersion: '3.0-test', async getRuntimeInfo() { return { apiVersion: '3.0-test' }; },
    async getArgument(key) { return key === 'embedding_enabled' ? 'false' : key === 'debug' ? 'false' : key === 'activity_dashboard' ? 'off' : undefined; },
    async requestPluginPermission() { return true; }, async getCharacter() { return clone(char); },
    async getCharacterFromIndex() { return clone(char); }, async getChatFromIndex() { return clone(chat); },
    async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
    async getDatabase() { return { personas: [{ id: 'wm-frozen-persona', name: 'Archivist persona', personaPrompt: 'Archive observer.' }], selectedPersona: 0 }; },
    async setChatToIndex(_a, _b, next) { Object.assign(chat, clone(next)); char.chats[0] = chat; return true; },
    async setCharacter(next) { Object.assign(char, clone(next)); char.chats[0] = chat; return true; },
    async addRisuReplacer(type, fn) { callbacks[type] = fn; }, async removeRisuReplacer() {},
    async addRisuScriptHandler() {}, async removeRisuScriptHandler() {}, async onUnload() {},
    async registerBodyIntercepter() { return 'wm-frozen'; }, async unregisterBodyIntercepter() {},
    async registerSetting() {}, async registerButton() {}, async showContainer() {}, async hideContainer() {},
    pluginStorage: store, safeLocalStorage: store, async getLocalPluginStorage() { return store; }, nativeFetch: rejectNetwork };
  const r = await load({ dist, globals: { risuai: host, Risuai: host, fetch: rejectNetwork,
    setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); },
    setInterval(fn, ms) { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval(id) { intervals.delete(id); clearInterval(id); } }, transformCode(code) {
      const i = code.lastIndexOf('\n})();'); assert.ok(i > 0);
      return code.slice(0, i) + '\n;globalThis.__WM_SHARED__={entity:EntityManager,corpus:TypedRecallCorpus,rollout:TypedRecallRollout,compat:RisuCompat,processor:EntityAwareProcessor,coordinator:PersonaRuntimeCoordinator,debug:DebugExportManager,active:resolveActiveChatContext};\n' + code.slice(i);
    } });
  const api = r.api, typed = r.context.__WM_SHARED__;
  const install = async (nextRows, nextScope, write = true) => {
    const before = hash(JSON.stringify(nextRows)), at = performance.now();
    chat.id = chat.chatId = nextScope; chat.message = clone(nextRows); chat.localLore = [];
    const entries = memoryCorpus(nextRows, nextScope);
    const canonicalScope = api.LibraDataStorage.scopeKeyFor(char, chat);
    if (write) await typed.compat.pluginStorage.setItem(api.LibraDataStorage.storageKeyFor(canonicalScope), JSON.stringify({ scopeKey: canonicalScope, entries, resetGeneration: 0 }));
    const checked = await api.LibraDataStorage.readVerified(canonicalScope);
    assert.equal(checked.ok, true, checked.reason);
    const expected = !write && options.expectedCanonicalEntries ? options.expectedCanonicalEntries : entries;
    if (options.compareCanonicalRead) options.compareCanonicalRead(checked.entries, expected);
    assert.equal(hash(JSON.stringify(checked.entries)), hash(JSON.stringify(expected)), 'canonical read-back must match the explicitly expected source mapping');
    assert.equal(hash(JSON.stringify(nextRows)), before);
    return { wallMs: performance.now() - at, entryCount: entries.length, sourceSha256: before, canonicalScope, schema: 'summary_memory -> lmai_memory', imported: write, actualGenerationCalls: 0 };
  };
  const ingestion = await install(rows, scope, importSource);
  assert.equal(typeof callbacks.beforeRequest, 'function');
  return { api, typed, char, chat, store, calls, ingestion, install,
    async request(query) { return callbacks.beforeRequest({ messages: [{ role: 'user', content: query }], maxContextTokens: 128000, maxResponseTokens: 4096 }, 'model'); },
    dispose() { typed.rollout.cancelAll(); for (const t of timers) clearTimeout(t); for (const t of intervals) clearInterval(t); }
  };
}
const delta = (a, b) => Object.fromEntries(Object.keys(b).map(k => [k, b[k] - a[k]]));
async function run(n, repeat, output, panelOnly = false) {
  assert.ok(!fs.existsSync(output), 'baseline result must not overwrite earlier evidence');
  const frozen = recipe(), fixture = require(FIXTURE), rowsOut = [], mutations = [];
  const baselineFile = path.join(BASE, `post-56dfa4d-registered-v5-turns${n}-repeat${repeat}-attempt1.json`);
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const schedule = baseline.rows.filter(r => r.kind === 'search');
  const markerUniverse = [...new Set(schedule.flatMap(r => [...r.question.expectedMarkers, ...r.quality.forbiddenMarkers]))];
  // Include all scenario labels, including stale ones absent from a particular run.
  for (const suffix of ['A0', 'A1', 'B0', 'B2', 'C0', 'D1', 'FA', 'FB', 'FC']) if (!markerUniverse.includes('BENCH_' + suffix)) markerUniverse.push('BENCH_' + suffix);
  let current = frozen.messages(n), scope = 'benchmark-main', adapter = null, phase = '', main = null, sequence = 0;
  const storageRoot = output.replace(/\.json$/, '-store');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const newAdapter = async label => startAdapter(current, scope, diskStore(path.join(storageRoot, label)), path.join(ROOT, 'dist/LIBRA World Manager Full.js'));
  const change = (turn, marker) => { const row = current.find(r => r.chatId === 'a' + turn); assert.ok(row); const body = frozen.packet(turn, marker); row.data = fixture.hiddenPacketMessage(`Entry ${turn} completed: ${body.meta.summary_memory.summary}`, body); };
  try {
    for (const contract of schedule) {
      const nextPhase = contract.phase;
      if (panelOnly && nextPhase !== 'cold') continue;
      if (nextPhase === 'cold') { adapter?.dispose(); adapter = await newAdapter('cold-' + (++sequence)); mutations.push({ phase: nextPhase, ...adapter.ingestion }); }
      else if (nextPhase !== phase) {
        if (nextPhase === 'initial-prepare') { adapter?.dispose(); adapter = await newAdapter('main'); mutations.push({ phase: nextPhase, ...adapter.ingestion }); }
        if (nextPhase === 'add') { const body = frozen.packet(n + 1, 'BENCH_D1'); current.push({ role: 'user', chatId: 'u' + (n + 1), data: 'Archive the Dawn drawer discovery.' }, { role: 'assistant', chatId: 'a' + (n + 1), data: fixture.hiddenPacketMessage(`Entry ${n + 1} completed: ${body.meta.summary_memory.summary}`, body) }); }
        if (nextPhase === 'edit') change(1, 'BENCH_A1');
        if (nextPhase === 'delete') current = current.filter(r => r.chatId !== 'u9' && r.chatId !== 'a9');
        if (nextPhase === 'rollback') current = frozen.messages(n);
        if (nextPhase === 'reroll') change(5, 'BENCH_B2');
        if (nextPhase === 'scope-change') { main = clone(current); current = frozen.messages(n, true); scope = 'benchmark-other'; }
        if (nextPhase === 'scope-return') { current = main; scope = 'benchmark-main'; }
        if (['add','edit','delete','rollback','reroll','scope-change','scope-return'].includes(nextPhase)) mutations.push({ phase: nextPhase, ...await adapter.install(current, scope) });
        if (nextPhase === 'restart-first-panel') { const sameStore = adapter.store; adapter.dispose(); adapter = await startAdapter(current, scope, sameStore, path.join(ROOT, 'dist/LIBRA World Manager Full.js'), false); mutations.push({ phase: nextPhase, ...adapter.ingestion }); }
      }
      phase = nextPhase;
      if (phase.endsWith('-settle-observation')) await new Promise(resolve => setTimeout(resolve, 250));
      const sourceSha256 = hash(JSON.stringify(current)); assert.equal(sourceSha256, contract.sourceSha256, 'shared original phase source mismatch: ' + phase);
      const stats = { ...adapter.store.stats }, before = performance.now(), heapBefore = process.memoryUsage().heapUsed;
      const outputValue = await adapter.request(contract.question.query), wallMs = performance.now() - before;
      assert.equal(hash(JSON.stringify(current)), sourceSha256, 'runtime changed shared source');
      const messages = Array.isArray(outputValue) ? outputValue : outputValue.messages;
      // WM preserves host slot roles: its injected continuity blocks can be user
      // messages. Exclude only the unchanged question, not an entire role.
      const context = messages.filter(r => !(r.role === 'user' && r.content === contract.question.query))
        .map(r => String(r.content || '')).join('\n');
      const trace = adapter.typed.rollout.inspect().last;
      assert.ok(trace?.retrieval, 'registered beforeRequest must execute typed retrieval');
      const blocks = (trace?.consumer?.directBlocks || []).filter(b => b.kind === 'recall' && context.includes(b.identity));
      const records = blocks.map(b => ({ identity: b.identity, family: b.family, roles: b.roles, text: b.text, markers: markerUniverse.filter(m => String(b.text || '').includes(m)) }));
      const expected = contract.question.expectedMarkers, emitted = markerUniverse.filter(m => context.includes(m));
      const allowedPhase = { 'initial-settle-observation': 'initial-prepare', 'add-settle-observation': 'add', 'restart-settle-observation': 'restart-first-panel' }[phase] || phase;
      const allowed = new Set(schedule.find(r => r.phase === allowedPhase && r.question.id === 'archive').question.expectedMarkers);
      const negativeFamily = { aurora: /^BENCH_(?:A|FA)/, borealis: /^BENCH_(?:B|FB)/, cirrus: /^BENCH_(?:C|FC)/, dawn: /^BENCH_(?:D|FD)/ }[contract.question.id];
      const candidateTexts = (trace?.retrieval?.union || []).map(hit => hit.unit?.text || '').join('\n');
      const candidateMisses = expected.filter(m => !candidateTexts.includes(m));
      const quality = { finalHit: expected.length ? expected.every(m => emitted.includes(m)) : !emitted.some(m => negativeFamily?.test(m)),
        expectedMarkers: expected, finalRecall: expected.length ? expected.filter(m => emitted.includes(m)).length / expected.length : null,
        candidateMisses, candidateMiss: candidateMisses.length > 0,
        forbiddenMarkers: emitted.filter(m => !allowed.has(m)),
        emittedRecallAtK: Object.fromEntries([1,5,10,20].map(k => [k, expected.length ? expected.filter(m => records.slice(0,k).some(r => r.markers.includes(m))).length / expected.length : null])) };
      rowsOut.push({ kind: 'search', phase, n, repeat, question: contract.question, sourceSha256, wallMs,
        heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore, storage: delta(stats, adapter.store.stats), quality,
        returnedSha256: hash(JSON.stringify(outputValue)), finalConsumed: { context, records, markers: emitted, messages }, trace,
        controls: { actualModelCalls: adapter.calls.actualModel, blockedTransport: adapter.calls.blockedTransport,
          semantic: 'disabled; no saved real vectors; heuristic execution only', productionPolicy: adapter.api.MemoryEngine.CONFIG.dualRecallPolicyVersion } });
      assert.equal(adapter.calls.blockedTransport, 0, 'unexpected model/network stage attempted');
      fs.writeFileSync(output + '.progress.json', JSON.stringify({ n, repeat, rows: rowsOut.length, phase, wallMs }));
    }
  } finally { adapter?.dispose(); }
  const positives = rowsOut.filter(r => r.question.expectedMarkers.length);
  const summary = { positiveFullGold: positives.filter(r => r.quality.finalHit).length, positiveRequests: positives.length,
    negativeRequests: rowsOut.length - positives.length, forbiddenHits: rowsOut.reduce((s,r) => s + r.quality.forbiddenMarkers.length, 0),
    candidateMissRequests: positives.filter(r => r.quality.candidateMiss).length, requests: rowsOut.length };
  const result = { schema: 'wm.shared-frozen56.memory-compatibility-baseline.v1', n, repeat, helperSha256: hash(fs.readFileSync(__filename)),
    baselineFile, baselineSha256: hash(fs.readFileSync(baselineFile)), sharedRunnerSha256: hash(fs.readFileSync(RUNNER)),
    bundleSha256: hash(fs.readFileSync(path.join(ROOT, 'dist/LIBRA World Manager Full.js'))), summary, mutations, rows: rowsOut,
    limits: ['Same original messages/questions/gold and recorded phase schedule; adapter receives query only, never gold.',
      'Native WM canonical chunk writer/strict read and registered beforeRequest final output; synthetic offline summary memory ingestion.',
      'Entity/world/narrative packet mapping is not covered by this memory-only baseline.',
      'Restart reads the same physical canonical store without re-import; no real semantic index quality is claimed.',
      'Model/retrieval configuration phases replay questions but their HAYAKU setting mutations have no verified WM equivalent yet.',
      'Production WM defaults kept. Request envelope 128000/4096 is the existing admitted WM rollout test host envelope, not a user setting.',
      'No actual generation/embedding calls or synthetic vectors. This is heuristic lexical quality only.'] };
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, ...summary, realModelCalls: 0 }));
  return result;
}
if (require.main === module) {
  const n = Number(process.argv[2] || 10), repeat = Number(process.argv[3] || 1);
  const output = process.argv[4] || path.join(ROOT, 'test-output/wm-resume-20261002/shared-frozen56-memory', `turns${n}-repeat${repeat}.json`);
  run(n, repeat, output, process.argv.includes('--panel')).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { recipe, memoryCorpus, startAdapter, diskStore, run };
