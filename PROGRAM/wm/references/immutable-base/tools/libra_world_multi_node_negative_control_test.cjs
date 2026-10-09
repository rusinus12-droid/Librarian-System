'use strict';
// Negative control: 멀티노드 게이트가 실제로 결함을 잡는가.
// 소스 변이 대조군은 단독 실행한다(동시 실행 금지 — 소스 손상 사고 이력).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'parts', '08a-world-graph.js');
const GATE = 'libra_world_multi_node_test.cjs';
const backup = fs.readFileSync(TARGET, 'utf8');

const runGate = () => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000 }); return { ok: true, out: '' }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const build = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };

const MUTATIONS = [
  { name: 'M1 setActiveNodes 를 1곳만 유지하게 (단일 회귀)', from: '            profile.activeNodes = normalizeActiveNodeIds(ids);', to: '            profile.activeNodes = normalizeActiveNodeIds(ids).slice(0, 1);' },
  { name: 'M2 syncActiveNodeFlags 가 activeNodes 를 무시', from: '            const activeSet = new Set([...profile.activePath, ...(profile.activeNodes || [])]);', to: '            const activeSet = new Set([...profile.activePath]);' },
  { name: 'M3 위치별 블록 대신 단일 헤딩만 (multiLocation 무력화)', from: '            const multiLocation = activeNodeIdsForPrompt.length > 1;', to: '            const multiLocation = false;' },
  { name: 'M4 직렬화에서 activeNodes 제외', from: "                activeNodes: Array.isArray(profile.activeNodes) ? profile.activeNodes.map(value => String(value || '').trim()).filter(Boolean).slice(0, WORLD_ACTIVE_NODE_CAP) : [],", to: '' },
  { name: 'M5 findNodeByName 이 부분 일치도 허용 (발명)', from: "                if (String(node?.name || '').trim() === target) return node;", to: "                if (String(node?.name || '').trim().includes(target)) return node;" },
  { name: 'M6 상한 제거 (cap 9999)', from: 'const WORLD_ACTIVE_NODE_CAP = 16;', to: 'const WORLD_ACTIVE_NODE_CAP = 9999;' }
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
