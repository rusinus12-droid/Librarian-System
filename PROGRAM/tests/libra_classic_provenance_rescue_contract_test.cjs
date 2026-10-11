'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');

const path = require('node:path');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { actualClassicPacket } = require('./fixtures/libra_actual_classic_request.cjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.match(source, /const CLASSIC_PROVENANCE_RESCUE_SCHEMA = 'libra\.classic_provenance_rescue\.v1'/);
assert.match(source, /const CLASSIC_PROVENANCE_RESCUE_MAX_REFS = 2/);
assert.match(source, /const classicCanonicalProvenanceRescueFromHead =/);
assert.match(source, /const buildClassicCanonicalProvenanceRescue = async/);
assert.match(source, /continuityEvidenceMatchesRef\(evidence, ref\)/);
assert.match(source, /current_state_provenance_rescue/);
assert.match(source, /provenanceRescueKeys/);
assert.match(source, /provenanceRescueCandidates/);
assert.match(source, /classicProvenanceRescueActive/);
assert.match(source, /classicRawStateInjected: false/);
assert.match(source, /LATEST RELEVANT CANONICAL EVIDENCE/);
assert.match(source, /HISTORICAL CANONICAL EVIDENCE/);
assert.match(source, /No derived State Head value is injected/);
assert.match(source, /queryBundle\.provenanceRescue = await runRecallStep/);
assert.match(source, /buildClassicCanonicalProvenanceRescue\(context\.scope, queryBundle\.manifest \|\| requestManifest \|\| null, queryBundle\)/);

// The Classic renderer may use provenance only as a role label; it must not inject the State Head payload.
const start = source.indexOf('const renderClassicBlock =');
const end = source.indexOf('const libraSafeClassicSourceLabel =', start);
assert.ok(start >= 0 && end > start);
const classicRenderer = source.slice(start, end);
assert.doesNotMatch(classicRenderer, /continuity_state_prompt|continuityStatePromptBlock|ARIADNE CURRENT STATE HEAD/);
assert.match(classicRenderer, /row\?\.classicEvidenceRole/);
assert.match(classicRenderer, /LATEST RELEVANT CANONICAL EVIDENCE/);

// The retained Classic request uses State provenance to select a canonical
// source. It never injects the derived Head; retired Planner/SGA branch syntax
// cannot serve as a witness for the current route.
(async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).completed, 1);
    const manifest = f.getManifest();
    const headRow = f.getRecords('libra.continuity_state.v2')[0];
    assert.ok(headRow);
    const head = f.clone(headRow.value);
    const person = head.characters.find(row => row.name === '민아');
    assert.ok(person?.fieldEvidence?.locationRef);
    const derivedSentinel = 'DERIVED_STATE_ONLY_PROVENANCE_SENTINEL';
    person.state.locationRef = derivedSentinel;
    const question = '민아는 지금 어디 있어?';
    const requestForHead = async value => {
      const values = new Map(f.r.values);
      values.set(headRow.key, JSON.stringify(value));
      // A fresh runtime reads the disposable persisted Head rather than the
      // producer runtime's valid in-memory Head cache.
      const fresh = await fixture({ snapshot: { chat: f.clone(f.chat), values: [...values] } });
      try { return await actualClassicPacket(fresh, question, manifest.scopeKey); }
      finally { await fresh.r.cleanup(); }
    };
    const packet = await requestForHead(head);
    assert.equal(packet.actualClassic.viewer.classicProvenanceRescueActive, true);
    assert.equal(packet.actualClassic.viewer.latestRelevantMemories, 1);
    assert.ok(packet.actualClassic.block.includes('LATEST RELEVANT CANONICAL EVIDENCE'));
    assert.ok(packet.actualClassic.block.includes('민아가 서재에 도착했다.'));
    assert.equal(packet.actualClassic.viewer.classicRawStateInjected, false);
    assert.equal(packet.actualClassic.viewer.continuityStateUsed, false);
    assert.equal(packet.actualClassic.context.values.currentHead, null);
    assert.equal(packet.actualClassic.block.includes(derivedSentinel), false,
      'a derived State value absent from Canonical cannot reach actual Classic output');
    const staleHead = f.clone(head);
    staleHead.characters.find(row => row.name === '민아').fieldEvidence.locationRef = {
      memoryId: 'missing_canonical_pointer', revision: 99, sourceDigest: 'foreign_source',
      turnRange: { start: 101, end: 105 }, sessionEpoch: 0
    };
    assert.equal(f.r.api.debugClassicProvenanceRescueFromHead(staleHead, manifest, question).active, false,
      'the fixture contains no matching committed provenance pointer');
    const rejected = await requestForHead(staleHead);
    assert.equal(rejected.actualClassic.viewer.classicProvenanceRescueActive, false,
      'a pointer outside the committed manifest cannot authorize provenance rescue');
    assert.equal(rejected.actualClassic.viewer.latestRelevantMemories, 0);
    assert.equal(rejected.actualClassic.block.includes('LATEST RELEVANT CANONICAL EVIDENCE'), false);
    assert.equal(rejected.actualClassic.block.includes(derivedSentinel), false);
    assert.equal(rejected.actualClassic.context.values.currentHead, null);
    console.log(JSON.stringify({ test: 'libra_classic_provenance_rescue_contract', passed: 1,
      boundary: 'retained Classic hook, sealed physical refs, exact canonical text; controlled plugin_only fixture',
      canonicalSourcesRescued: packet.actualClassic.viewer.latestRelevantMemories,
      stalePointerSourcesRescued: rejected.actualClassic.viewer.latestRelevantMemories, derivedStateInjected: false }));
  } finally { await f.r.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
