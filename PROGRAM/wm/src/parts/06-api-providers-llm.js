    // ══════════════════════════════════════════════════════════════
    // [UTILITY] LRU Cache
    // ══════════════════════════════════════════════════════════════
    class LRUCache {
        constructor(maxSize = 1000, options = {}) {
            const opts = options && typeof options === 'object' ? options : {};
            this.cache = new Map();
            this.entryBytes = new Map();
            this.maxSize = Math.max(1, Math.floor(Number(maxSize) || 1000));
            this.maxBytes = Math.max(0, Math.floor(Number(opts.maxBytes || 0) || 0));
            this.totalBytes = 0;
            this.label = String(opts.label || 'lru');
            this.hits = 0;
            this.misses = 0;
            try { ResourceGovernor?.registerCache?.(this); } catch (_) {}
        }

        _estimate(k, v) {
            try { return Math.max(32, ResourceGovernor?.estimateBytes?.([k, v], { maxDepth: 4, maxNodes: 192 }) || 0); }
            catch (_) { return Math.max(32, (String(k || '').length + String(v || '').length) * 2 + 64); }
        }

        _effectiveMaxBytes() {
            if (!this.maxBytes) return 0;
            try { return ResourceGovernor?.getCacheBudget?.(this.label, this.maxBytes) || this.maxBytes; }
            catch (_) { return this.maxBytes; }
        }

        _deleteOldest() {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) return false;
            return this.delete(oldest);
        }

        _enforceLimits() {
            const byteLimit = this._effectiveMaxBytes();
            while (this.cache.size > this.maxSize || (byteLimit > 0 && this.totalBytes > byteLimit)) {
                if (!this._deleteOldest()) break;
            }
        }

        get(k) {
            if (!this.cache.has(k)) { this.misses++; return undefined; }
            this.hits++;
            const v = this.cache.get(k);
            this.cache.delete(k);
            this.cache.set(k, v);
            return v;
        }

        peek(k) { return this.cache.get(k); }

        set(k, v) {
            if (this.cache.has(k)) this.delete(k);
            const bytes = this._estimate(k, v);
            this.cache.set(k, v);
            this.entryBytes.set(k, bytes);
            this.totalBytes += bytes;
            this._enforceLimits();
            try { ResourceGovernor?.touch?.(`cache:${this.label}`); } catch (_) {}
            return this;
        }

        has(k) { return this.cache.has(k); }
        delete(k) {
            if (!this.cache.has(k)) return false;
            const bytes = Number(this.entryBytes.get(k) || 0) || 0;
            this.entryBytes.delete(k);
            const deleted = this.cache.delete(k);
            if (deleted) this.totalBytes = Math.max(0, this.totalBytes - bytes);
            return deleted;
        }
        trimToSize(targetSize = this.maxSize) {
            const target = Math.max(0, Math.floor(Number(targetSize || 0) || 0));
            let removed = 0;
            while (this.cache.size > target) { if (!this._deleteOldest()) break; removed += 1; }
            return removed;
        }
        trimToBytes(targetBytes = this.maxBytes) {
            const target = Math.max(0, Math.floor(Number(targetBytes || 0) || 0));
            if (!target) return 0;
            let removed = 0;
            while (this.totalBytes > target && this.cache.size > 0) { if (!this._deleteOldest()) break; removed += 1; }
            return removed;
        }
        clear() { this.cache.clear(); this.entryBytes.clear(); this.totalBytes = 0; this.hits = 0; this.misses = 0; }
        dispose() { this.clear(); try { ResourceGovernor?.unregisterCache?.(this); } catch (_) {} }
        get stats() {
            const total = this.hits + this.misses;
            return { size: this.cache.size, bytes: this.totalBytes, maxBytes: this.maxBytes, hitRate: total > 0 ? +(this.hits / total).toFixed(3) : 0 };
        }
    }

    // ══════════════════════════════════════════════════════════════
    // [API] Providers
    // ══════════════════════════════════════════════════════════════
    const DEFAULT_REASONING_BUDGET_TOKENS = 0;
    const DEFAULT_MAX_COMPLETION_TOKENS = 16000;
    const DEFAULT_AUX_MAX_COMPLETION_TOKENS = 12000;
    const REASONING_PRESETS = {
        auto: {
            label: '자동 감지',
            reasoningEffort: 'none',
            reasoningBudgetTokens: DEFAULT_REASONING_BUDGET_TOKENS,
            maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS,
            glmThinkingType: 'enabled',
            hint: '모델/URL을 보고 GPT, Gemini, Claude, GLM 계열을 자동 판단합니다.'
        },
        gpt: {
            label: 'GPT',
            reasoningEffort: 'medium',
            reasoningBudgetTokens: 0,
            maxCompletionTokens: 20000,
            glmThinkingType: 'disabled',
            hint: 'GPT 계열은 Reasoning Effort와 Max Completion Tokens를 주로 사용합니다.'
        },
        gemini: {
            label: 'Gemini',
            reasoningEffort: 'none',
            reasoningBudgetTokens: 8192,
            maxCompletionTokens: 20000,
            glmThinkingType: 'disabled',
            hint: 'Gemini 계열은 Thinking Budget과 Max Completion Tokens를 주로 사용합니다.'
        },
        claude: {
            label: 'Claude',
            reasoningEffort: 'none',
            reasoningBudgetTokens: 4096,
            maxCompletionTokens: 20000,
            glmThinkingType: 'disabled',
            hint: 'Claude 계열은 Thinking Budget으로 추론을 켜고, Max Completion Tokens를 넉넉히 잡는 편이 좋습니다.'
        },
        deepseek: {
            label: 'DeepSeek',
            reasoningEffort: 'none',
            reasoningBudgetTokens: 1024,
            maxCompletionTokens: 20000,
            glmThinkingType: 'disabled',
            hint: 'DeepSeek 계열은 OpenAI 호환 요청의 thinking 설정과 Reasoning Budget을 사용합니다.'
        },
        kimi: {
            label: 'Kimi',
            reasoningEffort: 'none',
            reasoningBudgetTokens: 1024,
            maxCompletionTokens: 20000,
            glmThinkingType: 'disabled',
            hint: 'Kimi/Moonshot 계열은 OpenAI 호환 요청의 thinking 설정과 Reasoning Budget을 사용합니다.'
        },
        glm: {
            label: 'GLM',
            reasoningEffort: 'none',
            reasoningBudgetTokens: 0,
            maxCompletionTokens: 24000,
            glmThinkingType: 'enabled',
            hint: 'GLM 계열은 Zhipu 공식 thinking.type을 사용합니다. 현재 LIBRA에서는 enabled/disabled를 직접 조정합니다.'
        },
        custom: {
            label: '커스텀',
            reasoningEffort: 'none',
            reasoningBudgetTokens: DEFAULT_REASONING_BUDGET_TOKENS,
            maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS,
            glmThinkingType: 'disabled',
            hint: '모든 추론 항목을 직접 조정합니다.'
        }
    };
    const REASONING_BUDGET_FAMILIES = Object.freeze(['gemini', 'claude', 'deepseek', 'kimi', 'glm']);
    const isGLMLikeConfig = (llmConfig = {}) => {
        const model = String(llmConfig?.model || '').trim().toLowerCase();
        const url = String(llmConfig?.url || '').trim().toLowerCase();
        const provider = String(llmConfig?.provider || '').trim().toLowerCase();
        return /^glm[-\d.]/i.test(model)
            || /(?:open\.)?bigmodel\.cn|zhipu/i.test(url)
            || (provider === 'custom' && /^glm/i.test(model));
    };
    const isDeepSeekLikeConfig = (llmConfig = {}) => {
        const text = `${llmConfig?.provider || ''} ${llmConfig?.url || ''} ${llmConfig?.model || ''}`.toLowerCase();
        return /deepseek/.test(text);
    };
    const isKimiLikeConfig = (llmConfig = {}) => {
        const text = `${llmConfig?.provider || ''} ${llmConfig?.url || ''} ${llmConfig?.model || ''}`.toLowerCase();
        return /kimi|moonshot/.test(text);
    };
    const isGemmaLikeConfig = (llmConfig = {}) => {
        const text = `${llmConfig?.provider || ''} ${llmConfig?.url || ''} ${llmConfig?.model || ''}`.toLowerCase();
        return /(?:^|[\/\s:_-])gemma(?:\d|[\s:_-]|$)/.test(text);
    };
    const detectReasoningFamily = (llmConfig = {}) => {
        if (isGLMLikeConfig(llmConfig)) return 'glm';
        if (isDeepSeekLikeConfig(llmConfig)) return 'deepseek';
        if (isKimiLikeConfig(llmConfig)) return 'kimi';
        if (isGemmaLikeConfig(llmConfig)) return 'gemini';
        const provider = String(llmConfig?.provider || '').trim().toLowerCase();
        if (provider === 'claude') return 'claude';
        if (provider === 'gemini' || provider === 'vertex') return 'gemini';
        return 'gpt';
    };
    const getEffectiveReasoningRuntimeFamily = (llmConfig = {}) => {
        const requested = String(llmConfig?.reasoningPreset || 'auto').trim().toLowerCase();
        if (requested === 'gpt' || requested === 'gemini' || requested === 'claude' || requested === 'deepseek' || requested === 'kimi' || requested === 'glm') return requested;
        return detectReasoningFamily(llmConfig);
    };
    const getReasoningPresetDefinition = (presetKey = 'auto') => REASONING_PRESETS[String(presetKey || 'auto').trim().toLowerCase()] || REASONING_PRESETS.auto;
    const clampProviderTokenCount = (value, fallback = 1000, min = 1, max = 100000) => {
        const parsed = Math.floor(Number(value));
        const fallbackValue = Math.floor(Number(fallback));
        const normalized = Number.isFinite(parsed) && parsed > 0
            ? parsed
            : (Number.isFinite(fallbackValue) && fallbackValue > 0 ? fallbackValue : 1000);
        return Math.max(min, Math.min(max, normalized));
    };
    // 일부 ollama 모델은 think 파라미터 자체를 모르고 400 을 낸다(qwen3-coder 등).
    // 모델별로 한 번 확인한 뒤에는 파라미터를 아예 보내지 않는다.
    const ollamaThinkUnsupported = new Set();
    const noteOllamaThinkUnsupported = (model = '') => {
        const key = String(model || '').trim().toLowerCase();
        if (key) ollamaThinkUnsupported.add(key);
        return key;
    };
    const ollamaSupportsThinkField = (model = '') => !ollamaThinkUnsupported.has(String(model || '').trim().toLowerCase());

    const resolveProviderOutputBudget = (llmConfig = {}, options = {}, reasoningFamily = '') => {
        const requestedTokens = clampProviderTokenCount(options?.maxTokens, 1000);
        const configuredCapRaw = Math.floor(Number(llmConfig?.maxCompletionTokens));
        const configuredCap = Number.isFinite(configuredCapRaw) && configuredCapRaw > 0
            ? clampProviderTokenCount(configuredCapRaw, requestedTokens)
            : requestedTokens;
        // A profile max is a ceiling. It must never inflate a small per-task request.
        const providerMaxTokens = Math.max(1, Math.min(requestedTokens, configuredCap));
        const requestedReasoningBudget = Math.max(0, Math.floor(Number(llmConfig?.reasoningBudgetTokens) || 0));
        const explicitlyDisabled = options?.disableReasoning === true
            || options?.noReasoning === true
            || String(options?.reasoningPresetOverride || '').trim().toLowerCase() === 'off';
        const smallBudgetDisabled = providerMaxTokens < 512 && options?.allowReasoningForSmallBudget !== true;
        const effort = String(llmConfig?.reasoningEffort || 'none').trim().toLowerCase();
        const family = String(reasoningFamily || '').trim().toLowerCase();
        const familyDefaultsToReasoning = ['deepseek', 'kimi', 'glm'].includes(family);
        const reasoningRequested = requestedReasoningBudget > 0 || (effort && effort !== 'none') || familyDefaultsToReasoning;
        const reasoningAllowed = !explicitlyDisabled && !smallBudgetDisabled && reasoningRequested;
        // Providers that count hidden thinking inside the output cap still need room
        // for the JSON/text answer. Keep at least 35% (minimum 128 tokens) visible.
        const minimumVisibleTokens = Math.min(providerMaxTokens, Math.max(128, Math.ceil(providerMaxTokens * 0.35)));
        const reasoningBudgetTokens = reasoningAllowed
            ? Math.min(requestedReasoningBudget, Math.max(0, providerMaxTokens - minimumVisibleTokens))
            : 0;
        return Object.freeze({
            requestedTokens,
            configuredCap,
            providerMaxTokens,
            requestedReasoningBudget,
            reasoningBudgetTokens,
            minimumVisibleTokens,
            reasoningAllowed,
            reasoningDisabledReason: explicitlyDisabled ? 'explicit' : (smallBudgetDisabled ? 'small_budget' : '')
        });
    };
    class BaseProvider {
        async callLLM(config, systemPrompt, userContent, options) { throw new Error('Not implemented'); }
        async getEmbedding(config, text) { throw new Error('Not implemented'); }
        
        _checkKey(key) {
            if (!key || key.trim() === '') {
                throw new LIBRAError('API Key is missing. Please check your settings.', 'MISSING_KEY');
            }
        }

        _checkUrl(url, kind = 'API URL') {
            if (!url || String(url).trim() === '') {
                throw new LIBRAError(`${kind} is missing. Please check your settings.`, 'MISSING_URL');
            }
        }

        _normalizeUrl(url, suffix) {
            const raw = String(url || '').trim();
            this._checkUrl(raw);
            const normalizedSuffix = String(suffix || '');
            if (!normalizedSuffix) return raw;
            if (raw.includes(normalizedSuffix)) return raw;
            return raw.replace(/\/$/, '') + normalizedSuffix;
        }

        _appendApiKey(url, apiKey) {
            const raw = String(url || '').trim();
            if (!apiKey || raw.includes('key=')) return raw;
            return `${raw}${raw.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
        }

        _extractTextParts(content) {
            const parts = Array.isArray(content?.parts) ? content.parts : [];
            return parts
                .filter(part => part && !part.thought)
                .map(part => String(part?.text || '').trim())
                .filter(Boolean)
                .join('\n\n');
        }

        _ensureNonEmptyText(content, data, providerLabel = 'LLM') {
            const text = String(content || '').trim();
            if (text) return text;
            const finishReason = data?.candidates?.[0]?.finishReason
                || data?.choices?.[0]?.finish_reason
                || data?.done_reason
                || data?.doneReason
                || data?.generate?.done_reason
                || data?.chat?.done_reason
                || data?.stop_reason
                || data?.error?.message
                || 'unknown';
            throw new LIBRAError(`${providerLabel} returned no text content (finishReason=${finishReason})`, 'EMPTY_RESPONSE', data);
        }

        _retryHeaderValue(headers, name) {
            try {
                if (typeof headers?.get === 'function') return headers.get(name);
                const key = Object.keys(headers || {}).find(item => String(item).toLowerCase() === String(name).toLowerCase());
                return key ? headers[key] : null;
            } catch (_) { return null; }
        }

        _parseRetryDelayMs(response, policy = {}) {
            const minDelayMs = Math.max(0, Number(policy.minDelayMs || 600) || 600);
            const maxDelayMs = Math.max(minDelayMs, Number(policy.maxDelayMs || 5000) || 5000);
            const retryAfter = String(this._retryHeaderValue(response?.headers, 'retry-after') || '').trim();
            let headerDelay = 0;
            if (retryAfter) {
                const seconds = Number(retryAfter);
                if (Number.isFinite(seconds)) headerDelay = Math.max(0, seconds * 1000);
                else {
                    const at = Date.parse(retryAfter);
                    if (Number.isFinite(at)) headerDelay = Math.max(0, at - Date.now());
                }
            }
            if (!headerDelay) {
                const resetNames = [
                    'x-ratelimit-reset-requests',
                    'x-ratelimit-reset-tokens',
                    'anthropic-ratelimit-requests-reset',
                    'anthropic-ratelimit-tokens-reset'
                ];
                for (const name of resetNames) {
                    const raw = String(this._retryHeaderValue(response?.headers, name) || '').trim();
                    if (!raw) continue;
                    const numeric = Number(raw);
                    const parsed = Number.isFinite(numeric)
                        ? (numeric > 1e9 ? numeric * 1000 - Date.now() : numeric * 1000)
                        : (Date.parse(raw) - Date.now());
                    if (Number.isFinite(parsed) && parsed > 0) headerDelay = Math.max(headerDelay, parsed);
                }
            }
            const jitter = Math.floor(Math.random() * Math.max(50, Math.min(250, minDelayMs * 0.25)));
            // Never retry sooner than a provider-directed reset. The caller can
            // decline a delay that exceeds its bounded retry window/deadline.
            if (headerDelay > maxDelayMs) return Math.ceil(headerDelay);
            return Math.min(maxDelayMs, Math.max(minDelayMs, headerDelay || minDelayMs) + jitter);
        }

        _normalizeRetryPolicy(options = {}) {
            const raw = options?.retryPolicy;
            if (!raw || raw.enabled === false) return { enabled: false, maxRetries: 0, statuses: new Set() };
            const statuses = new Set((Array.isArray(raw.statuses) ? raw.statuses : [429, 502, 503, 504])
                .map(value => Number(value))
                .filter(value => Number.isFinite(value)));
            return {
                enabled: true,
                maxRetries: Math.max(0, Math.min(2, Math.floor(Number(raw.maxRetries ?? 1) || 0))),
                minDelayMs: Math.max(0, Math.min(10000, Number(raw.minDelayMs || 600) || 600)),
                maxDelayMs: Math.max(250, Math.min(30000, Number(raw.maxDelayMs || 5000) || 5000)),
                deadlineAt: Math.max(0, Number(raw.deadlineAt || options?.deadlineAt || 0) || 0),
                statuses
            };
        }

        _isRetryableNetworkError(error) {
            if (!error) return false;
            if (error?.name === 'AbortError' || error?.code === 'ANALYSIS_DEADLINE') return false;
            return /timeout|timed out|network|fetch failed|temporarily unavailable|connection reset|econnreset|socket hang up/i.test(String(error?.message || error));
        }

        async _waitForRetry(delayMs, signal) {
            const waitMs = Math.max(0, Math.floor(Number(delayMs) || 0));
            if (!waitMs) return;
            if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
            await new Promise((resolve, reject) => {
                let timer = null;
                const abort = () => {
                    if (timer != null) clearTimeout(timer);
                    signal?.removeEventListener?.('abort', abort);
                    reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
                };
                timer = setTimeout(() => {
                    signal?.removeEventListener?.('abort', abort);
                    resolve();
                }, waitMs);
                signal?.addEventListener?.('abort', abort, { once: true });
            });
        }

        async _fetchRaw(url, requestInit, timeoutMs = 120000, options = {}) {
            const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs || 120000) || 120000);
            const request = { ...(requestInit || {}) };
            if (options?.signal && !request.signal) request.signal = options.signal;
            const requestUrl = url;
            const requestPayload = request;
            const retryPolicy = this._normalizeRetryPolicy(options);
            const observe=async(phase,detail)=>{
                if(typeof options?.retryPolicy?.attemptObserver!=='function')return null;
                try{return await options.retryPolicy.attemptObserver(phase,detail);}
                catch(error){throw new LIBRAError('Extension attempt persistence unavailable','EXTENSION_ATTEMPT_PERSISTENCE',error);}
            };
            let retryCount = 0;
            for (;;) {
                if (requestPayload.signal?.aborted) throw requestPayload.signal.reason || new DOMException('Aborted', 'AbortError');
                const remainingMs = retryPolicy.deadlineAt > 0 ? Math.max(0, retryPolicy.deadlineAt - Date.now()) : Number.POSITIVE_INFINITY;
                if (Number.isFinite(remainingMs) && remainingMs <= 1000) throw new LIBRAError('LIBRA analysis deadline reached before provider request', 'ANALYSIS_DEADLINE');
                // Persist a dispatch reservation, not a claim of remote acceptance. A crash
                // between this save and request completion remains explicitly unresolved.
                const attempt=await observe('reserve',{retryIndex:retryCount});
                const afterSaveRemaining=retryPolicy.deadlineAt>0?retryPolicy.deadlineAt-Date.now():Number.POSITIVE_INFINITY;
                if(requestPayload.signal?.aborted || afterSaveRemaining<=1000){
                    await observe('not_dispatched',{attempt});
                    throw requestPayload.signal?.reason || new LIBRAError('LIBRA analysis deadline reached before provider request','ANALYSIS_DEADLINE');
                }
                const attemptTimeoutMs=Number.isFinite(afterSaveRemaining)?Math.max(1000,Math.min(effectiveTimeoutMs,afterSaveRemaining-250)):effectiveTimeoutMs;
                let res;
                try {res=await RisuCompat.request(requestUrl,requestPayload,{timeoutMs:attemptTimeoutMs});}
                catch(error){
                    await observe('error',{attempt,code:String(error?.code || error?.name || 'transport_error').slice(0,80)});
                    const canRetry=retryPolicy.enabled && retryCount<retryPolicy.maxRetries && this._isRetryableNetworkError(error);
                    if(!canRetry)throw error;
                    const delayMs=this._parseRetryDelayMs(null,retryPolicy);
                    const remainingAfterError=retryPolicy.deadlineAt>0?retryPolicy.deadlineAt-Date.now():Number.POSITIVE_INFINITY;
                    if(Number.isFinite(remainingAfterError)&&delayMs+1000>=remainingAfterError)throw error;
                    retryCount+=1;
                    recordRuntimeDebug('warn',`[LIBRA][LLM] transient network error; retry ${retryCount}/${retryPolicy.maxRetries} in ${delayMs}ms`,error?.message || error);
                    await this._waitForRetry(delayMs,requestPayload.signal);continue;
                }
                await observe(res?'response':'error',res?{attempt,status:Number(res.status || 0) || 0}:{attempt,code:'MISSING_RESPONSE'});
                if(!res)return {ok:false,status:500,text:async()=>'RisuAI internal fetch error (undefined response)'};
                const status=Number(res.status || 0) || 0;
                if(!(retryPolicy.enabled && retryCount<retryPolicy.maxRetries && retryPolicy.statuses.has(status)))return res;
                const delayMs=this._parseRetryDelayMs(res,retryPolicy);
                if(delayMs>retryPolicy.maxDelayMs)return res;
                const remainingAfterResponse=retryPolicy.deadlineAt>0?retryPolicy.deadlineAt-Date.now():Number.POSITIVE_INFINITY;
                if(Number.isFinite(remainingAfterResponse)&&delayMs+1000>=remainingAfterResponse)return res;
                try{await res.body?.cancel?.('libra_provider_retry');}catch(_){}
                retryCount+=1;
                recordRuntimeDebug('warn',`[LIBRA][LLM] transient HTTP ${status}; retry ${retryCount}/${retryPolicy.maxRetries} in ${delayMs}ms`);
                await this._waitForRetry(delayMs,requestPayload.signal);
            }
        }

        _redactDebugString(value, limit = 800) {
            let text = String(value ?? '');
            text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]');
            text = text.replace(/([?&](?:key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization)=)[^&\s]+/gi, '$1[REDACTED]');
            text = text.replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED_KEY]');
            text = text.replace(/([A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{12,}\.[A-Za-z0-9_\-]{12,})/g, '[REDACTED_TOKEN]');
            return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
        }
        _redactForDebug(value, depth = 0, keyHint = '') {
            if (depth > 5) return '[MaxDepth]';
            if (/(^|[_\-.])(key|authorization|api[-_]?key|token|secret|private[_-]?key|password|credential|bearer)($|[_\-.])/i.test(String(keyHint || ''))) return '[REDACTED]';
            if (value == null || typeof value !== 'object') {
                if (typeof value === 'string') return this._redactDebugString(value);
                return value;
            }
            if (Array.isArray(value)) return value.slice(0, 8).map(item => this._redactForDebug(item, depth + 1, keyHint));
            const out = {};
            for (const [key, val] of Object.entries(value)) {
                if (/(^|[_\-.])(key|authorization|api[-_]?key|token|secret|private[_-]?key|password|credential|bearer)($|[_\-.])/i.test(key)) {
                    out[key] = '[REDACTED]';
                } else if (/messages|contents|prompt|input|text|content/i.test(key)) {
                    const text = JSON.stringify(val);
                    out[key] = text.length > 1200 ? `${this._redactDebugString(text, 1200)}...[truncated]` : this._redactForDebug(val, depth + 1, key);
                } else {
                    out[key] = this._redactForDebug(val, depth + 1, key);
                }
            }
            return out;
        }

        _debugPayloadForTrace(url, headers, body) {
            if (MemoryEngine.CONFIG?.debugVerbosePayload === true) {
                return this._redactForDebug({ url, headers, body });
            }
            const digestText = (value) => {
                const text = String(value ?? '');
                const trimmed = text.trim();
                return {
                    chars: text.length,
                    trimmedChars: trimmed.length,
                    hash: trimmed ? stableHash(trimmed) : '',
                    empty: !trimmed
                };
            };
            const summarize = (value, keyHint = '', depth = 0) => {
                const key = String(keyHint || '');
                if (/authorization|api[-_]?key|token|secret|private[_-]?key|password/i.test(key)) return '[REDACTED]';
                if (value == null) return value;
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                    if (/messages|contents|prompt|input|text|content/i.test(key)) return digestText(value);
                    const text = String(value);
                    return text.length > 180 ? `${text.slice(0, 180)}...[truncated]` : value;
                }
                if (depth > 5) return '[MaxDepth]';
                if (Array.isArray(value)) return value.slice(0, 10).map(item => summarize(item, key, depth + 1));
                if (typeof value === 'object') {
                    const out = {};
                    for (const [childKey, childValue] of Object.entries(value).slice(0, 48)) {
                        out[childKey] = summarize(childValue, childKey, depth + 1);
                    }
                    return out;
                }
                return digestText(value);
            };
            return {
                url,
                headers: summarize(headers, 'headers'),
                body: summarize(body, 'body')
            };
        }

        async _fetch(url, headers, body, timeoutMs = 120000, options = {}) {
            if (MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('debug', "[LIBRA Debug] API Request Payload:", JSON.stringify(this._debugPayloadForTrace(url, headers, body), null, 2));
            }
            let response = await this._fetchRaw(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            }, timeoutMs, { ...options, stream: false });
            let prefetchedErrorBody = '';
            if (response && !response.ok && body && Object.prototype.hasOwnProperty.call(body, 'think')) {
                prefetchedErrorBody = await response.text().catch(() => '');
                if (/does not support thinking|does not support think|unsupported[^.]{0,24}think/i.test(prefetchedErrorBody)) {
                    noteOllamaThinkUnsupported(body?.model);
                    const retryBody = { ...body };
                    delete retryBody.think;
                    prefetchedErrorBody = '';
                    response = await this._fetchRaw(url, {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(retryBody)
                    }, timeoutMs, { ...options, stream: false });
                }
            }
            if (!response || !response.ok) {
                const status = response?.status || 'Unknown';
                const errorBody = prefetchedErrorBody || await response?.text().catch(() => 'No error body') || 'No response';
                throw new LIBRAError(`API Error: ${status} - ${errorBody}`, 'API_ERROR');
            }
            const rawText = await response.text().catch(() => '');
            try {
                return JSON.parse(rawText);
            } catch (parseError) {
                if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] API response JSON parse failed:', {
                        status: response.status || 0,
                        contentType: response.headers?.get?.('content-type') || '',
                        error: parseError?.message || String(parseError || ''),
                        body: {
                            chars: rawText.length,
                            preview: rawText.slice(0, 900)
                        }
                    });
                }
                if (!String(rawText || '').trim()) {
                    throw new LIBRAError(`API response was not valid JSON: ${parseError?.message || parseError}`, 'API_PARSE_ERROR');
                }
                return { choices: [{ message: { content: rawText } }], rawText };
            }
        }


        _safeParseJson(value) {
            const raw = String(value || '').trim();
            if (!raw || raw === '[DONE]') return null;
            try { return JSON.parse(raw); } catch (_) { return null; }
        }

        _normalizeUsage(usage = {}, provider = '') {
            const raw = usage && typeof usage === 'object' ? usage : {};
            const promptTokens = raw.prompt_tokens ?? raw.promptTokenCount ?? raw.prompt_token_count ?? raw.input_tokens ?? raw.inputTokens;
            const completionTokens = raw.completion_tokens ?? raw.candidatesTokenCount ?? raw.candidates_token_count ?? raw.output_tokens ?? raw.outputTokens;
            const totalTokens = raw.total_tokens ?? raw.totalTokenCount ?? raw.total_token_count ?? raw.totalTokens;
            const reasoningTokens = raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens ?? raw.thoughtsTokenCount ?? raw.thoughts_token_count ?? raw.reasoningTokens;
            const cacheCreationTokens = raw.cache_creation_input_tokens
                ?? raw.cacheCreationInputTokens
                ?? raw.prompt_tokens_details?.cache_write_tokens
                ?? raw.input_tokens_details?.cache_write_tokens;
            const cacheReadTokens = raw.cache_read_input_tokens
                ?? raw.cacheReadInputTokens;
            const cachedInputTokens = raw.prompt_tokens_details?.cached_tokens
                ?? raw.input_tokens_details?.cached_tokens
                ?? raw.cachedContentTokenCount
                ?? raw.cached_content_token_count
                ?? raw.cached_input_tokens
                ?? raw.cachedInputTokens
                ?? ((Number(cacheCreationTokens) || 0) + (Number(cacheReadTokens) || 0) || undefined);
            const out = {
                prompt_tokens: Number.isFinite(Number(promptTokens)) ? Number(promptTokens) : undefined,
                completion_tokens: Number.isFinite(Number(completionTokens)) ? Number(completionTokens) : undefined,
                total_tokens: Number.isFinite(Number(totalTokens)) ? Number(totalTokens) : undefined,
                reasoning_tokens: Number.isFinite(Number(reasoningTokens)) ? Number(reasoningTokens) : undefined,
                cached_input_tokens: Number.isFinite(Number(cachedInputTokens)) ? Number(cachedInputTokens) : undefined,
                cache_creation_input_tokens: Number.isFinite(Number(cacheCreationTokens)) ? Number(cacheCreationTokens) : undefined,
                cache_read_input_tokens: Number.isFinite(Number(cacheReadTokens)) ? Number(cacheReadTokens) : undefined,
                provider: String(provider || '')
            };
            if (out.total_tokens === undefined && (out.prompt_tokens !== undefined || out.completion_tokens !== undefined)) {
                out.total_tokens = Number(out.prompt_tokens || 0) + Number(out.completion_tokens || 0);
            }
            return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined && value !== ''));
        }

        _extractTextDeep(value) {
            if (typeof value === 'string') return value.trim();
            if (Array.isArray(value)) return value.map(item => this._extractTextDeep(item)).filter(Boolean).join('\n\n');
            if (!value || typeof value !== 'object') return '';
            const direct = [value.text, value.output_text, value.reasoning_content]
                .find(item => typeof item === 'string' && item.trim());
            if (direct) return direct.trim();
            if (value.content !== undefined) return this._extractTextDeep(value.content);
            if (value.message !== undefined) return this._extractTextDeep(value.message);
            return '';
        }

        _extractGeminiText(data = {}) {
            const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
            const parts = candidates[0]?.content?.parts || data?.content?.parts || [];
            return Array.isArray(parts)
                ? parts.filter(part => !part?.thought).map(part => String(part?.text || '').trim()).filter(Boolean).join('\n\n')
                : '';
        }

        _extractAnthropicText(data = {}) {
            const content = Array.isArray(data?.content) ? data.content : [];
            return content.map(block => String(block?.text || '').trim()).filter(Boolean).join('\n\n');
        }

        _extractChatText(data = {}) {
            const choice = Array.isArray(data?.choices) ? data.choices[0] || {} : {};
            const output = Array.isArray(data?.output)
                ? data.output.map(item => this._extractTextDeep(item?.content || item)).filter(Boolean).join('\n\n')
                : '';
            return String(
                this._extractTextDeep(choice?.message?.content)
                || this._extractTextDeep(choice?.text)
                || output
                || this._extractTextDeep(data?.output_text)
                || this._extractTextDeep(data?.message?.content)
                || this._extractTextDeep(data?.response)
                || this._extractGeminiText(data)
                || this._extractAnthropicText(data)
                || ''
            ).trim();
        }

        _streamEventFromPayload(provider = '', data = {}) {
            if (!data || typeof data !== 'object') return { text: '', thinking: '', toolCallCount: 0, usage: {} };
            const p = String(provider || '').toLowerCase();
            const choice = Array.isArray(data?.choices) ? data.choices[0] || {} : {};
            const delta = choice.delta || {};
            let chunkText = '';
            let thinking = '';
            let toolCallCount = 0;
            let usage = data.usage || data.usageMetadata || {};
            const eventType = String(data.type || data.event || '');
            if (p === 'claude' || p === 'anthropic') {
                const anthropicDelta = data.delta || {};
                if (eventType === 'content_block_delta') {
                    if (anthropicDelta.type === 'text_delta') chunkText = anthropicDelta.text || '';
                    else if (anthropicDelta.type === 'thinking_delta') thinking = anthropicDelta.thinking || '';
                    else if (anthropicDelta.type === 'input_json_delta') toolCallCount = 1;
                } else if (eventType === 'content_block_start') {
                    const block = data.content_block || {};
                    if (block.type === 'text') chunkText = block.text || '';
                    else if (block.type === 'thinking') thinking = block.thinking || '';
                    else if (block.type === 'tool_use') toolCallCount = 1;
                } else if (eventType === 'message_delta') {
                    usage = data.usage || anthropicDelta.usage || {};
                }
            } else if (p === 'gemini' || p === 'vertex') {
                const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
                const parts = candidates[0]?.content?.parts || data?.content?.parts || [];
                if (Array.isArray(parts)) {
                    chunkText = parts.filter(part => !part?.thought).map(part => String(part?.text || '')).filter(Boolean).join('');
                    thinking = parts.filter(part => part?.thought).map(part => String(part?.text || '')).filter(Boolean).join('');
                    toolCallCount = parts.filter(part => part?.functionCall).length;
                }
                usage = data.usageMetadata || data.usage || {};
            } else if (p === 'ollama') {
                chunkText = data?.message?.content || data?.delta?.content || data?.response || data?.delta?.text || '';
                thinking = data?.message?.thinking || data?.thinking || data?.delta?.thinking || '';
                usage = data.usage || {
                    prompt_tokens: data.prompt_eval_count,
                    completion_tokens: data.eval_count,
                    total_tokens: Number(data.prompt_eval_count || 0) + Number(data.eval_count || 0)
                };
            } else {
                const responsesDelta = eventType === 'response.output_text.delta' && typeof data?.delta === 'string'
                    ? data.delta
                    : '';
                const completedResponse = (eventType === 'response.completed' || eventType === 'response.done') ? data?.response || {} : {};
                chunkText = responsesDelta || delta.content || delta.text || choice.text || data?.delta?.content || data?.delta?.text || data?.message?.content || (typeof data?.response === 'string' ? data.response : '') || data?.output_text || '';
                thinking = delta.reasoning_content || delta.reasoning || data.reasoning_content || data.reasoning || '';
                toolCallCount = Array.isArray(delta.tool_calls) ? delta.tool_calls.length : Array.isArray(choice.tool_calls) ? choice.tool_calls.length : 0;
                if (delta.function_call || choice.function_call || data?.function_call) toolCallCount += 1;
                if (completedResponse?.usage) usage = completedResponse.usage;
            }
            const candidate = Array.isArray(data?.candidates) ? data.candidates[0] || {} : {};
            const finishReason = choice.finish_reason
                || choice.finishReason
                || candidate.finishReason
                || data.finishReason
                || data.done_reason
                || data.doneReason
                || data.stop_reason
                || data?.delta?.stop_reason
                || data?.message?.stop_reason
                || '';
            const transportDone = data?.done === true
                || data?.status === 'completed'
                || ['message_stop', 'response.completed', 'response.done', 'done'].includes(eventType)
            const generationDone = transportDone || !!String(finishReason || '').trim();
            if (!chunkText && !thinking && !toolCallCount) chunkText = this._extractGeminiText(data) || '';
            return {
                text: String(chunkText || ''),
                thinking: String(thinking || ''),
                toolCallCount,
                usage: this._normalizeUsage(usage, provider),
                done: transportDone,
                generationDone,
                finishReason: String(finishReason || '')
            };
        }

        async _readWithTimeout(reader, timeoutMs, label = 'provider_stream_timeout') {
            let timer = null;
            try {
                const timeoutPromise = new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new LIBRAError(label, 'STREAM_TIMEOUT')), Math.max(1000, Number(timeoutMs || 30000)));
                });
                return await Promise.race([reader.read(), timeoutPromise]);
            } finally {
                if (timer != null && typeof clearTimeout === 'function') clearTimeout(timer);
            }
        }

        async _fetchStream(url, headers, body, timeoutMs = 120000, options = {}) {
            const provider = String(options.provider || '').trim().toLowerCase();
            if (MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('debug', '[LIBRA Debug] API Stream Request Payload:', JSON.stringify(this._debugPayloadForTrace(url, headers, body), null, 2));
            }
            const response = await this._fetchRaw(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            }, timeoutMs, { ...options, stream: true });
            if (!response || !response.ok) {
                const status = response?.status || 'Unknown';
                const errorBody = await response?.text?.().catch(() => 'No error body') || 'No response';
                throw new LIBRAError(`API Error: ${status} - ${errorBody}`, 'API_ERROR');
            }
            if (!response.body?.getReader) {
                let data = null;
                try { data = await response.json(); } catch (_) {
                    const rawText = await response.text?.().catch(() => '') || '';
                    data = this._safeParseJson(rawText) || { choices: [{ message: { content: rawText } }], rawText };
                }
                return { content: this._extractChatText(data), usage: data?.usage || data?.usageMetadata || {}, streamMeta: { rawChars: 0, thinkingChars: 0, toolCallCount: 0, fallbackNonStream: true } };
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let raw = '';
            let content = '';
            let thinking = '';
            let toolCallCount = 0;
            let usage = {};
            let sawRawChunk = false;
            let streamDone = false;
            let generationDone = false;
            let finishReason = '';
            const consumePayload = (payload = '') => {
                const trimmed = String(payload || '').trim();
                if (!trimmed) return;
                if (trimmed === '[DONE]') { streamDone = true; return; }
                const data = this._safeParseJson(trimmed);
                if (!data) return;
                const event = this._streamEventFromPayload(provider, data);
                if (event.text) content += event.text;
                if (event.thinking) thinking += event.thinking;
                if (event.toolCallCount) toolCallCount += Number(event.toolCallCount || 0) || 0;
                if (Object.keys(event.usage || {}).length) usage = { ...usage, ...event.usage };
                if (event.generationDone) generationDone = true;
                if (event.finishReason) finishReason = event.finishReason;
                if (event.done) {
                    streamDone = true;
                }
            };
            while (true) {
                const readTimeoutMs = sawRawChunk ? Math.min(Math.max(5000, timeoutMs), 60000) : Math.min(Math.max(5000, timeoutMs), 120000);
                let readResult;
                try {
                    readResult = await this._readWithTimeout(reader, readTimeoutMs, sawRawChunk ? 'provider_stream_idle_timeout' : 'provider_stream_first_chunk_timeout');
                } catch (error) {
                    try { await reader.cancel(error?.message || 'provider_stream_timeout'); } catch (_) {}
                    throw error;
                }
                const { done, value } = readResult || {};
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                sawRawChunk = true;
                raw += chunk;
                buffer += chunk;
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (trimmed.startsWith('data:')) consumePayload(trimmed.replace(/^data:\s*/, ''));
                    else if (trimmed.startsWith('{')) consumePayload(trimmed);
                    if (streamDone) break;
                }
                if (streamDone) break;
            }
            if (streamDone) {
                try { await reader.cancel('provider_stream_done'); } catch (_) {}
            }
            const tail = decoder.decode();
            if (tail) {
                raw += tail;
                buffer += tail;
            }
            if (buffer.trim()) {
                const trimmed = buffer.trim();
                if (trimmed.startsWith('data:')) consumePayload(trimmed.replace(/^data:\s*/, ''));
                else if (trimmed.startsWith('{')) consumePayload(trimmed);
            }
            if (!content.trim()) {
                const parsed = this._safeParseJson(raw.trim());
                if (parsed) {
                    content = this._extractChatText(parsed);
                    usage = this._normalizeUsage(parsed.usage || parsed.usageMetadata || usage, provider);
                }
            }
            return {
                content: content.trim(),
                usage: this._normalizeUsage(usage, provider),
                streamMeta: {
                    rawChars: raw.length,
                    thinkingChars: thinking.length,
                    toolCallCount,
                    generationDone,
                    transportDone: streamDone,
                    finishReason
                }
            };
        }
    }

    const COPILOT_MODEL_MAP = {
        'gpt-4.1': 'gpt-4o',
        'gpt-4.1-mini': 'gpt-4o-mini',
        'gpt-4.1-nano': 'gpt-4o-mini'
    };
    const COPILOT_CODE_VERSION = '1.85.0';
    const COPILOT_CHAT_VERSION = '0.22.0';
    const COPILOT_USER_AGENT = `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`;
    const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
    let CopilotRuntimeTokenCache = { sourceHash: '', token: '', expiry: 0 };
    let CopilotRuntimeTokenInflight = null;
    const normalizeDirectProviderKey = (provider = '') => {
        const raw = String(provider || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
        const aliases = {
            anthropic: 'claude',
            'lm-studio': 'lmstudio',
            'ollama-cloud': 'ollama_cloud',
            'cloudflare-ai': 'cloudflare-ai-gateway',
            cloudflare: 'cloudflare-ai-gateway',
            crof: 'crofai',
            'fireworks-ai': 'fireworks',
            'lightning-ai-studio': 'lightning-ai',
            'llmgateway': 'llm-gateway',
            'neural-watt': 'neuralwatt',
            'novita-ai': 'novita',
            'novita-coding-plan': 'novita-coding',
            opencode: 'opencode-go',
            'silicon-flow': 'siliconflow',
            'synthetic-new': 'synthetic',
            venice: 'venice-ai',
            'vercel-ai-gateway': 'vercel-ai',
            vercel: 'vercel-ai',
            zai: 'z-ai',
            'zai-coding': 'z-ai-coding',
            mimo: 'xiaomi-mimo',
            'mimo-token-plan-cn': 'xiaomi-mimo-token-plan-cn',
            'mimo-token-plan-sgp': 'xiaomi-mimo-token-plan-sgp',
            'mimo-token-plan-ams': 'xiaomi-mimo-token-plan-ams'
        };
        return aliases[raw] || raw;
    };
    const DIRECT_LLM_PROVIDER_REGISTRY = Object.freeze({
        deepseek: Object.freeze({ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        together: Object.freeze({ label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        fireworks: Object.freeze({ label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '/responses' }),
        arliai: Object.freeze({ label: 'ArliAI', baseUrl: 'https://api.arliai.com/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        cerebras: Object.freeze({ label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        'cloudflare-ai-gateway': Object.freeze({ label: 'Cloudflare AI Gateway', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1', chatPath: '/chat/completions', modelsPath: '', responsesPath: '/responses', requiresConfiguredUrl: true }),
        crofai: Object.freeze({ label: 'CrofAI', baseUrl: 'https://ai.nahcrof.com/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        digitalocean: Object.freeze({ label: 'DigitalOcean Gradient AI', baseUrl: 'https://inference.do-ai.run/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '/responses' }),
        featherless: Object.freeze({ label: 'Featherless AI', baseUrl: 'https://api.featherless.ai/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        'heroku-us': Object.freeze({ label: 'Heroku Managed Inference (US)', baseUrl: 'https://us.inference.heroku.com/v1', chatPath: '/chat/completions', modelsPath: '', responsesPath: '' }),
        'heroku-eu': Object.freeze({ label: 'Heroku Managed Inference (EU)', baseUrl: 'https://eu.inference.heroku.com/v1', chatPath: '/chat/completions', modelsPath: '', responsesPath: '' }),
        'lightning-ai': Object.freeze({ label: 'Lightning AI', baseUrl: 'https://lightning.ai/api/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        'llm-gateway': Object.freeze({ label: 'LLM Gateway', baseUrl: 'https://api.llmgateway.io/v1', chatPath: '/chat/completions', modelsPath: '/models?exclude_deprecated=true', responsesPath: '' }),
        neuralwatt: Object.freeze({ label: 'Neuralwatt', baseUrl: 'https://api.neuralwatt.com/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        novita: Object.freeze({ label: 'Novita AI', baseUrl: 'https://api.novita.ai/openai/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        'novita-coding': Object.freeze({ label: 'Novita Coding', baseUrl: 'https://api.novita.ai/openai/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        'opencode-go': Object.freeze({ label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        siliconflow: Object.freeze({ label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.com/v1', chatPath: '/chat/completions', modelsPath: '/models?sub_type=chat', responsesPath: '' }),
        synthetic: Object.freeze({ label: 'Synthetic', baseUrl: 'https://api.synthetic.new/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '' }),
        'venice-ai': Object.freeze({ label: 'Venice AI', baseUrl: 'https://api.venice.ai/api/v1', chatPath: '/chat/completions', modelsPath: '/models?type=text', responsesPath: '' }),
        'vercel-ai': Object.freeze({ label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', chatPath: '/chat/completions', modelsPath: '/models', responsesPath: '/responses' }),
        'z-ai': Object.freeze({ label: 'Z.ai', baseUrl: 'https://api.z.ai/api/paas/v4', chatPath: '/chat/completions', modelsPath: '', responsesPath: '' }),
        'z-ai-coding': Object.freeze({ label: 'Z.ai Coding Plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4', chatPath: '/chat/completions', modelsPath: '', responsesPath: '' }),
        'xiaomi-mimo': Object.freeze({ label: 'Xiaomi MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', chatPath: '/chat/completions', modelsPath: '', responsesPath: '' }),
        'xiaomi-mimo-token-plan-cn': Object.freeze({ label: 'Xiaomi MiMo Token Plan (China)', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', chatPath: '/chat/completions', modelsPath: '', responsesPath: '' }),
        'xiaomi-mimo-token-plan-sgp': Object.freeze({ label: 'Xiaomi MiMo Token Plan (Singapore)', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', chatPath: '/chat/completions', modelsPath: '', responsesPath: '' }),
        'xiaomi-mimo-token-plan-ams': Object.freeze({ label: 'Xiaomi MiMo Token Plan (Europe)', baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1', chatPath: '/chat/completions', modelsPath: '', responsesPath: '' })
    });
    const directProviderDefinition = (provider = '') => DIRECT_LLM_PROVIDER_REGISTRY[normalizeDirectProviderKey(provider)] || null;
    const normalizeLLMRequestFormat = (value = '') => {
        const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (['responses', 'response', 'openai_responses'].includes(raw)) return 'responses';
        return 'chat_completions';
    };
    const providerAllowsEmptyKey = (provider) => ['ollama', 'lmstudio', 'lm-studio'].includes(normalizeDirectProviderKey(provider));
    const providerRequiresUrl = (provider) => {
        const p = normalizeDirectProviderKey(provider);
        return p === 'custom' || p === 'vertex' || p === 'vertex-openai' || p === 'vertex-embedding' || directProviderDefinition(p)?.requiresConfiguredUrl === true;
    };
    const resolveProviderBaseUrl = (provider, rawUrl, mode = 'llm') => {
        const normalizedProvider = normalizeDirectProviderKey(provider || 'openai');
        const normalizedRawUrl = String(rawUrl || '').trim();
        if (normalizedRawUrl) return normalizedRawUrl;
        const direct = directProviderDefinition(normalizedProvider);
        if (direct?.baseUrl) return direct.baseUrl;
        if (normalizedProvider === 'openai') return 'https://api.openai.com';
        if (normalizedProvider === 'openrouter') return 'https://openrouter.ai/api';
        if (normalizedProvider === 'copilot' && mode === 'llm') return 'https://api.githubcopilot.com';
        if (normalizedProvider === 'claude' || normalizedProvider === 'anthropic') return 'https://api.anthropic.com';
        if (normalizedProvider === 'gemini' || normalizedProvider === 'gemini-embedding') return 'https://generativelanguage.googleapis.com/v1beta';
        if (normalizedProvider === 'lmstudio' || normalizedProvider === 'lm_studio') return 'http://localhost:1234/v1';
        if (normalizedProvider === 'ollama') return 'http://localhost:11434';
        if (normalizedProvider === 'ollama_cloud') return 'https://ollama.com';
        if (normalizedProvider === 'voyageai' && mode === 'embed') return 'https://api.voyageai.com';
        return normalizedRawUrl;
    };
    const joinProviderEndpoint = (base = '', endpointPath = '') => {
        const rawBase = String(base || '').trim().replace(/\/+$/, '');
        const rawPath = String(endpointPath || '').trim();
        if (!rawBase || !rawPath) return rawBase;
        const [pathPart, queryPart = ''] = rawPath.split('?');
        const normalizedPath = `/${String(pathPart || '').replace(/^\/+/, '')}`;
        const currentEndpoint = rawBase.match(/\/(chat\/completions|responses|messages|embeddings|models)(?:\?.*)?$/i);
        const targetEndpoint = normalizedPath.match(/\/(chat\/completions|responses|messages|embeddings|models)$/i)?.[1] || '';
        if (currentEndpoint) {
            if (String(currentEndpoint[1]).toLowerCase() === String(targetEndpoint).toLowerCase()) return rawBase;
            return joinProviderEndpoint(rawBase.slice(0, currentEndpoint.index), rawPath);
        }
        const baseLower = rawBase.toLowerCase();
        const pathSegments = normalizedPath.split('/').filter(Boolean);
        let overlap = '';
        for (let count = pathSegments.length; count > 0; count -= 1) {
            const candidate = `/${pathSegments.slice(0, count).join('/')}`;
            if (baseLower.endsWith(candidate.toLowerCase())) {
                overlap = candidate;
                break;
            }
        }
        const tail = overlap ? normalizedPath.slice(overlap.length) : normalizedPath;
        const joined = `${rawBase}${tail}`;
        return queryPart ? `${joined}?${queryPart}` : joined;
    };
    const resolveDirectProviderEndpoint = (provider = '', rawUrl = '', kind = 'chat') => {
        const definition = directProviderDefinition(provider);
        if (!definition) return '';
        const endpointPath = kind === 'models'
            ? definition.modelsPath
            : kind === 'responses'
                ? definition.responsesPath
                : definition.chatPath;
        if (!endpointPath) return '';
        return joinProviderEndpoint(String(rawUrl || '').trim() || definition.baseUrl, endpointPath);
    };
    const validateDirectProviderUrl = (provider = '', url = '') => {
        const definition = directProviderDefinition(provider);
        const raw = String(url || definition?.baseUrl || '').trim();
        if (definition?.requiresConfiguredUrl && /(?:ACCOUNT_ID|GATEWAY_ID|\{[^}]+\})/i.test(raw)) {
            throw new LIBRAError(`${definition.label} URL의 계정 식별자를 실제 값으로 바꿔 주세요.`, 'MISSING_URL');
        }
        return raw;
    };
    const normalizeOpenAICompatUrl = (base = '', suffix = '/v1/chat/completions') => {
        const raw = String(base || '').trim().replace(/\/$/, '');
        if (!raw) return raw;
        if (/\/v\d+\/(?:chat\/completions|embeddings|completions)(?:\?|$)/i.test(raw)) return raw;
        if (/\/v\d+$/i.test(raw)) return `${raw}${suffix.replace(/^\/v\d+/, '')}`;
        if (/nano-gpt\.com\/api$/i.test(raw)) return `${raw}${suffix}`;
        if (/nano-gpt\.com\/api\/v\d+$/i.test(raw)) return `${raw}${suffix.replace(/^\/v\d+/, '')}`;
        return raw + suffix;
    };
    const ollamaApiUrl = (base = '', endpoint = '/api/chat') => {
        const raw = String(base || resolveProviderBaseUrl('ollama')).trim().replace(/\/$/, '');
        const cleanEndpoint = `/${String(endpoint || '/api/chat').replace(/^\/+/, '')}`;
        if (!raw) return raw;
        if (raw.toLowerCase().endsWith(cleanEndpoint.toLowerCase())) return raw;
        if (/\/api\/(?:chat|generate|embed|embeddings|tags|show)(?:\?|$)/i.test(raw)) {
            return raw.replace(/\/api\/(?:chat|generate|embed|embeddings|tags|show)(?:\?.*)?$/i, cleanEndpoint);
        }
        if (/\/api$/i.test(raw)) return `${raw}${cleanEndpoint.replace(/^\/api/, '')}`;
        return `${raw}${cleanEndpoint}`;
    };
    const vertexOpenAIUrl = (base = '') => {
        const cleanBase = String(base || '').trim().replace(/\/$/, '');
        if (!cleanBase) throw new LIBRAError('Vertex OpenAI URL is missing.', 'MISSING_URL');
        if (/:generateContent|:streamGenerateContent|\/publishers\/google\/models/i.test(cleanBase)) {
            throw new LIBRAError('Vertex OpenAI provider needs the Vertex OpenAI-compatible endpoint, not a direct Gemini endpoint.', 'BAD_URL');
        }
        if (/\/chat\/completions(?:\?|$)/i.test(cleanBase)) return cleanBase;
        if (/\/endpoints\/openapi$/i.test(cleanBase)) return `${cleanBase}/chat/completions`;
        return normalizeOpenAICompatUrl(cleanBase, '/chat/completions');
    };
    const normalizeVertexModelName = (model = '', fallback = 'gemini-2.5-flash') => {
        const raw = String(model || '').trim() || fallback;
        return raw.replace(/^models\//i, '').replace(/^publishers\/google\/models\//i, '');
    };
    const normalizeVertexGeminiBaseUrl = (base = '') => String(base || '').trim().replace(/\/$/, '');
    const vertexGeminiContentUrl = (base = '', model = '', action = 'generateContent') => {
        const normalizedAction = action === 'streamGenerateContent' ? 'streamGenerateContent' : 'generateContent';
        const cleanBase = normalizeVertexGeminiBaseUrl(base);
        if (!cleanBase) throw new LIBRAError('Vertex Gemini URL is missing.', 'MISSING_URL');
        const cleanModel = normalizeVertexModelName(model);
        if (/:(?:generateContent|streamGenerateContent)$/i.test(cleanBase)) return cleanBase.replace(/:(?:generateContent|streamGenerateContent)$/i, `:${normalizedAction}`);
        if (/\/publishers\/google\/models\/[^/:]+$/i.test(cleanBase)) return `${cleanBase}:${normalizedAction}`;
        if (/\/publishers\/google\/models$/i.test(cleanBase)) return `${cleanBase}/${cleanModel}:${normalizedAction}`;
        if (/\/locations\/[^/]+$/i.test(cleanBase)) return `${cleanBase}/publishers/google/models/${cleanModel}:${normalizedAction}`;
        return `${cleanBase}/${cleanModel}:${normalizedAction}`;
    };
    const vertexPredictUrl = (base = '', model = '') => {
        const cleanBase = normalizeVertexGeminiBaseUrl(base);
        if (!cleanBase) throw new LIBRAError('Vertex Embedding URL is missing.', 'MISSING_URL');
        const cleanModel = normalizeVertexModelName(model, 'text-embedding-004');
        if (/:predict$/i.test(cleanBase)) return cleanBase;
        if (/\/publishers\/google\/models\/[^/:]+$/i.test(cleanBase)) return `${cleanBase}:predict`;
        if (/\/publishers\/google\/models$/i.test(cleanBase)) return `${cleanBase}/${cleanModel}:predict`;
        if (/\/locations\/[^/]+$/i.test(cleanBase)) return `${cleanBase}/publishers/google/models/${cleanModel}:predict`;
        return `${cleanBase}/${cleanModel}:predict`;
    };
    const appendQueryParam = (url = '', query = '') => {
        const cleanUrl = String(url || '').trim();
        const cleanQuery = String(query || '').trim().replace(/^\?+/, '');
        if (!cleanUrl || !cleanQuery) return cleanUrl;
        return `${cleanUrl}${cleanUrl.includes('?') ? '&' : '?'}${cleanQuery}`;
    };
    const normalizeGeminiApiEndpoint = (rawUrl, model, action = 'generateContent') => {
        const normalizedAction = action === 'embedContent' ? 'embedContent' : (action === 'streamGenerateContent' ? 'streamGenerateContent' : 'generateContent');
        const cleanedModel = String(model || '').trim();
        let baseUrl = String(rawUrl || '').trim();
        if (!baseUrl) {
            baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
        }
        baseUrl = baseUrl.replace(/\/$/, '');
        if (!/generativelanguage\.googleapis\.com/i.test(baseUrl)) {
            return /:[a-zA-Z]+$/.test(baseUrl)
                ? baseUrl
                : `${baseUrl}/models/${cleanedModel}:${normalizedAction}`;
        }
        if (!/\/v[0-9][^/]*$/i.test(baseUrl) && !/\/v[0-9][^/]*\/models\//i.test(baseUrl)) {
            baseUrl += '/v1beta';
        }
        if (/:generateContent$/i.test(baseUrl) || /:streamGenerateContent$/i.test(baseUrl) || /:embedContent$/i.test(baseUrl)) {
            if (new RegExp(`:${normalizedAction}$`, 'i').test(baseUrl)) return baseUrl;
            return baseUrl.replace(/:(?:generateContent|streamGenerateContent|embedContent)$/i, `:${normalizedAction}`);
        }
        if (/\/models\/[^/:]+$/i.test(baseUrl)) return `${baseUrl}:${normalizedAction}`;
        if (/\/models\//i.test(baseUrl)) return baseUrl;
        return `${baseUrl}/models/${cleanedModel}:${normalizedAction}`;
    };

    const FlexTierPolicy = (() => {
        const FLEX_TIMEOUT_DEFAULT_MS = 600000;
        const FLEX_TIMEOUT_MAX_MS = 30 * 60 * 1000;
        const ROUTING_MODES = new Set(['off', 'background', 'all']);
        const SERVICE_TIERS = new Set(['off', 'auto', 'default', 'flex', 'priority', 'scale']);
        const BACKGROUND_LABEL_RE = /(cold[-_ ]?start|cold[-_ ]?reanalysis|reanalysis|memory[-_ ]?reanalysis|source[-_ ]?reflection|reflect[-_ ]?sources|structured[-_ ]?(?:knowledge|merge|synthesis)|knowledge[-_ ]?synthesis|merge[-_ ]?verify|synthesis|layer-\d+|maintenance|turn[-_ ]?maintenance|turn[-_ ]?correction|entity[-_ ]?extraction|entity[-_ ]?extraction[-_ ]?repair|world[-_ ]?state|character[-_ ]?state|consolidat|hypa|module[-_ ]?lorebook|persona|import(?:ed)?[-_ ]?knowledge|cleanup|background|batch|summary)/i;
        const REALTIME_LABEL_RE = /(before[-_ ]?request|context[-_ ]?assembly|context[-_ ]?injection|prompt[-_ ]?injection|rollback|commit|turn[-_ ]?anchor|embedding|retrieve|jaccard|similarity)/i;
        const normalizeRoutingMode = (value) => {
            const mode = String(value || 'off').trim().toLowerCase();
            return ROUTING_MODES.has(mode) ? mode : 'off';
        };
        const normalizeServiceTier = (value) => {
            const tier = String(value || 'off').trim().toLowerCase();
            if (tier === 'standard') return 'default';
            return SERVICE_TIERS.has(tier) ? tier : 'off';
        };
        const normalizeVertexFlexMode = (value) => {
            const mode = String(value || 'provisioned_then_flex').trim().toLowerCase();
            return mode === 'flex_only' ? 'flex_only' : 'provisioned_then_flex';
        };
        const normalizeTimeout = (value, fallback = FLEX_TIMEOUT_DEFAULT_MS) => {
            const n = Number(value || fallback);
            if (!Number.isFinite(n) || n <= 0) return fallback;
            return Math.max(60000, Math.min(FLEX_TIMEOUT_MAX_MS, Math.floor(n)));
        };
        const providerKey = (provider = '') => String(provider || 'openai').trim().toLowerCase();
        const providerKind = (providerName = '') => {
            const provider = providerKey(providerName);
            if (provider === 'openai' || provider === 'openrouter') return 'openai-compatible-official';
            if (provider === 'custom') return 'custom-openai-compatible';
            if (provider === 'gemini') return 'gemini-ai-studio';
            if (provider === 'vertex') return 'vertex-gemini';
            if (provider === 'vertex-openai' || provider === 'vertex_openai') return 'vertex-openai';
            return 'unsupported';
        };
        const isBackgroundTask = (options = {}) => {
            if (options.__disableFlex) return false;
            if (options.flexClass === 'background' || options.background === true || options.flexAllowed === true || options.latencyTolerant === true) return true;
            if (options.realtime === true || options.immediate === true || options.flexAllowed === false) return false;
            const runtimeLabel = (() => { try { return FlexTierRuntime?.currentLabel?.() || ''; } catch { return ''; } })();
            const label = [options.label, options.debugLabel, options.taskLabel, options.flexReason, options.__maintenanceTaskName, runtimeLabel]
                .map(v => String(v || '').trim())
                .filter(Boolean)
                .join('|');
            if (REALTIME_LABEL_RE.test(label)) return false;
            return BACKGROUND_LABEL_RE.test(label);
        };
        const supportsTier = (providerName = '', tier = 'off', cfg = {}) => {
            const normalizedTier = normalizeServiceTier(tier);
            if (!normalizedTier || normalizedTier === 'off') return false;
            const kind = providerKind(providerName);
            if (kind === 'openai-compatible-official') return true;
            if (kind === 'custom-openai-compatible') return cfg.customServiceTierPassthrough === true;
            if (kind === 'gemini-ai-studio' || kind === 'vertex-gemini' || kind === 'vertex-openai') return normalizedTier === 'flex';
            return false;
        };
        const resolve = (config = {}, options = {}, profile = 'primary') => {
            const providerName = providerKey(config?.llm?.provider || 'openai');
            const requestedTier = normalizeServiceTier(config?.llm?.serviceTier || 'off');
            const routingMode = normalizeRoutingMode(config?.flexRoutingMode || 'off');
            const background = isBackgroundTask(options);
            const wantsFlex = requestedTier === 'flex';
            const baseTimeout = Math.max(1000, Number(config?.llm?.timeout || 120000) || 120000);
            const flexTimeout = normalizeTimeout(config?.flexTimeoutMs || FLEX_TIMEOUT_DEFAULT_MS);
            const base = {
                profile: String(profile || 'primary'),
                provider: providerName,
                providerKind: providerKind(providerName),
                requestedTier,
                serviceTier: null,
                routingMode,
                flexApplied: false,
                applied: false,
                background,
                reason: 'off',
                timeoutMs: baseTimeout,
                baseTimeoutMs: baseTimeout,
                flexTimeoutMs: flexTimeout,
                fallbackToStandard: config?.flexFallbackToStandard === true,
                vertexFlexMode: normalizeVertexFlexMode(config?.vertexFlexMode || 'provisioned_then_flex'),
                customServiceTierPassthrough: config?.customServiceTierPassthrough === true,
                label: String(options.label || options.debugLabel || options.taskLabel || options.__maintenanceTaskName || FlexTierRuntime.currentLabel?.() || '')
            };
            if (options.__disableFlex) return { ...base, reason: 'disabled-for-fallback' };
            if (requestedTier === 'off') return base;
            if (wantsFlex) {
                if (routingMode === 'off') return { ...base, reason: 'flex-routing-off' };
                if (routingMode === 'background' && !background) return { ...base, reason: 'not-background-task' };
            }
            if (!supportsTier(providerName, requestedTier, config)) return { ...base, reason: 'unsupported-provider' };
            const timeoutMs = wantsFlex ? Math.max(baseTimeout, flexTimeout) : baseTimeout;
            return {
                ...base,
                serviceTier: requestedTier,
                flexApplied: wantsFlex,
                applied: true,
                reason: wantsFlex ? 'flex-enabled' : 'service-tier-enabled',
                timeoutMs
            };
        };
        const requestTierForOpenAI = (policy = null) => {
            if (!policy?.applied || !policy?.serviceTier) return '';
            if (policy.providerKind === 'openai-compatible-official' || policy.providerKind === 'custom-openai-compatible') return policy.serviceTier;
            return '';
        };
        const requestTierForGemini = (policy = null) => (policy?.applied && policy?.serviceTier === 'flex') ? 'flex' : '';
        const applyVertexHeaders = (headers = {}, policy = null) => {
            if (!(policy?.applied && policy?.serviceTier === 'flex')) return headers;
            headers['X-Vertex-AI-LLM-Shared-Request-Type'] = 'flex';
            if (policy.vertexFlexMode === 'flex_only') headers['X-Vertex-AI-LLM-Request-Type'] = 'shared';
            headers['X-Server-Timeout'] = String(Math.ceil(Math.min(FLEX_TIMEOUT_MAX_MS, Math.max(60000, Number(policy.timeoutMs || FLEX_TIMEOUT_DEFAULT_MS))) / 1000));
            return headers;
        };
        const withStandardFallback = (policy = null) => {
            if (!policy) return null;
            return {
                ...policy,
                serviceTier: null,
                applied: false,
                flexApplied: false,
                fallbackUsed: true,
                reason: 'flex-fallback-standard',
                timeoutMs: Math.max(1000, Number(policy.baseTimeoutMs || policy.timeoutMs || 120000) || 120000)
            };
        };
        const isTransientFlexError = (error) => /API Error:\s*(429|500|502|503|504)\b|TIMEOUT|timed out|timeout|temporarily unavailable|service_unavailable|resource unavailable|throttl|rate limit|capacity|overloaded|upstream|gateway/i.test(String(error?.message || error || ''));
        const publicTrace = (policy = null, extra = {}) => {
            if (!policy) return { applied: false };
            return {
                applied: !!policy.applied,
                flexApplied: !!policy.flexApplied,
                requestedTier: policy.requestedTier || 'off',
                serviceTier: policy.serviceTier || '',
                routingMode: policy.routingMode || 'off',
                provider: policy.provider || '',
                providerKind: policy.providerKind || '',
                profile: policy.profile || '',
                background: !!policy.background,
                reason: policy.reason || '',
                timeoutMs: policy.timeoutMs || 0,
                fallbackToStandard: !!policy.fallbackToStandard,
                fallbackUsed: !!policy.fallbackUsed,
                label: policy.label || '',
                ...extra
            };
        };
        return Object.freeze({
            normalizeRoutingMode,
            normalizeServiceTier,
            normalizeVertexFlexMode,
            normalizeTimeout,
            resolve,
            requestTierForOpenAI,
            requestTierForGemini,
            applyVertexHeaders,
            withStandardFallback,
            isTransientFlexError,
            publicTrace
        });
    })();

    class OpenAIProvider extends BaseProvider {
        async _getCopilotBearerToken(rawToken) {
            const sourceToken = String(rawToken || '').replace(/[^\x20-\x7E]/g, '').trim();
            if (!sourceToken) return '';
            const sourceHash = TokenizerEngine.simpleHash(sourceToken);
            if (CopilotRuntimeTokenCache?.sourceHash === sourceHash
                && CopilotRuntimeTokenCache?.token
                && Number.isFinite(Number(CopilotRuntimeTokenCache?.expiry || 0))
                && Date.now() < Number(CopilotRuntimeTokenCache.expiry || 0) - 60000) {
                return CopilotRuntimeTokenCache.token;
            }
            if (CopilotRuntimeTokenInflight?.sourceHash === sourceHash && CopilotRuntimeTokenInflight?.promise) {
                try {
                    return await CopilotRuntimeTokenInflight.promise;
                } catch (_) {
                    return sourceToken;
                }
            }

            const refreshPromise = (async () => {
                try {
                    const response = await this._fetchRaw(COPILOT_TOKEN_URL, {
                        method: 'GET',
                        headers: {
                            'Accept': 'application/json',
                            'Authorization': `Bearer ${sourceToken}`,
                            'Origin': 'vscode-file://vscode-app',
                            'Editor-Version': `vscode/${COPILOT_CODE_VERSION}`,
                            'Editor-Plugin-Version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
                            'Copilot-Integration-Id': 'vscode-chat',
                            'User-Agent': COPILOT_USER_AGENT
                        }
                    }, 12000);
                    if (!response.ok) return sourceToken;
                    const data = await response.json().catch(() => null);
                    const token = String(data?.token || '').trim();
                    const expiry = Number(data?.expires_at || 0) * 1000;
                    if (!token) return sourceToken;
                    CopilotRuntimeTokenCache = {
                        sourceHash,
                        token,
                        expiry: Number(expiry || (Date.now() + 30 * 60 * 1000))
                    };
                    return token;
                } catch (_) {
                    return sourceToken;
                }
            })();
            CopilotRuntimeTokenInflight = { sourceHash, promise: refreshPromise };
            try {
                return await refreshPromise;
            } finally {
                if (CopilotRuntimeTokenInflight?.sourceHash === sourceHash && CopilotRuntimeTokenInflight?.promise === refreshPromise) {
                    CopilotRuntimeTokenInflight = null;
                }
            }
        }

        async callLLM(config, systemPrompt, userContent, options) {
            const provider = normalizeDirectProviderKey(config.llm.provider || 'openai');
            if (!providerAllowsEmptyKey(provider)) this._checkKey(config.llm.key);
            if (providerRequiresUrl(provider)) this._checkUrl(config.llm.url, 'LLM API URL');
            const directDefinition = directProviderDefinition(provider);
            const baseUrl = validateDirectProviderUrl(provider, resolveProviderBaseUrl(provider, config.llm.url, 'llm'));
            const url = directDefinition
                ? resolveDirectProviderEndpoint(provider, baseUrl, 'chat')
                : (provider === 'copilot' || isGLMLikeConfig(config.llm))
                    ? this._normalizeUrl(baseUrl, '/chat/completions')
                    : normalizeOpenAICompatUrl(baseUrl, '/v1/chat/completions');
            const authToken = provider === 'copilot'
                ? await this._getCopilotBearerToken(config.llm.key)
                : config.llm.key;
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) headers.Authorization = `Bearer ${String(authToken).replace(/^Bearer\s+/i, '').trim()}`;
            if (!authToken && providerAllowsEmptyKey(provider)) delete headers.Authorization;
            if (provider === 'openrouter') {
                headers['HTTP-Referer'] = 'https://risuai.xyz';
                headers['X-Title'] = 'Librarian System';
            } else if (provider === 'featherless') {
                headers['HTTP-Referer'] = 'https://risuai.xyz';
                headers['X-Title'] = 'LIBRA World Manager';
            } else if (provider === 'z-ai' || provider === 'z-ai-coding') {
                headers['Accept-Language'] = 'en-US,en';
            } else if (provider === 'copilot') {
                headers['Editor-Version'] = `vscode/${COPILOT_CODE_VERSION}`;
                headers['Editor-version'] = `vscode/${COPILOT_CODE_VERSION}`;
                headers['Editor-Plugin-Version'] = `copilot-chat/${COPILOT_CHAT_VERSION}`;
                headers['Editor-plugin-version'] = `copilot-chat/${COPILOT_CHAT_VERSION}`;
                headers['Copilot-Integration-Id'] = 'vscode-chat';
                headers['User-Agent'] = COPILOT_USER_AGENT;
                headers['X-Github-Api-Version'] = '2025-10-01';
                headers['X-Initiator'] = 'user';
            }

            let modelName = config.llm.model;
            if (provider === 'copilot' && COPILOT_MODEL_MAP[modelName]) {
                recordRuntimeDebug('warn', `[LIBRA] Copilot: model "${modelName}" mapped to "${COPILOT_MODEL_MAP[modelName]}"`);
                modelName = COPILOT_MODEL_MAP[modelName];
            }

            const disableReasoningForCall = options.disableReasoning === true
                || options.noReasoning === true
                || String(options.reasoningPresetOverride || '').trim().toLowerCase() === 'off';
            const reasoningPresetKey = disableReasoningForCall ? 'gpt' : getEffectiveReasoningRuntimeFamily(config.llm);
            const tokenBudget = resolveProviderOutputBudget(config.llm, options, reasoningPresetKey);
            const jsonModeRequested = options?.jsonMode === true || options?.forceJsonMode === true;
            const streamRequested = config.llm.stream === true && options?.forceNonStreaming !== true;
            const body = {
                model: modelName,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent }
                ],
                temperature: jsonModeRequested
                    ? 0
                    : (Number.isFinite(Number(config.llm.temp)) ? Number(config.llm.temp) : 0.3),
                max_tokens: tokenBudget.providerMaxTokens
            };
            if (jsonModeRequested) body.response_format = { type: 'json_object' };
            if (reasoningPresetKey === 'glm') {
                body.max_tokens = tokenBudget.providerMaxTokens;
                body.thinking = {
                    type: tokenBudget.reasoningAllowed && String(config.llm.glmThinkingType || 'enabled').toLowerCase() !== 'disabled'
                        ? 'enabled'
                        : 'disabled'
                };
                if (body.thinking.type !== 'disabled' && tokenBudget.reasoningBudgetTokens > 0) {
                    body.thinking.budget_tokens = tokenBudget.reasoningBudgetTokens;
                }
            } else if (reasoningPresetKey === 'deepseek' && provider === 'deepseek') {
                body.max_tokens = tokenBudget.providerMaxTokens;
                if (tokenBudget.reasoningAllowed) delete body.temperature;
            } else if (reasoningPresetKey === 'deepseek' || reasoningPresetKey === 'kimi') {
                body.max_tokens = tokenBudget.providerMaxTokens;
                if (tokenBudget.reasoningAllowed) {
                    body.thinking = tokenBudget.reasoningBudgetTokens > 0
                        ? { type: 'enabled', budget_tokens: tokenBudget.reasoningBudgetTokens }
                        : { type: 'enabled' };
                    delete body.temperature;
                }
            } else if (tokenBudget.reasoningAllowed && config.llm.reasoningEffort && config.llm.reasoningEffort !== 'none') {
                body.reasoning_effort = config.llm.reasoningEffort;
                body.max_completion_tokens = tokenBudget.providerMaxTokens;
                delete body.max_tokens;
                delete body.temperature;
            }
            if (provider === 'lightning-ai') {
                body.chat_template_kwargs = {
                    ...(body.chat_template_kwargs || {}),
                    enable_thinking: tokenBudget.reasoningAllowed
                };
                delete body.thinking;
            }
            if (provider === 'heroku-us' || provider === 'heroku-eu' || provider.startsWith('xiaomi-mimo')) {
                body.max_completion_tokens = body.max_completion_tokens || body.max_tokens || tokenBudget.providerMaxTokens;
                delete body.max_tokens;
            }
            const openAiServiceTier = FlexTierPolicy.requestTierForOpenAI(config.llm.__flexPolicy);
            if (openAiServiceTier) body.service_tier = openAiServiceTier;
            if (streamRequested) {
                body.stream = true;
                if (provider === 'openai' || provider === 'openrouter') body.stream_options = { include_usage: true };
            }
            if (streamRequested) {
                const streamed = await this._fetchStream(url, headers, body, config.llm.timeout, {
                    provider,
                    signal: options?.signal,
                    deadlineAt: options?.deadlineAt,
                    retryPolicy: options?.retryPolicy
                });
                const content = this._ensureNonEmptyText(streamed.content || '', streamed, provider);
                return { content, usage: streamed.usage || {}, serviceTier: config.llm.__flexPolicy?.serviceTier || '', streamed: true, streamMeta: streamed.streamMeta || {} };
            }

            const requestOptions = {
                provider,
                signal: options?.signal,
                deadlineAt: options?.deadlineAt,
                retryPolicy: options?.retryPolicy
            };
            let data;
            let jsonModeFallback = false;
            try {
                data = await this._fetch(url, headers, body, config.llm.timeout, requestOptions);
            } catch (error) {
                const jsonModeUnsupported = jsonModeRequested
                    && /API Error:\s*(?:400|404|415|422)\b[\s\S]*(?:response_format|json(?:_| )?mode|structured output|unsupported|not supported|unknown field|extra inputs)/i.test(String(error?.message || error || ''));
                if (!jsonModeUnsupported) throw error;
                const fallbackBody = { ...body };
                delete fallbackBody.response_format;
                jsonModeFallback = true;
                recordRuntimeDebug('warn', `[LIBRA][LLM] ${provider} rejected JSON response_format; retrying once with prompt-enforced JSON.`);
                data = await this._fetch(url, headers, fallbackBody, config.llm.timeout, requestOptions);
            }
            const content = this._ensureNonEmptyText(
                data?.choices?.[0]?.message?.content
                    || data?.choices?.[0]?.text
                    || data?.output_text
                    || data?.response
                    || data?.rawText
                    || '',
                data,
                provider
            );
            const finishReason = String(data?.choices?.[0]?.finish_reason || data?.choices?.[0]?.finishReason || data?.finish_reason || data?.finishReason || '');
            return {
                content,
                usage: data.usage || {},
                serviceTier: data?.service_tier || data?.serviceTier || '',
                finishReason,
                truncated: /^(?:length|max_tokens)$/i.test(finishReason),
                jsonModeRequested,
                jsonModeFallback
            };
        }

        async getEmbedding(config, text) {
            const provider = (config.embed.provider || 'openai').toLowerCase();
            if (!providerAllowsEmptyKey(provider)) this._checkKey(config.embed.key);
            if (providerRequiresUrl(provider)) this._checkUrl(config.embed.url, 'Embedding API URL');
            const url = normalizeOpenAICompatUrl(resolveProviderBaseUrl(provider, config.embed.url, 'embed'), '/v1/embeddings');
            const headers = { 'Content-Type': 'application/json' };
            if (config.embed.key) headers.Authorization = `Bearer ${config.embed.key}`;
            const body = { input: [text], model: config.embed.model };
            const data = await this._fetch(url, headers, body, config.embed.timeout);
            return data?.data?.[0]?.embedding;
        }
    }

    class OpenAIResponsesProvider extends BaseProvider {
        async callLLM(config, systemPrompt, userContent, options = {}) {
            const provider = normalizeDirectProviderKey(config?.llm?.provider || 'openai');
            if (!providerAllowsEmptyKey(provider)) this._checkKey(config?.llm?.key);
            if (providerRequiresUrl(provider)) this._checkUrl(config?.llm?.url, 'LLM API URL');
            const definition = directProviderDefinition(provider);
            const baseUrl = validateDirectProviderUrl(provider, resolveProviderBaseUrl(provider, config?.llm?.url, 'llm'));
            const url = definition
                ? resolveDirectProviderEndpoint(provider, baseUrl, 'responses')
                : joinProviderEndpoint(baseUrl, '/v1/responses');
            if (!url || (definition && !definition.responsesPath)) {
                throw new LIBRAError(`${definition?.label || provider}는 LIBRA의 Responses 형식 대상이 아닙니다. Chat Completions를 선택해 주세요.`, 'UNSUPPORTED_REQUEST_FORMAT');
            }
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${String(config?.llm?.key || '').replace(/^Bearer\s+/i, '').trim()}`
            };
            if (provider === 'openrouter') {
                headers['HTTP-Referer'] = 'https://risuai.xyz';
                headers['X-Title'] = 'Librarian System';
            }
            const family = getEffectiveReasoningRuntimeFamily(config.llm);
            const tokenBudget = resolveProviderOutputBudget(config.llm, options, family);
            const body = {
                model: config.llm.model,
                input: [{ role: 'user', content: [{ type: 'input_text', text: String(userContent || '') }] }],
                max_output_tokens: tokenBudget.providerMaxTokens
            };
            if (String(systemPrompt || '').trim()) body.instructions = String(systemPrompt);
            if (tokenBudget.reasoningAllowed && config.llm.reasoningEffort && config.llm.reasoningEffort !== 'none') {
                body.reasoning = { effort: config.llm.reasoningEffort };
            }
            if (config.llm.stream === true) body.stream = true;
            if (body.stream) {
                const streamed = await this._fetchStream(url, headers, body, config.llm.timeout, {
                    provider: `${provider}:responses`,
                    signal: options?.signal,
                    deadlineAt: options?.deadlineAt,
                    retryPolicy: options?.retryPolicy
                });
                const content = this._ensureNonEmptyText(streamed.content || '', streamed, provider);
                return { content, usage: streamed.usage || {}, streamed: true, streamMeta: streamed.streamMeta || {} };
            }
            const data = await this._fetch(url, headers, body, config.llm.timeout, {
                provider: `${provider}:responses`,
                signal: options?.signal,
                deadlineAt: options?.deadlineAt,
                retryPolicy: options?.retryPolicy
            });
            const content = this._ensureNonEmptyText(this._extractChatText(data), data, provider);
            return { content, usage: this._normalizeUsage(data?.usage || {}, provider) };
        }

        async getEmbedding(config, text) {
            return new OpenAIProvider().getEmbedding(config, text);
        }
    }

    class RegisteredOpenAICompatibleProvider extends BaseProvider {
        constructor() {
            super();
            this.chatProvider = new OpenAIProvider();
            this.responsesProvider = new OpenAIResponsesProvider();
        }

        async callLLM(config, systemPrompt, userContent, options = {}) {
            return normalizeLLMRequestFormat(config?.llm?.requestFormat || config?.llm?.request_format) === 'responses'
                ? this.responsesProvider.callLLM(config, systemPrompt, userContent, options)
                : this.chatProvider.callLLM(config, systemPrompt, userContent, options);
        }

        async getEmbedding(config, text) {
            return this.chatProvider.getEmbedding(config, text);
        }
    }

    class AnthropicProvider extends BaseProvider {
        async callLLM(config, systemPrompt, userContent, options) {
            this._checkKey(config.llm.key);
            let url = String(config.llm.url || resolveProviderBaseUrl('claude')).trim();
            if (!url.includes('/v1/')) url = url.replace(/\/$/, '') + '/v1/messages';
            const tokenBudget = resolveProviderOutputBudget(config.llm, options, 'claude');
            const headers = {
                'Content-Type': 'application/json',
                'x-api-key': config.llm.key,
                'anthropic-version': '2023-06-01'
            };
            const body = {
                model: config.llm.model,
                system: systemPrompt,
                messages: [{ role: 'user', content: userContent }],
                max_tokens: tokenBudget.providerMaxTokens,
                temperature: Number.isFinite(Number(config.llm.temp)) ? Number(config.llm.temp) : 0.3
            };
            if (tokenBudget.reasoningAllowed && tokenBudget.reasoningBudgetTokens >= 1024 && tokenBudget.providerMaxTokens > tokenBudget.reasoningBudgetTokens) {
                body.thinking = {
                    type: 'enabled',
                    budget_tokens: tokenBudget.reasoningBudgetTokens
                };
                delete body.temperature;
            }
            if (config.llm.stream === true) {
                body.stream = true;
                const streamed = await this._fetchStream(url, headers, body, config.llm.timeout, {
                    provider: 'anthropic',
                    signal: options?.signal,
                    deadlineAt: options?.deadlineAt,
                    retryPolicy: options?.retryPolicy
                });
                return { content: this._ensureNonEmptyText(streamed.content || '', streamed, 'anthropic'), usage: streamed.usage || {}, streamed: true, streamMeta: streamed.streamMeta || {} };
            }
            const data = await this._fetch(url, headers, body, config.llm.timeout, {
                provider: 'anthropic',
                signal: options?.signal,
                deadlineAt: options?.deadlineAt,
                retryPolicy: options?.retryPolicy
            });
            const content = Array.isArray(data.content)
                ? data.content
                    .filter(block => block && (block.type === 'text' || typeof block.text === 'string'))
                    .map(block => String(block.text || '').trim())
                    .filter(Boolean)
                    .join('\n\n')
                : '';
            return { content: this._ensureNonEmptyText(content, data, 'anthropic'), usage: data.usage || {} };
        }
    }

    class GeminiProvider extends BaseProvider {
        async callLLM(config, systemPrompt, userContent, options) {
            this._checkKey(config.llm.key);
            const model = String(config.llm.model || '').trim();
            const url = normalizeGeminiApiEndpoint(config.llm.url, model, 'generateContent');
            this._checkUrl(url);
            const isThinkingModel = /gemini-(3|2\.5)/i.test(model);
            const tokenBudget = resolveProviderOutputBudget(config.llm, options, isThinkingModel ? 'gemini' : 'generic');
            const body = {
                contents: [{ role: "user", parts: [{ text: userContent }] }],
                generationConfig: {
                    temperature: Number.isFinite(Number(config.llm.temp)) ? Number(config.llm.temp) : 0.3,
                    maxOutputTokens: tokenBudget.providerMaxTokens
                }
            };
            if (systemPrompt) {
                body.systemInstruction = { parts: [{ text: systemPrompt }] };
            }
            if (isThinkingModel) {
                body.generationConfig.thinkingConfig = { includeThoughts: false };
                if (tokenBudget.reasoningAllowed && tokenBudget.reasoningBudgetTokens > 0) {
                    body.generationConfig.thinkingConfig.thinkingBudget = tokenBudget.reasoningBudgetTokens;
                }
            }
            const geminiServiceTier = FlexTierPolicy.requestTierForGemini(config.llm.__flexPolicy);
            if (geminiServiceTier) body.service_tier = geminiServiceTier;
            const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': config.llm.key };
            if (config.llm.stream === true) {
                const streamUrl = appendQueryParam(normalizeGeminiApiEndpoint(config.llm.url, model, 'streamGenerateContent'), 'alt=sse');
                const streamed = await this._fetchStream(streamUrl, headers, body, config.llm.timeout, {
                    provider: 'gemini',
                    signal: options?.signal,
                    deadlineAt: options?.deadlineAt,
                    retryPolicy: options?.retryPolicy
                });
                return { content: this._ensureNonEmptyText(streamed.content || '', streamed, 'gemini'), usage: streamed.usage || {}, serviceTier: geminiServiceTier || '', streamed: true, streamMeta: streamed.streamMeta || {} };
            }
            const data = await this._fetch(url, headers, body, config.llm.timeout, {
                provider: 'gemini',
                signal: options?.signal,
                deadlineAt: options?.deadlineAt,
                retryPolicy: options?.retryPolicy
            });
            const content = this._ensureNonEmptyText(this._extractTextParts(data.candidates?.[0]?.content) || '', data, 'gemini');
            return { content, usage: data.usageMetadata || data.usage || {}, serviceTier: data?.service_tier || data?.serviceTier || '' };
        }

        async getEmbedding(config, text) {
            this._checkKey(config.embed.key);
            const url = normalizeGeminiApiEndpoint(config.embed.url, config.embed.model, 'embedContent');
            this._checkUrl(url, 'Embedding API URL');
            const body = {
                model: `models/${config.embed.model}`,
                content: { parts: [{ text: text }] }
            };
            const data = await this._fetch(url, { 'Content-Type': 'application/json', 'x-goog-api-key': config.embed.key }, body, config.embed.timeout);
            return data?.embedding?.values;
        }
    }

    class VertexAIProvider extends BaseProvider {
        static _tokenCache = new Map();

        static _str2ab(privateKey) {
            const binaryString = atob(String(privateKey || '').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n|\n/g, ''));
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
            return bytes.buffer;
        }

        static _base64url(source) {
            let binary = '';
            for (let i = 0; i < source.length; i++) {
                binary += String.fromCharCode(source[i]);
            }
            return btoa(binary)
                .replace(/=+$/, '')
                .replace(/\+/g, '-')
                .replace(/\//g, '_');
        }

        static async _generateAccessToken(clientEmail, privateKey) {
            const now = Math.floor(Date.now() / 1000);
            const header = { alg: 'RS256', typ: 'JWT' };
            const claimSet = {
                iss: clientEmail,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
                aud: 'https://oauth2.googleapis.com/token',
                exp: now + 3600,
                iat: now
            };
            const encodedHeader = VertexAIProvider._base64url(new TextEncoder().encode(JSON.stringify(header)));
            const encodedClaimSet = VertexAIProvider._base64url(new TextEncoder().encode(JSON.stringify(claimSet)));
            const key = await crypto.subtle.importKey(
                'pkcs8',
                VertexAIProvider._str2ab(privateKey),
                { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
                false,
                ['sign']
            );
            const signature = await crypto.subtle.sign(
                'RSASSA-PKCS1-v1_5',
                key,
                new TextEncoder().encode(`${encodedHeader}.${encodedClaimSet}`)
            );
            const jwt = `${encodedHeader}.${encodedClaimSet}.${VertexAIProvider._base64url(new Uint8Array(signature))}`;
            const response = await RisuCompat.request('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
            }, { timeoutMs: 120000 });
            if (!response?.ok) {
                const errText = await response?.text?.().catch(() => String(response?.status || 'Unknown')) || 'No response';
                throw new Error(`Failed to get Vertex AI access token: ${errText}`);
            }
            const data = await response.json();
            if (!data?.access_token) throw new Error('No access token in Vertex AI token response');
            return data.access_token;
        }

        static _buildTokenCacheKey(credentials = null, rawKey = '') {
            if (credentials && typeof credentials === 'object') {
                if (credentials.client_email) {
                    return `svc:${String(credentials.client_email).trim()}:${String(credentials.project_id || '').trim()}:${String(credentials.private_key_id || stableHash(credentials.private_key || '')).trim()}`;
                }
                const token = String(credentials.access_token || credentials.token || '').trim();
                if (token) return `token:${stableHash(token)}`;
            }
            return `raw:${stableHash(String(rawKey || '').trim())}`;
        }

        static _pruneTokenCache() {
            const now = Date.now();
            for (const [key, value] of VertexAIProvider._tokenCache.entries()) {
                if (!value?.token || Number(value.expiry || 0) <= now) VertexAIProvider._tokenCache.delete(key);
            }
            while (VertexAIProvider._tokenCache.size > 8) {
                const oldest = VertexAIProvider._tokenCache.keys().next().value;
                VertexAIProvider._tokenCache.delete(oldest);
            }
        }

        static async _getAccessToken(rawKey) {
            const raw = String(rawKey || '').trim();
            let credentials = null;
            try { credentials = JSON.parse(raw); } catch { credentials = null; }
            const cacheKey = VertexAIProvider._buildTokenCacheKey(credentials, raw);
            VertexAIProvider._pruneTokenCache();
            const cached = VertexAIProvider._tokenCache.get(cacheKey);
            if (cached?.token && Date.now() < cached.expiry) return cached.token;
            if (!credentials || typeof credentials !== 'object') {
                const directToken = raw.replace(/^Bearer\s+/i, '').trim();
                if (!directToken) throw new Error('Vertex AI token missing');
                return directToken;
            }
            if (credentials.access_token || credentials.token) {
                const token = String(credentials.access_token || credentials.token || '').trim();
                if (!token) throw new Error('Vertex AI token missing');
                const expiresAt = Number(credentials.expires_at || credentials.expiry || credentials.expiration_time || 0) || 0;
                const expiresIn = Number(credentials.expires_in || 0) || 0;
                const expiry = expiresAt > Date.now()
                    ? expiresAt
                    : expiresAt > 1000000000
                        ? expiresAt * 1000
                        : expiresIn > 0
                            ? Date.now() + Math.max(30, expiresIn - 60) * 1000
                            : Date.now() + 50 * 60 * 1000;
                VertexAIProvider._tokenCache.set(cacheKey, { token, expiry });
                return token;
            }
            const clientEmail = credentials.client_email;
            const privateKey = credentials.private_key;
            if (!clientEmail || !privateKey) {
                throw new Error('Vertex AI credentials missing client_email/private_key or access_token');
            }
            const token = await VertexAIProvider._generateAccessToken(clientEmail, privateKey);
            VertexAIProvider._tokenCache.set(cacheKey, { token, expiry: Date.now() + 3500 * 1000 });
            return token;
        }

        async callLLM(config, systemPrompt, userContent, options) {
            this._checkKey(config.llm.key);
            const baseUrl = String(config.llm.url || '').trim().replace(/\/$/, '');
            this._checkUrl(baseUrl);
            const model = String(config.llm.model || '').trim();
            const accessToken = await VertexAIProvider._getAccessToken(config.llm.key);
            const isThinkingModel = /gemini-(3|2\.5)/i.test(model);
            const tokenBudget = resolveProviderOutputBudget(config.llm, options, isThinkingModel ? 'gemini' : 'generic');
            const body = {
                contents: [{ role: "user", parts: [{ text: userContent }] }],
                generationConfig: { temperature: Number.isFinite(Number(config.llm.temp)) ? Number(config.llm.temp) : 0.3, maxOutputTokens: tokenBudget.providerMaxTokens }
            };
            if (systemPrompt) {
                body.systemInstruction = { parts: [{ text: systemPrompt }] };
            }
            if (isThinkingModel) {
                body.generationConfig.thinkingConfig = { includeThoughts: false };
                if (tokenBudget.reasoningAllowed && tokenBudget.reasoningBudgetTokens > 0) {
                    body.generationConfig.thinkingConfig.thinkingBudget = tokenBudget.reasoningBudgetTokens;
                }
            }
            const headers = FlexTierPolicy.applyVertexHeaders({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }, config.llm.__flexPolicy);
            const url = vertexGeminiContentUrl(baseUrl, model, 'generateContent');
            if (config.llm.stream === true) {
                const streamUrl = appendQueryParam(vertexGeminiContentUrl(baseUrl, model, 'streamGenerateContent'), 'alt=sse');
                const streamed = await this._fetchStream(streamUrl, headers, body, config.llm.timeout, {
                    provider: 'vertex',
                    signal: options?.signal,
                    deadlineAt: options?.deadlineAt,
                    retryPolicy: options?.retryPolicy
                });
                return { content: this._ensureNonEmptyText(streamed.content || '', streamed, 'vertex'), usage: streamed.usage || {}, serviceTier: config.llm.__flexPolicy?.serviceTier || '', streamed: true, streamMeta: streamed.streamMeta || {} };
            }
            const data = await this._fetch(url, headers, body, config.llm.timeout, {
                provider: 'vertex',
                signal: options?.signal,
                deadlineAt: options?.deadlineAt,
                retryPolicy: options?.retryPolicy
            });
            const content = this._ensureNonEmptyText(this._extractTextParts(data.candidates?.[0]?.content) || '', data, 'vertex');
            return { content, usage: data.usageMetadata || data.usage || {}, serviceTier: config.llm.__flexPolicy?.serviceTier || '' };
        }

        async getEmbedding(config, text) {
            this._checkKey(config.embed.key);
            this._checkUrl(config.embed.url, 'Embedding API URL');
            const accessToken = await VertexAIProvider._getAccessToken(config.embed.key);
            const body = {
                instances: [{ content: text }],
                parameters: { autoTruncate: true }
            };
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` };
            const data = await this._fetch(vertexPredictUrl(config.embed.url, config.embed.model), headers, body, config.embed.timeout);
            return data?.predictions?.[0]?.embeddings?.values
                || data?.embedding?.values
                || data?.embeddings?.[0]?.values;
        }
    }


    class OllamaProvider extends BaseProvider {
        _extractOllamaContent(data = {}) {
            if (!data || typeof data !== 'object') return '';
            const choice = Array.isArray(data?.choices) ? data.choices[0] || {} : {};
            const messageListText = Array.isArray(data?.messages)
                ? data.messages
                    .filter(message => message && (!message.role || String(message.role).toLowerCase() === 'assistant'))
                    .map(message => this._extractTextDeep(message?.content || message?.text || ''))
                    .filter(Boolean)
                    .join('\n\n')
                : '';
            const direct = [
                this._extractTextDeep(data?.message?.content),
                this._extractTextDeep(data?.response),
                this._extractTextDeep(data?.output_text),
                this._extractTextDeep(data?.text),
                this._extractTextDeep(data?.content),
                this._extractTextDeep(choice?.message?.content),
                this._extractTextDeep(choice?.text),
                messageListText
            ].map(value => String(value || '').trim()).filter(Boolean).join('\n\n');
            return direct || this._extractChatText(data);
        }

        _extractOllamaUsage(data = {}) {
            const usage = data?.usage && typeof data.usage === 'object' ? data.usage : {};
            const promptTokens = usage.prompt_tokens ?? usage.promptTokenCount ?? data?.prompt_eval_count;
            const completionTokens = usage.completion_tokens ?? usage.completionTokenCount ?? data?.eval_count;
            const totalTokens = usage.total_tokens ?? usage.totalTokenCount;
            const normalized = {
                prompt_tokens: Number.isFinite(Number(promptTokens)) ? Number(promptTokens) : undefined,
                completion_tokens: Number.isFinite(Number(completionTokens)) ? Number(completionTokens) : undefined,
                total_tokens: Number.isFinite(Number(totalTokens)) ? Number(totalTokens) : undefined
            };
            if (normalized.total_tokens === undefined && (normalized.prompt_tokens !== undefined || normalized.completion_tokens !== undefined)) {
                normalized.total_tokens = Number(normalized.prompt_tokens || 0) + Number(normalized.completion_tokens || 0);
            }
            return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
        }

        _mergeOllamaUsage(...items) {
            const totals = {};
            for (const item of items) {
                const usage = this._extractOllamaUsage(item || {});
                for (const [key, value] of Object.entries(usage)) {
                    totals[key] = Number(totals[key] || 0) + Number(value || 0);
                }
            }
            return totals;
        }

        _buildOllamaCombinedPrompt(systemPrompt = '', userContent = '') {
            return [
                systemPrompt ? `System:\n${String(systemPrompt).trim()}` : '',
                `User:\n${String(userContent || '').trim()}`,
                'Assistant:'
            ].filter(Boolean).join('\n\n');
        }

        _summarizeOllamaResponse(label = 'ollama', data = {}) {
            const message = data?.message && typeof data.message === 'object' ? data.message : {};
            const choice = Array.isArray(data?.choices) ? data.choices[0] || {} : {};
            const content = this._extractOllamaContent(data);
            const thinking = [
                message.thinking,
                data?.thinking,
                choice?.message?.thinking,
                choice?.delta?.thinking
            ].map(value => String(value || '').trim()).filter(Boolean).join('\n\n');
            return {
                label,
                keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 16) : [],
                done: data?.done === true,
                done_reason: data?.done_reason || data?.doneReason || data?.stop_reason || '',
                error: typeof data?.error === 'string' ? data.error : (data?.error?.message || ''),
                contentChars: String(content || '').length,
                messageContentChars: String(message?.content || choice?.message?.content || '').length,
                responseChars: String(data?.response || '').length,
                thinkingChars: thinking.length,
                promptEvalCount: Number(data?.prompt_eval_count || 0) || 0,
                evalCount: Number(data?.eval_count || 0) || 0
            };
        }

        _formatOllamaDiagnostics(summaries = []) {
            return summaries
                .map(summary => {
                    const parts = [
                        summary.label,
                        summary.done ? 'done' : '',
                        summary.done_reason ? `reason=${summary.done_reason}` : '',
                        `content=${summary.contentChars || 0}`,
                        summary.thinkingChars ? `thinking=${summary.thinkingChars}` : '',
                        summary.evalCount ? `eval=${summary.evalCount}` : '',
                        summary.error ? `error=${summary.error}` : ''
                    ].filter(Boolean);
                    return parts.join(' ');
                })
                .join(' | ');
        }

        _shouldUseOllamaJsonMode(systemPrompt = '', userContent = '', options = {}) {
            if (options?.jsonMode === false || options?.forceJsonMode === false) return false;
            if (options?.jsonMode === true || options?.forceJsonMode === true) return true;
            const meta = [
                options?.label,
                options?.debugLabel,
                options?.reason,
                options?.domain,
                options?.featureDomain
            ].map(value => String(value || '')).join(' ');
            const promptText = `${systemPrompt || ''}\n${userContent || ''}`;
            const likelyStructuredTask = /cold[-_ ]?(?:start|reanalysis)|structured|analysis|synthesis|merge|chunk|json/i.test(`${meta}\n${promptText}`);
            if (!likelyStructuredTask) return false;
            return /(?:\bJSON\b|유효한\s*JSON|반드시\s*JSON|JSON\s*only|Return\s+JSON|Strict\s+Output\s+Rules|엄격\s*출력\s*규칙)/i.test(promptText);
        }

        async callLLM(config, systemPrompt, userContent, options) {
            const headers = { 'Content-Type': 'application/json' };
            if (config.llm.key) headers.Authorization = `Bearer ${String(config.llm.key).replace(/^Bearer\s+/i, '').trim()}`;
            const tokenBudget = resolveProviderOutputBudget(config.llm, options, 'generic');
            const requestOptions = {
                provider: 'ollama',
                signal: options?.signal,
                deadlineAt: options?.deadlineAt,
                retryPolicy: options?.retryPolicy
            };
            const useJsonMode = this._shouldUseOllamaJsonMode(systemPrompt, userContent, options);
            // ollama 는 다른 provider 와 달리 추론을 끄는 파라미터를 보내지 않으면 모델
            // 기본값(thinking on)을 그대로 쓴다. hidden thinking 은 num_predict 안에서
            // 소비되므로, 짧은 예산이 전부 사고에 소진되고 content 가 빈다
            // (실측: num_predict 1000 → content 0자 / thinking 4262자, done=length).
            // 예산을 늘리는 것으로는 해결되지 않는다 (4000 → content 0자 / thinking 17117자).
            const ollamaThink = tokenBudget.reasoningAllowed === true;
            const ollamaOptions = {
                temperature: Number.isFinite(Number(config.llm.temp)) ? Number(config.llm.temp) : 0.3,
                num_predict: tokenBudget.providerMaxTokens
                    + (tokenBudget.reasoningAllowed ? tokenBudget.reasoningBudgetTokens : 0)
            };
            const ollamaThinkingField = ollamaSupportsThinkField(config.llm.model)
                ? { think: ollamaThink }
                : {};
            const body = {
                model: config.llm.model,
                messages: [
                    systemPrompt ? { role: 'system', content: systemPrompt } : null,
                    { role: 'user', content: userContent }
                ].filter(Boolean),
                stream: config.llm.stream === true,
                options: ollamaOptions,
                ...ollamaThinkingField,
                ...(useJsonMode ? { format: 'json' } : {})
            };
            const url = ollamaApiUrl(config.llm.url, '/api/chat');
            if (config.llm.stream === true) {
                const streamed = await this._fetchStream(url, headers, body, config.llm.timeout, requestOptions);
                return { content: this._ensureNonEmptyText(streamed.content || '', streamed, 'ollama'), usage: streamed.usage || {}, streamed: true, streamMeta: streamed.streamMeta || {} };
            }
            const data = await this._fetch(url, headers, body, config.llm.timeout, requestOptions);
            let content = this._extractOllamaContent(data);
            let fallbackEndpoint = '';
            const attempts = [{ label: 'chat', data }];
            const combinedPrompt = this._buildOllamaCombinedPrompt(systemPrompt, userContent);
            if (!String(content || '').trim()) {
                fallbackEndpoint = 'chat-plain';
                const chatPlainData = await this._fetch(ollamaApiUrl(config.llm.url, '/api/chat'), headers, {
                    model: config.llm.model,
                    messages: [{ role: 'user', content: combinedPrompt }],
                    stream: false,
                    options: ollamaOptions,
                    ...ollamaThinkingField,
                    ...(useJsonMode ? { format: 'json' } : {})
                }, config.llm.timeout, requestOptions);
                attempts.push({ label: 'chat-plain', data: chatPlainData });
                content = this._extractOllamaContent(chatPlainData);
            }
            if (!String(content || '').trim()) {
                fallbackEndpoint = 'generate';
                const generateBody = {
                    model: config.llm.model,
                    prompt: String(userContent || ''),
                    stream: false,
                    options: ollamaOptions,
                    ...ollamaThinkingField,
                    ...(useJsonMode ? { format: 'json' } : {})
                };
                if (systemPrompt) generateBody.system = String(systemPrompt);
                const generateData = await this._fetch(ollamaApiUrl(config.llm.url, '/api/generate'), headers, generateBody, config.llm.timeout, requestOptions);
                attempts.push({ label: 'generate', data: generateData });
                content = this._extractOllamaContent(generateData);
            }
            if (!String(content || '').trim()) {
                fallbackEndpoint = 'generate-raw';
                const rawGenerateData = await this._fetch(ollamaApiUrl(config.llm.url, '/api/generate'), headers, {
                    model: config.llm.model,
                    prompt: combinedPrompt,
                    stream: false,
                    raw: true,
                    options: ollamaOptions,
                    ...ollamaThinkingField,
                    ...(useJsonMode ? { format: 'json' } : {})
                }, config.llm.timeout, requestOptions);
                attempts.push({ label: 'generate-raw', data: rawGenerateData });
                content = this._extractOllamaContent(rawGenerateData);
            }
            const summaries = attempts.map(attempt => this._summarizeOllamaResponse(attempt.label, attempt.data));
            if (!String(content || '').trim()) {
                const diagnosticText = this._formatOllamaDiagnostics(summaries) || 'no diagnostic';
                throw new LIBRAError(`ollama returned no text content (${diagnosticText})`, 'EMPTY_RESPONSE', {
                    provider: 'ollama',
                    model: config.llm.model,
                    fallbackEndpoint,
                    ollamaDiagnostics: summaries
                });
            }
            const successfulAttempt = [...attempts].reverse().find(attempt => String(this._extractOllamaContent(attempt.data) || '').trim()) || attempts[attempts.length - 1] || null;
            const finalUsage = successfulAttempt ? this._extractOllamaUsage(successfulAttempt.data || {}) : {};
            const attemptUsageTotal = this._mergeOllamaUsage(...attempts.map(attempt => attempt.data));
            const result = {
                content: String(content || '').trim(),
                usage: finalUsage
            };
            if (fallbackEndpoint) result.fallbackEndpoint = fallbackEndpoint;
            if (successfulAttempt?.label) result.usageSource = successfulAttempt.label;
            if (attempts.length > 1) result.attemptUsageTotal = attemptUsageTotal;
            return result;
        }

        async getEmbedding(config, text) {
            const headers = { 'Content-Type': 'application/json' };
            if (config.embed.key) headers.Authorization = `Bearer ${String(config.embed.key).replace(/^Bearer\s+/i, '').trim()}`;
            const body = { model: config.embed.model, input: text, truncate: true };
            const data = await this._fetch(ollamaApiUrl(config.embed.url, '/api/embed'), headers, body, config.embed.timeout);
            return (Array.isArray(data?.embeddings) && Array.isArray(data.embeddings[0]) ? data.embeddings[0] : null)
                || (Array.isArray(data?.embedding) ? data.embedding : null)
                || (Array.isArray(data?.data?.[0]?.embedding) ? data.data[0].embedding : null);
        }
    }

    class VertexOpenAIProvider extends BaseProvider {
        async callLLM(config, systemPrompt, userContent, options) {
            this._checkKey(config.llm.key);
            this._checkUrl(config.llm.url, 'Vertex OpenAI URL');
            const token = await VertexAIProvider._getAccessToken(config.llm.key);
            const tokenBudget = resolveProviderOutputBudget(config.llm, options, 'gpt');
            const body = {
                model: config.llm.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent }
                ],
                temperature: Number.isFinite(Number(config.llm.temp)) ? Number(config.llm.temp) : 0.3,
                max_tokens: tokenBudget.providerMaxTokens
            };
            if (tokenBudget.reasoningAllowed && config.llm.reasoningEffort && config.llm.reasoningEffort !== 'none') {
                body.reasoning_effort = config.llm.reasoningEffort;
                body.max_completion_tokens = tokenBudget.providerMaxTokens;
                delete body.max_tokens;
                delete body.temperature;
            }
            if (config.llm.stream === true) body.stream = true;
            const headers = FlexTierPolicy.applyVertexHeaders({
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }, config.llm.__flexPolicy);
            const url = vertexOpenAIUrl(config.llm.url);
            if (config.llm.stream === true) {
                const streamed = await this._fetchStream(url, headers, body, config.llm.timeout, {
                    provider: 'openai',
                    signal: options?.signal,
                    deadlineAt: options?.deadlineAt,
                    retryPolicy: options?.retryPolicy
                });
                return { content: this._ensureNonEmptyText(streamed.content || '', streamed, 'vertex-openai'), usage: streamed.usage || {}, serviceTier: config.llm.__flexPolicy?.serviceTier || '', streamed: true, streamMeta: streamed.streamMeta || {} };
            }
            const data = await this._fetch(url, headers, body, config.llm.timeout, {
                provider: 'openai',
                signal: options?.signal,
                deadlineAt: options?.deadlineAt,
                retryPolicy: options?.retryPolicy
            });
            const content = data?.choices?.[0]?.message?.content || data?.output_text || data?.response || '';
            return { content: this._ensureNonEmptyText(content, data, 'vertex-openai'), usage: data.usage || {}, serviceTier: data?.service_tier || config.llm.__flexPolicy?.serviceTier || '' };
        }
    }

    const AutoProvider = (() => {
        const registeredCompatible = new RegisteredOpenAICompatibleProvider();
        const providers = {
            openai: registeredCompatible,
            anthropic: new AnthropicProvider(),
            claude: new AnthropicProvider(),
            gemini: new GeminiProvider(),
            'gemini-embedding': new GeminiProvider(),
            vertex: new VertexAIProvider(),
            'vertex-embedding': new VertexAIProvider(),
            'vertex-openai': new VertexOpenAIProvider(),
            vertex_openai: new VertexOpenAIProvider(),
            openrouter: registeredCompatible,
            lmstudio: new OpenAIProvider(),
            lm_studio: new OpenAIProvider(),
            ollama: new OllamaProvider(),
            ollama_cloud: new OpenAIProvider(),
            copilot: new OpenAIProvider(),
            voyageai: new OpenAIProvider(),
            custom: new OpenAIProvider()
        };
        Object.keys(DIRECT_LLM_PROVIDER_REGISTRY).forEach(provider => {
            providers[provider] = registeredCompatible;
        });

        return {
            get: (name) => providers[normalizeDirectProviderKey(name || 'openai')] || providers.openai
        };
    })();
    const DirectProviderCatalog = (() => {
        const cache = new Map();
        const CACHE_TTL_MS = 5 * 60 * 1000;
        const builtins = Object.freeze({
            openai: Object.freeze({ label: 'OpenAI', modelsPath: '/v1/models', modelsUrl: 'https://api.openai.com/v1/models', responsesUrl: 'https://api.openai.com/v1/responses' }),
            openrouter: Object.freeze({ label: 'OpenRouter', modelsPath: '/v1/models', modelsUrl: 'https://openrouter.ai/api/v1/models', responsesUrl: 'https://openrouter.ai/api/v1/responses' }),
            gemini: Object.freeze({ label: 'Gemini AI Studio', modelsPath: '/v1beta/models', modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models', responsesUrl: '' }),
            ollama_cloud: Object.freeze({ label: 'Ollama Cloud', modelsPath: '/v1/models', modelsUrl: 'https://ollama.com/v1/models', responsesUrl: '' }),
            nanogpt: Object.freeze({ label: 'NanoGPT', modelsPath: '/v1/models', modelsUrl: 'https://nano-gpt.com/api/v1/models', responsesUrl: '' })
        });
        const metadataFor = (provider = '', rawUrl = '') => {
            const normalized = normalizeDirectProviderKey(provider);
            const direct = directProviderDefinition(normalized);
            if (direct) {
                return {
                    key: normalized,
                    label: direct.label,
                    baseUrl: direct.baseUrl,
                    chatUrl: resolveDirectProviderEndpoint(normalized, rawUrl, 'chat'),
                    responsesUrl: resolveDirectProviderEndpoint(normalized, rawUrl, 'responses'),
                    modelsUrl: resolveDirectProviderEndpoint(normalized, rawUrl, 'models'),
                    supportsResponses: !!direct.responsesPath,
                    requiresConfiguredUrl: direct.requiresConfiguredUrl === true
                };
            }
            const builtin = builtins[normalized];
            if (!builtin) return null;
            const base = String(rawUrl || '').trim();
            return {
                key: normalized,
                label: builtin.label,
                baseUrl: resolveProviderBaseUrl(normalized, base, 'llm'),
                chatUrl: base ? joinProviderEndpoint(base, '/v1/chat/completions') : normalizeOpenAICompatUrl(resolveProviderBaseUrl(normalized, '', 'llm'), '/v1/chat/completions'),
                responsesUrl: base ? joinProviderEndpoint(base, '/v1/responses') : builtin.responsesUrl,
                modelsUrl: base ? joinProviderEndpoint(base, builtin.modelsPath || '/v1/models') : builtin.modelsUrl,
                supportsResponses: !!builtin.responsesUrl,
                requiresConfiguredUrl: false
            };
        };
        const normalizeModels = (payload = {}) => {
            const source = Array.isArray(payload)
                ? payload
                : Array.isArray(payload?.data)
                    ? payload.data
                    : Array.isArray(payload?.models)
                        ? payload.models
                        : Array.isArray(payload?.items)
                            ? payload.items
                            : [];
            const seen = new Set();
            return source.map(item => {
                const record = typeof item === 'string' ? { id: item } : (item || {});
                const id = String(record.id || record.model || record.slug || record.name || '').trim();
                if (!id || seen.has(id)) return null;
                seen.add(id);
                return {
                    id,
                    label: String(record.display_name || record.displayName || record.label || record.name || id).trim() || id,
                    contextWindow: Number(record.context_length || record.context_window || record.contextWindow || 0) || 0,
                    maxOutputTokens: Number(record.max_output_tokens || record.maxOutputTokens || record.max_completion_tokens || 0) || 0
                };
            }).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
        };
        const listModels = async (provider = '', options = {}) => {
            const meta = metadataFor(provider, options?.url || '');
            if (!meta?.modelsUrl) throw new LIBRAError(`${meta?.label || provider}는 자동 모델 목록을 제공하지 않습니다. 모델 ID를 직접 입력해 주세요.`, 'MODEL_LIST_UNAVAILABLE');
            validateDirectProviderUrl(meta.key, options?.url || meta.baseUrl);
            const key = String(options?.key || '').trim();
            if (!providerAllowsEmptyKey(meta.key) && !key) throw new LIBRAError('모델 목록을 불러오려면 API Key가 필요합니다.', 'MISSING_KEY');
            const cacheKey = `${meta.key}|${meta.modelsUrl}|${TokenizerEngine.simpleHash(key)}`;
            const cached = cache.get(cacheKey);
            if (options?.force !== true && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models.map(item => ({ ...item }));
            const headers = { 'Accept': 'application/json' };
            if (key && meta.key === 'gemini') headers['x-goog-api-key'] = key.replace(/^Bearer\s+/i, '').trim();
            else if (key) headers.Authorization = `Bearer ${key.replace(/^Bearer\s+/i, '').trim()}`;
            if (meta.key === 'openrouter') {
                headers['HTTP-Referer'] = 'https://risuai.xyz';
                headers['X-Title'] = 'Librarian System';
            }
            const response = await new BaseProvider()._fetchRaw(meta.modelsUrl, { method: 'GET', headers }, Math.max(5000, Number(options?.timeout || 20000) || 20000), {
                signal: options?.signal,
                retryPolicy: { enabled: true, maxRetries: 1, statuses: [429, 502, 503, 504], minDelayMs: 500, maxDelayMs: 2500 }
            });
            if (!response?.ok) {
                const detail = await response?.text?.().catch(() => '') || '';
                throw new LIBRAError(`모델 목록 조회 실패: HTTP ${response?.status || 'Unknown'}${detail ? ` - ${detail.slice(0, 240)}` : ''}`, 'MODEL_LIST_ERROR');
            }
            const payload = await response.json().catch(() => null);
            const models = normalizeModels(payload || {}).map(item => meta.key === 'gemini'
                ? { ...item, id: String(item.id || '').replace(/^models\//, ''), label: String(item.label || item.id || '').replace(/^models\//, '') }
                : item);
            if (!models.length) throw new LIBRAError('제공자가 빈 모델 목록을 반환했습니다.', 'MODEL_LIST_EMPTY');
            cache.set(cacheKey, { at: Date.now(), models });
            return models.map(item => ({ ...item }));
        };
        return Object.freeze({
            get: (provider, options = {}) => {
                const meta = metadataFor(provider, options?.url || '');
                return meta ? { ...meta } : null;
            },
            listProviders: () => Object.keys(DIRECT_LLM_PROVIDER_REGISTRY).map(key => ({ key, label: DIRECT_LLM_PROVIDER_REGISTRY[key].label })),
            listModels,
            resetCache: () => cache.clear()
        });
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_DirectProviderCatalog = DirectProviderCatalog;
    } catch (_) {}
    try {
        if (typeof globalThis !== 'undefined' && globalThis.__LIBRA_PROVIDER_TEST_HOOKS__ === true) {
            globalThis.__LIBRA_PROVIDER_TEST_API__ = Object.freeze({
                resolveProviderOutputBudget: (llmConfig, options, family) => ({ ...resolveProviderOutputBudget(llmConfig, options, family) }),
        ollamaSupportsThinkField: (model) => ollamaSupportsThinkField(model),
        noteOllamaThinkUnsupported: (model) => noteOllamaThinkUnsupported(model),
                createBaseProvider: () => new BaseProvider(),
                getProvider: (name) => AutoProvider.get(name),
                normalizeProviderKey: normalizeDirectProviderKey,
                resolveEndpoint: (provider, url, kind = 'chat') => resolveDirectProviderEndpoint(provider, url, kind),
                listDirectProviders: () => DirectProviderCatalog.listProviders(),
                getProviderMetadata: (provider, options = {}) => DirectProviderCatalog.get(provider, options),
                listModels: (provider, options = {}) => DirectProviderCatalog.listModels(provider, options)
            });
        }
    } catch (_) {}

    const MEMORY_PRESETS = {
        general: { maxLimit: 120, threshold: 6, simThreshold: 0.35, gcBatchSize: 4 },
        sim_small: { maxLimit: 220, threshold: 5, simThreshold: 0.26, gcBatchSize: 6 },
        sim_medium: { maxLimit: 360, threshold: 4, simThreshold: 0.20, gcBatchSize: 8 },
        sim_large: { maxLimit: 560, threshold: 3, simThreshold: 0.15, gcBatchSize: 12 }
    };
    // A named preset is a bundle, never permission to discard explicit custom values.
    const normalizeMemoryRetentionSettings = (config = {}) => {
        const out = { ...config };
        if (!Object.prototype.hasOwnProperty.call(out, 'memoryPreset')) return out;
        const name = String(out.memoryPreset || 'custom').trim().toLowerCase();
        const preset = Object.prototype.hasOwnProperty.call(MEMORY_PRESETS, name) ? MEMORY_PRESETS[name] : null;
        out.memoryPreset = preset ? name : 'custom';
        if (!preset) return out;
        const conflicts = Object.entries(preset).some(([key, value]) =>
            Object.prototype.hasOwnProperty.call(out, key) && out[key] !== undefined && Number(out[key]) !== value);
        if (conflicts) {
            out.memoryPreset = 'custom';
            return out;
        }
        for (const [key, value] of Object.entries(preset)) {
            if (!Object.prototype.hasOwnProperty.call(out, key) || out[key] === undefined) out[key] = value;
        }
        return out;
    };
    const MEMORY_RETENTION_GUARD = Object.freeze({
        minMaxLimit: 20,
        maxMaxLimit: 5000,
        minThreshold: 1,
        maxThreshold: 10,
        minSimThreshold: 0.01,
        maxSimThreshold: 1,
        minGcBatchSize: 1,
        maxGcBatchSize: 200
    });
    const sanitizeMemoryRetentionConfig = (cfg = {}, context = 'runtime') => {
        if (!cfg || typeof cfg !== 'object') return cfg;
        const fallback = MEMORY_PRESETS.general;
        const changes = [];
        const asNumber = (value) => {
            const n = Number(value);
            return Number.isFinite(n) ? n : NaN;
        };
        const coerceInt = (key, fallbackValue, min, max) => {
            const raw = cfg[key];
            const n = asNumber(raw);
            let next = Number.isFinite(n) ? Math.floor(n) : fallbackValue;
            if (!Number.isFinite(n) || next <= 0) {
                changes.push(`${key}:${String(raw)}→${fallbackValue}`);
                next = fallbackValue;
            } else if (next < min) {
                changes.push(`${key}:${String(raw)}→${min}`);
                next = min;
            }
            if (next > max) {
                changes.push(`${key}:${String(raw)}→${max}`);
                next = max;
            }
            cfg[key] = next;
            return next;
        };
        const coerceFloat = (key, fallbackValue, min, max) => {
            const raw = cfg[key];
            const n = asNumber(raw);
            let next = Number.isFinite(n) ? n : fallbackValue;
            if (!Number.isFinite(n) || next <= 0) {
                changes.push(`${key}:${String(raw)}→${fallbackValue}`);
                next = fallbackValue;
            } else if (next < min) {
                changes.push(`${key}:${String(raw)}→${min}`);
                next = min;
            }
            if (next > max) {
                changes.push(`${key}:${String(raw)}→${max}`);
                next = max;
            }
            cfg[key] = next;
            return next;
        };

        const maxLimit = coerceInt('maxLimit', fallback.maxLimit, MEMORY_RETENTION_GUARD.minMaxLimit, MEMORY_RETENTION_GUARD.maxMaxLimit);
        coerceInt('threshold', fallback.threshold, MEMORY_RETENTION_GUARD.minThreshold, MEMORY_RETENTION_GUARD.maxThreshold);
        coerceFloat('simThreshold', fallback.simThreshold, MEMORY_RETENTION_GUARD.minSimThreshold, MEMORY_RETENTION_GUARD.maxSimThreshold);
        const gcBatchSize = coerceInt('gcBatchSize', fallback.gcBatchSize, MEMORY_RETENTION_GUARD.minGcBatchSize, MEMORY_RETENTION_GUARD.maxGcBatchSize);
        if (gcBatchSize > maxLimit) {
            changes.push(`gcBatchSize:${gcBatchSize}→${maxLimit}`);
            cfg.gcBatchSize = maxLimit;
        }

        if (changes.length > 0) {
            try {
                recordRuntimeDebug('warn', `[LIBRA][ConfigGuard] Memory retention config normalized (${context}): ${changes.join(', ')}`);
            } catch {}
        }
        return cfg;
    };
    const WEIGHT_MODE_PRESETS = {
        auto: { similarity: 0.5, importance: 0.3, recency: 0.2 }
    };

    const normalizeWeights = (weights, fallback = WEIGHT_MODE_PRESETS.auto) => {
        const raw = {
            similarity: Number(weights?.similarity ?? fallback.similarity),
            importance: Number(weights?.importance ?? fallback.importance),
            recency: Number(weights?.recency ?? fallback.recency)
        };
        let sum = raw.similarity + raw.importance + raw.recency;
        if (!(sum > 0)) return { ...fallback };
        if (Math.abs(sum - 1) > 0.01) {
            raw.similarity /= sum;
            raw.importance /= sum;
            raw.recency /= sum;
        }
        return raw;
    };

    const resolveWeightsForMode = (mode, customWeights) => {
        const normalizedMode = String(mode || 'auto').toLowerCase();
        if (normalizedMode === 'custom') return normalizeWeights(customWeights, WEIGHT_MODE_PRESETS.auto);
        if (WEIGHT_MODE_PRESETS[normalizedMode]) return { ...WEIGHT_MODE_PRESETS[normalizedMode] };
        return { ...WEIGHT_MODE_PRESETS.auto };
    };

    // Typed recall never reads mutable CONFIG or the legacy provider/cache/queue.
    // Only audited input modes are accepted; no silent provider fallback.
    const StrictRecallEmbeddingTransport = Object.freeze({
        snapshot(provider) {
            if (!provider || JSON.stringify(provider).length > 16384) throw new Error('provider_snapshot_bound');
            SemanticRecallIndex.providerDescriptor(provider);
            const p = JSON.parse(JSON.stringify(provider));
            const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
            if (!['ollama', 'openai'].includes(p.provider) || p.queryMode !== 'input' || p.documentMode !== 'input') throw new Error('unsupported_provider_mode');
            const endpoint = new URL(p.endpoint);
            if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('invalid_endpoint');
            const options = p.options || {};
            if (p.provider === 'ollama' && (options.truncate !== false || Object.keys(options).some(k => k !== 'truncate'))) throw new Error('unsupported_provider_options');
            if (p.provider === 'openai' && Object.keys(options).length) throw new Error('unsupported_provider_options');
            return freeze(p);
        },
        async request(text, provider, { mode, signal, deadline } = {}) {
            let attempted = false;
            try {
                const p = this.snapshot(provider);
                if (mode !== p.queryMode && mode !== p.documentMode) throw new Error('unsupported_mode');
                if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 65536) throw new Error('input_bound');
                if (!Number.isFinite(deadline) || deadline <= Date.now() || signal?.aborted) throw new Error(signal?.aborted ? 'cancelled' : 'deadline');
                const headers = { 'Content-Type': 'application/json' };
                if (typeof p.key === 'string' && p.key) headers.Authorization = `Bearer ${p.key}`;
                const body = p.provider === 'ollama' ? { model: p.model, input: text, truncate: false }
                    : { model: p.model, input: [text], encoding_format: 'float' };
                attempted = true;
                const response = await RisuCompat.request(p.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal }, { timeoutMs: Math.max(1000, deadline - Date.now()) });
                if (!response?.ok) throw new Error(`embedding_http_${response?.status || 0}`);
                const raw = await response.text();
                if (typeof raw !== 'string' || raw.length > 1048576) throw new Error('response_bound');
                const data = JSON.parse(raw), vector = p.provider === 'ollama' ? data?.embeddings?.[0] : data?.data?.[0]?.embedding;
                if (!Array.isArray(vector) || vector.length !== p.dimension || !vector.every(n => typeof n === 'number' && Number.isFinite(n))
                    || !Number.isFinite(Math.hypot(...vector)) || Math.hypot(...vector) <= 0) throw new Error('invalid_vector');
                if (signal?.aborted || Date.now() >= deadline) return { ok: false, reason: signal?.aborted ? 'cancelled' : 'deadline', uncertain: true };
                return { ok: true, vector: Object.freeze([...vector]), provider: SemanticRecallIndex.providerDescriptor(p),
                    sourceHash: SemanticRecallIndex.sourceHash(text), mode, dimension: p.dimension };
            } catch (error) { return { ok: false, reason: String(error?.message || 'embedding_failed'), attempted, uncertain: attempted }; }
        }
    });

    const inferColdStartScopePreset = (limit) => {
        const n = Number(limit || 0);
        if (!Number.isFinite(n) || n <= 0) return 'all';
        if (n === 100) return 'recent100';
        if (n === 200) return 'recent200';
        if (n === 500) return 'recent500';
        return 'custom';
    };
