'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { currentFixture: fixture, put, ownerApi, snapshotDurable } = require('./fixtures/authority_server_fixture.cjs');
const { createAuthorityCoordinator } = require('../server/authority/coordinator.cjs');
const C = require('../server/authority/contracts.cjs');
const keyFor = (f, operationId) => ({ generation: f.control.readWitness().generation, namespace: 'libra', operationId });
const resultFor = (f, id) => {
  assert.equal(typeof ownerApi.readOwnerOperationResult, 'function', 'retained result reader required');
  const key = keyFor(f, id), committed = f.control.readOperation(key);
  return ownerApi.readOwnerOperationResult(f.owners.libra, key, { expectedReceipt: committed.decision.receipt });
};
function requireV2(f, id) {
  const receipt = f.readReceipt('libra', id);
  assert.equal(receipt.contract, 'memory-suite.owner-write-receipt.v2', 'compact receipt contract required');
  assert.equal(Object.hasOwn(receipt, 'ordinaryReceipt'), false);
  return receipt;
}
function tamper(f, work) {
  const db = new DatabaseSync(f.repositories.libra.filePath);
  db.function('authority_guard', (table, action) => 1);
  db.exec('PRAGMA ignore_check_constraints=ON');
  try { return work(db); } finally { db.close(); }
}
const count = (repo, table) => repo.database.prepare('SELECT count(*) n FROM ' + table).get().n;

test('schema3_guards_retained_result_and_touch_rows_and_exact_original_bytes', t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  const result = put(repo, 'libra:retained:한😀', 'value', 'retained-exact-byte-operation');
  const receipt = requireV2(f, 'retained-exact-byte-operation');
  assert.equal(repo.database.prepare('PRAGMA user_version').get().user_version, 3);
  const ordinary = repo.database.prepare('SELECT response_json FROM operations WHERE operation_id=?').get('retained-exact-byte-operation').response_json;
  const retained = repo.database.prepare('SELECT response_json,utf8_bytes,sha256 FROM authority_write_results WHERE operation_id=?').get('retained-exact-byte-operation');
  assert.equal(retained.response_json, ordinary);
  assert.equal(retained.utf8_bytes, Buffer.byteLength(ordinary));
  assert.equal(retained.sha256, crypto.createHash('sha256').update(ordinary, 'utf8').digest('hex'));
  assert.equal(receipt.ordinaryResult.sha256, retained.sha256);
  assert.deepEqual(resultFor(f, 'retained-exact-byte-operation'), result);
  assert.equal(receipt.touchedSources.count, 1);
  for (const table of ['authority_write_results', 'authority_write_touches']) {
    assert.equal(count(repo, table), 1);
    for (const sql of ['INSERT INTO ' + table + ' SELECT * FROM ' + table, 'UPDATE ' + table + ' SET generation=generation', 'DELETE FROM ' + table]) assert.throws(() => repo.database.exec(sql), /AUTHORITY_WRITE_DENIED/);
  }
});

test('ordinary_expiry_and_repository_reopen_keep_exact_retained_replay', t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  const realNow = Date.now; let first;
  try { Date.now = () => 1; first = put(repo, 'libra:retained:aged', 'original', 'retained-aged-operation'); }
  finally { Date.now = realNow; }
  requireV2(f, 'retained-aged-operation');
  const original = repo.database.prepare('SELECT response_json FROM operations WHERE operation_id=?').get('retained-aged-operation').response_json;
  repo.__task4Maintenance();
  assert.equal(repo.operation('retained-aged-operation'), null);
  const reopened = f.open('libra');
  assert.deepEqual(put(reopened, 'libra:retained:aged', 'original', 'retained-aged-operation'), first);
  assert.equal(reopened.database.prepare('SELECT response_json FROM authority_write_results WHERE operation_id=?').get('retained-aged-operation').response_json, original);
  assert.throws(() => put(reopened, 'libra:retained:aged', 'different', 'retained-aged-operation'), /operation_id_payload_conflict/);
  assert.equal(reopened.get('plugin', 'libra:retained:aged').revision, 1);
});

