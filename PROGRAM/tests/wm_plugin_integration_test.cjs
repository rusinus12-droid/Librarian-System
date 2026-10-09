'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const programDir = path.resolve(__dirname, '..');
const wmRoot = path.join(programDir, 'wm');
const apiFile = path.join(programDir, 'tools/build_wm_source.cjs');
// An absent integration API is an explicit assertion failure, not a failed import.
const api = fs.existsSync(apiFile) ? require(apiFile) : {};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// P0b scoped official UI-id cleanup adds 1,015 Full bytes; frozen P0a baseline remains in its checkpoint.
const approved = '03cbbda4977c3574b99fe668802000c284352317e5d269a8168220ce13d2488c';
function requireApi() {
  assert.equal(typeof api.assembleWmSource, 'function', 'WM source assembly API must be available in the unified LIB project');
  assert.equal(typeof api.writeWmDevelopmentSource, 'function', 'WM development output adapter must be available');
}

test('wm_assembly_preserves_approved_candidate_bytes', async () => {
  requireApi();
  const assembled = await api.assembleWmSource({ wmRoot, verifyPins: true });
  assert.equal(assembled.sourceSha256, approved);
  assert.equal(sha(assembled.code), approved);
  assert.equal(Buffer.byteLength(assembled.code), 5810381);
  assert.match(assembled.code, /@name libra_world_manager\b/);
  assert.equal(fs.existsSync(path.join(wmRoot, 'dist')), false, 'assembly must not create a second install-artifact folder');
});

test('wm_source_tree_contains_all_pinned_fixture_inputs', async () => {
  requireApi();
  const assembled = await api.assembleWmSource({ wmRoot, verifyPins: true });
  const audit = new Map(assembled.inputs.map(row => [row.path, row.sha256]));
  assert.equal(audit.size, assembled.inputs.length, 'the read audit must not repeat inputs');
  const pins = JSON.parse(fs.readFileSync(path.join(wmRoot, 'BASE-PINS.json'), 'utf8'));
  assert.equal(pins.files.length, 530);
  for (const row of pins.files) {
    const relative = path.posix.join(pins.base, row.file);
    assert.equal(audit.get(relative), row.sha256, 'immutable fixture must be verified and audited: ' + relative);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(wmRoot, 'src/build-manifest.json'), 'utf8'));
  const production = ['BASE-PINS.json', 'tools/build-portable.cjs', 'tools/factory-edits.cjs',
    'src/build-manifest.json', 'tools/runtime-factory-baseline-owner.source.js',
    'tools/runtime-factory-detached-entry.source.js', 'tools/runtime-factory-controller.source.js',
    'tools/runtime-factory-health-orchestrator.source.js', 'src/MemorySuiteSnapshotCache.cjs',
    'src/wm-versioned-snapshot.cjs', 'src/versioned-canonical-bridge.source.js',
    'src/wm-common-derived-cache.source.js', 'src/wm-native-derived-cache.source.js',
    ...manifest.parts.map(row => 'src/' + row.file)];
  for (const relative of production) assert.equal(audit.get(relative), sha(fs.readFileSync(path.join(wmRoot, relative))), relative);
  for (const filename of ['LIBRA World Manager Full.js', 'LIBRA World Manager.js']) {
    assert.equal(audit.get('references/frozen-B/dist/' + filename), sha(fs.readFileSync(path.join(wmRoot, 'references/frozen-B/dist', filename))));
  }
  assert.equal([...audit.keys()].some(relative => relative.startsWith('dist/')), false, 'current output cannot become assembly input');
});

