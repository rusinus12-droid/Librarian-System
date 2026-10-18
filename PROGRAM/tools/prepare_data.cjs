'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const defaultProgramDir = path.resolve(__dirname, '..');
const DATA_LAYOUT_SCHEMA = 'memory-suite.data-layout.v1';
const DATA_LAYOUT_VERSION = 1;
const SERVER_CONFIG_SCHEMA = 'memory-suite.server-config.v1';
function readProgramVersion(programDir = defaultProgramDir) {
  const filePath = path.join(path.resolve(programDir), 'VERSION.txt');
  let stat, source;
  try { stat = fs.lstatSync(filePath); }
  catch (_) { throw Object.assign(new Error('prepare_data_program_version_unavailable'), { code: 'PREPARE_DATA_PROGRAM_VERSION_UNAVAILABLE' }); }
  if (!stat.isFile()) throw Object.assign(new Error('prepare_data_program_version_invalid'), { code: 'PREPARE_DATA_PROGRAM_VERSION_INVALID' });
  try { source = fs.readFileSync(filePath, 'utf8').trim(); }
  catch (_) { throw Object.assign(new Error('prepare_data_program_version_unavailable'), { code: 'PREPARE_DATA_PROGRAM_VERSION_UNAVAILABLE' }); }
  if (!/^\d+\.\d+\.\d+$/.test(source)) throw Object.assign(new Error('prepare_data_program_version_invalid'), { code: 'PREPARE_DATA_PROGRAM_VERSION_INVALID' });
  return source;
}
const DEFAULT_CONFIG = Object.freeze({
  schema: SERVER_CONFIG_SCHEMA,
  host: '127.0.0.1',
  port: 47630,
  autoBackup: true,
  computeEnabled: true,
  computeWorkers: 0
});

const nowIso = () => new Date().toISOString();
const safeStamp = () => nowIso().replace(/[:.]/g, '-');
const sha256File = filePath => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
};

function parseArgs(argv = process.argv.slice(2)) {
  const result = { programDir: path.resolve(__dirname, '..'), dataDir: '', freshDistribution: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--program-dir') {
      if (!argv[index + 1] || String(argv[index + 1]).startsWith('--')) throw new Error('prepare_data_program_dir_value_required');
      result.programDir = path.resolve(argv[++index]);
    } else if (arg === '--data-dir') {
      if (!argv[index + 1] || String(argv[index + 1]).startsWith('--')) throw new Error('prepare_data_data_dir_value_required');
      result.dataDir = path.resolve(argv[++index]);
    }
    else if (arg === '--fresh-distribution' || arg === '--no-legacy-migration') result.freshDistribution = true;
    else throw new Error(`unknown_prepare_data_argument:${arg}`);
  }
  if (!result.dataDir) result.dataDir = path.resolve(result.programDir, '..', 'DATA');
  result.rootDir = path.dirname(result.programDir);
  return result;
}

function fsyncDirectory(directoryPath) {
  let fd = null;
  try { fd = fs.openSync(directoryPath, 'r'); fs.fsyncSync(fd); } catch (_) {}
  finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }
}

