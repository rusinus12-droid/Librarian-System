'use strict';

const crypto = require('node:crypto');

const EXPECTED_SOURCE_SHA256 = '65B750DB47553B8F55B2695DEE9C86CB304DCD47C9E5744B5F9AB3680550A5A1';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();

module.exports = (input, { replaceExactlyOnce }) => {
  const actualHash = sha256(Buffer.from(input, 'utf8'));
  if (actualHash !== EXPECTED_SOURCE_SHA256) {
    throw new Error(`phase06_post_adoption_source_hash_changed:${actualHash}`);
  }

  let source = input;
  const labels = [];
  const replace = (label, before, after) => {
    source = replaceExactlyOnce(source, before, after, label);
    labels.push(label);
  };

  replace(
    'input_writer_catalog_read_only_option',
    `    const loadOrRefreshRecallCatalog = async (context, manifest, guard = null) => {
      const scopeKey = string(context?.scope?.scopeKey || '');`,
    `    const loadOrRefreshRecallCatalog = async (context, manifest, guard = null, optionsValue = {}) => {
      const persist = asObject(optionsValue).persist !== false;
      const scopeKey = string(context?.scope?.scopeKey || '');`
  );
  replace(
    'input_writer_runtime_legacy_catalog_no_background_write',
    `        if (runtimeCatalog.schema === RECALL_CATALOG_LEGACY_SCHEMA) scheduleRecallCatalogUpgrade(context, manifest);`,
    `        if (persist && runtimeCatalog.schema === RECALL_CATALOG_LEGACY_SCHEMA) scheduleRecallCatalogUpgrade(context, manifest);`
  );
  replace(
    'input_writer_storage_legacy_catalog_no_background_write',
    `        if (previous.schema === RECALL_CATALOG_LEGACY_SCHEMA) scheduleRecallCatalogUpgrade(context, manifest);`,
    `        if (persist && previous.schema === RECALL_CATALOG_LEGACY_SCHEMA) scheduleRecallCatalogUpgrade(context, manifest);`
  );
  replace(
    'input_writer_legacy_bridge_no_background_write',
    `        state.recallCatalogCache.set(scopeKey, bridged);
        scheduleRecallCatalogUpgrade(context, manifest);`,
    `        state.recallCatalogCache.set(scopeKey, bridged);
        if (persist) scheduleRecallCatalogUpgrade(context, manifest);`
  );
  replace(
    'input_writer_catalog_no_durable_write',
    `      if (catalog.complete) {
        await runRecallStep(guard, 'recall_catalog_write', () => storage.setJson(key.recallCatalog(context.scope), catalog), RECALL_STEP_BUDGET_MS, { soft: true, fallback: false, abortOnTimeout: false });
      }`,
    `      if (catalog.complete && persist) {
        await runRecallStep(guard, 'recall_catalog_write', () => storage.setJson(key.recallCatalog(context.scope), catalog), RECALL_STEP_BUDGET_MS, { soft: true, fallback: false, abortOnTimeout: false });
      }`
  );
  replace(
    'input_writer_recall_read_only_flag',
    `      const suppliedBundle = queryInput && typeof queryInput === 'object' ? queryInput : null;
      const settings = suppliedBundle?.settings || await runRecallStep(guard, 'recall_settings', () => loadMemorySettings(), RECALL_STEP_BUDGET_MS);`,
    `      const suppliedBundle = queryInput && typeof queryInput === 'object' ? queryInput : null;
      const requestLocalReadOnly = suppliedBundle?.requestLocalReadOnly === true;
      const persistRecallCatalog = suppliedBundle?.persistRecallCatalog !== false && !requestLocalReadOnly;
      const settings = suppliedBundle?.settings || await runRecallStep(guard, 'recall_settings', () => loadMemorySettings(), RECALL_STEP_BUDGET_MS);`
  );
  replace(
    'input_writer_recall_catalog_flag_forwarded',
    `      const catalogPromise = loadOrRefreshRecallCatalog(context, manifest, guard);`,
    `      const catalogPromise = loadOrRefreshRecallCatalog(context, manifest, guard, { persist: persistRecallCatalog });`
  );
  replace(
    'input_writer_preflight_marks_request_local_read_only',
    `      queryBundle.inputTag = continuationMode ? 'input_writer_continue' : 'input_writer_expand';
      queryBundle.manifest = manifest;`,
    `      queryBundle.inputTag = continuationMode ? 'input_writer_continue' : 'input_writer_expand';
      queryBundle.requestLocalReadOnly = true;
      queryBundle.persistRecallCatalog = false;
      queryBundle.manifest = manifest;`
  );

  replace(
    'input_writer_snapshot_accepts_bound_direction',
    `    const buildInputWriterDeliverySnapshot = async ({ context, pairs, manifest, stateManifest, responseState } = {}) => {`,
    `    const buildInputWriterDeliverySnapshot = async ({ context, pairs, manifest, stateManifest, responseState, narrativeDirection } = {}) => {`
  );
  replace(
    'input_writer_snapshot_uses_bound_direction',
    `      const direction = await getPlannerNarrativeDirection({ scopeKey: string(currentContext?.scope?.scopeKey || '') }).catch(() => null);`,
    `      const direction = narrativeDirection === undefined
        ? await getPlannerNarrativeDirection({ scopeKey: string(currentContext?.scope?.scopeKey || '') }).catch(() => null)
        : narrativeDirection;`
  );
  replace(
    'input_writer_preflight_seals_same_direction',
    `        stateManifest: manifest,
        responseState
      });`,
    `        stateManifest: manifest,
        responseState,
        narrativeDirection
      });`
  );

  replace(
    'input_writer_picker_binds_selected_run_snapshot',
    `              void finish({ action: choice.original ? 'original' : 'choice', content: body, choice: choice.original ? null : { ...choice, input: body } });`,
    `              void finish({
                action: choice.original ? 'original' : 'choice',
                content: body,
                choice: choice.original ? null : { ...choice, input: body },
                selectedRunId: text(currentRun?.runId || ''),
                deliverySnapshot: safeClone(currentRun?.deliverySnapshot || null)
              });`
  );
  replace(
    'input_writer_regenerate_transactional_commit',
    `        onRegenerate: async () => {
          preflight = await LibraMemoryCore.prepareInputWriterEvidence(composerInput, { settings: await loadSettings() });
          run = await generateLibraInputWriterChoices(preflight);
          return run;
        }
      });
      const ownedRun = Runtime.lastInputWriter?.runId === run?.runId ? Runtime.lastInputWriter : run;`,
    `        onRegenerate: async () => {
          const nextPreflight = await LibraMemoryCore.prepareInputWriterEvidence(composerInput, { settings: await loadSettings() });
          const nextRun = await generateLibraInputWriterChoices(nextPreflight);
          if (nextRun?.ok === true && Array.isArray(nextRun.choices) && nextRun.choices.length === INPUT_WRITER_CHOICE_TARGET) {
            preflight = nextPreflight;
            run = nextRun;
          }
          return nextRun;
        }
      });
      const selectedRunId = text(picked.selectedRunId || run?.runId || '');
      const selectedSnapshot = picked.deliverySnapshot
        || (selectedRunId && selectedRunId === text(run?.runId || '') ? run?.deliverySnapshot || preflight?.deliverySnapshot || null : null);
      const ownedRun = Runtime.lastInputWriter?.runId === selectedRunId
        ? Runtime.lastInputWriter
        : (run?.runId === selectedRunId ? run : { schema: INPUT_WRITER_RUN_SCHEMA, runId: selectedRunId });`
  );
  replace(
    'input_writer_delivery_uses_picker_owned_snapshot',
    `        deliverySnapshot: preflight?.deliverySnapshot || run?.deliverySnapshot || null,
        runId: text(run?.runId || '')`,
    `        deliverySnapshot: selectedSnapshot,
        runId: selectedRunId`
  );

  replace(
    'input_writer_send_meta_is_preparable',
    `    const deliveryMeta = { cycleId, idempotencyKey, snapshot, contentHash: stableDraftHash(content), readbackBasis: null };`,
    `    let deliveryMeta = { cycleId, idempotencyKey, snapshot, contentHash: stableDraftHash(content), readbackBasis: null, preparation: null };`
  );
  replace(
    'input_writer_send_failure_not_accepted',
    `        accepted: true,
        pending: false,`,
    `        accepted: outcome !== 'rejected',
        pending: false,`
  );
  replace(
    'input_writer_send_preflight_then_final_validation',
    `    let dispatchValue = null;
    try { dispatchValue = deps.sendChat(content, deliveryMeta); }`,
    `    let sendPreparation = null;
    if (typeof deps.prepareSend === 'function') {
      try { sendPreparation = await deps.prepareSend(content, { cycleId, idempotencyKey, snapshot }); }
      catch (error) {
        if (cycles.get(cycleId) === claimed) cycles.delete(cycleId);
        reportWarning('libra_input_writer_send_preflight_failed', error);
        return { ...base, unavailable: true, reason: compact(error?.message || error, 500) };
      }
      if (!sendPreparation || sendPreparation.ok !== true) {
        if (cycles.get(cycleId) === claimed) cycles.delete(cycleId);
        return {
          ...base,
          unavailable: sendPreparation?.unavailable === true,
          reason: text(sendPreparation?.reason || sendPreparation?.error || 'send_preflight_unavailable')
        };
      }
    }
    let finalValidation = null;
    try { finalValidation = await deps.validateSnapshot(snapshot); }
    catch (error) { finalValidation = { ok: false, current: false, stale: true, reason: compact(error?.message || error, 500) }; }
    if (!finalValidation || finalValidation.ok !== true || finalValidation.current !== true || finalValidation.stale === true) {
      if (cycles.get(cycleId) === claimed) cycles.delete(cycleId);
      return {
        ...base,
        stale: true,
        reason: text(finalValidation?.reason || 'input_writer_authority_changed_during_send_preflight'),
        validation: safeClone(finalValidation || null)
      };
    }
    deliveryMeta = {
      ...deliveryMeta,
      readbackBasis: sendPreparation?.readbackBasis || null,
      preparation: sendPreparation
    };
    let dispatchValue = null;
    try { dispatchValue = deps.sendChat(content, deliveryMeta); }`
  );
  replace(
    'input_writer_gui_prepares_send_before_dispatch',
    `          sendChat: async (value, meta) => {
            meta.readbackBasis = await captureInputWriterDeliveryReadback(value);
            const sendApi = getLiveApi(['sendChat']);
            if (typeof sendApi?.sendChat !== 'function') throw new Error('현재 RisuAI에서 sendChat API를 사용할 수 없습니다. 복사 후 직접 전송을 사용하세요.');
            return sendApi.sendChat(value);
          },`,
    `          prepareSend: async value => {
            const sendApi = getLiveApi(['sendChat']);
            if (typeof sendApi?.sendChat !== 'function') {
              return { ok: false, unavailable: true, reason: 'send_chat_unavailable' };
            }
            const readbackBasis = await captureInputWriterDeliveryReadback(value);
            return { ok: true, readbackBasis, dispatch: body => sendApi.sendChat(body) };
          },
          sendChat: (value, meta) => {
            const dispatch = meta?.preparation?.dispatch;
            if (typeof dispatch !== 'function') throw new Error('send_chat_preflight_missing');
            return dispatch(value);
          },`
  );

  return { source, labels };
};
