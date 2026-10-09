'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { syncDirectory } = require('./journal.cjs');

const RUNTIME_TOP_LEVEL = new Set([
  'update-state.json',
  'operation-lock.sqlite',
  'operation-lock.sqlite-shm',
  'operation-lock.sqlite-wal',
  '_runtime'
]);

function normalizeRelative(value) {
  return String(value || '').split(path.sep).join('/');
}

function isRuntimeRelative(relativePath) {
  const relative = normalizeRelative(relativePath);
  const first = relative.split('/')[0];
  if (RUNTIME_TOP_LEVEL.has(first)) return true;
  if (relative === 'logs') return true;
  if (relative.startsWith('logs/')) return relative !== 'logs/README.txt';
  if (/(?:^|\/)(?:[^/]+\.(?:log|tmp|bak|old|sqlite|db|zip))(?:$|\/)/i.test(relative)) return true;
  return false;
}

function listStaticFiles(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('updater_bootstrap_source_missing');
  const files = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelative(path.relative(root, absolute));
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`updater_bootstrap_symlink_rejected:${relative}`);
      if (entry.isDirectory()) {
        // logs/ itself must be traversed so the static README can be
        // refreshed; runtime log files inside it remain excluded below.
        if (relative === 'logs' || !isRuntimeRelative(relative)) walk(absolute);
      } else if (entry.isFile()) {
        if (!isRuntimeRelative(relative)) files.push(relative);
      } else throw new Error(`updater_bootstrap_file_kind_rejected:${relative}`);
    }
  };
  walk(root);
  if (!files.includes('updater.cjs')) throw new Error('updater_bootstrap_entrypoint_missing');
  // Replace dependencies first and the executable entrypoint last. If the
  // process dies early, the legacy updater entrypoint remains runnable.
  files.sort((left, right) => {
    if (left === 'updater.cjs') return 1;
    if (right === 'updater.cjs') return -1;
    return left.localeCompare(right, 'en');
  });
  return files;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function staticTreeMatches(sourceRoot, targetRoot, relativeFiles) {
  return relativeFiles.every(relative => {
    const source = path.join(sourceRoot, ...relative.split('/'));
    const target = path.join(targetRoot, ...relative.split('/'));
    return fs.existsSync(target)
      && fs.statSync(target).isFile()
      && fs.statSync(source).size === fs.statSync(target).size
      && sha256File(source) === sha256File(target);
  });
}

async function durableCopyFile(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle = null;
  try {
    const bytes = await fsp.readFile(source);
    const sourceMode = fs.statSync(source).mode & 0o777;
    handle = await fsp.open(temporary, 'wx', sourceMode || 0o600);
    await handle.writeFile(bytes);
    await handle.chmod(sourceMode || 0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function backupStaticFiles(targetUpdaterDir, backupUpdaterDir, relativeFiles) {
  for (const relative of relativeFiles) {
    const source = path.join(targetUpdaterDir, ...relative.split('/'));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const destination = path.join(backupUpdaterDir, ...relative.split('/'));
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fsp.copyFile(source, destination);
  }
  await syncDirectory(path.dirname(backupUpdaterDir));
}

async function installUpdaterIntoTarget({ sourceUpdaterDir, targetRoot, logger = () => {} }) {
  const sourceRoot = fs.realpathSync.native(path.resolve(sourceUpdaterDir));
  const root = fs.realpathSync.native(path.resolve(targetRoot));
  const targetUpdater = path.join(root, 'UPDATER');
  if (sourceRoot === targetUpdater) throw new Error('updater_bootstrap_source_equals_target');
  if (!fs.existsSync(targetUpdater) || !fs.statSync(targetUpdater).isDirectory()) throw new Error('updater_bootstrap_target_missing');
  if (fs.lstatSync(targetUpdater).isSymbolicLink()) throw new Error('updater_bootstrap_target_symlink_rejected');

  const sourceFiles = listStaticFiles(sourceRoot);
  if (staticTreeMatches(sourceRoot, targetUpdater, sourceFiles)) {
    return { installed: false, alreadyCurrent: true, files: sourceFiles.length, rollbackUpdater: null };
  }

  const operationId = `updater-bootstrap-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const rollbackUpdater = path.join(root, '.rollback', operationId, 'UPDATER');
  const targetStaticFiles = listStaticFiles(targetUpdater).filter(relative => !isRuntimeRelative(relative));
  const backupFiles = [...new Set([...sourceFiles, ...targetStaticFiles])].sort((a, b) => a.localeCompare(b, 'en'));
  await backupStaticFiles(targetUpdater, rollbackUpdater, backupFiles);

  logger(`[bootstrap] updater static files ${sourceFiles.length}개 교체`);
  try {
    for (const relative of sourceFiles) {
      await durableCopyFile(
        path.join(sourceRoot, ...relative.split('/')),
        path.join(targetUpdater, ...relative.split('/'))
      );
    }
  } catch (error) {
    // The entrypoint is written last. Restore every backed-up static file and
    // leave runtime state (journal/log/lock DB/_runtime) untouched.
    for (const relative of backupFiles) {
      const backup = path.join(rollbackUpdater, ...relative.split('/'));
      if (!fs.existsSync(backup)) continue;
      await durableCopyFile(backup, path.join(targetUpdater, ...relative.split('/'))).catch(() => {});
    }
    throw error;
  }

  if (!staticTreeMatches(sourceRoot, targetUpdater, sourceFiles)) throw new Error('updater_bootstrap_verify_failed');
  logger('[bootstrap] updater 정적 코드 교체 및 검증 완료');
  return { installed: true, alreadyCurrent: false, files: sourceFiles.length, rollbackUpdater };
}

module.exports = {
  isRuntimeRelative,
  listStaticFiles,
  installUpdaterIntoTarget
};
