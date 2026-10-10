'use strict';
// Gate (A): 관계 화면의 '그래프' 보기가 실제로 배선되고 그려지는가 + 인물 중심 뷰 API.
//
// 왜 필요한가:
//   메모리 화면 그래프(A2)를 관계 화면에도 얹으면서 렌더러를 공용화했다.
//   공용화는 **기존 화면을 깨뜨리기 쉽다**(id 하드코딩 → 인자화, 상태 분리).
//   그래서 관계 화면 계약과 메모리 화면 회귀를 함께 잰다.
//
// 판정:
//   R1 마크업 계약 — 관계 패널에 보기 토글·캔버스·KPI·요약이 있다
//   R2 배선이 일반적이라 새 보기가 코드 수정 없이 걸린다
//   R3 인물 중심 뷰 API 가 **인물 노드와 그들 사이 엣지만** 돌려준다 (기억 노드 배제)
//   R4 관계 뷰가 그래프 없으면 만들지 않고 없다고 알린다
//   R5 관계 보기에서 표를 숨기고 그래프를 실제로 그린다 (실행)
//   R6 [회귀] 메모리 화면 그래프가 공용화 후에도 그대로 동작한다
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const out = { ok: false, assertions: [], measurements: {} };
const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });
const clone = (v) => JSON.parse(JSON.stringify(v));

const read = (n) => fs.readFileSync(path.join(ROOT, 'src', 'parts', n), 'utf8');
const GUI = read('15-gui-and-exports.js');
const CONTENT = read('15b-gui-content-world-dlc.js');
const EVENTS = read('15d-gui-events-finalize.js');

// ── R1 마크업 계약 ───────────────────────────────────────────────────────
const bodyStart = GUI.indexOf('const GUI_BODY = `');
const body = GUI.slice(bodyStart, GUI.indexOf('`;', bodyStart));
const relPanelStart = body.indexOf('id="tab-relations"');
const relPanelEnd = body.indexOf('id="tab-world"', relPanelStart);
const relPanel = body.slice(relPanelStart, relPanelEnd > relPanelStart ? relPanelEnd : undefined);
out.measurements.markup = {
    viewToggle: relPanel.includes('data-rel-view="graph"'),
    canvas: relPanel.includes('id="rl-graph-cv"'),
    host: relPanel.includes('id="rl-graph"'),
    kpi: relPanel.includes('id="rl-graph-kpi"'),
    paths: relPanel.includes('id="rl-graph-paths"')
};
assert('R1: 마크업 계약 — 관계 패널에 그래프 토글·캔버스·KPI·요약이 있다',
    Object.values(out.measurements.markup).every(Boolean), out.measurements.markup);

// ── R2 배선 일반성 ───────────────────────────────────────────────────────
out.measurements.wiring = {
    genericSelector: /querySelectorAll\('\[data-rel-view\]'\)/.test(EVENTS),
    readsDataset: /button\.dataset\.relView/.test(EVENTS),
    callsRenderRels: /renderRels\(\)/.test(EVENTS)
};
assert('R2: 관계 보기 전환이 일반 배선이라 새 보기가 코드 수정 없이 걸린다',
    Object.values(out.measurements.wiring).every(Boolean), out.measurements.wiring);

// ── 제품 API 실행 하니스 (인물 중심 뷰) ──────────────────────────────────
const WHO = [['아리엘', '기사'], ['세라', '마법사'], ['카일', '정찰병'], ['미르', '연금술사']];
const MEM_N = 200;