for (const target of ['result', 'touch', 'compact-mismatch']) test(`terminal_replay_quarantines_${target}_loss_without_operations_fallback`, t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra, id = 'retained-loss-' + target;
  put(repo, 'libra:retained:loss', 'original', id); requireV2(f, id);
  assert(repo.operation(id), 'ordinary fallback remains available but must not be used');
  tamper(f, db => {
    if (target === 'result') db.prepare('DELETE FROM authority_write_results WHERE operation_id=?').run(id);
    else if (target === 'touch') db.prepare('DELETE FROM authority_write_touches WHERE operation_id=?').run(id);
    else {
      const row = db.prepare('SELECT receipt_json FROM authority_write_receipts WHERE operation_id=?').get(id);
      const receipt = JSON.parse(row.receipt_json); receipt.controlSequence += 2;
      db.prepare('UPDATE authority_write_receipts SET receipt_json=? WHERE operation_id=?').run(C.canonical(receipt), id);
    }
  });
  assert.throws(() => put(repo, 'libra:retained:loss', 'original', id), /AUTHORITY_QUARANTINED/);
  assert.equal(repo.get('plugin', 'libra:retained:loss').revision, 1);
  assert.equal(f.control.readOperation(keyFor(f, id)).status, 'committed');
});

test('orphan_retained_payload_without_compact_receipt_never_proves_abort', t => {
  const f = fixture(t); f.activate();
  const key = keyFor(f, 'retained-orphan-operation');
  const intent = f.control.publishIntent({ ...key, fingerprint: 'a'.repeat(64), operationClass: 'kv' });
  f.control.withExclusiveGate(permit => ownerApi.applyOwnerMutation(f.owners.libra, permit, intent, tx => {
    tx.run('INSERT INTO kv VALUES(?,?,?,0,1,?,0)', 'plugin', 'libra:retained:orphan', '1', 'b'.repeat(64));
    tx.run('INSERT INTO operations VALUES(?,?,?,0)', key.operationId, intent.fingerprint, '{"ok":true}');
  }));
  requireV2(f, key.operationId);
  tamper(f, db => db.prepare('DELETE FROM authority_write_receipts WHERE operation_id=?').run(key.operationId));
  const coordinator = createAuthorityCoordinator({ control: f.control, resolveOwnerStore: name => f.owners[name] });
  assert.throws(() => coordinator.recoverPending(), /AUTHORITY_QUARANTINED/);
  assert.equal(f.control.readOperation(key).status, 'pending');
  assert.equal(count(f.repositories.libra, 'kv'), 1);
});

for (const target of ['compact', 'touch']) test(`oversized_${target}_scalar_is_refused_before_SQL_to_JS_payload_load`, t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra, id = 'retained-size-' + target;
  put(repo, 'libra:retained:size', 'value', id); requireV2(f, id);
  tamper(f, db => {
    if (target === 'compact') db.prepare('UPDATE authority_write_receipts SET receipt_json=? WHERE operation_id=?').run('x'.repeat(65537), id);
    else db.prepare('UPDATE authority_write_touches SET source_id=? WHERE operation_id=?').run('x'.repeat(32769), id);
  });
  const prepare = DatabaseSync.prototype.prepare; let loaded = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (new RegExp('FROM authority_write_' + (target === 'compact' ? 'receipts' : 'touches'), 'i').test(sql)) {
      const get = statement.get;
      statement.get = function(...args) {
        const row = get.apply(this, args);
        if (row && Object.values(row).some(v => typeof v === 'string' && v.length > (target === 'compact' ? 65536 : 32768))) { loaded++; throw Error('UNBOUNDED_SQL_SCALAR_LOAD'); }
        return row;
      };
    }
    return statement;
  };
  try { assert.throws(() => f.readReceipt('libra', id), /AUTHORITY_QUARANTINED/); }
  finally { DatabaseSync.prototype.prepare = prepare; }
  assert.equal(loaded, 0);
});

test('activated_fingerprint_checks_never_fetch_full_ordinary_response', t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  const prepare = DatabaseSync.prototype.prepare; let unbounded = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    if (/SELECT\s+fingerprint\s*,\s*response_json\s+FROM operations/i.test(sql)) { unbounded++; throw Error('UNBOUNDED_OPERATION_LOOKUP'); }
    return prepare.call(this, sql);
  };
  try { put(repo, 'libra:retained:metadata', 'value', 'retained-metadata-only'); }
  finally { DatabaseSync.prototype.prepare = prepare; }
  assert.equal(unbounded, 0);
  requireV2(f, 'retained-metadata-only');
});

