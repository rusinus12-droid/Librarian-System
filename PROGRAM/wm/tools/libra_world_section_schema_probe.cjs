'use strict';
// 실측: 세 곳의 세계 "섹션" 목록을 정확히 맞댄다 (사용자 설계 원칙: 템플릿이 섹션을 감싼다).
//
// ① 주입 출력   08a formatForPrompt 가 내는 라벨
// ② 분류 bucket 01a classifyWorldCanonStatements
// ③ 사용자 입력 15-gui 마크업 필드 → 15b 가 쓰는 rules 경로
// 셋이 1:1 이어야 승격이 엉뚱한 칸에 들어가지 않는다.
// 이전 검사기는 불용어 제거가 과해 무의미했으므로, 여기서는 **원문 라벨**로 대조한다.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const out = {};

// ── ① 주입 출력 ──
const wg = read('src/parts/08a-world-graph.js');
const fpStart = wg.indexOf('const formatForPrompt');
const fpBody = wg.slice(fpStart, wg.indexOf('return parts.join', fpStart));
out.injection = {
  headings: [...new Set([...fpBody.matchAll(/parts\.push\('(【[^】]+】|\\n\[[^\]]+\])'/g)].map(m => m[1].replace('\\n', '')))],
  labels: [...new Set([...fpBody.matchAll(/parts\.push\(`?\s{2}([가-힣A-Za-z·/()\s]+?)\/?[A-Za-z]*:/g)].map(m => m[1].trim()))].filter(Boolean)
};

// ── ② 분류 bucket ──
const normSrc = read('src/parts/01a-message-scope-world-normalization.js');
const cs = normSrc.slice(normSrc.indexOf('function classifyWorldCanonStatements'));
out.classify_buckets = [...new Set([...cs.slice(0, 3000).matchAll(/bucket: '([a-zA-Z]+)'/g)].map(m => m[1]))];
out.classify_return_keys = [...new Set([...cs.slice(0, 4000).matchAll(/^\s{12}([a-zA-Z]+): dedupeTextArray/gm)].map(m => m[1]))];
out.classify_is_used_at_all = (() => {
  const callers = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'src/parts'))) {
    const s = read(`src/parts/${f}`);
    if (f !== '01a-message-scope-world-normalization.js' && /classifyWorldCanonStatements\s*\(/.test(s)) callers.push(f);
  }
  return callers;
})();

// ── ③ GUI 필드 → 정본 경로 ──
const gui = read('src/parts/15-gui-and-exports.js');
const g0 = gui.indexOf('🧱 세계관 정본 필드');
const g1 = gui.indexOf('btn-save-world-fields', g0);
const guiBody = gui.slice(g0, g1);
const fields = [];
for (const m of guiBody.matchAll(/<label>([^<]+)<\/label>\s*<(?:input|textarea|select)[^>]*?id="([^"]+)"/g)) {
  fields.push({ label: m[1].trim(), id: m[2] });
}
out.gui_fields = fields;

// 15b 가 각 필드를 어느 rules 경로에 쓰는가 (selector → path)
const gb = read('src/parts/15b-gui-content-world-dlc.js');
const saveBlock = gb.slice(gb.indexOf('rules.setting = normalizeWorldSettingRules'), gb.indexOf('rules.setting = normalizeWorldSettingRules') + 2600);
const routes = [];
for (const m of saveBlock.matchAll(/rules\.([a-zA-Z_.]+)\s*=\s*[^;]*?#([a-z-]+)/g)) routes.push({ path: m[1], selector: '#' + m[2] });
for (const m of saveBlock.matchAll(/(?:setWorldSelectValue|applyWorldSelectValue)\([^,]+,\s*'?([a-zA-Z_]+)'?,\s*`#([a-z-]+)`\)/g)) routes.push({ path: m[1], selector: '#' + m[2] });
out.gui_routes = routes;

// ── ④ 대조: 분류 bucket 이 주입 라벨에 있는가 ──
const injLabels = out.injection.labels.map(s => s.toLowerCase());
out.alignment = {
  classifier_buckets: out.classify_buckets,
  present_in_injection: out.classify_buckets.filter(b => injLabels.some(l => l.includes(b.toLowerCase()))),
  missing_from_injection: out.classify_buckets.filter(b => !injLabels.some(l => l.includes(b.toLowerCase()))),
  // GUI 가 실제로 쓰는 경로가 정본에 있는가
  gui_paths_written: [...new Set(out.gui_routes.map(r => r.path))],
  gui_paths_in_injection: [...new Set(out.gui_routes.map(r => r.path))].filter(p =>
    injLabels.some(l => l.includes(p.split('.')[0].toLowerCase()))),
  injection_label_count: injLabels.length,
  classifier_bucket_count: out.classify_buckets.length, gui_field_count: fields.length
};

console.log(JSON.stringify(out, null, 2));
