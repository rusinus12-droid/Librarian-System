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

// Compute is retired: the Storage panel no longer integrates a Compute bridge or shows a
// compute mode. The contracts below check the storage control and hydration behavior.

const storageSdk = read('sdk/MemorySuiteStorageClient.source.js');
const panel = between(storageSdk, 'const scopedMountConnectionPanel = async', 'const ensureHandoffReady = async');
assert.doesNotMatch(panel, /integratesCompute|computeBridge|연산/, 'the Storage panel carries no retired Compute control');
assert.match(panel, /플러그인 단독/);
assert.match(panel, /미러/);
assert.match(panel, /서버 단독/);

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
  ['plugins/LIBRA.js', 'libraMemorySuiteServerConnectionPanel']
];
for (const [relative, hostId] of integrations) {
  const source = read(relative);
  assert.match(source, new RegExp(hostId));
  assert.match(source, /MemorySuiteStorageBridge\.mountConnectionPanel\(/);
  // The Compute SDK is retired from Flashback and HAYAKU: their panels mount Storage alone.
  // LIBRA keeps its optional core-boundary lookup, checked below.
  if (!relative.endsWith('LIBRA.js')) assert.doesNotMatch(source, /computeBridge:\s*MemorySuite/);
  assert.doesNotMatch(source, /LIBRARIAN SYSTEM COMPUTE SDK v/, relative + ' no longer embeds the Compute SDK');
  assert.doesNotMatch(source, /MemorySuiteComputeSettingsPanel/);
}

const lia = read('plugins/LIA_Persona_Linker.js');
assert.match(lia, /storagePolicy:\s*'local_only'/);
assert.doesNotMatch(lia, /MemorySuiteStorageBridge\.mountConnectionPanel\(/, 'LIA retired ordinary server/compute panel stays absent');
assert.match(lia, /await LiaLegacyServerRecovery\.preview\(/, 'explicit read-only legacy recovery remains reachable');
assert.match(lia, /await LiaLegacyServerRecovery\.publish\(/, 'separate explicit recovery publication remains reachable');

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
assert.match(serverPanel, /저장 설정을 불러오는 중/);
assert.doesNotMatch(serverPanel, /연산|computeBridge/, 'the LIBRA server panel mounts Storage alone');
assert.doesNotMatch(libra, /getMemorySuiteComputeBridge/, 'LibraMemoryCore exports no retired Compute bridge');

console.log('integrated storage-compute GUI and LIBRA open-latency contract test: PASS');
