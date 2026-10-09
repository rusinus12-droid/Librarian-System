'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const setRecord = (repository, namespace, value, operationId, expectedRevision) => repository.mutate({
  kind: 'set', space: 'plugin', key: `${namespace}:restore:safety`, value, operationId, expectedRevision
});

const catalog = (flashbackScope, hayakuScope) => ({
  schema: 'memory-suite.scope-catalog.v1', updatedAt: Date.now(), namespaces: {
    flashback: [{ namespace: 'flashback', scopeId: flashbackScope }],
    hayaku: [{ namespace: 'hayaku', scopeId: hayakuScope }]
  }
});

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-restore-safety-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const catalogPath = path.join(dataDir, 'config', 'scope-catalog.json');
  const originalRename = fs.renameSync;
  try {
    await app.listen();
    setRecord(app.repositories.flashback, 'flashback', { state: 'backup' }, 'restore_backup_flashback_1', 0);
    setRecord(app.repositories.hayaku, 'hayaku', { state: 'backup' }, 'restore_backup_hayaku_1', 0);
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog('backup-flashback', 'backup-hayaku'), null, 2)}\n`, 'utf8');
    const backup = await app.createBackup('manual', 'restore-safety-source');

    setRecord(app.repositories.flashback, 'flashback', { state: 'current' }, 'restore_current_flashback_2', 1);
    setRecord(app.repositories.hayaku, 'hayaku', { state: 'current' }, 'restore_current_hayaku_2', 1);
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog('current-flashback', 'current-hayaku'), null, 2)}\n`, 'utf8');

    let injected = false;
    fs.renameSync = (from, to) => {
      if (!injected && String(from).endsWith('flashback.sqlite') && String(to).includes('.restore-rollback-')) {
        injected = true;
        throw new Error('AUDIT_INJECTED_RENAME_FAILURE');
      }
      return originalRename(from, to);
    };
    await assert.rejects(() => app.restoreBackup(backup.result.id), /AUDIT_INJECTED_RENAME_FAILURE/);
    fs.renameSync = originalRename;

    assert.deepEqual(app.repositories.flashback.get('plugin', 'flashback:restore:safety').value, { state: 'current' });
    assert.deepEqual(app.repositories.hayaku.get('plugin', 'hayaku:restore:safety').value, { state: 'current' });
    assert.equal(JSON.parse(fs.readFileSync(catalogPath, 'utf8')).namespaces.flashback[0].scopeId, 'current-flashback');

    const restored = await app.restoreBackup(backup.result.id, ['flashback']);
    assert.equal(restored.result.scopeCatalogRestored, true);
    assert.deepEqual(app.repositories.flashback.get('plugin', 'flashback:restore:safety').value, { state: 'backup' });
    assert.deepEqual(app.repositories.hayaku.get('plugin', 'hayaku:restore:safety').value, { state: 'current' });
    const partialCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    assert.equal(partialCatalog.namespaces.flashback[0].scopeId, 'backup-flashback');
    assert.equal(partialCatalog.namespaces.hayaku[0].scopeId, 'current-hayaku');

    process.stdout.write('server_restore_safety_test: PASS\n');
  } finally {
    fs.renameSync = originalRename;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`server_restore_safety_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
