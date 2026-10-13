'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const targetPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(targetPath, 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
for (const schema of [
  'libra.canonical_variant_index.v1',
  'libra.canonical_job.v1',
  'libra.canonical_manual_authority.v1',
  'libra.canonical_adoption_transaction.v1',
  'libra.continuity_delta.v1',
  'libra.continuity_override.v1'
]) assert.ok(source.includes(schema), `missing sidecar schema ${schema}`);

for (const api of [
  'startManualColdStart', 'startManualCanonicalScan', 'retryFailedMemoryAnalysis',
  'getCanonicalJobStatus', 'cancelCanonicalJob', 'resumeCanonicalJob',
  'listCanonicalVariants', 'regenerateCanonicalMemory', 'createCanonicalEditDraft',
  'saveCanonicalEditDraft', 'getCanonicalCandidateComparison', 'resolveCanonicalCandidate',
  'selectCanonicalVariant', 'deleteCanonicalVariant', 'saveContinuityOverride'
]) assert.match(source, new RegExp(`async ${api}\\(`), `missing public API ${api}`);

const batch = between('const processBatch = async', 'const retryEmbeddingForMemory = async');
assert.match(batch, /const candidateOnly = options\.candidateOnly === true/);
assert.match(batch, /status: 'candidate'/);
assert.match(batch, /canonical_candidate_readback_failed/);
assert.match(batch, /memory\.status = 'committed'/);
assert.match(batch, /canonical_adoption_readback_failed/);
assert.match(batch, /if \(candidateOnly\) \{[\s\S]*registerCanonicalVariant[\s\S]*return \{ \.\.\.memory, key: memoryKey, variantId:/);
assert.match(batch, /if \(!candidateOnly\) \{[\s\S]*manifest\.inFlight/);
assert.match(batch, /abortIfRequested\(\)/);
assert.match(source, /allowHistoricalBackfill\s*\? starts\.filter\(startTurn => requestedStarts\.size === 0 \|\| requestedStarts\.has\(startTurn\)\)/);

assert.match(source, /options\.recoverStartup === true/);
assert.match(source, /CANONICAL_JOB_ACTIVE_STATES/);
assert.match(source, /resumeJobId: job\.jobId/);
assert.match(source, /allowHistoricalBackfill: true/);
assert.match(source, /recoverCanonicalJobAtStartup\(\)/);
assert.match(source, /startedAt >= Number\(Runtime\.bootedAt \|\| 0\)/);
assert.match(source, /const findPendingCanonicalChoice = async/);
assert.match(source, /canonical_variant_pending_choice_delete_forbidden/);

const adoption = between('const resolveCanonicalCandidate = async', 'const listCanonicalVariants = async');
assert.match(adoption, /canonical_candidate_adoption_precondition_changed/);
assert.match(adoption, /sourceDigest\(currentBatch\) !== candidate\.sourceDigest/);
assert.match(adoption, /const alreadySwitched =/);
assert.match(adoption, /state\s*:\s*'adopting'/);
assert.match(adoption, /validateCanonicalManualAuthority/);
assert.match(adoption, /validateCanonicalAdoptionBinding/);
assert.match(adoption, /commitCanonicalAdoptionTransaction/);
assert.match(adoption, /loadOrRefreshRecallCatalog\(context, manifest, null\)/);
assert.doesNotMatch(adoption, /상태 전용 재분석에 실패했습니다\. 활성 정본은 변경되지 않았습니다/,
  'derived-state failure must not block a verified canonical adoption');
assert.match(adoption, /warnings\.push\(\{ stage: 'state_pipeline_v3'/,
  'post-adoption derived-state failure must be retained as a warning');
assert.match(adoption, /completed_with_warnings/,
  'canonical adoption reports derived rebuild problems without rolling back the pointer');
assert.doesNotMatch(adoption, /callContinuityDeltaProvider|callManualNarrativeDeltaProvider|rebuildMissingContinuityDelta/,
  'v3 adoption must not call the legacy continuity-delta provider');

const replay = between('const replayDurableStateObservations = async', 'const rebuildStateFromCanonicalChainUnlocked = async');
assert.match(replay, /observation\?\.verification\?\.decisions/,
  'v3 replay reuses the durable verifier-decision sidecar');
assert.match(replay, /applyVerifiedStateObservation/);
assert.match(replay, /state_replay_observation_missing/);
assert.match(replay, /state_replay_basis_stale/,
  'stale durable sidecars must fall back to a fresh post-commit observation rather than replaying against the wrong Head');
const stateRebuild = between('const rebuildStateFromCanonicalChainUnlocked = async', '/* LIBRA CANONICAL STATE PIPELINE V3 RUNTIME END */');
assert.match(stateRebuild, /manual_edit_requires_state_correction/,
  'manual memories without a v3 artifact are correction-required, never rebound to stale automatic evidence');
assert.match(source, /canonical_manual_artifact_reuse_forbidden/);
const comparison = between('const buildCanonicalComparison = async', 'const runManagedScan = async');
assert.doesNotMatch(comparison, /callStateObserver|callStateVerifier|callContinuityDeltaProvider|runStateTrackingAfterCommit/,
  'comparison is side-effect free and cannot invoke a state provider');
assert.match(source, /const canonicalNextSlotRevision = async/);
assert.match(source, /canonical_edit_render_invalid/);
assert.match(source, /CANONICAL_ADOPTION_ROLLBACK_INCOMPLETE/);
assert.match(source, /job\.state === 'adopting'\) return await resolveCanonicalCandidate/);
assert.match(source, /중단된 채택 복구/);

const restoreDependencies = between('async function memorySuiteLibraResolveRestoreDependencies', 'async function memorySuiteLibraValidateRestore');
assert.match(restoreDependencies, /libra\.variant\.memoryRef/);
assert.match(restoreDependencies, /libra\.variant\.vectorRef/);
assert.match(restoreDependencies, /libra\.variant\.continuityDelta/);
const restoreValidation = between('async function memorySuiteLibraValidateRestore', 'const MemorySuiteConfigStorageBridge');
assert.match(restoreValidation, /libra_restore_variant_vector_memory_mismatch/);
assert.match(restoreValidation, /libra_restore_variant_delta_digest_mismatch/);

for (const label of ['수동 콜드스타트', '누락 구간 생성 (기본)', '실패 구간 새 분석', '재생성', '수정', '버전 기록', '기존 유지', '후보 채택', '나중에 결정', '작업 취소', '최소화']) {
  assert.ok(source.includes(label), `missing GUI label ${label}`);
}

const renderer=require('./helpers/libra_approved_gui_contract.cjs').extract(source,'renderSettingsGuiOnce');
assert.match(renderer,/Gui\.mockupApp &&|!Gui\.mockupApp \|\| !Gui\.root\.contains\(Gui\.mockupApp\)/,'one actual app owns the shell');
assert.match(renderer,/Gui\.root\.replaceChildren\(stage\)/,'root mounting occurs at the approved frame boundary');
assert.match(renderer,/current\.replaceChildren\(\)/,'only the selected destination body is hydrated');
assert.match(renderer,/requestedRegions=new Set\(Gui\.invalidations\)/);
assert.match(renderer,/existingDrawer=app\.querySelector\('#drawer-quick\[data-book-quick-drawer\]'\)/,'the app keeps one independent drawer owner');
assert.match(renderer,/regionTimesMs/,'actual main/drawer construction retains measured diagnostics');
assert.match(source, /const typing = activeTag === 'TEXTAREA'[\s\S]*?!\['checkbox', 'radio', 'range', 'button', 'submit'\]\.includes\(activeType\)[\s\S]*?if \(active && Gui\.app\?\.contains\(active\) && typing\) return;/,
  'text editing blocks body remounts without suppressing checkbox or button navigation');
assert.match(source, /summaryOnly: true/);
assert.match(source, /data-canonical-job-portal/);
assert.match(source, /250 - \(now - Number\(Gui\.canonicalJobLastRenderAt/);
assert.match(source, /guiRenderMetrics: safeClone/);
assert.match(source, /canonicalSidecars: sidecars/);

process.stdout.write('libra_canonical_variant_job_gui_contract_test: PASS\n');
