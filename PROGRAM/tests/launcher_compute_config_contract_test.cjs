'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createMemorySuiteServer,parseArgs:parseServerArgs}=require('../server/server.cjs');
const os = require('node:os');
const path = require('node:path');

const programDir = path.resolve(__dirname, '..');
const { ensureConfig } = require('../tools/prepare_data.cjs');
const { readConfig, serverArguments } = require('../tools/platform_launcher.cjs');

const writeConfig = (dataDir, value) => {
  const configPath = path.join(dataDir, 'config', 'server-config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return configPath;
};

const baseConfig = overrides => ({
  schema: 'memory-suite.server-config.v1',
  host: '127.0.0.1',
  port: 47630,
  autoBackup: true,
  ...overrides
});

const assertConfigRejected = (dataDir, override, expected) => {
  const configPath = writeConfig(dataDir, baseConfig(override));
  const before = fs.readFileSync(configPath);
  assert.throws(() => ensureConfig(dataDir), expected, `prepare rejects ${JSON.stringify(override)}`);
  assert.deepEqual(fs.readFileSync(configPath), before, 'invalid config is rejected without rewrite');
  assert.throws(() => readConfig(dataDir), expected, `launcher rejects ${JSON.stringify(override)}`);
};

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-launcher-compute-'));
  const dataDir = path.join(tempRoot, 'DATA');
  try {
    const freshDataDir = path.join(tempRoot, 'FRESH_DATA');
    fs.mkdirSync(path.join(freshDataDir, 'config'), { recursive: true });
    const fresh = ensureConfig(freshDataDir);
    assert.equal(fresh.created, true);
    assert.equal(fresh.config.computeEnabled, true);
    assert.equal(fresh.config.computeWorkers, 0);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(fresh.configPath, 'utf8')),
      fresh.config,
      'new configs persist both compute defaults'
    );

    const configPath = writeConfig(dataDir, baseConfig({ autoBackup: false, retainedExtension: 'preserved' }));
    const prepared = ensureConfig(dataDir);
    assert.equal(prepared.created, false);
    assert.equal(prepared.config.computeEnabled, true, 'existing configs default compute on');
    assert.equal(prepared.config.computeWorkers, 0, 'existing configs default to automatic worker count');
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(persisted.computeEnabled, true, 'default computeEnabled is durably merged');
    assert.equal(persisted.computeWorkers, 0, 'default computeWorkers is durably merged');
    assert.equal(persisted.retainedExtension, 'preserved', 'unknown forward-compatible settings are preserved');

    let loaded = readConfig(dataDir);
    assert.equal(loaded.computeEnabled, true);
    assert.equal(loaded.computeWorkers, 0);
    assert.deepEqual(
      serverArguments(loaded, dataDir).filter(value => value === '--no-compute' || value === '--compute-workers'),
      [],
      'default/automatic compute adds no server override flags'
    );

    writeConfig(dataDir, baseConfig({ computeEnabled: false, computeWorkers: 4 }));
    loaded = readConfig(dataDir);
    const disabledArgs = serverArguments(loaded, dataDir);
    assert.ok(disabledArgs.includes('--portable-settings-from-data'), 'child resolves persisted preferences after restore recovery');
    assert.ok(!disabledArgs.includes('--no-compute') && !disabledArgs.includes('--compute-workers'), 'launcher does not freeze recoverable settings into stale overrides');
    const child = createMemorySuiteServer(parseServerArgs(disabledArgs.slice(2)));
    try {
      assert.equal(child.computePlane.stats().configured, false, 'persisted computeEnabled false reaches the actual child factory');
      assert.equal(child.computePlane.stats().pool.size, 4, 'persisted worker count reaches the actual child factory');
    } finally { child.server.emit('close'); }

    writeConfig(dataDir, baseConfig({ computeEnabled: true, computeWorkers: 16 }));
    loaded = readConfig(dataDir);
    assert.equal(loaded.computeWorkers, 16, 'upper worker bound is accepted');
    assert.ok(!serverArguments(loaded, dataDir).includes('--no-compute'));

    for (const invalid of [null, 0, 1, 'true', 'false']) {
      assertConfigRejected(dataDir, { computeEnabled: invalid, computeWorkers: 0 }, /server_config_compute_enabled_must_be_boolean/);
    }
    for (const invalid of [null, '0', '4', -1, 17, 1.5, true]) {
      assertConfigRejected(dataDir, { computeEnabled: true, computeWorkers: invalid }, /server_config_compute_workers_must_be_integer_0_to_16/);
    }

    const commonLauncher = fs.readFileSync(path.join(programDir, 'memory-suite.sh'), 'utf8');
    assert.match(commonLauncher, /tools\/platform_launcher\.cjs" "\$@"/, 'macOS/Linux/Termux use the shared launcher');
    for (const name of ['1_서버_실행.sh', '서버_백그라운드_실행.sh']) {
      assert.match(fs.readFileSync(path.join(programDir, name), 'utf8'), /memory-suite\.sh/, `${name} delegates to the shared launcher`);
    }
    assert.match(fs.readFileSync(path.join(programDir, 'macOS_서버_실행.command'), 'utf8'), /1_서버_실행\.sh/, 'macOS entry delegates to the common POSIX path');
    assert.match(fs.readFileSync(path.join(programDir, '안드로이드_Termux_준비.sh'), 'utf8'), /platform_launcher\.cjs" prepare/, 'Termux preparation uses the shared launcher');
    for (const name of ['_server_foreground.cmd', '서버_백그라운드_실행.bat']) {
      assert.match(fs.readFileSync(path.join(programDir, name), 'utf8'), /tools\\platform_launcher\.cjs/, `${name} delegates to the shared launcher`);
    }

    process.stdout.write('launcher_compute_config_contract_test: PASS\n');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  process.stderr.write(`launcher_compute_config_contract_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
}
