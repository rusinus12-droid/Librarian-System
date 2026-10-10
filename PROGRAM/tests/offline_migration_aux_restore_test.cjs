'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createCurrentSchema } = require('../server/portable/logical_migration.cjs');
const { restoreBackupOffline } = require('../server/server.cjs');

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-offline-migration-aux-'));
const data = path.join(root, 'DATA');
const manual = path.join(data, 'backups', 'manual');
const id = 'migration-aux-fixture';
const backup = path.join(manual, id);
try {
  fs.mkdirSync(path.join(data, 'config'), { recursive: true });
  fs.mkdirSync(path.join(data, 'migrations'), { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(data, 'config', 'server-config.json'), JSON.stringify({
    schema: 'memory-suite.server-config.v1', host: '127.0.0.1', port: 48765,
    autoBackup: true, computeEnabled: true, computeWorkers: 1
  }, null, 2));
  const dbFile = path.join(backup, 'libra.sqlite');
  const db = new DatabaseSync(dbFile);
  try {
    createCurrentSchema(db, 'libra', '0.3.52');
    db.prepare('INSERT INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('plugin', 'fixture', JSON.stringify({ ok: true }), 0, 4,
        crypto.createHash('sha256').update(JSON.stringify({ ok: true })).digest('hex'), Date.now());
  } finally { db.close(); }
  const manifest = {
    schema: 'memory-suite.backup.v1', id, kind: 'manual', label: 'logical-migration',
    createdAt: new Date().toISOString(), createdAtMs: Date.now(), serverVersion: '0.3.52',
    protocol: { major: 1, minor: 9 }, databaseSchemaVersion: 1,
    stores: { libra: { file: 'libra.sqlite', sha256: sha(dbFile), bytes: fs.statSync(dbFile).size, records: 1, liveRecords: 1, tombstones: 0 } },
    migrationAux: {
      schema: 'librarian.migration-aux.v1', source: { serverVersion: '0.3.51' },
      serverConfig: { schema: 'memory-suite.server-config.portable.v1', autoBackup: false, computeEnabled: false, computeWorkers: 3 },
      migrationSchema: 'librarian.portable-migration.v1', importedArchiveSha256: 'a'.repeat(64), historyDir: 'migration-history'
    }
  };
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const result = restoreBackupOffline({ dataDir: data, backupDir: path.join(data, 'backups'), backupId: id, namespaces: ['libra'], reason: 'migration-test' });
  assert.equal(result.ok, true);
  const config = JSON.parse(fs.readFileSync(path.join(data, 'config', 'server-config.json'), 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 48765);
  assert.equal(config.autoBackup, false);
  assert.equal(config.computeEnabled, false);
  assert.equal(config.computeWorkers, 3);
  assert.equal(result.result.migration?.settingsApplied, true);
  process.stdout.write('offline_migration_aux_restore_test: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
