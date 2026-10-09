'use strict';
// Gate (B): 노드 상한 포화 시 종류별 보존 + 화면 상한과 그래프 보존의 구분.
//
// ■ 배경 (실측)
//   `compactHmeGraphNodes` 에 종류별 reserve 가 있다(entity 8% / lore 12%). 미측정이었다.
//   실측(기억 5000 + 로어 300, 상한 800):
//     실제 그래프 = memory 700 / entity 4 / lore **96**  ← 정확히 800×12%
//     뷰 API     = memory 260 / entity 4 / lore **36**  ← 뷰의 lore 상한
//   → **그래프는 96개를 보존하는데 화면은 36개만 보여주고 있었다.**
//     이 구분이 안 되면 "로어가 상한에 밀린다" 로 오진한다(실제로 그럴 뻔했다).
//
// ■ 판정
//   N1 상한 포화 시에도 entity·lore 가 **살아남는다** (reserve 가 실제로 작동한다)
//   N2 로어를 크게 늘려도 보존 수가 reserve 상한(12%)을 넘지 않는다 (상한이 실제로 걸린다)
//   N3 보존 수와 **화면 상한**이 다르다 — 뷰는 그래프보다 적게 담는다(의도된 절단)
//   N4 포화 상태에서도 회상이 동작하고 비용이 감당 가능하다
//   N5 상한 아래 규모에서는 절단이 없다 (작은 그래프는 그대로 전부 담긴다)
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const out = { ok: false, assertions: [], measurements: {} };
const clone = (v) => JSON.parse(JSON.stringify(v));
const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });

const WHO = [['아리엘', '기사'], ['세라', '마법사'], ['카일', '정찰병'], ['미르', '연금술사']];

