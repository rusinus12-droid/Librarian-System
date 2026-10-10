'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'plugins');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const libra = read('LIBRA.js');
assert.match(libra, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.ok(libra.includes("getLiveApi(['getRuntimeInfo'])"), 'LIBRA queries official getRuntimeInfo');
assert.ok(libra.includes('hostRuntimeInfo: Runtime.hostRuntimeInfo ? safeClone(Runtime.hostRuntimeInfo) : null'), 'LIBRA exposes sanitized runtime info in diagnostics');
assert.ok(libra.includes("apiVersion: String(source.apiVersion || runtimeApi.apiVersion || '').trim()"), 'LIBRA keeps only official runtime summary fields');
assert.ok(libra.includes('getHostRuntimeInfo: () => clone({ info: Runtime.hostRuntimeInfo, error: Runtime.hostRuntimeInfoError })'), 'LIBRA exposes runtime diagnostics without replacing capability checks');

const flashback = read('Flashback_Memory.js');
assert.match(flashback, releasePattern("^\\/\\/@version {flashback}\\s*$", "m"));
assert.ok(flashback.includes("getLiveApi(['getRuntimeInfo'])"), 'Flashback queries official getRuntimeInfo');
assert.ok(flashback.includes('hostRuntimeInfo: Runtime.hostRuntimeInfo ? cloneRuntimeValue(Runtime.hostRuntimeInfo, null) : null'), 'Flashback debug export includes sanitized host runtime info');
assert.ok(flashback.includes('await refreshHostRuntimeInfo().catch(() => null);'), 'Flashback refreshes runtime info only in diagnostics/startup support paths');
assert.ok(flashback.includes('getCaptureBackendState: captureBackendSnapshot'), 'Flashback capability/capture health authority remains separate');

const hayaku = read('HAYAKU_Locator_Continuity.js');
assert.match(hayaku, releasePattern("^\\/\\/@version {hayaku}\\s*$", "m"));
assert.ok(hayaku.includes("const LEDGER_VIEWER_SETTING_UI_ID = 'hayaku-ledger-viewer-setting';"));
assert.ok(hayaku.includes("const LEDGER_VIEWER_BUTTON_UI_ID = 'hayaku-ledger-viewer-button';"));
assert.ok(hayaku.includes('LEDGER_VIEWER_SETTING_UI_ID\n      );') || hayaku.includes("LEDGER_VIEWER_SETTING_UI_ID\r\n      );"), 'HAYAKU registerSetting carries stable id');
assert.ok(hayaku.includes('id: LEDGER_VIEWER_BUTTON_UI_ID'), 'HAYAKU button carries stable id');
assert.ok(hayaku.includes("typeof candidate?.unregisterUIPart === 'function'"), 'HAYAKU prefers official unregisterUIPart');
assert.ok(hayaku.includes('registry.ownerToken !== RUNTIME_INSTANCE_TOKEN'), 'HAYAKU does not remove a newer runtime owner UI');
assert.ok(hayaku.includes('if (!uiApi) return retireLedgerViewerUiOwner();'), 'HAYAKU keeps legacy/fork shared-registration fallback');

const lia = read('LIA_Persona_Linker.js');
assert.match(lia, releasePattern("^\\/\\/@version {lia}\\s*$", "m"));
assert.ok(lia.includes('const LIA_SETTING_UI_ID = "lia-persona-linker-setting";'));
assert.ok(lia.includes('const LIA_BUTTON_UI_ID = "lia-persona-linker-button";'));
assert.ok(lia.includes('registerSetting?.(PLUGIN_DISPLAY_NAME, openUI, PLUGIN_ICON, "html", LIA_SETTING_UI_ID)'), 'LIA setting uses stable id');
assert.ok(lia.includes('id: LIA_BUTTON_UI_ID'), 'LIA button uses stable id');
assert.ok(lia.includes("typeof api?.unregisterUIPart === 'function'"), 'LIA prefers official unregisterUIPart');
assert.ok(lia.includes("['unregisterSetting', 'removeSetting']"), 'LIA retains legacy setting cleanup fallback');
assert.ok(lia.includes("['unregisterButton', 'removeButton']"), 'LIA retains legacy button cleanup fallback');

for (const [name, source] of [['LIBRA', libra], ['Flashback', flashback], ['HAYAKU', hayaku], ['LIA', lia]]) {
  assert.equal(/\breadInlay\s*\(/.test(source), false, `${name}: this patch must not add inlay processing`);
  assert.equal(/\bgetFetchLogs\s*\(/.test(source), false, `${name}: this patch must not add fetch-log permission/collection`);
}

process.stdout.write('api_v3_low_risk_adoption_test: ok\n');
