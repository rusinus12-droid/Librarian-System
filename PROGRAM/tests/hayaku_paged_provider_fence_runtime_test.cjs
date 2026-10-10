'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHayakuRuntime, createStore, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const PREFIX = 'hayaku.v2.recall_index.';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const packet = () => ({ raw: JSON.stringify(createValidPacket({ summary: 'amber lighthouse current evidence' })), hash: 'provider-proof-source', messageIndex: 1 });
async function prepare(h, packets, scope) {
  const store = { index: [], context: {} };
  const coverage = await h.hayaku._test.localRecallPrepareSources(packets, store,
    { ...h.hayaku.settings(), retrievalCurrentQuery: 'amber lighthouse', hierarchicalEpisodeMemoryEnabled: false }, scope, Date.now() + 10000);
  return { coverage, store };
}
async function indexed(h, packets, scope) {
  let result;
  for (let i = 0; i < 100; i++) {
    result = await prepare(h, packets, scope);
    if (result.coverage.routing.index?.current && result.coverage.routing.index?.durable) return result;
    await tick();
  }
  assert.fail('index did not settle: ' + JSON.stringify(result.coverage.routing.index));
}
const containsEvidence = result => result.store._recallSourceRows.some(row => row.publicText.includes('amber lighthouse current evidence'));

test('actual provider replacement invalidates old durable proof before current-provider readback; replacement survives fresh VM', async () => {
  const original = createStore(), h = await createHayakuRuntime({ autoRepair: false, pluginStorage: original });
  try {
    const packets = [packet()], scope = (await h.hayaku._test.currentChatScope()).key;
    const positive = await indexed(h, packets, scope), key = positive.coverage.routing.index.manifestKey;
    assert.equal(typeof original.values.get(key), 'string');
    const originalDerived = [...original.values].filter(([key]) => key.startsWith(PREFIX));
    const replacement = createStore(); h.host.pluginStorage = replacement;
    assert.equal(await replacement.getItem(key), null);
    const first = await prepare(h, packets, scope);
    assert.equal(containsEvidence(first), true);
    assert.equal(first.coverage.routing.index.durable, false, 'empty actual current provider has no accepted readback yet');
    assert.equal(first.coverage.routing.index.current, false, 'old-provider ready proof is invalidated');
    const adopted = await indexed(h, packets, scope);
    assert.equal(typeof replacement.values.get(adopted.coverage.routing.index.manifestKey), 'string');
    assert.equal(adopted.coverage.routing.index.loadedFromStorage, false);
    assert.deepEqual([...original.values].filter(([key]) => key.startsWith(PREFIX)), originalDerived, 'old derived pages are preserved');
    await h.dispose();
    const fresh = await createHayakuRuntime({ autoRepair: false, pluginStorage: replacement });
    try {
      const restored = await indexed(fresh, packets, scope);
      assert.equal(restored.coverage.routing.index.loadedFromStorage, true);
      assert.equal(restored.coverage.routing.index.builtSources, 0);
      assert.equal(containsEvidence(restored), true);
      assert.equal(fresh.llmCalls.length, 0); assert.equal(fresh.fetchCalls.length, 0);
    } finally { await fresh.dispose(); }
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
    console.log(JSON.stringify({ phase: 'provider replacement and fresh VM', first: first.coverage.routing.index, adopted: adopted.coverage.routing.index }));
  } finally { await h.dispose(); }
});

test('registered beforeRequest keeps raw evidence and never labels old-provider proof durable on an empty replacement', async () => {
  const original = createStore(), body = JSON.parse(packet().raw);
  const h = await createHayakuRuntime({ autoRepair: false, pluginStorage: original,
    messages: [{ role: 'user', chatId: 'u1', data: 'Find amber lighthouse' },
      { role: 'assistant', chatId: 'a1', data: hiddenPacketMessage('amber lighthouse answer', body) }] });
  try {
    const input = [{ role: 'user', content: 'amber lighthouse' }];
    let output, positive;
    for (let i = 0; i < 100; i++) {
      output = await h.callBeforeRequest(input, 'model');
      positive = h.hayaku.lastDebug().localRecallSourceIndex?.routing?.index;
      if (positive?.current && positive?.durable) break;
      await tick();
    }
    assert.equal(positive?.durable, true); assert.equal(typeof original.values.get(positive.manifestKey), 'string');
    const replacement = createStore(); h.host.pluginStorage = replacement;
    assert.equal(await replacement.getItem(positive.manifestKey), null);
    output = await h.callBeforeRequest(input, 'model');
    const changed = h.hayaku.lastDebug().localRecallSourceIndex.routing.index;
    assert.equal(changed.durable, false, 'actual registered consumer cannot retain old provider durable=true');
    assert.equal(changed.current, false);
    assert.ok(JSON.stringify(output).includes('amber lighthouse current evidence'));
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
    console.log(JSON.stringify({ phase: 'registered consumer provider replacement', index: changed, renderedSource: true }));
  } finally { await h.dispose(); }
});

