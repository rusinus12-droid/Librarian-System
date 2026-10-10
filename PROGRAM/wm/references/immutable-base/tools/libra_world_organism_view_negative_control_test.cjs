'use strict';
// Negative control: 세계가 인물을 보는 게이트가 실제로 결함을 잡는가.
// 소스 변이 대조군은 단독 실행한다(동시 실행 금지 — 소스 손상 사고 이력).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = 'libra_world_organism_view_test.cjs';
const targets = {
  F09: path.join(ROOT, 'src', 'parts', '09d-section-character-world-state.js'),
  F05K: path.join(ROOT, 'src', 'parts', '05k-narrative-turn-processing.js')
};
const backups = Object.fromEntries(Object.entries(targets).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));

const runGate = () => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], {
      encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000
    });
    return { ok: true, out: '' };
  } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const build = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };

const MUTATIONS = [
  {
    name: 'M1 09d normalizeWorldStateEntry 에서 presentEntities 제거',
    file: 'F09',
    from: '                ruleHighlights,\n                presentEntities,\n                notes\n            };',
    to: '                ruleHighlights,\n                notes\n            };'
  },
  {
    name: 'M2 describeWorldStateEntry 에서 인물 로그 줄 제거',
    file: 'F09',
    from: '            const cells = Array.isArray(entry?.presentEntities) ? entry.presentEntities.slice(0, 8) : [];\n            if (cells.length > 0) segments.push(`인물 ${cells.join(\', \')}`);',
    to: ''
  },
  {
    name: 'M3 번들 system 의 개체 관점 문장 제거 (원래 상태로)',
    file: 'F09',
    from: "'Treat the world as an organism whose cells are the characters: besides summarizing each side, state how the characters\\' movements change the world (collective movement, gathering, absence, or a shift that several characters share), and put that in world.summary.',",
    to: ''
  },
  {
    name: 'M4 상한 제거 (cap 을 9999 로)',
    file: 'F09',
    from: 'const WORLD_STATE_ENTITY_CAP = 16;',
    to: 'const WORLD_STATE_ENTITY_CAP = 9999;'
  },
  {
    name: 'M5 05k worldSnapshot 에서 presentEntities 키 자체를 제거 (실제 결함 형태)',
    file: 'F05K',
    from: "                // 세계는 세포(인물)들이 모인 개체다 — 개체가 자기 세포를 봐야 한다.\n                // 인물 상태 로그가 이미 여기 있으므로 재료는 갖춰져 있었다(실측: 이 축이 없어\n                // 인물이 바뀌어도 세계 상태 로그가 반응하지 않았다).\n                presentEntities: (() => {",
    to: "                __removedForMutation: (() => {"
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: broken(baseline.out) }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.name}]`);
  const file = targets[m.file];
  if (!backups[m.file].includes(m.from)) {
    results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' });
    console.log('  앵커 없음 — 건너뜀'); continue;
  }
  fs.writeFileSync(file, backups[m.file].replace(m.from, m.to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패(문법 깨짐)'); }
  let caught = false, b = [];
  if (applied) {
    const r = runGate();
    caught = !r.ok; b = caught ? broken(r.out) : [];
    console.log(`  → ${caught ? 'CAUGHT' : 'MISS'}`);
    if (caught) console.log('  깨진 단언:', b.join(', '));
  }
  fs.writeFileSync(file, backups[m.file], 'utf8');
  let restored = fs.readFileSync(file, 'utf8') === backups[m.file];
  try { build(); } catch { restored = false; }
  const after = runGate();
  console.log(`  원복: 파일일치=${restored} 재통과=${after.ok}`);
  results.push({ mutation: m.name, applied, caught, broken_assertions: b, restore_verified: restored && after.ok });
}

console.log('\n' + JSON.stringify({
  baseline_ok: true, total: results.length,
  caught: results.filter(r => r.caught).length,
  missed: results.filter(r => r.applied && !r.caught).length,
  restore_failures: results.filter(r => r.restore_verified === false).length,
  results
}, null, 2));
process.exit(0);
