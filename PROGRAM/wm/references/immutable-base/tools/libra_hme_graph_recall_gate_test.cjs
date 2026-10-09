'use strict';
// Gate: HME 그래프 회상이 *자기 게이트에 스스로 걸리는* 구조 결함 + 전파 2홉.
//
// ■ 실측 결함 (C 프로브에서 발견)
//   `10i` 는 그래프를 돌리기 전에 `hmeGraphMinRecallCandidates(24)` 게이트를 본다:
//       if (minGraphRecallCandidates > 0 && filtered.length < minGraphRecallCandidates) → candidate_gate
//   그런데 **그 직전 줄에서** `10f hybridReadPathShortlist` 가 topK 로 이미 잘라낸다:
//       filtered = hybridResult.entries || filtered;                 ← 여기서 topK(8) 로 축소
//       ... 게이트: filtered.length(8) < 24 → 항상 막힘
//   실측: 기억 6·12·20·23·24·30·60건 전부 `reason: 'candidate_gate', candidateCount: 8`.
//   60건을 넣어도 8 이다 — **규모를 늘려도 게이트를 영영 못 넘는다.**
//   즉 그래프 회상은 사실상 죽은 코드였다 (HME on/off 결과가 동일했던 이유).
//
// ■ 판정
//   게이트는 "HME 좁힘 이후"가 아니라 **"좁히기 이전 후보풀"** 을 봐야 한다.
//   좁힘 전 풀이 그래프가 확장할 수 있는 대상이기 때문이다.
//
// 이 게이트는 제품 `retrieveMemories` 를 돌려 debug 의 `hmeAssociativeGraph` 를 판정한다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const out = { ok: false, assertions: [], measurements: {} };

const clone = (v) => JSON.parse(JSON.stringify(v));
const memoryEntry = (turn, text) => ({
  key: `m_${turn}`, comment: 'lmai_memory',
  content: `[META:${JSON.stringify({ t: turn, ttl: -1, imp: 6, cat: 'personal', ent: ['아리엘'] })}]\n${text}\n`
});
const entityEntry = (name) => ({
  key: `lmai_entity::${name}`, comment: 'lmai_entity',
  content: JSON.stringify({
    name, type: 'character',
    identity: { aliases: [], summary: `${name} 요약`, roleInStory: '기사', affiliation: '북부 기사단' },
    meta: { created: 1, aliases: [], hiddenNameKeys: [] }
  })
});
// 아리엘(허브) — 별핵 파편(허브 경유 대상) — 무관 기억을 분리해 둔다.
const buildLore = (memoryCount) => {
  const lore = [];
  // 두 인물이 각각 다른 기억에 등장 — 허브 경유(seed 기억 → 인물 → 다른 기억)가
  //   실제로 일어나야 검증이 성립한다. 한 인물만 있으면 직접 엣지로도 도달한다.
  const WHO = ['아리엘', '세라', '카일'];
  for (let i = 1; i <= memoryCount; i += 1) {
    const who = WHO[i % WHO.length];
    lore.push(memoryEntry(i, `${who}은 별핵 파편 ${i} 의 공명을 확인했다.`));
  }
  for (const n of WHO) lore.push(entityEntry(n));
  return lore;
};

