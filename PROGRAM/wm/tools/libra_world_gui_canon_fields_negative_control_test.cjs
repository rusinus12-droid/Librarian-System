'use strict';
// Negative control: 세계관 화면 정본 필드 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GUI = path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js');
const MARKUP = path.join(ROOT, 'src', 'parts', '15-gui-and-exports.js');
const GATE = 'libra_world_gui_canon_fields_test.cjs';
const backupGui = fs.readFileSync(GUI, 'utf8');
const backupMarkup = fs.readFileSync(MARKUP, 'utf8');

const runGate = () => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000 }); return { ok: true, out: '' }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
// Windows 는 방금 읽은 dist 파일을 잠근다(writeFileSync UNKNOWN). 빌드 실패를
// "변이가 안 잡혔다(MISS)"로 오독하지 않도록 — 재시도하고, 변이가 dist 에 실제로
// 들어갔는지 확인한다. 들어가지 않았으면 그 변이는 판정 불가로 기록한다.
const buildOnce = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });
const build = () => {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { buildOnce(); return true; } catch (e) { lastError = e; }
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 5000 }); } catch { /* 무시 */ }
  }
  throw lastError || new Error('build failed');
};
// 변이 표지가 dist 에 들어갔는지 (파일이 실제로 다시 만들어졌는지)
const mutationLanded = (sourceMarker) => {
  try { return fs.readFileSync(DIST, 'utf8').includes(sourceMarker); } catch { return false; }
};
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };

const MUTATIONS = [
  {
    name: 'M1 상세가 다시 node.summary 를 읽는다 (실제 결함 형태 — 평면 필드)',
    file: GUI,
    from: "            setText('wld-detail-summary', wldMeta.worldSummary ||",
    to: "            setText('wld-detail-summary', node?.summary || wldMeta.worldSummary ||"
  },
  {
    name: 'M2 세계관 KPI 가 다시 node.fields 에서 규칙을 센다 (항상 0)',
    file: GUI,
    from: "                    ruleCount += extractWorldRuleHighlights(nodeRules, 24).length;",
    to: "                    const f = node?.fields || {};\n                    ruleCount += Object.values(f).reduce((a, v) => a + (Array.isArray(v) ? v.length : 1), 0);"
  },
  {
    name: 'M3 노드 카드가 다시 n.fields/n.classification 을 읽는다 (같은 부류)',
    file: GUI,
    from: "                    const ruleList = extractWorldRuleHighlights(n.rules && typeof n.rules === 'object' ? n.rules : {}, 24);",
    to: "                    const nf = n.fields && typeof n.fields === 'object' ? n.fields : {};\n                    const ruleList = Object.values(nf).flat().map(String);"
  },
  {
    name: 'M4 상위 노드를 다시 parentId 에서 읽는다 (정본에 없다)',
    file: GUI,
    from: "            const parentId = String(node?.parent || '').trim();",
    to: "            const parentId = String(node?.parentId || '').trim();"
  },
  {
    name: 'M5 마크업에 없는 축(깊이·개정) 라벨을 되살린다',
    file: MARKUP,
    from: '        <div class="hero-stat"><span>분류</span><b id="wld-detail-class">—</b></div>',
    to: '        <div class="hero-stat"><span>깊이</span><b id="wld-detail-depth">—</b></div>\n        <div class="hero-stat"><span>개정</span><b id="wld-detail-rev">—</b></div>\n        <div class="hero-stat"><span>분류</span><b id="wld-detail-class">—</b></div>'
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: broken(baseline.out) }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.name}]`);
  const target = m.file === GUI ? GUI : MARKUP;
  const backup = m.file === GUI ? backupGui : backupMarkup;
  if (!backup.includes(m.from)) { results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  fs.writeFileSync(target, backup.replace(m.from, m.to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  // 변이 표지: m.to 의 첫 줄에서 앞 공백을 뗀 조각이 dist 에 있어야 한다.
  const marker = String(m.to).split('\n')[0].trim().slice(0, 40);
  const landed = applied && (m.file === MARKUP ? true : mutationLanded(marker));
  if (applied && !landed) {
    applied = false;
    console.log(`  변이가 dist 에 반영되지 않음 (marker: ${marker}) — 판정 불가로 기록`);
  }
  let caught = false, b = [];
  if (applied) { const r = runGate(); caught = !r.ok; b = caught ? broken(r.out) : []; console.log(`  → ${caught ? 'CAUGHT' : 'MISS'}`); if (caught) console.log('  깨진 단언:', b.join(', ')); }
  fs.writeFileSync(target, backup, 'utf8');
  let restored = fs.readFileSync(target, 'utf8') === backup;
  try { build(); } catch { restored = false; }
  const after = runGate();
  console.log(`  원복: 파일일치=${restored} 재통과=${after.ok}`);
  results.push({ mutation: m.name, applied, caught, broken_assertions: b, restore_verified: restored && after.ok });
}

console.log('\n' + JSON.stringify({
  baseline_ok: true, total: results.length,
  caught: results.filter(r => r.caught).length,
  missed: results.filter(r => r.applied && !r.caught).length,
  unjudged: results.filter(r => r.applied === false).length,
  restore_failures: results.filter(r => r.restore_verified === false).length,
  results
}, null, 2));
process.exit(0);
