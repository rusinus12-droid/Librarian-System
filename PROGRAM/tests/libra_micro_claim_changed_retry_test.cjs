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
    produceMicroForTurn: async (_s, _w, _e, _t, rev, req) => {
      calls.push({ rev, manual: req.manual === true, retryClaimChanged: req.retryClaimChanged === true });
      if (rev === 'rev1') return { status: 'stale_source', reason: 'micro_publish_claim_changed' };
      return { status: 'verified', record: { analysisStatus: 'verified' } };
    },
    readActiveCompletedTurnReceipt: async () => ({ status: 'verified', receipt: { revisionId: 'rev2' } }),
    readActiveMicroMemory: async () => ({ status: 'missing' }),
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

  const first = await context.scheduleMicroForTurn({ scopeKey: 's1' }, 'main', 0, 18, 'rev1', {});
  assert.equal(first.status, 'stale_source');
  assert.equal(first.reason, 'micro_publish_claim_changed');

  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(calls.length, 2, 'schedules retry for active revision rev2 after micro_publish_claim_changed');
  assert.equal(calls[1].rev, 'rev2');
  assert.equal(calls[1].manual, true);
  assert.equal(calls[1].retryClaimChanged, true);
  assert.equal(context.state.lastMicroPublication.status, 'verified');
  console.log('PASS libra_micro_claim_changed_retry_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
