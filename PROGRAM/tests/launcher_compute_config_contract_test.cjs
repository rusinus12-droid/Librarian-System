'use strict';
// Server Compute is retired. Existing user DATA configs and older launchers may still carry
// computeEnabled/computeWorkers or pass --no-compute/--compute-workers: every value must be
// accepted and ignored, startup must succeed, and /v1/compute/* must answer 410.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer, parseArgs: parseServerArgs } = require('../server/server.cjs');
const { ensureConfig } = require('../tools/prepare_data.cjs');
const { readConfig, serverArguments } = require('../tools/platform_launcher.cjs');

const writeConfig = (dataDir, value) => {
  const configPath = path.join(dataDir, 'config', 'server-config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return configPath;
};
const baseConfig = overrides => ({ schema: 'memory-suite.server-config.v1', host: '127.0.0.1', port: 47630, autoBackup: true, ...overrides });
const legacyValues = [
  {}, { computeEnabled: true, computeWorkers: 0 }, { computeEnabled: false, computeWorkers: 4 },
  { computeEnabled: 'false', computeWorkers: 99 }, { computeEnabled: null, computeWorkers: -1 }, { computeWorkers: 'x' }
];

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-compute-retired-'));
  try {
    let index = 0;
    for (const legacy of legacyValues) {
      const dataDir = path.join(root, `data-${index += 1}`);
      const configPath = writeConfig(dataDir, baseConfig(legacy));
      const prepared = ensureConfig(dataDir);
      assert.equal(prepared.created, false, 'an existing config is kept');
      const config = readConfig(dataDir);
      assert.equal(Object.hasOwn(config, 'computeEnabled') || Object.hasOwn(config, 'computeWorkers'), false, 'launcher ignores retired keys');
      const args = serverArguments(config, dataDir);
      assert.equal(args.some(arg => /^--(?:no-)?compute/.test(String(arg))), false, 'launcher passes no Compute flag');
      const parsed = parseServerArgs([...args.slice(2), '--no-compute', '--compute-workers', '0']);
      assert.equal(Object.hasOwn(parsed, 'computeWorkers'), false, 'legacy Compute flags are accepted and ignored');
      const app = createMemorySuiteServer({ ...parsed, host: '127.0.0.1', port: 0 });
      const address = await app.listen();
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/compute/bootstrap`, { method: 'POST',
          headers: { 'X-Memory-Suite-Plugin': 'libra', 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 410);
        assert.equal((await response.json()).code, 'COMPUTE_RETIRED');
        assert.equal(fs.existsSync(path.join(dataDir, 'config', 'compute-signing-key.txt')), false, 'no Compute signing key is created');
      } finally { await app.close(); }
      assert.ok(fs.existsSync(configPath));
    }
    console.log(JSON.stringify({ test: 'launcher_compute_config_contract', legacyConfigs: legacyValues.length, computeRetired: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
