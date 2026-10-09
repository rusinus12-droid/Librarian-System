const normalizeAfterRequestTypeKey = (requestType = '') => String(requestType || '').trim().toLowerCase() || 'unknown';

const normalizeMainResponseTransportMode = (value = '') => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'unknown';
    if (normalized === 'stream' || normalized === 'streaming') return 'stream';
    if (normalized === 'nonstream' || normalized === 'non-stream' || normalized === 'blocking' || normalized === 'http') return 'nonstream';
    return 'unknown';
};

const isOriginlessAuxRequestType = (requestType = '') => {
    const typeKey = normalizeAfterRequestTypeKey(requestType);
    return typeKey === 'otherax'
        || typeKey === 'other-ax'
        || typeKey === 'other_ax'
        || typeKey === 'submodel'
        || typeKey === 'sub-model'
        || typeKey === 'sub_model';
};

const normalizeMainResponseTransportPayload = (value = null) => {
    const candidate = (value && typeof value === 'object') ? value : { mode: value };
    const mode = normalizeMainResponseTransportMode(
        candidate?.mode
        || candidate?.transportMode
        || candidate?.responseTransportMode
        || candidate?.mainResponseTransportMode
    );
    const source = String(
        candidate?.source
        || candidate?.transportSource
        || candidate?.responseTransportSource
        || candidate?.mainResponseTransportSource
        || ''
    ).trim();
    const interceptorType = String(
        candidate?.interceptorType
        || candidate?.responseTransportInterceptor
        || candidate?.mainResponseTransportInterceptor
        || ''
    ).trim().toLowerCase();
    const observedAt = Number(
        candidate?.observedAt
        || candidate?.responseTransportObservedAt
        || candidate?.mainResponseTransportObservedAt
        || 0
    );
    const reliable = candidate?.reliable === true
        || candidate?.responseTransportReliable === true
        || candidate?.mainResponseTransportReliable === true;
    const bodyStreamFlag = typeof candidate?.bodyStreamFlag === 'boolean' ? candidate.bodyStreamFlag : null;
    if (mode === 'unknown' && !source && !interceptorType && !observedAt && !reliable && bodyStreamFlag === null) {
        return null;
    }
    return {
        mode,
        source,
        reliable,
        interceptorType,
        observedAt: observedAt > 0 ? observedAt : 0,
        bodyStreamFlag
    };
};

const tryParseBodyInterceptorPayload = (body = null) => {
    if (!body) return null;
    if (typeof body === 'object') return body;
    if (typeof body !== 'string') return null;
    const trimmed = String(body || '').trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
    try { return JSON.parse(trimmed); } catch (_) { return null; }
};

const collectBodyInterceptorTextSamples = (value = null, output = [], depth = 0) => {
    if (output.length >= 32 || depth > 5 || value == null) return output;
    if (typeof value === 'string') {
        const text = String(value || '').trim();
        if (text) output.push(text.slice(0, 4000));
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 16)) collectBodyInterceptorTextSamples(item, output, depth + 1);
        return output;
    }
    if (typeof value !== 'object') return output;
    const preferredKeys = [
        'content', 'text', 'prompt', 'input', 'instruction', 'instructions',
        'system', 'query', 'source', 'sourceText', 'sample_text',
        'translator_notes', 'target_language', 'source_language'
    ];
    for (const key of preferredKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            collectBodyInterceptorTextSamples(value[key], output, depth + 1);
        }
    }
    return output;
};

const bodyInterceptorMessageStats = (parsedBody = null) => {
    const messages = Array.isArray(parsedBody?.messages) ? parsedBody.messages : [];
    const roles = messages.map(message => String(message?.role || '').trim().toLowerCase());
    return {
        messageCount: messages.length,
        userCount: roles.filter(role => role === 'user').length,
        systemCount: roles.filter(role => role === 'system').length,
        assistantCount: roles.filter(role => role === 'assistant').length
    };
};

const classifyAuxiliaryTransportPayload = (parsedBody = null, interceptorType = '') => {
    if (!parsedBody || typeof parsedBody !== 'object') return null;
    const normalizedType = String(interceptorType || '').trim().toLowerCase();
    const samples = [];
    collectBodyInterceptorTextSamples(parsedBody?.messages, samples);
    collectBodyInterceptorTextSamples(parsedBody?.prompt, samples);
    collectBodyInterceptorTextSamples(parsedBody?.input, samples);
    collectBodyInterceptorTextSamples(parsedBody?.system, samples);
    const bodyText = samples.join('\n').slice(0, 16000);
    const stats = bodyInterceptorMessageStats(parsedBody);
    const formatText = String(
        parsedBody?.format
        || parsedBody?.response_format?.type
        || parsedBody?.responseFormat?.type
        || ''
    ).trim().toLowerCase();
    const jsonMode = formatText === 'json' || formatText.includes('json');
    const singleUserJson = jsonMode && stats.messageCount === 1 && stats.userCount === 1 && stats.systemCount === 0 && stats.assistantCount === 0;
    const hasCurrentInput = /<\s*Current\s+Input\s*>/i.test(bodyText);
    const hasGigaTransMarker = /<GT-(?:CTRL|SEP)\b|<\s*\/?\s*GigaTrans\b|GigaTrans|기가트랜스|\bgt__\w+::\d+\b/i.test(bodyText)
        || /gigatrans|giga[-_ ]?trans|gt[-_ ]?(?:ctrl|sep)/i.test(normalizedType);
    const hasStructuredTranslationMarker = /(?:translate\s+(?:the\s+following|to\b)|translation\s+request|source\s+language|target\s+language|output\s+only\s+the\s+translated\s+text|<\s*sample_text\b|<\s*\/\s*sample_text\s*>|translator_notes|번역\s*(?:요청|전용|문|결과)|다음\s*(?:문장|텍스트|내용)을\s*번역|원문\s*:|번역문\s*:)/i.test(bodyText);
    const hasStrongTranslationInstruction = /(?:translate\s+(?:the\s+following|to\b)|translation\s+request|source\s+language|target\s+language|output\s+only\s+the\s+translated\s+text|<\s*sample_text\b|<\s*\/\s*sample_text\s*>|translator_notes|번역\s*(?:요청|전용)|다음\s*(?:문장|텍스트|내용)을\s*번역)/i.test(bodyText);
    if (hasGigaTransMarker) {
        return { auxiliary: true, reason: 'gigatrans_transport_payload', kind: 'translation' };
    }
    if (hasStructuredTranslationMarker && (singleUserJson || (hasStrongTranslationInstruction && !hasCurrentInput))) {
        return { auxiliary: true, reason: 'translation_transport_payload', kind: 'translation' };
    }
    return null;
};

const classifyMainResponseTransportFromInterceptor = (interceptorType = '', body = null) => {
    const normalizedType = String(interceptorType || '').trim().toLowerCase();
    const parsedBody = tryParseBodyInterceptorPayload(body);
    const bodyStreamFlag =
        typeof parsedBody?.stream === 'boolean'
            ? parsedBody.stream
            : (typeof parsedBody?.streaming === 'boolean' ? parsedBody.streaming : null);
    const auxiliaryTransport = classifyAuxiliaryTransportPayload(parsedBody, normalizedType);
    if (bodyStreamFlag === true) {
        return {
            mode: 'stream',
            source: 'body-stream-flag',
            reliable: true,
            interceptorType: normalizedType,
            bodyStreamFlag: true,
            auxiliary: auxiliaryTransport?.auxiliary === true,
            auxiliaryReason: auxiliaryTransport?.reason || '',
            auxiliaryKind: auxiliaryTransport?.kind || ''
        };
    }
    if (bodyStreamFlag === false) {
        return {
            mode: 'nonstream',
            source: 'body-stream-flag',
            reliable: true,
            interceptorType: normalizedType,
            bodyStreamFlag: false,
            auxiliary: auxiliaryTransport?.auxiliary === true,
            auxiliaryReason: auxiliaryTransport?.reason || '',
            auxiliaryKind: auxiliaryTransport?.kind || ''
        };
    }
    if (normalizedType.includes('stream')) {
        return {
            mode: 'stream',
            source: 'interceptor-type',
            reliable: true,
            interceptorType: normalizedType,
            bodyStreamFlag: null,
            auxiliary: auxiliaryTransport?.auxiliary === true,
            auxiliaryReason: auxiliaryTransport?.reason || '',
            auxiliaryKind: auxiliaryTransport?.kind || ''
        };
    }
    if (
        normalizedType.endsWith('_basic')
        || normalizedType.endsWith('_http')
        || normalizedType === 'gemini_base'
        || normalizedType === 'mistral'
        || normalizedType === 'openai_response_api'
        || normalizedType === 'anthropic_bedrock'
        || normalizedType === 'anthropic_batching'
    ) {
        return {
            mode: 'nonstream',
            source: 'interceptor-type',
            reliable: true,
            interceptorType: normalizedType,
            bodyStreamFlag: null,
            auxiliary: auxiliaryTransport?.auxiliary === true,
            auxiliaryReason: auxiliaryTransport?.reason || '',
            auxiliaryKind: auxiliaryTransport?.kind || ''
        };
    }
    return {
        mode: 'unknown',
        source: '',
        reliable: false,
        interceptorType: normalizedType,
        bodyStreamFlag,
        auxiliary: auxiliaryTransport?.auxiliary === true,
        auxiliaryReason: auxiliaryTransport?.reason || '',
        auxiliaryKind: auxiliaryTransport?.kind || ''
    };
};

const isManagedAfterRequestOriginType = (requestType = '') => {
    const typeKey = normalizeAfterRequestTypeKey(requestType);
    return typeKey === 'model'
        || typeKey === 'chat'
        || typeKey === 'main'
        || typeKey === 'submodel'
        || typeKey === 'sub-model'
        || typeKey === 'stream'
        || typeKey === 'streaming';
};

const isResponseStreamingCompatEnabled = (config = MemoryEngine?.CONFIG || {}) => {
    try {
        return config?.responseStreamingCompatEnabled !== false;
    } catch (_) {
        return false;
    }
};

const pruneRecentMainResponseTransportHint = (chatId = '') => {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId) return null;
    const current = MemoryState.recentMainResponseTransportByChatId.get(normalizedChatId);
    if (!current) return null;
    const observedAt = Number(current?.observedAt || 0);
    if (!observedAt || (Date.now() - observedAt) > MAIN_RESPONSE_TRANSPORT_HINT_TTL_MS) {
        MemoryState.recentMainResponseTransportByChatId.delete(normalizedChatId);
        return null;
    }
    return { ...current };
};

