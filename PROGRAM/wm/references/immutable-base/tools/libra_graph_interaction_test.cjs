'use strict';
// Gate (C): 그래프 상호작용 — 노드를 클릭하면 그 대상으로 이동하는가.
//
// 왜 필요한가:
//   그래프가 지금까지 **보기만** 됐다. "이 인물을 통해 연결된 기억"이 화면에 보이는데
//   거기서 그 기억으로 갈 수 없으면 정작 확인하려면 화면을 떠나야 한다.
//   상호작용이 붙어야 그래프가 **탐색 도구**가 된다.
//
// 판정:
//   C1 캔버스에 클릭·호버 배선이 있다 (중복 바인딩 없이)
//   C2 [핵심] 노드 hit test 가 **화면 좌표 → 월드 좌표** 변환으로 맞는 노드를 찾는다
//   C3 [핵심] 인물 노드 클릭 → 인물 프로필이 열린다 (rowId·이름 양쪽 매칭)
//   C4 [핵심] 기억 노드 클릭 → 메모리 화면으로 이동하고 그 항목이 검색된다
//   C5 로어 노드 클릭은 **없는 화면을 만들지 않는다** (강조만)
//   C6 빈 곳 클릭은 아무 동작도 하지 않는다
//   C7 호버가 커서와 강조를 바꾼다
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js'), 'utf8');
const out = { ok: false, assertions: [], measurements: {} };
const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });

// ── 실행 하니스 ──────────────────────────────────────────────────────────
const el = () => {
    const cls = new Set();
    const handlers = {};
    return {
        innerHTML: '', textContent: '', value: '', dataset: {}, style: {},
        _cls: cls, _handlers: handlers,
        classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c),
                     toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else if (on) { cls.add(c); } else { cls.delete(c); } },
                     contains: (c) => cls.has(c) },
        addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
        fire(ev, arg) { (handlers[ev] || []).forEach(fn => fn(arg)); },
        closest() { return this; }, querySelector() { return null; },
        getContext() { return ctxStub; },
        getBoundingClientRect() { return { width: 800, height: 420, left: 0, top: 0 }; },
        get clientWidth() { return 800; }, get clientHeight() { return 420; },
        parentElement: null
    };
};
let drawn = { arcs: 0, lines: 0 };
const ctxStub = {
    setTransform() {}, clearRect() {}, beginPath() {}, arc() { drawn.arcs += 1; },
    fill() {}, stroke() { drawn.lines += 1; }, moveTo() {}, lineTo() {},
    fillText() {}, strokeText() {}, measureText: () => ({ width: 20 }),
    set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
    set textAlign(v) {}, set textBaseline(v) {}
};

const blockStart = CONTENT.indexOf('        // ── 연상 그래프 보기');
const MEM_GRAPH_END = '        const renderMems = (list) => {';
const blockEnd = CONTENT.indexOf(MEM_GRAPH_END, blockStart);
if (blockStart < 0 || blockEnd < 0) {
    out.reason = 'renderer_block_not_found';
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
}
const graphBlock = CONTENT.slice(blockStart, blockEnd);

