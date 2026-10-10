'use strict';
// Negative control for `libra_drift_stale_recall_test.cjs`
//
//   M1 동기 판정을 없앤다 (원래 결함으로 회귀 — 창이 다시 열린다)
//   M2 리롤까지 제외 대상에 넣는다 (과잉 제거 — 살아있는 variant 기억이 사라진다)
//   M3 동기 판정이 **영속**하게 만든다 (사용자 확인이 무의미해진다)
//   M4 필터가 집합을 안 쓴다 (만들어 놓고 방치)
//
// ★★ 원복은 메모리 백업만(`git checkout` 금지). 대조군이 도는 동안 **소스 변경·커밋 금지**.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  '01f': path.join(ROOT, 'src/parts/01f-lore-consolidation.js'),
  '13c': path.join(ROOT, 'src/parts/13c-before-request-injection.js')
};
const TARGET = FILES['13c'];
const fileOf = (m) => FILES[m.file || '13c'];
const GATE = path.join(ROOT, 'tools/libra_drift_stale_recall_test.cjs');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const BACKUP = new Map(Object.values(FILES).map(f => [f, fs.readFileSync(f)]));
const HASH = new Map(Object.values(FILES).map(f => [f, sha(f)]));
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
  for (const [f, buf] of BACKUP) {
    if (sha(f) === HASH.get(f)) continue;
    let done = false;
    for (let i = 0; i < 6 && !done; i += 1) {
      try { fs.writeFileSync(f, buf); done = sha(f) === HASH.get(f); } catch (_) {}
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
  // ★ 앵커는 **한 줄**로 짧게 잡는다 — 여러 줄 앵커는 CRLF/LF 차이로 안 맞는다(반복해 밟은 함정).
  { id: 'M1', file: '01f', why: '드리프트 제외 집합을 항상 비운다 (원래 결함으로 회귀)',
    find: /                return \{ scopeKey: key, turns: new Set\(turns\), detectedAt: Date\.now\(\), reason: 'rollback_drift' \};/,
    replace: "                return null;" },
  { id: 'M2', file: '01f', why: '리롤까지 제외 대상에 넣는다 (과잉 제거)',
    find: /                const turns = \(drift\.rolledBack \|\| \[\]\)\.map/,
    replace: "                const turns = [...(drift.rolledBack || []), ...(drift.rerolled || [])].map" },
  { id: 'M3', file: '01f', why: '제외 집합을 영속시킨다 (사용자 확인이 무의미해진다)',
    find: /                return \{ scopeKey: key, turns: new Set\(turns\), detectedAt: Date\.now\(\), reason: 'rollback_drift' \};/,
    replace: "                try { void observe(key, livePairs); } catch (_) {}\n                return { scopeKey: key, turns: new Set(turns), detectedAt: Date.now(), reason: 'rollback_drift' };" },
  { id: 'M4', file: '01f', why: '적용 함수가 아무것도 안 뺀다 (만들어 놓고 방치)',
    find: /                if \(!turn \|\| !ex\.turns\.has\(turn\)\) return true;/,
    replace: '                if (true || !turn || !ex.turns.has(turn)) return true;' }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok, `(${(baseline.assertions || []).filter(a => a.ok).length}/${(baseline.assertions || []).length})`);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy' }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.id}] ${m.why}`);
  const f = fileOf(m);
  let before = fs.readFileSync(f, 'utf8');
  // ★ 이 파일은 CRLF 다 — LF 앵커는 매칭이 안 된다(실측 M1·M4 앵커 없음).
  //   파일에 맞춰 앵커/치환을 정규화한다.
  let find = m.find, replace = m.replace;
  if (!find.test(before)) {
    const crlf = (re) => new RegExp(re.source.replace(/\n/g, '\r\n'), re.flags);
    const crlfFind = crlf(m.find);
    if (crlfFind.test(before)) { find = crlfFind; replace = m.replace.replace(/\n/g, '\r\n'); }
  }
  if (!find.test(before)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  const after = before.replace(find, replace);
  if (after === before) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'no_change' }); console.log('  치환 무효'); continue; }
  if (!writeRetry(f, after)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'write_locked' }); console.log('  쓰기 잠금'); continue; }

  let applied = build();
  if (applied) {
    const srcNow = norm(fs.readFileSync(f, 'utf8'));
    const okSrc = !srcNow.includes(norm(find.source)) && srcNow.includes(norm(replace));
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
