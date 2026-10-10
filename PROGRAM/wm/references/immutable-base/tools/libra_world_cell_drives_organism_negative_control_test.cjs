'use strict';
// Negative control: 세포→개체 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'parts', '09d-section-character-world-state.js');
const GATE = 'libra_world_cell_drives_organism_test.cjs';
const backup = fs.readFileSync(TARGET, 'utf8');

const runGate = () => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000 }); return { ok: true, out: '' }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const build = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };

const MUTATIONS = [
  {
    name: 'M1 개인/세계 구분 문장 제거 (실제 밟은 오작동으로 되돌린다)',
    from: "'A character\\'s own condition changing — injury, health, mood, emotion, personal gain or loss, a private decision, a single person moving or acting — is NOT a world change; that belongs to the character, not to the world. ",
    to: "'"
  },
  {
    name: 'M2 applyConsolidationResult 의 critical 기록 제거',
    from: '            if (worldChangedByCharacters) {',
    to: '            if (false) {'
  },
  {
    name: 'M3 criticalEntities 를 안 남긴다',
    from: '                    entities: criticalEntities,',
    to: '                    entities: [],'
  },
  {
    name: 'M4 false 도 기록하게 (오작동)',
    from: "            const worldChangedByCharacters = result?.charactersChangeWorld === true",
    to: "            const worldChangedByCharacters = result?.charactersChangeWorld !== undefined"
  },
  {
    name: 'M5 하드코딩 임계 도입 (인원 수로 판정 — 금지된 형태)',
    from: '            if (worldChangedByCharacters) {',
    to: '            if (worldChangedByCharacters || (Array.isArray(result?.criticalEntities) && result.criticalEntities.length >= 3)) {'
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
