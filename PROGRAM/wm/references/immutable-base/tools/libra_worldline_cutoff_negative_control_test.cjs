'use strict';
// Negative control for `libra_worldline_cutoff_test.cjs`
//
//   M1 경계를 저장하지 않는다 (원래 결함으로 회귀 — cutoffTurn=null)
//   M2 단일 술어에서 경계 판정을 뺀다 (노드 없으면 못 거른다 — 실측 결함으로 회귀)
//   M3 단일 술어에서 노드 판정을 뺀다 (리롤을 롤백으로 오판)
//   M4 effectiveCutoff 의 fail-open 을 깬다 (경계 없을 때 오작동)
//   M5 기억 필터가 경계를 안 본다 (계층 통합 회귀)
//   M6 엔티티 필터가 경계를 안 본다 (계층 통합 회귀)
//
// ★★ 원복은 메모리 백업만. `git checkout` 금지(미커밋 작업이 사라진 사고가 있었다).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src/parts/01f-lore-consolidation.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = path.join(ROOT, 'tools/libra_worldline_cutoff_test.cjs');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const BACKUP = fs.readFileSync(TARGET);
const HASH = sha(TARGET);
const norm = (t) => String(t).replace(/\r\n/g, '\n');

const writeRetry = (text) => {
  for (let i = 0; i < 8; i += 1) {
    try { fs.writeFileSync(TARGET, text); if (sha(TARGET) === crypto.createHash('sha256').update(text).digest('hex')) return true; } catch (_) {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 4000 }); } catch (_) {}
  }
  return false;
};
const restore = () => {
  if (sha(TARGET) === HASH) return true;
  for (let i = 0; i < 6; i += 1) {
    try { fs.writeFileSync(TARGET, BACKUP); if (sha(TARGET) === HASH) return true; } catch (_) {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { timeout: 4000 }); } catch (_) {}
  }
  return false;
};
const runGate = () => {
  try {
    const out = execFileSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', timeout: 240000, env: { ...process.env, NODE_PATH: '' } });
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const i = out.indexOf('{');
    if (i >= 0) { try { return JSON.parse(out.slice(i)); } catch (_) {} }
    return { ok: false, __crash: out.slice(0, 240) };
  }
};
const build = () => {
  for (let i = 0; i < 4; i += 1) {
    try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, timeout: 400000, stdio: 'pipe' }); return true; }
    catch (_) { try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 4000 }); } catch (_) {} }
  }
  return false;
};

const MUTATIONS = [
  { id: 'M1', why: '경계를 저장하지 않는다 (원래 결함으로 회귀)',
    find: /cutoffTurn: maxPair > 0 \? maxPair : null/, replace: 'cutoffTurn: null' },
  { id: 'M2', why: '단일 술어에서 경계 판정을 뺀다 (노드 없으면 못 거른다)',
    find: /            return Number\.isFinite\(cutoff\) && value > cutoff;/, replace: '            return false;' },
  { id: 'M3', why: '단일 술어에서 노드 판정을 뺀다 (리롤을 못 살린다)',
    find: /            if \(bag\.superseded instanceof Set && bag\.superseded\.has\(value\)\) return true;/,
    replace: '            if (false && bag.superseded instanceof Set && bag.superseded.has(value)) return true;' },
  { id: 'M4', why: 'effectiveCutoff 의 fail-open 을 깬다 (경계 없을 때 오작동)',
    find: /            return \(Number\.isFinite\(value\) && value > 0\) \? value : Number\.POSITIVE_INFINITY;/,
    replace: '            return value;' },
  // ★ 앵커는 **한 줄**로 짧게 잡는다 — 여러 줄 앵커는 CRLF/LF 차이로 `anchor_not_found` 가 났다(실측).
  { id: 'M5', why: '기억 필터가 경계를 안 본다 (계층 통합 회귀)',
    find: /                if \(isSupersededTurn\(turn, index\)\) \{/,
    replace: '                if (turn && superseded.has(turn)) {' },
  { id: 'M6', why: '엔티티 필터가 경계를 안 본다 (계층 통합 회귀)',
    find: /            if \(\(!superseded \|\| superseded\.size === 0\) && !Number\.isFinite\(index\.cutoff\)\) \{/,
    replace: '            if (!superseded || superseded.size === 0) {' }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok, `(${(baseline.assertions || []).filter(a => a.ok).length}/${(baseline.assertions || []).length})`);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy' }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.id}] ${m.why}`);
  const before = fs.readFileSync(TARGET, 'utf8');
  if (!m.find.test(before)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  const after = before.replace(m.find, m.replace);
  if (after === before) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'no_change' }); console.log('  치환 무효'); continue; }
  if (!writeRetry(after)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'write_locked' }); console.log('  쓰기 잠금'); continue; }

  let applied = build();
  if (applied) {
    const srcNow = norm(fs.readFileSync(TARGET, 'utf8'));
    const okSrc = !srcNow.includes(norm(m.find.source)) && srcNow.includes(norm(m.replace));
    if (!okSrc) { applied = false; console.log('  변이 미반영 (src) — 판정 불가'); }
  } else { console.log('  빌드 실패'); }

  let caught = false, failures = [];
  if (applied) {
    const res = runGate();
    caught = res.ok === false;
    failures = (res.assertions || []).filter(a => !a.ok).map(a => a.name);
    console.log(`  → ${caught ? 'CAUGHT' : 'MISS'}`);
    if (caught) console.log('  깨진 단언:', failures.slice(0, 4).join(', '));
    if (res.__crash) console.log('  crash:', res.__crash);
  }
  const restored = restore();
  const rebuilt = build();
  const afterRun = runGate();
  console.log(`  원복: 파일일치=${restored} 재통과=${afterRun.ok}`);
  results.push({ mutation: `${m.id} ${m.why}`, applied, caught, failures, restore_verified: restored && rebuilt && afterRun.ok });
}

const caught = results.filter(r => r.caught).length;
const missed = results.filter(r => r.applied === true && !r.caught).length;
const unjudged = results.filter(r => r.applied === false).length;
const restoreFailures = results.filter(r => r.restore_verified === false).length;
console.log('\n' + JSON.stringify({ baseline_ok: true, total: results.length, caught, missed, unjudged, restore_failures: restoreFailures, results }, null, 2));
if (restoreFailures) process.exit(3);
process.exit(caught === results.length ? 0 : 1);
