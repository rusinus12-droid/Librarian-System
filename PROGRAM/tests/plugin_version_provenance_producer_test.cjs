'use strict';
const nativeAssert = require('node:assert/strict');
let controls = 0;
const assert = new Proxy(nativeAssert, { get(target, name) {
  const value = target[name];
  return typeof value === 'function' ? (...args) => { controls++; return value(...args); } : value;
} });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildSourceCandidate, rewritePluginVersion, prepareSourceRefresh,
  refreshSourceProvenance, validateProvenance } = require('../tools/plugin_version_provenance.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const row = (version, sha256, bytes = 100) => ({ version, sha256, bytes });
const actual = { profile: 'source', packageVersion: '0.3.71', plugins: {
  changed: row('1.0.8', b), unchanged: row('1.0.8', a), draft: row('3.0.138', c)
} };
const catalog = {
  schema: 'librarian.plugin-release-provenance.v2', profile: 'source',
  releases: [{ packageVersion: '0.3.70', plugins: {
    changed: row('1.0.8', a), unchanged: row('1.0.8', a)
  } }, { packageVersion: '0.3.69', plugins: { changed: row('1.0.9', c) } }],
  historicalAnomalies: [],
  currentRelease: { packageVersion: '0.3.71', artifact: 'unpublished.zip', plugins: {
    changed: row('1.0.8', a), unchanged: row('1.0.8', a), draft: row('3.0.138', a)
  }, note: 'unpublished developer source input' }
};
const frozen = JSON.stringify(catalog);
assert.equal(typeof buildSourceCandidate, 'function', 'normal source candidate producer is available');
const candidate = buildSourceCandidate(catalog, actual);
assert.equal(candidate.currentRelease.plugins.changed.version, '1.0.10', 'collision allocation skips occupied patch versions');
assert.equal(candidate.currentRelease.plugins.unchanged.version, '1.0.8', 'identical historical bytes retain their version');
assert.equal(candidate.currentRelease.plugins.draft.version, '3.0.138', 'unpublished unoccupied draft retains its version');
assert.equal(candidate.currentRelease.packageVersion, '0.3.71', 'plugin repair does not promote package version');
assert.deepEqual(candidate.releases, catalog.releases, 'historical rows are immutable');
assert.deepEqual(candidate.historicalAnomalies, catalog.historicalAnomalies, 'historical anomalies are immutable');
assert.equal(JSON.stringify(catalog), frozen, 'planning does not mutate its input catalog');
assert.equal(candidate.currentRelease.sourceState, 'unpublished-source-candidate', 'source candidate is not a published archive');
assert.equal(candidate.releases.length, 2, 'former draft is not promoted into published history');
assert.ok(validateProvenance(catalog, actual).some(e => e.code === 'current_row_mismatch'), 'stale rows remain rejected');
const merelyRehashed = structuredClone(catalog);
merelyRehashed.currentRelease.plugins = structuredClone(actual.plugins);
assert.ok(validateProvenance(merelyRehashed, actual).some(e => e.code === 'current_version_collision'), 'hash-only refresh still rejects a historical version collision');
const ambiguous = structuredClone(catalog);
ambiguous.releases.push({ plugins: { unchanged: row('1.0.8', b) } });
ambiguous.historicalAnomalies = [{ owner: 'unchanged', version: '1.0.8', sha256: [a, b] }];
assert.equal(buildSourceCandidate(ambiguous, actual).currentRelease.plugins.unchanged.version, '1.0.9', 'an ambiguous version is never reused even for a known hash');
assert.throws(() => buildSourceCandidate({ ...catalog, releases: [{ plugins: { changed: row('1.0.8', 'invalid') } }] }, actual), /historical_row_invalid/, 'malformed historical rows cannot be repaired away');
assert.throws(() => buildSourceCandidate({ ...catalog, historicalAnomalies: [{ owner: 'changed', version: '1.0.8', sha256: [a, b] }] }, actual), /historical_anomaly_mismatch/, 'incorrect anomaly declarations remain rejected');
assert.throws(() => buildSourceCandidate({ ...catalog, currentRelease: { ...catalog.currentRelease, archiveSha256: a } }, actual), /published/, 'a current release carrying an archive receipt cannot be silently rewritten');
assert.throws(() => buildSourceCandidate(catalog, { ...actual, packageVersion: '0.3.72' }), /package_version/, 'producer cannot silently promote the package');

const old = Buffer.from("//@display-name Plugin v1.0.8\r\n//@version 1.0.8\r\nconst PLUGIN_VERSION = '1.0.8';\r\nconst behavior = '1.0.8'; // untouched\r\n");
const replacement = rewritePluginVersion(old, '1.0.8', '1.0.10');
assert.equal(replacement.toString(), old.toString().replace('Plugin v1.0.8', 'Plugin v1.0.10').replace('//@version 1.0.8', '//@version 1.0.10').replace("PLUGIN_VERSION = '1.0.8'", "PLUGIN_VERSION = '1.0.10'"), 'rewrite changes only three version metadata fields and preserves CRLF/body');
assert.deepEqual(rewritePluginVersion(old, '1.0.8', '1.0.8'), old, 'same-version rewrite preserves exact bytes');
const unversionedDisplay = Buffer.from('//@display-name Plugin\n//@version 1.0.8\nconst PLUGIN_VERSION = "1.0.8";\n');
assert.ok(rewritePluginVersion(unversionedDisplay, '1.0.8', '1.0.10').toString().startsWith('//@display-name Plugin\n'), 'unversioned display names stay unversioned');
assert.throws(() => rewritePluginVersion(Buffer.from(old.toString().replace("PLUGIN_VERSION = '1.0.8'", "PLUGIN_VERSION = '1.0.7'")), '1.0.8', '1.0.10'), /version/, 'internal/header mismatch is rejected before writing');
assert.throws(() => rewritePluginVersion(Buffer.concat([old, Buffer.from("const PLUGIN_VERSION = '1.0.8';\n")]), '1.0.8', '1.0.10'), /version/, 'duplicate internal declarations are rejected');
assert.throws(() => rewritePluginVersion(Buffer.from(old.toString().replace('Plugin v1.0.8', 'Plugin v1.0.7')), '1.0.8', '1.0.10'), /version/, 'display/header mismatch is rejected');
assert.throws(() => rewritePluginVersion(Buffer.from(old.toString().replace('//@display-name Plugin v1.0.8\r\n', '')), '1.0.8', '1.0.10'), /display_directive_count/, 'missing display directive is rejected');
assert.throws(() => rewritePluginVersion(Buffer.concat([old, Buffer.from('//@display-name Extra\n')]), '1.0.8', '1.0.10'), /display_directive_count/, 'duplicate unversioned display directive is rejected');

const programRoot = path.resolve(__dirname, '..');
const prepared = prepareSourceRefresh(programRoot);
assert.deepEqual(validateProvenance(prepared.catalog, prepared.actual), [], 'prepared candidate validates against its post-rewrite actual bytes');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'LIB-Provenance-Producer-'));
try {
  for (const directory of ['plugins', 'docs/release-provenance', 'server', 'sdk']) fs.mkdirSync(path.join(scratch, directory), { recursive: true });
  const { PLUGINS } = require('../tools/release_metadata.cjs');
  const files = ['VERSION.txt', 'server/server.cjs', 'sdk/MemorySuiteStorageClient.source.js', 'sdk/MemorySuiteStorageClient.libra.source.js', 'sdk/MemorySuiteComputeClient.source.js', 'docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json', ...Object.values(PLUGINS).map(([file]) => 'plugins/' + file)];
  for (const file of files) fs.copyFileSync(path.join(programRoot, file), path.join(scratch, file));
  const catalogPath = path.join(scratch, 'docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json');
  // Keep the negative controls active after the real source candidate has been refreshed.
  const scratchCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const { readReleaseMetadata: readScratchMetadata } = require('../tools/release_metadata.cjs');
  const scratchMetadata = readScratchMetadata(scratch);
  for (const owner of ['flashback', 'lia', 'libra', 'retrace']) {
    const file = path.join(scratch, 'plugins', PLUGINS[owner][0]);
    const historicalVersion = scratchCatalog.releases.at(-1).plugins[owner].version;
    fs.writeFileSync(file, rewritePluginVersion(fs.readFileSync(file), scratchMetadata.plugins[owner].version, historicalVersion));
  }
  const baselineBytes = fs.readFileSync(catalogPath);
  const backupFile = path.join(scratch, 'prior-source-catalog.json');
  const beforePins = files.map(file => sha(fs.readFileSync(path.join(scratch, file))));
  const dryRun = refreshSourceProvenance(scratch);
  assert.ok(dryRun.changed, 'stale candidate needs a refresh in dry-run');
  assert.deepEqual(files.map(file => sha(fs.readFileSync(path.join(scratch, file)))), beforePins, 'dry-run never writes source or catalog');
  assert.equal(fs.existsSync(backupFile), false, 'dry-run does not create a backup');
  assert.throws(() => refreshSourceProvenance(scratch, { write: true }), /backup_required/, 'write requires an explicit prior-candidate backup');
  assert.deepEqual(files.map(file => sha(fs.readFileSync(path.join(scratch, file)))), beforePins, 'missing backup error leaves all source/catalog bytes untouched');
  fs.writeFileSync(backupFile, 'conflicting backup');
  assert.throws(() => refreshSourceProvenance(scratch, { write: true, backupFile }), /backup_conflict/, 'existing different backup is never overwritten');
  assert.deepEqual(files.map(file => sha(fs.readFileSync(path.join(scratch, file)))), beforePins, 'backup collision error leaves all source/catalog bytes untouched');
  fs.unlinkSync(backupFile);
  const nativeWrite = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function (file, content, ...rest) {
    if (!injected && String(file) === path.join(scratch, 'plugins', 'LIA_Persona_Linker.js')) {
      injected = true;
      nativeWrite.call(fs, file, Buffer.from('partial injected write'));
      throw new Error('injected partial write failure');
    }
    return nativeWrite.call(fs, file, content, ...rest);
  };
  try {
    assert.throws(() => refreshSourceProvenance(scratch, { write: true, backupFile }), /injected partial write failure/, 'source write failure is surfaced');
  } finally { fs.writeFileSync = nativeWrite; }
  assert.ok(injected, 'the rollback negative control actually injected a partial source write');
  assert.deepEqual(files.map(file => sha(fs.readFileSync(path.join(scratch, file)))), beforePins, 'partial-write error rolls back all changed sources and catalog');
  injected = false;
  fs.writeFileSync = function (file, content, ...rest) {
    if (!injected && String(file) === catalogPath) {
      injected = true;
      nativeWrite.call(fs, file, Buffer.from('partial injected catalog'));
      throw new Error('injected partial catalog failure');
    }
    return nativeWrite.call(fs, file, content, ...rest);
  };
  try {
    assert.throws(() => refreshSourceProvenance(scratch, { write: true, backupFile }), /injected partial catalog failure/, 'catalog write failure is surfaced');
  } finally { fs.writeFileSync = nativeWrite; }
  assert.ok(injected, 'the rollback negative control actually injected a partial catalog write');
  assert.deepEqual(files.map(file => sha(fs.readFileSync(path.join(scratch, file)))), beforePins, 'partial catalog write rolls back all changed sources and catalog');
  const first = refreshSourceProvenance(scratch, { write: true, backupFile });
  assert.deepEqual(fs.readFileSync(backupFile), baselineBytes, 'former currentRelease and whole raw catalog are backed up before writing');
  assert.deepEqual(validateProvenance(first.catalog, first.actual), [], 'written candidate remains collision-safe');
  const historicalPrefix = bytes => bytes.toString().slice(0, bytes.toString().indexOf('  "currentRelease":'));
  assert.equal(historicalPrefix(fs.readFileSync(catalogPath)), historicalPrefix(baselineBytes), 'all bytes preceding currentRelease, including historical rows/anomalies/coverage, are unchanged');
  const { GUIDES, readReleaseMetadata, renderGuide } = require('../tools/release_metadata.cjs');
  const metadata = readReleaseMetadata(scratch);
  for (const file of GUIDES) {
    const source = fs.readFileSync(path.join(programRoot, '..', file), 'utf8');
    const once = renderGuide(source, metadata);
    assert.equal(renderGuide(once, metadata), once, `${file}: normal guide producer is byte-idempotent`);
    const maskRows = value => value.replace(/^(- (?:Flashback Memory|HAYAKU Locator Continuity|LIBRA|LIA Persona Linker|RE:TRACE) )\d+\.\d+\.\d+(?=\r?$)/gm, '$1<VERSION>');
    assert.equal(maskRows(once), maskRows(source), `${file}: only plugin installation inventory version rows change`);
  }
  const pins = files.map(file => sha(fs.readFileSync(path.join(scratch, file))));
  const second = refreshSourceProvenance(scratch, { write: true, backupFile });
  assert.equal(second.changed, false, 'repeated producer execution is idempotent');
  assert.deepEqual(files.map(file => sha(fs.readFileSync(path.join(scratch, file)))), pins, 'repeat write leaves all plugin/catalog bytes fixed');
  assert.deepEqual(fs.readFileSync(backupFile), baselineBytes, 'repeat write does not overwrite the earlier candidate backup');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
console.log(JSON.stringify({ test: 'plugin_version_provenance_producer', controls, ok: true }));
