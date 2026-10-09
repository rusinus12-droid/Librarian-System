'use strict';

/*
 * Portable full-DATA backup archive bridge for Librarian System.
 *
 * The backup ENGINE (createBackup / restoreBackup in server.cjs) already owns
 * every safety property: the journal, epoch advancement, the pre-restore
 * preservation copy, whole-set rollback, and post-restore integrity. This
 * module adds only the FILE-FORMAT bridge around it:
 *
 *   exportBackupArchive  backup folder -> a single portable ZIP on disk
 *   importBackupArchive  a server-local ZIP -> a fresh backup folder that
 *                        listBackupsFromDisk() recognizes as a normal backupId
 *
 * It NEVER talks to the network and NEVER touches live namespace DBs. Restore
 * is performed by handing the imported backupId to the existing restoreBackup,
 * so this module cannot bypass any restore-time guard.
 *
 * Currently server-local: this module does not implement browser file transfer.
 * This is a product implementation limit, not proof that every RisuAI host
 * lacks an upload/download capability. A separate transport/UI is still needed.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const zipWriter = require('../../tools/zip_writer.cjs');

const BACKUP_MANIFEST_SCHEMA = 'memory-suite.backup.v1';
const BACKUP_NAMESPACES = new Set(['flashback', 'hayaku', 'libra', 'lia', 'retrace']);
// ZIP-entry path validation alone does not validate paths INSIDE manifest JSON.
// Validate every reference against this archive before allocating or extracting.
const validateArchiveReferences = (manifest, entries, rootName) => {
  const bad = reason => { throw Object.assign(new Error(`backup_archive_${reason}`), { statusCode: 422 }); };
  if (!manifest.stores || Array.isArray(manifest.stores) || typeof manifest.stores !== 'object'
      || !Object.keys(manifest.stores).length) bad('manifest_stores_missing');
  const members = new Set(entries.map(entry => entry.name));
  const used = new Set(['manifest.json']);
  const check = (meta, label) => {
    if (!meta || typeof meta !== 'object' || typeof meta.file !== 'string'
        || typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(meta.sha256)) bad(`reference_meta_invalid:${label}`);
    const file = meta.file;
    // Portable relative paths only. Reject Windows drives/ADS and backslashes
    // even when importing on Unix, so the result stays safe after OS migration.
    if (!file || file.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(file)
        || file.split('/').some(part => !part || part === '.' || part === '..')) bad(`reference_path_unsafe:${label}`);
    const key = file.normalize('NFC').toLowerCase();
    if (used.has(key)) bad(`reference_duplicate:${label}`);
    used.add(key);
    if (!members.has(`${rootName}/${file}`)) bad(`reference_not_in_archive:${label}`);
    if (meta.bytes != null && (!Number.isSafeInteger(meta.bytes) || meta.bytes < 0)) bad(`reference_bytes_invalid:${label}`);
  };
  for (const [namespace, meta] of Object.entries(manifest.stores)) {
    if (!BACKUP_NAMESPACES.has(namespace)) bad('namespace_not_allowed');
    check(meta, namespace);
  }
  if (manifest.scopeCatalog != null) check(manifest.scopeCatalog, 'scope_catalog');
};


const sha256File = filePath => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const safeFilePart = value => String(value || '')
  .replace(/[^A-Za-z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 120);

/**
 * Zip an existing backup folder into a single portable archive.
 *
 * @param {object} params
 * @param {string} params.backupDir      absolute path to the backup folder (…/backups/<kind>/<id>)
 * @param {string} params.archivePath    absolute destination .zip path
 * @param {string} [params.rootName]     folder name to nest entries under inside the ZIP (default: backup id)
 * @returns {{ok:true, archivePath:string, bytes:number, sha256:string, files:Array}}
 */
const exportBackupArchive = ({ backupDir, archivePath, rootName }) => {
  const source = path.resolve(String(backupDir || ''));
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw Object.assign(new Error('backup_archive_source_missing'), { statusCode: 404 });
  }
  const manifestPath = path.join(source, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw Object.assign(new Error('backup_archive_manifest_missing'), { statusCode: 422 });
  }
  const destination = path.resolve(String(archivePath || ''));
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const built = zipWriter.createZipFromDirectory(source, destination, {
    rootName: rootName ? safeFilePart(rootName) : path.basename(source)
  });
  // Prove the archive round-trips against the source before we report success.
  zipWriter.verifyZipAgainstDirectory(destination, source, {
    rootName: rootName ? safeFilePart(rootName) : path.basename(source)
  });
  return {
    ok: true,
    archivePath: destination,
    bytes: built.bytes,
    sha256: built.sha256,
    files: built.files
  };
};

