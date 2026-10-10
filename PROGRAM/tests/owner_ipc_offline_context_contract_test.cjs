'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const sdk = read('sdk/MemorySuiteStorageClient.source.js');
const flashback = read('plugins/Flashback_Memory.js');
const hayaku = read('plugins/HAYAKU_Locator_Continuity.js');
const libra = read('plugins/LIBRA.js');
const lia = read('plugins/LIA_Persona_Linker.js');

assert.ok(sdk.startsWith(releaseText('/* LIBRARIAN SYSTEM STORAGE SDK v{storage}')));
assert.ok(sdk.includes('bootstrapRequestTimeoutMs || 1800'));
assert.ok(sdk.includes("normalized?.code !== 'MEMORY_SUITE_SERVER_UNAVAILABLE'"));
assert.ok(sdk.includes("setStatus('server_unavailable_local_only', 'memory_suite_server_unavailable'"));

assert.ok(flashback.includes('const earlyBridgeReady = await registerMemoryBridgeIpc()'));
assert.ok(flashback.includes('const MEMORY_BRIDGE_IPC_MAX_RETRIES = 24;'));

assert.ok(hayaku.includes('const scheduleMemoryBridgeIpcRetry ='));
assert.ok(hayaku.includes('const MEMORY_BRIDGE_IPC_MAX_RETRIES = 24;'));
assert.ok(hayaku.includes("scopeReadMode: directSelection ? 'direct_character_verified' : 'full_verified'"));
assert.ok(hayaku.includes('const readDirectSelection = async label =>'));
assert.ok(hayaku.includes('const chat = chats[chatIndex] || chats[0]'));
const directFallback = hayaku.slice(
  hayaku.indexOf('const readDirectSelection = async label =>'),
  hayaku.indexOf('const addBeforeRequest = async handler =>')
);
assert.ok(!directFallback.includes('pluginStorage.setItem'));
assert.ok(!directFallback.includes('pluginStorage.removeItem'));

assert.ok(libra.includes('const scheduleRetraceIpcRetry ='));
assert.ok(libra.includes('const RETRACE_IPC_MAX_RETRIES = 24;'));
assert.ok(libra.includes('if (!retraceIpcReady) scheduleRetraceIpcRetry();'));

for (const [owner, source] of Object.entries({ flashback, hayaku, libra, lia })) {
  const statusHandler = source.slice(
    source.indexOf("memory_suite_storage_status"),
    source.indexOf("memory_suite_set_mode", source.indexOf("memory_suite_storage_status"))
  );
  assert.ok(statusHandler.includes('getConnectionSettings({ force: true })'), `${owner} must re-read durable scoped connection state`);
  assert.ok(statusHandler.includes('recoveryRequired'), `${owner} must report the durable recovery guard`);
  assert.ok(statusHandler.includes('recovery'), `${owner} must report recovery evidence`);
}

process.stdout.write('Owner IPC/offline/current-chat contract: PASS\n');
