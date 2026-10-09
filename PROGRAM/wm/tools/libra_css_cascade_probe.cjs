'use strict';
// 도구: CSS 규칙이 **실제로 계산되는지** 판정한다 (DOM 렌더러 없이).
//
// 배경 — 이 리포에는 jsdom/playwright 같은 렌더러가 없다. 그래서 레이아웃 결함을
//   "마크업에 있다"로만 판정해 왔다. 그 결과 **무력(inert) 규칙과 죽은 마크업**이
//   게이트를 통과했다. 여기서는 cascade 규칙을 직접 계산해 그 함정을 잡는다:
//
//     ① 같은 브레이크포인트 안에 **같은 속성을 두 번 선언**하면 뒤가 이긴다
//        (예: 780px 블록의 `.tabs{display:grid}` 가 다른 780px 블록의 flex 를 덮는다)
//     ② `display:flex` 인 부모에서만 `flex-wrap`/`flex-direction` 이 의미가 있다
//        (grid 부모 안의 flex-* 는 **무력**)
//     ③ `hidden` 속성이 CSS 나 부활 코드 없이 남아 있으면 **영구 숨김**(죽은 마크업)
//
// 사용: node tools/libra_css_cascade_probe.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GUI = path.join(ROOT, 'src/parts/15-gui-and-exports.js');
const src = fs.readFileSync(GUI, 'utf8');

const cssStart = src.indexOf('const GUI_CSS = `');
const cssEnd = src.indexOf('const GUI_BODY');
if (cssStart < 0 || cssEnd < 0) { console.log(JSON.stringify({ ok: false, reason: 'GUI_CSS/GUI_BODY_not_found' })); process.exit(1); }
//   ★★ **CSS 주석을 먼저 걷어낸다.** 주석을 그대로 두고 중괄호 균형으로 블록을 찾으면
//      주석 안의 중괄호 하나가 파서를 어긋나게 해 **이후 규칙이 통째로 사라진다**.
//      실측: `512행` 주석의 `.entity-band{display:flex}` 가 701블록 규칙을 삼켜
//      `.tabs` 규칙이 5개여야 하는데 3개로 파싱됐다(그래서 무력 flex 선언을 못 잡았다).
const stripCssComments = (text) => String(text || '').replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripCssComments(src.slice(cssStart + 'const GUI_CSS = `'.length, cssEnd));
const body = src.slice(cssEnd);

// ── CSS 파싱 (중괄호 균형 + @media 중첩) ──────────────────────────────
//   rules: [{ media: '780' | null, sel: '.side-sec', decls: 'display:flex;…', order: n }]
const rules = [];
let order = 0;
const pushRule = (media, sel, decls) => rules.push({ media, sel: sel.trim(), decls, order: order++ });

const parseBlock = (text, media) => {
  let i = 0;
  while (i < text.length) {
    let brace = text.indexOf('{', i);
    if (brace < 0) break;
    const sel = text.slice(i, brace).trim();
    let depth = 1, j = brace + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const inner = text.slice(brace + 1, j - 1);
    const m = /^@media\s*\(max-width:\s*(\d+)px\)$/.exec(sel.replace(/\s+/g, ' ').trim());
    if (m) {
      // @media 안: 중첩 블록을 재귀로 (선언만 있는 경우는 무시 — 여기선 쓰지 않는다)
      parseBlock(inner, m[1]);
    } else if (sel && !sel.startsWith('@')) {
      // @keyframes 내부는 건너뛴다
      if (!/^\d+%$/.test(sel) && !/^(from|to)$/i.test(sel)) pushRule(media, sel, inner);
    } else if (sel.startsWith('@')) {
      // @supports 등은 내부를 그대로 훑는다
      parseBlock(inner, media);
    }
    i = j;
  }
};
parseBlock(css, null);

const declOf = (ruleText, prop) => {
  const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)').exec(';' + ruleText.replace(/\s+/g, ' '));
  return m ? m[1].trim() : '';
};
const declsFor = (selector, media) => rules.filter(r => r.media === media && r.sel === selector);

// ── ① inert flex: 부모가 grid 인데 자식이 flex-wrap/flex-direction 을 쓴다 ──
const findInertFlex = () => {
  const out = [];
  for (const media of ['760', '780', '880', '900', '480', '520', null]) {
    const parent = declsFor('.tabs', media).map(r => r.decls).join(';');
    const disp = declOf(parent, 'display');
    const child = declsFor('.side-sec', media).map(r => r.decls).join(';');
    const childDisp = declOf(child, 'display');
    if (childDisp === 'flex' && !declOf(child, 'flex-wrap') && disp === 'grid') {
      out.push({ media: media || 'base', parentDisplay: disp, childDisplay: childDisp, childFlexWrap: declOf(child, 'flex-wrap') || '(없음)',
        note: '.side-sec 가 flex 인데 flex-wrap 이 없다 → 항목이 감기지 않는다' });
    }
  }
  return out;
};

