'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { test } = require('node:test');
const program = path.resolve(__dirname, '..');
const tool = path.join(program, 'tools/update_manifest.cjs');
const inheritedRequires = [];
for (let i = 0; i < process.execArgv.length; i++) {
  if (process.execArgv[i] === '--require' || process.execArgv[i] === '-r') inheritedRequires.push(process.execArgv[i], process.execArgv[++i]);
  else if (process.execArgv[i].startsWith('--require=')) inheritedRequires.push(process.execArgv[i]);
}
const plugins = {
  flashback: 'Flashback_Memory.js', hayaku: 'HAYAKU_Locator_Continuity.js',
  libra: 'LIBRA.js', lia: 'LIA_Persona_Linker.js', retrace: 'RETRACE.js', gradia: 'GRADIA.js'
};
const names = {
  libra: ['LIBRA_RECALL_BM25F_COMPUTE_OPERATION', 'LIBRA_RECALL_BM25F_COMPUTE_FINGERPRINT'],
  lia: ['LIA_WORLD_LORE_COMPUTE_OPERATION', 'LIA_WORLD_LORE_COMPUTE_FINGERPRINT'],
  hayaku: ['HAYAKU_SPARSE_RRF_COMPUTE_OPERATION', 'HAYAKU_SPARSE_RRF_COMPUTE_FINGERPRINT']
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = owner => 'plugins/' + plugins[owner];
const original = Object.fromEntries(Object.entries(plugins).map(([owner, file]) => [owner, fs.readFileSync(path.join(program, 'plugins', file), 'utf8')]));
const declarations = Object.fromEntries(Object.entries(names).map(([owner, pair]) => [owner, pair.map(name => {
  const match = original[owner].match(new RegExp('\\bconst\\s+' + name + '\\s*=\\s*[\'\"]([^\'\"]+)[\'\"]\\s*;'));
  assert.ok(match, 'Current readable declaration: ' + name);
  return match[1];
})]));
const version = owner => original[owner].match(/^\/\/@version\s+(\d+\.\d+\.\d+)\s*$/m)[1];
const source = (owner, pair = declarations[owner], renamed = false) => {
  const header = '//@version ' + version(owner) + '\n';
  if (!names[owner]) return header + 'const modelOnly=true;\n';
  return header + pair.map((value, index) => 'const ' + (renamed ? ['a', 'b'][index] : names[owner][index]) + '=' + JSON.stringify(value) + ';').join('\n') + '\n';
};
function put(root, relativePath, bytes) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function bindings(root) {
  return Object.fromEntries(Object.keys(plugins).map(owner => [relative(owner), sha(fs.readFileSync(path.join(root, relative(owner))))]));
}
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-minified-binding-'));
  const canonical = path.join(temp, 'canonical'), staged = path.join(temp, 'staged');
  for (const root of [canonical, staged]) {
    for (const owner of Object.keys(plugins)) put(root, relative(owner), source(owner));
    for (const file of ['program-manifest.json', 'VERSION.txt', 'sdk/MemorySuiteStorageClient.source.js', 'sdk/MemorySuiteStorageClient.libra.source.js', 'sdk/MemorySuiteComputeClient.source.js', 'sdk/MemorySuiteExecutionContract.source.js']) {
      put(root, file, fs.readFileSync(path.join(program, file)));
    }
  }
  return { temp, canonical, staged, captured: bindings(canonical) };
}
function snapshot(root) {
  const result = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file).split(path.sep).join('/')] = sha(fs.readFileSync(file));
    }
  }
  walk(root);
  return result;
}
function run(f, env = {}) {
  return cp.spawnSync(process.execPath, [...inheritedRequires, f.tool || tool], { cwd: f.staged, encoding: 'utf8',
    env: { ...process.env, LIBRARIAN_PROGRAM_ROOT: f.staged,
      LIBRARIAN_MANIFEST_DECLARATION_ROOT: f.canonical,
      LIBRARIAN_MANIFEST_DECLARATION_BINDINGS: JSON.stringify(f.captured), ...env } });
}
function rejectWithoutWrites(f, pattern, env) {
  const before = snapshot(f.staged), canonicalBefore = snapshot(f.canonical);
  const result = run(f, env);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
  assert.deepEqual(snapshot(f.staged), before, 'Failure must leave every staged byte unchanged');
  assert.deepEqual(snapshot(f.canonical), canonicalBefore, 'Canonical source is read-only');
}
function withFixture(body) {
  const f = fixture();
  try { return body(f); } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
}
function renameAll(f) { for (const owner of Object.keys(names)) put(f.staged, relative(owner), source(owner, declarations[owner], true)); }
function releaseBindings(f) {
  return JSON.stringify({ schema: 'librarian.plugin-transform-bindings.v1', profile: 'release',
    plugins: Object.fromEntries(Object.keys(names).map(owner => [relative(owner), {
      sourceSha256: f.captured[relative(owner)],
      artifactSha256: sha(fs.readFileSync(path.join(f.staged, relative(owner))))
    }])) });
}

