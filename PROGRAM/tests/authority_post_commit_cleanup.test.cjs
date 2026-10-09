'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
// Test-only differential runner: the same assertions can load the sealed old
// source tree. Each fixture imports its own real core modules consistently.
const program = process.env.LIB_AUTHORITY_REVIEW_PROGRAM || path.resolve(__dirname, '..');
const { fixture, fresh, put } = require(path.join(program, 'tests/fixtures/authority_server_fixture.cjs'));
const count = (repo, table) => repo.database.prepare('SELECT count(*) n FROM ' + table).get().n;

test('authorized_maintenance_batch_threshold_preserves_receipt_and_guarded_cleanup', t => {
  const f = fixture(t); f.activate(); const repo = f.open('libra', () => true);
  const rows = Array.from({ length: 1000 }, (_, i) => fresh('libra:cleanup:maintenance:' + i, i));
  let result;
  assert.doesNotThrow(() => { result = repo.applyConditionalBatch(rows, { maintenance: true, operationId: 'cleanup-maintenance-threshold' }); }, 'confirmed maintenance batch must return its success receipt');
  assert.deepEqual(result, f.readResult('libra', 'cleanup-maintenance-threshold'));
  assert.equal(result.result.receipts.length, 1000);
  assert.equal(count(repo, 'authority_write_receipts'), 2, 'batch and cleanup each own a real authority receipt');
  const receipts = repo.database.prepare('SELECT receipt_json FROM authority_write_receipts').all().map(row => JSON.parse(row.receipt_json));
  const cleanup = receipts.find(row => f.readResult(row.namespace,row.operationId)?.kind === 'ordinary-receipt-cleanup');
  assert.equal(cleanup.operationClass, 'maintenance');
  assert.deepEqual(repo.applyConditionalBatch(rows, { maintenance: true, operationId: 'cleanup-maintenance-threshold' }), result);
  assert.equal(count(repo, 'authority_write_receipts'), 2, 'replay never dispatches duplicate housekeeping');
});

for (const kind of ['batch', 'mutate']) test(`post_commit_cleanup_SQL_failure_preserves_${kind}_receipt_and_replay`, t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  const rows = Array.from({ length: kind === 'batch' ? 1000 : 999 }, (_, i) => fresh('libra:cleanup:failure:' + i, i));
  if (kind === 'mutate') repo.applyConditionalBatch(rows, { operationId: 'cleanup-failure-seed' });
  const originalPrepare = DatabaseSync.prototype.prepare;
  let injected = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = originalPrepare.call(this, sql);
    if (this === repo.database && sql === 'DELETE FROM operations WHERE created_at < ?') {
      statement.run = () => { injected++; throw Error('TASK4_CLEANUP_SQL_FAILURE'); };
    }
    return statement;
  };
  const operationId = 'cleanup-failure-' + kind;
  const run = () => kind === 'batch' ? repo.applyConditionalBatch(rows, { operationId }) : put(repo, 'libra:cleanup:failure:999', 999, operationId);
  let result;
  try {
    assert.doesNotThrow(() => { result = run(); }, 'failed housekeeping cannot negate the confirmed owner commit');
    assert.equal(injected, 1);
    assert.deepEqual(result, f.readResult('libra', operationId));
    assert.equal(count(repo, 'kv'), 1000);
    assert.deepEqual(run(), result);
    assert.equal(injected, 1, 'exact public replay does not repeat failed cleanup');
  } finally { DatabaseSync.prototype.prepare = originalPrepare; }
  assert.equal(f.control.readWitness().pendingIntent, null, 'real coordinator reconciles cleanup abort');
  const decisions = f.readControl('SELECT operation_id,status,operation_class FROM write_intents');
  const cleanup = decisions.filter(row => row.operation_id.startsWith('receipt-cleanup:'));
  assert.equal(cleanup.length, 1); assert.equal(cleanup[0].status, 'aborted'); assert.equal(cleanup[0].operation_class, 'maintenance');
  assert.equal(count(repo, 'authority_write_receipts'), kind === 'batch' ? 1 : 2, 'failed housekeeping has no fabricated receipt');
  assert.throws(() => repo.database.prepare('DELETE FROM authority_write_receipts').run(), /AUTHORITY_WRITE_DENIED/);
});

test('unsafe_cleanup_termination_remains_fatal_without_success_continuation', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/authority_cleanup_fatal_child.cjs')], { encoding: 'utf8', timeout: 30000, env: { NODE_OPTIONS:process.env.NODE_OPTIONS, LIBRA_NETWORK_AUDIT:process.env.LIBRA_NETWORK_AUDIT, LANG: 'C', TZ: 'UTC', NODE_NO_WARNINGS: '1', LIB_AUTHORITY_REVIEW_PROGRAM: program } });
  assert.equal(child.error, undefined);
  const info = JSON.parse(child.stdout.split('\n')[0]);
  assert(path.resolve(info.root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lib-authority-task4-'));
  try {
    assert.equal(child.status, 70, child.stderr);
    assert.equal(child.stderr, 'AUTHORITY_UNSAFE_TRANSACTION_END\n');
    assert.equal(child.stdout.includes('UNSAFE_SUCCESS_CONTINUATION'), false);
    const owner = new DatabaseSync(info.filePath, { readOnly: true });
    try {
      assert.equal(owner.prepare('SELECT count(*) n FROM kv').get().n, 1000);
      assert.equal(owner.prepare('SELECT count(*) n FROM authority_write_receipts').get().n, 1);
    } finally { owner.close(); }
    const control = new DatabaseSync(path.join(info.dataDir, 'stores/_authority/server-authority.sqlite'), { readOnly: true });
    try {
      const pending = control.prepare("SELECT operation_id,operation_class FROM write_intents WHERE status='pending'").all();
      assert.equal(pending.length, 1); assert(pending[0].operation_id.startsWith('receipt-cleanup:')); assert.equal(pending[0].operation_class, 'maintenance');
    } finally { control.close(); }
  } finally { fs.rmSync(info.root, { recursive: true, force: true }); }
});
