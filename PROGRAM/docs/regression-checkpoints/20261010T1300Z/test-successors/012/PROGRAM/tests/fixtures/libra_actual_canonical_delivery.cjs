'use strict';
// Test-only observation of the registered Classic consumer. This does not build
// a product packet, inject expected text, change settings, or revive an executor.
const assert = require('node:assert/strict');
const { countCalls } = require('./libra_provider_call_kinds.cjs');

const preservedKey = key => /:scope:/.test(key) && (
  /:manifest$|:memory:\d+:r\d+$|:continuity-state$/.test(key)
  || /:entity-registry:v2(?:$|:unified-)/.test(key)
  || /:state-corrections:|:state-correction-(?:meta|commit):|:state-worldline-meta:|:state-tracking-journal:/.test(key)
);
const parsed = raw => { try { return JSON.parse(raw); } catch { return null; } };

// These callers first finish their existing explicit recovery/scan/copy checks.
// This exact comparison describes the immediate hook boundary in those fixtures,
// not a general prohibition on the product's permitted branch bookkeeping. Any
// observed bookkeeping difference remains a failing observation for classification.
function durableWitness(snapshot) {
  assert.ok(snapshot.local instanceof Map, 'fixture supplies its actual local owner store');
  assert.equal(typeof snapshot.storedRows, 'function', 'fixture supplies actual server row readback');
  const local = [...snapshot.local.entries()].filter(([key]) => preservedKey(key))
    .map(([key, raw]) => ({ owner: 'local', key, raw, value: parsed(raw) }));
  const remote = snapshot.storedRows().filter(row => preservedKey(row.key))
    .map(row => ({ owner: 'server', key: row.key, raw: row.raw,
      revision: row.revision, value: row.value }));
  const rows = [...local, ...remote].sort((a, b) => a.owner.localeCompare(b.owner) || a.key.localeCompare(b.key));
  return { rows, rawIdentity: JSON.stringify(rows.map(({ value, ...row }) => row)) };
}

