'use strict';
// Full deployed plugin in Chromium. Host, model and storage are isolated fixtures.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const program = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[2] || path.join(program, '../../ui-patches/libra-workbench/applied-2.3.68/browser'));
fs.mkdirSync(output, { recursive: true });
const results = [], errors = [];
const check = (name, value) => { assert.ok(value, name); results.push(name); };
(async () => {
  const browser = await chromium.launch({ executablePath: (process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', e => errors.push(e.stack || e.message));
    await page.setContent('<html lang="ko"><body></body></html>');
    await page.addScriptTag({ path: path.join(__dirname, 'libra_writer_host.js') });
    let source = fs.readFileSync(path.join(program, 'plugins/LIBRA.js'), 'utf8');
    const needle = '  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
    assert.ok(source.includes(needle));
    source = source.replace(needle, '  globalThis.__audit={Gui,bookNavigate,selectBookSettingsRoomSection,bookOpenQuickSettings,saveBookQuickSettings,revertGuiStateFromStorage};\n' + needle);
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => !!window.__LIBRA__);
    await page.evaluate(async () => await __LIBRA__.openSettingsGui());
    await page.locator('[data-external-settings="pipeline"]').click();
    await page.waitForSelector('[data-agent-quick-settings-summary="draft"]');
    check('one workbench; removed agent detail sidebar', await page.locator('[data-external-settings="agents"]').count() === 0);
    check('workbench has no duplicated mode or budget editor', await page.locator('[data-native-settings-room] [data-consumer-policy-group], [data-native-settings-room] [data-generation-policy]').count() === 0);
    await page.screenshot({ path: path.join(output, 'workbench.png') });
    await page.getByRole('button', { name: 'LIBRA 빠른 설정 열기', exact: true }).click();
    const drawer = page.locator('[data-book-quick-drawer]');
    await drawer.waitFor();
    check('classic mode hides planner policy', await drawer.locator('[data-consumer-policy-group="planner"]').count() === 0);
    await drawer.getByRole('button', { name: /^플래너 모드/ }).click();
    await drawer.locator('[data-consumer-policy-group="planner"]').waitFor();
    check('planner change makes draft dirty', await page.evaluate(() => __audit.Gui.dirty));
    check('memory budget absent from LIBRA quick tab', await drawer.locator('[data-generation-policy]').count() === 0);
    await drawer.getByRole('tab', { name: '기억 Agent', exact: true }).click();
    await drawer.locator('[data-generation-policy]').waitFor();
    check('memory quick tab owns analyzer and request budget', await drawer.locator('[data-librarian-analyzer]').count() === 1);
    await page.screenshot({ path: path.join(output, 'memory-quick.png') });
    await drawer.getByRole('button', { name: '기억 분석 고급 설정 →', exact: true }).click();
    await page.waitForSelector('[data-agent-quick-settings-summary="memory"]');
    check('navigation preserves unsaved planner selection', await page.evaluate(() => __audit.Gui.dirty && __audit.Gui.state.runtime.libraResponseMode === 'planner'));
    check('memory workbench has no duplicate model selector', await page.locator('[data-librarian-analyzer] select').count() === 0);
    check('memory prompt editor has one advanced entry', await page.getByText('고급 프롬프트 설정', { exact: true }).count() === 1);
    await page.getByRole('button', { name: '기억 Agent 빠른 설정 열기', exact: true }).click();
    check('shared save succeeds', await page.evaluate(async () => await __audit.saveBookQuickSettings()));
    await page.evaluate(async () => await __audit.revertGuiStateFromStorage());
    check('saved mode survives storage reload', await page.evaluate(() => !__audit.Gui.dirty && __audit.Gui.state.runtime.libraResponseMode === 'planner'));
    await page.evaluate(() => { __audit.Gui.agentHubSection = 'memory'; __audit.selectBookSettingsRoomSection('agents'); });
    await page.waitForSelector('[data-agent-quick-settings-summary="memory"]');
    await page.waitForFunction(() => document.querySelector('[data-external-settings="pipeline"]')?.dataset.active === 'true');
    check('legacy agent route highlights unified workbench', await page.locator('[data-external-settings="pipeline"]').getAttribute('data-active') === 'true');
    await page.locator('[data-book-quick-drawer]').waitFor({ state: 'detached' });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.screenshot({ path: path.join(output, `memory-workbench-${width}.png`) });
      check(`workbench fits ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    check('settings work makes zero model requests', await page.evaluate(() => __writerHost.calls.model === 0));
    check('no uncaught browser errors', errors.length === 0);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, boundary: 'Full deployed plugin and Chromium; controlled host/storage, not installed RisuAI' }, null, 2));
  }
  console.log(JSON.stringify({ test: 'libra_workbench_consolidation_browser', passed: results.length, errors }));
})().catch(error => { console.error(error); process.exitCode = 1; });
