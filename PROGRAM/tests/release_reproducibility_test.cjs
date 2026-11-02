'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const programDir = path.resolve(__dirname, '..');
const builder = path.join(programDir, 'tools', 'build_distribution.cjs');
const version = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim();
const qualification = process.env.LIBRARIAN_REPRODUCIBILITY_QUALIFICATION || 'offline_candidate';
const isOffline = qualification === 'offline_candidate';
const artifactBase = `Librarian-System-${version}${isOffline ? '-Offline-Candidate' : ''}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-release-reproducibility-'));
const env = {
  ...process.env,
  LIBRARIAN_RELEASE_BUILD_ID: 'release-reproducibility-test',
  LIBRARIAN_RELEASE_GENERATED_AT: '2026-11-02T00:00:00.000Z'
};

try {
  for (const suffix of ['a', 'b']) {
    const args = [
      builder, '--profile', 'release',
      '--qualification', qualification,
      '--check',
      '--output-dir', path.join(tempRoot, suffix)
    ];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 300000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  for (const name of [
    `${artifactBase}.zip`,
    `${artifactBase}.build-report.json`,
    `${artifactBase}.GITHUB_RELEASE_INFO.txt`
  ]) {
    assert.deepEqual(
      fs.readFileSync(path.join(tempRoot, 'a', name)),
      fs.readFileSync(path.join(tempRoot, 'b', name)),
      `${name} must be byte-identical across same-event rebuilds`
    );
  }
  process.stdout.write('release_reproducibility_test: PASS\n');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
