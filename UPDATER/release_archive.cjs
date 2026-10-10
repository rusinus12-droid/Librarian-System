'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { inspectZip, extractEntry, sha256File } = require('../PROGRAM/server/portable/stream_archive.cjs');
const {
  OFFICIAL_REPOSITORY,
  expectedAssetName,
  normalizeVersion,
  validateUpdateManifest
} = require('../PROGRAM/tools/release_asset_contract.cjs');
const { readReleaseMetadata } = require('../PROGRAM/tools/release_metadata.cjs');
const { assertPristineDistributionData } = require('../PROGRAM/tools/runtime_release_validation.cjs');

const REQUIRED_ROOT_FILES = Object.freeze([
  '0_설치_안내.txt',
  'SHA256SUMS.txt',
  'update-manifest.json',
  '업데이트.bat',
  '업데이트.command',
  '업데이트.sh'
]);
const REQUIRED_ROOT_DIRS = new Set(['PROGRAM', 'DATA', 'UPDATER']);
const ALLOWED_ROOT_FILES = new Set(REQUIRED_ROOT_FILES);

function safeRelative(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`release_archive_path_unsafe:${relative}`);
  }
  return normalized;
}

async function readEntryBuffer(archivePath, entry, maxBytes = 2 * 1024 * 1024) {
  if (!entry || entry.name.endsWith('/')) throw new Error('release_archive_file_entry_required');
  if (entry.raw > maxBytes) throw new Error(`release_archive_entry_too_large:${entry.name}`);
  const parts = [];
  await extractEntry(archivePath, entry, new Writable({
    write(chunk, _encoding, callback) { parts.push(Buffer.from(chunk)); callback(); }
  }));
  return Buffer.concat(parts);
}

function parseChecksumFile(source) {
  const rows = String(source || '').trim().split(/\r?\n/).filter(Boolean);
  if (!rows.length) throw new Error('release_archive_checksums_empty');
  const map = new Map();
  for (const row of rows) {
    const match = row.match(/^([a-f0-9]{64})  \.\/(.+)$/i);
    if (!match) throw new Error(`release_archive_checksum_row_invalid:${row.slice(0, 160)}`);
    const relative = safeRelative(match[2]);
    if (map.has(relative)) throw new Error(`release_archive_checksum_duplicate:${relative}`);
    map.set(relative, match[1].toLowerCase());
  }
  return map;
}

async function sha256FileStreaming(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 256 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyChecksumTree(rootDir) {
  const root = path.resolve(rootDir);
  const checksumPath = path.join(root, 'SHA256SUMS.txt');
  const expected = parseChecksumFile(await fsp.readFile(checksumPath, 'utf8'));
  const actualFiles = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`release_archive_symlink_rejected:${path.relative(root, absolute)}`);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile() && path.resolve(absolute) !== path.resolve(checksumPath)) actualFiles.push(absolute);
      else if (!stat.isFile()) throw new Error(`release_archive_file_kind_rejected:${path.relative(root, absolute)}`);
    }
  }
  await walk(root);
  actualFiles.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b), 'en'));
  if (actualFiles.length !== expected.size) throw new Error(`release_archive_checksum_count_mismatch:${actualFiles.length}!=${expected.size}`);
  for (const filePath of actualFiles) {
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    const digest = expected.get(relative);
    if (!digest) throw new Error(`release_archive_checksum_missing:${relative}`);
    if ((await sha256FileStreaming(filePath)) !== digest) throw new Error(`release_archive_checksum_mismatch:${relative}`);
    expected.delete(relative);
  }
  if (expected.size) throw new Error(`release_archive_checksum_orphan:${[...expected.keys()][0]}`);
  return { files: actualFiles.length };
}

function assertReleaseRootLayout(entries, rootName) {
  const prefix = `${rootName}/`;
  const topFiles = new Set();
  const topDirs = new Set();
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) throw new Error(`release_archive_root_mismatch:${entry.name}`);
    const relative = entry.name.slice(prefix.length).replace(/\/$/, '');
    if (!relative) continue;
    const [first, ...rest] = relative.split('/');
    if (rest.length) topDirs.add(first);
    else if (!entry.name.endsWith('/')) topFiles.add(first);
  }
  for (const file of REQUIRED_ROOT_FILES) if (!topFiles.has(file)) throw new Error(`release_archive_required_file_missing:${file}`);
  for (const file of topFiles) if (!ALLOWED_ROOT_FILES.has(file)) throw new Error(`release_archive_unexpected_root_file:${file}`);
  for (const dir of REQUIRED_ROOT_DIRS) if (!topDirs.has(dir)) throw new Error(`release_archive_required_root_dir_missing:${dir}`);
  for (const dir of topDirs) if (!REQUIRED_ROOT_DIRS.has(dir)) throw new Error(`release_archive_unexpected_root_dir:${dir}`);
}

