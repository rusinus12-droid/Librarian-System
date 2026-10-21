'use strict';
// Shared browser executable resolver for the DOM/browser-driven tests.
//
// The tests that drive a real browser (flashback_scope_panels_browser_test,
// source_review_dock_browser_test) used to spawn a hard-coded path for one platform, so on any
// other host they died with `spawn ... ENOENT` and were counted as product failures even when a
// capable browser was installed. Resolve instead of assume:
//
//   1. CHROME_PATH wins when set (explicit operator override)
//   2. otherwise probe the well-known install locations for the host platform
//   3. then Playwright-managed Chromium builds (PLAYWRIGHT_BROWSERS_PATH, else Playwright's
//      default cache), which is how CI images and cloud containers usually ship a browser
//   4. otherwise throw a message that says what to do, rather than letting spawn fail vaguely
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// One entry per (platform, product) in preference order. Chromium-family browsers all speak the
// Chrome DevTools Protocol these tests use, so any of them is acceptable.
const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    '/opt/homebrew/bin/chromium',
    '/usr/local/bin/chromium'
  ],
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/snap/bin/chromium',
    '/usr/local/bin/chromium'
  ],
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Chromium/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'
  ]
};

const exists = candidate => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function candidatesFor(platform) {
  return CANDIDATES[platform] || CANDIDATES.linux;
}

// Executables inside Playwright's browser directories, newest Chromium build first.
const PLAYWRIGHT_EXECUTABLES = {
  linux: ['chrome-linux/chrome', 'chrome-linux64/chrome'],
  darwin: ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'],
  win32: ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']
};
function playwrightCandidatesFor(platform, env, home = (() => { try { return os.homedir(); } catch { return ''; } })()) {
  const roots = [];
  const configured = String(env.PLAYWRIGHT_BROWSERS_PATH || '').trim();
  if (configured && configured !== '0') roots.push(configured);
  if (platform === 'darwin' && home) roots.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (platform === 'win32') roots.push(path.join(String(env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '')), 'ms-playwright'));
  else if (home) roots.push(path.join(home, '.cache', 'ms-playwright'));
  const out = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch { continue; }
    for (const entry of entries) for (const relative of PLAYWRIGHT_EXECUTABLES[platform] || PLAYWRIGHT_EXECUTABLES.linux) out.push(path.join(root, entry, relative));
  }
  return out;
}

// Returns an executable path, or throws an actionable error naming CHROME_PATH.
function resolveChromeExecutable(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const probe = options.probe || exists;

  const override = String(env.CHROME_PATH || '').trim();
  if (override) {
    if (probe(override)) return override;
    throw new Error(
      `CHROME_PATH is set to '${override}' but that executable does not exist or is not `
      + `executable. Point CHROME_PATH at a Chromium-family browser, or unset it to let the `
      + `test probe the standard install locations for ${platform}.`
    );
  }

  const tried = [...candidatesFor(platform), ...playwrightCandidatesFor(platform, env)];
  for (const candidate of tried) {
    if (probe(candidate)) return candidate;
  }
  throw new Error(
    `No Chromium-family browser was found on this ${platform} host. Install one (Chrome, `
    + `Chromium, Edge or Brave) or set CHROME_PATH to its executable. Probed: ${tried.join(', ')}`
  );
}

module.exports = { resolveChromeExecutable, candidatesFor, playwrightCandidatesFor };
