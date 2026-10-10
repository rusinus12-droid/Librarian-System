'use strict';
// Negative control: canonical packet world 변환 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const F12 = path.join(ROOT, 'src', 'parts', '12-processors-world-entity.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_packet_world_shifts_test.cjs';
const backup = fs.readFileSync(F12, 'utf8');
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'pws_backup');
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
fs.writeFileSync(path.join(BACKUP, '12.js'), backup, 'utf8');

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
  const want = sha256(backup);
  for (let i = 0; i < 6; i++) {
    try { fs.writeFileSync(F12, backup, 'utf8'); if (sha256(fs.readFileSync(F12, 'utf8')) === want) return true; } catch {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeout: 4000 }); } catch {}
  }
  try { fs.writeFileSync(F12, fs.readFileSync(path.join(BACKUP, '12.js'), 'utf8')); return sha256(fs.readFileSync(F12, 'utf8')) === want; } catch { return false; }
};

const MUTATIONS = [
  {
    // 원래 결함 ①: 차원 이동을 내지 않는다
    name: 'M1 변환기가 dimensionalShifts 를 내지 않는다 (원래 결함으로 회귀)',
    from: "            if (dimensionalShifts.length > 0) output.dimensionalShifts = dimensionalShifts;",
    to: "            if (false && dimensionalShifts.length > 0) output.dimensionalShifts = dimensionalShifts;"
  },
  {
    // 원래 결함 ②: 중첩 state 를 안 읽는다
    name: 'M2 중첩 world.state 를 안 읽는다 (원래 결함으로 회귀)',
    from: "            const worldStateRoot = packetPlainObject(worldRoot.state);",
    to: "            const worldStateRoot = {};"
  },
  {
    // 원래 결함 ③: 구조화 배열을 문자열로 뭉갠다
    name: 'M3 병합이 구조화 배열을 문자열로 뭉갠다 (원래 결함으로 회귀)',
    from: "                    if (allObjects) {\n                        next[key] = [...mergedPrev, ...safeClone(value)].slice(-24);\n                    } else {",
    to: "                    if (false && allObjects) {\n                        next[key] = [...mergedPrev, ...safeClone(value)].slice(-24);\n                    } else {"
  },
  {
    name: 'M4 도착 세계가 없어도 항목을 만든다 (빈 항목 → to=\"\")',
    from: "                    const to = shiftName(item.to || item.target || item.world || '', 160);\n                    if (!to) return null;",
    to: "                    const to = shiftName(item.to || item.target || item.world || '', 160);"
  },
  {
    name: 'M5 이동이 없어도 빈 배열을 만든다 (allowShift 오판 위험)',
    from: "            if (dimensionalShifts.length > 0) output.dimensionalShifts = dimensionalShifts;",
    to: "            output.dimensionalShifts = dimensionalShifts;"
  },
  {
    name: 'M6 shiftName 이 모든 값을 빈 문자열로 만든다 (객체 판정 오류)',
    from: "                    const shiftName = (value, max) => (value && typeof value === 'object')\n                        ? ''\n                        : String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().slice(0, max);",
    to: "                    const shiftName = (value, max) => '';"
  },
  {
    name: 'M7 snake_case 를 안 읽는다 (하위 호환 파괴)',
    from: "                : (Array.isArray(worldRoot.dimensional_shifts) ? worldRoot.dimensional_shifts : []);",
    to: "                : [];"
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: broken(baseline.out) }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.name}]`);
  let from = m.from, to = m.to;
  if (!backup.includes(from)) { from = from.replace(/\n/g, '\r\n'); to = to.replace(/\n/g, '\r\n'); }
  if (!backup.includes(from)) { results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  fs.writeFileSync(F12, backup.replace(from, to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  if (applied) {
    const srcNow = fs.readFileSync(F12, 'utf8');
    const marker = String(to).split('\n')[0].trim().slice(0, 26);
    const okSrc = srcNow.includes(marker);
    const d = fs.readFileSync(DIST, 'utf8');
    const okDist = d.includes(marker);
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