const rememberRecentMainResponseTransportHint = (chat, payload = {}) => {
    const chatId = String(chat?.id || '').trim();
    const normalized = normalizeMainResponseTransportPayload(payload);
    if (!chatId || !normalized || normalized.mode === 'unknown') return null;
    const snapshot = {
        mode: normalized.mode,
        source: String(normalized.source || '').trim(),
        reliable: normalized.reliable === true,
        interceptorType: String(normalized.interceptorType || '').trim().toLowerCase(),
        observedAt: Number(normalized.observedAt || Date.now() || 0),
        bodyStreamFlag: typeof normalized.bodyStreamFlag === 'boolean' ? normalized.bodyStreamFlag : null
    };
    MemoryState.recentMainResponseTransportByChatId.set(chatId, snapshot);
    return { ...snapshot };
};

const getRecentMainResponseTransportHint = (chat) =>
    pruneRecentMainResponseTransportHint(String(chat?.id || '').trim());

const pruneAfterRequestOriginQueue = (requestType = '') => {
    const typeKey = normalizeAfterRequestTypeKey(requestType);
    const now = Date.now();
    const queue = (MemoryState.afterRequestOriginsByType.get(typeKey) || [])
        .filter(entry => entry && Number(entry.expiresAt || 0) > now);
    if (queue.length > MAX_AFTER_REQUEST_ORIGINS_PER_TYPE) {
        queue.splice(0, queue.length - MAX_AFTER_REQUEST_ORIGINS_PER_TYPE);
    }
    if (queue.length > 0) MemoryState.afterRequestOriginsByType.set(typeKey, queue);
    else MemoryState.afterRequestOriginsByType.delete(typeKey);
    return queue;
};

const registerAfterRequestOrigin = (chat, requestType = '', payload = {}) => {
    if (!isResponseStreamingCompatEnabled(MemoryEngine.CONFIG)) return null;
    if (!Utils.isModelRequestType(requestType)) return null;
    const chatId = String(chat?.id || '').trim();
    if (!chatId) return null;

    const typeKey = normalizeAfterRequestTypeKey(requestType);
    const queue = pruneAfterRequestOriginQueue(typeKey).slice();
    const now = Date.now();
    const requestSequence = Math.max(1, Number(MemoryState.afterRequestOriginSequence || 0) + 1);
    MemoryState.afterRequestOriginSequence = requestSequence;
    const latestAssistant = buildLatestAssistantSnapshot(chat, { includeStableId: true });
    const canonicalUser = payload?.canonicalUser && typeof payload.canonicalUser === 'object'
        ? payload.canonicalUser
        : {};
    const registered = {
        chatId,
        characterId: String(payload?.characterId || payload?.charId || '').trim(),
        characterIndex: normalizeRisuIndex(payload?.characterIndex ?? payload?.charIndex),
        chatIndex: normalizeRisuIndex(payload?.chatIndex),
        scopeKey: String(payload?.scopeKey || getChatMemoryScopeKey(chat)).trim(),
        runtimeScopeKey: String(payload?.runtimeScopeKey || '').trim(),
        canonicalScope: String(payload?.canonicalScope || '').trim(),
        resetGeneration: payload?.resetGeneration ?? 0,
        requestType: typeKey,
        messageCount: latestAssistant.currentMessageCount,
        latestAiId: latestAssistant.latestLiveId || latestAssistant.latestStableId || null,
        latestAiIndex: latestAssistant.latestMessages.lastIndexOf(latestAssistant.latestAiMsg),
        latestAiHash: latestAssistant.latestHash || null,
        latestAiSignature: latestAssistant.latestMessageSignature || null,
        canonicalUser: {
            strict: String(canonicalUser.strict || payload?.userMsgForNarrative || '').trim(),
            raw: String(canonicalUser.raw || payload?.userMsgForMemory || payload?.userMsgForNarrative || '').trim()
        },
        autoContinue: payload?.autoContinue === true,
        responseTransportMode: normalizeMainResponseTransportMode(payload?.responseTransportMode || payload?.mainResponseTransportMode || ''),
        responseTransportSource: String(payload?.responseTransportSource || payload?.mainResponseTransportSource || '').trim(),
        responseTransportReliable: payload?.responseTransportReliable === true || payload?.mainResponseTransportReliable === true,
        responseTransportInterceptor: String(payload?.responseTransportInterceptor || payload?.mainResponseTransportInterceptor || '').trim().toLowerCase(),
        responseTransportObservedAt: Number(payload?.responseTransportObservedAt || payload?.mainResponseTransportObservedAt || 0),
        interopBypassReason: String(payload?.interopBypassReason || '').trim(),
        interopBypassKind: String(payload?.interopBypassKind || '').trim(),
        interopBypassSource: String(payload?.interopBypassSource || '').trim(),
        requestSequence,
        requestId: String(payload?.requestId || `req_${now}_${requestSequence}_${Math.random().toString(36).slice(2, 12)}`).trim(),
        queuedAt: now,
        expiresAt: now + AFTER_REQUEST_ORIGIN_TTL_MS
    };
    registered.sourceCapture = ProspectiveSourceReceipt.capture(chat, registered);
    queue.push(registered);
    while (queue.length > MAX_AFTER_REQUEST_ORIGINS_PER_TYPE) queue.shift();
    MemoryState.afterRequestOriginsByType.set(typeKey, queue);

    try {
        const strict = String(registered.canonicalUser.strict || '').trim();
        const raw = String(registered.canonicalUser.raw || strict || '').trim();
        if (strict || raw) {
            MemoryState.recentNarrativeOriginByScope.set(registered.scopeKey || getChatMemoryScopeKey(chat), {
                ...registered,
                canonicalUser: { strict, raw },
                storedAt: now,
                source: 'beforeRequest-origin'
            });
        }
    } catch (error) {
        recordSuppressedRuntimeError('after_request_origin.cache_recent_narrative_origin', error, {
            chatId: registered.chatId,
            requestSequence: registered.requestSequence,
            requestType: registered.requestType
        });
    }
    return registered;
};

const unregisterAfterRequestOrigin = (origin = null, reason = 'rollback') => {
    if (!origin || typeof origin !== 'object') return false;
    const chatId = String(origin?.chatId || '').trim();
    const requestSequence = Math.max(0, Number(origin?.requestSequence || 0));
    const preferredTypeKey = String(origin?.requestType || '').trim() ? normalizeAfterRequestTypeKey(origin.requestType) : '';
    if (!chatId && !requestSequence) return false;
    let removed = false;
    const candidates = preferredTypeKey
        ? [[preferredTypeKey, MemoryState.afterRequestOriginsByType.get(preferredTypeKey) || []]]
        : Array.from(MemoryState.afterRequestOriginsByType.entries());
    for (const [typeKey, queue] of candidates) {
        if (!Array.isArray(queue) || queue.length === 0) continue;
        const nextQueue = queue.filter(entry => {
            const sameChat = !chatId || String(entry?.chatId || '').trim() === chatId;
            const sameSequence = !requestSequence || Number(entry?.requestSequence || 0) === requestSequence;
            const match = sameChat && sameSequence;
            if (match) removed = true;
            return !match;
        });
        if (nextQueue.length > 0) MemoryState.afterRequestOriginsByType.set(typeKey, nextQueue);
        else MemoryState.afterRequestOriginsByType.delete(typeKey);
    }
    try {
        const recent = MemoryState.recentNarrativeOriginByScope.get(String(origin?.scopeKey || '').trim());
        if (recent && (!requestSequence || Number(recent?.requestSequence || 0) === requestSequence) && (!chatId || String(recent?.chatId || '').trim() === chatId)) {
            MemoryState.recentNarrativeOriginByScope.delete(String(origin.scopeKey || '').trim());
        }
    } catch (error) {
        recordSuppressedRuntimeError('after_request_origin.unregister_recent_narrative_origin', error, {
            chatId,
            requestSequence,
            requestType: preferredTypeKey
        });
    }
    try { clearAfterRequestMissingRecoveryTimer(chatId); } catch (error) {
        recordSuppressedRuntimeError('after_request_origin.clear_missing_recovery_timer', error, {
            chatId,
            requestSequence,
            requestType: preferredTypeKey
        });
    }
    if (removed && MemoryEngine?.CONFIG?.debug) {
        recordRuntimeDebug('warn', '[LIBRA] afterRequest origin rolled back', {
            __libraDebugMeta: true,
            chatId,
            requestSequence,
            requestType: preferredTypeKey,
            reason: String(reason || '').trim()
        });
    }
    return removed;
};

const annotateLatestAfterRequestOriginTransport = (chat, payload = {}) => {
    const chatId = String(chat?.id || '').trim();
    const normalized = normalizeMainResponseTransportPayload(payload);
    if (!chatId || !normalized || normalized.mode === 'unknown') return null;
    const transportHint = rememberRecentMainResponseTransportHint(chat, normalized) || normalized;
    let updated = null;
    for (const [typeKey, queue] of MemoryState.afterRequestOriginsByType.entries()) {
        if (!Array.isArray(queue) || queue.length === 0) continue;
        for (let i = queue.length - 1; i >= 0; i--) {
            const entry = queue[i];
            if (String(entry?.chatId || '').trim() !== chatId) continue;
            if (!isManagedAfterRequestOriginType(typeKey || entry?.requestType)) continue;
            const nextEntry = {
                ...entry,
                responseTransportMode: transportHint.mode,
                responseTransportSource: transportHint.source || '',
                responseTransportReliable: transportHint.reliable === true,
                responseTransportInterceptor: transportHint.interceptorType || '',
                responseTransportObservedAt: Number(transportHint.observedAt || Date.now() || 0),
                responseTransportBodyStreamFlag: typeof transportHint.bodyStreamFlag === 'boolean' ? transportHint.bodyStreamFlag : null
            };
            const nextQueue = queue.slice();
            nextQueue[i] = nextEntry;
            MemoryState.afterRequestOriginsByType.set(typeKey, nextQueue);
            updated = nextEntry;
            break;
        }
        if (updated) break;
    }
    return updated;
};

