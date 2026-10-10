    // ══════════════════════════════════════════════════════════════
    // [MANAGER] Section World Inference
    // ══════════════════════════════════════════════════════════════
    const SectionWorldInferenceManager = (() => {
        let cache = {
            key: '',
            prompt: '',
            title: '',
            activeRules: [],
            scenePressures: [],
            sourceRefs: []
        };

        const isSceneLensSourceWrapperLine = (line = '') => {
            const text = String(line || '').trim();
            if (!text) return true;
            if (/^\[?(Character Description and Character Lorebook|Character Description|Character Lorebook|Character Name|Character Personality|Scenario|First Message|Creator Notes|Default Variables)\]?/i.test(text)) return true;
            if (/^\[?(현재 세계 규칙\s*\/\s*Current World Rules|Current World Rules|World Structure|World|세계관 구조|현재 위치|Active World Rules|Character\/Lorebook World Cues|Memory World Cues|Scene Pressures|Scene Focus)\]?$/i.test(text)) return true;
            if (/^#\s*(Roleplay setting|World Settings|Relationships?)\b/i.test(text)) return true;
            if (/^<\/?(World Settings|.+ Start|.+ End)>$/i.test(text)) return true;
            if (/^\.\.\.\[TRUNCATED/i.test(text) || /\[TRUNCATED(?: CHARACTER WORLD SOURCES)?\]/i.test(text)) return true;
            return false;
        };

        const collectCueLines = (value, limit = 6, maxChars = 220, options = {}) => {
            const raw = String(value || '').trim();
            if (!raw) return [];
            const { excludeSourceWrappers = false } = options || {};
            const lines = raw
                .replace(/\r/g, '\n')
                .split('\n')
                .flatMap(line => splitImportedWorldRuleFragments(line))
                .map(line => String(line || '')
                    .replace(/^[\s\-*•·▶▷☞]+/, '')
                    .replace(/^[0-9]+[.)]\s*/, '')
                    .trim())
                .filter(line => {
                    if (!line) return false;
                    if (excludeSourceWrappers && isSceneLensSourceWrapperLine(line)) return false;
                    if (/^[\[\]【】#\s\/A-Za-z가-힣]+$/.test(line) && line.length < 28) return false;
                    if (/^(World|World Structure|Current World Rules|세계관 구조|현재 세계 규칙|현재 위치)$/i.test(line)) return false;
                    return true;
                })
                .map(line => truncateForLLM(line, maxChars, ' ... '))
                .filter(Boolean);
            return dedupeTextArray(lines).slice(0, limit);
        };

        const isLikelyLoreSourceExcerpt = (line = '') => {
            const text = String(line || '').trim();
            if (!text) return true;
            if (isSceneLensSourceWrapperLine(text)) return true;
            if (/^(Absolute rule|Information):/i.test(text) && text.length > 140) return true;
            if (/^(Character Description|Character Lorebook|Character Name|Roleplay setting|World Settings)/i.test(text)) return true;
            if (/\{\{Char\}\}|co \.\.\.|\.\.\.\[TRUNCATED\]/i.test(text)) return true;
            return false;
        };

        const buildLoreWorldCueLines = (loreHints = [], limit = 5) => {
            const raw = (Array.isArray(loreHints) ? loreHints : [loreHints])
                .map(item => String(item || '').trim())
                .filter(Boolean)
                .join('\n');
            if (!raw) return [];
            const candidateLines = collectCueLines(raw, Math.max(limit * 3, 12), 180, { excludeSourceWrappers: true });
            return dedupeTextArray(candidateLines
                .map(line => String(line || '').trim())
                .filter(line => line && !isLikelyLoreSourceExcerpt(line)))
                .slice(0, limit);
        };

        const classifyWorldRuleLines = (lines = []) => lines.filter(line =>
            /(수동 보정|User Correction|분류|Classification|요약|Summary|설명|Description|존재|Exists|부재|Absent|시스템|Systems|비활성|Inactive|기술|Technology|중력|Gravity|시간|Time|공간|Space|현상|Phenomena|규칙|Rules|마법|Magic|초자연|Supernatural|레벨|Level|스킬|Skill|스탯|Stats|길드|Guild|세력|Faction)/i.test(String(line || ''))
        );

        const buildFallbackPrompt = (payload) => {
            const focusCharacters = Array.isArray(payload?.focusCharacters)
                ? payload.focusCharacters.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
                : [];
            const memoryHints = Array.isArray(payload?.memoryHints)
                ? payload.memoryHints.map(item => truncateForLLM(String(item || '').trim(), 500, ' ...[TRUNCATED]... ')).filter(Boolean).slice(0, 4)
                : [];
            const loreHints = Array.isArray(payload?.loreHints)
                ? payload.loreHints.map(item => truncateForLLM(String(item || '').trim(), 900, ' ...[TRUNCATED]... ')).filter(Boolean).slice(0, 4)
                : [];

            const worldLines = collectCueLines(payload.worldPrompt, 14, 240, { excludeSourceWrappers: true });
            const worldRuleLines = classifyWorldRuleLines(worldLines)
                .filter(line => !isLikelyLoreSourceExcerpt(line))
                .slice(0, 7);
            const worldStateLines = collectCueLines(payload.worldStatePrompt, 4, 220, { excludeSourceWrappers: true });
            const narrativeLines = collectCueLines(payload.narrativePrompt, 4, 220, { excludeSourceWrappers: true });
            const loreCueLines = buildLoreWorldCueLines(loreHints, 5);
            const activeRules = dedupeTextArray([
                ...worldRuleLines
            ]).slice(0, 7);
            const scenePressures = dedupeTextArray([
                ...worldStateLines,
                ...narrativeLines,
                ...memoryHints.slice(0, 2)
            ]).slice(0, 6);
            const sourceRefs = [];
            if (payload.worldPrompt) sourceRefs.push('세계관 트리/현재 규칙');
            if (payload.worldStatePrompt) sourceRefs.push('세계관 상태');
            if (payload.narrativePrompt) sourceRefs.push('내러티브');
            if (memoryHints.length > 0) sourceRefs.push('관련 기억');
            if (loreHints.length > 0) sourceRefs.push('캐릭터 설명/로어북');
            if (focusCharacters.length > 0) sourceRefs.push('초점 엔티티');
            if (payload.canonicalEvidenceText || payload.aiResponse) sourceRefs.push(payload.analysisIncludesUserInput ? '현재 턴 증거' : 'assistant 정본 응답');

            const parts = [
                '[Active Scene Lens / 현재 장면 세계관 보정]',
                'This is a compact selection of existing LIBRA world context, not a new world definition.',
                'Use it to keep the current scene aligned with stored world rules and active continuity.'
            ];
            if (activeRules.length > 0) {
                parts.push('\n[Active World Rules]');
                parts.push(...activeRules.map(rule => `- ${rule}`));
            } else if (payload.worldPrompt) {
                parts.push('\n[Active World Rules]');
                parts.push('- Follow the established world structure and current world rules already provided.');
            }
            if (scenePressures.length > 0) {
                parts.push('\n[Scene Pressures]');
                parts.push(...scenePressures.map(item => `- ${item}`));
            }
            if (focusCharacters.length > 0) {
                parts.push('\n[Scene Focus]');
                parts.push(`- Keep the scene grounded around: ${focusCharacters.join(', ')}.`);
            }
            if (loreCueLines.length > 0) {
                parts.push('\n[Character/Lorebook World Cues]');
                parts.push(...loreCueLines.map(item => `- ${item}`));
            }
            if (memoryHints.length > 0) {
                parts.push('\n[Memory World Cues]');
                parts.push(...memoryHints.slice(0, 4).map(item => `- ${item}`));
            }
            parts.push('\n[Use Policy]');
            parts.push('- Manual world correction and stored current world rules outrank inferred hints from memories or lorebook fragments.');
            parts.push('- Use memory/lore cues only to clarify the active scene; do not rewrite persistent world rules from this lens alone.');
            if (payload.canonicalEvidenceText || payload.aiResponse) parts.push(`- Select only the rules relevant to ${payload.evidenceLabel || 'Canonical Assistant Evidence'} before escalating any world element.`);

            return {
                title: 'Active Scene Lens',
                prompt: parts.join('\n'),
                activeRules,
                scenePressures,
                sourceRefs: dedupeTextArray(sourceRefs)
            };
        };

        const inferPrompt = async (config, payload) => {
            if (config?.sectionWorldInferenceEnabled === false) return '';
            const hasMemoryHints = Array.isArray(payload?.memoryHints) && payload.memoryHints.some(item => String(item || '').trim());
            const hasLoreHints = Array.isArray(payload?.loreHints) && payload.loreHints.some(item => String(item || '').trim());
            if (!payload?.worldPrompt && !payload?.worldStatePrompt && !payload?.narrativePrompt && !hasMemoryHints && !hasLoreHints) return '';

            const cacheKey = TokenizerEngine.simpleHash(JSON.stringify({
                scopeKey: payload.scopeKey || payload.scopeId || '',
                chatId: payload.chatId || '',
                turn: payload.turn,
                canonicalEvidenceHash: TokenizerEngine.simpleHash(payload.canonicalEvidenceText || payload.aiResponse || ''),
                worldPrompt: payload.worldPrompt,
                worldStatePrompt: payload.worldStatePrompt,
                narrativePrompt: payload.narrativePrompt,
                directorPrompt: payload.directorPrompt,
                storyAuthorPrompt: payload.storyAuthorPrompt,
                focusCharacters: payload.focusCharacters,
                memoryHints: payload.memoryHints,
                loreHints: payload.loreHints
            }));
            if (cache.key === cacheKey && cache.prompt) return cache.prompt;

            const fallback = buildFallbackPrompt(payload);
            cache = { key: cacheKey, ...fallback };
            return fallback.prompt;
        };

        const getLastMeta = () => ({
            title: cache.title || '',
            activeRules: Array.isArray(cache.activeRules) ? cache.activeRules.slice(0, 5) : [],
            scenePressures: Array.isArray(cache.scenePressures) ? cache.scenePressures.slice(0, 5) : [],
            sourceRefs: Array.isArray(cache.sourceRefs) ? cache.sourceRefs.slice(0, 6) : []
        });
        const getLastPrompt = () => String(cache.prompt || '').trim();
        const getState = () => ({
            key: String(cache.key || ''),
            prompt: String(cache.prompt || ''),
            title: String(cache.title || ''),
            activeRules: Array.isArray(cache.activeRules) ? cache.activeRules.slice(0, 5) : [],
            scenePressures: Array.isArray(cache.scenePressures) ? cache.scenePressures.slice(0, 5) : [],
            sourceRefs: Array.isArray(cache.sourceRefs) ? cache.sourceRefs.slice(0, 6) : []
        });
        const loadState = (nextState = null) => {
            cache = {
                key: String(nextState?.key || ''),
                prompt: String(nextState?.prompt || ''),
                title: String(nextState?.title || ''),
                activeRules: Array.isArray(nextState?.activeRules) ? nextState.activeRules.map(String).filter(Boolean).slice(0, 5) : [],
                scenePressures: Array.isArray(nextState?.scenePressures) ? nextState.scenePressures.map(String).filter(Boolean).slice(0, 5) : [],
                sourceRefs: Array.isArray(nextState?.sourceRefs) ? nextState.sourceRefs.map(String).filter(Boolean).slice(0, 6) : []
            };
            return getState();
        };

        const resetState = () => {
            cache = { key: '', prompt: '', title: '', activeRules: [], scenePressures: [], sourceRefs: [] };
            return cache;
        };

        return { inferPrompt, getLastMeta, getLastPrompt, getState, loadState, resetState };
    })();

    // ══════════════════════════════════════════════════════════════
    // [MANAGER] Character State Tracker
    // ══════════════════════════════════════════════════════════════
    const CharacterStateTracker = (() => {
        const STATE_COMMENT = 'lmai_char_states';
        const CONSOLIDATION_INTERVAL = 5;

        let stateHistory = {};
        const normalizeCharacterStateMood = (value = '') => {
            try {
                return EntityManager.normalizeMoodText?.(value, 8) || String(value || '').trim();
            } catch {
                return String(value || '').replace(/\s+/g, ' ').trim();
            }
        };
        const normalizeCharacterStateNotes = (value = '') => dedupeTextArray(
            String(value || '')
                .split('|')
                .map(item => String(item || '').replace(/\s+/g, ' ').trim())
                .filter(item => item && !/^Auto-corrected:/i.test(item))
        ).join(' | ');
        const normalizeCharacterStateLog = (entry = {}) => ({
            ...entry,
            turn: Number(entry?.turn || 0) || 0,
            timestamp: Number(entry?.timestamp || Date.now()) || Date.now(),
            // 명시적으로 보존한다 — 스프레드에 기대면 정규화 순서가 바뀔 때 조용히 사라진다
            //   (09d 는 종전에 화이트리스트라 모르는 필드를 버린 이력이 있다).
            world: String(entry?.world || '').replace(/\s+/g, ' ').trim(),
            location: String(entry?.location || '').replace(/\s+/g, ' ').trim(),
            mood: normalizeCharacterStateMood(entry?.mood || ''),
            health: String(entry?.health || '').replace(/\s+/g, ' ').trim(),
            notes: normalizeCharacterStateNotes(entry?.notes || '')
        });
        const normalizeCharacterStateHistory = (raw = {}) => {
            const next = {};
            for (const [name, history] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
                const key = String(name || '').trim();
                if (!key) continue;
                const source = history && typeof history === 'object' ? history : {};
                next[key] = {
                    turnLog: (Array.isArray(source.turnLog) ? source.turnLog : [])
                        .map(normalizeCharacterStateLog)
                        .filter(entry => entry.turn > 0)
                        .slice(-30),
                    consolidated: (Array.isArray(source.consolidated) ? source.consolidated : []).slice(-20),
                    lastConsolidationTurn: Number(source.lastConsolidationTurn || 0) || 0
                };
            }
            return next;
        };

        const loadState = (lorebook) => {
            const entry = lorebook.find(e => e.comment === STATE_COMMENT);
            if (!entry) {
                stateHistory = {};
                return stateHistory;
            }
            try { stateHistory = normalizeCharacterStateHistory(JSON.parse(entry.content)); }
            catch (e) {
                stateHistory = {};
                recordRuntimeDebug('warn', '[LIBRA] Char state parse failed:', e?.message);
            }
            return stateHistory;
        };

        const saveState = async (lorebook) => {
            stateHistory = normalizeCharacterStateHistory(stateHistory);
            const entry = {
                key: LibraLoreKeys.charStates(),
                comment: STATE_COMMENT,
                content: JSON.stringify(stateHistory),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(e => e.comment === STATE_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };

        const recordState = (entityName, turn, stateSnapshot) => {
            if (!stateHistory[entityName]) {
                stateHistory[entityName] = { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
            }
            const history = stateHistory[entityName];
            history.turnLog.push({
                turn,
                timestamp: Date.now(),
                // 소속 세계(개체). 규칙 텍스트가 아니라 **이름**이다 — 세계 규칙은 세계 블록이 낸다.
                world: String(stateSnapshot.world || '').replace(/\s+/g, ' ').trim(),
                location: stateSnapshot.currentLocation || '',
                mood: normalizeCharacterStateMood(stateSnapshot.currentMood || ''),
                health: stateSnapshot.healthStatus || '',
                notes: normalizeCharacterStateNotes(stateSnapshot.notes || '')
            });
            if (history.turnLog.length > 30) {
                history.turnLog = history.turnLog.slice(-30);
            }
        };
        const replaceState = (entityName, turn, stateSnapshot) => {
            if (!stateHistory[entityName]) {
                stateHistory[entityName] = { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
            }
            const history = stateHistory[entityName];
            const targetTurn = Number(turn || 0);
            const existingIdx = history.turnLog.findIndex(item => Number(item?.turn || 0) === targetTurn);
            const nextEntry = {
                turn: targetTurn,
                timestamp: Date.now(),
                location: stateSnapshot.currentLocation || '',
                mood: normalizeCharacterStateMood(stateSnapshot.currentMood || ''),
                health: stateSnapshot.healthStatus || '',
                notes: normalizeCharacterStateNotes(stateSnapshot.notes || '')
            };
            if (existingIdx >= 0) history.turnLog[existingIdx] = nextEntry;
            else history.turnLog.push(nextEntry);
            if (history.turnLog.length > 30) {
                history.turnLog = history.turnLog.slice(-30);
            }
        };

        const recordCriticalMoment = (entityName, turn, description) => {
            if (!stateHistory[entityName]) {
                stateHistory[entityName] = { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
            }
            stateHistory[entityName].consolidated.push({
                turn,
                type: 'critical',
                description,
                timestamp: Date.now()
            });
        };

        const getConsolidationCandidate = (entityName, currentTurn) => {
            const name = String(entityName || '').trim();
            const history = stateHistory[name];
            if (!history) return;
            if (currentTurn - history.lastConsolidationTurn < CONSOLIDATION_INTERVAL) return;

            const recentLogs = history.turnLog.filter(
                t => t.turn > history.lastConsolidationTurn
            );
            if (recentLogs.length < 3) return;
            const logText = recentLogs.map(l =>
                `Turn ${l.turn}: Location=${l.location}, Mood=${l.mood}, Health=${l.health}${l.notes ? ', Notes=' + l.notes : ''}`
            ).join('\n');
            return {
                type: 'character',
                name,
                currentTurn: Number(currentTurn || 0),
                recentLogs: safeClone(recentLogs),
                logText
            };
        };

        const trimConsolidatedHistory = (history) => {
            if (!history) return;
            if (history.consolidated.length > 20) {
                history.consolidated = history.consolidated.slice(-20);
            }
        };

        const applyConsolidationResult = (entityName, currentTurn, result = {}) => {
            const name = String(entityName || '').trim();
            const history = stateHistory[name];
            if (!history) return false;
            const rawChanges = Array.isArray(result?.significantChanges)
                ? result.significantChanges
                : (Array.isArray(result?.changes) ? result.changes : (result?.changes ? [result.changes] : []));
            const changes = dedupeTextArray(
                rawChanges
                    .map(item => String(item || '').trim())
                    .filter(Boolean)
            ).slice(0, 8);
            const summary = truncateForLLM(String(result?.summary || result?.description || '').trim(), 360, ' ... ');
            if (summary || changes.length > 0) {
                history.consolidated.push({
                    turn: Number(currentTurn || 0),
                    type: 'periodic',
                    description: summary,
                    changes,
                    timestamp: Date.now()
                });
            }
            history.lastConsolidationTurn = Number(currentTurn || 0);
            trimConsolidatedHistory(history);
            return true;
        };

        const applyConsolidationFallback = (entityName, currentTurn) => {
            const candidate = getConsolidationCandidate(entityName, currentTurn);
            if (!candidate) return false;
            const last = candidate.recentLogs[candidate.recentLogs.length - 1] || {};
            return applyConsolidationResult(candidate.name, currentTurn, {
                summary: `Location: ${last.location || ''}, Mood: ${last.mood || ''}, Health: ${last.health || ''}`,
                significantChanges: []
            });
        };

        const consolidateIfNeeded = async (entityName, currentTurn, config) => {
            const candidate = getConsolidationCandidate(entityName, currentTurn);
            if (!candidate) return;
            const history = stateHistory[candidate.name];

            if (LLMProvider.isConfigured(config, 'primary') || LLMProvider.isConfigured(config, 'aux')) {
                try {
                    const result = await runMaintenanceLLM(() =>
                        LLMProvider.call(config,
                            'Summarize the character state changes below. Note significant changes. If a LIBRA Internal Data Language Guard is present, use that target language for generated summary values; otherwise respond in the same language as the content.\nOutput JSON: {"summary": "...", "significantChanges": ["..."]}',
                            `Character: ${candidate.name}\nState log:\n${candidate.logText}`,
                            {
                                maxTokens: 300,
                                profile: resolveAnalysisProfile(config, 'characterStateConsolidation', 'aux'),
                                label: `char-state-${candidate.name}`,
                                domain: 'entity_consolidation',
                                reason: 'character-state-consolidation',
                            }
                        )
                    , `char-state-${candidate.name}`);

                    if (result.content) {
                        const cleanedContent = Utils.stripLLMThinkingTags(result.content);
                        const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            applyConsolidationResult(candidate.name, currentTurn, parsed);
                        }
                    }
                    history.lastConsolidationTurn = currentTurn;
                } catch (e) {
                    recordRuntimeDebug('warn', '[LIBRA] Char state consolidation failed:', e?.message);
                }
            } else {
                applyConsolidationFallback(candidate.name, currentTurn);
            }
        };

        const isCriticalMoment = (entityName, newState) => {
            const history = stateHistory[entityName];
            if (!history || history.turnLog.length === 0) return false;
            const last = history.turnLog[history.turnLog.length - 1];
            if (last.health && newState.healthStatus && last.health !== newState.healthStatus) return true;
            if (last.location && newState.currentLocation && last.location !== newState.currentLocation) return true;
            return false;
        };

        const getCharacterStateLookupKeys = (value = '') => {
            const text = String(value || '').trim();
            if (!text) return [];
            const keys = [text];
            const noParen = text.replace(/\([^)]*\)/g, '').trim();
            if (noParen && noParen !== text) keys.push(noParen);
            for (const match of text.matchAll(/\(([^)]{2,80})\)/g)) {
                if (match?.[1]) keys.push(match[1].trim());
            }
            const korean = text.match(/[가-힣]{2,}/g);
            if (korean) keys.push(...korean);
            return dedupeTextArray(keys)
                .map(item => String(item || '').trim())
                .filter(Boolean);
        };

        const findCharacterStateHistory = (entityName = '') => {
            const directName = String(entityName || '').trim();
            if (directName && stateHistory[directName]) return stateHistory[directName];
            const lookupKeys = new Set(getCharacterStateLookupKeys(directName).map(key => key.toLowerCase()));
            if (lookupKeys.size === 0) return null;
            for (const [key, history] of Object.entries(stateHistory || {})) {
                const keyVariants = getCharacterStateLookupKeys(key).map(item => item.toLowerCase());
                if (keyVariants.some(item => lookupKeys.has(item))) return history;
            }
            return null;
        };

        const formatForPrompt = (entityName) => {
            const history = findCharacterStateHistory(entityName);
            if (!history) return '';
            const parts = [];

            // 소속 세계 — 어느 개체에 속한 세포인가. 모델이 이미 받는 세계 블록과 이 이름으로 연결한다
            //   (규칙 텍스트를 여기 복사하면 중복이 된다).
            const affiliation = [...(Array.isArray(history.turnLog) ? history.turnLog : [])]
                .reverse()
                .map(entry => String(entry?.world || '').trim())
                .find(Boolean) || '';
            if (affiliation) parts.push(`  World: ${affiliation}`);

            if (history.consolidated.length > 0) {
                const lastConsolidated = history.consolidated[history.consolidated.length - 1];
                parts.push(`  State History: ${lastConsolidated.description}`);
            }

            const recent = history.turnLog.slice(-3);
            if (recent.length > 0) {
                const stateStr = recent.map(l => {
                    const segments = [];
                    if (l.location) segments.push(l.location);
                    if (l.mood) segments.push(l.mood);
                    if (l.health) segments.push(l.health);
                    if (l.notes) segments.push(l.notes);
                    return `T${l.turn}: ${segments.join(', ')}`;
                }).join(' → ');
                parts.push(`  Recent States: ${stateStr}`);
            }

            return parts.join('\n');
        };

        const formatForPromptAny = (entityNames = []) => {
            const candidates = Array.isArray(entityNames) ? entityNames : [entityNames];
            for (const candidate of candidates) {
                const text = formatForPrompt(candidate);
                if (text) return text;
            }
            return '';
        };

        const renameEntityKey = (oldName = '', newName = '', options = {}) => {
            const oldText = String(oldName || '').trim();
            const newText = String(newName || '').trim();
            if (!oldText || !newText || oldText === newText) return { changed: false };
            const candidates = [oldText, ...(Array.isArray(options.previousNames) ? options.previousNames : [])]
                .map(value => String(value || '').trim())
                .filter(Boolean);
            const keys = Object.keys(stateHistory || {});
            const matchedKeys = keys.filter(key => candidates.some(candidate => key === candidate));
            if (!matchedKeys.length) return { changed: false };
            const mergeHistory = (target = {}, source = {}) => ({
                turnLog: [...(Array.isArray(target.turnLog) ? target.turnLog : []), ...(Array.isArray(source.turnLog) ? source.turnLog : [])]
                    .sort((a, b) => Number(a?.turn || 0) - Number(b?.turn || 0))
                    .slice(-30),
                consolidated: [...(Array.isArray(target.consolidated) ? target.consolidated : []), ...(Array.isArray(source.consolidated) ? source.consolidated : [])]
                    .sort((a, b) => Number(a?.turn || 0) - Number(b?.turn || 0))
                    .slice(-20),
                lastConsolidationTurn: Math.max(Number(target.lastConsolidationTurn || 0), Number(source.lastConsolidationTurn || 0))
            });
            let merged = stateHistory[newText] || { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
            for (const key of matchedKeys) {
                merged = mergeHistory(merged, stateHistory[key]);
                if (key !== newText) delete stateHistory[key];
            }
            stateHistory[newText] = merged;
            return { changed: true };
        };

        const getState = () => stateHistory;
        const resetState = (nextState = null) => {
            stateHistory = nextState ? normalizeCharacterStateHistory(safeClone(nextState)) : {};
            return stateHistory;
        };

        return { loadState, saveState, recordState, replaceState, recordCriticalMoment, getConsolidationCandidate, applyConsolidationResult, applyConsolidationFallback, consolidateIfNeeded, isCriticalMoment, formatForPrompt, formatForPromptAny, renameEntityKey, getState, resetState };
    })();

    // ══════════════════════════════════════════════════════════════
    // [MANAGER] World State Tracker
    // ══════════════════════════════════════════════════════════════
    const WorldStateTracker = (() => {
        const STATE_COMMENT = 'lmai_world_states';
        const CONSOLIDATION_INTERVAL = 5;
        // 세계 로그가 담는 인물(세포) 상한 — 인물이 많아도 로그가 폭발하지 않게.
        const WORLD_STATE_ENTITY_CAP = 16;

        let stateHistory = { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
        const getWorldPathLabel = (entry = {}) => {
            const path = Array.isArray(entry?.activeWorld) ? entry.activeWorld.map(value => String(value || '').trim()).filter(Boolean) : [];
            return path.length > 0 ? path[path.length - 1] : '';
        };
        const normalizeWorldStateNotes = (value = '') => dedupeTextArray(
            String(value || '')
                .split('|')
                .map(item => String(item || '').replace(/^Auto-corrected:\s*/i, '').replace(/^Auto-corrected$/i, '').trim())
                .filter(Boolean)
        );
        const normalizeWorldStateEntry = (turn, worldSnapshot = {}) => {
            const targetTurn = Number(turn || 0);
            const rulesSnapshot = worldSnapshot?.rules && typeof worldSnapshot.rules === 'object' ? safeClone(worldSnapshot.rules) : {};
            const ruleHighlights = Array.isArray(worldSnapshot?.ruleHighlights)
                ? dedupeTextArray(worldSnapshot.ruleHighlights.map(value => String(value || '').trim()).filter(Boolean)).slice(0, 6)
                : extractWorldRuleHighlights(rulesSnapshot, 6);
            const worldSummary = truncateForLLM(String(worldSnapshot?.worldSummary || '').trim(), 260, ' ... ');
            const currentTime = truncateForLLM(String(worldSnapshot?.currentTime || worldSnapshot?.time || '').trim(), 100, ' ... ');
            const currentLocation = truncateForLLM(String(worldSnapshot?.currentLocation || worldSnapshot?.location || '').trim(), 160, ' ... ');
            const currentScene = truncateForLLM(String(worldSnapshot?.currentScene || worldSnapshot?.scene || '').trim(), 260, ' ... ');
            const activeEvents = normalizeWorldCanonTextList(worldSnapshot?.activeEvents || worldSnapshot?.active_events, 12);
            const offscreenThreads = normalizeWorldCanonTextList(worldSnapshot?.offscreenThreads || worldSnapshot?.offscreen_threads, 12);
            const notes = truncateForLLM(normalizeWorldStateNotes(worldSnapshot?.notes || '').join(' | '), 220, ' ... ');
            // 세계는 세포(인물)들이 모인 개체다 — 개체가 자기 세포를 봐야 한다.
            // 화이트리스트라 여기에 없으면 스냅샷에 담겨도 조용히 버려진다(실측).
            const presentEntities = dedupeTextArray(
                (Array.isArray(worldSnapshot?.presentEntities) ? worldSnapshot.presentEntities : [])
                    .map(item => {
                        if (!item) return '';
                        if (typeof item === 'string') return item.trim().slice(0, 160);
                        const name = String(item.name || '').trim();
                        if (!name) return '';
                        const bits = [name];
                        const loc = String(item.location || '').trim();
                        const health = String(item.health || '').trim();
                        const state = String(item.state || item.summary || '').trim();
                        if (loc) bits.push(`@${loc}`);
                        if (health) bits.push(`(${health})`);
                        if (state) bits.push(`- ${state}`);
                        return truncateForLLM(bits.join(' '), 160, ' ... ');
                    })
                    .filter(Boolean)
            ).slice(0, WORLD_STATE_ENTITY_CAP);
            return {
                turn: targetTurn,
                timestamp: Date.now(),
                activeWorld: Array.isArray(worldSnapshot?.activePath) ? worldSnapshot.activePath.slice(0, 8) : [],
                rulesSnapshot,
                globalFlags: worldSnapshot?.global && typeof worldSnapshot.global === 'object' ? safeClone(worldSnapshot.global) : {},
                classification: truncateForLLM(String(worldSnapshot?.classification || '').trim(), 160, ' ... '),
                worldSummary,
                currentTime,
                currentLocation,
                currentScene,
                activeEvents,
                offscreenThreads,
                ruleHighlights,
                presentEntities,
                notes
            };
        };
        const getWorldStateSignature = (entry = {}) => [
            Array.isArray(entry?.activeWorld) ? entry.activeWorld.join('>') : '',
            String(entry?.classification || '').trim(),
            String(entry?.currentTime || '').trim(),
            String(entry?.currentLocation || '').trim(),
            String(entry?.currentScene || '').trim(),
            Array.isArray(entry?.activeEvents) ? entry.activeEvents.join('|') : '',
            Array.isArray(entry?.offscreenThreads) ? entry.offscreenThreads.join('|') : '',
            Array.isArray(entry?.ruleHighlights) ? entry.ruleHighlights.join('|') : '',
            String(entry?.notes || '').trim()
        ].join('::');
        const describeWorldStateEntry = (entry = {}, options = {}) => {
            const { includeTurn = true, includeNotes = false, ruleLimit = 2 } = options || {};
            const segments = [];
            const turn = Number(entry?.turn || 0);
            if (includeTurn && turn > 0) segments.push(`T${turn}`);
            const pathLabel = getWorldPathLabel(entry);
            if (pathLabel) segments.push(pathLabel);
            if (entry?.classification) segments.push(String(entry.classification));
            if (entry?.currentTime) segments.push(`시간 ${String(entry.currentTime)}`);
            if (entry?.currentLocation) segments.push(`위치 ${String(entry.currentLocation)}`);
            if (entry?.currentScene) segments.push(`장면 ${truncateForLLM(String(entry.currentScene), 100, ' ... ')}`);
            const rules = Array.isArray(entry?.ruleHighlights) ? entry.ruleHighlights.slice(0, Math.max(1, Number(ruleLimit || 0))) : [];
            if (rules.length > 0) segments.push(`규칙 ${rules.join(', ')}`);
            if (Array.isArray(entry?.activeEvents) && entry.activeEvents.length > 0) segments.push(`진행 ${entry.activeEvents.slice(0, 2).join(', ')}`);
            // 세포(인물) — 개체(세계)가 자기 세포를 보는 자리. 로그 텍스트에 넣어야 LLM 이 본다.
            const cells = Array.isArray(entry?.presentEntities) ? entry.presentEntities.slice(0, 8) : [];
            if (cells.length > 0) segments.push(`인물 ${cells.join(', ')}`);
            if (!rules.length && entry?.worldSummary) segments.push(truncateForLLM(String(entry.worldSummary), 120, ' ... '));
            if (includeNotes && entry?.notes) segments.push(String(entry.notes));
            return segments.join(' | ');
        };
        const summarizeWorldStateWindow = (entries = []) => {
            const recent = Array.isArray(entries) ? entries.filter(Boolean) : [];
            if (recent.length === 0) return { summary: '', changes: [] };
            const first = recent[0];
            const last = recent[recent.length - 1];
            const changes = [];
            const firstPath = getWorldPathLabel(first);
            const lastPath = getWorldPathLabel(last);
            if (firstPath && lastPath && firstPath !== lastPath) changes.push(`경로 ${firstPath} -> ${lastPath}`);
            if (String(first?.classification || '').trim() !== String(last?.classification || '').trim() && last?.classification) {
                changes.push(`분류 ${String(first?.classification || '미상').trim()} -> ${String(last.classification).trim()}`);
            }
            if (String(first?.currentLocation || '').trim() !== String(last?.currentLocation || '').trim() && last?.currentLocation) {
                changes.push(`위치 ${String(first?.currentLocation || '미상').trim()} -> ${String(last.currentLocation).trim()}`);
            }
            if (String(first?.currentScene || '').trim() !== String(last?.currentScene || '').trim() && last?.currentScene) {
                changes.push(`장면 ${truncateForLLM(String(last.currentScene), 120, ' ... ')}`);
            }
            const lastRuleHighlights = Array.isArray(last?.ruleHighlights) ? last.ruleHighlights.slice(0, 3) : [];
            if (lastRuleHighlights.length > 0) changes.push(`규칙 ${lastRuleHighlights.join(', ')}`);
            if (Array.isArray(last?.activeEvents) && last.activeEvents.length > 0) changes.push(...last.activeEvents.slice(0, 2));
            const lastNotes = normalizeWorldStateNotes(last?.notes || '');
            if (lastNotes.length > 0) changes.push(...lastNotes.slice(0, 2));
            const summaryParts = [];
            if (firstPath && lastPath) summaryParts.push(firstPath === lastPath ? `${lastPath} 유지` : `${firstPath} -> ${lastPath}`);
            else if (lastPath) summaryParts.push(lastPath);
            if (last?.classification) summaryParts.push(String(last.classification));
            if (last?.currentTime) summaryParts.push(String(last.currentTime));
            if (last?.currentLocation) summaryParts.push(`위치 ${String(last.currentLocation)}`);
            if (last?.currentScene) summaryParts.push(truncateForLLM(String(last.currentScene), 120, ' ... '));
            if (lastRuleHighlights.length > 0) summaryParts.push(`핵심 규칙 ${lastRuleHighlights.join(', ')}`);
            else if (last?.worldSummary) summaryParts.push(truncateForLLM(String(last.worldSummary), 180, ' ... '));
            return {
                summary: truncateForLLM(summaryParts.join(' | '), 260, ' ... '),
                changes: dedupeTextArray(changes).slice(0, 4)
            };
        };

        const loadState = (lorebook) => {
            const entry = lorebook.find(e => e.comment === STATE_COMMENT);
            if (!entry) {
                stateHistory = { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
                return stateHistory;
            }
            try {
                const parsed = JSON.parse(entry.content);
                const integrity = IntegrityMetaManager.validateIntegrityMeta(parsed, {
                    domain: 'world',
                    recordId: 'world_state',
                    scopeKey: MemoryState?._activeScopeKey || ''
                });
                if (!integrity.ok) {
                    IntegrityMetaManager.debugValidationFailure('world.loadState', integrity, {
                        domain: 'world',
                        recordId: 'world_state',
                        scopeKey: MemoryState?._activeScopeKey || ''
                    });
                    stateHistory = { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
                } else {
                    stateHistory = parsed;
                }
            } catch (e) {
                stateHistory = { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
                recordRuntimeDebug('warn', '[LIBRA] World state parse failed:', e?.message);
            }
            return stateHistory;
        };

        const saveState = async (lorebook) => {
            stateHistory = stateHistory && typeof stateHistory === 'object' ? stateHistory : { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
            stateHistory.meta = stateHistory.meta && typeof stateHistory.meta === 'object' ? stateHistory.meta : {};
            IntegrityMetaManager.applyIntegrityMeta(stateHistory, {
                domain: 'world',
                recordSchema: 'libra.world.state.v1',
                recordId: 'world_state',
                scopeKey: MemoryState?._activeScopeKey || '',
                turn: MemoryState?.currentTurn || 0,
                source: 'world_state_tracker'
            });
            const entry = {
                key: LibraLoreKeys.worldStates(),
                comment: STATE_COMMENT,
                content: JSON.stringify(stateHistory),
                mode: 'normal',
                insertorder: 7,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(e => e.comment === STATE_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };

        const recordState = (turn, worldSnapshot) => {
            stateHistory.turnLog.push(normalizeWorldStateEntry(turn, worldSnapshot));
            if (stateHistory.turnLog.length > 30) {
                stateHistory.turnLog = stateHistory.turnLog.slice(-30);
            }
        };
        const replaceState = (turn, worldSnapshot) => {
            const targetTurn = Number(turn || 0);
            const nextEntry = normalizeWorldStateEntry(targetTurn, worldSnapshot);
            const existingIdx = stateHistory.turnLog.findIndex(item => Number(item?.turn || 0) === targetTurn);
            if (existingIdx >= 0) stateHistory.turnLog[existingIdx] = nextEntry;
            else stateHistory.turnLog.push(nextEntry);
            if (stateHistory.turnLog.length > 30) {
                stateHistory.turnLog = stateHistory.turnLog.slice(-30);
            }
        };

        const recordCriticalMoment = (turn, description) => {
            stateHistory.consolidated.push({
                turn,
                type: 'critical',
                description,
                timestamp: Date.now()
            });
        };

        const getConsolidationCandidate = (currentTurn) => {
            if (currentTurn - stateHistory.lastConsolidationTurn < CONSOLIDATION_INTERVAL) return;
            const recentLogs = stateHistory.turnLog.filter(t => t.turn > stateHistory.lastConsolidationTurn);
            if (recentLogs.length < 3) return;
            const logText = recentLogs.map(l =>
                `Turn ${l.turn}: World=${(l.activeWorld||[]).join('→')}, Notes=${l.notes||'none'}`
            ).join('\n');
            return {
                type: 'world',
                currentTurn: Number(currentTurn || 0),
                recentLogs: safeClone(recentLogs),
                logText
            };
        };

        const trimConsolidatedHistory = () => {
            if (stateHistory.consolidated.length > 20) {
                stateHistory.consolidated = stateHistory.consolidated.slice(-20);
            }
        };

        const applyConsolidationResult = (currentTurn, result = {}) => {
            const rawChanges = Array.isArray(result?.significantChanges)
                ? result.significantChanges
                : (Array.isArray(result?.changes) ? result.changes : (result?.changes ? [result.changes] : []));
            const changes = dedupeTextArray(
                rawChanges
                    .map(item => String(item || '').trim())
                    .filter(Boolean)
            ).slice(0, 8);
            const summary = truncateForLLM(String(result?.summary || result?.description || '').trim(), 360, ' ... ');
            if (summary || changes.length > 0) {
                stateHistory.consolidated.push({
                    turn: Number(currentTurn || 0),
                    type: 'periodic',
                    description: summary,
                    changes,
                    timestamp: Date.now()
                });
            }
            // 세포(인물)들의 움직임이 개체(세계)를 바꿨는가 — LLM 판정을 그대로 받는다.
            // 숫자 임계를 두지 않는다: 몇 명이 움직였는지가 아니라 **세계가 변했는지**가 기준이다.
            const worldChangedByCharacters = result?.charactersChangeWorld === true
                || result?.criticalChange === true
                || result?.worldShifted === true;
            if (worldChangedByCharacters) {
                const criticalReason = truncateForLLM(
                    String(result?.criticalReason || result?.reason || summary || '').trim(), 300, ' ... ');
                const criticalEntities = dedupeTextArray(
                    (Array.isArray(result?.criticalEntities) ? result.criticalEntities
                        : (Array.isArray(result?.entities) ? result.entities : []))
                        .map(item => String(item || '').trim())
                        .filter(Boolean)
                ).slice(0, 12);
                stateHistory.consolidated.push({
                    turn: Number(currentTurn || 0),
                    type: 'critical',
                    description: criticalReason || '세포들의 움직임이 세계를 바꿨다',
                    reason: criticalReason,
                    entities: criticalEntities,
                    timestamp: Date.now()
                });
                trimConsolidatedHistory();
            }
            stateHistory.lastConsolidationTurn = Number(currentTurn || 0);
            trimConsolidatedHistory();
            return true;
        };

        const applyConsolidationFallback = (currentTurn) => {
            const candidate = getConsolidationCandidate(currentTurn);
            if (!candidate) return false;
            const last = candidate.recentLogs[candidate.recentLogs.length - 1] || {};
            const summary = summarizeWorldStateWindow(candidate.recentLogs);
            return applyConsolidationResult(currentTurn, {
                summary: summary.summary || `World: ${(last.activeWorld||[]).join('→')}`,
                significantChanges: summary.changes || []
            });
        };

        const consolidateIfNeeded = async (currentTurn, config) => {
            const candidate = getConsolidationCandidate(currentTurn);
            if (!candidate) return;

            if (LLMProvider.isConfigured(config, 'primary') || LLMProvider.isConfigured(config, 'aux')) {
                try {
                    const result = await runMaintenanceLLM(() =>
                        LLMProvider.call(config,
                            'Summarize world state changes below. Note dimension shifts and rule changes. If a LIBRA Internal Data Language Guard is present, use that target language for generated summary values; otherwise respond in the same language as the content.\nOutput JSON: {"summary": "...", "significantChanges": ["..."]}',
                            `World state log:\n${candidate.logText}`,
                            {
                                maxTokens: 300,
                                profile: resolveAnalysisProfile(config, 'worldStateConsolidation', 'aux'),
                                label: `world-state-${currentTurn}`,
                                domain: 'world_consolidation',
                                reason: 'world-state-consolidation',
                            }
                        )
                    , `world-state-${currentTurn}`);

                    if (result.content) {
                        const cleanedContent = Utils.stripLLMThinkingTags(result.content);
                        const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            applyConsolidationResult(currentTurn, parsed);
                        }
                    }
                    stateHistory.lastConsolidationTurn = currentTurn;
                } catch (e) {
                    recordRuntimeDebug('warn', '[LIBRA] World state consolidation failed:', e?.message);
                }
            } else {
                applyConsolidationFallback(currentTurn);
            }
        };

        const isCriticalMoment = (newWorldState) => {
            if (stateHistory.turnLog.length === 0) return false;
            const last = stateHistory.turnLog[stateHistory.turnLog.length - 1];
            const lastPath = (last.activeWorld || []).join(',');
            const newPath = (newWorldState.activePath || []).join(',');
            return lastPath !== newPath;
        };

        const formatForPrompt = () => {
            const parts = [];
            if (stateHistory.consolidated.length > 0) {
                const lastC = stateHistory.consolidated[stateHistory.consolidated.length - 1];
                parts.push(`World History: ${lastC.description}`);
            }
            const recent = [];
            const seen = new Set();
            for (let i = stateHistory.turnLog.length - 1; i >= 0 && recent.length < 3; i--) {
                const entry = stateHistory.turnLog[i];
                const signature = getWorldStateSignature(entry);
                if (seen.has(signature)) continue;
                seen.add(signature);
                recent.unshift(entry);
            }
            if (recent.length > 0) {
                parts.push(`Recent: ${recent.map(entry => describeWorldStateEntry(entry, { includeTurn: true, includeNotes: false, ruleLimit: 2 })).join(' → ')}`);
            }
            return parts.join('\n');
        };

        const getState = () => stateHistory;
        const resetState = (nextState = null) => {
            stateHistory = nextState ? safeClone(nextState) : { turnLog: [], consolidated: [], lastConsolidationTurn: 0 };
            return stateHistory;
        };

        return { loadState, saveState, recordState, replaceState, recordCriticalMoment, getConsolidationCandidate, applyConsolidationResult, applyConsolidationFallback, consolidateIfNeeded, isCriticalMoment, formatForPrompt, getState, resetState };
    })();

    const StateConsolidationBundler = (() => {
        const normalizeChanges = (value = []) => dedupeTextArray(
            (Array.isArray(value) ? value : (value ? [value] : []))
                .map(item => String(item || '').trim())
                .filter(Boolean)
        ).slice(0, 8);

        const buildPayload = (characterTasks = [], worldTask = null, currentTurn = 0) => ({
            turn: Number(currentTurn || 0),
            characters: characterTasks.map(task => ({
                name: task.name,
                logs: String(task.logText || '').trim()
            })),
            world: worldTask ? { logs: String(worldTask.logText || '').trim() } : null
        });

        const parseBundleResult = (content = '') => {
            const cleaned = Utils.stripLLMThinkingTags(String(content || ''));
            const parsed = parseLooseJson(cleaned) || extractStructuredJson(cleaned);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return parsed;
        };

        const findCharacterResult = (parsedCharacters = [], task = {}) => {
            const target = String(task?.name || '').trim().toLowerCase();
            if (!target || !Array.isArray(parsedCharacters)) return null;
            return parsedCharacters.find(item => String(item?.name || '').trim().toLowerCase() === target) || null;
        };

        const applyParsedBundle = (parsed = {}, characterTasks = [], worldTask = null, currentTurn = 0) => {
            let applied = 0;
            const characters = Array.isArray(parsed.characters) ? parsed.characters : [];
            for (const task of characterTasks) {
                const item = findCharacterResult(characters, task);
                if (item) {
                    applied += CharacterStateTracker.applyConsolidationResult(task.name, currentTurn, {
                        summary: item.summary || item.description || '',
                        significantChanges: normalizeChanges(item.significantChanges || item.changes)
                    }) ? 1 : 0;
                } else {
                    applied += CharacterStateTracker.applyConsolidationFallback(task.name, currentTurn) ? 1 : 0;
                }
            }
            if (worldTask) {
                const world = parsed.world && typeof parsed.world === 'object' && !Array.isArray(parsed.world)
                    ? parsed.world
                    : null;
                if (world) {
                    applied += WorldStateTracker.applyConsolidationResult(currentTurn, {
                        summary: world.summary || world.description || '',
                        significantChanges: normalizeChanges(world.significantChanges || world.changes),
                        charactersChangeWorld: world.charactersChangeWorld === true,
                        criticalReason: world.criticalReason || world.reason || '',
                        criticalEntities: Array.isArray(world.criticalEntities) ? world.criticalEntities : []
                    }) ? 1 : 0;
                } else {
                    applied += WorldStateTracker.applyConsolidationFallback(currentTurn) ? 1 : 0;
                }
            }
            return applied;
        };

        const consolidateIfNeeded = async (entityNames = [], currentTurn = 0, config = MemoryEngine.CONFIG) => {
            const names = dedupeTextArray((Array.isArray(entityNames) ? entityNames : [])
                .map(name => String(name || '').trim())
                .filter(Boolean));
            const characterTasks = names
                .map(name => CharacterStateTracker.getConsolidationCandidate(name, currentTurn))
                .filter(Boolean);
            const worldTask = WorldStateTracker.getConsolidationCandidate(currentTurn) || null;
            if (!characterTasks.length && !worldTask) {
                return { skipped: true, reason: 'no-state-consolidation-due' };
            }
            const profile = (LLMProvider.isConfigured(config, 'primary') || LLMProvider.isConfigured(config, 'aux'))
                ? resolveAnalysisProfile(config, 'characterStateConsolidation', 'aux')
                : null;
            if (!profile) {
                let applied = 0;
                for (const task of characterTasks) {
                    applied += CharacterStateTracker.applyConsolidationFallback(task.name, currentTurn) ? 1 : 0;
                }
                if (worldTask) applied += WorldStateTracker.applyConsolidationFallback(currentTurn) ? 1 : 0;
                return { mode: 'heuristic', applied, characters: characterTasks.length, world: !!worldTask };
            }

            try {
                const payload = buildPayload(characterTasks, worldTask, currentTurn);
                const system = [
                    'You are LIBRA State Consolidation Bundler.',
                    'Summarize character state logs and world state logs in one compact JSON response.',
// 세계는 세포(인물)들이 모인 개체다. 각자를 따로 요약하는 데서 멈추지 말고,
// 인물들의 움직임이 세계에 어떤 변화를 만드는지(개체 관점)를 world.summary 에 반영한다.
'Treat the world as an organism whose cells are the characters: besides summarizing each side, state how the characters\' movements change the world (collective movement, gathering, absence, or a shift that several characters share), and put that in world.summary.',
                    'If a LIBRA Internal Data Language Guard is present, use that target language for generated summary values; otherwise preserve the same language as the logs. Do not invent events, locations, moods, health states, rules, or dimension shifts.',
                    'Return JSON only with this shape:',
                    '{"characters":[{"name":"","summary":"","significantChanges":[]}],"world":{"summary":"","significantChanges":[],"charactersChangeWorld":false,"criticalReason":"","criticalEntities":[]}}',
                    // 세계는 세포(인물)들이 모인 개체다. 각 세포의 요약에서 멈추지 말고
                    // **세포들의 움직임이 개체 자체를 바꿨는가**를 판정한다.
                    // 숫자로 자르지 않는다 — 임계는 문맥 판단이다(하드코딩 규칙은 오작동을 만든다).
                    'Judge whether the characters\' collective movement changed the world itself — not merely whether each character moved.',
                    // 실측(2026-09-29, qwen3.5:9b): 첫 프롬프트는 개인 부상을 세계 변화로 오판했다
                    //   ("아리엘의 부상으로 인해 세계 내 건강 상태가 변경됨").
                    //   개인이 변한 것과 세계가 변한 것을 **명시적으로 갈라** 말해야 한다.
                    'A character\'s own condition changing — injury, health, mood, emotion, personal gain or loss, a private decision, a single person moving or acting — is NOT a world change; that belongs to the character, not to the world. Set world.charactersChangeWorld=true ONLY when something about the world itself is now different: several characters shifting together toward one place (or leaving one behind), a group gathering or scattering, or a shared arrangement, commitment, loss, arrival, or departure that moves the centre of gravity of the world. Ask yourself: if only this one character had stayed put, would the world be the same? If yes, charactersChangeWorld is false. When true, put a short criticalReason and the names involved in criticalEntities. When false, leave criticalReason empty and criticalEntities [].',
                ].join('\n');
                const user = JSON.stringify(payload, null, 2);
                const maxTokens = Math.min(6000, Math.max(1200, 500 + characterTasks.length * 320 + (worldTask ? 500 : 0)));
                const result = await runMaintenanceLLM(() =>
                    LLMProvider.call(config, system, user, {
                        maxTokens,
                        profile,
                        label: `state-consolidation-bundle-${profile}`,
                        domain: 'state_consolidation',
                        reason: 'state-consolidation-bundle',
                        disableReasoning: true
                    })
                , `state-consolidation-bundle-${currentTurn}`);
                const parsed = parseBundleResult(result?.content || '');
                if (!parsed) throw new Error('state_consolidation_bundle_invalid_json');
                const applied = applyParsedBundle(parsed, characterTasks, worldTask, currentTurn);
                return { mode: 'bundle', applied, characters: characterTasks.length, world: !!worldTask };
            } catch (error) {
                if (config?.debug) recordRuntimeDebug('warn', '[LIBRA] State consolidation bundle failed; falling back to split consolidation:', error?.message || error);
                await Promise.allSettled([
                    ...characterTasks.map(task => CharacterStateTracker.consolidateIfNeeded(task.name, currentTurn, config)),
                    worldTask ? WorldStateTracker.consolidateIfNeeded(currentTurn, config) : Promise.resolve()
                ]);
                return { mode: 'fallback-split', characters: characterTasks.length, world: !!worldTask };
            }
        };

        return { consolidateIfNeeded };
    })();
