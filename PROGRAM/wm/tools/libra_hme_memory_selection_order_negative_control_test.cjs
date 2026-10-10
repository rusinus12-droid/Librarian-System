'use strict';
// Negative control: 인물 화면 기억 선택 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const F10J = path.join(ROOT, 'src', 'parts', '10j-memory-public-lore-schema-api.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_hme_memory_selection_order_test.cjs';
const backup = fs.readFileSync(F10J, 'utf8');
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'hmem_backup');
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
fs.writeFileSync(path.join(BACKUP, '10j.js'), backup, 'utf8');

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
    try { fs.writeFileSync(F10J, backup, 'utf8'); if (sha256(fs.readFileSync(F10J, 'utf8')) === want) return true; } catch {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeout: 4000 }); } catch {}
  }
  try { fs.writeFileSync(F10J, fs.readFileSync(path.join(BACKUP, '10j.js'), 'utf8')); return sha256(fs.readFileSync(F10J, 'utf8')) === want; } catch { return false; }
};

const SORT_LINE = "                    for (const e of hmeGraphEdges(graph).slice().sort(compareMemoryEdges)) {";

const MUTATIONS = [
  {
    // 원래 결함: 정렬 없이 삽입 순서
    name: 'M1 정렬 없이 엣지 삽입 순서대로 뽑는다 (원래 결함으로 회귀)',
    from: SORT_LINE,
    to: "                    for (const e of hmeGraphEdges(graph)) {"
  },
  {
    name: 'M2 정렬 축이 뒤집혔다 (오래된 턴 우선)',
    from: "                        return (b.turn - a.turn)",
    to: "                        return (a.turn - b.turn)"
  },
  {
    name: 'M3 동점 처리가 없다 (중요도 2차 축 제거)',
    from: "                            || (b.importance - a.importance)",
    to: ""
  },
  {
    // 중복 제거 제거 → 상한이 한 기억으로 채워진다
    name: 'M4 쌍 중복 제거가 없다 (상한이 한 기억으로 채워진다)',
    from: "                        if (seenPair.has(pairKey)) continue;         // 같은 쌍은 한 번만 센다",
    to: "                        if (false && seenPair.has(pairKey)) continue;"
  },
  {
    name: 'M5 정렬이 무작위다 (비결정적)',
    from: SORT_LINE,
    to: "                    for (const e of hmeGraphEdges(graph).slice().sort(() => Math.random() - 0.5)) {"
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
  fs.writeFileSync(F10J, backup.replace(from, to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  if (applied) {
    const srcNow = fs.readFileSync(F10J, 'utf8');
    const marker = String(to).split('\n')[0].trim().slice(0, 30);
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
