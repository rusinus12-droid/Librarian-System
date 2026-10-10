    // ══════════════════════════════════════════════════════════════
    // [ENGINE] Tokenizer & Hash
    // ══════════════════════════════════════════════════════════════
    const TokenizerEngine = (() => {
        const simpleHash = (s) => {
            let h = 0;
            for (let i = 0; i < (s || "").length; i++) {
                h = Math.imul(31, h) ^ s.charCodeAt(i) | 0;
            }
            return h;
        };

        const getSafeMapKey = (text) => {
            const t = text || "";
            return `${simpleHash(t)}_${t.slice(0, 8)}_${t.slice(-4)}`;
        };

        const stripKoreanParticleForToken = (value = '') => String(value || '').trim()
            .replace(/(?:에게서|에게|한테서|한테|으로서|으로|로서|로|에서|부터|까지|처럼|보다|마다|라도|이라도|하고|이랑|랑|와|과|은|는|이|가|을|를|도|만|의)$/u, '')
            .trim();

        const tokenize = (t) => {
            const raw = String(t || '');
            try {
                if (typeof KoreanTextCore !== 'undefined' && KoreanTextCore?.tokenize) {
                    return KoreanTextCore.tokenize(raw, 768);
                }
            } catch (_) {}
            const base = raw.toLowerCase()
                .replace(/[^\w가-힣\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 1);
            const expanded = [];
            const seen = new Set();
            const push = (token) => {
                const v = String(token || '').trim();
                if (!v || v.length <= 1 || seen.has(v)) return;
                seen.add(v);
                expanded.push(v);
            };
            for (const token of base) {
                push(token);
                const stripped = stripKoreanParticleForToken(token);
                if (stripped && stripped !== token) push(stripped);
            }
            return expanded;
        };

        const getIndexKey = (text) => {
            const tokens = tokenize(text);
            const textLen = text.length;
            let combined;
            if (tokens.length <= 8) {
                combined = tokens.join("_");
            } else {
                combined = [...tokens.slice(0, 5), ...tokens.slice(-3)].join("_");
            }
            return simpleHash(`${combined}_${textLen}`);
        };

        const estimateTokens = (text, type = 'simple') => {
            if (!text) return 0;
            const cjkCount = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/g) || []).length;
            const nonCjk = text.length - cjkCount;
            const ratio = type === 'gpt4' ? 0.45 : 0.55;
            return Math.ceil(nonCjk * ratio + cjkCount * 1.8) + (text.match(/\s/g) || []).length;
        };

        return { simpleHash, tokenize, getIndexKey, getSafeMapKey, estimateTokens };
    })();

    // ══════════════════════════════════════════════════════════════
    // [ENGINE] RE Companion Strengthened Sparse Jaccard
    // ══════════════════════════════════════════════════════════════
    const DEFAULT_RE_SCORING_PROFILE = 'balanced';
    const DEFAULT_RE_SCORING_WEIGHTS = Object.freeze({
        word: 0.34,
        char: 0.18,
        concept: 0.22,
        lexicalCoverage: 0.12,
        focus: 0.08,
        wordCoverageFactor: 0.72,
        charCoverageFactor: 0.54,
        conceptCoverageFactor: 0.74
    });
    const RE_SCORING_PROFILE_WEIGHTS = Object.freeze({
        default: DEFAULT_RE_SCORING_WEIGHTS,
        balanced: DEFAULT_RE_SCORING_WEIGHTS,
        lexical: Object.freeze({ word: 0.46, char: 0.20, concept: 0.10, lexicalCoverage: 0.18, focus: 0.06, wordCoverageFactor: 0.66, charCoverageFactor: 0.46, conceptCoverageFactor: 0.58 }),
        strict: Object.freeze({ word: 0.44, char: 0.18, concept: 0.14, lexicalCoverage: 0.18, focus: 0.06, wordCoverageFactor: 0.68, charCoverageFactor: 0.46, conceptCoverageFactor: 0.62 }),
        semantic: Object.freeze({ word: 0.24, char: 0.14, concept: 0.36, lexicalCoverage: 0.08, focus: 0.18, wordCoverageFactor: 0.78, charCoverageFactor: 0.56, conceptCoverageFactor: 0.84 }),
        salience: Object.freeze({ word: 0.28, char: 0.14, concept: 0.22, lexicalCoverage: 0.10, focus: 0.12, wordCoverageFactor: 0.72, charCoverageFactor: 0.52, conceptCoverageFactor: 0.78 }),
        recency: Object.freeze({ word: 0.26, char: 0.14, concept: 0.20, lexicalCoverage: 0.08, focus: 0.10, wordCoverageFactor: 0.70, charCoverageFactor: 0.52, conceptCoverageFactor: 0.76 }),
        entity_focus: Object.freeze({ word: 0.28, char: 0.16, concept: 0.22, lexicalCoverage: 0.10, focus: 0.20, wordCoverageFactor: 0.74, charCoverageFactor: 0.54, conceptCoverageFactor: 0.78 }),
        custom: DEFAULT_RE_SCORING_WEIGHTS
    });
    const clamp01 = (value, fallback = 0) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, Math.min(1, n));
    };
    const uniqLimit = (items = [], limit = 256) => {
        const out = [];
        const seen = new Set();
        for (const item of Array.isArray(items) ? items : []) {
            const v = String(item || '').trim();
            if (!v || seen.has(v)) continue;
            seen.add(v);
            out.push(v);
            if (out.length >= limit) break;
        }
        return out;
    };
    const normalizeREScoringProfile = (value) => {
        const raw = String(value || DEFAULT_RE_SCORING_PROFILE).trim().toLowerCase();
        if (raw === 'default') return 'balanced';
        return RE_SCORING_PROFILE_WEIGHTS[raw] ? raw : DEFAULT_RE_SCORING_PROFILE;
    };
    const normalizeREScoringWeights = (profile = DEFAULT_RE_SCORING_PROFILE, raw = {}) => {
        const preset = RE_SCORING_PROFILE_WEIGHTS[normalizeREScoringProfile(profile)] || DEFAULT_RE_SCORING_WEIGHTS;
        const read = (key) => {
            const n = Number(raw?.[key]);
            return Number.isFinite(n) && n >= 0 ? n : preset[key];
        };
        const weights = {
            word: read('word'),
            char: read('char'),
            concept: read('concept'),
            lexicalCoverage: read('lexicalCoverage'),
            focus: read('focus'),
            wordCoverageFactor: Number(raw?.wordCoverageFactor ?? preset.wordCoverageFactor),
            charCoverageFactor: Number(raw?.charCoverageFactor ?? preset.charCoverageFactor),
            conceptCoverageFactor: Number(raw?.conceptCoverageFactor ?? preset.conceptCoverageFactor)
        };
        const total = weights.word + weights.char + weights.concept + weights.lexicalCoverage + weights.focus;
        if (total > 0) {
            weights.word = Number((weights.word / total).toFixed(4));
            weights.char = Number((weights.char / total).toFixed(4));
            weights.concept = Number((weights.concept / total).toFixed(4));
            weights.lexicalCoverage = Number((weights.lexicalCoverage / total).toFixed(4));
            weights.focus = Number((weights.focus / total).toFixed(4));
        }
        weights.wordCoverageFactor = clamp01(weights.wordCoverageFactor, preset.wordCoverageFactor);
        weights.charCoverageFactor = clamp01(weights.charCoverageFactor, preset.charCoverageFactor);
        weights.conceptCoverageFactor = clamp01(weights.conceptCoverageFactor, preset.conceptCoverageFactor);
        return weights;
    };
    const ANALYSIS_EVIDENCE_MODE_ASSISTANT_ONLY = 'assistant_only';
    const ANALYSIS_EVIDENCE_MODE_USER_AND_ASSISTANT = 'user_and_assistant';
    const normalizeAnalysisEvidenceMode = (value) => {
        const mode = String(value || ANALYSIS_EVIDENCE_MODE_ASSISTANT_ONLY).trim().toLowerCase();
        return mode === ANALYSIS_EVIDENCE_MODE_USER_AND_ASSISTANT
            ? ANALYSIS_EVIDENCE_MODE_USER_AND_ASSISTANT
            : ANALYSIS_EVIDENCE_MODE_ASSISTANT_ONLY;
    };
    const getAnalysisEvidenceMode = (config = {}) => normalizeAnalysisEvidenceMode(config?.analysisEvidenceMode);
    const analysisIncludesUserInput = (config = {}) => getAnalysisEvidenceMode(config) === ANALYSIS_EVIDENCE_MODE_USER_AND_ASSISTANT;
    const getAnalysisEvidenceLabel = (config = {}) => analysisIncludesUserInput(config)
        ? 'Current Turn Evidence'
        : 'Canonical Assistant Evidence';
    const getAnalysisEvidencePolicy = (config = {}) => {
        if (!analysisIncludesUserInput(config)) return LIBRA_CANONICAL_ASSISTANT_EVIDENCE_POLICY;
        return [
            '[Current Turn Evidence Policy]',
            '- Treat the Current User Input and Canonical Assistant Evidence blocks as the current turn evidence.',
            '- User input can support user actions, user speech, directly introduced names, explicit intentions, and scene facts the user controls.',
            '- Assistant evidence can support assistant-controlled outcomes, reactions, state changes, world facts, and narrative progress.',
            '- If the two blocks conflict, preserve non-conflicting user evidence and prefer assistant evidence for assistant-controlled outcomes.'
        ].join('\n');
    };
    const getAnalysisEvidenceSystemOverride = (config = {}) => analysisIncludesUserInput(config)
        ? [
            '[Active Evidence Mode Override]',
            'For this request, Current User Input is factual current-turn evidence, not mere metadata.',
            'Promote facts only when directly supported by a span in Current User Input or Canonical Assistant Evidence.'
        ].join('\n')
        : '';
    const buildCurrentTurnAnalysisEvidence = (userMsg = '', aiResponse = '', config = {}) => {
        const userText = String(userMsg || '').trim();
        const assistantText = String(aiResponse || '').trim();
        const includeUser = analysisIncludesUserInput(config) && !!userText;
        const text = includeUser
            ? [
                `[Current User Input]\n${userText}`,
                `[Canonical Assistant Evidence]\n${assistantText || '(empty)'}`
            ].join('\n\n')
            : assistantText;
        return {
            mode: getAnalysisEvidenceMode(config),
            includeUser,
            label: getAnalysisEvidenceLabel(config),
            policy: getAnalysisEvidencePolicy(config),
            systemOverride: getAnalysisEvidenceSystemOverride(config),
            userText,
            assistantText,
            text: text.trim()
        };
    };
    const buildOptimizedHiddenSettingsDefaults = (options = {}) => {
        const coldStartScopePreset = ['all', 'recent100', 'recent200', 'recent500', 'custom'].includes(String(options.coldStartScopePreset || '').trim())
            ? String(options.coldStartScopePreset).trim()
            : 'all';
        const coldStartHistoryLimit = resolveColdStartHistoryLimit(coldStartScopePreset, Number(options.coldStartHistoryLimit || 0));
        const injectionBudgetMaxTokens = getInjectionBudgetPresetTokens('max');
        const scoringProfile = DEFAULT_RE_SCORING_PROFILE;
        const scoringPreset = RE_SCORING_PROFILE_WEIGHTS[scoringProfile] || DEFAULT_RE_SCORING_WEIGHTS;
        return {
            useLLM: true,
            cbsEnabled: true,
            bypassAuxRequests: true,
            responseStreamingCompatEnabled: true,
            useLorebookRAG: true,
            emotionEnabled: true,
            nsfwGuidancePromptEnabled: true,
            assistantPrefillEnabled: true,
            nsfwMode: 'direct',
            nsfwEnabled: true,
            sectionWorldInferenceEnabled: true,
            secretKnowledgeEnabled: true,
            entityKnowledgeVaultEnabled: true,
            rpLongTermMemoryEnabled: true,
            rpLongTermLlmEnrichment: true,
            rpLongTermInjectionMaxChars: 2600,
            rpLongTermLongTtl: 720,
            rpLongTermMediumTtl: 240,
            characterSourceReflectionEnabled: false,
            personaBindingSyncEnabled: false,
            debug: false,
            // Realtime overlay dashboard is an intentional visible runtime aid.
            // Keep the historic default on; users can still disable it via the
            // activity_dashboard arg or saved common settings.
            activityDashboard: 'compact',
            analysisEvidenceMode: normalizeAnalysisEvidenceMode(options.analysisEvidenceMode),
            backgroundMaintenanceDelayMs: 1500,
            resourceGovernorEnabled: true,
            resourceWorkingSetSoftBytes: 96 * 1024 * 1024,
            resourceWorkingSetHardBytes: 160 * 1024 * 1024,
            resourcePendingQueueSoftBytes: 8 * 1024 * 1024,
            resourcePendingQueueHardBytes: 24 * 1024 * 1024,
            resourceSampleIntervalMs: 2000,
            resourcePressureHoldMs: 3500,
            resourceRecoveryHoldMs: 15000,
            resourceTargetTaskSliceMs: 10,
            resourceNormalMaintenanceConcurrency: 3,
            resourcePressureMaintenanceConcurrency: 2,
            resourceCriticalMaintenanceConcurrency: 1,
            afterRequestMaintenanceMode: DEFAULT_AFTER_REQUEST_MAINTENANCE_MODE,
            afterRequestForegroundTimeoutMs: 45000,
            afterRequestAnalysisBudgetMs: 480000,
            llmPresets: {},
            llmDefaultPreset: 'primary',
            recallDetailCandidateMax: 48,
            memoryPreset: 'custom',
            maxLimit: 360,
            threshold: 2,
            simThreshold: 0.10,
            gcBatchSize: 16,
            coldStartScopePreset,
            coldStartHistoryLimit,
            injectionBudgetPreset: 'max',
            injectionBudgetMaxTokens,
            injectionBudgetTokens: injectionBudgetMaxTokens,
            injectionUnknownHostCapTokens: 4000,
            weightMode: 'auto',
            weights: resolveWeightsForMode('auto', null),
            scoringProfile,
            scoringWeights: normalizeREScoringWeights(scoringProfile, scoringPreset),
            worldAdjustmentMode: 'dynamic',
            recallEvidenceGate: 'soft',
            recallAnchorBonus: 0.12,
            recallSentenceWindowEnabled: true,
            recallSentenceWindowChars: 260,
            recallInjectionMaxTokens: 1800,
            recallScoringTextMaxChars: 800,
            recallScoringV2Enabled: true,
            recallDomainGuardEnabled: true,
            hybridMemoryEngineEnabled: true,
            hybridReadPathEnabled: true,
            hybridReadPathMaxRows: 48,
            hybridWritePathEnabled: true,
            hybridDuplicateFastEnabled: true,
            hybridDuplicateMaxHeavy: 12,
            hybridScopeIndexEnabled: true,
            hmeAssociativeGraphMode: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode,
            hmeGraphMaxSeeds: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxSeeds,
            hmeGraphMaxCandidates: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxCandidates,
            hmeGraphMaxAdditions: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxAdditions,
            hmeGraphMaxNodes: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxNodes,
            hmeGraphMaxEdges: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxEdges,
            hmeGraphMaxHops: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxHops,
            hmeGraphBonusCap: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphBonusCap,
            hmeGraphMinRecallCandidates: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMinRecallCandidates,
            hmeGraphDebug: 'off',
            dualRecallMode: 'dual',
            dualRecallHeuristicDepth: 32,
            dualRecallSemanticDepth: 32,
            dualRecallRrfK: 60,
            dualRecallQueryBudgetMs: 1500,
            dualRecallPolicyVersion: '',
            libraInjectionMode: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraInjectionMode,
            libraProjectionAlwaysActive: false,
            libraProjectionMaxChars: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionMaxChars,
            libraProjectionRecallBundle: LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionRecallBundle
        };
    };
    const KoreanTextCore = (() => {
        const normalizeSpacing = (value = '') => String(value || '')
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        const hangulNgrams = (value = '', min = 2, max = 3, limit = 256) => {
            const source = String(value || '').replace(/[^가-힣]+/g, ' ');
            const grams = [];
            const seen = new Set();
            for (const word of source.split(/\s+/).filter(Boolean)) {
                const chars = Array.from(word);
                for (let size = min; size <= max; size += 1) {
                    if (chars.length < size) continue;
                    for (let i = 0; i <= chars.length - size; i += 1) {
                        const gram = chars.slice(i, i + size).join('');
                        if (seen.has(gram)) continue;
                        seen.add(gram);
                        grams.push(gram);
                        if (grams.length >= limit) return grams;
                    }
                }
            }
            return grams;
        };
        const stripParticles = (token = '') => String(token || '').trim()
            .replace(/(?:에게서|에게|한테서|한테|으로서|으로|로서|로|에서|부터|까지|처럼|보다|마다|라도|이라도|하고|이랑|랑|와|과|은|는|이|가|을|를|도|만|의)$/u, '')
            .trim();
        const wordTokens = (value = '', limit = 512) => {
            const base = String(value || '')
                .toLowerCase()
                .replace(/[^\p{L}\p{N}_가-힣ぁ-んァ-ヶ一-龯]+/gu, ' ')
                .split(/\s+/)
                .filter(token => token.length >= 2);
            const expanded = [];
            for (const token of base) {
                expanded.push(token);
                const stripped = stripParticles(token);
                if (stripped && stripped.length >= 2 && stripped !== token) expanded.push(stripped);
            }
            return uniqLimit(expanded, limit);
        };
        const tokenize = (value = '', limit = 768) => uniqLimit([
            ...wordTokens(value, limit),
            ...hangulNgrams(value, 2, 3, Math.floor(limit / 2))
        ], limit);
        // hangulNgrams 를 노출한다: 소비자가 tokens 안에서 n-gram 과 어절을 구분해야
        // 한다 (게이트가 이름 조각 일치에 반응하면 다른 인물을 오인한다).
        return Object.freeze({ normalizeSpacing, tokenize, hangulNgrams, stripParticles, wordTokens });
    })();
    const StrengthenedJaccardCore = (() => {
        const ENGINE = 'libra_strengthened_jaccard_v1_re_companion_compat';
        const NORMALIZE_TOKEN_CACHE_LIMIT = 16384;
        const normalizeTokenCache = new Map();
        const rememberNormalizedToken = (key, value) => {
            normalizeTokenCache.set(key, value);
            if (normalizeTokenCache.size > ResourceGovernor.getCacheEntryLimit('normalize-token', NORMALIZE_TOKEN_CACHE_LIMIT)) {
                let removed = 0;
                for (const cachedKey of normalizeTokenCache.keys()) {
                    normalizeTokenCache.delete(cachedKey);
                    removed += 1;
                    if (removed >= 1024) break;
                }
            }
            return value;
        };
        const normalizeToken = (value = '') => {
            const raw = String(value || '');
            if (normalizeTokenCache.has(raw)) return normalizeTokenCache.get(raw);
            const normalized = KoreanTextCore.normalizeSpacing(raw)
                .toLowerCase()
                .replace(/[^\p{L}\p{N}:._-]+/gu, '')
                .replace(/[_\s]+/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 120);
            return rememberNormalizedToken(raw, normalized);
        };
        const CHAR_NGRAM_CACHE_LIMIT = 4096;
        const charNgramCache = new Map();
        const rememberCharNgrams = (key, grams) => {
            charNgramCache.set(key, grams);
            if (charNgramCache.size > ResourceGovernor.getCacheEntryLimit('char-ngram', CHAR_NGRAM_CACHE_LIMIT)) {
                let removed = 0;
                for (const cachedKey of charNgramCache.keys()) {
                    charNgramCache.delete(cachedKey);
                    removed += 1;
                    if (removed >= 512) break;
                }
            }
            return grams;
        };
        const charNgrams = (value = '', limit = 220) => {
            const cacheKey = `${limit}\0${String(value || '')}`;
            if (charNgramCache.has(cacheKey)) return charNgramCache.get(cacheKey);
            const cleaned = String(value || '')
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const grams = [];
            for (const part of cleaned.split(/\s+/).filter(Boolean)) {
                const chars = Array.from(part);
                if (chars.length < 2) continue;
                const min = chars.length <= 3 ? 2 : 3;
                const max = Math.min(4, chars.length);
                for (let size = min; size <= max; size += 1) {
                    for (let i = 0; i <= chars.length - size; i += 1) grams.push(chars.slice(i, i + size).join(''));
                }
            }
            return rememberCharNgrams(cacheKey, uniqLimit(grams, limit));
        };
        const registryTokens = (value = '') => {
            const body = String(value || '').toLowerCase();
            const registries = {
                'intent:memory': ['기억', '떠올', '회상', 'remember', 'memory', 'recall'],
                'intent:location': ['위치', '장소', '어디', 'where', 'location', 'place'],
                'intent:state': ['상태', '현재', '지금', 'current', 'state', 'status'],
                'intent:secret': ['비밀', '숨김', '드러', 'secret', 'hidden', 'reveal'],
                'relation:trust': ['믿', '신뢰', '의지', 'trust', 'rely'],
                'relation:distrust': ['불신', '의심', '배신', 'distrust', 'suspect', 'betray'],
                'relation:attachment': ['집착', '질투', '붙잡', 'cling', 'attached', 'jealous'],
                'emotion:fear': ['두려', '불안', '떨', 'fear', 'afraid', 'anxious'],
                'emotion:affection': ['애정', '사랑', '위로', 'affection', 'love', 'comfort'],
                'narrative:consequence': ['결과', '여파', '대가', 'consequence', 'aftermath', 'cost'],
                'narrative:unresolved': ['미해결', '아직', '보류', 'unresolved', 'pending'],
                'world:rule': ['규칙', '금지', '허용', 'rule', 'law', 'forbidden'],
                'time:recent': ['방금', '직전', '최근', 'now', 'recent', 'latest']
            };
            const out = [];
            for (const [token, phrases] of Object.entries(registries)) {
                if (phrases.some(phrase => body.includes(phrase))) out.push(token);
            }
            return uniqLimit(out, 80);
        };
        const tokenWeight = token => {
            const raw = String(token || '');
            const key = normalizeToken(raw);
            if (!key) return 0;
            let weight = 1;
            if (/^(?:intent|relation|emotion|narrative|world|time):/i.test(raw)) weight += 0.32;
            if (key.length >= 5) weight += 0.14;
            if (/^[가-힣A-Za-z][가-힣A-Za-z0-9_.:-]{1,32}$/.test(raw) && !/^(?:state|status|current|recent)$/i.test(raw)) weight += 0.08;
            return Math.max(0.7, Math.min(1.75, weight));
        };
        const exactStats = (queryTokens = [], bodyTokens = []) => {
            const left = new Set((queryTokens || []).map(normalizeToken).filter(Boolean));
            const right = new Set((bodyTokens || []).map(normalizeToken).filter(Boolean));
            if (!left.size || !right.size) return { jaccard: 0, coverage: 0, overlap: 0 };
            let overlap = 0;
            left.forEach(token => { if (right.has(token)) overlap += 1; });
            const union = left.size + right.size - overlap;
            return { jaccard: union > 0 ? overlap / union : 0, coverage: overlap / Math.max(1, left.size), overlap };
        };
        const TOKEN_SIM_CACHE_LIMIT = 8192;
        const tokenSimilarityCache = new Map();
        const rememberTokenSimilarity = (key, score) => {
            tokenSimilarityCache.set(key, score);
            if (tokenSimilarityCache.size > ResourceGovernor.getCacheEntryLimit('token-similarity', TOKEN_SIM_CACHE_LIMIT)) {
                let removed = 0;
                for (const cachedKey of tokenSimilarityCache.keys()) {
                    tokenSimilarityCache.delete(cachedKey);
                    removed += 1;
                    if (removed >= 512) break;
                }
            }
            return score;
        };
        const tokenSimilarity = (a = '', b = '') => {
            const left = normalizeToken(a);
            const right = normalizeToken(b);
            if (!left || !right) return 0;
            if (left === right) return 1;
            if ((left.length >= 4 && right.includes(left)) || (right.length >= 4 && left.includes(right))) return 0.82;
            const key = left <= right ? `${left}␟${right}` : `${right}␟${left}`;
            if (tokenSimilarityCache.has(key)) return tokenSimilarityCache.get(key);
            const grams = exactStats(charNgrams(left, 40), charNgrams(right, 40));
            const score = grams.jaccard >= 0.42 ? Math.max(0, Math.min(0.78, grams.jaccard * 0.92)) : 0;
            return rememberTokenSimilarity(key, score);
        };
        const softWeighted = (queryTokens = [], bodyTokens = []) => {
            // V5.2.7 recall freeze guard: the previous 180x260 fuzzy matrix was
            // the hottest live-turn path. Keep exact coverage first and limit fuzzy
            // matching to a smaller unmatched frontier.
            const left = uniqLimit(queryTokens || [], 96);
            const right = uniqLimit(bodyTokens || [], 128);
            if (!left.length || !right.length) return { jaccard: 0, coverage: 0, overlap: 0 };
            let leftWeight = 0, rightWeight = 0, overlapWeight = 0, overlap = 0;
            const used = new Set();
            const rightInfo = right.map((token, index) => ({
                token,
                index,
                norm: normalizeToken(token),
                weight: tokenWeight(token)
            }));
            const rightByNorm = new Map();
            rightInfo.forEach(info => {
                if (!info.norm) return;
                const arr = rightByNorm.get(info.norm) || [];
                arr.push(info);
                rightByNorm.set(info.norm, arr);
                rightWeight += info.weight;
            });
            left.forEach(leftToken => {
                const lw = tokenWeight(leftToken);
                leftWeight += lw;
                const leftNorm = normalizeToken(leftToken);
                let best = { index: -1, sim: 0, weight: 0 };
                const exactMatches = leftNorm ? (rightByNorm.get(leftNorm) || []) : [];
                const exact = exactMatches.find(info => !used.has(info.index));
                if (exact) {
                    best = { index: exact.index, sim: 1, weight: exact.weight };
                } else {
                    for (const info of rightInfo) {
                        if (used.has(info.index)) continue;
                        const sim = tokenSimilarity(leftToken, info.token);
                        if (sim > best.sim) best = { index: info.index, sim, weight: info.weight };
                    }
                }
                if (best.index >= 0 && best.sim >= 0.58) {
                    used.add(best.index);
                    overlap += 1;
                    overlapWeight += Math.min(lw, best.weight) * best.sim;
                }
            });
            const unionWeight = leftWeight + rightWeight - overlapWeight;
            return { jaccard: unionWeight > 0 ? overlapWeight / unionWeight : 0, coverage: leftWeight > 0 ? overlapWeight / leftWeight : 0, overlap };
        };
        const signature = (value = '', limit = 220) => {
            const body = KoreanTextCore.normalizeSpacing(value);
            const tokens = KoreanTextCore.tokenize(body, limit);
            // tokens 는 [어절, 조사제거형, 2gram, 3gram...] 이 섞인 목록이다.
            // n-gram 은 이름 일부만 겹쳐도(아리엘/아리수 → '아리') 겹침으로 세어져
            // 다른 인물을 같은 인물로 오인하게 만든다. 게이트·보너스 판정에는
            // 어절만 쓰고, n-gram 은 char 계열 점수에만 기여시킨다.
            // 분류는 '문자열이 n-gram 집합에 있나' 가 아니라 '어느 생성기에서 나왔나' 로 한다.
            // 문자열 비교로 하면 1~3자 어절('아리엘','도현')은 자기 자신이 n-gram 이기도 해서
            // 전부 n-gram 으로 분류되고 words 가 비어버린다 (동일 문자열이 gate=false 가 됨).
            const wordOnly = KoreanTextCore.wordTokens ? KoreanTextCore.wordTokens(body, limit) : tokens.slice();
            const grams = KoreanTextCore.hangulNgrams ? KoreanTextCore.hangulNgrams(body, 2, 3, Math.floor(limit / 2)) : [];
            const wordSet = new Set(wordOnly);
            const ngramsOnly = grams.filter(gram => !wordSet.has(gram));
            return {
                raw: body,
                tokens,
                words: wordOnly,
                ngrams: ngramsOnly,
                chars: charNgrams(body, limit),
                concepts: registryTokens(body)
            };
        };
        const normalizeComparable = (value = '') => KoreanTextCore.normalizeSpacing(value).toLowerCase();
        const includesLoose = (haystack = '', needle = '') => {
            const n = normalizeComparable(needle);
            if (!n || n.length < 2) return false;
            return normalizeComparable(haystack).includes(n);
        };
        const extractQuotedPhrases = (value = '', limit = 6) => {
            const src = String(value || '');
            const out = [];
            const seen = new Set();
            const patterns = [
                /["“”']([^"“”']{2,80})["“”']/g,
                /[‘’]([^‘’]{2,80})[‘’]/g,
                /[「『《〈]([^」』》〉]{2,80})[」』》〉]/g
            ];
            for (const re of patterns) {
                let m;
                while ((m = re.exec(src)) && out.length < limit) {
                    const phrase = KoreanTextCore.normalizeSpacing(m[1] || '').slice(0, 80);
                    const key = normalizeComparable(phrase);
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    out.push(phrase);
                }
            }
            return out;
        };
        const extractNumbers = (value = '', limit = 10) => uniqLimit(
            String(value || '').match(/(?:\b|[^\p{L}\p{N}])([+-]?\d+(?:\.\d+)?(?:\s?(?:년|월|일|시|분|초|층|번|개|명|살|km|m|cm|kg|%))?)/giu)?.map(v => String(v || '').replace(/^[^\p{L}\p{N}+-]+/u, '').trim()).filter(Boolean) || [],
            limit
        );
        const extractHardTokens = (value = '', limit = 32) => uniqLimit(
            String(value || '')
                .match(/[A-Z][A-Za-z0-9_.-]{1,31}|[가-힣]{2,12}|[ぁ-んァ-ヶ一-龯]{2,12}/g)?.map(v => String(v || '').trim()).filter(Boolean) || [],
            limit
        );
        const extractFocusNames = (meta = {}, options = {}) => uniqLimit([
            ...(Array.isArray(options.focusNames) ? options.focusNames : []),
            ...(Array.isArray(meta?.ent) ? meta.ent : []),
            ...(Array.isArray(meta?.entities) ? meta.entities : []),
            ...(Array.isArray(meta?.names) ? meta.names : []),
            ...(Array.isArray(meta?.recallHints?.names) ? meta.recallHints.names : []),
            ...(Array.isArray(meta?.recallHints?.tokens) ? meta.recallHints.tokens : [])
        ].map(v => String(v || '').trim()).filter(v => v.length >= 2), 24);
        const isContinuationQuery = (query = '') => /(계속|이어|이어서|방금|아까|직전|최근|그거|그 장면|다음|continue|continued|last|previous|just now|go on|carry on|what happened)/i.test(String(query || ''));
        const buildRecallHints = (value = '', options = {}) => {
            const tokens = extractHardTokens(value, 28)
                .filter(token => token.length >= 2 && !/^(그것|이것|저것|그리고|하지만|그러나|because|after|before)$/i.test(token))
                .slice(0, Math.max(0, Number(options.maxTokens || 10)));
            return {
                v: 1,
                tokens: uniqLimit(tokens, Number(options.maxTokens || 10)),
                numbers: extractNumbers(value, Number(options.maxNumbers || 4)),
                quotes: extractQuotedPhrases(value, Number(options.maxQuotes || 2))
            };
        };
        const evaluateEvidence = (query = '', body = '', options = {}, base = {}) => {
            const meta = options.meta || {};
            const queryQuotes = extractQuotedPhrases(query, 4);
            const bodyQuotes = extractQuotedPhrases(body, 6).concat(Array.isArray(meta?.recallHints?.quotes) ? meta.recallHints.quotes : []);
            const quoteHits = queryQuotes.filter(q => includesLoose(body, q) || bodyQuotes.some(b => includesLoose(b, q) || includesLoose(q, b))).slice(0, 4);
            const queryNumbers = extractNumbers(query, 8);
            const bodyNumbers = extractNumbers(body, 12).concat(Array.isArray(meta?.recallHints?.numbers) ? meta.recallHints.numbers : []);
            const bodyNumberSet = new Set(bodyNumbers.map(v => normalizeToken(v)).filter(Boolean));
            const numberHits = queryNumbers.filter(n => bodyNumberSet.has(normalizeToken(n))).slice(0, 6);
            const focusNames = extractFocusNames(meta, options);
            const hardNames = extractHardTokens(query, 24).filter(token => focusNames.some(name => normalizeComparable(name) === normalizeComparable(token)));
            const namePool = uniqLimit([...focusNames, ...hardNames], 28);
            const nameHits = namePool.filter(name => includesLoose(query, name) && includesLoose(body, name)).slice(0, 6);
            const currentTurn = Number(options.currentTurn || 0);
            const memoryTurn = Number(meta?.turnAnchorTurn ?? meta?.turnAnchor ?? meta?.finalizedTurn ?? meta?.lockedTurn ?? meta?.t ?? 0);
            const turnDelta = Number.isFinite(currentTurn) && Number.isFinite(memoryTurn) && currentTurn > 0 && memoryTurn > 0
                ? Math.max(0, currentTurn - memoryTurn)
                : Infinity;
            const continuationRecent = isContinuationQuery(query) && turnDelta <= 3;
            // 어절 기준 증거만 인정한다. n-gram(이름 조각) 겹침은 증거가 아니다:
            // '아리엘'/'아리수' 는 '아리' 하나만 겹치는데 기존 규칙으로는
            // coverage 0.33 으로 lexical/token 증거를 모두 통과해 보너스 0.07 을 받았다.
            const wordOverlap = Number(base.wordOverlap || 0);
            const wordCoverage = Number(base.wordCoverage || 0);
            const lexicalEvidence = wordOverlap >= 1 && wordCoverage >= 0.18;
            const tokenEvidence = wordOverlap >= 2 || wordCoverage >= 0.34;
            const conceptEvidence = Number(base.conceptJaccard || 0) >= 0.14;
            const reasons = [];
            if (quoteHits.length) reasons.push(`quote:${quoteHits.length}`);
            if (nameHits.length) reasons.push(`name:${nameHits.slice(0, 3).join(',')}`);
            if (numberHits.length) reasons.push(`number:${numberHits.slice(0, 3).join(',')}`);
            if (lexicalEvidence) reasons.push('lexical');
            if (tokenEvidence) reasons.push('token');
            if (conceptEvidence) reasons.push('concept');
            if (continuationRecent) reasons.push(`recent:T-${turnDelta}`);
            const hardEvidence = quoteHits.length > 0 || nameHits.length > 0 || numberHits.length > 0 || continuationRecent;
            // base.score 단독 통과는 금지한다: 점수에는 n-gram(char) 기여가 섞여 있어
            // '도현'/'도현욱' 처럼 이름 접두사만 같은 쌍이 0.53 까지 오른다.
            // 어절 근거(wordOverlap)가 최소 1개는 있어야 게이트를 연다.
            const wordFloor = wordOverlap >= 1;
            const passesGate = Boolean(
                hardEvidence
                || (wordFloor && (lexicalEvidence || tokenEvidence || conceptEvidence))
                || (wordFloor && Number(base.score || 0) >= 0.32)
            );
            const rawBonus =
                Math.min(0.16, quoteHits.length * 0.08)
                + Math.min(0.12, nameHits.length * 0.055)
                + Math.min(0.07, numberHits.length * 0.035)
                + (lexicalEvidence ? 0.035 : 0)
                + (tokenEvidence ? 0.035 : 0)
                + (conceptEvidence ? 0.025 : 0)
                + (continuationRecent ? 0.13 : 0);
            const maxBonus = Number.isFinite(Number(options.anchorBonusLimit)) ? Number(options.anchorBonusLimit) : 0.14;
            return {
                passesGate,
                reasons: uniqLimit(reasons, 8),
                quoteHits,
                nameHits,
                numberHits,
                continuationRecent,
                turnDelta: Number.isFinite(turnDelta) ? turnDelta : null,
                anchorBonus: Math.max(0, Math.min(Math.max(0, maxBonus), rawBonus)),
                scoreFloor: continuationRecent ? 0.30 : 0
            };
        };
        const splitSentences = (value = '', limit = 80) => {
            const src = KoreanTextCore.normalizeSpacing(value);
            if (!src) return [];
            const normalized = src.replace(/([.!?。！？])\s+/g, '$1\n').replace(/\n+/g, '\n');
            const raw = normalized.split(/\n|(?<=[.!?。！？])\s+/u).map(v => v.trim()).filter(Boolean);
            if (raw.length <= 1) {
                return src.match(/.{1,180}(?:\s+|$)/g)?.map(v => v.trim()).filter(Boolean).slice(0, limit) || [src.slice(0, 180)];
            }
            return raw.slice(0, limit);
        };
        const selectBestWindow = (query = '', body = '', options = {}) => {
            const maxChars = Math.max(80, Math.min(800, Number(options.maxChars || 260)));
            const source = KoreanTextCore.normalizeSpacing(body);
            if (!source || source.length <= maxChars) return source;
            const sentences = splitSentences(source, 80);
            if (!sentences.length) return source.slice(0, maxChars).trim();
            const qSig = signature(query, 180);
            let bestIndex = 0;
            let bestScore = -1;
            sentences.forEach((sentence, index) => {
                const d = score(query, sentence, { ...options, querySignature: qSig, includeWindow: false });
                const scoreValue = Number(d?.score || 0) + (index >= sentences.length - 3 ? 0.015 : 0);
                if (scoreValue > bestScore) {
                    bestScore = scoreValue;
                    bestIndex = index;
                }
            });
            const radius = Math.max(0, Math.min(2, Number(options.radius ?? 1)));
            let start = Math.max(0, bestIndex - radius);
            let end = Math.min(sentences.length, bestIndex + radius + 1);
            let windowText = sentences.slice(start, end).join(' ').trim();
            while (windowText.length > maxChars && end - start > 1) {
                if (bestIndex - start > end - bestIndex - 1) start += 1;
                else end -= 1;
                windowText = sentences.slice(start, end).join(' ').trim();
            }
            if (windowText.length > maxChars) windowText = `${windowText.slice(0, maxChars).trim()}...`;
            return windowText || source.slice(0, maxChars).trim();
        };
        const score = (query = '', body = '', options = {}) => {
            const q = options.querySignature || signature(query, 180);
            const b = signature(body, 260);
            const lexical = exactStats(q.tokens, b.tokens);
            const word = softWeighted(q.tokens, b.tokens);
            // 게이트 판정용: n-gram 을 제외한 순수 어절 통계.
            // n-gram 을 섞으면 '아리엘'/'아리수' 처럼 이름 일부만 겹치는 쌍이
            // coverage 0.33 을 얻어 evidence gate 를 통과한다 (실측 462/462 통과).
            const exactWords = exactStats(q.words || [], b.words || []);
            // Character n-grams and concept registry labels are already normalized
            // matching features; exact set overlap avoids quadratic fuzzy re-scoring.
            const chars = exactStats(q.chars, b.chars);
            const concepts = exactStats(q.concepts, b.concepts);
            const focusNames = extractFocusNames(options.meta || {}, options);
            const focus = focusNames.some(name => name && String(body || '').includes(name)) ? 0.22 : 0;
            const weights = options.weights || DEFAULT_RE_SCORING_WEIGHTS;
            const baseScore = clamp01(
                Math.max(word.jaccard, word.coverage * weights.wordCoverageFactor, lexical.jaccard) * weights.word
                + Math.max(chars.jaccard, chars.coverage * weights.charCoverageFactor) * weights.char
                + Math.max(concepts.jaccard, concepts.coverage * weights.conceptCoverageFactor) * weights.concept
                + lexical.coverage * weights.lexicalCoverage
                + focus * weights.focus,
                0
            );
            const evidence = evaluateEvidence(query, body, options, {
                score: baseScore,
                coverage: lexical.coverage,
                overlap: lexical.overlap,
                // 어절 기준 (n-gram 제외) — 게이트가 이름 조각 일치에 반응하지 않게.
                wordOverlap: exactWords.overlap,
                wordCoverage: exactWords.coverage,
                wordJaccard: exactWords.jaccard,
                rawWordOverlap: word.overlap,
                rawWordCoverage: word.coverage,
                conceptJaccard: concepts.jaccard
            });
            const scoreValue = clamp01(Math.max(baseScore + evidence.anchorBonus, evidence.scoreFloor), 0);
            const bestWindow = options.includeWindow ? selectBestWindow(query, body, options) : '';
            return {
                engine: ENGINE,
                score: scoreValue,
                baseScore,
                lexical: lexical.jaccard,
                coverage: lexical.coverage,
                wordJaccard: word.jaccard,
                wordOnlyJaccard: exactWords.jaccard,
                wordOnlyOverlap: exactWords.overlap,
                wordOnlyCoverage: exactWords.coverage,
                charJaccard: chars.jaccard,
                conceptJaccard: concepts.jaccard,
                focus,
                overlap: lexical.overlap,
                wordOverlap: word.overlap,
                anchorBonus: evidence.anchorBonus,
                evidenceGate: evidence.passesGate,
                evidenceReasons: evidence.reasons,
                evidence: {
                    quoteHits: evidence.quoteHits,
                    nameHits: evidence.nameHits,
                    numberHits: evidence.numberHits,
                    continuationRecent: evidence.continuationRecent,
                    turnDelta: evidence.turnDelta
                },
                bestWindow
            };
        };
        return Object.freeze({ ENGINE, signature, score, buildRecallHints, selectBestWindow });
    })();

    // ══════════════════════════════════════════════════════════════
    // [ENGINE] Embedding Queue
    // ══════════════════════════════════════════════════════════════
    const EmbeddingQueue = (() => {
        const q = [];
        const MAX_CONCURRENT = 2;
        let active = 0;

        const run = () => {
            while (q.length > 0 && active < MAX_CONCURRENT) {
                active++;
                const { task, resolve, reject } = q.shift();
                task().then(resolve, reject).finally(() => {
                    active--;
                    run();
                });
            }
        };

        return {
            enqueue: (task) => new Promise((res, rej) => {
                q.push({ task, resolve: res, reject: rej });
                run();
            }),
            get queueLength() { return q.length; },
            get activeCount() { return active; }
        };
    })();

    // ══════════════════════════════════════════════════════════════
    // [ENGINE] Emotion Analyzer
    // ══════════════════════════════════════════════════════════════
    const EmotionEngine = (() => {
        const NEGATION_WORDS_KO = ['않', '안 ', '안하', '안 해', '못', '없', '아니', '별로', '전혀', '절대'];
        const NEGATION_WORDS_EN = ['not', 'no', 'never', 'neither', 'hardly', 'barely', 'cannot', "can't", "don't", "doesn't", "didn't", "won't", "isn't", "aren't"];
        const NEGATION_WORDS_JA = ['ない', 'じゃない', 'ではない', 'ません', 'ぬ', 'ず', 'なかった', '嫌いじゃない'];
        const NEGATION_WINDOW = 10;
        const DOMINANT_PRIORITY = ['affection', 'joy', 'sadness', 'fear', 'surprise', 'anger', 'disgust'];
        const CONTRAST_MARKERS_KO = ['지만', '는데', '그러나', '하지만', '근데', '다만'];
        const CONTRAST_MARKERS_EN = ['but', 'however', 'though', 'although', 'yet', 'still'];
        const CONTRAST_MARKERS_JA = ['けど', 'けれど', 'しかし', 'でも', 'ただ'];

        const hasNegationNearby = (text, matchIndex) => {
            const start = Math.max(0, matchIndex - NEGATION_WINDOW);
            const end = Math.min(text.length, matchIndex + NEGATION_WINDOW);
            const context = text.slice(start, end);
            if (NEGATION_WORDS_KO.some(neg => context.includes(neg))) return true;
            if (NEGATION_WORDS_JA.some(neg => context.includes(neg))) return true;
            return NEGATION_WORDS_EN.some((neg) => {
                const escaped = neg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`\\b${escaped}\\b`, 'i').test(context);
            });
        };
        const findLatestContrastIndex = (text, matchIndex) => {
            const left = String(text || '').slice(0, Math.max(0, matchIndex));
            const markers = [...CONTRAST_MARKERS_KO, ...CONTRAST_MARKERS_EN, ...CONTRAST_MARKERS_JA];
            let latest = -1;
            for (const marker of markers) {
                const idx = left.lastIndexOf(marker);
                if (idx > latest) latest = idx;
            }
            return latest;
        };
        const applyContrastWeight = (text, matchIndex) => {
            const contrastIdx = findLatestContrastIndex(text, matchIndex);
            if (contrastIdx < 0) return 1;
            const distance = matchIndex - contrastIdx;
            if (distance <= 16) return 1.2;
            if (distance <= 36) return 1.1;
            return 1;
        };

        const analyze = (text) => {
            const lowerText = (text || "").toLowerCase();
            let score = 0;
            const emotions = { affection: 0, joy: 0, sadness: 0, anger: 0, fear: 0, surprise: 0, disgust: 0 };

            const keywords = {
                affection: ['애틋', '애절', '다정', '다정하', '따뜻', '포근', '소중', '아끼', '그리워', '보고 싶', '보고싶', '안아', '껴안', '손잡', '입맞', '키스', '사랑', '좋아하', '설레', '두근', '떨리', '애정', '위로', '보듬', '애증', '집착', '애달프', '애틋함', '애간장', '애잔', '울컥', '애써 웃', 'tender', 'affection', 'affectionate', 'longing', 'yearning', 'cherish', 'gentle', 'care for', 'caring', 'miss you', 'hold hands', 'hug', 'embrace', 'love', 'fond', 'obsess', 'obsession', 'achingly', 'yearn', 'pining', 'heart flutter', '切な', '愛し', '恋し', '会いた', '抱きし', '手を握', '優し', '大切', 'ぬくも', '恋'],
                joy: ['기쁘', '행복', '좋아', '웃', '미소', '즐거', '후련', '통쾌', '벅차', '안도', 'happy', 'joy', 'glad', 'smile', 'laugh', 'delighted', 'relieved', 'thrilled', 'uplifted', '嬉し', '幸せ', '好き', '笑', '楽しい', '喜び'],
                sadness: ['슬프', '우울', '눈물', '울', '먹먹', '허전', '허망', '쓸쓸', '비참', 'sad', 'depressed', 'tears', 'cry', 'miss', 'empty', 'hollow', 'heartbroken', 'grief', 'melancholy', '悲し', 'つら', '辛い', '涙', '泣', '寂し'],
                anger: ['화나', '분노', '짜증', '열받', '살기', '격분', '분개', '울분', 'angry', 'furious', 'rage', 'annoyed', 'irritated', 'livid', 'resentful', 'wrath', '怒', '腹立', '苛立', 'むかつ', 'イライラ'],
                fear: ['무서', '두려', '공포', '불안', '서늘', '오싹', '철렁', '섬뜩', '겁', 'scared', 'afraid', 'fear', 'anxious', 'terrified', 'uneasy', 'dread', 'chilling', 'ominous', '怖', '恐', '不安', '怯え', '震え'],
                surprise: ['놀라', '충격', '깜짝', '경악', '당혹', '멍해', 'surprised', 'shocked', 'astonished', 'startled', 'stunned', 'jaw dropped', 'taken aback', '驚', 'びっくり', '仰天', 'ショック'],
                disgust: ['역겨', '혐오', '싫어', '질색', '토나', '메스껍', '불쾌', 'disgusted', 'hate', 'loathe', 'revolted', 'gross', 'nauseous', 'repulsed', '嫌', '気持ち悪', 'うんざり', '吐き気', '最悪']
            };

            const keywordWeights = {
                affection: 1.2,
                joy: 1.0,
                sadness: 1.0,
                anger: 0.9,
                fear: 1.0,
                surprise: 0.9,
                disgust: 1.0
            };

            for (const [emotion, words] of Object.entries(keywords)) {
                for (const word of words) {
                    let idx = lowerText.indexOf(word);
                    while (idx !== -1) {
                        if (!hasNegationNearby(lowerText, idx)) {
                            const appliedWeight = (keywordWeights[emotion] || 1) * applyContrastWeight(lowerText, idx);
                            emotions[emotion] += appliedWeight;
                            score += appliedWeight;
                        }
                        idx = lowerText.indexOf(word, idx + 1);
                    }
                }
            }

            // 애틋함/그리움이 강한 문맥에서는 분노보다 관계 감정을 우선 반영
            if (emotions.affection > 0) {
                if (emotions.anger > 0 && emotions.affection >= emotions.anger) {
                    emotions.anger = Math.max(0, emotions.anger - (emotions.affection * 0.75));
                }
                emotions.joy += emotions.affection * 0.35;
                emotions.sadness += emotions.affection * 0.25;
            }
            if (emotions.fear > 0 && emotions.anger > 0) {
                emotions.surprise += Math.min(emotions.fear, emotions.anger) * 0.18;
            }
            if (emotions.sadness > 0 && emotions.affection > 0) {
                emotions.affection += emotions.sadness * 0.12;
            }

            const dominant = Object.entries(emotions)
                .filter(([, s]) => s > 0)
                .sort((a, b) => {
                    if (b[1] !== a[1]) return b[1] - a[1];
                    return DOMINANT_PRIORITY.indexOf(a[0]) - DOMINANT_PRIORITY.indexOf(b[0]);
                })[0];
            const sortedScores = Object.values(emotions).filter(v => v > 0).sort((a, b) => b - a);
            const diversityBonus = sortedScores.length >= 2 ? Math.min(0.15, (sortedScores[1] / Math.max(sortedScores[0], 0.001)) * 0.15) : 0;
            return {
                scores: emotions,
                dominant: dominant ? dominant[0] : 'neutral',
                intensity: Math.min(1, (score / 5) + diversityBonus)
            };
        };

        const formatSummary = (result, threshold = 0.35) => {
            if (!result || result.dominant === 'neutral' || (result.intensity || 0) < threshold) return '';
            return `Emotion: ${result.dominant} (${(result.intensity || 0).toFixed(2)})`;
        };

        const boostImportance = (baseImportance, result) => {
            const base = Math.max(1, Math.min(10, parseInt(baseImportance, 10) || 5));
            if (!result || result.dominant === 'neutral') return base;
            let bonus = 0;
            if ((result.intensity || 0) >= 0.35) bonus += 1;
            if ((result.intensity || 0) >= 0.65) bonus += 1;
            if (['fear', 'anger', 'surprise', 'sadness', 'affection'].includes(result.dominant)) bonus += 1;
            return Math.max(1, Math.min(10, base + bonus));
        };

        return { analyze, formatSummary, boostImportance, NEGATION_WORDS_KO, NEGATION_WORDS_EN, NEGATION_WORDS_JA };
    })();

    // Emotion-aware importance: the write path calls this instead of reading a base
    // importance directly, so the emotion_enabled arg actually changes stored data.
    const emotionAdjustedImportance = (baseImportance, text) => {
        const base = Math.max(1, Math.min(10, parseInt(baseImportance, 10) || 5));
        try {
            if (MemoryEngine?.CONFIG?.emotionEnabled === false) return base;
            const result = EmotionEngine.analyze(String(text || ''));
            return EmotionEngine.boostImportance(base, result);
        } catch (_) {
            return base;
        }
    };

    // ══════════════════════════════════════════════════════════════
    // [API] LLM Provider
    // ══════════════════════════════════════════════════════════════
    const isProviderProfileConfigured = (cfg = {}) => {
        if (cfg?.portableConnectionPending === true) return false;
        const provider = String(cfg?.provider || 'openai').trim().toLowerCase();
        const modelOk = !!String(cfg?.model || '').trim();
        const keyOk = providerAllowsEmptyKey(provider) || !!String(cfg?.key || '').trim();
        const urlOk = !providerRequiresUrl(provider) || !!String(cfg?.url || '').trim();
        return modelOk && keyOk && urlOk;
    };
    const normalizeLLMPresetName = (profile = '') => {
        const normalized = String(profile || '').trim().toLowerCase();
        if (!normalized || normalized === 'main' || normalized === 'primary') return 'primary';
        if (['aux', 'secondary', 'sub'].includes(normalized)) return 'aux';
        return normalized
            .replace(/[^\p{L}\p{N}_.:-]+/gu, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 48) || '';
    };
    const normalizeLLMPresetTimeout = (value, fallback = 120000) => {
        const n = Math.floor(Number(value));
        const fb = Math.floor(Number(fallback));
        const base = Number.isFinite(n) && n > 0 ? n : (Number.isFinite(fb) && fb > 0 ? fb : 120000);
        return Math.max(5000, Math.min(600000, base));
    };
    const normalizeLLMPresetNumber = (value, fallback = 0) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    };
    const normalizeLLMPresetConfig = (raw = {}, inherited = {}, name = '') => {
        const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const base = source.portableNoInheritance === true || source.portableConnectionPending === true ? {}
            : (inherited && typeof inherited === 'object' && !Array.isArray(inherited) ? inherited : {});
        const provider = String(source.provider || base.provider || 'openai').trim() || 'openai';
        const own = (key) => Object.prototype.hasOwnProperty.call(source, key);
        const model = String((own('model') ? source.model : base.model) ?? '').trim();
        return {
            ...base,
            ...source,
            enabled: source.enabled !== false,
            name: normalizeLLMPresetName(name),
            provider,
            requestFormat: normalizeLLMRequestFormat(source.requestFormat || source.request_format || base.requestFormat || base.request_format || 'chat_completions'),
            url: String((own('url') ? source.url : base.url) ?? '').trim(),
            key: String((own('key') ? source.key : base.key) ?? '').trim(),
            model,
            temp: normalizeLLMPresetNumber(source.temp ?? source.temperature, normalizeLLMPresetNumber(base.temp ?? base.temperature, 0.3)),
            timeout: normalizeLLMPresetTimeout(source.timeout ?? source.timeoutMs ?? source.timeout_ms, base.timeout || 120000),
            serviceTier: FlexTierPolicy.normalizeServiceTier(source.serviceTier || source.service_tier || base.serviceTier || 'off'),
            reasoningPreset: String(source.reasoningPreset || source.reasoning_preset || base.reasoningPreset || 'auto').trim() || 'auto',
            reasoningEffort: String(source.reasoningEffort || source.reasoning_effort || base.reasoningEffort || 'none').trim() || 'none',
            reasoningBudgetTokens: normalizeLLMPresetNumber(source.reasoningBudgetTokens ?? source.reasoning_budget_tokens, normalizeLLMPresetNumber(base.reasoningBudgetTokens, DEFAULT_REASONING_BUDGET_TOKENS)),
            maxCompletionTokens: normalizeLLMPresetNumber(source.maxCompletionTokens ?? source.max_completion_tokens ?? source.max_tokens, normalizeLLMPresetNumber(base.maxCompletionTokens, DEFAULT_MAX_COMPLETION_TOKENS)),
            glmThinkingType: String(source.glmThinkingType || source.glm_thinking_type || source.glmThinking || base.glmThinkingType || 'enabled').trim() || 'enabled',
            stream: source.stream === true || String(source.stream || '').trim().toLowerCase() === 'true'
        };
    };
    // These are compatibility INPUTS only. They never assign an analysis task.
    const RETIRED_ANALYSIS_ROUTE_KEYS = Object.freeze(['llmRouting', 'llmRoutingJson', 'llm_routing_json']);
    const ANALYSIS_PRESET_MAP_ALIASES = Object.freeze(['llmPresetsJson', 'modelPresetsJson', 'providerPresetsJson', 'llm_presets_json', 'model_presets_json', 'provider_presets_json']);
    const ANALYSIS_SELECTION_ALIASES = Object.freeze(['defaultPreset', 'defaultPresetName', 'llm_default_preset', 'default_preset']);
    const isSafeAnalysisProperty = (name) => !['__proto__', 'prototype', 'constructor'].includes(String(name).trim().toLowerCase());
    const cloneAnalysisSettingsValue = (value, seen = new WeakMap()) => {
        if (value == null || typeof value !== 'object') return value;
        if (seen.has(value)) return seen.get(value);
        const copy = Array.isArray(value) ? [] : {};
        seen.set(value, copy);
        for (const [key, item] of Object.entries(value)) {
            if (isSafeAnalysisProperty(key)) copy[key] = cloneAnalysisSettingsValue(item, seen);
        }
        return copy;
    };
    const normalizeAnalysisPresetDefinitions = (presets = {}, primary = {}, aux = {}) => {
        const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const rawSource = object(presets);
        const source = rawSource.presets && typeof rawSource.presets === 'object' && !Array.isArray(rawSource.presets)
            ? rawSource.presets : rawSource;
        const entries = Object.entries(source).filter(([rawName, value]) => (
            String(rawName).trim() && isSafeAnalysisProperty(rawName) && value && typeof value === 'object' && !Array.isArray(value)
        )).map(([rawName, value]) => ({rawName, name: normalizeLLMPresetName(rawName), value}))
            .filter(entry => entry.name && isSafeAnalysisProperty(entry.name));
        const reserved = new Set(entries.map(entry => entry.name));
        const used = new Set();
        const collisions = new Set();
        const out = {};
        // Reserve actual user names before allocating suffixes, so a collision
        // cannot overwrite a different existing name such as example_2.
        for (const entry of entries) {
            let name = entry.name;
            if (used.has(name)) {
                collisions.add(name);
                let ordinal = 2;
                do {
                    const suffix = `_${ordinal++}`;
                    name = entry.name.slice(0, 48 - suffix.length) + suffix;
                } while (used.has(name) || reserved.has(name));
            }
            used.add(name);
            const sourceProfile = cloneAnalysisSettingsValue(entry.value);
            const inherit = normalizeLLMPresetName(sourceProfile.inherit || sourceProfile.extends || sourceProfile.base || '');
            const base = sourceProfile.portableConnectionPending === true ? {} : (entry.name === 'aux' || inherit === 'aux'
                ? {...object(primary), ...object(aux)} : object(primary));
            out[name] = normalizeLLMPresetConfig(sourceProfile, cloneAnalysisSettingsValue(base), name);
        }
        if (!Object.prototype.hasOwnProperty.call(out, 'primary')) {
            out.primary = normalizeLLMPresetConfig(cloneAnalysisSettingsValue(object(primary)), {}, 'primary');
        }
        if (!Object.prototype.hasOwnProperty.call(out, 'aux') && Object.keys(object(aux)).length) {
            out.aux = normalizeLLMPresetConfig(cloneAnalysisSettingsValue(object(aux)), cloneAnalysisSettingsValue(object(primary)), 'aux');
        }
        return {presets: out, collisions};
    };
    const normalizeLLMPresetMap = (presets = {}, primary = {}, aux = {}) => (
        normalizeAnalysisPresetDefinitions(presets, primary, aux).presets
    );
    const normalizeCommonAnalysisSettings = (config = {}, options = {}) => {
        const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
        const own = key => Object.prototype.hasOwnProperty.call(source, key);
        const out = cloneAnalysisSettingsValue(source);
        const notices = [];
        if (RETIRED_ANALYSIS_ROUTE_KEYS.some(own)) notices.push('legacy_routing_retired');
        for (const key of RETIRED_ANALYSIS_ROUTE_KEYS) delete out[key];
        const mapKey = ['llmPresets', ...ANALYSIS_PRESET_MAP_ALIASES].find(own);
        let rawMap = mapKey ? source[mapKey] : {};
        if (typeof rawMap === 'string') {
            try { rawMap = JSON.parse(rawMap); }
            catch (_) { throw new Error('analysis_presets_invalid_json'); }
        }
        const normalized = normalizeAnalysisPresetDefinitions(rawMap, source.llm, source.auxLlm);
        out.llmPresets = normalized.presets;
        const selectionKey = ['llmDefaultPreset', ...ANALYSIS_SELECTION_ALIASES].find(own);
        // An explicitly empty/unknown choice is NOT a request for primary.
        const selectedText = selectionKey ? String(source[selectionKey] ?? '').trim() : 'primary';
        const selected = selectedText ? normalizeLLMPresetName(selectedText) : '';
        out.llmDefaultPreset = selected;
        if (normalized.collisions.size) notices.push('preset_name_collision');
        if (normalized.collisions.has(selected)) out.llmDefaultPreset = '';
        const selectedProfile = Object.prototype.hasOwnProperty.call(out.llmPresets, out.llmDefaultPreset)
            ? out.llmPresets[out.llmDefaultPreset] : null;
        if (!selectedProfile) notices.push('selected_preset_missing');
        else if (selectedProfile.enabled === false) notices.push('selected_preset_disabled');
        for (const key of [...ANALYSIS_PRESET_MAP_ALIASES, ...ANALYSIS_SELECTION_ALIASES]) delete out[key];
        return {config: out, notices};
    };
    const resolveCommonAnalysisPreset = (config = {}) => {
        let normalized;
        try { normalized = normalizeCommonAnalysisSettings(config).config; }
        catch (_) { return {ok: false, presetName: '', profile: null, reason: 'selected_preset_unconfigured'}; }
        const presetName = normalized.llmDefaultPreset;
        const unavailable = reason => ({ok: false, presetName, profile: null, reason});
        if (!normalized.useLLM) return unavailable('analysis_disabled');
        if (!presetName || !Object.prototype.hasOwnProperty.call(normalized.llmPresets, presetName)) return unavailable('selected_preset_missing');
        const profile = normalized.llmPresets[presetName];
        if (profile.enabled === false) return unavailable('selected_preset_disabled');
        if (!isProviderProfileConfigured(profile)) return unavailable('selected_preset_unconfigured');
        return {ok: true, presetName, profile: cloneAnalysisSettingsValue(profile), reason: ''};
    };
    const normalizeLLMRouteMap = (routes = {}) => {
        const source = routes && typeof routes === 'object' && !Array.isArray(routes) ? routes : {};
        const out = {};
        for (const [rawKey, rawValue] of Object.entries(source)) {
            const key = String(rawKey || '').trim();
            if (!key) continue;
            const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
                ? (rawValue.profile || rawValue.preset || rawValue.llmPreset || rawValue.name || '')
                : rawValue;
            if (!String(value || '').trim()) continue;
            const profile = normalizeLLMPresetName(value);
            if (profile) out[key] = profile;
        }
        return out;
    };
    const getLLMProfileConfig = (config, profile = 'primary') => {
        const baseConfig = config || {};
        const primary = baseConfig.llm || {};
        const aux = (baseConfig.auxLlm && baseConfig.auxLlm.enabled) ? baseConfig.auxLlm : {};
        const requestedProfile = normalizeLLMPresetName(profile) || 'primary';
        const presetMap = baseConfig.llmPresets && typeof baseConfig.llmPresets === 'object' && !Array.isArray(baseConfig.llmPresets)
            ? baseConfig.llmPresets
            : {};
        const preset = presetMap[requestedProfile];
        if (preset && typeof preset === 'object' && !Array.isArray(preset) && preset.enabled !== false) {
            const inheritKey = normalizeLLMPresetName(preset.inherit || preset.extends || preset.base || '');
            const inherited = requestedProfile === 'aux' || inheritKey === 'aux'
                ? { ...primary, ...aux, provider: aux.provider || primary.provider, url: aux.url || primary.url, key: aux.key || primary.key, model: aux.model || primary.model }
                : primary;
            const selected = normalizeLLMPresetConfig(preset, inherited, requestedProfile);
            return {
                config: { ...baseConfig, llm: { ...selected } },
                profile: requestedProfile,
                requestedProfile
            };
        }
        const wantsAux = requestedProfile === 'aux';
        const hasAux = wantsAux && isProviderProfileConfigured({ ...primary, ...aux, provider: aux.provider || primary.provider, model: aux.model || primary.model });
        const selected = hasAux
            ? {
                ...primary,
                ...aux,
                provider: aux.provider || primary.provider,
                url: aux.url || primary.url,
                key: aux.key || primary.key,
                model: aux.model || primary.model
            }
            : primary;
        return {
            config: { ...baseConfig, llm: { ...selected } },
            profile: hasAux ? 'aux' : 'primary',
            requestedProfile
        };
    };
    const isLLMProfileConfigured = (config, profile = 'primary') => {
        if (!config?.useLLM) return false;
        const resolved = getLLMProfileConfig(config, profile);
        const requested = normalizeLLMPresetName(profile) || 'primary';
        if (requested !== 'primary' && requested !== 'aux' && resolved?.profile !== requested) return false;
        return isProviderProfileConfigured(resolved?.config?.llm || {});
    };
    const LLMProvider = (() => {
        const PROFILE_FAILURE_THRESHOLD = 2;
        const PROFILE_COOLDOWN_BASE_MS = 30000;
        const PROFILE_COOLDOWN_MAX_MS = 300000;
        const profileHealth = new Map();
        const normalizeEndpoint = (value = '') => {
            const source = String(value || '').trim();
            if (!source) return 'default';
            try {
                const parsed = new URL(source);
                return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase() || 'default';
            } catch (_) {
                return source.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase() || 'default';
            }
        };
        const getProfileIdentity = (config = {}, profile = 'primary') => {
            const requestedProfile = normalizeLLMPresetName(profile) || 'primary';
            const resolved = getLLMProfileConfig(config, requestedProfile);
            const llm = resolved?.config?.llm || {};
            const provider = String(llm.provider || 'openai').trim().toLowerCase() || 'openai';
            const model = String(llm.model || '').trim();
            const endpoint = normalizeEndpoint(llm.url || '');
            return {
                key: `${provider}|${endpoint}|${model.toLowerCase()}`,
                requestedProfile,
                profile: resolved?.profile || requestedProfile,
                provider,
                endpoint,
                model
            };
        };
        const getHealthEntry = (identity, create = false) => {
            if (!identity?.key) return null;
            let entry = profileHealth.get(identity.key) || null;
            if (!entry && create) {
                entry = {
                    key: identity.key,
                    provider: identity.provider,
                    endpoint: identity.endpoint,
                    model: identity.model,
                    profiles: new Set(),
                    successes: 0,
                    failures: 0,
                    consecutiveFailures: 0,
                    circuitOpenCount: 0,
                    openedUntil: 0,
                    lastSuccessAt: 0,
                    lastFailureAt: 0,
                    lastErrorCode: '',
                    lastErrorMessage: ''
                };
                profileHealth.set(identity.key, entry);
            }
            if (entry) entry.profiles.add(identity.requestedProfile || identity.profile || 'primary');
            return entry;
        };
        const classifyProfileFailure = (error) => {
            const code = String(error?.code || error?.name || '').trim().toUpperCase();
            const message = String(error?.message || error || '').trim();
            const combined = `${code} ${message}`.toUpperCase();
            const aborted = code === 'ABORTERROR'
                || code === 'ANALYSIS_DEADLINE'
                || /\bABORT(?:ED)?\b|CANCEL(?:LED|ED|ATION)?|사용자.*취소|분석.*마감/.test(combined);
            if (aborted) return { transient: false, code: code || 'ABORTED', reason: 'cancelled_or_deadline' };
            const statusMatch = combined.match(/(?:API ERROR:|HTTP(?: STATUS)?|STATUS)[^0-9]*([1-5][0-9]{2})/i);
            const status = Math.floor(Number(error?.status || error?.statusCode || statusMatch?.[1] || 0)) || 0;
            const transientStatus = [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
            const transientCode = [
                'TIMEOUT', 'STREAM_TIMEOUT', 'NETWORK_ERROR', 'FETCH_ERROR', 'FETCH_UNAVAILABLE',
                'EMPTY_RESPONSE', 'API_PARSE_ERROR', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
                'ENETUNREACH', 'ETIMEDOUT'
            ].includes(code);
            const transientMessage = /RATE.?LIMIT|TOO MANY REQUESTS|TIMED? ?OUT|TIMEOUT|NETWORK|FETCH FAILED|CONNECTION|ECONN|EAI_AGAIN|ENETUNREACH|EMPTY RESPONSE|RETURNED NO TEXT|SERVICE UNAVAILABLE|BAD GATEWAY|GATEWAY TIMEOUT|INTERNAL SERVER ERROR/.test(combined);
            return {
                transient: transientStatus || transientCode || transientMessage,
                code: code || (status ? `HTTP_${status}` : 'UNKNOWN'),
                status,
                reason: transientStatus ? 'http_status' : (transientCode ? 'error_code' : (transientMessage ? 'error_message' : 'non_transient'))
            };
        };
        const recordProfileSuccess = (config, profile) => {
            const identity = getProfileIdentity(config, profile);
            const entry = getHealthEntry(identity, true);
            entry.successes += 1;
            entry.consecutiveFailures = 0;
            entry.circuitOpenCount = 0;
            entry.openedUntil = 0;
            entry.lastSuccessAt = Date.now();
            entry.lastErrorCode = '';
            entry.lastErrorMessage = '';
            return entry;
        };
        const recordProfileFailure = (config, profile, error) => {
            const classification = classifyProfileFailure(error);
            if (!classification.transient) return { classification, entry: getHealthEntry(getProfileIdentity(config, profile), true) };
            const identity = getProfileIdentity(config, profile);
            const entry = getHealthEntry(identity, true);
            entry.failures += 1;
            entry.consecutiveFailures += 1;
            entry.lastFailureAt = Date.now();
            entry.lastErrorCode = classification.code;
            entry.lastErrorMessage = String(error?.message || error || '').replace(/\s+/g, ' ').trim().slice(0, 180);
            if (entry.consecutiveFailures >= PROFILE_FAILURE_THRESHOLD) {
                entry.circuitOpenCount += 1;
                const exponent = Math.max(0, Math.min(4, entry.circuitOpenCount - 1));
                const cooldownMs = Math.min(PROFILE_COOLDOWN_MAX_MS, PROFILE_COOLDOWN_BASE_MS * (2 ** exponent));
                entry.openedUntil = Math.max(entry.openedUntil, Date.now() + cooldownMs);
            }
            return { classification, entry };
        };
        const isProfileHealthy = (config = {}, profile = 'primary') => {
            if (!isLLMProfileConfigured(config, profile)) return false;
            const entry = getHealthEntry(getProfileIdentity(config, profile), false);
            return !entry || Number(entry.openedUntil || 0) <= Date.now();
        };
        const getProfileHealthSnapshot = () => Array.from(profileHealth.values()).map(entry => ({
            provider: entry.provider,
            endpoint: entry.endpoint,
            model: entry.model,
            profiles: Array.from(entry.profiles),
            healthy: Number(entry.openedUntil || 0) <= Date.now(),
            successes: entry.successes,
            failures: entry.failures,
            consecutiveFailures: entry.consecutiveFailures,
            circuitOpenCount: entry.circuitOpenCount,
            openedUntil: entry.openedUntil,
            cooldownRemainingMs: Math.max(0, Number(entry.openedUntil || 0) - Date.now()),
            lastSuccessAt: entry.lastSuccessAt,
            lastFailureAt: entry.lastFailureAt,
            lastErrorCode: entry.lastErrorCode,
            lastErrorMessage: entry.lastErrorMessage
        }));
        const resetProfileHealth = () => profileHealth.clear();
        const callSingleProfile = async (config, systemPrompt, userContent, options = {}) => {
            const selected = resolveCommonAnalysisPreset(config);
            if (!selected.ok) return { content: null, skipped: true, reason: selected.reason };
            const resolved = { profile: selected.presetName };
            const activeConfig = { ...config, llm: selected.profile };
            const analysisDeadlineAt = Number(options?.deadlineAt || config?.__analysisDeadlineAt || activeConfig?.__analysisDeadlineAt || 0) || 0;
            const remainingAnalysisMs = () => analysisDeadlineAt > 0 ? Math.max(0, analysisDeadlineAt - Date.now()) : Number.POSITIVE_INFINITY;
            const awaitWithinAnalysisDeadline = async (promise, label = 'provider') => {
                if (!Number.isFinite(remainingAnalysisMs())) return await promise;
                const waitMs = Math.max(1, remainingAnalysisMs() - 250);
                if (waitMs <= 1) throw new LIBRAError(`LIBRA analysis deadline reached during ${label}`, 'ANALYSIS_DEADLINE');
                let timer = null;
                const deadline = new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new LIBRAError(`LIBRA analysis deadline reached during ${label}`, 'ANALYSIS_DEADLINE')), waitMs);
                });
                try {
                    return await Promise.race([Promise.resolve(promise), deadline]);
                } finally {
                    if (timer) clearTimeout(timer);
                }
            };
            const invokeProviderWithinDeadline = async (provider, providerConfig, providerSystemPrompt, providerUserContent, providerOptions, label) => {
                const sourceOptions = providerOptions && typeof providerOptions === 'object' ? providerOptions : {};
                const parentSignal = sourceOptions.signal;
                let controller = null;
                let deadlineTimer = null;
                let parentAbort = null;
                if (typeof AbortController === 'function') {
                    controller = new AbortController();
                    parentAbort = () => {
                        try { controller.abort(parentSignal?.reason || new DOMException('Aborted', 'AbortError')); }
                        catch (_) { try { controller.abort(); } catch (_) {} }
                    };
                    if (parentSignal?.aborted) parentAbort();
                    else parentSignal?.addEventListener?.('abort', parentAbort, { once: true });
                    if (Number.isFinite(remainingAnalysisMs())) {
                        const abortInMs = Math.max(1, remainingAnalysisMs() - 250);
                        deadlineTimer = setTimeout(() => {
                            const deadlineError = new LIBRAError(`LIBRA analysis deadline reached during ${label}`, 'ANALYSIS_DEADLINE');
                            try { controller.abort(deadlineError); }
                            catch (_) { try { controller.abort(); } catch (_) {} }
                        }, abortInMs);
                    }
                }
                const llmConfig = providerConfig?.llm || {};
                const configuredRetries = Math.floor(Number(
                    sourceOptions.maxRetries
                    ?? sourceOptions.retryMax
                    ?? llmConfig.maxRetries
                    ?? llmConfig.retryMax
                    ?? 1
                ));
                const retryPolicy = {
                    enabled: sourceOptions.retry !== false && sourceOptions.disableRetry !== true && configuredRetries > 0,
                    maxRetries: Math.max(0, Math.min(2, Number.isFinite(configuredRetries) ? configuredRetries : 1)),
                    minDelayMs: Math.max(100, Math.min(10000, Number(sourceOptions.retryMinDelayMs ?? llmConfig.retryMinDelayMs ?? 600) || 600)),
                    maxDelayMs: Math.max(250, Math.min(30000, Number(sourceOptions.retryMaxDelayMs ?? llmConfig.retryMaxDelayMs ?? 5000) || 5000)),
                    statuses: [429, 502, 503, 504],
                    deadlineAt: analysisDeadlineAt,
                    attemptObserver: typeof sourceOptions.attemptObserver === 'function'
                        ? (phase,detail)=>sourceOptions.attemptObserver(phase,{...detail,provider:String(llmConfig.provider || ''),model:String(llmConfig.model || ''),profile:resolved.profile,invocation:label}) : null
                };
                const effectiveProviderOptions = {
                    ...sourceOptions,
                    deadlineAt: analysisDeadlineAt || sourceOptions.deadlineAt || 0,
                    signal: controller?.signal || parentSignal,
                    retryPolicy
                };
                try {
                    return await awaitWithinAnalysisDeadline(
                        provider.callLLM(providerConfig, providerSystemPrompt, providerUserContent, effectiveProviderOptions),
                        label
                    );
                } catch (error) {
                    const code = String(error?.code || '').toUpperCase();
                    if (sourceOptions.__deadlineLimitedTimeout === true && code === 'TIMEOUT') {
                        throw new LIBRAError(
                            `LIBRA analysis deadline reached during ${label}`,
                            'ANALYSIS_DEADLINE',
                            error
                        );
                    }
                    throw error;
                } finally {
                    if (deadlineTimer) clearTimeout(deadlineTimer);
                    parentSignal?.removeEventListener?.('abort', parentAbort);
                }
            };
            let providerDebugCallId = '';
            if (!activeConfig.useLLM || !isProviderProfileConfigured(activeConfig.llm || {})) {
                try {
                    ActivityDashboardCore?.recordSkippedCall?.('llm', options.debugLabel || options.label || 'not_configured');
                } catch (_) {}
                return { content: null, skipped: true, reason: 'LLM not configured' };
            }

            try {
                if (remainingAnalysisMs() <= 1500) {
                    throw new LIBRAError('LIBRA analysis deadline reached before provider call', 'ANALYSIS_DEADLINE');
                }
                const providerName = activeConfig.llm.provider || 'openai';
                const provider = AutoProvider.get(providerName);
                const debugLabel = options.debugLabel || options.label || `${resolved.profile}-generic`;
                const effectiveSystemPrompt = systemPrompt;
                const effectiveOptions = options;
                const startAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                let flexPolicy = FlexTierPolicy.resolve(activeConfig, { ...effectiveOptions, label: debugLabel, __maintenanceTaskName: FlexTierRuntime.currentLabel?.() || '' }, resolved.profile);
                const requestedProviderTimeout = Math.max(1000, Number(flexPolicy.timeoutMs || activeConfig.llm.timeout || 120000));
                const deadlineTimeoutCeiling = Number.isFinite(remainingAnalysisMs())
                    ? Math.max(1000, remainingAnalysisMs() - 1000)
                    : Number.POSITIVE_INFINITY;
                const deadlineBoundTimeout = Math.min(requestedProviderTimeout, deadlineTimeoutCeiling);
                const providerCallOptions = deadlineBoundTimeout < requestedProviderTimeout
                    ? { ...effectiveOptions, __deadlineLimitedTimeout: true }
                    : effectiveOptions;
                flexPolicy = {
                    ...flexPolicy,
                    timeoutMs: deadlineBoundTimeout,
                    fallbackToStandard: flexPolicy.fallbackToStandard === true && remainingAnalysisMs() > Math.max(8000, deadlineBoundTimeout + 3000)
                };
                activeConfig.__analysisDeadlineAt = analysisDeadlineAt || activeConfig.__analysisDeadlineAt;
                activeConfig.llm = { ...activeConfig.llm, timeout: deadlineBoundTimeout, __flexPolicy: flexPolicy };
                // Recheck consumer-only context after provider admission awaits, before payload diagnostics.
                options.resultProjectionGuard?.();
                providerDebugCallId = DebugExportManager.recordProviderCallStart({
                    profile: resolved.profile,
                    provider: providerName,
                    model: activeConfig.llm.model || '',
                    label: debugLabel,
                    domain: options.domain || options.featureDomain || 'llm',
                    streamRequested: activeConfig.llm.stream === true && providerCallOptions.forceNonStreaming !== true,
                    serviceTier: flexPolicy.serviceTier || '',
                    flexApplied: flexPolicy.flexApplied === true,
                    systemPrompt: effectiveSystemPrompt,
                    userContent
                });
                if (activeConfig.debug) {
                    recordRuntimeDebug('log', 
                        `[LIBRA][LLM] start | label=${debugLabel} | profile=${resolved.profile} | provider=${providerName} | model=${activeConfig.llm.model || ''} | url=${activeConfig.llm.url || ''} | systemChars=${String(effectiveSystemPrompt || '').length} | userChars=${String(userContent || '').length} | serviceTier=${flexPolicy.serviceTier || 'none'} | flex=${flexPolicy.flexApplied ? 'yes' : 'no'}`
                    );
                    recordRuntimeDebug('log', '[LIBRA][Flex] resolved service tier', FlexTierPolicy.publicTrace(flexPolicy));
                }
                try {
                    const result = await invokeProviderWithinDeadline(
                        provider,
                        activeConfig,
                        effectiveSystemPrompt,
                        userContent,
                        providerCallOptions,
                        `${debugLabel}:primary`
                    );
                    if (result && typeof result === 'object') {
                        result.flex = FlexTierPolicy.publicTrace(flexPolicy, { actualServiceTier: result.serviceTier || '' });
                        result.stream = {
                            requested: activeConfig.llm.stream === true && providerCallOptions.forceNonStreaming !== true,
                            used: result.streamed === true,
                            provider: providerName,
                            profile: resolved.profile,
                            meta: result.streamMeta || {}
                        };
                    }
                    const endAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    try {
                        LIBRA_Metrics?.recordLlm?.(debugLabel, Math.max(0, Math.round(endAt - startAt)), true, {
                            profile: resolved.profile,
                            provider: providerName,
                            model: activeConfig.llm.model || '',
                            domain: options.domain || options.featureDomain || 'llm',
                            reason: options.reason || options.label || debugLabel
                        });
                    } catch (_) {}
                    if (activeConfig.debug) {
                        recordRuntimeDebug('log', 
                            `[LIBRA][LLM] success | label=${debugLabel} | profile=${resolved.profile} | provider=${providerName} | duration=${Math.max(0, Math.round(endAt - startAt))}ms | contentChars=${String(result?.content || '').length} | serviceTier=${result?.serviceTier || flexPolicy.serviceTier || 'none'} | stream=${result?.streamed === true ? 'yes' : (activeConfig.llm.stream === true ? 'requested' : 'no')}`
                        );
                    }
                    DebugExportManager.recordProviderCallFinish(providerDebugCallId, {
                        status: 'success',
                        content: DebugExportManager.textDigest(result?.content || ''),
                        usage: result?.usage || {},
                        streamUsed: result?.streamed === true,
                        streamMeta: result?.streamMeta || {},
                        finishReason: result?.finishReason || result?.streamMeta?.finishReason || '',
                        truncated: result?.truncated === true || /^(?:length|max_tokens)$/i.test(String(result?.finishReason || result?.streamMeta?.finishReason || '')),
                        jsonModeRequested: result?.jsonModeRequested === true || providerCallOptions?.jsonMode === true || providerCallOptions?.forceJsonMode === true,
                        jsonModeFallback: result?.jsonModeFallback === true,
                        serviceTier: result?.serviceTier || flexPolicy.serviceTier || ''
                    });
                    try {
                        ActivityDashboardCore?.recordLLM?.(resolved.profile, result?.usage || {}, {
                            label: debugLabel,
                            domain: options.domain || options.featureDomain || 'llm',
                            reason: options.reason || options.label || debugLabel,
                            foreground: options.dashboardForeground
                        });
                    } catch (_) {}
                    return result;
                } catch (firstError) {
                    if (!(flexPolicy.flexApplied && flexPolicy.fallbackToStandard && FlexTierPolicy.isTransientFlexError(firstError))) throw firstError;
                    if (remainingAnalysisMs() <= 3000) {
                        throw new LIBRAError('LIBRA analysis deadline reached before provider fallback', 'ANALYSIS_DEADLINE');
                    }
                    const fallbackPolicy = FlexTierPolicy.withStandardFallback(flexPolicy);
                    const requestedFallbackTimeout = Math.max(1000, Number(fallbackPolicy?.timeoutMs || 120000));
                    const fallbackDeadlineCeiling = Number.isFinite(remainingAnalysisMs())
                        ? Math.max(1000, remainingAnalysisMs() - 1000)
                        : Number.POSITIVE_INFINITY;
                    const fallbackTimeout = Math.min(requestedFallbackTimeout, fallbackDeadlineCeiling);
                    const fallbackCallOptions = fallbackTimeout < requestedFallbackTimeout
                        ? { ...effectiveOptions, __deadlineLimitedTimeout: true }
                        : effectiveOptions;
                    const fallbackConfig = {
                        ...activeConfig,
                        llm: {
                            ...activeConfig.llm,
                            timeout: fallbackTimeout,
                            __flexPolicy: { ...fallbackPolicy, timeoutMs: fallbackTimeout }
                        }
                    };
                    recordRuntimeDebug('warn', '[LIBRA][Flex] Flex request failed; retrying once without Flex.', FlexTierPolicy.publicTrace(flexPolicy, { error: firstError?.message || String(firstError || '') }));
                    const fallbackStartAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    const fallbackResult = await invokeProviderWithinDeadline(
                        provider,
                        fallbackConfig,
                        effectiveSystemPrompt,
                        userContent,
                        fallbackCallOptions,
                        `${debugLabel}:fallback`
                    );
                    const fallbackEndAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    try {
                        LIBRA_Metrics?.recordLlm?.(`${debugLabel} fallback`, Math.max(0, Math.round(fallbackEndAt - fallbackStartAt)), true, {
                            profile: resolved.profile,
                            provider: providerName,
                            model: fallbackConfig.llm?.model || '',
                            domain: options.domain || options.featureDomain || 'llm',
                            reason: options.reason || options.label || debugLabel
                        });
                    } catch (_) {}
                    if (fallbackResult && typeof fallbackResult === 'object') {
                        fallbackResult.flex = FlexTierPolicy.publicTrace(fallbackPolicy, { fallbackFrom: flexPolicy.serviceTier || 'flex', actualServiceTier: fallbackResult.serviceTier || '' });
                        fallbackResult.stream = {
                            requested: activeConfig.llm.stream === true && fallbackCallOptions.forceNonStreaming !== true,
                            used: fallbackResult.streamed === true,
                            provider: providerName,
                            profile: resolved.profile,
                            meta: fallbackResult.streamMeta || {}
                        };
                    }
                    try {
                        ActivityDashboardCore?.recordLLM?.(resolved.profile, fallbackResult?.usage || {}, {
                            label: `${debugLabel} fallback`,
                            domain: options.domain || options.featureDomain || 'llm',
                            reason: options.reason || options.label || debugLabel,
                            foreground: options.dashboardForeground
                        });
                    } catch (_) {}
                    DebugExportManager.recordProviderCallFinish(providerDebugCallId, {
                        status: 'success_fallback_standard',
                        fallbackFrom: flexPolicy.serviceTier || 'flex',
                        firstError: firstError?.message || String(firstError || ''),
                        content: DebugExportManager.textDigest(fallbackResult?.content || ''),
                        usage: fallbackResult?.usage || {},
                        streamUsed: fallbackResult?.streamed === true,
                        streamMeta: fallbackResult?.streamMeta || {},
                        finishReason: fallbackResult?.finishReason || fallbackResult?.streamMeta?.finishReason || '',
                        truncated: fallbackResult?.truncated === true || /^(?:length|max_tokens)$/i.test(String(fallbackResult?.finishReason || fallbackResult?.streamMeta?.finishReason || '')),
                        jsonModeRequested: fallbackResult?.jsonModeRequested === true || fallbackCallOptions?.jsonMode === true || fallbackCallOptions?.forceJsonMode === true,
                        jsonModeFallback: fallbackResult?.jsonModeFallback === true,
                        serviceTier: fallbackResult?.serviceTier || fallbackPolicy.serviceTier || ''
                    });
                    return fallbackResult;
                }
            } catch (e) {
                try {
                    const failEndAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    LIBRA_Metrics?.recordLlm?.(options.debugLabel || options.label || `${resolved.profile}-generic`, Math.max(0, Math.round(failEndAt - (typeof startAt !== 'undefined' ? startAt : failEndAt))), false, {
                        profile: resolved.profile,
                        provider: activeConfig.llm?.provider || 'openai',
                        model: activeConfig.llm?.model || '',
                        domain: options.domain || options.featureDomain || 'llm',
                        reason: options.reason || options.label || 'failed'
                    });
                } catch (_) {}
                try {
                    ActivityDashboardCore?.recordLLM?.(resolved.profile, {}, {
                        label: options.debugLabel || options.label || `${resolved.profile}-generic`,
                        domain: options.domain || options.featureDomain || 'llm',
                        reason: options.reason || options.label || 'failed',
                        foreground: options.dashboardForeground,
                        failed: true
                    });
                } catch (_) {}
                if (activeConfig.debug) {
                    recordRuntimeDebug('warn', 
                        `[LIBRA][LLM] fail | profile=${resolved.profile} | provider=${activeConfig.llm?.provider || 'openai'} | model=${activeConfig.llm?.model || ''} | url=${activeConfig.llm?.url || ''} | error=${e?.message || e}`
                    );
                }
                DebugExportManager.recordProviderCallFinish(providerDebugCallId, {
                    status: 'failed',
                    error: e?.message || String(e || ''),
                    errorName: e?.name || e?.code || ''
                });
                recordRuntimeDebug('error', '[LIBRA] LLM Provider Error:', e?.message || e);
                throw e;
            }
        };

        const call = async (config, systemPrompt, userContent, options = {}) => {
            // Snapshot before the first await: later edits cannot retarget this request.
            // Multi-stage logical jobs must additionally capture once at their own admission.
            const captured = captureWmAnalysisConfig(config);
            const selected = resolveCommonAnalysisPreset(captured);
            if (!selected.ok) {
                try { ActivityDashboardCore?.recordSkippedCall?.('llm', options.debugLabel || options.label || 'not_configured'); } catch (_) {}
                return { content: null, skipped: true, reason: selected.reason };
            }
            const boundOptions = { ...options, profile: selected.presetName };
            delete boundOptions.allowProfileFailover;
            delete boundOptions.__profileFailoverAttempt;
            delete boundOptions.__requestedProfile;
            try {
                const result = await callSingleProfile(captured, systemPrompt, userContent, boundOptions);
                if (!result?.skipped) recordProfileSuccess(captured, selected.presetName);
                return result;
            } catch (error) {
                recordProfileFailure(captured, selected.presetName, error);
                throw error;
            }
        };

        return {
            call,
            isConfigured: (config = {}) => resolveCommonAnalysisPreset(config).ok,
            isProfileHealthy,
            getProfileHealthSnapshot,
            resetProfileHealth
        };
    })();

    const LLMProviderCallTest = (() => {
        const EXPECTED_TOKEN = 'LIBRA_PROVIDER_TEST_OK';
        const TEST_TIMEOUT_MIN_MS = 5000;
        const TEST_TIMEOUT_MAX_MS = 60000;
        const now = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
        const clampTimeout = (value, fallback = 30000) => {
            const n = Number(value || fallback);
            if (!Number.isFinite(n) || n <= 0) return fallback;
            return Math.max(TEST_TIMEOUT_MIN_MS, Math.min(TEST_TIMEOUT_MAX_MS, Math.floor(n)));
        };
        const cleanText = (value, limit = 180) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
        };
        const prepareConfig = (sourceConfig = {}, profile = 'primary') => {
            const cfg = cloneAnalysisSettingsValue(sourceConfig && typeof sourceConfig === 'object' ? sourceConfig : {});
            // Only this explicit connectivity test has its own selection; global pause/selection is untouched.
            cfg.useLLM = true;
            cfg.llmDefaultPreset = String(profile ?? '').trim() ? normalizeLLMPresetName(profile) : '';
            const testConfig = captureWmAnalysisConfig(cfg);
            const selected = resolveCommonAnalysisPreset(testConfig);
            if (selected.ok) {
                const shaped = { ...selected.profile, timeout: clampTimeout(selected.profile.timeout, 30000) };
                testConfig.llmPresets[selected.presetName] = shaped;
                testConfig.llm = cloneAnalysisSettingsValue(shaped);
            }
            testConfig.flexTimeoutMs = TEST_TIMEOUT_MAX_MS;
            return testConfig;
        };
        const describeMissing = (llm = {}) => {
            const provider = String(llm.provider || 'openai').trim().toLowerCase();
            const missing = [];
            if (!String(llm.model || '').trim()) missing.push('model');
            if (!providerAllowsEmptyKey(provider) && !String(llm.key || '').trim()) missing.push('api key');
            if (providerRequiresUrl(provider) && !String(llm.url || '').trim()) missing.push('url');
            return missing;
        };
        const run = async (sourceConfig = {}, profile = 'primary') => {
            const requestedProfile = String(profile ?? '').trim() ? normalizeLLMPresetName(profile) : '';
            const testConfig = prepareConfig(sourceConfig, requestedProfile);
            const selected = resolveCommonAnalysisPreset(testConfig);
            const resolved = { profile: selected.presetName };
            const llm = selected.profile || {};
            const provider = String(llm.provider || 'openai').trim().toLowerCase();
            const model = String(llm.model || '').trim();
            const missing = describeMissing(llm);
            if (!selected.ok) {
                return {
                    ok: false, skipped: true, profile: selected.presetName, requestedProfile,
                    provider, model, reason: selected.reason,
                    error: `LLM 설정을 사용할 수 없습니다: ${selected.reason}`
                };
            }

            const startedAt = now();
            try {
                ActivityDashboardCore?.updateFeatureAnalysis?.({
                    domain: 'provider_test',
                    reason: requestedProfile,
                    status: 'running',
                    detail: `${provider}/${model}`,
                    source: 'llm'
                });
            } catch (_) {}
            try {
                const testMaxTokens = /ollama|glm|kimi|deepseek|gemma|qwen|gpt-oss/i.test(`${provider} ${model}`) ? 256 : 96;
                const result = await LLMProvider.call(
                    testConfig,
                    'You are a connectivity test endpoint. Put exactly LIBRA_PROVIDER_TEST_OK in the final answer. Do not include reasoning, explanations, markdown, or extra words.',
                    'Final answer only: LIBRA_PROVIDER_TEST_OK',
                    {
                        maxTokens: testMaxTokens,
                        profile: requestedProfile,
                        label: `provider-test-${requestedProfile}`,
                        debugLabel: `provider-test-${requestedProfile}`,
                        domain: 'provider_test',
                        reason: requestedProfile,
                        dashboardForeground: false,
                        realtime: true,
                        allowProfileFailover: false
                    }
                );
                const durationMs = Math.max(0, Math.round(now() - startedAt));
                const content = String(result?.content || '').trim();
                const ok = !result?.skipped && content.toUpperCase().includes(EXPECTED_TOKEN);
                const stream = result?.stream || {
                    requested: llm.stream === true,
                    used: result?.streamed === true,
                    provider,
                    profile: resolved?.profile || requestedProfile,
                    meta: result?.streamMeta || {}
                };
                try {
                    ActivityDashboardCore?.updateFeatureAnalysis?.({
                        domain: 'provider_test',
                        reason: requestedProfile,
                        status: ok ? 'done' : 'failed',
                        detail: ok ? `${provider}/${model} ${durationMs}ms` : cleanText(content || result?.reason || 'unexpected response', 120),
                        source: 'llm'
                    });
                } catch (_) {}
                return {
                    ok,
                    skipped: result?.skipped === true,
                    profile: stream.profile || resolved?.profile || requestedProfile,
                    requestedProfile,
                    provider: stream.provider || provider,
                    model,
                    durationMs,
                    content,
                    preview: cleanText(content, 180),
                    usage: result?.usage || {},
                    stream,
                    flex: result?.flex || {},
                    serviceTier: result?.serviceTier || result?.flex?.serviceTier || '',
                    fallbackEndpoint: result?.fallbackEndpoint || '',
                    error: ok ? '' : (result?.skipped ? result?.reason || 'LLM not configured' : '테스트 토큰이 응답에 포함되지 않았습니다.')
                };
            } catch (error) {
                const durationMs = Math.max(0, Math.round(now() - startedAt));
                const cause = error?.cause && typeof error.cause === 'object' ? error.cause : {};
                const diagnostic = Array.isArray(cause.ollamaDiagnostics)
                    ? cause.ollamaDiagnostics
                        .map(item => [
                            item?.label || '',
                            item?.done_reason ? `reason=${item.done_reason}` : '',
                            `content=${Number(item?.contentChars || 0)}`,
                            Number(item?.thinkingChars || 0) ? `thinking=${Number(item.thinkingChars || 0)}` : '',
                            Number(item?.evalCount || 0) ? `eval=${Number(item.evalCount || 0)}` : '',
                            item?.error ? `error=${item.error}` : ''
                        ].filter(Boolean).join(' '))
                        .join(' | ')
                    : '';
                try {
                    ActivityDashboardCore?.updateFeatureAnalysis?.({
                        domain: 'provider_test',
                        reason: requestedProfile,
                        status: 'failed',
                        detail: cleanText(error?.message || error, 120),
                        source: 'llm'
                    });
                } catch (_) {}
                return {
                    ok: false,
                    profile: resolved?.profile || requestedProfile,
                    requestedProfile,
                    provider,
                    model,
                    durationMs,
                    fallbackEndpoint: cause.fallbackEndpoint || '',
                    diagnostic: cleanText(diagnostic, 220),
                    error: error?.message || String(error || 'unknown error')
                };
            }
        };

        return { run, EXPECTED_TOKEN };
    })();
