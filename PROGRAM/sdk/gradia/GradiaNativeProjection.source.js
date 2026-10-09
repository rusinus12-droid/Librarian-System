'use strict';
// Pure request-visible projection; richer native facts require an independent owner witness.
function createGradiaNativeProjectionV1() {
  const libNativePromptView = recent => ({
    ...Object.fromEntries(['latestUser', 'latestAssistantRaw', 'latestAssistant', 'terminalVisibleScene',
      'previousTurnUser', 'previousTurnAssistant', 'previousTurnText', 'earlierTurnsText',
      'completeTurnsText', 'sceneAnchor', 'previousResponseEvidence', 'text', 'visibleText']
      .map(key => [key, text(recent?.[key] || '')])),
    visibleMessages: (recent.visibleMessages || []).map(message => ({ role: message.role, content: message.content }))
  });
  const text = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  };
  const compact = (value, max = 1000) => {
    const body = text(value).replace(/\r\n/g, '\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!max || body.length <= max) return body;
    return body.slice(0, Math.max(0, max - 24)).trimEnd() + '\n…[truncated]';
  };
  const compactMiddle = (value, max = 1000, marker = '\n…[middle truncated for context]\n') => {
    const body = text(value).replace(/\r\n/g, '\n').trim();
    if (!max || body.length <= max) return body;
    const room = Math.max(0, max - marker.length);
    const head = Math.floor(room * 0.46);
    const tail = room - head;
    return `${body.slice(0, head).trimEnd()}${marker}${body.slice(Math.max(head, body.length - tail)).trimStart()}`;
  };
  const clampInt = (value, min, max, fallback) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  const contentToText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(part => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (part.type === 'text') return text(part.text || '');
        if (part.type === 'input_text') return text(part.text || '');
        if (part.type === 'image_url' || part.type === 'input_image') return '[image]';
        return compact(part, 400);
      }).filter(Boolean).join('\n');
    }
    return compact(content, 1200);
  };
  const isSgaInjectionText = (value) => {
    const body = text(value);
    return body.includes(INJECTION_HEADER) || LEGACY_INJECTION_HEADERS.some(header => body.includes(header));
  };
  const isLikelyMetaUserMessage = (value) => {
    const body = text(value).trim();
    if (!body) return true;
    if (isSgaInjectionText(body)) return true;
    if (/^(---|<\/?(?:Lore|Others Info|Last output|Past conversations|Image Commands|information)>|#\s*(?:Final Check|Tags|Expansion|Annotation Feature)|###\s*Status Interface)/i.test(body)) return true;
    if (/^system\s*:/i.test(body)) return true;
    if (/^Take my current input as inspiration/i.test(body)) return true;
    if (body.length > 1800 && /(?:Response template|Narration Principles|Content Policy|Character Information|Basic Information|Long-Term Memory Archive)/i.test(body)) return true;
    return false;
  };
  const isOthersInfoMessage = (value) => {
    const body = text(value).trim();
    if (!body || isPrivateMachinePayload(body)) return false;
    return /<\/?(?:Others Info|Lore|Last output|Past conversations|Image Commands|information)>/i.test(body)
      || /(?:packet reading|packet\s*read|패킷\s*리딩|LBDATA|Response template|Narration Principles|Content Policy|Character Information|Basic Information|Long-Term Memory Archive|Final Check|Tags|Expansion|Annotation Feature|Status Interface)/i.test(body);
  };
  const hasSgaChatProvenance = (message) => {
    if (!message || typeof message !== 'object') return false;
    const direct = [
      message.memo,
      message.chatId,
      message.chat_id,
      message.messageId,
      message.message_id,
      message.m_id,
      message.msgId,
      message.saying
    ].some(value => text(value || '').trim());
    if (direct) return true;
    if (message.generationInfo && typeof message.generationInfo === 'object' && Object.keys(message.generationInfo).length > 0) return true;
    const stableId = text(message.id || message.uuid || message.uid || '').trim();
    const timestamp = Number(message.time || message.timestamp || message.createdAt || 0);
    return !!stableId && Number.isFinite(timestamp) && timestamp > 0;
  };
  const currentTurnRole = (message) => {
    const raw = text(message?.role || message?.type || message?.speaker || message?.sender || message?.from || message?.name || '').trim().toLowerCase();
    if (message?.isUser === true || message?.fromUser === true || /^(?:user|human|player|you|me)$/.test(raw) || raw.includes('user')) return 'user';
    if (message?.isAssistant === true || message?.isBot === true || message?.isChar === true || /^(?:assistant|model|bot|char|character|ai)$/.test(raw) || raw.includes('assistant') || raw.includes('bot')) return 'assistant';
    return raw;
  };
  const rawCurrentTurnBody = (message) => contentToText(
    message?.rawContentText
      ?? message?.contentText
      ?? message?.content
      ?? message?.message
      ?? message?.text
      ?? message?.data
      ?? message?.value
      ?? ''
  );
  const stripCurrentInputWrapper = (value) => {
    let body = text(value || '');
    for (const tag of SGA_CURRENT_INPUT_TAGS) {
      body = body
        .replace(new RegExp(`<\\s*${tag.source}\\b[^>]*>`, 'gi'), '')
        .replace(new RegExp(`<\\s*\\/\\s*${tag.source}\\s*>`, 'gi'), '');
    }
    const fence = body.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```/);
    if (fence) body = fence[1];
    body = body.replace(/^```(?:[a-zA-Z0-9_-]+)?\s*/gm, '').replace(/\s*```$/gm, '');
    body = body.replace(/Take my current input as inspiration[\s\S]*$/i, '');
    return compact(body, 6000);
  };

  // Current-input wrapper reader. Only the published host wrapper set and the
  // generic Markdown carrier are recognized. Unknown prompt-preset structures
  // are deliberately not inferred.
  const latestSgaCurrentInputRange = (messages) => {
    const source = Array.isArray(messages) ? messages : [];
    for (let start = source.length - 1; start >= 0; start -= 1) {
      const startBody = rawCurrentTurnBody(source[start]);
      if (!startBody) continue;
      for (const tag of SGA_CURRENT_INPUT_TAGS) {
        const openRe = new RegExp(`<\\s*${tag.source}\\b[^>]*>`, 'i');
        const closeRe = new RegExp(`<\\s*\\/\\s*${tag.source}\\s*>`, 'i');
        const open = startBody.match(openRe);
        if (!open) continue;
        const tail = startBody.slice(Number(open.index || 0) + open[0].length);
        const inlineClose = tail.search(closeRe);
        if (inlineClose >= 0) {
          const current = stripCurrentInputWrapper(tail.slice(0, inlineClose));
          if (current) return { start, end: start, text: current, tag: tag.name };
          continue;
        }
        const parts = [tail];
        for (let end = start + 1; end < source.length; end += 1) {
          const next = source[end];
          if (currentTurnRole(next) === 'assistant') break;
          const body = rawCurrentTurnBody(next);
          const closeIndex = body.search(closeRe);
          if (closeIndex >= 0) {
            parts.push(body.slice(0, closeIndex));
            const current = stripCurrentInputWrapper(parts.join('\n'));
            if (current) return { start, end, text: current, tag: tag.name };
            break;
          }
          if (SGA_CURRENT_INPUT_TAGS.some(other => new RegExp(`<\\s*${other.source}\\b[^>]*>`, 'i').test(body))) break;
          parts.push(body);
        }
      }

      const mdHeaderRe = /^#\s*Current\s+Input\b/im;
      const mdOpen = startBody.match(mdHeaderRe);
      if (mdOpen) {
        const afterHeader = startBody.slice(Number(mdOpen.index || 0) + mdOpen[0].length);
        const fenceMatch = afterHeader.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```/);
        if (fenceMatch?.[1]) {
          const current = stripCurrentInputWrapper(fenceMatch[1]);
          if (current) return { start, end: start, text: current, tag: 'Current Input (markdown)' };
        }
        const lines = afterHeader.split(/\n/).filter(line => {
          const normalizedLine = text(line).trim();
          const risuTemplateControl = /^\{\{[#/:?]?[^{}]*\}\}$/.test(normalizedLine);
          return normalizedLine
            && !risuTemplateControl
            && !/^(?:[-*+]\s*)?(?:Proceed\b|Helpfully\b)/i.test(normalizedLine);
        });
        const current = stripCurrentInputWrapper(lines.join('\n'));
        if (current) return { start, end: start, text: current, tag: 'Current Input (markdown)' };
      }
    }
    return null;
  };
  const hasUnresolvedPromptTemplate = value => /\{\{[\s\S]{0,240}?\}\}|<%[\s\S]{0,240}?%>|\$\{[^}]{1,240}\}/.test(text(value));

  // The host has no durable per-message prefill marker. A trailing assistant is
  // not proof of prefill; eligibility below handles unclosed outputs explicitly.
  const findSgaTerminalAssistantPrefillIndex = (_messages) => -1;
  const currentInputFrom = (value) => {
    const body = text(value || '');
    for (const tag of SGA_CURRENT_INPUT_TAGS) {
      const open = `<\\s*${tag.source}\\b[^>]*>`;
      const close = `<\\s*\\/\\s*${tag.source}\\s*>`;
      const fenced = body.match(new RegExp(`${open}\\s*\`\`\`[a-zA-Z0-9_-]*\\s*([\\s\\S]*?)\\s*\`\`\`\\s*${close}`, 'i'));
      if (fenced?.[1]) return text(fenced[1]).trim();
      const plain = body.match(new RegExp(`${open}([\\s\\S]*?)${close}`, 'i'));
      if (plain?.[1]) return text(plain[1]).trim();
    }
    return '';
  };
  const stripOpaquePrivateBlocks = value => text(value || '')
    .replace(/<dag_runtime_contract\b[\s\S]*?(?:<\/dag_runtime_contract>|$)/gi, ' ')
    .replace(/<\s*(?:thoughts?|thinking|reasoning|analysis)\s*>[\s\S]*?<\s*\/\s*(?:thoughts?|thinking|reasoning|analysis)\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const isPrivateMachinePayload = value => {
    const body = text(value || '').trim();
    if (!body) return false;
    return /^<!--[\s\S]*-->$/.test(body)
      || /^<dag_runtime_contract\b[\s\S]*(?:<\/dag_runtime_contract>)?$/i.test(body)
      || /^<\s*(?:thoughts?|thinking|reasoning|analysis)\s*>[\s\S]*<\s*\/\s*(?:thoughts?|thinking|reasoning|analysis)\s*>$/i.test(body);
  };
  const isBackstageUserPayload = value => isPrivateMachinePayload(value);
  const isExternalMemoryInjectionPayload = value =>
    isSgaInjectionText(value) || SGA_EXTERNAL_MEMORY_INJECTION_RE.test(text(value)) || isPrivateMachinePayload(value);
  const SgaCurrentInputRequestKind = (() => {
    const moduleMarkerPattern = /(?:<\s*\/?\s*(?:lb-[a-z0-9-]+|lightboard-[a-z0-9-]+)\b|\blb-(?:rerolling|pending|lazy|reroll|interaction-identifier|xnai)\b|재생성\s*중)/i;
    const hardAuxiliaryMarkerPattern = /(?:<\/?\s*lb-process\b|\blb-xnai-editing\b|\blb-xnai-gen\/|\[LightBoard\]|\bLightBoard\s+Backend\b|<\s*\/?\s*lightboard-[a-z0-9-]+\b|\[LBDATA START\][\s\S]*?(?:lb-rerolling|lb-pending|lb-interaction-identifier|lb-xnai))/i;
    const structuredImagePromptPattern = /(?:\b(?:positive|negative)\s+prompt\b|(?:네거티브|포지티브)\s*프롬프트|(?:sampler|cfg\s*scale|steps|seed|denoise|checkpoint|loras?|vae)\s*:|stable\s*diffusion|comfyui|image\s+prompt|illustration\s+prompt|삽화\s*프롬프트|이미지\s*프롬프트)/i;
    const structuredTranslationPromptPattern = /(?:translate\s+(?:the\s+following|to\b)|translation\s+request|source\s+language|target\s+language|번역\s*(?:요청|전용)|다음\s*(?:문장|텍스트|내용)을\s*번역|원문\s*:|번역문\s*:)/i;
    const lightBoardStructuredFormatMarkers = Object.freeze([
      '<lb-npclist>', '</lb-npclist>', '[characterlist|', 'char-history-wrapper',
      'char-history-content', 'char-info-row', '📜 과거 기록 보기'
    ]);
    const lightBoardStructuredGuidanceMarkers = Object.freeze([
      'must start with <lb-npclist>', 'every character must have all 7 base fields',
      'future relevance test', 'strictly exclude characters', 'fill every field completely',
      'structured character list output', 'specific format'
    ]);
    const separatorPattern = /^(?:[-_\s|:;,.·•~`'"()[\]{}<>/\\]+|#+|응답\s*없음|no\s+content|null|undefined)*$/i;
    const stripModuleArtifacts = value => text(value)
      .replace(/\[LBDATA START\][\s\S]*?\[LBDATA END\]/gi, ' ')
      .replace(/<\s*\/?\s*(?:lb-[a-z0-9-]+|lightboard-[a-z0-9-]+)\b[^>]*>/gi, ' ')
      .replace(/\blb-(?:rerolling|pending|lazy|reroll|interaction-identifier|xnai)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const isEffectivelyEmpty = value => {
      const clean = stripModuleArtifacts(value).trim();
      return !clean || separatorPattern.test(clean);
    };
    const isModuleOnlyPrompt = value => {
      const raw = text(value || '');
      return !!raw.trim() && moduleMarkerPattern.test(raw) && isEffectivelyEmpty(raw);
    };
    const isLightBoardStructuredPrompt = value => {
      const raw = text(value || '').trim();
      if (!raw) return false;
      const lower = raw.toLowerCase();
      const formatHits = lightBoardStructuredFormatMarkers.filter(marker => lower.includes(text(marker).toLowerCase())).length;
      const guidanceHits = lightBoardStructuredGuidanceMarkers.filter(marker => lower.includes(text(marker).toLowerCase())).length;
      if (formatHits >= 2 && guidanceHits >= 1) return true;
      return formatHits >= 3;
    };
    const isHardAuxiliaryPrompt = value => {
      const raw = text(value || '');
      if (!raw.trim()) return false;
      if (hardAuxiliaryMarkerPattern.test(raw)) return true;
      if (isLightBoardStructuredPrompt(raw)) return true;
      if (structuredImagePromptPattern.test(raw)) return true;
      if (structuredTranslationPromptPattern.test(raw)) return true;
      return false;
    };
    return Object.freeze({ isModuleOnlyPrompt, isHardAuxiliaryPrompt });
  })();
  const latestSgaProvenanceUserTurn = (messages) => {
    const source = Array.isArray(messages) ? messages : [];
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const message = source[i];
      const role = currentTurnRole(message);
      if (role && !/user|human/i.test(role)) continue;
      if (!hasSgaChatProvenance(message)) continue;
      const rawBody = rawCurrentTurnBody(message);
      const wrapped = currentInputFrom(rawBody);
      const stripped = compact(wrapped || rawBody, 6000);
      if (!stripped || isBackstageUserPayload(rawBody) || isExternalMemoryInjectionPayload(rawBody)) continue;
      return {
        text: stripped,
        requestIndex: i,
        requestEndIndex: i,
        source: wrapped ? 'request_provenance_wrapper' : 'request_provenance_user',
        confidence: 'request_provenance',
        tag: '',
        message
      };
    }
    return null;
  };
  const resolveSgaCurrentTurn = (messages = []) => {
    const source = Array.isArray(messages) ? messages : [];
    const terminalPrefillIndex = findSgaTerminalAssistantPrefillIndex(source);
    const currentRange = latestSgaCurrentInputRange(source);
    const provenanceTurn = latestSgaProvenanceUserTurn(source);

    // Later provenance beats an older wrapper, and an unrendered wrapper
    // cannot displace a provenance-bearing user message.
    if (provenanceTurn && (
      !currentRange?.text
      || provenanceTurn.requestIndex > Number(currentRange.end ?? currentRange.start ?? -1)
      || hasUnresolvedPromptTemplate(currentRange.text)
    )) {
      return { ...provenanceTurn, terminalPrefillIndex };
    }

    if (currentRange?.text) {
      return {
        text: compact(currentRange.text, 6000),
        requestIndex: currentRange.start,
        requestEndIndex: currentRange.end,
        source: 'explicit_wrapper',
        confidence: 'explicit_wrapper',
        tag: currentRange.tag || '',
        terminalPrefillIndex,
        message: source[currentRange.start] || null
      };
    }

    // Same-message inline-wrapper fallback retained for host compatibility.
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const message = source[i];
      const role = currentTurnRole(message);
      if (role && !/user|human/i.test(role)) continue;
      const current = currentInputFrom(rawCurrentTurnBody(message));
      if (!current) continue;
      return {
        text: compact(current, 6000),
        requestIndex: i,
        requestEndIndex: i,
        source: 'inline_wrapper',
        confidence: 'explicit_wrapper',
        tag: '',
        terminalPrefillIndex,
        message
      };
    }

    if (provenanceTurn) return { ...provenanceTurn, terminalPrefillIndex };

    const hasAnyProvenance = source.some(hasSgaChatProvenance);
    const legacyLimit = terminalPrefillIndex >= 0 ? terminalPrefillIndex - 1 : source.length - 1;
    const legacyCandidates = [];
    for (let i = legacyLimit; i >= 0; i -= 1) {
      const message = source[i];
      const role = currentTurnRole(message);
      if (role && !/user|human/i.test(role)) continue;
      const rawBody = rawCurrentTurnBody(message);
      const stripped = compact(rawBody, 6000);
      if (!stripped || isBackstageUserPayload(rawBody) || isExternalMemoryInjectionPayload(rawBody)) continue;
      if (SgaCurrentInputRequestKind.isModuleOnlyPrompt(stripped) || SgaCurrentInputRequestKind.isHardAuxiliaryPrompt(stripped)) continue;
      legacyCandidates.push({ index: i, text: stripped, message });
      if (legacyCandidates.length >= 2) break;
    }

    const allowLegacyTailFallback = !hasAnyProvenance && terminalPrefillIndex < 0 && legacyCandidates.length > 0;
    if (legacyCandidates.length === 1 || allowLegacyTailFallback) {
      const selected = legacyCandidates[0];
      return {
        text: selected.text,
        requestIndex: selected.index,
        requestEndIndex: selected.index,
        source: legacyCandidates.length === 1 ? 'unique_legacy_user' : 'legacy_last_safe_user',
        confidence: legacyCandidates.length === 1 ? 'legacy_unique' : 'legacy_ambiguous',
        tag: '',
        terminalPrefillIndex,
        message: selected.message
      };
    }

    return {
      text: '',
      requestIndex: -1,
      requestEndIndex: -1,
      source: 'none',
      confidence: 'none',
      tag: '',
      terminalPrefillIndex,
      message: null
    };
  };
  const stripPostprocessForPrivateRecentReading = (value) => text(value || '')
    .replace(/\[LBDATA START\][\s\S]*?(?:\[LBDATA END\]|$)/gi, ' ')
    .replace(/<lb-lazy\b[^>]*\/\s*>/gi, ' ')
    .replace(/<lb-lazy\b[^>]*>[\s\S]*?(?:<\/lb-lazy>|$)/gi, ' ');

  // Read-only story copy used only inside GRADIA. Opaque comments and reasoning
  // carriers are ignored by generic syntax; no foreign module schema is parsed
  // or promoted into a GRADIA continuity source.
  const deriveNarrativeContinuityCopy = value => stripOpaquePrivateBlocks(
    stripPostprocessForPrivateRecentReading(value)
  ).trim();
  const extractInputAssistTerminalTail = (content, maxChars = INPUT_ASSIST_TERMINAL_TAIL_MAX_CHARS) => {
    const limit = clampInt(maxChars, 600, 6000, INPUT_ASSIST_TERMINAL_TAIL_MAX_CHARS);
    const visible = deriveNarrativeContinuityCopy(content)
      .replace(/<GT-(?:CTRL|SEP)\b[^>]*\/?>/gi, ' ')
      .replace(/^\s*<img\b[^>]*>\s*$/gim, ' ')
      .replace(/^\s*#{1,6}\s+[^\n]*$/gm, ' ')
      .replace(/^\s*---+\s*$/gm, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!visible) return '';

    let tail = visible.length > limit ? visible.slice(-limit) : visible;
    if (visible.length > limit) {
      const paragraphBoundary = tail.indexOf('\n\n');
      if (paragraphBoundary >= 0 && paragraphBoundary <= Math.floor(limit * 0.38)) {
        tail = tail.slice(paragraphBoundary + 2);
      }
    }

    const sceneMarkers = [...tail.matchAll(/(?:^|\n)(?:\s*---+\s*\n)?(?:⏱️\[[^\]\n]{1,120}\]|\[[12]\d{3}[-/][^\]\n]{1,120}\])/g)];
    const finalMarker = sceneMarkers[sceneMarkers.length - 1];
    if (finalMarker && tail.length - finalMarker.index >= Math.min(280, Math.floor(limit * 0.22))) {
      tail = tail.slice(finalMarker.index).replace(/^\s*---+\s*/g, '');
    }
    return tail.trim();
  };
  const extractSceneAnchorFromAssistant = (content) => {
    const src = deriveNarrativeContinuityCopy(content)
      .replace(/<\/?(?:Last output|Past conversations|information)>/gi, ' ')
      .trim();
    const formats = [
      /\[[^\n\[\]]{0,40}\|[^\n\[\]]{0,80}\|[^\n\[\]]{0,120}\|[^\n\[\]]{0,180}\]/g,
      /(?:\*\*|##)\s*(?:Location|장소|위치|Scene|장면|Setting|배경)\s*:?\s*\*?\*?\s*([^\n]{1,200})/gi,
      /(?:^|\n)\s*(?:📍|🗺️|🏠|📂)\s*([^\n]{1,200})/g,
      /(?:^|\n)\s*(?:Location|장소|Time|시간|Date|날짜|Weather|날씨|Mood|분위기)\s*:\s*([^\n]{1,180})/gi
    ];
    let last = '';
    for (const regex of formats) {
      const matches = [...src.matchAll(regex)];
      if (matches.length) {
        const match = matches[matches.length - 1];
        last = match[1] ? match[1].trim() : match[0];
      }
    }
    if (!last) {
      const statusBlock = src.match(/(?:^|\n)###\s*Status[\s\S]*?(?=\n###|\n##|\n# |$)/i);
      if (statusBlock) last = compact(statusBlock[0].replace(/^###\s*Status/i, '').trim(), 600);
    }
    if (!last) {
      const visibleParagraphs = src
        .split(/\n\s*\n/)
        .map(block => block
          .replace(/^\s*<img\b[^>]*>\s*$/gim, ' ')
          .replace(/^\s*#{1,6}\s+(?:응답|Response|볼륨|Volume|챕터|Chapter|Chatindex)(?:\s|$)[^\n]*$/gim, ' ')
          .replace(/^\s*⏱️?\s*\[[^\]\n]{1,120}\]\s*$/gim, ' ')
          .trim())
        .filter(block => block
          && !/^(?:```|---)/i.test(block)
          && !/^\[[A-Z][A-Z0-9 _:-]{2,80}\b(?:START|BEGIN)\b/i.test(block)
          && !/^<[a-z][a-z0-9:_-]*\b[\s\S]*<\/[a-z][a-z0-9:_-]*>\s*$/i.test(block));
      const ending = visibleParagraphs.slice(-3).join('\n\n');
      if (ending) last = `Visible ending excerpt:\n${compactMiddle(ending, 900)}`;
    }
    return compact(last, 900);
  };
  const formatMessageWindow = (messages, maxEach = 2200, maxTotal = 18000) => {
    const formatted = (messages || []).map((m, i) => {
      const label = m.name ? `${m.role}:${m.name}` : m.role;
      return `#${i + 1} <${label}>\n${compact(m.content, maxEach)}`;
    }).join('\n\n---\n\n');
    return compact(formatted, maxTotal);
  };
  const nativeTurnMessageId = message => text(message?.chatId || message?.messageId || message?.message_id || message?.m_id || (message?.memo === 'NewChat' ? '' : message?.memo) || '').trim();
  const nativeTurnRef = message => ({
    messageId: nativeTurnMessageId(message) || null,
    generationId: text(message?.generationInfo?.generationId || '').trim() || null,
    speakerId: text(message?.saying || '').trim() || null,
    speakerName: text(message?.name || '').trim() || null,
    contentHash: createTextHasher().update(contentToText(message?.data ?? message?.content ?? '')).digest()
  });
  const turnBlockReason = message => {
    if (message?.turnMeta?.blocked) return message.turnMeta.blocked;
    if (message?.disabled) return 'disabled';
    if (message?.isComment === true) return 'comment';
    if (message?.isStreaming === true) return 'active_stream';
    if (!text(message?.content || '').trim()) return 'empty';
    if (message.role === 'assistant' && /```risuerror\b/i.test(message.content)) return 'host_error';
    return '';
  };
  const resolveCurrentVisibleUserIndex = (messages, currentUserText = '') => {
    const list = Array.isArray(messages) ? messages : [];
    const marked = list.findIndex(message => message?.turnMeta?.currentInput === true);
    if (marked >= 0) return marked;
    if (!text(currentUserText).trim()) return -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.role === 'user' && sameVisibleChatContent(list[i]?.content, currentUserText)) return i;
    }
    return -1;
  };
  const pairCompletedChatTurns = (messages, currentUserText = '') => {
    const list = (Array.isArray(messages) ? messages : [])
      .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
      .map(message => ({ ...message, content: text(message.content || '') }));
    const currentUserIndex = resolveCurrentVisibleUserIndex(list, currentUserText);
    const end = currentUserIndex >= 0 ? currentUserIndex + 1 : list.length;
    const turns = [], excluded = [];
    const selectedAssistantIndex = new Map();
    for (let i = 0; i < end; i += 1) if (list[i].role === 'assistant' && nativeTurnMessageId(list[i])) selectedAssistantIndex.set(nativeTurnMessageId(list[i]), i);
    let pendingUser = null, assistants = [], invalidGroup = false, leadingAssistant = null;
    const ref = message => message?.turnMeta?.ref || nativeTurnRef(message);
    const close = (boundary, trailing = false) => {
      if (!pendingUser) return;
      if (invalidGroup) excluded.push({ reason: 'incomplete_or_invalid_group', user: ref(pendingUser), assistants: assistants.map(ref) });
      else if (assistants.length) {
        const verified = assistants.every(message => message.turnMeta?.verifiedCompletion === true);
        const boundaryProven = !!boundary && (boundary.turnMeta?.nativeSelected === true || boundary.turnMeta?.currentInputProven === true || !!nativeTurnMessageId(boundary));
        if (verified || boundaryProven) {
          const assistant = assistants.length === 1 ? assistants[0] : {
            role: 'assistant', content: assistants.map(message => `[${text(message.name || message.saying || 'assistant')}]\n${message.content}`).join('\n\n'),
            turnMeta: { group: true }
          };
          turns.push({ user: pendingUser, assistant, assistantMessages: assistants.slice(),
            proofKind: verified ? 'verified_completion' : 'closed_conversation_boundary',
            refs: { user: ref(pendingUser), assistant: assistants.length === 1 ? ref(assistants[0]) : null, assistants: assistants.map(ref), boundary: boundary ? ref(boundary) : null } });
        } else excluded.push({ reason: trailing ? 'unknown_trailing_completion' : 'unbound_user_boundary', assistants: assistants.map(ref) });
      }
      assistants = []; invalidGroup = false;
    };
    for (let index = 0; index < end; index += 1) {
      const message = list[index];
      const id = nativeTurnMessageId(message);
      if (message.role === 'assistant' && id && selectedAssistantIndex.get(id) !== index) {
        excluded.push({ reason: 'replaced_native_variant', assistant: ref(message) }); continue;
      }
      const blocked = turnBlockReason(message);
      if (blocked) {
        excluded.push({ reason: blocked, role: message.role, ref: ref(message) });
        if (message.role === 'user') { pendingUser = null; assistants = []; invalidGroup = false; }
        else if (pendingUser) invalidGroup = true;
        continue;
      }
      if (message.role === 'user') {
        close(message);
        pendingUser = index === currentUserIndex ? null : message;
        if (index === currentUserIndex) break;
      } else if (pendingUser) assistants.push(message);
      else if (!turns.length && !leadingAssistant && (message.turnMeta?.greeting === true || message.turnMeta?.referencePrelude === true)) leadingAssistant = message;
      else excluded.push({ reason: 'unpaired_assistant', assistant: ref(message) });
    }
    close(null, true);
    return { turns, leadingAssistant, currentUser: currentUserIndex >= 0 ? list[currentUserIndex] : null,
      currentUserIndex, chatMessages: list, turnEligibility: { semantics: 'visible_closed_turns_with_completion_tier', excluded } };
  };
  const formatCompleteTurnWindow = (turns, firstTurnNumber = 1) => (turns || []).map((turn, idx) => [
    `<TURN index="${firstTurnNumber + idx}">`,
    '<USER>',
    text(turn?.user?.content || ''),
    '</USER>',
    '<ASSISTANT>',
    text(turn?.assistant?.content || ''),
    '</ASSISTANT>',
    '</TURN>'
  ].join('\n')).join('\n\n');
  const buildCompleteRecentTurnWindow = (messages, turnWindow, currentUserText = '') => {
    const paired = pairCompletedChatTurns(messages, currentUserText);
    const count = clampInt(turnWindow, 1, 64, DEFAULT_RECENT_TURNS);
    const selectedTurns = paired.turns.slice(-count);
    const startNumber = Math.max(1, paired.turns.length - selectedTurns.length + 1);
    const previousTurn = selectedTurns[selectedTurns.length - 1] || null;
    const includePrelude = !!paired.leadingAssistant && selectedTurns.length === paired.turns.length;
    const preludeText = includePrelude ? `<INITIAL_ASSISTANT_SCENE>
${text(paired.leadingAssistant.content || '')}
</INITIAL_ASSISTANT_SCENE>` : '';
    const turnsText = formatCompleteTurnWindow(selectedTurns, startNumber);
    const completeTurnsText = [preludeText, turnsText].filter(Boolean).join('\n\n');
    const previousTurnText = previousTurn
      ? formatCompleteTurnWindow([previousTurn], paired.turns.length)
      : preludeText;
    const earlierTurns = previousTurn ? selectedTurns.slice(0, -1) : [];
    const earlierTurnsText = previousTurn
      ? [
          preludeText,
          formatCompleteTurnWindow(earlierTurns, startNumber)
        ].filter(Boolean).join('\n\n')
      : '';
    const selectedMessages = selectedTurns.flatMap(turn => [turn.user, ...(turn.assistantMessages || [turn.assistant])]);
    if (includePrelude) selectedMessages.unshift(paired.leadingAssistant);
    if (paired.currentUser) selectedMessages.push(paired.currentUser);
    return {
      ...paired,
      selectedTurns,
      turnEligibility: { ...paired.turnEligibility, requestedTurns: count, includedTurns: selectedTurns.length, availableEligibleTurns: paired.turns.length, omittedWholeTurnsForWindow: Math.max(0, paired.turns.length - selectedTurns.length), partialTurnsIncluded: false, selected: selectedTurns.map(turn => ({ proofKind: turn.proofKind, ...turn.refs })) },
      selectedMessages,
      completeTurnsText,
      earlierTurnsText,
      previousTurn,
      previousTurnText,
      previousTurnUser: text(previousTurn?.user?.content || ''),
      previousTurnAssistant: text(previousTurn?.assistant?.content || paired.leadingAssistant?.content || ''),
      recentTurnCount: selectedTurns.length
    };
  };
  const buildRecentChat = (messages, settings) => {
    // v0.25.76: keep old message bodies as lightweight strings while pairing the
    // recent window, then run the expensive history sanitizer only on content that
    // can actually reach a prompt. This preserves turn numbering without repeatedly
    // regex-cleaning hundreds/thousands of old messages.
    const normalized = Array.isArray(messages)
      ? messages.map((msg, index) => ({
          ...msg,
          role: text(msg?.role || 'unknown').toLowerCase(),
          content: contentToText(msg?.content),
          name: text(msg?.name || ''),
          index
        }))
      : [];
    const allowed = normalized
      .map(m => {
        // Content filtering must not erase a selected native identity: retain a
        // blocking tombstone so an older variant/group member cannot revive it.
        if (['user', 'assistant'].includes(m.role) && nativeTurnMessageId(m)
          && (isSgaInjectionText(m.content) || isLikelyMetaUserMessage(m.content) || isOthersInfoMessage(m.content))) {
          return { ...m, content: '', turnMeta: { ...m.turnMeta, blocked: 'filtered_conversation_record' } };
        }
        return m;
      })
      .filter(m => ['system', 'user', 'assistant', 'developer'].includes(m.role))
      .filter(m => ['user', 'assistant'].includes(m.role) || text(m.content || '').trim())
      .filter(m => !isSgaInjectionText(m.content));
    const systemContextMessages = allowed.filter(m => ['system', 'developer'].includes(m.role));
    const otherInfoMessages = allowed.filter(m => {
      if (['system', 'developer'].includes(m.role)) return false;
      return isOthersInfoMessage(m.content) || (m.role === 'user' && isLikelyMetaUserMessage(m.content));
    });
    const visibleChatMessages = allowed.filter(m => {
      if (!['user', 'assistant'].includes(m.role)) return false;
      // Keep empty native/request records through eligibility and variant selection.
      if (!text(m.content || '').trim()) return true;
      if (isLikelyMetaUserMessage(m.content) || isOthersInfoMessage(m.content)) return false;
      return true;
    });
    const sanitizeWindowMessage = message => message ? {
      ...message,
      content: sanitizeMessageContentForHistory(message.role, message.content)
    } : null;
    const systemSliced = systemContextMessages.slice(-6).map(sanitizeWindowMessage).filter(m => text(m?.content || '').trim());
    const otherSliced = otherInfoMessages.slice(-8).map(sanitizeWindowMessage).filter(m => text(m?.content || '').trim());
    const currentTurnResolution = settings?.currentTurnResolution?.text
      ? settings.currentTurnResolution
      : resolveSgaCurrentTurn(messages);
    const latestUser = text(currentTurnResolution.text || '');
    const rawTurnWindow = buildCompleteRecentTurnWindow(visibleChatMessages, settings.turnWindow, latestUser);
    const sanitizedSelectedTurns = (rawTurnWindow.selectedTurns || []).map(turn => ({
      user: sanitizeWindowMessage(turn.user),
      assistant: sanitizeWindowMessage(turn.assistant),
      assistantMessages: (turn.assistantMessages || [turn.assistant]).map(sanitizeWindowMessage)
    })).filter(turn => text(turn.user?.content || '').trim() || text(turn.assistant?.content || '').trim());
    const sanitizedLeadingAssistant = sanitizeWindowMessage(rawTurnWindow.leadingAssistant);
    const sanitizedCurrentUser = sanitizeWindowMessage(rawTurnWindow.currentUser);
    const startNumber = Math.max(1, (rawTurnWindow.turns || []).length - sanitizedSelectedTurns.length + 1);
    const previousTurn = sanitizedSelectedTurns[sanitizedSelectedTurns.length - 1] || null;
    const includePrelude = !!sanitizedLeadingAssistant?.content && sanitizedSelectedTurns.length === (rawTurnWindow.turns || []).length;
    const preludeText = includePrelude ? `<INITIAL_ASSISTANT_SCENE>\n${text(sanitizedLeadingAssistant.content || '')}\n</INITIAL_ASSISTANT_SCENE>` : '';
    const turnsText = formatCompleteTurnWindow(sanitizedSelectedTurns, startNumber);
    const completeTurnsText = [preludeText, turnsText].filter(Boolean).join('\n\n');
    const previousTurnText = previousTurn
      ? formatCompleteTurnWindow([previousTurn], Math.max(1, (rawTurnWindow.turns || []).length))
      : preludeText;
    const earlierTurns = previousTurn ? sanitizedSelectedTurns.slice(0, -1) : [];
    const earlierTurnsText = previousTurn
      ? [preludeText, formatCompleteTurnWindow(earlierTurns, startNumber)].filter(Boolean).join('\n\n')
      : '';
    const selectedMessages = sanitizedSelectedTurns.flatMap(turn => [turn.user, ...(turn.assistantMessages || [turn.assistant])]).filter(Boolean);
    if (includePrelude) selectedMessages.unshift(sanitizedLeadingAssistant);
    if (sanitizedCurrentUser?.content) selectedMessages.push(sanitizedCurrentUser);
    const turnWindow = {
      ...rawTurnWindow,
      leadingAssistant: sanitizedLeadingAssistant,
      currentUser: sanitizedCurrentUser,
      selectedTurns: sanitizedSelectedTurns,
      selectedMessages,
      completeTurnsText,
      earlierTurnsText,
      previousTurn,
      previousTurnText,
      previousTurnUser: text(previousTurn?.user?.content || ''),
      previousTurnAssistant: text(previousTurn?.assistant?.content || sanitizedLeadingAssistant?.content || ''),
      recentTurnCount: sanitizedSelectedTurns.length
    };
    const latestAssistantRaw = turnWindow.previousTurnAssistant || '';
    const latestAssistant = deriveNarrativeContinuityCopy(latestAssistantRaw);
    const terminalVisibleScene = extractInputAssistTerminalTail(
      latestAssistantRaw,
      INPUT_ASSIST_TERMINAL_TAIL_MAX_CHARS
    );
    const privatePreviousTurnText = deriveNarrativeContinuityCopy(turnWindow.previousTurnText || '');
    const privateEarlierTurnsText = deriveNarrativeContinuityCopy(turnWindow.earlierTurnsText || '');
    const privateCompleteTurnsText = deriveNarrativeContinuityCopy(turnWindow.completeTurnsText || '');
    const sceneAnchor = extractSceneAnchorFromAssistant(latestAssistantRaw);
    const previousResponseEvidence = compactMiddle(latestAssistant, 9000);
    const visibleMessages = turnWindow.selectedMessages.map((m, idx) => ({
      role: m.role,
      name: m.name || '',
      index: m.index,
      source: `complete recent turn message ${idx + 1} by ${m.role}`,
      content: m.role === 'assistant'
        ? deriveNarrativeContinuityCopy(m.content || '')
        : stripPostprocessForPrivateRecentReading(m.content || '')
    }));
    return {
      latestUser,
      currentTurnResolution: {
        source: currentTurnResolution.source || 'none',
        confidence: currentTurnResolution.confidence || 'none',
        requestIndex: Number.isInteger(currentTurnResolution.requestIndex) ? currentTurnResolution.requestIndex : -1,
        requestEndIndex: Number.isInteger(currentTurnResolution.requestEndIndex) ? currentTurnResolution.requestEndIndex : -1,
        tag: currentTurnResolution.tag || ''
      },
      latestAssistant,
      latestAssistantRaw,
      terminalVisibleScene,
      previousTurnUser: turnWindow.previousTurnUser,
      previousTurnAssistant: latestAssistant,
      previousTurnText: privatePreviousTurnText,
      earlierTurnsText: privateEarlierTurnsText,
      completeTurnsText: privateCompleteTurnsText,
      recentTurnCount: turnWindow.recentTurnCount,
      turnEligibility: turnWindow.turnEligibility,
      sceneAnchor,
      previousResponseEvidence,
      text: privateCompleteTurnsText,
      visibleText: privateCompleteTurnsText,
      systemContext: formatMessageWindow(systemSliced, 1800, 7000),
      othersInfo: formatMessageWindow(otherSliced, 1800, 9000),
      visibleMessages,
      loreSearchMessages: visibleMessages.map((m, idx) => ({
        source: m.name ? `complete recent turn message ${idx + 1} by ${m.role}:${m.name}` : `complete recent turn message ${idx + 1} by ${m.role}`,
        role: m.role,
        prompt: `\x01{{${m.name || m.role}}}:${m.content}\x01`,
        data: m.content
      })),
      messageCount: normalized.length,
      filteredMessageCount: allowed.length,
      visibleMessageCount: visibleMessages.length,
      othersInfoCount: otherInfoMessages.length
    };
  };
  const normalizeForLoreMatch = (value) => text(value || '')
    .toLocaleLowerCase()
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const createTextHasher = () => {
    let hash = 2166136261;
    let length = 0;
    return {
      update(value) {
        const body = String(value ?? '');
        for (let idx = 0; idx < body.length; idx += 1) {
          hash ^= body.charCodeAt(idx);
          hash = Math.imul(hash, 16777619);
        }
        hash ^= 31;
        hash = Math.imul(hash, 16777619);
        length += body.length + 1;
        return this;
      },
      digest() { return `${(hash >>> 0).toString(16).padStart(8, '0')}:${length}`; }
    };
  };
  const stripHiddenReasoningBlocks = (value) => {
    let body = text(value || '').trim();
    if (!body) return '';
    body = body.replace(/<\s*(?:thoughts?|thinking|reasoning|analysis)\s*>[\s\S]*?<\s*\/\s*(?:thoughts?|thinking|reasoning|analysis)\s*>\s*/gi, '').trim();
    if (hiddenReasoningStartRe.test(body)) {
      const marker = body.search(responseStartRe);
      if (marker >= 0) body = body.slice(marker).trim();
      else return '';
    }
    body = body.replace(/^\s*(?:key beats|structure|constraints check)\s*:\s*[\s\S]*?(?=\n\s*(?:#\s*(?:응답|response)(?:\s|$)|#{2,6}\s+|####?\s*Chatindex\s*:|⏱️|<img\s+cmd=))/i, '').trim();
    return body;
  };
  const sanitizeMessageContentForHistory = (role, value) => {
    const normalizedRole = text(role || '').trim().toLowerCase();
    const assistantLike = ['assistant', 'char', 'character', 'bot', 'model', 'ai'].includes(normalizedRole);
    const contextLike = assistantLike || normalizedRole === 'system' || normalizedRole === 'developer';
    const raw = stripPostprocessForPrivateRecentReading(stripOpaquePrivateBlocks(value));
    if (!raw || !assistantLike) return raw;
    const hadHiddenBlock = /<\s*(?:thoughts?|thinking|reasoning|analysis)\s*>/i.test(raw) || hiddenReasoningStartRe.test(raw);
    if (!hadHiddenBlock) return raw;
    let body = stripHiddenReasoningBlocks(raw);
    if (responseStartRe.test(body)) {
      body = body.replace(/^\s*(?:Of course!?|Sure[.!]?|Certainly[.!]?|Here(?:'s| is)(?: the)?(?: response| draft)?[.:]?)\s*/i, '').trim();
    }
    return body;
  };
  const INJECTION_HEADER = '[SCENE CONTINUITY AND RESPONSE]';
  const LEGACY_INJECTION_HEADERS = Object.freeze(['[GRADIA]', '[SERIAL GRADATION AGENTS FOR RP]']);
  const SGA_CURRENT_INPUT_TAGS = Object.freeze([
    { name: 'Current Input', source: 'Current\\s+Input' },
    { name: 'Latest User Input to Continue From', source: 'Latest\\s+User\\s+Input\\s+to\\s+Continue\\s+From' },
    { name: 'Physis', source: 'Physis' },
    { name: 'Writing Cue', source: 'Writing\\s+Cue' },
    { name: 'current_message', source: 'current_message' }
  ]);
  const SGA_EXTERNAL_MEMORY_INJECTION_RE = /\[VECTOR RAG MEMORY\]|\[[A-Z0-9_-]+\s+[^\]\n]{1,100}\s+Injection\]/i;
  const DEFAULT_RECENT_TURNS = 8;
  const INPUT_ASSIST_TERMINAL_TAIL_MAX_CHARS = 2400;
  const hiddenReasoningStartRe = /^\s*(?:<\s*(?:thoughts?|thinking|reasoning|analysis)\s*>|(?:thoughts?|thinking|reasoning|analysis|key beats|structure|constraints check)\s*:)/i;
  const responseStartRe = /(?:^|\n)\s*(?:#\s*(?:응답|response)(?:\s|$)|#{2,6}\s+|####?\s*Chatindex\s*:|⏱️?\s*\[?\d{4}-\d{2}-\d{2}|<img\s+cmd=)/i;
  const sameVisibleChatContent = (left, right) => normalizeForLoreMatch(left) === normalizeForLoreMatch(right);
  const projectionError=reason=>{throw new TypeError('GRADIA_NATIVE_PROJECTION_'+reason);};
  function inertRecord(value,required,optional=[]){
    if(!value||typeof value!=='object'||Array.isArray(value))projectionError('OBJECT');
    const proto=Object.getPrototypeOf(value);if(proto!==null&&proto!==Object.prototype)projectionError('PROTOTYPE');
    const keys=Reflect.ownKeys(value),out=Object.create(null);if(keys.length>required.length+optional.length)projectionError('FIELDS');
    for(const key of keys){if(typeof key!=='string'||(!required.includes(key)&&!optional.includes(key)))projectionError('FIELDS');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)projectionError('ACCESSOR');out[key]=d.value;}
    for(const key of required)if(!Object.hasOwn(out,key))projectionError('MISSING_FIELD');return out;
  }
  function inertArray(value,max){
    if(!Array.isArray(value))projectionError('ARRAY');if(Object.getPrototypeOf(value)!==Array.prototype)projectionError('PROTOTYPE');const length=Object.getOwnPropertyDescriptor(value,'length').value;if(!Number.isSafeInteger(length)||length>max||Reflect.ownKeys(value).length!==length+1)projectionError('ARRAY_LIMIT');
    const out=[];for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable)projectionError('ACCESSOR');out.push(d.value);}return out;
  }
  function checkedString(value,max){
    if(typeof value!=='string'||value.length>max)projectionError('STRING');let bytes=0;
    for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))projectionError('UNSUPPORTED_TEXT');bytes+=4;}else if(c>=0xdc00&&c<=0xdfff)projectionError('UNSUPPORTED_TEXT');else bytes+=c<128?1:c<2048?2:3;if(bytes>max)projectionError('STRING_BYTES');}return bytes;
  }
  function qualifiedInput(raw){
    const rows=inertArray(raw,16384),roles=new Map(),refs=new Set();let bytes=0;
    const add=(value,max)=>{bytes+=checkedString(value,max);if(bytes>8388608)projectionError('NATIVE_BYTES');};
    const optional=['memo','chatId','messageId','message_id','m_id','generationInfo','saying','name','disabled','isComment','isStreaming','attr','thoughts','multimodals'];
    return rows.map(row=>{
      const message=inertRecord(row,['role','content'],optional);
      if(!['user','assistant','system','developer'].includes(message.role))projectionError('ROLE');add(message.content,8388608);
      for(const key of ['memo','chatId','messageId','message_id','m_id','saying','name'])if(Object.hasOwn(message,key)&&message[key]!==null)add(message[key],256);
      if(Object.hasOwn(message,'generationInfo')&&message.generationInfo!==null){const generation=inertRecord(message.generationInfo,['generationId']);if(generation.generationId!==null)add(generation.generationId,256);message.generationInfo=Object.freeze(generation);}
      if(Object.hasOwn(message,'disabled')&&typeof message.disabled!=='boolean'&&message.disabled!=='allBefore')projectionError('FLAG');
      for(const key of ['isComment','isStreaming'])if(Object.hasOwn(message,key)&&typeof message[key]!=='boolean')projectionError('FLAG');
      if(Object.hasOwn(message,'attr')){message.attr=Object.freeze(inertArray(message.attr,64));for(const value of message.attr)add(value,256);}
      if(Object.hasOwn(message,'thoughts')&&message.thoughts!==null)add(message.thoughts,8388608);
      if(Object.hasOwn(message,'multimodals'))message.multimodals=Object.freeze(inertArray(message.multimodals,0));
      const aliases=['chatId','messageId','message_id','m_id','memo'].map(k=>k==='memo'&&message[k]==='NewChat'?'':text(message[k]||'').trim()).filter(Boolean);
      if(new Set(aliases).size>1)projectionError('CONFLICTING_ID');
      const messageId=nativeTurnMessageId(message);
      if(message.role==='user'&&!messageId)projectionError('NATIVE_ID_UNAVAILABLE');
      if(messageId){if(roles.has(messageId)&&roles.get(messageId)!==message.role)projectionError('CONFLICTING_ROLE');roles.set(messageId,message.role);const key=JSON.stringify(nativeTurnRef(message));if(refs.has(key))projectionError('AMBIGUOUS_REF');refs.add(key);}
      if(/<\/?[^>]*(?:current[^>]*input|input[^>]*current)[^>]*>/i.test(message.content)&&!currentInputFrom(message.content))projectionError('UNSUPPORTED_WRAPPER');
      return Object.freeze(message);
    });
  }
  function normalizedPolicy(raw){
    const policy=inertRecord(raw,['enabledStages','turnWindows']),stages=inertArray(policy.enabledStages,4);
    if(stages[0]!=='shadow_act'||new Set(stages).size!==stages.length||stages.some(s=>!['shadow_act','aide_character','aide_world','aide_plot'].includes(s)))projectionError('STAGES');
    const windows=inertRecord(policy.turnWindows,stages);
    for(const stage of stages)if(!Number.isSafeInteger(windows[stage])||windows[stage]<1||windows[stage]>64)projectionError('WINDOW');
    return {stages,windows};
  }
  function project(raw){
    const input=inertRecord(raw,['requestView','stagePolicy']),policy=normalizedPolicy(input.stagePolicy),messages=qualifiedInput(input.requestView);
    const resolved=resolveSgaCurrentTurn(messages),current=messages[resolved.requestIndex];
    if(!current||current.role!=='user'||!nativeTurnMessageId(current)||!resolved.text||resolved.requestEndIndex!==resolved.requestIndex||turnBlockReason(current))projectionError('CURRENT_INPUT_UNAVAILABLE');
    const selected=new Map(),selections=[];
    for(const stage of policy.stages){
      const recent=buildRecentChat(messages,{turnWindow:policy.windows[stage],currentTurnResolution:resolved});
      const turns=recent.turnEligibility?.selected||[];selections.push({stage,turns,view:libNativePromptView(recent)});
      for(const turn of turns)for(const ref of [turn.user,...(turn.assistants||[turn.assistant]),turn.boundary].filter(Boolean)){
        if(!ref.messageId)projectionError('NATIVE_ID_UNAVAILABLE');
        const candidates=messages.filter(message=>nativeTurnMessageId(message)===ref.messageId&&JSON.stringify(nativeTurnRef(message))===JSON.stringify(ref));
        if(candidates.length!==1)projectionError('NATIVE_ID_UNAVAILABLE');
        selected.set(JSON.stringify(ref),{ref,role:currentTurnRole(candidates[0]),content:candidates[0].content});
      }
    }
    return {schema:'gradia.native-read-set.v1',currentInputRef:nativeTurnRef(current),selections,currentInput:current.content,query:resolved.text,turns:[...selected.values()]};
  }
  return Object.freeze({project});
}
