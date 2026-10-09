    // Detached entry: real processors, candidate-only capabilities. This first
    // integration deliberately cannot authorize publication.
    let detachedInitialization = null;
    let detachedUnitRunning = false;
    let detachedUnitAttempted = false;
    const persistDetachedLoreCandidate = async (preferredChat, lore, options = {}) => {
        assertRuntimeActive();
        if (!runtimeDetached || !detachedInitialization) throw new Error('detached_persistence_not_initialized');
        if (options.globalLore !== undefined) throw new Error('detached_global_lore_write_unsupported');
        const { char, chat, admission } = detachedInitialization;
        if (preferredChat?.id !== chat.id || (options.targetContext?.chatId && options.targetContext.chatId !== chat.id)) throw new Error('detached_persist_target_mismatch');
        const current = () => !runtimeDisposed && (!options.runtimeLease || RuntimeStateLease.isCurrent(options.runtimeLease));
        if (!current()) throw new Error('detached_persist_lease_expired');
        const entries = LibraLoreConsolidator.unpackRawFromLore(lore).filter(entry => LibraDataStorage.isLibraEntry(entry));
        const before = await LibraDataStorage.readVerified(admission.scopeKey);
        if (!before.ok || before.resetGeneration !== admission.resetGeneration) throw new Error('detached_persist_baseline_changed');
        const saved = await LibraDataStorage.saveVerified(admission.scopeKey, entries, {
            expectedRaw: before.raw, expectedGeneration: admission.resetGeneration, isCurrent: current
        });
        assertRuntimeActive();
        if (!saved.ok) return saved;
        const published = LibraDataStorage.publishVerifiedView(char, chat, admission.scopeKey, entries);
        if (!published.ok) throw new Error('detached_persist_projection_failed');
        return { ...saved, chat: { ...copySnapshot(chat), localLore: copySnapshot(entries) }, chatIndex: nativeSnapshot.chatIndex ?? 0,
            charIdx: nativeSnapshot.characterIndex ?? 0, candidateOnly: true };
    };
    const initializeDetached = async ({ config = {} } = {}) => {
        assertRuntimeActive();
        if (!runtimeDetached) throw new Error('detached_entry_requires_detached_runtime');
        if (detachedInitialization) throw new Error('detached_context_already_initialized');
        const char = await detachedHost.getCharacter();
        const chat = char?.chats?.[nativeSnapshot.chatIndex ?? 0];
        if (!char?.id || !chat?.id) throw new Error('detached_native_scope_required');
        Object.assign(MemoryEngine.CONFIG, copySnapshot(config));
        Object.assign(MemoryEngine.CONFIG, {
            activityDashboard: 'off', characterSourceReflectionEnabled: false,
            moduleLorebookReflectionEnabled: false, personaBindingSyncEnabled: false,
            analysisRecoveryDeferredAttempts: 0
        });
        const admission = await LibraDataStorage.preparePersonaContext(char, chat);
        assertRuntimeActive();
        if (!admission.ok) throw new Error(`detached_admission_failed:${admission.reason}`);
        const read = await LibraDataStorage.readVerified(admission.scopeKey);
        assertRuntimeActive();
        if (!read.ok || read.resetGeneration !== admission.resetGeneration) throw new Error('detached_baseline_unverified');
        const published = LibraDataStorage.publishVerifiedView(char, chat, admission.scopeKey, read.entries);
        if (!published.ok) throw new Error('detached_baseline_hydration_failed');
        LibraLoreConsolidator.withRawManagementRead(() => reloadChatScopedRuntime(read.entries, chat.id, {
            scopeKey: admission.runtimeScopeKey, resetSessionCaches: true,
            resetScopedState: true, forceWorldReload: true, restoreScopeSnapshot: false
        }));
        MemoryState.isInitialized = true;
        MemoryState.currentSessionId = buildScopedSessionId(admission.runtimeScopeKey);
        detachedInitialization = { char, chat, admission, baselineTurn: MemoryEngine.getCurrentTurn(), baselineStore: new Map(candidateStore) };
        return { initialized: true, baselineTurn: detachedInitialization.baselineTurn, scopeKey: admission.scopeKey };
    };
    const stageDetachedWholeTurn = async selection => {
        assertRuntimeActive();
        if (!runtimeDetached || !detachedInitialization) throw new Error('detached_context_not_initialized');
        if (detachedUnitRunning || detachedUnitAttempted) throw new Error('detached_unit_already_attempted');
        const input = copySnapshot(selection);
        const { char, chat, admission, baselineTurn, baselineStore } = detachedInitialization;
        const receipt = input?.sourceReceipt;
        if (!input?.analysisId || !input.canonicalMemoryId || input.turn !== baselineTurn + 1) throw new Error('latest_prospective_turn_required');
        if (receipt?.schema !== 'wm.prospective-source.v1' || receipt.state !== 'bound'
            || receipt.canonicalScope !== admission.scopeKey || receipt.characterId !== admission.characterId
            || receipt.chatId !== admission.chatId || receipt.resetGeneration !== admission.resetGeneration
            || !Array.isArray(receipt.userIds) || !receipt.userIds.length
            || !Array.isArray(receipt.assistantIds) || !receipt.assistantIds.length) throw new Error('prospective_source_binding_required');
        const messages = getChatMessages(chat);
        const nativeIds = message => normalizeCanonicalMessageIds([message?.id, message?.messageId, message?.m_id, message?.uuid, message?.key, message?.chatId, message?.generationInfo?.generationId]);
        const resolve = (expected, wantedRole) => {
            const matches = messages.map((message,index) => ({message,index,ids:nativeIds(message)}))
                .filter(row => row.ids.some(id => expected.includes(id)));
            if (matches.length !== 1 || !expected.every(id => matches[0].ids.includes(id))) throw new Error('source_native_identity_ambiguous');
            const row = matches[0], role = String(row.message.role || '').toLowerCase();
            if ((wantedRole === 'user' ? role !== 'user' : !['assistant','char'].includes(role))
                || row.message.disabled || row.message.isComment || row.message.isOOC) throw new Error('source_role_unavailable');
            const strings = ['data','content','text'].filter(key => typeof row.message[key] === 'string').map(key => row.message[key]);
            if (!strings.length || strings.some(text => text !== strings[0])) throw new Error('source_bytes_ambiguous');
            return { ...row, text: strings[0] };
        };
        const user = resolve(receipt.userIds, 'user'), assistant = resolve(receipt.assistantIds, 'assistant');
        if (user.index + 1 !== assistant.index || assistant.index !== messages.length - 1
            || receipt.originMessageCount !== assistant.index) throw new Error('latest_native_pair_changed');
        if (user.text !== input.userText || assistant.text !== input.assistantText) throw new Error('source_bytes_changed');
        const expectedCanonicalId = buildCanonicalMemoryId(chat.id, getLiveMessageId(assistant.message), 'turn_summary');
        if (input.canonicalMemoryId !== expectedCanonicalId) throw new Error('canonical_card_identity_mismatch');
        const sourceObservation = {
            schema: 'wm.reanalysis_source.v1', kind: 'native_source_observation',
            analysisId: input.analysisId, originalRequestId: receipt.requestId,
            nativeUserIds: receipt.userIds.slice(), nativeAssistantIds: receipt.assistantIds.slice(),
            observedAt: Date.now(), userChars: user.text.length, assistantChars: assistant.text.length
        };
        detachedUnitRunning = true; detachedUnitAttempted = true; runtimeUnitFailures = []; runtimeDomainProofs = new Map();
        try {
            const hash = String(TokenizerEngine.simpleHash(Utils.getMemorySourceText(assistant.text).trim()));
            const pending = PendingTurnManager.registerPending(chat, {
                userMsgForMemory: user.text, userMsgForNarrative: user.text,
                aiResponse: assistant.text, aiResponseRaw: assistant.text,
                aiHash: hash, sourceHash: hash, initialMessageId: getLiveMessageId(assistant.message),
                liveMessageIds: receipt.assistantIds.slice(), messageCount: assistant.index,
                originMessageCount: assistant.index, predictedTurn: input.turn, turnAnchor: input.turn,
                userTurnKey: buildLogicalUserTurnKey(user.text, user.text, false),
                allowMemoryCapture: true, allowNarrativeProcessing: true,
                targetContext: { characterId: admission.characterId, characterIndex: nativeSnapshot.characterIndex ?? 0,
                    chatId: admission.chatId, chatIndex: nativeSnapshot.chatIndex ?? 0,
                    scopeKey: admission.runtimeScopeKey, canonicalScope: admission.scopeKey, resetGeneration: admission.resetGeneration }
            });
            if (!pending) throw new Error('detached_pending_not_created');
            const committed = await PendingTurnManager.commitPendingNow(char, chat, 'detached-reanalysis', {
                pending, force: true, deferMaintenance: true, suppressFinalizeRetry: true
            });
            assertRuntimeActive();
            if (committed.status !== 'finalized' || !committed.maintenanceRecord) throw new Error(`detached_capture_incomplete:${committed.reason || committed.status}`);
            recordDetachedDomainCompletion('memory', committed, 'canonical_capture_guard_verified');
            const maintenance = await runTurnMaintenanceRecord(committed.maintenanceRecord);
            assertRuntimeActive();
            if (maintenance.status !== 'done') throw new Error(`detached_analysis_incomplete:${maintenance.error || maintenance.status}`);
            if (runtimeUnitFailures.length) { const failure = new Error('detached_domain_failed:' + runtimeUnitFailures.map(row => row.domain).join(',')); failure.failures = copySnapshot(runtimeUnitFailures); throw failure; }
            const current = await LibraDataStorage.readVerified(admission.scopeKey);
            if (!current.ok) throw new Error('detached_result_read_failed');
            const entries = copySnapshot(current.entries);
            let selectedCards = 0;
            for (const entry of entries) {
                if (entry.comment === 'lmai_memory') {
                    const meta = MemoryEngine.parseMeta(entry.content);
                    if (meta.canonicalMemoryId === input.canonicalMemoryId) {
                        forceMemoryTurnAnchor(entry, { sourceReceipt: receipt, reanalysisSource: sourceObservation }); selectedCards++;
                    }
                } else if (entry.comment === V42_TURN_RECORD_COMMENT) {
                    const state = JSON.parse(entry.content);
                    for (const record of state.records || []) if (record.turn === input.turn && receipt.assistantIds.includes(record.messageId)) {
                        record.sourceReceipt = copySnapshot(receipt); record.reanalysisSource = sourceObservation;
                    }
                    entry.content = JSON.stringify(state);
                }
            }
            if (!selectedCards) throw new Error('detached_selected_card_missing');
            const saved = await LibraDataStorage.saveVerified(admission.scopeKey, entries, {
                expectedRaw: current.raw, expectedGeneration: admission.resetGeneration,
                isCurrent: () => !runtimeDisposed
            });
            assertRuntimeActive();
            if (!saved.ok) throw new Error(`detached_candidate_unverified:${saved.reason}`);
            const scopeCachePrefix = `libra:v1:hme-derived:${stableHash(String(admission.runtimeScopeKey).trim())}:`;
            const writes = (() => {
                // Deletions are mutations too; no auxiliary deletion has a publication policy.
                for (const key of baselineStore.keys()) if (!candidateStore.has(key)) throw new Error('detached_unknown_auxiliary_write');
                return [...candidateStore].filter(([key,value]) => baselineStore.get(key) !== value).map(([key,value]) => {
                let kind = key === LibraDataStorage.storageKeyFor(admission.scopeKey) ? 'canonical_knowledge' : 'unknown';
                if (key === scopeCachePrefix+'scope' || key === scopeCachePrefix+'graph') {
                    const parsed = JSON.parse(value);
                    const recognized = parsed.scopeKey === admission.runtimeScopeKey && (
                        key.endsWith(':scope') ? parsed.schema === 'libra.hme.scope_index.v1' && Array.isArray(parsed.rows)
                        : parsed.schema === 'libra.hme.graph_index.v2' && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges));
                    if (recognized) kind = 'derived_cache_rebuild_only';
                }
                if (kind === 'unknown') throw new Error('detached_unknown_auxiliary_write');
                return {key,bytes:new TextEncoder().encode(value).length,kind};
            });
            })();
            const definitions = [
                ['memory',['lmai_memory','lmai_turn_records']], ['entities_relations',['lmai_entity','lmai_relation']],
                ['world',['lmai_world_graph']], ['narrative',['lmai_narrative']], ['time',['lmai_time_engine']],
                ['secrets',['lmai_secret_knowledge']], ['entity_knowledge',['lmai_entity_knowledge_vault']],
                ['entity_candidates',['lmai_entity_candidates']], ['rp_continuity',['lmai_rp_longterm'],MemoryEngine.CONFIG.rpLongTermMemoryEnabled === false],
                ['character_states',['lmai_char_states']], ['world_states',['lmai_world_states']],
                ['story_author',['lmai_story_author'],MemoryEngine.CONFIG.storyAuthorEnabled !== true || MemoryEngine.CONFIG.storyAuthorMode === 'disabled'],
                ['director',['lmai_director'],MemoryEngine.CONFIG.directorEnabled !== true || MemoryEngine.CONFIG.directorMode === 'disabled'],
                ['world_additional',['lmai_world_additional'],MemoryEngine.CONFIG.worldAdditionalEnabled !== true || MemoryEngine.CONFIG.worldAdditionalMode === 'off'],
                ['user_dlc',['lmai_user_dlc'],!entries.some(entry => entry.comment === 'lmai_user_dlc')],
                ['integrated_analysis_and_indexes',['lmai_integrated_packet_journal','lmai_character_lore_cues','lmai_hme_scope_index']]
            ];
            const domainLedger = { schema:'wm.whole_turn_domain_ledger.v1', analysisId:input.analysisId,
                complete:false, failures:copySnapshot(runtimeUnitFailures), domains:definitions.map(([domain,comments,disabled]) => {
                    const outputCount=entries.filter(entry => comments.includes(entry.comment)).length;
                    const proof=runtimeDomainProofs.get(domain);
                    return {domain,outputCount,status:disabled?'not_applicable':proof?.status || 'unverified_missing_owner',
                        reason:disabled?'disabled_or_unconfigured_in_captured_settings':proof?.reason || 'owner_completion_not_observed'};
                }) };
            domainLedger.complete = domainLedger.domains.every(row => ['complete','not_applicable'].includes(row.status)) && !domainLedger.failures.length;
            if (MaintenanceLLMQueue.activeCount || MaintenanceLLMQueue.pendingCount || BackgroundMaintenanceQueue.activeCount || BackgroundMaintenanceQueue.pendingCount) throw new Error('detached_jobs_not_quiescent');
            runtimeUnitSealed = true;
            for (const id of runtimeTimeouts) scheduler.clearTimeout(id); runtimeTimeouts.clear();
            for (const id of runtimeIntervals) scheduler.clearInterval(id); runtimeIntervals.clear();
            return { state: 'staged_unverified', publicationEligible: false, reason: 'domain_ownership_and_auxiliary_publication_unproven',
                entries, sourceObservation, writes, domainLedger, domains: [...new Set(entries.map(entry => entry.comment))] };
        } finally { detachedUnitRunning = false; runtimeUnitFailures = null; runtimeDomainProofs = null; }
    };
    if (runtimeDetached) runtimeDisposers.push(() => { detachedInitialization = null; });
