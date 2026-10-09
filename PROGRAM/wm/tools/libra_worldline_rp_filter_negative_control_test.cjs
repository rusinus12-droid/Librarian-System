'use strict';
// Negative control: RP-LTM worldline 필터 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  '01f': path.join(ROOT, 'src', 'parts', '01f-lore-consolidation.js'),
  '03g': path.join(ROOT, 'src', 'parts', '03g-rp-continuity-persistence-prompt.js'),
  '13c': path.join(ROOT, 'src', 'parts', '13c-before-request-injection.js')
};
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_worldline_rp_filter_test.cjs';
const backups = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'rpf_backup');
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
for (const [k, v] of Object.entries(backups)) fs.writeFileSync(path.join(BACKUP, k + '.js'), v, 'utf8');

const runGate = () => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000 }); return { ok: true, out: '' }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const buildOnce = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });
const build = () => {
  let last = null;
  for (let i = 0; i < 4; i++) { try { buildOnce(); return true; } catch (e) { last = e; try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 5000 }); } catch {} } }
  throw last || new Error('build failed');
};
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };
const restore = (file, original) => {
  const want = sha256(original);
  for (let i = 0; i < 6; i++) {
    try { fs.writeFileSync(file, original, 'utf8'); if (sha256(fs.readFileSync(file, 'utf8')) === want) return true; } catch {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeout: 4000 }); } catch {}
  }
  try { fs.writeFileSync(file, fs.readFileSync(path.join(BACKUP, path.basename(file)), 'utf8')); return sha256(fs.readFileSync(file, 'utf8')) === want; } catch { return false; }
};

const MUTATIONS = [
  {
    name: 'M1 RP-LTM 이 worldline 상태를 안 받는다 (13c 배선 제거 — 실제 결함 형태)',
    file: '13c',
    from: "                    worldlineState: rpWorldlineState\r\n",
    to: ""
  },
  {
    name: 'M2 formatForPrompt 가 필터를 안 건다 (03g)',
    file: '03g',
    from: "                const selected = rpFilter(state[category] || []).items",
    to: "                const selected = (state[category] || [])"
  },
  {
    name: 'M3 필터가 리롤(살아있는 형제)까지 제거한다 (과잉 제거)',
    file: '01f',
    from: "                if (!t || !superseded.has(t)) return true;",
    to: "                if (!t) return true;\n                const live = Array.isArray(state?.nodes) && state.nodes.some(n => Number(n?.pairIndex) === t);\n                if (live && superseded.has(t)) return true;\n                if (superseded.has(t)) return false;\n                return true;"
  },
  {
    name: 'M4 필터가 항상 빈 배열을 돌려준다 (주입이 통째로 사라짐)',
    file: '01f',
    from: "            const kept = list.filter(item => {",
    to: "            const kept = [];\n            const _unused = list.filter(item => {"
  },
  {
    // ★ M5 재조준 2회: 조기 반환은 **행동 가드가 아니라 견고성 가드**라 변이로 관측이 안 바뀐다
    //   (`buildSupersededTurnSet(null)` 이 빈 집합을 내므로 지워도 결과 동일).
    //   → 관측이 실제로 바뀌는 결함 형태로 겨냥한다: **턴 필드를 잘못 본다.**
    //   RP-LTM 아이템은 lastTurn 을 쓰므로, turn 만 보면 필터가 아무것도 못 지운다.
    name: 'M5 필터가 lastTurn 대신 turn 만 본다 (턴 필드 오독 → 필터 무력)',
    file: '01f',
    from: "                const t = Number(item?.lastTurn || item?.turn || item?.firstTurn || 0) || 0;",
    to: "                const t = Number(item?.turn || 0) || 0;"
  },
  {
    name: 'M6 제외 턴 목록을 안 낸다 (관측성 파괴)',
    file: '01f',
    from: "                excludedTurns: Array.from(excludedTurns).sort((a, b) => a - b)",
    to: "                excludedTurns: []"
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: broken(baseline.out) }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.name}]`);
  const file = FILES[m.file];
  const backup = backups[m.file];
  // CRLF 대응: 앵커를 파일 실제 개행에 맞춘다
  let from = m.from, to = m.to;
  if (!backup.includes(from)) { from = from.replace(/\n/g, '\r\n'); to = to.replace(/\n/g, '\r\n'); }
  if (!backup.includes(from)) { results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  fs.writeFileSync(file, backup.replace(from, to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  if (applied) {
    const srcNow = fs.readFileSync(file, 'utf8');
    const marker = String(to).split('\n')[0].trim().slice(0, 26);
    const okSrc = to === '' ? !srcNow.includes(String(from).split('\n')[0].trim().slice(0, 30)) : srcNow.includes(marker);
    const d = fs.readFileSync(DIST, 'utf8');
    const okDist = to === '' ? !d.includes(String(from).split('\n')[0].trim().slice(0, 30)) : d.includes(marker);
    if (!okSrc || !okDist) { applied = false; console.log(`  변이 미반영 (src=${okSrc} dist=${okDist}) — 판정 불가`); }
  }
  let caught = false, b = [];
  if (applied) { const r = runGate(); caught = !r.ok; b = caught ? broken(r.out) : []; console.log(`  → ${caught ? 'CAUGHT' : 'MISS'}`); if (caught) console.log('  깨진 단언:', b.join(', ')); }
  const restored = restore(file, backup);
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
