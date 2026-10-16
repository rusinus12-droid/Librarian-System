'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
const factoryPath = require('node:path').join(__dirname, '../tools/libra_memory_network.cjs');
assert.ok(fs.existsSync(factoryPath), 'A1 requires the pure canonical network factory');
const createNetwork = require(factoryPath);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const network = createNetwork({ hash });
const frame = { owner: 'plugin_only:owner-a', scopeKey: 'scope-a', worldlineId: 'main', asOf: null, authorityEpoch: 7, activeSourceMapping: 'mapping-a' };
const source = { ownerNamespace: 'owner-a', originScope: 'scope-a', objectUUID: 'message-object-a', birthIncarnation: 'birth-a', revision: 1, analysisRevision: 1, recordKey: 'canonical-a:r1' };
const claim = { actorId: 'entity-mina-a', targetId: 'entity-key-a', predicate: 'possession', direction: 'outgoing', value: { holderId: 'entity-mina-a' }, polarity: 'positive', time: { turn: 5 }, certainty: 'confirmed', sourceAnchors: ['message-object-a:span-key'], text: 'Mina holds the silver key.' };
const memory = { memoryId: 'memory-a', revision: 1, text: claim.text, claims: [claim], embedding: { profileId: 'space-a' } };
const project = (m = memory, s = source, f = frame) => network.projectCanonical({ memory: m, source: s, frame: f });
// Every metadata route that reaches the recursive output freezer must either
// copy structured data or reject unsupported types before touching the caller.
const invalidMetadata = [];
for (const [route, inputFor] of [
  ['source.revision', value => ({ memory, source: { ...source, revision: value }, frame })],
  ['source.analysisRevision', value => ({ memory, source: { ...source, analysisRevision: value }, frame })],
  ['memory.revision fallback', value => ({ memory: { ...memory, revision: value }, source: { ...source, revision: undefined }, frame })],
  ['claim.entityIds entry', value => ({ memory: { ...memory, claims: [{ ...claim, entityIds: [value] }] }, source, frame })]
]) {
  const callerValue = { id: 'unsupported-object', nested: { sequence: 1 } };
  const input = inputFor(callerValue);
  const before = JSON.stringify(input);
  let error = null;
  try { network.project(input); } catch (caught) { error = caught; }
  invalidMetadata.push({ route, rejected: error instanceof TypeError && /REVISION_TYPE|ENTITY_ID_TYPE/.test(error.message),
    callerFrozen: Object.isFrozen(callerValue) || Object.isFrozen(callerValue.nested), unchanged: JSON.stringify(input) === before });
}
assert.deepEqual(invalidMetadata, invalidMetadata.map(({ route }) => ({ route, rejected: true, callerFrozen: false, unchanged: true })),
  'structured source revisions, fallback revision and entity IDs reject without freezing or changing caller objects');
for (const revision of [null, undefined, 0, 1, 'analysis-r2', '']) {
  const unit = project(memory, { ...source, revision, analysisRevision: revision });
  assert.equal(unit.binding.sourceRevision, revision ?? memory.revision);
  assert.equal(unit.binding.analysisRevision, revision ?? null);
}
const entityUnit = project({ ...memory, claims: [{ ...claim, entityIds: ['entity-mina-a', '  entity-extra  '] }] });
assert.ok(entityUnit.postings.entity.includes('entity-extra'), 'supported string entity IDs normalize to primitive posting keys');
assert.ok(entityUnit.postings.entity.every(key => typeof key === 'string'));
const malformedIdentities = [];
for (const [route, inputFor] of [
  ...['ownerNamespace', 'originScope', 'objectUUID', 'birthIncarnation'].map(field => [field, value => ({ memory, source: { ...source, [field]: value }, frame })]),
  ...['actorId', 'targetId', 'predicate', 'direction', 'polarity', 'certainty'].map(field => [field, value => ({ memory: { ...memory, claims: [{ ...claim, [field]: value }] }, source, frame })]),
  ['sourceAnchors', value => ({ memory: { ...memory, claims: [{ ...claim, sourceAnchors: [value] }] }, source, frame })]
]) {
  const callerValue = { id: route, nested: { sequence: 1 } };
  let error = null;
  try { network.project(inputFor(callerValue)); } catch (caught) { error = caught; }
  malformedIdentities.push({ route, rejected: error instanceof TypeError && /IDENTIFIER_TYPE/.test(error.message),
    callerFrozen: Object.isFrozen(callerValue) || Object.isFrozen(callerValue.nested) });
}
assert.deepEqual(malformedIdentities, malformedIdentities.map(({ route }) => ({ route, rejected: true, callerFrozen: false })),
  'identifier objects cannot become complete identities through String coercion');
