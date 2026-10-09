'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DEFINITIONS, executeOperation } = require('../server/compute/registry.cjs');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins', 'LIBRA.js'), 'utf8');
const operation = 'libra.recall-bm25f.v1';
const fingerprint = DEFINITIONS[operation].fingerprint;

assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.match(source, /const createMemorySuiteComputeBridge\s*=/, 'embedded Compute factory is available to the owner');
assert.doesNotMatch(source, /^\/\/@arg memory_suite_libra_compute_mode\b/m);
assert.match(source, /MemorySuiteStorageBridge\.getScopeExecutionPolicy\(owner\?\.context\?\.scope/);
assert.match(source, /const LIBRA_RECALL_BM25F_COMPUTE_OPERATION = 'libra\.recall-bm25f\.v1'/);
assert.match(source, new RegExp(fingerprint));
assert.match(source, /MemorySuiteLibraComputeBridge\.execute\(/);
assert.match(source, /await bm25fScoresWithCompute\(rows, queryBundle\.sparseText, \{ context, manifest, pairs \}, guard\)/);
assert.match(source, /await LibraMemoryCore\.disposeMemorySuiteCompute/);
assert.equal(DEFINITIONS[operation].fingerprint, fingerprint, 'plugin and server algorithm fingerprints match');

const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out while loading LIBRA BM25F test runtime.');
};
const normalize = value => JSON.parse(JSON.stringify(value));
const values = new Map();
const storage = {
  async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return [...values.keys()]; }
};
let unload = null;
let computeNetworkCalls = 0;
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getLocalPluginStorage() { return storage; },
  async getArgument(name) {
    if (String(name).includes('memory_suite_server_mode')) return 'plugin_only';
    if (String(name).includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return await this.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch(url) {
    if (String(url).includes('/v1/compute/')) computeNetworkCalls += 1;
    throw new Error('offline fixture');
  },
  async onUnload(handler) { unload = handler; return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async addRisuReplacer() { return true; },
  async removeRisuReplacer() { return true; },
  async addRisuChatListener() { return true; },
  async removeRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; },
  async removeRisuScriptHandler() { return true; },
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async postPluginChannelMessage() { return true; }
};
const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  AbortController,
  AbortSignal,
  DOMException,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone,
  performance: globalThis.performance,
  Blob: globalThis.Blob,
  atob: globalThis.atob,
  btoa: globalThis.btoa
});

(async () => {
  vm.runInContext(source, context, { filename: 'LIBRA.js' });
  const api = await waitFor(() => context.__LIBRA__);
  assert.equal(api.version, releaseVersion('libra'));
  const rows = [
    {
      id: 'memory-1:r1',
      memory: {
        retrieval: { sparseFields: {
          summary: '왕립 아카데미의 마법 금지 규칙',
          recall_keys: 'academy law human only',
          characters_relations: '린과 교장의 불신',
          narrative_open_threads: '금지된 도서관 조사',
          chronology: '첫째 날 입학식',
          world_scene: '왕도 북부 아카데미',
          facts_uncertainty: '마법은 존재하지 않는다고 공표됨',
          full_text: 'The royal academy forbids magic under the human-only canon law.'
        } }
      },
      ownerMarker: { canonical: true }
    },
    {
      id: 'memory-2:r3',
      memory: {
        retrieval: { sparseFields: {
          summary: '아침 식사와 산책',
          recall_keys: 'tea bread garden',
          characters_relations: '친구와 평온한 대화',
          narrative_open_threads: '',
          chronology: '둘째 날 아침',
          world_scene: '정원',
          facts_uncertainty: '',
          full_text: 'Tea, bread, and a quiet walk through the garden.'
        } }
      },
      ownerMarker: { canonical: true }
    },
    {
      id: 'memory-3:r2',
      memory: {
        retrieval: { sparseFields: {
          summary: '금지 규칙의 예외를 찾는 조사',
          recall_keys: 'forbidden archive academy rule',
          characters_relations: '린과 사서의 비밀 동맹',
          narrative_open_threads: '도서관 봉인 해제',
          chronology: '셋째 날 밤',
          world_scene: '아카데미 지하 기록보관소',
          facts_uncertainty: '마법 흔적의 진위는 미확정',
          full_text: 'A hidden archive may contradict the academy law.'
        } }
      },
      ownerMarker: { canonical: true }
    }
  ];
  const originalRows = normalize(rows);
  const query = '아카데미 마법 금지 규칙과 비밀 도서관 academy forbidden magic law';
  const input = normalize(api.debugBuildRecallBm25fInput(rows, query));
  const local = normalize(api.debugRunRecallBm25fComputeLocal(input));
  const server = normalize(executeOperation(operation, input));
  assert.deepEqual(server, local, 'LIBRA local and server BM25F kernels have exact score/order parity');
  assert.equal(api.debugValidateRecallBm25fComputeResult(server, input), true);
  assert.equal(server.scores[0].id, 'memory-1:r1', 'result preserves canonical input identity');
  assert.ok(server.scores[0].raw > server.scores[1].raw, 'relevant canonical memory outranks routine memory');
  assert.deepEqual(rows, originalRows, 'pure seam never mutates owner rows');
  const scoreEntries = normalize(api.debugRecallBm25fScoresLocal(rows, query));
  assert.deepEqual(scoreEntries, server.scores.map(row => [row.id, { raw: row.raw, normalized: row.normalized, evidence: row.evidence }]));
  assert.equal(api.getMemorySuiteComputeStatus().mode, 'local');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(computeNetworkCalls, 0, 'LIBRA local mode never probes Compute');
  if (unload) await unload();
  process.stdout.write('libra_recall_bm25f_compute_pilot_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_recall_bm25f_compute_pilot_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});

