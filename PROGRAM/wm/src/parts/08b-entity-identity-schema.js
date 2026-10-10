    // [MANAGER] Entity Manager
    // ══════════════════════════════════════════════════════════════
    const EntityManager = (() => {
        const entityCache = new Map();
        const relationCache = new Map();
        const ENTITY_COMMENT = "lmai_entity";
        const RELATION_COMMENT = "lmai_relation";
        const ENTITY_ABSORPTION_COMMENT = "lmai_entity_absorption";
        const ENTITY_ABSORPTION_SCHEMA = "libra_entity_absorption_v1";
        const RELATION_DELTA_SCALE = 0.5;
        let identityState = {
            userCanonical: 'User',
            userAliases: new Set(['user', '사용자', 'you', 'me', '나', '본인'])
        };

        // V5.2.2 stability patch: canonical-name lookup cache.
        // This keeps EntityManager.resolveCanonicalName from reparsing/scanning the
        // full entity collection on every call in long chats. The cache is invalidated
        // whenever entityCache mutates, while lorebook-backed fallback uses a compact
        // signature derived from entity entry count/hash.
        const ENTITY_RESOLVE_CACHE_LIMIT = 4096;
        let entityCacheRevision = 0;
        let entityLookupIndexCache = null;
        const entityResolveCache = new Map();
        const trimEntityResolveCache = () => {
            while (entityResolveCache.size > ResourceGovernor.getCacheEntryLimit('entity-resolve', ENTITY_RESOLVE_CACHE_LIMIT)) {
                const first = entityResolveCache.keys().next().value;
                if (!first) break;
                entityResolveCache.delete(first);
            }
        };
        const invalidateEntityResolveCaches = () => {
            entityCacheRevision++;
            entityLookupIndexCache = null;
            entityResolveCache.clear();
        };
        (() => {
            const baseSet = entityCache.set.bind(entityCache);
            const baseDelete = entityCache.delete.bind(entityCache);
            const baseClear = entityCache.clear.bind(entityCache);
            entityCache.set = (key, value) => { const result = baseSet(key, value); invalidateEntityResolveCaches(); return result; };
            entityCache.delete = (key) => { const result = baseDelete(key); if (result) invalidateEntityResolveCaches(); return result; };
            entityCache.clear = () => { const had = entityCache.size > 0; const result = baseClear(); if (had) invalidateEntityResolveCaches(); return result; };
        })();

        const stripNameTitles = (name) => {
            let normalized = String(name || '')
                .replace(/[“”"'`‘’]/g, '')
                .replace(/\[[^\]]*\]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const koTitles = ['선생님', '교수님', '박사님', '씨', '님'];
            const spacedKoTitles = ['양', '군'];
            const enTitles = ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.', 'Prof.', 'Sir', 'Lady', 'Lord'];
            for (const title of koTitles) {
                if (normalized.endsWith(title) && normalized.length > title.length + 1) {
                    normalized = normalized.slice(0, -title.length).trim();
                    break;
                }
            }
            for (const title of spacedKoTitles) {
                const pattern = new RegExp(`\\s+${title}$`, 'u');
                if (pattern.test(normalized)) {
                    normalized = normalized.replace(pattern, '').trim();
                    break;
                }
            }
            for (const title of enTitles) {
                const needsBoundary = !title.endsWith('.');
                const hasTitlePrefix = normalized.startsWith(title + ' ')
                    || (!needsBoundary && normalized.startsWith(title))
                    || normalized === title;
                if (hasTitlePrefix) {
                    normalized = normalized.slice(title.length).trim();
                    break;
                }
            }
            return normalized.trim();
        };

        const extractBilingualNameParts = (name) => {
            const raw = String(name || '').replace(/[“”"'`‘’]/g, '').trim();
            const match = raw.match(/^([^()[\]]+?)\s*\(([^()]+?)\)\s*$/);
            if (!match) return null;
            const primary = stripNameTitles(match[1]).trim();
            const secondary = stripNameTitles(match[2]).trim();
            if (!primary || !secondary) return null;
            return { primary, secondary };
        };

        const normalizeCanonicalDisplayName = (name) => {
            const bilingual = extractBilingualNameParts(name);
            if (bilingual) return `${bilingual.primary}(${bilingual.secondary})`;
            return stripNameTitles(String(name || '')).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
        };

        const splitNameVariants = (value) => String(value || '')
            .split(/\s*\/\s*|\s*\|\s*|\s*;\s*|\s*,\s*|\s*[·・]\s*/)
            .map(part => stripNameTitles(part).trim())
            .filter(Boolean);

        const extractNameVariantParts = (name) => {
            const variants = new Set();
            const canonical = normalizeCanonicalDisplayName(name);
            if (canonical) variants.add(canonical);
            const bilingual = extractBilingualNameParts(name);
            if (bilingual) {
                variants.add(bilingual.primary);
                variants.add(bilingual.secondary);
                splitNameVariants(bilingual.primary).forEach(part => variants.add(part));
                splitNameVariants(bilingual.secondary).forEach(part => variants.add(part));
            }
            splitNameVariants(String(name || '').replace(/[()]/g, ' ')).forEach(part => variants.add(part));
            return [...variants].filter(Boolean);
        };

        const normalizeBaseName = (name) => {
            if (!name) return '';
            const bilingual = extractBilingualNameParts(name);
            if (bilingual) {
                return bilingual.primary;
            }
            return normalizeCanonicalDisplayName(name);
        };

        const getKoreanShortName = (name) => {
            const base = normalizeBaseName(name);
            if (!/^[가-힣]{3,4}$/.test(base)) return '';
            return base.slice(-2);
        };

        const getKoreanFamilyName = (name) => {
            const base = normalizeBaseName(name);
            if (!/^[가-힣]{3,4}$/.test(base)) return '';
            return base.slice(0, 1);
        };

        const getEnglishOrJapaneseNameParts = (name) => {
            const base = normalizeBaseName(name);
            if (!base) return [];
            const spaceParts = base.split(/\s+/).filter(Boolean);
            if (spaceParts.length >= 2) {
                return spaceParts;
            }
            if (/[・·]/.test(base)) {
                return base.split(/[・·]/).map(v => v.trim()).filter(Boolean);
            }
            return [];
        };

        const getNameTokenSignatures = (name) => {
            const parts = getEnglishOrJapaneseNameParts(name)
                .map(part => normalizeBaseName(part).toLowerCase())
                .filter(Boolean);
            if (parts.length < 2) return [];
            const signatures = new Set();
            signatures.add(parts.join(' '));
            signatures.add(parts.join(''));
            signatures.add(`${parts[0]} ${parts[parts.length - 1]}`);
            signatures.add(`${parts[parts.length - 1]} ${parts[0]}`);
            signatures.add(`${parts[0]}${parts[parts.length - 1]}`);
            signatures.add(`${parts[parts.length - 1]}${parts[0]}`);
            return [...signatures].filter(Boolean);
        };
        const normalizeIdentityToken = (value) => String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[._'`’\-]/g, '')
            .replace(/[·・]/g, '')
            .replace(/\s+/g, '');
        const romanizeHangulText = (value) => {
            const text = String(value || '').trim();
            if (!text || !/[가-힣]/.test(text)) return '';
            const CHO = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
            const JUNG = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
            const JONG = ['', 'k', 'k', 'ks', 'n', 'nj', 'nh', 't', 'l', 'lk', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'p', 'ps', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 'h'];
            let out = '';
            for (const ch of text) {
                const code = ch.charCodeAt(0);
                if (code < 0xac00 || code > 0xd7a3) {
                    out += ch.toLowerCase();
                    continue;
                }
                const syllableIndex = code - 0xac00;
                const cho = Math.floor(syllableIndex / 588);
                const jung = Math.floor((syllableIndex % 588) / 28);
                const jong = syllableIndex % 28;
                out += `${CHO[cho]}${JUNG[jung]}${JONG[jong]}`;
            }
            return normalizeIdentityToken(out);
        };
        const normalizePhoneticIdentityToken = (value) => {
            const identity = normalizeIdentityToken(value);
            if (!identity) return '';
            const shouldSimplify = /[가-힣]/.test(String(value || '')) || identity.length >= 5 || /[-_.\s]/.test(String(value || ''));
            if (!shouldSimplify) return '';
            return identity.replace(/(.)\1+/g, '$1');
        };
        const isPhoneticallySimilar = (nameA, nameB) => {
            const a = normalizeIdentityToken(nameA);
            const b = normalizeIdentityToken(nameB);
            if (!a || !b) return false;
            if (a === b) return true;
            
            const ra = romanizeHangulText(nameA);
            const rb = romanizeHangulText(nameB);
            if (ra && rb && ra === rb) return true;
            if (ra && ra === b) return true;
            if (rb && rb === a) return true;
            return false;
        };

        const buildHiddenNameKeys = (name) => {
            const keys = new Set();
            const canonical = normalizeCanonicalDisplayName(name);
            const base = normalizeBaseName(name);
            const family = getKoreanFamilyName(name);
            const shortKo = getKoreanShortName(name);
            const addKey = (value) => {
                const normalized = String(value || '').trim().toLowerCase();
                if (!normalized) return;
                keys.add(normalized);
                keys.add(normalized.replace(/\s+/g, ''));
                const identityToken = normalizeIdentityToken(normalized);
                if (identityToken) keys.add(identityToken);
                const phoneticToken = normalizePhoneticIdentityToken(normalized);
                if (phoneticToken) keys.add(phoneticToken);
                const hangulRomanized = romanizeHangulText(normalized);
                if (hangulRomanized) {
                    keys.add(hangulRomanized);
                    const romanizedPhonetic = normalizePhoneticIdentityToken(hangulRomanized);
                    if (romanizedPhonetic) keys.add(romanizedPhonetic);
                }
            };
            addKey(canonical);
            addKey(base);
            extractNameVariantParts(name).forEach(addKey);
            getNameTokenSignatures(name).forEach(addKey);
            if (family && shortKo) {
                addKey(`${family}:${shortKo}`);
                addKey(`${family}${shortKo}`);
                addKey(shortKo); // 성 떼고 이름만으로도 매칭되도록 추가
            }
            return [...keys].filter(Boolean);
        };

        const buildAliasCandidates = (name, includeShortKorean = true) => {
            const base = normalizeBaseName(name);
            const canonical = normalizeCanonicalDisplayName(name);
            if (!base && !canonical) return [];
            const aliases = new Set();
            const pushAlias = (value) => {
                const normalized = String(value || '').trim();
                if (!normalized) return;
                const compact = normalized.replace(/\s+/g, '');
                aliases.add(normalized);
                aliases.add(compact);
                aliases.add(normalized.toLowerCase());
                aliases.add(compact.toLowerCase());
                const identityToken = normalizeIdentityToken(normalized);
                if (identityToken) aliases.add(identityToken);
                const phoneticToken = normalizePhoneticIdentityToken(normalized);
                if (phoneticToken) aliases.add(phoneticToken);
                const hangulRomanized = romanizeHangulText(normalized);
                if (hangulRomanized) {
                    aliases.add(hangulRomanized);
                    const romanizedPhonetic = normalizePhoneticIdentityToken(hangulRomanized);
                    if (romanizedPhonetic) aliases.add(romanizedPhonetic);
                }
            };
            pushAlias(base);
            pushAlias(canonical);
            extractNameVariantParts(name).forEach(pushAlias);
            if (includeShortKorean) {
                const shortKo = getKoreanShortName(base) || (/^[가-힣]{2}$/.test(base) ? base : '');
                if (shortKo) {
                    aliases.add(shortKo);
                    aliases.add(shortKo.toLowerCase());
                    const shortKoRomanized = romanizeHangulText(shortKo);
                    if (shortKoRomanized) {
                        aliases.add(shortKoRomanized);
                        const shortKoPhonetic = normalizePhoneticIdentityToken(shortKoRomanized);
                        if (shortKoPhonetic) aliases.add(shortKoPhonetic);
                    }
                }
            }
            return [...aliases].filter(Boolean);
        };

        const refreshIdentity = (char, db, chat = null) => {
            const aliases = new Set(['user', '사용자', 'you', 'me', '나', '본인']);
            const binding = SourceReflectionManager.resolvePersonaBinding(db, chat, char);
            const personaName = normalizeBaseName(binding?.name || '');
            const canonical = personaName || 'User';
            buildAliasCandidates(canonical, true).forEach(alias => aliases.add(alias));
            if (personaName) buildAliasCandidates(personaName, true).forEach(alias => aliases.add(alias));
            identityState = {
                userCanonical: canonical,
                userAliases: aliases
            };
            return identityState;
        };

        const isUserAlias = (name) => {
            const aliases = buildAliasCandidates(name, true);
            return aliases.some(alias => identityState.userAliases.has(alias));
        };
        const readActiveEntityBlocklist = () => {
            try {
                return normalizeEntityBlocklistCollection(
                    (typeof MemoryEngine !== 'undefined' && MemoryEngine?.CONFIG)
                        ? MemoryEngine.CONFIG.entityBlocklist
                        : []
                );
            } catch {
                return [];
            }
        };
        const BUILTIN_WEAK_ENTITY_BLOCKLIST = Object.freeze([
            '조용히', '그림', '그려', '볼륨', '챕터', '뜻밖', '재능', '가방',
            '응답', '사용자', '대화', '장면', '서술', '묘사', '문장', '단어',
            '부장', '부원', '회장', '선배', '후배', '동기',
            'volume', 'chapter', 'scene', 'response'
        ]);
        const GENERIC_ROLE_ALIAS_BLOCKLIST = Object.freeze([
            '바텐더', '바리스타', '점원', '직원', '웨이터', '웨이트리스', '서빙',
            '매니저', '관리자', '선생님', '교사', '담임', '코치', '경호원', '의사',
            '간호사', '기사', '기자', '아나운서', '학생', '연습생', '감독', '원장',
            '사감', '사장', '교장', '교감', '교생', '팀장', '부장', '부원', '회장',
            '선배', '후배', '동기', '아저씨',
            'bartender', 'barista', 'waiter', 'waitress', 'server', 'clerk',
            'staff', 'staff member', 'manager', 'teacher', 'coach', 'guard',
            'doctor', 'nurse', 'driver', 'reporter', 'announcer', 'student',
            'trainee', 'director', 'boss'
        ]);
        const addBlockedEntityKey = (bucket, value) => {
            const normalized = String(value || '').trim().toLowerCase();
            if (!normalized) return;
            bucket.add(normalized);
            bucket.add(normalized.replace(/\s+/g, ''));
        };
        const isBuiltinWeakEntityName = (value) => {
            const raw = String(value || '').replace(/[()[\]{}"'`]/g, '').trim();
            if (!raw) return false;
            const normalized = raw.toLowerCase().replace(/\s+/g, ' ').trim();
            if (BUILTIN_WEAK_ENTITY_BLOCKLIST.includes(raw) || BUILTIN_WEAK_ENTITY_BLOCKLIST.includes(normalized)) return true;
            if (/^(?:볼륨|챕터|권|장)\s*\d*$/u.test(raw)) return true;
            if (/^(?:volume|chapter)\s*\d*$/i.test(normalized)) return true;
            return false;
        };
        const isGenericRoleAliasName = (value) => {
            const raw = String(value || '').replace(/[()[\]{}"'`]/g, '').trim();
            if (!raw) return false;
            const normalized = raw.toLowerCase().replace(/\s+/g, ' ').trim();
            if (GENERIC_ROLE_ALIAS_BLOCKLIST.includes(raw) || GENERIC_ROLE_ALIAS_BLOCKLIST.includes(normalized)) return true;
            if (/^(?:바텐더|바리스타|점원|직원|웨이터|웨이트리스|서빙|매니저|관리자|선생님|교사|담임|코치|경호원|의사|간호사|기사|기자|아나운서|학생|연습생|감독|원장|사감|사장|교장|교감|교생|팀장|부장|부원|회장|선배|후배|동기|아저씨)(?:님|씨)?$/u.test(raw)) return true;
            if (/^(?:bartender|barista|waiter|waitress|server|clerk|staff(?:\s+member)?|manager|teacher|coach|guard|doctor|nurse|driver|reporter|announcer|student|trainee|director|boss)$/i.test(normalized)) return true;
            return false;
        };
        const shouldKeepOldNameAsAliasForRename = (oldName = '', options = {}) => {
            if (options.keepOldNameAsAlias === true || options.aliasOldName === true) return true;
            if (options.keepOldNameAsAlias === false || options.aliasOldName === false) return false;
            const raw = String(oldName || '').trim();
            if (!raw) return false;
            if (isBuiltinWeakEntityName(raw) || isGenericRoleAliasName(raw)) return false;
            return true;
        };
        // 내장 차단어 집합 — **정확 일치 전용**.
        //
        // 실측 결함: 종전에는 내장 차단어도 별칭(축약 이름)과 대조했다. 그래서
        // getKoreanShortName('학생회장') → '회장' 이 내장 차단어 '회장' 과 만나
        // **직함 포함 고유 이름이 통째로 차단**됐다(부회장·서클부장·김선배 동일).
        // 그 인물과 그 관계가 인물·관계 화면에서 조용히 사라졌다(예외·로그 없음).
        // 내장 목록은 '회장'처럼 그 자체로 의미 없는 이름을 거르는 것이 목적이므로,
        // 이름 전체가 그 목록과 같을 때만 차단한다.
        const getBuiltinBlockedNameSet = () => {
            const blocked = new Set();
            for (const rawName of BUILTIN_WEAK_ENTITY_BLOCKLIST) {
                addBlockedEntityKey(blocked, rawName);
            }
            return blocked;
        };
        // 사용자 차단 목록 집합 — 별칭·숨김 키까지 포함한다(사용자가 지목한 이름을
        // 별칭으로 부른 경우도 막아야 하므로 종전 동작을 유지한다).
        const getBlockedEntityNameSet = (lorebook = []) => {
            const blocked = new Set();
            for (const rawName of readActiveEntityBlocklist()) {
                const canonical = resolveCanonicalName(rawName, lorebook) || normalizeCanonicalDisplayName(rawName) || normalizeBaseName(rawName) || rawName;
                [
                    rawName,
                    canonical,
                    normalizeCanonicalDisplayName(canonical),
                    normalizeBaseName(canonical)
                ].forEach(value => addBlockedEntityKey(blocked, value));
                buildAliasCandidates(rawName, true).forEach(value => addBlockedEntityKey(blocked, value));
                buildAliasCandidates(canonical, true).forEach(value => addBlockedEntityKey(blocked, value));
                buildHiddenNameKeys(rawName).forEach(value => addBlockedEntityKey(blocked, value));
                buildHiddenNameKeys(canonical).forEach(value => addBlockedEntityKey(blocked, value));
            }
            return blocked;
        };
        const isBlockedEntityName = (name, lorebook = []) => {
            const raw = String(name || '').trim();
            if (!raw) return false;
            // ① 내장 차단어는 이름 전체가 같을 때만 차단한다.
            //    별칭(축약 이름)까지 대조하면 '학생회장'이 '회장' 때문에 사라진다.
            if (isBuiltinWeakEntityName(raw)) return true;
            const builtinBlocked = getBuiltinBlockedNameSet();
            const rawKeys = [raw, normalizeCanonicalDisplayName(raw), normalizeBaseName(raw)]
                .filter(Boolean)
                .map(value => String(value).trim().toLowerCase());
            if (rawKeys.some(key => builtinBlocked.has(key) || builtinBlocked.has(key.replace(/\s+/g, '')))) return true;

            // ② 사용자 차단 목록은 별칭·숨김 키까지 본다(종전 동작 유지).
            const blocked = getBlockedEntityNameSet(lorebook);
            if (blocked.size === 0) return false;
            const probe = new Set([
                raw,
                normalizeCanonicalDisplayName(raw),
                normalizeBaseName(raw),
                resolveCanonicalName(raw, lorebook) || ''
            ].filter(Boolean));
            buildAliasCandidates(raw, true).forEach(value => probe.add(value));
            buildHiddenNameKeys(raw).forEach(value => probe.add(value));
            for (const value of probe) {
                const normalized = String(value || '').trim().toLowerCase();
                if (!normalized) continue;
                if (blocked.has(normalized) || blocked.has(normalized.replace(/\s+/g, ''))) return true;
            }
            return false;
        };

        const extractEntityAliases = (entity) => {
            const aliases = new Set();
            buildAliasCandidates(entity?.name || '', true).forEach(alias => aliases.add(alias));
            getNameTokenSignatures(entity?.name || '').forEach(alias => aliases.add(alias));
            const metaAliases = Array.isArray(entity?.meta?.aliases) ? entity.meta.aliases : [];
            for (const alias of metaAliases) {
                buildAliasCandidates(alias, true).forEach(candidate => aliases.add(candidate));
            }
            const hiddenKeys = Array.isArray(entity?.meta?.hiddenNameKeys) ? entity.meta.hiddenNameKeys : [];
            for (const key of hiddenKeys) {
                const normalized = String(key || '').trim();
                if (normalized) aliases.add(normalized);
            }
            return [...aliases].filter(Boolean);
        };

        const normalizeEntityAbsorptionStatus = (status = '') => {
            const normalized = String(status || '').trim().toLowerCase();
            if (['pending', 'applied', 'cancelled'].includes(normalized)) return normalized;
            return '';
        };
        const getEntityAbsorptionMeta = (entity = null) => {
            const meta = entity?.meta?.absorption;
            return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
        };
        const isEntityAbsorptionPending = (entity = null) => normalizeEntityAbsorptionStatus(getEntityAbsorptionMeta(entity)?.status) === 'pending';
        const isEntityAbsorptionApplied = (entity = null) => normalizeEntityAbsorptionStatus(getEntityAbsorptionMeta(entity)?.status) === 'applied';
        const isActiveEntityRecord = (entity = null) => !!entity && !isEntityAbsorptionApplied(entity);
        const isPromptVisibleEntityRecord = (entity = null) => isActiveEntityRecord(entity) && !isEntityAbsorptionPending(entity);

        const collectKnownEntities = (lorebook) => {
            // If entityCache is populated (after rebuildCache), use it directly to avoid
            // redundant lorebook parsing and duplicate entries
            if (entityCache.size > 0) {
                return Array.from(entityCache.values()).filter(isActiveEntityRecord);
            }
            // Fallback: parse lorebook entries when cache is not yet built
            const known = [];
            for (const entry of LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [], { shadowEntryComment: ENTITY_COMMENT })) {
                if (entry.comment !== ENTITY_COMMENT) continue;
                try {
                    const parsed = JSON.parse(entry.content || '{}');
                    if (isActiveEntityRecord(parsed)) known.push(parsed);
                } catch (e) {
                    if (typeof MemoryEngine !== 'undefined' && MemoryEngine.CONFIG?.debug) {
                        recordRuntimeDebug('warn', '[LIBRA] collectKnownEntities parse error:', e?.message);
                    }
                }
            }
            return known;
        };

        const getKnownEntitySignature = (knownEntities = [], lorebook = []) => {
            if (entityCache.size > 0) return `cache:${entityCacheRevision}:${entityCache.size}`;
            const loreEntries = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [], { shadowEntryComment: ENTITY_COMMENT })
                .filter(entry => entry?.comment === ENTITY_COMMENT);
            const digest = stableHash(loreEntries.map(entry => `${entry.comment}:${entry.content || ''}`).join('|'));
            return `lore:${loreEntries.length}:${digest}`;
        };

        const addEntityIndexValue = (map, key, value) => {
            const normalized = String(key || '').trim();
            const display = normalizeCanonicalDisplayName(value || '');
            if (!normalized || !display) return;
            if (!map.has(normalized)) map.set(normalized, new Set());
            map.get(normalized).add(display);
        };

        const uniqueEntityIndexValue = (set) => {
            if (!set || set.size !== 1) return '';
            return [...set][0] || '';
        };

        const getEntityLookupIndex = (knownEntities = [], lorebook = []) => {
            const signature = getKnownEntitySignature(knownEntities, lorebook);
            if (entityLookupIndexCache?.signature === signature) return entityLookupIndexCache;
            const aliasToName = new Map();
            const identityTokenToName = new Map();
            const normalizedNameToName = new Map();
            const shortKoToNames = new Map();
            for (const entity of Array.isArray(knownEntities) ? knownEntities : []) {
                const display = normalizeCanonicalDisplayName(entity?.name || '');
                if (!display) continue;
                const baseDisplay = normalizeBaseName(display);
                addEntityIndexValue(normalizedNameToName, baseDisplay, display);
                for (const alias of extractEntityAliases(entity)) {
                    addEntityIndexValue(aliasToName, alias, display);
                    const identity = normalizeIdentityToken(alias);
                    if (identity) addEntityIndexValue(identityTokenToName, identity, display);
                    const shortKo = getKoreanShortName(alias);
                    if (shortKo) addEntityIndexValue(shortKoToNames, shortKo, display);
                }
                for (const signatureToken of getNameTokenSignatures(display)) {
                    for (const token of signatureToken.split(/\s+/).filter(Boolean)) {
                        addEntityIndexValue(aliasToName, token.toLowerCase(), display);
                        const identity = normalizeIdentityToken(token);
                        if (identity) addEntityIndexValue(identityTokenToName, identity, display);
                    }
                }
                const shortKo = getKoreanShortName(display);
                if (shortKo) addEntityIndexValue(shortKoToNames, shortKo, display);
            }
            entityLookupIndexCache = { signature, aliasToName, identityTokenToName, normalizedNameToName, shortKoToNames, size: knownEntities.length };
            return entityLookupIndexCache;
        };

        const resolveCanonicalName = (name, lorebook = []) => {
            const base = normalizeBaseName(name);
            if (!base) return '';
            if (isUserAlias(base)) return identityState.userCanonical || base;

            const knownEntities = collectKnownEntities(lorebook);
            const lookupIndex = getEntityLookupIndex(knownEntities, lorebook);
            const cacheKey = `${lookupIndex.signature}::${base}::${String(name || '').trim()}`;
            if (entityResolveCache.has(cacheKey)) return entityResolveCache.get(cacheKey);
            const finish = (value) => {
                const resolved = normalizeCanonicalDisplayName(value) || normalizeCanonicalDisplayName(name) || base;
                entityResolveCache.set(cacheKey, resolved);
                trimEntityResolveCache();
                return resolved;
            };

            const incomingAliases = new Set(buildAliasCandidates(base, true));
            buildHiddenNameKeys(name).forEach(key => incomingAliases.add(key));

            // 1. Indexed exact match in aliases / normalized names.
            for (const alias of incomingAliases) {
                const match = uniqueEntityIndexValue(lookupIndex.aliasToName.get(alias))
                    || uniqueEntityIndexValue(lookupIndex.normalizedNameToName.get(alias));
                if (match) return finish(match);
            }

            // 2. Fallback exact scan for ambiguous or uncached metadata shapes.
            const exactAliasMatch = knownEntities.find(entity => {
                const entityAliases = extractEntityAliases(entity);
                return entityAliases.some(alias => incomingAliases.has(alias));
            });
            if (exactAliasMatch?.name) return finish(exactAliasMatch.name);

            // 3. Phonetic/Fuzzy matching.
            const fuzzyMatch = knownEntities.find(entity => {
                const entityName = entity?.name || '';
                return isPhoneticallySimilar(base, entityName);
            });
            if (fuzzyMatch?.name) return finish(fuzzyMatch.name);

            const shortKo = getKoreanShortName(base) || (/^[가-힣]{2}$/.test(base) ? base : '');
            if (shortKo) {
                const indexedShortMatch = uniqueEntityIndexValue(lookupIndex.shortKoToNames.get(shortKo));
                if (indexedShortMatch && !getKoreanFamilyName(name)) return finish(indexedShortMatch);

                const incomingFamilyName = getKoreanFamilyName(name);
                const candidates = knownEntities
                    .map(entity => normalizeCanonicalDisplayName(entity?.name || ''))
                    .filter(Boolean)
                    .map(entityName => ({
                        displayName: entityName,
                        baseName: normalizeBaseName(entityName),
                        familyName: getKoreanFamilyName(entityName)
                    }))
                    .filter(entity => /^[가-힣]{3,4}$/.test(entity.baseName) && entity.baseName.endsWith(shortKo));

                const exactFamilyMatches = incomingFamilyName
                    ? candidates.filter(entity => entity.familyName === incomingFamilyName)
                    : [];
                const uniqueExactFamilyMatches = [...new Set(exactFamilyMatches.map(entity => entity.displayName))];
                if (uniqueExactFamilyMatches.length === 1) return finish(uniqueExactFamilyMatches[0]);

                if (!incomingFamilyName) {
                    const uniqueMatches = [...new Set(candidates.map(entity => entity.displayName))];
                    if (uniqueMatches.length === 1) return finish(uniqueMatches[0]);
                }
            }

            const jpEnBase = normalizeBaseName(base);
            const jpEnIsSingleToken = getEnglishOrJapaneseNameParts(jpEnBase).length === 0
                && !/\s/.test(jpEnBase)
                && /[A-Za-z\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/.test(jpEnBase);
            if (jpEnIsSingleToken) {
                const incomingIdentity = normalizeIdentityToken(jpEnBase);
                const indexedMatch = uniqueEntityIndexValue(lookupIndex.identityTokenToName.get(jpEnBase.toLowerCase()))
                    || (incomingIdentity ? uniqueEntityIndexValue(lookupIndex.identityTokenToName.get(incomingIdentity)) : '');
                if (indexedMatch) return finish(indexedMatch);

                const matches = knownEntities
                    .filter(entity => {
                        const signatures = getNameTokenSignatures(entity?.name || '');
                        if (signatures.length === 0) return false;
                        return signatures.some(signature => {
                            const tokens = signature.split(/\s+/).filter(Boolean).flatMap(token => {
                                const lowered = token.toLowerCase();
                                const identity = normalizeIdentityToken(token);
                                return identity && identity !== lowered ? [lowered, identity] : [lowered];
                            });
                            return tokens.length >= 2 && (tokens.includes(jpEnBase.toLowerCase()) || (incomingIdentity && tokens.includes(incomingIdentity)));
                        });
                    })
                    .map(entity => normalizeCanonicalDisplayName(entity?.name || ''))
                    .filter(Boolean);
                const uniqueMatches = [...new Set(matches)];
                if (uniqueMatches.length === 1) return finish(uniqueMatches[0]);
            }

            // 5. Cross-script matching: English multi-part name vs Korean entity.
            const englishParts = getEnglishOrJapaneseNameParts(base);
            if (englishParts.length >= 2 && !/[가-힣]/.test(base)) {
                const incomingIdentity = normalizeIdentityToken(base);
                const crossScriptMatches = knownEntities
                    .filter(entity => {
                        const entityBaseName = normalizeBaseName(entity?.name || '');
                        if (!/[가-힣]/.test(entityBaseName)) return false;
                        const romanized = romanizeHangulText(entityBaseName);
                        if (romanized && incomingIdentity && romanized === incomingIdentity) return true;
                        const koreanShort = getKoreanShortName(entityBaseName);
                        if (koreanShort) {
                            const romanizedShort = romanizeHangulText(koreanShort);
                            for (const part of englishParts) {
                                const partIdentity = normalizeIdentityToken(part);
                                if (partIdentity && romanizedShort && partIdentity === romanizedShort) return true;
                            }
                        }
                        return false;
                    })
                    .map(entity => normalizeCanonicalDisplayName(entity?.name || ''))
                    .filter(Boolean);
                const uniqueCrossScriptMatches = [...new Set(crossScriptMatches)];
                if (uniqueCrossScriptMatches.length === 1) return finish(uniqueCrossScriptMatches[0]);
            }

            return finish(name);
        };

        const normalizeName = (name, lorebook = []) => {
            return resolveCanonicalName(name, lorebook);
        };

        const makeRelationId = (nameA, nameB, lorebook = []) => {
            const sorted = [normalizeName(nameA, lorebook), normalizeName(nameB, lorebook)].sort();
            return `${sorted[0]}_${sorted[1]}`;
        };

        const addSourceMessageId = (meta, m_id) => {
            if (!meta || !m_id) return;
            const list = Array.isArray(meta.m_ids) ? meta.m_ids.filter(Boolean) : [];
            if (!list.includes(m_id)) list.push(m_id);
            meta.m_ids = dedupeTextArray(list.map(id => String(id || '').trim()).filter(Boolean)).slice(-16);
            meta.m_id = String(m_id || '').trim();
        };
        const isManualProtected = (meta, updates) => {
            if (!meta?.manualLocked) return false;
            const source = String(updates?.source || '').trim().toLowerCase();
            if (source === 'gui' || source === 'manual') return false;
            if (updates?.allowManualOverride === true) return false;
            return true;
        };

        const deepClone = safeClone;
        const STATUS_NOTE_SCENE_DUMP_PATTERN = /(?:^|\s)(?:#|##|\[응답\]|\[assistant\]|\[response\]|scene result|user turn:|current pressure:|pending response to:|chatindex\s*:|volume\s+\d+|chapter\s+\d+|볼륨\s*\d+|챕터\s*\d+|\d+\s*권|\d+\s*장\b|⏱️?\s*\[\d{4}-\d{2}-\d{2})/i;
        const STATUS_NOTE_SIGNAL_PATTERN = /(tense|anxious|angry|afraid|guilty|relieved|hurt|injured|sick|exhausted|awkward|conflicted|jealous|긴장|불안|죄책감|질투|상처|회피)/i;
        const normalizeEntityStatusNoteText = (value) => String(value || '')
            .replace(/\r/g, ' ')
            .replace(/[#*_`>~]/g, ' ')
            .replace(/\[(?:user|assistant|response|conversation|응답|사용자)\]/ig, ' ')
            .replace(/◇/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const sanitizeEntityStatusField = (value, max = 64) => {
            const text = normalizeEntityStatusNoteText(value);
            if (!text) return '';
            if (STATUS_NOTE_SCENE_DUMP_PATTERN.test(text)) return '';
            if (text.length > max) return '';
            return text;
        };
        const buildEntityStatusNoteCandidates = (value) => {
            const cleaned = normalizeEntityStatusNoteText(value);
            if (!cleaned) return [];
            const separated = cleaned
                .replace(/\s*\|\s*/g, ' || ')
                .replace(/([.!?。！？])\s+/g, '$1 || ')
                .replace(/\s+-\s+/g, ' || ');
            return dedupeTextArray(
                separated
                    .split('||')
                    .map(part => part.replace(/^(?:user|assistant|response|conversation|응답|사용자)\s*:?/i, '').trim())
                    .filter(Boolean)
            );
        };
        const scoreEntityStatusNoteCandidate = (candidate = '', entityName = '', status = {}) => {
            const text = String(candidate || '').trim();
            if (!text) return -Infinity;
            let score = 0;
            const lowered = text.toLowerCase();
            const displayName = String(entityName || '').trim().toLowerCase();
            const baseName = String(normalizeBaseName(entityName || '') || '').trim().toLowerCase();
            if (displayName && lowered.includes(displayName)) score += 3;
            if (baseName && lowered.includes(baseName)) score += 2;
            if (STATUS_NOTE_SIGNAL_PATTERN.test(text)) score += 2;
            for (const key of ['currentMood', 'currentLocation', 'healthStatus']) {
                const signal = String(status?.[key] || '').trim().toLowerCase();
                if (signal && lowered.includes(signal)) score += 1;
            }
            if (STATUS_NOTE_SCENE_DUMP_PATTERN.test(text)) score -= 4;
            if (text.length > 140) score -= 2;
            if ((text.match(/[,;:]/g) || []).length >= 4) score -= 1;
            return score;
        };
        const compactEntityStatusNote = (value, max = 280, options = {}) => {
            const status = (options && typeof options === 'object' && options.status && typeof options.status === 'object')
                ? options.status
                : {};
            const entityName = String(options?.entityName || '').trim();
            const cleaned = normalizeEntityStatusNoteText(value);
            if (!cleaned) return '';
            const candidates = buildEntityStatusNoteCandidates(cleaned).filter(candidate => candidate.length >= 6);
            const ranked = candidates
                .map(candidate => ({ candidate, score: scoreEntityStatusNoteCandidate(candidate, entityName, status) }))
                .sort((a, b) => (b.score - a.score) || (a.candidate.length - b.candidate.length));
            const looksLikeSceneDump = STATUS_NOTE_SCENE_DUMP_PATTERN.test(cleaned) || cleaned.length > Math.max(220, max * 1.5);
            const best = ranked[0] || null;
            let chosen = best?.candidate || cleaned;
            if (looksLikeSceneDump && (!best || best.score < 2)) chosen = '';
            if (!chosen) return '';
            if (chosen.length <= max) return chosen;
            return `${chosen.slice(0, Math.max(48, max - 1)).trim()}…`;
        };
        const mergeLimitedStatusNotes = (current = '', incoming = '', max = 320, options = {}) => {
            const merged = dedupeTextArray(
                [current, incoming]
                    .map(value => compactEntityStatusNote(value, max, options))
                    .filter(Boolean)
            ).join(' | ');
            return compactEntityStatusNote(merged, max, options);
        };

        const hasRelationScore = (value) => Number.isFinite(Number(value));

        const normalizeNullableRelationScore = (value) => {
            if (value === null || value === undefined || value === '') return null;
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) return null;
            return Math.max(0, Math.min(1, numeric));
        };

        const normalizeFiniteNumber = (value, fallback = 0) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        };

        const isFunctionLikeEntityText = (value = '') => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            if (!text) return false;
            const head = text.slice(0, 160);
            return /^(?:async\s+)?function/.test(head)
                || /^\(?\s*[\w$\s,]*\)?\s*=>/.test(head)
                || /\[native code\]/.test(head)
                || /function\s*[\w$]*\s*\([^)]*\)\s*\{/.test(head);
        };

        const clampEntityText = (value, max = 220) => {
            if (value == null || typeof value === 'function' || typeof value === 'symbol') return '';
            if (Array.isArray(value)) {
                const joined = value.map(item => clampEntityText(item, max)).filter(Boolean).join('; ');
                return joined.length > max ? `${joined.slice(0, Math.max(24, max - 1)).trim()}…` : joined;
            }
            if (typeof value === 'object') {
                const preferred = value.summary || value.label || value.text || value.value || value.note || value.description || '';
                if (preferred) return clampEntityText(preferred, max);
                return '';
            }
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            if (!text || isFunctionLikeEntityText(text)) return '';
            return text.length > max ? `${text.slice(0, Math.max(24, max - 1)).trim()}…` : text;
        };

        const expandEntityListItem = (item, depth = 0) => {
            if (depth > 2 || item == null || item === '') return [];
            if (typeof item === 'function' || typeof item === 'symbol') return [];
            if (Array.isArray(item)) return item.flatMap(child => expandEntityListItem(child, depth + 1));
            if (typeof item === 'string') {
                const text = item.replace(/\s+/g, ' ').trim();
                if (!text || isFunctionLikeEntityText(text)) return [];
                const first = text[0];
                const last = text[text.length - 1];
                if ((first === '[' && last === ']') || (first === '{' && last === '}')) {
                    try {
                        const parsed = JSON.parse(text);
                        if (Array.isArray(parsed)) return parsed.flatMap(child => expandEntityListItem(child, depth + 1));
                        if (parsed && typeof parsed === 'object') {
                            const preferred = parsed.summary || parsed.label || parsed.text || parsed.value || parsed.note || parsed.description || '';
                            if (preferred) return expandEntityListItem(preferred, depth + 1);
                        }
                    } catch {}
                }
                return [text];
            }
            return [item];
        };

        const normalizeEntity01 = (value, fallback = 0) => {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, Number(fallback || 0)));
            return Math.max(0, Math.min(1, numeric));
        };

        const normalizeEntityList = (items, limit = 12, itemMax = 180) => {
            const source = Array.isArray(items) ? items : (items == null || items === '' ? [] : [items]);
            return dedupeTextArray(
                source
                    .flatMap(item => expandEntityListItem(item))
                    .map(item => clampEntityText(item, itemMax))
                    .filter(Boolean)
            ).slice(-Math.max(1, limit));
        };


        const splitEntityTraitFragments = (value = '', itemMax = 180) => {
            const text = clampEntityText(value, itemMax);
            if (!text) return [];
            const parts = text
                .replace(/[.!?。！？]+/g, '|')
                .split(/\s*[,，、;；|]\s*/u)
                .map(part => clampEntityText(part, itemMax))
                .filter(part => part.length >= 2);
            return parts.length > 1 ? parts : [text];
        };

        const ENTITY_APPEARANCE_FRAGMENT_RE = /(hair|eye|skin|face|body|height|weight|clothing|outfit|wearing|glasses|breast|chest|scar|tattoo|머리|머리카락|눈동자|눈매|눈빛|눈이|안경|피부|체형|키|신장|몸무게|복장|옷|착용|블라우스|셔츠|스커트|스타킹|가디건|가터|맨발|유방|가슴|쇄골|어깨|허리|체구|미모|외모|얼굴|표정|귀끝|손자국|상처|흉터|멍|충혈|cm|kg|[A-Z]컵)/i;
        const ENTITY_CLOTHING_FRAGMENT_RE = /(clothing|outfit|wearing|복장|옷|착용|입고|걸친|블라우스|셔츠|스커트|스타킹|가디건|가터|맨발)/i;
        const ENTITY_MARK_FRAGMENT_RE = /(scar|tattoo|distinctive|상처|흉터|문신|점|멍|손자국|자국|충혈|붉은)/i;
        const ENTITY_STABLE_TRAIT_RE = /(personality|trait|attitude|value|temperament|성격|성향|태도|가치관|경향|패턴|기질|습관|면모|기본|유지|책임감|체념|단호|차분|친절|무심|장난|뻔뻔|거침|교활|회의감|희망|결의|집착|사려|인내|도덕적|현실적|관찰자적)/i;
        const ENTITY_TRANSIENT_TRAIT_RE = /(이번\s*턴|이번\s*장면|현재|방금|처음으로|3년\s*만에|오르가즘|성관계|키스|고백|질문|대답|인터뷰|제보|커튼|서류|치킨|담배|전자레인지|배를\s*만지|눈물|웃음|발언|결정|식사|소파|식탁|거실)/i;
        const ENTITY_TRAIT_STOPWORDS = new Set([
            '이번', '턴', '현재', '장면', '처음', '으로', '에서', '에게', '하고', '하며', '한다',
            '있는', '있음', '유지', '모습', '상태', 'after', 'current', 'turn', 'scene'
        ]);

        const collectEntityTraitFragments = (items, itemMax = 180) => {
            const source = Array.isArray(items) ? items : (items == null || items === '' ? [] : [items]);
            return source
                .flatMap(item => expandEntityListItem(item))
                .flatMap(item => splitEntityTraitFragments(item, itemMax))
                .map(item => clampEntityText(item, itemMax))
                .filter(Boolean);
        };

        const getEntityTraitCompareText = (value = '') => String(value || '')
            .toLowerCase()
            .replace(/[“”"'‘’`「」『』()[\]{}]/g, ' ')
            .replace(/이번\s*턴(?:에서|의)?|이번\s*장면(?:에서|의)?|현재|방금|처음으로|3년\s*만에/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const getEntityTraitShingles = (value = '') => {
            const compact = getEntityTraitCompareText(value).replace(/[^a-z0-9가-힣]+/gi, '');
            if (compact.length <= 3) return new Set(compact ? [compact] : []);
            const out = new Set();
            for (let i = 0; i <= compact.length - 3; i += 1) out.add(compact.slice(i, i + 3));
            return out;
        };

        const getEntityTraitTokens = (value = '') => String(value || '')
            .toLowerCase()
            .match(/[a-z0-9가-힣]{2,}/gi)
            ?.map(token => token
                .replace(/(으로|에게|에서|부터|까지|처럼|보다|이고|이며|적인|적으로|함|함을|함이|하다|하고|하는|했다|한다)$/g, '')
                .trim())
            .filter(token => token && token.length >= 2 && !ENTITY_TRAIT_STOPWORDS.has(token)) || [];

        const areEntityTraitFragmentsRedundant = (left = '', right = '') => {
            const a = getEntityTraitCompareText(left);
            const b = getEntityTraitCompareText(right);
            if (!a || !b) return false;
            if (a === b) return true;
            const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
            if (shorter.length >= 8 && longer.includes(shorter)) return true;

            const aTokens = new Set(getEntityTraitTokens(a));
            const bTokens = new Set(getEntityTraitTokens(b));
            if (aTokens.size >= 2 && bTokens.size >= 2) {
                let shared = 0;
                for (const token of aTokens) if (bTokens.has(token)) shared += 1;
                if (shared / Math.min(aTokens.size, bTokens.size) >= 0.8) return true;
            }

            const aShingles = getEntityTraitShingles(a);
            const bShingles = getEntityTraitShingles(b);
            if (aShingles.size >= 4 && bShingles.size >= 4) {
                let shared = 0;
                for (const gram of aShingles) if (bShingles.has(gram)) shared += 1;
                if (shared / Math.min(aShingles.size, bShingles.size) >= 0.72) return true;
            }
            return false;
        };

        const shouldPreferEntityTraitFragment = (candidate = '', existing = '') => {
            const candidateTransient = ENTITY_TRANSIENT_TRAIT_RE.test(candidate);
            const existingTransient = ENTITY_TRANSIENT_TRAIT_RE.test(existing);
            if (existingTransient && !candidateTransient) return true;
            if (candidateTransient && !existingTransient) return false;
            return String(candidate || '').length < String(existing || '').length;
        };

        const normalizeEntityTraitCandidates = (items, limit = 18, itemMax = 180) => {
            const candidates = dedupeTextArray(
                (Array.isArray(items) ? items : [])
                    .map(item => clampEntityText(item, itemMax))
                    .filter(Boolean)
            );
            const out = [];
            for (const candidate of candidates) {
                const existingIdx = out.findIndex(item => areEntityTraitFragmentsRedundant(item, candidate));
                if (existingIdx >= 0) {
                    if (shouldPreferEntityTraitFragment(candidate, out[existingIdx])) out[existingIdx] = candidate;
                    continue;
                }
                out.push(candidate);
            }
            return out.slice(-Math.max(1, limit));
        };

        const classifyEntityVisualTraitBucket = (value = '') => {
            const text = String(value || '').trim();
            if (!text || !ENTITY_APPEARANCE_FRAGMENT_RE.test(text)) return '';
            if (ENTITY_STABLE_TRAIT_RE.test(text) && !/(표정|눈매|눈동자|피부|체형|키|신장|몸무게|복장|옷|셔츠|가슴|체구|미모|얼굴|귀끝|손자국|충혈|상처|흉터|멍|cm|kg|[A-Z]컵)/i.test(text)) return '';
            if (ENTITY_CLOTHING_FRAGMENT_RE.test(text)) return 'clothing';
            if (ENTITY_MARK_FRAGMENT_RE.test(text)) return 'distinctiveMarks';
            return 'features';
        };

        const shouldDropEntityTraitFragment = (value = '') => {
            const text = String(value || '').trim();
            if (!text) return true;
            if (classifyEntityVisualTraitBucket(text)) return true;
            return false;
        };

        const isEntityTurnStateTraitFragment = (value = '') => {
            const text = String(value || '').trim();
            if (!text || classifyEntityVisualTraitBucket(text)) return false;
            return ENTITY_TRANSIENT_TRAIT_RE.test(text) && !ENTITY_STABLE_TRAIT_RE.test(text);
        };

        const partitionEntityTraitFragments = (items, limit = 18, itemMax = 180) => {
            const routed = { traits: [], features: [], distinctiveMarks: [], clothing: [], stateFragments: [] };
            for (const fragment of collectEntityTraitFragments(items, itemMax)) {
                const bucket = classifyEntityVisualTraitBucket(fragment);
                if (bucket) {
                    routed[bucket].push(fragment);
                    continue;
                }
                if (isEntityTurnStateTraitFragment(fragment)) {
                    routed.stateFragments.push(fragment);
                    continue;
                }
                if (shouldDropEntityTraitFragment(fragment)) continue;
                routed.traits.push(fragment);
            }
            routed.traits = normalizeEntityTraitCandidates(routed.traits, limit, itemMax);
            routed.features = normalizeEntityList(routed.features, 12, 160);
            routed.distinctiveMarks = normalizeEntityList(routed.distinctiveMarks, 8, 160);
            routed.clothing = normalizeEntityList(routed.clothing, 8, 160);
            routed.stateFragments = normalizeEntityList(routed.stateFragments, 12, 220);
            return routed;
        };

        const normalizeEntityTraitList = (items, limit = 18, itemMax = 180) => {
            return partitionEntityTraitFragments(items, limit, itemMax).traits;
        };

        const rebalanceEntityVisualPersonalityFields = (entity) => {
            if (!entity || typeof entity !== 'object') return entity;
            entity.appearance = entity.appearance && typeof entity.appearance === 'object' ? entity.appearance : {};
            entity.personality = entity.personality && typeof entity.personality === 'object' ? entity.personality : {};
            entity.profile = entity.profile && typeof entity.profile === 'object' ? entity.profile : {};
            entity.profile.appearance = entity.profile.appearance && typeof entity.profile.appearance === 'object' ? entity.profile.appearance : {};
            entity.profile.personality = entity.profile.personality && typeof entity.profile.personality === 'object' ? entity.profile.personality : {};

            const legacyRoute = partitionEntityTraitFragments(entity.personality.traits || [], 18, 180);
            const profileRoute = partitionEntityTraitFragments(entity.profile.personality.traits || [], 18, 180);

            entity.appearance.features = normalizeEntityList([
                ...(Array.isArray(entity.appearance.features) ? entity.appearance.features : []),
                ...legacyRoute.features
            ], 18, 160);
            entity.appearance.distinctiveMarks = normalizeEntityList([
                ...(Array.isArray(entity.appearance.distinctiveMarks) ? entity.appearance.distinctiveMarks : []),
                ...legacyRoute.distinctiveMarks
            ], 12, 160);
            entity.appearance.clothing = normalizeEntityList([
                ...(Array.isArray(entity.appearance.clothing) ? entity.appearance.clothing : []),
                ...legacyRoute.clothing
            ], 12, 160);
            entity.personality.traits = legacyRoute.traits;

            entity.profile.appearance.features = normalizeEntityList([
                ...(Array.isArray(entity.profile.appearance.features) ? entity.profile.appearance.features : []),
                ...profileRoute.features,
                ...legacyRoute.features
            ], 18, 160);
            entity.profile.appearance.distinctiveMarks = normalizeEntityList([
                ...(Array.isArray(entity.profile.appearance.distinctiveMarks) ? entity.profile.appearance.distinctiveMarks : []),
                ...profileRoute.distinctiveMarks,
                ...legacyRoute.distinctiveMarks
            ], 12, 160);
            entity.profile.appearance.clothing = normalizeEntityList([
                ...(Array.isArray(entity.profile.appearance.clothing) ? entity.profile.appearance.clothing : []),
                ...profileRoute.clothing,
                ...legacyRoute.clothing
            ], 12, 160);
            entity.profile.personality.traits = normalizeEntityTraitCandidates([
                ...legacyRoute.traits,
                ...profileRoute.traits
            ], 18, 180);
            const stateFragments = normalizeEntityList([
                ...legacyRoute.stateFragments,
                ...profileRoute.stateFragments
            ], 12, 220);
            if (stateFragments.length > 0) {
                const turn = normalizeFiniteNumber(
                    entity.currentState?.lastObservedTurn
                    ?? entity.status?.lastUpdated
                    ?? entity.quality?.lastUpdatedTurn
                    ?? MemoryState?.currentTurn,
                    0
                );
                entity.stateTimeline = normalizeEntityStateTimeline([
                    ...(Array.isArray(entity.stateTimeline) ? entity.stateTimeline : []),
                    ...stateFragments.map(fragment => ({
                        turn,
                        summary: fragment,
                        sourceKind: 'personality_trait_reroute',
                        stability: 'turn_state'
                    }))
                ], 24);
                entity.currentState = entity.currentState && typeof entity.currentState === 'object' ? entity.currentState : {};
                if (!entity.currentState.summary && stateFragments[0]) entity.currentState.summary = stateFragments[0];
                entity.currentState.lastObservedTurn = Math.max(
                    normalizeFiniteNumber(entity.currentState.lastObservedTurn, 0),
                    turn
                );
            }
            return entity;
        };

        const isActiveRelationLedgerItem = (item = {}) => normalizeRelationEventStatus(item?.status || item?.provenanceStatus || 'active') === 'active';
        const getRelationEvidenceCount = (relation = {}) => {
            const details = relation?.details && typeof relation.details === 'object' ? relation.details : {};
            return [
                ...(Array.isArray(details.events) ? details.events.filter(isActiveRelationLedgerItem) : []),
                ...(Array.isArray(relation?.eventLedger) ? relation.eventLedger.filter(isActiveRelationLedgerItem) : []),
                ...(Array.isArray(relation?.evidence) ? relation.evidence.filter(isActiveRelationLedgerItem) : [])
            ].filter(Boolean).length;
        };

        const buildRelationshipAssessment = (relation = {}) => {
            const source = relation && typeof relation === 'object' ? relation : {};
            const existing = source.relationshipAssessment && typeof source.relationshipAssessment === 'object'
                ? source.relationshipAssessment
                : {};
            const evidenceCount = getRelationEvidenceCount(source);
            const closeness = normalizeNullableRelationScore(source?.details?.closeness ?? source?.metrics?.closeness);
            const trust = normalizeNullableRelationScore(source?.details?.trust ?? source?.metrics?.trust);
            const hasScores = closeness != null || trust != null;
            const hasExplicitStatus = !!String(source?.currentStatus?.summary || source?.relationType || '').trim()
                && !/^(?:관계|아는 사이|첫 대면|unknown|relationship)$/i.test(String(source?.relationType || '').trim());
            const inferred = existing.inferred === false ? false : !hasScores;
            let stage = 'observing';
            if (!hasScores && evidenceCount <= 1 && !hasExplicitStatus) stage = 'first_contact';
            else if (evidenceCount >= 3 || hasExplicitStatus || hasScores) stage = 'defined';
            const genericLabels = new Set(['', '첫 대면 · 정의 보류', '관계 정의됨', '관계 정의 중', '관찰 중']);
            const existingLabel = String(existing.label || '').trim();
            const label = genericLabels.has(existingLabel)
                ? (stage === 'first_contact' ? '첫 대면 · 정의 보류' : (stage === 'defined' ? (hasScores ? '관계 정의됨' : '관계 정의 중') : '관찰 중'))
                : existingLabel;
            const existingNote = String(existing.note || '').trim();
            const note = stage === 'first_contact'
                ? (existingNote || '관계를 정의하기에는 근거가 부족함')
                : (existingNote === '관계를 정의하기에는 근거가 부족함' ? '' : existingNote);
            const definitionConfidence = stage === 'first_contact'
                ? (evidenceCount > 0 ? 0.18 : 0.08)
                : (stage === 'observing'
                    ? Math.min(0.58, 0.24 + evidenceCount * 0.12)
                    : Math.min(1, 0.25 + evidenceCount * 0.15 + (hasScores ? 0.2 : 0) + (hasExplicitStatus ? 0.1 : 0)));

            return {
                stage,
                definitionConfidence,
                evidenceCount,
                label,
                note,
                inferred
            };
        };
        const ENTITY_ROLLBACK_REPAIR_SOURCE_IDS = new Set([
            'rollback-delete-augment',
            'rollback-delete-augment-existing-data-verify',
            'rollback-repair'
        ]);
        const isRollbackRepairEntitySource = (value = '') => {
            const text = String(value || '').trim().toLowerCase();
            return text && ENTITY_ROLLBACK_REPAIR_SOURCE_IDS.has(text);
        };
        const normalizeEntitySourceMix = (items, limit = 12, itemMax = 180) =>
            normalizeEntityList(items, limit, itemMax).filter(item => !isRollbackRepairEntitySource(item));

        const normalizeEntityMoodAtoms = (items = [], limit = 8, itemMax = 48) => {
            const source = Array.isArray(items) ? items : (items == null || items === '' ? [] : [items]);
            const atoms = [];
            for (const item of source) {
                const text = String(item || '')
                    .replace(/…+$/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (!text) continue;
                text
                    .split(/\s*[,，、;|/]\s*/u)
                    .map(part => clampEntityText(part, itemMax))
                    .filter(part => part && part !== '…')
                    .forEach(part => atoms.push(part));
            }
            const unique = dedupeTextArray(atoms)
                .filter(part => String(part || '').trim().length >= 2);
            const pruned = unique.filter((part, index) => !unique.some((other, otherIndex) =>
                otherIndex !== index
                && part.length >= 5
                && other.length >= part.length + 4
                && other.includes(part)
            ));
            return pruned.slice(-Math.max(1, Number(limit || 8) || 8));
        };
        const normalizeEntityMoodText = (value = '', limit = 8) =>
            normalizeEntityMoodAtoms(value, limit, 48).join(', ');

        const asEntityArray = (items) => Array.isArray(items) ? items : (items == null || items === '' ? [] : [items]);
        const collectEntityItems = (...values) => values.flatMap(value => asEntityArray(value));

        // Visual profile: stable appearance is stored as natural-language canon only.
        // Tokenized prompt tags are intentionally outside the canon core.

        const normalizeVisualTextBlock = (value = {}, fallback = {}) => {
            const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const fallbackSource = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
            return {
                summary: clampEntityText(source.summary || source.description || fallbackSource.summary || '', 320),
                hair: clampEntityText(source.hair || source.hairStyle || source.hair_style || fallbackSource.hair || '', 180),
                eyes: clampEntityText(source.eyes || source.eyeColor || source.eye_color || fallbackSource.eyes || '', 140),
                body: clampEntityText(source.body || source.bodyType || source.body_type || fallbackSource.body || '', 160),
                skin: clampEntityText(source.skin || source.skinTone || source.skin_tone || fallbackSource.skin || '', 120),
                ageLook: clampEntityText(source.ageLook || source.age_look || source.apparentAge || source.apparent_age || fallbackSource.ageLook || '', 120),
                speciesTraits: clampEntityText(source.speciesTraits || source.species_traits || fallbackSource.speciesTraits || '', 180),
                signatureItems: clampEntityText(source.signatureItems || source.signature_items || fallbackSource.signatureItems || '', 180),
                defaultOutfit: clampEntityText(source.defaultOutfit || source.default_outfit || source.outfit || fallbackSource.defaultOutfit || '', 220)
            };
        };
        const defaultEntityVisualCanon = (entity = {}) => ({
            version: 1,
            appearanceText: normalizeVisualTextBlock({}, {
                summary: normalizeEntityList([
                    ...(Array.isArray(entity?.appearance?.features) ? entity.appearance.features : []),
                    ...(Array.isArray(entity?.appearance?.distinctiveMarks) ? entity.appearance.distinctiveMarks : [])
                ], 10, 120).join(', '),
                defaultOutfit: normalizeEntityList([
                    ...(Array.isArray(entity?.appearance?.clothing) ? entity.appearance.clothing : [])
                ], 8, 120).join(', ')
            }),
            promptPolicy: { mustKeep: [], avoidChanging: [], allowSceneOverride: [], requireEvidenceForChange: true },
            evidence: [],
            customOverride: { enabled: false, source: '', instruction: '', appliedAt: 0 },
            updatedAt: 0
        });
        const normalizeVisualEvidence = (items = [], limit = 12) => {
            const source = Array.isArray(items) ? items : (items ? [items] : []);
            const out = [];
            const seen = new Set();
            for (const item of source) {
                let entry = null;
                if (typeof item === 'string') {
                    const text = clampEntityText(item, 220);
                    entry = text ? { source: 'text', text, turn: 0, confidence: 'medium' } : null;
                } else if (item && typeof item === 'object') {
                    const text = clampEntityText(item.text || item.snippet || item.evidence || item.summary || '', 260);
                    const sourceKind = clampEntityText(item.source || item.sourceKind || item.kind || '', 80);
                    if (text || sourceKind) {
                        entry = {
                            source: sourceKind || 'visual_profile',
                            text,
                            turn: normalizeFiniteNumber(item.turn ?? item.sourceTurn ?? item.turnNumber, 0),
                            confidence: clampEntityText(item.confidence || 'medium', 24) || 'medium'
                        };
                    }
                }
                if (!entry) continue;
                const key = `${entry.source}|${entry.turn}|${entry.text}|${entry.confidence}`.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(entry);
            }
            return out.slice(-Math.max(1, Number(limit || 12) || 12));
        };
        const normalizeEntityVisualCanon = (visualCanon = null, entity = {}) => {
            const source = visualCanon && typeof visualCanon === 'object' && !Array.isArray(visualCanon)
                ? visualCanon
                : (entity?.visual_canon && typeof entity.visual_canon === 'object' ? entity.visual_canon : {});
            const fallback = defaultEntityVisualCanon(entity);
            const policySource = source.promptPolicy || source.prompt_policy || {};
            const customSource = source.customOverride || source.custom_override || {};
            return {
                version: 1,
                appearanceText: normalizeVisualTextBlock(source.appearanceText || source.appearance_text || source.appearance || {}, fallback.appearanceText),
                promptPolicy: {
                    mustKeep: normalizeEntityList(policySource.mustKeep || policySource.must_keep || [], 18, 160),
                    avoidChanging: normalizeEntityList(policySource.avoidChanging || policySource.avoid_changing || policySource.avoid || [], 18, 160),
                    allowSceneOverride: normalizeEntityList(policySource.allowSceneOverride || policySource.allow_scene_override || [], 18, 160),
                    requireEvidenceForChange: policySource.requireEvidenceForChange === false || policySource.require_evidence_for_change === false ? false : true
                },
                evidence: normalizeVisualEvidence(source.evidence || source.sources || [], 16),
                customOverride: {
                    enabled: customSource.enabled === true || source.userForced === true || source.user_forced === true,
                    source: clampEntityText(customSource.source || source.customSource || source.custom_source || '', 80),
                    instruction: clampEntityText(customSource.instruction || customSource.text || source.customInstruction || source.custom_instruction || '', 360),
                    appliedAt: normalizeFiniteNumber(customSource.appliedAt ?? customSource.applied_at ?? source.appliedAt, 0)
                },
                updatedAt: normalizeFiniteNumber(source.updatedAt ?? source.updated_at, 0)
            };
        };
        const normalizeCurrentVisualState = (visualState = null) => {
            const source = visualState && typeof visualState === 'object' && !Array.isArray(visualState) ? visualState : {};
            return {
                notes: clampEntityText(source.notes || source.summary || '', 220),
                outfit: clampEntityText(source.outfit || source.currentOutfit || source.current_outfit || '', 180),
                pose: clampEntityText(source.pose || source.currentPose || source.current_pose || '', 160),
                expression: clampEntityText(source.expression || source.currentExpression || source.current_expression || '', 160),
                scene: clampEntityText(source.scene || source.sceneVisual || source.scene_visual || '', 220),
                source: clampEntityText(source.source || '', 80),
                lastUpdatedTurn: normalizeFiniteNumber(source.lastUpdatedTurn ?? source.last_updated_turn, 0)
            };
        };
        const mergeEntityVisualCanon = (baseVisual = null, incomingVisual = null, options = {}) => {
            const base = normalizeEntityVisualCanon(baseVisual || {}, {});
            const incoming = normalizeEntityVisualCanon(incomingVisual || {}, {});
            const force = options.forceReplace === true;
            for (const key of Object.keys(base.appearanceText)) {
                const incomingText = clampEntityText(incoming.appearanceText[key] || '', 320);
                if (!incomingText) continue;
                if (force || isSparseEntityText(base.appearanceText[key]) || incomingText.length > String(base.appearanceText[key] || '').length * 1.35) {
                    base.appearanceText[key] = incomingText;
                }
            }
            base.promptPolicy.mustKeep = normalizeEntityList([...(base.promptPolicy.mustKeep || []), ...(incoming.promptPolicy.mustKeep || [])], 18, 160);
            base.promptPolicy.avoidChanging = normalizeEntityList([...(base.promptPolicy.avoidChanging || []), ...(incoming.promptPolicy.avoidChanging || [])], 18, 160);
            base.promptPolicy.allowSceneOverride = normalizeEntityList([...(base.promptPolicy.allowSceneOverride || []), ...(incoming.promptPolicy.allowSceneOverride || [])], 18, 160);
            base.promptPolicy.requireEvidenceForChange = incoming.promptPolicy.requireEvidenceForChange !== false && base.promptPolicy.requireEvidenceForChange !== false;
            base.evidence = normalizeVisualEvidence([...(base.evidence || []), ...(incoming.evidence || [])], 18);
            if (incoming.customOverride.enabled || force) base.customOverride = incoming.customOverride;
            base.updatedAt = Math.max(normalizeFiniteNumber(base.updatedAt, 0), normalizeFiniteNumber(incoming.updatedAt, 0), MemoryState.currentTurn || 0);
            return base;
        };
        const entityHasVisualProfile = (entity = {}) => {
            const visual = normalizeEntityVisualCanon(entity?.visualCanon || entity?.visual_canon || {}, entity);
            return Object.values(visual.appearanceText || {}).some(value => String(value || '').trim());
        };
        const formatVisualCanonForPrompt = (entity = {}, options = {}) => {
            if (!entity || typeof entity !== 'object') return '';
            if (typeof MemoryEngine !== 'undefined' && MemoryEngine.CONFIG?.entityVisualCanonEnabled === false) return '';
            const visual = normalizeEntityVisualCanon(entity.visualCanon || entity.visual_canon || {}, entity);
            const visualState = normalizeCurrentVisualState(entity?.currentState?.visualState || entity?.currentState?.visual_state || {});
            const lines = [];
            const name = clampEntityText(entity.name || options.name || '', 100);
            if (!name) return '';
            const summaryBits = Object.entries(visual.appearanceText || {})
                .filter(([, value]) => String(value || '').trim())
                .map(([key, value]) => `${key}=${value}`);
            if (summaryBits.length) lines.push(`Visual profile for ${name}: ${summaryBits.join(' | ')}`);
            const stateBits = Object.entries(visualState || {})
                .filter(([key, value]) => !['source', 'lastUpdatedTurn'].includes(key) && String(value || '').trim())
                .map(([key, value]) => `${key}=${value}`);
            if (stateBits.length) lines.push(`Current visual state: ${stateBits.join(' | ')}`);
            if (visual.promptPolicy?.mustKeep?.length) lines.push(`Must keep: ${visual.promptPolicy.mustKeep.join(', ')}`);
            if (visual.promptPolicy?.avoidChanging?.length) lines.push(`Avoid changing: ${visual.promptPolicy.avoidChanging.join(', ')}`);
            return lines.join('\n');
        };
        const buildVisualProfilePayload = (entityNames = [], options = {}) => {
            if (typeof MemoryEngine !== 'undefined' && MemoryEngine.CONFIG?.entityVisualCanonEnabled === false) return null;
            const names = dedupeTextArray((Array.isArray(entityNames) ? entityNames : [entityNames]).map(v => String(v || '').trim()).filter(Boolean)).slice(0, 8);
            const entities = [];
            const cache = entityCache;
            if (names.length) {
                for (const name of names) {
                    const canonical = resolveCanonicalName(name, options.lorebook || []) || name;
                    const entity = cache.get(canonical) || cache.get(name);
                    if (entity && entityHasVisualProfile(entity)) entities.push(entity);
                }
            } else {
                for (const entity of cache.values()) {
                    if (entityHasVisualProfile(entity)) entities.push(entity);
                    if (entities.length >= 8) break;
                }
            }
            const blocks = entities.slice(0, 8).map(entity => formatVisualCanonForPrompt(entity)).filter(Boolean);
            if (!blocks.length) return null;
            return { entities, blocks, text: blocks.join('\n') };
        };
        const isSparseEntityText = (value) => {
            const text = String(value || '').trim();
            if (!text) return true;
            const lowered = text.toLowerCase();
            return lowered === 'unknown'
                || lowered === 'none'
                || lowered === 'n/a'
                || lowered === 'null'
                || lowered === '아는 사이'
                || lowered === '동료'
                || text.length < 4;
        };
        const ENTITY_STORAGE_LIMITS = Object.freeze({
            evidence: 12,
            episodeLedger: 12,
            stateTimeline: 12,
            povPublic: 12,
            povPrivate: 8,
            relationEventLedger: 12,
            relationEvidence: 12
        });

        const normalizeEntityEvidenceItems = (items, limit = 16) => {
            const source = Array.isArray(items) ? items : (items ? [items] : []);
            const out = [];
            const indexByKey = new Map();
            for (const item of source) {
                let entry = {};
                if (typeof item === 'string') {
                    entry = { snippet: clampEntityText(item, 260), status: 'active' };
                } else if (item && typeof item === 'object') {
                    entry = {
                        sourceKind: clampEntityText(item.sourceKind || item.source_kind || item.kind || item.source || '', 64),
                        turn: normalizeFiniteNumber(item.turn ?? item.sourceTurn ?? item.turnNumber, 0),
                        messageId: clampEntityText(item.messageId || item.m_id || item.sourceMessageId || '', 96),
                        snippet: clampEntityText(item.snippet || item.quote || item.text || item.summary || item.evidence || '', 260),
                        confidence: normalizeEntity01(item.confidence, 0),
                        status: normalizeRelationEventStatus(item.status || item.provenanceStatus || 'active'),
                        supersededBy: clampEntityText(item.supersededBy || item.superseded_by || '', 96),
                        reason: clampEntityText(item.reason || item.retractionReason || '', 120)
                    };
                }
                if (isRollbackRepairEntitySource(entry.sourceKind)) continue;
                if (!entry.snippet && !entry.sourceKind && !entry.turn && !entry.messageId) continue;
                const key = `${entry.sourceKind || ''}|${entry.turn || 0}|${entry.messageId || ''}|${entry.snippet || ''}`.toLowerCase();
                if (indexByKey.has(key)) out[indexByKey.get(key)] = entry;
                else {
                    indexByKey.set(key, out.length);
                    out.push(entry);
                }
            }
            return out.slice(-Math.max(1, limit));
        };

        const normalizeEntityThreadItems = (items, limit = 12) => {
            const source = Array.isArray(items) ? items : (items ? [items] : []);
            return source.map(item => {
                if (typeof item === 'string') {
                    const label = clampEntityText(item, 180);
                    if (!label) return null;
                    return {
                        id: `thread_${TokenizerEngine.simpleHash(label)}`,
                        label,
                        status: 'active',
                        pressure: 0
                    };
                }
                if (!item || typeof item !== 'object') return null;
                const label = clampEntityText(item.label || item.summary || item.text || item.name || '', 180);
                if (!label) return null;
                return {
                    id: clampEntityText(item.id || `thread_${TokenizerEngine.simpleHash(label)}`, 96),
                    label,
                    status: clampEntityText(item.status || 'active', 48) || 'active',
                    pressure: normalizeEntity01(item.pressure, 0),
                    evidenceTurns: normalizeEntityList(item.evidenceTurns || item.turns || [], 12, 24)
                };
            }).filter(Boolean).slice(-Math.max(1, limit));
        };

        const normalizeEntityEpisodeLedger = (items, limit = 16) => {
            const source = Array.isArray(items) ? items : (items ? [items] : []);
            const out = [];
            const indexByKey = new Map();
            for (const item of source) {
                if (!item) continue;
                const summary = typeof item === 'string'
                    ? clampEntityText(item, 260)
                    : clampEntityText(item.summary || item.event || item.text || item.brief || '', 260);
                if (!summary) continue;
                const turn = typeof item === 'object' ? normalizeFiniteNumber(item.turn ?? item.sourceTurn ?? item.turnNumber, 0) : 0;
                const eventId = typeof item === 'object'
                    ? clampEntityText(item.eventId || item.id || `event_${TokenizerEngine.simpleHash(`${turn}:${summary}`)}`, 96)
                    : `event_${TokenizerEngine.simpleHash(summary)}`;
                const entry = {
                    eventId,
                    turn,
                    summary,
                    impact: typeof item === 'object' ? clampEntityText(item.impact || item.effect || '', 220) : '',
                    stability: typeof item === 'object' ? clampEntityText(item.stability || item.scope || 'current_state', 64) : 'current_state',
                    evidence: typeof item === 'object' ? normalizeEntityEvidenceItems(item.evidence || item.evidenceItems || [], 6) : [],
                    messageId: typeof item === 'object' ? clampEntityText(item.messageId || item.m_id || item.sourceMessageId || '', 96) : '',
                    sourceRevision: typeof item === 'object' ? Math.max(0, normalizeFiniteNumber(item.sourceRevision || item.revision, 0)) : 0,
                    status: typeof item === 'object' ? normalizeRelationEventStatus(item.status || item.provenanceStatus || 'active') : 'active',
                    supersededBy: typeof item === 'object' ? clampEntityText(item.supersededBy || item.superseded_by || '', 96) : '',
                    reason: typeof item === 'object' ? clampEntityText(item.reason || item.retractionReason || '', 120) : ''
                };
                const key = `${eventId}|${turn}|${summary}`.toLowerCase();
                if (indexByKey.has(key)) out[indexByKey.get(key)] = entry;
                else {
                    indexByKey.set(key, out.length);
                    out.push(entry);
                }
            }
            return out.slice(-Math.max(1, limit));
        };

        const normalizeEntityStateTimeline = (items, limit = 24) => {
            const source = Array.isArray(items) ? items : (items ? [items] : []);
            const out = [];
            const seen = new Set();
            for (const item of source) {
                if (!item) continue;
                const isObject = item && typeof item === 'object' && !Array.isArray(item);
                const summary = isObject
                    ? clampEntityText(item.summary || item.state || item.text || item.description || item.note || '', 260)
                    : clampEntityText(item, 260);
                if (!summary) continue;
                const turn = isObject
                    ? normalizeFiniteNumber(item.turn ?? item.sourceTurn ?? item.lastObservedTurn, 0)
                    : normalizeFiniteNumber(MemoryState?.currentTurn, 0);
                const physicalState = isObject ? normalizeEntityList(item.physicalState || item.physical_state || [], 8, 140) : [];
                const emotionalState = isObject ? normalizeEntityMoodAtoms(item.emotionalState || item.emotional_state || [], 6, 48) : [];
                const cognitiveFocus = isObject ? normalizeEntityList(item.cognitiveFocus || item.cognitive_focus || [], 8, 160) : [];
                const sourceKind = isObject ? clampEntityText(item.sourceKind || item.source || 'turn_state', 64) : 'turn_state';
                const stability = isObject ? clampEntityText(item.stability || item.scope || 'turn_state', 64) : 'turn_state';
                const evidence = isObject ? normalizeEntityEvidenceItems(item.evidence || item.evidenceItems || [], 4) : [];
                const key = `${turn}|${sourceKind}|${summary}`.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    turn,
                    summary,
                    physicalState,
                    emotionalState,
                    cognitiveFocus,
                    sourceKind,
                    stability,
                    evidence
                });
            }
            return out.slice(-Math.max(1, limit));
        };

        const normalizeEntityQuality = (quality, entity = {}) => {
            const source = quality && typeof quality === 'object' && !Array.isArray(quality) ? quality : {};
            const meta = entity?.meta && typeof entity.meta === 'object' ? entity.meta : {};
            return {
                confidence: normalizeEntity01(source.confidence, normalizeFiniteNumber(meta.confidence, 0.5)),
                salience: normalizeEntity01(source.salience, 0),
                importance: normalizeEntity01(source.importance, 0),
                pressure: normalizeEntity01(source.pressure, 0),
                lastUpdatedTurn: normalizeFiniteNumber(source.lastUpdatedTurn ?? source.updatedTurn ?? meta.updated, 0),
                sourceMix: normalizeEntitySourceMix([...(Array.isArray(source.sourceMix) ? source.sourceMix : []), meta.source].filter(Boolean), 10, 64),
                staleness: clampEntityText(source.staleness || '', 48),
                needsReview: !!source.needsReview
            };
        };

        const ENTITY_FIELD_MAPPING_MIGRATION_SCHEMA = 'libra.entity_field_mapping.v1';
        const parseLegacyStructuredEntityValue = (value) => {
            if (value && typeof value === 'object') return value;
            if (typeof value !== 'string') return null;
            const text = value.trim();
            if (!text || !((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) return null;
            try {
                const parsed = JSON.parse(text);
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch {
                return null;
            }
        };
        const isEmptyLegacyStructuredEntityValue = (value) => {
            const parsed = parseLegacyStructuredEntityValue(value);
            if (Array.isArray(parsed)) return parsed.length === 0;
            return !!parsed && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
        };
        const legacyEntityScalarText = (...values) => {
            for (const value of values) {
                if (value == null || value === '') continue;
                if (isEmptyLegacyStructuredEntityValue(value)) continue;
                const text = clampEntityText(value, 260);
                if (text && text !== '[]' && text !== '{}') return text;
            }
            return '';
        };
        const repairLegacyEntityFieldMappings = (entity) => {
            if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return entity;
            const recovered = new Set(Array.isArray(entity?.meta?.fieldMappingMigration?.recoveredFields)
                ? entity.meta.fieldMappingMigration.recoveredFields
                : []);
            let changed = false;
            const note = (field) => { changed = true; recovered.add(field); };
            const assignText = (target, key, value, field = key) => {
                if (!target || typeof target !== 'object') return;
                const text = legacyEntityScalarText(value);
                if (!text || legacyEntityScalarText(target[key])) return;
                target[key] = text;
                note(field);
            };

            const parsedIdentityRoot = parseLegacyStructuredEntityValue(entity.identity);
            if (parsedIdentityRoot && !Array.isArray(parsedIdentityRoot) && typeof entity.identity === 'string') {
                entity.identity = { ...parsedIdentityRoot };
                note('identity');
            }
            const identity = entity.identity && typeof entity.identity === 'object' && !Array.isArray(entity.identity)
                ? entity.identity
                : {};
            entity.identity = identity;
            const identityPayload = parseLegacyStructuredEntityValue(identity.summary);
            const identityDetails = identityPayload && !Array.isArray(identityPayload) ? identityPayload : {};
            assignText(identity, 'roleInStory', identity.role || identity.storyRole || identityDetails.roleInStory || identityDetails.role || identityDetails.storyRole || identityDetails.relation_to_user, 'identity.roleInStory');
            assignText(identity, 'affiliation', identity.school || identity.organization || identity.workplace || identityDetails.affiliation || identityDetails.school || identityDetails.organization || identityDetails.workplace, 'identity.affiliation');
            assignText(identity, 'occupation', identity.job || identityDetails.occupation || identityDetails.job, 'identity.occupation');
            assignText(identity, 'age', identityDetails.age, 'identity.age');
            assignText(identity, 'sex', identityDetails.sex || identityDetails.gender, 'identity.sex');
            if (identityPayload) {
                const nextSummary = legacyEntityScalarText(identityDetails.summary, identityDetails.description, identityDetails.text, identityDetails.identity);
                if (identity.summary !== nextSummary) {
                    identity.summary = nextSummary;
                    note('identity.summary');
                }
            } else if (isEmptyLegacyStructuredEntityValue(identity.summary)) {
                identity.summary = '';
                note('identity.summary');
            }

            const parsedStateRoot = parseLegacyStructuredEntityValue(entity.currentState || entity.current_state);
            if (parsedStateRoot && !Array.isArray(parsedStateRoot) && typeof (entity.currentState || entity.current_state) === 'string') {
                entity.currentState = { ...parsedStateRoot };
                note('currentState');
            }
            const currentState = entity.currentState && typeof entity.currentState === 'object' && !Array.isArray(entity.currentState)
                ? entity.currentState
                : {};
            entity.currentState = currentState;
            const statePayload = parseLegacyStructuredEntityValue(currentState.summary);
            const stateDetails = statePayload && !Array.isArray(statePayload) ? statePayload : {};
            assignText(currentState, 'location', currentState.currentLocation || currentState.current_location || stateDetails.location || stateDetails.currentLocation || stateDetails.current_location, 'currentState.location');
            assignText(currentState, 'activity', currentState.currentActivity || currentState.current_activity || stateDetails.activity || stateDetails.currentActivity || stateDetails.current_activity, 'currentState.activity');
            assignText(currentState, 'immediateGoal', currentState.goal || stateDetails.immediateGoal || stateDetails.immediate_goal || stateDetails.goal, 'currentState.immediateGoal');
            const mood = legacyEntityScalarText(currentState.mood, currentState.emotion, stateDetails.mood, stateDetails.emotion, stateDetails.emotionalState, stateDetails.emotional_state);
            if (mood && (!Array.isArray(currentState.emotionalState) || currentState.emotionalState.length === 0)) {
                currentState.emotionalState = [mood];
                note('currentState.emotionalState');
            }
            if (statePayload) {
                const nextSummary = legacyEntityScalarText(stateDetails.summary, stateDetails.description, stateDetails.text, stateDetails.state, stateDetails.note);
                if (currentState.summary !== nextSummary) {
                    currentState.summary = nextSummary;
                    note('currentState.summary');
                }
            } else if (isEmptyLegacyStructuredEntityValue(currentState.summary)) {
                currentState.summary = '';
                note('currentState.summary');
            }

            entity.status = entity.status && typeof entity.status === 'object' && !Array.isArray(entity.status) ? entity.status : {};
            assignText(entity.status, 'currentLocation', currentState.location, 'status.currentLocation');
            assignText(entity.status, 'currentMood', mood || currentState.emotionalState, 'status.currentMood');
            const parsedStatusNotes = parseLegacyStructuredEntityValue(entity.status.notes);
            if (parsedStatusNotes) {
                const details = Array.isArray(parsedStatusNotes) ? {} : parsedStatusNotes;
                const nextNotes = legacyEntityScalarText(details.summary, details.description, details.text, details.state, details.note);
                if (entity.status.notes !== nextNotes) {
                    entity.status.notes = nextNotes;
                    note('status.notes');
                }
            }

            const clearSerializedEmpty = (target, key, field) => {
                if (!target || typeof target !== 'object' || !isEmptyLegacyStructuredEntityValue(target[key])) return;
                target[key] = '';
                note(field);
            };
            if (entity.profile && typeof entity.profile === 'object') {
                if (isEmptyLegacyStructuredEntityValue(entity.profile.psychology)) {
                    entity.profile.psychology = {};
                    note('profile.psychology');
                } else if (entity.profile.psychology && typeof entity.profile.psychology === 'object' && !Array.isArray(entity.profile.psychology)) {
                    clearSerializedEmpty(entity.profile.psychology, 'baseline', 'profile.psychology.baseline');
                    clearSerializedEmpty(entity.profile.psychology, 'currentConflict', 'profile.psychology.currentConflict');
                    clearSerializedEmpty(entity.profile.psychology, 'copingStyle', 'profile.psychology.copingStyle');
                }
            }
            if (isEmptyLegacyStructuredEntityValue(entity.psychology)) {
                entity.psychology = {};
                note('psychology');
            }

            if (changed) {
                entity.meta = entity.meta && typeof entity.meta === 'object' && !Array.isArray(entity.meta) ? entity.meta : {};
                entity.meta.fieldMappingMigration = {
                    schema: ENTITY_FIELD_MAPPING_MIGRATION_SCHEMA,
                    appliedTurn: normalizeFiniteNumber(MemoryState?.currentTurn, 0),
                    recoveredFields: [...recovered].sort()
                };
            }
            return entity;
        };

        const normalizeEntityIdentity = (identity, entity = {}) => {
            const source = identity && typeof identity === 'object' && !Array.isArray(identity) ? identity : {};
            const rawAge = source.age ?? entity.age;
            const parsedAge = Number(rawAge);
            const age = Number.isFinite(parsedAge) && parsedAge > 0 && parsedAge < 200 ? Math.floor(parsedAge) : '';
            const background = entity.background && typeof entity.background === 'object' ? entity.background : {};
            const meta = entity.meta && typeof entity.meta === 'object' ? entity.meta : {};
            return {
                age,
                sex: normalizeBiologicalSex(source.sex || entity.sex || entity.biologicalSex || ''),
                occupation: clampEntityText(source.occupation || background.occupation || '', 120),
                affiliation: clampEntityText(source.affiliation || source.organization || source.workplace || '', 120),
                roleInStory: clampEntityText(source.roleInStory || source.role || source.storyRole || '', 180),
                summary: clampEntityText(source.summary || source.identity || '', 240),
                aliases: normalizeEntityList([
                    ...(Array.isArray(source.aliases) ? source.aliases : []),
                    ...(Array.isArray(meta.aliases) ? meta.aliases : [])
                ], 18, 120),
                honorifics: normalizeEntityList(source.honorifics || source.honorificMarkers || [], 10, 80),
                source: normalizeEntityEvidenceItems(source.source ? [source.source] : [], 4)[0] || null
            };
        };

        const normalizeEntityProfile = (profile, entity = {}) => {
            const source = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
            const appearance = source.appearance && typeof source.appearance === 'object' ? source.appearance : {};
            const personality = source.personality && typeof source.personality === 'object' ? source.personality : {};
            const speech = source.speechStyle && typeof source.speechStyle === 'object' ? source.speechStyle : {};
            const psychology = source.psychology && typeof source.psychology === 'object' && !Array.isArray(source.psychology) ? source.psychology : {};
            const legacyAppearance = entity.appearance && typeof entity.appearance === 'object' ? entity.appearance : {};
            const legacyPersonality = entity.personality && typeof entity.personality === 'object' ? entity.personality : {};
            const legacySpeech = entity.speechStyle && typeof entity.speechStyle === 'object' ? entity.speechStyle : {};
            const legacyPsychology = entity.psychology && typeof entity.psychology === 'object' && !Array.isArray(entity.psychology) ? entity.psychology : {};
            const rawPsychologyText = typeof source.psychology === 'string'
                ? source.psychology
                : (Array.isArray(source.psychology)
                    ? normalizeEntityList(source.psychology, 6, 140).join('; ')
                    : (typeof entity.psychology === 'string'
                        ? entity.psychology
                        : (Array.isArray(entity.psychology) ? normalizeEntityList(entity.psychology, 6, 140).join('; ') : '')));
            const explicitPsychologyConflict = psychology.currentConflict
                || psychology.current_conflict
                || psychology.innerConflict
                || psychology.inner_conflict
                || psychology.internalConflict
                || psychology.internal_conflict
                || psychology.conflict
                || legacyPsychology.currentConflict
                || legacyPsychology.current_conflict
                || legacyPsychology.innerConflict
                || legacyPsychology.inner_conflict
                || entity.currentConflict
                || entity.current_conflict
                || entity.innerConflict
                || entity.inner_conflict
                || entity.internalConflict
                || entity.internal_conflict
                || entity.conflict
                || '';
            const normalizedPsychologyBaseline = clampEntityText(
                psychology.baseline
                || psychology.defaultState
                || psychology.default_state
                || psychology.core
                || legacyPsychology.baseline
                || legacyPsychology.defaultState
                || legacyPsychology.default_state
                || entity.baselinePsychology
                || entity.psychologicalBaseline
                || entity.psychological_baseline
                || (explicitPsychologyConflict ? '' : rawPsychologyText),
                220
            );
            const normalizedPsychologyConflict = clampEntityText(explicitPsychologyConflict, 220);
            const normalizedPsychologyNotes = normalizeEntityList([
                ...collectEntityItems(
                    psychology.notes,
                    psychology.cues,
                    psychology.signals,
                    psychology.observations,
                    legacyPsychology.notes,
                    legacyPsychology.cues,
                    entity.psychologicalNotes,
                    entity.psychological_notes,
                    entity.mentalNotes,
                    entity.mental_notes
                ),
                rawPsychologyText && rawPsychologyText !== normalizedPsychologyBaseline && rawPsychologyText !== normalizedPsychologyConflict ? rawPsychologyText : ''
            ].filter(Boolean), 10, 180);
            return {
                appearance: {
                    features: normalizeEntityList([...asEntityArray(appearance.features), ...asEntityArray(legacyAppearance.features)], 14, 150),
                    distinctiveMarks: normalizeEntityList([...asEntityArray(appearance.distinctiveMarks), ...asEntityArray(legacyAppearance.distinctiveMarks)], 8, 150),
                    clothing: normalizeEntityList([...asEntityArray(appearance.clothing), ...asEntityArray(legacyAppearance.clothing)], 10, 150),
                    confidence: normalizeEntity01(appearance.confidence, 0)
                },
                personality: {
                    traits: normalizeEntityTraitList([...asEntityArray(personality.traits), ...asEntityArray(legacyPersonality.traits)], 18, 160),
                    values: normalizeEntityList([...asEntityArray(personality.values), ...asEntityArray(legacyPersonality.values)], 12, 160),
                    fears: normalizeEntityList([...asEntityArray(personality.fears), ...asEntityArray(legacyPersonality.fears)], 12, 160),
                    likes: normalizeEntityList([...asEntityArray(personality.likes), ...asEntityArray(legacyPersonality.likes)], 12, 160),
                    dislikes: normalizeEntityList([...asEntityArray(personality.dislikes), ...asEntityArray(legacyPersonality.dislikes)], 12, 160),
                    vulnerabilities: normalizeEntityList(personality.vulnerabilities || personality.weaknesses || [], 10, 180),
                    boundaries: normalizeEntityList(personality.boundaries || [], 10, 180),
                    workStyle: clampEntityText(personality.workStyle || '', 180),
                    socialStyle: clampEntityText(personality.socialStyle || '', 180),
                    confidence: normalizeEntity01(personality.confidence, 0)
                },
                speechStyle: {
                    defaultTone: clampEntityText(speech.defaultTone || legacySpeech.defaultTone || '', 120),
                    honorificStyle: clampEntityText(speech.honorificStyle || legacySpeech.honorificStyle || '', 140),
                    pressureMarkers: normalizeEntityList(speech.pressureMarkers || speech.pressure_markers || [], 10, 100),
                    intimacyShift: clampEntityText(speech.intimacyShift || speech.intimacy_shift || '', 180),
                    catchphrases: normalizeEntityList(speech.catchphrases || speech.verbalTics || [], 10, 100),
                    notes: normalizeEntityList([...asEntityArray(speech.notes), ...asEntityArray(legacySpeech.notes)], 12, 160)
                },
                psychology: {
                    baseline: normalizedPsychologyBaseline,
                    currentConflict: normalizedPsychologyConflict,
                    copingStyle: clampEntityText(psychology.copingStyle || psychology.coping_style || psychology.coping || legacyPsychology.copingStyle || legacyPsychology.coping_style || legacyPsychology.coping || entity.copingStyle || entity.coping_style || entity.coping || '', 180),
                    notes: normalizedPsychologyNotes,
                    confidence: normalizeEntity01(psychology.confidence ?? legacyPsychology.confidence, 0)
                }
            };
        };

        const normalizeEntityCurrentState = (currentState, entity = {}) => {
            const source = currentState && typeof currentState === 'object' && !Array.isArray(currentState) ? currentState : {};
            const rawStateText = typeof currentState === 'string' ? currentState : '';
            const status = entity.status && typeof entity.status === 'object' ? entity.status : {};
            const sceneTime = clampEntityText(source.sceneTime || source.scene_time || [status.currentDate, status.currentTime].filter(Boolean).join(' ') || '', 80);
            const rawEmotionalState = source.emotionalState || source.emotional_state || [];
            const hasExplicitEmotionalState = Array.isArray(rawEmotionalState)
                ? rawEmotionalState.some(item => String(item || '').trim())
                : !!String(rawEmotionalState || '').trim();
            return {
                summary: clampEntityText(source.summary || source.current_state || rawStateText || '', 260),
                sceneTime,
                location: clampEntityText(source.location || status.currentLocation || '', 160),
                physicalState: normalizeEntityList(source.physicalState || source.physical_state || [], 12, 160),
                emotionalState: normalizeEntityMoodAtoms(hasExplicitEmotionalState ? rawEmotionalState : status.currentMood, 8, 48),
                cognitiveFocus: normalizeEntityList(source.cognitiveFocus || source.cognitive_focus || [], 12, 180),
                activity: clampEntityText(source.activity || source.currentActivity || source.current_activity || '', 220),
                immediateGoal: clampEntityText(source.immediateGoal || source.immediate_goal || '', 220),
                activeProblems: normalizeEntityList(source.activeProblems || source.active_problems || [], 12, 180),
                visualState: normalizeCurrentVisualState(source.visualState || source.visual_state || source.currentVisualState || source.current_visual_state || {}),
                lastObservedTurn: normalizeFiniteNumber(source.lastObservedTurn ?? source.last_observed_turn ?? status.lastUpdated, 0)
            };
        };

        const syncEntityLegacyV2Mirrors = (entity) => {
            if (!entity || typeof entity !== 'object') return entity;
            const identity = entity.identity && typeof entity.identity === 'object' ? entity.identity : {};
            const profile = entity.profile && typeof entity.profile === 'object' ? entity.profile : {};
            const currentState = entity.currentState && typeof entity.currentState === 'object' ? entity.currentState : {};
            const appearance = profile.appearance && typeof profile.appearance === 'object' ? profile.appearance : {};
            const personality = profile.personality && typeof profile.personality === 'object' ? profile.personality : {};
            const speech = profile.speechStyle && typeof profile.speechStyle === 'object' ? profile.speechStyle : {};
            const legacyAppearance = entity.appearance && typeof entity.appearance === 'object' ? entity.appearance : {};
            const legacyPersonality = entity.personality && typeof entity.personality === 'object' ? entity.personality : {};
            const legacySpeech = normalizeSpeechStyleObject(entity.speechStyle || {});
            const legacyBackground = entity.background && typeof entity.background === 'object' ? entity.background : {};
            const legacyStatus = entity.status && typeof entity.status === 'object' ? entity.status : {};
            entity.meta = entity.meta && typeof entity.meta === 'object' ? entity.meta : {};

            const aliases = normalizeEntityList([
                ...(Array.isArray(entity.meta.aliases) ? entity.meta.aliases : []),
                ...(Array.isArray(identity.aliases) ? identity.aliases : [])
            ], 32, 120);
            entity.meta.aliases = aliases;
            if (entity.identity && typeof entity.identity === 'object') entity.identity.aliases = aliases.slice(0, 24);

            entity.sex = normalizeBiologicalSex(identity.sex || entity.sex || '');
            entity.appearance = {
                ...legacyAppearance,
                features: normalizeEntityList(appearance.features || [], 18, 160),
                distinctiveMarks: normalizeEntityList(appearance.distinctiveMarks || [], 12, 160),
                clothing: normalizeEntityList(appearance.clothing || [], 12, 160)
            };
            entity.personality = {
                ...legacyPersonality,
                traits: normalizeEntityTraitList(personality.traits || [], 18, 180),
                values: normalizeEntityList(personality.values || [], 12, 180),
                fears: normalizeEntityList(personality.fears || [], 12, 180),
                likes: normalizeEntityList(personality.likes || [], 12, 180),
                dislikes: normalizeEntityList(personality.dislikes || [], 12, 180),
                sexualOrientation: clampEntityText(legacyPersonality.sexualOrientation || '', 160),
                sexualPreferences: normalizeEntityList(legacyPersonality.sexualPreferences || [], 12, 160)
            };
            entity.speechStyle = {
                ...legacySpeech,
                defaultTone: clampEntityText(speech.defaultTone || legacySpeech.defaultTone || '', 120),
                honorificStyle: clampEntityText(speech.honorificStyle || legacySpeech.honorificStyle || '', 140),
                notes: normalizeEntityList(speech.notes || [], 12, 160)
            };
            entity.background = {
                ...legacyBackground,
                occupation: clampEntityText(identity.occupation || legacyBackground.occupation || '', 120)
            };
            const emotionalState = normalizeEntityMoodAtoms(
                Array.isArray(currentState.emotionalState) && currentState.emotionalState.length
                    ? currentState.emotionalState
                    : legacyStatus.currentMood,
                8,
                48
            );
            if (entity.currentState && typeof entity.currentState === 'object') {
                entity.currentState.emotionalState = emotionalState;
            }
            const lastObservedTurn = normalizeFiniteNumber(currentState.lastObservedTurn, 0);
            const qualityTurn = normalizeFiniteNumber(entity.quality?.lastUpdatedTurn, 0);
            entity.status = {
                ...legacyStatus,
                currentLocation: clampEntityText(currentState.location || legacyStatus.currentLocation || '', 160),
                currentMood: clampEntityText(emotionalState.join(', '), 160),
                lastUpdated: Math.max(normalizeFiniteNumber(legacyStatus.lastUpdated, 0), lastObservedTurn, qualityTurn)
            };
            return entity;
        };

        const normalizeEntityContinuity = (continuity) => {
            const source = continuity && typeof continuity === 'object' && !Array.isArray(continuity) ? continuity : {};
            return {
                openThreads: normalizeEntityThreadItems(collectEntityItems(
                    source.openThreads,
                    source.open_threads,
                    source.activeThreads,
                    source.active_threads,
                    source.threads,
                    source.unresolvedThreads,
                    source.unresolved_threads,
                    source.openLoops,
                    source.open_loops,
                    source.openHooks,
                    source.open_hooks,
                    source.plotHooks,
                    source.plot_hooks,
                    source.looseEnds,
                    source.loose_ends,
                    source.pendingQuestions,
                    source.pending_questions,
                    source.unresolved
                ), 12),
                unresolvedNeeds: normalizeEntityList(collectEntityItems(source.unresolvedNeeds, source.unresolved_needs, source.needs, source.pendingNeeds, source.pending_needs), 12, 180),
                commitments: normalizeEntityList(collectEntityItems(source.commitments, source.promises, source.obligations), 12, 180),
                nextActionHints: normalizeEntityList(collectEntityItems(source.nextActionHints, source.next_action_hints, source.nextActions, source.next_actions, source.nextSteps, source.next_steps, source.plannedNextSteps, source.planned_next_steps), 12, 180)
            };
        };

        const normalizeEntityPovKnowledge = (povKnowledge) => {
            const source = povKnowledge && typeof povKnowledge === 'object' && !Array.isArray(povKnowledge) ? povKnowledge : {};
            return {
                knownToSelf: normalizeEntityList(source.knownToSelf || source.known_to_self || [], ENTITY_STORAGE_LIMITS.povPublic, 180),
                unknownToSelf: normalizeEntityList(source.unknownToSelf || source.unknown_to_self || [], ENTITY_STORAGE_LIMITS.povPrivate, 180),
                knownToOthers: normalizeEntityList(source.knownToOthers || source.known_to_others || [], ENTITY_STORAGE_LIMITS.povPublic, 180),
                visibleTo: normalizeEntityList(source.visibleTo || source.visible_to || [], 12, 120),
                privateExperiences: normalizeEntityList(source.privateExperiences || source.private_experiences || [], ENTITY_STORAGE_LIMITS.povPrivate, 180),
                privacy: clampEntityText(source.privacy || source.privacyLevel || '', 80)
            };
        };

        const normalizeEntityV2Fields = (entity) => {
            if (!entity || typeof entity !== 'object') return entity;
            repairLegacyEntityFieldMappings(entity);
            entity.entityType = clampEntityText(entity.entityType || entity.kind || entity.type || 'person', 48) || 'person';
            entity.identity = normalizeEntityIdentity(entity.identity, entity);
            rebalanceEntityVisualPersonalityFields(entity);
            entity.profile = normalizeEntityProfile(entity.profile, entity);
            entity.currentState = normalizeEntityCurrentState(entity.currentState || entity.current_state, entity);
            entity.visualCanon = normalizeEntityVisualCanon(entity.visualCanon || entity.visual_canon || entity.visualProfile || entity.visual_profile || {}, entity);
            if (Object.prototype.hasOwnProperty.call(entity, 'visual_canon')) delete entity.visual_canon;
            entity.continuity = normalizeEntityContinuity(entity.continuity);
            entity.povKnowledge = normalizeEntityPovKnowledge(entity.povKnowledge || entity.pov_knowledge || entity.knowledge);
            entity.episodeLedger = normalizeEntityEpisodeLedger(entity.episodeLedger || entity.episode_ledger || [], ENTITY_STORAGE_LIMITS.episodeLedger);
            entity.stateTimeline = normalizeEntityStateTimeline(entity.stateTimeline || entity.state_timeline || [], ENTITY_STORAGE_LIMITS.stateTimeline);
            entity.evidence = normalizeEntityEvidenceItems(entity.evidence || entity.evidenceItems || [], ENTITY_STORAGE_LIMITS.evidence);
            entity.quality = normalizeEntityQuality(entity.quality, entity);
            rebalanceEntityVisualPersonalityFields(entity);
            return syncEntityLegacyV2Mirrors(entity);
        };

        const mergeEntityScalar = (target, source, key, options = {}) => {
            const incoming = source?.[key];
            const incomingText = typeof incoming === 'number' ? incoming : clampEntityText(incoming, options.max || 220);
            if (incomingText === '' || incomingText == null) return;
            const existing = target?.[key];
            if (options.force || isSparseEntityText(existing)) {
                target[key] = incomingText;
                return;
            }
            if (typeof incomingText === 'string' && typeof existing === 'string' && incomingText.length > existing.length * 1.45) {
                target[key] = incomingText;
            }
        };

        const mergeEntityListField = (target, source, key, limit = 12, itemMax = 180) => {
            if (key === 'emotionalState') {
                target[key] = normalizeEntityMoodAtoms([
                    ...(Array.isArray(target?.[key]) ? target[key] : (target?.[key] ? [target[key]] : [])),
                    ...(Array.isArray(source?.[key]) ? source[key] : (source?.[key] ? [source[key]] : []))
                ], Math.min(Number(limit || 8) || 8, 8), 48);
                return;
            }
            const mergedItems = [
                ...(Array.isArray(target?.[key]) ? target[key] : []),
                ...(Array.isArray(source?.[key]) ? source[key] : (source?.[key] ? [source[key]] : []))
            ];
            target[key] = key === 'traits'
                ? normalizeEntityTraitList(mergedItems, limit, itemMax)
                : normalizeEntityList(mergedItems, limit, itemMax);
        };

        const mergeEntityV2Fields = (baseEntity, incomingEntity, options = {}) => {
            if (!baseEntity || !incomingEntity) return baseEntity;
            const rawCurrentState = incomingEntity.currentState || incomingEntity.current_state;
            const rawContinuity = incomingEntity.continuity;
            const rawCurrentStateKeys = new Set(rawCurrentState && typeof rawCurrentState === 'object' ? Object.keys(rawCurrentState) : []);
            const rawContinuityKeys = new Set(rawContinuity && typeof rawContinuity === 'object' ? Object.keys(rawContinuity) : []);
            normalizeEntityV2Fields(baseEntity);
            normalizeEntityV2Fields(incomingEntity);
            const force = options.forceReplace === true;
            const allowVolatileState = options.allowVolatileState !== false;

            ['age', 'sex', 'occupation', 'affiliation', 'roleInStory', 'summary'].forEach(key => mergeEntityScalar(baseEntity.identity, incomingEntity.identity, key, { force, max: 180 }));
            mergeEntityListField(baseEntity.identity, incomingEntity.identity, 'aliases', 24, 120);
            mergeEntityListField(baseEntity.identity, incomingEntity.identity, 'honorifics', 12, 100);
            if (!baseEntity.identity.source && incomingEntity.identity.source) baseEntity.identity.source = incomingEntity.identity.source;

            for (const key of ['features', 'distinctiveMarks', 'clothing']) {
                mergeEntityListField(baseEntity.profile.appearance, incomingEntity.profile.appearance, key, key === 'features' ? 18 : 12, 160);
            }
            baseEntity.profile.appearance.confidence = Math.max(baseEntity.profile.appearance.confidence || 0, incomingEntity.profile.appearance.confidence || 0);
            for (const key of ['traits', 'values', 'fears', 'likes', 'dislikes', 'vulnerabilities', 'boundaries']) {
                mergeEntityListField(baseEntity.profile.personality, incomingEntity.profile.personality, key, 18, 180);
            }
            ['workStyle', 'socialStyle'].forEach(key => mergeEntityScalar(baseEntity.profile.personality, incomingEntity.profile.personality, key, { force, max: 180 }));
            baseEntity.profile.personality.confidence = Math.max(baseEntity.profile.personality.confidence || 0, incomingEntity.profile.personality.confidence || 0);

            ['defaultTone', 'honorificStyle', 'intimacyShift'].forEach(key => mergeEntityScalar(baseEntity.profile.speechStyle, incomingEntity.profile.speechStyle, key, { force, max: 180 }));
            ['pressureMarkers', 'catchphrases', 'notes'].forEach(key => mergeEntityListField(baseEntity.profile.speechStyle, incomingEntity.profile.speechStyle, key, 12, 160));
            ['baseline', 'copingStyle'].forEach(key => mergeEntityScalar(baseEntity.profile.psychology, incomingEntity.profile.psychology, key, { force, max: 220 }));
            if (allowVolatileState) mergeEntityScalar(baseEntity.profile.psychology, incomingEntity.profile.psychology, 'currentConflict', { force, max: 220 });
            mergeEntityListField(baseEntity.profile.psychology, incomingEntity.profile.psychology, 'notes', 12, 180);
            baseEntity.profile.psychology.confidence = Math.max(baseEntity.profile.psychology.confidence || 0, incomingEntity.profile.psychology.confidence || 0);

            const incomingTurn = normalizeFiniteNumber(incomingEntity.currentState?.lastObservedTurn, options.currentTurn || MemoryState.currentTurn || 0);
            const baseTurn = normalizeFiniteNumber(baseEntity.currentState?.lastObservedTurn, 0);
            const allowStateReplace = allowVolatileState && (force || incomingTurn >= baseTurn || isSparseEntityText(baseEntity.currentState?.summary));
            if (allowStateReplace) ['summary', 'sceneTime', 'location', 'activity', 'immediateGoal'].forEach(key => mergeEntityScalar(baseEntity.currentState, incomingEntity.currentState, key, { force: true, max: 260 }));
            if (allowVolatileState && rawCurrentState && typeof rawCurrentState === 'object') {
                ['physicalState', 'emotionalState', 'cognitiveFocus', 'activeProblems'].forEach(key => {
                    if (!rawCurrentStateKeys.has(key)) return;
                    const incomingItems = Array.isArray(rawCurrentState[key]) ? rawCurrentState[key] : (rawCurrentState[key] ? [rawCurrentState[key]] : []);
                    baseEntity.currentState[key] = key === 'emotionalState'
                        ? normalizeEntityMoodAtoms(incomingItems, 8, 48)
                        : normalizeEntityList(incomingItems, 14, 180);
                });
            }
            if (allowVolatileState && rawCurrentStateKeys.has('visualState') && rawCurrentState?.visualState) {
                const baseVisualState = normalizeCurrentVisualState(baseEntity.currentState.visualState || {});
                const incomingVisualState = normalizeCurrentVisualState(incomingEntity.currentState.visualState || {});
                ['notes', 'outfit', 'pose', 'expression', 'scene'].forEach(field => {
                    if (incomingVisualState[field] && (force || isSparseEntityText(baseVisualState[field]))) baseVisualState[field] = incomingVisualState[field];
                });
                if (incomingVisualState.source) baseVisualState.source = incomingVisualState.source;
                baseVisualState.lastUpdatedTurn = Math.max(baseVisualState.lastUpdatedTurn || 0, incomingVisualState.lastUpdatedTurn || 0, options.currentTurn || 0);
                baseEntity.currentState.visualState = baseVisualState;
            }
            if (incomingTurn) baseEntity.currentState.lastObservedTurn = Math.max(baseTurn, incomingTurn);

            baseEntity.visualCanon = mergeEntityVisualCanon(baseEntity.visualCanon || {}, incomingEntity.visualCanon || {}, { forceReplace: force });

            if (allowVolatileState && rawContinuity && typeof rawContinuity === 'object') {
                if (rawContinuityKeys.has('openThreads')) baseEntity.continuity.openThreads = normalizeEntityThreadItems(rawContinuity.openThreads || [], 14);
                ['unresolvedNeeds', 'commitments', 'nextActionHints'].forEach(key => {
                    if (rawContinuityKeys.has(key)) baseEntity.continuity[key] = normalizeEntityList(rawContinuity[key] || [], 14, 180);
                });
            }
            ['knownToSelf', 'knownToOthers', 'visibleTo'].forEach(key => mergeEntityListField(baseEntity.povKnowledge, incomingEntity.povKnowledge, key, ENTITY_STORAGE_LIMITS.povPublic, 180));
            ['unknownToSelf', 'privateExperiences'].forEach(key => mergeEntityListField(baseEntity.povKnowledge, incomingEntity.povKnowledge, key, ENTITY_STORAGE_LIMITS.povPrivate, 180));
            mergeEntityScalar(baseEntity.povKnowledge, incomingEntity.povKnowledge, 'privacy', { force, max: 100 });

            baseEntity.episodeLedger = normalizeEntityEpisodeLedger([...(baseEntity.episodeLedger || []), ...(incomingEntity.episodeLedger || [])], ENTITY_STORAGE_LIMITS.episodeLedger);
            baseEntity.stateTimeline = normalizeEntityStateTimeline([...(baseEntity.stateTimeline || []), ...(incomingEntity.stateTimeline || [])], ENTITY_STORAGE_LIMITS.stateTimeline);
            baseEntity.evidence = normalizeEntityEvidenceItems([...(baseEntity.evidence || []), ...(incomingEntity.evidence || [])], ENTITY_STORAGE_LIMITS.evidence);
            if (options.sourceMode || options.m_id) {
                baseEntity.evidence = normalizeEntityEvidenceItems([
                    ...(baseEntity.evidence || []),
                    {
                        sourceKind: options.sourceMode || 'entity_update',
                        turn: options.currentTurn || 0,
                        messageId: options.m_id || '',
                        confidence: normalizeEntity01(incomingEntity.quality?.confidence, 0)
                    }
                ], ENTITY_STORAGE_LIMITS.evidence);
            }
            baseEntity.quality.confidence = Math.max(baseEntity.quality.confidence || 0, incomingEntity.quality.confidence || 0);
            baseEntity.quality.salience = Math.max(baseEntity.quality.salience || 0, incomingEntity.quality.salience || 0);
            baseEntity.quality.importance = Math.max(baseEntity.quality.importance || 0, incomingEntity.quality.importance || 0);
            baseEntity.quality.pressure = Math.max(baseEntity.quality.pressure || 0, incomingEntity.quality.pressure || 0);
            baseEntity.quality.lastUpdatedTurn = Math.max(baseEntity.quality.lastUpdatedTurn || 0, incomingEntity.quality.lastUpdatedTurn || 0, options.currentTurn || 0);
            baseEntity.quality.sourceMix = normalizeEntitySourceMix([...(baseEntity.quality.sourceMix || []), ...(incomingEntity.quality.sourceMix || []), options.sourceMode].filter(Boolean), 12, 64);
            baseEntity.quality.needsReview = !!(baseEntity.quality.needsReview || incomingEntity.quality.needsReview);
            if (incomingEntity.quality.staleness) baseEntity.quality.staleness = incomingEntity.quality.staleness;
            return normalizeEntityV2Fields(baseEntity);
        };

        // ── [RELATION] fine-grained relation state axes + pairwise speech dynamics
