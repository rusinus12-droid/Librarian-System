        const compactOptionalWorldBoolean = (value) => typeof value === 'boolean' ? value : undefined;

        const buildBoundedJsonArray = (items, maxChars, fallbackValue = []) => {
            const list = Array.isArray(items) ? items : [];
            if (list.length === 0) return JSON.stringify(fallbackValue);
            const out = [];
            for (const item of list) {
                out.push(item);
                const serialized = JSON.stringify(out);
                if (serialized.length > maxChars) {
                    out.pop();
                    break;
                }
            }
            if (out.length === 0) {
                return truncateForLLM(JSON.stringify([list[0]]), maxChars);
            }
            return JSON.stringify(out);
        };

        const compactStructuredSnapshot = (data) => ({
            narrative: truncateForLLM(data?.narrative || '', 1200, ' ...[TRUNCATED]... '),
            narrativeDetails: {
                storylines: normalizeNarrativeStorylinesForMerge(data?.narrativeDetails?.storylines, data?.narrative || '')
                    .slice(0, 4)
                    .map(storyline => ({
                        name: truncateForLLM(storyline?.name || '', 100, ' ... '),
                        context: truncateForLLM(storyline?.context || '', 260, ' ...[TRUNCATED]... '),
                        keyPoints: compactTextArray(storyline?.keyPoints, 4, 160),
                        ongoingTensions: compactTextArray(storyline?.ongoingTensions, 4, 160),
                        entities: compactTextArray(storyline?.entities, 5, 80)
                    }))
            },
            entities: (Array.isArray(data?.entities) ? data.entities : [])
                .slice(0, 10)
                .map(entity => {
                    const extension = compactColdStartEntityExtension(entity || {});
                    return {
                        name: truncateForLLM(entity?.name || '', 80, ' ... '),
                        sex: truncateForLLM(entity?.sex || entity?.biologicalSex || '', 16, ' ... '),
                        appearance: truncateForLLM(compactColdStartText(entity?.appearance || '', 260), 260, ' ...[TRUNCATED]... '),
                        personality: truncateForLLM(compactColdStartText(entity?.personality || '', 260), 260, ' ...[TRUNCATED]... '),
                        background: truncateForLLM(compactColdStartText(entity?.background || '', 260), 260, ' ...[TRUNCATED]... '),
                        identity: extension.identity,
                        profile: extension.profile,
                        currentState: extension.currentState,
                        continuity: extension.continuity,
                        povKnowledge: extension.povKnowledge,
                        episodeLedger: extension.episodeLedger,
                        evidence: extension.evidence,
                        quality: extension.quality
                    };
                })
                .filter(entity => entity.name),
            relations: (Array.isArray(data?.relations) ? data.relations : [])
                .slice(0, 12)
                .map(relation => {
                    const extension = compactColdStartRelationExtension(relation || {});
                    return {
                        entityA: truncateForLLM(relation?.entityA || '', 80, ' ... '),
                        entityB: truncateForLLM(relation?.entityB || '', 80, ' ... '),
                        type: truncateForLLM(relation?.type || relation?.relationType || '', 180, ' ...[TRUNCATED]... '),
                        sentiment: truncateForLLM(relation?.sentiment || '', 220, ' ...[TRUNCATED]... '),
                        currentStatus: extension.currentStatus,
                        metrics: extension.metrics,
                        dynamics: extension.dynamics,
                        sharedContext: extension.sharedContext,
                        eventLedger: extension.eventLedger,
                        evidence: extension.evidence,
                        quality: extension.quality
                    };
                })
                .filter(relation => relation.entityA && relation.entityB),
            world: {
                tech: truncateForLLM(data?.world?.tech || '', 120, ' ... '),
                classification: {
                    primary: truncateForLLM(data?.world?.classification?.primary || '', 80, ' ... ')
                },
                exists: {
                    technology: truncateForLLM(data?.world?.exists?.technology || '', 80, ' ... '),
                    magic: compactOptionalWorldBoolean(data?.world?.exists?.magic),
                    ki: compactOptionalWorldBoolean(data?.world?.exists?.ki),
                    supernatural: compactOptionalWorldBoolean(data?.world?.exists?.supernatural)
                },
                systems: {
                    leveling: compactOptionalWorldBoolean(data?.world?.systems?.leveling),
                    skills: compactOptionalWorldBoolean(data?.world?.systems?.skills),
                    stats: compactOptionalWorldBoolean(data?.world?.systems?.stats),
                    classes: compactOptionalWorldBoolean(data?.world?.systems?.classes)
                },
                physics: {
                    gravity: truncateForLLM(data?.world?.physics?.gravity || '', 60, ' ... '),
                    time_flow: truncateForLLM(data?.world?.physics?.time_flow || data?.world?.physics?.timeFlow || '', 60, ' ... '),
                    space: truncateForLLM(data?.world?.physics?.space || '', 80, ' ... ')
                },
                custom: compactTextArray(Object.values(normalizeWorldCustomRules(data?.world?.custom)), 10, 220),
                rules: compactTextArray(data?.world?.rules, 10, 220)
            }
        });

        const buildCompactStructuredJson = (data, maxChars = REVIEW_DATA_MAX_CHARS) => {
            return buildBoundedJsonArray([compactStructuredSnapshot(data)], maxChars, [{}]).replace(/^\[(.*)\]$/s, '$1');
        };


        const COLD_START_MESSAGE_AUDIT_LIMIT = 120;
        const COLD_START_AUX_HINT_LIMIT = 8;
        const parseColdStartTagAttributes = (tag = '') => {
            const attrs = {};
            String(tag || '').replace(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_, key, dq, sq, bare) => {
                attrs[String(key || '').toLowerCase()] = String(dq ?? sq ?? bare ?? '').trim();
                return _;
            });
            return attrs;
        };
        const compactColdStartHintValue = (value, depth = 0) => {
            if (value == null) return '';
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                return truncateForLLM(String(value).replace(/\s+/g, ' ').trim(), 180, ' ... ');
            }
            if (Array.isArray(value)) {
                return value.map(item => compactColdStartHintValue(item, depth + 1)).filter(Boolean).slice(0, 4).join('; ');
            }
            if (typeof value === 'object') {
                const preferred = [
                    'name', 'character', 'characterName', 'entity', 'summary', 'state', 'current_state', 'currentState',
                    'emotion', 'emotional_state', 'location', 'scene', 'relationship', 'status', 'goal', 'intent',
                    'appearance', 'clothing', 'speechStyle', 'speech_style', 'world', 'time'
                ];
                const parts = [];
                for (const key of preferred) {
                    if (!(key in value)) continue;
                    const text = compactColdStartHintValue(value[key], depth + 1);
                    if (text) parts.push(`${key}: ${text}`);
                    if (parts.length >= 6) break;
                }
                if (parts.length > 0 || depth >= 1) return parts.join('; ');
                for (const [key, val] of Object.entries(value).slice(0, 8)) {
                    const text = compactColdStartHintValue(val, depth + 1);
                    if (text) parts.push(`${key}: ${text}`);
                    if (parts.length >= 6) break;
                }
                return parts.join('; ');
            }
            return '';
        };
        const extractColdStartImageCues = (rawText = '') => {
            const cues = [];
            String(rawText || '').replace(/<img\b[^>]*>/gi, (tag) => {
                const attrs = parseColdStartTagAttributes(tag);
                const hasCommand = Object.prototype.hasOwnProperty.call(attrs, 'cmd') || /\bcmd\s*=/i.test(tag);
                if (!hasCommand) return tag;
                const summary = [
                    attrs.cmd ? `cmd: ${attrs.cmd}` : '',
                    attrs.prompt ? `prompt: ${attrs.prompt}` : '',
                    attrs.alt ? `alt: ${attrs.alt}` : '',
                    attrs.title ? `title: ${attrs.title}` : '',
                    attrs.src ? `src: ${attrs.src}` : ''
                ].filter(Boolean).join('; ');
                cues.push({
                    kind: 'image_command',
                    summary: truncateForLLM(summary || tag.replace(/\s+/g, ' ').trim(), 360, ' ... ')
                });
                return tag;
            });
            return cues.slice(0, COLD_START_AUX_HINT_LIMIT);
        };
        const stripColdStartAnalysisArtifacts = (rawText = '') => {
            return String(rawText || '')
                .replace(/<!--[\s\S]{0,240}HAYAKU_[A-Z0-9_]+_START[\s\S]*?HAYAKU_[A-Z0-9_]+_END[\s\S]{0,240}?-->/gi, ' ')
                .replace(/HAYAKU_([A-Z0-9_]+)_START\s*[\s\S]*?\s*HAYAKU_\1_END/gi, ' ')
                .replace(/<img\b[^>]*\bcmd\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        };
        const formatColdStartAuxiliaryHints = (imageCues = []) => {
            const lines = [];
            for (const cue of imageCues) {
                if (!cue?.summary || lines.length >= COLD_START_AUX_HINT_LIMIT) continue;
                lines.push(`- VisualCue: ${cue.summary}`);
            }
            return dedupeTextArray(lines).slice(0, COLD_START_AUX_HINT_LIMIT);
        };
        const normalizeColdStartMessageForAnalysis = (msg, sourceIndex = -1) => {
            const roleHint = getMessageRoleHint(msg);
            const rawText = Utils.getMessageText(msg);
            const imageCues = extractColdStartImageCues(rawText);
            const strippedRaw = stripColdStartAnalysisArtifacts(rawText);
            const narrativeText = Utils.getNarrativeComparableText(strippedRaw, roleHint);
            const auxHintLines = formatColdStartAuxiliaryHints(imageCues);
            const text = [
                narrativeText,
                auxHintLines.length ? '[Auxiliary module hints - lower priority than visible prose]' : '',
                ...auxHintLines
            ].filter(Boolean).join('\n').trim();
            return {
                msg,
                text,
                narrativeText,
                rawText,
                roleHint,
                sourceIndex,
                imageCues,
                auxHintCount: auxHintLines.length,
                rawChars: String(rawText || '').length,
                narrativeChars: String(narrativeText || '').length,
                textChars: String(text || '').length
            };
        };
        const coldStartMessageDigest = (text = '') => {
            const raw = String(text || '');
            const trimmed = raw.trim();
            return {
                chars: raw.length,
                trimmedChars: trimmed.length,
                hash: trimmed ? stableHash(trimmed) : '',
                empty: !trimmed
            };
        };
        const getColdStartMessageSourceCandidates = (chat) => {
            const candidates = [];
            const push = (label, value) => {
                if (!Array.isArray(value)) return;
                const messages = value.filter(item => item != null);
                if (!messages.length) return;
                const rawSignature = messages.slice(0, 3).map(getMessageSignature).join('||') || `${label}:${messages.length}`;
                const signature = stableHash(rawSignature);
                if (candidates.some(item => item.signature === signature)) return;
                const roleCounts = DebugExportManager.countRoles(messages);
                const textChars = messages.reduce((sum, msg) => sum + String(Utils.getMessageText(msg) || '').length, 0);
                const score = messages.length * 1000 + Math.min(textChars, 50000) + Math.min(Number(roleCounts.user || 0), Number(roleCounts.assistant || roleCounts.ai || roleCounts.char || 0)) * 200;
                candidates.push({ label, messages, count: messages.length, textChars, roleCounts, score, signature });
            };
            push('getChatMessages', getChatMessages(chat));
            push('chat.msgs', chat?.msgs);
            push('chat.messages', chat?.messages);
            push('chat.message', chat?.message);
            push('chat.log', chat?.log);
            push('chat.mes', chat?.mes);
            push('chat.chat', chat?.chat);
            push('chat.data.messages', readNested(chat, ['data', 'messages']));
            push('chat.data.message', readNested(chat, ['data', 'message']));
            push('chat.history.messages', readNested(chat, ['history', 'messages']));
            push('chat.history.message', readNested(chat, ['history', 'message']));
            return candidates.sort((a, b) => b.score - a.score || b.count - a.count);
        };
        const resolveColdStartMessageSource = (chat) => {
            const candidates = getColdStartMessageSourceCandidates(chat);
            const selected = candidates[0] || { label: 'none', messages: [], count: 0, textChars: 0, roleCounts: {}, score: 0 };
            return {
                label: selected.label,
                messages: selected.messages || [],
                candidates: candidates.map(item => ({
                    label: item.label,
                    count: item.count,
                    textChars: item.textChars,
                    roleCounts: item.roleCounts,
                    selected: item.label === selected.label
                })).slice(0, 10)
            };
        };
        const snapshotHistoricalSource = chat => {
            const source = resolveColdStartMessageSource(chat);
            const sources = ['msgs','messages','message','log','mes','chat'].map(key=>['chat.'+key,chat?.[key]])
                .concat([['chat.data.messages',readNested(chat,['data','messages'])],['chat.data.message',readNested(chat,['data','message'])],
                    ['chat.history.messages',readNested(chat,['history','messages'])],['chat.history.message',readNested(chat,['history','message'])]]);
            const backing = source.label === 'getChatMessages' ? sources.find(([,value])=>value === getChatMessages(chat))
                : sources.find(([label])=>label === source.label);
            const sourceBackingPath = backing?.[0] || source.label;
            const sourceBytes = JSON.stringify(backing?.[1] || source.messages || []);
            const messages = buildAnalyzableMessages(chat, {sourceMessages:source.messages,sourceInfo:source});
            const messageCount = getChatMessages(chat).length;
            return {sourceLabel:source.label,sourceBackingPath,sourceBytes,
                messageCount,analyzableMessageCount:messages.length,
                estimatedCalls:messageCount > 0 ? Math.max(2,Math.ceil(messageCount/24)+2) : 2};
        };
        const summarizeColdStartFilterAudit = (audit = []) => {
            const items = Array.isArray(audit) ? audit : [];
            const kept = items.filter(item => item.kept).length;
            const dropped = items.length - kept;
            const dropReasons = {};
            let imageCues = 0;
            for (const item of items) {
                if (!item.kept) dropReasons[item.dropReason || 'unknown'] = Number(dropReasons[item.dropReason || 'unknown'] || 0) + 1;
                imageCues += Number(item.imageCues || 0);
            }
            return { total: items.length, kept, dropped, dropReasons, imageCues };
        };
        const buildAnalysisMessageChunks = (msgs, maxChunkMessages = 25) => {
            const source = Array.isArray(msgs) ? msgs : [];
            const chunks = [];
            let current = [];
            let currentChars = 0;

            for (const item of source) {
                if (!item?.msg) continue;
                const role = getMessageRoleHint(item) === 'user' ? 'User' : 'AI';
                const line = `${role}: ${truncateForLLM(item.text || '', ANALYSIS_MAX_LINE_CHARS, ' ...[TRUNCATED]... ')}`;
                if (!line.trim()) continue;

                const delta = line.length + (current.length > 0 ? 2 : 0);
                const wouldOverflow = current.length > 0 && (currentChars + delta > ANALYSIS_MAX_CHUNK_CHARS || current.length >= maxChunkMessages);
                if (wouldOverflow) {
                    chunks.push(current);
                    current = [];
                    currentChars = 0;
                }

                current.push(item);
                currentChars += line.length + (current.length > 1 ? 2 : 0);
            }

            if (current.length > 0) chunks.push(current);
            return chunks;
        };

        const buildAnalysisChunkText = (chunk, options = {}) => {
            const evidenceMode = String(options?.evidenceMode || 'assistant_canonical').trim().toLowerCase();
            const lines = (Array.isArray(chunk) ? chunk : [])
                .filter(item => item?.msg != null)
                .map((item) => {
                    const { msg, text } = item;
                    const roleHint = getMessageRoleHint(item);
                    if (evidenceMode === 'assistant_canonical' && roleHint === 'user') return '';
                    const role = roleHint === 'user' ? 'User Request Metadata' : 'AI';
                    return `${role}: ${truncateForLLM(text, ANALYSIS_MAX_LINE_CHARS, ' ...[TRUNCATED]... ')}`;
                })
                .filter(Boolean);
            if (lines.length === 0) return '';
            return [
                evidenceMode === 'assistant_canonical' ? LIBRA_CANONICAL_ASSISTANT_EVIDENCE_POLICY : '',
                lines.join('\n\n')
            ].filter(Boolean).join('\n\n');
        };

        const buildSynthesisInput = (chunkSummaries) => {
            const compacted = (Array.isArray(chunkSummaries) ? chunkSummaries : []).map(compactChunkSummary);
            return buildBoundedJsonArray(compacted, SYNTHESIS_MAX_INPUT_CHARS, []);
        };
        const buildFallbackChunkSummary = (items = [], label = 'analysis') => {
            const sourceItems = Array.isArray(items) ? items : [];
            const sourceTexts = sourceItems
                .filter(item => getMessageRoleHint(item) !== 'user')
                .map(item => String(item?.text || getComparableMessageText(item?.msg || item) || '').trim())
                .filter(Boolean);
            const combined = sourceTexts.join('\n');
            const events = sourceTexts
                .map(text => truncateForLLM(text, 260, ' ...[TRUNCATED]... '))
                .filter(Boolean)
                .slice(-10);
            return {
                events: events.length ? events : [`${label}: source text preserved for later analysis.`],
                characters: [],
                relationships: [],
                world_rules: combined ? ['Fallback continuity seed: preserve the source conversation text as tentative evidence; do not invent unsupported facts.'] : [],
                memory_seeds: sourceTexts.slice(-8).map((text, index) => ({
                    summary: truncateForLLM(text, 900, ' ...[TRUNCATED]... '),
                    topics: [],
                    evidence: `fallback chunk memory ${index + 1}`
                }))
            };
        };
        const buildStructuredMergeInput = (reports) => {
            const compacted = (Array.isArray(reports) ? reports : []).map(compactStructuredSnapshot);
            return buildBoundedJsonArray(compacted, SYNTHESIS_MAX_INPUT_CHARS, []);
        };
