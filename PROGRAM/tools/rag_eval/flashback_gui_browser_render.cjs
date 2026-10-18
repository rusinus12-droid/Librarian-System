'use strict';
// Flashback GUI data check, step 2: restore the host state saved by flashback_gui_embed_check.cjs
// into an ephemeral RisuAI host in Chromium, run the REAL plugin, perform one real recall (query
// embedding through the Node side, so the provider sees the same request), open the GUI and capture
// every view that shows Flashback data.
// Env: RAG_EVAL_EMBED_URL (…/v1) for the recall's query embedding.
// Usage: node tools/rag_eval/flashback_gui_browser_render.cjs --state state.json --out dir
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const state = JSON.parse(fs.readFileSync(arg('--state'), 'utf8'));
const out = arg('--out'); fs.mkdirSync(out, { recursive: true });
const embedUrl = String(process.env.RAG_EVAL_EMBED_URL || '').replace(/\/+$/, '');
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const source = fs.readFileSync(path.join(ROOT, 'plugins', 'Flashback_Memory.js'), 'utf8');

// Browser-side RisuAI host: three stores restored from the dump; network only for embeddings.
const hostScript = `(() => {
  const s = window.__state;
  const store = seed => { const m = new Map(seed); return { getItem: async k => m.has(String(k)) ? m.get(String(k)) : null,
    setItem: async (k, v) => { m.set(String(k), v); return true; }, removeItem: async k => { m.delete(String(k)); return true; },
    keys: async () => [...m.keys()], clear: async () => { m.clear(); return true; } }; };
  // The real key never enters the page: Node swaps it into the Authorization header.
  const args = { ...Object.fromEntries(s.arguments), embedding_key: 'node-side-key' };
  const chat = s.chat, character = { ...s.character, chaId: s.character.id, chats: [chat], chat, chatPage: 0 };
  const replacers = { beforeRequest: [], afterRequest: [] }, noop = async () => {};
  window.__fbHost = { replacers, chat };
  const host = {
    apiVersion: '3.0', apiVersionCompatibleWith: ['3.0'],
    getArgument: async k => k in args ? args[k] : undefined, getArg: async k => k in args ? args[k] : undefined,
    setArgument: async (k, v) => { args[k] = v; return true; }, setArg: async (k, v) => { args[k] = v; return true; },
    pluginStorage: store(s.pluginStorage), safeLocalStorage: store(s.safeLocalStorage), getLocalPluginStorage: (() => { const local = store(s.localPluginStorage); return async () => local; })(),
    addRisuChatListener: async () => true, removeRisuChatListener: async () => true,
    addRisuReplacer: async (hook, fn) => { if (replacers[hook]) replacers[hook].push(fn); return true; }, removeRisuReplacer: async () => true,
    addRisuScriptHandler: async () => true, removeRisuScriptHandler: async () => true,
    registerSetting: async () => ({ id: 'ui-1' }), registerButton: async () => ({ id: 'ui-2' }), unregisterUIPart: noop,
    showContainer: async () => true, hideContainer: async () => true, onUnload: async () => true,
    addPluginChannelListener: async () => () => {}, removePluginChannelListener: async () => true, unregisterPluginChannelListener: async () => true,
    postPluginChannelMessage: async () => null,
    nativeFetch: async (url, init = {}) => { const r = await window.__nodeFetch(String(url), { method: init.method || 'GET', headers: init.headers || {}, body: init.body == null ? null : String(init.body) });
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } }); },
    runLLMModel: async () => { throw new Error('Flashback never calls a generation model'); },
    getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'web', saveMethod: 'local' }),
    getCharacter: async () => character, getChar: async () => character, getCharacterFromIndex: async () => character,
    getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, getChatFromIndex: async () => chat, getChat: async () => chat, getCurrentChat: async () => chat,
    setChatToIndex: async () => true, getDatabase: async () => ({ characters: [character], personas: [], selectedPersona: '' }), setDatabase: noop,
    getRootDocument: async () => document, createMutationObserver: async () => ({ observe() {}, disconnect() {} })
  };
  window.risuai = window.Risuai = window.RisuAI = host;
  window.confirm = () => false; window.alert = () => {}; window.prompt = () => null;
})();`;

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const report = { views: [], errors: [], text: {}, recall: {} };
  try {
    for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport });
      page.on('pageerror', error => report.errors.push(`${label}: ${error.message}`));
      if (process.env.FB_GUI_DEBUG) page.on('console', message => { if (/embed|INVALID|checkpoint/i.test(message.text())) (report.console = report.console || []).push(`${label} ${message.type()} ${message.text().slice(0, 600)}`); });
      await page.exposeFunction('__nodeFetch', async (url, init) => {
        if (!embedUrl || !url.startsWith(embedUrl)) { (report.fetches = report.fetches || []).push(`${label} blocked ${url}`); return { status: 599, body: JSON.stringify({ error: 'blocked ' + url }) }; }
        const headers = { ...init.headers };
        if (process.env.RAG_EVAL_EMBED_KEY) for (const key of Object.keys(headers)) if (/^authorization$/i.test(key)) headers[key] = `Bearer ${process.env.RAG_EVAL_EMBED_KEY}`;
        const response = await fetch(url, { method: init.method, headers, body: init.body });
        (report.fetches = report.fetches || []).push(`${label} ${response.status} ${String(init.body || '').length}`);
        return { status: response.status, body: await response.text() };
      });
      // A secure origin, as in RisuAI: the embedding checkpoint needs crypto.subtle, which about:blank lacks.
      await page.route('https://flashback-gui.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0"></body></html>' }));
      await page.goto('https://flashback-gui.test/');
      await page.addScriptTag({ content: `window.__state=${JSON.stringify({ chat: state.chat, character: state.character, pluginStorage: state.pluginStorage, safeLocalStorage: state.safeLocalStorage, localPluginStorage: state.localPluginStorage, arguments: state.arguments })};` });
      await page.addScriptTag({ content: hostScript });
      await page.addScriptTag({ content: source });
      await page.waitForFunction(() => !!window.__FlashbackMemory?._test, null, { timeout: 30000 });
      await page.waitForTimeout(1500);
      // One real recall so the lab view shows what Flashback injected.
      report.recall[label] = await page.evaluate(async () => {
        const fb = window.__FlashbackMemory, chat = window.__fbHost.chat;
        const messages = [{ role: 'system', content: '너는 이야기의 진행자다.' }, ...chat.message.map(m => ({ role: m.role === 'char' ? 'assistant' : 'user', content: m.data, memo: m.chatId })),
          { role: 'user', content: '유나가 처음에 추천한 숙소는 어디였지?' }];
        const inputs = new Set(messages.map(m => m.content));
        let output = messages;
        for (const fn of window.__fbHost.replacers.beforeRequest) { const next = await fn(output, 'model'); if (Array.isArray(next)) output = next; }
        const injected = output.map(m => String(m.content || '')).filter(t => !inputs.has(t)).join('\n');
        return { injectedChars: injected.length, mentionsLighthouseInn: /등대 여관/.test(injected) };
      });
      report.embeddingWork = report.embeddingWork || {};
      report.embeddingWork[label] = await page.evaluate(async () => {
        const view = await window.__FlashbackMemory.inspectEmbeddingWork();
        return { summary: view.summary, groups: (view.groups || []).map(g => ({ turn: g.turnIndex, status: g.status, errors: g.errors })) };
      }).catch(error => ({ error: String(error?.message || error) }));
      await page.evaluate(() => window.__FlashbackMemory.showUi());
      await page.waitForFunction(() => !!document.querySelector('#vector-rag-memory-root[data-vrm-mounted="1"]'), null, { timeout: 30000 });
      await page.waitForTimeout(2500);
      const go = async (route, subtab = null, group = null) => {
        await page.evaluate(r => document.querySelector(`[data-go="${r}"]`)?.click(), route);
        await page.waitForTimeout(900);
        if (subtab) { await page.evaluate(([t, g]) => document.querySelector(`[data-subtab="${t}"]${g ? `[data-group="${g}"]` : ''}`)?.click(), [subtab, group]); await page.waitForTimeout(1500); }
      };
      const shot = async name => {
        const file = path.join(out, `${label}_${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        // The GUI scrolls inside .page-body; a second capture unrolls it so the whole view is reviewable.
        const tall = path.join(out, `${label}_${name}_full.png`);
        await page.addStyleTag({ content: '#vector-rag-memory-root,#vector-rag-memory-root .app{position:static!important;height:auto!important;max-height:none!important;overflow:visible!important}#vector-rag-memory-root .page-body{overflow:visible!important}' }).then(handle => handle.evaluate(node => { node.dataset.fbGuiUnroll = '1'; }));
        await page.screenshot({ path: tall, fullPage: true });
        await page.evaluate(() => document.querySelectorAll('style[data-fb-gui-unroll]').forEach(node => node.remove()));
        report.views.push({ label, name, file, tall });
        report.text[`${label}_${name}`] = await page.evaluate(() => (document.querySelector('.page.is-active') || document.body).innerText);
      };
      await go('lab'); await shot('lab');
      await go('vault', 'resp', 'v'); await shot('vault_responses');
      const firstRecord = page.locator('[data-manual-record-key]');
      if (await firstRecord.count()) { await firstRecord.first().click(); await page.waitForTimeout(800); await shot('vault_response_detail'); }
      await go('vault', 'wl', 'v'); await shot('vault_worldline');
      await go('vault', 'scopes', 'v'); await shot('vault_scopes');
      await go('care'); await shot('care');
      await go('connect', 'emb', 'c'); await shot('connect_embedding');
      report.embeddingWorkAfterGui = report.embeddingWorkAfterGui || {};
      report.embeddingWorkAfterGui[label] = await page.evaluate(async () => {
        const view = await window.__FlashbackMemory.inspectEmbeddingWork();
        return { summary: view.summary, groups: (view.groups || []).filter(g => g.status !== 'ready').map(g => ({ turn: g.turnIndex, status: g.status, errors: g.errors })), warnings: (window.__FlashbackMemory._test?.Runtime?.warnings || []).slice(-6).map(w => String(w.msg || '').slice(0, 400)) };
      }).catch(error => ({ error: String(error?.message || error) }));
      await go('log', 'a', 'l'); await shot('log');
      await go('settings'); await shot('settings');
      report.topbarOverflow = report.topbarOverflow || {};
      report.topbarOverflow[label] = await page.evaluate(() => { const t = document.querySelector('#vector-rag-memory-root .topbar'); return t ? t.scrollWidth - t.clientWidth : null; });
      await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'render-report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ views: report.views.length, recall: report.recall, embeddingWorkAfterGui: report.embeddingWorkAfterGui, fetches: report.fetches, console: report.console, topbarOverflow: report.topbarOverflow, errors: report.errors }, null, 1));
})().catch(error => { console.error(error); process.exit(1); });
