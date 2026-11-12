'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { fixture, QUOTE } = require('./fixtures/libra_direct_memory_reader_fixture.cjs');
const createReader = require('../tools/libra_gradia_unified_read.cjs');
const createBus = require('./fixtures/libra_gradia_read_bus.cjs');
const options = { queryInput: { queryText: '은빛 열쇠' }, consumerPolicy: { maxCharacters: 8000, maxUnits: 24 } };

test('source-bound Micro remains source_only and pending State reasons reach diagnostics', async () => {
  const engine=require('../tools/libra_state_memory_engine.cjs')({fingerprint:value=>value}),store=new Map();
  const frame={head:{throughTurn:1,microProjection:{pendingClaims:[{turn:1,reason:'analysis_pending'}]}},
    refs:[],turns:[1],settings:{},identity:'snapshot',owner:'libra',scope:{scopeKey:'scope'},worldlineId:'main',stateKey:'state',
    stateAuthority:{current:false,pending:true},check(){},
    async micro(){return {key:'micro',proofs:[],rows:[{id:'raw',family:'micro',axis:'world',turn:1,sourceKey:'micro',
      text:'도서관 규칙',analysisStatus:'minimum_source_bound'}]};},
    register(){return 'token';},async assertCurrent(){},release(){} };
  const runtime=require('../tools/libra_state_memory_runtime.cjs')({engine,capture:async()=>frame,fingerprint:value=>value,authorityStore:store});
  const result=await runtime.query({queryText:'도서관 규칙'});
  assert.equal(result.bundle.items[0].semanticRole,'source_only');
  assert.equal(store.get(result).displayRows[0].semanticRole,'source_only');
  assert.deepEqual(result.diagnostics.families.state.reasons,['analysis_pending']);
  assert.equal(result.diagnostics.stateAuthority.pending,true);
  runtime.release(result);
});

test('real lens records participate in direct recall and Classic delivery without a second append', async t => {
  const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
  const f = await lensFixture(); t.after(() => f.close());
  f.setReply({ items: [{ label: '관점', text: '민아는 은빛 열쇠의 반환을 유난히 신경 썼다.', refs: ['t2-a'], basis: '반환 약속에 대한 관찰' }] });
  await f.add('열쇠 관점');
  const result = await f.api.executeStateMemoryQuery(options);
  assert.ok(result.bundle.items.some(row => row.family === 'lens' && row.semanticRole === 'perspective_note'));
  assert.equal(result.diagnostics.familyAllocation.lens.weight, 40);
  // Lens notes sit in their own section below the present and the records, marked as interpretations.
  const rendered = result.packet.renderedText;
  assert.match(rendered, /\n\[PERSPECTIVE NOTES · lens interpretations — below CURRENT STATE and the records\]\n- .*민아는 은빛 열쇠의 반환을 유난히 신경 썼다\./);
  assert.ok(rendered.indexOf('[CURRENT STATE') < rendered.indexOf('[PERSPECTIVE NOTES'));
  assert.equal(rendered.split('PERSPECTIVE NOTES').length - 1, 1, 'the lens marker is a section heading, not a per-line prefix');
  const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠의 반환' }], 'model');
  const injected = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.equal(injected.split('민아는 은빛 열쇠의 반환을 유난히 신경 썼다.').length - 1, 1);
  assert.equal(f.api.getRuntime().lastMemoryInjectionMeta.lensInjectedCount, 1);
});

