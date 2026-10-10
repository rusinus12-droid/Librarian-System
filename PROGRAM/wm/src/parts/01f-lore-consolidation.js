    const requireLoadedCharacter = async () => {
        const char = await RisuCompat.getCharacter();
        if (!char) {
            throw new LIBRAError('No character loaded', 'NO_CHAR');
        }
        return char;
    };
        // ★ **턴 도장은 턴이어야 한다** — 타임스탬프를 턴으로 읽으면 단위 혼용으로 오판한다.
        //   실측 결함(P0): 세계 노드 `meta.created` 는 `Date.now()`(08a:525)인데
        //   분기 상속이 그걸 `forkTurn`(40)과 비교해 **정상 노드를 전부 삭제**했다.
        //   같은 필드명이라도 계층마다 의미가 다르다:
        //     엔티티·관계 `meta.created` = **턴** (08d 병합이 `Math.min`)
        //     세계 노드 `meta.created` = **`Date.now()`**
        //   → **명시 턴 필드를 먼저** 보고, 레거시 `meta.created` 는 옵션으로 분리한다.
        const TURN_STAMP_FIELDS = ['createdTurn', 'sourceTurn', 'worldCorrectionTurn'];
        const stampTurn = (meta = null, options = {}) => {
            const m = (meta && typeof meta === 'object') ? meta : {};
            for (const key of TURN_STAMP_FIELDS) {
                const value = Number(m[key]);
                if (Number.isFinite(value) && value > 0) return value;
            }
            if (options.allowLegacyCreated === false) return 0;
            const created = Number(m.created);
            return (Number.isFinite(created) && created > 0) ? created : 0;
        };
        //   레거시 판정의 안전 범위 — 턴 번호는 작다. 타임스탬프(ms)는 넘는다.
        const LEGACY_TURN_MAX = 1000000;
        const legacyTurnWithinRange = (value = 0) => {
            const v = Number(value) || 0;
            if (!(v > 0) || v > LEGACY_TURN_MAX) return 0;   // 0 = 불명 (타임스탬프 배제)
            return v;
        };

    const RETIRED_ORCHESTRATION_LORE_COMMENTS = new Set([]);
    const isRetiredOrchestrationLoreEntry = (entry) => RETIRED_ORCHESTRATION_LORE_COMMENTS.has(String(entry?.comment || '').trim());
    const LIBRA_PACK_MANAGED_LORE_CONTAINERS = true;

    // ══════════════════════════════════════════════════════════════
    // LIBRA 데이터 스토리지 (로어 → RisuAI pluginStorage)
    //
    // 종전에는 lmai_* 38종을 캐릭터 로어북에 저장했다. 로어북은 캐릭터 카드에
    // 붙어 카드를 비대하게 만들고 채팅 로어 목록을 오염시킨다. pluginStorage 는
    // 세이브 파일에 붙고 기기 간 동기화되며 임의 길이를 담을 수 있다
    // (RisuCompat 이 512KB 단위로 분할 저장).
    //
    // unpack() 은 동기 함수이고 호출부가 80곳이라 async 로 바꿀 수 없다.
    // 그래서 **메모리 섀도**를 두고, 영속화는 이 라우터가 담당한다:
    //   - hydrate(): 스토리지 → 섀도 (초기화·스코프 전환 시)
    //   - save():    섀도 ← 항목 + 스토리지에 기록, 로어에서는 제거
    //   - unpack():  로어에 남은 항목 + 섀도를 합쳐 돌려준다 (투명)
    //
    // 섀도가 비어 있으면(미수화) unpack 은 종전과 완전히 동일하게 동작한다 —
    // 기존 게이트가 깨지지 않는다.
    // ══════════════════════════════════════════════════════════════
    const LIBRA_DATA_STORAGE_PREFIX = 'LIBRA_DATA::v1::';
    // Closure-private source and request hydration lifecycle.
    let disposeValidationSourceOwners = () => {};
    let originalHydrationValidator = () => null;
    let OwnedHydrationValidation = null;
    let OwnedNormalizationSource = null;
    let isOwnedHydrationHostEligible = () => false;
    const LibraDataStorage = (() => {
        const manualRouted = () => typeof WmManualRuntime !== 'undefined' && WmManualRuntime?.isRouted() === true;
        const shadow = new Map();          // scopeKey -> entries[]
        const hydratedScopes = new Set();  // hydrate 시도한 스코프 (빈 결과도 기억)
        const hydrationDiagnostics = new Map();
        const scopeWrites = new Map();
        const scopeMutations = new Map();
        let mutationSerial = 0;
        // Stage A source-observation foundation. This is deliberately not part of
        // LibraDataStorage's public API and does not certify hydration, integrity,
        // eligibility or request currentness. The registered hook separately binds
        // its capsule to live admission and retains every physical read boundary.
        const validationSources = (() => {
            const scopes = new Map(), owners = new WeakMap();
            let disposed = false;
            const scopeState = scope => {
                let state = scopes.get(scope);
                if (!state) { state = { scope, revision: {}, acquisition: null, writes: 0, owners: new Set() }; scopes.set(scope, state); }
                return state;
            };
            const releaseScope = state => {
                if (!state.writes && !state.owners.size && scopes.get(state.scope) === state) scopes.delete(state.scope);
            };
            const clearSource = state => { state.receipt = null; state.material = null; state.attempt = null; state.revision = null; };
            const close = owner => {
                const state = owners.get(owner);
                if (!state) return;
                owners.delete(owner);
                clearSource(state);
                const scope = state.scope;
                state.scope = null; state.owner = null;
                scope.owners.delete(state);
                releaseScope(scope);
            };
            const disposeAll = () => {
                if (disposed) return;
                disposed = true;
                for (const scope of scopes.values()) for (const state of [...scope.owners]) close(state.owner);
                // Pending writers retain only their own marker; settlement never
                // recreates this registry or an owner after terminal disposal.
                scopes.clear();
            };
            const live = () => {
                if (!disposed && typeof isLibraRuntimeEpochActive === 'function' && !isLibraRuntimeEpochActive()) disposeAll();
                return !disposed;
            };
            const revokeState = scope => {
                scope.revision = {};
                scope.acquisition = null;
                for (const state of scope.owners) clearSource(state);
            };
            const revoke = scopeKey => { const scope = scopes.get(scopeKey); if (scope) revokeState(scope); };
            const retire = scopeKey => {
                WmNativeReadonlyDerivedCache.invalidateScope(scopeKey);
                const scope = scopes.get(scopeKey);
                if (scope) { revokeState(scope); for (const state of [...scope.owners]) close(state.owner); }
            };
            const beginWrite = scopeKey => {
                if (!live()) return null;
                WmNativeReadonlyDerivedCache.invalidateScope(scopeKey);
                // Keep the marker even if no owner exists yet. A new owner may
                // start while set/remove is awaiting a delayed durable commit.
                const scope = scopeState(scopeKey);
                scope.writes += 1;
                revokeState(scope);
                return scope;
            };
            const endWrite = scope => {
                if (!scope) return;
                WmNativeReadonlyDerivedCache.invalidateScope(scope.scope);
                revokeState(scope);
                scope.writes -= 1;
                releaseScope(scope);
            };
            const createOwner = (scopeKey, authorityRequest = null) => {
                const scopeKeyText = String(scopeKey || '').trim();
                if (!live() || !isManagementScopeResolved(scopeKeyText)) return null;
                const owner = Object.freeze({}), scope = scopeState(scopeKeyText);
                const state = { owner, scope, authorityRequest, receipt: null, material: null, attempt: null, revision: null };
                owners.set(owner, state); scope.owners.add(state);
                return owner;
            };
            const acquireObserved = async owner => {
                const unavailable = status => ({ status, read: null, receipt: null });
                if (!live()) return unavailable('closed');
                const state = owners.get(owner);
                if (!state) return unavailable('closed');
                clearSource(state);
                const scope = state.scope;
                if (scope.writes) return unavailable('busy');
                const revision = scope.revision, attempt = {};
                // A late read from another owner must not replace or revoke a
                // newer observation. Keep this scope fence even if its owner closes.
                scope.acquisition = attempt;
                state.attempt = attempt;
                // Never use readonlyReadProof as a fresh physical observation.
                const read = await readVerified(scope.scope, { readonly: true, authorityRequest: state.authorityRequest });
                if (!live() || owners.get(owner) !== state || state.attempt !== attempt
                    || scope.writes || scope.revision !== revision || scope.acquisition !== attempt) return { status: 'stale', read, receipt: null };
                const binding = read?.entries && verifiedReadonlySourceBinding(read.entries);
                if (!read?.ok || read.missing || typeof read.raw !== 'string' || !isVerifiedReadonlyEntries(read.entries)
                    || !binding || binding.scopeKey !== scope.scope || binding.resetGeneration !== read.resetGeneration) {
                    revokeState(scope);
                    return { status: read?.ok && read.missing ? 'missing' : 'read_failed', read, receipt: null };
                }
                // A newly observed different source retires any other owner's old
                // observation too. Equal bytes are content facts, never a new token.
                if ([...scope.owners].some(other => other.material && other.material.raw !== read.raw)) revokeState(scope);
                const receipt = Object.freeze({});
                scope.acquisition = attempt;
                state.attempt = null; state.material = read; state.receipt = receipt; state.revision = scope.revision;
                return { status: 'issued', read, receipt };
            };
            const acquire = async owner => (await acquireObserved(owner)).receipt;
            const source = (owner, receipt) => {
                if (!live()) return null;
                const state = owners.get(owner);
                return state && receipt && state.receipt === receipt && !state.scope.writes
                    && state.revision === state.scope.revision ? state.material : null;
            };
            const matches = (owner, receipt, material) => !!material && source(owner, receipt) === material;
            return Object.freeze({ createOwner, acquire, acquireObserved, source, matches, close, revoke, retire, beginWrite, endWrite, disposeAll });
        })();
        disposeValidationSourceOwners = validationSources.disposeAll;
        // Lexical preparation ownership only. Absence is conditional input, never
        // an issued source receipt or authority to adopt unverified host rows.
        OwnedNormalizationSource = Object.freeze({
            async open(admission, guard) {
                if (!admission || !isManagementScopeResolved(admission.scopeKey) || typeof guard !== 'function')
                    throw new Error('normalization_identity_unresolved');
                let owner = validationSources.createOwner(admission.scopeKey), observation = null, closed = false;
                const close = () => { if (owner) validationSources.close(owner); owner = null; observation = null; closed = true; };
                const live = () => {
                    try { if (!closed && guard() === true) return true; } catch (_) {}
                    close(); return false;
                };
                if (!owner || !live()) { close(); throw new Error('normalization_source_invalidated'); }
                observation = await validationSources.acquireObserved(owner);
                if (!live() || !['issued', 'missing'].includes(observation?.status)
                    || observation.read?.resetGeneration !== admission.resetGeneration) {
                    close(); throw new Error('normalization_source_unavailable');
                }
                const status = observation.status, expectedRaw = observation.read.raw;
                if (status === 'missing') { validationSources.close(owner); owner = null; observation = null; }
                const isCurrent = () => live() && (status === 'missing'
                    || validationSources.matches(owner, observation?.receipt, observation?.read));
                const refresh = async () => {
                    if (!isCurrent()) { close(); return false; }
                    const next = status === 'missing' ? { status: 'missing', read: await readVerified(admission.scopeKey, { readonly: true }) }
                        : await validationSources.acquireObserved(owner);
                    if (!live() || next.status !== status || !next.read?.ok || next.read.raw !== expectedRaw
                        || next.read.resetGeneration !== admission.resetGeneration
                        || (status === 'missing' ? !next.read.missing : !next.receipt)) { close(); return false; }
                    if (status === 'issued') observation = next;
                    return isCurrent();
                };
                const matchesShadow = () => isCurrent() && getActiveScope() === admission.scopeKey
                    && (status === 'missing' ? getShadow(admission.scopeKey).length === 0
                        : isHydrated(admission.scopeKey) && JSON.stringify(getShadow(admission.scopeKey)) === JSON.stringify(observation.read.entries));
                return Object.freeze({ status, expectedRaw, isCurrent, matchesShadow, refresh, close });
            }
        });

        const invalidateScopeWriters = scope => {
            scopeMutations.set(scope, ++mutationSerial);
            if (typeof MemoryState !== 'undefined') MemoryState.invalidateTypedHmeSourceGraph?.();
        };
        const withScopeWrite = async (scope, callback) => {
            const previous = scopeWrites.get(scope) || Promise.resolve();
            const current = previous.catch(() => {}).then(callback);
            scopeWrites.set(scope, current);
            try { return await current; }
            finally { if (scopeWrites.get(scope) === current) scopeWrites.delete(scope); }
        };
        const capturedGeneration = (char, chat) => typeof PersonaScopeIdentity === 'undefined'
            ? 0 : (PersonaScopeIdentity.get(char, chat)?.resetGeneration ?? 0);
        const getHydrationDiagnostics = scope => ({ ...(hydrationDiagnostics.get(String(scope)) || { readOnly: false, excludedCount: 0, reasons: [] }) });
        const isLibraEntry = (entry) => String(entry?.comment || '').trim().startsWith('lmai_');
        // 호출 편의: (char, chat) 와 ({ char, chat }) 둘 다 받는다.
        const args = (a = null, b = null) => {
            if (a && typeof a === 'object' && ('char' in a || 'chat' in a || 'entries' in a)) {
                return { char: a.char || null, chat: a.chat || null, entries: a.entries || null };
            }
            return { char: a || null, chat: b || null, entries: null };
        };
        // 저장 키는 **안정적**이어야 한다. getChatRuntimeScopeKey 는 chatId 가 없으면
        // nonce 를 만들어 매 호출마다 달라지므로(휘발성 스코프) 저장 키로 쓸 수 없다.
        // 캐릭터·채팅의 안정 식별자만 조합한다.
        // Downloads/plugins 의 최신 5개 플러그인(Flashback/HAYAKU/LIA/RE:TRACE)이
        // 공유 스코프 라우팅 브리지에서 쓰는 규칙과 동일하게 맞춘다. 실측 규칙:
        //   characterId = first(id, _id, uid, uuid, key, `charIndex:N`)
        //   chatId      = first(id, _id, uid, uuid, key, chatId, `chatIndex:N`)
        //   personaId   = first(chat.bindedPersona, boundPersonaId, personaId)
        //                 || (db.selectedPersona → personas[i].id/_id/`personaIndex:i`)
        // persona 를 포함하지 않으면 같은 캐릭터·채팅에서 페르소나만 바꿔도
        // 서로 다른 대화의 기억이 섞인다.
        const firstDefined = (...values) => {
            for (const value of values) {
                const text = String(value == null ? '' : value).trim();
                if (text) return text;
            }
            return '';
        };
        let _personaCache = { at: 0, id: '', db: null };
        const resolvePersonaId = async (chat = null, char = null, options = {}) => {
            const hint = typeof PersonaScopeIdentity !== 'undefined' ? PersonaScopeIdentity.bindingHint(chat, char) : null;
            if (hint?.invalid) {
                if (options.strict === true) throw new Error('persona_binding_invalid');
                return '';
            }
            const fromChat = hint?.id || firstDefined(chat?.bindedPersona, chat?.boundPersonaId, chat?.personaId, char?.bindedPersona);
            if (fromChat) return fromChat;
            const proof = typeof PersonaScopeIdentity !== 'undefined' ? PersonaScopeIdentity.snapshotProof(char, chat) : null;
            if (options.fresh !== true && proof) return proof.personaId;
            // Management proof is uncached and must not silently re-key the existing
            // general runtime cache or migrate ambiguous default-persona storage.
            if (options.fresh === true) {
                try {
                    const db = await RisuCompat.database.get(['selectedPersona', 'personas']);
                    if (!db || typeof db !== 'object' || !Array.isArray(db.personas)) throw new Error('persona_read_unavailable');
                    const index = Number(db.selectedPersona), list = db.personas;
                    if (list.length && (!Number.isInteger(index) || !list[index])) throw new Error('persona_selection_unresolved');
                    return Number.isInteger(index) && list[index] ? firstDefined(list[index]?.id, list[index]?._id, `personaIndex:${index}`) : '';
                } catch (_) {
                    if (options.strict === true) throw new Error('persona_read_unavailable');
                    return '';
                }
            }
            // Preserve the existing general-runtime identity contract until legacy
            // default-persona data has an explicitly reviewed migration policy.
            if (_personaCache.id && Date.now() - _personaCache.at < 2000) return _personaCache.id;
            try {
                const db = await RisuCompat.getDatabase?.(['selectedPersona', 'personas']);
                const index = Number(db?.selectedPersona);
                const list = Array.isArray(db?.personas) ? db.personas : [];
                const found = Number.isInteger(index) && list[index]
                    ? firstDefined(list[index]?.id, list[index]?._id, `personaIndex:${index}`)
                    : '';
                _personaCache = { at: Date.now(), id: found, db: null };
                return found;
            } catch (_) {
                _personaCache = { at: Date.now(), id: '', db: null };
                return '';
            }
        };
        // 인덱스 폴백 — RisuAI 가 id 를 주지 않을 때만 쓴다. 스코프는 동기여야
        // 하므로(80곳이 동기 unpack 을 호출) 마지막으로 확인된 인덱스를 캐시한다.
        let _indexCache = { char: -1, chat: -1, at: 0 };
        const refreshIndexCache = async () => {
            try {
                const charIndex = await RisuCompat.getCurrentCharacterIndex?.();
                const chatIndex = await RisuCompat.getCurrentChatIndex?.();
                _indexCache = {
                    char: Number.isInteger(Number(charIndex)) ? Number(charIndex) : -1,
                    chat: Number.isInteger(Number(chatIndex)) ? Number(chatIndex) : -1,
                    at: Date.now()
                };
            } catch (_) {}
            return _indexCache;
        };
        // 동기 스코프 키 — persona 를 인자로 받거나 캐시된 값을 쓴다.
        // (unpack 이 동기라 scopeKeyFor 도 동기여야 한다.)
        const scopeKeyFor = (char = null, chat = null, personaId = null) => {
            try {
                const charIndexHint = Number(char?.chatPage ?? char?._index ?? _indexCache.char ?? -1);
                const characterId = firstDefined(
                    char?.id, char?._id, char?.uid, char?.uuid, char?.key, char?.chaId,
                    Number.isInteger(charIndexHint) && charIndexHint >= 0 ? `charIndex:${charIndexHint}` : ''
                );
                const chatIndexHint = Number(chat?.chatPage ?? chat?._index ?? _indexCache.chat ?? -1);
                const chatId = firstDefined(
                    chat?.id, chat?._id, chat?.uid, chat?.uuid, chat?.key, chat?.chatId,
                    Number.isInteger(chatIndexHint) && chatIndexHint >= 0 ? `chatIndex:${chatIndexHint}` : ''
                );
                const persona = firstDefined(
                    personaId,
                    chat?.bindedPersona, chat?.boundPersonaId, chat?.personaId, char?.bindedPersona,
                    typeof PersonaScopeIdentity !== 'undefined' ? PersonaScopeIdentity.get(char, chat)?.personaId : '',
                    _personaCache.id
                ) || 'default';
                return `char:${characterId || 'unknown'}|chat:${chatId || 'unknown'}|persona:${persona}`;
            } catch (_) { return 'global'; }
        };
        const scopeKeyForAsync = async (char = null, chat = null, options = {}) => {
            const persona = await resolvePersonaId(chat, char, options);
            await refreshIndexCache();
            return scopeKeyFor(char, chat, options.fresh === true ? (persona || 'default') : persona);
        };
        const storageKeyFor = (scopeKey = '') => `${LIBRA_DATA_STORAGE_PREFIX}${stableHash(String(scopeKey || 'global'))}`;
        const cloneData = (entry) => (entry && typeof entry === 'object') ? { ...entry } : entry;
        const normalizeEntries = (entries = []) => (Array.isArray(entries) ? entries : [])
            .filter(entry => entry && typeof entry === 'object' && isLibraEntry(entry))
            .map(entry => cloneData(entry));
        // ★★ integrity 스코프 접기 — 상속·전환으로 넘어온 기록은 **부모 스코프가 찍힌 채** 온다.
        //   그러면 소비처가 목적 스코프로 검증할 때 `scope_mismatch` 가 나고, 그걸 **버린다**:
        //     08e:376  EntityManager.rebuildCache   → `continue` (엔티티 소실)
        //     08e:459  repairLegacyFieldMappings    → `continue`
        //   실측(도구 `libra_audit_inherit_integrity_measure.cjs`):
        //     부모 스코프로 찍힌 엔티티를 자식 스코프로 검증 → { ok:false, reason:'scope_mismatch' }
        //     scopeKey 만 바꾼 뒤 검증                      → { ok:true }   ← 수리 유효
        //     체크섬은 스코프를 보지 않는다(동일 checksum)  → 재계산 부담 없음
        //   `04j:112` 가 세션 전환에서 **손으로** 하던 일과 같다 — 규칙을 복제하지 않고 한 곳에 둔다.
        const integrityApi = () => {
            try { if (typeof IntegrityMetaManager !== 'undefined' && IntegrityMetaManager) return IntegrityMetaManager; } catch (_) {}
            try { return (typeof globalThis !== 'undefined' && globalThis.LIBRA_IntegrityMetaManager) || null; } catch (_) { return null; }
        };
        //   레코드 하나를 접는다. 이미 맞거나 무결성 메타가 없으면(레거시) **손대지 않는다**.
        //   체크섬은 `meta.integrity` 를 제외하고 계산되므로, 전체 레코드를 그대로 넘겨야 보존된다.
        //
        //   ★★ 두 자리를 모두 접는다 (실측 G4 — `tools/libra_copy_source_artifact_measure.cjs`):
        //     (1) `meta.integrity.scopeKey`  — **검증용** (08:117 scope_mismatch → 버려짐)
        //     (2) **payload 최상위 `scopeKey`/`chatId`** — **조회용**
        //   (2)가 빠져 있었다. 소비처가 payload 의 scopeKey 로 엔트리를 찾는다:
        //     `08e:721 getManagedScopedEntryScope` → `payload.scopeKey || … || entry.meta.scopeKey`
        //     `08e:753 findManagedScopedEntryIndex` → `exact(스코프 일치) | legacy(스코프 없음)`
        //   상속 엔트리는 **부모 스코프**라 둘 다 아니라 `-1` 이 되고, 복제본은 그 도메인 상태를
        //   **찾지 못해 새로 시작**한다(실측: `found:false, index:-1`).
        //
        //   ★★ 그리고 이 함수는 **올바른 키**를 받아야 한다. 소비처가 쓰는 키는
        //     `01c:125 getActiveManagedRuntimeScopeKey() = MemoryState._activeScopeKey || _activeChatId`
        //     01a(= `getChatRuntimeScopeKey`) 형식이지, 01f 내부 형식이 **아니다**.
        //     01f 는 01a 헬퍼에 접근할 수 없으므로 **호출자가 넘긴다**(`hydrate` 의 options).
        const payloadScopeFields = ['scopeKey', 'scopeId', 'runtimeScopeId'];
        const payloadChatFields = ['chatId', 'chat_id'];
        const rescopeRecordIntegrity = (record = null, scopeKey = '', chatId = '') => {
            const api = integrityApi();
            if (!api || !record || typeof record !== 'object') return false;
            const expected = String(scopeKey || '').trim();
            const expectedChat = String(chatId || '').trim();
            if (!expected) return false;
            let changed = false;
            for (const holder of [record, record.meta]) {
                if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;
                for (const field of payloadScopeFields) {
                    const now = String(holder[field] || '').trim();
                    if (now && now !== expected) { holder[field] = expected; changed = true; }
                }
                if (expectedChat) {
                    for (const field of payloadChatFields) {
                        const now = String(holder[field] || '').trim();
                        if (now && now !== expectedChat) { holder[field] = expectedChat; changed = true; }
                    }
                }
                if (holder.engineState && typeof holder.engineState === 'object') {
                    for (const field of payloadScopeFields) {
                        const now = String(holder.engineState[field] || '').trim();
                        if (now && now !== expected) { holder.engineState[field] = expected; changed = true; }
                    }
                    //   ★ `engineState.chatId` 도 실제로 있다 (실측: `lmai_time_engine` 누출).
                    if (expectedChat) {
                        for (const field of payloadChatFields) {
                            const now = String(holder.engineState[field] || '').trim();
                            if (now && now !== expectedChat) { holder.engineState[field] = expectedChat; changed = true; }
                        }
                    }
                }
            }
            const meta = record.meta;
            const integrity = meta && typeof meta === 'object' ? meta.integrity : null;
            if (integrity && typeof integrity === 'object' && integrity.schema
                && (changed || String(integrity.scopeKey || '').trim() !== expected)) {
                api.applyIntegrityMeta(record, {
                    domain: integrity.domain || '', recordSchema: integrity.recordSchema || '',
                    recordId: integrity.recordId || '', scopeKey: expected,
                    turn: Number(integrity.turn) || 0, source: integrity.source || ''
                });
                changed = true;
            }
            return changed;
        };
        //   저장 형식 두 가지를 모두 다룬다(비파괴 — 파싱 실패는 조용히 통과):
        //     (1) `[META:{...}]` 본문 접두  (lmai_memory)
        //     (2) 순수 JSON                (엔티티·관계·세계·시간·서사 …)
        // ★ 후보 채팅이 **데이터를 가졌는지** — 정본(HAYAKU)의 결정적 필터.
        //   `LibraHostLineage` IIFE 는 스코프 조회를 못 하므로 여기서 만들어 넘긴다.
        const branchSourceHasData = async (candidateChat = null, character = null) => {
            try {
                const scope = scopeKeyFor(character, candidateChat, null);
                if (getShadow(scope).length > 0) return true;
                try {
                    const raw = await readCanonicalRaw(scope);
                    const parsed = raw ? JSON.parse(String(raw)) : null;
                    if (normalizeEntries(parsed?.entries || []).length > 0) return true;
                } catch (_) {}
                if (VersionedCanonicalBridge.mode === "authority" || manualRouted()) return false;
                return LibraLoreConsolidator.unpackRawFromLore(
                    Array.isArray(candidateChat?.localLore) ? candidateChat.localLore
                        : (Array.isArray(character?.globalLore) ? character.globalLore : [])
                ).filter(isLibraEntry).length > 0;
            } catch (_) { return false; }
        };
        const lineageInspectWithCopy = (character = null, chat = null) =>
            LibraHostLineage.inspectWithCopy(character, chat, { hasData: branchSourceHasData });
        const rescopeEntriesIntegrity = (entries = [], scopeKey = '', chatId = '') => {
            const expected = String(scopeKey || '').trim();
            const expectedChat = String(chatId || '').trim();
            const list = Array.isArray(entries) ? entries : [];
            if (!expected) return { entries: list, changed: 0 };
            let changed = 0;
            const out = list.map(entry => {
                if (!entry || typeof entry !== 'object') return entry;
                const content = String(entry.content || '');
                const prefixEnd = content.indexOf('\n');
                if (content.startsWith('[META:') && prefixEnd > 0) {
                    const line = content.slice(0, prefixEnd);
                    let meta = null;
                    try { meta = JSON.parse(line.slice(6, line.endsWith(']') ? -1 : undefined)); } catch (_) { return entry; }
                    if (!meta || typeof meta !== 'object') return entry;
                    const body = String(content.slice(prefixEnd + 1) || '').trim();
                    if (!rescopeRecordIntegrity({ meta, content: body }, expected, expectedChat)) return entry;
                    changed += 1;
                    return { ...entry, content: `[META:${JSON.stringify(meta)}]` + content.slice(prefixEnd) };
                }
                let parsed = null;
                try { parsed = JSON.parse(content); } catch (_) { return entry; }
                if (!parsed || typeof parsed !== 'object') return entry;
                if (!rescopeRecordIntegrity(parsed, expected, expectedChat)) return entry;
                changed += 1;
                return { ...entry, content: JSON.stringify(parsed) };
            });
            return { entries: out, changed };
        };
        // Ordinary reads have no authority to adopt another scope's records.
        // Canonical/runtime format equivalence is established from the actual
        // character, chat and canonical persona, never by replacing key strings.
        const inspectHydrationIdentity = (entries = [], context = {}) => {
            const { char, chat } = context;
            const scope = String(context.scopeKey || '');
            const actualRuntime = char && chat ? getChatRuntimeScopeKey(chat, char) : '';
            const runtimeInput = context.runtimeScopeKey;
            const runtime = String(runtimeInput || actualRuntime);
            const legacyRuntime = char && chat ? getLegacyChatRuntimeScopeKey(chat, char) : '';
            const allowedScopes = new Set([scope, runtime]);
            const canonicalEnvelopeVerified = context.canonicalEnvelopeVerified === true;
            if (canonicalEnvelopeVerified) allowedScopes.add(legacyRuntime);
            const chatId = String(chat?.id || '');
            const rejectAll = reason => ({ ok: false, entries: [], excludedCount: entries.length, reasons: [reason], changed: 0 });
            let resolvedScope, runtimeChatInput;
            if (!char || !chatId || !isManagementScopeResolved(scope) || (resolvedScope = scopeKeyFor(char, chat)) !== scope
                || !actualRuntime || runtime !== actualRuntime
                || ((runtimeChatInput = context.runtimeChatId) && String(context.runtimeChatId) !== chatId)) return { ok: false, result: rejectAll('runtime_identity_mismatch') };
            return { ok: true, scope, resolvedScope, actualRuntime, runtimeInput, runtime, legacyRuntime,
                chatId, runtimeChatInput, canonicalEnvelopeVerified, allowedScopes };
        };
        // The public entry always executes this full loop. Only the closure-private
        // capsule passes a collector, over freshly parsed owned JSON temporaries.
        const inspectHydrationCore = (entries = [], context = {}, privateFacts = null, providedIdentity = null) => {
            const identity = providedIdentity || privateFacts?.identity || inspectHydrationIdentity(entries, context);
            if (!identity.ok) return identity.result;
            const { runtime, allowedScopes, chatId } = identity;
            const accepted = [], reasons = [];
            let changed = 0;
            for (const entry of entries) {
                const content = String(entry?.content || '');
                let record = null, reason = '', owner = '';
                try {
                    if (content.startsWith('[META:')) {
                        const end = content.indexOf('\n'), line = end > 0 ? content.slice(0, end) : '';
                        if (!line.endsWith(']')) throw new Error('invalid_meta');
                        record = { meta: JSON.parse(line.slice(6, -1)), content: content.slice(end + 1).trim() };
                    } else if (/^\s*[\[{]/.test(content)) record = JSON.parse(content);
                } catch (_) { reason = 'record_parse_unverified'; }
                const integrity = record?.meta?.integrity;
                if (!reason && integrity != null) {
                    owner = String(integrity?.scopeKey || '').trim();
                    const api = integrityApi();
                    // Pass the recorded owner explicitly so validation cannot fall
                    // back to whichever MemoryState happens to be active.
                    if (!integrity?.schema || !owner || !api) reason = 'record_integrity_unverified';
                    else if (!api.validateIntegrityMeta(record, { scopeKey: owner }).ok) reason = 'record_integrity_invalid';
                    else if (!allowedScopes.has(owner)) reason = 'record_scope_mismatch';
                }
                if (!reason && record && typeof record === 'object') {
                    for (const holder of [record, record.meta, record.engineState, record.meta?.engineState]) {
                        if (!holder || typeof holder !== 'object') continue;
                        if (payloadScopeFields.some(field => holder[field] && !allowedScopes.has(String(holder[field]).trim()))
                            || payloadChatFields.some(field => holder[field] && String(holder[field]).trim() !== chatId)) reason = 'payload_scope_mismatch';
                    }
                }
                if (reason) { reasons.push(reason); continue; }
                // The old representation may be mapped only when an actual
                // canonical persona envelope proves its ownership. Current records
                // stay byte-identical; every compatibility view preserves storage.
                const payloadNeedsMapping = [record, record?.meta, record?.engineState, record?.meta?.engineState]
                    .some(holder => holder && typeof holder === 'object' && payloadScopeFields.some(field => {
                        const value = String(holder[field] || '').trim();
                        return value && value !== runtime && allowedScopes.has(value);
                    }));
                if (privateFacts) {
                    const scopes = [], chats = [];
                    for (const holder of [record, record?.meta, record?.engineState, record?.meta?.engineState]) {
                        if (!holder || typeof holder !== 'object') continue;
                        for (const field of payloadScopeFields) if (holder[field]) scopes.push(String(holder[field]).trim());
                        for (const field of payloadChatFields) if (holder[field]) chats.push(String(holder[field]).trim());
                    }
                    privateFacts.facts.push(Object.freeze({ signed: integrity != null, owner,
                        scopes: Object.freeze(scopes), chats: Object.freeze(chats) }));
                }
                if ((integrity?.scopeKey && integrity.scopeKey !== runtime) || payloadNeedsMapping) {
                    if (privateFacts) privateFacts.mappingAttempted = true;
                    const mapped = rescopeEntriesIntegrity([entry], runtime, chatId);
                    accepted.push(mapped.entries[0]); changed += mapped.changed;
                } else accepted.push(entry);
            }
            return { ok: reasons.length === 0,
                entries: changed === 0 && accepted.length === entries.length && isVerifiedReadonlyEntries(entries) ? entries : accepted,
                excludedCount: reasons.length, reasons: [...new Set(reasons)], changed };
        };
        const inspectHydrationEntries = (entries = [], context = {}) => inspectHydrationCore(entries, context);
        const evaluateHydrationFacts = (facts, identity) => {
            if (!identity.ok) return false;
            for (const fact of facts) {
                if (fact.signed && (!identity.allowedScopes.has(fact.owner) || fact.owner !== identity.runtime)) return false;
                if (fact.scopes.some(scope => !identity.allowedScopes.has(scope) || scope !== identity.runtime)) return false;
                if (fact.chats.some(chat => chat !== identity.chatId)) return false;
            }
            return true;
        };
        // 활성 스코프 — unpack 은 로어 배열만 받아서 char/chat 신원을 모른다.
        // 그래서 scopeKeyFor 가 `char:unknown|chat:unknown|persona:default` 를 돌려주고,
        // shadow 조회가 실패해 **로어 경로로 읽는 80곳이 전부 빈손**이 된다
        // (스토리지 이전 후 로어에는 lmai_* 가 없으므로).
        // hydrate/저장이 마지막으로 해석한 스코프를 기억해 두고 unpack 이 폴백으로 쓴다.
        let _activeScopeKey = '';
        const setActiveScope = (scopeKey = '') => {
            const key = String(scopeKey || '').trim();
            if (key && !/char:unknown\|chat:unknown\|persona:default/.test(key)) _activeScopeKey = key;
            return _activeScopeKey;
        };
        const getActiveScope = () => _activeScopeKey;
        const invalidateRuntimeView = scopeKey => {
            const scope = String(scopeKey || '');
            invalidateScopeWriters(scope);
            validationSources.retire(scope);
            shadow.delete(scope);
            hydratedScopes.delete(scope);
            hydrationDiagnostics.set(scope, { readOnly: true, excludedCount: 0, reasons: ['persona_runtime_unavailable'] });
            if (_activeScopeKey === scope) _activeScopeKey = '';
        };
        const getShadow = (scopeKey = '') => {
            const key = String(scopeKey || 'global');
            if (!shadow.has(key)) shadow.set(key, []);
            return shadow.get(key);
        };
        const load = (charArg = null, chatArg = null) => {
            const { char, chat } = args(charArg, chatArg);
            const scopeKey = scopeKeyFor(char, chat);
            const fromLore = LibraLoreConsolidator.unpackRawFromLore(
                Array.isArray(chat?.localLore) ? chat.localLore
                    : (Array.isArray(char?.globalLore) ? char.globalLore : (Array.isArray(char?.lorebook) ? char.lorebook : []))
            ).filter(isLibraEntry);
            const fromShadow = getShadow(scopeKey);
            if (manualRouted()) return fromShadow.map(entry => cloneData(entry));
            if (fromLore.length === 0) return fromShadow.map(entry => cloneData(entry));
            // 로어에 남은 항목이 있으면 그것을 우선하고, 섀도와 키 기준으로 합친다.
            const seen = new Set(fromLore.map(entry => String(entry?.key || '')));
            return [...fromLore.map(entry => cloneData(entry)),
                ...fromShadow.filter(entry => !seen.has(String(entry?.key || ''))).map(entry => cloneData(entry))];
        };
        const publishVerifiedView = (char, chat, scopeKey, entries) => {
            const inspected = inspectHydrationEntries(entries, { char, chat, scopeKey,
                runtimeScopeKey: getChatRuntimeScopeKey(chat, char), runtimeChatId: PersonaScopeIdentity.ids(char, chat).chatId,
                canonicalEnvelopeVerified: true });
            if (!inspected.ok) return { ok: false, reason: 'canonical_provenance_unverified' };
            shadow.set(scopeKey, normalizeEntries(inspected.entries));
            hydratedScopes.add(scopeKey);
            hydrationDiagnostics.set(scopeKey, { readOnly: false, excludedCount: 0, reasons: [] });
            setActiveScope(scopeKey);
            return { ok: true, entries: inspected.entries };
        };
        const hydrate = async (charArg = null, chatArg = null, options = {}) => {
            const { char, chat } = args(charArg, chatArg);
            const scopeKey = await scopeKeyForAsync(char, chat);
            const pendingAdmission=await WmPendingAdmission.forChat(char,chat,"hydrate");
            if(!pendingAdmission.ok)return {...pendingAdmission,scopeKey,entryCount:0};
            // Runtime options are checked against the actual character/chat below;
            // they are not authority to adopt foreign records.
            const runtimeScopeKey = String(options?.runtimeScopeKey || '').trim();
            const runtimeChatId = String(options?.runtimeChatId || chat?.id || '').trim();
            const storageKey = storageKeyFor(scopeKey);
            try {
                const raw = await readCanonicalRaw(scopeKey, { strict: true, authorityRequest: options.authorityRequest });
                let parsed = null;
                try { parsed = raw ? JSON.parse(String(raw)) : null; } catch (_) { parsed = null; }
                let entries = normalizeEntries(parsed?.entries || parsed || []);
                setActiveScope(scopeKey);
                if (raw !== null && raw !== undefined) {
                    const envelopeMatches = parsed && !Array.isArray(parsed) && parsed.scopeKey === scopeKey && Array.isArray(parsed.entries);
                    const inspected = envelopeMatches
                        ? inspectHydrationEntries(entries, { char, chat, scopeKey, runtimeScopeKey, runtimeChatId, canonicalEnvelopeVerified: true })
                        : { ok: false, entries: [], excludedCount: entries.length, reasons: ['canonical_envelope_unverified'], changed: 0 };
                    shadow.set(scopeKey, inspected.entries);
                    hydratedScopes.add(scopeKey);
                    hydrationDiagnostics.set(scopeKey, { readOnly: !inspected.ok, excludedCount: inspected.excludedCount, reasons: inspected.reasons });
                    if (!inspected.ok) {
                        try { recordRuntimeDebug('warn', '[LIBRA][Storage] canonical provenance unverified; stored data preserved, read-only', { excludedCount: inspected.excludedCount, reasons: inspected.reasons }); } catch (_) {}
                        return { ok: false, scopeKey, source: 'storage', reason: 'canonical_provenance_unverified', entryCount: inspected.entries.length, excludedCount: inspected.excludedCount };
                    }
                    return { ok: true, scopeKey, entryCount: inspected.entries.length, source: 'storage', rescopedRuntime: inspected.changed };
                }
                if (VersionedCanonicalBridge.mode === "authority") return {ok:false,scopeKey,reason:"authority_migration_token_required"};
                hydrationDiagnostics.delete(scopeKey);
                // 스토리지가 비었고 로어에 lmai_* 가 남아 있으면 흡수한다 (무중단 이전).
                const legacyLore = Array.isArray(chat?.localLore) ? chat.localLore
                    : (Array.isArray(char?.globalLore) ? char.globalLore : (Array.isArray(char?.lorebook) ? char.lorebook : []));
                const legacyEntries = manualRouted() ? [] : LibraLoreConsolidator.unpackRawFromLore(legacyLore).filter(isLibraEntry);
                if (legacyEntries.length > 0) {
                    const previousShadow = shadow.get(scopeKey);
                    // Absorption must not remove the only host copy before the
                    // storage result is known. Host cleanup is a separate action.
                    const saved = await save(char ? { ...char } : null, chat ? { ...chat } : null, legacyEntries);
                    if (!saved.ok) {
                        if (previousShadow) shadow.set(scopeKey, previousShadow);
                        else shadow.delete(scopeKey);
                        hydrationDiagnostics.set(scopeKey, { readOnly: true, excludedCount: 0, reasons: ['legacy_absorption_unverified'] });
                        return { ok: false, scopeKey, reason: 'legacy_absorption_unverified', entryCount: 0 };
                    }
                    return { ok: true, scopeKey, entryCount: legacyEntries.length, source: 'legacy-lore-absorbed' };
                }
                if(manualRouted() && await WmManualRuntime.isTombstone('plugin',storageKey)) {
                    shadow.set(scopeKey,[]);hydratedScopes.add(scopeKey);return {ok:true,scopeKey,entryCount:0,source:'manual-tombstone'};
                }
                // 스토리지도 로어도 비었고, 네이티브 브랜치 표식이 있으면 부모 기억을 물려받는다.
                try {
                    const inherited = await inheritFromBranch(char, chat, { runtimeScopeKey, runtimeChatId });
                    if (inherited?.ok && inherited.inherited > 0) {
                        return { ok: true, scopeKey, entryCount: inherited.inherited, source: 'branch_inheritance', from: inherited.from };
                    }
                    if (inherited?.ok === false) {
                        hydrationDiagnostics.set(scopeKey, { readOnly: true, excludedCount: Number(inherited.excludedCount) || 0, reasons: ['branch_source_unverified'] });
                        return { ok: false, scopeKey, entryCount: 0, reason: 'branch_source_unverified' };
                    }
                } catch (_) {
                    hydrationDiagnostics.set(scopeKey, { readOnly: true, excludedCount: 0, reasons: ['branch_source_unverified'] });
                    return { ok: false, scopeKey, entryCount: 0, reason: 'branch_source_unverified' };
                }
                shadow.set(scopeKey, []);
                hydratedScopes.add(scopeKey);
                return { ok: true, scopeKey, entryCount: 0, source: 'empty' };
            } catch (error) {
                const previous = getHydrationDiagnostics(scopeKey);
                hydrationDiagnostics.set(scopeKey, { ...previous, readOnly: true,
                    reasons: [...new Set([...previous.reasons, 'canonical_read_unavailable'])] });
                try { recordRuntimeDebug('warn', '[LIBRA][Storage] canonical read unavailable; prior data and read-only guard preserved'); } catch (_) {}
                return { ok: false, scopeKey, reason: 'canonical_read_unavailable' };
            }
        };
        const save = async (charArg = null, chatArg = null, entryArg = []) => {

            if (Object.prototype.hasOwnProperty.call(saveOptions, 'normalizationFence')
                && (VersionedCanonicalBridge.mode === 'authority' || manualRouted()))
                return { ok: false, reason: 'normalization_backend_unsupported', uncertain: false };
            const capturedMutation = mutationSerial;
            const parsed = args(charArg, chatArg);
            const char = parsed.char; const chat = parsed.chat;
            const entries = parsed.entries || entryArg;
            const expectedGeneration = capturedGeneration(char, chat);
            const ownedNormalization = Object.prototype.hasOwnProperty.call(saveOptions, 'normalizationFence');
            const fence = ownedNormalization && saveOptions.normalizationFence ? Object.freeze({ ...saveOptions.normalizationFence }) : null;
            if (ownedNormalization && (!fence || !Object.prototype.hasOwnProperty.call(fence, 'expectedRaw')
                || !(fence.expectedRaw === null || typeof fence.expectedRaw === 'string')
                || fence.expectedGeneration !== expectedGeneration
                || ['prewriteGuard', 'runtimeGuard', 'freshTargetCheck'].some(name => typeof fence[name] !== 'function')))
                return { ok: false, reason: 'normalization_fence_invalid', uncertain: false };
            let normalizationInvalidated = false;
            const normalizationCurrent = (prewrite = false) => {
                if (!ownedNormalization) return true;
                try {
                    if (!normalizationInvalidated && fence.runtimeGuard() === true
                        && (!prewrite || fence.prewriteGuard() === true)
                        && capturedGeneration(char, chat) === expectedGeneration) return true;
                } catch (_) {}
                normalizationInvalidated = true;
                return false;
            };
            if (!normalizationCurrent(true)) return { ok: false, reason: 'normalization_source_invalidated', uncertain: false };
            const scopeKey = await scopeKeyForAsync(char, chat);
            if (ownedNormalization && !isManagementScopeResolved(scopeKey)) return { ok: false, scopeKey, reason: 'normalization_identity_unresolved', uncertain: false };
            const pendingAdmission=await WmPendingAdmission.forChat(char,chat,"save");if(!pendingAdmission.ok)return pendingAdmission;
            if(WmWriterRuntime.enabled&&!saveOptions.expectedSource)saveOptions={...saveOptions,expectedSource:WmWriterRuntime.latestSource(scopeKey)};
            if (VersionedCanonicalBridge.mode === "authority" && !VersionedCanonicalBridge.validateSource(scopeKey,saveOptions.expectedSource).ok) return {ok:false,reason:"authority_write_token_required"};
            return withScopeWrite(scopeKey, async () => {
                // Fence old work before any cache or host mutation. The queue
                // serializes writers in this runtime; it is not cross-runtime CAS.
                let previousEnvelope = {};
                let ownedWriteIssued = false, acknowledgedRaw = null;
                if (!normalizationCurrent(true)) return { ok: false, scopeKey, reason: 'normalization_source_invalidated', uncertain: false };
                if (isManagementScopeResolved(scopeKey)) {
                    const before = await readVerified(scopeKey);
                    if (!before.ok) return { ok: false, scopeKey, reason: before.reason };
                    if (VersionedCanonicalBridge.mode === "authority" && !VersionedCanonicalBridge.matches(saveOptions.expectedSource,before.authoritySource)) return {ok:false,scopeKey,reason:"authority_source_changed"};
                    if (before.resetGeneration !== expectedGeneration) return { ok: false, scopeKey, reason: 'reset_generation_changed' };
                    if (ownedNormalization) {
                        if (before.raw !== fence.expectedRaw) return { ok: false, scopeKey, reason: 'normalization_source_changed', uncertain: false };
                        let targetCurrent = false;
                        try { targetCurrent = await fence.freshTargetCheck() === true; } catch (_) {}
                        if (!targetCurrent || !normalizationCurrent(true)) return { ok: false, scopeKey, reason: 'normalization_source_invalidated', uncertain: false };
                        const observedAgain = await readVerified(scopeKey);
                        if (!observedAgain.ok || observedAgain.raw !== fence.expectedRaw || observedAgain.resetGeneration !== expectedGeneration)
                            return { ok: false, scopeKey, reason: 'normalization_source_changed', uncertain: false };
                        if (!normalizationCurrent(true)) return { ok: false, scopeKey, reason: 'normalization_source_invalidated', uncertain: false };
                        acknowledgedRaw = before.raw;
                    }
                    previousEnvelope = before.missing ? {} : JSON.parse(before.raw);
                }
                if (getHydrationDiagnostics(scopeKey).readOnly) return { ok: false, scopeKey, reason: 'canonical_provenance_unverified' };
                if (scopeKeyFor(char, chat) !== scopeKey) return { ok: false, scopeKey, reason: 'stale_identity' };
                if (capturedGeneration(char, chat) !== expectedGeneration) return { ok: false, scopeKey, reason: 'reset_generation_changed' };
                if ((scopeMutations.get(scopeKey) || 0) > capturedMutation) return { ok: false, scopeKey, reason: 'canonical_operation_invalidated' };
                const normalized = normalizeEntries(entries);
                const hostOwner = Array.isArray(chat?.localLore) ? chat : (Array.isArray(char?.globalLore) ? char : null);
                const hostField = hostOwner === chat ? 'localLore' : 'globalLore';
                const hostBefore = hostOwner ? JSON.stringify(hostOwner[hostField]) : null;
                try {
                    // The strict current read above is mandatory even when nothing
                    // changed. Only an already normalized envelope with exactly the
                    // requested records can retain its last actual-write timestamp.
                    const unchanged = previousEnvelope.scopeKey === scopeKey
                        && previousEnvelope.version !== null && previousEnvelope.version !== undefined
                        && Number.isFinite(previousEnvelope.updatedAt)
                        && previousEnvelope.entryCount === normalized.length
                        && previousEnvelope.resetGeneration === expectedGeneration
                        && JSON.stringify(previousEnvelope.entries) === JSON.stringify(normalized);
                    if (!normalizationCurrent(true)) return { ok: false, scopeKey, reason: 'normalization_source_invalidated', uncertain: false };
                    if (!unchanged) {
                        const payload = JSON.stringify({ ...previousEnvelope, version: previousEnvelope.version ?? '1.0', scopeKey,
                            entryCount: normalized.length, updatedAt: Date.now(), entries: normalized, resetGeneration: expectedGeneration });
                        // A rejected/lost acknowledgement cannot publish provisional
                        // memory. Exact readback proves the captured write's outcome.
                        let authorityCommit = null;
                        const validationWrite = validationSources.beginWrite(scopeKey);
                        try {
                            // The build factory inserts its baseline-owner call at
                            // the set seam; include that call in marker cleanup too.
                            if (VersionedCanonicalBridge.mode === 'authority') {
                                baselineWriteTicket = LatestTurnBaselineOwner.beforeWrite(scopeKey, saveOptions.reanalysisBaselineToken, baselineVerifiedRaw);
                                authorityCommit = await VersionedCanonicalBridge.commit(scopeKey,saveOptions.expectedSource,payload,WmWriterRuntime.enabled?(saveOptions.operation||'normal'):'normal');
                                if (!authorityCommit.ok) return {ok:false,scopeKey,reason:authorityCommit.reason,uncertain:authorityCommit.uncertain===true};
                            } else if (ownedNormalization) {
                                baselineWriteTicket = LatestTurnBaselineOwner.beforeWrite(scopeKey, saveOptions.reanalysisBaselineToken, baselineVerifiedRaw);
                                ownedWriteIssued = true;
                                try {
                                    if (await RisuCompat.pluginStorage.setItem(storageKeyFor(scopeKey), payload, {
                                        strict: true, isCurrent: () => normalizationCurrent() && scopeKeyFor(char, chat) === scopeKey
                                            && (scopeMutations.get(scopeKey) || 0) <= capturedMutation && !getHydrationDiagnostics(scopeKey).readOnly
                                    }) !== true) throw new Error('canonical_save_unverified');
                                } catch (error) {
                                    if (error?.storageWriteUnverified === false) ownedWriteIssued = false;
                                    throw error;
                                }
                            } else {
                            try { await RisuCompat.pluginStorage.setItem(storageKeyFor(scopeKey), payload); } catch (_) {}
                            }
                        } finally { validationSources.endWrite(validationWrite); }
                        if (!normalizationCurrent()) return { ok: false, uncertain: ownedWriteIssued, scopeKey, reason: 'normalization_source_invalidated' };
                        const readbackSource = await readCanonicalSource(scopeKey,{strict:true});
                        const readback = readbackSource.raw;
                        if (authorityCommit && !VersionedCanonicalBridge.sameHead(readbackSource.head,authorityCommit.head)) return {ok:false,scopeKey,reason:'authority_source_changed',uncertain:true};
                        // Adapter readback may await a concurrent reset before this
                        // caller read. Preserve the more specific invalidation result.
                        if (scopeKeyFor(char, chat) !== scopeKey) return { ok: false, uncertain: true, scopeKey, reason: 'stale_identity' };
                        if (capturedGeneration(char, chat) !== expectedGeneration) return { ok: false, uncertain: true, scopeKey, reason: 'reset_generation_changed' };
                        if (readback !== payload) return { ok: false, uncertain: true, scopeKey, reason: 'canonical_save_unverified' };
                        if (ownedNormalization) acknowledgedRaw = readback;
                    }
                    if (scopeKeyFor(char, chat) !== scopeKey) return { ok: false, uncertain: true, scopeKey, reason: 'stale_identity' };
                    if (capturedGeneration(char, chat) !== expectedGeneration) return { ok: false, uncertain: true, scopeKey, reason: 'reset_generation_changed' };
                    if ((scopeMutations.get(scopeKey) || 0) > capturedMutation || getHydrationDiagnostics(scopeKey).readOnly)
                        return { ok: false, uncertain: true, scopeKey, reason: 'canonical_operation_invalidated' };
                    if (!normalizationCurrent()) return { ok: false, uncertain: ownedWriteIssued, scopeKey, reason: 'normalization_source_invalidated' };
                    shadow.set(scopeKey, normalized);
                    hydratedScopes.add(scopeKey);
                    // Do not remove additions made while persistence was awaited.
                    // Host persistence itself remains the caller's responsibility.
                    if (!WmWriterRuntime.enabled && !manualRouted() && hostOwner && JSON.stringify(hostOwner[hostField]) === hostBefore) {
                        const preserved = new Set(normalized.map(entry => JSON.stringify(entry)));
                        hostOwner[hostField] = hostOwner[hostField].filter(entry => !isLibraEntry(entry) || !preserved.has(JSON.stringify(entry)));
                    }
                    if (ownedNormalization) {
                        LatestTurnBaselineOwner.verifiedWrite(scopeKey, baselineWriteTicket, baselineVerifiedRaw);
                        return { ok: true, verified: true, unchanged, scopeKey, entryCount: normalized.length, resetGeneration: expectedGeneration, acknowledgedRaw };
                    }
                    return { ok: true, verified: true, unchanged, scopeKey, entryCount: normalized.length, resetGeneration: expectedGeneration };
                } catch (error) {
                    try { recordRuntimeDebug('warn', '[LIBRA][Storage] save failed:', error?.message || error); } catch (_) {}
                    return { ok: false, uncertain: ownedNormalization ? ownedWriteIssued : true, scopeKey, reason: ownedNormalization && !normalizationCurrent() ? 'normalization_source_invalidated' : 'canonical_save_unverified' };
                }
            });
        };
        // Management adds strict entry validation and target-currentness checks;
        // it never mutates a host object or falls back to it.
        const isManagementScopeResolved = scope => {
            const match = /^char:(.+)\|chat:(.+)\|persona:(.+)$/.exec(String(scope || ''));
            return !!match && [match[1], match[2]].every(id => id !== 'unknown' && !/^(?:char|chat)Index:/.test(id));
        };
        const readCanonicalSource = async (scope, options = {}) => {
            const pendingAdmission=await WmPendingAdmission.forScope(scope,"read");if(!pendingAdmission.ok)throw new Error(pendingAdmission.reason);
            if (VersionedCanonicalBridge.mode !== 'authority') return {ok:true,raw:await RisuCompat.pluginStorage.getItem(storageKeyFor(scope), options)};
            const result = await VersionedCanonicalBridge.read(scope, options.authorityRequest);
            if (!result.ok) throw new Error(result.reason);
            return result;
        };
        const readCanonicalRaw = async (scope, options = {}) => (await readCanonicalSource(scope, options)).raw;
        // Native inventory must inspect exact stored bytes without hydration,
        // fallback, rescoping, or cached/authority reads.
        const readInventoryCanonical = async (scopeKey = '') => {
            const raw = await RisuCompat.pluginStorage.getItem(storageKeyFor(scopeKey), {strict:true});
            if (raw == null) return {ok:true,missing:true,scopeKey,storageKey:storageKeyFor(scopeKey),raw:null};
            if (typeof raw !== 'string') throw new Error('WM_canonical_invalid');
            const checked = parseCanonicalReadonlyValue(raw, scopeKey);
            if (!checked.ok) throw new Error('WM_canonical_scope_unverified');
            return {ok:true,missing:false,scopeKey,storageKey:storageKeyFor(scopeKey),raw};
        };
        let readonlyReadProof = null, readonlyAuthorityOwner = null;
        clearNativeReadonlyFallback = scope => {
            if (scope === undefined || readonlyReadProof?.scopeKey === scope) { readonlyReadProof = null; readonlyAuthorityOwner = null; }
        };
        clearAuthorityReadonlyProof = owner => {if (readonlyAuthorityOwner === owner) {readonlyReadProof=null;readonlyAuthorityOwner=null;} WmReadonlyDerivedCache.releaseRequest(owner);};
        const readonlyEntries = new WeakSet(), readonlySourceBindings = new WeakMap();
        const isVerifiedReadonlyEntries = entries => readonlyEntries.has(entries);
        const verifiedReadonlySourceBinding = entries => readonlySourceBindings.get(entries) || null;
        const freezeReadProof = value => {
            if (value && typeof value === 'object') { Object.values(value).forEach(freezeReadProof); Object.freeze(value); }
            return value;
        };
        const parseCanonicalReadonlyValue = (raw, scope) => {
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.scopeKey !== scope
                    || !Array.isArray(parsed.entries) || parsed.entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || !isLibraEntry(entry))) return { ok: false, reason: 'canonical_invalid' };
                const resetGeneration = Object.prototype.hasOwnProperty.call(parsed, 'resetGeneration') ? parsed.resetGeneration : 0;
                if (!Number.isSafeInteger(resetGeneration) || resetGeneration < 0) return { ok: false, reason: 'canonical_invalid' };
                return { ok: true, value: { entries: parsed.entries, resetGeneration, scopeKey: scope } };
            } catch (_) { return { ok: false, reason: 'canonical_invalid' }; }
        };
        const readVerified = async (scopeKey = '', options = {}) => {
            const scope = String(scopeKey || '').trim();
            const fail = reason => { readonlyReadProof = null; return { ok: false, missing: false, scopeKey: scope, reason }; };
            if (!isManagementScopeResolved(scope)) return fail('identity_unresolved');
            const storageKey = storageKeyFor(scope);
            const nativeReadonly = options.readonly === true && options.authorityRequest && WmNativeReadonlyDerivedCache.enabled && VersionedCanonicalBridge.mode === 'native';
            const openedNativeRead = nativeReadonly ? WmNativeReadonlyDerivedCache.beginRead(options.authorityRequest, scope) : null;
            if (openedNativeRead && !openedNativeRead.ok) return fail(openedNativeRead.reason);
            const nativeRead = openedNativeRead?.value;
            try {
            let raw, authorityObservation = null;
            try { authorityObservation = await readCanonicalSource(scope, { strict: true, authorityRequest: options.authorityRequest }); raw = authorityObservation.raw; }
            catch (_) { return fail('canonical_read_unavailable'); }
            if (nativeRead && !WmNativeReadonlyDerivedCache.validateRead(nativeRead)) return fail('native_derived_request_closed');
            if (raw === null || raw === undefined) {
                readonlyReadProof = null;
                const legacyScope = scope.replace(/\|persona:[\s\S]*$/, '|persona:default');
                if (legacyScope !== scope && !WmWriterRuntime.enabled) {
                    let legacyRaw;
                    try { legacyRaw = await readCanonicalRaw(legacyScope, { strict: true, authorityRequest: options.authorityRequest }); }
                    catch (_) { return fail('canonical_read_unavailable'); }
                    if (legacyRaw !== null && legacyRaw !== undefined) return fail('legacy_persona_ambiguous');
                }
                if (nativeRead && !WmNativeReadonlyDerivedCache.validateRead(nativeRead)) return fail('native_derived_request_closed');
                return { ok: true, missing: true, scopeKey: scope, storageKey, raw: null, entries: [], resetGeneration: 0, ...(authorityObservation.sourceToken ? {authoritySource:authorityObservation.sourceToken} : {}) };
            }
            try {
                // The strict storage read above still verifies every physical chunk.
                // Exact byte equality permits immutable parse reuse, never a cached
                // physical read or a previous scope/currentness verdict.
                if (!nativeRead && options.readonly === true && readonlyReadProof?.scopeKey === scope && readonlyReadProof.raw === raw
                    && (!authorityObservation.sourceToken || readonlyReadProof.authoritySource === authorityObservation.sourceToken)) return readonlyReadProof;
                const nativeFallback = nativeRead && readonlyReadProof?.scopeKey === scope && readonlyReadProof.raw === raw && !readonlyReadProof.authoritySource
                    ? { entries: readonlyReadProof.entries, resetGeneration: readonlyReadProof.resetGeneration, scopeKey: scope } : null;
                const derived = nativeRead
                    ? await WmNativeReadonlyDerivedCache.parseReadonly({ read: nativeRead, raw, storageKey, parse: parseCanonicalReadonlyValue, fallbackValue: nativeFallback })
                    : options.readonly === true && options.authorityRequest && authorityObservation.sourceToken && WmReadonlyDerivedCache.enabled
                    ? await WmReadonlyDerivedCache.parseReadonly({ request: options.authorityRequest, scope, storageKey, raw, head: authorityObservation.head,
                        sourceToken: authorityObservation.sourceToken, parse: parseCanonicalReadonlyValue })
                    : parseCanonicalReadonlyValue(raw, scope);
                if (nativeRead && !WmNativeReadonlyDerivedCache.validateRead(nativeRead)) return fail('native_derived_request_closed');
                if (!derived.ok) return fail(derived.reason);
                const parsed = derived.value, resetGeneration = parsed.resetGeneration;
                if (VersionedCanonicalBridge.mode === 'native') raw = reuseVerifiedBaselinePostRaw(scope, resetGeneration, raw);
                // JSON.parse above already creates a private tree for this exact
                // strict read. Keep ownership without serializing/parsing it again.
                const result = { ok: true, missing: false, scopeKey: scope, storageKey, raw, entries: parsed.entries, resetGeneration, ...(authorityObservation.sourceToken ? {authoritySource:authorityObservation.sourceToken} : {}) };
                if (options.readonly === true) {
                    if (derived.cached || derived.immutable) Object.freeze(result); else freezeReadProof(result); readonlyEntries.add(result.entries);
                    if (nativeRead && derived.cached) clearNativeReadonlyFallback();
                    else if (!authorityObservation.sourceToken || options.authorityRequest) {readonlyReadProof = result;readonlyAuthorityOwner=options.authorityRequest||null;}
                    readonlySourceBindings.set(result.entries, Object.freeze({ scopeKey: scope, resetGeneration }));
                }
                return result;
            } catch (_) { return fail('canonical_invalid'); }
            } finally { if (nativeRead) WmNativeReadonlyDerivedCache.finishRead(nativeRead); }
        };
        const preparePersonaContextCore = async (char = null, chat = null, owned = null, sourceOptions = {}) => {
            const pendingAdmission=await WmPendingAdmission.forChat(char,chat,"prepare");if(!pendingAdmission.ok)return {...pendingAdmission,readOnly:true};
            const ownedHostEligible = owned ? isOwnedHydrationHostEligible(char, chat) : false;
            const identity = PersonaScopeIdentity.ids(char, chat), hint = PersonaScopeIdentity.bindingHint(chat, char);
            const capturedProof = PersonaScopeIdentity.snapshotProof(char, chat);
            const fail = (reason, extra = {}) => ({ ok: false, readOnly: true, reason, ...identity, ...extra });
            const sameTargetSnapshot = () => {
                const current = PersonaScopeIdentity.ids(char, chat), binding = PersonaScopeIdentity.bindingHint(chat, char);
                return current.characterId === identity.characterId && current.chatId === identity.chatId
                    && !binding.invalid && binding.explicit === hint.explicit && binding.id === hint.id;
            };
            if (!identity.characterId || !identity.chatId) return fail('identity_unresolved');
            if (hint.invalid) return fail('persona_binding_invalid');
            const readActivePersona = async () => {
                let activeChar, activeChat, db;
                try { db = await RisuCompat.database.get(['personas', 'selectedPersona']); }
                catch (_) { return fail('persona_read_unavailable'); }
                if (!db || !Array.isArray(db.personas)) return fail('persona_read_unavailable');
                // With no personas there is no active selection to borrow. This
                // also proves the default identity of a captured inactive chat.
                if (!db.personas.length) return { ok: true, personaId: 'default', source: 'no_personas' };
                try {
                    activeChar = await RisuCompat.getCharacter();
                    const ci = await RisuCompat.getCurrentCharacterIndex();
                    const ti = await RisuCompat.getCurrentChatIndex();
                    activeChat = RisuCompat.has('getChatFromIndex') ? await RisuCompat.getChatFromIndex(ci, ti) : activeChar?.chats?.[ti];
                } catch (_) { return fail('persona_target_not_active'); }
                const active = PersonaScopeIdentity.ids(activeChar, activeChat);
                if (active.characterId !== identity.characterId || active.chatId !== identity.chatId) return fail('persona_target_not_active');
                const index = Number(db.selectedPersona);
                if (db.selectedPersona == null || String(db.selectedPersona).trim() === '' || !Number.isInteger(index) || !db.personas[index]) return fail('persona_identity_unresolved');
                const selected = db.personas[index];
                const personaId = [selected.id, selected._id, selected.key].find(value => typeof value === 'string' && value.trim())?.trim() || '';
                return personaId ? { ok: true, personaId, source: 'active_selection' } : fail('persona_identity_unresolved');
            };
            let personaId = hint.id, source = 'explicit_binding';
            if (!hint.explicit) {
                const selected = await readActivePersona();
                if (!selected.ok) return selected;
                personaId = selected.personaId; source = selected.source;
                const previous = PersonaScopeIdentity.snapshotProof(char, chat);
                if (previous && previous.personaId !== personaId) return fail('stale_persona_context');
            }
            // Validate against a private identity snapshot. Rejected or pending
            // admission must not change scope routing for the caller's snapshot.
            const validationChat = { ...chat, bindedPersona: personaId };
            const scopeKey = scopeKeyFor(char, chat, personaId), runtimeScopeKey = getChatRuntimeScopeKey(validationChat, char);
            const context = { ...identity, personaId, source, scopeKey, runtimeScopeKey };
            const privateIdentityChanged = owned && (!owned.admission || owned.admission.scopeKey !== scopeKey || owned.admission.runtimeScopeKey !== runtimeScopeKey);
            if (privateIdentityChanged) OwnedHydrationValidation.close(owned.capsule);
            const observation = owned ? await OwnedHydrationValidation.read(owned.capsule, scopeKey) : null;
            const canonical = owned ? observation.read : await readVerified(scopeKey, { readonly: true, authorityRequest: sourceOptions.authorityRequest });
            if (!sameTargetSnapshot()) return fail('stale_persona_context', context);
            if (!canonical.ok) {
                hydrationDiagnostics.set(scopeKey, { readOnly: true, excludedCount: 0, reasons: [canonical.reason] });
                return fail(canonical.reason, context);
            }
            if ((owned?.admission && owned.admission.resetGeneration !== canonical.resetGeneration)
                || (capturedProof?.personaId === personaId && (capturedProof.resetGeneration ?? 0) !== canonical.resetGeneration)) {
                return fail('reset_generation_changed', context);
            }
            if (privateIdentityChanged) return fail('canonical_identity_changed', context);
            if (owned && !['issued', 'missing'].includes(observation.status)) return fail('validation_source_stale', context);
            const host = Array.isArray(chat.localLore) ? chat.localLore : (Array.isArray(char.globalLore) ? char.globalLore : []);
            if (canonical.missing && ((!manualRouted() && LibraLoreConsolidator.unpackRawFromLore(host).some(isLibraEntry)) || getShadow(scopeKey).length)) return fail('canonical_missing_unverified_data', context);
            if (canonical.missing && getHydrationDiagnostics(scopeKey).reasons.includes('branch_source_unverified')) return fail('branch_source_unverified', context);
            if (!canonical.missing) {
                const hydrationContext = { char, chat: validationChat, scopeKey, runtimeScopeKey, runtimeChatId: identity.chatId, canonicalEnvelopeVerified: true };
                const inspected = owned
                    ? OwnedHydrationValidation.inspect(owned.capsule, observation, canonical.entries, hydrationContext, ownedHostEligible)
                    : inspectHydrationEntries(canonical.entries, hydrationContext);
                if (!inspected.ok) {
                    hydrationDiagnostics.set(scopeKey, { readOnly: true, excludedCount: inspected.excludedCount, reasons: inspected.reasons });
                    return fail('canonical_provenance_unverified', context);
                }
            }
            if (!hint.explicit) {
                const current = await readActivePersona();
                if (!current.ok) return current;
                if (current.personaId !== personaId) return fail('stale_persona_context', context);
            }
            if (!sameTargetSnapshot()) return fail('stale_persona_context', context);
            PersonaScopeIdentity.remember(char, chat, personaId, source, canonical.resetGeneration);
            return { ok: true, readOnly: false, ...context, missing: canonical.missing, canonicalRaw: canonical.raw, resetGeneration: canonical.resetGeneration };
        };
        const preparePersonaContext = async (char = null, chat = null, options = {}) => preparePersonaContextCore(char, chat, null, options);
        // Private admission optimizes only ordinary native snapshots. Descriptors
        // detect accessors without invoking them; this is not a Proxy detector.
        const ordinaryHydrationObject = value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const prototype = Object.getPrototypeOf(value);
            if (prototype && Object.getPrototypeOf(prototype) !== null) return false;
            return Object.values(Object.getOwnPropertyDescriptors(value)).every(d => Object.prototype.hasOwnProperty.call(d, 'value'));
        };
        const ordinaryHydrationArray = value => {
            if (!Array.isArray(value)) return false;
            const prototype = Object.getPrototypeOf(value), parent = prototype && Object.getPrototypeOf(prototype);
            return Array.isArray(prototype) && !!parent && Object.getPrototypeOf(parent) === null
                && Reflect.ownKeys(value).every(key => typeof key === 'string' && (key === 'length' || /^(?:0|[1-9][0-9]*)$/.test(key)))
                && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => Object.prototype.hasOwnProperty.call(d, 'value'));
        };
        const ordinaryHydrationIdentity = context => {
            if (!ordinaryHydrationObject(context)) return false;
            const charDescriptor = Object.getOwnPropertyDescriptor(context, 'char'), chatDescriptor = Object.getOwnPropertyDescriptor(context, 'chat');
            if (!charDescriptor || !chatDescriptor) return false;
            const char = charDescriptor.value, chat = chatDescriptor.value;
            if (!ordinaryHydrationObject(char) || !ordinaryHydrationObject(chat)) return false;
            const scalarFields = ['id', '_id', 'uid', 'uuid', 'key', 'chaId', 'chatId', 'chatPage', '_index',
                'bindedPersona', 'boundPersonaId', 'boundPersona', 'personaId', 'persona', 'sectionId', 'sectionName',
                'branchId', 'branchName', 'folderId', 'pageId', 'tabId', 'roomId', 'threadId', 'chatroomId',
                'conversationId', 'sessionId', 'name', 'title'];
            const scalar = value => value == null || ['string', 'number', 'boolean'].includes(typeof value);
            const ownScalar = (value, key) => {
                const d = Object.getOwnPropertyDescriptor(value, key);
                return d ? Object.prototype.hasOwnProperty.call(d, 'value') && scalar(d.value) : !(key in value);
            };
            const native = value => ordinaryHydrationObject(value) && scalarFields.every(key => ownScalar(value, key));
            if (!native(char) || !native(chat)) return false;
            for (const key of ['section', 'branch', 'folder']) {
                const descriptor = Object.getOwnPropertyDescriptor(chat, key);
                if (!descriptor) { if (key in chat) return false; continue; }
                const value = descriptor.value;
                if (value != null && (!ordinaryHydrationObject(value) || !['id', 'name'].every(field => ownScalar(value, field)))) return false;
            }
            const chats = Object.getOwnPropertyDescriptor(char, 'chats');
            if (!chats) { if ('chats' in char) return false; }
            else if (chats.value != null && (!ordinaryHydrationArray(chats.value) || !chats.value.every(native))) return false;
            return ['scopeKey', 'runtimeScopeKey', 'runtimeChatId', 'canonicalEnvelopeVerified'].every(key => ownScalar(context, key));
        };
        const emptyHydrationLore = value => value === undefined || (ordinaryHydrationArray(value) && value.length === 0);
        isOwnedHydrationHostEligible = (char, chat) => {
            if (!ordinaryHydrationObject(char) || !ordinaryHydrationObject(chat)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(chat, 'localLore');
            if (descriptor) return emptyHydrationLore(descriptor.value) && descriptor.value !== undefined;
            const globalLore = Object.getOwnPropertyDescriptor(char, 'globalLore');
            return !('localLore' in chat) && (globalLore ? emptyHydrationLore(globalLore.value) : !('globalLore' in char));
        };
        const disposeSourceOwners = disposeValidationSourceOwners;
        OwnedHydrationValidation = (() => {
            const capsules = new WeakMap(), activeCapsules = new Set();
            const MAX_SOURCE_BYTES = 4194304;
            const MAX_HYDRATION_FACTS = 4096;
            let disposed = false;
            const close = capsule => {
                const state = capsules.get(capsule);
                if (!state) return;
                capsules.delete(capsule); activeCapsules.delete(capsule);
                validationSources.close(state.owner);
                state.owner = null; state.proof = null; state.guard = null; state.admission = null;
            };
            const current = capsule => {
                const state = capsules.get(capsule);
                if (!state || disposed) return null;
                if (!state.guard()) { close(capsule); return null; }
                return !disposed && capsules.get(capsule) === state ? state : null;
            };
            const open = ({ admission, guard, authorityRequest = null } = {}) => {
                if (disposed || typeof guard !== 'function' || !guard() || !admission
                    || !isManagementScopeResolved(admission.scopeKey) || !admission.runtimeScopeKey
                    || !Number.isSafeInteger(admission.resetGeneration) || admission.resetGeneration < 0) return null;
                const owner = validationSources.createOwner(admission.scopeKey, authorityRequest);
                if (!owner) return null;
                const capsule = Object.freeze({});
                capsules.set(capsule, { owner, authorityRequest, guard, proof: null, admission: Object.freeze({
                    scopeKey: admission.scopeKey, runtimeScopeKey: admission.runtimeScopeKey, resetGeneration: admission.resetGeneration }) });
                activeCapsules.add(capsule);
                return capsule;
            };
            const read = async (capsule, scope) => {
                let state = current(capsule), observation;
                if (state?.proof && !validationSources.matches(state.owner, state.proof.receipt, state.proof.read)) state.proof = null;
                if (!state || state.admission.scopeKey !== scope) {
                    // This slot still owes its original read against the newly
                    // resolved scope. It must not acquire through the old owner.
                    const status = state ? 'scope_mismatch' : 'closed';
                    close(capsule);
                    return { status, read: await readVerified(scope, { readonly: true, authorityRequest: state?.authorityRequest }), receipt: null };
                }
                observation = await validationSources.acquireObserved(state.owner);
                if (!observation.read) observation = { ...observation, read: await readVerified(scope, { readonly: true, authorityRequest: state?.authorityRequest }) };
                const live = current(capsule);
                if (live !== state) return { status: 'stale', read: observation.read, receipt: null };
                if (observation.read?.ok && observation.read.resetGeneration !== state.admission.resetGeneration) {
                    close(capsule);
                    return { status: 'reset_changed', read: observation.read, receipt: null };
                }
                if (observation.status !== 'issued') state.proof = null;
                return observation;
            };
            const validObservation = (state, observation, entries) => !!state && observation?.read?.ok
                && observation.read.scopeKey === state.admission.scopeKey && observation.read.resetGeneration === state.admission.resetGeneration
                && observation.read.entries === entries && (observation.status === 'missing'
                    ? observation.read.missing === true && observation.receipt === null
                    : observation.status === 'issued' && validationSources.matches(state.owner, observation.receipt, observation.read));
            const inspect = (capsule, observation, entries, context, hostEligible) => {
                const reject = reason => ({ ok: false, entries: [], excludedCount: entries.length, reasons: [reason], changed: 0 });
                let state = current(capsule);
                if (!validObservation(state, observation, entries)) { if (state) state.proof = null; return reject('validation_source_stale'); }
                const finish = (result, reusedValidator = null) => {
                    if (!result.ok) { state.proof = null; return result; }
                    const live = current(capsule);
                    if (live !== state || !validObservation(live, observation, entries)
                        || (reusedValidator && originalHydrationValidator() !== reusedValidator)) { state.proof = null; return reject('validation_source_stale'); }
                    return result;
                };
                const fallback = (checkedIdentity = null) => {
                    state.proof = null;
                    const identity = checkedIdentity || inspectHydrationIdentity(entries, context);
                    if (!identity.ok) return identity.result;
                    if (current(capsule) !== state || !validObservation(state, observation, entries)) return reject('validation_source_stale');
                    if (identity.scope !== state.admission.scopeKey || identity.runtime !== state.admission.runtimeScopeKey) return reject('runtime_identity_mismatch');
                    // One identity traversal and one original record loop, with no
                    // scalar collection on accessor/custom-validator fallbacks.
                    return finish(inspectHydrationCore(entries, context, null, identity));
                };
                const validator = originalHydrationValidator();
                if (!hostEligible || observation.status !== 'issued' || !validator || !ordinaryHydrationIdentity(context)) return fallback();
                if (entries.length > MAX_HYDRATION_FACTS) return fallback();
                const raw = observation.read.raw;
                if (raw.length > MAX_SOURCE_BYTES) return fallback();
                const bytes = state.proof?.raw === raw ? state.proof.bytes : new TextEncoder().encode(raw).byteLength;
                if (bytes > MAX_SOURCE_BYTES) return fallback();
                const identity = inspectHydrationIdentity(entries, context);
                if (!identity.ok) { state.proof = null; return identity.result; }
                const native = PersonaScopeIdentity.ids(context.char, context.chat), persona = PersonaScopeIdentity.get(context.char, context.chat);
                if (identity.scope !== state.admission.scopeKey || identity.runtime !== state.admission.runtimeScopeKey) {
                    state.proof = null; return reject('runtime_identity_mismatch');
                }
                const tuple = [identity.scope, identity.resolvedScope, identity.runtimeInput, identity.actualRuntime, identity.runtime,
                    identity.legacyRuntime, identity.chatId, identity.runtimeChatInput, identity.canonicalEnvelopeVerified,
                    native.characterId, native.chatId, persona?.personaId || '', state.admission.resetGeneration];
                // Context traversal is not authority to keep an earlier validator
                // or source. Check both again before shortcutting any record work.
                if (originalHydrationValidator() !== validator) return fallback(identity);
                if (current(capsule) !== state || !validObservation(state, observation, entries)) { state.proof = null; return reject('validation_source_stale'); }
                const proof = state.proof;
                if (proof && proof.raw === raw && proof.entries === entries && proof.validator === validator
                    && proof.tuple.length === tuple.length && proof.tuple.every((value, i) => value === tuple[i])
                    && evaluateHydrationFacts(proof.facts, identity)) {
                    state.proof = Object.freeze({ ...proof, receipt: observation.receipt, read: observation.read });
                    return finish({ ok: true, entries, excludedCount: 0, reasons: [], changed: 0 }, validator);
                }
                state.proof = null;
                const collected = { identity, facts: [], mappingAttempted: false };
                const result = finish(inspectHydrationCore(entries, context, collected));
                if (result.ok && result.changed === 0 && result.entries === entries && !collected.mappingAttempted) {
                    const live = current(capsule);
                    if (live !== state || !validObservation(live, observation, entries)) return reject('validation_source_stale');
                    if (originalHydrationValidator() === validator) {
                        state.proof = Object.freeze({ raw, entries, bytes, validator, tuple: Object.freeze(tuple),
                            entryCount: entries.length, facts: Object.freeze(collected.facts), receipt: observation.receipt, read: observation.read });
                    }
                }
                return result;
            };
            const prepare = async (capsule, char, chat) => {
                const result = await preparePersonaContextCore(char, chat, { capsule, admission: current(capsule)?.admission });
                return result.ok && !current(capsule) ? { ...result, ok: false, readOnly: true, reason: 'request_invalidated' } : result;
            };
            const disposeAll = () => {
                if (disposed) return;
                disposed = true;
                for (const capsule of [...activeCapsules]) close(capsule);
                disposeSourceOwners();
            };
            return Object.freeze({ open, prepare, read, inspect, close, disposeAll });
        })();
        disposeValidationSourceOwners = OwnedHydrationValidation.disposeAll;
        const saveVerifiedUnlocked = async (scopeKey = '', entries = [], options = {}) => {
            const scope = String(scopeKey || '').trim();
            let writeStarted = false;
            const fail = reason => ({ ok: false, verified: false, uncertain: writeStarted, scopeKey: scope, reason });
            if (!isManagementScopeResolved(scope)) return fail('identity_unresolved');
            const pendingAdmission=await WmPendingAdmission.forScope(scopeKey,"save");if(!pendingAdmission.ok)return pendingAdmission;
            if(WmWriterRuntime.enabled&&!options.expectedSource)options={...options,expectedSource:WmWriterRuntime.latestSource(String(scopeKey||'').trim())};
            if (VersionedCanonicalBridge.mode === "authority" && options.inheritance && !WmWriterRuntime.enabled) return {ok:false,reason:"authority_upstream_writer_unsupported"};
            if (VersionedCanonicalBridge.mode === "authority" && !VersionedCanonicalBridge.validateSource(String(scopeKey || "").trim(),options.expectedSource).ok) return {ok:false,reason:"authority_write_token_required"};
            if(WmWriterRuntime.enabled&&!options.expectedSource)options={...options,expectedSource:WmWriterRuntime.latestSource(scope)};
            if (!Array.isArray(entries)) return fail('invalid_management_save');
            if (entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || !isLibraEntry(entry))) return fail('invalid_management_payload');
            const isCurrent = async phase => {
                if (typeof options.isCurrent !== 'function') return false;
                try { return await options.isCurrent(phase) === true; } catch (_) { return false; }
            };
            if (!await isCurrent('before_read')) return fail('stale_identity');
            const before = await readVerified(scope);
            if (!before.ok) return fail(before.reason);
            if (VersionedCanonicalBridge.mode === "authority" && !VersionedCanonicalBridge.matches(options.expectedSource,before.authoritySource)) return fail("authority_source_changed");
            if (options.expectedGeneration !== undefined && options.expectedGeneration !== before.resetGeneration) return fail('reset_generation_changed');
            if (!await isCurrent('after_read')) return fail('stale_identity');
            if (Object.prototype.hasOwnProperty.call(options, 'expectedRaw') && before.raw !== options.expectedRaw) return fail('canonical_changed');
            if (options.inheritance && (!before.missing || !String(options.inheritance.inheritedFrom || '').trim()
                || options.inheritance.hostWorldlineMeta?.scopeKey !== scope)) return fail('invalid_inheritance_target');
            let normalized, payload;
            try {
                normalized = JSON.parse(JSON.stringify(normalizeEntries(entries)));
                const previousEnvelope = before.missing ? {} : JSON.parse(before.raw);
                const inheritance = options.inheritance ? { inheritedFrom: String(options.inheritance.inheritedFrom),
                    hostWorldlineMeta: JSON.parse(JSON.stringify(options.inheritance.hostWorldlineMeta)) } : {};
                const resetGeneration = before.resetGeneration + (options.advanceResetGeneration === true ? 1 : 0);
                if (!Number.isSafeInteger(resetGeneration)) return fail('reset_generation_exhausted');
                payload = JSON.stringify({ ...previousEnvelope, ...inheritance, version: previousEnvelope.version ?? '1.0',
                    scopeKey: scope, entryCount: normalized.length, updatedAt: Date.now(), entries: normalized, resetGeneration });
            } catch (_) { return fail('invalid_management_payload'); }
            const storageKey = storageKeyFor(scope);
            if (!await isCurrent('before_write')) return fail('stale_identity');
            writeStarted = true;
            // A missing/failed ACK is not the durable result. Always inspect the exact key.
            if (options.advanceResetGeneration === true) validationSources.retire(scope);
            const validationWrite = validationSources.beginWrite(scope);
            let authorityCommit = null;
            try {
                if (VersionedCanonicalBridge.mode === 'authority') {
                    authorityCommit = await VersionedCanonicalBridge.commit(scope,options.expectedSource,payload,options.advanceResetGeneration===true?'reset':(WmWriterRuntime.enabled?(options.operation||'verified'):'verified'));
                    if (!authorityCommit.ok) return fail(authorityCommit.reason);
                } else {
            try { await RisuCompat.pluginStorage.setItem(storageKey, payload); } catch (_) {}
                }
            } finally { validationSources.endWrite(validationWrite); }
            if (!await isCurrent('after_write')) return fail('stale_identity');
            let readback;
            try { const observed=await readCanonicalSource(scope,{strict:true}); readback=observed.raw; if(authorityCommit && !VersionedCanonicalBridge.sameHead(observed.head,authorityCommit.head)) return fail("authority_source_changed"); }
            catch (_) { return fail('canonical_readback_unavailable'); }
            if (readback !== payload) return fail('canonical_readback_mismatch');
            if (!await isCurrent('after_readback')) return fail('stale_identity');
            shadow.set(scope, normalized);
            hydratedScopes.add(scope);
            return { ok: true, verified: true, uncertain: false, scopeKey: scope, storageKey, raw: payload, entryCount: normalized.length,
                resetGeneration: before.resetGeneration + (options.advanceResetGeneration === true ? 1 : 0) };
        };
        const saveVerified = (scopeKey = '', entries = [], options = {}) => withScopeWrite(String(scopeKey || '').trim(),
            () => saveVerifiedUnlocked(scopeKey, entries, options));
        const resetVerified = (scopeKey = '', options = {}) => {
            if (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 0) {
                return Promise.resolve({ ok: false, verified: false, uncertain: false, reason: 'reset_generation_required' });
            }
            return saveVerified(scopeKey, [], { ...options, advanceResetGeneration: true }).then(result => {
                if (result.ok) invalidateScopeWriters(String(scopeKey || '').trim());
                return result;
            });
        };
        const remove = async (charArg = null, chatArg = null, options = {}) => {
            const { char, chat } = args(charArg, chatArg);
            const scopeKey = scopeKeyFor(char, chat);
            const isCurrent = () => scopeKeyFor(char, chat) === scopeKey;
            // Reserve invocation order before asynchronous admission can yield.
            return withScopeWrite(scopeKey, async () => {
                if (!isCurrent()) return { ok: false, reason: 'stale_identity' };
                const pendingAdmission = await WmPendingAdmission.forChat(char, chat, 'remove');
                if (!pendingAdmission.ok) return pendingAdmission;
                if (!isCurrent()) return { ok: false, reason: 'stale_identity' };
                if (VersionedCanonicalBridge.mode === 'authority') {
                    if (!VersionedCanonicalBridge.validateSource(scopeKey,options.expectedSource).ok) return {ok:false,reason:'authority_write_token_required'};
                    const before=await readVerified(scopeKey);
                    if (!before.ok || !VersionedCanonicalBridge.matches(options.expectedSource,before.authoritySource)) return {ok:false,reason:'authority_source_changed'};
                    const marker=validationSources.beginWrite(scopeKey);let committed;
                    try {committed=await VersionedCanonicalBridge.commit(scopeKey,options.expectedSource,null,'remove');}
                    finally {validationSources.endWrite(marker);}
                    if (!committed.ok) return committed;
                    const checked=await VersionedCanonicalBridge.currentSource(scopeKey,committed.head);
                    if (!checked.ok) return {ok:false,reason:checked.reason,uncertain:true};
                    invalidateScopeWriters(scopeKey);validationSources.retire(scopeKey);shadow.set(scopeKey,[]);
                    return {ok:true,verified:true,scopeKey};
                }
                invalidateScopeWriters(scopeKey);
                validationSources.retire(scopeKey);
                shadow.set(scopeKey, []);
                const validationWrite = validationSources.beginWrite(scopeKey);
                try { return await RisuCompat.pluginStorage.removeItem(storageKeyFor(scopeKey)); } catch (_) { return false; }
                finally { validationSources.endWrite(validationWrite); }
            });
        };
        // Entity fallback needs fresh entity rows, not cloned memory payloads.
        // This is a projection of the existing view, never a cached authority.
        const getShadowEntries = (scopeKey = '', entryComment = null) => (
            typeof entryComment === 'string'
                ? getShadow(scopeKey).filter(entry => entry?.comment === entryComment)
                : getShadow(scopeKey)
        ).map(cloneData);
        // 네이티브 브랜치 상속: 계보가 verified 면 자식 채팅이 부모 스코프의 데이터를
        // 물려받는다. 부모 원문이 실제로 공통 접두로 확인된 경우에만(verified) 한다 —
        // 그렇지 않으면 무관한 채팅의 기억이 섞인다.
        // 엔트리에서 턴을 읽는다 — 이 스코프(LibraLoreConsolidator)는 memoryEntryTurn 을
        //   갖고 있지 않으므로(그건 LibraTurnWorldline 쪽이다) 같은 규칙으로 로컬 정의한다.
        //   META 의 turnAnchorTurn → finalizedTurn → turn → t 순서는 확립된 규칙이다.
        const branchEntryTurn = (entry = null) => {
            try {
                const content = String(entry?.content || '');
                const match = content.match(/\[META:(\{[^\r\n]*\})]/);
                if (match) {
                    const meta = JSON.parse(match[1]);
                    const turn = Number(meta?.turnAnchorTurn || meta?.finalizedTurn || meta?.turn || meta?.t || 0);
                    if (Number.isFinite(turn) && turn > 0) return turn;
                }
                const parsed = JSON.parse(content);
                const meta = parsed?.meta || parsed?.metadata || {};
                const turn = Number(meta?.turnAnchorTurn || meta?.finalizedTurn || meta?.turn || meta?.t || 0);
                return Number.isFinite(turn) && turn > 0 ? turn : 0;
            } catch (_) { return 0; }
        };
        // 브랜치 상속은 **fork 지점까지만** — 부모의 미래(>fork)를 복제하지 않는다.
        //   제안서 §14(P0) 지적. 실측: 종전에는 parentEntries 전체를 복제했다.
        //   fork 지점은 lineage.commonPrefixPairs 다(이미 검증된 값 — 새로 계산하지 않는다).
        const filterBranchInheritanceByFork = (entries = [], lineage = null) => {
            const list = Array.isArray(entries) ? entries : [];
            const forkPair = Number(lineage?.commonPrefixPairs || 0) || 0;
            // fork 지점을 못 구하면 **종전과 동일하게 전체 상속**한다(fail-open, 하위 호환).
            if (!forkPair || list.length === 0) {
                return { entries: list, inherited: list.length, excluded: 0, excludedTurns: [], forkTurn: 0 };
            }
            const excludedTurns = new Set();
            // ★ 세계 그래프는 단일 항목이라 턴 도장이 없다 — 여기서 **안쪽을 파싱해** 자른다.
            //   실측: fork 40 에서 부모가 T99(포크 이후) 추가한 규칙·보정까지 자식이 받았다.
            let worldNodesRemoved = 0;
            let worldRulesRemoved = 0;
            // ★ `filter` 대신 `reduce` 를 쓴다 — `Array.filter` 는 **원소를 변환할 수 없다**.
            //   (콜백 인자를 재할당해도 결과 배열은 원본이라 수리가 조용히 무효였다 — 자기오류.)
            const kept = list.reduce((out, entry) => {
                const turn = branchEntryTurn(entry);
                // 턴을 알 수 없으면 **버리지 않는다** — 상속에서 빼면 정보가 사라진다.
                if (!turn) {
                    if (String(entry?.comment || '').trim() === 'lmai_world_graph') {
                        const trimmed = filterWorldGraphByFork(entry, forkPair);
                        if (trimmed.changed) {
                            worldNodesRemoved += trimmed.removedNodes;
                            worldRulesRemoved += trimmed.removedRules;
                            out.push(trimmed.entry);
                            return out;
                        }
                    }
                    out.push(entry);
                    return out;
                }
                if (turn > forkPair) { excludedTurns.add(turn); return out; }
                out.push(entry);
                return out;
            }, []);
            return {
                entries: kept,
                inherited: kept.length,
                excluded: list.length - kept.length,
                excludedTurns: Array.from(excludedTurns).sort((a, b) => a - b),
                forkTurn: forkPair,
                worldNodesRemoved,
                worldRulesRemoved
            };
        };
        // 저장된 상속 메타를 읽는다 — 재바인딩 판정에 쓴다 (정본 37479 대응).
        const readInheritanceMeta = async (targetScope = '') => {
            try {
                const raw = await readCanonicalRaw(targetScope);
                const parsed = raw ? JSON.parse(String(raw)) : null;
                // ★ `str` 은 LibraHostLineage 스코프 헬퍼라 여기서는 못 쓴다(실제로 ReferenceError 로
                //   catch 에 삼켜져 메타를 영영 못 읽었다). 이 스코프의 도구로 직접 만든다.
                return {
                    hostWorldlineMeta: parsed?.hostWorldlineMeta || null,
                    inheritedFrom: String(parsed?.inheritedFrom == null ? '' : parsed.inheritedFrom),
                    entryCount: Number(parsed?.entryCount) || 0
                };
            } catch (_) { return { hostWorldlineMeta: null, inheritedFrom: '', entryCount: 0 }; }
        };
        // ★ 세계 그래프(`lmai_world_graph`)는 단일 로어 항목이라 **턴 도장이 없다**.
        //   그래서 `branchEntryTurn` 이 0 을 내고, 상속 규칙(턴 불명은 버리지 않음)에 따라
        //   **통째로** 넘어갔다 — 실측: fork 턴 40 에서 T99(포크 이후) 부모 규칙·보정까지 자식이 받았다.
        //   기억은 정확히 잘리는데 세계만 안 잘리는 **비대칭**이었다(§5-6 과 같은 부류).
        //   노드는 `meta.created`(생성 시각)와 `rules.ruleMeta.promotedRules`(승격 출처 턴)로 판정한다.
        const branchWorldGraphTurn = (entry = null, node = null) => {
            const source = node && typeof node === 'object' ? node : {};
            // ★ 노드의 턴은 **생성 턴**이다. 규칙의 출처 턴(`promotedRules`)과 **섞으면 안 된다** —
            //   섞었더니 포크 직전에 생긴 루트 노드가 포크 이후 규칙(99) 때문에 통째로 제거됐다
            //   (과잉 제거 — 자식이 포크 시점의 세계를 통째로 잃는다. 자기오류).
            //   규칙별 판정은 `worldRuleTurnMap` 이 따로 한다.
            // ★★ 세계 노드의 `meta.created` 는 **`Date.now()`(밀리초)** 다(08a:525).
            //   종전엔 이걸 턴으로 읽어 `forkTurn`(40)과 비교했고, 타임스탬프가 항상 크므로
            //   **정상 노드를 전부 "포크 이후"로 오판해 삭제**했다(실측 P0 — 자식 세계가 전멸).
            //   → 명시 턴 필드만 본다. 레거시 `meta.created` 는 타임스탬프를 배제한 안전 범위에서만.
            let stamped = 0;
            try { stamped = stampTurn(source?.meta, { allowLegacyCreated: true }); } catch (_) { stamped = 0; }
            stamped = legacyTurnWithinRange(stamped);
            if (stamped > 0) return stamped;
            // 노드 자체에 도장이 없으면 항목 수준 도장을 본다.
            try { return branchEntryTurn(entry); } catch (_) { return 0; }
        };
        //   규칙 텍스트 → 출처 턴 (승격이 기록). 포크 이후 규칙을 골라낸다.
        const worldRuleTurnMap = (node = null) => {
            const source = node && typeof node === 'object' ? node : {};
            const promoted = source?.rules?.ruleMeta?.promotedRules;
            const out = {};
            if (!promoted || typeof promoted !== 'object' || Array.isArray(promoted)) return out;
            for (const [text, turn] of Object.entries(promoted)) {
                const key = String(text || '').trim();
                const value = Number(turn) || 0;
                if (key && value > 0) out[key] = value;
            }
            return out;
        };
        const filterWorldGraphByFork = (entry = null, forkTurn = 0) => {
            const limit = Number(forkTurn) || 0;
            if (!entry || !limit) return { entry, changed: false, removedNodes: 0, removedRules: 0 };
            let payload = null;
            try { payload = JSON.parse(String(entry?.content || '')); } catch (_) { return { entry, changed: false, removedNodes: 0, removedRules: 0 }; }
            if (!payload || !Array.isArray(payload.nodes)) return { entry, changed: false, removedNodes: 0, removedRules: 0 };
            let removedNodes = 0;
            let removedRules = 0;
            let correctionRemoved = 0;
            const nodes = [];
            for (const node of payload.nodes) {
                const turn = branchWorldGraphTurn(entry, node);
                // 턴을 알 수 없는 노드는 **버리지 않는다** (정보 손실 방지 — 상속 규칙과 동일).
                if (!turn || turn <= limit) { nodes.push(node); continue; }
                removedNodes += 1;
            }
            // 포크 직전 노드가 살아남았으면 그 노드의 규칙 중 **포크 이후 승격된 것**만 뺀다.
            //   교정(`userWorldCorrection`)도 출처 턴(`worldCorrectionTurn`)이 포크 이후면 뺀다.
            const kept = nodes.map(node => {
                // ★ 보정은 **전용 필드**(`worldCorrectionTurn`)로만 판정한다 —
                //   `stampTurn` 은 `createdTurn` 을 먼저 보므로 보정 턴을 놓친다(실측 FAIL).
                const correctionTurn = (() => {
                    const meta = (node && typeof node.meta === 'object') ? node.meta : {};
                    const nested = (meta.worldMetadata && typeof meta.worldMetadata === 'object') ? meta.worldMetadata : {};
                    const value = Number(meta.worldCorrectionTurn || nested.worldCorrectionTurn) || 0;
                    return legacyTurnWithinRange(value);
                })();
                const baseNode = (correctionTurn > limit) ? (() => {
                    const meta = { ...(node.meta || {}) };
                    delete meta.userWorldCorrection;
                    delete meta.worldCorrectionTurn;
                    const worldMetadata = { ...(meta.worldMetadata || {}) };
                    delete worldMetadata.userWorldCorrection;
                    delete worldMetadata.worldCorrectionTurn;
                    meta.worldMetadata = worldMetadata;
                    correctionRemoved += 1;
                    return { ...node, meta };
                })() : node;
                if (baseNode !== node) node = baseNode;
                const map = worldRuleTurnMap(node);
                const custom = node?.rules?.custom;
                if (!custom || typeof custom !== 'object' || Array.isArray(custom) || !Object.keys(map).length) return node;
                const nextCustom = {};
                let trimmed = 0;
                for (const [key, value] of Object.entries(custom)) {
                    const text = String(value || '').trim();
                    const sourceTurn = map[text] || 0;
                    if (sourceTurn && sourceTurn > limit) { trimmed += 1; continue; }
                    nextCustom[key] = value;
                }
                if (!trimmed) return node;
                removedRules += trimmed;
                return { ...node, rules: { ...node.rules, custom: nextCustom } };
            });
            if (!removedNodes && !removedRules && !correctionRemoved) {
                return { entry, changed: false, removedNodes: 0, removedRules: 0, correctionRemoved: 0 };
            }
            const next = { ...payload, nodes: kept };
            return { entry: { ...entry, content: JSON.stringify(next) }, changed: true, removedNodes, removedRules, correctionRemoved };
        };
        const inheritFromBranch = async (char = null, chat = null, options = {}) => {
            const pendingAdmission=await WmPendingAdmission.forChat(char,chat,"inherit");if(!pendingAdmission.ok)return {...pendingAdmission,inherited:0};
            if (VersionedCanonicalBridge.mode === "authority") return {ok:false,reason:"authority_upstream_writer_unsupported",inherited:0};
            const targetScope = scopeKeyFor(char, chat, null);
            const current = getShadow(targetScope);
            if (current.length > 0) {
                // ★ 이미 채워진 스코프 — **바인딩이 아직 맞는지** 확인한다.
                //   종전에는 무조건 `already_populated` 로 돌아가서, 부모 월드라인이 바뀌어도
                //   (포크 지점이 이동·재설정) 이미 들어간 기억이 **그대로 남았다**.
                //   정본(LIBRA.js 37479)은 같은 형태의 결합 키 불일치를 conflict 로 돌려준다.
                // ★ 네이티브 복제는 표식이 없으므로 `inspect` 만으로는 `independent_chat` 이 된다.
                //   비동기 판정(`inspectWithCopy`)으로 복제도 계보로 인정한다 (감사 G1).
                let lineageNow = null;
                try { lineageNow = await lineageInspectWithCopy(char, chat); } catch (_) { lineageNow = null; }
                if (lineageNow && LibraHostLineage.isInheritable(lineageNow)) {
                    const stored = await readInheritanceMeta(targetScope);
                    const storedBinding = LibraHostLineage.hostWorldlineBindingOf(stored.hostWorldlineMeta);
                    const expectedMeta = LibraHostLineage.hostWorldlineMetaOf(lineageNow, targetScope, stored.hostWorldlineMeta?.createdAt);
                    const expectedBinding = LibraHostLineage.hostWorldlineBindingOf(expectedMeta);
                    if (storedBinding && expectedBinding && storedBinding !== expectedBinding) {
                        return {
                            ok: false, inherited: 0, reason: 'worldline_binding_conflict',
                            storedBinding, expectedBinding,
                            rebindRequired: true,
                            storedForkTurn: Number(stored.hostWorldlineMeta?.forkTurn) || 0,
                            expectedForkTurn: Number(lineageNow.commonPrefixPairs) || 0
                        };
                    }
                }
                return { ok: true, inherited: 0, reason: 'already_populated' };
            }
            let lineage = null;
            try { lineage = await lineageInspectWithCopy(char, chat); } catch (_) { return { ok: false, reason: 'lineage_probe_failed' }; }
            if (!LibraHostLineage.isInheritable(lineage)) {
                return { ok: true, inherited: 0, reason: lineage?.reason || lineage?.status || 'not_inheritable' };
            }
            const chats = Array.isArray(char?.chats) ? char.chats : [];
            const parent = chats.find(item => String(item?.id || item?.chatId || '') === lineage.parentChatId) || null;
            if (!parent) return { ok: false, reason: 'parent_chat_unavailable' };
            let sourcePersonaId = null;
            if (options.stageOnly && options.personaId) {
                const targetProof = PersonaScopeIdentity.get(char, chat), parentHint = PersonaScopeIdentity.bindingHint(parent, char);
                if (!targetProof || targetProof.personaId !== options.personaId || parentHint.invalid
                    || (parentHint.explicit && parentHint.id !== options.personaId)) return { ok: false, inherited: 0, reason: 'branch_source_unverified' };
                sourcePersonaId = options.personaId;
            }
            const parentScope = scopeKeyFor(char, parent, sourcePersonaId);
            // Lineage authorizes a copy, but does not make corrupted or foreign
            // source records valid. Verify durable source identity and original
            // checksums before fork filtering or any authorized re-signing.
            const rejectSource = (excludedCount = 0) => {
                hydrationDiagnostics.set(targetScope, { readOnly: true, excludedCount, reasons: ['branch_source_unverified'] });
                return { ok: false, inherited: 0, reason: 'branch_source_unverified', excludedCount };
            };
            const source = await readVerified(parentScope);
            if (!source.ok) return rejectSource();
            let parentEntries = source.entries;
            if (source.missing) {
                parentEntries = LibraLoreConsolidator.unpackRawFromLore(
                    Array.isArray(parent?.localLore) ? parent.localLore
                        : (Array.isArray(char?.globalLore) ? char.globalLore : [])
                ).filter(isLibraEntry);
                if (!parentEntries.length && getShadow(parentScope).length) return rejectSource();
            }
            if (parentEntries.length === 0) return { ok: true, inherited: 0, reason: 'parent_has_no_data' };
            if (source.missing && sourcePersonaId && sourcePersonaId !== 'default') return rejectSource(parentEntries.length);
            const parentChar = { ...char, chatPage: chats.indexOf(parent) };
            const parentSnapshot = sourcePersonaId ? { ...parent, bindedPersona: sourcePersonaId } : parent;
            const verifiedSource = inspectHydrationEntries(parentEntries, {
                char: parentChar, chat: parentSnapshot, scopeKey: parentScope,
                runtimeScopeKey: getChatRuntimeScopeKey(parentSnapshot, parentChar), runtimeChatId: parent.id,
                canonicalEnvelopeVerified: !source.missing
            });
            if (!verifiedSource.ok) return rejectSource(verifiedSource.excludedCount);
            parentEntries = verifiedSource.entries;
            // 부모 기억을 자식 스코프로 복제한다 (부모는 그대로 둔다 — 브랜치는 분기지 이동이 아니다).
            //   ★ fork 지점까지만 — 부모가 fork 이후에도 진행했다면 그 엔트리는 자식 것이 아니다.
            //     Child 가 물려받아야 하는 것은 "포크 시점의 부모 상태"이지 부모의 미래가 아니다.
            const forked = filterBranchInheritanceByFork(parentEntries, lineage);
            // ★ 세계 그래프도 fork 지점까지만 — 단일 로어 항목이라 위 필터가 통째로 넘겼다.
            //   실측: fork 40 에서 부모가 T99(포크 이후) 추가한 규칙·보정까지 자식이 받았다.
            const forkTurn = Number(forked.forkTurn) || Number(lineage.commonPrefixPairs) || 0;
            const worldReport = { removedNodes: 0, removedRules: 0 };
            const entryList = forked.entries.map(entry => {
                if (!entry || String(entry.comment || '').trim() !== 'lmai_world_graph') return entry;
                const filtered = filterWorldGraphByFork(entry, forkTurn);
                if (filtered.changed) {
                    worldReport.removedNodes += filtered.removedNodes;
                    worldReport.removedRules += filtered.removedRules;
                    return filtered.entry;
                }
                return entry;
            });
            //   ★★ 복제·브랜치로 넘어온 기록의 **payload 식별자**를 목적 스코프로 접는다 (G4).
            //     소비처가 payload 의 scopeKey 로 엔트리를 찾으므로(08e:721/753), 부모 값이 남으면
            //     `exact` 도 `legacy` 도 아니어서 **-1(못 찾음)** → 복제본이 그 도메인을 새로 시작한다.
            //     ※ **소비처가 쓰는 키**로 접어야 한다(01c:125 = MemoryState._activeScopeKey).
            //       01f 형식으로 접으면 제품에서는 여전히 못 찾는다 — 그래서 호출자가 넘긴 키를 쓴다.
            const runtimeScopeKey = String(options?.runtimeScopeKey || '').trim();
            const runtimeChatId = String(options?.runtimeChatId || '').trim();
            let inherited = entryList.map(entry => cloneData(entry));
            if (runtimeScopeKey) {
                const rescoped = rescopeEntriesIntegrity(inherited, runtimeScopeKey, runtimeChatId);
                if (rescoped.changed > 0) inherited = rescoped.entries;
            }
            if (options.stageOnly) return { ok: true, inherited: inherited.length, entries: inherited,
                inheritance: { inheritedFrom: lineage.parentChatId,
                    hostWorldlineMeta: LibraHostLineage.hostWorldlineMetaOf(lineage, targetScope, Date.now()) },
                reason: 'branch_inheritance' };
            const saved = await saveVerified(targetScope, inherited, {
                expectedRaw: null, expectedGeneration: capturedGeneration(char, chat),
                inheritance: { inheritedFrom: lineage.parentChatId,
                    hostWorldlineMeta: LibraHostLineage.hostWorldlineMetaOf(lineage, targetScope, Date.now()) },
                isCurrent: async () => true
            });
            if (!saved.ok) return { ok: false, reason: saved.reason, inherited: 0, uncertain: saved.uncertain };
            return {
                ok: true, inherited: inherited.length, from: lineage.parentChatId, reason: 'branch_inheritance',
                binding: LibraHostLineage.hostWorldlineBindingOf(LibraHostLineage.hostWorldlineMetaOf(lineage, targetScope, 0)),
                forkTurn: forked.forkTurn || 0,
                excludedAfterFork: forked.excluded || 0,
                worldNodesRemoved: worldReport.removedNodes,
                worldRulesRemoved: worldReport.removedRules,
                excludedTurns: forked.excludedTurns || []
            };
        };
        // 휘발성 캐시는 세이브 파일에 실을 필요가 없다 — 기기 로컬에 둔다.
        // (다른 4개 플러그인도 getLocalPluginStorage 로 장치 로컬 캐시를 분리한다.)
        const deviceLocal = {
            async get(key) {
                try {
                    const store = await RisuCompat.getLocalPluginStorage?.();
                    if (store?.getItem) return await store.getItem(String(key));
                    const safe = RisuCompat.host?.('safeLocalStorage');
                    if (safe?.getItem) return await safe.getItem(String(key));
                } catch (_) {}
                return null;
            },
            async set(key, value) {
                try {
                    const store = await RisuCompat.getLocalPluginStorage?.();
                    if (store?.setItem) { await store.setItem(String(key), String(value)); return true; }
                    const safe = RisuCompat.host?.('safeLocalStorage');
                    if (safe?.setItem) { await safe.setItem(String(key), String(value)); return true; }
                } catch (_) {}
                return false;
            },
            async remove(key) {
                try {
                    const store = await RisuCompat.getLocalPluginStorage?.();
                    if (store?.removeItem) { await store.removeItem(String(key)); return true; }
                } catch (_) {}
                return false;
            }
        };
        const isHydrated = (scopeKey = '') => hydratedScopes.has(String(scopeKey || 'global'));
        const selfCheck = (char = null, chat = null) => {
            const scopeKey = scopeKeyFor(char, chat);
            return { scopeKey, storageKey: storageKeyFor(scopeKey), hydrated: isHydrated(scopeKey), entryCount: getShadow(scopeKey).length };
        };
        return Object.freeze({ hydrate, save, inspectHydrationEntries, getHydrationDiagnostics, readVerified, readInventoryCanonical, isVerifiedReadonlyEntries, verifiedReadonlySourceBinding, preparePersonaContext, publishVerifiedView, invalidateRuntimeView, saveVerified, resetVerified, load, remove, getShadowEntries, inheritFromBranch, inspectWithCopy: (c, ch) => lineageInspectWithCopy(c, ch), inferCopiedChatSource: (c, ch) => LibraHostLineage.inferCopiedChatSource(c, ch, { hasData: branchSourceHasData }), rescopeEntriesIntegrity, rescopeRecordIntegrity, filterBranchInheritanceByFork, branchEntryTurn, isHydrated, selfCheck, scopeKeyFor, scopeKeyForAsync, resolvePersonaId, refreshIndexCache, storageKeyFor, isLibraEntry, deviceLocal, setActiveScope, getActiveScope, hostWorldlineBindingOf: (meta) => LibraHostLineage.hostWorldlineBindingOf(meta), hostWorldlineMetaOf: (info, id, at) => LibraHostLineage.hostWorldlineMetaOf(info, id, at), readInheritanceMeta, filterWorldGraphByFork, branchWorldGraphTurn });
    })();

    try {
        if (typeof globalThis !== 'undefined') globalThis.LibraDataStorage = LibraDataStorage;
    } catch (_) {}


    // ══════════════════════════════════════════════════════════════
    // Turn Worldline — 턴을 노드로 기록해 리롤·브랜치·롤백을 추적한다.
    //
    // Downloads/plugins 의 최신 플러그인(Flashback/HAYAKU)이 쓰는 구조를 실측해
    // 같은 정체성 공식을 쓴다:
    //   logicalTurnId = hash(`turn\x01${scopeKey}\x01${pairIndex}\x01${userHash}`)
    //   variantId     = hash(`variant\x01${logicalTurnId}\x01${assistantHash}`)
    //   turnNodeId    = hash(`node\x01${scopeKey}\x01${logicalTurnId}\x01${variantId}`)
    //
    // 핵심 성질: 같은 턴을 리롤하면 logicalTurnId 는 같고 variantId 만 달라진다
    // → 형제 노드가 되고 이전 노드는 superseded 로 남는다 (이력 보존).
    // 라이브 대화에서 사라진 노드는 orphaned / detached 로 표시된다 (정본 어휘).
    // ══════════════════════════════════════════════════════════════
    const LibraTurnWorldline = (() => {
        const SCHEMA = 'libra_turn_worldline_v1';
        const MAX_NODES = 2048;
        // ★ 상태 어휘는 **크로스플러그인 정본**(HAYAKU·Flashback·RETRACE)과 맞춘다.
        //   정본(HYAKU `recoveryDebtStatusForWorldline`): active / quarantined / superseded /
        //   orphaned / detached. 종전 내부 이름(`inactive_variant`/`detached_branch`)과 갈려
        //   있어 크로스플러그인 판정이 어긋났다(실측 3/5 일치).
        const NODE_STATUSES = new Set(['active', 'quarantined', 'superseded', 'detached', 'orphaned']);
        // 구 저장 데이터 하위 호환 — 종전 이름을 정본으로 **읽을 때** 변환한다.
        const LEGACY_NODE_STATUS_ALIASES = Object.freeze({
            inactive_variant: 'superseded',
            detached_branch: 'detached'
        });
        const normalizeNodeStatus = (value = '') => {
            const raw = String(value == null ? '' : value).trim();
            const aliased = LEGACY_NODE_STATUS_ALIASES[raw] || raw;
            return NODE_STATUSES.has(aliased) ? aliased : 'orphaned';
        };
        const LIVE_STATUSES = new Set(['active', 'quarantined']);
        const text = (value = '') => String(value == null ? '' : value);
        const compact = (value = '', limit = 96) => text(value).trim().slice(0, limit);
        // 정규화: 공백·개행을 하나로 접어 같은 의미의 텍스트가 같은 해시를 갖게 한다.
        const canonical = (value = '') => text(value).replace(/\s+/g, ' ').trim();
        const hashOf = (value = '') => {
            try { return stableHash(text(value)); } catch (_) { return ''; }
        };
        const identityFor = (scopeKey = '', pair = {}) => {
            const pairIndex = Math.max(1, Number(pair?.pairIndex || pair?.index || 1) || 1);
            const userHash = hashOf(canonical(pair?.userText || pair?.user || ''));
            const assistantHash = hashOf(canonical(pair?.assistantText || pair?.assistant || ''));
            const logicalTurnId = hashOf(`turn\u0001${text(scopeKey)}\u0001${pairIndex}\u0001${userHash}`);
            const variantId = hashOf(`variant\u0001${logicalTurnId}\u0001${assistantHash}`);
            const turnNodeId = hashOf(`node\u0001${text(scopeKey)}\u0001${logicalTurnId}\u0001${variantId}`);
            return { pairIndex, userHash, assistantHash, logicalTurnId, variantId, turnNodeId };
        };
        const empty = (scopeKey = '') => ({
            version: SCHEMA, scopeKey: text(scopeKey), revision: 0, liveHash: '',
            headTurnNodeId: '', nodes: [], updatedAt: 0,
            // ★ 롤백 **경계** — 정본 `LIBRA.js` 61122 `worldlines.<id>.cutoffTurn`.
            //   종전에는 롤백을 매번 라이브에서 역추론해(`detectDrift`) 계층마다 필터를
            //   덧대야 했다(기억·RP-LTM·엔티티·세계 규칙). 경계를 저장하면 한 곳에서 판정한다.
            //   `null` = 제한 없음(정본도 `cutoffTurn == null ? Infinity`).
            cutoffTurn: null
        });
        const normalize = (value = null, scopeKey = '') => {
            const parsed = value && typeof value === 'object' ? value : {};
            const seen = new Set();
            const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).filter(node => {
                const id = compact(node?.turnNodeId);
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
            }).map(node => ({
                turnNodeId: compact(node.turnNodeId),
                logicalTurnId: compact(node.logicalTurnId),
                variantId: compact(node.variantId),
                parentTurnNodeId: compact(node.parentTurnNodeId),
                pairIndex: Math.max(1, Number(node.pairIndex || node.originalOrdinal || 1) || 1),
                originalOrdinal: Math.max(1, Number(node.originalOrdinal || node.pairIndex || 1) || 1),
                activeOrdinal: Math.max(0, Number(node.activeOrdinal || 0) || 0),
                userHash: compact(node.userHash),
                assistantHash: compact(node.assistantHash),
                userMessageId: text(node.userMessageId).trim(),
                assistantMessageId: text(node.assistantMessageId).trim(),
                status: normalizeNodeStatus(node.status),
                supersededBy: compact(node.supersededBy),
                createdAt: Math.max(0, Number(node.createdAt || 0) || 0),
                updatedAt: Math.max(0, Number(node.updatedAt || 0) || 0)
            })).sort((a, b) => a.originalOrdinal - b.originalOrdinal || a.createdAt - b.createdAt).slice(-MAX_NODES);
            return {
                version: SCHEMA,
                scopeKey: text(scopeKey || parsed.scopeKey || ''),
                revision: Math.max(0, Number(parsed.revision || 0) || 0),
                liveHash: compact(parsed.liveHash, 128),
                headTurnNodeId: compact(parsed.headTurnNodeId),
                nodes,
                updatedAt: Math.max(0, Number(parsed.updatedAt || 0) || 0),
                // 구 저장 데이터에는 없다 → null(제한 없음). 있으면 양수만 인정한다.
                cutoffTurn: (() => {
                    const value = Number(parsed.cutoffTurn);
                    return Number.isFinite(value) && value > 0 ? value : null;
                })()
            };
        };
        // 라이브 대화 쌍들로부터 월드라인을 전개한다. 순수 함수 — 저장하지 않는다.
        const reduceWorldline = (previous = null, scopeKey = '', pairs = [], options = {}) => {
            const timestamp = Number(options?.now || Date.now()) || Date.now();
            const list = Array.isArray(pairs) ? pairs : [];
            const base = normalize(previous, scopeKey);
            const incremental = options?.mode === 'finalized-turn';
            const acceptNativeIds = options?.sourceVerified === true && (incremental || options?.explicitReanalysis === true);
            const nodes = base.nodes.map(node => ({ ...node }));
            const byVariant = new Map(nodes.map(node => [`${node.logicalTurnId}\u0001${node.variantId}`, node]));
            const selected = [];
            const selectedByLogical = new Map();
            const livePairs = [];
            let parentTurnNodeId = incremental ? base.headTurnNodeId : '';
            for (const pair of list) {
                const identity = identityFor(scopeKey, pair);
                const key = `${identity.logicalTurnId}\u0001${identity.variantId}`;
                let node = byVariant.get(key);
                // 같은 논리 턴의 이전 active 노드는 형제(리롤)이므로 물러난다.
                const oldActive = nodes.find(candidate =>
                    (candidate.logicalTurnId === identity.logicalTurnId
                        || (incremental && (candidate.pairIndex === identity.pairIndex
                            || (acceptNativeIds && candidate.userMessageId && candidate.userMessageId === text(pair?.userMessageId).trim()))))
                    && candidate.status === 'active'
                    && candidate.turnNodeId !== identity.turnNodeId);
                if (oldActive) {
                    oldActive.status = 'superseded';
                    oldActive.supersededBy = identity.turnNodeId;
                    oldActive.updatedAt = timestamp;
                }
                if (!node) {
                    node = {
                        ...identity,
                        userMessageId: acceptNativeIds ? text(pair?.userMessageId).trim() : '',
                        assistantMessageId: acceptNativeIds ? text(pair?.assistantMessageId).trim() : '',
                        parentTurnNodeId,
                        originalOrdinal: identity.pairIndex,
                        activeOrdinal: identity.pairIndex,
                        status: 'active',
                        supersededBy: '',
                        createdAt: timestamp,
                        updatedAt: timestamp
                    };
                    nodes.push(node);
                    byVariant.set(key, node);
                } else {
                    Object.assign(node, identity, {
                        parentTurnNodeId: incremental ? node.parentTurnNodeId : parentTurnNodeId,
                        activeOrdinal: identity.pairIndex,
                        status: 'active',
                        supersededBy: '',
                        updatedAt: timestamp
                    });
                }
                selected.push(node);
                selectedByLogical.set(identity.logicalTurnId, node);
                livePairs.push({ identity, node });
                parentTurnNodeId = node.turnNodeId;
            }
            // 라이브에 없는 노드: 같은 논리 턴의 형제가 살아 있으면 그쪽으로 넘어간 것
            // (리롤) → superseded. 아니면 대화에서 잘린 것 → orphaned/detached.
            const selectedIds = new Set(selected.map(node => node.turnNodeId));
            const maxPair = livePairs.reduce((max, item) => Math.max(max, item.identity.pairIndex),
                incremental ? Math.max(0, ...activeNodes(base).map(node => node.pairIndex)) : 0);
            for (const node of incremental ? [] : nodes) {
                if (selectedIds.has(node.turnNodeId)) continue;
                const sibling = selectedByLogical.get(node.logicalTurnId);
                if (sibling) {
                    node.status = 'superseded';
                    node.supersededBy = sibling.turnNodeId;
                } else if (!LIVE_STATUSES.has(node.status) || node.status === 'active') {
                    node.status = node.pairIndex > maxPair ? 'orphaned' : 'detached';
                }
                node.updatedAt = timestamp;
            }
            const liveHash = hashOf((incremental ? base.liveHash + '\n' : '') + livePairs.map(item =>
                [item.identity.pairIndex, item.identity.userHash, item.identity.assistantHash].join('\u0001')).join('\n'));
            return normalize({
                version: SCHEMA,
                scopeKey,
                revision: base.revision + 1,
                liveHash,
                headTurnNodeId: parentTurnNodeId,
                nodes,
                updatedAt: timestamp,
                // ★ 경계 = 라이브에 존재하는 **최고 턴**. 이 아래는 유효, 위는 롤백됐다.
                //   리롤은 같은 위치의 다른 응답이라 maxPair 를 바꾸지 않는다(정본도 경계 불변).
                //   라이브가 비면 경계를 남기지 않는다(제한 없음 — 빈 대화에서 전부 지우면 안 된다).
                cutoffTurn: maxPair > 0 ? maxPair : null
            }, scopeKey);
        };
        const cache = new Map();
        const worldlineKeyFor = (scopeKey = '') => `LIBRA_WORLDLINE::v1::${hashOf(text(scopeKey || 'global'))}`;
        // Export cannot normalize or synthesize missing worldline state.
        const readInventoryWorldline = async (scopeKey = '') => {
            const key = text(scopeKey);
            if (!key) throw new Error('WM_scope_unverified');
            const raw = await RisuCompat.pluginStorage.getItem(worldlineKeyFor(key), {strict:true});
            if (raw == null) return {ok:true,missing:true,scopeKey:key,storageKey:worldlineKeyFor(key),raw:null};
            let value;
            try { value = JSON.parse(raw); } catch (_) { throw new Error('WM_worldline_invalid'); }
            if (value?.version !== SCHEMA || value.scopeKey !== key || !Array.isArray(value.nodes)) throw new Error('WM_worldline_scope_unverified');
            return {ok:true,missing:false,scopeKey:key,storageKey:worldlineKeyFor(key),raw};
        };
        const load = async (scopeKey = '') => {
            const key = text(scopeKey);
            if (!key) return empty('');
            try {
                const routed=WmWriterRuntime.enabled?await WmWriterRuntime.findCompanion(key,'libra_turn_worldline_v1'):null;
                if(WmWriterRuntime.enabled&&!routed.ok)throw Error(routed.reason);
                if(!WmWriterRuntime.enabled&&VersionedCanonicalBridge.mode==='authority')throw Error('authority_lineage_read_unsupported');
                const raw = WmWriterRuntime.enabled?routed.raw:await RisuCompat.pluginStorage.getItem(worldlineKeyFor(key), {strict:true});
                const parsed = raw == null ? null : JSON.parse(String(raw));
                if (typeof WmManualRuntime !== 'undefined' && WmManualRuntime && parsed !== null && (parsed?.version !== SCHEMA || parsed.scopeKey !== key || !Array.isArray(parsed.nodes))) throw Error('WM_lineage_scope_unverified');
                const normalized = normalize(parsed, key);
                cache.set(key, normalized);
                return normalized;
            } catch (error) {
                if (typeof WmManualRuntime !== 'undefined' && WmManualRuntime) { cache.delete(key); throw error; }
                return cache.get(key) || empty(key);
            }
        };
        const put = async (scopeKey = '', state = null, options = {}) => {
            const key = text(scopeKey);
            if (!key) return empty('');
            const normalized = normalize(state, key);
            if(WmWriterRuntime.enabled){const result=await WmWriterRuntime.putWorldline(key,normalized,options);if(!result.ok)throw Error(result.reason);cache.set(key,normalized);return normalized;}
            if(VersionedCanonicalBridge.mode==='authority')throw Error('authority_lineage_writer_unsupported');
            if (typeof WmManualRuntime !== 'undefined' && WmManualRuntime) {
                try {
                    if (typeof options.isCurrent === 'function' && !options.isCurrent()) throw Error('WM_lineage_scope_changed');
                    const wire = JSON.stringify(normalized), storageKey = worldlineKeyFor(key);
                    if (await RisuCompat.pluginStorage.setItem(storageKey, wire, {strict:true}) === false) throw Error('WM_lineage_write_rejected');
                    if (await RisuCompat.pluginStorage.getItem(storageKey, {strict:true}) !== wire) throw Error('WM_lineage_readback_mismatch');
                    if (typeof options.isCurrent === 'function' && !options.isCurrent()) throw Error('WM_lineage_scope_changed');
                    cache.set(key, normalized);
                    return normalized;
                } catch (error) { cache.delete(key); throw error; }
            }
            cache.set(key, normalized);
            try {
                await RisuCompat.pluginStorage.setItem(worldlineKeyFor(key), JSON.stringify(normalized));
            } catch (_) {}
            return normalized;
        };
        // 라이브 쌍을 관찰하고 저장까지 한다.
        const observe = async (scopeKey = '', pairs = [], options = {}) => {
            const key = text(scopeKey);
            const previous = cache.get(key) || await load(key);
            if (typeof options?.isCurrent === 'function' && !options.isCurrent()) return previous;
            if (typeof options?.verifySource === 'function' && !await options.verifySource()) return previous;
            if (typeof options?.isCurrent === 'function' && !options.isCurrent()) return previous;
            const next = reduceWorldline(previous, key, pairs, options);
            return await put(key, next, options);
        };
        const save = async (scopeKey = '', options = {}) => put(scopeKey, cache.get(text(scopeKey)) || await load(scopeKey),options);
        const get = (scopeKey = '') => cache.get(text(scopeKey)) || empty(text(scopeKey));
        // 현재 유효한(살아있는) 노드만 — 프롬프트·회상에 쓸 것
        const activeNodes = (state = null) => (Array.isArray(state?.nodes) ? state.nodes : [])
            .filter(node => LIVE_STATUSES.has(node.status));
        const supersededNodes = (state = null) => (Array.isArray(state?.nodes) ? state.nodes : [])
            .filter(node => !LIVE_STATUSES.has(node.status));
        // 물러난 턴 집합 — 회상(프롬프트 주입)에서 제외할 턴 번호.
        //
        // 리롤로 밀려난 턴(oldActive → superseded)과 잘려나간 턴(orphaned /
        // detached)의 기억을 프롬프트에서 빼야 한다. 그러지 않으면 모델이
        // 폐기된 응답의 내용을 사실로 취급해 리롤의 의미가 사라진다.
        //
        // 단, **물러난 노드가 있어도 그 논리 턴에 살아있는 variant 가 있으면 제외하지
        // 않는다** — 리롤 후의 새 응답은 유효하기 때문이다.
        // ══ 롤백 **경계** 판정 — 정본 `LIBRA.js` 41792 / 46304 와 같은 규칙 ══
        //   계층마다 롤백 규칙을 복제하지 않도록 **여기 하나**에서 답한다.
        const effectiveCutoff = (state = null) => {
            const value = Number((state && typeof state === 'object') ? state.cutoffTurn : NaN);
            // 정본: `cutoffTurn == null ? Infinity : Number(cutoffTurn)` — 경계가 없으면 제한 없음.
            return (Number.isFinite(value) && value > 0) ? value : Number.POSITIVE_INFINITY;
        };
        // 경계를 넘은(= 라이브에서 잘려나간) 턴 번호들.
        const turnsBeyondCutoff = (state = null) => {
            const cutoff = effectiveCutoff(state);
            if (!Number.isFinite(cutoff)) return [];
            const nodes = (state && Array.isArray(state.nodes)) ? state.nodes : [];
            const out = new Set();
            for (const node of nodes) {
                const turn = Number(node?.pairIndex) || 0;
                if (turn > cutoff) out.add(turn);
            }
            return Array.from(out).sort((a, b) => a - b);
        };
        // 계층이 한 줄로 묻는 술어. 경계가 없으면 **false**(종전 동작 — fail-open).
        const isTurnBeyondCutoff = (turn = 0, state = null) => {
            const cutoff = effectiveCutoff(state);
            if (!Number.isFinite(cutoff)) return false;
            const value = Number(turn) || 0;
            return value > cutoff;
        };
        const buildSupersededTurnSet = (state = null) => {
            const snapshot = state && typeof state === 'object' ? state : {};
            const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
            const liveTurns = new Set();
            for (const node of nodes) {
                if (LIVE_STATUSES.has(node.status)) liveTurns.add(Number(node.pairIndex) || 0);
            }
            const superseded = new Set();
            const reasons = {};
            for (const node of nodes) {
                if (LIVE_STATUSES.has(node.status)) continue;
                const turn = Number(node.pairIndex) || 0;
                if (!turn) continue;
                // 같은 턴에 살아있는 variant 가 있으면 그 턴은 유효하다.
                if (liveTurns.has(turn)) continue;
                superseded.add(turn);
                reasons[turn] = String(node.status || 'orphaned');
            }
            // ★ 경계를 함께 낸다 — 노드 기록이 사라져도(트림·미기록·구 데이터) 롤백된 턴을
            //   막을 수 있다. 실측: 노드가 없으면 위 `superseded` 가 **빈 집합**이 되어
            //   기억·엔티티·RP-LTM 필터 4개가 전부 무력해졌다(경계는 답을 알고 있는데도).
            for (const turn of Array.isArray(snapshot.requestExcludedTurns) ? snapshot.requestExcludedTurns : []) {
                const value = Number(turn);
                if (value > 0) { superseded.add(value); liveTurns.delete(value); reasons[value] = 'request_topology_exclusion'; }
            }
            const cutoff = effectiveCutoff(snapshot);
            return { superseded, liveTurns, reasons, nodeCount: nodes.length, cutoff };
        };
        // 계층이 한 줄로 묻는 **단일 술어** — 노드 판정과 경계 판정을 합친다.
        //   ★ 리롤은 경계 **안**이다(같은 위치의 다른 응답) → `turn > cutoff` 가 false 라 유지된다.
        //   ★ 턴을 모르면(0) 언제나 false — 정보 손실 방지 규칙이 그대로 유지된다.
        // Request-local source ownership exclusion; never observes original text.
        const buildDriftExclusion = (scopeKey = '', livePairs = []) => {
            const key = text(scopeKey);
            if (!key) return null;
            const topology = detectDrift(key, livePairs);
            const turns = [...new Set([...topology.rolledBack, ...topology.unresolved]
                .map(item => Number(item.pairIndex) || 0).filter(Boolean))].sort((a, b) => a - b);
            if (!turns.length) return null;
            return { scopeKey: key, turns: new Set(turns), detectedAt: Date.now(),
                reason: topology.unresolved.length ? 'topology_unresolved' : 'native_topology_changed',
                unresolved: topology.unresolved };
        };
        // Exclusion-only view: no write, activation, ordinal remap or ID backfill.
        const withRequestExclusion = (state = null, exclusion = null, scopeKey = '') => {
            if (!state || !exclusion || text(exclusion.scopeKey) !== text(scopeKey)
                || (text(state.scopeKey) && text(state.scopeKey) !== text(scopeKey))) return state;
            const values = exclusion.turns instanceof Set ? Array.from(exclusion.turns)
                : (Array.isArray(exclusion.turns) ? exclusion.turns : []);
            const turns = [...new Set(values.map(Number).filter(turn => Number.isFinite(turn) && turn > 0))];
            if (!turns.length) return state;
            return Object.freeze({ ...state, requestExcludedTurns: Object.freeze(turns),
                nodes: Object.freeze((state.nodes || []).map(node => Object.freeze({ ...node,
                    status: turns.includes(Number(node.pairIndex)) ? 'orphaned' : node.status }))) });
        };
        //   임시 제외 집합을 기억 목록에 적용한다. `scopeKey` 가 다르면 아무것도 하지 않는다(안전).
        const applyDriftExclusion = (entries = [], exclusion = null, scopeKey = '') => {
            const list = Array.isArray(entries) ? entries : [];
            const ex = (exclusion && typeof exclusion === 'object') ? exclusion : null;
            if (!ex || !(ex.turns instanceof Set) || ex.turns.size === 0) return { entries: list, excluded: 0, turns: [] };
            if (scopeKey && text(ex.scopeKey) && text(ex.scopeKey) !== text(scopeKey)) return { entries: list, excluded: 0, turns: [] };
            const excludedTurns = [];
            const kept = list.filter(entry => {
                const turn = memoryEntryTurn(entry);
                if (!turn || !ex.turns.has(turn)) return true;
                if (!excludedTurns.includes(turn)) excludedTurns.push(turn);
                return false;
            });
            return { entries: kept, excluded: list.length - kept.length, turns: excludedTurns.sort((a, b) => a - b) };
        };
        const isSupersededTurn = (turn = 0, index = null) => {
            const value = Number(turn) || 0;
            if (!value) return false;
            const bag = (index && typeof index === 'object') ? index : {};
            if (bag.superseded instanceof Set && bag.superseded.has(value)) return true;
            const cutoff = Number(bag.cutoff);
            return Number.isFinite(cutoff) && value > cutoff;
        };
        // 응답 지문 — 기억이 **어느 응답**에서 나왔는지 기록한다.
        //
        // 종전 기억 메타에는 사용자 메시지 해시만 있어서(sourceHash), 리롤로 응답이
        // 바뀌어도 옛 기억과 새 기억을 구별할 수 없었다. 측정으로 확인한 결함:
        // 리롤 후 "왕이 죽었다"(옛 응답)와 "왕은 살아있다"(새 응답)가 동시에
        // 회상에 실렸다 — 누적 저장에서 리롤이 작동하지 않았다.
        const memoryVariantStamp = (scopeKey = '', turn = 0, assistantText = '') => {
            const key = text(scopeKey);
            const t = Number(turn) || 0;
            if (!key || !t) return null;
            const identity = identityFor(key, { pairIndex: t, userText: '', assistantText: text(assistantText) });
            return { turn: t, assistantHash: identity.assistantHash, logicalTurnId: identity.logicalTurnId, variantId: identity.variantId };
        };
        // 기억 엔트리에 지문을 심는다 (메타에 vh 필드 추가).
        const stampMemoryVariant = (entry = null, stamp = null) => {
            if (!entry || typeof entry !== 'object' || !stamp?.assistantHash) return entry;
            try {
                const content = String(entry.content || '');
                const match = content.match(/\[META:(\{[^\r\n]*\})]/);
                if (!match) return { ...entry, meta: { ...(entry.meta || {}), variantHash: stamp.assistantHash, variantTurn: stamp.turn } };
                const meta = JSON.parse(match[1]);
                meta.vh = stamp.assistantHash;
                meta.vt = stamp.turn;
                const next = content.replace(match[0], `[META:${JSON.stringify(meta)}]`);
                return { ...entry, content: next };
            } catch (_) { return entry; }
        };
        // 기억 엔트리의 지문을 읽는다 (메타의 vh 또는 최상위 meta.variantHash).
        const memoryVariantHash = (entry = null) => {
            try {
                const content = String(entry?.content || '');
                const match = content.match(/\[META:(\{[^\r\n]*\})]/);
                if (match) {
                    const meta = JSON.parse(match[1]);
                    return text(meta?.vh || meta?.variantHash || '').trim();
                }
                return text(entry?.meta?.variantHash || '').trim();
            } catch (_) { return ''; }
        };
        // 기억 엔트리의 턴 번호를 뽑는다 (메타의 t / turn / finalizedTurn 등).
        const memoryEntryTurn = (entry = null) => {
            try {
                const content = String(entry?.content || '');
                const match = content.match(/\[META:(\{[^\r\n]*\})]/);
                if (match) {
                    const meta = JSON.parse(match[1]);
                    const turn = Number(meta?.turnAnchorTurn || meta?.finalizedTurn || meta?.turn || meta?.t || 0);
                    if (Number.isFinite(turn) && turn > 0) return turn;
                }
                const parsed = JSON.parse(content);
                const meta = parsed?.meta || parsed?.metadata || {};
                const turn = Number(meta?.turnAnchorTurn || meta?.finalizedTurn || meta?.turn || meta?.t || 0);
                return Number.isFinite(turn) && turn > 0 ? turn : 0;
            } catch (_) { return 0; }
        };
        // 물러난 턴의 기억을 걸러낸다. state 가 없으면 그대로 돌려준다 (안전한 기본값).
        // RP-LTM/State 아이템도 리롤·롤백에서 걸러야 한다.
        //   기억(memories)은 13c 에서 걸렀지만 RP 장기 연속성은 로어에서 직접 읽어 나가
        //   **같은 필터를 안 탔다** (실측: 정본 기억은 걸러지는데 RP-LTM 은 안 걸러짐).
        //   아이템은 lastTurn/firstTurn 을 갖고 있으므로 그 턴이 superseded 면 제거한다.
        const filterSupersededRpItems = (items = [], state = null) => {
            const list = Array.isArray(items) ? items : [];
            if (!state || list.length === 0) {
                return { items: list, excluded: 0, excludedTurns: [] };
            }
            const index = buildSupersededTurnSet(state);
            const { superseded } = index;
            // 경계만 있고 노드가 없을 수도 있다 — 그때도 거를 수 있어야 한다(실측 결함).
            if ((!superseded || superseded.size === 0) && !Number.isFinite(index.cutoff)) {
                return { items: list, excluded: 0, excludedTurns: [] };
            }
            const turnOf = (item) => {
                const t = Number(item?.lastTurn || item?.turn || item?.firstTurn || 0) || 0;
                return t > 0 ? t : 0;
            };
            const excludedTurns = new Set();
            const kept = list.filter(item => {
                const t = turnOf(item);
                if (!t || !isSupersededTurn(t, index)) return true;
                excludedTurns.add(t);
                return false;
            });
            return {
                items: kept,
                excluded: list.length - kept.length,
                excludedTurns: Array.from(excludedTurns).sort((a, b) => a - b)
            };
        };
        // §5-5 쓰기 시점 guard — **엔티티·관계**도 리롤·롤백된 턴이면 저장하지 않는다.
        //
        // 왜 필요한가 (실측 결함):
        //   `08e:497 saveToLorebook` 이 `entityCache`/`relationCache` 전체를 무조건 기록했다.
        //   → 리롤·롤백된 턴에서 만들어진 엔티티·관계도 그대로 저장됐다.
        //   다른 계층은 이미 필터를 탄다 — 기억(`filterSupersededMemories`),
        //   RP-LTM(`filterSupersededRpItems`, #1), 세계선 노드. **엔티티·관계만 안 탔다**(비대칭).
        //
        // 새 축을 만들지 않는다 — 엔티티·관계가 이미 갖고 있는 **턴 도장**을 쓴다:
        //   엔티티 `meta.created` / `meta.sourceTurn` / `quality.lastUpdatedTurn`,
        //   관계 `meta.created` / `meta.sourceTurn` / `relationTimeline.baseline.turn`.
        const entityRecordTurn = (record = {}) => {
            if (!record || typeof record !== 'object') return 0;
            const meta = record.meta && typeof record.meta === 'object' ? record.meta : {};
            const quality = record.quality && typeof record.quality === 'object' ? record.quality : {};
            const timeline = record.relationTimeline && typeof record.relationTimeline === 'object'
                ? record.relationTimeline : {};
            const baseline = timeline.baseline && typeof timeline.baseline === 'object' ? timeline.baseline : {};
            const turn = Number(
                // 명시 필드 우선(`stampTurn`), 레거시 `meta.created` 는 타임스탬프가 아닐 때만.
                stampTurn(meta)
                || quality.lastUpdatedTurn || baseline.turn || record.sourceTurn || 0
            );
            // ★ 타임스탬프를 턴으로 반환하지 않는다 — 레거시 `meta.created` 가 `Date.now()` 인
            //   데이터가 오면 그것도 범위 가드를 통과하므로, 반환 직전에 한 번 더 막는다.
            if (!Number.isFinite(turn) || turn <= 0) return 0;
            return legacyTurnWithinRange(turn);
        };
        const filterSupersededEntityRecords = (records = [], state = null) => {
            const list = Array.isArray(records) ? records : [];
            // worldline 상태가 없으면 **종전과 동일**(fail-open, 하위 호환).
            if (!state || list.length === 0) return { items: list, excluded: 0, excludedTurns: [] };
            const index = buildSupersededTurnSet(state);
            const { superseded } = index;
            // 경계만 있고 노드가 없을 수도 있다 — 그때도 거를 수 있어야 한다(실측 결함).
            if ((!superseded || superseded.size === 0) && !Number.isFinite(index.cutoff)) {
                return { items: list, excluded: 0, excludedTurns: [] };
            }
            const excludedTurns = new Set();
            const kept = list.filter(record => {
                const turn = entityRecordTurn(record);
                // 턴을 알 수 없으면 **버리지 않는다** — 저장에서 빼면 정보가 사라진다(보수적).
                if (!turn) return true;
                if (isSupersededTurn(turn, index)) { excludedTurns.add(turn); return false; }
                return true;
            });
            return {
                items: kept,
                excluded: list.length - kept.length,
                excludedTurns: Array.from(excludedTurns).sort((a, b) => a - b)
            };
        };
        const filterSupersededMemories = (entries = [], state = null) => {
            const list = Array.isArray(entries) ? entries : [];
            if (!state) return { entries: list, excluded: 0, excludedTurns: [], excludedByVariant: 0 };
            const { superseded } = buildSupersededTurnSet(state);
            // 턴별로 현재 살아있는 variant 의 응답 지문을 모은다.
            const liveVariantByTurn = new Map();
            const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
            for (const node of nodes) {
                if (!LIVE_STATUSES.has(node.status)) continue;
                const turn = Number(node.pairIndex) || 0;
                if (turn) liveVariantByTurn.set(turn, text(node.assistantHash).trim());
            }
            if (superseded.size === 0 && liveVariantByTurn.size === 0) {
                return { entries: list, excluded: 0, excludedTurns: [], excludedByVariant: 0 };
            }
            const excludedTurns = [];
            let excludedByVariant = 0;
            const index = { superseded, cutoff: buildSupersededTurnSet(state).cutoff };
            const kept = list.filter(entry => {
                const turn = memoryEntryTurn(entry);
                // (1) 잘려나간 턴 (롤백) — 살아있는 variant 가 없다. 경계를 넘은 턴도 포함한다.
                if (isSupersededTurn(turn, index)) {
                    if (!excludedTurns.includes(turn)) excludedTurns.push(turn);
                    return false;
                }
                // (2) 같은 턴인데 다른 응답의 기억 (리롤) — 지문이 다르면 폐기된 응답이다.
                //     지문이 없는 옛 기억은 제외하지 않는다 (하위 호환).
                const stamp = memoryVariantHash(entry);
                if (stamp && turn && liveVariantByTurn.has(turn)) {
                    const liveHash = liveVariantByTurn.get(turn);
                    if (liveHash && liveHash !== stamp) {
                        excludedByVariant += 1;
                        if (!excludedTurns.includes(turn)) excludedTurns.push(turn);
                        return false;
                    }
                }
                return true;
            });
            return { entries: kept, excluded: list.length - kept.length, excludedTurns, excludedByVariant };
        };
        const isSupersededMemory = (entry = null, state = null) => {
            if (!state) return false;
            const index = buildSupersededTurnSet(state);
            return isSupersededTurn(memoryEntryTurn(entry), index);
        };
        // Metadata-only host topology. Never inspect original message bodies.
        const nativeMessageIds = message => {
            const ids = [];
            for (const value of [message?.id, message?.messageId, message?.m_id, message?.uuid,
                message?.key, message?.chatId, message?.generationInfo?.generationId]) {
                if (typeof value !== 'string') continue;
                const id = value.trim();
                if (!id || /^\d+$/.test(id)
                    || /(?:^|\|)(?:T\d+$|(?:idx_|index:|position:|pos:|turn:)\d+(?:$|\|))/i.test(id)
                    || /^(?:derivedmsg|afterrequest|synthetic|fallback|legacy|hash|sha(?:1|256|512)?|content(?:-hash)?|text(?:-hash)?):/i.test(id)) continue;
                if (!ids.includes(id)) ids.push(id);
            }
            return ids;
        };
        const nativeMessageId = message => nativeMessageIds(message)[0] || '';
        const buildTopologyPairs = (chat = null) => {
            const messages = chat?.msgs || chat?.messages || chat?.message || chat?.log || chat?.mes || chat?.chat;
            if (!Array.isArray(messages)) return { pairs: [], complete: false, reason: 'host_topology_unavailable' };
            const pairs = [], nativeIdCounts = new Map();
            let pendingUser = null;
            for (const message of messages) {
                for (const id of nativeMessageIds(message)) nativeIdCounts.set(id, (nativeIdCounts.get(id) || 0) + 1);
                if (!message || message.isOOC === true || message.isComment === true || message.disabled === true) continue;
                const role = text(message.role).trim().toLowerCase();
                if (role === 'user') pendingUser = message;
                else if (role === 'assistant' || role === 'char') {
                    pairs.push({ pairIndex: pairs.length + 1,
                        userMessageId: nativeMessageId(pendingUser), assistantMessageId: nativeMessageId(message),
                        userMessageIds: nativeMessageIds(pendingUser), assistantMessageIds: nativeMessageIds(message) });
                    pendingUser = null;
                }
            }
            return { pairs, complete: true, nativeIdCounts };
        };
        // Compatibility name: no historical text hashes or inferred edits/rerolls.
        const detectDrift = (scopeKey = '', livePairs = []) => {
            const key = text(scopeKey), state = get(key), stored = activeNodes(state);
            const complete = Array.isArray(livePairs) || livePairs?.complete === true;
            const live = Array.isArray(livePairs) ? livePairs : (Array.isArray(livePairs?.pairs) ? livePairs.pairs : []);
            const byAssistant = new Map(), byUser = new Map(), pairIdCounts = new Map();
            for (const pair of live) {
                for (const [map, values] of [[byAssistant, [pair?.assistantMessageId, ...(pair?.assistantMessageIds || [])]],
                    [byUser, [pair?.userMessageId, ...(pair?.userMessageIds || [])]]]) {
                    for (const id of new Set(values.map(value => text(value).trim()).filter(Boolean))) {
                        const list = map.get(id) || []; list.push(pair); map.set(id, list);
                        pairIdCounts.set(id, (pairIdCounts.get(id) || 0) + 1);
                    }
                }
            }
            const nativeIdCounts = livePairs?.nativeIdCounts instanceof Map ? livePairs.nativeIdCounts : pairIdCounts;
            const rolledBack = [], unresolved = [], legacy = [];
            let unchangedCount = 0, knownTopologyMoved = false;
            for (const node of stored) {
                if (!complete) { unresolved.push({ pairIndex: node.pairIndex, reason: 'host_topology_unavailable' }); continue; }
                if (!node.userMessageId && !node.assistantMessageId) { legacy.push(node); continue; }
                const matches = node.assistantMessageId ? (byAssistant.get(node.assistantMessageId) || []) : null;
                const users = node.userMessageId ? (byUser.get(node.userMessageId) || []) : null;
                if (matches?.length === 0 || users?.length === 0) {
                    rolledBack.push({ pairIndex: node.pairIndex, reason: 'native_source_removed_or_replaced', turnNodeId: node.turnNodeId });
                    knownTopologyMoved = true; continue;
                }
                if ((node.assistantMessageId && nativeIdCounts.get(node.assistantMessageId) !== 1)
                    || (node.userMessageId && nativeIdCounts.get(node.userMessageId) !== 1)
                    || (matches && matches.length !== 1) || (users && users.length !== 1)
                    || (matches && users && matches[0] !== users[0])) {
                    unresolved.push({ pairIndex: node.pairIndex, reason: 'native_pair_ownership_ambiguous' });
                    knownTopologyMoved = true; continue;
                }
                if (Number((matches || users)[0].pairIndex) !== (node.activeOrdinal || node.originalOrdinal)) knownTopologyMoved = true;
                if (!matches || !users) legacy.push(node);
                else unchangedCount++;
            }
            const expectedLegacyEnd = Math.max(0, ...legacy.map(node => node.activeOrdinal || node.originalOrdinal));
            for (const node of legacy) {
                if (knownTopologyMoved || live.length < expectedLegacyEnd) unresolved.push({ pairIndex: node.pairIndex, reason: 'legacy_topology_unresolved' });
                else unchangedCount++;
            }
            return { scopeKey: key, changed: rolledBack.length > 0 || unresolved.length > 0,
                rolledBack, unresolved, rerolled: [], unchangedCount, livePairCount: live.length,
                storedNodeCount: state.nodes.length, detectedAt: Date.now() };
        };

        // 세계선 뷰 — GUI 에 노드·이력·계보를 보여준다. 사용자 언어로만 표시한다.
        const statusLabel = (status = '') => ({
            active: '현재', quarantined: '보류',
            superseded: '이력 · 리롤됨', detached: '이력 · 갈라짐', orphaned: '이력 · 삭제됨',
            // 구 저장 데이터가 옛 이름을 갖고 있어도 라벨이 나오게 한다(하위 호환).
            inactive_variant: '이력 · 리롤됨', detached_branch: '이력 · 갈라짐'
        }[String(status)] || '이력');
        const renderWorldlineView = (state = null, options = {}) => {
            const snapshot = state && typeof state === 'object' ? state : empty('');
            const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
            const lineage = options?.lineage && typeof options.lineage === 'object' ? options.lineage : null;
            const head = [];
            head.push('<div class="wl-head">');
            head.push(`<div class="wl-stat">현재 ${activeNodes(snapshot).length}개 · 이력 ${supersededNodes(snapshot).length}개</div>`);
            if (snapshot.revision) head.push(`<div class="wl-rev">기록 ${Number(snapshot.revision) || 0}회차</div>`);
            head.push('</div>');
            if (lineage) {
                const statusText = ({
                    verified: '검증됨 — 부모의 기억을 물려받았습니다',
                    diverged: '부모와 내용이 갈라졌습니다',
                    unverified: '분기 근거를 확인할 수 없습니다',
                    independent: '독립된 대화입니다'
                }[String(lineage.status)] || '분기 정보 없음');
                head.push('<div class="wl-lineage">');
                head.push(`<div class="wl-lineage-title">분기</div>`);
                head.push(`<div class="wl-lineage-body">${statusText}</div>`);
                if (lineage.parentChatId) head.push(`<div class="wl-lineage-note">부모 대화 · ${lineage.commonPrefixPairs ? `공통 ${lineage.commonPrefixPairs}턴` : ''}</div>`);
                head.push('</div>');
            }
            if (nodes.length === 0) {
                return `<div class="wl-empty">아직 기록된 턴이 없습니다. 대화를 진행하면 여기에 세계선이 쌓입니다.</div>`;
            }
            const active = activeNodes(snapshot).slice().sort((a, b) => a.pairIndex - b.pairIndex);
            const history = supersededNodes(snapshot).slice().sort((a, b) => a.pairIndex - b.pairIndex);
            // 노드가 실제로 들고 있는 시점 정보를 보여준다. 로직은 그대로 두고 표현만 넓힌다.
            const fmtTime = (value) => {
                const ms = Number(value) || 0;
                if (!ms) return '';
                // 로케일마다 다른 형식(9. 16. PM 02:20 등)을 쓰지 않고 직접 조립한다.
                try {
                    const d = new Date(ms);
                    const p2 = (v) => String(v).padStart(2, '0');
                    return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
                } catch (_) { return ''; }
            };
            const variantCountFor = (node) => nodes.filter(n => n.logicalTurnId === node.logicalTurnId).length;
            const rowFor = (node, cls) => {
                const parts = [];
                parts.push(`<div class="wl-node ${cls}">`);
                parts.push('<div class="wl-node-top">');
                parts.push(`<span class="wl-turn">턴 ${Number(node.pairIndex) || 0}</span>`);
                parts.push(`<span class="wl-status">${statusLabel(node.status)}</span>`);
                parts.push('</div>');
                const meta = [];
                const variants = variantCountFor(node);
                if (variants > 1) meta.push(`같은 턴 ${variants}번째 시도`);
                const created = fmtTime(node.createdAt);
                if (created) meta.push(`기록 ${created}`);
                const updated = fmtTime(node.updatedAt);
                if (updated && Number(node.updatedAt) !== Number(node.createdAt)) meta.push(`갱신 ${updated}`);
                if (node.supersededBy) meta.push('다음 시도로 물러남');
                if (meta.length) parts.push(`<div class="wl-node-meta">${meta.map(text).join(' · ')}</div>`);
                parts.push('</div>');
                return parts.join('');
            };
            const rows = [];
            rows.push('<div class="wl-section">현재 경로</div>');
            rows.push('<div class="wl-chain">');
            for (const node of active) {
                rows.push(rowFor(node, 'on'));
            }
            rows.push('</div>');
            if (history.length > 0) {
                rows.push(`<div class="wl-section">이력 (${history.length}개) — 리롤·삭제로 물러난 턴</div>`);
                rows.push('<div class="wl-history">');
                for (const node of history) {
                    rows.push(rowFor(node, 'off'));
                }
                rows.push('</div>');
            }
            return head.join('') + rows.join('');
        };
        const renderWorldlineHtml = renderWorldlineView;

        const selfCheck = (scopeKey = '') => {
            const state = get(scopeKey);
            return {
                scopeKey: text(scopeKey), storageKey: worldlineKeyFor(scopeKey), revision: state.revision,
                nodeCount: state.nodes.length,
                activeCount: activeNodes(state).length,
                inactiveCount: supersededNodes(state).length,
                headTurnNodeId: state.headTurnNodeId
            };
        };
        return Object.freeze({
            SCHEMA, identityFor, reduceWorldline, empty, normalize,
            load, put, observe, save, get, readInventoryWorldline, worldlineKeyFor, detectDrift, buildTopologyPairs, nativeMessageId, nativeMessageIds, buildSupersededTurnSet,
            effectiveCutoff, turnsBeyondCutoff, isTurnBeyondCutoff,
            buildDriftExclusion, applyDriftExclusion, withRequestExclusion,
            isSupersededTurn, filterSupersededMemories, filterSupersededRpItems, filterSupersededEntityRecords, entityRecordTurn, isSupersededMemory, memoryEntryTurn, memoryVariantStamp, stampMemoryVariant, memoryVariantHash, renderWorldlineView, renderWorldlineHtml, statusLabel,
            activeNodes, supersededNodes, selfCheck
        });
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LibraTurnWorldline = LibraTurnWorldline;
    } catch (_) {}


    // ══════════════════════════════════════════════════════════════
    // Host Lineage — RisuAI 가 채팅에 남긴 브랜치 표식을 읽어 계보를 세운다.
    //
    // Downloads/plugins 의 LIBRARIAN HOST LINEAGE SDK v1 을 실측한 규칙:
    // RisuAI 는 채팅을 분기할 때 자식 채팅에 주석 메시지를 남긴다 —
    //   {{specialcomment::branchedfrom::<parentChatId>::<parentName>::<forkMessageId>::}}
    //
    // 판정:
    //   independent — 표식 없음
    //   unverified  — 표식은 있으나 부모를 못 찾거나 형식이 깨짐 (상속 불가)
    //   diverged    — 공통 접두가 표식 위치와 다르거나 greeting 선택이 바뀜 (상속 불가)
    //   verified    — 부모·자식의 공통 접두가 표식 위치와 정확히 일치 (상속 가능)
    //
    // RP 대사 안에 인용된 문자열은 계보가 아니다 — isComment && disabled &&
    // role==='assistant' 인 메시지만 표식으로 인정한다.
    // ══════════════════════════════════════════════════════════════
    const LibraHostLineage = (() => {
        const SCHEMA = 'librarian.host_lineage.v1';
        const MARKER_PREFIX = '{{specialcomment::branchedfrom::';
        const MARKER_SUFFIX = '::}}';
        const str = (value) => String(value == null ? '' : value);
        const object = (value) => (value && typeof value === 'object') ? value : {};
        const unwrap = (value) => object(object(value)?.msg || value);
        const messagesOf = (chat) => Array.isArray(chat?.message) ? chat.message
            : (Array.isArray(chat?.messages) ? chat.messages : []);
        const chatIdOf = (chat) => str(chat?.id || chat?.chatId || '');
        const characterIdOf = (character) => str(character?.chaId || character?.id || character?.characterId || '');
        const roleOf = (value) => {
            const item = unwrap(value);
            const raw = str(item.role || item.type || '').toLowerCase();
            if (['user', 'human', 'player'].includes(raw)) return 'user';
            if (['char', 'assistant', 'character', 'bot', 'ai', 'model'].includes(raw)) return 'assistant';
            return raw;
        };
        const bodyOf = (value) => {
            const item = unwrap(value);
            const data = item.data ?? item.content ?? item.text ?? '';
            return typeof data === 'string' ? data : JSON.stringify(data);
        };
        // UI 위치·제목 추측이 아니라 원문 사실로 비교한다.
        const descriptorOf = (value) => {
            const item = unwrap(value);
            return [roleOf(item), str(item.chatId || item.id || ''), bodyOf(item),
                item.disabled === true, item.isComment === true, str(item.saying || '')];
        };
        const sameMessage = (a, b) => {
            const left = descriptorOf(a); const right = descriptorOf(b);
            return left.every((value, index) => value === right[index]);
        };
        const countPairs = (list) => {
            let pending = false; let complete = false; let total = 0;
            for (const raw of list) {
                const item = unwrap(raw);
                if (item.disabled === true || item.isComment === true || !bodyOf(item).trim()) continue;
                const role = roleOf(item);
                if (role === 'user') { if (complete) total += 1; pending = true; complete = false; }
                else if (role === 'assistant' && pending) complete = true;
            }
            return total + (complete ? 1 : 0);
        };
        const fingerprint = (list) => {
            let a = 0x811c9dc5; let b = 0x9e3779b9;
            for (const item of list) {
                const text = JSON.stringify(descriptorOf(item)) + '\u0000';
                for (let index = 0; index < text.length; index += 1) {
                    a = Math.imul(a ^ text.charCodeAt(index), 0x01000193) >>> 0;
                    b = Math.imul(b ^ text.charCodeAt(index), 0x85ebca6b) >>> 0;
                }
            }
            return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
        };
        // 채팅에 남은 분기 표식을 찾는다. 없으면 { present:false }.
        const findMarker = (chat) => {
            const rows = messagesOf(chat);
            let found = null;
            for (let index = 0; index < rows.length; index += 1) {
                const item = unwrap(rows[index]); const text = bodyOf(item);
                // RP 대사 안에 인용된 문자열은 계보가 아니다.
                if (item.isComment !== true || item.disabled !== true || roleOf(item) !== 'assistant'
                    || !text.startsWith(MARKER_PREFIX)) continue;
                found = { present: true, valid: false, markerIndex: index, parentChatId: '', parentName: '', forkMessageId: '' };
                if (!text.endsWith(MARKER_SUFFIX)) continue;
                const fields = text.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length).split('::');
                if (fields.length < 3) continue;
                const parentChatId = fields.shift();
                const forkMessageId = fields.pop();
                const parentName = fields.join('::');   // 이름에 :: 가 들어갈 수 있다
                found = {
                    ...found, parentChatId, parentName, forkMessageId,
                    valid: !!parentChatId && !!forkMessageId && !['undefined', 'null'].includes(forkMessageId)
                };
            }
            return found || { present: false, valid: false, markerIndex: -1, parentChatId: '', parentName: '', forkMessageId: '' };
        };
        const commonPrefix = (parent, child, limit) => {
            const left = messagesOf(parent); const right = messagesOf(child);
            const end = Math.min(left.length, right.length, Math.max(0, Number(limit) || 0));
            let common = 0;
            while (common < end && sameMessage(left[common], right[common])) common += 1;
            const rows = right.slice(0, common);
            return { commonPrefixMessages: common, commonPrefixPairs: countPairs(rows), prefixDigest: fingerprint(rows) };
        };
        // ── ★ 채팅 복제 감지 (감사 G1) ──────────────────────────────────────────
        //   RisuAI 네이티브 복제는 **분기 표식을 남기지 않는다** → 종전엔 `independent_chat` 으로
        //   떨어져 부모 기억을 한 건도 물려받지 못했다.
        //   실측(수리 전, `tools/libra_audit_chat_copy_measure.cjs`): 복제 0건 / 브랜치 3건(대조군).
        //
        //   정본 `HAYAKU_Locator_Continuity.js:11090-11152 inferCopiedChatSource` 와 **같은 규칙**:
        //     ① 후보 메시지가 대상의 **접두**여야 한다 (후보 길이 ≤ 대상 길이, 모든 서명 일치)
        //     ② 후보가 **데이터를 가져야** 한다 — 없으면 복제원이 아니다(결정적 필터)
        //     ③ 정렬: 메시지 수 desc → 제목 유사도 desc → chatId asc → **최상위 하나만** 채택
        //   여기서 새 축을 만들지 않는다 — 기존 `commonPrefix`/`fingerprint`/`countPairs` 를 그대로 쓴다.
        const messageSignature = (row) => {
            const item = unwrap(row);
            return [roleOf(item), str(item.chatId || item.id || ''), bodyOf(item),
                item.disabled === true, item.isComment === true, str(item.saying || '')].join('\u0001');
        };
        //   RisuAI 는 복제본 제목에 ` (Copy)` / ` (Branch 2)` 를 붙인다 — 유사도 판정용으로만 쓴다.
        const stripCopyTitle = (value = '') => str(value).replace(/\s+\((?:Copy|Branch)(?:\s+\d+)?\)\s*$/i, '').trim();
        const inferCopiedChatSource = async (characterValue = null, chatValue = null, options = {}) => {
            const character = object(characterValue); const chat = object(chatValue);
            const targetId = chatIdOf(chat); const targetRows = messagesOf(chat);
            if (!targetId || targetRows.length === 0) return { sourceChatId: '', reason: 'target_unavailable' };
            const targetSignatures = targetRows.map(messageSignature);
            const baseTitle = stripCopyTitle(chat?.name || chat?.title || chat?.chatName || '');
            const chats = Array.isArray(character?.chats) ? character.chats : [];
            const matching = [];
            for (const candidate of chats) {
                const candidateId = chatIdOf(candidate);
                if (!candidateId || candidateId === targetId) continue;
                const rows = messagesOf(candidate);
                if (!rows.length || rows.length > targetSignatures.length) continue;
                const signatures = rows.map(messageSignature);
                if (!signatures.every((signature, index) => signature === targetSignatures[index])) continue;
                const rawTitle = str(candidate?.name || candidate?.title || candidate?.chatName || '');
                matching.push({
                    sourceChatId: candidateId, messageCount: rows.length,
                    titleAffinity: baseTitle && stripCopyTitle(rawTitle) === baseTitle ? 2
                        : (rawTitle && stripCopyTitle(rawTitle) !== rawTitle ? 1 : 0)
                });
            }
            if (!matching.length) return { sourceChatId: '', reason: 'copy_source_not_found' };
            matching.sort((a, b) => b.messageCount - a.messageCount
                || b.titleAffinity - a.titleAffinity || a.sourceChatId.localeCompare(b.sourceChatId));
            //   ② 데이터가 있는 후보만 인정한다 (정본과 같은 필터 — 이게 없으면 빈 복제원을 고른다).
            //      ★ 스코프 조회는 이 IIFE 에 없다 — `LibraDataStorage` 가 콜백으로 넘긴다.
            //        (`scopeKeyFor`/`getShadow`/`storageKeyFor` 는 DataStorage IIFE 전용 —
            //         이 세션에서 5번째로 밟은 스코프 경계 함정.)
            const hasData = typeof options.hasData === 'function' ? options.hasData : null;
            if (!hasData) return { sourceChatId: '', reason: 'data_probe_unavailable' };
            for (const candidate of matching.slice(0, 48)) {
                const candidateChat = chats.find((item) => chatIdOf(item) === candidate.sourceChatId) || null;
                let filled = false;
                try { filled = (await hasData(candidateChat, character)) === true; } catch (_) { filled = false; }
                if (!filled) continue;
                return { sourceChatId: candidate.sourceChatId, messageCount: candidate.messageCount, reason: 'risu_native_chat_copy' };
            }
            return { sourceChatId: '', reason: 'copy_source_has_no_data' };
        };
        //   `inspect` 는 동기(기존 호출자 보존)라 스토리지를 못 본다.
        //   복제 추정이 필요한 **비동기** 경로는 이 함수를 쓴다. 표식이 있으면 표식이 우선이다.
        const inspectWithCopy = async (characterValue = null, chatValue = null, options = {}) => {
            const info = inspect(characterValue, chatValue);
            if (info.kind !== 'independent_chat' || info.status !== 'independent') return info;
            try {
                const copy = await inferCopiedChatSource(characterValue, chatValue, options);
                if (!copy.sourceChatId) return { ...info, copyReason: copy.reason };
                const chats = Array.isArray(object(characterValue)?.chats) ? object(characterValue).chats : [];
                const parent = chats.find((item) => chatIdOf(item) === copy.sourceChatId) || null;
                if (!parent) return { ...info, copyReason: 'copy_source_unavailable' };
                //   복제는 **스냅샷 전체**를 물려받는다 → 접두 전체가 상속 범위다(포크 컷오프 없음).
                const common = commonPrefix(parent, chatValue, Infinity);
                return {
                    ...info, ...common,
                    kind: 'native_chat_copy', status: 'verified', reason: 'risu_native_chat_copy',
                    parentChatId: copy.sourceChatId, parentName: str(parent?.name || ''),
                    path: [copy.sourceChatId, chatIdOf(chatValue)], pathVerified: true, inheritanceEligible: true,
                    copySourceMessageCount: copy.messageCount
                };
            } catch (_) { return info; }
        };
        // 브랜치 계보 판정. 부작용 없는 순수 함수.
        const inspect = (characterValue = null, chatValue = null) => {
            const character = object(characterValue); const chat = object(chatValue);
            const id = chatIdOf(chat); const mark = findMarker(chat);
            const characterId = characterIdOf(character);
            const base = {
                schema: SCHEMA, characterId, hostChatId: id,
                kind: mark.present ? 'native_branch' : 'independent_chat',
                status: 'independent', reason: 'no_native_branch_marker',
                parentChatId: mark.parentChatId, parentName: mark.parentName, forkMessageId: mark.forkMessageId,
                markerIndex: mark.markerIndex, forkMessageIndex: mark.markerIndex - 1,
                commonPrefixMessages: 0, commonPrefixPairs: 0, prefixDigest: '',
                path: id ? [id] : [], pathVerified: !mark.present, inheritanceEligible: false
            };
            if (!id || !characterId) return { ...base, status: 'unverified', reason: 'host_identity_missing', pathVerified: false };
            if (!mark.present) return base;
            if (!mark.valid || mark.parentChatId === id) return { ...base, status: 'unverified', reason: 'invalid_branch_marker', pathVerified: false };
            const chats = Array.isArray(character.chats) ? character.chats : [];
            const parents = chats.filter((item) => chatIdOf(item) === mark.parentChatId);
            if (parents.length !== 1) {
                return { ...base, status: 'unverified', reason: parents.length ? 'duplicate_parent_identity' : 'parent_unavailable', pathVerified: false };
            }
            if (chats.filter((item) => chatIdOf(item) === id).length > 1) {
                return { ...base, status: 'unverified', reason: 'duplicate_target_identity', pathVerified: false };
            }
            const parent = parents[0]; const childRows = messagesOf(chat); const parentRows = messagesOf(parent);
            const common = commonPrefix(parent, chat, mark.markerIndex);
            const result = {
                ...base, ...common, status: 'unverified', pathVerified: false, path: [mark.parentChatId, id]
            };
            const forkInParent = parentRows.map((item, index) => str(unwrap(item).chatId) === mark.forkMessageId ? index : -1).filter((index) => index >= 0);
            const forkInChild = childRows.slice(0, mark.markerIndex).map((item, index) => str(unwrap(item).chatId) === mark.forkMessageId ? index : -1).filter((index) => index >= 0);
            if (forkInParent.length !== 1 || forkInChild.length !== 1) return { ...result, reason: 'fork_identity_not_unique' };
            if (forkInParent[0] !== mark.markerIndex - 1 || forkInChild[0] !== mark.markerIndex - 1) {
                return { ...result, reason: 'fork_position_mismatch' };
            }
            if (common.commonPrefixMessages !== mark.markerIndex) return { ...result, status: 'diverged', reason: 'branch_prefix_changed' };
            if (Number(parent.fmIndex ?? -1) !== Number(chat.fmIndex ?? -1)) {
                return { ...result, status: 'diverged', reason: 'greeting_selection_changed' };
            }
            // 조상을 거슬러 올라가 경로를 검증한다 (최대 64단계).
            const seen = new Set([id, mark.parentChatId]);
            let ancestor = parent; let pathVerified = true; let pathReason = '';
            const path = [id, mark.parentChatId];
            for (let depth = 0; depth < 64; depth += 1) {
                const edge = findMarker(ancestor);
                if (!edge.present) break;
                if (!edge.valid) { pathVerified = false; pathReason = 'ancestor_marker_unverified'; break; }
                if (seen.has(edge.parentChatId)) { pathVerified = false; pathReason = 'ancestor_cycle'; break; }
                seen.add(edge.parentChatId); path.push(edge.parentChatId);
                const nextParents = chats.filter((item) => chatIdOf(item) === edge.parentChatId);
                if (nextParents.length !== 1) { pathVerified = false; pathReason = 'ancestor_unavailable'; break; }
                ancestor = nextParents[0];
            }
            return {
                ...result, status: 'verified', pathVerified, pathReason,
                path, inheritanceEligible: pathVerified === true
            };
        };
        // 현재 채팅의 계보 (RisuCompat 경유).
        const current = async () => {
            try {
                const character = await RisuCompat.getCharacter?.();
                const chatIndex = await RisuCompat.getCurrentChatIndex?.();
                const chat = Number.isInteger(Number(chatIndex))
                    ? (Array.isArray(character?.chats) ? character.chats[Number(chatIndex)] : null)
                    : null;
                if (!character || !chat) return inspect(character, chat);
                return inspect(character, chat);
            } catch (_) { return inspect(null, null); }
        };
        // 계보 상속 가능 여부만 빠르게 확인 (부모 스코프를 물려받을지 판단).
        const isInheritable = (info = null) => info?.status === 'verified' && info?.inheritanceEligible === true && !!info?.parentChatId;

        // ★ 호스트 월드라인 메타 — **크로스플러그인 정본 계약**(LIBRA.js v2.3.144 `HOST_WORLDLINE_META_SCHEMA`).
        //   종전 상속 기록에는 `inheritedFrom`(부모 chatId)만 있어서 **부모가 바뀌었는지**를 알 수 없었다.
        //   정본은 `parentWorldlineId|forkTurn|forkFingerprint` **바인딩**으로 판정한다(37479).
        //   여기서 그 값을 만들 수 있게 도출한다(새 축 발명 아님 — lineage 가 이미 다 갖고 있다).
        const HOST_WORLDLINE_META_SCHEMA = 'libra.host.worldline.meta.v1';
        const hostWorldlineMetaOf = (info = null, worldlineId = '', createdAt = 0) => {
            const lineage = object(info);
            return {
                schema: HOST_WORLDLINE_META_SCHEMA,
                worldlineId: str(worldlineId),
                scopeKey: str(worldlineId),
                parentWorldlineId: str(lineage.parentChatId),
                // forkTurn = 계보의 공통 접두 쌍 수, forkFingerprint = 그 접두의 지문.
                forkTurn: Number(lineage.commonPrefixPairs) || 0,
                forkFingerprint: str(lineage.prefixDigest).slice(0, 256),
                createdAt: Number(createdAt) || Date.now()
            };
        };
        // 정본 37479 과 같은 형태의 결합 키. 이 값이 달라지면 **재바인딩이 필요**하다.
        const hostWorldlineBindingOf = (meta = null) => {
            const m = object(meta);
            if (str(m.schema) !== HOST_WORLDLINE_META_SCHEMA) return '';
            return [str(m.parentWorldlineId), String(Number(m.forkTurn) || 0), str(m.forkFingerprint)].join('|');
        };
        return Object.freeze({ SCHEMA, MARKER_PREFIX, MARKER_SUFFIX, inspect, inspectWithCopy, inferCopiedChatSource, current, isInheritable, findMarker, commonPrefix, HOST_WORLDLINE_META_SCHEMA, hostWorldlineMetaOf, hostWorldlineBindingOf });
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LibraHostLineage = LibraHostLineage;
    } catch (_) {}

    const LibraLoreConsolidator = (() => {
        const CONTAINER_MEMO = 'LIBRA_CONTAINER';
        const CATEGORIES = ['lmai_memory', 'lmai_entity_relations'];
        const CATEGORY_SET = new Set(CATEGORIES);
        const ENTITY_RELATION_COMMENTS = new Set(['lmai_entity', 'lmai_relation']);
        const cloneEntry = (entry) => {
            // Lore entries are overwhelmingly flat RisuAI objects with large string content.
            // JSON stringify/parse here was the dominant live-turn CPU hotspot; shallow
            // cloning preserves write isolation for entry fields without reserializing MBs.
            if (!entry || typeof entry !== 'object') return entry;
            if (Array.isArray(entry)) return entry.slice();
            return { ...entry };
        };
        const PACK_TARGET_CHARS = 180000;
        const PACK_MAX_ENTRIES = 32;
        const PACK_CACHE_BASE_BYTES = 24 * 1024 * 1024;
        const UNPACK_CACHE_BASE_BYTES = 24 * 1024 * 1024;
        const packContentCache = new Map();
        const unpackContainerCache = new Map();
        let packContentCacheBytes = 0;
        let unpackContainerCacheBytes = 0;
        let loreCacheRegistered = false;
        const approximateTextBytes = (value = '') => Math.max(0, String(value == null ? '' : value).length * 2);
        const touchCacheEntry = (cache, key, value) => {
            cache.delete(key);
            cache.set(key, value);
            return value;
        };
        const trimLoreCache = (cache, targetBytes = 0, kind = 'pack') => {
            let bytes = kind === 'pack' ? packContentCacheBytes : unpackContainerCacheBytes;
            const target = Math.max(0, Number(targetBytes || 0) || 0);
            let removed = 0;
            while (bytes > target && cache.size > 0) {
                const first = cache.keys().next().value;
                const row = cache.get(first);
                cache.delete(first);
                bytes = Math.max(0, bytes - Number(row?.bytes || 0));
                removed += 1;
            }
            if (kind === 'pack') packContentCacheBytes = bytes;
            else unpackContainerCacheBytes = bytes;
            return removed;
        };
        const ensureLoreCacheRegistered = () => {
            if (loreCacheRegistered) return;
            try {
                if (typeof ResourceGovernor === 'undefined' || !ResourceGovernor?.registerCache) return;
                ResourceGovernor.registerCache({
                    label: 'lore-container-pack',
                    maxBytes: PACK_CACHE_BASE_BYTES,
                    get totalBytes() { return packContentCacheBytes; },
                    trimToBytes(target) { return trimLoreCache(packContentCache, target, 'pack'); },
                    trimToSize(limit) {
                        let removed = 0;
                        while (packContentCache.size > Math.max(1, Number(limit || 1))) {
                            const key = packContentCache.keys().next().value;
                            const row = packContentCache.get(key);
                            packContentCache.delete(key);
                            packContentCacheBytes = Math.max(0, packContentCacheBytes - Number(row?.bytes || 0));
                            removed += 1;
                        }
                        return removed;
                    }
                });
                ResourceGovernor.registerCache({
                    label: 'lore-container-unpack',
                    maxBytes: UNPACK_CACHE_BASE_BYTES,
                    get totalBytes() { return unpackContainerCacheBytes; },
                    trimToBytes(target) { return trimLoreCache(unpackContainerCache, target, 'unpack'); },
                    trimToSize(limit) {
                        let removed = 0;
                        while (unpackContainerCache.size > Math.max(1, Number(limit || 1))) {
                            const key = unpackContainerCache.keys().next().value;
                            const row = unpackContainerCache.get(key);
                            unpackContainerCache.delete(key);
                            unpackContainerCacheBytes = Math.max(0, unpackContainerCacheBytes - Number(row?.bytes || 0));
                            removed += 1;
                        }
                        return removed;
                    }
                });
                loreCacheRegistered = true;
            } catch (_) { /* optional optimization only */ }
        };
        const cacheBudget = (label = '', baseBytes = 0) => {
            try {
                if (typeof ResourceGovernor !== 'undefined' && ResourceGovernor?.getCacheBudget) {
                    return Math.max(512 * 1024, Number(ResourceGovernor.getCacheBudget(label, baseBytes) || baseBytes));
                }
            } catch (_) {}
            return baseBytes;
        };
        const entryPackFingerprint = (entry = {}, index = 0) => stableHash([
            entry?.key || '',
            entry?.comment || '',
            entry?.memo || '',
            entry?.mode || '',
            entry?.insertorder ?? '',
            entry?.alwaysActive === true ? '1' : '0',
            String(entry?.content || ''),
            index
        ].join('\u241f'));
        const partitionLoreBucket = (entries = []) => {
            const shards = [];
            let current = [];
            let chars = 0;
            for (const entry of entries) {
                const estimate = String(entry?.content || '').length + String(entry?.key || '').length + String(entry?.comment || '').length + 192;
                if (current.length > 0 && (current.length >= PACK_MAX_ENTRIES || chars + estimate > PACK_TARGET_CHARS)) {
                    shards.push(current);
                    current = [];
                    chars = 0;
                }
                current.push(entry);
                chars += estimate;
            }
            if (current.length) shards.push(current);
            return shards;
        };
        const isContainer = (entry = null) => {
            if (!entry || typeof entry !== 'object') return false;
            if (entry.memo === CONTAINER_MEMO) return true;
            if (!String(entry.key || '').startsWith('LIBRA_DATA_')) return false;
            if (!CATEGORY_SET.has(String(entry.comment || '').trim())) return false;
            if (typeof entry.content !== 'string') return false;
            try {
                const parsed = JSON.parse(entry.content);
                return parsed && typeof parsed === 'object' && parsed.version && parsed.category && Array.isArray(parsed.entries);
            } catch {
                return false;
            }
        };
        // 로어북만 파싱한다 (섀도 미포함). 라우터의 흡수·기준 계산에 쓴다.
        const unpackRawFromLore = (lorebook = []) => {
            if (!Array.isArray(lorebook) || lorebook.length === 0) return [];
            ensureLoreCacheRegistered();
            const out = [];
            const visit = (entry) => {
                if (!entry || typeof entry !== 'object') return;
                if (!isContainer(entry)) {
                    out.push(cloneEntry(entry));
                    return;
                }
                try {
                    const content = String(entry.content || '{}');
                    const cacheKey = `${String(entry.key || '')}:${content.length}:${stableHash(content)}`;
                    let cached = unpackContainerCache.get(cacheKey);
                    if (cached) {
                        touchCacheEntry(unpackContainerCache, cacheKey, cached);
                    } else {
                        const parsed = JSON.parse(content);
                        const parsedEntries = Array.isArray(parsed.entries) ? parsed.entries.map(cloneEntry) : [];
                        cached = { entries: parsedEntries, bytes: approximateTextBytes(content) + parsedEntries.length * 96 };
                        unpackContainerCache.set(cacheKey, cached);
                        unpackContainerCacheBytes += Number(cached.bytes || 0);
                        trimLoreCache(unpackContainerCache, cacheBudget('lore-container-unpack', UNPACK_CACHE_BASE_BYTES), 'unpack');
                    }
                    cached.entries.forEach(item => out.push(cloneEntry(item)));
                } catch (error) {
                    recordRuntimeDebug('warn', `[LIBRA][Lore] Container unpack failed for ${entry?.comment || 'unknown'}:`, error?.message || error);
                }
            };
            lorebook.forEach(visit);
            return out;
        };
        // 공개 unpack: 로어에 남은 항목과 스토리지 섀도를 합쳐 돌려준다.
        // 섀도가 비어 있으면(미수화) 종전과 완전히 동일하다.
        // options.raw === true 이면 섀도를 주입하지 않고 **주어진 로어만** 해석한다.
        // 3-way 병합(mergeConcurrentLibraManagedLore)처럼 명시적 리비전을 다루는
        // 곳에서는 섀도가 섞이면 "사용자가 지운 항목"이 되살아난다.
        let managementRawReadDepth = 0;
        const withRawManagementRead = callback => {
            managementRawReadDepth += 1;
            try {
                const result = callback();
                if (result && typeof result.then === 'function') throw new Error('management_prepare_must_be_synchronous');
                return result;
            } finally { managementRawReadDepth -= 1; }
        };
        const unpack = (lorebook = [], options = {}) => {
            // Optional read outcome is local memo bookkeeping, not source authority.
            const outcome = options?.entityProjectionReadOutcome;
            if (outcome) outcome.ok = false;
            let readCompleted = true;
            const fromLore = unpackRawFromLore(lorebook);
            if (managementRawReadDepth > 0 || (options && options.raw === true)) {
                if (outcome) outcome.ok = true;
                return fromLore;
            }
            // 스코프 해석: 로어 배열에는 char/chat 신원이 없으므로 활성 스코프를 쓴다.
            // (로어에서 유추한 스코프는 `char:unknown|...` 이 되어 항상 빗나간다.)
            const scopeKey = (() => {
                try {
                    const fromActive = LibraDataStorage.getActiveScope?.() || '';
                    if (fromActive) return fromActive;
                    return LibraDataStorage.scopeKeyFor(null, { localLore: lorebook });
                } catch (_) { readCompleted = false; return ''; }
            })();
            let shadowEntries = [];
            try { shadowEntries = LibraDataStorage.isHydrated(scopeKey) ? LibraDataStorage.getShadowEntries(scopeKey, options?.shadowEntryComment) : []; } catch (_) { readCompleted = false; }
            if (outcome) outcome.ok = readCompleted;
            if (shadowEntries.length === 0) return fromLore;
            const seen = new Set(fromLore.map(entry => String(entry?.key || '')));
            return [...fromLore, ...shadowEntries.filter(entry => !seen.has(String(entry?.key || '')))];
        };
        const classify = (entry = null) => {
            const comment = String(entry?.comment || '').trim();
            if (ENTITY_RELATION_COMMENTS.has(comment)) return 'lmai_entity_relations';
            if (comment === 'lmai_memory') return 'lmai_memory';
            return null;
        };
        const packUnpacked = (entries = []) => {
            const unpacked = Array.isArray(entries) ? entries : [];
            if (!LIBRA_PACK_MANAGED_LORE_CONTAINERS) return unpacked.map(cloneEntry);
            ensureLoreCacheRegistered();
            const buckets = new Map(CATEGORIES.map(category => [category, []]));
            const others = [];
            for (const entry of unpacked) {
                const cloned = cloneEntry(entry);
                const category = classify(cloned);
                if (category) buckets.get(category).push(cloned);
                else others.push(cloned);
            }
            const packed = [];
            for (const category of CATEGORIES) {
                const bucketEntries = buckets.get(category) || [];
                if (bucketEntries.length === 0) continue;
                const shards = partitionLoreBucket(bucketEntries);
                for (let shardIndex = 0; shardIndex < shards.length; shardIndex += 1) {
                    const shardEntries = shards[shardIndex];
                    const digest = stableHash(shardEntries.map((entry, index) => entryPackFingerprint(entry, index)).join('|'));
                    const cacheKey = `${category}:${digest}:${shardEntries.length}`;
                    let cached = packContentCache.get(cacheKey);
                    if (cached) {
                        touchCacheEntry(packContentCache, cacheKey, cached);
                    } else {
                        const content = JSON.stringify({
                            version: '2.0',
                            category,
                            shardIndex,
                            shardCount: shards.length,
                            digest,
                            entries: shardEntries
                        });
                        cached = { content, bytes: approximateTextBytes(content) };
                        packContentCache.set(cacheKey, cached);
                        packContentCacheBytes += Number(cached.bytes || 0);
                        trimLoreCache(packContentCache, cacheBudget('lore-container-pack', PACK_CACHE_BASE_BYTES), 'pack');
                    }
                    packed.push({
                        key: `LIBRA_DATA_${category.toUpperCase()}_${String(shardIndex).padStart(4, '0')}_${digest}`,
                        comment: category,
                        memo: CONTAINER_MEMO,
                        content: cached.content,
                        mode: 'constant',
                        insertorder: 1,
                        alwaysActive: false
                    });
                }
            }
            return [...packed, ...others];
        };
        const pack = (entries = []) => packUnpacked(unpack(Array.isArray(entries) ? entries : []));
        return Object.freeze({ unpack, unpackRawFromLore, withRawManagementRead, pack, packUnpacked, cloneEntry, isContainer });
    })();
