'use strict';
// E2E finding — the two browser-driven tests hard-coded one platform's browser path, so on any
// other platform they failed with ENOENT regardless of whether a browser was installed.
//
//   flashback_scope_panels_browser_test.cjs   spawn(process.env.CHROME_PATH || '/usr/bin/chromium')
//   source_review_dock_browser_test.cjs       spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe')
//
// On this macOS host Google Chrome IS installed
// (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome), but /usr/bin/chromium and the
// Windows path do not exist, so both tests reported
//     Error: spawn /usr/bin/chromium ENOENT
//     Error: spawn C:/Program Files/Google/Chrome/Application/chrome.exe ENOENT
// and were counted as failures in every regression run. That is an environment-shaped false
// failure: the product code under test was never reached.
//
// CONTRACT: a browser test must RESOLVE a browser rather than assume one path - a shared helper
// that honours CHROME_PATH first and then probes the well-known locations for the host platform
// (macOS app bundles, Linux binaries, Windows install dirs), and fails with a clear, actionable
// message when no browser exists instead of an ENOENT from spawn.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tests = {
  flashback_scope_panels_browser: fs.readFileSync(path.join(__dirname, 'flashback_scope_panels_browser_test.cjs'), 'utf8'),
  source_review_dock_browser: fs.readFileSync(path.join(__dirname, 'source_review_dock_browser_test.cjs'), 'utf8')
};

const observations = {};

// --- 1. No test may hard-code a platform-specific browser path -----------------------------
const HARDCODED = [
  '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:\\\\Program Files\\\\Google\\\\Chrome'
];
for (const [name, source] of Object.entries(tests)) {
  const found = HARDCODED.filter(literal => source.includes(literal));
  observations[`${name}Hardcoded`] = found;
  assert.deepEqual(found, [],
    `${name} must not hard-code a platform browser path (found ${JSON.stringify(found)}): it `
    + `cannot run on any other host and reports an environment failure as a product failure`);
}

// --- 2. Both must use the shared resolver --------------------------------------------------
for (const [name, source] of Object.entries(tests)) {
  const usesResolver = /browser_resolver|resolveChromeExecutable|resolveBrowserExecutable/.test(source);
  observations[`${name}UsesResolver`] = usesResolver;
  assert.equal(usesResolver, true,
    `${name} must obtain its browser from the shared resolver`);
}

// --- 3. The resolver itself must probe the well-known locations and honour CHROME_PATH ------
const resolverPath = path.join(__dirname, 'fixtures', 'browser_resolver.cjs');
assert.ok(fs.existsSync(resolverPath), 'the shared browser resolver must exist');
const resolver = fs.readFileSync(resolverPath, 'utf8');
observations.resolverHonoursEnv = /env\.CHROME_PATH/.test(resolver);
assert.equal(observations.resolverHonoursEnv, true, 'the resolver must honour CHROME_PATH first');
for (const platform of ['darwin', 'linux', 'win32']) {
  observations[`resolverCovers_${platform}`] = resolver.includes(platform);
  assert.ok(resolver.includes(platform), `the resolver must cover ${platform}`);
}

// --- 4. Runtime: on this host the resolver must find the installed browser ------------------
const { resolveChromeExecutable } = require(resolverPath);
const resolved = resolveChromeExecutable();
observations.resolvedPath = resolved;
assert.ok(resolved, 'a browser is installed on this host, so the resolver must find it');
assert.ok(fs.existsSync(resolved), `the resolved browser must exist on disk: ${resolved}`);

// --- 5. When nothing exists, the failure must be actionable, not ENOENT ---------------------
assert.throws(
  () => resolveChromeExecutable({ probe: () => false, env: {} }),
  error => {
    observations.missingMessage = String(error?.message || '').slice(0, 200);
    return /CHROME_PATH|install/i.test(String(error?.message || ''));
  },
  'a host with no browser must get an actionable message telling the operator what to set '
  + '(CHROME_PATH) or install, instead of a bare ENOENT from spawn');

console.log(JSON.stringify({ test: 'browser_executable_resolution', observations }, null, 1));
process.stdout.write('browser_executable_resolution_test: PASS\n');
