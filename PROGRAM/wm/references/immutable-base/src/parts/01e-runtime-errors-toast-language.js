    const recordRuntimeDebug = (level = 'debug', ...args) => DebugExportManager.record(level, ...args);
    const SUPPRESSED_ERROR_TURN_LIMIT = 2;
    const isSuppressedErrorTraceEnabled = () => {
        try { return MemoryEngine?.CONFIG?.debug === true; }
        catch (_) { return false; }
    };
    const clearSuppressedErrorStatsIfDisabled = () => {
        if (isSuppressedErrorTraceEnabled()) return false;
        try {
            if (MemoryState.suppressedErrorStatsByKey?.size) {
                MemoryState.suppressedErrorStatsByKey.clear();
                return true;
            }
        } catch (_) {}
        return false;
    };
    const getSuppressedErrorScopeKey = (context = {}) => String(
        context?.scopeKey
        || MemoryState?._activeScopeKey
        || MemoryState?._activeChatId
        || 'global'
    ).trim() || 'global';
    const getSuppressedErrorTurn = (context = {}) => {
        const candidates = [
            context?.turn,
            context?.currentTurn,
            context?.turnAnchorTurn,
            context?.finalizedTurn,
            (() => { try { return MemoryEngine?.getCurrentTurn?.(); } catch (_) { return 0; } })(),
            (() => { try { return MemoryState?.currentTurn; } catch (_) { return 0; } })()
        ];
        for (const item of candidates) {
            const n = Number(item);
            if (Number.isFinite(n) && n > 0) return Math.floor(n);
        }
        return 0;
    };
    const pruneSuppressedErrorStats = (scopeKey = '') => {
        const stats = MemoryState.suppressedErrorStatsByKey;
        if (!stats?.entries) return;
        const scope = String(scopeKey || 'global').trim() || 'global';
        const turns = Array.from(new Set(
            Array.from(stats.values())
                .filter(item => String(item?.scopeKey || 'global').trim() === scope)
                .map(item => Number(item?.turn || 0) || 0)
        )).sort((a, b) => a - b);
        if (turns.length <= SUPPRESSED_ERROR_TURN_LIMIT) return;
        const retained = new Set(turns.slice(-SUPPRESSED_ERROR_TURN_LIMIT));
        for (const [key, value] of Array.from(stats.entries())) {
            if (String(value?.scopeKey || 'global').trim() === scope && !retained.has(Number(value?.turn || 0) || 0)) {
                stats.delete(key);
            }
        }
    };
    const recordSuppressedRuntimeError = (label = 'unknown', error = null, context = {}) => {
        if (!isSuppressedErrorTraceEnabled()) {
            clearSuppressedErrorStatsIfDisabled();
            return null;
        }
        const normalizedLabel = String(label || 'unknown').trim() || 'unknown';
        const message = String(error?.message || error || 'unknown').trim().slice(0, 240) || 'unknown';
        try {
            const stats = MemoryState.suppressedErrorStatsByKey;
            if (stats?.set) {
                const now = Date.now();
                const scopeKey = getSuppressedErrorScopeKey(context);
                const turn = getSuppressedErrorTurn(context);
                const statKey = `${scopeKey}::${turn}::${normalizedLabel}`;
                const previous = stats.get(statKey) || {
                    label: normalizedLabel,
                    scopeKey,
                    turn,
                    count: 0,
                    firstAt: now,
                    lastAt: 0,
                    lastMessage: ''
                };
                stats.set(statKey, {
                    ...previous,
                    label: normalizedLabel,
                    scopeKey,
                    turn,
                    count: Number(previous.count || 0) + 1,
                    lastAt: now,
                    lastMessage: message
                });
                pruneSuppressedErrorStats(scopeKey);
            }
        } catch (_) {}
        try {
            recordRuntimeDebug('warn', `[LIBRA] Suppressed runtime error: ${normalizedLabel}`, message, {
                __libraDebugMeta: true,
                label: normalizedLabel,
                suppressed: true,
                ...(context && typeof context === 'object' ? context : {})
            });
        } catch (_) {}
        return null;
    };

    // Runtime toast notifications are DOM-only and never call showContainer()/hideContainer().
    // This restores external feedback such as LMAI_GUI.toast(...) without letting toast
    // cleanup hide the realtime Activity Dashboard or the settings overlay.
    const LibraToast = (() => {
        const ROOT_ID = 'libra-runtime-toast-root';
        const STYLE_ID = 'libra-runtime-toast-style';
        const nodes = new Map();
        const timers = new Map();
        const ensureStyle = () => {
            if (typeof document === 'undefined') return false;
            if (document.getElementById(STYLE_ID)) return true;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = [
                `#${ROOT_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:grid;gap:8px;max-width:min(360px,calc(100vw - 36px));pointer-events:none;font-family:var(--risu-font-family,'Segoe UI',Inter,system-ui,sans-serif)}`,
                `#${ROOT_ID} .libra-toast{pointer-events:auto;border:1px solid rgba(148,163,184,.28);border-radius:10px;background:rgba(15,23,42,.96);color:#e5f0ff;box-shadow:0 14px 36px rgba(0,0,0,.32);padding:10px 12px;font-size:12px;font-weight:750;line-height:1.38;word-break:keep-all;overflow-wrap:anywhere;animation:libra-toast-in .14s ease-out}`,
                `@keyframes libra-toast-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}`
            ].join('\n');
            (document.head || document.body)?.appendChild(style);
            return true;
        };
        const ensureRoot = () => {
            if (typeof document === 'undefined' || !document.body) return null;
            ensureStyle();
            let root = document.getElementById(ROOT_ID);
            if (!root) {
                root = document.createElement('div');
                root.id = ROOT_ID;
                document.body.appendChild(root);
            }
            return root;
        };
        const removeNode = (key = '') => {
            const normalized = String(key || '').trim();
            if (!normalized) return false;
            const timer = timers.get(normalized);
            if (timer) {
                try { clearTimeout(timer); } catch (_) {}
                timers.delete(normalized);
            }
            const node = nodes.get(normalized);
            if (node?.parentNode) node.remove();
            nodes.delete(normalized);
            return true;
        };
        const notify = async (message = '', options = {}) => {
            const body = String(message || '').trim();
            if (!body) return false;
            const root = ensureRoot();
            if (!root) return false;
            const key = String(options?.key || `toast:${stableHash(body)}`).trim().slice(0, 120);
            removeNode(key);
            const node = document.createElement('div');
            node.className = 'libra-toast';
            node.textContent = body;
            nodes.set(key, node);
            root.appendChild(node);
            const duration = Math.max(800, Math.min(12000, Number(options?.duration || 2200) || 2200));
            const timer = setTimeout(() => removeNode(key), duration);
            timers.set(key, timer);
            return true;
        };
        const sequence = (messages = [], options = {}) => {
            const list = (Array.isArray(messages) ? messages : [messages]).map(item => String(item || '').trim()).filter(Boolean);
            if (!list.length) return false;
            const keyPrefix = String(options?.keyPrefix || `seq:${Date.now()}`).trim();
            const gap = Math.max(0, Number(options?.gap || 800) || 0);
            list.forEach((item, index) => {
                const scheduledKey = `${keyPrefix}:scheduled:${index}`;
                const scheduledTimer = setTimeout(() => {
                    timers.delete(scheduledKey);
                    void notify(item, {
                        ...options,
                        key: `${keyPrefix}:${index}:${stableHash(item)}`
                    });
                }, index * gap);
                timers.set(scheduledKey, scheduledTimer);
            });
            return true;
        };
        const cleanup = async () => {
            try {
                for (const timer of timers.values()) { try { clearTimeout(timer); } catch (_) {} }
                timers.clear();
                nodes.clear();
                if (typeof document !== 'undefined') {
                    document.getElementById(ROOT_ID)?.remove();
                    document.getElementById(STYLE_ID)?.remove();
                }
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA Toast] cleanup failed:', e?.message || e);
            }
            return true;
        };
        return Object.freeze({ notify, sequence, cleanup });
    })();
    const notifyLibraTask = (message, options = {}) => LibraToast.notify(message, options);

    const normalizeInternalDataLanguageTarget = (value = '') => {
        const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
        if (!raw) return '';
        if (['ko', 'kr', 'kor', 'korean', '한국어', '한글'].includes(raw)) return 'Korean';
        if (['en', 'eng', 'english', '영어', '영문', 'en-us', 'en-gb'].includes(raw)) return 'English';
        if (['ja', 'jp', 'jpn', 'japanese', '日本語', '일본어', 'ja-jp'].includes(raw)) return 'Japanese';
        if (['zh', 'zho', 'chi', 'chinese', '中文', '중국어', 'zh-cn', 'zh-tw'].includes(raw)) return 'Chinese';
        return '';
    };

    const detectMainResponseLanguageTarget = (value = '') => {
        const text = String(value || '').replace(/<[^>]+>|```[\s\S]*?```/g, ' ').slice(0, 12000);
        const count = (re) => (text.match(re) || []).length;
        const hangul = count(/[가-힣]/g);
        const kana = count(/[ぁ-ゟ゠-ヿ]/g);
        const han = count(/[一-龯㐀-䶿]/g);
        const latin = count(/[A-Za-z]/g);
        if (hangul >= 4 && hangul >= kana * 2) return 'Korean';
        if (kana >= 2) return 'Japanese';
        if (han >= 4 && kana === 0 && hangul === 0) return 'Chinese';
        if (latin >= 8) return 'English';
        return '';
    };

