'use strict';

// Drive callbacks registered by the unchanged plugin against a real DOM and an
// isolated real server. Exposed helpers only inspect state/read owner data;
// neither producer, backup, transport, nor restore implementation is replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
const { createMemorySuiteServer } = require('../server/server.cjs');

const ASSETS = 'liaPersonaVisualAssetStoreV1';
const VAULT = 'dynamicPersonaLorebookGeneratorResultVault';
const BLOBS = 'liaPersonaVisualAssetBlobV1::';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function markerPng(text) {
  const base = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const typeAndData = Buffer.concat([Buffer.from('tEXt'), Buffer.from(`Comment\0${text}`)]);
  let crc = 0xffffffff;
  for (const byte of typeAndData) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(typeAndData.length - 4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([base.subarray(0, -12), length, typeAndData, checksum, base.subarray(-12)]);
}
function fileAssets(directory) {
  fs.mkdirSync(directory);
  return {
    get size() { return fs.readdirSync(directory).length; },
    set(key, value) { assert.match(key, /^flow-image-\d+\.png$/); fs.writeFileSync(path.join(directory, key), value); },
    get(key) { assert.match(key, /^flow-image-\d+\.png$/); const file = path.join(directory, key); return fs.existsSync(file) ? fs.readFileSync(file) : null; },
    clear() { for (const key of fs.readdirSync(directory)) { assert.match(key, /^flow-image-\d+\.png$/); fs.unlinkSync(path.join(directory, key)); } }
  };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`timeout:${label}`);
}

const expose = source => source.replace('      getLiveSyncCaptureState:', `
      restoreFlowAudit: {
        bridge: MemorySuiteStorageBridge,
        readStoredResultVault, readPersonaVisualAssetStore,
        readPersonaVisualAssetBackup, ensurePersonaVisualAssetAvailable
      },
      getLiveSyncCaptureState:`);

async function createRealm(url, diskRows, hostAssets, options = {}) {
  const callbacks = {};
  const localRows = options.localRows || new Map();
  const args = { memory_suite_server_url: url, memory_suite_server_mode: '',
    enable_gui: 'true', live_sync_enabled: 'false', mode: 'off' };
  const modelCalls = [];
  const fixture = await createFixture('official', {
    snapshot: diskRows ? options.snapshot : undefined,
    transformSource: expose,
    configureApi(api, seed) {
      if (diskRows) { seed.values.clear(); for (const row of diskRows) seed.values.set(...row); }
      api.getArgument = async key => args[String(key)] ?? '';
      api.getArg = api.getArgument;
      api.setArgument = async (key, value) => { args[String(key)] = String(value); return true; };
      api.safeLocalStorage = {
        async getItem(key) { return localRows.get(String(key)) ?? null; },
        async setItem(key, value) { localRows.set(String(key), value); return true; },
        async removeItem(key) { localRows.delete(String(key)); return true; },
        async keys() { return [...localRows.keys()]; }
      };
      api.getLocalPluginStorage = async () => api.safeLocalStorage;
      api.nativeFetch = async (request, init) => fetch(request, init);
      api.registerSetting = async (_name, callback) => { callbacks.setting = callback; return { id: 'lia-setting' }; };
      api.registerButton = async (_descriptor, callback) => { callbacks.button = callback; return { id: 'lia-button' }; };
      api.saveAsset = async bytes => {
        const id = `flow-image-${hostAssets.size + 1}.png`;
        hostAssets.set(id, Buffer.from(bytes));
        // The real host can transfer/detach this buffer during IPC.
        structuredClone(bytes, { transfer: [bytes.buffer] });
        return `assets/${id}`;
      };
      api.readImage = async key => {
        const bytes = hostAssets.get(String(key).replace(/^assets\//, ''));
        if (!bytes) throw new Error('test_host_asset_missing');
        return new Uint8Array(bytes);
      };
      for (const name of ['llm', 'requestModel', 'generateImage', 'embed']) api[name] = async () => {
        modelCalls.push(name); throw new Error(`unexpected_model_call:${name}`);
      };
    }
  });
  const domErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    // CSS container-query parsing is not relevant to these event/storage checks.
    if (error.type !== 'css-parsing') domErrors.push(error.message);
  });
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/', virtualConsole });
  Object.assign(fixture.context, { document: dom.window.document, window: dom.window,
    navigator: { language: 'en-US' }, confirm: () => true });
  assert.equal(typeof callbacks.setting, 'function', 'actual settings callback was registered');
  assert.equal(typeof callbacks.button, 'function', 'actual menu callback was registered');
  const audit = fixture.runtime.restoreFlowAudit;
  assert.ok(audit, 'read-only owner audit hook installed');
  async function open() {
    await callbacks.setting();
    await waitFor(() => dom.window.document.getElementById('dpg-asset-manual-upload'), 'registered GUI rendered');
    return dom.window.document;
  }
  return { ...fixture, audit, callbacks, dom, domErrors, localRows, modelCalls, args, open,
    async close() { await fixture.dispose(); dom.window.close(); } };
}

