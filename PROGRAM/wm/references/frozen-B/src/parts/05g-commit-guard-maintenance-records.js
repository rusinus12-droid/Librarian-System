    const markLiveSyncSnapshot = (chat, extra = {}) => {
        if (!chat) return null;
        const scopeKey = getChatMemoryScopeKey(chat);
        const latest = buildLatestAssistantSnapshot(chat, { includeStableId: true });
        const pending = MemoryState.pendingTurnCommits.get(scopeKey) || null;
        const snapshot = {
            checkedAt: Date.now(),
            messageCount: Number(latest.currentMessageCount || 0),
            latestMsgId: String(latest.latestLiveId || latest.latestStableId || '').trim(),
            latestMsgSignature: String(latest.latestMessageSignature || '').trim(),
            latestAiId: String(latest.latestLiveId || latest.latestStableId || '').trim(),
            latestAiSignature: String(latest.latestMessageSignature || '').trim(),
            latestAiHash: String(latest.latestHash || '').trim(),
            pendingKey: String(pending?.turnKey || pending?.aiHash || '').trim(),
            ...extra
        };
        MemoryState.liveSyncStateByScope.set(scopeKey, snapshot);
        return snapshot;
    };

    const getTurnMaintenanceChatId = (chat = null) => {
        const direct = String(chat?.id || '').trim();
        if (direct) return direct;
        try {
            return String(getActiveManagedChatId?.() || '').trim() || 'global';
        } catch {
            return 'global';
        }
    };

    const normalizeMaintenanceList = (value = null) => {
        if (value instanceof Set) return Array.from(value).map(v => String(v || '').trim()).filter(Boolean);
        if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
        return [];
    };

    const unionMaintenanceList = (a = null, b = null) => Array.from(new Set([
        ...normalizeMaintenanceList(a),
        ...normalizeMaintenanceList(b)
    ]));

    const mergeTurnMaintenanceState = (previousState = null, nextState = null) => {
        if (!previousState) return nextState;
        if (!nextState) return previousState;
        const merged = { ...nextState };
        const entitiesToConsolidate = unionMaintenanceList(previousState.entitiesToConsolidate, nextState.entitiesToConsolidate);
        const involvedEntities = unionMaintenanceList(previousState.involvedEntities, nextState.involvedEntities);
        if (entitiesToConsolidate.length > 0) merged.entitiesToConsolidate = entitiesToConsolidate;
        if (involvedEntities.length > 0) merged.involvedEntities = involvedEntities;
        return merged;
    };

    const mergeTurnMaintenanceRecord = (previous = null, next = null) => {
        if (!previous) return next;
        if (!next) return previous;
        return {
            ...previous,
            ...next,
            turnState: mergeTurnMaintenanceState(previous.turnState, next.turnState),
            coalescedCount: Math.max(1, Number(previous.coalescedCount || 1)) + 1,
            coalescedFromTurns: Array.from(new Set([
                ...(Array.isArray(previous.coalescedFromTurns) ? previous.coalescedFromTurns : [previous.turnForMaintenance]),
                next.turnForMaintenance
            ].map(turn => Number(turn || 0)).filter(turn => turn > 0)))
        };
    };

    const getTurnMaintenanceRecordKey = (record = null) => {
        const turn = normalizeLegacyMemoryTurnAnchor(record?.turnForMaintenance || record?.turnState?.finalizedTurn || 0);
        const anchorMeta = record?.turnState?.anchorMeta && typeof record.turnState.anchorMeta === 'object'
            ? record.turnState.anchorMeta
            : {};
        const turnKey = String(record?.turnKey || anchorMeta.turnKey || anchorMeta.sourceTurnKey || '').trim();
        const messageId = normalizeCanonicalMessageIds([
            record?.messageId,
            record?.m_id,
            record?.turnState?.m_id,
            anchorMeta.m_id,
            anchorMeta.messageId
        ])[0] || '';
        const responseHash = String(
            record?.aiHash
            || record?.sourceHash
            || anchorMeta.aiHash
            || anchorMeta.sourceHash
            || (record?.aiResponse ? TokenizerEngine.simpleHash(String(record.aiResponse || '')) : '')
            || ''
        ).trim();
        return [
            turn > 0 ? `t${turn}` : 't0',
            turnKey || messageId || responseHash || `created-${Number(record?.createdAt || 0) || Date.now()}`
        ].join('::');
    };

    const getPendingTurnMaintenanceRecords = (entry = null) => {
        if (!entry) return [];
        if (!Array.isArray(entry.pendingRecords)) entry.pendingRecords = [];
        if (entry.latest) {
            entry.pendingRecords.push(entry.latest);
            entry.latest = null;
        }
        return entry.pendingRecords;
    };

    const getCanonicalGuardMemoryIdentity = (entry = null) => {
        if (!entry || String(entry?.comment || '').trim() !== 'lmai_memory') return '';
        const split = splitManagedMemoryMetaPrefix(entry.content || '');
        let payload = null;
        try { payload = CompactMemoryCodec.parsePayloadFromContent(split.body || '') || null; } catch (_) { payload = null; }
        const slot = String(payload?.arcKey || '').trim() === 'world_rule_snapshot' ? 'world_rule_snapshot' : 'turn_summary';
        const anchor = String(split.meta?.canonicalMemoryId || split.meta?.turnKey || split.meta?.sourceHash || split.meta?.m_id || '').trim();
        return anchor ? `${anchor}::${slot}` : `${TokenizerEngine.simpleHash(String(entry.content || ''))}::${slot}`;
    };

    const buildCanonicalTurnCommitGuard = (options = {}) => ({
        schema: 'libra.canonical_turn_commit_guard.v1',
        turn: normalizeLegacyMemoryTurnAnchor(options.turn || options.anchorMeta?.turn || 0),
        turnKey: String(options.turnKey || options.anchorMeta?.turnKey || '').trim(),
        sourceHash: String(options.sourceHash || options.anchorMeta?.sourceHash || '').trim(),
        scopeKey: String(options.scopeKey || options.anchorMeta?.scopeKey || '').trim(),
        chatId: String(options.chatId || options.anchorMeta?.chatId || '').trim(),
        primaryMemoryKey: String(options.primaryMemoryKey || '').trim(),
        memoryEntries: (Array.isArray(options.memoryEntries) ? options.memoryEntries : [])
            .filter(entry => entry && String(entry?.comment || '').trim() === 'lmai_memory')
            .map(entry => ({ ...entry })),
        turnRecord: options.turnRecord && typeof options.turnRecord === 'object' ? safeClone(options.turnRecord) : null,
        rpTurnMemory: options.rpTurnMemory && typeof options.rpTurnMemory === 'object' ? safeClone(options.rpTurnMemory) : null,
        createdAt: Date.now()
    });

    const reconcileCanonicalTurnCommitGuard = (lorebook = [], guard = null, char = null, chat = null, options = {}) => {
        if (!Array.isArray(lorebook) || !guard || guard.schema !== 'libra.canonical_turn_commit_guard.v1') {
            return { ok: false, reason: 'missing_canonical_guard', restoredMemories: 0 };
        }
        const turn = normalizeLegacyMemoryTurnAnchor(guard.turn || 0);
        const scopeKey = String(guard.scopeKey || getChatRuntimeScopeKey(chat, char) || '').trim();
        let restoredMemories = 0;
        let repairedMemories = 0;
        const guardedMemories = [];
        for (const original of (Array.isArray(guard.memoryEntries) ? guard.memoryEntries : [])) {
            const candidate = { ...original };
            const refresh = refreshManagedMemoryEntryIntegrity(candidate, { scopeKey, turn, chatId: guard.chatId });
            if (!refresh.ok) {
                return { ok: false, reason: `guard_memory_integrity:${refresh.reason || 'failed'}`, restoredMemories, repairedMemories };
            }
            const identity = getCanonicalGuardMemoryIdentity(candidate);
            const existingIndex = lorebook.findIndex(entry => getCanonicalGuardMemoryIdentity(entry) === identity);
            if (existingIndex < 0) {
                lorebook.push(candidate);
                guardedMemories.push(candidate);
                restoredMemories += 1;
                continue;
            }
            const existing = lorebook[existingIndex];
            const existingRefresh = refreshManagedMemoryEntryIntegrity(existing, { scopeKey, turn, chatId: guard.chatId });
            if (!existingRefresh.ok) {
                lorebook[existingIndex] = candidate;
                guardedMemories.push(candidate);
                repairedMemories += 1;
            } else {
                guardedMemories.push(existing);
            }
        }

        let turnRecordRestored = false;
        if (guard.turnRecord) {
            const before = TurnRecordLedger.loadState(lorebook, chat, char, { scopeKey });
            const hadRecord = (before.records || []).some(record => String(record?.turnKey || '').trim() === guard.turnKey);
            TurnRecordLedger.upsertRecord(lorebook, guard.turnRecord, chat, char, { scopeKey });
            turnRecordRestored = !hadRecord;
        }

        let rpRestored = false;
        if (guard.rpTurnMemory && typeof guard.rpTurnMemory === 'object') {
            try {
                const rpResult = RPContinuityCore.upsertFromTurn(lorebook, guard.rpTurnMemory, {
                    turn,
                    entityRefs: guard.rpTurnMemory?.participants?.canonicalEntities || [],
                    source: 'canonical-commit-guard',
                    sourceMemoryKey: guard.primaryMemoryKey || `turn_key:${guard.turnKey}`
                });
                rpRestored = rpResult?.changed === true;
            } catch (error) {
                return { ok: false, reason: `guard_rp_restore:${error?.message || error}`, restoredMemories, repairedMemories };
            }
        }

        if (guardedMemories.length > 0) {
            MemoryEngine.upsertHybridScopeIndexRows(lorebook, guardedMemories, {
                scopeKey,
                currentTurn: turn,
                reason: options.reason || 'canonical-commit-guard'
            });
        }
        return {
            ok: true,
            turn,
            turnKey: guard.turnKey,
            restoredMemories,
            repairedMemories,
            turnRecordRestored,
            rpRestored,
            guardedMemoryCount: guardedMemories.length
        };
    };

    const verifyCanonicalTurnCommitGuard = (lorebook = [], guard = null, char = null, chat = null) => {
        if (!Array.isArray(lorebook) || !guard || guard.schema !== 'libra.canonical_turn_commit_guard.v1') {
            return { ok: false, reason: 'missing_canonical_guard' };
        }
        const scopeKey = String(guard.scopeKey || getChatRuntimeScopeKey(chat, char) || '').trim();
        const expectedIdentities = (guard.memoryEntries || []).map(getCanonicalGuardMemoryIdentity).filter(Boolean);
        const memoryChecks = expectedIdentities.map(identity => {
            const entry = lorebook.find(candidate => getCanonicalGuardMemoryIdentity(candidate) === identity) || null;
            const validation = entry ? refreshManagedMemoryEntryIntegrity(entry, { scopeKey, turn: guard.turn, chatId: guard.chatId }) : { ok: false, reason: 'missing' };
            return { identity, ok: !!entry && validation.ok === true, reason: validation.reason || '' };
        });
        const ledger = TurnRecordLedger.loadState(lorebook, chat, char, { scopeKey });
        const hasTurnRecord = (ledger.records || []).some(record => String(record?.turnKey || '').trim() === guard.turnKey);
        // 롤백 저널 기반 검증은 삭제됐다 (스냅샷 롤백 기능 제거).
        const ok = memoryChecks.every(check => check.ok) && hasTurnRecord;
        return { ok, reason: ok ? 'ok' : 'canonical_artifact_missing', memoryChecks, hasTurnRecord, turn: guard.turn, turnKey: guard.turnKey };
    };

    // Recover only an exact, active canonical commit in the admitted generation.
    // A matching message ID alone is not a commit proof: edits/rerolls change hash.
    const findVerifiedCanonicalTurnCommit = async (char, chat, expected = {}) => {
        const ids = normalizeCanonicalMessageIds(expected.liveMessageIds);
        const hash = String(expected.sourceHash || '').trim();
        const signature = compactTurnMessageSignature(expected.messageSignature || '');
        if (!hash || !signature || !ids.length) return null;
        const matches = record => record?.status === 'active'
            && record.sourceHash === hash
            && record.turnKey === buildCanonicalTurnKey(chat.id, record.userTurnKey || '', hash, signature, ids)
            && hasCanonicalMessageIdOverlap(record.liveMessageIds, ids)
            && (!expected.turnKey || record.turnKey === expected.turnKey);
        const lore = MemoryEngine.getLorebook(char, chat);
        if (!TurnRecordLedger.loadState(lore, chat, char).records.some(matches)) return null;
        const canonicalScope = LibraDataStorage.scopeKeyFor(char, chat);
        if (expected.canonicalScope && expected.canonicalScope !== canonicalScope) throw new Error('canonical_retry_scope_changed');
        const verified = await LibraDataStorage.readVerified(canonicalScope, { readonly: true });
        if (!verified.ok || verified.resetGeneration !== Number(expected.resetGeneration ?? 0)) throw new Error('canonical_retry_read_unverified');
        const entries = safeClone(verified.entries);
        const record = TurnRecordLedger.loadState(entries, chat, char).records.find(matches);
        if (!record) return null;
        const memories = entries.filter(entry => {
            if (entry?.comment !== 'lmai_memory') return false;
            const meta = splitManagedMemoryMetaPrefix(entry.content || '').meta || {};
            return meta.turnKey === record.turnKey && meta.sourceHash === hash;
        });
        if (record.memoryKey && !memories.length) throw new Error('canonical_retry_memory_missing');
        const guard = buildCanonicalTurnCommitGuard({
            turn: record.turn, turnKey: record.turnKey, sourceHash: hash,
            scopeKey: getChatRuntimeScopeKey(chat, char), chatId: chat.id,
            primaryMemoryKey: record.memoryKey, memoryEntries: memories, turnRecord: record
        });
        if (!verifyCanonicalTurnCommitGuard(entries, guard, char, chat).ok) throw new Error('canonical_retry_guard_failed');
        return { record, memories, guard };
    };

    const upsertPendingTurnMaintenanceRecord = (entry = null, record = null) => {
        if (!entry || !record) return null;
        const pending = getPendingTurnMaintenanceRecords(entry);
        const key = getTurnMaintenanceRecordKey(record);
        const idx = pending.findIndex(item => getTurnMaintenanceRecordKey(item) === key);
        if (idx >= 0) pending[idx] = mergeTurnMaintenanceRecord(pending[idx], record);
        else pending.push(record);
        pending.sort((a, b) => {
            const turnA = normalizeLegacyMemoryTurnAnchor(a?.turnForMaintenance || 0);
            const turnB = normalizeLegacyMemoryTurnAnchor(b?.turnForMaintenance || 0);
            if (turnA !== turnB) return turnA - turnB;
            return (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0);
        });
        const pendingLimit = ResourceGovernor.getPendingMaintenanceLimit();
        while (pending.length > pendingLimit && pending.length > 1) {
            const oldest = pending.shift();
            pending[0] = mergeTurnMaintenanceRecord(oldest, pending[0]);
        }
        ResourceGovernor.touch('turn-maintenance-upsert');
        return pending.find(item => getTurnMaintenanceRecordKey(item) === key) || pending[pending.length - 1] || record;
    };

    const shiftPendingTurnMaintenanceRecord = (entry = null) => {
        const pending = getPendingTurnMaintenanceRecords(entry);
        return pending.shift() || null;
    };

    const buildTurnMaintenanceRecord = (char, chat, turnState, aiResponse, turnForMaintenance, maintenanceConfig, options = {}) => {
        const createdAt = Date.now();
        const baseConfig = maintenanceConfig || MemoryEngine.CONFIG;
        const analysisBudgetMs = normalizeAfterRequestAnalysisBudgetMs(baseConfig?.afterRequestAnalysisBudgetMs ?? 480000, 480000);
        const sourceDeadlineAt = Math.max(0, Number(turnState?.targetContext?.analysisDeadlineAt || baseConfig?.__analysisDeadlineAt || 0) || 0);
        const analysisDeadlineAt = Math.min(
            createdAt + analysisBudgetMs,
            sourceDeadlineAt > 0 ? sourceDeadlineAt : Number.MAX_SAFE_INTEGER
        );
        return {
            char,
            chat,
            chatId: getTurnMaintenanceChatId(chat),
            scopeKey: String(turnState?.targetContext?.scopeKey || getChatRuntimeScopeKey(chat, char) || getChatMemoryScopeKey(chat)).trim(),
            targetContext: {
                resetGeneration: turnState?.targetContext?.resetGeneration ?? 0,
                canonicalScope: String(turnState?.targetContext?.canonicalScope || '').trim(),
                characterId: String(turnState?.targetContext?.characterId || char?.id || char?.chaId || '').trim(),
                characterIndex: normalizeRisuIndex(turnState?.targetContext?.characterIndex ?? turnState?.targetContext?.charIndex),
                chatId: String(turnState?.targetContext?.chatId || chat?.id || '').trim(),
                chatIndex: normalizeRisuIndex(turnState?.targetContext?.chatIndex),
                scopeKey: String(turnState?.targetContext?.scopeKey || getChatRuntimeScopeKey(chat, char) || getChatMemoryScopeKey(chat) || '').trim(),
                runtimeScopeKey: String(turnState?.targetContext?.runtimeScopeKey || getChatRuntimeScopeKey(chat, char) || '').trim(),
                requestSequence: Math.max(0, Number(turnState?.targetContext?.requestSequence || 0)),
                durableLedgerRecordId: String(turnState?.targetContext?.durableLedgerRecordId || '').trim(),
                durableLedgerRecordKey: String(turnState?.targetContext?.durableLedgerRecordKey || '').trim(),
                mainResponseLanguageTarget: normalizeInternalDataLanguageTarget(turnState?.targetContext?.mainResponseLanguageTarget || ''),
                analysisDeadlineAt
            },
            turnState,
            aiResponse,
            turnForMaintenance,
            maintenanceConfig: {
                ...baseConfig,
                mainResponseLanguageTarget: normalizeInternalDataLanguageTarget(
                    turnState?.targetContext?.mainResponseLanguageTarget
                    || baseConfig?.mainResponseLanguageTarget
                    || ''
                ),
                afterRequestAnalysisBudgetMs: analysisBudgetMs,
                __analysisDeadlineAt: analysisDeadlineAt
            },
            createdAt,
            analysisDeadlineAt,
            canonicalCommitGuard: options?.canonicalCommitGuard || null,
            coalescedCount: 1,
            coalescedFromTurns: [Number(turnForMaintenance || 0)].filter(Boolean)
        };
    };

    const updateTurnMaintenanceActivity = (record = null, patch = {}) => {
        const activityContext = record?.activityContext || null;
        if (!activityContext) return;
        try {
            ActivityDashboardCore.update(activityContext, {
                phase: 'afterRequest:maintenance',
                status: patch.status || 'running',
                progress: patch.progress,
                step: patch.step || '후처리 분석',
                stepStatus: patch.stepStatus || 'running',
                activeTask: patch.activeTask || patch.step || '후처리 분석',
                postprocessPhase: patch.postprocessPhase || 'afterRequest:maintenance',
                postprocessDetail: patch.postprocessDetail || patch.message || '',
                message: patch.message || patch.postprocessDetail || ''
            });
        } catch (error) {
            recordSuppressedRuntimeError('turn_maintenance.activity_update', error, {
                step: patch.step || '',
                activeTask: patch.activeTask || ''
            });
        }
    };