test('provider change during a held page write rejects old-provider manifest publication and current-provider adoption', async () => {
  const original = createStore(), originalSet = original.setItem;
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  original.setItem = async (key, value) => { if (!entered && key.startsWith(PREFIX) && key.includes('::page::')) { entered = true; await gate; } return originalSet(key, value); };
  const h = await createHayakuRuntime({ autoRepair: false, pluginStorage: original });
  try {
    const packets = [packet()], scope = (await h.hayaku._test.currentChatScope()).key;
    await prepare(h, packets, scope);
    for (let i = 0; i < 100 && !entered; i++) await tick();
    assert.equal(entered, true);
    const replacement = createStore(); h.host.pluginStorage = replacement;
    release(); await tick(); await tick();
    assert.equal([...original.values.keys()].filter(key => key.startsWith(PREFIX) && key.includes('::manifest::')).length, 0, 'old completion cannot publish a manifest after provider replacement without an intervening request');
    assert.equal([...replacement.values.keys()].filter(key => key.startsWith(PREFIX)).length, 0, 'old work is not adopted into a different actual provider');
    const first = await prepare(h, packets, scope);
    assert.equal(first.coverage.routing.index.durable, false); assert.equal(containsEvidence(first), true);
    const ready = await indexed(h, packets, scope);
    assert.equal(typeof replacement.values.get(ready.coverage.routing.index.manifestKey), 'string');
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
  } finally { release(); await h.dispose(); }
});

test('unavailable replacement cannot preserve durable/current status or block raw recall', async () => {
  const original = createStore(), h = await createHayakuRuntime({ autoRepair: false, pluginStorage: original });
  try {
    const packets = [packet()], scope = (await h.hayaku._test.currentChatScope()).key;
    await indexed(h, packets, scope);
    const rejected = createStore(); rejected.getItem = async () => { throw Error('current provider read rejected'); };
    rejected.setItem = async () => { throw Error('current provider write rejected'); };
    h.host.pluginStorage = rejected;
    const first = await prepare(h, packets, scope); await tick();
    const fallback = await prepare(h, packets, scope);
    assert.equal(first.coverage.routing.index.durable, false);
    assert.equal(fallback.coverage.routing.index.durable, false);
    assert.equal(fallback.coverage.routing.index.current, false);
    assert.equal(containsEvidence(first), true); assert.equal(containsEvidence(fallback), true);
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
  } finally { await h.dispose(); }
});

test('provider change during restart manifest read rejects bytes from the old provider before RAM adoption', async () => {
  const original = createStore(), first = await createHayakuRuntime({ autoRepair: false, pluginStorage: original });
  const packets = [packet()], scope = (await first.hayaku._test.currentChatScope()).key;
  const positive = await indexed(first, packets, scope);
  await first.dispose();
  const originalGet = original.getItem;
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  original.getItem = async key => { const value = await originalGet(key);
    if (!entered && key === positive.coverage.routing.index.manifestKey) { entered = true; await gate; }
    return value;
  };
  const h = await createHayakuRuntime({ autoRepair: false, pluginStorage: original });
  try {
    await prepare(h, packets, scope);
    for (let i = 0; i < 100 && !entered; i++) await tick();
    assert.equal(entered, true);
    const replacement = createStore(); h.host.pluginStorage = replacement;
    release(); await tick(); await tick();
    assert.equal([...replacement.values.keys()].filter(key => key.startsWith(PREFIX)).length, 0);
    const changed = await prepare(h, packets, scope);
    assert.equal(changed.coverage.routing.index.current, false); assert.equal(changed.coverage.routing.index.durable, false);
    assert.equal(containsEvidence(changed), true);
    const ready = await indexed(h, packets, scope);
    assert.equal(ready.coverage.routing.index.loadedFromStorage, false, 'old-provider manifest/page bytes cannot be accepted as a replacement-provider restore');
    assert.equal(typeof replacement.values.get(ready.coverage.routing.index.manifestKey), 'string');
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
  } finally { release(); await h.dispose(); }
});

test('provider change during manifest write rejects late durable acknowledgement on the current provider', async () => {
  const original = createStore(), originalSet = original.setItem;
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  original.setItem = async (key, value) => {
    if (!entered && key.startsWith(PREFIX) && key.includes('::manifest::')) { entered = true; await gate; }
    return originalSet(key, value);
  };
  const h = await createHayakuRuntime({ autoRepair: false, pluginStorage: original });
  try {
    const packets = [packet()], scope = (await h.hayaku._test.currentChatScope()).key;
    await prepare(h, packets, scope);
    for (let i = 0; i < 100 && !entered; i++) await tick();
    assert.equal(entered, true);
    const replacement = createStore(); h.host.pluginStorage = replacement;
    release(); await tick(); await tick();
    assert.equal([...replacement.values.keys()].filter(key => key.startsWith(PREFIX)).length, 0, 'a late old-provider manifest completion is not a new-provider readback');
    const changed = await prepare(h, packets, scope);
    assert.equal(changed.coverage.routing.index.durable, false); assert.equal(changed.coverage.routing.index.current, false);
    assert.equal(containsEvidence(changed), true);
    const ready = await indexed(h, packets, scope);
    assert.equal(typeof replacement.values.get(ready.coverage.routing.index.manifestKey), 'string');
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
  } finally { release(); await h.dispose(); }
});
