// Extracts the design-token block each plugin now carries, loads it into real Chrome, and
// asserts (a) every rule parsed -- Chrome silently drops invalid CSS -- and (b) the computed
// values a user would actually get: Korean-first font, 1.65 body leading, keep-all breaking,
// tabular numerals, and code blocks still breaking per character.
//
// Usage: node css_computed_check.js
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
const OUT = path.join(process.env.KIROCREW_SCRATCH || '.', 'css_check');
const PORT = 9333;
fs.mkdirSync(OUT, { recursive: true });

const MARKER = '/* --- MemorySuite shared design tokens';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pull the block from the marker to the end of the stylesheet it was appended to.
function extractBlock(file, endMarker) {
  const text = fs.readFileSync(D + file, 'utf8').replace(/\r\n/g, '\n');
  const a = text.indexOf(MARKER);
  if (a < 0) throw new Error(file + ': marker not found');
  const b = text.indexOf(endMarker, a);
  if (b < 0) throw new Error(file + ': end marker not found');
  return text.slice(a, b)
    // The HAYAKU rules interpolate its root id; substitute a literal for the test page.
    .replace(/\$\{LEDGER_VIEWER_ROOT_ID\}/g, 'hayakuLedgerViewerRoot');
}

const BLOCKS = {
  flashback: extractBlock('Flashback_Memory.js', '</style>'),
  hayaku: extractBlock('HAYAKU_Locator_Continuity.js', '</style>'),
  libra: extractBlock('LIBRA.js', '\n`;'),
};

// A page carrying all three blocks plus the minimum colour variables they reference, and
// one representative element per plugin so computed styles can be read.
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{
  --bg:#282a36;--surface:#21222c;--surface2:#374151;--text:#f8f8f2;--text2:#64748b;
  --border:#4b5563;--accent:#6272a4;--success:#50d394;--warn:#f2b55e;--purple:#b49af7;
  --hv-bg:#282a36;--hv-card:#21222c;--hv-text:#f8f8f2;--hv-muted:#64748b;
  --hv-line:#4b5563;--hv-primary:#6272a4;--hv-green:#14966f;
  --sga-bg:#282a36;--sga-text:#f8f8f2;--sga-line:#4b5563;
}
/* The plugins each set a base colour on their own root (Flashback .vrmDesign, HAYAKU's
   viewer root, LIBRA's body). The extracted blocks do not carry those base rules, so the
   probe reproduces them -- otherwise inherited black would be measured instead. */
.vrmDesign{color:var(--text);background:var(--bg)}
#hayakuLedgerViewerRoot{color:var(--hv-text);background:var(--hv-bg)}
.sga-app{color:var(--sga-text);background:var(--sga-bg)}
</style>
<style id="s-flashback">${BLOCKS.flashback}</style>
<style id="s-hayaku">${BLOCKS.hayaku}</style>
<style id="s-libra">${BLOCKS.libra}</style>
</head><body>
<div class="vrmDesign">
  <div class="page-eyebrow">개요</div><h1 class="page-title">기억 개요</h1>
  <p class="page-description">저장된 기억과 회상 상태를 확인합니다.</p>
  <div class="card-title">스코프 스토리지 관리</div>
  <div class="tiny">서버 오류는 데이터 없음으로 판정하지 않습니다.</div>
  <span class="nav-count">1234</span>
  <table class="data-table"><tbody><tr><td>12345</td></tr><tr><td>67890</td></tr></tbody></table>
  <div class="activity-log-empty"><strong>아직 없습니다.</strong><span>작업이 생기면 여기에 기록됩니다.</span></div>
  <pre>{"scopeKey":"chat_9f2c1ab34de5"}</pre>
</div>
<div id="hayakuLedgerViewerRoot">
  <div class="hayaku-viewer">
    <div class="hv-heading"><small class="hv-eyebrow">원장</small><h1>패킷 원장</h1><p>저장된 패킷을 확인합니다.</p></div>
    <div class="hv-log-summary">현재 실행 로그 <strong>42</strong>개</div>
    <div class="hv-empty" data-hv-empty="data"><strong>작동 로그가 없습니다.</strong><span>HAYAKU가 요청을 처리하면 여기에 기록됩니다.</span></div>
    <pre>{"hash":"aa11bb22cc33"}</pre>
  </div>
</div>
<div class="sga-app">
  <span class="libra-article-eyebrow">정본</span>
  <section class="sga-card"><h2>기억 서가</h2><h3>구간 요약</h3>
  <p class="sga-note">5턴마다 정본 기억을 만듭니다.</p></section>
  <pre>{"memoryId":"mem_000001"}</pre>
