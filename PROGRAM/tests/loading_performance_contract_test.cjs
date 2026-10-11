'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


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

for (const sdkName of ['MemorySuiteStorageClient.source.js', 'MemorySuiteStorageClient.libra.source.js']) {
  const sdk = read(`sdk/${sdkName}`);
  assert.match(sdk, releasePattern("^\\/\\* LIBRARIAN SYSTEM STORAGE SDK v{storage}", "m"));
  assert.match(sdk, /const preResolveKeyScope = options\.preResolveKeyScope === true;/);
  assert.match(sdk, /if \(previousScopeId !== String\(scope\.scopeId \|\| ''\)\) state\.scopeRouting\.routeCache\.clear\(\);/);
  assert.match(sdk, /if \(registry\?\.legacyGlobalModeImported === true && !hasServerScope\) return;/);
  assert.doesNotMatch(sdk, /scheduleDiagnosticsRefresh\(1200, \{ limit: 250 \}\);/);
  assert.match(sdk, sdkName.includes('.libra.') ? /const startupDiagnosticsEnabled = options\.startupDiagnostics !== false;/ : /const startupDiagnosticsEnabled = !localOnlyOwner && !managerOnly && options\.startupDiagnostics !== false;/);
  assert.match(sdk, /if \(startupDiagnosticsEnabled\) \{/);
}

const hayaku = read('plugins/HAYAKU_Locator_Continuity.js');
assert.match(hayaku, /const loadStorageLedgerSummary = async scope =>/);
const hayakuSummaryLoader = between(hayaku, 'const loadStorageLedgerSummary = async scope => {', '\n  const ');
assert.match(hayakuSummaryLoader, /recordsIncluded: false/);
assert.doesNotMatch(hayakuSummaryLoader, /loadStorageLedger\(/);
assert.doesNotMatch(hayakuSummaryLoader, /saveStorageLedger\(/);
assert.match(hayaku, /if \(!objectish\(capsule\)\) \{[\s\S]{0,240}?reason: 'capsule_absent'/);
const hayakuIpcInspect = between(hayaku, "} else if (action === 'inspect') {", "} else {\n            throw new Error(`Unsupported HAYAKU bridge IPC action");
assert.match(hayakuIpcInspect, /loadStorageLedgerSummary\(scope\)/);
assert.doesNotMatch(hayakuIpcInspect, /syncBridgeAnalysisCapsules\(\);/);
const hayakuRepair = between(hayaku, 'const repairCurrentSelectedUnboundLedger = async', 'const reconcileObservedChatTopology = async');
assert.match(hayakuRepair, /loadStorageLedger\(scope, \{ hydrateArchive: false \}\)/);

const flashback = read('plugins/Flashback_Memory.js');
const flashbackSummary = between(flashback, 'if (!includeRecords && !Array.isArray(options?.sourceTypes)) {', 'const loaded = await loadScopeRecords(scope.scopeKey);');
assert.match(flashbackSummary, /loadFlashbackArchiveManifestSummary/);
assert.match(flashbackSummary, /mergeFlashbackArchiveStats/);
assert.match(flashbackSummary, /archiveStatsIncluded/);
assert.match(flashbackSummary, /statsCoverage/);
assert.doesNotMatch(flashbackSummary, /loadFlashbackArchiveChain/);
assert.doesNotMatch(flashbackSummary, /loadScopeRecordsRaw/);
assert.match(flashback, /preResolveKeyScope: true/);

const libra = read('plugins/LIBRA.js');
const libraSummary = between(libra, 'if (!includeRecords) {', 'const loadedMemories = await mapWithConcurrency');
assert.doesNotMatch(libraSummary, /readLibraSharedArchive/);
assert.match(libraSummary, /summary_manifest_pointer_valid/);
assert.match(libra, /preResolveKeyScope:true/);

const lia = read('plugins/LIA_Persona_Linker.js');
assert.match(lia, /const LIA_HOST_CONTEXT_TIMEOUT_MS = 1800;/);
assert.match(lia, /boundedLiaHostContextCall\("getCurrentChatIndex"/);
assert.match(lia, /preResolveKeyScope:true/);

const retrace = read('plugins/RETRACE.js');
assert.match(retrace, /scopeRouting: false,\s*startupDiagnostics: false/);
assert.match(retrace, /const CURRENT_CONTEXT_HOST_TIMEOUT_MS = 1800;/);
assert.match(retrace, /const LIBRA_INSPECT_SUMMARY_TIMEOUT_MS = 5000;/);
assert.match(retrace, /void refreshCompatibility\(preview\)/);
const retraceStartup = between(retrace, 'globalThis.__MemorySessionBridge = RetraceApi;', "console.log(`[${PLUGIN_NAME}] v${PLUGIN_VERSION} ready.`);");
const retraceBeforeUi = between(retraceStartup, "await registerFlashbackIpc()", 'await registerUi();');
assert.doesNotMatch(retraceBeforeUi, /probeLiveHayakuOwner/);
assert.doesNotMatch(retraceStartup, /registerHayakuRecoveryEventIpc|scheduleHayakuAutoRepairSweep|probeLiveHayakuOwner/, 'RE:TRACE startup must not own HAYAKU analysis/repair scheduling');

console.log('loading performance contract test: PASS');
