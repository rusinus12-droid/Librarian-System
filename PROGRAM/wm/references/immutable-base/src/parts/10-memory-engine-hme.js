    // ══════════════════════════════════════════════════════════════
    // [MANAGER] Memory Engine
    // ══════════════════════════════════════════════════════════════
    const MemoryEngine = (() => {
        const CONFIG = {
            ...buildOptimizedHiddenSettingsDefaults(),
            tokenizerType: 'simple',
            moduleLorebookReflectionEnabled: false,
            moduleLorebookSelectedIds: '',
            entityBlocklist: [],
            storyAuthorEnabled: false,
            storyAuthorMode: 'disabled',
            directorEnabled: false,
            directorMode: 'disabled',
            worldAdditionalEnabled: true,
            worldAdditionalMode: 'firm',
            worldAdditionalMaxPerRequest: 3,
            worldAdditionalAutoIntegrate: true,
            worldCanonCustomText: '',
            worldCanonCustomForce: false,
            worldAdditionalCustomText: '',
            worldAdditionalCustomForce: false,
            entityVisualCanonEnabled: true,
            afterRequestParallelAnalysis: true,
            analysisRecoveryImmediateAttempts: 1,
            analysisRecoveryDeferredAttempts: 2,
            analysisRecoveryDeferredDelayMs: 5000,
            flexRoutingMode: 'off',
            flexTimeoutMs: 600000,
            flexFallbackToStandard: false,
            vertexFlexMode: 'provisioned_then_flex',
            customServiceTierPassthrough: false,
            llm: { provider: 'openai', url: '', key: '', model: 'gpt-4o-mini', temp: 0.3, timeout: 120000, serviceTier: 'off', reasoningPreset: 'auto', reasoningEffort: 'none', reasoningBudgetTokens: DEFAULT_REASONING_BUDGET_TOKENS, maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS, glmThinkingType: 'enabled' },
            auxLlm: { enabled: false, provider: 'openai', url: '', key: '', model: 'gpt-4o-mini', temp: 0.2, timeout: 90000, serviceTier: 'off', reasoningPreset: 'auto', reasoningEffort: 'none', reasoningBudgetTokens: DEFAULT_REASONING_BUDGET_TOKENS, maxCompletionTokens: DEFAULT_AUX_MAX_COMPLETION_TOKENS, glmThinkingType: 'enabled' },
            embeddingCacheMaxEntries: 768,
            embeddingCacheMaxTextChars: 8000,
            recallEmbeddingCandidateMax: 8,
            recallEmbeddingPrefilterMinSparse: 0.10,
            recallDetailCandidateMax: 32,
            coldArchiveHydrationEnabled: true,
            coldArchiveHydrationMaxShards: 4,
            coldArchiveHydrationMaxEntries: 8,
            coldArchiveHydrationMinScore: 2.2,
            embed: { enabled: true, provider: 'voyageai', url: 'https://api.voyageai.com/v1/embeddings', key: '', model: 'voyage-4-large', timeout: 120000 }
        };

        const getMetaCache = () => {
            if (!MemoryState.metaCache) MemoryState.metaCache = new LRUCache(2000, { label: 'meta', maxBytes: 12 * 1024 * 1024 });
            return MemoryState.metaCache;
        };

        const getSimCache = () => {
            if (!MemoryState.simCache) MemoryState.simCache = new LRUCache(2500, { label: 'similarity', maxBytes: 10 * 1024 * 1024 });
            return MemoryState.simCache;
        };
        const getEmbeddingCache = () => {
            const maxEntries = Math.max(128, Math.min(2048, Math.floor(Number(CONFIG.embeddingCacheMaxEntries || 768)) || 768));
            const maxBytes = 36 * 1024 * 1024;
            if (!MemoryState.embeddingCache || MemoryState.embeddingCache.maxSize !== maxEntries || MemoryState.embeddingCache.maxBytes !== maxBytes) {
                try { MemoryState.embeddingCache?.dispose?.(); } catch (_) {}
                MemoryState.embeddingCache = new LRUCache(maxEntries, { label: 'embedding', maxBytes });
            }
            return MemoryState.embeddingCache;
        };
        const shouldCacheEmbeddingText = (text = '') => {
            const len = String(text || '').length;
            const maxChars = Math.max(256, Math.min(32000, Number(CONFIG.embeddingCacheMaxTextChars || 8000) || 8000));
            return len >= 12 && len <= maxChars;
        };
        const getEmbeddingCacheKey = (providerName = '', model = '', text = '') => {
            const source = String(text || '');
            const checksumSource = `${source.slice(0, 32)}\u0000${source.slice(-16)}\u0000${source.length}`;
            return `emb:${String(providerName || '').trim().toLowerCase()}:${String(model || '').trim()}:${source.length}:${TokenizerEngine.simpleHash(source)}:${TokenizerEngine.simpleHash(checksumSource)}`;
        };
        const getEmbeddingEndpointHash = (config = CONFIG) => {
            const url = String(config?.embed?.url || '').trim().replace(/\/+$/, '');
            return url ? String(TokenizerEngine.simpleHash(url)) : '';
        };
        const getEmbeddingFingerprintMeta = (config = CONFIG, vector = null) => {
            const embed = config?.embed || {};
            const provider = String(embed.provider || 'openai').trim().toLowerCase() || 'openai';
            const model = String(embed.model || '').trim();
            const endpointHash = getEmbeddingEndpointHash(config);
            const dim = Array.isArray(vector) ? vector.length : Math.max(0, Number(embed.dim || embed.dimension || 0) || 0);
            return {
                schema: 'libra.embedding.fingerprint.v1',
                provider,
                model,
                endpointHash,
                dim,
                key: `${provider}:${model}:${endpointHash || 'default'}:${dim || 'unknown'}`
            };
        };
        const getEmbeddingFingerprint = (config = CONFIG, vector = null) => getEmbeddingFingerprintMeta(config, vector).key;
        const buildEmbeddingCacheRecord = (vector = null, config = CONFIG, text = '') => ({
            schema: 'libra.embedding.cache.v1',
            fingerprint: getEmbeddingFingerprintMeta(config, vector),
            dim: Array.isArray(vector) ? vector.length : 0,
            vector: Array.isArray(vector) ? vector : [],
            sourceHash: text ? String(TokenizerEngine.simpleHash(String(text || ''))) : '',
            sourceChars: String(text || '').length,
            cachedAt: Date.now()
        });
        const readEmbeddingCacheRecord = (record = null, config = CONFIG) => {
            if (Array.isArray(record)) {
                return { ok: true, legacy: true, vector: record, dim: record.length, reason: 'legacy_vector' };
            }
            if (!record || typeof record !== 'object') {
                return { ok: false, vector: null, dim: 0, reason: 'invalid_record' };
            }
            const vector = Array.isArray(record.vector) ? record.vector : null;
            if (!vector) return { ok: false, vector: null, dim: 0, reason: 'missing_vector' };
            const expected = getEmbeddingFingerprintMeta(config, vector);
            const actual = record.fingerprint && typeof record.fingerprint === 'object' ? record.fingerprint : {};
            const actualDim = Number(record.dim || actual.dim || vector.length) || 0;
            const mismatch = [];
            if (String(actual.provider || '').trim().toLowerCase() !== expected.provider) mismatch.push('provider');
            if (String(actual.model || '').trim() !== expected.model) mismatch.push('model');
            if (String(actual.endpointHash || '') !== expected.endpointHash) mismatch.push('endpoint');
            if (actualDim !== vector.length || (Number(actual.dim || 0) && Number(actual.dim || 0) !== vector.length)) mismatch.push('dim');
            if (mismatch.length > 0) {
                return { ok: false, vector: null, dim: vector.length, reason: `fingerprint_mismatch:${mismatch.join(',')}` };
            }
            return { ok: true, legacy: false, vector, dim: vector.length, fingerprint: actual };
        };
        const normalizeEmbeddingDebugSource = (source = '') => String(source || 'general')
            .trim()
            .replace(/[^\w:.-]+/g, '_')
            .slice(0, 48) || 'general';
        const bumpEmbeddingDebugSource = (stats, source = 'general', field = 'total') => {
            if (!stats || typeof stats !== 'object') return;
            const key = normalizeEmbeddingDebugSource(source);
            if (!stats.sources || typeof stats.sources !== 'object') stats.sources = {};
            if (!stats.sources[key]) stats.sources[key] = { total: 0, cacheHits: 0, providerCalls: 0, empty: 0, error: 0 };
            stats.sources[key][field] = Number(stats.sources[key][field] || 0) + 1;
        };
        const getStandardLoreTokenCache = () => {
            if (!MemoryState.standardLoreTokenCache) MemoryState.standardLoreTokenCache = new LRUCache(512, { label: 'standard-lore-token', maxBytes: 8 * 1024 * 1024 });
            return MemoryState.standardLoreTokenCache;
        };
        const getHybridRowCache = () => {
            if (!MemoryState.hybridRowCache) MemoryState.hybridRowCache = new LRUCache(2500, { label: 'hybrid-row', maxBytes: 20 * 1024 * 1024 });
            return MemoryState.hybridRowCache;
        };
        const safeClearMemoryCache = (label = 'cache', cacheGetter = null, fallbackGetter = null, context = {}) => {
            let cleared = false;
            try {
                const cache = typeof cacheGetter === 'function' ? cacheGetter() : cacheGetter;
                if (cache && typeof cache.clear === 'function') {
                    cache.clear();
                    cleared = true;
                }
            } catch (error) {
                recordSuppressedRuntimeError(`hme.clear_cache.${label}`, error, context);
            }
            if (cleared || !fallbackGetter) return cleared;
            try {
                const fallback = typeof fallbackGetter === 'function' ? fallbackGetter() : fallbackGetter;
                if (fallback && typeof fallback.clear === 'function') {
                    fallback.clear();
                    return true;
                }
            } catch (fallbackError) {
                recordSuppressedRuntimeError(`hme.clear_cache.${label}_fallback`, fallbackError, context);
            }
            return false;
        };

        const RECALL_INTENT_PATTERNS = Object.freeze({
            origin: /처음|처음부터|시작|계기|왜|원래|배경|어렸|origin|beginning|setup|why/,
            transition: /이후|때문|전환|바뀌|계기로|trigger|turning|after|because/,
            current: /지금|현재|방금|이어|계속|다음|current|now|continue|carry/,
            relationship: /관계|감정|연인|고백|좋아|사랑|relationship|romance/,
            worldRule: /세계관|규칙|금지|학교|조직|시스템|레벨|마법|world|rule|system/,
            aftermath: /$^/
        });

        // weight_mode/w_sim/w_imp/w_rec drive the recall weight vector.  `custom` uses the
        // configured weights; a named preset resolves through the preset table; `auto`
        // keeps the configured (default) weights.
        const detectGenreWeights = (query) => null;
        const resolveRecallWeights = (query = '') => {
            const genre = detectGenreWeights(query);
            if (genre) return genre;
            const mode = String(CONFIG?.weightMode || 'auto').trim().toLowerCase();
            try {
                if (mode === 'custom' || (mode && mode !== 'auto')) {
                    return resolveWeightsForMode(mode, CONFIG?.weights);
                }
            } catch (_) {}
            return CONFIG.weights;
        };
        const calculateDynamicWeights = (query) => resolveRecallWeights(query);
        const _log = (msg) => { if (CONFIG.debug) recordRuntimeDebug('log', `[LIBRA] ${msg}`); };
        const memoryEntryMetaHeadCache = new WeakMap();
        const memoryEntrySafeKeyCache = new WeakMap();
        const memoryEntryHashCache = new WeakMap();
        const parseMemoryMetaHead = (entry = null) => {
            try {
                if (!entry || typeof entry !== 'object' || String(entry?.comment || '') !== 'lmai_memory') return null;
                const raw = String(entry?.content || '');
                const cached = memoryEntryMetaHeadCache.get(entry);
                if (cached && cached.content === raw) return cached.meta;
                const marker = raw.indexOf('[META:');
                if (marker < 0 || marker > 64) {
                    memoryEntryMetaHeadCache.set(entry, { content: raw, meta: null });
                    return null;
                }
                const jsonStart = raw.indexOf('{', marker);
                if (jsonStart < 0 || jsonStart > 2048) {
                    memoryEntryMetaHeadCache.set(entry, { content: raw, meta: null });
                    return null;
                }
                let depth = 0;
                let inString = false;
                let escaped = false;
                let jsonEnd = -1;
                const maxScan = Math.min(raw.length, jsonStart + 4096);
                for (let i = jsonStart; i < maxScan; i++) {
                    const ch = raw[i];
                    if (inString) {
                        if (escaped) escaped = false;
                        else if (ch === '\\') escaped = true;
                        else if (ch === '"') inString = false;
                        continue;
                    }
                    if (ch === '"') {
                        inString = true;
                    } else if (ch === '{') {
                        depth++;
                    } else if (ch === '}') {
                        depth--;
                        if (depth === 0) {
                            jsonEnd = i;
                            break;
                        }
                    }
                }
                if (jsonEnd < jsonStart) {
                    memoryEntryMetaHeadCache.set(entry, { content: raw, meta: null });
                    return null;
                }
                const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
                const meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
                memoryEntryMetaHeadCache.set(entry, { content: raw, meta });
                return meta;
            } catch (_) {
                try { if (entry && typeof entry === 'object') memoryEntryMetaHeadCache.set(entry, { content: String(entry.content || ''), meta: null }); } catch (_) {}
                return null;
            }
        };
        const getMemoryBodyAfterMetaHead = (entry = null) => {
            try {
                if (!entry || typeof entry !== 'object' || String(entry?.comment || '') !== 'lmai_memory') return String(entry?.content || '');
                const raw = String(entry?.content || '');
                const marker = raw.indexOf('[META:');
                if (marker < 0 || marker > 64) return raw;
                const jsonStart = raw.indexOf('{', marker);
                if (jsonStart < 0 || jsonStart > 2048) return raw;
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
                if (jsonEnd < jsonStart) return raw;
                const closeBracket = raw.indexOf(']', jsonEnd);
                if (closeBracket < 0 || closeBracket > jsonEnd + 8) return raw.slice(jsonEnd + 1);
                return raw.slice(closeBracket + 1).replace(/^\s+/, '');
            } catch (_) {
                return String(entry?.content || '');
            }
        };
        const isIntegrityValidMemoryEntry = (entry = null, context = {}) => {
            const meta = parseMemoryMetaHead(entry);
            if (!meta?.integrity?.schema) return true;
            const body = getMemoryBodyAfterMetaHead(entry);
            const result = IntegrityMetaManager.validateMemoryMeta(meta, body, {
                ...context,
                recordId: context.recordId || getSafeKey(entry) || entry?.key || ''
            });
            if (result.ok) return true;
            IntegrityMetaManager.debugValidationFailure('memory.entry', result, {
                domain: 'memory',
                recordId: context.recordId || entry?.key || '',
                scopeKey: context.scopeKey || MemoryState?._activeScopeKey || ''
            });
            return false;
        };
        const getMemoryMetaHeadField = (entry = null, field = '') => {
            const key = String(field || '').trim();
            if (!key) return '';
            const meta = parseMemoryMetaHead(entry);
            const value = meta && Object.prototype.hasOwnProperty.call(meta, key) ? meta[key] : '';
            if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean).join('|');
            return String(value || '').trim();
        };
        const getEntryContentHash = (entry = null) => {
            if (entry && typeof entry === 'object') {
                const cached = memoryEntryHashCache.get(entry);
                if (cached !== undefined) return cached;
            }
            const content = String(entry?.content || '');
            if (!content) return '0';
            const sourceHash = getMemoryMetaHeadField(entry, 'sourceHash');
            const hash = sourceHash
                ? `${sourceHash}:${TokenizerEngine.simpleHash(content.slice(0, 1600))}:${content.length}`
                : String(TokenizerEngine.simpleHash(content));
            try { if (entry && typeof entry === 'object') memoryEntryHashCache.set(entry, hash); } catch (_) {}
            return hash;
        };
        const getSafeKey = (entry) => {
            if (!entry) return TokenizerEngine.getSafeMapKey('');
            if (entry && typeof entry === 'object') {
                const cached = memoryEntrySafeKeyCache.get(entry);
                if (cached !== undefined) return cached;
            }
            const explicit = String(entry.id || entry.key || '').trim();
            const turnKey = !explicit ? getMemoryMetaHeadField(entry, 'turnKey') : '';
            const sourceHash = (!explicit && !turnKey) ? getMemoryMetaHeadField(entry, 'sourceHash') : '';
            const messageId = (!explicit && !turnKey && !sourceHash) ? getMemoryMetaHeadField(entry, 'm_id') : '';
            const key = explicit
                || (turnKey ? `memory_turn:${turnKey}` : '')
                || (sourceHash ? `memory_source:${sourceHash}` : '')
                || (messageId ? `memory_msg:${messageId}` : '')
                || TokenizerEngine.getSafeMapKey(entry.content || "");
            try { if (entry && typeof entry === 'object') memoryEntrySafeKeyCache.set(entry, key); } catch (_) {}
            return key;
        };
        let lastRetrievalDebug = null;

        const META_PATTERN = /\[META:(\{[\s\S]*?\})\]\s*/;
        const extractMetaJsonString = (raw = '') => {
            return extractLibraMetaJsonString(raw);
        };
        const parseMeta = (raw) => {
            const def = { t: 0, ttl: 0, imp: 5, type: 'context', cat: 'personal', ent: [] };
            if (typeof raw !== 'string') return def;
            try {
                const metaJson = extractMetaJsonString(raw);
                return metaJson ? { ...def, ...JSON.parse(metaJson) } : def;
            } catch { return def; }
        };

        const getCachedMeta = (entry) => {
            const key = getSafeKey(entry);
            const cache = getMetaCache();
            const cached = cache.get(key);
            if (cached !== undefined) return cached;
            const m = parseMeta(entry.content);
            cache.set(key, m);
            return m;
        };

        // Recall protection is independent of lexical/semantic relevance and applies to every lane.
        const RECALL_WORLDLINE_VALIDATED = Symbol('recall-worldline-validated');
        const recallWorldlineContext = (context = {}) => {
            const scopeKey = String(context.worldlineScopeKey || context.scopeKey || MemoryState._activeScopeKey || '').trim();
            const worldlineState = Object.prototype.hasOwnProperty.call(context, 'worldlineState')
                ? context.worldlineState : (scopeKey ? LibraTurnWorldline.get(scopeKey) : null);
            return { scopeKey, worldlineState };
        };
        const inspectRecallEligibility = (entry = null, context = {}) => {
            const reject = reason => ({ eligible: false, reason });
            if (!entry || typeof entry !== 'object') return reject('invalid_entry');
            if (!isIntegrityValidMemoryEntry(entry, { scopeKey: context.scopeKey || MemoryState._activeScopeKey || '' })) return reject('integrity');
            // Protection must see current metadata even when an existing row id has been cached.
            const meta = parseMeta(entry.content);
            const rawPayload = CompactMemoryCodec.parsePayloadFromEntry(entry) || {};
            const payload = CompactMemoryCodec.normalizePayloadForRead?.(rawPayload, meta) || rawPayload;
            const flags = [meta, rawPayload, payload, meta.hme, rawPayload.hme, rawPayload.hybridRow, payload.hme, payload.hybridRow, meta.hybridRow,
                meta.projection, rawPayload.projection, payload.projection]
                .filter(value => value && typeof value === 'object');
            if (flags.some(value => value.rollbackTombstone === true)) return reject('tombstone');
            if (flags.some(value => ['retracted', 'superseded'].includes(String(value.provenanceStatus || '').trim().toLowerCase()))) return reject('provenance');
            if (flags.some(value => ['candidate_deleted', 'superseded'].includes(normalizeHybridRollbackState(value.rollbackState || 'active')))) return reject('rollback');
            if (flags.some(value => value.hiddenFromPrompt === true || value.stale === true || value.active === false)) return reject('inactive');
            const ttl = Number(meta.ttl), turn = Number(meta.t);
            const currentTurn = Number(context.currentTurn ?? MemoryState.currentTurn ?? 0);
            if (!(ttl === -1 || (Number.isFinite(turn) && Number.isFinite(ttl) && turn + ttl >= currentTurn))) return reject('expired');
            const content = CompactMemoryCodec.buildRecallScoringTextFromEntry(entry, CONFIG.recallScoringTextMaxChars || 800)
                || CompactMemoryCodec.buildSearchTextFromEntry(entry);
            if (Utils.shouldExcludeStoredMemoryContent(content)) return reject('excluded_content');
            if (!context[RECALL_WORLDLINE_VALIDATED] && String(entry.comment || '').trim() === 'lmai_memory') {
                const { scopeKey, worldlineState } = recallWorldlineContext(context);
                const live = LibraTurnWorldline.filterSupersededMemories([entry], worldlineState).entries;
                if (!live.length) return reject('worldline');
                if (!LibraTurnWorldline.applyDriftExclusion(live, context.ephemeralDriftExclusion, scopeKey).entries.length) return reject('drift');
            }
            return { eligible: true, reason: '' };
        };
        const filterRecallEligibleEntries = (entries = [], context = {}) => {
            const source = Array.isArray(entries) ? entries : [];
            const reasons = {};
            const basic = source.filter(entry => {
                const result = inspectRecallEligibility(entry, { ...context, [RECALL_WORLDLINE_VALIDATED]: true });
                if (!result.eligible) reasons[result.reason] = (reasons[result.reason] || 0) + 1;
                return result.eligible;
            });
            const { scopeKey, worldlineState } = recallWorldlineContext(context);
            const memories = basic.filter(entry => String(entry.comment || '').trim() === 'lmai_memory');
            const live = LibraTurnWorldline.filterSupersededMemories(memories, worldlineState);
            const drift = LibraTurnWorldline.applyDriftExclusion(live.entries, context.ephemeralDriftExclusion, scopeKey);
            if (live.excluded) reasons.worldline = live.excluded;
            if (drift.excluded) reasons.drift = drift.excluded;
            const allowed = new Set(drift.entries);
            const seen = new Set();
            const filtered = basic.filter(entry => {
                if (String(entry.comment || '').trim() === 'lmai_memory' && !allowed.has(entry)) return false;
                const key = String(getSafeKey(entry) || '');
                if (key && seen.has(key)) { reasons.duplicate = (reasons.duplicate || 0) + 1; return false; }
                if (key) seen.add(key);
                return true;
            });
            return { entries: filtered, excluded: source.length - filtered.length, reasons };
        };

        const ADAPTIVE_SEMANTIC_RECALL_POLICY = Object.freeze({
            version: 'libra_adaptive_semantic_recall_v1',
            legacySparseWeight: 0.82,
            legacyEmbeddingWeight: 0.18,
            directSparseWeight: 0.75,
            directEmbeddingWeight: 0.25,
            bridgeSparseWeight: 0.55,
            bridgeEmbeddingWeight: 0.45,
            bridgeCosineGate: 0.62,
            weakSparseMax: 0.28,
            minEntityOverlap: 2,
            aliasBridgeBonus: 0.055,
            semanticFloor: 0.26
        });
        const stripSemanticKoParticle = (value = '') => String(value || '').trim()
            .replace(/(?:에게서|에게|한테서|한테|으로|로서|로|에서|부터|까지|처럼|보다|마다|라도|이라도|하고|이랑|랑|와|과|은|는|이|가|을|를|도|만|의)$/u, '')
            .trim();
        const normalizeSemanticText = (value = '') => String(value || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_가-힣ぁ-んァ-ヶ一-龯]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const extractSemanticEntityTokens = (value = '') => {
            const raw = String(value || '');
            const stop = new Set(['그때', '장면', '단둘', '단둘이', '처음', '원점', '기억', '회수', '연결', '감정', '마음', '부담', '식사', '분식', '규칙', '회사', '소속', '소속사', '연애', '금지', '공개', '갈등', '관계', '현재', '지금', 'because', 'scene', 'memory', 'recall']);
            const out = [];
            const push = (token) => {
                const stripped = stripSemanticKoParticle(token);
                const normalized = normalizeSemanticText(stripped).replace(/\s+/g, '');
                if (!normalized || normalized.length < 2 || normalized.length > 18 || stop.has(normalized)) return;
                if (!out.includes(normalized)) out.push(normalized);
            };
            (raw.match(/[가-힣]{2,8}/g) || []).forEach(push);
            (raw.match(/[A-Za-z][A-Za-z0-9_.-]{1,32}/g) || []).forEach(push);
            return out.slice(0, 32);
        };
        const countSemanticEntityOverlap = (query = '', body = '') => {
            const q = extractSemanticEntityTokens(query);
            const bodyNorm = normalizeSemanticText(body).replace(/\s+/g, '');
            const hits = q.filter(token => token && bodyNorm.includes(token));
            return { count: hits.length, hits: hits.slice(0, 8) };
        };
        const SEMANTIC_ALIAS_BRIDGES = Object.freeze([]);
        const getSemanticAliasBridgeHits = (query = '', body = '') => {
            const q = normalizeSemanticText(query);
            const b = normalizeSemanticText(body);
            if (!q || !b) return [];
            return SEMANTIC_ALIAS_BRIDGES
                .filter(rule => rule.query.some(re => re.test(q)) && rule.body.some(re => re.test(b)))
                .map(rule => rule.label)
                .slice(0, 8);
        };
        const hasDirectSparseEvidence = (sparse = {}) => {
            const coverage = Number(sparse?.coverage || 0);
            const lexical = Number(sparse?.lexical || 0);
            const overlap = Number(sparse?.overlap || 0);
            const wordJaccard = Number(sparse?.wordJaccard || 0);
            const conceptJaccard = Number(sparse?.conceptJaccard || 0);
            return coverage >= 0.24 || lexical >= 0.08 || wordJaccard >= 0.10 || conceptJaccard >= 0.12 || overlap >= 2 || !!sparse?.evidenceGate;
        };
        const inferAdaptiveSemanticRecall = (query = '', body = '', sparse = {}, cosine = 0, embeddingUsed = false) => {
            const entity = countSemanticEntityOverlap(query, body);
            const aliasBridgeHits = getSemanticAliasBridgeHits(query, body);
            const sparseScore = Number(sparse?.score || 0);
            const directSparseEvidence = hasDirectSparseEvidence(sparse);
            const weakSparseStrongEmbedding = embeddingUsed
                && sparseScore <= ADAPTIVE_SEMANTIC_RECALL_POLICY.weakSparseMax
                && cosine >= ADAPTIVE_SEMANTIC_RECALL_POLICY.bridgeCosineGate
                && entity.count >= ADAPTIVE_SEMANTIC_RECALL_POLICY.minEntityOverlap;
            const aliasBridge = aliasBridgeHits.length > 0 && entity.count >= Math.max(1, ADAPTIVE_SEMANTIC_RECALL_POLICY.minEntityOverlap - 1);
            const assist = aliasBridge || weakSparseStrongEmbedding;
            const sparseWeight = assist
                ? ADAPTIVE_SEMANTIC_RECALL_POLICY.bridgeSparseWeight
                : directSparseEvidence
                    ? ADAPTIVE_SEMANTIC_RECALL_POLICY.directSparseWeight
                    : ADAPTIVE_SEMANTIC_RECALL_POLICY.legacySparseWeight;
            const embeddingWeight = assist
                ? ADAPTIVE_SEMANTIC_RECALL_POLICY.bridgeEmbeddingWeight
                : directSparseEvidence
                    ? ADAPTIVE_SEMANTIC_RECALL_POLICY.directEmbeddingWeight
                    : ADAPTIVE_SEMANTIC_RECALL_POLICY.legacyEmbeddingWeight;
            const reasons = [];
            if (aliasBridge) reasons.push(`alias:${aliasBridgeHits.join('/')}`);
            if (weakSparseStrongEmbedding) reasons.push(`semantic-entity:${entity.hits.join('/') || entity.count}`);
            if (directSparseEvidence) reasons.push('direct-sparse-evidence');
            const floor = aliasBridge ? ADAPTIVE_SEMANTIC_RECALL_POLICY.semanticFloor : 0;
            return {
                policyVersion: ADAPTIVE_SEMANTIC_RECALL_POLICY.version,
                assist,
                aliasBridge,
                weakSparseStrongEmbedding,
                directSparseEvidence,
                sparseWeight,
                embeddingWeight,
                entityOverlap: entity.count,
                entityHits: entity.hits,
                aliasBridgeHits,
                semanticGate: assist || (embeddingUsed && cosine >= 0.70 && entity.count >= ADAPTIVE_SEMANTIC_RECALL_POLICY.minEntityOverlap),
                semanticFloor: floor,
                reasons: uniqLimit(reasons, 8)
            };
        };
        const calcSimilarityDetailed = async (textA, textB, options = {}) => {
            const cleanA = String(textA || '').trim();
            const cleanB = String(textB || '').trim();
            if (!cleanA || !cleanB) {
                return { similarity: 0, sparseScore: 0, baseScore: 0, embedding: 0, embeddingUsed: false, evidenceGate: false, evidenceReasons: [], anchorBonus: 0, bestWindow: '', semanticAssist: false, semanticGate: false, semanticReasons: [] };
            }
            const sparse = StrengthenedJaccardCore.score(cleanA, cleanB, {
                weights: CONFIG.scoringWeights || DEFAULT_RE_SCORING_WEIGHTS,
                focusNames: options.focusNames || [],
                meta: options.meta || {},
                currentTurn: options.currentTurn || 0,
                anchorBonusLimit: Number(CONFIG.recallAnchorBonus ?? 0.12),
                includeWindow: !!options.includeWindow,
                maxChars: Number(options.maxWindowChars || CONFIG.recallSentenceWindowChars || 260)
            });
            const sparseScore = Number(sparse?.score || 0);
            const engine = EmbeddingEngine;
            let cosine = 0;
            let embeddingUsed = false;
            const embeddingAllowed = options.embeddingAllowed !== false;
            if (embeddingAllowed && engine && typeof engine.getEmbedding === 'function' && typeof engine.cosineSimilarity === 'function') {
                const hasSuppliedVecA = Object.prototype.hasOwnProperty.call(options, 'queryEmbedding')
                    || Object.prototype.hasOwnProperty.call(options, 'embeddingA');
                const vecA = hasSuppliedVecA
                    ? (options.queryEmbedding || options.embeddingA || null)
                    : await engine.getEmbedding(cleanA, { source: options.embeddingSourceA || options.embeddingSource || 'similarity_query' });
                const vecB = vecA ? await engine.getEmbedding(cleanB, { source: options.embeddingSourceB || options.embeddingSource || 'similarity_candidate' }) : null;
                cosine = (vecA && vecB) ? Math.max(0, engine.cosineSimilarity(vecA, vecB)) : 0;
                embeddingUsed = !!(vecA && vecB);
            }
            const semantic = inferAdaptiveSemanticRecall(cleanA, cleanB, sparse, cosine, embeddingUsed);
            const mixed = embeddingUsed
                ? (sparseScore * semantic.sparseWeight) + (cosine * semantic.embeddingWeight)
                : sparseScore;
            const aliasBridgeBonus = semantic.aliasBridge ? ADAPTIVE_SEMANTIC_RECALL_POLICY.aliasBridgeBonus : 0;
            const semanticFloor = semantic.semanticGate ? semantic.semanticFloor : 0;
            const similarity = embeddingUsed
                ? Math.max(sparseScore, mixed + aliasBridgeBonus, semanticFloor)
                : Math.max(sparseScore + aliasBridgeBonus, semanticFloor, sparseScore);
            const evidenceReasons = uniqLimit([
                ...(Array.isArray(sparse?.evidenceReasons) ? sparse.evidenceReasons : []),
                ...semantic.reasons.map(reason => `semantic:${reason}`)
            ], 10);
            return {
                similarity,
                sparseScore,
                baseScore: Number(sparse?.baseScore || sparseScore || 0),
                embedding: cosine,
                embeddingUsed,
                embeddingSkipped: !embeddingAllowed,
                embeddingSkipReason: embeddingAllowed ? '' : String(options.embeddingSkipReason || 'disabled').trim(),
                evidenceGate: !!sparse?.evidenceGate || !!semantic.semanticGate,
                evidenceReasons,
                anchorBonus: Number(sparse?.anchorBonus || 0),
                lexical: Number(sparse?.lexical || 0),
                coverage: Number(sparse?.coverage || 0),
                wordJaccard: Number(sparse?.wordJaccard || 0),
                charJaccard: Number(sparse?.charJaccard || 0),
                conceptJaccard: Number(sparse?.conceptJaccard || 0),
                overlap: Number(sparse?.overlap || 0),
                evidence: sparse?.evidence || {},
                bestWindow: String(sparse?.bestWindow || '').trim(),
                semanticAssist: !!semantic.assist,
                semanticGate: !!semantic.semanticGate,
                semanticAliasBridge: !!semantic.aliasBridge,
                semanticReasons: semantic.reasons,
                semanticPolicy: semantic.policyVersion,
                semanticSparseWeight: semantic.sparseWeight,
                semanticEmbeddingWeight: semantic.embeddingWeight,
                semanticEntityOverlap: semantic.entityOverlap,
                semanticEntityHits: semantic.entityHits,
                semanticAliasBridgeHits: semantic.aliasBridgeHits
            };
        };

        const calcSimilarity = async (textA, textB) => {
            const hA = TokenizerEngine.simpleHash(textA);
            const hB = TokenizerEngine.simpleHash(textB);
            const scoringKey = `${CONFIG.scoringProfile || DEFAULT_RE_SCORING_PROFILE}:${TokenizerEngine.simpleHash(JSON.stringify(CONFIG.scoringWeights || {}))}:evidence-v2:adaptive-semantic-v1:${CONFIG.recallAnchorBonus}`;
            const cKey = hA < hB ? `${scoringKey}_${hA}_${hB}` : `${scoringKey}_${hB}_${hA}`;
            const simCache = getSimCache();
            const cachedScore = simCache.get(cKey);
            if (cachedScore !== undefined) return cachedScore;
            const detail = await calcSimilarityDetailed(textA, textB, {});
            const score = Number(detail?.similarity || 0);
            simCache.set(cKey, score);
            return score;
        };

        const calcRecency = (turn, current) => Math.exp(-Math.max(0, current - turn) / 20);
        const classifyRecallIntent = (query = '') => {
            const q = String(query || '').toLowerCase();
            const intent = {
                origin: RECALL_INTENT_PATTERNS.origin.test(q),
                transition: RECALL_INTENT_PATTERNS.transition.test(q),
                current: RECALL_INTENT_PATTERNS.current.test(q),
                relationship: RECALL_INTENT_PATTERNS.relationship.test(q),
                worldRule: RECALL_INTENT_PATTERNS.worldRule.test(q),
                aftermath: RECALL_INTENT_PATTERNS.aftermath.test(q)
            };
            intent.any = Object.values(intent).some(Boolean);
            intent.labels = Object.entries(intent).filter(([key, value]) => key !== 'any' && value).map(([key]) => key);
            return intent;
        };
        const getRecallPayload = (entry = null) => {
            try {
                const payload = CompactMemoryCodec.parsePayloadFromEntry(entry) || {};
                return CompactMemoryCodec.normalizePayloadForRead?.(payload, getCachedMeta(entry)) || payload;
            } catch (_) { return {}; }
        };
        const normalizeRecallFeedbackKey = (value = '') => String(value || '').trim().toLowerCase();
        const emptyRecallFeedbackStats = () => ({
            used: 0,
            ignored: 0,
            contradicted: 0,
            uncertain: 0,
            total: 0
        });
        const addRecallFeedbackStats = (target, source = {}) => {
            if (!target || !source) return target;
            target.used += Number(source.used || 0) || 0;
            target.ignored += Number(source.ignored || 0) || 0;
            target.contradicted += Number(source.contradicted || 0) || 0;
            target.uncertain += Number(source.uncertain || 0) || 0;
            target.total += Number(source.total || 0) || 0;
            return target;
        };
        const bumpRecallFeedbackMap = (map, key, status = 'uncertain') => {
            const normalizedKey = normalizeRecallFeedbackKey(key);
            if (!normalizedKey || !map) return;
            const stats = map.get(normalizedKey) || emptyRecallFeedbackStats();
            const normalizedStatus = ['used', 'ignored', 'contradicted', 'uncertain'].includes(status) ? status : 'uncertain';
            stats[normalizedStatus] += 1;
            stats.total += 1;
            map.set(normalizedKey, stats);
        };
        const buildRecallFeedbackIndex = (lorebook = []) => {
            const index = {
                enabled: false,
                records: 0,
                observations: 0,
                byId: new Map(),
                bySourceHash: new Map()
            };
            if (!Array.isArray(lorebook)) return index;
            try {
                if (typeof RecallFeedbackManager === 'undefined' || typeof RecallFeedbackManager?.list !== 'function') return index;
                const records = RecallFeedbackManager.list(lorebook, { limit: 120, oldestFirst: true });
                index.enabled = true;
                index.records = Array.isArray(records) ? records.length : 0;
                for (const record of Array.isArray(records) ? records : []) {
                    for (const item of Array.isArray(record?.items) ? record.items : []) {
                        const status = String(item?.status || 'uncertain').trim();
                        bumpRecallFeedbackMap(index.byId, item?.id, status);
                        bumpRecallFeedbackMap(index.bySourceHash, item?.sourceHash, status);
                        index.observations += 1;
                    }
                }
            } catch (error) {
                recordSuppressedRuntimeError('recall_feedback.build_index_failed', error, {
                    lorebookCount: Array.isArray(lorebook) ? lorebook.length : 0
                });
            }
            return index;
        };
        const scoreRecallFeedbackAdjustment = (stats = null) => {
            const safeStats = stats || emptyRecallFeedbackStats();
            const total = Number(safeStats.total || 0) || 0;
            if (total <= 0) {
                return { enabled: false, adjustment: 0, stats: emptyRecallFeedbackStats(), reason: 'no_feedback' };
            }
            const usedBonus = Math.min(0.045, (Number(safeStats.used || 0) || 0) * 0.008);
            const ignoredPenalty = Math.min(0.040, (Number(safeStats.ignored || 0) || 0) * 0.006);
            const contradictedPenalty = Math.min(0.060, (Number(safeStats.contradicted || 0) || 0) * 0.015);
            const uncertainPenalty = Math.min(0.012, (Number(safeStats.uncertain || 0) || 0) * 0.002);
            const raw = usedBonus - ignoredPenalty - contradictedPenalty - uncertainPenalty;
            const adjustment = Math.max(-0.070, Math.min(0.050, raw));
            return {
                enabled: true,
                adjustment,
                stats: { ...safeStats },
                usedBonus,
                ignoredPenalty,
                contradictedPenalty,
                uncertainPenalty
            };
        };
        const getRecallFeedbackAdjustmentForEntry = (entry = null, meta = {}, payload = {}, index = null) => {
            if (!index?.enabled) return scoreRecallFeedbackAdjustment(null);
            const safeKey = getSafeKey(entry);
            const idStats = index.byId.get(normalizeRecallFeedbackKey(safeKey));
            if (idStats && Number(idStats.total || 0) > 0) return scoreRecallFeedbackAdjustment(idStats);
            const sourceHashes = [
                meta?.sourceHash,
                meta?.aiHash,
                meta?.responseHash,
                payload?.sourceHash,
                payload?.source?.sourceHash,
                payload?.source?.aiHash,
                payload?.source?.responseHash
            ].map(normalizeRecallFeedbackKey).filter(Boolean);
            const stats = emptyRecallFeedbackStats();
            const seen = new Set();
            for (const hash of sourceHashes) {
                if (seen.has(hash)) continue;
                seen.add(hash);
                const row = index.bySourceHash.get(hash);
                if (row) addRecallFeedbackStats(stats, row);
            }
            return scoreRecallFeedbackAdjustment(stats);
        };
        const hybridArrayFromValue = (value) => Array.isArray(value)
            ? value.map(v => typeof v === 'string' ? v : (v?.name || v?.id || v?.label || v?.ref || v?.text || v?.summary || '')).map(v => String(v || '').trim()).filter(Boolean)
            : String(value || '').split(/[\n,|;/]+/g).map(v => v.trim()).filter(Boolean);
        const getLedgerProjectionParts = (payload = {}) => {
            if (!CompactMemoryCodec.isLedgerPayload?.(payload)) {
                return { text: [], entities: [], tags: [], relation: [], world: [], narrative: [], scene: [], unresolved: [] };
            }
            const facts = Array.isArray(payload.facts) ? payload.facts : [];
            const canonicalEntities = hybridArrayFromValue(payload?.participants?.canonicalEntities);
            const unresolved = Array.isArray(payload?.participants?.unresolvedMentions)
                ? payload.participants.unresolvedMentions.flatMap(item => [item?.label, item?.role, item?.evidence]).filter(Boolean)
                : [];
            const groups = Array.isArray(payload?.participants?.groups)
                ? payload.participants.groups.flatMap(item => [item?.label, item?.role, item?.evidence]).filter(Boolean)
                : [];
            const factTexts = facts.flatMap(item => [
                item?.type,
                item?.text,
                ...(Array.isArray(item?.entities) ? item.entities : []),
                ...(Array.isArray(item?.subjects) ? item.subjects.flatMap(ref => [ref?.label, ref?.role]) : []),
                ...(Array.isArray(item?.observerEntities) ? item.observerEntities : []),
                ...(Array.isArray(item?.evidence) ? item.evidence.map(ev => ev?.text || ev).filter(Boolean) : [])
            ]).filter(Boolean);
            const openThreads = Array.isArray(payload?.continuity?.openThreads) ? payload.continuity.openThreads : [];
            const relationSignals = Array.isArray(payload?.continuity?.relationSignals) ? payload.continuity.relationSignals : [];
            const worldChanges = Array.isArray(payload?.continuity?.worldChanges) ? payload.continuity.worldChanges : [];
            const narrative = openThreads.flatMap(item => [
                item?.label,
                item?.text,
                item?.status,
                ...(Array.isArray(item?.entities) ? item.entities : []),
                ...(Array.isArray(item?.subjectRefs) ? item.subjectRefs.flatMap(ref => [ref?.label, ref?.role]) : []),
                ...(Array.isArray(item?.resolutionCriteria) ? item.resolutionCriteria : [])
            ]).filter(Boolean);
            const relation = relationSignals.flatMap(item => [item?.text, item?.status, ...(Array.isArray(item?.entities) ? item.entities : [])]).filter(Boolean);
            const world = worldChanges.flatMap(item => [item?.type, item?.text, item?.summary, ...(Array.isArray(item?.tags) ? item.tags : [])]).filter(Boolean);
            const scene = payload.scene && typeof payload.scene === 'object'
                ? [payload.scene.time, payload.scene.location, payload.scene.summary].filter(Boolean)
                : [];
            const summaryV2 = payload.summaryV2 && typeof payload.summaryV2 === 'object'
                ? [payload.summaryV2.oneLine, payload.summaryV2.continuity, payload.summaryV2.recall].filter(Boolean)
                : [];
            const sceneCore = payload.sceneCore && typeof payload.sceneCore === 'object'
                ? [
                    payload.sceneCore.time,
                    payload.sceneCore.location,
                    payload.sceneCore.locationStatus,
                    payload.sceneCore.scenePhase,
                    payload.sceneCore.activeProblem,
                    payload.sceneCore.nextPhysicalAction
                ].filter(Boolean)
                : [];
            const beats = Array.isArray(payload.beats)
                ? payload.beats.flatMap(item => [item?.type, item?.summary, ...(Array.isArray(item?.entities) ? item.entities : [])]).filter(Boolean)
                : [];
            const evidence = Array.isArray(payload.evidence)
                ? payload.evidence.flatMap(item => [item?.source, item?.kind, item?.text]).filter(Boolean)
                : [];
            const relationDeltas = Array.isArray(payload.relationDeltas)
                ? payload.relationDeltas.flatMap(item => [item?.delta, item?.trigger, ...(Array.isArray(item?.pair) ? item.pair : [])]).filter(Boolean)
                : [];
            const entityStates = payload.entityStates && typeof payload.entityStates === 'object'
                ? Object.entries(payload.entityStates).flatMap(([name, state]) => [
                    name,
                    ...(Array.isArray(state?.visibleState) ? state.visibleState : []),
                    ...(Array.isArray(state?.inferredState) ? state.inferredState : [])
                ]).filter(Boolean)
                : [];
            const audit = [
                ...(Array.isArray(payload?.audit?.cautions) ? payload.audit.cautions : []),
                ...(Array.isArray(payload?.audit?.overpromotionRisks) ? payload.audit.overpromotionRisks : [])
            ];
            const factTypes = facts.map(item => item?.type).filter(Boolean);
            const tags = dedupeTextArray([
                ...(Array.isArray(payload.tags) ? payload.tags : []),
                ...(Array.isArray(payload.recallKeywords) ? payload.recallKeywords : []),
                ...factTypes.map(type => `fact:${type}`),
                ...worldChanges.flatMap(item => Array.isArray(item?.tags) ? item.tags : []),
                ...beats.filter(value => /^(?:state|realization|reaction|relation_delta|next_action|open_thread)$/i.test(String(value || ''))).map(value => `beat:${value}`),
                ...(relationSignals.length ? ['ledger_relation_signal'] : []),
                ...(openThreads.length ? ['ledger_open_thread'] : []),
                ...(worldChanges.length ? ['ledger_world_change'] : [])
            ].map(v => String(v || '').trim()).filter(Boolean)).slice(0, 32);
            const entities = dedupeTextArray([
                ...canonicalEntities,
                ...facts.flatMap(item => Array.isArray(item?.entities) ? item.entities : []),
                ...facts.flatMap(item => Array.isArray(item?.observerEntities) ? item.observerEntities : [])
            ].map(v => String(v || '').trim()).filter(Boolean)).slice(0, 32);
            return {
                text: dedupeTextArray([
                    payload.summary,
                    ...summaryV2,
                    ...factTexts,
                    ...scene,
                    ...sceneCore,
                    ...narrative,
                    ...relation,
                    ...relationDeltas,
                    ...world,
                    ...beats,
                    ...evidence,
                    ...entityStates,
                    ...audit,
                    ...groups,
                    ...unresolved
                ].map(v => String(v || '').trim()).filter(Boolean)).slice(0, 180),
                entities,
                tags,
                relation,
                world,
                narrative,
                scene: dedupeTextArray([...scene, ...sceneCore].map(v => String(v || '').trim()).filter(Boolean)).slice(0, 64),
                unresolved
            };
        };
        const getHybridPayloadProjectionText = (payload = {}, meta = {}, extraText = '') => {
            const ledger = getLedgerProjectionParts(payload);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            return dedupeTextArray([
                String(extraText || '').trim(),
                payload.summary,
                payload.arcKey,
                payload.arcRole,
                payload.causalRole,
                ...(isLedger ? [] : [
                    payload.primaryConflict,
                    payload.relationDelta,
                    ...(Array.isArray(payload.tags) ? payload.tags : []),
                    ...(Array.isArray(payload.mentionedEntityNames) ? payload.mentionedEntityNames : []),
                    ...(Array.isArray(payload.entityRefs) ? payload.entityRefs : [])
                ]),
                ...ledger.text,
                ...ledger.tags,
                ...(Array.isArray(meta?.tags) ? meta.tags : []),
                ...(isLedger ? [] : [
                    ...(Array.isArray(meta?.ent) ? meta.ent : []),
                    ...(Array.isArray(meta?.entities) ? meta.entities : [])
                ])
            ].map(v => String(v || '').trim()).filter(Boolean)).join('\n');
        };
        const getHybridPayloadEntityRefs = (payload = {}, meta = {}, persistentHybrid = {}) => {
            const ledger = getLedgerProjectionParts(payload);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            return dedupeTextArray([
                ...(isLedger ? [] : [
                    ...hybridArrayFromValue(persistentHybrid?.subjects),
                    ...hybridArrayFromValue(persistentHybrid?.aliases),
                    ...hybridArrayFromValue(meta?.ent),
                    ...hybridArrayFromValue(meta?.entities),
                    ...hybridArrayFromValue(payload?.mentionedEntityNames),
                    ...hybridArrayFromValue(payload?.entityRefs)
                ]),
                ...ledger.entities
            ].map(v => String(v || '').trim()).filter(Boolean)).slice(0, 32);
        };
        const getHybridPayloadTagSeeds = (payload = {}, meta = {}, persistentHybrid = {}, retrospectiveClass = '') => {
            const ledger = getLedgerProjectionParts(payload);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            return dedupeTextArray([
                ...(isLedger ? [] : [
                    ...hybridArrayFromValue(persistentHybrid?.tags),
                    ...hybridArrayFromValue(payload?.tags),
                    ...hybridArrayFromValue(meta?.tags),
                    ...hybridArrayFromValue(payload?.arcKey),
                    ...hybridArrayFromValue(payload?.arcRole),
                    ...hybridArrayFromValue(payload?.causalRole)
                ]),
                ...ledger.tags,
                ...CompactMemoryCodec.getRetrospectiveTags(retrospectiveClass)
            ].map(v => String(v || '').trim()).filter(Boolean)).slice(0, 32);
        };
        const classifyRecallBucket = (payload = {}, intent = {}, meta = {}, currentTurn = 0) => {
            const retrospectiveClass = CompactMemoryCodec.normalizeRetrospectiveClass(
                payload?.retrospectiveClass || payload?.hybridRow?.retrospectiveClass || payload?.hme?.retrospectiveClass || meta?.hme?.retrospectiveClass || ''
            );
            if (retrospectiveClass || CompactMemoryCodec.isContinuityOnlyRecallProfile(payload)) return 'retrospective';
            const projectionText = getHybridPayloadProjectionText(payload, meta);
            const arcRole = String(payload.arcRole || '').toLowerCase();
            const causalRole = String(payload.causalRole || '').toLowerCase();
            const arcKey = String(payload.arcKey || '').toLowerCase();
            if (arcRole === 'origin' || causalRole === 'cause' || /setup|origin/.test(arcKey) || /원점|기원|첫\s*만남|시작점|origin|beginning|setup/i.test(projectionText)) return 'origin';
            if (arcRole === 'transition' || causalRole === 'trigger' || /transition|turning/.test(arcKey) || /전환|계기|transition|trigger|turning/i.test(projectionText)) return 'transition';
            if (arcRole === 'aftermath' || causalRole === 'result' || /aftermath|repair|rupture|post_/.test(arcKey)) return 'aftermath';
            const worldSignalProfile = getHybridWorldSignalProfile(payload, meta);
            if (intent.relationship && getLedgerProjectionParts(payload).relation.length > 0) return 'relationship';
            if (intent.worldRule && worldSignalProfile.dedicatedRow) return 'world';
            const turn = Number(payload.turn || meta.t || 0);
            if (Number.isFinite(turn) && currentTurn && Math.max(0, currentTurn - turn) <= 3) return 'current';
            return 'general';
        };
        const calcRecallIntentBonus = (payload = {}, intent = {}, meta = {}, currentTurn = 0) => {
            if (!intent?.any) return 0;
            let bonus = 0;
            const bucket = classifyRecallBucket(payload, intent, meta, currentTurn);
            const ledger = getLedgerProjectionParts(payload);
            const projectionText = getHybridPayloadProjectionText(payload, meta);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            const arcRole = String(payload.arcRole || '').toLowerCase();
            const causalRole = String(payload.causalRole || '').toLowerCase();
            const hasConflict = !isLedger && !!String(payload.primaryConflict || '').trim();
            const hasDelta = ledger.relation.length > 0 || (!isLedger && !!String(payload.relationDelta || '').trim());
            const worldSignalProfile = getHybridWorldSignalProfile(payload, meta);
            if (intent.origin && (bucket === 'origin' || arcRole === 'origin' || causalRole === 'cause')) bonus += 0.18;
            if (intent.transition && (bucket === 'transition' || arcRole === 'transition' || causalRole === 'trigger' || causalRole === 'escalation')) bonus += 0.16;
            if (intent.relationship && (bucket === 'relationship' || hasDelta)) bonus += 0.10;
            if (intent.worldRule && (bucket === 'world' || worldSignalProfile.dedicatedRow)) bonus += 0.10;
            if (intent.aftermath && (bucket === 'aftermath' || causalRole === 'result')) bonus += 0.10;
            if ((intent.origin || intent.transition) && hasConflict) bonus += 0.05;
            if ((intent.relationship || intent.transition) && hasDelta) bonus += 0.05;
            return Math.min(0.32, bonus);
        };
