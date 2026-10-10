'use strict';
// Negative control for `libra_branch_binding_test.cjs`
//
// 게이트가 통과만 보는 게 아닌지 확인한다 — **실제로 밟았던 결함의 형태**로 소스를 변이한다.
//   M1 메타 계약에서 forkFingerprint 를 뺀다 (정본에 있는 축을 잃는다)
//   M2 결합 키에서 지문을 뺀다 (부모·턴만 보면 fork 지점 이동을 놓친다)
//   M3 바인딩 검사를 통째로 무력화한다 (종전 동작으로 회귀)
//   M4 기록에 hostWorldlineMeta 를 싣지 않는다 (종전 동작으로 회귀)
//   M5 forkTurn 을 lineage 가 아니라 0 으로 박는다 (새 축 발명 대신 값 무력화)
//
// 안전 규칙(스킬): 소스 변이는 **단독 실행**, 원복은 sha256 으로 검증한다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'src/parts/01f-lore-consolidation.js'),
  path.join(ROOT, 'dist/LIBRA World Manager Full.js')
];
const GATE = path.join(ROOT, 'tools/libra_branch_binding_test.cjs');

const MUTATIONS = [
  {
    id: 'M1',
    why: 'forkFingerprint 를 메타에서 뺀다 (정본 계약 축 손실)',
    find: /forkFingerprint: str\(lineage\.prefixDigest\)\.slice\(0, 256\),\r?\n/,
    pick: (m) => m[0]
  },
  {
    id: 'M2',
    why: '결합 키에서 지문을 뺀다 (fork 이동을 못 잡는다)',
    find: /\[str\(m\.parentWorldlineId\), String\(Number\(m\.forkTurn\) \|\| 0\), str\(m\.forkFingerprint\)\]\.join\('\|'\)/,
    pick: (m) => m[0],
    replace: "[str(m.parentWorldlineId), String(Number(m.forkTurn) || 0)].join('|')"
  },
  {
    id: 'M3',
    why: '바인딩 검사를 무력화한다 (종전 already_populated 동작으로 회귀)',
    find: /if \(storedBinding && expectedBinding && storedBinding !== expectedBinding\) \{/,
    pick: (m) => m[0],
    replace: 'if (false && storedBinding && expectedBinding && storedBinding !== expectedBinding) {'
  },
  {
    id: 'M4',
    why: '기록에 hostWorldlineMeta 를 싣지 않는다 (종전 동작으로 회귀)',
    find: /hostWorldlineMeta: LibraHostLineage\.hostWorldlineMetaOf\(lineage, targetScope, Date\.now\(\)\),\r?\n/,
    pick: (m) => m[0]
  },
  {
    id: 'M5',
    why: 'forkTurn 을 lineage 가 아니라 0 으로 박는다 (값 무력화)',
    find: /forkTurn: Number\(lineage\.commonPrefixPairs\) \|\| 0,/,
    pick: (m) => m[0],
    replace: 'forkTurn: 0,'
  }
];

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ★★ 원복은 **메모리 백업**으로 한다. `git checkout` 은 절대 쓰지 않는다.
//    실측 사고: 커밋되지 않은 소스에 git checkout 을 걸어 **작업 전체가 HEAD 로 되돌아갔다**
//    (그 시점 01f 의 미커밋 변경이 통째로 사라졌다 — 다시 작성해야 했다).
//    변이 하네스는 자기 백업만 신뢰해야 한다.
const BACKUP = new Map(TARGETS.map((file) => [file, fs.readFileSync(file)]));
const ORIGINAL = TARGETS.map(sha);
const BACKUP_HASH = new Map(TARGETS.map((file, i) => [file, ORIGINAL[i]]));

const restore = (label) => {
  let ok = true;
  for (const file of TARGETS) {
    if (sha(file) === BACKUP_HASH.get(file)) continue;
    let done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt += 1) {
      try {
        fs.writeFileSync(file, BACKUP.get(file));   // 백업 바이트 그대로
        done = sha(file) === BACKUP_HASH.get(file);
      } catch (_) { /* Windows 파일 잠금 — 재시도 */ }
      if (!done) { try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},120)'], { stdio: 'pipe' }); } catch (_) {} }
    }
    if (!done) { ok = false; console.log(`  원복 실패 ${file} (백업 해시 ${BACKUP_HASH.get(file).slice(0, 12)})`); }
  }
  return ok;
};

