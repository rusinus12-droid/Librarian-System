'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'RETRACE.js'), 'utf8');

const metadataVersion=source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1]; assert.ok(metadataVersion, 'plugin has valid version metadata');
assert.ok(source.includes("const inspectTransition = async (options = {}) =>"), 'transition inspection accepts an explicit server-data option');
assert.ok(source.includes("options?.includeServerData === true"), 'server inventory is opt-in');
assert.ok(source.includes("reason: 'server_probe_deferred'"), 'first paint has a deferred-server state');
assert.ok(source.includes("await inspectTransition({ includeServerData: true })"), 'the committed handoff path can still request server evidence');
assert.ok(source.includes("if (namespace === 'lia') return 'plugin_only';"), 'LIA peer mode is local-only');
assert.ok(source.includes("await MemorySuiteStorageBridge.bootstrap(false, true)"), 'peer namespace inventory uses one server preflight');
assert.ok(source.includes("await memorySuitePeerStorageMode(namespace) === 'plugin_only'"), 'each peer owner mode gates its own server read');
assert.ok(source.includes('peerAvailability[namespace] === false'), 'absent peer owners are excluded from server inventory');
assert.ok(source.includes('${formatNumber((suite.peers || []).length)}개 플러그인 호환성'), 'compatibility title uses the rendered peer count');
assert.ok(!source.includes('6개 플러그인 호환성'), 'stale six-plugin title is removed');
assert.ok(!source.includes('6개 namespace'), 'stale six-namespace copy is removed');

assert.ok(!source.includes('const saveHayakuAutoRepairSelection = async selectNode =>'), 'RE:TRACE no longer persists a HAYAKU auto-repair selector');
assert.ok(!source.includes('hayakuAutoRepairEnabled'), 'RE:TRACE HAYAKU auto-repair selector UI is removed');
assert.ok(!source.includes('retrace_hayaku_auto_repair'), 'legacy RE:TRACE HAYAKU auto-repair argument is removed');
assert.ok(!source.includes('HAYAKU 본체 복구 상태'), 'RE:TRACE analysis-recovery panel is removed');
assert.ok(!source.includes('const refreshHayakuAutoRepairStatus = async () =>'), 'RE:TRACE no longer polls HAYAKU recovery status');
assert.ok(!source.includes('data-tab="coldstart"'), 'RE:TRACE has no analysis-recovery navigation tab');
assert.ok(!source.includes('data-tab="provider"'), 'RE:TRACE has no provider navigation tab');

process.stdout.write('retrace_offline_gui_contract_test: PASS\n');
