'use strict';
// Negative control: 세포↔위치 소속 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC05K = path.join(ROOT, 'src', 'parts', '05k-narrative-turn-processing.js');
const SRC09D = path.join(ROOT, 'src', 'parts', '09d-section-character-world-state.js');
const SRC08A = path.join(ROOT, 'src', 'parts', '08a-world-graph.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_world_entity_world_link_test.cjs';
const backup05k = fs.readFileSync(SRC05K, 'utf8');
const backup09d = fs.readFileSync(SRC09D, 'utf8');
const backup08a = fs.readFileSync(SRC08A, 'utf8');

const runGate = () => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', GATE)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, cwd: ROOT, timeout: 120000 }); return { ok: true, out: '' }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const buildOnce = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300000 });
// Windows 는 방금 읽은 dist 를 잠근다 — 빌드 실패를 MISS 로 오독하지 않도록 재시도한다(8단계 교훈).
const build = () => {
  let last = null;
  for (let i = 0; i < 4; i++) { try { buildOnce(); return true; } catch (e) { last = e; try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 5000 }); } catch {} } }
  throw last || new Error('build failed');
};
const broken = (out) => { try { const j = JSON.parse(String(out).slice(String(out).indexOf('{'))); return (j.assertions || []).filter(a => !a.ok).map(a => a.name); } catch { return ['(파싱실패)']; } };
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'ewl_backup');
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
fs.writeFileSync(path.join(BACKUP, '05k.js'), backup05k, 'utf8');
fs.writeFileSync(path.join(BACKUP, '09d.js'), backup09d, 'utf8');
fs.writeFileSync(path.join(BACKUP, '08a.js'), backup08a, 'utf8');

const restore = (file, original) => {
  const want = sha256(original);
  for (let i = 0; i < 6; i++) {
    try { fs.writeFileSync(file, original, 'utf8'); if (sha256(fs.readFileSync(file, 'utf8')) === want) return true; } catch {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeout: 4000 }); } catch {}
  }
  const fallback = path.join(BACKUP, path.basename(file));
  try { fs.writeFileSync(file, fs.readFileSync(fallback, 'utf8')); return sha256(fs.readFileSync(file, 'utf8')) === want; } catch { return false; }
};

const MUTATIONS = [
  {
    name: 'M1 소속 해석 제거 (세포가 개체를 모른다 — 실제 결함 형태)',
    file: SRC08A,
    from: '        const resolveEntityWorldName = (options = {}) => {\n            try {',
    to: "        const resolveEntityWorldName = (options = {}) => {\n            return '';\n            try {"
  },
  {
    name: 'M2 소속을 턴 로그에 안 남긴다',
    file: SRC09D,
    from: "                world: String(stateSnapshot.world || '').replace(/\\s+/g, ' ').trim(),",
    to: ''
  },
  {
    name: 'M3 정규화기가 소속을 버린다 (화이트리스트 회귀)',
    file: SRC09D,
    from: "            world: String(entry?.world || '').replace(/\\s+/g, ' ').trim(),",
    to: ''
  },
  {
    name: 'M4 인물 컨텍스트가 소속을 안 낸다',
    file: SRC09D,
    from: "            if (affiliation) parts.push(`  World: ${affiliation}`);",
    to: ''
  },
  {
    name: 'M5 인물 컨텍스트가 세계 규칙을 복사한다 (5단계 중복 재발)',
    file: SRC09D,
    from: "            if (affiliation) parts.push(`  World: ${affiliation}`);",
    to: "            if (affiliation) parts.push(`  World: ${affiliation}`);\n            parts.push(`  존재/Exists: 마법/Magic`);"
  },
  {
    name: 'M6 자명한 루트 이름을 소속으로 낸다 (발명)',
    file: SRC08A,
    from: "                const activeId = String(options.activeNodeId || getCurrentNode()?.id || '');\n                if (activeId && !isRoot(activeId)) return topWorldName(activeId) || nameOf(activeId);\n                return '';",
    to: "                const activeId = String(options.activeNodeId || getCurrentNode()?.id || '');\n                if (activeId && !isRoot(activeId)) return topWorldName(activeId) || nameOf(activeId);\n                return nameOf(rootId);"
  },
  {
    name: 'M7 부분 일치로 위치를 해석한다 (발명의 시작)',
    file: SRC08A,
    from: "                const byLocation = findNodeByName(String(options.location || '').trim());",
    to: "                const byLocation = (() => { const q = String(options.location || '').trim(); if (!q) return null; for (const [nid, nd] of p.nodes.entries()) { if (String(nd?.name || '').includes(q) || q.includes(String(nd?.name || ''))) return { id: nid, name: nd?.name }; } return null; })();"
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy', broken: broken(baseline.out) }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.name}]`);
  const backup = m.file === SRC05K ? backup05k : (m.file === SRC08A ? backup08a : backup09d);
  if (!backup.includes(m.from)) { results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  fs.writeFileSync(m.file, backup.replace(m.from, m.to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  // 변이가 dist 에 실제로 들어갔는지 (빌드 실패/잠금을 MISS 로 오독하지 않는다)
  const marker = String(m.to).split('\n')[0].trim().slice(0, 30);
  const landed = applied && (marker === '' ? true : fs.readFileSync(DIST, 'utf8').includes(marker));
  if (applied && !landed) { applied = false; console.log(`  변이가 dist 에 반영되지 않음 — 판정 불가`); }
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
