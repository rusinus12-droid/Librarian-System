'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
};

assert.match(source, /const CANONICAL_ARTIFACT_SCHEMA = 'libra\.canonical_artifact\.v3'/);
assert.match(source, /const CANONICAL_ARTIFACT_LEGACY_SCHEMA = 'libra\.canonical_artifact\.v2'/,
  'v2 records remain readable during migration');
assert.match(source, /const CANONICAL_COMMIT_SCHEMA = 'libra\.canonical_commit\.v1'/);
assert.match(source, /const STATE_OBSERVATION_SCHEMA = 'libra\.state_observation\.v2'/);
assert.match(source, /const STATE_PIPELINE_RECEIPT_SCHEMA = 'libra\.state_pipeline_receipt\.v1'/);
assert.match(source, /const ENTITY_REGISTRY_SCHEMA = 'libra\.entity_registry\.v2'/);

const canonicalValidation = between('const validateCanonicalArtifact =', 'const validateCanonicalRenderedText =');
assert.match(canonicalValidation, /CANONICAL_ARTIFACT_SCHEMA/);
assert.match(canonicalValidation,
  /const allowedTopLevel = new Set\(\['schema','chronology','characters','relationships','world','openThreads','uncertainties','recallTerms'\]\)/,
  'v3 must enumerate only canonical-memory fields');
assert.doesNotMatch(canonicalValidation, /allowedTopLevel[^\n]*(?:statePatch|state_patch|narrativePatch|mutation)/,
  'v3 must not re-admit a derived-state mutation field');
assert.match(canonicalValidation, /unknown_top_level_\$\{field\}/,
  'a removed state-mutation field must fail validation as an unknown top-level field');

const ariadne = between('const callAriadne = async', 'const validateAndBindItoPatchEvidence');
assert.doesNotMatch(ariadne, /\bstatePatch\b|\bstate_patch\b|\bnarrativePatch\b/,
  'Memory Ariadne may author canonical memory only');
assert.doesNotMatch(ariadne, /"state"\s*:/,
  'the v3 Memory Ariadne response shape must not request a state mutation');

const ito = between('const callIto = async', 'const buildCanonicalCommitEnvelope =');
assert.doesNotMatch(ito, /\b(?:statePatch|state_patch|narrativePatch|narrative_patch)\s*:/,
  'Memory ito stages may not return a Current State mutation');
assert.match(ito, /retiredAnalyzerError/);
assert.match(ariadne, /retiredAnalyzerError/);
assert.doesNotMatch(ito, /callMemoryProvider\(/);
assert.doesNotMatch(ariadne, /callMemoryProvider\(/);
assert.match(source, /const STAGE_ORDER = Object\.freeze\(\[LIBRARIAN_STAGE_ID\]\)/);
const observer = between('const callStateObserver = async','const callStateVerifier = async');
const verifier = between('const callStateVerifier = async','const statePipelineObservationDigest =');
for(const block of [observer,verifier]){assert.match(block,/retiredAnalyzerError/);assert.doesNotMatch(block,/callProviderWithOperationBudget|callMemoryProvider/);}
assert.match(source,/normalObserverDispatch:0/);
assert.match(source,/validateUnifiedArtifact/);

const orchestrator = between('const runStateTrackingAfterCommit = async', 'const processBatch = async');
assert.match(orchestrator, /stateTracking/,
  'state receipts must be stored under the stateTracking run field');
assert.match(orchestrator, /STATE_PIPELINE_RECEIPT_SCHEMA/);
const postCommit = between('const processBatch = async', 'const retryEmbeddingForMemory = async');
assert.match(postCommit, /run\.stateTracking\s*=\s*\{/,
  'state execution receipts must be stored separately from Memory stage receipts');

process.stdout.write(`libra_canonical_state_pipeline_separation_contract_test: PASS (${path.basename(sourcePath)})\n`);