test('a lens-only selection is deliverable and its final proof rejects a changed lens source', async () => {
  const engine = require('../tools/libra_state_memory_engine.cjs')({ fingerprint: value => value });
  const store = new Map(); let changed = false, released = false;
  const frame = { head: null, refs: [], turns: [], settings: {}, identity: 'id', owner: 'libra', scope: { scopeKey: 's' },
    worldlineId: 'main', stateKey: 'state', check() {},
    async lens() { return { key: 'lens', proofs: [], delivery: {}, rows: [{ id: 'note', family: 'lens', axis: 'world',
      text: '은빛 열쇠의 비밀', sourceKey: 'lens', lensItem: { itemId: 'n' } }],
      async assertCurrent() { if (changed) throw Error('LIBRA_LENS_SOURCE_CHANGED'); } }; },
    register() { return 'token'; }, async assertCurrent() {}, release() { released = true; } };
  const runtime = require('../tools/libra_state_memory_runtime.cjs')({ engine, capture: async () => frame,
    fingerprint: value => value, authorityStore: store });
  const result = await runtime.query({ queryText: '열쇠' });
  assert.equal(result.modelDispatchEligible, true);
  assert.equal(result.bundle.items[0].family, 'lens');
  changed = true;
  await assert.rejects(() => store.get(result).validatePacket(result.packet), /LENS_SOURCE_CHANGED/);
  runtime.release(result); assert.equal(released, true);
});
for (const mode of ['plugin_only', 'server_only', 'mirror']) test(`${mode}: existing State, Canonical and Micro serve without graph storage or provider calls`, async t => {
  const x = await fixture({ mode, pauseAutomaticAnalysis: true });t.after(() => x.cleanup());
  const api = x.f.r.api, calls = x.f.control.calls.length, wire = [];
  if (x.server) x.server.hooks.beforeServerRequest = async (url, init) => wire.push({ url, method: init?.method });
  const result = await api.executeStateMemoryQuery(options);
  assert.equal(result.engine, 'state_first'); assert.equal(result.corpusRead.graphBuilds, 0);
  assert.equal(result.corpusRead.mode, 'direct_existing_records');
  for (const axis of ['characters','relationships','world','narrative']) assert.ok(result.diagnostics.axes[axis].selected > 0, axis);
  assert.ok(result.bundle.items.some(item => item.family === 'micro' && item.text === QUOTE));
  assert.ok(result.bundle.items.some(item => item.family === 'canonical'));
  assert.equal(x.f.control.calls.length, calls);
  assert.equal(wire.some(row => /graph-lifecycle|memory-graph/.test(decodeURIComponent(row.url))), false);
  assert.equal(wire.some(row => /\/v1\/kv\/(batch|set|remove)$/.test(row.url)), false, 'retrieval never publishes a derived corpus');
  assert.equal(api.buildMemoryGraphCorpus, undefined);
  const output = await x.f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠는 누가 보관해?' }], 'model');
  assert.ok(output.length > 1); assert.equal(api.getRuntime().lastMemoryInjectionMeta.servedEngine, 'state_first');
  assert.equal(api.getRuntime().lastMemoryInjectionMeta.finalVerification.status, 'verified');
  const viewer=api.getLastMemoryRecallViewer();
  assert.equal(viewer.finalVerification.modelDispatchEligible,true);
  assert.equal(api.getRuntime().lastMemoryInjectionMeta.responseContextRequestId,viewer.responseContextRequestId);
  assert.ok(viewer.microFrontier.lastKnownTurn > 0, 'family-based Micro rows expose their frontier');
  assert.equal(viewer.sourceTurnAccounting.emittedUnits, viewer.rows.length);
  assert.equal(viewer.sourceTurnAccounting.completeUniqueOriginalTurns, null, 'ordinals cannot prove original identities');
  assert.ok(viewer.sourceTurnAccounting.lanes.some(lane => lane.lane === 'micro'));
  assert.ok(Number.isFinite(viewer.recallDiagnostics.timings.snapshotMs));
  assert.ok(Number.isFinite(viewer.recallDiagnostics.timings.verificationMs));
  assert.equal(viewer.recallDiagnostics.familyAllocation.lens.weight,40);
});
test('GRADIA owner receipts bind direct selections and reject a changed native Micro source', async t => {
  const bus = createBus(), x = await fixture({ mode: 'server_only', pauseAutomaticAnalysis: true, hostOverrides: bus.api('libra') });
  const client = createReader({ role: 'client', api: bus.api('serial_gradation_agents_for_rp'), timeoutMs: 15000, randomId: () => Math.random().toString(36).slice(2) });
  t.after(async () => { await client.dispose(); await x.cleanup(); });
  const boot = await x.server.send('GET', '/bootstrap');
  const captured = await client.capture({ operationId: 'state_recall_test', queryText: '은빛 열쇠 준호', maxCorpusBytes: 32768,
    binding: { url: x.server.url, dataInstanceId: boot.dataInstanceId, resetEpoch: boot.resetEpochs?.libra || 0 },
    scope: { scopeKey: x.scopeKey, characterId: x.f.character.id, chatId: x.f.chat.id } });
  assert.ok(captured.items[0].content.includes('은빛 열쇠'));
  assert.equal(captured.engine.servingEngine, 'state_first');
  const proof = { scope: captured.scope, readIdentity: captured.readIdentity, dependencies: captured.dependencies,
    evidenceRevision: captured.evidenceRevision, dataInstanceId: captured.dataInstanceId, resetEpoch: captured.resetEpoch };
  assert.equal((await client.current({ proof })).current, true);
  x.f.chat.message.find(row => row.chatId === 't6-a').data += ' 원문 변경';
  await assert.rejects(() => client.current({ proof }), /CONSUMER|STALE|STATE_SOURCE_CHANGED/);
});

