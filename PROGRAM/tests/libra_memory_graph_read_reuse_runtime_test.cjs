'use strict';

// A durable graph build and a search over it used to spend most of their requests on work that
// proved nothing new: a lease confirmation around every page, the same immutable page fetched
// again on each table access, the root re-read after every page. These cases pin the request
// shape on the server route, where every one of them is a transport round trip.
const { test } = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const QUERY = { queryInput: { queryText: '은빛 열쇠 기록' }, semanticPolicy: { mode: 'disabled' } };
const observe = server => {
  const seen = [];
  server.hooks.beforeServerRequest = async (url, init) => {
    let body = null; try { body = init?.body ? JSON.parse(init.body) : null; } catch (_) {}
    const route = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    let key = body?.key || ''; if (!key) { try { key = new URL(url).searchParams.get('key') || ''; } catch (_) {} }
    seen.push({ route, action: body?.action || '', key });
  };
  return { take: () => seen.splice(0) };
};
const pageKey = row => /:memory-graph:v1:corpus:(?:page:[A-Za-z]+:|projection:|manifest:|proof:|forest:)[a-f0-9]{64}$/.test(row.key);

test('server route: a build and a search confirm their lease locally and read each immutable page once', async t => {
  const x = await fixture({ mode: 'server_only', microCount: 6, microText: turn => '민아는 은빛 열쇠에 관해 기록 ' + turn + '을 남겼다.', pauseAutomaticAnalysis: true });
  t.after(() => x.cleanup());
  const api = x.f.r.api, wire = observe(x.server);

  const built = await api.buildMemoryGraphCorpus({ incremental: true, resume: true });
  assert.equal(built.status, 'published');
  const build = wire.take();
  assert.equal(build.filter(row => row.action === 'assert').length, 0, 'a build lease inside its granted time is not re-confirmed over the wire');
  assert.equal(build.filter(row => row.action === 'acquire').length, 1);
  const writes = build.filter(row => row.route === '/v1/kv/batch').length;
  assert.ok(writes >= 10, 'the build really wrote pages');

  const again = await api.buildMemoryGraphCorpus({ incremental: true, resume: true });
  assert.equal(again.status, 'published'); assert.ok(again.reusedWindowCount >= 1);
  const rebuild = wire.take();
  const singles = rebuild.filter(row => row.route === '/v1/kv/get' && pageKey(row));
  // One build opens a few storage contexts (planning, then the build itself); a record both of
  // them need, such as the manifest, is read once per context. Pages are not re-read within one.
  const repeated = singles.length - new Set(singles.map(row => row.key)).size;
  assert.ok(repeated <= Math.ceil(singles.length * 0.1), `an unchanged rebuild re-reads almost no immutable page (${repeated} of ${singles.length})`);
  assert.ok(rebuild.length < build.length / 2, `an unchanged rebuild is far cheaper than the first build (${rebuild.length} vs ${build.length})`);

  const first = await api.executeMemoryGraphUnifiedQuery(QUERY);
  assert.equal(first.corpusRead.mode, 'durable_common_index'); assert.equal(first.modelDispatchEligible, true);
  const cold = wire.take();
  api.releaseMemoryGraphUnifiedQuery?.(first);
  assert.equal(cold.filter(row => row.action === 'assert').length, 0, 'a read lease is confirmed locally');
  const coldPages = cold.filter(row => row.route === '/v1/kv/get' && pageKey(row));
  assert.equal(new Set(coldPages.map(row => row.key)).size, coldPages.length, 'a search fetches no immutable page twice');
  assert.ok(cold.filter(row => /:corpus:root:/.test(row.key)).length <= 8, 'the root is not re-read after every page');

  const second = await api.executeMemoryGraphUnifiedQuery(QUERY);
  const warm = wire.take();
  assert.equal(second.modelDispatchEligible, true);
  assert.deepEqual(Array.from(second.bundle.items, item => item.text), Array.from(first.bundle.items, item => item.text), 'cached pages return the same evidence');
  assert.equal(warm.filter(row => row.route === '/v1/kv/get' && pageKey(row)).length, 0, 'a repeated search reads published pages from the session cache');
  assert.ok(warm.some(row => /:corpus:root:/.test(row.key)), 'the root itself is still read from storage on every search');
  assert.ok(warm.length < cold.length, `warm ${warm.length} < cold ${cold.length}`);
  api.releaseMemoryGraphUnifiedQuery?.(second);

  const status = api.inspectResidentMemoryBudget();
  assert.ok(status.byCache.graphPages > 0 && status.byCache.graphPages <= 16 * 1024 * 1024, 'the search page cache is counted and bounded');
  await api.verifyMemoryGraphCorpus();
  const audit = wire.take();
  assert.ok(audit.some(row => pageKey(row)), 'an audit reads pages from storage, not from the search cache');
  // Warming derived pages must not skip validation of their native sources.
  x.f.chat.message.find(row => row.chatId === 't6-a').data += ' 원문이 바뀌었다.';
  await assert.rejects(() => api.executeMemoryGraphUnifiedQuery({ ...QUERY, corpusMode: 'required' }), /CORPUS_|READER_|READ_/);
  console.log(JSON.stringify({ test: 'libra_memory_graph_read_reuse', build: build.length, rebuild: rebuild.length, cold: cold.length, warm: warm.length }));
});

