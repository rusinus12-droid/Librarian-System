'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'plugins', name), 'utf8');
const flashback = read('Flashback_Memory.js');
const hayaku = read('HAYAKU_Locator_Continuity.js');
const libra = read('LIBRA.js');
const lia = read('LIA_Persona_Linker.js');
const retrace = read('RETRACE.js');

for (const [name, source, cachedMarker, forbidden] of [
  ['Flashback', flashback, "mode: text(MemorySuiteStorageBridge.status()?.mode || 'plugin_only')", "mode: await MemorySuiteStorageBridge.getMode().catch(() => 'plugin_only')"],
  ['HAYAKU', hayaku, "mode: text(MemorySuiteStorageBridge.status()?.mode || 'plugin_only')", "mode: await MemorySuiteStorageBridge.getMode().catch(() => 'plugin_only')"],
  ['LIBRA', libra, "mode: text(MemorySuiteStorageBridge.status()?.mode || 'plugin_only')", "{ mode: await MemorySuiteStorageBridge.getMode().catch(() => 'plugin_only'), status: MemorySuiteStorageBridge.status() }"],
  ['LIA', lia, 'mode: String(MemorySuiteStorageBridge.status()?.mode || "plugin_only")', 'mode: await MemorySuiteStorageBridge.getMode().catch(() => "plugin_only")']
]) {
  assert.ok(source.includes(cachedMarker), `${name} discovery reports cached storage status`);
  assert.ok(!source.includes(forbidden), `${name} discovery does not await durable storage-mode resolution`);
}

assert.ok(retrace.includes('bootstrapRequestTimeoutMs:5000'), 'explicit server-manager bootstrap has a bounded five-second budget');
assert.ok(retrace.includes('const tested = await MemorySuiteStorageBridge.testConnection();'), 'explicit refresh bypasses a stale background-offline cache');
assert.ok(retrace.includes("readSource: 'plugin_storage_registry_summary'"), 'Flashback summary fallback can avoid a full manifest read');
assert.ok(retrace.includes('Number(manifestRecord.valueBytes || 0) <= 512 * 1024'), 'server-scope scan does not eagerly read a large Flashback manifest');

process.stdout.write('owner_discovery_fast_path_contract_test: PASS\n');
