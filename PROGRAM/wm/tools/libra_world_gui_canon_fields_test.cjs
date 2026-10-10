'use strict';
// Gate: 세계관 화면이 **정본 필드**를 읽는다 (8단계 — 표시 계층 결함).
//
// 실측된 결함 (probe: libra_world_graph_gui_field_probe.cjs):
//   세계관 상세 화면이 정본에 **없는** 평면 필드를 읽고 있었다.
//     node.summary        → 정본은 node.meta.worldSummary
//     node.classification → 정본은 node.meta.classification
//     node.parentId       → 정본은 node.parent
//     node.fields         → 정본은 node.rules   (읽는 곳 0건 → 규칙 KPI 가 항상 0)
//     node.depth          → 정본에 없음 (depth 는 제품에 없는 축)
//     node.revision       → 정본에 없음 (revision 은 제품에 없는 축)
//
//   결과: 화면이 "요약이 아직 기록되지 않았습니다 / 0건 / —" 로 비어 있었다.
//   편집기는 정확히 node.rules / node.meta 를 쓴다 — 표시 계층만 어긋나 있었다.
//
// 이 게이트가 고정하는 계약:
//   D1 규칙 수를 정본(rules)에서 센다 — node.fields 를 읽지 않는다
//   D2 상세 화면이 meta.worldSummary / meta.classification 을 읽는다
//   D3 상위 노드를 parent 에서 읽는다 (parentId 아님)
//   D4 없는 축(depth·revision)을 표시하지 않는다 — 만들어내지 않는다
//   D5 상세 화면이 실제로 값을 만든다 (문자열 존재가 아니라 실행 결과)
//   D6 세계관 KPI 도 정본에서 규칙을 센다 (실행 결과가 0 이 아니다)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/parts/15b-gui-content-world-dlc.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src/parts/15-gui-and-exports.js'), 'utf8');
const dist = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── 실제 렌더 함수를 슬라이스해 실행한다 (문자열 검사가 아니라 실행) ──
const sliceFn = (name) => {
  const i = dist.indexOf('const ' + name + ' = ');
  if (i < 0) return null;
  const arrow = dist.indexOf('=>', i);
  let depth = 0, end = dist.indexOf('{', arrow);
  for (; end < dist.length; end++) {
    if (dist[end] === '{') depth++;
    else if (dist[end] === '}') { depth--; if (!depth) break; }
  }
  return dist.slice(i, end + 1) + ';';
};