async function manualUpload(env, bytes, expectedTone = 'ok') {
  const document = env.dom.window.document;
  const input = document.getElementById('dpg-asset-manual-upload');
  assert.ok(input, 'actual manual upload input exists');
  input.dataset.emotion = 'neutral';
  // The VM uses the Node Blob constructor, so its browser-file boundary must
  // receive that same Blob type rather than a duck-typed arrayBuffer object.
  const file = new Blob([bytes], { type: 'image/png' });
  Object.defineProperty(file, 'name', { value: 'marker.png' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new env.dom.window.Event('change', { bubbles: true }));
  await waitFor(() => !input.dataset.emotion, 'manual upload handler settled');
  const status = document.getElementById('dpg-status');
  assert.equal(status?.dataset?.tone, expectedTone, status?.textContent || 'upload status missing');
  return status.textContent;
}

async function serverPanel(env) {
  const document = env.dom.window.document;
  const tab = document.querySelector('[data-workspace-tab="server"]');
  assert.ok(tab, 'actual server route exists');
  tab.click();
  return await waitFor(() => {
    const container = document.getElementById('liaMemorySuiteServerConnectionPanel');
    return container?.querySelector('[data-restore]')?.onclick ? container : false;
  }, 'actual mounted server actions');
}

async function runPanelJob(env, selector, requestedMode) {
  const panel = await serverPanel(env);
  if (requestedMode) {
    const radio = panel.querySelector(`input[value="${requestedMode}"]`);
    assert.ok(radio, 'requested operational mode is offered');
    radio.checked = true;
    radio.dispatchEvent(new env.dom.window.Event('change', { bubbles: true }));
  }
  const button = panel.querySelector(selector);
  assert.equal(typeof button?.onclick, 'function', `mounted handler ${selector}`);
  await button.onclick();
  const job = await env.audit.bridge.waitForSyncJob('', 30000);
  assert.ok(job, 'actual job exists');
  await waitFor(() => panel.querySelector('[data-job-result]')?.textContent?.includes(
    job.status === 'completed' ? '완료 결과' : '실패 결과'), 'GUI terminal result');
  return { job, displayed: panel.querySelector('[data-job-result]').textContent };
}

function immutableRows(values, backupId) {
  return [...values].filter(([key]) => key.startsWith(`${BLOBS}${backupId}::`)).sort(([a], [b]) => a.localeCompare(b));
}
function assertRows(values, rows, label) {
  for (const [key, value] of rows) assert.equal(values.get(key), value, `${label}:${key}`);
}
function snapshot(env) {
  return structuredClone({ values: [...env.values], personas: env.db.personas,
    selectedPersona: env.db.selectedPersona, chat: env.liveChat });
}
function diskSnapshot(env, directory, label) {
  const file = path.join(directory, `${label}-mock-host-snapshot.json`);
  fs.writeFileSync(file, JSON.stringify({ snapshot: snapshot(env), localRows: [...env.localRows] }));
  // Recreate host storage from physical bytes, never retain a VM cache object.
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function physicalRows(filePath, expected) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const rows = database.prepare('SELECT space,key,value_json,deleted,revision FROM kv').all();
    const evidence = [];
    for (const [key, value] of expected) {
      const found = rows.filter(row => row.key === key && row.deleted === 0 && JSON.parse(row.value_json) === value);
      assert.equal(found.length, 1, `independent SQLite durable exact bytes:${key}`);
      evidence.push({ key, space: found[0].space, revision: found[0].revision,
        chars: value.length, sha256: sha(value) });
    }
    return evidence;
  } finally { database.close(); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-public-restore-flow-'));
  const hostAssets = fileAssets(path.join(dataDir, 'mock-host-assets'));
  const evidence = { schema: 'lia.public-asset-server-restore-flow.v1',
    hostBoundary: 'Windows Node VM + JSDOM registered callbacks; not native Risu/browser acceptance', cases: [] };
  const image = markerPng('LIA public producer preserved image marker '.repeat(12000));
  const replacement = markerPng('rejected replacement marker');
  const body = 'LIA public vault body marker: original persona draft survives server restore and realm restart.';
  let server, env;
  try {
    server = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
    let address = await server.listen();
    env = await createRealm(`http://127.0.0.1:${address.port}`, null, hostAssets);
    await env.open();
    const result = env.dom.window.document.getElementById('dpg-llm-result');
    assert.ok(result, 'actual generated-result editor exists');
    result.value = JSON.stringify({ personaName: 'Flow Marker Persona', personaPrompt: body });
    result.dispatchEvent(new env.dom.window.Event('input', { bubbles: true }));
    const vaultSave = env.dom.window.document.getElementById('dpg-vault-save');
    assert.ok(vaultSave, 'actual vault save action exists');
    vaultSave.click();
    await waitFor(() => env.values.get(VAULT)?.includes(body), 'public vault producer');
    await waitFor(() => !vaultSave.disabled, 'vault GUI settled');
    await manualUpload(env, image);
    const assetRaw = env.values.get(ASSETS);
    const vaultRaw = env.values.get(VAULT);
    const assetStore = JSON.parse(assetRaw);
    const [personaKey, bundle] = Object.entries(assetStore.sets).find(([, set]) => set.images?.neutral?.backupId);
    const entry = bundle.images.neutral;
    const priorBackup = immutableRows(env.values, entry.backupId);
    assert.ok(priorBackup.length >= 3, 'actual producer emitted multi-chunk immutable backup');
    assert.deepEqual(Buffer.from((await env.audit.readPersonaVisualAssetBackup(entry.backupId)).bytes), image);
    evidence.cases.push({ name: 'registered-GUI-producer', backupId: entry.backupId,
      backupRows: priorBackup.length, bytes: image.length, imageSha256: sha(image), vaultSha256: sha(vaultRaw) });

    const originalSet = env.api.pluginStorage.setItem;
    env.api.pluginStorage.setItem = async (key, value) => String(key).startsWith(BLOBS) && String(key).endsWith('::manifest')
      ? true : originalSet(key, value);
    await manualUpload(env, replacement, 'error');
    env.api.pluginStorage.setItem = originalSet;
    assert.equal(env.values.get(ASSETS), assetRaw, 'failed public upload preserved exact asset metadata');
    assert.equal(env.values.get(VAULT), vaultRaw, 'failed upload preserved independent body');
    assertRows(env.values, priorBackup, 'failed upload preserved immutable history');
    assert.equal([...env.values.keys()].filter(key => key.startsWith(BLOBS)).length, priorBackup.length,
      'failed new backup rolled back its partial chunks');
    evidence.cases.push({ name: 'public-upload-dropped-manifest', displayedError: true,
      originalMetadataUnchanged: true, immutableHistoryUnchanged: true, partialChunksRemoved: true });

    const transition = await runPanelJob(env, '[data-apply]', 'server_only');
    assert.equal(transition.job.status, 'completed', transition.job.error || transition.displayed);
    assert.equal(await env.audit.bridge.getMode(), 'server_only');
    const durable = [[ASSETS, assetRaw], [VAULT, vaultRaw], ...priorBackup];
    const dbPath = server.repositories.lia.filePath;
    server.repositories.lia.checkpoint();
    evidence.sqliteBeforeRestart = physicalRows(dbPath, durable);
    const { snapshot: restartSnapshot, localRows: persistedLocalRows } = diskSnapshot(env, dataDir, 'before-server-restart');
    assert.equal(env.modelCalls.length, 0, 'producer realm never called a model');
    assert.deepEqual(env.domErrors, [], 'producer GUI had no DOM/runtime errors');
    await env.close(); env = null;
    await server.close(); server = null;
    evidence.sqliteAfterServerClose = physicalRows(dbPath, durable);

    server = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
    address = await server.listen();
    const missingPayload = restartSnapshot.values.filter(([key]) => !key.startsWith(`${BLOBS}${entry.backupId}::`));
    env = await createRealm(`http://127.0.0.1:${address.port}`, missingPayload, hostAssets,
      { snapshot: restartSnapshot, localRows: new Map(persistedLocalRows) });
    assert.equal(await env.audit.bridge.getMode(), 'server_only', 'fresh realm retained server authority');
    await env.open();
    // A physically dropped host write must reject the public restore job, roll
    // every prior row back, and leave server authority/immutable history intact.
    const beforeFailure = new Map(durable.map(([key]) => [key, env.values.get(key)]));
    assert.equal(beforeFailure.get(ASSETS), assetRaw, 'original local metadata exists before failed restore');
    assert.equal(beforeFailure.get(VAULT), vaultRaw, 'original local body exists before failed restore');
    env.api.pluginStorage.setItem = async (key, value) => {
      if (key === priorBackup[0][0]) return true;
      env.values.set(String(key), value); return true;
    };
    const failed = await runPanelJob(env, '[data-restore]');
    assert.equal(failed.job.status, 'failed', 'dropped physical restore write is visible as failure');
    assert.equal(await env.audit.bridge.getMode(), 'server_only');
    for (const [key, value] of beforeFailure) assert.equal(env.values.get(key), value, `restore rollback:${key}`);
    assert.deepEqual(physicalRows(dbPath, durable), evidence.sqliteBeforeRestart, 'failure did not mutate authoritative server rows');
    evidence.cases.push({ name: 'public-restore-dropped-write', displayedFailure: true,
      localRollbackVerified: true, serverAuthorityRetained: true, serverRowsUnchanged: true });

    env.api.pluginStorage.setItem = async (key, value) => { env.values.set(String(key), value); return true; };
    const restored = await runPanelJob(env, '[data-restore]');
    assert.equal(restored.job.status, 'completed', restored.job.error || restored.displayed);
    assertRows(env.values, durable, 'public restore exact local physical rows');
    assert.equal(await env.audit.bridge.getRecoveryState(await env.audit.bridge.getCurrentScope()), null,
      'verified retry cleared durable recovery lock');
    const pluginOnly = await runPanelJob(env, '[data-apply]', 'plugin_only');
    assert.equal(pluginOnly.job.status, 'completed', pluginOnly.job.error || pluginOnly.displayed);
    assert.equal(await env.audit.bridge.getMode(), 'plugin_only');
    const { snapshot: restoredSnapshot, localRows: persistedRestoredLocalRows } = diskSnapshot(env, dataDir, 'after-public-restore');
    assert.equal(env.modelCalls.length, 0, 'transport/restore realm never called a model');
    assert.deepEqual(env.domErrors, [], 'transport/restore GUI had no DOM/runtime errors');
    await env.close(); env = null;
    // Fresh runtime has no asset cache and the native host files are missing.
    hostAssets.clear();
    env = await createRealm(`http://127.0.0.1:${address.port}`, restoredSnapshot.values, hostAssets,
      { snapshot: restoredSnapshot, localRows: new Map(persistedRestoredLocalRows) });
    const reloadedVault = await env.audit.readStoredResultVault();
    assert.ok(reloadedVault.some(item => item.personaPrompt === body), 'fresh owner reader returned actual vault body');
    const reloadedAssets = await env.audit.readPersonaVisualAssetStore();
    const reloadedEntry = reloadedAssets.sets[personaKey].images.neutral;
    const available = await env.audit.ensurePersonaVisualAssetAvailable(reloadedEntry, { personaKey, emotion: 'neutral' });
    assert.equal(available.restored, true, 'fresh owner recovered missing native image from immutable backup');
    assert.deepEqual(Buffer.from(available.bytes), image, 'fresh owner restored exact original image bytes');
    assertRows(env.values, priorBackup, 'owner asset recovery left immutable backup unchanged');
    await env.open();
    const document = env.dom.window.document;
    const vaultTab = document.querySelector('[data-pocket-tab="vault"]');
    assert.ok(vaultTab, 'fresh registered GUI offers the vault route');
    vaultTab.click();
    assert.equal(document.querySelector('.lia-app-layout').dataset.page, 'vault', 'registered navigation selected vault');
    const vaultPanel = document.getElementById('dpg-vault-panel');
    assert.ok(vaultPanel.classList.contains('active'), 'restored vault panel is active');
    assert.ok(vaultPanel.textContent.includes('Flow Marker Persona'), 'fresh registered GUI shows restored vault card');
    const reloadedMetadata = JSON.parse(env.values.get(ASSETS)).sets[personaKey].images.neutral;
    assert.equal(reloadedMetadata.backupId, entry.backupId, 'recovery retained immutable backup reference');
    assert.deepEqual(hostAssets.get(reloadedMetadata.assetPath.replace(/^assets\//, '')), image,
      'native host restored asset exact physical bytes');
    assert.equal(env.modelCalls.length, 0, 'no model API was called');
    assert.deepEqual(env.domErrors, [], 'registered GUI had no DOM/runtime errors');
    evidence.cases.push({ name: 'public-restore-retry-and-fresh-reader', restoredRows: durable.length,
      ownerBodyExact: true, ownerImageExact: true, nativeAssetRebuilt: true,
      immutableHistoryUnchanged: true, registeredGuiRestoredVaultVisible: true, modelCalls: 0 });
    evidence.result = 'PASS';
    if (process.env.LIA_FLOW_EVIDENCE) fs.writeFileSync(process.env.LIA_FLOW_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    if (env) await env.close();
    if (server) await server.close();
    // This path was created by mkdtemp above; no original repository DATA used.
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
