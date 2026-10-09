'use strict';
// Gate (A): 인물 화면의 '그래프' 보기 + 인물 중심 뷰(기억 포함) API.
//
// 세 화면(메모리·관계·인물)이 **같은 공용 렌더러**를 쓰므로, 이 게이트는
// 인물 화면 계약과 **다른 두 화면 회귀**를 함께 잰다.
//
// 판정:
//   P1 마크업 계약 — 인물 패널에 보기 토글·캔버스·KPI·요약이 있다
//   P2 배선이 일반적이라 새 보기가 코드 수정 없이 걸린다
//   P3 [핵심] 인물 뷰가 인물 + **인물당 상한만큼의 기억**을 담는다 (관계 뷰와 다른 점)
//   P4 인물 뷰가 그래프 없으면 만들지 않고 없다고 알린다
//   P5 인물 그래프가 실제로 그려진다 (실행)
//   P6 [회귀] 메모리·관계 화면 그래프가 그대로 동작한다
//   P7 세 화면의 대상 id 가 모두 분리돼 있다
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

// ── P1 마크업 ────────────────────────────────────────────────────────────
const bodyStart = GUI.indexOf('const GUI_BODY = `');
const body = GUI.slice(bodyStart, GUI.indexOf('`;', bodyStart));
const entStart = body.indexOf('id="tab-entity"');
const entEnd = body.indexOf('id="tab-relations"', entStart);
const entPanel = body.slice(entStart, entEnd > entStart ? entEnd : undefined);
out.measurements.markup = {
    toggle: entPanel.includes('data-ent-view="graph"'),
    canvas: entPanel.includes('id="el-graph-cv"'),
    host: entPanel.includes('id="el-graph"'),
    kpi: entPanel.includes('id="el-graph-kpi"'),
    paths: entPanel.includes('id="el-graph-paths"')
};
assert('P1: 마크업 계약 — 인물 패널에 그래프 토글·캔버스·KPI·요약이 있다',
    Object.values(out.measurements.markup).every(Boolean), out.measurements.markup);

// ── P2 배선 ──────────────────────────────────────────────────────────────
out.measurements.wiring = {
    genericSelector: /querySelectorAll\('\[data-ent-view\]'\)/.test(EVENTS),
    readsDataset: /button\.dataset\.entView/.test(EVENTS),
    callsRenderEnts: /renderEnts\(\)/.test(EVENTS)
};
assert('P2: 인물 보기 전환이 일반 배선이라 새 보기가 코드 수정 없이 걸린다',
    Object.values(out.measurements.wiring).every(Boolean), out.measurements.wiring);

// ── 제품 API 실행 하니스 ─────────────────────────────────────────────────
const WHO = [['아리엘', '기사'], ['세라', '마법사'], ['카일', '정찰병'], ['미르', '연금술사']];
const MEM_N = 200;

