'use strict';
// Gate: 설정 GUI ↔ 런타임 CONFIG **계약**이 일치한다 (P1)
//
// 실측된 결함 (감사):
//   GUI(15c:564-566)는 `useLorebookRag` / `hybridMemoryEngine` / `hmeAssociativeGraph` 를 저장하고,
//   엔진(10c:37,57 · 10d:415)은 `useLorebookRAG` / `hybridMemoryEngineEnabled` / `hmeAssociativeGraphMode` 를 읽는다.
//   → 실행 재현: GUI 에서 HME 를 OFF 해도 `hybridMemoryEngineEnabled` 는 true 라 **계속 ON**.
//
// 계약:
//   S1 영속 설정에서 **옛 alias 가 정본 키로 접힌다** (마이그레이션 — 기존 사용자 설정 보존)
//   S2 정본 키가 이미 있으면 **사용자 값이 이긴다** (alias 가 덮지 않는다)
//   S3 저장 시 **정본 키만 쓴다** (alias 를 만들지 않는다)
//   S4 GUI→런타임 경로가 정본 키를 갱신한다 (엔진이 읽는 값이 실제로 바뀐다)
//   S5 가중치 별칭(`wSim/wImp/wRec`)이 `weights.*` 로 접힌다
//   S6 정본 키 이름이 엔진·GUI 양쪽 소스에서 **같다** (드리프트 감지)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_GUI = fs.readFileSync(path.join(ROOT, 'src/parts/15c-gui-settings-config.js'), 'utf8');
const SRC_10C = fs.readFileSync(path.join(ROOT, 'src/parts/10c-hme-associative-graph.js'), 'utf8');
const SRC_10D = fs.readFileSync(path.join(ROOT, 'src/parts/10d-hme-scope-index.js'), 'utf8');
const SRC_15D = fs.readFileSync(path.join(ROOT, 'src/parts/15d-gui-events-finalize.js'), 'utf8');
const SRC_SHELL = fs.readFileSync(path.join(ROOT, 'src/parts/00-plugin-shell-and-args.js'), 'utf8');
const SRC_14 = fs.readFileSync(path.join(ROOT, 'src/parts/14-main-initialization.js'), 'utf8');
const SRC_06 = fs.readFileSync(path.join(ROOT, 'src/parts/06-api-providers-llm.js'), 'utf8');
const SRC_01D_FOR_VERSION = fs.readFileSync(path.join(ROOT, 'src/parts/01d-debug-export-runtime-trace.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL, code.indexOf('const MemoryEngine = (() => {'));
if (tailAt < 0) { console.log(JSON.stringify({ ok: false, reason: 'scope_tail_not_found' })); process.exit(1); }
const closeMark = code.indexOf('\n})();', tailAt);
const injectAt = closeMark + '\n})();'.length;
code = code.slice(0, injectAt)
  + "\n;globalThis.__probe = { MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,"
  + " normalizeSettingsAliases: typeof normalizeSettingsAliases !== 'undefined' ? normalizeSettingsAliases : null,"
  + " canonicalSettingsForStorage: typeof canonicalSettingsForStorage !== 'undefined' ? canonicalSettingsForStorage : null };"
  + code.slice(injectAt);

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const noop = () => {};
const mk = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), addEventListener: noop };
const store = new Map();
const R = { apiVersion: '3.0', getRuntimeInfo: async () => ({}), pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => [...store.keys()] }, getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }), getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}, addRisuScriptHandler: noop, onUnload: noop };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, globalThis: null, window: null, document, Risuai: R, risuai: R, structuredClone: globalThis.structuredClone, fetch: async () => { throw new Error('x'); }, AbortController, performance: { now: () => Date.now() } };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

assert('dist_runs_without_error', !runErr, { error: runErr });
const P = ctx.__probe || {};
const ME = P.MemoryEngine || null;
const normalize = P.normalizeSettingsAliases || null;
const forStorage = P.canonicalSettingsForStorage || null;
assert('memory_engine_exported', !!ME, { keys: ME ? Object.keys(ME).slice(0, 12) : null });
assert('normalize_aliases_exported', typeof normalize === 'function', { type: typeof normalize });
assert('canonical_for_storage_exported', typeof forStorage === 'function', { type: typeof forStorage });

// 정본 키 (엔진 소스에서 확인한 이름)
const CANONICAL = ['hybridMemoryEngineEnabled', 'hmeAssociativeGraphMode', 'useLorebookRAG'];
const ALIASES = { hybridMemoryEngine: 'hybridMemoryEngineEnabled', hmeAssociativeGraph: 'hmeAssociativeGraphMode', useLorebookRag: 'useLorebookRAG' };