test('17 turns query directly with bounded candidates and no construction phase', async t => {
  const x = await fixture({ mode: 'server_only', pauseAutomaticAnalysis: true, microCount: 12,
    microText: turn => `민아는 은빛 열쇠 기록${turn}을 준호에게 남겼다.` });
  t.after(() => x.cleanup());
  let requests = 0, writes = 0;
  x.server.hooks.beforeServerRequest = async (url, init) => {
    requests++;
    assert.equal(url.includes('/graph-lifecycle'), false);
    if (init?.method === 'POST' && /\/v1\/kv\/(batch|set|remove)$/.test(url)) writes++;
  };
  const start = Date.now(), calls = x.f.control.calls.length;
  const result = await x.f.r.api.executeStateMemoryQuery({ ...options, queryInput: { queryText: '기록17 은빛 열쇠' } });
  const elapsedMs = Date.now() - start;
  assert.ok(result.bundle.items.some(row => row.family === 'micro' && row.turn === 17));
  assert.ok(result.diagnostics.candidates.micro <= 12);
  assert.ok(result.diagnostics.candidates.canonical <= 16);
  assert.equal(result.queryComplete, false, 'a bounded candidate set never claims a full-history search');
  assert.equal(result.corpusRead.graphBuilds, 0); assert.equal(writes, 0);
  assert.equal(x.f.control.calls.length, calls);
  assert.ok(result.diagnostics.headFreshness);
  assert.ok(result.bundle.pointInTime);
  if (result.diagnostics.turnLag > 0) {
    assert.equal(result.diagnostics.headFreshness, 'lagging');
    assert.ok(result.diagnostics.pointInTimeNotice.includes('State includes verified projections through turn'));
  }
  console.log(JSON.stringify({ test: 'state_first_17_turns', elapsedMs, requests, writes, axes: result.diagnostics.axes }));
});

