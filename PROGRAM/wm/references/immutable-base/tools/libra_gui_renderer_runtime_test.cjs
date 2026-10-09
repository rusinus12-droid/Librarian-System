'use strict';
// Gate: GUI 렌더러가 "실제로 값을 만들어내는가" 를 실행으로 본다.
//
// 배경 (실측): 종전 검증은 마크업에 id 가 있는지만 봤다. 그래서
//   - KPI 함수가 있어도 화면이 비어 있는 경우
//   - 계약 파일(01f)에서 esc() 처럼 스코프에 없는 심볼을 쓰는 경우
//   - toLocaleString 이 로케일마다 다른 형식을 내는 경우
// 를 전부 놓쳤다. 문자열 존재는 "동작"의 증거가 아니다.
//
// 이 게이트가 단언하는 계약:
//   1) 헤더 실시간 대시보드가 상태·진행률·상태클래스를 계산한다
//   2) 사이드바 카운트가 스냅샷에서 실제 수치를 만든다
//   3) 세계관/내러티브/세계선 KPI 가 값을 만든다
//   4) 세계선 노드에 시점 정보가 실제로 붙는다
//   5) 렌더러가 참조하는 심볼이 그 파일 스코프에 있다 (esc 같은 미스코프 방지)
//   6) 시각 형식이 로케일 비의존이다
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const read = (f) => fs.readFileSync(path.join(PARTS, f), 'utf8');
const dist = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }
const assertions = [];

// ── 공용: dist 에서 함수 하나를 뽑아 실행 가능한 형태로 만든다 ───────────
const sliceFn = (name) => {
  const i = dist.indexOf('const ' + name + ' = ');
  if (i < 0) return null;
  const arrow = dist.indexOf('=>', i);
  let depth = 0, end = dist.indexOf('{', arrow);
  for (; end < dist.length; end++) {
    if (dist[end] === '{') depth++;
    else if (dist[end] === '}') { depth--; if (!depth) break; }
  }
  return dist.slice(i, end + 1) + ';';
};

