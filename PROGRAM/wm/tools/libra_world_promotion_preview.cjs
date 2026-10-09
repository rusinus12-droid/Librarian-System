'use strict';
// 승격 UI 검증용 프리뷰 — 기억 카드의 승격/강등 버튼을 **실제 렌더러 출력**으로 보여준다.
//
// 제품 자산을 쓴다: CSS·마크업은 `15-gui-and-exports.js` 에서 뽑고,
// 카드 HTML 은 배포본에서 `memCardsHtml` 을 **잘라 실행**해 얻는다(손으로 그리지 않는다).
//
// 대조: ① 승격 전 카드("세계 규칙으로") ② 승격 후 카드("승격 취소" + 배지).
// 그 차이가 눈에 보이는 것이 이 프리뷰의 목적이다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/parts/15-gui-and-exports.js'), 'utf8');
const cssMatch = source.match(/const GUI_CSS = `([\s\S]*?)`;\s*\n\s*const GUI_BODY/);
const bodyMatch = source.match(/const GUI_BODY = `([\s\S]*?)`;\s*\n\s*\/\/ Pure/);
if (!cssMatch || !bodyMatch) throw new Error('GUI_CSS or GUI_BODY extraction failed');
const dist = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

// 문장 추출은 (), {}, [] 를 **함께** 세고 깊이 0의 `;` 에서 끝낸다.
//   중괄호만 세는 방식은 `=> list.map((m) => { … })` 모양에서 **괄호를 닫지 못해** 파편을 낸다
//   (실측: missing ) after argument list).
const sliceFn = (name) => {
  const i = dist.indexOf('const ' + name + ' = ');
  if (i < 0) return null;
  let round = 0, curly = 0, square = 0, inString = null, escaped = false;
  for (let k = i; k < dist.length; k++) {
    const ch = dist[k];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (inString) { if (ch === inString) inString = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === ';' && round === 0 && curly === 0 && square === 0) return dist.slice(i, k + 1);
  }
  return null;
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MK = (meta, body) => ({
  key: 'lmai_memory::x', comment: 'lmai_memory',
  content: `[META:${JSON.stringify(meta)}]\n${body}`,
  mode: 'normal', insertorder: 100, alwaysActive: false
});
const BODY = '아리엘이 검은 탑에서 확인했다 — 마력은 저주받은 자만 쓴다. 마탑의 허가 없이 쓰면 대가가 따른다.';
const MEM_BEFORE = [MK({ imp: 7, t: 12, ttl: -1, cat: '세계 규칙', sourceHint: '장면에서 확인된 세계 법칙' }, BODY)];
const MEM_AFTER = [MK({
  imp: 7, t: 12, ttl: -1, cat: '세계 규칙', sourceHint: '장면에서 확인된 세계 법칙',
  // WorldPromotionBridge.promote 가 만드는 모양 그대로
  provenanceStatus: 'retracted',
  promotedTo: { nodeId: 'node_arcadia', nodeName: '아르카디아', text: '마력은 저주받은 자만 쓴다' },
  promotedAt: 1790660000000
}, BODY)];

// ── 렌더: memCardsHtml 을 잘라 실행한다 ──
//   의존: parseMeta, stripMeta, buildGuiMemoryReadable, impBdg, esc, escAttr, _MEM +
//         buildGuiMemoryReadable 이 쓰는 것들(LibraDataStorage 등) — 넘겨준다.
const errors = [];
const renderCards = (list) => {
  const src = sliceFn('memCardsHtml');
  if (!src) { errors.push('memCardsHtml 슬라이스 실패'); return '<div class="empty">memCardsHtml 없음</div>'; }
  const parseMeta = (c) => {
    const m = String(c || '').match(/\[META:([\s\S]*?)\]/);
    if (!m) return { imp: 5, t: 0, ttl: 0, cat: '' };
    try { return { imp: 5, t: 0, ttl: 0, cat: '', ...JSON.parse(m[1]) }; } catch { return { imp: 5, t: 0, ttl: 0, cat: '' }; }
  };
  const stripMeta = (c) => String(c || '').replace(/^\s*\[META:[\s\S]*?\]\s*/,'').trim();
  const impBdg = (i) => { const cls = i >= 7 ? 'bh' : i >= 4 ? 'bm' : 'bl'; return `<span class="bdg ${cls}">중요도 ${i}</span>`; };
  const buildGuiMemoryReadable = (entry, meta) => {
    const body = stripMeta(entry?.content);
    const parts = body.split(/(?<=[.!?])\s+/).filter(Boolean);
    return {
      kind: 'world_rule',
      title: '자연어 기억 보기',
      body: parts.join(' ').slice(0, 400),
      chips: Array.isArray(meta?.cat) ? meta.cat : (meta?.cat ? [meta.cat] : []),
      rawLabel: '원본 데이터 보기/수정',
      rpGroups: []
    };
  };
  const deps = {
    parseMeta, stripMeta, buildGuiMemoryReadable, impBdg,
    esc: (x) => String(x ?? ''),
    escAttr: (x) => String(x ?? ''),
    _MEM: list,
    LibraDataStorage: { scopeKeyFor: () => 'preview' },
    Char: {}, chat: {}, _CFG: {}
  };
  const keys = Object.keys(deps);
  try {
    // memCardsHtml 은 (list) => ... 형태다 — _MEM 은 카드가 삭제 인덱스용으로 참조한다.
    const fn = new Function(...keys, src + '; return memCardsHtml;')(...Object.values(deps));
    return String(fn(list) || '');
  } catch (e) { errors.push('memCardsHtml 실행: ' + e.message); return `<div class="empty">렌더 실패: ${esc(e.message)}</div>`; }
};

const beforeHtml = renderCards(MEM_BEFORE);
const afterHtml = renderCards(MEM_AFTER);

const hasBeforeButton = /class="btn bs act-promote-mem"/.test(beforeHtml);
const hasAfterButton = /class="btn bs act-demote-mem"/.test(afterHtml);
const hasAfterBadge = /세계 규칙 ↑/.test(afterHtml);

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LIBRA 승격 UI — 기억 카드 (실제 렌더 결과)</title>
<style>${cssMatch[1]}</style>
<style>
  body { background:#14110e; margin:0; padding:24px; }
  .pv-head { max-width:1100px; margin:0 auto 16px; color:#e8e2d8; font:600 15px/1.5 system-ui,sans-serif; }
  .pv-head h1 { font-size:20px; margin:0 0 6px; }
  .pv-head p { margin:0; color:#a89f92; font:400 13px/1.6 system-ui,sans-serif; }
  .pv-note { max-width:1100px; margin:0 auto 20px; padding:11px 15px; border-radius:8px;
             background:#1f1a15; border:1px solid #3a3128; color:#c9bfae; font:400 12.5px/1.65 system-ui,sans-serif; }
  .pv-note b { color:#e0bd7c; }
  .pv-wrap { max-width:1100px; margin:0 auto; }
  .pv-sec { margin-bottom:26px; }
  .pv-sec > .st { margin:0 0 10px; }
  .pv-err { max-width:1100px; margin:18px auto; padding:12px 14px; border-radius:8px;
            background:#2a1414; border:1px solid #6b2b2b; color:#f0b4b4; font:400 12px/1.6 monospace; }
  .pv-flow { max-width:1100px; margin:0 auto 20px; padding:12px 15px; border-radius:8px;
             background:#17140f; border:1px solid #2e2721; color:#9c9284; font:400 12.5px/1.7 system-ui,sans-serif; }
  .pv-flow code { color:#e0bd7c; }
</style>
</head><body>
<div class="pv-head">
  <h1>승격 UI — 기억 카드</h1>
  <p>제품 CSS·마크업에 <b>실제 카드 렌더러(memCardsHtml) 실행 결과</b>를 넣은 화면입니다.</p>
</div>
<div class="pv-note">
  <b>왼쪽이 승격 전, 아래가 승격 후</b>입니다. 같은 기억인데 버튼이 바뀌는 것이 승격의 가시적 결과입니다.<br>
  <b>볼 것</b> — 승격 전에는 <b>"세계 규칙으로"</b> 버튼 · 승격 후에는 <b>"승격 취소"</b> 버튼과
  <b>"세계 규칙 ↑아르카디아"</b> 배지가 붙는가.
</div>
<div class="pv-flow">
  누르면 일어나는 일: <code>WorldPromotionBridge.promote()</code> → 지금 세계 노드의 <code>custom</code> 에 규칙 삽입
  → 기억 META 에 <code>provenanceStatus:'retracted'</code> 기록 → <b>재스탬프</b> → 세계 그래프 저장.<br>
  결과: 그 규칙은 세계 블록으로 <b>매 턴 무조건</b> 나가고, 이 기억은 <b>회상에서 빠진다</b>(중복 제거).
  "승격 취소"는 규칙을 <b>내용으로 찾아 제거</b>하고 회상 자격을 되돌립니다.
</div>
<div class="pv-wrap">
  <div class="pv-sec">
    <div class="st">① 승격 전 — "세계 규칙으로"</div>
    <div class="list">${beforeHtml}</div>
  </div>
  <div class="pv-sec">
    <div class="st">② 승격 후 — "승격 취소" + 배지</div>
    <div class="list">${afterHtml}</div>
  </div>
</div>
${errors.length ? `<div class="pv-err"><b>렌더 오류 ${errors.length}건</b><br>${errors.map(esc).join('<br>')}</div>` : ''}
</body></html>`;

const outPath = path.join(ROOT, 'ux-prototype', 'libra-world-promotion-cards.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log(outPath);
console.log(JSON.stringify({
  errors,
  before_has_promote_button: hasBeforeButton,
  after_has_demote_button: hasAfterButton,
  after_has_badge: hasAfterBadge,
  before_len: beforeHtml.length,
  after_len: afterHtml.length
}, null, 2));
