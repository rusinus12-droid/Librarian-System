'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

const sliceBetween = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

assert.match(source, /const loadContinuityStateForResponse = async/);
assert.match(source, /pruneContinuityStateHeadToRefs\(stored, refs, scope\)/);
assert.match(source, /canonical_frontier_newer_than_state_head/);
assert.match(source, /last_known_non_authoritative/);
assert.match(source, /const plannerCanonicalPriorityPartition =/);
assert.match(source, /newerThanState/);
assert.match(source, /historicalAtOrBeforeState/);
assert.match(source, /FACTUAL AUTHORITY ORDER: recent completed dialogue > committed Canonical evidence newer than the State Head > current\/last-known State Head > older recalled Canonical evidence/);
assert.match(source, /LAST-KNOWN \/ PENDING \/ NON-AUTHORITATIVE FOR NEWER CANONICAL/);
assert.match(source, /plannerDetailInstruction\(settings\?\.plannerDetailLevel\)/);
assert.match(source, /maxTokens: normalizePlannerOutputBudget\(runtimeSettings\?\.plannerOutputBudget\)/);
assert.match(source, /plannerDetailLevel: normalizePlannerDetailLevel\(runtimeSettings\?\.plannerDetailLevel\)/);
assert.match(source, /plannerOutputBudget: normalizePlannerOutputBudget\(runtimeSettings\?\.plannerOutputBudget\)/);

const beforeRequest = sliceBetween('const beforeRequest = async', 'const afterRequest = async');
assert.match(beforeRequest, /loadContinuityStateForResponse/);
assert.doesNotMatch(beforeRequest, /narrativeForRoute\s*=\s*await __libraCompletionGetNarrative/, 'response planning must not fall back to an unscoped raw Narrative Head');

const planner = sliceBetween('const runTurnPlanner = async', 'const renderPlannerBlock =');
assert.doesNotMatch(planner, /saveContinuityState|storage\.setJson\(key\.continuityState|storage\.setItem\([^\n]*continuity-state/, 'Planner must not mutate State Head');
assert.doesNotMatch(planner, /saveCanonical|commitCanonical|writeCanonical/, 'Planner must not mutate Canonical Memory');

const classic = sliceBetween('const renderClassicBlock =', 'const libraSafeClassicSourceLabel =');
assert.doesNotMatch(classic, /continuity_state_prompt|CURRENT STATE HEAD|continuityStatePromptBlock/, 'Classic final injection must not directly inject derived State prose');
assert.match(source, /buildClassicCanonicalProvenanceRescue[\s\S]{0,1600}requireCurrent: true/);
assert.match(source, /embeddingSettingsSource = embeddingConfig \? 'bounded_settings_load' : 'unavailable_sparse_fallback'/);

process.stdout.write('libra_classic_planner_authority_contract_test: PASS\n');
