'use strict';
// Negative control for `libra_world_fork_inheritance_test.cjs`
//
//   M1 세계 그래프 처리를 통째로 뺀다 (원래 결함으로 회귀 — 통째 상속)
//   M2 노드 턴을 `meta.created` 대신 규칙 턴과 섞는다 (포크 직전 노드까지 제거 — 과잉 제거)
//   M3 규칙별 판정을 뺀다 (포크 이후 규칙이 남는다)
//   M4 턴을 모르는 노드·규칙까지 버린다 (정보 손실)
//   M5 `reduce` 를 `filter` 로 되돌린다 (원소 변환 불가 — 수리가 조용히 무효)
//
// ★★ 원복은 메모리 백업만. `git checkout` 금지. **대조군이 도는 동안 커밋 금지**
//    (이 리포에서 변이 상태가 커밋된 사고가 있었다).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src/parts/01f-lore-consolidation.js');
const TARGET_15A = path.join(ROOT, 'src/parts/15a-gui-session-data.js');
const fileOf = (m) => (m.file === '15a' ? TARGET_15A : TARGET);
const GATE = path.join(ROOT, 'tools/libra_world_fork_inheritance_test.cjs');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const BACKUP = fs.readFileSync(TARGET);
const HASH = sha(TARGET);
const BACKUP_15A = fs.readFileSync(TARGET_15A);
const HASH_15A = sha(TARGET_15A);
const norm = (t) => String(t).replace(/\r\n/g, '\n');

const writeRetry = (f, text) => {
  for (let i = 0; i < 8; i += 1) {
    try { fs.writeFileSync(f, text); if (sha(f) === crypto.createHash('sha256').update(text).digest('hex')) return true; } catch (_) {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 4000 }); } catch (_) {}
  }
  return false;
};
const restore = () => {
  let ok = true;
  for (const [f, buf, h] of [[TARGET, BACKUP, HASH], [TARGET_15A, BACKUP_15A, HASH_15A]]) {
    if (sha(f) === h) continue;
    let done = false;
    for (let i = 0; i < 6 && !done; i += 1) {
      try { fs.writeFileSync(f, buf); done = sha(f) === h; } catch (_) {}
      if (!done) { try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { timeout: 4000 }); } catch (_) {} }
    }
    if (!done) { ok = false; console.log('  원복 실패', path.basename(f)); }
  }
  return ok;
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
  { id: 'M1', why: '세계 그래프 처리를 통째로 뺀다 (원래 결함으로 회귀)',
    find: /                    if \(String\(entry\?\.comment \|\| ''\)\.trim\(\) === 'lmai_world_graph'\) \{/,
    replace: "                    if (false && String(entry?.comment || '').trim() === 'lmai_world_graph') {" },
  { id: 'M2', why: '노드 턴을 규칙 턴과 섞는다 (포크 직전 노드까지 제거 — 과잉 제거)',
    find: /            if \(created > 0\) return created;/,
    replace: "            const promoted = source?.rules?.ruleMeta?.promotedRules; let max = created;\n            if (promoted && typeof promoted === 'object') { for (const v of Object.values(promoted)) { const t = Number(v) || 0; if (t > max) max = t; } }\n            if (max > 0) return max;" },
  { id: 'M3', why: '규칙별 판정을 뺀다 (포크 이후 규칙이 남는다)',
    find: /                    if \(sourceTurn && sourceTurn > limit\) \{ trimmed \+= 1; continue; \}/,
    replace: '                    if (false && sourceTurn && sourceTurn > limit) { trimmed += 1; continue; }' },
  { id: 'M4', why: '턴을 모르는 노드까지 버린다 (정보 손실)',
    find: /                if \(!turn \|\| turn <= limit\) \{ nodes\.push\(node\); continue; \}/,
    replace: '                if (turn && turn <= limit) { nodes.push(node); continue; }' },
  { id: 'M5', why: 'reduce 를 filter 로 되돌린다 (원소 변환 불가 — 수리가 조용히 무효)',
    find: /            const kept = list\.reduce\(\(out, entry\) => \{/,
    replace: '            const kept = list.filter(entry => {' },
  { id: 'M6', why: '보정의 출처 턴을 안 본다 (포크 이후 보정이 넘어간다)',
    find: /                const correctionTurn = Number\(node\?\.meta\?\.worldCorrectionTurn/,
    replace: '                const correctionTurn = 0 && Number(node?.meta?.worldCorrectionTurn' },
  { id: 'M7', why: '교정 쓸 때 턴 도장을 안 남긴다 (원래 결함으로 회귀)',
    file: '15a',
    find: /            if \(correctionTurn > 0\) \{/,
    replace: '            if (false && correctionTurn > 0) {' }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok, `(${(baseline.assertions || []).filter(a => a.ok).length}/${(baseline.assertions || []).length})`);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy' }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.id}] ${m.why}`);
  const f = fileOf(m);
  const before = fs.readFileSync(f, 'utf8');
  if (!m.find.test(before)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  const after = before.replace(m.find, m.replace);
  if (after === before) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'no_change' }); console.log('  치환 무효'); continue; }
  if (!writeRetry(f, after)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'write_locked' }); console.log('  쓰기 잠금'); continue; }

  let applied = build();
  if (applied) {
    const srcNow = norm(fs.readFileSync(f, 'utf8'));
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
