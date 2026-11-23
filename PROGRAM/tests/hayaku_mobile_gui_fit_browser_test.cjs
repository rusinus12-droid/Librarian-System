'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { resolveChromeExecutable } = require('./fixtures/browser_resolver.cjs');

const program = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-mobile-fit-'));
const socketTmp = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'hk-chrome-'));
const stderrFile = path.join(profile, 'chromium.stderr.log');
fs.mkdirSync(path.join(profile, 'config'), { recursive: true });
fs.mkdirSync(path.join(profile, 'cache'), { recursive: true });

const chrome = spawn(resolveChromeExecutable(), [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
], {
  windowsHide: true,
  env: {
    ...process.env,
    TMPDIR: socketTmp,
    XDG_CONFIG_HOME: path.join(profile, 'config'),
    XDG_CACHE_HOME: path.join(profile, 'cache')
  },
  stdio: ['ignore', 'ignore', fs.openSync(stderrFile, 'a')]
});

let chromeExit = null;
chrome.on('error', error => { chromeExit = { error: error.message }; });
chrome.on('exit', (code, signal) => { chromeExit = { code, signal }; });

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
const watchdog = setTimeout(() => {
  console.error('HAYAKU mobile layout browser test timed out');
  try { chrome.kill(); } catch (_) {}
  process.exit(1);
}, 45000);