const inferMainResponseTransportFromChatState = (chat, requestOrigin = null, responseText = '') => {
    if (!chat || !requestOrigin || requestOrigin?.autoContinue === true) return null;
    const originMessageCount = Math.max(0, Number(requestOrigin?.messageCount || 0));
    const currentMessages = getChatMessages(chat);
    const currentMessageCount = Array.isArray(currentMessages) ? currentMessages.length : 0;
    const latest = buildLatestAssistantSnapshot(chat, { includeStableId: true });
    const incomingComparable = String(
        Utils.getNarrativeComparableText(responseText, 'ai')
        || Utils.getMemorySourceText(responseText)
        || ''
    ).trim();
    const incomingHash = incomingComparable ? String(TokenizerEngine.simpleHash(incomingComparable) || '').trim() : '';
    if (currentMessageCount > originMessageCount && latest.latestHash && incomingHash && latest.latestHash === incomingHash) {
        return {
            mode: 'stream',
            source: 'chat-attachment',
            reliable: true,
            interceptorType: '',
            observedAt: Date.now(),
            bodyStreamFlag: null
        };
    }
    if (currentMessageCount <= originMessageCount) {
        return {
            mode: 'nonstream',
            source: 'preinsert-inference',
            reliable: false,
            interceptorType: '',
            observedAt: Date.now(),
            bodyStreamFlag: null
        };
    }
    return null;
};

const resolveMainResponseTransportState = ({ chat = null, requestOrigin = null, responseText = '' } = {}) => {
    const fromOrigin = normalizeMainResponseTransportPayload(requestOrigin);
    if (fromOrigin && fromOrigin.mode !== 'unknown') {
        return rememberRecentMainResponseTransportHint(chat, fromOrigin) || fromOrigin;
    }
    const recent = getRecentMainResponseTransportHint(chat);
    if (recent && recent.mode !== 'unknown') return recent;
    const inferred = inferMainResponseTransportFromChatState(chat, requestOrigin, responseText);
    if (inferred && inferred.mode !== 'unknown') {
        return rememberRecentMainResponseTransportHint(chat, inferred) || inferred;
    }
    return {
        mode: 'unknown',
        source: '',
        reliable: false,
        interceptorType: '',
        observedAt: 0,
        bodyStreamFlag: null
    };
};

const selectAfterRequestOriginForChat = (chat, requestType = '', consume = true, predicate = null) => {
    const chatId = String(chat?.id || '').trim();
    if (!chatId) return null;
    const requestedType = String(requestType || '').trim();
    const typeKeys = requestedType
        ? [normalizeAfterRequestTypeKey(requestedType)]
        : Array.from(MemoryState.afterRequestOriginsByType.keys());
    let chosen = null;
    for (const typeKey of typeKeys) {
        const queue = pruneAfterRequestOriginQueue(typeKey).slice();
        for (let i = queue.length - 1; i >= 0; i--) {
            const entry = queue[i];
            if (String(entry?.chatId || '').trim() !== chatId) continue;
            if (typeof predicate === 'function' && !predicate(entry, typeKey)) continue;
            if (!chosen || Number(entry?.queuedAt || 0) > Number(chosen.entry?.queuedAt || 0)) {
                chosen = { typeKey, index: i, queue, entry };
            }
            break;
        }
    }
    if (!chosen) return null;
    if (consume) {
        const nextQueue = chosen.queue.slice();
        nextQueue.splice(chosen.index, 1);
        if (nextQueue.length > 0) MemoryState.afterRequestOriginsByType.set(chosen.typeKey, nextQueue);
        else MemoryState.afterRequestOriginsByType.delete(chosen.typeKey);
        clearAfterRequestMissingRecoveryTimer(chatId);
    }
    return {
        ...(chosen.entry || {}),
        matchStrategy: `chat-origin:${chosen.typeKey}`
    };
};

const consumeAfterRequestOriginForChat = (chat, requestType = '') => {
    const exact = selectAfterRequestOriginForChat(chat, requestType, true);
    if (exact || !Utils.isModelRequestType(requestType)) return exact;
    return selectAfterRequestOriginForChat(
        chat,
        '',
        true,
        (entry, typeKey) => Utils.isModelRequestType(typeKey || entry?.requestType)
    );
};

const claimAfterRequestOriginForType = (requestType = '') => {
    if (!Utils.isModelRequestType(requestType)) return null;
    const preferredKey = normalizeAfterRequestTypeKey(requestType);
    const keys = [
        preferredKey,
        ...Array.from(MemoryState.afterRequestOriginsByType.keys())
            .filter(key => key !== preferredKey && Utils.isModelRequestType(key))
    ];
    let chosen = null;
    for (const typeKey of keys) {
        const queue = pruneAfterRequestOriginQueue(typeKey).slice();
        if (!queue.length) continue;
        // A provider fallback invokes beforeRequest again for the same host
        // request. The last origin is the successful attempt; FIFO would bind
        // the response to the failed attempt and poison the next turn.
        const entry = queue[queue.length - 1];
        if (!chosen || Number(entry?.queuedAt || 0) > Number(chosen.entry?.queuedAt || 0)) {
            chosen = { typeKey, queue, entry };
        }
    }
    if (!chosen) return null;
    const chosenUserHash = stableHash(String(chosen.entry?.canonicalUser?.raw || chosen.entry?.canonicalUser?.strict || '').trim());
    const nextQueue = chosen.queue.filter(entry => {
        if (Number(entry?.requestSequence || 0) === Number(chosen.entry?.requestSequence || 0)) return false;
        const sameRetryFamily = String(entry?.chatId || '') === String(chosen.entry?.chatId || '')
            && Number(entry?.messageCount || 0) === Number(chosen.entry?.messageCount || 0)
            && stableHash(String(entry?.canonicalUser?.raw || entry?.canonicalUser?.strict || '').trim()) === chosenUserHash;
        return !sameRetryFamily;
    });
    if (nextQueue.length) MemoryState.afterRequestOriginsByType.set(chosen.typeKey, nextQueue);
    else MemoryState.afterRequestOriginsByType.delete(chosen.typeKey);
    clearAfterRequestMissingRecoveryTimer(String(chosen.entry?.chatId || '').trim());
    return { ...(chosen.entry || {}), matchStrategy: `type-fifo:${chosen.typeKey}` };
};

const previewLatestNarrativeAfterRequestOriginForChat = (chat) =>
    selectAfterRequestOriginForChat(
        chat,
        '',
        false,
        (entry, typeKey) => Utils.isModelRequestType(typeKey || entry?.requestType)
    );

const previewManagedAfterRequestOriginForChat = (chat) =>
    selectAfterRequestOriginForChat(
        chat,
        '',
        false,
        (entry, typeKey) => isManagedAfterRequestOriginType(typeKey || entry?.requestType)
    );

const previewManagedAfterRequestOriginForChatBySequence = (chat, requestSequence = 0) => {
    const sequence = Math.max(0, Number(requestSequence || 0));
    if (!sequence) return previewManagedAfterRequestOriginForChat(chat);
    return selectAfterRequestOriginForChat(
        chat,
        '',
        false,
        (entry, typeKey) =>
            isManagedAfterRequestOriginType(typeKey || entry?.requestType)
            && Number(entry?.requestSequence || 0) === sequence
    );
};

const getRecentNarrativeOriginSnapshotForChat = (chat = null, options = {}) => {
    try {
        const scopeKey = getChatMemoryScopeKey(chat);
        const snap = MemoryState.recentNarrativeOriginByScope.get(scopeKey);
        if (!snap) return null;
        const maxAgeMs = Math.max(10000, Number(options?.maxAgeMs || AFTER_REQUEST_ORIGIN_TTL_MS));
        const queuedAt = Math.max(0, Number(snap?.queuedAt || snap?.storedAt || 0));
        if (queuedAt > 0 && Date.now() - queuedAt > maxAgeMs) {
            MemoryState.recentNarrativeOriginByScope.delete(scopeKey);
            return null;
        }
        const chatId = String(chat?.id || '').trim();
        if (chatId && String(snap?.chatId || '').trim() && String(snap.chatId).trim() !== chatId) return null;
        const strict = String(snap?.canonicalUser?.strict || '').trim();
        const raw = String(snap?.canonicalUser?.raw || strict || '').trim();
        if (!strict && !raw) return null;
        return { ...(snap || {}), canonicalUser: { strict, raw } };
    } catch (_) {
        return null;
    }
};

const normalizeMainResponseOutputCapturePayload = (payload = {}) => {
    const rawResponseText = String(payload?.rawResponseText ?? payload?.content ?? payload?.text ?? payload?.displayContent ?? payload?.memorySourceText ?? '');
    const displayContent = String(Utils.sanitizeForLibra(payload?.displayContent || payload?.content || payload?.text || '') || '').trim();
    const memorySourceText = String(Utils.getMemorySourceText(payload?.memorySourceText || displayContent || '') || '').trim();
    const comparable = String(
        Utils.getNarrativeComparableText(memorySourceText || displayContent, 'ai')
        || Utils.getMemorySourceText(memorySourceText || displayContent)
        || ''
    ).trim();
    if (!displayContent && !memorySourceText && !comparable) return null;
    if (Utils.isTagOnlyToolResponse(comparable || memorySourceText || displayContent)) return null;
    const comparableHash = String((comparable ? TokenizerEngine.simpleHash(comparable) : '') || '').trim();
    return {
        rawResponseText,
        displayContent,
        memorySourceText,
        comparable,
        comparableHash,
        messageCount: Number(payload?.messageCount || 0),
        latestMessageId: String(payload?.latestMessageId || '').trim(),
        latestMessageSignature: String(payload?.latestMessageSignature || '').trim(),
        observedAt: Number(payload?.observedAt || Date.now()),
        transportMode: normalizeMainResponseTransportMode(payload?.transportMode || 'stream'),
        source: String(payload?.source || 'output-handler').trim(),
        requestSequence: Math.max(0, Number(payload?.requestSequence || 0)),
        requestQueuedAt: Math.max(0, Number(payload?.requestQueuedAt || 0)),
        requestType: normalizeAfterRequestTypeKey(payload?.requestType || 'model'),
        originSnapshot: payload?.originSnapshot && typeof payload.originSnapshot === 'object' ? safeClone(payload.originSnapshot) : null
    };
};

const rememberRecentMainResponseOutputCapture = (chat, payload = {}) => {
    const chatId = String(chat?.id || '').trim();
    if (!chatId) return null;
    const normalized = normalizeMainResponseOutputCapturePayload(payload);
    if (!normalized) return null;
    MemoryState.recentMainResponseOutputCaptureByChatId.set(chatId, {
        ...normalized,
        chatId,
        expiresAt: Date.now() + MAIN_RESPONSE_OUTPUT_CAPTURE_TTL_MS
    });
    return MemoryState.recentMainResponseOutputCaptureByChatId.get(chatId);
};

const getRecentMainResponseOutputCapture = (chat) => {
    const chatId = String(chat?.id || '').trim();
    if (!chatId) return null;
    const capture = MemoryState.recentMainResponseOutputCaptureByChatId.get(chatId) || null;
    if (!capture) return null;
    if (Number(capture.expiresAt || 0) <= Date.now()) {
        MemoryState.recentMainResponseOutputCaptureByChatId.delete(chatId);
        return null;
    }
    return capture;
};

