'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { allowlistedConfig } = require('../portable/migration_data_policy.cjs');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temp = `${file}.migration-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding:'utf8', flag:'wx', mode:0o600 });
  // Windows FlushFileBuffers requires a handle opened with write access; a
  // read-only handle raises EPERM. r+ preserves the bytes and provides the
  // access needed for a real durability barrier (same rule as server.cjs).
  const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function collectPersistentMetadata(dataDir) {
  const file = path.join(dataDir, 'config', 'server-config.json');
  const raw = readJson(file, {});
  return {
    schema: 'librarian.migration-metadata.v1',
    serverConfig: allowlistedConfig(raw),
    sourceConfigPresent: !!raw && Object.keys(raw).length > 0
  };
}
function planMigrationMetadataInstall(dataDir, aux) {
  const file = path.join(dataDir, 'config', 'server-config.json');
  const beforeBytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const before = readJson(file, { schema:'memory-suite.server-config.v1', host:'127.0.0.1', port:47630, autoBackup:true, computeEnabled:true, computeWorkers:0 });
  const portable = aux?.serverConfig && typeof aux.serverConfig === 'object' ? aux.serverConfig : {};
  const next = { ...before, schema:'memory-suite.server-config.v1' };
  for (const key of ['autoBackup','computeEnabled','computeWorkers']) if (Object.prototype.hasOwnProperty.call(portable,key)) next[key] = portable[key];
  return {
    schema:'librarian.migration-metadata-install.v1',
    file,
    beforeBytes: beforeBytes ? beforeBytes.toString('base64') : '',
    hadBefore: !!beforeBytes,
    next
  };
}
function applyMigrationMetadataPlan(dataDir, receipt) {
  if (!receipt || receipt.schema !== 'librarian.migration-metadata-install.v1') throw new Error('migration_metadata_plan_invalid');
  const expected = path.resolve(dataDir, 'config', 'server-config.json');
  if (path.resolve(receipt.file) !== expected) throw new Error('migration_metadata_plan_path_invalid');
  atomicWriteJson(expected, receipt.next);
  return receipt;
}
function installMigrationMetadata(dataDir, aux) {
  return applyMigrationMetadataPlan(dataDir, planMigrationMetadataInstall(dataDir, aux));
}
function verifyAuxiliary(dataDir, aux) {
  const current = readJson(path.join(dataDir,'config','server-config.json'), null);
  if (!current) throw new Error('migration_metadata_readback_missing');
  const portable = aux?.serverConfig && typeof aux.serverConfig === 'object' ? aux.serverConfig : {};
  for (const key of ['autoBackup','computeEnabled','computeWorkers']) {
    if (Object.prototype.hasOwnProperty.call(portable,key) && current[key] !== portable[key]) throw new Error(`migration_metadata_readback_mismatch:${key}`);
  }
  return true;
}
function rollbackMigrationMetadata(dataDir, receipt) {
  const file = path.join(dataDir,'config','server-config.json');
  if (!receipt) return;
  if (receipt.hadBefore) {
    const bytes = Buffer.from(String(receipt.beforeBytes || ''), 'base64');
    fs.writeFileSync(file, bytes);
  } else {
    fs.rmSync(file, { force:true });
  }
}
module.exports = {
  collectPersistentMetadata,
  planMigrationMetadataInstall,
  applyMigrationMetadataPlan,
  installMigrationMetadata,
  verifyAuxiliary,
  rollbackMigrationMetadata
};