test('post_owner_COMMIT_readback_failure_reconciles_exact_commit_once', t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
  let committed = false, fired = false;
  DatabaseSync.prototype.exec = function(sql) { const out = exec.call(this, sql); if (this === repo.database && sql === 'COMMIT') committed = true; return out; };
  DatabaseSync.prototype.prepare = function(sql) { if (this === repo.database && committed && !fired && /FROM authority_write_receipts/i.test(sql)) { fired = true; throw Error('AFTER_OWNER_COMMIT_READ_FAILURE'); } return prepare.call(this, sql); };
  let result;
  try { result = put(repo, 'libra:retained:commit', 'value', 'retained-after-commit'); }
  finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.prepare = prepare; }
  assert.equal(fired, true);
  requireV2(f, 'retained-after-commit');
  assert.deepEqual(resultFor(f, 'retained-after-commit'), result);
  assert.equal(repo.get('plugin', 'libra:retained:commit').revision, 1);
  assert.equal(f.control.readOperation(keyFor(f, 'retained-after-commit')).status, 'committed');
});

for (const version of [2, 4]) test(`prior_activated_or_future_schema_${version}_refuses_without_writes`, t => {
  const f = fixture(t), db = f.repositories.libra.database;
  db.exec('PRAGMA user_version=' + version);
  db.prepare("UPDATE metadata SET value=? WHERE key='database_schema_version'").run(String(version));
  const before = snapshotDurable(f.dataDir);
  assert.throws(() => f.activate({ open: false }), /AUTHORITY_QUARANTINED/);
  assert.deepEqual(snapshotDurable(f.dataDir), before);
});

// RECOVERY RECORD ONLY: append to the original retention test after restoring its base.

for (const table of ['authority_write_results','authority_write_touches']) test(`partial_${table}_schema_refuses_without_initialization_writes`,t=>{
 const f=fixture(t);f.repositories.libra.database.exec(`CREATE TABLE ${table}(placeholder)`);const before=snapshotDurable(f.dataDir);
 assert.throws(()=>f.activate({open:false}),/AUTHORITY_QUARANTINED/);assert.deepEqual(snapshotDurable(f.dataDir),before);
});

test('historical_minimum_SQLite_rowid_cannot_hide_unsupported_key',t=>{
 const f=fixture(t),db=f.repositories.libra.database;
 db.prepare('INSERT INTO kv(rowid,space,key,value_json,deleted,revision,digest,updated_at) VALUES(?,?,?,?,0,1,?,0)').run(-9223372036854775808n,'plugin','x'.repeat(4097),'0','a'.repeat(64));
 const before=snapshotDurable(f.dataDir);assert.throws(()=>f.activate({open:false}),/AUTHORITY_WRITER_KEY_PROFILE_UNAVAILABLE/);assert.deepEqual(snapshotDurable(f.dataDir),before);
});

for (const target of ['source_generation','key','digest','source_id','space','source_version','revision','present','ordinal']) test(`retained_touch_${target}_is_bounded_or_rejected_before_scalar_load`,t=>{
 const f=fixture(t);f.activate();const id='retained-scalar-'+target;put(f.repositories.libra,'libra:scalar:key','value',id);
 const invalid=['source_version','revision','ordinal'].includes(target)?9223372036854775807n:target==='present'?2:'x'.repeat(32769);
 tamper(f,db=>db.prepare(`UPDATE authority_write_touches SET ${target}=? WHERE operation_id=?`).run(invalid,id));
 const prepare=DatabaseSync.prototype.prepare;let oversized=0;
 DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(/FROM authority_write_touches/i.test(sql)){const get=stmt.get;stmt.get=function(...args){const row=get.apply(this,args);if(row&&Object.values(row).some(v=>typeof v==='string'&&v.length>32768)){oversized++;throw Error('UNBOUNDED_TOUCH');}return row;};}return stmt;};
 try{assert.throws(()=>f.readReceipt('libra',id),/AUTHORITY_QUARANTINED/);}finally{DatabaseSync.prototype.prepare=prepare;}assert.equal(oversized,0);
});

for (const target of ['result','touch']) test(`one_shot_${target}_read_fault_after_owner_commit_reconciles_without_rerun`,t=>{
 const f=fixture(t);f.activate();const repo=f.repositories.libra,id='retained-postcommit-'+target;const exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;let committed=false,fired=false;
 DatabaseSync.prototype.exec=function(sql){const r=exec.call(this,sql);if(this===repo.database&&sql==='COMMIT')committed=true;return r;};
 DatabaseSync.prototype.prepare=function(sql){if(this===repo.database&&committed&&!fired&&sql.includes('FROM authority_write_'+(target==='result'?'results':'touches'))){fired=true;throw Error('READBACK_IO');}return prepare.call(this,sql);};
 let result;try{result=put(repo,'libra:postcommit:key','value',id);}finally{DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.prepare=prepare;}
 assert.equal(fired,true);assert.deepEqual(resultFor(f,id),result);assert.equal(repo.get('plugin','libra:postcommit:key').revision,1);assert.equal(f.control.readOperation(keyFor(f,id)).status,'committed');
});

