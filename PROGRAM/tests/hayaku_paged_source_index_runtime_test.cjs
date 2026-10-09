'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { test } = require('node:test');
const { createHayakuRuntime, createStore, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createMemorySuiteServer } = require('../server/server.cjs');
const PREFIX = 'hayaku.v2.recall_index.';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const packet = turn => {
  const body = createValidPacket({ turn });
  body.world.world_rules = [{ id: `rule-${turn}`, summary: `amber lighthouse ${turn}` }];
  return { raw: JSON.stringify(body), hash: `source-${turn}`, messageIndex: 2 * turn - 1, worldlineOrdinal: turn };
};
async function prepare(h, packets, scope, query = 'amber lighthouse') {
  const store = { index: [], context: {} };
  const settings = { ...h.hayaku.settings(), retrievalCurrentQuery: query, hierarchicalEpisodeMemoryEnabled: false };
  const prior = h.context.Date, fixed = Date.now(), started = performance.now();
  h.context.Date = class extends Date { static now() { return fixed; } };
  try {
    const coverage = await h.hayaku._test.localRecallPrepareSources(packets, store, settings, scope, fixed + 10000);
    return { coverage, store, settings, wallMs: Math.round((performance.now() - started) * 100) / 100 };
  } finally { if (prior === undefined) delete h.context.Date; else h.context.Date = prior; }
}
async function indexed(h, packets, scope, query) {
  let result, firstRouting;
  for (let i = 0; i < 100; i++) {
    result = await prepare(h, packets, scope, query);
    firstRouting ??= { ...metrics(result.coverage.routing), wallMs: result.wallMs };
    if (result.coverage.routing.index?.current === true && result.coverage.routing.index?.durable === true) return { ...result, firstRouting };
    await tick();
  }
  assert.fail(`index did not settle: ${JSON.stringify(result.coverage.routing)}`);
}

const metrics = routing => ({ ...routing, index: routing.index ? { ...routing.index, pageKeys: undefined } : undefined });

test('warm product source routing reuses raw tokens and inverted postings', async () => {
  const h = await createHayakuRuntime({ autoRepair: false });
  try {
    const packets = Array.from({ length: 600 }, (_, i) => packet(i + 1));
    const before = JSON.stringify(packets);
    const scope = (await h.hayaku._test.currentChatScope()).key;
    const cold = await prepare(h, packets, scope);
    await indexed(h, packets, scope);
    const warm = await prepare(h, packets, scope);
    // RED on baseline: 929760 raw chars are routed again despite reused terms/builds=0.
    assert.equal(warm.coverage.routing.readChars, 0, 'warm posting lookup must not route all raw characters again');
    assert.equal(warm.coverage.routing.routingPostingBuildTerms, 0, 'warm lookup must reuse the inverted postings');
    const settled = await indexed(h, packets, scope);
    assert.equal(settled.coverage.routing.built, 0);
    assert.equal(settled.coverage.routing.validationSources, 600, 'without a host certificate safe validation is retained');
    assert.ok(settled.coverage.routing.validationChars > 900000);
    assert.ok(settled.coverage.routing.index.pages > 1);
    assert.ok(settled.coverage.routing.index.bytes > 0);
    assert.equal(JSON.stringify(packets), before, 'derived indexing never edits canonical raw');
    console.log(JSON.stringify({ phase: 'cold/warm', cold: { ...metrics(cold.coverage.routing), wallMs: cold.wallMs }, warm: { ...metrics(settled.coverage.routing), wallMs: settled.wallMs } }));

    packets.push(packet(601));
    const added = await indexed(h, packets, scope);
    assert.equal(added.coverage.routing.index.builtSources, 1, 'append tokenizes only the new source');
    const old = JSON.parse(packets[420].raw);
    old.world.world_rules[0].summary = 'violet archive replacement';
    // Keep both declared hash and string length authority untrusted; raw proof must change.
    packets[420].raw = JSON.stringify(old);
    const edited = await indexed(h, packets, scope, 'violet archive replacement');
    assert.equal(edited.coverage.routing.index.builtSources, 1);
    assert.ok(edited.store._recallSourceRows.some(row => row.publicText.includes('violet archive replacement')));
    packets.splice(420, 1);
    const deleted = await indexed(h, packets, scope, 'violet archive replacement');
    assert.ok(deleted.store._recallSourceRows.every(row => !row.publicText.includes('violet archive replacement')));
    const derived = [...h.pluginStorage.values.entries()].filter(([key]) => key.startsWith(PREFIX));
    assert.ok(derived.some(([, value]) => JSON.parse(value).schema === 'hayaku.recall_posting_manifest.v1'));
    const pages = derived.filter(([, value]) => JSON.parse(value).schema === 'hayaku.recall_posting_page.v1');
    assert.ok(pages.length > 1);
    assert.ok(pages.every(([, value]) => Buffer.byteLength(value) <= 65536));
    assert.ok(derived.every(([, value]) => !value.includes('"raw":')), 'persistent pages contain postings/identities, not raw packet copies');
    const shared = h.pluginStorage;
    await h.dispose();
    const restarted = await createHayakuRuntime({ autoRepair: false, pluginStorage: shared });
    try {
      const restored = await indexed(restarted, packets, scope);
      assert.equal(restored.coverage.routing.index.loadedFromStorage, true);
      assert.equal(restored.coverage.routing.index.builtSources, 0);
      assert.equal(restored.coverage.routing.readChars, 0);
      assert.equal(restarted.llmCalls.length, 0);
      console.log(JSON.stringify({ phase: 'add/edit/delete/restart', add: metrics(added.coverage.routing), edit: metrics(edited.coverage.routing), delete: metrics(deleted.coverage.routing), restart: metrics(restored.coverage.routing),
        firstRequests: { add: added.firstRouting, edit: edited.firstRouting, delete: deleted.firstRouting, restart: restored.firstRouting } }));
    } finally { await restarted.dispose(); }
  } finally { await h.dispose(); }
});

