'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

// Public product surface.
assert.match(source, releasePattern("^\\/\\/@display-name LIBRA v{libra}\\s*$", "m"));
assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.ok(source.includes("const PUBLIC_DISPLAY_NAME = 'LIBRA';"));
assert.ok(source.includes("text: PUBLIC_DISPLAY_NAME"), 'visible header exposes LIBRA public brand');
assert.match(source, /const normalizeLibraResponseMode = \(\) => 'classic'/, 'LIBRA owns Classic response injection');
assert.ok(source.includes("name: `${PUBLIC_DISPLAY_NAME} 설정`"), 'host settings action exposes LIBRA');
assert.ok(!source.includes("Object.freeze({ id: 'home', label: '홈'"), 'the public sidebar does not expose a dashboard home');
assert.ok(!source.includes("return page('홈'"), 'the shared public router does not mount the retired home');
// The six-product GUI mounts the memory analyzer as the LIBRA Settings workbench
// destination W1 ("기억 분석") instead of a shared agent shell panel.
assert.match(source, /Object\.freeze\(\{ id: 'pipeline', group: 'workbench', no: 'W1', label: '기억 분석'/, 'LIBRA workbench lists the memory analyzer');
const settingsPanelStart = source.indexOf('const buildApprovedMockupSettingsPanel =');
assert.notEqual(settingsPanelStart, -1, 'LIBRA Settings panel builder exists');
const settingsPanel = source.slice(settingsPanelStart, source.indexOf("if(sectionId==='logs')", settingsPanelStart));
assert.match(settingsPanel, /if\(sectionId==='pipeline'\)return buildLibrarianAnalyzerPanel\(/, 'LIBRA workbench owns the memory analyzer');
assert.ok(source.includes("displayName:PUBLIC_DISPLAY_NAME"), 'server management display uses public branding');

// Internal compatibility contract must remain LIBRA.
assert.match(source, /^\/\/@name libra\s*$/m);
assert.ok(source.includes("const INTERNAL_CODE_NAME = 'LIBRA';"));
assert.ok(source.includes("const PLUGIN_NAME = 'libra';"));
assert.ok(source.includes("namespace:'libra'"));
assert.ok(source.includes("const LIBRA_RETRACE_IPC_SCHEMA = 'libra-retrace-ipc-v1';"));
assert.ok(source.includes("const LIBRA_RETRACE_IPC_REQUEST_CHANNEL = 'libra_memory_bridge_request_v1';"));
assert.ok(source.includes("const LIBRA_RETRACE_IPC_RESPONSE_CHANNEL = 'libra_memory_bridge_response_v1';"));
assert.ok(source.includes("const LIBRA_SESSION_HANDOFF_CONTRACT = 'libra.handoff_immutable_source_lenses.v2';"));
assert.ok(source.includes("globalThis.__LIBRA__ = publicApi"));
assert.ok(source.includes("const MEMORY_INJECTION_MARKER = '[LIBRA 장기기억 — 관련 기억만 시간순으로 제공됨]';"));
assert.match(source, /Response injection: Classic/, 'runtime public contract identifies its current consumer');
assert.ok(!source.includes("const PLUGIN_NAME = 'ariadne';"));
assert.ok(!source.includes("namespace:'ariadne'"));
assert.ok(!source.includes('ariadne_memory_bridge_request_v1'));

process.stdout.write('libra_public_brand_internal_contract_test: PASS\n');
