'use strict';
// LOCKS source-tree portability: no shipped test or tool may depend on one machine's absolute path.
//
// WHY THIS EXISTS
//   `libra_duplicate_scanner_extractable_test.cjs` read
//     path.resolve('/Users/ijonghun/Desktop/LIB/.../plugins/LIBRA.js')
//   so it passed on the machine it was written on and failed with ENOENT at that exact line on every
//   other checkout — and because the path pointed OUTSIDE the tree, the suite kept passing even when
//   the file beside it was modified. Demonstrated before the fix: corrupting the copied tree's
//   LIBRA.js still produced PASS; after the fix, the same corruption fails. That is the difference
//   this suite protects.
//
//   Three dev tools carried the same defect in a worse form: a `C:\Users\<author>\...` plugin
//   directory and a pinned `chrome.exe`, which made them unrunnable for anyone else even though the
//   Source distribution ships `tools/`.
//
// WHAT COUNTS AS A VIOLATION
//   A path literal that is USED TO LOCATE A FILE IN THIS PROJECT — read, require, spawn, or a
//   directory prefix. Absolute paths that appear as TEST DATA are legitimate and must keep working:
//   this project deliberately feeds hostile paths (`/etc/passwd`, `C:\outside.sqlite`,
//   `C:\Program Files\Google\Chrome`) to archive-safety and browser-location code, and those are
//   the fixtures that prove the guards hold.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// An optional PROGRAM argument lets this same shipped check validate an unpacked source artifact.
const PROGRAM = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SCRIPT_ROOTS = ['tests', 'tools'];
const SCRIPT_EXTENSIONS = new Set(['.cjs', '.js']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '__generated__', 'build', 'coverage', 'dist', 'generated', 'node_modules', 'vendor'
]);

const read = file => fs.readFileSync(path.join(PROGRAM, file), 'utf8');
const isScript = file => SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase())
  && !/\.(?:generated|gen|min)\.(?:cjs|js)$/i.test(file);
const shouldSkipPath = file => file.split(/[\\/]/).some(segment => EXCLUDED_DIRECTORIES.has(segment.toLowerCase()));

function runGit(repositoryRoot, args) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw new Error(`could not run git ${args.join(' ')}: ${result.error.message}`);
  return result;
}

