'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const prepareScript = path.join(programDir, 'tools', 'prepare_data.cjs');

const sha256 = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const listFiles = root => {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
};

function runPrepare(tempProgram, dataDir) {
  return spawnSync(process.execPath, [prepareScript, '--program-dir', tempProgram, '--data-dir', dataDir], {
    encoding: 'utf8'
  });
}

function assertPackageRoot(root) {
  // macOS writes .DS_Store into any directory Finder has displayed. It is
  // gitignored, never tracked, and never copied into a release: the builder is an
  // allowlist (shouldCopySourceProgram / shouldCopyUpdater), so these files cannot
  // reach an artifact. Asserting an exact root listing therefore failed on any
  // machine where Finder had opened the bundle, for a reason unrelated to the
  // release, so OS metadata is filtered out of the listing rather than being
  // treated as a bundle entry.
  const OS_METADATA_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  const bundleEntries = dir => fs.readdirSync(dir).filter(name => !OS_METADATA_NAMES.has(name)).sort();
  const rootEntries = bundleEntries(root);
  const expectedRootEntries = ['0_설치_안내.txt', 'DATA', 'PROGRAM', 'SHA256SUMS.txt', 'UPDATER', '업데이트.bat', '업데이트.command', '업데이트.sh'];
  if (fs.existsSync(path.join(root, 'update-manifest.json'))) expectedRootEntries.push('update-manifest.json');
  const workspaceMarker = path.join(root, '.development', 'workspace.json');
  if (fs.existsSync(workspaceMarker)) {
    assert.equal(JSON.parse(fs.readFileSync(workspaceMarker)).schema, 'lib.development-workspace.v1');
    expectedRootEntries.push('.development', 'FIRST-README.md');
  }
  // Release smoke executes against this source checkout before packaging. These
  // publication inputs are permitted only at a verified Git repository root;
  // staged bundles keep the exact original release layout.
  if (fs.existsSync(path.join(root, '.git'))) {
    const repository = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    assert.equal(repository.status, 0, 'source metadata requires a real repository');
    assert.equal(fs.realpathSync(repository.stdout.trim()), fs.realpathSync(root), 'source metadata belongs to this repository root');
    assert.ok(fs.statSync(path.join(root, 'LICENSE')).isFile(), 'source publication license is present');
    const provenance = JSON.parse(fs.readFileSync(path.join(root, 'PUBLICATION-PROVENANCE.json'), 'utf8'));
    assert.equal(provenance.schema, 'librarian.six-plugin-checkpoint-publication.v2');
    expectedRootEntries.push('.git', 'LICENSE', 'PUBLICATION-PROVENANCE.json');
  }
  assert.deepEqual(rootEntries, expectedRootEntries.sort(), 'Bundle root contains only PROGRAM/DATA, updater, and verified release artifacts.');
}

