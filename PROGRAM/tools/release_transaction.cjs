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

function findReleaseCommitForEvent(commits, eventSha) {
  const expectedParent = String(eventSha || '').trim();
  if (!expectedParent) return null;
  const matches = commits.filter(commit =>
    Array.isArray(commit.parents) &&
    commit.parents[0] === expectedParent &&
    parseReleaseCommitSubject(commit.subject)
  );
  if (matches.length > 1) {
    throw new Error(`release_event_has_multiple_transactions:${expectedParent}`);
  }
  return matches[0] || null;
}

module.exports = {
  classifyRelease,
  classifyTag,
  determineReleaseState,
  findReleaseCommitForEvent,
  parseReleaseCommitSubject
};
