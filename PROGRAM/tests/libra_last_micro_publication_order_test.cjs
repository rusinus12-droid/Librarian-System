'use strict';
// lastMicroPublication: an older turn's background gap repair must not overwrite a newer
// publication, but every other job reports, so a chat rolled back to an earlier turn
// shows that turn instead of staying on the old, higher one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  const start = source.indexOf('    const shouldUpdateLastMicroPublication = ');
  const end = source.indexOf('     const microStageRequest = async request => {', start);
  assert.ok(start >= 0 && end > start, 'publication region found');

  const context = {
    state: {
      disposed: false,
      deletingScopes: new Set(),
      portableMemoryActiveOperationId: '',
      microJobs: new Map(),
      microQueues: new Map(),
      lastMicroPublication: null
    },
    MICRO_QUEUE_CAPACITY: 64,
    setTimeout: () => 0,
    assertPortableMemoryIdle: () => {},
    persistKnownPersonSpanInventory: async () => {},
    reanalyzeMicroSource: async () => ({ status: 'verified' }),
    produceMicroForTurn: async () => ({ status: 'verified', record: { analysisStatus: 'verified' } }),
    readActiveCompletedTurnReceipt: async () => ({ status: 'missing' }),
    readActiveMicroMemory: async () => ({ status: 'missing' }),
    admitPublishedMicroStateClaims: async () => ({ ok: true }),
    string: v => String(v ?? ''),
    clone: v => JSON.parse(JSON.stringify(v)),
    compact: v => String(v ?? ''),
    scheduleCurrentStateSnapshotRefresh: () => {},
    repairMicroGapsAfterPublication: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.scheduleMicroForTurn = scheduleMicroForTurn;', context);
  const run = (turn, request = {}) => context.scheduleMicroForTurn({ scopeKey: 's1' }, 'main', 0, turn, 'rev' + turn, request);

  await run(10);
  assert.equal(context.state.lastMicroPublication.turn, 10);
  await run(4, { manual: true, reason: 'micro_gap_repair' });
  assert.equal(context.state.lastMicroPublication.turn, 10, 'an older gap repair does not overwrite the newer publication');
  await run(5, { manual: true, reason: 'receipt_gap_repair' });
  assert.equal(context.state.lastMicroPublication.turn, 10, 'an older receipt_gap_repair does not overwrite the newer publication');
  await run(12, { manual: true, reason: 'micro_gap_repair' });
  assert.equal(context.state.lastMicroPublication.turn, 12, 'a newer gap repair reports');
  await run(13, { manual: true, reason: 'receipt_gap_repair' });
  assert.equal(context.state.lastMicroPublication.turn, 13, 'a newer receipt_gap_repair reports');
  await run(6);
  assert.equal(context.state.lastMicroPublication.turn, 6, 'after a rollback the current turn reports even though it is lower');
  await run(5, { manual: true, reason: 'receipt_gap_repair' });
  assert.equal(context.state.lastMicroPublication.turn, 6, 'an older receipt_gap_repair after rollback still does not overwrite the newer publication');
  console.log('PASS libra_last_micro_publication_order_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
