'use strict';
// 측정: 리롤·롤백된 턴의 **엔티티·관계가 저장에 남는가** (§5-5 판정용).
//
// 배경 (정적 실측):
//   · 엔티티/관계 저장 경로(`08d`/`08h`)에 worldline 검사가 **0곳**.
//   · 엔티티는 `quality.lastUpdatedTurn` 을 갖고, 97턴 하네스가 `entityLastTurn` 을 단언한다.
//   → 턴 기반 되돌리기가 **가능한 구조**다. 실제로 되는지를 측정한다.
//
// 이 프로브는 판정하지 않는다. **무엇이 남는지 그대로 나열**한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL, code.indexOf('const MemoryEngine = (() => {'));
const closeMark = code.indexOf('\n})();', tailAt);
const injectAt = closeMark + '\n})();'.length;
code = code.slice(0, injectAt)
  + '\n;globalThis.__W5__={' + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,"
  + "EntityManager: typeof EntityManager !== 'undefined' ? EntityManager : null,"
  + "EntityAwareProcessor: typeof EntityAwareProcessor !== 'undefined' ? EntityAwareProcessor : null,"
  + "LibraTurnWorldline: typeof LibraTurnWorldline !== 'undefined' ? LibraTurnWorldline : null"
  + '};'
  + code.slice(injectAt);

const ctx = {
  console: { log() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
  structuredClone, AbortController, Buffer, TextEncoder, TextDecoder,
  crypto: { randomUUID: () => 'x' },
  fetch: async () => { throw new Error('no network'); },
  process: { env: {} },
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  performance: { now: () => Date.now() },
  document: { getElementById() { return null; }, createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector() { return null; } }; }, head: { appendChild() {} }, body: { appendChild() {} }, querySelector() { return null; } },
  Risuai: {
    apiVersion: '3.0', async getRuntimeInfo() { return { apiVersion: '3.0' }; }, async getArgument() { return undefined; },
    pluginStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } },
    async getLocalPluginStorage() { const s = { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } }; return { getStore: () => s, ...s }; },
    async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
    async getCharacter() { return null; }, async getChat() { return null; }, async getDatabase() { return { selectedPersona: 0, personas: [] }; },
    async registerSetting() {}, async registerButton() {}, async showContainer() {}, async hideContainer() {},
    addRisuReplacer() {}, addRisuScriptHandler() {}, async onUnload() {}
  }
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { vm.runInContext(code, ctx, { filename: 'libra-bundle.js', timeout: 120000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

const P = ctx.__W5__ || {};
console.log('=== 노출 심볼 ===');
console.log('  MemoryEngine:', !!P.MemoryEngine, '| EntityManager:', !!P.EntityManager);
console.log('  EntityAwareProcessor:', !!P.EntityAwareProcessor, '| LibraTurnWorldline:', !!P.LibraTurnWorldline);
console.log('  runErr:', runErr || '(없음)');

// ── 엔티티 레코드가 무엇을 갖는지 ──
const EM = P.EntityManager;
if (EM) {
  const keys = Object.keys(EM);
  console.log('\n=== EntityManager 키 (쓰기·상태 관련) ===');
  console.log(' ', keys.filter(k => /save|put|upsert|apply|merge|remove|delete|list|get|state/i.test(k)).slice(0, 24).join(', '));
}

// ── 엔티티 스키마에 턴·롤백 표시가 있나 (실제 레코드 생성 경로로 확인) ──
const EAP = P.EntityAwareProcessor;
if (EAP) {
  console.log('\n=== extractFromConversation 이 만든 엔티티 레코드의 필드 ===');
  // 정적 확인: sanitizeEntities 가 어떤 필드를 남기는지
  try {
    const sample = {
      entities: [{ operation: 'add', name: '테스트인물', role: '학생', summary: '요약', confidence: 0.9 }],
      relations: [{ entityA: '테스트인물', entityB: '아리엘', relationType: 'friend', summary: '친구' }],
      world: {}, conflicts: [], uncertain: [], rejected: [], sourceMode: 'x'
    };
    const out = EAP.sanitizeExtractionPayload(sample, [], { sourceMode: 'conversation', conversationText: '테스트' });
    const e = (out?.entities || [])[0];
    if (e) {
      console.log('  엔티티 필드:', Object.keys(e).join(', '));
      console.log('  quality:', JSON.stringify(e.quality || null));
      console.log('  ★ 롤백/턴 표시:', JSON.stringify({
        lastUpdatedTurn: e.quality?.lastUpdatedTurn,
        rollbackState: e.rollbackState,
        status: e.status,
        supersededBy: e.supersededBy
      }));
    } else {
      console.log('  (엔티티 0건 — 표본이 살아남지 않음)');
    }
  } catch (err) {
    console.log('  sanitize 실패:', String(err && err.message || err).slice(0, 160));
  }
}

// ── 관계 ledger 의 status/supersededBy (있는 축) ──
console.log('\n=== 관계에 있는 롤백 축 (실측) ===');
try {
  const sample2 = { relations: [{ entityA: 'A', entityB: 'B', relationType: 'friend', status: 'active', supersededBy: 'x1' }], entities: [], world: {} };
  const out2 = EAP && EAP.sanitizeExtractionPayload(sample2, [], { sourceMode: 'conversation', conversationText: 'A와 B' });
  const r = (out2?.relations || [])[0];
  if (r) console.log('  관계 필드:', Object.keys(r).join(', '));
} catch (_) {}

// ── 엔티티가 턴을 기록하는가 (되돌리기 가능성) ──
console.log('\n=== 엔티티가 턴을 기록하는 경로 ===');
try {
  const srcFiles = ['08d-entity-merge-crud.js', '08h-entity-knowledge-vault.js', '08b-entity-identity-schema.js'];
  for (const f of srcFiles) {
    const t = fs.readFileSync(path.join(ROOT, 'src', 'parts', f), 'utf8');
    const hits = [];
    for (const re of [/lastUpdatedTurn[^\n]{0,60}/g, /currentTurn[^\n]{0,50}/g]) {
      for (const m of t.matchAll(re)) hits.push(m[0].trim().slice(0, 70));
    }
    console.log(`  ${f}: ${hits.length}건`);
    for (const h of hits.slice(0, 3)) console.log('    -', h);
  }
} catch (_) {}