test('index write/read failures leave the current raw source recall usable', async () => {
  const store = createStore();
  const originalSet = store.setItem;
  store.setItem = async (key, value) => { if (key.startsWith(PREFIX)) throw Error('derived_write_rejected'); return originalSet(key, value); };
  const h = await createHayakuRuntime({ autoRepair: false, pluginStorage: store });
  try {
    const scope = (await h.hayaku._test.currentChatScope()).key, packets = [packet(1), packet(2)];
    const result = await prepare(h, packets, scope);
    await tick();
    const retry = await prepare(h, packets, scope);
    assert.ok(result.store._recallSourceRows.some(row => row.publicText.includes('amber lighthouse')));
    assert.ok(retry.store._recallSourceRows.some(row => row.publicText.includes('amber lighthouse')));
    assert.notEqual(retry.coverage.routing.index?.durable, true, 'a failed page write never claims durable currentness');
    assert.equal(h.llmCalls.length, 0);
  } finally { await h.dispose(); }
});

test('a corrupted or unreadable stored page cannot certify the current source set after restart', async () => {
  const shared = createStore(), packets = [packet(1), packet(2)];
  const first = await createHayakuRuntime({ autoRepair: false, pluginStorage: shared });
  const scope = (await first.hayaku._test.currentChatScope()).key;
  const ready = await indexed(first, packets, scope);
  const pageKey = ready.coverage.routing.index.pageKeys[0];
  await first.dispose();
  const originalPage = shared.values.get(pageKey), originalGet = shared.getItem;
  for (const mode of ['corrupt', 'reject']) {
    shared.values.set(pageKey, mode === 'corrupt' ? originalPage + ' ' : originalPage);
    shared.getItem = async key => { if (mode === 'reject' && key === pageKey) throw Error('derived_read_rejected'); return originalGet(key); };
    const h = await createHayakuRuntime({ autoRepair: false, pluginStorage: shared });
    try {
      await prepare(h, packets, scope); await tick();
      const fallback = await prepare(h, packets, scope);
      assert.equal(fallback.coverage.routing.index.current, false);
      assert.equal(fallback.coverage.routing.index.durable, false);
      assert.ok(fallback.store._recallSourceRows.some(row => row.publicText.includes('amber lighthouse')));
      assert.equal(h.llmCalls.length, 0);
      console.log(JSON.stringify({ phase: `page ${mode}`, routing: metrics(fallback.coverage.routing) }));
    } finally { await h.dispose(); }
  }
});