// ── 1. 헤더 실시간 대시보드 ──────────────────────────────────────────────
const text = (v) => String(v == null ? '' : v);
const clampPercent = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : f; };
let headerOk = false, headerSample = {};
try {
  const fn = new Function('text', 'clampPercent',
    sliceFn('formatPhaseLabel') + sliceFn('classForStatus') + sliceFn('activityHeaderLabel') + '; return {a: activityHeaderLabel, c: classForStatus};'
  )(text, clampPercent);
  const running = fn.a({ status: 'running', phase: 'beforeRequest', activeTask: '주입 준비', progress: 35 });
  const done = fn.a({ status: 'done', activeTask: '후처리 분석' });
  const failed = fn.a({ status: 'error', activeTask: '동기화' });
  headerSample = { running, done, failed, cls: [fn.c('running'), fn.c('done'), fn.c('error'), fn.c('waiting')] };
  headerOk = running.includes('35%') && done.startsWith('완료') && failed.startsWith('오류')
    && fn.c('running') === 'running' && fn.c('done') === 'ok' && fn.c('error') === 'failed';
} catch (e) { headerSample = { error: e.message }; }
assertions.push(assert('header_dashboard_computes_label_and_state', headerOk, headerSample));
assertions.push(assert('header_writes_activity_state_attribute',
  dist.includes("data-libra-activity-state") && /setAttribute\(['"]data-libra-activity-state/.test(dist), {}));

// ── 2·3. KPI 계산 (사이드바 · 세계관 · 내러티브 · 세계선) ────────────────
const makeStub = () => {
  const store = {};
  const el = () => ({ innerHTML: '', textContent: '', style: {},
    classList: { toggle(){}, add(){}, remove(){} },
    set innerHTML(v){ store.__last = String(v); this.__v = String(v); }, get innerHTML(){ return this.__v || ''; },
    set textContent(v){ this.__t = String(v); }, get textContent(){ return this.__t || ''; } });
  const nodes = {};
  const overlay = { querySelector: (s) => { const id = s.replace(/^#/, ''); if (!nodes[id]) nodes[id] = el(); return nodes[id]; } };
  return { overlay, nodes, store };
};

const runKpi = (fnName, deps) => {
  const src = sliceFn(fnName);
  if (!src) return null;
  const s = makeStub();
  const keys = Object.keys(deps);
  try {
    const fn = new Function('overlay', 'recordSuppressedRuntimeError', 'esc', ...keys,
      src + '; return ' + fnName + ';')(s.overlay, () => {}, (x) => String(x ?? ''), ...Object.values(deps));
    fn();
    return s.nodes;
  } catch (e) { return { __error: e.message }; }
};

// 사이드바 카운트
const sideNodes = runKpi('syncSidebarCounts', {
  parseMeta: (c) => JSON.parse(String(c).split('|META|')[1] || '{}'),
  _MEM: [{ content: 'a|META|{"imp":5}' }, { content: 'b|META|{"source":"narrative_source_record"}' }],
  _ENT: [1, 2, 3], _REL: [1, 2], _NAR: { storylines: [1] }, _WLD: { nodes: [[1], [2]] },
  LibraTurnWorldline: { get: () => ({ nodes: [1, 2, 3, 4] }) },
  LibraDataStorage: { scopeKeyFor: () => 'scope' }, char: {}, chat: {},
  memViewState: { showNarrativeSource: false }
});
assertions.push(assert('sidebar_counts_from_snapshot',
  sideNodes && sideNodes['nav-mc']?.textContent === '1' && sideNodes['nav-ec']?.textContent === '3'
  && sideNodes['nav-rc']?.textContent === '2' && sideNodes['nav-wc']?.textContent === '2',
  { mc: sideNodes?.['nav-mc']?.textContent, ec: sideNodes?.['nav-ec']?.textContent, rc: sideNodes?.['nav-rc']?.textContent, wc: sideNodes?.['nav-wc']?.textContent, err: sideNodes?.__error }));

// 세계관 KPI
const wldNodes = runKpi('syncWorldKpi', {
  // 픽스처를 실제 정본 shape 으로 바꾼다 — 종전에는 결함 형태(node.fields)를 써서
  // "규칙 수를 어디서 읽는가"를 게이트가 보지 못했다.
  _WLD: {
    nodes: [
      ['n1', { name: 'A', meta: { classification: 'x' }, rules: { setting: { places: ['a', 'b'] } } }],
      ['n2', { name: 'B', meta: { classification: 'y' }, rules: { exists: { magic: true } } }]
    ],
    activePath: ['n1']
  }
});
assertions.push(assert('world_kpi_counts_nodes_and_rules',
  wldNodes && wldNodes['sum-wld-nodes']?.innerHTML === '2<small>개</small>' && wldNodes['sum-wld-badge']?.textContent === '활성 1 · 이력 1',
  { nodes: wldNodes?.['sum-wld-nodes']?.innerHTML, badge: wldNodes?.['sum-wld-badge']?.textContent, err: wldNodes?.__error }));

// 내러티브 KPI
const narNodes = runKpi('syncNarrativeKpi', {
  _NAR: { storylines: [{ title: '아크', keyPoints: ['a', 'b'], progress: ['c'], openThreads: ['t1', 't2'] }, { title: '둘', manualLocked: true }] }
});
assertions.push(assert('narrative_kpi_counts_items_and_open_threads',
  narNodes && narNodes['sum-nar-count']?.innerHTML === '2<small>개</small>' && narNodes['sum-nar-badge']?.textContent === '활성 1 · 보호 1',
  { count: narNodes?.['sum-nar-count']?.innerHTML, badge: narNodes?.['sum-nar-badge']?.textContent, err: narNodes?.__error }));

// 세계선 KPI
const wlNodes = runKpi('syncWorldlineKpi', {
  LibraDataStorage: { scopeKeyFor: () => 'scope' },
  LibraTurnWorldline: { get: () => ({ nodes: [{}, { supersededBy: 'x' }], revision: 42 }) },
  char: {}, chat: {}
});
assertions.push(assert('worldline_kpi_counts_active_and_history',
  wlNodes && wlNodes['sum-wl-active']?.innerHTML === '1<small>턴</small>' && wlNodes['sum-wl-history']?.innerHTML === '1<small>개</small>',
  { active: wlNodes?.['sum-wl-active']?.innerHTML, history: wlNodes?.['sum-wl-history']?.innerHTML, err: wlNodes?.__error }));

// ── 4. 세계선 노드 시점 정보 ─────────────────────────────────────────────
let wlOk = false, wlSample = {};
try {
  const blk = dist.slice(dist.indexOf('const renderWorldlineView'), dist.indexOf('const renderWorldlineHtml'));
  const T = 1758000000000;
  const stubs = {
    text: (v) => String(v == null ? '' : v),
    empty: (k = '') => ({ nodes: [], revision: 0, scopeKey: k }),
    statusLabel: (x) => ({ active: '현재', inactive_variant: '이력 · 리롤됨' }[String(x)] || '이력'),
    activeNodes: (s) => (s.nodes || []).filter(n => n.status === 'active'),
    supersededNodes: (s) => (s.nodes || []).filter(n => n.status !== 'active')
  };
  const fn = new Function(...Object.keys(stubs), blk + '; return renderWorldlineView;')(...Object.values(stubs));
  const html = fn({ revision: 9, nodes: [
    { pairIndex: 1, status: 'active', logicalTurnId: 'L1', variantId: 'v1', createdAt: T, updatedAt: T },
    { pairIndex: 1, status: 'inactive_variant', logicalTurnId: 'L1', variantId: 'v0', createdAt: T - 1000, updatedAt: T - 900, supersededBy: 'n' }
  ] }, {});
  wlSample = { metas: [...html.matchAll(/wl-node-meta">([^<]*)</g)].map(m => m[1]) };
  wlOk = (html.match(/class="wl-node /g) || []).length === 2
    && wlSample.metas.some(m => /기록 \d+\/\d+ \d{2}:\d{2}/.test(m))
    && wlSample.metas.some(m => /물러남/.test(m));
} catch (e) { wlSample = { error: e.message }; }
assertions.push(assert('worldline_nodes_render_temporal_meta', wlOk, wlSample));

// ── 5. 렌더러가 쓰는 심볼이 그 파일 스코프에 있는가 (esc 미스코프 방지) ───
// esc/escaper 는 15a 에만 정의된 DOM 헬퍼다. 계약 파일(01f)이나 다른 parts 에서
// 쓰면 그 스코프에서 보이지 않아 런타임에 죽는다. 실제로 이 결함을 밟았다.
const GUI_SCOPE_ONLY = ['esc', 'escAttr'];
// esc 는 호출(esc(x))로도, 참조(meta.map(esc))로도 쓰인다.
// 실제로 밟은 결함은 참조 형태였다 — 그래서 '호출'만 보면 놓친다.
// 규칙: 앞이 식별자문자/./$ 가 아니고, 뒤가 식별자문자가 아닌 esc 를 찾는다.
function referencesSymbol(src, sym) {
  let from = 0;
  for (;;) {
    const at = src.indexOf(sym, from);
    if (at < 0) return false;
    const prev = at > 0 ? src[at - 1] : '';
    const next = at + sym.length < src.length ? src[at + sym.length] : '';
    const leftOk = !/[A-Za-z0-9_$.]/.test(prev);
    const rightOk = !/[A-Za-z0-9_$]/.test(next);
    if (leftOk && rightOk) return true;
    from = at + sym.length;
  }
}

const scopedViolations = [];
for (const f of ['01f-lore-consolidation.js', '02b-activity-dashboard-dom.js', '06-api-providers-llm.js']) {
  const src = read(f);
  const lines = src.split(/\r?\n/);
  for (const sym of GUI_SCOPE_ONLY) {
    if (!referencesSymbol(src, sym)) continue;
    const definedHere = lines.some(l => new RegExp('const\\s+' + sym + '\\s*=').test(l));
    if (!definedHere) scopedViolations.push({ file: f, symbol: sym });
  }
}
assertions.push(assert('renderers_only_use_symbols_in_their_scope',
  scopedViolations.length === 0,
  { violations: scopedViolations, note: 'esc 는 15a 의 DOM 헬퍼다. 다른 파일에서 쓰면 런타임에 죽는다' }));

// ── 6. 시각 형식이 로케일 비의존 ─────────────────────────────────────────
const lore = read('01f-lore-consolidation.js');
assertions.push(assert('time_format_is_locale_independent',
  !/toLocaleString|toLocaleDateString|toLocaleTimeString/.test(lore) && /getHours\(\)/.test(lore),
  { note: 'toLocaleString 은 로케일마다 다른 형식(9. 16. PM 02:20)을 낸다' }));

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
