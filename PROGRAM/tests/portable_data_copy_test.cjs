'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {seedHistoricalInventory,assertRetiredReadOnly}=require('./fixtures/portable_historical_inventory_fixture.cjs');
const {
  createMemorySuiteServer,
  DATABASE_SCHEMA_VERSION,
  inspectDatabaseFile,
  preflightDataCompatibility
} = require('../server/server.cjs');

const sha256 = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-portable-copy-'));
  const firstProgram = path.join(tempRoot, 'PROGRAM_OLD');
  const firstData = path.join(tempRoot, 'DATA');
  const copiedRoot = path.join(tempRoot, 'RESTORED');
  const copiedData = path.join(copiedRoot, 'DATA');
  fs.mkdirSync(firstProgram, { recursive: true });

  const historical=await seedHistoricalInventory(firstData,{
    lia:[{space:'plugin',key:'lia:test:portable-copy',value:{persona:'portable-lia'}}],
    retrace:[{space:'plugin',key:'retrace:test:portable-copy',value:{handoff:'portable-retrace'}}]
  });
  let first = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: firstData, autoBackup: false });
  try {
    await first.listen();
    first.repositories.libra.mutate({
      kind: 'set',
      space: 'plugin',
      key: 'libra:test:portable-copy',
      value: { text: 'survives-program-replacement', number: 42 },
      operationId: 'portable_libra_set_000001',
      expectedRevision: 0
    });
    first.repositories.flashback.mutate({
      kind: 'set',
      space: 'local',
      key: 'vector_rag_memory:test:vector',
      value: { vector: [0.1, 0.2, 0.3] },
      operationId: 'portable_flashback_set_000001',
      expectedRevision: 0
    });
    first.repositories.hayaku.mutate({
      kind: 'set', space: 'plugin', key: 'hayaku:test:portable-copy',
      value: { ledger: ['portable', 'hayaku'] },
      operationId: 'portable_hayaku_set_000001', expectedRevision: 0
    });
    assertRetiredReadOnly(first,historical,{sourceUnchanged:true});
  } finally {
    await first.close();
  }
  const sourceStoreHashes=Object.fromEntries(['flashback','hayaku','libra','lia','retrace'].map(ns=>[ns,sha256(path.join(firstData,'stores',ns,ns+'.sqlite'))]));

  // User workflow: stop server, copy the entire DATA folder, discard PROGRAM.
  fs.mkdirSync(copiedRoot, { recursive: true });
  fs.cpSync(firstData, copiedData, { recursive: true, force: true });
  for(const [ns,digest]of Object.entries(sourceStoreHashes))assert.equal(sha256(path.join(copiedData,'stores',ns,ns+'.sqlite')),digest,'copied '+ns+' store exact');
  fs.rmSync(firstProgram, { recursive: true, force: true });
  assert.equal(fs.existsSync(firstProgram), false);
  assert.ok(fs.existsSync(path.join(copiedData, 'stores', 'libra', 'libra.sqlite')));
  assert.ok(fs.existsSync(path.join(copiedData, 'runtime-token.txt')));
  assert.ok(fs.existsSync(path.join(copiedData, 'data-layout.json')));

  const second = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: copiedData, autoBackup: false });
  try {
    await second.listen();
    assert.deepEqual(second.repositories.libra.get('plugin', 'libra:test:portable-copy').value, {
      text: 'survives-program-replacement',
      number: 42
    });
    assert.deepEqual(second.repositories.flashback.get('local', 'vector_rag_memory:test:vector').value, {
      vector: [0.1, 0.2, 0.3]
    });
    assert.deepEqual(second.repositories.hayaku.get('plugin', 'hayaku:test:portable-copy').value, {
      ledger: ['portable', 'hayaku']
    });
    assert.deepEqual(second.repositories.lia.get('plugin', 'lia:test:portable-copy').value, {
      persona: 'portable-lia'
    });
    assert.deepEqual(second.repositories.retrace.get('plugin', 'retrace:test:portable-copy').value, {
      handoff: 'portable-retrace'
    });
    assertRetiredReadOnly(second,historical,{sourceUnchanged:true});
  } finally {
    await second.close();
  }

  // Automatic DB migration creates a pre-migration backup and upgrades metadata.
  const libraPath = path.join(copiedData, 'stores', 'libra', 'libra.sqlite');
  {
    const db = new DatabaseSync(libraPath);
    db.prepare("UPDATE metadata SET value = '0' WHERE key = 'database_schema_version'").run();
    db.exec('PRAGMA user_version = 0;');
    db.close();
  }
  const migrating = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: copiedData, autoBackup: false });
  try {
    assert.equal(migrating.databasePreparation.migrated, true);
    assert.ok(migrating.databasePreparation.backup?.id);
    assert.ok(fs.existsSync(path.join(copiedData, 'backups', 'pre-migration', migrating.databasePreparation.backup.id, 'manifest.json')));
    await migrating.listen();
    const inspected = inspectDatabaseFile(libraPath, 'libra');
    assert.equal(inspected.version, DATABASE_SCHEMA_VERSION);
    assert.deepEqual(migrating.repositories.libra.get('plugin', 'libra:test:portable-copy').value, {
      text: 'survives-program-replacement',
      number: 42
    });
    assertRetiredReadOnly(migrating,historical,{sourceUnchanged:true});
  } finally {
    await migrating.close();
  }

  // A DATA schema newer than PROGRAM is rejected without touching layout or DB metadata.
  const layoutPath = path.join(copiedData, 'data-layout.json');
  const layoutHashBefore = sha256(layoutPath);
  {
    const db = new DatabaseSync(libraPath);
    db.prepare("UPDATE metadata SET value = '999' WHERE key = 'database_schema_version'").run();
    db.exec('PRAGMA user_version = 999;');
    db.close();
  }
  const dbHashBefore = sha256(libraPath);
  assert.throws(()=>preflightDataCompatibility(copiedData),error=>error.code==='DATA_SCHEMA_NEWER_THAN_PROGRAM'&&/data_schema_newer_than_program:libra:999>/.test(error.message));
  // Current authority admission protects any owner with user_version > 1
  // before generic compatibility preflight; the exact future-schema diagnosis
  // above and both unchanged-byte checks retain the original refusal contract.
  assert.throws(
    () => createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: copiedData, autoBackup: false }),
    error=>error.code==='AUTHORITY_LIFECYCLE_UNAVAILABLE'
  );
  assert.equal(sha256(layoutPath), layoutHashBefore, 'Future DB rejection must not rewrite data-layout.json.');
  assert.equal(sha256(libraPath), dbHashBefore, 'Future DB rejection must not rewrite the database.');
  for(const [ns,digest]of Object.entries(sourceStoreHashes))assert.equal(sha256(path.join(firstData,'stores',ns,ns+'.sqlite')),digest,'donor '+ns+' store remains immutable');

  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.stdout.write('portable_data_copy_test: PASS\n');
}

main().catch(error => {
  process.stderr.write(`portable_data_copy_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
