'use strict';
// Test-only historical input lookup. The live artifact keeps the unified name.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixtures = Object.freeze({
  source: { filename: 'LIBRA World Manager Full.js', sha256: 'e9f29b4f05d8e33f2f56b2948416596f677ce8626d63facb4e5c5a7838175510' },
  release: { filename: 'LIBRA World Manager.js', sha256: '35cf571214f2f6f0a11a0e099d8ac96d8ce4d35b9ce0d73a6feed923c3f50662' }
});
function artifactProfile({profile=process.env.WM_TEST_PROFILE,artifact=process.env.WM_VERSIONED_DIST||''}={}) {
 if(profile){if(!Object.hasOwn(fixtures,profile))throw Error('WM_FIXTURE_PROFILE_INVALID');return profile;}
 return path.basename(artifact).includes('Full')?'source':'release';
}
function profileLabel(options){return artifactProfile(options)==='source'?'Full':'Min';}
function frozenBArtifact({ wmRoot, profile }) {
  const fixture = fixtures[profile];
  if (!fixture) throw Error('WM_FIXTURE_PROFILE_INVALID');
  const file = path.join(wmRoot, 'references/frozen-B/dist', fixture.filename);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== fixture.sha256) throw Error('WM_FROZEN_FIXTURE_HASH_MISMATCH:' + profile);
  return { path: file, sha256: fixture.sha256 };
}
function privacyArtifacts({ wmRoot, artifact, label, sha256 } = {}) {
  if (!artifact) return ['LIBRA World Manager Full.js', 'LIBRA World Manager.js'].map(file => ({ file, path: path.join(wmRoot, 'dist', file) }));
  if (!label || !/^[a-f0-9]{64}$/.test(sha256 || '')) throw Error('WM_PRIVACY_ARTIFACT_IDENTITY_REQUIRED');
  const file = path.resolve(artifact);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== sha256) throw Error('WM_PRIVACY_ARTIFACT_HASH_MISMATCH');
  if (process.env.WM_PRIVACY_TARGET_AUDIT) fs.appendFileSync(process.env.WM_PRIVACY_TARGET_AUDIT, JSON.stringify({ path: file, sha256: actual, label, kind: 'read-and-verify-explicit-privacy-artifact' }) + '\n');
  return [{ file: label, path: file, sha256: actual }];
}
function immutableBaseRoot({ wmRoot }) {
  const root = path.resolve(wmRoot), pins = JSON.parse(fs.readFileSync(path.join(root, 'BASE-PINS.json'), 'utf8'));
  if (pins.base !== 'references/immutable-base' || !Array.isArray(pins.files) || !pins.files.length) throw Error('WM_IMMUTABLE_BASE_PINS_INVALID');
  const base = path.resolve(root, pins.base);
  if (fs.realpathSync(base) !== base) throw Error('WM_IMMUTABLE_BASE_PATH_INVALID');
  const seen = new Set();
  for (const pin of pins.files) {
    if (!pin || typeof pin.file !== 'string' || !pin.file || path.isAbsolute(pin.file) || pin.file.split(/[\\/]/).includes('..') || seen.has(pin.file) || !/^[a-f0-9]{64}$/.test(pin.sha256 || '')) throw Error('WM_IMMUTABLE_BASE_PIN_INVALID');
    seen.add(pin.file);
    const file = path.resolve(base, pin.file);
    if (!file.startsWith(base + path.sep) || fs.realpathSync(file) !== file) throw Error('WM_IMMUTABLE_BASE_FILE_INVALID');
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== pin.sha256) throw Error('WM_IMMUTABLE_BASE_HASH_MISMATCH:' + pin.file);
  }
  return base;
}
function immutableBaseArtifact({ wmRoot, profile = artifactProfile() }) {
  const names = { source: 'LIBRA World Manager Full.js', release: 'LIBRA World Manager.js' };
  if (!names[profile]) throw Error('WM_FIXTURE_PROFILE_INVALID');
  return path.join(immutableBaseRoot({ wmRoot }), 'dist', names[profile]);
}
module.exports = { frozenBArtifact, privacyArtifacts, artifactProfile, profileLabel, immutableBaseRoot, immutableBaseArtifact };
