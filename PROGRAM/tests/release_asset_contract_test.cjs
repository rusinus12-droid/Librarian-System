'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  OFFICIAL_REPOSITORY,
  expectedAssetName,
  expectedTag,
  parseAssetVersion,
  readReleasePolicy,
  buildUpdateManifest,
  validateUpdateManifest
} = require('../tools/release_asset_contract.cjs');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const version = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim();
assert.equal(OFFICIAL_REPOSITORY, 'rusinus12-droid/Librarian-System');
assert.equal(expectedTag(version), `v${version}`);
assert.equal(expectedAssetName(version), `Librarian-System-${version}.zip`);
assert.equal(parseAssetVersion(`Librarian-System-${version}.zip`), version);
assert.equal(parseAssetVersion(`Librarian-System-${version}-timestamp.zip`), null);
const policy = readReleasePolicy(programDir);
assert.equal(policy.version, version);
assert.ok(['program_only', 'migration_required', 'manual_required'].includes(policy.updatePolicy));
const manifest = buildUpdateManifest(programDir);
assert.deepEqual(Object.keys(manifest.components).sort(), ['backend','computeSdk','flashback','gradia','hayaku','lia','libra','retrace','storageSdk'].sort());
assert.equal(Object.hasOwn(manifest.components, 'wm'), false);
assert.equal(manifest.repository, OFFICIAL_REPOSITORY);
assert.equal(manifest.version, version);
assert.equal(manifest.assetName, expectedAssetName(version));
assert.equal(manifest.updatePolicy, policy.updatePolicy);
assert.equal(manifest.compatibility.updaterContract, 1);
assert.equal(validateUpdateManifest(manifest, { expectedVersion: version, expectedAssetName: expectedAssetName(version), expectedChannel: 'stable' }).version, version);
assert.throws(() => validateUpdateManifest({ ...manifest, assetName: 'release.zip' }), /asset_name_mismatch/);
const rootManifestPath = path.join(packageRoot, 'update-manifest.json');
if (fs.existsSync(rootManifestPath)) {
  const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
  assert.equal(rootManifest.schema, manifest.schema);
  assert.equal(rootManifest.repository, manifest.repository);
  assert.equal(rootManifest.version, manifest.version, 'root update-manifest.json version matches VERSION.txt');
  assert.equal(rootManifest.tag, manifest.tag);
  assert.equal(rootManifest.assetName, manifest.assetName);
  assert.equal(rootManifest.updatePolicy, manifest.updatePolicy);
  assert.equal(rootManifest.minimumSourceVersion, manifest.minimumSourceVersion);
  assert.deepEqual(rootManifest.compatibility, manifest.compatibility);
  assert.deepEqual(rootManifest.components, manifest.components, 'root update-manifest.json component versions match current source');
}
console.log('release_asset_contract_test: PASS');
