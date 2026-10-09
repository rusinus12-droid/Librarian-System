'use strict';
// Gate: canonical packet → world 변환은 **차원 이동을 보존**해야 한다.
//
// 실측된 결함 (12:1014 `structuredPacketWorldToExtraction`, 호출 12:1523-1526):
//   이 함수는 world 를 `setting/physics/custom/state/__genreSourceText` 로 **재구성**한다.
//   `dimensionalShifts` 를 읽지도 내지도 않는다.
//   → 캐노니컬 패킷 경로로 들어온 차원 이동은 **표현될 수 없다**.
//
// 그 결과(계측 실측, 12턴):
//   HANDOFF src="structured_packet"  shifts=-1
//   COND    allowShift=false shifts=0      ← 05k 의 노드 생성 조건이 영원히 false
//   노드 수 1 고정 (7단계 프로브 주석 C: "규칙은 항상 현재 노드(=루트)에 누적된다")
//
// 왜 중요한가: 노드 분기·승격·강등·멀티노드가 전부 이 축 위에 있다.
//   `allowDimensionalShift` 는 `world.dimensionalShifts.length > 0` 만 본다(13b).
//
// 계약:
//   S1 패킷의 world.dimensionalShifts 가 변환 결과에 보존된다
//   S2 항목은 `to`(도착 세계)를 유지한다 — 05k 가 그 이름으로 노드를 만들거나 찾는다
//   S3 `from`/`type` 도 보존된다(선택 필드지만 진단·경로 기록에 쓰인다)
//   S4 차원 이동이 없는 패킷에는 키를 만들지 않는다(빈 배열 금지 — allowShift 오판 방지)
//   S5 기존 world 키는 그대로 유지된다(회귀 금지)
//   S6 하위 호환: `dimensional_shifts`(snake_case)도 읽는다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC12 = fs.readFileSync(path.join(ROOT, 'src/parts/12-processors-world-entity.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + `
    globalThis.__probe = { EntityAwareProcessor };
