'use strict';
// Negative control for `libra_inherit_integrity_rescope_test.cjs` (감사 G3)
//
//   M1 리스코프를 무력화한다 (원래 결함으로 회귀 — 부모 스코프가 그대로 남는다)
//   M2 `[META:]` 형식만 건너뛴다 (04j 사각지대로 회귀)
//   M3 순수 JSON 만 건너뛴다 (엔티티가 안 접힌다)
//   M4 레거시(무결성 없음)도 스코프를 찍는다 (과잉 변경 — 하위 호환 파괴)
//   M5 hydrate 배선을 끊는다 (헬퍼는 맞지만 아무도 안 부른다 — 죽은 코드)
//   M6 이미 맞는 스코프도 다시 계산한다 (불필요한 쓰기)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  '01f': path.join(ROOT, 'src/parts/01f-lore-consolidation.js'),
  '04j': path.join(ROOT, 'src/parts/04j-session-transition.js')
};
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-libra-world-manager.cjs');
const GATE = path.join(ROOT, 'tools/libra_inherit_integrity_rescope_test.cjs');
const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const MUTATIONS = [
  { id: 'M1', file: '01f', expected: 'json_record_rescoped', why: '리스코프를 무력화한다',
    find: /            if \(!expected\) return false;/,
    replace: '            if (true) return false;' },
  { id: 'M2', file: '01f', expected: 'meta_prefix_rescoped', why: '[META:] 형식만 건너뛴다',
    find: /                if \(content\.startsWith\('\[META:'\) && prefixEnd > 0\) \{/,
    replace: "                if (false && content.startsWith('[META:') && prefixEnd > 0) {" },
  { id: 'M3', file: '01f', expected: 'json_record_rescoped', why: '순수 JSON만 건너뛴다',
    find: /                if \(!rescopeRecordIntegrity\(parsed, expected, expectedChat\)\) return entry;/,
    replace: '                if (true) return entry;' },
  { id: 'M4', file: '01f', expected: 'legacy_untouched', why: '레거시에도 무결성 메타를 만든다',
    find: /            const integrity = meta && typeof meta === 'object' \? meta\.integrity : null;/,
    replace: "            const integrity = meta && typeof meta === 'object' ? meta.integrity : null;\n            if (!integrity || !integrity.schema) { api.applyIntegrityMeta(record, { scopeKey: expected }); return true; }" },
  { id: 'M5', file: '04j', expected: 'transition_uses_shared_helper', why: '세션 전환의 공용 리스코프 배선을 끊는다',
    find: /                        const shared = LibraDataStorage\?\.rescopeEntriesIntegrity\?\.\(inheritedLore, newScopeKey, newChat\?\.id \|\| ''\);/,
    replace: '                        const shared = { entries: inheritedLore, changed: 0 };' },
  { id: 'M6', file: '01f', expected: 'already_correct_untouched', why: '이미 맞는 스코프도 다시 계산한다',
    find: /                && \(changed \|\| String\(integrity\.scopeKey \|\| ''\)\.trim\(\) !== expected\)\) \{/,
    replace: '                && true) {' },
  { id: 'M7', file: '01f', expected: 'stored_conflicting_payload_is_readonly_on_fresh_boot', why: 'Disable contradictory payload ownership detection during ordinary hydration',
    find: /reason = 'payload_scope_mismatch';/,
    replace: "reason = '';" },
  { id: 'M8', file: '01f', expected: 'payload_only_rescope_preserves_consumer_validation', why: 'payload 변경 후 체크섬 갱신을 건너뛴다',
    find: /                && \(changed \|\| String\(integrity\.scopeKey \|\| ''\)\.trim\(\) !== expected\)\) \{/,
    replace: "                && String(integrity.scopeKey || '').trim() !== expected) {" }
];

const BACKUP = new Map(Object.values(FILES).map(f => [f, fs.readFileSync(f)]));
const HASH = new Map(Object.values(FILES).map(f => [f, sha(f)]));

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
// ★★ 게이트는 `dist` 를 읽는다 — 변이 후 **반드시 리빌드**해야 변이가 게이트에 도달한다.
//    (이걸 빼먹으면 6/6 이 조용히 MISS 된다: 소스만 바뀌고 dist 는 그대로다.)
//   ★★ Windows 에서 `execFileSync('npm.cmd', …)` 는 **EINVAL** 로 실패한다(.cmd 는 shell 필요).
//      이걸 모르면 빌드가 한 번도 안 돌고, 게이트는 옛 dist 를 보고 실패하며,
//      집계가 그 실패를 **CAUGHT 로 세어** "전부 잡았다"는 거짓이 된다 — 실제로 밟았다.
//      그래서 npm 을 거치지 않고 **빌드 스크립트를 node 로 직접** 돌린다.
const distHash = () => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(DIST)).digest('hex'); } catch (_) { return ''; }
};
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
    const out = execFileSync(process.execPath, [GATE], { timeout: 120000, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
    const i = out.indexOf('{');
    const j = JSON.parse(out.slice(i));
    return { ok: j.ok === true, exitCode: 0, failed: (j.assertions || []).filter(a => !a.ok).map(a => a.name) };
  } catch (e) {
    const out = String((e && e.stdout) || '');
    const i = out.indexOf('{');
    if (i >= 0) {
      try { const j = JSON.parse(out.slice(i)); return { ok: j.ok === true, exitCode: e.status, failed: (j.assertions || []).filter(a => !a.ok).map(a => a.name) }; } catch (_) {}
    }
    return { ok: false, failed: ['(게이트 실행 실패)'], error: String((e && e.message) || e).slice(0, 160) };
  }
};

