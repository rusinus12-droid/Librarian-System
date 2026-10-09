'use strict';
// 9단계 검증용 프리뷰 — 제품 CSS·마크업에 **실제 렌더러 출력**을 넣는다.
//
// 목업(손으로 그린 HTML)이 아니라 제품 자산을 쓴다:
//   - CSS·BODY: `15-gui-and-exports.js` 의 GUI_CSS / GUI_BODY 를 그대로 뽑는다
//   - 렌더 결과: 배포본에서 렌더 함수를 **잘라 실행**(게이트와 같은 방식)해 나온 innerHTML 을 심는다
//
// 왜 잘라 실행하는가: 렌더러들은 `15a:1 show()` 안쪽 스코프에 있어 IIFE 밖에서 이름으로 못 잡는다
//   (실측: `_WLD`/`syncWorldKpi`/`renderWorld`/`overlay` 모두 `undefined` 로 보인다).
//   노드 카드 목록은 `renderWorld` 안 인라인이라 슬라이스로 못 잡아 **같은 규칙으로 재현**한다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/parts/15-gui-and-exports.js'), 'utf8');
const cssMatch = source.match(/const GUI_CSS = `([\s\S]*?)`;\s*\n\s*const GUI_BODY/);
const bodyMatch = source.match(/const GUI_BODY = `([\s\S]*?)`;\s*\n\s*\/\/ Pure/);
if (!cssMatch || !bodyMatch) throw new Error('GUI_CSS or GUI_BODY extraction failed');
const dist = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

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

