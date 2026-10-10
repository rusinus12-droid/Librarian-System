'use strict';
// Negative control: 쓰기 시점 worldline guard 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const F01F = path.join(ROOT, 'src', 'parts', '01f-lore-consolidation.js');
const F08E = path.join(ROOT, 'src', 'parts', '08e-entity-prompt-cache-persistence.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_write_time_worldline_test.cjs';
const snap = {
  '01f': fs.readFileSync(F01F, 'utf8'),
  '08e': fs.readFileSync(F08E, 'utf8')
};
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'wwl_backup');
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
fs.writeFileSync(path.join(BACKUP, '01f.js'), snap['01f'], 'utf8');
fs.writeFileSync(path.join(BACKUP, '08e.js'), snap['08e'], 'utf8');
const fileOf = (k) => (k === '01f' ? F01F : F08E);
// ★ Windows 파일 잠금(UNKNOWN) 방어 — 이 저장소에서 반복되는 함정이다.
//   한 번 실패하면 그 변이가 **적용되지 않은 채** 진행돼 판정이 오염된다.
const writeWithRetry = (file, text) => {
  for (let i = 0; i < 8; i++) {
    try { fs.writeFileSync(file, text, 'utf8'); return true; }
    catch (e) {
      if (!/UNKNOWN|EBUSY|EPERM|EACCES/.test(String(e && e.code || '') + String(e && e.message || ''))) throw e;
      try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},700)'], { timeout: 5000 }); } catch {}
    }
  }
  return false;
};

const runGate = () => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 180000 }); return { ok: true, out: '' }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const buildOnce = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 400000 });
const build = () => {
  let last = null;
  for (let i = 0; i < 4; i++) { try { buildOnce(); return true; } catch (e) { last = e; try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 5000 }); } catch {} } }
  throw last || new Error('build failed');
};
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };
const restore = () => {
  let okAll = true;
  for (const k of ['01f', '08e']) {
    const f = fileOf(k);
    const want = sha256(snap[k]);
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      try { if (writeWithRetry(f, snap[k])) ok = sha256(fs.readFileSync(f, 'utf8')) === want; } catch {}
      if (!ok) { try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeout: 4000 }); } catch {} }
    }
    if (!ok) { try { if (writeWithRetry(f, fs.readFileSync(path.join(BACKUP, `${k}.js`), 'utf8'))) ok = sha256(fs.readFileSync(f, 'utf8')) === want; } catch {} }
    okAll = okAll && ok;
  }
  return okAll;
};

