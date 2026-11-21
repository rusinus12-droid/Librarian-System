'use strict';
// The 최근 작업 overview must report what actually ran, driven through the real hook and provider path,
// and the header pill and the status dialog must read that same overview.
//
// Run: node tests/libra_recent_work_runtime_test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');
const { create, pause } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const config = { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings', model: 'text-embedding-3-small', key: 'synthetic-not-a-real-key', dimensions: 256, maxRetries: 0 };
const response = init => {
  const texts = JSON.parse(init.body).input;
  return new Response(JSON.stringify({ data: texts.map((_, index) => ({ index, embedding: Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0) })), usage: { total_tokens: 10 } }), { status: 200 });
};
const jobOf = (overview, id) => overview.jobs.find(job => job.id === id);
const partOf = (overview, id) => jobOf(overview, 'embedding').parts.find(part => part.id === id);

(async () => {
  {
    const f = await fixture();
    try {
      const empty = await f.r.api.getRecentWorkOverview();
      assert.deepEqual([...empty.jobs].map(job => job.id), ['canonical', 'micro', 'lens', 'state', 'embedding']);
      assert.equal(jobOf(empty, 'embedding').status, 'off', 'embedding off is reported as off, not as healthy');
      await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
      await f.r.api.saveEmbeddingSettings(config);
      let requests = 0;
      f.r.context.risuai.nativeFetch = async (url, init) => { requests++; return response(init); };
      await f.run();
      await waitFor(() => f.getMemory()?.embedding.status === 'ready');
      const stored = await f.r.api.getRecentWorkOverview();
      assert.equal(jobOf(stored, 'canonical').status === 'failed', false);
      assert.match(jobOf(stored, 'canonical').headline, /1개 · T5까지 작성/);
      assert.equal(partOf(stored, 'canonical').ready, 1);
      assert.equal(partOf(stored, 'canonical').total, 1);
      assert.equal(partOf(stored, 'canonical').last.ok, true, 'the canonical vector call is recorded');
      assert.equal(partOf(stored, 'query').last, null, 'no query call is claimed before a recall');
      const before = requests;
      await f.control.hooks.beforeRequest([{ role: 'system', content: '장면을 이어가세요.' }, { role: 'user', content: '민아의 은빛 열쇠는 누가 가지고 있어?' }], 'model');
      const recalled = await f.r.api.getRecentWorkOverview();
      assert.ok(requests > before, 'the recall really called the embedding provider');
      assert.equal(partOf(recalled, 'query').last.ok, true);
      assert.ok(partOf(recalled, 'query').last.requests > 0);
      assert.ok(partOf(recalled, 'query').used, 'whether recall used the vectors is reported');
      assert.ok(partOf(recalled, 'query').used.admitted > 0, JSON.stringify(partOf(recalled, 'query').used));
      assert.match(jobOf(recalled, 'embedding').note, /최근 검색에 벡터 \d+개 사용/);
    } finally { await f.r.cleanup(); }
  }
  {
    const f = await fixture();
    try {
      await f.r.api.saveEmbeddingSettings(config);
      f.r.context.risuai.nativeFetch = async () => { throw new Error('deliberate_embedding_failure'); };
      await f.run();
      await waitFor(() => f.getMemory()?.embedding.status === 'retry_pending');
      const failed = await f.r.api.getRecentWorkOverview();
      assert.equal(jobOf(failed, 'embedding').status, 'failed');
      assert.match(jobOf(failed, 'embedding').error, /deliberate_embedding_failure/);
      assert.equal(partOf(failed, 'canonical').ready, 0, 'a failed call never counts as a stored vector');
      assert.equal(failed.tone, 'danger');
    } finally { await f.r.cleanup(); }
  }
  {
    // "확인 필요" for user-settled conflicts names where to settle them, right under the badge.
    // Only the condition is forced here; the hint text and the renderer are the shipped ones.
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-recent-work-hint-'));
    const pluginPath = path.join(temporary, 'LIBRA.js');
    const condition = '        statusHint: !stateRead.error && !replayError.value && !pendingApplications && authority.pending === true && stateProjectionAwaitsUser(authority) ?';
    const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
    assert.equal(source.split(condition).length, 2, 'the State card hint condition is present once');
    fs.writeFileSync(pluginPath, source.replace(condition, () => '        statusHint: true ?'));
    let host;
    try {
      host = await create('LIBRA', 'Full', { pluginPath, initialChat: input.sourceRows.map(row => ({ role: row.role, chatId: row.ref, data: row.text })) });
      await host.open();
      const { doc } = host;
      await pause(800);
      doc.querySelector('.topbar .health').click();
      await pause(500);
      const card = doc.querySelector('#dialog-state [data-recent-work-job="state"]');
      assert.ok(card, 'the State projection card renders');
      const hint = card.querySelector('[data-recent-work-status-hint="state"]');
      assert.ok(hint, 'the review hint renders on the State card');
      assert.equal(hint.textContent, '자동 반영 검토에서 검토 가능');
      assert.ok(card.querySelector('.card__head').contains(hint), 'the hint sits with the status badge');
      assert.equal(doc.querySelectorAll('[data-recent-work-status-hint]').length, 1, 'other cards carry no hint');
    } finally { await host?.close?.(); fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-recent-work-gui-'));
    const pluginPath = path.join(temporary, 'LIBRA.js');
    fs.copyFileSync(path.join(__dirname, '../plugins/LIBRA.js'), pluginPath);
    let host;
    try {
      host = await create('LIBRA', 'Full', { pluginPath, initialChat: input.sourceRows.map(row => ({ role: row.role, chatId: row.ref, data: row.text })) });
      await host.open();
      const { doc } = host;
      await pause(800);
      const pill = doc.querySelector('.topbar .health');
      assert.ok(pill, 'the header keeps one health pill');
      assert.match(pill.title, /최근 작업/);
      pill.click();
      await pause(500);
      const dialog = doc.querySelector('#dialog-state');
      assert.ok(dialog, 'the health pill opens the status dialog');
      assert.ok(dialog.querySelector('.kv'), 'the status values stay');
      const tabs = () => [...dialog.querySelectorAll('[data-execution-logs] [role="tab"]')];
      assert.deepEqual(tabs().map(tab => tab.textContent), ['최근 작업', '작업 로그', '오류']);
      assert.deepEqual([...dialog.querySelectorAll('[data-recent-work-job]')].map(node => node.dataset.recentWorkJob), ['canonical', 'micro', 'lens', 'state', 'embedding']);
      assert.equal(dialog.querySelector('[data-recent-work-status-hint]'), null, 'no review hint while nothing waits on the user');
      // Layout: the actions live in the header above the summary, and 실행 기록 is one framed
      // section whose selected view is drawn inside it, under its own tabs.
      const head = dialog.querySelector('.dialog > [data-state-dialog-head]');
      assert.ok(head && head === dialog.querySelector('.dialog').firstElementChild, 'the header opens the dialog');
      assert.deepEqual([...head.querySelectorAll('.dialog__actions > button')].map(button => button.textContent), ['⚡ 상태 점검 및 자동 복구', '전체 상태 확인', '닫기']);
      assert.equal(dialog.querySelectorAll('.dialog__actions').length, 1, 'no second action row at the bottom');
      assert.ok(head.compareDocumentPosition(dialog.querySelector('.kv')) & 4, 'the summary follows the header');
      const logs = dialog.querySelector('section.exec-logs[data-execution-logs]');
      assert.ok(logs.querySelector(':scope > .exec-logs__head [role="tablist"]'), 'the view tabs head the section');
      assert.ok(logs.querySelector(':scope > .exec-logs__body[role="tabpanel"] [data-recent-work-job]'), 'the selected view sits inside the same section');
      const css = [...doc.querySelectorAll('style')].map(node => node.textContent).join('\n');
      assert.match(css, /\.state-dialog__head\{position:sticky/, 'the layout rules are in the stylesheet injected at mount');
      assert.match(css, /\.exec-logs__body\{/);
      tabs()[1].click();
      await pause(300);
      assert.ok(dialog.querySelector('[data-execution-work-log="all"]'), 'the log merges every receipt kind by default');
      tabs()[2].click();
      await pause(300);
      assert.ok(dialog.querySelector('[data-execution-errors]'));

      // With the same panel on the page behind it, every dialog click must still switch the dialog.
      dialog.remove();
      doc.querySelector('.sidebar [data-go="settings"]').click();
      await pause(600);
      [...doc.querySelectorAll('button')].find(button => button.textContent.includes('기록 보관소')).click();
      await pause(800);
      doc.querySelector('.topbar .health').click();
      await pause(500);
      const stacked = doc.querySelector('#dialog-state');
      assert.equal(doc.querySelectorAll('[data-execution-logs]').length, 2, 'the page and the dialog both show the panel');
      for (const [index, view] of [[1, 'log'], [0, 'recent'], [2, 'errors'], [1, 'log'], [0, 'recent']]) {
        stacked.querySelectorAll('[data-execution-logs] [role="tab"]')[index].click();
        await pause(500);
        assert.equal(stacked.querySelector('[data-execution-logs]').dataset.executionLogs, view);
      }

      const source = fs.readFileSync(pluginPath, 'utf8');
      assert.match(source, /GUI_SCROLL_SELECTORS = Object\.freeze\(\[[^\]]*'\.wl-list'/, 'selecting a turn keeps the turn list scroll');
      assert.doesNotMatch(source, /publication\?\.scopeKey===snap\.scope\?\.scopeKey/, 'two missing scopes must not read a null publication');
    } finally {
      await host?.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  console.log('libra_recent_work_runtime_test: PASS');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
