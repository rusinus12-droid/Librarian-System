'use strict';
// Shared lexical production factory. Detached processors have no host/UI capabilities.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'src/build-manifest.json'),'utf8'));
const replaceOne=(source,before,after,label)=>{if(source.split(before).length!==2)throw Error('factory_boundary_changed:'+label);return source.replace(before,after);};
module.exports = async function buildRuntimeFactory() {
const sources=manifest.parts.map(part=>({file:part.file,source:fs.readFileSync(path.join(root,'src',part.file),'utf8')}));
const swallowed = {
 'parts/05h-turn-maintenance-worker.js': { timePacketError:'world', orchestrationError:'narrative', trackerApplyError:'user_dlc', journalError:'integrated_analysis_and_indexes', materializeError:'entities_relations', quarantineError:'entities_relations' },
 'parts/05j-pending-turn-manager.js': { povRecordError:'entity_knowledge', candidateRecordError:'entity_candidates' },
 'parts/05i-turn-maintenance-scheduler-analysis.js': { unifiedError:'analysis_packet', povRecordError:'entity_knowledge', candidateRecordError:'entity_candidates', narrativeCorrectionError:'narrative' },
 'parts/05k-narrative-turn-processing.js': { quarantineError:'entities_relations' }
};
for(const part of sources){
 for(const [name,domain] of Object.entries(swallowed[part.file]||{})) part.source=replaceOne(part.source,`catch (${name}) {`,`catch (${name}) {\n                    recordDetachedDomainFailure('${domain}', ${name});`,part.file+':'+name);
 if(part.file==='parts/05h-turn-maintenance-worker.js') {
  const calls = {
   world:'HierarchicalWorldManager.saveWorldGraphUnsafe(latestLore);',
   entities_relations:'await EntityManager.saveToLorebook(latestChar, latestChat, latestLore);',
   narrative:'await NarrativeTracker.saveState(latestLore);',
   story_author:'await StoryAuthor.saveState?.(latestLore);',
   director:'await Director.saveState?.(latestLore);',
   world_additional:'await WorldAdditionalCore.saveState?.(latestLore);',
   character_states:'await CharacterStateTracker.saveState(latestLore);',
   world_states:'await WorldStateTracker.saveState(latestLore);',
   secrets:'await SecretKnowledgeCore.saveState(latestLore, {\n                        scopeKey,\n                        chatId\n                    });',
   entity_knowledge:'await EntityKnowledgeVaultCore.saveState(latestLore, {\n                        scopeKey,\n                        chatId\n                    });',
   time:'await TimeEngine.saveState(latestLore, {\n                        scopeKey,\n                        chatId\n                    });'
  };
  for (const [domain,raw] of Object.entries(calls)) {
   const call=raw.replace(/\\n/g,'\n');
   part.source=replaceOne(part.source,call,call+`\n                    recordDetachedDomainCompletion('${domain}', undefined, 'owner_save_completed');`,part.file+':owner:'+domain);
  }
  part.source=replaceOne(part.source,'integratedJournalChanged = journalResult?.changed === true;',"integratedJournalChanged = journalResult?.changed === true;\n                            recordDetachedDomainCompletion('integrated_analysis_and_indexes', journalResult, 'accepted_packet_journal_recorded');",part.file+':journal-proof');
  part.source=replaceOne(part.source,'if (Array.isArray(rpUpdate?.changedEntries) && rpUpdate.changedEntries.length > 0)',"recordDetachedDomainCompletion('rp_continuity', rpUpdate, 'owner_enrichment_evaluated');\n                            if (Array.isArray(rpUpdate?.changedEntries) && rpUpdate.changedEntries.length > 0)",part.file+':rp-proof');
  part.source=replaceOne(part.source,"if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA][RP-LTM] maintenance enrichment skipped:', error?.message || error);","recordDetachedDomainFailure('rp_continuity', error);\n                            if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA][RP-LTM] maintenance enrichment skipped:', error?.message || error);",part.file+':rp-failure');
  part.source=replaceOne(part.source,'if (!applied?.ok) {',"if (!applied?.ok) {\n                                recordDetachedDomainFailure('entities_relations', applied?.reason || 'absorption_failed');",part.file+':absorption-failure');
  part.source=replaceOne(part.source,'await Promise.allSettled([\n                    NarrativeTracker.summarizeIfNeeded(turnForMaintenance, maintenanceConfig),\n                    stateConsolidationTask\n                ]);',
   "const detachedSettledMaintenance = await Promise.allSettled([\n                    NarrativeTracker.summarizeIfNeeded(turnForMaintenance, maintenanceConfig),\n                    stateConsolidationTask\n                ]);\n                if (runtimeDetached) for (const result of detachedSettledMaintenance) {\n                    if (result.status === 'rejected') recordDetachedDomainFailure('narrative', result.reason);\n                    else if (result.value?.mode === 'fallback-split' || (['bundle','heuristic'].includes(result.value?.mode) && result.value.applied !== result.value.characters + Number(result.value.world))) recordDetachedDomainFailure('character_states', 'state_consolidation_incomplete');\n                    else if (Array.isArray(result.value)) for (const child of result.value) if (child?.status === 'rejected') recordDetachedDomainFailure('character_states', child.reason);\n                }",part.file+':settled-failures');
 }
 if(part.file==='parts/05i-turn-maintenance-scheduler-analysis.js')part.source=replaceOne(part.source,'if (candidateResult?.changed && maintenanceConfig?.debug)',"recordDetachedDomainCompletion('entity_candidates', candidateResult, 'owner_candidate_evaluation_completed');\n            if (candidateResult?.changed && maintenanceConfig?.debug)",part.file+':candidate-proof');
 if(part.file==='parts/05j-pending-turn-manager.js')part.source=replaceOne(part.source,"if (config.debug) recordRuntimeDebug('warn', '[LIBRA][RP-LTM] aggregate upsert skipped:', error?.message || error);","recordDetachedDomainFailure('rp_continuity', error);\n                        if (config.debug) recordRuntimeDebug('warn', '[LIBRA][RP-LTM] aggregate upsert skipped:', error?.message || error);",part.file+':rp-capture-failure');
 if(part.file==='parts/05k-narrative-turn-processing.js')part.source=replaceOne(part.source,'if (guard.allowed) return result;',"if (guard.allowed) return result;\n            if (!(operation === 'processNarrativeTurnState.structuredPacket' && result?.success === false && !(result?.entities || []).length && !(result?.relations || []).length && !Object.keys(result?.world || {}).length)) recordDetachedDomainFailure('entities_relations', guard.reason || 'analysis_merge_blocked');",part.file+':guard-failure');
 if(part.file==='parts/09d-section-character-world-state.js') {
  for (const [label,domain] of [['Char','character_states'],['World','world_states']]) {
   const line=`recordRuntimeDebug('warn', '[LIBRA] ${label} state consolidation failed:', e?.message);`;
   part.source=replaceOne(part.source,line,`recordDetachedDomainFailure('${domain}', e);\n                    `+line,part.file+':'+domain+'-failure');
  }
  const line="if (config?.debug) recordRuntimeDebug('warn', '[LIBRA] State consolidation bundle failed; falling back to split consolidation:', error?.message || error);";
  part.source=replaceOne(part.source,line,"if (runtimeDetached) { recordDetachedDomainFailure('character_states', error); throw error; }\n                "+line,part.file+':bundle-failure');
 }
 if(part.file==='parts/08e-entity-prompt-cache-persistence.js')part.source=replaceOne(part.source,"if (MemoryEngine.CONFIG?.debug) console.warn('[LIBRA] TimeEngine saveToLorebook projection skipped:', e?.message);","recordDetachedDomainFailure('time', e);\n                    if (MemoryEngine.CONFIG?.debug) console.warn('[LIBRA] TimeEngine saveToLorebook projection skipped:', e?.message);",part.file+':projection-failure');
 if(part.file==='parts/01b-runtime-state-prompt-ui.js')part.source=replaceOne(part.source,'        reset(opts = {}) {','        reset(opts = {}) {\n            wmHealthOrchestrator?.clear();\n            LatestTurnBaselineOwner.invalidate("runtime_reset");',part.file+':baseline-reset');
 if(part.file==='parts/01f-lore-consolidation.js') {
  part.source=replaceOne(part.source,'const save = async (charArg = null, chatArg = null, entryArg = []) => {','const save = async (charArg = null, chatArg = null, entryArg = [], saveOptions = {}) => {',part.file+':owner-save-arg');
  part.source=replaceOne(part.source,'                let previousEnvelope = {};','                let previousEnvelope = {};\n                let baselineWriteTicket = null, baselineVerifiedRaw = null;',part.file+':owner-save-state');
  part.source=replaceOne(part.source,'                    previousEnvelope = before.missing ? {} : JSON.parse(before.raw);','                    previousEnvelope = before.missing ? {} : JSON.parse(before.raw);\n                    baselineVerifiedRaw = before.raw;',part.file+':owner-prior-read');
  part.source=replaceOne(part.source,'                        try { await RisuCompat.pluginStorage.setItem(storageKeyFor(scopeKey), payload); } catch (_) {}','                        baselineWriteTicket = LatestTurnBaselineOwner.beforeWrite(scopeKey, saveOptions.reanalysisBaselineToken, baselineVerifiedRaw);\n                        try { await RisuCompat.pluginStorage.setItem(storageKeyFor(scopeKey), payload); } catch (_) {}',part.file+':owner-save-start');
  part.source=replaceOne(part.source,"                        if (readback !== payload) return { ok: false, uncertain: true, scopeKey, reason: 'canonical_save_unverified' };","                        if (readback !== payload) return { ok: false, uncertain: true, scopeKey, reason: 'canonical_save_unverified' };\n                        baselineVerifiedRaw = readback;",part.file+':owner-readback');
  part.source=replaceOne(part.source,'                    return { ok: true, verified: true, unchanged, scopeKey, entryCount: normalized.length, resetGeneration: expectedGeneration };','                    LatestTurnBaselineOwner.verifiedWrite(scopeKey, baselineWriteTicket, baselineVerifiedRaw);\n                    return { ok: true, verified: true, unchanged, scopeKey, entryCount: normalized.length, resetGeneration: expectedGeneration };',part.file+':owner-save-verified');
  part.source=replaceOne(part.source,'            writeStarted = true;','            const baselineWriteTicket = LatestTurnBaselineOwner.beforeWrite(scope, options.reanalysisPublicationTicket || options.reanalysisBaselineToken, before.raw);\n            writeStarted = true;',part.file+':owner-verified-start');
  part.source=replaceOne(part.source,"            if (!await isCurrent('after_readback')) return fail('stale_identity');","            if (!await isCurrent('after_readback')) return fail('stale_identity');\n            LatestTurnBaselineOwner.verifiedWrite(scope, baselineWriteTicket, readback);",part.file+':owner-verified-end');
 }
 if(part.file==='parts/01f-lore-consolidation.js')part.source=replaceOne(part.source,
  "scopeKey: scope, entryCount: normalized.length, updatedAt: Date.now(), entries: normalized, resetGeneration });",
  "scopeKey: scope, entryCount: normalized.length, updatedAt: Date.now(), entries: normalized, resetGeneration, ...(options.reanalysisPublicationTicket ? {reanalysisRevision:getPublicationMetadata(options.reanalysisPublicationTicket)} : {}) });",part.file+':private-publication-metadata');
 if(part.file==='parts/10c-hme-associative-graph.js') {
  part.source=replaceOne(part.source,'        const HmeDerivedCacheStore = (() => {','        let reanalysisDerivedGuard = null;\n        const HmeDerivedCacheStore = (() => {',part.file+':derived-guard');
  part.source=replaceOne(part.source,"                if (!value) return;","                if (!value) return;\n                if (reanalysisDerivedGuard?.scopeKey === scopeKey) options = { ...options, guard: reanalysisDerivedGuard.guard };",part.file+':derived-publication-guard');
  part.source=replaceOne(part.source,'return Object.freeze({ scheduleWrite, hydrate, keyFor, read });','return Object.freeze({ scheduleWrite, hydrate, keyFor, read, flush: () => Promise.all([...pending.values()]) });',part.file+':derived-flush');
 }
 if(part.file==='parts/10h-memory-public-write-api.js')part.source=replaceOne(part.source,'            ensureHybridScopeIndex,',`            refreshReanalysisDerived: async (entries, scopeKey, guard) => {
                if (!guard()) return false;
                reanalysisDerivedGuard = {scopeKey,guard};
                try {
                    ensureHybridScopeIndex(copySnapshot(entries), {scopeKey,force:true});
                    return (await HmeDerivedCacheStore.flush()).every(value => value !== false);
                } finally { reanalysisDerivedGuard = null; }
            },
            ensureHybridScopeIndex,`,part.file+':derived-refresh');
 if(part.file==='parts/01g-lore-concurrent-persistence.js')part.source=replaceOne(part.source,'const storageResult = await LibraDataStorage.save(freshChar, freshChat, libraLore);','const storageResult = await LibraDataStorage.save(freshChar, freshChat, libraLore, { reanalysisBaselineToken: opts.reanalysisBaselineToken });',part.file+':owner-forward-save');
 if(part.file==='parts/05j-pending-turn-manager.js') {
  part.source=replaceOne(part.source,'            const originalChat = chat;','            const originalChat = chat;\n            let reanalysisBaselineProof = null;',part.file+':owner-proof-slot');
  part.source=replaceOne(part.source,'                        chat = resolved.chat;\n                        char = resolved.char;','                        chat = resolved.chat;\n                        char = resolved.char;\n                        reanalysisBaselineProof = resolved.personaAdmission || null;',part.file+':owner-proof-target');
  part.source=replaceOne(part.source,'                    chat = refreshedChat;','                    chat = refreshedChat;\n                    reanalysisBaselineProof = refreshed.personaAdmission || null;',part.file+':owner-proof-active');
  part.source=replaceOne(part.source,'            const allowNarrativeProcessing = pending.allowNarrativeProcessing !== false;',"            const reanalysisBaselineToken = !canonicalRetry ? LatestTurnBaselineOwner.begin({ proof: reanalysisBaselineProof, sourceReceipt: anchorMeta.sourceReceipt, canonicalMemoryId, turn: finalizedTurn, chat, lease: runtimeLease }) : null;\n            const allowNarrativeProcessing = pending.allowNarrativeProcessing !== false;",part.file+':owner-begin');
  part.source=replaceOne(part.source,"                    reason: 'canonical-turn-commit', runtimeLease","                    reason: 'canonical-turn-commit', runtimeLease, reanalysisBaselineToken",part.file+':owner-capture-persist');
  part.source=replaceOne(part.source,'                if (options?.deferMaintenance !== true) {','                if (maintenanceRecord) maintenanceRecord.reanalysisBaselineToken = reanalysisBaselineToken;\n                if (options?.deferMaintenance !== true) {',part.file+':owner-maintenance-token');
 }
 if(part.file==='parts/05h-turn-maintenance-worker.js') {
  part.source=replaceOne(part.source,"                        reason: 'turn-maintenance-explicit-target'","                        reason: 'turn-maintenance-explicit-target', reanalysisBaselineToken: record.reanalysisBaselineToken",part.file+':owner-maintenance-persist');
  part.source=replaceOne(part.source,"        return finishMaintenanceLog({ status: 'done', turn: turnForMaintenance });","        LatestTurnBaselineOwner.complete(record.reanalysisBaselineToken, turnForMaintenance);\n        return finishMaintenanceLog({ status: 'done', turn: turnForMaintenance });",part.file+':owner-complete');
 }
 if(part.file==='parts/05h-turn-maintenance-worker.js') {
  part.source=replaceOne(part.source,'        if (maintenanceFailure) {','        if (maintenanceFailure) {\n            LatestTurnBaselineOwner.fail(record.reanalysisBaselineToken, "analysis_failed");',part.file+':owner-failed');
  part.source=replaceOne(part.source,'        if (turnState?.analysisDeferred === true) return finishMaintenanceLog({','        if (turnState?.analysisDeferred === true) LatestTurnBaselineOwner.fail(record.reanalysisBaselineToken, "analysis_deferred");\n        if (turnState?.analysisDeferred === true) return finishMaintenanceLog({',part.file+':owner-deferred');
 }
 if(part.file==='parts/13d-after-request-worker-unload.js')part.source=replaceOne(part.source,
  '        await RisuCompat.onUnload(async () => {',
  '        await RisuCompat.onUnload(async () => {\n            contextAbort.abort(new Error("runtime_unloaded"));\n            for (const release of runtimeDisposers.splice(0)) { try { release(); } catch (_) {} }',part.file+':dispose-detached-on-unload');
 if(part.file==='parts/13-risu-triggers-streaming.js')part.source=replaceOne(part.source,'const clearLibraTransientRuntimeState = () => {','const clearLibraTransientRuntimeState = () => {\n    LatestTurnBaselineOwner.invalidate("runtime_error_cleanup");',part.file+':owner-error-cleanup');
 if(part.file==='parts/05g-commit-guard-maintenance-records.js')part.source=replaceOne(part.source,
  "        if (!verified.ok || verified.resetGeneration !== Number(expected.resetGeneration ?? 0)) throw new Error('canonical_retry_read_unverified');",
  "        if (!verified.ok || verified.resetGeneration !== Number(expected.resetGeneration ?? 0)) throw new Error('canonical_retry_read_unverified');\n        if (typeof expected.onVerifiedRead === 'function') expected.onVerifiedRead(verified);",part.file+':reuse-preflight-read');
 if(part.file==='parts/05j-pending-turn-manager.js')part.source=replaceOne(part.source,
  '            const canonicalRetry = await findVerifiedCanonicalTurnCommit(char, chat, {',
  '            const canonicalRetry = await findVerifiedCanonicalTurnCommit(char, chat, {\n                onVerifiedRead: verified => { reanalysisBaselineProof = reanalysisBaselineProof?.ok && verified.scopeKey === reanalysisBaselineProof.scopeKey && verified.resetGeneration === reanalysisBaselineProof.resetGeneration ? { ...reanalysisBaselineProof, canonicalRaw: verified.raw } : null; },',part.file+':reuse-preflight-owner');
 if(part.file==='parts/01f-lore-consolidation.js') {
  part.source=replaceOne(part.source,'            });\n        };\n        // Management adds strict entry validation',
    '            }).then(result => { if (result?.ok !== true) LatestTurnBaselineOwner.fail(saveOptions.reanalysisBaselineToken, result?.reason || "canonical_write_unverified"); return result; });\n        };\n        // Management adds strict entry validation',part.file+':owner-save-failure');
  part.source=replaceOne(part.source,'            () => saveVerifiedUnlocked(scopeKey, entries, options));',
    '            () => saveVerifiedUnlocked(scopeKey, entries, options)).then(result => { if (result?.ok !== true) LatestTurnBaselineOwner.fail(options.reanalysisBaselineToken, result?.reason || "canonical_write_unverified"); return result; });',part.file+':owner-verified-failure');
 }
 if(part.file==='parts/00-plugin-shell-and-args.js')part.source=replaceOne(part.source,'(async () => {','',part.file);
 if(part.file==='parts/01f-lore-consolidation.js')part.source=replaceOne(part.source,'        return Object.freeze({ hydrate, save, inspectHydrationEntries',
   '        if (runtimeDetached) runtimeDisposers.push(() => { shadow.clear(); hydratedScopes.clear(); hydrationDiagnostics.clear(); scopeWrites.clear(); scopeMutations.clear(); readonlyReadProof = null; _activeScopeKey = ""; });\n        return Object.freeze({ hydrate, save, inspectHydrationEntries',part.file);
 if(part.file==='parts/01g-lore-concurrent-persistence.js')part.source=replaceOne(part.source,
   '    const persistLoreToActiveChat = async (preferredChat, lore, opts = {}) => {',
   '    const persistLoreToActiveChat = async (preferredChat, lore, opts = {}) => {\n        if (runtimeDetached) return persistDetachedLoreCandidate(preferredChat, lore, opts);',part.file);
 if(part.file==='parts/05j-pending-turn-manager.js')part.source=replaceOne(part.source,
   '                if (livePairs.length) {\n                    await LibraTurnWorldline.observe(',
   '                if (!runtimeDetached && livePairs.length) {\n                    await LibraTurnWorldline.observe(',part.file);
 if(part.file==='parts/13b-streaming-runtime-rescue.js')part.source=replaceOne(part.source,'if (RisuCompat.api()) {',"if (!runtimeDetached && RisuCompat.api()) {",part.file);
 if(part.file==='parts/14-main-initialization.js')part.source=replaceOne(part.source,'// Initialize\n(async () => {','// Initialize\nconst runtimeReady = runtimeDetached ? Promise.resolve() : (async () => {',part.file);
 if(part.file==='parts/15e-gui-registration-iife-close.js'){
  part.source=replaceOne(part.source,'// GUI 등록\n(async () => {','// GUI 등록\n(async () => {\n    if (runtimeDetached) return;',part.file);
  if(!/\n\}\)\(\);\s*$/.test(part.source))throw Error('factory_tail_changed');part.source=part.source.replace(/\n\}\)\(\);\s*$/,'\n');
 }
}
const pluginHeader = sources[0].source; sources[0].source = '';
const prefix=pluginHeader+`(async function createLibraRuntime(environment = {
    mode: 'live', global: globalThis,
    host: globalThis.risuai || globalThis.Risuai,
    window: globalThis.window,
    document: globalThis.document,
    console: globalThis.console,
    fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
    scheduler: { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args), clearInterval: (...args) => globalThis.clearInterval(...args) }
}) {
    if (!environment || !['live', 'detached'].includes(environment.mode)) throw new Error('runtime_environment_required');
    const runtimeMode = environment.mode;
    const runtimeDetached = runtimeMode === 'detached';
    const runtimeDisposers = [];
    let wmHealthOrchestrator = null;
    const globalThis = runtimeDetached ? Object.create(null) : environment.global;
    if (!globalThis || typeof globalThis !== 'object') throw new Error('runtime_global_required');
    let runtimeDisposed = false;
    let runtimeUnitSealed = false;
    let runtimeUnitFailures = null;
    let runtimeDomainProofs = null;
    const recordDetachedDomainCompletion = (domain, result, reason) => {
      if (!runtimeDetached || !runtimeDomainProofs) return;
      if (result?.ok === false || result?.success === false || result?.failed === true || result?.status === 'failed') {
        recordDetachedDomainFailure(domain, result?.reason || result?.error || 'owner_reported_failure'); return;
      }
      runtimeDomainProofs.set(domain, { status: 'complete', reason });
    };
    const recordDetachedDomainFailure = (domain, error) => {
      if (runtimeDetached && runtimeUnitFailures) runtimeUnitFailures.push({ domain, message: String(error?.message || error || 'domain_failed').slice(0, 240) });
    };
    const assertRuntimeActive = () => { if (runtimeDisposed) throw new Error('runtime_disposed'); };
    const dataOption = key => {
        const descriptor = Object.getOwnPropertyDescriptor(environment, key);
        if (!descriptor) return undefined;
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('runtime_accessor_capability_forbidden:' + key);
        return descriptor.value;
    };
    const copySnapshot = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    let nativeSnapshot = runtimeDetached ? copySnapshot(dataOption('snapshot') || {}) : null;
    const candidateStore = new Map();
    if (runtimeDetached) for (const pair of nativeSnapshot.storageEntries || []) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') throw new Error('invalid_candidate_storage_snapshot');
        candidateStore.set(pair[0], pair[1]);
    }
    const contextAbort = new AbortController();
    const detachedProvider = runtimeDetached ? dataOption('provider') : null;
    const denyCapability = name => () => { assertRuntimeActive(); throw new Error('detached_capability_forbidden:' + name); };
    const detachedHost = runtimeDetached ? Object.freeze({
        apiVersion: '3.0',
        async getRuntimeInfo() { assertRuntimeActive(); return { apiVersion: '3.0', platform: 'detached', saveMethod: 'candidate-only' }; },
        async getCharacter() { assertRuntimeActive(); return copySnapshot(nativeSnapshot.character || null); },
        async getCharacterFromIndex() { assertRuntimeActive(); return copySnapshot(nativeSnapshot.character || null); },
        async getCurrentCharacterIndex() { assertRuntimeActive(); return nativeSnapshot.characterIndex ?? 0; },
        async getCurrentChatIndex() { assertRuntimeActive(); return nativeSnapshot.chatIndex ?? 0; },
        async getChatFromIndex() { assertRuntimeActive(); return copySnapshot(nativeSnapshot.character?.chats?.[nativeSnapshot.chatIndex ?? 0] || null); },
        async getDatabase() { assertRuntimeActive(); return copySnapshot(nativeSnapshot.database || null); },
        async getArgument(key) { assertRuntimeActive(); return copySnapshot(nativeSnapshot.args?.[key]); },
        async nativeFetch(url, init) {
            assertRuntimeActive();
            if (runtimeUnitSealed) throw new Error('detached_candidate_sealed');
            if (typeof detachedProvider !== 'function') throw new Error('detached_provider_unavailable');
            const requestAbort = new AbortController();
            const signals = [...new Set([init?.signal, contextAbort.signal].filter(Boolean))];
            const listeners = [];
            for (const signal of signals) {
                const abort = () => requestAbort.abort(signal.reason);
                if (signal.aborted) abort();
                else { signal.addEventListener('abort', abort, {once:true}); listeners.push([signal,abort]); }
            }
            try {
                const response = await detachedProvider(String(url), { ...init, signal: requestAbort.signal });
                assertRuntimeActive(); return response;
            } finally {
                for (const [signal,abort] of listeners) signal.removeEventListener('abort',abort);
            }
        },
        async getLocalPluginStorage() { assertRuntimeActive(); return this.pluginStorage; },
        pluginStorage: Object.freeze({
            async getItem(key) { assertRuntimeActive(); return candidateStore.get(String(key)) ?? null; },
            async setItem(key, value) { assertRuntimeActive(); if (runtimeUnitSealed) throw new Error('detached_candidate_sealed'); candidateStore.set(String(key), String(value)); return true; },
            async removeItem(key) { assertRuntimeActive(); if (runtimeUnitSealed) throw new Error('detached_candidate_sealed'); candidateStore.delete(String(key)); return true; }
        }),
        setChatToIndex: denyCapability('setChatToIndex'), setCharacter: denyCapability('setCharacter'),
        setCharacterToIndex: denyCapability('setCharacterToIndex'), setDatabase: denyCapability('setDatabase'),
        registerSetting: denyCapability('registerSetting'), registerButton: denyCapability('registerButton'),
        addRisuReplacer: denyCapability('addRisuReplacer'), addRisuScriptHandler: denyCapability('addRisuScriptHandler'),
        registerBodyIntercepter: denyCapability('registerBodyIntercepter'), onUnload: denyCapability('onUnload'),
        requestPluginPermission: denyCapability('requestPluginPermission'), showContainer: denyCapability('showContainer')
    }) : null;
    const risuai = runtimeDetached ? detachedHost : environment.risuai || environment.host;
    const Risuai = runtimeDetached ? detachedHost : environment.Risuai || environment.host;
    const window = runtimeDetached ? undefined : environment.window;
    const document = runtimeDetached ? undefined : environment.document;
    const console = environment.console || { log(){}, warn(){}, error(){}, debug(){} };
    const fetch = runtimeDetached ? (() => { throw new Error('detached_direct_network_forbidden'); }) : environment.fetch;
    const scheduler = environment.scheduler;
    if (!scheduler || ['setTimeout','clearTimeout','setInterval','clearInterval'].some(key => typeof scheduler[key] !== 'function')) throw new Error('runtime_scheduler_required');
    const runtimeTimeouts = new Set(), runtimeIntervals = new Set();
    const setTimeout = (callback, delay, ...args) => {
        if (runtimeDisposed || runtimeUnitSealed) return null;
        if (typeof callback !== 'function') throw new Error('runtime_string_timer_forbidden');
        let id; id = scheduler.setTimeout(() => { runtimeTimeouts.delete(id); if (!runtimeDisposed) callback(...args); }, delay);
        runtimeTimeouts.add(id); return id;
    };
    const clearTimeout = id => { runtimeTimeouts.delete(id); scheduler.clearTimeout(id); };
    const setInterval = (callback, delay, ...args) => {
        if (runtimeDisposed || runtimeUnitSealed) return null;
        if (typeof callback !== 'function') throw new Error('runtime_string_timer_forbidden');
        const id = scheduler.setInterval(() => { if (!runtimeDisposed) callback(...args); }, delay);
        runtimeIntervals.add(id); return id;
    };
    const clearInterval = id => { runtimeIntervals.delete(id); scheduler.clearInterval(id); };
    const requestAnimationFrame = runtimeDetached ? denyCapability('requestAnimationFrame') : (environment.requestAnimationFrame || (callback => setTimeout(() => callback(Date.now()), 16)));
    const cancelAnimationFrame = runtimeDetached ? denyCapability('cancelAnimationFrame') : (environment.cancelAnimationFrame || clearTimeout);
`;
const baselineOwner=fs.readFileSync(path.join(__dirname,'runtime-factory-baseline-owner.source.js'),'utf8');
const detachedEntry=fs.readFileSync(path.join(__dirname,'runtime-factory-detached-entry.source.js'),'utf8');
const controller=fs.readFileSync(path.join(__dirname,'runtime-factory-controller.source.js'),'utf8');
const healthOrchestrator=fs.readFileSync(path.join(__dirname,'runtime-factory-health-orchestrator.source.js'),'utf8');
const suffix=`
    const runtimeApi = Object.freeze({ MemoryEngine, MemoryState, LibraDataStorage, ManagementReviewCore, EntityManager, TimeEngine,
      EntityCandidateCore, HierarchicalWorldManager, ActivityDashboardCore, LibraTurnWorldline, IntegrityMetaManager, EntityAwareProcessor,
      TransitionManager, ScopedRuntimeTransaction, NarrativeTracker, StoryAuthor, Director, WorldAdditionalCore, UserDlcCore,
      CharacterStateTracker, WorldStateTracker, SecretKnowledgeCore, EntityKnowledgeVaultCore, SectionWorldInferenceManager,
      reloadChatScopedRuntime, rememberScopedRuntimeState, getChatRuntimeScopeKey, TypedRecallRollout, stripSettingsSecrets,
      TypedRecallCorpus, SemanticRecallJobs, SemanticRecallIndex, persistLoreToActiveChat, PersonaRuntimeCoordinator,
      RuntimeStateLease, PendingTurnManager, TurnMaintenanceOptimizer, runTurnMaintenanceRecord, ProspectiveSourceReceipt, LLMProvider, LatestTurnBaselineOwner: Object.freeze(Object.fromEntries(Object.entries(LatestTurnBaselineOwner).filter(([key]) => key !== "claimPublication"))) });
    const invokeEntry = (method, owner, args) => {
      assertRuntimeActive(); const result = Reflect.apply(method, owner, args);
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(output => { assertRuntimeActive(); return copyDataValue(output); });
      assertRuntimeActive(); return copyDataValue(result);
    };
    const copyDataValue = (value, seen = new Map()) => {
      if (typeof value === 'function') return (...args) => invokeEntry(value, undefined, args);
      if (!value || typeof value !== 'object') return value;
      if (seen.has(value)) return seen.get(value);
      const tag = Object.prototype.toString.call(value);
      if (tag === '[object Date]') return new Date(value.getTime());
      if (tag === '[object ArrayBuffer]') return value.slice(0);
      if (ArrayBuffer.isView(value)) return tag === '[object DataView]'
        ? new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        : new value.constructor(value);
      const copy = Array.isArray(value) ? [] : tag === '[object Map]' ? new Map() : tag === '[object Set]' ? new Set() : {};
      seen.set(value, copy);
      if (tag === '[object Map]') { for (const [key, child] of value) copy.set(copyDataValue(key, seen), copyDataValue(child, seen)); return copy; }
      if (tag === '[object Set]') { for (const child of value) copy.add(copyDataValue(child, seen)); return copy; }
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (descriptor.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value')) copy[key] = copyDataValue(descriptor.value, seen);
      }
      return copy;
    };
    const guardService = service => {
      const methods = new Map();
      return new Proxy({}, {
        get(_unused, key) {
          assertRuntimeActive(); const child = Reflect.get(service, key, service);
          if (typeof child !== 'function') return copyDataValue(child);
          if (!methods.has(key)) methods.set(key, (...args) => invokeEntry(child, service, args));
          return methods.get(key);
        },
        set(_unused, key, next) { assertRuntimeActive(); return Reflect.set(service, key, copyDataValue(next), service); },
        ownKeys() { assertRuntimeActive(); return Reflect.ownKeys(service); },
        getOwnPropertyDescriptor(_unused, key) { assertRuntimeActive(); const descriptor = Object.getOwnPropertyDescriptor(service,key); return descriptor ? { enumerable: descriptor.enumerable, configurable: true } : undefined; }
      });
    };
    const detachedApi = runtimeDetached ? Object.freeze(Object.fromEntries(Object.entries(runtimeApi).map(([key, value]) => [key,
      typeof value === 'function' ? (...args) => invokeEntry(value, undefined, args) : guardService(value)
    ]))) : null;
    if (runtimeDetached) environment = null;
    const privateHandle = Object.freeze({ api: runtimeDetached ? detachedApi : runtimeApi, ready: runtimeReady,
      prepareLatestWholeTurn: (...args) => prepareLatestWholeTurn(...args),
      publishLatestWholeTurn: receipt => publishLatestWholeTurn(receipt),
      initialize: (...args) => invokeEntry(initializeDetached, undefined, args),
      stageWholeTurn: (...args) => invokeEntry(stageDetachedWholeTurn, undefined, args),
      diagnostics: () => ({ mode: runtimeMode, disposed: runtimeDisposed, pendingTimers: runtimeTimeouts.size + runtimeIntervals.size, candidateKeys: candidateStore.size, retainedInput: nativeSnapshot !== null }),
      dispose: () => {
        if (runtimeDisposed) return; runtimeDisposed = true;
        LatestTurnBaselineOwner.invalidate('runtime_disposed');
        contextAbort.abort(new Error('runtime_disposed'));  candidateStore.clear(); nativeSnapshot = null;
        for (const release of runtimeDisposers.splice(0)) { try { release(); } catch (_) {} }
        if (runtimeDetached) { try { LibraLoreConsolidator.withRawManagementRead(() => reloadChatScopedRuntime([], null, { resetSessionCaches: true, resetScopedState: true, forceWorldReload: true, restoreScopeSnapshot: false })); } catch (_) {} }
        for (const id of runtimeTimeouts) scheduler.clearTimeout(id); runtimeTimeouts.clear();
        for (const id of runtimeIntervals) scheduler.clearInterval(id); runtimeIntervals.clear();
        invalidateLibraRuntimeEpoch();
        try { ResourceGovernor.stop(); } catch (_) {}
        try { MemoryState.reset({ preserveSessionCache: false }); } catch (_) {}
      }
    });
    if (runtimeDetached) return privateHandle;
    runtimeReady.catch(error => recordSuppressedRuntimeError('runtime.initialization_failed', error));
})();
`;
const code=prefix+baselineOwner+sources.map(x=>x.source).join('')+detachedEntry+controller+healthOrchestrator+suffix;
return code;
};
