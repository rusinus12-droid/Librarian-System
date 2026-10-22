'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { boot, clean } = require('./libra_approved_browser.cjs');
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-status-'));
  const pluginPath = path.join(temporary, 'LIBRA.js');
  const source = fs.readFileSync(path.join(__dirname, '../../plugins/LIBRA.js'), 'utf8');
  const seam = 'MemorySuiteStorageBridge.getScopeMode(scope).then(value => {';
  assert.equal(source.split(seam).length, 2);
  fs.writeFileSync(pluginPath, source.replace(seam, '(globalThis.__statusModeRead ? globalThis.__statusModeRead(scope) : MemorySuiteStorageBridge.getScopeMode(scope)).then(value => {'));
  const previous = process.env.LIBRA_TEST_PLUGIN;
  process.env.LIBRA_TEST_PLUGIN = pluginPath;
  const { browser, page, errors } = await boot({ expose: ['Gui', 'Runtime', 'LibraMemoryCore', 'MemorySuiteStorageBridge', 'syncBookCurrentStatus', 'bookCurrentStatus', 'bookSettingsRoomActiveSection', 'LibraProviderBridge'] });
  try {
    const foot = page.locator('.side-foot');
    await page.waitForFunction(() => /저장: 플러그인 모드/.test(document.querySelector('.side-foot')?.textContent || ''));
    assert.equal(await foot.locator('[data-current-status]').count(), 3);
    assert.match(await foot.textContent(), /현재 상태.*저장: 플러그인 모드.*분석: 보조 모델.*검색: 키워드.*각 항목을 눌러 설정 변경/s);
    await page.evaluate(() => { __approved.Gui.state.runtime.defaultPresetName = 'UNSAVED'; __approved.Gui.state.agents.librarian.presetName = 'UNSAVED'; __approved.syncBookCurrentStatus(__approved.Gui.mockupApp); });
    assert.equal(await foot.locator('[data-current-status="analysis"]').textContent(), '분석: 보조 모델');
    const boxes = await foot.locator('[data-current-status]').evaluateAll(rows => rows.map(row => ({ top: row.offsetTop, height: row.offsetHeight, overflow: row.scrollWidth > row.clientWidth })));
    assert.ok(boxes.every(row => !row.overflow));
    assert.ok(boxes[1].top >= boxes[0].top + boxes[0].height && boxes[2].top >= boxes[1].top + boxes[1].height, 'each status uses its own row');
    for (const [id, section] of [['storage', 'server'], ['analysis', 'pipeline'], ['search', 'embedding']]) {
      await foot.locator(`[data-current-status="${id}"]`).click();
      await page.waitForFunction(value => __approved.bookSettingsRoomActiveSection() === value, section);
      await page.locator(`[data-product-settings-section="${section}"]`).waitFor();
    }
    await foot.locator('[data-current-status="storage"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => __approved.bookSettingsRoomActiveSection() === 'server');
    await page.screenshot({ path: '/tmp/libra-current-status-desktop.png', fullPage: true });
    await page.evaluate(() => {
      globalThis.__statusReplies = [];
      globalThis.__statusModeRead = () => new Promise(resolve => __statusReplies.push(resolve));
      __approved.syncBookCurrentStatus(__approved.Gui.mockupApp);
      __approved.syncBookCurrentStatus(__approved.Gui.mockupApp);
      __statusReplies[1]({ mode: 'server_only' });
    });
    await page.waitForFunction(() => document.querySelector('[data-current-status="storage"]').textContent === '저장: 서버 모드');
    await page.evaluate(() => __statusReplies[0]({ mode: 'plugin_only' }));
    assert.equal(await foot.locator('[data-current-status="storage"]').textContent(), '저장: 서버 모드', 'late old reply cannot overwrite new mode');
    await page.evaluate(() => { __approved.syncBookCurrentStatus(__approved.Gui.mockupApp); __statusReplies.at(-1)({ mode: 'plugin_only', transition: { toMode: 'server_only' } }); });
    await page.waitForFunction(() => /전환 확인 필요/.test(document.querySelector('[data-current-status="storage"]').textContent));
    await clean(page, errors);
    console.log('libra_current_status_browser_test: PASS (separate rows, saved settings, 3 live destinations, keyboard, no model calls)');
  } finally { await browser.close(); if (previous === undefined) delete process.env.LIBRA_TEST_PLUGIN; else process.env.LIBRA_TEST_PLUGIN = previous; fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
