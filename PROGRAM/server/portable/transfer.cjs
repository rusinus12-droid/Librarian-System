'use strict';

const logical = require('./logical_migration.cjs');
const snapshot = require('./stream_archive.cjs');

async function exportStart(params = {}) {
  return params.mode === 'snapshot'
    ? snapshot.exportArchive(params)
    : logical.exportLogicalMigration(params);
}

async function importAuto(params = {}) {
  const peek = await logical.peekArchiveManifest(params.archivePath);
  if (peek.manifest?.schema === logical.MIGRATION_SCHEMA) return logical.importLogicalMigration(params);
  if (peek.manifest?.schema === 'memory-suite.backup.v1') return snapshot.importArchive(params);
  throw Object.assign(new Error(`portable_manifest_schema_unsupported:${peek.manifest?.schema || ''}`), { statusCode: 422 });
}

async function restorePreview(managerControl, body) {
  return managerControl.handle('restore-plan', body);
}

async function restoreExecute(managerControl, body) {
  return managerControl.handle('restore-execute', body);
}

module.exports = { exportStart, importAuto, restorePreview, restoreExecute };
