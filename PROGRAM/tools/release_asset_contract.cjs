'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readReleaseMetadata } = require('./release_metadata.cjs');

const OFFICIAL_REPOSITORY = 'rusinus12-droid/Librarian-System';
const MANIFEST_SCHEMA = 'librarian.update-manifest.v1';
const POLICY_SCHEMA = 'librarian.release-policy.v1';
const UPDATE_POLICIES = new Set(['program_only', 'migration_required', 'manual_required']);
const UPDATE_CHANNELS = new Set(['stable']);
const UPDATER_CONTRACT = 1;

function normalizeVersion(value, label = 'version') {
  const version = String(value || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`release_asset_${label}_invalid:${value}`);
  return version;
}

function expectedTag(version) {
  return `v${normalizeVersion(version)}`;
}

function expectedAssetName(version) {
  return `Librarian-System-${normalizeVersion(version)}.zip`;
}
function expectedSourceAssetName(version) {
  return `Librarian-System-${normalizeVersion(version)}-Source.zip`;
}

function parseAssetVersion(fileName) {
  const match = String(fileName || '').match(/^Librarian-System-(\d+\.\d+\.\d+)\.zip$/);
  return match ? match[1] : null;
}
function parseSourceAssetVersion(fileName) {
  const match = String(fileName || '').match(/^Librarian-System-(\d+\.\d+\.\d+)-Source\.zip$/);
  return match ? match[1] : null;
}