async function run(memN, loreN) {
    const chat = { id: `n-${memN}-${loreN}`, localLore: [], msgs: [], message: [], isStreaming: false };
    const char = { id: 'n-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
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
        + '\n;globalThis.__NB__={MemoryEngine:typeof MemoryEngine!=="undefined"?MemoryEngine:null,MemoryState,getChatRuntimeScopeKey};\n'
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
    const p = vm.runInContext(code, context, { filename: DIST, timeout: 120000 });
    if (p && typeof p.then === 'function') await p;
    await new Promise(r => setTimeout(r, 60));

    const ME = context.__NB__.MemoryEngine;
    const scopeKey = context.__NB__.getChatRuntimeScopeKey(chat,char);
    context.__NB__.MemoryState._activeScopeKey = scopeKey;
    const lore = [];
    for (let i = 1; i <= memN; i += 1) {
        const w = WHO[i % WHO.length][0];
        lore.push({
            key: `m_${i}`, comment: 'lmai_memory',
            content: `[META:${JSON.stringify({ t: i, ttl: -1, imp: 6, cat: 'personal', ent: [w] })}]\n${w}이 ${i}번째 임무를 마쳤다.\n`
        });
    }
    for (let i = 1; i <= loreN; i += 1) {
        const w = WHO[i % WHO.length][0];
        lore.push({ key: `lb_${i}`, comment: 'lorebook', content: `[로어 ${i}] ${w}은 북부 기사단 소속이다.` });
    }
    for (const [n, r] of WHO) lore.push({
        key: `lmai_entity::${n}`, comment: 'lmai_entity',
        content: JSON.stringify({
            name: n, type: 'character',
            identity: { aliases: [], summary: `${n} 요약`, roleInStory: r, affiliation: '북부 기사단' },
            meta: { created: 1, aliases: [], hiddenNameKeys: [] }
        })
    });
    ME.setTurn(memN);
    ME.setLorebook(char, chat, lore);
    const entries = ME.getManagedEntries(lore);
    const t0 = performance.now();
    let recalled = [];
    recalled = await ME.retrieveMemories('아리엘 별핵 파편 임무 상태를 확인한다', memN, entries, { scopeKey: scopeKey }, 8);
    const ms = performance.now() - t0;
    const g = (ME.getLastRetrievalDebug() || {}).hmeAssociativeGraph || {};
    const view = ME.getHmeGraphView?.(scopeKey) || {};
    const vt = (view.nodes || []).reduce((m, n) => { const k = n.nodeType || '?'; m[k] = (m[k] || 0) + 1; return m; }, {});
    return {
        memN, loreN, ms: Number(ms.toFixed(1)), recalled: (recalled || []).length,
        graphOk: g.ok, reason: g.reason || '',
        nodeCount: Number(g.nodeCount || 0), edgeCount: Number(g.edgeCount || 0),
        viewTypes: vt,
        viewStats: view.stats || null,
        graphTotal: Number(view.stats?.nodeCount || 0),
        keptTypes: { ...(view.stats?.nodeTypeCounts || {}) }
    };
}

(async () => {
    // 규모별 측정 — 상한(800) 아래 / 포화 / 로어 폭증
    const SCALES = [[200, 4], [800, 4], [5000, 4], [5000, 20], [5000, 100], [5000, 300]];
    const rows = [];
    for (const [m, l] of SCALES) rows.push(await run(m, l));
    out.measurements.rows = rows;

    const saturated = rows.filter(r => r.nodeCount >= 800);
    const underCap = rows.filter(r => r.nodeCount < 800);

    // N1 — 포화 시에도 종류별 생존
    assert('N1: [핵심] 상한 포화 시에도 entity·lore 노드가 살아남는다 (reserve 가 작동한다)',
        saturated.length > 0 && saturated.every(r => Number(r.viewTypes.entity || 0) > 0 && Number(r.viewTypes.lore || 0) > 0),
        { saturated: saturated.map(r => ({ mem: r.memN, lore: r.loreN, nodes: r.nodeCount, types: r.viewTypes })) });

    // N2 — 로어 폭증 시 보존 수가 reserve 상한에 걸린다
    //   상한 800 × loreReserve 12% = 96. 뷰 상한(36)과 구분해야 한다.
    const loreHeavy = rows.filter(r => r.loreN >= 100);
    assert('N2: [핵심] 로어를 크게 늘려도 보존 수가 reserve 상한(12%=96)을 넘지 않는다',
        loreHeavy.length > 0 && loreHeavy.every(r => Number(r.keptTypes?.lore || 0) <= 96),
        { heavy: loreHeavy.map(r => ({ loreIn: r.loreN, keptLore: r.keptTypes?.lore, viewLore: r.viewTypes.lore, graphNodes: r.viewStats?.nodeCount })) });

    // N3 — 보존 수와 화면 상한이 다르다 (의도된 절단).
    //   ⚠️ 처음엔 `viewLore < graphTotal(총 노드 수)` 로 판정했는데 **노드 수 비교라 우연히 참**이었다.
    //      같은 종류(lore)의 보존 수와 비교해야 의미가 있다.
    const capped = rows.find(r => r.loreN >= 100);
    const viewLore = Number(capped?.viewTypes.lore || 0);
    const keptLore = Number(capped?.viewStats?.nodeTypeCounts?.lore || 0);
    out.measurements.viewVsGraph = {
        viewLore, keptLore,
        note: '뷰(36)는 보존(96)보다 적게 담는다 — 화면 상한이 의도적으로 자른다'
    };
    assert('N3: [핵심] 화면 상한과 그래프 보존이 구분된다 (뷰 lore < 보존 lore, 같은 종류 비교)',
        keptLore > 0 && viewLore > 0 && viewLore < keptLore,
        out.measurements.viewVsGraph);

    // N4 — 포화 상태에서도 회상이 동작하고 비용이 감당 가능
    assert('N4: 포화 상태에서도 회상이 동작하고 비용이 감당 가능하다 (< 500ms)',
        saturated.length > 0 && saturated.every(r => r.graphOk === true && r.recalled === 8 && r.ms < 500),
        { saturated: saturated.map(r => ({ mem: r.memN, lore: r.loreN, ms: r.ms, recalled: r.recalled, ok: r.graphOk })) });

    // N5 — 상한 아래에서는 절단이 없다
    assert('N5: 상한 아래 규모에서는 절단이 없다 (작은 그래프는 그대로 담긴다)',
        underCap.length > 0 && underCap.every(r => r.nodeCount === r.memN + r.loreN + 4),
        { underCap: underCap.map(r => ({ mem: r.memN, lore: r.loreN, nodes: r.nodeCount, expect: r.memN + r.loreN + 4 })) });

    out.ok = out.assertions.every(a => a.ok);
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
})().catch(e => { console.log(JSON.stringify({ ok: false, fatal: String(e && e.stack || e) })); process.exit(1); });
