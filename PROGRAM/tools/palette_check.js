// Renders each plugin's palette in real Chrome in BOTH states -- colour following off (the
// hand-tuned palette, the default) and on (the host-mapped palette) -- and asserts:
//   * elevation: cards must sit ABOVE the background in both states (the bug that made the
//     panels look flat was cards sinking below it),
//   * accent saturation must stay close to each plugin's designed hue,
//   * muted text must clear WCAG AA (4.5:1) in both states.
// Also writes a side-by-side screenshot so the two states can be compared by eye.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Chrome is discovered per platform rather than pinned to one machine's install path, and the
// plugin directory is derived from this file's own location — the previous absolute Windows paths
// made the tool unusable anywhere else, including in the Source distribution that ships tools/.
const chromeCandidates = [
  process.env.CHROME_PATH,
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);
const CHROME = chromeCandidates.find(candidate => { try { return fs.existsSync(candidate); } catch (_) { return false; } });
if (!CHROME) throw new Error('chrome_not_found: set CHROME_PATH to the browser executable');
const D = path.resolve(__dirname, '..', 'plugins') + path.sep;
const OUT = path.join(process.env.KIROCREW_SCRATCH || '.', 'palette_check');
const PORT = 9344;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pull each plugin's palette declarations straight out of its stylesheet.
function grab(file, startNeedle, endNeedle) {
  const text = fs.readFileSync(D + file, 'utf8').replace(/\r\n/g, '\n');
  const a = text.indexOf(startNeedle);
  if (a < 0) throw new Error(file + ': start not found: ' + startNeedle);
  const b = text.indexOf(endNeedle, a);
  if (b < 0) throw new Error(file + ': end not found');
  return text.slice(a, b + endNeedle.length).replace(/\$\{LEDGER_VIEWER_ROOT_ID\}/g, 'hvRoot');
}

const BASE = {
  // The built-in palettes, exactly as the plugins declare them.
  flashback: grab('Flashback_Memory.js', ':root{--bg:#0b0e14;', '}'),
  // Anchored on the declaration, not the interpolated selector, then re-wrapped: the
  // viewer's root selector is a template expression and is fragile to match on.
  hayaku: '#hvRoot{' + grab('HAYAKU_Locator_Continuity.js', '--hv-bg:#f4f7fb;', '}'),
  libra: grab('LIBRA.js', ':root{color-scheme:normal;--sga-vh:100vh;', '}'),
};
const MAPPED = {
  flashback: grab('Flashback_Memory.js', ':root[data-risu-theme-colors="1"] .vrmDesign,:root[data-risu-theme-colors="1"]{', '\n    }'),
  hayaku: grab('HAYAKU_Locator_Continuity.js', ':root[data-risu-theme-colors="1"] #${LEDGER_VIEWER_ROOT_ID}{', '\n      }'),
  libra: grab('LIBRA.js', ':root[data-risu-theme-colors="1"]{', '\n    }'),
};
// The contrast correction lives in a SECOND block, later in each stylesheet, and must be
// included or the probe measures the host's raw secondary colour instead of the corrected one.
const CONTRAST = {
  flashback: grab('Flashback_Memory.js', '  :root[data-risu-theme-colors="1"] .vrmDesign,:root[data-risu-theme-colors="1"]{\n    --text2:', '\n  }'),
  // Reaches past the host-theme correction to include the built-in light-palette correction
  // on the following line, which is the rule that governs the default (colours off) state.
  hayaku: grab('HAYAKU_Locator_Continuity.js', '  :root[data-risu-theme-colors="1"] #${LEDGER_VIEWER_ROOT_ID}{\n    --hv-muted:', 'var(--hv-text) 68%,var(--hv-bg))}'),
  libra: grab('LIBRA.js', '  :root[data-risu-theme-colors="1"]{\n    --sga-muted:', '\n  }'),
};

