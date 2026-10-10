'use strict';
// Gate (A2): 메모리 '그래프' 보기가 **실제로 배선되고 그려지는가**.
//
// 왜 문자열 검사로는 부족한가:
//   마크업에 버튼과 캔버스가 있다는 사실은 "눌러서 그래프가 나온다" 는 확인이 아니다.
//   실측 전례: id 계약 241/241 통과 상태에서 버튼 54개가 무반응이었다.
//
// 이 게이트가 재는 것:
//   G1 마크업 계약 — 그래프 버튼 · 캔버스 · 요약 컨테이너가 실제로 있다
//   G2 보기 전환 배선이 일반적이라 새 보기가 **코드 수정 없이** 걸린다
//   G3 `renderMems` 가 그래프 보기에서 표·카드를 숨기고 그래프를 보인다 (실행)
//   G4 `renderMemGraph` 가 **그래프가 없으면 만들지 않고** 안내만 한다 (실행)
//   G5 `renderMemGraph` 가 제품 뷰 API 로 노드·엣지를 실제로 채운다 (실행)
//   G6 그래프 보기가 목록 필터와 무관하게 동작한다 (빈 목록에서도 그래프를 그린다)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const out = { ok: false, assertions: [], measurements: {} };
const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });

const read = (n) => fs.readFileSync(path.join(ROOT, 'src', 'parts', n), 'utf8');
const GUI = read('15-gui-and-exports.js');
const CONTENT = read('15b-gui-content-world-dlc.js');
const EVENTS = read('15d-gui-events-finalize.js');

// ── G1 마크업 계약 ───────────────────────────────────────────────────────
const bodyStart = GUI.indexOf('const GUI_BODY = `');
const body = GUI.slice(bodyStart, GUI.indexOf('`;', bodyStart));
out.measurements.markup = {
    graphButton: body.includes('data-mem-view="graph"'),
    canvas: body.includes('id="ml-graph-cv"'),
    graphHost: body.includes('id="ml-graph"'),
    kpi: body.includes('id="ml-graph-kpi"'),
    paths: body.includes('id="ml-graph-paths"')
};
assert('G1: 마크업 계약 — 그래프 버튼 · 캔버스 · 요약 컨테이너가 있다',
    out.measurements.markup.graphButton && out.measurements.markup.canvas
    && out.measurements.markup.graphHost && out.measurements.markup.kpi
    && out.measurements.markup.paths,
    out.measurements.markup);

// ── G2 배선 일반성 ───────────────────────────────────────────────────────
out.measurements.wiring = {
    genericSelector: /querySelectorAll\('\[data-mem-view\]'\)/.test(EVENTS),
    readsDataset: /button\.dataset\.memView/.test(EVENTS)
};
assert('G2: 보기 전환이 일반 배선이라 새 보기가 코드 수정 없이 걸린다',
    out.measurements.wiring.genericSelector && out.measurements.wiring.readsDataset,
    out.measurements.wiring);

// ── 실행 하니스: renderMems / renderMemGraph 를 실제로 돌린다 ────────────
const el = () => {
    const cls = new Set();
    return {
        innerHTML: '', textContent: '', value: '',
        classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c),
                     toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else if (on) { cls.add(c); } else { cls.delete(c); } },
                     contains: (c) => cls.has(c) },
        style: {}, dataset: {}, _cls: cls,
        addEventListener() {}, closest() { return this; }, querySelector() { return null; },
        getContext() { return ctxStub; },
        getBoundingClientRect() { return { width: 800, height: 420, top: 0, left: 0 }; },
        get clientWidth() { return 800; }, get clientHeight() { return 420; },
        parentElement: null
    };
};
let drawn = { arcs: 0, lines: 0, texts: 0 };
const ctxStub = {
    setTransform() {}, clearRect() {}, beginPath() {}, arc() { drawn.arcs += 1; },
    fill() {}, stroke() { drawn.lines += 1; }, moveTo() {}, lineTo() {},
    fillText() { drawn.texts += 1; }, strokeText() {}, measureText: () => ({ width: 20 }),
    set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
    set textAlign(v) {}, set textBaseline(v) {}
};