const forgetRecentMainResponseOutputCapture = (chat, options = {}) => {
    const chatId = String(chat?.id || '').trim();
    if (!chatId) return false;
    const requestSequence = Math.max(0, Number(options?.requestSequence || 0));
    const current = MemoryState.recentMainResponseOutputCaptureByChatId.get(chatId);
    if (requestSequence > 0 && current && Number(current.requestSequence || 0) !== requestSequence) return false;
    MemoryState.recentMainResponseOutputCaptureByChatId.delete(chatId);
    return true;
};

const buildAssistantResponseCaptureFromSnapshot = (chat, origin = null) => {
    const latest = buildLatestAssistantSnapshot(chat, { includeStableId: true });
    const comparable = String(latest.latestComparable || '').trim();
    if (!comparable) return null;
    return normalizeMainResponseOutputCapturePayload({
        rawResponseText: String(Utils.getMessageText(latest.latestAiMsg) ?? ''),
        displayContent: comparable,
        memorySourceText: comparable,
        comparable,
        messageCount: latest.currentMessageCount,
        latestMessageId: latest.latestStableId || latest.latestLiveId || '',
        latestMessageSignature: latest.latestMessageSignature || '',
        source: 'latest-assistant-snapshot',
        requestSequence: Math.max(0, Number(origin?.requestSequence || 0)),
        requestQueuedAt: Math.max(0, Number(origin?.queuedAt || 0)),
        requestType: origin?.requestType || 'model',
        originSnapshot: origin || null
    });
};

const resolveMainResponseMemoryCapturePayload = ({
    chat = null,
    requestOrigin = null,
    responseTransport = null,
    responsePayload = '',
    displayContent = ''
} = {}) => {
    const transportMode = normalizeMainResponseTransportMode(responseTransport?.mode || '');
    const fallbackDisplay = String(Utils.sanitizeForLibra(displayContent || responsePayload || '') || '').trim();
    const fallbackMemorySourceText = String(Utils.getMemorySourceText(responsePayload || displayContent || '') || '').trim();
    const finalAfterRequestComparable = String(
        Utils.getNarrativeComparableText(fallbackMemorySourceText || fallbackDisplay, 'ai')
        || Utils.getMemorySourceText(fallbackMemorySourceText || fallbackDisplay)
        || ''
    ).trim();
    const finalAfterRequestUsable = !!(
        finalAfterRequestComparable
        && !Utils.isTagOnlyToolResponse(finalAfterRequestComparable)
    );
    const requestSequence = Math.max(0, Number(requestOrigin?.requestSequence || 0));
    const requestQueuedAt = Math.max(0, Number(requestOrigin?.queuedAt || 0));
    const streamCapture = transportMode === 'stream'
        ? getRecentMainResponseOutputCapture(chat)
        : null;
    const streamCaptureMatchesRequest = !!(
        streamCapture
        && (
            (requestSequence > 0 && Number(streamCapture?.requestSequence || 0) === requestSequence)
            || (
                requestSequence <= 0
                && requestQueuedAt > 0
                && Number(streamCapture?.observedAt || 0) >= Math.max(0, requestQueuedAt - 250)
            )
            || (
                requestSequence <= 0
                && requestQueuedAt <= 0
            )
        )
    );
    if (transportMode === 'stream' && finalAfterRequestUsable) {
        return {
            strategy: 'stream-afterRequest-final',
            source: 'afterRequest-stream-final',
            responsePayload: String(fallbackMemorySourceText || fallbackDisplay || '').trim(),
            displayContent: fallbackDisplay,
            memorySourceText: String(fallbackMemorySourceText || fallbackDisplay || '').trim(),
            streamCapture,
            requestMatched: streamCaptureMatchesRequest
        };
    }
    if (
        streamCapture
        && streamCaptureMatchesRequest
        && String(streamCapture?.comparable || streamCapture?.memorySourceText || streamCapture?.displayContent || '').trim()
    ) {
        return {
            strategy: 'stream-output-fallback',
            source: String(streamCapture.source || 'output-handler').trim().toLowerCase() || 'output-handler',
            responsePayload: String(streamCapture.memorySourceText || streamCapture.displayContent || fallbackMemorySourceText || '').trim(),
            displayContent: String(streamCapture.displayContent || fallbackDisplay || '').trim(),
            memorySourceText: String(streamCapture.memorySourceText || streamCapture.displayContent || fallbackMemorySourceText || '').trim(),
            streamCapture,
            requestMatched: true
        };
    }
    return {
        strategy: transportMode === 'nonstream' ? 'afterRequest-nonstream' : 'afterRequest',
        source: 'afterRequest',
        responsePayload: String(fallbackMemorySourceText || fallbackDisplay || '').trim(),
        displayContent: fallbackDisplay,
        memorySourceText: String(fallbackMemorySourceText || fallbackDisplay || '').trim(),
        streamCapture: null,
        requestMatched: false
    };
};

const clearStreamOutputRecoveryTimer = (chatOrId = null) => {
    const chatId = String(typeof chatOrId === 'string' ? chatOrId : (chatOrId?.id || '')).trim();
    if (!chatId) return false;
    const current = MemoryState.streamOutputRecoveryTimersByChatId.get(chatId);
    if (!current) return false;
    try { clearTimeout(current?.timer); } catch (error) {
        recordSuppressedRuntimeError('stream_output_recovery.clear_timer', error, { chatId });
    }
    MemoryState.streamOutputRecoveryTimersByChatId.delete(chatId);
    return true;
};

const clearAfterRequestMissingRecoveryTimer = (chatOrId = null, { preserveOwner = false } = {}) => {
    const chatId = String(typeof chatOrId === 'string' ? chatOrId : (chatOrId?.id || '')).trim();
    if (!chatId) return false;
    const current = MemoryState.afterRequestMissingRecoveryTimersByChatId.get(chatId);
    if (!current) return false;
    if (!preserveOwner && current.owner) current.owner.cancelled = true;
    try { clearTimeout(current?.timer); } catch (error) {
        recordSuppressedRuntimeError('after_request_missing_recovery.clear_timer', error, { chatId });
    }
    MemoryState.afterRequestMissingRecoveryTimersByChatId.delete(chatId);
    return true;
};

const getResponseCaptureStableText = (capture = null) => String(
    capture?.memorySourceText
    || capture?.displayContent
    || capture?.comparable
    || ''
).trim();

const getOutputCaptureIdleSettleState = (payload = {}) => {
    const activeChat = payload?.activeChat || null;
    const capture = payload?.capture || null;
    const requestSequence = Math.max(0, Number(payload?.requestSequence || 0));
    const requestQueuedAt = Math.max(0, Number(payload?.requestQueuedAt || 0));
    const requestAgeMs = Math.max(0, Number(payload?.requestAgeMs || 0));
    const captureIdleMs = Math.max(0, Number(payload?.captureIdleMs || 0));
    const hasNewAssistant = payload?.hasNewAssistant !== false;
    const captureSequence = Math.max(0, Number(capture?.requestSequence || 0));
    const captureObservedAt = Math.max(0, Number(capture?.observedAt || 0));
    const sequenceMatches = !requestSequence || !captureSequence || captureSequence === requestSequence;
    const captureAfterAnchor = !requestQueuedAt || (captureObservedAt > 0 && captureObservedAt >= Math.max(0, requestQueuedAt - 250));
    const hasCaptureText = !!getResponseCaptureStableText(capture);
    const idleSettled = activeChat?.isStreaming === true
        && hasNewAssistant
        && !!capture
        && hasCaptureText
        && sequenceMatches
        && captureAfterAnchor
        && captureIdleMs >= RESPONSE_STREAMING_IDLE_SETTLE_MS
        && requestAgeMs >= RESPONSE_STREAMING_IDLE_MIN_REQUEST_AGE_MS;
    return {
        idleSettled,
        settleReason: idleSettled ? 'output_capture_idle' : '',
        sequenceMatches,
        captureAfterAnchor,
        hasCaptureText,
        captureIdleMs,
        requestAgeMs
    };
};

const getAssistantSnapshotIdleSettleState = (latest = {}, options = {}) => {
    const now = Date.now();
    const text = String(latest?.latestComparable || '').trim();
    const hash = String(latest?.latestHash || '').trim();
    const key = hash
        ? [
            hash,
            String(text.length || 0),
            String(Math.max(0, Number(latest?.currentMessageCount || 0)))
        ].join(':')
        : '';
    const previousKey = String(options?.assistantSnapshotKey || '').trim();
    const previousStableSince = Math.max(0, Number(options?.assistantSnapshotStableSince || 0));
    const stableSince = key && previousKey === key && previousStableSince > 0
        ? previousStableSince
        : now;
    const idleMs = key ? Math.max(0, now - stableSince) : 0;
    return {
        key,
        stableSince,
        idleMs,
        hasText: !!text,
        hash,
        chars: text.length
    };
};

const freezeResponseCaptureAnalysisDeadline = (requestOrigin = null, capture = null) => {
    const now = Date.now();
    const budgetMs = normalizeAfterRequestAnalysisBudgetMs(MemoryEngine.CONFIG?.afterRequestAnalysisBudgetMs ?? 480000, 480000);
    const requestId = String(requestOrigin?.requestId || '').trim();
    const matchesOrigin = owner => !!requestId && !!owner
        && ['requestId', 'scopeKey', 'runtimeScopeKey', 'canonicalScope', 'chatId'].every(key =>
            String(owner[key] || '').trim() === String(requestOrigin?.[key] || '').trim())
        && Number(owner.resetGeneration ?? 0) === Number(requestOrigin?.resetGeneration ?? 0)
        && Number(owner.requestSequence || 0) === Number(requestOrigin?.requestSequence || 0);
    // Use only already-retained owners. A completed stream may outlive the
    // request queue's TTL, and a failed raw write must not restart its budget
    // when a later callback reconstructs the origin from another snapshot.
    const owners = [requestOrigin];
    if (requestId) {
        const queue = MemoryState.afterRequestOriginsByType.get(normalizeAfterRequestTypeKey(requestOrigin?.requestType));
        owners.push(
            Array.isArray(queue) ? queue.find(matchesOrigin) : null,
            MemoryState.recentNarrativeOriginByScope.get(String(requestOrigin?.scopeKey || '').trim()),
            capture?.originSnapshot,
            MemoryState.recentMainResponseOutputCaptureByChatId.get(String(requestOrigin?.chatId || '').trim())?.originSnapshot
        );
    }
    let observedAt = now;
    let analysisDeadlineAt = now + budgetMs;
    for (const owner of owners) {
        if (!owner || (owner !== requestOrigin && !matchesOrigin(owner))) continue;
        const observed = Number(owner.observedAt || 0);
        const deadline = Number(owner.analysisDeadlineAt || 0);
        if (Number.isFinite(observed) && observed > 0) observedAt = Math.min(observedAt, observed);
        if (Number.isFinite(deadline) && deadline > 0) analysisDeadlineAt = Math.min(analysisDeadlineAt, deadline);
    }
    analysisDeadlineAt = Math.min(analysisDeadlineAt, observedAt + budgetMs);
    for (const owner of owners) {
        if (!owner || (owner !== requestOrigin && !matchesOrigin(owner))) continue;
        owner.observedAt = observedAt;
        owner.analysisDeadlineAt = analysisDeadlineAt;
    }
    // The capture's own observedAt is a chunk/idle clock, not this budget clock.
    return { observedAt, analysisDeadlineAt };
};

