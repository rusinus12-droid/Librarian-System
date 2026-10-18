'use strict';
// Finite structural-checker controls only: all fixture text is parsed, never executed.
const assert = require('node:assert/strict');
const { checkLiaLocalComputeOwner } = require('./lia_local_compute_owner_contract.cjs');

function runControls() {
  const storage = `const MemorySuiteStorageBridge = createMemorySuiteStorageBridge({
    namespace: 'lia', pluginId: 'lia_persona_linker', storagePolicy: 'local_only',
    autoMigratePlugin: false, autoMigrateLocal: false
  });`;
  const compute = `const MemorySuiteLiaComputeBridge = createMemorySuiteComputeBridge({
    namespace: 'lia', pluginId: 'lia_persona_linker', defaultMode: 'local', backgroundProbe: false
  });`;
  const owner = (storageSource = storage, computeSource = '', extra = '') =>
    `(async () => { const PLUGIN_NAME = 'LIA'; ${storageSource}\n${computeSource}\n${extra}\n })();`;
  const replaceOnce = (source, before, after) => {
    assert.equal(source.split(before).length, 2, `unique control mutation: ${before}`);
    return source.replace(before, after);
  };
  assert.equal(checkLiaLocalComputeOwner(owner()), true, 'valid local owner factories');
  assert.equal(checkLiaLocalComputeOwner(owner(storage.replace('storagePolicy:', "'storagePolicy':"), '',
    `function embeddedSdk() { ${storage} ${compute} } // nested declarations are not the owner`)),
  true, 'quoted key and nested SDK do not displace the real owner');

  const controls = [
    ['wrong storage policy', owner(replaceOnce(storage, "'local_only'", "'server_only'")), /owner policy: MemorySuiteStorageBridge.storagePolicy/],
    ['missing storage policy', owner(replaceOnce(storage, "storagePolicy: 'local_only',", '')), /literal policy: MemorySuiteStorageBridge.storagePolicy/],
    ['automatic plugin migration', owner(replaceOnce(storage, 'autoMigratePlugin: false', 'autoMigratePlugin: true')), /owner policy: MemorySuiteStorageBridge.autoMigratePlugin/],
    ['automatic local migration', owner(replaceOnce(storage, 'autoMigrateLocal: false', 'autoMigrateLocal: true')), /owner policy: MemorySuiteStorageBridge.autoMigrateLocal/],
    ['missing migration flag', owner(replaceOnce(storage, ', autoMigrateLocal: false', '')), /literal policy: MemorySuiteStorageBridge.autoMigrateLocal/],
    ['wrong Storage owner namespace', owner(replaceOnce(storage, "namespace: 'lia'", "namespace: 'libra'")), /owner policy: MemorySuiteStorageBridge.namespace/],
    ['wrong Storage factory', owner(replaceOnce(storage, 'createMemorySuiteStorageBridge(', 'otherStorageFactory(')), /owner factory target: MemorySuiteStorageBridge/],
    ['missing Storage factory', owner(''), /direct owner binding: MemorySuiteStorageBridge/],
    ['renamed Storage binding', owner(replaceOnce(storage, 'const MemorySuiteStorageBridge', 'const OtherOwnerStorage')), /direct owner binding: MemorySuiteStorageBridge/],
    ['comment-only Storage evidence', owner(`/* ${storage} */`), /direct owner binding: MemorySuiteStorageBridge/],
    ['nested SDK Storage decoy', owner(`function embeddedSdk() { ${storage} }`), /direct owner binding: MemorySuiteStorageBridge/],
    ['correct comment cannot mask wrong policy', owner(replaceOnce(storage, "'local_only'", "'server_only'"), compute, `/* ${storage} */`), /owner policy: MemorySuiteStorageBridge.storagePolicy/],
    ['correct SDK factory cannot mask wrong owner', owner(replaceOnce(storage, "'local_only'", "'server_only'"), compute, `function embeddedSdk() { ${storage} }`), /owner policy: MemorySuiteStorageBridge.storagePolicy/],
    ['duplicate policy override', owner(replaceOnce(storage, "storagePolicy: 'local_only',", "storagePolicy: 'local_only', storagePolicy: 'server_only',")), /cannot override a key: MemorySuiteStorageBridge.storagePolicy/],
    ['spread policy override', owner(replaceOnce(storage, 'autoMigrateLocal: false', 'autoMigrateLocal: false, ...otherOptions')), /cannot use spreads, dynamic keys or accessors: MemorySuiteStorageBridge/],
    ['computed policy decoy', owner(replaceOnce(storage, 'storagePolicy:', '[storagePolicy]:')), /cannot use spreads, dynamic keys or accessors: MemorySuiteStorageBridge/],
    ['retired Compute bridge reintroduced', owner(storage, compute), /owns no retired Compute bridge: MemorySuiteLiaComputeBridge/],
    ['wrong owner IIFE identity', replaceOnce(owner(), "PLUGIN_NAME = 'LIA'", "PLUGIN_NAME = 'LIBRA'"), /LIA owner identity/],
    ['non-invoked owner decoy', `async function embeddedSdk() { const PLUGIN_NAME = 'LIA'; ${storage} ${compute} }`, /top-level async owner IIFE/]
  ];
  for (const [label, source, expected] of controls) {
    assert.throws(() => checkLiaLocalComputeOwner(source), error =>
      error.code === 'ERR_ASSERTION' && expected.test(error.message), label);
  }
  console.log(`LIA local Compute owner structural controls: PASS (2 positive, ${controls.length} negative)`);
}

module.exports = { runControls };
