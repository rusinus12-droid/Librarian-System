'use strict';
// Gate (A1): GUI 시각화가 쓸 **제품 그래프 뷰 API** 가 실제로 동작하는가.
//
// 왜 필요한가:
//   A(시각화 제품 이식)의 전제는 "GUI 가 제품 그래프를 그린다" 이다. 그런데 실측에서
//   GUI 조각은 그래프 심볼을 **0건** 참조했고 공개 조회 API 도 없었다.
//   `MemoryEngine.getHmeGraphView(scopeKey)` 를 신설했으므로, 그것이 **실제 그래프를 돌려주는지**를
//   실행으로 확인한다 — 소스에 함수가 있다는 사실은 "그래프가 나온다"는 확인이 아니다.
//
// 판정:
//   V1 그래프가 캐시돼 있으면 뷰가 그 그래프를 돌려준다 (노드·엣지가 비어있지 않다)
//   V2 뷰가 **제품 그래프와 같은 노드**를 담는다 (임의 생성이 아니다)
//   V3 종류별 보장 — entity/lore 노드가 표본에서 밀려나지 않는다
//   V4 엣지의 양 끝점이 뷰 노드 안에 있다 (끝점 없는 엣지는 그릴 수 없다)
//   V5 그래프가 없으면 **만들지 않고 없다고 알린다** (GUI 렌더 중 구축 금지 — 렉 방지)
//   V6 뷰가 그래프를 변형하지 않는다 (읽기 전용)
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const out = { ok: false, assertions: [], measurements: {} };
const clone = (v) => JSON.parse(JSON.stringify(v));

const MEM_N = Number(process.env.GATE_A_MEM_N || 400);
const WHO = [['아리엘', '기사'], ['세라', '마법사'], ['카일', '정찰병'], ['미르', '연금술사']];
const TOPICS = [
  '지하 수로에서 적의 흔적을 찾았다', '탑 꼭대기에서 별자리를 관측했다', '폐광 입구를 봉인했다',
  '북부 성문에서 증표를 확인했다', '연금술 실험으로 촉매를 합성했다', '기사단 회의에서 임무를 배정받았다',
  '숲의 제단에서 서약을 갱신했다', '항구에서 밀수를 저지했다', '옛 지도에서 비밀 통로를 발견했다',
  '마법진의 균열을 봉합했다', '사절단과 통역 없이 교섭했다', '유적에서 봉인된 상자를 열었다'
];

const buildLore = () => {
  const lore = [];
  for (let i = 1; i <= MEM_N; i += 1) {
    const w = WHO[i % WHO.length][0];
    lore.push({
      key: `m_${i}`, comment: 'lmai_memory',
      content: `[META:${JSON.stringify({ t: i, ttl: -1, imp: 6, cat: 'personal', ent: [w] })}]\n` +
        `${w}은 ${TOPICS[i % TOPICS.length]}. (기록 ${i})\n`
    });
  }
  lore.push({ key: 'lb_별핵', comment: 'lorebook', content: '별핵 파편은 아리엘과 세라가 함께 추적하는 유물이다. 북부 기사단이 감시한다.' });
  lore.push({ key: 'lb_북부', comment: 'lorebook', content: '북부 기사단의 정찰 조직은 카일이 이끈다. 미르가 연금술 지원을 맡는다.' });
  for (const [n, r] of WHO) lore.push({
    key: `lmai_entity::${n}`, comment: 'lmai_entity',
    content: JSON.stringify({
      name: n, type: 'character',
      identity: { aliases: [], summary: `${n} 요약`, roleInStory: r, affiliation: '북부 기사단' },
      meta: { created: 1, aliases: [], hiddenNameKeys: [] }
    })
  });
  return lore;
};

