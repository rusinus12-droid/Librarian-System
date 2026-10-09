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
assert.match(libra, releasePattern("const PLUGIN_VERSION = '{libra}';", ""), "LIBRA runtime version matches metadata");
assert.match(hayaku, releasePattern("const PLUGIN_VERSION = '{hayaku}';", ""), "HAYAKU runtime version matches metadata");
assert.match(flashback, releasePattern("const PLUGIN_VERSION = '{flashback}';", ""), "Flashback runtime version matches metadata");
assert.match(lia, releasePattern("const PLUGIN_VERSION = \"{lia}\";", ""), "LIA runtime version matches metadata");
assert.match(flashback, releasePattern("^\\/\\/@display-name \u26a1 FLASHBACK Memory v{flashback}\\s*$", "m"), "Flashback display version matches metadata");

for (const [name, source] of [
  ['LIBRA', libra],
  ['HAYAKU', hayaku],
  ['Flashback', flashback],
  ['LIA', lia],
]) {
  assert.match(source, /chat_output_registered_but_silent/, `${name}: silent registered-listener reason exists`);
  assert.match(source, /observedRunsAtAfter/, `${name}: afterRequest witness stores the observed callback counter`);
  assert.match(source, /SilentFailovers|silentFailovers/, `${name}: silent failover telemetry exists`);
  assert.match(source, /HealthChecks|healthChecks/, `${name}: health-check telemetry exists`);
  assert.match(source, /removeRisuChatListener/, `${name}: runtime failover retires the silent official listener`);
}

// LIBRA: only a subsequent main beforeRequest proves the prior official listener
// was silent. The old scope-bound scan is used once to recover the missed boundary.
assert.match(libra, /state\.captureBackend === LIBRA_CAPTURE_BACKENDS\.CHAT_OUTPUT_V3 && state\.captureBackendHealthPending/);
assert.match(libra, /await failover\('chat_output_registered_but_silent', health\)/);
assert.match(libra, /chat_output_silent_failover_reconcile/);
assert.match(libra, /state\.captureBackendHealthPending = null;[\s\S]{0,160}observeHookRuntime\('output', 'chat_output'\)/);

// HAYAKU: legacy packet finalization remains installed but non-owning until failover.
assert.match(hayaku, /const failoverSilentChatOutputBackend = async/);
assert.match(hayaku, /Memory\.afterRequest\.registered === true[\s\S]*?AFTER_REQUEST_RECONCILE/);
assert.match(hayaku, /scheduleFinalizedCaptureMonitor\(pending\)/);
assert.match(hayaku, /Memory\.captureBackendHealthPending = null;[\s\S]{0,180}Memory\.runtimeDiagnostics\.requestHooksObservedSinceInstall/);

// Flashback: prefer the script-output compatibility backend at runtime, then
// fall back to the already-registered afterRequest reconcile path.
assert.match(flashback, /const failoverSilentFlashbackChatOutputBackend = async/);
assert.match(flashback, /addRisuScriptHandler\('output', processLegacyScriptOutputCapture\)/);
assert.match(flashback, /Runtime\.replacersRegistered\.after === true[\s\S]*?AFTER_REQUEST_RECONCILE/);
assert.match(flashback, /scheduleFinalizedCaptureMonitor\(pending, settings, \{ responseCompleted: true \}\)/);

// LIA: official v3 lifecycle first, legacy/fork event fallback second.
assert.match(lia, /if \(typeof api\.onUnload === "function"\)[\s\S]*?api\.onUnload\(unloadEventHandler\)[\s\S]*?else if \(typeof api\.addEventListener === "function"\)/);
assert.doesNotMatch(lia, /await api\.log\?\./, 'LIA startup no longer uses deprecated api.log');
assert.match(lia, /const target = normalizeLiveSyncTarget\(health\?\.target \|\| recentLiveSyncRequestTarget\(\) \|\| \{\}\)/);
assert.match(lia, /reason: "chat_output_silent_failover_reconcile"/);
assert.match(lia, /if \(isNarrativePersonaProofRequest\(type\)\) await maybeFailoverSilentLiveSyncBackend\(\)/);

// No new unconditional timer is used to *decide* that the official listener is
// silent; the proof point is the next main beforeRequest after a main afterRequest.
for (const [name, source, marker] of [
  ['LIBRA', libra, 'activateLegacyBackendAfterSilentV3'],
  ['HAYAKU', hayaku, 'failoverSilentChatOutputBackend'],
  ['Flashback', flashback, 'failoverSilentFlashbackChatOutputBackend'],
  ['LIA', lia, 'activateLegacyLiveSyncBackendAfterSilentV3'],
]) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `${name}: helper found`);
  const body = source.slice(at, at + 7000);
  assert.doesNotMatch(body, /setInterval\s*\(/, `${name}: silent failover does not use polling`);
}

process.stdout.write('api_v3_capture_health_failover_test: PASS\n');
