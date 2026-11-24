'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { refreshRootFilesFromCandidate } = require('../../UPDATER/core/updater-bootstrap.cjs');
const { copyIdentityAndEndpoint } = require('../../UPDATER/core/migration-required.cjs');
const { createMemorySuiteServer } = require('../server/server.cjs');
const buildDist = require('../tools/build_distribution.cjs');

const repoRoot = path.resolve(__dirname, '../..');

test('Stage 7 (#6): refreshRootFilesFromCandidate refreshes root files atomically after commit without stray files and skips missing/symlink candidates', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7-root-refresh-'));
  try {
    const candidateRoot = path.join(tmp, '.update', 'candidate-1.5.0');
    fs.mkdirSync(candidateRoot, { recursive: true });
    for (const name of ['update-manifest.json', 'SHA256SUMS.txt', '0_설치_안내.txt', '업데이트.sh', '업데이트.command', '업데이트.bat']) {
      fs.writeFileSync(path.join(tmp, name), `old-${name}`, 'utf8');
      fs.writeFileSync(path.join(candidateRoot, name), `new-${name}`, 'utf8');
    }

    const res = await refreshRootFilesFromCandidate(tmp, { candidateRoot, targetVersion: '1.5.0' });
    assert.ok(res.refreshed.includes('update-manifest.json'));
    assert.ok(res.refreshed.includes('SHA256SUMS.txt'));
    assert.ok(res.refreshed.includes('0_설치_안내.txt'));
    assert.ok(res.refreshed.includes('업데이트.sh'));
    assert.ok(res.refreshed.includes('업데이트.command'));
    assert.ok(res.refreshed.includes('업데이트.bat'), 'non-self target root refreshes 업데이트.bat');

    for (const name of ['update-manifest.json', 'SHA256SUMS.txt', '0_설치_안내.txt', '업데이트.sh', '업데이트.command', '업데이트.bat']) {
      assert.equal(fs.readFileSync(path.join(tmp, name), 'utf8'), `new-${name}`);
    }
    assert.deepEqual(
      fs.readdirSync(path.join(tmp, '.update')).filter(n => n.startsWith('.root-refresh-')),
      [],
      'no leftover temporary files in .update'
    );

    const skippedNoCandidate = await refreshRootFilesFromCandidate(tmp, {});
    assert.deepEqual(skippedNoCandidate.skipped, ['no_candidate_root']);

    const outsideRes = await refreshRootFilesFromCandidate(tmp, { candidateRoot: path.join(os.tmpdir(), 'outside') });
    assert.deepEqual(outsideRes.skipped, ['invalid_candidate_root']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 7 (#6): updater menu 2 and guides reflect minimumSourceVersion 1.0.0 instead of stale 0.3.51', () => {
  for (const rel of [
    '업데이트.bat',
    '업데이트.sh',
    '0_설치_안내.txt',
    'PROGRAM/처음_읽어주세요.txt',
    'PROGRAM/PACKAGE_CONTENTS.txt'
  ]) {
    const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.doesNotMatch(content, /0\.3\.51/, `${rel} must not contain stale 0.3.51 guidance`);
    assert.match(content, /1\.0\.0/, `${rel} must reference v1.0.0 minimumSourceVersion`);
  }
});

test('Stage 7 (#15): optional remote-admin-key.txt separates manager bootstrap from ordinary plugins while staying backwards-compatible', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7-admin-key-'));
  const dataA = path.join(tmp, 'DATA-split');
  const dataB = path.join(tmp, 'DATA-legacy');
  const dataMigrated = path.join(tmp, 'DATA-migrated');
  let srvA = null;
  let srvB = null;
  try {
    fs.mkdirSync(path.join(dataA, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dataA, 'runtime-token.txt'), `${crypto.randomBytes(32).toString('base64url')}\n`);
    const accessKey = crypto.randomBytes(32).toString('base64url');
    const adminKey = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(path.join(dataA, 'config', 'remote-access-key.txt'), `${accessKey}\n`);
    fs.writeFileSync(path.join(dataA, 'config', 'remote-admin-key.txt'), `${adminKey}\n`);

    srvA = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: dataA, autoBackup: false, computeEnabled: false, remoteAccess: true });
    const addrA = await srvA.listen();
    const baseUrlA = `http://127.0.0.1:${addrA.port}`;

    // 1. Ordinary plugin succeeds with remote-access-key, rejected with remote-admin-key
    const libraOk = await fetch(`${baseUrlA}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'libra', 'X-Memory-Suite-Access-Key': accessKey } });
    assert.equal(libraOk.status, 200);
    const libraBad = await fetch(`${baseUrlA}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'libra', 'X-Memory-Suite-Access-Key': adminKey } });
    assert.equal(libraBad.status, 403);

    // 2. Manager (flashback_hayaku_bridge) rejected with ordinary access key, succeeds with admin key
    const mgrDenied = await fetch(`${baseUrlA}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge', 'X-Memory-Suite-Access-Key': accessKey } });
    assert.equal(mgrDenied.status, 403);
    const mgrDeniedJson = await mgrDenied.json();
    assert.equal(mgrDeniedJson.error, 'remote_admin_key_required');

    const mgrOk = await fetch(`${baseUrlA}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge', 'X-Memory-Suite-Access-Key': adminKey } });
    assert.equal(mgrOk.status, 200);
    const mgrBoot = await mgrOk.json();
    assert.ok(mgrBoot.authorization.roles.includes('manager'));

    // 3. Peer reader / legacy reader (RE:TRACE single-key peer binding) accepts either key
    const peerAdmin = await fetch(`${baseUrlA}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge:peer:libra', 'X-Memory-Suite-Access-Key': adminKey } });
    assert.equal(peerAdmin.status, 200);
    const peerAccess = await fetch(`${baseUrlA}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge:peer:libra', 'X-Memory-Suite-Access-Key': accessKey } });
    assert.equal(peerAccess.status, 200);

    // 4. Migration copyIdentityAndEndpoint preserves remote-admin-key.txt
    fs.mkdirSync(dataMigrated, { recursive: true });
    await copyIdentityAndEndpoint(dataA, dataMigrated);
    assert.equal(fs.readFileSync(path.join(dataMigrated, 'config', 'remote-admin-key.txt'), 'utf8').trim(), adminKey);

    // 5. Backwards compatibility when remote-admin-key.txt is absent
    fs.mkdirSync(path.join(dataB, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dataB, 'runtime-token.txt'), `${crypto.randomBytes(32).toString('base64url')}\n`);
    fs.writeFileSync(path.join(dataB, 'config', 'remote-access-key.txt'), `${accessKey}\n`);
    srvB = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: dataB, autoBackup: false, computeEnabled: false, remoteAccess: true });
    const addrB = await srvB.listen();
    const mgrCompat = await fetch(`http://127.0.0.1:${addrB.port}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge', 'X-Memory-Suite-Access-Key': accessKey }
    });
    assert.equal(mgrCompat.status, 200);

    // 6. Close scripts and leak patterns are handled cleanly by build_distribution.cjs
    assert.equal(buildDist.shouldCopyProgram('서버_원격접속_닫기.bat'), true);
    assert.equal(buildDist.shouldCopyProgram('서버_원격접속_닫기.sh'), true);
    assert.equal(buildDist.shouldCopyRuntimeProgram('서버_원격접속_닫기.bat'), true);
    assert.equal(buildDist.shouldCopyRuntimeProgram('서버_원격접속_닫기.sh'), true);
    assert.equal(buildDist.shouldCopyProgram('remote-admin-key.txt'), false);
    assert.equal(buildDist.shouldCopyRuntimeProgram('config/remote-admin-key.txt'), false);
    assert.throws(() => buildDist.assertArchivePrivacy([{ name: 'Librarian/DATA/config/remote-admin-key.txt', mode: 0o600 }], 'Librarian'), /distribution_archive_private_data_detected/);
  } finally {
    if (srvA) await srvA.close().catch(() => {});
    if (srvB) await srvB.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 7 (#4): mode transfer uploads >4.5 MiB records via chunked transfer-set and round-trips while keeping interactive 4 MiB cap', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7-large-transfer-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeEnabled: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previousRisuai = globalThis.risuai;
  const scope = { scopeId: 'scope-large', scopeKey: 'scope-large', label: 'Large Record Scope' };
  let bridge = null;
  try {
    const modeArgs = new Map([
      ['memory_suite_server_mode', 'plugin_only'],
      ['memory_suite_server_url', baseUrl]
    ]);
    globalThis.risuai = {
      async getArgument(name) { return modeArgs.get(String(name || '')) || ''; },
      async setArgument(name, val) { modeArgs.set(String(name || ''), String(val ?? '')); return true; },
      async nativeFetch(url, init) { return await fetch(url, init); }
    };

    const sdkText = fs.readFileSync(path.join(repoRoot, 'PROGRAM', 'sdk', 'MemorySuiteStorageClient.libra.source.js'), 'utf8');
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();

    const largeText = 'Z'.repeat(4608 * 1024); // ~4.5 MiB (>4 MiB SDK cap & >4.25 MiB interactive POST /v1/kv/set body cap)
    const legacyMap = new Map([['suite:large:record', largeText]]);
    const store = {
      async getItem(k) { return legacyMap.has(String(k)) ? legacyMap.get(String(k)) : null; },
      async setItem(k, v) { legacyMap.set(String(k), v); return true; },
      async removeItem(k) { legacyMap.delete(String(k)); return true; },
      async keys() { return Array.from(legacyMap.keys()); }
    };

    bridge = createBridge({
      namespace: 'libra',
      pluginId: 'libra',
      pluginVersion: '3.2.0',
      pluginPrefixes: ['suite:large:'],
      interactiveSetValueBudgetBytes: 4 * 1024 * 1024,
      currentScopeProvider: async () => scope
    });
    const proxy = bridge.createPluginStorageProxy(store);
    const boot = await bridge.bootstrap();
    assert.equal(boot.capabilities['chunked-transfer-upload.v1'], true);

    // Mode switch plugin_only -> server_only uploads ~4.5 MiB via chunked transfer without hitting 413
    const toServer = await bridge.setMode('server_only');
    assert.equal(toServer.to, 'server_only');
    const storedOnServer = await bridge.serverGet('plugin', 'suite:large:record');
    assert.equal(storedOnServer.exists, true);
    assert.equal(storedOnServer.value.length, largeText.length);

    // Interactive proxy write >4 MiB in server_only mode must STILL fail fast
    await assert.rejects(
      () => proxy.setItem('suite:large:interactive-too-big', 'X'.repeat(4 * 1024 * 1024 + 1)),
      err => err && err.code === 'MEMORY_SUITE_INTERACTIVE_VALUE_TOO_LARGE'
    );

    // Round-trip server_only -> plugin_only restores the exact ~4.5 MiB record back to local storage
    legacyMap.delete('suite:large:record');
    const toPlugin = await bridge.setMode('plugin_only');
    assert.equal(toPlugin.to, 'plugin_only');
    assert.equal(legacyMap.get('suite:large:record'), largeText);
  } finally {
    try { await bridge?.dispose?.(); } catch (_) {}
    globalThis.risuai = previousRisuai;
    await app.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
