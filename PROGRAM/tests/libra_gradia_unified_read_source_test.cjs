'use strict';
// N03 read source contract: which engine answered a read session, and what happens when it cannot.
//
// Two levels are exercised against real code: the shipped read client (sdk/MemorySuiteStorageClient) and
// GRADIA's server-read consumer. The property under test is that a unified read is never faked — if the
// unified engine cannot answer, the read is refused rather than silently served from the server read, and
// if the answering source is not the one that was asked for, the session is refused too.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { load } = require('./gradia/host.cjs');
const acorn = require('../tools/gradia/load-dev-dependency.cjs')('acorn');

const sdkSource = fs.readFileSync(require.resolve('../sdk/MemorySuiteStorageClient.source.js'), 'utf8');
const scope = { scopeKey: 'scope-one', characterId: 'character-one', chatId: 'chat-one' };
const dataInstanceId = 'A'.repeat(32);
const url = 'http://127.0.0.1:47630';
const results = [];
const test = async (name, run) => { await run(); results.push(name); };

// --- the shipped read client, driven through the SDK's own VM harness -------------------------------
function sdkFixture(options = {}) {
  let calls = 0, writes = 0, current = true; const values = new Map();
  const store = { getItem: async k => values.get(k) ?? null, setItem: async () => { writes++; throw Error('write forbidden'); }, removeItem: async () => { writes++; throw Error('write forbidden'); } };
  const route = { schema: 'memory-suite.scope-routing.v1', namespace: 'libra', version: 1, legacyGlobalModeImported: true, entries: { 'scope-one': { scopeId: 'scope-one', scopeKey: 'scope-one', mode: 'server_only', origin: 'user_explicit', updatedAt: 1 } } };
  const connection = { url, requestedUrl: url, token: 'synthetic-only', dataInstanceId, dataIdentityContract: 'memory-suite.physical-data-identity.v1', dataIdentityCertified: true, resetEpochCertified: true, resetEpochs: {}, capabilities: { 'libra-read-session.v1': true } };
  const packet = { schema: 'memory-suite.libra-read-session.v1', scope, readOnly: true, complete: true,
    items: [{ id: 'memory-one', key: 'libra:v1:scope:scope-one:memory:1', content: 'Full memory', source: { revision: 1, sourceDigest: 'a'.repeat(64), turnRange: { start: 1, end: 5 } } }],
    dependencies: [{ space: 'plugin', key: 'libra:v1:scope:scope-one:manifest', exists: true, tombstone: false, revision: 1, digest: 'a'.repeat(64), valueBytes: 20 }],
    evidenceRevision: 'b'.repeat(64), corpusBytes: 11, maxCorpusBytes: 4194304, dataInstanceId, resetEpoch: 0, readIdentity: { scope, dataInstanceId, resetEpoch: 0 } };
  const host = { pluginStorage: store, getLocalPluginStorage: async () => store, getArgument: async name => (name.includes('url') ? url : undefined),
    nativeFetch: async (u, init) => {
      calls++; assert.ok(u === url + '/v1/libra/read-session/capture' || u === url + '/v1/libra/read-session/current');
      assert.equal(init.headers['X-Memory-Suite-Plugin'], 'serial_gradation_agents_for_rp'); assert.equal(init.method, 'POST');
      const result = u.endsWith('/capture') ? packet : { schema: 'memory-suite.libra-read-session-current.v1', current, scope, evidenceRevision: packet.evidenceRevision, dataInstanceId, resetEpoch: 0 };
      return new Response(JSON.stringify({ ok: true, dataInstanceId, result }), { status: 200 });
    } };
  const box = { connection, route, values };
  const context = vm.createContext({ console, URL, Response, AbortController, TextEncoder, TextDecoder, setTimeout, clearTimeout, RisuAI: host, __fixture: box });
  const instrumented = sdkSource.replace('  const bridge = Object.freeze({', `Object.assign(dataBinding,{url:__fixture.connection.url,dataInstanceId:__fixture.connection.dataInstanceId,dataIdentityContract:__fixture.connection.dataIdentityContract,certified:true,generation:1,rejected:false}); state.config.url=__fixture.connection.url;state.bootstrap={value:__fixture.connection,baseUrl:__fixture.connection.url,at:1,pending:null}; __fixture.values.set(SCOPE_ROUTING_LOCAL_KEY,JSON.stringify(__fixture.route)); __fixture.state=state;__fixture.dataBinding=dataBinding;\n  const bridge = Object.freeze({`);
  vm.runInContext(instrumented + ';globalThis.factory=createMemorySuiteStorageBridge', context);
  const bridge = context.factory({ namespace: 'libra', pluginId: 'serial_gradation_agents_for_rp', managementButton: false, startupDiagnostics: false, ...(options.unifiedReadProvider ? { unifiedReadProvider: options.unifiedReadProvider } : {}) });
  return { bridge, counts: () => ({ calls, writes }), setCurrent: v => { current = v; },
    setMode(mode) { route.entries[scope.scopeKey].mode = mode; values.set('__memory_suite_internal_scope_routes_v1__:libra', JSON.stringify(route)); },
    setResetReview(value) { values.set('memory_suite_reset_choice.v2.libra', JSON.stringify(value)); },
    changeConnection() { connection.dataInstanceId = 'Z'.repeat(32); }
  };
}