test('a warm query still reads the mutable root and refuses its replacement', async t => {
  // No IndexedDB in this fixture: plugin_only uses host storage, exercising the
  // same request/session memo path without bypassing the host storage boundary.
  const x = await fixture({ pauseAutomaticAnalysis: true });
  t.after(() => x.cleanup());
  const api = x.f.r.api;
  assert.equal((await api.buildMemoryGraphCorpus()).status, 'published');
  const options = { ...QUERY, corpusMode: 'required' };
  const result = await api.executeMemoryGraphUnifiedQuery(options);
  assert.equal(result.modelDispatchEligible, true);
  api.releaseMemoryGraphUnifiedQuery?.(result);
  assert.ok(api.inspectResidentMemoryBudget().byCache.graphPages > 0);
  const rootKey = [...x.f.r.values.keys()].find(key => key.includes(':memory-graph:v1:corpus:root:'));
  assert.ok(rootKey);
  const root = x.f.r.values.get(rootKey);
  x.f.r.values.set(rootKey, '{}');
  await assert.rejects(() => api.executeMemoryGraphUnifiedQuery(options), /CORPUS_/);
  x.f.r.values.set(rootKey, root);
  const restored = await api.executeMemoryGraphUnifiedQuery(options);
  assert.equal(restored.modelDispatchEligible, true);
  assert.deepEqual(Array.from(restored.bundle.items, item => item.text), Array.from(result.bundle.items, item => item.text));
  api.releaseMemoryGraphUnifiedQuery?.(restored);
});

test('the structure view names every node and joins meaning nodes to their source and subjects', async t => {
  const x = await fixture({ mode: 'plugin_only', microCount: 2, pauseAutomaticAnalysis: true });
  t.after(() => x.cleanup());
  await assert.rejects(() => x.f.r.api.inspectMemoryGraphStructure({ expectedScopeKey: x.scopeKey }), /CORPUS_MISSING_GENERATION/);
  assert.equal((await x.f.r.api.buildMemoryGraphCorpus()).status, 'published');
  const view = await x.f.r.api.inspectMemoryGraphStructure({ expectedScopeKey: x.scopeKey });
  assert.equal(view.publication.source, 'published_durable_corpus');
  assert.ok(view.publication.generation);
  await assert.rejects(() => x.f.r.api.inspectMemoryGraphStructure({ expectedScopeKey: x.scopeKey, expectedGeneration: 'replaced' }), /STRUCTURE_GENERATION_CHANGED/);
  assert.equal(view.schema, 'libra.memory_graph_structure.v1'); assert.equal(view.authority, 'display_only');
  assert.equal(view.summary.nodes, view.nodes.length); assert.equal(view.summary.edges, view.edges.length);
  for (const layer of ['source', 'meaning', 'entity']) assert.ok(view.summary.byLayer[layer] > 0, layer + ' nodes are present');
  const ids = new Set(view.nodes.map(node => node.id));
  assert.equal(ids.size, view.nodes.length, 'display ids stay unique');
  assert.ok(view.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)), 'every edge joins two listed nodes');
  assert.ok(view.nodes.filter(node => node.layer === 'meaning').every(node => node.label && node.family), 'a meaning node carries its text and kind');
  const mina = view.nodes.find(node => node.layer === 'entity' && node.label === '민아');
  assert.ok(mina && mina.kind === 'person', 'an entity node is named from the registry');
  assert.ok(view.edges.some(edge => edge.to === mina.id && edge.predicate === 'subject_of'));
  assert.ok(view.nodes.some(node => node.layer === 'meaning' && node.family === 'micro' && node.turn >= 6));
  assert.equal(JSON.stringify(view).includes('libra.binding.v1'), false, 'no binding identity leaves the display view');
  await assert.rejects(() => x.f.r.api.inspectMemoryGraphStructure({ nodeLimit: 9 }), /STRUCTURE_OPTIONS_INVALID/);
});