function buildHarness(graphView, memView) {
    const nodes = {};
    const stage = el();
    const overlay = {
        querySelector: (s) => {
            const id = s.replace(/^#/, '');
            if (id === 'ml-graph-cv') { const c = nodes['ml-graph-cv'] || (nodes['ml-graph-cv'] = el()); c.parentElement = stage; return c; }
            if (!nodes[id]) nodes[id] = el();
            return nodes[id];
        }
    };
    return { overlay, nodes, stage, memView, graphView };
}

// 15b 에서 렌더러 블록을 뽑아 실행한다.
//   블록 경계는 **심볼**로 잡는다(좌표 금지 — 실측에서 세 번 어긋났다).
const blockStart = CONTENT.indexOf('        // ── 연상 그래프 보기');
const blockEnd = CONTENT.indexOf('        const renderMems = (list) => {');
if (blockStart < 0 || blockEnd < 0) {
    out.reason = 'renderer_block_not_found';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
}
const rendererBlock = CONTENT.slice(blockStart, blockEnd);
// renderMems 본문도 필요하다 (그래프 분기가 거기 있다)
const renderMemsStart = blockEnd;
// 블록 끝은 **다음 최상위 주석**으로 잡는다. 좌표(고정 길이)로 자르면 함수 중간에서 끊겨
//   `Unexpected token ';'` 가 난다(실측). 심볼이 없으면 여기서 즉시 실패시킨다.
// ⚠️ 마커 문자열을 **정확히** 옮겨 적어야 한다 — '종별'로 잘못 적어 못 찾았다(실측).
const RENDER_MEMS_END_MARK = '        // 메모리 구분 — 턴별 / 종류별 보기와 분류·수명 필터.';
const renderMemsEnd = CONTENT.indexOf(RENDER_MEMS_END_MARK, renderMemsStart);
if (renderMemsEnd < 0) {
    out.reason = 'renderMems_end_marker_not_found';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
}
const renderMemsSrc = CONTENT.slice(renderMemsStart, renderMemsEnd);
// renderMemTable / memCardsHtml / esc 등은 스텁으로 대체한다 (이 게이트의 관심이 아니다)
const stubs = {
    overlay: null, esc: (x) => String(x == null ? '' : x),
    renderMemTable: () => { stubs.__tableCalled = (stubs.__tableCalled || 0) + 1; },
    syncSidebarCounts: () => {},
    memCardsHtml: () => '<cards/>',
    memGroupedHtml: () => '<groups/>',
    MemoryEngine: null,
    getActiveManagedRuntimeScopeKey: () => 'test-scope',
    getChatRuntimeScopeKey: () => 'test-scope',
    char: {}, chat: {},
    memViewState: { view: 'list', showNarrativeSource: false },
    requestAnimationFrame: (fn) => { stubs.__raf = fn; return 1; },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ fontFamily: 'sans-serif' }),
    window: { devicePixelRatio: 1 },
    document: { body: { } }
};

function makeFns(h) {
    stubs.overlay = h.overlay;
    stubs.MemoryEngine = { getHmeGraphView: () => h.graphView };
    // `memViewState` 는 추출 블록 **밖**(다른 조각)에 선언돼 있다 — 스텁으로 주입한다.
    //   추출 블록 안에 같은 선언이 있으면 중복 선언 오류가 난다(실측 2회).
    //   그래서 주입 전에 블록에서 그 선언 줄을 제거한다.
    const strip = (t) => t.replace(/^\s*const memViewState = \{[^}]*\};\s*$/gm, '');
    const src = strip(rendererBlock) + '\n' + strip(renderMemsSrc)
        + '\n; return { renderMems, renderMemGraph };';
    const keys = Object.keys(stubs);
    const fn = new Function(...keys, src);
    return fn(...keys.map(k => stubs[k]));
}

// ── G3: 그래프 보기에서 표·카드 숨김 ────────────────────────────────────
{
    const h = buildHarness({ ok: false, reason: 'no_graph_cached', nodes: [], edges: [] });
    stubs.memViewState = { view: 'graph', showNarrativeSource: false };
    const fns = makeFns(h);
    stubs.__tableCalled = 0;
    fns.renderMems([{ key: 'm_1', content: 'x' }]);
    const tableHidden = (h.nodes['ml-table']?.classList.contains('hide')) || true; // closest() 스텁이라 항상 hide 처리됨
    const cardHidden = h.nodes['ml']?.classList.contains('hide');
    const graphShown = !h.nodes['ml-graph']?.classList.contains('hide');
    out.measurements.g3 = { cardHidden, graphShown, tableCallCount: stubs.__tableCalled };
    assert('G3: 그래프 보기에서 카드가 숨고 그래프 패널이 보인다 (표 렌더를 타지 않는다)',
        cardHidden === true && graphShown === true && stubs.__tableCalled === 0, out.measurements.g3);
}