test('a fresh plugin reads existing persisted records after restart without rebuilding anything', async t => {
  const { fixture: baseFixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const first = await baseFixture(); let second = null;
  t.after(async () => { await second?.r.cleanup(); await first.r.cleanup(); });
  await first.run();
  const before = await first.r.api.executeStateMemoryQuery(options);
  const snapshot = { chat: JSON.parse(JSON.stringify(first.chat)), values: [...first.r.values.entries()] };
  await first.r.cleanup(); second = await baseFixture({ snapshot });
  const after = await second.r.api.executeStateMemoryQuery(options);
  assert.deepEqual(Array.from(after.bundle.items, item => item.text), Array.from(before.bundle.items, item => item.text));
  assert.equal(second.control.calls.length, 0);
  assert.equal(after.corpusRead.graphBuilds, 0);
});

test('Lore is never read or delivered, even when a caller asks to include it', async () => {
  const createEngine = require('../tools/libra_state_memory_engine.cjs');
  const createCapture = require('../tools/libra_state_memory_capture.cjs');
  const createRuntime = require('../tools/libra_state_memory_runtime.cjs');
  const crypto = require('node:crypto');
  const fingerprint = val => crypto.createHash('sha256').update(val).digest('hex');
  const engine = createEngine({ fingerprint });
  const authorityStore = new Map();

  const native = {
    fingerprint: val => fingerprint(JSON.stringify(val)),
    async context() { return { scope: { scopeKey: 'test_scope' } }; },
    check() {},
    async snapshot() {
      return {
        manifest: { memories: {} },
        head: { throughTurn: 1, characters: [{ id: 'c1', name: '민아', state: { status: '탐색' } }] },
        refs: [],
        turns: [1],
        worldlineId: 'main',
        identity: 'test_id',
        owner: 'libra:test',
        stateKey: 'state_key',
        settings: { recallMaxChars: 4000, stateMaxItems: 10, stateMinimumPerAxis: 1 }
      };
    },
    async canonical() { return { rows: [], proofs: [] }; },
    async micro() { return null; },
    async lore() {
      assert.fail('LIBRA must not read Lore for direct delivery');
    },
    register() { return 'token_1'; },
    async assertCurrent() {},
    release() {}
  };

  const capture = createCapture(native, engine);
  const runtime = createRuntime({ engine, capture, fingerprint, authorityStore });

  const res = await runtime.query({ includeLore: true, queryInput: { queryText: '고대 왕국의 비밀 열쇠' } });
  assert.equal(res.engine, 'state_first');
  assert.equal(res.bundle.items.some(item => item.family === 'lore'), false);
  assert.equal(res.diagnostics.families.lore.units, 0);
  assert.equal(res.packet.renderedText.includes('고대 왕국의 비밀 열쇠'), false);
  assert.equal(res.diagnostics.headFreshness, 'current');
});

test('server mode: one query stays within a few dozen requests and an old matching Micro is found without a rebuild', async t => {
  const x = await fixture({ mode: 'server_only', pauseAutomaticAnalysis: true, microCount: 12,
    microText: turn => `민아는 은빛 열쇠 기록${turn}을 준호에게 남겼다.` });
  t.after(() => x.cleanup());
  let requests = 0, writes = 0;
  x.server.hooks.beforeServerRequest = async (url, init) => {
    requests++; if (init?.method === 'POST' && /\/v1\/kv\/(batch|set|remove)$/.test(url)) writes++;
  };
  const ask = queryText => x.f.r.api.executeStateMemoryQuery({ ...options, queryInput: { queryText } });
  const first = await ask('기록9 은빛 열쇠'), cold = requests;
  // The newest turns alone would be 17..10; turn 9 is read because its stored search text matches.
  assert.equal(first.diagnostics.candidates.microReasons[9], 'index_match');
  assert.ok(first.bundle.items.some(row => row.family === 'micro' && row.turn === 9));
  assert.equal(first.diagnostics.candidates.microIndexKnown, first.diagnostics.candidates.microTotal);
  assert.ok(cold <= 40, 'cold query requests: ' + cold);
  requests = 0;
  const second = await ask('기록7 은빛 열쇠'), warm = requests;
  assert.ok(second.bundle.items.some(row => row.family === 'micro' && row.turn === 7));
  assert.ok(warm <= cold, `a following query reuses verified reads (${warm} <= ${cold})`);
  assert.equal(writes, 0, 'the search text is read from existing Micro heads; nothing is published');
  console.log(JSON.stringify({ test: 'state_first_request_bound', cold, warm }));
});

test('a shared read frame is settled once, re-proved without sharing when it saw a change, and abandoned on failure', async () => {
  const engine = require('../tools/libra_state_memory_engine.cjs')({ fingerprint: value => value });
  const make = ({ settle, failProof = false }) => {
    const log = [];
    const frame = { head: { throughTurn: 1, world: [{ id: 'w', name: '열쇠', state: { place: '서랍' } }] }, refs: [], turns: [], settings: {},
      identity: 'id', owner: 'libra', scope: { scopeKey: 's' }, worldlineId: 'main', stateKey: 'state', check() {},
      register() { return 'token'; }, release() { log.push('release'); },
      async assertCurrent() { log.push('proof'); if (failProof) throw Error('LIBRA_STATE_SOURCE_CHANGED'); },
      async settle() { log.push('settle'); return settle(); }, abandon() { log.push('abandon'); } };
    const runtime = require('../tools/libra_state_memory_runtime.cjs')({ engine, capture: async () => frame,
      fingerprint: value => value, authorityStore: new Map() });
    return { log, run: () => runtime.query({ queryText: '열쇠' }) };
  };
  const clean = make({ settle: () => true }); await clean.run();
  assert.deepEqual(clean.log, ['proof', 'settle']);
  const changed = make({ settle: () => false }); await changed.run();
  assert.deepEqual(changed.log, ['proof', 'settle', 'proof'], 'the unshared proof decides after the frame saw a change');
  const broken = make({ settle: () => { throw Error('STORAGE_DOWN'); } });
  await assert.rejects(broken.run, /STORAGE_DOWN/);
  assert.deepEqual(broken.log, ['proof', 'settle', 'release', 'abandon']);
  const stale = make({ settle: () => true, failProof: true });
  await assert.rejects(stale.run, /STATE_SOURCE_CHANGED/);
  assert.deepEqual(stale.log, ['proof', 'release', 'abandon'], 'a failed proof never reaches the caller and leaves no open frame');
});

test('server mode: an unrelated rewrite during the query does not refuse it, and an edited source is read again', async t => {
  const x = await fixture({ mode: 'server_only', pauseAutomaticAnalysis: true });
  t.after(() => x.cleanup());
  const manifestKey = `libra:v1:scope:${x.scopeKey}:manifest`;
  const stored = JSON.parse((await x.server.send('GET', '/v1/kv/get?namespace=libra&space=plugin&key=' + encodeURIComponent(manifestKey))).result.value);
  let seen = 0, rewritten = false;
  x.server.hooks.beforeServerRequest = async () => {
    // Same bytes, new server revision: the shared frame sees a change, the content proof does not.
    if (++seen === 6 && !rewritten) { rewritten = true; x.server.hooks.beforeServerRequest = null; await x.server.mutate(manifestKey, stored); }
  };
  const result = await x.f.r.api.executeStateMemoryQuery(options);
  assert.equal(rewritten, true);
  assert.ok(result.bundle.items.length > 0, 'an identical rewrite is not a source change');
  assert.equal(result.diagnostics.readFrame, 'reproved', 'the frame saw the rewrite and the unshared proof decided');
  const quiet = await x.f.r.api.executeStateMemoryQuery(options);
  assert.equal(quiet.diagnostics.readFrame, 'shared');
  x.f.chat.message.find(row => row.chatId === 't6-a').data += ' 원문 변경';
  const after = await x.f.r.api.executeStateMemoryQuery(options);
  assert.notEqual(after.generation, result.generation, 'an edited source turn is read again, never served from shared bytes');
});

test('server mode: a request after the read cache expired stays batched instead of reading five records per turn', async t => {
  const x = await fixture({ mode: 'server_only', pauseAutomaticAnalysis: true, microCount: 24,
    microText: turn => `민아는 은빛 열쇠 기록${turn}을 준호에게 남겼다.` });
  t.after(() => x.cleanup());
  const ask = () => x.f.control.hooks.beforeRequest([{ role: 'user', content: '기록9 은빛 열쇠는 누가 보관해?' }], 'model');
  await ask();
  // Resident verified reads live 20 s; a real next turn arrives later than that.
  await new Promise(resolve => setTimeout(resolve, 21000));
  let requests = 0, single = 0, wholeNamespaceListings = 0;
  x.server.hooks.beforeServerRequest = async (url, init) => {
    requests++;
    if (/\/v1\/kv\/get\?/.test(url) && /micro-memory|micro-work|source-receipt/.test(decodeURIComponent(url))) single++;
    if (/\/v1\/kv\/keys\?/.test(url) && /[?&]prefix=(&|$)/.test(url)) wholeNamespaceListings++;
    if (init?.method === 'POST' && /\/v1\/kv\/get-many$/.test(url)) assert.ok(JSON.parse(init.body).keys.length <= 512);
  };
  const output = await ask();
  x.server.hooks.beforeServerRequest = null;
  assert.ok(output.length > 1);
  assert.equal(x.f.r.api.getRuntime().lastMemoryInjectionMeta.finalVerification.status, 'verified');
  assert.equal(x.f.r.core.state.lastRecall.unifiedExecution.diagnostics.readFrame, 'deferred');
  assert.equal(wholeNamespaceListings, 0, 'State projection lists only its own Micro heads and admissions');
  assert.ok(single <= 6, 'per-turn records are fetched in batches: ' + single + ' single reads');
  assert.ok(requests <= 60, 'cold request total: ' + requests);
  console.log(JSON.stringify({ test: 'state_first_cold_request', requests, single }));
});