test('a late old page write cannot publish a manifest for edited raw or substitute a stale identity', async () => {
  const shared = createStore(), originalSet = shared.setItem;
  let release, entered = false, held = true;
  const gate = new Promise(resolve => { release = resolve; });
  shared.setItem = async (key, value) => { if (held && key.startsWith(PREFIX) && key.includes('::page::')) {
    held = false; entered = true; await gate;
  } return originalSet(key, value); };
  const h = await createHayakuRuntime({ autoRepair: false, pluginStorage: shared });
  try {
    const packets = [packet(1), packet(2)], scope = (await h.hayaku._test.currentChatScope()).key;
    const old = await prepare(h, packets, scope);
    for (let i = 0; i < 100 && !entered; i++) await tick();
    assert.equal(entered, true, 'the actual derived page write reaches the host gate');
    const original = packets[0].raw;
    packets[0].raw = original.replace('amber lighthouse 1', 'cider stonehouse 1');
    assert.equal(packets[0].raw.length, original.length, 'same length cannot certify raw identity');
    const changed = await indexed(h, packets, scope, 'cider stonehouse 1');
    assert.notEqual(changed.coverage.routing.index.sourceDigest, old.coverage.routing.index.sourceDigest);
    assert.ok(changed.store._recallSourceRows.some(row => row.publicText.includes('cider stonehouse')));
    assert.ok(changed.store._recallSourceRows.every(row => !row.publicText.includes('amber lighthouse 1')));
    release(); await tick();
    const now = await prepare(h, packets, scope, 'cider stonehouse 1');
    assert.equal(now.coverage.routing.index.sourceDigest, changed.coverage.routing.index.sourceDigest);
    assert.equal(now.coverage.routing.index.durable, true);
    assert.ok([...shared.values.keys()].every(key => !key.includes('::manifest::' + old.coverage.routing.index.sourceDigest)), 'superseded generation has no published manifest');
    packets[0].sourceScope = 'different-source-owner';
    const identityChanged = await indexed(h, packets, scope, 'cider stonehouse 1');
    assert.notEqual(identityChanged.coverage.routing.index.sourceDigest, changed.coverage.routing.index.sourceDigest);
    assert.equal(identityChanged.coverage.routing.index.builtSources, 1);
    assert.equal(h.llmCalls.length, 0);
    console.log(JSON.stringify({ phase: 'late old write / same length edit / identity', routing: metrics(identityChanged.coverage.routing) }));
  } finally { release(); await h.dispose(); }
});

test('a removed reusable page is read again and repaired before a new generation is certified durable', async () => {
  const shared = createStore(), h = await createHayakuRuntime({ autoRepair: false, pluginStorage: shared });
  try {
    const packets = Array.from({ length: 64 }, (_, i) => packet(i + 1)), scope = (await h.hayaku._test.currentChatScope()).key;
    const initial = await indexed(h, packets, scope);
    const key = initial.coverage.routing.index.pageKeys[0], bytes = shared.values.get(key);
    shared.values.delete(key);
    packets[60].raw = packets[60].raw.replace('amber lighthouse 61', 'cider stonehouse 61');
    const next = await indexed(h, packets, scope, 'cider stonehouse');
    assert.equal(next.coverage.routing.index.builtSources, 1);
    assert.ok(next.coverage.routing.index.pageReads > 0, 'prior verified pages are rechecked before reuse');
    assert.equal(shared.values.get(key), bytes, 'missing prior bytes are repaired before manifest readback');
    const manifest = JSON.parse(shared.values.get(next.coverage.routing.index.manifestKey));
    assert.ok(manifest.pages.every(ref => shared.values.has(ref.key)));
  } finally { await h.dispose(); }
});

test('a backend URL change cancels a held old generation before manifest publication', async () => {
  const shared = createStore(), originalSet = shared.setItem;
  let release, heldKey, entered = false, held = true;
  const gate = new Promise(resolve => { release = resolve; });
  shared.setItem = async (key, value) => {
    if (held && key.startsWith(PREFIX) && key.includes('::page::')) { held = false; heldKey = key; entered = true; await gate; }
    return originalSet(key, value);
  };
  const h = await createHayakuRuntime({ autoRepair: false, pluginStorage: shared });
  try {
    const packets = [packet(1)], scope = (await h.hayaku._test.currentChatScope()).key;
    await prepare(h, packets, scope);
    for (let i = 0; i < 100 && !entered; i++) await tick();
    assert.equal(entered, true);
    const oldKey = heldKey;
    await h.host.setArgument('memory_suite_server_url', 'http://127.0.0.1:13378');
    const changed = await indexed(h, packets, scope);
    assert.ok(!changed.coverage.routing.index.pageKeys.includes(oldKey));
    release(); await tick();
    assert.ok([...shared.values.keys()].filter(key => key.startsWith(PREFIX) && key.includes('::manifest::')).every(key => key === changed.coverage.routing.index.manifestKey));
    assert.equal((await prepare(h, packets, scope)).coverage.routing.index.durable, true);
    assert.equal(h.fetchCalls.length, 0, 'plugin-only URL fencing sends no external request');
  } finally { release(); await h.dispose(); }
});

