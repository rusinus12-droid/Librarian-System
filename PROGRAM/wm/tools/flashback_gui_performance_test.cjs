'use strict';

const fs = require('fs');
const path = require('path');
const playwrightPath = process.env.CODEX_PLAYWRIGHT_PATH
  || 'C:/Users/rusin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright';
const { chromium } = require(playwrightPath);

const ROOT = path.resolve(__dirname, '..');
const FLASHBACK_FILE = process.env.FLASHBACK_TEST_FILE || path.join(ROOT, '.interop-staging', 'Flashback Memory.js');
const RECORD_COUNT = Math.max(64, Number(process.env.FLASHBACK_GUI_RECORDS || 640) || 640);
const BROWSER_EXECUTABLE = process.env.FLASHBACK_BROWSER_EXECUTABLE
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: BROWSER_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error?.message || error)));
  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  await page.evaluate(() => {
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const storage = new Map();
    const replacers = { beforeRequest: [], afterRequest: [] };
    const chat = {
      id: 'gui-perf-chat',
      name: 'GUI Performance',
      localLore: [],
      isStreaming: false,
      message: [
        { role: 'user', data: '이전 장면을 기억해.', chatId: 'gui-user-old' },
        { role: 'char', data: '기록실의 은색 열쇠를 확인했다.', chatId: 'gui-assistant-old' }
      ]
    };
    const char = { id: 'gui-perf-char', name: 'GUI Character', chatPage: 0, chats: [chat], lorebook: [] };
    const args = {
      mode: 'normal',
      interop_profile: 'auto',
      embedding_provider: 'hash',
      capture_after_request: 'true',
      non_response_write_enabled: 'false',
      non_response_recall_enabled: 'false',
      enable_gui: 'true',
      auto_open_gui: 'false',
      debug_log: 'false',
      operation_log_enabled: 'false'
    };
    const api = {
      apiVersion: '3.0-gui-perf',
      async getRuntimeInfo() { return { apiVersion: '3.0-gui-perf', platform: 'playwright-test', saveMethod: 'mock' }; },
      async getArgument(name) { return args[name]; },
      async getArg(name) { return args[name]; },
      async getCharacter() { return clone(char); },
      async getChar() { return clone(char); },
      async getCurrentCharacterIndex() { return 0; },
      async getCurrentChatIndex() { return 0; },
      async getCharacterFromIndex() { return clone(char); },
      async getChatFromIndex() { return clone(chat); },
      async getCurrentLorebookEntries() { return []; },
      async getDatabase() { return { personas: [], selectedPersona: null, modules: [], enabledModules: [], moduleIntergration: [], characters: [clone(char)] }; },
      async setChatToIndex(_charIndex, _chatIndex, next) { Object.assign(chat, clone(next)); return true; },
      async setCharacter(next) { Object.assign(char, clone(next)); return true; },
      async setCharacterToIndex(_index, next) { Object.assign(char, clone(next)); return true; },
      async addRisuReplacer(type, handler) { (replacers[type] || (replacers[type] = [])).push(handler); return true; },
      async removeRisuReplacer(type, handler) { replacers[type] = (replacers[type] || []).filter(item => item !== handler); return true; },
      async registerSetting(_name, callback) { window.__flashbackShowUi = callback; return { id: 'gui-perf-setting' }; },
      async registerButton(_options, callback) { window.__flashbackShowUi = callback; return { id: 'gui-perf-button' }; },
      async showContainer() { window.__guiContainerShown = true; return true; },
      async hideContainer() { window.__guiContainerShown = false; return true; },
      async onUnload(handler) { window.__flashbackUnload = handler; return true; },
      async requestPluginPermission() { return true; },
      async nativeFetch() { throw new Error('network must not be used'); },
      async risuFetch() { throw new Error('network must not be used'); },
      pluginStorage: {
        async getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        async setItem(key, value) { storage.set(key, String(value)); return true; },
        async removeItem(key) { storage.delete(key); return true; },
        async keys() { return Array.from(storage.keys()); }
      },
      safeLocalStorage: {
        async getItem() { return null; },
        async setItem() { return true; },
        async removeItem() { return true; }
      },
      async getLocalPluginStorage() {
        return { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; } };
      }
    };
    window.risuai = api;
    window.Risuai = api;
    window.__guiPerfReplacers = replacers;
  });
  await page.addScriptTag({ content: fs.readFileSync(FLASHBACK_FILE, 'utf8') });
  await page.waitForFunction(() => !!window.__FlashbackMemory && typeof window.__flashbackShowUi === 'function', null, { timeout: 15000 });

  const seedResult = await page.evaluate(async count => {
    const sources = Array.from({ length: count }, (_, index) => ({
      sourceType: 'response',
      title: `기억 ${index + 1}`,
      sourceId: `gui-perf-response-${index + 1}`,
      origin: 'gui_performance_test',
      role: 'assistant',
      turnIndex: index + 1,
      text: `장면 ${index + 1}. 기록실 사건과 은색 열쇠 단서 ${index % 17}를 확인하고 인물의 현재 상태를 보존했다.`
    }));
    return await window.__FlashbackMemory.ingestSources(sources, null, null, { skipEpisodeRebuild: true, skipGuiRefresh: true });
  }, RECORD_COUNT);

  const firstOpen = await page.evaluate(async () => {
    const started = performance.now();
    const ok = await window.__flashbackShowUi();
    const elapsedMs = performance.now() - started;
    return { ok, elapsedMs, status: window.__FlashbackMemory.uiStatus() };
  });
  await page.waitForSelector('#vector-rag-memory-root[data-vrm-mounted="1"]', { timeout: 10000 });

  const advancedSwitchMs = await page.evaluate(() => {
    const button = document.querySelector('.tab[data-tab="advanced"]');
    const started = performance.now();
    button.click();
    const active = document.querySelector('.panel[data-panel="advanced"]')?.classList.contains('active');
    return { elapsedMs: performance.now() - started, active };
  });
  const storageSwitchMs = await page.evaluate(() => {
    const button = document.querySelector('.tab[data-tab="storage"]');
    const started = performance.now();
    button.click();
    const active = document.querySelector('.panel[data-panel="storage"]')?.classList.contains('active');
    return { elapsedMs: performance.now() - started, active };
  });
  await page.waitForFunction(() => {
    const body = document.querySelector('#storageRows');
    return body && !String(body.textContent || '').includes('불러오는 중');
  }, null, { timeout: 10000 });

  const beforeHidden = await page.evaluate(async () => {
    await window.__FlashbackMemory.closeUi();
    return window.__FlashbackMemory.uiStatus();
  });
  await page.evaluate(async () => {
    const messages = [
      { role: 'system', content: '한국어로 응답한다.' },
      { role: 'user', memo: 'NewChat', chatId: 'gui-hidden-current', content: '기록실의 은색 열쇠를 다시 확인한다.' }
    ];
    for (let index = 0; index < 4; index += 1) {
      for (const handler of window.__guiPerfReplacers.beforeRequest || []) await handler(messages, 'model');
    }
  });
  const afterHidden = await page.evaluate(() => window.__FlashbackMemory.uiStatus());

  const reopen = await page.evaluate(async () => {
    const started = performance.now();
    const ok = await window.__flashbackShowUi();
    const elapsedMs = performance.now() - started;
    return { ok, elapsedMs, status: window.__FlashbackMemory.uiStatus() };
  });

  const assertions = [
    { name: 'seeded_large_response_memory', ok: Number(seedResult?.total || 0) >= RECORD_COUNT },
    { name: 'first_gui_open_completed', ok: firstOpen.ok === true && firstOpen.elapsedMs < 3000, detail: firstOpen.elapsedMs },
    { name: 'advanced_tab_switch_is_synchronous', ok: advancedSwitchMs.active === true && advancedSwitchMs.elapsedMs < 50, detail: advancedSwitchMs.elapsedMs },
    { name: 'storage_tab_switch_is_synchronous', ok: storageSwitchMs.active === true && storageSwitchMs.elapsedMs < 50, detail: storageSwitchMs.elapsedMs },
    { name: 'hidden_gui_does_not_reload_summary_manifests', ok: Number(afterHidden.perf.currentStatsLoads || 0) === Number(beforeHidden.perf.currentStatsLoads || 0), detail: { before: beforeHidden.perf, after: afterHidden.perf } },
    { name: 'hidden_gui_refreshes_are_skipped', ok: Number(afterHidden.perf.hiddenRefreshSkips || 0) > Number(beforeHidden.perf.hiddenRefreshSkips || 0), detail: { before: beforeHidden.perf.hiddenRefreshSkips, after: afterHidden.perf.hiddenRefreshSkips } },
    { name: 'reopen_reuses_mounted_dom', ok: reopen.ok === true && Number(reopen.status.perf.fullMounts || 0) === 1 && reopen.elapsedMs < 1000, detail: { elapsedMs: reopen.elapsedMs, perf: reopen.status.perf } },
    { name: 'no_browser_page_errors', ok: pageErrors.length === 0, detail: pageErrors }
  ];
  const output = {
    ok: assertions.every(item => item.ok),
    assertions,
    records: RECORD_COUNT,
    firstOpenMs: Number(firstOpen.elapsedMs.toFixed(2)),
    advancedSwitchMs: Number(advancedSwitchMs.elapsedMs.toFixed(2)),
    storageSwitchMs: Number(storageSwitchMs.elapsedMs.toFixed(2)),
    reopenMs: Number(reopen.elapsedMs.toFixed(2)),
    perf: reopen.status.perf
  };
  console.log(JSON.stringify(output, null, 2));
  await browser.close();
  process.exit(output.ok ? 0 : 1);
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
