'use strict';
// Resolve a tar extractor that can read the archive format this suite produces.
//
// Why this exists: the suite writes Git's ZIP archive on Windows (the tar stream over stdin loses
// Unicode pathnames) but then invoked `tar` from PATH. On this host that resolves to MSYS GNU tar,
// which reads tar archives only and dies on the ZIP with "This does not look like a tar archive" or
// "Cannot connect to C:" - a failure that has nothing to do with the manifest under test. The
// platform's own bsdtar reads the ZIP, so pick it explicitly instead of trusting PATH order.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const candidates = () => {
  const list = [];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    list.push(path.join(systemRoot, 'System32', 'tar.exe'));
  }
  list.push('tar');
  return list;
};

const probe = binary => {
  try {
    const run = spawnSync(binary, ['--version'], { encoding: 'utf8', maxBuffer: 1 << 20 });
    if (run.error || run.status !== 0) return null;
    return { binary, version: String(run.stdout || '').split('\n')[0].trim() };
  } catch (_) {
    return null;
  }
};

// Pick the first candidate that both exists and reports a version, preferring the platform tar.
const resolveTar = (overrides = {}) => {
  for (const binary of candidates()) {
    if (path.isAbsolute(binary) && !fs.existsSync(binary)) continue;
    const found = probe(binary);
    if (found) return found;
  }
  return null;
};

const extractArchive = (archiveFile, destination, options = {}) => {
  const tar = options.tar || resolveTar();
  if (!tar) {
    return { ok: false, reason: 'no_tar_extractor_available', binary: '', stderr: '' };
  }
  const run = spawnSync(tar.binary, ['-xf', archiveFile, '-C', destination],
    { maxBuffer: options.maxBuffer || 64 * 1024 * 1024 });
  return {
    ok: run.status === 0,
    reason: run.status === 0 ? '' : 'tar_extract_failed',
    binary: tar.binary,
    version: tar.version,
    status: run.status,
    stderr: String(run.stderr || '').slice(0, 400)
  };
};

module.exports = { resolveTar, extractArchive, candidates, tmpRoot: () => os.tmpdir() };
