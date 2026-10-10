'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');

const path = require('node:path');
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
assert.match(source, /if \(injectionMode === 'classic'\)/);
assert.match(source, /buildClassicCanonicalProvenanceRescue\(context\.scope, queryBundle\.manifest \|\| requestManifest \|\| null, queryBundle\)/);

// The Classic renderer may use provenance only as a role label; it must not inject the State Head payload.
const start = source.indexOf('const renderClassicBlock =');
const end = source.indexOf('const libraSafeClassicSourceLabel =', start);
assert.ok(start >= 0 && end > start);
const classicRenderer = source.slice(start, end);
assert.doesNotMatch(classicRenderer, /continuity_state_prompt|continuityStatePromptBlock|ARIADNE CURRENT STATE HEAD/);
assert.match(classicRenderer, /row\?\.classicEvidenceRole/);
assert.match(classicRenderer, /LATEST RELEVANT CANONICAL EVIDENCE/);

// Planner/SGA own the response-safe State Head path; Classic uses State only before recall as provenance routing.
assert.match(source, /if \(injectionMode !== 'classic'\) \{[\s\S]{0,1400}?loadContinuityStateForResponse/);

console.log('libra_classic_provenance_rescue_contract_test: PASS');
