'use strict';
// Negative control for `libra_world_rule_worldline_test.cjs`
// 게이트가 통과만 보는 게 아닌지 확인한다 — **실제로 밟았던 결함의 형태**로 소스를 변이한다.
//
//   M1 승격이 출처 턴을 기록하지 않는다 (원래 결함으로 회귀 — 턴 도장 없음)
//   M2 프롬프트 조립이 그 필터를 안 탄다 (판정은 있는데 배선이 죽었다)
//   M3 주입 경로(13c)가 worldline 인식 함수를 안 쓴다 (배선 회귀)
//   M4 리롤/롤백 구분을 무력화한다 (살아있는 규칙까지 거른다 — 과잉 제거)
//   M5 월드라인 상태가 없어도 필터링한다 (하위 호환 파괴)
//   M6 턴을 알 수 없는 규칙까지 버린다 (정보 손실)
//
// ★★ 원복은 **메모리 백업**으로만 한다. `git checkout` 을 쓰면 커밋 안 된 작업이 통째로 사라진다
//    (이 리포에서 실제로 겪은 사고다 — 그래서 여기서도 백업 방식만 쓴다).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  '08a': path.join(ROOT, 'src/parts/08a-world-graph.js'),
  '13c': path.join(ROOT, 'src/parts/13c-before-request-injection.js')
};
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GATE = path.join(ROOT, 'tools/libra_world_rule_worldline_test.cjs');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const BACKUP = new Map(Object.values(FILES).map(f => [f, fs.readFileSync(f)]));
const HASH = new Map(Object.values(FILES).map(f => [f, sha(f)]));
const norm = (t) => String(t).replace(/\r\n/g, '\n');

const writeRetry = (file, text) => {
  for (let i = 0; i < 8; i += 1) {
    try { fs.writeFileSync(file, text); if (sha(file) === crypto.createHash('sha256').update(text).digest('hex')) return true; } catch (_) {}
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
    if (!done) { ok = false; console.log(`  원복 실패 ${path.basename(f)}`); }
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
    return { ok: false, __crash: out.slice(0, 260) };
  }
};

const build = () => {
  for (let i = 0; i < 4; i += 1) {
    try { execFileSync('npm', ['run', 'build'], { cwd: ROOT, shell: true, timeout: 400000, stdio: 'pipe' }); return true; }
    catch (_) { try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},450)'], { timeout: 4000 }); } catch (_) {} }
  }
  return false;
};

const MUTATIONS = [
  {
    id: 'M1', file: '08a',
    why: '승격이 출처 턴을 기록하지 않는다 (원래 결함으로 회귀)',
    find: /                if \(sourceTurn\) \{\n/, replace: '                if (false && sourceTurn) {\n'
  },
  {
    id: 'M2', file: '08a',
    why: '프롬프트 조립이 필터를 안 탄다 (판정은 있는데 배선이 죽었다)',
    find: /                const ruleFilter = applyRuleWorldlineFilter\(/,
    replace: '                const ruleFilter = { rules: customRules } || applyRuleWorldlineFilter('
  },
  {
    id: 'M3', file: '13c',
    why: '주입 경로가 worldline 인식 함수를 안 쓴다 (배선 회귀)',
    find: /if \(worldlineState && typeof HierarchicalWorldManager\?\.formatForPromptWithWorldline === 'function'\) \{/,
    replace: "if (false && worldlineState && typeof HierarchicalWorldManager?.formatForPromptWithWorldline === 'function') {"
  },
  {
    id: 'M4', file: '08a',
    why: '리롤/롤백 구분을 무력화한다 (살아있는 규칙까지 거른다)',
    // ★ 엔티티 필터가 판정을 담당하므로 **거른 결과를 그대로 믿지 않고** 전부 거르게 만든다.
    find: /                if \(!excludedTurns\.has\(String\(rule \|\| ''\)\)\) return true;\n/,
    replace: "                if (false) return true;\n"
  },
  {
    id: 'M5', file: '08a',
    why: '월드라인 상태가 없는데 전부 버린다 (하위 호환 파괴)',
    // ★ 원래 M5(`!state ||` 제거)는 **무효 변이**였다 — 상태가 없으면 엔티티 필터가
    //   전부 반환하고, 바로 아래 `excludedTurns.size === 0` 조기 반환이 대신 막아
    //   **관측이 안 바뀐다**(조기 반환은 행동 가드가 아니라 견고성 가드 — 반복해 밟은 함정).
    //   실제로 하위 호환이 **깨지는** 형태로 겨냥한다.
    find: /            if \(!state \|\| list\.length === 0\) return \{ rules: list, excluded: 0, excludedTurns: \[\] \};\n/,
    replace: '            if (!state) return { rules: [], excluded: list.length, excludedTurns: [] };\n            if (list.length === 0) return { rules: list, excluded: 0, excludedTurns: [] };\n'
  },
  {
    id: 'M6', file: '08a',
    why: '턴을 알 수 없는 규칙까지 버린다 (정보 손실)',
    find: /                    list\.map\(\(text\) => \(\{ name: String\(text \|\| ''\), meta: \{ created: Number\(\(meta && meta\[text\]\) \|\| 0\) \|\| 0 \} \}\)\),/,
    replace: "                    list.map((text) => ({ name: String(text || ''), meta: { created: 1 } })),"
  }
];

const results = [];
console.log('[baseline]');
const baseline = runGate();
console.log('  ok =', baseline.ok, `(${(baseline.assertions || []).filter(a => a.ok).length}/${(baseline.assertions || []).length})`);
if (!baseline.ok) { console.log(JSON.stringify({ ok: false, reason: 'baseline_unhealthy' }, null, 2)); process.exit(1); }

for (const m of MUTATIONS) {
  console.log(`\n[${m.file}] ${m.id} ${m.why}`);
  const f = FILES[m.file];
  const before = fs.readFileSync(f, 'utf8');
  if (!m.find.test(before)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'anchor_not_found' }); console.log('  앵커 없음'); continue; }
  const after = before.replace(m.find, m.replace);
  if (after === before) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'no_change' }); console.log('  치환 무효'); continue; }
  if (!writeRetry(f, after)) { results.push({ mutation: `${m.id} ${m.why}`, applied: false, reason: 'write_locked' }); console.log('  쓰기 잠금'); continue; }

  let applied = build();
  if (applied) {
    // ★ 반영 판정: from 전체 소멸 AND to 전체 삽입 (CRLF 정규화) — 이 리포에서 3번 고친 함정이다.
    const srcNow = norm(fs.readFileSync(f, 'utf8'));
    const distNow = norm(fs.readFileSync(DIST, 'utf8'));
    const okSrc = !srcNow.includes(norm(m.find.source)) && srcNow.includes(norm(m.replace));
    //   dist 는 minify 되므로 원문이 그대로 있지 않다 — src 만 확실히 본다.
    if (!okSrc) { applied = false; console.log('  변이 미반영 (src) — 판정 불가'); }
    else if (!distNow.length) { applied = false; console.log('  dist 비어 있음 — 판정 불가'); }
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
console.log('\n' + JSON.stringify({
  baseline_ok: true, total: results.length, caught, missed, unjudged, restore_failures: restoreFailures, results
}, null, 2));
if (restoreFailures) process.exit(3);
process.exit(caught === results.length ? 0 : 1);