function unifiedAnswer(patch = {}) {
  const packet = { schema: 'memory-suite.libra-read-session.v1', scope, readOnly: true, complete: true,
    items: [{ id: 'graph-unit-one', key: 'libra:v1:scope:scope-one:graph:1', content: 'Unified memory', source: { revision: 3, sourceDigest: 'c'.repeat(64), turnRange: { start: 2, end: 6 } } }],
    dependencies: [], evidenceRevision: 'd'.repeat(64), corpusBytes: 14, maxCorpusBytes: 4194304, dataInstanceId, resetEpoch: 0,
    readIdentity: { scope, dataInstanceId, resetEpoch: 0 }, engine: { generation: 'mgm1:5', units: 33 } };
  const merged = { ...packet, ...patch };
  if (patch.items) merged.corpusBytes = patch.items.reduce((total, item) => total + Buffer.byteLength(item.content), 0);
  return merged;
}

function unifiedProvider(options = {}) {
  const counts = { capture: 0, current: 0 };
  const provider = {
    capture: async () => { counts.capture++; return options.answer ? options.answer() : unifiedAnswer(); },
    current: async ({ proof } = {}) => { counts.current++; return { schema: 'memory-suite.libra-read-session-current.v1', current: options.current === undefined ? true : options.current, scope: proof?.scope || scope, evidenceRevision: 'd'.repeat(64), dataInstanceId, resetEpoch: 0 }; }
  };
  return { provider, counts };
}

