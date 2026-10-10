'use strict';
// The manifest generator must not record files that Git does not track.
//
// WHY THIS EXISTS (measured defect): `update_manifest.cjs` scans the working tree, so a STALE collision
// copy (`<name> 2.cjs` made earlier, whose bytes drifted from its original while the original kept being
// edited) and a review note dropped inside PROGRAM were recorded into a COMMITTED manifest. A fresh
// `git archive HEAD` does not contain them, so `program_data_layout_test` failed there with
// `Manifest file missing: <path>` — which blocks the distribution, because the release staging tree is
// built from the repository content. Measured before the fix: committed 1,206 entries vs clean checkout
// 1,203.
//
// The existing shape rules could not see this: `isManifestCopyOfExistingFile` requires byte equality with
// the original, and a stale copy is not byte-equal. The generator also has to keep working inside a
// release directory that has no repository (contract §2), so the fix asks Git ONLY when it is meaningful:
// no repository, or a subdirectory of one (where `ls-files` returns nothing), means "no opinion".
//
// This test builds a sandbox that IS its own repository, so the filter is genuinely exercised in both
// directions:
//   * a tracked file must be recorded,
//   * an untracked file must NOT be recorded,
//   * a stale collision copy (untracked, bytes differing from its original) must NOT be recorded.
//
// SELF-TEST: the same run is repeated with the filter disabled through the sandbox's own generator copy,
// and the untracked probe must then APPEAR. If it does not, this test cannot tell the fix apart from
// a generator that never applied it.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractArchive } = require('../tools/lib/archive_extract.cjs');

const PROGRAM = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PROGRAM, '..', '..');
const RELATIVE_PROGRAM = 'Librarian-System/PROGRAM';
const MAX_BUFFER = 64 * 1024 * 1024;

const git = (cwd, args) => {
  const run = spawnSync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout;
};