// ── S1: alias → 정본 접기 ──
if (typeof normalize === 'function') {
  const legacy = { hybridMemoryEngine: false, hmeAssociativeGraph: 'off', useLorebookRag: false, otherKey: 1 };
  const norm = normalize(legacy);
  assert('alias_is_folded_into_canonical',
    norm.hybridMemoryEngineEnabled === false && norm.hmeAssociativeGraphMode === 'off' && norm.useLorebookRAG === false,
    { normalized: { hybridMemoryEngineEnabled: norm.hybridMemoryEngineEnabled, hmeAssociativeGraphMode: norm.hmeAssociativeGraphMode, useLorebookRAG: norm.useLorebookRAG },
      note: '옛 이름으로 저장된 사용자 설정이 사라지면 안 된다 (마이그레이션)' });
  assert('alias_keys_are_removed_after_fold',
    !('hybridMemoryEngine' in norm) && !('hmeAssociativeGraph' in norm) && !('useLorebookRag' in norm),
    { keys: Object.keys(norm).filter(k => /hybrid|hme|Lorebook/i.test(k)) });
  assert('unrelated_keys_are_preserved', norm.otherKey === 1, { otherKey: norm.otherKey });

  // ── S2: 정본이 이미 있으면 사용자 값이 이긴다 ──
  const both = normalize({ hybridMemoryEngineEnabled: true, hybridMemoryEngine: false });
  assert('canonical_wins_over_alias',
    both.hybridMemoryEngineEnabled === true,
    { value: both.hybridMemoryEngineEnabled,
      note: '옛 alias 가 정본을 덮으면 안 된다 (드리프트 재발)' });
}