const el = () => ({
  _v: '', _t: '', style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
  set innerHTML(v) { this._v = String(v); }, get innerHTML() { return this._v || ''; },
  set textContent(v) { this._t = String(v); }, get textContent() { return this._t || ''; }
});
const makeStub = () => {
  const nodes = {};
  const overlay = { querySelector: (s) => { const id = String(s).replace(/^#/, ''); if (!nodes[id]) nodes[id] = el(); return nodes[id]; } };
  return { overlay, nodes };
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const RULE_HIGHLIGHTS = (rules) => {
  const out = [];
  const st = rules?.setting || {};
  (Array.isArray(st.places) ? st.places : []).forEach(v => out.push(`장소/시설: ${v}`));
  (Array.isArray(st.organizations) ? st.organizations : []).forEach(v => out.push(`조직: ${v}`));
  if (rules?.exists?.magic) out.push('마법 존재');
  (rules?.physics?.special_phenomena || []).forEach(v => out.push(`현상: ${v}`));
  Object.values(rules?.custom || {}).forEach(v => out.push(String(v)));
  return out;
};

// ── 데이터 (실제 정본 규칙과 같은 모양) ──
const ROOT_ID = 'world_main';
const WLD = {
  rootId: ROOT_ID,
  activePath: [ROOT_ID, 'n_arcadia', 'n_gorge'],   // 주 초점 = 그림자 협곡
  activeNodes: ['n_gorge', 'n_north'],              // 동시 활성 = 그림자 협곡 + 북부 변경
  nodes: [
    [ROOT_ID, { id: ROOT_ID, name: '주요 세계', parent: null, layer: 'core', children: ['n_arcadia', 'n_north'], rules: {}, meta: {} }],
    ['n_arcadia', {
      id: 'n_arcadia', name: '아르카디아', parent: ROOT_ID, layer: 'dimension', children: ['n_gorge'],
      rules: { exists: { magic: true }, setting: { places: ['검은 탑'], organizations: ['마탑 결사'] }, custom: { rule_1: '마력은 저주받은 자만 쓴다' } },
      meta: { worldSummary: '마력이 일상인 세계. 마탑이 질서를 쥐고 있다.', classification: 'dark-fantasy' }
    }],
    ['n_gorge', {
      id: 'n_gorge', name: '그림자 협곡', parent: 'n_arcadia', layer: 'region', children: [],
      rules: { physics: { special_phenomena: ['빛이 사라진다'] }, setting: { places: ['심연의 문'] } },
      meta: { worldSummary: '빛이 사라지는 협곡. 심연의 문이 열려 있다.', classification: 'dark-fantasy' }
    }],
    ['n_north', {
      id: 'n_north', name: '북부 변경', parent: ROOT_ID, layer: 'dimension', children: [],
      rules: { physics: { special_phenomena: ['혹한'] }, setting: { places: ['얼음 성채'] } },
      meta: { worldSummary: '혹한이 상시인 북부.', classification: 'dark-fantasy' }
    }]
  ]
};
const ENTITY = {
  name: '아리엘',
  identity: { roleInStory: '마탑 소속 기사', affiliation: ['왕국 기사단'] },
  currentState: { location: '그림자 협곡', summary: '심연의 문 앞에서 경계 중', emotionalState: ['경계'], activity: '문을 조사하는 중' },
  continuity: { openThreads: ['심연의 문 뒤에 무엇이 있는가'] },
  meta: {}
};
const STATE = { '아리엘': { turnLog: [
  { turn: 10, world: '아르카디아', location: '아르카디아', mood: '평온', health: '', notes: '' },
  { turn: 11, world: '아르카디아', location: '그림자 협곡', mood: '경계', health: '', notes: '' }
], consolidated: [], lastConsolidationTurn: 0 } };

const errors = [];
const run = (label, fn) => { try { return fn(); } catch (e) { errors.push(`${label}: ${e.message}`); return null; } };

const kpi = run('syncWorldKpi', () => {
  const src = sliceFn('syncWorldKpi');
  const s = makeStub();
  const deps = { _WLD: WLD, esc: (x) => String(x ?? ''), recordSuppressedRuntimeError: () => {}, extractWorldRuleHighlights: RULE_HIGHLIGHTS, Object, Array, Number, String, Map };
  const keys = Object.keys(deps);
  new Function('overlay', ...keys, src + '; return syncWorldKpi;')(s.overlay, ...Object.values(deps))();
  return s.nodes;
});

const tree = run('renderWorld', () => {
  let src = sliceFn('rn');
  if (!src) return '';
  // rn 은 자기 자신을 재귀 호출한다 — 슬라이스만 넣으면 `rn` 이 스코프에 없어 죽는다.
  //   `let rn;` 을 먼저 선언하고 슬라이스의 `const rn =` 를 할당으로 바꾼다.
  src = src.replace('const rn = ', 'rn = ');
  const wsrc = (() => { const i = dist.indexOf('const renderWorld = '); return i < 0 ? '' : dist.slice(i, i + 4200); })();
  const ap = WLD.activePath.map(String);
  const apActive = /apActive/.test(wsrc) && WLD.activeNodes.length ? WLD.activeNodes.map(String) : ap;
  const fn = new Function('ap', 'apActive', '_WLD', 'esc', 'let rn; ' + src + ' return rn;')(ap, apActive, WLD, (x) => String(x ?? ''));
  return String(fn(ROOT_ID, 0, new Set()) || '');
});

const detail = run('renderWorldDetail', () => {
  const src = sliceFn('renderWorldDetail');
  const s = makeStub();
  const deps = {
    _WLD: WLD, esc: (x) => String(x ?? ''), switchTab: () => {}, recordSuppressedRuntimeError: () => {},
    extractWorldRuleHighlights: RULE_HIGHLIGHTS, String, Object, Array, Number, JSON, Math
  };
  const keys = Object.keys(deps);
  new Function('overlay', ...keys, src + '; return renderWorldDetail;')(s.overlay, ...Object.values(deps))('n_gorge');
  return s.nodes;
});

const profile = run('renderEntityProfile', () => {
  const src = sliceFn('getCharacterStateLookupKeysCompat') + sliceFn('renderEntityProfile');
  const s = makeStub();
  const deps = {
    _ENT: [{ key: '아리엘', content: JSON.stringify(ENTITY) }], _REL: [],
    esc: (x) => String(x ?? ''), switchTab: () => {}, recordSuppressedRuntimeError: () => {},
    parseGuiStoredJson: (e) => { try { return JSON.parse(e.content); } catch { return {}; } },
    formatGuiStateTimelineHtml: () => ({ count: 2 }),
    guiCsv: (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v || '')),
    guiLines: (v) => (Array.isArray(v) ? v.filter(Boolean).join(' · ') : String(v || '')),
    formatGuiOpenThreadLabels: (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v || '')),
    formatGuiEntityBackground: () => '',
    CharacterStateTracker: { getState: () => STATE },
    EntityManager: { normalizeEntityRecord: (x) => x },
    String, Object, Array, Number, JSON, Math
  };
  const keys = Object.keys(deps);
  new Function('overlay', ...keys, src + '; return renderEntityProfile;')(s.overlay, ...Object.values(deps))(0);
  return s.nodes;
});

const grab = (host, id) => (host && host[id] ? (host[id].innerHTML || host[id].textContent || '') : '');

// 노드 카드 목록: renderWorld 안 인라인 → 제품과 같은 규칙으로 재현
const apActive = WLD.activeNodes.length ? WLD.activeNodes.map(String) : WLD.activePath.map(String);
const cardCards = WLD.nodes.map(([id, node]) => {
  const n = node && typeof node === 'object' ? node : {};
  const isActive = apActive.includes(String(id));
  const nMeta = n.meta && typeof n.meta === 'object' ? n.meta : {};
  const ruleList = RULE_HIGHLIGHTS(n.rules && typeof n.rules === 'object' ? n.rules : {});
  const preview = ruleList.slice(0, 3).map(v => esc(String(v))).join(' · ');
  return `<div class="card wld-node-card" data-wld-active="${isActive ? '1' : '0'}">
    <div class="card-hdr"><strong>${esc(n.name || id)}</strong>
      <div class="card-meta">${isActive ? '<span class="bdg bt">활성</span>' : '<span class="bdg bh">이력</span>'}${nMeta.classification ? `<span class="chip">${esc(nMeta.classification)}</span>` : ''}<span class="chip">규칙 ${ruleList.length}</span></div>
    </div>
    <div class="entity-summary">${preview ? `<span class="entity-summary-bit">${preview}</span>` : '<span class="entity-summary-bit">규칙 없음</span>'}</div>
  </div>`;
}).join('');

const badge = esc(grab(kpi, 'sum-wld-badge'));
const kpiNodes = grab(kpi, 'sum-wld-nodes');
const kpiRules = grab(kpi, 'sum-wld-rules');
const kpiRulesBadge = esc(grab(kpi, 'sum-wld-rules-badge'));
const kpiRulesNote = esc(grab(kpi, 'sum-wld-rules-note'));
const kpiCorr = grab(kpi, 'sum-wld-corr');
const detailBadge = esc(grab(detail, 'wld-detail-badge'));
const detailName = esc(grab(detail, 'wld-detail-name'));
const detailSummary = esc(grab(detail, 'wld-detail-summary'));
const detailTags = grab(detail, 'wld-detail-tags');
const detailRead = grab(detail, 'wld-detail-read');
const profName = esc(grab(profile, 'prof-name'));
const profRole = esc(grab(profile, 'prof-role'));
const profRead = grab(profile, 'prof-read');
const profTags = grab(profile, 'prof-tags');
const profWorld = (profRead.match(/<span class="kv-k">세계<\/span><span class="kv-v">([^<]*)</) || [])[1] || null;

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LIBRA 9단계 — 멀티노드·소속 화면 (실제 렌더 결과)</title>
<style>${cssMatch[1]}</style>
<style>
  body { background:#14110e; margin:0; padding:24px; }
  .pv-head { max-width:1180px; margin:0 auto 16px; color:#e8e2d8; font:600 15px/1.5 system-ui,sans-serif; }
  .pv-head h1 { font-size:20px; margin:0 0 6px; }
  .pv-head p { margin:0; color:#a89f92; font:400 13px/1.6 system-ui,sans-serif; }
  .pv-note { max-width:1180px; margin:0 auto 18px; padding:11px 15px; border-radius:8px;
             background:#1f1a15; border:1px solid #3a3128; color:#c9bfae; font:400 12.5px/1.65 system-ui,sans-serif; }
  .pv-note b { color:#e0bd7c; }
  .pv-wrap { max-width:1180px; margin:0 auto; }
  .pv-err { max-width:1180px; margin:18px auto; padding:12px 14px; border-radius:8px;
            background:#2a1414; border:1px solid #6b2b2b; color:#f0b4b4; font:400 12px/1.6 monospace; }
  .pv-sec { margin-top:22px; }
</style>
</head><body>
<div class="pv-head">
  <h1>9단계 — 멀티노드 · 소속 화면</h1>
  <p>제품 CSS·마크업에 <b>실제 렌더러가 만든 결과</b>를 넣은 화면입니다(손으로 그린 목업이 아닙니다).</p>
</div>
<div class="pv-note">
  <b>정본</b> — 트리: 주요 세계 &gt; 아르카디아 &gt; 그림자 협곡, 그리고 <b>북부 변경</b>(같은 층).<br>
  <b>주 초점</b>(activePath) = 그림자 협곡 &nbsp;·&nbsp; <b>동시 활성</b>(activeNodes) = 그림자 협곡 + 북부 변경<br>
  <b>볼 것</b> — 노드 목록·트리에서 <b>북부 변경도 "활성"</b>인가 · KPI 가 <b>활성 2</b> 인가 ·
  인물 상세에 <b>세계 = 아르카디아</b> 행이 있고 <b>소속 = 왕국 기사단</b>(조직)과 구분되는가.
</div>
<div class="pv-wrap">
  <div id="tab-world" class="panel on">
    <div class="crumb">데이터 / <b>세계관</b></div>
    <div class="page-head">
      <div><h2>세계관</h2><div class="desc">세계 규칙은 <strong>노드 계층</strong>으로 쌓입니다. 활성 경로에 따라 장면용 세계관이 구성됩니다.</div></div>
    </div>
    <div class="kpi-grid">
      <div class="card kpi hl">
        <div class="kpi-top"><span class="kpi-name">⬡ 세계 노드</span><span class="badge b-gold">${badge}</span></div>
        <div class="kpi-num">${kpiNodes}</div>
        <div class="kpi-note">현재 활성 경로에 따라 장면용 세계관이 구성됩니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">◈ 확립된 규칙</span><span class="badge b-info">${kpiRulesBadge}</span></div>
        <div class="kpi-num">${kpiRules}</div>
        <div class="kpi-note">${kpiRulesNote}</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">⚠ 사용자 교정</span><span class="badge b-warn">미반영</span></div>
        <div class="kpi-num">${kpiCorr}</div>
        <div class="kpi-note">잘못 기록된 세계관을 직접 고친 항목입니다.</div>
      </div>
    </div>
    <div class="card">
      <div class="st">노드 트리 — "현재" 표시가 활성 위치</div>
      <div style="font-size:var(--fs-body)">${tree}</div>
    </div>
    <div class="card">
      <div class="st">노드 목록 — 카드의 활성 / 이력 배지</div>
      <div class="wld-list">${cardCards}</div>
    </div>
    <div class="card">
      <div class="st">세계 상세 — 그림자 협곡</div>
      <div class="hero"><div>
        <div class="hero-role"><span class="badge b-gold">${detailBadge}</span></div>
        <h3 style="margin:6px 0 2px">${detailName}</h3>
        <div class="hero-role">${detailSummary}</div>
      </div></div>
      <div class="hero-tags">${detailTags}</div>
      <div class="kv-grid">${detailRead}</div>
    </div>
  </div>
  <div class="pv-sec">
    <div id="tab-entity" class="panel on">
      <div class="crumb">데이터 / <b>인물</b></div>
      <div class="page-head"><div><h2>인물</h2><div class="desc">인물 상세 — <b>세계</b> 행이 4단계 소속이고, <b>소속</b> 은 조직입니다(다른 축).</div></div></div>
      <div class="explorer"><div class="card">
        <div class="card-hdr"><div><div class="card-title">${profName}</div><div class="card-meta">${profRole}</div></div></div>
        <div class="hero-tags">${profTags}</div>
        <div class="kv-grid">${profRead}</div>
      </div></div>
    </div>
  </div>
</div>
${errors.length ? `<div class="pv-err"><b>렌더 오류 ${errors.length}건</b><br>${errors.map(esc).join('<br>')}</div>` : ''}
</body></html>`;

const outPath = path.join(ROOT, 'ux-prototype', 'libra-world-stage9-display.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log(outPath);
console.log(JSON.stringify({
  errors,
  kpi_badge: badge,
  kpi_nodes: kpiNodes,
  kpi_rules: kpiRules,
  detail_badge: detailBadge,
  north_active_in_tree: /북부 변경/.test(tree) && /현재/.test(tree),
  north_card_active: /data-wld-active="1"[\s\S]*?북부 변경/.test(cardCards),
  prof_world_row: profWorld,
  prof_has_org_row: /왕국 기사단/.test(profRead)
}, null, 2));
