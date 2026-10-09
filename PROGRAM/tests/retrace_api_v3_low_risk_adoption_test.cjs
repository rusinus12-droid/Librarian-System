'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const retrace = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'RETRACE.js'), 'utf8');

assert.match(retrace, releasePattern("^\\/\\/@version {retrace}\\s*$", "m"));
assert.ok(retrace.includes("const RETRACE_SETTING_UI_ID = 'retrace-main-setting';"), 'RE:TRACE main setting has a stable id');
assert.ok(retrace.includes("const RETRACE_HAMBURGER_UI_ID = 'retrace-main-hamburger';"), 'RE:TRACE hamburger button has a stable id');
assert.ok(retrace.includes("registerSetting(PLUGIN_NAME, showUi, iconSvg, 'html', RETRACE_SETTING_UI_ID)"), 'RE:TRACE passes stable setting id to official registerSetting');
assert.ok(retrace.includes('id: RETRACE_HAMBURGER_UI_ID'), 'RE:TRACE passes stable button id to official registerButton');
assert.ok(retrace.includes("liveApi(['unregisterUIPart'])"), 'RE:TRACE prefers official unregisterUIPart on unload');
assert.ok(retrace.includes('if (globalThis.__RETRACE === RetraceApi) await unregisterMainUi();'), 'stale RE:TRACE runtime does not remove newer runtime UI');

assert.ok(retrace.includes("liveApi(['getRuntimeInfo'])"), 'RE:TRACE queries official getRuntimeInfo');
assert.ok(retrace.includes("apiVersion: text(source.apiVersion || runtimeApi.apiVersion || '').trim()"), 'RE:TRACE keeps only official runtime apiVersion');
assert.ok(retrace.includes("platform: text(source.platform || '').trim()"), 'RE:TRACE keeps only official runtime platform');
assert.ok(retrace.includes("saveMethod: text(source.saveMethod || '').trim()"), 'RE:TRACE keeps only official runtime saveMethod');
assert.ok(retrace.includes('risuaiRuntime: Runtime.hostRuntimeInfo ? clone(Runtime.hostRuntimeInfo, null) : null'), 'RE:TRACE debug export contains sanitized runtime info');
assert.ok(retrace.includes('getHostRuntimeInfo: () => clone({ info: Runtime.hostRuntimeInfo, error: Runtime.hostRuntimeInfoError }, null)'), 'RE:TRACE exposes runtime diagnostics independently from capability checks');

assert.equal(/\baddRisuChatListener\s*\(/.test(retrace), false, 'RE:TRACE must not add an unnecessary output listener');
assert.equal(/\breadInlay\s*\(/.test(retrace), false, 'RE:TRACE must not add inlay processing');
assert.equal(/\bgetFetchLogs\s*\(/.test(retrace), false, 'RE:TRACE must not add fetch-log collection');

for (const invariant of [
  "const FLASHBACK_REQUIRED_HANDOFF_CONTRACT = 'flashback_memory.handoff_immutable_source.v2';",
  'sourceMutationAllowed: false',
  'sourceCompactionAllowed: false',
  "const HANDOFF_SCHEMA = 'memory-session-bridge-v2';"
]) assert.ok(retrace.includes(invariant), `handoff invariant preserved: ${invariant}`);

process.stdout.write('retrace_api_v3_low_risk_adoption_test: ok\n');
