'use strict';
// C 게이트: playwright 로더가 *깨끗한 환경*에서도 동작하고, 없을 때 skip 하는가.
//
// 왜 게이트가 필요한가:
//   이 저장소는 playwright 를 의존성으로 두지 않는다. 그런데 3개 게이트가 Chromium 렌더를 쓴다.
//   `require('playwright')` 를 그냥 쓰면 캐시 경로가 없는 환경에서 MODULE_NOT_FOUND 로 죽고,
//   그게 **코드 결함이 아닌데 실패로 집계**됐다 (실측: entity_name_blocklist exit 1).
//
// 판정 항목:
//   P1 로더가 playwright 를 찾는다 (npx 캐시 자동 탐색)
//   P2 NODE_PATH 를 제거한 자식 프로세스에서도 3개 게이트가 exit 0
//   P3 playwright 를 *찾을 수 없는* 환경에서 skip(exit 2) 하고 안내를 낸다  ← 실패 대조군
//   P4 로더가 못 찾으면 null 을 반환한다 (조용히 실패하지 않는다)
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOADER = path.join(ROOT, 'tools', 'libra_playwright_loader.cjs');
const PW_GATES = [
  'tools/libra_entity_name_blocklist_test.cjs',
  'tools/libra_rp_long_term_conflict_test.cjs'
];

const out = { ok: false, assertions: [], measurements: {} };
const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });

// ── P1: 로더가 찾는다 ────────────────────────────────────────────────────
let loaderMod = null;
try { loaderMod = require(LOADER); } catch (e) { out.measurements.loaderThrow = String(e?.message); }
out.measurements.loaderExists = !!loaderMod;
let found = null;
try { found = loaderMod ? loaderMod.loadPlaywright() : null; } catch (e) { out.measurements.findThrow = String(e?.message); }
out.measurements.npxDirs = loaderMod ? loaderMod.findNpxModuleDirs() : [];
out.measurements.foundChromium = !!(found && found.chromium);

// ── P2: 깨끗한 환경(NODE_PATH 제거)에서 게이트 통과 ──────────────────────
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_PATH;
const cleanResults = {};
for (const rel of PW_GATES) {
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT, env: cleanEnv, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024
  });
  const stdout = String(r.stdout || '');
  cleanResults[rel] = {
    status: r.status,
    ok: /"ok":\s*true/.test(stdout),
    stderrHead: String(r.stderr || '').slice(0, 160)
  };
}
out.measurements.cleanEnvResults = cleanResults;

// ── P3/P4: playwright 를 못 찾는 환경 (실패 대조군) ─────────────────────
//   로더가 참조하는 캐시 루트를 NODE_PATH 없이 + LOCALAPPDATA 를 빈 임시 경로로 돌려
//   탐색이 실패하게 만든다. 호출 게이트가 skip(exit 2) + 안내를 내야 한다.
const tmpLocal = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'pw_absent_probe');
try { fs.mkdirSync(tmpLocal, { recursive: true }); } catch (_) {}
const absentEnv = { ...process.env, LOCALAPPDATA: tmpLocal };
delete absentEnv.NODE_PATH;

const absentLoader = spawnSync(process.execPath, ['-e',
  `const m=require(${JSON.stringify(LOADER)});const pw=m.loadPlaywright();` +
  `console.log(JSON.stringify({found:!!pw,hasHint:typeof m.PLAYWRIGHT_HINT==='string'&&m.PLAYWRIGHT_HINT.length>0}));`
], { cwd: ROOT, env: absentEnv, encoding: 'utf8', timeout: 60000 });
let absentParsed = null;
try { absentParsed = JSON.parse(String(absentLoader.stdout || '').trim().split('\n').pop()); } catch (_) {}
out.measurements.absentLoaderResult = absentParsed;

const absentGate = spawnSync(process.execPath, [path.join(ROOT, PW_GATES[0])],
  { cwd: ROOT, env: absentEnv, encoding: 'utf8', timeout: 120000 });
out.measurements.absentGateStatus = absentGate.status;
out.measurements.absentGateStderr = String(absentGate.stderr || '').slice(0, 200);

// ── 판정 ─────────────────────────────────────────────────────────────────
assert('P1: 로더가 playwright 를 찾는다 (npx 캐시 자동 탐색)',
  out.measurements.foundChromium === true,
  { dirs: out.measurements.npxDirs, found: out.measurements.foundChromium, throw: out.measurements.findThrow });

const cleanOk = PW_GATES.every(rel => cleanResults[rel].status === 0 && cleanResults[rel].ok);
assert('P2: [핵심] NODE_PATH 없이도 Chromium 게이트가 통과한다',
  cleanOk,
  cleanResults);

assert('P4: [대조군] playwright 가 없으면 로더가 null 을 반환한다',
  absentParsed && absentParsed.found === false,
  { absentLoader: absentParsed });

assert('P3: [대조군] playwright 가 없으면 게이트가 skip(exit 2) + 안내를 낸다',
  out.measurements.absentGateStatus === 2 && /playwright 를 찾을 수 없습니다/.test(String(out.measurements.absentGateStderr || '')),
  { status: out.measurements.absentGateStatus, stderr: out.measurements.absentGateStderr });

out.ok = out.assertions.every(a => a.ok);
console.log(JSON.stringify(out, null, 2));
