'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, installedSdkVariants } = require('./storage_global_allchat_job_test.cjs');
const { makePanelDom } = require('./helpers/global-allchat-panel-dom.cjs');

const selectorControl = makePanelDom();
selectorControl.container.innerHTML = '<span data-job-retry></span>';
assert.throws(() => selectorControl.root.querySelector('button[data-job-retry]').onclick,
  /panel_selector_missing/, 'a stats span cannot stand in for an action button');

async function waitForApproval(dom) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const approve = dom.byAttr('data-mode-confirm-approve');
    if (typeof approve.onclick === 'function') return approve;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Mode confirmation did not appear');
}

for (const variant of installedSdkVariants) {
  const [namespace] = variant;
  test(`${namespace}: global Apply waits for consent, shows batch progress and can stop and reapply`, { timeout: 15000 }, async () => {
    const dom = makePanelDom();
    let holdBatch = true;
    let releaseBatch, enterBatch;
    const blocked = new Promise(resolve => { releaseBatch = resolve; });
    const entered = new Promise(resolve => { enterBatch = resolve; });
    const f = await fixture(variant, {
      transportFactory: base => async (url, init) => {
        if (holdBatch && new URL(url).pathname === '/v1/kv/batch') {
          holdBatch = false;
          enterBatch();
          await blocked;
        }
        return base(url, init);
      }
    });
    let applying;
    try {
      f.context.confirm = () => { throw Error('Native confirmation forbidden'); };
      await f.bridge.mountConnectionPanel(dom.container);
      assert.doesNotMatch(dom.container.innerHTML, /data-scope-perchat/);
      assert.match(dom.container.innerHTML, /data-scope-global/);

      for (const radio of dom.radios) radio.checked = radio.value === 'server_only';
      applying = dom.byAttr('data-apply').onclick();
      const approve = await waitForApproval(dom);
      assert.equal(dom.byAttr('data-mode-confirm-title').textContent, '저장 위치 전환 확인');
      assert.match(dom.byAttr('data-mode-confirm-text').textContent, /플러그인 단독에서 서버 단독/);
      assert.equal(f.bridge.getSyncJob(), null);

      approve.onclick();
      await Promise.race([entered, applying.then(() => { throw Error('Apply finished before the first batch'); })]);
      const stoppedJob = f.bridge.getSyncJob();
      assert.equal(stoppedJob.phase, 'copy');
      assert.match(dom.byAttr('data-job-count').textContent, /대화 3개 · 항목 0 \/ 2/);
      assert.match(dom.byAttr('data-job-workflow').textContent, /현재 설정: 플러그인 단독 · 목표 설정: 서버 단독/);
      assert.match(dom.byAttr('data-job-cancel').textContent, /전환 중단 · 원본 유지/);
      await dom.byAttr('data-job-cancel').onclick();
      releaseBatch();
      await applying;

      assert.equal(f.bridge.getSyncJob().status, 'cancelled');
      assert.equal((await f.bridge.getGlobalMode()).mode, 'plugin_only');
      assert.equal(await f.proxy.getItem(namespace + '.A'), 'A_SOURCE');
      assert.equal(f.values.get(namespace + '.B'), 'B_SOURCE');

      for (const radio of dom.radios) radio.checked = radio.value === 'server_only';
      applying = dom.byAttr('data-apply').onclick();
      (await waitForApproval(dom)).onclick();
      await applying;

      const completed = f.bridge.getSyncJob();
      assert.notEqual(completed.jobId, stoppedJob.jobId);
      assert.equal(completed.status, 'completed', dom.byAttr('data-status').textContent);
      assert.equal(completed.matched, 2, 'reapply reuses the completed batch by digest');
      assert.equal(completed.uploaded, 0);
      assert.match(dom.byAttr('data-job-count').textContent, /대화 3개 · 항목 2 \/ 2/);
      assert.match(dom.byAttr('data-status').textContent, /전역 설정 적용 완료 · 서버 단독/);
      assert.equal((await f.bridge.getScopeMode({ scopeId: 'A' })).mode, 'server_only');
    } finally {
      releaseBatch();
      await applying;
      dom.root.isConnected = false;
      await f.close();
    }
  });
}
