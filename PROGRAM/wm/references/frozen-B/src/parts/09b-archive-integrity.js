    // ══════════════════════════════════════════════════════════════
    // [MANAGER] Illustration Intervention / Visual Canon Correction
    // Visual profile data remains natural-language canon only.

    const QuarantineManager = (() => {
        const QUARANTINE_COMMENT = 'lmai_analysis_quarantine';
        const QUARANTINE_SCHEMA = 'libra.analysis_quarantine.v1';
        const MAX_ENTRIES = 80;
        const MAX_PAYLOAD_CHARS = 80000;
        const REVIEW_STATUSES = new Set(['blocked', 'reviewed', 'ignored', 'accepted', 'resolved', 'archived']);
        const HARD_INVALID_FLAGS = ['schemaInvalid', 'schema_invalid', 'wrongJsonShape', 'wrong_json_shape', 'invalid', 'partial', 'truncated'];
        const hardInvalidFlags = source => Object.fromEntries(HARD_INVALID_FLAGS.filter(key => source?.[key] === true).map(key => [key, true]));
        const defaultState = () => ({
            schema: QUARANTINE_SCHEMA,
            version: 1,
            kind: 'analysis_quarantine',
            maxEntries: MAX_ENTRIES,
            entries: [],
            lastUpdated: 0
        });
        let quarantineState = defaultState();

        const clip = (value = '', max = 220) => truncateForLLM(String(value == null ? '' : value).replace(/\s+/g, ' ').trim(), Math.max(32, Number(max || 220)), ' ... ');
        const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const asArray = (value) => Array.isArray(value) ? value : [];
        const hashText = (value = '') => {
            const text = String(value || '');
            try {
                if (typeof TokenizerEngine !== 'undefined' && TokenizerEngine?.simpleHash) {
                    return String(TokenizerEngine.simpleHash(text));
                }
            } catch (_) { /* fallback below */ }
            let hash = 0;
            for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
            return String(hash);
        };
        const compactPayloadText = (value = '', max = 1800) => clip(value, max);
        const normalizeStoredPayload = (value = null) => {
            const source = asObject(value);
            if (!Object.keys(source).length) return {};
            return safeClone(source);
        };
        const buildStoredPayload = (result = null) => {
            const source = asObject(result);
            if (!Object.keys(source).length) return {};
            const canonicalPacket = asObject(source.canonicalPacket || source.canonical_packet || source.packet || source.packet_patch);
            const entityExtraction = asObject(source.entityExtraction || source.entity_extraction);
            const maintenance = asObject(source.maintenance);
            const payload = {
                ...hardInvalidFlags(source),
                success: source.success,
                degraded: source.degraded === true,
                fallbackReason: source.fallbackReason || source.reason || source.error || '',
                sourceMode: source.sourceMode || source.source || source.meta?.sourceMode || '',
                entities: asArray(source.entities).slice(0, 48),
                relations: asArray(source.relations).slice(0, 96),
                world: asObject(source.world),
                conflicts: asArray(source.conflicts).slice(0, 48),
                rejectedEntities: asArray(source.rejectedEntities).slice(0, 48),
                rejectedRelations: asArray(source.rejectedRelations).slice(0, 48),
                conversationText: compactPayloadText(source.conversationText || source.rawText || source.raw || source.content || '', 2400)
            };
            if (Object.keys(canonicalPacket).length) payload.canonicalPacket = safeClone(canonicalPacket);
            if (Object.keys(entityExtraction).length) payload.entityExtraction = safeClone(entityExtraction);
            if (Object.keys(maintenance).length) {
                payload.maintenance = {
                    correction: asObject(maintenance.correction),
                    narrativeBrief: compactPayloadText(maintenance.narrativeBrief || maintenance.narrative_brief || '', 1000),
                    storyAuthor: asObject(maintenance.storyAuthor),
                    director: asObject(maintenance.director)
                };
            }
            let json = '';
            try { json = JSON.stringify(payload); } catch (_) { return {}; }
            if (json.length <= MAX_PAYLOAD_CHARS) return payload;
            const slim = {
                ...payload,
                canonicalPacket: undefined,
                maintenance: undefined,
                conversationText: compactPayloadText(payload.conversationText || '', 800),
                entities: asArray(payload.entities).slice(0, 24),
                relations: asArray(payload.relations).slice(0, 48),
                conflicts: asArray(payload.conflicts).slice(0, 24)
            };
            try {
                if (JSON.stringify(slim).length <= MAX_PAYLOAD_CHARS) return slim;
            } catch (_) {}
            return {
                ...hardInvalidFlags(payload),
                success: payload.success,
                degraded: payload.degraded,
                fallbackReason: payload.fallbackReason,
                sourceMode: payload.sourceMode,
                entities: asArray(payload.entities).slice(0, 12),
                relations: asArray(payload.relations).slice(0, 24),
                world: asObject(payload.world),
                conflicts: asArray(payload.conflicts).slice(0, 12),
                conversationText: compactPayloadText(payload.conversationText || '', 400)
            };
        };
        const summarizeResult = (result = null) => {
            const source = asObject(result);
            const canonicalPacket = asObject(source.canonicalPacket || source.canonical_packet || source.packet || source.packet_patch);
            const world = asObject(source.world);
            const entityNames = asArray(source.entities)
                .map(item => String(item?.name || item?.canonicalName || item?.id || '').trim())
                .filter(Boolean)
                .slice(0, 8);
            const relationNames = asArray(source.relations)
                .map(item => [item?.entityA, item?.entityB].map(name => String(name || '').trim()).filter(Boolean).join(' - '))
                .filter(Boolean)
                .slice(0, 6);
            let sourcePreview = '';
            try {
                sourcePreview = clip(source.conversationText || source.rawText || source.raw || source.content || JSON.stringify({
                    entities: entityNames,
                    relations: relationNames,
                    worldKeys: Object.keys(world).slice(0, 12),
                    packetKeys: Object.keys(canonicalPacket).slice(0, 12)
                }), 360);
            } catch (_) {
                sourcePreview = '';
            }
            return {
                success: source.success,
                degraded: source.degraded === true,
                fallbackReason: clip(source.fallbackReason || source.reason || source.error || '', 160),
                sourceMode: clip(source.sourceMode || source.source || '', 80),
                counts: {
                    entities: asArray(source.entities).length,
                    relations: asArray(source.relations).length,
                    conflicts: asArray(source.conflicts).length,
                    rejectedEntities: asArray(source.rejectedEntities).length,
                    rejectedRelations: asArray(source.rejectedRelations).length,
                    worldKeys: Object.keys(world).length,
                    packetKeys: Object.keys(canonicalPacket).length
                },
                entityNames,
                relationNames,
                worldKeys: Object.keys(world).slice(0, 16),
                packetKeys: Object.keys(canonicalPacket).slice(0, 16),
                sourcePreview
            };
        };
        const normalizeEntry = (entry = {}) => ({
            schema: QUARANTINE_SCHEMA,
            id: clip(entry?.id || '', 80),
            domain: clip(entry?.domain || '', 80),
            operation: clip(entry?.operation || '', 120),
            reason: clip(entry?.reason || '', 180),
            status: REVIEW_STATUSES.has(String(entry?.status || '').trim()) ? String(entry.status).trim() : 'blocked',
            sourceMode: clip(entry?.sourceMode || '', 80),
            turn: normalizeLegacyMemoryTurnAnchor(entry?.turn || 0),
            turnKey: clip(entry?.turnKey || '', 180),
            chatId: clip(entry?.chatId || '', 100),
            scopeKey: clip(entry?.scopeKey || '', 140),
            createdAt: Number(entry?.createdAt || Date.now()) || Date.now(),
            reviewedAt: Number(entry?.reviewedAt || 0) || 0,
            reviewNote: clip(entry?.reviewNote || '', 240),
            reviewer: clip(entry?.reviewer || '', 80),
            sourceHash: clip(entry?.sourceHash || '', 80),
            guard: asObject(entry?.guard),
            summary: asObject(entry?.summary),
            payload: normalizeStoredPayload(entry?.payload)
        });
        const normalizeState = (state = null) => {
            const source = asObject(state);
            return {
                ...defaultState(),
                schema: QUARANTINE_SCHEMA,
                version: 1,
                kind: 'analysis_quarantine',
                maxEntries: MAX_ENTRIES,
                entries: asArray(source.entries)
                    .map(normalizeEntry)
                    .filter(entry => entry.id || entry.sourceHash || entry.reason)
                    .slice(-MAX_ENTRIES),
                lastUpdated: Number(source.lastUpdated || 0) || 0
            };
        };
        const loadState = (lorebook = [], options = {}) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .find(item => item?.comment === QUARANTINE_COMMENT);
            if (!entry) {
                quarantineState = defaultState();
                return quarantineState;
            }
            try {
                const parsed = JSON.parse(entry.content || '{}');
                if (options.strictRead === true && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
                    || !Array.isArray(parsed.entries) || parsed.entries.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !(row.id || row.sourceHash || row.reason))
                    || (parsed.schema !== undefined && parsed.schema !== QUARANTINE_SCHEMA))) {
                    throw new Error('quarantinemanager_state_invalid');
                }
                quarantineState = normalizeState(parsed);
            } catch (e) {
                if (options.strictRead === true) throw new Error('quarantinemanager_state_unreadable');
                recordRuntimeDebug('warn', '[LIBRA] Analysis quarantine parse failed:', e?.message || e);
                quarantineState = defaultState();
            }
            return quarantineState;
        };
        const saveState = (lorebook = []) => {
            if (!Array.isArray(lorebook)) return;
            quarantineState = normalizeState(quarantineState);
            const entry = {
                key: 'lmai_analysis_quarantine::state',
                comment: QUARANTINE_COMMENT,
                content: JSON.stringify(quarantineState),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(item => item?.comment === QUARANTINE_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };
        const append = (lorebook = [], result = null, context = {}) => {
            if (!Array.isArray(lorebook)) return { changed: false, reason: 'missing_lorebook' };
            const guard = context?.guard && typeof context.guard === 'object'
                ? context.guard
                : (typeof AnalysisResultGuard !== 'undefined' && AnalysisResultGuard?.isMergeAllowed
                    ? AnalysisResultGuard.isMergeAllowed(result, context)
                    : { allowed: false, reason: context?.reason || 'blocked', status: 'blocked' });
            const summary = summarizeResult(result);
            let sourceHash = '';
            try { sourceHash = hashText(JSON.stringify(summary)); } catch (_) { sourceHash = hashText(String(summary.sourcePreview || '')); }
            const turn = normalizeLegacyMemoryTurnAnchor(context?.turn || result?.turn || result?.t || 0);
            const keyBasis = [
                context?.domain || guard?.domain || '',
                context?.operation || guard?.operation || '',
                turn || 0,
                context?.turnKey || '',
                guard?.reason || context?.reason || '',
                sourceHash
            ].join('::');
            const entry = normalizeEntry({
                id: hashText(keyBasis),
                domain: context?.domain || guard?.domain || '',
                operation: context?.operation || guard?.operation || '',
                reason: guard?.reason || context?.reason || summary.fallbackReason || 'blocked',
                status: guard?.status || 'blocked',
                sourceMode: context?.sourceMode || guard?.sourceMode || summary.sourceMode || '',
                turn,
                turnKey: context?.turnKey || '',
                chatId: context?.chatId || '',
                scopeKey: context?.scopeKey || '',
                createdAt: Date.now(),
                sourceHash,
                guard,
                summary,
                payload: buildStoredPayload(result)
            });
            loadState(lorebook);
            const before = quarantineState.entries.length;
            quarantineState.entries = (quarantineState.entries || []).filter(item => item.id !== entry.id);
            quarantineState.entries.push(entry);
            quarantineState.entries = quarantineState.entries
                .sort((a, b) => (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0))
                .slice(-MAX_ENTRIES);
            quarantineState.lastUpdated = Date.now();
            saveState(lorebook);
            if (context?.debug === true || context?.config?.debug === true) {
                recordRuntimeDebug('warn', '[LIBRA] Analysis result quarantined:', {
                    reason: entry.reason,
                    domain: entry.domain,
                    operation: entry.operation,
                    turn: entry.turn,
                    sourceMode: entry.sourceMode,
                    sourceHash: entry.sourceHash
                });
            }
            return { changed: quarantineState.entries.length !== before || !quarantineState.entries.slice(0, -1).some(item => item.id === entry.id), entry };
        };
        const list = (lorebook = null, options = {}) => {
            if (Array.isArray(lorebook)) loadState(lorebook, options);
            const status = String(options?.status || '').trim();
            const domain = String(options?.domain || '').trim();
            const sourceMode = String(options?.sourceMode || '').trim();
            const limit = Math.max(1, Math.min(MAX_ENTRIES, Number(options?.limit || MAX_ENTRIES) || MAX_ENTRIES));
            const newestFirst = options?.oldestFirst !== true;
            let entries = asArray(quarantineState.entries).map(entry => normalizeEntry(entry));
            if (status) entries = entries.filter(entry => entry.status === status);
            if (domain) entries = entries.filter(entry => entry.domain === domain);
            if (sourceMode) entries = entries.filter(entry => entry.sourceMode === sourceMode);
            entries = entries.sort((a, b) => newestFirst
                ? (Number(b?.createdAt || 0) || 0) - (Number(a?.createdAt || 0) || 0)
                : (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0));
            return entries.slice(0, limit).map(entry => safeClone(entry));
        };
        const getEntry = (lorebook = null, id = '') => {
            const targetId = String(id || '').trim();
            if (!targetId) return null;
            return list(lorebook, { limit: MAX_ENTRIES, oldestFirst: true }).find(entry => entry.id === targetId) || null;
        };
        const markStatus = (lorebook = [], id = '', status = 'reviewed', options = {}) => {
            if (!Array.isArray(lorebook)) return { changed: false, reason: 'missing_lorebook' };
            const targetId = String(id || '').trim();
            if (!targetId) return { changed: false, reason: 'missing_id' };
            const nextStatus = REVIEW_STATUSES.has(String(status || '').trim()) ? String(status).trim() : 'reviewed';
            loadState(lorebook);
            const idx = asArray(quarantineState.entries).findIndex(entry => String(entry?.id || '').trim() === targetId);
            if (idx < 0) return { changed: false, reason: 'not_found' };
            const previous = normalizeEntry(quarantineState.entries[idx]);
            const next = normalizeEntry({
                ...previous,
                status: nextStatus,
                reviewedAt: Date.now(),
                reviewNote: options?.note || options?.reviewNote || previous.reviewNote || '',
                reviewer: options?.reviewer || previous.reviewer || ''
            });
            quarantineState.entries[idx] = next;
            quarantineState.lastUpdated = Date.now();
            saveState(lorebook);
            return { changed: true, entry: next, previousStatus: previous.status };
        };
        const prepareAcceptedPayload = (lorebook = [], id = '', options = {}) => {
            const entry = getEntry(lorebook, id);
            if (!entry) return { ok: false, reason: 'not_found' };
            const payload = normalizeStoredPayload(entry.payload);
            if (!Object.keys(payload).length) return { ok: false, reason: 'missing_payload', entry };
            // Old compacted entries may have lost payload flags; their recorded
            // structural rejection remains authoritative for manual acceptance.
            const recordedHardReason = [entry.guard?.reason, entry.reason].map(value => String(value || '').trim())
                .find(reason => reason === 'schema_invalid' || reason === 'partial_or_invalid_result' || reason.startsWith('canonical_packet_invalid:')) || '';
            const hardBlockReason = recordedHardReason || (payload.success === false
                ? (payload.fallbackReason || payload.error || payload.reason || 'success_false')
                : (payload.degraded === true
                    ? (payload.fallbackReason || payload.error || payload.reason || 'degraded_result')
                    : ((payload.schemaInvalid === true || payload.schema_invalid === true || payload.wrongJsonShape === true || payload.wrong_json_shape === true)
                        ? 'schema_invalid'
                        : ((payload.invalid === true || payload.partial === true || payload.truncated === true)
                            ? (payload.reason || 'partial_or_invalid_result')
                            : ''))));
            if (hardBlockReason) {
                return {
                    ok: false,
                    reason: 'guard_blocked',
                    guard: {
                        allowed: false,
                        status: 'blocked',
                        reason: clip(hardBlockReason, 160),
                        sourceMode: 'gui_manual_correction',
                        domain: entry.domain || options?.domain || 'analysis',
                        operation: options?.operation || `quarantine.accept.${entry.operation || 'analysis'}`,
                        shape: AnalysisResultGuard?.summarizeShape?.(payload) || {}
                    },
                    entry
                };
            }
            const sourceMode = 'gui_manual_correction';
            const acceptedPayload = {
                ...payload,
                sourceMode,
                source: sourceMode,
                allowManualOverride: options?.allowManualOverride !== false,
                __libraAcceptedFromQuarantine: true,
                __libraQuarantineId: entry.id
            };
            const guard = AnalysisResultGuard?.isMergeAllowed?.(acceptedPayload, {
                domain: entry.domain || options?.domain || 'analysis',
                operation: options?.operation || `quarantine.accept.${entry.operation || 'analysis'}`,
                sourceMode,
                allowFallbackReasonMerge: options?.allowFallbackReasonMerge !== false
            }) || { allowed: true, status: 'ok' };
            if (!guard.allowed) return { ok: false, reason: 'guard_blocked', guard, entry };
            return { ok: true, entry, payload: acceptedPayload, guard };
        };
        const getState = () => quarantineState;
        const count = (lorebook = null) => {
            if (Array.isArray(lorebook)) loadState(lorebook);
            return Array.isArray(quarantineState.entries) ? quarantineState.entries.length : 0;
        };
        const resetState = (nextState = null) => {
            quarantineState = normalizeState(nextState || defaultState());
            return quarantineState;
        };
        const withTemporaryState = callback => {
            const previous = quarantineState;
            try {
                quarantineState = safeClone(previous);
                const result = callback();
                if (result && typeof result.then === 'function') throw new Error('management_prepare_must_be_synchronous');
                return result;
            } finally { quarantineState = previous; }
        };
        return {
            withTemporaryState,
            loadState,
            saveState,
            append,
            list,
            listQuarantineEntries: list,
            getEntry,
            markStatus,
            markQuarantineEntry: markStatus,
            prepareAcceptedPayload,
            getState,
            count,
            resetState,
            summarizeResult
        };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_QuarantineManager = QuarantineManager;
    } catch (_) { /* optional diagnostics only */ }

    const ColdArchiveManager = (() => {
        const COLD_ARCHIVE_COMMENT = 'lmai_cold_archive';
        const COLD_ARCHIVE_SCHEMA = 'libra.cold_archive.v1';
        const MAX_SHARDS = 120;
        const MAX_ITEMS_PER_SHARD = 24;
        const MAX_PREVIEW_CHARS = 220;
        const PERSISTENT_ARCHIVE_SCHEMA = 'libra.persistent_memory_shard.v1';
        const PERSISTENT_MANIFEST_SCHEMA = 'libra.persistent_memory_manifest.v1';
        const PERSISTENT_WAL_SCHEMA = 'libra.persistent_memory_wal.v1';
        const PERSISTENT_TARGET_SHARD_BYTES = 192 * 1024;
        const PERSISTENT_MAX_SHARD_BYTES = 256 * 1024;
        const PERSISTENT_MAX_ITEMS_PER_SHARD = 256;
        const defaultState = () => ({
            schema: COLD_ARCHIVE_SCHEMA,
            version: 1,
            kind: 'cold_archive',
            maxShards: MAX_SHARDS,
            shards: [],
            lastUpdated: 0
        });
        let archiveState = defaultState();

        const clip = (value = '', max = MAX_PREVIEW_CHARS) => truncateForLLM(String(value == null ? '' : value).replace(/\s+/g, ' ').trim(), Math.max(32, Number(max || MAX_PREVIEW_CHARS)), ' ... ');
        const asArray = (value) => Array.isArray(value) ? value : [];
        const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const uniq = (items = [], limit = 24) => {
            const out = [];
            const seen = new Set();
            for (const item of asArray(items)) {
                const text = String(item == null ? '' : item).trim();
                if (!text || seen.has(text)) continue;
                seen.add(text);
                out.push(text);
                if (out.length >= limit) break;
            }
            return out;
        };
        const hashText = (value = '') => {
            const text = String(value || '');
            try {
                if (typeof TokenizerEngine !== 'undefined' && TokenizerEngine?.simpleHash) return String(TokenizerEngine.simpleHash(text));
            } catch (_) { /* fallback below */ }
            let hash = 0;
            for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
            return String(hash);
        };
        const parseMemoryMeta = (entry = {}) => {
            const content = String(entry?.content || '');
            const match = content.match(/^\[META:([^\n]*)\]\n?/);
            if (!match) return {};
            try { return asObject(JSON.parse(match[1] || '{}')); } catch (_) { return {}; }
        };
        const stripMemoryMeta = (entry = {}) => String(entry?.content || '').replace(/^\[META:[^\n]*\]\n?/, '').trim();
        const parseMemoryPayload = (entry = {}) => {
            const body = stripMemoryMeta(entry);
            if (!body || !/^[\[{]/.test(body)) return {};
            try { return asObject(JSON.parse(body)); } catch (_) { return {}; }
        };
        const collectTextValues = (value, out = [], limit = 16) => {
            if (out.length >= limit || value == null) return out;
            if (typeof value === 'string' || typeof value === 'number') {
                const text = clip(value, 120);
                if (text) out.push(text);
                return out;
            }
            if (Array.isArray(value)) {
                for (const item of value) {
                    collectTextValues(item, out, limit);
                    if (out.length >= limit) break;
                }
                return out;
            }
            if (typeof value === 'object') {
                for (const key of ['name', 'subject', 'entity', 'owner', 'target', 'label', 'topic', 'slot', 'kind', 'type', 'text', 'summary', 'value']) {
                    collectTextValues(value[key], out, limit);
                    if (out.length >= limit) break;
                }
            }
            return out;
        };
        const extractTerms = (entry = {}, payload = {}, meta = {}) => {
            const source = [
                ...collectTextValues(meta.ent || meta.entities || meta.recallHints || [], [], 12),
                ...collectTextValues(payload.entities || payload.entityRefs || payload.knownBy || payload.subject || payload.owner || payload.target || [], [], 12)
            ].join(' ');
            const entities = uniq((source.match(/[\p{L}\p{N}_.'-]{2,}/gu) || [])
                .filter(token => token.length <= 40), 12);
            const payloadText = collectTextValues([
                payload.tags,
                payload.topics,
                payload.keywords,
                payload.summary,
                payload.text,
                payload.value,
                payload.note
            ], [], 18).join(' ');
            const body = payloadText || stripMemoryMeta(entry);
            const topics = uniq((body.match(/[\p{L}\p{N}_.'-]{3,}/gu) || [])
                .filter(token => !/^(schema|version|source|memory|turn|true|false|null)$/i.test(token))
                .slice(0, 80), 16);
            return { entities, topics };
        };
        const summarizeMemoryEntry = (entry = {}, index = 0, context = {}) => {
            const meta = parseMemoryMeta(entry);
            const payload = parseMemoryPayload(entry);
            const body = stripMemoryMeta(entry);
            const turn = normalizeLegacyMemoryTurnAnchor(meta.t || meta.turn || payload.turn || payload.firstSeenTurn || 0);
            const id = String(entry?.key || entry?.uid || entry?.id || hashText(String(entry?.content || '') + index)).trim();
            const sourceMessageIds = uniq([
                ...asArray(meta.sourceMessageIds),
                ...asArray(meta.liveMessageIds),
                meta.m_id,
                payload.sourceMessageId,
                ...(payload.source && typeof payload.source === 'object' ? asArray(payload.source.sourceMessageIds) : [])
            ].filter(Boolean), 8);
            const preview = clip(
                payload.summary || payload.text || payload.value || payload.content || payload.note || body,
                MAX_PREVIEW_CHARS
            );
            const terms = extractTerms(entry, payload, meta);
            const persistentRecordId = resolvePersistentEntryId(entry, index, context);
            const persistentShardIdsByRecord = context?.persistentShardIdsByRecord && typeof context.persistentShardIdsByRecord === 'object'
                ? context.persistentShardIdsByRecord
                : {};
            return {
                id: clip(id, 96),
                persistentRecordId: clip(persistentRecordId, 140),
                persistentShardId: clip(persistentShardIdsByRecord[persistentRecordId] || context?.persistentShardId || '', 140),
                turn,
                importance: Number(meta.imp || payload.importance || 0) || 0,
                ttl: Number(meta.ttl ?? 0) || 0,
                sourceMessageIds,
                sourceHash: clip(meta.sourceHash || payload.sourceHash || '', 80),
                hash: hashText(`${id}\n${turn}\n${preview}`),
                preview,
                entities: terms.entities,
                topics: terms.topics
            };
        };
        const normalizeShard = (shard = {}) => {
            const source = asObject(shard);
            const items = asArray(source.items)
                .map((item, index) => ({
                    id: clip(item?.id || '', 96),
                    persistentRecordId: clip(item?.persistentRecordId || item?.id || '', 140),
                    persistentShardId: clip(item?.persistentShardId || source?.persistentShardId || '', 140),
                    turn: normalizeLegacyMemoryTurnAnchor(item?.turn || 0),
                    importance: Number(item?.importance || 0) || 0,
                    ttl: Number(item?.ttl || 0) || 0,
                    sourceMessageIds: uniq(item?.sourceMessageIds || [], 8),
                    sourceHash: clip(item?.sourceHash || '', 80),
                    hash: clip(item?.hash || hashText(JSON.stringify(item || {}) + index), 80),
                    preview: clip(item?.preview || '', MAX_PREVIEW_CHARS),
                    entities: uniq(item?.entities || [], 12),
                    topics: uniq(item?.topics || [], 16)
                }))
                .filter(item => item.id || item.preview || item.hash)
                .slice(0, MAX_ITEMS_PER_SHARD);
            const turns = items.map(item => Number(item.turn || 0)).filter(Number.isFinite).filter(turn => turn > 0);
            const fallbackTurnRange = {
                from: turns.length ? Math.min(...turns) : 0,
                to: turns.length ? Math.max(...turns) : 0
            };
            return {
                schema: COLD_ARCHIVE_SCHEMA,
                id: clip(source.id || hashText(JSON.stringify(items)), 96),
                domain: clip(source.domain || 'memory', 80),
                reason: clip(source.reason || 'cap_pressure', 120),
                scopeKey: clip(source.scopeKey || '', 140),
                chatId: clip(source.chatId || '', 100),
                characterId: clip(source.characterId || '', 100),
                persistentShardId: clip(source.persistentShardId || '', 140),
                createdAt: Number(source.createdAt || Date.now()) || Date.now(),
                updatedAt: Number(source.updatedAt || Date.now()) || Date.now(),
                turnRange: {
                    from: normalizeLegacyMemoryTurnAnchor(source.turnRange?.from || fallbackTurnRange.from || 0),
                    to: normalizeLegacyMemoryTurnAnchor(source.turnRange?.to || fallbackTurnRange.to || 0)
                },
                entryCount: Math.max(Number(source.entryCount || items.length) || items.length, items.length),
                sourceIds: uniq(source.sourceIds || items.flatMap(item => item.sourceMessageIds), 32),
                itemHashes: uniq(source.itemHashes || items.map(item => item.hash), 32),
                entities: uniq(source.entities || items.flatMap(item => item.entities), 24),
                topics: uniq(source.topics || items.flatMap(item => item.topics), 32),
                summary: clip(source.summary || items.map(item => item.preview).filter(Boolean).slice(0, 8).join(' / '), 1200),
                items
            };
        };
        const normalizeState = (state = null) => {
            const source = asObject(state);
            return {
                ...defaultState(),
                schema: COLD_ARCHIVE_SCHEMA,
                version: 1,
                kind: 'cold_archive',
                maxShards: MAX_SHARDS,
                shards: asArray(source.shards)
                    .map(normalizeShard)
                    .filter(shard => shard.id && shard.items.length)
                    .slice(-MAX_SHARDS),
                lastUpdated: Number(source.lastUpdated || 0) || 0
            };
        };
        const loadState = (lorebook = []) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .find(item => item?.comment === COLD_ARCHIVE_COMMENT);
            if (!entry) {
                archiveState = defaultState();
                return archiveState;
            }
            try {
                archiveState = normalizeState(JSON.parse(entry.content || '{}'));
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] Cold archive parse failed:', e?.message || e);
                archiveState = defaultState();
            }
            return archiveState;
        };
        const saveState = (lorebook = []) => {
            if (!Array.isArray(lorebook)) return false;
            archiveState = normalizeState(archiveState);
            const entry = {
                key: 'lmai_cold_archive::state',
                comment: COLD_ARCHIVE_COMMENT,
                content: JSON.stringify(archiveState),
                mode: 'normal',
                insertorder: 7,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(item => item?.comment === COLD_ARCHIVE_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
            return true;
        };
        const utf8ByteLength = (value = '') => {
            const text = String(value == null ? '' : value);
            try {
                if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
            } catch (_) { /* conservative fallback below */ }
            let bytes = 0;
            for (let index = 0; index < text.length; index += 1) {
                const code = text.charCodeAt(index);
                if (code < 0x80) bytes += 1;
                else if (code < 0x800) bytes += 2;
                else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) { bytes += 4; index += 1; }
                else bytes += 3;
            }
            return bytes;
        };
        const checksumText = (value = '') => {
            const text = String(value == null ? '' : value);
            let a = 0x811c9dc5;
            let b = 0x9e3779b9;
            for (let index = 0; index < text.length; index += 1) {
                const code = text.charCodeAt(index);
                a ^= code;
                a = Math.imul(a, 0x01000193) >>> 0;
                b ^= (code + index) >>> 0;
                b = Math.imul(b, 0x85ebca6b) >>> 0;
                b ^= b >>> 13;
            }
            return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}:${utf8ByteLength(text)}`;
        };
        const persistentScopeHash = (context = {}) => {
            const raw = [context?.scopeKey || '', context?.chatId || '', context?.characterId || '', 'global'].join('::');
            return checksumText(raw).replace(/[^a-zA-Z0-9:_-]/g, '').replace(/:/g, '-');
        };
        const persistentKeys = (context = {}) => {
            const namespace = `libra:v1:${persistentScopeHash(context)}:archive`;
            return {
                namespace,
                manifest: `${namespace}:manifest`,
                wal: `${namespace}:wal`,
                shard: (id = '') => `${namespace}:shard:${String(id || '').replace(/[^a-zA-Z0-9:_-]/g, '_')}`
            };
        };
        const createPersistentStorageAdapter = async () => {
            try {
                const localStore = await RisuCompat?.localPluginStorage?.getStore?.();
                if (localStore) {
                    return {
                        kind: 'local_plugin_storage',
                        async getItem(key) {
                            if (typeof localStore.getItem === 'function') return await localStore.getItem(key);
                            if (typeof localStore.get === 'function') return await localStore.get(key);
                            return Object.prototype.hasOwnProperty.call(localStore, key) ? localStore[key] : null;
                        },
                        async setItem(key, value) {
                            if (typeof localStore.setItem === 'function') { await localStore.setItem(key, value); return true; }
                            if (typeof localStore.set === 'function') { await localStore.set(key, value); return true; }
                            localStore[key] = value;
                            return true;
                        },
                        async removeItem(key) {
                            if (typeof localStore.removeItem === 'function') { await localStore.removeItem(key); return true; }
                            if (typeof localStore.delete === 'function') return localStore.delete(key) !== false;
                            if (Object.prototype.hasOwnProperty.call(localStore, key)) delete localStore[key];
                            return true;
                        }
                    };
                }
            } catch (_) { /* plugin storage fallback below */ }
            if (RisuCompat?.pluginStorage?.getItem && RisuCompat?.pluginStorage?.setItem) {
                return {
                    kind: 'plugin_storage_fallback',
                    getItem: key => RisuCompat.pluginStorage.getItem(key),
                    setItem: (key, value) => RisuCompat.pluginStorage.setItem(key, value),
                    removeItem: key => RisuCompat.pluginStorage.removeItem(key)
                };
            }
            return null;
        };
        const parseStoredJson = (raw, fallback = null) => {
            if (raw == null || raw === '') return fallback;
            if (typeof raw === 'object') return raw;
            try { return JSON.parse(String(raw)); } catch (_) { return fallback; }
        };
        const cloneArchiveEntry = (entry = {}) => {
            try { return safeClone(entry); } catch (_) {
                try { return JSON.parse(JSON.stringify(entry)); } catch (_) { return { key: entry?.key || '', comment: entry?.comment || '', content: String(entry?.content || '') }; }
            }
        };
        const resolvePersistentEntryId = (entry = {}, index = 0, context = {}) => {
            const supplied = asArray(context?.candidateIds)[index];
            if (supplied != null && String(supplied).trim()) return String(supplied).trim();
            const explicit = String(entry?.id || entry?.key || '').trim();
            if (explicit) return explicit;
            const meta = parseMemoryMeta(entry);
            if (meta.turnKey) return `memory_turn:${String(meta.turnKey)}`;
            if (meta.sourceHash) return `memory_source:${String(meta.sourceHash)}`;
            if (meta.m_id) return `memory_msg:${String(meta.m_id)}`;
            return `memory_content:${checksumText(String(entry?.content || ''))}`;
        };
        const normalizePersistentManifest = (manifest = null, context = {}) => {
            const source = asObject(manifest);
            const shards = asArray(source.shards)
                .map(item => ({
                    id: String(item?.id || '').trim(),
                    key: String(item?.key || '').trim(),
                    checksum: String(item?.checksum || '').trim(),
                    bytes: Math.max(0, Number(item?.bytes || 0) || 0),
                    entryCount: Math.max(0, Number(item?.entryCount || 0) || 0),
                    entryIds: uniq(item?.entryIds || [], PERSISTENT_MAX_ITEMS_PER_SHARD),
                    createdAt: Number(item?.createdAt || 0) || 0,
                    turnRange: {
                        from: normalizeLegacyMemoryTurnAnchor(item?.turnRange?.from || 0),
                        to: normalizeLegacyMemoryTurnAnchor(item?.turnRange?.to || 0)
                    }
                }))
                .filter(item => item.id && item.key && item.checksum);
            return {
                schema: PERSISTENT_MANIFEST_SCHEMA,
                version: 1,
                scopeHash: persistentScopeHash(context),
                updatedAt: Number(source.updatedAt || 0) || 0,
                shardCount: shards.length,
                entryCount: shards.reduce((sum, shard) => sum + Number(shard.entryCount || 0), 0),
                shards
            };
        };
        const serializeWithChecksum = (value = {}) => {
            const payload = { ...asObject(value) };
            delete payload.checksum;
            const body = JSON.stringify(payload);
            return { body, checksum: checksumText(body) };
        };
        const partitionPersistentEntries = (entries = [], context = {}) => {
            const records = asArray(entries)
                .filter(entry => entry?.comment === 'lmai_memory')
                .map((entry, index) => ({
                    id: resolvePersistentEntryId(entry, index, context),
                    entry: cloneArchiveEntry(entry)
                }));
            const batches = [];
            let current = [];
            let currentBytes = 0;
            for (const record of records) {
                const recordBytes = utf8ByteLength(JSON.stringify(record)) + 2;
                const wouldOverflow = current.length > 0 && (
                    current.length >= PERSISTENT_MAX_ITEMS_PER_SHARD
                    || (currentBytes + recordBytes) > PERSISTENT_TARGET_SHARD_BYTES
                );
                if (wouldOverflow) {
                    batches.push(current);
                    current = [];
                    currentBytes = 0;
                }
                current.push(record);
                currentBytes += recordBytes;
                if (currentBytes >= PERSISTENT_MAX_SHARD_BYTES || current.length >= PERSISTENT_MAX_ITEMS_PER_SHARD) {
                    batches.push(current);
                    current = [];
                    currentBytes = 0;
                }
            }
            if (current.length) batches.push(current);
            return batches;
        };
        const buildPersistentShard = (records = [], context = {}, batchIndex = 0) => {
            const turns = records.map(record => Number(parseMemoryMeta(record?.entry || {}).t || 0)).filter(turn => Number.isFinite(turn) && turn > 0);
            const sourceBasis = records.map(record => `${record.id}:${checksumText(String(record?.entry?.content || ''))}`).join('|');
            const id = `ps-${checksumText(`${persistentScopeHash(context)}:${batchIndex}:${sourceBasis}`).replace(/:/g, '-')}`;
            const shardBase = {
                schema: PERSISTENT_ARCHIVE_SCHEMA,
                version: 1,
                id,
                scopeHash: persistentScopeHash(context),
                reason: String(context?.reason || 'memory_gc'),
                createdAt: Date.now(),
                turnRange: {
                    from: turns.length ? Math.min(...turns) : 0,
                    to: turns.length ? Math.max(...turns) : 0
                },
                entryCount: records.length,
                entryIds: records.map(record => record.id),
                records
            };
            const provisionalBody = JSON.stringify(shardBase);
            const shardWithBytes = { ...shardBase, bytes: utf8ByteLength(provisionalBody) };
            const serialized = serializeWithChecksum(shardWithBytes);
            return { ...shardWithBytes, checksum: serialized.checksum };
        };
        const verifyPersistentShard = (value = null, expected = null) => {
            const shard = asObject(value);
            if (shard.schema !== PERSISTENT_ARCHIVE_SCHEMA || !shard.id || !Array.isArray(shard.records)) return false;
            const serialized = serializeWithChecksum(shard);
            if (String(shard.checksum || '') !== serialized.checksum) return false;
            if (expected && String(shard.id) !== String(expected.id)) return false;
            if (expected && String(shard.checksum) !== String(expected.checksum)) return false;
            const ids = shard.records.map(record => String(record?.id || ''));
            return ids.length === Number(shard.entryCount || 0) && ids.every(Boolean);
        };
        const commitPersistentMemoryEntries = async (entries = [], context = {}) => {
            const storage = await createPersistentStorageAdapter();
            if (!storage) return { ok: false, partial: false, reason: 'persistent_storage_unavailable', ackedIds: [], shards: [] };
            const keys = persistentKeys(context);
            const batches = partitionPersistentEntries(entries, context);
            if (!batches.length) return { ok: true, partial: false, reason: 'empty_candidates', ackedIds: [], shards: [], backend: storage.kind, keys };
            const planned = batches.map((records, index) => buildPersistentShard(records, context, index));
            const transactionId = `wal-${Date.now()}-${checksumText(planned.map(shard => shard.id).join('|')).replace(/:/g, '-')}`;
            const wal = {
                schema: PERSISTENT_WAL_SCHEMA,
                version: 1,
                transactionId,
                scopeHash: persistentScopeHash(context),
                createdAt: Date.now(),
                state: 'prepared',
                planned: planned.map(shard => ({ id: shard.id, key: keys.shard(shard.id), checksum: shard.checksum, entryIds: shard.entryIds })),
                committedShardIds: [],
                remainingShardIds: planned.map(shard => shard.id)
            };
            const walWritten = await storage.setItem(keys.wal, JSON.stringify(wal));
            if (walWritten === false) return { ok: false, partial: false, reason: 'wal_write_failed', ackedIds: [], shards: [], backend: storage.kind, keys };

            const verified = [];
            const failures = [];
            for (const shard of planned) {
                const shardKey = keys.shard(shard.id);
                try {
                    const writeOk = await storage.setItem(shardKey, JSON.stringify(shard));
                    if (writeOk === false) throw new Error('write_failed');
                    const readBack = parseStoredJson(await storage.getItem(shardKey), null);
                    if (!verifyPersistentShard(readBack, shard)) throw new Error('verify_failed');
                    verified.push({ shard, key: shardKey });
                } catch (error) {
                    failures.push({ id: shard.id, reason: error?.message || String(error || 'persistent_shard_failed') });
                }
            }
            if (!verified.length) {
                wal.state = 'shard_write_failed';
                wal.failures = failures;
                await storage.setItem(keys.wal, JSON.stringify(wal));
                return { ok: false, partial: false, reason: 'no_verified_shards', ackedIds: [], shards: [], failures, backend: storage.kind, keys };
            }

            const existingManifest = normalizePersistentManifest(parseStoredJson(await storage.getItem(keys.manifest), null), context);
            const manifestById = new Map(existingManifest.shards.map(shard => [shard.id, shard]));
            for (const row of verified) {
                const shard = row.shard;
                manifestById.set(shard.id, {
                    id: shard.id,
                    key: row.key,
                    checksum: shard.checksum,
                    bytes: Number(shard.bytes || 0),
                    entryCount: shard.entryCount,
                    entryIds: shard.entryIds,
                    createdAt: shard.createdAt,
                    turnRange: shard.turnRange
                });
            }
            const nextManifestBase = normalizePersistentManifest({
                ...existingManifest,
                updatedAt: Date.now(),
                shards: Array.from(manifestById.values())
                    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
            }, context);
            const manifestSerialized = serializeWithChecksum(nextManifestBase);
            const nextManifest = { ...nextManifestBase, checksum: manifestSerialized.checksum };
            const manifestWriteOk = await storage.setItem(keys.manifest, JSON.stringify(nextManifest));
            const manifestReadBack = parseStoredJson(await storage.getItem(keys.manifest), null);
            const manifestVerify = serializeWithChecksum(manifestReadBack || {});
            const manifestOk = manifestWriteOk !== false
                && manifestReadBack?.schema === PERSISTENT_MANIFEST_SCHEMA
                && String(manifestReadBack?.checksum || '') === manifestVerify.checksum
                && verified.every(row => asArray(manifestReadBack?.shards).some(item => item?.id === row.shard.id && item?.checksum === row.shard.checksum));
            if (!manifestOk) {
                wal.state = 'manifest_write_failed';
                wal.failures = failures;
                await storage.setItem(keys.wal, JSON.stringify(wal));
                return { ok: false, partial: false, reason: 'manifest_write_failed', ackedIds: [], shards: [], failures, backend: storage.kind, keys };
            }

            const ackedIds = uniq(verified.flatMap(row => row.shard.entryIds), Math.max(1, entries.length + 8));
            const committedIds = new Set(verified.map(row => row.shard.id));
            const remainingShardIds = planned.map(shard => shard.id).filter(id => !committedIds.has(id));
            if (!remainingShardIds.length) {
                await storage.removeItem(keys.wal);
            } else {
                wal.state = 'partial_committed';
                wal.committedShardIds = Array.from(committedIds);
                wal.remainingShardIds = remainingShardIds;
                wal.failures = failures;
                wal.updatedAt = Date.now();
                await storage.setItem(keys.wal, JSON.stringify(wal));
            }
            return {
                ok: ackedIds.length > 0,
                partial: remainingShardIds.length > 0,
                reason: remainingShardIds.length ? 'partial_commit' : 'committed',
                ackedIds,
                shards: verified.map(row => safeClone(row.shard)),
                failures,
                backend: storage.kind,
                keys,
                manifest: safeClone(nextManifest)
            };
        };
        const readPersistentManifest = async (context = {}) => {
            const storage = await createPersistentStorageAdapter();
            if (!storage) return null;
            const keys = persistentKeys(context);
            return parseStoredJson(await storage.getItem(keys.manifest), null);
        };
        const readPersistentShard = async (shardId = '', context = {}) => {
            const storage = await createPersistentStorageAdapter();
            if (!storage || !shardId) return null;
            const keys = persistentKeys(context);
            return parseStoredJson(await storage.getItem(keys.shard(shardId)), null);
        };
        const buildMemoryShard = (entries = [], context = {}) => {
            const items = asArray(entries)
                .filter(entry => entry?.comment === 'lmai_memory')
                .map((entry, index) => summarizeMemoryEntry(entry, index, context))
                .filter(item => item.preview || item.id || item.hash)
                .slice(0, MAX_ITEMS_PER_SHARD);
            if (!items.length) return null;
            const turns = items.map(item => Number(item.turn || 0)).filter(turn => Number.isFinite(turn) && turn > 0);
            const reason = String(context?.reason || 'cap_pressure').trim() || 'cap_pressure';
            const sourceIds = uniq(items.flatMap(item => item.sourceMessageIds), 32);
            const basis = [
                context?.scopeKey || '',
                context?.chatId || '',
                reason,
                context?.persistentShardId || '',
                turns.length ? Math.min(...turns) : 0,
                turns.length ? Math.max(...turns) : 0,
                items.map(item => item.hash).join('|')
            ].join('::');
            return normalizeShard({
                id: `cold:${hashText(basis)}`,
                domain: 'memory',
                reason,
                scopeKey: context?.scopeKey || '',
                chatId: context?.chatId || '',
                characterId: context?.characterId || '',
                persistentShardId: context?.persistentShardId || '',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                turnRange: {
                    from: turns.length ? Math.min(...turns) : 0,
                    to: turns.length ? Math.max(...turns) : 0
                },
                entryCount: asArray(entries).length,
                sourceIds,
                itemHashes: items.map(item => item.hash),
                entities: items.flatMap(item => item.entities),
                topics: items.flatMap(item => item.topics),
                summary: `Archived ${items.length} memory entries before hot-prune (${reason}). ${items.map(item => item.preview).filter(Boolean).slice(0, 6).join(' / ')}`,
                items
            });
        };
        const appendShard = (lorebook = [], shard = null, context = {}) => {
            if (!Array.isArray(lorebook)) return { ok: false, changed: false, reason: 'missing_lorebook' };
            const normalized = normalizeShard(shard || {});
            if (!normalized.items.length) return { ok: true, changed: false, reason: 'empty_shard' };
            loadState(lorebook);
            const before = archiveState.shards.length;
            archiveState.shards = asArray(archiveState.shards).filter(item => item.id !== normalized.id);
            archiveState.shards.push(normalized);
            archiveState.shards = archiveState.shards
                .sort((a, b) => (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0))
                .slice(-MAX_SHARDS);
            archiveState.lastUpdated = Date.now();
            if (!saveState(lorebook)) return { ok: false, changed: false, reason: 'save_failed' };
            if (context?.debug === true || context?.config?.debug === true) {
                recordRuntimeDebug('log', '[LIBRA] Cold archive preview shard written:', {
                    id: normalized.id,
                    reason: normalized.reason,
                    entries: normalized.entryCount,
                    turnRange: normalized.turnRange,
                    shardCount: archiveState.shards.length
                });
            }
            return { ok: true, changed: archiveState.shards.length !== before || archiveState.shards[archiveState.shards.length - 1]?.id === normalized.id, shard: safeClone(normalized) };
        };
        const archivePrunedMemoryEntries = async (lorebook = [], entries = [], context = {}) => {
            const candidates = asArray(entries).filter(entry => entry?.comment === 'lmai_memory');
            if (!candidates.length) return { ok: true, changed: false, reason: 'empty_candidates', ackedIds: [] };
            const candidateIds = candidates.map((entry, index) => resolvePersistentEntryId(entry, index, context));
            const persistentResult = await commitPersistentMemoryEntries(candidates, { ...context, candidateIds });
            const ackedSet = new Set(asArray(persistentResult?.ackedIds).map(String));
            if (!persistentResult?.ok || !ackedSet.size) {
                return {
                    ok: false,
                    changed: false,
                    reason: persistentResult?.reason || 'persistent_archive_failed',
                    ackedIds: [],
                    persistent: persistentResult
                };
            }
            const ackedRows = candidates
                .map((entry, index) => ({ entry, persistentRecordId: candidateIds[index] }))
                .filter(row => ackedSet.has(row.persistentRecordId));
            const persistentShardIdsByRecord = Object.fromEntries(asArray(persistentResult.shards)
                .flatMap(shard => asArray(shard.entryIds).map(id => [String(id), String(shard.id || '')])));
            const previewShards = [];
            for (let offset = 0; offset < ackedRows.length; offset += MAX_ITEMS_PER_SHARD) {
                const batchRows = ackedRows.slice(offset, offset + MAX_ITEMS_PER_SHARD);
                const batch = batchRows.map(row => row.entry);
                const batchCandidateIds = batchRows.map(row => row.persistentRecordId);
                const persistentShard = asArray(persistentResult.shards).find(shard => asArray(shard.entryIds).some(id => batchCandidateIds.includes(String(id))));
                const shard = buildMemoryShard(batch, {
                    ...context,
                    candidateIds: batchCandidateIds,
                    persistentShardId: persistentShard?.id || `${offset}`,
                    persistentShardIdsByRecord
                });
                if (!shard) continue;
                const appended = appendShard(lorebook, shard, context);
                if (appended?.ok && appended?.shard) previewShards.push(appended.shard);
            }
            return {
                ok: true,
                changed: previewShards.length > 0,
                reason: persistentResult.partial ? 'partial_commit' : 'committed',
                partial: persistentResult.partial === true,
                ackedIds: Array.from(ackedSet),
                archived: ackedSet.size,
                shard: previewShards[0] || null,
                shards: previewShards,
                persistent: persistentResult
            };
        };
        const normalizeSearchTerm = (value = '') => String(value || '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_가-힣ぁ-んァ-ヶ一-龯]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const extractSearchTerms = (value = '', limit = 32) => {
            const raw = String(value || '');
            const terms = [];
            try {
                if (typeof KoreanTextCore !== 'undefined' && KoreanTextCore?.tokenize) terms.push(...KoreanTextCore.tokenize(raw, limit * 2));
            } catch (_) {}
            terms.push(...(raw.match(/[\p{L}\p{N}_.'-]{2,}/gu) || []));
            return uniq(terms
                .map(normalizeSearchTerm)
                .filter(term => term.length >= 2 && term.length <= 48)
                .filter(term => !/^(the|and|for|with|from|this|that|then|there|here|memory|schema|version|true|false|null)$/i.test(term)), limit);
        };
        const scoreArchiveText = (terms = [], values = [], weight = 1) => {
            const haystack = normalizeSearchTerm(asArray(values).join(' '));
            if (!haystack) return { score: 0, hits: [] };
            const hits = [];
            for (const term of asArray(terms)) {
                if (term && haystack.includes(term) && !hits.includes(term)) hits.push(term);
            }
            return { score: hits.length * Number(weight || 1), hits };
        };
        const scoreShardForQuery = (shard = {}, query = '', options = {}) => {
            const terms = extractSearchTerms(query, 40);
            if (!terms.length) return { score: 0, hits: [], itemScores: [] };
            const entityScore = scoreArchiveText(terms, shard.entities || [], 3.2);
            const topicScore = scoreArchiveText(terms, shard.topics || [], 1.8);
            const summaryScore = scoreArchiveText(terms, [shard.summary], 1.2);
            const itemScores = asArray(shard.items).map(item => {
                const itemTextScore = scoreArchiveText(terms, [
                    item.preview,
                    ...(item.entities || []),
                    ...(item.topics || [])
                ], 1);
                const entityBoost = scoreArchiveText(terms, item.entities || [], 2.4);
                const topicBoost = scoreArchiveText(terms, item.topics || [], 1.4);
                const score = itemTextScore.score + entityBoost.score + topicBoost.score + (Number(item.importance || 0) * 0.12);
                return {
                    item,
                    score,
                    hits: uniq([...itemTextScore.hits, ...entityBoost.hits, ...topicBoost.hits], 16)
                };
            }).filter(row => row.score > 0)
                .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.item?.importance || 0) - Number(a.item?.importance || 0));
            const score = entityScore.score + topicScore.score + summaryScore.score + Math.min(12, itemScores.reduce((sum, row) => sum + Number(row.score || 0), 0));
            return {
                score,
                hits: uniq([...entityScore.hits, ...topicScore.hits, ...summaryScore.hits, ...itemScores.flatMap(row => row.hits)], 20),
                itemScores
            };
        };
        const searchShards = (lorebook = [], query = '', options = {}) => {
            if (!Array.isArray(lorebook)) return { ok: false, reason: 'missing_lorebook', shards: [], debug: { searched: 0, matched: 0 } };
            const limit = Math.max(0, Math.min(12, Number(options?.limit || 4) || 4));
            if (limit <= 0) return { ok: true, reason: 'disabled', shards: [], debug: { searched: 0, matched: 0 } };
            loadState(lorebook);
            const minScore = Math.max(0.5, Number(options?.minScore || 2.2) || 2.2);
            const ranked = asArray(archiveState.shards)
                .map(normalizeShard)
                .map(shard => ({ shard, match: scoreShardForQuery(shard, query, options) }))
                .filter(row => Number(row.match?.score || 0) >= minScore)
                .sort((a, b) => Number(b.match?.score || 0) - Number(a.match?.score || 0) || Number(b.shard?.updatedAt || 0) - Number(a.shard?.updatedAt || 0))
                .slice(0, limit);
            return {
                ok: true,
                shards: ranked.map(row => ({ ...safeClone(row.shard), _archiveMatch: row.match })),
                debug: {
                    searched: asArray(archiveState.shards).length,
                    matched: ranked.length,
                    limit,
                    minScore,
                    top: ranked.slice(0, 5).map(row => ({
                        id: row.shard.id,
                        score: Number((row.match?.score || 0).toFixed(3)),
                        hits: row.match?.hits || [],
                        itemCount: row.match?.itemScores?.length || 0
                    }))
                }
            };
        };
        const hydrateShardsForRecall = async (shards = [], options = {}) => {
            const perShard = Math.max(1, Math.min(8, Number(options?.itemsPerShard || 3) || 3));
            const maxEntries = Math.max(1, Math.min(24, Number(options?.maxEntries || 8) || 8));
            const entries = [];
            const persistentCache = new Map();
            let fullRecords = 0;
            let previewFallbacks = 0;
            for (const shard of asArray(shards)) {
                const matchItems = asArray(shard?._archiveMatch?.itemScores);
                const fallbackItems = asArray(shard?.items).map(item => ({ item, score: Number(item?.importance || 0) || 0, hits: [] }));
                const selectedItems = (matchItems.length ? matchItems : fallbackItems)
                    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.item?.importance || 0) - Number(a.item?.importance || 0))
                    .slice(0, perShard);
                for (const row of selectedItems) {
                    const item = row.item || {};
                    const persistentShardId = String(item.persistentShardId || shard?.persistentShardId || '').trim();
                    const persistentRecordId = String(item.persistentRecordId || item.id || '').trim();
                    if (persistentShardId && persistentRecordId) {
                        let persistentShard = persistentCache.get(persistentShardId);
                        if (persistentShard === undefined) {
                            persistentShard = await readPersistentShard(persistentShardId, {
                                scopeKey: shard?.scopeKey || options?.scopeKey || '',
                                chatId: shard?.chatId || options?.chatId || '',
                                characterId: shard?.characterId || options?.characterId || ''
                            });
                            persistentCache.set(persistentShardId, persistentShard || null);
                        }
                        const record = verifyPersistentShard(persistentShard)
                            ? asArray(persistentShard.records).find(candidate => String(candidate?.id || '') === persistentRecordId)
                            : null;
                        if (record?.entry) {
                            const fullEntry = cloneArchiveEntry(record.entry);
                            const fullMeta = {
                                ...parseMemoryMeta(fullEntry),
                                imp: Math.max(4, Math.min(9, Number(parseMemoryMeta(fullEntry)?.imp || item.importance || 5) || 5)),
                                ttl: -1,
                                coldArchive: true,
                                coldArchiveShardId: shard.id,
                                coldArchivePersistentShardId: persistentShardId
                            };
                            fullEntry.content = `[META:${JSON.stringify(fullMeta)}]\n${stripMemoryMeta(fullEntry)}\n`;
                            const originalFullEntry = cloneArchiveEntry(fullEntry);
                            try {
                                const recognized = CompactMemoryCodec?.parsePayloadFromEntry?.(fullEntry);
                                if (!recognized && CompactMemoryCodec?.buildTurnPayload) {
                                    const legacyPayload = parseMemoryPayload(fullEntry);
                                    const legacyText = collectTextValues(legacyPayload, [], 36).join('\n') || item.preview || shard.summary || '';
                                    const upgraded = CompactMemoryCodec.buildTurnPayload('', legacyText, {
                                        turn: normalizeLegacyMemoryTurnAnchor(fullMeta.t || item.turn || 0),
                                        importance: fullMeta.imp || item.importance || 5,
                                        sourceHash: fullMeta.sourceHash || item.sourceHash || '',
                                        sourceMessageIds: fullMeta.sourceMessageIds || item.sourceMessageIds || []
                                    });
                                    if (upgraded) fullEntry.content = `[META:${JSON.stringify(fullMeta)}]\n${CompactMemoryCodec.serialize(upgraded)}\n`;
                                }
                            } catch (_) {}
                            // 아카이브 복원은 imp/ttl/coldArchive 를 덧붙이므로 무결성 체크섬이 무효가 된다.
                            // 재스탬프하지 않으면 복원된 기억이 회상 후보에서 조용히 탈락한다.
                            try {
                                const archiveBody = String(fullEntry.content || '').replace(/^\[META:\{[^\r\n]*\}\]/, '').trim();
                                IntegrityMetaManager.annotateMemoryMeta(fullMeta, archiveBody, {
                                    domain: 'memory',
                                    recordSchema: 'libra.memory.entry.v1',
                                    recordId: String(fullMeta?.integrity?.recordId || fullMeta?.canonicalMemoryId || fullMeta?.turnKey || fullMeta?.sourceHash || fullMeta?.m_id || ''),
                                    scopeKey: String(shard?.scopeKey || options?.scopeKey || MemoryState?._activeScopeKey || '').trim(),
                                    turn: Number(fullMeta?.t || 0) || 0,
                                    source: String(fullMeta?.source || '')
                                });
                                fullEntry.content = `[META:${JSON.stringify(fullMeta)}]\n${archiveBody}\n`;
                            } catch (_) {}
                            entries.push({
                                ...fullEntry,
                                key: `cold-full:${shard.id}:${persistentRecordId}`,
                                _coldArchiveOriginalEntry: originalFullEntry,
                                _coldArchiveOriginalKey: String(fullEntry.key || ''),
                                _coldArchiveHydrated: true,
                                _coldArchiveFullRecord: true,
                                _coldArchiveShardId: shard.id,
                                _coldArchivePersistentShardId: persistentShardId,
                                _coldArchiveScore: Number(row.score || shard?._archiveMatch?.score || 0)
                            });
                            fullRecords += 1;
                            if (entries.length >= maxEntries) break;
                            continue;
                        }
                    }
                    const turn = normalizeLegacyMemoryTurnAnchor(item.turn || shard?.turnRange?.to || shard?.turnRange?.from || 0);
                    const sourceHash = item.sourceHash || `${shard.id}:${item.hash || item.id || entries.length}`;
                    const meta = {
                        t: turn,
                        ttl: -1,
                        imp: Math.max(4, Math.min(9, Number(item.importance || 0) || 5)),
                        ent: item.entities || shard.entities || [],
                        sourceHash,
                        sourceMessageIds: item.sourceMessageIds || shard.sourceIds || [],
                        coldArchive: true,
                        coldArchiveShardId: shard.id,
                        coldArchiveItemHash: item.hash || ''
                    };
                    const payload = {
                        schema: 'libra.memory.payload.v1',
                        source: 'cold_archive_hydration',
                        coldArchive: true,
                        archiveShardId: shard.id,
                        archiveReason: shard.reason || '',
                        turn,
                        importance: meta.imp,
                        summary: item.preview || shard.summary || '',
                        entities: item.entities || shard.entities || [],
                        topics: item.topics || shard.topics || [],
                        sourceHash,
                        archiveHits: row.hits || shard?._archiveMatch?.hits || []
                    };
                    entries.push({
                        key: `cold:${shard.id}:${item.hash || item.id || entries.length}`,
                        comment: 'lmai_memory',
                        content: `[META:${JSON.stringify(meta)}]\n${JSON.stringify(payload)}\n`,
                        mode: 'normal',
                        insertorder: 10,
                        alwaysActive: false,
                        _coldArchiveHydrated: true,
                        _coldArchiveShardId: shard.id,
                        _coldArchiveScore: Number(row.score || shard?._archiveMatch?.score || 0)
                    });
                    previewFallbacks += 1;
                    if (entries.length >= maxEntries) break;
                }
                if (entries.length >= maxEntries) break;
            }
            return {
                ok: true,
                entries,
                debug: {
                    sourceShards: asArray(shards).length,
                    hydratedEntries: entries.length,
                    fullRecords,
                    previewFallbacks,
                    maxEntries,
                    itemsPerShard: perShard
                }
            };
        };
        const listShards = (lorebook = null, options = {}) => {
            if (Array.isArray(lorebook)) loadState(lorebook);
            const limit = Math.max(1, Math.min(MAX_SHARDS, Number(options?.limit || MAX_SHARDS) || MAX_SHARDS));
            const newestFirst = options?.oldestFirst !== true;
            return asArray(archiveState.shards)
                .map(normalizeShard)
                .sort((a, b) => newestFirst
                    ? (Number(b?.createdAt || 0) || 0) - (Number(a?.createdAt || 0) || 0)
                    : (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0))
                .slice(0, limit)
                .map(shard => safeClone(shard));
        };
        const count = (lorebook = null) => {
            if (Array.isArray(lorebook)) loadState(lorebook);
            return asArray(archiveState.shards).length;
        };
        const resetState = (nextState = null) => {
            archiveState = normalizeState(nextState || defaultState());
            return archiveState;
        };
        return {
            COLD_ARCHIVE_COMMENT,
            COLD_ARCHIVE_SCHEMA,
            loadState,
            saveState,
            appendShard,
            archivePrunedMemoryEntries,
            commitPersistentMemoryEntries,
            readPersistentManifest,
            readPersistentShard,
            persistentKeys,
            buildMemoryShard,
            searchShards,
            hydrateShardsForRecall,
            listShards,
            count,
            getState: () => archiveState,
            resetState
        };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_ColdArchiveManager = ColdArchiveManager;
    } catch (_) { /* optional diagnostics only */ }

    const RecallFeedbackManager = (() => {
        const FEEDBACK_COMMENT = 'lmai_recall_feedback';
        const FEEDBACK_SCHEMA = 'libra.recall_feedback.v1';
        const MAX_RECORDS = 48;
        const MAX_ITEMS = 12;
        const VALID_STATUSES = new Set(['used', 'ignored', 'contradicted', 'uncertain']);
        const defaultState = () => ({
            schema: FEEDBACK_SCHEMA,
            version: 1,
            kind: 'recall_feedback',
            maxRecords: MAX_RECORDS,
            records: [],
            aggregate: {
                total: 0,
                used: 0,
                ignored: 0,
                contradicted: 0,
                uncertain: 0
            },
            lastUpdated: 0
        });
        let feedbackState = defaultState();

        const clip = (value = '', max = 220) => truncateForLLM(String(value == null ? '' : value).replace(/\s+/g, ' ').trim(), Math.max(32, Number(max || 220)), ' ... ');
        const asArray = (value) => Array.isArray(value) ? value : [];
        const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const hashText = (value = '') => {
            const text = String(value || '');
            try {
                if (typeof TokenizerEngine !== 'undefined' && TokenizerEngine?.simpleHash) return String(TokenizerEngine.simpleHash(text));
            } catch (_) {}
            let hash = 0;
            for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
            return String(hash);
        };
        const uniq = (items = [], limit = 24) => {
            const out = [];
            const seen = new Set();
            for (const item of asArray(items)) {
                const text = String(item == null ? '' : item).replace(/\s+/g, ' ').trim();
                if (!text || seen.has(text)) continue;
                seen.add(text);
                out.push(text);
                if (out.length >= limit) break;
            }
            return out;
        };
        const normalizeTerm = (value = '') => String(value || '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_가-힣ぁ-んァ-ヶ一-龯]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const WEAK_RECALL_FEEDBACK_TERMS = new Set([
            'the', 'and', 'for', 'with', 'from', 'this', 'that', 'then', 'there', 'here',
            'is', 'are', 'was', 'were', 'to', 'in', 'on', 'of', 'a', 'an', 'it', 'as',
            'memory', 'schema', 'version', 'true', 'false', 'null'
        ]);
        const extractTerms = (value = '', limit = 16) => {
            const raw = String(value || '');
            const tokens = [];
            try {
                if (typeof KoreanTextCore !== 'undefined' && KoreanTextCore?.tokenize) {
                    tokens.push(...KoreanTextCore.tokenize(raw, limit * 4));
                }
            } catch (_) {}
            tokens.push(...(raw.match(/[\p{L}\p{N}_.'-]{2,}/gu) || []));
            return uniq(tokens
                .map(normalizeTerm)
                .filter(term => term.length >= 2 && term.length <= 48)
                .filter(term => !WEAK_RECALL_FEEDBACK_TERMS.has(term)), limit);
        };
        const normalizeInjectedItem = (item = {}, index = 0) => {
            const source = asObject(item);
            const preview = clip(source.preview || source.text || source.summary || source.content || '', 120);
            const label = clip(source.label || source.name || source.title || source.id || '', 80);
            const terms = uniq([
                ...asArray(source.terms),
                ...asArray(source.entities),
                ...asArray(source.topics),
                ...extractTerms([label, preview].filter(Boolean).join(' '), 10)
            ], 12);
            const idBasis = source.id || source.key || [source.domain || 'item', label, preview, index].join('::');
            return {
                id: clip(source.id || source.key || hashText(idBasis), 96),
                domain: clip(source.domain || 'memory', 60),
                label,
                preview,
                terms,
                sourceHash: clip(source.sourceHash || hashText(`${label}\n${preview}`), 80),
                turn: normalizeLegacyMemoryTurnAnchor(source.turn || 0)
            };
        };
        const normalizeInjectionSnapshot = (snapshot = {}) => {
            const source = asObject(snapshot);
            const items = asArray(source.items)
                .map(normalizeInjectedItem)
                .filter(item => item.id || item.preview || item.terms.length)
                .slice(0, MAX_ITEMS);
            return {
                schema: `${FEEDBACK_SCHEMA}.injection`,
                scopeKey: clip(source.scopeKey || '', 96),
                chatId: clip(source.chatId || '', 64),
                requestType: clip(source.requestType || '', 80),
                requestSequence: Math.max(0, Number(source.requestSequence || 0) || 0),
                turn: normalizeLegacyMemoryTurnAnchor(source.turn || 0),
                turnKey: clip(source.turnKey || '', 96),
                createdAt: Number(source.createdAt || Date.now()) || Date.now(),
                items
            };
        };
        const responseTermSet = (responseText = '') => new Set(extractTerms(responseText, 256));
        const hasNegationNearTerm = (responseText = '', terms = []) => {
            const raw = String(responseText || '').toLowerCase();
            const negation = '(?:not|never|no longer|none|cannot|can\\s*not|아니|않|못하|없|거짓|부정|틀렸|다르)';
            const clauses = raw
                .split(/(?:[.!?;,\n\r]+|\bbut\b|\bhowever\b|하지만|그러나|다만)/i)
                .map(part => part.trim())
                .filter(Boolean);
            for (const term of asArray(terms).slice(0, 8)) {
                if (WEAK_RECALL_FEEDBACK_TERMS.has(normalizeTerm(term))) continue;
                const safe = String(term || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (!safe || safe.length < 3) continue;
                const termRe = new RegExp(safe, 'i');
                const negRe = new RegExp(negation, 'i');
                if (clauses.some(clause => clause.length <= 180 && termRe.test(clause) && negRe.test(clause))) return true;
            }
            return false;
        };
        const classifyItemUsage = (item = {}, responseTerms = new Set(), responseText = '') => {
            const terms = asArray(item.terms).map(normalizeTerm).filter(Boolean);
            const hits = terms.filter(term => responseTerms.has(term)).slice(0, 12);
            const labelHit = item.label && normalizeTerm(item.label) && responseTerms.has(normalizeTerm(item.label));
            const previewTerms = extractTerms(item.preview || '', 12);
            const previewHits = previewTerms.filter(term => responseTerms.has(term)).slice(0, 8);
            const overlap = uniq([...hits, ...previewHits], 12);
            if ((labelHit || overlap.length >= 1) && hasNegationNearTerm(responseText, [item.label, ...overlap].filter(Boolean))) {
                return { status: 'contradicted', overlap, score: overlap.length + (labelHit ? 2 : 0) };
            }
            if (labelHit || overlap.length >= 2) return { status: 'used', overlap, score: overlap.length + (labelHit ? 2 : 0) };
            if (overlap.length === 1) return { status: 'uncertain', overlap, score: 1 };
            return { status: 'ignored', overlap: [], score: 0 };
        };
        const normalizeFeedbackItem = (item = {}) => {
            const source = asObject(item);
            const status = VALID_STATUSES.has(String(source.status || '').trim()) ? String(source.status).trim() : 'uncertain';
            return {
                id: clip(source.id || '', 96),
                domain: clip(source.domain || 'memory', 60),
                label: clip(source.label || '', 120),
                status,
                score: Number(source.score || 0) || 0,
                overlap: uniq(source.overlap || [], 8),
                sourceHash: clip(source.sourceHash || '', 80),
                preview: clip(source.preview || '', 96)
            };
        };
        const buildFeedbackRecord = (snapshot = {}, responseText = '', context = {}) => {
            const injection = normalizeInjectionSnapshot(snapshot);
            const response = String(responseText || '');
            const terms = responseTermSet(response);
            const items = injection.items.map(item => {
                const usage = classifyItemUsage(item, terms, response);
                return normalizeFeedbackItem({ ...item, ...usage });
            });
            const counts = items.reduce((acc, item) => {
                acc[item.status] = Number(acc[item.status] || 0) + 1;
                return acc;
            }, { used: 0, ignored: 0, contradicted: 0, uncertain: 0 });
            const turn = normalizeLegacyMemoryTurnAnchor(context.turn || injection.turn || 0);
            const responseHash = clip(context.responseHash || hashText(response), 80);
            const idBasis = [
                injection.scopeKey,
                injection.chatId,
                injection.requestType,
                injection.requestSequence,
                turn,
                responseHash,
                items.map(item => `${item.id}:${item.status}`).join('|')
            ].join('::');
            return {
                schema: FEEDBACK_SCHEMA,
                id: `rf:${hashText(idBasis)}`,
                scopeKey: injection.scopeKey,
                chatId: injection.chatId,
                requestType: injection.requestType,
                requestSequence: injection.requestSequence,
                turn,
                turnKey: clip(context.turnKey || injection.turnKey || '', 96),
                responseHash,
                createdAt: Date.now(),
                injectedCount: injection.items.length,
                counts,
                items
            };
        };
        const normalizeRecord = (record = {}) => {
            const source = asObject(record);
            const items = asArray(source.items).map(normalizeFeedbackItem).filter(item => item.id || item.label).slice(0, MAX_ITEMS);
            const counts = items.reduce((acc, item) => {
                acc[item.status] = Number(acc[item.status] || 0) + 1;
                return acc;
            }, { used: 0, ignored: 0, contradicted: 0, uncertain: 0 });
            return {
                schema: FEEDBACK_SCHEMA,
                id: clip(source.id || hashText(JSON.stringify(items)), 96),
                scopeKey: clip(source.scopeKey || '', 96),
                chatId: clip(source.chatId || '', 64),
                requestType: clip(source.requestType || '', 80),
                requestSequence: Math.max(0, Number(source.requestSequence || 0) || 0),
                turn: normalizeLegacyMemoryTurnAnchor(source.turn || 0),
                turnKey: clip(source.turnKey || '', 96),
                responseHash: clip(source.responseHash || '', 80),
                createdAt: Number(source.createdAt || Date.now()) || Date.now(),
                injectedCount: Math.max(Number(source.injectedCount || items.length) || items.length, items.length),
                counts: {
                    used: Number(source.counts?.used ?? counts.used) || 0,
                    ignored: Number(source.counts?.ignored ?? counts.ignored) || 0,
                    contradicted: Number(source.counts?.contradicted ?? counts.contradicted) || 0,
                    uncertain: Number(source.counts?.uncertain ?? counts.uncertain) || 0
                },
                items
            };
        };
        const rebuildAggregate = (records = []) => asArray(records).reduce((acc, record) => {
            acc.total += Number(record.injectedCount || record.items?.length || 0) || 0;
            for (const status of VALID_STATUSES) acc[status] += Number(record.counts?.[status] || 0) || 0;
            return acc;
        }, { total: 0, used: 0, ignored: 0, contradicted: 0, uncertain: 0 });
        const normalizeState = (state = null) => {
            const source = asObject(state);
            const records = asArray(source.records)
                .map(normalizeRecord)
                .filter(record => record.id && record.items.length)
                .slice(-MAX_RECORDS);
            return {
                ...defaultState(),
                schema: FEEDBACK_SCHEMA,
                version: 1,
                kind: 'recall_feedback',
                maxRecords: MAX_RECORDS,
                records,
                aggregate: rebuildAggregate(records),
                lastUpdated: Number(source.lastUpdated || 0) || 0
            };
        };
        const loadState = (lorebook = []) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .find(item => item?.comment === FEEDBACK_COMMENT);
            if (!entry) {
                feedbackState = defaultState();
                return feedbackState;
            }
            try {
                feedbackState = normalizeState(JSON.parse(entry.content || '{}'));
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] Recall feedback parse failed:', e?.message || e);
                feedbackState = defaultState();
            }
            return feedbackState;
        };
        const saveState = (lorebook = []) => {
            if (!Array.isArray(lorebook)) return false;
            feedbackState = normalizeState(feedbackState);
            const entry = {
                key: 'lmai_recall_feedback::state',
                comment: FEEDBACK_COMMENT,
                content: JSON.stringify(feedbackState),
                mode: 'normal',
                insertorder: 8,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(item => item?.comment === FEEDBACK_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
            return true;
        };
        const appendFeedback = (lorebook = [], snapshot = {}, responseText = '', context = {}) => {
            if (!Array.isArray(lorebook)) return { changed: false, reason: 'missing_lorebook' };
            const record = normalizeRecord(buildFeedbackRecord(snapshot, responseText, context));
            if (!record.items.length) return { changed: false, reason: 'empty_items' };
            loadState(lorebook);
            const before = feedbackState.records.length;
            feedbackState.records = asArray(feedbackState.records).filter(item => item.id !== record.id);
            feedbackState.records.push(record);
            feedbackState.records = feedbackState.records
                .sort((a, b) => (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0))
                .slice(-MAX_RECORDS);
            feedbackState.aggregate = rebuildAggregate(feedbackState.records);
            feedbackState.lastUpdated = Date.now();
            saveState(lorebook);
            if (context?.debug === true || context?.config?.debug === true) {
                recordRuntimeDebug('log', '[LIBRA] Recall feedback recorded:', {
                    turn: record.turn,
                    injected: record.injectedCount,
                    counts: record.counts,
                    responseHash: record.responseHash
                });
            }
            return { changed: feedbackState.records.length !== before || feedbackState.records[feedbackState.records.length - 1]?.id === record.id, record };
        };
        const rememberInjection = (snapshot = {}) => {
            const normalized = normalizeInjectionSnapshot(snapshot);
            if (!normalized.scopeKey || normalized.items.length === 0) return { changed: false, reason: 'empty_snapshot' };
            try {
                if (!MemoryState.recentRecallInjectionByScope) MemoryState.recentRecallInjectionByScope = new Map();
                MemoryState.recentRecallInjectionByScope.set(normalized.scopeKey, normalized);
            } catch (_) {}
            return { changed: true, snapshot: normalized };
        };
        const consumeInjection = (scopeKey = '', options = {}) => {
            const key = String(scopeKey || '').trim();
            if (!key) return null;
            let snapshot = null;
            try {
                snapshot = MemoryState.recentRecallInjectionByScope?.get?.(key) || null;
                if (snapshot && options.keep !== true) MemoryState.recentRecallInjectionByScope.delete(key);
            } catch (_) { snapshot = null; }
            return snapshot ? normalizeInjectionSnapshot(snapshot) : null;
        };
        const list = (lorebook = null, options = {}) => {
            if (Array.isArray(lorebook)) loadState(lorebook);
            const limit = Math.max(1, Math.min(MAX_RECORDS, Number(options?.limit || MAX_RECORDS) || MAX_RECORDS));
            const newestFirst = options?.oldestFirst !== true;
            return asArray(feedbackState.records)
                .map(normalizeRecord)
                .sort((a, b) => newestFirst
                    ? (Number(b?.createdAt || 0) || 0) - (Number(a?.createdAt || 0) || 0)
                    : (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0))
                .slice(0, limit)
                .map(record => safeClone(record));
        };
        const resetState = (nextState = null) => {
            feedbackState = normalizeState(nextState || defaultState());
            return feedbackState;
        };
        return {
            FEEDBACK_COMMENT,
            FEEDBACK_SCHEMA,
            normalizeInjectedItem,
            normalizeInjectionSnapshot,
            rememberInjection,
            consumeInjection,
            buildFeedbackRecord,
            appendFeedback,
            loadState,
            saveState,
            list,
            getState: () => feedbackState,
            resetState
        };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_RecallFeedbackManager = RecallFeedbackManager;
    } catch (_) { /* optional diagnostics only */ }

    const IntegratedAnalysisJournal = (() => {
        const JOURNAL_COMMENT = 'lmai_integrated_packet_journal';
        const MAX_ENTRIES = 48;
        const defaultState = () => ({
            version: 1,
            entries: [],
            lastTurn: 0,
            lastUpdated: 0
        });
        let journalState = defaultState();

        const clip = (value = '', max = 220) => truncateForLLM(String(value || '').replace(/\s+/g, ' ').trim(), Math.max(40, Number(max || 220)), ' ... ');
        const asArray = (value) => Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
        const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const textOf = (value, max = 220) => {
            if (value == null) return '';
            if (typeof value === 'object') {
                const source = value.summary || value.text || value.label || value.name || value.value || value.state || value.reason || '';
                if (source) return textOf(source, max);
                try { return clip(JSON.stringify(value), max); } catch { return ''; }
            }
            return clip(value, max);
        };
        const textList = (value, limit = 6, max = 180) => dedupeTextArray(asArray(value)
            .map(item => textOf(item, max))
            .filter(Boolean)
        ).slice(0, Math.max(1, Number(limit || 6)));
        const compactCharacters = (value = []) => asArray(value)
            .map(item => {
                const obj = asObject(item);
                const visual = asObject(obj.visualCanon || obj.visual_canon || {});
                const appearance = asObject(visual.appearanceText || visual.appearance_text || visual.appearance || {});
                return {
                    name: textOf(obj.name || obj.canonicalName || obj.displayName || item, 100),
                    role: textOf(obj.role || obj.identity || obj.summary || '', 160),
                    state: textOf(obj.current_state || obj.currentState || obj.state || '', 180),
                    visualProfile: textList(Object.values(appearance), 8, 120)
                };
            })
            .filter(item => item.name || item.role || item.state || item.visualProfile.length)
            .slice(0, 12);
        const compactRelations = (value = []) => asArray(value)
            .map(item => {
                const obj = asObject(item);
                const pair = textList(obj.pair || obj.entities || obj.participants || [], 2, 100);
                return {
                    pair,
                    type: textOf(obj.type || obj.relationType || obj.axis || '', 80),
                    text: textOf(obj.text || obj.summary || obj.state || obj.current_state || item, 180)
                };
            })
            .filter(item => item.pair.length || item.type || item.text)
            .slice(0, 10);
        const compactPacket = (packet = null) => {
            const source = asObject(packet);
            const meta = asObject(source.meta);
            const memory = asObject(source.memory);
            const entity = asObject(source.entity);
            const world = asObject(source.world);
            const worldState = asObject(world.state);
            const narrative = asObject(source.narrative);
            const guards = { ...asObject(source.guards), ...asObject(source.guidance) };
            return {
                summary: textOf(asObject(meta.summary_memory || meta.summaryMemory).summary || memory.summary || narrative.summary || '', 260),
                memory: {
                    events: textList(memory.events, 8, 220),
                    facts: textList(memory.facts || memory.stableFacts || memory.stable_facts, 8, 220)
                },
                entity: {
                    characters: compactCharacters(entity.characters || entity.entities || entity.people),
                    relations: compactRelations(entity.relations || entity.relationships),
                    currentState: textList(entity.current_state || entity.currentState || [], 10, 180),
                    secretCount: asArray(entity.secrets || entity.privateFacts || entity.private_facts).length
                },
                world: {
                    time: textOf(worldState.time || world.time || '', 120),
                    location: textOf(worldState.location || world.location || '', 160),
                    scene: textOf(worldState.scene || world.scene || '', 220),
                    rules: textList(world.rules || world.active_rules || world.activeRules, 8, 180),
                    places: textList(world.places || world.locations, 8, 140),
                    organizations: textList(world.organizations || world.factions, 8, 140),
                    activeEvents: textList(worldState.active_events || worldState.activeEvents || world.active_events || world.activeEvents, 8, 180),
                    offscreenThreads: textList(worldState.offscreen_threads || worldState.offscreenThreads || world.offscreen_threads || world.offscreenThreads, 8, 180)
                },
                narrative: {
                    phase: textOf(narrative.scene_phase || narrative.scenePhase || narrative.phase || '', 120),
                    conflictTraces: textList(narrative.conflict_traces || narrative.conflictTraces, 8, 180),
                    sceneDeltas: textList(narrative.scene_deltas || narrative.sceneDeltas, 8, 180),
                    unresolvedThreads: textList(narrative.unresolved_threads || narrative.unresolvedThreads, 8, 180)
                },
                guards: {
                    continuityLocks: textList(guards.continuity_locks || guards.continuityLocks, 8, 180),
                    auditCautions: textList(guards.audit_cautions || guards.auditCautions || meta.audit_cautions || meta.auditCautions, 8, 180),
                    overpromotionRisks: textList(guards.overpromotion_risks || guards.overpromotionRisks || meta.overpromotion_risks || meta.overpromotionRisks, 8, 180)
                }
            };
        };
        const normalizeState = (state = null) => {
            const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
            return {
                ...defaultState(),
                version: 1,
                entries: (Array.isArray(source.entries) ? source.entries : [])
                    .map(entry => ({
                        turn: Number(entry?.turn || 0) || 0,
                        turnKey: clip(entry?.turnKey || '', 160),
                        packetHash: clip(entry?.packetHash || '', 80),
                        profile: clip(entry?.profile || '', 80),
                        label: clip(entry?.label || '', 120),
                        sourceMode: clip(entry?.sourceMode || '', 80),
                        parallel: entry?.parallel === true,
                        createdAt: Number(entry?.createdAt || Date.now()) || Date.now(),
                        packet: compactPacket(entry?.packet)
                    }))
                    .filter(entry => entry.turn > 0 || entry.packetHash)
                    .slice(-MAX_ENTRIES),
                lastTurn: Number(source.lastTurn || 0) || 0,
                lastUpdated: Number(source.lastUpdated || 0) || 0
            };
        };
        const loadState = (lorebook = []) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .find(item => item?.comment === JOURNAL_COMMENT);
            if (!entry) {
                journalState = defaultState();
                return journalState;
            }
            try {
                journalState = normalizeState(JSON.parse(entry.content || '{}'));
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] Integrated analysis journal parse failed:', e?.message || e);
                journalState = defaultState();
            }
            return journalState;
        };
        const saveState = async (lorebook = []) => {
            if (!Array.isArray(lorebook)) return;
            journalState = normalizeState(journalState);
            const entry = {
                key: 'lmai_integrated_packet_journal::state',
                comment: JOURNAL_COMMENT,
                content: JSON.stringify(journalState),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(item => item?.comment === JOURNAL_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };
        const recordPacket = (lorebook = [], packet = null, context = {}) => {
            if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return { changed: false, reason: 'missing-packet' };
            loadState(lorebook);
            let packetHash = '';
            try { packetHash = String(TokenizerEngine.simpleHash(JSON.stringify(packet))); } catch (_) {}
            const turn = normalizeLegacyMemoryTurnAnchor(context.turn || 0);
            const turnKey = clip(context.turnKey || '', 160);
            const next = {
                turn,
                turnKey,
                packetHash,
                profile: clip(context.profile || '', 80),
                label: clip(context.label || '', 120),
                sourceMode: clip(context.sourceMode || '', 80),
                parallel: context.parallel === true,
                createdAt: Date.now(),
                packet: compactPacket(packet)
            };
            const key = `${turn || 0}::${turnKey || packetHash}`;
            journalState.entries = (journalState.entries || []).filter(entry => `${Number(entry?.turn || 0) || 0}::${entry?.turnKey || entry?.packetHash || ''}` !== key);
            journalState.entries.push(next);
            journalState.entries = journalState.entries
                .sort((a, b) => (Number(a?.turn || 0) || 0) - (Number(b?.turn || 0) || 0) || (Number(a?.createdAt || 0) || 0) - (Number(b?.createdAt || 0) || 0))
                .slice(-MAX_ENTRIES);
            journalState.lastTurn = Math.max(Number(journalState.lastTurn || 0) || 0, turn);
            journalState.lastUpdated = Date.now();
            return { changed: true, entry: next };
        };
        const getState = () => journalState;
        const resetState = (nextState = null) => {
            journalState = normalizeState(nextState || defaultState());
            return journalState;
        };
        return { loadState, saveState, recordPacket, getState, resetState };
    })();

    const IntegrityScanner = (() => {
        const SCAN_COMMENT = 'lmai_integrity_scan';
        const SCAN_SCHEMA = 'libra.integrity_scan.v1';
        const MAX_FINDINGS = 180;
        const DEFAULT_BATCH_LIMIT = 40;
        const DEFAULT_MAX_MS = 24;
        const JSON_COMMENTS = new Set([
            'lmai_entity',
            'lmai_relation',
            'lmai_narrative',
            'lmai_char_states',
            'lmai_world_states',
            'lmai_analysis_quarantine',
            'lmai_cold_archive',
            'lmai_recall_feedback',
            'lmai_integrated_packet_journal',
            'lmai_world_additional',
            'lmai_user_dlc',
            'lmai_hme_index',
            'lmai_hme_graph_index'
        ]);
        const EXPECTED_SCHEMAS = {
            lmai_analysis_quarantine: 'libra.analysis_quarantine.v1',
            lmai_cold_archive: 'libra.cold_archive.v1',
            lmai_recall_feedback: 'libra.recall_feedback.v1',
            lmai_world_additional: 'libra.world_additional.v1',
            lmai_user_dlc: 'libra.user_dlc.v1'
        };
        const defaultState = () => ({
            schema: SCAN_SCHEMA,
            version: 1,
            kind: 'integrity_scan',
            cursor: { index: 0, pass: 0 },
            findings: [],
            summary: { total: 0, byType: {}, bySeverity: {}, lastBatch: null },
            lastScanAt: 0,
            lastCompletedAt: 0,
            lastUpdated: 0
        });
        let scanState = defaultState();

        const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const clip = (value = '', max = 220) => truncateForLLM(String(value == null ? '' : value).replace(/\s+/g, ' ').trim(), Math.max(20, Number(max || 220)), ' ... ');
        const hashText = (value = '') => {
            try { return String(TokenizerEngine.simpleHash(String(value || ''))); }
            catch (_) { return String(stableHash?.(String(value || '')) || '0'); }
        };
        const nowMs = () => (typeof performance !== 'undefined' && performance?.now) ? performance.now() : Date.now();
        const normalizeComment = (entry = {}) => String(entry?.comment || '').trim();
        const normalizeKey = (entry = {}, index = 0) => String(entry?.key || '').trim() || `${normalizeComment(entry)}#${index}`;
        const findingId = (type = '', entry = {}, index = 0, extra = '') => hashText([
            type,
            normalizeComment(entry),
            normalizeKey(entry, index),
            extra
        ].join('::'));
        const normalizeFinding = (finding = {}) => ({
            schema: `${SCAN_SCHEMA}.finding`,
            id: clip(finding.id || '', 80),
            type: clip(finding.type || 'unknown', 80),
            severity: ['info', 'warn', 'error', 'critical'].includes(String(finding.severity || '').trim()) ? String(finding.severity).trim() : 'warn',
            status: ['open', 'reviewed', 'ignored', 'resolved', 'accepted'].includes(String(finding.status || '').trim()) ? String(finding.status).trim() : 'open',
            domain: clip(finding.domain || '', 80),
            reason: clip(finding.reason || '', 180),
            entryIndex: Number(finding.entryIndex || 0) || 0,
            comment: clip(finding.comment || '', 80),
            key: clip(finding.key || '', 180),
            recordId: clip(finding.recordId || '', 180),
            scopeKey: clip(finding.scopeKey || '', 180),
            detail: asObject(finding.detail),
            preview: clip(finding.preview || '', 260),
            firstSeenAt: Number(finding.firstSeenAt || Date.now()) || Date.now(),
            lastSeenAt: Number(finding.lastSeenAt || Date.now()) || Date.now(),
            reviewedAt: Number(finding.reviewedAt || 0) || 0,
            reviewNote: clip(finding.reviewNote || '', 240)
        });
        const normalizeState = (state = null) => {
            const source = asObject(state);
            const cursor = asObject(source.cursor);
            const findings = Array.isArray(source.findings) ? source.findings : [];
            return {
                ...defaultState(),
                schema: SCAN_SCHEMA,
                version: 1,
                kind: 'integrity_scan',
                cursor: {
                    index: Math.max(0, Number(cursor.index || 0) || 0),
                    pass: Math.max(0, Number(cursor.pass || 0) || 0)
                },
                findings: findings
                    .map(normalizeFinding)
                    .filter(item => item.id && item.type)
                    .slice(-MAX_FINDINGS),
                summary: asObject(source.summary),
                lastScanAt: Number(source.lastScanAt || 0) || 0,
                lastCompletedAt: Number(source.lastCompletedAt || 0) || 0,
                lastUpdated: Number(source.lastUpdated || 0) || 0
            };
        };
        const rebuildSummary = (state = scanState, batch = null) => {
            const byType = {};
            const bySeverity = {};
            for (const finding of Array.isArray(state.findings) ? state.findings : []) {
                byType[finding.type] = Number(byType[finding.type] || 0) + 1;
                bySeverity[finding.severity] = Number(bySeverity[finding.severity] || 0) + 1;
            }
            state.summary = {
                total: Array.isArray(state.findings) ? state.findings.length : 0,
                byType,
                bySeverity,
                lastBatch: batch || state.summary?.lastBatch || null
            };
            return state.summary;
        };
        const loadState = (lorebook = [], options = {}) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .find(item => item?.comment === SCAN_COMMENT);
            if (!entry) {
                scanState = defaultState();
                return scanState;
            }
            try {
                const parsed = JSON.parse(entry.content || '{}');
                if (options.strictRead === true && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
                    || !Array.isArray(parsed.findings) || parsed.findings.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !row.id || !row.type)
                    || (parsed.schema !== undefined && parsed.schema !== SCAN_SCHEMA))) {
                    throw new Error('integrityscanner_state_invalid');
                }
                scanState = normalizeState(parsed);
            } catch (error) {
                if (options.strictRead === true) throw new Error('integrityscanner_state_unreadable');
                recordRuntimeDebug('warn', '[LIBRA] Integrity scan state parse failed:', error?.message || error);
                scanState = defaultState();
            }
            rebuildSummary(scanState);
            return scanState;
        };
        const saveState = (lorebook = []) => {
            if (!Array.isArray(lorebook)) return;
            scanState = normalizeState(scanState);
            rebuildSummary(scanState);
            const entry = {
                key: 'lmai_integrity_scan::state',
                comment: SCAN_COMMENT,
                content: JSON.stringify(scanState),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(item => item?.comment === SCAN_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };
        const upsertFinding = (finding = {}) => {
            const next = normalizeFinding(finding);
            if (!next.id) return false;
            const existingIdx = scanState.findings.findIndex(item => item.id === next.id);
            if (existingIdx >= 0) {
                scanState.findings[existingIdx] = {
                    ...scanState.findings[existingIdx],
                    ...next,
                    firstSeenAt: scanState.findings[existingIdx].firstSeenAt || next.firstSeenAt,
                    lastSeenAt: Date.now()
                };
            } else {
                scanState.findings.push(next);
            }
            scanState.findings = scanState.findings
                .sort((a, b) => (Number(a?.firstSeenAt || 0) || 0) - (Number(b?.firstSeenAt || 0) || 0))
                .slice(-MAX_FINDINGS);
            return true;
        };
        const parseJsonEntry = (entry = {}, index = 0) => {
            try {
                return { ok: true, value: JSON.parse(String(entry?.content || '{}')) };
            } catch (error) {
                return {
                    ok: false,
                    error,
                    finding: {
                        id: findingId('invalid_json', entry, index),
                        type: 'invalid_json',
                        severity: 'error',
                        domain: normalizeComment(entry).replace(/^lmai_/, '') || 'managed',
                        reason: error?.message || 'invalid_json',
                        entryIndex: index,
                        comment: normalizeComment(entry),
                        key: normalizeKey(entry, index),
                        preview: String(entry?.content || '').slice(0, 260)
                    }
                };
            }
        };
        const parseMemoryMeta = (entry = {}, index = 0) => {
            const raw = String(entry?.content || '');
            const marker = raw.indexOf('[META:');
            if (marker < 0 || marker > 64) return { ok: true, meta: {}, body: raw };
            const jsonStart = raw.indexOf('{', marker);
            if (jsonStart < 0 || jsonStart > 2048) {
                return { ok: false, finding: { id: findingId('invalid_json', entry, index, 'meta'), type: 'invalid_json', severity: 'error', domain: 'memory', reason: 'memory_meta_missing_json_start', entryIndex: index, comment: normalizeComment(entry), key: normalizeKey(entry, index), preview: raw.slice(0, 260) } };
            }
            let depth = 0;
            let inString = false;
            let escaped = false;
            let jsonEnd = -1;
            const maxScan = Math.min(raw.length, jsonStart + 4096);
            for (let i = jsonStart; i < maxScan; i += 1) {
                const ch = raw[i];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (ch === '\\') escaped = true;
                    else if (ch === '"') inString = false;
                    continue;
                }
                if (ch === '"') inString = true;
                else if (ch === '{') depth += 1;
                else if (ch === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        jsonEnd = i;
                        break;
                    }
                }
            }
            if (jsonEnd < jsonStart) {
                return { ok: false, finding: { id: findingId('invalid_json', entry, index, 'meta_truncated'), type: 'invalid_json', severity: 'error', domain: 'memory', reason: 'memory_meta_truncated', entryIndex: index, comment: normalizeComment(entry), key: normalizeKey(entry, index), preview: raw.slice(0, 260) } };
            }
            try {
                const meta = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
                const closeBracket = raw.indexOf(']', jsonEnd);
                const body = closeBracket >= 0 && closeBracket <= jsonEnd + 8 ? raw.slice(closeBracket + 1).replace(/^\s+/, '') : raw.slice(jsonEnd + 1);
                return { ok: true, meta: asObject(meta), body };
            } catch (error) {
                return { ok: false, finding: { id: findingId('invalid_json', entry, index, 'meta_parse'), type: 'invalid_json', severity: 'error', domain: 'memory', reason: error?.message || 'memory_meta_invalid_json', entryIndex: index, comment: normalizeComment(entry), key: normalizeKey(entry, index), preview: raw.slice(0, 260) } };
            }
        };
        const collectEntityNames = (entries = []) => {
            const names = new Map();
            entries.forEach((entry, index) => {
                if (normalizeComment(entry) !== 'lmai_entity') return;
                const parsed = parseJsonEntry(entry, index);
                if (!parsed.ok) return;
                const name = EntityManager.normalizeName?.(parsed.value?.name || '', entries) || String(parsed.value?.name || '').trim();
                if (!name) return;
                if (!names.has(name)) names.set(name, []);
                names.get(name).push({ entry, index, value: parsed.value });
            });
            return names;
        };
        const validateEmbeddingFingerprint = (entry = {}, parsed = null, meta = null, index = 0, context = {}) => {
            const current = MemoryEngine?.EmbeddingEngine?.getFingerprintMeta?.() || null;
            if (!current) return;
            const candidates = [
                meta?.embeddingFingerprint,
                meta?.embedding?.fingerprint,
                parsed?.embeddingFingerprint,
                parsed?.embedding?.fingerprint,
                parsed?.fingerprint?.schema === 'libra.embedding.fingerprint.v1' ? parsed.fingerprint : null
            ].filter(item => item && typeof item === 'object');
            for (const fp of candidates) {
                if (fp.schema && fp.schema !== 'libra.embedding.fingerprint.v1') continue;
                const mismatch = [];
                if (fp.provider && current.provider && String(fp.provider).toLowerCase() !== String(current.provider).toLowerCase()) mismatch.push('provider');
                if (fp.model && current.model && String(fp.model) !== String(current.model)) mismatch.push('model');
                if (fp.endpointHash != null && current.endpointHash != null && String(fp.endpointHash || '') !== String(current.endpointHash || '')) mismatch.push('endpoint');
                if (Number(fp.dim || 0) && Number(current.dim || 0) && Number(fp.dim || 0) !== Number(current.dim || 0)) mismatch.push('dim');
                if (fp.key && current.key && String(fp.key) !== String(current.key)) mismatch.push('key');
                if (mismatch.length > 0) {
                    upsertFinding({
                        id: findingId('embedding_fingerprint_mismatch', entry, index, mismatch.join(',')),
                        type: 'embedding_fingerprint_mismatch',
                        severity: 'warn',
                        domain: 'embedding',
                        reason: mismatch.join(','),
                        entryIndex: index,
                        comment: normalizeComment(entry),
                        key: normalizeKey(entry, index),
                        scopeKey: context.scopeKey || '',
                        detail: { expected: current, actual: fp, mismatch },
                        preview: String(entry?.content || '').slice(0, 220)
                    });
                }
            }
        };
        const validateIntegrity = (entry = {}, parsed = null, memoryMeta = null, memoryBody = '', index = 0, context = {}) => {
            const comment = normalizeComment(entry);
            let result = null;
            let domain = comment.replace(/^lmai_/, '') || 'managed';
            if (comment === 'lmai_entity') {
                domain = 'entity';
                result = IntegrityMetaManager.validateIntegrityMeta(parsed, { domain, recordId: parsed?.name || '', scopeKey: context.scopeKey || '' });
            } else if (comment === 'lmai_relation') {
                domain = 'relation';
                result = IntegrityMetaManager.validateIntegrityMeta(parsed, { domain, recordId: parsed?.id || [parsed?.entityA, parsed?.entityB].filter(Boolean).join('::'), scopeKey: context.scopeKey || '' });
            } else if (comment === 'lmai_narrative') {
                domain = 'narrative';
                result = IntegrityMetaManager.validateIntegrityMeta(parsed, { domain, recordId: 'narrative_state', scopeKey: context.scopeKey || '' });
            } else if (comment === 'lmai_world_states') {
                domain = 'world';
                result = IntegrityMetaManager.validateIntegrityMeta(parsed, { domain, recordId: 'world_state', scopeKey: context.scopeKey || '' });
            } else if (comment === 'lmai_memory' && memoryMeta?.integrity?.schema) {
                domain = 'memory';
                result = IntegrityMetaManager.validateMemoryMeta(memoryMeta, memoryBody, { domain, recordId: normalizeKey(entry, index), scopeKey: context.scopeKey || '' });
            }
            if (result && !result.ok) {
                upsertFinding({
                    id: findingId(result.reason || 'integrity_mismatch', entry, index, result.actual || result.actualScope || ''),
                    type: result.reason || 'integrity_mismatch',
                    severity: result.reason === 'checksum_mismatch' ? 'error' : 'warn',
                    domain,
                    reason: result.reason || 'integrity_mismatch',
                    entryIndex: index,
                    comment,
                    key: normalizeKey(entry, index),
                    recordId: result?.integrity?.recordId || '',
                    scopeKey: context.scopeKey || '',
                    detail: result,
                    preview: String(entry?.content || '').slice(0, 220)
                });
            }
        };
        const scanEntry = (entries = [], entry = {}, index = 0, context = {}) => {
            const comment = normalizeComment(entry);
            const key = normalizeKey(entry, index);
            const oversizedChars = Math.max(64, Number(context.oversizedChars || 240000) || 240000);
            const content = String(entry?.content || '');
            if (content.length > oversizedChars) {
                upsertFinding({
                    id: findingId('oversized_record', entry, index, String(content.length)),
                    type: 'oversized_record',
                    severity: 'warn',
                    domain: comment.replace(/^lmai_/, '') || 'managed',
                    reason: `content_chars:${content.length}`,
                    entryIndex: index,
                    comment,
                    key,
                    scopeKey: context.scopeKey || '',
                    detail: { chars: content.length, threshold: oversizedChars },
                    preview: content.slice(0, 220)
                });
            }
            if (comment === 'lmai_memory') {
                const parsedMeta = parseMemoryMeta(entry, index);
                if (!parsedMeta.ok) {
                    upsertFinding(parsedMeta.finding);
                    return;
                }
                validateIntegrity(entry, null, parsedMeta.meta, parsedMeta.body, index, context);
                validateEmbeddingFingerprint(entry, null, parsedMeta.meta, index, context);
                return;
            }
            let parsed = null;
            if (JSON_COMMENTS.has(comment)) {
                const parse = parseJsonEntry(entry, index);
                if (!parse.ok) {
                    upsertFinding(parse.finding);
                    return;
                }
                parsed = parse.value;
                const expectedSchema = EXPECTED_SCHEMAS[comment];
                if (expectedSchema && String(parsed?.schema || '') !== expectedSchema) {
                    upsertFinding({
                        id: findingId('schema_mismatch', entry, index, expectedSchema),
                        type: 'schema_mismatch',
                        severity: 'warn',
                        domain: comment.replace(/^lmai_/, '') || 'managed',
                        reason: `expected:${expectedSchema}`,
                        entryIndex: index,
                        comment,
                        key,
                        scopeKey: context.scopeKey || '',
                        detail: { expected: expectedSchema, actual: String(parsed?.schema || '') },
                        preview: content.slice(0, 220)
                    });
                }
                validateIntegrity(entry, parsed, null, '', index, context);
                validateEmbeddingFingerprint(entry, parsed, null, index, context);
            }
            if (comment === 'lmai_relation' && parsed) {
                const entityA = EntityManager.normalizeName?.(parsed.entityA || '', entries) || String(parsed.entityA || '').trim();
                const entityB = EntityManager.normalizeName?.(parsed.entityB || '', entries) || String(parsed.entityB || '').trim();
                const names = context.entityNames || new Map();
                const missing = [entityA, entityB].filter(name => name && !names.has(name));
                if (!entityA || !entityB || missing.length > 0) {
                    upsertFinding({
                        id: findingId('orphan_relation', entry, index, `${entityA}:${entityB}`),
                        type: 'orphan_relation',
                        severity: 'error',
                        domain: 'relation',
                        reason: missing.length ? `missing:${missing.join(',')}` : 'missing_relation_endpoint',
                        entryIndex: index,
                        comment,
                        key,
                        recordId: parsed.id || '',
                        scopeKey: context.scopeKey || '',
                        detail: { entityA, entityB, missing },
                        preview: content.slice(0, 220)
                    });
                }
            }
        };
        const scanDuplicateEntities = (entityNames = new Map(), context = {}) => {
            for (const [name, records] of entityNames.entries()) {
                if (!name || !Array.isArray(records) || records.length < 2) continue;
                const first = records[0]?.entry || {};
                upsertFinding({
                    id: findingId('duplicate_entity', first, records[0]?.index || 0, name),
                    type: 'duplicate_entity',
                    severity: 'warn',
                    domain: 'entity',
                    reason: `duplicate_count:${records.length}`,
                    entryIndex: Number(records[0]?.index || 0) || 0,
                    comment: 'lmai_entity',
                    key: normalizeKey(first, records[0]?.index || 0),
                    recordId: name,
                    scopeKey: context.scopeKey || '',
                    detail: {
                        name,
                        count: records.length,
                        indexes: records.map(item => item.index).slice(0, 12),
                        keys: records.map(item => normalizeKey(item.entry, item.index)).slice(0, 12)
                    },
                    preview: `Duplicate entity "${name}" appears ${records.length} times.`
                });
            }
        };
        const scanBacklog = (lorebook = [], context = {}) => {
            const limit = Math.max(1, Number(context.quarantineBacklogLimit || 60) || 60);
            const count = QuarantineManager?.count?.(lorebook) || 0;
            if (count > limit) {
                upsertFinding({
                    id: hashText(`quarantine_backlog::${limit}`),
                    type: 'quarantine_backlog',
                    severity: 'warn',
                    domain: 'quarantine',
                    reason: `count:${count}`,
                    entryIndex: 0,
                    comment: 'lmai_analysis_quarantine',
                    key: 'lmai_analysis_quarantine::state',
                    scopeKey: context.scopeKey || '',
                    detail: { count, limit },
                    preview: `Quarantine backlog ${count}/${limit}`
                });
            }
        };
        const scanBatch = (lorebook = [], options = {}) => {
            if (!Array.isArray(lorebook)) return { ok: false, reason: 'missing_lorebook' };
            loadState(lorebook);
            const startedAt = nowMs();
            const entries = LibraLoreConsolidator.unpack(lorebook).filter(entry => normalizeComment(entry) !== SCAN_COMMENT);
            const total = entries.length;
            const batchLimit = Math.max(1, Math.min(500, Number(options.batchLimit || DEFAULT_BATCH_LIMIT) || DEFAULT_BATCH_LIMIT));
            const maxMs = Math.max(1, Number(options.maxMs || DEFAULT_MAX_MS) || DEFAULT_MAX_MS);
            const scopeKey = String(options.scopeKey || MemoryState?._activeScopeKey || options.chatId || '').trim();
            const context = {
                scopeKey,
                oversizedChars: options.oversizedChars,
                quarantineBacklogLimit: options.quarantineBacklogLimit,
                entityNames: collectEntityNames(entries)
            };
            let index = Math.min(Math.max(0, Number(scanState.cursor?.index || 0) || 0), Math.max(0, total));
            let scanned = 0;
            let stoppedReason = '';
            if (index === 0) scanDuplicateEntities(context.entityNames, context);
            while (index < total && scanned < batchLimit) {
                scanEntry(entries, entries[index], index, context);
                index += 1;
                scanned += 1;
                if ((nowMs() - startedAt) >= maxMs) {
                    stoppedReason = 'time_budget';
                    break;
                }
            }
            if (!stoppedReason && scanned >= batchLimit && index < total) stoppedReason = 'batch_limit';
            let done = index >= total;
            if (done) {
                scanBacklog(lorebook, context);
                scanState.cursor = {
                    index: 0,
                    pass: Math.max(0, Number(scanState.cursor?.pass || 0) || 0) + 1
                };
                scanState.lastCompletedAt = Date.now();
                stoppedReason = 'completed';
            } else {
                scanState.cursor = {
                    index,
                    pass: Math.max(0, Number(scanState.cursor?.pass || 0) || 0)
                };
            }
            const batch = {
                scanned,
                total,
                nextIndex: scanState.cursor.index,
                done,
                stoppedReason,
                durationMs: Math.max(0, Math.round(nowMs() - startedAt))
            };
            scanState.lastScanAt = Date.now();
            scanState.lastUpdated = Date.now();
            rebuildSummary(scanState, batch);
            saveState(lorebook);
            return { ok: true, ...batch, summary: safeClone(scanState.summary), findings: safeClone(scanState.findings) };
        };
        const listFindings = (lorebook = null, options = {}) => {
            if (Array.isArray(lorebook)) loadState(lorebook, options);
            const type = String(options.type || '').trim();
            const severity = String(options.severity || '').trim();
            const status = String(options.status || '').trim();
            const limit = Math.max(1, Math.min(500, Number(options.limit || MAX_FINDINGS) || MAX_FINDINGS));
            return (Array.isArray(scanState.findings) ? scanState.findings : [])
                .filter(item => !type || item.type === type)
                .filter(item => !severity || item.severity === severity)
                .filter(item => !status || item.status === status)
                .slice(-limit)
                .map(item => safeClone(item));
        };
        const markFindingStatus = (lorebook = [], id = '', status = 'reviewed', options = {}) => {
            if (!Array.isArray(lorebook)) return { changed: false, reason: 'missing_lorebook' };
            const targetId = String(id || '').trim();
            if (!targetId) return { changed: false, reason: 'missing_id' };
            const nextStatus = ['open', 'reviewed', 'ignored', 'resolved', 'accepted'].includes(String(status || '').trim())
                ? String(status).trim()
                : 'reviewed';
            loadState(lorebook);
            const idx = (Array.isArray(scanState.findings) ? scanState.findings : []).findIndex(item => String(item?.id || '').trim() === targetId);
            if (idx < 0) return { changed: false, reason: 'not_found' };
            const previous = normalizeFinding(scanState.findings[idx]);
            const next = normalizeFinding({
                ...previous,
                status: nextStatus,
                reviewedAt: Date.now(),
                reviewNote: options?.note || options?.reviewNote || previous.reviewNote || ''
            });
            scanState.findings[idx] = next;
            scanState.lastUpdated = Date.now();
            rebuildSummary(scanState);
            saveState(lorebook);
            return { changed: true, finding: safeClone(next), previousStatus: previous.status };
        };
        const getState = () => scanState;
        const resetState = (nextState = null) => {
            scanState = normalizeState(nextState || defaultState());
            rebuildSummary(scanState);
            return scanState;
        };
        const withTemporaryState = callback => {
            const previous = scanState;
            try {
                scanState = safeClone(previous);
                const result = callback();
                if (result && typeof result.then === 'function') throw new Error('management_prepare_must_be_synchronous');
                return result;
            } finally { scanState = previous; }
        };
        return {
            withTemporaryState,
            SCAN_COMMENT,
            SCAN_SCHEMA,
            loadState,
            saveState,
            scanBatch,
            listFindings,
            markFindingStatus,
            markIntegrityFinding: markFindingStatus,
            getState,
            resetState
        };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_IntegrityScanner = IntegrityScanner;
    } catch (_) { /* optional diagnostics only */ }

