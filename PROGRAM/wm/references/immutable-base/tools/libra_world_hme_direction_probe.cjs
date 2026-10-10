'use strict';
// 실측: HME 는 이미 세계를 알고 있는데, 세계 쪽이 HME 를 모른다 — 그 비대칭을 확인한다.
//
// 발견: 10c:967 에 관계 타입 `world_rule_reinforces` / `world_rule_contradicts` 가 이미 있다.
//   세계 규칙과 일치/모순되는 기억 사이에 엣지가 만들어진다.
//   즉 HME 는 세계를 **판정 축으로 이미 쓴다**.
//
// 확인할 것:
//   ① HME 가 세계를 쓰는 자리 전수 (worldScore, worldSignature, worldRuleHighlights, worldChanges)
//   ② 세계(08a)가 HME 를 쓰는 자리가 있는가 (역방향)
//   ③ 그래서 "조화"가 새 배선인지, 기존 배선의 정리인지
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const out = {};

// ── ① HME 가 세계를 쓰는 자리 (10c) ──
const hme = read('src/parts/10c-hme-associative-graph.js');
const hmeWorldRefs = [];
hme.split('\n').forEach((line, i) => {
  if (/world/i.test(line) && !/^\/\//.test(line.trim())) {
    const m = line.match(/(world[A-Za-z]*|world_rule_[a-z]+|sharedWorld[A-Za-z]*)/);
    if (m) hmeWorldRefs.push({ line: i + 1, token: m[1], code: line.trim().slice(0, 110) });
  }
});
const byToken = {};
for (const r of hmeWorldRefs) byToken[r.token] = (byToken[r.token] || 0) + 1;
out.hme_uses_world = {
  total_refs: hmeWorldRefs.length,
  tokens: byToken,
  world_rule_edges: hmeWorldRefs.filter(r => /world_rule_/.test(r.token)).map(r => ({ line: r.line, code: r.code })),
  sample: hmeWorldRefs.slice(0, 12)
};

// ── ② 세계(08a)가 HME 를 쓰는 자리 (역방향) ──
const world = read('src/parts/08a-world-graph.js');
const worldHmeRefs = [];
world.split('\n').forEach((line, i) => {
  if (/hme|HME|associative|graph_index/i.test(line)) worldHmeRefs.push({ line: i + 1, code: line.trim().slice(0, 110) });
});
out.world_uses_hme = {
  total_refs: worldHmeRefs.length,
  refs: worldHmeRefs,
  verdict: worldHmeRefs.length === 0 ? '세계는 HME 를 전혀 모른다 — 단방향' : '부분 참조 있음'
};

// ── ③ 다른 파트에서 두 쪽을 함께 아는 자리 ──
const parts = fs.readdirSync(path.join(ROOT, 'src/parts'));
const both = [];
for (const f of parts) {
  const s = read(`src/parts/${f}`);
  const hasWorldMgr = /HierarchicalWorldManager/.test(s);
  const hasHmeGraph = /hmeGraph|HmeGraph|associativeGraph/i.test(s);
  if (hasWorldMgr && hasHmeGraph) both.push(f);
}
out.parts_knowing_both = {
  files: both,
  count: both.length,
  note: '두 쪽을 함께 아는 파트 — 조화의 접점 후보'
};

// ── ④ 세계 규칙 필드가 HME memory 노드로 들어가는 경로 ──
const bridge = [];
hme.split('\n').forEach((line, i) => {
  if (/worldRuleHighlights|worldSignature|worldChanges/.test(line) && /row\.|payload|meta|continuity/.test(line)) {
    bridge.push({ line: i + 1, code: line.trim().slice(0, 120) });
  }
});
out.memory_node_world_fields_bridge = {
  refs: bridge.slice(0, 10),
  count: bridge.length
};

// ── ⑤ 판정 ──
out.verdict = {
  direction: 'HME → 세계 는 이미 있다 (world_rule_reinforces/contradicts 엣지). 세계 → HME 는 0곳.',
  implication: '조화는 "새 배선"이 아니라 "기존 단방향을 정리하는 일"이다. HME 가 읽는 세계 값을 정본에서 직접 읽게 하면 된다.',
  why_id_fix_mattered: 'HME 가 세계 노드를 가리키려면 ID 가 결정적이어야 한다 — 이번 수정(node_<hash>)이 그 전제다. 수정 전엔 Date.now() 라 재구축마다 ID 가 바뀌어 가리킬 수 없었다.'
};

console.log(JSON.stringify(out, null, 2));
