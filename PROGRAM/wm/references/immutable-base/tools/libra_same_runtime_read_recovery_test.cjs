'use strict';
// Artifact-level regression: same bytes may be a fresh proof after a failed read.
// Removing the verified unchanged-view refresh must make both recovery cases fail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./libra_pending_ownership_test.cjs');
const checks = [];
const files = process.env.WM_RECOVERY_VARIANT === 'min' ? ['LIBRA World Manager.js']
  : process.env.WM_RECOVERY_VARIANT === 'full' ? ['LIBRA World Manager Full.js']
    : ['LIBRA World Manager Full.js', 'LIBRA World Manager.js'];
const canonicalWrites = f => f.calls.writes.filter(row => row.key.startsWith('LIBRA_DATA::')).length;
const diagnostics = f => f.api.LibraDataStorage.getHydrationDiagnostics(f.api.LibraDataStorage.scopeKeyFor(f.control.char, f.control.chat));
const activate = (f, options) => f.api.PersonaRuntimeCoordinator.activate({ char: f.control.char, chat: f.control.chat }, options);
async function markReadUnavailable(f) {
  f.control.failReads = true;
  const failed = await f.api.LibraDataStorage.preparePersonaContext(f.control.char, f.control.chat);
  assert.equal(failed.reason, 'canonical_read_unavailable');
  assert.equal(diagnostics(f).readOnly, true);
  f.control.failReads = false;
}
async function check(file, name, run) {
  let f;
  try { f = await fixture(file); const detail = await run(f); checks.push({ file, name, ok: true, detail }); }
  catch (error) { checks.push({ file, name, ok: false, error: error.stack }); }
  finally { f?.close(); if (global.gc) global.gc(); }
}
(async () => {
  for (const file of files) {
    for (const existing of [false, true]) await check(file, `recovered ${existing ? 'nonempty' : 'missing'} canonical read refreshes permission without replacing runtime owners`, async f => {
      let first = 1;
      if (existing) {
        const seed = await f.add(first++);
        assert.equal((await f.commit(seed.pending)).status, 'finalized');
        assert((await activate(f)).ok);
      }
      const head = await f.add(first), tail = await f.add(first + 1);
      const originals = [head, tail].map(entry => [entry.handle.recordKey, f.store.get(entry.handle.recordKey)]);
      const before = {
        raw: f.store.get(f.key), writes: canonicalWrites(f), version: f.api.MemoryState.initVersion,
        session: f.api.MemoryState.currentSessionId, active: f.api.MemoryState._activeScopeKey,
        pendingMap: f.api.MemoryState.pendingTurnCommits, lease: f.api.RuntimeStateLease.capture(),
        headJson: JSON.stringify(head.pending), tailJson: JSON.stringify(tail.pending),
        timers: [...f.api.MemoryState.pendingFinalizeRetryTimersByScope]
      };
      await markReadUnavailable(f);
      const admitted = await f.api.LibraDataStorage.preparePersonaContext(f.control.char, f.control.chat);
      assert(admitted.ok, 'restored strict admission succeeds');
      assert.equal(diagnostics(f).readOnly, true, 'admission alone cannot publish write authority');
      const restored = await activate(f);
      assert.equal(restored.ok, true);
      assert.equal(restored.activated, false, 'same canonical bytes must not reload the runtime');
      assert.equal(diagnostics(f).readOnly, false, 'verified unchanged activation refreshes stale read-only guard');
      assert.deepEqual(Array.from(diagnostics(f).reasons), []);
      assert.equal(f.api.MemoryState.initVersion, before.version);
      assert.equal(f.api.MemoryState.currentSessionId, before.session);
      assert.equal(f.api.MemoryState._activeScopeKey, before.active);
      assert.equal(f.api.MemoryState.pendingTurnCommits, before.pendingMap);
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat), head.pending);
      assert.equal(JSON.stringify(head.pending), before.headJson);
      assert.equal(JSON.stringify(tail.pending), before.tailJson);
      assert(f.api.RuntimeStateLease.isCurrent(before.lease));
      for (const [key, timer] of before.timers) assert.equal(f.api.MemoryState.pendingFinalizeRetryTimersByScope.get(key), timer);
      assert.equal(canonicalWrites(f), before.writes, 'read recovery does not write canonical storage');
      assert.equal(f.store.get(f.key), before.raw);
      assert.equal((await f.commit(head.pending)).turn, first);
      assert.equal((await f.commit(tail.pending)).turn, first + 1);
      assert(originals.every(([key, value]) => f.store.get(key) === value), 'raw receipts remain immutable');
      const rows = f.api.TurnRecordLedger.loadState(f.api.MemoryEngine.getLorebook(f.control.char, f.control.chat), f.control.chat, f.control.char).records;
      assert.deepEqual(Array.from(rows, row => [row.turn, row.liveMessageIds[0]]), Array.from({ length: first + 1 }, (_, i) => [i + 1, 'queue-a-' + (i + 1)]));
      return { existingCanonical: existing, recoveredWithoutWrite: true, ownerAndLeasePreserved: true, committed: first + 1 };
    });
    for (const mode of ['unavailable', 'invalid-envelope', 'foreign-entry', 'tampered-integrity', 'reset-generation', 'persona-change', 'runtime-reset', 'view-dismissed', 'canonical-changed', 'late-read-failure', 'transaction-busy']) {
      await check(file, `read-only recovery cannot bypass ${mode}`, async f => {
        const seed = await f.add(1); assert.equal((await f.commit(seed.pending)).status, 'finalized');
        assert((await activate(f)).ok);
        await markReadUnavailable(f);
        const scope = f.api.LibraDataStorage.scopeKeyFor(f.control.char, f.control.chat);
        const canonical = f.store.get(f.key), beforeWrites = canonicalWrites(f);
        let count = 0, token = null;
        if (mode === 'unavailable') f.control.failReads = true;
        if (mode === 'invalid-envelope') f.store.set(f.key, JSON.stringify({ scopeKey: 'foreign', entries: [] }));
        if (mode === 'foreign-entry') {
          const payload = JSON.parse(canonical);
          payload.entries.push({ key: 'foreign', comment: 'lmai_turn_ledger', content: JSON.stringify({ scopeKey: 'foreign-runtime', chatId: 'fixture-chat' }) });
          f.store.set(f.key, JSON.stringify(payload));
        }
        if (mode === 'tampered-integrity') {
          const payload = JSON.parse(canonical);
          const record = { id: 'tampered', name: 'Tampered', background: { occupation: 'Original' }, meta: { created: 1, updated: 1 } };
          f.api.IntegrityMetaManager.applyIntegrityMeta(record, { domain: 'entity', scopeKey: f.api.MemoryState._activeScopeKey, recordId: record.name, turn: 1 });
          record.background.occupation = 'Changed after signing';
          payload.entries.push({ key: 'tampered', comment: 'lmai_entity', content: JSON.stringify(record) });
          f.store.set(f.key, JSON.stringify(payload));
        }
        if (mode === 'reset-generation') f.control.afterRead = async () => { if (++count === 1) { const next = JSON.parse(canonical); next.resetGeneration = 1; f.store.set(f.key, JSON.stringify(next)); } };
        if (mode === 'persona-change') f.control.afterRead = async () => { if (++count === 1) f.control.chat.bindedPersona = 'persona-b'; };
        if (mode === 'runtime-reset') f.control.afterRead = async () => { if (++count === 1) f.api.MemoryState.reset(); };
        if (mode === 'canonical-changed') f.control.afterRead = async () => { if (++count === 4) { const next = JSON.parse(canonical); next.updatedAt = 999; f.store.set(f.key, JSON.stringify(next)); } };
        if (mode === 'late-read-failure') f.control.afterRead = async () => { if (++count === 3) throw new Error('synthetic late read unavailable'); };
        if (mode === 'transaction-busy') token = f.api.ScopedRuntimeTransaction.begin(f.api.MemoryState._activeScopeKey, 'recovery-negative-owner');
        let result;
        try { result = await activate(f, mode === 'view-dismissed' ? { isViewCurrent: () => false } : {}); }
        finally { if (token) { assert(f.api.ScopedRuntimeTransaction.owns(token)); f.api.ScopedRuntimeTransaction.end(token); } }
        assert.equal(result.ok, false, mode + ' must reject recovery');
        assert.equal(f.api.LibraDataStorage.getHydrationDiagnostics(scope).readOnly, true, 'failed validation cannot clear guard');
        assert.equal(canonicalWrites(f), beforeWrites, 'rejected recovery cannot write canonical storage');
        if (mode === 'canonical-changed') assert(count >= 4, 'revision race must be reached');
        return { reason: result.reason, readOnly: true, canonicalWrites: 0 };
      });
    }
  }
  const summary = { passed: checks.filter(row => row.ok).length, failed: checks.filter(row => !row.ok).length, realModelCalls: 0, blockedTransportAttempts: globalThis.__finalDeliveryTransportAttempts || [], checks };
  const dir = path.resolve(__dirname, '../verification/same-runtime-recovery'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, (process.env.WM_RECOVERY_PHASE || 'result') + '-' + (process.env.WM_RECOVERY_VARIANT || 'both') + '.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.failed ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
