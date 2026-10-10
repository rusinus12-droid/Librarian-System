'use strict';
// Full LIBRA UI in Chromium with isolated host/storage. No live RisuAI or provider call.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: (process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
    headless: true
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.setContent('<html lang="ko"><body></body></html>');
    await page.addScriptTag({ path: path.join(__dirname, 'libra_writer_host.js') });
    let source = fs.readFileSync(path.join(__dirname, '../../plugins/LIBRA.js'), 'utf8');
    const needle = '  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
    assert.ok(source.includes(needle));
    source = source.replace(needle,
      '  globalThis.__deskAudit={Gui,renderCanonicalJobSurface,selectBookSettingsRoomSection};\n' + needle);
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => !!window.__LIBRA__);
    await page.evaluate(async () => __LIBRA__.openSettingsGui());

    const modelCard = page.locator('[data-memory-model="analysis"]');
    await modelCard.waitFor();
    assert.equal(await modelCard.locator('select').count(), 1, 'Reading Desk exposes a Librarian preset selector');
    assert.equal(await modelCard.locator('[data-memory-model-save="analysis"]').count(), 1,
      'Reading Desk exposes an explicit preset save action');
    const selector = modelCard.locator('select');
    const alternatePreset = await selector.evaluate(node => [...node.options].find(option => option.value !== node.value)?.value || null);
    assert.notEqual(alternatePreset, null, 'fixture exposes an alternate preset binding');
    await selector.selectOption(alternatePreset);
    const presetSave = modelCard.locator('[data-memory-model-save="analysis"]');
    assert.equal(await presetSave.isEnabled(), true, 'changing the Reading Desk preset enables its save action');
    await presetSave.click();
    await page.waitForFunction(value => !__deskAudit.Gui.dirty
      && __deskAudit.Gui.state.agents.librarian.presetName === value, alternatePreset);

    const completed = {
      jobId: 'historical-completed', kind: 'manual_scan', state: 'completed', phase: 'complete',
      startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:10.000Z',
      total: 1, completed: 1, failed: 0, skipped: 0, message: '과거 작업 완료'
    };
    await page.evaluate(job => {
      __deskAudit.Gui.canonicalJobDismissedId = '';
      __deskAudit.Gui.canonicalJobObservedIds.clear();
      __deskAudit.renderCanonicalJobSurface(job);
    }, completed);
    assert.equal(await page.locator('.canonical-job-window').count(), 0,
      'historical completed jobs do not reopen on GUI entry');

    await page.evaluate(job => {
      const running = { ...job, state: 'running', phase: 'analysis', finishedAt: '', completed: 0, message: '현재 작업 실행 중' };
      __deskAudit.Gui.canonicalJobDismissedId = '';
      __deskAudit.renderCanonicalJobSurface(running);
    }, completed);
    assert.equal(await page.locator('[data-book-job-summary="running"]').count(), 1, 'active jobs remain visible in Reading Desk');
    await page.evaluate(job => __deskAudit.renderCanonicalJobSurface(job), completed);
    assert.equal(await page.locator('[data-book-job-summary="completed"]').count(), 1, 'completion stays in Reading Desk');
    assert.equal(await page.locator('.canonical-job-window').count(), 0, 'routine completion never overlays the workspace');

    await page.evaluate(() => __deskAudit.selectBookSettingsRoomSection('pipeline'));
    const workbench = page.locator('.libra-agent-workspace');
    await workbench.waitFor();
    assert.equal(await workbench.getByRole('tab', { name: '상태 추적', exact: true }).count(), 0,
      'Agent Workbench no longer exposes the non-actionable state tracking tab');
    assert.equal(await workbench.getByRole('tab', { name: '기억 작성', exact: true }).count(), 1);
    assert.equal(await workbench.getByRole('tab', { name: /LIBRA 응답|GRADIA 초안/ }).count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS Reading Desk preset control, historical job suppression, and two-tab Agent Workbench');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
