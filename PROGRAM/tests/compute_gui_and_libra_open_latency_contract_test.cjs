'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const program = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(program, relative), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

const computeSdk = read('sdk/MemorySuiteComputeClient.source.js');
// SDK comment/version changes are not GUI regressions; the contracts below
// check the actual integrated control, bridge and hydration behavior.
assert.doesNotMatch(computeSdk, /const mountSettingsPanel = async/);
assert.doesNotMatch(computeSdk, /value="shadow"/);

const storageSdk = read('sdk/MemorySuiteStorageClient.source.js');
const panel = between(storageSdk, 'const scopedMountConnectionPanel = async', 'const ensureHandoffReady = async');
assert.match(panel, /const integratesCompute = !!computeBridge/);
assert.match(panel, /플러그인 단독/);
assert.match(panel, /미러/);
assert.match(panel, /서버 단독/);
assert.match(panel, /로컬에서 연산/);
assert.match(panel, /서버 우선 · 실패 시 로컬/);
assert.match(panel, /computeBridge\.probe/);

const libraStorageSdk = read('sdk/MemorySuiteStorageClient.libra.source.js');
const libraPanel = between(libraStorageSdk, 'const scopedMountConnectionPanel = async', 'const ensureHandoffReady = async');
const libraPanelPaintAt = libraPanel.indexOf('container.innerHTML =');
const libraPanelForcedHydrationAt = libraPanel.indexOf('await scopedGetConnectionSettings({ force:true })');
assert.ok(libraPanelPaintAt >= 0 && libraPanelForcedHydrationAt > libraPanelPaintAt,
  'LIBRA server controls must paint before forced scope and storage hydration');
assert.match(libraPanel, /setControlsReady\(false\)/,
  'LIBRA server controls must stay inert until authoritative settings hydration finishes');
assert.match(libraPanel, /renderConnectionSettings\(await scopedGetConnectionSettings\(\{ force:true \}\)\)/,
  'LIBRA server controls must replace the cached first paint with authoritative scoped settings');

const integrations = [
  ['plugins/Flashback_Memory.js', 'flashbackMemorySuiteServerConnectionPanel'],
  ['plugins/HAYAKU_Locator_Continuity.js', 'hayakuMemorySuiteServerConnectionPanel'],
  ['plugins/LIBRA.js', 'libraMemorySuiteServerConnectionPanel'],
  ['plugins/LIA_Persona_Linker.js', 'liaMemorySuiteServerConnectionPanel']
];
for (const [relative, hostId] of integrations) {
  const source = read(relative);
  assert.match(source, new RegExp(hostId));
  assert.match(source, /MemorySuiteStorageBridge\.mountConnectionPanel\([\s\S]{0,500}?computeBridge:/);
  assert.doesNotMatch(source, /MemorySuiteComputeSettingsPanel/);
}

const libra = read('plugins/LIBRA.js');
const renderOnce = between(libra, 'async function renderSettingsGuiOnce() {', 'const hideSettingsGui = async () =>');
assert.doesNotMatch(renderOnce, /await LibraMemoryCore\.getCanonicalJobStatus\(\{\}\)/,
  'sidebar navigation must not wait for canonical-job storage reads');
assert.match(renderOnce, /Gui\.canonicalJobProbePromise = probe;\s*void probe;/s);

const openPath = between(libra, 'const showSettingsGui = async () => {', 'const readGuiEnabledForRegistration = async () =>');
assert.doesNotMatch(openPath, /await guiApi\.showContainer\('fullscreen'\)/,
  'first paint must not wait for the Tauri showContainer RPC');
const paintedAt = openPath.indexOf('Gui.openPerf.firstPaintAt = Date.now();');
const showScheduledAt = openPath.indexOf('scheduleSettingsGuiContainerShow(openSerial);');
assert.ok(paintedAt >= 0 && showScheduledAt > paintedAt,
  'the local iframe shell must be complete before the non-blocking host show call is scheduled');

const serverPanel = between(libra, 'const buildLibraServerConnectionPanel = () => {', 'const scheduleLibraPortableMemoryBackupMount =');
assert.match(serverPanel, /저장 및 연산 설정을 불러오는 중/);
assert.doesNotMatch(serverPanel, /Compute 설정을 불러오는 중/);
assert.match(libra, /getMemorySuiteComputeBridge: \(\) => MemorySuiteLibraComputeBridge/,
  'LibraMemoryCore must explicitly export its closure-owned Compute bridge');
assert.match(serverPanel, /const computeBridge = LibraMemoryCore\.getMemorySuiteComputeBridge\?\.\(\) \|\| null/,
  'the server panel must resolve Compute through the core boundary');
assert.match(serverPanel, /\.\.\.\(computeBridge \? \{ computeBridge: computeBridge \} : \{\}\)/,
  'Storage must still mount when the optional Compute bridge is unavailable');
assert.doesNotMatch(serverPanel, /computeBridge:\s*MemorySuiteLibraComputeBridge/,
  'the GUI must not reference the core-private Compute binding directly');

console.log('integrated storage-compute GUI and LIBRA open-latency contract test: PASS');
