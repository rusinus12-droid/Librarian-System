    const ActivityDashboardCore = (() => {
        const makeDashboardMetrics = () => ({
            runId: 0,
            currentTurn: 0,
            overallProgress: 0,
            backgroundProgress: 0,
            backgroundLabel: '대기 중',
            postprocessPhase: '',
            postprocessDetail: '',
            mainLlmCalls: 0,
            auxLlmCalls: 0,
            llmCallsThisTurn: 0,
            embeddingCalls: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cachedInput: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
            injectedSections: [],
            injectedPreview: [],
            queue: { llmActive: 0, llmPending: 0, bgActive: 0, bgPending: 0 },
            activeTask: '',
            backgroundTask: '',
            injectionStats: {
                usedTokens: 0,
                budgetTokens: 0,
                requiredDemand: 0,
                rankedDemand: 0,
                injectedCount: 0,
                skippedCount: 0,
                coreUsedTokens: 0,
                extensionUsedTokens: 0,
                coreRequiredDemand: 0,
                extensionRequiredDemand: 0,
                coreInjectedCount: 0,
                extensionInjectedCount: 0
            },
            plannerInjectionAudit: {
                storyAuthor: false,
                director: false,
                worldManager: false,
                patternGuard: false
            },
            featureAnalysis: {
                active: 0,
                completed: 0,
                failed: 0,
                lastKey: '',
                lastLabel: '',
                lastStatus: 'idle',
                lastDetail: '',
                lastReason: '',
                updatedAt: 0,
                modules: {}
            },
            healthSummary: {
                total: 0,
                quarantine: 0,
                conflicts: 0,
                integrity: 0,
                embedding: 0,
                severity: 'ok',
                message: ''
            },
            reusedCaches: [],
            invalidatedCaches: [],
            dirtyDomains: [],
            skippedCalls: [],
            llmCallDomains: [],
            llmCallReasons: [],
            sectionBudgetTrimmed: [],
            heartbeatTick: 0,
            dismissedRunId: 0,
            minimized: false,
            runtimeMode: ''
        });
        const ensureDashboardShape = (current = {}) => {
            const defaults = makeDashboardMetrics();
            for (const [key, value] of Object.entries(defaults)) {
                if (current[key] === undefined || current[key] === null) {
                    current[key] = safeClone(value);
                }
            }
            current.tokens = { ...defaults.tokens, ...(current.tokens && typeof current.tokens === 'object' ? current.tokens : {}) };
            current.queue = { ...defaults.queue, ...(current.queue && typeof current.queue === 'object' ? current.queue : {}) };
            current.injectionStats = { ...defaults.injectionStats, ...(current.injectionStats && typeof current.injectionStats === 'object' ? current.injectionStats : {}) };
            current.plannerInjectionAudit = { ...defaults.plannerInjectionAudit, ...(current.plannerInjectionAudit && typeof current.plannerInjectionAudit === 'object' ? current.plannerInjectionAudit : {}) };
            current.featureAnalysis = { ...defaults.featureAnalysis, ...(current.featureAnalysis && typeof current.featureAnalysis === 'object' ? current.featureAnalysis : {}) };
            current.healthSummary = { ...defaults.healthSummary, ...(current.healthSummary && typeof current.healthSummary === 'object' ? current.healthSummary : {}) };
            current.overallProgress = Number(current.overallProgress || current.progress || 0);
            current.progress = Number(current.progress || current.overallProgress || 0);
            return current;
        };
        const resetRunMetrics = (current = {}) => {
            const defaults = makeDashboardMetrics();
            const previousRunId = Number(current.runId || 0);
            Object.assign(current, safeClone(defaults));
            current.runId = previousRunId + 1;
            try { current.currentTurn = Number(MemoryEngine?.getCurrentTurn?.() || MemoryState.currentTurn || 0); } catch (_) { current.currentTurn = Number(MemoryState.currentTurn || 0); }
            return current;
        };
        const state = () => {
            if (!MemoryState.activityDashboard || typeof MemoryState.activityDashboard !== 'object') {
                MemoryState.activityDashboard = {};
            }
            return ensureDashboardShape(MemoryState.activityDashboard);
        };
        const nowMs = () => Date.now();
        const clampPercent = (value, fallback = 0) => {
            const n = Number(value);
            const base = Number.isFinite(n) ? n : Number(fallback || 0);
            return Math.max(0, Math.min(100, Math.round(base)));
        };
        const text = (value = '') => String(value == null ? '' : value);
        const compactText = (value = '', limit = 180) => truncateForLLM(text(value).replace(/\s+/g, ' ').trim(), limit, '...');
        const escapeHtml = (value = '') => text(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const formatMetricCount = (value) => {
            const n = Number(value || 0);
            if (!Number.isFinite(n)) return '0';
            if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
            if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
            return String(Math.max(0, Math.round(n)));
        };
        const FEATURE_ANALYSIS_LABELS = Object.freeze({
            integrated_world: 'IWE Provider',
            extraction: 'Entity/Identity 분석',
            repair: 'Entity 추출 복구',
            cold_start: '통합 분석',
            knowledge_import: '지식 가져오기',
            storyAuthor: 'Story Author',
            director: 'Director',
            turnMaintenance: '턴 유지보수',
            narrative_summary: '내러티브 요약',
            entity_consolidation: '엔티티 상태 요약',
            world_consolidation: '월드 상태 요약',
            embedding: 'Embedding',
            llm: 'LLM 분석'
        });
        const normalizeFeatureAnalysisStatus = (status = '') => {
            const key = String(status || '').trim().toLowerCase();
            if (['running', 'analyzing', 'active', 'requesting'].includes(key)) return 'running';
            if (['done', 'complete', 'completed', 'success', 'succeeded', 'ok'].includes(key)) return 'done';
            if (['failed', 'fail', 'error'].includes(key)) return 'failed';
            if (['skipped', 'skip'].includes(key)) return 'skipped';
            return key || 'idle';
        };
        const getFeatureAnalysisLabel = (payload = {}) => {
            const domain = String(payload.domain || '').trim();
            const reason = String(payload.reason || '').trim();
            const key = String(payload.key || '').trim();
            return String(
                payload.label
                || FEATURE_ANALYSIS_LABELS[domain]
                || FEATURE_ANALYSIS_LABELS[reason]
                || FEATURE_ANALYSIS_LABELS[key]
                || (domain ? domain.replace(/[_-]+/g, ' ') : '')
                || (reason ? reason.replace(/[_-]+/g, ' ') : '')
                || 'LLM 분석'
            ).replace(/\s+/g, ' ').trim().slice(0, 80);
        };
        const extractUsageTokens = (usage = {}) => {
            const input = Number(
                usage.prompt_tokens
                ?? usage.input_tokens
                ?? usage.promptTokenCount
                ?? usage.inputTokenCount
                ?? usage.promptTokens
                ?? 0
            ) || 0;
            const output = Number(
                usage.completion_tokens
                ?? usage.output_tokens
                ?? usage.candidatesTokenCount
                ?? usage.outputTokenCount
                ?? usage.completionTokens
                ?? 0
            ) || 0;
            const reasoning = Number(
                usage.reasoning_tokens
                ?? usage.reasoningTokenCount
                ?? usage.thoughts_token_count
                ?? usage.thinking_tokens
                ?? 0
            ) || 0;
            const cacheCreation = Number(
                usage.cache_creation_input_tokens
                ?? usage.cacheCreationInputTokens
                ?? usage.prompt_tokens_details?.cache_write_tokens
                ?? usage.input_tokens_details?.cache_write_tokens
                ?? 0
            ) || 0;
            const cacheRead = Number(
                usage.cache_read_input_tokens
                ?? usage.cacheReadInputTokens
                ?? 0
            ) || 0;
            const cachedInput = Number(
                usage.cached_input_tokens
                ?? usage.cachedInputTokens
                ?? usage.cachedContentTokenCount
                ?? usage.cached_content_token_count
                ?? usage.prompt_tokens_details?.cached_tokens
                ?? usage.input_tokens_details?.cached_tokens
                ?? (cacheCreation + cacheRead)
                ?? 0
            ) || 0;
            // Most providers include hidden reasoning inside completion/output tokens.
            // Adding it again would double-count total usage.
            const total = Number(usage.total_tokens ?? usage.totalTokenCount ?? usage.totalTokens ?? (input + output + (output > 0 ? 0 : reasoning))) || 0;
            return { input, output, reasoning, cachedInput, cacheCreation, cacheRead, total };
        };
        const notifyRender = (current = state()) => {
            current.updatedAt = nowMs();
            current.heartbeatTick = Number(current.heartbeatTick || 0) + 1;
            render();
            if (current.visible) startTicker();
            return safeClone(current);
        };
        const readMode = (context = {}, forced = '') => {
            let configuredMode = '';
            try { configuredMode = MemoryEngine?.CONFIG?.activityDashboard || ''; } catch (_) {}
            return normalizeActivityDashboard(
                forced || context.activityDashboard || context.settings?.activityDashboard || configuredMode || state().mode,
                DEFAULT_ACTIVITY_DASHBOARD
            );
        };
        const isEnabled = (context = {}) => readMode(context) !== 'off';
        const createDefaultSteps = () => ([
            { name: '준비', status: 'pending', at: 0 },
            { name: '분석', status: 'pending', at: 0 },
            { name: '반영', status: 'pending', at: 0 },
            { name: '정리', status: 'pending', at: 0 }
        ]);
        const stepsForFlow = (flow = '') => {
            const key = text(flow).toLowerCase();
            if (/before|context|주입/.test(key)) {
                return [
                    { name: '요청 감지', status: 'pending', at: 0 },
                    { name: '스코프 동기화', status: 'pending', at: 0 },
                    { name: '리콜 검색', status: 'pending', at: 0 },
                    { name: '컨텍스트 주입', status: 'pending', at: 0 }
                ];
            }
            if (/after|commit|저장/.test(key)) {
                return [
                    { name: '응답 수집', status: 'pending', at: 0 },
                    { name: '턴 앵커', status: 'pending', at: 0 },
                    { name: '턴 안정화', status: 'pending', at: 0 },
                    { name: '커밋 저장', status: 'pending', at: 0 },
                    { name: '후처리 분석', status: 'pending', at: 0 },
                    { name: '최종 저장', status: 'pending', at: 0 }
                ];
            }
            if (/cold|reanalysis|재분석|초기/.test(key)) {
                return [
                    { name: '대화 수집', status: 'pending', at: 0 },
                    { name: '청크 분석', status: 'pending', at: 0 },
                    { name: '계층 합성', status: 'pending', at: 0 },
                    { name: '데이터 반영', status: 'pending', at: 0 }
                ];
            }
            return createDefaultSteps();
        };
        const formatPhaseLabel = (phase = '') => {
            const key = text(phase).trim();
            const labels = {
                beforeRequest: '주입 준비',
                afterRequest: '응답 후처리',
                'afterRequest:stabilize': '응답 안정화',
                'afterRequest:commit': '턴 커밋',
                'afterRequest:maintenance': '후처리 분석',
                done: '완료',
                error: '오류',
                idle: '대기'
            };
            return labels[key] || key || '대기';
        };
        const classForStatus = (value = '') => {
            const raw = text(value).toLowerCase();
            if (/fail|error|warn|degrad/.test(raw)) return 'failed';
            if (/ok|done|complete|settled|committed|ready|finalized|skip/.test(raw)) return 'ok';
            if (/wait|pending|queue/.test(raw)) return 'waiting';
            if (/run|start|ing|capture|build|update|analysis|commit|write|read|background/.test(raw)) return 'running';
            return '';
        };

        // GUI 헤더의 실시간 작업 표시(#libra-global-status)를 대시보드 상태로 갱신한다.
        // 팝업(#libra-activity-overlay)을 대체하는 표시 계층이다. GUI 오버레이가
        // 닫혀 있으면 요소가 없으므로 조용히 넘어간다 (다음 tick 에서 다시 시도).
        const ACTIVITY_HEADER_ELEMENT_ID = 'libra-global-status';
        const activityHeaderLabel = (current = state()) => {
            const status = String(current.status || 'idle').toLowerCase();
            const label = String(current.activeTask || '').trim()
                || String(current.message || '').trim()
                || formatPhaseLabel(current.phase);
            const progress = clampPercent(current.progress, 0);
            if (/^(idle|done|ok|complete|completed|committed|ready|skipped)$/.test(status)) {
                return label && label !== '대기' ? `완료 · ${label}` : '';
            }
            if (/fail|error|warn/.test(status)) return `오류 · ${label}`;
            const background = Number(current.backgroundProgress || 0) > 0 && Number(current.backgroundProgress || 0) < 100;
            return background ? `${label} ${progress}% · 후처리` : `${label} ${progress}%`;
        };
        const syncActivityHeader = (current = state()) => {
            try {
                const doc = _headerDocument();
                const node = doc?.getElementById?.(ACTIVITY_HEADER_ELEMENT_ID);
                if (!node) return false;
                const label = activityHeaderLabel(current);
                if (!label) return false;
                node.textContent = label;
                // 점 색·맥동을 위해 wrap 요소에 상태를 싣는다 (없으면 텍스트 요소라도).
                const stateNode = doc?.getElementById?.('libra-global-status-wrap') || node;
                try { stateNode.setAttribute('data-libra-activity-state', classForStatus(current.status)); } catch (_) {}
                return true;
            } catch (_) {
                return false;
            }
        };
        const hasActivityHeader = () => {
            try {
                const doc = _headerDocument();
                return !!(doc?.getElementById?.(ACTIVITY_HEADER_ELEMENT_ID));
            } catch (_) { return false; }
        };
        const _headerDocument = () => {
            try { if (typeof document !== 'undefined' && document) return document; } catch (_) {}
            try { if (typeof window !== 'undefined' && window?.document) return window.document; } catch (_) {}
            return null;
        };