function findGitRepository() {
  const result = spawnSync('git', ['-C', PROGRAM, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') return null;
    throw new Error(`could not determine Git repository: ${result.error.message}`);
  }
  if (result.status === 0) {
    const repositoryRoot = (result.stdout || '').trim();
    assert.ok(repositoryRoot, 'git rev-parse returned an empty repository root');
    return path.resolve(repositoryRoot);
  }
  const diagnostic = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (result.status === 128 && /not a git (?:repository|directory)/i.test(diagnostic)) return null;
  throw new Error(`git rev-parse failed with exit ${result.status}: ${diagnostic.trim()}`);
}

function trackedScriptFiles(repositoryRoot) {
  const programRelative = path.relative(repositoryRoot, PROGRAM).split(path.sep).join('/');
  assert.ok(programRelative && programRelative !== '..' && !programRelative.startsWith('../'),
    `program directory is outside its Git repository: ${PROGRAM}`);
  const roots = SCRIPT_ROOTS.map(root => `${programRelative}/${root}`);
  const result = runGit(repositoryRoot, ['ls-files', '--cached', '-z', '--', ...roots]);
  if (result.status !== 0) {
    throw new Error(`git ls-files failed with exit ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  // The index still lists tracked files removed in the working tree. The
  // current shipped-source scan must omit those declared deletions, including
  // regressions retired before the cleanup commit is made.
  const deletedResult = runGit(repositoryRoot, ['ls-files', '--deleted', '-z', '--', ...roots]);
  if (deletedResult.status !== 0) {
    throw new Error(`git ls-files failed with exit ${deletedResult.status}: ${(deletedResult.stderr || deletedResult.stdout || '').trim()}`);
  }
  const deleted = new Set((deletedResult.stdout || '').split('\0').filter(Boolean));

  const files = [];
  for (const repoRelative of (result.stdout || '').split('\0').filter(Boolean)) {
    if (deleted.has(repoRelative)) continue;
    const relative = path.posix.relative(programRelative, repoRelative.replace(/\\/g, '/'));
    if (!relative || relative.startsWith('../') || !isScript(relative) || shouldSkipPath(relative)) continue;
    const absolute = path.join(repositoryRoot, ...repoRelative.split('/'));
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    files.push(relative);
  }
  return files.sort();
}

function sourceScriptFiles() {
  const files = [];
  function walk(relativeDirectory) {
    const absoluteDirectory = path.join(PROGRAM, relativeDirectory);
    const metadata = fs.lstatSync(absoluteDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink() || shouldSkipPath(relative)) continue;
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile() && isScript(relative)) files.push(relative.split(path.sep).join('/'));
    }
  }
  for (const root of SCRIPT_ROOTS) walk(root);
  return files.sort();
}

// Explicit unpacked-export mode does not claim Git index or HEAD coverage.
const repositoryRoot = process.env.SOURCE_TREE_PORTABILITY_EXPORT === '1' ? null : findGitRepository();
const sourceMode = !repositoryRoot;
const files = sourceMode ? sourceScriptFiles() : trackedScriptFiles(repositoryRoot);
assert.ok(files.length > 0, `source_tree_portability found zero shipped test/tool source files (${sourceMode ? 'source' : 'Git'} scan)`);

// A path literal that names THIS project's own tree, or a user profile directory. Accept both
// ordinary Windows separators and the doubled separators emitted when JSON.stringify writes a
// Windows absolute path into JavaScript source.
const LOCAL_TREE = /['"`](?:[A-Za-z]:(?:[\\/]+)?(?:Users|Documents)[\\/]+|\/(?:Users|home)\/)/;

// `fs.readFileSync`, `require`, `spawn` and friends: the call shapes that turn a path into a lookup.
const LOOKUP_CALL = /(?:readFileSync|require|createRequire|spawn|spawnSync|execFile|execFileSync|fork|readdirSync|statSync|existsSync|createReadStream|path\.resolve)\s*\(\s*([^)]{0,200})/g;

const offenders = [];
for (const file of files) {
  const source = read(file);
  // Strip comments first. A comment that QUOTES the old absolute path — as this suite's own header
  // does to explain the defect — is documentation, not a lookup, and matching it would make the
  // guard fail on the very file that describes the rule.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
  for (const match of code.matchAll(LOOKUP_CALL)) {
    const argument = match[1];
    if (!LOCAL_TREE.test(argument)) continue;
    // `existsSync` on a candidate list is how the platform-aware resolvers probe for a browser; those
    // literals are intentional discovery candidates, not a hard dependency on one machine.
    const candidateList = /candidates|chromeCandidates|BROWSER_CANDIDATES/i.test(code.slice(0, match.index));
    if (candidateList) continue;
    offenders.push({ file, argument: argument.trim().slice(0, 120) });
  }
}

assert.deepEqual(offenders, [],
  `no shipped test or tool may locate a file through an absolute user path:\n${offenders.map(o => `  ${o.file}: ${o.argument}`).join('\n')}`);

// ── the two tools must be able to find Chrome and the plugins without this machine's paths ──────
for (const tool of ['tools/palette_check.js', 'tools/css_computed_check.js']) {
  const source = read(tool);
  assert.match(source, /process\.env\.(?:CHROME_PATH|CHROME_BIN)/,
    `${tool} must honour a CHROME_PATH/CHROME_BIN override`);
  assert.match(source, /path\.resolve\(__dirname, '\.\.', 'plugins'\)/,
    `${tool} must derive the plugin directory from its own location`);
  assert.match(source, /chrome_not_found/,
    `${tool} must fail with an actionable message rather than ENOENT on a missing browser`);
}
// The probe and the scanner suite must be tree-relative.
assert.match(read('tools/_probe_restore_mismatch.cjs'), /require\(path\.resolve\(__dirname, '\.\.', 'tests'/,
  'the restore probe must require its fixture relative to the tree');
assert.match(read('tests/libra_duplicate_scanner_extractable_test.cjs'), /path\.resolve\(__dirname, '\.\.', 'plugins', 'LIBRA\.js'\)/,
  'the duplicate-scanner suite must read LIBRA.js relative to the tree');

// ── positive control: the hostile-path fixtures must still be present ───────────────────────────
// A rule that passed by deleting the security fixtures would be worse than the defect it fixes.
for (const [file, needle] of [
  ['tests/portable_stream_archive_safety_test.cjs', '/etc/passwd'],
  ['tests/portable_backup_manifest_reference_safety_test.cjs', 'outside.sqlite'],
  ['tests/browser_executable_resolution_test.cjs', 'Program Files']
]) {
  assert.ok(read(file).includes(needle),
    `${file} must keep its hostile-path fixture "${needle}" — those are test DATA, not lookup paths`);
}

console.log(JSON.stringify({ test: 'source_tree_portability', ok: true, scanned: files.length, mode: sourceMode ? 'source' : 'git' }));
console.log('PASS 소스 트리 이식성: 출하 테스트·도구가 개인 절대경로로 파일을 찾지 않는다');