const callerToken = { id: 'unsupported-token', nested: { sequence: 1 } };
let tokenError = null;
try { createNetwork({ hash, tokenize: () => [callerToken] }).project({ memory, source, frame }); } catch (caught) { tokenError = caught; }
assert.deepEqual({ rejected: tokenError instanceof TypeError && /IDENTIFIER_TYPE/.test(tokenError.message),
  callerFrozen: Object.isFrozen(callerToken) || Object.isFrozen(callerToken.nested) },
{ rejected: true, callerFrozen: false }, 'custom tokenizer keys also reject retained objects before freezing');
const a = project();
const callerFrame = { ...frame, asOf: { turn: 3 } };
project(memory, source, callerFrame);
assert.equal(Object.isFrozen(callerFrame.asOf), false, 'pure projection does not freeze caller frame data');
assert.equal(a.identityCoverage, 'complete');
const paraphrase = project({ ...memory, revision: 2, text: 'The key is in Mina’s hand.', claims: [{ ...claim, text: 'The key is in Mina’s hand.' }] }, { ...source, revision: 2, analysisRevision: 2, recordKey: 'canonical-a:r2' });
assert.equal(a.sourceId, paraphrase.sourceId, 'logical source survives a text/revision change');
assert.equal(a.claims[0].claimId, paraphrase.claims[0].claimId, 'proved typed meaning and attachment survives paraphrase');
assert.notEqual(a.binding.bindingId, paraphrase.binding.bindingId);
assert.notEqual(a.representationId, paraphrase.representationId, 'text/space representation is separate from claim identity');
for (const change of [{ polarity: 'negative' }, { targetId: 'other-key' }, { time: { turn: 6 } }, { certainty: 'uncertain' }, { value: { holderId: 'other-person' } }, { actorId: 'entity-mina-b' }]) {
  const changed = project({ ...memory, claims: [{ ...claim, ...change, claimId: a.claims[0].claimId }] });
  assert.notEqual(changed.claims[0].claimId, a.claims[0].claimId, 'changed meaning / same-name entity cannot reuse a caller claimId');
}
const split = project({ ...memory, claims: [{ ...claim, sourceAnchors: ['message-object-a:left'] }, { ...claim, sourceAnchors: ['message-object-a:right'] }] });
assert.ok(split.claims.every(c => c.claimId !== a.claims[0].claimId));
assert.notEqual(split.claims[0].claimId, split.claims[1].claimId);
const merge = project({ ...memory, claims: [{ ...claim, sourceAnchors: ['message-object-a:left', 'message-object-a:right'] }] });
assert.ok(![a.claims[0].claimId, ...split.claims.map(c => c.claimId)].includes(merge.claims[0].claimId));
const duplicate = project({ ...memory, claims: [claim, { ...claim }] });
assert.equal(duplicate.identityCoverage, 'partial', 'ambiguous one-to-one mapping stays partial');
assert.notEqual(duplicate.claims[0].claimId, duplicate.claims[1].claimId);
for (const changed of [{ ...source, originScope: 'scope-b' }, { ...source, ownerNamespace: 'owner-b' }, { ...source, birthIncarnation: 'reborn' }, { ...source, objectUUID: 'copy-a' }]) assert.notEqual(project(memory, changed).sourceId, a.sourceId);
const legacy = project(memory, { revision: 1, recordKey: 'legacy:r1' });
const legacy2 = project({ ...memory, revision: 2 }, { revision: 2, recordKey: 'legacy:r2' });
assert.equal(legacy.identityCoverage, 'partial');
assert.notEqual(legacy.sourceId, legacy2.sourceId, 'ambiguous legacy source is explicitly revision bound');
const registry = network.createRegistry({ frame });
const row = { id: 'memory-a:r1', memory, score: 4 };
const first = registry.upsert(a, row, { kind: 'lexical', score: .4 });
const again = registry.upsert(a, row, { kind: 'entity', score: .9 });
assert.equal(first, again, 'all accesses merge into SingleCandidate');
assert.equal(Object.isFrozen(first), true, 'caller cannot mutate active identity/binding/generation');
assert.equal(first.pathBonus, 0);
assert.equal(first.accesses.length, 2);
assert.equal(registry.rows()[0], row, 'runtime adapters preserve row and memory identity');
assert.equal(registry.rows()[0].memory, memory);
assert.deepEqual(registry.discoverCandidates({ tokens: ['silver'] }).map(c => c.id), [a.nodeId]);
assert.deepEqual(registry.discoverCandidates({ entities: ['entity-mina-a'] }).map(c => c.id), [a.nodeId]);
assert.deepEqual(registry.discoverCandidates({ predicates: ['possession'] }).map(c => c.id), [a.nodeId]);
assert.deepEqual(registry.discoverCandidates({ times: ['5'] }).map(c => c.id), [a.nodeId]);
const semanticMemory = { ...memory, memoryId: 'semantic-only', text: 'Unrelated wording', claims: [] };
const semantic = project(semanticMemory, { ...source, objectUUID: 'semantic-only' });
registry.upsert(semantic, { memory: semanticMemory }, { kind: 'semantic', score: .8 });
assert.equal(registry.discoverCandidates({ tokens: ['zero-overlap'], semanticIds: [semantic.nodeId] })[0].id, semantic.nodeId, 'lexical0 semantic discovery survives');
assert.equal(registry.discoverCandidates({ tokens: ['silver'] })[0].id, a.nodeId, 'semantic0 lexical discovery survives');
const lease7 = registry.capture(a.nodeId);
assert.equal(registry.isCurrent(lease7), true);
registry.invalidate({ frame: { ...frame, authorityEpoch: 8 }, sourceIds: [a.sourceId] });
assert.equal(registry.rows().length, 0, 'invalidation removes active candidate and postings');
assert.equal(registry.discoverCandidates({ tokens: ['silver'] }).length, 0);
const b = project({ ...memory, text: 'B' }, { ...source, revision: 2 }, { ...frame, authorityEpoch: 8 });
registry.upsert(b, { memory: { ...memory, text: 'B' } });
registry.invalidate({ frame: { ...frame, authorityEpoch: 11 } });
const restored = project(memory, source, { ...frame, authorityEpoch: 11 });
registry.upsert(restored, row);
assert.equal(restored.sourceId, a.sourceId);
assert.equal(restored.binding.textHash, a.binding.textHash);
assert.equal(registry.isCurrent(lease7), false, 'ABA old job/readset rejects at restored identical A');
assert.equal(registry.isCurrent(registry.capture(restored.nodeId)), true);
assert.throws(() => registry.invalidate({ frame: { ...frame, authorityEpoch: 7 } }), /epoch.*rewind/i);
assert.throws(() => registry.upsert(a, row), /binding.*frame/i, 'old persisted JSON epoch cannot issue current authority');
const current = registry.capture(restored.nodeId);
for (const changed of [{ scopeKey: 'scope-b' }, { owner: 'server_only:owner-a' }, { worldlineId: 'fork' }, { asOf: 3 }, { activeSourceMapping: 'mapping-b' }]) {
  const foreign = { ...current, frame: { ...current.frame, ...changed } };
  assert.equal(registry.isCurrent(foreign), false, 'owner / frame / mapping mismatch rejects');
}
registry.invalidate({ sourceIds: [restored.sourceId] });
assert.equal(registry.isCurrent(current), false, 'revocation invalidates job/readset');
assert.equal(typeof network.project, 'function', 'approved MemoryNetwork facade exposes project');
assert.equal(typeof network.upsert, 'function');
assert.equal(typeof network.invalidate, 'function');
assert.equal(typeof network.discover, 'function');
assert.equal(network.scoreCandidate, undefined, 'C2/D1 scorer is not falsely enabled by A1');
assert.equal(network.retrieve, undefined, 'C2/D1 retriever is not falsely enabled by A1');
const facade = createNetwork({ adapters: { hash } });
const units = facade.project({ memory, source, frame, row });
assert.equal(units.length, 1);
assert.equal(units[0].sourceId, a.sourceId);
const coverage = facade.upsert(units, { frame });
assert.equal(coverage.indexed, 1);
assert.equal(coverage.identityCoverage, 'complete');
const found = facade.discover([{ unitId: units[0].nodeId, kind: 'semantic', score: .7 }, { unitId: units[0].nodeId, kind: 'lexical', score: .4 }]);
assert.equal(found.length, 1);
assert.equal(found[0].row, row, 'facade preserves the original row across all accesses');
assert.equal(found[0].pathBonus, 0);
assert.equal(facade.discover({ tokens: ['silver'] })[0], found[0]);
facade.invalidate([a.sourceId], 8);
assert.equal(facade.discover({ tokens: ['silver'] }).length, 0);
assert.throws(() => facade.invalidate([], 7), /epoch.*rewind/i);
// Use the real deployed createTextHasher function, not the crypto test adapter.
const vm = require('node:vm');
const pluginSource = fs.readFileSync(require('node:path').join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const hasherSource = /const createTextHasher = \(\) => \{[\s\S]*?^  \};/m.exec(pluginSource)?.[0];
assert.ok(hasherSource, 'runtime legacy hasher extraction remains bound to product source');
const actualHasher = vm.runInNewContext('(' + hasherSource.replace('const createTextHasher = ', '').replace(/;$/, '') + ')');
const runtimeHash = value => actualHasher().update(value).digest();
const collisionUUIDs = ['uuid-b8f55479', 'uuid-d3de9ea9'];
assert.equal(runtimeHash(JSON.stringify(['source-object', 'owner', 'scope', collisionUUIDs[0], 'birth'])), '6593cea9:58');
assert.equal(runtimeHash(JSON.stringify(['source-object', 'owner', 'scope', collisionUUIDs[1], 'birth'])), '6593cea9:58');
const collisionFrame = { owner: 'owner', scopeKey: 'scope', worldlineId: 'w', authorityEpoch: 7 };
const collisionClaim = { actorId: 'a', targetId: 'b', predicate: 'holds', direction: 'forward', value: 'key', polarity: 'positive', time: { turn: 1 }, certainty: 'confirmed', sourceAnchors: ['span'] };
const collisionInput = (objectUUID, body = objectUUID) => ({ memory: { memoryId: objectUUID, text: body, claims: [collisionClaim] },
  source: { ownerNamespace: 'owner', originScope: 'scope', objectUUID, birthIncarnation: 'birth', revision: 1, recordKey: objectUUID }, frame: collisionFrame });
for (const adapterHash of [runtimeHash, () => 'constant']) {
  const safe = createNetwork({ adapters: { hash: adapterHash } });
  const units = collisionUUIDs.map(uuid => safe.project(collisionInput(uuid))[0]);
  assert.notEqual(units[0].sourceId, units[1].sourceId, 'independent source UUIDs survive runtime/adversarial adapter hash collision');
  assert.notEqual(units[0].nodeId, units[1].nodeId);
  const registry = safe.createRegistry({ frame: collisionFrame });
  const rows = units.map((unit, index) => ({ id: collisionUUIDs[index], memory: collisionInput(collisionUUIDs[index]).memory }));
  registry.upsert(units[0], rows[0]);
  const firstLease = registry.capture(units[0].nodeId);
  registry.upsert(units[1], rows[1]);
  assert.deepEqual(registry.rows(), rows, 'distinct sources both remain available to the existing scorer');
  assert.equal(registry.discoverCandidates({ semanticIds: units.map(unit => unit.nodeId) }).length, 2);
  assert.equal(registry.isCurrent(firstLease), true, 'independent source admission does not revoke the other source lease');
  const secondLease = registry.capture(units[1].nodeId);
  registry.invalidate({ sourceIds: [units[0].sourceId] });
  assert.equal(registry.isCurrent(firstLease), false);
  assert.equal(registry.isCurrent(secondLease), true, 'source leases do not cross bindings');
}
// Verify factory-local SHA256 against Node crypto, including its browser fallback.
const browserCreate = vm.runInNewContext('(' + createNetwork.toString() + ')', { TextEncoder: undefined });
for (const create of [createNetwork, browserCreate]) {
  const shaNetwork = create({ adapters: { hash: runtimeHash } });
  for (const body of ['', 'abc', '민아의 열쇠', '🔑🚀 astral', '\ud800']) {
    const unit = shaNetwork.project({ ...collisionInput('unicode', body), memory: { ...collisionInput('unicode', body).memory, text: body } })[0];
    assert.equal(unit.binding.textHash, hash(body), 'local SHA256 agrees with Node crypto for UTF8 text');
  }
}
// Simulate an unexpected collision even in the strong label component. Exact
// private tuples must prevent unrelated-source replacement and stale binding reuse.
const shaMarker = 'const sha256Hex = value => {';
assert.equal(createNetwork.toString().split(shaMarker).length, 2);
const brokenSHAFactory = vm.runInNewContext('(' + createNetwork.toString().replace(shaMarker,
  shaMarker + " return '0'.repeat(64);") + ')');
const collisionNetwork = brokenSHAFactory({ adapters: { hash: () => 'constant' } });
const exactRegistry = collisionNetwork.createRegistry({ frame: collisionFrame });
const originalUnit = collisionNetwork.project(collisionInput(collisionUUIDs[0], 'original text'))[0];
const originalRow = { memory: collisionInput(collisionUUIDs[0], 'original text').memory };
exactRegistry.upsert(originalUnit, originalRow);
const originalLease = exactRegistry.capture(originalUnit.nodeId);
const foreignUnit = collisionNetwork.project(collisionInput(collisionUUIDs[1], 'foreign text'))[0];
assert.equal(originalUnit.nodeId, foreignUnit.nodeId, 'test interleaving forces an equal label for different exact identities');
let labelError = null;
try { exactRegistry.upsert(foreignUnit, { memory: collisionInput(collisionUUIDs[1]).memory }); } catch (error) { labelError = error; }
const changedUnit = collisionNetwork.project(collisionInput(collisionUUIDs[0], 'changed text'))[0];
assert.equal(changedUnit.nodeId, originalUnit.nodeId);
assert.equal(changedUnit.binding.bindingId, originalUnit.binding.bindingId, 'test also forces equal binding labels for different snapshots');
const beforeReplacement = { retained: exactRegistry.rows()[0] === originalRow, originalLeaseCurrent: exactRegistry.isCurrent(originalLease) };
const replacementRow = { memory: collisionInput(collisionUUIDs[0], 'changed text').memory };
exactRegistry.upsert(changedUnit, replacementRow);
assert.deepEqual({ rejectedForeign: labelError?.code === 'LIBRA_NETWORK_IDENTITY_LABEL_COLLISION',
  reason: labelError?.coverage?.reason, status: exactRegistry.diagnostics().status,
  retainedBeforeReplacement: beforeReplacement.retained, leaseValidBeforeReplacement: beforeReplacement.originalLeaseCurrent,
  replacementRetained: exactRegistry.rows()[0] === replacementRow, oldLeaseRejected: !exactRegistry.isCurrent(originalLease),
  currentLeaseValid: exactRegistry.isCurrent(exactRegistry.capture(changedUnit.nodeId)) },
{ rejectedForeign: true, reason: 'identity_label_collision', status: 'partial', retainedBeforeReplacement: true,
  leaseValidBeforeReplacement: true, replacementRetained: true, oldLeaseRejected: true, currentLeaseValid: true },
'exact identity/binding equality rejects unrelated label collision and replaces changed snapshots despite equal hash labels');
assert.ok(exactRegistry.diagnostics().partialReasons.includes('identity_label_collision'));
// A source-label collision must also reject when different claim meanings keep
// node labels distinct; source invalidation must never join unrelated sources.
const sourceOnlyCollisionFactory = vm.runInNewContext('(' + createNetwork.toString().replace(shaMarker,
  shaMarker + " if (String(value).startsWith('[\"source-object\"')) return '0'.repeat(64);") + ')');
const sourceOnlyNetwork = sourceOnlyCollisionFactory({ adapters: { hash: () => 'constant' } });
const sourceOnlyRegistry = sourceOnlyNetwork.createRegistry({ frame: collisionFrame });
const sourceOnlyFirst = sourceOnlyNetwork.project(collisionInput(collisionUUIDs[0]))[0];
const otherMeaningInput = collisionInput(collisionUUIDs[1]);
otherMeaningInput.memory.claims = [{ ...collisionClaim, targetId: 'different-target' }];
const sourceOnlySecond = sourceOnlyNetwork.project(otherMeaningInput)[0];
assert.equal(sourceOnlyFirst.sourceId, sourceOnlySecond.sourceId);
assert.notEqual(sourceOnlyFirst.nodeId, sourceOnlySecond.nodeId);
const sourceOnlyRow = { memory: collisionInput(collisionUUIDs[0]).memory };
sourceOnlyRegistry.upsert(sourceOnlyFirst, sourceOnlyRow);
const sourceOnlyLease = sourceOnlyRegistry.capture(sourceOnlyFirst.nodeId);
assert.throws(() => sourceOnlyRegistry.upsert(sourceOnlySecond, { memory: otherMeaningInput.memory }),
  error => error.code === 'LIBRA_NETWORK_IDENTITY_LABEL_COLLISION' && error.coverage.reason === 'identity_label_collision',
  'unequal exact source tuples cannot share a source label even when node labels differ');
assert.equal(sourceOnlyRegistry.rows().length, 1);
assert.equal(sourceOnlyRegistry.rows()[0], sourceOnlyRow, 'source collision keeps the exact original row object');
assert.equal(sourceOnlyRegistry.isCurrent(sourceOnlyLease), true);
console.log('libra_network_projection_test: PASS');
