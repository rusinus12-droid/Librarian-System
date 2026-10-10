    const AnalysisMemoryHintBridge = (() => {
        const MAX_HINTS_DEFAULT = 5;
        const parseMeta = (entry = null) => {
            const raw = String(entry?.content || entry || '');
            return parseLibraMetaObject(raw, { t: 0, imp: 5 });
        };
        const tokenize = (value = '') => {
            const raw = String(value || '').normalize('NFKC').toLowerCase();
            const tokens = raw.match(/[가-힣A-Za-z0-9]{2,}/g) || [];
            const blocked = new Set(['사용자','응답','대화','장면','현재','기억','메모리','정보','요약','후보','분석','데이터','관계','세계관','내러티브','그리고','하지만','그러나','그녀','그는','그때','정말','아무']);
            return new Set(tokens.filter(token => token.length >= 2 && !blocked.has(token)).slice(0, 160));
        };
        const setOverlapScore = (a, b) => {
            if (!a || !b || a.size === 0 || b.size === 0) return 0;
            let count = 0;
            for (const token of a) if (b.has(token)) count += 1;
            return count;
        };
        const getEntityNamesFromRuntime = () => {
            const names = [];
            const push = (value) => { const text = String(value || '').trim(); if (text) names.push(text); };
            try {
                if (typeof EntityManager !== 'undefined' && EntityManager?.getEntityCache) {
                    Array.from(EntityManager.getEntityCache().values()).forEach(entity => {
                        push(entity?.name);
                        if (Array.isArray(entity?.aliases)) entity.aliases.forEach(push);
                    });
                }
            } catch (_) {}
            return dedupeTextArray(names).slice(0, 80);
        };
        const normalizeEntries = (lorebook = []) => {
            try {
                return (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack)
                    ? LibraLoreConsolidator.unpack(lorebook)
                    : (Array.isArray(lorebook) ? lorebook : []);
            } catch (_) { return Array.isArray(lorebook) ? lorebook : []; }
        };
        const build = (lorebook = [], query = '', options = {}) => {
            const limit = Math.max(0, Math.min(12, Number(options.limit || MAX_HINTS_DEFAULT) || MAX_HINTS_DEFAULT));
            if (!limit) return [];
            const source = normalizeEntries(lorebook).filter(entry => String(entry?.comment || '') === 'lmai_memory');
            if (!source.length) return [];
            const queryText = String(query || '').trim();
            const queryTokens = tokenize(queryText);
            const runtimeEntityNames = getEntityNamesFromRuntime();
            const queryLower = queryText.toLowerCase();
            const currentTurn = (() => { try { return Number(MemoryEngine?.getCurrentTurn?.() || MemoryState?.currentTurn || 0); } catch (_) { return 0; } })();
            return source.map((entry) => {
                const meta = parseMeta(entry);
                const payload = CompactMemoryCodec.parsePayloadFromEntry(entry);
                const searchText = CompactMemoryCodec.buildSearchTextFromEntry(entry);
                const displayText = CompactMemoryCodec.buildDisplayTextFromEntry(entry, Number(options.maxChars || 240) || 240);
                const overlap = setOverlapScore(queryTokens, tokenize(searchText));
                const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
                const memoryEntityRefs = isLedger
                    ? (Array.isArray(payload?.participants?.canonicalEntities) ? payload.participants.canonicalEntities : []).map(v => String(v || '').trim()).filter(Boolean)
                    : (payload && Array.isArray(payload.mentionedEntityNames) ? payload.mentionedEntityNames.map(v => String(v || '').trim()).filter(Boolean) : []);
                const entityOverlap = runtimeEntityNames.filter(name => {
                    const lower = String(name || '').toLowerCase();
                    return lower && (queryLower.includes(lower) || String(searchText || '').toLowerCase().includes(lower));
                }).length;
                const tagOverlap = payload && Array.isArray(payload.tags)
                    ? payload.tags.filter(tag => queryLower.includes(String(tag || '').toLowerCase())).length
                    : 0;
                const turn = Number(payload?.turn || meta.turn || meta.t || meta.finalizedTurn || meta.turnAnchorTurn || 0);
                const recency = currentTurn && turn ? Math.max(0, 1 - Math.min(1, Math.max(0, currentTurn - turn) / 80)) : 0;
                const importance = Math.max(1, Math.min(10, Number(payload?.importance || meta.imp || 5) || 5));
                const score = (overlap * 1.2) + (entityOverlap * 2.5) + (tagOverlap * 2.0) + (importance * 0.25) + (recency * 1.0);
                return {
                    turn,
                    arcKey: String(payload?.arcKey || meta.arcKey || '').trim(),
                    entityRefs: memoryEntityRefs.slice(0, 8),
                    text: displayText,
                    score: Number(score.toFixed(3))
                };
            })
                .filter(item => item.text && (item.score > 0 || source.length <= limit))
                .sort((a, b) => (b.score - a.score) || (Number(b.turn || 0) - Number(a.turn || 0)))
                .slice(0, limit);
        };
        const format = (hints = [], options = {}) => {
            const list = (Array.isArray(hints) ? hints : []).filter(item => item && String(item.text || '').trim());
            if (!list.length) return '';
            const title = String(options.title || 'Long-Term Compact Memory Hints').trim();
            const policy = String(options.policy || 'Lower-priority compact memory hints. Use only for stable identity, aliases, relationship continuity, recurring motives, and persistent world constraints. Never override the current user turn, current assistant response, hard world rules, or manual corrections. Do not infer volatile current location, current mood, health, or consent from old memory unless the current turn confirms it.').trim();
            return [
                `[${title}]`,
                policy,
                ...list.map((hint) => {
                    const bits = [];
                    if (hint.turn) bits.push(`T${hint.turn}`);
                    if (hint.arcKey) bits.push(`arc=${hint.arcKey}`);
                    if (Array.isArray(hint.entityRefs) && hint.entityRefs.length) bits.push(`entities=${hint.entityRefs.slice(0, 5).join('/')}`);
                    return `- ${bits.length ? `[${bits.join(', ')}] ` : ''}${String(hint.text || '').trim()}`;
                })
            ].join('\n');
        };
        return Object.freeze({ build, format });
    })();