(async () => {
  await test('N03: the default read source is still the server read, unchanged', async () => {
    const f = sdkFixture();
    try {
      const session = await f.bridge.createLibraReadOnlyClient().openReadSession(scope);
      assert.equal(session.source, 'server_logical_read');
      assert.equal(session.snapshot.items[0].content, 'Full memory');
      assert.equal(await session.assertCurrent(), true);
      assert.equal(f.counts().calls, 2, 'capture and current are served by the server read');
    } finally { await f.bridge.dispose(); }
  });

  await test('N03: asking for the unified engine without one is refused, never served from the server', async () => {
    const f = sdkFixture();
    try {
      await assert.rejects(() => f.bridge.createLibraReadOnlyClient().openReadSession(scope, { source: 'unified_engine' }),
        error => error.code === 'LIB_READ_UNIFIED_UNAVAILABLE');
      assert.equal(f.counts().calls, 0, 'no server read may stand in for the unified engine');
    } finally { await f.bridge.dispose(); }
  });

  await test('N03: an unknown read source is refused by name', async () => {
    const f = sdkFixture();
    try {
      await assert.rejects(() => f.bridge.createLibraReadOnlyClient().openReadSession(scope, { source: 'moon' }),
        error => error.code === 'LIB_READ_SOURCE_UNSUPPORTED');
      assert.equal(f.counts().calls, 0);
    } finally { await f.bridge.dispose(); }
  });

  await test('N03: a unified read is served by the unified engine and never touches the server', async () => {
    const { provider, counts } = unifiedProvider();
    const f = sdkFixture({ unifiedReadProvider: provider });
    try {
      const session = await f.bridge.createLibraReadOnlyClient().openReadSession(scope, { source: 'unified_engine' });
      assert.equal(session.source, 'unified_engine');
      assert.equal(session.snapshot.items[0].content, 'Unified memory');
      assert.equal(session.snapshot.schema, 'memory-suite.libra-read-session.v1', 'the envelope is the same one the consumer validates');
      assert.equal(session.engine.generation, 'mgm1:5');
      assert.equal(await session.assertCurrent(), true);
      assert.equal(counts.capture, 1);
      assert.ok(counts.current >= 1);
      assert.equal(f.counts().calls, 0, 'the server read must not be used at all');
    } finally { await f.bridge.dispose(); }
  });

  await test('N03: a unified answer that breaks the envelope is refused like any other', async () => {
    const cases = [
      ['scope', () => unifiedAnswer({ scope: { ...scope, chatId: 'foreign' } })],
      ['budget', () => ({ ...unifiedAnswer(), corpusBytes: 4194304 + 1 })],
      ['revision', () => ({ ...unifiedAnswer(), evidenceRevision: 'not-a-digest' })]
    ];
    for (const [label, answer] of cases) {
      const { provider } = unifiedProvider({ answer });
      const f = sdkFixture({ unifiedReadProvider: provider });
      try {
        await assert.rejects(() => f.bridge.createLibraReadOnlyClient().openReadSession(scope, { source: 'unified_engine' }),
          error => error.code === 'LIB_READ_RESPONSE_INVALID', 'a ' + label + ' violation must be refused');
      } finally { await f.bridge.dispose(); }
    }
  });

  await test('N03: the unified engine must still be current at dispatch time', async () => {
    const { provider } = unifiedProvider({ current: false });
    const f = sdkFixture({ unifiedReadProvider: provider });
    try {
      const session = await f.bridge.createLibraReadOnlyClient().openReadSession(scope, { source: 'unified_engine' });
      await assert.rejects(() => session.assertCurrent(), error => error.code === 'LIB_READ_STALE');
    } finally { await f.bridge.dispose(); }
  });

  await test('N03 regression: route, reset and connection changes refuse unified currentness before calling the provider', async () => {
    for (const [change, code] of [
      [f => f.setMode('plugin_only'), 'LIB_READ_SERVER_MODE_REQUIRED'],
      [f => f.setResetReview({ choice: 'unreviewed' }), 'LIB_READ_RESET_REVIEW_REQUIRED'],
      [f => f.changeConnection(), 'LIB_READ_SERVER_CONNECTION_REQUIRED']
    ]) {
      const { provider, counts } = unifiedProvider();
      const f = sdkFixture({ unifiedReadProvider: provider });
      try {
        const session = await f.bridge.createLibraReadOnlyClient().openReadSession(scope, { source: 'unified_engine' });
        change(f);
        await assert.rejects(() => session.assertCurrent(), error => error.code === code);
        assert.equal(counts.current, 0, 'a changed boundary must be refused before provider access');
      } finally { await f.bridge.dispose(); }
    }
  });

  await test('N03 regression: a late unified capture cannot cross a storage-mode change', async () => {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const { provider } = unifiedProvider();
    provider.capture = async () => { entered(); return await new Promise(resolve => { release = resolve; }); };
    const f = sdkFixture({ unifiedReadProvider: provider });
    try {
      const pending = f.bridge.createLibraReadOnlyClient().openReadSession(scope, { source: 'unified_engine' });
      const rejected = assert.rejects(pending, error => error.code === 'LIB_READ_SERVER_MODE_REQUIRED');
      await waiting; f.setMode('plugin_only'); release(unifiedAnswer());
      await rejected;
    } finally { await f.bridge.dispose(); }
  });

  await test('N03 regression: a late unified currentness answer cannot cross reset or connection changes', async () => {
    for (const [change, code] of [
      [f => f.setResetReview({ choice: 'unreviewed' }), 'LIB_READ_RESET_REVIEW_REQUIRED'],
      [f => f.changeConnection(), 'LIB_READ_SERVER_CONNECTION_REQUIRED']
    ]) {
      let release, entered;
      const waiting = new Promise(resolve => { entered = resolve; });
      const { provider } = unifiedProvider();
      const current = provider.current;
      provider.current = async input => { entered(); await new Promise(resolve => { release = resolve; }); return await current(input); };
      const f = sdkFixture({ unifiedReadProvider: provider });
      try {
        const session = await f.bridge.createLibraReadOnlyClient().openReadSession(scope, { source: 'unified_engine' });
        const pending = session.assertCurrent();
        const rejected = assert.rejects(pending, error => error.code === code);
        await waiting; change(f); release(); await rejected;
      } finally { await f.bridge.dispose(); }
    }
  });

  // --- GRADIA's server-read consumer ---------------------------------------------------------------
  function captureConsumer(source) {
    const ast = acorn.parse(source, { ecmaVersion: 'latest' }); let target;
    const walk = node => { if (!node || typeof node !== 'object') return;
      if (node.type === 'ArrowFunctionExpression' && source.slice(node.start, node.end).includes('gradia.lib-server-read-consumer.v1') && (!target || node.end - node.start < target.end - target.start)) target = node;
      for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value); } };
    walk(ast); assert.ok(target, 'the server read consumer factory exists');
    return source.slice(0, target.start) + '(globalThis.__testCreateLibReadConsumer=' + source.slice(target.start, target.end) + ')' + source.slice(target.end);
  }

  async function consumerFixture(options = {}) {
    const host = await load({ transformSource: captureConsumer, testGlobals: { crypto: crypto.webcrypto } });
    const items = [{ id: 'm1', key: 'k1', content: 'historical evidence', source: { revision: 1, turnRange: { start: 1, end: 5 } } }];
    const packet = { schema: 'memory-suite.libra-read-session.v1', scope, readOnly: true, complete: true, items, evidenceRevision: 'a'.repeat(64), dependencies: [],
      corpusBytes: items.reduce((n, i) => n + Buffer.byteLength(i.content), 0), maxCorpusBytes: 4194304, dataInstanceId, resetEpoch: 0 };
    let captures = 0; const asked = [];
    const client = { schema: 'memory-suite.libra-read-client.v1', pluginId: 'serial_gradation_agents_for_rp', openReadSession: async (s, o) => {
      captures++; asked.push(o.source === undefined ? null : o.source);
      if (options.onCapture) await options.onCapture(binding);
      return { snapshot: packet, source: options.answerSource, engine: options.engine,
        assertCurrentSync: () => { if (options.onSyncCurrent) options.onSyncCurrent(binding); return true; }, assertCurrent: async () => true }; } };
    const binding = options.unbound ? null : { client, scope, maxCorpusBytes: 4194304, generation: 1, ...(options.readSource === undefined ? {} : { readSource: options.readSource }) };
    const consumer = host.createLibReadConsumer({ getBinding: () => binding, assertNativeScope: options.assertNativeScope || (async () => true), digest: async value => crypto.createHash('sha256').update(value).digest('hex') });
    return { consumer, binding, counts: () => ({ captures }), asked: () => asked };
  }

  await test('N03: the consumer asks for the unified engine and reports which engine answered', async () => {
    const f = await consumerFixture({ readSource: 'unified_engine', answerSource: 'unified_engine', engine: { generation: 'mgm1:5', units: 33 } });
    const session = await f.consumer.beginRead({ requestId: 'r1' });
    assert.equal(session.status, 'ready');
    assert.equal(session.contract, 'existing-server-logical-read.v1', 'the envelope contract the budget and scope gates use stays the same');
    assert.equal(session.readSource, 'unified_engine');
    assert.equal(session.engine.generation, 'mgm1:5');
    assert.equal(session.selection.readSource, 'unified_engine');
    assert.equal(session.selection.promptByteLimit, 96000*4+8192, 'render bytes follow the reference profile, independently of model tokens');
    assert.equal(session.selection.promptCharLimit, 96000);
    assert.equal(session.selection.selectedItems, 1);
    assert.equal(f.asked()[0], 'unified_engine');
    assert.equal((await session.getEvidence()).items[0].content, 'historical evidence');
  });

  await test('N03: a binding that names no source still requires the unified engine', async () => {
    const f = await consumerFixture({ answerSource: 'server_logical_read' });
    await assert.rejects(() => f.consumer.beginRead({ requestId: 'r2' }), error => error.code === 'LIB_READ_SOURCE_MISMATCH');
    const ok = await consumerFixture({ answerSource: 'unified_engine' });
    assert.equal((await ok.consumer.beginRead({ requestId: 'r2b' })).readSource, 'unified_engine');
  });

  await test('N03: a server read cannot pass as the unified engine', async () => {
    const f = await consumerFixture({ readSource: 'unified_engine', answerSource: 'server_logical_read' });
    await assert.rejects(() => f.consumer.beginRead({ requestId: 'r3' }), error => error.code === 'LIB_READ_SOURCE_MISMATCH');
    assert.equal(f.counts().captures, 1, 'a mismatching source is refused, never retried against the other source');
  });

  await test('N03: a source that is not the unified engine is refused before any capture', async () => {
    for (const readSource of ['server_logical_read', 'moon']) {
      const f = await consumerFixture({ readSource, answerSource: 'unified_engine' });
      await assert.rejects(() => f.consumer.beginRead({ requestId: 'r5' }), error => error.code === 'LIB_READ_SOURCE_UNSUPPORTED',
        readSource + ' must not be served by this consumer');
      assert.equal(f.counts().captures, 0, 'the refusal must happen before the provider is asked');
    }
  });

  await test('N03: a legacy source request is migrated at the binding and the effective source is recorded', () => {
    const plugin = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'GRADIA.js'), 'utf8');
    assert.ok(plugin.includes("requestedSource === 'server_logical_read' ? 'unified_engine' : requestedSource"),
      'a retired source selection is migrated rather than served');
    const binding = plugin.slice(plugin.indexOf('libReadBinding = Object.freeze({ client, scope'));
    assert.ok(binding.slice(0, 200).includes('readSource'), 'the binding records the effective source, not the requested one');
    assert.ok(plugin.includes("String(read?.source || 'server_logical_read') !== readSource"),
      'the answered source is still compared with the required one');
  });

  console.log(JSON.stringify({ suite: 'libra_gradia_unified_read_source', passed: results.length, tests: results }));
})().catch(error => { console.error('READ SOURCE CONTRACT FAILED', error.code || '', error.message); process.exit(1); });
