'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out while loading LIBRA provenance-rescue runtime.');
};

const store = new Map();
let unload = null;
const storage = {
  async getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
  async setItem(key, value) { store.set(String(key), value); return true; },
  async removeItem(key) { store.delete(String(key)); return true; },
  async keys() { return Array.from(store.keys()); }
};
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getLocalPluginStorage() { return storage; },
  async getArgument(name) {
    const key = String(name);
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch() { throw new Error('no server'); },
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
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  AbortController, URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
  performance: globalThis.performance, Blob: globalThis.Blob,
  atob: globalThis.atob, btoa: globalThis.btoa
});

const ref = (start, id, digest) => ({
  key: `libra:v1:scope:test:memory:${start}:r1`, status: 'committed',
  memoryId: id, revision: 1, sourceDigest: digest,
  turnRange: { start, end: start + 4 }, sessionEpoch: 0
});
const m1 = ref(1, 'm1', 'd1');
const m2 = ref(6, 'm2', 'd2');
const m3 = ref(11, 'm3', 'd3');
const manifest = {
  memories: { 1: m1, 6: m2, 11: m3 }, inheritedMemories: [],
  branchGuard: { schema: 'libra.branch_guard.v1', status: 'ready', batchSignatures: [], verifiedStarts: [] }
};
const evidence = row => ({
  memoryId: row.memoryId, revision: row.revision, sessionEpoch: 0,
  turnRange: row.turnRange, sourceDigest: row.sourceDigest
});
const e1 = evidence(m1), e2 = evidence(m2), e3 = evidence(m3);
const ready = ev => ({ status: 'ready', sessionEpoch: 0, throughTurn: ev.turnRange.end, evidence: ev });

const baseHead = {
  status: 'ready', throughTurn: 15,
  domainStatus: { characters: ready(e3), relationships: ready(e3), world: ready(e3) },
  characters: [
    {
      id: 'c-sea', name: '세아', aliases: ['Se-a'],
      state: { location: '아르주나', emotion: '불안함', knowledge: '봉인 열쇠의 정체를 알고 있음' },
      fieldEvidence: { location: e1, emotion: e2, knowledge: e3 }, evidence: e3
    },
    {
      id: 'c-pudding', name: '푸딩', aliases: ['Pudding'], state: { location: '중앙 홀' },
      fieldEvidence: { location: e2 }, evidence: e2
    }
  ],
  relationships: [
    { id: 'r1', subjectId: 'c-sea', subjectName: '세아', targetId: 'c-pudding', targetName: '푸딩', dimension: 'trust', state: '서로를 신뢰함', evidence: e2 }
  ],
  world: [
    { id: 'w1', kind: 'object', name: '봉인 열쇠', aliases: ['열쇠'], state: { location: '세아의 주머니' }, fieldEvidence: { location: e3 }, evidence: e3 }
  ]
};

(async () => {
  vm.runInContext(source, context, { filename: 'LIBRA.js' });
  const api = await waitFor(() => context.__LIBRA__);
  assert.equal(api.version, releaseVersion('libra'));

  const location = api.debugClassicProvenanceRescueFromHead(baseHead, manifest, '세아는 지금 어디 있어?');
  assert.equal(location.active, true);
  assert.equal(location.rawStateInjected, false);
  assert.equal(location.selected.length, 1);
  assert.equal(location.selected[0].memoryId, 'm1', 'location query follows the location field provenance, not the newest unrelated state field');
  assert.equal(location.selected[0].matches[0].field, 'location');
  assert.equal(JSON.stringify(location).includes('아르주나'), false, 'raw derived state value must never be copied into the rescue plan');

  const knowledge = api.debugClassicProvenanceRescueFromHead(baseHead, manifest, '세아가 봉인 열쇠의 비밀을 지금 알고 있어?');
  assert.equal(knowledge.active, true);
  assert.equal(knowledge.selected[0].memoryId, 'm3');
  assert.ok(knowledge.selected[0].matches.some(row => row.field === 'knowledge'));

  const relation = api.debugClassicProvenanceRescueFromHead(baseHead, manifest, '지금 세아와 푸딩은 서로 신뢰해?');
  assert.equal(relation.active, true);
  assert.ok(relation.selected.some(row => row.memoryId === 'm2'));
  assert.ok(relation.selected.flatMap(row => row.matches).some(row => row.domain === 'relationships' && row.dimension === 'trust'));

  const world = api.debugClassicProvenanceRescueFromHead(baseHead, manifest, '봉인 열쇠는 지금 어디 있어?');
  assert.equal(world.active, true);
  assert.ok(world.selected.some(row => row.memoryId === 'm3'));
  assert.ok(world.selected.flatMap(row => row.matches).some(row => row.domain === 'world' && row.field === 'location'));

  const pastOnly = api.debugClassicProvenanceRescueFromHead(baseHead, manifest, '세아는 예전에 어디 있었어?');
  assert.equal(pastOnly.active, false, 'past-only questions must not be contaminated by current-state provenance rescue');
  assert.equal(pastOnly.historicalOnly, true);

  const unrelated = api.debugClassicProvenanceRescueFromHead(baseHead, manifest, '지금 민지는 어디 있어?');
  assert.equal(unrelated.active, false, 'unmatched entity must not drag in an unrelated current-state memory');

  const boundaryHead = structuredClone(baseHead);
  boundaryHead.characters.push({
    id: 'c-short-name', name: '도현', aliases: ['Alice'], state: { location: '정원' },
    fieldEvidence: { location: e1 }, evidence: e1
  });
  const partialName = api.debugClassicProvenanceRescueFromHead(boundaryHead, manifest, '도현욱은 지금 어디 있어?');
  assert.equal(partialName.active, false,
    'a longer Korean name must not force-rescue the shorter person\'s canonical evidence');
  const fullName = api.debugClassicProvenanceRescueFromHead(boundaryHead, manifest, '도현은 지금 어디 있어?');
  assert.equal(fullName.active, true, 'a complete Korean name may rescue its own source evidence');
  assert.ok(fullName.selected.flatMap(row => row.matches).some(row => row.entity === '도현'));
  const latinAlias = api.debugClassicProvenanceRescueFromHead(boundaryHead, manifest, 'alice는 지금 어디 있어?');
  assert.equal(latinAlias.active, true, 'a confirmed Latin alias followed by a Korean particle remains a full mention');

  const partialHead = structuredClone(baseHead);
  partialHead.domainStatus.characters = { status: 'not_updated', sessionEpoch: 0, throughTurn: 10, evidence: e2, attemptedEvidence: e3 };
  const partial = api.debugClassicProvenanceRescueFromHead(partialHead, manifest, '세아는 지금 어디 있어?');
  assert.equal(partial.active, false, 'non-ready state domains are last-known only and cannot drive current-state rescue');

  if (unload) await unload();
  process.stdout.write('libra_classic_provenance_rescue_runtime_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
