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

const occurrences = (text, needle) => {
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
};

// A committed Canonical memory schedules its derived-State work durably before
// the manifest pointer can make that memory visible as the active authority.
const batch = between('const processBatch = async', 'const retryEmbeddingForMemory = async');
const postCommit = between(
  'run.embedding = clone(memory.embedding);',
  '// Deprecated Story Arc clients receive a request-local projection'
);
const envelopeOffset = postCommit.indexOf('buildCanonicalCommitEnvelope');
const journalScheduleOffset = postCommit.indexOf('scheduleStateTrackingJournalEntry');
const manifestSaveOffset = postCommit.indexOf('await saveManifest(context.scope, manifest);');
assert.ok(envelopeOffset >= 0, 'the committed Canonical envelope must be built at the commit boundary');
assert.ok(journalScheduleOffset > envelopeOffset,
  'State tracking must be journaled from the sealed Canonical envelope');
assert.ok(manifestSaveOffset > journalScheduleOffset,
  'the State journal schedule/readback must complete before the active manifest pointer is saved');

const observerOffset = postCommit.indexOf('runStateTrackingAfterCommit');
const runningUpdateOffset = postCommit.indexOf('updateStateTrackingJournalEntry', manifestSaveOffset);
assert.ok(runningUpdateOffset > manifestSaveOffset && runningUpdateOffset < observerOffset,
  'the journal must enter running before any post-commit State provider work starts');
assert.match(postCommit.slice(runningUpdateOffset, observerOffset), /state:\s*'running'/,
  'the pre-provider journal transition must explicitly persist the running state');
assert.match(postCommit.slice(runningUpdateOffset, observerOffset), /attempts:[\s\S]*lastAttemptBootedAt:/,
  'a running transition must seal its attempt count and boot identity for duplicate-resume suppression');

const continuityCatchOffset = postCommit.indexOf('catch (continuityStateError)');
const firstFinishOffset = postCommit.indexOf('finishStateTrackingJournalAttempt', observerOffset);
assert.ok(firstFinishOffset > observerOffset && firstFinishOffset < continuityCatchOffset,
  'successful or partial State results must be durably finalized before leaving the primary attempt');
assert.ok(occurrences(postCommit, 'finishStateTrackingJournalAttempt') >= 2,
  'both the success path and the caught failure path must finalize the durable journal attempt');
const markerClearOffset = postCommit.indexOf('clearPendingBoundaryAfterCommit');
const caughtFinishOffset = postCommit.indexOf('finishStateTrackingJournalAttempt', continuityCatchOffset);
assert.ok(caughtFinishOffset > continuityCatchOffset && caughtFinishOffset < markerClearOffset,
  'a failed-open provider attempt must still persist a pending/completed journal outcome before marker cleanup');

const cleanup = postCommit.slice(postCommit.indexOf('await storage.remove(workKey);'), markerClearOffset);
assert.match(cleanup, /stateTrackingJournalEntry\?\.state\s*!==\s*'completed'/,
  'the pending live-boundary marker may only clear after a completed State journal readback');
assert.match(cleanup, /state_tracking_journal_pending/,
  'an incomplete State journal must retain the live-boundary marker for startup recovery');
assert.ok(batch.includes('scheduleStateTrackingJournalEntry') && batch.includes('finishStateTrackingJournalAttempt'),
  'processBatch must own both durable scheduling and durable attempt finalization');

// Startup recovery is durable, identity-bound, single-attempt-per-boot, and
// replays/rebuilds only after rereading the current Canonical/worldline boundary.
const journal = between(
  '/* LIBRA STATE TRACKING JOURNAL START */',
  '/* LIBRA STATE TRACKING JOURNAL END */'
);
for (const helper of [
  'stateTrackingEnvelopeProjection', 'stateTrackingJournalIdentity',
  'loadStateTrackingJournal', 'saveStateTrackingJournal',
  'scheduleStateTrackingJournalEntry', 'updateStateTrackingJournalEntry',
  'finishStateTrackingJournalAttempt', 'recoverPendingStateTrackingJournal'
]) assert.match(journal, new RegExp(`const ${helper} =`), `missing durable State journal helper: ${helper}`);
assert.match(journal, /\['scheduled', 'running', 'pending'\]\.includes\(entry\.state\)/,
  'startup recovery must resume every unfinished durable State state');
assert.match(journal, /lastAttemptBootedAt[\s\S]*Runtime\.bootedAt/,
  'startup recovery must suppress duplicate attempts within the same runtime boot');

const recovery = journal.slice(journal.indexOf('const recoverPendingStateTrackingJournal = async'));
const recoveryVerifyOffset = recovery.indexOf('verifyCanonicalCommitEnvelope');
const recoveryRebuildOffset = recovery.indexOf('rebuildCurrentStateForWorldlineUnlocked');
assert.ok(recoveryVerifyOffset >= 0 && recoveryRebuildOffset > recoveryVerifyOffset,
  'startup recovery must revalidate the Canonical identity before rebuilding derived State');
assert.match(recovery.slice(recoveryVerifyOffset, recoveryRebuildOffset), /activeWorldlineId[\s\S]*running\.envelope\.worldlineId/,
  'startup recovery must reject a journal entry from a stale logical worldline');
assert.match(recovery.slice(recoveryRebuildOffset), /requiredBoundaryFingerprint:\s*boundaryFingerprint/,
  'startup recovery rebuild must be sealed to the reread manifest/worldline boundary');
assert.match(journal, /storage\.setJson\(storageKey, next\)[\s\S]*storage\.getJson\(storageKey, null\)[\s\S]*digest\(readback\)\s*!==\s*digest\(next\)/,
  'journal writes require exact durable readback before the commit path can advance');

const startup = between(
  'const recoverPendingLiveBoundaryAtStartup = async',
  'const memoryRefSessionEpoch ='
);
const startupJournalOffset = startup.indexOf('recoverPendingStateTrackingJournal');
const startupMarkerLoadOffset = startup.indexOf('loadPendingBoundaryStore');
assert.ok(startupJournalOffset >= 0 && startupMarkerLoadOffset > startupJournalOffset,
  'startup must resume the State journal before deciding whether a live-boundary marker can clear');
assert.match(startup, /stateTrackingRecovery\?\.remaining[\s\S]*state_tracking_recovery_pending/,
  'a committed live-boundary marker must remain while any State journal entry is unfinished');

// Librarian replaces remote fan-out. The local applier still validates the basis before each authority write.
const dispatch=between('const runStateTrackingAfterCommit = async','const persistStatePipelineSkipReceipt = async');
assert.ok(dispatch.indexOf('verifyCanonicalCommitEnvelope')<dispatch.indexOf('runUnifiedStateAfterCommit'));
assert.doesNotMatch(dispatch,/callStateObserver|callStateVerifier|Promise\.allSettled/);
const apply=between('const runUnifiedStateAfterCommit = async','const processBatch = async');
assert.match(apply,/assertUnifiedBasis/);assert.match(apply,/validateUnifiedArtifact/);assert.match(apply,/sourceDigest\(batch\)===memory.sourceDigest/);
assert.match(apply,/await guard\(\)/);assert.match(apply,/UNIFIED_REGISTRY_READBACK/);assert.match(apply,/UNIFIED_HEAD_READBACK/);
console.log('LIBRA durable State reload gate contract test: PASS');
