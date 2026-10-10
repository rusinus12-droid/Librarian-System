'use strict';
// Gate (B): 그래프가 **원거리 기억**을 실제로 회상에 넣는다 — 그리고 coldTier 이식이 불필요함을 고정한다.
//
// ■ 배경 (실측)
//   위그로어 `frontierColdReserveRatio` 는 "최근 unit 이 frontier 를 독점해 옛 기억이 propagate 진입
//   못 하는" 문제를 겨냥한다. 위그로어는 *전체 활성 unit*(수백~수천)에서 전파를 시작해 frontierCap
//   (maxFrontier 128 × speedMode) 으로 자른다.
//
//   LIBRA 는 구조가 다르다 — 실측으로 확인했다:
//     ① frontierPeak = 1  (시드별 BFS · 출발 1 · maxHops 2)
//        signal 엣지(shared_entity/turn_proximity)는 frontier 에 들어가지 않고 terminal 이다.
//        허브(entity)만 frontier 에 들어간다 — 즉 frontier 가 커질 수 없다.
//     ② 그런데 그래프는 **원거리 기억을 실제로 살린다**:
//        MEM_N=400 표본에서 ON=[...,t=1] vs OFF=[...,t=39] — 허브 경유가 가장 오래된 기억을 가져왔다.
//
//   → frontierCap + coldTier 는 LIBRA 에서 **겨냥할 포화가 없다.** 넣으면 ① 영구 비활성 코드이거나
//     ② 근거 없는 절단으로 회상 품질을 깎는다. 대신 **원거리 회수를 게이트로 고정**한다.
//
// ■ 판정
//   A1 그래프가 원거리(turn 이 작은) 기억을 회상에 넣는다 (그래프 off 에는 없는 것을 on 이 가져온다)
//   A2 frontier 가 포화되지 않는다 (frontierPeak 이 위그로어 임계 128 보다 훨씬 작다)
//   A3 그래프 off/on 비교에서 그래프가 회상을 **실제로 바꾼다**
//   A4 허브 경유(2홉)가 실제로 일어난다
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const out = { ok: false, assertions: [], measurements: {} };
const clone = (v) => JSON.parse(JSON.stringify(v));

const MEM_N = Number(process.env.GATE_B_MEM_N || 400);
const WHO = [['아리엘', '기사'], ['세라', '마법사'], ['카일', '정찰병'], ['미르', '연금술사']];

