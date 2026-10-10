        const updateQueues = (label = '', activeCount = 0, pendingCount = 0) => {
            const current = state();
            const queueLabel = String(label || '').trim();
            if (queueLabel === 'MaintenanceLLMQueue') {
                current.queue.llmActive = Number(activeCount || 0);
                current.queue.llmPending = Number(pendingCount || 0);
            } else if (queueLabel === 'BackgroundMaintenanceQueue') {
                current.queue.bgActive = Number(activeCount || 0);
                current.queue.bgPending = Number(pendingCount || 0);
            } else if (/llm/i.test(queueLabel)) {
                current.queue.llmActive = Number(activeCount || 0);
                current.queue.llmPending = Number(pendingCount || 0);
            } else {
                current.queue.bgActive = Number(activeCount || 0);
                current.queue.bgPending = Number(pendingCount || 0);
            }
            const queueBusy = (current.queue.llmActive + current.queue.llmPending + current.queue.bgActive + current.queue.bgPending) > 0;
            if (queueBusy) clearDismissForNewWorkIfSettled(current);
            const dismissed = isDismissedForCurrentRun(current);
            if (isEnabled() && queueBusy && !dismissed) {
                clearActivityDashboardAutoHide();
                current.visible = true;
                current.finishedAt = 0;
                current.status = /done|ok|complete|committed|ready|skipped/i.test(String(current.status || '')) ? 'background' : (current.status || 'running');
                current.phase = queueLabel === 'BackgroundMaintenanceQueue' ? 'afterRequest:maintenance' : (current.phase || 'queue');
                current.message = queueLabel === 'BackgroundMaintenanceQueue'
                    ? '백그라운드 후처리 분석 진행 중'
                    : (current.message || '큐 작업 진행 중');
                current.activeTask = queueLabel === 'BackgroundMaintenanceQueue' ? '후처리 분석' : (current.activeTask || '큐 작업');
            }
            if (
                !queueBusy
                && !dismissed
                && current.visible === true
                && (clampPercent(current.progress || 0) >= 100 || clampPercent(current.backgroundProgress || 0) >= 100 || isDashboardTerminalStatus(current.status))
            ) {
                current.status = /fail|error/i.test(String(current.status || '')) ? current.status : 'done';
                current.phase = /fail|error/i.test(String(current.status || '')) ? 'error' : 'done';
                current.finishedAt = Number(current.finishedAt || 0) || nowMs();
                settleFeatureAnalysis(current.status);
                scheduleActivityDashboardAutoHide();
            }
            if (dismissed) current.visible = false;
            return notifyRender(current);
        };
        const updateFeatureAnalysis = (payload = {}) => {
            const current = state();
            const prev = current.featureAnalysis && typeof current.featureAnalysis === 'object' ? current.featureAnalysis : makeDashboardMetrics().featureAnalysis;
            const domain = String(payload.domain || '').trim();
            const reason = String(payload.reason || '').trim();
            const rawKey = String(payload.key || [domain || 'llm', reason || payload.detail || payload.profile || payload.source || 'analysis'].filter(Boolean).join(':')).trim();
            const key = rawKey.replace(/[^\w:.-]+/g, '_').slice(0, 96) || 'llm:analysis';
            const modules = { ...(prev.modules && typeof prev.modules === 'object' ? prev.modules : {}) };
            const oldModule = modules[key] && typeof modules[key] === 'object' ? modules[key] : {};
            const status = normalizeFeatureAnalysisStatus(payload.status || oldModule.status || 'running');
            const nowTs = nowMs();
            const label = getFeatureAnalysisLabel({ ...payload, domain, reason, key });
            const detail = compactText(payload.detail || oldModule.detail || '', 120);
            const nextModule = {
                ...oldModule,
                key,
                label,
                domain,
                reason,
                profile: String(payload.profile || oldModule.profile || '').trim(),
                source: String(payload.source || oldModule.source || '').trim(),
                status,
                detail,
                startedAt: status === 'running' ? (oldModule.startedAt || nowTs) : (oldModule.startedAt || 0),
                updatedAt: nowTs,
                endedAt: ['done', 'failed', 'skipped'].includes(status) ? nowTs : 0
            };
            modules[key] = nextModule;
            const limitedEntries = Object.values(modules)
                .filter(entry => entry && typeof entry === 'object')
                .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
                .slice(0, 12);
            const nextModules = {};
            limitedEntries.forEach(entry => { nextModules[entry.key] = entry; });
            const active = limitedEntries.filter(entry => normalizeFeatureAnalysisStatus(entry.status) === 'running').length;
            const completed = limitedEntries.filter(entry => normalizeFeatureAnalysisStatus(entry.status) === 'done').length;
            const failed = limitedEntries.filter(entry => normalizeFeatureAnalysisStatus(entry.status) === 'failed').length;
            const latest = limitedEntries[0] || nextModule;
            current.featureAnalysis = {
                active,
                completed,
                failed,
                lastKey: latest.key || key,
                lastLabel: latest.label || label,
                lastStatus: latest.status || status,
                lastDetail: latest.detail || detail,
                lastReason: compactText(latest.reason || reason || '', 120),
                updatedAt: nowTs,
                modules: nextModules
            };
            if (payload.label || payload.detail) current.activeTask = compactText(payload.label || payload.detail, 120);
            if (status === 'running' || payload.show === true) clearDismissForNewWorkIfSettled(current);
            if (isEnabled() && !isDismissedForCurrentRun(current) && (current.visible === true || ['running', 'failed'].includes(status) || payload.show === true)) {
                if (status === 'running') {
                    clearActivityDashboardAutoHide();
                    current.finishedAt = 0;
                    current.status = /done|ok|complete|committed|ready|skipped/i.test(String(current.status || '')) ? 'running' : (current.status || 'running');
                    current.phase = /done|idle/i.test(String(current.phase || '')) ? 'afterRequest:maintenance' : (current.phase || 'analysis');
                    current.message = compactText(`${label} 진행 중`, 220);
                }
                current.visible = true;
            }
            if (
                active === 0
                && current.visible === true
                && status !== 'running'
                && (clampPercent(current.progress || 0) >= 100 || clampPercent(current.backgroundProgress || 0) >= 100 || isDashboardTerminalStatus(current.status))
            ) {
                current.finishedAt = Number(current.finishedAt || 0) || nowMs();
                scheduleActivityDashboardAutoHide();
            }
            return notifyRender(current);
        };
        const recordLLM = (profile = 'primary', usage = {}, meta = {}) => {
            const current = state();
            const profileKey = String(profile || 'primary').trim().toLowerCase();
            const isForeground = meta.foreground === true || (profileKey !== 'aux' && meta.foreground !== false);
            current.llmCallsThisTurn = Number(current.llmCallsThisTurn || 0) + 1;
            if (profileKey === 'aux') current.auxLlmCalls = Number(current.auxLlmCalls || 0) + 1;
            else current.mainLlmCalls = Number(current.mainLlmCalls || 0) + 1;
            if (!current.tokens || typeof current.tokens !== 'object') current.tokens = {};
            const tokens = extractUsageTokens(usage);
            current.tokens.input = Number(current.tokens.input || 0) + tokens.input;
            current.tokens.output = Number(current.tokens.output || 0) + tokens.output;
            current.tokens.reasoning = Number(current.tokens.reasoning || 0) + tokens.reasoning;
            current.tokens.cachedInput = Number(current.tokens.cachedInput || 0) + tokens.cachedInput;
            current.tokens.cacheCreation = Number(current.tokens.cacheCreation || 0) + tokens.cacheCreation;
            current.tokens.cacheRead = Number(current.tokens.cacheRead || 0) + tokens.cacheRead;
            current.tokens.total = Number(current.tokens.total || 0) + tokens.total;
            if (meta.domain) current.llmCallDomains = dedupeTextArray([...(current.llmCallDomains || []), String(meta.domain || '')]).slice(-12);
            if (meta.reason || meta.label) current.llmCallReasons = dedupeTextArray([...(current.llmCallReasons || []), String(meta.reason || meta.label || '')]).slice(-16);
            if (meta.domain || meta.reason || meta.label) {
                updateFeatureAnalysis({
                    domain: meta.domain || 'llm',
                    reason: meta.reason || '',
                    status: meta.failed ? 'failed' : 'done',
                    detail: meta.label || '',
                    profile: profileKey,
                    source: 'llm'
                });
            }
            if (isForeground) {
                clearDismissForNewWorkIfSettled(current);
                current.activeTask = meta.label ? compactText(meta.label, 120) : (profileKey === 'aux' ? '보조 LLM 작업' : '메인 LLM 작업');
                current.status = meta.failed ? 'failed' : 'running';
                if (isEnabled() && !isDismissedForCurrentRun(current)) current.visible = true;
            }
            return notifyRender(current);
        };
        const recordEmbedding = (meta = {}) => {
            const current = state();
            const isForeground = meta.foreground !== false;
            if (isForeground) {
                clearDismissForNewWorkIfSettled(current);
                current.embeddingCalls = Number(current.embeddingCalls || 0) + 1;
                current.activeTask = compactText(meta.label || 'Embedding', 120);
                if (isEnabled() && !isDismissedForCurrentRun(current)) current.visible = true;
            }
            updateFeatureAnalysis({
                domain: 'embedding',
                // Provider starts are keyed as embedding:<provider>. Reuse that
                // exact key on completion so a stale running row cannot survive.
                reason: meta.cacheHit ? 'cache' : (String(meta.provider || '').trim() || 'provider'),
                status: meta.failed ? 'failed' : (meta.cacheHit ? 'skipped' : 'done'),
                detail: meta.label || '',
                source: 'embedding',
                show: isForeground && meta.cacheHit !== true
            });
            return notifyRender(current);
        };
        const recordCacheReuse = (domain = 'cache', reason = 'reused', meta = {}) => {
            const current = state();
            const label = [domain, reason].filter(Boolean).join(':');
            current.reusedCaches = dedupeTextArray([...(current.reusedCaches || []), label]).slice(-16);
            if (meta?.dirtyDomain) current.dirtyDomains = dedupeTextArray([...(current.dirtyDomains || []), String(meta.dirtyDomain)]).slice(-16);
            return notifyRender(current);
        };
        const recordSkippedCall = (domain = 'llm', reason = 'skipped', meta = {}) => {
            const current = state();
            const label = [domain, reason].filter(Boolean).join(':');
            current.skippedCalls = dedupeTextArray([...(current.skippedCalls || []), label]).slice(-16);
            if (meta?.dirtyDomain) current.dirtyDomains = dedupeTextArray([...(current.dirtyDomains || []), String(meta.dirtyDomain)]).slice(-16);
            return notifyRender(current);
        };
        const recordInvalidatedCache = (domain = 'cache', reason = 'invalidated') => {
            const current = state();
            const label = [domain, reason].filter(Boolean).join(':');
            current.invalidatedCaches = dedupeTextArray([...(current.invalidatedCaches || []), label]).slice(-16);
            return notifyRender(current);
        };
        const updateBackground = (label = '', progress = 0, taskName = null) => {
            const current = state();
            const pct = clampPercent(progress, current.backgroundProgress || 0);
            current.backgroundLabel = compactText(label || current.backgroundLabel || '백그라운드 작업', 120);
            current.backgroundProgress = pct;
            if (taskName) {
                current.backgroundTask = compactText(taskName, 120);
                current.activeTask = compactText(taskName, 120);
            }
            current.postprocessPhase = 'background';
            current.postprocessDetail = taskName ? compactText(taskName, 140) : '후속 유지보수 진행 중';
            if (pct < 100) clearDismissForNewWorkIfSettled(current);
            if (pct >= 100) {
                current.status = 'done';
                current.progress = 100;
                current.overallProgress = 100;
                current.finishedAt = nowMs();
                settleFeatureAnalysis('done');
                scheduleActivityDashboardAutoHide();
            } else {
                clearActivityDashboardAutoHide();
                current.status = 'background';
                current.progress = Math.max(Number(current.progress || 0), 84 + Math.round(pct * 0.15));
                current.overallProgress = current.progress;
                current.finishedAt = 0;
            }
            if (isEnabled() && !isDismissedForCurrentRun(current)) current.visible = true;
            return notifyRender(current);
        };
        const refresh = () => render();
        const updateHealthSummary = (context = {}, summary = {}) => {
            const current = state();
            current.healthSummary = {
                ...makeDashboardMetrics().healthSummary,
                ...(summary && typeof summary === 'object' ? safeClone(summary) : {})
            };
            current.updatedAt = nowMs();
            current.heartbeatTick = Number(current.heartbeatTick || 0) + 1;
            if (current.visible !== true) return safeClone(current);
            return update(context, {
                status: Number(summary?.total || 0) > 0 ? 'waiting' : (current.status || 'idle'),
                healthSummary: current.healthSummary
            });
        };
        const getState = () => safeClone(state());
        const finish = (context = {}, status = 'ok', message = '완료') => {
            const current = state();
            const requestedMode = readMode(context);
            if (requestedMode === 'off' && current.forceVisible !== true) return hide();
            current.status = status;
            current.phase = /fail|error|warn|degraded/i.test(status) ? 'error' : 'done';
            current.message = compactText(message, 220);
            current.progress = status === 'failed' ? current.progress : 100;
            current.overallProgress = current.progress;
            if (/ok|done|complete|committed|ready/i.test(status)) {
                current.backgroundProgress = Math.max(Number(current.backgroundProgress || 0), 100);
                current.backgroundLabel = message || current.backgroundLabel || '완료';
            }
            current.updatedAt = nowMs();
            current.heartbeatTick = Number(current.heartbeatTick || 0) + 1;
            current.finishedAt = nowMs();
            settleOpenSteps(status);
            settleFeatureAnalysis(status);
            recordEvent(message);
            render();
            scheduleActivityDashboardAutoHide();
            return safeClone(current);
        };
        const complete = (message = '완료', context = {}) => finish(context, 'ok', message);
        const fail = (message = '실패', context = {}) => finish(context, 'failed', message);
        const reset = () => {
            const previousRunId = Number(state().runId || 0);
            MemoryState.activityDashboard = {
                ...safeClone(makeDashboardMetrics()),
                runId: previousRunId + 1,
                visible: false,
                mode: DEFAULT_ACTIVITY_DASHBOARD,
                phase: 'idle',
                status: 'idle',
                message: '',
                scopeKey: '',
                requestId: '',
                startedAt: 0,
                updatedAt: 0,
                finishedAt: 0,
                progress: 0,
                steps: [],
                events: [],
                injection: null,
                forceVisible: false
            };
            return hide();
        };
        const selfCheck = (context = {}) => {
            const current = state();
            const normalizedMode = readMode(context);
            const mode = normalizedMode === 'off' && current.forceVisible === true ? 'compact' : normalizedMode;
            return {
                enabled: mode !== 'off',
                visible: current.visible === true,
                mode,
                minimized: current.minimized === true,
                // 종전에는 팝업 DOM 상태를 보고했다. 팝업이 사라졌으므로
                // 헤더 요소가 실제로 존재하는지를 보고한다.
                domStatus: hasActivityHeader() ? 'mounted' : 'unavailable',
                domMounted: hasActivityHeader(),
                phase: current.phase || 'idle',
                status: current.status || 'idle',
                progress: clampPercent(current.progress, 0),
                scopeKey: current.scopeKey || '',
                startedAt: current.startedAt || 0,
                updatedAt: current.updatedAt || 0,
                elapsedSeconds: current.startedAt ? Math.max(0, Math.round((nowMs() - current.startedAt) / 1000)) : 0,
                eventCount: current.events?.length || 0,
                stepCount: current.steps?.length || 0,
                queue: safeClone(current.queue || {}),
                llmCallsThisTurn: Number(current.llmCallsThisTurn || 0),
                mainLlmCalls: Number(current.mainLlmCalls || 0),
                auxLlmCalls: Number(current.auxLlmCalls || 0),
                embeddingCalls: Number(current.embeddingCalls || 0),
                tokens: safeClone(current.tokens || {}),
                backgroundProgress: clampPercent(current.backgroundProgress || 0, 0),
                backgroundLabel: current.backgroundLabel || '',
                healthSummary: safeClone(current.healthSummary || {}),
                featureAnalysis: safeClone(current.featureAnalysis || {}),
                hasInjectionSummary: !!current.injection,
                lastInjectionChars: Number(current.injection?.totalChars || 0),
                lastInjectionSections: Array.isArray(current.injection?.sections) ? current.injection.sections.map(section => section.title || section.key).slice(0, 12) : []
            };
        };
        return Object.freeze({
            isEnabled,
            beginRequest,
            show,
            setContext,
            setStage,
            complete,
            fail,
            update,
            updateQueues,
            recordLLM,
            recordEmbedding,
            recordCacheReuse,
            recordSkippedCall,
            recordInvalidatedCache,
            updateFeatureAnalysis,
            updateBackground,
            recordInjection,
            finish,
            hide,
            reset,
            refresh,
            updateHealthSummary,
            getState,
            render,
            selfCheck
        });
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_ActivityDashboard = ActivityDashboardCore;
    } catch (_) {}

