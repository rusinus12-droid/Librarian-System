'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const libra = read('plugins/LIBRA.js');
const hayaku = read('plugins/HAYAKU_Locator_Continuity.js');
const flashback = read('plugins/Flashback_Memory.js');
const lia = read('plugins/LIA_Persona_Linker.js');
const retrace = read('plugins/RETRACE.js');
const server = read('server/server.cjs');

// Release metadata.
assert.match(libra, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.ok(libra.includes(releaseText("const PLUGIN_VERSION = '{libra}';")));
assert.match(hayaku, releasePattern("^\\/\\/@version {hayaku}\\s*$", "m"));
assert.ok(hayaku.includes(releaseText("const PLUGIN_VERSION = '{hayaku}';")));
assert.match(flashback, releasePattern("^\\/\\/@version {flashback}\\s*$", "m"));
assert.ok(flashback.includes(releaseText("const PLUGIN_VERSION = '{flashback}';")));
assert.match(lia, releasePattern("^\\/\\/@version {lia}\\s*$", "m"));
assert.ok(lia.includes(releaseText('const PLUGIN_VERSION = "{lia}";')));
assert.match(retrace, releasePattern("^\\/\\/@version {retrace}\\s*$", "m"), releaseText('RE:TRACE GUI workspace release is {retrace}'));

// Stable plugin identities and peer protocol: major product version bumps must not
// become protocol/schema/storage breaks.
for (const [name, source, pluginId, handoff, retraceRequired] of [
  // LIBRA's handoff contract was deliberately bumped to the lens-carrying v2 (LIBRA 2.3.181 /
  // RE:TRACE 1.9.90, "Complete immutable lens handoff"); RE:TRACE requires it in lockstep below.
  ['LIBRA', libra, "const PLUGIN_NAME = 'libra';", "libra.handoff_immutable_source_lenses.v2", 'LIBRA_REQUIRED_HANDOFF_CONTRACT'],
  ['HAYAKU', hayaku, "const HAYAKU_PLUGIN_ID = 'hayaku_locator_continuity';", "hayaku.handoff_immutable_source.v1", 'HAYAKU_REQUIRED_HANDOFF_CONTRACT'],
  ['FLASHBACK', flashback, "const PLUGIN_SLUG = 'flashback_memory';", "flashback_memory.handoff_immutable_source.v2", 'FLASHBACK_REQUIRED_HANDOFF_CONTRACT'],
  ['LIA', lia, "pluginId:'lia_persona_linker'", 'lia.live_persona_handoff_immutable_source.v1', 'LIA_REQUIRED_HANDOFF_CONTRACT']
]) {
  assert.ok(source.includes('retrace.peer_compatibility.v1'), `${name} peer schema unchanged`);
  assert.ok(source.includes('RETRACE_PEER_PROTOCOL_MAJOR = 1'), `${name} peer protocol major unchanged`);
  assert.ok(source.includes(handoff), `${name} handoff contract unchanged`);
  assert.ok(retrace.includes(`const ${retraceRequired} = '${handoff}';`), `RE:TRACE requires the ${name} handoff contract the peer advertises`);
  assert.ok(source.includes(pluginId), `${name} stable plugin id unchanged`);
}

// Core storage/data contracts remain byte-addressable under their previous namespaces.
assert.ok(libra.includes("const PREFIX = 'libra:v1';"));
assert.ok(libra.includes("const MEMORY_SCHEMA = 'libra.canonical_memory.v1';"));
assert.ok(hayaku.includes("const STORAGE_LEDGER_VERSION = 'hayaku_storage_ledger_v2';"));
assert.ok(hayaku.includes("const TURN_WORLDLINE_VERSION = 'hayaku_turn_worldline_v2';"));
assert.ok(hayaku.includes("const HAYAKU_RETRACE_COMPATIBILITY_BEACON_KEY = 'hayaku.v2.retrace_compatibility.v1';"));
assert.ok(flashback.includes("const PLUGIN_STORAGE_ID = 'vector_rag_memory';") || flashback.includes("const PLUGIN_STORAGE_ID = 'flashback_memory';"), 'Flashback durable namespace remains defined');
assert.ok(flashback.includes('flashback-memory-bridge-ipc-v1'));
assert.ok(lia.includes('lia-persona-handoff-ipc-v1'));

// HAYAKU 3.0.42 remains the native recovery owner. RE:TRACE only probes the
// authenticated owner and no longer negotiates or delegates recovery actions.
assert.ok(hayaku.includes('nativeOtherAxRepair: true'));
assert.ok(hayaku.includes("repairOwner: 'hayaku'"));
assert.ok(hayaku.includes('nativeColdStart: true'));
assert.ok(retrace.includes('const probeLiveHayakuOwner = async'));
assert.ok(!retrace.includes('repairOwnedByHayaku'));
assert.ok(!retrace.includes('coldStartOwnedByHayaku'));
assert.ok(!retrace.includes('delegateHayakuNativeRepair'));
assert.ok(!retrace.includes('delegateHayakuNativeColdStart'));
assert.ok(retrace.includes('const versionAtLeast = (value, minimum) => {'));
const versionAtLeastCalls = (retrace.match(/(?<!const )versionAtLeast\s*\(/g) || []).length;
assert.equal(versionAtLeastCalls, 0, 'RE:TRACE peer execution does not gate on product version');

// Librarian System server records client version only as diagnostic metadata; it must not
// parse product semver as a storage protocol gate.
assert.ok(server.includes("const version = String(request.headers['x-memory-suite-plugin-version'] || '').trim().slice(0, 80);"));
assert.equal((server.match(/semver/gi) || []).length, 0);
assert.equal((server.match(/versionAtLeast/gi) || []).length, 0);

// Portable backup envelopes must advertise the new release versions without changing schema.
assert.ok(libra.includes('"old":"2.3.24","new":PLUGIN_VERSION,"pluginVersion":PLUGIN_VERSION'));
assert.ok(hayaku.includes('"old":"3.0.42","new":PLUGIN_VERSION,"pluginVersion":PLUGIN_VERSION'));
assert.ok(flashback.includes('"old":"1.0.25","new":PLUGIN_VERSION,"pluginVersion":PLUGIN_VERSION'));

process.stdout.write('release_major_version_rebase_compatibility_test: PASS\n');