const buildLore = () => {
  const lore = [];
  // 표본 규칙 2가지 (둘 다 실측으로 얻었다):
  //   ① 옛 구간(15%)은 한 인물만 등장 → "옛 기억이 최근 것에 밀리는가" 를 재현 가능하게 만든다
  //   ② **문장을 서로 다르게** → 전부 같은 문장이면 다양성 게이트(redundancy 0.86)가 그래프 후보를
  //      전부 탈락시켜 "그래프가 회상을 못 바꾼다" 로 오진한다
  const TOPICS = [
    '지하 수로에서 적의 흔적을 찾았다', '탑 꼭대기에서 별자리를 관측했다', '폐광 입구를 봉인했다',
    '북부 성문에서 증표를 확인했다', '연금술 실험으로 촉매를 합성했다', '기사단 회의에서 임무를 배정받았다',
    '숲의 제단에서 서약을 갱신했다', '항구에서 밀수를 저지했다', '옛 지도에서 비밀 통로를 발견했다',
    '마법진의 균열을 봉합했다', '사절단과 통역 없이 교섭했다', '유적에서 봉인된 상자를 열었다'
  ];
  for (let i = 1; i <= MEM_N; i += 1) {
    const old = i <= Math.floor(MEM_N * 0.15);
    const w = old ? WHO[0][0] : WHO[i % WHO.length][0];
    lore.push({
      key: `m_${i}`, comment: 'lmai_memory',
      content: `[META:${JSON.stringify({ t: i, ttl: -1, imp: old ? 4 : 6, cat: 'personal', ent: [w] })}]\n` +
        `${w}은 ${TOPICS[i % TOPICS.length]}. (기록 ${i})\n`
    });
  }
  // 로어북 항목 — `03i` cue 색인이 lore 노드를 만드는 소스다.
  //   없으면 lore 노드가 0건이고, 그러면 "인물 ↔ 로어북 파이프라인" 의 로어 쪽이 검증되지 않는다.
  lore.push({
    key: 'lb_별핵', comment: 'lorebook',
    content: '별핵 파편은 아리엘과 세라가 함께 추적하는 유물이다. 북부 기사단이 감시한다.'
  });
  lore.push({
    key: 'lb_북부', comment: 'lorebook',
    content: '북부 기사단의 정찰 조직은 카일이 이끈다. 미르가 연금술 지원을 맡는다.'
  });
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

async function load(graphMode) {
  const chat = { id: 'gb', bindedPersona: 'default', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'gb-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
  const args = new Map(Object.entries({
    debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off',
    hme_graph_debug: 'full', hme_associative_graph: graphMode
  }));
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
    + '\n;globalThis.__GB__={MemoryEngine:typeof MemoryEngine!=="undefined"?MemoryEngine:null,MemoryState,getChatRuntimeScopeKey};\n'
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
  return { api: context.__GB__, char, chat };
}

const turnsOf = (recalled) => (recalled || []).map(e => {
  const m = /\[META:(\{.*?\})\]/s.exec(String(e?.content || ''));
  try { return m ? JSON.parse(m[1]).t : null; } catch (_) { return null; }
}).filter(v => v != null);

async function runWith(graphMode) {
  const { api, char, chat } = await load(graphMode);
  const ME = api.MemoryEngine;
  const lore = buildLore();
  const scopeKey = api.getChatRuntimeScopeKey(chat, char);
  api.MemoryState._activeScopeKey = scopeKey;
  ME.setTurn(MEM_N);
  try { ME.clearDerivedCaches?.(); } catch (_) {}
  ME.setLorebook(char, chat, lore);
  const entries = ME.getManagedEntries(lore);
  let recalled = [];
  try {
    recalled = await ME.retrieveMemories('아리엘 별핵 파편 공명 상태를 확인한다', MEM_N, entries, { scopeKey, recallFeedbackLorebook: lore }, 8);
  } catch (_) {}
  const dbg = ME.getLastRetrievalDebug() || {};
  const g = dbg.hmeAssociativeGraph || {};
  return {
    turns: turnsOf(recalled), graph: g,
    frontierPeak: Number(g.frontierPeak || 0),
    hubTraces: (g.hubTraces || []).length,
    // 허브 경유가 **2홉**인 것만 센다.
    //   ⚠️ 실측: chain 에 mentions_entity 가 있으면 담기므로 **1홉 도달(seed→허브)도 포함**된다.
    //      그걸로 판정하면 "허브가 쓰인다"가 1홉만으로 통과하고, 2홉을 죽이는 변이를 못 잡았다.
    //      chain 3세그먼트 = seed → 허브 → 다른 기억 이어야 실제 경유다.
    hub2Hop: (g.hubTraces || []).filter(t => (t.edgeChain || []).length >= 3).length,
    hubChainLens: (g.hubTraces || []).map(t => (t.edgeChain || []).length),
    added: Number(g.addedCandidates || 0),
    reason: g.reason || '', ok: g.ok,
    debugKeys: Object.keys(g)
  };
}

(async () => {
  const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });

  const on = await runWith('on');
  const off = await runWith('off');

  const offSet = new Set(off.turns);
  const onlyViaGraph = on.turns.filter(t => !offSet.has(t));
  const onSet = new Set(on.turns);
  const onlyViaBase = off.turns.filter(t => !onSet.has(t));
  const oldCut = Math.max(1, Math.floor(MEM_N * 0.15) - 1);

  out.measurements.memN = MEM_N;
  out.measurements.graphOnTurns = on.turns;
  out.measurements.graphOffTurns = off.turns;
  out.measurements.onlyViaGraph = onlyViaGraph;
  out.measurements.onlyViaBase = onlyViaBase;
  out.measurements.frontierPeak = on.frontierPeak;
  out.measurements.oldCut = oldCut;
  out.measurements.hubTraces = on.hubTraces;
  out.measurements.hub2Hop = on.hub2Hop;
  out.measurements.hubChainLens = on.hubChainLens;
  out.measurements.addedCandidates = on.added;
  out.measurements.graphReason = on.reason;
  out.measurements.edgeBudgetEvidence = { edgeCount:on.graph.edgeCount, relationCounts:on.graph.relationCounts, nodeTypeCounts:on.graph.nodeTypeCounts, mode:on.graph.mode };

  out.measurements.graphOnOk = on.ok;
  out.measurements.nodeTypes = (on.graph.nodeSample || []).reduce((m, n) => { const k = n.nodeType || '?'; m[k] = (m[k] || 0) + 1; return m; }, {});

  // 대조군 무결성: 그래프 off 는 실제로 그래프를 안 돌려야 한다
  assert('A0: 대조군이 유효하다 (그래프 off 는 그래프가 안 돈다)',
    off.ok !== true || off.added === 0,
    { offOk: off.ok, offReason: off.reason, offAdded: off.added });

  assert('A1: [핵심] 그래프가 **원거리** 기억을 회상에 넣는다 (off 에는 없던 것을 on 이 가져온다)',
    onlyViaGraph.some(t => t <= oldCut),
    { onlyViaGraph, oldCut, on: on.turns, off: off.turns });

  assert('A2: frontier 가 포화되지 않는다 (frontierPeak 이 위그로어 임계 128 보다 훨씬 작다)',
    on.frontierPeak > 0 && on.frontierPeak < 128,
    { frontierPeak: on.frontierPeak, whygoraeCap: 128, note: '시드별 BFS 라 frontier 가 커질 수 없다' });

  assert('A3: [핵심] 허브 경유 **2홉**이 실제로 일어난다 (seed → 허브 → 다른 기억)',
    on.hub2Hop > 0,
    { hub2Hop: on.hub2Hop, hubTraces: on.hubTraces, chainLens: on.hubChainLens });

  // A4: 그래프가 계산한 후보가 실제 회상에 도달하는가.
  //   ⚠️ 실측: MEM_N=400 에서 `addedCandidates 4` 인데도 graphOnly 항목이 최종 선택에서
  //      **다양성/중복 게이트에 막혀** 안 들어가는 경우가 있었다. 그건 결함인가 정상인가?
  //      → 그래프는 *후보를 늘리는* 계층이고 최종 선택은 점수·다양성 계층이다.
  //        그래프 후보가 항상 뽑혀야 한다면 그건 선택 계층을 침범하는 것이다.
  //        그래서 이 단언은 "회상이 실제로 달라진다" 까지만 요구한다(강도 조정).
  assert('A4: 그래프가 회상 결과를 실제로 바꾼다 (off 와 다른 집합)',
    on.ok === true && (onlyViaGraph.length > 0 || onlyViaBase.length > 0),
    { onlyViaGraph, onlyViaBase, on: on.turns, off: off.turns });

  // A5: 로어 노드가 그래프에 실제로 있다 (인물↔로어북 파이프라인의 로어 쪽)
  assert('A5: 로어북 항목이 lore 노드로 그래프에 들어간다',
    Number(out.measurements.nodeTypes.lore || 0) > 0,
    { nodeTypes: out.measurements.nodeTypes });

  out.ok = out.assertions.every(a => a.ok);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})();
