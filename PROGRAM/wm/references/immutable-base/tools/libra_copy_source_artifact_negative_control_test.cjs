'use strict';
// Negative control for `libra_copy_source_artifact_test.cjs` (G4)
//
//   M1 payload 식별자 리스코프를 없앤다 (부모 scopeKey 가 남아 소비처가 못 찾는다 — 원래 결함)
//   M2 payload **chatId** 만 건너뛴다 (스코프는 맞지만 chatId 가 부모로 남는다)
//   M3 `engineState.scopeKey` 를 건너뛴다 (실제로 쓰이는 세 번째 자리)
//   M4 상속 경로 배선을 끊는다 (헬퍼는 맞지만 아무도 안 부른다 — 죽은 코드)
//
// ★ 대조군 함정: 게이트가 `dist` 를 읽는다 — 변이마다 **리빌드**해야 하고,
//   빌드가 실제로 dist 를 바꿨는지 **해시로 확인**한다(안 바뀌면 판정불가).
//   npm.cmd 는 Windows 에서 EINVAL 이므로 **빌드 스크립트를 node 로 직접** 돌린다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src/parts/01f-lore-consolidation.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-libra-world-manager.cjs');
const GATE = path.join(ROOT, 'tools/libra_copy_source_artifact_test.cjs');
const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const distHash = () => { try { return crypto.createHash('sha256').update(fs.readFileSync(DIST)).digest('hex'); } catch (_) { return ''; } };

const MUTATIONS = [
  // ★ 앵커는 한 줄로 짧게 — 여러 줄 앵커는 CRLF 차이로 무너진다(반복해 밟은 함정).
  { id: 'M1', why: 'payload 식별자 리스코프를 없앤다 (부모 scopeKey 가 남는다)',
    find: /                for \(const field of payloadScopeFields\) \{\n                    const now = String\(holder\[field\] \|\| ''\)\.trim\(\);\n                    if \(now && now !== expected\) \{ holder\[field\] = expected; changed = true; \}\n                \}/,
    replace: "                void payloadScopeFields;" },
  { id: 'M2', why: 'payload `chatId` 만 건너뛴다 (스코프는 맞고 chatId 만 부모로 남는다)',
    find: /                    for \(const field of payloadChatFields\) \{\n                        const now = String\(holder\[field\] \|\| ''\)\.trim\(\);\n                        if \(now && now !== expectedChat\) \{ holder\[field\] = expectedChat; changed = true; \}\n                    \}/,
    replace: "                    void payloadChatFields;" },
  { id: 'M3', why: '`engineState.scopeKey` 를 건너뛴다 (실제로 쓰이는 자리)',
    find: /                if \(holder\.engineState && typeof holder\.engineState === 'object'\) \{/,
    replace: "                if (false && holder.engineState && typeof holder.engineState === 'object') {" },
  { id: 'M4', why: '상속 경로 배선을 끊는다 (헬퍼는 맞지만 아무도 안 부른다)',
    find: /                const rescoped = rescopeEntriesIntegrity\(inherited, runtimeScopeKey, runtimeChatId\);/,
    replace: "                const rescoped = { entries: inherited, changed: 0 };" }
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
const rebuild = () => {
  try { execFileSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, timeout: 300000, stdio: 'ignore', env: { ...process.env, NODE_PATH: '' } }); return fs.existsSync(DIST); } catch (_) { return false; }
};
const rebuildAndVerify = (beforeHash) => (rebuild() ? { built: true, changed: distHash() !== beforeHash } : { built: false, changed: false });

const runGate = () => {
  try {
    const out = execFileSync(process.execPath, [GATE], { timeout: 120000, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    return { ok: j.ok === true, failed: (j.assertions || []).filter(a => !a.ok).map(a => a.name) };
  } catch (e) {
    const out = String((e && e.stdout) || '');
    if (out.indexOf('{') >= 0) {
      try { const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); return { ok: j.ok === true, failed: (j.assertions || []).filter(a => !a.ok).map(a => a.name) }; } catch (_) {}
    }
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
  const baseBuild = rebuildAndVerify('');
  const base = baseBuild.built ? runGate() : { ok: false, failed: ['(기준선 빌드 실패)'] };
  console.log('[baseline]');
  console.log('  ok =', base.ok, base.failed.length ? `(${base.failed.join(', ')})` : '');
  if (!base.ok) { console.log('  기준선 실패 — 대조군 무효'); restore(); rebuild(); process.exit(1); }

  for (const m of MUTATIONS) {
    const before = fs.readFileSync(TARGET, 'utf8');
    const after = norm(before).replace(m.find, m.replace);
    console.log();
    console.log(`[${m.id}] ${m.why}`);
    if (after === norm(before)) { console.log('  변이 미적용 (앵커 불일치)'); results.push({ id: m.id, applied: false, reason: 'anchor_not_found' }); continue; }
    if (!writeRetry(after)) { console.log('  변이 쓰기 실패'); results.push({ id: m.id, applied: false, reason: 'write_failed' }); continue; }
    const prebuilt = distHash();
    const build = rebuildAndVerify(prebuilt);
    if (!build.built || !build.changed) {
      console.log(`  판정불가 — ${build.built ? 'dist 미변경' : '빌드 실패'}`);
      const r0 = restore(); console.log('  원복', r0 ? '확인' : '실패');
      results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: build.built ? 'dist_unchanged' : 'build_failed' });
      continue;
    }
    const r = runGate();
    const restored = restore();
    const rebuilt = rebuildAndVerify(distHash()).built;
    const crashed = r.failed.some(f => /게이트 실행 실패/.test(f));
    const caught = r.ok === false && !crashed;
    console.log(`  ${caught ? 'CAUGHT' : (crashed ? '무효(크래시)' : 'MISS')}${r.failed.length ? ' — ' + r.failed.join(', ') : ''} | 빌드 OK·dist 변경 | 원복 ${restored && rebuilt ? '확인' : '실패'}`);
    results.push({ mutation: `${m.id} ${m.why}`, applied: true, caught, crashed, failures: r.failed, restore_verified: restored && rebuilt });
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
