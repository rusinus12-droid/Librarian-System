'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  const start = source.indexOf('    const scheduleMicroForTurn = (scope, worldlineId, sessionEpoch, turn, revisionId, request={}) => {');
  const end = source.indexOf('     const microStageRequest = async request => {', start);
  assert.ok(start >= 0 && end > start, 'scheduleMicroForTurn region found');

  const calls = [];
  let attempt = 0;
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
    setTimeout,
    assertPortableMemoryIdle: () => {},
    persistKnownPersonSpanInventory: async () => {},
    reanalyzeMicroSource: async () => ({ status: 'verified' }),
    produceMicroForTurn: async (_s, _w, _e, _t, _r, req) => {
      calls.push({ manual: req.manual === true, retryNotDurablyReady: req.retryNotDurablyReady === true, reason: req.reason || '' });
      attempt += 1;
      if (attempt === 1) return { status: 'pending_reconciliation', reason: 'micro_result_not_durably_ready' };
      return { status: 'verified', record: { analysisStatus: 'verified' } };
    },
    admitPublishedMicroStateClaims: async () => ({ ok: true }),
    shouldUpdateLastMicroPublication: () => true,
    string: v => String(v ?? ''),
    clone: v => JSON.parse(JSON.stringify(v)),
    compact: v => String(v ?? ''),
    scheduleCurrentStateSnapshotRefresh: () => {},
    repairMicroGapsAfterPublication: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.scheduleMicroForTurn = scheduleMicroForTurn;', context);

  const first = await context.scheduleMicroForTurn({ scopeKey: 's1' }, 'main', 0, 15, 'rev1', {});
  assert.equal(first.status, 'pending_reconciliation');
  assert.equal(first.reason, 'micro_result_not_durably_ready');

  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(calls.length, 2, 'schedules one automatic retry after micro_result_not_durably_ready');
  assert.equal(calls[1].manual, true);
  assert.equal(calls[1].retryNotDurablyReady, true);
  assert.equal(context.state.lastMicroPublication.status, 'verified');
  console.log('PASS libra_micro_not_durably_ready_retry_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
