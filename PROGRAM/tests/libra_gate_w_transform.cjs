'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const TRANSFORM_ID = 'libra.gate_w.transform.v1';

const countExact = (source, anchor) => {
  let count = 0;
  let cursor = 0;
  while ((cursor = source.indexOf(anchor, cursor)) !== -1) {
    count += 1;
    cursor += anchor.length;
  }
  return count;
};

const replaceExactOnce = (source, anchor, replacement, label) => {
  const count = countExact(source, anchor);
  if (count !== 1) throw new Error(`${label}: expected exact anchor count=1, actual=${count}`);
  return source.replace(anchor, replacement);
};

const journalBlock = `
    /* LIBRA STATE TRACKING JOURNAL START */
    const stateTrackingEnvelopeProjection = value => ({
      schema: string(value?.schema || ''),
      scopeKey: string(value?.scopeKey || ''),
      worldlineId: string(value?.worldlineId || 'main'),
      memoryId: string(value?.memoryId || ''),
      revision: Number(value?.revision || 0),
      turnRange: clone(asObject(value?.turnRange)),
      sourceDigest: string(value?.sourceDigest || ''),
      artifactDigest: string(value?.artifactDigest || ''),
      memoryKey: string(value?.memoryKey || ''),
      status: string(value?.status || '')
    });
    const stateTrackingJournalIdentity = envelopeValue => digest(stateTrackingEnvelopeProjection(envelopeValue));
    const normalizeStateTrackingJournalEntry = value => {
      const source = asObject(value);
      const envelope = stateTrackingEnvelopeProjection(source.envelope || source);
      if (envelope.schema !== CANONICAL_COMMIT_SCHEMA || envelope.status !== 'committed'
        || !envelope.scopeKey || !envelope.memoryKey || !envelope.memoryId || envelope.revision < 1
        || !envelope.sourceDigest || !envelope.artifactDigest) return null;
      const identityDigest = stateTrackingJournalIdentity(envelope);
      if (source.identityDigest && string(source.identityDigest) !== identityDigest) return null;
      const stateValue = ['scheduled', 'running', 'pending', 'completed', 'stale'].includes(string(source.state || ''))
        ? string(source.state) : 'scheduled';
      return {
        schema: STATE_TRACKING_JOURNAL_ENTRY_SCHEMA,
        jobId: string(source.jobId || ('state_track_' + identityDigest.slice(0, 24))),
        scopeKey: envelope.scopeKey,
        identityDigest,
        envelope,
        state: stateValue,
        attempts: Math.max(0, Number(source.attempts || 0) || 0),
        lastAttemptBootedAt: Math.max(0, Number(source.lastAttemptBootedAt || 0) || 0),
        receiptKey: string(source.receiptKey || ''),
        receiptDigest: string(source.receiptDigest || ''),
        headFingerprint: string(source.headFingerprint || ''),
        replayFingerprint: string(source.replayFingerprint || ''),
        reason: compact(source.reason || '', 700),
        error: compact(source.error || '', 700),
        createdAt: string(source.createdAt || nowIso()),
        updatedAt: string(source.updatedAt || source.createdAt || nowIso()),
        completedAt: string(source.completedAt || ''),
        staleAt: string(source.staleAt || '')
      };
    };
    const stateTrackingJournalDefaultStore = scope => ({
      schema: STATE_TRACKING_JOURNAL_SCHEMA,
      scopeKey: string(scope?.scopeKey || ''),
      revision: 0,
      entries: [],
      updatedAt: ''
    });
    const loadStateTrackingJournal = async scope => {
      const loaded = await storage.getJson(key.stateTrackingJournal(scope), null);
      if (loaded == null) return stateTrackingJournalDefaultStore(scope);
      if (loaded?.schema !== STATE_TRACKING_JOURNAL_SCHEMA
        || string(loaded.scopeKey || '') !== string(scope?.scopeKey || '')) throw new Error('state_tracking_journal_invalid');
      const rawEntries = asArray(loaded.entries);
      const entries = rawEntries.map(normalizeStateTrackingJournalEntry);
      if (entries.some(entry => !entry)) throw new Error('state_tracking_journal_entry_invalid');
      const identities = entries.map(entry => entry.identityDigest);
      if (new Set(identities).size !== identities.length) throw new Error('state_tracking_journal_duplicate_identity');
      return {
        ...stateTrackingJournalDefaultStore(scope),
        ...clone(loaded),
        entries,
        revision: Math.max(0, Number(loaded.revision || 0) || 0)
      };
    };
    const saveStateTrackingJournal = async (scope, value) => {
      const previous = asObject(value);
      const normalizedEntries = asArray(previous.entries).map(normalizeStateTrackingJournalEntry);
      if (normalizedEntries.some(entry => !entry)) throw new Error('state_tracking_journal_entry_invalid');
      const next = {
        schema: STATE_TRACKING_JOURNAL_SCHEMA,
        scopeKey: string(scope?.scopeKey || ''),
        revision: Math.max(0, Number(previous.revision || 0) || 0) + 1,
        entries: normalizedEntries
          .sort((left, right) => Date.parse(left.createdAt || '') - Date.parse(right.createdAt || ''))
          .slice(-STATE_TRACKING_JOURNAL_MAX_ENTRIES),
        updatedAt: nowIso()
      };
      const storageKey = key.stateTrackingJournal(scope);
      await storage.setJson(storageKey, next);
      const readback = await storage.getJson(storageKey, null);
      if (digest(readback) !== digest(next)) throw new Error('state_tracking_journal_readback_failed');
      return clone(readback);
    };
    const scheduleStateTrackingJournalEntry = async ({ scope, envelope } = {}) => {
      const normalized = normalizeStateTrackingJournalEntry({ envelope, state: 'scheduled' });
      if (!normalized || normalized.scopeKey !== string(scope?.scopeKey || '')) throw new Error('state_tracking_journal_schedule_invalid');
      const store = await loadStateTrackingJournal(scope);
      const existing = store.entries.find(entry => entry.identityDigest === normalized.identityDigest);
      if (existing) return clone(existing);
      const saved = await saveStateTrackingJournal(scope, { ...store, entries: [...store.entries, normalized] });
      const readback = saved.entries.find(entry => entry.identityDigest === normalized.identityDigest);
      if (!readback) throw new Error('state_tracking_journal_schedule_readback_failed');
      return clone(readback);
    };
    const updateStateTrackingJournalEntry = async ({ scope, identityDigest, patch = {} } = {}) => {
      const expected = string(identityDigest || '');
      const store = await loadStateTrackingJournal(scope);
      const index = store.entries.findIndex(entry => entry.identityDigest === expected);
      if (index < 0) throw new Error('state_tracking_journal_entry_missing');
      const current = store.entries[index];
      const next = normalizeStateTrackingJournalEntry({
        ...current,
        ...clone(asObject(patch)),
        envelope: current.envelope,
        identityDigest: current.identityDigest,
        jobId: current.jobId,
        scopeKey: current.scopeKey,
        updatedAt: nowIso()
      });
      if (!next || next.identityDigest !== expected) throw new Error('state_tracking_journal_entry_update_invalid');
      store.entries[index] = next;
      const saved = await saveStateTrackingJournal(scope, store);
      const readback = saved.entries.find(entry => entry.identityDigest === expected);
      if (!readback || readback.state !== next.state || digest(readback.envelope) !== digest(next.envelope)) {
        throw new Error('state_tracking_journal_entry_update_readback_failed');
      }
      return clone(readback);
    };
    const stateTrackingResultComplete = result => result?.continuityRequired === false
      || result?.reason === 'state_tracking_disabled'
      || result?.reason === 'already_reviewed'
      || ['complete', 'not_required'].includes(string(result?.receipt?.status || ''));
    const finishStateTrackingJournalAttempt = async ({ scope, entry, result = null, error = null, rebuild = null } = {}) => {
      const complete = stateTrackingResultComplete(result) || (rebuild?.ok === true && !!rebuild?.head);
      const receipt = asObject(result?.receipt);
      return await updateStateTrackingJournalEntry({
        scope,
        identityDigest: entry.identityDigest,
        patch: {
          state: complete ? 'completed' : 'pending',
          receiptKey: string(result?.receiptKey || ''),
          receiptDigest: string(receipt.receiptDigest || ''),
          headFingerprint: result?.head ? statePipelineHeadFingerprint(result.head) : (rebuild?.head ? statePipelineHeadFingerprint(rebuild.head) : ''),
          replayFingerprint: string(rebuild?.replayFingerprint || ''),
          reason: complete ? string(result?.reason || rebuild?.reason || 'state_tracking_completed')
            : string(result?.reason || rebuild?.reason || 'state_tracking_pending'),
          error: error ? compact(error?.message || error, 700) : '',
          completedAt: complete ? nowIso() : ''
        }
      });
    };
    const recoverPendingStateTrackingJournal = async (contextValue, options = {}) => {
      const scope = asObject(contextValue?.scope);
      const scopeKey = string(scope.scopeKey || '');
      const diagnostic = {
        schema: STATE_TRACKING_JOURNAL_SCHEMA,
        scopeKey,
        at: Date.now(),
        attempted: 0,
        recovered: 0,
        pending: 0,
        stale: 0,
        skippedThisBoot: 0,
        entries: []
      };
      if (!scopeKey) return { ...diagnostic, ok: false, reason: 'scope_unavailable' };
      const bootedAt = Math.max(0, Number(Runtime.bootedAt || 0) || 0);
      return await enqueue(scopeKey, async () => {
        const liveContext = await resolveContext();
        if (string(liveContext?.scope?.scopeKey || '') !== scopeKey) return { ...diagnostic, ok: false, reason: 'scope_changed' };
        let store = await loadStateTrackingJournal(liveContext.scope);
        const candidates = store.entries.filter(entry => ['scheduled', 'running', 'pending'].includes(entry.state));
        for (const candidate of candidates) {
          if (options.force !== true && bootedAt > 0 && Number(candidate.lastAttemptBootedAt || 0) === bootedAt) {
            diagnostic.skippedThisBoot += 1;
            diagnostic.entries.push({ identityDigest: candidate.identityDigest, state: candidate.state, reason: 'already_attempted_this_boot' });
            continue;
          }
          const verified = await verifyCanonicalCommitEnvelope({ context: liveContext, envelope: candidate.envelope });
          if (!verified.ok) {
            const stale = await updateStateTrackingJournalEntry({
              scope: liveContext.scope,
              identityDigest: candidate.identityDigest,
              patch: { state: 'stale', reason: verified.reason || 'state_tracking_identity_stale', staleAt: nowIso(), error: '' }
            });
            diagnostic.stale += 1;
            diagnostic.entries.push({ identityDigest: stale.identityDigest, state: stale.state, reason: stale.reason });
            continue;
          }
          let running = await updateStateTrackingJournalEntry({
            scope: liveContext.scope,
            identityDigest: candidate.identityDigest,
            patch: {
              state: 'running',
              attempts: Number(candidate.attempts || 0) + 1,
              lastAttemptBootedAt: bootedAt,
              reason: 'startup_resume',
              error: ''
            }
          });
          diagnostic.attempted += 1;
          let result = null;
          let rebuild = null;
          let failure = null;
          try {
            const settings = await loadSettings();
            if (settings?.stateTracking?.enabled !== true) {
              result = await runStateTrackingAfterCommit({ context: liveContext, envelope: running.envelope });
            } else {
              const pairs = buildPairs(liveContext.chat, liveContext?.scope?.scopeKey || '');
              const meta = await loadStateWorldlineMeta(liveContext.scope, { strict: true });
              if (string(meta.activeWorldlineId || 'main') !== string(running.envelope.worldlineId || 'main')) {
                const staleError = new Error('state_tracking_recovery_worldline_stale');
                staleError.code = 'STATE_TRACKING_STALE_IDENTITY';
                throw staleError;
              }
              const boundaryFingerprint = stateReplayBoundaryFingerprint({
                scope: liveContext.scope,
                manifest: verified.manifest,
                meta,
                worldlineId: running.envelope.worldlineId
              });
              rebuild = await rebuildCurrentStateForWorldlineUnlocked({
                context: liveContext,
                manifest: verified.manifest,
                pairs,
                worldlineId: running.envelope.worldlineId,
                reason: 'state_tracking_startup_resume',
                persist: true,
                requiredBoundaryFingerprint: boundaryFingerprint
              });
            }
          } catch (error) {
            failure = error;
          }
          if (failure?.code === 'STATE_TRACKING_STALE_IDENTITY') {
            running = await updateStateTrackingJournalEntry({
              scope: liveContext.scope,
              identityDigest: running.identityDigest,
              patch: { state: 'stale', reason: failure.message, staleAt: nowIso(), error: '' }
            });
            diagnostic.stale += 1;
          } else {
            running = await finishStateTrackingJournalAttempt({ scope: liveContext.scope, entry: running, result, error: failure, rebuild });
            if (running.state === 'completed') diagnostic.recovered += 1;
            else diagnostic.pending += 1;
          }
          diagnostic.entries.push({ identityDigest: running.identityDigest, state: running.state, reason: running.reason, error: running.error });
        }
        store = await loadStateTrackingJournal(liveContext.scope);
        diagnostic.remaining = store.entries.filter(entry => ['scheduled', 'running', 'pending'].includes(entry.state)).length;
        diagnostic.ok = diagnostic.pending === 0;
        diagnostic.reason = diagnostic.remaining ? 'state_tracking_recovery_pending' : 'state_tracking_recovery_settled';
        return clone(diagnostic);
      });
    };
    /* LIBRA STATE TRACKING JOURNAL END */

`.slice(1);

