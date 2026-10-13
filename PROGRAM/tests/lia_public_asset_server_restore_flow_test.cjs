'use strict';

// Drive callbacks registered by the unchanged plugin against a real DOM and an
// physical local snapshot. Exposed helpers only inspect state/read owner data;
// neither producer, backup, transport, nor restore implementation is replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
const { createSnapshotBridge } = require('./fixtures/lia_legacy_recovery_snapshot_fixture.cjs');

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
        uploadSelection: () => ({ emotion: liaSelectedVisualAssetEmotion, personaKey: liaSelectedVisualAssetPersonaKey }),
        setGeneratedResult: raw => setGeneratedOutputText(resultToOutputText(JSON.parse(String(raw)))),
        readResult: () => getLLMResultOverride(),
        refresh: () => refreshPreview({skipCapture:true}),
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
    transformSource: source => {
      let audited=expose(source);
      if(options.legacySnapshotFile){
        const marker='const LiaLegacyServerRecovery = createLiaLegacyServerRecovery(MemorySuiteStorageBridge);';
        assert.equal(audited.split(marker).length,2,'one legacy recovery transport seam');
        const methods=['serverBinding','serverIntegrity','serverKeys','serverGet'];
        audited=audited.replace(marker,'const LiaLegacyServerRecovery = createLiaLegacyServerRecovery({...MemorySuiteStorageBridge,'+methods.map(name=>name+':(...args)=>globalThis.__legacyReadTransport.'+name+'(...args)').join(',')+'});');
      }
      return audited;
    },
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
      api.nativeFetch = async () => { throw Error('local-only storage must never request server'); };
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
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLSelectElement: dom.window.HTMLSelectElement,
    CSS: { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    navigator: { language: 'en-US' }, confirm: () => true });
  assert.equal(typeof callbacks.setting, 'function', 'actual settings callback was registered');
  assert.equal(typeof callbacks.button, 'function', 'actual menu callback was registered');
  const audit = fixture.runtime.restoreFlowAudit;
  assert.ok(audit, 'read-only owner audit hook installed');
  const transport=options.legacySnapshotFile?createSnapshotBridge(audit.bridge,options.legacySnapshotFile):null;
  if(transport)fixture.context.__legacyReadTransport=transport.api;
  async function open() {
    await callbacks.setting();
    await waitFor(() => dom.window.document.querySelector('#dpg-preview-root .page[data-page="mine"]'), 'adopted LIA GUI rendered');
    return dom.window.document;
  }
  return { ...fixture, audit, callbacks, dom, domErrors, localRows, modelCalls, args, open, transport,
    async close() { await fixture.dispose(); dom.window.close(); } };
}

