'use strict';
// 변이 대조군: 신규 게이트가 실제로 결함을 잡는가.
//
// 양성(현재)은 통과한다. 각 요소를 *제거* 했을 때 해당 주장이 FAIL 로 뒤집히는지 확인한다.
// 통과만 보는 게이트는 아무것도 안 보는 것과 같다 — 사용자 지적 계열.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tools', 'libra_hme_graph_node_extension_test.cjs');
const SRC10C = path.join(ROOT, 'src', 'parts', '10c-hme-associative-graph.js');
// 8단계 교훈: 원복 실패를 조용히 넘기면 소스가 깨진 채 **커밋된다**.
//   실제로 이 하네스가 그렇게 해서 HME_GRAPH_INDEX_VERSION=2 가 소스에 남았고,
//   커밋된 dist 에는 옛 값(3)이 남아 검증을 통과했다 —
//   "테스트한 산출물"과 "커밋한 소스"가 갈라졌다.
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', '10c_mutation_backup.js');
// 원복은 재시도 + 해시 검증한다. Windows 파일 잠금으로 한 번 실패하면 소스가
// 변이된 채 남고, 그 상태가 커밋된다(실제로 겪었다).
const restoreSource = (original) => {
  const want = sha256(original);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.writeFileSync(SRC10C, original);
      if (sha256(fs.readFileSync(SRC10C, 'utf8')) === want) return true;
    } catch (_) { /* 잠금 — 재시도 */ }
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeout: 4000 }); } catch (_) {}
  }
  try {
    fs.writeFileSync(SRC10C, fs.readFileSync(BACKUP, 'utf8'));
    return sha256(fs.readFileSync(SRC10C, 'utf8')) === want;
  } catch (_) { return false; }
};

const MUTATIONS = [
  {
    name: 'M1: 인물 노드 빌더 제거 → C1/C9 가 잡아야',
    from: 'const crossTypeNodes = buildHmeGraphCrossTypeNodes(lorebookEntries);',
    to: 'const crossTypeNodes = [];',
    expectFail: ['C1', 'C9']
  },
  {
    name: 'M2: 로어 노드 빌더 제거 → C2/C5 가 잡아야',
    from: 'cueLoreNodes = buildHmeGraphCueLoreNodes(lorebookEntries);',
    to: 'cueLoreNodes = [];',
    expectFail: ['C2', 'C5']
  },
  {
    name: 'M3: 크로스타입 엣지 제거 → C4/C5 가 잡아야',
    from: 'const crossEdges = buildHmeGraphCrossTypeEdges(nodes, {',
    to: 'const crossEdges = [].map(() => {}, {',
    expectFail: ['C4', 'C5']
  },
  {
    name: 'M4: version 을 2 로 되돌림 → C7/C8 이 잡아야',
    from: 'const HME_GRAPH_INDEX_VERSION = 4;',
    to: 'const HME_GRAPH_INDEX_VERSION = 2;',
    expectFail: ['C7']
  },
  {
    name: 'M5: 예산 reserve 제거 → C6 이 잡아야',
    from: 'const entityReserve = Math.max(32, Math.floor(maxNodes * 0.08));',
    to: 'const entityReserve = 0;',
    expectFail: ['C6']
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
  const original = fs.readFileSync(SRC10C, 'utf8');
  fs.writeFileSync(BACKUP, original);
  const report = { mutations: [], baseline: null };

  // 기준선 (현재 소스)
  const baseline = runGate();
  report.baseline = { ok: baseline.ok, failed: failedNames(baseline) };

  try {
    for (const m of MUTATIONS) {
      if (!original.includes(m.from)) {
        report.mutations.push({ name: m.name, applied: false, note: 'anchor not found' });
        continue;
      }
      const mutated = original.replace(m.from, m.to);
      fs.writeFileSync(SRC10C, mutated);
      try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, stdio: 'ignore' }); } catch (_) {}
      const res = runGate();
      const fails = failedNames(res);
      const caught = m.expectFail.some(c => fails.includes(c));
      report.mutations.push({
        name: m.name,
        applied: true,
        gateOk: res.ok,
        failed: fails,
        expected: m.expectFail,
        caught
      });
    }
  } finally {
    // 원복 실패를 조용히 넘기지 않는다 — 소스가 변이된 채 남으면 그게 커밋된다.
    report.restore_ok = restoreSource(original);
    if (!report.restore_ok) {
      report.restore_error = 'SOURCE RESTORE FAILED — 원본: ' + BACKUP;
      console.error('[치명] 소스 원복에 실패했다. 즉시 확인하라: ' + SRC10C + ' ← ' + BACKUP);
    }
    try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, stdio: 'ignore' }); } catch (_) {}
  }

  // 복원 확인
  const restored = runGate();
  report.restored = { ok: restored.ok, failed: failedNames(restored) };
  const caughtCount = report.mutations.filter(m => m.caught).length;
  report.summary = {
    applied: report.mutations.filter(m => m.applied).length,
    caught: caughtCount,
    missed: report.mutations.filter(m => m.applied && !m.caught).map(m => m.name)
  };
  console.log(JSON.stringify(report, null, 2));
  // 원복 실패는 미탐보다 위험하다(깨진 소스가 커밋된다) — exit code 로 알린다.
  if (report.restore_ok === false) process.exit(3);
})();