function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    const buffer = Buffer.from(String(value), 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(temp, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    throw error;
  }
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return fallback; }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function listFiles(root) {
  const rows = [];
  if (!fs.existsSync(root)) return rows;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`prepare_data_symbolic_link_is_not_allowed:${full}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) rows.push(full);
    }
  };
  walk(root);
  return rows;
}

function relativeFilesFingerprint(root) {
  const rows = [];
  for (const filePath of listFiles(root)) {
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    if (/^(?:README(?:\.txt)?|\.keep\.txt)$/i.test(path.basename(relative))) continue;
    rows.push(`${relative}\0${fs.statSync(filePath).size}\0${sha256File(filePath)}`);
  }
  rows.sort();
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

function hasMeaningfulData(root) {
  if (!root || !fs.existsSync(root)) return false;
  const pending = [path.resolve(root)];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      const relative = path.relative(root, filePath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (/^(?:logs|migrations)(?:\/|$)/i.test(relative)) continue;
        pending.push(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const base = entry.name;
      if (/^(?:README(?:\.txt)?|\.keep\.txt|이_폴더.*\.txt)$/i.test(base)) continue;
      if (relative === 'config/server-config.json' || relative === 'data-layout.json') continue;
      if (/\.sqlite(?:-wal|-shm)?$/i.test(base)) return true;
      if (/runtime-token\.txt$/i.test(base)) return true;
      if (/manifest\.json$/i.test(base) && /(?:^|\/)backups\//i.test(relative)) return true;
      if (/^stores\//i.test(relative) && fs.statSync(filePath).size > 0) return true;
    }
  }
  return false;
}

function uniqueExistingDirectories(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || !fs.existsSync(value) || !fs.statSync(value).isDirectory()) continue;
    const key = normalizedPath(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path.resolve(value));
  }
  return out;
}

function selectLegacyDataCandidate(candidates, dataDir) {
  const meaningful = uniqueExistingDirectories(candidates)
    .filter(candidate => !samePath(candidate, dataDir))
    .filter(hasMeaningfulData);
  if (!meaningful.length) return null;
  if (meaningful.length === 1) return meaningful[0];
  const fingerprints = meaningful.map(candidate => ({ candidate, fingerprint: relativeFilesFingerprint(candidate) }));
  if (new Set(fingerprints.map(row => row.fingerprint)).size === 1) return meaningful[0];
  const error = new Error(`multiple_legacy_data_candidates:${meaningful.join('|')}`);
  error.code = 'MULTIPLE_LEGACY_DATA_CANDIDATES';
  throw error;
}

// A "case-only" legacy directory is one whose path differs from the destination
// only by letter case, on a filesystem that treats both spellings as the SAME
// directory. That is not a Windows-only situation: macOS APFS is case-insensitive
// by default, so `<root>/data` and `<root>/DATA` resolve to one directory there
// too (`statSync(a).ino === statSync(b).ino` is true while the resolved path
// strings differ).
//
// Detection therefore uses filesystem identity, not the platform name. The
// win32-only gate this replaced made macOS skip the `case_only_in_place`
// migration entirely, so the legacy DATA was reported as un-migrated even though
// it was already in place.
function sameDirectory(left, right) {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

function selectCaseOnlyLegacyDataCandidate(candidates, dataDir) {
  const destination = path.resolve(dataDir);
  if (!fs.existsSync(destination) || !fs.statSync(destination).isDirectory()) return null;
  return candidates
    .map(value => path.resolve(value))
    .find(candidate => (
      candidate !== destination
      && fs.existsSync(candidate)
      && fs.statSync(candidate).isDirectory()
      // Same underlying directory, but spelled differently: letter case only.
      && sameDirectory(candidate, destination)
      // samePath folds case on Windows, so negating it suppresses precisely the
      // in-place case-only migration that this branch must recognize.
      && candidate.toLowerCase() === destination.toLowerCase()
      && hasMeaningfulData(candidate)
    )) || null;
}

function copyTreeVerified(sourceRoot, targetRoot, options = {}) {
  const copied = [];
  const skipped = [];
  const conflicts = [];
  let bytes = 0;
  for (const sourcePath of listFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, sourcePath);
    const normalizedRelative = relative.split(path.sep).join('/');
    if (options.skip && options.skip(normalizedRelative, sourcePath)) continue;
    const targetPath = path.join(targetRoot, relative);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath)) {
      const sourceHash = sha256File(sourcePath);
      const targetHash = sha256File(targetPath);
      if (sourceHash === targetHash) {
        skipped.push(normalizedRelative);
        continue;
      }
      if (options.allowTemplateOverwrite && options.allowTemplateOverwrite(normalizedRelative, targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
      } else {
        conflicts.push(normalizedRelative);
        continue;
      }
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    const sourceHash = sha256File(sourcePath);
    const targetHash = sha256File(targetPath);
    if (sourceHash !== targetHash || fs.statSync(sourcePath).size !== fs.statSync(targetPath).size) {
      throw new Error(`legacy_copy_verification_failed:${normalizedRelative}`);
    }
    bytes += fs.statSync(targetPath).size;
    copied.push({ relative: normalizedRelative, sha256: targetHash, bytes: fs.statSync(targetPath).size });
  }
  if (conflicts.length) {
    const error = new Error(`legacy_data_conflict:${conflicts.join(',')}`);
    error.code = 'LEGACY_DATA_CONFLICT';
    error.conflicts = conflicts;
    throw error;
  }
  return { copied, skipped, bytes };
}

function parseLegacyConfig(candidates) {
  for (const filePath of candidates) {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    let source = '';
    try { source = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }
    const host = source.match(/set\s+"?MEMORY_SUITE_HOST=([^"\r\n]+)"?/i)?.[1]?.trim();
    const portRaw = source.match(/set\s+"?MEMORY_SUITE_PORT=([^"\r\n]+)"?/i)?.[1]?.trim();
    const port = Number(portRaw);
    const validHost = ['127.0.0.1', 'localhost', '::1'].includes(String(host || '').toLowerCase()) ? host : DEFAULT_CONFIG.host;
    const validPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_CONFIG.port;
    return { ...DEFAULT_CONFIG, host: validHost, port: validPort, migratedFrom: path.resolve(filePath) };
  }
  return { ...DEFAULT_CONFIG };
}

function ensureConfig(dataDir, legacyConfigCandidates = [], options = {}) {
  const configPath = path.join(dataDir, 'config', 'server-config.json');
  if (!fs.existsSync(configPath)) {
    const config = parseLegacyConfig(legacyConfigCandidates);
    atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { created: true, configPath, config };
  }
  let config = readJson(configPath, null);
  if (!config || config.schema !== SERVER_CONFIG_SCHEMA) throw new Error('invalid_server_config_schema');
  const hasComputeEnabled = Object.prototype.hasOwnProperty.call(config, 'computeEnabled');
  const hasComputeWorkers = Object.prototype.hasOwnProperty.call(config, 'computeWorkers');
  // Server Compute is retired. The two legacy keys stay in the distribution template (older
  // updaters check its exact key set) but any existing value is accepted and never rejected.
  config = {
    ...config,
    computeEnabled: hasComputeEnabled ? config.computeEnabled : DEFAULT_CONFIG.computeEnabled,
    computeWorkers: hasComputeWorkers ? config.computeWorkers : DEFAULT_CONFIG.computeWorkers
  };
  const isPristineDefault = String(config.host || '').toLowerCase() === DEFAULT_CONFIG.host
    && Number(config.port) === DEFAULT_CONFIG.port
    && config.autoBackup !== false
    && config.computeEnabled === DEFAULT_CONFIG.computeEnabled
    && config.computeWorkers === DEFAULT_CONFIG.computeWorkers
    && Object.keys(config).every(key => ['schema', 'host', 'port', 'autoBackup', 'computeEnabled', 'computeWorkers'].includes(key));
  if (options.preferLegacy === true && isPristineDefault) {
    const legacy = parseLegacyConfig(legacyConfigCandidates);
    if (legacy.migratedFrom && (legacy.host !== config.host || legacy.port !== config.port)) {
      atomicWrite(configPath, `${JSON.stringify(legacy, null, 2)}\n`);
      config = legacy;
    }
  }
  const host = String(config.host || '').toLowerCase();
  const port = Number(config.port);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('server_config_host_must_be_loopback');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('server_config_port_invalid');
  if (!hasComputeEnabled || !hasComputeWorkers) {
    atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { created: false, configPath, config };
}


function preflightLayout(dataDir) {
  const layoutPath = path.join(dataDir, 'data-layout.json');
  if (!fs.existsSync(layoutPath)) return null;
  const current = readJson(layoutPath, null);
  if (!current || current.schema !== DATA_LAYOUT_SCHEMA) throw new Error('invalid_data_layout_schema');
  const version = Number(current.layoutVersion || 0);
  if (version > DATA_LAYOUT_VERSION) {
    const error = new Error(`data_layout_newer_than_program:${version}>${DATA_LAYOUT_VERSION}`);
    error.code = 'DATA_LAYOUT_NEWER_THAN_PROGRAM';
    throw error;
  }
  return current;
}

function writeLayout(dataDir, programVersion) {
  const layoutPath = path.join(dataDir, 'data-layout.json');
  const current = readJson(layoutPath, null);
  if (current) {
    if (current.schema !== DATA_LAYOUT_SCHEMA) throw new Error('invalid_data_layout_schema');
    const version = Number(current.layoutVersion || 0);
    if (version > DATA_LAYOUT_VERSION) {
      const error = new Error(`data_layout_newer_than_program:${version}>${DATA_LAYOUT_VERSION}`);
      error.code = 'DATA_LAYOUT_NEWER_THAN_PROGRAM';
      throw error;
    }
    if (version < DATA_LAYOUT_VERSION) {
      const error = new Error(`unsupported_data_layout_upgrade:${version}->${DATA_LAYOUT_VERSION}`);
      error.code = 'UNSUPPORTED_DATA_LAYOUT_UPGRADE';
      throw error;
    }
  }
  const next = {
    schema: DATA_LAYOUT_SCHEMA,
    layoutVersion: DATA_LAYOUT_VERSION,
    createdAt: current?.createdAt || nowIso(),
    lastPreparedAt: nowIso(),
    lastProgramVersion: programVersion,
    portableRoot: true,
    programFolder: 'PROGRAM',
    dataFolder: 'DATA',
    backupRule: 'stop_server_then_copy_entire_DATA_folder',
    recoveryQuarantine: 'backups/recovery-quarantine',
    restoreJournal: 'migrations/restore-transaction.json',
    scopeCatalogPrevious: 'config/scope-catalog.previous.json'
  };
  atomicWrite(layoutPath, `${JSON.stringify(next, null, 2)}\n`);
  return { layoutPath, layout: next, existed: !!current };
}

function ensureLayout(dataDir, programDir = defaultProgramDir) {
  return writeLayout(dataDir, readProgramVersion(programDir));
}

function ensureDataDirectories(dataDir) {
  const directories = [
    'config',
    'stores',
    path.join('backups', 'auto'),
    path.join('backups', 'manual'),
    path.join('backups', 'pre-migration'),
    path.join('backups', 'deleted-scopes'),
    path.join('backups', 'recovery-quarantine'),
    'logs',
    'migrations'
  ];
  for (const relative of directories) fs.mkdirSync(path.join(dataDir, relative), { recursive: true });
}

function assertFreshDistributionTarget(dataDir) {
  if (!fs.existsSync(dataDir)) return;
  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  if (entries.length === 0) return;
  const error = new Error(`fresh_distribution_data_dir_must_be_empty:${dataDir}`);
  error.code = 'FRESH_DISTRIBUTION_DATA_DIR_NOT_EMPTY';
  throw error;
}

function migrateLegacyLayout({ programDir, rootDir, dataDir }) {
  const legacyCandidates = [
    path.join(rootDir, 'data'),
    path.join(programDir, 'data')
  ];
  const caseOnlyLegacyData = selectCaseOnlyLegacyDataCandidate(legacyCandidates, dataDir);
  const legacyData = selectLegacyDataCandidate(legacyCandidates, dataDir);
  const destinationHasData = legacyData ? hasMeaningfulData(dataDir) : false;
  let dataMigration = null;
  const priorDataReceipts = listFiles(path.join(dataDir, 'migrations'))
    .filter(filePath => /legacy-data-.*\.json$/i.test(path.basename(filePath)))
    .map(filePath => readJson(filePath, null))
    .filter(Boolean);
  const caseOnlyAlreadyAdopted = caseOnlyLegacyData && priorDataReceipts.some(receipt => (
    receipt.migrationMode === 'case_only_in_place'
    && receipt.destination
    && samePath(receipt.destination, dataDir)
  ));
  if (caseOnlyLegacyData && !caseOnlyAlreadyAdopted) {
    dataMigration = {
      schema: 'memory-suite.legacy-layout-migration.v1',
      migrationMode: 'case_only_in_place',
      migratedAt: nowIso(),
      source: caseOnlyLegacyData,
      destination: dataDir,
      sourcePreserved: true,
      filesCopied: 0,
      filesSkippedAsIdentical: listFiles(dataDir).length,
      bytesCopied: 0,
      fileDigest: relativeFilesFingerprint(dataDir)
    };
    atomicWrite(path.join(dataDir, 'migrations', `legacy-data-${safeStamp()}.json`), `${JSON.stringify(dataMigration, null, 2)}\n`);
  } else if (legacyData && !destinationHasData) {
    const copied = copyTreeVerified(legacyData, dataDir, {
      skip: relative => /^(?:README(?:\.txt)?|\.keep\.txt)$/i.test(path.basename(relative))
    });
    dataMigration = {
      schema: 'memory-suite.legacy-layout-migration.v1',
      migratedAt: nowIso(),
      source: legacyData,
      destination: dataDir,
      sourcePreserved: true,
      filesCopied: copied.copied.length,
      filesSkippedAsIdentical: copied.skipped.length,
      bytesCopied: copied.bytes,
      fileDigest: crypto.createHash('sha256').update(JSON.stringify(copied.copied)).digest('hex')
    };
    atomicWrite(path.join(dataDir, 'migrations', `legacy-data-${safeStamp()}.json`), `${JSON.stringify(dataMigration, null, 2)}\n`);
  }

  const legacyLogs = uniqueExistingDirectories([
    path.join(rootDir, 'logs'),
    path.join(programDir, 'logs')
  ]).filter(candidate => !samePath(candidate, path.join(dataDir, 'logs')));
  let logMigration = null;
  const priorLogReceipts = listFiles(path.join(dataDir, 'migrations'))
    .filter(filePath => /legacy-logs-.*\.json$/i.test(path.basename(filePath)))
    .map(filePath => readJson(filePath, null))
    .filter(Boolean);
  const nonEmptyLogCandidate = legacyLogs.find(candidate => (
    listFiles(candidate).some(file => fs.statSync(file).size > 0)
    && !priorLogReceipts.some(receipt => receipt.source && samePath(receipt.source, candidate))
  ));
  if (nonEmptyLogCandidate) {
    const target = path.join(dataDir, 'logs', `legacy-${safeStamp()}`);
    const copied = copyTreeVerified(nonEmptyLogCandidate, target, {
      skip: relative => /^(?:README(?:\.txt)?|\.keep\.txt)$/i.test(path.basename(relative))
    });
    if (copied.copied.length) {
      logMigration = {
        schema: 'memory-suite.legacy-log-migration.v1',
        migratedAt: nowIso(),
        source: nonEmptyLogCandidate,
        destination: target,
        sourcePreserved: true,
        filesCopied: copied.copied.length,
        bytesCopied: copied.bytes
      };
      atomicWrite(path.join(dataDir, 'migrations', `legacy-logs-${safeStamp()}.json`), `${JSON.stringify(logMigration, null, 2)}\n`);
    } else {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
    }
  }
  return { dataMigration, logMigration };
}

function main() {
  const args = parseArgs();
  // Bind receipt and layout to one selected-package version before any DATA,
  // legacy migration or settings mutation. No historical-version fallback.
  const programVersion = readProgramVersion(args.programDir);
  if (args.freshDistribution) assertFreshDistributionTarget(args.dataDir);
  if (fs.existsSync(args.dataDir)) preflightLayout(args.dataDir);
  fs.mkdirSync(args.dataDir, { recursive: true });
  ensureDataDirectories(args.dataDir);
  const migration = args.freshDistribution
    ? { dataMigration: null, logMigration: null }
    : migrateLegacyLayout(args);
  ensureDataDirectories(args.dataDir);
  const legacyConfigCandidates = args.freshDistribution ? [] : [
    path.join(args.rootDir, 'memory-suite-config.cmd'),
    path.join(args.programDir, 'memory-suite-config.cmd')
  ];
  const config = ensureConfig(args.dataDir, legacyConfigCandidates, { preferLegacy: !!migration.dataMigration });
  const layout = writeLayout(args.dataDir, programVersion);
  const result = {
    ok: true,
    schema: 'memory-suite.prepare-data.receipt.v1',
    programVersion,
    programDir: args.programDir,
    dataDir: args.dataDir,
    configPath: config.configPath,
    layoutPath: layout.layoutPath,
    freshDistribution: args.freshDistribution,
    legacyDataMigrated: !!migration.dataMigration,
    legacySourcePreserved: migration.dataMigration?.sourcePreserved === true,
    legacyLogsMigrated: !!migration.logMigration
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`[LIBRARIAN SYSTEM DATA PREPARE] ${String(error?.stack || error)}\n`);
    process.exitCode = error?.code === 'DATA_LAYOUT_NEWER_THAN_PROGRAM' ? 23 : 1;
  }
}

module.exports = {
  parseArgs,
  readProgramVersion,
  ensureLayout,
  preflightLayout,
  ensureConfig,
  migrateLegacyLayout,
  assertFreshDistributionTarget,
  hasMeaningfulData,
  copyTreeVerified,
  DATA_LAYOUT_VERSION,
  get PROGRAM_VERSION() { return readProgramVersion(); }
};
