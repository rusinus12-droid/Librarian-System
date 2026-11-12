'use strict';

const assert = require('node:assert/strict');
const {
  classifyRelease,
  classifyTag,
  determineReleaseState,
  parseReleaseCommitSubject,
  resolveReleaseTarget,
  verifyReleaseShaFence
} = require('../tools/release_transaction.cjs');

assert.equal(parseReleaseCommitSubject('chore(release): v0.5.2'), 'v0.5.2');
assert.equal(parseReleaseCommitSubject('feat: unrelated'), null);

assert.deepEqual(determineReleaseState({
  headSubject: 'feat: prepare next release',
  currentVersion: '0.5.1'
}), {
  phase: 'prepare',
  previousVersion: '0.5.1',
  targetVersion: null,
  releaseTag: null
});

assert.deepEqual(determineReleaseState({
  headSubject: 'chore(release): v0.5.2',
  currentVersion: '0.5.2',
  parentVersion: '0.5.1'
}), {
  phase: 'resume',
  previousVersion: '0.5.1',
  targetVersion: '0.5.2',
  releaseTag: 'v0.5.2'
});

assert.throws(() => determineReleaseState({
  headSubject: 'chore(release): v0.5.2',
  currentVersion: '0.5.1',
  parentVersion: '0.5.0'
}), /release_commit_version_mismatch/);
assert.throws(() => determineReleaseState({
  headSubject: 'chore(release): v0.5.2',
  currentVersion: '0.5.2',
  parentVersion: '0.5.2'
}), /release_commit_parent_version_not_advanced/);

assert.equal(classifyTag({ exists: false, actualSha: null, releaseCommitSha: 'abc' }), 'create');
assert.equal(classifyTag({ exists: true, actualSha: 'abc', releaseCommitSha: 'abc' }), 'reuse');
assert.throws(() => classifyTag({ exists: true, actualSha: 'def', releaseCommitSha: 'abc' }),
  /release_tag_points_to_unexpected_commit/);
assert.equal(classifyRelease({ exists: false, tagName: null, expectedTag: 'v0.5.2' }), 'create');
assert.equal(classifyRelease({ exists: true, tagName: 'v0.5.2', expectedTag: 'v0.5.2' }), 'reuse');

// Release SHA Fence Invariant (validated SHA == origin/main -> allowed, != -> blocked)
assert.deepEqual(
  verifyReleaseShaFence({ expectedSha: 'abc1234', currentMainSha: 'abc1234', stage: 'fence1' }),
  { ok: true, sha: 'abc1234', stage: 'fence1' }
);
assert.throws(
  () => verifyReleaseShaFence({ expectedSha: 'abc1234', currentMainSha: 'def5678', stage: 'fence1' }),
  err => err.code === 'RELEASE_SHA_FENCE_MISMATCH' && err.message.includes('main changed after compatibility validation.')
);
assert.throws(
  () => verifyReleaseShaFence({ expectedSha: 'abc1234', currentMainSha: 'def5678', stage: 'fence2' }),
  err => err.code === 'RELEASE_SHA_FENCE_MISMATCH' && err.message.includes('main changed after compatibility validation.')
);
assert.throws(
  () => verifyReleaseShaFence({ expectedSha: '', currentMainSha: 'abc1234' }),
  /release_sha_fence_missing_expected/
);
assert.throws(
  () => verifyReleaseShaFence({ expectedSha: 'abc1234', currentMainSha: '' }),
  /release_sha_fence_missing_current/
);

// Requested version: empty keeps the next patch; the source version publishes as-is; higher bumps.
const prepare = determineReleaseState({ headSubject: 'feat: work', currentVersion: '1.0.0' });
assert.deepEqual(resolveReleaseTarget({ state: prepare, currentVersion: '1.0.0' }),
  { phase: 'prepare', previousVersion: '1.0.0', targetVersion: '1.0.1', releaseTag: null });
assert.deepEqual(resolveReleaseTarget({ state: prepare, currentVersion: '1.0.0', requestedVersion: ' ' }),
  { phase: 'prepare', previousVersion: '1.0.0', targetVersion: '1.0.1', releaseTag: null });
assert.deepEqual(resolveReleaseTarget({ state: prepare, currentVersion: '1.0.0', requestedVersion: '1.0.0' }),
  { phase: 'current', previousVersion: '1.0.0', targetVersion: '1.0.0', releaseTag: null });
assert.deepEqual(resolveReleaseTarget({ state: prepare, currentVersion: '1.0.0', requestedVersion: 'v1.0.0' }).phase, 'current');
assert.deepEqual(resolveReleaseTarget({ state: prepare, currentVersion: '1.0.0', requestedVersion: '1.2.0' }),
  { phase: 'prepare', previousVersion: '1.0.0', targetVersion: '1.2.0', releaseTag: null });
assert.throws(() => resolveReleaseTarget({ state: prepare, currentVersion: '1.0.0', requestedVersion: '0.9.9' }),
  /release_requested_version_below_current:0\.9\.9:1\.0\.0/);
for (const bad of ['1.0', '1.0.0-rc1', '01.0.0', '1.0.0; rm -rf /', '$(id)'])
  assert.throws(() => resolveReleaseTarget({ state: prepare, currentVersion: '1.0.0', requestedVersion: bad }), /release_requested_version_invalid/);
// A release commit at HEAD decides the version; a matching request resumes, a different one is refused.
const resume = determineReleaseState({ headSubject: 'chore(release): v1.0.1', currentVersion: '1.0.1', parentVersion: '1.0.0' });
assert.deepEqual(resolveReleaseTarget({ state: resume, currentVersion: '1.0.1' }), resume);
assert.deepEqual(resolveReleaseTarget({ state: resume, currentVersion: '1.0.1', requestedVersion: '1.0.1' }), resume);
assert.throws(() => resolveReleaseTarget({ state: resume, currentVersion: '1.0.1', requestedVersion: '1.0.2' }),
  /release_requested_version_conflicts_with_release_commit:1\.0\.2:1\.0\.1/);

process.stdout.write('release_transaction_test: PASS\n');
