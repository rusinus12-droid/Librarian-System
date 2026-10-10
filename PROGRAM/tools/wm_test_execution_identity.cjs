'use strict';
// Verification-only cache identity. A broad closed source snapshot deliberately
// invalidates reuse when any helper, fixture, guard or pinned package changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = file => hash(fs.readFileSync(file));
const schema = 'wm.test-execution-identity.v1';
function treeIdentity(root, source) {
  const files = [];
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (source && (/^(?:\.git|\.development)(?:\/|$)/.test(name) || /^PROGRAM\/wm\/(?:evidence|verification|test-output|dist)(?:\/|$)/.test(name))) continue;
      if (source && (entry.name === 'DATA' || entry.name === '.env' || entry.name === 'node_modules')) throw Error('WM_REUSE_UNSUPPORTED_SOURCE_INPUT:' + name);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, name);
      else if (entry.isFile()) files.push({ path: name, sha256: hashFile(file) });
      else if (!source && entry.isSymbolicLink()) {
        const target = fs.realpathSync(file), within = path.relative(root, target);
        if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within) || !fs.statSync(target).isFile()) throw Error('WM_REUSE_UNSUPPORTED_DEPENDENCY_LINK:' + name);
        files.push({ path: name, link: fs.readlinkSync(file), sha256: hashFile(target) });
      } else throw Error('WM_REUSE_UNSUPPORTED_INPUT_TYPE:' + name);
    }
  };
  walk(root);
  return { root, files: files.length, sha256: hash(JSON.stringify(files)) };
}
function captureWmExecutionIdentity({ programDir, artifact, profile, environment }) {
  if (!['source', 'release'].includes(profile)) throw Error('WM_REUSE_PROFILE_INVALID');
  const program = path.resolve(programDir), sourceRoot = path.dirname(program);
  const roots = [...new Set(String(environment.NODE_PATH || '').split(path.delimiter).filter(Boolean).map(value => path.resolve(value)))];
  const value = {
    schema,
    source: treeIdentity(sourceRoot, true),
    dependencies: roots.map(root => treeIdentity(root, false)),
    identityImplementationSha256: hashFile(__filename),
    runtime: { path: process.execPath, sha256: hashFile(process.execPath), version: process.version, platform: process.platform, arch: process.arch },
    profile,
    artifact: { path: path.resolve(artifact), sha256: hashFile(artifact) },
    hooks: ['strict-offline-guard.cjs', 'portable-test-paths.cjs'].map(filename => {
      const file = path.join(program, 'wm/tools', filename); return { path: file, sha256: hashFile(file) };
    }),
    options: { nodePath: String(environment.NODE_PATH || ''), nodeOptions: String(environment.NODE_OPTIONS || ''),
      flags: ['--expose-gc', '--test', '--test-force-exit', '--test-concurrency=1'] }
  };
  return { ...value, identitySha256: hash(JSON.stringify(value)) };
}
function requireWmExecutionIdentity(prior, current) {
  const saved = prior.executionIdentity;
  if (!saved || saved.schema !== schema || typeof saved.identitySha256 !== 'string') throw Error('WM_REUSE_IDENTITY_REQUIRED');
  const { identitySha256, ...value } = saved;
  if (hash(JSON.stringify(value)) !== identitySha256 || identitySha256 !== current.identitySha256) throw Error('WM_REUSE_IDENTITY_MISMATCH');
}
module.exports = { captureWmExecutionIdentity, requireWmExecutionIdentity };