` + code.slice(idx);

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const noop = () => {};
const mk = () => ({
  _v: '', _t: '', style: {}, dataset: {}, tagName: 'DIV',
  classList: { toggle: noop, add: noop, remove: noop },
  set innerHTML(v) { this._v = String(v); }, get innerHTML() { return this._v || ''; },
  set textContent(v) { this._t = String(v); }, get textContent() { return this._t || ''; },
  setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => []
});
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), readyState: 'complete', addEventListener: noop };
const store = new Map();
const Risuai = {
  apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
  pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => store.set(k, String(v)), removeItem: async (k) => store.delete(k), keys: async () => Array.from(store.keys()) },
  getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
  getCharacter: async () => ({ id: 'c1', name: 'T', chats: [] }), getChatFromIndex: async () => ({ id: 'ch1', msg: [] }),
  getDatabase: async () => ({ personas: [] }), registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {},
  addRisuScriptHandler: noop, onUnload: noop
};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map,
  globalThis: null, window: null, document, Risuai, risuai: Risuai, structuredClone: global.structuredClone,
  fetch: async () => { throw new Error('no'); }, AbortController, performance: { now: () => Date.now() }
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

setTimeout(() => {
  const P = ctx.__probe?.EntityAwareProcessor;
  assert('dist_runs_without_error', !runErr, { error: runErr });
  assert('probe_exported', !!P, { processor: !!P });
  if (!P) { console.log(JSON.stringify({ ok: false, assertions }, null, 2)); process.exit(1); }

  // ── S1~S3: 실제 변환 경로를 실행한다 (mock 이 아니라 제품 함수) ──
  const mkPacket = (extraWorld = {}) => ({
    schema: 'libra.canonical_packet.v3',
    version: 3,
    meta: { turn: 7, sourceMessageIds: ['a-7'], summary_memory: { summary: '차원 이동 턴', recall: '아르카디아' } },
    world: {
      summary: '두 개의 달이 뜬 세계',
      places: ['공중 섬'],
      rules: ['이 세계에서는 부유석이 뜬다.'],
      phenomena: ['이중 달'],
      state: { time: 'T7', location: '아르카디아', scene: '도착' },
      ...extraWorld
    },
    entity: { characters: [], relations: [] }
  });

  const run = (extraWorld) => {
    const res = P.extractStructuredEntitySignalsFromPackets([mkPacket(extraWorld)], {});
    return res?.world || null;
  };

  const shifted = run({
    dimensionalShifts: [{ to: '아르카디아', from: '루멘 아카데미', type: 'portal' }]
  });

  assert('world_conversion_runs', !!shifted, { world: shifted ? Object.keys(shifted) : null, note: '변환 경로가 실행돼야 판정 가능' });

  const shifts = shifted?.dimensionalShifts;
  assert('shifts_are_preserved', Array.isArray(shifts) && shifts.length === 1,
    { dimensionalShifts: shifts, worldKeys: shifted ? Object.keys(shifted) : null });
  assert('shift_keeps_target_world', Array.isArray(shifts) && String(shifts[0]?.to || '') === '아르카디아',
    { to: shifts?.[0]?.to, note: '05k 가 이 이름으로 노드를 찾거나 만든다' });
  assert('shift_keeps_from_and_type',
    Array.isArray(shifts) && String(shifts[0]?.from || '') === '루멘 아카데미' && String(shifts[0]?.type || '') === 'portal',
    { from: shifts?.[0]?.from, type: shifts?.[0]?.type });

  // ── S4: 이동이 없으면 키를 만들지 않는다 (빈 배열은 allowShift 오판 위험) ──
  const plain = run({});
  assert('no_shifts_no_key',
    plain && !Object.prototype.hasOwnProperty.call(plain, 'dimensionalShifts'),
    { worldKeys: plain ? Object.keys(plain) : null, note: '빈 배열을 만들면 allowDimensionalShift 판정이 흔들린다' });

  // ── S5: 기존 world 키 유지 ──
  assert('existing_world_keys_preserved',
    !!(plain?.setting?.places?.length) && !!plain?.state && String(plain?.state?.location || '') === '아르카디아',
    { setting: plain?.setting, state: plain?.state });

  // ── S6: snake_case 하위 호환 ──
  const snake = run({ dimensional_shifts: [{ to: '아르카디아', type: 'gate' }] });
  assert('snake_case_is_read',
    Array.isArray(snake?.dimensionalShifts) && String(snake.dimensionalShifts[0]?.to || '') === '아르카디아',
    { dimensionalShifts: snake?.dimensionalShifts });

  // ── S8: 도착 세계(`to`)가 없는 항목은 버린다 ──
  //   05k 는 `to` 로 노드를 찾거나 만든다. `to` 가 빈 항목을 넘기면 빈 이름 노드가 생기거나
  //   조건이 흔들린다. (M4 변이가 이 지점을 겨냥한다 — 종전엔 단언이 없어 통과했다)
  const noTarget = run({ dimensionalShifts: [{ type: 'portal' }, { to: '  ' }, { to: '아르카디아', type: 'gate' }] });
  const nt = noTarget?.dimensionalShifts;
  assert('shift_without_target_is_dropped',
    Array.isArray(nt) && nt.length === 1 && String(nt[0].to) === '아르카디아',
    { dimensionalShifts: nt, note: 'to 가 없거나 공백뿐인 항목은 제외한다' });

  // ── S7: 변환기가 실제로 그 키를 **읽도록** 쓰였는지 (배선 단언) ──
  //   실행 단언만으로는 "다른 경로가 우연히 보존"을 구분할 수 없다.
  const fnBody = (() => {
    const i = SRC12.indexOf('const structuredPacketWorldToExtraction = (packet = {}, options = {}) => {');
    if (i < 0) return '';
    return SRC12.slice(i, i + 4200);
  })();
  const readsShifts = /dimensionalShifts|dimensional_shifts/.test(fnBody);
  assert('converter_reads_shifts', readsShifts, { found: readsShifts, note: '변환기가 이 키를 알아야 한다' });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
}, 250);