const writeRetry = (f, text) => {
  for (let i = 0; i < 8; i += 1) {
    try {
      fs.writeFileSync(f, text);
      if (sha(f) === crypto.createHash('sha256').update(text).digest('hex')) return true;
    } catch (_) {}
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
  if (!base.ok) { console.log('  기준선이 실패 — 대조군 무효'); restore(); process.exit(1); }

  for (const m of MUTATIONS) {
    const f = FILES[m.file];
    const before = fs.readFileSync(f, 'utf8');
    const normalized = norm(before);
    const anchorCount = [...normalized.matchAll(new RegExp(m.find.source, 'g'))].length;
    const after = normalized.replace(m.find, m.replace);
    console.log();
    console.log(`[${m.id}] ${m.why}`);
    if (anchorCount !== 1 || after === normalized) { console.log('  변이 미적용 (고유 앵커 필요)', anchorCount); results.push({ id: m.id, applied: false, anchorCount }); continue; }
    if (!writeRetry(f, after)) { console.log('  변이 쓰기 실패'); results.push({ id: m.id, applied: false, reason: 'write_failed' }); continue; }
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
    // 원복 후 dist 를 원상 복구한다 (다음 변이가 깨끗한 dist 에서 출발해야 한다)
    const rebuilt = rebuildAndVerify(distHash()).built;
    const caught = r.ok === false && Number.isInteger(r.exitCode) && r.exitCode !== 0 && r.failed[0] === m.expected;
    console.log(`  ${caught ? 'CAUGHT' : 'MISS'}${r.failed.length ? ' — ' + r.failed.join(', ') : ''} | 빌드 OK·dist 변경 | 원복 ${restored && rebuilt ? '확인' : '실패'}`);
    results.push({ mutation: `${m.id} ${m.why}`, applied: true, anchorCount, caught, expectedFirstFailure: m.expected, exitCode: r.exitCode, failures: r.failed, restore_verified: restored && rebuilt });
  }

  const restoreOk = restore();
  const finalGate = restoreOk && rebuild() ? runGate() : { ok: false };
  const caught = results.filter(r => r.caught).length;
  const missed = results.filter(r => r.applied && !r.caught).length;
  const unjudged = results.filter(r => !r.applied).length;
  console.log();
  console.log(JSON.stringify({
    baseline_ok: true, restored_gate_ok: finalGate.ok === true, total: MUTATIONS.length, caught, missed, unjudged,
    restore_failures: restoreOk && results.every(r => r.restore_verified !== false) ? 0 : 1,
    results
  }, null, 2));
  const failed = caught !== MUTATIONS.length || missed !== 0 || unjudged !== 0
    || !restoreOk || finalGate.ok !== true || results.some(r => r.restore_verified === false);
  process.exit(failed ? 1 : 0);
})();
