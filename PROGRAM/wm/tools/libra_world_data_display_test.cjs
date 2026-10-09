'use strict';
// Gate: 9단계 — 이미 있는 데이터를 화면에 연결한다.
//
// ★ 정정: 8단계에서 나는 "세계관 필드 23개 중 6개만 배선"이라고 보고했다. **틀렸다.**
//   재측정 결과 마크업 world-* 36개가 **전부** 배선돼 있다(편집기 `renderWorldFields` 읽기 +
//   저장 모두 `node.rules`/`node.meta` 정본을 쓴다). `world-system-*` 6개는 템플릿 동적
//   배선(`#world-system-${key}`)이라 나의 단일 인용 grep 이 놓쳤다.
//
// 실제로 빠져 있던 것은 **마크업 배선이 아니라 새 데이터의 표시**다:
//   ① 2단계 `profile.activeNodes`(멀티노드)가 화면에 **전혀** 안 나온다.
//      `_WLD` 스냅샷에 아예 없고, GUI 는 노드를 "활성"으로 판정할 때 `activePath` 만 본다
//      → 멀티노드로 활성화된 위치가 **"이력"으로 잘못 표시**된다.
//   ② 4단계 소속 세계가 인물 화면에 안 나온다.
//      인물 상세의 `소속` 행은 `identity.affiliation`(조직 소속)이라 세계와 다른 축이다.
//
// 이 게이트가 고정하는 계약:
//   S1 `_WLD` 스냅샷이 activeNodes 를 담는다 (15a)
//   S2 노드 카드가 activeNodes 를 활성으로 표시한다 (실행)
//   S3 상세 배지가 activeNodes 를 활성으로 표시한다 (실행)
//   S4 세계관 KPI 가 활성 위치를 정확히 센다 (실행)
//   S5 인물 화면이 소속 세계를 낸다 (실행 — 4단계 데이터)
//   S6 activeNodes 가 비면 종전과 완전히 동일하다 (하위 호환)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC15A = fs.readFileSync(path.join(ROOT, 'src/parts/15a-gui-session-data.js'), 'utf8');
const SRC15B = fs.readFileSync(path.join(ROOT, 'src/parts/15b-gui-content-world-dlc.js'), 'utf8');
const dist = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

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

// ── S1: 스냅샷에 activeNodes (15a 소스 계약) ──
// 주의: 같은 취지의 줄이 **두 곳**(초기 선언 + 동기화 함수)에 있다. 첫 번째만 보면
//   동기화 경로를 놓친다 — 런타임에 스냅샷을 다시 채우는 쪽이 정본이다.
// 두 경로를 **이름으로 정확히** 잡는다(윈도 슬라이스는 이웃 줄까지 삼켜 오판한다).
const initBlock = SRC15A.slice(SRC15A.indexOf('let _WLD = {'), SRC15A.indexOf('let _WLD = {') + 220);
const syncFnStart = SRC15A.indexOf('const syncWorldSnapshotFromRuntime = () => {');
const syncBlock = syncFnStart < 0 ? '' : SRC15A.slice(syncFnStart, syncFnStart + 900);
assert('snapshot_carries_active_nodes',
  /let _WLD = \{[^}]*activeNodes/.test(initBlock)          // 초기 선언
    && /activeNodes:\s*Array\.isArray\(profile\.activeNodes\)/.test(syncBlock),   // 런타임 동기화(정본)
  { init_has_active_nodes: /activeNodes/.test(initBlock),
    sync_has_active_nodes: /activeNodes:\s*Array\.isArray\(profile\.activeNodes\)/.test(syncBlock),
    sync_found: syncFnStart >= 0 });

// ── S2·S4: 노드 카드·KPI 가 activeNodes 를 활성으로 본다 (실행) ──
const _WLD_MULTI = {
  rootId: 'root',
  activePath: ['root'],                // 주 초점은 루트 (1곳)
  activeNodes: ['n1', 'n2'],           // n1·n2 가 활성 (멀티노드) — activePath 만 보면 1곳으로 잘못 센다
  nodes: [
    ['root', { id: 'root', name: '주요 세계', parent: null, rules: {}, meta: {} }],
    ['n1', { id: 'n1', name: '검은 탑', parent: 'root', rules: { exists: { magic: true } }, meta: { classification: 'dark' } }],
    ['n2', { id: 'n2', name: '북부 변경', parent: 'root', rules: { physics: { special_phenomena: ['혹한'] } }, meta: { classification: 'dark' } }]
  ]
};

const runKpi = (wld) => {
  const src = sliceFn('syncWorldKpi');
  if (!src) return { __error: 'syncWorldKpi 없음' };
  const s = makeStub();
  const deps = {
    _WLD: wld, esc: (x) => String(x ?? ''), recordSuppressedRuntimeError: () => {},
    extractWorldRuleHighlights: (rules) => {
      const out = [];
      const st = rules?.setting || {};
      (Array.isArray(st.places) ? st.places : []).forEach(v => out.push(`장소/시설: ${v}`));
      if (rules?.exists?.magic) out.push('마법 존재');
      (rules?.physics?.special_phenomena || []).forEach(v => out.push(`현상: ${v}`));
      Object.values(rules?.custom || {}).forEach(v => out.push(String(v)));
      return out;
    },
    Object, Array, Number, String, Map
  };
  const keys = Object.keys(deps);
  try {
    const fn = new Function('overlay', ...keys, src + '; return syncWorldKpi;')(s.overlay, ...Object.values(deps));
    fn();
    return s.nodes;
  } catch (e) { return { __error: String(e && e.message || e) }; }
};

