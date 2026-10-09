'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, fresh, put, snapshotDurable, ownerApi } = require('./fixtures/authority_server_fixture.cjs');
function originalResult(f, namespace, operationId) {
  assert.equal(typeof ownerApi.readOwnerOperationResult, 'function', 'retained result reader is required');
  const key = { generation: f.control.readWitness().generation, namespace, operationId };
  const decision = f.control.readOperation(key);
  return ownerApi.readOwnerOperationResult(f.owners[namespace], key, { expectedReceipt: decision.decision.receipt });
}
function compare(t, mutations, operationId) {
  const legacy = fixture(t).repositories.libra;
  const before = legacy.applyConditionalBatch(mutations, { operationId });
  assert.equal(before.result.receipts.length, mutations.length);
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  let returned;
  assert.doesNotThrow(() => { returned = repo.applyConditionalBatch(mutations, { operationId }); }, 'existing admitted batch must keep working under real authority');
  const receipt = f.readReceipt('libra', operationId);
  assert.equal(receipt.contract, 'memory-suite.owner-write-receipt.v2');
  assert.equal(Object.hasOwn(receipt, 'ordinaryReceipt'), false);
  assert.equal(Array.isArray(receipt.touchedSources), false);
  assert(receipt.ordinaryResult.utf8Bytes > 0);
  assert(Buffer.byteLength(JSON.stringify(receipt)) < 65536);
  assert.deepEqual(returned, originalResult(f, 'libra', operationId));
  assert.equal(returned.result.receipts.length, mutations.length);
  assert.equal(repo.database.prepare('SELECT count(*) n FROM kv').get().n, mutations.length);
}

test('4096_internal_batch_and_64_long_unicode_public_profile_preserve_capacity', t => {
  compare(t, Array.from({ length: 4096 }, (_, i) => fresh('libra:boundary:small:' + i, i)), 'retained-max-internal-batch');
  const mutations = Array.from({ length: 64 }, (_, i) => fresh('libra:boundary:' + '한'.repeat(4000) + ':' + i, i));
  assert(Buffer.byteLength(JSON.stringify({ namespace: 'libra', operationId: 'retained-long-public-batch', mutations })) < 4 * 1024 * 1024);
  compare(t, mutations, 'retained-long-public-batch');
});

test('historical_overlimit_key_refuses_initialization_without_qualification_writes', t => {
  const f = fixture(t), db = f.repositories.libra.database;
  db.prepare('INSERT INTO kv VALUES(?,?,?,0,1,?,0)').run('plugin', 'x'.repeat(4097), '0', 'a'.repeat(64));
  const before = snapshotDurable(f.dataDir);
  assert.throws(() => f.activate({ open: false }), /AUTHORITY_WRITER_KEY_PROFILE_UNAVAILABLE/);
  assert.deepEqual(snapshotDurable(f.dataDir), before);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'stores/_authority')), false);
});

test('maximal_historical_key_survives_activation_remove_purge_recreate', t => {
  const f = fixture(t), key = '한'.repeat(4096), old = f.repositories.libra;
  put(old, key, 'original', 'retained-historical-seed');
  f.activate(); const repo = f.repositories.libra;
  assert.equal(repo.database.prepare('PRAGMA user_version').get().user_version, 3);
  const row = repo.get('plugin', key);
  repo.applyConditionalBatch([{ kind: 'purge', space: 'plugin', key, expectedRevision: row.revision, expectedDigest: row.digest, expectedExists: true, expectedTombstone: false }], { operationId: 'retained-historical-purge' });
  put(repo, key, 'recreated', 'retained-historical-recreate');
  assert.equal(repo.get('plugin', key).value, 'recreated');
  assert.equal(originalResult(f, 'libra', 'retained-historical-purge').result.receipts[0].key, key);
});

test('lone_surrogate_collisions_match_legacy_SQLite_and_retain_original_response', t => {
  const keys = ['libra:alias:\ud800', 'libra:alias:\ud801', 'libra:alias:\udc00', 'libra:alias:\ufffd', '\ud800:libra:start', 'libra:end:\udfff', 'libra:pair:😀'];
  const run = (f, active) => {
    if (active) f.activate();
    const repo = f.repositories.libra;
    const result = repo.applyConditionalBatch(keys.map((key, i) => fresh(key, i)), { operationId: 'retained-surrogate-collision' });
    const raw = repo.database.prepare('SELECT key,revision,value_json FROM kv ORDER BY key').all().map(row => ({ ...row }));
    if (active) {
      const receipt = f.readReceipt('libra', 'retained-surrogate-collision');
      assert.deepEqual(originalResult(f, 'libra', 'retained-surrogate-collision'), result);
      assert.equal(receipt.touchedSources.count, raw.length);
      const stamps = repo.database.prepare('SELECT key,version FROM authority_source_lifecycle ORDER BY key').all();
      for (const row of raw) assert.equal(stamps.find(stamp => stamp.key === row.key).version, row.revision);
      assert.deepEqual(result.result.receipts.map(row => row.key), keys);
    }
    return raw;
  };
  assert.deepEqual(run(fixture(t), true), run(fixture(t), false));
});
