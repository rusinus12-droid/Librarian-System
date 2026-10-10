    const LIBRA_COMMON_SETTINGS_STORAGE_KEY = 'LMAI_Config';
    const readCommonPluginSettings = async () => {
        return await RisuCompat.pluginStorage.getItem(LIBRA_COMMON_SETTINGS_STORAGE_KEY);
    };
    // ══════════════════════════════════════════════════════════════
    // 설정 **정본 스키마** — GUI 와 런타임이 같은 이름을 쓴다 (P1 감사 수리)
    //
    // 실측 결함: GUI 는 `hybridMemoryEngine` 을 저장했고 엔진은 `hybridMemoryEngineEnabled` 를 읽었다.
    // → 사용자가 GUI 에서 HME 를 OFF 해도 엔진은 계속 ON 이었다(실행 재현).
    //
    // 설계: **읽을 때 옛 이름을 접고(마이그레이션), 쓸 때는 정본만 쓴다.**
    //   구 저장 데이터(`LMAI_Config`)에 옛 이름이 들어 있어도 사용자 설정이 사라지지 않는다.
    //   plugin args 는 별도 override layer 로 남긴다(여기서 다루지 않는다).
    // ══════════════════════════════════════════════════════════════
    const SETTINGS_KEY_ALIASES = Object.freeze({
        // 기능 토글 — GUI 가 만들던 옛 이름 → 정본
        hybridMemoryEngine: 'hybridMemoryEngineEnabled',
        hmeAssociativeGraph: 'hmeAssociativeGraphMode',
        useLorebookRag: 'useLorebookRAG',
        useLorebookRagEnabled: 'useLorebookRAG',
        // 검색 가중치 — GUI 가 만들던 별칭 → 정본 `weights`
        wSim: 'weights.similarity',
        wImp: 'weights.importance',
        wRec: 'weights.recency'
    });
    const setNestedSettingValue = (target = {}, path = '', value = undefined) => {
        const parts = String(path || '').split('.').map(part => part.trim()).filter(Boolean);
        if (!parts.length) return target;
        let cursor = target;
        for (let index = 0; index < parts.length - 1; index += 1) {
            const key = parts[index];
            if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
            cursor = cursor[key];
        }
        cursor[parts[parts.length - 1]] = value;
        return target;
    };
    const getNestedSettingValue = (source = {}, path = '') => {
        const parts = String(path || '').split('.').map(part => part.trim()).filter(Boolean);
        let cursor = source;
        for (const key of parts) {
            if (!cursor || typeof cursor !== 'object') return undefined;
            cursor = cursor[key];
        }
        return cursor;
    };
    const hasNestedSettingValue = (source = {}, path = '') => getNestedSettingValue(source, path) !== undefined;
    //   옛 이름을 정본으로 접는다. **정본이 이미 있으면 사용자 값이 이긴다**(alias 가 덮지 않는다).
    const normalizeSettingsAliases = (config = null) => {
        const source = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};
        const out = {};
        for (const [key, value] of Object.entries(source)) {
            if (Object.prototype.hasOwnProperty.call(SETTINGS_KEY_ALIASES, key)) continue;   // 옛 이름은 버린다
            out[key] = value;
        }
        for (const [alias, canonical] of Object.entries(SETTINGS_KEY_ALIASES)) {
            if (!Object.prototype.hasOwnProperty.call(source, alias)) continue;
            if (hasNestedSettingValue(out, canonical)) continue;   // 정본 우선
            setNestedSettingValue(out, canonical, source[alias]);
        }
        // Removed setting: legacy imports must not restore the pause switch.
        delete out.manualOocPause;
        delete out.manual_ooc_pause;
        delete out.internalDataLanguageMode;
        delete out.internalDataLanguageDebug;
        delete out.internal_data_language_mode;
        delete out.internal_data_language_debug;
        // Retire only transitional injection settings; HME/graph settings are independent.
        if (String(out.libraInjectionMode || '').trim().toLowerCase() === 'hybrid') out.libraInjectionMode = 'direct';
        if (String(out.libraProjectionRecallBundle || '').trim().toLowerCase() === 'hybrid') out.libraProjectionRecallBundle = 'off';
        return out;
    };
    //   설정 파일 내보내기 — **인증정보는 기본 제외**한다(감사 P2).
    //   디버그 export 는 이미 secret redaction 을 한다(`01d` sanitizeValue) — 같은 철학을 적용한다.
    //   사용자가 명시적으로 `[인증 정보 포함]` 을 고르면 원본을 유지한다(백업 복원 목적).
    const SETTINGS_SECRET_KEY_RE = /(^|[_\-.])(key|api[_-]?key|authorization|token|secret|password|private[_-]?key|credential|bearer|x-api-key|access[_-]?token|refresh[_-]?token)($|[_\-.])/i;
    const stripSettingsSecrets = (config = null) => {
        const source = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};
        const out = Array.isArray(config) ? [] : {};
        for (const [key, value] of Object.entries(source)) {
            if (SETTINGS_SECRET_KEY_RE.test(String(key))) continue;   // 인증정보 제거
            if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = stripSettingsSecrets(value);
            else if (Array.isArray(value)) out[key] = value.map(item => (item && typeof item === 'object' && !Array.isArray(item)) ? stripSettingsSecrets(item) : item);
            else out[key] = value;
        }
        return out;
    };
    //   제거했는지 **비교**로 확인한다 — 경고 문구를 띄울지 판단하는 데도 쓴다.
    const settingsExportContainsSecrets = (config = null) => {
        const source = (config && typeof config === 'object') ? config : {};
        for (const [key, value] of Object.entries(source)) {
            if (SETTINGS_SECRET_KEY_RE.test(String(key))) {
                const text = String(value == null ? '' : value).trim();
                if (text) return true;
                continue;
            }
            if (value && typeof value === 'object' && settingsExportContainsSecrets(value)) return true;
        }
        return false;
    };
    //   저장은 **정본만** — alias 를 만들지 않는다.
    const canonicalSettingsForStorage = (config = null) => normalizeSettingsAliases(config);

    //   게이트·다른 조각이 실행할 수 있게 노출한다(판정 로직을 파이프라인에 숨기지 않는다).
    try {
        if (typeof globalThis !== 'undefined') {
            globalThis.LibraSettingsSchema = Object.freeze({
                KEY_ALIASES: SETTINGS_KEY_ALIASES,
                normalize: normalizeSettingsAliases,
                forStorage: canonicalSettingsForStorage,
                stripSecrets: stripSettingsSecrets,
                containsSecrets: settingsExportContainsSecrets
            });
        }
    } catch (_) {}

    let commonSettingsMutationQueue = Promise.resolve();
    let commonSettingsReplacementRevision = 0;
    const queueCommonPluginSettingsMutation = (callback) => {
        const task = commonSettingsMutationQueue.catch(() => {}).then(callback);
        commonSettingsMutationQueue = task.catch(() => {});
        return task;
    };
    const readCommonPluginSettingsForMutation = async (fallback = {}) => {
        const raw = await RisuCompat.pluginStorage.getItem(LIBRA_COMMON_SETTINGS_STORAGE_KEY, { strict: true });
        if (raw == null) return { ...fallback };
        let parsed;
        try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch (_) { throw new Error('settings_storage_invalid_current'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings_storage_invalid_current');
        return canonicalSettingsForStorage({ ...fallback, ...parsed });
    };
    const unverifiedSettingsStorageError = (reason, cause = null) => {
        const error = new Error(`저장 결과 미확인: ${reason}`);
        error.settingsStorageUnverified = true;
        if (cause) error.cause = cause;
        return error;
    };
    const writeCommonPluginSettings = async (value) => {
        // ★ 저장은 **정본 키로만** 한다 — 옛 alias 가 파일에 남으면 드리프트가 재발한다(P1).
        //   문자열(JSON)과 객체 둘 다 받는다(호출부가 둘 다 있다).
        let payload = value;
        try {
            const parsed = (typeof value === 'string') ? JSON.parse(value) : value;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                payload = JSON.stringify(canonicalSettingsForStorage(parsed));
            }
        } catch (_) { payload = value; }   // 파싱 실패하면 원본을 그대로 쓴다(정보 손실 방지)
        let written;
        try {
            written = await RisuCompat.pluginStorage.setItem(LIBRA_COMMON_SETTINGS_STORAGE_KEY, payload, { strict: true });
        } catch (error) {
            if (error?.storageWriteUnverified) throw unverifiedSettingsStorageError('settings_storage_write_unverified', error);
            throw error;
        }
        if (written !== true) throw new Error('settings_storage_write_failed');
        // Publish settings only after the storage adapter confirms the exact
        // canonical payload, including reconstructed chunked settings.
        let persisted;
        try { persisted = await RisuCompat.pluginStorage.getItem(LIBRA_COMMON_SETTINGS_STORAGE_KEY, { strict: true }); }
        catch (error) { throw unverifiedSettingsStorageError('settings_storage_readback_failed', error); }
        if (persisted !== String(payload ?? '')) throw unverifiedSettingsStorageError('settings_storage_readback_mismatch');
        return true;
    };
    const replaceCommonPluginSettings = async (value) => {
        try {
            await writeCommonPluginSettings(value);
        } catch (error) {
            // An issued replacement with uncertain readback must not be undone
            // later by an autosave from the previous settings view.
            if (error?.settingsStorageUnverified) commonSettingsReplacementRevision += 1;
            throw error;
        }
        commonSettingsReplacementRevision += 1;
    };
    const normalizeEntityBlocklistCollection = (value) => {
        const rawItems = Array.isArray(value)
            ? value
            : (value && typeof value === 'object' && Array.isArray(value.items))
                ? value.items
                : String(value || '')
                    .split(/[\n\r,;|]+/g);
        return dedupeTextArray(
            rawItems
                .map(item => String(item || '').trim())
                .filter(Boolean)
        ).slice(0, 200);
    };

        const DebugExportManager = (() => {
        const COMMENT = 'lmai_debug_recent';
        const EXPORT_SCHEMA = 'libra.debug.export.v2';
        const STORAGE_SCHEMA = 'libra.debug.plugin-storage.v1';
        const STORAGE_KEY_PREFIX = 'LMAI_DebugRecent_v2::';
        // ★ 버전은 **단일 출처**(00-plugin-shell-and-args.js 의 `//@version`)에서 파생한다.
        //   종전엔 `'0.1'` 하드코딩이라 v6.0.0 장애가 디버그 JSON 에 0.1 로 찍혔다(감사 P2).
        const PLUGIN_VERSION = (() => {
            try {
                const src = String((typeof LIBRA_PLUGIN_SHELL_HEADER !== 'undefined' && LIBRA_PLUGIN_SHELL_HEADER) || '');
                const matched = src.match(/@version\s+([0-9][^\s]*)/);
                if (matched && matched[1]) return matched[1];
            } catch (_) {}
            // 폴백 — 헤더를 못 읽어도 실제 버전을 유지한다(0.1 로 회귀 금지).
            return '6.0.0';
        })();
        // LIB Flashback-inspired split: safe operational summaries and opt-in diagnostics.
        // Session-only. Explicit export is the sole debug storage write path.
        const OPERATION_LIMIT = 160;
        const OPERATION_RETENTION_MS = 30 * 60 * 1000;
        const OPERATION_CONTEXT_LIMIT = 48;
        let operationSequence = 0;
        const operationSession = Math.random().toString(36).slice(2, 10);
        const operationContexts = new Map();
        let operationalEvents = [];
        const operationLabels = Object.freeze({ request: '요청 처리', source: '원문 확보', binding: '요청 연결', analysis: '분석', memory: '기억 처리', entity: '엔티티 처리', world: '세계 상태 처리', narrative: '서사 처리', save: '저장 확인', retry: '재시도 대기', completion: '처리 종료', other: '처리 단계' });
        const operationStatusLabels = Object.freeze({ running: '진행 중', done: '단계 완료', verified: '저장 내용 확인됨', uncertain: '저장 결과 미확인', waiting: '대기', retry: '재시도 예정', skipped: '건너뜀', failed: '실패' });
        const operationStage = value => {
            const name = String(value || '').toLowerCase();
            if (/save|persist|저장/.test(name)) return 'save';
            if (/retry|recovery|재시도/.test(name)) return 'retry';
            if (/source|capture|원문/.test(name)) return 'source';
            if (/binding|origin|anchor|context_resolved|연결/.test(name)) return 'binding';
            if (/memory|기억/.test(name)) return 'memory';
            if (/entity|엔티티/.test(name)) return 'entity';
            if (/world|세계/.test(name)) return 'world';
            if (/narrative|서사/.test(name)) return 'narrative';
            if (/analysis|maintenance|분석/.test(name)) return 'analysis';
            if (/completion/.test(name)) return 'completion';
            if (/request/.test(name)) return 'request';
            return 'other';
        };
        const pruneOperations = () => {
            const cutoff = Date.now() - OPERATION_RETENTION_MS;
            operationalEvents = operationalEvents.filter(event => event.at >= cutoff).slice(-OPERATION_LIMIT);
            for (const [key, entry] of operationContexts) if (entry.at < cutoff) operationContexts.delete(key);
            while (operationContexts.size > OPERATION_CONTEXT_LIMIT) operationContexts.delete(operationContexts.keys().next().value);
        };
        const recordOperation = (key, phase, payload = {}, status = 'running') => {
            // CBS compatibility diagnostics are explicitly debug-only.
            if (/cbs/i.test(String(phase || ''))) return;
            pruneOperations();
            const context = operationContexts.get(String(key || ''));
            if (!context || context.finished) return;
            const stage = operationStage(phase);
            const turn = Number(payload.turn || payload.turnAnchorTurn || payload.finalizedTurn || 0);
            if (Number.isFinite(turn) && turn > 0) {
                context.turn = Math.floor(turn);
                for (const event of operationalEvents) if (event.operationId === key) event.turn = context.turn;
            }
            const input = String(status || '').toLowerCase();
            let normalized = /uncertain|unverified/.test(input) ? 'uncertain'
                : /fail|error|timeout|invalid|abort/.test(input) || payload.failed === true ? 'failed'
                : /skip|cancel/.test(input) ? 'skipped'
                : /retry|deferred/.test(input) ? 'retry'
                : /wait|pending|queue/.test(input) ? 'waiting'
                : /done|ok|complete|commit|ready|verified/.test(input) ? 'done' : 'running';
            if (stage === 'save' && normalized === 'done') normalized = payload.canonicalVerified === true ? 'verified' : 'uncertain';
            if (normalized === 'failed') context.failed = true;
            if (normalized === 'uncertain') context.uncertain = true;
            if (stage === 'completion' && normalized === 'done') normalized = context.failed ? 'failed' : context.uncertain ? 'uncertain' : 'done';
            const dedupe = `${stage}:${normalized}`;
            if (context.last === dedupe) return;
            context.last = dedupe;
            context.at = Date.now();
            const event = { at: context.at, operationId: key, scopeId: context.scopeId, turn: context.turn, stage, status: normalized, message: `${operationLabels[stage]}: ${operationStatusLabels[normalized]}` };
            // Numeric/boolean allowlist: never copy arbitrary response/error strings.
            if (shouldCapture()) {
                const detail = {};
                for (const name of ['count', 'attempt', 'durationMs', 'canonicalVerified', 'ok', 'failed']) {
                    const value = payload[name];
                    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) detail[name] = value;
                }
                if (Object.keys(detail).length) event.debug = detail;
            }
            operationalEvents.push(event);
            if (operationalEvents.length > OPERATION_LIMIT) operationalEvents.splice(0, operationalEvents.length - OPERATION_LIMIT);
            if (stage === 'completion') context.finished = true;
        };
        const beginOperation = context => {
            pruneOperations();
            const key = `op_${operationSession}_${++operationSequence}`;
            const scope = String(context.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global');
            const turn = Number(context.turn || context.request?.turn || 0);
            operationContexts.set(key, { at: Date.now(), scopeId: `scope_${stableHash(scope)}`, turn: Number.isFinite(turn) && turn > 0 ? Math.floor(turn) : 0 });
            recordOperation(key, 'request', {}, 'running');
            return key;
        };
        const getOperationalRecords = (scopeKey = '') => {
            pruneOperations();
            const scopeId = scopeKey ? `scope_${stableHash(String(scopeKey))}` : '';
            return operationalEvents.filter(event => !scopeId || event.scopeId === scopeId).map(event => ({ ...event, ...(event.debug ? { debug: { ...event.debug } } : {}) }));
        };
        const TURN_LIMIT = 2;
        const EVENT_LIMIT_PER_TURN = 80;
        const REQUEST_LIMIT = 48;
        const PROVIDER_CALL_LIMIT = 96;
        const PHASE_LIMIT = 32;
        const STORAGE_FLUSH_DELAY_MS = 250;
        const TEXT_LIMIT = 1200;
        const DEFAULT_ARRAY_ITEM_LIMIT = 24;
        const VALUE_DEPTH_LIMIT = 6;
        const SECRET_KEY_RE = /(^|[_\-.])(key|api[_-]?key|authorization|token|secret|password|private[_-]?key|credential|bearer|x-api-key|access[_-]?token|refresh[_-]?token)($|[_\-.])/i;
        const shouldCapture = () => {
            try { return typeof MemoryEngine !== 'undefined' && MemoryEngine.CONFIG?.debug === true; }
            catch { return false; }
        };
        const clampText = (value, limit = TEXT_LIMIT) => {
            let text = String(value ?? '');
            text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim();
            text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]');
            text = text.replace(/([?&](?:key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization)=)[^&\s]+/gi, '$1[REDACTED]');
            text = text.replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED_KEY]');
            text = text.replace(/([A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{12,}\.[A-Za-z0-9_\-]{12,})/g, '[REDACTED_TOKEN]');
            text = text.replace(/\b(?:Basic)\s+[^\s,;]+/gi, 'Basic [REDACTED]');
            text = text.replace(/https?:\/\/[^\s<>"']+/gi, url => url.replace(/\/\/[^/@\s]+@/, '//[REDACTED]@').replace(/[?#].*$/, '?[REDACTED]'));
            text = text.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
            return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
        };
        const arrayItemLimitForKey = (keyHint = '') => {
            const key = String(keyHint || '').trim();
            if (key === 'turns') return TURN_LIMIT;
            if (key === 'events') return EVENT_LIMIT_PER_TURN;
            if (key === 'requests' || key === 'recentRequestKeys') return REQUEST_LIMIT;
            if (key === 'providerCalls' || key === 'providerCallIds') return PROVIDER_CALL_LIMIT;
            if (key === 'filterAudit') return 120;
            if (key === 'sourceCandidates') return 16;
            return DEFAULT_ARRAY_ITEM_LIMIT;
        };
        // Closed diagnostic schema. Identifier-shaped strings and object property names
        // can be user content too; neither a regex nor a secret-name denylist is an allowlist.
        const DIAGNOSTIC_FIELDS = new Set(["aborted", "active", "activeCount", "activeScopeKey", "activeTask", "after", "afterChars", "afterRequestHook", "afterRequestMissingTimers", "afterRequestOrigins", "analysisCompleted", "analysisDeferred", "analysisPending", "analysisRecoveryAttempt", "analysisRecoveryStatus", "analysisStatus", "assistantChars", "assistantMessage", "at", "attempt", "attemptCount", "auxiliary", "available", "availableBytes", "backgroundTask", "before", "beforeChars", "beforeRequestHook", "bgActive", "bgPending", "bodyInterceptor", "bodyStreamFlag", "bytes", "bytesByComment", "cacheHits", "cacheMisses", "canceled", "canonicalVerified", "canonicalWritten", "capacity", "captureRegistered", "cbsCharacterLoreMacroCount", "cbsCharacterLorePreResolved", "charName", "characterId", "chars", "chatId", "chatMessageCount", "code", "comparable", "compatEnabled", "completed", "completedCount", "completion_tokens", "concurrency", "configured", "contentChars", "contentKind", "count", "counts", "currentRequestKey", "currentTurn", "dashboard", "data", "debug", "debugEnabled", "debugEntryPresent", "debugPluginStorage", "deferred", "delayMs", "details", "display", "domain", "dropped", "durationMs", "editOutputHandlerRegistered", "elapsedMs", "empty", "emptyCount", "enabled", "endpointMode", "entity", "entityCount", "entryCount", "errorCount", "errors", "events", "excludedCount", "external", "failed", "failedCount", "failures", "featureAnalysis", "filterAudit", "filtered", "finalStatus", "finalizedTurn", "finishedAt", "flexApplied", "flow", "foregroundMaintenanceScopes", "generation", "hasData", "hasIdentity", "hasSource", "hash", "healthSummary", "hmeGraph", "id", "incomingKind", "index", "input", "inputTokens", "input_tokens", "isMainRequest", "kept", "key", "keyConfigured", "kind", "label", "labelCount", "lastDetail", "lastKey", "lastLabel", "lastReason", "lastStatus", "latestUser", "legacyDebugLoreEntry", "level", "limit", "llmActive", "llmPending", "loaded", "lockedTurn", "loreEntries", "macroCount", "managedCount", "maxAttempts", "maxRetries", "memory", "memoryCount", "memoryId", "memorySource", "message", "metrics", "missing", "mode", "model", "modelCalls", "modules", "narrative", "narrativeCount", "nested", "observedAt", "ok", "opaqueId", "operation", "operationId", "operationalHealth", "originBound", "other", "otherManaged", "output", "outputCapture", "outputHandlerRegistered", "outputTokens", "output_tokens", "overallProgress", "payloadKind", "pending", "pendingCount", "persistStatus", "personaId", "phaseOrder", "phases", "pipeline", "plugin", "pluginStorageDebug", "pluginVersion", "postprocessPhase", "present", "processedCount", "profile", "progress", "prompt_tokens", "provider", "providerCallCount", "providerCallIds", "providerCallLimit", "providerCalls", "providers", "queue", "queueLimit", "queueName", "queues", "rawMessageCount", "readCount", "reason", "reasons", "recall", "recentRequestKeys", "recordId", "relation", "relationCount", "remaining", "removed", "removedCount", "request", "requestBytes", "requestCount", "requestId", "requestKey", "requestLimit", "requestSequence", "requestType", "requests", "resetGeneration", "resolvedCount", "response", "responseBytes", "responseChars", "responseKind", "responseStreaming", "restoredCount", "result", "retries", "retryCount", "retryExhausted", "retryScheduled", "risuApi", "roleCounts", "running", "runtimeScopeKey", "safeMessageCount", "saveVerified", "saved", "schema", "scopeHash", "scopeId", "scopeKey", "scriptHandler", "selfCheck", "semanticRecall", "serviceTier", "skipped", "source", "sourceBound", "sourceCandidates", "sourceChars", "sourceCount", "sourceGeneration", "sourceIndex", "sourceMode", "sourceRole", "sourceType", "stage", "stale", "startedAt", "stats", "status", "step", "stepStatus", "storage", "storageReads", "storageWrites", "store", "streamRecoveryTimers", "streamRequested", "success", "supported", "suppressedErrorTurnLimit", "suppressedErrors", "system", "targetGeneration", "targetId", "textDigest", "timestamp", "timestampMs", "total", "totalCalls", "totalTokens", "total_tokens", "trace", "traceEnabled", "transport", "transportCaptured", "transportMode", "trimmedChars", "ts", "turn", "turnAnchor", "turnAnchorTurn", "turnCommitScopes", "turnCount", "turnKey", "turnLimit", "turnMaintenanceLocks", "turns", "type", "unbound", "unchanged", "unresolvedCount", "unsupportedCount", "updated", "updatedAt", "updatedCount", "urlMode", "usage", "used", "user", "userChars", "userMessage", "valid", "verified", "version", "waiting", "warnings", "world", "worldCount", "writeCount"]);
        const DIAGNOSTIC_PHASES = new Set(["after_request_origin", "analysis", "analyzable_messages", "auxiliary_request_guard", "capture_resolve", "cbs_unsupported_macros", "collect_messages", "commit_pending_deferred", "commit_pending_now", "completion", "context_resolved", "entity", "existing_data", "final_synthesis", "foreground_maintenance_wait", "injection_build", "live_sync_anchor", "memory", "merge_verify", "narrative", "narrative_mode", "normalize_request", "origin_resolve", "origin_transport", "other", "output_capture", "partial_state_rollback", "pending_retry", "projection_lorebook_update", "query_scope_guard", "recall_feedback", "response_capture", "retry", "save", "save_verified", "scope_sync", "source_capture", "start", "synthesize_pending", "turn_anchor", "turn_maintenance", "turn_maintenance_result", "user_extract", "world"]);
        const DIAGNOSTIC_CODES = new Set(["6.0.0", "LIBRA World Manager", "aborted", "acknowledged_source_changed", "afterRequest", "afterRequestMissingRecovery", "after_request_origin", "all", "analysis", "analysis-deadline-expired", "analysis_unavailable", "analyzable_messages", "anthropic", "array", "automatic", "auxiliary", "auxiliary_request_guard", "background", "beforeRequest", "binding", "blocked", "canceled", "cancelled", "canonical_save_failed", "canonical_save_unverified", "capture_resolve", "cbs_unsupported_macros", "character_write_failed", "chat_write_failed", "cold-start", "collect_messages", "commit_pending_deferred", "commit_pending_now", "committed", "compact", "complete", "completed", "completion", "context_resolved", "custom", "debug", "debug-export", "default", "deferred", "direct", "disabled", "done", "embedding", "empty", "entity", "error", "existing_data", "export", "failed", "failure", "fallback", "false", "final", "final_synthesis", "finish", "foreground", "foreground_maintenance_wait", "full", "gemini", "google", "hme-graph-recall", "idle", "info", "injection_build", "invalid", "libra.debug.export.v2", "libra.debug.plugin-storage.v1", "live_sync_anchor", "llm", "local", "log", "main", "maintenance-target-not-active", "maintenance-target-unavailable", "manual", "memory", "merge_verify", "missing", "model", "module", "narrative", "narrative_mode", "native", "nonstreaming", "normalize_request", "not_configured", "null", "number", "object", "off", "ok", "ollama", "on", "openai", "origin_resolve", "origin_transport", "other", "output", "output_capture", "partial_state_rollback", "pending", "pending_retry", "primary", "projection_lorebook_update", "query_scope_guard", "queued", "read", "ready", "recall_feedback", "relation", "remote", "request", "request_messages", "request_response", "reset_generation_changed", "response", "response_capture", "retry", "risu", "running", "runtime-transaction-busy", "runtime_lease_invalidated", "save", "save_verified", "scope_sync", "secondary", "skipped", "snapshot", "source", "source_capture", "start", "started", "storage", "streamOutputRecovery", "streaming", "string", "success", "synthesize_pending", "target_character_write_failed", "timeout", "trace", "true", "turn_anchor", "turn_maintenance", "turn_maintenance_result", "unavailable", "unbound", "uncertain", "unchanged", "unknown", "unsupported", "user_extract", "v1", "v2", "v3", "verified", "waiting", "warn", "warning", "world", "write"]);
        // CBS limitation metadata stays in opt-in diagnostics, never the operational ring.
        const CBS_BOOLEAN_FIELDS = new Set(['cbsReadOnly', 'cbsHiddenSnapshotMatched', 'cbsManifestWritten']);
        const CBS_ENUM_FIELDS = new Map([
            ['cbsBridgeStatus', new Set(['not_required', 'native_unproven_target', 'native_unscoped_unsupported', 'native_unavailable', 'disabled', 'unavailable'])],
            ['cbsHiddenSnapshotReason', new Set(['', 'missing', 'stale', 'unproven_target', 'key_set_mismatch'])],
            ['cbsHiddenSnapshotProvenance', new Set(['not_required', 'previously_captured_reference', 'unavailable'])]
        ]);
        for (const key of CBS_BOOLEAN_FIELDS) DIAGNOSTIC_FIELDS.add(key);
        for (const key of CBS_ENUM_FIELDS.keys()) DIAGNOSTIC_FIELDS.add(key);
        const LORE_STAT_CATEGORIES = new Set(['memory', 'entity', 'relation', 'world', 'narrative', 'otherManaged', 'external', 'empty']);
        const isIssuedDiagnosticId = value => typeof value === 'string' && (
            operationContexts.has(value)
            || MemoryState.runtimeDebugRequestsByKey?.has?.(value)
            || (MemoryState.runtimeDebugProviderCalls || []).some(call => call.id === value)
        );
        const sanitizeValue = (value, depth = 0, keyHint = '') => {
            if (CBS_BOOLEAN_FIELDS.has(keyHint)) return typeof value === 'boolean' ? value : undefined;
            if (CBS_ENUM_FIELDS.has(keyHint)) return typeof value === 'string' && CBS_ENUM_FIELDS.get(keyHint).has(value) ? value : undefined;
            const normalizedKey = String(keyHint || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
            if (SECRET_KEY_RE.test(normalizedKey)) {
                if (value === '') return '';
                if (isIssuedDiagnosticId(value)) return value;
                return '[REDACTED]';
            }
            if (/^(?:raw_?)?(?:prompt|response|request)_?(?:text|body|content)$|^(?:body|content|conversation_?text|user_?text|assistant_?text|raw_?response|raw_?prompt|messages)$/i.test(normalizedKey)) return '[REDACTED_CONTENT]';
            if (value === null || value === undefined) return value;
            if (typeof value === 'string') {
                // Reject URL hosts/paths and identifier-shaped secrets as well as free text.
                if (/(?:https?:\/\/|www\.)/i.test(value)) return '[REDACTED_URL]';
                if (value === '' || DIAGNOSTIC_CODES.has(value) || isIssuedDiagnosticId(value)) return value;
                if (/(?:^|_)(?:at|timestamp)$/i.test(normalizedKey) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return value;
                return '[REDACTED_TEXT]';
            }
            if (typeof value === 'number') return Number.isFinite(value) ? value : null;
            if (typeof value === 'boolean') return value;
            if (typeof value === 'function') return '[Function]';
            if (depth >= VALUE_DEPTH_LIMIT) return '[MaxDepth]';
            if (Array.isArray(value)) return value.slice(0, arrayItemLimitForKey(keyHint)).map((item) => sanitizeValue(item, depth + 1, keyHint));
            if (value && typeof value === 'object') {
                const out = {};
                const allowedKeys = keyHint === 'phases' ? DIAGNOSTIC_PHASES
                    : keyHint === 'counts' || keyHint === 'bytesByComment' ? LORE_STAT_CATEGORIES
                    : DIAGNOSTIC_FIELDS;
                for (const [key, val] of Object.entries(value).slice(0, 40)) {
                    if (!allowedKeys.has(key)) continue;
                    out[key] = sanitizeValue(val, depth + 1, key);
                }
                return out;
            }
            return '[Unsupported]';
        };
        const getRuntimeTurn = (meta = {}) => {
            const candidates = [
                meta.turn,
                meta.turnAnchorTurn,
                meta.finalizedTurn,
                meta.lockedTurn,
                (() => { try { return MemoryEngine?.getCurrentTurn?.(); } catch { return 0; } })(),
                (() => { try { return MemoryState?.currentTurn; } catch { return 0; } })()
            ];
            for (const item of candidates) {
                const n = Number(item);
                if (Number.isFinite(n) && n > 0) return Math.floor(n);
            }
            return 0;
        };
        const getScopeKey = (meta = {}) => String(meta.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
        const getBucketKey = (scopeKey, turn) => `${String(scopeKey || 'global')}::${Number(turn || 0)}`;
        const nowMs = () => Date.now();
        const textDigest = (value = '') => {
            const text = String(value || '');
            const trimmed = text.trim();
            return {
                chars: text.length,
                trimmedChars: trimmed.length,
                hash: trimmed ? stableHash(trimmed) : '',
                empty: !trimmed
            };
        };
        const countRoles = (messages = []) => {
            const out = {};
            for (const msg of Array.isArray(messages) ? messages : []) {
                const role = getMessageRoleHint(msg) === 'user' ? 'user' : 'assistant';
                out[role] = Number(out[role] || 0) + 1;
            }
            return out;
        };
        const latestUserDigest = (messages = []) => {
            const list = Array.isArray(messages) ? messages : [];
            for (let i = list.length - 1; i >= 0; i--) {
                const msg = list[i];
                if (!isUserLikeMessage(msg)) continue;
                return {
                    index: i,
                    source: 'request_messages',
                    ...textDigest(msg?.content ?? msg?.text ?? msg?.message ?? '')
                };
            }
            return { index: -1, source: 'none', ...textDigest('') };
        };
        const getStorageKey = (scopeKey = '') => `${STORAGE_KEY_PREFIX}${stableHash(String(scopeKey || 'global').trim() || 'global')}`;
        const parseStoragePayload = (raw) => {
            try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (!parsed || parsed.schema !== STORAGE_SCHEMA) return null;
                return sanitizeValue(parsed);
            } catch (_) {
                return null;
            }
        };
        const mergeByKey = (items = [], keyFn = item => item?.key || item?.id || '') => {
            const byKey = new Map();
            for (const item of Array.isArray(items) ? items : []) {
                if (!item || typeof item !== 'object') continue;
                const key = String(keyFn(item) || '').trim() || `fallback:${byKey.size}:${stableHash(JSON.stringify(item).slice(0, 400))}`;
                byKey.set(key, sanitizeValue(item));
            }
            return Array.from(byKey.values());
        };
        const getStorageStatus = (scopeKey = '') => {
            const scope = String(scopeKey || 'global').trim() || 'global';
            return MemoryState.runtimeDebugStorageStatusByScope?.get?.(scope) || null;
        };
        const buildStoragePayload = (scopeKey = '', context = {}) => {
            const scope = String(scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
            const requests = getRuntimeRequests(scope);
            const requestKeys = new Set(requests.map(request => request?.key).filter(Boolean));
            const providerCalls = (Array.isArray(MemoryState.runtimeDebugProviderCalls) ? MemoryState.runtimeDebugProviderCalls : [])
                .filter(call => !call?.requestKey || requestKeys.has(call.requestKey))
                .slice(0, PROVIDER_CALL_LIMIT)
                .map(call => sanitizeValue(call));
            return sanitizeValue({
                schema: STORAGE_SCHEMA,
                version: 1,
                updatedAt: new Date().toISOString(),
                reason: clampText(context.reason || '', 80),
                plugin: 'LIBRA World Manager',
                pluginVersion: PLUGIN_VERSION,
                scopeKey: scope,
                scopeHash: stableHash(scope),
                chatId: String(context.chatId || MemoryState?._activeChatId || '').trim(),
                turnLimit: TURN_LIMIT,
                requestLimit: REQUEST_LIMIT,
                providerCallLimit: PROVIDER_CALL_LIMIT,
                turns: getRuntimeRecords(scope),
                requests,
                providerCalls
            });
        };
        const readPluginStoragePayload = async (scopeKey = '') => {
            const scope = String(scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
            try {
                const raw = await RisuCompat.pluginStorage.getItem(getStorageKey(scope));
                return parseStoragePayload(raw);
            } catch (error) {
                MemoryState.runtimeDebugStorageStatusByScope?.set?.(scope, {
                    ok: false,
                    at: Date.now(),
                    operation: 'read',
                    key: getStorageKey(scope),
                    error: String(error?.message || error || 'unknown').slice(0, 240)
                });
                return null;
            }
        };
        const flushPluginStorage = async (scopeKey = '', context = {}) => {
            const scope = String(scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
            const key = getStorageKey(scope);
            try {
                const payload = buildStoragePayload(scope, context);
                const ok = await RisuCompat.pluginStorage.setItem(key, JSON.stringify(payload));
                MemoryState.runtimeDebugStorageStatusByScope?.set?.(scope, {
                    ok: ok !== false,
                    at: Date.now(),
                    operation: 'write',
                    key,
                    updatedAt: payload.updatedAt,
                    turnCount: Array.isArray(payload.turns) ? payload.turns.length : 0,
                    requestCount: Array.isArray(payload.requests) ? payload.requests.length : 0,
                    providerCallCount: Array.isArray(payload.providerCalls) ? payload.providerCalls.length : 0
                });
                return payload;
            } catch (error) {
                MemoryState.runtimeDebugStorageStatusByScope?.set?.(scope, {
                    ok: false,
                    at: Date.now(),
                    operation: 'write',
                    key,
                    error: String(error?.message || error || 'unknown').slice(0, 240)
                });
                return null;
            }
        };
        // Retain the call sites for compatibility; live diagnostics are volatile.
        // A user-requested export still flushes explicitly and reads legacy snapshots.
        const schedulePluginStorageFlush = () => {};
        const pushRecentRequestKey = (key = '') => {
            const normalized = String(key || '').trim();
            if (!normalized) return;
            const current = Array.isArray(MemoryState.runtimeDebugRecentRequestKeys) ? MemoryState.runtimeDebugRecentRequestKeys : [];
            MemoryState.runtimeDebugRecentRequestKeys = [normalized, ...current.filter(item => item !== normalized)].slice(0, REQUEST_LIMIT);
            const retained = new Set(MemoryState.runtimeDebugRecentRequestKeys);
            for (const existing of Array.from(MemoryState.runtimeDebugRequestsByKey?.keys?.() || [])) {
                if (!retained.has(existing)) MemoryState.runtimeDebugRequestsByKey.delete(existing);
            }
        };
        const getRuntimeRequest = (key = '') => {
            const normalized = String(key || '').trim();
            if (!normalized) return null;
            return MemoryState.runtimeDebugRequestsByKey?.get?.(normalized) || null;
        };
        const startRequest = (flow = 'request', context = {}) => {
            const operationKey = beginOperation(context);
            if (!shouldCapture()) return operationKey;
            const scopeKey = String(context.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
            const startedAt = nowMs();
            const key = operationKey;
            const request = {
                key,
                flow: sanitizeValue(flow, 0, 'flow'),
                scopeKey,
                chatId: String(context.chatId || '').trim(),
                requestType: sanitizeValue(context.requestType || '', 0, 'requestType'),
                status: 'running',
                startedAt,
                updatedAt: startedAt,
                finishedAt: 0,
                durationMs: 0,
                request: sanitizeValue(context.request || {}),
                phases: {},
                phaseOrder: [],
                providerCallIds: [],
                result: {}
            };
            MemoryState.runtimeDebugRequestsByKey.set(key, request);
            MemoryState.runtimeDebugCurrentRequestKey = key;
            pushRecentRequestKey(key);
            schedulePluginStorageFlush(scopeKey, { chatId: request.chatId, reason: `start:${flow}` });
            return key;
        };
        const updateRequestContext = (key = '', patch = {}) => {
            pruneOperations();
            const operation = operationContexts.get(key);
            if (operation && !operation.finished) {
                if (patch.scopeKey) operation.scopeId = `scope_${stableHash(String(patch.scopeKey))}`;
                const turn = Number(patch.turn || patch.request?.turn || 0);
                if (Number.isFinite(turn) && turn > 0) operation.turn = Math.floor(turn);
                for (const event of operationalEvents) if (event.operationId === key) { event.scopeId = operation.scopeId; event.turn = operation.turn; }
            }
            const request = getRuntimeRequest(key);
            if (!request) return;
            if (patch.scopeKey) request.scopeKey = String(patch.scopeKey || request.scopeKey || 'global').trim() || 'global';
            if (patch.chatId !== undefined) request.chatId = String(patch.chatId || '').trim();
            if (patch.requestType !== undefined) request.requestType = sanitizeValue(patch.requestType || '', 0, 'requestType');
            if (patch.request && typeof patch.request === 'object') request.request = sanitizeValue({ ...(request.request || {}), ...patch.request });
            request.updatedAt = nowMs();
            schedulePluginStorageFlush(request.scopeKey, { chatId: request.chatId, reason: `context:${request.flow || 'request'}` });
        };
        const isFailureDebugStatus = (value = '') => /(?:fail|error|timeout|abort|cancel|schema|parse|invalid|db_error)/i.test(String(value || ''));
        const isNeutralDebugStatus = (value = '') => /^(?:done|ok|ready|committed|updated|skipped|skip|none|waiting|running)$/i.test(String(value || '').trim());
        const isFailedDebugPhase = (phase = {}) => {
            const status = phase?.status || '';
            if (isFailureDebugStatus(status)) return true;
            if (phase?.failed === true) return true;
            return phase?.ok === false && !isNeutralDebugStatus(status);
        };
        const recordPhase = (key = '', phase = 'phase', payload = {}, status = 'done') => {
            recordOperation(key, phase, payload, status);
            if (!shouldCapture()) return;
            const request = getRuntimeRequest(key);
            if (!request) return;
            const name = DIAGNOSTIC_PHASES.has(phase) ? phase : 'other';
            const entryStatus = clampText(status || payload?.status || 'done', 32);
            const entry = sanitizeValue({
                ...payload,
                at: nowMs(),
                status: entryStatus
            });
            if (!Object.prototype.hasOwnProperty.call(request.phases, name) && request.phaseOrder.length >= PHASE_LIMIT) {
                delete request.phases[request.phaseOrder.shift()];
            }
            request.phases[name] = entry;
            if (isFailedDebugPhase({ ...entry, status: entryStatus })) {
                request.status = 'failed';
            }
            if (!request.phaseOrder.includes(name)) request.phaseOrder.push(name);
            request.updatedAt = nowMs();
            schedulePluginStorageFlush(request.scopeKey, { chatId: request.chatId, reason: `phase:${name}` });
        };
        const finishRequest = (key = '', status = 'done', payload = {}) => {
            recordOperation(key, 'completion', payload, status);
            const request = getRuntimeRequest(key);
            if (!request) return;
            const requestedStatus = clampText(status || 'done', 48);
            const hasFailedPhase = Object.values(request.phases || {}).some(phase => isFailedDebugPhase(phase));
            const payloadFailed = payload?.failed === true || isFailureDebugStatus(payload?.status || '') || (payload?.ok === false && isFailureDebugStatus(requestedStatus));
            request.status = (hasFailedPhase || payloadFailed || isFailureDebugStatus(request.status)) && !isFailureDebugStatus(requestedStatus)
                ? 'failed'
                : requestedStatus;
            request.result = sanitizeValue({ ...(request.result || {}), ...payload });
            request.finishedAt = nowMs();
            request.updatedAt = request.finishedAt;
            request.durationMs = Math.max(0, request.finishedAt - Number(request.startedAt || request.finishedAt));
            if (MemoryState.runtimeDebugCurrentRequestKey === request.key) MemoryState.runtimeDebugCurrentRequestKey = '';
            schedulePluginStorageFlush(request.scopeKey, { chatId: request.chatId, reason: `finish:${request.flow || 'request'}` });
        };
        const recordProviderCallStart = (context = {}) => {
            if (!shouldCapture()) return '';
            // Concurrent provider work must not inherit the most recently started request.
            const candidateKey = String(context.requestKey || '').trim();
            const requestKey = getRuntimeRequest(candidateKey) ? candidateKey : '';
            const startedAt = nowMs();
            const id = `llm_${stableHash(`${requestKey}:${context.label || ''}:${startedAt}:${Math.random()}`)}`;
            const entry = sanitizeValue({
                id,
                requestKey,
                unbound: !requestKey,
                startedAt,
                status: 'running',
                profile: context.profile || '',
                provider: context.provider || '',
                model: context.model || '',
                label: context.label || '',
                domain: context.domain || '',
                streamRequested: context.streamRequested === true,
                serviceTier: context.serviceTier || '',
                flexApplied: context.flexApplied === true,
                system: textDigest(context.systemPrompt || ''),
                user: textDigest(context.userContent || '')
            });
            // This ID was generated here, not accepted from provider/user content.
            entry.id = id;
            MemoryState.runtimeDebugProviderCalls = [entry, ...(MemoryState.runtimeDebugProviderCalls || [])].slice(0, PROVIDER_CALL_LIMIT);
            const request = getRuntimeRequest(requestKey);
            if (request) request.providerCallIds = [id, ...(request.providerCallIds || []).filter(item => item !== id)].slice(0, PROVIDER_CALL_LIMIT);
            schedulePluginStorageFlush(request?.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global', {
                chatId: request?.chatId || '',
                reason: `provider-start:${context.label || ''}`
            });
            return id;
        };
        const recordProviderCallFinish = (id = '', patch = {}) => {
            const normalized = String(id || '').trim();
            if (!normalized) return;
            const calls = Array.isArray(MemoryState.runtimeDebugProviderCalls) ? MemoryState.runtimeDebugProviderCalls : [];
            const index = calls.findIndex(item => item?.id === normalized);
            if (index < 0) return;
            const startedAt = Number(calls[index]?.startedAt || nowMs());
            calls[index] = sanitizeValue({
                ...calls[index],
                ...patch,
                finishedAt: nowMs(),
                durationMs: Math.max(0, nowMs() - startedAt)
            });
            MemoryState.runtimeDebugProviderCalls = calls.slice(0, PROVIDER_CALL_LIMIT);
            const request = getRuntimeRequest(calls[index]?.requestKey || '');
            schedulePluginStorageFlush(request?.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global', {
                chatId: request?.chatId || '',
                reason: `provider-finish:${calls[index]?.label || ''}`
            });
        };
        const ensureTurnBucket = (scopeKey, turn) => {
            if (!MemoryState.debugRecentTurnsByScope) MemoryState.debugRecentTurnsByScope = new Map();
            const scope = String(scopeKey || 'global').trim() || 'global';
            if (!MemoryState.debugRecentTurnsByScope.has(scope)) MemoryState.debugRecentTurnsByScope.set(scope, new Map());
            while (MemoryState.debugRecentTurnsByScope.size > 8) MemoryState.debugRecentTurnsByScope.delete(MemoryState.debugRecentTurnsByScope.keys().next().value);
            const turns = MemoryState.debugRecentTurnsByScope.get(scope);
            const key = getBucketKey(scope, turn);
            if (!turns.has(key)) {
                turns.set(key, {
                    turn: Number(turn || 0),
                    scopeHash: stableHash(scope),
                    startedAt: Date.now(),
                    updatedAt: Date.now(),
                    events: []
                });
            }
            const bucket = turns.get(key);
            bucket.updatedAt = Date.now();
            return { turns, bucket };
        };
        const pruneScope = (turns) => {
            const ordered = Array.from(turns.entries()).sort((a, b) => {
                const at = Number(a[1]?.turn || 0);
                const bt = Number(b[1]?.turn || 0);
                if (at !== bt) return at - bt;
                return Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0);
            });
            while (ordered.length > TURN_LIMIT) {
                const [key] = ordered.shift();
                turns.delete(key);
            }
        };
        const record = (level = 'debug', ...args) => {
            if (!shouldCapture()) return;
            let meta = {};
            if (args.length > 0) {
                const last = args[args.length - 1];
                if (last && typeof last === 'object' && last.__libraDebugMeta === true) {
                    meta = { ...last };
                    args.pop();
                    delete meta.__libraDebugMeta;
                }
            }
            const scopeKey = getScopeKey(meta);
            const turn = getRuntimeTurn(meta);
            const { turns, bucket } = ensureTurnBucket(scopeKey, turn);
            const event = {
                ts: Date.now(),
                level: clampText(level, 24),
                label: sanitizeValue(meta.label || meta.stage || 'runtime', 0, 'label'),
                message: 'Runtime diagnostic (free text omitted)',
                data: sanitizeValue(args.filter(arg => arg && typeof arg === 'object' && !(arg instanceof Error)).slice(0, 4))
            };
            if (event.data === undefined) delete event.data;
            bucket.events.push(event);
            if (bucket.events.length > EVENT_LIMIT_PER_TURN) {
                bucket.events.splice(0, bucket.events.length - EVENT_LIMIT_PER_TURN);
            }
            pruneScope(turns);
            schedulePluginStorageFlush(scopeKey, { chatId: MemoryState?._activeChatId || '', reason: `event:${event.level}` });
        };
        const getRuntimeRecords = (scopeKey = '') => {
            const scope = String(scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
            const turns = MemoryState.debugRecentTurnsByScope?.get(scope);
            if (!turns) return [];
            return Array.from(turns.values())
                .sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0))
                .slice(-TURN_LIMIT)
                .map(item => sanitizeValue(item));
        };
        const stripEntryAndFlush = (lore = [], context = {}) => {
            const base = (Array.isArray(lore) ? lore : []).filter(entry => String(entry?.comment || '') !== COMMENT);
            schedulePluginStorageFlush(context.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global', {
                chatId: context.chatId || MemoryState?._activeChatId || '',
                reason: 'persist-lore'
            });
            return base;
        };
        const getRuntimeRequests = (scopeKey = '') => {
            const scope = String(scopeKey || '').trim();
            const calls = Array.isArray(MemoryState.runtimeDebugProviderCalls) ? MemoryState.runtimeDebugProviderCalls : [];
            const byId = new Map(calls.map(call => [call?.id, call]).filter(item => item[0]));
            return (Array.isArray(MemoryState.runtimeDebugRecentRequestKeys) ? MemoryState.runtimeDebugRecentRequestKeys : [])
                .map(key => MemoryState.runtimeDebugRequestsByKey?.get?.(key))
                .filter(Boolean)
                .filter(request => !scope || String(request?.scopeKey || '') === scope)
                .map(request => sanitizeValue({
                    ...request,
                    providerCalls: (request.providerCallIds || []).map(id => byId.get(id)).filter(Boolean)
                }));
        };
        const getLoreForStats = (lore = []) => {
            try {
                if (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack) {
                    return LibraLoreConsolidator.unpack(lore);
                }
            } catch (_) {}
            return Array.isArray(lore) ? lore : [];
        };
        const buildLoreStats = (lore = []) => {
            const entries = getLoreForStats(lore);
            const counts = {};
            const bytesByComment = {};
            let managed = 0;
            let contentBytes = 0;
            for (const entry of entries) {
                const comment = String(entry?.comment || '').trim() || '(none)';
                const category = comment === 'lmai_memory' ? 'memory'
                    : comment === 'lmai_entity' ? 'entity'
                    : comment === 'lmai_relation' ? 'relation'
                    : ['lmai_world', 'lmai_world_graph', 'lmai_world_state', 'lmai_world_additional'].includes(comment) ? 'world'
                    : ['lmai_narrative', 'lmai_narrative_state', 'lmai_story_author'].includes(comment) ? 'narrative'
                    : comment.startsWith('lmai_') ? 'otherManaged' : comment === '(none)' ? 'empty' : 'external';
                counts[category] = Number(counts[category] || 0) + 1;
                const bytes = String(entry?.content || '').length;
                contentBytes += bytes;
                bytesByComment[category] = Number(bytesByComment[category] || 0) + bytes;
                if (comment.startsWith('lmai_')) managed += 1;
            }
            return {
                entryCount: entries.length,
                managedCount: managed,
                contentChars: contentBytes,
                counts,
                bytesByComment,
                debugEntryPresent: entries.some(entry => String(entry?.comment || '') === COMMENT)
            };
        };
        const buildProviderSnapshot = () => {
            const scrub = (cfg = {}) => ({
                provider: String(cfg?.provider || '').trim(),
                urlMode: cfg?.url ? 'custom' : 'default',
                keyConfigured: !!String(cfg?.key || '').trim() || ['ollama', 'lmstudio', 'lm_studio'].includes(String(cfg?.provider || '').trim().toLowerCase()),
                model: String(cfg?.model || '').trim(),
                timeout: Number(cfg?.timeout || 0) || 0,
                stream: cfg?.stream === true,
                reasoningPreset: String(cfg?.reasoningPreset || '').trim(),
                reasoningEffort: String(cfg?.reasoningEffort || '').trim(),
                maxCompletionTokens: Number(cfg?.maxCompletionTokens || 0) || 0,
                enabled: cfg?.enabled
            });
            const cfg = MemoryEngine?.CONFIG || {};
            return {
                main: scrub(cfg.llm || {}),
                aux: scrub(cfg.auxLlm || {}),
                embedding: scrub(cfg.embed || {}),
                useLLM: cfg.useLLM !== false
            };
        };
        const buildQueueSnapshot = () => ({
            llm: {
                active: Number(MaintenanceLLMQueue?.activeCount || 0) || 0,
                pending: Number(MaintenanceLLMQueue?.pendingCount || 0) || 0
            },
            background: {
                active: Number(BackgroundMaintenanceQueue?.activeCount || 0) || 0,
                pending: Number(BackgroundMaintenanceQueue?.pendingCount || 0) || 0
            },
            foreground: {
                active: Number(MemoryState.afterRequestForegroundTasksByScope?.size || 0) || 0,
                pending: 0
            },
            dashboard: sanitizeValue(MemoryState.activityDashboard || {})
        });
        const compactMapEntries = (map, limit = 8, mapValue = value => value) => {
            try {
                return Array.from(map?.entries?.() || [])
                    .slice(-limit)
                    .map(([key, value]) => sanitizeValue({ key, value: mapValue(value) }));
            } catch (_) {
                return [];
            }
        };
        const buildRuntimeDump = (lore = [], context = {}) => {
            const scopeKey = String(context.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
            const storagePayload = context.pluginStoragePayload && context.pluginStoragePayload.schema === STORAGE_SCHEMA
                ? context.pluginStoragePayload
                : null;
            const pendingTurnKeys = Array.from(MemoryState.pendingTurnCommits?.keys?.() || []).slice(-8);
            const afterOrigins = compactMapEntries(MemoryState.afterRequestOriginsByType, 8, queue => (Array.isArray(queue) ? queue : []).slice(-4).map(item => ({
                chatId: item?.chatId || '',
                requestType: item?.requestType || '',
                requestSequence: Number(item?.requestSequence || 0) || 0,
                queuedAt: Number(item?.queuedAt || 0) || 0,
                responseTransportMode: item?.responseTransportMode || '',
                user: textDigest(item?.canonicalUser?.raw || item?.canonicalUser?.strict || '')
            })));
            const transport = compactMapEntries(MemoryState.recentMainResponseTransportByChatId, 8, value => ({
                mode: value?.mode || '',
                source: value?.source || '',
                reliable: value?.reliable === true,
                observedAt: Number(value?.observedAt || 0) || 0,
                bodyStreamFlag: value?.bodyStreamFlag
            }));
            const outputCapture = compactMapEntries(MemoryState.recentMainResponseOutputCaptureByChatId, 8, value => ({
                requestSequence: Number(value?.requestSequence || 0) || 0,
                source: value?.source || '',
                transportMode: value?.transportMode || '',
                observedAt: Number(value?.observedAt || 0) || 0,
                display: textDigest(value?.displayContent || ''),
                memorySource: textDigest(value?.memorySourceText || ''),
                comparable: textDigest(value?.comparable || '')
            }));
            const runtimeRequests = getRuntimeRequests(scopeKey);
            const storageRequests = Array.isArray(storagePayload?.requests) ? storagePayload.requests : [];
            const mergedRequests = mergeByKey([...storageRequests, ...runtimeRequests], item => item?.key || '');
            const requestKeys = new Set(mergedRequests.map(request => request?.key).filter(Boolean));
            const runtimeProviderCalls = (Array.isArray(MemoryState.runtimeDebugProviderCalls) ? MemoryState.runtimeDebugProviderCalls : [])
                .filter(call => !call?.requestKey || requestKeys.has(call.requestKey));
            const storageProviderCalls = Array.isArray(storagePayload?.providerCalls) ? storagePayload.providerCalls : [];
            const mergedProviderCalls = mergeByKey([...storageProviderCalls, ...runtimeProviderCalls], item => item?.id || '').slice(0, PROVIDER_CALL_LIMIT);
            const storageStatus = getStorageStatus(scopeKey);
            const suppressedErrorTraceEnabled = MemoryEngine?.CONFIG?.debug === true;
            if (!suppressedErrorTraceEnabled && MemoryState.suppressedErrorStatsByKey?.size) {
                try { MemoryState.suppressedErrorStatsByKey.clear(); } catch (_) {}
            }
            const suppressedErrorTurnLimit = suppressedErrorTraceEnabled ? 2 : 0;
            const suppressedErrorScope = suppressedErrorTraceEnabled
                ? Array.from(MemoryState.suppressedErrorStatsByKey?.values?.() || [])
                    .filter(item => String(item?.scopeKey || 'global').trim() === scopeKey)
                : [];
            const suppressedErrorTurns = new Set(
                Array.from(new Set(suppressedErrorScope.map(item => Number(item?.turn || 0) || 0)))
                    .sort((a, b) => a - b)
                    .slice(-suppressedErrorTurnLimit)
            );
            const suppressedErrors = suppressedErrorScope
                .filter(item => suppressedErrorTurns.has(Number(item?.turn || 0) || 0))
                .sort((a, b) => (Number(b?.turn || 0) - Number(a?.turn || 0)) || (Number(b?.lastAt || 0) - Number(a?.lastAt || 0)))
                .slice(0, 24);
            return sanitizeValue({
                traceEnabled: MemoryEngine?.CONFIG?.debug === true,
                currentRequestKey: MemoryState.runtimeDebugCurrentRequestKey || '',
                recentRequestKeys: Array.isArray(MemoryState.runtimeDebugRecentRequestKeys) ? MemoryState.runtimeDebugRecentRequestKeys : [],
                requests: mergedRequests.slice(-REQUEST_LIMIT),
                providerCalls: mergedProviderCalls,
                queues: buildQueueSnapshot(),
                suppressedErrorTurnLimit,
                suppressedErrors,
                pending: {
                    turnCommitScopes: pendingTurnKeys,
                    afterRequestOrigins: afterOrigins,
                    streamRecoveryTimers: Array.from(MemoryState.streamOutputRecoveryTimersByChatId?.keys?.() || []).slice(-8),
                    afterRequestMissingTimers: Array.from(MemoryState.afterRequestMissingRecoveryTimersByChatId?.keys?.() || []).slice(-8),
                    foregroundMaintenanceScopes: Array.from(MemoryState.afterRequestForegroundTasksByScope?.keys?.() || []).slice(-8),
                    turnMaintenanceLocks: Array.from(MemoryState.turnMaintenanceLocksByChatId?.keys?.() || []).slice(-8)
                },
                responseStreaming: {
                    compatEnabled: MemoryEngine?.CONFIG?.responseStreamingCompatEnabled !== false,
                    outputHandlerRegistered: !!libraResponseStreamingOutputHandler,
                    editOutputHandlerRegistered: !!libraResponseStreamingEditOutputHandler,
                    transport,
                    outputCapture
                },
                storage: {
                    ...buildLoreStats(lore),
                    debugPluginStorage: {
                        key: getStorageKey(scopeKey),
                        present: !!storagePayload,
                        updatedAt: storagePayload?.updatedAt || '',
                        turnCount: Array.isArray(storagePayload?.turns) ? storagePayload.turns.length : 0,
                        requestCount: Array.isArray(storagePayload?.requests) ? storagePayload.requests.length : 0,
                        providerCallCount: Array.isArray(storagePayload?.providerCalls) ? storagePayload.providerCalls.length : 0,
                        lastStatus: storageStatus || null
                    }
                },
                providers: buildProviderSnapshot(),
                operationalHealth: {
                    metrics: (() => { try { return sanitizeValue(LIBRA_Metrics?.snapshot?.() || {}); } catch (_) { return {}; } })(),
                    recall: sanitizeValue(MemoryState.recallRuntimeStats || {}),
                    dashboard: (() => { try { return sanitizeValue(ActivityDashboardCore?.selfCheck?.() || {}); } catch (_) { return {}; } })()
                },
                selfCheck: {
                    debugEnabled: MemoryEngine?.CONFIG?.debug === true,
                    scopeKey,
                    legacyDebugLoreEntry: (Array.isArray(lore) ? lore : []).some(entry => String(entry?.comment || '') === COMMENT),
                    pluginStorageDebug: !!storagePayload,
                    risuApi: {
                        beforeRequestHook: RisuCompat.has?.('addRisuReplacer') || RisuCompat.has?.('addReplacer'),
                        afterRequestHook: RisuCompat.has?.('addRisuReplacer') || RisuCompat.has?.('addReplacer'),
                        bodyInterceptor: RisuCompat.has?.('registerBodyIntercepter'),
                        scriptHandler: RisuCompat.has?.('addRisuScriptHandler')
                    }
                }
            });
        };
        const buildExportPayload = (lore = [], context = {}) => {
            const scopeKey = String(context.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
            const storagePayload = context.pluginStoragePayload && context.pluginStoragePayload.schema === STORAGE_SCHEMA
                ? context.pluginStoragePayload
                : null;
            const runtimeTurns = getRuntimeRecords(scopeKey);
            const storageTurns = Array.isArray(storagePayload?.turns) ? storagePayload.turns : [];
            const merged = [...storageTurns, ...runtimeTurns]
                .sort((a, b) => Number(a?.turn || 0) - Number(b?.turn || 0) || Number(a?.updatedAt || 0) - Number(b?.updatedAt || 0));
            const byTurn = new Map();
            for (const item of merged) {
                const key = String(Number(item?.turn || 0));
                byTurn.set(key, sanitizeValue(item));
            }
            return {
                schema: EXPORT_SCHEMA,
                version: 2,
                exportedAt: new Date().toISOString(),
                plugin: 'LIBRA World Manager',
                pluginVersion: PLUGIN_VERSION,
                scope: {
                    chatId: context.chatId ? `opaque:${stableHash(String(context.chatId))}` : '',
                    scopeHash: stableHash(scopeKey)
                },
                policy: {
                    runtimeTraceOutput: true,
                    operationalHistory: 'session-only; cleared on restart',
                    operationalEventLimit: OPERATION_LIMIT,
                    operationalContextLimit: OPERATION_CONTEXT_LIMIT,
                    debugPhaseLimit: PHASE_LIMIT,
                    debugScopeLimit: 8,
                    operationalRetentionMs: OPERATION_RETENTION_MS,
                    automaticDebugPersistence: false,
                    debugPersistence: 'explicit export snapshot only; older snapshots preserved',
                    rawPromptResponseText: false,
                    persistentLocation: `pluginStorage ${getStorageKey(scopeKey)}`,
                    turnLimit: TURN_LIMIT,
                    requestTraceLimit: REQUEST_LIMIT,
                    pluginStorage: 'recent two-turn runtime debug trace'
                },
                operations: getOperationalRecords(scopeKey),
                turns: Array.from(byTurn.values()).slice(-TURN_LIMIT),
                runtime: buildRuntimeDump(lore, { ...context, scopeKey, pluginStoragePayload: storagePayload })
            };
        };
        const buildExportPayloadAsync = async (lore = [], context = {}) => {
            const scopeKey = String(context.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
            const flushed = await flushPluginStorage(scopeKey, {
                chatId: context.chatId || MemoryState?._activeChatId || '',
                reason: 'debug-export'
            });
            const stored = flushed || await readPluginStoragePayload(scopeKey);
            return buildExportPayload(lore, { ...context, scopeKey, pluginStoragePayload: stored });
        };
        return Object.freeze({
            COMMENT,
            record,
            stripEntryAndFlush,
            buildExportPayload,
            buildExportPayloadAsync,
            getRuntimeRecords,
            getOperationalRecords,
            clearOperationalRecords: () => { operationalEvents = []; operationContexts.clear(); },
            startRequest,
            updateRequestContext,
            recordPhase,
            finishRequest,
            recordProviderCallStart,
            recordProviderCallFinish,
            textDigest,
            countRoles,
            latestUserDigest
        });
    })();
