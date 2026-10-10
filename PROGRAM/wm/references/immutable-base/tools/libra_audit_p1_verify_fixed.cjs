'use strict';
// 감사 재현 (수리 확인) — **실제 저장 관문을 통과**시켜 GUI↔런타임 계약을 검증한다.
//   종전 도구는 `Object.assign(CONFIG, {alias})` 로 옛 동작을 직접 흉내 냈다(수리와 무관).
//   이제는 `LibraSettingsSchema.forStorage/normalize`(제품이 실제로 쓰는 것)를 태운다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const noop = () => {};
const mk = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), addEventListener: noop };
const store = new Map();
const R = { apiVersion: '3.0', getRuntimeInfo: async () => ({}), pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => [...store.keys()] }, getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }), getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}, addRisuScriptHandler: noop, onUnload: noop };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, globalThis: null, window: null, document, Risuai: R, risuai: R, structuredClone: globalThis.structuredClone, fetch: async () => { throw new Error('x'); }, AbortController, performance: { now: () => Date.now() } };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 30000 });

const S = ctx.LibraSettingsSchema;
console.log('=== LibraSettingsSchema 노출 ===');
console.log('  normalize:', typeof (S && S.normalize), '| forStorage:', typeof (S && S.forStorage));
console.log();

console.log('=== ① 사용자 시나리오: GUI 에서 HME OFF ===');
const guiOff = { hybridMemoryEngineEnabled: false, hmeAssociativeGraphMode: 'off', useLorebookRAG: false };
const forStore = S.forStorage(guiOff);
console.log('  저장될 값(정본):', JSON.stringify({ hybridMemoryEngineEnabled: forStore.hybridMemoryEngineEnabled, hmeAssociativeGraphMode: forStore.hmeAssociativeGraphMode, useLorebookRAG: forStore.useLorebookRAG }));
console.log('  ★ alias 키가 저장물에 남았나:',
  ('hybridMemoryEngine' in forStore) || ('hmeAssociativeGraph' in forStore) || ('useLorebookRag' in forStore)
    ? 'O ← 실패' : 'X (정본만 저장됨)');
console.log();

console.log('=== ② 재시작: 구 저장 데이터(alias)를 읽는 경우 ===');
const legacyStored = { hybridMemoryEngine: false, hmeAssociativeGraph: 'off', useLorebookRag: false, debug: true };
const loaded = S.normalize(legacyStored);
console.log('  읽은 값:', JSON.stringify({ hybridMemoryEngineEnabled: loaded.hybridMemoryEngineEnabled, hmeAssociativeGraphMode: loaded.hmeAssociativeGraphMode, useLorebookRAG: loaded.useLorebookRAG, debug: loaded.debug }));
console.log('  ★ 옛 이름만 있는 저장 데이터가 정본으로 접혔나:',
  loaded.hybridMemoryEngineEnabled === false && loaded.hmeAssociativeGraphMode === 'off' && loaded.useLorebookRAG === false
    ? 'O (마이그레이션 성공 — 사용자 설정 보존)' : 'X ← 실패');
console.log();

console.log('=== ③ 정본이 이미 있으면 alias 가 덮지 않는다 ===');
const conflict = S.normalize({ hybridMemoryEngineEnabled: true, hybridMemoryEngine: false });
console.log('  hybridMemoryEngineEnabled =', conflict.hybridMemoryEngineEnabled, '(정본 true 여야 함)');
console.log();

console.log('=== ④ 가중치 별칭 → weights ===');
const weights = S.normalize({ wSim: 0.5, wImp: 0.3, wRec: 0.2 });
console.log('  weights =', JSON.stringify(weights.weights));
console.log();

console.log('=== ⑤ 엔진이 읽는 값이 실제로 바뀌는가 (핵심) ===');
const ME = ctx.MemoryEngine;
if (ME) {
  const before = ME.CONFIG.hybridMemoryEngineEnabled;
  Object.assign(ME.CONFIG, S.normalize({ hybridMemoryEngine: false }));
  console.log('  before =', before, '→ after =', ME.CONFIG.hybridMemoryEngineEnabled);
  console.log('  ★ GUI OFF 가 엔진 판정에 반영되나:', ME.CONFIG.hybridMemoryEngineEnabled === false ? 'O' : 'X ← 실패');
} else {
  console.log('  (MemoryEngine 미노출 — 게이트가 대신 검증)');
}
