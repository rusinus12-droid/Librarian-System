    // Derived vectors only. No model calls, canonical persistence, or legacy-cache reads.
    const SemanticRecallIndex = (() => {
        const ROW_SCHEMA = 'libra.typed-semantic.row.v3';
        const PREFIX = 'libra:v1:typed-semantic:';
        const FAMILIES = ['memory', 'entity', 'world', 'narrative'];
        const states = new WeakMap();
        const text = x => typeof x === 'string' ? x : '';
        const freeze = x => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
        const canonical = x => {
            if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
            if (typeof x === 'number' && Number.isFinite(x)) return x;
            if (Array.isArray(x)) return x.map(canonical);
            if (x && typeof x === 'object' && Object.prototype.toString.call(x) === '[object Object]')
                return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
            throw new Error('non_json_value');
        };
        const json = x => JSON.stringify(canonical(x));
        const copy = x => freeze(JSON.parse(json(x)));
        const bytes = x => new TextEncoder().encode(text(x)).length;
        // Synchronous SHA-256 keeps validate/read synchronous across browser and native hosts.
        // Legacy stableHash32 has equal-length collisions (e.g. Aa/BB); never use it here.
        const SHA_K = Object.freeze([
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ]);
        const sourceHash = value => {
            const input = new TextEncoder().encode(text(value)), size = Math.ceil((input.length + 9) / 64) * 64;
            const padded = new Uint8Array(size); padded.set(input); padded[input.length] = 0x80;
            const view = new DataView(padded.buffer), bitLength = input.length * 8;
            view.setUint32(size - 8, Math.floor(bitLength / 0x100000000)); view.setUint32(size - 4, bitLength >>> 0);
            const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
            const words = new Uint32Array(64), rotate = (n, shift) => (n >>> shift) | (n << (32 - shift));
            for (let offset = 0; offset < size; offset += 64) {
                for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
                for (let i = 16; i < 64; i++) {
                    const a = words[i - 15], b = words[i - 2];
                    words[i] = (words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
                }
                let a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
                for (let i = 0; i < 64; i++) {
                    const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + words[i]) >>> 0;
                    const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
                    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
                }
                // Avoid temporary arrays, iterators and callbacks for every input block.
                state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
                state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
                state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
                state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
            }
            return 'sha256:' + state.map(n => n.toString(16).padStart(8, '0')).join('');
        };
        const hash = value => sourceHash(json(value));
        const no = reason => ({ ok: false, reason });
        const providerDescriptor = p => {
            if (!p || !['spaceFingerprint', 'provider', 'model', 'modelRevision', 'endpoint', 'queryMode', 'documentMode'].every(k => text(p[k]).trim())
                || !Number.isInteger(p.dimension) || p.dimension < 1 || p.dimension > 8192) throw new Error('provider_invalid');
            return copy({ spaceFingerprint: p.spaceFingerprint, provider: p.provider, model: p.model, modelRevision: p.modelRevision,
                endpointHash: sourceHash(p.endpoint), dimension: p.dimension, queryMode: p.queryMode, documentMode: p.documentMode, options: canonical(p.options || {}) });
        };
        const vectorChecksum = vector => hash(vector);
        const bindingFor = (snapshot, unit, provider) => ({ schema: ROW_SCHEMA,
            scopeKey: snapshot.scopeKey, branchId: snapshot.branchId, identity: unit.identity, family: unit.family, subtype: unit.subtype,
            locator: unit.locator, contentHash: unit.persistentContentHash, dependencyHash: unit.persistentDependencyHash,
            representationVersion: unit.representationVersion, sourceHash: sourceHash(unit.text), provider: providerDescriptor(provider),
            mode: provider.documentMode, dimension: provider.dimension, viewerId: snapshot.viewerId });
        const namespaceFor = (snapshot, provider) => `${PREFIX}${encodeURIComponent(snapshot.scopeKey)}:${encodeURIComponent(snapshot.branchId)}:${hash(providerDescriptor(provider))}:rows-v3`;
        const rowKey = (snapshot, unit, provider) => `${namespaceFor(snapshot, provider)}:row:${hash(bindingFor(snapshot, unit, provider))}`;
        const validate = (record, unit, provider, mode) => {
            try {
                if (!record || record.schema !== ROW_SCHEMA || !unit || !FAMILIES.includes(unit.family)) return no('schema');
                if (record.indexGeneration !== undefined) return no('legacy_index_generation');
                if (mode !== provider.documentMode || record.mode !== mode) return no('mode');
                if (json(record.provider) !== json(providerDescriptor(provider))) return no('provider_fingerprint');
                for (const key of ['scopeKey', 'identity', 'family', 'subtype', 'contentHash', 'dependencyHash', 'representationVersion'])
                    if (!text(key === 'contentHash' ? unit.persistentContentHash : key === 'dependencyHash' ? unit.persistentDependencyHash : unit[key])
                        || record[key] !== (key === 'contentHash' ? unit.persistentContentHash : key === 'dependencyHash' ? unit.persistentDependencyHash : unit[key])) return no(key);
                if (json(record.locator) !== json(unit.locator)) return no('locator');
                if (record.sourceHash !== sourceHash(unit.text)) return no('sourceHash');
                if (record.dimension !== provider.dimension || !Array.isArray(record.vector) || record.vector.length !== provider.dimension) return no('dimension');
                if (!record.vector.every(n => typeof n === 'number' && Number.isFinite(n))) return no('non_finite_vector');
                const norm = Math.hypot(...record.vector);
                if (!Number.isFinite(norm) || norm <= 0) return no('zero_or_overflow_vector');
                if (record.vectorChecksum !== vectorChecksum(record.vector)) return no('vector_checksum');
                return { ok: true, reason: '' };
            } catch (_) { return no('invalid_record'); }
        };
        const limitsFor = policy => {
            const p = policy?.storage || {};
            const bounded = (key, fallback, lo, hi) => Number.isInteger(p[key]) ? Math.max(lo, Math.min(hi, p[key])) : fallback;
            return freeze({ maxRowBytes: bounded('maxRowBytes', 65536, 128, 2097152),
                maxJobBytes: bounded('maxJobBytes', 1048576, 128, 8388608),
                maxExpectedBytes: bounded('maxExpectedBytes', 8388608, 128, 33554432), maxExpectedRows: bounded('maxExpectedRows', 2048, 1, 8192) });
        };
        // Runtime observations only, never a cross-runtime writer lock or persistent receipt.
        // Failures poison reads in this runtime, including host cache ghosts after rejected set.
        // A new VM has no receipts: it can use validated reads but cannot certify persistence.
        const storageObservations = new WeakMap();
        const remember = (collection, key, value) => {
            collection.delete(key); collection instanceof Map ? collection.set(key, value) : collection.add(key);
            while (collection.size > 8192) collection.delete(collection.keys().next().value);
        };
        const eligibleUnits = s => TypedRecallCorpus.enumerate(s.snapshot, s.policy)
            .filter(unit => TypedRecallCorpus.adapters[unit.family]?.eligibility(unit, s.snapshot).eligible);
        const prepareExpected = s => {
            const units = eligibleUnits(s);
            s.corpusUnits = units;
            if (units.length > s.limits.maxExpectedRows) throw new Error('expected_rows_bound');
            s.expected = new Map(); s.expectedBytes = 0;
            for (const unit of units) {
                if (s.expected.has(unit.identity)) throw new Error('ambiguous_identity');
                const key = rowKey(s.snapshot, unit, s.provider), binding = bindingFor(s.snapshot, unit, s.provider);
                // Reserve a complete maximum-sized row per current unit, plus key and corpus
                // representation metadata. This bounds current work, not historical revisions.
                s.expectedBytes += bytes(key) + bytes(json(binding)) + bytes(unit.text) + s.limits.maxRowBytes;
                if (s.expectedBytes > s.limits.maxExpectedBytes) throw new Error('expected_bytes_bound');
                s.expected.set(unit.identity, { key, binding, unit });
            }
        };
        const checkedRow = (raw, expected, s) => {
            if (typeof raw !== 'string' || raw.length > s.limits.maxRowBytes || bytes(raw) > s.limits.maxRowBytes) throw new Error('row_encoding_or_bound');
            const row = JSON.parse(raw), verdict = validate(row, expected.unit, s.provider, s.provider.documentMode);
            if (!verdict.ok) throw new Error(verdict.reason);
            const allowed = new Set([...Object.keys(expected.binding), 'bindingHash', 'vector', 'vectorChecksum']);
            if (Object.keys(row).some(key => !allowed.has(key))) throw new Error('unexpected_row_field');
            if (Object.keys(expected.binding).some(k => json(row[k]) !== json(expected.binding[k]))
                || row.bindingHash !== hash(expected.binding)) throw new Error('canonical_binding');
            return copy(row);
        };
        const loadExpected = async s => {
            s.rows = new Map(); s.errors = new Map(); s.storageBytes = 0;
            for (const [identity, expected] of s.expected) {
                if (s.retired.has(identity)) continue;
                try {
                    if (s.uncertain.has(expected.key)) throw new Error('unacknowledged_set');
                    const raw = await s.adapter.get(expected.key);
                    if (raw == null) continue;
                    const row = checkedRow(raw, expected, s);
                    s.storageBytes += bytes(expected.key) + bytes(raw);
                    s.rows.set(identity, row);
                    if (s.receipts.get(expected.key) !== row.vectorChecksum) s.receipts.delete(expected.key);
                } catch (error) { s.errors.set(identity, text(error?.message) || 'row_read_failed'); s.receipts.delete(expected.key); }
            }
        };
        const open = async (snapshot, provider, policy = {}) => {
            const s = { snapshot, policy: null, provider: null, namespace: '', limits: limitsFor(policy), adapter: null,
                rows: new Map(), errors: new Map(), expected: new Map(), corpusUnits: [], retired: new Set(), receipts: new Map(), uncertain: new Set(),
                writable: false, reason: '', storageBytes: 0, expectedBytes: 0, busy: false };
            const handle = Object.freeze({
                get scopeKey() { return s.snapshot?.scopeKey || ''; }, get namespace() { return s.namespace; }, get provider() { return s.provider; },
                get generation() { return s.snapshot?.requestGeneration || 0; }, get writable() { return s.writable; },
                get storageBytes() { return s.storageBytes; }, get limits() { return s.limits; },
                get storageContract() { return freeze({ publication: 'expected_key_single_row', exclusiveWriter: false,
                    acknowledgement: s.adapter?.setAcknowledgement || 'unavailable', readVerification: 'cache_or_persistent', independentDurabilityRead: false }); }
            });
            states.set(handle, s);
            try {
                if (!snapshot?.scopeKey || typeof snapshot.branchId !== 'string' || !text(snapshot.viewerId) || !text(snapshot.worldlineRevision)) throw new Error('snapshot_invalid');
                // Preserve Task1 canonical entry property order during cloning.
                s.snapshot = Object.freeze({ ...freeze(JSON.parse(JSON.stringify(snapshot))), diagnostics: [] });
                s.policy = copy({ representation: policy?.representation || {} });
                providerDescriptor(provider);
                s.provider = copy({ spaceFingerprint: provider.spaceFingerprint, provider: provider.provider, model: provider.model, modelRevision: provider.modelRevision,
                    endpoint: provider.endpoint, dimension: provider.dimension, queryMode: provider.queryMode, documentMode: provider.documentMode, options: provider.options || {} });
                s.namespace = namespaceFor(s.snapshot, s.provider);
                if (bytes(s.namespace) > 2048) throw new Error('namespace_bound');
                prepareExpected(s);
                s.adapter = await MemoryEngine.getRecallDerivedStorageAdapter();
                if (!s.adapter) throw new Error('storage_unavailable');
                // Bind observations to the actual host storage object in this runtime. A
                // fallback/reconnection never inherits another object's successful set receipt.
                const domain = s.adapter.runtimeDomain;
                if (!storageObservations.has(domain)) storageObservations.set(domain, { receipts: new Map(), uncertain: new Set() });
                const observations = storageObservations.get(domain);
                s.receipts = observations.receipts; s.uncertain = observations.uncertain;
                await loadExpected(s);
                s.writable = typeof s.adapter.set === 'function';
                if (!s.writable) s.reason = 'storage_read_only';
            } catch (error) { s.reason = text(error?.message) || 'open_failed'; s.writable = false; s.rows.clear(); }
            return handle;
        };
        const read = (handle, units) => {
            const s = states.get(handle);
            if (!s) return { rows: [], readiness: { status: 'degraded', reason: 'unknown_handle', byType: {}, persistence: { persistentReady: false } } };
            const byType = Object.fromEntries(FAMILIES.map(f => [f, { eligible: 0, valid: 0, missing: 0, stale: 0, coverage: 0 }]));
            const requested = new Map((Array.isArray(units) ? units : []).filter(u => u?.identity).map(u => [u.identity, u]));
            const rows = []; let valid = 0, acknowledged = 0, eligible = 0;
            // Full current resident corpus is the denominator, even on subset reads or bounds.
            for (const unit of s.corpusUnits) {
                if (s.retired.has(unit.identity)) continue;
                const c = byType[unit.family]; c.eligible++; eligible++;
                const row = s.rows.get(unit.identity), expected = s.expected.get(unit.identity);
                if (!row) s.errors.has(unit.identity) ? c.stale++ : c.missing++;
                else {
                    c.valid++; valid++;
                    if (!s.uncertain.has(expected.key) && s.receipts.get(expected.key) === row.vectorChecksum) acknowledged++;
                    const wanted = requested.get(unit.identity);
                    if (wanted && rowKey(s.snapshot, wanted, s.provider) === expected.key) rows.push(row);
                }
            }
            for (const c of Object.values(byType)) c.coverage = c.eligible ? c.valid / c.eligible : 0;
            const reason = s.reason || s.errors.values().next().value || '';
            const status = reason ? 'degraded' : valid === eligible ? 'ready' : valid ? 'partial' : 'uninitialized';
            const persistentReady = !reason && eligible > 0 && valid === eligible && acknowledged === eligible
                && s.adapter?.setAcknowledgement === 'awaited_local_storage_api';
            return freeze({ rows, readiness: { status, reason, byType, eligible, valid, coverageBasis: 'current_expected_resident_snapshot',
                coldArchive: { status: 'not_indexed', eligible: null, valid: 0 }, storageBytes: s.storageBytes,
                expectedBytesReserved: s.expectedBytes, historicalStorageBounded: false,
                persistence: { persistentReady, acknowledged, validReads: valid, unverifiedReads: valid - acknowledged,
                    acknowledgement: s.adapter?.setAcknowledgement || 'unavailable',
                    status: persistentReady ? 'set_acknowledged_and_read_verified' : valid ? 'unverified_read' : 'unavailable',
                    independentDurabilityRead: false } } });
        };
        const sameSnapshot = (a, b) => ['scopeKey', 'branchId', 'corpusRevision', 'worldlineRevision', 'viewerId', 'currentTurn'].every(k => a?.[k] === b?.[k])
            && json(a?.ephemeralDriftExclusion || null) === json(b?.ephemeralDriftExclusion || null);
        const publish = async (handle, records, currentSnapshot) => {
            const s = states.get(handle);
            if (!s || !s.writable || !s.adapter?.set) return no(s?.reason || 'storage_read_only');
            if (s.busy) return no('runtime_job_busy');
            if (!Array.isArray(records) || !sameSnapshot(s.snapshot, currentSnapshot)) return no('snapshot_changed');
            s.busy = true;
            let written = 0;
            try {
                const currentUnits = new Map(TypedRecallCorpus.enumerate(currentSnapshot, s.policy)
                    .filter(u => TypedRecallCorpus.adapters[u.family]?.eligibility(u, currentSnapshot).eligible).map(u => [u.identity, u]));
                const seen = new Set(), job = []; let jobBytes = 0;
                // Validate and bound the entire supplied job before the first storage mutation.
                for (const record of records) {
                    const expected = s.expected.get(record?.identity), current = currentUnits.get(record?.identity);
                    if (seen.has(record?.identity)) return no('duplicate_identity');
                    seen.add(record?.identity);
                    if (!expected || !current || s.retired.has(record.identity) || rowKey(currentSnapshot, current, s.provider) !== expected.key) return no('canonical_binding');
                    const verdict = validate(record, current, s.provider, s.provider.documentMode);
                    if (!verdict.ok) return no(verdict.reason);
                    for (const key of Object.keys(expected.binding))
                        if (json(record[key]) !== json(expected.binding[key])) return no('canonical_binding');
                    if (record.bindingHash !== undefined && record.bindingHash !== hash(expected.binding)) return no('canonical_binding');
                    const row = copy({ ...expected.binding, bindingHash: hash(expected.binding), vector: record.vector, vectorChecksum: record.vectorChecksum });
                    const raw = json(row);
                    if (bytes(raw) > s.limits.maxRowBytes) return no('row_bytes_bound');
                    jobBytes += bytes(expected.key) + bytes(raw);
                    if (jobBytes > s.limits.maxJobBytes) return no('job_bytes_bound');
                    job.push({ expected, row, raw });
                }
                for (const { expected, row, raw } of job) {
                    // Single-key writes may race. Any validated same-binding vector is allowed;
                    // exact byte equality with this writer's vector is deliberately not required.
                    s.receipts.delete(expected.key);
                    try {
                        if (await s.adapter.set(expected.key, raw) === false) throw new Error('storage_set_failed');
                        remember(s.receipts, expected.key, row.vectorChecksum); s.uncertain.delete(expected.key);
                        const verified = checkedRow(await s.adapter.get(expected.key), expected, s);
                        if (verified.vectorChecksum !== row.vectorChecksum) s.receipts.delete(expected.key);
                        written++;
                    } catch (error) { s.receipts.delete(expected.key); remember(s.uncertain, expected.key); throw error; }
                }
                s.reason = ''; await loadExpected(s);
                return { ok: !s.errors.size, reason: s.errors.values().next().value || '', written, jobBytes, storageBytes: s.storageBytes,
                    readiness: read(handle, [...currentUnits.values()]).readiness };
            } catch (error) {
                s.reason = text(error?.message) || 'publish_failed';
                await loadExpected(s);
                return { ...no(s.reason), written, readiness: read(handle, [...s.expected.values()].map(e => e.unit)).readiness };
            } finally { s.busy = false; }
        };
        const retire = async (handle, identities) => {
            const s = states.get(handle); if (!s) return no('unknown_handle');
            if (s.busy) return no('runtime_job_busy');
            // Logical exclusion in this handle only. Fresh handles follow fresh canonical state;
            // canonical retirement is authoritative. No storage deletion or shared tombstones.
            for (const identity of Array.isArray(identities) ? identities : []) { s.retired.add(identity); s.rows.delete(identity); s.errors.delete(identity); }
            return { ok: true, reason: '', deleted: 0, persistence: 'canonical_expected_set' };
        };
        return Object.freeze({ open, validate, read, publish, retire, sourceHash, providerDescriptor, rowKey, vectorChecksum, ROW_SCHEMA });
    })();
