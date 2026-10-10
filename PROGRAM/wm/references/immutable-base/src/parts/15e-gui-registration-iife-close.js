// GUI 등록
(async () => {
    const R = RisuCompat.host('registerSetting') || RisuCompat.host('registerButton') || RisuCompat.api();
    if (R) {
        try {
            await R.registerSetting('LIBRA World Manager', LMAI_GUI.show, '📚', 'html', 'lmai-settings');
            await R.registerButton({
                name: 'LIBRA',
                icon: '📚',
                iconType: 'html',
                location: 'chat',
                id: LIBRA_LAUNCHER_BUTTON_ID
            }, LMAI_GUI.show);
            if (typeof R.onUnload === 'function') {
                await R.onUnload(async () => {
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
