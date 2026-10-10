'use strict';
// Portable backup archive round-trip contract:
//   backup folder -> exportBackupArchive -> ZIP -> importBackupArchive -> fresh
//   backup folder that round-trips byte-for-byte, with a fresh collision-free id
//   and a manifest whose store digests all verify. Tamper cases must be rejected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { exportBackupArchive, importBackupArchive } = require('../server/portable/backup_archive.cjs');

const sha256File = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const scratch = process.env.KIROCREW_SCRATCH || os.tmpdir();
const work = fs.mkdtempSync(path.join(scratch, 'backup-archive-test-'));

const NAMESPACES = ['flashback', 'hayaku', 'libra', 'lia', 'retrace'];

const makeBackupFolder = () => {
  const id = '2026-09-14T00-00-00-000Z_deadbeef';
  const dir = path.join(work, 'backups', 'manual', id);
  fs.mkdirSync(dir, { recursive: true });
  const stores = {};
  for (const ns of NAMESPACES) {
    const file = `${ns}.sqlite`;
    const body = Buffer.from(`SQLite format 3\u0000 fake ${ns} ${crypto.randomBytes(64).toString('hex')}`);
    fs.writeFileSync(path.join(dir, file), body);
    stores[ns] = { file, sha256: sha256File(path.join(dir, file)), bytes: body.length, records: 1 };
  }
  const manifest = { schema: 'memory-suite.backup.v1', id, kind: 'manual', label: 'unit', createdAt: new Date(0).toISOString(), createdAtMs: 0, stores };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { id, dir, manifest };
};

(() => {
  const { id, dir, manifest } = makeBackupFolder();

  // export
  const archivePath = path.join(work, 'export.zip');
  const exported = exportBackupArchive({ backupDir: dir, archivePath });
  assert.equal(exported.ok, true);
  assert.ok(fs.existsSync(archivePath), 'archive written');
  assert.ok(exported.sha256 && exported.sha256.length === 64, 'archive sha256 reported');
  assert.ok(Array.isArray(exported.files) && exported.files.length >= NAMESPACES.length + 1, 'archive contains stores + manifest');

  // import into a fresh manual root
  const importRoot = path.join(work, 'backups', 'manual');
  const existing = new Set(fs.existsSync(importRoot) ? fs.readdirSync(importRoot) : []);
  const imported = importBackupArchive({
    archivePath,
    backupRootManual: importRoot,
    backupIdExists: candidate => existing.has(candidate),
    verifyDatabase: p => ({ ok: fs.readFileSync(p).slice(0, 15).toString() === 'SQLite format 3', result: 'ok' })
  });
  assert.equal(imported.ok, true);
  assert.notEqual(imported.backupId, id, 'imported backup gets a FRESH id, never the archived one');
  assert.equal(imported.manifest.id, imported.backupId, 'manifest id rewritten to match the folder');
  assert.equal(imported.manifest.importedFromId, id, 'original id preserved for provenance');

  // byte-for-byte store equality
  for (const ns of NAMESPACES) {
    const original = path.join(dir, manifest.stores[ns].file);
    const restored = path.join(imported.backupDir, manifest.stores[ns].file);
    assert.ok(fs.existsSync(restored), `imported store present: ${ns}`);
    assert.equal(sha256File(restored), sha256File(original), `store round-trips byte-for-byte: ${ns}`);
    assert.equal(imported.verified[ns].sha256, manifest.stores[ns].sha256, `verified digest matches manifest: ${ns}`);
  }

  // tamper: a corrupted store digest must be rejected and leave no visible backup
  const before = fs.readdirSync(importRoot).length;
  const tamperedRoot = path.join(work, 'backups', 'tampered');
  fs.mkdirSync(tamperedRoot, { recursive: true });
  // build a bad archive by editing the source then zipping with a stale manifest digest
  const badDir = path.join(work, 'bad-src');
  fs.cpSync(dir, badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'flashback.sqlite'), Buffer.from('SQLite format 3\u0000 CORRUPTED different length'));
  const badZip = path.join(work, 'bad.zip');
  exportBackupArchive({ backupDir: badDir, archivePath: badZip }); // zips whatever is there
  let rejected = false;
  try {
    importBackupArchive({ archivePath: badZip, backupRootManual: tamperedRoot, backupIdExists: () => false });
  } catch (e) {
    rejected = /digest_mismatch/.test(String(e.message));
  }
  assert.equal(rejected, true, 'tampered store digest must be rejected');
  assert.equal(fs.readdirSync(tamperedRoot).length, 0, 'a rejected import leaves NO visible backup folder');
  assert.equal(fs.readdirSync(importRoot).length, before, 'good import root untouched by the rejected import');

  console.log(JSON.stringify({ test: 'portable_backup_archive_roundtrip', result: 'pass', importedId: imported.backupId, stores: NAMESPACES.length }));
  fs.rmSync(work, { recursive: true, force: true });
})();
