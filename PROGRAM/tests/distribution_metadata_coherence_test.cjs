'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readReleaseMetadata, renderGuide } = require('../tools/release_metadata.cjs');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const readProgram = relative => fs.readFileSync(path.join(programDir, ...relative.split('/')), 'utf8');
const readPackage = relative => fs.readFileSync(path.join(packageRoot, ...relative.split('/')), 'utf8');

const extractVersion = (source, pattern, label) => {
  const value = String(source || '').match(pattern)?.[1] || '';
  assert.match(value, /^\d+\.\d+\.\d+$/, `${label} version`);
  return value;
};

const extractConstant = (source, name) => {
  const match = String(source || '').match(new RegExp(`\\bconst\\s+${name}\\s*=\\s*['\"]([^'\"]+)['\"]\\s*;`));
  assert.ok(match, `${name} constant`);
  return match[1];
};

function main() {
  const manifest = JSON.parse(readProgram('program-manifest.json'));
  const pluginFiles = {
    flashback: 'Flashback_Memory.js',
    hayaku: 'HAYAKU_Locator_Continuity.js',
    libra: 'LIBRA.js',
    lia: 'LIA_Persona_Linker.js',
    retrace: 'RETRACE.js',
    gradia: 'GRADIA.js'
  };
  const pluginSources = Object.fromEntries(Object.entries(pluginFiles).map(([owner, file]) => [owner, readProgram(`plugins/${file}`)]));
  const pluginVersions = Object.fromEntries(Object.entries(pluginSources).map(([owner, source]) => {
    const header = source.slice(0, 512);
    assert.ok(header.includes('//@version '), `${owner} version is inside the first 512 bytes`);
    return [owner, extractVersion(header, /^\/\/@version\s+(\d+\.\d+\.\d+)\s*$/m, owner)];
  }));
  assert.deepEqual(manifest.plugins, pluginVersions, 'manifest plugin versions match canonical headers');
  for (const [owner, source] of Object.entries(pluginSources)) {
    const declarations = [...source.matchAll(/^\/\/@arg\s+(\S+)\s+(\S+)/gm)];
    assert.ok(declarations.length > 0, `${owner} declares plugin arguments`);
    for (const [, argumentName, argumentType] of declarations) {
      assert.ok(['string', 'int'].includes(argumentType), `${owner} ${argumentName} uses a RisuAI-compatible argument type: ${argumentType}`);
    }
  }

  const storageSdkVersion = extractVersion(readProgram('sdk/MemorySuiteStorageClient.source.js'), /^\/\* LIBRARIAN SYSTEM STORAGE SDK v(\d+\.\d+\.\d+)/m, 'Storage SDK');
  const libraStorageSdkVersion = extractVersion(readProgram('sdk/MemorySuiteStorageClient.libra.source.js'), /^\/\* LIBRARIAN SYSTEM STORAGE SDK v(\d+\.\d+\.\d+)/m, 'LIBRA Storage SDK');
  const computeSdkVersion = extractVersion(readProgram('sdk/MemorySuiteComputeClient.source.js'), /^\/\* LIBRARIAN SYSTEM COMPUTE SDK v(\d+\.\d+\.\d+)/m, 'Compute SDK');
  assert.equal(storageSdkVersion, libraStorageSdkVersion, 'Storage SDK variants share a version');
  assert.equal(manifest.storageSdkVersion, storageSdkVersion);
  assert.equal(manifest.dataContract.serverConnectionGui.sdk, storageSdkVersion);
  assert.equal(manifest.computeSdkVersion, computeSdkVersion);
  assert.deepEqual(manifest.computeProtocol, { major: 1, minor: 2 });

  const plane = manifest.dataContract.computePlane;
  // Compute is retired: the record says so; historical operation identities stay below.
  assert.equal(plane.retired, true);
  assert.equal(plane.execution, 'local_only');
  assert.equal(plane.pluginsEmbedCompute, false);
  assert.equal(plane.storageDerivesComputeMode, false);
  assert.equal(plane.serverRetired, true);
  assert.equal(plane.serverRetiredResponse.code, 'COMPUTE_RETIRED');
  assert.equal(plane.computeModeArgumentExposed, false);

  const pilots = {
    flashback: ['flashbackPilot', 'FLASHBACK_HASH_COMPUTE_OPERATION', 'FLASHBACK_HASH_COMPUTE_FINGERPRINT'],
    lia: ['liaWorldLorePilot', 'LIA_WORLD_LORE_COMPUTE_OPERATION', 'LIA_WORLD_LORE_COMPUTE_FINGERPRINT'],
    libra: ['libraRecallBm25fPilot', 'LIBRA_RECALL_BM25F_COMPUTE_OPERATION', 'LIBRA_RECALL_BM25F_COMPUTE_FINGERPRINT'],
    hayaku: ['hayakuSparseRrfPilot', 'HAYAKU_SPARSE_RRF_COMPUTE_OPERATION', 'HAYAKU_SPARSE_RRF_COMPUTE_FINGERPRINT']
  };
  for (const [owner, [manifestKey, operationName, fingerprintName]] of Object.entries(pilots)) {
    const pilot = plane[manifestKey];
    if (owner === 'flashback'
      && !new RegExp(`\\bconst\\s+${operationName}\\s*=`).test(pluginSources[owner])
      && !pluginSources[owner].includes('flashback.hash-embedding-batch.v1')) {
      assert.equal(Object.hasOwn(plane, manifestKey), false, 'model-only Flashback must not advertise a retired hash-vector pilot');
      continue;
    }
    assert.equal(pilot.version, pluginVersions[owner], `${owner} pilot version`);
    assert.equal(pilot.operation, extractConstant(pluginSources[owner], operationName), `${owner} pilot operation`);
    assert.equal(pilot.algorithmFingerprint, extractConstant(pluginSources[owner], fingerprintName), `${owner} pilot fingerprint`);
    assert.equal(Object.hasOwn(pilot, 'shadowAdopts'), false, `${owner} pilot has no retired shadow contract`);
  }

  const installGuide = readPackage('0_설치_안내.txt');
  const firstRead = readProgram('처음_읽어주세요.txt');
  const contents = readProgram('PACKAGE_CONTENTS.txt');
  const release = readReleaseMetadata(programDir);
  for (const source of [installGuide, firstRead, contents]) {
    assert.equal(source, renderGuide(source, release), 'installation inventory rows match current source; historical version mentions do not count');
  }
  for (const [owner, version] of Object.entries(pluginVersions)) {
    const label = owner === 'retrace' ? 'RE:TRACE' : owner === 'flashback' ? 'Flashback' : owner.toUpperCase();
    assert.ok([installGuide, firstRead, contents].every(source => source.includes(version)), `${label} current version appears in every distribution guide`);
  }
  for (const source of [installGuide, firstRead, contents]) {
    assert.ok(source.includes(storageSdkVersion), 'current Storage SDK appears in every distribution guide');
    assert.ok(source.includes(computeSdkVersion), 'current Compute SDK appears in every distribution guide');
    assert.doesNotMatch(source, /Shadow 비교|Compute 연산 모드를|Storage 모드와 Compute 모드는 서로 독립|memory_suite_(?:flashback|hayaku|libra|lia)_compute_mode를/);
  }
  assert.match(installGuide, /플러그인 단독.*로컬 연산/);
  assert.match(firstRead, /plugin_only.*기존 JS kernel/);
  assert.match(contents, /plugin_only → local.*server_only → prefer_server/);
  assert.match(contents, /mirror는 두 저장 위치 사이의 전환 단계/);

  process.stdout.write('distribution_metadata_coherence_test: PASS\n');
}

try { main(); }
catch (error) {
  process.stderr.write(`distribution_metadata_coherence_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
}
