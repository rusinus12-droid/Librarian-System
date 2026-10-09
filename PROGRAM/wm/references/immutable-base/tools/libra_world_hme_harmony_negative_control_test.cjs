'use strict';
// Negative control: HME 조화 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'parts', '10c-hme-associative-graph.js');
const GATE = 'libra_world_hme_harmony_test.cjs';
const backup = fs.readFileSync(TARGET, 'utf8');

const runGate = () => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000 }); return { ok: true, out: '' }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const build = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };

const MUTATIONS = [
  {
    name: 'M1 정본 리더 제거 (기억 경유로 회귀 — 5단계가 만든 결함)',
    from: "                ...(__canon?.ruleHighlights || []),",
    to: ''
  },
  {
    name: 'M2 서명에 정본을 안 쓴다',
    from: "                ...(__canon?.signature || []),",
    to: ''
  },
  {
    name: 'M3 HME 가 세계를 쓰게 한다 (단방향 위반)',
    from: "                const profile = HierarchicalWorldManager.getProfile?.();",
    to: "                const profile = HierarchicalWorldManager.getProfile?.();\n                try { HierarchicalWorldManager.updateNode(profile?.rootId, { meta: { touchedByHme: true } }); } catch (_) {}"
  },
  {
    name: 'M4 세계를 HME 노드 타입으로 추가 (보류한 A안)',
    from: "        const HME_GRAPH_INDEX_VERSION = 4;",
    to: "        const HME_GRAPH_INDEX_VERSION = 4;\n        const __forbiddenWorldNodeType = 'world';\n        const __gWorld = null;  // g_world_"
  },
  {
    name: 'M5 레거시(기억 경유) 폴백 제거 — 하위 호환 파괴',
    from: "                ...(Array.isArray(payloadWorld?.ruleHighlights) ? payloadWorld.ruleHighlights : []),",
    to: ''
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: broken(baseline.out) }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.name}]`);
  if (!backup.includes(m.from)) { results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  fs.writeFileSync(TARGET, backup.replace(m.from, m.to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  let caught = false, b = [];
  if (applied) { const r = runGate(); caught = !r.ok; b = caught ? broken(r.out) : []; console.log(`  → ${caught ? 'CAUGHT' : 'MISS'}`); if (caught) console.log('  깨진 단언:', b.join(', ')); }
  fs.writeFileSync(TARGET, backup, 'utf8');
  let restored = fs.readFileSync(TARGET, 'utf8') === backup;
  try { build(); } catch { restored = false; }
  const after = runGate();
  console.log(`  원복: 파일일치=${restored} 재통과=${after.ok}`);
  results.push({ mutation: m.name, applied, caught, broken_assertions: b, restore_verified: restored && after.ok });
}

console.log('\n' + JSON.stringify({ baseline_ok: true, total: results.length, caught: results.filter(r => r.caught).length, missed: results.filter(r => r.applied && !r.caught).length, restore_failures: results.filter(r => r.restore_verified === false).length, results }, null, 2));
process.exit(0);
