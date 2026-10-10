'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const {
  assertSafeDataDir,
  dataInstanceIdForToken,
  parseArgs,
  validateServerIdentity
} = require('../tools/platform_launcher.cjs');
const { dataInstanceIdForToken: serverDataInstanceIdForToken } = require('../server/server.cjs');

const programDir = path.resolve(__dirname, '..');
const launcher = path.join(programDir, 'tools', 'platform_launcher.cjs');
const admin = path.join(programDir, 'server', 'admin.cjs');
const fixture = path.join(__dirname, 'fixtures', 'launcher_probe_server.cjs');

const runLauncher = (args, timeout = 5000) => spawnSync(process.execPath, ['--no-warnings', launcher, ...args], {
  cwd: programDir,
  encoding: 'utf8',
  timeout
});

async function startFixture(mode, dataInstanceId = '', capturePath = '') {
  const child = spawn(process.execPath, [fixture, mode, dataInstanceId, capturePath], {
    cwd: programDir,
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let line = '';
  child.stdout.setEncoding('utf8');
  while (!line.includes('\n')) {
    const [chunk] = await once(child.stdout, 'data');
    line += chunk;
  }
  const port = Number(line.trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(port) && port > 0, `fixture port unavailable: ${line}`);
  return { child, port };
}

function stopFixture(fixtureServer) {
  if (!fixtureServer?.child || fixtureServer.child.exitCode != null) return;
  try { fixtureServer.child.kill('SIGTERM'); } catch (_) {}
}

function configurePort(dataDir, port) {
  const configPath = path.join(dataDir, 'config', 'server-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.port = port;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function main() {
  assert.throws(() => parseArgs(['serve', '--data-dir']), /launcher_data_dir_value_required/);
  assert.throws(() => parseArgs(['serve', '--data-dir', '--unexpected']), /launcher_data_dir_value_required/);
  assert.throws(
    () => assertSafeDataDir('/storage/emulated/0/MemorySuite/DATA', { TERMUX_VERSION: '0.119' }, 'linux'),
    error => error?.code === 'ANDROID_SHARED_STORAGE_DATA_DIR_BLOCKED'
  );
  assert.throws(
    () => assertSafeDataDir('/sdcard/MemorySuite/DATA', {}, 'android'),
    error => error?.code === 'ANDROID_SHARED_STORAGE_DATA_DIR_BLOCKED'
  );
  assert.equal(
    assertSafeDataDir('/data/data/com.termux/files/home/MemorySuite/DATA', { PREFIX: '/data/data/com.termux/files/usr' }, 'linux'),
    '/data/data/com.termux/files/home/MemorySuite/DATA'
  );
  assert.equal(
    validateServerIdentity({ name: 'Memory Suite Data Server', protocol: { major: 1 } }, path.join(os.tmpdir(), 'missing-legacy-data')).name,
    'Memory Suite Data Server',
    'the renamed launcher accepts the legacy server identity during an in-place update'
  );

  const token = crypto.randomBytes(32).toString('base64url');
  assert.equal(dataInstanceIdForToken(token), serverDataInstanceIdForToken(token), 'legacy server and launcher retain compatible token identity during in-place updates');
  assert.doesNotMatch(dataInstanceIdForToken(token), new RegExp(token.slice(0, 8)), 'DATA identity must not expose token text');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-launcher-safety-'));
  const dataDir = path.join(tempRoot, 'DATA');
  let fixtureServer = null;
  try {
    const prepared = runLauncher(['prepare', '--data-dir', dataDir]);
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    fs.writeFileSync(path.join(dataDir, 'runtime-token.txt'), `${token}\n`, { encoding: 'utf8', mode: 0o600 });

    const capturePath = path.join(tempRoot, 'fake-server-requests.jsonl');
    fixtureServer = await startFixture('fake', '', capturePath);
    configurePort(dataDir, fixtureServer.port);
    const fakeStartedAt = Date.now();
    const fake = runLauncher(['background', '--data-dir', dataDir]);
    assert.notEqual(fake.status, 0, 'fake health server must be rejected');
    assert.match(`${fake.stderr}\n${fake.stdout}`, /server_identity_mismatch/);
    assert.ok(Date.now() - fakeStartedAt < 3000, 'fake health rejection must be immediate');
    const layoutBeforeFakeProbe = fs.readFileSync(path.join(dataDir, 'data-layout.json'));
    const failedStatus = runLauncher(['status', '--data-dir', dataDir]);
    assert.notEqual(failedStatus.status, 0);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'data-layout.json')), layoutBeforeFakeProbe, 'failed status must not mutate DATA layout');
    for (const command of ['stop', 'integrity']) {
      const rejectedAdmin = runLauncher([command, '--data-dir', dataDir]);
      assert.notEqual(rejectedAdmin.status, 0, `${command} must reject a non-Memory-Suite endpoint before authentication`);
      assert.match(`${rejectedAdmin.stderr}\n${rejectedAdmin.stdout}`, /server_identity_mismatch/);
    }
    const captured = fs.existsSync(capturePath)
      ? fs.readFileSync(capturePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      : [];
    assert.ok(captured.length >= 3, 'identity probes must reach the fake endpoint');
    assert.equal(captured.some(row => row.authorization), false, 'admin bearer token must never be sent before server identity verification');
    assert.equal(captured.some(row => row.url !== '/health'), false, 'rejected admin commands must stop at the health preflight');
    stopFixture(fixtureServer);
    fixtureServer = null;

    const otherToken = crypto.randomBytes(32).toString('base64url');
    fixtureServer = await startFixture('memory-suite', dataInstanceIdForToken(otherToken));
    configurePort(dataDir, fixtureServer.port);
    const otherData = runLauncher(['background', '--data-dir', dataDir]);
    assert.notEqual(otherData.status, 0, 'another DATA instance must be rejected');
    assert.match(`${otherData.stderr}\n${otherData.stdout}`, /server_data_instance_mismatch/);
    stopFixture(fixtureServer);
    fixtureServer = null;

    fixtureServer = await startFixture('hang');
    configurePort(dataDir, fixtureServer.port);
    const timeoutStartedAt = Date.now();
    const timedOut = spawnSync(process.execPath, [admin, 'stop', '--url', `http://127.0.0.1:${fixtureServer.port}`, '--data-dir', dataDir, '--timeout-ms', '250'], {
      cwd: programDir,
      encoding: 'utf8',
      timeout: 2500
    });
    assert.notEqual(timedOut.status, 0, 'hung admin request must fail');
    assert.match(`${timedOut.stderr}\n${timedOut.stdout}`, /timed out after 250ms/);
    assert.ok(Date.now() - timeoutStartedAt < 2000, 'admin timeout must be bounded');
    process.stdout.write('launcher_safety_regression_test: PASS\n');
  } finally {
    stopFixture(fixtureServer);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`launcher_safety_regression_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
