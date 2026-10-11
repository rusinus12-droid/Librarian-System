'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { extractStorageSdk, expectedStorageSdk } = require('../tools/lib/sdk_variants.cjs');

const root = path.resolve(__dirname, '..');
const sdkPath = path.join(root, 'sdk', 'MemorySuiteStorageClient.source.js');
const sdkText = fs.readFileSync(sdkPath, 'utf8').trim();
const pluginDir = path.join(root, 'plugins');
const plugins = [
  ['Flashback_Memory.js', 'data-tab="server"', 'flashbackMemorySuiteServerConnectionPanel'],
  ['HAYAKU_Locator_Continuity.js', 'data-hayaku-viewer-tab="server"', 'hayakuMemorySuiteServerConnectionPanel'],
  ['LIBRA.js', "{ id: 'server', label: '서버 · 저장' }", 'libraMemorySuiteServerConnectionPanel'],
  ['LIA_Persona_Linker.js', '["server", "저장·이전 자료 복구"]', 'liaMemorySuiteServerConnectionPanel'],
  ['RETRACE.js', 'data-tab="serverconnection"', 'retraceMemorySuiteServerConnectionPanel']
];

assert.match(sdkText, releasePattern("LIBRARIAN SYSTEM STORAGE SDK v{storage}", ""));
// The scope-default marker used to read '새 스코프의 기본값은 항상 플러그인 단독입니다' — "always". That
// sentence stopped being true when a GLOBAL storage mode was added: a user can now set one mode for
// every conversation, and an untouched scope follows it rather than always defaulting to plugin_only.
// The marker is kept here (so the sentence is still asserted, not merely deleted) in its corrected
// form, which states both behaviours: per-scope default when nothing is set, global inheritance when
// it is.
for (const marker of ['이 설정은 현재 스코프에만 적용됩니다.', '새 스코프의 기본값은 플러그인 단독이며, 전역 설정을 지정하면 설정하지 않은 스코프가 그 값을 따릅니다', 'MEMORY_SUITE_SERVER_URL_IN_USE', 'MEMORY_SUITE_RECOVERY_REQUIRED', 'resolveRestoreDependencies', 'validateRestore', 'data-job-result', 'data-job-dismiss', '별도 key 입력 없이', 'testConnection', 'configureConnection', 'getConnectionSettings', 'mountConnectionPanel', 'startConnectionConfigurationJob', 'startSynchronizationJob', 'startRestoreJob', 'subscribeSyncJob', 'data-mscx-job', '처리 용량', '마지막 활동', '서버 주소', '연결 테스트', '설정 적용',
  // The global-mode range selector and its per-direction transition warnings.
  'data-scope-global', 'data-scope-perchat', 'confirmModeTransition',
  '서버로 데이터를 옮기는 과정이 필요하니 시간이 오래 걸릴 수 있습니다',
  '플러그인 스토리지로 데이터를 옮겨야 하니 시간이 소요됩니다',
  '서버에만 있는 자료까지 pluginStorage에 복원하고 재조회합니다', 'MEMORY_SUITE_MIRROR_TRANSITION_ONLY']) {
  assert.ok(sdkText.includes(marker), `SDK marker ${marker}`);
}
for (const forbidden of ['memory_suite_bootstrap_key_required', 'data-mscx-key', 'setBootstrapKey', 'X-Memory-Suite-Bootstrap-Key']) {
  assert.ok(!sdkText.includes(forbidden), `SDK manual key marker removed: ${forbidden}`);
}

for (const [file, navMarker, hostMarker] of plugins) {
  const text = fs.readFileSync(path.join(pluginDir, file), 'utf8');
  const expectedSdk = expectedStorageSdk(root, file, text);
  assert.ok(text.includes(navMarker), `${file} side navigation`);
  assert.ok(text.includes(hostMarker), `${file} connection host`);
  if (file === 'RETRACE.js') {
    assert.ok(text.includes('refreshMemorySuiteOwnerStorageDashboard'), `${file} owner storage dashboard`);
    assert.ok(text.includes('RE:TRACE는 저장 모드를 소유하거나 변경하지 않습니다.'), `${file} read-only control-plane contract`);
    assert.ok(!text.includes('MemorySuiteStorageBridge.mountConnectionPanel'), `${file} must not expose its own storage-mode panel in RE:TRACE 1.9.77`);
  } else if (file === 'LIA_Persona_Linker.js') {
    assert.ok(text.includes('mountLiaServerConnectionPanel'), `${file} local recovery panel mount`);
    assert.ok(!text.includes('MemorySuiteStorageBridge.mountConnectionPanel'), `${file} local owner has no mode-changing panel`);
  } else {
    assert.ok(text.includes('MemorySuiteStorageBridge.mountConnectionPanel'), `${file} panel mount`);
  }
  // extractStorageSdk requires exactly one marker/block; expectedStorageSdk
  // verifies preserved consumer hashes as well as canonical active variants.
  assert.equal(extractStorageSdk(text, file), expectedSdk, `${file} embedded SDK exact designated variant`);
}

