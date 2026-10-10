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
//   3. otherwise throw a message that says what to do, rather than letting spawn fail vaguely
const fs = require('node:fs');

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

  const tried = candidatesFor(platform);
  for (const candidate of tried) {
    if (probe(candidate)) return candidate;
  }
  throw new Error(
    `No Chromium-family browser was found on this ${platform} host. Install one (Chrome, `
    + `Chromium, Edge or Brave) or set CHROME_PATH to its executable. Probed: ${tried.join(', ')}`
  );
}

module.exports = { resolveChromeExecutable, candidatesFor };