// A sandbox that is a repository of its own, so `ls-files` inside it reports the sandbox's own files.
const buildSandbox = () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-generator-untracked-'));
  // Keep the archive as bytes on disk. Windows tar misreads Unicode paths when Git's tar
  // stream is passed over stdin, so use Git's ZIP archive there; POSIX retains its tar format.
  // Neither route includes index or working-tree-only files.
  const useZipArchive = process.platform === 'win32';
  const archiveArgs = useZipArchive
    ? ['archive', '--format=zip', 'HEAD', RELATIVE_PROGRAM]
    : ['archive', 'HEAD', RELATIVE_PROGRAM];
  const archived = spawnSync('git', archiveArgs,
    { cwd: REPO_ROOT, maxBuffer: MAX_BUFFER });
  if (archived.status !== 0) throw new Error(`git archive failed: ${archived.stderr}`);
  const archiveFile = path.join(temp, useZipArchive ? 'head-program.zip' : 'head-program.tar');
  fs.writeFileSync(archiveFile, archived.stdout);
  const extracted = extractArchive(archiveFile, temp, { maxBuffer: MAX_BUFFER });
  if (!extracted.ok) throw new Error(`archive extraction failed (${extracted.reason}) with ${extracted.binary}: ${extracted.stderr}`);
  const sandbox = path.join(temp, 'Librarian-System', 'PROGRAM');
  if (!fs.existsSync(sandbox)) throw new Error('the archive did not contain Librarian-System/PROGRAM');
  // The generator under test is the WORKING TREE version, so the current fix is what runs.
  fs.copyFileSync(path.join(PROGRAM, 'tools', 'update_manifest.cjs'), path.join(sandbox, 'tools', 'update_manifest.cjs'));
  git(sandbox, ['init', '-q']);
  git(sandbox, ['add', '-A']);
  git(sandbox, ['-c', 'user.email=fixture@localhost', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture']);
  return { temp, sandbox };
};

const regenerate = sandbox => {
  const run = spawnSync(process.execPath, [path.join(sandbox, 'tools', 'update_manifest.cjs')],
    { cwd: sandbox, encoding: 'utf8', maxBuffer: MAX_BUFFER, env: { ...process.env, LIBRARIAN_PROGRAM_ROOT: sandbox } });
  if (run.status !== 0) throw new Error(`update_manifest failed (status ${run.status}): ${run.stdout}${run.stderr}`);
  return Object.keys(JSON.parse(fs.readFileSync(path.join(sandbox, 'program-manifest.json'), 'utf8')).files || {});
};

const { temp, sandbox } = buildSandbox();
let result;
try {
  const trackedProbe = path.join(sandbox, 'docs', '__tracked_probe__.md');
  fs.writeFileSync(trackedProbe, 'tracked file\n');
  git(sandbox, ['add', 'docs/__tracked_probe__.md']);

  // Untracked, no original: the plainest case.
  fs.writeFileSync(path.join(sandbox, 'docs', '__untracked_probe__.md'), 'untracked\n');
  // Untracked stale collision copy: the original IS tracked and the bytes DIFFER, which is exactly the
  // case the shape-only rules could not see.
  fs.writeFileSync(path.join(sandbox, 'docs', '__stale_original__.md'), 'original v1\n');
  git(sandbox, ['add', 'docs/__stale_original__.md']);
  fs.writeFileSync(path.join(sandbox, 'docs', '__stale_original__ 2.md'), 'stale copy, different bytes\n');

  const withFix = regenerate(sandbox);
  const untrackedProbePresent = withFix.includes('docs/__untracked_probe__.md');
  const staleCopyPresent = withFix.includes('docs/__stale_original__ 2.md');
  const staleOriginalPresent = withFix.includes('docs/__stale_original__.md');
  const trackedProbePresent = withFix.includes('docs/__tracked_probe__.md');

  // ── self-test: disable the filter in the sandbox generator and require the probes to APPEAR ────────
  const generator = path.join(sandbox, 'tools', 'update_manifest.cjs');
  const generatorSource = fs.readFileSync(generator, 'utf8');
  const site = '      && !isManifestUntrackedInRepository(path.relative(root, full))) rows.push(full);';
  assert.strictEqual(generatorSource.split(site).length - 1, 1,
    'the filter call site must exist exactly once in the generator');
  fs.writeFileSync(generator, generatorSource.replace(site, '      ) rows.push(full);'));
  const withoutFix = regenerate(sandbox);
  const selfTestDetected = withoutFix.includes('docs/__untracked_probe__.md')
    && withoutFix.includes('docs/__stale_original__ 2.md');

  result = {
    withFix: {
      untrackedProbePresent, staleCopyPresent, staleOriginalPresent, trackedProbePresent,
      entries: withFix.length,
    },
    withoutFix: {
      entries: withoutFix.length,
      untrackedProbePresent: withoutFix.includes('docs/__untracked_probe__.md'),
      staleCopyPresent: withoutFix.includes('docs/__stale_original__ 2.md'),
    },
    selfTestDetected,
  };
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(JSON.stringify({ suite: 'manifest_generator_untracked_exclusion', result }, null, 1));
if (!result.selfTestDetected) {
  throw new Error('self-test: with the filter disabled the untracked probes must be recorded; if they ' +
    'are not, this test cannot distinguish the fix from a generator that never applied it');
}
assert.strictEqual(result.withFix.trackedProbePresent, true,
  'a tracked file must still be recorded — the filter must not empty the manifest');
assert.strictEqual(result.withFix.untrackedProbePresent, false,
  'an untracked file must not be recorded');
assert.strictEqual(result.withFix.staleOriginalPresent, true,
  'the tracked original of the collision copy must be recorded');
assert.strictEqual(result.withFix.staleCopyPresent, false,
  'an untracked stale collision copy must not be recorded even though its bytes differ from the original');
console.log('manifest_generator_untracked_exclusion_test: PASS');
