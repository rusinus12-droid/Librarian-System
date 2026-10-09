// ══════════════════════════════════════════════════════════════
// [TRIGGER] RisuAI Event Handlers
// ══════════════════════════════════════════════════════════════
// 마지막 사용자 메시지 캐시 (beforeRequest → afterRequest 전달용)
let _lastUserMessage = '';
let _lastUserMessageRaw = '';
const BEFORE_REQUEST_PENDING_RETRY_SOFT_TIMEOUT_MS = 150;

const clearLibraTransientRuntimeState = () => {
    _lastUserMessage = '';
    _lastUserMessageRaw = '';
    try { MemoryState.pendingTurnCommits.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_pending_turn_commits', error);
    }
    try { MemoryState.afterRequestOriginsByType.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_after_request_origins', error);
    }
    try { MemoryState.recentNarrativeOriginByScope.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_recent_narrative_origins', error);
    }
    try { MemoryState.recentRecallInjectionByScope.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_recent_recall_injections', error);
    }
    try { MemoryState.recentMainResponseTransportByChatId.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_response_transport_hints', error);
    }
    try { MemoryState.recentMainResponseOutputCaptureByChatId.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_response_output_captures', error);
    }
    try {
        MemoryState.streamOutputRecoveryTimersByChatId.forEach(entry => { try { clearTimeout(entry?.timer); } catch (_) {} });
        MemoryState.streamOutputRecoveryTimersByChatId.clear();
    } catch (error) {
        recordSuppressedRuntimeError('transient.clear_stream_output_recovery_timers', error);
    }
    try {
        MemoryState.afterRequestMissingRecoveryTimersByChatId.forEach(entry => {
            if (entry?.owner) entry.owner.cancelled = true;
            try { clearTimeout(entry?.timer); } catch (_) {}
        });
        MemoryState.afterRequestMissingRecoveryTimersByChatId.clear();
    } catch (error) {
        recordSuppressedRuntimeError('transient.clear_after_request_missing_timers', error);
    }
    try {
        MemoryState.turnMaintenanceSchedulesByChatId.forEach(entry => { try { clearTimeout(entry?.timer); } catch (_) {} });
        MemoryState.turnMaintenanceSchedulesByChatId.clear();
    } catch (error) {
        recordSuppressedRuntimeError('transient.clear_turn_maintenance_schedules', error);
    }
    try { MemoryState.afterRequestForegroundTasksByScope.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_after_request_foreground_tasks', error);
    }
    try { MemoryState.turnMaintenanceLocksByChatId.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_turn_maintenance_locks', error);
    }
    try { MemoryState.transientMissing.clear(); } catch (error) {
        recordSuppressedRuntimeError('transient.clear_missing_markers', error);
    }
};