const applyGateWTransform = sourceValue => {
  let source = String(sourceValue || '');

  source = replaceExactOnce(
    source,
    "    const STATE_PIPELINE_RECEIPT_SCHEMA = 'libra.state_pipeline_receipt.v1';\n",
    "    const STATE_PIPELINE_RECEIPT_SCHEMA = 'libra.state_pipeline_receipt.v1';\n"
      + "    const STATE_TRACKING_JOURNAL_SCHEMA = 'libra.state_tracking_journal.v1';\n"
      + "    const STATE_TRACKING_JOURNAL_ENTRY_SCHEMA = 'libra.state_tracking_journal_entry.v1';\n"
      + "    const STATE_TRACKING_JOURNAL_MAX_ENTRIES = 64;\n",
    'gate-w constants'
  );

  source = replaceExactOnce(
    source,
    '      stateReplayErrors: scope => `${PREFIX}:scope:${scope.scopeKey}:state-replay-errors:v1`,\n',
    '      stateReplayErrors: scope => `${PREFIX}:scope:${scope.scopeKey}:state-replay-errors:v1`,\n'
      + '      stateTrackingJournal: scope => `${PREFIX}:scope:${scope.scopeKey}:state-tracking-journal:v1`,\n',
    'gate-w journal key'
  );

  source = replaceExactOnce(
    source,
    '    const recoverPendingLiveBoundaryAtStartup = async (context, options = {}) => {\n',
    journalBlock + '    const recoverPendingLiveBoundaryAtStartup = async (context, options = {}) => {\n',
    'gate-w journal runtime insertion'
  );

  source = replaceExactOnce(
    source,
`      state.pendingBoundaryRecoveryInFlight.add(scopeKey);
      try {
        const settings = await loadMemorySettings();
`,
`      state.pendingBoundaryRecoveryInFlight.add(scopeKey);
      try {
        try {
          diagnostic.stateTrackingRecovery = await recoverPendingStateTrackingJournal(context, { force: options.forceStateRecovery === true });
        } catch (error) {
          diagnostic.stateTrackingRecovery = { ok: false, reason: 'state_tracking_recovery_failed', error: compact(error?.message || error, 700) };
        }
        const settings = await loadMemorySettings();
`,
    'gate-w startup recovery ordering'
  );

  source = replaceExactOnce(
    source,
`          if (ref?.status === 'committed' && string(ref.sourceDigest || '') === sourceHash && ref.key) {
            const cleared = await clearPendingBoundaryAfterCommit({
`,
`          if (ref?.status === 'committed' && string(ref.sourceDigest || '') === sourceHash && ref.key) {
            if (Number(diagnostic.stateTrackingRecovery?.remaining || 0) > 0) {
              diagnostic.retryable = false;
              return finish('state_tracking_recovery_pending');
            }
            const cleared = await clearPendingBoundaryAfterCommit({
`,
    'gate-w committed marker retention'
  );

  source = replaceExactOnce(
    source,
`      await storage.setJson(key.entityRegistry(context.scope), registry);
      const registryReadback = await storage.getJson(key.entityRegistry(context.scope), null);
      if (registryReadback?.schema !== ENTITY_REGISTRY_SCHEMA || string(registryReadback.fingerprint || '') !== registry.fingerprint
        || digest(registryReadback) !== digest(registry)) throw new Error('entity_registry_readback_failed');
      let workingHead = await loadContinuityState(context.scope, stateManifest, { requireCurrent: false });
`,
`      let workingHead = await loadContinuityState(context.scope, stateManifest, { requireCurrent: false });
`,
    'gate-w defer Registry mutation'
  );

  source = replaceExactOnce(
    source,
`        return { domain, ...observed, verification: verifiedResult };
      }));
      const domainReceipts = [...blockedDomainReceipts];
`,
`        return { domain, ...observed, verification: verifiedResult };
      }));
      // Provider work remains request-local until the active Canonical ref and
      // State worldline are re-read. Reroll, rollback, adoption, copy, or handoff
      // changes discard late Observer results before any authoritative mutation.
      const mutationVerified = await verifyCanonicalCommitEnvelope({ context, envelope, replayRef });
      if (!mutationVerified.ok) return {
        ok: false,
        skipped: true,
        providerCalls: Number(entityAdmission.providerCalls || 0) + executions.reduce((sum, row) => sum + (row.status === 'fulfilled'
          ? Number(row.value?.receipt?.providerCalls || 0) + Number(row.value?.verification?.receipt?.providerCalls || 0) : 1), 0),
        reason: 'state_tracking_stale_before_mutation:' + mutationVerified.reason,
        authority: 'last_known_non_authoritative',
        envelope: clone(envelope)
      };
      await storage.setJson(key.entityRegistry(context.scope), registry);
      const registryReadback = await storage.getJson(key.entityRegistry(context.scope), null);
      if (registryReadback?.schema !== ENTITY_REGISTRY_SCHEMA || string(registryReadback.fingerprint || '') !== registry.fingerprint
        || digest(registryReadback) !== digest(registry)) throw new Error('entity_registry_readback_failed');
      const domainReceipts = [...blockedDomainReceipts];
`,
    'gate-w post-provider Canonical revalidation'
  );

  source = replaceExactOnce(
    source,
`        await storage.setJson(key.run(context.scope, run.runId), run);
        manifest.inFlight = null;
        await saveManifest(context.scope, manifest);
`,
`        await storage.setJson(key.run(context.scope, run.runId), run);
        manifest.inFlight = null;
        // Seal a durable State job before the canonical manifest pointer can
        // become visible. A reload between these writes can then classify the
        // orphan schedule as stale, while a reload after manifest durability
        // can resume the exact canonical identity.
        const canonicalCommitEnvelope = buildCanonicalCommitEnvelope({ context, memory, memoryKey, worldlineId: activeWorldlineId });
        let stateTrackingJournalEntry = await scheduleStateTrackingJournalEntry({
          scope: context.scope,
          envelope: canonicalCommitEnvelope
        });
        await saveManifest(context.scope, manifest);
`,
    'gate-w pre-manifest schedule'
  );

  source = replaceExactOnce(
    source,
`        let continuityStateUpdate = null;
        try {
          const canonicalCommitEnvelope = buildCanonicalCommitEnvelope({ context, memory, memoryKey, worldlineId: activeWorldlineId });
          let stateTrackingResult = await runStateTrackingAfterCommit({ context, envelope: canonicalCommitEnvelope, signal: options.signal });
`,
`        let continuityStateUpdate = null;
        try {
          stateTrackingJournalEntry = await updateStateTrackingJournalEntry({
            scope: context.scope,
            identityDigest: stateTrackingJournalEntry.identityDigest,
            patch: {
              state: 'running',
              attempts: Number(stateTrackingJournalEntry.attempts || 0) + 1,
              lastAttemptBootedAt: Math.max(0, Number(Runtime.bootedAt || 0) || 0),
              reason: 'post_commit_observer',
              error: ''
            }
          });
          let stateTrackingResult = await runStateTrackingAfterCommit({ context, envelope: canonicalCommitEnvelope, signal: options.signal });
`,
    'gate-w running attempt seal'
  );

  source = replaceExactOnce(
    source,
`          run.stateTracking = {
            schema: STATE_PIPELINE_RECEIPT_SCHEMA, receiptKey: continuityStateUpdate.receiptKey,
            status: continuityStateUpdate.status, skipped: continuityStateUpdate.skipped, reason: continuityStateUpdate.reason
          };
          await storage.setJson(key.run(context.scope, run.runId), run);
        } catch (continuityStateError) {
`,
`          run.stateTracking = {
            schema: STATE_PIPELINE_RECEIPT_SCHEMA, receiptKey: continuityStateUpdate.receiptKey,
            status: continuityStateUpdate.status, skipped: continuityStateUpdate.skipped, reason: continuityStateUpdate.reason
          };
          await storage.setJson(key.run(context.scope, run.runId), run);
          stateTrackingJournalEntry = await finishStateTrackingJournalAttempt({
            scope: context.scope,
            entry: stateTrackingJournalEntry,
            result: stateTrackingResult
          });
        } catch (continuityStateError) {
`,
    'gate-w successful attempt finalization'
  );

  source = replaceExactOnce(
    source,
`          run.errors.push({ stage: 'state_tracking', message: continuityStateUpdate.reason, at: nowIso(), failSoft: true });
          try { await storage.setJson(key.run(context.scope, run.runId), run); } catch (_) {}
          warn('LIBRA post-commit state tracking failed open', continuityStateError);
`,
`          run.errors.push({ stage: 'state_tracking', message: continuityStateUpdate.reason, at: nowIso(), failSoft: true });
          try { await storage.setJson(key.run(context.scope, run.runId), run); } catch (_) {}
          try {
            stateTrackingJournalEntry = await finishStateTrackingJournalAttempt({
              scope: context.scope,
              entry: stateTrackingJournalEntry,
              error: continuityStateError
            });
          } catch (stateTrackingJournalError) {
            warn('LIBRA post-commit State journal finalization failed; startup will retry the sealed running job.', stateTrackingJournalError);
          }
          warn('LIBRA post-commit state tracking failed open', continuityStateError);
`,
    'gate-w failed attempt finalization'
  );

  source = replaceExactOnce(
    source,
`        await storage.remove(workKey);
        try {
          await clearPendingBoundaryAfterCommit({
`,
`        await storage.remove(workKey);
        try {
          if (stateTrackingJournalEntry?.state !== 'completed') throw new Error('state_tracking_journal_pending');
          await clearPendingBoundaryAfterCommit({
`,
    'gate-w pending marker completion gate'
  );

  return source;
};

