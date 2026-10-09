    // ══════════════════════════════════════════════════════════════
    // [MANAGER] World Additional / World Changer Layer
    // Active intervention layer: scene intervention, world delta, and character addition.
    // ══════════════════════════════════════════════════════════════
    const clipCustomDirectiveText = (value = '', max = 6000) => truncateForLLM(String(value || '').trim(), max, ' ... ');
    // Retired compatibility fields. User-authored additions now enter through the
    // User DLC / World Additional records, where they can be inspected and toggled.
    const getWorldCanonCustomText = () => '';
    const hasWorldCanonCustomMandate = () => false;
    const getWorldAdditionalCustomText = () => '';
    const hasWorldAdditionalCustomMandate = () => false;

    const WorldAdditionalCore = (() => {
        const ADDITIONAL_COMMENT = 'lmai_world_additional';
        const ADDITIONAL_SCHEMA = 'libra.world_additional.v1';
        const VALID_TYPES = ['scene_intervention', 'world_delta', 'character_addition'];
        const VALID_STATUSES = ['prepared', 'armed', 'injected', 'manifested', 'integrated', 'retired', 'blocked'];
        const VALID_FORCE = ['soft', 'firm', 'hard'];
        const VALID_IMPACT = ['none', 'ambient', 'soft', 'direct', 'major'];
        const TYPE_ALIASES = Object.freeze({
            scene: 'scene_intervention',
            sceneintervention: 'scene_intervention',
            scene_intervention: 'scene_intervention',
            intervention: 'scene_intervention',
            forced_scene: 'scene_intervention',
            world: 'world_delta',
            worlddelta: 'world_delta',
            world_delta: 'world_delta',
            delta: 'world_delta',
            world_addition: 'world_delta',
            character: 'character_addition',
            characteraddition: 'character_addition',
            character_addition: 'character_addition',
            additional_character: 'character_addition',
            person: 'character_addition',
            npc: 'character_addition'
        });
        const STATUS_ALIASES = Object.freeze({
            active: 'armed',
            candidate: 'armed',
            draft: 'prepared',
            planned: 'prepared',
            used: 'manifested',
            appeared: 'manifested',
            canonized: 'integrated',
            canonised: 'integrated',
            rejected: 'blocked',
            disabled: 'blocked'
        });
        const FORCE_ALIASES = Object.freeze({
            light: 'soft',
            subtle: 'soft',
            optional: 'soft',
            standard: 'firm',
            active: 'firm',
            strong: 'hard',
            absolute: 'hard',
            forced: 'hard'
        });
        const VALID_PROGRESSION_TIERS = ['ambient', 'local', 'section', 'arc', 'climax', 'final'];
        const PROGRESSION_RANK = Object.freeze({ ambient: 0, local: 1, section: 2, arc: 3, climax: 4, final: 5 });
        const PROGRESSION_ALIASES = Object.freeze({
            background: 'ambient',
            minor: 'local',
            local_helper: 'local',
            current_section: 'section',
            chapter: 'section',
            arc_mid: 'arc',
            major: 'arc',
            boss: 'climax',
            final_boss: 'final',
            endgame: 'final',
            ultimate: 'final'
        });

        const defaultSettings = () => ({
            defaultForceLevel: 'firm',
            maxSceneInterventionsPerTurn: 1,
            maxWorldDeltasPerTurn: 1,
            maxCharacterAdditionsPerScene: 1,
            autoIntegrateManifested: true
        });
        const defaultState = () => ({
            schema: ADDITIONAL_SCHEMA,
            version: 1,
            scopeKey: '',
            chatId: '',
            sceneInterventions: [],
            worldDeltas: [],
            characterAdditions: [],
            worldCodex: [],
            activeDirectives: [],
            manifestationLog: [],
            deletedItemKeys: [],
            lastInjectedIds: [],
            lastTurn: 0,
            lastUpdated: 0,
            settings: defaultSettings()
        });

        let additionalState = defaultState();

        const debugWorldAdditional = (event = '', data = {}, meta = {}) => {
            try {
                if (MemoryEngine?.CONFIG?.debug !== true) return;
                const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data };
                const stage = String(event || 'event').trim() || 'event';
                const turn = Number(payload.turn || meta.turn || MemoryEngine?.getCurrentTurn?.() || MemoryState?.currentTurn || 0) || 0;
                recordRuntimeDebug('debug', { event: stage, ...payload }, {
                    __libraDebugMeta: true,
                    label: `world_additional_${stage}`,
                    stage,
                    turn,
                    scopeKey: meta.scopeKey || additionalState.scopeKey || MemoryState?._activeScopeKey || '',
                    chatId: meta.chatId || additionalState.chatId || MemoryState?._activeChatId || ''
                });
            } catch (_) {}
        };
        const clip = (value = '', max = 260) => truncateForLLM(String(value || '').replace(/\s+/g, ' ').trim(), max, ' ... ');
        const normalizeKey = (value = '') => String(value || '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^a-z0-9\u3131-\u318e\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9fff]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const arrayOfText = (items = [], limit = 8, max = 180) => dedupeTextArray(
            (Array.isArray(items) ? items : (items ? [items] : []))
                .map(item => typeof item === 'string' ? item : (item?.text || item?.label || item?.summary || item?.name || item?.title || ''))
                .map(item => clip(item, max))
                .filter(Boolean)
        ).slice(0, Math.max(1, Number(limit || 8)));
        const compactWorldCodexFieldText = (value = '', max = 220, depth = 0) => {
            if (value == null || depth > 3) return '';
            const limit = Math.max(40, Number(max || 220));
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                return clip(value, limit);
            }
            if (Array.isArray(value)) {
                return clip(dedupeTextArray(value
                    .map(item => compactWorldCodexFieldText(item, Math.max(40, Math.min(limit, 160)), depth + 1))
                    .filter(Boolean)
                ).slice(0, 6).join(' / '), limit);
            }
            if (typeof value === 'object') {
                const preferredKeys = ['text', 'summary', 'description', 'content', 'prompt', 'note', 'label', 'name', 'title', 'primary', 'type', 'classification', 'technology', 'exists', 'systems', 'physics', 'custom', 'rules', 'locations', 'organizations', 'factions', 'history', 'timeline'];
                const preferred = dedupeTextArray(preferredKeys
                    .map(key => compactWorldCodexFieldText(value?.[key], Math.max(40, Math.min(limit, 160)), depth + 1))
                    .filter(Boolean)
                ).slice(0, 6);
                if (preferred.length > 0) return clip(preferred.join(' / '), limit);
                const entries = dedupeTextArray(Object.entries(value).slice(0, 12)
                    .map(([key, child]) => {
                        const text = compactWorldCodexFieldText(child, Math.max(40, limit - String(key).length - 2), depth + 1);
                        return text ? `${key}: ${text}` : '';
                    })
                    .filter(Boolean)
                ).slice(0, 6);
                return clip(entries.join(' / '), limit);
            }
            return '';
        };
        // ── [WORLD-CODEX] Lightweight structured world facts for prompt/RAG reuse
        const WORLD_CODEX_VALID_SUBJECTS = Object.freeze([
            'world_identity', 'world_laws', 'world_limits', 'world_geography', 'world_history', 'world_society'
        ]);
        const normalizeWorldCodexSubject = (value = '') => {
            const raw = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
            if (WORLD_CODEX_VALID_SUBJECTS.includes(raw)) return raw;
            if (/identity|summary|genre|classification/.test(raw)) return 'world_identity';
            if (/law|rule|system|magic|physics|tech|technology/.test(raw)) return 'world_laws';
            if (/limit|constraint|forbid|boundary/.test(raw)) return 'world_limits';
            if (/geo|location|place|map|region/.test(raw)) return 'world_geography';
            if (/history|timeline|event|past/.test(raw)) return 'world_history';
            if (/society|faction|organization|guild|culture|class/.test(raw)) return 'world_society';
            return 'world_laws';
        };
        const splitWorldCodexLines = (value = '', limit = 12, max = 240) => {
            const out = [];
            const visit = (item, depth = 0) => {
                if (out.length >= limit || item == null || depth > 3) return;
                if (Array.isArray(item)) {
                    for (const child of item) visit(child, depth + 1);
                    return;
                }
                if (item && typeof item === 'object') {
                    for (const key of ['text', 'summary', 'description', 'content', 'prompt', 'note', 'label', 'name', 'primary', 'type', 'classification']) {
                        if (item[key] != null) visit(item[key], depth + 1);
                    }
                    if (out.length >= limit) return;
                    for (const [key, child] of Object.entries(item).slice(0, 12)) {
                        if (['meta', 'debug', 'raw', 'content'].includes(String(key).toLowerCase())) continue;
                        const text = compactWorldCodexFieldText(child, Math.max(80, max - 40));
                        if (text) out.push(`${key}: ${text}`);
                        if (out.length >= limit) break;
                    }
                    return;
                }
                const raw = String(item || '').replace(/\r/g, '\n').trim();
                if (!raw) return;
                raw
                    .replace(/[;；]+/g, '\n')
                    .replace(/\.\s+(?=[A-Z가-힣0-9])/g, '.\n')
                    .split(/\n+/)
                    .map(line => line.replace(/^\s*[-*•·▶▷0-9.)]+\s*/, '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean)
                    .forEach(line => {
                        if (out.length < limit) out.push(truncateForLLM(line, Math.max(80, Number(max || 240)), ' ... '));
                    });
            };
            visit(value, 0);
            return dedupeTextArray(out.filter(Boolean)).slice(0, Math.max(1, Number(limit || 12)));
        };
        const buildWorldCodexId = (scope = {}, subject = '', content = '') => {
            const scopeType = String(scope?.type || 'system').trim() || 'system';
            const scopeId = String(scope?.id || 'world_main').trim() || 'world_main';
            return `wc_${stableHash(`${scopeType}:${scopeId}:${normalizeWorldCodexSubject(subject)}:${normalizeKey(content).slice(0, 260)}`).slice(0, 12)}`;
        };
        const normalizeWorldCodexItem = (item = {}, fallback = {}) => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : { content: item };
            const scope = source.scope && typeof source.scope === 'object' ? source.scope : {};
            const normalizedScope = {
                type: clip(scope.type || fallback.scopeType || 'system', 40) || 'system',
                id: clip(scope.id || fallback.scopeId || 'world_main', 80) || 'world_main'
            };
            const subject = normalizeWorldCodexSubject(source.subject || fallback.subject || 'world_laws');
            const contentLines = splitWorldCodexLines(source.content || source.text || source.summary || source.description || '', 10, 240);
            const content = contentLines.join('\n');
            if (!content) return null;
            const turn = Number(source.updatedTurn || source.createdTurn || fallback.turn || MemoryEngine?.getCurrentTurn?.() || MemoryState?.currentTurn || 0) || 0;
            const tags = dedupeTextArray(['world', 'world_codex', ...(Array.isArray(source.tags) ? source.tags : []), ...(Array.isArray(fallback.tags) ? fallback.tags : [])]
                .map(tag => clip(tag, 40))
                .filter(Boolean)
            ).slice(0, 12);
            const id = clip(source.id || buildWorldCodexId(normalizedScope, subject, content), 80);
            return {
                id,
                scope: normalizedScope,
                subject,
                content: truncateForLLM(content, 1200, '\n... '),
                confidence: clip(source.confidence || fallback.confidence || 'inferred', 40),
                visibility: clip(source.visibility || fallback.visibility || 'restricted', 40),
                tags,
                source: clip(source.source || fallback.source || 'runtime', 80),
                manualInjection: source.manualInjection === true || source.manual_injection === true,
                injectionDisabled: source.injectionDisabled === true || source.injection_disabled === true,
                createdTurn: Number(source.createdTurn || turn) || 0,
                updatedTurn: turn,
                lastUpdated: Number(source.lastUpdated || source.updatedAt || 0) || Date.now(),
                signature: stableHash(`${subject}:${normalizeKey(content).slice(0, 500)}`)
            };
        };
        const normalizeWorldCodexList = (items = [], limit = 96) => {
            const out = [];
            const seen = new Set();
            for (const item of Array.isArray(items) ? items : []) {
                const normalized = normalizeWorldCodexItem(item);
                if (!normalized) continue;
                const key = normalized.id || normalized.signature;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(normalized);
            }
            return out.slice(-Math.max(1, Number(limit || 96)));
        };
        const upsertWorldCodexItems = (items = [], options = {}) => {
            const current = normalizeWorldCodexList(additionalState.worldCodex || [], 96);
            const byId = new Map(current.map(item => [String(item.id || item.signature || ''), item]));
            let changed = false;
            const turn = Number(options.turn || MemoryEngine?.getCurrentTurn?.() || MemoryState?.currentTurn || 0) || 0;
            for (const item of Array.isArray(items) ? items : []) {
                const normalized = normalizeWorldCodexItem(item, { turn, source: options.source || 'runtime' });
                if (!normalized) continue;
                const deletedKeys = new Set(arrayOfText(additionalState.deletedItemKeys || [], 160, 180));
                if (deletedKeys.has(`codex:id:${normalized.id}`) || deletedKeys.has(`codex:sig:${normalized.signature}`)) continue;
                const key = String(normalized.id || normalized.signature || '');
                const previous = byId.get(key);
                if (!previous || previous.signature !== normalized.signature || previous.content !== normalized.content) {
                    byId.set(key, {
                        ...(previous || {}), ...normalized,
                        manualInjection: previous?.manualInjection === true || normalized.manualInjection === true,
                        injectionDisabled: previous?.injectionDisabled === true,
                        createdTurn: previous?.createdTurn || normalized.createdTurn,
                        lastUpdated: Date.now()
                    });
                    changed = true;
                }
            }
            if (changed) {
                additionalState.worldCodex = Array.from(byId.values())
                    .sort((a, b) => Number(a.lastUpdated || 0) - Number(b.lastUpdated || 0))
                    .slice(-96);
                additionalState.lastUpdated = Date.now();
                debugWorldAdditional('world_codex_upsert', {
                    turn,
                    addedOrUpdated: (Array.isArray(items) ? items : []).length,
                    worldCodex: additionalState.worldCodex.length,
                    source: options.source || 'runtime'
                });
            }
            return { changed, items: additionalState.worldCodex || [] };
        };
        const extractCurrentWorldNodeForCodex = () => {
            try {
                const profile = HierarchicalWorldManager?.getProfile?.() || {};
                const activePath = Array.isArray(profile?.activePath) ? profile.activePath : [];
                const nodeId = String(activePath[activePath.length - 1] || profile.rootId || 'world_main').trim() || 'world_main';
                const nodes = profile?.nodes;
                if (nodes instanceof Map && nodes.has(nodeId)) return nodes.get(nodeId) || {};
                if (nodes && typeof nodes === 'object') return nodes[nodeId] || {};
                return { id: nodeId };
            } catch (_) {
                return { id: 'world_main' };
            }
        };
        const collectWorldCodexRuntimeFacts = (ctx = {}) => {
            const facts = [];
            const rules = (() => { try { return HierarchicalWorldManager?.getCurrentRules?.() || {}; } catch (_) { return {}; } })();
            const profile = (() => { try { return HierarchicalWorldManager?.getProfile?.() || {}; } catch (_) { return {}; } })();
            const node = extractCurrentWorldNodeForCodex();
            const scopeId = clip(node?.id || profile?.rootId || 'world_main', 80) || 'world_main';
            const turn = Number(ctx.turn || MemoryEngine?.getCurrentTurn?.() || MemoryState?.currentTurn || 0) || 0;
            const push = (subject, lines, tags = [], confidence = 'inferred') => {
                const content = splitWorldCodexLines(lines, 10, 260).join('\n');
                if (!content) return;
                facts.push({
                    scope: { type: subject === 'world_geography' ? 'location' : 'system', id: scopeId },
                    subject,
                    content,
                    confidence,
                    visibility: 'restricted',
                    tags: ['world_codex', ...tags],
                    source: 'runtime_world_codex',
                    createdTurn: turn,
                    updatedTurn: turn
                });
            };
            const classification = compactWorldCodexFieldText(rules?.classification?.primary || rules?.classification || profile?.classification?.primary || ctx.classification || '', 160);
            const existsText = compactWorldCodexFieldText(rules?.exists || '', 420);
            const systemsText = compactWorldCodexFieldText(rules?.systems || '', 420);
            const physicsText = compactWorldCodexFieldText(rules?.physics || '', 420);
            const customRulesText = compactWorldCodexFieldText(rules?.custom || '', 520);
            push('world_identity', [
                classification ? `세계 유형: ${classification}` : '',
                node?.name ? `활성 세계 노드: ${node.name}` : '',
                profile?.rootId ? `세계 루트: ${profile.rootId}` : '',
                ctx.worldSummary || ctx.sectionWorldSummary || ''
            ].filter(Boolean), ['identity', 'world_rule']);
            push('world_laws', [
                existsText ? `존재/비존재 체계: ${existsText}` : '',
                systemsText ? `시스템/사회 체계: ${systemsText}` : '',
                physicsText ? `물리/시간/공간 법칙: ${physicsText}` : '',
                customRulesText ? `사용자/추가 규칙: ${customRulesText}` : ''
            ].filter(Boolean), ['law', 'world_rule']);
            push('world_limits', [
                rules?.limits || rules?.limitingRules || rules?.custom?.limitingRules || rules?.custom?.limiting_rules || '',
                ctx.referenceSafetyPrompt || '',
                ctx.secrecyGuardPrompt || ''
            ].filter(Boolean), ['limit', 'guardrail']);
            push('world_geography', [
                rules?.geography || rules?.locations || rules?.setting?.locations || rules?.custom?.geographyHints || rules?.custom?.geography_hints || '',
                ctx.worldStatePrompt || ''
            ].filter(Boolean), ['location']);
            push('world_society', [
                rules?.society || rules?.organizations || rules?.factions || rules?.setting?.organizations || rules?.custom?.societyHints || rules?.custom?.society_hints || ''
            ].filter(Boolean), ['society', 'organization']);
            push('world_history', [
                rules?.history || rules?.timeline || rules?.custom?.historyHints || rules?.custom?.history_hints || '',
                ctx.narrativePrompt || ''
            ].filter(Boolean), ['history']);
            return facts;
        };
        const refreshWorldCodexFromContext = (ctx = {}, config = MemoryEngine.CONFIG) => {
            if (config?.worldAdditionalEnabled === false) return { changed: false, items: additionalState.worldCodex || [], skipped: true };
            const facts = collectWorldCodexRuntimeFacts(ctx);
            return upsertWorldCodexItems(facts, { turn: ctx.turn, source: 'runtime_world_codex' });
        };
        const formatWorldCodexForPrompt = (maxChars = 900, options = {}) => {
            const uniqueAgainst = normalizeKey(String(options?.uniqueAgainst || options?.alreadyInjectedText || '').slice(0, 24000));
            const maxItems = Math.max(2, Math.min(12, Number(options?.maxItems || 8) || 8));
            const isDuplicateAgainstExisting = (item = {}) => {
                if (!uniqueAgainst) return false;
                const contentKey = normalizeKey(String(item?.content || '').replace(/\n+/g, ' '));
                if (!contentKey || contentKey.length < 28) return false;
                if (uniqueAgainst.includes(contentKey.slice(0, Math.min(220, contentKey.length)))) return true;
                const tokens = contentKey.split(/\s+/).filter(token => token.length >= 3).slice(0, 18);
                if (tokens.length < 5) return false;
                const hits = tokens.filter(token => uniqueAgainst.includes(token)).length;
                return hits >= Math.max(5, Math.ceil(tokens.length * 0.82));
            };
            const items = normalizeWorldCodexList(additionalState.worldCodex || [], 96)
                .sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0))
                .filter(item => item.injectionDisabled !== true)
                .sort((a, b) => Number(b.manualInjection === true) - Number(a.manualInjection === true))
                .filter(item => !isDuplicateAgainstExisting(item))
                .slice(0, Math.max(maxItems, normalizeWorldCodexList(additionalState.worldCodex || [], 96).filter(item => item.manualInjection === true && item.injectionDisabled !== true).length));
            if (!items.length) return '';
            const grouped = new Map();
            for (const item of items) {
                const subject = normalizeWorldCodexSubject(item.subject || 'world_laws');
                if (!grouped.has(subject)) grouped.set(subject, []);
                grouped.get(subject).push(item);
            }
            const lines = [
                '[LIBRA WORLD CODEX / 구조화 세계 정본]',
                'Compact non-duplicate world facts and constraints. Do not quote IDs.'
            ];
            for (const [subject, list] of grouped.entries()) {
                lines.push(`\n## ${subject}`);
                list.slice(0, Math.max(3, list.filter(item => item.manualInjection === true).length)).forEach((item) => {
                    lines.push(`- ${truncateForLLM(String(item.content || '').replace(/\n+/g, ' / '), 300, ' ... ')}${item.confidence ? ` (${item.confidence})` : ''}`);
                });
            }
            return truncateForLLM(lines.join('\n'), Math.max(420, Number(maxChars || 900)), '\n...[world codex clipped]...\n');
        };

        const normalizeType = (value = '', fallback = '') => {
            const raw = String(value || fallback || '').trim().toLowerCase();
            const compact = raw.replace(/[^a-z0-9_]+/g, '').replace(/-/g, '_');
            return TYPE_ALIASES[raw] || TYPE_ALIASES[compact] || (VALID_TYPES.includes(raw) ? raw : (VALID_TYPES.includes(fallback) ? fallback : 'world_delta'));
        };
        const normalizeStatus = (value = 'prepared') => {
            const raw = String(value || 'prepared').trim().toLowerCase();
            const compact = raw.replace(/[^a-z0-9_]+/g, '');
            const status = STATUS_ALIASES[raw] || STATUS_ALIASES[compact] || raw;
            return VALID_STATUSES.includes(status) ? status : 'prepared';
        };
        const normalizeForce = (value = '', fallback = 'firm') => {
            const raw = String(value || fallback || 'firm').trim().toLowerCase();
            const compact = raw.replace(/[^a-z0-9_]+/g, '');
            const force = FORCE_ALIASES[raw] || FORCE_ALIASES[compact] || raw;
            return VALID_FORCE.includes(force) ? force : 'firm';
        };
        const normalizeImpact = (value = '', fallback = 'soft') => {
            const raw = String(value || fallback || 'soft').trim().toLowerCase();
            return VALID_IMPACT.includes(raw) ? raw : 'soft';
        };
        const normalizeProgressionTier = (value = '', fallback = 'local') => {
            const raw = String(value || fallback || 'local').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
            const tier = PROGRESSION_ALIASES[raw] || raw;
            return VALID_PROGRESSION_TIERS.includes(tier) ? tier : 'local';
        };
        const directiveBucketKey = (type = '') => {
            const normalized = normalizeType(type);
            if (normalized === 'scene_intervention') return 'sceneInterventions';
            if (normalized === 'character_addition') return 'characterAdditions';
            return 'worldDeltas';
        };
        const directiveTypeLabel = (type = '') => {
            const normalized = normalizeType(type);
            if (normalized === 'scene_intervention') return 'Scene Intervention';
            if (normalized === 'character_addition') return 'Character Addition';
            return 'World Delta';
        };
        // ── 사용자 가시성: 거부 사유·상태 라벨 ──────────────────────────
        // selectForPrompt 는 후보 수·버킷 통계·거부 사유를 계산하지만 종전에는
        // debugWorldAdditional() 로만 흘려보내 GUI 에 닿지 않았다. 그래서
        // 사용자는 "이 요소가 왜 안 들어갔는지" 알 수 없었다. 아래 두 표는
        // 그 계산 결과를 사용자가 읽을 수 있는 문장으로 바꾼다.
        const REJECT_REASON_LABELS = Object.freeze({
            user_injection_disabled: '사용자가 투입을 껐음',
            status_retired: '은퇴한 항목',
            status_blocked: '차단된 항목',
            scene_already_manifested: '이미 발현된 1회성 개입',
            progression_mismatch: '진행 단계 불일치 (아직 이르거나 이미 지남)',
            character_without_grounding: '인물 근거 부족 (등장 조건·연관 대상 없음)',
            character_name_already_known: '인물이 이미 등장함',
            context_mismatch: '현재 장면과 관련 없음',
            bucket_limit: '유형별 한도 초과',
            total_limit: '요청당 최대 투입 수 초과',
            unknown: '사유 미상'
        });
        const getRejectReasonLabel = (reason = '') => {
            const key = String(reason || '').trim();
            if (REJECT_REASON_LABELS[key]) return REJECT_REASON_LABELS[key];
            // 정규화된 상태 거부(status_xxx)와 예상 밖 코드를 안전하게 표시한다.
            const statusMatch = /^status_(.+)$/.exec(key);
            if (statusMatch) return `상태 거부: ${statusMatch[1]}`;
            return key ? `기타 (${key})` : REJECT_REASON_LABELS.unknown;
        };
        // 상태 라벨: injected 는 "투입됐지만 작품에 아직 안 쓰임"을 뜻한다.
        // 이 구분이 없으면 사용자는 요소가 왜 안 나오는지 알 수 없다.
        const STATUS_LABELS = Object.freeze({
            prepared: '준비됨',
            armed: '대기 중',
            injected: '주입됨 (아직 작품에 안 쓰임)',
            manifested: '등장함',
            integrated: '정착함 (작품에 반영됨)',
            retired: '은퇴함',
            blocked: '차단됨'
        });
        const getStatusLabel = (status = '') => {
            const key = normalizeStatus(status || 'prepared');
            return STATUS_LABELS[key] || STATUS_LABELS.prepared;
        };
        // selectForPrompt 의 판정 결과를 GUI 가 읽을 수 있도록 남긴다.
        let lastSelectionDiagnostics = null;
        const getSelectionDiagnostics = () => (lastSelectionDiagnostics
            ? {
                turn: lastSelectionDiagnostics.turn,
                selectedIds: [...(lastSelectionDiagnostics.selectedIds || [])],
                rejected: (lastSelectionDiagnostics.rejected || []).map(entry => ({ ...entry })),
                bucketStats: (lastSelectionDiagnostics.bucketStats || []).map(entry => ({ ...entry })),
                totalLimit: lastSelectionDiagnostics.totalLimit,
                updatedAt: lastSelectionDiagnostics.updatedAt
            }
            : null);
        const collectKnownActorNames = (ctx = {}) => dedupeTextArray([
            ...(Array.isArray(ctx.knownActorNames) ? ctx.knownActorNames : []),
            ...(Array.isArray(ctx.canonActorNames) ? ctx.canonActorNames : []),
            ...(Array.isArray(ctx.loreActorNames) ? ctx.loreActorNames : []),
            ...(Array.isArray(ctx.focusCharacters) ? ctx.focusCharacters : [])
        ]
            .map(item => typeof item === 'string' ? item : (item?.name || item?.title || item?.key || item?.label || ''))
            .map(item => clip(item, 80))
            .filter(Boolean)
        ).slice(0, 80);
        const buildDirectiveId = (type = 'world_delta', title = '', description = '') => {
            const seed = `${normalizeType(type)}|${normalizeKey(title)}|${normalizeKey(description).slice(0, 120)}`;
            return `wa_${normalizeType(type).replace(/[^a-z]+/g, '').slice(0, 3) || 'wld'}_${stableHash(seed).slice(0, 10)}`;
        };
        const summarizeDirectiveForDebug = (directive = {}) => ({
            id: clip(directive?.id || '', 80),
            type: normalizeType(directive?.type || ''),
            bucket: directiveBucketKey(directive?.type || ''),
            title: clip(directive?.title || directive?.name || '', 140),
            name: clip(directive?.name || '', 100),
            status: normalizeStatus(directive?.status || 'prepared'),
            forceLevel: normalizeForce(directive?.forceLevel || ''),
            userImpact: normalizeImpact(directive?.userImpact || 'soft'),
            progressionTier: normalizeProgressionTier(directive?.progressionTier || ''),
            repeatable: directive?.repeatable === true,
            createdTurn: Number(directive?.createdTurn || 0) || 0,
            injectedTurn: Number(directive?.injectedTurn || 0) || 0,
            manifestedTurn: Number(directive?.manifestedTurn || 0) || 0,
            integratedTurn: Number(directive?.integratedTurn || 0) || 0,
            hasActivation: Boolean(String(directive?.activationCondition || '').trim()),
            hasSourceBasis: Boolean(Array.isArray(directive?.sourceBasis) && directive.sourceBasis.length),
            relatedEntities: arrayOfText(directive?.relatedEntities || [], 6, 80),
            activationCondition: clip(directive?.activationCondition || '', 160),
            description: clip(directive?.description || '', 180),
            directive: clip(directive?.directive || '', 180)
        });
        const normalizeDirective = (item = null, fallbackType = '') => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
            const type = normalizeType(item.type || item.kind || item.category || fallbackType, fallbackType);
            const title = clip(item.title || item.name || item.label || item.summary || '', type === 'character_addition' ? 120 : 150);
            const description = clip(item.description || item.detail || item.worldFact || item.world_fact || item.sceneEffect || item.scene_effect || item.personalitySeed || item.personality_seed || item.summary || '', 520);
            const directive = clip(item.directive || item.instruction || item.mustDo || item.must_do || item.effect || item.narrativeUse || item.narrative_use || '', 520);
            const purpose = clip(item.purpose || item.function || item.role || item.reason || '', 260);
            const sourceBasis = arrayOfText(item.sourceBasis || item.source_basis || item.canonBasis || item.canon_basis || item.grounding || item.groundingEvidence || item.grounding_evidence || [], 6, 180);
            const reusedCanonEntity = clip(item.reusedCanonEntity || item.reused_canon_entity || item.existingEntity || item.existing_entity || item.canonActor || item.canon_actor || '', 120);
            const noveltyReason = clip(item.noveltyReason || item.novelty_reason || item.newCharacterReason || item.new_character_reason || item.whyNew || item.why_new || '', 260);
            const noveltyScope = clip(item.noveltyScope || item.novelty_scope || item.characterNovelty || item.character_novelty || '', 80);
            const customSource = clip(item.customSource || item.custom_source || item.worldCustomSource || item.world_custom_source || '', 160);
            const progressionTier = normalizeProgressionTier(item.progressionTier || item.progression_tier || item.storyTier || item.story_tier || item.narrativeTier || item.narrative_tier || '', type === 'character_addition' ? 'local' : 'section');
            const activationCondition = clip(item.activationCondition || item.activation_condition || item.insertionCondition || item.insertion_condition || item.timing || item.firstAppearance?.timing || '', 240);
            const firstAppearance = item.firstAppearance && typeof item.firstAppearance === 'object' && !Array.isArray(item.firstAppearance)
                ? {
                    timing: clip(item.firstAppearance.timing || '', 120),
                    method: clip(item.firstAppearance.method || item.firstAppearance.description || '', 260)
                }
                : null;
            const id = clip(item.id || item.directiveId || item.directive_id || buildDirectiveId(type, title, description || directive), 80);
            const createdTurn = Number(item.createdTurn || item.created_turn || item.turn || item.sourceTurn || 0) || 0;
            const normalized = {
                id,
                type,
                title: title || (type === 'scene_intervention' ? 'Unnamed Scene Intervention' : (type === 'character_addition' ? 'Unnamed Character Addition' : 'Unnamed World Delta')),
                name: type === 'character_addition' ? clip(item.name || title || '', 120) : '',
                role: clip(item.role || item.function || '', 160),
                description,
                directive,
                purpose,
                sourceBasis,
                reusedCanonEntity,
                noveltyReason,
                noveltyScope,
                customSource,
                progressionTier,
                activationCondition,
                firstAppearance,
                forceLevel: normalizeForce(item.forceLevel || item.force_level || item.force || item.intensity, additionalState.settings?.defaultForceLevel || 'firm'),
                userImpact: normalizeImpact(item.userImpact || item.user_impact || item.impact || 'soft'),
                constraints: arrayOfText(item.constraints || item.guardrails || item.safety || [], 8, 180),
                anchors: arrayOfText(item.anchors || item.relatedAnchors || item.related_anchors || [], 8, 120),
                relatedEntities: arrayOfText(item.relatedEntities || item.related_entities || item.entities || item.focusCharacters || [], 8, 80),
                relatedWorldRules: arrayOfText(item.relatedWorldRules || item.related_world_rules || item.rules || [], 6, 160),
                revealDebt: clip(item.revealDebt || item.reveal_debt || item.expectedReveal || item.expected_reveal || '', 260),
                repeatable: item.repeatable === true,
                manualInjection: item.manualInjection === true || item.manual_injection === true,
                injectionDisabled: item.injectionDisabled === true || item.injection_disabled === true,
                status: normalizeStatus(item.status || (item.active === true ? 'armed' : 'prepared')),
                createdTurn,
                injectedTurn: Number(item.injectedTurn || item.injected_turn || 0) || 0,
                manifestedTurn: Number(item.manifestedTurn || item.manifested_turn || 0) || 0,
                integratedTurn: Number(item.integratedTurn || item.integrated_turn || 0) || 0,
                mergedFromIds: arrayOfText(item.mergedFromIds || item.merged_from_ids || [], 24, 80),
                lastUpdated: Number(item.lastUpdated || item.updatedAt || 0) || Date.now()
            };
            if (!normalized.description && !normalized.directive && !normalized.purpose) return null;
            if (normalized.status === 'prepared' && item.arm === true) normalized.status = 'armed';
            return normalized;
        };
        const normalizeList = (items = [], fallbackType = '', limit = 48) => {
            const out = [];
            const seen = new Set();
            for (const item of Array.isArray(items) ? items : []) {
                const normalized = normalizeDirective(item, fallbackType);
                if (!normalized) continue;
                const key = normalized.id || buildDirectiveId(normalized.type, normalized.title, normalized.description);
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(normalized);
            }
            return out.slice(-Math.max(1, Number(limit || 48)));
        };
        const normalizeSettings = (settings = {}) => ({
            ...defaultSettings(),
            ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}),
            defaultForceLevel: normalizeForce(settings?.defaultForceLevel || settings?.default_force_level || 'firm'),
            maxSceneInterventionsPerTurn: Math.max(0, Math.min(3, Math.floor(Number(settings?.maxSceneInterventionsPerTurn ?? settings?.max_scene_interventions_per_turn ?? 1) || 1))),
            maxWorldDeltasPerTurn: Math.max(0, Math.min(3, Math.floor(Number(settings?.maxWorldDeltasPerTurn ?? settings?.max_world_deltas_per_turn ?? 1) || 1))),
            maxCharacterAdditionsPerScene: Math.max(0, Math.min(3, Math.floor(Number(settings?.maxCharacterAdditionsPerScene ?? settings?.max_character_additions_per_scene ?? 1) || 1))),
            autoIntegrateManifested: settings?.autoIntegrateManifested !== false && settings?.auto_integrate_manifested !== false
        });
        const normalizeState = (state = null, meta = {}) => {
            const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
            return {
                ...defaultState(),
                schema: ADDITIONAL_SCHEMA,
                version: 1,
                scopeKey: clip(meta.scopeKey || source.scopeKey || '', 140),
                chatId: clip(meta.chatId || source.chatId || '', 140),
                sceneInterventions: normalizeList(source.sceneInterventions || source.scene_interventions || [], 'scene_intervention', 40),
                worldDeltas: normalizeList(source.worldDeltas || source.world_deltas || [], 'world_delta', 64),
                characterAdditions: normalizeList(source.characterAdditions || source.character_additions || [], 'character_addition', 48),
                worldCodex: normalizeWorldCodexList(source.worldCodex || source.world_codex || [], 96),
                activeDirectives: normalizeList(source.activeDirectives || source.active_directives || [], '', 12),
                manifestationLog: (Array.isArray(source.manifestationLog || source.manifestation_log) ? (source.manifestationLog || source.manifestation_log) : [])
                    .map(item => ({
                        turn: Number(item?.turn || 0) || 0,
                        id: clip(item?.id || '', 80),
                        type: normalizeType(item?.type || ''),
                        title: clip(item?.title || '', 140),
                        status: normalizeStatus(item?.status || 'manifested'),
                        note: clip(item?.note || item?.notes || '', 220),
                        at: Number(item?.at || item?.time || 0) || Date.now()
                    }))
                    .filter(item => item.id || item.title)
                    .slice(-80),
                deletedItemKeys: arrayOfText(source.deletedItemKeys || source.deleted_item_keys || [], 160, 180),
                lastInjectedIds: arrayOfText(source.lastInjectedIds || source.last_injected_ids || [], 12, 80),
                lastTurn: Number(source.lastTurn || source.last_turn || 0) || 0,
                lastUpdated: Number(source.lastUpdated || source.updatedAt || 0) || 0,
                settings: normalizeSettings(source.settings || {})
            };
        };
        const loadState = (lorebook = [], meta = {}) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .find(item => item?.comment === ADDITIONAL_COMMENT);
            if (!entry) {
                additionalState = normalizeState(defaultState(), meta);
                return additionalState;
            }
            try {
                additionalState = normalizeState(JSON.parse(entry.content || '{}'), meta);
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] World Additional state parse failed:', e?.message || e);
                additionalState = normalizeState(defaultState(), meta);
            }
            return additionalState;
        };
        const saveState = async (lorebook = []) => {
            if (!Array.isArray(lorebook)) return;
            const entry = {
                key: 'lmai_world_additional::directives',
                comment: ADDITIONAL_COMMENT,
                content: JSON.stringify(additionalState),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            };
            const idx = lorebook.findIndex(item => item?.comment === ADDITIONAL_COMMENT);
            if (idx >= 0) lorebook[idx] = entry;
            else lorebook.push(entry);
        };
        const collectDirectives = () => [
            ...(Array.isArray(additionalState.sceneInterventions) ? additionalState.sceneInterventions : []),
            ...(Array.isArray(additionalState.worldDeltas) ? additionalState.worldDeltas : []),
            ...(Array.isArray(additionalState.characterAdditions) ? additionalState.characterAdditions : [])
        ];
        const getWorldAdditionalCountsForDebug = () => ({
            sceneInterventions: Array.isArray(additionalState.sceneInterventions) ? additionalState.sceneInterventions.length : 0,
            worldDeltas: Array.isArray(additionalState.worldDeltas) ? additionalState.worldDeltas.length : 0,
            characterAdditions: Array.isArray(additionalState.characterAdditions) ? additionalState.characterAdditions.length : 0,
            worldCodex: Array.isArray(additionalState.worldCodex) ? additionalState.worldCodex.length : 0,
            activeDirectives: Array.isArray(additionalState.activeDirectives) ? additionalState.activeDirectives.length : 0,
            lastInjectedIds: Array.isArray(additionalState.lastInjectedIds) ? additionalState.lastInjectedIds.length : 0,
            manifestationLog: Array.isArray(additionalState.manifestationLog) ? additionalState.manifestationLog.length : 0
        });
        const similarityTokens = (value = '') => new Set(normalizeKey(value).split(/\s+/).filter(token => token.length >= 2 && !GROUNDING_STOPWORDS.test(token)));
        const jaccardSimilarity = (left = new Set(), right = new Set()) => {
            if (!left.size || !right.size) return 0;
            let intersection = 0;
            left.forEach(token => { if (right.has(token)) intersection += 1; });
            return intersection / Math.max(1, left.size + right.size - intersection);
        };
        const directiveDuplicateScore = (left = {}, right = {}) => {
            if (normalizeType(left.type) !== normalizeType(right.type)) return 0;
            const leftTitle = normalizeKey(left.name || left.title || '');
            const rightTitle = normalizeKey(right.name || right.title || '');
            const genericTitle = /^(?:unnamed|untitled|unnamed scene intervention|unnamed world delta|unnamed character addition|추가 지시|이름 없음)$/i;
            if (leftTitle && rightTitle && leftTitle === rightTitle && !genericTitle.test(leftTitle)) return 1;
            if (leftTitle.length >= 5 && rightTitle.length >= 5 && (leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle))) return 0.96;
            const titleScore = jaccardSimilarity(similarityTokens(leftTitle), similarityTokens(rightTitle));
            const leftBody = [left.title, left.name, left.description, left.directive, left.purpose, ...(left.sourceBasis || []), ...(left.relatedEntities || []), ...(left.relatedWorldRules || [])].filter(Boolean).join(' ');
            const rightBody = [right.title, right.name, right.description, right.directive, right.purpose, ...(right.sourceBasis || []), ...(right.relatedEntities || []), ...(right.relatedWorldRules || [])].filter(Boolean).join(' ');
            const bodyScore = jaccardSimilarity(similarityTokens(leftBody), similarityTokens(rightBody));
            const leftAnchors = similarityTokens([...(left.relatedEntities || []), ...(left.relatedWorldRules || []), ...(left.sourceBasis || [])].join(' '));
            const rightAnchors = similarityTokens([...(right.relatedEntities || []), ...(right.relatedWorldRules || []), ...(right.sourceBasis || [])].join(' '));
            const anchorScore = jaccardSimilarity(leftAnchors, rightAnchors);
            if (titleScore >= 0.72 && bodyScore >= 0.66) return 0.9;
            if (bodyScore >= 0.82 && (anchorScore >= 0.35 || titleScore >= 0.55)) return 0.88;
            return Math.max(titleScore * 0.55 + bodyScore * 0.35 + anchorScore * 0.1, 0);
        };
        const mergeTextField = (left = '', right = '', max = 520) => {
            const a = String(left || '').trim(); const b = String(right || '').trim();
            if (!a) return clip(b, max); if (!b) return clip(a, max);
            const aKey = normalizeKey(a); const bKey = normalizeKey(b);
            if (aKey.includes(bKey)) return clip(a, max);
            if (bKey.includes(aKey)) return clip(b, max);
            return clip(`${a}\n${b}`, max);
        };
        const earliestPositiveNumber = (...values) => {
            const numbers = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
            return numbers.length ? Math.min(...numbers) : 0;
        };
        const mergeDirectiveRecords = (primary = {}, duplicate = {}) => {
            const statusRank = { blocked: 0, retired: 1, prepared: 2, armed: 3, injected: 4, manifested: 5, integrated: 6 };
            const selectedStatus = (statusRank[normalizeStatus(duplicate.status)] || 0) > (statusRank[normalizeStatus(primary.status)] || 0) ? normalizeStatus(duplicate.status) : normalizeStatus(primary.status);
            const merged = {
                ...primary,
                title: mergeTextField(primary.title, duplicate.title, 150).split('\n')[0],
                name: mergeTextField(primary.name, duplicate.name, 120).split('\n')[0],
                role: mergeTextField(primary.role, duplicate.role, 160),
                description: mergeTextField(primary.description, duplicate.description, 520),
                directive: mergeTextField(primary.directive, duplicate.directive, 520),
                purpose: mergeTextField(primary.purpose, duplicate.purpose, 260),
                activationCondition: mergeTextField(primary.activationCondition, duplicate.activationCondition, 240),
                noveltyReason: mergeTextField(primary.noveltyReason, duplicate.noveltyReason, 260),
                revealDebt: mergeTextField(primary.revealDebt, duplicate.revealDebt, 260),
                sourceBasis: arrayOfText([...(primary.sourceBasis || []), ...(duplicate.sourceBasis || [])], 12, 180),
                constraints: arrayOfText([...(primary.constraints || []), ...(duplicate.constraints || [])], 12, 180),
                anchors: arrayOfText([...(primary.anchors || []), ...(duplicate.anchors || [])], 12, 120),
                relatedEntities: arrayOfText([...(primary.relatedEntities || []), ...(duplicate.relatedEntities || [])], 12, 80),
                relatedWorldRules: arrayOfText([...(primary.relatedWorldRules || []), ...(duplicate.relatedWorldRules || [])], 10, 160),
                status: selectedStatus,
                repeatable: primary.repeatable === true || duplicate.repeatable === true,
                manualInjection: primary.manualInjection === true || duplicate.manualInjection === true,
                injectionDisabled: primary.manualInjection === true || duplicate.manualInjection === true ? false : (primary.injectionDisabled === true && duplicate.injectionDisabled === true),
                createdTurn: earliestPositiveNumber(primary.createdTurn, duplicate.createdTurn),
                injectedTurn: Math.max(Number(primary.injectedTurn || 0), Number(duplicate.injectedTurn || 0)),
                manifestedTurn: Math.max(Number(primary.manifestedTurn || 0), Number(duplicate.manifestedTurn || 0)),
                integratedTurn: Math.max(Number(primary.integratedTurn || 0), Number(duplicate.integratedTurn || 0)),
                mergedFromIds: arrayOfText([...(primary.mergedFromIds || []), ...(duplicate.mergedFromIds || []), duplicate.id].filter(id => id && id !== primary.id), 24, 80),
                lastUpdated: Date.now()
            };
            return normalizeDirective(merged, primary.type) || merged;
        };
        const upsertDirective = (directive = null) => {
            const normalized = normalizeDirective(directive, directive?.type || '');
            if (!normalized) return { changed: false, directive: null };
            const deletionKey = `directive:${normalizeType(normalized.type)}:${normalizeKey(normalized.name || normalized.title || normalized.id)}`;
            const deletedKeys = new Set(arrayOfText(additionalState.deletedItemKeys || [], 160, 180));
            if (deletedKeys.has(`directive:id:${normalized.id}`) || deletedKeys.has(deletionKey)) return { changed: false, directive: null, deleted: true };
            const bucket = directiveBucketKey(normalized.type);
            const list = Array.isArray(additionalState[bucket]) ? [...additionalState[bucket]] : [];
            const idx = list.findIndex(item => String(item?.id || '') === normalized.id || directiveDuplicateScore(item, normalized) >= 0.88);
            let next;
            if (idx >= 0) {
                const previous = list[idx] || {};
                next = mergeDirectiveRecords(previous, normalized);
                list[idx] = next;
            } else {
                next = {
                    ...normalized,
                    status: ['prepared', 'armed'].includes(normalized.status) ? 'armed' : normalized.status,
                    lastUpdated: Date.now()
                };
                list.push(next);
            }
            additionalState[bucket] = list.slice(-(bucket === 'worldDeltas' ? 64 : 48));
            additionalState.lastUpdated = Date.now();
            return { changed: true, directive: next };
        };
        const mergeDuplicateDirectives = () => {
            let merged = 0;
            const groups = [];
            for (const bucket of ['sceneInterventions', 'worldDeltas', 'characterAdditions']) {
                const output = [];
                for (const item of Array.isArray(additionalState[bucket]) ? additionalState[bucket] : []) {
                    const idx = output.findIndex(current => directiveDuplicateScore(current, item) >= 0.88);
                    if (idx < 0) output.push(item);
                    else { output[idx] = mergeDirectiveRecords(output[idx], item); merged += 1; groups.push({ keptId: output[idx].id, mergedId: item.id, type: item.type }); }
                }
                additionalState[bucket] = output;
            }
            if (merged) {
                const validIds = new Set(collectDirectives().map(item => String(item.id || '')).filter(Boolean));
                additionalState.activeDirectives = (additionalState.activeDirectives || []).filter(item => validIds.has(String(item.id || '')));
                additionalState.lastInjectedIds = (additionalState.lastInjectedIds || []).filter(id => validIds.has(String(id || '')));
                additionalState.lastUpdated = Date.now();
            }
            return { changed: merged > 0, merged, groups };
        };
        // 카드 인라인 편집 (World Additional 디렉티브).
        // upsertDirective 는 유사도 병합을 하므로 편집에 쓰면 다른 항목과 합쳐질 수 있다.
        // id 가 정확히 일치하는 항목만 고친다.
        const DIRECTIVE_EDITABLE_FIELDS = Object.freeze([
            'title', 'name', 'description', 'directive', 'purpose', 'role',
            'activationCondition', 'progressionTier', 'forceLevel', 'userImpact', 'status'
        ]);
        const getDirectiveEditableFields = () => [...DIRECTIVE_EDITABLE_FIELDS];
        const updateDirectiveFields = (directiveId = '', patch = {}, options = {}) => {
            const targetId = String(directiveId || '').trim();
            if (!targetId) return { changed: false, reason: 'missing_id', item: null };
            const buckets = ['sceneInterventions', 'worldDeltas', 'characterAdditions', 'activeDirectives'];
            for (const bucket of buckets) {
                const list = Array.isArray(additionalState[bucket]) ? additionalState[bucket] : [];
                const index = list.findIndex(item => String(item?.id || '') === targetId);
                if (index < 0) continue;
                const current = list[index];
                const changes = patch && typeof patch === 'object' ? patch : {};
                if (Object.prototype.hasOwnProperty.call(changes, 'title')
                    && !String(changes.title || '').trim()) {
                    return { changed: false, reason: 'empty_title', item: current };
                }
                const applied = {};
                for (const field of DIRECTIVE_EDITABLE_FIELDS) {
                    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
                    applied[field] = clip(changes[field], 2000);
                }
                if (!Object.keys(applied).length) {
                    return { changed: false, reason: 'no_editable_field', item: current };
                }
                const turn = Number(options.turn || MemoryEngine?.getCurrentTurn?.() || MemoryState?.currentTurn || 0) || 0;
                const updated = {
                    ...current,
                    ...applied,
                    id: current.id,
                    revision: Math.max(1, Number(current.revision || 1)) + 1,
                    lastUpdated: Date.now(),
                    editedByUser: true
                };
                const nextList = [...list];
                nextList[index] = updated;
                additionalState[bucket] = nextList;
                additionalState.lastUpdated = Date.now();
                return { changed: true, item: updated, bucket, appliedFields: Object.keys(applied), turn };
            }
            return { changed: false, reason: 'not_found', item: null };
        };
        const deleteItem = (kind = 'directive', id = '') => {
            const targetId = String(id || '').trim(); if (!targetId) return { changed: false, reason: 'missing_id' };
            let changed = false;
            if (kind === 'codex') {
                const target = (additionalState.worldCodex || []).find(item => String(item.id || '') === targetId);
                const before = (additionalState.worldCodex || []).length;
                additionalState.worldCodex = (additionalState.worldCodex || []).filter(item => String(item.id || '') !== targetId);
                changed = additionalState.worldCodex.length !== before;
                if (changed) additionalState.deletedItemKeys = arrayOfText([...(additionalState.deletedItemKeys || []), `codex:id:${targetId}`, target?.signature ? `codex:sig:${target.signature}` : ''].filter(Boolean), 160, 180);
            } else {
                const target = collectDirectives().find(item => String(item.id || '') === targetId);
                for (const bucket of ['sceneInterventions', 'worldDeltas', 'characterAdditions']) {
                    const before = (additionalState[bucket] || []).length;
                    additionalState[bucket] = (additionalState[bucket] || []).filter(item => String(item.id || '') !== targetId);
                    if (additionalState[bucket].length !== before) changed = true;
                }
                additionalState.activeDirectives = (additionalState.activeDirectives || []).filter(item => String(item.id || '') !== targetId);
                additionalState.lastInjectedIds = (additionalState.lastInjectedIds || []).filter(item => String(item || '') !== targetId);
                if (changed) additionalState.deletedItemKeys = arrayOfText([
                    ...(additionalState.deletedItemKeys || []),
                    `directive:id:${targetId}`,
                    target ? `directive:${normalizeType(target.type)}:${normalizeKey(target.name || target.title || target.id)}` : ''
                ].filter(Boolean), 160, 180);
            }
            if (changed) additionalState.lastUpdated = Date.now();
            return { changed, id: targetId, kind };
        };
        const getConfiguredSettings = (config = MemoryEngine.CONFIG) => {
            const maxPerResponse = Math.max(1, Math.min(6, Number(config?.worldAdditionalMaxPerRequest || 3) || 3));
            return normalizeSettings({
            ...additionalState.settings,
            defaultForceLevel: 'firm',
            maxSceneInterventionsPerTurn: maxPerResponse,
            maxWorldDeltasPerTurn: maxPerResponse,
            maxCharacterAdditionsPerScene: maxPerResponse,
            autoIntegrateManifested: true
            });
        };
        const GROUNDING_STOPWORDS = /^(?:the|and|with|that|this|scene|world|character|additional|directive|should|must|create|add|addition|event|place|person|current|next|relevant|use|using|추가|장면|세계|인물|요소|상황|진행|자연|사용|등장|임무|장소|현재|다음|관련)$/i;
        const tokenizeGroundingCues = (text = '', limit = 18) => normalizeKey(text)
            .split(/\s+/)
            .filter(token => token.length >= 2 && !GROUNDING_STOPWORDS.test(token))
            .slice(0, Math.max(1, Number(limit || 18)));
        const directiveMatchesContext = (directive = {}, ctx = {}) => {
            const haystack = normalizeKey([
                ctx.userMessage,
                ctx.worldPrompt,
                ctx.worldStatePrompt,
                ctx.narrativePrompt,
                ctx.directorPrompt,
                ctx.storyAuthorPrompt,
                ...(Array.isArray(ctx.focusCharacters) ? ctx.focusCharacters : []),
                ...(Array.isArray(ctx.memoryHints) ? ctx.memoryHints : []),
                ...(Array.isArray(ctx.loreHints) ? ctx.loreHints : [])
            ].filter(Boolean).join('\n'));
            if (!haystack) return true;
            const explicitCueText = [
                directive.activationCondition,
                ...(Array.isArray(directive.anchors) ? directive.anchors : []),
                ...(Array.isArray(directive.relatedEntities) ? directive.relatedEntities : []),
                ...(Array.isArray(directive.relatedWorldRules) ? directive.relatedWorldRules : []),
                ...(Array.isArray(directive.sourceBasis) ? directive.sourceBasis : []),
                directive.reusedCanonEntity
            ].filter(Boolean).join(' ');
            let tokens = tokenizeGroundingCues(explicitCueText, 18);
            if (!tokens.length) {
                if (directive.type === 'scene_intervention') return true;
                tokens = tokenizeGroundingCues([
                    directive.title,
                    directive.name,
                    directive.role,
                    directive.purpose,
                    directive.description,
                    directive.directive
                ].filter(Boolean).join(' '), 14);
            }
            if (!tokens.length) return directive.type === 'scene_intervention';
            const hits = tokens.filter(token => haystack.includes(token)).length;
            if (directive.type === 'character_addition' && hits <= 0) return false;
            return hits > 0 || hits / Math.max(1, tokens.length) >= 0.25;
        };
        const getProgressionRank = (tier = 'section') => PROGRESSION_RANK[normalizeProgressionTier(tier, 'section')] ?? PROGRESSION_RANK.section;
        const hasExplicitProgressionJustification = (directive = {}) => {
            const tier = normalizeProgressionTier(directive.progressionTier || '', 'local');
            if (!['climax', 'final'].includes(tier)) return true;
            const text = normalizeKey([
                directive.activationCondition,
                directive.noveltyReason,
                directive.directive,
                directive.description,
                directive.customSource,
                ...(Array.isArray(directive.sourceBasis) ? directive.sourceBasis : []),
                ...(Array.isArray(directive.anchors) ? directive.anchors : [])
            ].filter(Boolean).join(' '));
            return /(climax|finale|endgame|foreshadow|foreshadowed|already\s+revealed|already\s+established|confrontation|결전|클라이맥스|최종|종반|후반|이미\s*암시|이미\s*등장|직접\s*요청|유저\s*요청|사용자\s*요청|복선|흔적|소문|대리자|현지\s*연락책)/i.test(text);
        };
        const hasStagedForeshadowingCue = (directive = {}) => {
            const text = normalizeKey([
                directive.title,
                directive.name,
                directive.activationCondition,
                directive.noveltyReason,
                directive.directive,
                directive.description,
                directive.customSource,
                ...(Array.isArray(directive.sourceBasis) ? directive.sourceBasis : []),
                ...(Array.isArray(directive.anchors) ? directive.anchors : [])
            ].filter(Boolean).join(' '));
            return /(foreshadow|rumou?r|trace|proxy|emissary|representative|observer|contact|local\s+helper|indirect|소문|흔적|복선|암시|대리자|사자|대표|관찰자|현지\s*연락책|간접|직접\s*등장\s*금지|직접\s*나오지|직접\s*출현\s*금지)/i.test(text);
        };
        const inferContextProgressionTier = (ctx = {}) => {
            const text = normalizeKey([
                ctx.userMessage,
                ctx.narrativePrompt,
                ctx.directorPrompt,
                ctx.storyAuthorPrompt,
                ctx.worldStatePrompt,
                ...(Array.isArray(ctx.memoryHints) ? ctx.memoryHints : []),
                ...(Array.isArray(ctx.loreHints) ? ctx.loreHints : [])
            ].filter(Boolean).join(' '));
            if (!text) return 'section';
            const earlyCue = /(early|opening|intro|local|investigation|mission|assignment|not\s+yet|far\s+from|too\s+early|초반|도입|초기|현지|지역|조사|임무|의뢰|아직|멀다|이르다)/i.test(text);
            const negatedLateCue = /(not\s+yet|far\s+from|too\s+early|아직|멀다|이르다).{0,36}(finale|endgame|final|climax|최종|결전|클라이맥스|종막|대단원)|(finale|endgame|final|climax|최종|결전|클라이맥스|종막|대단원).{0,36}(not\s+yet|far\s+from|too\s+early|아직|멀다|이르다)/i.test(text);
            const lateNowCue = !negatedLateCue && /(now|currently|entered|already\s+at|현재|지금|진입|돌입|이미).{0,24}(finale|endgame|final|climax|최종|결전|클라이맥스|종막|대단원)/i.test(text);
            if (negatedLateCue || (earlyCue && !lateNowCue)) return 'local';
            if (/(finale|endgame|final\s+battle|last\s+boss|ultimate\s+confrontation|최종|최후|종막|결말|라스트\s*보스|최종\s*보스|최종전)/i.test(text)) return 'final';
            if (/(climax|decisive\s+battle|confrontation|boss\s+fight|결전|클라이맥스|대결전|보스전)/i.test(text)) return 'climax';
            if (/(arc|chapter\s+goal|midgame|long\s+running|장기\s*목표|메인\s*아크|아크|중반|후반)/i.test(text)) return 'arc';
            return 'section';
        };
        const progressionFitsContext = (directive = {}, ctx = {}) => {
            const tier = normalizeProgressionTier(directive.progressionTier || '', directive.type === 'character_addition' ? 'local' : 'section');
            const desired = getProgressionRank(tier);
            const current = getProgressionRank(inferContextProgressionTier(ctx));
            if (desired <= current + 1) return true;
            if (desired >= getProgressionRank('climax') && hasStagedForeshadowingCue(directive)) return true;
            if (desired >= getProgressionRank('climax') && !hasExplicitProgressionJustification(directive)) return false;
            const text = normalizeKey([directive.customSource, directive.noveltyReason, directive.directive, directive.description].filter(Boolean).join(' '));
            const directCustom = /(world\s*custom|user\s*custom|direct\s*user|유저\s*직접|사용자\s*직접|직접\s*요청)/i.test(text);
            return directCustom && desired <= current + 2;
        };
        const isCharacterNameAlreadyKnownInContext = (directive = {}, ctx = {}) => {
            if (directive.type !== 'character_addition') return false;
            if (String(directive.reusedCanonEntity || '').trim()) return false;
            const labels = [directive.name, directive.title]
                .map(value => normalizeKey(value))
                .filter(value => value && value.length >= 2 && !/^unnamed\s+character\s+addition$/i.test(value));
            if (!labels.length) return false;
            const haystack = normalizeKey([
                ...collectKnownActorNames(ctx),
                ...(Array.isArray(ctx.focusCharacters) ? ctx.focusCharacters : []),
                ...(Array.isArray(ctx.memoryHints) ? ctx.memoryHints : []),
                ...(Array.isArray(ctx.loreHints) ? ctx.loreHints : []),
                ctx.worldPrompt,
                ctx.worldStatePrompt,
                ctx.narrativePrompt,
                ctx.directorPrompt,
                ctx.storyAuthorPrompt
            ].filter(Boolean).join('\n'));
            if (!haystack) return false;
            return labels.some(label => label.length >= 2 && haystack.includes(label));
        };
        const formatWorldAdditionalCustomMandate = (config = MemoryEngine.CONFIG) => {
            const text = getWorldAdditionalCustomText(config).trim();
            if (!text) return '';
            return [
                '[WORLD ADDITIONAL CUSTOM DIRECTIVE / 월드 에디셔널 직접 지시]',
                'This is direct user-authored input for the World Additional layer only. Interpret it adaptively; do not paste it raw if adaptation is needed.',
                'Forced priority: convert the requested active scene intervention, world delta, or character addition into World Additional behavior unless it directly violates the latest user-role message, established safety boundaries, or impossible canon constraints.',
                'Do not write this directive directly into canonicalPacket or the LIBRA canon DB. Stable canon DB reflection belongs only to the separate LIBRA Canon DB Reflection Directive.',
                'Character-addition policy: when a new person is requested, prioritize a genuinely unintroduced actor for the current section who is not already present in the character lorebook or LIBRA canonical entities; if the user did not request a new person and a canon actor already fits, reuse the canon actor instead.',
                'Progression guard: avoid abrupt stage collapse. Early/local sections should introduce local helpers, contacts, observers, rivals, symptoms, traces, proxies, rumors, or foreshadowing; do not directly manifest final-boss/endgame figures until the current narrative already supports that scale. If the custom itself asks for an over-tier figure too early, preserve it as a future mandate and adapt the current turn into foreshadowing/proxy evidence instead of direct appearance.',
                'Keep every custom adaptation grounded in current location, mission, social role, existing world logic, and recent unresolved threads. Do not steal the user character\'s agency.',
                'Raw World Additional user directive:',
                text
            ].join('\n');
        };
        const evaluateInjection = (directive = {}, settings = defaultSettings(), ctx = {}) => {
            const status = normalizeStatus(directive.status || 'prepared');
            if (directive.injectionDisabled === true) return { ok: false, reason: 'user_injection_disabled', status };
            if (directive.manualInjection === true) return { ok: true, reason: 'user_manual_injection', status, manual: true };
            if (status === 'retired' || status === 'blocked') return { ok: false, reason: `status_${status}`, status };
            if (directive.type === 'scene_intervention' && (status === 'manifested' || status === 'integrated') && directive.repeatable !== true) {
                return { ok: false, reason: 'scene_already_manifested', status };
            }
            if (!progressionFitsContext(directive, ctx)) return { ok: false, reason: 'progression_mismatch', status, progressionTier: normalizeProgressionTier(directive.progressionTier || '') };
            if (directive.type === 'character_addition') {
                const hasGrounding = Boolean(
                    String(directive.activationCondition || '').trim()
                    || String(directive.reusedCanonEntity || '').trim()
                    || (Array.isArray(directive.sourceBasis) && directive.sourceBasis.length)
                    || (Array.isArray(directive.anchors) && directive.anchors.length)
                    || (Array.isArray(directive.relatedEntities) && directive.relatedEntities.length)
                );
                if (!hasGrounding) return { ok: false, reason: 'character_without_grounding', status };
                if (isCharacterNameAlreadyKnownInContext(directive, ctx)) return { ok: false, reason: 'character_name_already_known', status };
            }
            if (!directiveMatchesContext(directive, ctx)) return { ok: false, reason: 'context_mismatch', status };
            return { ok: true, reason: 'ok', status };
        };
        const prioritize = (items = []) => [...items].sort((a, b) => {
            const statusScore = { injected: 5, armed: 4, prepared: 3, manifested: 2, integrated: 1 };
            return (statusScore[normalizeStatus(b.status)] || 0) - (statusScore[normalizeStatus(a.status)] || 0)
                || Number(b.createdTurn || 0) - Number(a.createdTurn || 0)
                || String(a.title || '').localeCompare(String(b.title || ''));
        });
        const selectForPrompt = (ctx = {}, config = MemoryEngine.CONFIG) => {
            const turn = Number(ctx.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            const mode = 'adaptive';
            const globalActive = true;
            const settings = getConfiguredSettings(config);
            const rejected = [];
            const bucketStats = [];
            const pick = (items = [], limit = 1, bucket = '') => {
                const list = (Array.isArray(items) ? items : []).filter(item => globalActive || item?.manualInjection === true);
                const evaluated = list.map(item => ({ item, evaluation: evaluateInjection(item, settings, ctx) }));
                const eligible = evaluated.filter(entry => entry.evaluation?.ok === true).map(entry => entry.item);
                const normalizedLimit = Math.max(0, Number(limit || 0));
                const prioritized = prioritize(eligible);
                const manual = prioritized.filter(item => item.manualInjection === true);
                const automatic = prioritized.filter(item => item.manualInjection !== true);
                const picked = [...manual, ...automatic].slice(0, Math.max(normalizedLimit, manual.length));
                const pickedIds = new Set(picked.map(item => String(item?.id || '')).filter(Boolean));
                for (const entry of evaluated) {
                    if (entry.evaluation?.ok === true) continue;
                    rejected.push({
                        bucket,
                        reason: entry.evaluation?.reason || 'unknown',
                        detail: entry.evaluation || {},
                        directive: summarizeDirectiveForDebug(entry.item)
                    });
                }
                for (const item of prioritized) {
                    const id = String(item?.id || '').trim();
                    if (!id || pickedIds.has(id)) continue;
                    rejected.push({
                        bucket,
                        reason: 'bucket_limit',
                        detail: { limit: normalizedLimit },
                        directive: summarizeDirectiveForDebug(item)
                    });
                }
                bucketStats.push({ bucket, candidates: list.length, eligible: eligible.length, picked: picked.length, limit: normalizedLimit });
                return picked;
            };
            const selectedBeforeTotalLimit = [
                ...pick(additionalState.sceneInterventions || [], settings.maxSceneInterventionsPerTurn, 'sceneInterventions'),
                ...pick(additionalState.worldDeltas || [], settings.maxWorldDeltasPerTurn, 'worldDeltas'),
                ...pick(additionalState.characterAdditions || [], settings.maxCharacterAdditionsPerScene, 'characterAdditions')
            ];
            const totalLimit = Math.max(1, Math.min(6, Math.floor(Number(config?.worldAdditionalMaxPerRequest || 3) || 3)));
            const manualSelected = selectedBeforeTotalLimit.filter(item => item.manualInjection === true);
            const automaticSelected = selectedBeforeTotalLimit.filter(item => item.manualInjection !== true);
            const selected = [...manualSelected, ...automaticSelected].slice(0, Math.max(totalLimit, manualSelected.length));
            const selectedIds = new Set(selected.map(item => String(item?.id || '')).filter(Boolean));
            const totalLimitSkipped = selectedBeforeTotalLimit.filter(item => !selectedIds.has(String(item?.id || ''))).map(item => ({
                reason: 'total_limit',
                detail: { totalLimit },
                directive: summarizeDirectiveForDebug(item)
            }));
            debugWorldAdditional('selection', {
                turn,
                mode,
                settings: {
                    defaultForceLevel: settings.defaultForceLevel,
                    maxSceneInterventionsPerTurn: settings.maxSceneInterventionsPerTurn,
                    maxWorldDeltasPerTurn: settings.maxWorldDeltasPerTurn,
                    maxCharacterAdditionsPerScene: settings.maxCharacterAdditionsPerScene,
                },
                stateCounts: getWorldAdditionalCountsForDebug(),
                bucketStats,
                totalLimit,
                customMandateActive: hasWorldAdditionalCustomMandate(config),
                context: {
                    knownActorCount: collectKnownActorNames(ctx).length,
                    focusCharacters: arrayOfText(ctx.focusCharacters || [], 8, 80),
                    currentProgressionTier: normalizeProgressionTier(ctx.progressionTier || ctx.currentProgressionTier || ctx.storyTier || 'local')
                },
                selected: selected.map(summarizeDirectiveForDebug),
                rejected: [...rejected, ...totalLimitSkipped].slice(0, 24)
            });
            // 사용자 가시성: 방금 계산한 판정 결과를 GUI 가 읽을 수 있게 남긴다.
            // 종전에는 위 debugWorldAdditional() 로만 흘러 디버그 내보내기에만
            // 들어갔고, GUI 는 숫자만 셀 수 있었다.
            lastSelectionDiagnostics = {
                turn,
                selectedIds: selected.map(item => String(item?.id || '')).filter(Boolean),
                rejected: [...rejected, ...totalLimitSkipped].slice(0, 24).map(entry => ({
                    bucket: entry.bucket || '',
                    reason: entry.reason || 'unknown',
                    label: getRejectReasonLabel(entry.reason),
                    detail: entry.detail || {},
                    directive: entry.directive || {}
                })),
                bucketStats: bucketStats.map(entry => ({ ...entry })),
                totalLimit,
                updatedAt: Date.now()
            };
            return selected;
        };
        const setInjectionState = (kind = 'directive', id = '', enabled = false) => {
            const targetId = String(id || '').trim(); if (!targetId) return { changed: false, reason: 'missing_id' };
            let item = null;
            if (kind === 'codex') {
                const idx = (additionalState.worldCodex || []).findIndex(entry => String(entry.id || '') === targetId);
                if (idx >= 0) {
                    item = { ...additionalState.worldCodex[idx], manualInjection: enabled === true, injectionDisabled: enabled !== true, lastUpdated: Date.now() };
                    additionalState.worldCodex[idx] = item;
                }
            } else {
                for (const bucket of ['sceneInterventions', 'worldDeltas', 'characterAdditions']) {
                    const idx = (additionalState[bucket] || []).findIndex(entry => String(entry.id || '') === targetId);
                    if (idx < 0) continue;
                    item = {
                        ...additionalState[bucket][idx],
                        manualInjection: enabled === true,
                        injectionDisabled: enabled !== true,
                        status: enabled === true ? 'armed' : additionalState[bucket][idx].status,
                        lastUpdated: Date.now()
                    };
                    additionalState[bucket][idx] = item;
                    break;
                }
            }
            if (!item) return { changed: false, reason: 'not_found', id: targetId, kind };
            if (kind !== 'codex') {
                if (enabled === true) additionalState.activeDirectives = (additionalState.activeDirectives || []).map(entry => String(entry.id || '') === targetId ? { ...entry, ...item } : entry);
                else {
                    additionalState.activeDirectives = (additionalState.activeDirectives || []).filter(entry => String(entry.id || '') !== targetId);
                    additionalState.lastInjectedIds = (additionalState.lastInjectedIds || []).filter(entry => String(entry || '') !== targetId);
                }
            }
            additionalState.lastUpdated = Date.now();
            return { changed: true, enabled: enabled === true, item, id: targetId, kind };
        };
        const directiveToPromptLine = (directive = {}) => {
            const parts = [];
            parts.push(`- ID: ${directive.id} (tracking only; never reveal this ID in prose)`);
            parts.push(`  Type: ${directiveTypeLabel(directive.type)}`);
            parts.push(`  Title: ${directive.title || directive.name || 'Untitled'}`);
            if (directive.name && directive.name !== directive.title) parts.push(`  Name: ${directive.name}`);
            if (directive.role) parts.push(`  Role/Function: ${directive.role}`);
            if (directive.description) parts.push(`  Addition: ${directive.description}`);
            if (directive.directive) parts.push(`  Directive: ${directive.directive}`);
            if (directive.purpose) parts.push(`  Purpose: ${directive.purpose}`);
            if (directive.reusedCanonEntity) parts.push(`  Canon-first: use existing canon/lorebook entity: ${directive.reusedCanonEntity}`);
            if (directive.sourceBasis?.length) parts.push(`  Canon/context basis: ${directive.sourceBasis.join('; ')}`);
            if (directive.noveltyReason) parts.push(`  Novelty reason: ${directive.noveltyReason}`);
            if (directive.noveltyScope) parts.push(`  Novelty scope: ${directive.noveltyScope}`);
            if (directive.progressionTier) parts.push(`  Progression tier: ${directive.progressionTier}`);
            if (directive.customSource) parts.push(`  Custom source: ${directive.customSource}`);
            if (directive.activationCondition) parts.push(`  Activation: ${directive.activationCondition}`);
            if (directive.firstAppearance?.method) parts.push(`  First appearance: ${directive.firstAppearance.method}`);
            if (directive.constraints?.length) parts.push(`  Constraints: ${directive.constraints.join('; ')}`);
            if (directive.relatedEntities?.length) parts.push(`  Related entities: ${directive.relatedEntities.join(', ')}`);
            if (directive.revealDebt) parts.push(`  Reveal debt: ${directive.revealDebt}`);
            // NOTE: forceLevel / userImpact 은 의도적으로 프롬프트에 싣지 않는다.
            // 이 계층은 강도를 "전역 한도"로 제약하지 않고 응답 모델이 정본·관계·장면을
            // 보고 스스로 정하게 한다 (아래 'The response model decides ...' 문장).
            // 값은 저장·정규화·GUI 배지 표시에만 쓰인다.
            // 근거: tools/world_additional_targeted_test.cjs 의
            // manual_injection_bypasses_retired_global_strength_and_impact_limits.
            return parts.join('\n');
        };
        const markInjected = (directives = [], turn = 0) => {
            const ids = [];
            for (const directive of Array.isArray(directives) ? directives : []) {
                const id = String(directive?.id || '').trim();
                if (!id) continue;
                ids.push(id);
                const bucket = directiveBucketKey(directive.type);
                const list = Array.isArray(additionalState[bucket]) ? additionalState[bucket] : [];
                const idx = list.findIndex(item => String(item?.id || '') === id);
                if (idx >= 0) {
                    list[idx] = {
                        ...list[idx],
                        status: normalizeStatus(list[idx].status) === 'prepared' ? 'injected' : (['armed', 'injected'].includes(normalizeStatus(list[idx].status)) ? 'injected' : list[idx].status),
                        injectedTurn: Number(turn || 0) || list[idx].injectedTurn || 0,
                        lastUpdated: Date.now()
                    };
                }
            }
            additionalState.lastInjectedIds = arrayOfText([...ids, ...(additionalState.lastInjectedIds || [])], 12, 80);
            additionalState.activeDirectives = normalizeList(directives, '', 12);
            additionalState.lastTurn = Number(turn || 0) || additionalState.lastTurn || 0;
            additionalState.lastUpdated = Date.now();
            if (ids.length) {
                debugWorldAdditional('injected', {
                    turn: Number(turn || 0) || 0,
                    ids,
                    directives: (Array.isArray(directives) ? directives : []).map(summarizeDirectiveForDebug),
                    stateCounts: getWorldAdditionalCountsForDebug()
                });
            }
        };
        const formatForPrompt = (ctx = {}, config = MemoryEngine.CONFIG) => {
            const selected = selectForPrompt(ctx, config);
            const customMandate = '';
            const turn = Number(ctx.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            if (!selected.length && !customMandate) {
                debugWorldAdditional('prompt_empty', {
                    turn,
                    selectedCount: 0,
                    customMandateActive: false,
                    stateCounts: getWorldAdditionalCountsForDebug()
                });
                return '';
            }
            if (selected.length) markInjected(selected, turn);
            const byType = {
                scene_intervention: selected.filter(item => item.type === 'scene_intervention'),
                world_delta: selected.filter(item => item.type === 'world_delta'),
                character_addition: selected.filter(item => item.type === 'character_addition')
            };
            const parts = [
                '[WORLD ADDITIONAL DIRECTIVE / 월드 에디셔널 투입]',
                'Every listed item is enabled input and must be represented in the next response.',
                'The response model decides the natural portrayal intensity and character impact from current canon, relationships, scene conditions, and the latest user message. Preserve user-character agency and do not expose internal metadata.'
            ];
            const knownActors = collectKnownActorNames(ctx);
            if (customMandate) {
                parts.push('\n## World Additional Custom Directive / 월드 에디셔널 직접 지시');
                parts.push(customMandate);
            }
            if (byType.scene_intervention.length) {
                parts.push('\n## Scene Intervention / 강제 장면 개입');
                parts.push(byType.scene_intervention.map(directiveToPromptLine).join('\n'));
            }
            if (byType.world_delta.length) {
                parts.push('\n## World Delta / 세계관 추가 요소');
                parts.push('Treat these as active additional setting layers. Use them as world facts/layers without overwriting older canon.');
                parts.push(byType.world_delta.map(directiveToPromptLine).join('\n'));
            }
            if (byType.character_addition.length) {
                parts.push('\n## Character Addition / 인물 추가 요소');
                parts.push('Introduce or apply these external actors naturally. They may pressure the scene, but must not steal the user\'s agency. If a new actor is requested, use a truly unintroduced actor for the current section and outside current lorebook/LIBRA canon; if the role does not require novelty, reuse named canon/lorebook actors when they can serve the same scene function. Avoid premature final-boss/endgame introductions.');
                parts.push(byType.character_addition.map(directiveToPromptLine).join('\n'));
            }
            parts.push(
                'Canon-first rule: prefer existing canon/LIBRA/lorebook characters, places, organizations, and unresolved threads whenever they can naturally fulfill the role.',
                'New-character rule: when the purpose is specifically to add a new person, prioritize a genuinely unintroduced actor for the current section who is not already in character lorebook or LIBRA canonical entities; otherwise reuse an existing canon actor if they can naturally fulfill the same role.',
                'Progression guard: match the current section scale. Do not abruptly manifest final-boss/endgame-tier figures in early or local development; use local contacts, helpers, observers, rivals, traces, rumors, or foreshadowing first.',
                'Every addition must arise naturally from the current place, mission, social situation, mystery, or established world logic. Avoid unrelated surprise elements and genre-breaking additions.',
                'Do not decide the user character\'s actions, inner feelings, past identity, bloodline, body state, or consent. Do not reveal tracking IDs in prose.',
                'Prefer concrete manifestation: an event occurs, a world layer becomes usable, or a grounded added character enters/pressures the scene.'
            );
            if (knownActors.length) {
                parts.push(`Known canon/lorebook/LIBRA actors already available; do not treat these as new characters: ${knownActors.slice(0, 40).join(', ')}`);
            }
            const prompt = parts.filter(Boolean).join('\n');
            debugWorldAdditional('prompt_built', {
                turn,
                selectedCount: selected.length,
                selected: selected.map(summarizeDirectiveForDebug),
                customMandateActive: Boolean(customMandate),
                customMandateChars: customMandate.length,
                promptChars: prompt.length,
                knownActorCount: knownActors.length
            });
            return prompt;
        };
        const manifestPayloadItems = (payload = {}) => {
            const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
            // 프롬프트 shape(v6.0.0 이후 불변)은 manifestations 만 지시한다.
            // adoptionLog/adoption_log 는 프롬프트가 지시한 적도, 코드가 만든 적도 없다
            // (정의 2줄이 전부이고 저장소 초기화 이래 한 번도 바뀌지 않았다) → 죽은 별칭 제거.
            // manifested 는 유지한다: 기존 저장 데이터에 이 이름의 배열이 있을 수 있고,
            // 제거 이득(혼동 감소)보다 호환성 위험이 크다.
            const raw = [
                ...(Array.isArray(source.manifestations) ? source.manifestations : []),
                ...(Array.isArray(source.manifested) ? source.manifested : [])
            ];
            return raw.map(item => {
                if (typeof item === 'string') return { id: '', title: clip(item, 140), manifested: true, integrate: false, note: '' };
                if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
                return {
                    id: clip(item.id || item.directiveId || item.directive_id || '', 80),
                    type: item.type ? normalizeType(item.type) : '',
                    title: clip(item.title || item.name || item.label || '', 140),
                    manifested: item.manifested !== false && item.used !== false && item.appeared !== false,
                    integrate: item.integrate === true || item.integrated === true || item.canonize === true || item.canonized === true,
                    retire: item.retire === true || item.retired === true,
                    note: clip(item.note || item.notes || item.evidence || '', 220)
                };
            }).filter(Boolean);
        };
        const responseMentionsDirective = (response = '', directive = {}) => {
            const text = normalizeKey(response);
            if (!text) return false;
            const labels = [directive.title, directive.name, directive.directive, directive.description]
                .map(value => normalizeKey(value))
                .filter(value => value && value.length >= 3);
            for (const label of labels.slice(0, 2)) {
                if (label.length >= 6 && text.includes(label)) return true;
            }
            const tokens = normalizeKey([directive.title, directive.name, directive.description, directive.directive].filter(Boolean).join(' '))
                .split(/\s+/)
                .filter(token => token.length >= 2 && !/^(?:the|and|with|that|this|scene|world|character|추가|장면|세계|인물)$/.test(token))
                .slice(0, 14);
            if (tokens.length < 2) return false;
            const hits = tokens.filter(token => text.includes(token)).length;
            return hits >= Math.min(3, Math.max(2, Math.ceil(tokens.length * 0.35)));
        };
        const updateDirectiveManifestation = (directive = {}, turn = 0, options = {}) => {
            const id = String(directive?.id || '').trim();
            if (!id) return false;
            const bucket = directiveBucketKey(directive.type);
            const list = Array.isArray(additionalState[bucket]) ? additionalState[bucket] : [];
            const idx = list.findIndex(item => String(item?.id || '') === id);
            if (idx < 0) return false;
            const current = list[idx];
            const status = options.retire || (current.type === 'scene_intervention' && current.repeatable !== true)
                ? 'retired'
                : (options.integrate || additionalState.settings?.autoIntegrateManifested !== false ? 'integrated' : 'manifested');
            list[idx] = {
                ...current,
                status,
                manifestedTurn: Number(turn || 0) || current.manifestedTurn || 0,
                integratedTurn: status === 'integrated' ? (Number(turn || 0) || current.integratedTurn || 0) : current.integratedTurn,
                lastUpdated: Date.now()
            };
            additionalState.manifestationLog = [
                ...(Array.isArray(additionalState.manifestationLog) ? additionalState.manifestationLog : []),
                {
                    turn: Number(turn || 0) || 0,
                    id,
                    type: current.type,
                    title: current.title || current.name || '',
                    status,
                    note: clip(options.note || '', 220),
                    at: Date.now()
                }
            ].slice(-80);
            additionalState.lastUpdated = Date.now();
            return true;
        };
        const normalizeMaintenancePayload = (payload = null) => {
            const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
            return {
                sceneInterventions: normalizeList(source.sceneInterventions || source.scene_interventions || [], 'scene_intervention', 6),
                worldDeltas: normalizeList(source.worldDeltas || source.world_deltas || [], 'world_delta', 8),
                characterAdditions: normalizeList(source.characterAdditions || source.character_additions || [], 'character_addition', 6),
                manifestations: manifestPayloadItems(source),
                settings: normalizeSettings(source.settings || {})
            };
        };
        const ingestMaintenance = (payload = null, responseText = '', context = {}, config = MemoryEngine.CONFIG) => {
            const turn = Number(context?.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            const safePayload = normalizeMaintenancePayload(payload || {});
            additionalState.settings = normalizeSettings({ ...additionalState.settings, ...(safePayload.settings || {}) });
            const allBefore = collectDirectives();
            const manifestations = safePayload.manifestations || [];
            const injectedIds = new Set([...(additionalState.lastInjectedIds || []), ...(Array.isArray(context?.injectedIds) ? context.injectedIds : [])].map(String).filter(Boolean));
            const payloadCounts = {
                sceneInterventions: safePayload.sceneInterventions.length,
                worldDeltas: safePayload.worldDeltas.length,
                characterAdditions: safePayload.characterAdditions.length,
                manifestations: manifestations.length
            };
            debugWorldAdditional('maintenance_start', {
                turn,
                payloadCounts,
                injectedIds: Array.from(injectedIds).slice(0, 12),
                responseChars: String(responseText || '').length,
                beforeCounts: getWorldAdditionalCountsForDebug()
            });
            const manifestationResults = [];
            for (const directive of allBefore) {
                const explicit = manifestations.find(item => (item.id && item.id === directive.id)
                    || (item.title && normalizeKey(item.title) && normalizeKey(item.title) === normalizeKey(directive.title || directive.name || '')));
                const wasInjected = injectedIds.has(String(directive.id || '')) || normalizeStatus(directive.status) === 'injected';
                if (!explicit && !wasInjected) continue;
                const manifested = explicit?.manifested === true || responseMentionsDirective(responseText, directive);
                const integrate = explicit?.integrate === true || directive.type !== 'scene_intervention';
                const retire = explicit?.retire === true;
                const updated = manifested
                    ? updateDirectiveManifestation(directive, turn, {
                        integrate,
                        retire,
                        note: explicit?.note || 'Detected in assistant response.'
                    })
                    : false;
                manifestationResults.push({
                    directive: summarizeDirectiveForDebug(directive),
                    explicit: Boolean(explicit),
                    wasInjected,
                    responseMatched: manifested && !explicit?.manifested,
                    manifested,
                    integrate,
                    retire,
                    updated,
                    note: clip(explicit?.note || '', 180)
                });
            }
            const upserted = [];
            const upsertPayloadItems = (items = [], bucket = '') => {
                for (const item of Array.isArray(items) ? items : []) {
                    const result = upsertDirective({ ...item, status: item.status || 'armed', createdTurn: item.createdTurn || turn });
                    upserted.push({
                        bucket,
                        changed: result?.changed === true,
                        directive: result?.directive ? summarizeDirectiveForDebug(result.directive) : summarizeDirectiveForDebug(item)
                    });
                }
            };
            upsertPayloadItems(safePayload.sceneInterventions, 'sceneInterventions');
            upsertPayloadItems(safePayload.worldDeltas, 'worldDeltas');
            upsertPayloadItems(safePayload.characterAdditions, 'characterAdditions');
            additionalState.lastTurn = turn || additionalState.lastTurn || 0;
            additionalState.lastUpdated = Date.now();
            debugWorldAdditional('maintenance_result', {
                turn,
                payloadCounts,
                manifestationResults: manifestationResults.slice(0, 24),
                upserted: upserted.slice(0, 24),
                afterCounts: getWorldAdditionalCountsForDebug()
            });
            return additionalState;
        };
        const formatStateForAnalysis = (maxChars = 2200) => {
            const active = collectDirectives()
                .filter(item => !['retired', 'blocked'].includes(normalizeStatus(item.status)))
                .slice(-18);
            if (!active.length) return 'none';
            const text = active.map(item => [
                `${item.id} | ${directiveTypeLabel(item.type)} | ${item.status} | force=${item.forceLevel} | impact=${item.userImpact}`,
                `title: ${item.title || item.name || ''}`,
                item.description ? `addition: ${item.description}` : '',
                item.directive ? `directive: ${item.directive}` : '',
                item.activationCondition ? `activation: ${item.activationCondition}` : '',
                item.progressionTier ? `progressionTier: ${item.progressionTier}` : '',
                item.sourceBasis?.length ? `basis: ${item.sourceBasis.join('; ')}` : ''
            ].filter(Boolean).join('\n')).join('\n---\n');
            return truncateForLLM(text, Math.max(600, Number(maxChars || 2200)), ' ... ');
        };
        const buildHeuristicMaintenance = () => ({
            sceneInterventions: [],
            worldDeltas: [],
            characterAdditions: [],
            manifestations: []
        });
        const renameEntityReferences = (oldName = '', newName = '', options = {}) => {
            const oldText = String(oldName || '').trim();
            const newText = String(newName || '').trim();
            if (!oldText || !newText) return { changed: false };
            const oldKeys = new Set([oldText, ...(Array.isArray(options?.previousNames) ? options.previousNames : [])]
                .map(item => normalizeKey(item))
                .filter(Boolean));
            if (!oldKeys.size) return { changed: false };
            let changed = false;
            const rewriteArray = (items = []) => arrayOfText((Array.isArray(items) ? items : []).map(item => oldKeys.has(normalizeKey(item)) ? newText : item), 8, 120);
            const rewriteDirective = (directive = {}) => {
                const next = { ...directive };
                if (oldKeys.has(normalizeKey(next.name))) { next.name = newText; changed = true; }
                next.relatedEntities = rewriteArray(next.relatedEntities || []);
                if (JSON.stringify(next.relatedEntities || []) !== JSON.stringify(directive.relatedEntities || [])) changed = true;
                return next;
            };
            additionalState.sceneInterventions = (additionalState.sceneInterventions || []).map(rewriteDirective);
            additionalState.worldDeltas = (additionalState.worldDeltas || []).map(rewriteDirective);
            additionalState.characterAdditions = (additionalState.characterAdditions || []).map(rewriteDirective);
            if (changed) additionalState.lastUpdated = Date.now();
            return { changed };
        };
        const getState = () => additionalState;
        const resetState = (nextState = null) => {
            additionalState = normalizeState(nextState || defaultState());
            return additionalState;
        };

        return {
            loadState,
            saveState,
            formatForPrompt,
            formatWorldCodexForPrompt,
            refreshWorldCodexFromContext,
            formatStateForAnalysis,
            ingestMaintenance,
            normalizeMaintenancePayload,
            buildHeuristicMaintenance,
            upsertDirective,
            mergeDuplicateDirectives,
            deleteItem,
            setInjectionState,
            renameEntityReferences,
            getState,
            resetState,
            // 사용자 가시성 (GUI 가 읽는다)
            getSelectionDiagnostics,
            getStatusLabel,
            getRejectReasonLabel,
            // 카드 인라인 편집
            updateDirectiveFields,
            getDirectiveEditableFields
        };
    })();

    // ══════════════════════════════════════════════════════════════
    // [MANAGER] User DLC — user-authored, world-adaptive additions
    // Kept in its own lorebook DB so ordinary World Additional analysis,
    // cold start, and historical reanalysis cannot overwrite user designs.
    // ══════════════════════════════════════════════════════════════
    const UserDlcCore = (() => {
        const DLC_COMMENT = 'lmai_user_dlc';
        const DLC_SCHEMA = 'libra.user_dlc.v1';
        const WORLD_KINDS = new Set(['tool', 'contraceptive', 'dungeon', 'monster', 'drop_item', 'experience_system', 'monster_gate', 'magic', 'sorcery', 'magic_array', 'magic_wand', 'magic_circle', 'skill', 'superpower', 'trap', 'crisis', 'hazard', 'mechanism', 'lore', 'location', 'faction', 'rule', 'history', 'artifact', 'custom']);
        const WORLD_STATUSES = new Set(['draft', 'analyzed', 'armed', 'injected', 'manifested', 'retired']);
        const CANON_COMPATIBILITY_STATUSES = new Set(['compatible', 'adapted', 'pending_adaptation', 'pending_review', 'unverified', 'conflicted']);
        const normalizeCanonCompatibilityStatus = (value = '', fallback = 'unverified') => {
            const normalized = String(value || fallback || 'unverified').toLowerCase().trim();
            return CANON_COMPATIBILITY_STATUSES.has(normalized) ? normalized : fallback;
        };
        const clip = (value = '', max = 360) => truncateForLLM(String(value || '').replace(/\s+/g, ' ').trim(), max, ' ... ');
        const textArray = (items = [], limit = 12, max = 260) => dedupeTextArray(
            (Array.isArray(items) ? items : (items ? [items] : []))
                .map(item => typeof item === 'string' ? item : (item?.text || item?.value || item?.label || item?.name || item?.title || item?.summary || ''))
                .map(item => clip(item, max))
                .filter(Boolean)
        ).slice(0, Math.max(1, Number(limit || 12)));
        const normalizeKey = (value = '') => String(value || '').normalize('NFKC').toLowerCase()
            .replace(/[^a-z0-9\u3131-\u318e\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9fff]+/g, ' ')
            .replace(/\s+/g, ' ').trim();
        const defaultState = () => ({
            schema: DLC_SCHEMA,
            version: 1,
            scopeKey: '',
            chatId: '',
            worldItems: [],
            targetAnalyses: [],
            entityTrackers: [],
            analysisLog: [],
            lastTurn: 0,
            lastUpdated: 0,
            settings: { worldInjectionEnabled: true, entityReferenceEnabled: true, maxWorldItemsPerRequest: 2, maxEntityAnalysesPerRequest: 6, maxTrackersPerAnalysis: 16 }
        });
        let state = defaultState();
        const similarityTokens = (value = '') => new Set(normalizeKey(value).split(/\s+/).filter(token => token.length >= 2));
        const jaccardSimilarity = (left = new Set(), right = new Set()) => {
            if (!left.size || !right.size) return 0;
            let intersection = 0; left.forEach(token => { if (right.has(token)) intersection += 1; });
            return intersection / Math.max(1, left.size + right.size - intersection);
        };
        const worldDuplicateScore = (left = {}, right = {}) => {
            if (String(left.kind || 'custom') !== String(right.kind || 'custom')) return 0;
            const leftTitle = normalizeKey(left.title || ''); const rightTitle = normalizeKey(right.title || '');
            const genericTitle = /^(?:사용자 dlc 요소|user dlc item|unnamed|untitled)$/i;
            if (leftTitle && leftTitle === rightTitle && !genericTitle.test(leftTitle)) return 1;
            if (leftTitle.length >= 5 && rightTitle.length >= 5 && (leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle))) return 0.96;
            const titleScore = jaccardSimilarity(similarityTokens(leftTitle), similarityTokens(rightTitle));
            const leftBody = [left.userConcept, left.adaptedConcept, left.mechanism, left.trigger, ...(left.relatedEntities || []), ...(left.sourceBasis || [])].filter(Boolean).join(' ');
            const rightBody = [right.userConcept, right.adaptedConcept, right.mechanism, right.trigger, ...(right.relatedEntities || []), ...(right.sourceBasis || [])].filter(Boolean).join(' ');
            const bodyScore = jaccardSimilarity(similarityTokens(leftBody), similarityTokens(rightBody));
            return titleScore >= 0.7 && bodyScore >= 0.62 ? 0.9 : (bodyScore >= 0.84 ? 0.88 : 0);
        };
        const mergeText = (left = '', right = '', max = 1200) => {
            const a = String(left || '').trim(); const b = String(right || '').trim();
            if (!a) return clip(b, max); if (!b) return clip(a, max);
            const ak = normalizeKey(a); const bk = normalizeKey(b);
            if (ak.includes(bk)) return clip(a, max); if (bk.includes(ak)) return clip(b, max);
            return clip(`${a}\n${b}`, max);
        };
        const earliestPositiveNumber = (...values) => {
            const numbers = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
            return numbers.length ? Math.min(...numbers) : 0;
        };

        const normalizeFinding = (finding = {}) => {
            const source = finding && typeof finding === 'object' && !Array.isArray(finding) ? finding : { value: finding };
            const label = clip(source.label || source.key || source.aspect || source.title || '분석', 100);
            const value = clip(source.value || source.text || source.summary || source.finding || source.description || '', 700);
            if (!value) return null;
            return {
                key: clip(source.key || stableHash(`${normalizeKey(label)}:${normalizeKey(value).slice(0, 180)}`).slice(0, 12), 40),
                label,
                value,
                evidence: textArray(source.evidence || source.sourceBasis || source.sources || [], 6, 240),
                confidence: clip(source.confidence || 'inferred', 40),
                dbCompatibility: normalizeCanonCompatibilityStatus(source.dbCompatibility || source.db_compatibility || source.canonStatus || source.canon_status || 'unverified'),
                conflicts: textArray(source.conflicts || source.dbConflicts || source.db_conflicts || [], 6, 240)
            };
        };
        const normalizeFindings = (items = [], limit = 24) => (Array.isArray(items) ? items : [])
            .map(normalizeFinding).filter(Boolean).slice(-Math.max(1, Number(limit || 24)));
        const CONTRACEPTIVE_METHOD_CLASSES = new Set(['barrier', 'hormonal', 'chemical', 'device', 'emergency', 'surgical', 'magical', 'technological', 'alchemical', 'hybrid', 'other']);
        const CONTRACEPTIVE_RELIABILITY_TIERS = new Set(['unknown', 'low', 'moderate', 'high', 'very_high']);
        const CONTRACEPTIVE_REVERSIBILITY = new Set(['unknown', 'reversible', 'long_acting_reversible', 'permanent']);
        const CONTRACEPTIVE_PROTECTION_SCOPES = new Set(['unknown', 'pregnancy_only', 'pregnancy_and_infection', 'infection_only']);
        const normalizeContraceptiveProfile = (value = {}, fallback = {}) => {
            const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const prior = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
            const methodClassRaw = String(source.methodClass || source.method_class || prior.methodClass || 'other').toLowerCase().trim();
            const reliabilityRaw = String(source.reliabilityTier || source.reliability_tier || prior.reliabilityTier || 'unknown').toLowerCase().trim();
            const reversibilityRaw = String(source.reversibility || prior.reversibility || 'unknown').toLowerCase().trim();
            const protectionScopeRaw = String(source.protectionScope || source.protection_scope || prior.protectionScope || 'unknown').toLowerCase().trim();
            return {
                methodClass: CONTRACEPTIVE_METHOD_CLASSES.has(methodClassRaw) ? methodClassRaw : 'other',
                form: clip(source.form || prior.form || '', 180),
                useProtocol: clip(source.useProtocol || source.use_protocol || prior.useProtocol || '', 800),
                onset: clip(source.onset || prior.onset || '', 300),
                effectiveWindow: clip(source.effectiveWindow || source.effective_window || source.duration || prior.effectiveWindow || '', 360),
                reliabilityTier: CONTRACEPTIVE_RELIABILITY_TIERS.has(reliabilityRaw) ? reliabilityRaw : 'unknown',
                failureConditions: textArray(source.failureConditions || source.failure_conditions || source.failureModes || prior.failureConditions || [], 10, 320),
                sideEffects: textArray(source.sideEffects || source.side_effects || prior.sideEffects || [], 10, 320),
                availability: clip(source.availability || source.access || prior.availability || '', 500),
                reversibility: CONTRACEPTIVE_REVERSIBILITY.has(reversibilityRaw) ? reversibilityRaw : 'unknown',
                protectionScope: CONTRACEPTIVE_PROTECTION_SCOPES.has(protectionScopeRaw) ? protectionScopeRaw : 'unknown',
                settingBasis: clip(source.settingBasis || source.setting_basis || prior.settingBasis || '', 500)
            };
        };
        const mergeContraceptiveProfiles = (primary = {}, duplicate = {}) => {
            const prior = normalizeContraceptiveProfile(primary || {});
            const next = normalizeContraceptiveProfile(duplicate || {});
            const preferKnown = (incoming, existing, unknown = 'unknown') => incoming && incoming !== unknown ? incoming : existing;
            return normalizeContraceptiveProfile({
                methodClass: preferKnown(next.methodClass, prior.methodClass, 'other'),
                form: next.form || prior.form,
                useProtocol: next.useProtocol || prior.useProtocol,
                onset: next.onset || prior.onset,
                effectiveWindow: next.effectiveWindow || prior.effectiveWindow,
                reliabilityTier: preferKnown(next.reliabilityTier, prior.reliabilityTier),
                failureConditions: textArray([...(prior.failureConditions || []), ...(next.failureConditions || [])], 14, 320),
                sideEffects: textArray([...(prior.sideEffects || []), ...(next.sideEffects || [])], 14, 320),
                availability: next.availability || prior.availability,
                reversibility: preferKnown(next.reversibility, prior.reversibility),
                protectionScope: preferKnown(next.protectionScope, prior.protectionScope),
                settingBasis: next.settingBasis || prior.settingBasis
            });
        };
        const FANTASY_SYSTEM_KINDS = new Set(['dungeon', 'monster', 'drop_item', 'experience_system', 'monster_gate', 'magic', 'sorcery', 'magic_array', 'magic_wand', 'magic_circle', 'skill', 'superpower']);
        const normalizeFantasySystemProfile = (value = {}) => {
            const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            return {
                category: clip(source.category || source.subtype || '', 120),
                rank: clip(source.rank || source.tier || source.grade || '', 100),
                rarity: clip(source.rarity || '', 100),
                levelRange: clip(source.levelRange || source.level_range || '', 160),
                origin: clip(source.origin || '', 500),
                acquisition: clip(source.acquisition || source.obtainMethod || source.obtain_method || '', 600),
                activation: clip(source.activation || source.activationMethod || source.activation_method || '', 700),
                duration: clip(source.duration || '', 320),
                prerequisites: textArray(source.prerequisites || source.requirements || [], 12, 300),
                costs: textArray(source.costs || source.resourceCosts || source.resource_costs || [], 12, 300),
                limits: textArray(source.limits || source.restrictions || [], 12, 320),
                progressionRules: textArray(source.progressionRules || source.progression_rules || source.progression || [], 12, 340),
                rewardRules: textArray(source.rewardRules || source.reward_rules || source.rewards || [], 12, 340),
                drops: textArray(source.drops || source.dropTable || source.drop_table || [], 16, 300),
                weaknesses: textArray(source.weaknesses || source.vulnerabilities || [], 12, 300),
                entryConditions: textArray(source.entryConditions || source.entry_conditions || [], 12, 320),
                exitConditions: textArray(source.exitConditions || source.exit_conditions || [], 12, 320),
                spawnConditions: textArray(source.spawnConditions || source.spawn_conditions || [], 12, 320),
                failureConsequences: textArray(source.failureConsequences || source.failure_consequences || [], 12, 320),
                antiExploitRules: textArray(source.antiExploitRules || source.anti_exploit_rules || [], 12, 320),
                relatedElements: textArray(source.relatedElements || source.related_elements || source.links || [], 20, 140),
                settingBasis: clip(source.settingBasis || source.setting_basis || '', 600)
            };
        };
        const mergeFantasySystemProfiles = (primary = {}, duplicate = {}) => {
            const prior = normalizeFantasySystemProfile(primary || {});
            const next = normalizeFantasySystemProfile(duplicate || {});
            const mergeList = key => textArray([...(prior[key] || []), ...(next[key] || [])], key === 'relatedElements' ? 24 : 16, key === 'relatedElements' ? 140 : 340);
            return normalizeFantasySystemProfile({
                category: next.category || prior.category,
                rank: next.rank || prior.rank,
                rarity: next.rarity || prior.rarity,
                levelRange: next.levelRange || prior.levelRange,
                origin: next.origin || prior.origin,
                acquisition: next.acquisition || prior.acquisition,
                activation: next.activation || prior.activation,
                duration: next.duration || prior.duration,
                prerequisites: mergeList('prerequisites'),
                costs: mergeList('costs'),
                limits: mergeList('limits'),
                progressionRules: mergeList('progressionRules'),
                rewardRules: mergeList('rewardRules'),
                drops: mergeList('drops'),
                weaknesses: mergeList('weaknesses'),
                entryConditions: mergeList('entryConditions'),
                exitConditions: mergeList('exitConditions'),
                spawnConditions: mergeList('spawnConditions'),
                failureConsequences: mergeList('failureConsequences'),
                antiExploitRules: mergeList('antiExploitRules'),
                relatedElements: mergeList('relatedElements'),
                settingBasis: next.settingBasis || prior.settingBasis
            });
        };
        const normalizeWorldItem = (item = {}, fallback = {}) => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
            const kindRaw = String(source.kind || source.type || fallback.kind || 'custom').toLowerCase().trim();
            const kindAliases = {
                contraception: 'contraceptive', contraceptive_tool: 'contraceptive', birth_control: 'contraceptive',
                creature: 'monster', loot: 'drop_item', loot_item: 'drop_item', drop: 'drop_item',
                experience: 'experience_system', xp: 'experience_system', experience_points: 'experience_system',
                gate: 'monster_gate', monstergate: 'monster_gate', spell: 'magic', witchcraft: 'sorcery',
                magic_formation: 'magic_array', magic_diagram: 'magic_array', wand: 'magic_wand', staff: 'magic_wand', magic_staff: 'magic_wand',
                circle: 'magic_circle', magic_rank_circle: 'magic_circle', ability: 'skill', super_power: 'superpower', psychic: 'superpower'
            };
            const kindAlias = kindAliases[kindRaw] || kindRaw;
            const kind = WORLD_KINDS.has(kindAlias) ? kindAlias : 'custom';
            const userConcept = clip(source.userConcept || source.user_concept || source.concept || fallback.userConcept || '', 1800);
            const title = clip(source.title || source.name || fallback.title || userConcept.slice(0, 72) || '사용자 DLC 요소', 140);
            if (!userConcept && !source.adaptedConcept && !source.adapted_concept) return null;
            const turn = Number(source.updatedTurn || source.createdTurn || fallback.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            const id = clip(source.id || fallback.id || `udlc_w_${stableHash(`${kind}:${normalizeKey(title)}:${normalizeKey(userConcept).slice(0, 300)}`).slice(0, 12)}`, 80);
            const statusRaw = String(source.status || fallback.status || 'analyzed').toLowerCase().trim();
            const compatibility = source.canonCompatibility || source.canon_compatibility || {};
            const compatibilityStatus = normalizeCanonCompatibilityStatus(compatibility.status || source.compatibilityStatus || 'adapted', 'adapted');
            const conflictBlocked = compatibilityStatus === 'conflicted';
            const rawContraceptiveProfile = source.contraceptiveProfile || source.contraceptive_profile || source.contraceptionProfile || source.contraception_profile;
            const contraceptiveProfile = kind === 'contraceptive'
                ? normalizeContraceptiveProfile(rawContraceptiveProfile || {})
                : null;
            const rawFantasySystemProfile = source.fantasySystemProfile || source.fantasy_system_profile || source.gameplayProfile || source.gameplay_profile;
            const fantasySystemProfile = FANTASY_SYSTEM_KINDS.has(kind)
                ? normalizeFantasySystemProfile(rawFantasySystemProfile || {})
                : null;
            return {
                id, kind, title, userConcept,
                adaptedConcept: clip(source.adaptedConcept || source.adapted_concept || source.description || '', 2400),
                worldFitSummary: clip(source.worldFitSummary || source.world_fit_summary || '', 900),
                mechanism: clip(source.mechanism || '', 1000),
                trigger: clip(source.trigger || source.activationCondition || source.activation_condition || '', 700),
                effects: textArray(source.effects || [], 10, 360),
                counterplay: textArray(source.counterplay || source.countermeasures || [], 10, 360),
                risks: textArray(source.risks || source.failureModes || [], 10, 360),
                activationCondition: clip(source.activationCondition || source.activation_condition || source.trigger || '', 700),
                progressionTier: clip(source.progressionTier || source.progression_tier || 'section', 40),
                userImpact: clip(source.userImpact || source.user_impact || 'soft', 40),
                relatedEntities: textArray(source.relatedEntities || source.related_entities || [], 12, 120),
                relatedWorldRules: textArray(source.relatedWorldRules || source.related_world_rules || [], 12, 240),
                sourceBasis: textArray(source.sourceBasis || source.source_basis || [], 14, 320),
                contraceptiveProfile,
                fantasySystemProfile,
                canonCompatibility: {
                    status: compatibilityStatus,
                    conflicts: textArray(compatibility.conflicts || source.conflicts || [], 8, 320),
                    adaptations: textArray(compatibility.adaptations || source.adaptations || [], 10, 320)
                },
                analysisPrompt: clip(source.analysisPrompt || source.analysis_prompt || fallback.analysisPrompt || '', 1800),
                registrationSource: clip(source.registrationSource || source.registration_source || fallback.registrationSource || 'llm_analysis', 40),
                manualInjection: conflictBlocked ? false : (source.manualInjection === true || source.manual_injection === true),
                injectionDisabled: conflictBlocked || source.injectionDisabled === true || source.injection_disabled === true,
                status: conflictBlocked ? 'draft' : (WORLD_STATUSES.has(statusRaw) ? statusRaw : 'analyzed'),
                revision: Math.max(1, Number(source.revision || fallback.revision || 1) || 1),
                createdTurn: Number(source.createdTurn || fallback.createdTurn || turn) || 0,
                updatedTurn: turn,
                createdAt: Number(source.createdAt || fallback.createdAt || Date.now()) || Date.now(),
                lastUpdated: Number(source.lastUpdated || Date.now()) || Date.now(),
                history: (Array.isArray(source.history) ? source.history : []).slice(-8)
            };
        };
        const normalizeTargetAnalysis = (item = {}, fallback = {}) => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
            const typeRaw = String(source.targetType || source.target_type || fallback.targetType || 'entity').toLowerCase();
            const targetType = typeRaw === 'relation' ? 'relation' : 'entity';
            const targetIds = textArray(source.targetIds || source.target_ids || source.entityIds || source.entity_ids || fallback.targetIds || [], 8, 100);
            const displayName = clip(source.displayName || source.display_name || source.targetName || source.target_name || fallback.displayName || targetIds.join(' ↔ '), 180);
            if (!targetIds.length && !displayName) return null;
            const id = clip(source.id || fallback.id || `udlc_${targetType}_${stableHash(`${targetType}:${targetIds.join('|') || normalizeKey(displayName)}`).slice(0, 12)}`, 80);
            const turn = Number(source.updatedTurn || source.createdTurn || fallback.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            const compatibility = source.canonCompatibility || source.canon_compatibility || {};
            const compatibilityStatus = normalizeCanonCompatibilityStatus(compatibility.status || source.compatibilityStatus || 'unverified');
            const conflictBlocked = compatibilityStatus === 'conflicted';
            return {
                id, targetType, targetIds, displayName,
                prompt: clip(source.prompt || source.analysisPrompt || source.analysis_prompt || fallback.prompt || '', 2400),
                promptHistory: textArray(source.promptHistory || source.prompt_history || [], 12, 500),
                summary: clip(source.summary || source.analysis || source.result || '', 1800),
                findings: normalizeFindings(source.findings || source.details || [], 24),
                continuityEffects: textArray(source.continuityEffects || source.continuity_effects || [], 12, 360),
                narrativeUses: textArray(source.narrativeUses || source.narrative_uses || [], 12, 360),
                relationshipImplications: textArray(source.relationshipImplications || source.relationship_implications || [], 12, 360),
                worldFitSummary: clip(source.worldFitSummary || source.world_fit_summary || '', 900),
                sourceBasis: textArray(source.sourceBasis || source.source_basis || [], 14, 320),
                canonCompatibility: {
                    status: compatibilityStatus,
                    conflicts: textArray(compatibility.conflicts || source.conflicts || [], 10, 320),
                    adaptations: textArray(compatibility.adaptations || source.adaptations || [], 10, 320)
                },
                registrationSource: clip(source.registrationSource || source.registration_source || fallback.registrationSource || 'llm_analysis', 40),
                manualInjection: conflictBlocked ? false : (source.manualInjection === true || source.manual_injection === true),
                injectionDisabled: conflictBlocked || source.injectionDisabled === true || source.injection_disabled === true,
                revision: Math.max(1, Number(source.revision || fallback.revision || 1) || 1),
                createdTurn: Number(source.createdTurn || fallback.createdTurn || turn) || 0,
                updatedTurn: turn,
                createdAt: Number(source.createdAt || fallback.createdAt || Date.now()) || Date.now(),
                lastUpdated: Number(source.lastUpdated || Date.now()) || Date.now(),
                history: (Array.isArray(source.history) ? source.history : []).slice(-8)
            };
        };
        const TRACKER_VALUE_TYPES = new Set(['status', 'boolean', 'number', 'text']);
        const TRACKER_UPDATE_MODES = new Set(['relevant', 'every_turn', 'manual']);
        const TRACKER_CONFIDENCE = new Set(['confirmed', 'likely', 'possible', 'uncertain', 'unknown']);
        const TRACKER_KINDS = new Set(['state', 'scenario_response', 'relationship_model', 'capability', 'reproductive_health', 'health_risk', 'sexual_history']);
        const EVENT_RESOLUTION_MODES = new Set(['none', 'single_event_locked']);
        const SEXUAL_HISTORY_COUNT_FIELDS = ['sexCount', 'masturbationCount', 'pregnancyCount', 'birthCount', 'vaginalEjaculationCount', 'fellatioCount', 'analSexCount'];
        const SEXUAL_HISTORY_SNAPSHOT_FIELDS = [...SEXUAL_HISTORY_COUNT_FIELDS, 'virginityStatus', 'distinctPartnerCount', 'firstSexPartner', 'knownSexPartners', 'sexualHistoryCountingBasis', 'sexualHistoryNote'];
        const probabilityNumber = (value, fallback = null) => {
            const number = Number(value);
            return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number * 100) / 100)) : fallback;
        };
        const nonNegativeCount = (value, fallback = null, max = 999999999) => {
            if (value === null || value === undefined || value === '') return fallback;
            const number = Math.floor(Number(value));
            return Number.isFinite(number) ? Math.max(0, Math.min(max, number)) : fallback;
        };
        const normalizeVirginityStatus = (value = '') => {
            const raw = String(value || '').toLowerCase().trim();
            if (!raw) return '';
            if (['sexually_experienced', 'experienced', 'not_virgin', 'nonvirgin'].includes(raw)) return 'sexually_experienced';
            if (['no_confirmed_sex_experience', 'no_experience', 'inexperienced', 'virgin'].includes(raw)) return 'no_confirmed_sex_experience';
            return 'unknown';
        };
        const normalizeSexualHistoryCountingBasis = (value = '') => {
            const raw = String(value || '').toLowerCase().trim();
            if (!raw) return '';
            return ['canonical_total', 'observed_minimum'].includes(raw) ? raw : 'unknown';
        };
        const normalizeSexualHistoryDelta = (value = {}) => {
            const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const readCount = (camel, snake) => {
                if (!Object.prototype.hasOwnProperty.call(source, camel) && !Object.prototype.hasOwnProperty.call(source, snake)) return null;
                return nonNegativeCount(source[camel] ?? source[snake], null, 100);
            };
            const rawVirginity = source.virginityStatus ?? source.virginity_status;
            return {
                sexCount: readCount('sexCount', 'sex_count'),
                masturbationCount: readCount('masturbationCount', 'masturbation_count'),
                pregnancyCount: readCount('pregnancyCount', 'pregnancy_count'),
                birthCount: readCount('birthCount', 'birth_count'),
                vaginalEjaculationCount: readCount('vaginalEjaculationCount', 'vaginal_ejaculation_count'),
                fellatioCount: readCount('fellatioCount', 'fellatio_count'),
                analSexCount: readCount('analSexCount', 'anal_sex_count'),
                newPartnerCount: readCount('newPartnerCount', 'new_partner_count'),
                virginityStatus: rawVirginity === null || rawVirginity === undefined || rawVirginity === '' ? '' : normalizeVirginityStatus(rawVirginity),
                partnerNames: textArray(source.partnerNames || source.partner_names || source.partners || [], 12, 120),
                firstSexPartner: clip(source.firstSexPartner || source.first_sex_partner || '', 180)
            };
        };
        const sexualHistoryDeltaHasData = (delta = {}) => SEXUAL_HISTORY_COUNT_FIELDS.some(key => Number(delta?.[key] || 0) > 0)
            || Number(delta?.newPartnerCount || 0) > 0
            || !!delta?.virginityStatus
            || !!delta?.firstSexPartner
            || (Array.isArray(delta?.partnerNames) && delta.partnerNames.length > 0);
        const stripSexualHistorySnapshotFields = (snapshot = {}) => Object.fromEntries(Object.entries(snapshot || {})
            .filter(([key]) => !SEXUAL_HISTORY_SNAPSHOT_FIELDS.includes(key)));
        const applySexualHistoryDelta = (snapshot = {}, delta = {}) => {
            const next = normalizeAdaptiveSnapshot(snapshot);
            let observedFromUnknown = false;
            for (const key of SEXUAL_HISTORY_COUNT_FIELDS) {
                const increment = nonNegativeCount(delta?.[key], null, 100);
                if (increment === null || increment <= 0) continue;
                const previous = nonNegativeCount(next[key], null);
                if (previous === null) observedFromUnknown = true;
                next[key] = (previous === null ? 0 : previous) + increment;
            }
            const newPartnerCount = nonNegativeCount(delta?.newPartnerCount, null, 100);
            if (newPartnerCount !== null && newPartnerCount > 0) {
                const previousCount = nonNegativeCount(next.distinctPartnerCount, null);
                if (previousCount === null) observedFromUnknown = true;
                next.distinctPartnerCount = (previousCount === null ? 0 : previousCount) + newPartnerCount;
            }
            const previousPartners = textArray(next.knownSexPartners || [], 40, 120);
            const partnerNames = textArray(delta?.partnerNames || [], 12, 120);
            next.knownSexPartners = [...new Map([...previousPartners, ...partnerNames].map(name => [normalizeKey(name), name])).values()].filter(Boolean).slice(0, 40);
            if (next.knownSexPartners.length) {
                const previousCount = nonNegativeCount(next.distinctPartnerCount, null);
                next.distinctPartnerCount = Math.max(previousCount === null ? 0 : previousCount, next.knownSexPartners.length);
                if (previousCount === null) observedFromUnknown = true;
            }
            if ((!next.firstSexPartner || normalizeKey(next.firstSexPartner) === 'unknown') && delta?.firstSexPartner) next.firstSexPartner = clip(delta.firstSexPartner, 180);
            if (Number(delta?.sexCount || 0) > 0) next.virginityStatus = 'sexually_experienced';
            else if (delta?.virginityStatus) next.virginityStatus = normalizeVirginityStatus(delta.virginityStatus);
            if (observedFromUnknown && next.sexualHistoryCountingBasis !== 'canonical_total') next.sexualHistoryCountingBasis = 'observed_minimum';
            next.sexualHistoryNote = next.sexualHistoryCountingBasis === 'observed_minimum'
                ? '정본상 생애 총계가 확인되지 않아 현재 숫자는 직접 확인된 사건의 최소 누적치입니다.'
                : next.sexualHistoryNote;
            return normalizeAdaptiveSnapshot(next);
        };
        const mergeSexualHistorySnapshots = (previous = {}, incomingPatch = {}) => {
            const oldSnapshot = normalizeAdaptiveSnapshot(previous);
            const next = normalizeAdaptiveSnapshot({ ...oldSnapshot, ...(incomingPatch || {}) });
            for (const key of [...SEXUAL_HISTORY_COUNT_FIELDS, 'distinctPartnerCount']) {
                const oldCount = nonNegativeCount(oldSnapshot[key], null);
                const incomingCount = nonNegativeCount(incomingPatch?.[key], null);
                next[key] = oldCount === null ? incomingCount : (incomingCount === null ? oldCount : Math.max(oldCount, incomingCount));
            }
            next.knownSexPartners = [...new Map([
                ...textArray(oldSnapshot.knownSexPartners || [], 40, 120),
                ...textArray(incomingPatch?.knownSexPartners || [], 40, 120)
            ].map(name => [normalizeKey(name), name])).values()].filter(Boolean).slice(0, 40);
            if (next.knownSexPartners.length) next.distinctPartnerCount = Math.max(nonNegativeCount(next.distinctPartnerCount, 0), next.knownSexPartners.length);
            next.firstSexPartner = oldSnapshot.firstSexPartner || next.firstSexPartner || '';
            next.virginityStatus = oldSnapshot.virginityStatus === 'sexually_experienced'
                ? 'sexually_experienced'
                : (next.virginityStatus && next.virginityStatus !== 'unknown' ? next.virginityStatus : oldSnapshot.virginityStatus);
            next.sexualHistoryCountingBasis = oldSnapshot.sexualHistoryCountingBasis === 'canonical_total'
                ? 'canonical_total'
                : (next.sexualHistoryCountingBasis && next.sexualHistoryCountingBasis !== 'unknown' ? next.sexualHistoryCountingBasis : oldSnapshot.sexualHistoryCountingBasis);
            next.sexualHistoryNote = next.sexualHistoryNote || oldSnapshot.sexualHistoryNote;
            return normalizeAdaptiveSnapshot(next);
        };
        const normalizeAdaptiveSnapshot = (value = {}) => {
            const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const probabilityMin = probabilityNumber(source.probabilityMin ?? source.probability_min ?? source.riskMin ?? source.risk_min, null);
            const probabilityMax = probabilityNumber(source.probabilityMax ?? source.probability_max ?? source.riskMax ?? source.risk_max, null);
            const cycleNumber = (raw, min, max) => {
                const parsed = Math.floor(Number(raw));
                return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : null;
            };
            return {
                summary: clip(source.summary || source.currentSummary || source.current_summary || '', 1000),
                relationshipState: clip(source.relationshipState || source.relationship_state || '', 700),
                probabilityMin,
                probabilityMax,
                probabilityLabel: clip(source.probabilityLabel || source.probability_label || source.riskLabel || source.risk_label || '', 80),
                expectedResponse: clip(source.expectedResponse || source.expected_response || source.response || '', 1400),
                dialogueExamples: textArray(source.dialogueExamples || source.dialogue_examples || source.dialogue || [], 6, 420),
                defenseAssessment: clip(source.defenseAssessment || source.defense_assessment || '', 1100),
                sceneDate: clip(source.sceneDate || source.scene_date || source.storyDate || source.story_date || '', 100),
                cycleModel: clip(source.cycleModel || source.cycle_model || '', 80),
                cycleAnchorDate: clip(source.cycleAnchorDate || source.cycle_anchor_date || '', 100),
                cycleLengthDays: cycleNumber(source.cycleLengthDays ?? source.cycle_length_days, 15, 60),
                cycleDay: cycleNumber(source.cycleDay ?? source.cycle_day, 1, 60),
                bleedingDurationDays: cycleNumber(source.bleedingDurationDays ?? source.bleeding_duration_days, 1, 14),
                fertileWindowStartDay: cycleNumber(source.fertileWindowStartDay ?? source.fertile_window_start_day, 1, 60),
                fertileWindowEndDay: cycleNumber(source.fertileWindowEndDay ?? source.fertile_window_end_day, 1, 60),
                cycleStatus: clip(source.cycleStatus || source.cycle_status || '', 500),
                fertilityWindow: clip(source.fertilityWindow || source.fertility_window || '', 500),
                contraception: clip(source.contraception || source.contraceptionStatus || source.contraception_status || '', 700),
                healthStatus: clip(source.healthStatus || source.health_status || '', 700),
                sexCount: nonNegativeCount(source.sexCount ?? source.sex_count, null),
                virginityStatus: normalizeVirginityStatus(source.virginityStatus ?? source.virginity_status),
                masturbationCount: nonNegativeCount(source.masturbationCount ?? source.masturbation_count, null),
                pregnancyCount: nonNegativeCount(source.pregnancyCount ?? source.pregnancy_count, null),
                birthCount: nonNegativeCount(source.birthCount ?? source.birth_count, null),
                distinctPartnerCount: nonNegativeCount(source.distinctPartnerCount ?? source.distinct_partner_count, null),
                vaginalEjaculationCount: nonNegativeCount(source.vaginalEjaculationCount ?? source.vaginal_ejaculation_count, null),
                fellatioCount: nonNegativeCount(source.fellatioCount ?? source.fellatio_count, null),
                analSexCount: nonNegativeCount(source.analSexCount ?? source.anal_sex_count, null),
                firstSexPartner: clip(source.firstSexPartner || source.first_sex_partner || '', 180),
                knownSexPartners: textArray(source.knownSexPartners || source.known_sex_partners || [], 40, 120),
                sexualHistoryCountingBasis: normalizeSexualHistoryCountingBasis(source.sexualHistoryCountingBasis ?? source.sexual_history_counting_basis),
                sexualHistoryNote: clip(source.sexualHistoryNote || source.sexual_history_note || '', 700),
                nextEvaluation: clip(source.nextEvaluation || source.next_evaluation || '', 500),
                confidenceNote: clip(source.confidenceNote || source.confidence_note || '', 500)
            };
        };
        const normalizeAdaptiveSnapshotPatch = (value = {}) => {
            const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const normalized = normalizeAdaptiveSnapshot(source);
            const aliases = {
                summary: ['summary', 'currentSummary', 'current_summary'],
                relationshipState: ['relationshipState', 'relationship_state'],
                probabilityMin: ['probabilityMin', 'probability_min', 'riskMin', 'risk_min'],
                probabilityMax: ['probabilityMax', 'probability_max', 'riskMax', 'risk_max'],
                probabilityLabel: ['probabilityLabel', 'probability_label', 'riskLabel', 'risk_label'],
                expectedResponse: ['expectedResponse', 'expected_response', 'response'],
                dialogueExamples: ['dialogueExamples', 'dialogue_examples', 'dialogue'],
                defenseAssessment: ['defenseAssessment', 'defense_assessment'],
                sceneDate: ['sceneDate', 'scene_date', 'storyDate', 'story_date'],
                cycleModel: ['cycleModel', 'cycle_model'],
                cycleAnchorDate: ['cycleAnchorDate', 'cycle_anchor_date'],
                cycleLengthDays: ['cycleLengthDays', 'cycle_length_days'],
                cycleDay: ['cycleDay', 'cycle_day'],
                bleedingDurationDays: ['bleedingDurationDays', 'bleeding_duration_days'],
                fertileWindowStartDay: ['fertileWindowStartDay', 'fertile_window_start_day'],
                fertileWindowEndDay: ['fertileWindowEndDay', 'fertile_window_end_day'],
                cycleStatus: ['cycleStatus', 'cycle_status'],
                fertilityWindow: ['fertilityWindow', 'fertility_window'],
                contraception: ['contraception', 'contraceptionStatus', 'contraception_status'],
                healthStatus: ['healthStatus', 'health_status'],
                sexCount: ['sexCount', 'sex_count'],
                virginityStatus: ['virginityStatus', 'virginity_status'],
                masturbationCount: ['masturbationCount', 'masturbation_count'],
                pregnancyCount: ['pregnancyCount', 'pregnancy_count'],
                birthCount: ['birthCount', 'birth_count'],
                distinctPartnerCount: ['distinctPartnerCount', 'distinct_partner_count'],
                vaginalEjaculationCount: ['vaginalEjaculationCount', 'vaginal_ejaculation_count'],
                fellatioCount: ['fellatioCount', 'fellatio_count'],
                analSexCount: ['analSexCount', 'anal_sex_count'],
                firstSexPartner: ['firstSexPartner', 'first_sex_partner'],
                knownSexPartners: ['knownSexPartners', 'known_sex_partners'],
                sexualHistoryCountingBasis: ['sexualHistoryCountingBasis', 'sexual_history_counting_basis'],
                sexualHistoryNote: ['sexualHistoryNote', 'sexual_history_note'],
                nextEvaluation: ['nextEvaluation', 'next_evaluation'],
                confidenceNote: ['confidenceNote', 'confidence_note']
            };
            return Object.fromEntries(Object.entries(aliases)
                .filter(([, keys]) => keys.some(key => Object.prototype.hasOwnProperty.call(source, key)))
                .map(([key]) => [key, normalized[key]]));
        };
        const adaptiveSnapshotHasData = (snapshot = {}) => Object.values(snapshot || {}).some(value => Array.isArray(value)
            ? value.length > 0
            : (value !== '' && value !== null && value !== undefined));
        const ensureFictionalRpCycleSnapshot = (tracker = {}) => {
            const snapshot = normalizeAdaptiveSnapshot(tracker.currentSnapshot || {});
            if (String(tracker.kind || '') !== 'reproductive_health') return snapshot;
            const hasCycleDefinition = !!snapshot.cycleModel
                || snapshot.cycleLengthDays !== null
                || !!snapshot.cycleStatus
                || !!snapshot.fertilityWindow;
            if (hasCycleDefinition) return snapshot;
            const seedText = `${tracker.id || ''}:${tracker.targetIds?.join('|') || tracker.displayName || ''}:${tracker.createdTurn || 0}`;
            const seed = parseInt(stableHash(seedText).slice(-7), 36) || 1;
            const cycleLengthDays = 24 + (seed % 12);
            const bleedingDurationDays = 3 + (Math.floor(seed / 13) % 5);
            const cycleDay = 1 + (Math.floor(seed / 67) % cycleLengthDays);
            const fertileWindowStartDay = Math.max(1, cycleLengthDays - 16);
            const fertileWindowEndDay = Math.min(cycleLengthDays, fertileWindowStartDay + 5);
            const storyDate = snapshot.sceneDate
                || (typeof TimeEngine !== 'undefined' ? String(TimeEngine.getState?.()?.currentDate || '') : '');
            const inFertileWindow = cycleDay >= fertileWindowStartDay && cycleDay <= fertileWindowEndDay;
            return normalizeAdaptiveSnapshot({
                ...snapshot,
                sceneDate: storyDate,
                cycleModel: 'fictional_rp',
                cycleAnchorDate: storyDate,
                cycleLengthDays,
                cycleDay,
                bleedingDurationDays,
                fertileWindowStartDay,
                fertileWindowEndDay,
                cycleStatus: `가상 RP 주기 · ${cycleLengthDays}일 주기 · 현재 ${cycleDay}일차 · 출혈 기간 ${bleedingDurationDays}일`,
                fertilityWindow: `가상 RP 가임 구간 ${fertileWindowStartDay}~${fertileWindowEndDay}일차 · 현재 ${inFertileWindow ? '구간 내' : '구간 밖'} (의학적 사실 아님)`,
                confidenceNote: snapshot.confidenceNote || '정본 정보가 없어 생성한 가상 역할극용 주기입니다. 실제 의학적 예측이나 조언으로 사용하지 않습니다.'
            });
        };
        const normalizeScenarioBands = (items = []) => (Array.isArray(items) ? items : []).map(item => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
            const band = clip(source.band || source.relationshipBand || source.relationship_band || source.label || '', 80);
            const expectedResponse = clip(source.expectedResponse || source.expected_response || source.response || '', 900);
            if (!band && !expectedResponse) return null;
            return {
                band,
                conditions: textArray(source.conditions || [], 8, 260),
                probabilityMin: probabilityNumber(source.probabilityMin ?? source.probability_min, null),
                probabilityMax: probabilityNumber(source.probabilityMax ?? source.probability_max, null),
                expectedResponse,
                dialogueExamples: textArray(source.dialogueExamples || source.dialogue_examples || [], 4, 360)
            };
        }).filter(Boolean).slice(0, 10);
        const normalizeEventLedger = (items = []) => (Array.isArray(items) ? items : []).map(item => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
            const eventKey = clip(source.eventKey || source.event_key || source.id || '', 120);
            if (!eventKey) return null;
            const sexualHistoryDelta = normalizeSexualHistoryDelta(source.sexualHistoryDelta || source.sexual_history_delta || {});
            return {
                eventKey,
                eventType: clip(source.eventType || source.event_type || 'event', 60),
                sceneDate: clip(source.sceneDate || source.scene_date || '', 100),
                probabilityMin: probabilityNumber(source.probabilityMin ?? source.probability_min, 0),
                probabilityMax: probabilityNumber(source.probabilityMax ?? source.probability_max, 0),
                resolutionRoll: probabilityNumber(source.resolutionRoll ?? source.resolution_roll, 0),
                lockedOutcome: clip(source.lockedOutcome || source.locked_outcome || 'pending', 60),
                ...(sexualHistoryDeltaHasData(sexualHistoryDelta) ? { sexualHistoryDelta } : {}),
                evidence: textArray(source.evidence || [], 8, 320),
                turn: Number(source.turn || 0) || 0,
                createdAt: Number(source.createdAt || source.created_at || Date.now()) || Date.now()
            };
        }).filter(Boolean).slice(-40);
        const normalizeTrackerValue = (value, valueType = 'status', allowedValues = []) => {
            if (value === null || value === undefined) return '';
            if (valueType === 'boolean') {
                if (value === true || /^(?:true|yes|on|1)$/i.test(String(value).trim())) return 'true';
                if (value === false || /^(?:false|no|off|0)$/i.test(String(value).trim())) return 'false';
                if (/^(?:unknown|uncertain)$/i.test(String(value).trim())) return 'unknown';
                return '';
            }
            if (valueType === 'number') {
                const raw = String(value).trim();
                return raw && Number.isFinite(Number(raw)) ? raw : '';
            }
            const normalized = clip(value, valueType === 'text' ? 700 : 120);
            if (!normalized) return '';
            if (valueType !== 'status' || !allowedValues.length) return normalized;
            const match = allowedValues.find(item => normalizeKey(item) === normalizeKey(normalized));
            return match || '';
        };
        const normalizeEntityTracker = (item = {}, fallback = {}) => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
            const typeRaw = String(source.targetType || source.target_type || fallback.targetType || 'entity').toLowerCase();
            const targetType = typeRaw === 'relation' ? 'relation' : 'entity';
            const targetIds = textArray(source.targetIds || source.target_ids || fallback.targetIds || [], 8, 100);
            const displayName = clip(source.displayName || source.display_name || fallback.displayName || targetIds.join(' ↔ '), 180);
            const label = clip(source.label || source.name || source.title || fallback.label || '사용자 상태 추적', 120);
            const instruction = clip(source.instruction || source.prompt || source.analysisPrompt || fallback.instruction || '', 2400);
            if ((!targetIds.length && !displayName) || !instruction) return null;
            const trackerKindRaw = String(source.kind || source.trackerKind || source.tracker_kind || fallback.kind || 'state').toLowerCase().trim();
            const kind = TRACKER_KINDS.has(trackerKindRaw) ? trackerKindRaw : 'state';
            const valueTypeRaw = String(source.valueType || source.value_type || fallback.valueType || 'status').toLowerCase();
            const valueType = TRACKER_VALUE_TYPES.has(valueTypeRaw) ? valueTypeRaw : 'status';
            let allowedValues = textArray(source.allowedValues || source.allowed_values || fallback.allowedValues || [], 20, 120);
            if (valueType === 'boolean') allowedValues = ['unknown', 'true', 'false'];
            else if (valueType === 'status' && !allowedValues.length) allowedValues = ['unknown', 'possible', 'confirmed', 'resolved'];
            else if (valueType !== 'status') allowedValues = [];
            if (valueType === 'status' && !allowedValues.some(value => normalizeKey(value) === 'unknown')) allowedValues.unshift('unknown');
            const updateModeRaw = String(source.updateMode || source.update_mode || fallback.updateMode || 'relevant').toLowerCase();
            const hasExplicitTracking = typeof source.trackingEnabled === 'boolean'
                || typeof source.tracking_enabled === 'boolean'
                || typeof source.enabled === 'boolean';
            const trackingEnabled = hasExplicitTracking
                ? (source.trackingEnabled === true || source.tracking_enabled === true || source.enabled === true)
                : updateModeRaw !== 'manual';
            const updateMode = trackingEnabled
                ? (TRACKER_UPDATE_MODES.has(updateModeRaw) && updateModeRaw !== 'manual' ? updateModeRaw : 'every_turn')
                : 'manual';
            const initialValue = source.currentValue ?? source.current_value ?? fallback.currentValue ?? (valueType === 'number' || valueType === 'text' ? '' : 'unknown');
            const currentValue = normalizeTrackerValue(initialValue, valueType, allowedValues) || (valueType === 'number' || valueType === 'text' ? '' : 'unknown');
            const confidenceRaw = String(source.confidence || fallback.confidence || 'unknown').toLowerCase();
            const confidence = TRACKER_CONFIDENCE.has(confidenceRaw) ? confidenceRaw : 'unknown';
            const createdTurn = Number(source.createdTurn || fallback.createdTurn || fallback.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            const id = clip(source.id || fallback.id || `udlc_tracker_${stableHash(`${targetType}:${targetIds.join('|') || normalizeKey(displayName)}:${normalizeKey(label)}:${normalizeKey(instruction).slice(0, 300)}`).slice(0, 14)}`, 90);
            const resolutionModeRaw = String(source.eventResolutionMode || source.event_resolution_mode || fallback.eventResolutionMode || 'none').toLowerCase().trim();
            const eventResolutionMode = kind === 'sexual_history'
                ? 'single_event_locked'
                : (EVENT_RESOLUTION_MODES.has(resolutionModeRaw) ? resolutionModeRaw : 'none');
            const normalized = {
                id, targetType, targetIds, displayName, label, instruction, valueType, allowedValues, updateMode, kind,
                userRequest: clip(source.userRequest || source.user_request || source.prompt || fallback.userRequest || '', 1800),
                analysisGroupId: clip(source.analysisGroupId || source.analysis_group_id || fallback.analysisGroupId || '', 90),
                membershipActive: source.membershipActive !== false && source.membership_active !== false,
                retargetArchive: source.retargetArchive && typeof source.retargetArchive === 'object' ? {
                    removedAt: Number(source.retargetArchive.removedAt || 0) || 0,
                    removedTurn: Number(source.retargetArchive.removedTurn || 0) || 0,
                    reason: clip(source.retargetArchive.reason || '', 240),
                    previousEnabled: source.retargetArchive.previousEnabled !== false,
                    previousUpdateMode: clip(source.retargetArchive.previousUpdateMode || '', 30),
                    previousInjectionDisabled: source.retargetArchive.previousInjectionDisabled === true
                } : null,
                enabled: trackingEnabled,
                currentValue,
                confidence,
                currentSnapshot: normalizeAdaptiveSnapshot(source.currentSnapshot || source.current_snapshot || {}),
                scenarioBands: normalizeScenarioBands(source.scenarioBands || source.scenario_bands || []),
                eventResolutionMode,
                eventLedger: normalizeEventLedger(source.eventLedger || source.event_ledger || []),
                evidence: textArray(source.evidence || [], 8, 320),
                reason: clip(source.reason || '', 700),
                lastEvaluatedTurn: Number(source.lastEvaluatedTurn || source.last_evaluated_turn || 0) || 0,
                lastChangedTurn: Number(source.lastChangedTurn || source.last_changed_turn || 0) || 0,
                revision: Math.max(1, Number(source.revision || fallback.revision || 1) || 1),
                manualInjection: source.manualInjection === true || source.manual_injection === true,
                injectionDisabled: source.useEnabled === false || source.use_enabled === false || source.injectionDisabled === true || source.injection_disabled === true,
                createdTurn,
                createdAt: Number(source.createdAt || fallback.createdAt || Date.now()) || Date.now(),
                lastUpdated: Number(source.lastUpdated || Date.now()) || Date.now(),
                history: (Array.isArray(source.history) ? source.history : []).map(entry => ({
                    turn: Number(entry?.turn || 0) || 0,
                    from: clip(entry?.from || '', 120),
                    to: clip(entry?.to || '', 120),
                    confidence: TRACKER_CONFIDENCE.has(String(entry?.confidence || '').toLowerCase()) ? String(entry.confidence).toLowerCase() : 'unknown',
                    evidence: textArray(entry?.evidence || [], 6, 260),
                    reason: clip(entry?.reason || '', 500),
                    at: Number(entry?.at || Date.now()) || Date.now()
                })).slice(-30)
            };
            normalized.currentSnapshot = ensureFictionalRpCycleSnapshot(normalized);
            return normalized;
        };
        const normalizeState = (raw = {}, meta = {}) => {
            const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
            return {
                ...defaultState(),
                ...source,
                schema: DLC_SCHEMA,
                version: 1,
                scopeKey: String(meta.scopeKey || source.scopeKey || '').trim(),
                chatId: String(meta.chatId || source.chatId || '').trim(),
                worldItems: (Array.isArray(source.worldItems) ? source.worldItems : []).map(normalizeWorldItem).filter(Boolean).slice(-80),
                targetAnalyses: (Array.isArray(source.targetAnalyses) ? source.targetAnalyses : []).map(normalizeTargetAnalysis).filter(Boolean).slice(-120),
                entityTrackers: (Array.isArray(source.entityTrackers) ? source.entityTrackers : []).map(normalizeEntityTracker).filter(Boolean).slice(-160),
                analysisLog: (Array.isArray(source.analysisLog) ? source.analysisLog : []).slice(-80),
                settings: { ...defaultState().settings, ...(source.settings || {}) }
            };
        };
        const loadState = (lorebook = [], meta = {}) => {
            const entry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : []).find(item => item?.comment === DLC_COMMENT);
            if (!entry) return (state = normalizeState(defaultState(), meta));
            try { state = normalizeState(JSON.parse(entry.content || '{}'), meta); }
            catch (error) {
                recordRuntimeDebug('warn', '[LIBRA] User DLC state parse failed:', error?.message || error);
                state = normalizeState(defaultState(), meta);
            }
            return state;
        };
        const saveState = async (lorebook = []) => {
            if (!Array.isArray(lorebook)) return;
            const entry = { key: 'lmai_user_dlc::state', comment: DLC_COMMENT, content: JSON.stringify(state), mode: 'normal', insertorder: 6, alwaysActive: false };
            const idx = lorebook.findIndex(item => item?.comment === DLC_COMMENT);
            if (idx >= 0) lorebook[idx] = entry; else lorebook.push(entry);
        };
        const appendLog = (kind, id, displayName, turn, note = '') => {
            state.analysisLog = [...(state.analysisLog || []), { kind, id, displayName, turn: Number(turn || 0) || 0, note: clip(note, 260), at: Date.now() }].slice(-80);
        };
        const mergeWorldRecords = (primary = {}, duplicate = {}) => normalizeWorldItem({
            ...primary,
            userConcept: mergeText(primary.userConcept, duplicate.userConcept, 1800),
            adaptedConcept: mergeText(primary.adaptedConcept, duplicate.adaptedConcept, 2400),
            worldFitSummary: mergeText(primary.worldFitSummary, duplicate.worldFitSummary, 900),
            mechanism: mergeText(primary.mechanism, duplicate.mechanism, 1000),
            trigger: mergeText(primary.trigger, duplicate.trigger, 700),
            activationCondition: mergeText(primary.activationCondition, duplicate.activationCondition, 700),
            effects: textArray([...(primary.effects || []), ...(duplicate.effects || [])], 14, 360),
            counterplay: textArray([...(primary.counterplay || []), ...(duplicate.counterplay || [])], 14, 360),
            risks: textArray([...(primary.risks || []), ...(duplicate.risks || [])], 14, 360),
            relatedEntities: textArray([...(primary.relatedEntities || []), ...(duplicate.relatedEntities || [])], 16, 120),
            relatedWorldRules: textArray([...(primary.relatedWorldRules || []), ...(duplicate.relatedWorldRules || [])], 16, 240),
            sourceBasis: textArray([...(primary.sourceBasis || []), ...(duplicate.sourceBasis || [])], 18, 320),
            ...((primary.contraceptiveProfile || duplicate.contraceptiveProfile) ? { contraceptiveProfile: mergeContraceptiveProfiles(primary.contraceptiveProfile, duplicate.contraceptiveProfile) } : {}),
            ...((primary.fantasySystemProfile || duplicate.fantasySystemProfile) ? { fantasySystemProfile: mergeFantasySystemProfiles(primary.fantasySystemProfile, duplicate.fantasySystemProfile) } : {}),
            registrationSource: duplicate.registrationSource === 'user_manual' ? 'user_manual' : (primary.registrationSource || duplicate.registrationSource || 'llm_analysis'),
            canonCompatibility: {
                status: duplicate.registrationSource === 'llm_analysis'
                    ? normalizeCanonCompatibilityStatus(duplicate.canonCompatibility?.status || 'unverified')
                    : ([primary.canonCompatibility?.status, duplicate.canonCompatibility?.status].includes('conflicted')
                        ? 'conflicted'
                        : (duplicate.canonCompatibility?.status || primary.canonCompatibility?.status || 'unverified')),
                conflicts: textArray([...(primary.canonCompatibility?.conflicts || []), ...(duplicate.canonCompatibility?.conflicts || [])], 12, 320),
                adaptations: textArray([...(primary.canonCompatibility?.adaptations || []), ...(duplicate.canonCompatibility?.adaptations || [])], 14, 320)
            },
            manualInjection: primary.manualInjection === true || duplicate.manualInjection === true,
            injectionDisabled: primary.manualInjection === true || duplicate.manualInjection === true ? false : (primary.injectionDisabled === true && duplicate.injectionDisabled === true),
            revision: Math.max(Number(primary.revision || 1), Number(duplicate.revision || 1)) + 1,
            createdTurn: earliestPositiveNumber(primary.createdTurn, duplicate.createdTurn),
            updatedTurn: Math.max(Number(primary.updatedTurn || 0), Number(duplicate.updatedTurn || 0)),
            createdAt: Math.min(Number(primary.createdAt || Date.now()), Number(duplicate.createdAt || Date.now())),
            lastUpdated: Date.now(),
            history: [...(primary.history || []), ...(duplicate.history || []), { revision: duplicate.revision, adaptedConcept: duplicate.adaptedConcept, worldFitSummary: duplicate.worldFitSummary, updatedTurn: duplicate.updatedTurn, at: duplicate.lastUpdated }].slice(-8)
        }, { id: primary.id, title: primary.title, kind: primary.kind });
        const upsertWorldItem = (item = {}, options = {}) => {
            const normalized = normalizeWorldItem(item, { ...options, turn: options.turn });
            if (!normalized) return { changed: false, item: null };
            const list = [...(state.worldItems || [])];
            const idx = list.findIndex(current => String(current.id) === normalized.id || worldDuplicateScore(current, normalized) >= 0.88);
            if (idx >= 0) {
                const previous = list[idx];
                list[idx] = mergeWorldRecords(previous, normalized);
            } else list.push(normalized);
            state.worldItems = list.slice(-80); state.lastTurn = normalized.updatedTurn || state.lastTurn; state.lastUpdated = Date.now();
            appendLog('world', normalized.id, normalized.title, normalized.updatedTurn, idx >= 0 ? '갱신 분석' : '신규 분석');
            return { changed: true, item: idx >= 0 ? list[idx] : normalized };
        };
        const mergeFindings = (previous = [], incoming = []) => {
            const map = new Map();
            for (const finding of [...normalizeFindings(previous), ...normalizeFindings(incoming)]) map.set(normalizeKey(finding.label || finding.key), finding);
            return [...map.values()].slice(-24);
        };
        // ── 카드 인라인 편집 ────────────────────────────────────────────
        // 카드에는 투입 토글과 삭제만 있어서, 내용을 고치려면 재분석하거나 삭제 후
        // 재생성해야 했다. 그러면 revision 이력과 사용자가 켜 둔 투입 상태가 끊긴다.
        // upsertWorldItem 은 id 와 유사도(0.88)로 병합하므로 편집에 재사용할 수 없다
        // — 다른 항목과 합쳐질 수 있다. 아래는 id 가 정확히 일치하는 항목만 고친다.
        const WORLD_ITEM_EDITABLE_FIELDS = Object.freeze([
            'title', 'userConcept', 'adaptedConcept', 'worldFitSummary', 'mechanism',
            'trigger', 'effects', 'counterplay', 'risks', 'relatedEntities',
            'progressionTier', 'userImpact', 'forceLevel', 'status'
        ]);
        const getWorldItemEditableFields = () => [...WORLD_ITEM_EDITABLE_FIELDS];
        const updateWorldItemFields = (itemId = '', patch = {}, options = {}) => {
            const targetId = String(itemId || '').trim();
            if (!targetId) return { changed: false, reason: 'missing_id', item: null };
            const index = (state.worldItems || []).findIndex(current => String(current?.id || '') === targetId);
            if (index < 0) return { changed: false, reason: 'not_found', item: null };
            const current = state.worldItems[index];
            const changes = patch && typeof patch === 'object' ? patch : {};
            // 제목은 비울 수 없다 — 비면 목록에서 식별할 수 없게 된다.
            if (Object.prototype.hasOwnProperty.call(changes, 'title')
                && !String(changes.title || '').trim()) {
                return { changed: false, reason: 'empty_title', item: current };
            }
            const applied = {};
            for (const field of WORLD_ITEM_EDITABLE_FIELDS) {
                if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
                const next = changes[field];
                applied[field] = Array.isArray(next)
                    ? textArray(next, 24, 400)
                    : clip(next, 2000);
            }
            if (!Object.keys(applied).length) {
                return { changed: false, reason: 'no_editable_field', item: current };
            }
            const turn = Number(options.turn || MemoryEngine?.getCurrentTurn?.() || MemoryState?.currentTurn || 0) || 0;
            // 편집 대상 필드만 덮어쓰고 나머지는 그대로 둔다 — 투입 상태(useEnabled,
            // injectionDisabled), id, revision 이력이 여기서 보존된다.
            const updated = {
                ...current,
                ...applied,
                id: current.id,
                revision: Math.max(1, Number(current.revision || 1)) + 1,
                updatedTurn: turn || current.updatedTurn || 0,
                lastUpdated: Date.now(),
                editedByUser: true
            };
            const list = [...state.worldItems];
            list[index] = updated;
            state.worldItems = list;
            state.lastTurn = turn || state.lastTurn;
            state.lastUpdated = Date.now();
            appendLog('world', updated.id, updated.title, turn, '사용자 편집');
            return { changed: true, item: updated, appliedFields: Object.keys(applied) };
        };
        const upsertTargetAnalysis = (item = {}, options = {}) => {
            const normalized = normalizeTargetAnalysis(item, { ...options, turn: options.turn });
            if (!normalized) return { changed: false, item: null };
            const list = [...(state.targetAnalyses || [])];
            const idx = list.findIndex(current => String(current.id) === normalized.id);
            if (idx >= 0) {
                const previous = list[idx];
                normalized.history = [...(previous.history || []), { revision: previous.revision, prompt: previous.prompt, summary: previous.summary, findings: previous.findings, updatedTurn: previous.updatedTurn, at: previous.lastUpdated }].slice(-8);
                normalized.findings = mergeFindings(previous.findings, normalized.findings);
                normalized.promptHistory = textArray([...(previous.promptHistory || []), previous.prompt, normalized.prompt], 12, 500);
                normalized.revision = Math.max(Number(previous.revision || 1) + 1, Number(normalized.revision || 1));
                normalized.createdTurn = previous.createdTurn; normalized.createdAt = previous.createdAt;
                normalized.manualInjection = previous.manualInjection === true;
                normalized.injectionDisabled = previous.injectionDisabled === true;
                list[idx] = { ...previous, ...normalized };
            } else {
                normalized.promptHistory = textArray([normalized.prompt], 12, 500);
                list.push(normalized);
            }
            state.targetAnalyses = list.slice(-120); state.lastTurn = normalized.updatedTurn || state.lastTurn; state.lastUpdated = Date.now();
            appendLog(normalized.targetType, normalized.id, normalized.displayName, normalized.updatedTurn, idx >= 0 ? '누적·갱신 분석' : '신규 분석');
            return { changed: true, item: idx >= 0 ? list[idx] : normalized };
        };
        const registerWorldElement = (item = {}, options = {}) => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
            const userConcept = clip(source.userConcept || source.concept || source.description || '', 1800);
            if (!userConcept) return { changed: false, reason: 'missing_world_content', item: null };
            return upsertWorldItem({
                ...source,
                userConcept,
                adaptedConcept: clip(source.adaptedConcept || userConcept, 2400),
                worldFitSummary: clip(source.worldFitSummary || source.analysisPrompt || '', 900),
                sourceBasis: textArray([...(source.sourceBasis || []), '사용자 직접 등록'], 14, 320),
                canonCompatibility: {
                    ...(source.canonCompatibility || {}),
                    status: source.canonCompatibility?.status || 'pending_review',
                    adaptations: textArray([...(source.canonCompatibility?.adaptations || []), '실제 발현 시 현재 캐릭터 로어북과 LIBRA 세계 DB에 맞춰 표면 설정을 적응'], 10, 320)
                },
                registrationSource: 'user_manual',
                status: 'draft',
                manualInjection: false,
                injectionDisabled: true
            }, { ...options, registrationSource: 'user_manual', status: 'draft' });
        };
        const registerTargetAnalysisElement = (item = {}, options = {}) => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
            const label = clip(source.label || source.findingLabel || source.title || '사용자 분석 요소', 100);
            const value = clip(source.value || source.content || source.summary || source.analysis || '', 700);
            if (!value) return { changed: false, reason: 'missing_analysis_content', item: null };
            const base = normalizeTargetAnalysis({
                ...source,
                prompt: source.prompt || options.prompt || '[사용자 직접 등록]',
                summary: source.summary || '',
                findings: [{ label, value, evidence: ['사용자 직접 등록'], confidence: 'user_asserted' }],
                sourceBasis: textArray([...(source.sourceBasis || []), '사용자 직접 등록'], 14, 320),
                canonCompatibility: {
                    ...(source.canonCompatibility || {}),
                    status: source.canonCompatibility?.status || 'pending_review',
                    conflicts: textArray(source.canonCompatibility?.conflicts || [], 10, 320),
                    adaptations: textArray([...(source.canonCompatibility?.adaptations || []), 'LIBRA 엔티티·관계 DB와 다르면 해석 가설로만 유지'], 10, 320)
                },
                registrationSource: 'user_manual',
                manualInjection: false,
                injectionDisabled: true
            }, { ...options, registrationSource: 'user_manual', turn: options.turn });
            if (!base) return { changed: false, reason: 'missing_target', item: null };
            const list = [...(state.targetAnalyses || [])];
            const idx = list.findIndex(current => String(current.id || '') === String(base.id || ''));
            if (idx >= 0) {
                const previous = list[idx];
                list[idx] = normalizeTargetAnalysis({
                    ...previous,
                    prompt: base.prompt || previous.prompt,
                    promptHistory: textArray([...(previous.promptHistory || []), previous.prompt, base.prompt], 12, 500),
                    summary: previous.summary || base.summary || value,
                    findings: mergeFindings(previous.findings, base.findings),
                    sourceBasis: textArray([...(previous.sourceBasis || []), ...(base.sourceBasis || [])], 18, 320),
                    registrationSource: 'user_manual',
                    manualInjection: previous.manualInjection === true,
                    injectionDisabled: previous.manualInjection === true ? false : previous.injectionDisabled === true,
                    revision: Math.max(1, Number(previous.revision || 1)) + 1,
                    createdTurn: previous.createdTurn,
                    createdAt: previous.createdAt,
                    updatedTurn: base.updatedTurn,
                    lastUpdated: Date.now(),
                    history: [...(previous.history || []), { revision: previous.revision, prompt: previous.prompt, summary: previous.summary, findings: previous.findings, updatedTurn: previous.updatedTurn, at: previous.lastUpdated }].slice(-8)
                }, { id: previous.id, targetType: previous.targetType, targetIds: previous.targetIds, displayName: previous.displayName });
            } else {
                base.summary = base.summary || value;
                list.push(base);
            }
            state.targetAnalyses = list.slice(-120);
            state.lastTurn = base.updatedTurn || state.lastTurn;
            state.lastUpdated = Date.now();
            const saved = idx >= 0 ? list[idx] : base;
            appendLog(saved.targetType, saved.id, saved.displayName, saved.updatedTurn, '사용자 분석 요소 직접 등록');
            return { changed: true, item: saved, created: idx < 0 };
        };
        const registerEntityTracker = (item = {}, options = {}) => {
            const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
            const normalized = normalizeEntityTracker(item, { ...options, turn: options.turn });
            if (!normalized) return { changed: false, reason: 'missing_tracker_definition', item: null };
            const list = [...(state.entityTrackers || [])];
            const duplicateKey = `${normalized.targetType}:${[...(normalized.targetIds || [])].map(normalizeKey).sort().join('|') || normalizeKey(normalized.displayName)}:${normalized.kind || 'state'}:${normalizeKey(normalized.label)}`;
            const exactTrackerId = String(options.existingTrackerId || '').trim();
            const idx = exactTrackerId
                ? list.findIndex(current => String(current.id || '') === exactTrackerId)
                : list.findIndex(current => `${current.targetType}:${[...(current.targetIds || [])].map(normalizeKey).sort().join('|') || normalizeKey(current.displayName)}:${current.kind || 'state'}:${normalizeKey(current.label)}` === duplicateKey);
            if (idx >= 0) {
                const previous = list[idx];
                const retargeting = options.retargeting === true;
                const hasCurrentValue = Object.prototype.hasOwnProperty.call(source, 'currentValue')
                    || Object.prototype.hasOwnProperty.call(source, 'current_value');
                const snapshotPatch = normalizeAdaptiveSnapshotPatch(source.currentSnapshot || source.current_snapshot || {});
                list[idx] = normalizeEntityTracker({
                    ...previous,
                    ...normalized,
                    id: previous.id,
                    analysisGroupId: retargeting ? (normalized.analysisGroupId || previous.analysisGroupId) : (previous.analysisGroupId || normalized.analysisGroupId),
                    membershipActive: retargeting ? true : previous.membershipActive !== false,
                    retargetArchive: retargeting ? null : previous.retargetArchive,
                    enabled: retargeting ? normalized.enabled !== false : previous.enabled !== false,
                    updateMode: retargeting ? normalized.updateMode : (previous.enabled === false ? 'manual' : previous.updateMode),
                    currentValue: hasCurrentValue ? normalized.currentValue : previous.currentValue,
                    confidence: normalized.confidence !== 'unknown' ? normalized.confidence : previous.confidence,
                    currentSnapshot: adaptiveSnapshotHasData(snapshotPatch)
                        ? (normalized.kind === 'sexual_history'
                            ? mergeSexualHistorySnapshots(previous.currentSnapshot || {}, snapshotPatch)
                            : { ...(previous.currentSnapshot || {}), ...snapshotPatch })
                        : previous.currentSnapshot,
                    scenarioBands: normalized.scenarioBands?.length ? normalized.scenarioBands : previous.scenarioBands,
                    eventLedger: previous.eventLedger,
                    evidence: normalized.evidence?.length ? normalized.evidence : previous.evidence,
                    reason: normalized.reason || previous.reason,
                    lastEvaluatedTurn: previous.lastEvaluatedTurn,
                    lastChangedTurn: previous.lastChangedTurn,
                    history: previous.history,
                    manualInjection: previous.manualInjection === true,
                    injectionDisabled: retargeting ? normalized.injectionDisabled === true : previous.injectionDisabled === true,
                    revision: Math.max(1, Number(previous.revision || 1)) + 1,
                    createdTurn: previous.createdTurn,
                    createdAt: previous.createdAt,
                    lastUpdated: Date.now()
                }, { id: previous.id });
            } else list.push(normalized);
            state.entityTrackers = list.slice(-160);
            state.lastTurn = Number(options.turn || normalized.createdTurn || state.lastTurn) || state.lastTurn;
            state.lastUpdated = Date.now();
            const saved = idx >= 0 ? list[idx] : normalized;
            appendLog('tracker', saved.id, `${saved.displayName} · ${saved.label}`, state.lastTurn, idx >= 0 ? '추적 정의 갱신' : '추적 정의 등록');
            return { changed: true, item: saved, created: idx < 0 };
        };
        const ingestAdaptiveItems = (payload = {}, context = {}) => {
            const items = payload?.adaptiveItems || payload?.adaptive_items || payload?.entityTrackers || payload?.entity_trackers || payload?.trackers || [];
            return (Array.isArray(items) ? items : []).map(item => registerEntityTracker(item, context)).filter(result => result.changed);
        };
        const trackerIdentityKeys = (item = {}) => new Set([
            ...(Array.isArray(item.targetIds) ? item.targetIds : []),
            item.displayName
        ].map(normalizeKey).filter(Boolean));
        const reconcileTrackerTargets = (sourceTrackerId = '', payload = {}, selectedTargetIds = [], options = {}) => {
            const sourceId = String(sourceTrackerId || '').trim();
            const source = (state.entityTrackers || []).find(item => String(item.id || '') === sourceId);
            if (!source) return { changed: false, reason: 'source_tracker_not_found', active: [], archived: [] };
            const items = payload?.adaptiveItems || payload?.adaptive_items || payload?.entityTrackers || payload?.entity_trackers || payload?.trackers || [];
            const adaptiveItems = Array.isArray(items) ? items.filter(item => item && typeof item === 'object') : [];
            if (!adaptiveItems.length) return { changed: false, reason: 'missing_reanalysis_items', active: [], archived: [] };
            const groupId = clip(source.analysisGroupId || `udlc_group_${stableHash(`retarget:${source.id}`).slice(0, 16)}`, 90);
            const existingMembers = (state.entityTrackers || []).filter(item =>
                String(item.id || '') === source.id || (source.analysisGroupId && String(item.analysisGroupId || '') === String(source.analysisGroupId))
            );
            const selectedKeys = new Set(textArray(selectedTargetIds, 160, 120).map(normalizeKey).filter(Boolean));
            const active = [];
            let added = 0;
            let updated = 0;
            for (const adaptive of adaptiveItems) {
                const adaptiveKeys = trackerIdentityKeys(adaptive);
                const previous = existingMembers.find(member => [...trackerIdentityKeys(member)].some(key => adaptiveKeys.has(key)));
                const definition = {
                    ...adaptive,
                    id: previous?.id,
                    targetType: 'entity',
                    kind: source.kind,
                    label: source.label,
                    instruction: adaptive.instruction || source.instruction,
                    userRequest: options.userRequest || source.userRequest,
                    analysisGroupId: groupId,
                    membershipActive: true,
                    trackingEnabled: true,
                    enabled: true,
                    updateMode: source.updateMode === 'relevant' ? 'relevant' : 'every_turn',
                    useEnabled: true,
                    injectionDisabled: false,
                    retargetArchive: null
                };
                const result = registerEntityTracker(definition, {
                    ...options,
                    existingTrackerId: previous?.id || '',
                    retargeting: true,
                    analysisGroupId: groupId
                });
                if (result.changed && result.item) {
                    active.push(result.item);
                    if (previous) updated += 1; else added += 1;
                }
            }
            const activeKeys = new Set(active.flatMap(item => [...trackerIdentityKeys(item)]));
            const archived = [];
            state.entityTrackers = (state.entityTrackers || []).map(item => {
                const isMember = String(item.id || '') === source.id || String(item.analysisGroupId || '') === groupId;
                if (!isMember) return item;
                const itemKeys = trackerIdentityKeys(item);
                const remainsSelected = [...itemKeys].some(key => activeKeys.has(key) || selectedKeys.has(key));
                if (remainsSelected) return { ...item, analysisGroupId: groupId, membershipActive: true, retargetArchive: null };
                const next = {
                    ...item,
                    analysisGroupId: groupId,
                    membershipActive: false,
                    enabled: false,
                    updateMode: 'manual',
                    injectionDisabled: true,
                    retargetArchive: {
                        removedAt: Date.now(),
                        removedTurn: Number(options.turn || state.lastTurn || 0) || 0,
                        reason: '유저 DLC 추적 대상 구성에서 제외됨',
                        previousEnabled: item.enabled !== false,
                        previousUpdateMode: item.updateMode,
                        previousInjectionDisabled: item.injectionDisabled === true
                    },
                    lastUpdated: Date.now()
                };
                archived.push(next);
                return next;
            });
            state.lastTurn = Number(options.turn || state.lastTurn || 0) || state.lastTurn;
            state.lastUpdated = Date.now();
            appendLog('tracker_retarget', groupId, source.label, state.lastTurn, `대상 재구성 · 유지/추가 ${active.length} · 보관 ${archived.length}`);
            return { changed: true, groupId, active, archived, added, updated };
        };
        const setTrackerEnabled = (id = '', enabled = false) => {
            const targetId = String(id || '').trim();
            const idx = (state.entityTrackers || []).findIndex(item => String(item.id || '') === targetId);
            if (idx < 0) return { changed: false, reason: 'not_found', id: targetId };
            if (enabled === true && state.entityTrackers[idx]?.membershipActive === false) {
                return { changed: false, reason: 'archived_target_membership', id: targetId, item: state.entityTrackers[idx] };
            }
            state.entityTrackers[idx] = {
                ...state.entityTrackers[idx],
                enabled: enabled === true,
                updateMode: enabled === true
                    ? (state.entityTrackers[idx].updateMode === 'relevant' ? 'relevant' : 'every_turn')
                    : 'manual',
                lastUpdated: Date.now()
            };
            state.lastUpdated = Date.now();
            appendLog('tracker_enabled', targetId, state.entityTrackers[idx].label, state.lastTurn, enabled ? '자동 추적 ON' : '자동 추적 OFF');
            return { changed: true, enabled: enabled === true, item: state.entityTrackers[idx] };
        };
        const normalizeTrackerUpdates = (updates = []) => (Array.isArray(updates) ? updates : [])
            .map(update => {
                if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
                const trackerId = clip(update.trackerId || update.tracker_id || update.id || '', 90);
                if (!trackerId) return null;
                const confidenceRaw = String(update.confidence || 'unknown').toLowerCase();
                const dbCompatibilityRaw = String(update.dbCompatibility || update.db_compatibility || '').toLowerCase().trim();
                const hasProvidedValue = Object.prototype.hasOwnProperty.call(update, 'value')
                    || Object.prototype.hasOwnProperty.call(update, 'currentValue')
                    || Object.prototype.hasOwnProperty.call(update, 'current_value');
                return {
                    trackerId,
                    value: update.value ?? update.currentValue ?? update.current_value,
                    hasProvidedValue,
                    confidence: TRACKER_CONFIDENCE.has(confidenceRaw) ? confidenceRaw : 'unknown',
                    currentSnapshot: normalizeAdaptiveSnapshotPatch(update.currentSnapshot || update.current_snapshot || update.snapshot || {}),
                    eventKey: clip(update.eventKey || update.event_key || '', 120),
                    eventType: clip(update.eventType || update.event_type || '', 60),
                    probabilityMin: probabilityNumber(update.probabilityMin ?? update.probability_min ?? update.riskMin ?? update.risk_min, null),
                    probabilityMax: probabilityNumber(update.probabilityMax ?? update.probability_max ?? update.riskMax ?? update.risk_max, null),
                    sceneDate: clip(update.sceneDate || update.scene_date || '', 100),
                    sexualHistoryDelta: normalizeSexualHistoryDelta(update.sexualHistoryDelta || update.sexual_history_delta || {}),
                    evidence: textArray(update.evidence || update.evidenceRefs || update.evidence_refs || [], 8, 320),
                    reason: clip(update.reason || update.note || '', 700),
                    dbCompatibility: ['compatible', 'explicit_transition', 'conflicted'].includes(dbCompatibilityRaw) ? dbCompatibilityRaw : 'unverified',
                    dbConflicts: textArray(update.dbConflicts || update.db_conflicts || update.conflicts || [], 6, 260),
                    relevant: update.relevant !== false
                };
            }).filter(Boolean).slice(0, 48);
        const trackerEvidenceSupportedByAssistant = (evidence = '', assistantText = '') => {
            const evidenceKey = normalizeKey(evidence);
            const assistantKey = normalizeKey(assistantText);
            if (!evidenceKey) return false;
            if (!assistantKey) return true; // Manual/core API calls may not supply source text; live commits always do.
            if (evidenceKey.length >= 6 && assistantKey.includes(evidenceKey)) return true;
            const evidenceTokens = [...similarityTokens(evidenceKey)];
            const assistantTokens = similarityTokens(assistantKey);
            if (!evidenceTokens.length) return false;
            const overlap = evidenceTokens.filter(token => assistantTokens.has(token)).length;
            if (evidenceTokens.length <= 2) return overlap === evidenceTokens.length;
            return overlap >= 2 && overlap / evidenceTokens.length >= 0.28;
        };
        const applyTrackerUpdates = (updates = [], context = {}) => {
            const normalizedUpdates = normalizeTrackerUpdates(updates);
            const turn = Number(context.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            const assistantText = String(context.assistantText || context.aiResponse || '');
            let evaluated = 0; let changed = 0; const applied = [];
            for (const update of normalizedUpdates) {
                const idx = (state.entityTrackers || []).findIndex(item => String(item.id || '') === update.trackerId);
                if (idx < 0 || state.entityTrackers[idx]?.enabled === false || update.relevant === false) continue;
                const tracker = state.entityTrackers[idx];
                const normalizedProvidedValue = normalizeTrackerValue(update.value, tracker.valueType, tracker.allowedValues || []);
                // If the model supplied a value, an out-of-schema value invalidates the whole update.
                // Snapshot-only updates omit the value and retain the existing compact status instead.
                if (update.hasProvidedValue && !normalizedProvidedValue) continue;
                const nextValue = normalizedProvidedValue || String(tracker.currentValue || '');
                const supportedEvidence = update.evidence.filter(evidence => trackerEvidenceSupportedByAssistant(evidence, assistantText));
                const hasSnapshotUpdate = adaptiveSnapshotHasData(update.currentSnapshot);
                const hasEventUpdate = !!update.eventKey;
                const hasSexualHistoryDelta = tracker.kind === 'sexual_history' && sexualHistoryDeltaHasData(update.sexualHistoryDelta);
                // Sexual-history counters are event sourced. Never accept a bare increment that cannot be deduplicated.
                if (hasSexualHistoryDelta && !hasEventUpdate) continue;
                // A model response cannot mutate a tracker without direct current-turn evidence and an explicit LIBRA DB compatibility verdict.
                if ((!nextValue && !hasSnapshotUpdate && !hasEventUpdate && !hasSexualHistoryDelta) || !supportedEvidence.length || !['compatible', 'explicit_transition'].includes(update.dbCompatibility)) {
                    if (update.dbCompatibility === 'conflicted') appendLog('conflict_blocked', tracker.id, `${tracker.displayName} · ${tracker.label}`, turn, `상태 갱신 차단: ${update.dbConflicts.join('; ') || update.reason || 'LIBRA DB 충돌'}`);
                    continue;
                }
                evaluated += 1;
                const didChange = String(nextValue) !== String(tracker.currentValue || '');
                const timeState = typeof TimeEngine !== 'undefined' ? (TimeEngine.getState?.() || {}) : {};
                let eventLedger = [...(tracker.eventLedger || [])];
                let lockedEvent = null;
                let createdNewEvent = false;
                if (hasEventUpdate && tracker.eventResolutionMode === 'single_event_locked') {
                    lockedEvent = eventLedger.find(event => String(event.eventKey || '') === update.eventKey) || null;
                    if (!lockedEvent) {
                        createdNewEvent = true;
                        if (tracker.kind === 'sexual_history') {
                            lockedEvent = {
                                eventKey: update.eventKey,
                                eventType: update.eventType || 'sexual_history_event',
                                sceneDate: update.sceneDate || update.currentSnapshot?.sceneDate || timeState.currentDate || '',
                                probabilityMin: 100,
                                probabilityMax: 100,
                                resolutionRoll: 0,
                                lockedOutcome: 'depicted',
                                sexualHistoryDelta: update.sexualHistoryDelta,
                                evidence: supportedEvidence,
                                turn,
                                createdAt: Date.now()
                            };
                        } else {
                            const minRisk = update.probabilityMin ?? update.currentSnapshot?.probabilityMin ?? 0;
                            const maxRisk = update.probabilityMax ?? update.currentSnapshot?.probabilityMax ?? minRisk;
                            const lower = probabilityNumber(Math.min(minRisk, maxRisk), 0);
                            const upper = probabilityNumber(Math.max(minRisk, maxRisk), lower);
                            const hashNumber = parseInt(stableHash(`${state.scopeKey || state.chatId || 'scope'}:${tracker.id}:${update.eventKey}`), 36) || 0;
                            const resolutionRoll = Math.round(((hashNumber % 10000) / 100) * 100) / 100;
                            const threshold = Math.round(((lower + upper) / 2) * 100) / 100;
                            lockedEvent = {
                                eventKey: update.eventKey,
                                eventType: update.eventType || tracker.kind || 'event',
                                sceneDate: update.sceneDate || update.currentSnapshot?.sceneDate || timeState.currentDate || '',
                                probabilityMin: lower,
                                probabilityMax: upper,
                                resolutionRoll,
                                lockedOutcome: resolutionRoll < threshold ? 'occurred' : 'not_occurred',
                                evidence: supportedEvidence,
                                turn,
                                createdAt: Date.now()
                            };
                        }
                        eventLedger.push(lockedEvent);
                        eventLedger = eventLedger.slice(-40);
                    }
                }
                const snapshotPatch = tracker.kind === 'sexual_history'
                    ? stripSexualHistorySnapshotFields(update.currentSnapshot)
                    : update.currentSnapshot;
                let nextSnapshot = normalizeAdaptiveSnapshot({
                    ...(tracker.currentSnapshot || {}),
                    ...(hasSnapshotUpdate ? snapshotPatch : {}),
                    ...(tracker.kind !== 'sexual_history' && update.probabilityMin !== null ? { probabilityMin: update.probabilityMin } : {}),
                    ...(tracker.kind !== 'sexual_history' && update.probabilityMax !== null ? { probabilityMax: update.probabilityMax } : {}),
                    ...(update.sceneDate ? { sceneDate: update.sceneDate } : {}),
                    ...(lockedEvent && tracker.kind !== 'sexual_history' ? {
                        probabilityMin: lockedEvent.probabilityMin,
                        probabilityMax: lockedEvent.probabilityMax,
                        sceneDate: lockedEvent.sceneDate || update.sceneDate || timeState.currentDate || '',
                        confidenceNote: `사건 ${lockedEvent.eventKey}의 확률 판정은 1회 고정되었으며 매 턴 재추첨하지 않습니다.`
                    } : lockedEvent ? {
                        sceneDate: lockedEvent.sceneDate || update.sceneDate || timeState.currentDate || '',
                        confidenceNote: `사건 ${lockedEvent.eventKey}은 이미 한 번만 집계되도록 고정되었습니다.`
                    } : {})
                });
                if (tracker.kind === 'sexual_history' && createdNewEvent && hasSexualHistoryDelta) {
                    nextSnapshot = applySexualHistoryDelta(nextSnapshot, update.sexualHistoryDelta);
                }
                const richChanged = JSON.stringify(nextSnapshot) !== JSON.stringify(tracker.currentSnapshot || {})
                    || eventLedger.length !== (tracker.eventLedger || []).length;
                const history = didChange ? [...(tracker.history || []), {
                    turn,
                    from: tracker.currentValue || '',
                    to: nextValue,
                    confidence: update.confidence,
                    evidence: supportedEvidence,
                    reason: update.reason,
                    at: Date.now()
                }].slice(-30) : (tracker.history || []);
                state.entityTrackers[idx] = {
                    ...tracker,
                    currentValue: nextValue,
                    confidence: update.confidence,
                    currentSnapshot: nextSnapshot,
                    eventLedger,
                    evidence: supportedEvidence,
                    reason: update.reason,
                    lastEvaluatedTurn: turn,
                    lastChangedTurn: didChange ? turn : tracker.lastChangedTurn,
                    revision: didChange ? Math.max(1, Number(tracker.revision || 1)) + 1 : tracker.revision,
                    lastUpdated: Date.now(),
                    history
                };
                if (didChange || richChanged) changed += 1;
                applied.push(state.entityTrackers[idx]);
                appendLog('tracker_update', tracker.id, `${tracker.displayName} · ${tracker.label}`, turn, didChange ? `${tracker.currentValue || '(empty)'} → ${nextValue}` : `상태 유지: ${nextValue}`);
            }
            if (evaluated) { state.lastTurn = turn || state.lastTurn; state.lastUpdated = Date.now(); }
            return { changed: changed > 0, changedCount: changed, evaluated, applied };
        };
        const mergeDuplicateItems = () => {
            let mergedWorld = 0; let mergedTargets = 0;
            const worldOutput = [];
            for (const item of state.worldItems || []) {
                const idx = worldOutput.findIndex(current => worldDuplicateScore(current, item) >= 0.88);
                if (idx < 0) worldOutput.push(item); else { worldOutput[idx] = mergeWorldRecords(worldOutput[idx], item); mergedWorld += 1; }
            }
            const targetOutput = [];
            for (const item of state.targetAnalyses || []) {
                const key = `${item.targetType}:${[...(item.targetIds || [])].map(normalizeKey).sort().join('|') || normalizeKey(item.displayName)}`;
                const idx = targetOutput.findIndex(current => `${current.targetType}:${[...(current.targetIds || [])].map(normalizeKey).sort().join('|') || normalizeKey(current.displayName)}` === key);
                if (idx < 0) targetOutput.push(item);
                else {
                    const previous = targetOutput[idx];
                    targetOutput[idx] = normalizeTargetAnalysis({
                        ...previous,
                        prompt: item.prompt || previous.prompt,
                        promptHistory: textArray([...(previous.promptHistory || []), ...(item.promptHistory || []), previous.prompt, item.prompt], 12, 500),
                        summary: mergeText(previous.summary, item.summary, 1800),
                        findings: mergeFindings(previous.findings, item.findings),
                        continuityEffects: textArray([...(previous.continuityEffects || []), ...(item.continuityEffects || [])], 16, 360),
                        narrativeUses: textArray([...(previous.narrativeUses || []), ...(item.narrativeUses || [])], 16, 360),
                        relationshipImplications: textArray([...(previous.relationshipImplications || []), ...(item.relationshipImplications || [])], 16, 360),
                        sourceBasis: textArray([...(previous.sourceBasis || []), ...(item.sourceBasis || [])], 18, 320),
                        canonCompatibility: {
                            status: [previous.canonCompatibility?.status, item.canonCompatibility?.status].includes('conflicted') ? 'conflicted' : (item.canonCompatibility?.status || previous.canonCompatibility?.status || 'unverified'),
                            conflicts: textArray([...(previous.canonCompatibility?.conflicts || []), ...(item.canonCompatibility?.conflicts || [])], 12, 320),
                            adaptations: textArray([...(previous.canonCompatibility?.adaptations || []), ...(item.canonCompatibility?.adaptations || [])], 12, 320)
                        },
                        manualInjection: previous.manualInjection === true || item.manualInjection === true,
                        injectionDisabled: previous.manualInjection === true || item.manualInjection === true ? false : (previous.injectionDisabled === true && item.injectionDisabled === true),
                        revision: Math.max(Number(previous.revision || 1), Number(item.revision || 1)) + 1,
                        history: [...(previous.history || []), ...(item.history || []), { revision: item.revision, prompt: item.prompt, summary: item.summary, findings: item.findings, updatedTurn: item.updatedTurn, at: item.lastUpdated }].slice(-8),
                        lastUpdated: Date.now()
                    }, { id: previous.id, targetType: previous.targetType, targetIds: previous.targetIds, displayName: previous.displayName });
                    mergedTargets += 1;
                }
            }
            state.worldItems = worldOutput; state.targetAnalyses = targetOutput;
            const merged = mergedWorld + mergedTargets;
            if (merged) { state.lastUpdated = Date.now(); appendLog('merge', '', '중복 항목 병합', state.lastTurn, `World ${mergedWorld}개 · Entity/Relation ${mergedTargets}개`); }
            return { changed: merged > 0, merged, mergedWorld, mergedTargets };
        };
        const deleteItem = (kind = 'world', id = '') => {
            const targetId = String(id || '').trim(); if (!targetId) return { changed: false, reason: 'missing_id' };
            const key = kind === 'tracker' ? 'entityTrackers' : (kind === 'target' ? 'targetAnalyses' : 'worldItems');
            const before = (state[key] || []).length;
            state[key] = (state[key] || []).filter(item => String(item.id || '') !== targetId);
            const changed = state[key].length !== before;
            if (changed) { state.lastUpdated = Date.now(); appendLog('delete', targetId, kind, state.lastTurn, '사용자 삭제'); }
            return { changed, id: targetId, kind };
        };
        const setInjectionState = (kind = 'world', id = '', enabled = false) => {
            const targetId = String(id || '').trim(); if (!targetId) return { changed: false, reason: 'missing_id' };
            const key = kind === 'tracker' ? 'entityTrackers' : (kind === 'target' ? 'targetAnalyses' : 'worldItems');
            const idx = (state[key] || []).findIndex(item => String(item.id || '') === targetId);
            if (idx < 0) return { changed: false, reason: 'not_found', id: targetId, kind };
            if (key === 'entityTrackers' && enabled === true && state[key][idx]?.membershipActive === false) {
                return { changed: false, reason: 'archived_target_membership', id: targetId, kind, item: state[key][idx] };
            }
            const compatibilityStatus = normalizeCanonCompatibilityStatus(state[key][idx]?.canonCompatibility?.status || 'unverified');
            if (enabled === true && compatibilityStatus === 'conflicted') {
                appendLog('conflict_blocked', targetId, state[key][idx].displayName || state[key][idx].title || kind, state.lastTurn, 'LIBRA DB 충돌로 투입 차단');
                return { changed: false, reason: 'canon_conflict', conflictBlocked: true, item: state[key][idx], id: targetId, kind };
            }
            state[key][idx] = {
                ...state[key][idx],
                manualInjection: enabled === true,
                injectionDisabled: enabled !== true,
                ...(key === 'worldItems' && enabled === true ? { status: 'armed' } : {}),
                lastUpdated: Date.now()
            };
            state.lastUpdated = Date.now();
            appendLog('injection', targetId, state[key][idx].displayName || state[key][idx].title || kind, state.lastTurn, enabled ? '사용자 수동 투입 ON' : '사용자 투입 OFF');
            return { changed: true, enabled: enabled === true, item: state[key][idx], id: targetId, kind };
        };
        const ingestWorldAnalysis = (payload = {}, context = {}) => {
            const items = payload?.worldItems || payload?.world_items || payload?.items || (payload?.worldItem ? [payload.worldItem] : []);
            return (Array.isArray(items) ? items : []).map(item => upsertWorldItem(item, { ...context, userConcept: context.userConcept, title: context.title, kind: context.kind, analysisPrompt: context.analysisPrompt })).filter(result => result.changed);
        };
        // ── 생성 미리보기 (승인 단계) ────────────────────────────────────
        // 종전 GUI 흐름은 LLM 분석 결과를 받은 즉시 saveLoreToChar 로 커밋했다.
        // 사용자가 결과를 보기 전에 저장되므로, 잘못 적응된 요소를 되돌리려면
        // 삭제해야 했다. 아래 세 함수가 분석과 저장을 분리한다:
        //   previewWorldAnalysis = 결과를 평가만 하고 DB 는 건드리지 않는다
        //   commitWorldPreview   = 사용자가 승인할 때 그때 저장한다
        //   discardWorldPreview  = 취소하면 미리보기를 버린다
        let pendingWorldPreview = null;
        const buildWorldPreview = (payload = {}, context = {}) => {
            const rawItems = payload?.worldItems || payload?.world_items || payload?.items || (payload?.worldItem ? [payload.worldItem] : []);
            const list = Array.isArray(rawItems) ? rawItems : [];
            const turn = Number(context.turn || 0) || 0;
            const existing = Array.isArray(state.worldItems) ? state.worldItems : [];
            const existingKeys = new Set(existing.map(item => normalizeKey(item?.title || item?.id || '')));
            const items = [];
            const conflicts = [];
            for (const raw of list) {
                const source = raw && typeof raw === 'object' ? raw : {};
                const title = clip(source.title || source.name || '', 140) || '(제목 없음)';
                const compat = source.canonCompatibility || source.canon_compatibility || {};
                const status = String(compat?.status || '').trim().toLowerCase();
                const conflictList = textArray(compat?.conflicts || compat?.conflict || [], 6, 200);
                const conflict = status === 'conflicted';
                const duplicate = existingKeys.has(normalizeKey(title));
                // 충돌 항목은 종전에도 활성화가 차단된다(quarantine). 미리보기에서도
                // 같은 판정을 그대로 보여주어야 사용자가 승인 여부를 판단할 수 있다.
                const blocked = conflict || duplicate;
                const reason = conflict
                    ? `LIBRA DB와 충돌: ${conflictList[0] || '해결되지 않은 충돌'}`
                    : (duplicate ? '같은 제목의 요소가 이미 있습니다 (자동 병합됨)' : '추가됨');
                const entry = {
                    index: items.length,
                    kind: clip(source.kind || 'custom', 40),
                    title,
                    adaptedConcept: clip(source.adaptedConcept || source.adapted_concept || source.concept || '', 400),
                    mechanism: clip(source.mechanism || '', 300),
                    trigger: clip(source.trigger || source.activationCondition || source.activation_condition || '', 300),
                    counterplay: clip(source.counterplay || source.counter_play || '', 300),
                    canonStatus: status || 'unknown',
                    conflicts: conflictList,
                    blocked,
                    reason,
                    duplicate
                };
                items.push(entry);
                if (conflict) conflicts.push({ title, conflicts: conflictList, reason });
            }
            const wouldAdd = items.filter(it => !it.duplicate).length;
            return {
                id: `udlc_preview_${stableHash(`${turn}:${Date.now()}:${normalizeKey(context.userConcept || '')}`).slice(0, 12)}`,
                turn,
                userConcept: clip(context.userConcept || '', 400),
                createdAt: Date.now(),
                items,
                conflicts,
                wouldAdd,
                blocked: items.filter(it => it.blocked).length,
                payload: { ...payload }
            };
        };
        const previewWorldAnalysis = (payload = {}, context = {}) => {
            const preview = buildWorldPreview(payload, context);
            pendingWorldPreview = preview;
            return preview;
        };
        const commitWorldPreview = (previewId = null, context = {}) => {
            const preview = pendingWorldPreview;
            if (!preview) return { committed: false, reason: 'no_preview', added: 0 };
            if (previewId && String(previewId) !== String(preview.id)) {
                return { committed: false, reason: 'preview_id_mismatch', added: 0 };
            }
            const saved = ingestWorldAnalysis(preview.payload, {
                ...context,
                turn: Number(context.turn || preview.turn || 0) || 0,
                userConcept: preview.userConcept,
                kind: context.kind || 'auto',
                title: context.title || ''
            });
            pendingWorldPreview = null;
            return {
                committed: true,
                added: saved.length,
                blockedTitles: preview.items.filter(it => it.blocked).map(it => it.title),
                previewId: preview.id
            };
        };
        const discardWorldPreview = (previewId = null) => {
            const preview = pendingWorldPreview;
            if (!preview) return { discarded: false, reason: 'no_preview' };
            if (previewId && String(previewId) !== String(preview.id)) {
                return { discarded: false, reason: 'preview_id_mismatch' };
            }
            pendingWorldPreview = null;
            return { discarded: true, previewId: preview.id };
        };
        const getPendingWorldPreview = () => (pendingWorldPreview ? { ...pendingWorldPreview } : null);
        const ingestTargetAnalysis = (payload = {}, context = {}) => {
            const items = payload?.targetAnalyses || payload?.target_analyses || payload?.analyses || (payload?.analysis ? [payload.analysis] : []);
            return (Array.isArray(items) ? items : []).map(item => upsertTargetAnalysis(item, context)).filter(result => result.changed);
        };
        const cacheValues = (cache) => cache instanceof Map ? [...cache.values()] : (Array.isArray(cache) ? cache : Object.values(cache || {}));
        const activeUserDlcEntityBlocklist = () => {
            try {
                return normalizeEntityBlocklistCollection(
                    (typeof MemoryEngine !== 'undefined' && MemoryEngine?.CONFIG)
                        ? MemoryEngine.CONFIG.entityBlocklist
                        : []
                );
            } catch (_) {
                return [];
            }
        };
        const isTargetBlocked = (item = {}, lorebook = []) => {
            const blockedNames = activeUserDlcEntityBlocklist();
            if (!blockedNames.length) return false;
            const displaySegments = String(item?.displayName || '')
                .split(/\s*(?:↔|→|←|·|\||,|\/|::)\s*/g)
                .map(value => String(value || '').trim())
                .filter(Boolean);
            const references = textArray([
                ...(Array.isArray(item?.targetIds) ? item.targetIds : []),
                ...(Array.isArray(item?.entityIds) ? item.entityIds : []),
                ...displaySegments
            ], 32, 180);
            if (references.some(name => EntityManager?.isBlockedEntityName?.(name, lorebook) === true)) return true;
            const blockedKeys = new Set(blockedNames.map(normalizeKey).filter(Boolean));
            return references.some(name => blockedKeys.has(normalizeKey(name)));
        };
        const storedRecordsByComment = (lorebook = [], comment = '') => {
            const records = [];
            for (const entry of LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])) {
                if (String(entry?.comment || '') !== comment) continue;
                try {
                    const parsed = JSON.parse(String(entry?.content || '{}'));
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed);
                } catch (_) { /* malformed stored rows are omitted from target selection */ }
            }
            return records;
        };
        const listEntityTargets = (lorebook = []) => {
            const output = []; const seen = new Set();
            const records = [...cacheValues(EntityManager.getEntityCache?.()), ...storedRecordsByComment(lorebook, 'lmai_entity')];
            records.forEach((entity, index) => {
                const displayName = clip(entity?.name || entity?.displayName || entity?.canonicalName || entity?.id || `Entity ${index + 1}`, 160);
                if (EntityManager?.isBlockedEntityName?.(displayName, lorebook) === true) return;
                const id = clip(entity?.id || entity?.entityId || displayName, 100);
                const key = normalizeKey(id || displayName); if (!displayName || !key || seen.has(key)) return; seen.add(key);
                output.push({ id, displayName, type: entity?.type || entity?.category || entity?.role || '', raw: entity });
            });
            return output.sort((a, b) => a.displayName.localeCompare(b.displayName));
        };
        const listRelationTargets = (lorebook = []) => {
            const output = []; const seen = new Set();
            const records = [...cacheValues(EntityManager.getRelationCache?.()), ...storedRecordsByComment(lorebook, 'lmai_relation')];
            records.forEach((relation, index) => {
                const a = clip(relation?.entityA || relation?.from || relation?.source || relation?.a || relation?.subject || '', 120);
                const b = clip(relation?.entityB || relation?.to || relation?.target || relation?.b || relation?.object || '', 120);
                if (EntityManager?.isBlockedEntityName?.(a, lorebook) === true || EntityManager?.isBlockedEntityName?.(b, lorebook) === true) return;
                const relationName = clip(relation?.displayName || relation?.name || relation?.relationType || relation?.type || relation?.relation || '관계', 100);
                const displayName = clip(relation?.displayName || [a, relationName, b].filter(Boolean).join(' ↔ ') || `Relation ${index + 1}`, 200);
                const id = clip(relation?.id || relation?.relationId || `${a}::${b}::${relationName}`, 120);
                const key = normalizeKey(id || displayName); if (!displayName || !key || seen.has(key)) return; seen.add(key);
                output.push({ id, displayName, entityIds: textArray([a, b], 2, 120), raw: relation });
            });
            return output.sort((a, b) => a.displayName.localeCompare(b.displayName));
        };
        const formatWorldForPrompt = (ctx = {}, maxChars = 3600) => {
            const manualItems = (state.worldItems || []).filter(item => item.manualInjection === true && item.injectionDisabled !== true);
            if (state.settings?.worldInjectionEnabled === false && !manualItems.length) return '';
            const maxItems = Math.max(1, Math.min(4, Number(state.settings?.maxWorldItemsPerRequest || 2) || 2));
            const userMessageKey = normalizeKey(ctx.userMessage || '');
            const eligibleItems = [...(state.worldItems || [])]
                .filter(item => item.injectionDisabled !== true && ['analyzed', 'armed', 'injected'].includes(item.status))
                .filter(item => normalizeCanonCompatibilityStatus(item.canonCompatibility?.status || 'unverified') !== 'conflicted')
                .filter(item => state.settings?.worldInjectionEnabled !== false || item.manualInjection === true)
                .sort((a, b) => Number(b.manualInjection === true) - Number(a.manualInjection === true)
                    || Number(!!userMessageKey && userMessageKey.includes(normalizeKey(b.title || ''))) - Number(!!userMessageKey && userMessageKey.includes(normalizeKey(a.title || '')))
                    || Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0));
            const contraceptiveCatalog = eligibleItems.filter(item => item.contraceptiveProfile).slice(0, 8);
            const fantasySystemCatalog = eligibleItems.filter(item => item.fantasySystemProfile).slice(0, 18);
            const items = eligibleItems.slice(0, Math.max(maxItems, manualItems.length));
            if (!items.length) return '';
            const turn = Number(ctx.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            items.forEach(item => { if (item.status !== 'injected') { item.status = 'injected'; item.lastUpdated = Date.now(); } });
            state.lastTurn = turn || state.lastTurn;
            return truncateForLLM([
                '[USER DLC — WORLD / 사용자 창안 세계 요소]',
                contraceptiveCatalog.length ? `[ACTIVE CONTRACEPTIVE TOOL CATALOG] ${contraceptiveCatalog.map(item => `${item.title} (${item.contraceptiveProfile.methodClass}/${item.contraceptiveProfile.reliabilityTier}/${item.contraceptiveProfile.protectionScope})`).join('; ')}. Mentioning a stored title in the current user message prioritizes its full profile below.` : '',
                fantasySystemCatalog.length ? `[ACTIVE FANTASY/GAMEPLAY ELEMENT CATALOG] ${fantasySystemCatalog.map(item => `${item.title} [${item.kind}]${item.fantasySystemProfile.rank ? `/${item.fantasySystemProfile.rank}` : ''}`).join('; ')}. Mentioning a stored title in the current user message prioritizes its full profile below.` : '',
                fantasySystemCatalog.length ? 'Fantasy/gameplay activation rule: catalog presence establishes only that an element exists. Dungeons, gates, monsters and encounters appear only under their activation/spawn conditions. Drops, rewards and experience are granted only after an explicitly eligible completed event and never repeatedly for the same event. Magic, sorcery, circles, arrays, wands, skills and superpowers retain their prerequisites, costs, limits and counterplay.' : '',
                ...items.map(item => [
                    `- ${item.title} [${item.kind}] (DLC-ID ${item.id}; never reveal the ID; ACTIVE MANDATORY DLC)`,
                    `  Adapted form: ${item.adaptedConcept || item.userConcept}`,
                    item.worldFitSummary ? `  World fit: ${item.worldFitSummary}` : '',
                    item.mechanism ? `  Mechanism: ${item.mechanism}` : '',
                    item.trigger ? `  Trigger: ${item.trigger}` : '',
                    item.effects?.length ? `  Effects: ${item.effects.join('; ')}` : '',
                    item.counterplay?.length ? `  Counterplay: ${item.counterplay.join('; ')}` : '',
                    item.risks?.length ? `  Risks: ${item.risks.join('; ')}` : '',
                    item.activationCondition ? `  Activation: ${item.activationCondition}` : '',
                    item.relatedEntities?.length ? `  Linked entities: ${item.relatedEntities.join(', ')}` : '',
                    item.contraceptiveProfile ? `  Contraceptive class/form: ${item.contraceptiveProfile.methodClass}/${item.contraceptiveProfile.form || 'unspecified'}` : '',
                    item.contraceptiveProfile?.useProtocol ? `  Use protocol: ${item.contraceptiveProfile.useProtocol}` : '',
                    item.contraceptiveProfile?.onset ? `  Onset: ${item.contraceptiveProfile.onset}` : '',
                    item.contraceptiveProfile?.effectiveWindow ? `  Effective window: ${item.contraceptiveProfile.effectiveWindow}` : '',
                    item.contraceptiveProfile ? `  Reliability tier: ${item.contraceptiveProfile.reliabilityTier}; reversibility: ${item.contraceptiveProfile.reversibility}; protection scope: ${item.contraceptiveProfile.protectionScope}` : '',
                    item.contraceptiveProfile?.failureConditions?.length ? `  Contraceptive failure conditions: ${item.contraceptiveProfile.failureConditions.join('; ')}` : '',
                    item.contraceptiveProfile?.sideEffects?.length ? `  Side effects/constraints: ${item.contraceptiveProfile.sideEffects.join('; ')}` : '',
                    item.contraceptiveProfile?.availability ? `  Availability: ${item.contraceptiveProfile.availability}` : '',
                    item.contraceptiveProfile?.settingBasis ? `  Setting basis: ${item.contraceptiveProfile.settingBasis}` : '',
                    item.fantasySystemProfile ? `  Fantasy/gameplay profile: category ${item.fantasySystemProfile.category || 'unspecified'}; rank ${item.fantasySystemProfile.rank || 'unspecified'}; rarity ${item.fantasySystemProfile.rarity || 'unspecified'}; level ${item.fantasySystemProfile.levelRange || 'unspecified'}` : '',
                    item.fantasySystemProfile?.origin ? `  Origin: ${item.fantasySystemProfile.origin}` : '',
                    item.fantasySystemProfile?.acquisition ? `  Acquisition: ${item.fantasySystemProfile.acquisition}` : '',
                    item.fantasySystemProfile?.activation ? `  Activation/use: ${item.fantasySystemProfile.activation}` : '',
                    item.fantasySystemProfile?.duration ? `  Duration: ${item.fantasySystemProfile.duration}` : '',
                    item.fantasySystemProfile?.prerequisites?.length ? `  Prerequisites: ${item.fantasySystemProfile.prerequisites.join('; ')}` : '',
                    item.fantasySystemProfile?.costs?.length ? `  Costs/resources: ${item.fantasySystemProfile.costs.join('; ')}` : '',
                    item.fantasySystemProfile?.limits?.length ? `  Limits/counterplay: ${item.fantasySystemProfile.limits.join('; ')}` : '',
                    item.fantasySystemProfile?.progressionRules?.length ? `  Progression rules: ${item.fantasySystemProfile.progressionRules.join('; ')}` : '',
                    item.fantasySystemProfile?.rewardRules?.length ? `  Reward/experience rules: ${item.fantasySystemProfile.rewardRules.join('; ')}` : '',
                    item.fantasySystemProfile?.drops?.length ? `  Drop table/items: ${item.fantasySystemProfile.drops.join('; ')}` : '',
                    item.fantasySystemProfile?.weaknesses?.length ? `  Weaknesses: ${item.fantasySystemProfile.weaknesses.join('; ')}` : '',
                    item.fantasySystemProfile?.entryConditions?.length ? `  Entry conditions: ${item.fantasySystemProfile.entryConditions.join('; ')}` : '',
                    item.fantasySystemProfile?.exitConditions?.length ? `  Exit conditions: ${item.fantasySystemProfile.exitConditions.join('; ')}` : '',
                    item.fantasySystemProfile?.spawnConditions?.length ? `  Spawn conditions: ${item.fantasySystemProfile.spawnConditions.join('; ')}` : '',
                    item.fantasySystemProfile?.failureConsequences?.length ? `  Failure consequences: ${item.fantasySystemProfile.failureConsequences.join('; ')}` : '',
                    item.fantasySystemProfile?.antiExploitRules?.length ? `  Anti-duplication/exploit rules: ${item.fantasySystemProfile.antiExploitRules.join('; ')}` : '',
                    item.fantasySystemProfile?.relatedElements?.length ? `  Linked DLC elements: ${item.fantasySystemProfile.relatedElements.join(', ')}` : '',
                    item.fantasySystemProfile?.settingBasis ? `  Fantasy system basis: ${item.fantasySystemProfile.settingBasis}` : '',
                    item.registrationSource === 'user_manual' ? '  Direct registration: preserve the user-defined function, but adapt names, metaphysics, institutions, and scale to the active character lorebook and LIBRA World DB before manifestation.' : ''
                ].filter(Boolean).join('\n')),
                'Authority: active User DLC is persisted user input. Its creative intent, function, and requested result have user-level priority and must not be weakened, postponed, or discarded by Memory, Narrative, Story Author, Director, World Additional, or other planner suggestions.',
                'Canon adaptation firewall: the Character Lorebook and LIBRA Memory/Entity/Relation/World DB define identity, continuity, and world-law constraints; they do not cancel the DLC outcome. Never rename, overwrite, negate, retcon, or silently mutate those records. When literal details conflict, preserve the DLC function and required result through a canon-compatible analogue.',
                'If immediate literal realization is impossible without a retcon, show a concrete blocked attempt, constraint, or setup that advances the same mandatory DLC outcome and keep it pending. Never silently omit it.',
                'Enforcement rule: every listed compatible User DLC item is mandatory, not optional inspiration. Manifest it in the current response when its activation condition is met. If the condition is not yet met, create a concrete observable setup, cue, or progression toward it and keep it pending; do not silently ignore it.',
                'Result scope: enforcement may control world events, NPC actions, hazards, clues, consequences, and scene conditions, but never the user character\'s choice, consent, private emotion, bodily reaction, or final action.',
                'Persistence rule: a User DLC proposal is not evidence for canonical DB storage. It may become canon only after it actually appears in the assistant response without contradiction and passes the normal current-turn evidence/conflict checks.',
                contraceptiveCatalog.length ? 'Contraceptive tool rule: availability establishes only that the tool exists in the world. Never assume that any character obtained, used, tolerated, or correctly applied it without direct scene evidence. Do not claim infection protection unless protectionScope explicitly includes it.' : '',
                fantasySystemCatalog.length ? 'Fantasy package integrity rule: keep relatedElements links and kind distinctions intact. A magic_array is an inscribed ritual diagram, while a magic_circle is a rank, stage, orbit or progression structure. Do not silently merge linked dungeons, monsters, gates, drops, experience systems or powers into one generic concept.' : '',
                'Agency guard: do not force the user character\'s actions, consent, emotions, or final decision. Traps and crises retain discoverable cues, counterplay, and consequences.'
            ].filter(Boolean).join('\n'), Math.max(1200, Number(maxChars || 3600)), ' ... ');
        };
        const trackerHasCurrentProjection = (item = {}) => {
            if (String(item.currentValue || '').trim() && String(item.currentValue || '').trim() !== 'unknown') return true;
            return adaptiveSnapshotHasData(item.currentSnapshot);
        };
        const adaptiveTrackerPromptLines = (item = {}) => {
            const snapshot = item.currentSnapshot || {};
            const latestEvent = Array.isArray(item.eventLedger) && item.eventLedger.length ? item.eventLedger[item.eventLedger.length - 1] : null;
            const isSexualHistory = String(item.kind || '') === 'sexual_history';
            const probability = snapshot.probabilityMin !== null || snapshot.probabilityMax !== null
                ? `${snapshot.probabilityMin ?? '?'}~${snapshot.probabilityMax ?? '?'}%${snapshot.probabilityLabel ? ` (${snapshot.probabilityLabel})` : ''}`
                : '';
            const sexualCount = (label, value, unit = 'events') => value !== null && value !== undefined
                ? `  ${label}: ${value} ${unit}${snapshot.sexualHistoryCountingBasis === 'observed_minimum' ? ' (confirmed minimum, not established lifetime total)' : ''}`
                : `  ${label}: unknown`;
            const sexualEventSummary = latestEvent?.sexualHistoryDelta
                ? [...SEXUAL_HISTORY_COUNT_FIELDS, 'newPartnerCount'].filter(key => Number(latestEvent.sexualHistoryDelta[key] || 0) > 0).map(key => `${key}+${latestEvent.sexualHistoryDelta[key]}`).join(', ')
                : '';
            return [
                `- ${item.targetType}: ${item.displayName} / ${item.label} [${item.kind || 'state'}] (tracker ${item.id}, never reveal the ID)`,
                item.currentValue ? `  Current: ${item.currentValue} (confidence: ${item.confidence})` : '',
                snapshot.relationshipState ? `  Current relationship: ${snapshot.relationshipState}` : '',
                probability ? `  Current probability estimate: ${probability}` : '',
                snapshot.expectedResponse ? `  Current expected response: ${snapshot.expectedResponse}` : '',
                snapshot.dialogueExamples?.length ? `  Dialogue direction/examples: ${snapshot.dialogueExamples.join(' / ')}` : '',
                snapshot.defenseAssessment ? `  Current defense/escape assessment: ${snapshot.defenseAssessment}` : '',
                snapshot.sceneDate ? `  Story date: ${snapshot.sceneDate}` : '',
                snapshot.cycleModel === 'fictional_rp' ? '  Cycle model: fictional RP simulation (not medical fact)' : '',
                snapshot.cycleLengthDays ? `  Fictional cycle parameters: length ${snapshot.cycleLengthDays} days; anchor ${snapshot.cycleAnchorDate || 'unspecified'}; current day ${snapshot.cycleDay || '?'}` : '',
                snapshot.cycleStatus ? `  Current cycle: ${snapshot.cycleStatus}` : '',
                snapshot.fertilityWindow ? `  Fertility likelihood: ${snapshot.fertilityWindow}` : '',
                snapshot.contraception ? `  Contraception/exposure: ${snapshot.contraception}` : '',
                snapshot.healthStatus ? `  Current health: ${snapshot.healthStatus}` : '',
                isSexualHistory ? sexualCount('Partnered sex encounters', snapshot.sexCount) : '',
                isSexualHistory ? `  Sexual-debut status: ${snapshot.virginityStatus || 'unknown'} (narrative first-sex status only; never anatomy or hymen inference)` : '',
                isSexualHistory ? sexualCount('Masturbation events', snapshot.masturbationCount) : '',
                isSexualHistory ? sexualCount('Pregnancies', snapshot.pregnancyCount) : '',
                isSexualHistory ? sexualCount('Births', snapshot.birthCount) : '',
                isSexualHistory ? sexualCount('Distinct known partners', snapshot.distinctPartnerCount, 'people') : '',
                isSexualHistory ? sexualCount('Vaginal ejaculation events', snapshot.vaginalEjaculationCount) : '',
                isSexualHistory ? sexualCount('Fellatio acts', snapshot.fellatioCount) : '',
                isSexualHistory ? sexualCount('Anal sex acts', snapshot.analSexCount) : '',
                isSexualHistory ? `  First sex partner: ${snapshot.firstSexPartner || 'unknown'}` : '',
                isSexualHistory && snapshot.knownSexPartners?.length ? `  Known partners: ${snapshot.knownSexPartners.join(', ')}` : '',
                isSexualHistory && snapshot.sexualHistoryNote ? `  Counting note: ${snapshot.sexualHistoryNote}` : '',
                snapshot.nextEvaluation ? `  Next evaluation: ${snapshot.nextEvaluation}` : '',
                snapshot.summary ? `  Summary: ${snapshot.summary}` : '',
                latestEvent && isSexualHistory ? `  Counted event lock: ${latestEvent.eventType}/${latestEvent.lockedOutcome}; ${sexualEventSummary || 'non-count status event'}; scene ${latestEvent.sceneDate || 'unknown'}. Never count this event again.` : '',
                latestEvent && !isSexualHistory ? `  Locked event resolution: ${latestEvent.eventType}/${latestEvent.lockedOutcome}; risk ${latestEvent.probabilityMin}~${latestEvent.probabilityMax}%; scene ${latestEvent.sceneDate || 'unknown'}. Do not reroll this event or reveal it before story-time evidence permits.` : '',
                item.reason ? `  Reason: ${item.reason}` : '',
                item.evidence?.length ? `  Last evidence: ${item.evidence.join('; ')}` : ''
            ].filter(Boolean);
        };
        const formatTargetAnalysesForPrompt = (focusNames = [], maxChars = 3200) => {
            const manualItems = (state.targetAnalyses || []).filter(item => item.manualInjection === true && item.injectionDisabled !== true);
            const injectableTrackers = (state.entityTrackers || []).filter(item => item.membershipActive !== false && item.injectionDisabled !== true && trackerHasCurrentProjection(item));
            if (state.settings?.entityReferenceEnabled === false && !manualItems.length && !injectableTrackers.some(item => item.manualInjection === true)) return '';
            const focus = textArray(focusNames, 20, 120).map(normalizeKey).filter(Boolean);
            let items = [...(state.targetAnalyses || [])]
                .filter(item => !isTargetBlocked(item))
                .filter(item => item.injectionDisabled !== true)
                .filter(item => normalizeCanonCompatibilityStatus(item.canonCompatibility?.status || 'unverified') !== 'conflicted')
                .filter(item => state.settings?.entityReferenceEnabled !== false || item.manualInjection === true);
            let trackers = injectableTrackers.filter(item => !isTargetBlocked(item)).filter(item => state.settings?.entityReferenceEnabled !== false || item.manualInjection === true);
            if (focus.length) {
                const matched = items.filter(item => focus.some(key => normalizeKey([item.displayName, ...(item.targetIds || [])].join(' ')).includes(key)));
                if (matched.length) {
                    const byId = new Map([...items.filter(item => item.manualInjection === true), ...matched].map(item => [String(item.id || ''), item]));
                    items = [...byId.values()];
                }
                const matchedTrackers = trackers.filter(item => focus.some(key => normalizeKey([item.displayName, ...(item.targetIds || [])].join(' ')).includes(key)));
                if (matchedTrackers.length) {
                    const byId = new Map([...trackers.filter(item => item.manualInjection === true), ...matchedTrackers].map(item => [String(item.id || ''), item]));
                    trackers = [...byId.values()];
                }
            }
            const maxItems = Math.max(1, Math.min(10, Number(state.settings?.maxEntityAnalysesPerRequest || 6) || 6));
            items = items.sort((a, b) => Number(b.manualInjection === true) - Number(a.manualInjection === true) || Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0)).slice(0, Math.max(maxItems, manualItems.length));
            trackers = trackers.sort((a, b) => Number(b.manualInjection === true) - Number(a.manualInjection === true) || Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0)).slice(0, 12);
            if (!items.length && !trackers.length) return '';
            return truncateForLLM([
                '[USER DLC — ENTITY/RELATION ANALYSIS]',
                ...items.map(item => [
                    `- ${item.targetType}: ${item.displayName} (revision ${item.revision})`,
                    `  DB compatibility: ${normalizeCanonCompatibilityStatus(item.canonCompatibility?.status || 'unverified')}`,
                    item.summary ? `  Summary: ${item.summary}` : '',
                    ...(item.findings || []).filter(f => normalizeCanonCompatibilityStatus(f.dbCompatibility || 'unverified') !== 'conflicted').slice(0, 8).map(f => `  ${f.label}: ${f.value} [${normalizeCanonCompatibilityStatus(f.dbCompatibility || 'unverified')}]`),
                    item.continuityEffects?.length ? `  Continuity: ${item.continuityEffects.join('; ')}` : '',
                    item.relationshipImplications?.length ? `  Relations: ${item.relationshipImplications.join('; ')}` : ''
                ].filter(Boolean).join('\n')),
                trackers.length ? '[USER DLC — CURRENT CUSTOM TRACKER STATES]' : '',
                ...trackers.map(item => adaptiveTrackerPromptLines(item).join('\n')),
                'Authority: this separate User DLC DB is persisted user input. Once an entry is active and compatible/adapted, its requested analysis axis, finding, and validated tracker state have user-level priority over Memory summaries and planner suggestions.',
                'Canon adaptation firewall: preserve exact LIBRA target identity and established continuity. Do not rename targets, silently replace traits or relations, negate canonical state, or mutate canonical DB merely because this block exists. Resolve literal mismatch through an explicit compatible interpretation or a current-scene transition/correction.',
                'Enforcement rule: compatible/adapted findings and validated tracker states in this active block are mandatory continuity constraints for portrayal. Apply them consistently in the current response. Pending/unverified user entries still require the requested analysis or observation, but their unverified value must not be asserted as an established fact.',
                'Pending/unverified entries are hypotheses, not facts. Conflicted entries are quarantined and are never included in this prompt.'
            ].join('\n'), Math.max(1000, Number(maxChars || 3200)), ' ... ');
        };
        const formatTrackersForAnalysis = (focusNames = [], maxChars = 5200) => {
            const focus = textArray(focusNames, 24, 120).map(normalizeKey).filter(Boolean);
            let trackers = (state.entityTrackers || []).filter(item => !isTargetBlocked(item)).filter(item => item.membershipActive !== false && item.enabled !== false && item.updateMode !== 'manual');
            if (focus.length) {
                const matched = trackers.filter(item => focus.some(key => normalizeKey([item.displayName, ...(item.targetIds || [])].join(' ')).includes(key)));
                trackers = [...new Map([...trackers.filter(item => item.updateMode === 'every_turn'), ...matched].map(item => [item.id, item])).values()];
            } else trackers = trackers.filter(item => item.updateMode === 'every_turn');
            const limit = Math.max(1, Math.min(32, Number(state.settings?.maxTrackersPerAnalysis || 16) || 16));
            trackers = trackers.sort((a, b) => Number(b.updateMode === 'every_turn') - Number(a.updateMode === 'every_turn') || Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0)).slice(0, limit);
            if (!trackers.length) return '';
            const needsContraceptiveContext = trackers.some(item => ['reproductive_health', 'health_risk'].includes(String(item.kind || '')));
            const contraceptiveTools = needsContraceptiveContext ? (state.worldItems || [])
                .filter(item => item.contraceptiveProfile && item.injectionDisabled !== true && ['analyzed', 'armed', 'injected'].includes(item.status))
                .filter(item => normalizeCanonCompatibilityStatus(item.canonCompatibility?.status || 'unverified') !== 'conflicted')
                .filter(item => state.settings?.worldInjectionEnabled !== false || item.manualInjection === true)
                .slice(-6) : [];
            return truncateForLLM([
                '[USER DLC CUSTOM ENTITY TRACKERS — EVALUATE CURRENT ASSISTANT EVIDENCE ONLY]',
                ...trackers.map(item => JSON.stringify({
                    trackerId: item.id,
                    kind: item.kind || 'state',
                    targetType: item.targetType,
                    targetIds: item.targetIds,
                    displayName: item.displayName,
                    label: item.label,
                    instruction: item.instruction,
                    valueType: item.valueType,
                    allowedValues: item.allowedValues,
                    currentValue: item.currentValue,
                    confidence: item.confidence,
                    currentSnapshot: item.currentSnapshot || {},
                    scenarioBands: item.scenarioBands || [],
                    eventResolutionMode: item.eventResolutionMode || 'none',
                    eventLedger: item.eventLedger || [],
                    storyClock: typeof TimeEngine !== 'undefined' ? (TimeEngine.getState?.() || {}) : {},
                    updateMode: item.updateMode
                })),
                contraceptiveTools.length ? '[ACTIVE USER DLC CONTRACEPTIVE WORLD TOOLS — CONTEXT ONLY]' : '',
                ...contraceptiveTools.map(item => JSON.stringify({
                    title: item.title,
                    kind: item.kind,
                    mechanism: item.mechanism,
                    effects: item.effects,
                    risks: item.risks,
                    contraceptiveProfile: item.contraceptiveProfile
                })),
                contraceptiveTools.length ? 'Contraceptive context rule: a listed tool exists in the world, but its presence is never evidence that the tracked character acquired, used, correctly applied, or tolerated it. Apply its profile only when the current assistant response directly establishes the exact tool and use/failure details. Never infer infection protection beyond protectionScope.' : '',
                'Rules: evaluate tracking-enabled items every turn but return an update only when direct current-response evidence or an authoritative current DB transition changes the active projection. Absence of mention is not evidence. Use listed trackerId and allowedValues exactly.',
                'Scenario items retain all branches internally but update only currentSnapshot for the presently applicable relationship/situation branch.',
                'For reproductive-health or health-risk items, emit a stable eventKey only for a newly depicted exposure/event. The runtime resolves each event once and never rerolls it on later turns.'
            ].join('\n'), Math.max(1200, Number(maxChars || 5200)), ' ... ');
        };
        const formatStateForAnalysis = (maxChars = 5000) => truncateForLLM(JSON.stringify({
            worldItems: (state.worldItems || []).slice(-12),
            targetAnalyses: (state.targetAnalyses || []).slice(-16),
            entityTrackers: (state.entityTrackers || []).slice(-24)
        }), Math.max(1200, Number(maxChars || 5000)), ' ... ');
        const renameEntityReferences = (oldName = '', newName = '') => {
            const oldKey = normalizeKey(oldName); if (!oldKey || !newName) return { changed: false };
            let changed = false;
            state.worldItems = (state.worldItems || []).map(item => {
                const relatedEntities = (item.relatedEntities || []).map(name => normalizeKey(name) === oldKey ? (changed = true, newName) : name);
                return { ...item, relatedEntities };
            });
            state.targetAnalyses = (state.targetAnalyses || []).map(item => {
                const targetIds = (item.targetIds || []).map(name => normalizeKey(name) === oldKey ? (changed = true, newName) : name);
                const displayName = normalizeKey(item.displayName).includes(oldKey) ? (changed = true, String(item.displayName).replace(new RegExp(String(oldName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), newName)) : item.displayName;
                return { ...item, targetIds, displayName };
            });
            state.entityTrackers = (state.entityTrackers || []).map(item => {
                const targetIds = (item.targetIds || []).map(name => normalizeKey(name) === oldKey ? (changed = true, newName) : name);
                const displayName = normalizeKey(item.displayName).includes(oldKey) ? (changed = true, String(item.displayName).replace(new RegExp(String(oldName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), newName)) : item.displayName;
                return { ...item, targetIds, displayName };
            });
            if (changed) state.lastUpdated = Date.now();
            return { changed };
        };
        const getState = () => state;
        const resetState = (next = null) => (state = normalizeState(next || defaultState()));
        return { loadState, saveState, getState, resetState, upsertWorldItem, upsertTargetAnalysis, registerWorldElement, registerTargetAnalysisElement, registerEntityTracker, reconcileTrackerTargets, setTrackerEnabled, normalizeTrackerUpdates, applyTrackerUpdates, ingestWorldAnalysis, ingestTargetAnalysis, ingestAdaptiveItems, mergeDuplicateItems, deleteItem, setInjectionState, listEntityTargets, listRelationTargets, isTargetBlocked, formatWorldForPrompt, formatTargetAnalysesForPrompt, formatTrackersForAnalysis, formatStateForAnalysis, renameEntityReferences, previewWorldAnalysis, commitWorldPreview, discardWorldPreview, getPendingWorldPreview, updateWorldItemFields, getWorldItemEditableFields };
    })();
