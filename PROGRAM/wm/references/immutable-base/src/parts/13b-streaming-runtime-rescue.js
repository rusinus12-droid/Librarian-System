let ensureResponseStreamingCompatibilityHandlers = async () => false;
let libraResponseStreamingOutputHandler = null;
let libraResponseStreamingEditOutputHandler = null;
let libraResponseOutputCaptureTimer = null;
let libraResponseOutputCapturePending = null;
let libraResponseOutputCaptureRunning = false;

const readWorldMutationFlag = (worldPayload = {}, keys = []) => {
    const roots = [worldPayload?.global, worldPayload?.structure, worldPayload?.flags, worldPayload?.meta];
    for (const root of roots) {
        if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
        for (const key of keys) {
            if (root[key] === true) return true;
            if (root[key] === false) return false;
        }
    }
    return undefined;
};

const resolveStructuredWorldMutationPolicy = (worldPayload = {}) => {
    const systems = (worldPayload?.systems && typeof worldPayload.systems === 'object') ? worldPayload.systems : {};
    const explicitGlobal = [
        ['multiverse', 'multiVerse', 'multipleWorlds', 'multiple_worlds'],
        ['dimensionTravel', 'dimension_travel', 'interdimensionalTravel', 'interdimensional_travel'],
        ['timeTravel', 'time_travel', 'timeLoop', 'time_loop'],
        ['metaNarrative', 'meta_narrative', 'fourthWall', 'fourth_wall'],
        ['virtualReality', 'virtual_reality', 'simulation'],
        ['dreamWorld', 'dream_world'],
        ['reincarnationPossession', 'reincarnation_possession', 'reincarnation', 'possession', 'transmigration']
    ].some(keys => readWorldMutationFlag(worldPayload, keys) === true);
    const explicitSystemInterface = readWorldMutationFlag(worldPayload, ['systemInterface', 'system_interface']);
    const structuredSystemInterface = [
        systems.systemInterface,
        systems.system_interface,
        systems.leveling,
        systems.stats,
        systems.skills,
        systems.classes,
        systems.quests,
        systems.inventory
    ].some(value => value === true);
    const explicitShifts = Array.isArray(worldPayload?.dimensionalShifts)
        ? worldPayload.dimensionalShifts
        : (Array.isArray(worldPayload?.dimensional_shifts) ? worldPayload.dimensional_shifts : []);
    return {
        indicatorCount: 0,
        structuralSignals: Number(explicitGlobal) + Number(explicitSystemInterface === true || structuredSystemInterface),
        allowGlobalFlags: explicitGlobal || explicitSystemInterface === true || structuredSystemInterface,
        allowDimensionalShift: explicitShifts.length > 0,
        allowSystemInterface: explicitSystemInterface === true || structuredSystemInterface
    };
};

