    // ══════════════════════════════════════════════════════════════
    // [CORE] Error Handler
    // ══════════════════════════════════════════════════════════════
    class LIBRAError extends Error {
        constructor(message, code, cause = null) {
            super(message);
            this.name = 'LIBRAError';
            this.code = code;
            this.cause = cause;
            this.timestamp = Date.now();
        }
    }

    const RisuCompat = (() => {
        const candidates = () => {
            const list = [];
            const push = (value) => {
                if (value && typeof value === 'object' && !list.includes(value)) list.push(value);
            };
            try {
                if (typeof risuai !== 'undefined') push(risuai);
            } catch (_) {}
            try {
                if (typeof Risuai !== 'undefined') push(Risuai);
            } catch (_) {}
            try {
                if (typeof globalThis !== 'undefined') {
                    push(globalThis.risuai);
                    push(globalThis.Risuai);
                }
            } catch (_) {}
            return list;
        };
        const api = () => candidates()[0] || null;
        const host = (name) => candidates().find(candidate => typeof candidate?.[name] === 'function') || api();
        const storageHost = () => candidates().find(candidate => candidate?.pluginStorage) || api();
        const has = (name) => typeof host(name)?.[name] === 'function';
        const isProbablyLocalNetworkUrl = (url) => {
            try {
                const host = new URL(String(url || '')).hostname.toLowerCase();
                return host === 'localhost'
                    || host === '127.0.0.1'
                    || host === '0.0.0.0'
                    || host === '::1'
                    || host.endsWith('.local')
                    || host.startsWith('192.168.')
                    || host.startsWith('10.')
                    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
                    || /^[a-z0-9_-]+$/i.test(host);
            } catch (_) {
                return false;
            }
        };
        const detectCompat = async () => {
            const runtimeApi = api();
            let runtime = null;
            try {
                if (typeof runtimeApi?.getRuntimeInfo === 'function') runtime = await runtimeApi.getRuntimeInfo();
            } catch (_) { runtime = null; }
            return {
                runtime,
                apiVersion: runtimeApi?.apiVersion ?? runtime?.apiVersion ?? 'unknown',
                platform: runtime?.platform ?? 'unknown',
                saveMethod: runtime?.saveMethod ?? 'unknown',
                hasPluginStorage: !!storageHost()?.pluginStorage,
                hasSafeLocalStorage: !!(candidates().find(candidate => candidate?.safeLocalStorage)?.safeLocalStorage),
                hasLocalPluginStorage: typeof host('getLocalPluginStorage')?.getLocalPluginStorage === 'function',
                hasNativeFetch: typeof host('nativeFetch')?.nativeFetch === 'function',
                hasDatabase: typeof host('getDatabase')?.getDatabase === 'function',
                hasReplacer: typeof host('addRisuReplacer')?.addRisuReplacer === 'function',
                hasPermissionApi: typeof host('requestPluginPermission')?.requestPluginPermission === 'function'
            };
        };
        const normalizeNetworkError = (error, url) => {
            const message = String(error?.message || error || 'network request failed').trim();
            const code = error?.code || (message === 'API Request timed out' ? 'TIMEOUT' : 'NETWORK_ERROR');
            if (isProbablyLocalNetworkUrl(url)) {
                return new LIBRAError(
                    `API Request failed: direct localhost/LAN access may be blocked in Web Risu. In PocketRisu, Node Risu, or Local Risu, prefer nativeFetch local_network routing or the host proxy path when available; otherwise use a tunnel or a reachable HTTPS endpoint. Original error: ${message}`,
                    code,
                    error
                );
            }
            return error instanceof LIBRAError ? error : new LIBRAError(`API Request failed: ${message}`, code, error);
        };
        const request = async (url, init = {}, options = {}) => {
            const runtime = host('nativeFetch');
            const timeoutMs = Math.max(1000, Number(options.timeoutMs || init.requestTimeoutMs || 120000) || 120000);
            const requestInit = {
                ...init,
                requestTimeoutMs: timeoutMs
            };
            if (isProbablyLocalNetworkUrl(url) && !requestInit.networkRoute) {
                requestInit.networkRoute = 'local_network';
            }
            let abortTimer = null;
            let ownedTimeoutError = null;
            let timeoutTimer = null;
            let externalAbort = null;
            const externalSignal = requestInit.signal;
            if (typeof AbortController === 'function') {
                const controller = new AbortController();
                requestInit.signal = controller.signal;
                externalAbort = () => {
                    try { controller.abort(externalSignal?.reason || new DOMException('Aborted', 'AbortError')); }
                    catch (_) { try { controller.abort(); } catch (_) {} }
                };
                if (externalSignal?.aborted) externalAbort();
                else externalSignal?.addEventListener?.('abort', externalAbort, { once: true });
                abortTimer = setTimeout(() => {
                    const timeoutError = new LIBRAError('API Request timed out', 'TIMEOUT');
                    if (!controller.signal.aborted) ownedTimeoutError = timeoutError;
                    try { controller.abort(timeoutError); }
                    catch (_) { try { controller.abort(); } catch (_) {} }
                }, timeoutMs);
            }

            const fetchPromise = (async () => {
                if (typeof runtime?.nativeFetch === 'function') return await runtime.nativeFetch(url, requestInit);
                if (typeof fetch === 'function') return await fetch(url, requestInit);
                throw new LIBRAError('No compatible fetch API available', 'FETCH_UNAVAILABLE');
            })();
            if (typeof options.onPhysical === "function") options.onPhysical(fetchPromise);
            const timeoutPromise = new Promise((_, reject) => {
                timeoutTimer = setTimeout(() => reject(new LIBRAError('API Request timed out', 'TIMEOUT')), timeoutMs);
            });

            try {
                return await Promise.race([fetchPromise, timeoutPromise]);
            } catch (error) {
                const ownedTimeout = ownedTimeoutError && requestInit.signal?.aborted && requestInit.signal.reason === ownedTimeoutError;
                throw normalizeNetworkError(ownedTimeout ? ownedTimeoutError : error, url);
            } finally {
                if (abortTimer != null && typeof clearTimeout === 'function') clearTimeout(abortTimer);
                if (timeoutTimer != null && typeof clearTimeout === 'function') clearTimeout(timeoutTimer);
                externalSignal?.removeEventListener?.('abort', externalAbort);
            }
        };
        const COMPAT_CHUNK_SENTINEL = '__libraChunkedStorageV1';
        const COMPAT_CHUNK_SIZE = 512 * 1024;
        // Chunk generations must never alias an earlier write, including after a
        // reload in the same clock tick. Keep the v1 manifest/read format.
        const compatChunkRuntimeNonce = typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        let compatChunkWriteSequence = 0;
        const compatDiagnostics = {
            createdAt: Date.now(),
            permissions: Object.create(null),
            replacers: Object.create(null),
            database: { lastPermission: 'not_requested', lastAccessAt: 0, lastError: '' },
            storage: { chunkedWrites: 0, lastChunkedKey: '', lastError: '' }
        };
        const replacerWrappedHandlers = new Map();
        const permissionCache = new Map();
        const normalizePermissionResult = (value) => value === null ? null : !!value;
        const setPermissionStatus = (name, value) => {
            const status = value === null ? 'unavailable' : value ? 'granted' : 'denied';
            compatDiagnostics.permissions[name] = { status, value, at: Date.now() };
            return value;
        };
        const ensurePermission = async (name, options = {}) => {
            const permission = String(name || '').trim();
            if (!permission) return false;
            const useCache = options.cache !== false;
            if (useCache && permissionCache.has(permission)) return permissionCache.get(permission);
            const runtime = host('requestPluginPermission');
            if (typeof runtime?.requestPluginPermission !== 'function') {
                const result = setPermissionStatus(permission, null);
                if (useCache) permissionCache.set(permission, result);
                return result;
            }
            try {
                const result = normalizePermissionResult(await runtime.requestPluginPermission(permission));
                setPermissionStatus(permission, result);
                if (useCache) permissionCache.set(permission, result);
                return result;
            } catch (error) {
                compatDiagnostics.permissions[permission] = { status: 'error', value: false, at: Date.now(), error: error?.message || String(error || '') };
                if (useCache) permissionCache.set(permission, false);
                return false;
            }
        };
        const getCompatStorageRuntime = () => storageHost();
        const parseCompatChunkManifest = raw => {
            if (typeof raw !== 'string' || !raw.includes(COMPAT_CHUNK_SENTINEL)) return null;
            try {
                const parsed = JSON.parse(raw);
                return parsed?.[COMPAT_CHUNK_SENTINEL] === true ? parsed : null;
            } catch (_) { return null; }
        };
        const validCompatChunkManifest = (manifest, key) => {
            if (manifest?.[COMPAT_CHUNK_SENTINEL] !== true || manifest.schemaVersion !== 1
                || manifest.key !== String(key) || !Number.isSafeInteger(manifest.length)
                || manifest.length <= COMPAT_CHUNK_SIZE || !Array.isArray(manifest.chunks)
                || manifest.chunks.length !== Math.ceil(manifest.length / COMPAT_CHUNK_SIZE)
                || new Set(manifest.chunks).size !== manifest.chunks.length) return false;
            const prefix = `${String(key)}::chunk:v1:`;
            const first = manifest.chunks[0];
            if (typeof first !== 'string' || !first.startsWith(prefix) || !first.endsWith(':0000')) return false;
            const stamp = first.slice(prefix.length, -5);
            // Historical timestamp/random and runtime-nonce generations contain
            // no colon. A generation must not absorb another root/chunk prefix.
            if (!stamp || stamp.includes(':')) return false;
            return manifest.chunks.every((chunkKey, index) =>
                typeof chunkKey === 'string' && chunkKey === `${prefix}${stamp}:${String(index).padStart(4, '0')}`);
        };
        const sameCompatStorageRoot = (actual, expected) => actual === expected || (actual == null && expected == null);
        const removePluginStorageItem = async (runtime, key) => {
            if (typeof runtime?.pluginStorage?.removeItem !== 'function'
                || typeof runtime?.pluginStorage?.getItem !== 'function') return false;
            if (await runtime.pluginStorage.removeItem(key) === false) return false;
            return (await runtime.pluginStorage.getItem(key)) == null;
        };
        const cleanupCompatOwnedChunkKeys = async (runtime, key, chunks, expectedRoot) => {
            try {
                for (const chunkKey of chunks) {
                    // This observation reduces known races; it is not host CAS
                    // and does not pin readers in another runtime.
                    if (!sameCompatStorageRoot(await runtime.pluginStorage.getItem(key), expectedRoot)) return false;
                    if (!await removePluginStorageItem(runtime, chunkKey)) return false;
                }
                return sameCompatStorageRoot(await runtime.pluginStorage.getItem(key), expectedRoot);
            } catch (_) { return false; }
        };
        const tryCleanupChunkedStorage = async (runtime, key, manifest, expectedRoot) => {
            if (!validCompatChunkManifest(manifest, key)) return false;
            return cleanupCompatOwnedChunkKeys(runtime, key, manifest.chunks, expectedRoot);
        };
        const pluginStorage = {
            // Closure-local route identity only; never a storage revision/currentness proof.
            readRouteIdentity() {
                const storage = getCompatStorageRuntime()?.pluginStorage;
                // Accessor-backed/ad-hoc methods keep the original uncached route.
                let current = storage;
                for (let depth = 0; current && depth < 16; depth++, current = Object.getPrototypeOf(current)) {
                    const descriptor = Object.getOwnPropertyDescriptor(current, 'getItem');
                    if (descriptor) return typeof descriptor.value === 'function' ? { storage, getItem: descriptor.value } : null;
                }
                return null;
            },
            async inventoryPhysicalKeys(key) {
                const runtime = getCompatStorageRuntime();
                if (typeof runtime?.pluginStorage?.getItem !== 'function') throw new Error('storage_read_unavailable');
                try {
                    const raw = await runtime.pluginStorage.getItem(key);
                    const manifest = parseCompatChunkManifest(raw);
                    if (!manifest) return [];
                    if (!validCompatChunkManifest(manifest, key)) throw new Error('storage_read_invalid_manifest');
                    return manifest.chunks.slice();
                } catch (_) { throw new Error('storage_read_failed'); }
            },
            // Read-only inventory enumeration. The host may allocate its complete
            // key array before returning; consumers must negotiate that cost.
            async keys(options = {}) {
                const runtime = getCompatStorageRuntime();
                try {
                    if (typeof runtime?.pluginStorage?.keys !== 'function') throw new Error('storage_keys_unavailable');
                    const result = await runtime.pluginStorage.keys();
                    if (!Array.isArray(result) || result.some(key => typeof key !== 'string')) throw new Error('storage_keys_invalid');
                    return result.slice();
                } catch (_) {
                    if (options.strict === true) throw new Error('storage_keys_failed');
                    return null;
                }
            },
            async getItem(key, options = {}) {
                const runtime = getCompatStorageRuntime();
                if (typeof runtime?.pluginStorage?.getItem !== 'function') {
                    if (options.strict === true) throw new Error('storage_read_unavailable');
                    return null;
                }
                try {
                    const raw = await runtime.pluginStorage.getItem(key);
                    const manifest = parseCompatChunkManifest(raw);
                    if (!manifest) return raw;
                    if (!validCompatChunkManifest(manifest, key)) throw new Error('storage_read_invalid_manifest');
                    const parts = [];
                    for (let i = 0; i < manifest.chunks.length; i += 1) {
                        const part = await runtime.pluginStorage.getItem(manifest.chunks[i]);
                        if (typeof part !== 'string') throw new Error('storage_read_incomplete_chunk');
                        if (part.length !== Math.min(COMPAT_CHUNK_SIZE, manifest.length - i * COMPAT_CHUNK_SIZE)) {
                            throw new Error('storage_read_invalid_chunk_length');
                        }
                        parts.push(part);
                    }
                    const joined = parts.join('');
                    if (joined.length !== manifest.length) throw new Error('storage_read_invalid_manifest');
                    return joined;
                } catch (error) {
                    compatDiagnostics.storage.lastError = error?.message || String(error || '');
                    if (options.strict === true) throw new Error('storage_read_failed');
                    return null;
                }
            },
            async setItem(key, value, options = {}) {
                const runtime = getCompatStorageRuntime();
                if (typeof runtime?.pluginStorage?.setItem !== 'function') return false;
                const stringValue = String(value ?? '');
                let rootWriteIssued = false;
                let previous = null, previousRead = false;
                const stagedChunkKeys = [];
                try {
                    previous = await runtime.pluginStorage.getItem(key);
                    previousRead = true;
                    const previousManifest = parseCompatChunkManifest(previous);
                    // A corrupt root needs explicit recovery, not a destructive
                    // replacement that follows untrusted chunk references.
                    if (previousManifest && !validCompatChunkManifest(previousManifest, key)) {
                        throw new Error('storage_set_invalid_manifest');
                    }
                    if (stringValue.length <= COMPAT_CHUNK_SIZE) {
                        rootWriteIssued = true;
                        if (await runtime.pluginStorage.setItem(key, stringValue) === false) {
                            throw new Error('storage_set_failed');
                        }
                        if (await runtime.pluginStorage.getItem(key) !== stringValue) throw new Error('storage_set_readback_mismatch');
                        if (previousManifest && !await tryCleanupChunkedStorage(runtime, key, previousManifest, stringValue)) {
                            compatDiagnostics.storage.lastError = 'storage_cleanup_unverified';
                        }
                        return true;
                    }
                    const chunkCount = Math.ceil(stringValue.length / COMPAT_CHUNK_SIZE);
                    const chunks = stagedChunkKeys;
                    const stamp = `${Date.now().toString(36)}-${compatChunkRuntimeNonce}-${++compatChunkWriteSequence}`;
                    for (let i = 0; i < chunkCount; i += 1) {
                        const chunkKey = `${key}::chunk:v1:${stamp}:${String(i).padStart(4, '0')}`;
                        chunks.push(chunkKey);
                        const chunkValue = stringValue.slice(i * COMPAT_CHUNK_SIZE, (i + 1) * COMPAT_CHUNK_SIZE);
                        if (await runtime.pluginStorage.setItem(chunkKey, chunkValue) === false) throw new Error('storage_chunk_set_failed');
                        if (await runtime.pluginStorage.getItem(chunkKey) !== chunkValue) throw new Error('storage_chunk_readback_mismatch');
                    }
                    const manifest = {
                        [COMPAT_CHUNK_SENTINEL]: true,
                        schemaVersion: 1,
                        key: String(key || ''),
                        chunks,
                        length: stringValue.length,
                        updatedAt: Date.now()
                    };
                    const manifestValue = JSON.stringify(manifest);
                    rootWriteIssued = true;
                    if (await runtime.pluginStorage.setItem(key, manifestValue) === false) {
                        throw new Error('storage_manifest_set_failed');
                    }
                    if (await runtime.pluginStorage.getItem(key) !== manifestValue) throw new Error('storage_manifest_readback_mismatch');
                    if (previousManifest && !await tryCleanupChunkedStorage(runtime, key, previousManifest, manifestValue)) {
                        compatDiagnostics.storage.lastError = 'storage_cleanup_unverified';
                    }
                    compatDiagnostics.storage.chunkedWrites += 1;
                    compatDiagnostics.storage.lastChunkedKey = String(key || '');
                    return true;
                } catch (error) {
                    // Only keys generated by this attempt are eligible. An issued
                    // root may reference them despite a false/throw/lost readback.
                    if (!rootWriteIssued && previousRead && stagedChunkKeys.length
                        && !await cleanupCompatOwnedChunkKeys(runtime, key, stagedChunkKeys, previous)) {
                        compatDiagnostics.storage.lastCleanupError = 'storage_staging_cleanup_unverified';
                    }
                    compatDiagnostics.storage.lastError = error?.message || String(error || '');
                    if (options.strict === true) {
                        // Preserve the uncertainty boundary for transactional
                        // callers. Failed staged chunks never published the root;
                        // an issued root may exist despite a lost ack/readback.
                        const failure = new Error(compatDiagnostics.storage.lastError || 'storage_set_failed');
                        failure.storageWriteUnverified = rootWriteIssued;
                        failure.cause = error;
                        throw failure;
                    }
                    return false;
                }
            },
            async removeItem(key) {
                const runtime = getCompatStorageRuntime();
                if (typeof runtime?.pluginStorage?.getItem !== 'function') return false;
                try {
                    const raw = await runtime.pluginStorage.getItem(key);
                    const manifest = parseCompatChunkManifest(raw);
                    if (manifest && !validCompatChunkManifest(manifest, key)) throw new Error('storage_remove_invalid_manifest');
                    if (!sameCompatStorageRoot(await runtime.pluginStorage.getItem(key), raw)) {
                        throw new Error('storage_remove_root_changed');
                    }
                    // Keep referenced chunks until physical root absence is
                    // confirmed. False, throw and ambiguous readback preserve them.
                    if (!await removePluginStorageItem(runtime, key)) throw new Error('storage_remove_unverified');
                    if (manifest && !await tryCleanupChunkedStorage(runtime, key, manifest, null)) {
                        throw new Error('storage_cleanup_unverified');
                    }
                    return true;
                } catch (error) {
                    compatDiagnostics.storage.lastError = error?.message || String(error || '');
                    return false;
                }
            }
        };
        const safeLocalStorage = {
            async getItem(key) {
                const runtime = candidates().find(candidate => candidate?.safeLocalStorage) || api();
                if (typeof runtime?.safeLocalStorage?.getItem !== 'function') return null;
                try { return await runtime.safeLocalStorage.getItem(key); } catch (_) { return null; }
            },
            async setItem(key, value) {
                const runtime = candidates().find(candidate => candidate?.safeLocalStorage) || api();
                if (typeof runtime?.safeLocalStorage?.setItem !== 'function') return false;
                try { await runtime.safeLocalStorage.setItem(key, String(value ?? '')); return true; } catch (_) { return false; }
            },
            async removeItem(key) {
                const runtime = candidates().find(candidate => candidate?.safeLocalStorage) || api();
                if (typeof runtime?.safeLocalStorage?.removeItem !== 'function') return false;
                try { await runtime.safeLocalStorage.removeItem(key); return true; } catch (_) { return false; }
            }
        };
        const localPluginStorage = {
            async getStore(options = {}) {
                const runtime = host('getLocalPluginStorage');
                try {
                    if (typeof runtime?.getLocalPluginStorage !== 'function') {
                        if (options.strict === true) throw new Error('local_storage_unavailable');
                        return null;
                    }
                    const store = await runtime.getLocalPluginStorage();
                    if (!store && options.strict === true) throw new Error('local_storage_unavailable');
                    return store;
                } catch (_) {
                    if (options.strict === true) throw new Error('local_storage_unavailable');
                    return null;
                }
            },
            async keys(options = {}) {
                try {
                    const store = await this.getStore(options);
                    if (!store) throw new Error('local_storage_unavailable');
                    let result;
                    if (typeof store.keys === 'function') result = Array.from(await store.keys());
                    else if (Object.getPrototypeOf(store) === Object.prototype || Object.getPrototypeOf(store) === null) {
                        // Plain-object fallback is only a complete data store without
                        // methods. Ad-hoc object wrappers cannot prove enumeration.
                        if (Object.values(store).some(value => typeof value === 'function')) throw new Error('local_storage_keys_unavailable');
                        result = Object.keys(store);
                    } else throw new Error('local_storage_keys_unavailable');
                    if (result.some(key => typeof key !== 'string')) throw new Error('local_storage_keys_invalid');
                    return result;
                } catch (_) {
                    if (options.strict === true) throw new Error('local_storage_keys_failed');
                    return null;
                }
            },
            async getItem(key, options = {}) {
                try {
                    const store = await this.getStore(options);
                    if (!store) {
                        if (options.strict === true) throw new Error('local_storage_unavailable');
                        return null;
                    }
                    if (typeof store.getItem === 'function') return await store.getItem(key);
                    if (typeof store.get === 'function') return await store.get(key);
                    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
                } catch (_) {
                    if (options.strict === true) throw new Error('local_storage_read_failed');
                    return null;
                }
            },
            async setItem(key, value) {
                const store = await this.getStore();
                if (!store) return false;
                try {
                    if (typeof store.setItem === 'function') { await store.setItem(key, value); return true; }
                    if (typeof store.set === 'function') { await store.set(key, value); return true; }
                    store[key] = value;
                    return true;
                } catch (_) { return false; }
            },
            async removeItem(key) {
                const store = await this.getStore();
                if (!store) return false;
                try {
                    if (typeof store.removeItem === 'function') { await store.removeItem(key); return true; }
                    if (typeof store.delete === 'function') return store.delete(key) !== false;
                    if (Object.prototype.hasOwnProperty.call(store, key)) delete store[key];
                    return true;
                } catch (_) { return false; }
            }
        };
        const database = {
            async get(keys) {
                const runtime = host('getDatabase');
                if (typeof runtime?.getDatabase !== 'function') return null;
                const granted = await ensurePermission('db');
                compatDiagnostics.database.lastPermission = granted === null ? 'unavailable' : granted ? 'granted' : 'denied';
                compatDiagnostics.database.lastAccessAt = Date.now();
                if (granted === false) return null;
                try {
                    return await runtime.getDatabase(keys);
                } catch (error) {
                    compatDiagnostics.database.lastError = error?.message || String(error || '');
                    return null;
                }
            }
        };
        const failOpenValueForReplacer = (type, args) => {
            const first = args?.[0];
            const normalizedType = String(type || '').trim().toLowerCase();
            if (normalizedType === 'beforerequest') return first;
            if (normalizedType === 'afterrequest') return first;
            return first;
        };
        const wrapReplacerHandler = (type, handler) => {
            const normalizedType = String(type || 'unknown').trim() || 'unknown';
            const state = compatDiagnostics.replacers[normalizedType] || (compatDiagnostics.replacers[normalizedType] = {
                registered: false,
                lastRunAt: 0,
                runCount: 0,
                lastError: ''
            });
            return async (...args) => {
                state.lastRunAt = Date.now();
                state.runCount = Number(state.runCount || 0) + 1;
                try {
                    return await handler(...args);
                } catch (error) {
                    state.lastError = error?.message || String(error || '');
                    return failOpenValueForReplacer(normalizedType, args);
                }
            };
        };
        return Object.freeze({
            api,
            host,
            has,
            request,
            pluginStorage,
            safeLocalStorage,
            localPluginStorage,
            database,
            ensurePermission,
            detectCompat,
            async getRuntimeInfo() { return await detectCompat(); },
            getDiagnostics() { try { return typeof safeClone === 'function' ? safeClone(compatDiagnostics) : JSON.parse(JSON.stringify(compatDiagnostics)); } catch (_) { return { available: true }; } },
            isProbablyLocalNetworkUrl,
            async getArgument(name) {
                const runtime = host('getArgument');
                return typeof runtime?.getArgument === 'function' ? await runtime.getArgument(name) : undefined;
            },
            async getCharacter() {
                const runtime = host('getCharacter');
                return typeof runtime?.getCharacter === 'function' ? await runtime.getCharacter() : null;
            },
            async getCurrentCharacterIndex() {
                const runtime = host('getCurrentCharacterIndex');
                return typeof runtime?.getCurrentCharacterIndex === 'function' ? await runtime.getCurrentCharacterIndex() : -1;
            },
            async getCurrentChatIndex() {
                const runtime = host('getCurrentChatIndex');
                return typeof runtime?.getCurrentChatIndex === 'function' ? await runtime.getCurrentChatIndex() : -1;
            },
            async getCharacterFromIndex(index) {
                const runtime = host('getCharacterFromIndex');
                return typeof runtime?.getCharacterFromIndex === 'function' ? await runtime.getCharacterFromIndex(index) : null;
            },
            async getChatFromIndex(charIndex, chatIndex) {
                const runtime = host('getChatFromIndex');
                return typeof runtime?.getChatFromIndex === 'function' ? await runtime.getChatFromIndex(charIndex, chatIndex) : null;
            },
            async setChatToIndex(charIndex, chatIndex, chat) {
                const runtime = host('setChatToIndex');
                if (typeof runtime?.setChatToIndex !== 'function') return false;
                return await runtime.setChatToIndex(charIndex, chatIndex, chat) !== false;
            },
            async setCharacterToIndex(charIndex, char) {
                const runtime = host('setCharacterToIndex');
                if (typeof runtime?.setCharacterToIndex !== 'function') return false;
                return await runtime.setCharacterToIndex(charIndex, char) !== false;
            },
            async setCharacter(char) {
                const runtime = host('setCharacter');
                if (typeof runtime?.setCharacter !== 'function') return false;
                return await runtime.setCharacter(char) !== false;
            },
            async addReplacer(type, handler) {
                const runtime = host('addRisuReplacer');
                if (typeof runtime?.addRisuReplacer !== 'function' || typeof handler !== 'function') return false;
                const granted = await ensurePermission('replacer');
                const state = compatDiagnostics.replacers[String(type || 'unknown').trim() || 'unknown'] || (compatDiagnostics.replacers[String(type || 'unknown').trim() || 'unknown'] = {});
                state.permission = granted === null ? 'unavailable' : granted ? 'granted' : 'denied';
                state.permissionCheckedAt = Date.now();
                if (granted === false) {
                    state.registered = false;
                    state.lastError = 'replacer permission denied';
                    return false;
                }
                const wrapped = wrapReplacerHandler(type, handler);
                replacerWrappedHandlers.set(handler, wrapped);
                await runtime.addRisuReplacer(type, wrapped);
                state.registered = true;
                state.registeredAt = Date.now();
                return true;
            },
            async removeReplacer(type, handler) {
                const runtime = host('removeRisuReplacer');
                if (typeof runtime?.removeRisuReplacer !== 'function') return false;
                const wrapped = replacerWrappedHandlers.get(handler) || handler;
                await runtime.removeRisuReplacer(type, wrapped);
                replacerWrappedHandlers.delete(handler);
                const state = compatDiagnostics.replacers[String(type || 'unknown').trim() || 'unknown'];
                if (state) state.registered = false;
                return true;
            },
            async addScriptHandler(mode, handler) {
                const runtime = host('addRisuScriptHandler');
                if (typeof runtime?.addRisuScriptHandler !== 'function') return false;
                await runtime.addRisuScriptHandler(mode, handler);
                return true;
            },
            async removeScriptHandler(mode, handler) {
                const runtime = host('removeRisuScriptHandler');
                if (typeof runtime?.removeRisuScriptHandler !== 'function') return false;
                await runtime.removeRisuScriptHandler(mode, handler);
                return true;
            },
            async registerBodyIntercepter(handler) {
                const runtime = host('registerBodyIntercepter');
                if (typeof runtime?.registerBodyIntercepter !== 'function') return null;
                return await runtime.registerBodyIntercepter(handler);
            },
            async unregisterBodyIntercepter(id) {
                const runtime = host('unregisterBodyIntercepter');
                if (typeof runtime?.unregisterBodyIntercepter !== 'function') return false;
                await runtime.unregisterBodyIntercepter(id);
                return true;
            },
            async onUnload(handler) {
                const runtime = host('onUnload');
                if (typeof runtime?.onUnload !== 'function') return false;
                await runtime.onUnload(handler);
                return true;
            }
        });
    })();