const registerPendingFromResponseCapture = async (char, chat, requestOrigin = null, responseCapture = null, reason = 'stream-output-fallback', options = {}) => {
    const ownerIsCurrent = () => {
        if (options?.isCurrent === undefined) return true;
        if (typeof options.isCurrent !== 'function') return false;
        try { return options.isCurrent() === true; } catch (_) { return false; }
    };
    if (!ownerIsCurrent()) return { status: 'deferred', reason: 'capture_owner_cancelled', origin: requestOrigin };
    if (!isResponseStreamingCompatEnabled(MemoryEngine.CONFIG)) return { status: 'disabled' };
    if (!char || !chat) return { status: 'invalid-context' };
    const responseLease = RuntimeStateLease.capture();
    const responseScope = String(requestOrigin?.runtimeScopeKey || requestOrigin?.scopeKey || getChatRuntimeScopeKey(chat, char)).trim();
    // Idle output is a recovery buffer, never proof of completion.
    if (chat.isStreaming === true) return { status: 'response-still-streaming' };
    if (PendingTurnManager.getPending?.(chat)) return { status: 'already-pending' };
    const capture = responseCapture || getRecentMainResponseOutputCapture(chat) || buildAssistantResponseCaptureFromSnapshot(chat, requestOrigin);
    if (!capture) return { status: 'no-capture' };

    const msgsAll = getChatMessages(chat);
    const latestAssistant = buildLatestAssistantSnapshot(chat, { includeStableId: true });
    const responseText = String(capture.memorySourceText || capture.displayContent || capture.comparable || latestAssistant.latestComparable || '').trim();
    if (isManagedModuleHelperOutput(responseText)) return { status: 'helper-response', origin: requestOrigin };
    const aiResponseRaw = String(Utils.getMemorySourceText(responseText) || '').trim();
    const aiResponse = String(Utils.getNarrativeComparableText(aiResponseRaw, 'ai') || aiResponseRaw || '').trim();
    if (!aiResponse) return { status: 'no-ai-response', origin: requestOrigin };
    if (Utils.isTagOnlyToolResponse(aiResponse)) return { status: 'tool-response', origin: requestOrigin };
    const analysisStamp = freezeResponseCaptureAnalysisDeadline(requestOrigin, capture);
    let durableLedgerHandle = null;
    try {
        durableLedgerHandle = await DurableTurnLedger.appendObserved({
            origin: requestOrigin,
            recordId: String(requestOrigin?.requestId || '').trim() || undefined,
            scopeKey: requestOrigin?.scopeKey || getStableChatScopeKey(chat, char),
            characterId: requestOrigin?.characterId || char?.id || char?.chaId || '',
            characterIndex: requestOrigin?.characterIndex,
            chatId: requestOrigin?.chatId || chat?.id || '',
            chatIndex: requestOrigin?.chatIndex,
            requestSequence: requestOrigin?.requestSequence || 0,
            requestType: requestOrigin?.requestType || capture?.requestType || 'model',
            observedAt: analysisStamp.observedAt,
            analysisDeadlineAt: analysisStamp.analysisDeadlineAt,
            userText: requestOrigin?.canonicalUser?.raw || requestOrigin?.canonicalUser?.strict || '',
            assistantText: capture.rawResponseText ?? responseText,
            captureSource: capture.source || 'stream-output-fallback',
            mainResponseLanguageTarget: detectMainResponseLanguageTarget(aiResponseRaw)
        });
    } catch (ledgerError) {
        recordSuppressedRuntimeError('stream_capture.durable_ledger_append', ledgerError, { chatId: String(chat?.id || '') });
    }
    if (!durableLedgerHandle?.ok || durableLedgerHandle?.verified !== true) return { status: 'durable-unverified', reason: durableLedgerHandle?.reason || 'raw_receipt_unverified', origin: requestOrigin };
    // Raw persistence may await storage while the GUI activates another persona
    // or reset/unload invalidates this runtime. Keep the frozen raw receipt, but
    // never publish its pending turn into the replacement runtime.
    if (!RuntimeStateLease.isCurrent(responseLease) || responseScope !== responseLease.scopeKey) {
        return { status: 'deferred', reason: 'runtime_lease_invalidated', origin: requestOrigin };
    }

    // A normal afterRequest claim may cancel recovery without changing the
    // runtime lease while the immutable raw receipt is being acknowledged.
    // Preserve that receipt, but never let the stale callback publish pending work.
    if (!ownerIsCurrent()) return { status: 'deferred', reason: 'capture_owner_cancelled', origin: requestOrigin };
    if (PendingTurnManager.getPending?.(chat)) return { status: 'already-pending' };

    const originCanonical = sanitizeCanonicalUserPayload(
        requestOrigin?.canonicalUser && typeof requestOrigin.canonicalUser === 'object'
            ? requestOrigin.canonicalUser
            : {}
    );
    const latestIsAttachedAssistant = !!latestAssistant.latestAiMsg && Array.isArray(msgsAll) && msgsAll[msgsAll.length - 1] === latestAssistant.latestAiMsg;
    const priorMsgs = latestIsAttachedAssistant ? msgsAll.slice(0, Math.max(0, msgsAll.length - 1)) : msgsAll;
    const fallbackCanonical = resolveCanonicalUserPayload(priorMsgs);
    const originSaysAutoContinue = requestOrigin?.autoContinue === true;
    let userMsgForNarrative = originSaysAutoContinue ? '' : String(originCanonical.strict || fallbackCanonical.strict || '').trim();
    let userMsgForMemory = originSaysAutoContinue ? '' : String(originCanonical.raw || originCanonical.strict || fallbackCanonical.raw || fallbackCanonical.strict || '').trim();
    if (!userMsgForNarrative && userMsgForMemory) userMsgForNarrative = getStrictNarrativeUserText(userMsgForMemory);
    const isAutoContinueTurn = !userMsgForNarrative && !userMsgForMemory && originSaysAutoContinue && !!aiResponse;
    const isRaceCondition = !userMsgForNarrative && !userMsgForMemory && !isAutoContinueTurn;
    const narrativeChannelPreview = classifyNarrativeTurnChannel(userMsgForMemory || userMsgForNarrative, aiResponse);
    const allowNarrativeProcessing = !!aiResponse && (isAutoContinueTurn || narrativeChannelPreview.channel === 'meta' || !narrativeChannelPreview.bypassSuggested);
    const allowMemoryCapture = !isRaceCondition && !!aiResponse && (isAutoContinueTurn || !!userMsgForMemory || !!userMsgForNarrative);
    if (!allowNarrativeProcessing && !allowMemoryCapture) return { status: 'bypassed-turn', origin: requestOrigin };

    const sourceHash = String(
        capture.comparableHash
        || (aiResponse ? TokenizerEngine.simpleHash(aiResponse) : '')
        || ''
    ).trim();
    if (!sourceHash) return { status: 'no-source-hash', origin: requestOrigin };
    const predictedTurn = Math.max(
        deriveRuntimeTurnFromLorebook(MemoryEngine.getLorebook(char, chat)),
        MemoryEngine.getCurrentTurn()
    ) + 1;
    const messageId = capture.latestMessageId
        || latestAssistant.latestStableId
        || latestAssistant.latestLiveId
        || buildAfterRequestSyntheticMessageId(chat, predictedTurn, sourceHash);
    const messageSignature = capture.latestMessageSignature
        || latestAssistant.latestMessageSignature
        || buildAfterRequestSyntheticMessageSignature(predictedTurn, aiResponse, sourceHash);
    const liveMessageIds = normalizeCanonicalMessageIds([messageId, latestAssistant.latestStableId, latestAssistant.latestLiveId]);
    const normalizedReason = String(reason || 'stream-output-fallback').trim() || 'stream-output-fallback';
    const pending = PendingTurnManager.registerPending(chat, {
        userMsgForNarrative,
        userMsgForMemory,
        aiResponse,
        aiResponseRaw,
        autoContinueTurn: isAutoContinueTurn,
        allowNarrativeProcessing,
        allowMemoryCapture,
        narrativeChannelPreview,
        aiHash: sourceHash,
        sourceHash,
        initialMessageId: messageId,
        liveMessageIds,
        messageSignature,
        messageCount: Number(capture.messageCount || latestAssistant.currentMessageCount || 0),
        originMessageCount: Math.max(0, Number(requestOrigin?.messageCount || 0)),
        sourceCapture: requestOrigin?.sourceCapture ? safeClone(requestOrigin.sourceCapture) : null,
        originLatestAssistant: {
            index: requestOrigin?.latestAiIndex,
            id: requestOrigin?.latestAiId || '',
            hash: requestOrigin?.latestAiHash || '',
            signature: requestOrigin?.latestAiSignature || ''
        },
        predictedTurn,
        turnAnchor: predictedTurn,
        turnAnchorTurn: predictedTurn,
        userTurnKey: buildLogicalUserTurnKey(userMsgForNarrative, userMsgForMemory, isAutoContinueTurn),
        requestType: requestOrigin?.requestType || capture.requestType || 'model',
        requestSequence: Math.max(0, Number(requestOrigin?.requestSequence || capture.requestSequence || 0)),
        hostPromptEvidence: requestOrigin?.hostPromptEvidence || null,
        runtimeMode: 'response-streaming-fallback',
        runtimeReliability: isRaceCondition ? 'guarded' : 'normal',
        memoryCaptureMode: normalizedReason,
        responseTransportMode: normalizeMainResponseTransportMode(capture?.transportMode || requestOrigin?.responseTransportMode || ''),
        responseTransportSource: String(requestOrigin?.responseTransportSource || capture.source || normalizedReason).trim(),
        responseTransportReliable: requestOrigin?.responseTransportReliable === true,
        responseTransportInterceptor: String(requestOrigin?.responseTransportInterceptor || '').trim().toLowerCase(),
        responseTransportObservedAt: Number(requestOrigin?.responseTransportObservedAt || capture?.observedAt || 0),
        targetContext: {
            canonicalScope: String(requestOrigin?.canonicalScope || LibraDataStorage.scopeKeyFor(char, chat)).trim(),
            resetGeneration: requestOrigin?.resetGeneration ?? PersonaScopeIdentity.snapshotProof(char, chat)?.resetGeneration ?? 0,
            characterId: String(requestOrigin?.characterId || char?.id || char?.chaId || '').trim(),
            characterIndex: normalizeRisuIndex(requestOrigin?.characterIndex),
            chatId: String(requestOrigin?.chatId || chat?.id || '').trim(),
            chatIndex: normalizeRisuIndex(requestOrigin?.chatIndex),
            scopeKey: String(requestOrigin?.scopeKey || getStableChatScopeKey(chat, char)).trim(),
            runtimeScopeKey: responseScope,
            requestSequence: Math.max(0, Number(requestOrigin?.requestSequence || 0)),
            durableLedgerRecordId: String(durableLedgerHandle?.recordId || '').trim(),
            durableLedgerRecordKey: String(durableLedgerHandle?.recordKey || '').trim(),
            analysisDeadlineAt: Math.max(0, Number(durableLedgerHandle?.record?.analysisDeadlineAt || 0) || 0),
            mainResponseLanguageTarget: detectMainResponseLanguageTarget(aiResponseRaw)
        }
    });
    if (!pending) return { status: 'skipped', origin: requestOrigin };
    if (MemoryEngine.CONFIG?.debug) {
        recordRuntimeDebug('log', '[LIBRA] Pending turn synthesized from response streaming compatibility capture', {
            __libraDebugMeta: true,
            chatId: chat?.id || null,
            reason: normalizedReason,
            source: capture.source || '',
            requestSequence: Math.max(0, Number(requestOrigin?.requestSequence || capture.requestSequence || 0)),
            aiHash: pending.aiHash || ''
        });
    }
    return { status: 'registered', origin: requestOrigin, pending };
};

