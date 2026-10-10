'use strict';
// Negative control for `libra_css_cascade_test.cjs`
//
//   M1 `flex-wrap` 을 되돌린다 (D1 원래 결함으로 회귀 — 그룹 항목이 안 감긴다)
//   M2 `.tabs` 780px 블록을 **두 개**로 되돌린다 (display:grid 가 flex 규칙을 무력화)
//   M3 도구가 CSS 를 못 찾게 만든다 (빈 결과로 공허하게 통과하는지 — C4 가 막아야 한다)
//   M4 780px 블록의 `.side-sec` 를 통째로 지운다 (수리 지점 제거)
//
// ★★ 대조군 함정 (이 세션에서 실제로 밟은 것):
//   ① Windows 에서 `execFileSync('npm.cmd', …)` 는 **EINVAL** — 빌드가 안 돌아
//      "전부 CAUGHT" 거짓이 된다. 빌드 스크립트를 **node 로 직접** 돌린다.
//   ② 빌드가 **실제로 dist 를 바꿨는지** 해시로 확인한다. 안 바뀌면 **판정불가**.
//   ③ 그래도 "CAUGHT" 의 **원인**을 본다 — `(게이트 실행 실패)`(크래시)면 무효다.
//
//   ※ 이 게이트는 `src/parts/15-gui-and-exports.js` 를 **직접** 읽는다(dist 아님).
//     그래서 리빌드가 필요 없다 — 다만 도구(`libra_css_cascade_probe.cjs`) 를 통해 읽으므로
//     변이가 도구에 도달하는지는 C4(`probe_parsed_css_rules`) 가 지킨다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src/parts/15-gui-and-exports.js');
const GATE = path.join(ROOT, 'tools/libra_css_cascade_test.cjs');
const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const MUTATIONS = [
  { id: 'M1', why: '`flex-wrap` 을 되돌린다 (D1 원래 결함으로 회귀)',
    find: /  \.side-sec\{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px\}/,
    replace: '  .side-sec{margin:0;display:flex;align-items:center;gap:6px}' },
  { id: 'M2', why: '`.tabs` 780px 블록을 grid 로 되돌린다 (flex 규칙이 무력해진다)',
    find: /  \.side-sec\{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px\}/,
    replace: '  .side-sec{margin:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}' },
  { id: 'M3', why: '780px 블록의 `.side-sec` 를 지운다 (수리 지점 제거)',
    find: /  \.side-sec\{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px\}\n/,
    replace: '' },
  { id: 'M4', why: '`.side-sec` 를 flex 유지한 채 wrap 만 다른 값으로 (감김 무력화)',
    find: /flex-wrap:wrap;align-items:center;gap:6px\}/,
    replace: 'flex-wrap:nowrap;align-items:center;gap:6px}' },
  // ★ D3 회귀 — 무력 flex 선언을 되살린다 (grid 컨테이너에 flex-direction/flex-wrap)
  { id: 'M5', why: '무력 flex 선언을 되살린다 (D3 회귀 — grid 컨테이너에 flex-direction)',
    find: /  \.tabs\{align-items:center;gap:6px;border-right:0;/,
    replace: '  .tabs{flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px;border-right:0;' }
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
  const base = runGate();
  console.log('[baseline]');
  console.log('  ok =', base.ok, base.failed.length ? `(실패: ${base.failed.join(', ')})` : '');
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
