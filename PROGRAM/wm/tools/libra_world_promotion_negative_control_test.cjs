'use strict';
// Negative control: 승격·강등 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  '08a': path.join(ROOT, 'src', 'parts', '08a-world-graph.js'),
  '15b': path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js'),
  '15d': path.join(ROOT, 'src', 'parts', '15d-gui-events-finalize.js')
};
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_world_promotion_test.cjs';
const backups = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'promo_backup');
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
  try {
    fs.writeFileSync(file, fs.readFileSync(path.join(BACKUP, path.basename(file)) , 'utf8'));
    return sha256(fs.readFileSync(file, 'utf8')) === want;
  } catch { return false; }
};

const MUTATIONS = [
  {
    name: 'M1 규칙 제거 경로가 없다 (deepMerge 회귀 — 강등 불가)',
    file: '08a',
    from: "        const removeWorldRuleByText = (nodeId, text) => {",
    to: "        const removeWorldRuleByText_DISABLED = (nodeId, text) => {"
  },
  {
    name: 'M2 승격이 META 를 안 바꾼다 (회상에서 안 빠짐)',
    file: '08a',
    from: "                        provenanceStatus: 'retracted',",
    to: "                        provenanceStatus: '',"
  },
  {
    name: 'M3 승격이 규칙을 노드에 안 넣는다',
    file: '08a',
    from: "                    HierarchicalWorldManager.updateNode(nodeId, { rules: { custom: { [nextKey]: text } } });",
    to: "                    void nextKey;"
  },
  {
    name: 'M4 실패 시에도 META 를 retracted 로 만든다 (기억이 회상에서 사라진다)',
    file: '08a',
    from: "            if (!nodeId || !text) return { ok: false, reason: 'invalid_input', memoryMeta, locator: null };",
    to: "            if (!nodeId || !text) return { ok: false, reason: 'invalid_input', memoryMeta: { ...memoryMeta, provenanceStatus: 'retracted' }, locator: null };"
  },
  {
    name: 'M5 승격이 키로 기록한다 (GUI 저장이 키를 재부여해 강등이 못 찾음)',
    file: '08a',
    from: "                const locator = { nodeId, nodeName, text };",
    to: "                const locator = { nodeId, nodeName, key: 'rule_1' };"
  },
  {
    name: 'M6 기억 카드에서 승격 버튼 제거 (A안 미배선)',
    file: '15b',
    from: "act-promote-mem",
    to: "act-promote-mem-disabled"
  },
  {
    name: 'M7 이벤트 위임이 승격을 안 받는다 (버튼 무반응)',
    file: '15d',
    from: "            } else if (target.classList.contains('act-promote-mem') || target.classList.contains('act-demote-mem')) {",
    to: "            } else if (false && (target.classList.contains('act-promote-mem') || target.classList.contains('act-demote-mem'))) {"
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
  if (!backup.includes(m.from)) { results.push({ mutation: m.name, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  fs.writeFileSync(file, backup.replace(m.from, m.to), 'utf8');
  let applied = true;
  try { build(); } catch { applied = false; console.log('  빌드 실패'); }
  if (applied) {
    const srcNow = fs.readFileSync(file, 'utf8');
    const d = fs.readFileSync(DIST, 'utf8');
    const marker = String(m.to).split('\n')[0].trim().slice(0, 28);
    const srcOk = srcNow.includes(marker);
    const distOk = d.includes(marker);
    if (!srcOk || !distOk) { applied = false; console.log(`  변이 미반영 (src=${srcOk} dist=${distOk}) — 판정 불가`); }
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
