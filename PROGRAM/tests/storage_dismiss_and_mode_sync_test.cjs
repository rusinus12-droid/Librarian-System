'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, variants } = require('./storage_global_allchat_job_test.cjs');
const { makePanelDom } = require('./helpers/global-allchat-panel-dom.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const variant of variants) {
  const namespace = variant[0];

  test(`${namespace} dismissed completed job remains hidden across panel remounts (settings save / reopen)`, async () => {
    const f = await fixture(variant);
    const dom1 = makePanelDom();
    const dom2 = makePanelDom();

    try {
      // 1. Set global mode to server_only
      await f.bridge.setGlobalMode('server_only');
      await pause(30);

      const job = f.bridge.getSyncJob();
      assert.equal(job.status, 'completed', 'job must be completed');

      // 2. Mount panel 1
      await f.bridge.mountConnectionPanel(dom1.container);
      const jobCard1 = dom1.byAttr('data-job');
      assert.equal(jobCard1.classList.contains('show'), true, 'initial completed job must be shown before user dismisses');

      // Verify mode label and radio selection
      assert.equal(dom1.byAttr('data-current-mode').textContent, '현재 전역 모드: 서버 단독');
      const serverRadio1 = dom1.radios.find(r => r.value === 'server_only');
      const pluginRadio1 = dom1.radios.find(r => r.value === 'plugin_only');
      assert.equal(serverRadio1?.checked, true, 'server_only radio must be checked initially');
      assert.equal(pluginRadio1?.checked, false, 'plugin_only radio must not be checked');

      // 3. User clicks [결과 확인 닫기] (data-job-dismiss)
      const dismissBtn = dom1.byAttr('data-job-dismiss');
      assert.ok(dismissBtn.onclick, 'dismiss button must have click handler');
      dismissBtn.onclick();

      assert.equal(jobCard1.classList.contains('show'), false, 'job card must be hidden after dismissal');

      // 4. Panel is unmounted and remounted (simulating saveSettingsRoom / renderSettingsGui / reopen)
      dom1.root.isConnected = false;
      await f.bridge.mountConnectionPanel(dom2.container);

      const jobCard2 = dom2.byAttr('data-job');
      assert.equal(jobCard2.classList.contains('show'), false, 'completed job must REMAIN hidden on remount after dismissal');

      // Verify mode label and radio selection remain server_only in dom2
      assert.equal(dom2.byAttr('data-current-mode').textContent, '현재 전역 모드: 서버 단독');
      const serverRadio2 = dom2.radios.find(r => r.value === 'server_only');
      const pluginRadio2 = dom2.radios.find(r => r.value === 'plugin_only');
      assert.equal(serverRadio2?.checked, true, 'server_only radio must stay checked on remount');
      assert.equal(pluginRadio2?.checked, false, 'plugin_only radio must not flip to checked on remount');
    } finally {
      dom1.root.isConnected = false;
      dom2.root.isConnected = false;
      await f.close();
    }
  });

  test(`${namespace} starting a new job resets dismissed status so the new job is visible`, async () => {
    const f = await fixture(variant);
    const dom1 = makePanelDom();
    const dom2 = makePanelDom();

    try {
      await f.bridge.setGlobalMode('server_only');
      await pause(30);

      await f.bridge.mountConnectionPanel(dom1.container);
      dom1.byAttr('data-job-dismiss').onclick();
      assert.equal(dom1.byAttr('data-job').classList.contains('show'), false);

      // Start new job (switch back to plugin_only)
      dom1.root.isConnected = false;
      const newJobPromise = f.bridge.setGlobalMode('plugin_only');
      await pause(20);

      // Mount new panel while job is active / completing
      await f.bridge.mountConnectionPanel(dom2.container);
      await newJobPromise;
      await pause(20);

      // The new job should be shown because it has a new jobId
      const jobCard2 = dom2.byAttr('data-job');
      assert.equal(jobCard2.classList.contains('show'), true, 'new job must be shown and not suppressed by previous dismissal');
      assert.equal(dom2.byAttr('data-current-mode').textContent, '현재 전역 모드: 플러그인 단독');
    } finally {
      dom1.root.isConnected = false;
      dom2.root.isConnected = false;
      await f.close();
    }
  });
}
