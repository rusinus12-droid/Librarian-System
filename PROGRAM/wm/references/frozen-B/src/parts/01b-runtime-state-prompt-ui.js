    const LIBRA_RUNTIME_EPOCH_KEY = '__LIBRA_WORLD_MAKER_RUNTIME_EPOCH__';
    const LIBRA_RUNTIME_EPOCH = (() => {
        const next = Math.max(0, Number(globalThis?.[LIBRA_RUNTIME_EPOCH_KEY] || 0)) + 1;
        try { globalThis[LIBRA_RUNTIME_EPOCH_KEY] = next; } catch (_) {}
        return next;
    })();
    const isLibraRuntimeEpochActive = () => Number(globalThis?.[LIBRA_RUNTIME_EPOCH_KEY] || 0) === LIBRA_RUNTIME_EPOCH;
    const invalidateLibraRuntimeEpoch = () => {
        try {
            if (Number(globalThis?.[LIBRA_RUNTIME_EPOCH_KEY] || 0) === LIBRA_RUNTIME_EPOCH) {
                globalThis[LIBRA_RUNTIME_EPOCH_KEY] = LIBRA_RUNTIME_EPOCH + 1;
            }
        } catch (_) {}
    };
    const MemoryState = {
        gcCursor: 0,
        hashIndex: new Map(),
        metaCache: null,
        simCache: null,
        embeddingCache: null,
        standardLoreTokenCache: null,
        hybridRowCache: null,
        hmeScopeIndexByScope: new Map(),
        hmeGraphIndexByScope: new Map(), // HME-derived associative graph recall index cache by chat scope
        hmeGraphStaleRebuildByScope: new Map(), // throttle HME graph self-repair rebuilds by chat scope
        libraProjectionDigestByScope: new Map(), // latest projection lorebook digest by chat scope
        sessionCache: new Map(),
        cbsResolvedCharacterLoreByScope: new Map(), // runtime-only CBS pre-resolved character lore by chat scope
        characterLoreEmbeddingCache: new Map(), // runtime-only semantic cache for character/lorebook cue vectors
        characterLoreIndexStatusByScope: new Map(), // runtime diagnostics for character/lorebook cue index
        finalizedTurnMetaByScope: new Map(), // V4.2-style finalized turn anchor metadata by chat scope
        liveSyncStateByScope: new Map(), // latest observed live-chat state by scope
        commitRevisionByScope: new Map(), // lightweight commit revision marker for diagnostics
        debugRecentTurnsByScope: new Map(), // plugin-storage debug export ring: latest two turn buckets per scope
        runtimeDebugRequestsByKey: new Map(), // request traces persisted to pluginStorage for recent debug exports
        runtimeDebugRecentRequestKeys: [],
        runtimeDebugProviderCalls: [],
        runtimeDebugCurrentRequestKey: '',
        runtimeDebugStorageFlushTimersByScope: new Map(),
        runtimeDebugStorageStatusByScope: new Map(),
        suppressedErrorStatsByKey: new Map(),
        pendingTurnCommits: new Map(), // { chat_id: pending turn payload }
        pendingTurnCommitLocksByScope: new Map(), // serialized pending turn finalization by stable chat scope
        pendingFinalizeRetryTimersByScope: new Map(), // delayed post-afterRequest stabilization retries
        deferredGcByScope: new Map(), // background locked GC throttles by chat scope
        afterRequestOriginsByType: new Map(), // { request_type: [{ chatId, canonicalUser, requestSequence, ... }] }
        recentNarrativeOriginByScope: new Map(), // latest beforeRequest origin per chat scope
        mainResponseLanguageByScope: new Map(), // detected canonical assistant language per scope
        recentRecallInjectionByScope: new Map(), // latest beforeRequest injected recall items by chat scope
        recallRuntimeStats: { total: 0, fullScanFallback: 0, boundedPoolBypass: 0, scopeIndexHits: 0, coldHydrated: 0, totalLatencyMs: 0, lastLatencyMs: 0, lastCandidateCount: 0 },
        recentMainResponseTransportByChatId: new Map(), // latest main response transport hint per chat id
        recentMainResponseOutputCaptureByChatId: new Map(), // latest streamed output capture per chat id
        streamOutputRecoveryTimersByChatId: new Map(), // stream output recovery timers
        afterRequestMissingRecoveryTimersByChatId: new Map(), // fallback timers when afterRequest never fires
        turnMaintenanceSchedulesByChatId: new Map(), // debounced/coalesced background maintenance slots
        afterRequestForegroundTasksByScope: new Map(), // foreground afterRequest analysis tasks that beforeRequest must await
        turnMaintenanceLocksByChatId: new Map(), // serialized foreground/background maintenance by chat id
        scopedRuntimeTransaction: null, // exclusive owner of mutable tracker caches
        transientMissing: new Map(), // { msg_id: { since, reason } }
        activityDashboard: {
            visible: false,
            mode: 'compact',
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
        },
        activityDashboardTimer: null,
        activityDashboardTicker: null,
        afterRequestOriginSequence: 0,
        currentSessionId: null,
        _activeChatId: null,
        _activeScopeKey: null,
        isSessionRestored: false,
        ignoredGreetingSignature: null,
        greetingIsolationChatId: null,
        greetingIsolationRearmAvailable: false,
        pendingGreetingIsolationChatId: null,
        pendingGreetingIsolationArmed: false,
        isInitialized: false,
        currentTurn: 0,
        initVersion: 0,
        responseOriginGeneration: 0,
        refreshStabilizeUntil: 0,
        refreshDeleteBlockUntil: 0,

        reset(opts = {}) {
            const { preserveSessionCache = false, preserveRuntimeTransaction = null, preserveResponseOrigins = false } = opts || {};
            const retainedTransaction = preserveRuntimeTransaction?.id
                && this.scopedRuntimeTransaction?.id === preserveRuntimeTransaction.id
                && this.scopedRuntimeTransaction?.epoch === LIBRA_RUNTIME_EPOCH
                && isLibraRuntimeEpochActive() ? this.scopedRuntimeTransaction : null;
            // Navigation replaces the active caches, not the host request that
            // is still awaiting its response. Only a verified persona activation
            // may retain that bounded ownership; explicit reset/unload cancels it.
            const retainResponseOrigins = preserveResponseOrigins === true
                && retainedTransaction?.phase === 'persona.activate';
            this.gcCursor = 0;
            this.hashIndex.clear();
            this.metaCache?.clear?.();
            this.simCache?.clear?.();
            this.embeddingCache?.clear?.();
            this.standardLoreTokenCache?.clear?.();
            this.hybridRowCache?.clear?.();
            this.hmeScopeIndexByScope.clear();
            this.hmeGraphIndexByScope.clear();
            this.hmeGraphStaleRebuildByScope.clear();
            this.invalidateTypedHmeSourceGraph?.();
            this.libraProjectionDigestByScope.clear();
            if (!preserveSessionCache) this.sessionCache.clear();
            if (!preserveSessionCache) this.cbsResolvedCharacterLoreByScope.clear();
            if (!preserveSessionCache) this.characterLoreEmbeddingCache.clear();
            if (!preserveSessionCache) this.characterLoreIndexStatusByScope.clear();
            this.finalizedTurnMetaByScope.clear();
            this.liveSyncStateByScope.clear();
            this.commitRevisionByScope.clear();
            if (!preserveSessionCache) this.debugRecentTurnsByScope.clear();
            if (!preserveSessionCache) { try { DebugExportManager.clearOperationalRecords(); } catch (_) {} }
            if (!preserveSessionCache) this.runtimeDebugRequestsByKey.clear();
            if (!preserveSessionCache) this.runtimeDebugRecentRequestKeys = [];
            if (!preserveSessionCache) this.runtimeDebugProviderCalls = [];
            if (!preserveSessionCache) this.runtimeDebugCurrentRequestKey = '';
            if (!preserveSessionCache) this.suppressedErrorStatsByKey.clear();
            if (!preserveSessionCache) {
                this.runtimeDebugStorageFlushTimersByScope.forEach(timer => { try { clearTimeout(timer); } catch (_) {} });
                this.runtimeDebugStorageFlushTimersByScope.clear();
                this.runtimeDebugStorageStatusByScope.clear();
            }
            this.pendingTurnCommits.clear();
            this.pendingTurnCommitLocksByScope.clear();
            this.pendingFinalizeRetryTimersByScope.forEach(entry => { try { clearTimeout(entry?.timer); } catch (_) {} });
            this.pendingFinalizeRetryTimersByScope.clear();
            this.deferredGcByScope.forEach(entry => { try { clearTimeout(entry?.timer); } catch (_) {} });
            this.deferredGcByScope.clear();
            if (!retainResponseOrigins) {
                this.afterRequestOriginsByType.clear();
                this.responseOriginGeneration++;
            } else {
                for (const typeKey of this.afterRequestOriginsByType.keys()) pruneAfterRequestOriginQueue(typeKey);
            }
            this.recentNarrativeOriginByScope.clear();
            this.mainResponseLanguageByScope.clear();
            this.recentRecallInjectionByScope.clear();
            this.recallRuntimeStats = { total: 0, fullScanFallback: 0, boundedPoolBypass: 0, scopeIndexHits: 0, coldHydrated: 0, totalLatencyMs: 0, lastLatencyMs: 0, lastCandidateCount: 0 };
            this.recentMainResponseTransportByChatId.clear();
            this.recentMainResponseOutputCaptureByChatId.clear();
            this.streamOutputRecoveryTimersByChatId.forEach(entry => { try { clearTimeout(entry?.timer); } catch (_) {} });
            this.streamOutputRecoveryTimersByChatId.clear();
            const retainedOrigins = retainResponseOrigins ? Array.from(this.afterRequestOriginsByType.values()).flat() : [];
            this.afterRequestMissingRecoveryTimersByChatId.forEach((entry, chatId) => {
                if (retainedOrigins.some(origin => origin.chatId === chatId && origin.requestSequence === entry?.requestSequence)) return;
                if (entry?.owner) entry.owner.cancelled = true;
                try { clearTimeout(entry?.timer); } catch (_) {}
                this.afterRequestMissingRecoveryTimersByChatId.delete(chatId);
            });
            this.turnMaintenanceSchedulesByChatId.forEach(entry => { try { clearTimeout(entry?.timer); } catch (_) {} });
            this.turnMaintenanceSchedulesByChatId.clear();
            this.afterRequestForegroundTasksByScope.clear();
            this.turnMaintenanceLocksByChatId.clear();
            this.scopedRuntimeTransaction = retainedTransaction;
            this.transientMissing.clear();
            if (this.activityDashboardTimer) {
                try { clearTimeout(this.activityDashboardTimer); } catch (_) {}
                this.activityDashboardTimer = null;
            }
            if (this.activityDashboardTicker) {
                try { clearInterval(this.activityDashboardTicker); } catch (_) {}
                this.activityDashboardTicker = null;
            }
            this.activityDashboard = {
                visible: false,
                mode: 'compact',
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
            if (!retainResponseOrigins) this.afterRequestOriginSequence = 0;
            this.currentTurn = 0;
            this.initVersion++;
            this.refreshStabilizeUntil = 0;
            this.refreshDeleteBlockUntil = 0;
            this.greetingIsolationChatId = null;
            this.greetingIsolationRearmAvailable = false;
            this.pendingGreetingIsolationChatId = null;
            this.pendingGreetingIsolationArmed = false;
            this._activeChatId = null;
            this._activeScopeKey = null;
            try { ResourceGovernor?.touch?.('memory-state-reset'); } catch (_) {}
        }
    };

    const ScopedRuntimeTransaction = Object.freeze({
        begin(scopeKey = '', phase = '') {
            if (!isLibraRuntimeEpochActive()) return null;
            if (MemoryState.scopedRuntimeTransaction) return null;
            const token = {
                id: `scope_tx_${LIBRA_RUNTIME_EPOCH}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                epoch: LIBRA_RUNTIME_EPOCH,
                scopeKey: String(scopeKey || '').trim(),
                phase: String(phase || '').trim(),
                startedAt: Date.now()
            };
            MemoryState.scopedRuntimeTransaction = token;
            return token;
        },
        end(token = null) {
            if (token?.id && MemoryState.scopedRuntimeTransaction?.id === token.id) {
                MemoryState.scopedRuntimeTransaction = null;
                return true;
            }
            return false;
        },
        current() {
            const value = MemoryState.scopedRuntimeTransaction;
            return value ? { ...value } : null;
        },
        owns(token = null) {
            return !!token?.id && MemoryState.scopedRuntimeTransaction?.id === token.id && isLibraRuntimeEpochActive();
        }
    });
    const RuntimeStateLease = Object.freeze({
        capture(scopeKey = MemoryState._activeScopeKey || MemoryState._activeChatId || '') {
            return Object.freeze({ epoch: LIBRA_RUNTIME_EPOCH, initVersion: MemoryState.initVersion, scopeKey: String(scopeKey || '') });
        },
        isCurrent(lease) {
            return !!lease && lease.epoch === LIBRA_RUNTIME_EPOCH && isLibraRuntimeEpochActive()
                && lease.initVersion === MemoryState.initVersion
                && lease.scopeKey === String(MemoryState._activeScopeKey || MemoryState._activeChatId || '');
        },
        assertCurrent(lease) {
            if (!this.isCurrent(lease)) throw new Error('runtime_lease_invalidated');
        }
    });

    const REFRESH_STABILIZE_MS = 2500;
    const REFRESH_DELETE_BLOCK_MS = 15000;
    const SESSION_CACHE_LIMIT = 24;
    const enterRefreshStabilizeWindow = () => {
        const now = Date.now();
        MemoryState.refreshStabilizeUntil = Math.max(MemoryState.refreshStabilizeUntil || 0, now + REFRESH_STABILIZE_MS);
        MemoryState.refreshDeleteBlockUntil = Math.max(MemoryState.refreshDeleteBlockUntil || 0, now + REFRESH_DELETE_BLOCK_MS);
        MemoryState.transientMissing.clear();
    };
    const isRefreshStabilizing = () => Date.now() < (MemoryState.refreshStabilizeUntil || 0);
    const isRefreshDeleteBlocked = () => Date.now() < (MemoryState.refreshDeleteBlockUntil || 0);
    const getChatMemoryScopeKey = (chat, char = null) => getChatRuntimeScopeKey(chat, char);
    const buildScopedSessionId = (scopeKey) => `sess_${stableHash(scopeKey || 'global')}_${Date.now()}`;
    const captureScopedRuntimeState = () => ({
        narrative: safeClone(NarrativeTracker.getState?.() || { storylines: [], turnLog: [], lastSummaryTurn: 0 }),
        storyAuthor: safeClone(StoryAuthor.getState?.() || {}),
        director: safeClone(Director.getState?.() || {}),
        worldAdditional: safeClone((typeof WorldAdditionalCore === 'object' && WorldAdditionalCore?.getState) ? WorldAdditionalCore.getState() : {}),
        userDlc: safeClone((typeof UserDlcCore === 'object' && UserDlcCore?.getState) ? UserDlcCore.getState() : {}),
        charStates: safeClone(CharacterStateTracker.getState?.() || {}),
        worldStates: safeClone(WorldStateTracker.getState?.() || {}),
        secretKnowledge: safeClone(SecretKnowledgeCore?.getState?.() || null),
        entityKnowledgeVault: safeClone(EntityKnowledgeVaultCore?.getState?.() || null),
        timeEngine: safeClone(TimeEngine?.getState?.() || null),
        sectionWorld: safeClone(SectionWorldInferenceManager.getState?.() || {})
    });
    const rememberScopedRuntimeState = (scopeKey) => {
        const key = String(scopeKey || '').trim();
        if (!key) return;
        if (MemoryState.sessionCache.has(key)) {
            MemoryState.sessionCache.delete(key);
        }
        MemoryState.sessionCache.set(key, captureScopedRuntimeState());
        while (MemoryState.sessionCache.size > SESSION_CACHE_LIMIT) {
            const oldestKey = MemoryState.sessionCache.keys().next().value;
            if (!oldestKey) break;
            MemoryState.sessionCache.delete(oldestKey);
        }
    };
    const restoreScopedRuntimeState = (scopeKey) => {
        const key = String(scopeKey || '').trim();
        if (!key || !MemoryState.sessionCache.has(key)) return false;
        const snapshot = MemoryState.sessionCache.get(key);
        MemoryState.sessionCache.delete(key);
        MemoryState.sessionCache.set(key, snapshot);
        NarrativeTracker.resetState(snapshot?.narrative || { storylines: [], turnLog: [], lastSummaryTurn: 0 });
        if (typeof StoryAuthor?.resetState === 'function') StoryAuthor.resetState(snapshot?.storyAuthor || null);
        if (typeof Director?.resetState === 'function') Director.resetState(snapshot?.director || null);
        if (typeof WorldAdditionalCore === 'object' && typeof WorldAdditionalCore.resetState === 'function') WorldAdditionalCore.resetState(snapshot?.worldAdditional || null);
        if (typeof UserDlcCore === 'object' && typeof UserDlcCore.resetState === 'function') UserDlcCore.resetState(snapshot?.userDlc || null);
        CharacterStateTracker.resetState(snapshot?.charStates || {});
        WorldStateTracker.resetState(snapshot?.worldStates || {});
        if (typeof SecretKnowledgeCore?.resetState === 'function') SecretKnowledgeCore.resetState(snapshot?.secretKnowledge || null);
        if (typeof EntityKnowledgeVaultCore?.resetState === 'function') EntityKnowledgeVaultCore.resetState(snapshot?.entityKnowledgeVault || null);
        if (typeof TimeEngine?.resetState === 'function') TimeEngine.resetState(snapshot?.timeEngine || null);
        SectionWorldInferenceManager.loadState(snapshot?.sectionWorld || null);
        return true;
    };
    const PENDING_FINALIZE_MIN_MS = 3500;
    const PENDING_FINALIZE_REQUIRED_MATCHES = 2;
    const PENDING_FINALIZE_RETRY_MAX_ATTEMPTS = 12;
    const PENDING_FINALIZE_RETRY_MAX_AGE_MS = 30000;
    const PENDING_STALE_MS = 180000;
    const AFTER_REQUEST_ORIGIN_TTL_MS = 600000;
    const MAX_AFTER_REQUEST_ORIGINS_PER_TYPE = 10;
    const MAIN_RESPONSE_TRANSPORT_HINT_TTL_MS = 120000;
    const MAIN_RESPONSE_OUTPUT_CAPTURE_TTL_MS = 30 * 60 * 1000;
    const RESPONSE_STREAMING_RECOVERY_INITIAL_MS = 5000;
    const RESPONSE_STREAMING_RECOVERY_RETRY_MS = 5000;
    const RESPONSE_STREAMING_RECOVERY_MAX_ATTEMPTS = 360;
    const RESPONSE_STREAMING_IDLE_SETTLE_MS = 15 * 1000;
    const RESPONSE_STREAMING_IDLE_MIN_REQUEST_AGE_MS = 20 * 1000;
    const RESPONSE_STREAMING_STALE_SETTLE_MS = 2 * 60 * 1000;
    const RESPONSE_STREAMING_FORCE_SETTLE_MS = 30 * 60 * 1000;
    const BACKGROUND_MAINTENANCE_DEBOUNCE_MS = 8000;
    const BACKGROUND_MAINTENANCE_COOLDOWN_MS = 20000;
    const LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_KEY = '__LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR__';
    const UI_INTERACTION_BLOCK_MS = 1200;
    const UI_INTERACTION_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown'];
    const LIBRA_UI_GUARD_CLEANUP_KEY = '__LIBRA_UI_GUARD_CLEANUP__';
    const ROLLBACK_SNAPSHOT_LIMIT_PER_SCOPE = 1; // Volatile runtime fallback also keeps only the latest turn.
    const RUNTIME_SCOPE_RECORD_TTL_MS = 60 * 60 * 1000;
    const LIBRA_LAUNCHER_BUTTON_ID = 'lmai-button';
    let uiInteractionHotUntil = 0;
    let uiInteractionListenersBound = false;
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
    const isLibraDebugEnabled = () => {
        try {
            return typeof MemoryEngine !== 'undefined' && !!MemoryEngine.CONFIG?.debug;
        } catch {
            return false;
        }
    };
    const normalizeNsfwMode = (value) => {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'soft' || normalized === 'direct' || normalized === 'explicit') return normalized;
        if (normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'enabled') return 'direct';
        return 'off';
    };
    const getNsfwMode = (config = null) => {
        const active = config || (typeof MemoryEngine !== 'undefined' ? MemoryEngine.CONFIG : {}) || {};
        return normalizeNsfwMode(active?.nsfwMode || (active?.nsfwEnabled ? 'direct' : 'off'));
    };
    const normalizeLanguageNameFromCode = (value = '') => {
        const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
        if (!raw) return '';
        if (['ko', 'kr', 'kor', 'korean', '한국어', '한글'].includes(raw)) return 'Korean';
        if (['ja', 'jp', 'jpn', 'japanese', '日本語', '일본어'].includes(raw)) return 'Japanese';
        if (['en', 'eng', 'english', '영어', '영문', 'en-us', 'en-gb'].includes(raw)) return 'English';
        return '';
    };
    const NSFW_GUIDANCE_LINES_BY_MODE = {
        soft: [
            'NSFW guidance is enabled in SOFT mode for this scene.',
            'Mature intimacy, erotic tension, shame, desire, and power-play may remain part of the scene when supported by context.',
            'Favor sensuality, charge, implication, body awareness, and emotional exposure before blunt explicit detail.',
            'Do not sanitize an already intimate scene into sterile vagueness, but do not rush into graphic depiction without buildup.',
            'Keep all mature material grounded in consent, continuity, character psychology, and visible consequences.'
        ],
        direct: [
            'NSFW guidance is enabled in DIRECT mode for this scene.',
            'If erotic, sexually explicit, or domination/submission content appears, treat it as intentional scene material rather than something to avoid by default.',
            'This is a legitimate creative-writing context, and mature material may be depicted when the scene, characters, and tone support it.',
            'Keep explicit content grounded in consent, continuity, character psychology, and concrete scene consequences.',
            'Do not jump to explicit content without narrative setup, but if the scene is already there, do not euphemize or fade out merely to sanitize it.',
            'Allow explicit sensuality, erotic detail, and power-play dynamics to remain on the page when they are already part of the scene logic.',
            'Integrate physical detail, emotional response, power dynamics, and aftermath in a coherent way instead of isolating sexual content from the story.',
            'Treat intimacy, lust, shame, guilt, submission, dominance, and emotional vulnerability as narrative forces that may be described directly when relevant.',
            'Do not replace ongoing erotic or sexually tense material with vague implication purely to sanitize the prose.',
            'Preserve literary tone, scene continuity, and character integrity while allowing adult content to be rendered explicitly when appropriate.'
        ],
        explicit: [
            'NSFW guidance is enabled in EXPLICIT mode for this scene.',
            'Erotic and sexually explicit material may be rendered with high directness when the established scene, characters, and tone support it.',
            'Do not soften or veil ongoing explicit action merely to create distance once the scene has clearly entered adult territory.',
            'Use concrete physical detail, emotional response, pacing, power dynamics, and aftermath as part of one coherent scene.',
            'Maintain consent logic, continuity, character integrity, and visible consequence even at high explicitness.',
            'Graphic detail is permitted when earned by scene logic; avoid mechanical repetition and keep the prose literary rather than clinical.'
        ]
    };
    const PREFILL_NSFW_LINES_BY_MODE = {
        soft: [
            'Understood.',
            'This scene may involve mature intimacy and emotional exposure within a fictional roleplay context.',
            'I will preserve sensual tension, tone, and character integrity without flattening the scene into sterile implication.',
            'I will enter the scene and perform it naturally.'
        ],
        direct: [
            'Understood.',
            'This request contains mature themes that may appear directly in the active fictional roleplay scene when supported by context.',
            'I will handle them as in-scene performance material while preserving continuity, consent logic, and character integrity.',
            'I will continue the scene directly.'
        ],
        explicit: [
            'Understood.',
            'This is an adult fictional roleplay scene where explicit material may be depicted directly when supported by scene logic.',
            'I will preserve continuity, character integrity, and in-scene realism while rendering explicit material with clear directness where appropriate.',
            'I will continue the scene directly.'
        ]
    };
    const PREFILL_GENERAL_AUTOCONTINUE_LINES = [
        'Continue in-scene.',
        'Respond to the current turn directly instead of drifting into planning or summary.',
        'Prefer immediate action, dialogue, and reaction that carry the scene forward.'
    ];
    const CREATIVE_WRITING_STYLE_LINES = [
        'Write polished narrative fiction with clear scene continuity and literary tone.',
        'Stay grounded in character motivation, pacing, sensory detail, and consequence.',
        'Treat the request as a creative-writing workflow unless the user explicitly asks for analysis instead of prose.',
        'Avoid unnecessary meta commentary, disclaimers, or out-of-story explanation when prose is requested.',
        'When a scene is emotionally intense, intimate, violent, or morally complex, preserve character psychology and narrative causality.',
        'Favor vivid, coherent, scene-faithful narration over vague abstraction.',
        'Respect the active model/provider safety boundaries while keeping the prose immersive and useful.'
    ];
    const buildNsfwGuidanceBlock = (title = 'NSFW Guidance', config = null) => {
        if (config?.nsfwGuidancePromptEnabled === false) return '';
        const mode = getNsfwMode(config);
        if (mode === 'off') return '';
        return [`【${title}】`, ...((NSFW_GUIDANCE_LINES_BY_MODE[mode] || NSFW_GUIDANCE_LINES_BY_MODE.direct))].join('\n');
    };
    const buildCreativeWritingGuidanceBlock = (title = 'Creative Writing Guidance') => {
        return [`【${title}】`, ...CREATIVE_WRITING_STYLE_LINES].join('\n');
    };
    const buildPrefillBlock = (config = null, options = {}) => {
        const active = config || (typeof MemoryEngine !== 'undefined' ? MemoryEngine.CONFIG : {}) || {};
        if (active?.assistantPrefillEnabled === false) return '';
        const mode = getNsfwMode(active);
        let lines = null;
        if (mode !== 'off') {
            lines = PREFILL_NSFW_LINES_BY_MODE[mode] || PREFILL_NSFW_LINES_BY_MODE.direct;
        } else if (options?.autoContinue === true) {
            lines = PREFILL_GENERAL_AUTOCONTINUE_LINES;
        }
        if (!Array.isArray(lines) || lines.length === 0) return '';
        const target = normalizeLanguageNameFromCode(options?.languageTarget || '');
        const header = target === 'Korean'
            ? '# 응답'
            : target === 'Japanese'
                ? '# 応答'
                : target === 'English'
                    ? '# Response'
                    : '';
        const languageSyncLines = (() => {
            if (target === 'Korean') {
                return [
                    '최종 visible 본문은 한국어로 이어간다.',
                    '장면, 대사, 서술은 한국어 문장으로 쓴다.'
                ];
            }
            if (target === 'Japanese') {
                return [
                    '最終的に見える本文は日本語で続ける。',
                    '場面、台詞、叙述は日本語の文章で書く。'
                ];
            }
            if (target === 'English') {
                return [
                    'Continue the final visible body in English.',
                    'Write scene prose, dialogue, and narration in English.'
                ];
            }
            return [];
        })();
        return `<assistant>\n${[header, ...languageSyncLines, ...lines].filter(Boolean).join('\n')}\n</assistant>`;
    };
    const buildFullSystemPrompt = (...parts) => {
        // Risu has already assembled the active preset, author note, jailbreak,
        // response template, and (often terminal) assistant prefill by the time
        // beforeRequest runs.  LIBRA must add continuity data only: adding a
        // second creative-writing policy or an assistant prefill here changes
        // the host contract and is especially harmful for markerless presets.
        return parts.filter(Boolean).join('\n\n');
    };
    function resolveColdStartHistoryLimit(preset, fallbackLimit = 100) {
        const normalizedPreset = String(preset || 'all').trim().toLowerCase();
        if (normalizedPreset === 'all') return 0;
        const presetLimits = {
            recent100: 100,
            recent200: 200,
            recent500: 500,
            last100: 100,
            last200: 200,
            last500: 500
        };
        if (Object.prototype.hasOwnProperty.call(presetLimits, normalizedPreset)) return presetLimits[normalizedPreset];
        const numericFallback = Number(fallbackLimit);
        if (Number.isFinite(numericFallback) && numericFallback > 0) return Math.max(1, Math.floor(numericFallback));
        return 100;
    }
    const markUiInteractionHot = () => {
        uiInteractionHotUntil = Math.max(uiInteractionHotUntil, Date.now() + UI_INTERACTION_BLOCK_MS);
    };
    const unbindUiInteractionGuards = () => {
        if (typeof document !== 'undefined') {
            UI_INTERACTION_EVENTS.forEach((eventName) => {
                document.removeEventListener(eventName, markUiInteractionHot, true);
            });
        }
        uiInteractionListenersBound = false;
        if (typeof globalThis !== 'undefined' && globalThis[LIBRA_UI_GUARD_CLEANUP_KEY] === unbindUiInteractionGuards) {
            delete globalThis[LIBRA_UI_GUARD_CLEANUP_KEY];
        }
    };
    const bindUiInteractionGuards = () => {
        if (typeof document === 'undefined') return;
        const existingCleanup = typeof globalThis !== 'undefined' ? globalThis[LIBRA_UI_GUARD_CLEANUP_KEY] : null;
        if (typeof existingCleanup === 'function' && existingCleanup !== unbindUiInteractionGuards) {
            existingCleanup();
        }
        if (uiInteractionListenersBound) return;
        uiInteractionListenersBound = true;
        UI_INTERACTION_EVENTS.forEach((eventName) => {
            document.addEventListener(eventName, markUiInteractionHot, true);
        });
        if (typeof globalThis !== 'undefined') {
            globalThis[LIBRA_UI_GUARD_CLEANUP_KEY] = unbindUiInteractionGuards;
        }
    };
    const tryRearmGreetingIsolation = (chat) => {
        const chatId = chat?.id || null;
        if (!chatId) return false;
        if (MemoryState.pendingGreetingIsolationArmed) return false;
        if (!MemoryState.greetingIsolationRearmAvailable) return false;
        if (MemoryState.greetingIsolationChatId !== chatId) return false;
        if (!MemoryState.ignoredGreetingSignature) return false;

        const msgs = getChatMessages(chat);
        if (!Array.isArray(msgs) || msgs.length !== 1) return false;
        const onlyMsg = msgs[0];
        if (!onlyMsg || isUserLikeMessage(onlyMsg)) return false;
        if (getMessageSignature(onlyMsg) !== MemoryState.ignoredGreetingSignature) return false;

        MemoryState.pendingGreetingIsolationChatId = chatId;
        MemoryState.pendingGreetingIsolationArmed = true;
        MemoryState.greetingIsolationRearmAvailable = false;
        return true;
    };
