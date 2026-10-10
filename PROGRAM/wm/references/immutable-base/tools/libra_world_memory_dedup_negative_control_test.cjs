'use strict';
// Negative control: 중복 제거 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'parts', '05e-canonical-turn-memory-helpers.js');
const GATE = 'libra_world_memory_dedup_test.cjs';
const backup = fs.readFileSync(TARGET, 'utf8');

const runGate = () => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000 }); return { ok: true, out: '' }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const build = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };

const MUTATIONS = [
  {
    name: 'M1 존재(exists) 값을 다시 복사한다 (실제 결함 형태)',
    from: '                ruleHash: stableHash(JSON.stringify({',
    to: '                exists: safeClone(normalizedRules.exists || {}),\n                ruleHash: stableHash(JSON.stringify({'
  },
  {
    name: 'M2 ruleHighlights 를 다시 복사한다',
    from: '                correctionHash: stableHash(String(userWorldCorrection || \'\').trim())',
    to: '                correctionHash: stableHash(String(userWorldCorrection || \'\').trim()),\n                ruleHighlights: meaningfulHighlights'
  },
  {
    name: 'M3 지문(ruleHash) 제거 — 변경 감지가 죽는다',
    from: '                ruleHash: stableHash(JSON.stringify({',
    to: '                __ruleHashRemoved: stableHash(JSON.stringify({'
  },
  {
    name: 'M4 해시 함수가 저장 지문을 무시 (레거시 재계산만)',
    from: "        const stored = String(payload?.world?.ruleHash || payload?.worldRuleHash || '').trim();\n        if (stored) return stored;",
    to: '        const stored = \'\';'
  },
  {
    name: 'M5 activePathHash 제거',
    from: '                activePathHash: stableHash(JSON.stringify(meaningfulActivePath)),',
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