const kNodes = runKpi(_WLD_MULTI);
const badge = kNodes?.['sum-wld-badge']?.textContent || '';
assert('kpi_counts_active_locations_from_active_nodes',
  !kNodes?.__error && /활성 2/.test(badge),
  { error: kNodes?.__error, badge, note: 'activePath 는 1곳이지만 activeNodes 가 2곳 → 활성 2 여야 한다' });

// ── S3: 상세 배지가 activeNodes 를 활성으로 표시한다 (실행) ──
const runDetail = (wld, nodeId) => {
  const src = sliceFn('renderWorldDetail');
  if (!src) return { __error: 'renderWorldDetail 없음' };
  const s = makeStub();
  const deps = {
    _WLD: wld, esc: (x) => String(x ?? ''), switchTab: () => {}, recordSuppressedRuntimeError: () => {},
    extractWorldRuleHighlights: (rules) => {
      const out = [];
      const st = rules?.setting || {};
      (Array.isArray(st.places) ? st.places : []).forEach(v => out.push(`장소/시설: ${v}`));
      if (rules?.exists?.magic) out.push('마법 존재');
      (rules?.physics?.special_phenomena || []).forEach(v => out.push(`현상: ${v}`));
      Object.values(rules?.custom || {}).forEach(v => out.push(String(v)));
      return out;
    },
    String, Object, Array, Number, JSON, Math
  };
  const keys = Object.keys(deps);
  try {
    const fn = new Function('overlay', ...keys, src + '; return renderWorldDetail;')(s.overlay, ...Object.values(deps));
    fn(nodeId);
    return s.nodes;
  } catch (e) { return { __error: String(e && e.message || e) }; }
};

// n2 는 activePath 에 없지만 activeNodes 에 있다 → 활성으로 보여야 한다.
const dNodes = runDetail(_WLD_MULTI, 'n2');
const detailBadge = dNodes?.['wld-detail-badge']?.textContent || '';
assert('detail_badge_uses_active_nodes',
  !dNodes?.__error && /활성/.test(detailBadge),
  { error: dNodes?.__error, badge: detailBadge, note: 'activePath 에 없어도 activeNodes 에 있으면 활성' });

// ── S4: 노드 카드(트리)가 activeNodes 를 활성으로 표시한다 (실행) ──
//   실측: 배선 검사만으로는 "트리가 activePath 만 보는" 변이(M4)를 못 잡았다.
const runTree = (wld, nodeId) => {
  const src = sliceFn('rn');
  if (!src || !/rn/.test(src)) return { __error: 'rn 없음' };
  const ap = Array.isArray(wld.activePath) ? wld.activePath.map(String) : [];
  const worldSrc = (() => { const i = dist.indexOf('const renderWorld = '); return i < 0 ? '' : dist.slice(i, i + 3200); })();
  const usesActiveNodes = /apActive/.test(worldSrc) && /_WLD\.activeNodes/.test(worldSrc);
  const apActive = usesActiveNodes && Array.isArray(wld.activeNodes) && wld.activeNodes.length > 0
    ? wld.activeNodes.map(String) : ap;
  try {
    const fn = new Function('ap', 'apActive', '_WLD', 'esc', src + '; return rn;')(ap, apActive, wld, (x) => String(x ?? ''));
    return { html: String(fn(nodeId, 0, new Set()) || ''), uses_active_nodes: usesActiveNodes };
  } catch (e) { return { __error: String(e && e.message || e) }; }
};
const tree = runTree(_WLD_MULTI, 'n2');   // activePath 에 없지만 activeNodes 에 있다
assert('node_tree_marks_active_nodes_as_current',
  !tree.__error && tree.uses_active_nodes && /현재/.test(tree.html),
  { error: tree.__error, uses_active_nodes: tree.uses_active_nodes, html: String(tree.html).slice(0, 200) });

// ── S4b: 세계 렌더 구역이 activePath 를 직접 보지 않는다 (배선) ──
//   실측: 카드 목록처럼 **실행 대상이 아닌** 코드는 실행 단언으로 못 잡는다.
//   활성 판정이 activePath 를 직접 보는 순간 activeNodes 가 무시되므로, 그 형태 자체를 금지한다
//   (ap 는 활성 집합의 fallback 으로만 쓰여야 한다 — `: ap;`).
const worldRenderSources = [(() => { const i = dist.indexOf('const renderWorld = '); return i < 0 ? '' : dist.slice(i, i + 4200); })()]
  .concat((() => { const i = dist.indexOf('#wld-list'); const j = i < 0 ? -1 : dist.lastIndexOf('const ', i); return j < 0 ? '' : dist.slice(j, i + 2600); })());