function assertDeliveryWitness({ messages, context, viewer, previousRequestId, query,
  expectedMemory, durableBefore }) {
  const expectedScopeKey = String(expectedMemory?.scopeKey || '');
  assert.ok(expectedScopeKey, 'scope expectation comes from the already verified durable canonical memory');
  assert.ok(context?.requestId, 'the actual hook publishes a fresh response context');
  assert.notEqual(context.requestId, previousRequestId, 'the observation is from this hook call');
  assert.equal(context.route, 'classic');
  assert.equal(context.scopeKey, expectedScopeKey);
  assert.equal(context.values?.currentInput, query);
  assert.equal(viewer?.scopeKey, expectedScopeKey);
  assert.equal(viewer?.queryText, query);
  assert.equal(viewer?.responseContextRequestId, context.requestId);
  assert.ok(context.contextDigest, 'the response context has a seal');
  assert.equal(viewer?.responseContextDigest, context.contextDigest);
  assert.notEqual(viewer.liveTailInjected, true, 'these canonical-only fixtures did not opt into Live Tail');
  assert.notEqual(viewer.classicRawStateInjected, true, 'raw derived Head is not a canonical delivery substitute');
  assert.ok(Array.isArray(messages), 'the real hook returns outbound messages');
  const blocks = messages.filter(row => row.role === 'system'
    && String(row.content || '').includes('[LIBRA CLASSIC RECALL'));
  assert.ok(blocks.length > 0, 'outbound system messages include actual Classic evidence');
  const block = blocks.map(row => String(row.content || '')).join('\n');
  const deliveredRows = Array.from(viewer.rows || []).filter(row => row.kind === 'canonical'
    && row.classicUsed === true && row.injected === true);
  assert.ok(deliveredRows.length > 0, 'positive recovery evidence was actually injected');
  const matchesMemory = (row, memory) => row.memoryId === memory.memoryId
    && Number(row.revision) === Number(memory.revision)
    && row.scopeKey === memory.scopeKey
    && row.sourceDigest === memory.sourceDigest
    && row.artifactDigest === memory.artifactDigest;
  const canonicalMemories = durableBefore.rows.filter(row => row.value?.canonicalArtifact)
    .map(row => ({ key: row.key, memory: row.value }));
  for (const row of deliveredRows) {
    const text = String(row.selectedText || row.text || '');
    assert.ok(text.length > 0, 'injected canonical evidence has nonempty selected text');
    assert.ok(block.includes(text), 'the whole selected canonical text reaches the actual block');
    // Ordinary hydration does not publish its physical locator in the viewer.
    // The same validated response context seals the manifest refs separately.
    const refs = Array.from(context.canonicalRefs || []).filter(ref => ref.memoryId === row.memoryId
      && Number(ref.revision) === Number(row.revision) && ref.sourceDigest === row.sourceDigest
      && ref.artifactDigest === row.artifactDigest);
    assert.equal(refs.length, 1, 'injected identity has one exact same-request sealed canonical ref');
    assert.equal(typeof row.memoryKey, 'string');
    if (row.memoryKey !== '') assert.equal(row.memoryKey, refs[0].key,
      'a provided viewer locator must match the sealed canonical ref');
    assert.ok(canonicalMemories.some(({ key, memory }) => matchesMemory(row, memory)
      && refs[0].key === key), 'sealed injected ref resolves to pre-existing canonical bytes in the same owner scope');
  }
  const suppliesFact = (row, memory, pattern) => matchesMemory(row, memory)
    && (memory.canonicalArtifact?.facts || []).some(fact => pattern.test(String(fact.text || ''))
      && String(row.selectedText || row.text || '').includes(String(fact.text || '')));
  assert.ok(deliveredRows.some(row => suppliesFact(row, expectedMemory, /이행되었다/)),
    'accepted successor meaning is delivered from the exact committed successor identity');
  assert.ok(deliveredRows.some(row => canonicalMemories.some(({ memory }) =>
    suppliesFact(row, memory, /민트차를 좋아한다/))),
  'profile meaning is delivered from a stored canonical fact, not State or prompt metadata');
  return { block, deliveredRows,
    canonicalText: deliveredRows.map(row => String(row.selectedText || row.text || '')).join('\n') };
}

async function readActualCanonicalDelivery(snapshot, query, { expectedMemory }) {
  const f = snapshot.f;
  assert.equal(typeof f.control.hooks.beforeRequest, 'function');
  for (const name of ['getLastResponseContext', 'getLastMemoryRecallViewer', 'validateResponseContext']) {
    assert.equal(typeof f.r.api[name], 'function', `retained consumer API ${name} is available`);
  }
  const previousRequestId = f.r.api.getLastResponseContext()?.requestId;
  const providerBefore = countCalls(f.control);
  const durableBefore = durableWitness(snapshot);
  const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: query }], 'model');
  const context = f.r.api.getLastResponseContext();
  const viewer = f.r.api.getLastMemoryRecallViewer();
  const delivery = assertDeliveryWitness({ messages, context, viewer, previousRequestId,
    query, expectedMemory, durableBefore });
  const validity = await f.r.api.validateResponseContext(context);
  assert.equal(validity.ok, true, JSON.stringify(validity));
  assert.equal(validity.current, true);
  assert.deepEqual(countCalls(f.control), providerBefore,
    'this consumer boundary adds no canonical, Micro, other, or total provider call');
  const durableAfter = durableWitness(snapshot);
  assert.equal(durableAfter.rawIdentity, durableBefore.rawIdentity,
    'the hook preserves canonical/ref/Head/registry/transaction bytes and physical owner revisions');
  return { ...delivery, context, viewer, providerBefore,
    providerAfter: countCalls(f.control), durableRows: durableAfter.rows.length };
}

module.exports = { readActualCanonicalDelivery, assertDeliveryWitness, durableWitness };
