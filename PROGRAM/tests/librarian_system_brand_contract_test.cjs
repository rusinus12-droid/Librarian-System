'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readReleaseMetadata } = require('../tools/release_metadata.cjs');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const read = relative => fs.readFileSync(path.join(programDir, ...relative.split('/')), 'utf8');

function main() {
  const packageVersion = read('VERSION.txt').trim();
  assert.match(packageVersion, /^\d+\.\d+\.\d+$/);
  assert.match(read('server/server.cjs'), /const SERVER_NAME = 'Librarian System Data Server'/);
  assert.match(read('tools/platform_launcher.cjs'), /const SERVER_NAME = 'Librarian System Data Server'/);
  assert.match(read('tools/platform_launcher.cjs'), /LEGACY_SERVER_NAMES = new Set\(\['Memory Suite Data Server'\]\)/,
    'the previous wire identity remains accepted only as an update compatibility alias');
  assert.match(read('tools/build_distribution.cjs'), /Librarian-System-/);
  const release = readReleaseMetadata(programDir);
  const manifest = JSON.parse(read('program-manifest.json'));
  assert.equal(manifest.storageSdkVersion, release.storageSdkVersion);
  assert.equal(manifest.computeSdkVersion, release.computeSdkVersion);
  assert.deepEqual(manifest.plugins, Object.fromEntries(Object.entries(release.plugins).map(([owner, row]) => [owner, row.version])));
  const pluginVersions = new Map(Object.values(release.plugins).map(row => [row.file, row.version]));
  for (const [fileName, version] of pluginVersions) {
    const source = read(`plugins/${fileName}`);
    assert.match(source, new RegExp(`^//\\@version ${version.replace(/\./g, '\\.')}$`, 'm'));
    const publicHeader = source.slice(0, Math.min(source.length, 12000));
    assert.doesNotMatch(publicHeader, /Memory Suite|MEMORY SUITE/, `${fileName} public header must expose the Librarian System brand`);
    assert.match(source, /memory-suite|MEMORY_SUITE|MemorySuite/,
      `${fileName} must retain at least one legacy technical identifier for persisted compatibility`);
  }

  const escapedVersion = packageVersion.replace(/\./g, '\\.');
  assert.match(fs.readFileSync(path.join(packageRoot, '0_설치_안내.txt'), 'utf8'), new RegExp(`^Librarian System Server ${escapedVersion}`, 'm'));
  assert.match(read('PACKAGE_CONTENTS.txt'), new RegExp(`^Librarian System Server ${escapedVersion}`, 'm'));
  process.stdout.write('librarian_system_brand_contract_test: PASS\n');
}

try { main(); }
catch (error) {
  process.stderr.write(`librarian_system_brand_contract_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
}

