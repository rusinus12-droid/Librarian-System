'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const program = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(program, relative), 'utf8');
const storageSdk = read('sdk/MemorySuiteStorageClient.source.js');
const libraStorageSdk = read('sdk/MemorySuiteStorageClient.libra.source.js');
const computeSdk = read('sdk/MemorySuiteComputeClient.source.js');

for (const source of [storageSdk, libraStorageSdk]) {
  assert.match(source, releasePattern("^\\/\\* LIBRARIAN SYSTEM STORAGE SDK v{storage}", "m"));
  assert.match(source, /schema: 'memory-suite\.scope-execution-policy\.v1'/);
  assert.match(source, /configuredRoute: serverBacked \? 'server' : 'local'/);
  assert.match(source, /computeMode: serverBacked \? 'prefer_server' : 'local'/);
  assert.match(source, /lockedByStorageMode: true/);
  assert.match(source, /const getScopeExecutionPolicy = async/);
}

assert.match(computeSdk, /const VALID_MODES = new Set\(\[MODE_LOCAL, MODE_PREFER_SERVER\]\)/);
assert.doesNotMatch(computeSdk, /MODE_SHADOW|shadowMatches|shadowMismatches|onShadowComparison|mountSettingsPanel/);
assert.match(computeSdk, /modes: Object\.freeze\(\{ local: MODE_LOCAL, preferServer: MODE_PREFER_SERVER \}\)/);

// The Compute SDK is retired from the plugins: the Storage SDK still derives the scope
// execution policy above, but no plugin embeds the Compute SDK or mounts a Compute bridge.
const integrations = [
  ['plugins/Flashback_Memory.js', releaseVersion('flashback')],
  ['plugins/HAYAKU_Locator_Continuity.js', releaseVersion('hayaku')],
  ['plugins/LIBRA.js', releaseVersion('libra')],
  ['plugins/LIA_Persona_Linker.js', releaseVersion('lia')]
];
for (const [relative, version] of integrations) {
  const source = read(relative);
  const escapedVersion = version.replaceAll('.', '\\.');
  assert.match(source, new RegExp(`^\\/\\/@version ${escapedVersion}\\s*$`, 'm'));
  assert.doesNotMatch(source, /^\/\/@arg memory_suite_(?:flashback|hayaku|libra|lia)_compute_mode\b/m);
  assert.doesNotMatch(source, /LIBRARIAN SYSTEM COMPUTE SDK v|createMemorySuiteComputeBridge\(|\.mountSettingsPanel/, `${relative} embeds no Compute SDK`);
  assert.doesNotMatch(source, /computeBridge:\s*MemorySuite/, `${relative} mounts Storage without a Compute bridge`);
  if (relative === 'plugins/LIA_Persona_Linker.js') require('./fixtures/lia_local_compute_owner_contract.cjs').checkLiaLocalComputeOwner(source);
}

require('./fixtures/lia_local_compute_owner_contract_controls.cjs').runControls();

console.log('storage-compute integrated scope policy contract test: PASS');