function makeHarness() {
    const nodes = {};
    const stage = el();
    const overlay = {
        querySelector: (s) => {
            const id = s.replace(/^#/, '');
            if (!nodes[id]) nodes[id] = el();
            if (id.endsWith('-cv')) nodes[id].parentElement = stage;
            return nodes[id];
        },
        querySelectorAll: () => []
    };
    const calls = { profile: [], tab: [], filter: 0 };
    const stubs = {
        overlay, esc: (x) => String(x == null ? '' : x),
        MemoryEngine: { getHmeGraphView: () => null, getHmeEntityGraphView: () => null, getHmeCharacterGraphView: () => null },
        getActiveManagedRuntimeScopeKey: () => 's', getChatRuntimeScopeKey: () => 's',
        // `memViewState` 는 추출 블록 **밖**(다른 조각)에 선언돼 있다 — 스텁으로 주입한다.
        memViewState: { view: 'graph', showNarrativeSource: false },
        char: {}, chat: {},
        _ENT: [
            { key: 'lmai_entity::아리엘' },
            { key: 'lmai_entity::세라' }
        ],
        _MEM: [{ key: 'm_7', content: 'x' }], _REL: [],
        parseGuiStoredJson: (e) => ({ name: String(e?.key || '').replace('lmai_entity::', '') }),
        parseMeta: () => ({}),
        renderEntityProfile: (i) => { calls.profile.push(i); },
        switchTab: (t) => { calls.tab.push(t); },
        filterMems: () => { calls.filter += 1; },
        memCardsHtml: () => '', memGroupedHtml: () => '',
        renderMemTable: () => {}, syncSidebarCounts: () => {},
        requestAnimationFrame: (fn) => { stubs.__raf = fn; return 1; },
        cancelAnimationFrame: () => {},
        getComputedStyle: () => ({ fontFamily: 'sans-serif' }),
        window: { devicePixelRatio: 1 },
        document: { body: {} }
        // `graphCleanLabel`·`GRAPH_TYPE_R`·`GRAPH_REL_C` 등은 추출 블록 **안에** 정의돼 있다 —
        //   스텁으로도 넣으면 `Identifier already declared` 가 난다(실측).
    };
    const strip = (t) => t.replace(/^\s*const (memViewState|relViewState|entViewState) = \{[^}]*\};\s*$/gm, '');
    const src = strip(graphBlock)
        + '\n; return { renderGraphView, GRAPH_TARGET_MEM, graphNodeAt, graphActivateNode, graphHoverAt, bindGraphInteraction, graphState, getState: () => graphState };';
    const keys = Object.keys(stubs);
    const fns = new Function(...keys, src)(...keys.map(k => stubs[k]));
    return { fns, stubs, nodes, calls, overlay };
}

// ── C1 배선 존재 ────────────────────────────────────────────────────────
{
    const { fns, nodes } = makeHarness();
    fns.bindGraphInteraction(fns.GRAPH_TARGET_MEM);
    const cv = nodes['ml-graph-cv'];
    const evs = Object.keys(cv._handlers);
    fns.bindGraphInteraction(fns.GRAPH_TARGET_MEM);   // 중복 호출
    const evs2 = Object.keys(cv._handlers);
    const counts = {};
    for (const k of evs2) counts[k] = cv._handlers[k].length;
    out.measurements.wiring = { events: evs, countsAfterDoubleBind: counts, boundFlag: cv.dataset.bound };
    assert('C1: 캔버스에 클릭·호버 배선이 있고 중복 바인딩이 없다',
        evs.includes('click') && evs.includes('mousemove') && evs.includes('mouseleave')
        && Object.values(counts).every(c => c === 1),
        out.measurements.wiring);
}

// ── C2 hit test (좌표 변환) ─────────────────────────────────────────────
{
    const { fns, nodes } = makeHarness();
    const cv = nodes['ml-graph-cv'];
    // 그래프 상태를 직접 세팅 — 노드 하나를 알려진 월드 좌표에 둔다
    const st = fns.getState();
    st.nodes = [{ id: 'n1', rowId: 'm_7', type: 'memory', label: 'm_7', turn: 7, deg: 0, x: 100, y: 60, vx: 0, vy: 0 }];
    st.edges = [];
    st.scale = 2; st.tx = 10; st.ty = 20;
    // 화면 좌표 = world*scale + t → (210, 140). rect.left/top = 0.
    const hit = fns.graphNodeAt(fns.GRAPH_TARGET_MEM, 210, 140);
    const miss = fns.graphNodeAt(fns.GRAPH_TARGET_MEM, 600, 400);
    out.measurements.hitTest = { hitId: hit?.id || null, miss: miss?.id || null, scale: st.scale, tx: st.tx, ty: st.ty };
    assert('C2: [핵심] 노드 hit test 가 화면→월드 좌표 변환으로 맞는 노드를 찾는다',
        hit && hit.id === 'n1' && miss === null, out.measurements.hitTest);
}

