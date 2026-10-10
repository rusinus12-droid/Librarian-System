'use strict';
// Gate: 월드라인 노드 상태 어휘가 **크로스플러그인 정본**과 일치한다.
//
// 실측된 불일치 (정본 `LIBRA.js` v2.3.144 · `HAYAKU` `recoveryDebtStatusForWorldline` 대조):
//   정본:    active / quarantined / superseded / orphaned / detached
//   내 리포: active / quarantined / inactive_variant / detached_branch / orphaned
//   → 3/5 만 일치. 이름이 갈리면 크로스플러그인 판정(HAYAKU 가 LIBRA 월드라인을 읽는 경로)이 어긋난다.
//
// 계약:
//   V1 상태 집합이 정본 5값과 **정확히** 같다
//   V2 저장 데이터의 **옛 이름은 정본으로 읽힌다** (하위 호환 — 데이터 손실 금지)
//   V3 쓰기 경로가 옛 이름을 만들지 않는다 (신규 데이터는 정본 어휘)
//   V4 표시 라벨은 옛 이름도 그대로 낸다 (구 데이터도 라벨이 나온다)
//   V5 알 수 없는 상태는 orphaned 로 수렴한다 (fail-safe — 정본도 같은 방향)
(async () => {
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC01F = fs.readFileSync(path.join(ROOT, 'src/parts/01f-lore-consolidation.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const injectAt = code.lastIndexOf('})();');
if (injectAt < 0) throw new Error('portable_factory_closure_tail_not_found');
code = code.slice(0, injectAt)
  + '\n;globalThis.__SW__={' + "LibraTurnWorldline: typeof LibraTurnWorldline !== 'undefined' ? LibraTurnWorldline : null" + '};'
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
try { await vm.runInContext(code, ctx, { filename: 'libra-bundle.js', timeout: 120000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// 정본 어휘 — 대조 원본: LIBRA.js `worldlines.main`, HAYAKU `recoveryDebtStatusForWorldline`
const CANONICAL = ['active', 'quarantined', 'superseded', 'orphaned', 'detached'];
const LEGACY = { inactive_variant: 'superseded', detached_branch: 'detached' };

assert('dist_runs_without_error', !runErr, { error: runErr });

const WL = (ctx.__SW__ && ctx.__SW__.LibraTurnWorldline) || null;
assert('worldline_exported', !!WL, { keys: WL ? Object.keys(WL).slice(0, 24) : null });

// ── V1: 01f 소스의 상태 집합이 정본과 정확히 같다 ──
const setMatch = SRC01F.match(/const NODE_STATUSES = new Set\(\[([^\]]+)\]\)/);
const declared = setMatch ? setMatch[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
assert('status_set_matches_canonical',
  declared.length === CANONICAL.length && CANONICAL.every(v => declared.includes(v)),
  { declared, canonical: CANONICAL });

assert('no_legacy_status_writes',
  !/node\.status\s*=\s*'inactive_variant'/.test(SRC01F) && !/node\.status\s*=\s*'detached_branch'/.test(SRC01F)
  && !/status:\s*'inactive_variant'/.test(SRC01F) && !/status:\s*'detached_branch'/.test(SRC01F),
  { note: '신규 데이터는 정본 어휘로만 쓴다' });

// ── V2/V5: 옛 이름이 정본으로 **읽히는가** (실행) ──
//   normalize 는 비공개므로 worldline 상태를 실제로 만들어 읽는다.
const buildState = (statuses) => ({
  version: 'libra.turn.worldline.v1',
  scopeKey: 'sw-scope',
  revision: 1,
  liveHash: '',
  headTurnNodeId: '',
  updatedAt: Date.now(),
  nodes: statuses.map((s, i) => ({
    turnNodeId: `n${i}`, logicalTurnId: `L${i}`, variantId: 'a', parentTurnNodeId: '',
    pairIndex: i + 1, originalOrdinal: i + 1, activeOrdinal: i + 1,
    userHash: `u${i}`, assistantHash: `a${i}`,
    status: s, supersededBy: '', createdAt: 1, updatedAt: 1
  }))
});

//   renderWorldlineView 는 상태를 normalize 해서 그린다 — 그 출력으로 읽기를 확인한다.
const readStatuses = (statuses) => {
  try {
    const view = WL.renderWorldlineView(buildState(statuses), {});
    const text = JSON.stringify(view || {});
    return { text, view };
  } catch (e) { return { error: String(e.message).slice(0, 200) }; }
};

const legacyRead = readStatuses(['inactive_variant', 'detached_branch', 'active']);
const legacyOk = !legacyRead.error
  && /리롤됨/.test(legacyRead.text || '')
  && /갈라짐/.test(legacyRead.text || '');
assert('legacy_status_reads_as_canonical', legacyOk,
  { error: legacyRead.error, sample: String(legacyRead.text || '').slice(0, 260),
    note: '구 저장 데이터의 옛 이름도 정본으로 해석돼 라벨이 나와야 한다' });

const canonRead = readStatuses(['superseded', 'detached', 'active']);
assert('canonical_status_reads', !canonRead.error
  && /리롤됨/.test(canonRead.text || '') && /갈라짐/.test(canonRead.text || ''),
  { error: canonRead.error, sample: String(canonRead.text || '').slice(0, 200) });

// ── V3: 쓰기 경로가 정본 어휘만 만든다 (소스 계약) ──
const writes = [];
for (const m of SRC01F.matchAll(/node\.status\s*=\s*'([a-z_]+)'/g)) writes.push(m[1]);
for (const m of SRC01F.matchAll(/node\.status\s*=\s*[^;]*?\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g)) { writes.push(m[1], m[2]); }
const badWrites = writes.filter(v => !CANONICAL.includes(v));
assert('all_status_writes_are_canonical', badWrites.length === 0,
  { writes: Array.from(new Set(writes)), bad: badWrites });

// ── V5: 알 수 없는 상태는 orphaned 로 수렴 ──
const unknownRead = readStatuses(['완전히_모르는_값']);
assert('unknown_status_falls_back', !unknownRead.error && /삭제됨|이력/.test(unknownRead.text || ''),
  { error: unknownRead.error, sample: String(unknownRead.text || '').slice(0, 160),
    note: 'fail-safe — 정본도 알 수 없는 값은 suspended/orphaned 로 수렴한다' });

// ── V4: 라벨이 옛 이름도 낸다 (구 데이터 표시) ──
const labelBlock = (() => {
  const i = SRC01F.indexOf('const statusLabel = (status');
  return i < 0 ? '' : SRC01F.slice(i, i + 600);
})();
assert('status_label_covers_legacy_names',
  /inactive_variant/.test(labelBlock) && /detached_branch/.test(labelBlock)
  && /superseded/.test(labelBlock) && /detached/.test(labelBlock),
  { found: labelBlock.length > 0,
    note: '정본 이름과 옛 이름 모두 라벨이 있어야 구 데이터가 표시된다' });

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);

})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
