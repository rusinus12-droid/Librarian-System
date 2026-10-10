    const CharacterEntitySourceHintBridge = (() => {
        const DEFAULT_LIMIT = 10;
        const build = async (targetChar = null, targetChat = null, query = '', options = {}) => {
            const requestedLimit = Number(options.limit ?? DEFAULT_LIMIT);
            const limit = Math.max(0, Math.min(20, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT));
            const maxChars = Math.max(800, Math.min(8000, Number(options.maxChars || 3200) || 3200));
            if (!limit) return { count: 0, block: '', items: [], vectorUsed: false };
            const buckets = Array.isArray(options.buckets) && options.buckets.length
                ? options.buckets
                : ['entity', 'relation', 'identity', 'narrative'];
            const result = await CharacterLoreCueIndex.search(targetChar, targetChat, query, {
                limit,
                buckets,
                allowQueryEmbedding: options.allowQueryEmbedding === true,
                forceRebuild: options.forceRebuild === true
            });
            const block = CharacterLoreCueIndex.format(result.items, {
                title: 'Character Card / Lorebook Entity Cues',
                maxChars,
                itemChars: 560,
                policy: 'Lower-priority stable entity/reference cues retrieved from the character card and non-LIBRA character lorebook cue index. Use only for explicitly written biological sex, appearance, personality, speech style, background, alias, occupation, stable relationship facts, and long-term identity. Do not treat style/output instructions as entity facts. Do not overwrite the current turn with stale lorebook hints. Current user/assistant turn and manually corrected LIBRA data outrank this block.'
            });
            return { count: result.count, block, items: result.items, vectorUsed: result.vectorUsed, sourceHash: result.sourceHash };
        };
        return Object.freeze({ build });
    })();

    const EntityAnalysisHintBridge = (() => {
        const buildRpLongTermCueBlock = (targetLore = [], query = '', options = {}) => {
            try {
                if (typeof RPContinuityCore === 'undefined' || !RPContinuityCore?.formatForPrompt) return '';
                if (typeof MemoryEngine !== 'undefined' && MemoryEngine.CONFIG?.rpLongTermMemoryEnabled === false) return '';
                const queryText = String(query || '').trim();
                const focusNames = typeof extractEntityRefs === 'function'
                    ? extractEntityRefs(queryText, { includeGeneric: false }).slice(0, 12)
                    : [];
                const maxChars = Math.max(700, Math.min(2400, Number(options.maxChars || 1400) || 1400));
                const block = RPContinuityCore.formatForPrompt(Array.isArray(targetLore) ? targetLore : [], {
                    query: queryText,
                    focusNames,
                    maxChars,
                    currentTurn: options.currentTurn || (typeof MemoryEngine !== 'undefined' ? MemoryEngine.getCurrentTurn?.() : 0) || 0
                });
                if (!String(block || '').trim()) return '';
                return [
                    '[RP-LTM Candidate Entity Cues / RP 장기기억 엔티티 후보 단서]',
                    'Lower-priority durable continuity cues. Use them only to resolve aliases, stable identity, and relationship context for names that directly appear in the current transcript. Never create a new entity from this block alone.',
                    block
                ].join('\n');
            } catch (_) {
                return '';
            }
        };
        return Object.freeze({ buildRpLongTermCueBlock });
    })();

    const LibraLoreKeys = {
        entityFromName: (name) => `lmai_entity::${TokenizerEngine.simpleHash(String(name || '').trim().toLowerCase())}`,
        relationFromNames: (nameA, nameB) => {
            const a = String(nameA || '').trim().toLowerCase();
            const b = String(nameB || '').trim().toLowerCase();
            const parts = [a, b].sort();
            return `lmai_relation::${TokenizerEngine.simpleHash(parts.join('::'))}`;
        },
        narrative: () => 'lmai_narrative::core',
        charStates: () => 'lmai_char_states::core',
        worldStates: () => 'lmai_world_states::core',
        secretKnowledge: () => 'lmai_secret_knowledge::core',
        entityKnowledgeVault: () => 'lmai_entity_knowledge_vault::core',
        timeEngine: () => 'lmai_time_engine::core',
        rpLongTerm: () => 'lmai_rp_longterm::core'
    };

    const parseLooseJson = (text) => {
        if (!text || typeof text !== 'string') return null;
        const cleaned = Utils.stripLLMThinkingTags(text).trim();
        try {
            return JSON.parse(cleaned);
        } catch {}
        const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (codeBlock) {
            try {
                const inner = codeBlock[1].trim().match(/\{[\s\S]*\}|\[[\s\S]*\]/);
                if (inner) return JSON.parse(inner[0]);
            } catch {}
        }
        try {
            const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
            return match ? JSON.parse(match[0]) : null;
        } catch {
            return null;
        }
    };
