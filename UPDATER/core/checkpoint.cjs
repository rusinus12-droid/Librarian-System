'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { atomicWriteJson, syncDirectory } = require('./journal.cjs');

const sha256File = async filePath => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
};

async function scanTree(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];
  let totalBytes = 0;
  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`data_checkpoint_symlink_rejected:${relative}`);
      if (stat.isDirectory()) { await walk(absolute); continue; }
      if (!stat.isFile()) throw new Error(`data_checkpoint_special_file_rejected:${relative}`);
      files.push({ relative, bytes: stat.size, mode: stat.mode & 0o777, mtimeMs: Math.trunc(stat.mtimeMs) });
      totalBytes += stat.size;
    }
  }
  if (!fs.existsSync(root)) throw new Error(`data_checkpoint_source_missing:${root}`);
  if ((await fsp.lstat(root)).isSymbolicLink()) throw new Error('data_checkpoint_root_symlink_rejected');
  await walk(root);
  return { root, files, totalBytes };
}

async function hashManifest(rootDir, scan = null) {
  const info = scan || await scanTree(rootDir);
  const rows = [];
  for (const file of info.files) {
    const absolute = path.join(info.root, ...file.relative.split('/'));
    rows.push({ ...file, sha256: await sha256File(absolute) });
  }
  const canonical = rows.map(r => `${r.sha256} ${r.bytes} ${r.relative}`).join('\n');
  return {
    schema: 'librarian.data-checkpoint.v1',
    files: rows,
    fileCount: rows.length,
    totalBytes: info.totalBytes,
    treeSha256: crypto.createHash('sha256').update(canonical).digest('hex')
  };
}

async function assertDiskSpace(destinationParent, requiredBytes) {
  if (typeof fsp.statfs !== 'function') return { checked: false };
  const stat = await fsp.statfs(destinationParent);
  const free = Number(stat.bavail) * Number(stat.bsize);
  const need = Math.ceil(Number(requiredBytes || 0) * 1.08 + 64 * 1024 * 1024);
  if (Number.isFinite(free) && free < need) throw new Error(`data_checkpoint_insufficient_space:${free}<${need}`);
  return { checked: true, freeBytes: free, requiredBytes: need };
}

async function copyFileStrict(source, target, mode) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await pipeline(fs.createReadStream(source), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  const file = await fsp.open(target, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  await fsp.chmod(target, mode || 0o600);
  await syncDirectory(path.dirname(target));
}

async function createDataCheckpoint({ dataDir, checkpointDir }) {
  const source = path.resolve(dataDir);
  const checkpointRoot = path.resolve(checkpointDir);
  const destination = path.join(checkpointRoot, 'DATA');
  if (fs.existsSync(checkpointRoot)) throw new Error(`data_checkpoint_destination_exists:${checkpointRoot}`);
  const scan = await scanTree(source);
  await fsp.mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
  await assertDiskSpace(checkpointRoot, scan.totalBytes);
  try {
    await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
    for (const file of scan.files) {
      const src = path.join(source, ...file.relative.split('/'));
      const dst = path.join(destination, ...file.relative.split('/'));
      await copyFileStrict(src, dst, file.mode);
    }
    const sourceManifest = await hashManifest(source, scan);
    const copyManifest = await hashManifest(destination);
    if (sourceManifest.treeSha256 !== copyManifest.treeSha256 || sourceManifest.fileCount !== copyManifest.fileCount) {
      throw new Error('data_checkpoint_readback_mismatch');
    }
    const manifest = {
      ...sourceManifest,
      createdAt: new Date().toISOString(),
      sourceName: path.basename(source),
      checkpointDataRelative: 'DATA'
    };
    // The manifest is the completion marker; publish only after copy readback.
    await syncDirectory(destination);
    await atomicWriteJson(path.join(checkpointRoot, 'checkpoint-manifest.json'), manifest);
    await syncDirectory(path.dirname(checkpointRoot));
    return { checkpointRoot, checkpointData: destination, manifest };
  } catch (error) {
    await fsp.rm(checkpointRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyDataCheckpoint(checkpointRoot, restoredDataPath = null) {
  const root = path.resolve(checkpointRoot);
  const manifestPath = path.join(root, 'checkpoint-manifest.json');
  let expected;
  try { expected = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); }
  catch (error) { throw new Error(`data_checkpoint_manifest_invalid:${error?.message || error}`); }
  if (expected?.schema !== 'librarian.data-checkpoint.v1') throw new Error('data_checkpoint_manifest_schema_invalid');
  const dataPath = restoredDataPath ? path.resolve(restoredDataPath) : path.join(root, 'DATA');
  const actual = await hashManifest(dataPath);
  if (actual.treeSha256 !== expected.treeSha256 || actual.fileCount !== expected.fileCount || actual.totalBytes !== expected.totalBytes) {
    throw new Error('data_checkpoint_verify_failed');
  }
  return { manifest: expected, dataPath };
}

module.exports = { sha256File, scanTree, hashManifest, createDataCheckpoint, verifyDataCheckpoint };
