    const TurnRecordLedger = (() => {
        const getScopeKey = (chat = null, char = null, options = {}) => String(
            options?.scopeKey
            || getChatMemoryScopeKey(chat, char)
            || ((typeof getActiveManagedRuntimeScopeKey !== 'undefined' && typeof getActiveManagedRuntimeScopeKey === 'function') ? getActiveManagedRuntimeScopeKey() : '')
            || chat?.id
            || 'global'
        ).trim() || 'global';

        const defaultState = (chat = null, char = null, options = {}) => ({
            version: V42_TURN_RECORD_VERSION,
            kind: 'v42_turn_records',
            recordFormat: V42_TURN_RECORD_FORMAT,
            scopeKey: getScopeKey(chat, char, options),
            chatId: String(options?.chatId || chat?.id || ((typeof getActiveManagedChatId !== 'undefined' && typeof getActiveManagedChatId === 'function') ? getActiveManagedChatId() : '') || '').trim(),
            updatedAt: Date.now(),
            records: []
        });

        const isMatchingEntry = (entry = {}, scopeKey = '') => {
            if (String(entry?.comment || '').trim() !== V42_TURN_RECORD_COMMENT) return false;
            const parsed = parseJsonSafeV42(entry?.content || '{}', null);
            const entryScope = String(parsed?.scopeKey || parsed?.scopeId || '').trim();
            return !entryScope || !scopeKey || entryScope === scopeKey;
        };

        const findIndex = (lorebook = [], scopeKey = '') => Array.isArray(lorebook)
            ? lorebook.findIndex(entry => isMatchingEntry(entry, scopeKey))
            : -1;

        const hydrateStoredRecord = (record = {}, chat = null, char = null, options = {}) => {
            const scopeKey = getScopeKey(chat, char, options);
            const turn = normalizeLegacyMemoryTurnAnchor(
                record?.turn
                || record?.turnAnchor
                || record?.turnAnchorTurn
                || record?.lockedTurn
                || record?.finalizedTurn
            );
            const liveMessageIds = normalizeCanonicalMessageIds(record?.liveMessageIds || record?.sourceMessageIds || record?.messageId || record?.m_id);
            const sourceHash = String(record?.sourceHash || record?.aiHash || '').trim();
            const userTurnKey = String(record?.userTurnKey || '').trim();
            const rawMessageSignature = String(record?.messageSignature || '').trim();
            const messageSignature = compactTurnMessageSignature(rawMessageSignature);
            const turnKey = String(
                record?.turnKey
                || buildCanonicalTurnKey(chat?.id || record?.chatId || '', userTurnKey, sourceHash, messageSignature, liveMessageIds)
            ).trim();
            const finalizedAt = Number(record?.finalizedAt || 0);
            const updatedAt = Number(record?.updatedAt || 0);
            return {
                version: V42_TURN_RECORD_VERSION,
                scopeKey,
                chatId: String(record?.chatId || options?.chatId || chat?.id || '').trim(),
                turn,
                turnAnchor: turn,
                turnAnchorTurn: turn,
                lockedTurn: turn,
                finalizedTurn: turn,
                turnKey,
                userTurnKey,
                sourceReceipt: record?.sourceReceipt?.schema === 'wm.prospective-source.v1' ? { ...safeClone(record.sourceReceipt), analysisEligible: false, replacementEligible: false } : null,
                sourceHash,
                aiHash: String(record?.aiHash || sourceHash || '').trim(),
                messageId: getPrimaryCanonicalMessageId(liveMessageIds, true) || null,
                liveMessageIds,
                sourceMessageIds: liveMessageIds,
                messageSignature,
                messageSignatureHash: rawMessageSignature ? stableHash(rawMessageSignature) : '',
                userPreview: String(record?.userPreview || record?.userMsg || record?.userMsgForNarrative || record?.userMsgForMemory || '').replace(/\s+/g, ' ').trim().slice(0, 90),
                aiPreview: String(record?.aiPreview || record?.aiResponse || '').replace(/\s+/g, ' ').trim().slice(0, 140),
                memoryKey: String(record?.memoryKey || '').trim(),
                status: String(record?.status || 'active').trim() || 'active',
                reason: String(record?.reason || 'afterRequest-finalized').trim() || 'afterRequest-finalized',
                runtimeMode: String(record?.runtimeMode || 'turn-anchor').trim() || 'turn-anchor',
                runtimeReliability: String(record?.runtimeReliability || 'normal').trim() || 'normal',
                finalizedAt: finalizedAt > 0 ? finalizedAt : 0,
                updatedAt: updatedAt > 0 ? updatedAt : 0,
                deletedAt: Number(record?.deletedAt || 0),
                deletionReason: String(record?.deletionReason || '').trim(),
                supersededAt: Number(record?.supersededAt || 0),
                supersededBy: String(record?.supersededBy || '').trim(),
                supersededByHash: String(record?.supersededByHash || '').trim(),
                supersededByTurnKey: String(record?.supersededByTurnKey || '').trim(),
                supersedeReason: String(record?.supersedeReason || '').trim()
            };
        };

        const loadState = (lorebook = [], chat = null, char = null, options = {}) => {
            const scopeKey = getScopeKey(chat, char, options);
            const idx = findIndex(lorebook, scopeKey);
            if (idx < 0) return defaultState(chat, char, { ...options, scopeKey });
            const parsed = parseJsonSafeV42(lorebook[idx]?.content || '{}', null);
            if (!parsed || typeof parsed !== 'object') return defaultState(chat, char, { ...options, scopeKey });
            const chatId = String(parsed?.chatId || options?.chatId || chat?.id || '').trim();
            return {
                ...defaultState(chat, char, { ...options, scopeKey, chatId }),
                ...parsed,
                version: V42_TURN_RECORD_VERSION,
                recordFormat: V42_TURN_RECORD_FORMAT,
                scopeKey,
                chatId,
                records: (Array.isArray(parsed?.records) ? parsed.records : [])
                    .map(record => hydrateStoredRecord(record, chat, char, { ...options, scopeKey, chatId }))
                    .filter(record => normalizeLegacyMemoryTurnAnchor(record?.turn) > 0)
            };
        };

        const normalizeRecord = (record = {}, chat = null, char = null, options = {}) => ({
            ...hydrateStoredRecord(record, chat, char, options),
            finalizedAt: Number(record?.finalizedAt || Date.now()),
            updatedAt: Date.now()
        });

        const compactRecordForStorage = (record = {}, chat = null, char = null, options = {}) => {
            const normalized = hydrateStoredRecord(record, chat, char, options);
            if (normalized.turn <= 0) return null;
            const liveMessageIds = normalizeCanonicalMessageIds(normalized.liveMessageIds || normalized.sourceMessageIds || normalized.messageId);
            const messageId = getPrimaryCanonicalMessageId(liveMessageIds, true) || normalized.messageId || null;
            const out = { turn: normalized.turn };
            if (normalized.turnKey) out.turnKey = normalized.turnKey;
            if (normalized.userTurnKey) out.userTurnKey = normalized.userTurnKey;
            if (normalized.sourceReceipt) out.sourceReceipt = safeClone(normalized.sourceReceipt);
            if (normalized.sourceHash) out.sourceHash = normalized.sourceHash;
            if (normalized.aiHash && normalized.aiHash !== normalized.sourceHash) out.aiHash = normalized.aiHash;
            if (messageId) out.messageId = messageId;
            if (liveMessageIds.length > 1) out.liveMessageIds = liveMessageIds;
            if (normalized.memoryKey) out.memoryKey = normalized.memoryKey;
            if (normalized.userPreview) out.userPreview = normalized.userPreview.slice(0, 90);
            if (normalized.aiPreview) out.aiPreview = normalized.aiPreview.slice(0, 120);
            if (normalized.status && normalized.status !== 'active') out.status = normalized.status;
            if (normalized.reason && normalized.reason !== 'afterRequest-finalized') out.reason = normalized.reason;
            if (normalized.runtimeMode && normalized.runtimeMode !== 'turn-anchor') out.runtimeMode = normalized.runtimeMode;
            if (normalized.runtimeReliability && normalized.runtimeReliability !== 'normal') out.runtimeReliability = normalized.runtimeReliability;
            if (normalized.finalizedAt > 0) out.finalizedAt = normalized.finalizedAt;
            if (normalized.status === 'deleted') {
                if (normalized.deletedAt > 0) out.deletedAt = normalized.deletedAt;
                if (normalized.deletionReason) out.deletionReason = normalized.deletionReason;
            }
            if (normalized.status === 'superseded') {
                if (normalized.supersededAt > 0) out.supersededAt = normalized.supersededAt;
                if (normalized.supersededBy) out.supersededBy = normalized.supersededBy;
                if (normalized.supersededByHash) out.supersededByHash = normalized.supersededByHash;
                if (normalized.supersededByTurnKey) out.supersededByTurnKey = normalized.supersededByTurnKey;
                if (normalized.supersedeReason) out.supersedeReason = normalized.supersedeReason;
            }
            return out;
        };

        const saveState = (lorebook = [], state = {}, chat = null, char = null, options = {}) => {
            if (!Array.isArray(lorebook)) return false;
            const scopeKey = getScopeKey(chat, char, options);
            const compactRecords = (Array.isArray(state?.records) ? state.records : [])
                .map(record => hydrateStoredRecord(record, chat, char, { ...options, scopeKey }))
                .filter(item => normalizeLegacyMemoryTurnAnchor(item?.turn) > 0)
                .sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0))
                .slice(-V42_TURN_RECORD_LIMIT)
                .map(record => compactRecordForStorage(record, chat, char, { ...options, scopeKey }))
                .filter(Boolean);
            const normalized = {
                ...defaultState(chat, char, { ...options, scopeKey }),
                ...state,
                version: V42_TURN_RECORD_VERSION,
                kind: 'v42_turn_records',
                recordFormat: V42_TURN_RECORD_FORMAT,
                scopeKey,
                chatId: String(state?.chatId || chat?.id || '').trim(),
                updatedAt: Date.now(),
                records: compactRecords
            };
            const entry = {
                key: `lmai_turn_records::${stableHash(scopeKey)}`,
                comment: V42_TURN_RECORD_COMMENT,
                content: JSON.stringify(normalized),
                mode: 'normal',
                insertorder: 110,
                alwaysActive: false,
                memo: 'LIBRA V4.2 turn anchor ledger'
            };
            const idx = findIndex(lorebook, scopeKey);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
            return true;
        };

        const upsertRecord = (lorebook = [], record = {}, chat = null, char = null, options = {}) => {
            if (!Array.isArray(lorebook)) return null;
            const normalized = normalizeRecord(record, chat, char, options);
            if (normalized.turn <= 0 || !normalized.sourceHash) return null;
            const state = loadState(lorebook, chat, char, options);
            const idx = state.records.findIndex(existing => {
                if (existing?.turnKey && normalized.turnKey && existing.turnKey === normalized.turnKey) return true;
                if (hasCanonicalMessageIdOverlap(existing?.liveMessageIds || existing?.sourceMessageIds || existing?.messageId, normalized.liveMessageIds)) return true;
                const sameTurn = normalizeLegacyMemoryTurnAnchor(existing?.turn) === normalized.turn && normalized.turn > 0;
                if (sameTurn && existing?.sourceHash && normalized.sourceHash && existing.sourceHash === normalized.sourceHash) return true;
                return sameTurn;
            });
            if (idx >= 0) state.records[idx] = { ...state.records[idx], ...normalized, updatedAt: Date.now() };
            else state.records.push(normalized);
            saveState(lorebook, state, chat, char, options);
            return normalized;
        };

        const markDeleted = (lorebook = [], record = {}, chat = null, char = null, options = {}) => {
            if (!Array.isArray(lorebook)) return false;
            const state = loadState(lorebook, chat, char, options);
            const normalized = normalizeRecord({ ...record, status: 'deleted', reason: record?.reason || 'live-message-deleted' }, chat, char, options);
            let changed = false;
            for (const existing of state.records) {
                const turnMatch = normalized.turn > 0 && normalizeLegacyMemoryTurnAnchor(existing?.turn) === normalized.turn;
                const hashMatch = normalized.sourceHash && existing?.sourceHash === normalized.sourceHash;
                const idMatch = hasCanonicalMessageIdOverlap(existing?.liveMessageIds || existing?.sourceMessageIds || existing?.messageId, normalized.liveMessageIds);
                if (!turnMatch && !hashMatch && !idMatch) continue;
                existing.status = 'deleted';
                existing.deletedAt = Date.now();
                existing.deletionReason = String(record?.reason || 'live-message-deleted').trim();
                existing.updatedAt = Date.now();
                changed = true;
            }
            if (!changed && normalized.turn > 0) {
                state.records.push({ ...normalized, status: 'deleted', deletedAt: Date.now(), deletionReason: String(record?.reason || 'live-message-deleted') });
                changed = true;
            }
            if (changed) saveState(lorebook, state, chat, char, options);
            return changed;
        };

        const markSuperseded = (lorebook = [], record = {}, chat = null, char = null, options = {}) => {
            if (!Array.isArray(lorebook)) return false;
            const state = loadState(lorebook, chat, char, options);
            const normalized = normalizeRecord({ ...record, status: 'superseded', reason: record?.reason || 'same-user-turn-replaced' }, chat, char, options);
            const supersededAt = Date.now();
            let changed = false;
            for (const existing of state.records) {
                const existingHash = String(existing?.sourceHash || existing?.aiHash || '').trim();
                const existingTurnKey = String(existing?.turnKey || '').trim();
                const existingUserTurnKey = String(existing?.userTurnKey || '').trim();
                const incomingHash = String(normalized?.sourceHash || normalized?.aiHash || '').trim();
                const incomingTurnKey = String(normalized?.turnKey || '').trim();
                const hashMatch = incomingHash && existingHash && existingHash === incomingHash;
                const turnKeyMatch = incomingTurnKey && existingTurnKey && existingTurnKey === incomingTurnKey;
                const idMatch = hasCanonicalMessageIdOverlap(existing?.liveMessageIds || existing?.sourceMessageIds || existing?.messageId, normalized.liveMessageIds);
                const sameUserTurn = existingUserTurnKey && normalized.userTurnKey && existingUserTurnKey === normalized.userTurnKey;
                if (!hashMatch && !turnKeyMatch && !idMatch) continue;
                if (!sameUserTurn && normalized.userTurnKey) continue;
                existing.status = 'superseded';
                existing.supersededAt = supersededAt;
                existing.supersededBy = String(record?.supersededBy || '').trim();
                existing.supersededByHash = String(record?.supersededByHash || '').trim();
                existing.supersededByTurnKey = String(record?.supersededByTurnKey || '').trim();
                existing.supersedeReason = String(record?.reason || 'same-user-turn-replaced').trim();
                existing.updatedAt = supersededAt;
                changed = true;
            }
            if (!changed && normalized.turn > 0) {
                state.records.push({
                    ...normalized,
                    status: 'superseded',
                    supersededAt,
                    supersededBy: String(record?.supersededBy || '').trim(),
                    supersededByHash: String(record?.supersededByHash || '').trim(),
                    supersededByTurnKey: String(record?.supersededByTurnKey || '').trim(),
                    supersedeReason: String(record?.reason || 'same-user-turn-replaced').trim()
                });
                changed = true;
            }
            if (changed) saveState(lorebook, state, chat, char, options);
            return changed;
        };

        const deriveMaxTurn = (lorebook = [], chat = null, char = null, options = {}) => {
            const state = loadState(lorebook, chat, char, options);
            return Math.max(0, ...state.records
                .filter(item => !['deleted', 'superseded'].includes(String(item?.status || 'active')))
                .map(item => normalizeLegacyMemoryTurnAnchor(item?.turn)));
        };

        return Object.freeze({ loadState, saveState, upsertRecord, markDeleted, markSuperseded, deriveMaxTurn, normalizeRecord });
    })();

    // Canonical, host-independent turn ledger. Risu's setChatToIndex replaces a
    // whole chat object and has no CAS, so localLore cannot be the only copy of
    // a completed RP turn. Each raw turn is written first under its own strongly
    // prefixed pluginStorage key; the compact index and localLore projections
    // are rebuildable derivatives.
    const DurableTurnLedger = (() => {
        const PREFIX = 'libra.v5.ltm.turn-ledger::';
        const INDEX_VERSION = 2;
        const PAGE_RECORDS = 32;
        const locks = new Map();

        // Raw capture is lossless. Narrative normalization belongs to the
        // analysis projection, never to the durable receipt.
        const rawText = (value = '') => String(value ?? '');
        const rawHash = (userText, assistantText) => stableHash(JSON.stringify([userText, assistantText]));
        const rawBytes = text => new TextEncoder().encode(text).byteLength;
        const normalizeScope = (scopeKey = '') => String(scopeKey || 'global').trim() || 'global';
        const scopeStorageId = (scopeKey = '') => {
            const scope = normalizeScope(scopeKey);
            return `${stableHash(scope)}::${encodeURIComponent(scope)}`;
        };
        const indexKey = (scopeKey = '') => `${PREFIX}${scopeStorageId(scopeKey)}::index`;
        const recordKey = (scopeKey = '', recordId = '') => `${PREFIX}${scopeStorageId(scopeKey)}::record::${encodeURIComponent(String(recordId || 'unknown'))}`;
        const parse = (value, fallback = null) => {
            try { return typeof value === 'string' ? JSON.parse(value) : (value && typeof value === 'object' ? value : fallback); }
            catch { return fallback; }
        };
        const withKeyLock = async (key, task) => {
            const previous = locks.get(key) || Promise.resolve();
            let current = null;
            current = previous.catch(() => null).then(task);
            locks.set(key, current);
            try { return await current; }
            finally { if (locks.get(key) === current) locks.delete(key); }
        };
        const readIndex = async (scopeKey = '') => {
            const raw = await RisuCompat.pluginStorage.getItem(indexKey(scopeKey), { strict: true });
            const parsed = parse(raw, null);
            if (raw != null && (!parsed || ![1, INDEX_VERSION].includes(parsed.version) || parsed.scopeKey !== normalizeScope(scopeKey) || !Array.isArray(parsed.records))) {
                throw new Error('turn ledger index invalid');
            }
            return parsed
                ? parsed
                : { version: INDEX_VERSION, scopeKey: normalizeScope(scopeKey), updatedAt: 0, records: [], previousPageKey: '', pageCount: 0, recordCount: 0 };
        };
        const beforeDeadline = async (task, deadline = Infinity) => {
            if (!Number.isFinite(deadline)) return await task();
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('raw_ack_deadline');
            let timer;
            try {
                return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('raw_ack_deadline')), remaining); })]);
            } finally { if (timer) clearTimeout(timer); }
        };
        const writeExact = async (key, value, reason, deadline = Infinity) => {
            const encoded = JSON.stringify(value);
            // The caller's ACK deadline may expire, but a started mutation
            // still owns the enclosing key lock until the host settles it.
            // Racing the write itself would release that lock while the late
            // write can still overwrite a newer verified journal head.
            if (Number.isFinite(deadline) && Date.now() >= deadline) throw new Error('raw_ack_deadline');
            if (await RisuCompat.pluginStorage.setItem(key, encoded) === false) throw new Error(reason);
            if (await beforeDeadline(() => RisuCompat.pluginStorage.getItem(key, { strict: true }), deadline) !== encoded) throw new Error(`${reason}_readback`);
        };
        const immutableFields = ['version', 'kind', 'recordId', 'recordKey', 'requestId', 'scopeKey', 'runtimeScopeKey', 'canonicalScope', 'characterId', 'characterIndex', 'chatId', 'chatIndex', 'requestSequence', 'requestType', 'resetGeneration', 'userText', 'assistantText', 'responseHash', 'rawHash', 'userBytes', 'assistantBytes', 'journalSequence', 'journalPageNumber', 'captureSource', 'observedAt'];
        const readLifecycle = async (record, deadline = Infinity) => {
            if (record?.version !== 2) return record;
            const raw = await beforeDeadline(() => RisuCompat.pluginStorage.getItem(`${record.recordKey}::status`, { strict: true }), deadline);
            if (raw == null) return record;
            const metadata = parse(raw, null);
            if (!metadata || metadata.version !== 1 || metadata.recordKey !== record.recordKey || metadata.scopeKey !== record.scopeKey || metadata.rawHash !== record.rawHash
                || !metadata.patch || typeof metadata.patch !== 'object' || Array.isArray(metadata.patch)
                || immutableFields.some(field => Object.prototype.hasOwnProperty.call(metadata.patch, field))) throw new Error('raw_status_metadata_invalid');
            return { ...record, ...metadata.patch };
        };
        const sealPage = async (scopeKey, index, deadline = Infinity) => {
            const pageKey = `${indexKey(scopeKey)}::page::${Number(index.pageCount || 0) + 1}`;
            const page = { version: INDEX_VERSION, scopeKey, previousPageKey: index.previousPageKey || '', records: index.records.slice() };
            await writeExact(pageKey, page, 'turn ledger page write failed', deadline);
            index.previousPageKey = pageKey;
            index.pageCount = Number(index.pageCount || 0) + 1;
            index.records = [];
        };
        const migrateIndex = async (scopeKey, index, deadline = Infinity) => {
            if (index.version === INDEX_VERSION) return index;
            const refs = index.records.slice();
            const next = { version: INDEX_VERSION, scopeKey, updatedAt: index.updatedAt, records: [], previousPageKey: '', pageCount: 0, recordCount: refs.length };
            for (const ref of refs) {
                if (next.records.length >= PAGE_RECORDS) await sealPage(scopeKey, next, deadline);
                next.records.push(ref);
            }
            return next;
        };
        const appendObserved = async (payload = {}) => {
            const scopeKey = String(payload.scopeKey || payload.origin?.scopeKey || payload.chatId || 'global').trim() || 'global';
            const requestSequence = Math.max(0, Number(payload.requestSequence || payload.origin?.requestSequence || 0));
            const chatId = String(payload.chatId || payload.origin?.chatId || payload.chat?.id || '').trim();
            const characterId = String(payload.characterId || payload.origin?.characterId || payload.char?.id || payload.char?.chaId || '').trim();
            const assistantText = rawText(payload.assistantText ?? payload.responseText ?? '');
            const userText = rawText(payload.userText ?? payload.origin?.canonicalUser?.raw ?? payload.origin?.canonicalUser?.strict ?? '');
            const responseHash = String((assistantText ? TokenizerEngine.simpleHash(assistantText) : '') || '').trim();
            if (!chatId || !assistantText || !responseHash) return { ok: false, reason: 'missing_turn_identity' };
            const requestId = String(payload.recordId || `${scopeKey}::${requestSequence || 'na'}::${responseHash}`).trim();
            let recordId = requestId;
            let key = recordKey(scopeKey, recordId);
            const now = Date.now();
            const observedAt = Math.max(0, Number(payload.observedAt || payload.origin?.observedAt || now) || now);
            const analysisDeadlineAt = Math.max(0, Number(payload.analysisDeadlineAt || payload.origin?.analysisDeadlineAt || 0) || 0);
            const ackDeadline = now + Math.max(1, Math.min(1500, Number(payload.ackBudgetMs || 1500) || 1500));
            const record = {
                version: 2,
                kind: 'libra_raw_turn',
                runtimeScopeKey: String(payload.runtimeScopeKey || payload.origin?.runtimeScopeKey || '').trim(),
                canonicalScope: String(payload.canonicalScope || payload.origin?.canonicalScope || '').trim(),
                resetGeneration: payload.resetGeneration ?? payload.origin?.resetGeneration ?? 0,
                requestId,
                recordId,
                recordKey: key,
                scopeKey,
                characterId,
                characterIndex: normalizeRisuIndex(payload.characterIndex ?? payload.origin?.characterIndex),
                chatId,
                chatIndex: normalizeRisuIndex(payload.chatIndex ?? payload.origin?.chatIndex),
                requestSequence,
                requestType: String(payload.requestType || payload.origin?.requestType || 'model').trim(),
                originMessageCount: Math.max(0, Number(payload.originMessageCount ?? payload.origin?.messageCount ?? 0) || 0),
                sourceCapture: payload.origin?.sourceCapture ? safeClone(payload.origin.sourceCapture) : null,
                mainResponseLanguageTarget: normalizeInternalDataLanguageTarget(payload.mainResponseLanguageTarget || ''),
                responseHash,
                rawHash: rawHash(userText, assistantText),
                userBytes: rawBytes(userText),
                assistantBytes: rawBytes(assistantText),
                captureSource: String(payload.captureSource || 'afterRequest'),
                userText,
                assistantText,
                status: 'observed',
                analysisStatus: 'pending',
                observedAt,
                analysisDeadlineAt,
                updatedAt: now
            };
            try { return await beforeDeadline(() => withKeyLock(indexKey(scopeKey), async () => {
                try {
                    const index = await migrateIndex(scopeKey, await beforeDeadline(() => readIndex(scopeKey), ackDeadline), ackDeadline);
                    const readRecord = recordKey => beforeDeadline(() => RisuCompat.pluginStorage.getItem(recordKey, { strict: true }), ackDeadline);
                    const existingRaw = await readRecord(key);
                    let existing = parse(existingRaw, null);
                    if (existingRaw != null && !existing) throw new Error('raw_receipt_invalid');
                    const sameRaw = value => value && value.scopeKey === scopeKey && value.chatId === chatId && value.characterId === characterId
                        && Number(value.requestSequence || 0) === requestSequence && value.requestType === record.requestType
                        && value.userText === userText && value.assistantText === assistantText;
                    if (existing && !sameRaw(existing)) {
                        recordId = `${requestId}::variant::${record.rawHash}::${userText.length}:${assistantText.length}`;
                        key = recordKey(scopeKey, recordId);
                        const variantRaw = await readRecord(key);
                        existing = parse(variantRaw, null);
                        if (variantRaw != null && !existing) throw new Error('raw_receipt_invalid');
                        if (existing && !sameRaw(existing)) return { ok: false, reason: 'raw_variant_collision', recordId, recordKey: key, scopeKey };
                    }
                    record.recordId = recordId;
                    record.recordKey = key;
                    if (existing) existing = await readLifecycle(existing, ackDeadline);
                    const publicationKey = `${key}::publication`;
                    const publication = existing ? parse(await readRecord(publicationKey), null) : null;
                    const publishedPageNumber = Number(publication?.pageNumber || existing?.journalPageNumber || 0);
                    const publishedPage = publishedPageNumber > 0 && publishedPageNumber <= Number(index.pageCount || 0)
                        ? parse(await readRecord(`${indexKey(scopeKey)}::page::${publishedPageNumber}`), null)
                        : index;
                    const alreadyPublished = existing && publishedPage?.scopeKey === scopeKey && publishedPage.records?.some(ref => ref?.recordKey === key);
                    if (alreadyPublished) {
                        if (!publication) await writeExact(publicationKey, { recordKey: key, pageNumber: publishedPageNumber || Number(index.pageCount || 0) + 1 }, 'turn ledger publication write failed', ackDeadline);
                        return { ok: true, verified: true, duplicate: true, recordId, recordKey: key, scopeKey, record: existing };
                    }
                    const next = existing || { ...record, journalSequence: Number(index.recordCount || 0) + 1, journalPageNumber: Number(index.pageCount || 0) + (index.records.length >= PAGE_RECORDS ? 2 : 1) };
                    // The raw payload is immutable, including across rerolls.
                    // Both payload and bounded publication head need exact
                    // readback before this receipt can authorize analysis.
                    if (!existing) await writeExact(key, next, 'record_write_failed', ackDeadline);
                    if (index.records.length >= PAGE_RECORDS) await sealPage(scopeKey, index, ackDeadline);
                    index.records.push({ recordId, recordKey: key, requestSequence, responseHash, observedAt, rawHash: next.rawHash });
                    index.recordCount = Number(index.recordCount || 0) + 1;
                    index.updatedAt = now;
                    await writeExact(indexKey(scopeKey), index, 'turn ledger index write failed', ackDeadline);
                    await writeExact(publicationKey, { recordKey: key, pageNumber: Number(index.pageCount || 0) + 1 }, 'turn ledger publication write failed', ackDeadline);
                    return { ok: true, verified: true, recordId, recordKey: key, scopeKey, record: next };
                } catch (error) {
                    return { ok: false, reason: String(error?.message || 'record_write_failed'), recordId, recordKey: key, scopeKey };
                }
            }), ackDeadline); }
            catch (error) { return { ok: false, reason: String(error?.message || 'raw_ack_deadline'), recordId, recordKey: key, scopeKey }; }
        };
        const readRecord = async (handle = null) => {
            const key = String(handle?.recordKey || '').trim();
            const scopeKey = String(handle?.scopeKey || '').trim();
            try {
                const record = parse(await RisuCompat.pluginStorage.getItem(key, { strict: true }), null);
                if (!record || record.recordKey !== key || (scopeKey && record.scopeKey !== scopeKey)
                    || (handle?.recordId && record.recordId !== handle.recordId)) return { ok: false, reason: 'raw_record_binding_invalid' };
                if (record.version === 2 && (record.rawHash !== rawHash(record.userText, record.assistantText)
                    || record.responseHash !== String(TokenizerEngine.simpleHash(record.assistantText)))) return { ok: false, reason: 'raw_record_integrity_invalid' };
                return { ok: true, record: await readLifecycle(record) };
            } catch (error) { return { ok: false, reason: String(error?.message || 'raw_record_read_failed') }; }
        };
        const markStatus = async (handle = null, patch = {}, options = {}) => {
            const key = String(handle?.recordKey || '').trim();
            const scopeKey = String(handle?.scopeKey || patch?.scopeKey || '').trim();
            if (!key) return { ok: false, reason: 'missing_record_key' };
            return await withKeyLock(key, async () => {
                // Every lifecycle transition is bound to the immutable capture,
                // including ordinary completion/replay updates.
                const checked = await readRecord(handle);
                if (!checked.ok) return checked;
                const current = checked.record;
                if (!current) return { ok: false, reason: 'record_not_found' };
                const lifecycleOwnerCurrent = () => options.isCurrent === undefined
                    || (typeof options.isCurrent === 'function' && options.isCurrent() === true);
                if (!lifecycleOwnerCurrent()) return {ok:false,reason:'raw_lifecycle_owner_changed'};
                if (options.expectedPendingParkToken !== undefined && String(current.pendingParkToken || '') !== String(options.expectedPendingParkToken)) return {ok:false,reason:'pending_park_token_changed'};
                if (options.requireUncommitted === true && (current.status !== 'observed' || ['done','committed','terminal','discarded'].includes(String(current.analysisStatus || '')))) return {ok:false,reason:'pending_park_receipt_changed'};
                if (immutableFields.some(field => Object.prototype.hasOwnProperty.call(patch, field) && patch[field] !== current[field])) return { ok: false, reason: 'immutable_raw_receipt' };
                if (scopeKey && scopeKey !== current.scopeKey) return { ok: false, reason: 'record_scope_mismatch' };
                // A terminal uncertainty hold cannot be revived by a stale
                // replay snapshot. Explicit repair owns a separate receipt.
                if (String(current.analysisStatus || '') === 'terminal') {
                    return { ok: true, verified: true, unchanged: true, reason: 'analysis_terminal_receipt', record: current };
                }
                // Completion is authoritative for this immutable capture/job only.
                // Explicit reanalysis/new model work owns a separate recordId;
                // an old retry/replay may not downgrade a completed receipt.
                if (['done', 'committed'].includes(String(current.analysisStatus || ''))
                    && patch.analysisStatus && !['done', 'committed', 'skipped', 'terminal', 'discarded'].includes(String(patch.analysisStatus))) {
                    return { ok: true, verified: true, unchanged: true, record: current };
                }
                if (options.claimAnalysisAttempt === true) {
                    if (['skipped', 'terminal', 'discarded'].includes(String(current.analysisStatus || ''))
                        || ['skipped', 'terminal', 'discarded'].includes(String(current.status || ''))) {
                        return { ok: true, verified: true, unchanged: true, reason: 'analysis_terminal_receipt', record: current };
                    }
                    if (Number(current.resetGeneration ?? 0) !== Number(options.resetGeneration ?? 0)) return { ok: false, reason: 'analysis_receipt_generation_changed' };
                    const attempt = Math.max(0, Number(patch.analysisRecoveryAttempt || 0));
                    const started = Number(current.analysisStartedAt || current.analysisFinishedAt || 0) > 0;
                    if (attempt > Math.max(0, Number(options.maxRecoveryAttempts || 0))
                        || (started && attempt <= Math.max(0, Number(current.analysisRecoveryAttempt || 0)))) {
                        return { ok: true, verified: true, unchanged: true, reason: 'analysis_attempt_already_reserved', record: current };
                    }
                }
                if (patch.analysisRecoveryAttempt != null && current.analysisRecoveryAttempt != null
                    && Number(patch.analysisRecoveryAttempt) < Number(current.analysisRecoveryAttempt)) {
                    return { ok: true, verified: true, unchanged: true, reason: 'analysis_attempt_superseded', record: current };
                }
                const next = {
                    ...current,
                    ...patch,
                    updatedAt: Date.now()
                };
                if (scopeKey && scopeKey !== current.scopeKey) return { ok: false, reason: 'record_scope_mismatch' };
                try {
                    if (current.version === 2) {
                        // Lifecycle writes must never rewrite immutable raw
                        // chunks. Keep only metadata in this ledger sidecar.
                        const statusPatch = Object.fromEntries(Object.entries(next).filter(([field]) => !immutableFields.includes(field)));
                        await writeExact(`${key}::status`, { version: 1, recordKey: key, scopeKey: current.scopeKey, rawHash: current.rawHash, patch: statusPatch }, 'record_update_failed');
                    } else await writeExact(key, next, 'record_update_failed');
                }
                catch (error) { return {
                    ok: false, reason: String(error?.message || 'record_update_failed'),
                    // Only this locked path proved the requested ordinal had not
                    // started before its reservation write. A read/binding error
                    // above must never authorize rolling back an older attempt.
                    attemptWasUnstarted: options.claimAnalysisAttempt === true
                }; }
                if (!lifecycleOwnerCurrent()) return {ok:false,reason:'raw_lifecycle_owner_changed'};
                return { ok: true, verified: true, record: next };
            });
        };
        // Replay scans one bounded window at a time. Sealed v2 pages have
        // deterministic numbers, so oldest-first recovery need not load the
        // entire backward-linked journal before it can inspect one receipt.
        const listPendingPage = async (scopeKey = '', options = {}) => {
            const index = await readIndex(scopeKey);
            const scope = normalizeScope(scopeKey);
            const limit = Math.max(1, Math.min(32, Number(options.limit || 8) || 8));
            const pageCount = index.version === INDEX_VERSION ? Number(index.pageCount || 0) : 0;
            if (!Number.isSafeInteger(pageCount) || pageCount < 0
                || (index.version === INDEX_VERSION && (index.records.length > PAGE_RECORDS
                    || String(index.previousPageKey || '') !== (pageCount ? `${indexKey(scopeKey)}::page::${pageCount}` : '')))) throw new Error('turn ledger page count invalid');
            const available = pageCount * PAGE_RECORDS + index.records.length;
            if (options.cursor && options.cursor.scopeKey !== scope) throw new Error('turn ledger cursor scope invalid');
            const end = options.cursor?.end ?? available;
            let offset = options.cursor?.offset ?? 0;
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || offset > end || end > available) throw new Error('turn ledger cursor invalid');
            const records = [];
            let scanned = 0, loadedPageNumber = -1, refs = [];
            while (offset < end && scanned < PAGE_RECORDS && records.length < limit) {
                const pageNumber = index.version === INDEX_VERSION ? Math.floor(offset / PAGE_RECORDS) + 1 : 1;
                if (pageNumber !== loadedPageNumber) {
                    if (pageNumber > pageCount) refs = index.records;
                    else {
                        const key = `${indexKey(scopeKey)}::page::${pageNumber}`;
                        const page = parse(await RisuCompat.pluginStorage.getItem(key, { strict: true }), null);
                        const previous = pageNumber > 1 ? `${indexKey(scopeKey)}::page::${pageNumber - 1}` : '';
                        if (!page || page.version !== INDEX_VERSION || page.scopeKey !== scope
                            || !Array.isArray(page.records) || page.records.length !== PAGE_RECORDS
                            || String(page.previousPageKey || '') !== previous) throw new Error('turn ledger page missing');
                        refs = page.records;
                    }
                    loadedPageNumber = pageNumber;
                }
                const ref = refs[index.version === INDEX_VERSION ? offset % PAGE_RECORDS : offset];
                offset++; scanned++;
                const checked = await readRecord({recordKey: ref?.recordKey, recordId: ref?.recordId, scopeKey: scope});
                if (!checked.ok) {
                    if (options.strictReceiptReads === true) throw new Error(`turn ledger receipt unverified:${checked.reason || 'unknown'}`);
                    continue;
                }
                const record = checked.record;
                if (['done', 'committed', 'skipped', 'terminal', 'discarded'].includes(String(record.analysisStatus || '').trim())) continue;
                if (['skipped', 'discarded', 'terminal'].includes(String(record.status || '').trim())) continue;
                if (typeof options.acceptRecord === 'function' && !options.acceptRecord(record)) continue;
                records.push(record);
            }
            return { records, nextCursor: offset < end ? {scopeKey: scope, offset, end} : null, scanned };
        };
        const listPending = async (scopeKey = '', options = {}) => {
            const index = await readIndex(scopeKey);
            const limit = Math.max(1, Math.min(32, Number(options.limit || 8) || 8));
            const pages = [index.records];
            let pageKey = String(index.previousPageKey || '');
            const seenPages = new Set();
            while (pageKey) {
                if (seenPages.has(pageKey) || !pageKey.startsWith(`${indexKey(scopeKey)}::page::`)) throw new Error('turn ledger page chain invalid');
                seenPages.add(pageKey);
                const page = parse(await RisuCompat.pluginStorage.getItem(pageKey, { strict: true }), null);
                if (!page || page.version !== INDEX_VERSION || page.scopeKey !== normalizeScope(scopeKey) || !Array.isArray(page.records)) throw new Error('turn ledger page missing');
                pages.unshift(page.records);
                pageKey = String(page.previousPageKey || '');
            }
            const refs = pages.flat();
            if (options.oldestFirst !== true) refs.reverse();
            const records = [];
            const seenRecords = new Set();
            for (const ref of refs) {
                if (seenRecords.has(ref?.recordKey)) continue;
                seenRecords.add(ref?.recordKey);
                let parsed = parse(await RisuCompat.pluginStorage.getItem(String(ref?.recordKey || ''), { strict: true }), null);
                if (!parsed || parsed.scopeKey !== normalizeScope(scopeKey) || parsed.recordKey !== ref.recordKey || parsed.recordId !== ref.recordId) continue;
                if (parsed.version === 2 && (parsed.rawHash !== rawHash(parsed.userText, parsed.assistantText) || parsed.responseHash !== String(TokenizerEngine.simpleHash(parsed.assistantText)))) continue;
                parsed = await readLifecycle(parsed);
                if (['done', 'committed', 'skipped', 'terminal'].includes(String(parsed.analysisStatus || '').trim())) continue;
                if (['skipped', 'discarded', 'terminal'].includes(String(parsed.status || '').trim())) continue;
                records.push(parsed);
                if (records.length >= limit) break;
            }
            return records;
        };
        return Object.freeze({ appendObserved, markStatus, readRecord, listPending, listPendingPage, indexKey, recordKey });
    })();