const bareActivePath = worldRenderSources
  .map(t => (t.match(/\bap\.(?:includes|indexOf)\(/g) || []).length)
  .reduce((a, b) => a + b, 0);
assert('no_world_render_uses_bare_active_path',
  bareActivePath === 0
    && worldRenderSources.every(t => t === '' || /apActive/.test(t)),
  { bare_uses: bareActivePath,
    per_section: worldRenderSources.map(t => t ? { has_apActive: /apActive/.test(t), bare: (t.match(/\bap\.(?:includes|indexOf)\(/g) || []).length } : null) });

// ── S6: activeNodes 가 비면 종전과 동일 (하위 호환) ──
const legacy = { ..._WLD_MULTI, activeNodes: [] };
const kLegacy = runKpi(legacy);
const badgeLegacy = kLegacy?.['sum-wld-badge']?.textContent || '';
const dLegacy = runDetail(legacy, 'root');   // activePath 안에 있는 노드
assert('empty_active_nodes_falls_back_to_active_path',
  !kLegacy?.__error && /활성 1/.test(badgeLegacy)     // activePath ['root'] = 1곳 — 종전 동작
    && /활성/.test(dLegacy?.['wld-detail-badge']?.textContent || ''),
  { badge: badgeLegacy, detail_badge: dLegacy?.['wld-detail-badge']?.textContent });

// ── S5: 인물 화면이 소속 세계를 낸다 (실행 — 4단계 데이터) ──
const runEntity = (entityRecord, stateTracker) => {
  // 제품에서는 헬퍼가 같은 스코프에 있다 — 슬라이스에도 함께 넣어야 정확하다.
  //   (빼면 try/catch 가 ReferenceError 를 삼켜 빈 값이 되고, 게이트가 거짓 RED 를 낸다.)
  const src = sliceFn('getCharacterStateLookupKeysCompat') + sliceFn('renderEntityProfile');
  if (!src.includes('renderEntityProfile')) return { __error: 'renderEntityProfile 없음' };
  const s = makeStub();
  const deps = {
    _ENT: [{ key: '아리엘', content: JSON.stringify(entityRecord) }],
    _REL: [],
    esc: (x) => String(x ?? ''), recordSuppressedRuntimeError: () => {},
    parseGuiStoredJson: (e, kind, i) => { try { return JSON.parse(e.content); } catch { return {}; } },
    formatGuiStateTimelineHtml: () => ({ count: 0 }),
    guiCsv: (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v || '')),
    guiLines: (v) => (Array.isArray(v) ? v.filter(Boolean).join(' · ') : String(v || '')),
    formatGuiOpenThreadLabels: (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v || '')),
    formatGuiEntityBackground: () => '',
    CharacterStateTracker: stateTracker,
    EntityManager: { normalizeEntityRecord: (x) => x },
    switchTab: () => {},
    String, Object, Array, Number, JSON, Math
  };
  const keys = Object.keys(deps);
  try {
    const fn = new Function('overlay', ...keys, src + '; return renderEntityProfile;')(s.overlay, ...Object.values(deps));
    fn(0);
    return s.nodes;
  } catch (e) { return { __error: String(e && e.message || e) }; }
};

const ENTITY_RECORD = {
  name: '아리엘',
  identity: { roleInStory: '기사', affiliation: ['왕국 기사단'] },
  currentState: { location: '그림자 협곡', summary: '경계 중' },
  meta: {}
};
const STATE_WITH_WORLD = {
  getState: () => ({ '아리엘': { turnLog: [{ turn: 11, world: '아르카디아', location: '그림자 협곡', mood: '경계', health: '', notes: '' }], consolidated: [], lastConsolidationTurn: 0 } })
};
const eNodes = runEntity(ENTITY_RECORD, STATE_WITH_WORLD);
const readHtml = eNodes?.['prof-read']?.innerHTML || '';
assert('entity_profile_surfaces_world_affiliation',
  !eNodes?.__error && /아르카디아/.test(readHtml) && /세계/.test(readHtml),
  { error: eNodes?.__error, read: readHtml.slice(0, 420) });

// 소속 세계가 없으면 행이 안 나온다 (빈 값 발명 금지)
const eNodesNoWorld = runEntity(ENTITY_RECORD, { getState: () => ({ '아리엘': { turnLog: [{ turn: 11, world: '', location: 'x', mood: '', health: '', notes: '' }], consolidated: [], lastConsolidationTurn: 0 } }) });
const readNoWorld = eNodesNoWorld?.['prof-read']?.innerHTML || '';
// "아르카디아가 없다"만으로는 부족하다 — 빈 소속에 다른 값을 채워 넣어도(발명) 통과한다.
//   **'세계' 행 자체가 나오지 않아야** 한다.
const hasWorldRow = /<span class="kv-k">세계<\/span>/.test(readNoWorld);
assert('entity_profile_omits_empty_affiliation',
  !eNodesNoWorld?.__error && !hasWorldRow && !/주요 세계/.test(readNoWorld),
  { error: eNodesNoWorld?.__error, has_world_row: hasWorldRow, read: readNoWorld.slice(0, 320) });

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
