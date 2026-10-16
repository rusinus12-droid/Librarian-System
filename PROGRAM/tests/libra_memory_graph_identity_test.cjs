'use strict';
const assert = require('node:assert/strict');
const createIdentity = require('../tools/libra_memory_graph_identity.cjs');
const { fixture, fingerprint, frame, bound, stable, legacy, clone } = require('./fixtures/libra_memory_graph_identity_fixture.cjs');
const results = [];
const test = (name, run) => { run(); results.push(name); };
const setup = () => {
  const k = createIdentity({ fingerprint });
  const origin = k.source({ identity: stable('canonical-source'), binding: bound('memory:r1', { text: 'first' }) });
  const claim = (source = origin, anchor = { actorId: 'mina', predicate: 'owns', value: 'key', polarity: 'positive', turn: 2 }, options = {}) =>
    k.meaning({ source, kind: 'canonical_fact', identity: stable('claim-attachment'), anchor,
      binding: bound('memory:r1#claim', { value: 'key' }), ...options });
  return { k, origin, claim };
};

test('four source families form a nonempty normalized graph without becoming runtime proof', () => {
  const f = fixture();
  assert.equal(f.nodes.length, 13); assert.equal(f.edges.length, 19);
  assert.equal(new Set(f.nodes.map(n => n.id)).size, f.nodes.length);
  assert.equal(new Set(f.edges.map(e => e.id)).size, f.edges.length);
  for (const node of f.nodes) {
    assert.match(node.id, /^libra\.node\.v1:[0-9a-f]{64}$/);
    assert.equal(node.identityCoverage, 'revision_bound');
    assert.equal(Object.isFrozen(node), true);
  }
  const ids = new Set(f.nodes.map(n => n.id));
  for (const edge of f.edges) { assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)); }
  const adjacency = new Map(f.nodes.map(n => [n.id, new Set()]));
  for (const e of f.edges) { adjacency.get(e.from).add(e.to); adjacency.get(e.to).add(e.from); }
  const reached = new Set([f.entities.key.id]), queue = [...reached];
  while (queue.length) for (const next of adjacency.get(queue.shift())) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  assert.equal(reached.size, f.nodes.length, 'projection connectivity, not retrieval or relevance');
  assert.equal(f.retrievalImplemented, false); assert.equal(f.physicalProofVerified, false);
  assert.equal(f.kernel.inspect().authority, 'descriptive_only');
  assert.equal(f.kernel.inspect().byteBounded, false);
  assert.ok(!JSON.stringify(f.nodes).includes(f.records.micro.claims[0].evidence.exactQuote), 'public labels contain no source body');
});

test('physical key, revision, body and restore epoch affect binding rather than stable source identity', () => {
  const { k, origin } = setup();
  for (const overrides of [{ revision: 2 }, { locator: { recordKey: 'moved:r1' } }, { body: { text: 'paraphrase' } },
    { restoreEpoch: 8 }, { owner: 'other-physical-reader' }]) {
    const next = k.source({ identity: stable('canonical-source'), binding: bound('memory:r1', { text: 'first' }, 1, overrides) });
    assert.equal(next.id, origin.id); assert.equal(k.sameIdentity(origin, next), true);
    assert.equal(k.sameBinding(origin, next), false);
  }
});

test('qualified owner, origin scope, object and birth distinguish stable logical identities', () => {
  const { k, origin } = setup();
  for (const change of [{ ownerNamespace: 'other' }, { originScope: 'other' }, { objectUUID: 'other' }, { birthIncarnation: 'reborn' }]) {
    assert.notEqual(k.source({ identity: { ...stable('canonical-source'), ...change }, binding: bound('memory:r1', {}) }).id, origin.id);
  }
});

test('revision-bound sources cannot borrow a stable identity or a mismatched revision body', () => {
  const k = createIdentity({ fingerprint }), body = { text: 'legacy' };
  const a = k.source({ identity: legacy('old', body), binding: bound('old', body) });
  const b = k.source({ identity: legacy('old', body, 2), binding: bound('old', body, 2) });
  const c = k.source({ identity: legacy('old', body, 1, 'fixture', 8), binding: bound('old', body, 1, { restoreEpoch: 8 }) });
  assert.notEqual(a.id, b.id); assert.notEqual(a.id, c.id); assert.equal(a.identityCoverage, 'revision_bound');
  assert.throws(() => k.source({ identity: legacy('old', body), binding: bound('old', { text: 'different' }) }), /REVISION_BINDING_MISMATCH/);
});

