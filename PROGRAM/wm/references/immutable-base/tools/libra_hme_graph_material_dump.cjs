'use strict';
// 목업 재료 덤프: 실제 HME 그래프의 노드 종류·엣지 관계·전파 경로를 그대로 뽑는다.
// 발명 금지 — 목업이 그리는 노드/엣지/경로는 이 출력에서만 온다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const clone = (v) => JSON.parse(JSON.stringify(v));

const memoryEntry = (turn, who, text) => ({
  key: `m_${turn}`, comment: 'lmai_memory',
  content: `[META:${JSON.stringify({ t: turn, ttl: -1, imp: 6, cat: 'personal', ent: [who] })}]\n${text}\n`
});
const entityEntry = (name, role) => ({
  key: `lmai_entity::${name}`, comment: 'lmai_entity',
  content: JSON.stringify({
    name, type: 'character',
    identity: { aliases: [], summary: `${name} 요약`, roleInStory: role, affiliation: '북부 기사단' },
    meta: { created: 1, aliases: [], hiddenNameKeys: [] }
  })
});

// 실사용에 가까운 표본: 인물 4명 + 로어 2건 + 기억 40건.
//   한 인물(아리엘)은 여러 기억에 등장 → 허브. 다른 인물은 소수 → 잎.
const WHO = [
  ['아리엘', '기사'], ['세라', '마법사'], ['카일', '정찰병'], ['미르', '연금술사']
];
const MEM_N = Number(process.env.MEM_N || 40);
const buildLore = () => {
  const lore = [];
  for (let i = 1; i <= MEM_N; i += 1) {
    const w = WHO[i % WHO.length][0];
    lore.push(memoryEntry(i, w, `${w}은 별핵 파편 ${i} 의 공명을 확인했다.`));
  }
  for (const [n, r] of WHO) lore.push(entityEntry(n, r));
  // 로어북 항목 — character_lore_cues 가 인물↔로어 연결을 만든다
  lore.push({ key: 'lb_별핵', comment: 'lorebook', content: '별핵 파편은 아리엘과 세라가 함께 추적하는 유물이다.' });
  lore.push({ key: 'lb_북부', comment: 'lorebook', content: '북부 기사단은 카일이 속한 정찰 조직이다.' });
  return lore;
};

async function load() {
  const chat = { id: 'mat', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'mat-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
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
  if (!ME) { console.log(JSON.stringify({ reason: 'MemoryEngine_missing' })); process.exit(1); }
  const lore = buildLore();
  ME.setTurn(MEM_N);
  try { ME.clearDerivedCaches?.(); } catch (_) {}
  ME.setLorebook(char, chat, lore);
  const entries = ME.getManagedEntries(lore);
  let recalled = [];
  try {
    recalled = await ME.retrieveMemories('아리엘 별핵 파편 공명 상태를 확인한다', MEM_N, entries, { scopeKey: 'mat' }, 8);
  } catch (e) { console.log('retrieve err', e.message); }
  const dbg = ME.getLastRetrievalDebug() || {};
  const g = dbg.hmeAssociativeGraph || {};
  const out = {
    graph: {
      ok: g.ok, reason: g.reason, mode: g.mode,
      nodeCount: g.nodeCount, edgeCount: g.edgeCount,
      relationCounts: g.relationCounts, layerCounts: g.layerCounts,
      seedCount: g.seedCount, candidateCount: g.candidateCount, addedCandidates: g.addedCandidates,
      directFocusNames: g.directFocusNames, relatedFocusNames: g.relatedFocusNames
    },
    nodesByType: (g.nodeSample || []).reduce((m, n) => { m[n.nodeType || '?'] = (m[n.nodeType || '?'] || 0) + 1; return m; }, {}),
    nodesByKind: (g.nodeSample || []).reduce((m, n) => { m[n.kind] = (m[n.kind] || 0) + 1; return m; }, {}),
    edgesByRelation: (g.edgeSample || []).reduce((m, e) => { m[e.relation] = (m[e.relation] || 0) + 1; return m; }, {}),
    nodeSample: (g.nodeSample || []),
    edgeSample: (g.edgeSample || []),
    traces: (g.traces || []).slice(0, 10).map(t => ({
      reason: t.reason, relation: t.relation, boost: t.boost,
      chain: t.edgeChain || [],
      viaHub: (t.edgeChain || []).some(s => String(s).includes('mentions_entity'))
    })),
    recalled: (recalled || []).length,
    hubTraces: (g.hubTraces || []).map(t => ({ reason: t.reason, chain: t.edgeChain || [] }))
  };
  fs.writeFileSync(path.join(ROOT, 'ux-prototype', `hme-graph-real-data-${MEM_N}.json`), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({
    saved: 'ux-prototype/hme-graph-real-data.json',
    nodesByType: out.nodesByType, nodesByKind: out.nodesByKind,
    edgesByRelation: out.edgesByRelation,
    graph: out.graph,
    recalled: out.recalled,
    traceCount: out.traces.length,
    hubTraces: out.traces.filter(t => t.viaHub).length,
    sampleTrace: out.traces[0] || null
  }, null, 1));
})();
