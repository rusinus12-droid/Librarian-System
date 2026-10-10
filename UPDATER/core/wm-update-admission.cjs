'use strict';
const fs = require('node:fs'), path = require('node:path');
// Program-only success retains DATA, but its copied-checkpoint rollback does not.
// Both update policies refuse retained WM until physical-identity continuation is qualified.
// Five-owner logical migration cannot relocate WM's physical identity, selected
// import paths or active manual/paged state. Preserve the original pair rather
// than report success after silently omitting that separate owner's inventory.
// This is an observed-input refusal, not a writer fence or WM activation path.
function assertWmUpdateAdmission(dataDir, policy = 'migration_required') {
  if (!['migration_required', 'program_only'].includes(policy)) throw new Error('wm_update_policy_invalid');
  const root = path.resolve(dataDir);
  const refuse = reason => { throw Object.assign(new Error(`${policy === 'program_only' ? 'program_only_wm_state_requires_identity_safe_rollback' : 'migration_wm_state_requires_explicit_handoff'}:${reason}`), { code: 'MIGRATION_WM_HANDOFF_REQUIRED' }); };
  const stat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; refuse('inventory_unreadable'); } };
  const directory = file => { const s = stat(file); if (s && (!s.isDirectory() || s.isSymbolicLink())) refuse('inventory_directory_invalid'); return s; };
  if (!directory(root)) refuse('data_missing');
  for (const name of ['stores', 'config', 'migrations']) directory(path.join(root, name));
  for (const rel of ['stores/wm', 'migrations/wm-imports', 'migrations/component-restore-plans', 'migrations/component-restore-receipts']) {
    if (stat(path.join(root, ...rel.split('/')))) refuse(rel);
  }
  const config = path.join(root, 'config');
  if (stat(config) && fs.readdirSync(config).some(name => name === 'wm-import-selection.json' || name.startsWith('wm-import-selection.json.'))) refuse('import_selection');
  const backups = path.join(root, 'backups');
  if (!directory(backups)) return { wm: 'absent', historicalBackupFiles: 0 };
  let entries = 0, metadataBytes = 0;
  const payloadFiles = [], classifiedFiles = new Set();
  const templateMarker = Buffer.from('This directory is intentionally empty in a clean Librarian System distribution.\n', 'utf8');
  const templatePaths = new Set(['auto', 'manual', 'pre-migration', 'deleted-scopes', 'recovery-quarantine'].map(dir => dir + '/.keep.txt'));

  function walk(dir, depth) {
    if (depth > 32) refuse('backup_inventory_limit');
    for (const name of fs.readdirSync(dir)) {
      if (++entries > 20000) refuse('backup_inventory_limit');
      const file = path.join(dir, name), s = stat(file);
      if (!s || s.isSymbolicLink()) refuse('backup_inventory_unverified');
      if (/^wm(?:-|\.)/i.test(name)) refuse('historical_wm_component');
      if (s.isDirectory()) { walk(file, depth + 1); continue; }
      if (!s.isFile()) refuse('backup_inventory_unverified');
      payloadFiles.push(file);
      // Admit only the builder's five exact inert markers, never arbitrary hidden payloads.
      if (templatePaths.has(path.relative(backups, file).split(path.sep).join('/'))) {
        if (s.size !== templateMarker.length) refuse('backup_template_marker_unverified');
        let fd;
        try {
          fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.dev !== s.dev || opened.ino !== s.ino || opened.size !== s.size) refuse('backup_template_marker_changed');
          const bytes = Buffer.alloc(templateMarker.length); let offset = 0;
          while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) refuse('backup_template_marker_changed'); offset += n; }
          const after = fs.fstatSync(fd);
          if (after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs || !bytes.equals(templateMarker)) refuse('backup_template_marker_unverified');
        } catch (error) { if (error.code === 'MIGRATION_WM_HANDOFF_REQUIRED') throw error; refuse('backup_template_marker_unverified'); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
        classifiedFiles.add(file);
        continue;
      }

      if (/\.(?:zip|tar|tgz|gz|7z|rar)$/i.test(name)) refuse('opaque_backup_inventory');
      if (!/^manifest\.json(?:\.|$)/i.test(name)) continue;
      if (s.size > 1024 * 1024 || (metadataBytes += s.size) > 16 * 1024 * 1024) refuse('backup_metadata_limit');
      let fd, manifest;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== s.dev || opened.ino !== s.ino || opened.size !== s.size) refuse('backup_metadata_changed');
        const bytes = Buffer.alloc(s.size); let offset = 0;
        while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) refuse('backup_metadata_changed'); offset += n; }
        const after = fs.fstatSync(fd);
        if (after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) refuse('backup_metadata_changed');
        manifest = JSON.parse(bytes.toString('utf8'));
      } catch (error) { if (error.code === 'MIGRATION_WM_HANDOFF_REQUIRED') throw error; refuse('backup_metadata_unverified'); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
      if (!manifest || !['memory-suite.backup.v1', 'memory-suite.backup-bundle.v2'].includes(manifest.schema)) refuse('backup_metadata_unverified');
      for (const field of ['stores', 'components', 'coverage']) if (Object.hasOwn(manifest, field) &&
          (!manifest[field] || typeof manifest[field] !== 'object' || Array.isArray(manifest[field]))) refuse('backup_metadata_unverified');
      if (manifest.schema === 'memory-suite.backup-bundle.v2') {
        const legacy = manifest.components?.legacy, coverage = manifest.coverage;
        if (manifest.components?.wm !== null || coverage?.wm !== 'absent') refuse('historical_wm_coverage');
        if (Object.keys(manifest.components).sort().join(',') !== 'legacy,wm' || legacy?.schema !== 'memory-suite.backup.v1' ||
            legacy.manifest?.schema !== 'memory-suite.backup.v1' || !legacy.manifest.stores || typeof legacy.manifest.stores !== 'object' ||
            Array.isArray(legacy.manifest.stores) || !Array.isArray(coverage.legacyOwners) ||
            JSON.stringify([...coverage.legacyOwners].sort()) !== JSON.stringify(Object.keys(legacy.manifest.stores).sort())) refuse('backup_metadata_unverified');
        manifest = legacy.manifest;
      }
      if (Object.hasOwn(manifest.components || {}, 'wm') || Object.hasOwn(manifest.stores || {}, 'wm') ||
          (Object.hasOwn(manifest.coverage || {}, 'wm') && manifest.coverage.wm !== 'absent')) refuse('historical_wm_coverage');
      if (!manifest.stores || typeof manifest.stores !== 'object' || Array.isArray(manifest.stores)) refuse('backup_metadata_unverified');
      classifiedFiles.add(file);
      for (const [owner, store] of Object.entries(manifest.stores)) {
        if (!['flashback', 'hayaku', 'libra', 'lia', 'retrace'].includes(owner) || store?.file !== owner + '.sqlite') refuse('backup_metadata_unverified');
        classifiedFiles.add(path.join(dir, store.file));
      }
      if (manifest.scopeCatalog) {
        if (manifest.scopeCatalog.file !== 'scope-catalog.json') refuse('backup_metadata_unverified');
        classifiedFiles.add(path.join(dir, manifest.scopeCatalog.file));
      }
    }
  }
  try { walk(backups, 0); } catch (error) { if (error.code === 'MIGRATION_WM_HANDOFF_REQUIRED') throw error; refuse('backup_inventory_unreadable'); }
  if (payloadFiles.some(file => !classifiedFiles.has(file))) refuse('backup_payload_unclassified');
  return { wm: 'absent', historicalBackupFiles: entries };
}

module.exports = { assertWmUpdateAdmission };
