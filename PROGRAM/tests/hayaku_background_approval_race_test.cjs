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
    + '\nglobalThis.request = requestRecoveryJournalBackgroundConfirmationOnce; globalThis.resolve = resolveRecoveryJournalBackgroundConfirmationOnce;', c);
  c.resolveRecoveryJournalBackgroundConfirmation = accepted => (resolution = c.resolve(accepted));
  return Object.assign(f, { request: () => c.request(structuredClone(record)), resolve: accepted => c.resolve(accepted) });
}

test('repair failure during debt inspection uses the current journal and asks for consent', async () => {
  const f = fixture({ inspect(f, n) { if (n === 1) f.failRepair(); } });
  assert.equal(await f.request(), true); await f.settled();
  assert.equal(f.prompts, 1); assert.equal(f.sweeps, 0);
  assert.equal(f.Memory.ledgerViewer.recoveryConfirmation.autoApproved, false);
  await f.resolve(true); assert.equal(f.sweeps, 1, 'explicit consent still permits a retry');
});

for (const boundary of ['prompt_write', 'approval_inspection']) test(`late failure at ${boundary} revokes automatic approval`, async () => {
  const f = fixture({
    write(f, reason) { if (boundary === 'prompt_write' && reason === 'recovery_journal_background_pending') f.failRepair(); },
    inspect(f, n) { if (boundary === 'approval_inspection' && n === 2) f.failRepair(); }
  });
  assert.equal(await f.request(), true);
  const result = await f.settled();
  assert.equal(result.reason, 'recovery_journal_auto_approval_changed');
  assert.equal(f.sweeps, 0); assert.equal(f.current().backgroundDecision, 'pending');
  assert.equal(f.Memory.ledgerViewer.recoveryConfirmation, null);
});

test('consent disabled during inspection cannot claim an automatic prompt', async () => {
  const f = fixture({ inspect(f) { f.Memory.settings.backgroundAutoRepair = false; } });
  assert.equal(await f.request(), false); assert.equal(f.sweeps, 0); assert.equal(f.prompts, 0);
});

test('eligible skipped repair runs once and repeated stale prompt cannot reclaim it', async () => {
  const f = fixture(); assert.equal(await f.request(), true); await f.settled();
  assert.equal(f.sweeps, 1); assert.equal(f.prompts, 0);
  assert.equal(await f.request(), false); assert.equal(f.sweeps, 1);
});
