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
assert.ok(source.includes("text: 'LIBRA'"), 'header family selector exposes LIBRA');
assert.ok(source.includes("selectResponseFamilyFromHeader('libra')"), 'header family selector activates LIBRA mode');
assert.ok(source.includes("name: 'LIBRA로 인풋 작성하기'"), 'separate Input Writer chat action exposes LIBRA');
assert.ok(!source.includes("Object.freeze({ id: 'home', label: '홈'"), 'the public sidebar does not expose a dashboard home');
assert.ok(!source.includes("return page('홈'"), 'the shared public router does not mount the retired home');
const sharedAgentShell = source.slice(source.indexOf('const buildSharedAgentShellPanel ='), source.indexOf('const buildSharedCustomShellPanel ='));
assert.match(sharedAgentShell, /const family = activeGuiResponseFamily\(\);[\s\S]{0,360}buildDraftWorkspacePanel\(family\)/, 'the selected public engine still owns only the actual draft workspace');
assert.ok(source.includes("displayName:PUBLIC_DISPLAY_NAME"), 'server management display uses public branding');

// Internal compatibility contract must remain LIBRA.
assert.match(source, /^\/\/@name libra\s*$/m);
assert.ok(source.includes("const INTERNAL_CODE_NAME = 'LIBRA';"));
assert.ok(source.includes("const PLUGIN_NAME = 'libra';"));
assert.ok(source.includes("namespace:'libra'"));
assert.ok(source.includes("const LIBRA_RETRACE_IPC_SCHEMA = 'libra-retrace-ipc-v1';"));
assert.ok(source.includes("const LIBRA_RETRACE_IPC_REQUEST_CHANNEL = 'libra_memory_bridge_request_v1';"));
assert.ok(source.includes("const LIBRA_RETRACE_IPC_RESPONSE_CHANNEL = 'libra_memory_bridge_response_v1';"));
assert.ok(source.includes("const LIBRA_SESSION_HANDOFF_CONTRACT = 'libra.handoff_immutable_source.v1';"));
assert.ok(source.includes("globalThis.__LIBRA__ = publicApi"));
assert.ok(source.includes("const MEMORY_INJECTION_MARKER = '[LIBRA 장기기억 — 관련 기억만 시간순으로 제공됨]';"));
assert.ok(source.includes("'You are LIBRA SGA SHADOW"), 'model/runtime prompt contract stays LIBRA/SGA');
assert.ok(!source.includes("const PLUGIN_NAME = 'ariadne';"));
assert.ok(!source.includes("namespace:'ariadne'"));
assert.ok(!source.includes('ariadne_memory_bridge_request_v1'));

process.stdout.write('libra_public_brand_internal_contract_test: PASS\n');
