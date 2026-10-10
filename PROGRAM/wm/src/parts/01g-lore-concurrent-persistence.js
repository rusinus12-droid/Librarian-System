    const cloneChatForLoreMutation = (chat = {}) => {
        if (!chat || typeof chat !== 'object') return {};
        return {
            ...chat,
            localLore: Array.isArray(chat.localLore) ? chat.localLore.slice() : []
        };
    };
    const cloneCharacterForChatMutation = (baseChar, chatIndex, nextChat) => {
        const checkpointChar = (baseChar && typeof baseChar === 'object') ? { ...baseChar } : {};
        checkpointChar.chats = Array.isArray(baseChar?.chats) ? baseChar.chats.slice() : [];
        checkpointChar.chats[chatIndex] = nextChat;
        return checkpointChar;
    };
    // ── [COMMIT-GUARD] Preserve critical managed lore on refreshed/concurrent commits
    const LIBRA_COMMIT_GUARD_COMMENTS = Object.freeze([
        'lmai_memory',
        'lmai_direct_memory',
        'lmai_turn_records',
        'lmai_entity',
        'lmai_relation',
        'lmai_relation_graph',
        'lmai_world_graph',
        'lmai_world_additional',
        'lmai_user_dlc',
        'lmai_narrative',
        'lmai_char_states',
        'lmai_world_states',
        'lmai_secret_knowledge',
        'lmai_entity_knowledge_vault',
        'lmai_time_engine',
        'lmai_hme_index',
        'lmai_hme_graph_index',
        'lmai_character_lore_cues',
        'lmai_rp_longterm',
        'lmai_story_author',
        'lmai_director',
        'lmai_integrated_packet_journal',
        'lmai_recall_feedback',
        'lmai_rollback_journal',
        'lmai_rollback_snapshot',
        'lmai_analysis_quarantine',
        'lmai_cold_archive',
        'lmai_entity_candidates',
        'lmai_entity_absorption',
        'lmai_integrity_scan',
        'lmai_source_reflection_state',
        'lmai_user',
        'lmai_user_identity',
        'lmai_hypa_v3_source',
        'lmai_world_node'
    ]);
    const LIBRA_COMMIT_GUARD_COMMENT_SET = new Set(LIBRA_COMMIT_GUARD_COMMENTS);
    const summarizeLibraManagedCommitCounts = (entries = [], options = {}) => {
        const summary = { totalManaged: 0 };
        for (const comment of LIBRA_COMMIT_GUARD_COMMENTS) summary[comment] = 0;
        const source = options?.alreadyUnpacked === true
            ? (Array.isArray(entries) ? entries : [])
            : LibraLoreConsolidator.unpack(Array.isArray(entries) ? entries : []);
        for (const entry of source) {
            const comment = String(entry?.comment || '').trim();
            if (comment.startsWith('lmai_')) summary.totalManaged += 1;
            if (LIBRA_COMMIT_GUARD_COMMENT_SET.has(comment)) summary[comment] = Number(summary[comment] || 0) + 1;
        }
        return summary;
    };
    const buildLibraCommitMergeKey = (entry = {}, fallbackIndex = 0) => {
        const comment = String(entry?.comment || '').trim();
        const key = String(entry?.key || '').trim();
        if (key) return `${comment}::key:${key}`;
        if (comment === 'lmai_memory') {
            const content = String(entry?.content || '');
            const metaMatch = content.match(/\[META:({[^\r\n]*})\]/);
            if (metaMatch) {
                try {
                    const meta = JSON.parse(metaMatch[1]);
                    const identity = String(
                        meta?.canonicalMemoryId
                        || meta?.turnKey
                        || [meta?.chatId, meta?.m_id || meta?.messageId, meta?.canonicalFactSlot].filter(Boolean).join(':')
                        || [meta?.sourceHash || meta?.aiHash, meta?.t || meta?.turn].filter(Boolean).join(':')
                        || ''
                    ).trim();
                    if (identity) return `${comment}::memory:${identity}`;
                } catch (_) {}
            }
        }
        if (comment) {
            try {
                const parsed = JSON.parse(String(entry?.content || '{}'));
                const recordId = String(parsed?.id || parsed?.recordId || parsed?.name || '').trim();
                if (recordId) return `${comment}::record:${recordId}`;
            } catch (_) {}
            return `${comment}::content:${stableHash(String(entry?.content || ''))}`;
        }
        return `idx:${fallbackIndex}::${stableHash(String(entry?.content || ''))}`;
    };
    const fingerprintLibraManagedEntry = (entry = {}) => stableHash(JSON.stringify({
        key: String(entry?.key || ''),
        comment: String(entry?.comment || ''),
        content: String(entry?.content || ''),
        mode: String(entry?.mode || ''),
        insertorder: Number(entry?.insertorder || 0),
        alwaysActive: entry?.alwaysActive === true
    }));
    const mergeConcurrentLibraManagedLore = (incomingLore = [], latestLore = [], baselineLore = []) => {
        // 병합은 **주어진 세 리비전**만 비교해야 한다. 섀도를 주입하면 세 리비전에
        // 없는 항목이 끼어들어 "사용자가 지운 항목"이 되살아난다.
        const incoming = LibraLoreConsolidator.unpack(Array.isArray(incomingLore) ? incomingLore : [], { raw: true });
        const latest = LibraLoreConsolidator.unpack(Array.isArray(latestLore) ? latestLore : [], { raw: true });
        const baseline = LibraLoreConsolidator.unpack(Array.isArray(baselineLore) ? baselineLore : [], { raw: true });
        const next = incoming.map(entry => safeClone(entry));
        const buildMap = (entries = []) => {
            const map = new Map();
            entries.forEach((entry, index) => {
                const comment = String(entry?.comment || '').trim();
                if (!LIBRA_COMMIT_GUARD_COMMENT_SET.has(comment)) return;
                map.set(buildLibraCommitMergeKey(entry, index), { entry, index });
            });
            return map;
        };
        const incomingMap = buildMap(next);
        const baselineMap = buildMap(baseline);
        const latestMap = buildMap(latest);
        const addedConcurrent = [];
        const refreshedConcurrent = [];

        for (const [identity, latestRow] of latestMap.entries()) {
            const incomingRow = incomingMap.get(identity);
            const baselineRow = baselineMap.get(identity);
            if (!incomingRow) {
                // Missing from both the GUI baseline and requested save means it
                // arrived while the GUI was open. Missing only from the request is
                // an intentional user deletion and must remain deleted.
                if (!baselineRow) {
                    next.push(safeClone(latestRow.entry));
                    incomingMap.set(identity, { entry: next[next.length - 1], index: next.length - 1 });
                    addedConcurrent.push(identity);
                }
                continue;
            }
            if (!baselineRow) continue;
            const incomingFingerprint = fingerprintLibraManagedEntry(incomingRow.entry);
            const baselineFingerprint = fingerprintLibraManagedEntry(baselineRow.entry);
            const latestFingerprint = fingerprintLibraManagedEntry(latestRow.entry);
            // If the GUI did not change this record but the runtime did, retain the
            // runtime revision. Explicit GUI edits win when both sides changed.
            if (incomingFingerprint === baselineFingerprint && latestFingerprint !== baselineFingerprint) {
                next[incomingRow.index] = safeClone(latestRow.entry);
                incomingMap.set(identity, { entry: next[incomingRow.index], index: incomingRow.index });
                refreshedConcurrent.push(identity);
            }
        }
        return { lore: next, addedConcurrent, refreshedConcurrent };
    };
    const isManagedDropAllowedForCommit = (opts = {}) => {
        if (opts?.allowManagedDrops === true || opts?.preserveManagedDrops === false) return true;
        const reason = String(opts?.reason || opts?.refreshReason || opts?.source || '').trim().toLowerCase();
        if (!reason) return false;
        return /(?:manual|gui|delete|purge|trash|reset|clear|rollback|tombstone|import|restore|migration)/i.test(reason);
    };
    const guardLibraManagedCommitMerge = (incomingLore = [], latestLore = [], opts = {}) => {
        const inputsAlreadyUnpacked = opts?.inputsAlreadyUnpacked === true;
        const incoming = inputsAlreadyUnpacked
            ? (Array.isArray(incomingLore) ? incomingLore : [])
            : LibraLoreConsolidator.unpack(Array.isArray(incomingLore) ? incomingLore : []);
        const latest = inputsAlreadyUnpacked
            ? (Array.isArray(latestLore) ? latestLore : [])
            : LibraLoreConsolidator.unpack(Array.isArray(latestLore) ? latestLore : []);
        if (isManagedDropAllowedForCommit(opts) || latest.length === 0) {
            return {
                lore: incoming,
                restoredComments: [],
                previousSummary: summarizeLibraManagedCommitCounts(latest, { alreadyUnpacked: true }),
                nextSummary: summarizeLibraManagedCommitCounts(incoming, { alreadyUnpacked: true }),
                guarded: false
            };
        }
        const previousSummary = summarizeLibraManagedCommitCounts(latest, { alreadyUnpacked: true });
        const nextSummary = summarizeLibraManagedCommitCounts(incoming, { alreadyUnpacked: true });
        const restoredComments = [];
        const next = incoming.map(entry => ({ ...entry }));
        const existingKeys = new Set(next.map((entry, index) => buildLibraCommitMergeKey(entry, index)));
        for (const comment of LIBRA_COMMIT_GUARD_COMMENTS) {
            if (Number(previousSummary[comment] || 0) <= 0 || Number(nextSummary[comment] || 0) > 0) continue;
            const restored = latest.filter(entry => String(entry?.comment || '').trim() === comment);
            for (const entry of restored) {
                const key = buildLibraCommitMergeKey(entry, next.length);
                if (existingKeys.has(key)) continue;
                next.push({ ...entry });
                existingKeys.add(key);
            }
            if (restored.length > 0) restoredComments.push(comment);
        }
        return {
            lore: next,
            restoredComments: [...new Set(restoredComments)],
            previousSummary,
            nextSummary: summarizeLibraManagedCommitCounts(next, { alreadyUnpacked: true }),
            guarded: restoredComments.length > 0
        };
    };

    const shouldRunPersistRpBackfill = (entries = []) => {
        if (MemoryEngine?.CONFIG?.rpLongTermMemoryEnabled === false) return false;
        const memoryCount = Array.isArray(entries)
            ? entries.reduce((count, entry) => count + (String(entry?.comment || '').trim() === 'lmai_memory' ? 1 : 0), 0)
            : 0;
        const hasRpLongTerm = Array.isArray(entries)
            ? entries.some(entry => String(entry?.comment || '').trim() === 'lmai_rp_longterm')
            : false;
        const currentTurn = Number(MemoryEngine?.getCurrentTurn?.() || 0) || 0;
        const previous = MemoryState._lastPersistRpBackfill || { memoryCount: 0, turn: 0 };
        if (!hasRpLongTerm) return true;
        if (memoryCount - Number(previous.memoryCount || 0) >= 24) return true;
        if (currentTurn - Number(previous.turn || 0) >= 24) return true;
        return false;
    };

    const persistLoreToActiveChat = async (preferredChat, lore, opts = {}) => {
        if(WmWriterRuntime.enabled && !opts.expectedSource)opts={...opts,expectedSource:WmWriterRuntime.latestSource(LibraDataStorage.scopeKeyFor(null,preferredChat))};
        if (VersionedCanonicalBridge.mode === "authority" && !WmWriterRuntime.enabled && !opts.expectedSource) return {ok:false,reason:"authority_write_token_required"};
        if (!Array.isArray(lore)) return { ok: false, reason: 'invalid_lore' };
        const { globalLore = undefined } = opts;
        // A chat-origin receipt cannot authorize the separate global source.
        if ((VersionedCanonicalBridge.mode === "authority" || typeof WmManualRuntime !== "undefined" && WmManualRuntime?.isRouted()) && Array.isArray(globalLore)) return {ok:false,reason:"authority_mixed_scope_unsupported"};
        const { targetContext = null } = opts;
        const capturedProof = typeof PersonaScopeIdentity === 'undefined' ? null : PersonaScopeIdentity.chatProof(preferredChat);
        const expectedGeneration = targetContext?.resetGeneration ?? capturedProof?.resetGeneration ?? 0;
        const isCurrent = () => !opts.runtimeLease || RuntimeStateLease.isCurrent(opts.runtimeLease);
        if (!isCurrent()) return { ok: false, reason: 'runtime_lease_invalidated' };
        
        bindUiInteractionGuards();
        const delayMs = uiInteractionHotUntil - Date.now();
        if (delayMs > 0) {
            await sleep(delayMs + 50);
        }

        const explicitTarget = targetContext && typeof targetContext === 'object'
            ? {
                ...targetContext,
                chatId: String(targetContext.chatId || preferredChat?.id || '').trim()
            }
            : null;
        const resolvedTarget = explicitTarget
            ? await resolveChatContextByTarget(explicitTarget, { allowActiveFallback: false })
            : null;
        if (explicitTarget && !resolvedTarget?.ok) return { ok: false, reason: resolvedTarget?.reason || 'target_unavailable' };
        const freshChar = resolvedTarget?.char || await RisuCompat.getCharacter();
        if (!freshChar) return { ok: false, reason: 'missing_char' };
        const charIdx = resolvedTarget?.ok
            ? normalizeRisuIndex(resolvedTarget.charIdx)
            : normalizeRisuIndex(await RisuCompat.getCurrentCharacterIndex());
        const chats = Array.isArray(freshChar.chats) ? freshChar.chats : [];
        let chatIndex = resolvedTarget?.ok
            ? normalizeRisuIndex(resolvedTarget.chatIndex)
            : normalizeRisuIndex(await RisuCompat.getCurrentChatIndex());
        if (preferredChat?.id) {
            const resolved = chats.findIndex(entry => String(entry?.id || '') === String(preferredChat.id));
            if (resolved >= 0) chatIndex = resolved;
            else return { ok: false, reason: 'preferred_chat_not_found' };
        }
        const freshChat = chats[chatIndex];
        if (!freshChat || chatIndex < 0) {
            return { ok: false, reason: 'missing_chat_context' };
        }
        const admission = await LibraDataStorage.preparePersonaContext(freshChar, freshChat);
        if (!isCurrent()) return { ok: false, reason: 'runtime_lease_invalidated' };
        if (!admission.ok) return { ok: false, reason: admission.reason };
        if (admission.resetGeneration !== expectedGeneration
            || (capturedProof && (admission.characterId !== capturedProof.characterId || admission.chatId !== capturedProof.chatId || admission.personaId !== capturedProof.personaId))) {
            return { ok: false, reason: 'reset_generation_changed' };
        }

        const expectedChatId = String(freshChat?.id || '');
        // Capture before save mutates shadow/cache and strips managed chat lore.
        let typedRecallBefore = null;
        try {
            if (SemanticRecallJobs.watchesScope(getChatRuntimeScopeKey(freshChat, freshChar))) {
                const beforeCanonical = await LibraDataStorage.readVerified(admission.scopeKey, { readonly: true });
                if (!beforeCanonical.ok || beforeCanonical.resetGeneration !== expectedGeneration || !isCurrent()) throw new Error('canonical_generation_changed');
                typedRecallBefore = TypedRecallCorpus.capture(freshChar, freshChat, {
                    currentTurn: MemoryEngine.getCurrentTurn?.() || 0,
                    resetGeneration: beforeCanonical.resetGeneration,
                    verifiedCanonicalEntries: beforeCanonical.entries
                });
                SemanticRecallJobs.beginPersist(typedRecallBefore);
            }
        } catch (_) {}
        const nextChat = cloneChatForLoreMutation(freshChat);
        const activeScopeKeyForDebug = getChatRuntimeScopeKey(freshChat, freshChar);
        // A declared deletion is a complete requested revision. Hydrated shadow
        // may fill an ordinary partial save, but must not resurrect removed rows.
        let workingLoreForPersist = LibraLoreConsolidator.unpack(lore, {
            raw: isManagedDropAllowedForCommit(opts)
        });
        const prepareRequestedRevision = callback => isManagedDropAllowedForCommit(opts)
            ? LibraLoreConsolidator.withRawManagementRead(callback)
            : callback();
        try {
            const latestManagedLoreForGuard = typeof WmManualRuntime !== 'undefined' && WmManualRuntime?.isRouted() ? LibraDataStorage.getShadowEntries(admission.scopeKey) : LibraLoreConsolidator.unpack(Array.isArray(freshChat?.localLore) ? freshChat.localLore : []);
            const guardResult = guardLibraManagedCommitMerge(workingLoreForPersist, latestManagedLoreForGuard, {
                ...opts,
                inputsAlreadyUnpacked: true
            });
            if (guardResult.guarded) {
                workingLoreForPersist = guardResult.lore;
                recordRuntimeDebug('warn', '[LIBRA][CommitGuard] restored missing managed lore categories before persist', {
                    chatId: expectedChatId,
                    scopeKey: activeScopeKeyForDebug,
                    restoredComments: guardResult.restoredComments,
                    previousSummary: guardResult.previousSummary,
                    nextSummary: guardResult.nextSummary,
                    reason: opts?.reason || opts?.refreshReason || ''
                });
            }
        } catch (guardError) {
            if (MemoryEngine?.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA][CommitGuard] merge guard skipped:', guardError?.message || guardError);
        }
        try {
            if (shouldRunPersistRpBackfill(workingLoreForPersist)) {
                prepareRequestedRevision(() => RPContinuityCore.backfillFromMemories(workingLoreForPersist, {
                    maxEntries: Math.max(1200, Number(MemoryEngine?.CONFIG?.maxLimit || 200) * 6)
                }));
                MemoryState._lastPersistRpBackfill = {
                    memoryCount: workingLoreForPersist.reduce((count, entry) => count + (String(entry?.comment || '').trim() === 'lmai_memory' ? 1 : 0), 0),
                    turn: Number(MemoryEngine?.getCurrentTurn?.() || 0) || 0,
                    at: Date.now()
                };
            }
        } catch (error) {
            if (MemoryEngine?.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA][RP-LTM] persist backfill skipped:', error?.message || error);
        }
        try {
            const hasHmeScopeIndex = workingLoreForPersist.some(entry => String(entry?.comment || '').trim() === 'lmai_hme_index');
            if (!hasHmeScopeIndex && typeof MemoryEngine !== 'undefined' && MemoryEngine?.ensureHybridScopeIndex) {
                prepareRequestedRevision(() => MemoryEngine.ensureHybridScopeIndex(workingLoreForPersist, {
                    scopeKey: activeScopeKeyForDebug,
                    currentTurn: MemoryEngine.getCurrentTurn?.() || 0,
                    reason: 'persistLoreToActiveChat'
                }));
            }
        } catch (error) {
            if (MemoryEngine?.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA][HMEIndex] persist index update failed:', error?.message || error);
        }
        const loreWithoutDebugEntry = DebugExportManager.stripEntryAndFlush(workingLoreForPersist, {
            chatId: expectedChatId,
            scopeKey: activeScopeKeyForDebug
        }).filter(entry => !isRetiredOrchestrationLoreEntry(entry));
        const externalLore = (Array.isArray(nextChat.localLore) ? nextChat.localLore : []).filter(e => !e.comment || !String(e.comment).startsWith('lmai_'));
        const libraLore = loreWithoutDebugEntry
            .filter(e => e.comment && String(e.comment).startsWith('lmai_') && !isRetiredOrchestrationLoreEntry(e))
            .map(e => ({ ...e }));
        // LIBRA 데이터는 이제 pluginStorage 에 저장한다 (로어북이 아니라).
        // 로어에는 비-LIBRA(사용자·다른 플러그인) 항목만 남긴다.
        // Optional historical-selection guard. The ordinary mirror path is unchanged.
        // This is a final pre-dispatch check, not cross-runtime CAS or an atomic source revision.
        if (typeof opts.beforeCanonicalWrite === 'function' && await opts.beforeCanonicalWrite() !== true)
            return {ok:false,reason:'historical_selection_changed_before_save',canonicalWritten:false};
        const historyRootRow=libraLore.find(entry=>entry?.comment===WmExtensionHistory.COMMENT);
        if(historyRootRow) {
            if(WmWriterRuntime.enabled&&WmWriterRuntime.historyProfile!=='server-pinned-roots-v2')return {ok:false,reason:'history_server_dependency_roots_unsupported'};
            let root;try{root=JSON.parse(historyRootRow.content);}catch(_){return {ok:false,reason:'history_manifest_invalid'};}
            if(WmWriterRuntime.enabled&&root.profile!==WmWriterRuntime.historyProfile)return {ok:false,reason:'history_profile_mismatch'};
            if(root.scope!==admission.scopeKey || root.eventScope!==activeScopeKeyForDebug)return {ok:false,reason:'history_scope_changed'};
            if(root.phase==='ready' && libraLore.some(WmExtensionHistory.historyRow))return {ok:false,reason:'history_inline_rows_after_cutover'};
        }
        const storageResult = await LibraDataStorage.save(freshChar, freshChat, libraLore);
        if (!storageResult?.ok) return { ok: false, reason: storageResult?.reason || 'canonical_save_failed',uncertain:storageResult?.uncertain===true };
        if(WmWriterRuntime.enabled || typeof WmManualRuntime !== 'undefined' && WmManualRuntime?.isRouted())return {ok:true,canonicalVerified:true,canonicalWritten:true,scopeKey:storageResult.scopeKey,backend:WmWriterRuntime.enabled?'server_only':'wm.manual-copy-switch.v1'};
        if (!isCurrent()) return { ok: false, reason: 'runtime_lease_invalidated', canonicalWritten: true };
        const packedLibraLore = storageResult?.ok === false && LibraDataStorage.isHydrated(LibraDataStorage.scopeKeyFor(freshChar, freshChat))
            ? LibraDataStorage.getShadowEntries(LibraDataStorage.scopeKeyFor(freshChar, freshChat)).map(entry => ({ ...entry }))
            : [];
        nextChat.localLore = [...externalLore, ...packedLibraLore];

        // Rebase only LIBRA-managed lore onto the newest host chat snapshot.
        // Risu may append/edit messages, modules, or external lore while a
        // background analysis is running; writing the older full chat object
        // would silently roll those concurrent host changes back.
        const rebaseManagedLoreOntoChat = (baseChat = null) => {
            const latestBase = cloneChatForLoreMutation(baseChat || nextChat);
            const latestExternalLore = (Array.isArray(latestBase?.localLore) ? latestBase.localLore : [])
                .filter(entry => !entry?.comment || !String(entry.comment).startsWith('lmai_'));
            latestBase.localLore = [...latestExternalLore, ...packedLibraLore.map(entry => safeClone(entry))];
            return latestBase;
        };

        const needsGlobalLoreWrite = Array.isArray(globalLore);
        const buildCheckpointChar = async (baseChar, rebasedChat = nextChat) => {
            const checkpointChar = cloneCharacterForChatMutation(baseChar || freshChar, chatIndex, rebasedChat);
            if (needsGlobalLoreWrite) {
                const canonicalGlobalLore = Array.isArray(checkpointChar.globalLore)
                    ? checkpointChar.globalLore
                    : (Array.isArray(checkpointChar.lorebook) ? checkpointChar.lorebook : []);
                const externalGlobal = canonicalGlobalLore.filter(e => !e.comment || !String(e.comment).startsWith('lmai_'));
                const libraGlobal = LibraLoreConsolidator.unpackRawFromLore(globalLore)
                    .filter(e => e.comment && String(e.comment).startsWith('lmai_') && !isRetiredOrchestrationLoreEntry(e))
                    .map(e => ({ ...e }));
                // 전역 로어도 스토리지로 보낸다. 캐릭터 로어에는 비-LIBRA 만 남긴다.
                if (libraGlobal.length > 0) await LibraDataStorage.save(checkpointChar, null, libraGlobal);
                checkpointChar.globalLore = [...externalGlobal];
            }
            return checkpointChar;
        };

        // Prefer the narrow v3 chat writer to avoid overwriting concurrent
        // character-level edits. Fall back to setCharacter only when the current
        // API cannot write the chat directly or when global lore migration must
        // remove managed entries from the character lorebook.
        let savedByGranularChatApi = false;
        let persistedChat = nextChat;
        if (!needsGlobalLoreWrite && charIdx >= 0 && RisuCompat.has('setChatToIndex')) {
            try {
                const verifyResolved = explicitTarget
                    ? await resolveChatContextByTarget(explicitTarget, { allowActiveFallback: false })
                    : null;
                if (explicitTarget && !verifyResolved?.ok) return { ok: false, reason: verifyResolved?.reason || 'target_changed_before_save' };
                const verifyChar = verifyResolved?.char || await RisuCompat.getCharacter();
                const verifyChat = verifyChar?.chats?.[chatIndex];
                if (expectedChatId && String(verifyChat?.id || '') !== expectedChatId) {
                    return { ok: false, reason: 'chat_changed_before_save' };
                }
                persistedChat = rebaseManagedLoreOntoChat(verifyChat);
                if (!isCurrent()) return { ok: false, reason: 'runtime_lease_invalidated', canonicalWritten: true };
                const chatSaved = await RisuCompat.setChatToIndex(charIdx, chatIndex, persistedChat);
                if (chatSaved === false) return { ok: false, reason: 'chat_write_failed' };
                savedByGranularChatApi = true;
            } catch (granularSaveError) {
                if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] setChatToIndex failed; falling back to setCharacter:', granularSaveError?.message || granularSaveError);
                }
            }
        }

        if (!savedByGranularChatApi) {
            // setCharacter mutates the currently selected character.  It is not
            // a safe fallback for an explicit background target.
            if (explicitTarget) {
                if (charIdx < 0 || !RisuCompat.has('setCharacterToIndex')) {
                    return { ok: false, reason: 'target_granular_writer_unavailable' };
                }
                const verifyResolved = await resolveChatContextByTarget(explicitTarget, { allowActiveFallback: false });
                if (!verifyResolved?.ok) return { ok: false, reason: verifyResolved?.reason || 'target_changed_before_save' };
                persistedChat = rebaseManagedLoreOntoChat(verifyResolved.chat);
                const checkpointChar = await buildCheckpointChar(verifyResolved.char, persistedChat);
                const saved = await RisuCompat.setCharacterToIndex(charIdx, checkpointChar);
                if (saved === false) return { ok: false, reason: 'target_character_write_failed' };
                savedByGranularChatApi = true;
            }
        }

        if (!savedByGranularChatApi) {
            const verifyChar = await RisuCompat.getCharacter();
            const verifyChat = verifyChar?.chats?.[chatIndex];
            if (expectedChatId && String(verifyChat?.id || '') !== expectedChatId) {
                return { ok: false, reason: 'chat_changed_before_save' };
            }
            persistedChat = rebaseManagedLoreOntoChat(verifyChat);
            const checkpointChar = await buildCheckpointChar(verifyChar, persistedChat);
            if (await RisuCompat.setCharacter(checkpointChar) === false) return { ok: false, reason: 'character_write_failed' };
        }

        // Both canonical storage and host chat must acknowledge success. Failed
        // cache-first canonical saves must never produce semantic change jobs.
        let canonicalVerified = false;
        if (storageResult?.ok === true) {
            try {
                const canonical = await LibraDataStorage.readVerified(admission.scopeKey, { readonly: true });
                if (!canonical.ok || canonical.resetGeneration !== expectedGeneration || !isCurrent()
                    || LibraDataStorage.scopeKeyFor(freshChar, persistedChat) !== admission.scopeKey
                    || JSON.stringify(canonical.entries) !== JSON.stringify(libraLore)) throw new Error('acknowledged_source_changed');
                canonicalVerified = true;
                const after = TypedRecallCorpus.capture(freshChar, persistedChat, {
                    currentTurn: MemoryEngine.getCurrentTurn?.() || 0,
                    resetGeneration: canonical.resetGeneration,
                    verifiedCanonicalEntries: canonical.entries
                });
                // HME source maintenance is independent of semantic provider setup.
                // Failure of a derived graph must not undo acknowledged source data.
                try {
                    if (typedRecallBefore) void SemanticRecallJobs.onPersist(typedRecallBefore, after).catch(() => {});
                } catch (_) { /* a semantic scheduling failure cannot skip HME maintenance */ }
                await MemoryEngine.maintainHmeTypedSourceGraph(after, { guard: () => isCurrent()
                    && LibraDataStorage.scopeKeyFor(freshChar, persistedChat) === admission.scopeKey
                    && (PersonaScopeIdentity.get(freshChar, freshChat)?.resetGeneration ?? 0) === expectedGeneration });
            } catch (_) { /* indexing failure must not fail canonical conversation persistence */ }
        }
        const unpackedSavedChat = {
            ...persistedChat,
            localLore: LibraLoreConsolidator.unpack(persistedChat.localLore)
        };
        return { ok: true, canonicalVerified, chat: unpackedSavedChat, storedChat: persistedChat, chatIndex: chatIndex, charIdx: charIdx, savedByGranularChatApi };
    };
    const requireSuccessfulLorePersist = (result = null, operation = 'lore persist') => {
        if (!result?.ok) {
            throw new Error(`${operation} failed: ${result?.reason || 'unknown'}`);
        }
        return result;
    };
