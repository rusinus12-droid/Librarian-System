'use strict';
// 변이 대조군: 그래프 회상 게이트 + 허브 경유 게이트가 실제로 결함을 잡는가.
//
// 각 요소를 제거했을 때 해당 주장이 FAIL 로 뒤집혀야 한다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tools', 'libra_hme_graph_recall_gate_test.cjs');
const SRC_10C = path.join(ROOT, 'src', 'parts', '10c-hme-associative-graph.js');
const SRC_10I = path.join(ROOT, 'src', 'parts', '10i-memory-public-recall-api.js');
const SRC_01H = path.join(ROOT, 'src', 'parts', '01h-projection-reset.js');

const n = (t) => t.replace(/\r\n/g, '\n');

const MUTATIONS = [
  {
    file: SRC_10I,
    name: 'M1: 게이트를 다시 좁힘 후(filtered) 기준으로 되돌린다 → G2 가 잡아야',
    from: 'if (minGraphRecallCandidates > 0 && preShortlistCount < minGraphRecallCandidates) {',
    to: 'if (minGraphRecallCandidates > 0 && filtered.length < minGraphRecallCandidates) {',
    expectFail: ['G2']
  },
  {
    file: SRC_10C,
    name: 'M2: 인물 노드 생성을 끊는다 → G1/G4 가 잡아야',
    from: 'const crossTypeNodes = buildHmeGraphCrossTypeNodes(lorebookEntries);',
    to: 'const crossTypeNodes = [];',
    expectFail: ['G1', 'G4']
  },
  {
    file: SRC_10C,
    name: 'M3: 허브를 frontier 에 넣지 않는다 → G4 가 잡아야',
    from: "(layer === 'meaning' || isHubNode)) {",
    to: "(layer === 'meaning' && !isHubNode)) {",
    expectFail: ['G4']
  },
  {
    // 10c preset 만 되돌리면 01h/14 의 마이그레이션이 2 를 복원해 효과가 없다(실측 M4 MISS).
    //   실제로 값을 1 로 고정하는 것은 *숨은 운영 기본값* 이다 — 그쪽을 변이한다.
    file: SRC_01H,
    name: 'M4: 숨은 운영 기본값 hmeGraphMaxHops 를 1 로 되돌린다 → G4 가 잡아야',
    from: '        hmeGraphMaxHops: 2,',
    to: '        hmeGraphMaxHops: 1,',
    expectFail: ['G4']
  }
];

const runGate = () => {
  try {
    const stdout = execFileSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const i = stdout.indexOf('{');
    return JSON.parse(stdout.slice(i, stdout.lastIndexOf('}') + 1));
  } catch (e) {
    const raw = String((e.stdout || '') + (e.stderr || ''));
    const i = raw.indexOf('{');
    if (i < 0) return { ok: false, assertions: [], parseError: raw.slice(0, 200) };
    try { return JSON.parse(raw.slice(i, raw.lastIndexOf('}') + 1)); }
    catch (_) { return { ok: false, assertions: [], parseError: raw.slice(0, 200) }; }
  }
};
const failedNames = (res) => (res.assertions || []).filter(a => !a.ok).map(a => String(a.name).split(':')[0]);

(async () => {
  const originals = new Map();
  for (const f of [SRC_10C, SRC_10I, SRC_01H]) originals.set(f, fs.readFileSync(f, 'utf8'));

  const report = { mutations: [], baseline: null };
  const baseline = runGate();
  report.baseline = { ok: baseline.ok, failed: failedNames(baseline) };

  try {
    for (const m of MUTATIONS) {
      const original = originals.get(m.file);
      if (!n(original).includes(n(m.from))) {
        report.mutations.push({ name: m.name, applied: false, note: 'anchor not found' });
        continue;
      }
      fs.writeFileSync(m.file, n(original).replace(n(m.from), n(m.to)));
      try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, stdio: 'ignore' }); } catch (_) {}
      const res = runGate();
      const fails = failedNames(res);
      const caught = m.expectFail.some(c => fails.includes(c));
      report.mutations.push({ name: m.name, applied: true, gateOk: res.ok, failed: fails, expected: m.expectFail, caught });
      fs.writeFileSync(m.file, original);
      try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, stdio: 'ignore' }); } catch (_) {}
    }
  } finally {
    for (const [f, orig] of originals) fs.writeFileSync(f, orig);
    try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, stdio: 'ignore' }); } catch (_) {}
  }

  const restored = runGate();
  report.restored = { ok: restored.ok, failed: failedNames(restored) };
  const applied = report.mutations.filter(m => m.applied);
  report.summary = {
    applied: applied.length,
    caught: applied.filter(m => m.caught).length,
    missed: applied.filter(m => !m.caught).map(m => m.name),
    baselineOk: report.baseline.ok,
    restoredOk: report.restored.ok
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.summary.missed.length === 0 && report.restored.ok && report.baseline.ok ? 0 : 1);
})();
