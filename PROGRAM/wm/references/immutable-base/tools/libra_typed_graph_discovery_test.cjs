'use strict';
const assert = require('node:assert/strict');
const { runtime, provider, policy: storagePolicy, flush } = require('./libra_typed_recall_queue_test.cjs');
const { graphKeyFor, assertOnlyTypedGraphWrite } = require('./fixtures/typed-graph-storage-contract.cjs');
const checks = [], QUERY = 'ORBITSEED', MARKER = 'UNRELATED_AMBER_CANARY';
const policy = () => ({ ...storagePolicy, mode: 'fixture', version: 'typed-graph-discovery-v1', laneDepth: 32, maxCorpusUnits: 128,
  rrf: { k: 60 }, packing: { maxItems: 8, maxRefill: 8 },
  calibration: Object.fromEntries(['memory', 'entity', 'world', 'narrative'].map(f => [f, { scale: 1, offset: 0 }])),
  admission: Object.fromEntries(['memory', 'entity', 'world', 'narrative'].map(f => [f, { heuristicMinScore: .001, semanticMinScore: 2, semanticMinMargin: 0 }])),
  diversity: { maxItems: 8, lambda: .8, crossRolePenalty: .2, arcPenalty: 0, maxPerArc: 8, typeCaps: {} } });
