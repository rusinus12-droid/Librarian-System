'use strict';
// Observe the retained request hook. The layer object below is the product's
// sealed canonicalLayers, and each delivered row must reach the returned block.
const assert = require('node:assert/strict');
const { countCalls } = require('./libra_provider_call_kinds.cjs');
async function actualClassicPacket(f, query, expectedScopeKey, {allowEmpty = false} = {}) {
  const previous = f.r.api.getLastResponseContext();
  const providerCalls = countCalls(f.control);
  assert.equal(typeof f.control.hooks.beforeRequest, 'function');
  const messages = await f.control.hooks.beforeRequest([{role: 'user', content: query}], 'model');
  const context = f.r.api.getLastResponseContext();
  const viewer = f.r.api.getLastMemoryRecallViewer();
  assert.ok(context?.requestId, 'actual Classic publishes a request-local response context');
  assert.notEqual(context.requestId, previous?.requestId, 'the witness belongs to this new query');
  assert.equal(context.route, 'classic');
  assert.equal(context.scopeKey, expectedScopeKey);
  assert.equal(context.values?.currentInput, query);
  assert.equal(viewer?.scopeKey, expectedScopeKey);
  assert.equal(viewer?.queryText, query);
  assert.equal(viewer?.responseContextRequestId, context.requestId);
  assert.equal(viewer?.responseContextDigest, context.contextDigest);
  const validity = await f.r.api.validateResponseContext(context);
  assert.equal(validity.ok, true, JSON.stringify(validity));
  assert.equal(validity.current, true);
  assert.deepEqual(countCalls(f.control), providerCalls, 'the actual consumer adds no canonical, Micro, other or total provider calls');
  const injected = messages.filter(row => row.role === 'system' &&
    String(row.content || '').includes('[LIBRA CLASSIC RECALL'));
  const deliveredRows = Array.from(viewer?.rows || []).filter(row => row.classicUsed === true && row.injected === true);
  if (!allowEmpty) {
    assert.ok(injected.length > 0, 'the actual returned prompt contains Classic recall');
    assert.ok(deliveredRows.length > 0, 'at least one canonical row was actually delivered');
  }
  const block = injected.map(row => row.content).join('\n');
  assert.notEqual(viewer.liveTailInjected, true, 'this canonical-only fixture has no Live Tail opt-in');
  for (const row of deliveredRows) {
    const exactText = String(row.selectedText || row.text || '');
    assert.ok(exactText.length > 0, 'each delivered row carries actual selected text');
    assert.ok(block.includes(exactText), 'each delivered row is present whole in the returned Classic block');
  }
  return {evidencePacket: {layers: context.values.canonicalLayers, temporal_scope: viewer.temporalAnchor},
    actualClassic: {context, viewer, deliveredRows, block}};
}

function deliveredClosureRows(packet) {
  const layers = Array.from(packet?.evidencePacket?.layers?.memory || []).filter(row => row.closure === true);
  return layers.filter(row => packet.actualClassic.deliveredRows.some(delivered =>
    (delivered.closure === true || Number(delivered.closureFacts || 0) > 0)
    && delivered.memoryId === row.memoryId && Number(delivered.revision) === Number(row.revision)
    && delivered.scopeKey === row.scopeKey
    && Array.from(packet.actualClassic.context.canonicalRefs || []).filter(ref =>
      ref.memoryId === row.memoryId && Number(ref.revision) === Number(row.revision)
      && ref.sourceDigest === row.sourceDigest && ref.artifactDigest === row.artifactDigest
      && ref.key === row.memoryKey).length === 1
    && (delivered.memoryKey === '' || delivered.memoryKey === row.memoryKey)
    && delivered.sourceDigest === row.sourceDigest && delivered.artifactDigest === row.artifactDigest
    && String(delivered.selectedText || delivered.text || '').includes(row.text)
    && packet.actualClassic.block.includes(row.text)));
}