const HOST = {
  bgcolor: '#282a36', darkbg: '#21222c', borderc: '#6272a4', selected: '#44475a',
  draculared: '#ff5555', textcolor: '#f8f8f2', textcolor2: '#64748b',
  darkborderc: '#4b5563', darkbutton: '#374151',
};

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${Object.entries(HOST).map(([k, v]) => `--risu-theme-${k}:${v}`).join(';')};--ms-mix-muted:62%}
${BASE.flashback}
${BASE.libra}
${BASE.hayaku}
${MAPPED.flashback}
${MAPPED.hayaku}
${MAPPED.libra}
${CONTRAST.flashback}
${CONTRAST.hayaku}
${CONTRAST.libra}
.probe{padding:10px;font:12px system-ui}
.fb{background:var(--bg);color:var(--text)} .fb .card{background:var(--surface)} .fb .card2{background:var(--surface2)}
#hvRoot{background:var(--hv-bg);color:var(--hv-text)} #hvRoot .card{background:var(--hv-card)}
.sga{background:var(--sga-bg);color:var(--sga-text)} .sga .card{background:var(--sga-surface)}
.swatch{height:22px;margin:2px 0;border-radius:4px}
</style></head><body>
<div class="probe fb" id="fb"><div class="swatch card" id="fbCard"></div><div class="swatch card2" id="fbCard2"></div><span id="fbMuted" style="color:var(--text2)">보조</span><span id="fbAccent" style="color:var(--accent)">강조</span></div>
<div class="probe" id="hvRoot"><div class="swatch card" id="hvCard"></div><span id="hvMuted" style="color:var(--hv-muted)">보조</span><span id="hvAccent" style="color:var(--hv-primary)">강조</span></div>
<div class="probe sga" id="sga"><div class="swatch card" id="sgaCard"></div><span id="sgaMuted" style="color:var(--sga-muted)">보조</span><span id="sgaAccent" style="color:var(--sga-accent)">강조</span></div>
</body></html>`;

const pageFile = path.join(OUT, 'palette.html');
fs.writeFileSync(pageFile, page, 'utf8');

const getJson = p => new Promise((res, rej) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 4000 }, r => {
    let b = ''; r.on('data', c => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout')));
});

(async () => {
  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=900,420', 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 40 && !targets; i += 1) { await sleep(500); try { targets = await getJson('/json/list'); } catch (_) {} }
  if (!targets) { chrome.kill(); console.log('FATAL: chrome did not start'); process.exit(3); }
  const t = targets.find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };

  const rows = [];
  const check = (label, ok, detail = '') => rows.push({ label, ok: !!ok, detail });

  const READ = `(() => {
    const parse = css => {
      const s = String(css || '');
      const sr = /color\\(srgb\\s+([-\\d.eE]+)\\s+([-\\d.eE]+)\\s+([-\\d.eE]+)/.exec(s);
      if (sr) return [1,2,3].map(i => Math.max(0, Math.min(255, Math.round(parseFloat(sr[i]) * 255))));
      const m = /rgba?\\(([^)]+)\\)/.exec(s);
      if (!m) return null;
      const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2]];
    };
    const lin = c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const lum = a => 0.2126 * lin(a[0]) + 0.7152 * lin(a[1]) + 0.0722 * lin(a[2]);
    const ratio = (a, b) => { const s = [lum(a), lum(b)].sort((p, q) => q - p); return (s[0] + 0.05) / (s[1] + 0.05); };
    const satOf = a => { const mx = Math.max(...a) / 255, mn = Math.min(...a) / 255, l = (mx + mn) / 2;
      return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); };
    const bgOf = sel => parse(getComputedStyle(document.querySelector(sel)).backgroundColor);
    const fgOf = sel => parse(getComputedStyle(document.querySelector(sel)).color);
    const one = (rootSel, cardSel, mutedSel, accentSel) => {
      const bg = bgOf(rootSel), card = bgOf(cardSel);
      return {
        bgL: Number(lum(bg).toFixed(4)),
        cardL: Number(lum(card).toFixed(4)),
        cardAbove: lum(card) > lum(bg),
        step: Number(Math.abs(lum(card) - lum(bg)).toFixed(4)),
        mutedRatio: Number(ratio(fgOf(mutedSel), bg).toFixed(2)),
        accentSat: Number((satOf(fgOf(accentSel)) * 100).toFixed(0)),
      };
    };
    return {
      flashback: one('#fb', '#fbCard', '#fbMuted', '#fbAccent'),
      hayaku: one('#hvRoot', '#hvCard', '#hvMuted', '#hvAccent'),
      libra: one('#sga', '#sgaCard', '#sgaMuted', '#sgaAccent'),
    };
  })()`;

  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: 'file:///' + pageFile.replace(/\\/g, '/') });
    await sleep(2000);

    const states = {};
    for (const [name, on] of [['off', false], ['on', true]]) {
      await evaluate(`(() => {
        const r = document.documentElement;
        r.setAttribute('data-risu-theme','1');
        r.setAttribute('data-risu-theme-type','dark');
        ${on ? "r.setAttribute('data-risu-theme-colors','1')" : "r.removeAttribute('data-risu-theme-colors')"};
        return true;
      })()`);
      await sleep(250);
      states[name] = await evaluate(READ);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, 'palette-' + name + '.png'), Buffer.from(shot.data, 'base64'));
    }
    fs.writeFileSync(path.join(OUT, 'states.json'), JSON.stringify(states, null, 2), 'utf8');

    for (const [name, state] of Object.entries(states)) {
      const label = name === 'off' ? '자체 팔레트' : '호스트 추종';
      for (const plugin of ['flashback', 'hayaku', 'libra']) {
        const m = state[plugin];
        check(`${label} · ${plugin}: 카드가 배경 위에`, m.cardAbove === true, 'bgL=' + m.bgL + ' cardL=' + m.cardL);
        check(`${label} · ${plugin}: 카드-배경 분리 존재`, m.step >= 0.004, 'step=' + m.step);
        check(`${label} · ${plugin}: 보조 글자 4.5:1 이상`, m.mutedRatio >= 4.5, m.mutedRatio + ':1');
        check(`${label} · ${plugin}: 강조색 채도 55% 이상`, m.accentSat >= 55, m.accentSat + '%');
      }
    }
    console.log('screenshots: ' + path.join(OUT, 'palette-off.png') + ' / palette-on.png');
  } finally {
    try { await send('Browser.close'); } catch (_) {}
    try { chrome.kill(); } catch (_) {}
  }

  const pad = Math.max(...rows.map(r => r.label.length));
  for (const r of rows) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label.padEnd(pad) + '  ' + r.detail);
  const failed = rows.filter(r => !r.ok).length;
  console.log('\n' + (rows.length - failed) + '/' + rows.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FATAL: ' + e.message); process.exit(1); });
