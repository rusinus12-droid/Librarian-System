'use strict';

const assert = require('node:assert/strict');
const {
  classifyRelease,
  classifyTag,
  determineReleaseState,
  parseReleaseCommitSubject
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

process.stdout.write('release_transaction_test: PASS\n');
