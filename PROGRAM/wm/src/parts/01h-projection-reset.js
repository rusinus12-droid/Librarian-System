    const isLibraManagedLoreEntryForReset = (entry = null) => {
        if (!entry || typeof entry !== 'object') return false;
        const comment = String(entry.comment || '').trim();
        const key = String(entry.key || '').trim();
        if (comment.startsWith('lmai_')) return true;
        if (key.startsWith('lmai_')) return true;
        if (LibraLoreConsolidator.isContainer(entry)) return true;
        if (key.startsWith('LIBRA_DATA_')) return true;
        return isRetiredOrchestrationLoreEntry(entry);
    };

    const LIBRA_PROJECTION_COMMENTS = Object.freeze([
        'lmai_projection_active_state',
        'lmai_projection_boundary_guard',
        'lmai_projection_recall_bundle',
        'lmai_projection_typed_recall'
    ]);
    const LIBRA_PROJECTION_COMMENT_SET = new Set(LIBRA_PROJECTION_COMMENTS);
    const LIBRA_PROJECTION_LABELS = Object.freeze({
        active: 'LIBRA_ACTIVE_STATE',
        boundary: 'LIBRA_BOUNDARY_GUARD',
        recall: 'LIBRA_RECALL_BUNDLE'
    });
    const LIBRA_PROJECTION_MIN_RECOMMENDED_CHARS = 6400;
    const LIBRA_PROJECTION_STABLE_CHARS = 7200;
    const LIBRA_PROJECTION_GENEROUS_CHARS = 8000;
    const LIBRA_HIDDEN_OPERATIONAL_DEFAULTS = Object.freeze({
        libraInjectionMode: 'direct',
        libraProjectionRecallBundle: 'off',
        libraProjectionMaxChars: LIBRA_PROJECTION_STABLE_CHARS,
        hmeAssociativeGraphMode: 'light',
        hmeGraphMaxSeeds: 6,
        hmeGraphMaxCandidates: 10,
        hmeGraphMaxAdditions: 4,
        hmeGraphMaxNodes: 800,
        hmeGraphMaxEdges: 1024,
        hmeGraphMaxHops: 2,
        hmeGraphBonusCap: 0.10,
        hmeGraphMinRecallCandidates: 24
    });
    const normalizeLibraInjectionMode = (value = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraInjectionMode) => {
        const mode = String(value || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraInjectionMode).trim().toLowerCase();
        return ['direct', 'lorebook_projection'].includes(mode) ? mode : LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraInjectionMode;
    };
    const normalizeLibraProjectionRecallBundle = (value = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionRecallBundle) => {
        const mode = String(value || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionRecallBundle).trim().toLowerCase();
        return ['off', 'projection_only', 'always'].includes(mode) ? mode : LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionRecallBundle;
    };
    const shouldBuildLibraProjectionRecallBundle = (config = null) => {
        const injectionMode = normalizeLibraInjectionMode(config?.libraInjectionMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraInjectionMode);
        const bundleMode = normalizeLibraProjectionRecallBundle(config?.libraProjectionRecallBundle || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionRecallBundle);
        if (bundleMode === 'off') return false;
        if (bundleMode === 'always') return true;
        return injectionMode === 'lorebook_projection';
    };
    const compactLibraProjectionBlock = (value = '', maxChars = 2400) => {
        const raw = String(value || '')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
        const limit = Math.max(400, Math.min(20000, Number(maxChars || 2400) || 2400));
        return truncateForLLM(raw, limit, '\n...[LIBRA projection clipped]...\n').trim();
    };
    const buildLibraProjectionEntry = ({ comment, label, content, order = 980, alwaysActive = true, memo = '' }) => {
        const body = String(content || '').trim();
        if (!body) return null;
        return {
            key: String(label || comment || '').trim(),
            comment: String(comment || '').trim(),
            memo: memo || 'LIBRA_PROJECTION',
            content: body,
            mode: 'constant',
            insertorder: order,
            alwaysActive: alwaysActive !== false,
            selective: false,
            useRegex: false,
            secondkey: '',
            depth: 0
        };
    };
    const stripLibraProjectionEntries = (lore = []) => (Array.isArray(lore) ? lore : [])
        .filter(entry => !LIBRA_PROJECTION_COMMENT_SET.has(String(entry?.comment || '').trim()));
    const upsertLibraProjectionEntries = (lore = [], entries = [], options = {}) => {
        const base = stripLibraProjectionEntries(LibraLoreConsolidator.unpack(Array.isArray(lore) ? lore : []));
        const nextEntries = (Array.isArray(entries) ? entries : [])
            .filter(entry => entry && String(entry?.comment || '').trim() && String(entry?.content || '').trim())
            .map(entry => safeClone(entry));
        const next = [...base, ...nextEntries];
        const digestPayload = nextEntries.map(entry => ({
            comment: entry.comment,
            key: entry.key,
            alwaysActive: entry.alwaysActive === true,
            contentHash: stableHash(entry.content || '')
        }));
        const digest = stableHash(JSON.stringify(digestPayload));
        const previousDigest = String(options.previousDigest || '').trim();
        const currentProjectionDigest = stableHash(JSON.stringify(
            LibraLoreConsolidator.unpack(Array.isArray(lore) ? lore : [])
                .filter(entry => LIBRA_PROJECTION_COMMENT_SET.has(String(entry?.comment || '').trim()))
                .map(entry => ({ comment: entry.comment, key: entry.key, alwaysActive: entry.alwaysActive === true, contentHash: stableHash(entry.content || '') }))
        ));
        const changed = previousDigest ? previousDigest !== digest : currentProjectionDigest !== digest;
        return { lore: next, entries: nextEntries, digest, changed };
    };
    const buildLibraProjectionEntriesFromContext = (ctx = {}, config = null) => {
        const cfg = config || {};
        const injectionMode = normalizeLibraInjectionMode(cfg.libraInjectionMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraInjectionMode);
        if (injectionMode === 'direct' || cfg.libraProjectionAlwaysActive === false) return [];
        if (ctx.typedRecallFinalized) {
            // Typed blocks have already passed atomic shared budget/safety gates.
            // Never feed them through the legacy character clipping path.
            return TypedRecallConsumers.verified(ctx.typedRecallFinalized)
                ? ctx.typedRecallFinalized.projectionEntries.map(entry => safeClone(entry)) : [];
        }
        const maxChars = Math.max(
            LIBRA_PROJECTION_MIN_RECOMMENDED_CHARS,
            Math.min(
                LIBRA_PROJECTION_GENEROUS_CHARS,
                Number(cfg.libraProjectionMaxChars || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionMaxChars) || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionMaxChars
            )
        );
        const nowIso = new Date().toISOString();
        const scopeHash = stableHash(ctx.scopeKey || ctx.chatId || 'global');
        const activeParts = [];
        const pushActive = (title, value, sectionMax = Math.floor(maxChars * 0.75)) => {
            const text = compactLibraProjectionBlock(value, Math.max(300, Number(sectionMax || 0) || Math.floor(maxChars * 0.75)));
            if (text) activeParts.push(`## ${title}\n${text}`);
        };
        const entityProjectionText = ctx.entityProjectionPrompt || ctx.entityPrompt || '';
        const relationProjectionText = ctx.relationProjectionPrompt || ctx.relationPrompt || '';
        pushActive('Temporal / Scene', ctx.temporalPrecisionPrompt, 520);
        pushActive('Active Entities', entityProjectionText ? `[인물 정보 / Character Info]\n${entityProjectionText}` : '', 1250);
        pushActive('Active Relations', relationProjectionText ? `[관계 정보 / Relationship Info]\n${relationProjectionText}` : '', 1050);
        pushActive('World State', ctx.worldStatePrompt, 850);
        pushActive('World', ctx.worldProjectionPrompt || ctx.worldPrompt, 1100);
        pushActive('Section World', ctx.sectionWorldPrompt, 850);
        if (Array.isArray(ctx.charStateSections) && ctx.charStateSections.length > 0) {
            pushActive('Character States', ctx.charStateSections
                .map(section => String(section?.text || section || '').trim())
                .filter(Boolean)
                .join('\n\n'), 850);
        }
        if (injectionMode === 'lorebook_projection') {
            pushActive('Director', ctx.directorPrompt, 650);
            pushActive('Story Author', ctx.storyAuthorPrompt, 650);
            pushActive('World Additional', ctx.worldAdditionalPrompt, 950);
        }
        const activeContent = activeParts.length > 0 ? compactLibraProjectionBlock([
            `[${LIBRA_PROJECTION_LABELS.active}]`,
            'purpose: Stable LIBRA current-state projection for the RisuAI lorebook slot. Use as reference data; do not quote this block.',
            `mode: ${injectionMode}`,
            `scope: ${scopeHash}`,
            `updatedAt: ${nowIso}`,
            ...activeParts
        ].join('\n\n'), maxChars) : '';

        const boundaryParts = [];
        const pushBoundary = (title, value) => {
            const text = compactLibraProjectionBlock(value, Math.max(260, Math.floor(maxChars * 0.55)));
            if (text) boundaryParts.push(`## ${title}\n${text}`);
        };
        pushBoundary('Reference Safety', ctx.referenceSafetyPrompt);
        pushBoundary('Secrecy Guard', ctx.secrecyGuardPrompt);
        pushBoundary('Secret Boundary', ctx.secretBoundaryPrompt);
        pushBoundary('Entity POV Boundary', ctx.entityPovBoundaryPrompt);
        const boundaryContent = boundaryParts.length > 0 ? compactLibraProjectionBlock([
            `[${LIBRA_PROJECTION_LABELS.boundary}]`,
            'purpose: Stable LIBRA boundary projection. Prevent POV leakage, secret leakage, stale assumptions, and invalidated recall.',
            `mode: ${injectionMode}`,
            `scope: ${scopeHash}`,
            `updatedAt: ${nowIso}`,
            ...boundaryParts
        ].join('\n\n'), maxChars) : '';

        const recallParts = [];
        if (shouldBuildLibraProjectionRecallBundle(cfg)) {
            const pushRecall = (title, value) => {
                const text = compactLibraProjectionBlock(value, Math.max(300, Math.floor(maxChars * 0.75)));
                if (text) recallParts.push(`## ${title}\n${text}`);
            };
            pushRecall('RP Long-Term Continuity', ctx.rpContinuityText || '');
            pushRecall('Related Memories', ctx.memoryText ? `[관련 기억 / Related Memories]\n${ctx.memoryText}` : '');
            pushRecall('Reference Lorebook', ctx.lorebookText ? `[로어북 설정 / Reference Lorebook]\n${ctx.lorebookText}` : '');
            pushRecall('Narrative', ctx.narrativePrompt);
            const memoryDebug = ctx.memoryDebug || null;
            if (memoryDebug) {
                pushRecall('Recall Debug Summary', [
                    `selected=${memoryDebug.selectedCount ?? ''}`,
                    `candidates=${memoryDebug.originalCandidates ?? ''}`,
                    `domainGuardBlocked=${memoryDebug.domainGuardBlocked === true}`,
                    `graph=${memoryDebug.hmeAssociativeGraph?.enabled ? memoryDebug.hmeAssociativeGraph?.mode || 'on' : 'off'}`
                ].join(' | '));
            }
        }
        const recallContent = recallParts.length > 0 ? compactLibraProjectionBlock([
            `[${LIBRA_PROJECTION_LABELS.recall}]`,
            'purpose: Dynamic LIBRA recall projection. It is a selected recall bundle, not a database dump.',
            `mode: ${injectionMode}`,
            `scope: ${scopeHash}`,
            `updatedAt: ${nowIso}`,
            ...recallParts
        ].join('\n\n'), maxChars) : '';

        return [
            buildLibraProjectionEntry({ comment: 'lmai_projection_active_state', label: LIBRA_PROJECTION_LABELS.active, content: activeContent, order: 982, alwaysActive: cfg.libraProjectionAlwaysActive !== false }),
            buildLibraProjectionEntry({ comment: 'lmai_projection_boundary_guard', label: LIBRA_PROJECTION_LABELS.boundary, content: boundaryContent, order: 981, alwaysActive: cfg.libraProjectionAlwaysActive !== false }),
            buildLibraProjectionEntry({ comment: 'lmai_projection_recall_bundle', label: LIBRA_PROJECTION_LABELS.recall, content: recallContent, order: 980, alwaysActive: cfg.libraProjectionAlwaysActive !== false })
        ].filter(Boolean);
    };
    const shouldDirectInjectLibraSection = (section = {}, config = null) => {
        const mode = normalizeLibraInjectionMode(config?.libraInjectionMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraInjectionMode);
        if (mode === 'direct') return true;
        const key = String(section?.key || '').trim();
        const projectionAvailable = config?.libraProjectionAlwaysActive !== false;
        if (!projectionAvailable) return true;
        if (mode === 'lorebook_projection') return false;
        return true;
    };

    const stripLibraManagedLoreForReset = (entries = []) => {
        const source = Array.isArray(entries) ? entries : [];
        const unpacked = LibraLoreConsolidator.unpack(source);
        const removedManagedCount = unpacked.filter(isLibraManagedLoreEntryForReset).length;
        const kept = source
            .filter(entry => !isLibraManagedLoreEntryForReset(entry))
            .map(entry => safeClone(entry));
        return {
            entries: kept,
            removed: removedManagedCount || Math.max(0, source.length - kept.length)
        };
    };

    const stripLibraManagedLoreFieldsForReset = (target = null, fields = []) => {
        if (!target || typeof target !== 'object') return 0;
        let removed = 0;
        for (const field of fields) {
            if (!Array.isArray(target[field])) continue;
            const stripped = stripLibraManagedLoreForReset(target[field]);
            target[field] = stripped.entries;
            removed += stripped.removed;
        }
        return removed;
    };

    const stripNestedLibraManagedLoreForReset = (target = null, depth = 0) => {
        if (!target || typeof target !== 'object' || depth > 2) return 0;
        let removed = stripLibraManagedLoreFieldsForReset(target, ['entries', 'lorebook', 'lore', 'globalLore', 'data']);
        for (const field of ['data', 'card', 'spec']) {
            if (target[field] && typeof target[field] === 'object' && !Array.isArray(target[field])) {
                removed += stripNestedLibraManagedLoreForReset(target[field], depth + 1);
            }
        }
        return removed;
    };

    const purgeLibraManagedLoreForActiveChat = async (preferredChat = null, opts = {}) => {
        if(VersionedCanonicalBridge.mode==='authority')return {ok:false,reason:'authority_host_purge_unsupported'};
        const { purgeGlobal = true } = opts || {};
        bindUiInteractionGuards();
        const delayMs = uiInteractionHotUntil - Date.now();
        if (delayMs > 0) await sleep(delayMs + 50);

        // Acquire the baseline after the UI guard delay. Capturing it before the
        // delay could roll back messages or host fields written while we waited.
        const freshChar = await RisuCompat.getCharacter();
        if (!freshChar) return { ok: false, reason: 'missing_char' };
        const charIdx = normalizeRisuIndex(await RisuCompat.getCurrentCharacterIndex());
        const expectedCharacterId = String(freshChar?.id || freshChar?.chaId || '').trim();
        const chats = Array.isArray(freshChar.chats) ? freshChar.chats : [];
        let chatIndex = normalizeRisuIndex(await RisuCompat.getCurrentChatIndex());
        if (preferredChat?.id) {
            const resolved = chats.findIndex(entry => String(entry?.id || '') === String(preferredChat.id));
            if (resolved >= 0) chatIndex = resolved;
            else return { ok: false, reason: 'preferred_chat_not_found' };
        }
        const freshChat = chats[chatIndex];
        if (!freshChat || chatIndex < 0) return { ok: false, reason: 'missing_chat_context' };
        const expectedChatId = String(freshChat?.id || '');
        const buildPurgedSnapshot = (baseChar, preferredIndex = chatIndex) => {
            const nextChar = cloneForMutation(baseChar);
            nextChar.chats = Array.isArray(nextChar.chats) ? nextChar.chats : [];
            const resolvedIndex = expectedChatId
                ? nextChar.chats.findIndex(entry => String(entry?.id || '') === expectedChatId)
                : preferredIndex;
            if (resolvedIndex < 0 || !nextChar.chats[resolvedIndex]) return null;
            const nextChat = cloneChatForLoreMutation(nextChar.chats[resolvedIndex]);
            let removed = 0;
            removed += stripLibraManagedLoreFieldsForReset(nextChat, ['localLore', 'lorebook', 'lore']);
            if (purgeGlobal) {
                removed += stripLibraManagedLoreFieldsForReset(nextChar, ['lorebook', 'lore', 'characterLore', 'rawCharacterLore', 'globalLore']);
                removed += stripNestedLibraManagedLoreForReset(nextChar.data);
                removed += stripNestedLibraManagedLoreForReset(nextChar.card);
                removed += stripNestedLibraManagedLoreForReset(nextChar.spec);
            }
            nextChar.chats[resolvedIndex] = safeClone(nextChat);
            return { nextChar, nextChat, removed, chatIndex: resolvedIndex };
        };

        // Rebase the destructive transform on the newest whole-character
        // snapshot immediately before writing, preserving concurrent host edits.
        const verifyChar = await RisuCompat.getCharacter();
        const verifyCharacterId = String(verifyChar?.id || verifyChar?.chaId || '').trim();
        if (expectedCharacterId && verifyCharacterId !== expectedCharacterId) {
            return { ok: false, reason: 'character_changed_before_save' };
        }
        const purged = buildPurgedSnapshot(verifyChar, chatIndex);
        if (!purged) return { ok: false, reason: 'chat_changed_before_save' };
        if (charIdx >= 0 && RisuCompat.has('setCharacterToIndex')) {
            const saved = await RisuCompat.setCharacterToIndex(charIdx, safeClone(purged.nextChar));
            if (saved === false) return { ok: false, reason: 'indexed_character_write_failed' };
        } else {
            await RisuCompat.setCharacter(safeClone(purged.nextChar));
        }
        const savedChat = {
            ...safeClone(purged.nextChat),
            localLore: Array.isArray(purged.nextChat.localLore) ? LibraLoreConsolidator.unpack(purged.nextChat.localLore).map(e => safeClone(e)) : purged.nextChat.localLore
        };
        return { ok: true, char: purged.nextChar, chat: savedChat, storedChat: purged.nextChat, removed: purged.removed, chatIndex: purged.chatIndex, charIdx };
    };
