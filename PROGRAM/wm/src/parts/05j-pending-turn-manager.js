    const PendingTurnManager = (() => {
        // Runtime-only projections. The durable raw ledger owns recovery; no queue
        // metadata is copied into pending payloads, receipts, or model inputs.
        const PENDING_QUEUE_LIMIT = 64; // includes the head
        const queues = new WeakMap();
        const owners = new WeakMap();
        const timerOwners = new WeakMap();
        const durableOnly = new Map();
        const orderCursors = new Map();
        let durableReplayScheduler = null;
        const setDurableReplayScheduler = scheduler => { durableReplayScheduler = typeof scheduler === 'function' ? scheduler : null; };
        const needsReplay = scopeKey => {
            const lease = durableOnly.get(String(scopeKey || ''));
            if (lease && RuntimeStateLease.isCurrent(lease)) return entriesFor(MemoryState.pendingTurnCommits.get(String(scopeKey || ''))).length < PENDING_QUEUE_LIMIT;
            durableOnly.delete(String(scopeKey || ''));
            return false;
        };
        const noteDurableReplayBacklog = target => {
            const scopeKey = String(target?.scopeKey || ''), lease = RuntimeStateLease.capture();
            if (!scopeKey || (target?.runtimeScopeKey && target.runtimeScopeKey !== lease.scopeKey)) return false;
            durableOnly.set(scopeKey, lease); return true;
        };
        const requestDurableReplay = (pending, force = false) => {
            const owner = owners.get(pending);
            if (!owner || !RuntimeStateLease.isCurrent(owner.lease) || !durableReplayScheduler) return false;
            if (!force && !needsReplay(owner.scopeKey)) return false;
            if (force) durableOnly.set(owner.scopeKey, owner.lease);
            if (entriesFor(MemoryState.pendingTurnCommits.get(owner.scopeKey)).length >= PENDING_QUEUE_LIMIT) return false;
            return durableReplayScheduler({ ...pending.targetContext, runtimeScopeKey: owner.lease.scopeKey });
        };
        const rawHandle = pending => ({
            recordKey: String(pending?.targetContext?.durableLedgerRecordKey || ''),
            recordId: String(pending?.targetContext?.durableLedgerRecordId || ''),
            scopeKey: String(pending?.targetContext?.scopeKey || '')
        });
        const recordDeferred = async (pending, reason, analysisStatus = 'awaiting_host_anchor') => {
            const handle = rawHandle(pending);
            if (!handle.recordKey) return { ok: false, reason: 'durable_receipt_unavailable' };
            const owner = owners.get(pending);
            const current = () => owners.get(pending) === owner && !!owner && RuntimeStateLease.isCurrent(owner.lease)
                && (!!owner.blockedReason || ownerIsCurrent(pending));
            return DurableTurnLedger.markStatus(handle, {
                status: 'observed', analysisStatus, deferredReason: reason, commitStatus: 'waiting',
                turn: 0, turnKey: '', deferredAt: Date.now()
            }, {requireUncommitted:true,isCurrent:current});
        };
        const identity = pending => {
            const target = pending?.targetContext || {};
            const receipt = String(target.durableLedgerRecordKey || target.durableLedgerRecordId || '').trim();
            if (receipt) return `receipt:${receipt}`;
            return JSON.stringify([target.scopeKey || '', target.resetGeneration ?? 0,
                pending?.requestSequence || target.requestSequence || 0, pending?.originMessageCount ?? pending?.messageCount ?? 0,
                pending?.sourceHash || pending?.aiHash || '', pending?.messageSignature || '', pending?.liveMessageIds || []]);
        };
        const entriesFor = head => head ? (queues.get(head) || [head]) : [];
        const ownerIsCurrent = pending => {
            const owner = owners.get(pending);
            if (!owner || !RuntimeStateLease.isCurrent(owner.lease)) return false;
            const head = MemoryState.pendingTurnCommits.get(owner.scopeKey);
            return entriesFor(head).includes(pending);
        };
        const hasPendingReceipt = record => Array.from(MemoryState.pendingTurnCommits.values()).some(head =>
            entriesFor(head).some(pending => ownerIsCurrent(pending) && (
                (!!record?.recordKey && String(pending.targetContext?.durableLedgerRecordKey || '') === String(record.recordKey))
                || (!!record?.recordId && String(pending.targetContext?.durableLedgerRecordId || '') === String(record.recordId))
            )));

        const findScopedMapKey = (map, chat = null, payload = null) => {
            const explicit = String(payload?.targetContext?.scopeKey || payload?.scopeKey || '').trim();
            if (explicit && map.has(explicit)) return explicit;
            const legacy = String(getChatMemoryScopeKey(chat) || '').trim();
            if (legacy && map.has(legacy)) return legacy;
            const chatId = String(payload?.targetContext?.chatId || payload?.chatId || chat?.id || '').trim();
            if (chatId) {
                for (const [key, value] of map.entries()) {
                    if (String(value?.targetContext?.chatId || value?.chatId || '').trim() === chatId) return key;
                }
            }
            return explicit || legacy || chatId || 'global';
        };

        const getPending = (chat, payload = null) => {
            return MemoryState.pendingTurnCommits.get(findScopedMapKey(MemoryState.pendingTurnCommits, chat, payload)) || null;
        };

    
    // Only this accepted source pair is observed. A guarded legacy pair may
    // advance the canonical cutoff, but never gains fabricated native IDs.
    const buildWorldlinePairsFromChat = (chat, char, finalizedTurn, pending, latest, receipt) => {
        if (latest?.hostMessageAccepted !== true || !latest?.resolvedHash) return [];
        const target = pending?.targetContext || {};
        if (target.runtimeScopeKey && getChatRuntimeScopeKey(chat, char) !== target.runtimeScopeKey) return [];
        if (target.canonicalScope && LibraDataStorage.scopeKeyFor(char, chat, null) !== target.canonicalScope) return [];
        const bound = receipt?.state === 'bound';
        const index = Number(bound ? receipt.originMessageCount : (pending?.originMessageCount ?? pending?.messageCount));
        if (!Number.isInteger(index) || index < 1
            || (!bound && latest.matchedMessageIndex >= 0 && latest.matchedMessageIndex !== index)) return [];
        const messages = getChatMessages(chat), user = messages[index - 1], assistant = messages[index];
        if (!user || !assistant || !isUserLikeMessage(user) || isUserLikeMessage(assistant)
            || [user, assistant].some(message => message.isOOC || message.isComment || message.disabled)) return [];
        const readText = message => {
            const values = ['data', 'content', 'text'].filter(key => typeof message?.[key] === 'string').map(key => message[key]);
            return values.length && values.every(value => value === values[0]) ? values[0] : null;
        };
        const userText = readText(user), rawAssistant = readText(assistant);
        if (userText === null || rawAssistant === null) return [];
        const assistantText = String(Utils.getMemorySourceText(rawAssistant) || '').trim();
        if (!assistantText || String(TokenizerEngine.simpleHash(assistantText)) !== String(latest.resolvedHash)) return [];
        const expectedUser = String(Utils.getMemorySourceText(pending.sourceCapture?.userText
            ?? pending.userMsgForMemory ?? pending.userMsgForNarrative ?? '') || '').trim();
        if (String(Utils.getMemorySourceText(userText) || '').trim() !== expectedUser) return [];
        const userIds = LibraTurnWorldline.nativeMessageIds(user), assistantIds = LibraTurnWorldline.nativeMessageIds(assistant);
        const topology = LibraTurnWorldline.buildTopologyPairs(chat);
        if (!topology.complete || [...userIds, ...assistantIds].some(id => topology.nativeIdCounts.get(id) !== 1)) return [];
        if (assistantIds.length && !assistantIds.some(id => (latest.latestIds || []).includes(id))) return [];
        if (!bound) {
            const source = pending.sourceCapture;
            if (source?.state === 'captured' && (receipt?.reason !== 'accepted_assistant_identity_mismatch' || assistantIds.length)) return [];
            if (source?.state === 'unsupported' && (source.reason !== 'native_request_user_identity_ambiguous' || userIds.length)) return [];
        }
        return [{ pairIndex: finalizedTurn, userText, assistantText,
            userMessageId: bound ? (receipt.userIds[0] || '') : '',
            assistantMessageId: bound ? (receipt.assistantIds[0] || '') : '',
            // Verification-only metadata is dropped by the worldline reducer.
            sourcePosition: index, sourceUserIds: userIds, sourceAssistantIds: assistantIds }];
    };

    const getFinalizedTurnMeta = (chat, payload = null) => MemoryState.finalizedTurnMetaByScope.get(findScopedMapKey(MemoryState.finalizedTurnMetaByScope, chat, payload)) || null;

        const setFinalizedTurnMeta = (chat, meta = {}) => {
            const scopeKey = String(meta?.targetContext?.scopeKey || findScopedMapKey(MemoryState.finalizedTurnMetaByScope, chat, meta)).trim();
            const liveMessageIds = normalizeCanonicalMessageIds(meta?.liveMessageIds || meta?.sourceMessageIds || meta?.messageId || meta?.m_id);
            const turn = normalizeLegacyMemoryTurnAnchor(
                meta?.turn
                || meta?.turnAnchor
                || meta?.turnAnchorTurn
                || meta?.lockedTurn
                || meta?.finalizedTurn
            );
            const sourceHash = String(meta?.sourceHash || meta?.aiHash || '').trim();
            const userTurnKey = String(meta?.userTurnKey || '').trim();
            const messageSignature = String(meta?.messageSignature || '').trim();
            const normalized = {
                turn,
                turnAnchor: turn,
                turnAnchorTurn: turn,
                lockedTurn: turn,
                finalizedTurn: turn,
                aiHash: String(meta?.aiHash || sourceHash || '').trim(),
                sourceHash,
                userTurnKey,
                messageId: getPrimaryCanonicalMessageId(liveMessageIds, true) || null,
                liveMessageIds,
                messageSignature,
                turnKey: String(meta?.turnKey || buildCanonicalTurnKey(chat?.id || '', userTurnKey, sourceHash, messageSignature, liveMessageIds)).trim(),
                messageCount: Number(meta?.messageCount || 0),
                finalizedAt: Number(meta?.finalizedAt || Date.now()),
                reason: String(meta?.reason || 'stabilized').trim() || 'stabilized',
                runtimeMode: String(meta?.runtimeMode || 'turn-anchor').trim() || 'turn-anchor',
                runtimeReliability: String(meta?.runtimeReliability || 'normal').trim() || 'normal'
                ,chatId: String(meta?.targetContext?.chatId || meta?.chatId || chat?.id || '').trim()
                ,targetContext: meta?.targetContext && typeof meta.targetContext === 'object' ? safeClone(meta.targetContext) : null
            };
            MemoryState.finalizedTurnMetaByScope.set(scopeKey, normalized);
            return normalized;
        };

        const getPendingComparableHashes = (chat) => {
            const pending = getPending(chat);
            if (!pending?.aiHash) return new Set();
            return new Set([pending.aiHash]);
        };

        const isLikelyAlreadyFinalized = (chat, payload = {}) => {
            const finalized = getFinalizedTurnMeta(chat, payload);
            if (!finalized) return false;
            const incomingHash = String(payload?.aiHash || payload?.sourceHash || '').trim();
            if (incomingHash && finalized.sourceHash && incomingHash !== finalized.sourceHash) return false;
            // Equal response text is not turn identity. Distinct raw receipts must
            // reach host-anchor verification, even when both user and AI repeat.
            const incomingReceipt = String(payload?.targetContext?.durableLedgerRecordId || '').trim();
            const finalizedReceipt = String(finalized.targetContext?.durableLedgerRecordId || '').trim();
            if (incomingReceipt && finalizedReceipt) {
                return incomingReceipt === finalizedReceipt && !!incomingHash && incomingHash === finalized.sourceHash;
            }
            const incomingIds = normalizeCanonicalMessageIds(payload?.liveMessageIds || payload?.sourceMessageIds || payload?.initialMessageId || payload?.messageId);
            if (incomingIds.length) return hasCanonicalMessageIdOverlap(incomingIds, finalized.liveMessageIds || finalized.messageId);
            const incomingSignature = String(payload?.messageSignature || '').trim();
            return !!incomingSignature && incomingSignature === finalized.messageSignature;
        };

        const registerPending = (chat, payload, options = {}) => {
            if (!chat || !payload?.aiHash) return null;
            if (isLikelyAlreadyFinalized(chat, payload)) return null;
            const key = String(payload?.targetContext?.scopeKey || getChatMemoryScopeKey(chat)).trim();
            const head = MemoryState.pendingTurnCommits.get(key);
            const queue = entriesFor(head);
            const prior = queue.find(entry => identity(entry) === identity(payload));
            if (prior && ownerIsCurrent(prior)) return prior;
            const prev = null; // a distinct receipt never inherits another owner's clocks
            const liveMessageIds = normalizeCanonicalMessageIds(
                payload?.liveMessageIds
                || payload?.sourceMessageIds
                || payload?.initialMessageId
                || payload?.messageId
            );
            const sourceHash = String(payload?.sourceHash || payload?.aiHash || '').trim();
            const userTurnKey = String(payload?.userTurnKey || buildLogicalUserTurnKey(payload?.userMsgForNarrative, payload?.userMsgForMemory, payload?.autoContinueTurn)).trim();
            const messageSignature = String(payload?.messageSignature || '').trim();
            const anchorTurn = normalizeLegacyMemoryTurnAnchor(
                payload?.turnAnchor
                || payload?.turnAnchorTurn
                || payload?.lockedTurn
                || payload?.finalizedTurn
                || payload?.liveTurn
                || payload?.predictedTurn
                || (Number(MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) + 1)
            );
            const next = {
                ...payload,
                chatId: chat?.id || null,
                createdAt: prev?.aiHash === payload.aiHash ? Number(prev?.createdAt || Date.now()) : Date.now(),
                firstSeenAt: prev?.aiHash === payload.aiHash ? Number(prev?.firstSeenAt || Date.now()) : Date.now(),
                lastSeenAt: 0,
                stableMatches: prev?.aiHash === payload.aiHash ? Number(prev.stableMatches || 0) : 0,
                finalizeRetryAttempts: prev?.aiHash === payload.aiHash ? Number(prev.finalizeRetryAttempts || 0) : 0,
                finalizeRetryStartedAt: prev?.aiHash === payload.aiHash ? Number(prev.finalizeRetryStartedAt || 0) : 0,
                finalizeRetryExhaustedAt: 0,
                observedMessageId: prev?.aiHash === payload.aiHash ? (prev.observedMessageId || null) : null,
                observedHash: prev?.aiHash === payload.aiHash ? (prev.observedHash || null) : null,
                aiHash: String(payload.aiHash || sourceHash).trim(),
                sourceHash,
                userTurnKey,
                liveMessageIds,
                sourceMessageIds: liveMessageIds,
                initialMessageId: getPrimaryCanonicalMessageId(liveMessageIds, true) || payload?.initialMessageId || null,
                messageSignature,
                turnAnchor: anchorTurn,
                turnAnchorTurn: anchorTurn,
                lockedTurn: anchorTurn,
                finalizedTurn: anchorTurn,
                predictedTurn: anchorTurn,
                liveTurn: anchorTurn,
                turnKey: String(payload?.turnKey || buildCanonicalTurnKey(chat?.id || '', userTurnKey, sourceHash, messageSignature, liveMessageIds)).trim(),
                runtimeMode: String(payload?.runtimeMode || 'turn-anchor').trim() || 'turn-anchor',
                runtimeReliability: String(payload?.runtimeReliability || 'normal').trim() || 'normal'
            };
            owners.set(next, { scopeKey: key, lease: RuntimeStateLease.capture(), blockedReason: '', evidenceRevision: 0 });
            for (const [scope, lease] of durableOnly) if (!RuntimeStateLease.isCurrent(lease)) durableOnly.delete(scope);
            if (needsReplay(key) && options.durableReplay !== true) {
                owners.get(next).blockedReason = 'pending_durable_backlog';
                return next;
            }
            if (head && queue.length >= PENDING_QUEUE_LIMIT) {
                owners.get(next).blockedReason = 'pending_queue_capacity';
                durableOnly.set(key, RuntimeStateLease.capture());
                return next; // caller records explicit durable waiting state; never replaces the head
            }
            if (head) {
                queue.push(next);
                queues.set(head, queue);
                const headOwner = owners.get(head);
                if (headOwner) headOwner.evidenceRevision += 1;
            } else {
                queues.set(next, [next]);
                MemoryState.pendingTurnCommits.set(key, next);
            }
            enterRefreshStabilizeWindow();
            markLiveSyncSnapshot(chat, { pendingKey: next.turnKey || next.sourceHash || next.aiHash });
            return next;
        };

        const dropPending = (chat, expected = null) => {
            const pending = getPending(chat);
            if (!pending || (expected && pending !== expected)) return false;
            const scopeKey = findScopedMapKey(MemoryState.pendingTurnCommits, chat, pending);
            const queue = entriesFor(pending).slice(1);
            clearPendingFinalizeRetry(chat, pending);
            queues.delete(pending);
            owners.delete(pending);
            if (queue.length) {
                queues.set(queue[0], queue);
                MemoryState.pendingTurnCommits.set(scopeKey, queue[0]);
            } else MemoryState.pendingTurnCommits.delete(scopeKey);
            return true;
        };

        const withPendingCommitLock = async (chat, task, payload = null) => {
            const scopeKey = String(findScopedMapKey(MemoryState.pendingTurnCommits, chat, payload) || chat?.id || 'global').trim() || 'global';
            const previous = MemoryState.pendingTurnCommitLocksByScope.get(scopeKey) || Promise.resolve();
            let current = null;
            current = previous.catch(() => null).then(async () => {
                try { return await task(); }
                finally {
                    if (MemoryState.pendingTurnCommitLocksByScope.get(scopeKey) === current) {
                        MemoryState.pendingTurnCommitLocksByScope.delete(scopeKey);
                    }
                }
            });
            MemoryState.pendingTurnCommitLocksByScope.set(scopeKey, current);
            return current;
        };

        const clearPendingFinalizeRetry = (chat, payload = null) => {
            const scopeKey = String(payload?.targetContext?.scopeKey || findScopedMapKey(MemoryState.pendingFinalizeRetryTimersByScope, chat, payload) || chat?.id || 'global').trim() || 'global';
            const current = MemoryState.pendingFinalizeRetryTimersByScope.get(scopeKey);
            if (current?.timer) { try { clearTimeout(current.timer); } catch (_) {} }
            MemoryState.pendingFinalizeRetryTimersByScope.delete(scopeKey);
        };

        const schedulePendingFinalizeRetry = (char, chat, reason = 'afterRequest-stabilized-retry', delayMs = PENDING_FINALIZE_MIN_MS + 250) => {
            if (!char || !chat || typeof setTimeout !== 'function') return false;
            const pending = getPending(chat);
            if (!pending) return false;
            const scopeKey = String(pending?.targetContext?.scopeKey || findScopedMapKey(MemoryState.pendingTurnCommits, chat, pending) || chat?.id || 'global').trim() || 'global';
            const existing = MemoryState.pendingFinalizeRetryTimersByScope.get(scopeKey);
            if (timerOwners.get(existing) === pending && existing.timer) return true;
            clearPendingFinalizeRetry(chat, pending);
            const now = Date.now();
            const retryStartedAt = Math.max(0, Number(pending.finalizeRetryStartedAt || 0) || now);
            const retryAttempts = Math.max(0, Number(pending.finalizeRetryAttempts || 0));
            const owner = owners.get(pending);
            const newEvidenceWake = reason === 'afterRequest-new-pending-owner'
                && Number(owner?.evidenceRevision || 0) > Number(owner?.lastEvidenceWake || 0);
            if (newEvidenceWake) owner.lastEvidenceWake = owner.evidenceRevision;
            if (!newEvidenceWake && (
                retryAttempts >= PENDING_FINALIZE_RETRY_MAX_ATTEMPTS
                || (now - retryStartedAt) >= PENDING_FINALIZE_RETRY_MAX_AGE_MS
            )) {
                pending.finalizeRetryAttempts = retryAttempts;
                pending.finalizeRetryStartedAt = retryStartedAt;
                pending.finalizeRetryExhaustedAt = now;
                void recordDeferred(pending, 'pending_retry_exhausted').catch(() => null);
                MemoryState.pendingTurnCommits.set(findScopedMapKey(MemoryState.pendingTurnCommits, chat, pending), pending);
                if (MemoryEngine.CONFIG?.debug && !pending.finalizeRetryExhaustedLogged) {
                    pending.finalizeRetryExhaustedLogged = true;
                    recordRuntimeDebug('warn', '[LIBRA] pending finalize retry limit reached; waiting for the next host hook', {
                        scopeKey,
                        reason,
                        retryAttempts,
                        ageMs: now - retryStartedAt
                    });
                }
                return false;
            }
            pending.finalizeRetryAttempts = retryAttempts + 1;
            pending.finalizeRetryStartedAt = retryStartedAt;
            pending.finalizeRetryExhaustedAt = 0;
            MemoryState.pendingTurnCommits.set(findScopedMapKey(MemoryState.pendingTurnCommits, chat, pending), pending);
            const entry = { timer: null, scheduledAt: now, reason, attempt: pending.finalizeRetryAttempts };
            timerOwners.set(entry, pending);
            const timer = setTimeout(async () => {
                if (MemoryState.pendingFinalizeRetryTimersByScope.get(scopeKey) !== entry
                    || getPending(chat) !== pending || !ownerIsCurrent(pending)) return;
                MemoryState.pendingFinalizeRetryTimersByScope.delete(scopeKey);
                try {
                    const result = await finalizePending(char, chat, reason);
                    if (MemoryEngine.CONFIG?.debug && result?.status !== 'finalized' && result?.status !== 'already-committed' && result?.status !== 'none') {
                        recordRuntimeDebug('log', '[LIBRA] delayed pending finalize result:', result);
                    }
                } catch (error) {
                    if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA] delayed pending finalize failed:', error?.message || error);
                }
            }, Math.max(250, Number(delayMs || 0) || (PENDING_FINALIZE_MIN_MS + 250)));
            entry.timer = timer;
            MemoryState.pendingFinalizeRetryTimersByScope.set(scopeKey, entry);
            return true;
        };

        const resolveLatestPendingSnapshot = (chat, pending = {}) => {
            const currentLatest = buildLatestAssistantSnapshot(chat, { includeStableId: true });
            const pendingText = String(Utils.getMemorySourceText(pending?.aiResponseRaw || pending?.aiResponse || '') || '').trim();
            const pendingHash = String(
                (pendingText ? TokenizerEngine.simpleHash(pendingText) : '')
                || pending?.sourceHash
                || pending?.aiHash
                || ''
            ).trim();
            const pendingMessageCount = Math.max(0, Number(pending?.originMessageCount ?? pending?.messageCount ?? 0) || 0);
            const matchOptions = {
                originMessageCount: pendingMessageCount,
                expectedUserText: pending?.userMsgForMemory || pending?.userMsgForNarrative || '',
                expectedMessageIds: pending?.liveMessageIds || pending?.sourceMessageIds || [],
                allowContinuation: true,
                originLatestAssistant: pending?.originLatestAssistant || null
            };
            const exactPersisted = pendingHash
                ? findPersistedAssistantSnapshotByHash(chat, pendingHash, matchOptions)
                : null;
            const eligibleLatest = currentLatest.latestHash
                ? findPersistedAssistantSnapshotByHash(chat, currentLatest.latestHash, { ...matchOptions, allowContinuation: false })
                : null;
            const currentLatestEligible = !!eligibleLatest && eligibleLatest.latestAiMsg === currentLatest.latestAiMsg;
            const currentLatestMatchesPending = currentLatestEligible
                && !!pendingHash && currentLatest.latestHash === pendingHash;
            const latest = exactPersisted || currentLatest;
            const exactPersistedMatch = !!exactPersisted;
            const latestMatchesPending = exactPersistedMatch && latest.latestHash === pendingHash;
            const latestMessageTime = Math.max(0, Number(latest.latestAiMsg?.time || 0) || 0);
            const pendingCreatedAt = Math.max(0, Number(pending?.createdAt || 0) || 0);
            // RisuAI invokes afterRequest before editoutput/inlay processing and
            // before pushing the final role:"char" message. The persisted text may
            // therefore differ from the hook payload. Accept exactly one newly
            // persisted assistant message, but reject later/ambiguous chat growth.
            const hostPersistedAfterRequest = !!(
                exactPersistedMatch
                || (
                    currentLatestEligible
                    && currentLatest.currentMessageCount === pendingMessageCount + 1
                    && (!latestMessageTime || !pendingCreatedAt || latestMessageTime >= pendingCreatedAt - 2000)
                )
            );
            const hostMessageAccepted = latestMatchesPending || hostPersistedAfterRequest || (!pendingHash && currentLatestEligible);
            const useLatest = hostMessageAccepted;
            const pendingTurn = normalizeLegacyMemoryTurnAnchor(
                pending?.turnAnchor || pending?.turnAnchorTurn || pending?.lockedTurn || pending?.finalizedTurn || pending?.predictedTurn || 0
            );
            const latestIds = normalizeCanonicalMessageIds(useLatest
                ? [latest.latestLiveId, latest.latestStableId]
                : []
            );
            const resolvedText = String(Utils.getMemorySourceText(
                useLatest ? (latest.latestComparable || pendingText || pending?.aiResponse || '') : pendingText
            ) || '').trim();
            const resolvedHash = String(
                (resolvedText ? TokenizerEngine.simpleHash(resolvedText) : '')
                || (useLatest ? latest.latestHash : '')
                || pendingHash
                || ''
            ).trim();
            // Persistent memories must be anchored to an assistant message that
            // actually exists in the active Risu chat. Pending/synthetic IDs are
            // diagnostic-only and must never become provenance anchors.
            const resolvedMessageId = useLatest ? (getPrimaryCanonicalMessageId(latestIds, true) || null) : null;
            const resolvedSignature = String(useLatest ? latest.latestMessageSignature : '').trim();
            return {
                ...latest,
                latestIds: normalizeCanonicalMessageIds([latestIds, resolvedMessageId]),
                latestMatchesPending,
                currentLatestMatchesPending,
                historicalAssistantMatch: exactPersistedMatch && exactPersisted?.historicalMatch === true,
                matchedMessageIndex: Number.isInteger(exactPersisted?.index) ? exactPersisted.index : -1,
                hostPersistedAfterRequest,
                hostMessageAccepted,
                resolvedHash,
                resolvedSignature,
                resolvedMessageId,
                resolvedText
            };
        };

        const promoteOwned = (chat, pending) => {
            const head = getPending(chat), queue = entriesFor(head), index = queue.indexOf(pending);
            if (index <= 0 || !ownerIsCurrent(pending)) return index === 0;
            clearPendingFinalizeRetry(chat, head);
            queue.splice(index, 1); queue.unshift(pending);
            queues.delete(head); queues.set(pending, queue);
            MemoryState.pendingTurnCommits.set(owners.get(pending).scopeKey, pending);
            return true;
        };
        const verifyDurableOrder = async pending => {
            const handle = rawHandle(pending);
            if (!handle.recordKey) return { ok: true, legacy: true };
            const lease = owners.get(pending)?.lease;
            for (const [scope, state] of orderCursors) if (!RuntimeStateLease.isCurrent(state.lease)) orderCursors.delete(scope);
            let cursor = orderCursors.get(handle.scopeKey)?.cursor || null;
            try {
                const own = await DurableTurnLedger.readRecord(handle);
                if (!own.ok) return {ok:false,reason:'pending_order_read_unverified'};
                if (own.record.status === 'committed') return {ok:true,alreadyCommitted:true,receipt:own.record};
                if (own.record.analysisStatus === 'blocked_host_source_changed') return {ok:false,parked:true,receipt:own.record,reason:'blocked_host_source_changed'};
                for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
                    // At most 8 x 32 raw records per pass. A verified prefix is
                    // resumed on the next bounded retry, never treated as empty.
                    const page = await DurableTurnLedger.listPendingPage(handle.scopeKey, {
                        limit: 1, cursor: cursor ? {scopeKey: cursor.scopeKey, offset: cursor.offset} : null,
                        strictReceiptReads: true,
                        acceptRecord: record => record.status !== 'committed'
                            && record.analysisStatus !== 'blocked_host_source_changed'
                            && Number(record.resetGeneration ?? 0) === Number(pending.targetContext?.resetGeneration ?? 0)
                    });
                    if (!RuntimeStateLease.isCurrent(lease)) return {ok:false,reason:'runtime_lease_invalidated'};
                    if (page.records.length) {
                        const record = page.records[0];
                        const before = {scopeKey: handle.scopeKey, offset: Number(cursor?.offset || 0) + page.scanned - 1};
                        orderCursors.set(handle.scopeKey, {lease, cursor: before});
                        return {ok:record.recordKey === handle.recordKey, record, reason:'pending_predecessor_unadmitted'};
                    }
                    cursor = page.nextCursor;
                    if (!cursor) {
                        const own = await DurableTurnLedger.readRecord(handle);
                        if (!own.ok) return {ok:false,reason:'pending_order_read_unverified'};
                        return own.record.status === 'committed' ? {ok:true, alreadyCommitted:true}
                            : {ok:false,reason:'pending_raw_receipt_unavailable'};
                    }
                    orderCursors.set(handle.scopeKey, {lease, cursor});
                }
                return {ok:false,reason:'pending_order_scan_incomplete'};
            } catch (_) { return {ok:false,reason:'pending_order_read_unverified'}; }
        };
        const findIncompatibleSuccessor = (chat, pending, latest) => {
            if (chat.isStreaming === true || latest.latestMatchesPending || getPending(chat) !== pending || !ownerIsCurrent(pending)) return null;
            const boundary = Number(pending.originMessageCount ?? pending.messageCount ?? 0);
            const source = pending.sourceCapture;
            if (source?.state !== 'captured' || source.originMessageCount !== boundary) return null;
            const slot = getChatMessages(chat)[boundary];
            if (!slot || slot.disabled || slot.isComment || slot.isOOC || !String(Utils.getMessageText(slot) || '').trim()) return null;
            return entriesFor(pending).slice(1).find(candidate => {
                if (!ownerIsCurrent(candidate)) return false;
                const nextBoundary = Number(candidate.originMessageCount ?? candidate.messageCount ?? 0);
                if (nextBoundary < boundary) return false;
                if (nextBoundary === boundary && identity(candidate) === identity(pending)) return false;
                const match = resolveLatestPendingSnapshot(chat, candidate);
                return match.latestMatchesPending && match.matchedMessageIndex === nextBoundary
                    && !!match.resolvedMessageId && !!match.resolvedSignature;
            }) || null;
        };
        const pendingParkWait = reason => ({status:'waiting',reason,preserveReceiptStatus:true});
        const reconcilePendingPark = async (char, originalChat, pending) => {
            const owner = owners.get(pending), token = owner?.parkToken;
            if (!token) return null;
            const current = () => ownerIsCurrent(pending) && getPending(originalChat) === pending;
            if (!current()) return pendingParkWait('pending_park_owner_changed');
            const checked = await DurableTurnLedger.readRecord(rawHandle(pending));
            if (!checked.ok || !current()) return pendingParkWait('pending_park_recheck_unverified');
            const receipt = checked.record;
            if (receipt.status === 'committed') { owner.parkToken = ''; return null; }
            if (receipt.pendingParkResumeToken === token && receipt.analysisStatus === 'awaiting_host_anchor') {
                owner.parkToken = ''; return pendingParkWait('pending_park_source_restored');
            }
            if (receipt.pendingParkToken !== token) {
                // An exact unparked read after the write settled can show that
                // this attempt did not publish. Never compensate an unknown ACK.
                if (!receipt.pendingParkToken && receipt.analysisStatus !== 'blocked_host_source_changed') {
                    owner.parkToken = ''; return pendingParkWait('pending_park_write_not_published');
                }
                return pendingParkWait('pending_park_status_superseded');
            }
            const refreshed = await resolveChatContextByTarget(pending.targetContext, {allowActiveFallback:false});
            if (!refreshed?.ok || !current() || refreshed.chat?.isStreaming === true) return pendingParkWait('pending_park_recheck_unverified');
            const latest = resolveLatestPendingSnapshot(refreshed.chat, pending);
            if (findIncompatibleSuccessor(refreshed.chat, pending, latest)) {
                // No await separates final fresh host evidence from exact-owner
                // removal. A stale ACK alone never authorizes promotion.
                dropPending(originalChat, pending);
                schedulePendingFinalizeRetry(refreshed.char, refreshed.chat, 'afterRequest-queued-owner', 250);
                return {status:'blocked',reason:'blocked_host_source_changed',preserveReceiptStatus:true};
            }
            if (!latest.latestMatchesPending || !latest.resolvedMessageId || !latest.resolvedSignature) return pendingParkWait('pending_park_recheck_unverified');
            const restored = await DurableTurnLedger.markStatus(rawHandle(pending), {
                status:'observed',analysisStatus:'awaiting_host_anchor',deferredReason:'pending_park_source_restored',
                commitStatus:'waiting',turn:0,turnKey:'',pendingParkToken:'',pendingParkResumeToken:token
            }, {expectedPendingParkToken:token,requireUncommitted:true,isCurrent:current});
            if (!restored?.ok || restored.verified !== true || !current()) return pendingParkWait('pending_park_resume_unverified');
            owner.parkToken = '';
            // The resume ACK can itself span a host edit. Re-enter through the
            // ordinary fresh-context/receipt gates instead of committing here.
            return pendingParkWait('pending_park_source_restored');
        };
        const parkIncompatibleHead = async (char, chat, pending, latest) => {
            if (!findIncompatibleSuccessor(chat, pending, latest)) return null;
            const owner = owners.get(pending);
            const token = `park:${Date.now()}:${Math.random().toString(36).slice(2)}`;
            owner.parkToken = token;
            const current = () => ownerIsCurrent(pending) && getPending(chat) === pending;
            const saved = await DurableTurnLedger.markStatus(rawHandle(pending), {
                status:'observed',analysisStatus:'blocked_host_source_changed',deferredReason:'blocked_host_source_changed',
                commitStatus:'waiting',turn:0,turnKey:'',deferredAt:Date.now(),pendingParkToken:token,pendingParkResumeToken:''
            }, {requireUncommitted:true,isCurrent:current});
            if (!saved?.ok || saved.verified !== true || !current()) return pendingParkWait('pending_park_ack_unverified');
            return reconcilePendingPark(char, chat, pending);
        };
        const inspectDeferred = async (char, chat) => {
            const lease = RuntimeStateLease.capture(), scopeKey = getStableChatScopeKey(chat, char);
            const canonical = await LibraDataStorage.readVerified(LibraDataStorage.scopeKeyFor(char, chat));
            RuntimeStateLease.assertCurrent(lease);
            if (!canonical?.ok || !Number.isSafeInteger(canonical.resetGeneration) || canonical.resetGeneration < 0) throw new Error('pending_capture_generation_unverified');
            const currentResetGeneration = canonical.resetGeneration;
            const records = []; let cursor = null, scanned = 0;
            for (let pageNumber = 0; pageNumber < 8 && records.length < 16; pageNumber++) {
                const page = await DurableTurnLedger.listPendingPage(scopeKey, {limit:16-records.length,cursor,strictReceiptReads:true,
                    acceptRecord: record => record.status !== 'committed' && /^(?:blocked_host_source_changed|pending_queue_capacity|pending_durable_backlog|pending_order_|pending_retry_exhausted|pending_park_)/.test(String(record.deferredReason || record.analysisStatus || ''))});
                RuntimeStateLease.assertCurrent(lease);
                records.push(...page.records.map(record => ({recordId:record.recordId,recordKey:record.recordKey,originMessageCount:record.originMessageCount,
                    requestSequence:record.requestSequence,status:record.status,analysisStatus:record.analysisStatus,deferredReason:record.deferredReason,
                    resetGeneration:record.resetGeneration,generationState:Number.isSafeInteger(record.resetGeneration) && record.resetGeneration >= 0
                        ? (record.resetGeneration === currentResetGeneration ? 'current' : record.resetGeneration < currentResetGeneration ? 'historical' : 'unknown') : 'unknown'})));
                scanned += page.scanned; cursor = page.nextCursor;
                if (!cursor) break;
            }
            return {ok:true,records,complete:!cursor,scanned,currentResetGeneration};
        };

        const commitPendingNowUnlocked = async (char, chat, reason = 'afterRequest-immediate', options = {}) => {
            const runtimeLease = RuntimeStateLease.capture();
            const originalChat = chat;
            const suppliedPending = options?.pending || getPending(originalChat);
            if (suppliedPending && (!ownerIsCurrent(suppliedPending) || getPending(originalChat) !== suppliedPending)) {
                const blockedReason = owners.get(suppliedPending)?.blockedReason || 'pending_owner_queued_or_retired';
                if (['pending_queue_capacity','pending_durable_backlog'].includes(blockedReason)) {
                    await recordDeferred(suppliedPending, blockedReason);
                    requestDurableReplay(suppliedPending);
                }
                if (getPending(originalChat)) schedulePendingFinalizeRetry(char, originalChat, 'afterRequest-new-pending-owner', 250);
                return { status: 'waiting', reason: blockedReason };
            }
            const refreshCommitContext = async () => {
                try {
                    const explicitTarget = suppliedPending?.targetContext && typeof suppliedPending.targetContext === 'object'
                        ? suppliedPending.targetContext
                        : null;
                    if (explicitTarget?.chatId) {
                        const resolved = await resolveChatContextByTarget(explicitTarget, { allowActiveFallback: false });
                        if (!resolved?.ok) return false;
                        chat = resolved.chat;
                        char = resolved.char;
                        return true;
                    }
                    const expectedId = String(originalChat?.id || chat?.id || '').trim();
                    const refreshed = await resolveActiveChatContext({ id: expectedId });
                    const refreshedChat = refreshed?.chat || null;
                    if (!refreshedChat) return false;
                    if (expectedId && String(refreshedChat?.id || '').trim() !== expectedId) return false;
                    chat = refreshedChat;
                    if (refreshed?.char) char = refreshed.char;
                    return true;
                } catch (_) {
                    return false;
                }
            };
            // The chat captured inside RisuAI's afterRequest hook is a pre-save
            // snapshot. Reacquire the host chat before validating provenance.
            if (!await refreshCommitContext() || !RuntimeStateLease.isCurrent(runtimeLease)
                || (suppliedPending && (!ownerIsCurrent(suppliedPending) || getPending(originalChat) !== suppliedPending))) return { status: 'cancelled', reason: 'runtime_lease_invalidated' };
            const pending = suppliedPending || getPending(chat) || getPending(originalChat);
            if (!char || !chat || !pending) return { status: 'none' };
            const parkRecheck = await reconcilePendingPark(char, chat, pending);
            if (parkRecheck) {
                if (parkRecheck.status === 'waiting' && options?.suppressFinalizeRetry !== true) schedulePendingFinalizeRetry(char, chat, 'afterRequest-park-recheck', 500);
                return parkRecheck;
            }
            const order = await verifyDurableOrder(pending);
            if (!RuntimeStateLease.isCurrent(runtimeLease) || !ownerIsCurrent(pending) || getPending(chat) !== pending) return {status:'cancelled',reason:'runtime_lease_invalidated'};
            if (order.alreadyCommitted || order.parked) {
                // Verified lifecycle completion/parking belongs to this immutable
                // receipt. A repeated callback does not certify today's edited
                // host text, reinsert history, or hold newer live work hostage.
                requestDurableReplay(pending);
                dropPending(chat, pending);
                if (getPending(chat)) schedulePendingFinalizeRetry(char, chat, 'afterRequest-queued-owner', 250);
                return order.alreadyCommitted
                    ? {status:'already-committed',reason:'durable_completion_recorded',turn:Number(order.receipt?.turn || 0),
                        turnKey:String(order.receipt?.turnKey || ''),preserveReceiptStatus:true,
                        maintenancePending:!['done','committed'].includes(String(order.receipt?.analysisStatus || ''))}
                    : {status:'blocked',reason:'blocked_host_source_changed',preserveReceiptStatus:true};
            }
            if (!order.ok) {
                const older = order.record && entriesFor(pending).find(entry => rawHandle(entry).recordKey === order.record.recordKey);
                if (older) promoteOwned(chat, older);
                else if (order.record && entriesFor(pending).length >= PENDING_QUEUE_LIMIT) {
                    const queue = entriesFor(pending), last = queue[queue.length-1];
                    const saved = await recordDeferred(last, 'pending_queue_capacity');
                    if (saved?.ok && ownerIsCurrent(pending) && getPending(chat) === pending && queue.at(-1) === last) {
                        queue.pop(); owners.delete(last);
                        durableOnly.set(rawHandle(pending).scopeKey, runtimeLease);
                    }
                }
                await recordDeferred(pending, order.reason, order.reason === 'blocked_host_source_changed' ? order.reason : 'awaiting_host_anchor');
                if (order.record && !older) requestDurableReplay(pending, true);
                if (options?.suppressFinalizeRetry !== true) schedulePendingFinalizeRetry(char, chat, 'afterRequest-order-retry', 500);
                return {status:'waiting',reason:order.reason};
            }
            let latest = resolveLatestPendingSnapshot(chat, pending);
            const parked = await parkIncompatibleHead(char, chat, pending, latest);
            if (parked) {
                if (parked.status === 'waiting' && options?.suppressFinalizeRetry !== true) schedulePendingFinalizeRetry(char, chat, 'afterRequest-park-recheck', 500);
                return parked;
            }
            if (String(reason || '').includes('afterRequest') && (!latest.resolvedMessageId || !latest.resolvedSignature)) {
                const originMessageCount = Math.max(0, Number(pending?.originMessageCount ?? pending?.messageCount ?? 0) || 0);
                const hostAlreadyAdvanced = Number(latest.currentMessageCount || 0) > originMessageCount + 2;
                const attachDeadline = Date.now() + (hostAlreadyAdvanced ? 0 : 1250);
                let attachStep = 120;
                while (Date.now() < attachDeadline) {
                    await sleep(attachStep);
                    if (!await refreshCommitContext() || !RuntimeStateLease.isCurrent(runtimeLease)
                || (suppliedPending && (!ownerIsCurrent(suppliedPending) || getPending(originalChat) !== suppliedPending))) return { status: 'cancelled', reason: 'runtime_lease_invalidated' };
                    const candidate = resolveLatestPendingSnapshot(chat, pending);
                    const candidateHasStableAnchor = candidate.hostMessageAccepted && (
                        !!(candidate.resolvedMessageId || candidate.resolvedSignature)
                        || Number(candidate.currentMessageCount || 0) > Number(pending.messageCount || 0)
                    );
                    if (candidate.resolvedHash && candidateHasStableAnchor) {
                        latest = candidate;
                        break;
                    }
                    attachStep = Math.min(300, attachStep + 40);
                }
            }
            const optionResponseText = String(Utils.getMemorySourceText(options?.responseText || '') || '').trim();
            const optionResponseHash = optionResponseText ? String(TokenizerEngine.simpleHash(optionResponseText) || '').trim() : '';
            const sourceHash = String(pending?.sourceHash || pending?.aiHash || latest.resolvedHash || optionResponseHash || '').trim();
            const latestHash = String(latest.resolvedHash || sourceHash || optionResponseHash || '').trim();
            if (!latestHash) return { status: 'waiting', reason: 'no_latest_hash' };
            if (chat?.isStreaming === true) return { status: 'waiting', reason: 'response_still_streaming' };
            if (!latest.hostMessageAccepted || !latest.resolvedMessageId || !latest.resolvedSignature) {
                const retryScheduled = options?.suppressFinalizeRetry === true
                    ? false
                    : schedulePendingFinalizeRetry(char, chat, 'awaiting-host-committed-message', 500);
                return {
                    status: 'waiting',
                    reason: 'host_message_anchor_unavailable',
                    retryScheduled,
                    latestMatchesPending: latest.latestMatchesPending,
                    hostPersistedAfterRequest: latest.hostPersistedAfterRequest,
                    hasMessageId: !!latest.resolvedMessageId,
                    hasSignature: !!latest.resolvedSignature
                };
            }

            const now = Date.now();
            const isImmediateAfterRequest = String(reason || '') === 'afterRequest-immediate';
            if (isImmediateAfterRequest && options?.force !== true) {
                const ageMs = now - Number(pending.createdAt || now);
                const messageCountAdvanced = Number(latest.currentMessageCount || 0) > Number(pending.messageCount || 0);
                const anchorStable = latest.hostMessageAccepted && (messageCountAdvanced || !!latest.resolvedMessageId || !!latest.resolvedSignature);
                if (ageMs < PENDING_FINALIZE_MIN_MS || !anchorStable) {
                    const retryScheduled = options?.suppressFinalizeRetry === true
                        ? false
                        : schedulePendingFinalizeRetry(char, chat, 'afterRequest-stabilized-retry', Math.max(250, PENDING_FINALIZE_MIN_MS - ageMs + 250));
                    return {
                        status: 'waiting',
                        reason: ageMs < PENDING_FINALIZE_MIN_MS ? 'age_guard_afterrequest' : 'anchor_stability_guard_afterrequest',
                        retryScheduled,
                        ageMs,
                        anchorStable
                    };
                }
            }
            pending.lastSeenAt = now;
            pending.observedHash = latestHash;
            pending.observedMessageId = latest.resolvedMessageId || pending.observedMessageId || null;
            pending.stableMatches = Math.max(Number(pending.stableMatches || 0), 1);
            pending.aiResponse = Utils.getMemorySourceText(latest.resolvedText || pending.aiResponse || optionResponseText || '');
            pending.aiResponseRaw = Utils.getMemorySourceText(pending.aiResponseRaw || pending.aiResponse || '');
            MemoryState.pendingTurnCommits.set(findScopedMapKey(MemoryState.pendingTurnCommits, chat, pending), pending);

            const lore = MemoryEngine.getLorebook(char, chat);
            const config = MemoryEngine.CONFIG;
            const retryIds = normalizeCanonicalMessageIds([latest.latestIds, latest.resolvedMessageId]);
            const retryTurnKey = buildCanonicalTurnKey(chat?.id || '', pending.userTurnKey || '', latestHash, compactTurnMessageSignature(latest.resolvedSignature), retryIds);
            const canonicalRetry = await findVerifiedCanonicalTurnCommit(char, chat, {
                liveMessageIds: retryIds, sourceHash: latestHash, messageSignature: latest.resolvedSignature,
                turnKey: retryTurnKey, canonicalScope: pending?.targetContext?.canonicalScope || '',
                resetGeneration: pending?.targetContext?.resetGeneration ?? 0
            });
            RuntimeStateLease.assertCurrent(runtimeLease);
            if (canonicalRetry) {
                pending.turnAnchor = canonicalRetry.record.turn;
                pending.turnAnchorTurn = canonicalRetry.record.turn;
                pending.lockedTurn = canonicalRetry.record.turn;
                pending.finalizedTurn = canonicalRetry.record.turn;
            }
            const rawDerivedMax = Math.max(
                deriveRuntimeTurnFromLorebook(lore),
                TurnRecordLedger.deriveMaxTurn(lore, chat, char)
            );
            // 롤백 저널 기반 턴 clamp 는 삭제됐다 (스냅샷 롤백 기능 제거).
            const derivedMax = rawDerivedMax;
            const currentTurn = Math.max(1, normalizeLegacyMemoryTurnAnchor(
                pending.turnAnchor
                || pending.turnAnchorTurn
                || pending.lockedTurn
                || pending.finalizedTurn
                || pending.liveTurn
                || pending.predictedTurn
                || (derivedMax + 1)
            ));
            if (!canonicalRetry && currentTurn <= derivedMax && currentTurn > 0) {
                // Reroll/refresh may intentionally reuse an anchor; otherwise move forward.
                const finalized = getFinalizedTurnMeta(chat);
                const sameFinalized = finalized && (
                    hasCanonicalMessageIdOverlap(finalized.liveMessageIds, latest.latestIds)
                );
                if (!sameFinalized) {
                    pending.turnAnchor = derivedMax + 1;
                    pending.turnAnchorTurn = derivedMax + 1;
                    pending.lockedTurn = derivedMax + 1;
                    pending.finalizedTurn = derivedMax + 1;
                }
            }
            const finalizedTurn = Math.max(1, normalizeLegacyMemoryTurnAnchor(pending.turnAnchor || pending.turnAnchorTurn || currentTurn));
            MemoryEngine.setTurn(finalizedTurn);


            const m_id = latest.resolvedMessageId || pending.observedMessageId || null;
            const liveMessageIds = normalizeCanonicalMessageIds([latest.latestIds, m_id]);
            const storageMessageSignature = compactTurnMessageSignature(latest.resolvedSignature);
            const turnKey = String(buildCanonicalTurnKey(chat?.id || '', pending.userTurnKey || '', latestHash, storageMessageSignature, liveMessageIds)).trim();
            const canonicalFactSlot = 'turn_summary';
            const canonicalMemoryId = buildCanonicalMemoryId(chat?.id || '', m_id || '', canonicalFactSlot, {
                turnKey,
                sourceHash: latestHash,
                turn: finalizedTurn
            });
            const anchorMeta = {
                t: finalizedTurn,
                turn: finalizedTurn,
                turnAnchor: finalizedTurn,
                turnAnchorTurn: finalizedTurn,
                lockedTurn: finalizedTurn,
                finalizedTurn,
                firstTurn: finalizedTurn,
                originalTurn: finalizedTurn,
                m_id,
                messageId: m_id,
                liveMessageIds,
                sourceMessageIds: liveMessageIds,
                aiHash: latestHash,
                sourceHash: latestHash,
                responseHash: latestHash,
                userTurnKey: pending.userTurnKey || '',
                turnKey,
                canonicalFactSlot,
                canonicalMemoryId,
                provenanceStatus: 'active',
                sourceRevision: 1,
                sourceReceipt: ProspectiveSourceReceipt.bind(chat, pending, liveMessageIds),
                validFrom: finalizedTurn,
                validTo: null,
                messageSignature: storageMessageSignature,
                messageCount: Number(latest.currentMessageCount || 0),
                liveOrder: Number(latest.currentMessageCount || 0),
                chatId: String(chat?.id || '').trim(),
                runtimeMode: pending.runtimeMode || 'turn-anchor',
                runtimeReliability: pending.runtimeReliability || 'normal',
                turnLocked: true,
                turnAnchorReason: 'v4.2-finalized-turn',
                finalizedAt: Date.now(),
                gcTargetContext: pending?.targetContext && typeof pending.targetContext === 'object'
                    ? {
                        characterId: String(pending.targetContext.characterId || pending.targetContext.charId || char?.id || char?.chaId || '').trim(),
                        characterIndex: normalizeRisuIndex(pending.targetContext.characterIndex ?? pending.targetContext.charIndex),
                        chatId: String(pending.targetContext.chatId || chat?.id || '').trim(),
                        chatIndex: normalizeRisuIndex(pending.targetContext.chatIndex)
                    }
                    : null
            };
            const allowNarrativeProcessing = pending.allowNarrativeProcessing !== false;
            const allowMemoryCapture = pending.allowMemoryCapture !== false;
            const recoveredUserMemory = String(Utils.getMemorySourceText(
                pending.userMsgForMemory
                || pending.userMsgForNarrative
                || _lastUserMessageRaw
                || _lastUserMessage
                || findLatestVisibleUserText(getChatMessages(chat))
                || ''
            ) || '').trim();
            const recoveredUserNarrative = String(
                Utils.getNarrativeComparableText(pending.userMsgForNarrative || recoveredUserMemory || '', 'user')
                || recoveredUserMemory
                || ''
            ).trim();
            const effectiveAiResponse = String(Utils.getMemorySourceText(pending.aiResponse || latest.resolvedText || '') || '').trim();
            pending.userMsgForMemory = recoveredUserMemory;
            pending.userMsgForNarrative = recoveredUserNarrative;
            pending.aiResponse = effectiveAiResponse;
            pending.aiResponseRaw = String(Utils.getMemorySourceText(pending.aiResponseRaw || effectiveAiResponse) || '').trim();
            const turnState = allowNarrativeProcessing
                ? await buildFastCommittedTurnState(char, chat, lore, recoveredUserNarrative, effectiveAiResponse, m_id, {
                    autoContinue: !!pending.autoContinueTurn,
                    anchorMeta,
                    narrativeChannel: pending.narrativeChannelPreview,
                    finalizedTurn,
                    allowNarrativeProcessing,
                    hostPromptEvidence: pending.hostPromptEvidence || null
                })
                : {
                    config,
                    conversationEmotion: null,
                    analysisPending: false,
                    involvedEntities: [],
                    entitiesToConsolidate: [],
                    strictUserMsg: recoveredUserNarrative || '',
                    recordedNarrativeTurn: false,
                    narrativeTrack: 'scene',
                    m_id
                };
            RuntimeStateLease.assertCurrent(runtimeLease);
            turnState.targetContext = pending?.targetContext && typeof pending.targetContext === 'object'
                ? safeClone(pending.targetContext)
                : null;
            try {
                const povRecordResult = EntityKnowledgeVaultCore.recordTurnForEntities(turnState?.involvedEntities || [], {
                    userText: recoveredUserMemory,
                    aiText: effectiveAiResponse,
                    turn: finalizedTurn,
                    source: 'afterRequest-turn'
                }, {
                    turn: finalizedTurn,
                    source: 'afterRequest-turn'
                });
                if (povRecordResult?.changed && config.debug) {
                    recordRuntimeDebug('log', '[LIBRA] Entity POV vault updated', {
                        turn: finalizedTurn,
                        count: povRecordResult.count || 0,
                        entities: turnState?.involvedEntities || []
                    });
                }
            } catch (povRecordError) {
                if (config.debug) recordRuntimeDebug('warn', '[LIBRA] Entity POV vault update skipped:', povRecordError?.message || povRecordError);
            }
            try {
                const candidateResult = EntityCandidateCore?.recordInvolvedEntityCandidates?.(lore, turnState?.involvedEntities || [], {
                    turn: finalizedTurn,
                    source: 'afterRequest-turn.involvedEntities',
                    reason: 'related_but_not_promoted',
                    userText: recoveredUserMemory,
                    aiText: effectiveAiResponse
                });
                if (candidateResult?.changed && config.debug) {
                    recordRuntimeDebug('log', '[LIBRA] Entity candidates updated', {
                        turn: finalizedTurn,
                        count: candidateResult.count || 0
                    });
                }
            } catch (candidateRecordError) {
                if (config.debug) recordRuntimeDebug('warn', '[LIBRA] Entity candidate update skipped:', candidateRecordError?.message || candidateRecordError);
            }
            const allowCompactMemoryCapture = allowMemoryCapture && turnState?.narrativeTrack !== 'meta';
            const memoryContent = buildCanonicalMemoryCaptureContent(recoveredUserMemory, effectiveAiResponse, {
                turn: finalizedTurn,
                entityRefs: turnState?.involvedEntities || [],
                knownEntityNames: turnState?.involvedEntities || [],
                source: 'afterRequest-turn-capture'
            });
            const memoryPayloadForRetention = memoryContent ? CompactMemoryCodec.parsePayloadFromContent(memoryContent) : null;
            const memoryImportance = (config.rpLongTermMemoryEnabled !== false && memoryPayloadForRetention?.rpLongTerm)
                ? RPContinuityCore.resolveImportance(memoryPayloadForRetention.rpLongTerm, 5)
                : 5;
            const recoveredMemory = canonicalRetry?.memories.find(entry => getCanonicalGuardMemoryIdentity(entry).endsWith('::turn_summary')) || null;
            const newMemory = recoveredMemory || (allowCompactMemoryCapture && memoryContent
                ? await MemoryEngine.prepareMemory(
                    { content: memoryContent, importance: memoryImportance, forceCreate: true, entityRefs: turnState?.involvedEntities || [] },
                    finalizedTurn, lore, lore, char, chat, m_id, anchorMeta
                )
                : null);
            RuntimeStateLease.assertCurrent(runtimeLease);
            const currentWorldNode = HierarchicalWorldManager.getCurrentNode?.();
            const currentWorldRules = HierarchicalWorldManager.getCurrentRules();
            const currentWorldProfile = HierarchicalWorldManager.getProfile?.();
            const worldMemoryContent = allowCompactMemoryCapture
                ? buildWorldRecallMemoryContent(currentWorldNode?.meta || {}, currentWorldRules, {
                    turn: finalizedTurn,
                    importance: Math.max(6, Number(memoryImportance || 0) || 6),
                    sourceHash: latestHash,
                    sourceMessageIds: liveMessageIds,
                    worldSnapshot: turnState?.worldSnapshot || null,
                    activePath: turnState?.worldSnapshot?.activePath || currentWorldProfile?.activePath || []
                })
                : '';
            const worldMemoryPayload = worldMemoryContent ? (CompactMemoryCodec.parsePayloadFromContent(worldMemoryContent) || null) : null;
            const worldMemoryDecision = worldMemoryContent
                ? shouldCreateWorldRecallMemorySnapshot(lore, worldMemoryPayload, {
                    turn: finalizedTurn,
                    isWorldCritical: turnState?.isWorldCritical === true,
                    worldSnapshot: turnState?.worldSnapshot || null
                })
                : { create: false, reason: 'empty_content' };
            const shouldCreateWorldMemory = !!(worldMemoryContent && worldMemoryDecision.create);
            const worldMemory = allowCompactMemoryCapture && shouldCreateWorldMemory
                ? await MemoryEngine.prepareMemory(
                    { content: worldMemoryContent, importance: Math.max(6, Number(memoryImportance || 0) || 6) },
                    finalizedTurn, lore, lore, char, chat, m_id, anchorMeta
                )
                : null;

            RuntimeStateLease.assertCurrent(runtimeLease);
            if (newMemory) forceMemoryTurnAnchor(newMemory, anchorMeta);
            if (worldMemory) forceMemoryTurnAnchor(worldMemory, anchorMeta);
            const committedMemories = [newMemory, worldMemory].filter(Boolean);
            const primaryMemoryKey = newMemory?.key
                || worldMemory?.key
                || (newMemory?.content ? TokenizerEngine.getSafeMapKey(newMemory.content) : '')
                || (worldMemory?.content ? TokenizerEngine.getSafeMapKey(worldMemory.content) : '');
            const turnRecordPayload = {
                ...anchorMeta,
                userPreview: String(pending.userMsgForNarrative || pending.userMsgForMemory || (pending.autoContinueTurn ? '*says nothing*' : '') || '').replace(/\s+/g, ' ').trim().slice(0, 90),
                aiPreview: pending.aiResponse || '',
                memoryKey: primaryMemoryKey,
                status: 'active',
                reason
            };
            const canonicalCommitGuard = buildCanonicalTurnCommitGuard({
                turn: finalizedTurn,
                turnKey,
                sourceHash: latestHash,
                scopeKey: getChatRuntimeScopeKey(chat, char),
                chatId: String(chat?.id || '').trim(),
                primaryMemoryKey,
                memoryEntries: committedMemories,
                turnRecord: turnRecordPayload,
                rpTurnMemory: memoryPayloadForRetention?.rpLongTerm || null,
                anchorMeta
            });
            if (config.debug) {
                recordRuntimeDebug('log', '[LIBRA] V4.2 turn anchor commit prepared', {
                    __libraDebugMeta: true,
                    turn: finalizedTurn,
                    turnAnchorTurn: finalizedTurn,
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    chatId: String(chat?.id || '').trim(),
                    turnKey,
                    memoryCreated: committedMemories.length > 0,
                    worldMemoryCreated: Boolean(worldMemory),
                    worldMemoryDeduped: !!(worldMemoryContent && !worldMemory),
                    worldMemoryDecision,
                    reason
                });
            }

            await loreLock.writeLock();
            try {
                RuntimeStateLease.assertCurrent(runtimeLease);
                if (committedMemories.length > 0) {
                    lore.push(...(canonicalRetry ? committedMemories.filter(candidate => !lore.some(entry => getCanonicalGuardMemoryIdentity(entry) === getCanonicalGuardMemoryIdentity(candidate))) : committedMemories));
                    MemoryEngine.upsertHybridScopeIndexRows(lore, committedMemories, {
                        scopeKey: getChatRuntimeScopeKey(chat, char),
                        currentTurn: finalizedTurn,
                        reason: `post-commit:${reason}`
                    });
                }
                if (config.rpLongTermMemoryEnabled !== false && newMemory) {
                    try {
                        const committedTurnMemory = memoryPayloadForRetention?.rpLongTerm || null;
                        if (committedTurnMemory) {
                            RPContinuityCore.upsertFromTurn(lore, committedTurnMemory, {
                                turn: finalizedTurn,
                                entityRefs: turnState?.involvedEntities || [],
                                source: 'afterRequest-turn-commit',
                                sourceMemoryKey: (() => {
                        const raw = String(newMemory?.key || '').trim();
                        const hm = raw.match(/^(-?\d+)(?:_|$)/);
                        if (hm) return `memory_hash:${hm[1]}`;
                        if (raw && !raw.includes('[')) return raw;
                        return `memory_hash:${TokenizerEngine.simpleHash(String(newMemory?.content || ''))}`;
                    })()
                            });
                        }
                    } catch (error) {
                        if (config.debug) recordRuntimeDebug('warn', '[LIBRA][RP-LTM] aggregate upsert skipped:', error?.message || error);
                    }
                }
                TurnRecordLedger.upsertRecord(lore, turnRecordPayload, chat, char);
                await SecretKnowledgeCore.saveState(lore, {
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                });
                RuntimeStateLease.assertCurrent(runtimeLease);
                await NarrativeTracker.saveState(lore);
                RuntimeStateLease.assertCurrent(runtimeLease);
                await EntityKnowledgeVaultCore.saveState(lore, {
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                });
                RuntimeStateLease.assertCurrent(runtimeLease);
                await TimeEngine.saveState(lore, {
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                });
                RuntimeStateLease.assertCurrent(runtimeLease);
                const canonicalCommitVerification = verifyCanonicalTurnCommitGuard(lore, canonicalCommitGuard, char, chat);
                if (!canonicalCommitVerification.ok) {
                    throw new Error(`canonical turn commit invariant failed before persist: ${canonicalCommitVerification.reason || 'artifact_missing'}`);
                }
                MemoryEngine.setLorebook(char, chat, lore);
                if (!isLibraRuntimeEpochActive()) throw new Error('runtime epoch invalidated before canonical commit');
                const persistResult = await persistLoreToActiveChat(chat, lore, {
                    targetContext: pending?.targetContext?.chatId ? pending.targetContext : null,
                    reason: 'canonical-turn-commit', runtimeLease
                });
                RuntimeStateLease.assertCurrent(runtimeLease);
                if (!persistResult?.ok) throw new Error(`canonical turn persist failed: ${persistResult?.reason || 'unknown'}`);
            } finally {
                loreLock.writeUnlock();
            }

            if (m_id || liveMessageIds.length > 0) {
                const createdKeys = [];
                if (newMemory) createdKeys.push(newMemory.key || TokenizerEngine.getSafeMapKey(newMemory.content));
                if (worldMemory) createdKeys.push(worldMemory.key || TokenizerEngine.getSafeMapKey(worldMemory.content));
                const trackerPayload = {
                    loreKeys: createdKeys,
                    sourceHash: latestHash,
                    aiHash: latestHash,
                    messageSignature: latest.resolvedSignature,
                    liveMessageIds,
                    sourceMessageIds: liveMessageIds,
                    messageId: m_id,
                    turn: finalizedTurn,
                    turnAnchor: finalizedTurn,
                    turnAnchorTurn: finalizedTurn,
                    lockedTurn: finalizedTurn,
                    finalizedTurn,
                    turnKey,
                    userTurnKey: pending.userTurnKey || ''
                };
                for (const id of liveMessageIds.length ? liveMessageIds : [m_id]) {
                    if (!id) continue;
                    MemoryState.transientMissing.delete(id);
                }
            }

            setFinalizedTurnMeta(chat, {
                ...anchorMeta,
                messageCount: Number(latest.currentMessageCount || 0),
                reason,
                targetContext: pending?.targetContext || null
            });
            if (pending?.targetContext?.durableLedgerRecordKey) {
                try {
                    await DurableTurnLedger.markStatus({
                        recordKey: pending.targetContext.durableLedgerRecordKey,
                        recordId: pending.targetContext.durableLedgerRecordId || '',
                        scopeKey: pending.targetContext.scopeKey || ''
                    }, {
                        status: 'committed',
                        analysisStatus: allowNarrativeProcessing && turnState?.narrativeTrack !== 'meta' ? 'queued' : 'done',
                        turn: finalizedTurn,
                        turnKey,
                        committedAt: Date.now()
                    });
                } catch (ledgerCommitError) {
                    recordSuppressedRuntimeError('durable_turn_ledger.canonical_commit_status', ledgerCommitError, {
                        chatId: String(chat?.id || '').trim(),
                        turn: finalizedTurn
                    });
                }
            }
            RuntimeStateLease.assertCurrent(runtimeLease);
            // Observe only this verified finalized source; do not rescan history.
            try {
                const livePairs = buildWorldlinePairsFromChat(chat, char, finalizedTurn, pending, latest, anchorMeta.sourceReceipt);
                if (livePairs.length) {
                    await LibraTurnWorldline.observe(
                        LibraDataStorage.scopeKeyFor(char, chat, null),
                        livePairs,
                        { mode: 'finalized-turn', sourceVerified: true,
                            isCurrent: () => RuntimeStateLease.isCurrent(runtimeLease) && ownerIsCurrent(pending),
                            verifySource: async () => {
                                if (!await refreshCommitContext()) return false;
                                const receipt = ProspectiveSourceReceipt.bind(chat, pending, liveMessageIds);
                                const current = buildWorldlinePairsFromChat(chat, char, finalizedTurn, pending, latest, receipt);
                                return current.length === 1 && JSON.stringify(current[0]) === JSON.stringify(livePairs[0]);
                            } }
                    );
                }
            } catch (worldlineError) {
                recordSuppressedRuntimeError('turn_worldline.observe', worldlineError, { turn: finalizedTurn });
            }
            RuntimeStateLease.assertCurrent(runtimeLease);
            markLiveSyncSnapshot(chat, { finalizedTurn, pendingKey: '' });
            requestDurableReplay(pending);
            dropPending(chat, pending);
            if (getPending(chat)) schedulePendingFinalizeRetry(char, chat, 'afterRequest-queued-owner', 250);
            let maintenanceRecord = null;
            if (allowNarrativeProcessing && turnState?.narrativeTrack !== 'meta') {
                maintenanceRecord = buildTurnMaintenanceRecord(char, chat, turnState, pending.aiResponse, finalizedTurn, config, {
                    canonicalCommitGuard
                });
                if (options?.deferMaintenance !== true) {
                    startCommittedTurnMaintenance(maintenanceRecord, { reason });
                }
            } else {
            }
            if (config.debug) {
                recordRuntimeDebug('log', `[LIBRA] V4.2 turn anchor finalized via ${reason} | turn=${finalizedTurn} | chat=${chat?.id || 'global'} | key=${turnKey}`);
            }
            return {
                status: 'finalized',
                turn: finalizedTurn,
                memoryCreated: Boolean(newMemory),
                turnKey,
                maintenanceRecord: options?.deferMaintenance === true ? maintenanceRecord : null
            };
        };

        const commitPendingNow = async (char, chat, reason = 'afterRequest-immediate', options = {}) => {
            return withPendingCommitLock(chat, () => commitPendingNowUnlocked(char, chat, reason, options), options?.pending || null);
        };

        const finalizePending = async (char, chat, reason = 'stabilized', options = {}) => {
            return withPendingCommitLock(chat, async () => {
                const pending = getPending(chat);
                if (!char || !chat || !pending) return { status: 'none' };
                const latest = resolveLatestPendingSnapshot(chat, pending);
                if (!latest.resolvedHash) return { status: 'waiting', reason: 'no_latest_hash' };
                const now = Date.now();
                pending.lastSeenAt = now;
                if (pending.observedHash === latest.resolvedHash) pending.stableMatches = Number(pending.stableMatches || 0) + 1;
                else pending.stableMatches = 1;
                pending.observedHash = latest.resolvedHash;
                pending.observedMessageId = latest.resolvedMessageId || pending.observedMessageId || null;
                pending.aiResponse = Utils.getMemorySourceText(latest.resolvedText || pending.aiResponse || '');
                pending.aiResponseRaw = Utils.getMemorySourceText(pending.aiResponseRaw || pending.aiResponse || '');
                MemoryState.pendingTurnCommits.set(findScopedMapKey(MemoryState.pendingTurnCommits, chat, pending), pending);

                if ((now - Number(pending.createdAt || now)) < PENDING_FINALIZE_MIN_MS) {
                    const retryScheduled = options?.suppressFinalizeRetry === true
                        ? false
                        : schedulePendingFinalizeRetry(char, chat, reason, PENDING_FINALIZE_MIN_MS - (now - Number(pending.createdAt || now)) + 250);
                    return { status: 'waiting', reason: 'age_guard', retryScheduled };
                }
                if (Number(pending.stableMatches || 0) < PENDING_FINALIZE_REQUIRED_MATCHES) {
                    const retryScheduled = options?.suppressFinalizeRetry === true
                        ? false
                        : schedulePendingFinalizeRetry(char, chat, reason, 900);
                    return { status: 'waiting', reason: 'stability_guard', retryScheduled, stableMatches: Number(pending.stableMatches || 0) };
                }
                return commitPendingNowUnlocked(char, chat, reason, {
                    pending,
                    deferMaintenance: options?.deferMaintenance === true,
                    suppressFinalizeRetry: options?.suppressFinalizeRetry === true
                });
            });
        };

        return Object.freeze({
            getPending,
            hasPendingReceipt,
            setDurableReplayScheduler,
            noteDurableReplayBacklog,
            needsReplay,
            inspectDeferred,
            getPendingComparableHashes,
            isLikelyAlreadyFinalized,
            registerPending,
            finalizePending,
            commitPendingNow,
            schedulePendingFinalizeRetry,
            dropPending,
            getFinalizedTurnMeta,
            setFinalizedTurnMeta
        });
    })();