const makeStub = () => {
  const nodes = {};
  const el = () => ({
    _v: '', _t: '', style: {}, classList: { toggle() {}, add() {}, remove() {} },
    set innerHTML(v) { this._v = String(v); }, get innerHTML() { return this._v || ''; },
    set textContent(v) { this._t = String(v); }, get textContent() { return this._t || ''; }
  });
  const overlay = { querySelector: (s) => { const id = String(s).replace(/^#/, ''); if (!nodes[id]) nodes[id] = el(); return nodes[id]; } };
  return { overlay, nodes };
};

// ── D1/D2/D3/D4: 소스 계약 (읽는 필드) ──
// 주석을 먼저 제거한다 — 주석이 옛 필드명을 설명으로 언급하는 것은 위반이 아니다.
const stripComments = (t) => String(t).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const detailBlock = stripComments((() => {
  const i = SRC.indexOf('const renderWorldDetail = (nodeId) => {');
  return i < 0 ? '' : SRC.slice(i, i + 4200);
})());
const kpiBlock = stripComments((() => {
  const i = SRC.indexOf('const syncWorldKpi = () => {');
  return i < 0 ? '' : SRC.slice(i, i + 2600);
})());
const cardBlock = stripComments((() => {
  const i = SRC.indexOf('const cards = _WLD.nodes.map');
  return i < 0 ? '' : SRC.slice(Math.max(0, i - 200), i + 2400);
})());

// 옛 평면 필드를 **읽는가** (node?.fields / node.summary / node.classification / node.parentId).
const READS_FLAT_FIELDS = /\b(?:n|node)\??\.(?:fields|summary|classification|parentId)\b/;
const flatReads = [
  ['detail', READS_FLAT_FIELDS.test(detailBlock)],
  ['kpi', READS_FLAT_FIELDS.test(kpiBlock)],
  ['card', READS_FLAT_FIELDS.test(cardBlock)]
].filter(([, v]) => v).map(([k]) => k);
assert('rules_counted_from_canon_not_fields', flatReads.length === 0,
  { flat_read_locations: flatReads, detail: detailBlock.length, kpi: kpiBlock.length, card: cardBlock.length });

// 정본 meta 의 축을 읽는가 (수신자 이름은 무엇이든 좋다 — wldMeta.worldSummary 등).
const readsSummary = /\bworldSummary\b/.test(detailBlock);
const readsClassification = /\bclassification\b/.test(detailBlock);
assert('detail_reads_meta_summary_and_classification', readsSummary && readsClassification,
  { summary: readsSummary, classification: readsClassification });

const readsParent = /node\?\.parent\b|node\.parent\b/.test(detailBlock);
const readsParentId = /node\?\.parentId\b|node\.parentId\b/.test(detailBlock);
assert('detail_reads_parent_not_parentId', readsParent && !readsParentId,
  { parent: readsParent, parentId: readsParentId });

const showsDepth = /node\?\.depth|node\.depth/.test(detailBlock) || /wld-detail-depth/.test(detailBlock);
const showsRevision = /node\?\.revision|node\.revision/.test(detailBlock) || /wld-detail-rev/.test(detailBlock);
assert('no_invented_axes_shown', !showsDepth && !showsRevision,
  { depth: showsDepth, revision: showsRevision, note: 'depth/revision 은 제품에 없는 축 — 라벨을 없앤다(값을 만들지 않는다)' });

// ── D5: 상세 화면이 실제로 값을 만든다 ──
const runDetail = () => {
  const src = sliceFn('renderWorldDetail');
  if (!src) return { __error: 'renderWorldDetail 없음' };
  const s = makeStub();
  // 정본 형태의 노드 (rules + meta) — 종전 픽스처(fields)가 아니라 실제 shape
  const _WLD = {
    rootId: 'world_main',
    activePath: ['world_main', 'n2'],
    nodes: [
      ['world_main', { id: 'world_main', name: '주요 세계', parent: null, rules: {}, meta: { worldSummary: '빛이 사라진 왕국', classification: 'dark-fantasy' } }],
      ['n2', { id: 'n2', name: '검은 탑', parent: 'world_main', layer: 'dimension',
        rules: { exists: { magic: true }, setting: { places: ['심연의 문', '검은 탑'] }, physics: { special_phenomena: ['빛이 사라진다'] }, custom: { rule_1: '마력은 저주받은 자만 쓴다' } },
        meta: { worldSummary: '빛이 사라진 탑', classification: 'dark-fantasy' } }]
    ]
  };
  const deps = {
    _WLD, esc: (x) => String(x ?? ''), switchTab: () => {}, recordSuppressedRuntimeError: () => {},
    // 실제 플러그인 스코프(01a)에 있는 함수다 — 게이트는 렌더 함수만 슬라이스해 실행하므로 주입한다.
    // 주입하지 않으면 ReferenceError 로 죽는다(그게 종전 게이트가 이 결함을 못 본 이유이기도 하다).
    extractWorldRuleHighlights: (rules, limit) => {
      const out = [];
      const s = rules?.setting || {};
      (Array.isArray(s.places) ? s.places : []).forEach(v => out.push(`장소/시설: ${v}`));
      if (rules?.exists?.magic) out.push('마법 존재');
      (rules?.physics?.special_phenomena || []).forEach(v => out.push(`현상: ${v}`));
      Object.values(rules?.custom || {}).forEach(v => out.push(String(v)));
      return out.slice(0, limit);
    },
    String, Object, Array, Number, JSON, Math
  };
  const keys = Object.keys(deps);
  try {
    const fn = new Function('overlay', ...keys, src + '; return renderWorldDetail;')(s.overlay, ...Object.values(deps));
    fn('n2');
    return s.nodes;
  } catch (e) { return { __error: String(e && e.message || e) }; }
};
const dNodes = runDetail();
const detailRead = dNodes?.['wld-detail-read']?.innerHTML || '';
const detailTags = dNodes?.['wld-detail-tags']?.innerHTML || '';
const detailSummary = dNodes?.['wld-detail-summary']?.textContent || '';
assert('detail_renders_canon_values',
  !dNodes?.__error
    && /빛이 사라진 탑/.test(detailSummary)
    && /규칙 [1-9]/.test(detailTags || '')
    && /마력은 저주받은 자만 쓴다/.test(detailRead)
    && /심연의 문|검은 탑/.test(detailRead)
    && /dark-fantasy/.test(detailRead + detailTags)
    && /주요 세계/.test(detailRead),   // 상위 노드가 **이름**으로 해석된다
  { error: dNodes?.__error, summary: detailSummary, tags: detailTags.slice(0, 160), read: detailRead.slice(0, 400) });

// ── D6: KPI 가 정본에서 규칙을 센다 (실행) ──
const runKpi = () => {
  const src = sliceFn('syncWorldKpi');
  if (!src) return { __error: 'syncWorldKpi 없음' };
  const s = makeStub();
  const _WLD = {
    rootId: 'world_main', activePath: ['world_main', 'n2'],
    nodes: [
      ['world_main', { name: '주요 세계', rules: { exists: { magic: true } }, meta: { classification: 'dark-fantasy' } }],
      ['n2', { name: '검은 탑', rules: { exists: { magic: true }, setting: { places: ['a', 'b'] }, custom: { rule_1: 'x' } }, meta: { classification: 'dark-fantasy' } }]
    ]
  };
  const deps = {
    _WLD, esc: (x) => String(x ?? ''), recordSuppressedRuntimeError: () => {}, Object, Array, Number, String, Map,
    extractWorldRuleHighlights: (rules, limit) => {
      const out = [];
      const st = rules?.setting || {};
      (Array.isArray(st.places) ? st.places : []).forEach(v => out.push(`장소/시설: ${v}`));
      if (rules?.exists?.magic) out.push('마법 존재');
      Object.values(rules?.custom || {}).forEach(v => out.push(String(v)));
      return out.slice(0, limit);
    }
  };
  const keys = Object.keys(deps);
  try {
    const fn = new Function('overlay', ...keys, src + '; return syncWorldKpi;')(s.overlay, ...Object.values(deps));
    fn();
    return s.nodes;
  } catch (e) { return { __error: String(e && e.message || e) }; }
};
const kNodes = runKpi();
const ruleText = kNodes?.['sum-wld-rules']?.innerHTML || '';
assert('world_kpi_counts_canon_rules',
  !kNodes?.__error && /[1-9]/.test(ruleText) && !/^0<small>/.test(ruleText),
  { error: kNodes?.__error, rules: ruleText, badge: kNodes?.['sum-wld-rules-badge']?.textContent, note: kNodes?.['sum-wld-rules-note']?.textContent });

// ── D4b: 마크업에서도 없는 축 라벨이 사라졌는가 ──
assert('markup_has_no_dead_axis_labels',
  !/wld-detail-depth/.test(MARKUP) && !/wld-detail-rev/.test(MARKUP),
  { depth_in_markup: /wld-detail-depth/.test(MARKUP), rev_in_markup: /wld-detail-rev/.test(MARKUP) });

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