function memoryStore(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    async getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    async setItem(key, value) { map.set(String(key), value); return true; },
    async removeItem(key) { map.delete(String(key)); return true; },
    async keys() { return Array.from(map.keys()); }
  };
}

async function verifyLiaRecoveryPanel() {
  const text = fs.readFileSync(path.join(pluginDir, 'LIA_Persona_Linker.js'), 'utf8');
  const start = text.indexOf('function mountLiaServerConnectionPanel()');
  const end = text.indexOf('function activateTab(', start);
  assert(start >= 0 && end > start, 'LIA recovery panel extraction');
  const button = disabled => ({ disabled, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } });
  const preview = button(false), publish = button(true), status = { textContent: '' };
  const nodes = { '[data-lia-recovery-preview]': preview, '[data-lia-recovery-publish]': publish, '[data-lia-recovery-status]': status };
  const root = { innerHTML: '', querySelector(selector) { return nodes[selector]; } };
  let previews = 0, publishes = 0, clears = 0;
  let receipt = { records: 2, imageChunks: 1, conflicts: ['different-local-value'], unsupportedServerRecords: [], retainedServerTombstones: 1, unindexedShards: 1 };
  const recovery = {
    clear() { clears++; },
    async preview() { previews++; return receipt; },
    async publish(selected) { assert.equal(selected, receipt); publishes++; return { restored: 2 }; }
  };
  const mount = new Function('document', 'LiaLegacyServerRecovery', 'pluginUnloaded', `${text.slice(start, end)}; return mountLiaServerConnectionPanel;`)(
    { getElementById(id) { return id === 'liaMemorySuiteServerConnectionPanel' ? root : null; } }, recovery, false
  );
  assert.equal(mount(), true);
  assert.equal(clears, 1);
  assert.equal(previews, 0, 'opening LIA storage performs no automatic server read');
  assert.equal(publishes, 0, 'opening LIA storage performs no automatic import');
  assert(root.innerHTML.includes('LIA 로컬 저장'));
  await preview.handlers.click();
  assert.equal(publish.disabled, true, 'conflicting local data blocks publication');
  await publish.handlers.click();
  assert.equal(publishes, 0);
  receipt = { ...receipt, conflicts: [] };
  await preview.handlers.click();
  assert.equal(publish.disabled, false, 'verified conflict-free preview enables explicit publication');
  await publish.handlers.click();
  assert.equal(publishes, 1);
  assert.equal(publish.disabled, true, 'publication consumes the preview');
  assert(status.textContent.includes('서버 자료는 그대로 유지됩니다'));
}

