'use strict';
// 변이 대조군: 로어 큐(03i) 조사 제거 게이트가 실제로 결함을 잡는가.
//
// 양성은 통과한다. 조사 제거를 끊으면 L2/L4 가 뒤집혀야 한다 (통과만 보는 게이트 방지).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tools', 'libra_lore_cue_entity_ref_normalization_test.cjs');
const SRC = path.join(ROOT, 'src', 'parts', '03i-character-lore-cue-index.js');

const MUTATIONS = [
  {
    name: 'M1: 폴백 조사 제거를 끊는다 → L2/L4 가 잡아야',
    from: 'const stripped = stripLoreCueKoParticle(chunk) || chunk;',
    to: 'const stripped = chunk;',
    expectFail: ['L2', 'L4']
  },
  {
    name: 'M2: push 경로 조사 제거를 끊는다 → (주 경로가 정본 이름을 쓰므로 정상 통과해야)',
    from: `            const push = (value) => {
                const v = stripLoreCueKoParticle(String(value || '').trim());
                if (v && raw.includes(v)) refs.push(v);
            };`,
    to: `            const push = (value) => {
                const v = String(value || '').trim();
                if (v && raw.includes(v)) refs.push(v);
            };`,
    expectFail: []   // 정상 통과가 기대 (push 는 정본 이름을 쓴다)
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
  const original = fs.readFileSync(SRC, 'utf8');
  const report = { mutations: [], baseline: null };

  const baseline = runGate();
  report.baseline = { ok: baseline.ok, failed: failedNames(baseline) };

  try {
    for (const m of MUTATIONS) {
      const norm = (t) => t.replace(/\r\n/g, '\n');
      const idx = norm(original).indexOf(norm(m.from));
      if (idx < 0) { report.mutations.push({ name: m.name, applied: false, note: 'anchor not found' }); continue; }
      const mutated = norm(original).replace(norm(m.from), norm(m.to));
      fs.writeFileSync(SRC, mutated);
      try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, stdio: 'ignore' }); } catch (_) {}
      const res = runGate();
      const fails = failedNames(res);
      const caught = m.expectFail.some(c => fails.includes(c));
      report.mutations.push({
        name: m.name, applied: true, gateOk: res.ok, failed: fails,
        expected: m.expectFail, caught, expectPass: m.expectFail.length === 0
      });
    }
  } finally {
    fs.writeFileSync(SRC, original);
    try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, stdio: 'ignore' }); } catch (_) {}
  }

  const restored = runGate();
  report.restored = { ok: restored.ok, failed: failedNames(restored) };
  const mustCatch = report.mutations.filter(m => m.applied && m.expected.length > 0);
  report.summary = {
    applied: report.mutations.filter(m => m.applied).length,
    mustCatch: mustCatch.length,
    caught: mustCatch.filter(m => m.caught).length,
    missed: mustCatch.filter(m => !m.caught).map(m => m.name),
    baselineOk: report.baseline.ok,
    restoredOk: report.restored.ok
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.summary.missed.length === 0 && report.restored.ok ? 0 : 1);
})();
