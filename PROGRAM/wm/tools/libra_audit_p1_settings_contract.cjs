'use strict';
// 감사 실측 — P1: 설정 GUI와 런타임 CONFIG 계약 불일치
//   주장 A: GUI 가 `hybridMemoryEngine` 을 저장하지만 엔진은 `hybridMemoryEngineEnabled` 를 읽는다
//           → GUI 에서 HME 를 OFF 해도 **실제로는 계속 ON**
//   주장 B: `hmeAssociativeGraph` vs `hmeAssociativeGraphMode` 도 같은 문제
//   주장 C: `useLorebookRag` vs `useLorebookRAG`
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
//   `MemoryEngine` 는 IIFE 내부 심볼이다 — 내부 스코프에서 probe 로 꺼낸다.
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL, code.indexOf('const MemoryEngine = (() => {'));
if (tailAt < 0) { console.log('scope_tail_not_found'); process.exit(1); }
const closeMark = code.indexOf('\n})();', tailAt);
const injectAt = closeMark + '\n})();'.length;
code = code.slice(0, injectAt)
  + "\n;globalThis.__audit = { MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null };"
  + code.slice(injectAt);
const noop = () => {};
const mk = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), addEventListener: noop };
const store = new Map();
const R = { apiVersion: '3.0', getRuntimeInfo: async () => ({}), pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => [...store.keys()] }, getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }), getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}, addRisuScriptHandler: noop, onUnload: noop };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, globalThis: null, window: null, document, Risuai: R, risuai: R, structuredClone: globalThis.structuredClone, fetch: async () => { throw new Error('x'); }, AbortController, performance: { now: () => Date.now() } };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 30000 });

const ME = (ctx.__audit && ctx.__audit.MemoryEngine) || ctx.MemoryEngine;
console.log('=== 0. 전제 확인 ===');
console.log('  MemoryEngine 노출:', typeof ME);
console.log('  CONFIG.hybridMemoryEngineEnabled (정본) =', ME && ME.CONFIG && ME.CONFIG.hybridMemoryEngineEnabled);
console.log('  CONFIG.hmeAssociativeGraphMode  (정본) =', ME && ME.CONFIG && ME.CONFIG.hmeAssociativeGraphMode);
console.log('  CONFIG.useLorebookRAG           (정본) =', ME && ME.CONFIG && ME.CONFIG.useLorebookRAG);
console.log();

// ── 사용자가 GUI 에서 HME 를 OFF 로 저장하는 상황을 재현 ──
//   GUI 저장부(15c:565)가 만드는 객체 그대로:
const guiPayload = {
  hybridMemoryEngine: false,          // ← GUI 가 쓰는 이름
  hmeAssociativeGraph: 'off',         // ← GUI 가 쓰는 이름
  useLorebookRag: false               // ← GUI 가 쓰는 이름
};
//   그리고 15c mergeRuntimeConfigFromSettingsUI 가 하는 일:
Object.assign(ME.CONFIG, guiPayload);

console.log('=== 1. GUI OFF 저장 후 실제 CONFIG ===');
console.log('  hybridMemoryEngine (GUI alias)       =', ME.CONFIG.hybridMemoryEngine);
console.log('  hybridMemoryEngineEnabled (**엔진이 읽는 것**) =', ME.CONFIG.hybridMemoryEngineEnabled);
console.log('  hmeAssociativeGraph (GUI alias)      =', ME.CONFIG.hmeAssociativeGraph);
console.log('  hmeAssociativeGraphMode (**엔진이 읽는 것**)   =', ME.CONFIG.hmeAssociativeGraphMode);
console.log('  useLorebookRag (GUI alias)           =', ME.CONFIG.useLorebookRag);
console.log('  useLorebookRAG (**엔진이 읽는 것**)            =', ME.CONFIG.useLorebookRAG);
console.log();

// ── HME 가 실제로 도는가 (엔진 판정 함수 소스로 확인) ──
const SRC10C = fs.readFileSync(path.join(ROOT, 'src/parts/10c-hme-associative-graph.js'), 'utf8');
console.log('=== 2. 엔진 판정 (10c 소스) ===');
console.log('  isHmeGraphEnabled = CONFIG.hybridMemoryEngineEnabled !== false && ...');
console.log('  → hybridMemoryEngineEnabled 은 여전히', ME.CONFIG.hybridMemoryEngineEnabled, '이므로 **true 판정**');
console.log('  mode = normalizeHmeGraphMode(CONFIG.hmeAssociativeGraphMode || ...)');
console.log('  → hmeAssociativeGraphMode 은 여전히', JSON.stringify(ME.CONFIG.hmeAssociativeGraphMode), '이므로 GUI 의 off 가 **반영되지 않는다**');
console.log();
console.log('  ★ GUI 에서 OFF 했는데 엔진은 계속 ON 인가:',
  (ME.CONFIG.hybridMemoryEngineEnabled !== false && guiPayload.hybridMemoryEngine === false) ? 'O ← 결함 확정' : 'X');