test('a captured release transform can eliminate retired pilot declarations without losing their source identity', () => withFixture(f => {
  for (const owner of Object.keys(names)) put(f.staged, relative(owner), '//@version ' + version(owner) + '\nvoid 0;\n');
  const before = snapshot(f.staged);
  const result = run(f, { LIBRARIAN_MANIFEST_TRANSFORM_BINDINGS: releaseBindings(f) });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.staged, 'program-manifest.json')));
  for (const [owner, field] of [['lia','liaWorldLorePilot'],['libra','libraRecallBm25fPilot'],['hayaku','hayakuSparseRrfPilot']]) {
    const pilot = manifest.dataContract.computePlane[field];
    assert.equal(pilot.retired, true);
    assert.equal(pilot.operation, declarations[owner][0]);
    assert.equal(pilot.algorithmFingerprint, declarations[owner][1]);
    assert.equal(manifest.files[relative(owner)].sha256, before[relative(owner)]);
  }
}));

test('a staged change after release binding capture is rejected without writes', () => withFixture(f => {
  renameAll(f); const binding = releaseBindings(f);
  fs.appendFileSync(path.join(f.staged, relative('lia')), '\nvoid "changed";\n');
  rejectWithoutWrites(f, /manifest_release_transform_mismatch:lia/, { LIBRARIAN_MANIFEST_TRANSFORM_BINDINGS: binding });
}));

test('a release receipt cannot authorize metadata from a different source', () => withFixture(f => {
  renameAll(f); const binding = JSON.parse(releaseBindings(f));
  binding.plugins[relative('lia')].sourceSha256 = '0'.repeat(64);
  rejectWithoutWrites(f, /manifest_release_transform_mismatch:lia/, { LIBRARIAN_MANIFEST_TRANSFORM_BINDINGS: JSON.stringify(binding) });
}));

test('an active pilot still requires its emitted fingerprint even with a release receipt', () => withFixture(f => {
  put(f.canonical, relative('flashback'), source('flashback') + "const FLASHBACK_HASH_COMPUTE_OPERATION='flashback.hash-embedding-batch.v1';\nconst FLASHBACK_HASH_COMPUTE_FINGERPRINT='active-fingerprint';\n");
  put(f.staged, relative('flashback'), source('flashback') + "const renamed='flashback.hash-embedding-batch.v1';\n");
  f.captured = bindings(f.canonical);
  rejectWithoutWrites(f, /manifest_release_literal_missing:flashback-fingerprint/, { LIBRARIAN_MANIFEST_TRANSFORM_BINDINGS: releaseBindings(f) });
}));

test('readable declarations remain authoritative without a canonical fallback environment', () => withFixture(f => {
  const result = run(f, { LIBRARIAN_MANIFEST_DECLARATION_ROOT: 'unavailable', LIBRARIAN_MANIFEST_DECLARATION_BINDINGS: 'invalid' });
  assert.equal(result.status, 0, result.stderr);
  const plane = JSON.parse(fs.readFileSync(path.join(f.staged, 'program-manifest.json'))).dataContract.computePlane;
  assert.equal(plane.libraRecallBm25fPilot.algorithmFingerprint, declarations.libra[1]);
  assert.equal(Object.hasOwn(plane, 'flashbackPilot'), false);
}));

test('renamed release declarations use the captured current readable pair and preserve plugin bytes', () => withFixture(f => {
  renameAll(f);
  const before = snapshot(f.staged), canonicalBefore = snapshot(f.canonical);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.staged, 'program-manifest.json')));
  assert.equal(manifest.dataContract.computePlane.libraRecallBm25fPilot.algorithmFingerprint, declarations.libra[1]);
  assert.equal(manifest.dataContract.computePlane.libraRecallBm25fPilot.operation, declarations.libra[0]);
  assert.equal(Object.hasOwn(manifest.dataContract.computePlane, 'flashbackPilot'), false);
  const after = snapshot(f.staged);
  delete before['program-manifest.json']; delete after['program-manifest.json'];
  assert.deepEqual(after, before);
  assert.deepEqual(snapshot(f.canonical), canonicalBefore);
  for (const owner of Object.keys(plugins)) assert.equal(manifest.files[relative(owner)].sha256, after[relative(owner)]);
}));

