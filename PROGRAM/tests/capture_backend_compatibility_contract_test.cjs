'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'plugins');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const libra = read('LIBRA.js');
const hayaku = read('HAYAKU_Locator_Continuity.js');
const flashback = read('Flashback_Memory.js');
const lia = read('LIA_Persona_Linker.js');

assert.match(libra, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.match(hayaku, releasePattern("^\\/\\/@version {hayaku}\\s*$", "m"));
assert.match(flashback, releasePattern("^\\/\\/@version {flashback}\\s*$", "m"));
assert.match(lia, releasePattern("^\\/\\/@version {lia}\\s*$", "m"));

// All output-sensitive plugins expose explicit backend ownership instead of
// letting official and legacy finalizers compete for the same U+A.
for (const [name, source, prefix] of [
  ['LIBRA', libra, 'LIBRA_CAPTURE_BACKENDS'],
  ['HAYAKU', hayaku, 'HAYAKU_CAPTURE_BACKENDS'],
  ['Flashback', flashback, 'FLASHBACK_CAPTURE_BACKENDS'],
]) {
  assert.match(source, new RegExp(`const ${prefix} = Object\\.freeze`), `${name}: backend enum exists`);
  assert.match(source, /chat_output_v3/, `${name}: current RisuAI backend exists`);
  assert.match(source, /script_output_legacy/, `${name}: old script output backend exists`);
  assert.match(source, /after_request_reconcile/, `${name}: no-output-API fallback exists`);
}

// LIBRA owns exactly one detector. Payload-incompatible chat-listener callbacks
// reuse the existing scope-bound live scan rather than registering another hook.
assert.match(libra, /state\.captureBackend = LIBRA_CAPTURE_BACKENDS\.CHAT_OUTPUT_V3;[\s\S]*?return true;[\s\S]*?const legacyApi/);
assert.match(libra, /state\.captureBackend = LIBRA_CAPTURE_BACKENDS\.SCRIPT_OUTPUT_LEGACY;[\s\S]*?return true;/);
assert.match(libra, /state\.captureBackend = LIBRA_CAPTURE_BACKENDS\.AFTER_REQUEST_RECONCILE/);
assert.match(libra, /chat_output_payload_legacy_reconcile/);
assert.match(libra, /fallbackActive = state\.settings\?\.autoAnalyze !== false && state\.captureBackend === LIBRA_CAPTURE_BACKENDS\.AFTER_REQUEST_RECONCILE/);
assert.match(libra, /getCaptureBackendState/);
assert.match(libra, /captureBackendDuplicateDrops/);
assert.match(libra, /captureBackendStaleDrops/);

// HAYAKU keeps output/editoutput installed as sanitizers, but only the selected
// backend may persist packets. Completed afterRequest is preferred over legacy
// script output when the official listener is absent.
assert.match(hayaku, /if \(Memory\.captureBackend !== HAYAKU_CAPTURE_BACKENDS\.AFTER_REQUEST_RECONCILE\)[\s\S]*?scrubHayakuRuntimeInstructionEchoForReturn/);
assert.match(hayaku, /if \(Memory\.captureBackend !== HAYAKU_CAPTURE_BACKENDS\.SCRIPT_OUTPUT_LEGACY\)[\s\S]*?packet\/runtime sanitizer/);
assert.match(hayaku, /if \(chatOutputRegistered\)[\s\S]*?CHAT_OUTPUT_V3[\s\S]*?else if \(afterRequestRegistered\)[\s\S]*?AFTER_REQUEST_RECONCILE[\s\S]*?else if \(outputRegistered\)[\s\S]*?SCRIPT_OUTPUT_LEGACY/);
assert.match(hayaku, /Memory\.captureBackend !== HAYAKU_CAPTURE_BACKENDS\.CHAT_OUTPUT_V3\) scheduleFinalizedCaptureMonitor/);
assert.match(hayaku, /captureBackendFallbackReason/);

// Flashback now has a real middle legacy backend. It takes the old output body
// only as a candidate, then uses the same authoritative live-chat reconciliation
// and hash-first provisional save contract as the old afterRequest path.
assert.match(flashback, /const processLegacyScriptOutputCapture = content =>/);
assert.match(flashback, /retainAfterRequestCaptureCandidate\(pending, content, requestClass, 'scriptOutput'\)/);
assert.match(flashback, /reconcileFinalizedCaptureCandidates\(snapshot, settings, \{ scope: pending\.scope, hook: 'scriptOutput'/);
assert.match(flashback, /captureSource: 'script_output_legacy'/);
assert.match(flashback, /Runtime\.captureBackend = FLASHBACK_CAPTURE_BACKENDS\.CHAT_OUTPUT_V3;[\s\S]*?return true;[\s\S]*?addRisuScriptHandler/);
assert.match(flashback, /Runtime\.captureBackend = FLASHBACK_CAPTURE_BACKENDS\.SCRIPT_OUTPUT_LEGACY/);
assert.match(flashback, /Runtime\.captureBackend = FLASHBACK_CAPTURE_BACKENDS\.AFTER_REQUEST_RECONCILE/);
assert.match(flashback, /Runtime\.captureBackend !== FLASHBACK_CAPTURE_BACKENDS\.AFTER_REQUEST_RECONCILE/);
assert.match(flashback, /removeRisuScriptHandler\('output', Runtime\.legacyScriptOutputHandler\)/);
assert.match(flashback, /getCaptureBackendState: captureBackendSnapshot/);

// LIA manual-only policy retains explicit analysis and source/ledger guards.
// The committed-output listener only offers a manual-update notice; it never
// becomes an automatic capture backend and no update runs before consent.
assert.match(lia, /async function registerLiveSyncCaptureBackend\(\) \{\s*liveSyncCaptureBackend = LIVE_SYNC_CAPTURE_BACKENDS\.NONE;\s*liveSyncCaptureFallbackReason = "manual_only_notification";\s*if\s*\(typeof api\.addRisuChatListener\s*!==\s*"function"\)\s*return false;\s*liveSyncOutputListener\s*=\s*event\s*=>\s*\{\s*void maybeNotifyLiaUpdate\(event\)/);
assert.doesNotMatch(lia, /liveSyncCaptureBackend\s*=\s*LIVE_SYNC_CAPTURE_BACKENDS\.(?!NONE\b)/, 'LIA never selects an automatic capture backend');
assert.match(lia, /const approved\s*=\s*await showLiaUpdateNotice\(expected[^)]*\);\s*if\s*\(!approved\s*\|\|\s*pluginUnloaded\)\s*\{[^}]*return;\s*\}[\s\S]{0,400}runLiaMockupAction\('update-five'/, 'manual update runs only after explicit consent');
assert.match(lia, /async function maybeFailoverSilentLiveSyncBackend\(\) \{ return false; \}/);
assert.match(lia, /verifyLivePersonaBatchStillCurrent/);
assert.match(lia, /validateLivePersonaLedger/);

process.stdout.write('capture_backend_compatibility_contract_test: PASS\n');
