'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemorySuiteServer } = require('../server/server.cjs');

const root = path.resolve(__dirname, '..');
const retrace = fs.readFileSync(path.join(root, 'plugins', 'RETRACE.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'server.cjs'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'server', 'admin.cjs'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'program-manifest.json'), 'utf8'));
const activeNamespaces = ['flashback', 'hayaku', 'libra', 'lia', 'retrace'];

assert.match(retrace, releasePattern("^\\/\\/@version {retrace}\\s*$", "m"), 'RE:TRACE GRADIA-free version');
assert.ok(retrace.includes("const ACTIVE_RETRACE_PEER_KEYS = Object.freeze(['flashback', 'hayaku', 'libra', 'lia']);"), 'RE:TRACE negotiates exactly the four active peers');
assert.ok(retrace.includes("const MEMORY_SUITE_SCOPE_NAMESPACES = Object.freeze(['flashback', 'hayaku', 'libra', 'lia', 'retrace']);"), 'RE:TRACE manages exactly five server namespaces');
for (const forbidden of [
  '//@allowed-ipc serial_gradation_agents_for_rp',
  'GRADIA_PLUGIN_ID', 'GRADIA_IPC_SCHEMA', 'requestGradiaIpc', 'probeGradiaIpc',
  'readGradiaSource', 'includeGradia', 'gradiaSessionHandoff', 'scopeManagerScanGradia',
  "namespace: 'gradia'", 'serial_gradation_agents_for_rp:peer:'
]) assert.ok(!retrace.includes(forbidden), `retired GRADIA active contract removed: ${forbidden}`);

assert.ok(server.includes("const NAMESPACES = Object.freeze(['flashback', 'hayaku', 'libra', 'lia', 'retrace']);"), 'server exposes exactly five namespaces');
assert.ok(!/namespace:\s*['\"]gradia['\"]/.test(server), 'server does not introduce a GRADIA owner namespace');
assert.ok(server.includes("roles: ['readonly']"), 'new GRADIA adapter is read-only and not a sixth owner');
assert.ok(!/\bgradia\b/i.test(admin), 'admin CLI has no GRADIA restore target');
assert.deepEqual(manifest.dataContract.namespaces, activeNamespaces, 'manifest declares only active namespaces');
assert.deepEqual(manifest.dataContract.serverConnectionGui.sidePanelOwners, activeNamespaces, 'manifest GUI owners are the five active namespaces');
assert.equal(Object.hasOwn(manifest.plugins || {}, 'gradia'), true, 'manifest packages the GRADIA reader without a sixth owner');
const manifestFilePaths = Array.isArray(manifest.files) ? manifest.files.map(item => String(item?.path || item || '')) : Object.keys(manifest.files || {});
assert.equal(manifestFilePaths.some(item => /plugins\/GRADIA\.js$/i.test(item)), true, 'manifest ships the canonical GRADIA plugin file');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-gradia-orphan-'));
  const orphanDir = path.join(dataDir, 'stores', 'gradia');
  const orphanFile = path.join(orphanDir, 'gradia.sqlite');
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(orphanFile, Buffer.from('ORPHAN_GRADIA_BYTES_MUST_REMAIN_UNTOUCHED\n'));
  const before = { hash: sha(orphanFile), size: fs.statSync(orphanFile).size };
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  try {
    const address = await app.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const bootstrapResponse = await fetch(`${base}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'libra', 'X-Memory-Suite-Plugin-Version': '1.0.98' } });
    assert.equal(bootstrapResponse.status, 200, 'active LIBRA bootstrap succeeds with orphan GRADIA file present');
    const bootstrap = await bootstrapResponse.json();
    assert.deepEqual(bootstrap.namespaces, activeNamespaces, 'bootstrap advertises only five active namespaces');
  } finally {
    await app.close();
  }
  assert.equal(fs.existsSync(orphanFile), true, 'pre-existing GRADIA orphan DB is not deleted');
  const after = { hash: sha(orphanFile), size: fs.statSync(orphanFile).size };
  assert.deepEqual(after, before, 'pre-existing GRADIA orphan DB is byte-stable');
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write('gradia_free_contract_test: PASS\n');
})().catch(error => {
  process.stderr.write(`gradia_free_contract_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
