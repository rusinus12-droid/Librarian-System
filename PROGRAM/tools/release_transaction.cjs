'use strict';

const RELEASE_SUBJECT = /^chore\(release\): v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseReleaseCommitSubject(subject) {
  const match = String(subject || '').trim().match(RELEASE_SUBJECT);
  if (!match) return null;
  return `v${match.slice(1).join('.')}`;
}

function determineReleaseState({ headSubject, currentVersion, parentVersion }) {
  const releaseTag = parseReleaseCommitSubject(headSubject);
  if (!releaseTag) {
    return {
      phase: 'prepare',
      previousVersion: String(currentVersion).trim(),
      targetVersion: null,
      releaseTag: null
    };
  }

  const targetVersion = releaseTag.slice(1);
  if (String(currentVersion).trim() !== targetVersion) {
    throw new Error(`release_commit_version_mismatch:${targetVersion}:${currentVersion}`);
  }
  if (parentVersion != null && String(parentVersion).trim() === targetVersion) {
    throw new Error(`release_commit_parent_version_not_advanced:${targetVersion}`);
  }
  return {
    phase: 'resume',
    previousVersion: parentVersion == null ? null : String(parentVersion).trim(),
    targetVersion,
    releaseTag
  };
}

function classifyTag({ exists, actualSha, releaseCommitSha }) {
  if (!exists) return 'create';
  if (actualSha === releaseCommitSha) return 'reuse';
  throw new Error(`release_tag_points_to_unexpected_commit:${actualSha}:${releaseCommitSha}`);
}

function classifyRelease({ exists, tagName, expectedTag }) {
  if (!exists) return 'create';
  if (tagName === expectedTag) return 'reuse';
  throw new Error(`release_points_to_unexpected_tag:${tagName}:${expectedTag}`);
}

function verifyReleaseShaFence({ expectedSha, currentMainSha, stage = 'fence' }) {
  const expected = String(expectedSha || '').trim();
  const current = String(currentMainSha || '').trim();
  if (!expected) {
    throw new Error(`release_sha_fence_missing_expected:${stage}`);
  }
  if (!current) {
    throw new Error(`release_sha_fence_missing_current:${stage}`);
  }
  if (expected !== current) {
    const error = new Error(
      `main changed after compatibility validation.\n` +
      `validated: ${expected}\n` +
      `current main: ${current}\n` +
      `Re-run Manual Release against the current main commit.`
    );
    error.code = 'RELEASE_SHA_FENCE_MISMATCH';
    error.details = { expectedSha: expected, currentMainSha: current, stage };
    throw error;
  }
  return { ok: true, sha: expected, stage };
}

module.exports = {
  classifyRelease,
  classifyTag,
  determineReleaseState,
  parseReleaseCommitSubject,
  verifyReleaseShaFence
};