function damagedFixture(kind) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-wm-pin-'));
  const root = path.join(temp, 'wm');
  fs.mkdirSync(root);
  const pins = JSON.parse(fs.readFileSync(path.join(wmRoot, 'BASE-PINS.json'), 'utf8'));
  fs.copyFileSync(path.join(wmRoot, 'BASE-PINS.json'), path.join(root, 'BASE-PINS.json'));
  const damaged = pins.files[0];
  for (const row of pins.files) {
    const relative = path.join(pins.base, row.file), target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (row === damaged) {
      if (kind === 'modified') fs.writeFileSync(target, 'synthetic changed immutable fixture\n');
    } else fs.symlinkSync(path.join(wmRoot, relative), target);
  }
  for (const name of ['src', 'tools', 'build-support', 'references/frozen-B']) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.symlinkSync(path.join(wmRoot, name), path.join(root, name));
  }
  return { temp, root };
}

test('wm_missing_or_modified_pin_fails_before_output', async () => {
  requireApi();
  for (const kind of ['missing', 'modified']) {
    const fixture = damagedFixture(kind);
    const output = path.join(fixture.temp, 'Full');
    try {
      await assert.rejects(api.assembleWmSource({ wmRoot: fixture.root, verifyPins: true }), /WM_(?:PIN_MISSING|PIN_MISMATCH):/);
      await assert.rejects(api.writeWmDevelopmentSource({ programDir: fixture.temp, fullOutputDir: output }), /WM_(?:PIN_MISSING|PIN_MISMATCH):/);
      assert.equal(fs.existsSync(output), false, 'invalid input must fail before creating the output folder');
    } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
  }
});