async function load() {
  const chat = { id: 'gate2', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'gate2-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
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
    + '\n;globalThis.__G2__={MemoryEngine:typeof MemoryEngine!=="undefined"?MemoryEngine:null};\n'
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
  return { api: context.__G2__, char, chat };
}

(async () => {
  const { api, char, chat } = await load();
  const ME = api.MemoryEngine;
  if (!ME) { out.reason = 'MemoryEngine_missing'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
  const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });

  const runAt = async (memoryCount) => {
    const lore = buildLore(memoryCount);
    ME.setTurn(Math.max(memoryCount, 10));
    try { ME.clearDerivedCaches?.(); } catch (_) {}
    ME.setLorebook(char, chat, lore);
    const entries = ME.getManagedEntries(lore);
    let recalled = [];
    try {
      recalled = await ME.retrieveMemories('아리엘 별핵 파편 공명 상태를 확인한다', Math.max(memoryCount, 10), entries, { scopeKey: `g2-${memoryCount}` }, 8);
    } catch (_) {}
    const dbg = ME.getLastRetrievalDebug() || {};
    const g = dbg.hmeAssociativeGraph || null;
    return {
      memoryCount,
      managed: Array.isArray(entries) ? entries.length : 0,
      recalled: Array.isArray(recalled) ? recalled.length : 0,
      graph: g ? {
        enabled: g.enabled, ok: g.ok, reason: g.reason || '', mode: g.mode || '',
        nodeCount: g.nodeCount || 0, edgeCount: g.edgeCount || 0,
        seedCount: g.seedCount || 0, candidateCount: g.candidateCount || 0,
        addedCandidates: g.addedCandidates || 0
      } : null,
      traces: (g?.traces || []).slice(0, 12).map(t => ({
        reason: t.reason,
        hop: (t.edgeChain || []).length,
        boost: t.boost,
        rel: t.relation,
        chain: t.edgeChain || [],
        // 허브 경유 판정: chain 어딘가에 mentions_entity(E1) 가 있으면 인물을 거쳐 왔다.
        viaHub: (t.edgeChain || []).some(seg => String(seg).includes('mentions_entity'))
      }))
    };
  };

  const SCALES = [8, 23, 24, 40];
  const rows = [];
  for (const n of SCALES) rows.push(await runAt(n));
  out.measurements.rows = rows;

  const gated = rows.filter(r => r.graph && r.graph.reason === 'candidate_gate');
  const ran = rows.filter(r => r.graph && r.graph.ok === true);
  out.measurements.gatedScales = gated.map(r => r.memoryCount);
  out.measurements.ranScales = ran.map(r => r.memoryCount);
  out.measurements.nodeCounts = rows.map(r => ({ n: r.memoryCount, nodes: r.graph?.nodeCount || 0, edges: r.graph?.edgeCount || 0 }));
  out.measurements.maxAdded = rows.reduce((m, r) => Math.max(m, Number(r.graph?.addedCandidates || 0)), 0);
  out.measurements.maxTraceHops = rows.reduce((m, r) => Math.max(m, ...(r.traces || []).map(t => t.hop || 0), 0), 0);

  // ── 판정 ───────────────────────────────────────────────────────────────
  assert('G1: 인물 노드가 그래프에 있다 (노드 수 > 기억 수)',
    out.measurements.nodeCounts.some(v => v.nodes > v.n),
    { counts: out.measurements.nodeCounts });

  // 게이트 통과 판정: `candidate_gate` 가 아니고 그래프가 실제로 노드를 만들었는가.
  //   (`ok` 필드는 expand 경로 debug 에 이제 있다 — 그래도 노드 수가 더 확실한 증거다.)
  const actuallyRan = rows.filter(r => r.graph && r.graph.reason !== 'candidate_gate' && Number(r.graph.nodeCount) > 0);
  out.measurements.actuallyRanScales = actuallyRan.map(r => r.memoryCount);
  assert('G2: [핵심] 규모가 임계 이상이면 그래프가 candidate_gate 로 막히지 않는다',
    actuallyRan.length > 0
      && rows.filter(r => r.memoryCount >= 24).every(r => r.graph && r.graph.reason !== 'candidate_gate')
      && rows.filter(r => r.memoryCount < 24).every(r => r.graph && r.graph.reason === 'candidate_gate'),
    { ran: out.measurements.actuallyRanScales, gated: out.measurements.gatedScales, rows: rows.map(r => ({ n: r.memoryCount, reason: r.graph?.reason, nodes: r.graph?.nodeCount })) });

  assert('G3: 그래프가 회상 후보를 실제로 추가한다 (addedCandidates > 0)',
    out.measurements.maxAdded > 0,
    { maxAdded: out.measurements.maxAdded, added: rows.map(r => ({ n: r.memoryCount, added: r.graph?.addedCandidates })) });

  // 허브 경유 판정: trace 의 relation 이 `mentions_entity`(E1) 이고 2홉인 것.
  //   shared_entity/turn_proximity 는 기억-기억 직접 엣지라 허브 경유가 아니다.
  const hubTraces = rows.flatMap(r => (r.traces || []).map(t => ({ n: r.memoryCount, ...t })))
    .filter(t => t.viaHub === true);
  out.measurements.hubRoutedTraces = hubTraces.slice(0, 6);
  out.measurements.hubRoutedCount = hubTraces.length;
  const relsSeen = Array.from(new Set(rows.flatMap(r => (r.traces || []).map(t => t.rel))));
  out.measurements.relationsSeen = relsSeen;
  assert('G4: [핵심] 인물 허브를 경유한 전파가 일어난다 (chain 에 E1 mentions_entity)',
    out.measurements.hubRoutedCount > 0,
    { hubRouted: out.measurements.hubRoutedCount, relationsSeen: relsSeen, sample: out.measurements.hubRoutedTraces });

  out.ok = out.assertions.every(a => a.ok);
  console.log(JSON.stringify(out, null, 2));
})();
