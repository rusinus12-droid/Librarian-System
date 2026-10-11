'use strict';
// Bounded negative controls for the observation helper, not a product replay.
const assert = require('node:assert/strict');
const { assertDeliveryWitness, durableWitness, readActualCanonicalDelivery } = require('./libra_actual_canonical_delivery.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const memory = {
  memoryId: 'fixture-memory', revision: 1, scopeKey: 'fixture-scope',
  sourceDigest: 'fixture-source', artifactDigest: 'fixture-artifact',
  canonicalArtifact: { facts: [
    { text: '민아는 민트차를 좋아한다.' },
    { text: '열쇠 반환 약속이 이행되었다.' }
  ] }
};
const key = 'libra:v1:scope:fixture-scope:memory:6:r1';
const row = {
  kind: 'canonical', classicUsed: true, injected: true,
  memoryKey: key, memoryId: memory.memoryId, revision: 1, scopeKey: memory.scopeKey,
  sourceDigest: memory.sourceDigest, artifactDigest: memory.artifactDigest,
  selectedText: memory.canonicalArtifact.facts.map(fact => fact.text).join('\n')
};
function witness() {
  return copy({
    messages: [{ role: 'user', content: 'fixture-query' },
      { role: 'system', content: '[LIBRA CLASSIC RECALL]\n' + row.selectedText }],
    context: { requestId: 'new-request', route: 'classic', scopeKey: memory.scopeKey,
      contextDigest: 'fixture-seal', canonicalRefs: [{key,memoryId:memory.memoryId,revision:memory.revision,sourceDigest:memory.sourceDigest,artifactDigest:memory.artifactDigest}], values: { currentInput: 'fixture-query' } },
    viewer: { scopeKey: memory.scopeKey, queryText: 'fixture-query',
      responseContextRequestId: 'new-request', responseContextDigest: 'fixture-seal',
      rows: [row], liveTailInjected: false, classicRawStateInjected: false },
    previousRequestId: 'old-request', query: 'fixture-query', expectedMemory: memory,
    durableBefore: { rows: [{ owner: 'local', key, raw: JSON.stringify(memory), value: memory }] }
  });
}

const negatives = [
  ['stale request', x => { x.context.requestId = x.previousRequestId; }],
  ['wrong context scope', x => { x.context.scopeKey = 'other'; }],
  ['wrong query', x => { x.context.values.currentInput = 'other'; }],
  ['wrong viewer scope', x => { x.viewer.scopeKey = 'other'; }],
  ['wrong viewer query', x => { x.viewer.queryText = 'other'; }],
  ['viewer from another request', x => { x.viewer.responseContextRequestId = 'other'; }],
  ['mismatched context seal', x => { x.viewer.responseContextDigest = 'other'; }],
  ['selected but not injected', x => { x.viewer.rows[0].injected = false; }],
  ['no actual system block', x => { x.messages = [x.messages[0]]; }],
  ['text only in user query', x => { x.messages[0].content = row.selectedText; x.messages[1].content = '[LIBRA CLASSIC RECALL]'; }],
  ['partial delivered text', x => { x.messages[1].content = '[LIBRA CLASSIC RECALL]\n민아는 민트차를 좋아한다.'; }],
  ['wrong canonical source', x => { x.viewer.rows[0].sourceDigest = 'other'; }],
  ['wrong canonical owner key', x => { x.viewer.rows[0].memoryKey = key.replace('fixture-scope', 'other'); }],
  ['missing sealed ref', x => { x.context.canonicalRefs = []; }],
  ['ambiguous sealed ref', x => { x.context.canonicalRefs.push(copy(x.context.canonicalRefs[0])); }],
  ...['key','memoryId','revision','sourceDigest','artifactDigest'].map(field => ['wrong sealed '+field, x => { x.context.canonicalRefs[0][field] = field === 'revision' ? 99 : 'wrong'; }]),
  ['unrelated successor identity', x => { x.expectedMemory.memoryId = 'unrelated'; }],
  ['raw State substitute', x => { x.viewer.classicRawStateInjected = true; }],
  ['Live Tail substitute', x => { x.viewer.liveTailInjected = true; }],
  ['canonical text without profile fact', x => { x.durableBefore.rows[0].value.canonicalArtifact.facts.splice(0, 1); }],
  ['canonical text without successor fact', x => { x.expectedMemory.canonicalArtifact.facts.splice(1, 1); }]
];

async function fixtureControl(mutate) {
  const x = witness(); let called = 0; let published = false;
  const local = new Map([[key, JSON.stringify(memory)]]);
  const snapshot = { local, storedRows: () => [], f: { control: { calls: [], hooks: {} }, r: { api: {} } } };
  snapshot.f.control.hooks.beforeRequest = async (messages, route) => {
    called++; assert.equal(route, 'model');
    assert.deepEqual(messages, [{ role: 'user', content: 'fixture-query' }]);
    published = true; if (mutate) mutate(snapshot, x);
    return x.messages;
  };
  snapshot.f.r.api = {
    getLastResponseContext: () => published ? x.context : { requestId: x.previousRequestId },
    getLastMemoryRecallViewer: () => x.viewer,
    validateResponseContext: async context => ({ ok: context === x.context, current: context === x.context })
  };
  await readActualCanonicalDelivery(snapshot, x.query, { expectedMemory: x.expectedMemory });
  assert.equal(called, 1, 'helper actually invokes the registered hook exactly once');
}

(async () => {
  assert.equal(assertDeliveryWitness(witness()).deliveredRows.length, 1);
  const ordinary = witness(); ordinary.viewer.rows[0].memoryKey = '';
  assert.equal(assertDeliveryWitness(ordinary).deliveredRows.length, 1);
  for (const field of ['key','memoryId','revision','sourceDigest','artifactDigest']) {
    const x=copy(ordinary);x.context.canonicalRefs[0][field]=field==='revision'?99:'wrong';
    assert.throws(()=>assertDeliveryWitness(x),assert.AssertionError,'empty viewer locator still requires exact sealed '+field);
  }
  for (const [name, mutate] of negatives) {
    const x = witness(); mutate(x);
    assert.throws(() => assertDeliveryWitness(x), assert.AssertionError, name);
  }
  await fixtureControl();
  await assert.rejects(fixtureControl(snapshot => { snapshot.f.control.calls.push(['unexpected-provider']); }),
    /provider call/);
  await assert.rejects(fixtureControl(snapshot => {
    const changed = copy(memory); changed.canonicalArtifact.facts[0].text += 'changed';
    snapshot.local.set(key, JSON.stringify(changed));
  }), /preserves canonical/);
  const a = durableWitness({ local: new Map([[key, JSON.stringify(memory)]]), storedRows: () => [] });
  const b = durableWitness({ local: new Map(), storedRows: () => [{ key, raw: JSON.stringify(memory), value: memory, revision: 1 }] });
  assert.notEqual(a.rawIdentity, b.rawIdentity, 'moving bytes across physical owner stores is observable');
  console.log(JSON.stringify({ status: 'PASS', kind: 'helper-negative-controls-only',
    positive: 3, rejectedFalseWitnesses: negatives.length, rejectedEmptyLocatorWrongRefs:5, rejectedProviderMutation: 1,
    rejectedDurableMutation: 1, physicalOwnerDistinction: 1, productExecuted: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