test('wm_development_adapter_writes_full_with_unified_filename_and_receipt', async () => {
  requireApi();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-wm-full-'));
  try {
    const receipt = await api.writeWmDevelopmentSource({ programDir, fullOutputDir: temp });
    assert.deepEqual(Object.keys(receipt).sort(), ['filename', 'inputDigest', 'outputBytes', 'outputSha256', 'owner', 'profile', 'transforms']);
    assert.equal(receipt.owner, 'wm');
    assert.equal(receipt.profile, 'source');
    assert.equal(receipt.filename, 'LIBRA_World_Manager.js');
    assert.equal(receipt.outputSha256, approved);
    assert.equal(receipt.outputBytes, 5810381);
    assert.match(receipt.inputDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(receipt.transforms, []);
    assert.deepEqual(fs.readdirSync(temp), ['LIBRA_World_Manager.js']);
    assert.equal(sha(fs.readFileSync(path.join(temp, receipt.filename))), approved);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('wm_pin_manifest_cannot_authorize_changed_immutable_bytes', async () => {
  requireApi();
  const fixture = damagedFixture('modified');
  const manifest = path.join(fixture.root, 'BASE-PINS.json');
  const pins = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  pins.files[0].sha256 = sha(fs.readFileSync(path.join(fixture.root, pins.base, pins.files[0].file)));
  fs.writeFileSync(manifest, JSON.stringify(pins));
  try {
    await assert.rejects(api.writeWmDevelopmentSource({ programDir: fixture.temp, fullOutputDir: path.join(fixture.temp, 'Full') }), /WM_PIN_MANIFEST_MISMATCH/);
    assert.equal(fs.existsSync(path.join(fixture.temp, 'Full')), false);
  } finally { fs.rmSync(fixture.temp, { recursive: true, force: true }); }
});

test('wm_required_bridge_input_cannot_be_silently_omitted', async () => {
  requireApi();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-wm-required-'));
  const root = path.join(temp, 'wm');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const name of ['BASE-PINS.json', 'tools', 'references', 'build-support']) fs.symlinkSync(path.join(wmRoot, name), path.join(root, name));
  for (const name of fs.readdirSync(path.join(wmRoot, 'src'))) {
    if (name !== 'versioned-canonical-bridge.source.js') fs.symlinkSync(path.join(wmRoot, 'src', name), path.join(root, 'src', name));
  }
  try {
    await assert.rejects(api.writeWmDevelopmentSource({ programDir: temp, fullOutputDir: path.join(temp, 'Full') }), /WM_REQUIRED_INPUT_MISSING:src\/versioned-canonical-bridge.source.js/);
    assert.equal(fs.existsSync(path.join(temp, 'Full')), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('wm_historical_fixture_mapping_preserves_both_approved_profile_hashes', () => {
  const helper = path.join(wmRoot, 'tools/wm-historical-fixture-paths.cjs');
  const lookup = fs.existsSync(helper) ? require(helper).frozenBArtifact : undefined;
  assert.equal(typeof lookup, 'function', 'historical profile mapping must be explicit');
  for (const [profile, filename] of [['source', 'LIBRA World Manager Full.js'], ['release', 'LIBRA World Manager.js']]) {
    const artifact = lookup({ wmRoot, profile });
    assert.equal(path.basename(artifact.path), filename);
    assert.equal(sha(fs.readFileSync(artifact.path)), artifact.sha256);
  }
  assert.throws(() => lookup({ wmRoot, profile: 'unknown' }), /WM_FIXTURE_PROFILE_INVALID/);
});

test('wm_privacy_target_is_bound_to_the_explicit_new_artifact_hash', () => {
  const helper = require(path.join(wmRoot, 'tools/wm-historical-fixture-paths.cjs'));
  assert.equal(typeof helper.privacyArtifacts, 'function', 'privacy adapter must accept one explicitly identified LIB artifact');
  const artifact = path.join(programDir, 'plugins/LIBRA_World_Manager.js');
  const targets = helper.privacyArtifacts({ wmRoot, artifact, label: 'LIBRA_World_Manager.js', sha256: approved });
  assert.deepEqual(targets, [{ file: 'LIBRA_World_Manager.js', path: artifact, sha256: approved }]);
  assert.throws(() => helper.privacyArtifacts({ wmRoot, artifact, label: 'LIBRA_World_Manager.js', sha256: '0'.repeat(64) }), /WM_PRIVACY_ARTIFACT_HASH_MISMATCH/);
  assert.equal(helper.privacyArtifacts({ wmRoot }).length, 2, 'legacy defaults are preserved when no explicit target is supplied');
});

for (const missing of ['tools/factory-edits.cjs', 'src/parts/00-plugin-shell-and-args.js']) test('wm_missing_active_overlay_source_fails_before_output: ' + missing, async () => {
  requireApi();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-wm-overlay-'));
    const root = path.join(temp, 'wm');
    const linkExcept = (source, target, relative = '') => {
      if (relative === missing) return;
      if (!relative || missing.startsWith(relative + '/')) {
        fs.mkdirSync(target, { recursive: true });
        for (const name of fs.readdirSync(source)) linkExcept(path.join(source, name), path.join(target, name), relative ? relative + '/' + name : name);
      } else fs.symlinkSync(source, target);
    };
    linkExcept(wmRoot, root);
    try {
      await assert.rejects(api.writeWmDevelopmentSource({ programDir: temp, fullOutputDir: path.join(temp, 'Full') }), error => error.message === 'WM_REQUIRED_INPUT_MISSING:' + missing);
      assert.equal(fs.existsSync(path.join(temp, 'Full')), false);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('wm_development_cli_does_not_silently_emit_full_for_a_legacy_min_request', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-wm-cli-'));
  const output = path.join(temp, 'Full');
  try {
    const result = spawnSync(process.execPath, [path.join(wmRoot, 'tools/build-portable.cjs')], {
      encoding: 'utf8', env: { PATH: path.dirname(process.execPath), WM_BUILD_MIN: '1', WM_FULL_OUTPUT_DIR: output,
        NODE_OPTIONS: '--require=' + JSON.stringify(path.join(wmRoot, 'tools/strict-offline-guard.cjs')) }
    });
    assert.equal(result.status, 1, 'legacy Min intent must wait for the separate LIB release profile');
    assert.match(result.stderr, /WM_RELEASE_PROFILE_REQUIRED/);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