const reloadChatScopedRuntime = (lore, chatId = null, opts = {}) => {
    const { resetSessionCaches = false, forceWorldReload = false, scopeKey = null, resetScopedState = false,
        restoreScopeSnapshot = true, transactionToken = null, preserveResponseOrigins = false } = opts;
    if (transactionToken && (!ScopedRuntimeTransaction.owns(transactionToken)
        || ScopedRuntimeTransaction.current()?.scopeKey !== String(scopeKey || chatId || '').trim())) {
        throw new Error('runtime_owner_invalid');
    }
    const hasStateEntry = (comment = '') => (Array.isArray(lore) ? lore : [])
        .some(entry => String(entry?.comment || '').trim() === comment);
    const loadPersistentScopedState = () => {
        NarrativeTracker.loadState(lore);
        StoryAuthor.loadState(lore);
        Director.loadState(lore);
        WorldAdditionalCore.loadState?.(lore, {
            scopeKey: String(scopeKey || chatId || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global',
            chatId: String(chatId || getActiveManagedChatId() || '').trim()
        });
        UserDlcCore.loadState?.(lore, {
            scopeKey: String(scopeKey || chatId || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global',
            chatId: String(chatId || getActiveManagedChatId() || '').trim()
        });
        CharacterStateTracker.loadState(lore);
        WorldStateTracker.loadState(lore);
        SectionWorldInferenceManager.resetState();
    };
    if (resetSessionCaches) {
        MemoryState.reset({ preserveSessionCache: true, preserveRuntimeTransaction: transactionToken, preserveResponseOrigins });
        MemoryState.ignoredGreetingSignature = null;
        MemoryState.greetingIsolationChatId = null;
        MemoryState.greetingIsolationRearmAvailable = false;
        MemoryState.pendingGreetingIsolationChatId = null;
        MemoryState.pendingGreetingIsolationArmed = false;
        MemoryState.isSessionRestored = false;
        _lastUserMessage = '';
        _lastUserMessageRaw = '';
    }
    // Consumers validate signed records against the destination during loading.
    MemoryState._activeChatId = chatId || null;
    MemoryState._activeScopeKey = scopeKey || chatId || null;
    MemoryEngine.rebuildIndex(lore);
    try {
        SecretKnowledgeCore.loadState(lore, {
            scopeKey: String(scopeKey || chatId || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global',
            chatId: String(chatId || getActiveManagedChatId() || '').trim()
        });
        EntityKnowledgeVaultCore.loadState(lore, {
            scopeKey: String(scopeKey || chatId || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global',
            chatId: String(chatId || getActiveManagedChatId() || '').trim()
        });
        TimeEngine.loadState(lore, {
            scopeKey: String(scopeKey || chatId || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global',
            chatId: String(chatId || getActiveManagedChatId() || '').trim()
        });
    } catch (e) {
        if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA] scoped knowledge/time reload skipped:', e?.message || e);
    }
    EntityManager.rebuildCache(lore);
    HierarchicalWorldManager.loadWorldGraph(lore, forceWorldReload);
    if (resetScopedState) {
        const restored = restoreScopeSnapshot && restoreScopedRuntimeState(scopeKey);
        const hasPersistentState = hasStateEntry('lmai_narrative')
            || hasStateEntry('lmai_story_author')
            || hasStateEntry('lmai_director')
            || hasStateEntry('lmai_world_additional')
            || hasStateEntry('lmai_user_dlc')
            || hasStateEntry('lmai_char_states')
            || hasStateEntry('lmai_world_states');
        if (hasPersistentState) {
            // Lorebook state is the persistence authority.  Session snapshots are
            // only a fallback when the lore has no saved scoped state.
            loadPersistentScopedState();
        } else if (!restored) {
            NarrativeTracker.resetState({ storylines: [], turnLog: [], metaTurnLog: [], lastSummaryTurn: 0 });
            StoryAuthor.resetState();
            Director.resetState();
            WorldAdditionalCore.resetState?.();
            UserDlcCore.resetState?.();
            CharacterStateTracker.resetState();
            WorldStateTracker.resetState();
            SectionWorldInferenceManager.resetState();
        }
    } else if (!resetScopedState) {
        loadPersistentScopedState();
    }
    MemoryEngine.setTurn(deriveMaxTurnFromLorebook(lore));
    MemoryState._activeChatId = chatId || null;
    MemoryState._activeScopeKey = scopeKey || chatId || null;
};

const PersonaRuntimeCoordinator = (() => {
    let lastView = null;
    const quarantineFailedPublication = (token, scopeKey) => {
        if (!ScopedRuntimeTransaction.owns(token)) return;
        // Mark unusable before cleanup: no partially loaded persona is current.
        lastView = null;
        MemoryState.isInitialized = false;
        MemoryState._activeScopeKey = null;
        MemoryState._activeChatId = null;
        MemoryState.currentSessionId = null;
        MemoryState.personaActivationError = 'persona_runtime_unavailable';
        const cleanup = [
            () => LibraDataStorage.invalidateRuntimeView(scopeKey),
            () => MemoryState.reset({ preserveSessionCache: false }),
            () => EntityManager.clearCache(), () => EntityManager.refreshIdentity(null, null),
            () => HierarchicalWorldManager.resetState(), () => EntityCandidateCore.resetState(),
            () => SecretKnowledgeCore.resetState(), () => EntityKnowledgeVaultCore.resetState(),
            () => TimeEngine.resetState(), () => NarrativeTracker.resetState(),
            () => StoryAuthor.resetState(), () => Director.resetState(),
            () => WorldAdditionalCore.resetState(), () => UserDlcCore.resetState(),
            () => CharacterStateTracker.resetState(), () => WorldStateTracker.resetState(),
            () => SectionWorldInferenceManager.resetState(),
            () => QuarantineManager.resetState(), () => IntegrityScanner.resetState()
        ];
        for (const clear of cleanup) { try { clear(); } catch (_) {} }
        _lastUserMessage = ''; _lastUserMessageRaw = '';
    };
    const activate = async (context = {}, options = {}) => {
        if (!context.char || !context.chat) return { ok: false, readOnly: true, reason: context.personaAdmission?.reason || context.reason || 'missing_chat_context' };
        if (ScopedRuntimeTransaction.current()) return { ok: false, readOnly: true, reason: 'runtime_transaction_busy' };
        await loreLock.writeLock();
        let token = null;
        let publicationScope = '';
        const reject = reason => ({ ok: false, readOnly: true, reason });
        try {
            if (ScopedRuntimeTransaction.current()) return reject('runtime_transaction_busy');
            const previousScope = MemoryState._activeScopeKey, previousVersion = MemoryState.initVersion;
            const admission = await LibraDataStorage.preparePersonaContext(context.char, context.chat, options);
            if (!admission.ok) return admission;
            if (MemoryState._activeScopeKey !== previousScope || MemoryState.initVersion !== previousVersion) return reject('stale_persona_context');
            token = ScopedRuntimeTransaction.begin(admission.runtimeScopeKey, 'persona.activate');
            if (!token) return reject('runtime_transaction_busy');
            let latestContext = context;
            const owns = () => ScopedRuntimeTransaction.owns(token)
                && MemoryState._activeScopeKey === previousScope && MemoryState.initVersion === previousVersion
                && (!options.isViewCurrent || options.isViewCurrent() === true);
            const isCurrent = async () => {
                if (!owns()) return false;
                const latest = await resolveActiveChatContext(null,{authorityRequest:options.authorityRequest});
                if (!owns() || !latest?.chat || !latest.personaAdmission?.ok) return false;
                const proof = latest.personaAdmission;
                if (proof.scopeKey !== admission.scopeKey || proof.runtimeScopeKey !== admission.runtimeScopeKey
                    || proof.resetGeneration !== admission.resetGeneration) return false;
                latestContext = latest;
                return true;
            };
            if (!await isCurrent()) return reject('stale_persona_context');
            let canonical = await LibraDataStorage.readVerified(admission.scopeKey,{authorityRequest:options.authorityRequest});
            if (!canonical.ok) return reject(canonical.reason);
            if (!await isCurrent()) return reject('stale_persona_context');
            if (canonical.missing && VersionedCanonicalBridge.mode === "authority") return reject("authority_branch_token_required");
            if (canonical.missing) {
                const inherited = await LibraDataStorage.inheritFromBranch(context.char, context.chat, {
                    stageOnly: true, personaId: admission.personaId,
                    runtimeScopeKey: admission.runtimeScopeKey, runtimeChatId: admission.chatId
                });
                if (!inherited.ok) return reject(inherited.reason || 'branch_source_unverified');
                if (!await isCurrent()) return reject('stale_persona_context');
                if (inherited.inherited > 0) {
                    const saved = await LibraDataStorage.saveVerified(admission.scopeKey, inherited.entries, {
                        expectedRaw: null, inheritance: inherited.inheritance, isCurrent
                    });
                    if (!saved.ok) return reject(saved.reason);
                    canonical = await LibraDataStorage.readVerified(admission.scopeKey,{authorityRequest:options.authorityRequest});
                    if (!canonical.ok || canonical.raw !== saved.raw) return reject('canonical_changed');
                }
            }
            const view = LibraDataStorage.inspectHydrationEntries(canonical.entries, {
                ...context, ...admission, runtimeChatId: admission.chatId, canonicalEnvelopeVerified: !canonical.missing
            });
            if (!view.ok) return reject('canonical_provenance_unverified');
            if (!await isCurrent()) return reject('stale_persona_context');
            if (latestContext.personaAdmission.canonicalRaw !== canonical.raw) return reject('canonical_changed');
            const unchanged = MemoryState.isInitialized && lastView?.runtimeScopeKey === admission.runtimeScopeKey
                && lastView?.raw === canonical.raw && lastView?.version === MemoryState.initVersion
                && MemoryState._activeScopeKey === admission.runtimeScopeKey
                && LibraDataStorage.getActiveScope() === admission.scopeKey;
            // Freshly revalidated bytes can be unchanged after a transient read
            // failure. Refresh their storage publication without reloading the
            // live runtime, invalidating leases, or replacing pending owners.
            if (unchanged && LibraDataStorage.getHydrationDiagnostics(admission.scopeKey).readOnly) {
                publicationScope = admission.scopeKey;
                const published = LibraDataStorage.publishVerifiedView(latestContext.char, latestContext.chat, admission.scopeKey, view.entries);
                if (!published.ok) return reject(published.reason);
            }
            if (!unchanged) {
                publicationScope = admission.scopeKey;
                const published = LibraDataStorage.publishVerifiedView(latestContext.char, latestContext.chat, admission.scopeKey, view.entries);
                if (!published.ok) return reject(published.reason);
                if (previousScope && previousScope !== admission.runtimeScopeKey) rememberScopedRuntimeState(previousScope);
                LibraLoreConsolidator.withRawManagementRead(() => {
                    reloadChatScopedRuntime(published.entries, admission.chatId, {
                        scopeKey: admission.runtimeScopeKey, resetSessionCaches: previousScope !== admission.runtimeScopeKey,
                        resetScopedState: true, forceWorldReload: true, restoreScopeSnapshot: false, transactionToken: token,
                        preserveResponseOrigins: true
                    });
                    EntityCandidateCore.loadState(published.entries, { scopeKey: admission.runtimeScopeKey, chatId: admission.chatId });
                    QuarantineManager.list(published.entries, { strictRead: true });
                    IntegrityScanner.listFindings(published.entries, { strictRead: true });
                });
                if (previousScope !== admission.runtimeScopeKey || !MemoryState.currentSessionId) {
                    MemoryState.currentSessionId = buildScopedSessionId(admission.runtimeScopeKey);
                }
                MemoryState.isInitialized = true;
                MemoryState.personaActivationError = '';
                lastView = { runtimeScopeKey: admission.runtimeScopeKey, raw: canonical.raw, version: MemoryState.initVersion };
            }
            return { ok: true, readOnly: false, activated: !unchanged, context: latestContext,
                admission, lore: safeClone(view.entries) };
        } catch (_) {
            if (publicationScope) quarantineFailedPublication(token, publicationScope);
            return reject('persona_activation_unavailable');
        }
        finally { if (token) ScopedRuntimeTransaction.end(token); loreLock.writeUnlock(); }
    };
    return Object.freeze({ activate, quarantineOwnedRuntime: quarantineFailedPublication });
})();

// 지연 초기화 (CHAT_START 대체 - beforeRequest 최초 호출 시 실행)
    const _lazyInit = async (lore) => {
    if (MemoryState.isInitialized) return;
    reloadChatScopedRuntime(lore, MemoryState._activeChatId, {
        forceWorldReload: false,
        scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || null
    });
    const managed = MemoryEngine.getManagedEntries(lore);
    MemoryState.isInitialized = true;
    if (MemoryEngine.CONFIG.debug) {
        recordRuntimeDebug('log', `[LIBRA] Lazy init. Turn: ${MemoryEngine.getCurrentTurn()}, Memories: ${managed.length}`);
        recordRuntimeDebug('log', `[LIBRA] Entities: ${EntityManager.getEntityCache().size}, Relations: ${EntityManager.getRelationCache().size}`);
    }
};

if (RisuCompat.api()) {
    let scheduleDurableTurnReplay = () => false;
    const ensureMainResponseTransportInterceptor = async () => {
        if (!RisuCompat.has('registerBodyIntercepter')) return null;
        if (globalThis.__LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_INFLIGHT__) {
            try { return await globalThis.__LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_INFLIGHT__; } catch (_) { return null; }
        }
        const inflight = (async () => {
            try {
                const existing = globalThis[LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_KEY];
                const existingId = String(existing?.id || '').trim();
                if (existingId && RisuCompat.has('unregisterBodyIntercepter')) {
                    let unregistered = false;
                    try { unregistered = await RisuCompat.unregisterBodyIntercepter(existingId); } catch (_) { unregistered = false; }
                    if (!unregistered) {
                        if (MemoryEngine.CONFIG?.debug) {
                            recordRuntimeDebug('warn', '[LIBRA] Existing response transport interceptor kept; unregister failed');
                        }
                        return existing || null;
                    }
                    try { delete globalThis[LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_KEY]; } catch (_) {}
                }
                const registered = await RisuCompat.registerBodyIntercepter(async (body, interceptorType) => {
                    try {
                        const classified = classifyMainResponseTransportFromInterceptor(interceptorType, body);
                        if (classified?.auxiliary === true) {
                            if (MemoryEngine.CONFIG?.debug) {
                                recordRuntimeDebug('log', '[LIBRA] auxiliary transport ignored', {
                                    __libraDebugMeta: true,
                                    reason: classified.auxiliaryReason || 'auxiliary_transport_payload',
                                    kind: classified.auxiliaryKind || '',
                                    mode: classified.mode || 'unknown',
                                    source: classified.source || '',
                                    interceptorType: classified.interceptorType || '',
                                    bodyStreamFlag: typeof classified.bodyStreamFlag === 'boolean' ? classified.bodyStreamFlag : null
                                });
                            }
                            return body;
                        }
                        if (!classified || classified.mode === 'unknown') return body;
                        let chat = null;
                        try {
                            const char = await RisuCompat.getCharacter();
                            const chatIndex = normalizeRisuIndex(await RisuCompat.getCurrentChatIndex());
                            chat = Array.isArray(char?.chats) && chatIndex >= 0 ? char.chats[chatIndex] : null;
                            if (!chat && Number.isFinite(Number(char?.chatPage))) chat = char?.chats?.[Number(char.chatPage)] || null;
                        } catch (_) {
                            chat = null;
                        }
                        if (!chat && MemoryState._activeChatId) {
                            const resolved = await resolveActiveChatContext({ id: MemoryState._activeChatId });
                            chat = resolved?.chat || null;
                        }
                        if (!chat) return body;
                        const updated = annotateLatestAfterRequestOriginTransport(chat, {
                            mode: classified.mode,
                            source: classified.source,
                            reliable: classified.reliable,
                            interceptorType: classified.interceptorType,
                            observedAt: Date.now(),
                            bodyStreamFlag: classified.bodyStreamFlag
                        });
                        if (!updated) {
                            rememberRecentMainResponseTransportHint(chat, {
                                mode: classified.mode,
                                source: classified.source,
                                reliable: classified.reliable,
                                interceptorType: classified.interceptorType,
                                observedAt: Date.now(),
                                bodyStreamFlag: classified.bodyStreamFlag
                            });
                        }
                        if (MemoryEngine.CONFIG?.debug) {
                            recordRuntimeDebug('log', '[LIBRA] Main response transport captured', {
                                __libraDebugMeta: true,
                                chatId: chat?.id || null,
                                mode: classified.mode,
                                source: classified.source,
                                interceptorType: classified.interceptorType || '',
                                requestType: String(updated?.requestType || '').trim() || 'unknown'
                            });
                        }
                    } catch (transportError) {
                        if (MemoryEngine.CONFIG?.debug) {
                            recordRuntimeDebug('warn', '[LIBRA] Main response transport interceptor failed:', transportError?.message || transportError);
                        }
                    }
                    return body;
                });
                const record = {
                    id: String(typeof registered === 'string' ? registered : (registered?.id || '')).trim(),
                    registeredAt: Date.now()
                };
                globalThis[LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_KEY] = record;
                return record;
            } catch (error) {
                if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] Main response transport interceptor unavailable:', error?.message || error);
                }
                return null;
            }
        })();
        globalThis.__LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_INFLIGHT__ = inflight;
        try {
            return await inflight;
        } finally {
            if (globalThis.__LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_INFLIGHT__ === inflight) {
                try { delete globalThis.__LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_INFLIGHT__; } catch (_) {}
            }
        }
    };

    ensureResponseStreamingCompatibilityHandlers = async () => {
        await ensureMainResponseTransportInterceptor();
        if (libraResponseStreamingOutputHandler || libraResponseStreamingEditOutputHandler) return true;
        if (!RisuCompat.has('addRisuScriptHandler')) return false;
        const captureMainResponseOutputContent = async (content, phase = 'output') => {
            if (!isResponseStreamingCompatEnabled(MemoryEngine.CONFIG)) return content;
            try {
                const handlerPhase = String(phase || 'output').trim().toLowerCase() || 'output';
                const rawContentText = extractResponseTextValue(content, new WeakSet(), true) || String(content || '');
                const displayContent = String(Utils.sanitizeForLibra(rawContentText) || '').trim();
                const memorySourceText = String(Utils.getMemorySourceText(rawContentText || displayContent || '') || '').trim();
                const comparable = String(
                    Utils.getNarrativeComparableText(memorySourceText || displayContent, 'ai')
                    || Utils.getMemorySourceText(memorySourceText || displayContent)
                    || ''
                ).trim();
                if (!displayContent && !comparable) return content;
                if (isManagedModuleHelperOutput([rawContentText, displayContent, memorySourceText, comparable].join('\n'))) {
                    if (MemoryEngine.CONFIG?.debug) {
                        recordRuntimeDebug('log', `[LIBRA] Main response output capture skipped: managed module helper output (${handlerPhase})`);
                    }
                    return content;
                }
                if (Utils.isTagOnlyToolResponse(comparable || memorySourceText || displayContent)) return content;
                let activeOrigin = null;
                let resolved = null;
                try {
                    resolved = await resolveActiveChatContext();
                    if (resolved?.chat) {
                        activeOrigin = previewManagedAfterRequestOriginForChat(resolved.chat)
                            || previewLatestNarrativeAfterRequestOriginForChat(resolved.chat)
                            || null;
                    }
                } catch (error) {
                    recordSuppressedRuntimeError('response_streaming.resolve_active_origin', error, {
                        phase: handlerPhase
                    });
                }
                if (!resolved?.chat) {
                    resolved = await resolveActiveChatContext();
                }
                const chat = resolved?.chat || null;
                if (!chat) return content;
                if (!activeOrigin) {
                    activeOrigin = previewManagedAfterRequestOriginForChat(chat)
                        || previewLatestNarrativeAfterRequestOriginForChat(chat)
                        || null;
                }
                if (activeOrigin?.chatId && String(activeOrigin.chatId || '').trim() !== String(chat?.id || '').trim()) return content;
                const recentTransport = getRecentMainResponseTransportHint(chat);
                const recentTransportMode = normalizeMainResponseTransportMode(recentTransport?.mode || activeOrigin?.responseTransportMode || '');
                const isEditOutputCapture = handlerPhase === 'editoutput';
                const isStreamingCapture = chat?.isStreaming === true;
                const isKnownStreamResponse = recentTransportMode === 'stream';
                const isKnownNonStreamResponse = recentTransportMode === 'nonstream';
                if (!isStreamingCapture && !isKnownStreamResponse && !isEditOutputCapture) return content;
                if (isKnownNonStreamResponse && !isStreamingCapture) return content;

                const latestAssistant = buildLatestAssistantSnapshot(chat, { includeStableId: true });
                rememberRecentMainResponseTransportHint(chat, {
                    mode: 'stream',
                    source: String(recentTransport?.source || handlerPhase || 'output-handler').trim(),
                    reliable: recentTransport?.reliable === true,
                    interceptorType: String(recentTransport?.interceptorType || '').trim().toLowerCase(),
                    observedAt: Date.now()
                });
                const capture = rememberRecentMainResponseOutputCapture(chat, {
                    rawResponseText: rawContentText,
                    displayContent,
                    memorySourceText,
                    comparable,
                    messageCount: latestAssistant.currentMessageCount,
                    latestMessageId: latestAssistant.latestStableId || latestAssistant.latestLiveId || '',
                    latestMessageSignature: latestAssistant.latestMessageSignature || '',
                    observedAt: Date.now(),
                    transportMode: 'stream',
                    source: isEditOutputCapture ? 'editoutput-handler' : 'output-handler',
                    requestSequence: Math.max(0, Number(activeOrigin?.requestSequence || 0)),
                    requestQueuedAt: Math.max(0, Number(activeOrigin?.queuedAt || 0)),
                    requestType: String(activeOrigin?.requestType || 'model').trim(),
                    originSnapshot: activeOrigin || null
                });
                if (capture) {
                    scheduleStreamOutputRecoveryCheck(chat, {
                        requestSequence: Math.max(0, Number(activeOrigin?.requestSequence || 0)),
                        requestQueuedAt: Math.max(0, Number(activeOrigin?.queuedAt || 0)),
                        targetContext: activeOrigin || null
                    });
                }
            } catch (captureError) {
                if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] Response streaming output capture failed:', captureError?.message || captureError);
                }
            }
            return content;
        };
        const drainOutputCapture = async () => {
            if (libraResponseOutputCaptureRunning) return;
            libraResponseOutputCaptureRunning = true;
            try {
                while (libraResponseOutputCapturePending) {
                    const pending = libraResponseOutputCapturePending;
                    libraResponseOutputCapturePending = null;
                    await captureMainResponseOutputContent(pending.content, pending.phase);
                }
            } catch (error) {
                recordSuppressedRuntimeError('response_streaming.detached_capture', error);
            } finally {
                libraResponseOutputCaptureRunning = false;
                if (libraResponseOutputCapturePending && !libraResponseOutputCaptureTimer) {
                    libraResponseOutputCaptureTimer = setTimeout(() => {
                        libraResponseOutputCaptureTimer = null;
                        void drainOutputCapture();
                    }, 0);
                }
            }
        };
        const scheduleOutputCapture = (content, phase = 'output') => {
            // Risu awaits output handlers for every streaming chunk. Never await
            // chat APIs, storage, embedding, or analysis on that hot path.
            libraResponseOutputCapturePending = { content, phase, observedAt: Date.now() };
            if (!libraResponseOutputCaptureTimer && !libraResponseOutputCaptureRunning) {
                libraResponseOutputCaptureTimer = setTimeout(() => {
                    libraResponseOutputCaptureTimer = null;
                    void drainOutputCapture();
                }, 0);
            }
        };
        const outputHandler = (content) => {
            try { scheduleOutputCapture(content, 'output'); } catch (_) {}
            return content;
        };
        let outputOk = false;
        try {
            outputOk = await RisuCompat.addScriptHandler('output', outputHandler);
            if (outputOk) libraResponseStreamingOutputHandler = outputHandler;
        } catch (handlerError) {
            if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA] Response streaming output handler unavailable:', handlerError?.message || handlerError);
        }
        if (!outputOk) {
            libraResponseStreamingOutputHandler = null;
            libraResponseStreamingEditOutputHandler = null;
            return false;
        }
        if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('log', `[LIBRA] Response streaming compatibility handler registered | output=${outputOk} | detachedCapture=true`);
        return true;
    };
    await ensureResponseStreamingCompatibilityHandlers();