const isAutoContinueSilenceInput = (text) => {
    const normalized = String(Utils.getMemorySourceText(text) || '')
        .replace(/[*_[\](){}"'`~]+/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return false;
    return /^(?:say|says)\s+nothings?$/.test(normalized)
        || /^(?:say|says)\s+nothing$/.test(normalized)
        || /^(?:do|does)\s+not(?:hing)?\s*$/.test(normalized)
        || /^no\s+input$/.test(normalized)
        || /^empty\s+input$/.test(normalized)
        || /^silence$/.test(normalized)
        || /^silent$/.test(normalized)
        || /^\.{3,}$/.test(normalized);
};

const isAutoContinueCommandInput = (text) => {
    const normalized = String(Utils.getMemorySourceText(text) || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_[\](){}"'`~:;,.!?-]+/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return false;
    return /^(?:ooc\s*)?(?:continue|continue writing|continue the scene|go on|proceed|keep going|write more|next|next scene|auto continue|move the story forward|move story forward|advance the story|advance story|advance the scene|advance scene)$/.test(normalized)
        || /^(?:please\s+)?(?:continue|continue writing|go on|keep going)(?:\s+please)?$/.test(normalized)
        || /^(?:please\s+)?(?:move|advance)\s+(?:the\s+)?(?:story|scene|narrative)\s+forward(?:\s+please)?$/.test(normalized)
        || /^(?:계속|이어쓰기|이어줘|계속해|계속 써줘|다음|다음 장면|자동 이어쓰기)$/.test(normalized)
        || /(?:^|\s)(?:continue writing|continue the scene|auto continue|move the story forward|advance the story|advance the scene)(?:\s|$)/.test(normalized)
        || /(?:^|\s)(?:계속 써줘|내용을 계속|장면을 이어|이어가줘|이야기를 진행|장면을 진행)(?:\s|$)/.test(normalized);
};

const isPromptWrapperUserText = (text) => {
    const raw = String(Utils.getMemorySourceText(text) || '').trim();
    if (!raw) return false;
    return Utils.isMetaPromptLike(raw)
        || Utils.isForcedBypassPrompt(raw)
        || Utils.isTagOnlyToolResponse(raw);
};

const sanitizeCanonicalUserPayload = (payload = {}) => {
    const strict = String(payload?.strict || '').trim();
    const raw = String(payload?.raw || '').trim();
    if (!strict && raw && isPromptWrapperUserText(raw)) return { strict: '', raw: '' };
    if (strict && isPromptWrapperUserText(strict)) return { strict: '', raw: '' };
    const safeRaw = raw && isPromptWrapperUserText(raw) ? strict : raw;
    return { strict, raw: safeRaw || strict };
};

const buildCanonicalUserPayload = (msg) => {
    if (!msg || !isUserLikeMessage(msg)) {
        return { strict: '', raw: '' };
    }
    const sourceText = Utils.getMessageText(msg);
    if (isAutoContinueSilenceInput(sourceText) || isAutoContinueCommandInput(sourceText)) {
        return { strict: '', raw: '' };
    }
    const raw = Utils.getMemorySourceText(sourceText);
    const strict = getStrictNarrativeUserText(sourceText);
    return sanitizeCanonicalUserPayload({ strict, raw });
};

const buildAutoContinueRetrievalQuery = (latestAiText = '', options = {}) => {
    const latestAi = String(latestAiText || '').trim();
    if (!latestAi) return '';
    const recentLiveText = String(options?.recentLiveText || '').trim();
    const parts = [
        'Auto-continue the immediately previous scene.',
        'Prefer the latest assistant output over older similar memories.',
        'Do not restart, recap, or repeat the opening situation.',
        `Latest assistant response:\n${latestAi.slice(0, 900)}`
    ];
    if (recentLiveText && recentLiveText !== latestAi) {
        parts.push(`Recent live context:\n${recentLiveText.slice(-900)}`);
    }
    return parts.filter(Boolean).join('\n\n').trim();
};

const buildLatestAssistantSnapshotFromMessages = (messages = []) => {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (!msg || isUserLikeMessage(msg)) continue;
        const role = String(msg.role || msg.type || msg.author || msg.sender || '').trim().toLowerCase();
        if (role && !/^(?:assistant|model|ai|bot|char|character|response)$/.test(role)) continue;
        const rawText = String(Utils.getMessageText(msg) || msg.content || msg.text || msg.data || '').trim();
        if (!rawText || Utils.isToolResponseEnvelope(rawText)) continue;
        const latestComparable = String(
            Utils.getNarrativeComparableText(rawText, 'ai')
            || Utils.getMemorySourceText(rawText)
            || rawText
            || ''
        ).trim();
        if (!latestComparable) continue;
        const latestHash = String((TokenizerEngine?.simpleHash ? TokenizerEngine.simpleHash(latestComparable) : '') || '').trim();
        return {
            latestAiMsg: msg,
            latestComparable,
            latestHash,
            latestMessageSignature: `request:${i}:${latestHash}`,
            latestLiveId: String(msg.id || msg.m_id || msg.messageId || '').trim(),
            latestStableId: `request-assistant-${i}-${latestHash || 'nohash'}`,
            currentMessageCount: list.length,
            source: 'request_messages',
            index: i
        };
    }
    return {
        latestAiMsg: null,
        latestComparable: '',
        latestHash: '',
        latestMessageSignature: '',
        latestLiveId: '',
        latestStableId: '',
        currentMessageCount: list.length,
        source: '',
        index: -1
    };
};

const findLatestVisibleUserText = (messages = []) => {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (!msg || !isUserLikeMessage(msg)) continue;
        const sourceText = Utils.getMessageText(msg);
        if (Utils.isToolResponseEnvelope(sourceText)) continue;
        const payload = buildCanonicalUserPayload(msg);
        const text = String(payload.raw || payload.strict || '').trim();
        if (text) return text;
    }
    return '';
};

const findLatestUserMessage = (messages = []) => {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (!msg || !isUserLikeMessage(msg)) continue;
        if (Utils.isToolResponseEnvelope(Utils.getMessageText(msg))) continue;
        const payload = buildCanonicalUserPayload(msg);
        if (!payload.strict && !payload.raw) continue;
        return msg;
    }
    return null;
};

