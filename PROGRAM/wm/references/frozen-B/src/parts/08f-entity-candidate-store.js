    // [MANAGER] Hidden Entity Candidate Store
    // Keeps weak/non-promoted entity observations out of official entity state.
    // ══════════════════════════════════════════════════════════════
    const EntityCandidateCore = (() => {
        const COMMENT = 'lmai_entity_candidates';
        const VERSION = 1;
        const MAX_ITEMS = 96;
        const MAX_EVIDENCE = 6;
        const NAME_MAX = 80;
        const SNIPPET_MAX = 320;
        let state = null;

        const makeEmptyState = (scopeKey = '', chatId = '') => ({
            version: VERSION,
            scopeKey: String(scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global',
            chatId: String(chatId || getActiveManagedChatId() || '').trim(),
            updatedAt: 0,
            items: []
        });
        const compact = (value = '', max = 240) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            return text.length > max ? text.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : text;
        };
        const normalizeCandidateKey = (value = '') => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase().trim();
        const normalizeCandidateName = (value = '', lorebook = []) => {
            const raw = compact(value, NAME_MAX);
            if (!raw) return '';
            try {
                return compact(EntityManager.normalizeName(raw, lorebook) || raw, NAME_MAX);
            } catch {
                return raw;
            }
        };
        const parseJsonObject = (text = '') => {
            try {
                const parsed = JSON.parse(String(text || '{}'));
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch {
                return {};
            }
        };
        const getOfficialEntityNameKeys = (lorebook = []) => {
            const keys = new Set();
            const add = (value = '') => {
                const normalized = normalizeCandidateName(value, lorebook);
                const key = normalizeCandidateKey(normalized || value);
                if (key) keys.add(key);
            };
            try {
                for (const name of EntityManager.getEntityCache().keys()) add(name);
                for (const entity of EntityManager.getEntityCache().values()) {
                    add(entity?.name || '');
                    if (Array.isArray(entity?.meta?.aliases)) entity.meta.aliases.forEach(add);
                }
            } catch { /* cache may be unavailable during early init */ }
            for (const entry of LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])) {
                if (entry?.comment !== 'lmai_entity') continue;
                const parsed = parseJsonObject(entry.content || '{}');
                add(parsed.name || '');
                if (Array.isArray(parsed?.meta?.aliases)) parsed.meta.aliases.forEach(add);
            }
            return keys;
        };
        const isOfficialEntityName = (name = '', lorebook = []) => {
            const normalized = normalizeCandidateName(name, lorebook);
            const key = normalizeCandidateKey(normalized || name);
            return !!key && getOfficialEntityNameKeys(lorebook).has(key);
        };
        const isBlockedCandidateName = (name = '', lorebook = []) => {
            const normalized = normalizeCandidateName(name, lorebook);
            try {
                return !normalized
                    || EntityManager.isBlockedEntityName(name, lorebook)
                    || EntityManager.isBlockedEntityName(normalized, lorebook);
            } catch {
                return !normalized;
            }
        };
        const normalizeEvidence = (evidence = {}, fallback = {}) => ({
            turn: Number(evidence.turn ?? fallback.turn ?? 0) || 0,
            source: compact(evidence.source || fallback.source || '', 96),
            reason: compact(evidence.reason || fallback.reason || '', 96),
            snippet: compact(evidence.snippet || fallback.snippet || '', SNIPPET_MAX),
            at: Number(evidence.at || Date.now())
        });
        const findSnippetAroundName = (name = '', context = {}) => {
            const haystack = compact([
                context.userText || context.inputText || '',
                context.aiText || context.responseText || ''
            ].filter(Boolean).join('\n'), 2200);
            const needle = String(name || '').trim();
            if (!haystack) return '';
            if (!needle) return compact(haystack, SNIPPET_MAX);
            const idx = haystack.indexOf(needle);
            if (idx < 0) return compact(haystack, SNIPPET_MAX);
            const start = Math.max(0, idx - 120);
            const end = Math.min(haystack.length, idx + needle.length + 180);
            return compact(haystack.slice(start, end), SNIPPET_MAX);
        };
        const sanitizeItem = (item = {}, lorebook = []) => {
            const normalizedName = normalizeCandidateName(item.normalizedName || item.name || '', lorebook);
            const name = compact(item.name || normalizedName, NAME_MAX);
            const key = normalizeCandidateKey(normalizedName || name);
            if (!name || !normalizedName || !key) return null;
            if (isBlockedCandidateName(name, lorebook) || isOfficialEntityName(normalizedName, lorebook)) return null;
            const sources = dedupeTextArray((Array.isArray(item.sources) ? item.sources : [item.source])
                .map(source => compact(source, 96))
                .filter(Boolean)).slice(0, 12);
            const reasons = dedupeTextArray((Array.isArray(item.reasons) ? item.reasons : [item.reason])
                .map(reason => compact(reason, 96))
                .filter(Boolean)).slice(0, 12);
            const evidence = (Array.isArray(item.evidence) ? item.evidence : [])
                .filter(entry => entry && typeof entry === 'object')
                .map(entry => normalizeEvidence(entry))
                .filter(entry => entry.source || entry.snippet)
                .slice(-MAX_EVIDENCE);
            const seenCount = Math.max(1, Number(item.seenCount || evidence.length || 1) || 1);
            const hasExtractionSource = sources.some(source => /entityExtraction|rejectedEntity|uncertain/i.test(source));
            const status = String(item.status || '').trim() === 'ignored'
                ? 'ignored'
                : (seenCount >= 2 && hasExtractionSource ? 'promotable' : 'candidate');
            return {
                id: compact(item.id || `cand_${TokenizerEngine.simpleHash(`${key}::${state?.scopeKey || ''}`)}`, 80),
                name,
                normalizedName,
                status,
                confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.35) || 0.35)),
                seenCount,
                firstSeenTurn: Number(item.firstSeenTurn || item.turn || 0) || 0,
                lastSeenTurn: Number(item.lastSeenTurn || item.turn || 0) || 0,
                sources,
                reasons,
                evidence
            };
        };
        const loadState = (lorebook = [], options = {}) => {
            const scopeKey = String(options?.scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
            const chatId = String(options?.chatId || getActiveManagedChatId() || '').trim();
            const idx = findManagedScopedEntryIndex(lorebook, COMMENT, scopeKey);
            const entry = idx >= 0 ? lorebook[idx] : null;
            if (!entry) {
                state = makeEmptyState(scopeKey, chatId);
                return state;
            }
            const parsed = parseJsonObject(entry.content || '{}');
            state = {
                ...makeEmptyState(scopeKey, chatId),
                ...parsed,
                scopeKey,
                chatId,
                items: []
            };
            const seen = new Set();
            for (const item of (Array.isArray(parsed.items) ? parsed.items : [])) {
                const normalized = sanitizeItem(item, lorebook);
                const key = normalizeCandidateKey(normalized?.normalizedName || normalized?.name || '');
                if (!normalized || !key || seen.has(key)) continue;
                seen.add(key);
                state.items.push(normalized);
            }
            return state;
        };
        const saveState = (lorebook = [], options = {}) => {
            if (!Array.isArray(lorebook)) return false;
            if (!state) loadState(lorebook, options);
            const scopeKey = String(options?.scopeKey || state.scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
            const chatId = String(options?.chatId || state.chatId || getActiveManagedChatId() || '').trim();
            state.scopeKey = scopeKey;
            state.chatId = chatId;
            state.version = VERSION;
            state.updatedAt = Date.now();
            state.items = (Array.isArray(state.items) ? state.items : [])
                .map(item => sanitizeItem(item, lorebook))
                .filter(Boolean)
                .sort((a, b) => Number(b.lastSeenTurn || 0) - Number(a.lastSeenTurn || 0) || Number(b.seenCount || 0) - Number(a.seenCount || 0))
                .slice(0, MAX_ITEMS);
            const idx = findManagedScopedEntryIndex(lorebook, COMMENT, scopeKey);
            if (state.items.length === 0) {
                if (idx >= 0) lorebook.splice(idx, 1);
                return true;
            }
            const entry = {
                key: buildScopedManagedLoreKey(COMMENT, scopeKey),
                comment: COMMENT,
                content: JSON.stringify(state),
                mode: 'normal',
                insertorder: 52,
                alwaysActive: false
            };
            return upsertManagedScopedEntry(lorebook, COMMENT, entry, scopeKey) >= 0;
        };
        const ensureLoaded = (lorebook = [], options = {}) => {
            const scopeKey = String(options?.scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
            if (!state || state.scopeKey !== scopeKey) loadState(lorebook, options);
            return state || loadState(lorebook, options);
        };
        const upsertCandidate = (lorebook = [], candidate = {}, context = {}) => {
            if (!Array.isArray(lorebook)) return false;
            ensureLoaded(lorebook, context);
            const normalizedName = normalizeCandidateName(candidate.normalizedName || candidate.name || '', lorebook);
            const name = compact(candidate.name || normalizedName, NAME_MAX);
            const key = normalizeCandidateKey(normalizedName || name);
            if (!name || !normalizedName || !key) return false;
            if (isBlockedCandidateName(name, lorebook) || isOfficialEntityName(normalizedName, lorebook)) return false;
            const items = Array.isArray(state.items) ? state.items : [];
            const idx = items.findIndex(item => normalizeCandidateKey(item.normalizedName || item.name || '') === key);
            const turn = Number(context.turn || candidate.turn || 0) || 0;
            const source = compact(candidate.source || context.source || 'entity-candidate', 96);
            const reason = compact(candidate.reason || context.reason || 'not_promoted', 96);
            const evidence = normalizeEvidence({
                turn,
                source,
                reason,
                snippet: candidate.snippet || findSnippetAroundName(name, context)
            }, context);
            const previous = idx >= 0 ? items[idx] : null;
            const merged = sanitizeItem({
                ...(previous || {}),
                name: previous?.name || name,
                normalizedName,
                confidence: Math.max(Number(previous?.confidence || 0), Number(candidate.confidence ?? context.confidence ?? 0.35) || 0.35),
                seenCount: Number(previous?.seenCount || 0) + 1,
                firstSeenTurn: Number(previous?.firstSeenTurn || 0) || turn,
                lastSeenTurn: turn || Number(previous?.lastSeenTurn || 0) || 0,
                sources: dedupeTextArray([...(previous?.sources || []), source].filter(Boolean)),
                reasons: dedupeTextArray([...(previous?.reasons || []), reason].filter(Boolean)),
                evidence: [...(previous?.evidence || []), evidence].slice(-MAX_EVIDENCE)
            }, lorebook);
            if (!merged) return false;
            if (idx >= 0) items[idx] = merged;
            else items.push(merged);
            state.items = items;
            return true;
        };
        const collectExtractionCandidates = (rawExtraction = {}, sanitizedPayload = {}) => {
            const out = [];
            const push = (name, source, reason, confidence = 0.45) => {
                const normalized = compact(name, NAME_MAX);
                if (!normalized) return;
                out.push({ name: normalized, source, reason, confidence });
            };
            for (const item of (Array.isArray(sanitizedPayload.rejectedEntities) ? sanitizedPayload.rejectedEntities : [])) {
                push(item?.normalizedName || item?.name || '', 'entityExtraction.rejectedEntity', item?.reason || 'not_promoted', 0.45);
            }
            for (const item of (Array.isArray(rawExtraction?.uncertain) ? rawExtraction.uncertain : [])) {
                push(item?.normalizedName || item?.name || item?.entity || '', 'entityExtraction.uncertain', item?.reason || 'uncertain', 0.4);
            }
            const uncertainEntities = Array.isArray(rawExtraction?.uncertain?.entities) ? rawExtraction.uncertain.entities : [];
            for (const item of uncertainEntities) {
                push(item?.normalizedName || item?.name || item?.entity || '', 'entityExtraction.uncertainEntity', item?.reason || 'uncertain', 0.4);
            }
            for (const relation of (Array.isArray(sanitizedPayload.rejectedRelations) ? sanitizedPayload.rejectedRelations : [])) {
                push(relation?.entityA || '', 'entityExtraction.rejectedRelation', relation?.reason || 'relation_endpoint_not_promoted', 0.28);
                push(relation?.entityB || '', 'entityExtraction.rejectedRelation', relation?.reason || 'relation_endpoint_not_promoted', 0.28);
            }
            return out;
        };
        const recordExtractionCandidates = (lorebook = [], rawExtraction = {}, sanitizedPayload = {}, context = {}) => {
            let changed = false;
            for (const candidate of collectExtractionCandidates(rawExtraction, sanitizedPayload)) {
                changed = upsertCandidate(lorebook, candidate, {
                    ...context,
                    source: candidate.source,
                    reason: candidate.reason,
                    confidence: candidate.confidence
                }) || changed;
            }
            if (changed) saveState(lorebook, context);
            return { changed, count: Array.isArray(state?.items) ? state.items.length : 0 };
        };
        const recordInvolvedEntityCandidates = (lorebook = [], names = [], context = {}) => {
            let changed = false;
            for (const rawName of (Array.isArray(names) ? names : [])) {
                const name = compact(rawName, NAME_MAX);
                if (!name) continue;
                changed = upsertCandidate(lorebook, {
                    name,
                    source: context.source || 'maintenance.involvedEntities',
                    reason: context.reason || 'related_but_not_promoted',
                    confidence: Number(context.confidence ?? 0.35) || 0.35
                }, context) || changed;
            }
            if (changed) saveState(lorebook, context);
            return { changed, count: Array.isArray(state?.items) ? state.items.length : 0 };
        };
        const prunePromotedOrBlocked = (lorebook = [], context = {}) => {
            if (!Array.isArray(lorebook)) return { changed: false, count: 0 };
            ensureLoaded(lorebook, context);
            const before = Array.isArray(state.items) ? state.items.length : 0;
            state.items = (Array.isArray(state.items) ? state.items : []).filter(item => {
                const name = item?.normalizedName || item?.name || '';
                return name && !isBlockedCandidateName(name, lorebook) && !isOfficialEntityName(name, lorebook);
            });
            const changed = state.items.length !== before;
            if (changed) saveState(lorebook, context);
            return { changed, count: state.items.length };
        };
        const getState = () => state || makeEmptyState();
        const withTemporaryState = callback => {
            const previous = state;
            try {
                state = safeClone(previous);
                const result = callback();
                if (result && typeof result.then === 'function') throw new Error('management_prepare_must_be_synchronous');
                return result;
            } finally { state = previous; }
        };
        return Object.freeze({
            COMMENT,
            withTemporaryState,
            loadState,
            saveState,
            getState,
            resetState: () => { state = makeEmptyState(); },
            recordExtractionCandidates,
            recordInvolvedEntityCandidates,
            prunePromotedOrBlocked
        });
    })();

    // ══════════════════════════════════════════════════════════════
