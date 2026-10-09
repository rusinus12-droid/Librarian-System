'use strict';
// Negative control: E2 경계 인식 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const F10C = path.join(ROOT, 'src', 'parts', '10c-hme-associative-graph.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_hme_partial_edge_test.cjs';
const backup = fs.readFileSync(F10C, 'utf8');
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'hme_bnd_backup');
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
fs.writeFileSync(path.join(BACKUP, '10c.js'), backup, 'utf8');

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
    try { fs.writeFileSync(F10C, backup, 'utf8'); if (sha256(fs.readFileSync(F10C, 'utf8')) === want) return true; } catch {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeout: 4000 }); } catch {}
  }
  try { fs.writeFileSync(F10C, fs.readFileSync(path.join(BACKUP, '10c.js'), 'utf8')); return sha256(fs.readFileSync(F10C, 'utf8')) === want; } catch { return false; }
};

const MUTATIONS = [
  {
    // 원래 결함: 인라인 includes (경계 무시)
    name: 'M1 부분 일치가 경계를 무시한다 (원래 결함으로 회귀)',
    from: "                            if (ek && key && (hmeEntityNameBoundaryMatch(key, ek) || hmeEntityNameBoundaryMatch(ek, key))) {",
    to: "                            if (ek && key && (key.includes(ek) || ek.includes(key))) {"
  },
  {
    // ★ M4 재조준 2회: `HME_PARTICLE_SUFFIX` 분기는 **도달 불가**라 제거했다
    //   (실측: 조사는 앞단 entities 추출에서 이미 정규화된다 — `아리엘은` → `entities:["아리엘"]`).
    //   실제로 도달하는 지점은 **구분자 판정**이다. 한국어 글자까지 구분자로 넓히면
    //   `세라핌`/`김민아` 꼬리가 통과해 오탐이 재발한다.
    name: 'M4 구분자 판정이 한국어 꼬리까지 인정한다 (오탐 재발)',
    from: "            if (/^[\\s._\\-·/]+/.test(rest)) return true;",
    to: "            if (/^[\\s._\\-·/\uAC00-\uD7A3]+$/.test(rest)) return true;"
  },
  {
    name: 'M5 완전 일치가 깨진다 (0.78 → 0.45)',
    from: "                    const weight = exact > 0 ? 0.78 : 0.45;",
    to: "                    const weight = 0.45;"
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
  fs.writeFileSync(F10C, backup.replace(from, to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  if (applied) {
    const srcNow = fs.readFileSync(F10C, 'utf8');
    const marker = String(to).split('\n')[0].trim().slice(0, 28);
    const d = fs.readFileSync(DIST, 'utf8');
    const okSrc = srcNow.includes(marker), okDist = d.includes(marker);
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