// ── ①b inert flex 선언: flex-* 를 선언했는데 **그 브레이크포인트의 display 가 flex 가 아니다** ──
//   실측 사례(D3): 780px 에서 `.tabs{display:grid}`(345블록) 가 이기는데
//   701블록이 `.tabs{flex-direction:row;flex-wrap:wrap}` 를 선언한다 → **완전 무력**.
//   컨테이너가 grid 인데 flex 속성을 쓰면 **아무 효과가 없고**, 읽는 사람에게
//   "여기는 flex row" 라는 **거짓 인상**을 준다.
const findInertFlexDeclarations = () => {
  const out = [];
  const selectors = new Set(rules.map(r => r.sel));
  for (const sel of selectors) {
    //   ★ **flex-direction / flex-wrap 만** 무력 대상이다.
    //     `align-items`/`justify-content` 는 CSS Box Alignment 라 **grid 에서도 유효**하다 —
    //     그것까지 결함으로 세면 오탐이 쏟아진다(실측: 6건 중 5건이 그런 오탐).
    const flexProps = ['flex-direction', 'flex-wrap'];
    for (const media of [...new Set(rules.map(r => r.media))]) {
      const decls = declsFor(sel, media).map(r => r.decls).join(';');
      if (!decls) continue;
      const declaredFlex = flexProps.filter(p => declOf(decls, p));
      if (!declaredFlex.length) continue;
      //   그 브레이크포인트에서 이 선택자의 **이기는 display** 를 구한다 (base + 모든 활성 media 중 뒤 선언)
      const displayCandidates = [];
      for (const m of [null, '900', '880', '780', '760', '520', '480']) {
        if (m !== null && media !== null && Number(m) < Number(media)) continue;   // 더 좁은 브레이크포인트만 덮는다
        if (m !== null && media === null) continue;                                // base 뒤에 오는 mobile 규칙은 여기선 무시
        for (const r of declsFor(sel, m)) {
          const v = declOf(r.decls, 'display');
          if (v) displayCandidates.push({ order: r.order, media: m, value: v });
        }
      }
      if (!displayCandidates.length) continue;
      displayCandidates.sort((a, b) => (a.media === null ? 0 : 1) - (b.media === null ? 0 : 1) || a.order - b.order);
      const winner = displayCandidates[displayCandidates.length - 1].value;
      if (!/^(flex|inline-flex)$/.test(winner)) {
        out.push({ selector: sel, media: media || 'base', declaredFlex, effectiveDisplay: winner, inert: true,
          note: 'display 가 flex 가 아니면 flex-* 는 무효다 — 죽은 코드이자 거짓 인상' });
      }
    }
  }
  return out;
};

// ── ② 중복 선언: 같은 media 안에서 같은 선택자+속성을 두 번 ──
const findOverridden = () => {
  const out = [];
  const byKey = new Map();
  for (const r of rules) {
    for (const prop of ['display', 'flex-direction', 'flex-wrap', 'grid-template-columns']) {
      const v = declOf(r.decls, prop);
      if (!v) continue;
      const key = `${r.media || 'base'}|${r.sel}|${prop}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ order: r.order, value: v });
    }
  }
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const winner = list[list.length - 1];
    const losers = list.slice(0, -1);
    out.push({ key, winner: winner.value, overridden: losers.map(x => x.value),
      note: '같은 브레이크포인트에서 뒤 선언이 이긴다 — 앞 선언은 죽은 코드' });
  }
  return out;
};

// ── ③ hidden 인데 부활 코드/CSS 가 없다 (죽은 마크업) ──
const findDeadHidden = () => {
  const out = [];
  //   `aria-hidden` 은 별개 속성이다 — `hidden` 만 본다 (단어 경계).
  const hiddenAttrs = [...body.matchAll(/<[^>]*\shidden(?:\s[^>]*)?>/g)];
  for (const m of hiddenAttrs) {
    const tag = m[0];
    const idm = /id="([^"]+)"/.exec(tag);
    const clm = /class="([^"]+)"/.exec(tag);
    const keys = [idm && idm[1], ...(clm ? clm[1].split(/\s+/) : [])].filter(Boolean);
    // 부활시키는 코드가 있나 (다른 조각 포함)
    const dir = path.join(ROOT, 'src/parts');
    let revive = '';
    for (const f of fs.readdirSync(dir)) {
      if (!/^15.*\.js$/.test(f)) continue;
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const k of keys) {
        const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // hidden 제거/설정 관련 참조만
        const re = new RegExp(`(removeAttribute\\(\\s*['"]hidden|hidden\\s*=\\s*false)[^;]{0,120}${esc}`, 'g');
        const re2 = new RegExp(`${esc}[^;]{0,120}(removeAttribute\\(\\s*['"]hidden|hidden\\s*=\\s*false)`, 'g');
        if (re.test(s) || re2.test(s)) revive += `${f}:${k};`;
      }
    }
    // 부모 패널째로 숨겨지는 경우(의도적)는 죽은 마크업이 아니다 —
    //   그 판단은 호출자가 한다. 여기서는 **사실만** 남긴다.
    if (!revive) out.push({ tag: tag.slice(0, 90), keys, reviveCode: '' });
  }
  return out;
};

const report = {
  ok: true,
  cssRuleCount: rules.length,
  mediaBreakpoints: [...new Set(rules.map(r => r.media).filter(Boolean))].sort((a, b) => b - a),
  inertFlex: findInertFlex(),
  inertFlexDeclarations: findInertFlexDeclarations(),
  overriddenDeclarations: findOverridden(),
  deadHiddenMarkup: findDeadHidden(),
  note: '이 도구는 **계산된 cascade** 를 본다 — 마크업 존재 여부가 아니다.'
};
console.log(JSON.stringify(report, null, 2));
process.exit(0);