function readJson(filePath, label) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { throw new Error(`release_asset_${label}_json_invalid:${error?.message || error}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`release_asset_${label}_object_required`);
  return parsed;
}

function readReleasePolicy(programDir) {
  const root = path.resolve(programDir);
  const currentVersion = normalizeVersion(fs.readFileSync(path.join(root, 'VERSION.txt'), 'utf8'), 'program_version');
  const policy = readJson(path.join(root, 'release-policy.json'), 'policy');
  if (policy.schema !== POLICY_SCHEMA) throw new Error(`release_asset_policy_schema_invalid:${policy.schema || ''}`);
  if (normalizeVersion(policy.version, 'policy_version') !== currentVersion) throw new Error('release_asset_policy_version_mismatch');
  if (!UPDATE_CHANNELS.has(policy.channel)) throw new Error(`release_asset_policy_channel_invalid:${policy.channel || ''}`);
  if (!UPDATE_POLICIES.has(policy.updatePolicy)) throw new Error(`release_asset_policy_mode_invalid:${policy.updatePolicy || ''}`);
  const minimumSourceVersion = normalizeVersion(policy.minimumSourceVersion, 'minimum_source_version');
  if (!Number.isSafeInteger(policy.logicalMigrationFormat) || policy.logicalMigrationFormat < 1) throw new Error('release_asset_logical_migration_format_invalid');
  if (policy.updaterContract !== UPDATER_CONTRACT) throw new Error(`release_asset_updater_contract_invalid:${policy.updaterContract}`);
  return {
    schema: POLICY_SCHEMA,
    version: currentVersion,
    channel: policy.channel,
    updatePolicy: policy.updatePolicy,
    minimumSourceVersion,
    logicalMigrationFormat: policy.logicalMigrationFormat,
    updaterContract: policy.updaterContract
  };
}

function compatibilityFromProgramManifest(programDir, logicalMigrationFormat) {
  const manifest = readJson(path.join(programDir, 'program-manifest.json'), 'program_manifest');
  const storageProtocol = String(manifest?.dataContract?.storageReadPerformance?.protocol || '').trim();
  const computeMajor = Number(manifest?.computeProtocol?.major);
  const computeMinor = Number(manifest?.computeProtocol?.minor);
  const dataLayout = Number(manifest?.server?.dataLayoutSchemaVersion);
  if (!/^\d+\.\d+$/.test(storageProtocol)) throw new Error('release_asset_storage_protocol_invalid');
  if (!Number.isSafeInteger(computeMajor) || computeMajor < 0 || !Number.isSafeInteger(computeMinor) || computeMinor < 0) {
    throw new Error('release_asset_compute_protocol_invalid');
  }
  if (!Number.isSafeInteger(dataLayout) || dataLayout < 1) throw new Error('release_asset_data_layout_invalid');
  return {
    storageProtocol,
    computeProtocol: `${computeMajor}.${computeMinor}`,
    dataLayout,
    logicalMigrationFormat,
    updaterContract: UPDATER_CONTRACT,
    releaseArchiveContract: 1
  };
}

function buildUpdateManifest(programDir) {
  const programRoot = path.resolve(programDir);
  const policy = readReleasePolicy(programRoot);
  const metadata = readReleaseMetadata(programRoot);
  if (metadata.packageVersion !== policy.version) throw new Error('release_asset_metadata_version_mismatch');
  const compatibility = compatibilityFromProgramManifest(programRoot, policy.logicalMigrationFormat);
  return {
    schema: MANIFEST_SCHEMA,
    repository: OFFICIAL_REPOSITORY,
    version: policy.version,
    tag: expectedTag(policy.version),
    channel: policy.channel,
    assetName: expectedAssetName(policy.version),
    updatePolicy: policy.updatePolicy,
    minimumSourceVersion: policy.minimumSourceVersion,
    compatibility,
    components: {
      backend: metadata.packageVersion,
      libra: metadata.plugins.libra.version,
      hayaku: metadata.plugins.hayaku.version,
      flashback: metadata.plugins.flashback.version,
      lia: metadata.plugins.lia.version,
      retrace: metadata.plugins.retrace.version,
      gradia: metadata.plugins.gradia.version,
      storageSdk: metadata.storageSdkVersion,
      computeSdk: metadata.computeSdkVersion
    },
    layout: {
      program: 'PROGRAM',
      dataTemplate: 'DATA',
      updater: 'UPDATER',
      checksumFile: 'SHA256SUMS.txt'
    }
  };
}

function validateUpdateManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('release_asset_manifest_object_required');
  if(manifest.qualification==='offline_candidate'||manifest.updaterEligible===false)throw Error('release_asset_manifest_unqualified_candidate');
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`release_asset_manifest_schema_invalid:${manifest.schema || ''}`);
  if (manifest.repository !== OFFICIAL_REPOSITORY) throw new Error(`release_asset_manifest_repository_invalid:${manifest.repository || ''}`);
  const version = normalizeVersion(manifest.version, 'manifest_version');
  if (manifest.tag !== expectedTag(version)) throw new Error('release_asset_manifest_tag_mismatch');
  if (!UPDATE_CHANNELS.has(manifest.channel)) throw new Error(`release_asset_manifest_channel_invalid:${manifest.channel || ''}`);
  if (manifest.assetName !== expectedAssetName(version)) throw new Error('release_asset_manifest_asset_name_mismatch');
  if (!UPDATE_POLICIES.has(manifest.updatePolicy)) throw new Error(`release_asset_manifest_policy_invalid:${manifest.updatePolicy || ''}`);
  const minimumSourceVersion = normalizeVersion(manifest.minimumSourceVersion, 'manifest_minimum_source_version');
  const compatibility = manifest.compatibility;
  if (!compatibility || typeof compatibility !== 'object' || compatibility.updaterContract !== UPDATER_CONTRACT || compatibility.releaseArchiveContract !== 1) {
    throw new Error('release_asset_manifest_compatibility_invalid');
  }
  if (!/^\d+\.\d+$/.test(String(compatibility.storageProtocol || ''))) throw new Error('release_asset_manifest_storage_protocol_invalid');
  if (!/^\d+\.\d+$/.test(String(compatibility.computeProtocol || ''))) throw new Error('release_asset_manifest_compute_protocol_invalid');
  if (!Number.isSafeInteger(compatibility.dataLayout) || compatibility.dataLayout < 1) throw new Error('release_asset_manifest_data_layout_invalid');
  if (!Number.isSafeInteger(compatibility.logicalMigrationFormat) || compatibility.logicalMigrationFormat < 1) throw new Error('release_asset_manifest_migration_format_invalid');
  if (options.expectedVersion && version !== normalizeVersion(options.expectedVersion, 'expected_version')) throw new Error('release_asset_manifest_version_mismatch');
  if (options.expectedAssetName && manifest.assetName !== options.expectedAssetName) throw new Error('release_asset_manifest_expected_asset_mismatch');
  if (options.expectedChannel && manifest.channel !== options.expectedChannel) throw new Error('release_asset_manifest_expected_channel_mismatch');
  return { version, minimumSourceVersion, updatePolicy: manifest.updatePolicy, compatibility };
}

function writeUpdateManifest(packageRoot, options={}) {
  const root = path.resolve(packageRoot);
  const manifest = buildUpdateManifest(path.join(root, 'PROGRAM'));
  if(options.qualification==='offline_candidate')Object.assign(manifest,{qualification:'offline_candidate',status:'offline_candidate',updaterEligible:false,publicationReady:false});
  const output = path.join(root, 'update-manifest.json');
  const flag = options.flag || (options.overwrite ? 'w' : 'wx');
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag });
  return manifest;
}

module.exports = {
  OFFICIAL_REPOSITORY,
  MANIFEST_SCHEMA,
  POLICY_SCHEMA,
  UPDATE_POLICIES,
  UPDATE_CHANNELS,
  UPDATER_CONTRACT,
  normalizeVersion,
  expectedTag,
  expectedAssetName,
  expectedSourceAssetName,
  parseAssetVersion,
  parseSourceAssetVersion,
  readReleasePolicy,
  compatibilityFromProgramManifest,
  buildUpdateManifest,
  validateUpdateManifest,
  writeUpdateManifest
};