test('terminal_delivery_failure_keeps_committed_and_retry_reuses_exact_result',t=>{
 const f=fixture(t);f.activate();const repo=f.repositories.libra,id='retained-delivery-fault';const prepare=DatabaseSync.prototype.prepare;let fired=false;
 DatabaseSync.prototype.prepare=function(sql){if(/FROM authority_decisions JOIN write_intents/.test(sql)){fired=true;throw Error('DELIVERY_IO');}return prepare.call(this,sql);};
 try{assert.throws(()=>put(repo,'libra:delivery:key','value',id),/DELIVERY_IO/);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(fired,true);assert.equal(f.control.readOperation(keyFor(f,id)).status,'committed');assert.equal(repo.get('plugin','libra:delivery:key').revision,1);
 const result=put(repo,'libra:delivery:key','value',id);assert.deepEqual(result,resultFor(f,id));assert.equal(repo.get('plugin','libra:delivery:key').revision,1);
});

test('extra_touch_ordinal_uses_metadata_only_sentinel',t=>{
 const f=fixture(t);f.activate();const id='retained-extra-sentinel';put(f.repositories.libra,'libra:sentinel:key','value',id);
 tamper(f,db=>db.prepare('INSERT INTO authority_write_touches SELECT generation,namespace,operation_id,1,space,?,source_id,source_generation,source_version,present,revision,digest FROM authority_write_touches WHERE operation_id=?').run('x'.repeat(32769),id));
 assert.throws(()=>f.readReceipt('libra',id),/AUTHORITY_QUARANTINED/);
});

// RECOVERY RECORD ONLY. These were prepared but NEVER RUN before interruption.
// Append to the existing retention test after restoration, then observe RED before fixes.
for(const target of ['source_id','digest'])test(`mutable_lifecycle_${target}_cannot_load_unbounded_stamp_scalar`,t=>{
 const f=fixture(t);f.activate();const repo=f.repositories.libra;put(repo,'libra:lifecycle:bounded','first','retained-lifecycle-seed-'+target);
 tamper(f,db=>db.prepare(`UPDATE authority_source_lifecycle SET ${target}=?`).run('x'.repeat(32769)));
 const prepare=DatabaseSync.prototype.prepare;let unbounded=0;
 DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(/FROM authority_source_lifecycle/i.test(sql)){const get=stmt.get;stmt.get=function(...args){const row=get.apply(this,args);if(row&&Object.values(row).some(v=>typeof v==='string'&&v.length>32768)){unbounded++;throw Error('UNBOUNDED_LIFECYCLE_SCALAR');}return row;};}return stmt;};
 try{assert.throws(()=>put(repo,'libra:lifecycle:bounded','second','retained-lifecycle-next-'+target),/AUTHORITY_QUARANTINED/);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(unbounded,0);assert.equal(repo.get('plugin','libra:lifecycle:bounded').revision,1);
});

test('activated_preexisting_ordinary_fingerprint_is_bounded_before_materialization',t=>{
 const f=fixture(t),id='retained-large-fingerprint';f.repositories.libra.database.prepare('INSERT INTO operations VALUES(?,?,?,0)').run(id,'x'.repeat(32769),'{"ok":true}');f.activate();
 const prepare=DatabaseSync.prototype.prepare;let unbounded=0;
 DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(/FROM operations/i.test(sql)){const get=stmt.get;stmt.get=function(...args){const row=get.apply(this,args);if(row&&Object.values(row).some(v=>typeof v==='string'&&v.length>32768)){unbounded++;throw Error('UNBOUNDED_ORDINARY_FINGERPRINT');}return row;};}return stmt;};
 try{assert.throws(()=>put(f.repositories.libra,'libra:bounded:fingerprint','value',id),/AUTHORITY_QUARANTINED/);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(unbounded,0);assert.equal(f.repositories.libra.get('plugin','libra:bounded:fingerprint').exists,false);
});
