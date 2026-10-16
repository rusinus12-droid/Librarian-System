'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(process.argv[2] || process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '..', 'plugins', 'LIBRA.js'));
const source = fs.readFileSync(pluginPath, 'utf8');
const publicApiStart = source.indexOf('const publicApi = Object.freeze({');
assert.notEqual(publicApiStart, -1, 'missing host public API');
const publicApiSource = source.slice(publicApiStart, source.indexOf('\n  });', publicApiStart) + 6);

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

assert.match(source.slice(0, 512), releasePattern("\\/\\/@version {libra}\\b", ""), 'version declaration must remain inside the first 512 bytes');
assert.match(source, releasePattern("const PLUGIN_VERSION = '{libra}'", ""));

for (const api of [
  'listCanonicalReaderChapters', 'getCanonicalReaderChapter', 'getCanonicalEvidenceChain',
  'listExecutionReceipts', 'getExecutionReceiptDetail'
]) {
  assert.match(source, new RegExp(`const\\s+${api}\\s*=\\s*async\\b`), `missing core API ${api}`);
  assert.match(source, new RegExp(`return Object\\.freeze\\([\\s\\S]{0,7000}\\b${api}\\b`), `missing public API export ${api}`);
  assert.match(publicApiSource, new RegExp(`async\\s+${api}\\s*\\(`), `missing host public API wrapper ${api}`);
}

const readerList = between('const listCanonicalReaderChapters = async', '// Native owner projection shared');
assert.match(readerList, /limit=20/);
assert.match(readerList, /canonicalReaderSearchRefs/);
assert.doesNotMatch(readerList, /loadMemoryRef|LibraProviderBridge|callTask|storage\.set|saveManifest|embed(?:Query|Text)?\s*\(/,
  'Chapter list must remain summary-only, provider-free, and mutation-free');

const readerSearch = between('const canonicalReaderSearchRefs = async', 'const listCanonicalReaderChapters = async');
assert.match(readerSearch,/executeMemoryGraphUnifiedQuery/);
assert.match(readerSearch,/semanticPolicy: \{ mode: 'disabled' \}/);
assert.doesNotMatch(readerSearch,/recallCatalog|fallbackMatch|storage\.set|saveManifest/);

const readerDetail = between('const getCanonicalReaderChapter = async', 'const canonicalEvidenceArtifactRows =');
assert.match(readerDetail, /loadMemoryRef\(ref\)/, 'detail must lazily hydrate only the selected ref');
assert.doesNotMatch(readerDetail, /getWorldManagerHistoryDetail\(/, 'detail must not hydrate the selected Canonical record a second time');
assert.match(readerDetail, /sourceDigest[^\n]*ref\.sourceDigest/);
assert.match(readerDetail, /changeStatus:actualChanges\.length\?'changed':'no_recorded_change'/);
assert.doesNotMatch(readerDetail, /storage\.set|saveManifest|LibraProviderBridge|callTask/);

const evidence = between('const getCanonicalEvidenceChain = async', 'const normalizeExecutionReceiptStatus =');
for (const layer of ['source', 'canonical', 'assertion', 'admission', 'observation', 'verification', 'patch', 'head']) {
  assert.match(evidence, new RegExp(`addNode\\('${layer}'`), `missing evidence layer ${layer}`);
}
assert.match(evidence, /CANONICAL_EVIDENCE_ACTIVE_REF_MISMATCH/);
assert.match(evidence, /historical_only/);
assert.match(evidence, /statePipelineReceiptDigest\(receipt\)/);
assert.match(evidence, /validationErrors/);
assert.match(evidence, /CANONICAL_EVIDENCE_STATE_RECEIPT_INVALID/);
assert.match(evidence, /authority:layerAuthority/);
assert.doesNotMatch(evidence, /storage\.set|saveManifest|LibraProviderBridge|callTask/);

const receipts = between('const normalizeExecutionReceiptStatus =', 'const normalizeWorldManagerCorrectionDomain =');
for (const status of ['complete', 'partial', 'pending', 'not_required', 'skipped', 'stale', 'failed']) assert.match(receipts, new RegExp(`'${status}'`));
for (const kind of ['memory', 'state', 'draft', 'recall', 'embedding', 'rebuild']) assert.match(receipts, new RegExp(`'${kind}'`));
assert.match(receipts, /sessionOnly:true/);
assert.match(receipts, /durable:true/);
assert.doesNotMatch(receipts, /storage\.set|saveManifest|LibraProviderBridge|callTask/);

// Actual approved GUI behavior is exercised by the DOM transaction/retirement
// suites. Check the current read/detail/evidence wiring rather than old CSS ids.
for(const name of ['buildBookMemoryReaderProjection','buildBookMemoryRail','buildBookMemoryReadingSheet','buildCanonicalEvidenceDrawer'])assert.match(source,new RegExp('const '+name+' ='));
const currentMemory=between('const buildApprovedMockupMemory =','const buildApprovedMockupSettings =');
assert.match(currentMemory,/buildBookMemoryReaderProjection/);assert.match(currentMemory,/buildCanonicalEvidenceDrawer/);

const references = between('const sealReferenceSourceSnapshot =', 'const formatShadowRisuContext =');
assert.match(references, /libra\.reference_source_snapshot\.v1|REFERENCE_SOURCE_SNAPSHOT_SCHEMA/);
assert.match(references, /referenceSnapshotDigest/);
assert.match(references, /resolveReferenceBodies/);
assert.match(source, /referenceSnapshotDigest/);

const governor = between('const createCanonicalProviderBudget =', 'const canonicalProviderRecoveryPlan =');
assert.match(governor, /libra\.provider_operation_budget\.v1/);
assert.match(governor, /parentOperationId/);
const physicalAttempt = between('const executePhysicalAttempt =', 'let outcome;');
assert.match(physicalAttempt, /reserveCanonicalProviderAttempt\(budget, stageName/);
assert.match(physicalAttempt, /finishCanonicalProviderAttempt\(budget, reservation\.row, result, null\)/);
assert.match(physicalAttempt, /finishCanonicalProviderAttempt\(budget, reservation\.row, result, error\)/);
assert.match(source, /normalObserverDispatch:0/);
assert.match(source, /LEGACY_STATE_REPLAY_EVIDENCE_REQUIRED/);
assert.match(source, /parentOperationId: string\(providerBudget\?\.operationId/);
assert.match(source, /orphanPresetBindings/);
assert.match(source, /preset_id/);

console.log('LIBRA reader, Evidence, execution receipt, reference snapshot, and provider governor contract test passed.');
