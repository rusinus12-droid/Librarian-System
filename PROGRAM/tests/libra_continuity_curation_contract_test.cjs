'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

const sourceBetween = (start, end) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source start: ${start}`);
  assert.ok(endIndex > startIndex, `missing source end: ${end}`);
  return source.slice(startIndex, endIndex);
};

assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"), releaseText('continuity execution fix remains present in LIBRA {libra}'));
assert.ok(source.includes('const PROMPT_PROFILE_COMPILER_VERSION = 9;'), 'prompt compiler includes state semantic safety and sanitized Live Tail authority wording');

const contract = sourceBetween('const unifiedPromptContract =', 'const executeUnifiedStage =');
const dispatch = sourceBetween('const executeUnifiedStage =', 'const unifiedStateBindingsForRead =');
assert.match(contract, /preserve materially distinct facts needed for continuity/);
assert.match(contract, /Preserve actor, target, speaker and observer ownership/);
assert.match(contract, /A→B never proves B→A/);
assert.match(contract, /Profile instructions cannot change this evidence\/output contract/);
assert.match(dispatch, /compileMemoryPromptProfile\(LIBRARIAN_STAGE_ID/);
assert.match(dispatch, /const system=\[unifiedPromptContract\(\),.*subordinate.*compiled\.profileBody/);
assert.match(dispatch, /callMemoryProvider\(LIBRARIAN_STAGE_ID,system,user/);
assert.match(dispatch, /finalizeMemoryPromptProvenance\(compiled,system\)/,
  'the live Librarian dispatch hashes its full assembled system prompt');

assert.doesNotMatch(source, /const STORY_ARC_RELATIONSHIP_DIMENSIONS =|const storyArcDerivedFromMemory =|const storyArcDirectorPrompts =/,
  'retired accumulated Story Arc curation must not remain as a second state system');
assert.match(source, /const CONTINUITY_STATE_RELATION_DIMENSIONS = Object\.freeze\(\[/,
  'directional relationship dimensions belong to the current-state reducer');
assert.match(source, /subjectId[\s\S]*targetId[\s\S]*dimension/,
  'Current State relationships retain directional subject, target, and dimension identity');
const relationshipObserver = sourceBetween('const callStateObserver = async', 'const callStateVerifier = async');
assert.match(relationshipObserver, /retiredAnalyzerError/,'old observer does not dispatch');
assert.match(source, /A→B never proves B→A/,'single analyzer receives directional relationship contract');

assert.ok(source.includes("const MEMORY_SCHEMA = 'libra.canonical_memory.v1';"), 'canonical memory remains the historical truth schema');
assert.ok(source.includes('Canonical memories remain the only historical truth store.'), 'Story Arc remains a rebuildable materialized view');
assert.ok(!source.includes('class IdentityRegistry'), 'no reference IdentityRegistry was transplanted');
assert.ok(!source.includes('class RevisionStore'), 'no weaker reference RevisionStore was transplanted');
assert.ok(!source.includes('function mergeWorldDelta'), 'no second canonical state merge engine was transplanted');
assert.ok(!source.includes('parseStructuredWorldDelta'), 'no permissive reference parser was transplanted');

process.stdout.write('libra_continuity_curation_contract_test: ok\n');