// ── S3: 저장 시 정본 키만 ──
if (typeof forStorage === 'function') {
  const stored = forStorage({ hybridMemoryEngine: false, hmeAssociativeGraph: 'off', hybridMemoryEngineEnabled: false, keep: 2 });
  // ★ 함수 존재만 보면 배선이 죽어도 통과한다(대조군 M3 이 그 지점을 겨냥했다).
  //   **저장 관문(`writeCommonPluginSettings`)이 실제로 정본화를 태우는지** 소스로 본다.
  //   ★ 함수 경계를 **다음 줄 시작 `const`** 로 잡는다 — `i + 40` 같은 오프셋은
  //     함수 본문 안의 `const parsed` 를 먼저 만나 잘린다(첫 시도가 그래서 false 였다).
  const writeGate = (() => {
    const i = SRC_01D_FOR_VERSION.indexOf('const writeCommonPluginSettings = async');
    if (i < 0) return '';
    const rest = SRC_01D_FOR_VERSION.slice(i + 40);
    const m = rest.match(/\n    const [A-Za-z_$]/);
    return m ? SRC_01D_FOR_VERSION.slice(i, i + 40 + m.index) : SRC_01D_FOR_VERSION.slice(i, i + 1500);
  })();
  assert('storage_gateway_canonicalizes',
    writeGate.length > 0 && /canonicalSettingsForStorage\s*\(/.test(writeGate),
    { gate_found: writeGate.length > 0,
      calls: /canonicalSettingsForStorage\s*\(/.test(writeGate),
      note: '★ 저장 관문이 정본화를 안 태우면 alias 가 파일에 남는다(대조군 M3)' });

  assert('storage_writes_canonical_only',
    !('hybridMemoryEngine' in stored) && !('hmeAssociativeGraph' in stored)
    && stored.hybridMemoryEngineEnabled === false && stored.hmeAssociativeGraphMode === 'off',
    { keys: Object.keys(stored).filter(k => /hybrid|hme/i.test(k)) });
}

// ── S5: 가중치 별칭 → weights ──
if (typeof normalize === 'function') {
  const w = normalize({ wSim: 0.5, wImp: 0.3, wRec: 0.2 });
  const weights = w.weights || {};
  assert('weight_aliases_are_folded',
    Number(weights.similarity) === 0.5 && Number(weights.importance) === 0.3 && Number(weights.recency) === 0.2,
    { weights, note: 'GUI wSim/wImp/wRec 가 런타임 weights 로 접혀야 검색 가중치가 실제로 바뀐다' });
}

// ── S4: GUI→런타임 경로가 정본을 갱신한다 (실행) ──
if (ME && typeof normalize === 'function') {
  const before = ME.CONFIG.hybridMemoryEngineEnabled;
  Object.assign(ME.CONFIG, normalize({ hybridMemoryEngine: false }));
  assert('runtime_config_reads_canonical_after_gui_save',
    ME.CONFIG.hybridMemoryEngineEnabled === false,
    { before, after: ME.CONFIG.hybridMemoryEngineEnabled,
      note: '★ P1 핵심 — GUI OFF 가 엔진이 읽는 값에 반영되어야 한다' });
  ME.CONFIG.hybridMemoryEngineEnabled = before;
}

// ── S6: 소스 드리프트 감지 — GUI 가 alias 를 **저장**하지 않는다 ──
assert('gui_does_not_persist_alias_names',
  !/useLorebookRag:\s*overlay/.test(SRC_GUI) && !/hybridMemoryEngine:\s*overlay/.test(SRC_GUI)
  && !/hmeAssociativeGraph:\s*String\(/.test(SRC_GUI),
  { note: 'GUI 저장부가 alias 를 만들면 정규화가 있어도 다시 드리프트한다' });
assert('engine_reads_canonical_names',
  /CONFIG\.hybridMemoryEngineEnabled/.test(SRC_10C) && /CONFIG\.hmeAssociativeGraphMode/.test(SRC_10C)
  && /CONFIG\.hybridMemoryEngineEnabled/.test(SRC_10D),
  { note: '엔진이 읽는 정본 이름을 게이트가 고정한다' });

// ── S7: 헤더 공개 문서의 enum 이 실제 엔진 목록과 일치한다 (감사 P2) ──
//   실측: 헤더는 `story_author_mode: disabled|supportive|active` 였지만 실제는 `proactive|aggressive` 까지 있다.
const headerEnum = (argName) => {
  const m = SRC_SHELL.match(new RegExp('//@arg ' + argName + ' string [^\\n]*'));
  if (!m) return null;
  const tail = m[0].split(':').slice(1).join(':');
  return tail.split('|').map(x => x.trim()).filter(Boolean);
};
const engineListIn = (src, marker) => {
  const i = src.indexOf(marker);
  if (i < 0) return null;
  const m = src.slice(i, i + 240).match(/\[([^\]]+)\]/);
  return m ? m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : null;
};
const saEngine = engineListIn(SRC_GUI, "['disabled', 'supportive', 'proactive', 'aggressive'].includes");
const dirEngine = engineListIn(SRC_GUI, "['disabled', 'light', 'standard', 'strong', 'absolute'].includes");
assert('header_story_author_enum_matches_engine',
  Array.isArray(saEngine) && JSON.stringify(headerEnum('story_author_mode')) === JSON.stringify(saEngine),
  { header: headerEnum('story_author_mode'), engine: saEngine });
assert('header_director_enum_matches_engine',
  Array.isArray(dirEngine) && JSON.stringify(headerEnum('director_mode')) === JSON.stringify(dirEngine),
  { header: headerEnum('director_mode'), engine: dirEngine });

//   memory_preset 은 `MEMORY_PRESETS` 키 + 'custom' 이 정본(14:337).
const presetKeys = [...SRC_06.matchAll(/^\s{8}(\w+):\s*\{\s*maxLimit:/gm)].map(m => m[1]);
assert('header_memory_preset_matches_engine',
  presetKeys.length > 0
  && JSON.stringify(headerEnum('memory_preset')) === JSON.stringify([...presetKeys, 'custom']),
  { header: headerEnum('memory_preset'), engine: [...presetKeys, 'custom'] });

// ── S8: 디버그 export 버전이 실제 플러그인 버전과 같다 (감사 P2) ──
const pkgVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (_) { return null; } })();
const declaredVersion = (() => {
  const m = SRC_SHELL.match(/\/\/@version\s+([0-9][^\s]*)/);
  return m ? m[1] : null;
})();
assert('debug_export_version_matches_plugin',
  !!pkgVersion && pkgVersion === declaredVersion,
  { package: pkgVersion, header: declaredVersion, note: '헤더와 package.json 이 같은 버전이어야 한다' });
//   ★ 소스 패턴(`PLUGIN_VERSION = '0.1'`)만 보면 구조가 바뀔 때 못 잡는다(대조군 M6).
//     **폴백 값과 실제 헤더 버전**을 함께 본다 — 둘 중 하나라도 0.1 이면 실패.
const versionFallback = (() => {
  const i = SRC_01D_FOR_VERSION.indexOf('const PLUGIN_VERSION');
  if (i < 0) return null;
  const block = SRC_01D_FOR_VERSION.slice(i, i + 900);
  const m = block.match(/return\s+'([0-9][^']*)'/g);
  return m ? m.map(x => x.replace(/return\s+'|'/g, '')) : null;
})();
assert('debug_export_version_not_stale',
  Array.isArray(versionFallback) && versionFallback.length > 0
  && versionFallback.every(v => v !== '0.1')
  && versionFallback.includes(declaredVersion),
  { fallbacks: versionFallback, declared: declaredVersion,
    note: '★ 감사 P2 — v6.0.0 장애가 0.1 로 찍혔다. 폴백이 실제 버전을 유지해야 한다' });

// ── S9: 설정 export 가 인증정보를 다룬다 (감사 P2) ──
assert('settings_export_handles_secrets',
  /stripSecrets/.test(SRC_01D_FOR_VERSION) && /containsSecrets/.test(SRC_01D_FOR_VERSION)
  && /stripSecrets|containsSecrets/.test(SRC_15D),
  { note: '설정 파일에 API 키가 들어간다 — 기본 제외 + 경고가 있어야 한다' });

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