(async () => {
  let port;
  for (let i = 0; i < 120; i += 1) {
    try {
      port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      if (port) break;
    } catch (_) {}
    if (chromeExit) break;
    await pause(100);
  }
  if (!port && chromeExit) {
    console.log(JSON.stringify({ test: 'hayaku_mobile_gui_fit_browser', result: 'NOT_RUN', reason: 'Chrome exited before exposing DevTools', chromeExit }));
    process.exitCode = 77;
    return;
  }
  assert.ok(port, 'Chrome DevTools endpoint starts');

  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));

  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };

  await call('Page.enable');
  await call('Runtime.enable');
  const tree = await call('Page.getFrameTree');
  await call('Page.setDocumentContent', {
    frameId: tree.frameTree.frame.id,
    html: '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"></body></html>'
  });

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(fs.readFileSync(path.join(program, 'tests', 'browser', 'hayaku_browser_host.js'), 'utf8'));
  await evaluate(`
    window.__hideCount = 0;
    if (window.risuai) {
      window.risuai.hideContainer = async () => { window.__hideCount += 1; return true; };
    }
  `);
  await evaluate(fs.readFileSync(path.join(program, 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8'));
  await evaluate(`(async () => {
    const deadline = Date.now() + 5000;
    while (!window.HAYAKU && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    if (!window.HAYAKU) throw new Error('HAYAKU global did not initialize');
    await window.HAYAKU.showUi();
    return true;
  })()`);

  const measureHeader = async () => evaluate(`(() => {
    const q = s => document.querySelector(s);
    const box = n => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const app = q('.app');
    const top = q('.topbar');
    const close = q('#closeHayakuViewer');
    const menu = q('.topbar [data-menu]');
    const visibleChildren = [...top.children].filter(el => {
      if (el.hidden) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0.5 && r.height > 0.5;
    });
    const childBoxes = visibleChildren.map(el => ({ id: el.id || el.className, ...box(el) }));
    const overlaps = [];
    for (let i = 1; i < childBoxes.length; i += 1) {
      if (childBoxes[i].x < childBoxes[i - 1].right - 0.5) {
        overlaps.push([childBoxes[i - 1].id, childBoxes[i].id, childBoxes[i - 1].right, childBoxes[i].x]);
      }
    }
    const closeRect = box(close);
    const closeHit = document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2);
    const menuRect = box(menu);
    const menuHit = document.elementFromPoint(menuRect.x + menuRect.width / 2, menuRect.y + menuRect.height / 2);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      appOverflow: app.scrollWidth - app.clientWidth,
      topOverflow: top.scrollWidth - top.clientWidth,
      app: box(app),
      top: box(top),
      close: closeRect,
      menu: menuRect,
      closeIsLast: top.lastElementChild === close,
      closeClickable: Boolean(closeHit && (close === closeHit || close.contains(closeHit))),
      menuClickable: Boolean(menuHit && (menu === menuHit || menu.contains(menuHit))),
      overlaps
    };
  })()`);

  const viewports = [
    [320, 640],
    [360, 780],
    [375, 812],
    [390, 844],
    [414, 896],
    [480, 844],
    [560, 844],
    [640, 844],
    [844, 390],
    [900, 844],
    [1280, 900]
  ];

  const assertViewportFit = async (label, [width, height]) => {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 640
    });
    await pause(30);
    const m = await measureHeader();
    assert.ok(m.docOverflow <= 1, `${label} @ ${width}x${height}: document horizontal overflow: ${JSON.stringify(m)}`);
    assert.ok(m.appOverflow <= 1, `${label} @ ${width}x${height}: .app horizontal overflow: ${JSON.stringify(m)}`);
    assert.ok(m.topOverflow <= 1, `${label} @ ${width}x${height}: .topbar horizontal overflow: ${JSON.stringify(m)}`);
    assert.equal(m.overlaps.length, 0, `${label} @ ${width}x${height}: header controls overlap: ${JSON.stringify(m.overlaps)}`);
    assert.ok(m.closeIsLast, `${label} @ ${width}x${height}: #closeHayakuViewer must be last element in .topbar`);
    assert.ok(m.close.width >= 30 && m.close.height >= 30, `${label} @ ${width}x${height}: #closeHayakuViewer collapsed: ${JSON.stringify(m.close)}`);
    assert.ok(m.close.x >= m.top.x - 1 && m.close.right <= m.top.right + 1 && m.close.y >= m.top.y - 1 && m.close.bottom <= m.top.bottom + 1,
      `${label} @ ${width}x${height}: #closeHayakuViewer clipped outside .topbar: ${JSON.stringify(m)}`);
    assert.ok(m.close.right <= width + 1 && m.close.x >= -1, `${label} @ ${width}x${height}: #closeHayakuViewer outside viewport: ${JSON.stringify(m.close)}`);
    assert.ok(m.menu.x >= m.top.x - 1 && m.menu.right <= m.top.right + 1, `${label} @ ${width}x${height}: menu button outside .topbar: ${JSON.stringify(m.menu)}`);
    assert.ok(m.closeClickable, `${label} @ ${width}x${height}: #closeHayakuViewer not hit-testable at center`);
    assert.ok(m.menuClickable, `${label} @ ${width}x${height}: menu button not hit-testable at center`);
    assert.ok(Math.abs((m.app.x + m.app.width / 2) - width / 2) <= 1.5, `${label} @ ${width}x${height}: .app horizontally off-center: ${JSON.stringify(m.app)}`);
    assert.ok(Math.abs((m.app.y + m.app.height / 2) - height / 2) <= 1.5, `${label} @ ${width}x${height}: .app vertically off-center: ${JSON.stringify(m.app)}`);
    return m;
  };

  // Phase 1: Default state across all 11 viewports
  const measurements = [];
  for (const vp of viewports) {
    measurements.push({ phase: 'default', ...(await assertViewportFit('default', vp)) });
  }

  // Phase 2: Reproduce screenshot worst-case header badges (Other Ax + 복구 검토) & Recovery tab
  await evaluate(`(() => {
    const mode = document.querySelector('#hayakuHeaderPacketMode');
    if (mode) {
      mode.classList.add('is-otherax');
      const mt = mode.querySelector('[data-mode-text]');
      if (mt) mt.textContent = 'Other Ax';
    }
    const health = document.querySelector('#hayakuViewerHealth');
    if (health) {
      health.classList.remove('health--ok', 'health--danger');
      health.classList.add('health--warn');
      const ht = health.querySelector('[data-health-text]');
      if (ht) ht.textContent = '복구 검토';
    }
    document.querySelector('.tabbar [data-go="recovery"]')?.click();
    return true;
  })()`);
  await pause(40);

  for (const vp of viewports) {
    measurements.push({ phase: 'recovery-otherax-warn', ...(await assertViewportFit('recovery-otherax-warn', vp)) });
  }

  // Verify longest health label ("상태 확인 필요") on narrowest 320px & common 360px
  await evaluate(`(() => {
    const health = document.querySelector('#hayakuViewerHealth');
    if (health) {
      health.classList.remove('health--warn');
      health.classList.add('health--danger');
      const ht = health.querySelector('[data-health-text]');
      if (ht) ht.textContent = '상태 확인 필요';
    }
    return true;
  })()`);
  for (const vp of [[320, 640], [360, 780], [390, 844]]) {
    measurements.push({ phase: 'longest-health', ...(await assertViewportFit('longest-health', vp)) });
  }

  // On 360x780, verify Recovery page title is not clipped beneath .topbar, menu opens within viewport, and close button closes viewer
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await pause(30);
  const recoveryTitle = await evaluate(`(() => {
    const top = document.querySelector('.topbar').getBoundingClientRect();
    const title = document.querySelector('#hayakuViewerPanelRecovery .page-title').getBoundingClientRect();
    const pageBody = document.querySelector('.page-body');
    return {
      topBottom: top.bottom,
      titleTop: title.top,
      pageBodyScrollTop: pageBody.scrollTop
    };
  })()`);
  assert.ok(recoveryTitle.titleTop >= recoveryTitle.topBottom - 1, `Recovery title clipped beneath topbar: ${JSON.stringify(recoveryTitle)}`);

  const menuPanelRect = await evaluate(`(() => {
    document.querySelector('.topbar [data-menu]').click();
    const panel = document.querySelector('.topbar .menu__panel');
    const r = panel.getBoundingClientRect();
    const visible = getComputedStyle(panel).display !== 'none' && r.width > 0 && r.height > 0;
    document.querySelector('.topbar [data-menu]').click();
    return { visible, left: r.left, right: r.right, width: window.innerWidth };
  })()`);
  assert.ok(menuPanelRect.visible, 'Menu panel opens on mobile');
  assert.ok(menuPanelRect.left >= -1 && menuPanelRect.right <= menuPanelRect.width + 1, `Menu panel clipped outside mobile viewport: ${JSON.stringify(menuPanelRect)}`);

  const closedCount = await evaluate(`(async () => {
    document.querySelector('#closeHayakuViewer').click();
    await new Promise(r => setTimeout(r, 30));
    return window.__hideCount;
  })()`);
  assert.ok(closedCount >= 1, 'Clicking #closeHayakuViewer on 360px mobile closes the HAYAKU viewer');

  console.log(JSON.stringify({
    test: 'hayaku_mobile_gui_fit_browser_test',
    result: 'pass',
    viewportsTested: viewports.length,
    totalChecks: measurements.length,
    closedCount
  }));
  await call('Browser.close');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(watchdog);
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(socketTmp, { recursive: true, force: true }); } catch (_) {}
});
