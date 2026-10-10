    // ══════════════════════════════════════════════════════════════
    // [ENGINE] World Archetype Registry
    // ══════════════════════════════════════════════════════════════
    // V5.2.8: keep this as an empty compatibility registry. Previous builds
    // expanded genre labels such as "fantasy" or "modern" into predefined
    // world rules, which made world canon drift toward local heuristics. World
    // rules now come from explicit LLM/packet/manual fields only; local code may
    // normalize, sanitize, and dedupe, but it must not synthesize genre defaults.
    const WORLD_TEMPLATES = Object.freeze({});

    // ══════════════════════════════════════════════════════════════
    // [MANAGER] Integrity Metadata
    // ══════════════════════════════════════════════════════════════
    // Closure-private bridge: callers must prove the parsed graph unchanged in this batch.
    let validateOwnedTypedRecallIntegrity = null;
    const IntegrityMetaManager = (() => {
        const SCHEMA = 'libra.integrity_meta.v1';
        const VERSION = 1;
        const CHECKSUM_ALGO = 'stableHash32';
        const LEGACY_OK = { ok: true, legacy: true, reason: 'legacy_no_integrity_meta' };

        const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const clip = (value = '', max = 180) => String(value == null ? '' : value)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, Math.max(1, Number(max || 180)));
        const hashText = (value = '') => {
            try {
                if (typeof stableHash === 'function') return String(stableHash(value));
            } catch (_) { /* fallback below */ }
            try {
                if (typeof TokenizerEngine !== 'undefined' && TokenizerEngine?.simpleHash) return String(TokenizerEngine.simpleHash(value));
            } catch (_) { /* fallback below */ }
            const text = String(value || '');
            let hash = 0;
            for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
            return String(Math.abs(hash).toString(36));
        };
        const stableSerialize = (value) => {
            const seen = new WeakSet();
            const walk = (input, parentKey = '') => {
                if (input == null) return input;
                if (typeof input !== 'object') return input;
                if (seen.has(input)) return '[Circular]';
                seen.add(input);
                try {
                    // `seen` represents the current ancestor path, not every object
                    // encountered in the record. Normalized narrative structures can
                    // legitimately share the same array/object reference in sibling
                    // fields; treating aliases as circular made a checksum change
                    // after JSON persistence broke those aliases.
                    if (Array.isArray(input)) return input.map(item => walk(item, parentKey));
                    const out = {};
                    for (const key of Object.keys(input).sort()) {
                        if (parentKey === 'meta' && key === 'integrity') continue;
                        const valueForKey = input[key];
                        if (typeof valueForKey === 'function' || typeof valueForKey === 'undefined') continue;
                        out[key] = walk(valueForKey, key);
                    }
                    return out;
                } finally {
                    seen.delete(input);
                }
            };
            return JSON.stringify(walk(value));
        };
        const getRecordMeta = (record) => asObject(asObject(record).meta);
        const getIntegrityMeta = (record) => asObject(getRecordMeta(record).integrity);
        // Scope identity must never be truncated: the distinguishing persona
        // component can occur after a long character/chat prefix.
        const normalizeScopeKey = value => String(value == null ? '' : value).trim();
        const getScopeKey = (context = {}) => normalizeScopeKey(
            context.scopeKey
            || context.chatScopeKey
            || context.chatId
            || MemoryState?._activeScopeKey
            || ''
        );
        const computeRecordChecksum = (record = null) => hashText(stableSerialize(record));
        const buildIntegrityMeta = (record = null, context = {}) => {
            const domain = clip(context.domain || context.kind || '', 64);
            const scopeKey = getScopeKey(context);
            const turn = normalizeLegacyMemoryTurnAnchor(context.turn || record?.turn || record?.meta?.updated || record?.meta?.created || MemoryState?.currentTurn || 0);
            const checksum = computeRecordChecksum(record);
            return {
                schema: SCHEMA,
                version: VERSION,
                checksumAlgo: CHECKSUM_ALGO,
                checksum,
                domain,
                recordSchema: clip(context.recordSchema || record?.schema || record?.kind || domain || 'record', 96),
                recordId: clip(context.recordId || context.key || record?.id || record?.name || '', 160),
                scopeKey,
                turn,
                source: clip(context.source || record?.meta?.source || '', 80),
                updatedAt: Date.now()
            };
        };
        const applyIntegrityMeta = (record = null, context = {}) => {
            if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
            record.meta = asObject(record.meta);
            record.meta.integrity = buildIntegrityMeta(record, context);
            return record;
        };
        const validateIntegrityMetaCore = (record = null, context = {}, checksum = computeRecordChecksum) => {
            if (!record || typeof record !== 'object' || Array.isArray(record)) {
                return { ok: false, legacy: false, reason: 'invalid_record' };
            }
            const integrity = getIntegrityMeta(record);
            if (!integrity || !integrity.schema) return { ...LEGACY_OK };
            if (integrity.schema !== SCHEMA) {
                return { ok: false, legacy: false, reason: 'schema_mismatch', integrity };
            }
            const actual = clip(integrity.checksum || '', 96);
            const expected = checksum(record);
            if (actual !== expected) {
                return { ok: false, legacy: false, reason: 'checksum_mismatch', expected, actual, integrity };
            }
            const expectedScope = getScopeKey(context);
            const actualScope = normalizeScopeKey(integrity.scopeKey || '');
            if (expectedScope && actualScope && expectedScope !== actualScope) {
                return { ok: false, legacy: false, reason: 'scope_mismatch', expectedScope, actualScope, integrity };
            }
            const expectedDomain = clip(context.domain || '', 64);
            const actualDomain = clip(integrity.domain || '', 64);
            if (expectedDomain && actualDomain && expectedDomain !== actualDomain) {
                return { ok: false, legacy: false, reason: 'domain_mismatch', expectedDomain, actualDomain, integrity };
            }
            return { ok: true, legacy: false, reason: 'ok', checksum: actual, integrity };
        };
        const validateIntegrityMeta = (record = null, context = {}) => {
            return validateIntegrityMetaCore(record, context);
        };
        validateOwnedTypedRecallIntegrity = (record, context, checksums, witnessCurrent) => validateIntegrityMetaCore(record, context, value => {
            // Cache only the pure checksum, never schema/scope/domain acceptance.
            // The map is owned by one synchronous private consumer validity pass.
            // Integrity getters have already run. Verify immediately at checksum use.
            if (!witnessCurrent(value)) return computeRecordChecksum(value);
            if (!checksums.has(value)) checksums.set(value, computeRecordChecksum(value));
            return checksums.get(value);
        });
        const annotateMemoryMeta = (meta = {}, content = '', context = {}) => {
            const next = asObject(meta);
            const record = {
                meta: next,
                content: String(content || '').trim()
            };
            next.integrity = buildIntegrityMeta(record, {
                ...context,
                domain: context.domain || 'memory',
                recordSchema: context.recordSchema || 'libra.memory.entry.v1',
                turn: context.turn || next.t || next.turn || next.turnAnchor || 0,
                recordId: context.recordId || context.key || next.turnKey || next.sourceHash || next.m_id || ''
            });
            return next;
        };
        const validateMemoryMeta = (meta = {}, content = '', context = {}) => validateIntegrityMeta({
            meta: asObject(meta),
            content: String(content || '').trim()
        }, {
            ...context,
            domain: context.domain || 'memory',
            recordId: context.recordId || context.key || meta?.turnKey || meta?.sourceHash || meta?.m_id || '',
            turn: context.turn || meta?.t || meta?.turn || meta?.turnAnchor || 0
        });
        const debugValidationFailure = (label = 'integrity', result = {}, context = {}) => {
            try {
                recordRuntimeDebug('warn', '[LIBRA] Integrity validation blocked record:', {
                    label,
                    reason: result?.reason || '',
                    domain: context?.domain || '',
                    recordId: context?.recordId || context?.key || '',
                    scopeKey: context?.scopeKey || '',
                    expected: result?.expected || result?.expectedScope || '',
                    actual: result?.actual || result?.actualScope || ''
                });
            } catch (_) { /* diagnostics only */ }
        };
        return {
            schema: SCHEMA,
            buildIntegrityMeta,
            computeRecordChecksum,
            validateIntegrityMeta,
            applyIntegrityMeta,
            annotateMemoryMeta,
            validateMemoryMeta,
            debugValidationFailure
        };
    })();
    // Capture at construction, before any public exposure. Never learn a wrapper
    // or invoke an accessor while checking private hydration compatibility.
    originalHydrationValidator = (() => {
        const original = IntegrityMetaManager.validateIntegrityMeta;
        return () => {
            const descriptor = Object.getOwnPropertyDescriptor(IntegrityMetaManager, 'validateIntegrityMeta');
            return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && descriptor.value === original ? original : null;
        };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_IntegrityMetaManager = IntegrityMetaManager;
    } catch (_) { /* optional diagnostics only */ }

    // ══════════════════════════════════════════════════════════════