async function load() {
  const chat = { id: 'ga', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'ga-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
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
    + '\n;globalThis.__GA__={MemoryEngine:typeof MemoryEngine!=="undefined"?MemoryEngine:null,MemoryState,getChatRuntimeScopeKey:typeof getChatRuntimeScopeKey!=="undefined"?getChatRuntimeScopeKey:null};\n'
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
  return { api: context.__GA__, char, chat };
}

(async () => {
  const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });
  const { api, char, chat } = await load();
  const ME = api.MemoryEngine;
    const scopeKey = api.getChatRuntimeScopeKey(chat,char);
    api.MemoryState._activeScopeKey = scopeKey;
  if (!ME) { out.reason = 'MemoryEngine_missing'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }

  // V5 를 먼저 — 그래프가 아직 없을 때
  let viewBefore = null;
  try { viewBefore = ME.getHmeGraphView(scopeKey); } catch (e) { viewBefore = { thrown: String(e.message) }; }

  // 그래프를 만든다 (정상 회상 경로)
  const lore = buildLore();
  ME.setTurn(MEM_N);
  ME.setLorebook(char, chat, lore);
  const entries = ME.getManagedEntries(lore);
  await ME.retrieveMemories('아리엘 별핵 파편 공명 상태를 확인한다', MEM_N, entries, { scopeKey: scopeKey }, 8);
  const dbg = (ME.getLastRetrievalDebug() || {}).hmeAssociativeGraph || {};
  out.measurements.graphDebug = {
    ok: dbg.ok, reason: dbg.reason, nodeCount: dbg.nodeCount, edgeCount: dbg.edgeCount,
    nodeTypes: (dbg.nodeSample || []).reduce((m, n) => { const k = n.nodeType || '?'; m[k] = (m[k] || 0) + 1; return m; }, {})
  };

  const view = ME.getHmeGraphView(scopeKey);
  out.measurements.view = {
    ok: view?.ok, reason: view?.reason, scopeKey: view?.scopeKey,
    nodes: (view?.nodes || []).length, edges: (view?.edges || []).length,
    types: (view?.nodes || []).reduce((m, n) => { const k = n.nodeType || '?'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    stats: view?.stats
  };

  // V1
  assert('V1: 그래프가 캐시돼 있으면 뷰가 노드·엣지를 돌려준다',
    view?.ok === true && (view.nodes || []).length > 0 && (view.edges || []).length > 0,
    { ok: view?.ok, nodes: (view?.nodes || []).length, edges: (view?.edges || []).length, reason: view?.reason });

  // V2 — 뷰 노드가 제품 그래프 노드와 같은 id 인가 (임의 생성이 아님)
  const graphNodeIds = new Set((dbg.nodeSample || []).map(n => n.id));
  const viewNodeIds = (view?.nodes || []).map(n => n.id);
  const allFromGraph = viewNodeIds.length > 0 && viewNodeIds.every(id => graphNodeIds.has(id));
  out.measurements.idOverlap = {
    graphSample: graphNodeIds.size, viewNodes: viewNodeIds.length,
    fromGraph: viewNodeIds.filter(id => graphNodeIds.has(id)).length
  };
  assert('V2: [핵심] 뷰의 노드가 **제품 그래프의 노드**다 (임의 생성이 아니다)',
    allFromGraph, out.measurements.idOverlap);

  // V3 — 종류별 보장
  const types = out.measurements.view.types;
  assert('V3: 종류별 보장 — entity 와 lore 가 표본에서 밀려나지 않는다',
    Number(types.entity || 0) > 0 && Number(types.lore || 0) > 0,
    { types });

  // V4 — 엣지 끝점
  const ids = new Set(viewNodeIds);
  const orphan = (view?.edges || []).filter(e => !ids.has(e.from) || !ids.has(e.to));
  out.measurements.orphanEdges = orphan.length;
  assert('V4: 엣지의 양 끝점이 뷰 노드 안에 있다 (끝점 없는 엣지 0)',
    orphan.length === 0, { orphan: orphan.length, edges: (view?.edges || []).length });

  // V5 — 그래프 없을 때 만들지 않는다
  assert('V5: [핵심] 그래프가 없으면 만들지 않고 없다고 알린다 (GUI 렌더 중 구축 금지)',
    viewBefore && viewBefore.ok === false && viewBefore.reason === 'no_graph_cached'
      && Array.isArray(viewBefore.nodes) && viewBefore.nodes.length === 0,
    { viewBefore });

  // V6 — 읽기 전용. `getHmeGraphIndexStats` 는 MemoryEngine 밖(10d)이라 쓸 수 없다(실측).
  //   대신 뷰를 두 번 불러 **결과가 동일**한지 본다 — 조회가 그래프나 뷰 상태를 바꾸면 달라진다.
  const v1 = ME.getHmeGraphView(scopeKey);
  const v2 = ME.getHmeGraphView(scopeKey);
  const sig = (v) => JSON.stringify({
    n: (v?.nodes || []).map(x => x.id).sort(),
    e: (v?.edges || []).map(x => x.from + '>' + x.to + ':' + x.relation).sort(),
    stats: v?.stats
  });
  assert('V6: 뷰 조회가 멱등하다 (읽기 전용 — 두 번 불러도 같다)',
    v1?.ok === true && sig(v1) === sig(v2),
    { same: sig(v1) === sig(v2), nodes: (v1?.nodes || []).length });

  out.ok = out.assertions.every(a => a.ok);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})();
