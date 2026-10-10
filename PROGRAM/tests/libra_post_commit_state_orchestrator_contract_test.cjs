'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

for (const helper of [
  'buildCanonicalCommitEnvelope', 'verifyCanonicalCommitEnvelope',
  'callStateObserver', 'callStateVerifier', 'applyVerifiedStateObservation',
  'runStateTrackingAfterCommit'
]) assert.match(source, new RegExp(`const ${helper} =`), `missing post-commit helper: ${helper}`);

const envelopeBuilder = between('const buildCanonicalCommitEnvelope =', 'const verifyCanonicalCommitEnvelope =');
for (const binding of [
  'scopeKey', 'worldlineId', 'memoryId', 'revision', 'turnRange',
  'sourceDigest', 'artifactDigest', 'memoryKey', 'status'
]) assert.match(envelopeBuilder, new RegExp(`\\b${binding}\\b`), `commit envelope lost ${binding}`);
assert.match(envelopeBuilder, /CANONICAL_COMMIT_SCHEMA/);
assert.match(envelopeBuilder, /status:\s*string\(memory\?\.status/,
  'the envelope must carry the durable memory status instead of manufacturing committed');

const envelopeVerifier = between('const verifyCanonicalCommitEnvelope =', 'const statePipelineHeadFingerprint =');
assert.match(envelopeVerifier, /candidate\.status !== 'committed'/,
  'only a committed envelope may cross the post-commit boundary');
for (const binding of [
  'scopeKey', 'worldlineId', 'memoryId', 'revision', 'sourceDigest',
  'artifactDigest', 'memoryKey'
]) assert.match(envelopeVerifier, new RegExp(`\\b${binding}\\b`), `commit verification lost ${binding}`);
assert.match(envelopeVerifier, /storage|read|getJson|memoryKey/i,
  'the state pipeline must reread the committed canonical record');
assert.match(envelopeVerifier, /manifest|active/i,
  'the state pipeline must verify the active manifest reference');

const orchestrator = between('const runStateTrackingAfterCommit = async', 'const processBatch = async');
const verifyOffset = orchestrator.indexOf('verifyCanonicalCommitEnvelope');
const localOffset=orchestrator.indexOf('runUnifiedStateAfterCommit');
assert.ok(verifyOffset>=0&&localOffset>verifyOffset,'canonical envelope must verify before local state');
assert.doesNotMatch(orchestrator.slice(0,orchestrator.indexOf('const persistStatePipelineSkipReceipt')),/callStateObserver|callStateVerifier|Promise\.allSettled/);
assert.match(orchestrator,/providerCalls:0|providerCalls: 0/);
assert.match(source,/STATE_PIPELINE_DOMAINS = Object\.freeze\(\['character', 'relationship', 'world', 'narrative'\]\)/);

const batch = between('const processBatch = async', 'const retryEmbeddingForMemory = async');
const committedReadbackOffset = Math.max(
  batch.indexOf('canonical_adoption_readback_failed'),
  batch.indexOf('memory.status = \'committed\''),
  batch.indexOf('status: \'committed\'')
);
const envelopeOffset = batch.indexOf('buildCanonicalCommitEnvelope');
const scheduleOffset = batch.indexOf('runStateTrackingAfterCommit');
assert.ok(committedReadbackOffset >= 0, 'canonical durable commit/readback gate is missing');
assert.ok(envelopeOffset > committedReadbackOffset,
  'the commit envelope must be built after durable canonical adoption/readback');
assert.ok(scheduleOffset > envelopeOffset,
  'state tracking must be scheduled from the verified commit envelope');
assert.match(batch.slice(scheduleOffset), /catch|stateTracking|warning|fail/i,
  'state failure must be recorded without converting the canonical commit to failure');

const adoption = between('const resolveCanonicalCandidate = async', 'const listCanonicalVariants = async');
assert.doesNotMatch(adoption, /stateReanalysisFailureBlocksAdoption|state-only reanalysis failure keeps the active manifest|상태 전용 재분석에 실패했습니다\. 활성 정본은 변경되지 않았습니다/,
  'derived-state failure must no longer block a valid canonical pointer adoption');
assert.doesNotMatch(adoption, /callContinuityDeltaProvider|callManualNarrativeDeltaProvider|rebuildMissingContinuityDelta/,
  'v3 adoption must not call a legacy state provider');
const replay = between('const replayDurableStateObservations = async', 'const rebuildStateFromCanonicalChainUnlocked = async');
assert.match(replay, /observation\?\.verification\?\.decisions/,
  'replay must reuse durable verifier decisions from the observation sidecar');
assert.match(replay, /applyVerifiedStateObservation[\s\S]*verifierDecisions:/);
assert.match(replay, /if \(reduced\.atomicRejected === true\)[\s\S]*return \{ ok: false, reason: `state_replay_partial:/,
  'integrity failures remain atomic during durable replay');
assert.match(replay, /status: 'replayed'[\s\S]*localFailClosedPatches:/,
  'locally rejected future-shaping fields do not block safe low-risk replay');
assert.doesNotMatch(replay, /callStateObserver|callStateVerifier|LibraProviderBridge\.callTask/,
  'a valid durable v3 sidecar replays without another provider call');

const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
(async()=>{const f=await fixture();try{const job=await f.run();assert.equal(job.completed,1);assert.equal(f.control.calls.length,1);assert.equal(f.getHead().status,'ready');
 const memory=f.getMemory(),before=JSON.stringify(memory.canonicalArtifact);const replay=await f.r.api.rebuildWorldManagerState();assert.equal(replay.ok,true,JSON.stringify(replay));assert.equal(f.control.calls.length,1);assert.equal(JSON.stringify(f.getMemory().canonicalArtifact),before);
 console.log('libra_post_commit_state_orchestrator_contract_test: PASS (envelope, local replay, readback and canonical independence)');}finally{await f.r.cleanup();}})().catch(e=>{console.error(e);process.exitCode=1;});
