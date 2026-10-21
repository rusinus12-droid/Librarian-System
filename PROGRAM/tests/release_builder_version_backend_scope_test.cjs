'use strict';
// A version the release builder applies must reach the whole backend, not just VERSION.txt.
// Real repository files in a scratch copy: apply the version exactly as the builder does
// (applyReleaseVersion + the guide and README sync), then check the server module itself reports
// it and that no place still carries the old backend version.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const builder = require('../tools/build_distribution.cjs');
const metadata = require('../tools/release_metadata.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, filter: source => !/node_modules|__pycache__/.test(source) && (!filter || filter(source)) });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-version-scope-'));
try {
  const program = path.join(scratch, 'PROGRAM');
  fs.mkdirSync(path.join(program, 'docs', 'release-provenance'), { recursive: true });
  copy(path.join(repoRoot, 'PROGRAM', 'server'), path.join(program, 'server'));
  copy(path.join(repoRoot, 'PROGRAM', 'sdk'), path.join(program, 'sdk'), source => /sdk$|Storage|Compute|ExecutionContract/.test(source) || fs.statSync(source).isDirectory());
  copy(path.join(repoRoot, 'PROGRAM', 'plugins'), path.join(program, 'plugins'));
  copy(path.join(repoRoot, 'PROGRAM', 'tools'), path.join(program, 'tools'), source => !/rag_eval/.test(source));
  for (const file of ['VERSION.txt', 'release-policy.json', 'PACKAGE_CONTENTS.txt', '처음_읽어주세요.txt', 'docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json'])
    fs.copyFileSync(path.join(repoRoot, 'PROGRAM', file), path.join(program, file));
  for (const file of ['0_설치_안내.txt', 'README.md', 'update-manifest.json']) fs.copyFileSync(path.join(repoRoot, file), path.join(scratch, file));

  const previous = fs.readFileSync(path.join(program, 'VERSION.txt'), 'utf8').trim();
  const [major, minor, patch] = previous.split('.').map(Number);
  const target = `${major}.${minor}.${patch + 7}`;

  builder.applyReleaseVersion(scratch, target);
  metadata.syncReleaseGuides(scratch);
  metadata.syncRepositoryReadme(scratch);

  // The backend itself reports the new version.
  const server = require(path.join(program, 'server', 'server.cjs'));
  assert.equal(server.SERVER_VERSION, target, 'the server module reports the builder version');
  assert.equal(fs.readFileSync(path.join(program, 'VERSION.txt'), 'utf8').trim(), target);
  assert.equal(JSON.parse(fs.readFileSync(path.join(program, 'release-policy.json'), 'utf8')).version, target);
  assert.equal(metadata.readReleaseMetadata(program).packageVersion, target, 'package and server versions agree');

  // No backend place keeps the old version: the server tree, the export tool, the release policy,
  // the installation guides and the README.
  const stale = [];
  const needle = new RegExp(`(?<![\\d.])${previous.replace(/\./g, '\\.')}(?![\\d])`);
  const scan = file => { if (needle.test(fs.readFileSync(file, 'utf8'))) stale.push(path.relative(scratch, file)); };
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(cjs|js|json|txt)$/.test(entry.name)) scan(full); } };
  walk(path.join(program, 'server'));
  for (const file of [path.join(program, 'tools', 'portable_export_stopped.cjs'), path.join(program, 'release-policy.json'), path.join(program, 'PACKAGE_CONTENTS.txt'), path.join(program, '처음_읽어주세요.txt'),
    path.join(scratch, '0_설치_안내.txt'), path.join(scratch, 'README.md')]) scan(file);
  assert.deepEqual(stale, [], 'no backend, guide or README place keeps the previous version');
  assert.match(fs.readFileSync(path.join(scratch, 'README.md'), 'utf8'), new RegExp(`version-${target.replace(/\./g, '\\.')}-`), 'README badge follows the builder version');

  // The README renderer is strict: a README that lost one of its generated places fails.
  const readme = fs.readFileSync(path.join(scratch, 'README.md'), 'utf8');
  const meta = metadata.readReleaseMetadata(program);
  assert.equal(metadata.renderReadme(readme, meta), readme, 'rendering is idempotent');
  assert.throws(() => metadata.renderReadme(readme.replace(/^\| \*\*GRADIA\*\* .*$/m, ''), meta), /release_readme_invalid:GRADIA/);
  assert.throws(() => metadata.renderReadme(readme.replace(/Storage SDK `/, 'Storage SDK '), meta), /release_readme_invalid:storage sdk/);
  console.log('release_builder_version_backend_scope_test: PASS');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