async function extractArchive({ archivePath, destinationRoot, targetVersion }) {
  const version = normalizeVersion(targetVersion, 'target_version');
  const expectedRoot = `Librarian-System-${version}`;
  const info = await inspectZip(archivePath);
  const roots = new Set(info.entries.map(entry => entry.name.split('/')[0]));
  if (roots.size !== 1 || !roots.has(expectedRoot)) throw new Error(`release_archive_top_level_invalid:${[...roots].join(',')}`);
  assertReleaseRootLayout(info.entries, expectedRoot);
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) throw new Error(`release_archive_destination_exists:${destination}`);
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  await fsp.mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const entry of info.entries) {
      const relativeWithRoot = entry.name.slice(expectedRoot.length + 1);
      if (!relativeWithRoot) continue;
      const relative = safeRelative(relativeWithRoot.replace(/\/$/, ''));
      const output = path.resolve(temporary, ...relative.split('/'));
      if (output !== temporary && !output.startsWith(`${temporary}${path.sep}`)) throw new Error(`release_archive_path_escape:${relative}`);
      if (entry.name.endsWith('/')) {
        await fsp.mkdir(output, { recursive: true, mode: 0o700 });
        continue;
      }
      await fsp.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await extractEntry(archivePath, entry, fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }));
      if (/\.(?:sh|command)$/i.test(relative)) await fsp.chmod(output, 0o755);
      else await fsp.chmod(output, 0o644);
    }
    await fsp.rename(temporary, destination);
    return { root: destination, entries: info.entries.length, bytes: info.bytes, expandedBytes: info.expandedBytes };
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function compareComponentVersions(manifest, programRoot) {
  const metadata = readReleaseMetadata(programRoot);
  const expected = {
    backend: metadata.packageVersion,
    libra: metadata.plugins.libra.version,
    hayaku: metadata.plugins.hayaku.version,
    flashback: metadata.plugins.flashback.version,
    lia: metadata.plugins.lia.version,
    retrace: metadata.plugins.retrace.version,
      gradia: metadata.plugins.gradia.version,
    storageSdk: metadata.storageSdkVersion,
    computeSdk: metadata.computeSdkVersion
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(manifest?.components?.[key] || '') !== String(value)) throw new Error(`release_archive_component_version_mismatch:${key}`);
  }
  return expected;
}

async function validateExtractedRelease({ rootDir, targetVersion, currentVersion = null }) {
  const root = path.resolve(rootDir);
  const version = normalizeVersion(targetVersion, 'target_version');
  const manifestPath = path.join(root, 'update-manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); }
  catch (error) { throw new Error(`release_archive_update_manifest_invalid:${error?.message || error}`); }
  const validated = validateUpdateManifest(manifest, {
    expectedVersion: version,
    expectedAssetName: expectedAssetName(version),
    expectedChannel: 'stable'
  });
  if (manifest.repository !== OFFICIAL_REPOSITORY) throw new Error('release_archive_repository_mismatch');
  if (currentVersion) {
    const current = normalizeVersion(currentVersion, 'current_version');
    const min = validated.minimumSourceVersion.split('.').map(Number);
    const cur = current.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
      if ((cur[index] || 0) > (min[index] || 0)) break;
      if ((cur[index] || 0) < (min[index] || 0)) throw new Error(`release_archive_source_version_too_old:${current}<${validated.minimumSourceVersion}`);
    }
  }
  const checksum = await verifyChecksumTree(root);
  const components = compareComponentVersions(manifest, path.join(root, 'PROGRAM'));
  assertPristineDistributionData(path.join(root, 'DATA'));
  if (!fs.existsSync(path.join(root, 'UPDATER', 'updater.cjs'))) throw new Error('release_archive_updater_missing');
  return { manifest, checksum, components, updatePolicy: validated.updatePolicy };
}

async function prepareReleaseCandidate({ archivePath, workRoot, targetVersion, currentVersion, expectedArchiveSha256 = null }) {
  const archive = path.resolve(archivePath);
  const version = normalizeVersion(targetVersion, 'target_version');
  const actualSha256 = await sha256File(archive);
  if (expectedArchiveSha256 && actualSha256 !== String(expectedArchiveSha256).toLowerCase()) throw new Error('release_archive_outer_sha256_mismatch');
  const root = path.resolve(workRoot);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const candidateRoot = path.join(root, `candidate-${version}`);
  const programNext = path.join(root, 'PROGRAM.next');
  await fsp.rm(candidateRoot, { recursive: true, force: true });
  await fsp.rm(programNext, { recursive: true, force: true });
  const extracted = await extractArchive({ archivePath: archive, destinationRoot: candidateRoot, targetVersion: version });
  try {
    const verified = await validateExtractedRelease({ rootDir: candidateRoot, targetVersion: version, currentVersion });
    await fsp.cp(path.join(candidateRoot, 'PROGRAM'), programNext, { recursive: true, errorOnExist: true, force: false });
    const receipt = {
      schema: 'librarian.update-candidate.v1',
      currentVersion: normalizeVersion(currentVersion, 'current_version'),
      targetVersion: version,
      asset: expectedAssetName(version),
      sha256: actualSha256,
      updatePolicy: verified.updatePolicy,
      candidateRoot,
      programNext,
      releaseDataTemplate: path.join(candidateRoot, 'DATA'),
      preparedAt: new Date().toISOString(),
      verifiedFiles: verified.checksum.files,
      components: verified.components
    };
    await fsp.writeFile(path.join(root, 'candidate.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return receipt;
  } catch (error) {
    await fsp.rm(candidateRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(programNext, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  REQUIRED_ROOT_FILES,
  parseChecksumFile,
  verifyChecksumTree,
  assertReleaseRootLayout,
  extractArchive,
  validateExtractedRelease,
  prepareReleaseCandidate
};
