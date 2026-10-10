'use strict';
// Public U1 regression: the self-contained shared-host fixture uses each
// deployed owner's writer, calls public RETRACE.continueToNextSession(), then
// proves target consumers re-read the durable target after a reboot.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const fixture = path.resolve(__dirname, 'fixtures', 'retrace_u1_owner_writer_fixture.cjs');
const content = rows => rows.map(row => ({ hash: row.hash, text: row.text })).sort((left, right) => left.hash.localeCompare(right.hash));
for (const scenario of ['same', 'different']) {
  const output = execFileSync(process.execPath, [fixture], {
    cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8',
    env: { ...process.env, U1_PERSONA_SCENARIO: scenario }
  });
  const line = output.split(/\r?\n/).find(value => value.startsWith('U1_OWNER_WRITER_SUMMARY '));
  assert.ok(line, `${scenario}: fixture must report the public handoff summary`);
  const value = JSON.parse(line.slice('U1_OWNER_WRITER_SUMMARY '.length));
  assert.equal(value.publicResultOk, true, `${scenario}: public handoff completes`);
  assert.equal(value.journalState, 'completed', `${scenario}: completed journal`);
  assert.equal(value.flashback.records, 8, `${scenario}: Flashback consumer payload`);
  assert.equal(value.hayaku.records, 5, `${scenario}: HAYAKU consumer payload`);
  assert.equal(value.libra.records, 1, `${scenario}: LIBRA consumer payload`);
  assert.equal(value.lia.durableReadbackVerified, true, `${scenario}: LIA durable fork`);
  assert.equal(value.sourcePreserved, true, `${scenario}: source immutable`);
  assert.equal(value.flashback.sourceFingerprintBefore, value.flashback.sourceFingerprintAfter, `${scenario}: Flashback source fingerprint preserved`);
  assert.equal(value.ownerReads.flashback.records, 8, `${scenario}: target Flashback own reader`);
  assert.equal(value.ownerReads.hayaku.records, 5, `${scenario}: target HAYAKU own reader`);
  assert.equal(value.ownerReads.libra.records, 1, `${scenario}: target LIBRA own reader`);
  assert.equal(value.ownerReads.lia.livePersonaId, value.lia.livePersonaId, `${scenario}: target LIA own reader`);
  assert.deepEqual(value.rebootReads, value.ownerReads, `${scenario}: reboot reads the same target evidence`);
  assert.deepEqual(value.sourceReaders.after, value.sourceReaders.before, `${scenario}: source owner readers preserve their snapshots`);
  assert.deepEqual(content(value.ownerReads.flashback.rows), content(value.sourceReaders.before.flashback.rows), `${scenario}: target Flashback content matches source snapshot`);
  assert.deepEqual(content(value.ownerReads.hayaku.rows), content(value.sourceReaders.before.hayaku.rows), `${scenario}: target HAYAKU content matches source snapshot`);
  assert.deepEqual(content(value.ownerReads.libra.rows), content(value.sourceReaders.before.libra.rows), `${scenario}: target LIBRA content matches source snapshot`);
  assert.equal(value.rebootJournal.pending, false, `${scenario}: reboot has no pending journal`);
  assert.equal(value.rebootJournal.state, 'completed', `${scenario}: reboot reads durable completed journal`);
  assert.equal(value.rebootJournal.transferId, value.transferId, `${scenario}: reboot journal retains transfer`);
  assert.equal(value.forged.ok, false, `${scenario}: forged liaContinuity is rejected`);
  assert.equal(value.wrongTransfer.ok, false, `${scenario}: wrong transfer is rejected`);
  assert.equal(value.wrongOwnerScope.ok, false, `${scenario}: unrelated LIA owner scope is rejected`);
  assert.equal(value.bindingDrift.drifted, true, `${scenario}: target binding drift seam executes`);
  assert.equal(value.bindingDrift.ok, false, `${scenario}: binding drift cannot reuse a receipt`);
  assert.equal(value.bindingDrift.receiptReused, false, `${scenario}: drift never reports receipt reuse`);
}
console.log('retrace_u1_all_owners_owner_writer_test: PASS (same/different all-four public handoff, owner readers, reboot, forged and drift guards)');
