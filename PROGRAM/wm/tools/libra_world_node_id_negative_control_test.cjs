'use strict';
// Negative control: node-ID 게이트가 실제로 결함을 잡는가.
// 각 변이를 주입해 그 게이트가 CAUGHT 하는지 보고, 원복 후 기준선을 확인한다.
// 소스 변이 대조군은 단독 실행한다(동시 실행 금지 — 소스 손상 사고 이력).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'parts', '08a-world-graph.js');
const GATE = 'libra_world_node_id_test.cjs';
const backup = fs.readFileSync(TARGET, 'utf8');

const runGate = () => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], {
      encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
const build = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });

// 게이트 실패 시 어느 단언이 깨졌는지 뽑는다
const brokenAssertions = (out) => {
  try {
    const j = JSON.parse(String(out).slice(String(out).indexOf('{')));
    return (j.assertions || []).filter(a => !a.ok).map(a => a.name);
  } catch { return ['(파싱 실패)']; }
};

const MUTATIONS = [
  {
    name: 'M1 노드 ID 를 Date.now() 로 되돌린다 (원래 결함)',
    from: '            const id = config.id || buildWorldNodeId();',
    to: '            const id = config.id || `node_${Date.now()}`;',
    expectBroken: ['node_ids_are_unique', 'nodes_survive_rapid_creation']
  },
  {
    name: 'M2 children 중복 방지 제거',
    from: '                if (parent && !parent.children.includes(id)) parent.children.push(id);',
    to: '                if (parent) parent.children.push(id);',
    expectBroken: []   // 고유 ID 가 보장되면 children 중복은 안 생긴다 — 이 변이는 MISS 가 정상
  },
  {
    name: 'M3 buildWorldNodeId 가 상수 ID 를 돌려준다',
    from: '                candidate = `node_${suffix}`;',
    to: '                candidate = \'node_fixed_constant\';',
    expectBroken: ['node_ids_are_unique', 'nodes_survive_rapid_creation']
  },
  {
    name: 'M4 config.id 존중을 제거 (항상 새로 생성)',
    from: '            const id = config.id || buildWorldNodeId();',
    to: '            const id = buildWorldNodeId();',
    expectBroken: ['explicit_id_respected']
  }
];

const results = [];

// 기준선 확인 (변이 전에 건강한가)
console.log('[baseline] 게이트 실행...');
const baseline = runGate();
console.log('[baseline] ok =', baseline.ok);

if (!baseline.ok) {
  console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: brokenAssertions(baseline.out) }, null, 2));
  process.exit(1);
}

for (const m of MUTATIONS) {
  console.log(`\n[${m.name}]`);
  if (!backup.includes(m.from)) {
    results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' });
    console.log('  앵커 없음 — 건너뜀');
    continue;
  }
  // 주입
  let mutated = backup.replace(m.from, m.to);
  fs.writeFileSync(TARGET, mutated, 'utf8');
  let applied = true;
  try {
    build();
  } catch (e) {
    applied = false;
    console.log('  빌드 실패(변이가 문법을 깼다):', String(e.message).slice(0, 120));
  }

  let caught = false, broken = [];
  if (applied) {
    const r = runGate();
    caught = !r.ok;
    broken = caught ? brokenAssertions(r.out) : [];
    console.log(`  게이트 통과=${r.ok} → ${caught ? 'CAUGHT' : 'MISS'}`);
    if (caught) console.log('  깨진 단언:', broken.join(', '));
    else console.log('  (이 변이는 관측값을 바꾸지 않는다)');
  }

  // 원복 + 검증
  fs.writeFileSync(TARGET, backup, 'utf8');
  let restoreOk = fs.readFileSync(TARGET, 'utf8') === backup;
  try { build(); } catch (e) { restoreOk = false; }
  const after = runGate();
  console.log(`  원복: 파일일치=${restoreOk} 게이트재통과=${after.ok}`);

  results.push({
    mutation: m.name,
    applied,
    caught,
    broken_assertions: broken,
    expected_broken: m.expectBroken,
    restore_verified: restoreOk && after.ok
  });
}

const summary = {
  baseline_ok: true,
  total: results.length,
  caught: results.filter(r => r.caught).length,
  missed: results.filter(r => r.applied && !r.caught).length,
  restore_failures: results.filter(r => r.restore_verified === false).length,
  results
};
console.log('\n' + JSON.stringify(summary, null, 2));
process.exit(0);
