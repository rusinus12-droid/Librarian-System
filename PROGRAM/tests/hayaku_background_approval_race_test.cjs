'use strict';
// Execute the actual async confirmation/decision functions with a serialized,
// durable journal fixture. Mutations occur at the same await boundaries as the review.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
const slice = (a, b) => { const i = source.indexOf(a), j = source.indexOf(b, i + a.length); assert(i >= 0 && j > i); return source.slice(i, j); };
function fixture(hooks = {}) {
  let record = { recordId: 'debt', scopeKey: 'scope', pairIndex: 1, worldlineStatus: 'active', backgroundDecision: 'pending', backgroundPromptedAt: 0,
    afterRequestRepair: { attempted: false, outcome: 'evidence_unavailable' } };
  let tail = Promise.resolve(), inspection = 0, prompts = 0, sweeps = 0, resolution;
  const Memory = { settings: { afterRequestAutoRepair: true, backgroundAutoRepair: true }, nativeRecovery: {}, ledgerViewer: {} };
  const f = { Memory, current: () => record, failRepair() { record.afterRequestRepair = { attempted: true, outcome: 'failed_journal_required' }; record.failedAnalysisId = 'failed-1'; },
    get prompts() { return prompts; }, get sweeps() { return sweeps; }, async settled() { if (resolution) return await resolution; } };
  const c = vm.createContext({ Memory, text: v => String(v ?? ''), compact: v => String(v ?? ''), clone: structuredClone, now: Date.now,
    ensureArray: v => Array.isArray(v) ? v : [], NATIVE_JOB_TERMINAL_STATES: new Set(), RECOVERY_CONFIRMATION_OVERLAY_ID: 'ui',
    loadSettings: async () => {}, normalizeRecoveryVaultRecord: value => structuredClone(value),
    enqueueStorageOperation: operation => { const result = tail.then(operation); tail = result.catch(() => {}); return result; },
    loadRecoveryVault: async () => ({ records: [structuredClone(record)] }),
    writeRecoveryVaultDirect: async (_scope, vault, reason) => { record = structuredClone(vault.records[0]); await hooks.write?.(f, reason); return { durable: true }; },
    inspectRecoveryDebtsForNativeRepair: async () => { await hooks.inspect?.(f, ++inspection); return { available: true, scopeKey: 'scope', debts: [{ debtId: 'debt' }], coverage: { missingTurns: [1], rows: [{ turn: 1, sourceDigest: 'source' }] } }; },
    inBandRecoveryPendingForDebt: () => false, nativeRepairTargetFingerprint: () => 'same-source',
    beginNativeJob() {}, finishNativeJob() {}, updateNativeJob() {}, pushOperationLog() {}, viewerRenderNativeJob() {}, refreshLedgerViewer: async () => {},
    RisuCompat: { currentChatScope: async () => ({ confident: true, key: 'scope' }) },
    runNativeRepairSweep: async () => { sweeps++; return { ok: true }; },
    showIndependentRecoveryConfirmation: async () => { prompts++; return true; }, viewerSetStatusMessage() {}
  });
  vm.runInContext(slice('  const updateRecoveryJournalBackgroundDecision =', '  const upsertRecoveryVaultEvidence =')
    + slice('  const recoveryJournalAutoApproved =', '  let recoveryConfirmationResolution =')
    + '\nglobalThis.update = updateRecoveryJournalBackgroundDecision; globalThis.resolve = resolveRecoveryJournalBackgroundConfirmationOnce;', c);
  c.resolveRecoveryJournalBackgroundConfirmation = accepted => (resolution = c.resolve(accepted));
  return Object.assign(f, { update: (decision, patch) => c.update('scope', 'debt', decision, patch), resolve: accepted => c.resolve(accepted),
    confirm: () => { Memory.ledgerViewer.recoveryConfirmation = { scopeKey: 'scope', debtId: 'debt', pairIndex: 1, targetFingerprint: 'same-source' }; } });
}

// Background repair and its dialog are retired. The durable decision fences stay,
// and an explicit confirmation (set by the host/tests) still runs one repair.
test('automatic approval is always refused and leaves the journal untouched', async () => {
  const f = fixture();
  const result = await f.update('approved', { requireAutoApproval: true });
  assert.equal(result.reason, 'recovery_journal_auto_approval_changed');
  assert.equal(f.current().backgroundDecision, 'pending');
});

test('a prompt cannot be claimed when background repair is off', async () => {
  const f = fixture(); f.Memory.settings.backgroundAutoRepair = false;
  assert.equal((await f.update('pending', { promptedAt: Date.now(), claimPrompt: true })).reason, 'recovery_journal_prompt_changed');
  assert.equal(Number(f.current().backgroundPromptedAt || 0), 0);
});

test('resolving without a confirmation does nothing', async () => {
  const f = fixture();
  assert.equal((await f.resolve(true)).reason, 'recovery_confirmation_absent');
  assert.equal(f.sweeps, 0);
});

test('an explicit confirmation still runs exactly one repair', async () => {
  const f = fixture(); f.confirm();
  await f.resolve(true);
  assert.equal(f.sweeps, 1);
  assert.equal(f.current().backgroundDecision, 'completed');
});
