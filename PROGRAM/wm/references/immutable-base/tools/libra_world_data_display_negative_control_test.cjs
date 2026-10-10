'use strict';
// Negative control: 9단계 데이터 표시 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC15A = path.join(ROOT, 'src', 'parts', '15a-gui-session-data.js');
const SRC15B = path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_world_data_display_test.cjs';
const backupA = fs.readFileSync(SRC15A, 'utf8');
const backupB = fs.readFileSync(SRC15B, 'utf8');
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'wdd_backup');
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
fs.writeFileSync(path.join(BACKUP, '15a.js'), backupA, 'utf8');
fs.writeFileSync(path.join(BACKUP, '15b.js'), backupB, 'utf8');

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
  const fb = path.join(BACKUP, path.basename(file));
  try { fs.writeFileSync(file, fs.readFileSync(fb, 'utf8')); return sha256(fs.readFileSync(file, 'utf8')) === want; } catch { return false; }
};

const MUTATIONS = [
  {
    // 삭제 대신 변형한다 — 같은 취지의 줄이 2곳(초기화·동기화)이라 삭제는 판정이 모호해진다.
    //   "activeNodes 가 activePath 를 그대로 따라간다" = 멀티노드 데이터가 화면에 도달하지 않는다.
    name: 'M1 스냅샷의 activeNodes 가 activePath 를 따라간다 (멀티노드 데이터 미도달)',
    file: SRC15A,
    from: "                activeNodes: Array.isArray(profile.activeNodes) ? [...profile.activeNodes] : [],",
    to: "                activeNodes: Array.isArray(profile.activePath) ? [...profile.activePath] : [],"
  },
  {
    name: 'M2 상세 배지가 activePath 만 본다 (멀티노드를 이력으로 오표시)',
    file: SRC15B,
    from: "            const isActive = activeNodeIds.includes(String(id));",
    to: "            const isActive = activePath.includes(String(id));"
  },
  {
    name: 'M3 KPI 가 activePath 만 센다 (활성 수를 잘못 셈)',
    file: SRC15B,
    from: "                const activeCount = Array.isArray(_WLD?.activeNodes) && _WLD.activeNodes.length > 0\n                    ? _WLD.activeNodes.length\n                    : activePath.length;",
    to: "                const activeCount = activePath.length;"
  },
  {
    name: 'M4 노드 카드가 activePath 만 본다 (같은 부류)',
    file: SRC15B,
    from: "                    const isActive = apActive.includes(String(id));",
    to: "                    const isActive = ap.includes(String(id));"
  },
  {
    name: 'M4b 트리 렌더러가 activePath 만 본다 (같은 부류·별도 지점)',
    file: SRC15B,
    from: "                const active = apActive.indexOf(id) >= 0;",
    to: "                const active = ap.indexOf(id) >= 0;"
  },
  {
    name: 'M5 인물 화면이 소속 세계를 안 낸다 (4단계 데이터 미노출)',
    file: SRC15B,
    from: "                ['세계', worldAffiliation],\n",
    to: ""
  },
  {
    name: 'M6 소속이 없어도 행을 낸다 (빈 값 발명)',
    file: SRC15B,
    from: "                ['세계', worldAffiliation],",
    to: "                ['세계', worldAffiliation || '주요 세계'],"
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: broken(baseline.out) }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.name}]`);
  const backup = m.file === SRC15A ? backupA : backupB;
  if (!backup.includes(m.from)) { results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  fs.writeFileSync(m.file, backup.replace(m.from, m.to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  // 변이가 **소스에** 실제로 들어갔는지 먼저 본다(쓰기 실패/앵커 밖 변경 차단).
  //   그리고 삭제 변이는 dist 에서 "그 줄이 사라졌는지"로 본다 —
  //   실측: 같은 취지의 줄이 2곳(초기화·동기화)에 있어 "아무 데도 없으면 반영"이라
  //   판정하니 **적용됐는데 미반영으로 오독**했다.
  if (applied) {
    const srcNow = fs.readFileSync(m.file, 'utf8');
    const srcApplied = srcNow.includes(String(m.to).split('\n')[0]);
    const d = fs.readFileSync(DIST, 'utf8');
    const fromLine = String(m.from).split('\n')[0].trim().slice(0, 40);
    const distOk = m.to === '' ? !d.includes(fromLine) : d.includes(String(m.to).split('\n')[0].trim().slice(0, 30));
    if (!srcApplied || !distOk) {
      applied = false;
      console.log(`  변이가 반영되지 않음 (src=${srcApplied} dist=${distOk}) — 판정 불가`);
    }
  }
  let caught = false, b = [];
  if (applied) { const r = runGate(); caught = !r.ok; b = caught ? broken(r.out) : []; console.log(`  → ${caught ? 'CAUGHT' : 'MISS'}`); if (caught) console.log('  깨진 단언:', b.join(', ')); }
  const restored = restore(m.file, backup);
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