test('retained derived generations stop at the storage quota while raw recall remains useful', async () => {
  const shared = createStore(), h = await createHayakuRuntime({ autoRepair: false, pluginStorage: shared });
  try {
    const scope = (await h.hayaku._test.currentChatScope()).key, packets = [packet(1)];
    for (let i = 0; i < 32; i++) {
      packets[0].raw = JSON.stringify(createValidPacket({ turn: i + 1, summary: `unique generation ${i}` }));
      await indexed(h, packets, scope, 'unique generation');
    }
    packets[0].raw = JSON.stringify(createValidPacket({ turn: 99, summary: 'quota newest source evidence' }));
    await prepare(h, packets, scope, 'quota newest source evidence'); await tick();
    const fallback = await prepare(h, packets, scope, 'quota newest source evidence');
    assert.equal(fallback.coverage.routing.index.current, false);
    assert.equal(fallback.coverage.routing.index.durable, false);
    assert.equal(fallback.coverage.routing.index.error, 'recall_index_retained_storage_budget');
    assert.equal([...shared.values.keys()].filter(key => key.startsWith(PREFIX) && key.includes('::manifest::')).length, 32);
    assert.ok(fallback.store._recallSourceRows.some(row => row.publicText.includes('quota newest source evidence')));
    console.log(JSON.stringify({ phase: 'retained quota', routing: metrics(fallback.coverage.routing) }));
  } finally { await h.dispose(); }
});

test('normal beforeRequest consumes current posting pages and still renders source evidence', async () => {
  const messages = [];
  for (let turn = 1; turn <= 80; turn++) {
    messages.push({ role: 'user', chatId: `u${turn}`, data: `question ${turn}` });
    messages.push({ role: 'assistant', chatId: `a${turn}`, data: hiddenPacketMessage(`answer ${turn}`, JSON.parse(packet(turn).raw)) });
  }
  const h = await createHayakuRuntime({ autoRepair: false, messages });
  try {
    const input = [{ role: 'user', content: 'amber lighthouse 70' }];
    await h.callBeforeRequest(input, 'model');
    await tick();
    let output;
    for (let i = 0; i < 60; i++) {
      output = await h.callBeforeRequest(input, 'model');
      if (h.hayaku.lastDebug().localRecallSourceIndex?.routing?.index?.current) break;
      await tick();
    }
    const metrics = h.hayaku.lastDebug().localRecallSourceIndex;
    assert.equal(metrics?.routing?.index?.current, true, 'actual registered request route uses the derived pages');
    assert.equal(metrics.routing.readChars, 0);
    assert.ok(JSON.stringify(output).includes('amber lighthouse'), 'actual final injection still uses source records');
    assert.equal(h.llmCalls.length, 0);
    console.log(JSON.stringify({ phase: 'registered beforeRequest', routing: { ...metrics.routing, index: { ...metrics.routing.index, pageKeys: undefined } } }));
  } finally { await h.dispose(); }
});

test('derived index writes and restart reads use the existing plugin/mirror/server-only scope routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-paged-modes-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
  const address = await app.listen(), url = `http://127.0.0.1:${address.port}`;
  try {
    for (const mode of ['plugin_only', 'mirror', 'server_only']) {
      const local = createStore(), calls = [], packets = [packet(1), packet(2)];
      const options = { autoRepair: false, chatId: 'paged-' + mode, pluginStorage: local,
        arguments: { memory_suite_server_mode: mode, memory_suite_server_url: url },
        nativeFetch: async (target, init) => { calls.push({ path: new URL(target).pathname, body: init.body ? JSON.parse(init.body) : null }); return fetch(target, init); } };
      const first = await createHayakuRuntime(options);
      const scope = (await first.hayaku._test.currentChatScope()).key;
      let ready;
      try { ready = await indexed(first, packets, scope); } finally { await first.dispose(); }
      const localKeys = [...local.values.keys()].filter(key => key.startsWith(PREFIX));
      if (mode === 'server_only') assert.equal(localKeys.length, 0, 'server-only derived pages never go to pluginStorage');
      else assert.ok(localKeys.length > 0, 'plugin/mirror keep their routed local copies');
      if (mode !== 'plugin_only') assert.ok(calls.some(call => call.path === '/v1/kv/set' && call.body?.key?.startsWith(PREFIX)), 'the actual scoped storage route writes index pages on the local fixture server');
      const restarted = await createHayakuRuntime(options);
      try {
        const restored = await indexed(restarted, packets, scope);
        assert.equal(restored.coverage.routing.index.loadedFromStorage, true);
        assert.equal(restored.coverage.routing.index.builtSources, 0);
        assert.equal(restored.coverage.routing.index.sourceDigest, ready.coverage.routing.index.sourceDigest);
        assert.equal(restarted.llmCalls.length, 0);
        console.log(JSON.stringify({ phase: 'storage mode restart', mode, localIndexKeys: localKeys.length, routing: metrics(restored.coverage.routing) }));
      } finally { await restarted.dispose(); }
    }
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
