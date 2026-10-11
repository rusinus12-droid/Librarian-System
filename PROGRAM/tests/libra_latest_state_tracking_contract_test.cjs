'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

assert.match(source, /const CONTINUITY_STATE_SCHEMA = 'libra\.continuity_state\.v2'/);
assert.match(source, /const CONTINUITY_STATE_PATCH_SCHEMA = 'libra\.continuity_state_patch\.v1'/);
assert.match(source, /const STATE_OBSERVATION_SCHEMA = 'libra\.state_observation\.v2'/);
assert.match(source, /const CANONICAL_COMMIT_SCHEMA = 'libra\.canonical_commit\.v1'/);
assert.match(source, /const CONTINUITY_STATE_RELATION_DIMENSIONS = Object\.freeze\(\[[\s\S]*'affection', 'attraction'/,
  'attraction is an existing directed relationship dimension, not a new state domain');
assert.match(source, /continuityState: scope => `\$\{PREFIX\}:scope:\$\{scope\.scopeKey\}:continuity-state`/);
assert.match(source, /This is intentionally not a second memory system/);
assert.match(source, /no history\/revision chain, no vectors and no/);
assert.match(source, /continuityStateForbiddenKeys = new Set\(\[/);
for (const forbidden of ['history', 'events', 'timeline', 'revisions', 'previous', 'inner_thoughts', 'affinity_score']) {
  assert.match(source, new RegExp(`['"]${forbidden}['"]`));
}

const callItoStart = source.indexOf('const callIto = async');
const callItoEnd = source.indexOf('const buildCanonicalCommitEnvelope', callItoStart);
assert.ok(callItoStart >= 0 && callItoEnd > callItoStart, 'Memory ito execution block exists');
const memoryIto = source.slice(callItoStart, callItoEnd);
assert.doesNotMatch(memoryIto, /(?:statePatch|state_patch|narrativePatch|narrative_patch)\s*:/,
  'Memory ito output must not return a Current State mutation');
assert.match(memoryIto, /throw retiredAnalyzerError/,'legacy memory provider no longer returns a mutation');
assert.match(source, /const buildCanonicalCommitEnvelope =/);
assert.match(source, /const verifyCanonicalCommitEnvelope =/);
assert.match(source, /const runStateTrackingAfterCommit = async/);
assert.match(source, /const callStateObserver = async/);
assert.match(source, /const applyVerifiedStateObservation =/);
for (const domain of ['character', 'relationship', 'world', 'narrative']) {
  assert.match(source, new RegExp(`['"]state_${domain}_observer['"]`));
}
assert.match(source, /const STATE_PIPELINE_DOMAINS = Object\.freeze\(\['character', 'relationship', 'world', 'narrative'\]\)/);
assert.doesNotMatch(source, /state_(?:scene|objective|pattern)_observer/,
  'semantic safety must not add a fifth observer or independent analyzer');
assert.match(source, /Future-shaping Character fields require the existing Character Verifier/);
assert.match(source, /Affection|affection/);
assert.match(source, /numeric affinity|affinity_score/);
assert.doesNotMatch(source, /key\.(?:continuityStateHistory|stateDelta|stateProjection|stateCheckpoint)/);

assert.match(source, /reviewedThroughCanonical/);
assert.match(source, /changedThroughCanonical/);
assert.match(source, /reviewedThroughTurn/);
assert.match(source, /changedThroughTurn/);
assert.match(source, /\[RECENT DIALOGUE CONTEXT — NOT PERSISTED\]/);
assert.match(source, /continuity_state:head,continuity_state_authority:response\?\.authority/,'read-only unified context retains scoped State authority');
assert.match(source, /const SHARED_MEMORY_HUB_SECTIONS = Object\.freeze\(\['read', 'context', 'manage'\]\)/,
  'Memory is a reader, evidence context, and canonical management workspace');
assert.match(source, /const SHARED_EXECUTION_LOG_SECTIONS = Object\.freeze\(\['memory',\s*'state',\s*'draft',\s*'recall',\s*'embedding',\s*'rebuild'\]\)/);
assert.match(source, /const worldManagerSnapshotView = \(\) => \{[\s\S]*LibraMemoryCore\.peekSnapshot\(\)/);
for (const builder of ['buildWorldManagerCharactersPanel', 'buildWorldManagerRelationshipsPanel', 'buildWorldManagerWorldPanel', 'buildWorldManagerNarrativePanel']) {
  assert.match(source, new RegExp(`const ${builder} =`));
}
assert.match(source, /worldManagerSelect\(values\.dimension,CONTINUITY_STATE_RELATION_DIMENSIONS\.map/,
  'relationship correction UI must render every runtime-supported dimension from one authority');
assert.doesNotMatch(source, /id: 'continuity_state', label: '월드 매니저'/,
  'World Manager domains must no longer be hidden inside the Memory hub');
assert.match(source, /getCurrentStateHead\(\) \{ return LibraMemoryCore\.getContinuityState\(\); \}/);

assert.match(source, /continuityStateSeed: sourceContinuityState \? clone\(sourceContinuityState\) : null/);
assert.match(source, /rebuildStateAfterCanonicalTransfer\(\{[\s\S]*seed: handoffContinuityStateSeed/,
  'handoff seed is compatibility fallback only; target-chain Registry and Head rebuild is authoritative');
assert.match(source, /continuityRebuildPending: stateTransferRebuild\?\.pending === true/);
assert.match(source, /state_tracking_disabled_not_required/,
  'disabled state tracking is an explicit not-required outcome, not a failed transfer');
assert.match(source, /continuityRequired: false/,
  'disabled state tracking must declare that continuity derivation is not required');
assert.match(source, /continuityStateAuthority: stateTransferRebuild\?\.continuityRequired === false \? 'not_required'[\s\S]{0,180}stateTransferRebuild\?\.ok === true && stateTransferRebuild\?\.pending !== true \? 'target_canonical_chain' : 'none_pending'/,
  'receipts must distinguish disabled/not-required, successful target-chain authority, and failed-or-pending non-authority');
assert.match(source, /continuity-state\$\|memory:/);
assert.match(source, /libra_restore_continuity_state_invalid/);

console.log('libra_latest_state_tracking_contract_test: PASS');
