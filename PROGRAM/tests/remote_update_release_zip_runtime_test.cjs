'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildDistribution } = require('../tools/build_distribution.cjs');
const { readZipEntries } = require('../tools/zip_writer.cjs');
const { prepareReleaseCandidate } = require('../../UPDATER/release_archive.cjs');
const { expectedAssetName } = require('../tools/release_asset_contract.cjs');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  const version = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim();
  const dataLayout = path.join(packageRoot, 'DATA', 'data-layout.json');
  const beforeData = sha(dataLayout);
  const beforeProgramVersion = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-release-updater-contract-'));
  try {
    const output = path.join(temp, 'release');
    const result = buildDistribution({ outputDir: output });
    assert.equal(path.basename(result.archivePath), expectedAssetName(version));
    assert.equal(result.report.artifact, expectedAssetName(version));
    assert.equal(result.report.releaseTag, `v${version}`);
    assert.equal(result.report.releaseAssetContract, 'librarian.update-manifest.v1');
    const entries = readZipEntries(result.archivePath).map(entry => entry.name);
    const prefix = `Librarian-System-${version}/`;
    for (const required of [
      'update-manifest.json',
      'SHA256SUMS.txt',
      'UPDATER/updater.cjs',
      '업데이트.bat',
      '업데이트.command',
      '업데이트.sh',
      'PROGRAM/VERSION.txt',
      'DATA/data-layout.json'
    ]) assert.ok(entries.includes(prefix + required), `release ZIP missing ${required}`);

    const candidateWork = path.join(temp, 'candidate-work');
    const receipt = await prepareReleaseCandidate({
      archivePath: result.archivePath,
      workRoot: candidateWork,
      targetVersion: version,
      currentVersion: version,
      expectedArchiveSha256: result.report.archiveSha256
    });
    assert.equal(receipt.targetVersion, version);
    assert.equal(receipt.asset, expectedAssetName(version));
    assert.equal(fs.readFileSync(path.join(candidateWork, 'PROGRAM.next', 'VERSION.txt'), 'utf8').trim(), version);
    // The invariant this assertion is named for is "the internal checksum covers
    // the full release" — that is, every file shipped in the ZIP is listed in
    // SHA256SUMS.txt. Assert exactly that instead of a magic file count.
    //
    // This used to read `receipt.verifiedFiles > 900`, which cannot hold for the
    // artifact this test builds: `buildDistribution` defaults to the RUNTIME
    // profile (line 29 above requires it — `releaseAssetContract` is only set for
    // non-source builds), and that profile deliberately ships ~129 files via the
    // explicit `shouldCopyRuntimeProgram` allowlist, which excludes PROGRAM/tests.
    // Only the separate `-Source.zip` profile includes the ~685 test files, so
    // `> 900` was unpassable here and was masked by an earlier failure in this
    // same test. The equality below is a stronger check: it fails if the checksum
    // omits any shipped file, and the count bound catches a truncated release.
    const shippedFiles = entries.filter(name => !name.endsWith('/')).length;
    assert.equal(receipt.verifiedFiles, shippedFiles - 1,
      'internal checksum must cover every shipped file except SHA256SUMS.txt itself');
    assert.ok(receipt.verifiedFiles > 100, 'release must ship a substantial file set, not a truncated archive');
    const internalManifest = JSON.parse(fs.readFileSync(path.join(receipt.candidateRoot, 'update-manifest.json'), 'utf8'));
    assert.equal(internalManifest.assetName, expectedAssetName(version));
    assert.equal(internalManifest.repository, 'rusinus12-droid/Librarian-System');
    await assert.rejects(
      () => prepareReleaseCandidate({ archivePath: result.archivePath, workRoot: path.join(temp, 'bad-digest'), targetVersion: version, currentVersion: version, expectedArchiveSha256: '0'.repeat(64) }),
      /outer_sha256_mismatch/
    );
    assert.equal(sha(dataLayout), beforeData, 'release build and candidate preparation must not mutate active DATA');
    assert.equal(fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8'), beforeProgramVersion, 'release build must not mutate active PROGRAM version');
    console.log('remote_update_release_zip_runtime_test: PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

main().catch(error => {
  console.error('remote_update_release_zip_runtime_test: FAIL');
  console.error(error.stack || error);
  process.exitCode = 1;
});