const runGate = () => {
  try {
    const out = execFileSync(process.execPath, [GATE], { cwd: ROOT, stdio: 'pipe', timeout: 240000, env: { ...process.env, NODE_PATH: '' } }).toString();
    const i = out.indexOf('{');
    return JSON.parse(out.slice(i));
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || ''));
    const i = out.indexOf('{');
    if (i >= 0) { try { return JSON.parse(out.slice(i)); } catch (_) {} }
    return { ok: false, __crash: out.slice(0, 300) };
  }
};

const results = [];
let restoreFailures = 0;

// 기준선 — 변이 없이 게이트가 통과해야 한다
const baseline = runGate();
console.log(`기준선 ok=${baseline.ok} (${(baseline.assertions || []).filter(a => a.ok).length}/${(baseline.assertions || []).length})`);
if (!baseline.ok) { console.log('기준선이 실패 — 대조군을 진행할 수 없다'); process.exit(2); }

for (const mut of MUTATIONS) {
  const record = { mutation: `${mut.id} ${mut.why}`, caught: false, applied: null };
  let ok = true;
  for (const file of TARGETS) {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(mut.find);
    if (!match) { record.applied = false; console.log(`  ${mut.id}: 앵커 없음 (${path.basename(file)})`); ok = false; break; }
    const from = mut.pick(match);
    const to = mut.replace !== undefined ? mut.replace : '';
    const next = text.replace(from, to);
    if (next === text) { record.applied = false; console.log(`  ${mut.id}: 치환 무효 (${path.basename(file)})`); ok = false; break; }
    let written = false;
    for (let attempt = 0; attempt < 5 && !written; attempt += 1) {
      try { fs.writeFileSync(file, next); written = true; } catch (_) { /* Windows 파일 잠금 */ }
    }
    if (!written) { record.applied = false; console.log(`  ${mut.id}: 쓰기 실패 (${path.basename(file)})`); ok = false; break; }
  }
  if (ok) {
    // 반영 확인은 **from 소멸** 기준 (to 의 첫 줄은 다른 곳에도 있을 수 있다)
    const srcNow = fs.readFileSync(TARGETS[0], 'utf8');
    const distNow = fs.readFileSync(TARGETS[1], 'utf8');
    const first = mut.find.source.split('\\r?\\n')[0];
    const stillThere = srcNow.match(mut.find) !== null;
    if (stillThere) { record.applied = false; console.log(`  ${mut.id}: 변이 미반영 — 판정 불가`); }
    else {
      record.applied = true;
      const res = runGate();
      record.caught = res.ok === false;
      record.failures = (res.assertions || []).filter(a => !a.ok).map(a => a.name);
      if (res.__crash) record.crash = res.__crash;
    }
  }
  if (!restore(mut.id)) restoreFailures += 1;
  results.push(record);
  const tag = record.caught ? 'CAUGHT' : (record.applied === false ? '판정불가' : 'MISS');
  console.log(`  ${tag}  ${record.mutation}`);
  if (record.failures && record.failures.length) console.log(`         → ${record.failures.slice(0, 3).join(', ')}`);
}

const caught = results.filter(r => r.caught).length;
const missed = results.filter(r => r.applied === true && !r.caught).length;
const unjudged = results.filter(r => r.applied === false).length;
console.log(JSON.stringify({
  baseline_ok: baseline.ok,
  total: results.length, caught, missed, unjudged, restore_failures: restoreFailures,
  results
}, null, 2));
process.exit(caught === results.length ? 0 : 1);
