    const AnalysisBudgetPreflight = (() => {
        const DEFAULT_CHAR_PER_TOKEN = 3.6;
        // ── 계약별 출력 예산 **단일 정의** ──
        // 02h 는 09c 보다 먼저 실행되므로(build-manifest 순서) 정의는 여기 있어야 하고 09c 가 읽는다.
        // 예전에는 09c 에 표가 있고 02h 에 도메인 천장이 따로 있어서, 한쪽만 올리면 min() 이 요청을
        // 조용히 잘랐다(실측: manual 3200 → 2800, 번들 3600 → 2800).
        // `budgetFor(contract, tier)` 가 계약값을, `domainCeilingFor(domain)` 이 그 도메인으로 들어오는
        // 최대 요청을 돌려준다. 천장은 **손으로 적지 않고 이 표에서 파생**된다.
        const CONTRACT_OUTPUT_BUDGETS = Object.freeze({
            world_additional: { light: 1400, standard: 1800, complex: 2200, critical: 2600, recovery: 1500 },
            unified: { light: 7000, standard: 9000, complex: 12000, critical: 16000, recovery: 6500 },
            canonical_packet: { light: 5200, standard: 7200, complex: 9600, critical: 12000, recovery: 6000 },
            turn_maintenance_bundle: { light: 2000, standard: 2400, complex: 2800, critical: 3600, recovery: 2400 },
            user_dlc_tracker: { light: 1200, standard: 1800, complex: 2200, critical: 2600, recovery: 1500 }
        });
        // 도메인 하나로 여러 계약이 들어오므로, 천장은 그 도메인에 라우팅되는 계약들의 최대값이다.
        // (도메인 → 계약 목록은 09c 의 실제 호출 지점에서 읽은 사실이다.)
        // 계약이 라우팅되는 도메인의 천장을 표에서 파생한다(최대 tier = critical).
        const budgetFor = (contract = 'canonical_packet', tier = 'standard') => {
            const table = CONTRACT_OUTPUT_BUDGETS[String(contract || '').trim().toLowerCase()]
                || CONTRACT_OUTPUT_BUDGETS.canonical_packet;
            return Number(table[tier] ?? table.standard) || table.standard;
        };
        const derivedDomainCeiling = (domain = '') => {
            const contracts = DOMAIN_CONTRACTS[domain] || [];
            if (!contracts.length) return Number(NON_CONTRACT_DOMAIN_CEILINGS[domain] || 0) || 0;
            return Math.max(...contracts.map(c => budgetFor(c, 'critical')));
        };
        const DOMAIN_CONTRACTS = Object.freeze({
            turnMaintenanceBundle: ['world_additional', 'turn_maintenance_bundle', 'user_dlc_tracker'],
            afterrequestCanonicalPacket: ['canonical_packet'],
            // unified 는 자기 천장(20000)이 계약 최대(16000)보다 크므로 **파생 대상이 아니다**.
            // 여기 넣으면 derivedDomainCeiling 이 더 작은 값을 보고해 요청>실효 가드를 통과시킨다.
            afterrequestUnifiedAnalysis: [],
            userDlcAnalysis: [],          // 09c 가 자체 상수(4200/5200)로 요청 — 표에 없는 경로
            entityExtraction: [],         // 12-processors 가 6500 고정으로 요청 — 표에 없는 경로
            coldStartChunkSummary: [],    // 04g cold start 전용
            coldStartFinalSynthesis: []   // 04d cold start 전용
        });
        // 계약 표에 없는(=파생 대상이 아닌) 도메인의 천장. 값은 리팩터 전과 동일하게 보존한다.
        // entityExtraction(12-processors 6500 고정) · userDlcAnalysis(09c 자체 상수) ·
        // coldStart*(04g/04d 전용) · unified(계약 최대보다 큰 자기 천장) · default.
        const NON_CONTRACT_DOMAIN_CEILINGS = Object.freeze({
            userDlcAnalysis: 5200,
            entityExtraction: 6500,
            coldStartChunkSummary: 2200,
            coldStartFinalSynthesis: 3000,
            default: 6500,
            coldStartFinalSynthesisChunked: 1900,
            // unified 는 계약표 최대(16000)보다 큰 천장(20000)을 갖는다. 파생 대상이 아니다.
            afterrequestUnifiedAnalysis: 20000
        });
        const DOMAIN_LIMITS = {
            entityExtraction: {
                compactAtTokens: 7600,
                chunkedAtTokens: 11800,
                fullUserChars: 36000,
                compactUserChars: 18000,
                chunkedUserChars: 10500,
                fullMaxTokens: 6500,
                compactMaxTokens: 4200,
                chunkedMaxTokens: 2600
            },
            // 이 도메인 하나로 여러 계약이 들어온다(실측 2026-09-27):
            //   world_additional turn(critical 2600) · world_additional manual/historical(요청 3200)
            //   · turn-maintenance-bundle(RP 장기기억 포함 시 요청 3600) · user-dlc tracker
            // 천장이 그 최대 요청보다 작으면 min() 이 **조용히 자른다**(3200/3600 → 2800 이 실제로 발생).
            // 그래서 이 값은 계약 표의 최대 요청을 덮도록 잡고, 게이트가 전 호출 지점에서
            // "요청 ≤ 실효" 를 검사한다. 계약 표를 올리면 여기도 함께 올려야 한다.
            turnMaintenanceBundle: {
                compactAtTokens: 8600,
                chunkedAtTokens: 13500,
                fullUserChars: 42000,
                compactUserChars: 22000,
                chunkedUserChars: 12500,
                // 계약 표에서 파생: 이 도메인의 최대 계약값(turn_maintenance_bundle critical 3600).
                // 배수는 **원래 값에서 역산**했다(동작 불변): full 3600 → compact 3000 = 3600*5/6,
                // chunked 2400 = 3600*2/3. 반올림 오차가 나지 않는 정확한 유리수만 쓴다.
                get fullMaxTokens() { return derivedDomainCeiling('turnMaintenanceBundle'); },
                get compactMaxTokens() { return Math.round(derivedDomainCeiling('turnMaintenanceBundle') * 5 / 6); },
                get chunkedMaxTokens() { return Math.round(derivedDomainCeiling('turnMaintenanceBundle') * 2 / 3); }
            },
            userDlcAnalysis: {
                compactAtTokens: 10500,
                chunkedAtTokens: 16500,
                fullUserChars: 42000,
                compactUserChars: 26000,
                chunkedUserChars: 16000,
                fullMaxTokens: 5200,
                compactMaxTokens: 4200,
                chunkedMaxTokens: 3200
            },
            afterrequestCanonicalPacket: {
                compactAtTokens: 10500,
                chunkedAtTokens: 16500,
                fullUserChars: 52000,
                compactUserChars: 28000,
                chunkedUserChars: 16000,
                // 원래 12000 / 9000 / 6500 → 3/4, 13/24 (6500/12000). 유리수로 정확히 재현한다.
                get fullMaxTokens() { return derivedDomainCeiling('afterrequestCanonicalPacket'); },
                get compactMaxTokens() { return Math.round(derivedDomainCeiling('afterrequestCanonicalPacket') * 3 / 4); },
                get chunkedMaxTokens() { return Math.round(derivedDomainCeiling('afterrequestCanonicalPacket') * 13 / 24); }
            },
            afterrequestUnifiedAnalysis: {
                compactAtTokens: 12000,
                chunkedAtTokens: 19000,
                fullUserChars: 60000,
                compactUserChars: 32000,
                chunkedUserChars: 18000,
                // 이 도메인은 계약 최대값(16000)보다 **큰** 천장을 갖는다(원래 20000). 파생으로 낮추면
                // 회귀다 — 표에서 파생하지 않고 자기 값을 유지한다(동작 불변, 예외임을 여기 명시).
                // 원래 20000 / 14000 / 9000 → 7/10, 9/20.
                get fullMaxTokens() { return NON_CONTRACT_DOMAIN_CEILINGS.afterrequestUnifiedAnalysis; },
                get compactMaxTokens() { return Math.round(NON_CONTRACT_DOMAIN_CEILINGS.afterrequestUnifiedAnalysis * 7 / 10); },
                get chunkedMaxTokens() { return Math.round(NON_CONTRACT_DOMAIN_CEILINGS.afterrequestUnifiedAnalysis * 9 / 20); }
            },
            coldStartChunkSummary: {
                compactAtTokens: 7600,
                chunkedAtTokens: 11800,
                fullUserChars: 36000,
                compactUserChars: 18000,
                chunkedUserChars: 10500,
                fullMaxTokens: 2200,
                compactMaxTokens: 1800,
                chunkedMaxTokens: 1400
            },
            coldStartFinalSynthesis: {
                compactAtTokens: 9000,
                chunkedAtTokens: 14500,
                fullUserChars: 44000,
                compactUserChars: 24000,
                chunkedUserChars: 14000,
                fullMaxTokens: 3000,
                compactMaxTokens: 2400,
                chunkedMaxTokens: 1900
            },
            default: {
                compactAtTokens: 9000,
                chunkedAtTokens: 14500,
                fullUserChars: 44000,
                compactUserChars: 24000,
                chunkedUserChars: 14000,
                fullMaxTokens: 6500,
                compactMaxTokens: 4200,
                chunkedMaxTokens: 2600
            }
        };
        let metrics = {
            lengthFailureCount: 0,
            lastLengthFailure: null,
            lengthFailures: []
        };
        const LENGTH_FAILURE_PATTERN = /finishReason\s*=\s*length|finish_reason["':=\s]+length|finishReason["':=\s]+length|MAX_TOKENS|max(?:imum)? output tokens|context(?:_| )length|too many tokens|prompt (?:is )?too long|input (?:is )?too long|truncated/i;
        const normalizeDomain = (domain = '') => {
            const key = String(domain || '').trim();
            return Object.prototype.hasOwnProperty.call(DOMAIN_LIMITS, key) ? key : 'default';
        };
        const clampPositive = (value, fallback, min = 1, max = 1000000) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) return fallback;
            return Math.max(min, Math.min(max, Math.floor(n)));
        };
        const textOf = (value = '') => {
            if (value == null) return '';
            if (typeof value === 'string') return value;
            try { return JSON.stringify(value); } catch (_) { return String(value || ''); }
        };
        const estimateAnalysisInputSize = (payload = {}) => {
            const system = textOf(payload?.system ?? payload?.systemPrompt ?? '');
            const user = textOf(payload?.user ?? payload?.userContent ?? payload?.prompt ?? '');
            const extra = textOf(payload?.extra ?? '');
            const chars = system.length + user.length + extra.length;
            const charPerToken = clampPositive(payload?.charPerToken, DEFAULT_CHAR_PER_TOKEN, 2, 8);
            return {
                chars,
                systemChars: system.length,
                userChars: user.length,
                extraChars: extra.length,
                estimatedTokens: Math.ceil(chars / charPerToken)
            };
        };
        const getDomainProfile = (domain = 'default') => DOMAIN_LIMITS[normalizeDomain(domain)] || DOMAIN_LIMITS.default;
        const selectAnalysisMode = (input = {}) => {
            const config = input?.config || {};
            const domain = normalizeDomain(input?.domain || input?.routeKey || 'default');
            const profile = getDomainProfile(domain);
            const size = input?.estimatedTokens
                ? {
                    chars: Number(input?.chars || 0) || 0,
                    systemChars: Number(input?.systemChars || 0) || 0,
                    userChars: Number(input?.userChars || 0) || 0,
                    extraChars: Number(input?.extraChars || 0) || 0,
                    estimatedTokens: Number(input.estimatedTokens || 0) || 0
                }
                : estimateAnalysisInputSize(input);
            if (config?.analysisPreflightEnabled === false) {
                return {
                    domain,
                    mode: 'full',
                    reason: 'disabled',
                    ...size,
                    targetUserChars: profile.fullUserChars,
                    maxTokens: clampPositive(input?.maxTokens, profile.fullMaxTokens, 64, 50000),
                    compacted: false
                };
            }
            const compactAt = clampPositive(config?.analysisPreflightCompactAtTokens || input?.compactAtTokens, profile.compactAtTokens, 256, 1000000);
            const chunkedAt = clampPositive(config?.analysisPreflightChunkedAtTokens || input?.chunkedAtTokens, profile.chunkedAtTokens, compactAt + 1, 1000000);
            let mode = 'full';
            let reason = 'within_budget';
            if (size.estimatedTokens >= chunkedAt) {
                mode = 'chunked';
                reason = 'estimated_tokens_exceed_chunked_threshold';
            } else if (size.estimatedTokens >= compactAt) {
                mode = 'compact';
                reason = 'estimated_tokens_exceed_compact_threshold';
            }
            const targetUserChars = mode === 'chunked'
                ? profile.chunkedUserChars
                : (mode === 'compact' ? profile.compactUserChars : profile.fullUserChars);
            const modeMaxTokens = mode === 'chunked'
                ? profile.chunkedMaxTokens
                : (mode === 'compact' ? profile.compactMaxTokens : profile.fullMaxTokens);
            return {
                domain,
                mode,
                reason,
                ...size,
                compactAtTokens: compactAt,
                chunkedAtTokens: chunkedAt,
                targetUserChars,
                maxTokens: Math.min(
                    clampPositive(input?.maxTokens, modeMaxTokens, 64, 50000),
                    clampPositive(modeMaxTokens, modeMaxTokens, 64, 50000)
                ),
                compacted: mode !== 'full'
            };
        };
        const compactTextMiddle = (value = '', maxChars = 12000, marker = '\n...[LIBRA ANALYSIS PREFLIGHT COMPACTED]...\n') => {
            const text = String(value || '');
            const limit = clampPositive(maxChars, 12000, 512, 1000000);
            if (text.length <= limit) return text;
            const markerText = String(marker || '\n...[COMPACTED]...\n');
            const remaining = Math.max(256, limit - markerText.length);
            const headLen = Math.max(128, Math.floor(remaining * 0.62));
            const tailLen = Math.max(128, remaining - headLen);
            return `${text.slice(0, headLen).trimEnd()}${markerText}${text.slice(-tailLen).trimStart()}`;
        };
        const preparePrompt = (input = {}) => {
            const system = textOf(input?.system ?? input?.systemPrompt ?? '');
            const user = textOf(input?.user ?? input?.userContent ?? '');
            const selected = selectAnalysisMode({
                ...input,
                system,
                user
            });
            const preparedUser = selected.compacted
                ? compactTextMiddle(user, selected.targetUserChars)
                : user;
            const prepared = {
                ...selected,
                system,
                user: preparedUser,
                originalUserChars: user.length,
                preparedUserChars: preparedUser.length,
                preparedEstimatedTokens: Math.ceil((system.length + preparedUser.length) / DEFAULT_CHAR_PER_TOKEN)
            };
            return prepared;
        };
        const debugPreflight = (config = {}, label = '', preflight = {}) => {
            if (!config?.debug) return;
            try {
                recordRuntimeDebug('log', '[LIBRA] Analysis budget preflight:', {
                    label: String(label || preflight?.domain || '').trim(),
                    domain: preflight?.domain || '',
                    mode: preflight?.mode || '',
                    reason: preflight?.reason || '',
                    estimatedTokens: preflight?.estimatedTokens || 0,
                    preparedEstimatedTokens: preflight?.preparedEstimatedTokens || 0,
                    originalUserChars: preflight?.originalUserChars || preflight?.userChars || 0,
                    preparedUserChars: preflight?.preparedUserChars || 0,
                    maxTokens: preflight?.maxTokens || 0
                });
            } catch (_) { /* debug only */ }
        };
        const isLengthFailure = (error = null, extra = '') => {
            const text = [
                typeof error === 'string' ? error : '',
                error?.message || '',
                error?.code || '',
                error?.details ? textOf(error.details) : '',
                extra
            ].filter(Boolean).join('\n');
            return LENGTH_FAILURE_PATTERN.test(text);
        };
        const recordLengthFailure = (config = {}, label = '', error = null, preflight = {}) => {
            if (!isLengthFailure(error, preflight?.reason || '')) return false;
            const entry = {
                label: String(label || preflight?.domain || '').trim(),
                domain: String(preflight?.domain || '').trim(),
                mode: String(preflight?.mode || '').trim(),
                reason: String(preflight?.reason || '').trim(),
                error: String(error?.message || error || '').slice(0, 360),
                estimatedTokens: Number(preflight?.estimatedTokens || 0) || 0,
                preparedEstimatedTokens: Number(preflight?.preparedEstimatedTokens || 0) || 0,
                originalUserChars: Number(preflight?.originalUserChars || preflight?.userChars || 0) || 0,
                preparedUserChars: Number(preflight?.preparedUserChars || 0) || 0,
                maxTokens: Number(preflight?.maxTokens || 0) || 0,
                at: Date.now()
            };
            metrics.lengthFailureCount += 1;
            metrics.lastLengthFailure = entry;
            metrics.lengthFailures = [...(metrics.lengthFailures || []), entry].slice(-80);
            try {
                if (typeof MemoryState !== 'undefined' && MemoryState) {
                    MemoryState.analysisPreflightMetrics = {
                        ...(MemoryState.analysisPreflightMetrics || {}),
                        lengthFailureCount: metrics.lengthFailureCount,
                        lastLengthFailure: entry,
                        lengthFailures: metrics.lengthFailures
                    };
                }
            } catch (_) { /* optional state mirror */ }
            if (config?.debug) {
                try { recordRuntimeDebug('warn', '[LIBRA] Analysis preflight length failure recorded:', entry); } catch (_) {}
            }
            return true;
        };
        const getMetrics = () => safeClone(metrics);
        return {
            estimateAnalysisInputSize,
            selectAnalysisMode,
            preparePrompt,
            compactTextMiddle,
            debugPreflight,
            isLengthFailure,
            recordLengthFailure,
            getMetrics,
            getDomainProfile,
            // 계약별 예산 단일 정의 + 파생 helpers (09c 가 읽는다)
            contractBudgets: CONTRACT_OUTPUT_BUDGETS,
            budgetFor,
            derivedDomainCeiling
        };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_AnalysisBudgetPreflight = AnalysisBudgetPreflight;
    } catch (_) { /* optional diagnostics only */ }

    const getEmbeddingDebugSnapshotSafe = () => {
        let engine = null;
        try {
            engine = MemoryEngine?.EmbeddingEngine || null;
        } catch {
            engine = null;
        }
        if (!engine || typeof engine.getDebugSnapshot !== 'function') {
            return {
                totalCalls: 0,
                cacheHits: 0,
                providerCalls: 0,
                lastProvider: '',
                lastModel: '',
                lastDims: 0,
                lastStatus: 'unavailable'
            };
        }
        try {
            return engine.getDebugSnapshot();
        } catch {
            return {
                totalCalls: 0,
                cacheHits: 0,
                providerCalls: 0,
                lastProvider: '',
                lastModel: '',
                lastDims: 0,
                lastStatus: 'error'
            };
        }
    };

    const extractLibraMetaJsonString = (raw = '') => {
        const text = String(raw || '');
        const marker = '[META:';
        const start = text.indexOf(marker);
        if (start < 0) return '';
        const jsonStart = text.indexOf('{', start + marker.length);
        if (jsonStart < 0) return '';
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = jsonStart; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) return text.slice(jsonStart, i + 1);
            }
        }
        return '';
    };

    const parseLibraMetaObject = (raw = '', fallback = {}) => {
        const def = (fallback && typeof fallback === 'object') ? fallback : {};
        try {
            const metaJson = extractLibraMetaJsonString(raw);
            if (!metaJson) return { ...def };
            const parsed = JSON.parse(metaJson);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? { ...def, ...parsed }
                : { ...def };
        } catch (_) {
            return { ...def };
        }
    };

    const deriveMaxTurnFromLorebook = (lorebook) => {
        const managed = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
            .filter(entry => entry?.comment && String(entry.comment).startsWith('lmai_'))
            .filter(entry => !['lmai_rollback_journal', 'lmai_rollback_snapshot'].includes(String(entry.comment || '').trim()));
        let maxTurn = 0;
        const consider = (value) => {
            const num = Number(value);
            if (Number.isFinite(num) && num >= 0 && num < 1000000) maxTurn = Math.max(maxTurn, Math.floor(num));
        };
        const considerObjectFields = (obj = null) => {
            if (!obj || typeof obj !== 'object') return;
            consider(obj.turn);
            consider(obj.t);
            consider(obj.currentTurn);
            consider(obj.upToTurn);
            consider(obj.lastSummaryTurn);
            consider(obj.lastConsolidationTurn);
            consider(obj.firstTurn);
            consider(obj.lastTurn);
            consider(obj.lockedTurn);
            consider(obj.finalizedTurn);
            consider(obj.turnAnchorTurn);
            consider(obj.originalTurn);
            consider(obj.maxTurn);
        };
        const considerRecentArrayObjects = (items = [], limit = 64) => {
            if (!Array.isArray(items) || !items.length) return;
            const start = Math.max(0, items.length - Math.max(1, Number(limit || 64) || 64));
            for (let i = start; i < items.length; i += 1) considerObjectFields(items[i]);
        };
        const parseJsonLike = (content = '') => {
            const text = String(content || '').trim();
            if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
            try { return JSON.parse(text); } catch { return null; }
        };

        for (const entry of managed) {
            const comment = String(entry?.comment || '').trim();
            const content = String(entry?.content || '');
            if (comment === 'lmai_memory') {
                try { considerObjectFields(parseLibraMetaObject(content, {})); } catch { /* ignore malformed meta */ }
                continue;
            }
            const parsed = parseJsonLike(content);
            if (!parsed) continue;
            if (Array.isArray(parsed)) {
                considerRecentArrayObjects(parsed, 64);
                continue;
            }
            considerObjectFields(parsed);
            considerObjectFields(parsed.meta);
            considerObjectFields(parsed.state);
            considerObjectFields(parsed.source);
            considerObjectFields(parsed.stats);
            considerRecentArrayObjects(parsed.turnLog, 80);
            considerRecentArrayObjects(parsed.rows, 80);
            considerRecentArrayObjects(parsed.memories, 80);
            considerRecentArrayObjects(parsed.logs, 80);
            considerRecentArrayObjects(parsed.consolidated, 40);
            if (Array.isArray(parsed.storylines)) {
                for (const storyline of parsed.storylines.slice(-16)) {
                    considerObjectFields(storyline);
                    considerRecentArrayObjects(storyline.recentEvents, 24);
                    considerRecentArrayObjects(storyline.summaries, 24);
                    const turns = Array.isArray(storyline.turns) ? storyline.turns.slice(-24) : [];
                    for (const turn of turns) consider(turn);
                }
            }
            if (parsed.histories && typeof parsed.histories === 'object') {
                for (const history of Object.values(parsed.histories).slice(-24)) {
                    considerObjectFields(history);
                    considerRecentArrayObjects(history?.logs, 24);
                    considerRecentArrayObjects(history?.turnLog, 24);
                    considerRecentArrayObjects(history?.consolidated, 12);
                }
            }
        }

        return maxTurn;
    };
