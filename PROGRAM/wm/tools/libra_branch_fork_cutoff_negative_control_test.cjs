'use strict';
// Negative control: 브랜치 fork-cutoff 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const F01F = path.join(ROOT, 'src', 'parts', '01f-lore-consolidation.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_branch_fork_cutoff_test.cjs';
const backup = fs.readFileSync(F01F, 'utf8');
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'bfc_backup');
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
fs.writeFileSync(path.join(BACKUP, '01f.js'), backup, 'utf8');

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
const restore = () => {
  const want = sha256(backup);
  for (let i = 0; i < 6; i++) {
    try { fs.writeFileSync(F01F, backup, 'utf8'); if (sha256(fs.readFileSync(F01F, 'utf8')) === want) return true; } catch {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeout: 4000 }); } catch {}
  }
  try { fs.writeFileSync(F01F, fs.readFileSync(path.join(BACKUP, '01f.js'), 'utf8')); return sha256(fs.readFileSync(F01F, 'utf8')) === want; } catch { return false; }
};

const MUTATIONS = [
  {
    name: 'M1 상속이 fork 지점을 무시하고 전체를 복제한다 (원래 결함으로 회귀)',
    from: "            const forked = filterBranchInheritanceByFork(parentEntries, lineage);\n            const inherited = forked.entries.map(entry => cloneData(entry));",
    to: "            const forked = { entries: parentEntries, forkTurn: 0, excluded: 0, excludedTurns: [] };\n            const inherited = parentEntries.map(entry => cloneData(entry));"
  },
  {
    name: 'M2 fork 이후 대신 **이전**을 버린다 (부등호 반전 — 치명적)',
    from: "                if (turn > forkPair) { excludedTurns.add(turn); return false; }",
    to: "                if (turn < forkPair) { excludedTurns.add(turn); return false; }"
  },
  {
    name: 'M3 턴을 알 수 없는 엔트리를 버린다 (정보 손실)',
    from: "                if (!turn) return true;",
    to: "                if (!turn) { excludedTurns.add(0); return false; }"
  },
  {
    name: 'M4 fork 지점이 없어도 필터링한다 (하위 호환 파괴)',
    from: "            if (!forkPair || list.length === 0) {\n                return { entries: list, inherited: list.length, excluded: 0, excludedTurns: [], forkTurn: 0 };\n            }",
    to: "            if (list.length === 0) {\n                return { entries: list, inherited: list.length, excluded: 0, excludedTurns: [], forkTurn: 0 };\n            }"
  },
  {
    // ★ 재조준: 종전 변이는 **엉뚱한 위치**를 겨냥했다(`LibraTurnWorldline` 의 `memoryEntryTurn`
    //   은 상속 경로가 쓰지 않는다) + 픽스처가 `{t,turn}` 두 키를 다 가져 키 순서 변이를 못 봤다.
    //   → 상속 경로가 **실제로 쓰는** `branchEntryTurn` 의 키 순서를 무너뜨린다.
    name: 'M5 턴 읽기가 t 키만 본다 (다른 키 형태를 놓쳐 필터가 무력)',
    from: "                    const turn = Number(meta?.turnAnchorTurn || meta?.finalizedTurn || meta?.turn || meta?.t || 0);\n                    if (Number.isFinite(turn) && turn > 0) return turn;\n                }\n                const parsed = JSON.parse(content);",
    to: "                    const turn = Number(meta?.t || 0);\n                    if (Number.isFinite(turn) && turn > 0) return turn;\n                }\n                const parsed = JSON.parse(content);"
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
  fs.writeFileSync(F01F, backup.replace(from, to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  if (applied) {
    const srcNow = fs.readFileSync(F01F, 'utf8');
    const marker = String(to).split('\n')[0].trim().slice(0, 26);
    const okSrc = to === '' ? !srcNow.includes(String(from).split('\n')[0].trim().slice(0, 30)) : srcNow.includes(marker);
    const d = fs.readFileSync(DIST, 'utf8');
    const okDist = to === '' ? !d.includes(String(from).split('\n')[0].trim().slice(0, 30)) : d.includes(marker);
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