function assertHealthyEmpty(packet) {
  const { viewer, deliveredRows, block } = packet.actualClassic;
  assert.equal(viewer.sourceTurnAccounting?.status, 'complete');
  assert.equal(viewer.sourceTurnAccounting?.completeUniqueOriginalTurns, 0);
  assert.equal(viewer.sourceTurnAccounting?.emittedUnits, 0);
  assert.equal(Number(viewer.selectedMemories), 0);
  assert.equal(Array.from(viewer.rows || []).length, 0);
  assert.equal(deliveredRows.length, 0);
  assert.equal(Object.values(packet.evidencePacket.layers || {}).flat().length, 0);
  assert.equal(block, '');
}

function assertOriginalOrdinarySelection(packet, original) {
  const viewer = packet.actualClassic.viewer;
  const ordinary = Array.from(viewer.rows || []).filter(row => row.closure !== true);
  assert.equal(viewer.selectedMemories, 1, 'same-request complete selection contains only the original memory');
  assert.equal(ordinary.length, 1, 'non-injected selected rows are included in this check');
  const row = ordinary[0];
  assert.equal(row.kind, 'canonical');
  for (const field of ['memoryId', 'revision', 'scopeKey', 'sourceDigest', 'artifactDigest']) {
    assert.ok(original[field] !== undefined && original[field] !== '', `durable original has ${field}`);
    assert.equal(row[field], original[field], `actual ordinary selection binds original ${field}`);
  }
  const context = packet.actualClassic.context;
  assert.equal(context.scopeKey, original.scopeKey);
  const refs = Array.from(context.canonicalRefs || []).filter(ref => ref.memoryId === row.memoryId
    && ref.revision === row.revision && ref.sourceDigest === row.sourceDigest
    && ref.artifactDigest === row.artifactDigest);
  assert.equal(refs.length, 1, 'the validated same-request context supplies one exact canonical identity');
  assert.equal(refs[0].key, original.memoryKey, 'the sealed ref resolves to the actual original physical record');
  assert.deepEqual(JSON.parse(JSON.stringify(refs[0].turnRange)), original.turnRange);
  assert.equal(Number(refs[0].sessionEpoch || 0), original.sessionEpoch);
  assert.equal(refs[0].inherited === true, original.inherited);
  assert.equal(typeof row.memoryKey, 'string');
  if (row.memoryKey !== '') assert.equal(row.memoryKey, refs[0].key,
    'when present the optional viewer locator must agree with the sealed physical ref');
  return ordinary;
}

function assertNoForbiddenClosure(packet, forbiddenTexts) {
  const forbidden = Array.from(forbiddenTexts);
  assert.ok(forbidden.every(text => typeof text === 'string' && text.length > 0));
  // Inspect the actual viewer and rendered labels independently of sealed layers.
  // closureFacts may count a valid closure within an otherwise ordinary historical row.
  // Its other historical text is not thereby relabelled as closure.
  const rows = packet.actualClassic.deliveredRows.filter(row => row.closure === true
    || row.classicEvidenceRole === 'continuity_closure');
  for (const row of rows) for (const text of forbidden) {
    assert.equal(String(row.selectedText || row.text || '').includes(text), false,
      'forbidden historical text cannot be marked as an injected closure');
  }
  const block = packet.actualClassic.block;
  const headers = [...block.matchAll(/^\[(LATER CANONICAL CONTINUITY EVIDENCE|LATEST RELEVANT CANONICAL EVIDENCE|HISTORICAL CANONICAL EVIDENCE|TURN EVIDENCE \(MICRO\)|RECENT DIALOGUE|CURRENT SESSION|PREVIOUS SESSION \d+)(?: · [^\n]*)?\]\n/gm)];
  for (let i = 0; i < headers.length; i++) {
    if (headers[i][1] !== 'LATER CANONICAL CONTINUITY EVIDENCE') continue;
    const section = block.slice(headers[i].index + headers[i][0].length,
      i + 1 < headers.length ? headers[i+1].index : block.length);
    for (const text of forbidden) assert.equal(section.includes(text), false,
      'actual closure-labelled section cannot contain forbidden historical text');
  }
}
module.exports = { actualClassicPacket, deliveredClosureRows, assertHealthyEmpty,
  assertOriginalOrdinarySelection, assertNoForbiddenClosure };
