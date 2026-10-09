'use strict';
// Gate: GUI 마크업의 태그가 실제로 균형인가.
//
// 배경 (실측): 셸을 재배치할 때 </div> 가 하나 남아 gui-wrap 이 일찍 닫혔고,
// <div class="content"> 가 프레임 밖(top 810, 폭 1440)으로 나가 화면이 깨졌다.
// 또 세계관 details 닫힘이 패널 밖으로 나간 적이 있다. 둘 다 태그 균형 문제였다.
//
// 검사 방법 주의: 마크업에는 JS 템플릿 리터럴(${...}) 안의 태그가 섞여 있다.
// 순진하게 정규식으로 세면 ${} 안의 <div> 를 실제 태그로 오인해
// "미닫힘 227 / 불일치 143" 같은 오탐이 난다(실제로 겪었다).
// 그래서 이 게이트는 ${...} 를 먼저 걷어낸 뒤 센다.
//
// 이 게이트가 단언하는 계약:
//   1) GUI_BODY 의 모든 태그가 균형이다 (${...} 제거 후)
//   2) 최상위 구조가 hdr / tabs / content 로 유지된다
//   3) 12개 이상 패널이 같은 깊이(최상위)에 있다
//   4) 패널 밖으로 나간 .sec 요소가 없다 (겹침 결함 방지)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'parts', '15-gui-and-exports.js'), 'utf8');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }
const assertions = [];

const start = source.indexOf('const GUI_BODY = `');
let body = source.slice(start, source.indexOf('`;', start));
body = body.slice(body.indexOf('`') + 1);

// ── ${...} 제거 (중첩 중괄호 고려) ───────────────────────────────────────
let cleaned = '';
for (let i = 0; i < body.length; i++) {
  if (body[i] === '$' && body[i + 1] === '{') {
    let depth = 0;
    for (let j = i + 1; j < body.length; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') { depth--; if (depth === 0) { i = j; break; } }
    }
    cleaned += ' ';
  } else {
    cleaned += body[i];
  }
}
assertions.push(assert('template_expressions_stripped_for_counting',
  cleaned.length > 0 && !cleaned.includes('${'),
  { length: cleaned.length, note: '${} 안의 태그를 실제 태그로 오인하지 않기 위해' }));

// ── 1. 태그 균형 ─────────────────────────────────────────────────────────
const VOID = new Set(['br','hr','img','input','meta','link','source','track','wbr','area','base','col','embed','param']);
const stack = [];
const mismatches = [];
for (const m of cleaned.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
  const closing = m[1] === '/';
  const tag = m[2].toLowerCase();
  const selfClose = m[3] === '/';
  if (VOID.has(tag) || selfClose) continue;
  if (!closing) stack.push(tag);
  else {
    if (stack.length && stack[stack.length - 1] === tag) stack.pop();
    else mismatches.push(tag);
  }
}
assertions.push(assert('all_tags_balanced', stack.length === 0 && mismatches.length === 0,
  { unclosed: stack, mismatched: mismatches }));

// ── 2. 최상위 구조 ───────────────────────────────────────────────────────
const topLevel = [];
{
  let depth = 0;
  for (const m of cleaned.matchAll(/<(\/?)div\b[^>]*>/g)) {
    if (m[1] === '/') { depth--; if (depth === 0 && topLevel.length > 5) break; }
    else {
      if (depth === 1) {
        const cls = /class="([^"]+)"/.exec(cleaned.slice(m.index, m.index + 200));
        topLevel.push(cls ? cls[1].split(' ')[0] : '?');
      }
      depth++;
    }
  }
}
assertions.push(assert('shell_has_brand_tabs_content',
  topLevel.includes('hdr') && topLevel.includes('tabs') && topLevel.includes('content'),
  { topLevel }));

// ── 3. 패널이 같은 깊이 ──────────────────────────────────────────────────
const panelDepths = [];
{
  let depth = 0;
  for (const m of cleaned.matchAll(/<(\/?)div\b[^>]*>/g)) {
    if (m[1] === '/') depth--;
    else {
      if (/^<div id="tab-/.test(m[0])) panelDepths.push(depth);
      depth++;
    }
  }
}
const uniform = panelDepths.length >= 12 && new Set(panelDepths).size === 1;
assertions.push(assert('panels_share_one_depth', uniform,
  { count: panelDepths.length, depths: [...new Set(panelDepths)] }));

// ── 4. 패널 밖 .sec 없음 ─────────────────────────────────────────────────
const secTags = [...cleaned.matchAll(/<div class="sec"/g)].map(m => m.index);
let orphanSec = 0;
{
  // 각 .sec 앞에서 열린 패널이 아직 닫히지 않았는지 — 패널 id 마커로 근사
  const panelStarts = [...cleaned.matchAll(/<div id="tab-[a-z\-]+" class="panel/g)].map(m => m.index);
  const markers = panelStarts.map(s => ({ s, e: cleaned.indexOf('<div id="tab-', s + 10) }));
  secTags.forEach(pos => {
    const owner = markers.filter(x => x.s < pos).pop();
    const end = owner ? (owner.e < 0 ? cleaned.length : owner.e) : -1;
    if (!owner || pos > end) orphanSec++;
  });
}
assertions.push(assert('no_section_outside_panels', orphanSec === 0,
  { orphanSec, total: secTags.length, note: '패널 밖 .sec 는 모든 화면 위에 겹쳐 보인다' }));

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
