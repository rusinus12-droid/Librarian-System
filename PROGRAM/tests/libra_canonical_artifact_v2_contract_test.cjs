'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.match(source, /const CANONICAL_ARTIFACT_SCHEMA = 'libra\.canonical_artifact\.v3'/);
assert.match(source, /const CANONICAL_ARTIFACT_LEGACY_SCHEMA = 'libra\.canonical_artifact\.v2'/,
  'stored v2 artifacts remain a read-compatible migration input');
assert.match(source, /const CANONICAL_ARTIFACT_REFERENCE_MAX_CHARS = 16000/);
assert.match(source, /const parseCanonicalArtifactJson =/);
assert.match(source, /const validateCanonicalArtifact =/);
assert.match(source, /const renderCanonicalArtifact =/);
assert.match(source, /const validateCanonicalRenderedText =/);
assert.match(source, /reasoning_or_meta_leak/);
assert.match(source, /canonicalEvidenceRef/);
const artifactValidation = between('const validateCanonicalArtifact =', 'const validateCanonicalRenderedText =');
assert.match(artifactValidation, /unknown_top_level_\$\{field\}/);
assert.match(artifactValidation, /relationship_dimension_invalid_\$\{index\}/,
  'canonical artifacts reject unsupported relationship dimensions before commit');
assert.doesNotMatch(artifactValidation, /allowedTopLevel[^\n]*(?:statePatch|state_patch|narrativePatch)/,
  'v3 canonical artifacts must not carry a Current State mutation');

const librarianPrompt = between('const unifiedPromptContract =', 'const executeUnifiedStage =');
assert.match(librarianPrompt, /Do not invent motives, predictions, consent or outcomes/);
assert.match(librarianPrompt, /consent, refusal, coercion/);
assert.match(librarianPrompt, /A→B never proves B→A/);
assert.match(librarianPrompt, /CONTINUITY_STATE_RELATION_DIMENSIONS\.join\('\|'\)/,
  'the live analyzer shares the relationship-dimension authority with the reader');

const ariadne = between('const callAriadne = async', 'const callIto = async');
assert.match(ariadne, /throw retiredAnalyzerError\('ariadne'\)/);
assert.doesNotMatch(ariadne, /callMemoryProvider\(/);
assert.match(source, /renderUnifiedArtifact = artifact => renderCanonicalArtifact\(unifiedProjection\(artifact\)\)/);

const provider = between('const callMemoryProvider = async', 'const callAriadne = async');
for (const gate of [
  'promptCacheUnsupportedRetry: true', 'thinkingUnsupportedRetry: true',
  'nativeJsonUnsupportedRetry: true', 'contextRetry: true',
  'transientRetry: true', 'lengthLimitRetry: true', 'noThinkingRetry: true'
]) assert.ok(provider.includes(gate), `missing canonical retry gate: ${gate}`);
assert.match(provider, /reserveCanonicalProviderAttempt/);
assert.match(source, /canonical_provider_call_budget_exhausted/);
assert.match(source, /canonical_provider_input_token_budget_exhausted/);
assert.match(source, /canonical_provider_output_token_budget_exhausted/);
assert.match(source, /canonical_provider_reasoning_token_budget_exhausted/);
assert.match(source, /canonical_provider_retry_budget_exhausted/);

assert.match(source, /const providerModelCapabilityProfile =/);
assert.match(source, /forcedReasoning: glm53Flash/);
assert.match(source, /body\.reasoning_effort = capability\.canonicalReasoningEffort/);
assert.match(source, /signal: options\.signal/);
assert.match(source, /retrievedContent: retrievedContent \|\|/);
assert.match(source, /repackCanonicalReferencePacketForBudget\(rendered\.packet, CANONICAL_ARTIFACT_REFERENCE_MAX_CHARS/);

const readMigration = between('const normalizeCanonicalArtifactForRead =', 'const canonicalJsonHasDuplicateKeys =');
assert.match(readMigration, /source\.schema === CANONICAL_ARTIFACT_LEGACY_SCHEMA/);
assert.match(readMigration, /delete source\.state/,
  'legacy state mutation is discarded instead of migrating into canonical v3');
assert.match(readMigration, /legacy_ca_\$\{stableHash/,
  'v2 rows receive deterministic assertion identities for evidence-bound replay');
assert.match(readMigration, /legacyStateObservationCompatible/);
assert.match(source, /legacy_v2_artifact_evidence_incomplete/,
  'insufficient legacy evidence must skip state observation instead of guessing');

console.log('libra_canonical_artifact_v2_contract_test: PASS');
