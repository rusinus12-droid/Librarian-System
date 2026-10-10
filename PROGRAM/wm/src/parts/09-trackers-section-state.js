    // ══════════════════════════════════════════════════════════════
    // [MANAGER] Narrative Tracker
    // ══════════════════════════════════════════════════════════════
    const NarrativeTracker = (() => {
        const NARRATIVE_COMMENT = 'lmai_narrative';
        const SUMMARY_INTERVAL = 5;
        const NARRATIVE_TURN_LOG_LIMIT = 160;
        const NARRATIVE_META_TURN_LOG_LIMIT = 80;

        let narrativeState = {
            storylines: [],
            turnLog: [],
            metaTurnLog: [],
            lastSummaryTurn: 0
        };

        const clipText = (text, max = 180) => {
            const normalized = String(text || '').replace(/\s+/g, ' ').trim();
            if (!normalized) return '';
            if (normalized.length <= max) return normalized;
            const sliced = normalized.slice(0, Math.max(0, max - 1));
            const boundary = Math.max(sliced.lastIndexOf('. '), sliced.lastIndexOf('! '), sliced.lastIndexOf('? '), sliced.lastIndexOf(', '), sliced.lastIndexOf(' '));
            const compact = (boundary >= Math.max(24, Math.floor(max * 0.45)) ? sliced.slice(0, boundary) : sliced).trim();
            return `${compact}…`;
        };

        const normalizeNarrativeDedupeKey = (value = '') => {
            const normalized = normalizeKnowledgeText(value)
                || String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
            return normalized
                .replace(/["'“”‘’()[\]{}<>]/g, '')
                .replace(/[.,!?…:;|/\\_-]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 160);
        };

        const narrativeTextSimilar = (a = '', b = '') => {
            const ak = normalizeNarrativeDedupeKey(a);
            const bk = normalizeNarrativeDedupeKey(b);
            if (!ak || !bk) return false;
            if (ak === bk) return true;
            if (Math.min(ak.length, bk.length) >= 28 && (ak.includes(bk) || bk.includes(ak))) return true;
            const at = new Set(ak.split(/\s+/).filter(part => part.length >= 2));
            const bt = new Set(bk.split(/\s+/).filter(part => part.length >= 2));
            const base = Math.min(at.size, bt.size);
            if (base < 3) return false;
            let shared = 0;
            for (const token of at) if (bt.has(token)) shared++;
            return shared / base >= 0.72;
        };

        const pushNarrativeUniqueLimited = (current = [], incoming = [], limit = 12, options = {}) => {
            const maxChars = Math.max(40, Number(options?.maxChars || 160));
            const exclusions = (Array.isArray(options?.exclude) ? options.exclude : [])
                .map(item => clipText(item, maxChars))
                .filter(Boolean);
            const out = [];
            for (const item of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
                const text = clipText(item, maxChars);
                if (!text) continue;
                if (exclusions.some(exclude => narrativeTextSimilar(text, exclude))) continue;
                if (out.some(existing => narrativeTextSimilar(existing, text))) continue;
                out.push(text);
            }
            return out.slice(-Math.max(1, Number(limit || 12)));
        };

        const normalizeNarrativeStringArray = (value, limit = 8, maxChars = 160) => (
            pushNarrativeUniqueLimited(
                [],
                (Array.isArray(value) ? value : (value ? [value] : []))
                    .map(item => typeof item === 'string' ? item : item?.label || item?.text || item?.status || '')
                    .filter(Boolean),
                limit,
                { maxChars }
            )
        );

        const dedupeNarrativeRecentEvents = (events = [], limit = 10) => {
            const seen = new Set();
            const out = [];
            for (const event of Array.isArray(events) ? events : []) {
                const rawTurn = Number(event?.turn || 0);
                const turn = Number.isFinite(rawTurn) && rawTurn > 0 ? rawTurn : (event?.turn || '?');
                const brief = clipText(event?.brief || event?.summary || event?.text || '', 220);
                if (!brief) continue;
                const arcKey = String(event?.arcKey || '').trim();
                const key = `${turn}|${normalizeNarrativeDedupeKey(brief)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ ...event, turn, brief, arcKey });
            }
            return out.slice(-Math.max(1, Number(limit || 10) || 10));
        };

        const normalizeNarrativeEntityKey = (value = '') => {
            const raw = String(value || '').normalize('NFKC').toLowerCase().trim();
            if (!raw) return '';
            const compact = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
            const squashed = raw.replace(/[^a-z0-9\u3131-\u318e\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9fff]+/g, '');
            return squashed || compact;
        };

        const narrativeEntityKeySet = (value = '') => {
            const raw = String(value || '').normalize('NFKC').trim();
            const candidates = new Set([raw]);
            const parens = [...raw.matchAll(/\(([^)]{1,60})\)/g)].map(match => match[1]);
            parens.forEach(part => candidates.add(part));
            candidates.add(raw.replace(/\([^)]*\)/g, ' '));
            raw.split(/[\/|,，;；]+/).forEach(part => candidates.add(part));
            const keys = new Set();
            for (const candidate of candidates) {
                const key = normalizeNarrativeEntityKey(candidate);
                if (key) keys.add(key);
            }
            return keys;
        };

        const narrativeEntitiesOverlapScore = (left = [], right = []) => {
            const leftKeys = new Set((Array.isArray(left) ? left : []).flatMap(item => [...narrativeEntityKeySet(item)]));
            const rightKeys = new Set((Array.isArray(right) ? right : []).flatMap(item => [...narrativeEntityKeySet(item)]));
            if (!leftKeys.size || !rightKeys.size) return 0;
            let overlap = 0;
            for (const key of leftKeys) if (rightKeys.has(key)) overlap++;
            return overlap / Math.max(1, Math.min(leftKeys.size, rightKeys.size));
        };

        const isGenericNarrativeStorylineName = (value = '') => /^Storyline #\d+$/i.test(String(value || '').trim());

        const isGenericNarrativeArcKey = (key = '') => {
            const value = String(key || '').trim();
            if (!value) return true;
            if (/^storyline_\d+$/i.test(value)) return true;
            if (/^(?:main|current|default|general|unknown|misc|기본|현재|일반|미정)$/i.test(value)) return true;
            return false;
        };

        const isConcreteNarrativeArcKey = (key = '') => !isGenericNarrativeArcKey(key);

        const narrativeArcKeysCompatible = (left = '', right = '') => {
            const leftArc = String(left || '').trim();
            const rightArc = String(right || '').trim();
            if (isConcreteNarrativeArcKey(leftArc) && isConcreteNarrativeArcKey(rightArc)) {
                return leftArc === rightArc;
            }
            return true;
        };

        const narrativeStorylineNameFromArcKey = (arcKey = '', fallback = '') => {
            const value = String(arcKey || '').trim();
            if (!value) return String(fallback || '').trim();
            return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        };

        const pushNarrativeEntity = (entities = [], entity = '') => {
            const text = String(entity || '').trim();
            if (!text) return entities;
            const next = Array.isArray(entities) ? [...entities] : [];
            const incomingKeys = narrativeEntityKeySet(text);
            const hasAlias = next.some(existing => {
                const existingKeys = narrativeEntityKeySet(existing);
                for (const key of incomingKeys) if (existingKeys.has(key)) return true;
                return false;
            });
            if (!hasAlias) next.push(text);
            return next;
        };

        const isNarrativeStatusOrControlLine = (line = '') => {
            const text = String(line || '').trim();
            if (!text) return true;
            if (/^#{1,6}\s+/.test(text)) return true;
            if (/^(?:volume|chapter)\b/i.test(text)) return true;
            if (/^chatindex\s*:/i.test(text)) return true;
            if (/^⏱️?\s*\[/.test(text)) return true;
            if (/^\[\s*(?:response|응답|assistant|character)\s*\]$/i.test(text)) return true;
            if (/^[-=_*]{3,}$/.test(text)) return true;
            if (/^```/.test(text)) return true;
            if (/^<!--/.test(text)) return true;
            if (/^<\s*\/?\s*(?:GigaTrans|HAYAKU|GT-|img\b)/i.test(text)) return true;
            if (/^\[[^\]]*(?:HAYAKU|GigaTrans|VN|Feedback|Translate)[^\]]*\]/i.test(text)) return true;
            if (/^★\s*📍/.test(text)) return true;
            if (/^🚪\s*name\s*:/i.test(text)) return true;
            if (/^§\s*[^§]{0,100}\s*§$/.test(text)) return true;
            return false;
        };

        const cleanNarrativeText = (text) => {
            const raw = Utils.getNarrativeSourceText(text, 'ai') || Utils.getMemorySourceText(text) || String(text || '');
            if (!raw) return '';
            const cleanedLines = raw
                .replace(/\r/g, '')
                .split('\n')
                .map(line => line.trim())
                .filter(line => !isNarrativeStatusOrControlLine(line));
            return cleanedLines.join('\n').trim();
        };

        const extractNarrativeParagraph = (text) => {
            const cleaned = cleanNarrativeText(text);
            if (!cleaned) return '';
            const paragraphs = cleaned
                .split(/\n{2,}/)
                .map(part => part.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
            const meaningful = paragraphs.find(part => (part.match(/[A-Za-z0-9\u3131-\u318E\uAC00-\uD7A3\u3040-\u30FF\u4E00-\u9FFF]/g) || []).length >= 12);
            return meaningful || paragraphs[0] || '';
        };

        const splitNarrativeSentences = (text) => {
            const normalized = String(text || '').replace(/\r/g, '\n').trim();
            if (!normalized) return [];
            return normalized
                .split(/\n+/)
                .flatMap(part => part.match(/[^.!?。！？…\n]+(?:[.!?。！？…]+|$)/g) || [part])
                .map(part => part.replace(/\s+/g, ' ').trim())
                .filter(part => part && !isNarrativeStatusOrControlLine(part));
        };

        const scoreNarrativeContinuitySentence = (sentence = '') => {
            const text = String(sentence || '').trim();
            if (!text || isNarrativeStatusOrControlLine(text)) return -20;
            let score = 0;
            const bump = (pattern, value) => { if (pattern.test(text)) score += value; };
            bump(/결심|선택|대답|거절|수락|확인|숨기|말해야|요청|안내|설명|약속|합의/, 4);
            bump(/말했|물었|답했|도착|나섰|들어|바라보|웃|침묵|멈추|발견|이동|따라|열었|닫았|돌아/, 3);
            bump(/갈등|긴장|오해|폭로|위기|문제|단서|비밀|규칙|목표|계획|변화|전환|관계|감정/, 2);
            if (text.length < 14) score -= 4;
            if (text.length > 260) score -= 2;
            if (/^[“"']/.test(text)) score += 1;
            return score;
        };

        const extractNarrativeSceneLocation = (raw = '', cleaned = '') => {
            const text = `${raw || ''}\n${cleaned || ''}`;
            const status = text.match(/★\s*📍\s*([^§\n]{2,90})/);
            if (status?.[1]) return { current: clipText(status[1], 90), source: 'status' };
            return { current: '', source: '' };
        };

        const extractNarrativeTemporalState = (raw = '') => {
            const text = String(raw || '');
            const labels = [];
            const bracket = text.match(/⏱️?\s*\[([^\]]{1,120})\]/);
            if (bracket?.[1]) labels.push(bracket[1]);
            for (const match of text.matchAll(/§\s*([^§]{1,120}?(?:\d{1,2}:\d{2}|오전|오후|AM|PM)[^§]{0,80})\s*§/gi)) {
                labels.push(match[1]);
            }
            const storyLabel = text.match(/(\d{1,6}년\s*\d{1,2}월\s*\d{1,2}일(?:\s*\([^)]{1,12}\))?(?:\s*(?:오전|오후)\s*\d{1,2}(?::|시\s*)?\d{0,2}(?:분)?|\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?|\s*)?)/i);
            if (storyLabel?.[1]) labels.push(storyLabel[1]);
            const numericLabel = text.match(/\b(\d{1,6}[-./]\d{1,2}[-./]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?)\b/i);
            if (numericLabel?.[1]) labels.push(numericLabel[1]);
            const label = clipText(labels.find(Boolean) || '', 100);
            const dateMatch = text.match(/\b(\d{1,6}[-./]\d{1,2}[-./]\d{1,2})\b/) || text.match(/\b(\d{1,6}년\s*\d{1,2}월\s*\d{1,2}일)\b/);
            let time = '';
            const timeSource = label || text;
            const krTime = timeSource.match(/(오전|오후)\s*(\d{1,2})(?::|시\s*)?(\d{2})?/);
            if (krTime) {
                let hour = Number(krTime[2] || 0);
                const minute = Number(krTime[3] || 0);
                if (krTime[1] === '오후' && hour < 12) hour += 12;
                if (krTime[1] === '오전' && hour === 12) hour = 0;
                time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
            }
            if (!time) {
                const hhmm = timeSource.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s*(AM|PM)?\b/i);
                if (hhmm?.[4]) {
                    let hour = Number(hhmm[1]);
                    if (/PM/i.test(hhmm[4]) && hour < 12) hour += 12;
                    if (/AM/i.test(hhmm[4]) && hour === 12) hour = 0;
                    time = `${String(hour).padStart(2, '0')}:${hhmm[2]}:${hhmm[3] || '00'}`;
                } else if (hhmm) {
                    time = `${String(Number(hhmm[1])).padStart(2, '0')}:${hhmm[2]}${hhmm[3] ? `:${hhmm[3]}` : ''}`;
                }
            }
            return {
                label,
                date: dateMatch?.[1]
                    ? dateMatch[1].replace(/[./]/g, '-').replace(/(\d{1,6})년\s*(\d{1,2})월\s*(\d{1,2})일/, (_, y, m, d) => `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`)
                    : '',
                time
            };
        };

        const normalizeNarrativeThread = (thread, fallbackTurn = 0) => {
            const isObject = thread && typeof thread === 'object' && !Array.isArray(thread);
            const label = clipText(isObject ? (thread.label || thread.name || thread.text || '') : thread, 120);
            if (!label) return null;
            const id = String(isObject ? (thread.id || thread.key || '') : '').trim()
                || `thread.${normalizeNarrativeDedupeKey(label).replace(/\s+/g, '_').slice(0, 48) || stableHash(label)}`;
            const sourceTurns = Array.from(new Set(
                (Array.isArray(thread?.sourceTurns) ? thread.sourceTurns : [thread?.turn, fallbackTurn])
                    .map(turn => Number(turn || 0))
                    .filter(Number.isFinite)
                    .filter(turn => turn > 0)
            )).slice(-8);
            const evidenceTurns = normalizeNarrativeStringArray(thread?.evidenceTurns || (fallbackTurn > 0 ? [`T${fallbackTurn}`] : []), 8, 40);
            const memoryRefs = normalizeNarrativeStringArray(thread?.memoryRefs || [], 8, 80);
            return {
                id,
                label,
                status: clipText(isObject ? (thread.status || thread.state || '') : '', 140),
                sourceTurns,
                evidenceTurns,
                memoryRefs,
                lastUpdatedTurn: Number(thread?.lastUpdatedTurn || sourceTurns[sourceTurns.length - 1] || fallbackTurn || 0)
            };
        };

        const mergeNarrativeThreads = (current = [], incoming = [], limit = 8) => {
            const map = new Map();
            const add = (thread) => {
                const normalized = normalizeNarrativeThread(thread);
                if (!normalized) return;
                const key = normalized.id || normalizeNarrativeDedupeKey(normalized.label);
                const existing = map.get(key);
                if (!existing) {
                    map.set(key, normalized);
                    return;
                }
                existing.label = existing.label || normalized.label;
                if (normalized.status && !narrativeTextSimilar(existing.status, normalized.status)) existing.status = normalized.status;
                existing.sourceTurns = Array.from(new Set([...(existing.sourceTurns || []), ...(normalized.sourceTurns || [])])).sort((a, b) => a - b).slice(-8);
                existing.evidenceTurns = pushNarrativeUniqueLimited(existing.evidenceTurns, normalized.evidenceTurns, 8, { maxChars: 40 });
                existing.memoryRefs = pushNarrativeUniqueLimited(existing.memoryRefs, normalized.memoryRefs, 8, { maxChars: 80 });
                existing.lastUpdatedTurn = Math.max(Number(existing.lastUpdatedTurn || 0), Number(normalized.lastUpdatedTurn || 0));
            };
            [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])].forEach(add);
            return Array.from(map.values())
                .sort((a, b) => Number(a.lastUpdatedTurn || 0) - Number(b.lastUpdatedTurn || 0))
                .slice(-Math.max(1, Number(limit || 8)));
        };

        const narrativeThreadOverlapScore = (left = [], right = []) => {
            const toKeys = (items = []) => new Set((Array.isArray(items) ? items : [])
                .map(item => normalizeNarrativeThread(item))
                .filter(Boolean)
                .flatMap(item => [item.id, normalizeNarrativeDedupeKey(item.label)].filter(Boolean)));
            const leftKeys = toKeys(left);
            const rightKeys = toKeys(right);
            if (!leftKeys.size || !rightKeys.size) return 0;
            let overlap = 0;
            for (const key of leftKeys) if (rightKeys.has(key)) overlap++;
            return overlap / Math.max(1, Math.min(leftKeys.size, rightKeys.size));
        };

        const extractNarrativeSignals = (userMsg, aiResponse, options = {}) => {
            const raw = Utils.getNarrativeSourceText(aiResponse, 'ai') || Utils.getMemorySourceText(aiResponse) || String(aiResponse || '');
            const cleaned = cleanNarrativeText(aiResponse);
            const normalizedUser = '';
            const turn = Number(options?.turn || 0);
            const sourceMessageIds = normalizeCanonicalMessageIds(options?.sourceMessageIds || []);
            const memoryRefs = pushNarrativeUniqueLimited(
                [],
                [
                    turn > 0 ? `turn:${turn}` : '',
                    ...sourceMessageIds.map(id => `msg:${id}`)
                ],
                8,
                { maxChars: 80 }
            );
            const evidenceTurns = turn > 0 ? [`T${turn}`] : [];
            const sentences = splitNarrativeSentences(cleaned);
            const scored = sentences
                .map((text, index) => ({ text, index, score: scoreNarrativeContinuitySentence(text) }))
                .sort((a, b) => (b.score - a.score) || (a.index - b.index));
            const locationState = extractNarrativeSceneLocation(raw, cleaned);
            const temporalState = extractNarrativeTemporalState(raw);
            const activeThreads = [];
            const unresolvedQuestions = [];
            const nextBeatHints = [];
            const relationPressure = [];
            const threadUpdates = [];
            const ongoingTensions = [];
            const topSentence = clipText(scored.find(item => item.score > 0)?.text || sentences[0] || '', 180);
            const responseBrief = clipText(topSentence || normalizedUser, 180);

            const distinctEvents = pushNarrativeUniqueLimited(
                [],
                [topSentence || responseBrief],
                6,
                { maxChars: 180 }
            );
            const stateChanges = pushNarrativeUniqueLimited(
                [],
                [
                    locationState.current ? `장소 축: ${locationState.current}` : '',
                    temporalState.label || temporalState.time ? `시간 축: ${temporalState.label || temporalState.time}` : '',
                    activeThreads.length ? `진행 스레드: ${activeThreads.map(thread => thread.label).join(', ')}` : ''
                ],
                4,
                { maxChars: 160 }
            );
            const keyPoints = pushNarrativeUniqueLimited([], [...stateChanges, ...distinctEvents], 8, { maxChars: 150 });
            const continuityBrief = clipText(pushNarrativeUniqueLimited(
                [],
                [
                    locationState.current ? `장소: ${locationState.current}` : '',
                    temporalState.label || temporalState.time ? `시각: ${temporalState.label || temporalState.time}` : '',
                    responseBrief
                ],
                5,
                { maxChars: 160 }
            ).join(' | ') || responseBrief, 240);
            const dedupeKeys = Array.from(new Set(
                [responseBrief, continuityBrief, ...threadUpdates, ...distinctEvents]
                    .map(normalizeNarrativeDedupeKey)
                    .filter(Boolean)
            )).slice(0, 10);

            return {
                responseBrief,
                continuityBrief,
                lastDistinctEvent: clipText(distinctEvents[0] || responseBrief, 180),
                distinctEvents,
                stateChanges,
                threadUpdates,
                relationUpdates: relationPressure,
                nextBeat: nextBeatHints[0] || '',
                activeThreads: mergeNarrativeThreads([], activeThreads, 8),
                unresolvedQuestions: pushNarrativeUniqueLimited([], unresolvedQuestions, 6, { maxChars: 140 }),
                nextBeatHints: pushNarrativeUniqueLimited([], nextBeatHints, 6, { maxChars: 140 }),
                relationPressure: pushNarrativeUniqueLimited([], relationPressure, 6, { maxChars: 140 }),
                locationState,
                temporalState,
                keyPoints,
                ongoingTensions,
                memoryRefs,
                evidenceTurns,
                dedupeKeys
            };
        };

        const buildHeuristicTurnBrief = (userMsg, aiResponse) => {
            const signals = extractNarrativeSignals('', aiResponse);
            if (signals.responseBrief) return signals.responseBrief;
            const paragraph = extractNarrativeParagraph(aiResponse);
            if (!paragraph) return '';

            const sentences = paragraph.match(/[^.!?…\n]+(?:[.!?…]+|$)/g) || [paragraph];
            const picked = [];
            let totalLength = 0;
            for (const sentence of sentences) {
                const compact = sentence.replace(/\s+/g, ' ').trim();
                if (!compact) continue;
                if (picked.length >= 2) break;
                if (picked.length > 0 && totalLength + compact.length > 180) break;
                picked.push(compact);
                totalLength += compact.length;
            }

            const summary = clipText((picked.join(' ') || paragraph).replace(/^["'“”‘’]+|["'“”‘’]+$/g, ''), 180);
            if (summary) return summary;
            return '';
        };

        const generateTurnBrief = async (userMsg, aiResponse) => buildHeuristicTurnBrief(userMsg, aiResponse);

        const deriveKeyPointsFromBrief = (brief, maxItems = 3) => {
            const normalized = String(brief || '').replace(/\s+/g, ' ').trim();
            if (!normalized) return [];
            const parts = splitNarrativeSentences(normalized.replace(/\s+\/\s+/g, '\n').replace(/\s+\|\s+/g, '\n'))
                .map(part => clipText(part, 110))
                .filter(part => part.length >= 12 && !/^[\u3131-\u318e\uac00-\ud7a3]{1,6}$/.test(part));
            return pushNarrativeUniqueLimited([], parts.length ? parts : [normalized], maxItems, { maxChars: 110 });
        };

        const deriveOngoingTensionsFromTurn = (turnEntry, maxItems = 3) => {
            const candidates = [];
            if (Array.isArray(turnEntry?.activeThreads)) {
                for (const thread of turnEntry.activeThreads) {
                    const normalized = normalizeNarrativeThread(thread, turnEntry?.turn || 0);
                    if (normalized?.label) candidates.push(`${normalized.label}: ${normalized.status || 'open'}`);
                }
            }
            candidates.push(...normalizeNarrativeStringArray(turnEntry?.unresolvedQuestions, 4, 140));
            candidates.push(...normalizeNarrativeStringArray(turnEntry?.relationPressure, 4, 140));
            candidates.push(...normalizeNarrativeStringArray(turnEntry?.nextBeatHints, 3, 140).map(item => `Next: ${item}`));
            return pushNarrativeUniqueLimited([], candidates, maxItems, { maxChars: 140 });
        };

        const normalizeNarrativeArcLabel = (value = '') => clipText(String(value || '').replace(/\s+/g, ' ').trim(), 60);

        // 서사 식별자로 쓸 수 없는 값 — 문장/서술문/조사 미제거형.
        // arcKey 는 짧은 식별자여야 한다. 문장이 들어오면 storyline 의 arcKey 와
        // 이름이 문장 전체로 오염되고, 이후 매칭·병합이 전부 어긋난다.
        // 실측: arcKey = '아리엘은_는_초기_조사와_관련된_직접_증거를_확인하고_루멘_아카데미의_금지_규칙이_아직_유효하다고_설명했다'
        const isUnusableNarrativeArcLabel = (value = '') => {
            const v = String(value || '').trim();
            if (!v) return true;
            if (v.length > 60) return true;
            if (/[.!?。！？]/.test(v)) return true;
            if (/(?:은|는|이|가|을|를|했다|한다|있었다|입니다|합니다|드러났다|설명했다|확인했다)(?:\s|$)/.test(v)) return true;
            if (v.split(/\s+/).length > 6) return true;
            return false;
        };
        const makeNarrativeArcKey = (value = '') => {
            const label = normalizeNarrativeArcLabel(value);
            if (!label) return '';
            if (isUnusableNarrativeArcLabel(label)) return '';
            return label
                .normalize('NFKC')
                .toLowerCase()
                .replace(/[\u0000-\u001f]+/g, ' ')
                .replace(/[^a-z0-9\u3131-\u318e\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9fff]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 80) || `arc_${stableHash(label)}`;
        };

        const buildNarrativeArcPatch = (turnEntry = {}, updates = {}) => {
            const storyAuthor = updates?.storyAuthor && typeof updates.storyAuthor === 'object' ? updates.storyAuthor : {};
            const explicitName = normalizeNarrativeArcLabel(
                updates.storylineName
                || updates.currentArc
                || storyAuthor.currentArc
                || updates.name
                || ''
            );
            const explicitKey = String(updates.arcKey || '').trim();
            const narrativeGoal = clipText(updates.narrativeGoal || storyAuthor.narrativeGoal || '', 220);
            const name = explicitName;
            const key = explicitKey || makeNarrativeArcKey(name);
            const threadTexts = Array.isArray(turnEntry?.activeThreads)
                ? turnEntry.activeThreads.map(thread => {
                    const normalized = normalizeNarrativeThread(thread, turnEntry?.turn || 0);
                    return normalized ? `${normalized.label}: ${normalized.status}` : '';
                }).filter(Boolean)
                : [];
            const activeTensions = dedupeTextArray([
                ...(Array.isArray(updates.ongoingTensions) ? updates.ongoingTensions : []),
                ...(Array.isArray(storyAuthor.activeTensions) ? storyAuthor.activeTensions : []),
                ...(Array.isArray(turnEntry?.ongoingTensions) ? turnEntry.ongoingTensions : []),
                ...threadTexts,
                ...(Array.isArray(turnEntry?.unresolvedQuestions) ? turnEntry.unresolvedQuestions : []),
                ...(Array.isArray(turnEntry?.relationPressure) ? turnEntry.relationPressure : []),
                ...(narrativeGoal ? [narrativeGoal] : [])
            ]).map(item => clipText(item, 150)).filter(Boolean).slice(0, 6);
            const keyPoints = dedupeTextArray([
                ...(Array.isArray(updates.keyPoints) ? updates.keyPoints : []),
                ...(Array.isArray(storyAuthor.nextBeats) ? storyAuthor.nextBeats : []),
                ...(Array.isArray(storyAuthor.recentDecisions) ? storyAuthor.recentDecisions : []),
                ...(Array.isArray(turnEntry?.distinctEvents) ? turnEntry.distinctEvents : []),
                ...(Array.isArray(turnEntry?.stateChanges) ? turnEntry.stateChanges : []),
                ...(Array.isArray(turnEntry?.nextBeatHints) ? turnEntry.nextBeatHints : []),
                ...deriveKeyPointsFromBrief(updates.summary || turnEntry?.summary || turnEntry?.response || '')
            ]).map(item => clipText(item, 120)).filter(Boolean).slice(0, 8);
            return {
                arcKey: key,
                name,
                phase: clipText(updates.phase || storyAuthor.scenePhase || '', 80),
                primaryConflict: narrativeGoal || activeTensions[0] || '',
                keyPoints,
                ongoingTensions: activeTensions,
                confidence: Math.max(Number(updates.arcConfidence || 0), key ? 0.65 : 0)
            };
        };

        const pushUniqueLimited = (current = [], incoming = [], limit = 12) => {
            return pushNarrativeUniqueLimited(current, incoming, limit, { maxChars: 160 });
        };

        const removeTurnFromStorylines = (turn) => {
            const targetTurn = Number(turn || 0);
            if (!targetTurn) return;
            narrativeState.storylines = (Array.isArray(narrativeState.storylines) ? narrativeState.storylines : []).map(storyline => {
                storyline.turns = Array.isArray(storyline.turns)
                    ? storyline.turns.filter(item => Number(item || 0) !== targetTurn)
                    : [];
                storyline.recentEvents = Array.isArray(storyline.recentEvents)
                    ? storyline.recentEvents.filter(item => Number(item?.turn || 0) !== targetTurn)
                    : [];
                storyline.firstTurn = storyline.turns.length ? Math.min(...storyline.turns.map(Number).filter(Number.isFinite)) : 0;
                storyline.lastTurn = storyline.turns.length ? Math.max(...storyline.turns.map(Number).filter(Number.isFinite)) : 0;
                return storyline;
            }).filter(storyline => Array.isArray(storyline.turns) && storyline.turns.length > 0);
        };

        const refreshNarrativeStorylineBounds = (storyline = {}) => {
            const turns = Array.isArray(storyline.turns)
                ? Array.from(new Set(storyline.turns.map(turn => normalizeLegacyMemoryTurnAnchor(turn)).filter(Boolean))).sort((a, b) => a - b)
                : [];
            storyline.turns = turns;
            storyline.firstTurn = turns.length ? turns[0] : 0;
            storyline.lastTurn = turns.length ? turns[turns.length - 1] : 0;
            if (Array.isArray(storyline.recentEvents) && storyline.recentEvents.length) {
                const lastEvent = storyline.recentEvents[storyline.recentEvents.length - 1];
                if (!storyline.lastDistinctEvent && lastEvent?.brief) storyline.lastDistinctEvent = clipText(lastEvent.brief, 220);
                if (!storyline.currentContext && lastEvent?.brief) storyline.currentContext = clipText(lastEvent.brief, 260);
                if (!storyline.continuityBrief && lastEvent?.brief) storyline.continuityBrief = clipText(lastEvent.brief, 260);
            }
            return storyline;
        };

        const splitMixedArcStorylines = (state = {}) => {
            const storylines = Array.isArray(state.storylines) ? state.storylines : [];
            if (!storylines.length) return state;
            const turnMap = new Map((Array.isArray(state.turnLog) ? state.turnLog : []).map(entry => [Number(entry?.turn || 0), entry]));
            const nextStorylines = [];

            for (const storyline of storylines) {
                if (!storyline || typeof storyline !== 'object') continue;
                if (storyline?.meta?.manualLocked === true) {
                    nextStorylines.push(storyline);
                    continue;
                }
                const baseArc = String(storyline.arcKey || '').trim();
                const recentEvents = Array.isArray(storyline.recentEvents) ? storyline.recentEvents : [];
                const buckets = new Map();

                for (const event of recentEvents) {
                    const eventArc = String(event?.arcKey || '').trim();
                    if (!isConcreteNarrativeArcKey(eventArc)) continue;
                    if (narrativeArcKeysCompatible(baseArc, eventArc) && baseArc === eventArc) continue;
                    if (isConcreteNarrativeArcKey(baseArc) && !narrativeArcKeysCompatible(baseArc, eventArc)) {
                        if (!buckets.has(eventArc)) buckets.set(eventArc, []);
                        buckets.get(eventArc).push(event);
                    } else if (!isConcreteNarrativeArcKey(baseArc)) {
                        if (!buckets.has(eventArc)) buckets.set(eventArc, []);
                        buckets.get(eventArc).push(event);
                    }
                }

                if (!buckets.size) {
                    nextStorylines.push(storyline);
                    continue;
                }

                const parent = safeClone(storyline);
                const splitTurnsAll = new Set();

                for (const [arcKey, events] of buckets.entries()) {
                    const splitTurns = new Set(events.map(event => normalizeLegacyMemoryTurnAnchor(event?.turn || 0)).filter(Boolean));
                    for (const turn of splitTurns) splitTurnsAll.add(turn);
                    const turnEntries = Array.from(splitTurns).map(turn => turnMap.get(turn)).filter(Boolean);
                    const splitEntities = Array.from(new Set(turnEntries
                        .flatMap(entry => Array.isArray(entry?.involvedEntities) ? entry.involvedEntities : [])
                        .map(String)
                        .filter(Boolean)));
                    const splitSummaries = (Array.isArray(storyline.summaries) ? storyline.summaries : []).filter(summary => {
                        const summaryArc = String(summary?.arcKey || '').trim();
                        const upToTurn = normalizeLegacyMemoryTurnAnchor(summary?.upToTurn || 0);
                        if (summaryArc && summaryArc === arcKey) return true;
                        if (upToTurn && splitTurns.has(upToTurn)) return true;
                        return Array.isArray(summary?.evidenceTurns)
                            && summary.evidenceTurns.some(item => {
                                const match = String(item || '').match(/\bT\s*(\d+)\b/i);
                                return match && splitTurns.has(normalizeLegacyMemoryTurnAnchor(match[1]));
                            });
                    });
                    const sortedTurns = Array.from(splitTurns).sort((a, b) => a - b);
                    const splitStoryline = refreshNarrativeStorylineBounds({
                        ...safeClone(storyline),
                        id: 0,
                        name: narrativeStorylineNameFromArcKey(arcKey, storyline.name),
                        arcKey,
                        entities: splitEntities.length ? splitEntities : safeClone(storyline.entities || []),
                        turns: sortedTurns,
                        recentEvents: dedupeNarrativeRecentEvents(events.map(event => ({
                            ...event,
                            arcKey,
                            brief: clipText(event?.brief || '', 220)
                        })), 10),
                        summaries: splitSummaries,
                        currentContext: events[events.length - 1]?.brief || '',
                        continuityBrief: events[events.length - 1]?.brief || '',
                        lastDistinctEvent: events[events.length - 1]?.brief || '',
                        meta: {
                            ...(storyline.meta || {}),
                            repairedFromStorylineId: storyline.id,
                            repairReason: 'mixed_arc_split'
                        }
                    });
                    nextStorylines.push(splitStoryline);
                }

                parent.turns = (Array.isArray(parent.turns) ? parent.turns : [])
                    .map(turn => normalizeLegacyMemoryTurnAnchor(turn))
                    .filter(turn => turn && !splitTurnsAll.has(turn));
                parent.recentEvents = (Array.isArray(parent.recentEvents) ? parent.recentEvents : [])
                    .filter(event => !splitTurnsAll.has(normalizeLegacyMemoryTurnAnchor(event?.turn || 0)));
                parent.summaries = (Array.isArray(parent.summaries) ? parent.summaries : []).filter(summary => {
                    const summaryArc = String(summary?.arcKey || '').trim();
                    const upToTurn = normalizeLegacyMemoryTurnAnchor(summary?.upToTurn || 0);
                    if (summaryArc && buckets.has(summaryArc)) return false;
                    return !(upToTurn && splitTurnsAll.has(upToTurn));
                });
                refreshNarrativeStorylineBounds(parent);
                if ((Array.isArray(parent.turns) && parent.turns.length > 0)
                    || String(parent.currentContext || '').trim()
                    || (Array.isArray(parent.keyPoints) && parent.keyPoints.length > 0)
                    || (Array.isArray(parent.ongoingTensions) && parent.ongoingTensions.length > 0)) {
                    nextStorylines.push(parent);
                }
            }

            state.storylines = nextStorylines.map((storyline, index) => ({
                ...storyline,
                id: Number(storyline.id || index + 1)
            }));
            return state;
        };

        const applyLiveNarrativeSnapshot = (storyline, turnEntry) => {
            if (!storyline || !turnEntry) return;
            const brief = clipText(turnEntry.continuityBrief || turnEntry.summary || turnEntry.response || '', 240);
            if (!brief) return;
            const lastDistinctEvent = clipText(turnEntry.lastDistinctEvent || turnEntry.responseBrief || turnEntry.summary || brief, 220);

            const arcPatch = turnEntry.narrativeArc && typeof turnEntry.narrativeArc === 'object'
                ? turnEntry.narrativeArc
                : buildNarrativeArcPatch(turnEntry, {});
            if (arcPatch?.arcKey && !storyline.arcKey) storyline.arcKey = arcPatch.arcKey;
            if (arcPatch?.name && (!storyline.name || /^Storyline #\d+$/i.test(String(storyline.name || '')))) storyline.name = arcPatch.name;
            if (arcPatch?.phase) storyline.phase = arcPatch.phase;
            if (arcPatch?.primaryConflict) storyline.primaryConflict = arcPatch.primaryConflict;

            storyline.currentContext = brief;
            storyline.continuityBrief = brief;
            storyline.lastDistinctEvent = lastDistinctEvent;
            if (turnEntry.sceneDate) storyline.lastSceneDate = turnEntry.sceneDate;
            if (turnEntry.sceneTime) storyline.lastSceneTime = turnEntry.sceneTime;
            if (turnEntry.sceneTimeLabel) storyline.lastSceneTimeLabel = turnEntry.sceneTimeLabel;
            if (turnEntry.sceneLocation || turnEntry.locationState?.current) {
                storyline.sceneLocation = clipText(turnEntry.sceneLocation || turnEntry.locationState?.current || '', 100);
            }
            if (turnEntry.locationState && typeof turnEntry.locationState === 'object') storyline.locationState = safeClone(turnEntry.locationState);
            if (turnEntry.temporalState && typeof turnEntry.temporalState === 'object') storyline.temporalState = safeClone(turnEntry.temporalState);
            storyline.activeThreads = mergeNarrativeThreads(storyline.activeThreads, turnEntry.activeThreads, 8);
            storyline.unresolvedQuestions = pushNarrativeUniqueLimited(storyline.unresolvedQuestions, turnEntry.unresolvedQuestions, 8, { maxChars: 140 });
            storyline.nextBeatHints = pushNarrativeUniqueLimited(storyline.nextBeatHints, turnEntry.nextBeatHints, 8, { maxChars: 140 });
            storyline.relationPressure = pushNarrativeUniqueLimited(storyline.relationPressure, turnEntry.relationPressure, 8, { maxChars: 140 });
            storyline.memoryRefs = pushNarrativeUniqueLimited(storyline.memoryRefs, turnEntry.memoryRefs, 12, { maxChars: 80 });
            storyline.evidenceTurns = pushNarrativeUniqueLimited(storyline.evidenceTurns, turnEntry.evidenceTurns, 12, { maxChars: 40 });
            storyline.dedupeKeys = pushNarrativeUniqueLimited(storyline.dedupeKeys, turnEntry.dedupeKeys, 12, { maxChars: 160 });
            const liveKeyPoints = pushUniqueLimited(
                arcPatch?.keyPoints || [],
                [
                    ...(Array.isArray(turnEntry.distinctEvents) ? turnEntry.distinctEvents : []),
                    ...(Array.isArray(turnEntry.stateChanges) ? turnEntry.stateChanges : []),
                    ...deriveKeyPointsFromBrief(brief)
                ],
                8
            ).filter(item => !narrativeTextSimilar(item, brief) && !narrativeTextSimilar(item, lastDistinctEvent));
            const liveTensions = pushUniqueLimited(
                arcPatch?.ongoingTensions || [],
                deriveOngoingTensionsFromTurn(turnEntry),
                6
            );
            storyline.keyPoints = pushUniqueLimited(storyline.keyPoints, liveKeyPoints, 12);
            storyline.ongoingTensions = pushUniqueLimited(storyline.ongoingTensions, liveTensions, 10);
            storyline.summaries = Array.isArray(storyline.summaries) ? storyline.summaries : [];

            const existingLiveIndex = storyline.summaries.findIndex(entry => entry?.live === true);
            const liveEntry = {
                upToTurn: Number(turnEntry.turn || 0),
                summary: brief,
                keyPoints: liveKeyPoints,
                ongoingTensions: liveTensions,
                timestamp: Date.now(),
                live: true,
                sceneDate: turnEntry.sceneDate || '',
                sceneTime: turnEntry.sceneTime || '',
                sceneTimeLabel: turnEntry.sceneTimeLabel || '',
                sceneLocation: turnEntry.sceneLocation || turnEntry.locationState?.current || '',
                arcKey: storyline.arcKey || '',
                continuityBrief: brief,
                lastDistinctEvent,
                activeThreads: mergeNarrativeThreads([], turnEntry.activeThreads, 6),
                nextBeatHints: normalizeNarrativeStringArray(turnEntry.nextBeatHints, 4, 140),
                evidenceTurns: normalizeNarrativeStringArray(turnEntry.evidenceTurns, 8, 40)
            };

            if (existingLiveIndex >= 0) storyline.summaries[existingLiveIndex] = liveEntry;
            else storyline.summaries.push(liveEntry);

            if (storyline.summaries.length > 12) {
                storyline.summaries = storyline.summaries.slice(-12);
            }
        };

        const normalizeTurnEntry = (entry = {}) => {
            const sourceResponse = String(entry.summary || entry.response || '').trim();
            const summary = clipText(buildHeuristicTurnBrief('', sourceResponse), 180);
            const sourceMeta = entry?.meta && typeof entry.meta === 'object' ? safeClone(entry.meta) : {};
            const channel = String(entry.channel || entry.track || sourceMeta.channel || 'scene').trim().toLowerCase() === 'meta'
                ? 'meta'
                : 'scene';
            const containsMetaSignals = entry?.containsMetaSignals === true || sourceMeta.containsMetaSignals === true;
            const turn = Number(entry.turn || 0);
            const anchorTurn = normalizeLegacyMemoryTurnAnchor(
                entry.turnAnchorTurn
                || entry.turnAnchor
                || entry.lockedTurn
                || entry.finalizedTurn
                || sourceMeta.turnAnchorTurn
                || sourceMeta.turnAnchor
                || sourceMeta.lockedTurn
                || sourceMeta.finalizedTurn
                || turn
            ) || turn;
            const sourceMessageIds = normalizeCanonicalMessageIds(
                entry.sourceMessageIds
                || entry.liveMessageIds
                || sourceMeta.sourceMessageIds
                || sourceMeta.liveMessageIds
                || entry.messageId
                || entry.m_id
                || sourceMeta.messageId
                || sourceMeta.m_id
            );
            const sourceHash = String(entry.sourceHash || entry.aiHash || entry.responseHash || sourceMeta.sourceHash || sourceMeta.aiHash || sourceMeta.responseHash || '').trim();
            const messageSignature = String(entry.messageSignature || sourceMeta.messageSignature || '').trim();
            const userTurnKey = String(entry.userTurnKey || sourceMeta.userTurnKey || '').trim();
            const chatId = String(entry.chatId || sourceMeta.chatId || '').trim();
            const turnKey = String(
                entry.turnKey
                || sourceMeta.turnKey
                || buildCanonicalTurnKey(chatId, userTurnKey, sourceHash, messageSignature, sourceMessageIds)
            ).trim();
            const v42Meta = {
                ...sourceMeta,
                t: anchorTurn,
                turn: anchorTurn,
                firstTurn: normalizeLegacyMemoryTurnAnchor(entry.firstTurn || sourceMeta.firstTurn || anchorTurn) || anchorTurn,
                originalTurn: normalizeLegacyMemoryTurnAnchor(entry.originalTurn || sourceMeta.originalTurn || anchorTurn) || anchorTurn,
                lockedTurn: normalizeLegacyMemoryTurnAnchor(entry.lockedTurn || sourceMeta.lockedTurn || anchorTurn) || anchorTurn,
                finalizedTurn: normalizeLegacyMemoryTurnAnchor(entry.finalizedTurn || sourceMeta.finalizedTurn || anchorTurn) || anchorTurn,
                turnAnchorTurn: anchorTurn,
                turnAnchor: anchorTurn,
                turnLocked: entry.turnLocked === true || sourceMeta.turnLocked === true || anchorTurn > 0,
                turnAnchorReason: String(entry.turnAnchorReason || sourceMeta.turnAnchorReason || 'v4.2-narrative-turn').trim() || 'v4.2-narrative-turn',
                sourceMessageIds,
                liveMessageIds: normalizeCanonicalMessageIds(entry.liveMessageIds || sourceMeta.liveMessageIds || sourceMessageIds),
                m_id: String(entry.m_id || sourceMeta.m_id || getPrimaryCanonicalMessageId(sourceMessageIds, true) || '').trim(),
                messageId: String(entry.messageId || sourceMeta.messageId || getPrimaryCanonicalMessageId(sourceMessageIds, true) || '').trim(),
                sourceHash,
                aiHash: String(entry.aiHash || sourceMeta.aiHash || sourceHash || '').trim(),
                responseHash: String(entry.responseHash || sourceMeta.responseHash || sourceHash || '').trim(),
                userTurnKey,
                turnKey,
                messageSignature,
                messageCount: Number(entry.messageCount || sourceMeta.messageCount || 0),
                liveOrder: Number(entry.liveOrder || sourceMeta.liveOrder || entry.messageCount || sourceMeta.messageCount || 0),
                chatId,
                channel,
                containsMetaSignals
            };
            const fallbackSignals = extractNarrativeSignals('', sourceResponse || summary, {
                turn: anchorTurn || turn,
                sourceMessageIds
            });
            const responseBrief = clipText(entry.responseBrief || entry.response || fallbackSignals.responseBrief || summary, 180);
            const continuityBrief = clipText(entry.continuityBrief || fallbackSignals.continuityBrief || responseBrief, 240);
            const lastDistinctEvent = clipText(entry.lastDistinctEvent || fallbackSignals.lastDistinctEvent || responseBrief, 180);
            const locationState = (entry.locationState && typeof entry.locationState === 'object')
                ? safeClone(entry.locationState)
                : fallbackSignals.locationState;
            const temporalState = (entry.temporalState && typeof entry.temporalState === 'object')
                ? safeClone(entry.temporalState)
                : fallbackSignals.temporalState;
            const activeThreads = mergeNarrativeThreads(fallbackSignals.activeThreads, entry.activeThreads, 8);
            const distinctEvents = pushNarrativeUniqueLimited(fallbackSignals.distinctEvents, entry.distinctEvents, 6, { maxChars: 180 });
            const stateChanges = pushNarrativeUniqueLimited(fallbackSignals.stateChanges, entry.stateChanges, 6, { maxChars: 160 });
            const threadUpdates = pushNarrativeUniqueLimited(fallbackSignals.threadUpdates, entry.threadUpdates, 8, { maxChars: 150 });
            const relationUpdates = pushNarrativeUniqueLimited(fallbackSignals.relationUpdates, entry.relationUpdates, 6, { maxChars: 140 });
            const nextBeatHints = pushNarrativeUniqueLimited(fallbackSignals.nextBeatHints, entry.nextBeatHints, 6, { maxChars: 140 });
            const unresolvedQuestions = pushNarrativeUniqueLimited(fallbackSignals.unresolvedQuestions, entry.unresolvedQuestions, 6, { maxChars: 140 });
            const relationPressure = pushNarrativeUniqueLimited(fallbackSignals.relationPressure, entry.relationPressure, 6, { maxChars: 140 });
            const memoryRefs = pushNarrativeUniqueLimited(fallbackSignals.memoryRefs, entry.memoryRefs, 8, { maxChars: 80 });
            const evidenceTurns = pushNarrativeUniqueLimited(fallbackSignals.evidenceTurns, entry.evidenceTurns, 8, { maxChars: 40 });
            const dedupeKeys = Array.from(new Set([
                ...(Array.isArray(fallbackSignals.dedupeKeys) ? fallbackSignals.dedupeKeys : []),
                ...(Array.isArray(entry.dedupeKeys) ? entry.dedupeKeys : []),
                normalizeNarrativeDedupeKey(responseBrief),
                normalizeNarrativeDedupeKey(continuityBrief)
            ].filter(Boolean))).slice(0, 10);
            return {
                turn,
                timestamp: Number(entry.timestamp || Date.now()),
                userAction: '',
                response: responseBrief,
                involvedEntities: Array.isArray(entry.involvedEntities)
                    ? entry.involvedEntities.map(e => typeof e === 'string' ? e : e?.name).filter(Boolean)
                    : [],
                summary: responseBrief,
                responseBrief,
                continuityBrief,
                lastDistinctEvent,
                distinctEvents,
                stateChanges,
                threadUpdates,
                relationUpdates,
                nextBeat: clipText(entry.nextBeat || fallbackSignals.nextBeat || nextBeatHints[0] || '', 140),
                activeThreads,
                unresolvedQuestions,
                nextBeatHints,
                relationPressure,
                locationState,
                temporalState,
                memoryRefs,
                evidenceTurns,
                dedupeKeys,
                sceneLocation: clipText(entry.sceneLocation || sourceMeta.sceneLocation || locationState?.current || '', 100),
                sceneDate: compactTimeFieldText(entry.sceneDate || sourceMeta.sceneDate || temporalState?.date || entry.currentDate || '', 80),
                sceneTime: compactTimeFieldText(entry.sceneTime || sourceMeta.sceneTime || temporalState?.time || entry.currentTime || '', 40),
                sceneTimeLabel: compactTimeFieldText(entry.sceneTimeLabel || sourceMeta.sceneTimeLabel || temporalState?.label || '', 160),
                sceneTurn: Math.max(0, Number(entry.sceneTurn || sourceMeta.sceneTurn || entry.turn || 0)),
                narrativeArc: (entry?.narrativeArc && typeof entry.narrativeArc === 'object') ? safeClone(entry.narrativeArc) : null,
                sourceMessageIds: v42Meta.sourceMessageIds,
                liveMessageIds: v42Meta.liveMessageIds,
                m_id: v42Meta.m_id,
                messageId: v42Meta.messageId,
                sourceHash: v42Meta.sourceHash,
                aiHash: v42Meta.aiHash,
                responseHash: v42Meta.responseHash,
                userTurnKey: v42Meta.userTurnKey,
                turnKey: v42Meta.turnKey,
                messageSignature: v42Meta.messageSignature,
                messageCount: v42Meta.messageCount,
                liveOrder: v42Meta.liveOrder,
                chatId: v42Meta.chatId,
                firstTurn: v42Meta.firstTurn,
                originalTurn: v42Meta.originalTurn,
                lockedTurn: v42Meta.lockedTurn,
                finalizedTurn: v42Meta.finalizedTurn,
                turnAnchorTurn: v42Meta.turnAnchorTurn,
                turnAnchor: v42Meta.turnAnchor,
                turnLocked: v42Meta.turnLocked,
                turnAnchorReason: v42Meta.turnAnchorReason,
                channel,
                containsMetaSignals,
                meta: v42Meta
            };
        };

        const getNarrativeTurnLogDedupeKey = (entry = {}) => {
            const channel = String(entry?.channel || entry?.track || entry?.meta?.channel || 'scene').trim().toLowerCase() === 'meta' ? 'meta' : 'scene';
            const turn = Number(entry?.turnAnchorTurn || entry?.turnAnchor || entry?.finalizedTurn || entry?.lockedTurn || entry?.turn || entry?.meta?.turnAnchorTurn || entry?.meta?.turn || 0);
            if (Number.isFinite(turn) && turn > 0) return `${channel}:turn:${turn}`;
            const turnKey = String(entry?.turnKey || entry?.meta?.turnKey || '').trim();
            if (turnKey) return `${channel}:key:${turnKey}`;
            const sourceHash = String(entry?.sourceHash || entry?.aiHash || entry?.responseHash || entry?.meta?.sourceHash || entry?.meta?.aiHash || entry?.meta?.responseHash || '').trim();
            if (sourceHash) return `${channel}:hash:${sourceHash}`;
            const ids = normalizeCanonicalMessageIds(entry?.sourceMessageIds || entry?.liveMessageIds || entry?.messageId || entry?.m_id || entry?.meta?.sourceMessageIds || entry?.meta?.liveMessageIds || entry?.meta?.messageId || entry?.meta?.m_id);
            if (ids.length) return `${channel}:ids:${ids.join('|')}`;
            return `${channel}:summary:${normalizeNarrativeDedupeKey(entry?.summary || entry?.response || entry?.continuityBrief || '')}`;
        };

        const mergeNarrativeTurnLogEntries = (existing = {}, incoming = {}) => {
            const merged = {
                ...existing,
                ...incoming,
                timestamp: Math.max(Number(existing?.timestamp || 0), Number(incoming?.timestamp || 0), Date.now()),
                meta: {
                    ...(existing?.meta && typeof existing.meta === 'object' ? existing.meta : {}),
                    ...(incoming?.meta && typeof incoming.meta === 'object' ? incoming.meta : {})
                }
            };
            merged.involvedEntities = pushNarrativeUniqueLimited(existing.involvedEntities, incoming.involvedEntities, 16, { maxChars: 80 });
            merged.distinctEvents = pushNarrativeUniqueLimited(existing.distinctEvents, incoming.distinctEvents, 8, { maxChars: 180 });
            merged.stateChanges = pushNarrativeUniqueLimited(existing.stateChanges, incoming.stateChanges, 8, { maxChars: 160 });
            merged.threadUpdates = pushNarrativeUniqueLimited(existing.threadUpdates, incoming.threadUpdates, 10, { maxChars: 150 });
            merged.relationUpdates = pushNarrativeUniqueLimited(existing.relationUpdates, incoming.relationUpdates, 8, { maxChars: 140 });
            merged.nextBeatHints = pushNarrativeUniqueLimited(existing.nextBeatHints, incoming.nextBeatHints, 8, { maxChars: 140 });
            merged.unresolvedQuestions = pushNarrativeUniqueLimited(existing.unresolvedQuestions, incoming.unresolvedQuestions, 8, { maxChars: 140 });
            merged.relationPressure = pushNarrativeUniqueLimited(existing.relationPressure, incoming.relationPressure, 8, { maxChars: 140 });
            merged.memoryRefs = pushNarrativeUniqueLimited(existing.memoryRefs, incoming.memoryRefs, 12, { maxChars: 80 });
            merged.evidenceTurns = pushNarrativeUniqueLimited(existing.evidenceTurns, incoming.evidenceTurns, 12, { maxChars: 40 });
            merged.dedupeKeys = pushNarrativeUniqueLimited(existing.dedupeKeys, incoming.dedupeKeys, 12, { maxChars: 160 });
            merged.activeThreads = mergeNarrativeThreads(existing.activeThreads, incoming.activeThreads, 8);
            if (!merged.locationState && (existing.locationState || incoming.locationState)) merged.locationState = safeClone(incoming.locationState || existing.locationState);
            if (!merged.temporalState && (existing.temporalState || incoming.temporalState)) merged.temporalState = safeClone(incoming.temporalState || existing.temporalState);
            return merged;
        };

        const dedupeNarrativeTurnLog = (entries = [], limit = NARRATIVE_TURN_LOG_LIMIT) => {
            const map = new Map();
            const order = [];
            for (const rawEntry of Array.isArray(entries) ? entries : []) {
                if (!rawEntry) continue;
                const entry = rawEntry.turnKey || rawEntry.turnAnchorTurn || rawEntry.summary || rawEntry.response
                    ? rawEntry
                    : normalizeTurnEntry(rawEntry);
                const key = getNarrativeTurnLogDedupeKey(entry);
                if (!key) continue;
                if (map.has(key)) {
                    map.set(key, mergeNarrativeTurnLogEntries(map.get(key), entry));
                } else {
                    map.set(key, entry);
                    order.push(key);
                }
            }
            const merged = order.map(key => map.get(key)).filter(Boolean)
                .sort((a, b) => Number(a?.turn || 0) - Number(b?.turn || 0) || Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
            const cap = Math.max(1, Number(limit || NARRATIVE_TURN_LOG_LIMIT));
            return merged.length > cap ? merged.slice(-cap) : merged;
        };

        const mergeNarrativeStorylines = (storylines = []) => {
            const shouldMerge = (left, right) => {
                const leftArc = String(left?.arcKey || '').trim();
                const rightArc = String(right?.arcKey || '').trim();
                if (!narrativeArcKeysCompatible(leftArc, rightArc)) return false;
                if (leftArc && rightArc && leftArc === rightArc && isConcreteNarrativeArcKey(leftArc)) return true;
                const threadScore = narrativeThreadOverlapScore(left?.activeThreads, right?.activeThreads);
                if (threadScore >= 0.5) return true;
                const entityScore = narrativeEntitiesOverlapScore(left?.entities, right?.entities);
                const hasConcreteArc = isConcreteNarrativeArcKey(leftArc) || isConcreteNarrativeArcKey(rightArc);
                if (hasConcreteArc) {
                    return entityScore >= 0.85
                        && (isGenericNarrativeStorylineName(left?.name) || isGenericNarrativeStorylineName(right?.name));
                }
                if (entityScore >= 0.65) return true;
                if (entityScore >= 0.4 && (isGenericNarrativeStorylineName(left?.name) || isGenericNarrativeStorylineName(right?.name))) return true;
                return false;
            };
            const mergeInto = (target, source) => {
                if (!target || !source) return target;
                if (isGenericNarrativeStorylineName(target.name) && !isGenericNarrativeStorylineName(source.name)) target.name = source.name;
                if ((!target.arcKey || isGenericNarrativeArcKey(target.arcKey)) && source.arcKey && isConcreteNarrativeArcKey(source.arcKey)) target.arcKey = source.arcKey;
                if (!target.phase && source.phase) target.phase = source.phase;
                if (!target.primaryConflict && source.primaryConflict) target.primaryConflict = source.primaryConflict;
                for (const entity of Array.isArray(source.entities) ? source.entities : []) {
                    target.entities = pushNarrativeEntity(target.entities, entity);
                }
                target.turns = Array.from(new Set([...(target.turns || []), ...(source.turns || [])].map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
                target.firstTurn = target.turns[0] || target.firstTurn || source.firstTurn || 0;
                target.lastTurn = target.turns[target.turns.length - 1] || target.lastTurn || source.lastTurn || 0;
                target.lastSceneDate = source.lastSceneDate || target.lastSceneDate || '';
                target.lastSceneTime = source.lastSceneTime || target.lastSceneTime || '';
                target.lastSceneTimeLabel = source.lastSceneTimeLabel || target.lastSceneTimeLabel || '';
                target.sceneLocation = source.sceneLocation || target.sceneLocation || '';
                target.currentContext = source.currentContext || target.currentContext || '';
                target.continuityBrief = source.continuityBrief || target.continuityBrief || target.currentContext || '';
                target.lastDistinctEvent = source.lastDistinctEvent || target.lastDistinctEvent || '';
                const mergedEvents = [];
                for (const event of [...(target.recentEvents || []), ...(source.recentEvents || [])]
                    .sort((a, b) => Number(a?.turn || 0) - Number(b?.turn || 0))) {
                    const normalizedEvent = {
                        turn: Number(event?.turn || 0),
                        brief: clipText(event?.brief || '', 220),
                        arcKey: String(event?.arcKey || target.arcKey || '').trim()
                    };
                    if (!normalizedEvent.turn || !normalizedEvent.brief) continue;
                    const existing = mergedEvents.find(item => Number(item.turn || 0) === normalizedEvent.turn || narrativeTextSimilar(item.brief, normalizedEvent.brief));
                    if (existing) {
                        existing.turn = Math.max(Number(existing.turn || 0), normalizedEvent.turn);
                        if (!existing.arcKey && normalizedEvent.arcKey) existing.arcKey = normalizedEvent.arcKey;
                    } else {
                        mergedEvents.push(normalizedEvent);
                    }
                }
                target.recentEvents = dedupeNarrativeRecentEvents(mergedEvents, 10);
                target.summaries = [...(target.summaries || []), ...(source.summaries || [])]
                    .sort((a, b) => Number(a?.upToTurn || 0) - Number(b?.upToTurn || 0))
                    .slice(-12);
                target.keyPoints = pushNarrativeUniqueLimited(target.keyPoints, source.keyPoints, 12, { maxChars: 160 });
                target.ongoingTensions = pushNarrativeUniqueLimited(target.ongoingTensions, source.ongoingTensions, 10, { maxChars: 160 });
                target.activeThreads = mergeNarrativeThreads(target.activeThreads, source.activeThreads, 8);
                target.unresolvedQuestions = pushNarrativeUniqueLimited(target.unresolvedQuestions, source.unresolvedQuestions, 8, { maxChars: 140 });
                target.nextBeatHints = pushNarrativeUniqueLimited(target.nextBeatHints, source.nextBeatHints, 8, { maxChars: 140 });
                target.relationPressure = pushNarrativeUniqueLimited(target.relationPressure, source.relationPressure, 8, { maxChars: 140 });
                target.memoryRefs = pushNarrativeUniqueLimited(target.memoryRefs, source.memoryRefs, 12, { maxChars: 80 });
                target.evidenceTurns = pushNarrativeUniqueLimited(target.evidenceTurns, source.evidenceTurns, 12, { maxChars: 40 });
                target.dedupeKeys = pushNarrativeUniqueLimited(target.dedupeKeys, source.dedupeKeys, 12, { maxChars: 160 });
                if (!target.locationState && source.locationState) target.locationState = safeClone(source.locationState);
                if (!target.temporalState && source.temporalState) target.temporalState = safeClone(source.temporalState);
                return target;
            };

            const merged = [];
            for (const storyline of Array.isArray(storylines) ? storylines : []) {
                if (!storyline) continue;
                const existing = merged.find(item => shouldMerge(item, storyline));
                if (existing) mergeInto(existing, storyline);
                else merged.push(storyline);
            }
            return merged.map((storyline, index) => ({
                ...storyline,
                id: Number(storyline.id || index + 1)
            }));
        };

        const normalizeState = (state = null) => {
            const nextState = state && typeof state === 'object' ? safeClone(state) : { storylines: [], turnLog: [], metaTurnLog: [], lastSummaryTurn: 0 };
            nextState.turnLog = dedupeNarrativeTurnLog(
                Array.isArray(nextState.turnLog) ? nextState.turnLog.map(normalizeTurnEntry).filter(entry => entry.turn >= 0) : [],
                NARRATIVE_TURN_LOG_LIMIT
            );
            nextState.metaTurnLog = dedupeNarrativeTurnLog(
                Array.isArray(nextState.metaTurnLog) ? nextState.metaTurnLog.map(normalizeTurnEntry).filter(entry => entry.turn >= 0) : [],
                NARRATIVE_META_TURN_LOG_LIMIT
            );
            const turnMap = new Map(nextState.turnLog.map(entry => [entry.turn, entry]));
            nextState.storylines = Array.isArray(nextState.storylines) ? nextState.storylines.map((storyline, idx) => {
                const turns = Array.isArray(storyline?.turns) ? storyline.turns.map(turn => Number(turn)).filter(Number.isFinite) : [];
                const recentEvents = Array.isArray(storyline?.recentEvents) ? storyline.recentEvents.map((event) => {
                    const turn = Number(event?.turn ?? event);
                    const matched = turnMap.get(turn);
                    return {
                        turn: Number.isFinite(turn) ? turn : '?',
                        brief: clipText(matched?.lastDistinctEvent || matched?.continuityBrief || matched?.summary || event?.brief || '', 180),
                        arcKey: String(event?.arcKey || matched?.narrativeArc?.arcKey || '').trim()
                    };
                }).filter(event => String(event.brief || '').trim()) : [];
                return {
                    id: Number(storyline?.id || idx + 1),
                    name: String(storyline?.name || `Storyline #${idx + 1}`),
                    arcKey: String(storyline?.arcKey || makeNarrativeArcKey(storyline?.name || '') || '').trim(),
                    phase: clipText(storyline?.phase || '', 80),
                    primaryConflict: clipText(storyline?.primaryConflict || '', 220),
                    entities: Array.isArray(storyline?.entities) ? storyline.entities.map(String).filter(Boolean) : [],
                    turns,
                    firstTurn: Number(storyline?.firstTurn || turns[0] || 0),
                    lastTurn: Number(storyline?.lastTurn || turns[turns.length - 1] || 0),
                    lastSceneDate: compactTimeFieldText(storyline?.lastSceneDate || '', 80),
                    lastSceneTime: compactTimeFieldText(storyline?.lastSceneTime || '', 40),
                    lastSceneTimeLabel: compactTimeFieldText(storyline?.lastSceneTimeLabel || '', 160),
                    sceneLocation: clipText(storyline?.sceneLocation || storyline?.locationState?.current || '', 100),
                    locationState: (storyline?.locationState && typeof storyline.locationState === 'object') ? safeClone(storyline.locationState) : null,
                    temporalState: (storyline?.temporalState && typeof storyline.temporalState === 'object') ? safeClone(storyline.temporalState) : null,
                    recentEvents: dedupeNarrativeRecentEvents(recentEvents, 10),
                    summaries: Array.isArray(storyline?.summaries) ? storyline.summaries.map(entry => ({
                        upToTurn: Number(entry?.upToTurn || 0),
                        summary: clipText(entry?.summary || '', 240),
                        keyPoints: normalizeNarrativeStringArray(entry?.keyPoints, 8, 160),
                        ongoingTensions: normalizeNarrativeStringArray(entry?.ongoingTensions, 8, 160),
                        timestamp: Number(entry?.timestamp || Date.now()),
                        live: entry?.live === true,
                        sceneDate: compactTimeFieldText(entry?.sceneDate || '', 80),
                        sceneTime: compactTimeFieldText(entry?.sceneTime || '', 40),
                        sceneTimeLabel: compactTimeFieldText(entry?.sceneTimeLabel || '', 160),
                        sceneLocation: clipText(entry?.sceneLocation || '', 100),
                        arcKey: String(entry?.arcKey || '').trim(),
                        continuityBrief: clipText(entry?.continuityBrief || entry?.summary || '', 240),
                        lastDistinctEvent: clipText(entry?.lastDistinctEvent || '', 220),
                        activeThreads: mergeNarrativeThreads([], entry?.activeThreads, 6),
                        nextBeatHints: normalizeNarrativeStringArray(entry?.nextBeatHints, 4, 140),
                        evidenceTurns: normalizeNarrativeStringArray(entry?.evidenceTurns, 8, 40)
                    })) : [],
                    currentContext: clipText(storyline?.currentContext || '', 260),
                    continuityBrief: clipText(storyline?.continuityBrief || storyline?.currentContext || '', 260),
                    lastDistinctEvent: clipText(storyline?.lastDistinctEvent || recentEvents[recentEvents.length - 1]?.brief || '', 220),
                    keyPoints: normalizeNarrativeStringArray(storyline?.keyPoints, 12, 160),
                    ongoingTensions: normalizeNarrativeStringArray(storyline?.ongoingTensions, 10, 160),
                    activeThreads: mergeNarrativeThreads([], storyline?.activeThreads, 8),
                    unresolvedQuestions: normalizeNarrativeStringArray(storyline?.unresolvedQuestions, 8, 140),
                    nextBeatHints: normalizeNarrativeStringArray(storyline?.nextBeatHints, 8, 140),
                    relationPressure: normalizeNarrativeStringArray(storyline?.relationPressure, 8, 140),
                    memoryRefs: normalizeNarrativeStringArray(storyline?.memoryRefs, 12, 80),
                    evidenceTurns: normalizeNarrativeStringArray(storyline?.evidenceTurns, 12, 40),
                    dedupeKeys: normalizeNarrativeStringArray(storyline?.dedupeKeys, 12, 160),
                    meta: {
                        manualLocked: storyline?.meta?.manualLocked === true,
                        manualLockedAt: Number(storyline?.meta?.manualLockedAt || 0)
                    }
                };
            }) : [];
            splitMixedArcStorylines(nextState);
            nextState.storylines = mergeNarrativeStorylines(nextState.storylines);
            nextState.lastSummaryTurn = Number(nextState.lastSummaryTurn || 0);
            return nextState;
        };

        const buildPromptState = () => {
            const promptState = safeClone(narrativeState || {});
            splitMixedArcStorylines(promptState);
            promptState.storylines = mergeNarrativeStorylines(promptState.storylines);
            return promptState;
        };


        const loadState = (lorebook) => {
            const entry = lorebook.find(e => e.comment === NARRATIVE_COMMENT);
            if (!entry) {
                narrativeState = normalizeState({ storylines: [], turnLog: [], metaTurnLog: [], lastSummaryTurn: 0 });
                return narrativeState;
            }
            try {
                const parsed = JSON.parse(entry.content);
                const integrity = IntegrityMetaManager.validateIntegrityMeta(parsed, {
                    domain: 'narrative',
                    recordId: 'narrative_state',
                    scopeKey: MemoryState?._activeScopeKey || ''
                });
                if (!integrity.ok) {
                    IntegrityMetaManager.debugValidationFailure('narrative.loadState', integrity, {
                        domain: 'narrative',
                        recordId: 'narrative_state',
                        scopeKey: MemoryState?._activeScopeKey || ''
                    });
                    narrativeState = normalizeState({ storylines: [], turnLog: [], metaTurnLog: [], lastSummaryTurn: 0 });
                } else {
            narrativeState = normalizeState(parsed);
                }
            } catch (e) {
                narrativeState = normalizeState({ storylines: [], turnLog: [], metaTurnLog: [], lastSummaryTurn: 0 });
                recordRuntimeDebug('warn', '[LIBRA] Narrative state parse failed:', e?.message);
            }
            return narrativeState;
        };

        const saveState = async (lorebook) => {
            narrativeState = normalizeState(narrativeState);
            narrativeState.meta = narrativeState.meta && typeof narrativeState.meta === 'object' ? narrativeState.meta : {};
            IntegrityMetaManager.applyIntegrityMeta(narrativeState, {
                domain: 'narrative',
                recordSchema: 'libra.narrative.state.v1',
                recordId: 'narrative_state',
                scopeKey: MemoryState?._activeScopeKey || '',
                turn: MemoryState?.currentTurn || 0,
                source: 'narrative_tracker'
            });
            const entry = {
                key: LibraLoreKeys.narrative(),
                comment: NARRATIVE_COMMENT,
                content: JSON.stringify(narrativeState),
                mode: 'normal',
                insertorder: 5,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(e => e.comment === NARRATIVE_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };

        const recordTurn = async (turn, userMsg, aiResponse, entities = [], config = MemoryEngine.CONFIG, options = {}) => {
            const normalizedEntities = Array.from(new Set(
                (Array.isArray(entities) ? entities : [])
                    .map(e => typeof e === 'string' ? e : e?.name)
                    .map(name => String(name || '').trim())
                    .filter(Boolean)
            ));
            const anchorSource = (options?.anchorMeta && typeof options.anchorMeta === 'object') ? options.anchorMeta : (options || {});
            const channel = String(options?.channel || options?.track || anchorSource.channel || 'scene').trim().toLowerCase() === 'meta'
                ? 'meta'
                : 'scene';
            const containsMetaSignals = options?.containsMetaSignals === true || anchorSource.containsMetaSignals === true;
            const anchorTurn = normalizeLegacyMemoryTurnAnchor(
                anchorSource.turnAnchorTurn
                || anchorSource.turnAnchor
                || anchorSource.lockedTurn
                || anchorSource.finalizedTurn
                || anchorSource.turn
                || turn
            ) || Number(turn || 0);
            const sourceMessageIds = normalizeCanonicalMessageIds(
                anchorSource.sourceMessageIds
                || anchorSource.liveMessageIds
                || anchorSource.messageId
                || anchorSource.m_id
            );
            const sourceHash = String(anchorSource.sourceHash || anchorSource.aiHash || anchorSource.responseHash || '').trim();
            const aiHash = String(anchorSource.aiHash || sourceHash || '').trim();
            const responseHash = String(anchorSource.responseHash || sourceHash || '').trim();
            const messageSignature = String(anchorSource.messageSignature || '').trim();
            const userTurnKey = String(anchorSource.userTurnKey || '').trim();
            const chatId = String(anchorSource.chatId || '').trim();
            const turnKey = String(
                anchorSource.turnKey
                || buildCanonicalTurnKey(chatId, userTurnKey, sourceHash, messageSignature, sourceMessageIds)
            ).trim();
            const narrativeSignals = extractNarrativeSignals('', aiResponse, {
                turn: anchorTurn || turn,
                sourceMessageIds
            });
            let responseBrief = clipText(narrativeSignals.responseBrief || '', 180);
            if (!responseBrief) responseBrief = await generateTurnBrief('', aiResponse, config);
            const v42Meta = {
                ...Object.fromEntries(Object.entries(anchorSource || {}).filter(([, value]) => value !== undefined && value !== null && value !== '')),
                t: anchorTurn,
                turn: anchorTurn,
                firstTurn: normalizeLegacyMemoryTurnAnchor(anchorSource.firstTurn || anchorTurn) || anchorTurn,
                originalTurn: normalizeLegacyMemoryTurnAnchor(anchorSource.originalTurn || anchorTurn) || anchorTurn,
                lockedTurn: normalizeLegacyMemoryTurnAnchor(anchorSource.lockedTurn || anchorTurn) || anchorTurn,
                finalizedTurn: normalizeLegacyMemoryTurnAnchor(anchorSource.finalizedTurn || anchorTurn) || anchorTurn,
                turnAnchorTurn: anchorTurn,
                turnAnchor: anchorTurn,
                turnLocked: true,
                turnAnchorReason: String(anchorSource.turnAnchorReason || 'v4.2-narrative-turn').trim() || 'v4.2-narrative-turn',
                sourceMessageIds,
                liveMessageIds: normalizeCanonicalMessageIds(anchorSource.liveMessageIds || sourceMessageIds),
                m_id: String(anchorSource.m_id || anchorSource.messageId || getPrimaryCanonicalMessageId(sourceMessageIds, true) || '').trim(),
                messageId: String(anchorSource.messageId || anchorSource.m_id || getPrimaryCanonicalMessageId(sourceMessageIds, true) || '').trim(),
                sourceHash,
                aiHash,
                responseHash,
                userTurnKey,
                turnKey,
                messageSignature,
                messageCount: Number(anchorSource.messageCount || 0),
                liveOrder: Number(anchorSource.liveOrder || anchorSource.messageCount || 0),
                chatId,
                recordedAt: Date.now(),
                channel,
                containsMetaSignals
            };
            const beforeTimeState = TimeEngine.getState?.() || {};
            const sceneDateCandidate = compactTimeFieldText(anchorSource.sceneDate || narrativeSignals.temporalState?.date || '', 80);
            const sceneTimeCandidate = compactTimeFieldText(anchorSource.sceneTime || narrativeSignals.temporalState?.time || '', 40);
            const sceneTimeLabel = compactTimeFieldText(
                anchorSource.sceneTimeLabel
                || anchorSource.currentLabel
                || narrativeSignals.temporalState?.label
                || [sceneDateCandidate, sceneTimeCandidate].filter(Boolean).join(' '),
                160
            );
            if (channel === 'scene') {
                try {
                    TimeEngine.ingestLiveTurn(
                        normalizedEntities,
                        sceneDateCandidate || anchorSource.currentDate || '',
                        `Turn ${Number(anchorTurn || turn || 0)} narrative progression`,
                        {
                            sceneDate: sceneDateCandidate,
                            sceneTime: sceneTimeCandidate,
                            sceneTimeLabel
                        }
                    );
                } catch (e) {
                    if (config?.debug) console.warn('[LIBRA] TimeEngine narrative ingest skipped:', e?.message || e);
                }
            }
            const timeState = TimeEngine.getState?.() || beforeTimeState || {};
            const sceneDate = compactTimeFieldText(sceneDateCandidate || timeState.currentDate || timeState.lastSceneDate || '', 80);
            const sceneTime = compactTimeFieldText(sceneTimeCandidate || timeState.currentTime || timeState.lastSceneTime || '', 40);
            const sceneTurn = Math.max(0, Number(timeState.sceneTurn || anchorTurn || turn || 0));
            const sceneLocation = clipText(anchorSource.sceneLocation || narrativeSignals.locationState?.current || '', 100);
            v42Meta.sceneDate = sceneDate;
            v42Meta.sceneTime = sceneTime;
            v42Meta.sceneTimeLabel = sceneTimeLabel || timeState.currentLabel || timeState.lastSceneLabel || '';
            v42Meta.sceneTurn = sceneTurn;
            v42Meta.sceneLocation = sceneLocation;
            const narrativeArcPatch = buildNarrativeArcPatch({
                    userAction: '',
                response: responseBrief,
                summary: responseBrief,
                continuityBrief: narrativeSignals.continuityBrief,
                lastDistinctEvent: narrativeSignals.lastDistinctEvent,
                distinctEvents: narrativeSignals.distinctEvents,
                stateChanges: narrativeSignals.stateChanges,
                activeThreads: narrativeSignals.activeThreads,
                unresolvedQuestions: narrativeSignals.unresolvedQuestions,
                relationPressure: narrativeSignals.relationPressure,
                nextBeatHints: narrativeSignals.nextBeatHints
            }, anchorSource?.narrative || {});
            const turnEntry = {
                turn: anchorTurn || turn,
                timestamp: Date.now(),
                userAction: '',
                response: responseBrief,
                involvedEntities: normalizedEntities,
                summary: responseBrief,
                responseBrief,
                continuityBrief: narrativeSignals.continuityBrief || responseBrief,
                lastDistinctEvent: narrativeSignals.lastDistinctEvent || responseBrief,
                distinctEvents: narrativeSignals.distinctEvents || [],
                stateChanges: narrativeSignals.stateChanges || [],
                threadUpdates: narrativeSignals.threadUpdates || [],
                relationUpdates: narrativeSignals.relationUpdates || [],
                nextBeat: narrativeSignals.nextBeat || '',
                activeThreads: narrativeSignals.activeThreads || [],
                unresolvedQuestions: narrativeSignals.unresolvedQuestions || [],
                nextBeatHints: narrativeSignals.nextBeatHints || [],
                relationPressure: narrativeSignals.relationPressure || [],
                locationState: narrativeSignals.locationState || { current: '', source: '' },
                temporalState: narrativeSignals.temporalState || { label: '', date: '', time: '' },
                memoryRefs: narrativeSignals.memoryRefs || [],
                evidenceTurns: narrativeSignals.evidenceTurns || [],
                dedupeKeys: narrativeSignals.dedupeKeys || [],
                sceneLocation,
                sceneDate,
                sceneTime,
                sceneTimeLabel: v42Meta.sceneTimeLabel,
                sceneTurn,
                narrativeArc: narrativeArcPatch,
                sourceMessageIds: v42Meta.sourceMessageIds,
                liveMessageIds: v42Meta.liveMessageIds,
                m_id: v42Meta.m_id,
                messageId: v42Meta.messageId,
                sourceHash: v42Meta.sourceHash,
                aiHash: v42Meta.aiHash,
                responseHash: v42Meta.responseHash,
                userTurnKey: v42Meta.userTurnKey,
                turnKey: v42Meta.turnKey,
                messageSignature: v42Meta.messageSignature,
                messageCount: v42Meta.messageCount,
                liveOrder: v42Meta.liveOrder,
                chatId: v42Meta.chatId,
                firstTurn: v42Meta.firstTurn,
                originalTurn: v42Meta.originalTurn,
                lockedTurn: v42Meta.lockedTurn,
                finalizedTurn: v42Meta.finalizedTurn,
                turnAnchorTurn: v42Meta.turnAnchorTurn,
                turnAnchor: v42Meta.turnAnchor,
                turnLocked: true,
                turnAnchorReason: v42Meta.turnAnchorReason,
                channel,
                containsMetaSignals,
                meta: v42Meta
            };
            if (channel === 'meta') {
                narrativeState.metaTurnLog = dedupeNarrativeTurnLog([
                    ...(Array.isArray(narrativeState.metaTurnLog) ? narrativeState.metaTurnLog : []),
                    turnEntry
                ], NARRATIVE_META_TURN_LOG_LIMIT);
                return narrativeState.metaTurnLog.find(entry => getNarrativeTurnLogDedupeKey(entry) === getNarrativeTurnLogDedupeKey(turnEntry)) || turnEntry;
            }

            narrativeState.turnLog = dedupeNarrativeTurnLog([
                ...(Array.isArray(narrativeState.turnLog) ? narrativeState.turnLog : []),
                turnEntry
            ], NARRATIVE_TURN_LOG_LIMIT);

            const storedTurnEntry = narrativeState.turnLog.find(entry => getNarrativeTurnLogDedupeKey(entry) === getNarrativeTurnLogDedupeKey(turnEntry)) || turnEntry;
            assignToStoryline(storedTurnEntry);
            return storedTurnEntry;
        };
        const correctTurn = (turn, updates = {}) => {
            const targetTurn = Number(turn || 0);
            if (!targetTurn) return false;
            const turnEntry = narrativeState.turnLog.find(entry => Number(entry?.turn || 0) === targetTurn);
            if (!turnEntry) return false;

            const nextSummary = String(updates.summary || updates.narrativeBrief || '').trim();
            const nextEntities = Array.isArray(updates.entities)
                ? updates.entities.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean)
                : [];

            if (nextSummary) {
                const clipped = clipText(nextSummary, 220);
                const correctionSignals = extractNarrativeSignals('', clipped, {
                    turn: targetTurn,
                    sourceMessageIds: turnEntry.sourceMessageIds
                });
                turnEntry.response = clipped;
                turnEntry.summary = clipped;
                turnEntry.responseBrief = correctionSignals.responseBrief || clipped;
                turnEntry.continuityBrief = correctionSignals.continuityBrief || clipped;
                turnEntry.lastDistinctEvent = correctionSignals.lastDistinctEvent || clipped;
                turnEntry.distinctEvents = correctionSignals.distinctEvents || [];
                turnEntry.stateChanges = correctionSignals.stateChanges || [];
                turnEntry.threadUpdates = correctionSignals.threadUpdates || [];
                turnEntry.relationUpdates = correctionSignals.relationUpdates || [];
                turnEntry.nextBeat = correctionSignals.nextBeat || '';
                turnEntry.activeThreads = mergeNarrativeThreads(turnEntry.activeThreads, correctionSignals.activeThreads, 8);
                turnEntry.unresolvedQuestions = pushNarrativeUniqueLimited(turnEntry.unresolvedQuestions, correctionSignals.unresolvedQuestions, 6, { maxChars: 140 });
                turnEntry.nextBeatHints = pushNarrativeUniqueLimited(turnEntry.nextBeatHints, correctionSignals.nextBeatHints, 6, { maxChars: 140 });
                turnEntry.relationPressure = pushNarrativeUniqueLimited(turnEntry.relationPressure, correctionSignals.relationPressure, 6, { maxChars: 140 });
                turnEntry.locationState = correctionSignals.locationState || turnEntry.locationState;
                turnEntry.temporalState = correctionSignals.temporalState || turnEntry.temporalState;
                turnEntry.memoryRefs = pushNarrativeUniqueLimited(turnEntry.memoryRefs, correctionSignals.memoryRefs, 8, { maxChars: 80 });
                turnEntry.evidenceTurns = pushNarrativeUniqueLimited(turnEntry.evidenceTurns, correctionSignals.evidenceTurns, 8, { maxChars: 40 });
                turnEntry.dedupeKeys = Array.from(new Set([...(turnEntry.dedupeKeys || []), ...(correctionSignals.dedupeKeys || [])].filter(Boolean))).slice(0, 10);
            }
            if (nextEntities.length > 0) {
                turnEntry.involvedEntities = Array.from(new Set(nextEntities));
            }
            const nextSceneDate = compactTimeFieldText(updates.sceneDate || updates.currentDate || '', 80);
            const nextSceneTime = compactTimeFieldText(updates.sceneTime || updates.currentTime || '', 40);
            const nextSceneTimeLabel = compactTimeFieldText(updates.sceneTimeLabel || updates.timeLabel || '', 160);
            if (nextSceneDate) turnEntry.sceneDate = nextSceneDate;
            if (nextSceneTime) turnEntry.sceneTime = nextSceneTime;
            if (nextSceneTimeLabel) turnEntry.sceneTimeLabel = nextSceneTimeLabel;
            if (nextSceneTimeLabel || nextSceneDate || nextSceneTime) {
                turnEntry.temporalState = {
                    ...(turnEntry.temporalState && typeof turnEntry.temporalState === 'object' ? turnEntry.temporalState : {}),
                    label: nextSceneTimeLabel || turnEntry.temporalState?.label || '',
                    date: nextSceneDate || turnEntry.temporalState?.date || '',
                    time: nextSceneTime || turnEntry.temporalState?.time || ''
                };
            }
            const arcPatch = buildNarrativeArcPatch(turnEntry, updates || {});
            if (arcPatch.arcKey || arcPatch.name || arcPatch.keyPoints.length || arcPatch.ongoingTensions.length) {
                turnEntry.narrativeArc = arcPatch;
            }

            removeTurnFromStorylines(targetTurn);
            assignToStoryline(turnEntry, { forceArc: !!arcPatch.arcKey });
            return true;
        };

        const assignToStoryline = (turnEntry, options = {}) => {
            const entities = Array.from(new Set((Array.isArray(turnEntry.involvedEntities) ? turnEntry.involvedEntities : []).map(String).filter(Boolean)));
            const arcPatch = turnEntry.narrativeArc && typeof turnEntry.narrativeArc === 'object'
                ? turnEntry.narrativeArc
                : buildNarrativeArcPatch(turnEntry, {});
            if (arcPatch?.arcKey || arcPatch?.name) turnEntry.narrativeArc = arcPatch;
            const arcKey = String(arcPatch?.arcKey || '').trim();
            const activeThreads = mergeNarrativeThreads([], turnEntry.activeThreads, 8);
            const recentBrief = clipText(turnEntry.lastDistinctEvent || turnEntry.continuityBrief || turnEntry.summary || turnEntry.response || '', 220);

            let bestMatch = null;
            let bestScore = 0;

            if (arcKey) {
                bestMatch = narrativeState.storylines.find(storyline => String(storyline?.arcKey || '').trim() === arcKey && isConcreteNarrativeArcKey(arcKey)) || null;
            }

            if (!bestMatch) {
                for (const storyline of narrativeState.storylines) {
                    const storylineArc = String(storyline?.arcKey || '').trim();
                    if (isConcreteNarrativeArcKey(arcKey) && isConcreteNarrativeArcKey(storylineArc) && storylineArc !== arcKey) {
                        continue;
                    }
                    const entityScore = narrativeEntitiesOverlapScore(entities, storyline.entities);
                    const threadScore = narrativeThreadOverlapScore(activeThreads, storyline.activeThreads);
                    const arcScore = arcKey && storylineArc === arcKey ? 1 : 0;
                    const genericBoost = (isGenericNarrativeStorylineName(storyline?.name) || isGenericNarrativeArcKey(storylineArc)) && (entityScore > 0 || threadScore > 0) ? 0.15 : 0;
                    const score = Math.max(entityScore, threadScore, arcScore) + genericBoost;
                    const threshold = arcKey ? 0.35 : 0.45;
                    if (score > bestScore && score >= threshold) {
                        bestScore = score;
                        bestMatch = storyline;
                    }
                }
            }

            if (bestMatch) {
                bestMatch.turns = Array.isArray(bestMatch.turns) ? bestMatch.turns : [];
                if (!bestMatch.turns.includes(turnEntry.turn)) bestMatch.turns.push(turnEntry.turn);
                bestMatch.turns = Array.from(new Set(bestMatch.turns.map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
                bestMatch.firstTurn = bestMatch.turns[0] || turnEntry.turn;
                bestMatch.lastTurn = bestMatch.turns[bestMatch.turns.length - 1] || turnEntry.turn;
                for (const e of entities) {
                    bestMatch.entities = pushNarrativeEntity(bestMatch.entities, e);
                }
                if (arcPatch?.name && (!bestMatch.name || isGenericNarrativeStorylineName(bestMatch.name))) bestMatch.name = arcPatch.name;
                // 서사 식별자에 문장이 들어오지 않게 한다. sanitize 를 우회한 경로
                // (04b/04f 콜드스타트, 09a 월드 DLC) 로 문장이 흘러들면 storyline
                // arcKey 와 이름이 문장 전체로 오염된다.
                const safeArcKey = (() => {
                    const v = String(arcKey || '').trim();
                    if (!v || v.length > 60) return '';
                    if (/[.!?。！？]\s|\s{2,}/.test(v)) return '';
                    if ((v.match(/[_-]/g) || []).length > 6) return '';
                    if (/(?:은|는|이|가|을|를|했다|한다|있었다|입니다|합니다)(?:_|$)/.test(v) && v.length > 24) return '';
                    return v;
                })();
                if (safeArcKey && (!bestMatch.arcKey || isGenericNarrativeArcKey(bestMatch.arcKey))) bestMatch.arcKey = safeArcKey;
                if (arcPatch?.primaryConflict) bestMatch.primaryConflict = arcPatch.primaryConflict;
                if (arcPatch?.phase) bestMatch.phase = arcPatch.phase;
                bestMatch.recentEvents = Array.isArray(bestMatch.recentEvents) ? bestMatch.recentEvents.filter(item => Number(item?.turn || 0) !== Number(turnEntry.turn || 0)) : [];
                bestMatch.recentEvents.push({
                    turn: turnEntry.turn,
                    brief: recentBrief,
                    arcKey: bestMatch.arcKey || ''
                });
                if (bestMatch.recentEvents.length > 10) {
                    bestMatch.recentEvents = bestMatch.recentEvents.slice(-10);
                }
                applyLiveNarrativeSnapshot(bestMatch, turnEntry);
            } else if (entities.length > 0 || arcKey || activeThreads.length > 0 || (recentBrief && narrativeState.storylines.length === 0)) {
                const id = (narrativeState.storylines || []).reduce((max, item) => Math.max(max, Number(item?.id || 0)), 0) + 1;
                const storyline = {
                    id,
                    name: arcPatch?.name || (recentBrief ? '현재 장면' : `Storyline #${id}`),
                    arcKey: arcKey || makeNarrativeArcKey(arcPatch?.name || recentBrief || `Storyline #${id}`),
                    phase: arcPatch?.phase || '',
                    primaryConflict: arcPatch?.primaryConflict || '',
                    entities: [...entities],
                    turns: [turnEntry.turn],
                    firstTurn: turnEntry.turn,
                    lastTurn: turnEntry.turn,
                    recentEvents: [{
                        turn: turnEntry.turn,
                        brief: recentBrief,
                        arcKey: arcKey || ''
                    }],
                    summaries: [],
                    currentContext: '',
                    continuityBrief: turnEntry.continuityBrief || '',
                    lastDistinctEvent: turnEntry.lastDistinctEvent || recentBrief,
                    sceneLocation: turnEntry.sceneLocation || turnEntry.locationState?.current || '',
                    locationState: turnEntry.locationState && typeof turnEntry.locationState === 'object' ? safeClone(turnEntry.locationState) : null,
                    temporalState: turnEntry.temporalState && typeof turnEntry.temporalState === 'object' ? safeClone(turnEntry.temporalState) : null,
                    keyPoints: arcPatch?.keyPoints || [],
                    ongoingTensions: arcPatch?.ongoingTensions || [],
                    activeThreads,
                    unresolvedQuestions: normalizeNarrativeStringArray(turnEntry.unresolvedQuestions, 8, 140),
                    nextBeatHints: normalizeNarrativeStringArray(turnEntry.nextBeatHints, 8, 140),
                    relationPressure: normalizeNarrativeStringArray(turnEntry.relationPressure, 8, 140),
                    memoryRefs: normalizeNarrativeStringArray(turnEntry.memoryRefs, 12, 80),
                    evidenceTurns: normalizeNarrativeStringArray(turnEntry.evidenceTurns, 12, 40),
                    dedupeKeys: normalizeNarrativeStringArray(turnEntry.dedupeKeys, 12, 160),
                    meta: { manualLocked: false, manualLockedAt: 0 }
                };
                applyLiveNarrativeSnapshot(storyline, turnEntry);
                narrativeState.storylines.push(storyline);
            }
            narrativeState.storylines = mergeNarrativeStorylines(narrativeState.storylines);
        };

        const summarizeIfNeeded = async (currentTurn) => {
            if (currentTurn - narrativeState.lastSummaryTurn < SUMMARY_INTERVAL) return;
            let summarized = false;
            for (const storyline of narrativeState.storylines) {
                const manualLocked = storyline?.meta?.manualLocked === true;
                const recentTurns = narrativeState.turnLog.filter(
                    t => storyline.turns.includes(t.turn) && t.turn > (storyline.summaries.length > 0 ? storyline.summaries[storyline.summaries.length - 1].upToTurn : 0)
                );
                if (recentTurns.length < 3) continue;
                if (manualLocked) continue;
                const brief = clipText(pushNarrativeUniqueLimited(
                    [],
                    recentTurns.map(t => t.continuityBrief || t.lastDistinctEvent || t.summary || t.response || '').filter(Boolean),
                    4,
                    { maxChars: 180 }
                ).join(' -> '), 240);
                storyline.summaries = (storyline.summaries || []).filter(entry => entry?.live !== true);
                const summaryKeyPoints = pushUniqueLimited([], recentTurns.flatMap(t => [
                    ...(Array.isArray(t.stateChanges) ? t.stateChanges : []),
                    ...(Array.isArray(t.distinctEvents) ? t.distinctEvents : []),
                    ...deriveKeyPointsFromBrief(t.continuityBrief || t.summary || t.response || '')
                ]), 8);
                const summaryTensions = pushUniqueLimited([], recentTurns.flatMap(t => deriveOngoingTensionsFromTurn(t)), 8);
                const summaryThreads = mergeNarrativeThreads([], recentTurns.flatMap(t => Array.isArray(t.activeThreads) ? t.activeThreads : []), 8);
                storyline.summaries.push({
                    upToTurn: currentTurn,
                    summary: brief,
                    keyPoints: summaryKeyPoints,
                    ongoingTensions: summaryTensions,
                    timestamp: Date.now(),
                    arcKey: storyline.arcKey || '',
                    continuityBrief: brief,
                    lastDistinctEvent: clipText(recentTurns[recentTurns.length - 1]?.lastDistinctEvent || '', 220),
                    activeThreads: summaryThreads,
                    nextBeatHints: pushNarrativeUniqueLimited([], recentTurns.flatMap(t => t.nextBeatHints || []), 6, { maxChars: 140 }),
                    evidenceTurns: pushNarrativeUniqueLimited([], recentTurns.flatMap(t => t.evidenceTurns || []), 12, { maxChars: 40 })
                });
                storyline.currentContext = brief;
                storyline.continuityBrief = brief;
                storyline.keyPoints = pushUniqueLimited(storyline.keyPoints, summaryKeyPoints, 12);
                storyline.ongoingTensions = pushUniqueLimited(storyline.ongoingTensions, summaryTensions, 10);
                storyline.activeThreads = mergeNarrativeThreads(storyline.activeThreads, summaryThreads, 8);
                summarized = true;
            }
            if (summarized) narrativeState.lastSummaryTurn = currentTurn;
        };

        const formatForPrompt = () => {
            const promptState = buildPromptState();
            const promptStorylines = Array.isArray(promptState.storylines) ? promptState.storylines : [];
            if (promptStorylines.length === 0) return '';

            const parts = ['【내러티브 현황 / Narrative Status】'];

            for (const storyline of promptStorylines) {
                parts.push(`\n[${storyline.name}] (Entities: ${storyline.entities.join(', ')})`);
                const flow = clipText(storyline.continuityBrief || storyline.currentContext || '', 260);
                if (flow) {
                    parts.push(`  Flow: ${flow}`);
                }
                const stateBits = [];
                const location = clipText(storyline.sceneLocation || storyline.locationState?.current || '', 100);
                const timeLabel = [
                    String(storyline.lastSceneTimeLabel || storyline.temporalState?.label || '').trim()
                    || [String(storyline.lastSceneDate || storyline.temporalState?.date || '').trim(), String(storyline.lastSceneTime || storyline.temporalState?.time || '').trim()].filter(Boolean).join(' ')
                ]
                    .filter(Boolean)
                    .join(' ');
                if (location) stateBits.push(`location=${location}`);
                if (timeLabel) stateBits.push(`time=${timeLabel}`);
                const relation = normalizeNarrativeStringArray(storyline.relationPressure, 2, 140);
                if (relation.length) stateBits.push(`relation=${relation.join('; ')}`);
                if (stateBits.length) {
                    parts.push(`  State: ${stateBits.join(' | ')}`);
                }
                const openThreads = mergeNarrativeThreads([], storyline.activeThreads, 5)
                    .map(thread => `${thread.label}${thread.status ? `: ${thread.status}` : ''}`);
                if (openThreads.length > 0) {
                    parts.push(`  Open Threads: ${openThreads.join('; ')}`);
                } else if (Array.isArray(storyline.ongoingTensions) && storyline.ongoingTensions.length > 0) {
                    parts.push(`  Open Threads: ${storyline.ongoingTensions.slice(-5).join('; ')}`);
                }
                const nextBeats = normalizeNarrativeStringArray(storyline.nextBeatHints, 3, 140);
                if (nextBeats.length) {
                    parts.push(`  Next: ${nextBeats.join('; ')}`);
                }
                const progression = pushNarrativeUniqueLimited(
                    [],
                    normalizeNarrativeStringArray(storyline.keyPoints, 5, 150),
                    4,
                    { maxChars: 150, exclude: [flow, ...openThreads, ...nextBeats] }
                );
                if (progression.length > 0) {
                    parts.push(`  Progression: ${progression.join('; ')}`);
                }
                const evidence = normalizeNarrativeStringArray(storyline.evidenceTurns, 8, 40);
                if (evidence.length) {
                    parts.push(`  Evidence: ${evidence.join(', ')}`);
                }
                if (storyline.recentEvents.length > 0) {
                    const last3 = storyline.recentEvents.slice(-3);
                    parts.push(`  Recent: ${last3.map(e => {
                        const matchedTurn = narrativeState.turnLog.find(t => Number(t?.turn || 0) === Number(e.turn || 0));
                        const timeLabel = String(matchedTurn?.sceneTimeLabel || '').trim()
                            || [String(matchedTurn?.sceneDate || '').trim(), String(matchedTurn?.sceneTime || '').trim()].filter(Boolean).join(' ');
                        const brief = clipText(matchedTurn?.lastDistinctEvent || e.brief || '', 180);
                        return `T${e.turn}${timeLabel ? ` @ ${timeLabel}` : ''}: ${brief}`;
                    }).join(' → ')}`);
                }
            }

            return parts.join('\n');
        };

        const normalizeRenameEntityKey = (value = '') => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
        const renameEntityList = (items = [], oldName = '', newName = '', previousNames = []) => {
            const oldKeys = new Set([oldName, ...(Array.isArray(previousNames) ? previousNames : [])].map(normalizeRenameEntityKey).filter(Boolean));
            let changed = false;
            const next = dedupeTextArray((Array.isArray(items) ? items : [])
                .map(item => {
                    const raw = typeof item === 'string' ? item : item?.name;
                    if (!raw) return '';
                    if (oldKeys.has(normalizeRenameEntityKey(raw))) {
                        changed = true;
                        return newName;
                    }
                    return String(raw || '').trim();
                })
                .filter(Boolean));
            return { list: next, changed };
        };
        const renameEntityReferences = (oldName = '', newName = '', options = {}) => {
            const oldText = String(oldName || '').trim();
            const newText = String(newName || '').trim();
            if (!oldText || !newText || normalizeRenameEntityKey(oldText) === normalizeRenameEntityKey(newText)) return { changed: false };
            const previousNames = Array.isArray(options.previousNames) ? options.previousNames : [];
            let changed = false;
            const rewriteTurn = (entry = {}) => {
                if (!entry || typeof entry !== 'object') return entry;
                for (const key of ['involvedEntities', 'mentionedEntityNames']) {
                    if (!Array.isArray(entry[key])) continue;
                    const renamed = renameEntityList(entry[key], oldText, newText, previousNames);
                    if (renamed.changed) {
                        entry[key] = renamed.list;
                        changed = true;
                    }
                }
                if (entry.narrativeArc && typeof entry.narrativeArc === 'object' && Array.isArray(entry.narrativeArc.entities)) {
                    const renamed = renameEntityList(entry.narrativeArc.entities, oldText, newText, previousNames);
                    if (renamed.changed) {
                        entry.narrativeArc.entities = renamed.list;
                        changed = true;
                    }
                }
                return entry;
            };
            narrativeState.turnLog = (Array.isArray(narrativeState.turnLog) ? narrativeState.turnLog : []).map(rewriteTurn);
            narrativeState.metaTurnLog = (Array.isArray(narrativeState.metaTurnLog) ? narrativeState.metaTurnLog : []).map(rewriteTurn);
            narrativeState.storylines = (Array.isArray(narrativeState.storylines) ? narrativeState.storylines : []).map(storyline => {
                if (!storyline || typeof storyline !== 'object') return storyline;
                if (Array.isArray(storyline.entities)) {
                    const renamed = renameEntityList(storyline.entities, oldText, newText, previousNames);
                    if (renamed.changed) {
                        storyline.entities = renamed.list;
                        changed = true;
                    }
                }
                return storyline;
            });
            if (changed) narrativeState.storylines = mergeNarrativeStorylines(narrativeState.storylines);
            return { changed };
        };

        const getState = () => narrativeState;
        const resetState = (nextState = null) => {
            narrativeState = normalizeState(nextState);
            return narrativeState;
        };

        return { loadState, saveState, recordTurn, correctTurn, summarizeIfNeeded, formatForPrompt, renameEntityReferences, getState, resetState, buildHeuristicTurnBrief };
    })();

    // ══════════════════════════════════════════════════════════════
    // [MANAGER] V4.2 Narrative Orchestration Port
    // Ports the V4.2 author/director reasoning model while preserving the
    // current single-call maintenance pipeline, commit gate, relation model,
    // Resource Governor, and direct-injection runtime.
    // ══════════════════════════════════════════════════════════════
    const NarrativeOrchestrationCore = (() => {
        const SCHEMA_VERSION = 2;
        const VALID_SCENE_PHASES = new Set(['setup', 'development', 'escalation', 'turning_point', 'aftermath', 'transition']);
        const VALID_BEAT_TYPES = new Set(['dialogue', 'decision', 'reveal', 'confrontation', 'intimacy', 'interruption', 'consequence', 'transition']);
        const VALID_EXECUTION_MODES = new Set(['subtle', 'balanced', 'forceful', 'absolute']);
        const VALID_PLANNER_STATUS = new Set(['active', 'dirty', 'stale', 'retracted']);
        const VALID_REFRESH_MODES = new Set(['full', 'light', 'reuse']);
        let lastSceneContract = null;
        let lastNarrativeDiagnostics = null;

        const clone = (value) => {
            try { return JSON.parse(JSON.stringify(value)); }
            catch { return value; }
        };
        const clip = (value = '', max = 220) => truncateForLLM(
            String(value || '').replace(/\s+/g, ' ').trim(),
            Math.max(20, Number(max || 220)),
            ' ... '
        );
        const list = (items = [], limit = 6, max = 180) => dedupeTextArray(
            (Array.isArray(items) ? items : (items ? [items] : []))
                .map(item => typeof item === 'string' ? item : (item?.label || item?.text || item?.summary || item?.name || ''))
                .map(item => clip(item, max))
                .filter(Boolean)
        ).slice(0, Math.max(1, Number(limit || 6)));
        const clamp01 = (value, fallback = 0) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
        };
        const normalizeEnum = (value, valid, fallback) => {
            const normalized = String(value || '').trim().toLowerCase();
            return valid.has(normalized) ? normalized : fallback;
        };
        const normalizeScenePhase = (value, fallback = '') => {
            const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            if (VALID_SCENE_PHASES.has(normalized)) return normalized;
            if (/(?:turning|turning_point|climax|decisive_reveal|major_reveal)/.test(normalized)) return 'turning_point';
            if (/(?:aftermath|consequence|resolution|cooldown|recovery)/.test(normalized)) return 'aftermath';
            if (/(?:transition|scene_change|travel|relocation|time_skip)/.test(normalized)) return 'transition';
            if (/(?:escalation|confrontation|conflict|crisis|attack|chase)/.test(normalized)) return 'escalation';
            if (/(?:development|investigation|exploration|dialogue|discovery|build_up)/.test(normalized)) return 'development';
            if (/(?:setup|introduction|opening|arrival|establish)/.test(normalized)) return 'setup';
            return fallback;
        };
        const collectSourceMessageIds = (payload = {}) => normalizeCanonicalMessageIds([
            payload?.sourceMessageIds,
            payload?.liveMessageIds,
            payload?.messageId,
            payload?.m_id,
            payload?.initialMessageId,
            payload?.finalizedMessageId,
            payload?.assistantMessageId,
            payload?.turnState?.sourceMessageIds,
            payload?.turnState?.liveMessageIds,
            payload?.turnState?.messageId,
            payload?.turnState?.initialMessageId,
            payload?.turnState?.finalizedMessageId
        ]).slice(0, 24);
        const tokenSet = (value = '') => new Set(String(value || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .split(/\s+/)
            .map(item => item.trim())
            .filter(item => item.length >= 2)
            .slice(0, 120));
        const jaccard = (left = '', right = '') => {
            const a = tokenSet(left);
            const b = tokenSet(right);
            if (!a.size || !b.size) return 0;
            let intersection = 0;
            for (const item of a) if (b.has(item)) intersection += 1;
            return intersection / Math.max(1, a.size + b.size - intersection);
        };
        const normalizeSignatureText = (value = '') => String(value || '')
            .toLowerCase()
            .replace(/turn\s*\d+\s*:/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        const buildSignature = (value) => {
            try { return String(TokenizerEngine.simpleHash(JSON.stringify(value)) || '').trim(); }
            catch { return String(TokenizerEngine.simpleHash(String(value || '')) || '').trim(); }
        };
        const inferUserIntentType = (value = '') => {
            const text = String(value || '').trim();
            if (!text) return 'empty_continue';
            if (/^(?:\[?ooc\]?|\(?ooc\)?|out\s*of\s*character|메타|정정|설정\s*(?:수정|변경)|오타\s*수정)/i.test(text)) return 'ooc_correction';
            if (/^[“"'「『]|[”"'」』]$/.test(text) || /(?:라고|라며|말했|묻|대답|외쳤|속삭)/.test(text)) return 'ic_dialogue';
            if (/\?|어떻게|무엇|왜|어디|언제|누가|해줘|해라|하자|부탁|please|could you|would you/i.test(text)) return 'request_or_choice';
            return 'ic_action';
        };
        const pickLines = (text = '', limit = 4, max = 180) => list(
            String(text || '').split(/\r?\n/).map(line => line.replace(/^[-*#\s]+/, '').trim()).filter(Boolean),
            limit,
            max
        );
        const buildSceneContract = (payload = {}) => {
            const turn = Math.max(0, Number(payload?.turn || MemoryEngine.getCurrentTurn?.() || 0));
            const userText = String(payload?.userMsg || payload?.strictUserMsg || payload?.userMsgForNarrative || '').trim();
            const focusedEntities = list(payload?.focusedEntities || payload?.involvedEntities || [], 8, 80);
            const explicitParticipants = list(
                payload?.activeParticipants || payload?.visibleParticipants || payload?.currentParticipants || [],
                8,
                80
            );
            const currentTurnText = `${userText} ${String(payload?.aiResponse || payload?.assistantEvidenceText || '').trim()}`.toLowerCase();
            const mentionedParticipants = focusedEntities.filter(name => currentTurnText.includes(String(name || '').toLowerCase()));
            const activeParticipants = explicitParticipants.length
                ? explicitParticipants
                : (mentionedParticipants.length ? mentionedParticipants : focusedEntities.slice(0, 4));
            const worldState = (() => { try { return WorldStateTracker.getState?.() || {}; } catch { return {}; } })();
            const timeState = (() => { try { return TimeEngine.getState?.() || {}; } catch { return {}; } })();
            const narrativeState = (() => { try { return NarrativeTracker.getState?.() || {}; } catch { return {}; } })();
            const relationSignals = list(payload?.relationStateSignals || payload?.relationTexts || [], 6, 180);
            const authorState = (() => { try { return WmResultProjection.plannerState(StoryAuthor?.getState?.() || {}, payload.wmResultContext); } catch { return {}; } })();
            const latestWorldTurn = Array.isArray(worldState?.turnLog) && worldState.turnLog.length
                ? worldState.turnLog[worldState.turnLog.length - 1]
                : null;
            const location = clip(
                payload?.location
                || payload?.sectionWorldMeta?.location
                || latestWorldTurn?.currentLocation
                || latestWorldTurn?.location
                || worldState?.currentLocation
                || worldState?.location
                || '',
                120
            );
            const sceneTime = clip(
                payload?.sceneTime
                || payload?.timeState
                || [timeState?.currentDate, timeState?.currentTime].filter(Boolean).join(' ')
                || latestWorldTurn?.currentTime
                || latestWorldTurn?.time
                || worldState?.currentTime
                || '',
                120
            );
            const worldRules = list([
                ...(payload?.activeWorldRules || []),
                ...pickLines(payload?.worldPrompt || '', 3, 180),
                ...pickLines(payload?.worldStatePrompt || '', 3, 180)
            ], 6, 180);
            const unresolvedThreads = list([
                ...(authorState?.openQuestions || []),
                ...(authorState?.activeTensions || []),
                ...((Array.isArray(narrativeState?.storylines) ? narrativeState.storylines : [])
                    .flatMap(item => item?.ongoingTensions || item?.openThreads || [])
                    .slice(-8))
            ], 8, 180);
            const userAgencyLocks = [
                'Do not decide the user persona’s actions, consent, private feelings, desire, bodily reaction, or final choice.',
                'Respond to the latest user turn before following lower-priority planner guidance.'
            ];
            const hardContinuityLocks = list([
                ...worldRules,
                ...relationSignals.slice(0, 3),
                ...(payload?.hardContinuityLocks || [])
            ], 8, 180);
            const protectedSecrets = list(payload?.protectedSecrets || [], 6, 160);
            const forbiddenJumps = list([
                'Do not skip or replace the current user turn.',
                'Do not change location, time, participants, relationship state, or established knowledge without current-turn cause.',
                'Do not turn predicted pressure into an already completed canon event.',
                ...(payload?.forbiddenJumps || [])
            ], 8, 180);
            const intentType = inferUserIntentType(userText);
            const sceneKey = {
                location,
                sceneTime,
                activeParticipants,
                worldRules: worldRules.slice(0, 3),
                relationSignals: relationSignals.slice(0, 3)
            };
            const sceneId = String(payload?.sceneId || buildSignature(sceneKey) || `scene-${turn}`).trim();
            const contract = {
                schema: 'libra.scene_contract.v2',
                schemaVersion: SCHEMA_VERSION,
                sceneId,
                turn,
                sourceMessageIds: collectSourceMessageIds(payload),
                currentUserIntent: clip(userText || 'Continue the immediately active scene from its current state.', 240),
                userIntentType: intentType,
                povEntity: clip(payload?.povEntity || '', 80),
                activeParticipants,
                location,
                sceneTime,
                hardContinuityLocks,
                userAgencyLocks,
                protectedSecrets,
                activeWorldRules: worldRules,
                currentRelationshipStates: relationSignals,
                unresolvedThreads,
                forbiddenJumps,
                allowedTransitionLevel: intentType === 'empty_continue' ? 'soft_continuation_only' : 'no_major_jump_without_user_signal',
                confidence: (location || sceneTime || focusedEntities.length || unresolvedThreads.length) ? 0.78 : 0.48,
                status: 'active',
                generatedAt: Date.now()
            };
            contract.signature = buildSignature({
                sceneId: contract.sceneId,
                activeParticipants: contract.activeParticipants,
                location: contract.location,
                sceneTime: contract.sceneTime,
                userIntentType: contract.userIntentType,
                hardContinuityLocks: contract.hardContinuityLocks,
                currentRelationshipStates: contract.currentRelationshipStates
            });
            if (payload?.recordRuntime !== false) lastSceneContract = clone(contract);
            return contract;
        };
        const buildNarrativeDiagnostics = (payload = {}, sceneContract = null) => {
            const contract = sceneContract || buildSceneContract(payload);
            // Preserve duplicate turn signatures here. Generic list() intentionally
            // deduplicates prompt fields, but repetition diagnostics must observe
            // repeated beats and repeated wording rather than erasing them first.
            const recentTurns = (Array.isArray(payload?.recentTurns) ? payload.recentTurns : [])
                .map(item => {
                    if (typeof item === 'string') return clip(item, 360);
                    return clip(
                        item?.assistant
                        || item?.ai
                        || item?.response
                        || item?.summary
                        || item?.brief
                        || item?.text
                        || '',
                        360
                    );
                })
                .filter(Boolean)
                .slice(-8);
            const previousAuthor = (() => { try { return WmResultProjection.plannerState(StoryAuthor?.getState?.() || {}, payload.wmResultContext); } catch { return {}; } })();
            let maxSimilarity = 0;
            for (let i = 0; i < recentTurns.length; i += 1) {
                for (let j = i + 1; j < recentTurns.length; j += 1) {
                    maxSimilarity = Math.max(maxSimilarity, jaccard(normalizeSignatureText(recentTurns[i]), normalizeSignatureText(recentTurns[j])));
                }
            }
            const repetitiveMicroReactionCount = recentTurns.slice(-4).filter(text => /(시선|눈빛|고개|입술|숨|호흡|손끝|침묵|바라|gaze|eyes|lips|breath|silence|fingers)/i.test(text)).length;
            const stateChangeSignals = [
                ...(payload?.stateChangeSignals || []),
                ...(payload?.canonicalPacket?.narrative?.scene_deltas || payload?.canonicalPacket?.narrative?.sceneDeltas || []),
                ...(payload?.canonicalPacket?.memory?.events || [])
            ];
            const repetitionRisk = clamp01(Math.max(maxSimilarity, repetitiveMicroReactionCount >= 4 ? 0.78 : repetitiveMicroReactionCount >= 3 ? 0.58 : 0.2), 0.2);
            const emptyInput = contract.userIntentType === 'empty_continue';
            const stallRisk = clamp01(
                (emptyInput ? 0.48 : 0.18)
                + (stateChangeSignals.length ? -0.12 : 0.18)
                + (repetitionRisk > 0.7 ? 0.18 : 0),
                0.3
            );
            const momentumScore = clamp01(1 - (stallRisk * 0.55 + repetitionRisk * 0.35), 0.55);
            const turn = Math.max(0, Number(payload?.turn || 0));
            const scenePhase = normalizeScenePhase(
                payload?.scenePhase || previousAuthor?.scenePhase,
                turn <= 1 ? 'setup' : (momentumScore < 0.35 ? 'development' : (turn % 7 === 0 ? 'turning_point' : 'development'))
            );
            const openTensions = list([
                ...(previousAuthor?.activeTensions || []),
                ...(contract?.unresolvedThreads || []),
                ...(payload?.openTensions || [])
            ], 8, 180);
            const payoffCandidates = list([
                ...(previousAuthor?.payoffCandidates || []),
                ...(payload?.payoffCandidates || []),
                ...openTensions.slice(0, 3).map(item => `Potential payoff: ${item}`)
            ], 6, 180);
            const recommendedBeatType = normalizeEnum(
                payload?.recommendedBeatType,
                VALID_BEAT_TYPES,
                contract.userIntentType === 'ooc_correction' ? 'consequence'
                    : contract.userIntentType === 'request_or_choice' ? 'decision'
                        : emptyInput ? 'interruption'
                            : repetitionRisk >= 0.68 ? 'reveal'
                                : 'dialogue'
            );
            const diagnostics = {
                schema: 'libra.narrative_diagnostics.v2',
                schemaVersion: SCHEMA_VERSION,
                turn,
                sceneId: contract.sceneId,
                scenePhase,
                momentumScore,
                stallRisk,
                repetitionRisk,
                dialogueLoopRisk: clamp01(repetitiveMicroReactionCount / 4, 0),
                openTensions,
                payoffCandidates,
                recommendedBeatType,
                recommendedPacing: stallRisk >= 0.7 ? 'introduce-grounded-change' : (repetitionRisk >= 0.65 ? 'vary-beat-and-state' : 'follow-current-user-rhythm'),
                userIntentAlignment: contract.userIntentType === 'empty_continue'
                    ? 'Continue the active scene without restarting or inventing a new premise.'
                    : 'The latest user input is the primary response axis; planner guidance may only support it.',
                doNotResolveYet: list([
                    ...(previousAuthor?.doNotResolveYet || []),
                    ...openTensions.slice(1, 5),
                    ...(payload?.doNotResolveYet || [])
                ], 6, 180),
                sceneExitReadiness: contract.userIntentType === 'request_or_choice' && /떠나|종료|끝|전환|leave|end|transition/i.test(contract.currentUserIntent)
                    ? 'user_signaled_transition'
                    : 'low_without_user_signal',
                guardrails: list([
                    'Do not replace the current user input with memory, world, entity, relationship, or planner inference.',
                    'Do not resolve protected open tensions merely to create artificial momentum.',
                    'Treat world and relationship pressure as constraints or possibilities, not forced outcomes.',
                    ...(payload?.narrativeGuardrails || [])
                ], 8, 200),
                repeatedPatternSignals: list([
                    maxSimilarity >= 0.62 ? `recent_turn_similarity:${maxSimilarity.toFixed(2)}` : '',
                    repetitiveMicroReactionCount >= 3 ? `micro_reaction_loop:${repetitiveMicroReactionCount}` : ''
                ], 4, 120),
                status: 'active',
                generatedAt: Date.now()
            };
            diagnostics.signature = buildSignature({
                sceneId: diagnostics.sceneId,
                scenePhase: diagnostics.scenePhase,
                openTensions: diagnostics.openTensions,
                recommendedBeatType: diagnostics.recommendedBeatType,
                doNotResolveYet: diagnostics.doNotResolveYet,
                repeatedPatternSignals: diagnostics.repeatedPatternSignals
            });
            if (payload?.recordRuntime !== false) lastNarrativeDiagnostics = clone(diagnostics);
            return diagnostics;
        };
        const normalizePlannerMeta = (meta = {}, fallback = {}) => {
            const source = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
            const status = normalizeEnum(source.status, VALID_PLANNER_STATUS, fallback.status || 'active');
            const refreshMode = normalizeEnum(source.refreshMode, VALID_REFRESH_MODES, fallback.refreshMode || 'light');
            return {
                schema: 'libra.planner_provenance.v2',
                schemaVersion: SCHEMA_VERSION,
                sourceMessageIds: normalizeCanonicalMessageIds(source.sourceMessageIds || fallback.sourceMessageIds || []).slice(0, 24),
                sourceRevision: Math.max(0, Number(source.sourceRevision ?? fallback.sourceRevision ?? 0) || 0),
                inputSignature: String(source.inputSignature || fallback.inputSignature || '').trim(),
                lastObservedSourceMessageIds: normalizeCanonicalMessageIds(
                    source.lastObservedSourceMessageIds || fallback.lastObservedSourceMessageIds || []
                ).slice(0, 24),
                lastObservedInputSignature: String(source.lastObservedInputSignature || fallback.lastObservedInputSignature || '').trim(),
                contextSignature: String(source.contextSignature || fallback.contextSignature || '').trim(),
                ...((source.wmResultVersion || fallback.wmResultVersion) ? { wmResultVersion: String(source.wmResultVersion || fallback.wmResultVersion) } : {}),
                sceneContractSignature: String(source.sceneContractSignature || fallback.sceneContractSignature || '').trim(),
                diagnosticsSignature: String(source.diagnosticsSignature || fallback.diagnosticsSignature || '').trim(),
                generatedAtTurn: Math.max(0, Number(source.generatedAtTurn ?? fallback.generatedAtTurn ?? 0) || 0),
                validUntilTurn: Math.max(0, Number(source.validUntilTurn ?? fallback.validUntilTurn ?? 0) || 0),
                lastObservedTurn: Math.max(0, Number(source.lastObservedTurn ?? fallback.lastObservedTurn ?? 0) || 0),
                status,
                dirtyReasons: list(source.dirtyReasons || fallback.dirtyReasons || [], 10, 140),
                refreshMode,
                reuseCount: Math.max(0, Number(source.reuseCount ?? fallback.reuseCount ?? 0) || 0),
                generatedAt: Math.max(0, Number(source.generatedAt ?? fallback.generatedAt ?? Date.now()) || Date.now()),
                updatedAt: Math.max(0, Number(source.updatedAt ?? fallback.updatedAt ?? Date.now()) || Date.now())
            };
        };
        const buildPlannerProvenance = (payload = {}, refreshMode = 'light') => {
            const sceneContract = payload?.sceneContract || lastSceneContract || buildSceneContract(payload);
            const diagnostics = payload?.narrativeDiagnostics || lastNarrativeDiagnostics || buildNarrativeDiagnostics(payload, sceneContract);
            const turn = Math.max(0, Number(payload?.turn || 0));
            const contextSignature = buildSignature({
                sceneId: sceneContract?.sceneId || '',
                participants: sceneContract?.activeParticipants || [],
                location: sceneContract?.location || '',
                sceneTime: sceneContract?.sceneTime || '',
                relationStates: sceneContract?.currentRelationshipStates || [],
                activeWorldRules: sceneContract?.activeWorldRules || [],
                openTensions: diagnostics?.openTensions || [],
                userIntentType: sceneContract?.userIntentType || '',
                wmResultVersion: payload?.wmResultSnapshot?.version || ''
            });
            const inputSignature = buildSignature({
                user: clip(payload?.userMsg || payload?.strictUserMsg || '', 600),
                assistant: clip(payload?.aiResponse || payload?.assistantEvidenceText || '', 900),
                contextSignature
            });
            return normalizePlannerMeta({
                sourceMessageIds: collectSourceMessageIds(payload),
                sourceRevision: Math.max(0, Number(payload?.sourceRevision || turn) || turn),
                inputSignature,
                contextSignature,
                sceneContractSignature: String(sceneContract?.signature || '').trim(),
                diagnosticsSignature: String(diagnostics?.signature || '').trim(),
                generatedAtTurn: turn,
                validUntilTurn: turn + 4,
                lastObservedTurn: turn,
                status: 'active',
                dirtyReasons: [],
                refreshMode,
                reuseCount: refreshMode === 'reuse' ? 1 : 0,
                generatedAt: Date.now(),
                updatedAt: Date.now()
            });
        };
        const resolveRefreshModes = (payload = {}, currentTurn = 0, config = MemoryEngine.CONFIG) => {
            const sceneContract = payload?.sceneContract || buildSceneContract({ ...payload, turn: currentTurn });
            const diagnostics = payload?.narrativeDiagnostics || buildNarrativeDiagnostics({ ...payload, turn: currentTurn }, sceneContract);
            const authorState = (() => { try { return WmResultProjection.plannerState(StoryAuthor?.getState?.() || {}, payload.wmResultContext); } catch { return {}; } })();
            const directorState = (() => { try { return WmResultProjection.plannerState(Director?.getState?.() || {}, payload.wmResultContext); } catch { return {}; } })();
            const priorMeta = authorState?.plannerMeta || directorState?.plannerMeta || {};
            const currentMeta = buildPlannerProvenance({ ...payload, turn: currentTurn, sceneContract, narrativeDiagnostics: diagnostics }, 'light');
            const reasons = [];
            const intentType = sceneContract?.userIntentType || '';
            const priorStatus = String(priorMeta?.status || 'active').trim().toLowerCase();
            if (['dirty', 'stale', 'retracted'].includes(priorStatus)) reasons.push(`prior_${priorStatus}`);
            if (intentType === 'ooc_correction') reasons.push('explicit_ooc_correction');
            if (priorMeta?.sceneContractSignature && priorMeta.sceneContractSignature !== currentMeta.sceneContractSignature) reasons.push('scene_contract_changed');
            if (priorMeta?.contextSignature && priorMeta.contextSignature !== currentMeta.contextSignature) reasons.push('planner_context_changed');
            if (diagnostics?.repetitionRisk >= 0.72) reasons.push('high_repetition_risk');
            if (diagnostics?.stallRisk >= 0.75) reasons.push('high_stall_risk');
            if (Array.isArray(payload?.mutationReasons) && payload.mutationReasons.length) reasons.push(...payload.mutationReasons.map(item => String(item || '').trim()).filter(Boolean));
            if (config?.forceFullTurnRefresh === true) reasons.push('forced_full_refresh');
            const authorAge = Math.max(0, Number(currentTurn || 0) - Number(authorState?.lastPlanTurn || 0));
            const directorAge = Math.max(0, Number(currentTurn || 0) - Number(directorState?.lastTurn || 0));
            let storyAuthor = 'light';
            let director = 'light';
            if (reasons.some(reason => /retracted|stale|ooc|scene_contract|forced_full|mutation/.test(reason)) || authorAge >= 4) storyAuthor = 'full';
            else if (priorMeta?.contextSignature === currentMeta.contextSignature && authorAge <= 1 && (authorState?.nextBeats || []).length) storyAuthor = 'reuse';
            if (reasons.some(reason => /retracted|stale|ooc|scene_contract|forced_full|mutation/.test(reason)) || directorAge >= 3) director = 'full';
            else if (storyAuthor === 'reuse' && priorMeta?.contextSignature === currentMeta.contextSignature && directorAge <= 1 && directorState?.sceneMandate) director = 'reuse';
            if (diagnostics?.repetitionRisk >= 0.72 || diagnostics?.stallRisk >= 0.75) {
                if (storyAuthor === 'reuse') storyAuthor = 'light';
                if (director === 'reuse') director = 'light';
            }
            return {
                storyAuthor,
                director,
                reasons: list(reasons, 12, 120),
                sceneContract,
                narrativeDiagnostics: diagnostics,
                plannerProvenance: currentMeta
            };
        };
        const buildAuthorPlanInputs = (plan = {}) => list([
            plan?.narrativeGoal ? `goal:${plan.narrativeGoal}` : '',
            plan?.primaryTension ? `primary_tension:${plan.primaryTension}` : '',
            plan?.recommendedBeatType ? `beat:${plan.recommendedBeatType}` : '',
            ...(plan?.nextBeats || []).map(item => `next:${item}`),
            ...(plan?.doNotResolveYet || []).map(item => `preserve:${item}`),
            ...(plan?.guardrails || []).slice(0, 2).map(item => `guard:${item}`)
        ], 10, 200);
        const conflictsWithPreservedThread = (outcome = '', preserved = []) => {
            const outcomeText = String(outcome || '').trim();
            if (!outcomeText) return false;
            return (Array.isArray(preserved) ? preserved : []).some(item => {
                const target = String(item || '').trim();
                if (!target) return false;
                return jaccard(outcomeText, target) >= 0.68 || normalizeSignatureText(outcomeText).includes(normalizeSignatureText(target));
            });
        };
        const validateDirectorHandoff = (directive = {}, authorPlan = {}, payload = {}, config = MemoryEngine.CONFIG) => {
            const source = directive && typeof directive === 'object' && !Array.isArray(directive) ? directive : {};
            const authorInputs = buildAuthorPlanInputs(authorPlan);
            const preserved = list(authorPlan?.doNotResolveYet || payload?.narrativeDiagnostics?.doNotResolveYet || [], 8, 180);
            const sceneLocks = list([
                ...(payload?.sceneContract?.hardContinuityLocks || []),
                ...(payload?.sceneContract?.userAgencyLocks || []),
                ...preserved.map(item => `Preserve unresolved thread: ${item}`)
            ], 10, 200);
            const directorMode = String(config?.directorMode || 'light').trim().toLowerCase();
            const fallbackExecution = directorMode === 'absolute' ? 'absolute' : directorMode === 'strong' ? 'forceful' : directorMode === 'light' ? 'subtle' : 'balanced';
            const beatType = normalizeEnum(source.beatTypeToExecute || authorPlan?.recommendedBeatType, VALID_BEAT_TYPES, 'dialogue');
            const requiredOutcomes = list(source.requiredOutcomes || [], 8, 180)
                .filter(item => !conflictsWithPreservedThread(item, preserved));
            const forbiddenMoves = list([
                ...(source.forbiddenMoves || []),
                ...preserved.map(item => `Do not resolve yet: ${item}`),
                'Do not invent a new narrative goal that replaces the Story Author plan.',
                'Do not override the latest user input, user agency, consent, or explicit correction.'
            ], 10, 200);
            return {
                ...source,
                executionMode: normalizeEnum(source.executionMode, VALID_EXECUTION_MODES, fallbackExecution),
                beatTypeToExecute: beatType,
                requiredOutcomes,
                forbiddenMoves,
                emphasis: list(source.emphasis || [], 8, 180),
                stagingInstructions: list(source.stagingInstructions || [], 8, 180),
                dialogueInstructions: list(source.dialogueInstructions || [], 8, 180),
                pacingInstructions: list(source.pacingInstructions || [], 8, 180),
                continuityLocks: list([...(source.continuityLocks || []), ...sceneLocks], 12, 200),
                authorPlanInputs: list([...(source.authorPlanInputs || []), ...authorInputs], 10, 200),
                worldManagerInputs: list(source.worldManagerInputs || authorPlan?.worldManagerHints || payload?.worldManagerHints || [], 8, 180),
                endingRequirement: clip(source.endingRequirement || '', 220)
            };
        };
        const formatSceneContractForPrompt = (contract = lastSceneContract) => {
            if (!contract || typeof contract !== 'object') return '';
            const parts = ['【장면 계약 / Scene Contract】'];
            if (contract.currentUserIntent) parts.push(`Current User Intent: ${contract.currentUserIntent}`);
            if (contract.userIntentType) parts.push(`Intent Type: ${contract.userIntentType}`);
            if (contract.activeParticipants?.length) parts.push(`Participants: ${contract.activeParticipants.join(', ')}`);
            if (contract.location) parts.push(`Location: ${contract.location}`);
            if (contract.sceneTime) parts.push(`Scene Time: ${contract.sceneTime}`);
            if (contract.hardContinuityLocks?.length) parts.push(`Continuity Locks: ${contract.hardContinuityLocks.join('; ')}`);
            if (contract.userAgencyLocks?.length) parts.push(`User Agency Locks: ${contract.userAgencyLocks.join('; ')}`);
            if (contract.protectedSecrets?.length) parts.push(`Protected Secrets: ${contract.protectedSecrets.join('; ')}`);
            if (contract.unresolvedThreads?.length) parts.push(`Unresolved Before Transition: ${contract.unresolvedThreads.join('; ')}`);
            if (contract.forbiddenJumps?.length) parts.push(`Forbidden Jumps: ${contract.forbiddenJumps.join('; ')}`);
            return parts.join('\n');
        };
        const formatDiagnosticsForPrompt = (diagnostics = lastNarrativeDiagnostics) => {
            if (!diagnostics || typeof diagnostics !== 'object') return '';
            const parts = ['【서사 진단 / Narrative Diagnostics】'];
            if (diagnostics.scenePhase) parts.push(`Scene Phase: ${diagnostics.scenePhase}`);
            parts.push(`Momentum: ${Number(diagnostics.momentumScore || 0).toFixed(2)} | Stall Risk: ${Number(diagnostics.stallRisk || 0).toFixed(2)} | Repetition Risk: ${Number(diagnostics.repetitionRisk || 0).toFixed(2)}`);
            if (diagnostics.recommendedBeatType) parts.push(`Recommended Beat: ${diagnostics.recommendedBeatType}`);
            if (diagnostics.recommendedPacing) parts.push(`Recommended Pacing: ${diagnostics.recommendedPacing}`);
            if (diagnostics.userIntentAlignment) parts.push(`User Intent Alignment: ${diagnostics.userIntentAlignment}`);
            if (diagnostics.openTensions?.length) parts.push(`Open Tensions: ${diagnostics.openTensions.join('; ')}`);
            if (diagnostics.doNotResolveYet?.length) parts.push(`Do Not Resolve Yet: ${diagnostics.doNotResolveYet.join('; ')}`);
            if (diagnostics.guardrails?.length) parts.push(`Diagnostic Guardrails: ${diagnostics.guardrails.join('; ')}`);
            return parts.join('\n');
        };
        const getSceneContract = () => clone(lastSceneContract);
        const getNarrativeDiagnostics = () => clone(lastNarrativeDiagnostics);
        const recordSceneContract = (value = null) => {
            lastSceneContract = value && typeof value === 'object' ? clone(value) : null;
            return getSceneContract();
        };
        const recordNarrativeDiagnostics = (value = null) => {
            lastNarrativeDiagnostics = value && typeof value === 'object' ? clone(value) : null;
            return getNarrativeDiagnostics();
        };
        return {
            SCHEMA_VERSION,
            VALID_SCENE_PHASES,
            VALID_BEAT_TYPES,
            VALID_EXECUTION_MODES,
            VALID_PLANNER_STATUS,
            VALID_REFRESH_MODES,
            clip,
            list,
            normalizeEnum,
            normalizeScenePhase,
            collectSourceMessageIds,
            buildSceneContract,
            buildNarrativeDiagnostics,
            normalizePlannerMeta,
            buildPlannerProvenance,
            resolveRefreshModes,
            buildAuthorPlanInputs,
            validateDirectorHandoff,
            formatSceneContractForPrompt,
            formatDiagnosticsForPrompt,
            getSceneContract,
            getNarrativeDiagnostics,
            recordSceneContract,
            recordNarrativeDiagnostics
        };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_NarrativeOrchestrationCore = NarrativeOrchestrationCore;
    } catch (_) { /* optional diagnostics only */ }

    const StoryAuthor = (() => {
        const AUTHOR_COMMENT = 'lmai_story_author';
        const defaultState = () => ({
            schema: 'libra.story_author.v2',
            schemaVersion: NarrativeOrchestrationCore.SCHEMA_VERSION,
            currentArc: '',
            narrativeGoal: '',
            scenePhase: '',
            activeTensions: [],
            primaryTension: '',
            openQuestions: [],
            payoffCandidates: [],
            recommendedBeatType: '',
            nextBeats: [],
            beatReason: '',
            escalationDelta: 0,
            guardrails: [],
            doNotResolveYet: [],
            entityContextHints: [],
            relationStateSignals: [],
            worldManagerHints: [],
            environmentPressures: [],
            storylineCarryoverSignals: [],
            focusCharacters: [],
            recentDecisions: [],
            userIntentAlignment: '',
            sceneContract: null,
            narrativeDiagnostics: null,
            plannerMeta: NarrativeOrchestrationCore.normalizePlannerMeta({}, { status: 'stale', refreshMode: 'full' }),
            autoAdvanceOnEmptyInput: true,
            lastPlanTurn: 0,
            lastUpdated: 0
        });
        let authorState = defaultState();
        const clip = NarrativeOrchestrationCore.clip;
        const list = NarrativeOrchestrationCore.list;
        const normalizeState = (state = null) => {
            const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
            return {
                ...defaultState(),
                schema: 'libra.story_author.v2',
                schemaVersion: NarrativeOrchestrationCore.SCHEMA_VERSION,
                currentArc: clip(source.currentArc || '', 140),
                narrativeGoal: clip(source.narrativeGoal || '', 260),
                scenePhase: NarrativeOrchestrationCore.normalizeScenePhase(source.scenePhase, ''),
                activeTensions: list(source.activeTensions, 8, 180),
                primaryTension: clip(source.primaryTension || '', 200),
                openQuestions: list(source.openQuestions, 8, 180),
                payoffCandidates: list(source.payoffCandidates, 8, 180),
                recommendedBeatType: NarrativeOrchestrationCore.normalizeEnum(source.recommendedBeatType, NarrativeOrchestrationCore.VALID_BEAT_TYPES, ''),
                nextBeats: list(source.nextBeats, 8, 180),
                beatReason: clip(source.beatReason || '', 220),
                escalationDelta: Math.max(-3, Math.min(3, Number(source.escalationDelta || 0) || 0)),
                guardrails: list(source.guardrails, 8, 200),
                doNotResolveYet: list(source.doNotResolveYet, 8, 180),
                entityContextHints: list(source.entityContextHints, 8, 180),
                relationStateSignals: list(source.relationStateSignals, 8, 180),
                worldManagerHints: list(source.worldManagerHints, 8, 180),
                environmentPressures: list(source.environmentPressures, 8, 180),
                storylineCarryoverSignals: list(source.storylineCarryoverSignals, 8, 180),
                focusCharacters: list(source.focusCharacters, 8, 80),
                recentDecisions: list(source.recentDecisions, 10, 180),
                userIntentAlignment: clip(source.userIntentAlignment || '', 220),
                sceneContract: source.sceneContract && typeof source.sceneContract === 'object' ? safeClone(source.sceneContract) : null,
                narrativeDiagnostics: source.narrativeDiagnostics && typeof source.narrativeDiagnostics === 'object' ? safeClone(source.narrativeDiagnostics) : null,
                plannerMeta: NarrativeOrchestrationCore.normalizePlannerMeta(source.plannerMeta || source.provenance || {}, {
                    status: source.lastPlanTurn ? 'active' : 'stale',
                    generatedAtTurn: Number(source.lastPlanTurn || 0),
                    validUntilTurn: Number(source.lastPlanTurn || 0) + 4,
                    refreshMode: source.lastPlanTurn ? 'light' : 'full'
                }),
                autoAdvanceOnEmptyInput: source.autoAdvanceOnEmptyInput !== false,
                lastPlanTurn: Number(source.lastPlanTurn || 0) || 0,
                lastUpdated: Number(source.lastUpdated || 0) || 0
            };
        };
        const loadState = (lorebook = []) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .find(item => item?.comment === AUTHOR_COMMENT);
            if (!entry) {
                authorState = defaultState();
                NarrativeOrchestrationCore.recordSceneContract(null);
                NarrativeOrchestrationCore.recordNarrativeDiagnostics(null);
                return authorState;
            }
            try {
                authorState = normalizeState(JSON.parse(entry.content || '{}'));
                NarrativeOrchestrationCore.recordSceneContract(authorState.sceneContract);
                NarrativeOrchestrationCore.recordNarrativeDiagnostics(authorState.narrativeDiagnostics);
            } catch (e) {
                authorState = defaultState();
                NarrativeOrchestrationCore.recordSceneContract(null);
                NarrativeOrchestrationCore.recordNarrativeDiagnostics(null);
                recordRuntimeDebug('warn', '[LIBRA] Story author state parse failed:', e?.message || e);
            }
            return authorState;
        };
        const saveState = async (lorebook = []) => {
            if (!Array.isArray(lorebook)) return;
            const entry = {
                key: 'lmai_story_author::plan',
                comment: AUTHOR_COMMENT,
                content: JSON.stringify(authorState),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(item => item?.comment === AUTHOR_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };
        const buildHeuristicPlan = (payload = {}, mode = 'proactive') => {
            const previousState = WmResultProjection.plannerState(authorState, payload.wmResultContext);
            const focused = list(payload.focusedEntities || [], 8, 80);
            const diagnostics = payload?.narrativeDiagnostics || NarrativeOrchestrationCore.buildNarrativeDiagnostics(payload, payload?.sceneContract);
            const sceneContract = payload?.sceneContract || NarrativeOrchestrationCore.buildSceneContract(payload);
            const supportive = mode === 'supportive';
            const aggressive = mode === 'aggressive';
            const nextBeats = [];
            if (diagnostics.repetitionRisk >= 0.65) nextBeats.push('Change the beat type or produce a concrete state change instead of repeating the previous emotional confirmation.');
            if (focused.length > 0) nextBeats.push(supportive
                ? `${focused[0]} may respond through a scene-grounded action or dialogue that fits the user-led rhythm.`
                : `${focused[0]} should take a scene-grounded action or decision that changes at least one visible state.`);
            if (payload.worldStatePrompt) nextBeats.push('Use current world and relationship pressure as constraints or possibilities, not guaranteed outcomes.');
            if (payload.isEmptyInput) nextBeats.push('Continue from the immediately active scene without restarting it and advance one grounded beat.');
            if (aggressive) nextBeats.push('Before the response ends, create a meaningful consequence, decision, reveal, interruption, or relationship shift.');
            return {
                currentArc: previousState.currentArc || 'Ongoing Story',
                narrativeGoal: previousState.narrativeGoal || (payload.isEmptyInput
                    ? 'Continue the active scene from its current state without inventing a new premise.'
                    : 'Align the next story beat with the latest user input and confirmed continuity.'),
                scenePhase: diagnostics.scenePhase,
                activeTensions: diagnostics.openTensions?.length ? diagnostics.openTensions : ['Preserve the most relevant unresolved tension without forcing a premature payoff.'],
                primaryTension: diagnostics.openTensions?.[0] || '',
                openQuestions: previousState.openQuestions || [],
                payoffCandidates: diagnostics.payoffCandidates || [],
                recommendedBeatType: diagnostics.recommendedBeatType,
                nextBeats,
                beatReason: diagnostics.repetitionRisk >= 0.65 ? 'A different beat is needed to avoid narrative repetition.' : 'The next beat should answer the current user intent while preserving continuity.',
                escalationDelta: aggressive ? 1 : 0,
                guardrails: diagnostics.guardrails || [],
                doNotResolveYet: diagnostics.doNotResolveYet || [],
                entityContextHints: list(payload.entityContextHints || payload.entityTexts || [], 6, 180),
                relationStateSignals: list(payload.relationStateSignals || payload.relationTexts || [], 6, 180),
                worldManagerHints: list(payload.worldManagerHints || [], 6, 180),
                environmentPressures: list(payload.environmentPressures || [], 6, 180),
                storylineCarryoverSignals: list(payload.storylineCarryoverSignals || payload.recentTurns || [], 6, 180),
                focusCharacters: focused,
                recentDecisions: [],
                userIntentAlignment: diagnostics.userIntentAlignment,
                sceneContract,
                narrativeDiagnostics: diagnostics
            };
        };
        const isPlanUsable = (turn = MemoryEngine.getCurrentTurn?.() || 0) => {
            const meta = authorState?.plannerMeta || {};
            if (!['active', 'dirty'].includes(String(meta.status || ''))) return false;
            if (Number(meta.validUntilTurn || 0) > 0 && Number(turn || 0) > Number(meta.validUntilTurn || 0)) return false;
            return Boolean(authorState.narrativeGoal || authorState.nextBeats?.length || authorState.primaryTension);
        };
        const applyPlanState = (currentTurn, nextPlan = null, payload = {}, config = MemoryEngine.CONFIG) => {
            const mode = String(config?.storyAuthorMode || 'disabled').toLowerCase();
            if (config?.storyAuthorEnabled !== true || mode === 'disabled') return authorState;
            const previousState = WmResultProjection.plannerState(authorState, payload.wmResultContext);
            const refreshMode = NarrativeOrchestrationCore.normalizeEnum(
                payload?.plannerRefreshModes?.storyAuthor || payload?.plannerRefreshMode || nextPlan?.refreshMode,
                NarrativeOrchestrationCore.VALID_REFRESH_MODES,
                'light'
            );
            const sceneContract = payload?.sceneContract || NarrativeOrchestrationCore.buildSceneContract({ ...payload, turn: currentTurn });
            const diagnostics = payload?.narrativeDiagnostics || NarrativeOrchestrationCore.buildNarrativeDiagnostics({ ...payload, turn: currentTurn }, sceneContract);
            const provenance = NarrativeOrchestrationCore.normalizePlannerMeta(
                payload?.plannerProvenance || NarrativeOrchestrationCore.buildPlannerProvenance({ ...payload, turn: currentTurn, sceneContract, narrativeDiagnostics: diagnostics }, refreshMode),
                previousState?.plannerMeta || {}
            );
            if (previousState === authorState && refreshMode === 'reuse' && isPlanUsable(currentTurn)) {
                authorState = normalizeState({
                    ...previousState,
                    sceneContract,
                    narrativeDiagnostics: diagnostics,
                    userIntentAlignment: diagnostics.userIntentAlignment || previousState.userIntentAlignment,
                    plannerMeta: {
                        ...previousState.plannerMeta,
                        status: 'active',
                        dirtyReasons: [],
                        refreshMode: 'reuse',
                        reuseCount: Number(previousState?.plannerMeta?.reuseCount || 0) + 1,
                        lastObservedTurn: currentTurn,
                        lastObservedSourceMessageIds: provenance.sourceMessageIds || [],
                        lastObservedInputSignature: provenance.inputSignature || '',
                        validUntilTurn: Math.max(Number(previousState?.plannerMeta?.validUntilTurn || 0), currentTurn + 2),
                        updatedAt: Date.now()
                    },
                    lastPlanTurn: Number(currentTurn || 0) || previousState.lastPlanTurn,
                    lastUpdated: Date.now()
                });
                NarrativeOrchestrationCore.recordSceneContract(sceneContract);
                NarrativeOrchestrationCore.recordNarrativeDiagnostics(diagnostics);
                return authorState;
            }
            const plan = nextPlan && typeof nextPlan === 'object' ? nextPlan : buildHeuristicPlan({ ...payload, sceneContract, narrativeDiagnostics: diagnostics }, mode);
            authorState = normalizeState({
                ...previousState,
                ...plan,
                currentArc: plan.currentArc || previousState.currentArc,
                narrativeGoal: plan.narrativeGoal || previousState.narrativeGoal,
                scenePhase: NarrativeOrchestrationCore.normalizeScenePhase(plan.scenePhase, '') || diagnostics.scenePhase || previousState.scenePhase,
                activeTensions: Array.isArray(plan.activeTensions) ? plan.activeTensions : diagnostics.openTensions,
                primaryTension: plan.primaryTension || diagnostics.openTensions?.[0] || previousState.primaryTension,
                openQuestions: Array.isArray(plan.openQuestions) ? plan.openQuestions : previousState.openQuestions,
                payoffCandidates: Array.isArray(plan.payoffCandidates) ? plan.payoffCandidates : diagnostics.payoffCandidates,
                recommendedBeatType: plan.recommendedBeatType || diagnostics.recommendedBeatType,
                nextBeats: Array.isArray(plan.nextBeats) ? plan.nextBeats : previousState.nextBeats,
                beatReason: plan.beatReason || previousState.beatReason,
                escalationDelta: Number.isFinite(Number(plan.escalationDelta)) ? Number(plan.escalationDelta) : previousState.escalationDelta,
                guardrails: Array.isArray(plan.guardrails) ? plan.guardrails : diagnostics.guardrails,
                doNotResolveYet: Array.isArray(plan.doNotResolveYet) ? plan.doNotResolveYet : diagnostics.doNotResolveYet,
                entityContextHints: Array.isArray(plan.entityContextHints) ? plan.entityContextHints : (payload.entityContextHints || payload.entityTexts || previousState.entityContextHints),
                relationStateSignals: Array.isArray(plan.relationStateSignals) ? plan.relationStateSignals : (payload.relationStateSignals || payload.relationTexts || previousState.relationStateSignals),
                worldManagerHints: Array.isArray(plan.worldManagerHints) ? plan.worldManagerHints : (payload.worldManagerHints || previousState.worldManagerHints),
                environmentPressures: Array.isArray(plan.environmentPressures) ? plan.environmentPressures : (payload.environmentPressures || previousState.environmentPressures),
                storylineCarryoverSignals: Array.isArray(plan.storylineCarryoverSignals) ? plan.storylineCarryoverSignals : (payload.storylineCarryoverSignals || previousState.storylineCarryoverSignals),
                focusCharacters: Array.isArray(plan.focusCharacters) ? plan.focusCharacters : (payload.focusedEntities || previousState.focusCharacters),
                recentDecisions: [...(previousState.recentDecisions || []), ...(Array.isArray(plan.recentDecisions) ? plan.recentDecisions : [])],
                userIntentAlignment: plan.userIntentAlignment || diagnostics.userIntentAlignment || previousState.userIntentAlignment,
                sceneContract,
                narrativeDiagnostics: diagnostics,
                plannerMeta: {
                    ...provenance,
                    status: 'active',
                    dirtyReasons: [],
                    refreshMode,
                    reuseCount: 0,
                    generatedAtTurn: currentTurn,
                    validUntilTurn: currentTurn + 4,
                    lastObservedTurn: currentTurn,
                    updatedAt: Date.now()
                },
                lastPlanTurn: Number(currentTurn || 0) || previousState.lastPlanTurn,
                lastUpdated: Date.now()
            });
            NarrativeOrchestrationCore.recordSceneContract(sceneContract);
            NarrativeOrchestrationCore.recordNarrativeDiagnostics(diagnostics);
            return authorState;
        };
        const markDirty = (reason = 'context_changed', options = {}) => {
            const status = NarrativeOrchestrationCore.normalizeEnum(options?.status, NarrativeOrchestrationCore.VALID_PLANNER_STATUS, 'dirty');
            authorState = normalizeState({
                ...authorState,
                plannerMeta: {
                    ...(authorState.plannerMeta || {}),
                    status,
                    dirtyReasons: list([...(authorState?.plannerMeta?.dirtyReasons || []), reason], 10, 140),
                    updatedAt: Date.now()
                },
                lastUpdated: Date.now()
            });
            return authorState;
        };
        const invalidateBySourceIds = (sourceIds = [], options = {}) => {
            const ids = normalizeCanonicalMessageIds(sourceIds);
            if (!ids.length || !hasCanonicalMessageIdOverlap(authorState?.plannerMeta?.sourceMessageIds || [], ids)) return false;
            markDirty(options?.reason || 'source_message_invalidated', { status: options?.status || 'stale' });
            return true;
        };
        const formatForPrompt = (resultContext = null) => {
            if (!WmResultProjection.plannerAllowed(authorState.plannerMeta, resultContext)) return '';
            const mode = String(MemoryEngine.CONFIG?.storyAuthorMode || 'disabled').toLowerCase();
            if (MemoryEngine.CONFIG?.storyAuthorEnabled !== true || mode === 'disabled') return '';
            const planUsable = isPlanUsable();
            const parts = ['【스토리 작가 총괄 / Story Author Narrative Manager】'];
            parts.push('Authority boundary: Story Author owns narrative meaning, unresolved tensions, payoff timing, and next-beat intent. It does not write dialogue orders, staging commands, mandatory user actions, or fixed outcomes; those belong to Director or the main response model.');
            parts.push('Host-preset boundary: this plan is continuity guidance only. It must preserve the active RisuAI preset and latest user contract for language, response length, style, POV, formatting, required headings/tags, and assistant prefill.');
            parts.push('The latest user input and explicit correction outrank this plan. Preserve user agency, consent, feelings, and final decisions.');
            if (mode === 'aggressive') parts.push('Aggressive mode: actively seek a consequential beat, but never replace the user’s current intent or force protected outcomes.');
            else if (mode === 'supportive') parts.push('Supportive mode: preserve user-led rhythm; a reflective or low-motion beat is valid when it meaningfully answers the user and maintains continuity.');
            else parts.push('Proactive mode: shape a clear next beat while keeping continuity and user intent primary.');
            // Scene Contract and Narrative Diagnostics are rebuilt from the current
            // request in beforeRequest and injected as separate control sections.
            // Do not embed the previous turn's stored snapshots inside the author
            // memo, or stale scene/user-intent data can outrank the live request.
            if (!planUsable) {
                parts.push(`Planner Status: ${authorState?.plannerMeta?.status || 'stale'}${authorState?.plannerMeta?.dirtyReasons?.length ? ` (${authorState.plannerMeta.dirtyReasons.join('; ')})` : ''}`);
                parts.push('The prior plan is not authoritative. Use only the current Scene Contract, Narrative Diagnostics, confirmed continuity, and latest user input until refreshed.');
                return parts.filter(Boolean).join('\n');
            }
            if (authorState.currentArc) parts.push(`Current Arc: ${authorState.currentArc}`);
            if (authorState.narrativeGoal) parts.push(`Narrative Goal: ${authorState.narrativeGoal}`);
            if (authorState.scenePhase) parts.push(`Scene Phase: ${authorState.scenePhase}`);
            if (authorState.userIntentAlignment) parts.push(`User Intent Alignment: ${authorState.userIntentAlignment}`);
            if (authorState.focusCharacters?.length) parts.push(`Focus Characters: ${authorState.focusCharacters.join(', ')}`);
            if (authorState.primaryTension) parts.push(`Primary Tension: ${authorState.primaryTension}`);
            if (authorState.activeTensions?.length) parts.push(`Active Tensions: ${authorState.activeTensions.join('; ')}`);
            if (authorState.openQuestions?.length) parts.push(`Open Questions: ${authorState.openQuestions.join('; ')}`);
            if (authorState.payoffCandidates?.length) parts.push(`Payoff Candidates: ${authorState.payoffCandidates.join('; ')}`);
            if (authorState.recommendedBeatType) parts.push(`Recommended Beat Type: ${authorState.recommendedBeatType}`);
            if (authorState.beatReason) parts.push(`Beat Reason: ${authorState.beatReason}`);
            if (authorState.nextBeats?.length) parts.push(`Next Beats: ${authorState.nextBeats.join('; ')}`);
            if (authorState.doNotResolveYet?.length) parts.push(`Do Not Resolve Yet: ${authorState.doNotResolveYet.join('; ')}`);
            if (authorState.guardrails?.length) parts.push(`Guardrails: ${authorState.guardrails.join('; ')}`);
            if (authorState.relationStateSignals?.length) parts.push(`Relationship Pressure: ${authorState.relationStateSignals.join('; ')}`);
            if (authorState.environmentPressures?.length) parts.push(`Environment Pressure: ${authorState.environmentPressures.join('; ')}`);
            return parts.filter(Boolean).join('\n');
        };
        const getState = () => authorState;
        const resetState = (nextState = null) => {
            authorState = normalizeState(nextState || defaultState());
            NarrativeOrchestrationCore.recordSceneContract(authorState.sceneContract);
            NarrativeOrchestrationCore.recordNarrativeDiagnostics(authorState.narrativeDiagnostics);
            return authorState;
        };
        const renameEntityReferences = (oldName = '', newName = '', options = {}) => {
            const newText = String(newName || '').trim();
            if (!newText) return { changed: false };
            const oldKeys = new Set([oldName, ...(Array.isArray(options?.previousNames) ? options.previousNames : [])]
                .map(item => String(item || '').normalize('NFKC').trim().toLowerCase())
                .filter(Boolean));
            if (oldKeys.size === 0) return { changed: false };
            let changed = false;
            const rewriteList = (items = []) => {
                const next = [];
                for (const item of Array.isArray(items) ? items : []) {
                    const text = String(item || '').trim();
                    const key = text.normalize('NFKC').toLowerCase();
                    const value = oldKeys.has(key) ? newText : text;
                    if (value !== text) changed = true;
                    if (value && !next.includes(value)) next.push(value);
                }
                return next;
            };
            authorState.focusCharacters = rewriteList(authorState.focusCharacters);
            if (authorState.sceneContract?.activeParticipants) authorState.sceneContract.activeParticipants = rewriteList(authorState.sceneContract.activeParticipants);
            return { changed };
        };
        return {
            loadState,
            saveState,
            applyPlanState,
            formatForPrompt,
            renameEntityReferences,
            getState,
            resetState,
            markDirty,
            invalidateBySourceIds,
            isPlanUsable,
            normalizeState
        };
    })();

    const Director = (() => {
        const DIRECTOR_COMMENT = 'lmai_director';
        const defaultState = () => ({
            schema: 'libra.director.v2',
            schemaVersion: NarrativeOrchestrationCore.SCHEMA_VERSION,
            sceneMandate: '',
            executionMode: 'balanced',
            beatTypeToExecute: '',
            requiredOutcomes: [],
            forbiddenMoves: [],
            emphasis: [],
            stagingInstructions: [],
            dialogueInstructions: [],
            pacingInstructions: [],
            continuityLocks: [],
            authorPlanInputs: [],
            worldManagerInputs: [],
            targetPacing: 'steady',
            pressureLevel: 'light',
            focusCharacters: [],
            endingRequirement: '',
            sceneContract: null,
            narrativeDiagnostics: null,
            plannerMeta: NarrativeOrchestrationCore.normalizePlannerMeta({}, { status: 'stale', refreshMode: 'full' }),
            lastTurn: 0,
            lastUpdated: 0
        });
        let directorState = defaultState();
        const clip = NarrativeOrchestrationCore.clip;
        const list = NarrativeOrchestrationCore.list;
        const normalizeState = (state = null) => {
            const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
            return {
                ...defaultState(),
                schema: 'libra.director.v2',
                schemaVersion: NarrativeOrchestrationCore.SCHEMA_VERSION,
                sceneMandate: clip(source.sceneMandate || '', 260),
                executionMode: NarrativeOrchestrationCore.normalizeEnum(source.executionMode, NarrativeOrchestrationCore.VALID_EXECUTION_MODES, 'balanced'),
                beatTypeToExecute: NarrativeOrchestrationCore.normalizeEnum(source.beatTypeToExecute, NarrativeOrchestrationCore.VALID_BEAT_TYPES, ''),
                requiredOutcomes: list(source.requiredOutcomes, 8, 180),
                forbiddenMoves: list(source.forbiddenMoves, 10, 200),
                emphasis: list(source.emphasis, 8, 180),
                stagingInstructions: list(source.stagingInstructions, 8, 180),
                dialogueInstructions: list(source.dialogueInstructions, 8, 180),
                pacingInstructions: list(source.pacingInstructions, 8, 180),
                continuityLocks: list(source.continuityLocks, 12, 200),
                authorPlanInputs: list(source.authorPlanInputs, 10, 200),
                worldManagerInputs: list(source.worldManagerInputs, 8, 180),
                targetPacing: clip(source.targetPacing || 'steady', 80) || 'steady',
                pressureLevel: clip(source.pressureLevel || 'light', 80) || 'light',
                focusCharacters: list(source.focusCharacters, 8, 80),
                endingRequirement: clip(source.endingRequirement || '', 240),
                sceneContract: source.sceneContract && typeof source.sceneContract === 'object' ? safeClone(source.sceneContract) : null,
                narrativeDiagnostics: source.narrativeDiagnostics && typeof source.narrativeDiagnostics === 'object' ? safeClone(source.narrativeDiagnostics) : null,
                plannerMeta: NarrativeOrchestrationCore.normalizePlannerMeta(source.plannerMeta || source.provenance || {}, {
                    status: source.lastTurn ? 'active' : 'stale',
                    generatedAtTurn: Number(source.lastTurn || 0),
                    validUntilTurn: Number(source.lastTurn || 0) + 4,
                    refreshMode: source.lastTurn ? 'light' : 'full'
                }),
                lastTurn: Number(source.lastTurn || 0) || 0,
                lastUpdated: Number(source.lastUpdated || 0) || 0
            };
        };
        const loadState = (lorebook = []) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .find(item => item?.comment === DIRECTOR_COMMENT);
            if (!entry) {
                directorState = defaultState();
                return directorState;
            }
            try {
                directorState = normalizeState(JSON.parse(entry.content || '{}'));
            } catch (e) {
                directorState = defaultState();
                recordRuntimeDebug('warn', '[LIBRA] Director state parse failed:', e?.message || e);
            }
            return directorState;
        };
        const saveState = async (lorebook = []) => {
            if (!Array.isArray(lorebook)) return;
            const entry = {
                key: 'lmai_director::directive',
                comment: DIRECTOR_COMMENT,
                content: JSON.stringify(directorState),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(item => item?.comment === DIRECTOR_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };
        const buildHeuristicDirective = (payload = {}, mode = 'light') => {
            const focused = list(payload.focusedEntities || [], 8, 80);
            const authorPlan = WmResultProjection.plannerState(payload?.storyAuthorState || StoryAuthor.getState?.() || {}, payload.wmResultContext);
            const diagnostics = payload?.narrativeDiagnostics || authorPlan?.narrativeDiagnostics || {};
            const requiredOutcomes = [];
            if (mode === 'absolute' || mode === 'strong') {
                requiredOutcomes.push(authorPlan?.nextBeats?.[0] || 'Create one visible, continuity-grounded change before the response ends.');
            } else if (authorPlan?.nextBeats?.[0]) {
                requiredOutcomes.push(`Where natural, realize this author beat: ${authorPlan.nextBeats[0]}`);
            }
            if (payload.isEmptyInput) requiredOutcomes.push('Continue from the immediately active scene without restarting or recapping it.');
            return NarrativeOrchestrationCore.validateDirectorHandoff({
                sceneMandate: mode === 'absolute'
                    ? 'Execute the approved author plan with unmistakable scene movement while preserving user agency and continuity.'
                    : mode === 'strong'
                        ? 'Execute the approved author plan through a clear scene beat, consequence, decision, reveal, or relationship shift.'
                        : 'Translate the approved author plan into scene-local pacing, staging, and emphasis without over-directing the user-led rhythm.',
                executionMode: mode === 'absolute' ? 'absolute' : mode === 'strong' ? 'forceful' : mode === 'light' ? 'subtle' : 'balanced',
                beatTypeToExecute: authorPlan?.recommendedBeatType || diagnostics?.recommendedBeatType || 'dialogue',
                requiredOutcomes,
                forbiddenMoves: [
                    'Do not create a new story goal independent of the Story Author plan.',
                    'Do not contradict established world rules, relationship states, known facts, or the latest user input.'
                ],
                emphasis: [
                    'Render direction through visible action, dialogue, pacing, or consequence rather than backstage explanation.'
                ],
                stagingInstructions: focused.length ? [`Keep staging centered on ${focused.join(', ')} unless the user introduces another active participant.`] : [],
                dialogueInstructions: ['Use remembered dialogue as voice and continuity evidence, not as lines to copy verbatim.'],
                pacingInstructions: [diagnostics?.recommendedPacing || 'Follow the current user-led rhythm.'],
                targetPacing: mode === 'absolute' ? 'relentless' : mode === 'strong' ? 'brisk' : mode === 'light' ? 'measured' : 'steady',
                pressureLevel: mode,
                focusCharacters: focused,
                endingRequirement: mode === 'absolute' ? 'End after a concrete state change or consequential turn, not before it.' : ''
            }, authorPlan, payload, MemoryEngine.CONFIG);
        };
        const isDirectiveUsable = (turn = MemoryEngine.getCurrentTurn?.() || 0) => {
            const meta = directorState?.plannerMeta || {};
            if (!['active', 'dirty'].includes(String(meta.status || ''))) return false;
            if (Number(meta.validUntilTurn || 0) > 0 && Number(turn || 0) > Number(meta.validUntilTurn || 0)) return false;
            return Boolean(directorState.sceneMandate || directorState.requiredOutcomes?.length || directorState.continuityLocks?.length);
        };
        const applyDirectiveState = (currentTurn, nextDirective = null, payload = {}, config = MemoryEngine.CONFIG) => {
            const mode = String(config?.directorMode || 'disabled').toLowerCase();
            if (config?.directorEnabled !== true || mode === 'disabled') return directorState;
            const previousState = WmResultProjection.plannerState(directorState, payload.wmResultContext);
            const refreshMode = NarrativeOrchestrationCore.normalizeEnum(
                payload?.plannerRefreshModes?.director || payload?.plannerRefreshMode || nextDirective?.refreshMode,
                NarrativeOrchestrationCore.VALID_REFRESH_MODES,
                'light'
            );
            const sceneContract = payload?.sceneContract || NarrativeOrchestrationCore.buildSceneContract({ ...payload, turn: currentTurn });
            const diagnostics = payload?.narrativeDiagnostics || NarrativeOrchestrationCore.buildNarrativeDiagnostics({ ...payload, turn: currentTurn }, sceneContract);
            const authorPlan = WmResultProjection.plannerState(payload?.storyAuthorState || StoryAuthor.getState?.() || {}, payload.wmResultContext);
            const provenance = NarrativeOrchestrationCore.normalizePlannerMeta(
                payload?.plannerProvenance || NarrativeOrchestrationCore.buildPlannerProvenance({ ...payload, turn: currentTurn, sceneContract, narrativeDiagnostics: diagnostics }, refreshMode),
                previousState?.plannerMeta || {}
            );
            if (previousState === directorState && refreshMode === 'reuse' && isDirectiveUsable(currentTurn)) {
                directorState = normalizeState({
                    ...previousState,
                    sceneContract,
                    narrativeDiagnostics: diagnostics,
                    authorPlanInputs: NarrativeOrchestrationCore.buildAuthorPlanInputs(authorPlan),
                    plannerMeta: {
                        ...previousState.plannerMeta,
                        status: 'active',
                        dirtyReasons: [],
                        refreshMode: 'reuse',
                        reuseCount: Number(previousState?.plannerMeta?.reuseCount || 0) + 1,
                        lastObservedTurn: currentTurn,
                        lastObservedSourceMessageIds: provenance.sourceMessageIds || [],
                        lastObservedInputSignature: provenance.inputSignature || '',
                        validUntilTurn: Math.max(Number(previousState?.plannerMeta?.validUntilTurn || 0), currentTurn + 2),
                        updatedAt: Date.now()
                    },
                    lastTurn: Number(currentTurn || 0) || previousState.lastTurn,
                    lastUpdated: Date.now()
                });
                return directorState;
            }
            const rawDirective = nextDirective && typeof nextDirective === 'object'
                ? nextDirective
                : buildHeuristicDirective({ ...payload, storyAuthorState: authorPlan, sceneContract, narrativeDiagnostics: diagnostics }, mode);
            const directive = NarrativeOrchestrationCore.validateDirectorHandoff(rawDirective, authorPlan, {
                ...payload,
                sceneContract,
                narrativeDiagnostics: diagnostics
            }, config);
            directorState = normalizeState({
                ...previousState,
                ...directive,
                sceneMandate: directive.sceneMandate || previousState.sceneMandate,
                focusCharacters: Array.isArray(directive.focusCharacters) ? directive.focusCharacters : (payload.focusedEntities || previousState.focusCharacters),
                sceneContract,
                narrativeDiagnostics: diagnostics,
                plannerMeta: {
                    ...provenance,
                    status: 'active',
                    dirtyReasons: [],
                    refreshMode,
                    reuseCount: 0,
                    generatedAtTurn: currentTurn,
                    validUntilTurn: currentTurn + 4,
                    lastObservedTurn: currentTurn,
                    updatedAt: Date.now()
                },
                lastTurn: Number(currentTurn || 0) || previousState.lastTurn,
                lastUpdated: Date.now()
            });
            return directorState;
        };
        const markDirty = (reason = 'context_changed', options = {}) => {
            const status = NarrativeOrchestrationCore.normalizeEnum(options?.status, NarrativeOrchestrationCore.VALID_PLANNER_STATUS, 'dirty');
            directorState = normalizeState({
                ...directorState,
                plannerMeta: {
                    ...(directorState.plannerMeta || {}),
                    status,
                    dirtyReasons: list([...(directorState?.plannerMeta?.dirtyReasons || []), reason], 10, 140),
                    updatedAt: Date.now()
                },
                lastUpdated: Date.now()
            });
            return directorState;
        };
        const invalidateBySourceIds = (sourceIds = [], options = {}) => {
            const ids = normalizeCanonicalMessageIds(sourceIds);
            if (!ids.length || !hasCanonicalMessageIdOverlap(directorState?.plannerMeta?.sourceMessageIds || [], ids)) return false;
            markDirty(options?.reason || 'source_message_invalidated', { status: options?.status || 'stale' });
            return true;
        };
        const formatForPrompt = (resultContext = null) => {
            if (!WmResultProjection.plannerAllowed(directorState.plannerMeta, resultContext)) return '';
            const mode = String(MemoryEngine.CONFIG?.directorMode || 'disabled').toLowerCase();
            if (MemoryEngine.CONFIG?.directorEnabled !== true || mode === 'disabled') return '';
            const usable = isDirectiveUsable();
            const parts = ['【감독 실행 지휘 / Director Execution Authority】'];
            parts.push('Authority boundary: Director owns execution only—staging, pacing, emphasis, forbidden moves, and visible response constraints. It must not create a new narrative goal or replace the Story Author plan.');
            parts.push('Host-preset boundary: execution guidance must not alter the active RisuAI preset or latest user contract for language, response length, prose style, POV, output format, required headings/tags, or assistant prefill.');
            parts.push('The latest user input, explicit correction, user agency, consent, and confirmed continuity outrank every directive below.');
            if (mode === 'light') parts.push('Light mode: apply subtle, scene-local guidance and preserve reflective pacing when appropriate.');
            else if (mode === 'absolute') parts.push('Absolute mode: strongly execute the approved plan, but never force the user persona or violate protected continuity.');
            else if (mode === 'strong') parts.push('Strong mode: create clear scene movement from the approved plan without independently re-planning the story.');
            else parts.push('Standard mode: convert the approved plan into firm but proportionate execution guidance.');
            if (!usable) {
                parts.push(`Planner Status: ${directorState?.plannerMeta?.status || 'stale'}${directorState?.plannerMeta?.dirtyReasons?.length ? ` (${directorState.plannerMeta.dirtyReasons.join('; ')})` : ''}`);
                parts.push('The prior directive is not authoritative. Follow the latest user input, current Scene Contract, confirmed continuity, and active Story Author plan until refreshed.');
                return parts.join('\n');
            }
            if (directorState.sceneMandate) parts.push(`Scene Mandate: ${directorState.sceneMandate}`);
            if (directorState.executionMode) parts.push(`Execution Mode: ${directorState.executionMode}`);
            if (directorState.beatTypeToExecute) parts.push(`Beat Type To Execute: ${directorState.beatTypeToExecute}`);
            if (directorState.focusCharacters?.length) parts.push(`Focus Characters: ${directorState.focusCharacters.join(', ')}`);
            if (directorState.targetPacing) parts.push(`Target Pacing: ${directorState.targetPacing}`);
            if (directorState.pressureLevel) parts.push(`Pressure Level: ${directorState.pressureLevel}`);
            if (directorState.requiredOutcomes?.length) parts.push(`Required Outcomes: ${directorState.requiredOutcomes.join('; ')}`);
            if (directorState.forbiddenMoves?.length) parts.push(`Forbidden Moves: ${directorState.forbiddenMoves.join('; ')}`);
            if (directorState.stagingInstructions?.length) parts.push(`Staging Instructions: ${directorState.stagingInstructions.join('; ')}`);
            if (directorState.dialogueInstructions?.length) parts.push(`Dialogue Instructions: ${directorState.dialogueInstructions.join('; ')}`);
            if (directorState.pacingInstructions?.length) parts.push(`Pacing Instructions: ${directorState.pacingInstructions.join('; ')}`);
            if (directorState.continuityLocks?.length) parts.push(`Continuity Locks: ${directorState.continuityLocks.join('; ')}`);
            if (directorState.authorPlanInputs?.length) parts.push(`Story Author Plan Inputs: ${directorState.authorPlanInputs.join('; ')}`);
            if (directorState.worldManagerInputs?.length) parts.push(`World Manager Inputs: ${directorState.worldManagerInputs.join('; ')}`);
            if (directorState.emphasis?.length) parts.push(`Emphasis: ${directorState.emphasis.join('; ')}`);
            if (directorState.endingRequirement) parts.push(`Ending Requirement: ${directorState.endingRequirement}`);
            return parts.filter(Boolean).join('\n');
        };
        const getState = () => directorState;
        const resetState = (nextState = null) => {
            directorState = normalizeState(nextState || defaultState());
            return directorState;
        };
        const renameEntityReferences = (oldName = '', newName = '', options = {}) => {
            const newText = String(newName || '').trim();
            if (!newText) return { changed: false };
            const oldKeys = new Set([oldName, ...(Array.isArray(options?.previousNames) ? options.previousNames : [])]
                .map(item => String(item || '').normalize('NFKC').trim().toLowerCase())
                .filter(Boolean));
            if (oldKeys.size === 0) return { changed: false };
            let changed = false;
            const rewriteList = (items = []) => {
                const next = [];
                for (const item of Array.isArray(items) ? items : []) {
                    const text = String(item || '').trim();
                    const key = text.normalize('NFKC').toLowerCase();
                    const value = oldKeys.has(key) ? newText : text;
                    if (value !== text) changed = true;
                    if (value && !next.includes(value)) next.push(value);
                }
                return next;
            };
            directorState.focusCharacters = rewriteList(directorState.focusCharacters);
            if (directorState.sceneContract?.activeParticipants) directorState.sceneContract.activeParticipants = rewriteList(directorState.sceneContract.activeParticipants);
            return { changed };
        };
        return {
            loadState,
            saveState,
            applyDirectiveState,
            formatForPrompt,
            renameEntityReferences,
            getState,
            resetState,
            markDirty,
            invalidateBySourceIds,
            isDirectiveUsable,
            normalizeState
        };
    })();

