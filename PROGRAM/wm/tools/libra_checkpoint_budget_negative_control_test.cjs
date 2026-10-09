'use strict';
// Negative control for the checkpoint-budget contract in `libra_remaining_hardening_test.cjs`
//
//   M1 예산을 30s 로 되돌린다 (원래 결함으로 회귀 — 턴 60+ 에서 정착 직전에 끊긴다)
//   M2 예산을 제품 상한(240s) **위**로 올린다 (계약이 뒤집힌다)
//   M3 `unmet` 수집을 없앤다 (타임아웃 원인이 다시 판정 불가가 된다)
//   M4 `summarizeCheckpoint` 가 `unmet` 을 안 싣게 한다 (게이트가 원인을 못 본다)
//
// ※ 이 게이트는 하네스 **소스**를 직접 읽는다(dist 아님) — 리빌드 불필요.
//   대신 변이가 게이트에 도달하는지는 게이트 자신이 파싱으로 확인한다(정규식 실패 = 0 → 실패).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'tools/libra_97_test_harness.cjs');
const GATE = path.join(ROOT, 'tools/libra_remaining_hardening_test.cjs');
const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const MUTATIONS = [
  { id: 'M1', why: '예산을 30s 로 되돌린다 (원래 결함으로 회귀)',
    find: /process\.env\.LIBRA_CHECKPOINT_WAIT_MS \|\| 90000\) \|\| 90000\)/,
    replace: 'process.env.LIBRA_CHECKPOINT_WAIT_MS || 30000) || 30000)' },
  { id: 'M2', why: '예산을 제품 상한 위로 올린다 (계약 뒤집힘)',
    find: /process\.env\.LIBRA_CHECKPOINT_WAIT_MS \|\| 90000\) \|\| 90000\)/,
    replace: 'process.env.LIBRA_CHECKPOINT_WAIT_MS || 300000) || 300000)' },
  { id: 'M3', why: '`unmet` 수집을 없앤다 (원인이 다시 판정 불가)',
    find: /  if \(!\(Number\(ledger\.byStatus\?\.committed \|\| 0\) >= turnCount\)\) unmet\.push\(`committed \$\{Number\(ledger\.byStatus\?\.committed \|\| 0\)\}<\$\{turnCount\}`\);/,
    replace: '  void turnCount;' },
  { id: 'M4', why: '결과가 `unmet` 을 안 싣게 한다',
    find: /unmet: Array\.isArray\(drain\.unmet\) \? drain\.unmet : \[\] \}/,
    replace: 'unmet: [] }' }
];

const BACKUP = fs.readFileSync(TARGET);
const HASH = sha(TARGET);

const restore = () => {
  if (sha(TARGET) === HASH) return true;
  for (let i = 0; i < 6; i += 1) {
    try { fs.writeFileSync(TARGET, BACKUP); if (sha(TARGET) === HASH) return true; } catch (_) {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { timeout: 3000 }); } catch (_) {}
  }
  return false;
};

//   ★ 이 게이트는 `assertCheck` 에서 **예외를 던진다**(첫 실패 지점에서 멈춘다).
//     그래서 실패 결과 JSON 은 **stderr** 로 나간다(stdout 아님). 양쪽을 보고 `checks[]` 로 판정한다.
const parseGateOutput = (text) => {
  const i = String(text || '').indexOf('{');
  if (i < 0) return null;
  try {
    const j = JSON.parse(String(text).slice(i, String(text).lastIndexOf('}') + 1));
    const bad = (j.checks || []).filter(c => c.ok === false).map(c => c.name);
    return { ok: j.ok === true && bad.length === 0, failed: bad, checks: (j.checks || []).length };
  } catch (_) { return null; }
};
const runGate = () => {
  try {
    const out = execFileSync(process.execPath, [GATE], { timeout: 120000, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
    const r = parseGateOutput(out);
    return r || { ok: false, failed: ['(게이트 출력 파싱 실패)'], crashed: true };
  } catch (e) {
    const r = parseGateOutput(e && e.stdout) || parseGateOutput(e && e.stderr);
    if (r) return r;
    return { ok: false, failed: ['(게이트 실행 실패)'], crashed: true };
  }
};

const writeRetry = (text) => {
  for (let i = 0; i < 8; i += 1) {
    try { fs.writeFileSync(TARGET, text); if (sha(TARGET) === crypto.createHash('sha256').update(text).digest('hex')) return true; } catch (_) {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { timeout: 3000 }); } catch (_) {}
  }
  return false;
};

(async () => {
  const results = [];
  const base = runGate();
  console.log('[baseline]');
  console.log('  ok =', base.ok, base.failed.length ? `(${base.failed.join(', ')})` : '');
  if (!base.ok) { console.log('  기준선이 실패 — 대조군 무효'); restore(); process.exit(1); }

  for (const m of MUTATIONS) {
    const before = fs.readFileSync(TARGET, 'utf8');
    const after = norm(before).replace(m.find, m.replace);
    console.log();
    console.log(`[${m.id}] ${m.why}`);
    if (after === norm(before)) { console.log('  변이 미적용 (앵커 불일치)'); results.push({ id: m.id, applied: false, reason: 'anchor_not_found' }); continue; }
    if (!writeRetry(after)) { console.log('  변이 쓰기 실패'); results.push({ id: m.id, applied: false, reason: 'write_failed' }); continue; }
    const r = runGate();
    const restored = restore();
    const crashed = r.failed.some(f => /게이트 실행 실패/.test(f));
    const caught = r.ok === false && !crashed;
    console.log(`  ${caught ? 'CAUGHT' : (crashed ? '무효(크래시)' : 'MISS')}${r.failed.length ? ' — ' + r.failed.join(', ') : ''} | 원복 ${restored ? '확인' : '실패'}`);
    results.push({ mutation: `${m.id} ${m.why}`, applied: true, caught, crashed, failures: r.failed, restore_verified: restored });
  }

  const restoreOk = restore();
  const caught = results.filter(r => r.caught).length;
  const missed = results.filter(r => r.applied && !r.caught).length;
  const unjudged = results.filter(r => !r.applied).length;
  console.log();
  console.log(JSON.stringify({
    baseline_ok: true, total: MUTATIONS.length, caught, missed, unjudged,
    restore_failures: restoreOk && results.every(r => r.restore_verified !== false) ? 0 : 1,
    results
  }, null, 2));
  process.exit(0);
})();
