'use strict';
// RE:TRACE server management, checked against a real server with real owner data.
//
// A real Librarian System server runs on a temporary DATA directory. Chromium hosts a RisuAI-shaped
// page: the parent window holds the character database, per-plugin storage and the plugin IPC bus
// (it stamps each message with the real sender id), and each plugin runs in its own iframe as in
// RisuAI 3. Flashback and HAYAKU write in server_only mode, so their data lives on the server;
// RE:TRACE (flashback_hayaku_bridge, the manager) is then driven through its GUI.
// No model or embedding provider is called.
//
// Usage: node tools/gui_check/retrace_server_manage_check.cjs --out dir [--keep-open-ms N]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const { createMemorySuiteServer } = require(path.join(ROOT, 'server', 'server.cjs'));
const { createValidPacket, hiddenPacketMessage } = require(path.join(ROOT, 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const out = arg('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'retrace-manage-'));
fs.mkdirSync(out, { recursive: true });
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const PLUGINS = [
  { id: 'flashback_memory', file: 'Flashback_Memory.js' },
  { id: 'hayaku_locator_continuity', file: 'HAYAKU_Locator_Continuity.js' },
  { id: 'flashback_hayaku_bridge', file: 'RETRACE.js' }
];

const chatOf = (id, name, turns) => {
  const message = [];
  turns.forEach(([user, assistant], index) => {
    message.push({ role: 'user', chatId: `${id}-u${index + 1}`, data: user });
    message.push({ role: 'char', chatId: `${id}-a${index + 1}`, data: assistant });
  });
  return { id, chatId: id, name, message, messages: message, bindedPersona: '', fmIndex: -1 };
};
const harbor = chatOf('chat-harbor', '항구 마을 이야기', [
  ['오늘 처음 항구 마을에 도착했어.', hiddenPacketMessage('안내인 유나가 반갑게 손을 흔듭니다.', createValidPacket({ turn: 1, summary: '항구 마을 도착' }))],
  ['유나에게 묵을 곳을 물어봤어.', hiddenPacketMessage('유나는 등대 여관을 추천했습니다.', createValidPacket({ turn: 2, summary: '등대 여관 추천' }))],
  ['시장 구경을 갔어.', hiddenPacketMessage('상인 서린이 푸른 비단을 팔고 있습니다.', createValidPacket({ turn: 3, summary: '시장과 서린' }))]
]);
const tower = chatOf('chat-tower', '북쪽 탑 원정', [
  ['북쪽 탑에 올라가 봤어.', '꼭대기에는 녹슨 망원경과 깨진 별자리 지도가 있습니다.'],
  ['별자리 지도를 자세히 봤어.', '지도 뒷면에 달이 세 번 차면 문이 열린다는 문장이 적혀 있습니다.']
]);
const removed = chatOf('chat-removed', '지워진 채팅', [
  ['비 오는 날 도서관에 갔어.', '사서 하준이 오래된 기록을 정리하고 있습니다.'],
  ['하준에게 말을 걸었어.', '하준은 귀찮다는 듯 고개를 저었습니다.']
]);

// Parent window: the RisuAI host. Each iframe asks for its own API object by plugin id.
const parentScript = `(() => {
  const s = window.__seed;
  const stores = {}, args = {}, listeners = new Map(), calls = { fetch: 0, llm: 0, ipc: [] };
  const store = () => { const m = new Map(); return { getItem: async k => m.has(String(k)) ? m.get(String(k)) : null,
    setItem: async (k, v) => { m.set(String(k), v); return true; }, removeItem: async k => { m.delete(String(k)); return true; },
    keys: async () => [...m.keys()], key: async i => [...m.keys()][i] ?? null, length: async () => m.size, clear: async () => { m.clear(); return true; } }; };
  const character = { id: 'char-yuna', chaId: 'char-yuna', name: '유나', chatPage: 0, chats: s.chats };
  const db = { characters: [character], personas: [], selectedPersona: '', plugins: [], maxContext: 128000, maxResponse: 8192 };
  const state = { char: 0, chat: 0 };
  const currentChar = () => db.characters[state.char];
  const currentChat = () => currentChar().chats[state.chat];
  window.__risu = { db, state, calls, setCurrent: (c, h) => { state.char = c; state.chat = h; currentChar().chatPage = h; },
    removeChat: id => { const list = currentChar().chats; const index = list.findIndex(c => c.id === id); if (index >= 0) list.splice(index, 1); state.chat = 0; currentChar().chatPage = 0; } };
  const headersObject = h => { const o = {}; if (!h) return o; if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { o[k] = v; }); else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; }); else Object.assign(o, h); return o; };
  window.__hostFor = (pluginId, frame) => {
    stores[pluginId] = stores[pluginId] || { plugin: store(), safe: store(), local: store() };
    args[pluginId] = args[pluginId] || new Map(Object.entries(s.args[pluginId] || {}));
    const own = stores[pluginId], a = args[pluginId], unloads = [];
    const api = {
      apiVersion: '3.0', apiVersionCompatibleWith: ['3.0'],
      pluginStorage: own.plugin, safeLocalStorage: own.safe, getLocalPluginStorage: async () => own.local,
      getArgument: async k => a.get(String(k)) ?? '', getArg: async k => a.get(String(k)) ?? '',
      setArgument: async (k, v) => { a.set(String(k), v); return true; }, setArg: async (k, v) => { a.set(String(k), v); return true; },
      nativeFetch: async (url, init = {}) => { calls.fetch++;
        const r = await window.__nodeFetch(String(url), { method: init.method || 'GET', headers: headersObject(init.headers), body: init.body == null ? null : String(init.body) });
        return new frame.Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers }); },
      runLLMModel: async () => { calls.llm++; throw new Error('model calls are disabled in this check'); },
      getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'web', saveMethod: 'local' }),
      getDatabase: async fields => Array.isArray(fields) ? Object.fromEntries(fields.map(k => [k, db[k] ?? null])) : db,
      setDatabase: async () => { throw new Error('database writes are disabled in this check'); },
      getCurrentCharacterIndex: async () => state.char, getCurrentChatIndex: async () => state.chat,
      getCharacter: async () => currentChar(), getChar: async () => currentChar(), getCharacterFromIndex: async i => db.characters[Number(i) || 0],
      getChat: async () => currentChat(), getCurrentChat: async () => currentChat(),
      getChatFromIndex: async (c, h) => (db.characters[Number(c) || 0]?.chats || [])[h == null ? state.chat : Number(h)] || null,
      setChatToIndex: async (c, h) => { state.char = Number(c) || 0; state.chat = Number(h) || 0; return true; },
      showContainer: async () => { frame.frameElement.dataset.visible = '1'; return true; }, hideContainer: async () => { frame.frameElement.dataset.visible = '0'; return true; },
      getRootDocument: async () => frame.document, getRootContainer: async () => frame.document.body, getPluginRoot: async () => frame.document.body,
      createMutationObserver: async (cb) => new frame.MutationObserver(cb),
      addPluginChannelListener: async (channel, handler) => { const key = pluginId + '|' + channel; if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(handler); return () => listeners.get(key)?.delete(handler); },
      removePluginChannelListener: async (channel, handler) => { listeners.get(pluginId + '|' + channel)?.delete(handler); return true; },
      unregisterPluginChannelListener: async (channel, handler) => { listeners.get(pluginId + '|' + channel)?.delete(handler); return true; },
      postPluginChannelMessage: async (target, channel, message) => { calls.ipc.push(pluginId + '>' + target + ':' + channel);
        const handlers = [...(listeners.get(String(target) + '|' + channel) || [])];
        for (const handler of handlers) await handler(JSON.parse(JSON.stringify(message ?? null)), { sender: pluginId });
        return handlers.length > 0; },
      onUnload: async h => { unloads.push(h); return true; }
    };
    for (const m of ['registerSetting', 'registerButton', 'unregisterSetting', 'unregisterButton', 'unregisterUIPart', 'addRisuReplacer', 'removeRisuReplacer', 'addRisuScriptHandler', 'removeRisuScriptHandler', 'addRisuChatListener', 'removeRisuChatListener', 'registerBodyIntercepter', 'unregisterBodyIntercepter']) api[m] = async () => ({ id: pluginId + ':' + m });
    return api;
  };
})();`;

const frameHtml = plugin => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0">
<script>window.risuai=window.Risuai=window.RisuAI=parent.__hostFor(${JSON.stringify(plugin.id)},window);window.confirm=()=>false;window.alert=()=>{};window.prompt=()=>null;</script>
<script src="/src/${plugin.file}"></script></body></html>`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retrace-manage-data-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(dataRoot, 'DATA'), autoBackup: false });
  const address = await app.listen();
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const report = { serverUrl, steps: {}, errors: [], console: [], views: [] };
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const viewport = arg('--mobile') ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
  const label = arg('--mobile') ? 'mobile' : 'desktop';
  try {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.console.push(message.text().slice(0, 300)); });
    await page.exposeFunction('__nodeFetch', async (url, init) => {
      if (!url.startsWith(serverUrl)) return { status: 599, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'blocked ' + url }) };
      const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
      const headers = {}; response.headers.forEach((v, k) => { headers[k] = v; });
      return { status: response.status, headers, body: await response.text() };
    });
    await page.route('https://risu.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#ddd"></body></html>` });
      if (url.pathname.startsWith('/frame/')) return route.fulfill({ contentType: 'text/html', body: frameHtml(PLUGINS.find(p => p.id === url.pathname.slice(7))) });
      if (url.pathname.startsWith('/src/')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'plugins', path.basename(url.pathname))) });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('https://risu.test/');
    const serverArgs = { memory_suite_server_mode: 'server_only', memory_suite_server_url: serverUrl };
    await page.addScriptTag({ content: `window.__seed=${JSON.stringify({ chats: [harbor, tower, removed], args: {
      flashback_memory: { ...serverArgs, mode: 'normal', enable_gui: 'false', embedding_provider: 'openai', embedding_key: '' },
      hayaku_locator_continuity: { ...serverArgs, hayaku_debug: 'false', hayaku_background_auto_repair: 'false', hayaku_after_request_auto_repair: 'false', hayaku_native_auto_repair: 'false' },
      flashback_hayaku_bridge: { ...serverArgs }
    } })};` });
    await page.addScriptTag({ content: parentScript });
    for (const plugin of PLUGINS) {
      await page.evaluate(({ id }) => { const f = document.createElement('iframe'); f.id = 'frame-' + id; f.src = '/frame/' + id;
        f.style.cssText = id === 'flashback_hayaku_bridge' ? 'position:fixed;inset:0;width:100vw;height:100vh;border:0' : 'position:absolute;width:10px;height:10px;left:-50px;border:0';
        document.body.appendChild(f); }, plugin);
    }
    const frame = id => page.frame({ url: new RegExp('/frame/' + id + '$') });
    await page.waitForFunction(() => !!document.getElementById('frame-flashback_hayaku_bridge')?.contentWindow?.__RETRACE
      && !!document.getElementById('frame-flashback_memory')?.contentWindow?.__FlashbackMemory?._test
      && !!document.getElementById('frame-hayaku_locator_continuity')?.contentWindow?.HAYAKU, null, { timeout: 60000 });
    await sleep(2500);

    // Owner data, written by the owners themselves in server_only mode.
    report.steps.seed = await page.evaluate(async () => {
      const fb = document.getElementById('frame-flashback_memory').contentWindow.__FlashbackMemory;
      const hy = document.getElementById('frame-hayaku_locator_continuity').contentWindow.HAYAKU;
      const result = { flashback: [], hayaku: null };
      for (let index = 0; index < 3; index += 1) {
        window.__risu.setCurrent(0, index);
        result.flashback.push(await fb.ingestLiveChatColdStart({ scope: 'current', canonical: true }).then(r => ({ ok: r?.ok !== false, reason: r?.reason || '' }), e => ({ ok: false, error: String(e?.message || e) })));
      }
      window.__risu.setCurrent(0, 0);
      try {
        const scope = await hy._test.currentChatScope();
        await hy._test.reconcileObservedChatTopology(scope, hy._test.authoritativeChatSnapshot(scope.chatMessages, scope), 'retrace_manage_check_seed');
        result.hayaku = { ok: true };
      } catch (error) { result.hayaku = { ok: false, error: String(error?.message || error) }; }
      // The third chat is deleted from RisuAI; its server copy becomes an orphan.
      window.__risu.removeChat('chat-removed');
      return result;
    });
    await sleep(3000);
    report.steps.serverKeys = await (async () => {
      const files = []; const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else files.push(path.relative(dataRoot, p)); } };
      walk(dataRoot); return files.slice(0, 40);
    })();

    const retrace = frame('flashback_hayaku_bridge');
    const shot = async name => {
      const file = path.join(out, `${label}_${name}.png`);
      await page.screenshot({ path: file });
      // Unrolled capture of the RE:TRACE page body.
      const tall = path.join(out, `${label}_${name}_full.png`);
      const height = await retrace.evaluate(() => {
        const style = document.createElement('style'); style.id = 'unroll';
        style.textContent = '#flashback-hayaku-bridge-root{position:static!important;height:auto!important;overflow:visible!important}#flashback-hayaku-bridge-root .app,#flashback-hayaku-bridge-root .stage,#flashback-hayaku-bridge-root .frame{height:auto!important;max-height:none!important;overflow:visible!important}#flashback-hayaku-bridge-root .page-body,#flashback-hayaku-bridge-root .main{overflow:visible!important;max-height:none!important}';
        document.head.appendChild(style); return document.documentElement.scrollHeight + 40; });
      await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(viewport.height, height), 6000) });
      await sleep(250); await page.screenshot({ path: tall });
      await retrace.evaluate(() => document.getElementById('unroll')?.remove());
      await page.setViewportSize(viewport); await sleep(150);
      report.views.push(name);
      report.steps['text_' + name] = await retrace.evaluate(() => (document.querySelector('.page.is-active, [data-page].is-active') || document.body).innerText.slice(0, 6000));
    };
    const click = async (selector, wait = 800) => { const ok = await retrace.evaluate(s => { const n = document.querySelector(s); if (!n) return false; n.click(); return true; }, selector); await sleep(wait); return ok; };
    // RE:TRACE dialogs are in-GUI layers with [data-dialog-confirm]; answer the one that is open.
    const dialog = async (accept = true, timeout = 8000) => {
      for (const until = Date.now() + timeout; Date.now() < until; await sleep(200)) {
        const answer = await retrace.evaluate(accept => {
          const layer = [...document.querySelectorAll('.overlay.is-open')].find(l => !l.hidden && l.querySelector('[data-dialog-confirm]'));
          if (!layer) return null;
          const text = layer.innerText.replace(/\s+\n/g, '\n').slice(0, 1500);
          const typed = layer.querySelector('[data-dialog-typed-wrap]:not([hidden]) [data-dialog-typed-input]');
          const word = layer.querySelector('[data-dialog-typed-label] b')?.textContent?.trim() || '';
          if (accept && typed && word) { typed.value = word; typed.dispatchEvent(new Event('input', { bubbles: true })); }
          const cancel = layer.querySelector('[data-dialog-cancel]');
          const button = accept || !cancel || cancel.hidden ? layer.querySelector('[data-dialog-confirm]') : cancel;
          if (button.disabled) return { id: layer.id, text, clicked: '(disabled) ' + button.textContent.trim() };
          button.click();
          return { id: layer.id, text, typed: word, clicked: button.textContent.trim() };
        }, accept);
        if (answer) return answer;
      }
      return null;
    };
    const status = selector => retrace.evaluate(s => document.querySelector(s)?.innerText || '', selector);
    const waitIdle = async (ms = 60000) => { for (const until = Date.now() + ms; Date.now() < until; await sleep(400)) { if (await retrace.evaluate(() => !document.querySelector('[data-server-control][disabled]:not([data-server-control="restore-execute"])') && !/확인 중|스캔 중|불러오는 중|진행하고 있습니다/.test(document.querySelector('#serverDataBody')?.innerText || ''))) return; } };
    const scopes = () => retrace.evaluate(() => [...document.querySelectorAll('#serverDataBody .scope-card')].map(card => ({ name: card.querySelector('b')?.innerText.replace(/\s+/g, ' ').trim(), meta: card.querySelector('small')?.innerText || '', kind: card.className.replace('scope-card', '').trim(), checkbox: !!card.querySelector('input.sel') && !card.querySelector('input.sel').disabled && getComputedStyle(card.querySelector('input.sel')).display !== 'none', actions: [...card.querySelectorAll('.acts button')].map(b => b.innerText.trim() + (b.disabled ? '(off)' : '')) })));
    report.helpers = { click: true };
    await retrace.evaluate(() => window.__RETRACE.showUi());
    await sleep(2500);
    await click('[data-tab="serverdata"]', 3000);
    await shot('server_overview');
    const step = async (name, run) => { try { report.steps[name] = await run(); } catch (error) { report.steps[name] = { error: String(error?.stack || error).slice(0, 800) }; } };
    const refreshData = async () => { await click('[data-server-page="data"]', 800); await click('#refreshServerData', 600); await waitIdle(); await sleep(800); return scopes(); };

    await step('dataInitial', async () => { const list = await refreshData(); await shot('data_initial'); return list; });
    const orphan = 'flashback|' + (await retrace.evaluate(() => document.querySelector('.k-orphan [data-server-scope-delete]')?.getAttribute('data-server-scope-delete')?.split('|').slice(1).join('|') || ''));
    await step('detail', async () => { await click(`[data-server-scope-detail="${orphan}"]`, 1500); const shown = await retrace.evaluate(() => [...document.querySelectorAll('[id]')].filter(n => n.offsetParent !== null && /dialog|drawer|sheet|detail/i.test(n.id)).map(n => n.id + ': ' + n.innerText.slice(0, 900))); await shot('data_detail'); const d = await dialog(false, 1500); return { shown, dialog: d }; });
    await step('pin', async () => { await click(`[data-server-scope-pin="${orphan}"]`, 1500); const d = await dialog(true, 3000); await waitIdle(); await sleep(800); const list = await scopes(); await shot('data_pinned'); return { dialog: d, card: list.find(x => /지워진/.test(x.name)) }; });
    await step('deletePinned', async () => { await click(`[data-server-scope-delete="${orphan}"]`, 1200); const d1 = await dialog(true, 3000); await sleep(1500); const d2 = await dialog(true, 1500); await waitIdle(); return { d1, d2, status: await status('#serverScopeDeleteStatus'), list: await scopes() }; });
    await step('unpin', async () => { const pin = await retrace.evaluate(o => document.querySelector(`[data-server-scope-pin="${o}"]`)?.innerText, orphan); await click(`[data-server-scope-pin="${orphan}"]`, 1500); const d = await dialog(true, 3000); await waitIdle(); await sleep(800); return { before: pin, dialog: d, card: (await scopes()).find(x => /지워진/.test(x.name)) }; });
    await step('deleteOrphan', async () => { await click(`[data-server-scope-delete="${orphan}"]`, 1200); const dialogs = []; for (let i = 0; i < 4; i += 1) { const d = await dialog(true, 4000); if (!d) break; dialogs.push(d); await sleep(1200); } await waitIdle(); await sleep(1500); const list = await refreshData(); await shot('data_after_orphan_delete'); return { dialogs, status: await status('#serverScopeDeleteStatus'), list }; });
    await step('deleteActive', async () => { const target = await retrace.evaluate(() => document.querySelector('.k-active [data-server-scope-delete^="hayaku|"]')?.getAttribute('data-server-scope-delete')); await click(`[data-server-scope-delete="${target}"]`, 1500); const dialogs = []; for (let i = 0; i < 4; i += 1) { const d = await dialog(false, 3000); if (!d) break; dialogs.push(d); await sleep(800); } await waitIdle(); return { target, dialogs, status: await status('#serverScopeDeleteStatus'), list: await scopes() }; });
    await step('bulkSelect', async () => { await click('[data-server-scope-select-all]', 800); return { text: await retrace.evaluate(() => document.querySelector('#serverDataBody')?.innerText.match(/다중 작업[^\n]*/)?.[0] || ''), checked: await retrace.evaluate(() => [...document.querySelectorAll('#serverDataBody input.sel:checked')].length) }; });

    await step('backupCreate', async () => { await click('[data-server-page="backups"]', 1500); await shot('backups_initial'); await click('[data-server-control="backup-create"]', 500); await waitIdle(); await sleep(1500); const r = await status('#serverControlResult'); await shot('backups_created'); return { result: r, backups: await retrace.evaluate(() => [...document.querySelectorAll('#serverControlBackups option')].map(o => o.value + ' | ' + o.textContent)), badge: await status('#bk-badge'), cards: await status('#serverControlBackupCards') }; });
    await step('backupCheck', async () => { await click('[data-server-control="backup-check"]', 500); await waitIdle(); await sleep(1000); return await status('#serverControlResult'); });
    await step('restorePlan', async () => { await retrace.evaluate(() => { for (const n of document.querySelectorAll('[data-control-namespace]')) n.checked = n.value === 'flashback'; document.querySelector('[data-control-namespace]')?.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(300); await click('[data-server-control="restore-plan"]', 500); await waitIdle(); await sleep(1000); await shot('restore_plan'); return { result: await status('#serverControlResult'), executeEnabled: await retrace.evaluate(() => !document.querySelector('[data-server-control="restore-execute"]')?.disabled) }; });
    await step('restoreExecute', async () => { await click('[data-server-control="restore-execute"]', 800); const d = await dialog(true, 4000); await waitIdle(90000); await sleep(1500); await shot('restore_done'); return { dialog: d, result: await status('#serverControlResult'), reconnect: await status('#serverControlReconnect') }; });
    await step('diagnose', async () => { await click('[data-server-page="connection"]', 800); await click('[data-server-control="diagnose"]', 500); await waitIdle(); await sleep(1200); await shot('connection_diagnosed'); return { result: await status('#serverControlResult'), diagnosis: await status('#serverControlDiagnosis') }; });
    await step('history', async () => { await click('[data-server-page="history"]', 800); await click('[data-server-control="refresh"]', 500); await waitIdle(); await sleep(1200); await shot('history'); return await status('#serverControlHistory'); });
    await step('overview', async () => { await click('[data-server-page="overview"]', 1200); await shot('overview_after'); return await retrace.evaluate(() => document.querySelector('[data-server-view="overview"]')?.innerText.slice(0, 2500)); });
    await step('reset', async () => { await click('[data-server-page="backups"]', 1000); await retrace.evaluate(() => { const s = document.querySelector('#serverResetTarget'); s.value = 'flashback'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await click('#serverResetBegin', 800); const d = await dialog(true, 6000); await waitIdle(90000); await sleep(2500); await shot('reset_done'); return { dialog: d, status: await status('#serverResetStatus') }; });
    await step('dataAfterReset', async () => { const list = await refreshData(); await shot('data_after_reset'); return { list, error: await status('#serverDataBody .banner--danger') }; });
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
    await browser.close();
    await app.close?.();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ out, seed: report.steps.seed, views: report.views, errors: report.errors.slice(0, 10), console: report.console.slice(0, 10) }, null, 1));
})().catch(error => { console.error(error); process.exit(1); });
