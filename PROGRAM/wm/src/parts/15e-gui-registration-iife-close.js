// Register only the WM handoff allowlist after every cold/raw/runtime manager exists.
// The trusted registration hook owns authenticated IPC sender verification. No
// storage/router/provider/journal object or runtime global is handed to RETRACE.
if (runtimeMode === 'live') {
    try {
        const handoff = environment.storageRouter && environment.storageInventory ? WmRetraceHandoff.createWmRetraceHandoff({
            router: environment.storageRouter,
            inventory: environment.storageInventory,
            hostGate: WmHostGate,
            journal: environment.storageHandoffJournal || WmRetraceHandoff.createWmHandoffJournal({storage:RisuCompat.pluginStorage}),
            rescopeEntries: (entries, sourceIdentity, targetIdentity) => LibraDataStorage.rescopeEntriesIntegrity(entries, targetIdentity.scope, targetIdentity.chatId).entries
        }) : Object.freeze({
            capabilities:()=>({schema:'wm.handoff-materialized.v1',owner:'wm',pluginId:'libra_world_manager',sourceImmutable:true,materialized:true,durableReadback:true,idempotent:true,modes:[],limits:{}}),
            ...Object.fromEntries(WmRetraceHandoff.METHODS.filter(name=>name !== 'capabilities').map(name=>[name,async()=>({ok:false,reason:'wm_scope_materializer_unavailable'})]))
        });
        const methods = Object.freeze(Object.fromEntries(WmRetraceHandoff.METHODS.map(name => [name, handoff[name]])));
        const readStorageStatus = async (input = {}) => {
            if (!environment.storageRouter) return {schema:'wm.handoff-storage-status.v1',ready:false,mode:'plugin_only',route:null,sourceReady:false,sourceIdentity:null,sourceHead:null,reason:'wm_scope_materializer_unavailable',qualification:{supported:false,reason:'native_host_unqualified'}};
            const route = await environment.storageRouter.readMigrationRoute();
            const qualification = WmHostGate.inspect();
            const cap = handoff.capabilities();
            const status = {schema:'wm.handoff-storage-status.v1',route,mode:route.mode,
                ready:qualification.supported === true && cap.modes.includes(route.mode) && route.state === 'active',
                qualification:{supported:qualification.supported === true,reason:qualification.reason || ''},
                sourceReady:false,sourceIdentity:null,sourceHead:null,reason:qualification.reason || ''};
            if (input.includeSource !== true || !status.ready) return status;
            // Read host identity directly. resolveActiveChatContext can initialize a
            // persona or bootstrap memory; a capability query must never do that.
            const char = await RisuCompat.getCharacter();
            const index = normalizeRisuIndex(await RisuCompat.getCurrentChatIndex());
            const chat = char?.chats?.[index >= 0 ? index : normalizeRisuIndex(char?.chatPage)];
            const proof = PersonaScopeIdentity.get(char, chat);
            if (!proof) return {...status,reason:'wm_source_identity_unavailable'};
            const sourceIdentity = {scope:`char:${proof.characterId}|chat:${proof.chatId}|persona:${proof.personaId}`,
                characterId:proof.characterId,chatId:proof.chatId,personaId:proof.personaId,resetGeneration:proof.resetGeneration};
            const handle = await environment.storageRouter.openRequest();
            if (!handle) return {...status,reason:'wm_source_route_unavailable'};
            try {
                const read = await environment.storageRouter.readCanonical({handle,scope:sourceIdentity.scope});
                if (read?.ok !== true || !WmHandoffReceipt.head(read.head)) return {...status,reason:'wm_genuine_source_head_unavailable'};
                const canonical = read.raw === null ? null : JSON.parse(read.raw);
                if (canonical && (!Number.isSafeInteger(canonical.resetGeneration || 0) || canonical.scopeKey !== sourceIdentity.scope)) return {...status,reason:'wm_source_provenance_unavailable'};
                sourceIdentity.resetGeneration = canonical?.resetGeneration || 0;
                const freshRoute = await environment.storageRouter.readMigrationRoute();
                if (!WmHandoffReceipt.same(route, freshRoute)) return {...status,reason:'wm_source_route_changed'};
                return {...status,sourceReady:true,sourceIdentity,sourceHead:read.head,reason:''};
            } finally { await environment.storageRouter.closeRequest(handle); }
        };
        const registration = typeof environment.registerWmHandoff === 'function'
            ? await environment.registerWmHandoff({owner:'wm',pluginId:'libra_world_manager',schema:'wm.handoff-materialized.v1',methods,readStorageStatus})
            : await WmHandoffIpc.register({api:RisuCompat.host('addPluginChannelListener'),methods,readStorageStatus});
        if (typeof registration === 'function') runtimeDisposers.push(registration);
        else if (typeof registration?.dispose === 'function') runtimeDisposers.push(() => registration.dispose());
    } catch (e) {
        recordRuntimeDebug('warn', '[LIBRA] Materialized handoff unavailable:', e?.message || 'handoff_registration_failed');
    }
}

// GUI 등록
(async () => {
    const R = RisuCompat.host('registerSetting') || RisuCompat.host('registerButton') || RisuCompat.api();
    if (R) {
        try {
            const settingPart = await R.registerSetting('LIBRA World Manager', LMAI_GUI.show, '📚', 'html', 'lmai-settings');
            const buttonPart = await R.registerButton({
                name: 'LIBRA',
                icon: '📚',
                iconType: 'html',
                location: 'chat',
                id: LIBRA_LAUNCHER_BUTTON_ID
            }, LMAI_GUI.show);
            if (typeof R.onUnload === 'function') {
                await R.onUnload(async () => {
                    LMAI_GUI.disposeStoragePanels();
                    for (const [kind, part, fallbackId] of [['setting', settingPart, 'lmai-settings'], ['button', buttonPart, LIBRA_LAUNCHER_BUTTON_ID]]) {
                        try {
                            if (typeof part === 'function') { await part(); continue; }
                            const dispose = ['dispose', 'unsubscribe', 'remove'].find(method => typeof part?.[method] === 'function');
                            if (dispose) { await part[dispose](); continue; }
                            const id = part?.id || (typeof part === 'string' || typeof part === 'number' ? part : fallbackId);
                            if (typeof R.unregisterUIPart === 'function') await R.unregisterUIPart(id);
                            else if (typeof R[kind === 'setting' ? 'unregisterSetting' : 'unregisterButton'] === 'function') await R[kind === 'setting' ? 'unregisterSetting' : 'unregisterButton'](id);
                        } catch {}
                    }
                    try { unbindUiInteractionGuards(); } catch {}
                    try { await LibraToast.cleanup(); } catch {}
                });
            }
            recordRuntimeDebug('log', '[LIBRA] GUI registered.');
        } catch (e) {
            recordRuntimeDebug('warn', '[LIBRA] GUI registration failed:', e?.message || e);
        }
    }
})();


// Runtime internals are not exported; use the visible recent-turn debug export from the GUI.
if (typeof globalThis !== 'undefined') {
    try { delete globalThis.LIBRA; } catch {}
    try { delete globalThis.LIBRA_DEV; } catch {}
}

})();