function main() {
  assertPackageRoot(packageRoot);
  const rootControl = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-root-control-'));
  try {
    for (const name of ['0_설치_안내.txt', 'DATA', 'PROGRAM', 'SHA256SUMS.txt', 'UPDATER', '업데이트.bat', '업데이트.command', '업데이트.sh']) {
      if (['DATA', 'PROGRAM', 'UPDATER'].includes(name)) fs.mkdirSync(path.join(rootControl, name));
      else fs.writeFileSync(path.join(rootControl, name), '');
    }
    assertPackageRoot(rootControl);
    for (const name of ['unaccounted.bin', 'LICENSE', 'PUBLICATION-PROVENANCE.json', '.git']) {
      fs.writeFileSync(path.join(rootControl, name), '');
      assert.throws(() => assertPackageRoot(rootControl), assert.AssertionError, `packaged roots reject ${name}`);
      fs.unlinkSync(path.join(rootControl, name));
    }
  } finally { fs.rmSync(rootControl, { recursive: true, force: true }); }
  assert.ok(fs.existsSync(path.join(packageRoot, 'UPDATER', 'updater.cjs')), 'Cross-platform updater engine is packaged at the bundle root.');

  const dataDir = path.join(packageRoot, 'DATA');
  const programFiles = listFiles(programDir);
  const dataFiles = listFiles(dataDir);
  assert.ok(programFiles.some(file => /server[\\/]server\.cjs$/i.test(file)));
  assert.ok(programFiles.some(file => /plugins[\\/]LIBRA\.js$/i.test(file)));
  assert.equal(programFiles.some(file => /plugins[\\/]GRADIA\.js$/i.test(file)), true, 'GRADIA is the sixth packaged read-only consumer plugin.');
  assert.equal(programFiles.filter(file => /plugins[\\/][^\\/]+\.js$/i.test(file)).length, 6, 'Exactly six declared plugins are packaged.');
  const canonicalPluginNames = [
    'Flashback_Memory.js',
    'HAYAKU_Locator_Continuity.js',
    'LIBRA.js',
    'LIA_Persona_Linker.js',
    'RETRACE.js',
    'GRADIA.js'
  ];
  assert.deepEqual(
    fs.readdirSync(path.join(programDir, 'plugins')).filter(name => /\.js$/i.test(name)).sort(),
    canonicalPluginNames.sort(),
    'PROGRAM/plugins is the single canonical RisuAI plugin distribution folder.'
  );
  assert.equal(fs.existsSync(path.join(packageRoot, 'PLUGINS')), false, 'Top-level PLUGINS duplicate folder must not be shipped.');
  assert.equal(dataFiles.some(file => /\.(?:js|cjs|mjs|bat|cmd|ps1|exe|dll)$/i.test(file)), false, 'DATA must not contain executable/program files.');
  assert.equal(programFiles.some(file => /(?:^|[\\/])(?:stores|backups|logs)(?:[\\/]|$)/i.test(path.relative(programDir, file))), false, 'PROGRAM must not contain persistent store/backup/log files.');

  const programManifest = JSON.parse(fs.readFileSync(path.join(programDir, 'program-manifest.json'), 'utf8'));
  const currentVersion = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim();
  assert.equal(programManifest.packageVersion, currentVersion);
  assert.equal(programManifest.dataContract.programIsReplaceable, true);
  assert.equal(programManifest.dataContract.dataIsPortable, true);
  for (const [relative, meta] of Object.entries(programManifest.files)) {
    const filePath = path.join(programDir, relative);
    assert.ok(fs.existsSync(filePath), `Manifest file missing: ${relative}`);
    assert.equal(sha256(filePath), meta.sha256, `Manifest SHA mismatch: ${relative}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-layout-test-'));
  try {
    const tempProgram = path.join(tempRoot, 'PROGRAM');
    const legacyData = path.join(tempRoot, 'data');
    const legacyLogs = path.join(tempRoot, 'logs');
    const newData = path.join(tempRoot, 'DATA');
    fs.mkdirSync(path.join(legacyData, 'stores', 'libra'), { recursive: true });
    fs.mkdirSync(legacyLogs, { recursive: true });
    fs.mkdirSync(tempProgram, { recursive: true });
    fs.writeFileSync(path.join(tempProgram, 'VERSION.txt'), `${currentVersion}\n`);
    fs.mkdirSync(path.join(newData, 'config'), { recursive: true });
    fs.writeFileSync(path.join(newData, 'config', 'server-config.json'), JSON.stringify({ schema: 'memory-suite.server-config.v1', host: '127.0.0.1', port: 47630, autoBackup: true }, null, 2));
    fs.writeFileSync(path.join(legacyData, 'stores', 'libra', 'legacy.bin'), 'legacy-data');
    fs.writeFileSync(path.join(legacyLogs, 'server.log'), 'legacy-log');
    fs.writeFileSync(path.join(tempRoot, 'memory-suite-config.cmd'), [
      'set "MEMORY_SUITE_HOST=127.0.0.1"',
      'set "MEMORY_SUITE_PORT=47631"'
    ].join('\r\n'));

    const first = runPrepare(tempProgram, newData);
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(first.stdout.trim());
    assert.equal(receipt.programVersion, currentVersion, 'Preparation receipt is bound to the selected PROGRAM version.');
    assert.equal(receipt.legacyDataMigrated, true);
    assert.equal(receipt.legacySourcePreserved, true);
    assert.equal(fs.readFileSync(path.join(newData, 'stores', 'libra', 'legacy.bin'), 'utf8'), 'legacy-data');
    assert.equal(fs.readFileSync(path.join(legacyData, 'stores', 'libra', 'legacy.bin'), 'utf8'), 'legacy-data');
    const config = JSON.parse(fs.readFileSync(path.join(newData, 'config', 'server-config.json'), 'utf8'));
    assert.equal(config.port, 47631);
    assert.equal(config.computeEnabled, true, 'existing server configs gain the enabled compute default');
    assert.equal(config.computeWorkers, 0, 'existing server configs gain automatic compute worker sizing');
    const layout = JSON.parse(fs.readFileSync(path.join(newData, 'data-layout.json'), 'utf8'));
    assert.equal(layout.lastProgramVersion, currentVersion, 'Generated DATA layout is bound to the selected PROGRAM version.');
    assert.equal(layout.layoutVersion, 1);
    assert.equal(layout.programFolder, 'PROGRAM');
    assert.equal(layout.dataFolder, 'DATA');
    assert.equal(layout.recoveryQuarantine, 'backups/recovery-quarantine');
    assert.equal(layout.restoreJournal, 'migrations/restore-transaction.json');
    assert.equal(layout.scopeCatalogPrevious, 'config/scope-catalog.previous.json');
    assert.ok(fs.existsSync(path.join(newData, 'backups', 'recovery-quarantine')));

    const logFileCountBefore = listFiles(path.join(newData, 'logs')).length;
    const dataReceiptCountBefore = listFiles(path.join(newData, 'migrations'))
      .filter(file => /legacy-data-.*\.json$/i.test(path.basename(file))).length;
    const second = runPrepare(tempProgram, newData);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(listFiles(path.join(newData, 'logs')).length, logFileCountBefore, 'Legacy logs must migrate only once.');
    assert.equal(listFiles(path.join(newData, 'migrations')).filter(file => /legacy-data-.*\.json$/i.test(path.basename(file))).length,
      dataReceiptCountBefore, 'Case-only legacy DATA adoption must be recorded only once.');

    const layoutPath = path.join(newData, 'data-layout.json');
    const future = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
    future.layoutVersion = 99;
    fs.writeFileSync(layoutPath, JSON.stringify(future));
    const beforeHash = sha256(layoutPath);
    const rejected = runPrepare(tempProgram, newData);
    assert.equal(rejected.status, 23);
    assert.equal(sha256(layoutPath), beforeHash, 'A newer DATA layout must not be rewritten by an older PROGRAM.');

    process.stdout.write('program_data_layout_test: PASS\n');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  process.stderr.write(`program_data_layout_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
}