const normalizeCurrentInputCandidateText = (text = '') => {
    let raw = String(text || '').replace(/\r/g, '').trim();
    if (!raw) return '';
    raw = raw
        .replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/, '')
        .replace(/\n?\s*```\s*$/, '')
        .trim();
    if (isAutoContinueSilenceInput(raw) || isAutoContinueCommandInput(raw)) return '';
    return raw;
};

const makeCurrentUserResolution = ({ text = '', source = '', index = -1, replaceIndex = -1, message = null } = {}) => {
    const content = normalizeCurrentInputCandidateText(text);
    if (!content) return null;
    const canonicalUser = buildCanonicalUserPayload({ role: 'user', content });
    if (!canonicalUser.strict && !canonicalUser.raw) return null;
    return {
        content,
        canonicalUser,
        source: source || 'unknown',
        index: Number.isInteger(index) ? index : -1,
        replaceIndex: Number.isInteger(replaceIndex) ? replaceIndex : -1,
        message
    };
};

const extractCurrentInputFromMessageText = (text = '') => {
    const raw = String(text || '');
    if (!/<\s*Current\s+Input\s*>/i.test(raw)) return '';
    const fenced = raw.match(/<\s*Current\s+Input\s*>\s*```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```\s*<\s*\/\s*Current\s+Input\s*>/i);
    if (fenced?.[1]) return normalizeCurrentInputCandidateText(fenced[1]);
    const unfenced = raw.match(/<\s*Current\s+Input\s*>([\s\S]*?)<\s*\/\s*Current\s+Input\s*>/i);
    if (unfenced?.[1]) return normalizeCurrentInputCandidateText(unfenced[1]);
    return '';
};

const extractCurrentUserAnchorFromMessageText = (text = '') => {
    const raw = String(text || '').replace(/\r/g, '');
    const marker = raw.match(/\[\s*CURRENT\s+USER\s+TURN\s+ANCHOR\s*\]/i);
    if (!marker) return '';
    const after = raw.slice(marker.index + marker[0].length);
    const collected = [];
    for (const line of after.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (collected.length > 0) break;
            continue;
        }
        if (/^(?:Use this exact current turn|Previous assistant output|Adaptive prompt mode|Locator, internal id|\[|<|---|#)/i.test(trimmed)) break;
        collected.push(line);
    }
    return normalizeCurrentInputCandidateText(collected.join('\n'));
};

const findReplacementIndexForCurrentInputBlock = (messages = [], startIndex = -1, endIndex = -1, content = '') => {
    const target = normalizeCurrentInputCandidateText(content);
    if (!target || startIndex < 0 || endIndex < startIndex) return -1;
    const candidates = [];
    for (let i = startIndex; i <= endIndex; i++) {
        const raw = String(messages[i]?.content || '');
        let segment = raw;
        segment = segment.replace(/^[\s\S]*?<\s*Current\s+Input\s*>/i, '');
        segment = segment.replace(/<\s*\/\s*Current\s+Input\s*>[\s\S]*$/i, '');
        const normalized = normalizeCurrentInputCandidateText(segment);
        if (normalized && normalized === target) candidates.push(i);
    }
    return candidates.length === 1 ? candidates[0] : -1;
};

const resolveCurrentUserInputPayloadFromRequestMessages = (messages = [], chat = null) => {
    const list = Array.isArray(messages) ? messages : [];

    for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (!msg || !isUserLikeMessage(msg)) continue;
        const content = String(msg.content || '');
        const inlineCurrentInput = extractCurrentInputFromMessageText(content);
        if (inlineCurrentInput) {
            return makeCurrentUserResolution({
                text: inlineCurrentInput,
                source: 'request_current_input_inline',
                index: i,
                replaceIndex: -1,
                message: msg
            });
        }
    }

    for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (!msg || !isUserLikeMessage(msg)) continue;
        const content = String(msg.content || '');
        if (!/<\s*Current\s+Input\s*>/i.test(content)) continue;
        const segments = [];
        let endIndex = i;
        for (let j = i; j < list.length; j++) {
            const next = list[j];
            if (!next || !isUserLikeMessage(next)) break;
            let segment = String(next.content || '');
            if (j === i) segment = segment.replace(/^[\s\S]*?<\s*Current\s+Input\s*>/i, '');
            const closeIndex = segment.search(/<\s*\/\s*Current\s+Input\s*>/i);
            if (closeIndex >= 0) {
                segments.push(segment.slice(0, closeIndex));
                endIndex = j;
                break;
            }
            segments.push(segment);
            endIndex = j;
        }
        const joined = normalizeCurrentInputCandidateText(segments.join('\n'));
        if (joined) {
            const replaceIndex = findReplacementIndexForCurrentInputBlock(list, i, endIndex, joined);
            return makeCurrentUserResolution({
                text: joined,
                source: 'request_current_input_split',
                index: i,
                replaceIndex,
                message: list[replaceIndex >= 0 ? replaceIndex : i] || msg
            });
        }
    }

    for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (!msg || !isUserLikeMessage(msg)) continue;
        const anchorText = extractCurrentUserAnchorFromMessageText(msg.content || '');
        if (anchorText) {
            return makeCurrentUserResolution({
                text: anchorText,
                source: 'request_current_user_turn_anchor',
                index: i,
                replaceIndex: -1,
                message: msg
            });
        }
    }

    // In Risu's beforeRequest lifecycle the active chat may still contain the
    // previous user turn. Once explicit Current Input/anchor wrappers have been
    // checked, the latest valid user object in the final host request is the
    // authoritative current turn. Chat history is only a legacy fallback.
    for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (!msg || !isUserLikeMessage(msg)) continue;
        const payload = buildCanonicalUserPayload(msg);
        if (!payload.strict && !payload.raw) continue;
        return {
            content: payload.strict || payload.raw,
            canonicalUser: payload,
            source: 'request_latest_user_fallback',
            index: i,
            replaceIndex: i,
            message: msg
        };
    }

    const chatMessage = findLatestUserMessage(getChatMessages(chat));
    const chatPayload = buildCanonicalUserPayload(chatMessage);
    if (chatPayload.strict || chatPayload.raw) {
        return {
            content: chatPayload.strict || chatPayload.raw,
            canonicalUser: chatPayload,
            source: 'chat_fallback',
            index: -1,
            replaceIndex: -1,
            message: chatMessage
        };
    }

    return {
        content: '',
        canonicalUser: { strict: '', raw: '' },
        source: 'none',
        index: -1,
        replaceIndex: -1,
        message: null
    };
};
const REQUEST_MESSAGE_ARRAY_KEYS = ['messages', 'input', 'conversation', 'contents'];
const REQUEST_TEXT_KEYS = ['prompt', 'input', 'message', 'text', 'content'];
const REQUEST_NESTED_PAYLOAD_KEYS = ['body', 'request', 'payload', 'data', 'json', 'params'];

const extractRequestTextValue = (value, seen = new WeakSet()) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value
            .map(item => extractRequestTextValue(item, seen))
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    if (typeof value === 'object') {
        if (seen.has(value)) return '';
        seen.add(value);
        const preferredKeys = ['content', 'text', 'message', 'msg', 'mes', 'data', 'value', 'parts', 'input', 'prompt'];
        for (const key of preferredKeys) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const picked = extractRequestTextValue(value[key], seen);
            if (picked) return picked;
        }
    }
    return '';
};

const extractResponseTextValue = (value, seen = new WeakSet(), preserveWhitespace = false) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        const text = value
            .map(item => extractResponseTextValue(item, seen, preserveWhitespace))
            .filter(Boolean)
            .join('\n');
        return preserveWhitespace ? text : text.trim();
    }
    if (typeof value === 'object') {
        if (seen.has(value)) return '';
        seen.add(value);
        const preferredKeys = [
            'content', 'text', 'message', 'msg', 'mes', 'output_text', 'generated_text',
            'delta', 'data', 'value', 'parts', 'choices', 'candidates', 'response', 'result'
        ];
        for (const key of preferredKeys) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const picked = extractResponseTextValue(value[key], seen, preserveWhitespace);
            if (picked) return picked;
        }
    }
    return '';
};

const parseRequestPayloadJson = (value) => {
    const raw = String(value || '').trim();
    if (!raw || (!raw.startsWith('{') && !raw.startsWith('['))) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
};

const normalizeRequestMessages = (messages = []) => {
    const source = Array.isArray(messages)
        ? messages
        : (typeof messages === 'string' ? [{ role: 'user', content: messages }] : []);
    return source.map((msg) => {
        if (typeof msg === 'string' || typeof msg === 'number' || typeof msg === 'boolean') {
            return { role: 'user', content: String(msg || '') };
        }
        if (!msg || typeof msg !== 'object') return null;
        const rawRole = String(
            msg.role
            || msg.author
            || msg.sender
            || msg.type
            || (msg.is_user ? 'user' : '')
            || ''
        ).trim().toLowerCase();
        let role = rawRole;
        if (role === 'assistant' || role === 'model' || role === 'ai' || role === 'bot' || role === 'char' || role === 'character') role = 'assistant';
        else if (role === 'human' || role === 'input' || role === 'prompt') role = 'user';
        else if (msg.is_user && role !== 'system' && role !== 'developer') role = 'user';
        if (!role) return null;
        let content = msg.content;
        if (Array.isArray(content)) {
            content = content
                .map(part => {
                    if (typeof part === 'string') return part;
                    if (part && typeof part === 'object') return String(part.text || part.content || part.value || '').trim();
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        } else if (content && typeof content === 'object') {
            content = extractRequestTextValue(content);
        }
        if (content == null || content === '') {
            content = extractRequestTextValue(msg.text ?? msg.message ?? msg.prompt ?? msg.parts ?? msg.input ?? '');
        }
        return { ...msg, role, content: String(content || '') };
    }).filter(Boolean);
};
const extractRequestMessageContainer = (payload) => {
    if (Array.isArray(payload)) {
        return { kind: 'array', original: payload, messages: payload };
    }
    if (typeof payload === 'string') {
        const parsed = parseRequestPayloadJson(payload);
        if (parsed) {
            const parsedContainer = extractRequestMessageContainer(parsed);
            if (parsedContainer.kind !== 'unknown') {
                return { kind: 'json-string', original: payload, parsed, child: parsedContainer, messages: parsedContainer.messages };
            }
        }
        return { kind: 'string', original: payload, messages: [{ role: 'user', content: payload }] };
    }
    if (payload && typeof payload === 'object') {
        for (const key of REQUEST_MESSAGE_ARRAY_KEYS) {
            if (Array.isArray(payload[key])) return { kind: 'object', original: payload, messages: payload[key], key };
        }
        for (const key of REQUEST_TEXT_KEYS) {
            if (typeof payload[key] === 'string' && payload[key].trim()) {
                const parsed = parseRequestPayloadJson(payload[key]);
                if (parsed) {
                    const parsedContainer = extractRequestMessageContainer(parsed);
                    if (parsedContainer.kind !== 'unknown') {
                        return { kind: 'object-json-string', original: payload, messages: parsedContainer.messages, key, child: parsedContainer };
                    }
                }
                return { kind: 'object-text', original: payload, messages: [{ role: 'user', content: payload[key] }], key };
            }
        }
        for (const key of REQUEST_NESTED_PAYLOAD_KEYS) {
            const nested = payload[key];
            if (!nested) continue;
            const nestedContainer = extractRequestMessageContainer(nested);
            if (nestedContainer.kind !== 'unknown') {
                return { kind: 'nested', original: payload, messages: nestedContainer.messages, key, child: nestedContainer };
            }
        }
    }
    return { kind: 'unknown', original: payload, messages: [] };
};

const mergeRequestMessagesToPromptText = (messages = []) => {
    const normalized = normalizeRequestMessages(messages);
    const systemText = normalized
        .filter(msg => msg?.role === 'system' || msg?.role === 'developer')
        .map(msg => String(msg.content || '').trim())
        .filter(Boolean)
        .join('\n\n');
    const bodyText = normalized
        .filter(msg => msg?.role !== 'system' && msg?.role !== 'developer')
        .map(msg => String(msg.content || '').trim())
        .filter(Boolean)
        .join('\n\n');
    return [systemText, bodyText].filter(Boolean).join('\n\n');
};

const rebuildGeminiContentsPayload = (original = {}, nextMessages = [], key = 'contents') => {
    const originalSystemText = extractRequestTextValue(original?.systemInstruction || '');
    const systemText = [
        originalSystemText,
        ...(Array.isArray(nextMessages) ? nextMessages : [])
            .filter(msg => (msg?.role === 'system' || msg?.role === 'developer') && !Array.isArray(msg?.parts))
            .map(msg => extractRequestTextValue(msg?.content || msg?.text || '').trim())
            .filter(Boolean)
    ].filter(Boolean).join('\n\n');
    const contents = (Array.isArray(nextMessages) ? nextMessages : [])
        .filter(msg => msg && msg.role !== 'system' && msg.role !== 'developer')
        .map(msg => {
            // Preserve every host Gemini message (inlineData, functionCall,
            // functionResponse, thought, cache metadata, and role) verbatim.
            if (Array.isArray(msg?.parts)) return msg;
            const content = extractRequestTextValue(msg?.content ?? msg?.text ?? '').trim();
            const role = /^(?:assistant|bot|model)$/i.test(String(msg.role || '')) ? 'model' : 'user';
            const next = { ...msg, role, parts: [{ text: content }] };
            delete next.content;
            delete next.text;
            return next;
        })
        .filter(msg => Array.isArray(msg.parts) && msg.parts.length > 0);
    const rebuilt = { ...(original || {}), [key]: contents };
    if (systemText) rebuilt.systemInstruction = { parts: [{ text: systemText }] };
    return rebuilt;
};

const rebuildRequestPayload = (container, nextMessages) => {
    if (!container || container.kind === 'unknown') return nextMessages;
    if (container.kind === 'array') return nextMessages;
    if (container.kind === 'string') return mergeRequestMessagesToPromptText(nextMessages);
    if (container.kind === 'json-string') {
        return JSON.stringify(rebuildRequestPayload(container.child, nextMessages));
    }
    if (container.kind === 'nested') {
        return {
            ...(container.original || {}),
            [container.key]: rebuildRequestPayload(container.child, nextMessages)
        };
    }
    if (container.kind === 'object-text') {
        return {
            ...(container.original || {}),
            [container.key]: mergeRequestMessagesToPromptText(nextMessages)
        };
    }
    if (container.kind === 'object-json-string') {
        return {
            ...(container.original || {}),
            [container.key]: JSON.stringify(rebuildRequestPayload(container.child, nextMessages))
        };
    }
    const key = container.key || 'messages';
    if (key === 'contents') {
        return rebuildGeminiContentsPayload(container.original || {}, nextMessages, key);
    }
    return {
        ...(container.original || {}),
        [key]: nextMessages
    };
};

const LibraAuxBypassTypes = new Set([
    'memory',
    'emotion',
    'translate',
    'translation',
    'translations',
    'otherax',
    'other-ax',
    'other_ax'
]);

const GigaTransBypassRuntime = (() => {
    const inFlightByType = new Map();
    const ttlMs = 120000;
    const ambientGraceMs = 8000;
    let lastActivityAt = 0;
    const normalizeType = (type) => String(type || 'unknown').trim().toLowerCase() || 'unknown';
    const bump = () => { lastActivityAt = Date.now(); };
    const prune = () => {
        const now = Date.now();
        for (const [key, entry] of inFlightByType.entries()) {
            if (!entry || Number(entry.expiresAt || 0) <= now || Number(entry.count || 0) <= 0) {
                inFlightByType.delete(key);
            }
        }
    };
    return {
        mark(type) {
            prune();
            bump();
            const key = normalizeType(type);
            const current = inFlightByType.get(key) || { count: 0, expiresAt: 0 };
            inFlightByType.set(key, {
                count: Math.min(8, Number(current.count || 0) + 1),
                expiresAt: Date.now() + ttlMs
            });
        },
        consume(type) {
            prune();
            const keys = [normalizeType(type), 'unknown'];
            for (const key of keys) {
                const current = inFlightByType.get(key);
                if (!current || Number(current.count || 0) <= 0) continue;
                current.count = Number(current.count || 0) - 1;
                if (current.count > 0) inFlightByType.set(key, current);
                else inFlightByType.delete(key);
                return true;
            }
            return false;
        },
        isRecentActivity() {
            return (Date.now() - Number(lastActivityAt || 0)) < ambientGraceMs;
        }
    };
})();

const isGigaTransAmbientAuxType = (type = '') => {
    const normalized = String(type || '').trim().toLowerCase();
    return normalized === 'otherax'
        || normalized === 'other-ax'
        || normalized === 'other_ax'
        || normalized === 'submodel'
        || normalized === 'sub-model'
        || normalized === 'sub_model'
        || normalized === 'translate';
};

const getLatestRequestTextForBypass = (value) => {
    const CONTROL_TEXT_KEYS = ['code', 'action', 'event', 'mode', 'trigger', 'button', 'buttonCode', 'command', 'name', 'id'];
    const pickText = (item) => {
        if (item == null) return '';
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return String(item || '');
        if (Array.isArray(item)) return getLatestRequestTextForBypass(item);
        if (typeof item === 'object') {
            const role = String(item?.role || item?.author || item?.sender || item?.type || (item?.is_user ? 'user' : '') || '').trim().toLowerCase();
            const content = item?.content ?? item?.data ?? item?.text ?? item?.message ?? item?.msg ?? item?.mes ?? item?.prompt ?? '';
            if (content && (role === 'user' || role === 'system' || role === 'developer' || role === 'input' || role === 'prompt')) {
                return pickText(content);
            }
            const controlText = CONTROL_TEXT_KEYS
                .map(key => typeof item?.[key] === 'string' || typeof item?.[key] === 'number' ? String(item[key] || '').trim() : '')
                .filter(Boolean)
                .join(' ');
            return [controlText, pickText(content)].filter(Boolean).join(' ').trim();
        }
        return String(item || '');
    };
    if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
            const text = pickText(value[i]).trim();
            if (text) return text;
        }
        return '';
    }
    if (value && typeof value === 'object') {
        for (const key of REQUEST_MESSAGE_ARRAY_KEYS) {
            if (Array.isArray(value[key])) return getLatestRequestTextForBypass(value[key]);
        }
        for (const key of REQUEST_TEXT_KEYS) {
            if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
        }
        for (const key of REQUEST_NESTED_PAYLOAD_KEYS) {
            if (value[key]) {
                const nested = getLatestRequestTextForBypass(value[key]);
                if (nested) return nested;
            }
        }
    }
    return pickText(value).trim();
};

const isGigaTransHelperPrompt = (text = '') => {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    const isGigaTransButtonEvent =
        /\bonButtonClick\b/i.test(raw) && /\bgt__\w+::\d+\b/i.test(raw);
    const hasGtMarker = /<GT-CTRL\b[^>]*\/>|<GT-SEP\/>|<\s*GigaTrans(?:\s[^>]*)?>|<\s*\/\s*GigaTrans\s*>/i.test(raw)
        || /\bgt__re::\d+\b|\bgt__\w+::\d+\b/i.test(raw);
    const strongMarkers = [
        'translate the <sample_text>',
        'output only the translated text',
        '<sample_text>',
        '</sample_text>',
        '<translator_notes>',
        '</translator_notes>',
        '<lorebook>',
        '</lorebook>',
        '<persona>',
        '</persona>',
        '<context>',
        '</context>'
    ];
    const strongHits = strongMarkers.reduce((count, marker) => count + (lower.includes(marker) ? 1 : 0), 0);
    const sampleTextPair = lower.includes('<sample_text>') && lower.includes('</sample_text>');
    const translatorNotesPair = lower.includes('<translator_notes>') && lower.includes('</translator_notes>');
    const gigaTranslatorInstruction =
        lower.includes('translate the <sample_text>')
        || lower.includes('output only the translated text')
        || /\bgigatrans\s+(?:translation|translator|engine)\b/i.test(raw);
    const slotMarkers = ['{{slot::input}}', '{{slot::tnote}}', '{{slot::lore}}', '{{slot::persona}}', '{{slot::context}}'];
    const slotHits = slotMarkers.filter(marker => lower.includes(marker)).length;
    let visible = raw;
    try { visible = Utils.getMemorySourceText(raw).trim(); } catch (_) {}
    const pureGtControl = hasGtMarker && !visible;
    return isGigaTransButtonEvent
        || pureGtControl
        || hasGtMarker
        || strongHits >= 4
        || (sampleTextPair && translatorNotesPair && gigaTranslatorInstruction)
        || (slotHits >= 2 && (lower.includes('# advance_notice') || lower.includes('# system_role')) && gigaTranslatorInstruction);
};

const containsGigaTransHelperPrompt = (value, depth = 0, seen = new WeakSet()) => {
    if (value === null || value === undefined || depth > 7) return false;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return isGigaTransHelperPrompt(String(value || ''));
    }
    if (Array.isArray(value)) {
        return value.some(item => containsGigaTransHelperPrompt(item, depth + 1, seen));
    }
    if (typeof value === 'object') {
        if (seen.has(value)) return false;
        seen.add(value);
        const controlText = ['code', 'action', 'event', 'mode', 'trigger', 'button', 'buttonCode', 'command', 'name', 'id', 'type']
            .map(key => typeof value?.[key] === 'string' || typeof value?.[key] === 'number' ? String(value[key] || '').trim() : '')
            .filter(Boolean)
            .join(' ');
        if (isGigaTransHelperPrompt(controlText)) return true;
        return Object.values(value).some(item => containsGigaTransHelperPrompt(item, depth + 1, seen));
    }
    return false;
};

const isPureManagedModuleResponse = (text = '') => {
    const raw = String(text || '').trim();
    if (!raw) return true;
    const stripped = Utils.getMemorySourceText(raw)
        .replace(/[-—_\s]+/g, '')
        .trim();
    return stripped.length === 0;
};

const isManagedModuleHelperOutput = (text = '') => {
    const raw = String(text || '');
    if (!raw.trim()) return false;
    return containsGigaTransHelperPrompt(raw)
        || isGigaTransHelperPrompt(raw);
};

const getLibraAuxRequestBypassReason = (messagesOrContent, type, config = MemoryEngine?.CONFIG || {}, options = {}) => {
    const requestType = String(type || '').trim().toLowerCase();
    if (!Utils.isModelRequestType(requestType)) return `non-model request (${requestType || 'unknown'})`;
    if (config?.bypassAuxRequests === false) return '';
    const phase = String(options?.phase || '').trim().toLowerCase();
    const latestRequestText = getLatestRequestTextForBypass(messagesOrContent);
    const payloadText = typeof messagesOrContent === 'string'
        ? String(messagesOrContent || '')
        : latestRequestText;
    if (phase === 'afterrequest' && GigaTransBypassRuntime.consume(requestType)) return 'GigaTrans helper response';
    if (phase === 'beforerequest' && isGigaTransAmbientAuxType(requestType) && GigaTransBypassRuntime.isRecentActivity()) {
        GigaTransBypassRuntime.mark(requestType);
        return 'recent GigaTrans helper request';
    }
    if (containsGigaTransHelperPrompt(messagesOrContent)) {
        if (phase === 'beforerequest') GigaTransBypassRuntime.mark(requestType);
        return 'GigaTrans helper request';
    }
    if (isGigaTransHelperPrompt(latestRequestText)) {
        if (phase === 'beforerequest') GigaTransBypassRuntime.mark(requestType);
        return 'GigaTrans helper request';
    }
    if (
        phase === 'afterrequest'
        && options?.afterRequestOriginChecked === true
        && isOriginlessAuxRequestType(requestType)
    ) {
        const originMatched = !!options?.afterRequestOrigin || options?.originMatched === true;
        const latestAssistantMatchesCurrent = options?.latestAssistantMatchesCurrent === true;
        if (!originMatched && !latestAssistantMatchesCurrent && String(payloadText || '').trim()) {
            return `originless auxiliary/plugin request (${requestType || 'unknown'})`;
        }
    }
    if (LibraAuxBypassTypes.has(requestType)) return `auxiliary request (${requestType})`;
    return '';
};

const resolveCanonicalUserPayload = (messages = []) => {
    const primary = buildCanonicalUserPayload(findLatestUserMessage(messages));
    if (primary.strict || primary.raw) return primary;
    const cachedRaw = String(Utils.getMemorySourceText(_lastUserMessageRaw || _lastUserMessage || '') || '').trim();
    const cachedStrict = String(getStrictNarrativeUserText(_lastUserMessage || cachedRaw) || cachedRaw || '').trim();
    const cached = sanitizeCanonicalUserPayload({ strict: cachedStrict, raw: cachedRaw || cachedStrict });
    if (cached.strict || cached.raw) return cached;
    return { strict: '', raw: '' };
};

const getStrictNarrativeUserText = (text) => {
    if (isAutoContinueSilenceInput(text)) return '';
    const candidate = Utils.getNarrativeComparableText(text, 'user');
    if (!candidate) return '';
    if (Utils.isForcedBypassPrompt(candidate)) return '';
    return candidate;
};

const classifyNarrativeTurnChannel = (userText, aiText = '') => {
    const strictUser = String(getStrictNarrativeUserText(userText) || '').trim();
    const strictAi = String(Utils.getNarrativeComparableText(aiText, 'ai') || '').trim();
    const rawUser = String(Utils.getMemorySourceText(userText) || '').trim();
    const rawAi = String(Utils.getMemorySourceText(aiText) || '').trim();
    const hasNarrativePayload =
        Utils.hasSubstantialNarrativePayload(userText, 'user') ||
        Utils.hasSubstantialNarrativePayload(aiText, 'ai');
    const userSceneCues = !!rawUser && Utils.hasNarrativeSceneLikeCues(rawUser, 'user');
    const aiSceneCues = !!rawAi && Utils.hasNarrativeSceneLikeCues(rawAi, 'ai');
    const metaSignals = {
        userMeta: !!rawUser && (Utils.isMetaPromptLike(rawUser) || Utils.isForcedBypassPrompt(rawUser)),
        aiMeta: !!rawAi && (Utils.isMetaPromptLike(rawAi) || Utils.isTagOnlyToolResponse(rawAi))
    };
    const bypassSuggested = Utils.shouldBypassNarrativeSystems(userText, aiText);
    const narrativeChars = strictUser.length + strictAi.length;
    const sceneEligible = !bypassSuggested && (hasNarrativePayload || narrativeChars >= 24 || userSceneCues || aiSceneCues);
    return {
        channel: sceneEligible ? 'scene' : 'meta',
        strictUser,
        strictAi,
        rawUser,
        rawAi,
        hasNarrativePayload,
        userSceneCues,
        aiSceneCues,
        containsMetaSignals: metaSignals.userMeta || metaSignals.aiMeta,
        metaSignals,
        bypassSuggested
    };
};
