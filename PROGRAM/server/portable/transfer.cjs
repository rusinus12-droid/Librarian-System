'use strict';

const logical = require('./logical_migration.cjs');
const snapshot = require('./stream_archive.cjs');
const bundle=require('./backup_bundle_v2.cjs'),fs=require('node:fs'),path=require('node:path');

async function exportStart(params = {}) {
  const manifest=JSON.parse(fs.readFileSync(path.join(params.backupDir,'manifest.json'),'utf8'));
  if(manifest.schema===bundle.SCHEMA){bundle.validateBundle(manifest);if(params.mode!=='snapshot')throw Object.assign(Error('wm_logical_migration_unsupported_use_component_snapshot'),{statusCode:422});const result=await snapshot.exportArchive(params);return {...result,archiveKind:'component_bundle',coverage:manifest.coverage};} 
  return params.mode === 'snapshot'
    ? snapshot.exportArchive(params)
    : logical.exportLogicalMigration(params);
}

async function importAuto(params = {}) {
  const peek = await logical.peekArchiveManifest(params.archivePath);
  if (peek.manifest?.schema === logical.MIGRATION_SCHEMA) return logical.importLogicalMigration(params);
  if (peek.manifest?.schema === 'memory-suite.backup.v1') return snapshot.importArchive(params);
  if(peek.manifest?.schema===bundle.SCHEMA)return bundle.importBackupBundleStream(params);
  throw Object.assign(new Error(`portable_manifest_schema_unsupported:${peek.manifest?.schema || ''}`), { statusCode: 422 });
}

async function restorePreview(managerControl, body) {
  return managerControl.handle('restore-plan', body);
}

async function restoreExecute(managerControl, body) {
  return managerControl.handle('restore-execute', body);
}

module.exports = { exportStart, importAuto, restorePreview, restoreExecute };
