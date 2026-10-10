'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const hayaku = fs.readFileSync(path.join(root, 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');
const retrace = fs.readFileSync(path.join(root, 'plugins', 'RETRACE.js'), 'utf8');

assert.match(hayaku, releasePattern("^\\/\\/@version {hayaku}\\s*$", "m"));
assert.match(retrace, releasePattern("^\\/\\/@version {retrace}\\s*$", "m"));

const fpStart = hayaku.indexOf('const recoveryVaultStorageFingerprint = async scopeKey =>');
const fpEnd = hayaku.indexOf('const inheritRecoveryVaultForBridgeSession', fpStart);
assert.ok(fpStart >= 0 && fpEnd > fpStart, 'Recovery Vault fingerprint implementation exists');
const fp = hayaku.slice(fpStart, fpEnd);
assert.match(fp, /RisuCompat\.getStorageItem\(storageKey, null\)/, 'fingerprint reads physical storage');
assert.match(fp, /fingerprint:\s*stableHash64\(serialized\)/, 'fingerprint hashes raw serialized storage');
assert.doesNotMatch(fp, /vault\.updatedAt/, 'synthetic empty-vault timestamp cannot affect source proof');

const adoptStart = retrace.indexOf('const adoptHayakuSessionHandoff = async');
const adoptEnd = retrace.indexOf('// HAYAKU analysis prompts/execution moved to the authenticated HAYAKU owner', adoptStart);
assert.ok(adoptStart >= 0 && adoptEnd > adoptStart, 'RE:TRACE explicit next-session HAYAKU handoff function exists');
const adopt = retrace.slice(adoptStart, adoptEnd);
assert.doesNotMatch(adopt, /reason:\s*'no_hayaku_records'/, 'zero-packet early success shortcut removed');
assert.match(adopt, /requestHayakuIpc\(\s*'adopt_session_handoff'/, 'zero-packet path can reach owner IPC');

for (const removed of [
  'dispatchHayakuAdoption',
  'requestImmediateHayakuColdStartAdoption',
  'requestImmediateHayakuIncrementalRecoveryAdoption',
  "'adopt_cold_start'",
  "'adopt_incremental_recovery'",
  "'sync_analysis_capsules'"
]) {
  assert.doesNotMatch(retrace, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `retired RE:TRACE analysis-recovery surface is absent: ${removed}`);
}

assert.match(retrace, /const hayakuRequired = bridge\.includeHayaku === true;/, 'participating HAYAKU remains required independent of packet count');
assert.match(retrace, /const participants = installedRows\.filter\(row => row\.connected === true && row\.supported === true && HANDOFF_STORAGE_MODES\.includes/, 'dynamic storage gate keeps every installed/reachable owner with a verifiable mode as a participant');
assert.match(retrace, /participantOwners: participantSummary\.map\(item => item\.owner\)/, 'dynamic gate snapshots participating owner identities, including HAYAKU when its owner responds');
assert.match(retrace, /hayaku:\s*\{ required: preview\.includeHayaku === true, verified: false \}/, 'handoff journal tracks zero-packet HAYAKU owner');

process.stdout.write('hayaku_retrace_recovery_vault_handoff_hotfix_test: PASS\n');
