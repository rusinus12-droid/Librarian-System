    const getChatMessages = (chat) => {
        if (!chat) return [];
        return chat.msgs || chat.messages || chat.message || chat.log || chat.mes || chat.chat || [];
    };
    const unwrapAnalyzableMessage = (value) => {
        if (value && typeof value === 'object' && value.msg && typeof value.msg === 'object') return value.msg;
        return value;
    };
    const getMessageRoleHint = (value) => {
        const wrapperRole = String(value?.roleHint || '').trim().toLowerCase();
        if (/^(?:user|human|player|request|input)$/.test(wrapperRole)) return 'user';
        if (/^(?:ai|assistant|character|char|bot|model|response)$/.test(wrapperRole)) return 'ai';
        const msg = unwrapAnalyzableMessage(value);
        const roleText = String(
            msg?.role
            ?? msg?.type
            ?? msg?.speakerType
            ?? msg?.senderType
            ?? msg?.authorType
            ?? ''
        ).trim().toLowerCase();
        if (/^(?:user|human|player|request|input)$/.test(roleText)) return 'user';
        if (/^(?:assistant|ai|character|char|bot|model|response)$/.test(roleText)) return 'ai';
        if (value?.is_user === true || value?.isUser === true || value?.user === true) return 'user';
        if (msg?.is_user === true || msg?.isUser === true || msg?.user === true) return 'user';
        if (value?.is_user === false || value?.isUser === false || value?.isBot === true || value?.is_bot === true || value?.bot === true) return 'ai';
        if (msg?.is_user === false || msg?.isUser === false || msg?.isBot === true || msg?.is_bot === true || msg?.bot === true) return 'ai';
        return 'ai';
    };
    const isUserLikeMessage = (value) => getMessageRoleHint(value) === 'user';
        const getComparableMessageText = (msg) => {
        const roleHint = getMessageRoleHint(msg);
        return Utils.getNarrativeComparableText(Utils.getMessageText(msg), roleHint);
    };
    const getMessageSignature = (msg) => {
        if (!msg || typeof msg !== 'object') return '';
        const role = getMessageRoleHint(msg) === 'user' ? 'user' : 'ai';
        const speaker = String(msg?.saying || msg?.name || '').trim();
        const time = Number(msg?.time || 0);
        const text = String(getComparableMessageText(msg) || Utils.getMessageText(msg) || '').trim();
        return `${role}::${speaker}::${time || 0}::${text}`;
    };
    const stableHash = (input) => {
        const str = String(input || '');
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    };
    const readNested = (obj, path) => {
        let cur = obj;
        for (const key of path) {
            if (!cur || typeof cur !== 'object') return undefined;
            cur = cur[key];
        }
        return cur;
    };
    const collectSectionScopeHints = (chat) => {
        const hintPaths = [
            ['sectionId'], ['section', 'id'], ['section', 'name'], ['sectionName'],
            ['branchId'], ['branch', 'id'], ['branchName'],
            ['folderId'], ['folder', 'id'], ['folder', 'name'],
            ['pageId'], ['tabId'], ['roomId'], ['threadId'],
            ['chatroomId'], ['conversationId'], ['sessionId'],
            ['name'], ['title']
        ];
        const hints = [];
        for (const path of hintPaths) {
            const value = readNested(chat, path);
            if (value === undefined || value === null) continue;
            const text = String(value).trim();
            if (text) hints.push(`${path.join('.')}:${text}`);
        }
        return [...new Set(hints)].slice(0, 8);
    };
    const getChatHeadScopeSignature = (chat) => {
        const msgs = getChatMessages(chat)
            .filter(msg => msg && typeof msg === 'object')
            .slice(0, 5)
            .map(getMessageSignature)
            .filter(Boolean);
        // Early chats mutate too frequently; including a head signature before enough
        // messages exist causes rollback journals/session caches to move scopes.
        // Keep the scope stable until the first five message anchors are available.
        if (msgs.length < 5) return '';
        return stableHash(msgs.join('||'));
    };
    const getOrCreatePendingChatScopeNonce = (chat) => {
        if (!chat || typeof chat !== 'object') return `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const existing = String(chat.__libraRuntimeScopeNonce || '').trim();
        if (existing) return existing;
        const created = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
            Object.defineProperty(chat, '__libraRuntimeScopeNonce', {
                value: created,
                writable: true,
                configurable: true,
                enumerable: false
            });
        } catch {
            chat.__libraRuntimeScopeNonce = created;
        }
        return created;
    };
    const PersonaScopeIdentity = (() => {
        const snapshots = new WeakMap();
        const firstId = (...values) => values.map(value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '').find(Boolean) || '';
        const ids = (char, chat) => ({
            characterId: firstId(char?.id, char?._id, char?.uid, char?.uuid, char?.key, char?.chaId),
            chatId: firstId(chat?.id, chat?._id, chat?.uid, chat?.uuid, chat?.key, chat?.chatId)
        });
        const bindingHint = (chat = null, char = null) => {
            for (const value of [chat?.bindedPersona, chat?.boundPersonaId, chat?.boundPersona, chat?.personaId, chat?.persona, char?.bindedPersona]) {
                if (value == null || (typeof value === 'string' && !value.trim())) continue;
                if (typeof value !== 'string') return { explicit: true, invalid: true, id: '' };
                return { explicit: true, invalid: false, id: value.trim() };
            }
            return { explicit: false, invalid: false, id: '' };
        };
        const snapshotProof = (char, chat) => {
            const proof = chat && typeof chat === 'object' ? snapshots.get(chat) : null;
            const actual = ids(char, chat);
            return proof && proof.characterId === actual.characterId && proof.chatId === actual.chatId ? proof : null;
        };
        const chatProof = chat => {
            const proof = chat && typeof chat === 'object' ? snapshots.get(chat) : null;
            return proof && proof.chatId === ids(null, chat).chatId ? proof : null;
        };
        const get = (char, chat) => {
            const hint = bindingHint(chat, char), actual = ids(char, chat);
            if (hint.invalid || !actual.characterId || !actual.chatId) return null;
            const captured = snapshotProof(char, chat);
            return hint.explicit ? { ...actual, personaId: hint.id, source: 'explicit_binding',
                resetGeneration: captured?.personaId === hint.id ? captured.resetGeneration : 0 } : captured;
        };
        const remember = (char, chat, personaId, source, resetGeneration = 0) => {
            const actual = ids(char, chat);
            if (!chat || typeof chat !== 'object' || !actual.characterId || !actual.chatId || !personaId) return null;
            const proof = Object.freeze({ ...actual, personaId: String(personaId), source: String(source || ''), resetGeneration });
            snapshots.set(chat, proof);
            return proof;
        };
        const suffix = (char, chat) => {
            const proof = get(char, chat);
            return proof ? `::persona:${encodeURIComponent(proof.personaId)}` : '';
        };
        return Object.freeze({ ids, bindingHint, snapshotProof, chatProof, get, remember, suffix });
    })();
    const getLegacyChatRuntimeScopeKey = (chat, char = null) => {
        const explicitChatId = String(chat?.id || '').trim();
        const chatId = explicitChatId || String(getOrCreatePendingChatScopeNonce(chat));
        const charId = String(char?.id || char?.chaId || '');
        const page = String(char?.chatPage ?? chat?.chatPage ?? '');
        const sectionHints = collectSectionScopeHints(chat).join('|');
        const headSignature = explicitChatId ? '' : getChatHeadScopeSignature(chat);
        return [charId, page, chatId, sectionHints, headSignature].join('::');
    };
    const getChatRuntimeScopeKey = (chat, char = null) => {
        const proof = PersonaScopeIdentity.get(char, chat);
        const targetIndex = proof && Array.isArray(char?.chats)
            ? char.chats.findIndex(entry => PersonaScopeIdentity.ids(char, entry).chatId === proof.chatId) : -1;
        const runtime = proof
            ? getLegacyChatRuntimeScopeKey({ ...chat, id: proof.chatId }, { ...char, id: proof.characterId,
                chatPage: targetIndex >= 0 ? targetIndex : char?.chatPage })
            : getLegacyChatRuntimeScopeKey(chat, char);
        return runtime + PersonaScopeIdentity.suffix(char, chat);
    };
    const getStableChatScopeKey = (chat, char = null) => {
        const proof = PersonaScopeIdentity.get(char, chat);
        const charId = String(proof?.characterId || char?.id || char?.chaId || '').trim();
        const chatId = String(proof?.chatId || chat?.id || '').trim();
        if (charId && chatId) return `character:${charId}::chat:${chatId}` + PersonaScopeIdentity.suffix(char, chat);
        return getChatRuntimeScopeKey(chat, char);
    };
    const normalizeKnowledgeText = (value) => String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,.;:!?()\[\]{}"'`~\-]+|[\s,.;:!?()\[\]{}"'`~\-]+$/g, '')
        .trim()
        .toLowerCase();
    function dedupeTextArray(items) {
        const out = [];
        const seen = new Set();
        for (const item of (Array.isArray(items) ? items : [])) {
            const raw = String(item || '').trim();
            if (!raw) continue;
            const key = normalizeKnowledgeText(raw);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(raw);
        }
        return out;
    }
    const normalizeDelimitedList = (value) => dedupeTextArray(String(value || '')
        .split(/\s*[;,]\s*|\s+\|\s+/)
        .map(item => String(item || '').trim())
        .filter(Boolean));
    const pickLatestExplicitField = (value, patterns = []) => {
        const text = String(value || '').trim();
        if (!text) return '';
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (!match) continue;
            const picked = String(match[1] || '').trim().replace(/[.;,\s]+$/g, '').trim();
            if (picked) return picked;
        }
        return '';
    };
    const stripLabeledFragments = (text, patterns = []) => {
        let next = String(text || '');
        for (const pattern of patterns) {
            next = next.replace(pattern, ' ');
        }
        return next.replace(/\s{2,}/g, ' ').replace(/\s+([,;:.])/g, '$1').trim();
    };
    function splitImportedWorldRuleFragments(value) {
        const raw = String(value || '')
            .replace(/\r/g, '\n')
            .replace(/\.\s*,\s*/g, '.\n')
            .replace(/[;；]+/g, '\n')
            .replace(/,\s+(?=[A-Z가-힣])/g, '\n')
            .replace(/\.\s+(?=[A-Z가-힣])/g, '.\n')
            .replace(/\n{2,}/g, '\n');
        return raw
            .split('\n')
            .map(line => String(line || '').replace(/^[\s\-*•·▶▷☞]+/, '').trim())
            .map(line => line.replace(/^[0-9]+[.)]\s*/, '').trim())
            .filter(Boolean);
    }
    const isStructuralWorldScalar = (text) => /^(normal|low|high|linear|nonlinear|non-linear|three_dimensional|two_dimensional|four_dimensional)$/i.test(String(text || '').trim());
    const isDefaultWorldGravity = (text) => /^normal$/i.test(String(text || '').trim());
    const isDefaultWorldTimeFlow = (text) => /^linear$/i.test(String(text || '').trim());
    const isDefaultWorldSpace = (text) => /^three_dimensional$/i.test(String(text || '').trim());
    function normalizeWorldCustomRules(custom) {
        if (Array.isArray(custom)) {
            return Object.fromEntries(
                custom
                    .map((value, index) => [`rule_${index + 1}`, String(value || '').trim()])
                    .filter(([, value]) => value)
            );
        }
        if (typeof custom === 'string') {
            const trimmed = custom.trim();
            return trimmed ? { rule_1: trimmed } : {};
        }
        if (custom && typeof custom === 'object') {
            return Object.fromEntries(
                Object.entries(custom)
                    .map(([key, value]) => {
                        if (value == null) return [String(key || '').trim(), ''];
                        if (typeof value === 'string') return [String(key || '').trim(), value.trim()];
                        if (typeof value === 'number' || typeof value === 'boolean') return [String(key || '').trim(), String(value)];
                        return [String(key || '').trim(), JSON.stringify(value)];
                    })
                    .filter(([key, value]) => key && value)
            );
        }
        return {};
    }
    const WORLD_CANON_EMPTY_FRAGMENT_RE = /^(?:unknown|unk|n\/a|na|none|null|undefined|미상|불명|알 수 없음|알수없음)$/i;
    const isDiscardableWorldCanonFragment = (text) => {
        const raw = String(text || '').trim();
        if (!raw) return true;
        if (WORLD_CANON_EMPTY_FRAGMENT_RE.test(raw)) return true;
        if (isStructuralWorldScalar(raw)) return true;
        if (/^(?:current\s*)?(?:time|location|scene)\s*[:：]\s*/i.test(raw)) return true;
        if (/^(?:현재\s*)?(?:시간|위치|장면)\s*[:：]\s*/i.test(raw)) return true;
        if (/(?:인물|character).{0,24}(?:중요|암시|관계|meaning|important)/i.test(raw)) return true;
        return false;
    };
    function normalizeWorldCanonTextList(value, limit = 24) {
        const fragments = [];
        const visit = (item) => {
            if (item == null) return;
            if (Array.isArray(item)) {
                item.forEach(visit);
                return;
            }
            if (item && typeof item === 'object') {
                for (const key of ['name', 'label', 'summary', 'text', 'value', 'description']) {
                    if (item[key] != null) visit(item[key]);
                }
                return;
            }
            splitImportedWorldRuleFragments(item)
                .map(fragment => String(fragment || '').trim())
                .filter(fragment => !isDiscardableWorldCanonFragment(fragment))
                .forEach(fragment => fragments.push(fragment));
        };
        visit(value);
        return dedupeTextArray(fragments).slice(0, Math.max(1, Number(limit || 24) || 24));
    }
    function normalizeWorldSettingRules(setting = {}) {
        const source = (setting && typeof setting === 'object' && !Array.isArray(setting)) ? setting : {};
        return {
            places: normalizeWorldCanonTextList([
                source.places,
                source.locations,
                source.facilities,
                source.institutions,
                source.landmarks
            ], 24),
            organizations: normalizeWorldCanonTextList([
                source.organizations,
                source.orgs,
                source.departments,
                source.factions,
                source.powerStructure,
                source.power_structure
            ], 24),
            socialRules: normalizeWorldCanonTextList([
                source.socialRules,
                source.social_rules,
                source.culture,
                source.culturalRules,
                source.cultural_rules,
                source.customs,
                source.etiquette,
                source.taboos
            ], 32)
        };
    }
    function classifyWorldCanonStatements(values = []) {
        // LLM-authoritative world routing: only explicit field labels are routed
        // into structured buckets. Unlabelled statements stay in custom rules;
        // local code must not infer "place/org/social/phenomenon" from keywords.
        const out = { places: [], organizations: [], socialRules: [], phenomena: [], custom: [] };
        const statements = normalizeWorldCanonTextList(values, 80);
        const readExplicitWorldBucket = (statement = '') => {
            const text = String(statement || '').trim();
            const match = text.match(/^\s*(places?|locations?|facilit(?:y|ies)|장소|시설|위치|무대|공간|organizations?|orgs?|factions?|groups?|단체|조직|세력|파벌|기관|social\s*rules?|culture|customs?|taboos?|etiquette|rules?|laws?|규칙|법칙|법|문화|관습|금기|예절|phenomena?|phenomenon|anomal(?:y|ies)|현상|이상현상)\s*[:：=-]\s*(.+)$/i);
            if (!match) return { bucket: 'custom', value: text };
            const label = String(match[1] || '').toLowerCase();
            const value = String(match[2] || '').trim();
            if (!value) return { bucket: 'custom', value: text };
            if (/^(?:place|places|location|locations|facility|facilities|장소|시설|위치|무대|공간)$/i.test(label)) return { bucket: 'places', value };
            if (/^(?:organization|organizations|org|orgs|faction|factions|group|groups|단체|조직|세력|파벌|기관)$/i.test(label)) return { bucket: 'organizations', value };
            if (/^(?:phenomenon|phenomena|anomaly|anomalies|현상|이상현상)$/i.test(label)) return { bucket: 'phenomena', value };
            if (/^(?:social\s*rule|social\s*rules|culture|custom|customs|taboo|taboos|etiquette|rule|rules|law|laws|규칙|법칙|법|문화|관습|금기|예절)$/i.test(label)) return { bucket: 'socialRules', value };
            return { bucket: 'custom', value: text };
        };
        for (const statement of statements) {
            const routed = readExplicitWorldBucket(statement);
            out[routed.bucket || 'custom'].push(routed.value || statement);
        }
        return {
            places: dedupeTextArray(out.places).slice(0, 24),
            organizations: dedupeTextArray(out.organizations).slice(0, 24),
            socialRules: dedupeTextArray(out.socialRules).slice(0, 32),
            phenomena: dedupeTextArray(out.phenomena).slice(0, 24),
            custom: dedupeTextArray(out.custom).slice(0, 32)
        };
    }
    function inferWorldClassificationLabel(world = {}, sourceText = '') {
        try {
            if (typeof EntityAwareProcessor !== 'undefined' && typeof EntityAwareProcessor?.inferWorldClassificationLabel === 'function') {
                return EntityAwareProcessor.inferWorldClassificationLabel(world, sourceText);
            }
        } catch {}
        return String(world?.classification?.primary || '').trim();
    }
    function collectWorldRuleEvidenceText(world = {}, extraText = '') {
        const exists = (world?.exists && typeof world.exists === 'object' && !Array.isArray(world.exists)) ? world.exists : {};
        const systems = (world?.systems && typeof world.systems === 'object' && !Array.isArray(world.systems)) ? world.systems : {};
        const physics = (world?.physics && typeof world.physics === 'object' && !Array.isArray(world.physics)) ? world.physics : {};
        const setting = normalizeWorldSettingRules(world?.setting);
        const custom = normalizeWorldCustomRules(world?.custom);
        return [
            String(extraText || '').trim(),
            String(world?.__genreSourceText || '').trim(),
            String(world?.tech || '').trim(),
            String(world?.description || '').trim(),
            String(world?.classification?.primary || '').trim(),
            String(exists.technology || '').trim(),
            ...(Array.isArray(world?.rules) ? world.rules : []),
            ...Object.values(custom).filter(value => !isDiscardableWorldCanonFragment(value)),
            ...setting.places,
            ...setting.organizations,
            ...setting.socialRules,
            ...(Array.isArray(exists.mythical_creatures) ? exists.mythical_creatures : []),
            ...(Array.isArray(exists.non_human_races) ? exists.non_human_races : []),
            ...(Array.isArray(physics.special_phenomena) ? physics.special_phenomena : []),
            Object.keys(systems).filter(key => systems[key]).join(' ')
        ].map(value => String(value || '').trim()).filter(Boolean).join('\n');
    }
    function buildWorldRuleMetaEntry(state = 'unknown', explicitness = 'default', emitPolicy = 'silent', evidence = []) {
        return {
            state,
            explicitness,
            emitPolicy,
            evidence: dedupeTextArray((Array.isArray(evidence) ? evidence : [evidence]).map(value => String(value || '').trim()).filter(Boolean)).slice(0, 4)
        };
    }
    function sanitizeWorldRuleUpdateForPolicy(rules = {}, sourceText = '') {
        const next = (rules && typeof rules === 'object' && !Array.isArray(rules)) ? safeClone(rules) : {};
        next.exists = (next.exists && typeof next.exists === 'object' && !Array.isArray(next.exists)) ? next.exists : {};
        next.systems = (next.systems && typeof next.systems === 'object' && !Array.isArray(next.systems)) ? next.systems : {};
        next.physics = (next.physics && typeof next.physics === 'object' && !Array.isArray(next.physics)) ? next.physics : {};
        next.setting = normalizeWorldSettingRules(next.setting);
        if (next.exists) {
            delete next.exists.currentTime;
            delete next.exists.currentLocation;
            delete next.exists.currentScene;
        }
        if (next.custom) {
            const filteredCustom = {};
            Object.values(normalizeWorldCustomRules(next.custom))
                .flatMap(value => normalizeWorldCanonTextList(value, 12))
                .forEach((value, index) => { filteredCustom[`rule_${index + 1}`] = value; });
            next.custom = filteredCustom;
        }
        if (!next.setting.places.length && !next.setting.organizations.length && !next.setting.socialRules.length) delete next.setting;
        if (next.custom && Object.keys(next.custom).length === 0) delete next.custom;
        const ruleMeta = {
            schema: 'libra.world.rule_meta.v2',
            sourcePolicy: 'llm_structured_fields_only',
            metaphysics: {},
            systems: {},
            consistencyWarnings: [],
            autoDemotions: []
        };

        for (const kind of ['magic', 'ki', 'supernatural']) {
            const value = next.exists[kind];
            if (value === true) {
                ruleMeta.metaphysics[kind] = buildWorldRuleMetaEntry('present', 'llm_structured', 'when_relevant', []);
            } else if (value === false) {
                ruleMeta.metaphysics[kind] = buildWorldRuleMetaEntry('absent', 'llm_structured', 'when_relevant', []);
            } else {
                ruleMeta.metaphysics[kind] = buildWorldRuleMetaEntry('unknown', 'none', 'silent', []);
            }
        }

        for (const key of ['leveling', 'skills', 'stats', 'classes']) {
            const value = next.systems[key];
            if (value === true) {
                ruleMeta.systems[key] = buildWorldRuleMetaEntry('present', 'llm_structured', 'when_relevant', []);
            } else if (value === false) {
                ruleMeta.systems[key] = buildWorldRuleMetaEntry('absent', 'llm_structured', 'when_relevant', []);
            } else {
                ruleMeta.systems[key] = buildWorldRuleMetaEntry('unknown', 'none', 'silent', []);
            }
        }

        next.ruleMeta = {
            ...((next.ruleMeta && typeof next.ruleMeta === 'object' && !Array.isArray(next.ruleMeta)) ? next.ruleMeta : {}),
            ...ruleMeta,
            consistencyWarnings: [],
            autoDemotions: []
        };
        return next;
    }
    function shouldEmitWorldPresentRule(rules = {}, kind = '') {
        const exists = (rules?.exists && typeof rules.exists === 'object' && !Array.isArray(rules.exists)) ? rules.exists : {};
        if (exists[kind] !== true) return false;
        const meta = rules?.ruleMeta?.metaphysics?.[kind] || {};
        if (meta.emitPolicy === 'silent') return false;
        return true;
    }
    function metaAllowsEmit(meta = {}) {
        return meta.emitPolicy && meta.emitPolicy !== 'silent' && (meta.explicitness === 'explicit' || meta.explicitness === 'user_confirmed');
    }
    function shouldEmitWorldAbsentRule(rules = {}, kind = '') {
        const exists = (rules?.exists && typeof rules.exists === 'object' && !Array.isArray(rules.exists)) ? rules.exists : {};
        if (exists[kind] !== false) return false;
        return metaAllowsEmit(rules?.ruleMeta?.metaphysics?.[kind] || {});
    }
    function shouldEmitWorldInactiveSystem(rules = {}, key = '') {
        const systems = (rules?.systems && typeof rules.systems === 'object' && !Array.isArray(rules.systems)) ? rules.systems : {};
        if (systems[key] !== false) return false;
        return metaAllowsEmit(rules?.ruleMeta?.systems?.[key] || {});
    }
    function resolveWorldTemplateKey(classificationLabel, world = {}) {
        // Deprecated compatibility shim. Genre labels are metadata only and no
        // longer expand into hardcoded world templates.
        return '';
    }
    function normalizeWorldRuleUpdate(world) {
        const normalized = {};
        const sourceText = collectWorldRuleEvidenceText(world, String(world?.__genreSourceText || '').trim());
        // Classification is stored as metadata by buildWorldMetaPayload(). It must
        // not auto-create magic/technology/system rules here.
        for (const key of ['exists', 'systems', 'physics', 'setting', 'custom']) {
            if (key === 'setting') {
                const normalizedSetting = normalizeWorldSettingRules({
                    ...(world?.setting && typeof world.setting === 'object' && !Array.isArray(world.setting) ? world.setting : {}),
                    places: [world?.setting?.places, world?.places, world?.locations, world?.facilities],
                    organizations: [world?.setting?.organizations, world?.organizations, world?.orgs, world?.factions],
                    socialRules: [world?.setting?.socialRules, world?.setting?.social_rules, world?.social_rules, world?.socialRules, world?.culture, world?.customs]
                });
                if (normalizedSetting.places.length || normalizedSetting.organizations.length || normalizedSetting.socialRules.length) {
                    normalized.setting = normalizedSetting;
                }
                continue;
            }
            if (key === 'custom') {
                const normalizedCustom = normalizeWorldCustomRules(world?.custom);
                const filteredCustom = {};
                Object.values(normalizedCustom)
                    .flatMap(value => normalizeWorldCanonTextList(value, 12))
                    .forEach((value, index) => { filteredCustom[`rule_${index + 1}`] = value; });
                if (Object.keys(filteredCustom).length > 0) {
                    normalized.custom = {
                        ...(normalized.custom || {}),
                        ...filteredCustom
                    };
                }
                continue;
            }
            if (world?.[key] && typeof world[key] === 'object' && !Array.isArray(world[key])) {
                normalized[key] = {
                    ...(normalized[key] || {}),
                    ...world[key]
                };
            }
        }
        return sanitizeWorldRuleUpdateForPolicy(normalized, sourceText);
    }
    function extractWorldRuleHighlights(rules = {}, limit = 6) {
        const normalizedRules = sanitizeWorldRuleUpdateForPolicy(rules, collectWorldRuleEvidenceText(rules));
        const exists = (normalizedRules?.exists && typeof normalizedRules.exists === 'object' && !Array.isArray(normalizedRules.exists)) ? normalizedRules.exists : {};
        const systems = (normalizedRules?.systems && typeof normalizedRules.systems === 'object' && !Array.isArray(normalizedRules.systems)) ? normalizedRules.systems : {};
        const physics = (normalizedRules?.physics && typeof normalizedRules.physics === 'object' && !Array.isArray(normalizedRules.physics)) ? normalizedRules.physics : {};
        const setting = normalizeWorldSettingRules(normalizedRules?.setting);
        const custom = normalizeWorldCustomRules(normalizedRules?.custom);
        const highlights = [];

        setting.places.forEach(value => highlights.push(`장소/시설: ${value}`));
        setting.organizations.forEach(value => highlights.push(`조직: ${value}`));
        setting.socialRules.forEach(value => highlights.push(`사회 규칙: ${value}`));

        Object.values(custom)
            .flatMap(value => splitImportedWorldRuleFragments(value))
            .map(value => String(value || '').trim())
            .filter(value => value && !isDiscardableWorldCanonFragment(value))
            .forEach(value => highlights.push(value));

        if (systems.leveling) highlights.push('레벨 시스템');
        if (systems.skills) highlights.push('스킬 시스템');
        if (systems.stats) highlights.push('스탯 시스템');
        if (systems.classes) highlights.push('직업 시스템');
        if (systems.guilds) highlights.push('길드');
        if (systems.factions) highlights.push('세력');
        if (shouldEmitWorldPresentRule(normalizedRules, 'magic')) highlights.push('마법 존재');
        if (shouldEmitWorldPresentRule(normalizedRules, 'ki')) highlights.push('기(氣) 존재');
        if (shouldEmitWorldPresentRule(normalizedRules, 'supernatural')) highlights.push('초자연 존재');
        if (Array.isArray(exists.mythical_creatures)) highlights.push(...exists.mythical_creatures.map(value => String(value || '').trim()).filter(Boolean));
        if (Array.isArray(exists.non_human_races)) highlights.push(...exists.non_human_races.map(value => String(value || '').trim()).filter(Boolean));
        if (exists.technology) highlights.push(`기술: ${String(exists.technology).trim()}`);
        if (physics.dimensionStability) highlights.push(`차원 안정성: ${String(physics.dimensionStability).trim()}`);
        if (Array.isArray(physics.special_phenomena)) {
            physics.special_phenomena
                .flatMap(value => splitImportedWorldRuleFragments(value))
                .map(value => String(value || '').trim())
                .filter(value => value && !isStructuralWorldScalar(value))
                .forEach(value => highlights.push(value));
        }
        if (shouldEmitWorldAbsentRule(normalizedRules, 'magic')) highlights.push('마법 없음');
        if (shouldEmitWorldAbsentRule(normalizedRules, 'ki')) highlights.push('기 없음');
        if (shouldEmitWorldAbsentRule(normalizedRules, 'supernatural')) highlights.push('초자연 없음');
        if (physics.gravity && !isDefaultWorldGravity(physics.gravity)) highlights.push(`중력: ${String(physics.gravity).trim()}`);
        if ((physics.time_flow || physics.timeFlow) && !isDefaultWorldTimeFlow(physics.time_flow || physics.timeFlow)) {
            highlights.push(`시간 흐름: ${String(physics.time_flow || physics.timeFlow).trim()}`);
        }
        if (physics.space && !isDefaultWorldSpace(physics.space)) highlights.push(`공간: ${String(physics.space).trim()}`);

        return dedupeTextArray(highlights.map(value => String(value || '').trim()).filter(Boolean)).slice(0, Math.max(1, Number(limit || 0)));
    }
    function buildWorldMetaPayload(world = {}, existingMeta = {}) {
        const currentMeta = (existingMeta && typeof existingMeta === 'object') ? existingMeta : {};
        const currentWorldMetadata = (currentMeta.worldMetadata && typeof currentMeta.worldMetadata === 'object')
            ? safeClone(currentMeta.worldMetadata)
            : {};
        const sourceText = String(world?.__genreSourceText || currentWorldMetadata.sourceText || '').trim();
        const classification = String(
            world?.classification?.primary
            || inferWorldClassificationLabel(world, sourceText)
            || currentMeta.classification
            || currentWorldMetadata.classification
            || ''
        ).trim();
        const customRuleSummary = Object.values(normalizeWorldCustomRules(world?.custom))
            .flatMap(value => splitImportedWorldRuleFragments(value))
            .map(value => String(value || '').trim())
            .filter(value => value && !isDiscardableWorldCanonFragment(value));
        const setting = normalizeWorldSettingRules(world?.setting);
        const rawSummaryParts = dedupeTextArray([
            String(world?.summary || '').trim(),
            String(world?.description || '').trim(),
            String(world?.tech || '').trim(),
            ...(Array.isArray(world?.rules) ? world.rules.map(item => String(item || '').trim()) : []),
            ...setting.places.map(value => `Place/Facility: ${value}`),
            ...setting.organizations.map(value => `Organization: ${value}`),
            ...setting.socialRules.map(value => `Social rule: ${value}`),
            ...customRuleSummary
        ].filter(value => !isDiscardableWorldCanonFragment(value)));
        const fallbackSummary = String(currentMeta.worldSummary || currentWorldMetadata.summary || '').trim();
        const shortSummary = String(world?.summary || currentWorldMetadata.summary || fallbackSummary || '').trim();

        return {
            classification,
            worldSummary: truncateForLLM(rawSummaryParts.join('\n') || fallbackSummary, 1200, ' ... '),
            worldMetadata: {
                ...currentWorldMetadata,
                classification,
                tech: String(world?.tech || currentWorldMetadata.tech || '').trim(),
                description: truncateForLLM(String(world?.description || currentWorldMetadata.description || '').trim(), 500, ' ... '),
                summary: truncateForLLM(shortSummary, 700, ' ... '),
                sourceText: truncateForLLM(sourceText, 1200, ' ... ')
            }
        };
    }
    function buildWorldCorrectionNote(world = {}, reasonText = '') {
        const parts = [];
        const classification = String(
            world?.classification?.primary
            || inferWorldClassificationLabel(world, String(world?.__genreSourceText || '').trim())
            || ''
        ).trim();
        if (classification) parts.push(`분류:${classification}`);
        const ruleHighlights = extractWorldRuleHighlights(normalizeWorldRuleUpdate(world), 4);
        if (ruleHighlights.length > 0) parts.push(`규칙:${ruleHighlights.join(', ')}`);
        const normalizedReason = String(reasonText || '').replace(/^Auto-corrected:\s*/i, '').replace(/^Auto-corrected$/i, '').trim();
        if (normalizedReason) parts.push(`보정:${normalizedReason}`);
        return truncateForLLM(dedupeTextArray(parts).join(' | '), 220, ' ... ');
    }
    const REVIEW_EXCERPT_MAX_CHARS = 5000;
    const truncateForLLM = (value, maxChars, marker = '\n...[TRUNCATED]...\n') => {
        const text = String(value || '');
        const limit = Math.max(0, Number(maxChars) || 0);
        if (!limit || text.length <= limit) return text;
        if (limit <= marker.length + 20) return text.slice(0, limit);
        const remain = limit - marker.length;
        const headSize = Math.ceil(remain * 0.6);
        const tailSize = Math.max(0, remain - headSize);
        return `${text.slice(0, headSize)}${marker}${tailSize > 0 ? text.slice(-tailSize) : ''}`;
    };
    const LIBRA_CANONICAL_ASSISTANT_EVIDENCE_POLICY = [
        '[Canonical Evidence Policy]',
        '- Assistant/AI output is the canonical evidence for events, locations, states, relationships, memories, world facts, and narrative progress.',
        '- User messages are request metadata only. Do not treat a requested action as something that happened unless assistant evidence depicts it.',
        '- If a user request conflicts with assistant evidence, assistant evidence wins.'
    ].join('\n');
    const getAssistantCanonicalTextFromMessage = (item) => {
        const msg = item?.msg && typeof item.msg === 'object' ? item.msg : item;
        if (!msg) return '';
        if (getMessageRoleHint(item) === 'user') return '';
        const rawText = typeof item?.text === 'string' ? item.text : Utils.getMessageText(msg);
        return String(
            Utils.getNarrativeComparableText(rawText, 'ai')
            || Utils.getMemorySourceText(rawText)
            || ''
        ).trim();
    };
    const buildAssistantCanonicalTranscript = (items, options = {}) => {
        const list = Array.isArray(items) ? items.filter(Boolean) : [];
        if (list.length === 0) return '';
        const maxChars = Math.max(0, Number(options.maxChars || REVIEW_EXCERPT_MAX_CHARS) || REVIEW_EXCERPT_MAX_CHARS);
        const perItemChars = Math.max(200, Number(options.perItemChars || 2400) || 2400);
        const includeTurn = options.includeTurn !== false;
        const turnByIndex = Array.isArray(options.turnByIndex) ? options.turnByIndex : [];
        const baseTurn = normalizeLegacyMemoryTurnAnchor(options.baseTurn || 0) || 1;
        const startIndex = Math.max(0, Number(options.startIndex || 0) || 0);
        const safeMaxTurn = normalizeLegacyMemoryTurnAnchor(options.maxTurn || 0) || 0;
        const blocks = [];
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            const text = getAssistantCanonicalTextFromMessage(item);
            if (!text) continue;
            const mappedTurn = normalizeLegacyMemoryTurnAnchor(turnByIndex[i] || 0);
            const rawTurn = mappedTurn || normalizeLegacyMemoryTurnAnchor(item?.turn || 0) || (baseTurn + startIndex + i);
            const turn = safeMaxTurn ? Math.min(rawTurn, safeMaxTurn) : rawTurn;
            blocks.push([
                includeTurn ? `[Turn ${turn}]` : '',
                `[Assistant]\n${truncateForLLM(text, perItemChars, '\n...[TRUNCATED]...\n')}`
            ].filter(Boolean).join('\n'));
        }
        return truncateForLLM(blocks.join('\n\n'), maxChars, '\n...[TRUNCATED CANONICAL ASSISTANT EVIDENCE]...\n');
    };
        // ══════════════════════════════════════════════════════════════
    // [UTILITY] State Management
    // ══════════════════════════════════════════════════════════════
