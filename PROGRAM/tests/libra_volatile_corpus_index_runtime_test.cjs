'use strict';
// LIBRA runtime-only common index.
//
// Without a published durable index every unified recall re-enumerates and re-projects
// every owner window (seconds per request on a long chat). After such a cold recall the
// engine builds the same common index into runtime memory in the background; the next
// recall reads it through the same corpus read path, so owner sources and their
// currentness proofs are still checked against storage. It must:
//   1. serve later recalls from `volatile_common_index`,
//   2. deliver exactly what the durable index delivers for the same sources,
//   3. never write storage (plugin_only cannot reclaim superseded index pages),
//   4. be dropped when owner sources change, so a stale index is never consulted.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const QUERY = '은빛 열쇠는 누가 가지고 있지?';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const moreTurns = (f, batch) => {
  const extra = f.chat.message.slice(0, 10).map((m, i) => ({ ...m, chatId: `t${5 * batch + 1 + Math.floor(i / 2)}-${i % 2 ? 'a' : 'u'}` }));
  f.chat.message.push(...extra);
  f.control.artifact = artifact();
  for (const x of [...f.control.artifact.entities, ...f.control.artifact.facts]) {
    for (const e of x.evidenceSpans) e.ref = e.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + 5 * batch}`);
  }
};
const excerpts = recall => JSON.stringify(Array.from(recall.memories, row => String(row?.excerpt || '')).sort());
// Recalls make a background build yield, so wait for it without issuing queries.
const waitForRuntimeIndex = async (f, timeoutMs = 60000) => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    const status = f.r.api.inspectVolatileMemoryGraphCorpus();
    if (status.available && !status.building && !status.scheduled) return status;
  }
  throw new Error('runtime index was never built: ' + JSON.stringify(f.r.api.inspectVolatileMemoryGraphCorpus()));
};
const recallFromRuntimeIndex = async f => {
  await waitForRuntimeIndex(f);
  const recall = await f.r.api.previewUnifiedMemoryRecall(QUERY);
  assert.equal(recall.corpusRead?.mode, 'volatile_common_index');
  return recall;
};

async function run(mode) {
  let interrupted = false;
  const snapshot = await serverFixture({ mode,
    host: { beforeVolatileBuild: () => {
      if (!interrupted) { interrupted = true; throw new Error('LIBRA_GRAPH_READER_BODY_CHANGED'); }
    } },
    transformSource: source => {
      const anchor = 'const buildMemoryGraphCorpusInto = async (options, volatile, yieldCheck = null) => {';
      assert.equal(source.split(anchor).length, 2);
      return source.replace(anchor, anchor + '\n      if (volatile) risuai.beforeVolatileBuild();');
    }
  });
  try {
    const f = snapshot.f;
    await f.run();
    moreTurns(f, 1); await f.run(); await f.r.api.retryPendingUnifiedVectors?.();
    await sleep(500);
    const localBytes = () => [...snapshot.local].reduce((sum, [, value]) => sum + String(value).length, 0);
    const serverRows = () => snapshot.storedRows().length;

    const cold = await f.r.api.previewUnifiedMemoryRecall(QUERY);
    assert.ok(cold.memories.length >= 1, `${mode}: cold recall delivers memory`);
    const before = { local: localBytes(), server: serverRows() };

    const warm = await recallFromRuntimeIndex(f);
    assert.equal(excerpts(warm), excerpts(cold), `${mode}: runtime index delivers what the request-local corpus delivered`);
    assert.equal(localBytes(), before.local, `${mode}: the runtime index writes no local storage`);
    assert.equal(serverRows(), before.server, `${mode}: the runtime index writes no server rows`);

    // New owner sources: the runtime index is dropped, then rebuilt for the new sources.
    moreTurns(f, 2); await f.run(); await f.r.api.retryPendingUnifiedVectors?.();
    const afterWrite = await f.r.api.previewUnifiedMemoryRecall(QUERY);
    assert.notEqual(afterWrite.corpusRead?.mode, 'volatile_common_index', `${mode}: a stale runtime index is not consulted after owner writes`);
    const rebuilt = await recallFromRuntimeIndex(f);

    await f.r.api.buildMemoryGraphCorpus();
    const durable = await f.r.api.previewUnifiedMemoryRecall(QUERY);
    assert.equal(durable.corpusRead?.mode, 'durable_common_index');
    assert.equal(excerpts(rebuilt), excerpts(durable), `${mode}: runtime and durable indexes deliver the same memory`);
    assert.equal(f.r.api.inspectVolatileMemoryGraphCorpus().failures, 0, `${mode}: background builds did not fail`);
    assert.ok(f.r.api.inspectVolatileMemoryGraphCorpus().sourceChangeRetries >= 1, `${mode}: a torn whole-build snapshot is retried`);
    return { mode, coldItems: cold.memories.length, warmItems: warm.memories.length };
  } finally { await snapshot.cleanup(); }
}

(async () => {
  const results = [];
  for (const mode of ['plugin_only', 'server_only']) results.push(await run(mode));
  console.log(JSON.stringify({ test: 'libra_volatile_corpus_index_runtime', results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
