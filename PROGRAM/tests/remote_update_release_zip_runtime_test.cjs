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
const { assertPristineDistributionData } = require('../tools/runtime_release_validation.cjs');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function snapshotDataTree(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) return [];
  const rows = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        rows.push({
          path: path.relative(root, full).split(path.sep).join('/'),
          sha256: sha(full)
        });
      }
    }
  };
  walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

async function main() {
  const version = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim();
  const dataRoot = path.join(packageRoot, 'DATA');
  const dataLayout = path.join(dataRoot, 'data-layout.json');
  const hadSourceDataLayout = fs.existsSync(dataLayout);
  const beforeDataLayout = hadSourceDataLayout ? sha(dataLayout) : null;
  const beforeDataSnapshot = snapshotDataTree(dataRoot);
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
    const candidateDataDir = path.join(receipt.candidateRoot, 'DATA');
    assertPristineDistributionData(candidateDataDir);
    const candidateLayout = JSON.parse(fs.readFileSync(path.join(candidateDataDir, 'data-layout.json'), 'utf8'));
    assert.equal(candidateLayout.lastProgramVersion, version, 'release DATA/data-layout.json must be freshly generated for the release version');
    assert.equal(Object.hasOwn(candidateLayout, 'lastOpenedAt'), false, 'release DATA/data-layout.json must not include runtime open timestamps');

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
    assert.equal(fs.existsSync(dataLayout), hadSourceDataLayout, 'release build must not create or delete source/user DATA/data-layout.json');
    if (hadSourceDataLayout) {
      assert.equal(sha(dataLayout), beforeDataLayout, 'release build and candidate preparation must not mutate active DATA/data-layout.json');
    }
    assert.deepEqual(snapshotDataTree(dataRoot), beforeDataSnapshot, 'release build and candidate preparation must not mutate any source/user DATA file');
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
