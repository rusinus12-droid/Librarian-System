'use strict';
// The committed manifest must not reference files that a fresh checkout does not have.
//
// WHY THIS EXISTS (measured defect): `update_manifest.cjs` scans the WORKING TREE, so any file that
// exists only here — a stale `<name> 2.cjs` collision copy whose bytes drifted from its original, or a
// review note dropped inside PROGRAM — is recorded in the manifest. A fresh `git archive HEAD` has none
// of those files, and `program_data_layout_test` then fails with `Manifest file missing: <path>`, which
// blocks the distribution: the release staging tree is built FROM the repository content, so the layout
// test runs where those working-tree-only files do not exist.
//
// The generator itself cannot close this class: it must also run inside a release directory that has no
// repository (contract §2), so it cannot ask Git what is tracked. The invariant therefore has to be
// enforced at the repository level, which is what this test does: it regenerates the manifest inside a
// throwaway tree built from `git archive HEAD` and requires the recorded file set to equal the manifest
// that is committed alongside the sources.
//
// SEMANTICS: this compares against HEAD, not the working tree. Adding a file and regenerating the
// manifest therefore reports a mismatch until BOTH are committed together, which is the repository's
// existing discipline and exactly the signal that the manifest has outrun the sources.
//
// SELF-TEST (a tool that ran is not a tool that verified): mode B injects one stray file into the clean
// tree and requires the comparison to DETECT it. If that mode does not diverge, this guard cannot catch
// the very class it exists for, and the test fails instead of reporting a pass.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractArchive } = require('../tools/lib/archive_extract.cjs');

const PROGRAM = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PROGRAM, '..', '..');
const MANIFEST = path.join(PROGRAM, 'program-manifest.json');
const RELATIVE_PROGRAM = path.join('Librarian-System', 'PROGRAM');
// The whole 5 MB plugin set is read by the generator, so the default 1 MB buffer would truncate it.
const MAX_BUFFER = 64 * 1024 * 1024;

const manifestFiles = programRoot => {
  const raw = JSON.parse(fs.readFileSync(path.join(programRoot, 'program-manifest.json'), 'utf8'));
  return Object.keys(raw.files || {}).sort();
};

const buildCleanTree = () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-clean-tree-'));
  // Keep Git's binary archive output as a Buffer and extract from a file. On Windows, the tar
  // stream over stdin loses Unicode pathnames; Git's ZIP format carries those names explicitly.
  // POSIX keeps the portable tar format. Both formats still contain HEAD only.
  const useZipArchive = process.platform === 'win32';
  const archiveArgs = useZipArchive
    ? ['archive', '--format=zip', 'HEAD', RELATIVE_PROGRAM.split(path.sep).join('/')]
    : ['archive', 'HEAD', RELATIVE_PROGRAM.split(path.sep).join('/')];
  const archived = spawnSync('git', archiveArgs,
    { cwd: REPO_ROOT, maxBuffer: MAX_BUFFER });
  if (archived.status !== 0) throw new Error(`git archive failed: ${archived.stderr}`);
  const archiveFile = path.join(temp, useZipArchive ? 'head-program.zip' : 'head-program.tar');
  fs.writeFileSync(archiveFile, archived.stdout);
  const extracted = extractArchive(archiveFile, temp, { maxBuffer: MAX_BUFFER });
  if (!extracted.ok) throw new Error(`archive extraction failed (${extracted.reason}) with ${extracted.binary}: ${extracted.stderr}`);
  const sandbox = path.join(temp, RELATIVE_PROGRAM);
  if (!fs.existsSync(sandbox)) throw new Error('the archive did not contain Librarian-System/PROGRAM');
  // The generator under test is the WORKING TREE version, so a fix in it is what gets exercised even
  // before the commit that carries it.
  fs.copyFileSync(path.join(PROGRAM, 'tools', 'update_manifest.cjs'), path.join(sandbox, 'tools', 'update_manifest.cjs'));
  return { temp, sandbox };
};

const regenerate = sandbox => {
  const run = spawnSync(process.execPath, [path.join(sandbox, 'tools', 'update_manifest.cjs')],
    { cwd: sandbox, encoding: 'utf8', maxBuffer: MAX_BUFFER,
      env: { ...process.env, LIBRARIAN_PROGRAM_ROOT: sandbox } });
  if (run.status !== 0) {
    throw new Error(`update_manifest failed in the clean tree (status ${run.status}): ` +
      `${run.stdout || ''}${run.stderr || ''}`);
  }
  return manifestFiles(sandbox);
};

const difference = (left, right) => {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return { onlyLeft: left.filter(item => !rightSet.has(item)), onlyRight: right.filter(item => !leftSet.has(item)) };
};

const committed = manifestFiles(PROGRAM);
const clean = buildCleanTree();
let result;
try {
  // ── mode A: the recorded set in a clean checkout must equal the committed manifest ────────────────
  const fromCleanTree = regenerate(clean.sandbox);
  const modeA = difference(fromCleanTree, committed);

  // ── mode B: self-test — one stray file must be DETECTED, or this guard is worthless ───────────────
  const stray = path.join(clean.sandbox, 'tests', '__manifest_clean_tree_selftest__.md');
  fs.writeFileSync(stray, 'stray file that exists only in a working tree\n');
  const fromCleanTreeWithStray = regenerate(clean.sandbox);
  const modeB = difference(fromCleanTreeWithStray, committed);

  // Assertions run only after every measurement is complete, so a failure reports the numbers instead
  // of dying on an undefined field.
  result = {
    committedEntries: committed.length,
    cleanTreeEntries: fromCleanTree.length,
    strayDetected: modeB.onlyLeft.includes('tests/__manifest_clean_tree_selftest__.md'),
    onlyInCleanTree: modeA.onlyLeft,
    onlyInCommitted: modeA.onlyRight,
    modeA,
  };

  if (result.strayDetected !== true) {
    console.error(JSON.stringify({ suite: 'manifest_clean_tree_file_set', passed: 0, result }, null, 1));
    throw new Error('self-test: a stray file in the clean tree must be recorded and reported as a ' +
      'difference; if it is not, this comparison cannot detect the class it exists for');
  }
  // `difference()` returns onlyLeft / onlyRight; the result object renames them for the report.
  if (modeA.onlyRight.length) {
    console.error(JSON.stringify({ suite: 'manifest_clean_tree_file_set', passed: 1, result }, null, 1));
    throw new Error('the committed manifest records files a fresh checkout does not have, so the ' +
      `distribution layout test fails there: ${modeA.onlyRight.join(', ')}`);
  }
  if (modeA.onlyLeft.length) {
    console.error(JSON.stringify({ suite: 'manifest_clean_tree_file_set', passed: 1, result }, null, 1));
    throw new Error('the clean checkout holds files the committed manifest does not record ' +
      `(regenerate it and commit both together): ${modeA.onlyLeft.join(', ')}`);
  }
} finally {
  fs.rmSync(clean.temp, { recursive: true, force: true });
}

console.log(JSON.stringify({ suite: 'manifest_clean_tree_file_set', passed: 2, result }, null, 1));
console.log('manifest_clean_tree_file_set_test: PASS');
