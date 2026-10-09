        const ACTIVITY_DASHBOARD_DONE_HIDE_MS = 1800;
        const recordEvent = (message = '') => {
            const clean = compactText(message, 160);
            if (!clean) return;
            const current = state();
            current.events = [{ at: nowMs(), message: clean }, ...(current.events || [])].slice(0, 8);
        };
        const setStep = (name = '', status = 'running') => {
            const label = compactText(name, 60);
            if (!label) return;
            const current = state();
            const list = Array.isArray(current.steps) ? [...current.steps] : [];
            const index = list.findIndex(item => item?.name === label);
            const entry = { name: label, status, at: nowMs() };
            if (index >= 0) list[index] = { ...list[index], ...entry };
            else list.push(entry);
            current.steps = list.slice(-10);
        };
        const settleOpenSteps = (status = 'done') => {
            const current = state();
            if (!Array.isArray(current.steps)) return;
            const terminal = /warn|degraded/i.test(status) ? 'warn'
                : /fail|error/i.test(status) ? 'failed'
                : /skip|cancel/i.test(status) ? 'skipped'
                : 'done';
            current.steps = current.steps.map(step => {
                const stepStatus = text(step?.status || '').toLowerCase();
                if (!step || !/run|start|ing|queue|wait|pending/.test(stepStatus)) return step;
                return { ...step, status: terminal, at: step.at || nowMs() };
            });
        };
        const settleFeatureAnalysis = (status = 'done') => {
            const current = state();
            const feature = current.featureAnalysis && typeof current.featureAnalysis === 'object'
                ? current.featureAnalysis
                : makeDashboardMetrics().featureAnalysis;
            const terminal = /fail|error/i.test(status) ? 'failed'
                : /skip|cancel/i.test(status) ? 'skipped'
                : 'done';
            const modules = {};
            for (const [key, value] of Object.entries(feature.modules || {})) {
                const moduleState = value && typeof value === 'object' ? { ...value } : null;
                if (!moduleState) continue;
                if (normalizeFeatureAnalysisStatus(moduleState.status) === 'running') {
                    moduleState.status = terminal;
                    moduleState.updatedAt = nowMs();
                    moduleState.endedAt = moduleState.updatedAt;
                }
                modules[key] = moduleState;
            }
            const values = Object.values(modules);
            const active = values.filter(item => normalizeFeatureAnalysisStatus(item?.status) === 'running').length;
            const completed = values.filter(item => normalizeFeatureAnalysisStatus(item?.status) === 'done').length;
            const failed = values.filter(item => normalizeFeatureAnalysisStatus(item?.status) === 'failed').length;
            const latest = values.sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))[0] || null;
            current.featureAnalysis = {
                ...feature,
                active,
                completed,
                failed,
                lastKey: latest?.key || feature.lastKey || '',
                lastLabel: latest?.label || feature.lastLabel || '',
                lastStatus: latest?.status || terminal,
                lastDetail: latest?.detail || feature.lastDetail || '',
                lastReason: latest?.reason || feature.lastReason || '',
                updatedAt: nowMs(),
                modules
            };
        };
        const stopTicker = () => {
            if (MemoryState.activityDashboardTicker) {
                clearInterval(MemoryState.activityDashboardTicker);
                MemoryState.activityDashboardTicker = null;
            }
        };
        const hasActiveDashboardWork = (current = state()) => {
            const queue = current.queue || {};
            const queueActive = Number(queue.llmActive || 0) + Number(queue.llmPending || 0) + Number(queue.bgActive || 0) + Number(queue.bgPending || 0);
            const terminalRun = Number(current.finishedAt || 0) > 0 && isDashboardTerminalStatus(current.status);
            const featureActive = terminalRun ? 0 : Number(current.featureAnalysis?.active || 0);
            const foregroundActive = Number(MemoryState.afterRequestForegroundTasksByScope?.size || 0) || 0;
            return queueActive > 0 || featureActive > 0 || foregroundActive > 0;
        };
        const clearActivityDashboardAutoHide = () => {
            if (MemoryState.activityDashboardTimer) {
                clearTimeout(MemoryState.activityDashboardTimer);
                MemoryState.activityDashboardTimer = null;
            }
        };
        const startTicker = () => {
            if (MemoryState.activityDashboardTicker) return;
            // 헤더 표시는 경과 시간을 초 단위로 갱신해야 하므로 1초 ticker 를 유지한다.
            MemoryState.activityDashboardTicker = setInterval(() => {
                const current = state();
                if (!current.visible) {
                    stopTicker();
                    return;
                }
                render();
            }, 1000);
        };
        const hide = () => {
            const current = state();
            current.visible = false;
            current.forceVisible = false;
            if (MemoryState.activityDashboardTimer) {
                clearTimeout(MemoryState.activityDashboardTimer);
                MemoryState.activityDashboardTimer = null;
            }
            stopTicker();
            syncActivityHeader();
            return selfCheck();
        };
        // Retired: 수동 닫기는 헤더 전환과 함께 사라졌다 (팝업의 ✕ 버튼이 유일한
        // 트리거였다). 사용자 결정: "수동 닫기 제거 — 헤더는 상태를 계속 표시".
        // 헤더 표시는 작업이 끝나면 자동으로만 숨는다. 호출부(02c/02d 12곳)를
        // 그대로 두기 위해 상수 스텁으로 남긴다 — 이 저장소의 은퇴 기능 관례.
        const isDismissedForCurrentRun = () => false;
        const isDashboardTerminalStatus = (status = '') => /^(idle|done|ok|complete|completed|committed|ready|skipped|failed|error)$/i.test(String(status || '').trim());
        const clearDismissForNewWorkIfSettled = (current = state()) => {
            // A manual close is authoritative for this run. Only beginRequest,
            // which increments runId, may make a later run visible again.
            return !isDismissedForCurrentRun(current);
        };
        const scheduleActivityDashboardAutoHide = (delayMs = ACTIVITY_DASHBOARD_DONE_HIDE_MS) => {
            const delay = Math.max(600, Math.min(5000, Number(delayMs || ACTIVITY_DASHBOARD_DONE_HIDE_MS) || ACTIVITY_DASHBOARD_DONE_HIDE_MS));
            const current = state();
            if (isDismissedForCurrentRun(current)) return hide();
            clearActivityDashboardAutoHide();
            const armCheck = (waitMs) => {
                MemoryState.activityDashboardTimer = setTimeout(() => {
                    MemoryState.activityDashboardTimer = null;
                    const latest = state();
                    if (isDismissedForCurrentRun(latest)) {
                        hide();
                        return;
                    }
                    if (hasActiveDashboardWork(latest)) {
                        // finish() can run just before the foreground-task map
                        // releases its final promise. Keep checking instead of
                        // cancelling auto-hide forever at that boundary.
                        scheduleActivityDashboardAutoHide(delay);
                        return;
                    }
                    hide();
                }, waitMs);
            };
            if (hasActiveDashboardWork(current)) {
                current.visible = isEnabled() ? true : current.visible;
                armCheck(350);
                return;
            }
            armCheck(delay);
        };
        const render = () => {
            const current = state();
            if (!current.visible) return hide();
            syncActivityHeader();
            return null;
        };
        const update = (context = {}, patch = {}) => {
            const current = state();
            if (patch.forceVisible === true) current.forceVisible = true;
            if (patch.forceVisible === true) current.dismissedRunId = 0;
            const requestedMode = readMode(context, patch.mode);
            current.mode = requestedMode === 'off' && current.forceVisible === true ? 'compact' : requestedMode;
            if (requestedMode === 'off' && current.forceVisible !== true) return hide();
            if (MemoryState.activityDashboardTimer) {
                clearTimeout(MemoryState.activityDashboardTimer);
                MemoryState.activityDashboardTimer = null;
            }
            const allowVisible = !isDismissedForCurrentRun(current) || patch.forceVisible === true;
            current.visible = allowVisible;
            current.scopeKey = context.scopeKey || current.scopeKey || MemoryState._activeScopeKey || MemoryState._activeChatId || '';
            current.requestId = patch.requestId || current.requestId || '';
            current.phase = patch.phase || current.phase || 'running';
            current.status = patch.status || current.status || 'running';
            current.message = patch.message == null ? current.message : compactText(patch.message, 220);
            current.progress = patch.progress == null ? current.progress : clampPercent(patch.progress, current.progress || 0);
            current.overallProgress = patch.overallProgress == null
                ? clampPercent(current.overallProgress || current.progress || 0, current.progress || 0)
                : clampPercent(patch.overallProgress, current.overallProgress || current.progress || 0);
            current.progress = Math.max(clampPercent(current.progress, 0), clampPercent(current.overallProgress, 0));
            if (Object.prototype.hasOwnProperty.call(patch, 'activeTask')) current.activeTask = compactText(patch.activeTask || '', 120);
            if (Object.prototype.hasOwnProperty.call(patch, 'backgroundTask')) current.backgroundTask = compactText(patch.backgroundTask || '', 120);
            if (Object.prototype.hasOwnProperty.call(patch, 'backgroundLabel')) current.backgroundLabel = compactText(patch.backgroundLabel || '', 120) || current.backgroundLabel;
            if (Object.prototype.hasOwnProperty.call(patch, 'backgroundProgress')) current.backgroundProgress = clampPercent(patch.backgroundProgress, current.backgroundProgress || 0);
            if (Object.prototype.hasOwnProperty.call(patch, 'postprocessPhase')) current.postprocessPhase = compactText(patch.postprocessPhase || '', 80);
            if (Object.prototype.hasOwnProperty.call(patch, 'postprocessDetail')) current.postprocessDetail = compactText(patch.postprocessDetail || '', 140);
            if (Object.prototype.hasOwnProperty.call(patch, 'healthSummary')) {
                current.healthSummary = {
                    ...makeDashboardMetrics().healthSummary,
                    ...(patch.healthSummary && typeof patch.healthSummary === 'object' ? safeClone(patch.healthSummary) : {})
                };
            }
            current.startedAt = current.startedAt || nowMs();
            current.updatedAt = nowMs();
            current.heartbeatTick = Number(current.heartbeatTick || 0) + 1;
            current.finishedAt = /ok|done|complete|failed|skipped|warn/i.test(current.status) ? nowMs() : 0;
            if (patch.step) setStep(patch.step, patch.stepStatus || current.status);
            if (patch.event || patch.message) recordEvent(patch.event || patch.message);
            if (current.visible) {
                render();
                if (current.finishedAt) scheduleActivityDashboardAutoHide();
                startTicker();
            } else {
                stopTicker();
                syncActivityHeader();
            }
            return safeClone(current);
        };
        const beginRequest = (payload = {}, context = {}) => {
            const current = state();
            const flow = text(payload.flow || payload.requestType || payload.phase || '').trim();
            const startedAt = Number(payload.startedAt || payload.startAt || 0) || nowMs();
            const previousMinimized = current.minimized === true || current.collapsed === true;
            const previousForceVisible = current.forceVisible === true;
            resetRunMetrics(current);
            current.visible = true;
            current.forceVisible = payload.forceVisible === true || previousForceVisible;
            const requestedMode = readMode(context, payload.mode);
            current.mode = requestedMode === 'off' && current.forceVisible === true ? 'compact' : requestedMode;
            if (requestedMode === 'off' && current.forceVisible !== true) return hide();
            current.phase = flow || 'manual';
            current.status = payload.status || 'running';
            current.message = compactText(payload.stageLabel || payload.title || '작업을 준비합니다.', 220);
            current.scopeKey = context.scopeKey || payload.scopeKey || MemoryState._activeScopeKey || MemoryState._activeChatId || '';
            current.requestId = payload.requestType || payload.id || current.requestId || '';
            current.progress = clampPercent(payload.progress ?? 4, 4);
            current.overallProgress = clampPercent(payload.overallProgress ?? current.progress, current.progress);
            current.startedAt = startedAt;
            current.updatedAt = nowMs();
            current.finishedAt = 0;
            current.injection = null;
            current.activeTask = compactText(payload.activeTask || payload.stageLabel || payload.title || '', 120);
            current.postprocessPhase = compactText(payload.postprocessPhase || flow || '', 80);
            current.postprocessDetail = compactText(payload.postprocessDetail || payload.stageLabel || '', 140);
            current.backgroundLabel = payload.backgroundLabel || '대기 중';
            current.minimized = payload.minimized === true || payload.collapsed === true ? true : previousMinimized;
            current.collapsed = false;
            current.steps = stepsForFlow(flow || payload.title).map((step, index) => ({
                ...step,
                status: index === 0 ? 'running' : 'pending',
                at: index === 0 ? startedAt : 0
            }));
            current.events = [];
            recordEvent(current.message);
            render();
            startTicker();
            return safeClone(current);
        };
        const setStage = (label = '', progress = 0, patch = {}, context = {}) => update(context, {
            phase: patch.phase || state().phase || 'manual',
            status: patch.status || 'running',
            progress,
            step: patch.activeTask || label,
            stepStatus: patch.stepStatus || 'running',
            message: label,
            event: patch.event,
            forceVisible: patch.forceVisible === true
        });
        const recordInjection = (context = {}, summary = {}) => {
            const current = state();
            current.injection = summary && typeof summary === 'object' ? safeClone(summary) : null;
            if (!current.injection) return null;
            const sections = Array.isArray(current.injection.sections) ? current.injection.sections : [];
            current.injectedSections = Array.isArray(current.injection.sectionTitles)
                ? current.injection.sectionTitles.slice(0, 18)
                : sections.map(section => section?.title || section?.key || '').filter(Boolean).slice(0, 18);
            current.injectedPreview = sections
                .filter(section => section?.preview)
                .slice(0, 8)
                .map(section => ({
                    title: section.title || section.key || 'section',
                    preview: compactText(section.preview || '', 240)
                }));
            const injectedStats = current.injection.injectionStats && typeof current.injection.injectionStats === 'object'
                ? current.injection.injectionStats
                : {};
            current.injectionStats = {
                ...current.injectionStats,
                ...injectedStats,
                usedTokens: Number(injectedStats.usedTokens || current.injection.totalTokens || current.injection.usedTokens || current.injectionStats.usedTokens || 0),
                budgetTokens: Number(injectedStats.budgetTokens || current.injection.budgetTokens || current.injectionStats.budgetTokens || 0),
                injectedCount: Number(injectedStats.injectedCount || current.injection.sectionCount || sections.length || current.injectionStats.injectedCount || 0),
                skippedCount: current.injection.skipped
                    ? Number(injectedStats.skippedCount || current.injectionStats.skippedCount || 0) + 1
                    : Number(injectedStats.skippedCount || current.injectionStats.skippedCount || 0)
            };
            if (current.injection.plannerInjectionAudit && typeof current.injection.plannerInjectionAudit === 'object') {
                current.plannerInjectionAudit = {
                    ...current.plannerInjectionAudit,
                    storyAuthor: current.injection.plannerInjectionAudit.storyAuthor === true,
                    director: current.injection.plannerInjectionAudit.director === true,
                    worldManager: current.injection.plannerInjectionAudit.worldManager === true,
                    patternGuard: current.injection.plannerInjectionAudit.patternGuard === true
                };
            }
            return update(context, {
                progress: Math.max(92, Number(current.progress || 0)),
                overallProgress: Math.max(92, Number(current.overallProgress || 0)),
                step: '주입 내용',
                stepStatus: current.injection.skipped ? 'skipped' : 'done',
                message: current.injection.skipped
                    ? `주입 없음: ${current.injection.reason || '건너뜀'}`
                    : `실제 주입: ${current.injection.totalChars || 0}자, ${current.injection.sectionCount || 0}개 섹션`,
                event: current.injection.skipped
                    ? `주입 없음: ${current.injection.reason || '건너뜀'}`
                    : `주입 섹션: ${(current.injection.sectionTitles || []).slice(0, 5).join(', ') || '없음'}`
            });
        };
        const show = (payload = {}, context = {}) => {
            const current = state();
            if (isDismissedForCurrentRun(current) && payload.forceVisible !== true) {
                return safeClone(current);
            }
            if (!Number(current.runId || 0) || !current.visible) {
                beginRequest({
                    requestType: payload.requestType || payload.flow || 'manual-dashboard',
                    title: payload.title || '실시간 오버레이',
                    stageLabel: payload.stageLabel || payload.message || '실시간 오버레이가 준비되었습니다.',
                    progress: payload.progress ?? 8,
                    forceVisible: payload.forceVisible === true
                }, context);
            }
            return update(context, {
                phase: payload.phase || state().phase || 'manual',
                status: payload.status || state().status || 'running',
                progress: payload.progress ?? state().progress,
                message: payload.stageLabel || payload.message || state().message || '실시간 오버레이',
                activeTask: payload.activeTask || state().activeTask || '대시보드 표시',
                forceVisible: payload.forceVisible === true
            });
        };
        const setContext = (payload = {}, context = {}) => {
            const current = state();
            const rawSections = Array.isArray(payload.sections) ? payload.sections : [];
            const sections = rawSections.map((section, index) => {
                if (section && typeof section === 'object') {
                    return {
                        title: String(section.title || section.key || `section-${index + 1}`).trim(),
                        key: String(section.key || section.title || `section-${index + 1}`).trim(),
                        chars: Number(section.chars || section.length || String(section.preview || section.content || '').length || 0),
                        preview: compactText(section.preview || section.content || '', 240)
                    };
                }
                const title = String(section || '').trim();
                return { title, key: title, chars: 0, preview: '' };
            }).filter(section => section.title || section.preview).slice(0, 18);
            const preview = Array.isArray(payload.preview)
                ? payload.preview.slice(0, 8).map(item => {
                    if (item && typeof item === 'object') {
                        return {
                            title: String(item.title || item.key || 'section').trim(),
                            preview: compactText(item.preview || item.content || '', 240)
                        };
                    }
                    return { title: 'section', preview: compactText(item || '', 240) };
                }).filter(item => item.preview)
                : sections.filter(section => section.preview).slice(0, 8);
            current.injectedSections = sections.map(section => section.title || section.key).filter(Boolean).slice(0, 18);
            current.injectedPreview = preview;
            current.injection = {
                ...(current.injection && typeof current.injection === 'object' ? current.injection : {}),
                sections,
                sectionTitles: current.injectedSections,
                sectionCount: sections.length,
                totalChars: sections.reduce((sum, section) => sum + Number(section.chars || 0), 0),
                totalTokens: Number(payload.injectionStats?.usedTokens || current.injectionStats?.usedTokens || 0)
            };
            if (payload.injectionStats && typeof payload.injectionStats === 'object') {
                current.injectionStats = {
                    ...current.injectionStats,
                    usedTokens: Number(payload.injectionStats.usedTokens || 0),
                    budgetTokens: Number(payload.injectionStats.budgetTokens || 0),
                    requiredDemand: Number(payload.injectionStats.requiredDemand || 0),
                    rankedDemand: Number(payload.injectionStats.rankedDemand || 0),
                    injectedCount: Number(payload.injectionStats.injectedCount || sections.length || 0),
                    skippedCount: Number(payload.injectionStats.skippedCount || 0),
                    coreUsedTokens: Number(payload.injectionStats.coreUsedTokens || 0),
                    extensionUsedTokens: Number(payload.injectionStats.extensionUsedTokens || 0),
                    coreRequiredDemand: Number(payload.injectionStats.coreRequiredDemand || 0),
                    extensionRequiredDemand: Number(payload.injectionStats.extensionRequiredDemand || 0),
                    coreInjectedCount: Number(payload.injectionStats.coreInjectedCount || 0),
                    extensionInjectedCount: Number(payload.injectionStats.extensionInjectedCount || 0)
                };
            }
            if (payload.plannerInjectionAudit && typeof payload.plannerInjectionAudit === 'object') {
                current.plannerInjectionAudit = {
                    storyAuthor: payload.plannerInjectionAudit.storyAuthor === true,
                    director: payload.plannerInjectionAudit.director === true,
                    worldManager: payload.plannerInjectionAudit.worldManager === true,
                    patternGuard: payload.plannerInjectionAudit.patternGuard === true
                };
            }
            if (Array.isArray(payload.sectionBudgetTrimmed)) {
                current.sectionBudgetTrimmed = payload.sectionBudgetTrimmed.slice(0, 24);
            }
            return update(context, {
                phase: payload.phase || current.phase || 'before-request',
                status: payload.status || 'running',
                progress: Math.max(Number(current.progress || 0), Number(payload.progress ?? 28)),
                overallProgress: Math.max(Number(current.overallProgress || 0), Number(payload.progress ?? 28)),
                step: payload.step || '컨텍스트 주입',
                stepStatus: 'done',
                message: payload.stageLabel || '컨텍스트 주입 완료',
                activeTask: payload.activeTask || '메인 응답 생성'
            });
        };
