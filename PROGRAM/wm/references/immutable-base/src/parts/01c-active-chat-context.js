    const normalizeRisuIndex = (value) => {
        const n = Number(value);
        return Number.isInteger(n) && n >= 0 ? n : -1;
    };
    const admitChatContext = async (context, options = {}) => {
        if (!context?.char || !context?.chat || typeof LibraDataStorage === 'undefined' || !LibraDataStorage.preparePersonaContext) return context;
        const personaAdmission = await LibraDataStorage.preparePersonaContext(context.char, context.chat, options);
        if (personaAdmission.ok && options.expectedCanonicalScope && options.expectedCanonicalScope !== personaAdmission.scopeKey) {
            return { ...context, ok: false, chat: null, reason: 'target_not_active', personaAdmission: { ...personaAdmission, ok: false, reason: 'target_not_active' } };
        }
        if (personaAdmission.ok && options.expectedGeneration !== undefined && options.expectedGeneration !== personaAdmission.resetGeneration) {
            return { ...context, ok: false, chat: null, reason: 'reset_generation_changed', personaAdmission: { ...personaAdmission, ok: false, reason: 'reset_generation_changed' } };
        }
        const result = { ...context, ok: personaAdmission.ok, personaAdmission,
            scopeKey: personaAdmission.ok ? personaAdmission.runtimeScopeKey : '',
            reason: personaAdmission.ok ? '' : personaAdmission.reason };
        return !personaAdmission.ok && !options.includeReadOnly ? { ...result, blockedChat: result.chat, chat: null } : result;
    };
    const resolveActiveChatContext = async (preferredChat = null, options = {}) => {
        try {
            let char = null;
            try { char = await RisuCompat.getCharacter(); } catch (_) {}
            const rawCharIdx = await RisuCompat.getCurrentCharacterIndex();
            let charIdx = normalizeRisuIndex(rawCharIdx);
            let chatIndex = normalizeRisuIndex(await RisuCompat.getCurrentChatIndex());
            if (chatIndex < 0) chatIndex = normalizeRisuIndex(char?.chatPage);

            if (!char && charIdx >= 0 && RisuCompat.has('getCharacterFromIndex')) {
                try { char = await RisuCompat.getCharacterFromIndex(charIdx); } catch (_) {}
            }
            if (!char) return { char: null, charIdx: -1, rawCharIdx, chat: null, chatIndex: -1, scopeKey: '' };

            const chats = Array.isArray(char?.chats) ? char.chats : [];
            if (preferredChat?.id) {
                const resolved = chats.findIndex(entry => String(entry?.id || '') === String(preferredChat.id));
                if (resolved >= 0) chatIndex = resolved;
                else return { char, charIdx, rawCharIdx, chat: null, chatIndex: -1, scopeKey: '', reason: 'preferred_chat_not_found' };
            }

            let chat = null;
            if (charIdx >= 0 && chatIndex >= 0 && RisuCompat.has('getChatFromIndex')) {
                try { chat = await RisuCompat.getChatFromIndex(charIdx, chatIndex); } catch (_) {}
            }
            if (!chat && chatIndex >= 0) chat = chats?.[chatIndex] || null;
            if (!chat && typeof char?.chatPage !== 'undefined') {
                const fallbackIndex = normalizeRisuIndex(char.chatPage);
                if (fallbackIndex >= 0) {
                    chatIndex = fallbackIndex;
                    chat = chats?.[fallbackIndex] || null;
                }
            }
            const scopeKey = chat ? getChatRuntimeScopeKey(chat, char) : '';
            const preferredProof = typeof PersonaScopeIdentity === 'undefined' ? null : PersonaScopeIdentity.chatProof(preferredChat);
            return await admitChatContext({ char, charIdx, rawCharIdx, chat, chatIndex, scopeKey }, {
                ...options, ...(preferredProof ? { expectedGeneration: preferredProof.resetGeneration,
                    expectedCanonicalScope: LibraDataStorage.scopeKeyFor({ id: preferredProof.characterId }, { id: preferredProof.chatId, bindedPersona: preferredProof.personaId }) } : {})
            });
        } catch {
            return { char: null, charIdx: -1, rawCharIdx: -1, chat: null, chatIndex: -1, scopeKey: '' };
        }
    };
    const resolveChatContextByTarget = async (target = null, options = {}) => {
        const requested = target && typeof target === 'object' ? target : {};
        const expectedCharacterId = String(requested.characterId || requested.charId || '').trim();
        const expectedChatId = String(requested.chatId || requested.id || '').trim();
        let charIdx = normalizeRisuIndex(requested.characterIndex ?? requested.charIndex);
        let chatIndex = normalizeRisuIndex(requested.chatIndex);
        const hasExplicitTarget = !!(expectedCharacterId || expectedChatId || charIdx >= 0 || chatIndex >= 0);

        // A detached worker must never reinterpret an explicit target as the
        // currently visible chat.  The user can switch chats while the worker
        // is awaiting an LLM, so both stable IDs are verified after every host
        // lookup.
        let char = null;
        if (charIdx >= 0 && RisuCompat.has('getCharacterFromIndex')) {
            try { char = await RisuCompat.getCharacterFromIndex(charIdx); } catch (_) {}
        } else if (!hasExplicitTarget || options.allowActiveFallback === true) {
            try {
                char = await RisuCompat.getCharacter();
                charIdx = normalizeRisuIndex(await RisuCompat.getCurrentCharacterIndex());
            } catch (_) {}
        }
        if (!char) return { ok: false, reason: 'target_character_unavailable', char: null, chat: null, charIdx, chatIndex, scopeKey: '' };
        const actualCharacterId = String(char?.id || char?.chaId || '').trim();
        if (expectedCharacterId && actualCharacterId !== expectedCharacterId) {
            return { ok: false, reason: 'target_character_mismatch', char: null, chat: null, charIdx, chatIndex, scopeKey: '' };
        }

        const chats = Array.isArray(char?.chats) ? char.chats : [];
        if (expectedChatId) {
            const byId = chats.findIndex(entry => String(entry?.id || '').trim() === expectedChatId);
            if (byId < 0) return { ok: false, reason: 'target_chat_not_found', char, chat: null, charIdx, chatIndex: -1, scopeKey: '' };
            chatIndex = byId;
        }
        let chat = null;
        if (charIdx >= 0 && chatIndex >= 0 && RisuCompat.has('getChatFromIndex')) {
            try { chat = await RisuCompat.getChatFromIndex(charIdx, chatIndex); } catch (_) {}
        }
        if (!chat && chatIndex >= 0) chat = chats[chatIndex] || null;
        if (!chat) return { ok: false, reason: 'target_chat_unavailable', char, chat: null, charIdx, chatIndex, scopeKey: '' };
        if (expectedChatId && String(chat?.id || '').trim() !== expectedChatId) {
            return { ok: false, reason: 'target_chat_mismatch', char, chat: null, charIdx, chatIndex, scopeKey: '' };
        }
        return await admitChatContext({
            ok: true,
            char,
            chat,
            charIdx,
            chatIndex,
            scopeKey: getChatRuntimeScopeKey(chat, char)
        }, { ...options, expectedGeneration: requested.resetGeneration, expectedCanonicalScope: requested.canonicalScope });
    };
    const getActiveChatForCharacter = async (char, preferredChat = null, options = {}) => {
        // getCharacter() already returns the current character snapshot. Prefer its chat
        // collection so a single request does not immediately fetch and clone the same
        // character/chat payload again. Persistence paths still re-read before commit.
        const chats = Array.isArray(char?.chats) ? char.chats : [];
        if (chats.length > 0) {
            let chatIndex = -1;
            const preferredId = String(preferredChat?.id || '').trim();
            if (preferredId) {
                chatIndex = chats.findIndex(entry => String(entry?.id || '').trim() === preferredId);
            }
            if (chatIndex < 0) {
                try { chatIndex = normalizeRisuIndex(await RisuCompat.getCurrentChatIndex()); } catch (_) {}
            }
            if (chatIndex < 0) chatIndex = normalizeRisuIndex(char?.chatPage);
            if (chatIndex >= 0 && chats[chatIndex]) return (await admitChatContext({ char, chat: chats[chatIndex] }, options))?.chat || null;
        }
        const ctx = await resolveActiveChatContext(preferredChat, options);
        return ctx?.chat || null;
    };
    const LIBRA_DB_READ_KEYS = Object.freeze(['personas', 'selectedPersona', 'modules', 'enabledModules', 'moduleIntergration', 'characters']);
    const LIBRA_IDENTITY_DB_READ_KEYS = Object.freeze(['personas', 'selectedPersona']);
    const getLibraAllowedDatabase = async (keys = LIBRA_DB_READ_KEYS) => {
        try {
            return await RisuCompat.database.get(Array.isArray(keys) ? keys : LIBRA_DB_READ_KEYS);
        } catch {
            return null;
        }
    };
    const getLibraIdentityDatabase = async () => await getLibraAllowedDatabase(LIBRA_IDENTITY_DB_READ_KEYS);
    const getActiveManagedRuntimeScopeKey = () => String(MemoryState._activeScopeKey || MemoryState._activeChatId || '').trim();
    const getActiveManagedChatId = () => String(MemoryState._activeChatId || '').trim();
