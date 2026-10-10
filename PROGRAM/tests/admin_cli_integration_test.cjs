'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { readDataInstanceIdentity } = require('../server/core/data-instance-identity.cjs');

const adminPath = path.resolve(__dirname, '..', 'server', 'admin.cjs');
const expectedVersion = fs.readFileSync(path.resolve(__dirname, '..', 'VERSION.txt'), 'utf8').trim();

function runAdmin(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [adminPath, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-admin-test-'));
  const wrongDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-admin-wrong-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const status = await runAdmin(['status', '--url', baseUrl]);
    assert.equal(status.code, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.version, expectedVersion);
    assert.equal(statusPayload.dataIdentityContract, 'memory-suite.physical-data-identity.v1');
    assert.equal(statusPayload.dataInstanceId, readDataInstanceIdentity(dataDir).dataInstanceId);

    const clients = await runAdmin(['clients', '--url', baseUrl, '--data-dir', dataDir]);
    assert.equal(clients.code, 0, clients.stderr);
    assert.ok(Array.isArray(JSON.parse(clients.stdout)));

    const integrity = await runAdmin(['integrity', '--url', baseUrl, '--data-dir', dataDir]);
    assert.equal(integrity.code, 0, integrity.stderr);
    assert.equal(JSON.parse(integrity.stdout).ok, true);

    const backup = await runAdmin(['backup', 'admin-cli', '--url', baseUrl, '--data-dir', dataDir]);
    assert.equal(backup.code, 0, backup.stderr);
    const backupId = JSON.parse(backup.stdout).id;
    assert.ok(backupId);
    const scrub = await runAdmin(['scrub', backupId, '--url', baseUrl, '--data-dir', dataDir]);
    assert.equal(scrub.code, 0, scrub.stderr);
    assert.equal(JSON.parse(scrub.stdout).ok, true);
    const plan = await runAdmin(['restore-plan', backupId, 'libra', '--url', baseUrl, '--data-dir', dataDir]);
    assert.equal(plan.code, 0, plan.stderr);
    assert.deepEqual(JSON.parse(plan.stdout).namespaces, ['libra']);

    const denied = await runAdmin(['clients', '--url', baseUrl, '--data-dir', wrongDataDir]);
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /admin token is unavailable/i);

    process.stdout.write('admin_cli_integration_test: PASS\n');
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(wrongDataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`admin_cli_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
