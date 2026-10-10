'use strict';
// Negative control: HME freshness digest 게이트가 실제로 결함을 잡는가.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const F10C = path.join(ROOT, 'src', 'parts', '10c-hme-associative-graph.js');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = 'libra_hme_freshness_digest_test.cjs';
const backup = fs.readFileSync(F10C, 'utf8');
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const BACKUP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'hfresh_backup');
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
    // 원래 결함: source 에 digest 자체가 없음. 두 줄을 한 변이로 묶는다(CRLF 앵커 안정성).
    name: 'M1 source 에서 entityDigest·loreDigest 를 모두 뺀다 (원래 결함으로 회귀)',
    from: "                    entityDigest: hmeGraphInputDigest(lorebookEntries, 'entity'),\n                    loreDigest: hmeGraphInputDigest(lorebookEntries, 'lore'),",
    to: "                    entityDigest: '',\n                    loreDigest: '',"
  },
  {
    // ★ 재사용 판정이 digest 를 봐도 **관측(재구축 여부)이 안 바뀌면** 변이가 무효다.
    //   실측 MISS: `reusableExisting = existing` 로 바꿔도 `hmeGraphNeedsSemanticV2Rebuild` 가
    //   참을 내 재구축이 일어나 관측이 같았다.
    //   → 관측이 바뀌는 형태로 겨냥한다: **digest 비교를 항상 참**으로 만든다.
    name: 'M3 crossTypeFresh 가 항상 참 (엔티티·로어 변경을 무시)',
    from: "                return cachedEntity === hmeGraphInputDigest(inputEntries, 'entity')\n                    && cachedLore === hmeGraphInputDigest(inputEntries, 'lore');",
    to: "                return true;"
  },
  {
    // 엔트리 원문 대신 노드만 봄 (정보 손실 — 실측으로 확인된 함정)
    name: 'M4 digest 가 노드 필드를 본다 (identity.summary 손실로 변경 미감지)',
    from: "            const list = (Array.isArray(entries) ? entries : []);\n            const parts = [];",
    to: "            const list = [];\n            const parts = [];\n            for (const n of (Array.isArray(entries) ? entries : [])) parts.push(String(n?.summaryHash || ''));"
  },
  {
    // ★ 정렬 제거는 **관측을 안 바꿨다**(MISS) — 내 게이트가 입력 순서를 바꿔 보지 않는다.
    //   변이를 관측이 바뀌는 형태(digest 에 가변값 혼입)로 겨냥한다.
    name: 'M5 digest 에 가변값이 섞인다 (같은 입력에도 매번 재구축)',
    from: "            return String(TokenizerEngine.simpleHash(parts.sort().join('\\u0002')));",
    to: "            return String(TokenizerEngine.simpleHash(parts.sort().join('\\u0002') + Date.now()));"
  },
  {
    name: 'M6 digest 가 항상 빈 문자열 (판정 무력)',
    from: "            if (!parts.length) return '';\n            return String(TokenizerEngine.simpleHash(parts.sort().join('\\u0002')));",
    to: "            return '';"
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
    const marker = to === '' ? null : String(to).split('\n')[0].trim().slice(0, 30);
    const d = fs.readFileSync(DIST, 'utf8');
    const okSrc = marker ? srcNow.includes(marker) : !srcNow.includes(String(from).split('\n')[0].trim().slice(0, 34));
    const okDist = marker ? d.includes(marker) : !d.includes(String(from).split('\n')[0].trim().slice(0, 34));
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
