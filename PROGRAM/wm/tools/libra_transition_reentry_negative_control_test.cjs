'use strict';
// Negative control for the re-entry guard in `libra_scope_transition_regression_test.cjs` (감사 G2)
//
//   M1 가드를 없앤다 (원래 결함으로 회귀 — 겹친 호출이 둘 다 통과해 새 채팅이 두 개 생긴다)
//   M2 `finally` 해제를 없앤다 (플래그가 안 풀려 전환이 영구히 막힌다)
//   M3 플래그를 세우지 않는다 (가드가 항상 통과)
//   M4 거부인데 `true` 를 돌려준다 (성공을 거짓 보고 — 호출부가 새 채팅이 생긴 줄 안다)
//
// ★★ 게이트는 `dist` 를 읽는다 — 변이 후 **반드시 리빌드**해야 한다.
//    (빼먹으면 전부 조용히 MISS 된다: 소스만 바뀌고 dist 는 그대로다.)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src/parts/04j-session-transition.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-libra-world-manager.cjs');
const GATE = path.join(ROOT, 'tools/libra_scope_transition_regression_test.cjs');
const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const MUTATIONS = [
  // ★ 앵커는 한 줄로 짧게 — 여러 줄 앵커는 CRLF 차이로 무너진다(반복해 밟은 함정).
  { id: 'M1', why: '가드를 없앤다 (겹친 호출이 둘 다 통과한다)',
    find: /            if \(_transitionInFlight\) \{/,
    replace: "            if (false) {" },
  { id: 'M2', why: '`finally` 해제를 없앤다 (플래그가 안 풀려 전환이 영구히 막힌다)',
    find: /                _transitionInFlight = false;\n            \}\n        \};/,
    replace: "            }\n        };" },
  { id: 'M3', why: '플래그를 세우지 않는다 (가드가 항상 통과)',
    find: /            _transitionInFlight = true;/,
    replace: "            _transitionInFlight = _transitionInFlight;" },
  { id: 'M4', why: '거부인데 `true` 를 돌려준다 (성공을 거짓 보고)',
    find: /                return false;\n            \}\n            _transitionInFlight = true;/,
    replace: "                return true;\n            }\n            _transitionInFlight = true;" }
];

let BACKUP = fs.readFileSync(TARGET);
const HASH = sha(TARGET);

const restore = () => {
  if (sha(TARGET) === HASH) return true;
  for (let i = 0; i < 6; i += 1) {
    try { fs.writeFileSync(TARGET, BACKUP); if (sha(TARGET) === HASH) return true; } catch (_) {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { timeout: 3000 }); } catch (_) {}
  }
  return false;
};

const distHash = () => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(DIST)).digest('hex'); } catch (_) { return ''; }
};
//   ★★ Windows 에서 `execFileSync('npm.cmd', …)` 는 **EINVAL** 로 실패한다(.cmd 는 shell 필요).
//      이걸 모르면 빌드가 한 번도 안 돌고, 게이트는 옛 dist 를 보고 실패하며,
//      집계가 그 실패를 **CAUGHT 로 세어** "전부 잡았다"는 거짓이 된다 — 실제로 밟았다.
//      그래서 npm 을 거치지 않고 **빌드 스크립트를 node 로 직접** 돌린다.
const rebuild = () => {
  try {
    execFileSync(process.execPath, [BUILD_SCRIPT], {
      cwd: ROOT, timeout: 300000, stdio: 'ignore', env: { ...process.env, NODE_PATH: '' }
    });
    return fs.existsSync(DIST);
  } catch (_) { return false; }
};
//   ★ 빌드가 **실제로 dist 를 바꿨는지** 확인한다. 안 바뀌었으면 변이가 반영되지 않은 것이고,
//     그때의 게이트 실패는 CAUGHT 가 아니라 **판정불가**다 (조용한 거짓 방지).
const rebuildAndVerify = (beforeHash) => (rebuild() ? { built: true, changed: distHash() !== beforeHash } : { built: false, changed: false });

const runGate = () => {
  try {
    const out = execFileSync(process.execPath, [GATE], { timeout: 180000, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
    const i = out.indexOf('{');
    const j = JSON.parse(out.slice(i));
    return { ok: j.ok === true, failed: (j.failed || []) };
  } catch (e) {
    const out = String((e && e.stdout) || '');
    const i = out.indexOf('{');
    if (i >= 0) { try { const j = JSON.parse(out.slice(i)); return { ok: j.ok === true, failed: (j.failed || []) }; } catch (_) {} }
    return { ok: false, failed: ['(게이트 실행 실패)'], error: String((e && e.message) || e).slice(0, 160) };
  }
};

const writeRetry = (text) => {
  for (let i = 0; i < 8; i += 1) {
    try {
      fs.writeFileSync(TARGET, text);
      if (sha(TARGET) === crypto.createHash('sha256').update(text).digest('hex')) return true;
    } catch (_) {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { timeout: 3000 }); } catch (_) {}
  }
  return false;
};

(async () => {
  const results = [];
  rebuild();
  const base = runGate();
  console.log('[baseline]');
  console.log('  ok =', base.ok, base.failed.length ? `(실패: ${base.failed.join(', ')})` : '');
  if (!base.ok) { console.log('  기준선이 실패 — 대조군 무효'); restore(); rebuild(); process.exit(1); }

  for (const m of MUTATIONS) {
    const before = fs.readFileSync(TARGET, 'utf8');
    const after = norm(before).replace(m.find, m.replace);
    console.log();
    console.log(`[${m.id}] ${m.why}`);
    if (after === norm(before)) { console.log('  변이 미적용 (앵커 불일치)'); results.push({ id: m.id, applied: false }); continue; }
    if (!writeRetry(after)) { console.log('  변이 쓰기 실패'); results.push({ id: m.id, applied: false, reason: 'write_failed' }); continue; }
    const prebuilt = distHash();
    const build = rebuildAndVerify(prebuilt);
    // ★ 빌드가 실패했거나 dist 가 안 바뀌었으면 **판정불가**다 — 그 게이트 실패는 변이 때문이 아니다.
    if (!build.built || !build.changed) {
      console.log(`  판정불가 — ${build.built ? 'dist 미변경' : '빌드 실패'}`);
      const restoredUnbuilt = restore();
      console.log('  원복', restoredUnbuilt ? '확인' : '실패');
      results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: build.built ? 'dist_unchanged' : 'build_failed' });
      continue;
    }
    const r = runGate();
    const restored = restore();
    const rebuilt = rebuildAndVerify(distHash()).built;
    const caught = r.ok === false;
    console.log(`  ${caught ? 'CAUGHT' : 'MISS'}${r.failed.length ? ' — ' + r.failed.join(', ') : ''} | 빌드 OK·dist 변경 | 원복 ${restored && rebuilt ? '확인' : '실패'}`);
    results.push({ mutation: `${m.id} ${m.why}`, applied: true, caught, failures: r.failed, restore_verified: restored && rebuilt });
  }

  const restoreOk = restore();
  const rebuildOk = rebuild();
  const caught = results.filter(r => r.caught).length;
  const missed = results.filter(r => r.applied && !r.caught).length;
  const unjudged = results.filter(r => !r.applied).length;
  console.log();
  console.log(JSON.stringify({
    baseline_ok: true, total: MUTATIONS.length, caught, missed, unjudged,
    restore_failures: restoreOk && rebuildOk && results.every(r => r.restore_verified !== false) ? 0 : 1,
    results
  }, null, 2));
  process.exit(0);
})();