// ── C3 인물 클릭 → 프로필 ───────────────────────────────────────────────
{
    const { fns, calls } = makeHarness();
    fns.graphActivateNode(fns.GRAPH_TARGET_MEM, { id: 'e1', rowId: 'lmai_entity::아리엘', type: 'entity', label: '아리엘' });
    const byRow = calls.profile.slice();
    calls.profile.length = 0;
    // 이름만으로도 찾아야 한다 (rowId 가 없을 수 있다)
    fns.graphActivateNode(fns.GRAPH_TARGET_MEM, { id: 'e2', rowId: '', type: 'entity', label: '세라 / lorebook' });
    out.measurements.entityClick = { byRowId: byRow, byLabel: calls.profile.slice() };
    assert('C3: [핵심] 인물 노드 클릭 → 인물 프로필이 열린다 (rowId·이름 양쪽 매칭)',
        byRow.length === 1 && byRow[0] === 0 && calls.profile.length === 1 && calls.profile[0] === 1,
        out.measurements.entityClick);
}

// ── C4 기억 클릭 → 메모리 화면 ──────────────────────────────────────────
{
    const { fns, calls, nodes } = makeHarness();
    fns.graphActivateNode(fns.GRAPH_TARGET_MEM, { id: 'm1', rowId: 'm_7', type: 'memory', label: 'm_7' });
    out.measurements.memoryClick = { tabs: calls.tab, filterCalled: calls.filter, searchValue: nodes['ms']?.value };
    assert('C4: [핵심] 기억 노드 클릭 → 메모리 화면으로 이동하고 그 항목이 검색된다',
        calls.tab.includes('memory') && calls.filter > 0 && String(nodes['ms']?.value) === 'm_7',
        out.measurements.memoryClick);
}

// ── C5 로어는 강조만 ────────────────────────────────────────────────────
{
    const { fns, calls, stubs } = makeHarness();
    stubs.__raf = null;
    fns.graphActivateNode(fns.GRAPH_TARGET_MEM, { id: 'l1', rowId: 'lmai_character_lore_cues::x', type: 'lore', label: 'lb_별핵' });
    const st = fns.getState();
    out.measurements.loreClick = { pinned: st.pinned, tabs: calls.tab, profiles: calls.profile };
    assert('C5: 로어 노드 클릭은 강조만 한다 (없는 화면을 만들지 않는다)',
        st.pinned === 'l1' && calls.tab.length === 0 && calls.profile.length === 0,
        out.measurements.loreClick);
}

// ── C6 빈 곳 클릭 ───────────────────────────────────────────────────────
{
    const { fns, calls } = makeHarness();
    fns.graphActivateNode(fns.GRAPH_TARGET_MEM, null);
    out.measurements.emptyClick = { tabs: calls.tab, profiles: calls.profile };
    assert('C6: 빈 곳 클릭은 아무 동작도 하지 않는다',
        calls.tab.length === 0 && calls.profile.length === 0, out.measurements.emptyClick);
}

// ── C7 호버 ─────────────────────────────────────────────────────────────
{
    const h = makeHarness();
    const fns = h.fns;
    // `graphHoverAt` 이 `overlay.querySelector` 로 캔버스를 가져오므로 **먼저 만들어진 상태**여야 한다.
    //   하니스의 키는 `#` 를 뗀 `ml-graph-cv` 다(실측 함정: `#` 포함 키로 찾아 undefined 였다).
    const cv = h.overlay.querySelector('#ml-graph-cv');
    const st = fns.getState();
    st.nodes = [{ id: 'n1', rowId: 'm_7', type: 'memory', label: 'm_7', turn: 7, deg: 0, x: 100, y: 60, vx: 0, vy: 0 }];
    st.scale = 1; st.tx = 0; st.ty = 0;
    fns.graphHoverAt(fns.GRAPH_TARGET_MEM, 100, 60);
    const onCursor = cv.style.cursor;
    const hoverId = fns.getState().hover;
    fns.graphHoverAt(fns.GRAPH_TARGET_MEM, 700, 400);
    out.measurements.hover = { onCursor, hoverId, offCursor: cv.style.cursor, offHover: fns.getState().hover };
    assert('C7: 호버가 커서와 강조를 바꾼다 (클릭 가능함을 알린다)',
        onCursor === 'pointer' && hoverId === 'n1' && cv.style.cursor === 'default' && fns.getState().hover === null,
        out.measurements.hover);
}

out.ok = out.assertions.every(a => a.ok);
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