async function main() {
  await verifyLiaRecoveryPanel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-connection-gui-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previous = globalThis.risuai;
  const args = { memory_suite_server_mode: '', memory_suite_server_url: 'http://127.0.0.1:47630' };
  let conflictingApp = null;
  let conflictingDataDir = '';
  try {
    globalThis.risuai = {
      async getArgument(name) { return args[name] || ''; },
      async setArgument(name, value) { args[name] = String(value); return true; },
      async nativeFetch(url, init) { return await fetch(url, init); }
    };
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
    const legacy = memoryStore({ 'gui:test:a': { n: 1 } });
    // The generic connection/mode workflow uses an active storage owner.
    // LIA local recovery is exercised above; LIBRA retains its own SDK variant.
    const bridge = createBridge({
      namespace: 'hayaku', pluginId: 'hayaku', pluginVersion: '1.0.98',
      pluginPrefixes: ['gui:test:'], managementButton: false, migrationDelayMs: 100000,
      currentScopeProvider: async () => ({ scopeId: 'gui-scope-a', scopeKey: 'gui-scope-a', label: 'GUI Scope A' })
    });
    bridge.createPluginStorageProxy(legacy);

    assert.equal(await bridge.getMode(), 'plugin_only', 'plugin-only remains default');
    const test = await bridge.testConnection(baseUrl);
    assert.equal(test.ok, true, 'connection test works even in plugin-only mode');
    assert.equal(test.serverVersion, require('node:fs').readFileSync(require('node:path').join(__dirname, '../VERSION.txt'),'utf8').trim());
    assert.equal(test.protocol.major, 1);

    const configured = await bridge.configureConnection({ mode: 'server_only', url: baseUrl });
    assert.equal(configured.ok, true);
    assert.equal(configured.to.mode, 'server_only');
    assert.equal(configured.to.url, baseUrl);
    assert.equal(args.memory_suite_server_mode, '', 'scope mode must leave the untouched global ARG unchanged');
    assert.equal(args.memory_suite_server_url, baseUrl);

    await assert.rejects(
      () => bridge.configureConnection({ mode: 'server_only', url: 'http://127.0.0.1:65530' }),
      error => error?.code === 'MEMORY_SUITE_SERVER_URL_IN_USE'
    );
    assert.equal((await bridge.getConnectionSettings({ force: true })).url, baseUrl, 'global server URL must stay fixed while any scope is server-backed');

    const settings = await bridge.getConnectionSettings({ force: true, test: true });
    assert.equal(settings.mode, 'server_only');
    assert.equal(settings.connection.ok, true);
    assert.equal(settings.connection.serverVersion, require('node:fs').readFileSync(require('node:path').join(__dirname, '../VERSION.txt'),'utf8').trim());

    await assert.rejects(
      () => bridge.configureConnection({ mode: 'server_only', url: 'https://example.com' }),
      /invalid_memory_suite_server_url|server_url_must_be_loopback_http/
    );
    assert.equal(await bridge.getMode(), 'server_only', 'invalid URL must not change mode');
    assert.equal((await bridge.getConnectionSettings({ force: true })).url, baseUrl, 'invalid URL must not change saved URL');

    const localOnly = await bridge.configureConnection({ mode: 'plugin_only', url: baseUrl });
    assert.equal(localOnly.to.mode, 'plugin_only');
    assert.equal(await bridge.getMode(), 'plugin_only');

    conflictingDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-connection-conflict-'));
    conflictingApp = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir:conflictingDataDir, autoBackup:false });
    const conflictingAddress = await conflictingApp.listen();
    const conflictingUrl = `http://127.0.0.1:${conflictingAddress.port}`;
    const bootstrap = await (await fetch(`${conflictingUrl}/bootstrap`, { headers:{ 'X-Memory-Suite-Plugin':'hayaku', 'X-Memory-Suite-Plugin-Version':'1.0.98' } })).json();
    const seeded = await (await fetch(`${conflictingUrl}/v1/kv/set`, {
      method:'POST',
      headers:{ Authorization:`Bearer ${bootstrap.token}`, 'X-Memory-Suite-Plugin':'hayaku', 'X-Memory-Suite-Plugin-Version':'1.0.98', 'Content-Type':'application/json' },
      body:JSON.stringify({ namespace:'hayaku', space:'plugin', key:'gui:test:a', value:{ n:999 }, operationId:'connection_url_rollback_conflict_seed' })
    })).json();
    assert.equal(seeded.ok, true);
    await assert.rejects(
      () => bridge.configureConnection({ mode:'server_only', url:conflictingUrl }),
      error => error?.code === 'MEMORY_SUITE_SCOPE_SYNC_INCOMPLETE'
    );
    assert.equal(args.memory_suite_server_url, baseUrl, 'failed mode transition rolls the plugin-global URL back');
    assert.equal(await bridge.getMode(), 'plugin_only', 'failed mode transition does not commit mirror mode');

    process.stdout.write('server_connection_gui_contract_test: PASS\n');
  } finally {
    if (conflictingApp) await conflictingApp.close();
    if (conflictingDataDir) fs.rmSync(conflictingDataDir, { recursive:true, force:true });
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`server_connection_gui_contract_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