test('meaning identity follows the exact typed anchor, independently of rendering and physical key', () => {
  const { k, claim } = setup(), a = claim();
  const b = claim(undefined, undefined, { binding: bound('other-key', { value: 'key', text: 'another rendering' }, 2) });
  assert.equal(a.id, b.id); assert.equal(k.sameBinding(a, b), false);
  for (const anchor of [{ actorId: 'other-mina' }, { polarity: 'negative' }, { value: 'other-key' }, { turn: 3 }]) {
    assert.notEqual(claim(undefined, { actorId: 'mina', predicate: 'owns', value: 'key', polarity: 'positive', turn: 2, ...anchor }).id, a.id);
  }
});

test('same-named entities, source excerpts and different adapter roles are not silently merged', () => {
  const { k, origin, claim } = setup();
  const a = k.entity({ identity: stable('person-a'), binding: bound('entity:a', { name: '민아' }) });
  const b = k.entity({ identity: stable('person-b'), binding: bound('entity:b', { name: '민아' }) });
  assert.notEqual(a.id, b.id);
  const excerpt = k.meaning({ source: origin, kind: 'source_excerpt', identity: stable('claim-attachment'),
    anchor: { start: 0, end: 5, coordinateSpace: 'source' }, binding: bound('excerpt', 'first') });
  assert.notEqual(excerpt.id, claim().id);
});

test('unit and basis identities must belong to their source partition', () => {
  const { k, origin, claim } = setup();
  assert.throws(() => claim(undefined, undefined, { identity: { ...stable('claim-attachment'), originScope: 'other' } }), /SOURCE_PARTITION_MISMATCH/);
  assert.throws(() => k.basis({ source: origin, kind: 'canonical_claim', identity: { ...stable('evidence'), ownerNamespace: 'other' },
    anchor: {}, binding: bound('evidence', {}) }), /SOURCE_PARTITION_MISMATCH/);
});

test('unknown and explicit clear stay different bindings of a qualified State field', () => {
  const k = createIdentity({ fingerprint });
  const project = (availability, revision) => {
    const body = { availability, value: null };
    const source = k.source({ identity: stable('state-head'), binding: bound('head', { ownerRef: body }, revision) });
    return k.meaning({ source, kind: 'state_field', identity: stable('state-head'),
      anchor: { domain: 'world', entityId: 'key', field: 'ownerRef' }, binding: bound('head#ownerRef', body, revision) });
  };
  const unknown = project('unknown', 1), clear = project('clear', 2);
  assert.equal(unknown.id, clear.id); assert.equal(k.sameBinding(unknown, clear), false);
});

test('same endpoints retain multiple predicates, direction, qualifier, valid time and evidence occurrence', () => {
  const f = fixture(), a = f.meaning.ownerFact, b = f.entities.mina;
  const options = { from: a, to: b, predicate: 'mentions', basis: f.reasons.canonical, binding: bound('edge', {}) };
  const first = f.kernel.edge(options);
  for (const change of [{ predicate: 'target_of' }, { from: b, to: a }, { qualifier: { field: 'ownerRef' } },
    { validTime: { turn: 3 } }, { basis: f.reasons.micro }]) assert.notEqual(f.kernel.edge({ ...options, ...change }).id, first.id);
  assert.equal(f.edges.filter(e => e.from === a.id && e.to === b.id).length, 2);
});

test('stable basis revisions update bindings, while new basis incarnations change EdgeID', () => {
  const { k, origin, claim } = setup(), a = claim();
  const why = (identity = stable('evidence-occurrence'), revision = 1) => k.basis({ source: origin, kind: 'canonical_claim',
    identity, anchor: { span: [0, 5] }, binding: bound('evidence', 'first', revision) });
  const make = basis => k.edge({ from: a, to: origin, predicate: 'evidenced_by', basis, binding: bound('edge', {}) });
  const first = make(why()), revised = make(why(undefined, 2));
  assert.equal(first.id, revised.id); assert.equal(k.sameBinding(first, revised), false);
  assert.notEqual(make(why({ ...stable('evidence-occurrence'), birthIncarnation: 'replacement' })).id, first.id);
});

