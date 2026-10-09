'use strict';
// Negative control for `libra_settings_contract_test.cjs`
//
//   M1 정규화가 alias 를 접지 않는다 (원래 결함으로 회귀 — GUI OFF 무시)
//   M2 alias 가 정본을 덮는다 (정본 우선 규칙 파괴)
//   M3 저장이 정본화를 안 한다 (alias 가 파일에 남는다)
//   M4 가중치 별칭을 접지 않는다
//   M5 GUI 저장부가 다시 alias 를 쓴다 (드리프트 재발)
//   M6 디버그 버전이 0.1 로 회귀
//   M7 헤더 enum 이 실제와 어긋난다
//
// ★★ 원복은 메모리 백업만(`git checkout` 금지). **대조군이 도는 동안 커밋 금지**.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  '01d': path.join(ROOT, 'src/parts/01d-debug-export-runtime-trace.js'),
  '15c': path.join(ROOT, 'src/parts/15c-gui-settings-config.js'),
  '00': path.join(ROOT, 'src/parts/00-plugin-shell-and-args.js')
};
const GATE = path.join(ROOT, 'tools/libra_settings_contract_test.cjs');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const BACKUP = new Map(Object.values(FILES).map(f => [f, fs.readFileSync(f)]));
const HASH = new Map(Object.values(FILES).map(f => [f, sha(f)]));
const norm = (t) => String(t).replace(/\r\n/g, '\n');
const fileOf = (m) => FILES[m.file];

const writeRetry = (f, text) => {
  for (let i = 0; i < 8; i += 1) {
    try { fs.writeFileSync(f, text); if (sha(f) === crypto.createHash('sha256').update(text).digest('hex')) return true; } catch (_) {}
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 4000 }); } catch (_) {}
  }
  return false;
};
const restore = () => {
  let ok = true;
  for (const [f, buf] of BACKUP) {
    if (sha(f) === HASH.get(f)) continue;
    let done = false;
    for (let i = 0; i < 6 && !done; i += 1) {
      try { fs.writeFileSync(f, buf); done = sha(f) === HASH.get(f); } catch (_) {}
      if (!done) { try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { timeout: 4000 }); } catch (_) {} }
    }
    if (!done) { ok = false; console.log('  원복 실패', path.basename(f)); }
  }
  return ok;
};
const runGate = () => {
  try {
    const out = execFileSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', timeout: 240000, env: { ...process.env, NODE_PATH: '' } });
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const i = out.indexOf('{');
    if (i >= 0) { try { return JSON.parse(out.slice(i)); } catch (_) {} }
    return { ok: false, __crash: out.slice(0, 240) };
  }
};
const build = () => {
  for (let i = 0; i < 4; i += 1) {
    try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, timeout: 400000, stdio: 'pipe' }); return true; }
    catch (_) { try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 4000 }); } catch (_) {} }
  }
  return false;
};

const declaredVersion = fs.readFileSync(FILES['00'], 'utf8').match(/^\/\/@version\s+(\S+)/m)?.[1];
const fallbackMutation = require('./libra_version_fallback_mutation.cjs').versionFallbackMutation(declaredVersion);

const MUTATIONS = [
  { id: 'M1', file: '01d', why: '정규화가 alias 를 접지 않는다 (원래 결함으로 회귀)',
    find: /        for \(const \[alias, canonical\] of Object\.entries\(SETTINGS_KEY_ALIASES\)\) \{/,
    replace: '        for (const [alias, canonical] of []) {' },
  { id: 'M2', file: '01d', why: 'alias 가 정본을 덮는다 (정본 우선 규칙 파괴)',
    find: /            if \(hasNestedSettingValue\(out, canonical\)\) continue;   \/\/ 정본 우선/,
    replace: '            // 정본 우선 규칙 제거' },
  { id: 'M3', file: '01d', why: '저장이 정본화를 안 한다 (alias 가 파일에 남는다)',
    find: /                payload = JSON\.stringify\(canonicalSettingsForStorage\(parsed\)\);/,
    replace: '                payload = JSON.stringify(parsed);' },
  { id: 'M4', file: '01d', why: '가중치 별칭을 접지 않는다',
    find: /        wSim: 'weights\.similarity',\n        wImp: 'weights\.importance',\n        wRec: 'weights\.recency'\n/,
    replace: '\n' },
  { id: 'M5', file: '15c', why: 'GUI 저장부가 다시 alias 를 쓴다 (드리프트 재발)',
    find: /                hybridMemoryEngineEnabled: overlay\.querySelector\('#shme'\)\?\.checked === true,/,
    replace: "                hybridMemoryEngine: overlay.querySelector('#shme')?.checked === true," },
  { id: 'M6', file: '01d', why: '디버그 버전이 0.1 로 회귀',
    ...fallbackMutation },
  { id: 'M7', file: '00', why: '헤더 enum 이 실제와 어긋난다',
    find: /\/\/@arg director_mode string Director mode: disabled\|light\|standard\|strong\|absolute/,
    replace: '//@arg director_mode string Director mode: disabled|light|full' }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok, `(${(baseline.assertions || []).filter(a => a.ok).length}/${(baseline.assertions || []).length})`);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy' }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.id}] ${m.why}`);
  const f = fileOf(m);
  const before = fs.readFileSync(f, 'utf8');
  if (!m.find.test(before)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  const after = before.replace(m.find, m.replace);
  if (after === before) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'no_change' }); console.log('  치환 무효'); continue; }
  if (!writeRetry(f, after)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'write_locked' }); console.log('  쓰기 잠금'); continue; }

  let applied = build();
  if (applied) {
    const srcNow = norm(fs.readFileSync(f, 'utf8'));
    const okSrc = !srcNow.includes(norm(m.find.source)) && srcNow.includes(norm(m.replace));
    if (!okSrc) { applied = false; console.log('  변이 미반영 (src) — 판정 불가'); }
  } else { console.log('  빌드 실패'); }

  let caught = false, failures = [];
  if (applied) {
    const res = runGate();
    caught = res.ok === false;
    failures = (res.assertions || []).filter(a => !a.ok).map(a => a.name);
    console.log(`  → ${caught ? 'CAUGHT' : 'MISS'}`);
    if (caught) console.log('  깨진 단언:', failures.slice(0, 4).join(', '));
    if (res.__crash) console.log('  crash:', res.__crash);
  }
  const restored = restore();
  const rebuilt = build();
  const afterRun = runGate();
  console.log(`  원복: 파일일치=${restored} 재통과=${afterRun.ok}`);
  results.push({ mutation: `${m.id} ${m.why}`, applied, caught, failures, restore_verified: restored && rebuilt && afterRun.ok });
}

const caught = results.filter(r => r.caught).length;
const missed = results.filter(r => r.applied === true && !r.caught).length;
const unjudged = results.filter(r => r.applied === false).length;
const restoreFailures = results.filter(r => r.restore_verified === false).length;
console.log('\n' + JSON.stringify({ baseline_ok: true, total: results.length, caught, missed, unjudged, restore_failures: restoreFailures, results }, null, 2));
if (restoreFailures) process.exit(3);
process.exit(caught === results.length ? 0 : 1);