async function manualUpload(env, bytes, expectedTone = 'ok') {
  const document = env.dom.window.document;
  const input = document.getElementById('lia-asset-image-file');
  assert.ok(input, 'actual manual upload input exists');
  // The VM uses the Node Blob constructor, so its browser-file boundary must
  // receive that same Blob type rather than a duck-typed arrayBuffer object.
  const file = new Blob([bytes], { type: 'image/png' });
  Object.defineProperty(file, 'name', { value: 'marker.png' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  const status = document.getElementById('dpg-status');
  const previousStatus = status?.textContent || '';
  input.dispatchEvent(new env.dom.window.Event('change', { bubbles: true }));
  let currentStatus;
  await waitFor(() => { currentStatus = document.getElementById('dpg-status'); return currentStatus?.textContent !== previousStatus && currentStatus?.dataset?.tone === expectedTone; }, 'manual upload handler settled');
  assert.equal(currentStatus?.dataset?.tone, expectedTone, currentStatus?.textContent || 'upload status missing');
  return currentStatus.textContent;
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
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-public-restore-flow-'));
  const hostAssets = fileAssets(path.join(dataDir, 'mock-host-assets'));
  const evidence = { schema: 'lia.public-asset-local-restart-flow.v2',
    hostBoundary: 'Windows Node VM + JSDOM registered callbacks; not native Risu/browser acceptance', cases: [] };
  const image = markerPng('LIA public producer preserved image marker '.repeat(12000));
  const replacement = markerPng('rejected replacement marker');
  const body = 'LIA public vault body marker: original persona draft survives server restore and realm restart.';
  let env;
  try {
    env = await createRealm('', null, hostAssets);
    await env.open();
    const generated = { personaName: 'Flow Marker Persona', generationMode: 'random', generationId: 'flow-marker-generation', randomCandidate: { id: 'flow-marker-candidate', name: 'Flow Marker Persona' }, personaPrompt: body, personaSpec: { name: 'Flow Marker Persona', gender: '', age: '', speciesRace: '', origin: '', role: 'Synthetic archivist', appearance: 'Synthetic appearance', personality: 'Synthetic personality', visibleSide: '', hiddenSide: '', internalContradiction: '', background: '', speech: '', motivation: '', relationshipStyle: '', relationshipToCharacter: '', preferences: '', conflictRepair: '', skills: [], limitations: '', knowledgeBoundary: '', boundaries: [], worldFitNotes: '' }, personaFieldLocks: ['role'], personaVariants: { full: body, standard: '', compact: '' }, activePersonaProfile: 'full', personaLineage: { lineageId: 'flow-marker-lineage', revision: 1, history: [{ revision: 1, at: '2026-10-12T00:00:00Z', operation: 'create', detail: 'synthetic test fixture' }, { revision: 2, at: '2026-10-13T00:00:00Z', operation: 'edit', detail: 'synthetic test fixture' }] } };
    env.audit.setGeneratedResult(JSON.stringify(generated));
    await env.audit.refresh();
    const document = env.dom.window.document;
    document.querySelector('#dpg-preview-root .sidebar [data-go="mine"]').click();
    document.querySelector('#dpg-preview-root #pocket [data-go="edit"]').click();
    document.querySelector('#dpg-preview-root [data-subtabs="ed"] [data-subtab="out"]').click();
    const vaultSave = document.querySelector('#dpg-preview-root [data-lia-editor-writer="vault"]');
    assert.ok(vaultSave, 'adopted editor exposes the local-only vault writer');
    assert.equal(vaultSave.disabled, false, `valid generated Persona result satisfies the existing writer admission contract; result=${JSON.stringify(env.audit.readResult())}; active=${document.querySelector('#dpg-preview-root .page.is-active')?.dataset.page}; button=${vaultSave.outerHTML}`);
    vaultSave.click();
    await waitFor(() => env.values.get(VAULT)?.includes(body), 'public vault producer');
    await waitFor(() => !document.querySelector('#dpg-preview-root [data-lia-editor-writer="vault"]')?.disabled, 'vault GUI readback completed');
    document.querySelector('#dpg-preview-root .sidebar [data-go="mine"]').click();
    document.querySelector('#dpg-preview-root #pocket [data-go="assets"]').click();
    document.querySelector('#dpg-preview-root #emo-grid button[data-open="sheet-emo"]').click();
    document.querySelector('#dpg-preview-root #sheet-emo [data-lia-asset-upload]').click();
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
    document.querySelector('#dpg-preview-root #emo-grid button[data-open="sheet-emo"]').click();
    document.querySelector('#dpg-preview-root #sheet-emo [data-lia-asset-upload]').click();
    await manualUpload(env, replacement, 'error');
    env.api.pluginStorage.setItem = originalSet;
    assert.equal(env.values.get(ASSETS), assetRaw, 'failed public upload preserved exact asset metadata');
    assert.equal(env.values.get(VAULT), vaultRaw, 'failed upload preserved independent body');
    assertRows(env.values, priorBackup, 'failed upload preserved immutable history');
    assert.equal([...env.values.keys()].filter(key => key.startsWith(BLOBS)).length, priorBackup.length,
      'failed new backup rolled back its partial chunks');
    evidence.cases.push({ name: 'public-upload-dropped-manifest', displayedError: true,
      originalMetadataUnchanged: true, immutableHistoryUnchanged: true, partialChunksRemoved: true });

    // Current replacement: the registered legacy preview/import callbacks read
    // a physical preexisting response snapshot and use the unchanged local
    // publisher. Never manufacture a retired writable LIA SQLite namespace.
    await assert.rejects(() => env.audit.bridge.setMode('server_only'),error => error.code === 'MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY');
    const durable = [[ASSETS, assetRaw], [VAULT, vaultRaw], ...priorBackup];
    const legacyFile=path.join(dataDir,'preexisting-legacy-response.json');fs.writeFileSync(legacyFile,JSON.stringify(durable));const legacyBefore=fs.readFileSync(legacyFile,'utf8');
    const {snapshot:restartSnapshot,localRows:persistedLocalRows}=diskSnapshot(env,dataDir,'before-local-restart');
    assert.equal(env.modelCalls.length,0);assert.deepEqual(env.domErrors,[]);await env.close();env=null;
    const missing=restartSnapshot.values.filter(([key])=>!key.startsWith(`${BLOBS}${entry.backupId}::`));
    env=await createRealm('',missing,hostAssets,{snapshot:restartSnapshot,localRows:new Map(persistedLocalRows),legacySnapshotFile:legacyFile});await env.open();
    const serverTab=env.dom.window.document.querySelector('#dpg-preview-root .menu [data-go="recover"]');assert(serverTab);serverTab.click();
    const panel=await waitFor(()=>env.dom.window.document.getElementById('liaMemorySuiteServerConnectionPanel')?.querySelector('[data-lia-recovery-preview]'),'actual legacy recovery GUI');
    const recoverySection=panel.closest('section');
    const status=recoverySection.querySelector('[data-lia-recovery-status]');
    const publish=recoverySection.querySelector('[data-lia-recovery-publish]');
    const preview=async()=>{panel.click();await waitFor(()=>!panel.disabled,'registered read-only preview');assert.match(status.textContent,/검증/);assert.equal(publish.disabled,false);};
    const runPublish=async()=>{publish.click();await waitFor(()=>!panel.disabled,'registered local publication');return status.textContent;};
    const beforeFailure=new Map(durable.map(([key])=>[key,env.values.get(key)]));const write=env.api.pluginStorage.setItem;
    await preview();for(const [key,value]of beforeFailure)assert.equal(env.values.get(key),value,'preview never writes local owner');
    env.api.pluginStorage.setItem=async(key,value)=>key===priorBackup.at(-1)[0]?true:write(key,value);
    assert.match(await runPublish(),/가져오기 중단/);for(const [key,value]of beforeFailure)assert.equal(env.values.get(key),value,`failed import rollback:${key}`);
    assert.equal(fs.readFileSync(legacyFile,'utf8'),legacyBefore,'failed import preserves physical legacy source');
    env.api.pluginStorage.setItem=write;await preview();assert.match(await runPublish(),/저장하고 다시 확인/);assertRows(env.values,durable,'registered local import exact physical bytes');
    assert(env.transport.calls.every(route=>route.startsWith('GET ')));assert.equal(fs.readFileSync(legacyFile,'utf8'),legacyBefore);
    evidence.cases.push({name:'registered-legacy-preview-import-failure-retry',previewReadOnly:true,droppedManifestRejected:true,rollbackExact:true,retrySucceeded:true,physicalLegacySourceUnchanged:true,serverWrites:0});
    const {snapshot:restoredSnapshot,localRows:persistedRestoredLocalRows}=diskSnapshot(env,dataDir,'after-registered-local-import');
    assert.equal(env.modelCalls.length,0);assert.deepEqual(env.domErrors,[]);await env.close();env=null;hostAssets.clear();
    env=await createRealm('',restoredSnapshot.values,hostAssets,{snapshot:restoredSnapshot,localRows:new Map(persistedRestoredLocalRows)});
    assertRows(env.values,durable,'physical local restart retained exact imported owner bytes');
    const reloadedVault = await env.audit.readStoredResultVault();
    assert.ok(reloadedVault.some(item => item.personaPrompt === body), 'fresh owner reader returned actual vault body');
    const reloadedAssets = await env.audit.readPersonaVisualAssetStore();
    const reloadedEntry = reloadedAssets.sets[personaKey].images.neutral;
    const available = await env.audit.ensurePersonaVisualAssetAvailable(reloadedEntry, { personaKey, emotion: 'neutral' });
    assert.equal(available.restored, true, 'fresh owner recovered missing native image from immutable backup');
    assert.deepEqual(Buffer.from(available.bytes), image, 'fresh owner restored exact original image bytes');
    assertRows(env.values, priorBackup, 'owner asset recovery left immutable backup unchanged');
    await env.open();
    const restoredDocument = env.dom.window.document;
    const vaultTab = restoredDocument.querySelector('#dpg-preview-root .sidebar [data-go="shelf"]');
    assert.ok(vaultTab, 'fresh registered GUI offers the vault route');
    vaultTab.click();
    assert.equal(restoredDocument.querySelector('#dpg-preview-root .page[data-page="shelf"].is-active') !== null, true, 'registered navigation selected adopted shelf');
    const vaultPanel = restoredDocument.getElementById('shelf-list');
    assert.ok(vaultPanel, 'restored vault list is mounted');
    assert.ok(vaultPanel.textContent.includes('Flow Marker Persona'), 'fresh registered GUI shows restored vault card');
    const reloadedMetadata = JSON.parse(env.values.get(ASSETS)).sets[personaKey].images.neutral;
    assert.equal(reloadedMetadata.backupId, entry.backupId, 'recovery retained immutable backup reference');
    assert.deepEqual(hostAssets.get(reloadedMetadata.assetPath.replace(/^assets\//, '')), image,
      'native host restored asset exact physical bytes');
    assert.equal(env.modelCalls.length, 0, 'no model API was called');
    assert.deepEqual(env.domErrors, [], 'registered GUI had no DOM/runtime errors');
    evidence.cases.push({ name: 'physical-local-restart-and-native-backup-recovery', restoredRows: durable.length,
      ownerBodyExact: true, ownerImageExact: true, nativeAssetRebuilt: true,
      immutableHistoryUnchanged: true, registeredGuiRestoredVaultVisible: true, modelCalls: 0 });
    evidence.result = 'PASS';
    if (process.env.LIA_FLOW_EVIDENCE) fs.writeFileSync(process.env.LIA_FLOW_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    if (env) await env.close();
    // This path was created by mkdtemp above; no original repository DATA used.
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