async function loadProduct() {
    const chat = { id: 'cg', localLore: [], msgs: [], message: [], isStreaming: false };
    const char = { id: 'cg-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
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
        + '\n;globalThis.__CG__={MemoryEngine:typeof MemoryEngine!=="undefined"?MemoryEngine:null};\n'
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
    return { api: context.__CG__, char, chat };
}

(async () => {
    const { api, char, chat } = await loadProduct();
    const ME = api.MemoryEngine;

    let before = null;
    try { before = ME.getHmeCharacterGraphView('cg-scope', { memoriesPerEntity: 5 }); } catch (e) { before = { thrown: String(e.message) }; }

    const lore = [];
    for (let i = 1; i <= MEM_N; i += 1) {
        const w = WHO[i % WHO.length][0];
        lore.push({
            key: `m_${i}`, comment: 'lmai_memory',
            content: `[META:${JSON.stringify({ t: i, ttl: -1, imp: 6, cat: 'personal', ent: [w] })}]\n${w}이 ${i}번째 임무를 마쳤다.\n`
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
    const RELS = [['아리엘', '세라', 0.8, 0.7], ['아리엘', '카일', 0.35, 0.5]];
    for (const [a, b, cls, trs] of RELS) {
        lore.push({
            key: `lmai_relation::${a}::${b}`, comment: 'lmai_relation',
            content: JSON.stringify({ entityA: a, entityB: b, relationType: '동료', details: { closeness: cls, trust: trs }, meta: { created: 1 } })
        });
    }
    ME.setTurn(MEM_N);
    ME.setLorebook(char, chat, lore);
    const entries = ME.getManagedEntries(lore);
    try { await ME.retrieveMemories('아리엘 임무 상태를 확인한다', MEM_N, entries, { scopeKey: 'cg-scope' }, 8); } catch (_) {}

    const view = ME.getHmeCharacterGraphView('cg-scope', { memoriesPerEntity: 5 });
    const vt = (view?.nodes || []).reduce((m, n) => { const k = n.nodeType || '?'; m[k] = (m[k] || 0) + 1; return m; }, {});
    // 인물별 등장 기억 수 — 상한(5) 이하인가
    const perEnt = {};
    const idType = new Map((view?.nodes || []).map(n => [n.id, n.nodeType]));
    for (const e of (view?.edges || [])) {
        if (e.relation !== 'mentions_entity') continue;
        const entId = idType.get(e.from) === 'entity' ? e.from : (idType.get(e.to) === 'entity' ? e.to : null);
        if (!entId) continue;
        perEnt[entId] = (perEnt[entId] || 0) + 1;
    }
    out.measurements.charView = {
        ok: view?.ok, reason: view?.reason, nodes: (view?.nodes || []).length, edges: (view?.edges || []).length,
        types: vt, perEntityMemories: perEnt, stats: view?.stats
    };

    // P3 — 인물 + 인물당 상한 기억
    const counts = Object.values(perEnt);
    assert('P3: [핵심] 인물 뷰가 인물 + 인물당 상한(5)만큼의 기억을 담는다',
        view?.ok === true && Number(vt.entity || 0) >= 2 && Number(vt.memory || 0) > 0
        && counts.length > 0 && counts.every(c => c <= 5),
        out.measurements.charView);

    // P4 — 없으면 안 만든다
    assert('P4: 인물 뷰가 그래프 없으면 만들지 않고 없다고 알린다',
        before && before.ok === false && before.reason === 'no_graph_cached'
        && Array.isArray(before.nodes) && before.nodes.length === 0,
        { before });

    // ── 실행 하니스 ──────────────────────────────────────────────────────
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

    const blockStart = CONTENT.indexOf('        // ── 연상 그래프 보기');
    const MEM_GRAPH_END = '        const renderMems = (list) => {';
    const blockEnd = CONTENT.indexOf(MEM_GRAPH_END, blockStart);
    const entViewStart = CONTENT.indexOf('        const entViewState = { view: \'list\' };');
    const entViewEnd = CONTENT.indexOf('        const renderEnts = () => {');
    const graphBlock = CONTENT.slice(blockStart, blockEnd);
    const entViewSrc = CONTENT.slice(entViewStart, entViewEnd);
    if (blockStart < 0 || blockEnd < 0 || entViewStart < 0) {
        out.reason = 'renderer_block_not_found';
        console.log(JSON.stringify(out, null, 2)); process.exit(1);
    }

    function makeFns(views) {
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
        const stubs = {
            overlay, esc: (x) => String(x == null ? '' : x),
            MemoryEngine: {
                getHmeGraphView: () => views.mem || null,
                getHmeEntityGraphView: () => views.rel || null,
                getHmeCharacterGraphView: () => views.ent || null
            },
            getActiveManagedRuntimeScopeKey: () => 'cg-scope',
            getChatRuntimeScopeKey: () => 'cg-scope',
            char: {}, chat: {},
            applyGuiEntityBlocklistToLocalSnapshots: () => {},
            syncSidebarCounts: () => {},
            _ENT: [], _REL: [], _MEM: [],
            parseGuiStoredJson: () => ({}), parseMeta: () => ({}),
            EntityManager: null,
            requestAnimationFrame: (fn) => { stubs.__raf = fn; return 1; },
            cancelAnimationFrame: () => {},
            getComputedStyle: () => ({ fontFamily: 'sans-serif' }),
            window: { devicePixelRatio: 1 },
            document: { body: {} }
        };
        const strip = (t) => t.replace(/^\s*const (memViewState|relViewState|entViewState) = \{[^}]*\};\s*$/gm, '');
        const src = strip(graphBlock) + '\n' + strip(entViewSrc)
            + '\n; return { renderGraphView, renderMemGraph, renderRelGraph, renderEntGraph, GRAPH_TARGET_MEM, GRAPH_TARGET_REL, GRAPH_TARGET_ENT };';
        const keys = Object.keys(stubs);
        return { fns: new Function(...keys, src)(...keys.map(k => stubs[k])), stubs, nodes };
    }

    const mk = (entType, relType, memType) => ({
        ent: { ok: true, nodes: [
            { id: 'e0', rowId: 'lmai_entity::아리엘', nodeType: 'entity', label: '아리엘', turn: 1 },
            { id: 'e1', rowId: 'lmai_entity::세라', nodeType: 'entity', label: '세라', turn: 1 },
            { id: 'm0', rowId: 'm_1', nodeType: 'memory', label: 'm_1', turn: 1 },
            { id: 'm1', rowId: 'm_2', nodeType: 'memory', label: 'm_2', turn: 2 }
        ], edges: [
            { from: 'e0', to: 'm0', relation: 'mentions_entity', weight: 1 },
            { from: 'e1', to: 'm1', relation: 'mentions_entity', weight: 0.9 },
            { from: 'e0', to: 'e1', relation: 'relation_record', weight: 0.8 }
        ], stats: { nodeCount: 4, edgeCount: 9, relationCounts: { mentions_entity: 40, relation_record: 2 } } },
        rel: { ok: true, nodes: [
            { id: 'e0', rowId: 'lmai_entity::아리엘', nodeType: 'entity', label: '아리엘', turn: 1 },
            { id: 'e1', rowId: 'lmai_entity::세라', nodeType: 'entity', label: '세라', turn: 1 }
        ], edges: [{ from: 'e0', to: 'e1', relation: 'relation_record', weight: 0.8 }],
        stats: { nodeCount: 2, edgeCount: 1, linkedCount: 2, relationCounts: { relation_record: 1 } } },
        mem: { ok: true, nodes: [
            { id: 'm0', rowId: 'm_1', nodeType: 'memory', label: 'm_1', turn: 1 },
            { id: 'e0', rowId: 'lmai_entity::아리엘', nodeType: 'entity', label: '아리엘', turn: 1 },
            { id: 'l0', rowId: 'lmai_character_lore_cues::x', nodeType: 'lore', label: 'lb_별핵 / lorebook', turn: 1 }
        ], edges: [{ from: 'm0', to: 'e0', relation: 'mentions_entity', weight: 1 }],
        stats: { nodeCount: 3, edgeCount: 1, relationCounts: { mentions_entity: 1 } } }
    });

    // P5 — 인물 그래프
    {
        const { fns, stubs, nodes } = makeFns(mk());
        stubs.__raf = null;
        drawn = { arcs: 0, lines: 0 };
        fns.renderEntGraph();
        if (stubs.__raf) { const r = stubs.__raf; stubs.__raf = null; r(); }
        const kpi = nodes['el-graph-kpi']?.innerHTML || '';
        const paths = nodes['el-graph-paths']?.innerHTML || '';
        out.measurements.entRender = { arcs: drawn.arcs, lines: drawn.lines, kpiHas기억: kpi.includes('기억'), kpiHas등장: kpi.includes('등장'), paths: paths.slice(0, 60) };
        assert('P5: [핵심] 인물 그래프가 인물·기억·관계로 실제로 그려진다',
            drawn.arcs >= 4 && drawn.lines >= 3 && kpi.includes('기억') && kpi.includes('등장'),
            out.measurements.entRender);
    }

    // P6 — 회귀: 메모리·관계
    {
        const { fns, stubs, nodes } = makeFns(mk());
        stubs.__raf = null; drawn = { arcs: 0, lines: 0 };
        fns.renderMemGraph();
        if (stubs.__raf) { const r = stubs.__raf; stubs.__raf = null; r(); }
        const memArcs = drawn.arcs, memKpi = nodes['ml-graph-kpi']?.innerHTML || '';
        stubs.__raf = null; drawn = { arcs: 0, lines: 0 };
        fns.renderRelGraph();
        if (stubs.__raf) { const r = stubs.__raf; stubs.__raf = null; r(); }
        const relArcs = drawn.arcs, relKpi = nodes['rl-graph-kpi']?.innerHTML || '';
        out.measurements.regression = { memArcs, relArcs, memHasLore: memKpi.includes('로어'), relHas인물: relKpi.includes('인물') };
        assert('P6: [회귀] 메모리·관계 화면 그래프가 세 번째 화면 추가 후에도 그대로 동작한다',
            memArcs >= 3 && relArcs >= 2 && memKpi.includes('로어') && relKpi.includes('인물'),
            out.measurements.regression);
    }

    // P7 — 세 화면 대상 분리
    {
        const { fns } = makeFns(mk());
        const a = fns.GRAPH_TARGET_MEM, b = fns.GRAPH_TARGET_REL, c = fns.GRAPH_TARGET_ENT;
        const hosts = [a.host, b.host, c.host];
        out.measurements.targets = { hosts, distinct: new Set(hosts).size === 3 };
        assert('P7: 세 화면의 그래프 대상 id 가 모두 분리돼 있다',
            new Set(hosts).size === 3 && new Set([a.cv, b.cv, c.cv]).size === 3, out.measurements.targets);
    }

    out.ok = out.assertions.every(a => a.ok);
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
})().catch(e => { console.log(JSON.stringify({ ok: false, fatal: String(e && e.stack || e) })); process.exit(1); });