async function fixture(family, options = {}) {
  const r = await runtime(null, { admittedHost: true, transformCode: options.removeEdges ? code => {
    return require('./libra_typed_graph_edge_control.cjs').removeTypedGraphEdges(code);
  } : undefined });
  const memory = (id, text, extra = {}) => ({ key: 'lmai_memory::' + id, comment: 'lmai_memory', content: `[META:${JSON.stringify({ t: 4, ttl: -1, imp: 7, ...extra })}]\n${text}` });
  const json = (comment, value) => ({ key: comment + '::fixture', comment, content: JSON.stringify(value) });
  if (family === 'entity') r.chat.localLore = [memory('seed', QUERY, { ent: ['Mira'] }), json('lmai_entity', r.signed({ id: 'target', name: 'Mira', identity: { summary: MARKER }, meta: { created: 2 } }, 'entity', 'target'))];
  if (family === 'world') r.chat.localLore = [json('lmai_world_graph', r.signed({ rootId: 'target', activePath: ['target', 'seed'], nodes: [
    ['target', { id: 'target', name: MARKER, parent: null, rules: {} }], ['seed', { id: 'seed', name: QUERY, parent: 'target', rules: {} }]
  ] }, 'world', 'world_graph'))];
  if (family === 'narrative') r.chat.localLore = [memory('seed', QUERY), json('lmai_narrative', r.signed({ storylines: [
    { id: 'target', name: MARKER, turns: [4], memoryRefs: ['lmai_memory::seed'], evidenceTurns: [4] }
  ] }, 'narrative', 'narrative_state'))];
  if (family === 'memory') r.chat.localLore = [memory('target', MARKER), json('lmai_narrative', r.signed({ storylines: [
    { id: 'seed', name: QUERY, turns: [4], memoryRefs: ['lmai_memory::target'], evidenceTurns: [4] }
  ] }, 'narrative', 'narrative_state'))];
  r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode = options.off ? 'off' : 'balanced';
  r.api.MemoryEngine.CONFIG.hybridMemoryEngineEnabled = true; r.api.MemoryEngine.CONFIG.hybridScopeIndexEnabled = true;
  r.snapshot = r.snap({ viewerId: 'main_request' }); r.all = r.corpus.enumerate(r.snapshot);
  r.target = r.all.find(u => u.family === family && u.locator.id === 'target'); assert(r.target);
  assert.equal(r.corpus.adapters[family].heuristic(QUERY, r.target).evidence.lexicalOverlap, 0);
  r.dual = r.context.__QUEUE_TEST__.dual;
  return r;
}
async function test(name, fn) { try { await fn(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: error.stack }); process.exitCode = 1; } }
if (require.main === module) (async () => {
  for (const family of ['memory', 'entity', 'world', 'narrative']) {
    await test(`${family}: graph-only candidate reaches final RRF/MMR selection`, async () => {
      const r = await fixture(family), result = await r.dual.retrieve(QUERY, r.snapshot, null, policy());
      const selected = result.selection.find(x => x.identity === r.target.identity);
      assert(selected, JSON.stringify(result.trace)); assert(selected.evidence.heuristic.graph);
      assert.equal(selected.ranks.semantic, null); assert.equal(r.state.calls.length, 0);
    });
    for (const mode of ['off', 'removeEdges']) await test(`${family}: ${mode} removes graph-only candidate`, async () => {
      const r = await fixture(family, { [mode]: true }), result = await r.dual.retrieve(QUERY, r.snapshot, null, policy());
      assert(!result.selection.some(x => x.identity === r.target.identity));
    });
    await test(`${family}: explicit hard exclusion wins over graph connectivity`, async () => {
      const r = await fixture(family), p = policy(); p.exclusions = { identities: [r.target.identity] };
      const result = await r.dual.retrieve(QUERY, r.snapshot, null, p);
      assert(!result.selection.some(x => x.identity === r.target.identity));
    });
  }
  for (const kind of ['expired', 'rollback', 'reroll']) await test(`memory: ${kind} cannot re-enter through a graph`, async () => {
    const r = await fixture('memory');
    if (kind === 'expired') r.chat.localLore[0].content = r.chat.localLore[0].content.replace('"ttl":-1', '"ttl":1');
    else {
      const pairs = [1, 2, 3, 4].map(t => ({ pairIndex: t, userText: 'u' + t, assistantText: 'a' + t }));
      if (kind === 'reroll') r.chat.localLore[0] = r.api.LibraTurnWorldline.stampMemoryVariant(r.chat.localLore[0], r.api.LibraTurnWorldline.memoryVariantStamp(r.snapshot.worldlineScopeKey, 4, 'a4'));
      await r.api.LibraTurnWorldline.observe(r.snapshot.worldlineScopeKey, pairs, { now: 1000 });
      const changed = kind === 'rollback' ? pairs.slice(0, 3) : pairs.map(p => p.pairIndex === 4 ? { ...p, assistantText: 'rerolled' } : p);
      await r.api.LibraTurnWorldline.observe(r.snapshot.worldlineScopeKey, changed, { now: 2000 });
    }
    const result = await r.dual.retrieve(QUERY, r.snap(), null, policy());
    assert(!result.selection.some(x => x.identity === r.target.identity));
    if (kind === 'reroll') {
      r.chat.localLore[0] = r.api.LibraTurnWorldline.stampMemoryVariant(r.chat.localLore[0], r.api.LibraTurnWorldline.memoryVariantStamp(r.snapshot.worldlineScopeKey, 4, 'rerolled'));
      assert((await r.dual.retrieve(QUERY, r.snap(), null, policy())).selection.some(x => x.identity === r.target.identity));
    }
  });
  await test('foreign entity signature cannot be recovered through a valid local seed', async () => {
    const r = await fixture('entity'), entry = r.chat.localLore.find(x => x.comment === 'lmai_entity'), value = JSON.parse(entry.content);
    r.api.IntegrityMetaManager.applyIntegrityMeta(value, { domain: 'entity', recordId: 'target', scopeKey: 'foreign-persona', turn: 2 });
    entry.content = JSON.stringify(value);
    const result = await r.dual.retrieve(QUERY, r.snap(), null, policy());
    assert(!result.selection.some(x => x.identity === r.target.identity));
  });
  await test('untrusted graph evidence cannot replace lexical admission', async () => {
    const r = await fixture('entity');
    assert.equal(r.dual.admit({ identity: r.target.identity, lane: 'heuristic', score: 1,
      evidence: { graph: { scopeKey: r.snapshot.scopeKey, corpusRevision: r.snapshot.corpusRevision, edgeChain: ['seed', 'forged'] } } }, r.target, r.snapshot, policy()).ok, false);
  });
  for (const reuse of ['destination', 'query', 'request']) await test(`issued graph evidence is bound to its ${reuse}`, async () => {
    const r = await fixture('entity');
    r.chat.localLore.push({ key: 'lmai_entity::unconnected', comment: 'lmai_entity', content: JSON.stringify(r.signed({ id: 'unconnected', name: 'UnconnectedPerson', meta: { created: 0 } }, 'entity', 'unconnected')) });
    const snapshot = r.snap(), all = r.corpus.enumerate(snapshot), target = all.find(u => u.locator.id === 'target');
    const lane = await r.dual.searchHeuristic(QUERY, all, snapshot, policy()), issued = lane.hits.find(hit => hit.identity === target.identity);
    assert(issued?.evidence.graph);
    assert.equal(r.dual.admit(issued, target, snapshot, policy()).ok, true, 'original issued evidence is valid');
    const destination = reuse === 'destination' ? all.find(u => u.locator.id === 'unconnected') : target;
    const candidate = { ...issued, identity: destination.identity, query: reuse === 'query' ? 'unrelated query' : issued.query };
    assert.equal(r.dual.admit(candidate, destination, reuse === 'request' ? r.snap() : snapshot, policy()).ok, false);
  });
  await test('graph failure preserves the ordinary heuristic lane', async () => {
    const r = await fixture('entity'); r.api.MemoryEngine.searchHmeTypedGraphCandidates = () => { throw new Error('synthetic graph failure'); };
    const result = await r.dual.retrieve(QUERY, r.snapshot, null, policy());
    assert(result.selection.some(x => x.unit.text.includes(QUERY)));
    assert.equal(result.trace.lanes.heuristic.trace.graph.reason, 'graph_unavailable');
  });
  await test('graph discovery respects the configured addition cap and persists only a derived source graph', async () => {
    const r = await fixture('memory'), template = r.chat.localLore[0], narrative = JSON.parse(r.chat.localLore[1].content);
    const memories = Array.from({ length: 12 }, (_, i) => ({ ...template, key: 'lmai_memory::target' + i, content: template.content + ' ' + i }));
    narrative.storylines[0].memoryRefs = memories.map(row => row.key);
    r.chat.localLore = [...memories, { ...r.chat.localLore[1], content: JSON.stringify(r.signed(narrative, 'narrative', 'narrative_state')) }];
    r.api.MemoryEngine.CONFIG.hmeGraphMaxAdditions = 2;
    const snapshot = r.snap(), expectedKey = graphKeyFor(snapshot);
    r.store.set('libra:v1:hme-derived:foreign-scope:typed-graph', 'FOREIGN_TYPED_GRAPH');
    r.store.set(expectedKey.replace(/:typed-graph$/, ':graph'), 'SAME_SCOPE_CLASSIC_GRAPH');
    r.store.set(expectedKey.replace(/:typed-graph$/, ':scope'), 'SAME_SCOPE_DERIVED_INDEX');
    const before = new Map(r.store), result = await r.dual.retrieve(QUERY, snapshot, null, policy());
    const graphOnly = result.trace.fused.filter(row => row.evidence.heuristic?.graph && !row.evidence.heuristic?.lexicalOverlap);
    assert(graphOnly.length > 0); assert(graphOnly.length <= 2, String(graphOnly.length));
    assertOnlyTypedGraphWrite(before, r.store, snapshot, r.corpus.enumerate(snapshot));
  });
  for (const family of ['memory', 'entity', 'world', 'narrative']) await test(`actual registered beforeRequest emits a graph-only ${family} block`, async () => {
    const r = await fixture(family), scopeKey = r.api.LibraDataStorage.scopeKeyFor(r.char, r.chat);
    if (family !== 'world') r.chat.localLore.push({ key: 'lmai_world_graph::registered', comment: 'lmai_world_graph', content: JSON.stringify(require('./fixtures/typed-recall-v1.json').worldGraph) });
    r.store.set(r.api.LibraDataStorage.storageKeyFor(scopeKey), JSON.stringify({ scopeKey, entries: r.chat.localLore }));
    r.chat.message = Array.from({ length: 10 }, (_, i) => [{ role: 'user', data: 'u' + i }, { role: 'assistant', data: 'a' + i }]).flat();
    r.api.MemoryEngine.CONFIG.injectionUnknownHostCapTokens = 8000; r.api.MemoryEngine.CONFIG.injectionBudgetMaxTokens = 16000;
    const rollout = r.context.__QUEUE_TEST__.rollout; rollout.configureFixture(provider(), policy()); rollout.setMode('dual');
    const output = await r.api.libraBeforeRequestReplacer([{ role: 'user', content: QUERY }], 'model'), trace = rollout.inspect().last;
    assert(trace?.consumer?.ok, JSON.stringify(trace));
    assert(trace.consumer.trace.blocks.some(b => b.kind === 'recall' && b.identity === r.target.identity));
    assert(JSON.stringify(output).includes(MARKER));
    assert(trace.retrieval.trace.fused.find(x => x.identity === r.target.identity).evidence.heuristic.graph);
  });
  await test('late typed abort cannot clear a replacement runtime projection digest', async () => {
    const r = await fixture('memory'), scopeKey = r.api.LibraDataStorage.scopeKeyFor(r.char, r.chat);
    r.chat.localLore.push({ key: 'lmai_world_graph::registered', comment: 'lmai_world_graph', content: JSON.stringify(require('./fixtures/typed-recall-v1.json').worldGraph) });
    r.store.set(r.api.LibraDataStorage.storageKeyFor(scopeKey), JSON.stringify({ scopeKey, entries: r.chat.localLore }));
    r.chat.message = Array.from({ length: 10 }, (_, i) => [{ role: 'user', data: 'u' + i }, { role: 'assistant', data: 'a' + i }]).flat();
    const rollout = r.context.__QUEUE_TEST__.rollout; rollout.configureFixture(provider(), policy()); rollout.setMode('dual');
    r.state.blockQuery = true;
    r.host.nativeFetch = async () => new Promise(resolve => r.state.pending.push(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ embeddings: [[1, .25, -.5]] }) })));
    const request = [{ role: 'user', content: QUERY }], pending = r.api.libraBeforeRequestReplacer(request, 'model');
    await flush(); assert.equal(r.state.pending.length, 1);
    r.api.MemoryState.reset(); r.api.MemoryState.libraProjectionDigestByScope.set(r.snapshot.scopeKey, 'replacement-owned');
    r.state.pending.splice(0).forEach(fn => fn()); await pending;
    assert.equal(r.api.MemoryState.libraProjectionDigestByScope.get(r.snapshot.scopeKey), 'replacement-owned');
  });
  console.log(JSON.stringify({ passed: checks.filter(x => x.ok).length, failed: checks.filter(x => !x.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture, policy };
