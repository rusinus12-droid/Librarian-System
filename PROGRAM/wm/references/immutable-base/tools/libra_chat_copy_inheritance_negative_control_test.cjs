'use strict';
// Negative control for `libra_chat_copy_inheritance_test.cjs` (감사 G1)
//
//   M1 접두 검사를 없앤다 (무관한 채팅도 복제원이 된다 — 오염)
//   M2 데이터 보유 필터를 없앤다 (빈 복제원을 고른다 — 정본의 결정적 필터)
//   M3 정렬을 뒤집는다 (가장 짧은 후보를 고른다 — 정본은 메시지 수 desc)
//   M4 자기 자신 제외를 없앤다 (대상이 자기 자신의 복제원이 된다)
//   M5 배선을 `inspect` 로 되돌린다 (표식 없는 복제를 다시 못 찾는다 — 원래 결함)
//
// ★★ 대조군 함정 3종 (전부 이 세션에서 실제로 밟았다):
//   ① Windows 에서 `execFileSync('npm.cmd', …)` 는 **EINVAL** — 빌드가 한 번도 안 돌아
//      "전부 CAUGHT" 거짓이 된다. 그래서 빌드 스크립트를 **node 로 직접** 돌린다.
//   ② 빌드가 **실제로 dist 를 바꿨는지** 해시로 확인한다. 안 바뀌면 **판정불가**다.
//   ③ 그래도 "CAUGHT" 의 **원인**을 본다 — `(게이트 실행 실패)`(크래시)면 무효다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src/parts/01f-lore-consolidation.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-libra-world-manager.cjs');
const GATE = path.join(ROOT, 'tools/libra_chat_copy_inheritance_test.cjs');
const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const distHash = () => { try { return crypto.createHash('sha256').update(fs.readFileSync(DIST)).digest('hex'); } catch (_) { return ''; } };

const MUTATIONS = [
  // ★ 앵커는 한 줄로 짧게 — 여러 줄 앵커는 CRLF 차이로 무너진다(반복해 밟은 함정).
  { id: 'M1', why: '접두 검사를 없앤다 (무관한 채팅도 복제원이 된다)',
    find: /                if \(!signatures\.every\(\(signature, index\) => signature === targetSignatures\[index\]\)\) continue;/,
    replace: "                if (false) continue;" },
  { id: 'M2', why: '데이터 보유 필터를 없앤다 (빈 복제원을 고른다)',
    find: /                if \(!filled\) continue;/,
    replace: "                if (false) continue;" },
  { id: 'M3', why: '정렬을 뒤집는다 (가장 짧은 후보를 고른다)',
    find: /            matching\.sort\(\(a, b\) => b\.messageCount - a\.messageCount/,
    replace: "            matching.sort((a, b) => a.messageCount - b.messageCount" },
  { id: 'M4', why: '자기 자신 제외를 없앤다 (대상이 자기 자신의 복제원이 된다)',
    find: /                if \(!candidateId \|\| candidateId === targetId\) continue;/,
    replace: "                if (!candidateId) continue;" },
  { id: 'M5', why: '배선을 `inspect` 로 되돌린다 (표식 없는 복제를 다시 못 찾는다)',
    find: /            try \{ lineage = await lineageInspectWithCopy\(char, chat\); \} catch \(_\) \{ return \{ ok: false, reason: 'lineage_probe_failed' \}; \}/,
    replace: "            try { lineage = LibraHostLineage.inspect(char, chat); } catch (_) { return { ok: false, reason: 'lineage_probe_failed' }; }" }
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
//   ★ npm 을 거치지 않는다 — Windows 에서 npm.cmd 는 EINVAL 이다.
const rebuild = () => {
  try {
    execFileSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, timeout: 300000, stdio: 'ignore', env: { ...process.env, NODE_PATH: '' } });
    return fs.existsSync(DIST);
  } catch (_) { return false; }
};
const rebuildAndVerify = (beforeHash) => (rebuild() ? { built: true, changed: distHash() !== beforeHash } : { built: false, changed: false });

const runGate = () => {
  try {
    const out = execFileSync(process.execPath, [GATE], { timeout: 120000, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
    const i = out.indexOf('{');
    const j = JSON.parse(out.slice(i));
    return { ok: j.ok === true, failed: (j.assertions || []).filter(a => !a.ok).map(a => a.name) };
  } catch (e) {
    const out = String((e && e.stdout) || '');
    const i = out.indexOf('{');
    if (i >= 0) {
      try { const j = JSON.parse(out.slice(i)); return { ok: j.ok === true, failed: (j.assertions || []).filter(a => !a.ok).map(a => a.name) }; } catch (_) {}
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
  console.log('  ok =', base.ok, base.failed.length ? `(실패: ${base.failed.join(', ')})` : '');
  if (!base.ok) { console.log('  기준선이 실패 — 대조군 무효'); restore(); rebuild(); process.exit(1); }

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
    //   ★ 크래시로 얻은 CAUGHT 는 무효다 — 원인이 변이인지 확인한다.
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
