'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { resolveChromeExecutable } = require('./fixtures/browser_resolver.cjs');

test('Playwright browser discovery honors explicit paths, newest builds and available fallback without requiring Chrome', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-resolution-'));
  try {
    for (const build of ['chromium-99', 'chromium-100', 'chromium-headless-shell-999']) fs.mkdirSync(path.join(cache, build));
    const newest = path.join(cache, 'chromium-100', 'chrome-linux64/chrome');
    const older = path.join(cache, 'chromium-99', 'chrome-linux/chrome');
    const env = { PLAYWRIGHT_BROWSERS_PATH: cache }, available = new Set([newest, older]);
    const options = { platform: 'linux', env, probe: candidate => available.has(candidate) };
    assert.equal(resolveChromeExecutable(options), newest);
    available.delete(newest); assert.equal(resolveChromeExecutable(options), older);
    assert.equal(resolveChromeExecutable({ ...options, env: { ...env, CHROME_PATH: '/explicit/chrome' },
      probe: candidate => candidate === '/explicit/chrome' || available.has(candidate) }), '/explicit/chrome');
    assert.throws(() => resolveChromeExecutable({ ...options, env: { ...env, CHROME_PATH: '/missing' } }), /CHROME_PATH/);
    available.clear(); assert.throws(() => resolveChromeExecutable(options), /No Chromium-family browser/);
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});
