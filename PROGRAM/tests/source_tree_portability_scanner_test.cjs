'use strict';
// Exercises the shipped portability scanner against real source-tree fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROGRAM = path.resolve(__dirname, '..');
const SCANNER = path.join(PROGRAM, 'tests', 'source_tree_portability_test.cjs');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-source-portability-'));
const copiedFiles = [
  'tests/source_tree_portability_test.cjs',
  'tests/source_tree_portability_scanner_test.cjs',
  'tests/libra_duplicate_scanner_extractable_test.cjs',
  'tests/portable_stream_archive_safety_test.cjs',
  'tests/portable_backup_manifest_reference_safety_test.cjs',
  'tests/browser_executable_resolution_test.cjs',
  'tools/palette_check.js',
  'tools/css_computed_check.js',
  'tools/_probe_restore_mismatch.cjs'
];

function makeTree(name, copyFiles = true) {
  const repository = path.join(TEMP, name);
  const program = path.join(repository, 'Librarian-System', 'PROGRAM');
  fs.mkdirSync(path.join(program, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(program, 'tools'), { recursive: true });
  if (copyFiles) {
    for (const relative of copiedFiles) {
      const target = path.join(program, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(PROGRAM, relative), target);
    }
  }
  return { repository, program };
}

function machineLookupSource() {
  const projectFile = path.join(os.homedir(), 'Desktop', 'LIB', 'plugins', 'LIBRA.js');
  return `require('node:fs').readFileSync(${JSON.stringify(projectFile)}, 'utf8');\n`;
}

function writeNested(program, relative, contents) {
  const target = path.join(program, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function runSourceScanner(program, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(program, 'tests', 'source_tree_portability_test.cjs')], {
    cwd: TEMP,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...extraEnv }
  });
}

function runScannerAt(program, extraEnv = {}) {
  return spawnSync(process.execPath, [SCANNER, program], {
    cwd: TEMP,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...extraEnv }
  });
}

