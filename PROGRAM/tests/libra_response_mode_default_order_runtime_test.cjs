'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const sourcePath = process.env.LIBRA_TEST_PLUGIN
  ? path.resolve(process.env.LIBRA_TEST_PLUGIN)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');
assert.match(source, /const DEFAULT_RESPONSE_INJECTION_MODE = 'classic';/);
assert.match(source, /const DEFAULT_LIBRA_RESPONSE_MODE = 'classic';/);

// Embedded Planner/SGA selectors were retired; exercise public mode normalization.
(async () => {
  const harness = await createLibraVmHarness();
  try {
    const api = harness.api;
  assert.equal(api.version, releaseVersion('libra'));
    const fresh = api.debugResolveResponseModeState({});
    assert.equal(fresh.responseFamily, 'libra');
    assert.equal(fresh.libraResponseMode, 'classic');
    assert.equal(fresh.injectionMode, 'classic');

    const explicitPlanner = api.debugResolveResponseModeState({ libraResponseMode: 'planner' });
    assert.equal(explicitPlanner.libraResponseMode, 'classic');
    assert.equal(explicitPlanner.injectionMode, 'classic');
    for(const obsolete of [{injection_mode:'sga'},{responseFamily:'gradia'},{injectionMode:'planner'}]) assert.deepEqual(JSON.parse(JSON.stringify(api.debugResolveResponseModeState(obsolete))),{responseFamily:'libra',libraResponseMode:'classic',injectionMode:'classic'});
  } finally {
    await harness.cleanup();
  }
  process.stdout.write('libra_response_mode_default_order_runtime_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_response_mode_default_order_runtime_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