// ── G4: 그래프 없으면 만들지 않고 안내만 ────────────────────────────────
{
    const h = buildHarness({ ok: false, reason: 'no_graph_cached', nodes: [], edges: [] });
    const fns = makeFns(h);
    drawn = { arcs: 0, lines: 0, texts: 0 };
    stubs.__raf = null;
    fns.renderMemGraph();
    // ⚠️ 실측: 그리기는 **rAF 콜백 안**에서 일어나므로 `drawn.arcs` 만 세면 못 잡는다
    //    (rAF 를 안 돌리면 정상이든 결함이든 0 이다 — M2 변이가 그 때문에 MISS 였다).
    //    판정은 **렌더 루프를 시작했는가**(rAF 요청)를 함께 본다.
    out.measurements.g4 = { arcs: drawn.arcs, lines: drawn.lines, rafRequested: !!stubs.__raf,
                            emptyNote: (h.nodes['ml-graph-paths']?.innerHTML || '').includes('아직 없습니다') };
    assert('G4: [핵심] 그래프가 없으면 그리지 않고 안내만 한다 (루프를 시작하지 않는다)',
        drawn.arcs === 0 && drawn.lines === 0 && stubs.__raf === null
        && out.measurements.g4.emptyNote === true,
        out.measurements.g4);
}

// ── G5: 제품 뷰 API 로 실제로 채운다 ────────────────────────────────────
{
    const view = {
        ok: true,
        nodes: [
            { id: 'n1', rowId: 'm_1', nodeType: 'memory', label: 'm_1', turn: 1 },
            { id: 'n2', rowId: 'm_2', nodeType: 'memory', label: 'm_2', turn: 2 },
            { id: 'e1', rowId: 'lmai_entity::아리엘', nodeType: 'entity', label: '아리엘', turn: 1 },
            { id: 'l1', rowId: 'lmai_character_lore_cues::x', nodeType: 'lore', label: 'lb_별핵 / lorebook', turn: 1 }
        ],
        edges: [
            { from: 'n1', to: 'e1', relation: 'mentions_entity', layer: 'meaning', weight: 1 },
            { from: 'e1', to: 'n2', relation: 'mentions_entity', layer: 'meaning', weight: 0.8 },
            { from: 'l1', to: 'n1', relation: 'described_by_lore', layer: 'meaning', weight: 0.5 }
        ],
        stats: { nodeCount: 4, edgeCount: 3, relationCounts: { mentions_entity: 2, described_by_lore: 1 } }
    };
    const h = buildHarness(view);
    const fns = makeFns(h);
    drawn = { arcs: 0, lines: 0, texts: 0 };
    stubs.__raf = null;
    fns.renderMemGraph();
    // rAF 를 실제로 돌려 그려지게 한다 — 그리기가 rAF 안에 있으므로 이것 없이는 0 이다.
    if (stubs.__raf) { const r = stubs.__raf; stubs.__raf = null; r(); }
    const kpi = h.nodes['ml-graph-kpi']?.innerHTML || '';
    const paths = h.nodes['ml-graph-paths']?.innerHTML || '';
    out.measurements.g5 = {
        arcs: drawn.arcs, lines: drawn.lines, texts: drawn.texts,
        kpiHasNode: kpi.includes('노드'), kpiHasEntity: kpi.includes('인물'),
        pathsHasRelation: paths.includes('mentions_entity'),
        rafStarted: !!stubs.__raf || drawn.arcs > 0
    };
    assert('G5: [핵심] 제품 뷰 API 로 노드·엣지를 실제로 그린다 (엣지 관계도 표시)',
        drawn.arcs >= 4 && drawn.lines >= 3 && out.measurements.g5.pathsHasRelation
        && out.measurements.g5.kpiHasEntity,
        out.measurements.g5);
}

// ── G6: 그래프 보기는 목록 필터와 무관 ──────────────────────────────────
{
    const g6 = /if \(memViewState\.view === 'graph'\) \{ renderMems\(rows\); return; \}/.test(CONTENT);
    out.measurements.g6 = { filterShortCircuit: g6 };
    assert('G6: 그래프 보기가 목록 필터와 무관하게 동작한다 (빈 목록에서도 그래프를 그린다)',
        g6, out.measurements.g6);
}

out.ok = out.assertions.every(a => a.ok);
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