function outputOf(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function assertFailure(result, description) {
  assert.equal(result.status, 1, `${description} must exit 1, got ${result.status}: ${outputOf(result)}`);
}

function reportOf(result) {
  const line = (result.stdout || '').split('\n').find(candidate => candidate.startsWith('{'));
  assert.ok(line, `scanner emits its result record: ${outputOf(result)}`);
  return JSON.parse(line);
}

try {
  // Run the actual shipped file in an export layout, without .git or review_artifacts.
  const source = makeTree('source');
  assert.equal(fs.existsSync(path.join(source.repository, '.git')), false);
  assert.equal(fs.existsSync(path.join(source.repository, 'review_artifacts')), false);
  const sourceResult = runSourceScanner(source.program);
  assert.equal(sourceResult.status, 0, `a source export without Git runs: ${outputOf(sourceResult)}`);
  const sourceReport = reportOf(sourceResult);
  assert.ok(sourceReport.scanned > 0, `a source export scans shipped files: ${outputOf(sourceResult)}`);

  // An empty source artifact must fail, rather than emit a successful scanned:0 report.
  const empty = makeTree('empty', false);
  const emptyResult = runScannerAt(empty.program);
  assertFailure(emptyResult, 'empty source tree');
  assert.match(outputOf(emptyResult), /zero|no source files/i);

  // Source mode recursively sees nested shipped tests and rejects a project lookup there.
  writeNested(source.program, 'tests/nested/deeper/absolute_lookup_test.cjs', machineLookupSource());
  const sourceFailure = runSourceScanner(source.program);
  assertFailure(sourceFailure, 'nested absolute lookup in source mode');
  assert.match(outputOf(sourceFailure), /nested[\\/]deeper[\\/]absolute_lookup_test\.cjs/);

  // Directory exclusions and symlink boundaries remain effective during recursive walking.
  const safeSource = makeTree('safe-source');
  writeNested(safeSource.program, 'tests/nested/portable_case.cjs', "'use strict';\nmodule.exports = true;\n");
  writeNested(safeSource.program, 'tests/generated/ignored_lookup.cjs', machineLookupSource());
  writeNested(safeSource.program, 'tools/vendor/ignored_lookup.js', machineLookupSource());
  const outside = writeNested(safeSource.repository, 'outside/linked_lookup.cjs', machineLookupSource());
  if (process.platform === 'win32') {
    // Windows permits junction creation without symlink privilege. Dirent still identifies it as a
    // symbolic link, so this exercises the scanner's no-follow boundary on the host platform.
    fs.symlinkSync(path.dirname(outside), path.join(safeSource.program, 'tests', 'linked_directory'), 'junction');
  } else {
    fs.symlinkSync(outside, path.join(safeSource.program, 'tests', 'linked_lookup.cjs'));
    fs.symlinkSync(path.dirname(outside), path.join(safeSource.program, 'tests', 'linked_directory'), 'dir');
  }
  const safeResult = runSourceScanner(safeSource.program);
  assert.equal(safeResult.status, 0, `ordinary source files plus skipped generated/vendor/symlink inputs pass: ${outputOf(safeResult)}`);
  assert.ok(reportOf(safeResult).scanned > 0, 'a source artifact scans shipped files');

  // A real Git index defines the shipped set; an untracked duplicate is not a distribution claim.
  const checkout = makeTree('checkout');
  let git = spawnSync('git', ['-C', checkout.repository, 'init', '--quiet'], { encoding: 'utf8' });
  assert.equal(git.status, 0, `temporary Git repository initializes: ${git.stderr || ''}`);
  git = spawnSync('git', ['-C', checkout.repository, 'add', '-f', '--', 'Librarian-System/PROGRAM/tests', 'Librarian-System/PROGRAM/tools'], { encoding: 'utf8' });
  assert.equal(git.status, 0, `fixture files enter the Git index: ${git.stderr || ''}`);
  writeNested(checkout.program, 'tests/nested/untracked_duplicate.cjs', machineLookupSource());
  const trackedResult = runSourceScanner(checkout.program);
  assert.equal(trackedResult.status, 0, `tracked source passes despite an untracked duplicate: ${outputOf(trackedResult)}`);
  assert.ok(reportOf(trackedResult).scanned > 0, 'tracked source files are scanned');

  // A tracked source violation remains visible until the file is removed.
  // Git still lists that deletion in the index before the cleanup is committed.
  const retiredLookup = writeNested(checkout.program, 'tests/nested/retired_lookup.cjs', machineLookupSource());
  git = spawnSync('git', ['-C', checkout.repository, 'add', '--', 'Librarian-System/PROGRAM/tests/nested/retired_lookup.cjs'], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  assertFailure(runSourceScanner(checkout.program), 'an existing tracked absolute lookup');
  fs.unlinkSync(retiredLookup);
  const afterRemoval = runSourceScanner(checkout.program);
  assert.equal(afterRemoval.status, 0, `declared working-tree deletions are excluded: ${outputOf(afterRemoval)}`);
  assert.equal(reportOf(afterRemoval).scanned, reportOf(trackedResult).scanned,
    'retiring a tracked script restores the same current shipped-file inventory');

  // Once Git identifies a checkout, a real index read error is an error, not a cue to fall back.
  // rev-parse does not read this alternate index; ls-files does, and Git reports the malformed
  // index itself. This exercises the actual Git boundary on Windows and POSIX without a shell shim.
  const brokenIndex = path.join(checkout.repository, 'broken-index');
  fs.mkdirSync(brokenIndex);
  const gitError = runSourceScanner(checkout.program, { GIT_INDEX_FILE: brokenIndex });
  assertFailure(gitError, 'unexpected git ls-files failure');
  assert.match(outputOf(gitError), /git ls-files failed/i,
    'a malformed real Git index must fail at the stable ls-files scanner boundary');
  assert.ok(!/"ok":true/.test(outputOf(gitError)), 'a Git scan error must not emit a successful report');

  console.log(JSON.stringify({ test: 'source_tree_portability_scanner', ok: true, controls: 7 }));
  console.log('PASS portability scanner controls: source export, empty tree, nested lookup, exclusions, Git tracking, working-tree deletions, and Git errors');
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true });
}