test('JSON clones, foreign factories, stale cleared handles and mixed query frames cannot issue edges', () => {
  const f = fixture();
  const options = { from: f.meaning.ownerFact, to: f.entities.key, predicate: 'mentions', basis: f.reasons.canonical, binding: bound('edge', {}) };
  assert.throws(() => f.kernel.edge({ ...options, from: clone(options.from) }), /HANDLE_UNAVAILABLE/);
  assert.throws(() => createIdentity({ fingerprint }).edge(options), /HANDLE_UNAVAILABLE/);
  for (const change of [{ scopeKey: 'other' }, { worldlineId: 'fork' }, { restoreEpoch: 8 }, { view: { viewerId: 'other', asOf: 3 } }]) {
    assert.throws(() => f.kernel.edge({ ...options, binding: bound('edge', {}, 1, change) }), /FRAME_MISMATCH/);
  }
  f.kernel.clear(); assert.throws(() => f.kernel.edge(options), /HANDLE_UNAVAILABLE/);
  assert.equal(f.kernel.inspect().retainedIdentityKeys, 0);
});

test('heuristic association bases cannot be promoted to facts or lifecycle edges', () => {
  const f = fixture(), body = { sharedTopic: 'key' };
  const why = f.kernel.basis({ source: f.sources.lore, kind: 'association', identity: legacy('affinity', body),
    anchor: { algorithm: 'fixture' }, binding: bound('affinity', body) });
  const options = { from: f.meaning.rule, to: f.meaning.transfer, basis: why, binding: bound('edge', {}) };
  assert.ok(f.kernel.edge({ ...options, predicate: 'semantic_affinity' }));
  for (const predicate of ['updates', 'fulfills', 'evidenced_by']) assert.throws(() => f.kernel.edge({ ...options, predicate }), /ASSOCIATION_AUTHORITY/);
  assert.throws(() => f.kernel.edge({ ...options, predicate: 'causal_followup' }), /PREDICATE_INVALID/);
});

test('exact JSON normalization preserves ordering and scalar types without invoking source accessors', () => {
  const { k } = setup();
  const make = body => k.source({ identity: stable('json'), binding: bound('json', body) });
  assert.equal(make({ a: 1, b: 2 }).bindingId, make({ b: 2, a: 1 }).bindingId);
  assert.notEqual(make([1, 2]).bindingId, make([2, 1]).bindingId);
  assert.notEqual(make(1).bindingId, make('1').bindingId);
  const absentView = bound('json', {}); delete absentView.view;
  assert.equal(k.source({ identity: stable('json'), binding: absentView }).bindingId,
    k.source({ identity: stable('json'), binding: { ...absentView, view: null } }).bindingId);
  let invoked = false; const body = {}; Object.defineProperty(body, 'secret', { enumerable: true, get() { invoked = true; return 'value'; } });
  assert.throws(() => k.source({ identity: stable('json'), binding: { ...bound('json', {}), body } }), /JSON_DATA_REQUIRED/);
  assert.equal(invoked, false);
  for (const invalid of [NaN, Infinity, -0, undefined, new Map(), [, 1]]) {
    assert.throws(() => k.source({ identity: stable('json'), binding: { ...bound('json', {}), body: invalid } }), /JSON_/);
  }
});

test('identity and binding fingerprint collisions reject atomically instead of merging tuples', () => {
  const constant = '0'.repeat(64), k = createIdentity({ fingerprint: () => constant });
  k.source({ identity: stable('first'), binding: bound('first', {}) });
  assert.throws(() => k.source({ identity: stable('second'), binding: bound('second', {}) }), /IDENTITY_LABEL_COLLISION/);
  assert.equal(k.inspect().retainedIdentityKeys, 1);
  const b = createIdentity({ fingerprint: text => text.startsWith('["libra.node.v1:') ? constant : fingerprint(text) });
  b.source({ identity: stable('first'), binding: bound('first', {}) });
  assert.throws(() => b.source({ identity: stable('second'), binding: bound('second', {}) }), /IDENTITY_LABEL_COLLISION/);
  assert.equal(b.inspect().retainedIdentityKeys, 1);
});

console.log(JSON.stringify({ suite: 'libra_memory_graph_identity', passed: results.length, tests: results,
  scope: 'normalized_identity_and_projection_connectivity', runtimeIntegrated: false, physicalProofVerified: false }));
