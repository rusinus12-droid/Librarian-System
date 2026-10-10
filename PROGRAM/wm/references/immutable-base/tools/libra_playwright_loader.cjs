'use strict';
// 게이트용 playwright 로더.
//
// 왜 필요한가:
//   `playwright` 는 이 저장소의 의존성이 아니다 (devDependencies 는 terser 뿐).
//   Chromium 렌더가 필요한 게이트들은 npx 캐시에 있는 playwright 를 NODE_PATH 로
//   지정해 쓰거나 로컬 설치를 쓴다. 그런데 `require('playwright')` 를 그냥 쓰면
//   캐시 경로가 없는 환경에서 **MODULE_NOT_FOUND 로 그냥 죽어** 게이트가 실패한 것처럼 보인다.
//   실측: `npm test` 계열에서 `libra_entity_name_blocklist_test` 가
//   `Cannot find module 'playwright'` 로 exit 1 을 냈다 — 코드 결함이 아닌데도 실패로 집계됐다.
//
// 정책:
//   ① 로컬 node_modules → ② NODE_PATH → ③ npx 캐시(자동 탐색) → ④ 없으면 명확한 안내.
//   찾으면 `{ chromium }` 반환. 못 찾으면 null 과 안내 문자열을 돌려준다 —
//   호출자가 **skip(exit 2)** 할지 판단하게 한다. 조용히 실패하지 않는다.
//
// 사용:
//   const { loadPlaywright } = require('./libra_playwright_loader.cjs');
//   const pw = loadPlaywright();
//   if (!pw) { console.error(pw?.hint || ''); process.exit(2); }   // 또는 skip 처리
//   const browser = await pw.chromium.launch();

const fs = require('fs');
const path = require('path');

const NPX_CACHE_ROOT = path.join(
  process.env.LOCALAPPDATA || process.env.HOME || '',
  'npm-cache', '_npx'
);

const HINT = [
  'playwright 를 찾을 수 없습니다 (이 저장소의 의존성이 아닙니다).',
  'Chromium 렌더가 필요한 게이트입니다. 다음 중 하나로 준비하세요:',
  '  npx playwright install chromium   # 또는',
  '  export NODE_PATH="$(ls -d "$LOCALAPPDATA/npm-cache/_npx"/*/node_modules 2>/dev/null | head -1)"',
  '게이트는 playwright 부재를 실패가 아니라 skip(exit 2) 으로 처리합니다.'
].join('\n');

// npx 캐시에서 playwright 가 있는 node_modules 디렉터리를 찾는다.
const findNpxModuleDirs = () => {
  const dirs = [];
  try {
    if (!NPX_CACHE_ROOT || !fs.existsSync(NPX_CACHE_ROOT)) return dirs;
    for (const entry of fs.readdirSync(NPX_CACHE_ROOT)) {
      const nm = path.join(NPX_CACHE_ROOT, entry, 'node_modules');
      try {
        if (fs.existsSync(path.join(nm, 'playwright'))) dirs.push(nm);
      } catch (_) { /* 권한/경합 무시 */ }
    }
  } catch (_) { /* 캐시 없음 */ }
  return dirs;
};

const tryRequire = (mod) => { try { return require(mod); } catch (_) { return null; } };

// Optional test-runner executable selection. Default Playwright behavior is unchanged.
const withConfiguredExecutable = playwright => {
  const executablePath = String(process.env.LIBRA_PLAYWRIGHT_EXECUTABLE_PATH || '').trim();
  if (!executablePath) return playwright;
  if (!path.isAbsolute(executablePath)) throw new Error('LIBRA_PLAYWRIGHT_EXECUTABLE_PATH must be absolute');
  try {
    if (!fs.statSync(executablePath).isFile()) throw new Error('not a file');
    fs.accessSync(executablePath, fs.constants.X_OK);
  } catch (_) { throw new Error('LIBRA_PLAYWRIGHT_EXECUTABLE_PATH must name an existing executable'); }
  const chromium = Object.create(playwright.chromium);
  chromium.launch = (options = {}) => playwright.chromium.launch({ ...options, executablePath: options.executablePath || executablePath });
  return Object.assign(Object.create(playwright), { chromium });
};

const loadPlaywright = () => {
  // ① 기본 require (로컬 node_modules 또는 이미 지정된 NODE_PATH)
  const direct = tryRequire('playwright');
  if (direct && direct.chromium) return withConfiguredExecutable(direct);

  // ② npx 캐시 자동 탐색 — 경로를 NODE_PATH 에 넣고 재시도
  for (const nm of findNpxModuleDirs()) {
    const prev = process.env.NODE_PATH || '';
    process.env.NODE_PATH = prev ? `${nm}${path.delimiter}${prev}` : nm;
    try { require('module').Module._initPaths(); } catch (_) { /* 실패해도 아래 직접 경로 시도 */ }
    const viaPath = tryRequire('playwright');
    if (viaPath && viaPath.chromium) return withConfiguredExecutable(viaPath);
    // ③ 캐시 모듈을 절대 경로로 직접 require (NODE_PATH 초기화가 안 먹는 런타임 대비)
    const byPath = tryRequire(path.join(nm, 'playwright'));
    if (byPath && byPath.chromium) return withConfiguredExecutable(byPath);
  }

  const result = null;
  // 호출자가 hint 를 읽을 수 있게 함수에 붙인다 (null 반환과 함께 쓰기 위함).
  loadPlaywright.hint = HINT;
  return result;
};

loadPlaywright.hint = HINT;
loadPlaywright.findNpxModuleDirs = findNpxModuleDirs;

module.exports = { loadPlaywright, PLAYWRIGHT_HINT: HINT, findNpxModuleDirs };