const scheduleStreamOutputRecoveryCheck = (chat, payload = {}) => {
    if (!isResponseStreamingCompatEnabled(MemoryEngine.CONFIG)) return null;
    const chatId = String(chat?.id || '').trim();
    if (!chatId || typeof setTimeout !== 'function') return null;
    const requestSequence = Math.max(0, Number(payload?.requestSequence || 0));
    const requestQueuedAt = Math.max(0, Number(payload?.requestQueuedAt || 0));
    const attempts = Math.max(0, Number(payload?.attempts || 0));
    clearStreamOutputRecoveryTimer(chatId);
    const delayMs = attempts > 0 ? RESPONSE_STREAMING_RECOVERY_RETRY_MS : RESPONSE_STREAMING_RECOVERY_INITIAL_MS;
    const timer = setTimeout(async () => {
        clearStreamOutputRecoveryTimer(chatId);
        let recoveryDebugKey = '';
        try {
            if (!isResponseStreamingCompatEnabled(MemoryEngine.CONFIG)) return;
            const explicitTarget = payload?.targetContext && typeof payload.targetContext === 'object' ? payload.targetContext : null;
            const resolvedContext = explicitTarget?.chatId
                ? await resolveChatContextByTarget(explicitTarget, { allowActiveFallback: false })
                : await resolveActiveChatContext({ id: chatId });
            const activeChat = resolvedContext?.chat || (!explicitTarget ? chat : null) || null;
            const activeChar = resolvedContext?.char || null;
            if (!activeChat || !activeChar) return;
            if (explicitTarget) {
                const visibleContext = await resolveActiveChatContext();
                if (String(visibleContext?.chat?.id || '') !== String(explicitTarget.chatId || '')) {
                    if (Date.now() < Number(explicitTarget.expiresAt || (requestQueuedAt + AFTER_REQUEST_ORIGIN_TTL_MS))) {
                        scheduleStreamOutputRecoveryCheck(activeChat, { requestSequence, requestQueuedAt, attempts: attempts + 1, targetContext: explicitTarget });
                    }
                    return;
                }
            }
            recoveryDebugKey = DebugExportManager.startRequest('streamOutputRecovery', {
                requestType: 'stream',
                scopeKey: getChatRuntimeScopeKey(activeChat, activeChar),
                chatId: String(activeChat?.id || chatId || '').trim(),
                request: { requestSequence, requestQueuedAt, attempts }
            });
            if (PendingTurnManager.getPending?.(activeChat)) {
                DebugExportManager.finishRequest(recoveryDebugKey, 'skipped', { reason: 'pending_turn_already_exists' });
                return;
            }
            const currentCapture = getRecentMainResponseOutputCapture(activeChat);
            const captureIdleMs = currentCapture ? Math.max(0, Date.now() - Number(currentCapture.observedAt || 0)) : 0;
            const requestAnchorAt = Math.max(Number(currentCapture?.requestQueuedAt || 0), requestQueuedAt);
            const requestAgeMs = requestAnchorAt ? Math.max(0, Date.now() - requestAnchorAt) : captureIdleMs;
            const idleSettle = getOutputCaptureIdleSettleState({
                activeChat,
                capture: currentCapture,
                requestSequence,
                requestQueuedAt,
                requestAgeMs,
                captureIdleMs
            });
            const legacyStaleStreamingSettled = activeChat?.isStreaming === true
                && !!currentCapture
                && captureIdleMs >= RESPONSE_STREAMING_STALE_SETTLE_MS
                && requestAgeMs >= RESPONSE_STREAMING_FORCE_SETTLE_MS;
            const streamingSettledReason = idleSettle.idleSettled
                ? idleSettle.settleReason
                : (legacyStaleStreamingSettled ? 'stale_streaming_flag' : '');
            const staleStreamingSettled = idleSettle.idleSettled || legacyStaleStreamingSettled;
            if (activeChat?.isStreaming === true) {
                if (attempts + 1 < RESPONSE_STREAMING_RECOVERY_MAX_ATTEMPTS) {
                    scheduleStreamOutputRecoveryCheck(activeChat, { requestSequence, requestQueuedAt, attempts: attempts + 1, targetContext: explicitTarget });
                    DebugExportManager.finishRequest(recoveryDebugKey, 'waiting', {
                        reason: 'response_still_streaming',
                        attempts: attempts + 1,
                        captureIdleMs,
                        requestAgeMs,
                        outputCaptureSequenceMatches: idleSettle.sequenceMatches,
                        outputCaptureAfterAnchor: idleSettle.captureAfterAnchor,
                        hasOutputCaptureText: idleSettle.hasCaptureText
                    });
                } else if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] Response streaming compatibility recovery gave up: response still streaming', { chatId, requestSequence, attempts: attempts + 1 });
                    DebugExportManager.finishRequest(recoveryDebugKey, 'skipped', { reason: 'response_still_streaming_give_up', attempts: attempts + 1, captureIdleMs, requestAgeMs });
                }
                return;
            }
            if (streamingSettledReason && MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('warn', '[LIBRA] Response streaming compatibility treating streaming flag as settled', {
                    __libraDebugMeta: true,
                    chatId,
                    requestSequence,
                    captureIdleMs,
                    requestAgeMs,
                    settleReason: streamingSettledReason
                });
            }
            if (!currentCapture) {
                DebugExportManager.finishRequest(recoveryDebugKey, 'skipped', { reason: 'no_output_capture' });
                return;
            }
            DebugExportManager.recordPhase(recoveryDebugKey, 'output_capture', {
                captureIdleMs,
                requestAgeMs,
                staleStreamingSettled,
                settleReason: streamingSettledReason,
                requestSequence: currentCapture.requestSequence || 0,
                source: currentCapture.source || '',
                transportMode: currentCapture.transportMode || '',
                display: DebugExportManager.textDigest(currentCapture.displayContent || ''),
                memorySource: DebugExportManager.textDigest(currentCapture.memorySourceText || ''),
                comparable: DebugExportManager.textDigest(currentCapture.comparable || '')
            });
            if (requestSequence > 0 && Number(currentCapture.requestSequence || 0) !== requestSequence) {
                DebugExportManager.finishRequest(recoveryDebugKey, 'skipped', { reason: 'request_sequence_mismatch', expected: requestSequence, actual: currentCapture.requestSequence || 0 });
                return;
            }
            if (requestQueuedAt > 0 && Number(currentCapture.observedAt || 0) < Math.max(0, requestQueuedAt - 250)) {
                DebugExportManager.finishRequest(recoveryDebugKey, 'skipped', { reason: 'capture_before_request_anchor' });
                return;
            }

            let origin = previewManagedAfterRequestOriginForChatBySequence(activeChat, requestSequence)
                || previewLatestNarrativeAfterRequestOriginForChat(activeChat)
                || null;
            let shouldConsumeOrigin = !!origin;
            if (
                origin
                && requestSequence > 0
                && Number(origin?.requestSequence || 0) > 0
                && Number(origin.requestSequence || 0) !== requestSequence
            ) {
                origin = null;
                shouldConsumeOrigin = false;
            }
            if (!origin && currentCapture.originSnapshot && typeof currentCapture.originSnapshot === 'object') {
                origin = {
                    ...safeClone(currentCapture.originSnapshot),
                    matchStrategy: String(currentCapture.originSnapshot.matchStrategy || 'stream-output-captured-origin').trim()
                };
            }
            if (!origin) {
                const recentOrigin = getRecentNarrativeOriginSnapshotForChat(activeChat, {
                    maxAgeMs: Math.max(AFTER_REQUEST_ORIGIN_TTL_MS, MAIN_RESPONSE_OUTPUT_CAPTURE_TTL_MS, 120000)
                });
                if (recentOrigin) {
                    origin = {
                        ...recentOrigin,
                        matchStrategy: String(recentOrigin.matchStrategy || 'stream-output-recent-origin').trim()
                    };
                }
            }
            if (!origin) {
                const msgsAll = getChatMessages(activeChat);
                const canonicalUser = resolveCanonicalUserPayload(Array.isArray(msgsAll) ? msgsAll.slice(0, Math.max(0, msgsAll.length - 1)) : []);
                origin = {
                    chatId,
                    scopeKey: getChatMemoryScopeKey(activeChat),
                    requestType: normalizeAfterRequestTypeKey(currentCapture.requestType || 'model'),
                    messageCount: Number(currentCapture.messageCount || (Array.isArray(msgsAll) ? msgsAll.length : 0) || 0),
                    canonicalUser: {
                        strict: String(canonicalUser.strict || '').trim(),
                        raw: String(canonicalUser.raw || canonicalUser.strict || '').trim()
                    },
                    autoContinue: false,
                    requestSequence: Math.max(0, Number(currentCapture.requestSequence || requestSequence || 0)),
                    queuedAt: Math.max(0, Number(currentCapture.requestQueuedAt || requestQueuedAt || 0)) || Date.now(),
                    expiresAt: Date.now() + AFTER_REQUEST_ORIGIN_TTL_MS,
                    matchStrategy: 'stream-output-synthetic-origin'
                };
            }
            DebugExportManager.recordPhase(recoveryDebugKey, 'origin_resolve', {
                originFound: !!origin,
                matchStrategy: origin?.matchStrategy || '',
                originChatId: origin?.chatId || '',
                originRequestType: origin?.requestType || '',
                user: DebugExportManager.textDigest(origin?.canonicalUser?.raw || origin?.canonicalUser?.strict || '')
            }, origin ? 'done' : 'skipped');
            if (origin?.chatId && String(origin.chatId || '').trim() !== chatId) {
                DebugExportManager.finishRequest(recoveryDebugKey, 'skipped', { reason: 'origin_chat_mismatch', originChatId: origin.chatId, chatId });
                return;
            }
            const synthesized = await registerPendingFromResponseCapture(activeChar, activeChat, origin, currentCapture, 'stream-output-fallback');
            DebugExportManager.recordPhase(recoveryDebugKey, 'synthesize_pending', {
                status: synthesized?.status || 'none',
                reason: synthesized?.reason || ''
            }, synthesized?.status === 'registered' ? 'done' : 'skipped');
            if (!synthesized || synthesized.status !== 'registered') {
                if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] Response streaming compatibility could not synthesize pending turn', { chatId, requestSequence, status: synthesized?.status || 'none' });
                }
                DebugExportManager.finishRequest(recoveryDebugKey, 'skipped', { reason: 'synthesize_pending_failed', status: synthesized?.status || 'none' });
                return;
            }
            if (shouldConsumeOrigin) consumeAfterRequestOriginForChat(activeChat, origin?.requestType || currentCapture.requestType || 'model');
            const pending = PendingTurnManager.getPending?.(activeChat) || synthesized.pending;
            if (!pending) {
                DebugExportManager.finishRequest(recoveryDebugKey, 'skipped', { reason: 'pending_missing_after_synthesis' });
                return;
            }
            const commitResult = await PendingTurnManager.commitPendingNow(activeChar, activeChat, 'stream-output-fallback', { pending });
            DebugExportManager.recordPhase(recoveryDebugKey, 'commit_pending_now', {
                status: commitResult?.status || 'none',
                reason: commitResult?.reason || '',
                turn: commitResult?.turn || 0,
                memoryCreated: commitResult?.memoryCreated === true,
                turnKey: commitResult?.turnKey || ''
            }, (commitResult?.status === 'finalized' || commitResult?.status === 'already-committed') ? 'done' : 'waiting');
            if (commitResult?.status === 'finalized' || commitResult?.status === 'already-committed') {
                forgetRecentMainResponseOutputCapture(activeChat, { requestSequence });
                notifyLibraTask('LIBRA streaming commit을 복구했습니다.', { key: `libra-stream-commit-${commitResult?.turn || Date.now()}`, duration: 1500 });
                DebugExportManager.finishRequest(recoveryDebugKey, 'committed', { turn: commitResult?.turn || 0, turnKey: commitResult?.turnKey || '' });
            } else {
                DebugExportManager.finishRequest(recoveryDebugKey, 'waiting', { commitStatus: commitResult?.status || 'none', reason: commitResult?.reason || '' });
            }
            if (MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('log', '[LIBRA] Response streaming compatibility recovery completed', {
                    __libraDebugMeta: true,
                    chatId,
                    requestSequence,
                    synthStatus: synthesized?.status || 'none',
                    commitStatus: commitResult?.status || 'none'
                });
            }
        } catch (error) {
            DebugExportManager.finishRequest(recoveryDebugKey, 'failed', { error: error?.message || String(error || '') });
            if (MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('warn', '[LIBRA] Response streaming compatibility recovery failed:', error?.message || error);
            }
        }
    }, delayMs);
    MemoryState.streamOutputRecoveryTimersByChatId.set(chatId, {
        timer,
        requestSequence,
        requestQueuedAt,
        attempts,
        scheduledAt: Date.now()
    });
    return timer;
};