/**
 * Expand a server-local backup ZIP into a fresh backup folder that the normal
 * backup listing recognizes, WITHOUT mutating any live DB. The returned
 * backupId can then be fed straight to the existing restoreBackup engine.
 *
 * The ZIP must contain exactly one backup: a single top-level folder holding a
 * memory-suite.backup.v1 manifest.json plus the store files it references.
 *
 * @param {object} params
 * @param {string} params.archivePath    absolute path to the source .zip (already on the host)
 * @param {string} params.backupRootManual  absolute path to backups/manual
 * @param {(id:string)=>boolean} [params.backupIdExists] collision probe against existing backups
 * @param {(dbPath:string)=>{ok:boolean,result?:string}} [params.verifyDatabase] optional sqlite integrity check
 * @returns {{ok:true, backupId:string, backupDir:string, manifest:object, verified:object}}
 */
const importBackupArchive = ({ archivePath, backupRootManual, backupIdExists, verifyDatabase }) => {
  const source = path.resolve(String(archivePath || ''));
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw Object.assign(new Error('backup_archive_file_missing'), { statusCode: 404 });
  }

  // 1) Read + structurally validate the archive (CRC, bounds, path traversal,
  //    duplicate/overlap defenses are all inside readZipEntries).
  const entries = zipWriter.readZipEntries(source);
  if (!entries.length) throw Object.assign(new Error('backup_archive_empty'), { statusCode: 422 });

  // 2) Determine the single top-level root folder and locate the manifest.
  const roots = new Set();
  for (const entry of entries) {
    const top = String(entry.name).split('/')[0];
    if (!top) throw Object.assign(new Error('backup_archive_entry_without_root'), { statusCode: 422 });
    roots.add(top);
  }
  if (roots.size !== 1) {
    throw Object.assign(new Error(`backup_archive_must_have_single_root:${roots.size}`), { statusCode: 422 });
  }
  const rootName = [...roots][0];
  const manifestEntryName = `${rootName}/manifest.json`;
  const manifestEntry = entries.find(entry => entry.name === manifestEntryName);
  if (!manifestEntry) throw Object.assign(new Error('backup_archive_manifest_missing'), { statusCode: 422 });

  // 3) Read the manifest payload from the archive to validate schema BEFORE writing anything.
  const manifest = readManifestFromEntry(manifestEntry);
  if (manifest?.schema !== BACKUP_MANIFEST_SCHEMA) {
    throw Object.assign(new Error(`backup_archive_manifest_schema_mismatch:${manifest?.schema || ''}`), { statusCode: 422 });
  }
  if (!manifest.stores || typeof manifest.stores !== 'object') {
    throw Object.assign(new Error('backup_archive_manifest_stores_missing'), { statusCode: 422 });
  }

  validateArchiveReferences(manifest, entries, rootName);

  // 4) Allocate a fresh, collision-free backup id (never reuse the archived id,
  //    which could clash with an existing local backup).
  const createdAtMs = Date.now();
  const stamp = new Date(createdAtMs).toISOString().replace(/[:.]/g, '-');
  const importedLabel = safeFilePart(manifest.label ? `imported-${manifest.label}` : 'imported');
  let backupId = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${stamp}_${crypto.randomBytes(4).toString('hex')}_${importedLabel}`.replace(/_+$/, '');
    if (typeof backupIdExists !== 'function' || !backupIdExists(candidate)) { backupId = candidate; break; }
  }
  if (!backupId) throw Object.assign(new Error('backup_archive_id_allocation_failed'), { statusCode: 500 });

  const destDir = path.join(path.resolve(String(backupRootManual || '')), backupId);
  if (fs.existsSync(destDir)) throw Object.assign(new Error('backup_archive_target_exists'), { statusCode: 409 });

  // 5) Extract into a temp dir first, then atomically rename into place. If any
  //    validation fails, the temp dir is removed and no listing is polluted.
  const tempDir = `${destDir}.import-temp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    extractEntries(source, entries, rootName, tempDir);

    // 6) Rewrite the manifest id to match the freshly-allocated folder id, so
    //    listBackupsFromDisk (which keys on the folder) and the manifest agree.
    const extractedManifestPath = path.join(tempDir, 'manifest.json');
    const persistedManifest = JSON.parse(fs.readFileSync(extractedManifestPath, 'utf8'));
    persistedManifest.id = backupId;
    persistedManifest.kind = 'manual';
    persistedManifest.importedAt = new Date(createdAtMs).toISOString();
    persistedManifest.importedFromId = String(manifest.id || '');
    fs.writeFileSync(extractedManifestPath, `${JSON.stringify(persistedManifest, null, 2)}\n`);

    // 7) Verify every referenced store: presence, sha256 against the manifest,
    //    and (optionally) sqlite integrity — BEFORE the backup becomes visible.
    const verified = {};
    for (const [namespace, storeMeta] of Object.entries(manifest.stores)) {
      if (!storeMeta?.file || !storeMeta?.sha256) {
        throw Object.assign(new Error(`backup_archive_store_meta_invalid:${namespace}`), { statusCode: 422 });
      }
      const storePath = path.join(tempDir, storeMeta.file);
      if (!fs.existsSync(storePath)) {
        throw Object.assign(new Error(`backup_archive_store_file_missing:${namespace}`), { statusCode: 422 });
      }
      const digest = sha256File(storePath);
      if (digest !== storeMeta.sha256) {
        throw Object.assign(new Error(`backup_archive_store_digest_mismatch:${namespace}`), { statusCode: 422 });
      }
      let integrity = { ok: true, result: 'skipped' };
      if (typeof verifyDatabase === 'function') {
        integrity = verifyDatabase(storePath);
        if (!integrity.ok) {
          throw Object.assign(new Error(`backup_archive_store_integrity_failed:${namespace}:${integrity.result}`), { statusCode: 422 });
        }
      }
      verified[namespace] = { sha256: digest, integrity: integrity.result };
    }

    // 8) Optional scope catalog: presence + digest if the manifest declares one.
    if (persistedManifest.scopeCatalog?.file) {
      const scopePath = path.join(tempDir, persistedManifest.scopeCatalog.file);
      if (!fs.existsSync(scopePath)) {
        throw Object.assign(new Error('backup_archive_scope_catalog_missing'), { statusCode: 422 });
      }
      if (persistedManifest.scopeCatalog.sha256 && sha256File(scopePath) !== persistedManifest.scopeCatalog.sha256) {
        throw Object.assign(new Error('backup_archive_scope_catalog_digest_mismatch'), { statusCode: 422 });
      }
    }

    fs.renameSync(tempDir, destDir);
    return { ok: true, backupId, backupDir: destDir, manifest: persistedManifest, verified };
  } catch (error) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
};

