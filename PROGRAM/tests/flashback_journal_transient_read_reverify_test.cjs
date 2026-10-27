'use strict';
// A slow/failed startup journal read used to leave every repair refused with
// FLASHBACK_PHYSICAL_OUTCOME_UNRESOLVED until reload, even with no journal at all.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const key = 'vector_rag_memory:maintenance_journal:v1';

test('a transient startup journal read failure is re-verified instead of blocking repairs', async () => {
  let reads = 0;
  const values = new Map();
  const pluginStorage = { values,
    async getItem(k) { if (k === key && ++reads === 1) throw Error('TRANSIENT_STARTUP_TIMEOUT'); return values.get(k) ?? null; },
    async setItem(k, v) { values.set(k, v); return true; },
    async removeItem(k) { values.delete(k); return true; },
    async keys() { return [...values.keys()]; } };
  const h = await createFlashback(PROGRAM, { pluginStorage });
  try {
    assert.equal(h.audit.Runtime.maintenanceJournalReadUnverified, true, 'the startup read failed');
    let error;
    try { await h.api.runMemoryMaintenance('sync', { preflight: { inspection: { coverage: 'server_snapshot' } } }); } catch (e) { error = e; }
    assert.notEqual(error?.code, 'FLASHBACK_PHYSICAL_OUTCOME_UNRESOLVED', 'an absent journal no longer blocks after re-verification');
    assert.equal(h.audit.Runtime.maintenanceJournalReadUnverified, false);
    assert.equal(h.networkCalls.length, 0);
  } finally { await h.cleanup(); }
});
