'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertNoAuthorityFilesystemEvidence, assertNoAuthorityDataRoot } = require('../authority/maintenance-admission.cjs');

function allowlistedConfig(value = {}) {
  const out = { schema: 'memory-suite.server-config.portable.v1' };
  if (typeof value.autoBackup === 'boolean') out.autoBackup = value.autoBackup;
  if (typeof value.computeEnabled === 'boolean') out.computeEnabled = value.computeEnabled;
  const workers = Number(value.computeWorkers);
  if (Number.isInteger(workers) && workers >= 0 && workers <= 64) out.computeWorkers = workers;
  return out;
}

function assertRuntimeInventory(root) {
  const runtime = path.join(root, 'runtime');
  if (!fs.existsSync(runtime)) return;
  const runtimeStat = fs.lstatSync(runtime);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) throw new Error('migration_runtime_entry_invalid:runtime');
  const allowedRuntime = new Set(['portable-transfers']);
  const unknownRuntime = fs.readdirSync(runtime).filter(name => !allowedRuntime.has(name));
  if (unknownRuntime.length) throw new Error(`migration_unknown_runtime_entries:${unknownRuntime.slice(0,8).join(',')}`);
  const transfers = path.join(runtime, 'portable-transfers');
  if (!fs.existsSync(transfers)) return;
  const transferStat = fs.lstatSync(transfers);
  if (!transferStat.isDirectory() || transferStat.isSymbolicLink()) throw new Error('migration_runtime_entry_invalid:portable-transfers');
  const pending = fs.readdirSync(transfers);
  if (pending.length) throw new Error(`migration_runtime_transfer_state_present:${pending.slice(0,8).join(',')}`);
}

// Filesystem classification only; staged stopped export must separately inspect
// every copied owner database before treating its logical data as qualified.
function assertPersistentDataFilesystemInventory(dataDir) {
  const root = path.resolve(String(dataDir || ''));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('migration_source_data_missing');
  assertNoAuthorityFilesystemEvidence(root);
  const allowedTop = new Set([
    'stores','backups','config','logs','migrations','runtime','data-layout.json','runtime-token.txt',
    '이_DATA_폴더를_통째로_백업하세요.txt'
  ]);
  const unknown = fs.readdirSync(root).filter(name => !allowedTop.has(name));
  // Unknown persistent files can carry user state. Never silently leave them
  // behind while calling the export "complete".
  if (unknown.length) throw new Error(`migration_unknown_data_entries:${unknown.slice(0,8).join(',')}`);
  // runtime/ is known ephemeral process state, but only the currently defined
  // empty portable-transfer workspace may be ignored during stopped export.
  assertRuntimeInventory(root);
  return { ok:true, root, unknown:[] };
}

function assertPersistentDataInventory(dataDir) {
  const result = assertPersistentDataFilesystemInventory(dataDir);
  assertNoAuthorityDataRoot(result.root);
  return result;
}
module.exports = { allowlistedConfig, assertPersistentDataInventory, assertPersistentDataFilesystemInventory };
