'use strict';
// The checksum generator must not record checkout metadata.
//
// WHY THIS EXISTS (measured defect): `update_checksums.cjs` excludes DIRECTORIES named `.git`, but a
// linked worktree keeps `.git` as a FILE (a `gitdir:` pointer). Running the generator inside
// `git worktree add` therefore emitted a `./.git` row whose bytes depend on where the checkout lives —
// measured on this machine: `85cf56a7…  ./.git` while the main checkout produced none. The published
// integrity list would then differ per machine for a reason unrelated to the release.
//
// The generator has to keep working in a release directory that has no repository, so it cannot ask Git
// what is metadata; the rule is by name, in both shapes (directory and file).
//
// This test builds a sandbox package root that carries a real `.git` FILE, so the case is exercised
// directly rather than assumed:
//   * an ordinary file must be recorded,
//   * the `.git` pointer must NOT be recorded.
//
// SELF-TEST: the same run is repeated with the guard removed from the sandbox copy of the generator and
// the `.git` row must then APPEAR. If it does not, this test cannot tell the fix apart from a generator
// where the case never existed.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GENERATOR = path.resolve(__dirname, '..', 'tools', 'update_checksums.cjs');
// `git archive HEAD PROGRAM` passed 64 MiB in 2026-10; keep headroom for growth.
const MAX_BUFFER = 256 * 1024 * 1024;

const buildSandbox = () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-generator-worktree-'));
  const packageRoot = path.join(temp, 'bundle');
  fs.mkdirSync(path.join(packageRoot, 'PROGRAM', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'PROGRAM', 'plugins'), { recursive: true });
  // The generator under test is the WORKING TREE version, so the current fix is what runs.
  fs.copyFileSync(GENERATOR, path.join(packageRoot, 'PROGRAM', 'tools', 'update_checksums.cjs'));
  fs.writeFileSync(path.join(packageRoot, 'PROGRAM', 'plugins', 'keep.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(packageRoot, 'PROGRAM', 'tools', 'keep_tool.cjs'), 'module.exports = 2;\n');
  // The linked-worktree shape: `.git` is a file, not a directory.
  fs.writeFileSync(path.join(packageRoot, '.git'), `gitdir: ${path.join(temp, 'worktrees', 'bundle')}\n`);
  return { temp, packageRoot };
};

const generate = packageRoot => {
  const run = spawnSync(process.execPath,
    [path.join(packageRoot, 'PROGRAM', 'tools', 'update_checksums.cjs')],
    { cwd: packageRoot, encoding: 'utf8', maxBuffer: MAX_BUFFER,
      env: { ...process.env, LIBRARIAN_PACKAGE_ROOT: packageRoot } });
  if (run.status !== 0) throw new Error(`update_checksums failed (status ${run.status}): ${run.stdout}${run.stderr}`);
  const rows = fs.readFileSync(path.join(packageRoot, 'SHA256SUMS.txt'), 'utf8')
    .split('\n').map(line => line.trim()).filter(Boolean)
    .map(line => line.replace(/^\S+\s+/, '').replace(/^\*/, ''));
  return rows;
};

const { temp, packageRoot } = buildSandbox();
let result;
try {
  assert.ok(fs.statSync(path.join(packageRoot, '.git')).isFile(), 'the sandbox must carry a `.git` FILE');

  const rows = generate(packageRoot);
  const pluginPresent = rows.includes('./PROGRAM/plugins/keep.cjs');
  const toolPresent = rows.includes('./PROGRAM/tools/keep_tool.cjs');
  const checkoutMetadataPresent = rows.some(row => row === './.git' || row.endsWith('/.git'));

  // ── self-test: remove the guard in the sandbox generator and require the row to APPEAR ──────────────
  const generatorPath = path.join(packageRoot, 'PROGRAM', 'tools', 'update_checksums.cjs');
  const source = fs.readFileSync(generatorPath, 'utf8');
  const site = '!CHECKSUM_EXCLUDED_FILES.has(entry.name) && ';
  assert.strictEqual(source.split(site).length - 1, 1,
    'the checkout-metadata guard must exist exactly once in the generator');
  fs.writeFileSync(generatorPath, source.replace(site, ''));
  const withoutFix = generate(packageRoot);
  const selfTestDetected = withoutFix.some(row => row === './.git');

  result = {
    withFix: { rows: rows.length, pluginPresent, toolPresent, checkoutMetadataPresent },
    withoutFix: { rows: withoutFix.length, checkoutMetadataPresent: selfTestDetected },
    selfTestDetected,
  };
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(JSON.stringify({ suite: 'checksum_generator_worktree_metadata', result }, null, 1));
assert.strictEqual(result.withFix.pluginPresent, true,
  'an ordinary source file must still be recorded — the guard must not empty the list');
assert.strictEqual(result.withFix.toolPresent, true, 'every ordinary file in the tree must be recorded');
assert.strictEqual(result.withFix.checkoutMetadataPresent, false,
  'the `.git` checkout pointer must not be recorded as a checksum row');
if (!result.selfTestDetected) {
  throw new Error('self-test: with the guard removed the `.git` row must be recorded; if it is not, ' +
    'this test cannot distinguish the fix from a generator that never had the case');
}
console.log('checksum_generator_worktree_metadata_test: PASS');
