    // [MANAGER] SourceReflectionManager — source data -> visible LIBRA data only
    // ══════════════════════════════════════════════════════════════
    const SourceReflectionManager = (() => {
        const COMMENT = 'lmai_source_reflection_state';
        const VERSION = 1;
        const MAX_TEXTS_PER_SOURCE = 48;
        const MAX_CHARS_PER_TEXT = 2400;
        const MAX_COMBINED_CHARS = 52000;
        const SOURCE_LABELS = Object.freeze({
            character_card: 'Character Card + Character Lorebook',
            persona_binding: 'RisuAI Persona Binding',
            module_lorebook: 'Selected Module Lorebook'
        });
        const clip = (value = '', max = MAX_CHARS_PER_TEXT) => {
            const text = String(value || '')
                .replace(/\r\n/g, '\n')
                .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .trim();
            const limit = Math.max(120, Number(max || MAX_CHARS_PER_TEXT));
            return text.length > limit ? `${text.slice(0, limit).trim()}...[cut]` : text;
        };
        const normalizeId = (value = '') => String(value || '')
            .normalize('NFKC')
            .trim()
            .toLowerCase()
            .replace(/[\s]+/g, '_');
        const splitIds = (value = '') => {
            if (Array.isArray(value)) return value.map(splitIds).flat().filter(Boolean);
            return String(value || '')
                .split(/[\n\r,|;]+/g)
                .map(normalizeId)
                .filter(Boolean);
        };
        const moduleIdentityKeys = (module = null) => [
            module?.id,
            module?._id,
            module?.key,
            module?.namespace,
            module?.name,
            module?.displayName
        ].map(normalizeId).filter(Boolean);
        const getScopeKey = (chat = null, char = null) => getChatRuntimeScopeKey(chat || {}, char || {});
        const getStateIndex = (lorebook = [], scopeKey = '') => (Array.isArray(lorebook) ? lorebook : []).findIndex(entry => {
            if (entry?.comment !== COMMENT) return false;
            try {
                const parsed = JSON.parse(entry.content || '{}');
                return String(parsed?.scopeKey || '') === String(scopeKey || '');
            } catch {
                return false;
            }
        });
        const loadState = (lorebook = [], scopeKey = '') => {
            const idx = getStateIndex(lorebook, scopeKey);
            if (idx < 0) return { version: VERSION, scopeKey, signatures: {}, counts: {}, reflectedAt: 0, sources: {} };
            try {
                const parsed = JSON.parse(lorebook[idx].content || '{}');
                return {
                    version: VERSION,
                    scopeKey,
                    signatures: parsed?.signatures && typeof parsed.signatures === 'object' ? parsed.signatures : {},
                    counts: parsed?.counts && typeof parsed.counts === 'object' ? parsed.counts : {},
                    reflectedAt: Number(parsed?.reflectedAt || 0),
                    sources: parsed?.sources && typeof parsed.sources === 'object' ? parsed.sources : {}
                };
            } catch {
                return { version: VERSION, scopeKey, signatures: {}, counts: {}, reflectedAt: 0, sources: {} };
            }
        };
        const saveState = (lorebook = [], state = {}, chat = null, char = null) => {
            if (!Array.isArray(lorebook)) return false;
            const normalizedState = {
                ...((state && typeof state === 'object') ? state : {}),
                signatures: state?.signatures && typeof state.signatures === 'object' ? { ...state.signatures } : {},
                counts: state?.counts && typeof state.counts === 'object' ? { ...state.counts } : {},
                sources: state?.sources && typeof state.sources === 'object' ? { ...state.sources } : {}
            };
            const scopeKey = String(normalizedState?.scopeKey || getScopeKey(chat, char) || 'global');
            const payload = {
                version: VERSION,
                scopeKey,
                chatId: String(chat?.id || '').trim(),
                charId: String(char?.chaId || char?.id || '').trim(),
                reflectedAt: Date.now(),
                signatures: normalizedState?.signatures && typeof normalizedState.signatures === 'object' ? normalizedState.signatures : {},
                counts: normalizedState?.counts && typeof normalizedState.counts === 'object' ? normalizedState.counts : {},
                sources: normalizedState?.sources && typeof normalizedState.sources === 'object' ? normalizedState.sources : {}
            };
            const entry = {
                key: `lmai_source_reflection_state::${TokenizerEngine.simpleHash(scopeKey)}`,
                comment: COMMENT,
                content: JSON.stringify(payload, null, 2),
                mode: 'normal',
                insertorder: 89,
                alwaysActive: false
            };
            const idx = getStateIndex(lorebook, scopeKey);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
            return true;
        };
        const pushText = (items, label, text, max = MAX_CHARS_PER_TEXT) => {
            const clipped = clip(text, max);
            if (!clipped) return;
            items.push(`[${label}]\n${clipped}`);
        };
        const collectCharacterSourceTexts = (char = null, chat = null) => {
            const texts = [];
            if (!char || typeof char !== 'object') return texts;
            const fields = [
                ['Character Name', char.name || char.displayName],
                ['Character Description', char.description || char.desc || char.detail || char.details],
                ['Character Personality', char.personality || char.persona || char.traits],
                ['Scenario', char.scenario || char.situation || char.context],
                ['First Message', char.firstMessage || char.first_message || char.greeting],
                ['Creator Notes', char.creatorNotes || char.creator_notes || char.note || char.notes],
                ['Default Variables', char.defaultVariables]
            ];
            for (const [label, value] of fields) pushText(texts, label, value, 3000);
            const lore = getCbsResolvedCharacterLoreEntries({ char, chat }) || MemoryEngine.getEffectiveLorebook(char, null);
            lore
                .filter(entry => !entry?.comment || !String(entry.comment).startsWith('lmai_'))
                .slice(0, MAX_TEXTS_PER_SOURCE)
                .forEach((entry, index) => {
                    const key = [entry?.key, entry?.secondkey].map(v => String(v || '').trim()).filter(Boolean).join(' / ');
                    const title = key || entry?.comment || entry?.id || `entry-${index + 1}`;
                    pushText(texts, `Character Lorebook: ${title}`, entry?.content || '', 2200);
                });
            return texts.slice(0, MAX_TEXTS_PER_SOURCE);
        };
        const extractPersonaPrompt = (persona = null) => {
            if (!persona || typeof persona !== 'object') return '';
            const fields = [
                persona.personaPrompt,
                persona.prompt,
                persona.description,
                persona.desc,
                persona.detail,
                persona.details,
                persona.note,
                persona.notes,
                persona.content
            ];
            return clip(fields.map(v => String(v || '').trim()).filter(Boolean).join('\n\n'), 6000);
        };
        const getPersonaBindingHint = (chat = null, char = null) => {
            for (const value of [chat?.bindedPersona, chat?.boundPersonaId, chat?.boundPersona, chat?.personaId, chat?.persona, char?.bindedPersona]) {
                if (value == null || (typeof value === 'string' && !value.trim())) continue;
                if (typeof value !== 'string') return { explicit: true, invalid: true, id: '' };
                return { explicit: true, invalid: false, id: value.trim() };
            }
            return { explicit: false, invalid: false, id: '' };
        };
        const resolvePersonaBinding = (db = null, chat = null, char = null) => {
            const personas = Array.isArray(db?.personas) ? db.personas : [];
            const byId = (id = '') => {
                const needle = String(id || '').trim();
                if (!needle) return null;
                return personas.find(p => String(p?.id || p?._id || p?.key || '').trim() === needle) || null;
            };
            const hint = getPersonaBindingHint(chat, char);
            if (hint.invalid) return null;
            const boundId = hint.id;
            let persona = byId(boundId);
            if (boundId && !persona) return null;
            let source = persona ? 'chat_binding' : '';
            if (!persona) {
                const selected = Number(db?.selectedPersona);
                if (db?.selectedPersona !== null && db?.selectedPersona !== undefined && String(db.selectedPersona).trim() !== ''
                    && Number.isInteger(selected) && selected >= 0 && personas[selected]) {
                    persona = personas[selected];
                    source = 'selectedPersona';
                }
            }
            if (!persona) return null;
            const name = String(persona.name || persona.displayName || persona.nickname || 'User').trim() || 'User';
            const prompt = extractPersonaPrompt(persona);
            return {
                id: String(persona.id || persona._id || persona.key || '').trim(),
                name,
                source,
                prompt,
                raw: persona
            };
        };
        const buildPersonaAliasCandidates = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return [];
            const aliases = new Set([raw]);
            aliases.add(raw.toLowerCase());
            raw.split(/[\s,;|/·・]+/g).map(part => part.trim()).filter(Boolean).forEach(part => {
                aliases.add(part);
                aliases.add(part.toLowerCase());
            });
            const withoutTemplate = raw.replace(/\{\{\s*user\s*\}\}/gi, '').trim();
            if (withoutTemplate) aliases.add(withoutTemplate);
            return [...aliases].filter(Boolean).slice(0, 24);
        };
        const collectPersonaTexts = (db = null, chat = null, char = null) => {
            const persona = resolvePersonaBinding(db, chat, char);
            if (!persona) return [];
            const texts = [];
            pushText(texts, `Persona Binding: ${persona.name} (${persona.source || 'unknown'})`, persona.prompt || persona.name, 4000);
            return texts;
        };
        const syncPersonaIdentity = async (char = null, chat = null, lorebook = [], db = null, options = {}) => {
            if (!Array.isArray(lorebook)) return { changed: false, reason: 'invalid_lore' };
            const persona = resolvePersonaBinding(db, chat, char);
            if (!persona) return { changed: false, reason: 'no_persona' };
            EntityManager.refreshIdentity(char, db, chat);
            const canonical = persona.name || 'User';
            const aliases = new Set(['user', '사용자', 'you', 'me', '나', '본인', '{{user}}']);
            buildPersonaAliasCandidates(canonical).forEach(alias => aliases.add(alias));
            const promptText = persona.prompt || '';
            const aliasMatches = promptText.match(/(?:alias|aliases|별칭|호칭|이름)\s*[:=]\s*([^\n]+)/gi) || [];
            aliasMatches.forEach(line => String(line).split(/[:=]/).slice(1).join(':').split(/[,/|;·・]/g).forEach(part => {
                const v = part.trim();
                if (v) buildPersonaAliasCandidates(v).forEach(alias => aliases.add(alias));
            }));
            const scopeKey = getScopeKey(chat, char);
            const signature = TokenizerEngine.simpleHash(JSON.stringify({ id: persona.id, name: persona.name, source: persona.source, prompt: promptText }));
            const stateEntry = {
                version: 1,
                scopeKey,
                chatId: String(chat?.id || '').trim(),
                personaId: persona.id,
                personaName: persona.name,
                source: persona.source,
                signature,
                aliases: [...aliases].slice(0, 80),
                updatedAt: Date.now(),
                note: 'Visible sync record only. The persona prompt itself is not directly injected by LIBRA.'
            };
            const entry = {
                key: `lmai_user_identity::${TokenizerEngine.simpleHash(scopeKey || persona.name)}`,
                comment: 'lmai_user_identity',
                content: JSON.stringify(stateEntry, null, 2),
                mode: 'normal',
                insertorder: 88,
                alwaysActive: false
            };
            let changed = false;
            const existingIdx = lorebook.findIndex(item => item?.comment === 'lmai_user_identity');
            const existingSig = existingIdx >= 0 ? (() => { try { return JSON.parse(lorebook[existingIdx].content || '{}')?.signature || ''; } catch { return ''; } })() : '';
            if (existingIdx < 0) { lorebook.push(entry); changed = true; }
            else if (existingSig !== signature) { lorebook[existingIdx] = entry; changed = true; }
            const existingEntity = EntityManager.getOrCreateEntity(canonical, lorebook);
            const beforeEntity = JSON.stringify(existingEntity || {});
            const updates = {
                source: 'persona_binding',
                s_id: 'persona_binding',
                background: { history: promptText ? [`RisuAI persona binding: ${clip(promptText, 420)}`] : [] },
                forceReplace: false
            };
            const entity = EntityManager.updateEntity(canonical, updates, lorebook);
            if (entity) {
                entity.meta = entity.meta || {};
                const aliasList = [...aliases].slice(0, 80);
                entity.meta.role = 'user_persona';
                entity.meta.isUserPersona = true;
                entity.meta.personaId = persona.id || entity.meta.personaId || '';
                entity.meta.personaSource = persona.source || entity.meta.personaSource || '';
                entity.meta.aliases = dedupeTextArray([...(Array.isArray(entity.meta.aliases) ? entity.meta.aliases : []), ...aliasList]);
                entity.meta.hiddenNameKeys = dedupeTextArray([...(Array.isArray(entity.meta.hiddenNameKeys) ? entity.meta.hiddenNameKeys : []), ...aliasList.map(a => String(a || '').toLowerCase())]);
                if (JSON.stringify(entity) !== beforeEntity) changed = true;
            }
            return { changed, persona: stateEntry, signature };
        };
        const collectModuleLoreTexts = (db = null, selectedIdsRaw = '') => {
            const selected = new Set(splitIds(selectedIdsRaw));
            if (selected.size === 0) return [];
            const modules = Array.isArray(db?.modules) ? db.modules : [];
            const texts = [];
            modules.forEach(module => {
                const keys = moduleIdentityKeys(module);
                if (!keys.some(key => selected.has(key))) return;
                const lore = Array.isArray(module?.lorebook)
                    ? module.lorebook
                    : Array.isArray(module?.data?.lorebook)
                        ? module.data.lorebook
                        : Array.isArray(module?.lore)
                            ? module.lore
                            : [];
                lore
                    .filter(entry => entry && entry.disabled !== true && entry.enabled !== false)
                    .slice(0, MAX_TEXTS_PER_SOURCE)
                    .forEach((entry, idx) => {
                        const title = [module.name || module.namespace || module.id || 'module', entry.comment || entry.key || `entry-${idx + 1}`]
                            .map(v => String(v || '').trim()).filter(Boolean).join(' :: ');
                        const body = [entry.key ? `key: ${entry.key}` : '', entry.secondkey ? `secondkey: ${entry.secondkey}` : '', entry.content || '']
                            .filter(Boolean).join('\n');
                        pushText(texts, `Module Lorebook: ${title}`, body, 2200);
                    });
            });
            return texts.slice(0, MAX_TEXTS_PER_SOURCE);
        };
        const computeSignature = (items = []) => TokenizerEngine.simpleHash(JSON.stringify((Array.isArray(items) ? items : []).map(item => clip(item, 1200))));
        const trimCombined = (items = []) => {
            const out = [];
            let chars = 0;
            for (const item of Array.isArray(items) ? items : []) {
                const text = clip(item, MAX_CHARS_PER_TEXT);
                if (!text) continue;
                const nextLen = chars + text.length + 2;
                if (nextLen > MAX_COMBINED_CHARS) break;
                out.push(text);
                chars = nextLen;
            }
            return out;
        };
        const collectSources = (char = null, chat = null, db = null, config = MemoryEngine.CONFIG) => {
            const sources = {};
            if (config?.characterSourceReflectionEnabled !== false) sources.character_card = collectCharacterSourceTexts(char, chat);
            if (config?.personaBindingSyncEnabled !== false) sources.persona_binding = collectPersonaTexts(db, chat, char);
            if (config?.moduleLorebookReflectionEnabled === true && String(config?.moduleLorebookSelectedIds || '').trim()) {
                sources.module_lorebook = collectModuleLoreTexts(db, config.moduleLorebookSelectedIds);
            }
            return sources;
        };
        const reflectIfNeeded = async (char = null, chat = null, lorebook = [], db = null, options = {}) => {
            if (!Array.isArray(lorebook)) return { ok: false, changed: false, reason: 'invalid_lore' };
            const config = MemoryEngine.CONFIG || {};
            const analysisConfig = options.analysisConfig || captureWmAnalysisConfig(config);
            const scopeKey = getScopeKey(chat, char);
            const previous = loadState(lorebook, scopeKey);
            let cbsPreResolve = null;
            if (config.cbsEnabled !== false && typeof CharacterLoreCbsPreResolver !== 'undefined' && CharacterLoreCbsPreResolver?.resolve) {
                try {
                    cbsPreResolve = await CharacterLoreCbsPreResolver.resolve({ char, chat, db, lorebook, scopeKey, mode: 'prompt' });
                } catch (error) {
                    if (config.debug) recordRuntimeDebug('warn', '[LIBRA] Source reflection character lore CBS pre-resolve skipped:', error?.message || error);
                }
            }
            let personaSync = { changed: false };
            if (config.personaBindingSyncEnabled !== false) {
                personaSync = await syncPersonaIdentity(char, chat, lorebook, db, options);
            }
            const sources = collectSources(char, chat, db, config);
            const signatures = { ...(previous.signatures || {}) };
            const counts = {};
            const sourcesSummary = {};
            const changedTypes = [];
            for (const [type, items] of Object.entries(sources)) {
                const normalizedItems = trimCombined(items);
                counts[type] = normalizedItems.length;
                sourcesSummary[type] = { label: SOURCE_LABELS[type] || type, count: normalizedItems.length };
                const sig = computeSignature(normalizedItems);
                if (sig && sig !== previous.signatures?.[type]) changedTypes.push(type);
                signatures[type] = sig;
            }
            const reflectTypes = changedTypes.filter(type => type !== 'persona_binding' && counts[type] > 0);
            let reflected = false;
            let llmSkipped = false;
            if ((options.force === true || reflectTypes.length > 0) && reflectTypes.length > 0) {
                if (!config.useLLM) {
                    llmSkipped = true;
                } else {
                    const combinedTexts = trimCombined(reflectTypes.flatMap(type => sources[type] || []));
                    if (combinedTexts.length > 0) {
                        notifyLibraTask('원천 데이터를 LIBRA 데이터에 반영하고 있습니다.', { key: `libra-source-reflect-${scopeKey}`, duration: 1600 });
                        const label = reflectTypes.map(type => SOURCE_LABELS[type] || type).join(' + ');
                        await ColdStartManager.integrateImportedKnowledge(combinedTexts, label, {
                            analysisConfig,
                            sourceId: reflectTypes.length === 1 ? reflectTypes[0] : 'source_reflection',
                            worldNote: `Updated via ${label} source reflection`,
                            updateNarrative: true,
                            cbsResolvedCharacterLore: Array.isArray(cbsPreResolve?.entries) ? cbsPreResolve.entries : null,
                            cbsPreResolveMeta: cbsPreResolve || null,
                            targetChar: char,
                            targetChat: chat
                        });
                        reflected = true;
                    }
                }
            }
            if (llmSkipped && !personaSync.changed) {
                return { ok: false, changed: false, reason: 'llm_disabled', changedTypes, counts };
            }
            if (!reflected && !personaSync.changed && changedTypes.length === 0 && options.force !== true) {
                return { ok: true, changed: false, reflected: false, personaSynced: false, changedTypes, counts };
            }
            const latestCtx = await resolveActiveChatContext(chat);
            const expectedChatId = String(chat?.id || '').trim();
            if (expectedChatId && (!latestCtx?.chat || String(latestCtx.chat?.id || '') !== expectedChatId)) {
                throw new Error('원천 데이터 반영 대상 채팅방을 찾을 수 없습니다.');
            }
            const latestChar = latestCtx?.char || char;
            const latestChat = latestCtx?.chat || chat;
            const latestLore = MemoryEngine.getLorebook(latestChar, latestChat) || lorebook;
            if (personaSync.changed && latestLore !== lorebook) {
                personaSync = await syncPersonaIdentity(latestChar, latestChat, latestLore, db, options);
            }
            if (personaSync.changed) {
                await EntityManager.saveToLorebook(latestChar, latestChat, latestLore);
            }
            saveState(latestLore, { scopeKey: getScopeKey(latestChat, latestChar), signatures, counts, sources: sourcesSummary }, latestChat, latestChar);
            await SecretKnowledgeCore.saveState(latestLore, {
                scopeKey: getChatRuntimeScopeKey(latestChat, latestChar),
                chatId: String(latestChat?.id || getActiveManagedChatId() || '').trim()
            });
            await EntityKnowledgeVaultCore.saveState(latestLore, {
                scopeKey: getChatRuntimeScopeKey(latestChat, latestChar),
                chatId: String(latestChat?.id || getActiveManagedChatId() || '').trim()
            });
            await TimeEngine.saveState(latestLore, {
                scopeKey: getChatRuntimeScopeKey(latestChat, latestChar),
                chatId: String(latestChat?.id || getActiveManagedChatId() || '').trim()
            });
            MemoryEngine.setLorebook(latestChar, latestChat, latestLore);
            const persistResult = await persistLoreToActiveChat(latestChat, latestLore);
            if (!persistResult?.ok) {
                throw new Error(`원천 데이터 반영 저장 실패: ${persistResult?.reason || 'unknown'}`);
            }
            if (reflected || personaSync.changed) notifyLibraTask('원천 데이터 반영을 완료했습니다.', { key: `libra-source-reflect-complete-${scopeKey}`, duration: 1500 });
            return { ok: !llmSkipped, changed: reflected || personaSync.changed, reflected, personaSynced: !!personaSync.changed, changedTypes, counts, reason: llmSkipped ? 'llm_disabled' : undefined };
        };
        const getStatus = (lorebook = [], chat = null, char = null) => {
            const scopeKey = getScopeKey(chat, char);
            const state = loadState(lorebook, scopeKey);
            return {
                ok: true,
                scopeKey,
                reflectedAt: state.reflectedAt || 0,
                counts: state.counts || {},
                sources: state.sources || {},
                signatures: state.signatures || {}
            };
        };
        const getSelectedActiveModuleIds = (db = null, chat = null, char = null) => {
            const ids = new Set();
            const add = (value) => splitIds(value).forEach(id => ids.add(id));
            add(db?.enabledModules);
            add(db?.moduleIntergration);
            add(db?.moduleIntegration);
            add(chat?.modules);
            add(char?.modules);
            return [...ids].filter(Boolean);
        };
        return Object.freeze({
            reflectIfNeeded,
            getStatus,
            collectSources,
            collectModuleLoreTexts,
            collectCharacterSourceTexts,
            resolvePersonaBinding,
            getPersonaBindingHint,
            syncPersonaIdentity,
            getSelectedActiveModuleIds,
            splitIds
        });
    })();

    // ══════════════════════════════════════════════════════════════

    const getCbsResolvedCharacterLoreScopeKey = (context = {}) => {
        const chat = context?.chat || context?.targetChat || null;
        const char = context?.char || context?.character || context?.targetChar || null;
        return String(
            context?.scopeKey
            || context?.scopeId
            || (chat ? getChatRuntimeScopeKey(chat, char) : '')
            || chat?.id
            || getActiveManagedRuntimeScopeKey()
            || 'global'
        ).trim() || 'global';
    };
    const cloneCbsResolvedLoreEntries = (entries = []) => (Array.isArray(entries) ? entries : [])
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => {
            const cloned = safeClone(entry);
            try {
                Object.defineProperty(cloned, '__libraCbsPreResolved', {
                    value: true,
                    enumerable: false,
                    configurable: true
                });
            } catch (_) {}
            return cloned;
        });
    const getCbsResolvedCharacterLoreSnapshot = (context = {}) => {
        try {
            const scopeKey = getCbsResolvedCharacterLoreScopeKey(context);
            const snapshot = MemoryState?.cbsResolvedCharacterLoreByScope?.get?.(scopeKey) || null;
            if (!snapshot || !Array.isArray(snapshot.entries)) return null;
            // A derived snapshot is usable only while its native source still matches.
            // Checking here also covers synchronous cue rebuilds that skip the resolver.
            if (MemoryEngine.CONFIG?.cbsEnabled === false || !CBSEngine.isCharacterLoreSnapshotReusable(context) || !snapshot.sourceSignature
                || snapshot.sourceSignature !== CBSEngine.getCharacterLoreSourceSignature(context)) {
                MemoryState.cbsResolvedCharacterLoreByScope.delete(scopeKey);
                return null;
            }
            return {
                ...snapshot,
                entries: cloneCbsResolvedLoreEntries(snapshot.entries)
            };
        } catch (_) {
            return null;
        }
    };
    const getCbsResolvedCharacterLoreEntries = (context = {}) => {
        const snapshot = getCbsResolvedCharacterLoreSnapshot(context);
        return snapshot ? cloneCbsResolvedLoreEntries(snapshot.entries) : null;
    };
    const setCbsResolvedCharacterLoreSnapshot = (context = {}, payload = {}) => {
        try {
            const scopeKey = getCbsResolvedCharacterLoreScopeKey(context);
            // Hidden host values have no revision proof for later synchronous reads.
            // Keep their resolved entries request-local, never a reusable snapshot.
            if (context?.cbsReadLease?.cancelled || !CBSEngine.isCharacterLoreSnapshotReusable(context) || payload?.bridge?.candidateCounts?.global > 0
                || payload?.bridge?.candidateCounts?.toggle > 0 || !Array.isArray(payload?.entries)
                || payload?.sourceSignature !== CBSEngine.getCharacterLoreSourceSignature(context)) return null;
            const entries = cloneCbsResolvedLoreEntries(payload.entries);
            const snapshot = {
                scopeKey,
                entries,
                rawEntryCount: Number(payload?.rawEntryCount || entries.length || 0),
                resolvedEntryCount: Number(payload?.resolvedEntryCount || entries.length || 0),
                macroCount: Number(payload?.macroCount || 0),
                changed: payload?.changed === true,
                signature: String(payload?.signature || ''),
                runtimeSignature: String(payload?.runtimeSignature || ''),
                sourceSignature: String(payload?.sourceSignature || ''),
                supportedTags: Array.isArray(payload?.supportedTags) ? payload.supportedTags.slice(0, 80) : [],
                unsupportedTags: Array.isArray(payload?.unsupportedTags) ? payload.unsupportedTags.slice(0, 80) : [],
                hiddenKeys: Array.isArray(payload?.hiddenKeys) ? payload.hiddenKeys.slice(0, 120) : [],
                updatedAt: Date.now()
            };
            if (!MemoryState.cbsResolvedCharacterLoreByScope) MemoryState.cbsResolvedCharacterLoreByScope = new Map();
            MemoryState.cbsResolvedCharacterLoreByScope.set(scopeKey, snapshot);
            return {
                ...snapshot,
                entries: cloneCbsResolvedLoreEntries(snapshot.entries)
            };
        } catch (_) {
            return null;
        }
    };
    const clearCbsResolvedCharacterLoreSnapshot = (context = {}) => {
        try {
            return MemoryState?.cbsResolvedCharacterLoreByScope?.delete?.(getCbsResolvedCharacterLoreScopeKey(context)) === true;
        } catch (_) {
            return false;
        }
    };

    // ══════════════════════════════════════════════════════════════
    // [ENGINE] CBSEngine
    // ══════════════════════════════════════════════════════════════
    const CBSEngine = (() => {
        const R = /^(\w+)\s*(>=|<=|==|!=|>|<)\s*(".*?"|-?\d+\.?\d*)$/;
        const safeTrim = (v) => typeof v === "string" ? v.trim() : "";
        const CBS_TEXT_FIELDS = ['content', 'text', 'description', 'desc', 'memo', 'note', 'notes'];
        const CBS_KEY_FIELDS = ['key', 'secondkey', 'keys', 'selective', 'selectiveLogic', 'comment', 'name', 'title'];

        function hasStandaloneCbsSyntax(value) {
            if (value == null) return false;
            if (typeof value === 'string') return value.includes('{{') || value.includes('[CBS_EXPR:');
            if (Array.isArray(value)) return value.some(item => hasStandaloneCbsSyntax(item));
            if (typeof value === 'object') return Object.values(value).some(item => hasStandaloneCbsSyntax(item));
            return false;
        }

        function coerceStandaloneCbsValue(value) {
            if (value == null) return 'null';
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
            try { return JSON.stringify(value); } catch (_) { return String(value || ''); }
        }

        function writeStandaloneCbsVar(target, rawKey, value, overwrite = true) {
            if (!target || typeof target !== 'object') return;
            const key = String(rawKey || '').trim();
            if (!key || (!overwrite && Object.prototype.hasOwnProperty.call(target, key))) return;
            target[key] = coerceStandaloneCbsValue(value);
        }

        function collectStandaloneCbsVariables(target, source, overwrite = true) {
            if (!target || !source) return;
            if (typeof source === 'string') {
                parseDefaultVariables(source).forEach(([key, value]) => writeStandaloneCbsVar(target, key, value, overwrite));
                return;
            }
            if (Array.isArray(source)) {
                source.forEach((item) => {
                    if (Array.isArray(item) && item.length >= 2) writeStandaloneCbsVar(target, item[0], item[1], overwrite);
                    else if (item && typeof item === 'object') {
                        const key = item.key ?? item.name ?? item.id;
                        if (key != null && ('value' in item || 'val' in item || 'content' in item)) {
                            writeStandaloneCbsVar(target, key, item.value ?? item.val ?? item.content, overwrite);
                        } else {
                            collectStandaloneCbsVariables(target, item, overwrite);
                        }
                    }
                });
                return;
            }
            if (source instanceof Map) {
                source.forEach((value, key) => writeStandaloneCbsVar(target, key, value, overwrite));
                return;
            }
            if (typeof source === 'object') {
                Object.entries(source).forEach(([key, value]) => writeStandaloneCbsVar(target, key, value, overwrite));
            }
        }

        function makeStandaloneCbsRuntimeSignature(runtime = {}) {
            try {
                const chatVariables = runtime?.chatVariables || runtime?.vars || {};
                const globalVariables = runtime?.globalVariables || runtime?.globalVars || {};
                const toggleVariables = runtime?.toggleVariables || {};
                const vars = Object.keys(chatVariables).sort().map(key => [key, String(chatVariables[key] ?? '').slice(0, 300)]);
                const globalVars = Object.keys(globalVariables).sort().map(key => [key, String(globalVariables[key] ?? '').slice(0, 300)]);
                const toggles = Object.keys(toggleVariables).sort().map(key => [key, String(toggleVariables[key] ?? '').slice(0, 120)]);
                return String(TokenizerEngine.simpleHash(JSON.stringify({
                    char: runtime?.char?.id || runtime?.char?._id || runtime?.characterName || runtime?.char?.name || '',
                    chat: runtime?.chat?.id || runtime?.chat?._id || '',
                    userName: runtime?.userName || '',
                    personaId: runtime?.personaId || '',
                    personaDescription: runtime?.personaDescription || '',
                    vars,
                    globalVars,
                    toggles,
                    bridgeFingerprint: runtime?.__libraCbsBridge?.manifest?.fingerprint || ''
                })));
            } catch (_) {
                return '';
            }
        }

        function cloneStandaloneLoreEntry(entry = {}) {
            const cloned = safeClone(entry && typeof entry === 'object' ? entry : {});
            return cloned && typeof cloned === 'object' ? cloned : {};
        }

        function parseDefaultVariables(raw) {
            return String(raw || "").split(/\r?\n/g).map((line) => line.trim()).filter(Boolean).map((line) => {
                const eq = line.indexOf("=");
                if (eq === -1) return null;
                return [line.slice(0, eq).trim(), line.slice(eq + 1)];
            }).filter((pair) => pair && pair[0]);
        }

        function splitTopLevelCbsByDoubleColon(raw) {
            const src = String(raw || "");
            const result = [];
            let current = "", braceDepth = 0, parenDepth = 0;
            for (let i = 0; i < src.length; i += 1) {
                const two = src.slice(i, i + 2);
                if (two === "{{") { braceDepth += 1; current += two; i += 1; continue; }
                if (two === "}}" && braceDepth > 0) { braceDepth -= 1; current += two; i += 1; continue; }
                if (src[i] === "(") parenDepth += 1;
                if (src[i] === ")" && parenDepth > 0) parenDepth -= 1;
                if (two === "::" && braceDepth === 0 && parenDepth === 0) { result.push(current); current = ""; i += 1; continue; }
                current += src[i];
            }
            result.push(current);
            return result;
        }

        function readCbsTagAt(text, startIndex) {
            if (String(text || "").slice(startIndex, startIndex + 2) !== "{{") return null;
            let depth = 1, i = startIndex + 2;
            while (i < text.length) {
                const two = text.slice(i, i + 2);
                if (two === "{{") { depth += 1; i += 2; continue; }
                if (two === "}}") { depth -= 1; i += 2; if (depth === 0) return { start: startIndex, end: i, raw: text.slice(startIndex, i), inner: text.slice(startIndex + 2, i - 2) }; continue; }
                i += 1;
            }
            return null;
        }

        function findNextCbsTag(text, startIndex) {
            const src = String(text || "");
            for (let i = startIndex; i < src.length - 1; i += 1) { if (src[i] === "{" && src[i + 1] === "{") return readCbsTagAt(src, i); }
            return null;
        }

        function readBracketCbsExprAt(text, startIndex) {
            const src = String(text || "");
            if (src.slice(startIndex, startIndex + 10) !== "[CBS_EXPR:") return null;
            let i = startIndex + 10;
            while (i < src.length) {
                if (src[i] === "]") {
                    return {
                        start: startIndex,
                        end: i + 1,
                        raw: src.slice(startIndex, i + 1),
                        inner: src.slice(startIndex + 10, i)
                    };
                }
                i += 1;
            }
            return null;
        }

        function findNextBracketCbsExpr(text, startIndex) {
            const src = String(text || "");
            for (let i = startIndex; i < src.length - 9; i += 1) {
                if (src[i] === "[" && src.slice(i, i + 10) === "[CBS_EXPR:") return readBracketCbsExprAt(src, i);
            }
            return null;
        }

        function findNextAnyCbsToken(text, startIndex) {
            const curly = findNextCbsTag(text, startIndex);
            const bracket = findNextBracketCbsExpr(text, startIndex);
            if (!curly) return bracket;
            if (!bracket) return curly;
            return curly.start <= bracket.start ? curly : bracket;
        }

        function extractCbsBlock(text, startTag, blockName) {
            let depth = 1, cursor = startTag.end, elseTag = null;
            while (cursor < text.length) {
                const tag = findNextCbsTag(text, cursor);
                if (!tag) break;
                const inner = safeTrim(tag.inner);
                const opensSameBlock = inner.startsWith(`#${blockName} `) || inner.startsWith(`#${blockName}::`);
                const closesSameBlock = inner === `/${blockName}` || inner === "/";
                const isElseTag = inner === "else" || inner === ":else";
                if (opensSameBlock) depth += 1;
                else if (closesSameBlock) { depth -= 1; if (depth === 0) return { body: text.slice(startTag.end, elseTag ? elseTag.start : tag.start), elseBody: elseTag ? text.slice(elseTag.end, tag.start) : "", end: tag.end }; }
                else if (isElseTag && depth === 1 && (blockName === "if" || blockName === "when")) elseTag = tag;
                cursor = tag.end;
            }
            return { body: text.slice(startTag.end), elseBody: "", end: text.length };
        }

        function trimLegacyCbsBlockBody(text) {
            const src = String(text ?? "").replace(/^\n+|\n+$/g, "");
            return src.split(/\r?\n/g).map((line) => line.replace(/^\s+/, "")).join("\n");
        }

        async function evalStandaloneWhenCondition(rawCondition, runtime, args = []) {
            const tokens = splitTopLevelCbsByDoubleColon(String(rawCondition ?? ""));
            let mode = "default";
            if (tokens[0] && safeTrim(tokens[0]).toLowerCase() === "keep") {
                mode = "keep";
                tokens.shift();
            } else if (tokens[0] && safeTrim(tokens[0]).toLowerCase() === "legacy") {
                mode = "legacy";
                tokens.shift();
            }

            async function evalTokens(items) {
                const parts = items.map((item) => safeTrim(String(item ?? ""))).filter((item) => item.length > 0);
                if (parts.length === 0) return false;
                if (parts[0] === "not") return !(await evalTokens(parts.slice(1)));
                if ((parts[0] === "var" || parts[0] === "toggle") && parts.length >= 2) {
                    const value = await renderStandaloneCbsText(parts.slice(1).join("::"), runtime, args);
                    return isStandaloneCbsTruthy(value);
                }
                if (parts.length === 1) {
                    const value = await renderStandaloneCbsText(parts[0], runtime, args);
                    return isStandaloneCbsTruthy(value);
                }

                const left = await renderStandaloneCbsText(parts[0], runtime, args);
                const op = safeTrim(parts[1]).toLowerCase();
                if (op === "and") return isStandaloneCbsTruthy(left) && (await evalTokens(parts.slice(2)));
                if (op === "or") return isStandaloneCbsTruthy(left) || (await evalTokens(parts.slice(2)));

                const right = await renderStandaloneCbsText(parts[2] || "", runtime, args);
                const leftNum = Number(left), rightNum = Number(right);
                const isNumeric = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
                switch (op) {
                    case "is":
                    case "vis":
                    case "tis":
                    case "==":
                    case "equal":
                        return left === right;
                    case "isnot":
                    case "visnot":
                    case "tisnot":
                    case "!=":
                    case "notequal":
                    case "not_equal":
                        return left !== right;
                    case ">":
                    case "greater":
                        return isNumeric ? leftNum > rightNum : left > right;
                    case ">=":
                    case "greaterequal":
                    case "greater_equal":
                        return isNumeric ? leftNum >= rightNum : left >= right;
                    case "<":
                    case "less":
                        return isNumeric ? leftNum < rightNum : left < right;
                    case "<=":
                    case "lessequal":
                    case "less_equal":
                        return isNumeric ? leftNum <= rightNum : left <= right;
                    default:
                        return isStandaloneCbsTruthy(await renderStandaloneCbsText(parts.join("::"), runtime, args));
                }
            }

            return {
                truthy: await evalTokens(tokens),
                mode
            };
        }

        async function getStandaloneCbsRuntime(context = {}) {
            let char = context?.char || context?.character || context?.targetChar || null;
            try { if (!char) char = await RisuCompat.getCharacter(); } catch (_) {}

            let chat = context?.chat || context?.targetChat || null;
            try { if (!chat && char) chat = await getActiveChatForCharacter(char); } catch (_) {}
            chat = chat || {};

            let db = context?.db || context?.database || null;
            if (!db) {
                try { db = await getLibraAllowedDatabase(['personas', 'selectedPersona', 'globalNote', 'username']); }
                catch (_) {
                    try { db = await RisuCompat.getDatabase(); }
                    catch (_) { db = {}; }
                }
            }
            db = db || {};
            return buildStandaloneCbsRuntime(context, char, chat, db);
        }

        // One synchronous builder owns the values consumed by the evaluator and
        // the local freshness proof. Proof construction performs no host calls.
        function buildStandaloneCbsRuntime(context = {}, char = null, chat = {}, db = {}) {
            const chatVariables = Object.create(null);
            const defaultVariables = Object.create(null);
            const templateDefaultVariables = Object.create(null);
            const globalVariables = Object.create(null);
            const toggleVariables = Object.create(null);
            collectStandaloneCbsVariables(templateDefaultVariables, db?.templateDefaultVariables || db?.templateVariables, true);
            collectStandaloneCbsVariables(defaultVariables, char?.defaultVariables || db?.defaultVariables, true);
            [
                db?.variables, db?.vars, db?.chatVariables,
                char?.variables, char?.vars, char?.scriptstate, char?.scriptState,
                chat?.variables, chat?.vars, chat?.chatVariables, chat?.localVariables,
                context?.vars, context?.variables, context?.scriptstate, context?.scriptState
            ].forEach(source => collectStandaloneCbsVariables(chatVariables, source, true));
            Object.assign(chatVariables, RisuCbsStandalone.readRisuChatVariables(chat));
            [db?.globalVariables, db?.globalVars, context?.globalVariables, context?.globalVars]
                .forEach(source => collectStandaloneCbsVariables(globalVariables, source, true));
            [db?.toggleVariables, db?.toggles, context?.toggleVariables, context?.toggles]
                .forEach(source => collectStandaloneCbsVariables(toggleVariables, source, true));

            const binding = SourceReflectionManager.resolvePersonaBinding(db, chat, char);
            const hasExplicitBinding = SourceReflectionManager.getPersonaBindingHint(chat, char).explicit;
            const persona = binding?.raw || null;
            const userName = safeTrim(
                (hasExplicitBinding ? binding?.name : (context?.userName || context?.username || db?.username))
                || persona?.name
                || "User"
            );
            const chatScopedNote = safeTrim(chat?.note || chat?.globalNote || db?.globalNote || "");
            const finalDb = { ...db, username: userName, globalNote: chatScopedNote };
            const bridgeSnapshot = context?.cbsBridgeState?.snapshot;
            // Bridge variables remain usable, but its character/persona text has no
            // fresh metadata proof. Current local fields/variables remain authoritative.
            const targetSnapshot = bridgeSnapshot ? { ...bridgeSnapshot, persona: undefined, character: undefined, chatVariables: undefined } : undefined;
            const runtime = RisuCbsStandalone.buildRisuCbsRuntime({
                snapshot: targetSnapshot,
                characterName: safeTrim(char?.name || char?.charName || char?.data?.name || 'Char'),
                userName,
                characterDescription: safeTrim(char?.desc || char?.description || char?.data?.description || ''),
                characterPersonality: safeTrim(char?.personality || char?.data?.personality || ''),
                scenario: safeTrim(chat?.scenario || char?.scenario || char?.data?.scenario || ''),
                personaDescription: safeTrim(binding?.prompt || (!hasExplicitBinding ? context?.personaDescription : '') || ''),
                authorNote: chatScopedNote,
                chatVariables,
                defaultVariables,
                templateDefaultVariables,
                globalVariables,
                toggleVariables
            });
            return {
                ...runtime,
                personaId: binding?.id || '',
                personaSource: binding?.source || '',
                char,
                chat,
                db: finalDb,
                vars: { ...templateDefaultVariables, ...defaultVariables, ...runtime.chatVariables },
                globalVars: runtime.globalVariables,
                functions: Object.create(null),
                cbsMode: String(context?.mode || context?.cbsMode || 'prompt').trim() || 'prompt',
                __libraCbsBridge: context?.cbsBridgeState || null
            };
        }

        function tokenizeStandaloneCbsCalc(src) {
            const tokens = [];
            let i = 0;
            while (i < src.length) {
                const ch = src[i];
                if (/\s/.test(ch)) { i++; continue; }
                if (ch === '"' || ch === "'") {
                    const quote = ch;
                    let value = '';
                    i++;
                    while (i < src.length) {
                        const c = src[i++];
                        if (c === quote) { tokens.push({ type: 'literal', value }); value = null; break; }
                        if (c === '\\') {
                            if (i >= src.length) throw new Error('Invalid escape');
                            const esc = src[i++];
                            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
                        } else {
                            value += c;
                        }
                    }
                    if (value !== null) throw new Error('Unterminated string');
                    continue;
                }
                if (/[0-9.]/.test(ch)) {
                    const start = i;
                    let dots = 0;
                    while (i < src.length && /[0-9.]/.test(src[i])) {
                        if (src[i] === '.') dots++;
                        if (dots > 1) throw new Error('Invalid number');
                        i++;
                    }
                    const raw = src.slice(start, i);
                    if (raw === '.' || raw === '') throw new Error('Invalid number');
                    const value = Number(raw);
                    if (!Number.isFinite(value)) throw new Error('Invalid number');
                    tokens.push({ type: 'literal', value });
                    continue;
                }
                if (/[A-Za-z_]/.test(ch)) {
                    const start = i;
                    while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
                    const word = src.slice(start, i).toLowerCase();
                    if (word === 'true') tokens.push({ type: 'literal', value: true });
                    else if (word === 'false') tokens.push({ type: 'literal', value: false });
                    else if (word === 'null') tokens.push({ type: 'literal', value: null });
                    else throw new Error('Unsupported identifier');
                    continue;
                }
                const three = src.slice(i, i + 3);
                if (three === '===' || three === '!==') { tokens.push({ type: 'op', value: three }); i += 3; continue; }
                const two = src.slice(i, i + 2);
                if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
                if ('+-*/%()!<>'.includes(ch)) { tokens.push({ type: ch === '(' || ch === ')' ? 'paren' : 'op', value: ch }); i++; continue; }
                throw new Error('Unsupported token');
            }
            return tokens;
        }

        function evaluateStandaloneCbsCalcTokens(tokens) {
            let pos = 0;
            const peek = () => tokens[pos];
            const consume = (value = null) => {
                const token = tokens[pos];
                if (!token || (value !== null && token.value !== value)) return null;
                pos++;
                return token;
            };
            const toNumber = (value) => {
                const n = Number(value);
                if (!Number.isFinite(n)) throw new Error('Expected finite number');
                return n;
            };
            const calcTruthy = (value) => {
                if (typeof value === 'boolean') return value;
                return isStandaloneCbsTruthy(value);
            };

            const parsePrimary = () => {
                const token = peek();
                if (!token) throw new Error('Unexpected end');
                if (token.type === 'literal') { pos++; return token.value; }
                if (consume('(')) {
                    const value = parseLogicalOr();
                    if (!consume(')')) throw new Error('Expected closing parenthesis');
                    return value;
                }
                throw new Error('Expected literal');
            };
            const parseUnary = () => {
                if (consume('!')) return !calcTruthy(parseUnary());
                if (consume('-')) return -toNumber(parseUnary());
                if (consume('+')) return toNumber(parseUnary());
                return parsePrimary();
            };
            const parseMultiplicative = () => {
                let left = parseUnary();
                while (peek() && ['*', '/', '%'].includes(peek().value)) {
                    const op = consume().value;
                    const right = parseUnary();
                    if (op === '*') left = toNumber(left) * toNumber(right);
                    else if (op === '/') left = toNumber(left) / toNumber(right);
                    else left = toNumber(left) % toNumber(right);
                    if (!Number.isFinite(left)) throw new Error('Non-finite result');
                }
                return left;
            };
            const parseAdditive = () => {
                let left = parseMultiplicative();
                while (peek() && ['+', '-'].includes(peek().value)) {
                    const op = consume().value;
                    const right = parseMultiplicative();
                    if (op === '+') {
                        left = (typeof left === 'string' || typeof right === 'string') ? String(left ?? '') + String(right ?? '') : toNumber(left) + toNumber(right);
                    } else {
                        left = toNumber(left) - toNumber(right);
                    }
                }
                return left;
            };
            const parseComparison = () => {
                let left = parseAdditive();
                while (peek() && ['>', '>=', '<', '<='].includes(peek().value)) {
                    const op = consume().value;
                    const right = parseAdditive();
                    const leftNum = Number(left), rightNum = Number(right);
                    const numeric = Number.isFinite(leftNum) && Number.isFinite(rightNum);
                    if (op === '>') left = numeric ? leftNum > rightNum : String(left) > String(right);
                    else if (op === '>=') left = numeric ? leftNum >= rightNum : String(left) >= String(right);
                    else if (op === '<') left = numeric ? leftNum < rightNum : String(left) < String(right);
                    else left = numeric ? leftNum <= rightNum : String(left) <= String(right);
                }
                return left;
            };
            const parseEquality = () => {
                let left = parseComparison();
                while (peek() && ['==', '!=', '===', '!=='].includes(peek().value)) {
                    const op = consume().value;
                    const right = parseComparison();
                    if (op === '===') left = left === right;
                    else if (op === '!==') left = left !== right;
                    else {
                        const leftNum = Number(left), rightNum = Number(right);
                        const numeric = Number.isFinite(leftNum) && Number.isFinite(rightNum);
                        const equal = numeric ? leftNum === rightNum : String(left) === String(right);
                        left = op === '==' ? equal : !equal;
                    }
                }
                return left;
            };
            const parseLogicalAnd = () => {
                let left = parseEquality();
                while (consume('&&')) left = calcTruthy(left) && calcTruthy(parseEquality());
                return left;
            };
            function parseLogicalOr() {
                let left = parseLogicalAnd();
                while (consume('||')) left = calcTruthy(left) || calcTruthy(parseLogicalAnd());
                return left;
            }

            const result = parseLogicalOr();
            if (pos !== tokens.length) throw new Error('Unexpected trailing token');
            return result;
        }

        function evalStandaloneCbsCalc(expression) {
            const src = String(expression || "").replace(/\s+/g, " ").trim();
            if (!src) return "";
            const looksConditional = /[<>=!&|]/.test(src);
            if (src.includes("{{") || src.includes("}}") || src.includes("[CBS_")) return looksConditional ? "0" : src;
            if (src.length > 512) return looksConditional ? "0" : src;
            try {
                const result = evaluateStandaloneCbsCalcTokens(tokenizeStandaloneCbsCalc(src));
                if (typeof result === "boolean") return result ? "1" : "0";
                if (typeof result === "number") return Number.isFinite(result) ? String(result) : (looksConditional ? "0" : src);
                return result == null ? "" : String(result);
            } catch { return looksConditional ? "0" : src; }
        }

        function isStandaloneCbsTruthy(value) {
            const src = safeTrim(String(value ?? ""));
            if (!src || src === "0" || src.toLowerCase() === "false" || src.toLowerCase() === "null") return false;
            return true;
        }

        async function evalStandaloneCbsExpr(inner, runtime, args = []) {
            try {
                let expr = safeTrim(inner); if (!expr) return "";
                if (expr.includes("{{")) { expr = safeTrim(await renderStandaloneCbsText(expr, runtime, args)); if (!expr) return ""; }
                if (expr === "char" || expr === "Char") return safeTrim(runtime?.char?.name || "Char");
                if (expr === "user" || expr === "User") return runtime?.userName || "User";
                const parts = splitTopLevelCbsByDoubleColon(expr).map((s) => String(s ?? ""));
                const head = safeTrim(parts[0] || "");
                if (head === "arg") { const index = Math.max(0, (parseInt(safeTrim(parts[1] || "1"), 10) || 1) - 1); return args[index] ?? "null"; }
                if (head === "getvar") { const keyRaw = parts.slice(1).join("::"); const key = safeTrim(await renderStandaloneCbsText(keyRaw, runtime, args)); if (!key) return "null"; if (Object.prototype.hasOwnProperty.call(runtime.vars, key)) return runtime.vars[key]; if (Object.prototype.hasOwnProperty.call(runtime.globalVars, key)) return runtime.globalVars[key]; return "null"; }
                if (head === "calc") { const expression = await renderStandaloneCbsText(parts.slice(1).join("::"), runtime, args); return evalStandaloneCbsCalc(expression); }
                if (head === "call") { runtime._callDepth = (runtime._callDepth || 0) + 1; if (runtime._callDepth > 20) { runtime._callDepth--; return "[ERROR:max recursion]"; } try { const fnName = safeTrim(await renderStandaloneCbsText(parts[1] || "", runtime, args)); const fnBody = runtime.functions[fnName]; if (!fnBody) return ""; const callArgs = []; for (let i = 2; i < parts.length; i += 1) callArgs.push(await renderStandaloneCbsText(parts[i], runtime, args)); return await renderStandaloneCbsText(fnBody, runtime, callArgs); } finally { runtime._callDepth--; } }
                if (head === "none") return "";
                if (head === "char_desc") return safeTrim(runtime?.char?.desc || runtime?.char?.description || "");
                if (head === "ujb") return safeTrim(runtime?.db?.globalNote || "");
                if (head === "system_note") return safeTrim(runtime?.db?.globalNote || "");
                if (head === "random") { const choices = parts.slice(1); if (choices.length === 0) return ""; const randIdx = Math.floor(Math.random() * choices.length); return await renderStandaloneCbsText(choices[randIdx], runtime, args); }
                if (head === "token_count") { const text = await renderStandaloneCbsText(parts.slice(1).join("::"), runtime, args); return String(TokenizerEngine.estimateTokens(text, 'simple')); }
                if (["equal", "not_equal", "greater", "greater_equal", "less", "less_equal"].includes(head)) {
                    const v1 = await renderStandaloneCbsText(parts[1] || "", runtime, args), v2 = await renderStandaloneCbsText(parts[2] || "", runtime, args);
                    const n1 = Number(v1), n2 = Number(v2), isNum = !isNaN(n1) && !isNaN(n2);
                    switch(head) {
                        case "equal": return v1 === v2 ? "1" : "0"; case "not_equal": return v1 !== v2 ? "1" : "0";
                        case "greater": return (isNum ? n1 > n2 : v1 > v2) ? "1" : "0"; case "greater_equal": return (isNum ? n1 >= n2 : v1 >= v2) ? "1" : "0";
                        case "less": return (isNum ? n1 < n2 : v1 < v2) ? "1" : "0"; case "less_equal": return (isNum ? n1 <= n2 : v1 <= v2) ? "1" : "0";
                    }
                }
                if (Object.prototype.hasOwnProperty.call(runtime.vars, expr)) return runtime.vars[expr];
                if (Object.prototype.hasOwnProperty.call(runtime.globalVars, expr)) return runtime.globalVars[expr];
                return expr;
            } catch (e) {
                recordRuntimeDebug('warn', "[LIBRA] CBS Expr Eval Error:", e?.message);
                return "";
            }
        }

        async function evalBracketCbsExpr(inner, runtime, args = []) {
            const parts = splitTopLevelCbsByDoubleColon(inner).map((s) => safeTrim(s));
            const head = parts[0] || "";

            if (!head) return "";
            if (head.toLowerCase() === "annotation") {
                return await renderStandaloneCbsText(parts[1] || "", runtime, args);
            }

            // Fallback: treat payload like a normal CBS expression so unsupported
            // forms degrade into a usable string instead of leaking raw tokens.
            return await evalStandaloneCbsExpr(inner, runtime, args);
        }

        async function renderStandaloneCbsText(text, runtime, args = []) {
            const src = String(text ?? "");
            if (!src || (!src.includes("{{") && !src.includes("[CBS_EXPR:"))) return src;
            let out = "", cursor = 0;
            while (cursor < src.length) {
                const tag = findNextAnyCbsToken(src, cursor);
                if (!tag) { out += src.slice(cursor); break; }
                out += src.slice(cursor, tag.start);
                const inner = safeTrim(tag.inner);
                if (tag.raw.startsWith("[CBS_EXPR:")) {
                    out += await evalBracketCbsExpr(inner, runtime, args);
                    cursor = tag.end;
                    continue;
                }
                if (inner.startsWith("#func ")) { const fnName = safeTrim(inner.slice(6)); const block = extractCbsBlock(src, tag, "func"); if (fnName) runtime.functions[fnName] = block.body; cursor = block.end; continue; }
                if (inner.startsWith("#if_pure ")) { const conditionRaw = inner.slice(9); const block = extractCbsBlock(src, tag, "if_pure"); const condition = await evalStandaloneCbsExpr(conditionRaw, runtime, args); out += await renderStandaloneCbsText(isStandaloneCbsTruthy(condition) ? block.body : block.elseBody, runtime, args); cursor = block.end; continue; }
                if (inner.startsWith("#if ")) { const conditionRaw = inner.slice(4); const block = extractCbsBlock(src, tag, "if"); const condition = await evalStandaloneCbsExpr(conditionRaw, runtime, args); out += await renderStandaloneCbsText(isStandaloneCbsTruthy(condition) ? block.body : block.elseBody, runtime, args); cursor = block.end; continue; }
                if (inner.startsWith("#unless ")) { const conditionRaw = inner.slice(8); const block = extractCbsBlock(src, tag, "unless"); const condition = await evalStandaloneCbsExpr(conditionRaw, runtime, args); out += await renderStandaloneCbsText(isStandaloneCbsTruthy(condition) ? block.elseBody : block.body, runtime, args); cursor = block.end; continue; }
                if (inner.startsWith("#when ")) {
                    const block = extractCbsBlock(src, tag, "when");
                    const result = await evalStandaloneWhenCondition(inner.slice(6), runtime, args);
                    const selected = result.truthy ? block.body : block.elseBody;
                    const body = result.mode === "legacy" ? trimLegacyCbsBlockBody(selected) : selected;
                    out += await renderStandaloneCbsText(body, runtime, args);
                    cursor = block.end;
                    continue;
                }
                if (inner.startsWith("#when::")) {
                    const block = extractCbsBlock(src, tag, "when");
                    const result = await evalStandaloneWhenCondition(inner.slice(6), runtime, args);
                    const selected = result.truthy ? block.body : block.elseBody;
                    const body = result.mode === "legacy" ? trimLegacyCbsBlockBody(selected) : selected;
                    out += await renderStandaloneCbsText(body, runtime, args);
                    cursor = block.end;
                    continue;
                }
                if (inner === "else" || inner === ":else" || inner === "/if" || inner === "/unless" || inner === "/func" || inner === "/if_pure" || inner === "/when" || inner === "/") { cursor = tag.end; continue; }
                out += await evalStandaloneCbsExpr(inner, runtime, args); cursor = tag.end;
            }
            return out;
        }

        function collectCharacterLoreCbsSources(value, out = [], depth = 0) {
            if (depth > 8 || out.length >= 512) return out;
            if (typeof value === 'string') {
                if (hasStandaloneCbsSyntax(value)) out.push(value);
                return out;
            }
            if (Array.isArray(value)) {
                value.forEach(item => collectCharacterLoreCbsSources(item, out, depth + 1));
                return out;
            }
            if (value && typeof value === 'object') {
                Object.values(value).forEach(item => collectCharacterLoreCbsSources(item, out, depth + 1));
            }
            return out;
        }

        async function prepareStandaloneCbsBridge(sources = [], context = {}) {
            const candidates = RisuCbsStandalone.collectRisuCbsCandidates(Array.isArray(sources) ? sources : [String(sources || '')]);
            const needsSnapshot = candidates.globalVariableKeys.length > 0 || candidates.toggleKeys.length > 0;
            const base = { candidates, needsSnapshot, status: 'not_required', manifest: null,
                snapshot: undefined, snapshotProvenance: 'not_required', manifestWritten: false, validation: { ok: true } };
            if (!needsSnapshot) return base;
            const char = context.char || context.character || context.targetChar || await RisuCompat.getCharacter();
            const chat = context.chat || context.targetChat || (char && await getActiveChatForCharacter(char));
            const bound = { ...context, char, chat };
            const sourceSignature = getCharacterLoreSourceSignature(bound);
            const generation = MemoryState.initVersion;
            const characterId = String(char?.id || char?.chaId || '');
            const characterIndex = Number(context.characterIndex ?? context.charIndex ?? await RisuCompat.getCurrentCharacterIndex());
            const chatIndex = Number(context.chatIndex ?? await RisuCompat.getCurrentChatIndex());
            const manifest = RisuCbsStandalone.createRisuCbsCandidateManifest({ createdAt: Date.now(), characterIndex, chatIndex, candidates });
            if (!characterId || !chat?.id || !Number.isInteger(characterIndex) || characterIndex < 0
                || !Number.isInteger(chatIndex) || chatIndex < 0 || !RisuCompat.has('getChatFromIndex')) {
                return { ...base, manifest, status: 'native_unproven_target', snapshotProvenance: 'unavailable', validation: { ok: false, reason: 'unproven_target' } };
            }
            const initialDb = context.db || await getLibraAllowedDatabase(['personas', 'selectedPersona', 'globalNote', 'username']);
            const personaProof = JSON.stringify(SourceReflectionManager.resolvePersonaBinding(initialDb, chat, char));
            // The indexed chat response carries the target chat ID. Only an existing
            // matching companion snapshot from this proven target may be consumed.
            const assertCurrent = async () => {
                if (context.cbsReadLease?.cancelled || generation !== MemoryState.initVersion
                    || MemoryEngine.CONFIG?.cbsEnabled === false
                    || sourceSignature !== getCharacterLoreSourceSignature(bound)) throw new Error('CBS stale read');
                const ci = Number(await RisuCompat.getCurrentCharacterIndex());
                const ti = Number(await RisuCompat.getCurrentChatIndex());
                const currentChar = await RisuCompat.getCharacter();
                const currentChat = await RisuCompat.getChatFromIndex(ci, ti);
                const currentDb = await getLibraAllowedDatabase(['personas', 'selectedPersona', 'globalNote', 'username']);
                const currentBinding = SourceReflectionManager.resolvePersonaBinding(currentDb, currentChat, currentChar);
                if (ci !== characterIndex || ti !== chatIndex || !characterId || !chat?.id
                    || String(currentChar?.id || currentChar?.chaId || '') !== characterId || currentChat?.id !== chat.id
                    || personaProof !== JSON.stringify(currentBinding)
                    || sourceSignature !== getCharacterLoreSourceSignature({ ...bound, char: currentChar, chat: currentChat })
                    || sourceSignature !== getCharacterLoreSourceSignature(bound)
                    || context.cbsReadLease?.cancelled || generation !== MemoryState.initVersion) throw new Error('CBS stale read');
                return currentChat;
            };
            const currentChat = await assertCurrent();
            const state = RisuCbsStandalone.readRisuCbsBridgeState(currentChat);
            let validation = RisuCbsStandalone.validateRisuCbsBridgeSnapshot(state.snapshot,
                { characterIndex, chatIndex, manifestFingerprint: manifest.fingerprint });
            // A fingerprint is only a label. Compare actual hidden key sets too,
            // so a hash collision or ambiguous snapshot cannot expand the reads.
            if (validation.ok && (
                JSON.stringify(Object.keys(state.snapshot.globalVariables || {}).sort()) !== JSON.stringify([...candidates.globalVariableKeys].sort())
                || JSON.stringify(Object.keys(state.snapshot.toggleVariables || {}).sort()) !== JSON.stringify([...candidates.toggleKeys].sort())
            )) validation = { ok: false, reason: 'key_set_mismatch' };
            // Verified parseRisuChat has no indexed target, revision, or target
            // receipt. Even before/after guards cannot rule out A->B->A and a
            // foreign active-chat override. Do not call it or invent another API.
            return { ...base, manifest, validation,
                snapshotProvenance: validation.ok ? 'previously_captured_reference' : 'unavailable',
                status: RisuCompat.has('parseRisuChat') ? 'native_unscoped_unsupported' : 'native_unavailable',
                snapshot: validation.ok ? state.snapshot : undefined };

        }

        function normalizeLegacyBracketCbs(text = '') {
            return String(text || '').replace(/\[CBS_EXPR:([^\]]*)\]/g, (_match, inner) => {
                const parts = splitTopLevelCbsByDoubleColon(String(inner || ''));
                if (safeTrim(parts[0] || '').toLowerCase() === 'annotation') return parts.slice(1).join('::');
                return `{{${inner}}}`;
            });
        }

        async function evaluateWithRuntime(text, runtimeOrContext = null, options = {}) {
            const src = String(text ?? '');
            if (!MemoryEngine.CONFIG.cbsEnabled || !src || !hasStandaloneCbsSyntax(src)) return { text: src, diagnostics: [], bridge: null };
            const looksLikeRuntime = runtimeOrContext
                && typeof runtimeOrContext === 'object'
                && runtimeOrContext.chatVariables
                && runtimeOrContext.globalVariables
                && runtimeOrContext.toggleVariables;
            const runtime = looksLikeRuntime
                ? runtimeOrContext
                : await getStandaloneCbsRuntime({ ...(runtimeOrContext || {}), mode: options?.mode || runtimeOrContext?.mode || 'prompt' });
            const result = RisuCbsStandalone.evaluateRisuCbs(normalizeLegacyBracketCbs(src), runtime);
            try { runtime.__libraCbsDiagnostics = result.diagnostics.slice(); } catch (_) {}
            if (MemoryEngine.CONFIG?.debug && result.diagnostics.length > 0) {
                recordRuntimeDebug('warn', '[LIBRA][CBS] evaluation diagnostics', {
                    diagnostics: result.diagnostics.slice(0, 20),
                    bridge: runtime.__libraCbsBridge?.status || 'none'
                });
            }
            return { ...result, bridge: runtime.__libraCbsBridge || null };
        }

        async function processWithRuntime(text, runtimeOrContext = null, options = {}) {
            const src = String(text ?? "");
            if (!MemoryEngine.CONFIG.cbsEnabled) return src;
            if (!src || !hasStandaloneCbsSyntax(src)) return src;
            try {
                const result = await evaluateWithRuntime(src, runtimeOrContext, options);
                return result.text;
            } catch (e) {
                recordRuntimeDebug('error', "[LIBRA] CBS Process Error", e);
                return src;
            }
        }

        function getRawCharacterLorebookForCbs(context = {}) {
            const char = context?.char || context?.character || context?.targetChar || null;
            const candidates = [
                context?.characterLorebook,
                context?.rawCharacterLorebook,
                context?.characterLore,
                context?.lorebookEntries,
                char?.lorebook,
                char?.lore,
                char?.characterLore,
                char?.rawCharacterLore,
                char?.globalLore,
                char?.data?.lorebook,
                char?.data?.lore,
                char?.data?.characterLore,
                char?.data?.globalLore
            ];
            for (const candidate of candidates) {
                if (Array.isArray(candidate) && candidate.length) return candidate;
                if (candidate && typeof candidate === 'object') {
                    if (Array.isArray(candidate.entries) && candidate.entries.length) return candidate.entries;
                    if (Array.isArray(candidate.lorebook) && candidate.lorebook.length) return candidate.lorebook;
                    if (Array.isArray(candidate.lore) && candidate.lore.length) return candidate.lore;
                    if (Array.isArray(candidate.globalLore) && candidate.globalLore.length) return candidate.globalLore;
                }
            }
            return [];
        }

        function unpackCharacterLoreForCbs(raw = []) {
            try {
                if (Array.isArray(raw)) {
                    return (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack)
                        ? LibraLoreConsolidator.unpack(raw)
                        : raw.slice();
                }
                if (raw && typeof raw === 'object') {
                    if (Array.isArray(raw.entries)) return unpackCharacterLoreForCbs(raw.entries);
                    if (Array.isArray(raw.lorebook)) return unpackCharacterLoreForCbs(raw.lorebook);
                    if (Array.isArray(raw.lore)) return unpackCharacterLoreForCbs(raw.lore);
                    if (Array.isArray(raw.globalLore)) return unpackCharacterLoreForCbs(raw.globalLore);
                }
            } catch (error) {
                recordSuppressedRuntimeError('cbs.unpack_character_lore', error, { stage: 'character-lore-cbs-preresolve' });
            }
            return [];
        }

        function makeCharacterLoreCbsSignature(entries = [], runtimeSignature = '') {
            try {
                const compact = (Array.isArray(entries) ? entries : []).map(entry => ({
                    key: String(entry?.key || '').slice(0, 240),
                    secondkey: String(entry?.secondkey || '').slice(0, 240),
                    comment: String(entry?.comment || '').slice(0, 240),
                    content: String(entry?.content || '').slice(0, 1200)
                }));
                return String(TokenizerEngine.simpleHash(JSON.stringify({ runtimeSignature, compact })));
            } catch (_) {
                return '';
            }
        }

        function characterLoreNeedsDatabaseProof(entries = []) {
            // Only these direct fields are independent of database/persona/default
            // variable input. Unknown or nested syntax is conservative, not guessed.
            return collectCharacterLoreCbsSources(entries).some(text => hasStandaloneCbsSyntax(String(text)
                .replace(/\{\{\s*(?:char|bot|charname|description|personality|scenario)\s*\}\}/gi, '')
                .replace(/\[CBS_EXPR:\s*(?:char|bot|charname|description|personality|scenario)\s*\]/gi, '')));
        }

        function isCharacterLoreSnapshotReusable(context = {}) {
            const entries = unpackCharacterLoreForCbs(getRawCharacterLorebookForCbs(context))
                .filter(entry => entry && typeof entry === 'object' && !String(entry.comment || '').startsWith('lmai_'));
            return !characterLoreNeedsDatabaseProof(entries) || !!(context.db || context.database);
        }

        function getCharacterLoreSourceSignature(context = {}) {
            const char = context?.char || context?.character || context?.targetChar || null;
            const chat = context?.chat || context?.targetChat || {};
            const entries = unpackCharacterLoreForCbs(getRawCharacterLorebookForCbs(context))
                .filter(entry => entry && typeof entry === 'object' && !String(entry.comment || '').startsWith('lmai_'));
            const needsDatabase = characterLoreNeedsDatabaseProof(entries);
            const db = context.db || context.database || {};
            const runtime = buildStandaloneCbsRuntime({ ...context, cbsBridgeState: null }, char, chat, db);
            const renderedInputs = {
                characterName: runtime.characterName,
                characterDescription: runtime.characterDescription,
                characterPersonality: runtime.characterPersonality,
                scenario: runtime.scenario,
                ...(needsDatabase ? {
                    databaseProof: context.db || context.database ? 'provided' : 'unavailable',
                    userName: runtime.userName,
                    personaDescription: runtime.personaDescription,
                    authorNote: runtime.authorNote,
                    chatVariables: runtime.chatVariables,
                    defaultVariables: runtime.defaultVariables,
                    templateDefaultVariables: runtime.templateDefaultVariables,
                    globalVariables: runtime.globalVariables,
                    toggleVariables: runtime.toggleVariables
                } : {})
            };
            // Runtime-only exact serialized proof: no truncated values and no
            // non-cryptographic hash collision is accepted as source equality.
            return JSON.stringify([getCbsResolvedCharacterLoreScopeKey(context), MemoryState.initVersion,
                String(char?.id || char?.chaId || ''), String(chat.id || ''),
                SourceReflectionManager.getPersonaBindingHint(chat, char), entries, renderedInputs]);
        }

        async function resolveCharacterLoreValue(value, runtime, stats) {
            if (typeof value === 'string') {
                if (!hasStandaloneCbsSyntax(value)) return value;
                stats.macroCount += 1;
                return await processWithRuntime(value, runtime, { mode: 'prompt' });
            }
            if (Array.isArray(value)) {
                const out = [];
                for (const item of value) out.push(await resolveCharacterLoreValue(item, runtime, stats));
                return out;
            }
            if (value && typeof value === 'object') {
                const cloned = cloneStandaloneLoreEntry(value);
                for (const key of Object.keys(cloned)) {
                    if (hasStandaloneCbsSyntax(cloned[key])) cloned[key] = await resolveCharacterLoreValue(cloned[key], runtime, stats);
                }
                return cloned;
            }
            return value;
        }

        async function resolveCharacterLoreEntries(context = {}) {
            const rawEntries = safeClone(unpackCharacterLoreForCbs(getRawCharacterLorebookForCbs(context))
                .filter(entry => entry && typeof entry === 'object' && !String(entry.comment || '').startsWith('lmai_')));
            const sourceSignature = getCharacterLoreSourceSignature(context);
            const cbsSources = collectCharacterLoreCbsSources(rawEntries);
            const cbsBridgeState = await prepareStandaloneCbsBridge(cbsSources, context);
            const runtime = await getStandaloneCbsRuntime({ ...context, cbsBridgeState });
            const runtimeSignature = makeStandaloneCbsRuntimeSignature(runtime);
            const beforeSignature = makeCharacterLoreCbsSignature(rawEntries, runtimeSignature);
            const stats = { macroCount: 0 };
            const entries = [];
            for (const entry of rawEntries) {
                const next = cloneStandaloneLoreEntry(entry);
                for (const field of CBS_TEXT_FIELDS) {
                    if (Object.prototype.hasOwnProperty.call(next, field)) next[field] = await resolveCharacterLoreValue(next[field], runtime, stats);
                }
                for (const field of CBS_KEY_FIELDS) {
                    if (Object.prototype.hasOwnProperty.call(next, field)) next[field] = await resolveCharacterLoreValue(next[field], runtime, stats);
                }
                try {
                    Object.defineProperty(next, '__libraCbsPreResolved', {
                        value: true,
                        enumerable: false,
                        configurable: true
                    });
                } catch (_) {}
                entries.push(next);
            }
            if (context.cbsReadLease?.cancelled || sourceSignature !== getCharacterLoreSourceSignature(context)) throw new Error('CBS stale resolution');
            const afterSignature = makeCharacterLoreCbsSignature(entries, runtimeSignature);
            return {
                entries,
                rawEntryCount: rawEntries.length,
                resolvedEntryCount: entries.length,
                macroCount: stats.macroCount,
                changed: beforeSignature !== afterSignature,
                signature: afterSignature,
                runtimeSignature,
                sourceSignature,
                supportedTags: ['{{...}}', '[CBS_EXPR:...]', '#if', '#when', '#each'],
                unsupportedTags: cbsBridgeState?.candidates?.dynamicKeys || [],
                hiddenKeys: [
                    ...(cbsBridgeState?.candidates?.globalVariableKeys || []),
                    ...(cbsBridgeState?.candidates?.toggleKeys || [])
                ],
                bridge: {
                    status: cbsBridgeState?.status || 'not_required',
                    snapshotProvenance: cbsBridgeState?.snapshotProvenance || 'unavailable',
                    manifestFingerprint: cbsBridgeState?.manifest?.fingerprint || '',
                    manifestWritten: cbsBridgeState?.manifestWritten === true,
                    validation: cbsBridgeState?.validation || null,
                    candidateCounts: {
                        chat: cbsBridgeState?.candidates?.chatVariableKeys?.length || 0,
                        global: cbsBridgeState?.candidates?.globalVariableKeys?.length || 0,
                        toggle: cbsBridgeState?.candidates?.toggleKeys?.length || 0,
                        dynamic: cbsBridgeState?.candidates?.dynamicKeys?.length || 0
                    }
                }
            };
        }

        async function preResolveCharacterLore(context = {}) {
            const result = await resolveCharacterLoreEntries(context);
            const snapshot = setCbsResolvedCharacterLoreSnapshot(context, result);
            return {
                ...result,
                scopeKey: snapshot?.scopeKey || getCbsResolvedCharacterLoreScopeKey(context),
                entries: cloneCbsResolvedLoreEntries(result.entries)
            };
        }

        return {
            process: async (text) => processWithRuntime(text, {}, { mode: 'prompt' }),
            processWithRuntime,
            evaluate: evaluateWithRuntime,
            hasSyntax: hasStandaloneCbsSyntax,
            createRuntime: getStandaloneCbsRuntime,
            collectCandidates: (texts = []) => RisuCbsStandalone.collectRisuCbsCandidates(Array.isArray(texts) ? texts : [String(texts || '')]),
            prepareBridge: prepareStandaloneCbsBridge,
            bridgeKeys: Object.freeze({
                manifest: RisuCbsStandalone.RISU_CBS_CANDIDATES_KEY,
                snapshot: RisuCbsStandalone.RISU_CBS_SNAPSHOT_KEY
            }),
            resolveCharacterLoreEntries,
            getCharacterLoreSourceSignature,
            isCharacterLoreSnapshotReusable,
            preResolveCharacterLore,
            clean: (text) => typeof text === 'string'
                ? text.replace(/\{\{[^}]*\}\}/g, '').replace(/\[CBS_EXPR:[^\]]*\]/g, '').trim()
                : ""
        };
    })();

    const CharacterLoreCbsPreResolver = (() => {
        const activeReadLeases = new Map();
        const resolve = async (context = {}) => {
            const scopeKey = getCbsResolvedCharacterLoreScopeKey(context);
            const previousLease = activeReadLeases.get(scopeKey);
            if (previousLease) previousLease.cancelled = true;
            const lease = context.cbsReadLease || { cancelled: false };
            context = { ...context, cbsReadLease: lease };
            activeReadLeases.set(scopeKey, lease);
            if (MemoryEngine.CONFIG?.cbsEnabled === false || !CBSEngine?.preResolveCharacterLore) {
                clearCbsResolvedCharacterLoreSnapshot(context);
                activeReadLeases.delete(scopeKey);
                return {
                    entries: null,
                    skipped: 'cbs-disabled',
                    scopeKey: getCbsResolvedCharacterLoreScopeKey(context)
                };
            }
            try {
                const result = await CBSEngine.preResolveCharacterLore(context);
                if (context.cbsReadLease?.cancelled || result?.sourceSignature !== CBSEngine.getCharacterLoreSourceSignature(context)) throw new Error('CBS stale publication');
                const entries = Array.isArray(result?.entries) ? result.entries : [];
                const snapshot = setCbsResolvedCharacterLoreSnapshot(context, {
                    ...result,
                    entries,
                    resolvedEntryCount: entries.length
                });
                return {
                    ...result,
                    entries: cloneCbsResolvedLoreEntries(entries),
                    scopeKey: snapshot?.scopeKey || result?.scopeKey || getCbsResolvedCharacterLoreScopeKey(context)
                };
            } catch (error) {
                recordSuppressedRuntimeError('cbs.character_lore_preresolve', error, {
                    scopeKey: getCbsResolvedCharacterLoreScopeKey(context)
                });
                // A superseded failure must not erase a newer successful snapshot.
                return {
                    entries: null,
                    skipped: 'resolve-error',
                    reason: error?.message || String(error || 'unknown'),
                    scopeKey: getCbsResolvedCharacterLoreScopeKey(context)
                };
            } finally {
                if (activeReadLeases.get(scopeKey) === lease) activeReadLeases.delete(scopeKey);
            }
        };
        const peek = (context = {}) => getCbsResolvedCharacterLoreSnapshot(context);
        const getEntries = (context = {}) => getCbsResolvedCharacterLoreEntries(context);
        const clear = (context = {}) => clearCbsResolvedCharacterLoreSnapshot(context);
        return Object.freeze({ resolve, peek, getEntries, clear });
    })();

    try {
        globalThis.LIBRA_CBS_PRE_RESOLVE_CHARACTER_LORE = async (context = {}) => CharacterLoreCbsPreResolver.resolve(context);
        globalThis.LIBRA_CBS_GET_RESOLVED_CHARACTER_LORE = (context = {}) => CharacterLoreCbsPreResolver.peek(context);
    } catch (_) {}
