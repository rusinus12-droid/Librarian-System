'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Reuse the four-owner writers/readers and restart oracle. The extra obligation
// is reaching that public flow through a host-registered UI callback and the
// rendered session tab, create-session button, and real confirmation dialogs.
for (const scenario of ['same', 'different']) {
  const output = execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'retrace_u1_owner_writer_fixture.cjs')], {
    encoding: 'utf8', env: { ...process.env, U1_PERSONA_SCENARIO: scenario, U1_GUI_ENTRY: 'true' }
  });
  const line = output.split(/\r?\n/).find(row => row.startsWith('U1_OWNER_WRITER_SUMMARY '));
  assert.ok(line, `${scenario}: four-owner fixture reports its readbacks`);
  const summary = JSON.parse(line.slice('U1_OWNER_WRITER_SUMMARY '.length));
  assert.equal(summary.gui?.entryId, 'retrace-main-hamburger', `${scenario}: actual registered GUI entry ran`);
  assert.equal(summary.gui?.tab, 'session', `${scenario}: actual session tab handler ran`);
  assert.equal(summary.gui?.confirmations, 2, `${scenario}: confirm and completed alert ran`);
  assert.equal(summary.gui?.providerCallsDuringHandoff, 0, `${scenario}: GUI handoff invokes no model provider`);
  assert.equal(summary.publicResultOk, true);
  assert.equal(summary.journalState, 'completed');
  assert.ok(summary.flashback.sourceFingerprintBefore);
  assert.equal(summary.flashback.sourceFingerprintAfter, summary.flashback.sourceFingerprintBefore);
  assert.deepEqual(summary.sourceReaders.after, summary.sourceReaders.before);
  assert.deepEqual(summary.rebootReads, summary.ownerReads, `${scenario}: exact target owner field readback survives fresh runtime`);
  assert.equal(summary.rebootJournal.transferId, summary.transferId);
  console.log(JSON.stringify({ scenario, gui: summary.gui, journal: summary.rebootJournal, sourceFingerprint: summary.flashback.sourceFingerprintBefore,
    ownerRecords: { flashback: summary.ownerReads.flashback.records, hayaku: summary.ownerReads.hayaku.records, libra: summary.ownerReads.libra.records }, lia: summary.ownerReads.lia }));
}
console.log('retrace_gui_public_handoff_runtime_test: PASS (registered GUI, public four-owner handoff, exact readback, source invariant, restart)');