const MUTATIONS = [
  {
    // 원래 결함: 필터가 없다
    file: '01f',
    name: 'M1 필터가 리롤·롤백을 구분하지 않고 전부 통과시킨다 (원래 결함으로 회귀)',
    from: "                if (superseded.has(turn)) { excludedTurns.add(turn); return false; }",
    to: "                if (false) { excludedTurns.add(turn); return false; }"
  },
  {
    file: '01f',
    name: 'M2 턴 도장이 없는 항목을 버린다 (정보 손실)',
    // ★ `if (!turn) return true;` 가 **두 곳**(01f:263 `filterBranchInheritanceByFork`, 01f:703 내 필터)에
    //   있다. 짧은 앵커는 **첫 번째**를 바꿔 MISS 를 만든다 — 앞 문맥을 포함해 정확히 겨냥한다.
    from: "                const turn = entityRecordTurn(record);\n                // 턴을 알 수 없으면 **버리지 않는다** — 저장에서 빼면 정보가 사라진다(보수적).\n                if (!turn) return true;",
    to: "                const turn = entityRecordTurn(record);\n                if (!turn) { excludedTurns.add(0); return false; }"
  },
  {
    file: '01f',
    name: 'M3 같은 턴에 살아있는 variant 를 못 봐 리롤을 롤백으로 오판한다',
    // ★ 원래 M3(조기 반환 제거)는 **무효 변이**였다 — state=null 이면 buildSupersededTurnSet 이
    //   빈 집합을 내고 아래 `superseded.size === 0` 조기 반환이 대신 막아 **관측이 안 바뀐다**.
    //   (조기 반환은 행동 가드가 아니라 견고성 가드다 — #1 에서 겪은 것과 같은 함정.)
    //   실제로 도달 가능한 지점 = **리롤과 롤백을 구분하는 한 줄**:
    //   같은 턴에 살아있는 variant 가 있으면 그 턴은 유효하다(리롤). 이걸 무력화하면
    //   리롤된 턴(10)이 롤백처럼 거르여 **살아있는 엔티티가 저장에서 사라진다**.
    from: "                if (liveTurns.has(turn)) continue;",
    to: "                if (false) continue;"
  },
  {
    file: '01f',
    name: 'M4 entityRecordTurn 이 턴을 못 읽는다 (필터 무력)',
    from: "            const turn = Number(\n                meta.created || meta.sourceTurn || quality.lastUpdatedTurn\n                || baseline.turn || record.sourceTurn || 0\n            );",
    to: "            const turn = 0;"
  },
  {
    // 저장 경로 배선 제거 → 게이트 W1 이 잡아야 한다
    file: '08e',
    name: 'M5 저장 경로가 worldline 을 안 본다 (원래 결함으로 회귀)',
    from: "            if (writeFilter && worldlineState) {",
    to: "            if (false && writeFilter && worldlineState) {"
  },
  {
    file: '08e',
    name: 'M6 제외된 엔티티를 캐시에 남긴다 (다음 저장에서 되살아난다)',
    // ★ 변이를 캐시 삭제가 아니라 **제외 판정**으로 겨냥한다.
    //   delete 만 없애면 `continue` 뒤의 `droppedEntityNames.has` 가 여전히 참이라 관측이 같다.
    from: "                if (droppedEntityNames.has(String(entity?.name || name || ''))) {",
    to: "                if (false && droppedEntityNames.has(String(entity?.name || name || ''))) {"
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: broken(baseline.out) }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.file}] ${m.name}`);
  const f = fileOf(m.file);
  const base = snap[m.file];
  let from = m.from, to = m.to;
  if (!base.includes(from)) { from = from.replace(/\n/g, '\r\n'); to = to.replace(/\n/g, '\r\n'); }
  if (!base.includes(from)) { results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  if (!writeWithRetry(f, base.replace(from, to))) { results.push({ mutation: m.name, applied: false, reason: 'write_locked' }); console.log('  쓰기 잠금 — 판정 불가'); continue; }
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  if (applied) {
    // ★ 반영 판정은 **from 전체가 사라지고 to 가 들어왔는가**로 한다.
    //   함정 2개를 실측으로 밟았다:
    //   ① `to` 의 첫 줄을 마커로 쓰면 다른 곳에 같은 문장이 있어 모호해진다(M3).
    //   ② `from` 의 **첫 줄만** 보면, 변이가 그 줄을 그대로 두는 경우(M2·M4: `const turn = …` 를 유지하고
    //      다음 줄만 바꾼다) **적용됐는데도 미반영으로 오판**한다.
    //   줄바꿈은 파일마다 CRLF/LF 가 섞여 있으므로 **정규화 후** 비교한다.
    const norm = (t) => String(t).replace(/\r\n/g, '\n');
    const srcNow = norm(fs.readFileSync(f, 'utf8'));
    const d = norm(fs.readFileSync(DIST, 'utf8'));
    const okSrc = !srcNow.includes(norm(from)) && srcNow.includes(norm(to));
    const okDist = !d.includes(norm(from)) && d.includes(norm(to));
    if (!okSrc || !okDist) { applied = false; console.log(`  변이 미반영 (src=${okSrc} dist=${okDist}) — 판정 불가`); }
  }
  let caught = false, b = [];
  if (applied) { const r = runGate(); caught = !r.ok; b = caught ? broken(r.out) : []; console.log(`  → ${caught ? 'CAUGHT' : 'MISS'}`); if (caught) console.log('  깨진 단언:', b.join(', ')); }
  const restored = restore();
  let rebuilt = true; try { build(); } catch { rebuilt = false; }
  const after = runGate();
  console.log(`  원복: 파일일치=${restored} 재통과=${after.ok}`);
  results.push({ mutation: m.name, applied, caught, broken_assertions: b, restore_verified: restored && rebuilt && after.ok });
}

console.log('\n' + JSON.stringify({
  baseline_ok: true, total: results.length,
  caught: results.filter(r => r.caught).length,
  missed: results.filter(r => r.applied && !r.caught).length,
  unjudged: results.filter(r => r.applied === false).length,
  restore_failures: results.filter(r => r.restore_verified === false).length,
  results
}, null, 2));
if (results.some(r => r.restore_verified === false)) process.exit(3);
process.exit(0);