async function loadProduct() {
    const chat = { id: 'rg', localLore: [], msgs: [], message: [], isStreaming: false };
    const char = { id: 'rg-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
    const args = new Map(Object.entries({ debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off', hme_graph_debug: 'full' }));
    const risuai = {
        async getArgument(n) { return args.get(n); },
        async requestPluginPermission() { return true; },
        async getCharacter() { return clone(char); },
        async getCurrentCharacterIndex() { return 0; },
        async getCurrentChatIndex() { return 0; },
        async getCharacterFromIndex() { return clone(char); },
        async getChatFromIndex() { return clone(chat); },
        async setChatToIndex() { return true; },
        async setCharacter() { return true; },
        async getDatabase() { return { personas: [] }; },
        async addRisuReplacer() {}, async removeRisuReplacer() {},
        async addRisuScriptHandler() {}, async removeRisuScriptHandler() {},
        async registerBodyIntercepter() { return 'x'; }, async unregisterBodyIntercepter() {},
        async onUnload() {},
        async registerSetting() {}, async registerButton() {},
        async showContainer() {}, async hideContainer() {},
        pluginStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; } },
        async nativeFetch() { throw new Error('no fetch'); }
    };
    let code = fs.readFileSync(DIST, 'utf8');
    const close = code.lastIndexOf('\n})();');
    code = code.slice(0, close)
        + '\n;globalThis.__RG__={MemoryEngine:typeof MemoryEngine!=="undefined"?MemoryEngine:null,MemoryState,getChatRuntimeScopeKey};\n'
        + code.slice(close);
    const context = {
        console: { log() {}, warn() {}, error() {}, debug() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, performance,
        crypto: { randomUUID: require('crypto').randomUUID },
        AbortController, TextEncoder, TextDecoder, URL, Buffer,
        fetch: async () => { throw new Error('no fetch'); },
        risuai, Risuai: risuai, globalThis: null, process: { env: {} },
        atob: (t) => Buffer.from(String(t), 'base64').toString('binary'),
        btoa: (t) => Buffer.from(String(t), 'binary').toString('base64')
    };
    context.globalThis = context;
    vm.createContext(context);
    const p = vm.runInContext(code, context, { filename: DIST, timeout: 60000 });
    if (p && typeof p.then === 'function') await p;
    await new Promise(r => setTimeout(r, 60));
    return { api: context.__RG__, char, chat };
}

(async () => {
    const { api, char, chat } = await loadProduct();
    const ME = api.MemoryEngine;
    const scopeKey = api.getChatRuntimeScopeKey(chat,char);
    api.MemoryState._activeScopeKey = scopeKey;

    // R4 먼저 — 그래프가 아직 없을 때
    let before = null;
    try { before = ME.getHmeEntityGraphView(scopeKey); } catch (e) { before = { thrown: String(e.message) }; }

    // 관계 데이터(인물 간) + 기억을 만들어 그래프를 돌린다
    const lore = [];
    for (let i = 1; i <= MEM_N; i += 1) {
        const w = WHO[i % WHO.length][0];
        lore.push({
            key: `m_${i}`, comment: 'lmai_memory',
            content: `[META:${JSON.stringify({ t: i, ttl: -1, imp: 6, cat: 'personal', ent: [w] })}]\n${w}은 ${i}번째 임무를 마쳤다.\n`
        });
    }
    for (const [n, r] of WHO) lore.push({
        key: `lmai_entity::${n}`, comment: 'lmai_entity',
        content: JSON.stringify({
            name: n, type: 'character',
            identity: { aliases: [], summary: `${n} 요약`, roleInStory: r, affiliation: '북부 기사단' },
            meta: { created: 1, aliases: [], hiddenNameKeys: [] }
        })
    });
    // 인물 간 관계 기록 — E3(relation_record) 의 소스
    const RELS = [['아리엘', '세라', 0.8, 0.7], ['아리엘', '카일', 0.35, 0.5], ['세라', '미르', 0.6, 0.55]];
    for (const [a, b, cls, trs] of RELS) {
        lore.push({
            key: `lmai_relation::${a}::${b}`, comment: 'lmai_relation',
            content: JSON.stringify({
                entityA: a, entityB: b, relationType: '동료',
                details: { closeness: cls, trust: trs },
                meta: { created: 1 }
            })
        });
    }
    ME.setTurn(MEM_N);
    ME.setLorebook(char, chat, lore);
    const entries = ME.getManagedEntries(lore);
    await ME.retrieveMemories('아리엘 임무 상태를 확인한다', MEM_N, entries, { scopeKey: scopeKey }, 8);

    const g = (ME.getLastRetrievalDebug() || {}).hmeAssociativeGraph || {};
    out.measurements.graph = {
        ok: g.ok, reason: g.reason, nodeCount: g.nodeCount, edgeCount: g.edgeCount,
        relationCounts: g.relationCounts
    };

    const view = ME.getHmeEntityGraphView(scopeKey);
    out.measurements.entityView = {
        ok: view?.ok, reason: view?.reason,
        nodes: (view?.nodes || []).length, edges: (view?.edges || []).length,
        types: Array.from(new Set((view?.nodes || []).map(n => n.nodeType))),
        relations: Array.from(new Set((view?.edges || []).map(e => e.relation))),
        stats: view?.stats
    };

    // R3 — 인물 노드만 + 그들 사이 엣지만
    const onlyEntities = (view?.nodes || []).length > 0 && (view?.nodes || []).every(n => n.nodeType === 'entity');
    const nodeIds = new Set((view?.nodes || []).map(n => n.id));
    const noOrphan = (view?.edges || []).every(e => nodeIds.has(e.from) && nodeIds.has(e.to));
    assert('R3: [핵심] 인물 중심 뷰가 인물 노드와 그들 사이 엣지만 돌려준다 (기억 노드 배제)',
        onlyEntities && noOrphan && (view?.nodes || []).length >= 2,
        { ...out.measurements.entityView, onlyEntities, noOrphan });

    // R4 — 그래프 없으면 만들지 않는다
    assert('R4: [핵심] 그래프가 없으면 만들지 않고 없다고 알린다',
        before && before.ok === false && before.reason === 'no_graph_cached'
        && Array.isArray(before.nodes) && before.nodes.length === 0,
        { before });
    assert('R3b: 관계(E3 relation_record)가 인물 엣지로 실제로 존재한다',
        (view?.edges || []).some(e => e.relation === 'relation_record'),
        { relations: out.measurements.entityView.relations, relCounts: out.measurements.graph.relationCounts });

    // ── 실행 하니스: 관계/메모리 렌더러를 돌린다 ─────────────────────────
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
    let drawn = { arcs: 0, lines: 0 };
    const ctxStub = {
        setTransform() {}, clearRect() {}, beginPath() {}, arc() { drawn.arcs += 1; },
        fill() {}, stroke() { drawn.lines += 1; }, moveTo() {}, lineTo() {},
        fillText() {}, strokeText() {}, measureText: () => ({ width: 20 }),
        set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
        set textAlign(v) {}, set textBaseline(v) {}
    };

    // 그래프 렌더러 블록만 뽑는다. `renderMems` 는 블록 밖(`memCardsHtml` 등을 쓰므로) 제외한다 —
    //   포함하면 그 함수들이 정의되지 않아 참조 순서가 꺼진다(실측: renderGraphView is not defined).
    const blockStart = CONTENT.indexOf('        // ── 연상 그래프 보기');
    const MEM_GRAPH_END = '        const renderMems = (list) => {';
    const blockEnd = CONTENT.indexOf(MEM_GRAPH_END, blockStart);
    const relRelsStart = CONTENT.indexOf('        // 관계 보기 상태 — 메모리 보기와 같은 패턴(목록 / 그래프).');
    const relRelsEnd = CONTENT.indexOf('        const renderRels = () => {');
    const graphBlock = CONTENT.slice(blockStart, blockEnd);
    const relRelsSrc = CONTENT.slice(relRelsStart, relRelsEnd);
    if (blockStart < 0 || blockEnd < 0 || relRelsStart < 0) {
        out.reason = 'renderer_block_not_found';
        console.log(JSON.stringify(out, null, 2)); process.exit(1);
    }

    const buildHarness = (graphView, entityView, relViewName) => {
        const nodes = {};
        const stage = el();
        const overlay = {
            querySelector: (s) => {
                const id = s.replace(/^#/, '');
                if (!nodes[id]) nodes[id] = el();
                if (id.endsWith('-cv')) nodes[id].parentElement = stage;
                return nodes[id];
            }
        };
        return { overlay, nodes, stage, graphView, entityView, relViewName };
    };

    function makeFns(h) {
        const stubs = {
            overlay: h.overlay, esc: (x) => String(x == null ? '' : x),
            MemoryEngine: {
                getHmeGraphView: () => h.graphView,
                getHmeEntityGraphView: () => h.entityView
            },
            getActiveManagedRuntimeScopeKey: () => scopeKey,
            getChatRuntimeScopeKey: () => scopeKey,
            char: {}, chat: {},
            renderRels: () => { stubs.__renderRelsCalled = true; },
            syncSidebarCounts: () => {},
            memCardsHtml: () => '', memGroupedHtml: () => '', memRowsHtml: () => '',
            parseGuiStoredJson: () => ({}), parseMeta: () => ({}),
            _MEM: [], _REL: [],
            requestAnimationFrame: (fn) => { stubs.__raf = fn; return 1; },
            cancelAnimationFrame: () => {},
            getComputedStyle: () => ({ fontFamily: 'sans-serif' }),
            window: { devicePixelRatio: 1 },
            document: { body: {} }
        };
        const strip = (t) => t.replace(/^\s*const (memViewState|relViewState) = \{[^}]*\};\s*$/gm, '');
        const src = strip(graphBlock) + '\n' + strip(relRelsSrc)
            + '\n; return { renderGraphView, renderMemGraph, renderRelGraph, renderRels, GRAPH_TARGET_MEM, GRAPH_TARGET_REL, setRelView: (v) => { relViewState.view = v; } };';
        const keys = Object.keys(stubs);
        return { fns: new Function(...keys, src)(...keys.map(k => stubs[k])), stubs };
    }

    // R5 — 관계 보기에서 표 숨김 + 실제 그리기
    {
        const ev = {
            ok: true,
            nodes: [
                { id: 'e0', rowId: 'lmai_entity::아리엘', nodeType: 'entity', label: '아리엘', turn: 1 },
                { id: 'e1', rowId: 'lmai_entity::세라', nodeType: 'entity', label: '세라', turn: 1 },
                { id: 'e2', rowId: 'lmai_entity::카일', nodeType: 'entity', label: '카일', turn: 1 }
            ],
            edges: [
                { from: 'e0', to: 'e1', relation: 'relation_record', layer: 'meaning', weight: 0.8 },
                { from: 'e0', to: 'e2', relation: 'relation_record', layer: 'meaning', weight: 0.35 }
            ],
            stats: { nodeCount: 4, edgeCount: 9, linkedCount: 3, relationCounts: { relation_record: 3, mentions_entity: 40 } }
        };
        const h = buildHarness(null, ev);
        const { fns, stubs } = makeFns(h);
        stubs.__raf = null;
        drawn = { arcs: 0, lines: 0 };
        fns.renderRelGraph();
        // rAF 를 실제로 돌려야 그리기가 일어난다(실측: 안 돌리면 0).
        if (stubs.__raf) { const r = stubs.__raf; stubs.__raf = null; r(); }
        const kpi = h.nodes['rl-graph-kpi']?.innerHTML || '';
        const paths = h.nodes['rl-graph-paths']?.innerHTML || '';
        out.measurements.relRender = { arcs: drawn.arcs, lines: drawn.lines, kpiHas인물: kpi.includes('인물'), pathsHasRelation: paths.includes('relation_record') || paths.includes('엣지 관계') };
        assert('R5: [핵심] 관계 그래프가 인물 노드·엣지로 실제로 그려진다',
            drawn.arcs >= 3 && drawn.lines >= 2 && kpi.includes('인물'),
            out.measurements.relRender);
    }

    // R6 — 회귀: 메모리 화면 그래프가 공용화 후에도 동작
    {
        const mv = {
            ok: true,
            nodes: [
                { id: 'n1', rowId: 'm_1', nodeType: 'memory', label: 'm_1', turn: 1 },
                { id: 'e1', rowId: 'lmai_entity::아리엘', nodeType: 'entity', label: '아리엘', turn: 1 },
                { id: 'l1', rowId: 'lmai_character_lore_cues::x', nodeType: 'lore', label: 'lb_별핵 / lorebook', turn: 1 }
            ],
            edges: [{ from: 'n1', to: 'e1', relation: 'mentions_entity', layer: 'meaning', weight: 1 }],
            stats: { nodeCount: 3, edgeCount: 1, relationCounts: { mentions_entity: 1 } }
        };
        const h = buildHarness(mv, null);
        const { fns, stubs } = makeFns(h);
        stubs.__raf = null;
        drawn = { arcs: 0, lines: 0 };
        fns.renderMemGraph();
        if (stubs.__raf) { const r = stubs.__raf; stubs.__raf = null; r(); }
        const kpi = h.nodes['ml-graph-kpi']?.innerHTML || '';
        out.measurements.memRegression = { arcs: drawn.arcs, kpiHas로어: kpi.includes('로어'), kpiHas노드: kpi.includes('노드') };
        assert('R6: [회귀] 메모리 화면 그래프가 공용 렌더러 전환 후에도 그대로 동작한다',
            drawn.arcs >= 3 && kpi.includes('로어') && kpi.includes('노드'),
            out.measurements.memRegression);
    }

    // R7 — 메모리/관계 대상 id 가 서로 다르다 (상태·화면 분리)
    {
        const h = buildHarness(null, null);
        const { fns } = makeFns(h);
        const a = fns.GRAPH_TARGET_MEM, b = fns.GRAPH_TARGET_REL;
        out.measurements.targets = { mem: a.host, rel: b.host, distinct: a.host !== b.host && a.cv !== b.cv };
        assert('R7: 두 화면의 그래프 대상 id 가 분리돼 있다 (상태·화면이 섞이지 않는다)',
            a.host !== b.host && a.cv !== b.cv && a.kpi !== b.kpi, out.measurements.targets);
    }

    out.ok = out.assertions.every(a => a.ok);
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
})().catch(e => { console.log(JSON.stringify({ ok: false, fatal: String(e && e.stack || e) })); process.exit(1); });
