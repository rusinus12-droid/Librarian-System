'use strict';
// A post-commit State attempt that committed a digest-verified receipt has run, even when the
// State it wrote still holds a pending item. Its journal entry completes instead of replaying the
// same deterministic chain on every boot forever (seen in the field: attempts 13 and 18 on
// `memory_first_contiguous_state`, a narrative thread link holding its domain). A missing
// canonical range, an unverifiable receipt or a failure still stays pending.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MARKER = '    /* LIBRA STATE TRACKING JOURNAL END */';
const expose = source => {
  assert.equal(source.split(MARKER).length, 2, 'journal block marker');
  return source.replace(MARKER, `    globalThis.__stateJournal = {
      get finish() { return finishStateTrackingJournalAttempt; }, get update() { return updateStateTrackingJournalEntry; },
      get load() { return loadStateTrackingJournal; }, get receiptDigest() { return statePipelineReceiptDigest; },
      get digest() { return digest; }, get schema() { return STATE_PIPELINE_RECEIPT_SCHEMA; }, get resolveContext() { return resolveContext; } };
${MARKER}`);
};

test('a committed partial State completes its journal entry; a gap, a bad receipt or a failure stays pending', async t => {
  const f = await fixture({ transformSource: expose });
  t.after(() => f.r.cleanup());
  await f.run();
  const sj = f.r.context.__stateJournal, scope = (await sj.resolveContext()).scope;
  const [entry] = (await sj.load(scope)).entries;
  assert.ok(entry, 'the canonical commit wrote a State journal entry');
  const reopen = async () => await sj.update({ scope, identityDigest: entry.identityDigest, patch: { state: 'pending', reason: 'memory_first_contiguous_state' } });

  const head = { status: 'partial', domainStatus: { narrative: { status: 'not_updated', reason: 'unified_bindings_pending' } } };
  const receipt = { schema: sj.schema, status: 'partial', replay: true, headDigest: sj.digest(head),
    pending: [{ domain: 'narrative', reason: 'thread_link_pending:thread_anchor_evidence_missing' },
      { domain: 'character', reason: 'memory_record_quarantined' }] };
  receipt.receiptDigest = sj.receiptDigest(receipt);
  const committed = { ok: true, localReplay: true, providerCalls: 0, reason: 'memory_first_contiguous_state', head, receipt, receiptKey: 'receipt' };

  const done = await sj.finish({ scope, entry: await reopen(), result: committed });
  assert.equal(done.state, 'completed', 'a committed partial State is not replayed again');
  assert.equal(done.reason, 'state_committed_with_pending');
  assert.deepEqual(Array.from(done.remainingPending), ['thread_link_pending:thread_anchor_evidence_missing', 'memory_record_quarantined']);
  const stored = (await sj.load(scope)).entries.find(row => row.identityDigest === entry.identityDigest);
  assert.equal(stored.state, 'completed', 'the completion is durable');

  const gap = await sj.finish({ scope, entry: await reopen(), result: { ...committed, pendingBoundary: { reason: 'state_prefix_gap', startTurn: 6 } } });
  assert.equal(gap.state, 'pending', 'a missing canonical range waits for that range');

  const tampered = await sj.finish({ scope, entry: await reopen(), result: { ...committed, receipt: { ...receipt, status: 'partial', receiptDigest: 'forged' } } });
  assert.equal(tampered.state, 'pending', 'an unverifiable receipt is not trusted');

  const moved = await sj.finish({ scope, entry: await reopen(), result: { ...committed, head: { ...head, status: 'ready' } } });
  assert.equal(moved.state, 'pending', 'a receipt for another Head is not trusted');

  const failed = await sj.finish({ scope, entry: await reopen(), result: committed, error: new Error('UNIFIED_REPLAY_EXTERNAL_WRITE') });
  assert.equal(failed.state, 'pending', 'a failed attempt is retried');

  const shell = await sj.finish({ scope, entry: await reopen(), result: { ok: true, skipped: true, receipt: { status: 'pending' } } });
  assert.equal(shell.state, 'pending', 'a pending receipt shell is not a committed State');
});