function readManifestFromEntry(entry) {
  // readZipEntries always returns the inflated bytes for each entry, so the
  // manifest can be schema-validated in memory before anything is written.
  if (Buffer.isBuffer(entry.bytes)) {
    try { return JSON.parse(entry.bytes.toString('utf8')); } catch (_) { return null; }
  }
  return null;
}

function extractEntries(archivePath, entries, rootName, destDir) {
  // Every entry carries its verified inflated bytes (CRC + size already checked
  // inside readZipEntries), so extraction is a guarded write per entry.
  const rootPrefix = `${rootName}/`;
  for (const entry of entries) {
    if (entry.name === rootPrefix) continue;
    if (!entry.name.startsWith(rootPrefix)) {
      throw Object.assign(new Error(`backup_archive_entry_outside_root:${entry.name}`), { statusCode: 422 });
    }
    const relative = entry.name.slice(rootPrefix.length);
    if (!relative) continue;
    if (!Buffer.isBuffer(entry.bytes)) {
      throw Object.assign(new Error(`backup_archive_entry_unreadable:${entry.name}`), { statusCode: 422 });
    }
    const resolved = path.resolve(path.join(destDir, relative));
    if (resolved !== destDir && !resolved.startsWith(destDir + path.sep)) {
      throw Object.assign(new Error(`backup_archive_path_escape:${entry.name}`), { statusCode: 422 });
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, entry.bytes);
  }
}

module.exports = { exportBackupArchive, importBackupArchive, validateArchiveReferences };