const validateTransformedSyntax = (source, filename = 'LIBRA.gate-w.generated.js') => {
  new vm.Script(source, { filename });
};

const parseCli = argv => {
  const result = { input: '', tempOutput: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--temp-output') result.tempOutput = argv[++index] || '';
    else if (!result.input) result.input = token;
    else throw new Error(`unexpected argument: ${token}`);
  }
  if (!result.input) throw new Error('usage: node libra_gate_w_transform.cjs <baseline-LIBRA.js> [--temp-output <path-under-os-tmp>]');
  return result;
};

if (require.main === module) {
  const cli = parseCli(process.argv.slice(2));
  const inputPath = path.resolve(cli.input);
  const original = fs.readFileSync(inputPath, 'utf8');
  const transformed = applyGateWTransform(original);
  validateTransformedSyntax(transformed, inputPath + '.gate-w.generated');

  let outputPath = '';
  if (cli.tempOutput) {
    outputPath = path.resolve(cli.tempOutput);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!outputPath.startsWith(tempRoot)) throw new Error(`--temp-output must stay under ${tempRoot}`);
    if (outputPath === inputPath) throw new Error('refusing to overwrite the input/production file');
    fs.writeFileSync(outputPath, transformed, 'utf8');
  }

  process.stdout.write(JSON.stringify({
    transform: TRANSFORM_ID,
    inputPath,
    inputBytes: Buffer.byteLength(original),
    outputBytes: Buffer.byteLength(transformed),
    changed: transformed !== original,
    syntax: 'ok',
    wroteInput: false,
    tempOutput: outputPath
  }, null, 2) + '\n');
}

module.exports = {
  TRANSFORM_ID,
  applyGateWTransform,
  validateTransformedSyntax,
  countExact,
  replaceExactOnce
};