const scheduleAfterRequestMissingRecoveryCheck = (chat, requestOrigin = null, options = {}) => {
    if (!isResponseStreamingCompatEnabled(MemoryEngine.CONFIG)) return null;
    const chatId = String(chat?.id || requestOrigin?.chatId || '').trim();
    const requestSequence = Math.max(0, Number(requestOrigin?.requestSequence || 0));
    const requestQueuedAt = Math.max(0, Number(requestOrigin?.queuedAt || 0));
    if (!chatId || !requestSequence || typeof setTimeout !== 'function') return null;
    const previous = MemoryState.afterRequestMissingRecoveryTimersByChatId.get(chatId);
    // Queue TTL eviction is not cancellation of an active stream. Keep one
    // owner with its existing timer entry until consume/reset/unload or the
    // established retry limit, including while the callback awaits host I/O.
    const owner = previous?.requestSequence === requestSequence && previous?.owner
        ? previous.owner : { cancelled: false, generation: MemoryState.responseOriginGeneration };
    const isCurrentOrigin = () => isLibraRuntimeEpochActive()
        && owner.generation === MemoryState.responseOriginGeneration && !owner.cancelled;
    const attempts = Math.max(0, Number(options?.attempts || 0));
    clearAfterRequestMissingRecoveryTimer(chatId, { preserveOwner: previous?.owner === owner });
    const timer = setTimeout(async () => {
        let missingDebugKey = '';
        try {
            if (!isResponseStreamingCompatEnabled(MemoryEngine.CONFIG) || !isCurrentOrigin()) return;
            const explicitTarget = requestOrigin?.chatId ? requestOrigin : null;
            const resolvedContext = explicitTarget
                ? await resolveChatContextByTarget(explicitTarget, { allowActiveFallback: false })
                : await resolveActiveChatContext({ id: chatId });
            if (!isCurrentOrigin()) return;
            if (explicitTarget && ['target_not_active', 'persona_target_not_active'].includes(resolvedContext?.reason)) {
                if (Date.now() < Number(explicitTarget.expiresAt || (requestQueuedAt + AFTER_REQUEST_ORIGIN_TTL_MS))) {
                    scheduleAfterRequestMissingRecoveryCheck(chat, explicitTarget, { attempts: attempts + 1 });
                }
                return;
            }
            const activeChat = resolvedContext?.chat || (!explicitTarget ? chat : null) || null;
            const activeChar = resolvedContext?.char || null;
            if (!activeChat || !activeChar) return;
            if (explicitTarget) {
                const visibleContext = await resolveActiveChatContext();
                if (!isCurrentOrigin()) return;
                if (String(visibleContext?.scopeKey || '') !== String(explicitTarget.runtimeScopeKey || explicitTarget.scopeKey || '')) {
                    if (Date.now() < Number(explicitTarget.expiresAt || (requestQueuedAt + AFTER_REQUEST_ORIGIN_TTL_MS))) {
                        scheduleAfterRequestMissingRecoveryCheck(activeChat, explicitTarget, { attempts: attempts + 1 });
                    }
                    return;
                }
            }
            missingDebugKey = DebugExportManager.startRequest('afterRequestMissingRecovery', {
                requestType: requestOrigin?.requestType || 'model',
                scopeKey: getChatRuntimeScopeKey(activeChat, activeChar),
                chatId: String(activeChat?.id || chatId || '').trim(),
                request: { requestSequence, requestQueuedAt, attempts }
            });
            if (PendingTurnManager.getPending?.(activeChat)) {
                DebugExportManager.finishRequest(missingDebugKey, 'skipped', { reason: 'pending_turn_already_exists' });
                return;
            }
            let origin = previewManagedAfterRequestOriginForChatBySequence(activeChat, requestSequence)
                || previewLatestNarrativeAfterRequestOriginForChat(activeChat)
                || (requestOrigin && typeof requestOrigin === 'object' ? { ...safeClone(requestOrigin), matchStrategy: 'afterRequest-missing-original-origin' } : null);
            if (
                origin
                && requestSequence > 0
                && Number(origin?.requestSequence || 0) > 0
                && Number(origin.requestSequence || 0) !== requestSequence
            ) {
                origin = requestOrigin && typeof requestOrigin === 'object'
                    ? { ...safeClone(requestOrigin), matchStrategy: 'afterRequest-missing-original-origin' }
                    : null;
            }
            if (!origin) {
                DebugExportManager.finishRequest(missingDebugKey, 'skipped', { reason: 'missing_origin' });
                return;
            }
            const latest = buildLatestAssistantSnapshot(activeChat, { includeStableId: true });
            const assistantSnapshotIdle = getAssistantSnapshotIdleSettleState(latest, options);
            const originCount = Number(origin.messageCount || 0);
            const hasNewAssistant = !!latest.latestHash && (
                Number(latest.currentMessageCount || 0) > originCount
                || (!!origin.latestAiHash && latest.latestHash !== origin.latestAiHash)
                || !origin.latestAiHash
            );
            const outputCapture = getRecentMainResponseOutputCapture(activeChat);
            const outputCaptureSequenceMatches = !!outputCapture
                && (
                    !requestSequence
                    || !Number(outputCapture?.requestSequence || 0)
                    || Number(outputCapture?.requestSequence || 0) === requestSequence
                );
            const outputCaptureIdleMs = outputCapture
                ? Math.max(0, Date.now() - Number(outputCapture?.observedAt || 0))
                : 0;
            const originQueuedAt = Math.max(0, Number(origin?.queuedAt || 0), requestQueuedAt);
            const requestAgeMs = originQueuedAt ? Math.max(0, Date.now() - originQueuedAt) : 0;
            const recentTransport = getRecentMainResponseTransportHint(activeChat);
            const resolvedTransportMode = normalizeMainResponseTransportMode(
                recentTransport?.mode
                || origin?.responseTransportMode
                || requestOrigin?.responseTransportMode
                || ''
            );
            const nonStreamAfterRequestExpected = resolvedTransportMode === 'nonstream'
                && activeChat?.isStreaming !== true
                && !outputCapture;
            if (!hasNewAssistant && nonStreamAfterRequestExpected) {
                if (attempts + 1 < RESPONSE_STREAMING_RECOVERY_MAX_ATTEMPTS) {
                    scheduleAfterRequestMissingRecoveryCheck(activeChat, origin, {
                        attempts: attempts + 1,
                        assistantSnapshotKey: assistantSnapshotIdle.key,
                        assistantSnapshotStableSince: assistantSnapshotIdle.stableSince
                    });
                    DebugExportManager.finishRequest(missingDebugKey, 'waiting', {
                        reason: 'nonstream_wait_for_afterrequest',
                        attempts: attempts + 1,
                        messageCount: latest.currentMessageCount,
                        originMessageCount: origin.messageCount,
                        requestAgeMs,
                        transportMode: resolvedTransportMode,
                        transportSource: recentTransport?.source || origin?.responseTransportSource || requestOrigin?.responseTransportSource || '',
                        outputCaptureIdleMs,
                        hasOutputCaptureText: false
                    });
                } else {
                    if (MemoryEngine.CONFIG?.debug) {
                        recordRuntimeDebug('warn', '[LIBRA] afterRequest missing recovery gave up waiting for nonstream afterRequest', {
                            __libraDebugMeta: true,
                            chatId,
                            requestSequence,
                            attempts: attempts + 1,
                            messageCount: latest.currentMessageCount,
                            originMessageCount: origin.messageCount,
                            requestAgeMs
                        });
                    }
                    DebugExportManager.finishRequest(missingDebugKey, 'skipped', {
                        reason: 'nonstream_afterrequest_not_observed',
                        attempts: attempts + 1,
                        messageCount: latest.currentMessageCount,
                        originMessageCount: origin.messageCount,
                        requestAgeMs,
                        transportMode: resolvedTransportMode,
                        hasOutputCaptureText: false
                    });
                }
                return;
            }
            const idleSettle = getOutputCaptureIdleSettleState({
                activeChat,
                capture: outputCapture,
                hasNewAssistant,
                requestSequence,
                requestQueuedAt: originQueuedAt,
                requestAgeMs,
                captureIdleMs: outputCaptureIdleMs
            });
            const snapshotIdleSettled = activeChat?.isStreaming === true
                && hasNewAssistant
                && assistantSnapshotIdle.hasText
                && (!outputCapture || !outputCaptureSequenceMatches)
                && assistantSnapshotIdle.idleMs >= RESPONSE_STREAMING_IDLE_SETTLE_MS
                && requestAgeMs >= RESPONSE_STREAMING_IDLE_MIN_REQUEST_AGE_MS;
            const legacyStaleStreamingSettled = activeChat?.isStreaming === true
                && hasNewAssistant
                && requestAgeMs >= RESPONSE_STREAMING_FORCE_SETTLE_MS
                && (!outputCaptureSequenceMatches || !outputCapture || outputCaptureIdleMs >= RESPONSE_STREAMING_STALE_SETTLE_MS);
            const streamingSettledReason = idleSettle.idleSettled
                ? idleSettle.settleReason
                : (snapshotIdleSettled ? 'assistant_snapshot_idle' : '')
                    || (legacyStaleStreamingSettled ? 'stale_streaming_flag' : '');
            const staleStreamingSettled = idleSettle.idleSettled || snapshotIdleSettled || legacyStaleStreamingSettled;
            if (activeChat?.isStreaming === true || !hasNewAssistant) {
                if (attempts + 1 < RESPONSE_STREAMING_RECOVERY_MAX_ATTEMPTS) {
                    scheduleAfterRequestMissingRecoveryCheck(activeChat, origin, {
                        attempts: attempts + 1,
                        assistantSnapshotKey: assistantSnapshotIdle.key,
                        assistantSnapshotStableSince: assistantSnapshotIdle.stableSince
                    });
                    DebugExportManager.finishRequest(missingDebugKey, 'waiting', {
                        reason: activeChat?.isStreaming === true ? 'response_still_streaming' : 'no_new_assistant',
                        attempts: attempts + 1,
                        messageCount: latest.currentMessageCount,
                        originMessageCount: origin.messageCount,
                        outputCaptureIdleMs,
                        assistantSnapshotIdleMs: assistantSnapshotIdle.idleMs,
                        assistantSnapshotChars: assistantSnapshotIdle.chars,
                        requestAgeMs,
                        outputCaptureSequenceMatches,
                        outputCaptureAfterAnchor: idleSettle.captureAfterAnchor,
                        hasOutputCaptureText: idleSettle.hasCaptureText
                    });
                } else if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] afterRequest missing recovery gave up: response not settled', {
                        __libraDebugMeta: true,
                        chatId,
                        requestSequence,
                        attempts: attempts + 1,
                        messageCount: latest.currentMessageCount,
                        originMessageCount: origin.messageCount
                    });
                    DebugExportManager.finishRequest(missingDebugKey, 'skipped', {
                        reason: 'response_not_settled_give_up',
                        attempts: attempts + 1,
                        messageCount: latest.currentMessageCount,
                        originMessageCount: origin.messageCount
                    });
                }
                return;
            }
            if (staleStreamingSettled && MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('warn', '[LIBRA] afterRequest missing recovery treating streaming flag as settled', {
                    __libraDebugMeta: true,
                    chatId,
                    requestSequence,
                    settleReason: streamingSettledReason,
                    outputCaptureIdleMs,
                    assistantSnapshotIdleMs: assistantSnapshotIdle.idleMs,
                    requestAgeMs,
                    messageCount: latest.currentMessageCount,
                    originMessageCount: origin.messageCount
                });
            }
            const snapshotCapture = buildAssistantResponseCaptureFromSnapshot(activeChat, origin);
            const capture = outputCaptureSequenceMatches && outputCapture
                ? {
                    ...outputCapture,
                    messageCount: latest.currentMessageCount || outputCapture.messageCount || 0,
                    latestMessageId: latest.latestStableId || latest.latestLiveId || outputCapture.latestMessageId || '',
                    latestMessageSignature: latest.latestMessageSignature || outputCapture.latestMessageSignature || '',
                    transportMode: normalizeMainResponseTransportMode(getRecentMainResponseTransportHint(activeChat)?.mode || origin?.responseTransportMode || outputCapture.transportMode || ''),
                    source: 'afterRequest-missing-output-capture'
                }
                : snapshotCapture;
            DebugExportManager.recordPhase(missingDebugKey, 'capture_resolve', {
                hasNewAssistant,
                staleStreamingSettled,
                settleReason: streamingSettledReason,
                outputCaptureIdleMs,
                assistantSnapshotIdleMs: assistantSnapshotIdle.idleMs,
                requestAgeMs,
                outputCaptureSequenceMatches,
                outputCaptureAfterAnchor: idleSettle.captureAfterAnchor,
                captureSource: capture?.source || '',
                capture: DebugExportManager.textDigest(capture?.memorySourceText || capture?.comparable || capture?.displayContent || '')
            }, capture ? 'done' : 'skipped');
            if (!capture) {
                DebugExportManager.finishRequest(missingDebugKey, 'skipped', { reason: 'missing_capture' });
                return;
            }
            if (!isCurrentOrigin()) return;
            const synthesized = await registerPendingFromResponseCapture(activeChar, activeChat, origin, capture, 'afterRequest-missing-fallback', { isCurrent: isCurrentOrigin });
            if (!isCurrentOrigin()) return;
            DebugExportManager.recordPhase(missingDebugKey, 'synthesize_pending', {
                status: synthesized?.status || 'none',
                reason: synthesized?.reason || ''
            }, synthesized?.status === 'registered' ? 'done' : 'skipped');
            if (!synthesized || synthesized.status !== 'registered') {
                DebugExportManager.finishRequest(missingDebugKey, 'skipped', { reason: 'synthesize_pending_failed', status: synthesized?.status || 'none' });
                return;
            }
            consumeAfterRequestOriginForChat(activeChat, origin.requestType || 'model');
            const pending = PendingTurnManager.getPending?.(activeChat) || synthesized.pending;
            if (!pending) {
                DebugExportManager.finishRequest(missingDebugKey, 'skipped', { reason: 'pending_missing_after_synthesis' });
                return;
            }
            const commitResult = await PendingTurnManager.commitPendingNow(activeChar, activeChat, 'afterRequest-missing-fallback', { pending });
            DebugExportManager.recordPhase(missingDebugKey, 'commit_pending_now', {
                status: commitResult?.status || 'none',
                reason: commitResult?.reason || '',
                turn: commitResult?.turn || 0,
                memoryCreated: commitResult?.memoryCreated === true,
                turnKey: commitResult?.turnKey || ''
            }, (commitResult?.status === 'finalized' || commitResult?.status === 'already-committed') ? 'done' : 'waiting');
            if (commitResult?.status === 'finalized' || commitResult?.status === 'already-committed') {
                notifyLibraTask('LIBRA streaming commit을 복구했습니다.', { key: `libra-missing-afterrequest-${commitResult?.turn || Date.now()}`, duration: 1500 });
                DebugExportManager.finishRequest(missingDebugKey, 'committed', { turn: commitResult?.turn || 0, turnKey: commitResult?.turnKey || '' });
            } else {
                DebugExportManager.finishRequest(missingDebugKey, 'waiting', { commitStatus: commitResult?.status || 'none', reason: commitResult?.reason || '' });
            }
            if (MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('log', '[LIBRA] afterRequest missing recovery completed', {
                    __libraDebugMeta: true,
                    chatId,
                    requestSequence,
                    commitStatus: commitResult?.status || 'none'
                });
            }
        } catch (error) {
            DebugExportManager.finishRequest(missingDebugKey, 'failed', { error: error?.message || String(error || '') });
            if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA] afterRequest missing recovery failed:', error?.message || error);
        } finally {
            // A rescheduled timer owns the entry now; only retire this callback.
            if (MemoryState.afterRequestMissingRecoveryTimersByChatId.get(chatId)?.timer === timer) {
                clearAfterRequestMissingRecoveryTimer(chatId);
            }
        }
    }, attempts > 0 ? RESPONSE_STREAMING_RECOVERY_RETRY_MS : RESPONSE_STREAMING_RECOVERY_INITIAL_MS);
    MemoryState.afterRequestMissingRecoveryTimersByChatId.set(chatId, {
        timer,
        owner,
        requestSequence,
        requestQueuedAt,
        attempts,
        scheduledAt: Date.now()
    });
    return timer;
};
