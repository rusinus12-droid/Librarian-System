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
      assert.deepEqual([...empty.jobs].map(job => job.id), ['canonical', 'micro', 'lens', 'state', 'embedding', 'gradia']);
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
      assert.deepEqual([...dialog.querySelectorAll('[data-recent-work-job]')].map(node => node.dataset.recentWorkJob), ['canonical', 'micro', 'lens', 'state', 'embedding', 'gradia']);
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