</div>
<div class="libra-book-reading-sheet">종이 면의 한국어 본문입니다.</div>
</body></html>`;

const pageFile = path.join(OUT, 'probe.html');
fs.writeFileSync(pageFile, page, 'utf8');

const getJson = p => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 4000 }, res => {
    let body = ''; res.on('data', c => { body += c; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
});

(async () => {
  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i += 1) { await sleep(500); try { targets = await getJson('/json/list'); } catch (_) {} }
  if (!targets) { chrome.kill(); console.log('FATAL: chrome did not start'); process.exit(3); }

  const target = targets.find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };

  const rows = [];
  const check = (label, ok, detail = '') => rows.push({ label, ok: !!ok, detail });

  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: 'file:///' + pageFile.replace(/\\/g, '/') });
    await sleep(2500);

    // 1. Chrome drops invalid rules, so a rule count of 0 means the block failed to parse.
    const sheets = await evaluate(`(() => {
      const out = {};
      for (const id of ['s-flashback','s-hayaku','s-libra']) {
        const el = document.getElementById(id);
        let n = -1;
        try { n = el.sheet ? el.sheet.cssRules.length : -1; } catch (e) { n = -2; }
        out[id] = n;
      }
      return out;
    })()`);
    for (const [key, n] of Object.entries(sheets)) check('CSS 파싱 ' + key, n > 0, 'rules=' + n);

    // 2. Computed values a user actually sees.
    const computed = await evaluate(`(() => {
      const pick = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return { missing: sel };
        const cs = getComputedStyle(el);
        const out = {};
        for (const p of props) out[p] = cs.getPropertyValue(p);
        return out;
      };
      return {
        fbRoot: pick('.vrmDesign', ['font-family','font-size','line-height','word-break','overflow-wrap']),
        fbTitle: pick('.vrmDesign .page-title', ['font-size','font-weight','line-height']),
        fbEyebrow: pick('.vrmDesign .page-eyebrow', ['font-size','text-transform','letter-spacing','font-weight']),
        fbNote: pick('.vrmDesign .tiny', ['font-size']),
        fbTable: pick('.vrmDesign .data-table', ['font-variant-numeric']),
        fbPre: pick('.vrmDesign pre', ['font-family','word-break']),
        hvRoot: pick('#hayakuLedgerViewerRoot', ['font-family','font-size','line-height','word-break']),
        hvH1: pick('#hayakuLedgerViewerRoot .hv-heading h1', ['font-size','font-weight']),
        hvEyebrow: pick('#hayakuLedgerViewerRoot .hv-eyebrow', ['font-size','text-transform','letter-spacing']),
        hvCard: pick('#hayakuLedgerViewerRoot .hayaku-viewer', ['border-radius']),
        hvPre: pick('#hayakuLedgerViewerRoot pre', ['font-family','word-break']),
        sgaRoot: pick('.sga-app', ['font-family','font-size','line-height','word-break']),
        sgaEyebrow: pick('.sga-app .libra-article-eyebrow', ['font-size','letter-spacing','text-transform']),
        sgaH2: pick('.sga-app .sga-card h2', ['font-size','font-weight']),
        sgaH3: pick('.sga-app .sga-card h3', ['font-size']),
        sgaNote: pick('.sga-app .sga-note', ['font-size']),
        sgaPre: pick('.sga-app pre', ['font-family','word-break']),
        bookSheet: pick('.libra-book-reading-sheet', ['word-break','line-height','border-radius']),
        motion: getComputedStyle(document.documentElement).getPropertyValue('--ms-motion'),
      };
    })()`);

    fs.writeFileSync(path.join(OUT, 'computed.json'), JSON.stringify(computed, null, 2), 'utf8');

    const korean = /Pretendard|Noto Sans KR|Malgun Gothic/;
    for (const [key, label] of [['fbRoot', 'Flashback'], ['hvRoot', 'HAYAKU'], ['sgaRoot', 'LIBRA']]) {
      const v = computed[key];
      check(label + ': 한글 글꼴이 스택 앞', korean.test(v['font-family'] || ''), (v['font-family'] || '').slice(0, 60));
      check(label + ': 본문 13px', v['font-size'] === '13px', v['font-size']);
      // 13px * 1.65 = 21.45px
      check(label + ': 줄간격 1.65 적용', Math.abs(parseFloat(v['line-height']) - 21.45) < 0.6, v['line-height']);
      check(label + ': 한글 줄바꿈 keep-all', v['word-break'] === 'keep-all', v['word-break']);
    }
    // Chrome serialises `letter-spacing: 0` as `normal`; both mean no tracking.
    const noTracking = value => {
      const v = String(value || '').trim();
      return v === 'normal' || parseFloat(v) === 0;
    };
    check('Flashback: 제목 22px', computed.fbTitle['font-size'] === '22px', computed.fbTitle['font-size']);
    check('Flashback: 라벨 12px · 자간 0 · 대문자',
      computed.fbEyebrow['font-size'] === '12px'
      && noTracking(computed.fbEyebrow['letter-spacing'])
      && computed.fbEyebrow['text-transform'] === 'uppercase',
      JSON.stringify(computed.fbEyebrow));
    check('Flashback: 설명 12px', computed.fbNote['font-size'] === '12px', computed.fbNote['font-size']);
    check('Flashback: 표 숫자 자릿수 정렬', computed.fbTable['font-variant-numeric'] === 'tabular-nums', computed.fbTable['font-variant-numeric']);
    check('HAYAKU: 제목 22px', computed.hvH1['font-size'] === '22px', computed.hvH1['font-size']);
    check('HAYAKU: 라벨 12px · 자간 0',
      computed.hvEyebrow['font-size'] === '12px'
      && noTracking(computed.hvEyebrow['letter-spacing']),
      JSON.stringify(computed.hvEyebrow));
    check('HAYAKU: 외곽 모서리 20px', computed.hvCard['border-radius'] === '20px', computed.hvCard['border-radius']);
    check('LIBRA: h2 19px', computed.sgaH2['font-size'] === '19px', computed.sgaH2['font-size']);
    check('LIBRA: 라벨 12px · 자간 0',
      computed.sgaEyebrow['font-size'] === '12px'
      && noTracking(computed.sgaEyebrow['letter-spacing']),
      JSON.stringify(computed.sgaEyebrow));
    check('LIBRA: h3 15px', computed.sgaH3['font-size'] === '15px', computed.sgaH3['font-size']);
    check('LIBRA: 설명 12px', computed.sgaNote['font-size'] === '12px', computed.sgaNote['font-size']);
    for (const [key, label] of [['fbPre', 'Flashback'], ['hvPre', 'HAYAKU'], ['sgaPre', 'LIBRA']]) {
      check(label + ': 코드는 문자 단위 줄바꿈', computed[key]['word-break'] === 'break-all', computed[key]['word-break']);
      check(label + ': 코드는 고정폭', /monospace|Consolas|Menlo|D2Coding/.test(computed[key]['font-family'] || ''),
        (computed[key]['font-family'] || '').slice(0, 50));
    }
    check('LIBRA: Book 종이 면도 keep-all', computed.bookSheet['word-break'] === 'keep-all', computed.bookSheet['word-break']);
    check('LIBRA: Book 모서리 16px', computed.bookSheet['border-radius'] === '16px', computed.bookSheet['border-radius']);
    // Custom properties are not normalised until used, so Chrome echoes the token verbatim.
    check('모션 토큰이 호스트 기본값으로 해석', /^0?\.2s$/.test(String(computed.motion || '').trim()), String(computed.motion).trim());

    // 3. Measure the ACTUAL contrast a user gets, with the host theme active. This is the
    //    claim that matters: RisuAI's own secondary colour is 2.99:1 on its own background.
    const contrast = await evaluate(`(() => {
      const host = {
        bgcolor:'#282a36', darkbg:'#21222c', borderc:'#6272a4', selected:'#44475a',
        draculared:'#ff5555', textcolor:'#f8f8f2', textcolor2:'#64748b',
        darkborderc:'#4b5563', darkbutton:'#374151',
      };
      const root = document.documentElement;
      for (const [k, v] of Object.entries(host)) root.style.setProperty('--risu-theme-' + k, v);
      root.setAttribute('data-risu-theme', '1');
      root.setAttribute('data-risu-theme-type', 'dark');
      // Colour following is opt-in now, so the probe must switch it on to measure the
      // mapped palette's contrast at all.
      root.setAttribute('data-risu-theme-colors', '1');
      // Plugin surfaces must also carry the host background for the mix to resolve against.
      document.querySelector('.vrmDesign').style.background = host.bgcolor;
      document.querySelector('#hayakuLedgerViewerRoot').style.background = host.bgcolor;
      document.querySelector('.sga-app').style.background = host.bgcolor;

      // color-mix() serialises as color(srgb r g b) with 0-1 floats, not rgb().
      const parse = css => {
        const s = String(css || '');
        const srgb = /color\\(srgb\\s+([-\\d.eE]+)\\s+([-\\d.eE]+)\\s+([-\\d.eE]+)/.exec(s);
        if (srgb) return [1, 2, 3].map(i => Math.max(0, Math.min(255, Math.round(parseFloat(srgb[i]) * 255))));
        const m = /rgba?\\(([^)]+)\\)/.exec(s);
        if (!m) return null;
        const parts = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
        return [parts[0], parts[1], parts[2]];
      };
      const lin = c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const ratio = (a, b) => { const s = [lum(a), lum(b)].sort((p, q) => q - p); return (s[0] + 0.05) / (s[1] + 0.05); };
      const bg = parse(getComputedStyle(document.querySelector('.vrmDesign')).backgroundColor);

      const measure = sel => {
        const el = document.querySelector(sel);
        if (!el) return { missing: sel };
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        return {
          color: cs.color,
          opacity: cs.opacity,
          ratio: fg && bg ? Number(ratio(fg, bg).toFixed(2)) : null,
        };
      };
      return {
        hostSecondaryRaw: Number(ratio(parse('rgb(100,116,139)'), bg).toFixed(2)),
        fbNote: measure('.vrmDesign .tiny'),
        fbEyebrow: measure('.vrmDesign .page-eyebrow'),
        hvEyebrow: measure('#hayakuLedgerViewerRoot .hv-eyebrow'),
        hvSummary: measure('#hayakuLedgerViewerRoot .hv-log-summary'),
        sgaEyebrow: measure('.sga-app .libra-article-eyebrow'),
        sgaNote: measure('.sga-app .sga-note'),
      };
    })()`);
    fs.writeFileSync(path.join(OUT, 'contrast.json'), JSON.stringify(contrast, null, 2), 'utf8');

    check('기준: 호스트 보조 글자색이 실제로 미달', contrast.hostSecondaryRaw < 4.5, contrast.hostSecondaryRaw + ':1');
    for (const [key, label] of [
      ['fbNote', 'Flashback 설명'], ['fbEyebrow', 'Flashback 라벨'],
      ['hvEyebrow', 'HAYAKU 라벨'], ['hvSummary', 'HAYAKU 보조'],
      ['sgaEyebrow', 'LIBRA 라벨'], ['sgaNote', 'LIBRA 설명'],
    ]) {
      const m = contrast[key] || {};
      check(label + ' 대비 4.5:1 이상', typeof m.ratio === 'number' && m.ratio >= 4.5, m.ratio + ':1 (' + m.color + ')');
      // Opacity multiplies the blend with the background and silently undoes the fix.
      check(label + ' 투명도 미사용', parseFloat(m.opacity) === 1, 'opacity=' + m.opacity);
    }

    // 4. Empty-state icon and skeleton actually resolve.
    const decor = await evaluate(`(() => {
      const maskOf = sel => {
        const el = document.querySelector(sel);
        if (!el) return { missing: sel };
        const cs = getComputedStyle(el, '::before');
        return {
          content: cs.content,
          width: cs.width,
          mask: (cs.maskImage || cs.webkitMaskImage || '').slice(0, 40),
          background: cs.backgroundColor,
        };
      };
      const el = document.createElement('div');
      el.className = 'ms-skeleton';
      el.style.width = '100px'; el.style.height = '20px';
      document.body.appendChild(el);
      const sk = getComputedStyle(el);
      const out = {
        fbEmpty: maskOf('.vrmDesign .activity-log-empty'),
        hvEmpty: maskOf('#hayakuLedgerViewerRoot .hv-empty'),
        skeleton: { animation: sk.animationName, image: sk.backgroundImage.slice(0, 30), size: sk.backgroundSize },
      };
      el.remove();
      return out;
    })()`);
    fs.writeFileSync(path.join(OUT, 'decor.json'), JSON.stringify(decor, null, 2), 'utf8');
    check('Flashback 빈 상태 아이콘', /svg/.test(decor.fbEmpty.mask || ''), decor.fbEmpty.mask);
    check('HAYAKU 빈 상태 아이콘', /svg/.test(decor.hvEmpty.mask || ''), decor.hvEmpty.mask);
    check('스켈레톤 셰이머 애니메이션', decor.skeleton.animation === 'ms-shimmer', decor.skeleton.animation);
    check('스켈레톤 그라디언트', /gradient/.test(decor.skeleton.image || ''), decor.skeleton.image);

    // 5. Screenshot so the result is visible, not just asserted.
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, 'typography.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('screenshot: ' + file);
  } finally {
    try { await send('Browser.close'); } catch (_) {}
    try { chrome.kill(); } catch (_) {}
  }

  const pad = Math.max(...rows.map(r => r.label.length));
  for (const r of rows) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label.padEnd(pad) + (r.detail ? '  ' + r.detail : ''));
  const failed = rows.filter(r => !r.ok).length;
  console.log('\n' + (rows.length - failed) + '/' + rows.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FATAL: ' + e.message); process.exit(1); });