test('a changed canonical fingerprint is resolved dynamically rather than through a stale value table', () => withFixture(f => {
  const pair = [declarations.libra[0], 'f'.repeat(64)];
  put(f.canonical, relative('libra'), source('libra', pair));
  f.captured = bindings(f.canonical);
  put(f.staged, relative('libra'), source('libra', pair, true));
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.staged, 'program-manifest.json'))).dataContract.computePlane.libraRecallBm25fPilot.algorithmFingerprint, pair[1]);
}));

for (const [label, body, pattern] of [
  ['missing fingerprint', 'const a=' + JSON.stringify(declarations.libra[0]) + ';', /manifest_release_literal_missing:libra-fingerprint/],
  ['missing operation', 'const b=' + JSON.stringify(declarations.libra[1]) + ';', /manifest_release_literal_missing:libra-operation/],
  ['fingerprint only inside a larger literal', 'const a=' + JSON.stringify(declarations.libra[0]) + ';const b=' + JSON.stringify('prefix-' + declarations.libra[1]) + ';', /manifest_release_literal_missing:libra-fingerprint/],
  ['fingerprint only in a comment', 'const a=' + JSON.stringify(declarations.libra[0]) + ';/* ' + JSON.stringify(declarations.libra[1]) + ' */', /manifest_release_literal_missing:libra-fingerprint/],
  ['fingerprint only inside a documentation string', 'const a=' + JSON.stringify(declarations.libra[0]) + ';const doc=' + JSON.stringify("example '" + declarations.libra[1] + "'") + ';', /manifest_release_literal_missing:libra-fingerprint/]
]) test(label + ' fails before any write', () => withFixture(f => {
  put(f.staged, relative('libra'), '//@version ' + version('libra') + '\n' + body);
  rejectWithoutWrites(f, pattern);
}));
for (const context of ['return', 'throw']) {
  for (const [kind, valueIndex, otherIndex] of [['fingerprint', 1, 0], ['operation', 0, 1]]) {
    test(context + ' regex-only ' + kind + ' fails before any write', () => withFixture(f => {
      const body = 'const present=' + JSON.stringify(declarations.libra[otherIndex]) + ';function x(){' + context + ' /"' + declarations.libra[valueIndex] + '"/;}';
      put(f.staged, relative('libra'), '//@version ' + version('libra') + '\n' + body);
      rejectWithoutWrites(f, new RegExp('manifest_release_literal_missing:libra-' + kind));
    }));
  }
}
test('an unavailable local tokenizer rejects renamed inputs before any write', () => withFixture(f => {
  renameAll(f);
  put(f.staged, 'tools/update_manifest.cjs', fs.readFileSync(tool));
  put(f.staged, 'tools/lib/ultralight_scan.cjs', fs.readFileSync(path.join(program, 'tools/lib/ultralight_scan.cjs')));
  for(const dependency of ['tools/lib/sdk_variants.cjs'])put(f.staged,dependency,fs.readFileSync(path.join(program,dependency)));
  put(f.staged, 'tools/build_plugins.cjs', "'use strict';module.exports={resolveAcorn:()=>null};\n");
  f.tool = path.join(f.staged, 'tools/update_manifest.cjs');
  rejectWithoutWrites(f, /manifest_declaration_parser_unavailable/);
}));
test('ordinary readable model-only generation needs no local tokenizer package', () => withFixture(f => {
  put(f.staged, 'tools/update_manifest.cjs', fs.readFileSync(tool));
  put(f.staged, 'tools/lib/ultralight_scan.cjs', fs.readFileSync(path.join(program, 'tools/lib/ultralight_scan.cjs')));
  for(const dependency of ['tools/lib/sdk_variants.cjs'])put(f.staged,dependency,fs.readFileSync(path.join(program,dependency)));
  put(f.staged, 'tools/build_plugins.cjs', "'use strict';module.exports={resolveAcorn:()=>{throw Error('tokenizer_must_remain_lazy')}};\n");
  f.tool = path.join(f.staged, 'tools/update_manifest.cjs');
  const result = run(f); assert.equal(result.status, 0, result.stderr);
}));

