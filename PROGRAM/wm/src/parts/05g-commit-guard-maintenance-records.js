    // Private RAM capability: neither copied flags nor serialized config can manufacture ownership.
    const WmAnalysisSnapshotOwner = (() => {
        const tokensByConfig = new WeakMap();
        const proofs = new WeakMap();
        const bind = (record, receipt, config) => {
            if (!record || !receipt || !wmPrivateAnalysisCaptures.has(config)
                || !isLibraRuntimeEpochActive()) throw new Error('analysis_snapshot_binding_invalid');
            const token = Object.freeze({});
            proofs.set(token, { config, recordKey: receipt.recordKey, recordId: receipt.recordId,
                scopeKey: receipt.scopeKey, resetGeneration: receipt.resetGeneration, epoch: LIBRA_RUNTIME_EPOCH });
            tokensByConfig.set(config, token);
            record.maintenanceConfig = config;
            return token;
        };
        const fromRecord = record => record?.maintenanceConfig && tokensByConfig.get(record.maintenanceConfig) || null;
        const matches = (token, receipt) => {
            const proof = token && proofs.get(token);
            return !!proof && proof.epoch === LIBRA_RUNTIME_EPOCH && isLibraRuntimeEpochActive()
                && wmPrivateAnalysisCaptures.has(proof.config)
                && proof.recordKey === receipt?.recordKey && proof.recordId === receipt?.recordId
                && proof.scopeKey === receipt?.scopeKey && proof.resetGeneration === receipt?.resetGeneration;
        };
        const config = token => token && proofs.get(token)?.config || null;
        return Object.freeze({ bind, fromRecord, matches, config });
    })();

    // Classification consumes a fresh verified lifecycle read, never an imported 'started' flag.
    const classifyWmAnalysisAdmission = (receipt, snapshotBinding = null, context = {}) => {
        const unknown = reason => ({ kind: 'unverified', reason });
        const expected = context.expectedHandle;
        if (context.verified !== true || context.runtimeCurrent !== true
            || context.writerProtocolVerified !== true || !receipt || receipt.version !== 2
            || !expected?.recordKey || !expected?.recordId || !expected?.scopeKey
            || receipt.recordKey !== expected.recordKey || receipt.recordId !== expected.recordId
            || receipt.scopeKey !== expected.scopeKey
            || !Number.isSafeInteger(context.expectedResetGeneration)
            || context.expectedResetGeneration < 0
            || receipt.resetGeneration !== context.expectedResetGeneration) return unknown('analysis_lifecycle_unverified');
        const markerFields = ['analysisStartedAt', 'analysisFinishedAt', 'analysisRecoveryAttempt'];
        if (markerFields.some(field => receipt[field] !== undefined
            && (!Number.isSafeInteger(receipt[field]) || receipt[field] < 0))) return unknown('analysis_marker_invalid');
        const status = typeof receipt.analysisStatus === 'string' ? receipt.analysisStatus : '';
        if (['done', 'committed', 'skipped', 'terminal', 'discarded', 'deadline', 'blocked_host_source_changed'].includes(status)
            || ['skipped', 'terminal', 'discarded'].includes(String(receipt.status || ''))) {
            return { kind: 'closed', reason: 'analysis_receipt_closed' };
        }
        // Positive markers prove prior activity only for the known writer states.
        // Unknown metadata must not authorize resume or a permanent interruption repair.
        if (!['pending', 'queued', 'deferred', 'replaying', 'awaiting_host_anchor', 'running', 'failed'].includes(status)) {
            return unknown('analysis_start_state_unproven');
        }
        if (markerFields.some(field => receipt[field] > 0)) {
            if (Number.isSafeInteger(context.maxRecoveryAttempts) && context.maxRecoveryAttempts >= 0
                && Number(receipt.analysisRecoveryAttempt || 0) >= context.maxRecoveryAttempts) {
                return { kind: 'closed', reason: 'analysis_recovery_exhausted' };
            }
            if (WmAnalysisSnapshotOwner.matches(snapshotBinding, receipt)) return { kind: 'resume', reason: 'analysis_snapshot_owned' };
            return { kind: 'interrupted', reason: 'analysis_snapshot_unavailable' };
        }
        if (['pending', 'queued', 'deferred', 'replaying', 'awaiting_host_anchor'].includes(status)) {
            return { kind: 'new', reason: 'analysis_never_started' };
        }
        return unknown('analysis_start_state_unproven');
    };

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

    const hasOwnedTurnMaintenanceSnapshot = record => WmAnalysisSnapshotOwner.matches(
        WmAnalysisSnapshotOwner.fromRecord(record), {
            recordKey: record?.targetContext?.durableLedgerRecordKey,
            recordId: record?.targetContext?.durableLedgerRecordId,
            scopeKey: record?.targetContext?.scopeKey || record?.scopeKey,
            resetGeneration: record?.targetContext?.resetGeneration ?? 0
        });

    const mergeTurnMaintenanceRecord = (previous = null, next = null) => {
        if (!previous) return next;
        if (!next) return previous;
        if (hasOwnedTurnMaintenanceSnapshot(previous)) {
            return hasOwnedTurnMaintenanceSnapshot(next)
                && next.maintenanceConfig === previous.maintenanceConfig
                && getTurnMaintenanceRecordKey(next) === getTurnMaintenanceRecordKey(previous)
                && Number(next.analysisRecoveryAttempt || 0) > Number(previous.analysisRecoveryAttempt || 0)
                ? next : previous;
        }
        if (hasOwnedTurnMaintenanceSnapshot(next)) return next;
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
        const pin = entry.pinnedAnalysisRecord;
        if (pin && hasOwnedTurnMaintenanceSnapshot(pin)
            && !entry.pendingRecords.some(item => getTurnMaintenanceRecordKey(item) === getTurnMaintenanceRecordKey(pin))) {
            entry.pendingRecords.unshift(pin);
        }
        return entry.pendingRecords;
    };
    const getNextPendingTurnMaintenanceRecord = entry => {
        const pending = getPendingTurnMaintenanceRecords(entry);
        if (entry?.pinnedAnalysisRecord && hasOwnedTurnMaintenanceSnapshot(entry.pinnedAnalysisRecord)) {
            return entry.pinnedRetryReady === true ? entry.pinnedAnalysisRecord : null;
        }
        return pending[0] || null;
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
        return { record, memories, guard,expectedSource:verified.authoritySource||null };
    };

    const upsertPendingTurnMaintenanceRecord = (entry = null, record = null) => {
        if (!entry || !record) return null;
        const pending = getPendingTurnMaintenanceRecords(entry);
        const key = getTurnMaintenanceRecordKey(record);
        const idx = pending.findIndex(item => getTurnMaintenanceRecordKey(item) === key);
        if (idx >= 0) pending[idx] = mergeTurnMaintenanceRecord(pending[idx], record);
        else pending.push(record);
        pending.sort((a, b) => {
            const ownedOrder = Number(hasOwnedTurnMaintenanceSnapshot(b)) - Number(hasOwnedTurnMaintenanceSnapshot(a));
            if (ownedOrder) return ownedOrder;
            const turnA = normalizeLegacyMemoryTurnAnchor(a?.turnForMaintenance || 0);
            const turnB = normalizeLegacyMemoryTurnAnchor(b?.turnForMaintenance || 0);
            if (turnA !== turnB) return turnA - turnB;
            return (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0);
        });
        const pendingLimit = ResourceGovernor.getPendingMaintenanceLimit();
        while (pending.length > pendingLimit && pending.length > 1) {
            const unstarted = pending.map((item, index) => hasOwnedTurnMaintenanceSnapshot(item) ? -1 : index).filter(index => index >= 0);
            if (unstarted.length < 2) break;
            const oldest = pending[unstarted[0]];
            pending[unstarted[1]] = mergeTurnMaintenanceRecord(oldest, pending[unstarted[1]]);
            pending.splice(unstarted[0], 1);
        }
        ResourceGovernor.touch('turn-maintenance-upsert');
        return pending.find(item => getTurnMaintenanceRecordKey(item) === key) || pending[pending.length - 1] || record;
    };

    const pinTurnMaintenanceSnapshot = (record, ready = false) => {
        if (!record?.chatId || !hasOwnedTurnMaintenanceSnapshot(record)) return null;
        let entry = MemoryState.turnMaintenanceSchedulesByChatId.get(record.chatId);
        if (!entry) {
            entry = { chatId: record.chatId, timer: null, queued: false, running: false,
                latest: null, pendingRecords: [], lastFinishedAt: 0 };
            MemoryState.turnMaintenanceSchedulesByChatId.set(record.chatId, entry);
        }
        const previous = entry.pinnedAnalysisRecord;
        if (previous && hasOwnedTurnMaintenanceSnapshot(previous)
            && (previous.maintenanceConfig !== record.maintenanceConfig
                || getTurnMaintenanceRecordKey(previous) !== getTurnMaintenanceRecordKey(record))) return null;
        entry.pinnedAnalysisRecord = record;
        entry.pinnedRetryReady = ready === true;
        upsertPendingTurnMaintenanceRecord(entry, record);
        return entry;
    };
    const readyTurnMaintenanceSnapshot = record => {
        const entry = MemoryState.turnMaintenanceSchedulesByChatId.get(record?.chatId);
        const pin = entry?.pinnedAnalysisRecord;
        if (!pin || pin.maintenanceConfig !== record?.maintenanceConfig
            || getTurnMaintenanceRecordKey(pin) !== getTurnMaintenanceRecordKey(record)
            || !hasOwnedTurnMaintenanceSnapshot(pin)) return false;
        entry.pinnedRetryReady = true;
        return true;
    };
    const releaseTurnMaintenanceSnapshot = (record, terminal = false) => {
        const entry = MemoryState.turnMaintenanceSchedulesByChatId.get(record?.chatId);
        const pin = entry?.pinnedAnalysisRecord;
        if (!pin || pin.maintenanceConfig !== record?.maintenanceConfig
            || getTurnMaintenanceRecordKey(pin) !== getTurnMaintenanceRecordKey(record)
            || (!terminal && Number(record.analysisRecoveryAttempt || 0) < Number(pin.analysisRecoveryAttempt || 0))) return false;
        entry.pinnedAnalysisRecord = null;
        entry.pinnedRetryReady = false;
        entry.pendingRecords = (entry.pendingRecords || []).filter(item => item.maintenanceConfig !== pin.maintenanceConfig
            || getTurnMaintenanceRecordKey(item) !== getTurnMaintenanceRecordKey(pin));
        if (!entry.running && !entry.queued && entry.pendingRecords.length && isLibraRuntimeEpochActive()) {
            scheduleTurnMaintenanceRecord(null, { existingEntry: entry, reason: 'analysis-snapshot-released' });
        }
        return true;
    };
    const shiftPendingTurnMaintenanceRecord = (entry = null) => {
        const pending = getPendingTurnMaintenanceRecords(entry);
        const record = getNextPendingTurnMaintenanceRecord(entry);
        if (!record) return null;
        const index = pending.indexOf(record);
        if (index >= 0) pending.splice(index, 1);
        return record;
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
