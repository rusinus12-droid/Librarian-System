'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateProvenance } = require('../tools/plugin_version_provenance.cjs');
const { PLUGINS, readReleaseMetadata } = require('../tools/release_metadata.cjs');

const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json'), 'utf8'));
const metadata = readReleaseMetadata(root);
const actual = { profile: 'source', packageVersion: metadata.packageVersion, plugins: {} };
for (const [owner, [file]] of Object.entries(PLUGINS)) {
  const bytes = fs.readFileSync(path.join(root, 'plugins', file));
  const source = bytes.toString('utf8');
  const versions = [...source.matchAll(/^\s*const PLUGIN_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]\s*;/gm)];
  assert.equal(versions.length, 1, `${owner}: internal PLUGIN_VERSION count`);
  assert.equal(versions[0][1], metadata.plugins[owner].version, `${owner}: internal and header versions agree`);
  const displayVersion = bytes.subarray(0, 512).toString('utf8').match(/^\/\/@display-name[^\r\n]*?\bv(\d+\.\d+\.\d+)\b/m)?.[1];
  if (displayVersion) assert.equal(displayVersion, metadata.plugins[owner].version, `${owner}: versioned display name agrees`);
  actual.plugins[owner] = {
    version: metadata.plugins[owner].version,
    sha256: metadata.plugins[owner].sha256,
    bytes: bytes.length,
    file
  };
}
const errors = validateProvenance(catalog, actual);
assert.deepEqual(errors, [], `current release provenance is complete and collision-safe: ${JSON.stringify(errors)}`);
console.log(JSON.stringify({
  test: 'plugin_version_byte_provenance',
  passed: Object.keys(actual.plugins).length * 2 + 1,
  packageVersion: actual.packageVersion,
  currentPlugins: Object.keys(actual.plugins).length,
  historicalAnomalies: catalog.historicalAnomalies.length
}));