test('a canonical source changed after capture is rejected without re-binding', () => withFixture(f => {
  renameAll(f); fs.appendFileSync(path.join(f.canonical, relative('libra')), '\n// post-capture change\n');
  rejectWithoutWrites(f, /manifest_declaration_source_changed:libra/);
}));
test('canonical and staged declared versions must match', () => withFixture(f => {
  renameAll(f); put(f.staged, relative('libra'), source('libra', declarations.libra, true).replace('//@version ' + version('libra'), '//@version 99.0.0'));
  rejectWithoutWrites(f, /manifest_declaration_version_mismatch:libra/);
}));
test('renamed declarations require an explicit canonical root and captured bindings', () => withFixture(f => {
  renameAll(f); rejectWithoutWrites(f, /manifest_declaration_root_required:libra|manifest_declaration_root_required:lia/, { LIBRARIAN_MANIFEST_DECLARATION_ROOT: '', LIBRARIAN_MANIFEST_DECLARATION_BINDINGS: '' });
}));
test('a missing canonical root fails before any write', () => withFixture(f => {
  renameAll(f); rejectWithoutWrites(f, /manifest_declaration_source_unavailable:lia|manifest_declaration_source_unavailable:libra/, { LIBRARIAN_MANIFEST_DECLARATION_ROOT: path.join(f.temp, 'missing') });
}));
test('malformed captured binding JSON fails before any write', () => withFixture(f => {
  renameAll(f); rejectWithoutWrites(f, /manifest_declaration_binding_invalid:lia/, { LIBRARIAN_MANIFEST_DECLARATION_BINDINGS: '{broken' });
}));
test('a missing per-plugin captured binding fails before any write', () => withFixture(f => {
  renameAll(f); delete f.captured[relative('lia')]; rejectWithoutWrites(f, /manifest_declaration_binding_invalid:lia/);
}));
test('a wrong per-plugin captured SHA fails before any write', () => withFixture(f => {
  renameAll(f); f.captured[relative('lia')] = '0'.repeat(64); rejectWithoutWrites(f, /manifest_declaration_source_changed:lia/);
}));
test('duplicate canonical declarations cannot be chosen by position', () => withFixture(f => {
  renameAll(f); fs.appendFileSync(path.join(f.canonical, relative('libra')), 'const ' + names.libra[1] + '="' + declarations.libra[1] + '";\n');
  f.captured = bindings(f.canonical); rejectWithoutWrites(f, /manifest_constant_ambiguous:libra-fingerprint/);
}));
test('partial named staged declarations cannot use a fallback to conceal corruption', () => withFixture(f => {
  put(f.staged, relative('libra'), '//@version ' + version('libra') + '\nconst ' + names.libra[0] + '=' + JSON.stringify(declarations.libra[0]) + ';const z=' + JSON.stringify(declarations.libra[1]) + ';');
  rejectWithoutWrites(f, /manifest_constant_missing:libra-fingerprint/);
}));
test('a stale renamed Flashback hash pilot cannot be hidden by a model-only canonical source', () => withFixture(f => {
  put(f.staged, relative('flashback'), '//@version ' + version('flashback') + '\nconst a="flashback.hash-embedding-batch.v1";const b="legacy-fingerprint";');
  rejectWithoutWrites(f, /manifest_declaration_absence_mismatch:flashback/);
}));

if (process.env.MANIFEST_RELEASE_ARTIFACT_DIR) test('the captured actual five release artifacts regenerate strict metadata without changing their bytes', () => withFixture(f => {
  f.canonical = program; f.captured = bindings(program);
  for (const owner of Object.keys(plugins)) put(f.staged, relative(owner), fs.readFileSync(path.join(process.env.MANIFEST_RELEASE_ARTIFACT_DIR, plugins[owner])));
  const before = snapshot(f.staged), result = run(f); assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.staged, 'program-manifest.json')));
  assert.equal(manifest.dataContract.computePlane.libraRecallBm25fPilot.algorithmFingerprint, declarations.libra[1]);
  const after = snapshot(f.staged); delete before['program-manifest.json']; delete after['program-manifest.json'];
  assert.deepEqual(after, before);
  for (const owner of Object.keys(plugins)) assert.equal(manifest.files[relative(owner)].sha256, after[relative(owner)]);
}));
