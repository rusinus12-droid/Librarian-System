'use strict';
// HAYAKU GUI data check, step 2: load the state saved by hayaku_gui_llm_check.cjs into an
// ephemeral RisuAI host in Chromium, run the REAL plugin, open its GUI and capture every view
// that shows HAYAKU-written data. No model is called here (runLLMModel throws).
// Usage: node tools/rag_eval/hayaku_gui_browser_render.cjs --state state.json --out dir
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const state = JSON.parse(fs.readFileSync(arg('--state'), 'utf8'));
const out = arg('--out'); fs.mkdirSync(out, { recursive: true });
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const source = fs.readFileSync(path.join(ROOT, 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');
const anchor = '  await install();';
if (source.split(anchor).length !== 2) throw new Error('install anchor');
const instrumented = source.replace(anchor, '  globalThis.__hvg = { Memory, viewerSetTab };\n' + anchor);
const host = fs.readFileSync(path.join(ROOT, 'tests', 'browser', 'hayaku_browser_host.js'), 'utf8')
  .replace("window.__chat={id:'gui-chat-A',chatId:'gui-chat-A',name:'GUI 검증용 채팅',message:[],messages:[],bindedPersona:''};",
    "window.__chat={id:__state.chat.id,chatId:__state.chat.id,name:__state.chat.name,message:__state.chat.message,messages:__state.chat.message,bindedPersona:''};")
  .replace("window.__character={id:'gui-character',chaId:'gui-character',name:'GUI 검증용 캐릭터',chatPage:0,chats:[__chat]};",
    "window.__character={id:__state.character.id,chaId:__state.character.id,name:__state.character.name,chatPage:0,chats:[__chat]};")
  .replace("const createStore=()=>{const v=new Map();", "const createStore=(seed=[])=>{const v=new Map(seed);")
  .replace("const host={pluginStorage:createStore(),safeLocalStorage:createStore(),", "const host={pluginStorage:createStore(__state.pluginStorage),safeLocalStorage:createStore(__state.safeLocalStorage),")
  .replace(/const args=new Map\(Object\.entries\(\{[^}]*\}\)\);/, "const args=new Map(__state.arguments);");
for (const needle of ['__state.chat.id', '__state.pluginStorage', 'new Map(__state.arguments)']) if (!host.includes(needle)) throw new Error('host seam ' + needle);

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const report = { views: [], errors: [], text: {} };
  try {
    for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport });
      page.on('pageerror', error => report.errors.push(`${label}: ${error.message}`));
      await page.setContent('<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0"></body></html>');
      await page.addScriptTag({ content: `window.__state=${JSON.stringify({ chat: state.chat, character: state.character, pluginStorage: state.pluginStorage, safeLocalStorage: state.safeLocalStorage, arguments: state.arguments })};` });
      await page.addScriptTag({ content: host });
      await page.addScriptTag({ content: instrumented });
      await page.waitForFunction(() => !!window.HAYAKU, null, { timeout: 30000 });
      await page.evaluate(() => HAYAKU.showUi());
      await page.waitForFunction(() => !!document.querySelector('.app[data-hayaku-mockup="1"]') && !__hvg.Memory.ledgerViewer.busy, null, { timeout: 30000 });
      await page.waitForTimeout(400);
      const goto = async tab => {
        await page.evaluate(t => __hvg.viewerSetTab(t), tab);
        await page.waitForFunction(t => __hvg.Memory.ledgerViewer.activeTab === t && !__hvg.Memory.ledgerViewer.busy, tab, { timeout: 20000 });
        await page.waitForTimeout(500);
      };
      const shot = async (name, selector = null) => {
        const file = path.join(out, `${label}_${name}.png`);
        if (selector && await page.locator(selector).count()) await page.locator(selector).first().screenshot({ path: file });
        else await page.screenshot({ path: file, fullPage: true });
        const panelText = await page.evaluate(() => (document.querySelector('[id^="hayakuViewerPanel"]:not([hidden])') || document.body).innerText);
        report.views.push({ label, name, file });
        report.text[`${label}_${name}`] = panelText;
      };
      await goto('overview'); await shot('overview');
      await goto('packets');
      if (await page.locator('[data-packet-view="list"]').count()) { await page.locator('[data-packet-view="list"]').first().click(); await page.waitForTimeout(300); }
      await shot('packets_list');
      const rows = page.locator('#hayakuViewerRecords [data-record-id], #hayakuViewerRecords [data-hayaku-record], #hayakuViewerRecords button, #hayakuViewerRecords .record');
      report.recordRowCount = await rows.count();
      for (const index of [0, 4, 7, 8]) {
        if (index >= report.recordRowCount) continue;
        await rows.nth(index).click(); await page.waitForTimeout(400);
        await shot(`packet_detail_${index}`);
      }
      if (report.recordRowCount) {
        await rows.nth(0).click(); await page.waitForTimeout(300);
        const axes = page.locator('[data-hayaku-record-detail-tab="axes"]');
        if (await axes.count()) { await axes.first().click(); await page.waitForTimeout(300); await shot('packet_detail_axes', '#hayakuViewerRecordDetail'); }
        const summary = page.locator('[data-hayaku-record-detail-tab="summary"]');
        if (await summary.count()) await summary.first().click();
      }
      // Each record's label, origin badge and state as rendered in the list.
      report.listRows = report.listRows || {};
      report.listRows[label] = await page.evaluate(() => [...document.querySelectorAll('#hayakuViewerRecords [data-hayaku-record-select]')].map(row => ({
        turn: row.querySelector('b')?.textContent || '', origin: row.querySelector('.pk-origin')?.textContent || '',
        state: row.querySelector('.badge')?.textContent || '', summary: (row.querySelector('strong')?.textContent || '').slice(0, 40) })));
      report.headerOverflow = report.headerOverflow || {};
      report.headerOverflow[label] = await page.evaluate(() => { const t = document.querySelector('.topbar'); return t ? t.scrollWidth - t.clientWidth : null; });
      if (await page.locator('[data-packet-view="worldline"]').count()) { await page.locator('[data-packet-view="worldline"]').first().click(); await page.waitForTimeout(400); await shot('packets_worldline'); }
      await goto('recovery');
      for (const view of ['missing', 'cold', 'failed']) {
        const button = page.locator(`[data-recovery-view="${view}"]`);
        if (await button.count()) { await button.first().click(); await page.waitForTimeout(400); await shot(`recovery_${view}`); }
      }
      await goto('logs'); await shot('logs');
      await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'render-report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ views: report.views.length, recordRowCount: report.recordRowCount, errors: report.errors }, null, 1));
})().catch(error => { console.error(error); process.exit(1); });
