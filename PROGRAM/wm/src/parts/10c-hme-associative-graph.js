        const HME_GRAPH_INDEX_COMMENT = 'lmai_hme_graph_index';
        const HME_GRAPH_INDEX_SCHEMA_V1 = 'libra.hme.graph_index.v1';
        const HME_GRAPH_INDEX_SCHEMA = 'libra.hme.graph_index.v2';
        // 3: 인물(entity)·로어(lore) 노드 + 크로스타입 엣지 추가.
        //    version 을 올리지 않으면 구버전 그래프가 그대로 hydrate 되어 새 노드가 없는 채로 돈다.
        // 4: rebuild Unicode tokens and links from the current scope index.
        // 5: preserve structural links within the shared edge budget, including incremental edits.
        const HME_GRAPH_INDEX_VERSION = 5;
        const HME_GRAPH_ONLY_MAX_SCORE = 0.58;
        const HME_GRAPH_BUCKET_LIMIT = 40;
        const HME_GRAPH_EDGE_LIMIT_PER_NODE = 8;
        const HME_GRAPH_MEANING_THRESHOLD = 0.72;
        const HME_GRAPH_SIGNAL_THRESHOLD = 0.35;
        const HME_GRAPH_GENERIC_TOPICS = new Set([
            '사건', '대화', '장소', '물건', '관계', '장소 단서', '물건 단서', '관계 단서',
            'fact:user_turn', 'fact:scene_result', 'narrative', 'current', 'world',
            'memory', 'general', 'entity', 'relationship', 'open-thread', 'ledger_open_thread',
            'ledger_relation_signal', 'ledger_world_change', '세계 변화', '세계 규칙', '관계 신호'
        ].map(value => normalizeHmeIndexTerm(String(value || ''))).filter(Boolean));
        const HME_GRAPH_STALE_EDGE_POLICY = Object.freeze({
            enabled: true,
            pruneEnabled: true,
            rebuildEnabled: true,
            rebuildRatio: 0.15,
            minEdges: 12,
            cooldownMs: 60000
        });
        const HME_GRAPH_MODE_PRESETS = Object.freeze({
            off: Object.freeze({ enabled: false, maxSeeds: 0, maxCandidates: 0, maxAdditions: 0, maxHops: 0, edgeWeightMin: 1, bonusCap: 0 }),
            light: Object.freeze({ enabled: true, maxSeeds: 6, maxCandidates: 10, maxAdditions: 4, maxHops: 2, edgeWeightMin: 0.28, bonusCap: 0.10 }),
            balanced: Object.freeze({ enabled: true, maxSeeds: 14, maxCandidates: 28, maxAdditions: 8, maxHops: 2, edgeWeightMin: 0.20, bonusCap: 0.18 }),
            deep: Object.freeze({ enabled: true, maxSeeds: 14, maxCandidates: 28, maxAdditions: 8, maxHops: 2, edgeWeightMin: 0.16, bonusCap: 0.18 })
        });
        const normalizeHmeGraphMode = (value = '') => {
            const mode = String(value || '').trim().toLowerCase();
            return HME_GRAPH_MODE_PRESETS[mode] ? mode : 'off';
        };
        const getHmeGraphPreset = () => {
            const mode = normalizeHmeGraphMode(CONFIG.hmeAssociativeGraphMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode);
            const base = HME_GRAPH_MODE_PRESETS[mode] || HME_GRAPH_MODE_PRESETS.off;
            const operationalNumber = (value, fallback, migrateIfAtOrBelow = null) => {
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) return fallback;
                if (migrateIfAtOrBelow !== null && n <= Number(migrateIfAtOrBelow)) return fallback;
                return n;
            };
            return Object.freeze({
                ...base,
                mode,
                maxSeeds: Math.max(0, Math.min(32, operationalNumber(CONFIG.hmeGraphMaxSeeds, LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxSeeds, 8))),
                maxCandidates: Math.max(0, Math.min(96, operationalNumber(CONFIG.hmeGraphMaxCandidates, LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxCandidates, 16))),
                maxNodes: Math.max(64, Math.min(2400, operationalNumber(CONFIG.hmeGraphMaxNodes, LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxNodes, 1600))),
                maxEdges: Math.max(128, Math.min(4096, operationalNumber(CONFIG.hmeGraphMaxEdges, LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxEdges, 8000))),
                maxAdditions: Math.max(0, Math.min(24, Number(CONFIG.hmeGraphMaxAdditions || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxAdditions || base.maxAdditions) || base.maxAdditions || 0)),
                maxHops: Math.max(0, Math.min(2, Number(CONFIG.hmeGraphMaxHops || base.maxHops) || base.maxHops || 0)),
                bonusCap: Math.max(0, Math.min(0.24, Number(CONFIG.hmeGraphBonusCap || base.bonusCap) || base.bonusCap || 0))
            });
        };
        const isHmeGraphEnabled = () => CONFIG.hybridMemoryEngineEnabled !== false
            && CONFIG.hybridScopeIndexEnabled !== false
            && getHmeGraphPreset().enabled === true;
        const hmeGraphEntryKey = (scopeKey = '') => `lmai_hme_graph_index::${getHybridScopeHash(scopeKey)}`;
        const hmeGraphNodes = graph => Array.isArray(graph?.nodes) ? graph.nodes : [];
        const hmeGraphEdges = graph => Array.isArray(graph?.edges) ? graph.edges : [];
        // 구조 샘플(노드·엣지 목록)을 debug 에 담을지. 기본 off — 매 회상마다 만들면 비용이다.
        //   시각화/진단이 필요할 때만 `hme_graph_debug=full` 로 켠다.
        const hmeGraphSampleRequested = () => String(CONFIG.hmeGraphDebug || 'off').trim().toLowerCase() === 'full';
        // 시각화용 노드 표본 — **종류별 보장**.
        //   균일하게 앞에서 자르면 entity/lore 노드가 목록 뒤로 밀려 하나도 안 들어온다
        //   (실측: 60개 상한에서 entity 1개). 시각화가 인물 허브를 그리려면 종류별 보장이 필요하다.
        //   그리고 **엣지가 가리키는 노드는 반드시 포함**한다 — 끝점 없는 엣지는 그릴 수 없다.
        const hmeGraphSampleNodes = (graph) => {
            const all = hmeGraphNodes(graph);
            const pick = (type, cap) => all.filter(n => (n.nodeType || 'memory') === type).slice(0, cap);
            // 상한은 시각화가 **실제 규모**를 그릴 수 있게 잡는다. 작게 잡으면 목업이
            //   "그래프 전체"처럼 보이면서 실제로는 일부만 그려 렉 여부를 검증할 수 없다.
            //   (실측: memory 40 상한에서 노드 400건 그래프를 70개만 그렸다.)
            const chosen = [...pick('memory', 260), ...pick('entity', 48), ...pick('lore', 36)];
            const chosenIds = new Set(chosen.map(n => n.id));
            const byId = new Map(all.map(n => [n.id, n]));
            // 표본에 담긴 노드끼리 이어진 엣지의 끝점을 보강한다 (상한 24개).
            let added = 0;
            for (const edge of hmeGraphEdges(graph)) {
                if (added >= 80) break;
                const needFrom = chosenIds.has(edge.from), needTo = chosenIds.has(edge.to);
                if (!needFrom && !needTo) continue;
                for (const end of [edge.from, edge.to]) {
                    if (chosenIds.has(end) || added >= 80) continue;
                    const node = byId.get(end);
                    if (!node) continue;
                    chosen.push(node); chosenIds.add(end); added += 1;
                }
            }
            return chosen.map(n => ({
                id: n.id, rowId: n.rowId, nodeType: n.nodeType || 'memory',
                label: n.name || n.rowId, kind: n.kind || 'memory', turn: n.turn ?? null
            }));
        };
        // 엣지 표본 — 양 끝점이 모두 표본에 있는 엣지만. 끝점 없는 엣지는 그릴 수 없다.
        const hmeGraphSampleEdges = (graph, sampleNodes) => {
            const ids = new Set((sampleNodes || []).map(n => n.id));
            return hmeGraphEdges(graph)
                .filter(e => ids.has(e.from) && ids.has(e.to))
                .slice(0, 900)
                .map(e => ({
                    from: e.from, to: e.to, relation: e.relation || '', layer: e.layer || '',
                    weight: Number(Number(e.weight || 0).toFixed(3))
                }));
        };
        const isHmeGraphIndexSchema = (schema = '') => [HME_GRAPH_INDEX_SCHEMA, HME_GRAPH_INDEX_SCHEMA_V1].includes(String(schema || '').trim());
        const normalizeHmeGraphToken = (value = '') => normalizeHmeIndexTerm(value);
        // 한국어 조사 제거 — 인물/엔티티 이름 전용.
        //
        // 왜 필요한가 (실측 결함):
        //   인물 이름이 문장에서 뽑히면 '아리엘은' 처럼 조사가 붙은 채로 들어온다.
        //   이게 normalizeHmeEntityNameList → row.subjects → node.entities → byEntity 버킷 키가
        //   되어, 인물 노드의 '아리엘' 키와 매칭되지 않는다 → E1 엣지(memory → entity) 미연결.
        //   실측: 조사 붙은 이름 9/9 샘플이 그대로 키가 됨.
        //
        //   같은 계열 결함이 CompactMemoryCodec 에서는 이미 고쳐졌다 (stripMemoryEntityParticle).
        //   그 함수는 그 모듈 내부 비공개라 여기서 못 써서 사본이 갈라졌다.
        //
        // ★ 적용 범위를 엔티티 이름으로 한정한다 (normalizeHmeGraphToken 아님):
        //   normalizeHmeGraphToken 은 byTopic/byThread/byArc 등 *주제·태그* 버킷 키도 만든다.
        //   거기에 조사 제거를 걸면 '호랑이'→'호랑', '지팡이'→'지팡' 같은 주제명 오탐이 난다.
        //   엔티티 이름은 조사가 붙은 형태로 들어오고, 주제·태그는 이미 정제된 구(句) 라는
        //   비대칭이 있으므로 범위를 나눈다.
        //
        // ★ `이`/`가` 는 목록에서 **제외**한다 (오탐 실측).
        //   '호랑이'·'지팡이'·'가위'·'소이' 처럼 `이` 로 끝나는 명사가 많아, 떼면
        //   '호랑'·'지팡'·'가'·'소' 라는 **없는 이름을 만든다**. 사전 없이는 구분 불가다.
        //
        //   그런데 `이`/`가` 주격 조사는 이 계층에서 이미 해결된다:
        //   - 주 경로(`push(value)`)는 `EntityManager` 캐시·known 목록에서 온 **정본 이름**을
        //     `raw.includes(v)` 로 찾는다. 본문에 '미르가' 가 있어도 이름 '미르' 가 그대로 잡힌다.
        //   - `row.subjects/entities` 는 `03a stripMemoryEntityParticle` 을 이미 거친다.
        //   그래서 목록에서 빼도 진탐이 유지되고, 오탐만 사라진다 (게이트 N1/N5 로 확인).
        const HME_KO_PARTICLE_SUFFIXES = [
            '에게서는', '에게서', '으로는', '이라도', '에게는', '에게', '한테는', '한테', '에서는', '에는', '에서',
            '부터', '까지', '처럼', '께서는', '께서', '으로', '하고', '이다', '이며', '이랑', '랑',
            '과', '와',
            '은', '는', '에', '을', '를', '의', '도', '로', '만'
        ];
        const stripHmeKoParticle = (value = '') => {
            let current = String(value || '').trim();
            if (!/^[가-힣]{2,8}$/.test(current)) return current;
            for (let pass = 0; pass < 2; pass += 1) {
                let stripped = false;
                for (const suffix of HME_KO_PARTICLE_SUFFIXES) {
                    if (current.length - suffix.length >= 2 && current.endsWith(suffix)) {
                        current = current.slice(0, -suffix.length);
                        stripped = true;
                        break;
                    }
                }
                if (!stripped) break;
            }
            return current;
        };
        const HME_EN_STOPWORDS = new Set([
            'the', 'and', 'but', 'for', 'with', 'from', 'that', 'this', 'those', 'these',
            'his', 'her', 'their', 'its', 'was', 'were', 'are', 'has', 'had', 'not', 'you', 'she', 'he', 'they'
        ]);
        const expandHmeEntityNameVariants = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return [];
            const repaired = raw.includes('(') && !raw.includes(')') ? `${raw})` : raw;
            const strippedParen = repaired.replace(/\([^)]*\)/g, '').trim();
            const insideParen = Array.from(repaired.matchAll(/\(([^)]{1,80})\)/g)).map(match => match[1]).filter(Boolean);
            const compactParen = repaired.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
            // 어절 단위 분리 — 정규식 통짜 매칭(/[가-힣]{2,8}/g)은 띄어쓰기를 무시해
            //   동사 활용형·조사 결합형을 엔티티명 후보로 만든다 (03a 에서 실측 정밀도 6%).
            const tokens = [];
            for (const chunk of repaired.split(/[^가-힣A-Za-z]+/)) {
                if (!chunk) continue;
                if (/^[A-Za-z]/.test(chunk)) {
                    if (chunk.length < 2 || HME_EN_STOPWORDS.has(chunk.toLowerCase())) continue;
                    tokens.push(chunk);
                    continue;
                }
                if (!/^[가-힣]+$/.test(chunk)) continue;
                tokens.push(chunk);
            }
            return uniqLimit([
                raw,
                repaired,
                strippedParen,
                compactParen,
                ...insideParen,
                ...tokens
            ]
                .map(item => String(item || '').trim())
                .filter(item => item.length >= 2)
                .map(item => stripHmeKoParticle(item) || item), 12);
        };
        const normalizeHmeEntityNameList = (items = [], limit = 32) => compactHmeIndexArray(
            asHybridArray(items).flatMap(expandHmeEntityNameVariants),
            Math.max(1, limit)
        );
        const hmeEntityMatchKeys = (items = []) => new Set(normalizeHmeEntityNameList(items, 64)
            .flatMap(value => [normalizeHmeIndexTerm(value), normalizeHmeGraphToken(value), normalizeSemanticText(value).replace(/\s+/g, '')])
            .map(value => String(value || '').trim())
            .filter(Boolean));
        const countHmeEntityFocusMatches = (row = {}, focusNames = []) => {
            const focusKeys = focusNames instanceof Set ? focusNames : hmeEntityMatchKeys(focusNames);
            if (!focusKeys || focusKeys.size === 0) return 0;
            const rowKeys = hmeEntityMatchKeys([
                ...(row?.subjects || []),
                ...(row?.aliases || []),
                ...flattenHmeGraphEntityRoles(row?.entityRoles || {})
            ]);
            let count = 0;
            for (const key of rowKeys) {
                if (focusKeys.has(key)) count += 1;
                if (count >= 8) break;
            }
            return count;
        };
        const normalizeHmeGraphList = (value = [], limit = 16) => compactHmeIndexArray(value, limit).map(v => String(v || '').trim()).filter(Boolean);
        // 엔티티(인물) 이름 전용 목록 정규화 — 조사를 떼고 어절 경계를 존중한다.
        //
        // 왜 엔티티만인가:
        //   normalizeHmeGraphList 는 엔티티와 *주제·태그* 에 함께 쓰인다. 주제·태그는
        //   이미 정제된 구(句)라 조사 제거를 걸면 '호랑이'→'호랑', '지팡이'→'지팡' 같은
        //   오탐이 난다. 반면 인물 이름은 문장에서 뽑혀 '아리엘은' 처럼 조사가 붙은 채 들어온다.
        //   이 비대칭 때문에 목록 정규화를 엔티티 경로에만 따로 둔다.
        //
        // 효과: byEntity 버킷 키가 '아리엘' 이 되어 인물 노드의 정본 이름 키와 만난다
        //   → E1 엣지(memory → entity)가 붙는다. 실측 전: 조사 잔존 9/9.
        const normalizeHmeEntityList = (value = [], limit = 16) => normalizeHmeGraphList(value, limit)
            .map(v => stripHmeKoParticle(v) || v)
            .filter(Boolean);
        const isHmeGraphGenericTopic = (value = '') => {
            const normalized = normalizeHmeGraphToken(value);
            if (!normalized) return true;
            return HME_GRAPH_GENERIC_TOPICS.has(normalized)
                || /^fact:(?:user_turn|scene_result|summary|current)$/i.test(normalized)
                || /^(?:kind|bucket):?(?:memory|entity|world|narrative|current|general)$/i.test(normalized);
        };
        const normalizeHmeGraphSpecificList = (items = [], limit = 16) => normalizeHmeGraphList(items, limit * 2)
            .filter(value => !isHmeGraphGenericTopic(value))
            .slice(0, limit);
        const hmeGraphTextKey = (value = '') => normalizeHmeGraphToken(value).replace(/\s+/g, ' ').trim();
        const hmeGraphObjectText = (item = null) => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            return String(item.text || item.summary || item.label || item.name || item.delta || item.trigger || item.location || item.signature || item.type || '').trim();
        };
        const hmeGraphObjectList = (items = [], limit = 16) => normalizeHmeGraphSpecificList(
            (Array.isArray(items) ? items : [items])
                .flatMap(item => {
                    if (!item) return [];
                    if (typeof item === 'string') return [item];
                    return [
                        hmeGraphObjectText(item),
                        ...(Array.isArray(item.entities) ? item.entities : []),
                        ...(Array.isArray(item.pair) ? item.pair : []),
                        ...(Array.isArray(item.tags) ? item.tags : []),
                        ...(Array.isArray(item.resolutionCriteria) ? item.resolutionCriteria : [])
                    ];
                })
                .filter(Boolean),
            limit
        );
        const normalizeHmeGraphEntityRoles = (roles = {}) => ({
            primary: normalizeHmeEntityList(roles?.primary || [], 24),
            observer: normalizeHmeEntityList(roles?.observer || [], 20),
            mention: normalizeHmeEntityList(roles?.mention || [], 24),
            inferred: normalizeHmeEntityList(roles?.inferred || [], 16)
        });
        const mergeHmeGraphEntityRoles = (...roleSets) => {
            const merged = { primary: [], observer: [], mention: [], inferred: [] };
            for (const roles of roleSets) {
                const normalized = normalizeHmeGraphEntityRoles(roles || {});
                for (const key of Object.keys(merged)) merged[key].push(...normalized[key]);
            }
            return {
                primary: normalizeHmeEntityList(merged.primary, 24),
                observer: normalizeHmeEntityList(merged.observer, 20),
                mention: normalizeHmeEntityList(merged.mention, 24),
                inferred: normalizeHmeEntityList(merged.inferred, 16)
            };
        };
        const flattenHmeGraphEntityRoles = (roles = {}) => {
            const normalized = normalizeHmeGraphEntityRoles(roles);
            return normalizeHmeGraphList([
                ...normalized.primary,
                ...normalized.observer,
                ...normalized.mention,
                ...normalized.inferred
            ], 32);
        };
        // ── 세계 정본 리더 (조화안 B) ──
        // HME 는 세계를 **읽기만** 한다. 세계 정본은 08a 하나이고 여기서는 참조만 한다.
        //   이전에는 기억 레코드(payload.world)를 통해 읽었는데, 그건 정본의 복사본이었고
        //   5단계에서 제거됐다(복사 8개) → 이 경로가 없으면 HME 그래프가 세계 규칙을 잃는다.
        // 재구축마다 매번 읽으면 비용이므로 그래프 1회 구축 동안만 유효한 캐시를 쓴다.
        // 검증용 노출(게이트·프로브가 정본 리더를 직접 확인한다). 동작에는 영향 없다.
        if (typeof globalThis !== 'undefined') {
            try {
                Object.defineProperty(globalThis, '__libraReadWorldCanonSignals', {
                    configurable: true,
                    get: () => readWorldCanonSignals
                });
            } catch (_) { /* 이미 정의됨 */ }
        }
        let __worldCanonCache = null;
        let __worldCanonCacheKey = '';
        const readWorldCanonSignals = () => {
            try {
                if (typeof HierarchicalWorldManager === 'undefined' || !HierarchicalWorldManager) return null;
                const profile = HierarchicalWorldManager.getProfile?.();
                if (!profile) return null;
                const activeIds = (typeof HierarchicalWorldManager.getActiveNodes === 'function'
                    ? HierarchicalWorldManager.getActiveNodes()
                    : (Array.isArray(profile.activePath) ? profile.activePath.slice(-1) : []));
                const rules = (typeof HierarchicalWorldManager.getCurrentRules === 'function'
                    ? HierarchicalWorldManager.getCurrentRules()
                    : null);
                // 캐시 키: 활성 위치 + 규칙 지문. 내용이 바뀌면 다시 읽는다.
                const cacheKey = JSON.stringify(activeIds) + '|' + JSON.stringify(rules || {});
                if (__worldCanonCache && __worldCanonCacheKey === cacheKey) return __worldCanonCache;
                const highlights = (typeof extractWorldRuleHighlights === 'function'
                    ? extractWorldRuleHighlights(rules || {}, 8)
                    : []);
                const names = [];
                for (const id of activeIds) {
                    const node = profile.nodes instanceof Map ? profile.nodes.get(id) : null;
                    const name = String(node?.name || '').trim();
                    if (name) names.push(name);
                }
                // 활성 위치 이름을 서명 축으로 쓴다 — "어느 세계인가"를 HME 가 알게 한다.
                __worldCanonCache = {
                    ruleHighlights: Array.isArray(highlights) ? highlights.filter(Boolean).slice(0, 8) : [],
                    signature: names.slice(0, 6)
                };
                __worldCanonCacheKey = cacheKey;
                return __worldCanonCache;
            } catch (error) {
                return null;
            }
        };

        const buildHmeGraphRowSignals = (payload = {}, meta = {}, row = {}, recallHints = {}, ledgerProjection = null, canonicalSignals = undefined) => {
            const ledger = ledgerProjection || getLedgerProjectionParts(payload);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            const facts = Array.isArray(payload?.facts) ? payload.facts : [];
            const beats = Array.isArray(payload?.beats) ? payload.beats : [];
            const participants = payload?.participants && typeof payload.participants === 'object' && !Array.isArray(payload.participants) ? payload.participants : {};
            const continuity = payload?.continuity && typeof payload.continuity === 'object' && !Array.isArray(payload.continuity) ? payload.continuity : {};
            const payloadWorld = payload?.world && typeof payload.world === 'object' && !Array.isArray(payload.world) ? payload.world : {};
            const relationDeltas = Array.isArray(payload?.relationDeltas) ? payload.relationDeltas : [];
            // 세계 정본(08a)을 먼저 본다 — 조화안 B. 정본이 비면 기억 경유(레거시 기억)로 되돌아간다.
            const __canon = canonicalSignals === undefined ? readWorldCanonSignals() : canonicalSignals;
            const worldRuleHighlights = normalizeHmeGraphSpecificList([
                ...(__canon?.ruleHighlights || []),
                ...(Array.isArray(payloadWorld?.ruleHighlights) ? payloadWorld.ruleHighlights : []),
                ...(Array.isArray(payload?.ruleHighlights) ? payload.ruleHighlights : []),
                ...(Array.isArray(meta?.worldRuleHighlights) ? meta.worldRuleHighlights : [])
            ], 12);
            const worldSignature = normalizeHmeGraphSpecificList([
                ...(__canon?.signature || []),
                payload?.worldSignature,
                payloadWorld?.signature,
                payloadWorld?.classification?.primary,
                payloadWorld?.worldSignature,
                ...(Array.isArray(continuity.worldChanges) ? continuity.worldChanges.map(item => item?.signature || item?.type || item?.text || item?.summary) : [])
            ], 6);
            const scenePlaces = normalizeHmeGraphSpecificList([
                payload?.scene?.location,
                payload?.sceneCore?.location,
                ...(Array.isArray(continuity.places) ? continuity.places : [])
            ], 8);
            const objectContinuity = normalizeHmeGraphSpecificList([
                ...(Array.isArray(continuity.objects) ? continuity.objects : []),
                ...(Array.isArray(payload?.objects) ? payload.objects : []),
                ...(Array.isArray(payload?.sceneCore?.objects) ? payload.sceneCore.objects : [])
            ], 8);
            const openThreads = hmeGraphObjectList(continuity.openThreads || ledger.narrative || [], 16);
            const relationSignals = hmeGraphObjectList([
                ...(Array.isArray(continuity.relationSignals) ? continuity.relationSignals : []),
                ...relationDeltas,
                payload?.relationDelta
            ], 16);
            const worldChanges = hmeGraphObjectList(continuity.worldChanges || ledger.world || [], 16);
            const primaryConflict = normalizeHmeGraphSpecificList([
                payload?.primaryConflict,
                row?.primaryConflict,
                ...(Array.isArray(continuity.openThreads) ? continuity.openThreads.map(item => item?.text || item?.label) : [])
            ], 6);
            const relationDelta = normalizeHmeGraphSpecificList([
                payload?.relationDelta,
                row?.relationDelta,
                ...relationDeltas.map(item => item?.delta || item?.text || item?.trigger),
                ...(Array.isArray(continuity.relationSignals) ? continuity.relationSignals.map(item => item?.text || item?.status) : [])
            ], 8);
            const primaryEntities = normalizeHmeEntityList([
                ...(row?.subjects || []),
                ...(isLedger ? ledger.entities : []),
                ...facts.flatMap(item => [
                    ...(Array.isArray(item?.entities) ? item.entities : []),
                    ...(Array.isArray(item?.subjects) ? item.subjects.flatMap(ref => [ref?.label, ref?.name, ref?.ref]).filter(Boolean) : [])
                ]),
                ...beats.flatMap(item => Array.isArray(item?.entities) ? item.entities : []),
                ...Object.keys(payload?.entityStates && typeof payload.entityStates === 'object' ? payload.entityStates : {})
            ], 24);
            const observerEntities = normalizeHmeEntityList([
                ...facts.flatMap(item => Array.isArray(item?.observerEntities) ? item.observerEntities : []),
                ...(Array.isArray(participants?.canonicalEntities) ? participants.canonicalEntities : [])
            ], 20);
            const mentionEntities = normalizeHmeEntityList([
                ...(Array.isArray(payload?.mentionedEntityNames) ? payload.mentionedEntityNames : []),
                ...(Array.isArray(meta?.ent) ? meta.ent : []),
                ...(Array.isArray(meta?.entities) ? meta.entities : []),
                ...(Array.isArray(recallHints?.names) ? recallHints.names : [])
            ], 24);
            const inferredEntities = normalizeHmeEntityList([
                ...(row?.aliases || []),
                ...(Array.isArray(payload?.entityRefs) ? payload.entityRefs : [])
            ], 16).filter(name => !primaryEntities.includes(name) && !observerEntities.includes(name) && !mentionEntities.includes(name));
            return {
                entityRoles: mergeHmeGraphEntityRoles({
                    primary: primaryEntities,
                    observer: observerEntities,
                    mention: mentionEntities,
                    inferred: inferredEntities
                }),
                arcKey: normalizeHmeGraphSpecificList([row?.arcKey, payload?.arcKey], 4)[0] || '',
                arcRole: String(row?.arcRole || payload?.arcRole || '').trim(),
                causalRole: String(row?.causalRole || payload?.causalRole || '').trim(),
                primaryConflict,
                relationDelta,
                openThreads,
                relationSignals,
                worldChanges,
                worldSignature,
                worldRuleHighlights,
                objectContinuity,
                placeContinuity: scenePlaces,
                recallKeywords: normalizeHmeGraphSpecificList(payload?.recallKeywords || [], 16),
                summaryContinuity: normalizeHmeGraphSpecificList([
                    payload?.summaryV2?.continuity,
                    payload?.summaryV2?.recall
                ], 6)
            };
        };
        const isHmeGraphRowBlocked = row => !row?.id
            || row.hiddenFromPrompt
            || row.rollbackTombstone
            || row.stale
            || ['candidate_deleted', 'superseded'].includes(normalizeHybridRollbackState(row.rollbackState || 'active'));
        const graphCanUseNode = node => !!node?.rowId
            && !node.hiddenFromPrompt
            && !node.rollbackTombstone
            && !node.stale
            && node.active !== false
            && !['candidate_deleted', 'superseded'].includes(normalizeHybridRollbackState(node.rollbackState || 'active'));
        const compareHmeGraphNodeRetention = (a, b) => {
            const turnDelta = Number(b?.turn || 0) - Number(a?.turn || 0);
            if (turnDelta) return turnDelta;
            return Number(b?.importance || 0) - Number(a?.importance || 0);
        };
        const compactHmeGraphNodes = (nodes = [], preset = getHmeGraphPreset()) => {
            const maxNodes = Math.max(128, Number(preset.maxNodes || 1200) || 1200);
            if (!Array.isArray(nodes) || nodes.length <= maxNodes) return Array.isArray(nodes) ? nodes : [];
            // ★ 종류별 예산 — 인물·로어 노드는 `turn` 이 없어 정렬에서 뒤로 밀린다.
            //   기본 정렬(turn 내림차순 → importance)만 쓰면 새 노드가 전부 잘린다.
            //   위그로어 `_evictColdUnits` 가 persona/relation 을 절대 evict 하지 않는 것과
            //   같은 판단: 인물은 그래프의 허브라 보존 대상이다.
            const entityReserve = Math.max(32, Math.floor(maxNodes * 0.08));
            const loreReserve = Math.max(48, Math.floor(maxNodes * 0.12));
            const isEntity = node => String(node?.nodeType || '') === 'entity';
            const isLore = node => String(node?.nodeType || '') === 'lore';
            const entityNodes = nodes.filter(isEntity);
            const loreNodes = nodes.filter(isLore);
            const otherNodes = nodes.filter(node => !isEntity(node) && !isLore(node));
            const keptEntity = entityNodes.sort(compareHmeGraphNodeRetention).slice(0, entityReserve);
            const keptLore = loreNodes.sort(compareHmeGraphNodeRetention).slice(0, loreReserve);
            const remaining = Math.max(0, maxNodes - keptEntity.length - keptLore.length);
            const tombstoneReserve = Math.min(80, Math.max(8, Math.floor(remaining * 0.08)));
            const inactive = otherNodes.filter(node => !graphCanUseNode(node)).sort(compareHmeGraphNodeRetention).slice(0, tombstoneReserve);
            const activeBudget = Math.max(0, remaining - inactive.length);
            const active = otherNodes.filter(graphCanUseNode).sort(compareHmeGraphNodeRetention).slice(0, activeBudget);
            return [...keptEntity, ...keptLore, ...active, ...inactive]
                .sort((a, b) => Number(a?.turn || 0) - Number(b?.turn || 0));
        };
        const buildHmeGraphNodeFromRow = (row = null) => {
            if (!row?.id) return null;
            const entityRoles = normalizeHmeGraphEntityRoles(row.entityRoles || {});
            // 엔티티 이름은 전용 정규화 — 조사가 붙은 형태('아리엘은')를 떼어
            //   byEntity 버킷 키가 인물 정본 이름('아리엘')과 만나게 한다.
            const entities = normalizeHmeEntityList([
                ...flattenHmeGraphEntityRoles(entityRoles),
                ...(row.subjects || []),
                ...(row.aliases || [])
            ], 32);
            const topics = normalizeHmeGraphList([
                ...(row.tags || []), ...(row.sceneTags || []), ...(row.emotionTags || []),
                ...(row.relationTags || []), ...(row.worldTags || []), ...(row.narrativeTags || []),
                ...(row.recallKeywords || []), ...(row.summaryContinuity || []),
                row.primaryKind, row.baseBucket
            ], 36);
            const specificTopics = normalizeHmeGraphSpecificList(topics, 24);
            const sourceTurnIds = uniqLimit([row.turn, ...(row.sourceTurnIds || [])].map(Number).filter(v => Number.isFinite(v) && v > 0), 16);
            return {
                id: `g_node_${stableHash(`${row.id}:${row.contentHash || ''}:${row.rollbackState || ''}:${row.stale ? 1 : 0}`)}`,
                nodeType: 'memory',
                rowId: String(row.id || '').trim(),
                version: 2,
                kind: String(row.primaryKind || 'memory').trim() || 'memory',
                kinds: normalizeHmeGraphList(row.kinds || [], 10),
                contentHash: String(row.contentHash || '').trim(),
                summaryHash: stableHash([row.id, row.contentHash, ...entities.slice(0, 4), ...topics.slice(0, 6)].join('|')),
                entityRoles,
                entities,
                topics,
                specificTopics,
                tags: normalizeHmeGraphList(row.tags || [], 20),
                narrativeTags: normalizeHmeGraphList(row.narrativeTags || [], 16),
                arcKey: String(row.arcKey || '').trim(),
                arcRole: String(row.arcRole || '').trim(),
                causalRole: String(row.causalRole || '').trim(),
                primaryConflict: normalizeHmeGraphSpecificList(row.primaryConflict || [], 8),
                relationDelta: normalizeHmeGraphSpecificList(row.relationDelta || [], 8),
                openThreads: normalizeHmeGraphSpecificList(row.openThreads || [], 12),
                relationSignals: normalizeHmeGraphSpecificList(row.relationSignals || [], 12),
                worldChanges: normalizeHmeGraphSpecificList(row.worldChanges || [], 12),
                worldSignature: normalizeHmeGraphSpecificList(row.worldSignature || [], 6),
                worldRuleHighlights: normalizeHmeGraphSpecificList(row.worldRuleHighlights || [], 12),
                objectContinuity: normalizeHmeGraphSpecificList(row.objectContinuity || [], 8),
                placeContinuity: normalizeHmeGraphSpecificList(row.placeContinuity || [], 8),
                sourceRefs: sourceTurnIds.map(turn => `turn:${turn}`),
                sourceTurnIds,
                turn: normalizeLegacyMemoryTurnAnchor(row.turn || 0) || 0,
                importance: Math.max(0, Math.min(1, Number(row.importance || 0.5))),
                baseBucket: String(row.baseBucket || '').trim(),
                rollbackState: normalizeHybridRollbackState(row.rollbackState || 'active'),
                rollbackTombstone: Boolean(row.rollbackTombstone),
                hiddenFromPrompt: Boolean(row.hiddenFromPrompt),
                stale: Boolean(row.stale),
                active: !isHmeGraphRowBlocked(row),
                updatedAt: Date.now()
            };
        };
        // ── 인물(entity) 노드 — 그래프의 허브 ────────────────────────────────
        //
        // 왜 노드로 승격하는가:
        //   기존 그래프는 `lmai_memory` row 만 노드로 만들고, 인물 이름은 기억 노드의
        //   `entities[]` 속성으로만 붙였다. 그래서 "이 인물을 통해 연결된 다른 기억" 을
        //   따라갈 경로가 없었다 — 사용자가 요청한 "인물과 로어북을 연결하는 상설 파이프라인" 이 없다.
        //   인물을 노드로 만들면 E1(memory→entity)·E2(entity→lore)·E3(entity→entity) 엣지가 붙어
        //   인물이 허브가 된다.
        //
        // `turn` 을 채우는 이유: 영속화 정렬이 turn 내림차순이라 turn 없는 노드는 전부 잘린다.
        //   `meta.created` 를 쓰고, 없으면 0 이어도 예산 reserve 로 보존된다(compactHmeGraphNodes).
        const buildHmeGraphEntityNode = (entityRecord = null) => {
            if (!entityRecord || typeof entityRecord !== 'object') return null;
            const canonicalName = String(entityRecord.name || '').trim();
            if (!canonicalName) return null;
            const identity = entityRecord.identity && typeof entityRecord.identity === 'object' ? entityRecord.identity : {};
            const meta = entityRecord.meta && typeof entityRecord.meta === 'object' ? entityRecord.meta : {};
            // 이름 ∪ 별칭 ∪ 숨은 이름키 — byEntity 역색인이 인물 노드와 기억 노드를 함께 잡게 한다.
            const entities = normalizeHmeEntityList([
                canonicalName,
                ...(Array.isArray(identity.aliases) ? identity.aliases : []),
                ...(Array.isArray(meta.aliases) ? meta.aliases : []),
                ...(Array.isArray(meta.hiddenNameKeys) ? meta.hiddenNameKeys : [])
            ], 32);
            const topics = normalizeHmeGraphSpecificList([
                identity.roleInStory, identity.occupation, identity.affiliation, identity.summary
            ], 24);
            const createdTurn = Number(meta.created || 0) || 0;
            return {
                id: `g_ent_${stableHash(canonicalName)}`,
                nodeType: 'entity',
                rowId: `lmai_entity::${stableHash(canonicalName.toLowerCase())}`,
                version: 1,
                kind: 'entity',
                name: canonicalName,
                contentHash: stableHash([canonicalName, ...entities.slice(0, 8)].join('|')),
                summaryHash: stableHash([canonicalName, ...topics.slice(0, 6)].join('|')),
                entityRoles: { primary: [canonicalName], observer: [], mention: [], inferred: [] },
                entities,
                topics,
                specificTopics: topics,
                tags: [],
                narrativeTags: [],
                arcKey: '',
                arcRole: '',
                causalRole: '',
                primaryConflict: [],
                relationDelta: [],
                openThreads: [],
                relationSignals: [],
                worldChanges: [],
                worldSignature: [],
                worldRuleHighlights: [],
                objectContinuity: [],
                placeContinuity: [],
                sourceRefs: [],
                sourceTurnIds: createdTurn ? [createdTurn] : [],
                turn: createdTurn,
                // 인물은 기억보다 우선순위를 높게 둔다 — 허브가 잘리면 그래프가 끊긴다.
                importance: 0.72,
                baseBucket: 'entity',
                rollbackState: 'active',
                rollbackTombstone: false,
                hiddenFromPrompt: false,
                stale: false,
                active: true,
                updatedAt: Date.now()
            };
        };

        // ── 로어(lore) 노드 — 사용자 세계 설정 ──────────────────────────────
        //
        // `03i CharacterLoreCueIndex` 의 cue 를 노드로 승격한다. cue.entityRefs 는
        //   로어 텍스트에서 추출한 인물 참조라 E2(entity→lore) 엣지의 근거가 된다.
        const buildHmeGraphLoreNode = (cue = null) => {
            if (!cue || typeof cue !== 'object') return null;
            const sourceId = String(cue.sourceId || '').trim();
            const chunkIndex = Number(cue.chunkIndex || 0) || 0;
            if (!sourceId && !cue.id) return null;
            const label = String(cue.sourceLabel || sourceId || 'lore').trim();
            const entities = normalizeHmeEntityList([
                ...(Array.isArray(cue.entityRefs) ? cue.entityRefs : [])
            ], 24);
            const topics = normalizeHmeGraphSpecificList([
                ...(Array.isArray(cue.tags) ? cue.tags : []),
                ...(Array.isArray(cue.buckets) ? cue.buckets : [])
            ], 20);
            return {
                id: `g_lore_${stableHash(`${sourceId}:${chunkIndex}:${String(cue.sourceHash || '')}`)}`,
                nodeType: 'lore',
                rowId: `lmai_character_lore_cues::${stableHash(`${sourceId}:${chunkIndex}`)}`,
                version: 1,
                kind: 'lore',
                name: label,
                contentHash: stableHash(String(cue.sourceHash || cue.id || label)),
                summaryHash: stableHash([label, ...entities.slice(0, 4)].join('|')),
                entityRoles: { primary: entities, observer: [], mention: [], inferred: [] },
                entities,
                topics,
                specificTopics: topics,
                tags: normalizeHmeGraphList(Array.isArray(cue.tags) ? cue.tags : [], 20),
                narrativeTags: [],
                arcKey: '',
                arcRole: '',
                causalRole: '',
                primaryConflict: [],
                relationDelta: [],
                openThreads: [],
                relationSignals: [],
                worldChanges: [],
                worldSignature: [],
                worldRuleHighlights: [],
                objectContinuity: [],
                placeContinuity: [],
                sourceRefs: [],
                sourceTurnIds: [],
                // 로어는 서사 시간축이 없다. 예산 reserve 로 보존된다.
                turn: 0,
                importance: 0.55,
                baseBucket: 'lore',
                sourceLoreId: sourceId,
                chunkIndex,
                rollbackState: 'active',
                rollbackTombstone: false,
                hiddenFromPrompt: false,
                stale: false,
                active: true,
                updatedAt: Date.now()
            };
        };

        // 인물·로어 노드를 lorebook 에서 수집한다.
        //   인물: `lmai_entity` comment 항목 (08b ENTITY_COMMENT)
        //   로어: `03i CharacterLoreCueIndex` 의 cue 색인 (비-LIBRA 항목만)
        const buildHmeGraphCrossTypeNodes = (lorebook = []) => {
            const out = [];
            if (!Array.isArray(lorebook) || !lorebook.length) return out;
            let entries = lorebook;
            try {
                if (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack) {
                    entries = LibraLoreConsolidator.unpack(lorebook);
                }
            } catch (_) { entries = Array.isArray(lorebook) ? lorebook : []; }
            const seenEntity = new Set();
            for (const entry of Array.isArray(entries) ? entries : []) {
                if (String(entry?.comment || '') !== 'lmai_entity') continue;
                try {
                    const parsed = JSON.parse(String(entry?.content || '{}'));
                    if (parsed && !seenEntity.has(parsed.name)) {
                        const node = buildHmeGraphEntityNode(parsed);
                        if (node) { seenEntity.add(parsed.name); out.push(node); }
                    }
                } catch (_) { /* 손상 엔트리는 건너뛴다 */ }
            }
            return out;
        };

        const hmeGraphIntersect = (a = [], b = [], limit = 8) => {
            const set = new Set((Array.isArray(a) ? a : []).map(normalizeHmeGraphToken).filter(Boolean));
            const out = [];
            for (const raw of Array.isArray(b) ? b : []) {
                const key = normalizeHmeGraphToken(raw);
                if (key && set.has(key) && !out.includes(key)) out.push(key);
                if (out.length >= limit) break;
            }
            return out;
        };
        const buildHmeGraphEntityDocumentFrequency = (nodes = []) => {
            const frequency = new Map();
            for (const node of Array.isArray(nodes) ? nodes : []) {
                const seen = new Set((node?.entities || []).map(hmeGraphTextKey).filter(Boolean));
                for (const entity of seen) frequency.set(entity, (frequency.get(entity) || 0) + 1);
            }
            return frequency;
        };
        const hmeGraphEntityRoleWeight = (fromRoles = {}, toRoles = {}, entity = '') => {
            const key = hmeGraphTextKey(entity);
            const has = (roles, role) => (roles?.[role] || []).some(value => hmeGraphTextKey(value) === key);
            if (has(fromRoles, 'primary') && has(toRoles, 'primary')) return { weight: 1.0, role: 'primary-primary' };
            if ((has(fromRoles, 'primary') && has(toRoles, 'observer')) || (has(fromRoles, 'observer') && has(toRoles, 'primary'))) return { weight: 0.62, role: 'primary-observer' };
            if (has(fromRoles, 'observer') && has(toRoles, 'observer')) return { weight: 0.35, role: 'observer-observer' };
            if ((has(fromRoles, 'primary') && has(toRoles, 'mention')) || (has(fromRoles, 'mention') && has(toRoles, 'primary'))) return { weight: 0.25, role: 'primary-mention' };
            if (has(fromRoles, 'mention') && has(toRoles, 'mention')) return { weight: 0.12, role: 'mention-mention' };
            if (has(fromRoles, 'inferred') || has(toRoles, 'inferred')) return { weight: 0.08, role: 'inferred' };
            return { weight: 0.10, role: 'entity' };
        };
        const scoreHmeGraphEntityOverlap = (from = null, to = null, entityDf = new Map()) => {
            const sharedEntities = hmeGraphIntersect(from?.entities || [], to?.entities || [], 8);
            const evidence = [];
            const rolePairs = [];
            let score = 0;
            let commonOnly = sharedEntities.length > 0;
            for (const entity of sharedEntities) {
                const key = hmeGraphTextKey(entity);
                const df = Math.max(1, Number(entityDf?.get?.(key) || 1));
                const role = hmeGraphEntityRoleWeight(from?.entityRoles || {}, to?.entityRoles || {}, entity);
                const entityWeight = role.weight / Math.sqrt(df);
                if (df <= 3 || role.weight >= 0.62) commonOnly = false;
                score += entityWeight;
                evidence.push(`entity:${entity}:df${df}:${role.role}`);
                rolePairs.push(role.role);
            }
            return {
                score: Math.min(1, score),
                sharedEntities,
                evidence,
                rolePairs,
                commonOnly
            };
        };
        const hmeGraphRelationDeltaKey = (value = '') => hmeGraphTextKey(value).replace(/^(?:관계|relation|delta)[:\s-]*/i, '').trim();
        // `03i CharacterLoreCueIndex` 의 cue 색인에서 로어 노드를 만든다.
        //   로어 엔트리(`lmai_character_lore_cues`)가 로어북에 있으면 그 payload 의 cues 를 쓴다.
        //   없으면 비-LIBRA 로어 항목 자체를 로어 노드로 승격한다(폴백) — 색인이 아직 빌드되지
        //   않은 턴에도 파이프라인이 비지 않게 한다.
        const buildHmeGraphCueLoreNodes = (lorebook = []) => {
            const out = [];
            if (!Array.isArray(lorebook) || !lorebook.length) return out;
            let entries = lorebook;
            try {
                if (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack) {
                    entries = LibraLoreConsolidator.unpack(lorebook);
                }
            } catch (_) { entries = Array.isArray(lorebook) ? lorebook : []; }
            const list = Array.isArray(entries) ? entries : [];
            // 1순위: 03i 색인 payload 가 있으면 그 cues 가 정본 (entityRefs 가 계산돼 있다).
            for (const entry of list) {
                if (String(entry?.comment || '') !== 'lmai_character_lore_cues') continue;
                try {
                    const payload = JSON.parse(String(entry?.content || '{}'));
                    for (const cue of Array.isArray(payload?.cues) ? payload.cues : []) {
                        const node = buildHmeGraphLoreNode(cue);
                        if (node) out.push(node);
                    }
                } catch (_) { /* 손상 payload 는 건너뛴다 */ }
            }
            if (out.length) return out;
            // 폴백: 색인이 없으면 비-LIBRA 로어 항목을 직접 노드로. entityRefs 는 빈 배열이므로
            //   E2 엣지는 색인이 빌드된 뒤에 붙는다(정직한 한계 — 조사 붙은 이름을 여기서 만들지 않는다).
            const isLibraManaged = (comment) => /^lmai_/.test(String(comment || ''));
            list.forEach((entry, index) => {
                const comment = String(entry?.comment || '');
                if (isLibraManaged(comment)) return;
                const content = String(entry?.content || '').trim();
                if (!content || /^\s*(?:<!--[\s\S]*?-->\s*)+$/.test(content)) return;
                const label = [entry?.key, entry?.comment].map(v => String(v || '').trim()).filter(Boolean).join(' / ')
                    || `Lorebook Entry ${index + 1}`;
                const node = buildHmeGraphLoreNode({
                    id: `fb_${index}`,
                    sourceId: String(entry?.key || entry?.comment || `entry_${index}`),
                    sourceLabel: label,
                    chunkIndex: 0,
                    entityRefs: [],
                    tags: [],
                    buckets: [],
                    sourceHash: stableHash(content.slice(0, 200))
                });
                if (node) out.push(node);
            });
            return out;
        };

        // `lmai_relation` 항목을 이름쌍 → 레코드 맵으로 만든다 (E3 엣지 근거).
        const buildHmeGraphRelationMap = (lorebook = []) => {
            const map = new Map();
            if (!Array.isArray(lorebook) || !lorebook.length) return map;
            let entries = lorebook;
            try {
                if (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack) {
                    entries = LibraLoreConsolidator.unpack(lorebook);
                }
            } catch (_) { entries = Array.isArray(lorebook) ? lorebook : []; }
            for (const entry of Array.isArray(entries) ? entries : []) {
                if (String(entry?.comment || '') !== 'lmai_relation') continue;
                try {
                    const parsed = JSON.parse(String(entry?.content || '{}'));
                    if (parsed && parsed.entityA && parsed.entityB) {
                        map.set(`${String(parsed.entityA)}::${String(parsed.entityB)}`, parsed);
                    }
                } catch (_) { /* 손상 엔트리 건너뜀 */ }
            }
            return map;
        };

        // ── 크로스타입 엣지 (E1~E4) ─────────────────────────────────────────
        //
        // 기존 `hmeGraphEdgeSignal` 은 **기억-기억** 쌍 전용이다(sharedEntities/sharedTopics/
        //   penalties/explanation 이 그 전제로 짜여 있다). 인물·로어 노드는 그 계산이 맞지 않으므로
        //   *별도 함수* 로 만든다 — 기존 루프를 건드리지 않아 회귀 표면이 국소화된다.
        //
        //   E1 memory → entity   `mentions_entity`      role 가중 (primary 1.0 … inferred 0.08)
        //   E2 entity → lore     `described_by_lore`    이름/별칭 일치 (완전 0.78 / 부분 0.45)
        //   E3 entity → entity   `relation_record`      lmai_relation 의 closeness/trust
        //   E4 memory → lore     `shares_lore_ref`      겹침 ≥2 + DF 나눗셈 (클리크 차단)
        // E2 부분 일치의 **단어 경계** 판정.
        //
        // 왜 필요한가 (실측 결함):
        //   종전 규칙은 `key.includes(ek) || ek.includes(key)` 였다. 경계를 보지 않아
        //   `세라` ⊂ `세라핌`, `민아` ⊂ `김민아`, `리엘` ⊂ `아리엘` 이 부분 일치로 성립했고
        //   weight 0.45 > light.edgeWeightMin(0.28) 이라 **실제 엣지**가 되었다.
        //   실측: E2 13건 중 6건이 `exact:0, partial:1` — 전부 부분 문자열만으로 성립.
        //
        // 규칙:
        //   · 완전 일치는 여기 오지 않는다(호출부가 먼저 처리한다).
        //   · 한국어: **접미 조사**만 인정한다. `아리엘은`/`아리엘이`/`아리엘의` → 아리엘.
        //     접두는 인정하지 않는다 — `김민아` ↔ `민아` 는 성씨 유무를 구분할 수 없어 다른 인물이다.
        //   · 영문: 단어 경계를 요구한다(`art` ⊄ `arthur`). 구분자로 이어지면 인정(`art-arthur`).
        //   · 영문/한국어 공통: 긴 쪽이 짧은 쪽으로 **시작**하고 남은 조각이
        //     구분자로 이어질 때만 인정한다 (`art-arthur`, `아리엘 · 아리엘`).
        //   · 한국어 조사(`아리엘은`)는 **앞단에서 이미 정규화**되므로 여기서 다루지 않는다
        //     (실측: entities 추출이 `아리엘은` → `아리엘` 로 만들고 `exact:1` 이 된다).
        const hmeEntityNameBoundaryMatch = (longValue, shortValue) => {
            const longText = String(longValue || '').trim();
            const shortText = String(shortValue || '').trim();
            if (!longText || !shortText || longText === shortText) return false;
            // 긴 쪽이 짧은 쪽으로 **시작**해야 한다(끝 일치는 `민아`⊂`김민아` 를 다시 들여온다).
            if (!longText.startsWith(shortText)) return false;
            const rest = longText.slice(shortText.length);
            if (!rest) return false;
            // 영문: 구분자로 이어진 경우만 인정 (`art-arthur`, `art_arthur`, `art arthur`)
            if (/^[\s._\-·/]+/.test(rest)) return true;
            // 그 밖의 꼬리는 **다른 이름**이다 (`세라핌`, `김민아`)
            return false;
        };

        const buildHmeGraphCrossTypeEdges = (nodes = [], context = {}) => {
            const out = [];
            if (!Array.isArray(nodes) || !nodes.length) return out;
            const byType = { memory: [], entity: [], lore: [] };
            for (const node of nodes) {
                const t = String(node?.nodeType || 'memory');
                if (byType[t]) byType[t].push(node);
            }
            const relations = context.relations instanceof Map ? context.relations : new Map();
            const entityDf = context.entityDf instanceof Map ? context.entityDf : new Map();
            // An exhausted explicit budget is zero, not an omitted/unlimited one.
            const edgeCap = context.maxEdges === undefined ? Infinity : Math.max(0, Number(context.maxEdges) || 0);
            if (edgeCap === 0) return out;
            const seen = new Set();
            const push = (from, to, relation, layer, weight, evidence, explanation) => {
                if (!from?.id || !to?.id || from.id === to.id) return;
                const pair = [from.id, to.id].sort().join('::');
                if (seen.has(pair)) return;
                if (out.length >= edgeCap) return;
                const w = Math.max(0, Math.min(1, Number(weight) || 0));
                if (w <= 0) return;
                seen.add(pair);
                out.push({
                    id: `g_edge_${stableHash(pair)}`,
                    from: from.id,
                    to: to.id,
                    fromVersion: Number(from.version || 1),
                    toVersion: Number(to.version || 1),
                    layer: layer || 'meaning',
                    relation,
                    weight: Number(w.toFixed(4)),
                    confidence: Number(Math.min(1, w + 0.08).toFixed(4)),
                    evidence: Array.isArray(evidence) ? evidence.slice(0, 6) : [],
                    penalties: [],
                    explanation: explanation || `${layer || 'meaning'}:${relation}`,
                    usedForRecall: false,
                    score: Number(w.toFixed(4)),
                    components: {},
                    boundaryClass: 'public',
                    updatedAt: Date.now()
                });
            };

            // ── E1: memory → entity (role 가중) ──
            for (const memory of byType.memory) {
                if (!graphCanUseNode(memory)) continue;
                const roleWeights = [
                    ['primary', 1.0], ['observer', 0.62], ['mention', 0.25], ['inferred', 0.08]
                ];
                for (const [role, weight] of roleWeights) {
                    const names = normalizeHmeEntityList(memory?.entityRoles?.[role] || [], 24);
                    for (const name of names) {
                        const key = normalizeHmeGraphToken(name);
                        const targets = byType.entity.filter(e => (e.entities || []).some(v => normalizeHmeGraphToken(v) === key));
                        for (const entity of targets) {
                            push(memory, entity, 'mentions_entity', 'meaning', weight,
                                [`entity:${name}`, `role:${role}`], `meaning:mentions_entity:${role}`);
                        }
                    }
                }
            }

            // ── E2: entity → lore (이름/별칭 일치) ──
            for (const entity of byType.entity) {
                const entityKeys = new Set((entity.entities || []).map(v => normalizeHmeGraphToken(v)).filter(Boolean));
                if (!entityKeys.size) continue;
                for (const lore of byType.lore) {
                    const loreKeys = (lore.entities || []).map(v => normalizeHmeGraphToken(v)).filter(Boolean);
                    if (!loreKeys.length) continue;
                    let exact = 0;
                    let partial = 0;
                    const hits = [];
                    for (const key of loreKeys) {
                        if (entityKeys.has(key)) { exact += 1; hits.push(key); continue; }
                        for (const ek of entityKeys) {
                            // 경계 인식 — 인라인 includes 는 `세라핌`↔`세라` 를 오탐했다(실측).
                            if (ek && key && (hmeEntityNameBoundaryMatch(key, ek) || hmeEntityNameBoundaryMatch(ek, key))) {
                                partial += 1; hits.push(key); break;
                            }
                        }
                    }
                    if (!exact && !partial) continue;
                    const weight = exact > 0 ? 0.78 : 0.45;
                    push(entity, lore, 'described_by_lore', 'meaning', weight,
                        [...hits.slice(0, 4), `exact:${exact}`, `partial:${partial}`],
                        'meaning:described_by_lore');
                }
            }

            // ── E3: entity → entity (정본 관계 기록) ──
            if (relations.size) {
                const entityByName = new Map(byType.entity.map(e => [normalizeHmeGraphToken(e.name), e]));
                for (const rel of relations.values()) {
                    const a = entityByName.get(normalizeHmeGraphToken(rel?.entityA));
                    const b = entityByName.get(normalizeHmeGraphToken(rel?.entityB));
                    if (!a || !b) continue;
                    const closeness = Number(rel?.metrics?.closeness ?? rel?.details?.closeness);
                    const trust = Number(rel?.metrics?.trust ?? rel?.details?.trust);
                    const parts = [closeness, trust].filter(v => Number.isFinite(v));
                    const base = parts.length ? parts.reduce((x, y) => x + y, 0) / parts.length : 0.3;
                    const weight = Math.max(0.1, Math.min(1, base));
                    push(a, b, 'relation_record', 'meaning', weight,
                        [`relationType:${String(rel?.relationType || '').slice(0, 24)}`],
                        'meaning:relation_record');
                }
            }

            // ── E4: memory → lore (겹침 ≥2 + DF 나눗셈 — 클리크 차단) ──
            for (const memory of byType.memory) {
                if (!graphCanUseNode(memory)) continue;
                const memoryKeys = new Set((memory.entities || []).map(v => normalizeHmeGraphToken(v)).filter(Boolean));
                if (!memoryKeys.size) continue;
                for (const lore of byType.lore) {
                    const shared = (lore.entities || [])
                        .map(v => normalizeHmeGraphToken(v))
                        .filter(k => k && memoryKeys.has(k));
                    // 겹침 1건은 광범위 명사로도 생긴다. 2건 이상만 신호로 인정한다.
                    if (shared.length < 2) continue;
                    const df = Math.max(1, Number(entityDf.get(hmeGraphTextKey(shared[0])) || 1));
                    const weight = Math.min(1, (shared.length / Math.sqrt(df)) * 0.35);
                    if (weight < HME_GRAPH_SIGNAL_THRESHOLD * 0.5) continue;
                    push(memory, lore, 'shares_lore_ref', 'signal', weight,
                        shared.slice(0, 4).map(s => `entity:${s}`), 'signal:shares_lore_ref');
                }
            }
            return out;
        };

        const hmeGraphEdgeSignal = (from = null, to = null, context = {}) => {
            const entityOverlap = scoreHmeGraphEntityOverlap(from, to, context.entityDf || new Map());
            const sharedEntities = entityOverlap.sharedEntities;
            const sharedTopics = hmeGraphIntersect(from?.specificTopics || [], to?.specificTopics || [], 8);
            const sharedRefs = hmeGraphIntersect(from?.sourceRefs || [], to?.sourceRefs || [], 4);
            const sharedThreadTags = hmeGraphIntersect(from?.narrativeTags || [], to?.narrativeTags || [], 4);
            const sharedOpenThreads = hmeGraphIntersect(from?.openThreads || [], to?.openThreads || [], 6);
            const sharedArc = from?.arcKey && to?.arcKey && hmeGraphTextKey(from.arcKey) === hmeGraphTextKey(to.arcKey) && !isHmeGraphGenericTopic(from.arcKey)
                ? [from.arcKey]
                : [];
            const sharedConflict = hmeGraphIntersect(from?.primaryConflict || [], to?.primaryConflict || [], 4);
            const sharedRelationDelta = hmeGraphIntersect(
                (from?.relationDelta || []).map(hmeGraphRelationDeltaKey),
                (to?.relationDelta || []).map(hmeGraphRelationDeltaKey),
                4
            );
            const sharedRelationSignals = hmeGraphIntersect(from?.relationSignals || [], to?.relationSignals || [], 4);
            const sharedWorldSignature = hmeGraphIntersect(from?.worldSignature || [], to?.worldSignature || [], 4);
            const sharedWorldRules = hmeGraphIntersect(from?.worldRuleHighlights || [], to?.worldRuleHighlights || [], 4);
            const sharedObjects = hmeGraphIntersect(from?.objectContinuity || [], to?.objectContinuity || [], 4);
            const sharedPlaces = hmeGraphIntersect(from?.placeContinuity || [], to?.placeContinuity || [], 4);
            const turnGap = Number(from?.turn || 0) > 0 && Number(to?.turn || 0) > 0 ? Math.abs(Number(from.turn) - Number(to.turn)) : Infinity;
            const turnSignal = Number.isFinite(turnGap) && turnGap <= 6 ? Math.max(0, 1 - (turnGap / 7)) : 0;
            const genericTopicPenalty = hmeGraphIntersect(from?.topics || [], to?.topics || [], 8).filter(isHmeGraphGenericTopic).length > 0 && sharedTopics.length === 0 ? 0.12 : 0;
            const stalePenalty = (from?.stale || to?.stale ? 0.08 : 0)
                + (String(from?.rollbackState || '') === 'superseded' || String(to?.rollbackState || '') === 'superseded' ? 0.16 : 0);
            const protagonistOnlyPenalty = entityOverlap.commonOnly && !sharedTopics.length && !sharedArc.length && !sharedOpenThreads.length && !sharedConflict.length && !sharedRelationDelta.length ? 0.20 : 0;
            const entityScore = entityOverlap.score;
            const specificTopicScore = Math.min(1, (sharedTopics.length * 0.22) + (sharedObjects.length * 0.18) + (sharedPlaces.length * 0.18) + (sharedWorldRules.length * 0.22));
            const arcScore = sharedArc.length ? 1 : ((from?.arcRole && to?.arcRole && from.arcRole === to.arcRole && (sharedConflict.length || sharedOpenThreads.length)) ? 0.35 : 0);
            const threadScore = Math.min(1, (sharedOpenThreads.length * 0.42) + (sharedThreadTags.length * 0.16));
            const conflictScore = Math.min(1, sharedConflict.length * 0.70);
            const relationDeltaScore = Math.min(1, (sharedRelationDelta.length * 0.82) + (sharedRelationSignals.length * 0.40));
            const worldScore = Math.min(1, (sharedWorldSignature.length * 0.70) + (sharedWorldRules.length * 0.45));
            const causalPair = [
                `${String(from?.causalRole || '').toLowerCase()}->${String(to?.causalRole || '').toLowerCase()}`,
                `${String(to?.causalRole || '').toLowerCase()}->${String(from?.causalRole || '').toLowerCase()}`
            ].some(value => /(?:cause|trigger|setup|origin)->(?:result|aftermath|resolution|resolved|consequence)/i.test(value));
            const causalScore = causalPair && (sharedArc.length || sharedConflict.length || sharedOpenThreads.length) && turnSignal > 0 ? 0.85 : 0;
            const rawScore = (entityScore * 0.25)
                + (specificTopicScore * 0.15)
                + (Math.max(arcScore, conflictScore, causalScore) * 0.20)
                + (threadScore * 0.20)
                + (Math.max(relationDeltaScore, worldScore) * 0.15)
                + (turnSignal * 0.05);
            const rawFinalScore = Math.max(0, Math.min(1, rawScore - genericTopicPenalty - protagonistOnlyPenalty - stalePenalty));
            const weakSignalFloor = (sharedEntities.length || sharedRefs.length || sharedThreadTags.length || turnSignal > 0)
                ? HME_GRAPH_SIGNAL_THRESHOLD
                : 0;
            const score = Math.max(rawFinalScore, weakSignalFloor);
            if (score < HME_GRAPH_SIGNAL_THRESHOLD) {
                return {
                    weight: 0,
                    score: rawFinalScore,
                    layer: 'none',
                    relation: 'below_threshold',
                    evidence: [],
                    penalties: ['below_signal_threshold'],
                    explanation: 'No graph edge: combined meaning/signal score below threshold.'
                };
            }
            let relation = 'associated_with';
            if (worldScore >= 0.70) relation = [from, to].some(node => /contradict|contradiction|충돌|모순|위반|반박/i.test([...(node.worldChanges || []), ...(node.worldRuleHighlights || [])].join(' '))) ? 'world_rule_contradicts' : 'world_rule_reinforces';
            else if (sharedRelationDelta.length || sharedRelationSignals.length) relation = 'relation_delta';
            else if (causalScore > 0) relation = 'causal_followup';
            else if (sharedConflict.length) relation = 'same_primary_conflict';
            else if (sharedArc.length) relation = 'same_arc';
            else if (sharedOpenThreads.length) relation = /resolved|closed|해소|종결|완료/i.test([...(from.openThreads || []), ...(to.openThreads || [])].join(' ')) ? 'resolves_thread' : 'continues_thread';
            else if (sharedObjects.length) relation = 'same_object_continuity';
            else if (sharedPlaces.length) relation = 'same_place_continuity';
            else if (sharedThreadTags.length) relation = 'same_thread';
            else if (sharedRefs.length) relation = 'same_source_ref';
            else if (sharedEntities.length) relation = 'shared_entity';
            else if (sharedTopics.length) relation = 'shared_topic';
            else if (turnSignal > 0) relation = 'turn_proximity';
            const strongEvidence = sharedArc.length || sharedConflict.length || sharedOpenThreads.length || sharedRelationDelta.length || sharedRelationSignals.length || sharedWorldSignature.length || sharedWorldRules.length || sharedObjects.length || sharedPlaces.length || causalScore > 0;
            const layer = score >= HME_GRAPH_MEANING_THRESHOLD && strongEvidence ? 'meaning' : 'signal';
            const weight = layer === 'meaning'
                ? score
                : Math.min(0.64, score * (relation === 'shared_entity' ? 0.72 : 0.86));
            const penalties = uniqLimit([
                ...(entityOverlap.commonOnly && sharedEntities.length ? ['penalty:common_entity_only'] : []),
                ...(genericTopicPenalty > 0 ? ['penalty:generic_topic_only'] : []),
                ...(protagonistOnlyPenalty > 0 ? ['penalty:protagonist_or_common_entity_only'] : []),
                ...(stalePenalty > 0 ? ['penalty:stale_or_superseded'] : [])
            ], 8);
            const evidence = uniqLimit([
                ...entityOverlap.evidence,
                ...sharedTopics.map(v => `topic:${v}`),
                ...sharedRefs.map(v => `source:${v}`),
                ...sharedThreadTags.map(v => `thread_tag:${v}`),
                ...sharedOpenThreads.map(v => `thread:${v}`),
                ...sharedArc.map(v => `arc:${v}`),
                ...sharedConflict.map(v => `conflict:${v}`),
                ...sharedRelationDelta.map(v => `relation_delta:${v}`),
                ...sharedWorldSignature.map(v => `world_signature:${v}`),
                ...sharedWorldRules.map(v => `world_rule:${v}`),
                ...sharedObjects.map(v => `object:${v}`),
                ...sharedPlaces.map(v => `place:${v}`),
                ...(turnSignal > 0 ? [`turn_gap:${turnGap}`] : [])
            ], 18);
            const explanation = [
                `${layer}:${relation}`,
                strongEvidence ? 'structured evidence present' : 'weak associative signal only',
                penalties.length ? penalties.join(',') : ''
            ].filter(Boolean).join(' | ');
            return {
                weight,
                score,
                layer,
                relation,
                confidence: Math.min(1, score + (layer === 'meaning' ? 0.08 : 0.02)),
                evidence,
                penalties,
                explanation,
                usedForRecall: false,
                components: {
                    entityScore: Number(entityScore.toFixed(4)),
                    specificTopicScore: Number(specificTopicScore.toFixed(4)),
                    arcScore: Number(Math.max(arcScore, conflictScore, causalScore).toFixed(4)),
                    threadScore: Number(threadScore.toFixed(4)),
                    relationDeltaScore: Number(Math.max(relationDeltaScore, worldScore).toFixed(4)),
                    turnProximityScore: Number(turnSignal.toFixed(4)),
                    genericTopicPenalty: Number(genericTopicPenalty.toFixed(4)),
                    protagonistOnlyPenalty: Number(protagonistOnlyPenalty.toFixed(4)),
                    stalePenalty: Number(stalePenalty.toFixed(4))
                }
            };
        };
        const buildHmeGraphBuckets = (nodes = []) => {
            const byRowId = {}, byEntity = {}, byTopic = {}, bySourceRef = {}, byThread = {}, bySourceTurn = {}, byArc = {}, byWorldSignature = {}, byRelationDelta = {}, byTurn = {};
            const add = (bucket, key, id) => {
                const normalized = normalizeHmeGraphToken(key);
                if (!normalized || !id) return;
                if (!bucket[normalized]) bucket[normalized] = [];
                if (!bucket[normalized].includes(id) && bucket[normalized].length < HME_GRAPH_BUCKET_LIMIT) bucket[normalized].push(id);
            };
            for (const node of nodes) {
                if (!node?.id || !node?.rowId) continue;
                byRowId[node.rowId] = node.id;
                if (!graphCanUseNode(node)) continue;
                (node.entities || []).forEach(value => add(byEntity, value, node.id));
                (node.topics || []).forEach(value => add(byTopic, value, node.id));
                (node.sourceRefs || []).forEach(value => add(bySourceRef, value, node.id));
                (node.narrativeTags || []).forEach(value => add(byThread, value, node.id));
                (node.sourceTurnIds || []).forEach(value => add(bySourceTurn, String(value), node.id));
                (node.openThreads || []).forEach(value => add(byThread, value, node.id));
                if (node.arcKey) add(byArc, node.arcKey, node.id);
                (node.worldSignature || []).forEach(value => add(byWorldSignature, value, node.id));
                (node.relationDelta || []).forEach(value => add(byRelationDelta, value, node.id));
                if (node.turn) add(byTurn, String(node.turn), node.id);
            }
            return { byRowId, byEntity, byTopic, bySourceRef, byThread, bySourceTurn, byArc, byWorldSignature, byRelationDelta, byTurn };
        };
        const buildHmeGraphEdgeBuckets = (edges = []) => {
            const byLayer = {}, byRelation = {};
            const add = (bucket, key, id) => {
                const normalized = String(key || '').trim() || 'unknown';
                if (!id) return;
                if (!bucket[normalized]) bucket[normalized] = [];
                if (!bucket[normalized].includes(id) && bucket[normalized].length < HME_GRAPH_BUCKET_LIMIT * 4) bucket[normalized].push(id);
            };
            for (const edge of Array.isArray(edges) ? edges : []) {
                if (!edge?.id) continue;
                add(byLayer, edge.layer || 'signal', edge.id);
                add(byRelation, edge.relation || 'associated_with', edge.id);
            }
            return { byLayer, byRelation };
        };
        const buildHmeGraphStats = (nodes = [], edges = [], staleEdgeCount = 0) => {
            const relationCounts = {};
            const layerCounts = {};
            for (const edge of Array.isArray(edges) ? edges : []) {
                const relation = String(edge?.relation || 'associated_with').trim();
                const layer = String(edge?.layer || 'signal').trim();
                relationCounts[relation] = (relationCounts[relation] || 0) + 1;
                layerCounts[layer] = (layerCounts[layer] || 0) + 1;
            }
            const nodeCount = Array.isArray(nodes) ? nodes.length : 0;
            const edgeCount = Array.isArray(edges) ? edges.length : 0;
            // 종류별 **보존** 수 — 화면 뷰가 담는 수와 다르다(뷰는 화면 상한으로 더 자른다).
            //   둘을 구분하지 않으면 "로어가 상한에 밀려 36개만 남았다" 로 오진한다 —
            //   실측: 그래프는 96개를 보존하는데 뷰는 36개만 보여줬다.
            const nodeTypeCounts = {};
            for (const n of (Array.isArray(nodes) ? nodes : [])) {
                const k = String(n?.nodeType || 'memory').trim() || 'memory';
                nodeTypeCounts[k] = (nodeTypeCounts[k] || 0) + 1;
            }
            return {
                nodeCount,
                edgeCount,
                meaningEdgeCount: Number(layerCounts.meaning || 0),
                signalEdgeCount: Number(layerCounts.signal || 0),
                activeNodeCount: (Array.isArray(nodes) ? nodes : []).filter(graphCanUseNode).length,
                tombstoneNodeCount: (Array.isArray(nodes) ? nodes : []).filter(node => node.rollbackTombstone || normalizeHybridRollbackState(node.rollbackState || 'active') === 'candidate_deleted').length,
                staleEdgeCount: Number(staleEdgeCount || 0),
                relationCounts,
                layerCounts,
                nodeTypeCounts,
                averageDegree: nodeCount ? Number(((edgeCount * 2) / nodeCount).toFixed(4)) : 0,
                density: nodeCount > 1 ? Number((edgeCount / ((nodeCount * (nodeCount - 1)) / 2)).toFixed(6)) : 0
            };
        };
        const collectHmeGraphNeighbors = (node = null, buckets = {}) => {
            const out = new Set();
            const collect = (bucket, values = []) => {
                for (const value of values) {
                    const list = bucket?.[normalizeHmeGraphToken(value)];
                    if (Array.isArray(list)) list.forEach(id => { if (id && id !== node?.id) out.add(id); });
                    if (out.size >= HME_GRAPH_BUCKET_LIMIT) return;
                }
            };
            collect(buckets.byEntity, node?.entities || []);
            collect(buckets.bySourceRef, node?.sourceRefs || []);
            collect(buckets.byThread, node?.narrativeTags || []);
            collect(buckets.byThread, node?.openThreads || []);
            collect(buckets.byTopic, node?.specificTopics || node?.topics || []);
            collect(buckets.byArc, node?.arcKey ? [node.arcKey] : []);
            collect(buckets.byWorldSignature, node?.worldSignature || []);
            collect(buckets.byRelationDelta, node?.relationDelta || []);
            (node?.sourceTurnIds || []).forEach(turn => [-1, 0, 1].forEach(delta => collect(buckets.bySourceTurn, [String(Number(turn) + delta)])));
            return Array.from(out).slice(0, HME_GRAPH_BUCKET_LIMIT);
        };
        // HME freshness — **엔티티·로어 변경 감지**용 digest.
        //
        // 왜 필요한가 (실측 결함):
        //   종전 source 에는 `hmeScopeIndexDigest` 하나만 있었고, 그 digest 는 `10d:267` 에서
        //   **기억 row 만** 반영한다(row.id:contentHash:rollbackState:stale).
        //   → 엔티티(lmai_entity)·로어(lmai_character_lore_cues)가 바뀌어도 digest 가 같아
        //     재구축 판정이 "변경 없음"으로 보고 **E1/E2 엣지가 stale 로 남는다**.
        //   E1(memory→entity)·E2(entity→lore) 의 입력이 바로 그 엔티티·로어다.
        //
        // ★ 노드가 아니라 **원본 엔트리**를 본다 (실측): 노드의 `summaryHash` 는
        //   `[canonicalName, ...topics]` 인데 `topics` 가 정규화를 거치며 `identity.summary` 를
        //   버린다 → 요약이 바뀌어도 해시가 같았다. digest 는 입력을 **직접** 봐야 한다.
        const hmeGraphInputDigest = (entries = [], kind = 'entity') => {
            const list = (Array.isArray(entries) ? entries : []);
            const parts = [];
            for (const entry of list) {
                const comment = String(entry?.comment || '');
                if (kind === 'entity' && comment !== 'lmai_entity') continue;
                if (kind === 'lore' && comment !== 'lmai_character_lore_cues') continue;
                // ★ E3 는 `lmai_relation` 의 closeness/trust 를 읽는다(10c:816) — 그 변경이
                //   digest 에 없으면 relation 만 바뀌었을 때 E3 edge 가 **stale** 로 남는다(P1).
                if (kind === 'relation' && comment !== 'lmai_relation') continue;
                // ★ 엔트리 원문을 **정규화**해서 넣는다. 원문을 그대로 넣으면
                //   내용이 같은데 순서만 바뀐 경우(로어 cue 재정렬)도 '변경'으로 잡혀
                //   불필요한 재구축이 일어난다(게이트 실측: loreDigest 가 순서에 의존했다).
                //   JSON 을 파싱해 **키를 정렬**하고 넣는다 — 파싱 실패하면 원문을 쓴다.
                let normalized = String(entry?.content || '');
                try {
                    const parsed = JSON.parse(normalized);
                    // 큐·목록 배열은 **항목 단위로 정렬**한다 — 같은 내용인데 순서만 바뀐 경우,
                    //   제품은 노드 id 를 순서 기반으로 만들기 때문에 엣지가 재생성된다.
                    //   digest 는 '무엇이 들어 있나'를 봐야지 '어떤 순서로 왔나'를 보면 안 된다.
                    // 순서 기반 식별자는 제외한다 — `id: 'cue_0'`·`sourceHash: 'h0'` 같은 값은
                    //   내용이 아니라 **위치**를 담으므로, 순서만 바뀌어도 digest 를 흔든다.
                    const POSITIONAL_KEYS = new Set(['id', 'cueId', 'cue_id', 'sourceHash', 'source_hash', 'chunkIndex', 'chunk_index', 'updatedAt', 'updated_at', 'priority']);
                    const sortValue = (value) => {
                        if (Array.isArray(value)) {
                            // ★ **모든** 배열을 정렬한다 — 객체 배열을 그대로 두면 큐 순서만 바뀌어도
                            //   digest 가 흔들린다(실측: `text` 가 '아리엘 로어' ↔ '세라 로어' 로 달라졌다).
                            //   직렬화 후 문자열 정렬이 가장 단순하고 결정적이다.
                            return value
                                .map(item => JSON.stringify(sortValue(item)))
                                .sort();
                        }
                        if (value && typeof value === 'object') {
                            const sorted = {};
                            for (const k of Object.keys(value).sort()) {
                                if (POSITIONAL_KEYS.has(k)) continue;
                                sorted[k] = sortValue(value[k]);
                            }
                            return sorted;
                        }
                        return value;
                    };
                    normalized = JSON.stringify(sortValue(parsed));
                } catch (_) {}
                parts.push(String(entry?.key || '') + '\u0001' + String(entry?.secondkey || '') + '\u0001' + normalized);
            }
            if (!parts.length) return '';
            return String(TokenizerEngine.simpleHash(parts.sort().join('\u0002')));
        };
        // lorebook 원문(엔트리 배열)을 얻는다 — unpack 이 있으면 그것을 쓴다.
        const hmeGraphInputEntries = (lorebook = []) => {
            try {
                if (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack) {
                    const unpacked = LibraLoreConsolidator.unpack(lorebook);
                    if (Array.isArray(unpacked)) return unpacked;
                }
            } catch (_) {}
            return Array.isArray(lorebook) ? lorebook : [];
        };
        const buildHmeGraphIndexFromScopeIndex = (scopeIndex = null, options = {}) => {
            if (!scopeIndex || scopeIndex.schema !== HME_SCOPE_INDEX_SCHEMA) return null;
            const scopeKey = getHybridScopeKey(options.scopeKey || scopeIndex.scopeKey);
            const preset = getHmeGraphPreset();
            const typedNodes = Array.isArray(options.typedNodes) ? options.typedNodes : null;
            let nodes = typedNodes || hmeIndexRows(scopeIndex).map(buildHmeGraphNodeFromRow).filter(Boolean);
            // 인물·로어 노드를 lorebook 에서 승격 (있으면). 없으면 기존 동작 그대로.
            const lorebookEntries = Array.isArray(options.lorebook)
                ? options.lorebook
                : (Array.isArray(options.entries) ? options.entries : []);
            const crossTypeNodes = typedNodes ? [] : buildHmeGraphCrossTypeNodes(lorebookEntries);
            let cueLoreNodes = [];
            if (!typedNodes && (crossTypeNodes.length || lorebookEntries.length)) {
                cueLoreNodes = buildHmeGraphCueLoreNodes(lorebookEntries);
                nodes = [...nodes, ...crossTypeNodes, ...cueLoreNodes];
            }
            nodes = compactHmeGraphNodes(nodes, preset);
            const nodeById = new Map(nodes.map(node => [node.id, node]));
            const buckets = buildHmeGraphBuckets(nodes);
            const entityDf = buildHmeGraphEntityDocumentFrequency(nodes);
            // Structural links must survive dense pairwise signals without increasing the shared cap.
            const edges = buildHmeGraphCrossTypeEdges(nodes, {
                relations: buildHmeGraphRelationMap(lorebookEntries), entityDf,
                maxEdges: Number(preset.maxEdges || 6000)
            });
            const seen = new Set(edges.map(edge => [edge.from, edge.to].sort().join('::')));
            const adjacentByNode = {};
            const nodeVersionById = {};
            nodes.forEach(node => { nodeVersionById[node.id] = Number(node.version || 1); });
            for (const edge of edges) {
                (adjacentByNode[edge.from] ||= []).push(edge.id);
                (adjacentByNode[edge.to] ||= []).push(edge.id);
            }
            for (const node of nodes) {
                if (!graphCanUseNode(node)) continue;
                const localEdges = [];
                for (const otherId of collectHmeGraphNeighbors(node, buckets)) {
                    const other = nodeById.get(otherId);
                    if (!other || !graphCanUseNode(other)) continue;
                    const pair = [node.id, other.id].sort().join('::');
                    if (seen.has(pair)) continue;
                    const signal = hmeGraphEdgeSignal(node, other, { entityDf });
                    const edgeWeightMin = signal.layer === 'signal'
                        ? Math.min(Number(preset.edgeWeightMin || 0), HME_GRAPH_SIGNAL_THRESHOLD * 0.72)
                        : Number(preset.edgeWeightMin || 0);
                    if (signal.weight < edgeWeightMin) continue;
                    localEdges.push({ other, pair, signal });
                }
                localEdges
                    .sort((a, b) => Number(b.signal.weight || 0) - Number(a.signal.weight || 0))
                    .slice(0, Math.min(HME_GRAPH_EDGE_LIMIT_PER_NODE, Math.max(0, Number(preset.maxEdges || 6000) - edges.length)))
                    .forEach(({ other, pair, signal }) => {
                        seen.add(pair);
                        if (edges.length >= Number(preset.maxEdges || 6000)) return;
                        const edge = {
                            id: `g_edge_${stableHash(pair)}`,
                            from: node.id,
                            to: other.id,
                            fromVersion: Number(node.version || 1),
                            toVersion: Number(other.version || 1),
                            layer: signal.layer || 'signal',
                            relation: signal.relation,
                            weight: Number(signal.weight.toFixed(4)),
                            confidence: Number(Math.min(1, signal.confidence || signal.weight + 0.08).toFixed(4)),
                            evidence: signal.evidence,
                            penalties: signal.penalties || [],
                            explanation: signal.explanation || '',
                            usedForRecall: false,
                            score: Number((signal.score || signal.weight || 0).toFixed(4)),
                            components: signal.components || {},
                            boundaryClass: 'public',
                            updatedAt: Date.now()
                        };
                        edges.push(edge);
                        if (!adjacentByNode[edge.from]) adjacentByNode[edge.from] = [];
                        if (!adjacentByNode[edge.to]) adjacentByNode[edge.to] = [];
                        adjacentByNode[edge.from].push(edge.id);
                        adjacentByNode[edge.to].push(edge.id);
                    });
            }
            const edgeBuckets = buildHmeGraphEdgeBuckets(edges);
            return {
                schema: HME_GRAPH_INDEX_SCHEMA,
                version: HME_GRAPH_INDEX_VERSION,
                source: {
                    derivedFrom: HME_SCOPE_INDEX_COMMENT,
                    hmeScopeIndexDigest: String(scopeIndex.digest || ''),
                    hmeScopeIndexSchema: HME_SCOPE_INDEX_SCHEMA,
                    // 엔티티·로어 입력 식별자 — 없으면 그 변경이 그래프에 반영되지 않는다(#6).
                    entityDigest: hmeGraphInputDigest(lorebookEntries, 'entity'),
                    loreDigest: hmeGraphInputDigest(lorebookEntries, 'lore'),
                    relationDigest: hmeGraphInputDigest(lorebookEntries, 'relation'),
                    rebuiltAt: Date.now()
                },
                scopeKey,
                scopeHash: getHybridScopeHash(scopeKey),
                updatedAt: Date.now(),
                stats: buildHmeGraphStats(nodes, edges, 0),
                nodes,
                edges,
                ...buckets,
                ...edgeBuckets,
                adjacentByNode,
                nodeVersionById,
                policy: {
                    rawRetention: 'signals_only',
                    authority: 'retrieval_hint_only',
                    meaningThreshold: HME_GRAPH_MEANING_THRESHOLD,
                    signalThreshold: HME_GRAPH_SIGNAL_THRESHOLD,
                    defaultInjection: 'merge_existing_sections',
                    maxSeeds: preset.maxSeeds,
                    maxCandidates: preset.maxCandidates,
                    maxNodes: preset.maxNodes,
                    maxEdges: preset.maxEdges,
                    maxHops: preset.maxHops,
                    bonusCap: preset.bonusCap
                }
            };
        };
        const rebuildHmeGraphRuntimeShape = (graph = null) => {
            if (!graph || !isHmeGraphIndexSchema(graph.schema) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
            Object.assign(graph, buildHmeGraphBuckets(graph.nodes || []));
            Object.assign(graph, buildHmeGraphEdgeBuckets(graph.edges || []));
            graph.adjacentByNode = {};
            graph.nodeVersionById = {};
            graph.nodes.forEach(node => {
                if (node?.id) graph.nodeVersionById[node.id] = Number(node.version || 1);
            });
            graph.edges.forEach(edge => {
                if (!edge?.id || !edge.from || !edge.to) return;
                if (!edge.layer) edge.layer = ['shared_entity', 'shared_topic', 'same_source_ref', 'turn_proximity', 'associated_with'].includes(String(edge.relation || '')) ? 'signal' : 'meaning';
                if (!Array.isArray(edge.penalties)) edge.penalties = [];
                if (!edge.explanation) edge.explanation = `${edge.layer || 'signal'}:${edge.relation || 'associated_with'}`;
                edge.usedForRecall = edge.usedForRecall === true;
                if (!graph.adjacentByNode[edge.from]) graph.adjacentByNode[edge.from] = [];
                if (!graph.adjacentByNode[edge.to]) graph.adjacentByNode[edge.to] = [];
                graph.adjacentByNode[edge.from].push(edge.id);
                graph.adjacentByNode[edge.to].push(edge.id);
            });
            graph.stats = {
                ...(graph.stats || {}),
                ...buildHmeGraphStats(graph.nodes || [], graph.edges || [], Number(graph.stats?.staleEdgeCount || 0)),
                lastStaleEdgeCount: Number(graph.stats?.lastStaleEdgeCount || graph.stats?.rebuiltFromStaleEdgeCount || 0),
                lastStaleEdgeRatio: Number(graph.stats?.lastStaleEdgeRatio || graph.stats?.rebuiltFromStaleEdgeRatio || 0)
            };
            return graph;
        };
        const ensureHmeGraphRuntimeShape = (graph = null) => {
            if (!graph || !isHmeGraphIndexSchema(graph.schema) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
            if (!graph.byRowId || !graph.adjacentByNode || !graph.nodeVersionById || !graph.byLayer || !graph.byRelation) return rebuildHmeGraphRuntimeShape(graph);
            return graph;
        };
        const isHmeGraphEdgeFresh = (edge = null, graph = null) => {
            if (!edge || !graph?.nodeVersionById) return false;
            const fromVersion = graph.nodeVersionById[edge.from];
            const toVersion = graph.nodeVersionById[edge.to];
            return fromVersion !== undefined
                && toVersion !== undefined
                && Number(fromVersion) === Number(edge.fromVersion)
                && Number(toVersion) === Number(edge.toVersion);
        };
        const analyzeHmeGraphStaleEdges = (graph = null) => {
            const runtimeGraph = ensureHmeGraphRuntimeShape(graph);
            const edges = hmeGraphEdges(runtimeGraph);
            let staleCount = 0;
            let missingNodeCount = 0;
            let versionMismatchCount = 0;
            let invalidEdgeCount = 0;
            for (const edge of edges) {
                if (!edge?.from || !edge?.to) {
                    staleCount += 1;
                    invalidEdgeCount += 1;
                    continue;
                }
                const fromVersion = runtimeGraph?.nodeVersionById?.[edge.from];
                const toVersion = runtimeGraph?.nodeVersionById?.[edge.to];
                if (fromVersion === undefined || toVersion === undefined) {
                    staleCount += 1;
                    missingNodeCount += 1;
                    continue;
                }
                if (Number(fromVersion) !== Number(edge.fromVersion) || Number(toVersion) !== Number(edge.toVersion)) {
                    staleCount += 1;
                    versionMismatchCount += 1;
                }
            }
            return {
                total: edges.length,
                staleCount,
                staleRatio: edges.length ? staleCount / edges.length : 0,
                missingNodeCount,
                versionMismatchCount,
                invalidEdgeCount
            };
        };
        const pruneStaleHmeGraphEdges = (graph = null, analysis = null) => {
            const runtimeGraph = ensureHmeGraphRuntimeShape(graph);
            if (!runtimeGraph) return { graph, changed: false, analysis: analysis || analyzeHmeGraphStaleEdges(graph) };
            const staleAnalysis = analysis || analyzeHmeGraphStaleEdges(runtimeGraph);
            if (!staleAnalysis.staleCount) {
                runtimeGraph.stats = { ...(runtimeGraph.stats || {}), staleEdgeCount: 0 };
                return { graph: runtimeGraph, changed: false, analysis: staleAnalysis };
            }
            const freshEdges = hmeGraphEdges(runtimeGraph).filter(edge => isHmeGraphEdgeFresh(edge, runtimeGraph));
            const now = Date.now();
            const pruned = {
                ...runtimeGraph,
                updatedAt: now,
                source: {
                    ...(runtimeGraph.source || {}),
                    staleEdgePrunedAt: now,
                    staleEdgePruneReason: 'stale_edge_policy'
                },
                stats: {
                    ...(runtimeGraph.stats || {}),
                    edgeCount: freshEdges.length,
                    staleEdgeCount: 0,
                    lastStaleEdgeCount: staleAnalysis.staleCount,
                    lastStaleEdgeRatio: Number(staleAnalysis.staleRatio.toFixed(4)),
                    staleEdgePrunedCount: Math.max(0, hmeGraphEdges(runtimeGraph).length - freshEdges.length)
                },
                edges: freshEdges
            };
            return { graph: rebuildHmeGraphRuntimeShape(pruned), changed: true, analysis: staleAnalysis };
        };
        const getHmeGraphStaleRebuildMap = () => {
            if (!MemoryState.hmeGraphStaleRebuildByScope || typeof MemoryState.hmeGraphStaleRebuildByScope.get !== 'function') {
                MemoryState.hmeGraphStaleRebuildByScope = new Map();
            }
            return MemoryState.hmeGraphStaleRebuildByScope;
        };
        const shouldRebuildHmeGraphForStaleEdges = (analysis = null, scopeKey = '') => {
            const policy = HME_GRAPH_STALE_EDGE_POLICY;
            if (!policy.enabled || !policy.rebuildEnabled) return false;
            if (!analysis || Number(analysis.total || 0) < policy.minEdges) return false;
            if (Number(analysis.staleRatio || 0) < policy.rebuildRatio) return false;
            const map = getHmeGraphStaleRebuildMap();
            const key = getHybridScopeHash(scopeKey);
            const last = map.get(key);
            const now = Date.now();
            if (last && Number(MemoryState.currentTurn || 0) > 0 && Number(last.turn || 0) === Number(MemoryState.currentTurn || 0)) return false;
            if (last && (now - Number(last.at || 0)) < policy.cooldownMs) return false;
            return true;
        };
        const markHmeGraphStaleRebuild = (scopeKey = '', analysis = null) => {
            const map = getHmeGraphStaleRebuildMap();
            map.set(getHybridScopeHash(scopeKey), {
                at: Date.now(),
                turn: MemoryState.currentTurn || 0,
                staleCount: Number(analysis?.staleCount || 0),
                staleRatio: Number(Number(analysis?.staleRatio || 0).toFixed(4))
            });
            while (map.size > 48) map.delete(map.keys().next().value);
        };
        const parseHmeGraphIndexEntry = (entry = null) => {
            if (!entry || String(entry?.comment || '').trim() !== HME_GRAPH_INDEX_COMMENT) return null;
            try { return ensureHmeGraphRuntimeShape(JSON.parse(String(entry.content || '{}'))); } catch (error) { if (CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA][HMEGraph] parse failed:', error?.message || error); return null; }
        };
        const findHmeGraphIndexInLore = (lorebook = [], scopeKey = '') => {
            const scope = getHybridScopeKey(scopeKey);
            const scopeHash = getHybridScopeHash(scope);
            const candidates = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .filter(entry => String(entry?.comment || '').trim() === HME_GRAPH_INDEX_COMMENT)
                .map(parseHmeGraphIndexEntry)
                .filter(Boolean);
            return candidates
                .filter(graph => !scopeHash || String(graph.scopeHash || '') === scopeHash || String(graph.scopeKey || '') === scope)
                .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
        };
        const compactHmeGraphNodeForPersistence = (node = null) => {
            if (!node || typeof node !== 'object') return null;
            return {
                id: String(node.id || ''),
                rowId: String(node.rowId || ''),
                memoryKey: String(node.memoryKey || ''),
                turn: Number(node.turn || 0) || 0,
                version: Number(node.version || 1) || 1,
                importance: Number(node.importance || 0) || 0,
                confidence: Number(node.confidence || 0) || 0,
                kind: String(node.kind || ''),
                bucket: String(node.bucket || ''),
                arcKey: String(node.arcKey || ''),
                summary: String(node.summary || '').slice(0, 360),
                entities: compactHmeIndexArray(node.entities, 8),
                primaryEntities: compactHmeIndexArray(node.primaryEntities, 6),
                topics: compactHmeIndexArray(node.topics, 8),
                specificTopics: compactHmeIndexArray(node.specificTopics, 8),
                narrativeTags: compactHmeIndexArray(node.narrativeTags, 6),
                relationDelta: compactHmeIndexArray(node.relationDelta, 6),
                worldSignature: compactHmeIndexArray(node.worldSignature, 6),
                openThreads: compactHmeIndexArray(node.openThreads, 6),
                sourceRefs: compactHmeIndexArray(node.sourceRefs, 6),
                sourceTurnIds: compactHmeIndexArray(node.sourceTurnIds, 6)
            };
        };
        const compactHmeGraphEdgeForPersistence = (edge = null) => {
            if (!edge || typeof edge !== 'object') return null;
            return {
                id: String(edge.id || ''),
                from: String(edge.from || ''),
                to: String(edge.to || ''),
                fromVersion: Number(edge.fromVersion || 0) || 0,
                toVersion: Number(edge.toVersion || 0) || 0,
                layer: String(edge.layer || ''),
                relation: String(edge.relation || ''),
                weight: Number(Number(edge.weight || 0).toFixed(4)),
                confidence: Number(Number(edge.confidence || 0).toFixed(4)),
                score: Number(Number(edge.score || edge.weight || 0).toFixed(4))
            };
        };
        const compactHmeGraphForPersistence = (graph = null) => {
            if (!graph || graph.schema !== HME_GRAPH_INDEX_SCHEMA) return graph;
            const preset = getHmeGraphPreset();
            const maxNodes = Math.max(64, Math.min(2400, Number(preset.maxNodes || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxNodes || 800) || 800));
            const maxEdges = Math.max(128, Math.min(4096, Number(preset.maxEdges || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxEdges || 1024) || 1024));
            const candidateEdges = hmeGraphEdges(graph)
                .sort((a, b) => Number(b.weight || b.score || 0) - Number(a.weight || a.score || 0))
                .slice(0, maxEdges);
            // Persist isolated nodes as well as connected nodes. Dropping isolated
            // nodes made live incremental graphs restart from an empty persisted graph
            // every turn, so later rows never had prior neighbors to connect with.
            const nodes = hmeGraphNodes(graph)
                .sort((a, b) => Number(b?.turn || 0) - Number(a?.turn || 0)
                    || Number(b?.importance || 0) - Number(a?.importance || 0)
                    || String(a?.id || '').localeCompare(String(b?.id || '')))
                .slice(0, maxNodes)
                .map(compactHmeGraphNodeForPersistence)
                .filter(Boolean);
            const nodeIds = new Set(nodes.map(node => node.id).filter(Boolean));
            const edges = candidateEdges
                .filter(edge => nodeIds.has(String(edge?.from || '')) && nodeIds.has(String(edge?.to || '')))
                .map(compactHmeGraphEdgeForPersistence)
                .filter(Boolean);
            return {
                schema: HME_GRAPH_INDEX_SCHEMA,
                version: HME_GRAPH_INDEX_VERSION,
                source: graph.source || {},
                scopeKey: graph.scopeKey || '',
                scopeHash: graph.scopeHash || getHybridScopeHash(graph.scopeKey || ''),
                updatedAt: graph.updatedAt || Date.now(),
                stats: buildHmeGraphStats(nodes, edges, Number(graph.stats?.staleEdgeCount || 0)),
                nodes,
                edges,
                policy: {
                    ...(graph.policy || {}),
                    persistedShape: 'compact_runtime_rebuild',
                    maxSeeds: preset.maxSeeds,
                    maxCandidates: preset.maxCandidates,
                    maxNodes: preset.maxNodes,
                    maxEdges: preset.maxEdges,
                    maxHops: preset.maxHops,
                    bonusCap: preset.bonusCap
                }
            };
        };
        const upsertHmeGraphIndexEntry = (entries = [], graph = null) => {
            if (!Array.isArray(entries) || !graph || graph.schema !== HME_GRAPH_INDEX_SCHEMA) return false;
            for (let i = entries.length - 1; i >= 0; i -= 1) {
                if (String(entries[i]?.comment || '').trim() === HME_GRAPH_INDEX_COMMENT) entries.splice(i, 1);
            }
            try { HmeDerivedCacheStore.scheduleWrite('graph', graph.scopeKey, compactHmeGraphForPersistence(graph)); } catch (_) {}
            return true;
        };
        const cacheHmeGraphIndex = (graph = null, scopeKey = '') => {
            if (!graph || graph.schema !== HME_GRAPH_INDEX_SCHEMA || Number(graph.version || 0) !== HME_GRAPH_INDEX_VERSION) return;
            const runtimeGraph = ensureHmeGraphRuntimeShape(graph);
            if (!runtimeGraph) return;
            const scope = getHybridScopeKey(scopeKey || runtimeGraph.scopeKey);
            MemoryState.hmeGraphIndexByScope.set(scope, runtimeGraph);
            MemoryState.hmeGraphIndexByScope.set(`hash:${runtimeGraph.scopeHash || getHybridScopeHash(scope)}`, runtimeGraph);
            while (MemoryState.hmeGraphIndexByScope.size > 48) MemoryState.hmeGraphIndexByScope.delete(MemoryState.hmeGraphIndexByScope.keys().next().value);
        };
        const getCachedHmeGraphIndex = (scopeKey = '') => {
            const scope = getHybridScopeKey(scopeKey);
            const graph = MemoryState.hmeGraphIndexByScope.get(scope)
                || MemoryState.hmeGraphIndexByScope.get(`hash:${getHybridScopeHash(scope)}`)
                || null;
            return graph?.schema === HME_GRAPH_INDEX_SCHEMA && Number(graph.version || 0) === HME_GRAPH_INDEX_VERSION ? graph : null;
        };
        // Separate seam for strict typed derived storage. Legacy HME/cache policy stays intact.
        // Expected-key rows need awaited single-key replacement, not a mutable-head CAS.
        // A read may be served by host cache; it is never an independent durability proof.
        const recallDerivedStorageRuntimeDomains = new WeakMap();
        const getRecallDerivedStorageAdapter = async () => {
            const wrap = async (store, kind) => {
                if (!store) return null;
                const get = typeof store.getItem === 'function' ? store.getItem.bind(store) : typeof store.get === 'function' ? store.get.bind(store) : null;
                const set = typeof store.setItem === 'function' ? store.setItem.bind(store) : typeof store.set === 'function' ? store.set.bind(store) : null;
                if (!get) return null;
                if (!recallDerivedStorageRuntimeDomains.has(store)) recallDerivedStorageRuntimeDomains.set(store, Object.freeze({}));
                return Object.freeze({ kind, get, set, runtimeDomain: recallDerivedStorageRuntimeDomains.get(store),
                    // PocketRisu SafeLocalPluginStorage awaits persistentKv. Its legacy
                    // pluginStorage setter only changes pluginCustomStorage in DB memory.
                    setAcknowledgement: kind === 'localPluginStorage' ? 'awaited_local_storage_api' : 'runtime_api_completion',
                    readVerification: 'cache_or_persistent', independentDurabilityRead: false });
            };
            try {
                const local = await wrap(await RisuCompat.localPluginStorage.getStore(), 'localPluginStorage');
                if (local) return local;
            } catch (_) {}
            try { return await wrap(RisuCompat.api()?.pluginStorage, 'pluginStorage'); } catch (_) { return null; }
        };
        const HME_DERIVED_STORAGE_CONTRACT = Object.freeze({ writeClass: 'cache-derived', canonical: false, rebuildable: true, searchTimeWrite: 'allowed-cold-build' });
        const classifyHmeDerivedStorageKey = key => String(key || '').startsWith('libra:v1:hme-derived:') ? HME_DERIVED_STORAGE_CONTRACT : null;
        const HmeDerivedCacheStore = (() => {
            const loaded = new Set();
            const pending = new Map();
            const keyFor = (kind = 'scope', scopeKey = '') => `libra:v1:hme-derived:${getHybridScopeHash(scopeKey)}:${kind}`;
            const adapter = async () => {
                try {
                    const store = await RisuCompat?.localPluginStorage?.getStore?.();
                    if (store) return {
                        get: key => typeof store.getItem === 'function' ? store.getItem(key) : (typeof store.get === 'function' ? store.get(key) : store[key]),
                        set: (key, value) => typeof store.setItem === 'function' ? store.setItem(key, value) : (typeof store.set === 'function' ? store.set(key, value) : (store[key] = value))
                    };
                } catch (_) {}
                if (RisuCompat?.pluginStorage?.getItem && RisuCompat?.pluginStorage?.setItem) return {
                    get: key => RisuCompat.pluginStorage.getItem(key),
                    set: (key, value) => RisuCompat.pluginStorage.setItem(key, value)
                };
                return null;
            };
            const scheduleWrite = (kind = 'scope', scopeKey = '', value = null, options = {}) => {
                if (!value) return;
                const key = keyFor(kind, scopeKey);
                const previous = pending.get(key) || Promise.resolve();
                const next = previous.catch(() => {}).then(async () => {
                    if (options.guard && !options.guard()) return false;
                    const storage = await adapter();
                    if (!storage) return false;
                    if (options.guard && !options.guard()) return false;
                      if (await storage.set(key, JSON.stringify(value)) === false) return false;
                    if (options.guard && !options.guard()) return false;
                    return true;
                }).catch(error => {
                    if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA][HMECache] derived cache write failed:', error?.message || error);
                    return false;
                }).finally(() => {
                    if (pending.get(key) === next) pending.delete(key);
                });
              pending.set(key, next);
              return next;
            };
            const hydrate = async (scopeKey = '') => {
                const scope = getHybridScopeKey(scopeKey);
                const hash = getHybridScopeHash(scope);
                if (loaded.has(hash)) return { ok: true, cached: true };
                loaded.add(hash);
                const storage = await adapter();
                if (!storage) return { ok: false, reason: 'storage_unavailable' };
                const parse = async (kind) => {
                    try {
                        const raw = await storage.get(keyFor(kind, scope));
                        return raw && typeof raw === 'object' ? raw : JSON.parse(String(raw || 'null'));
                    } catch (_) { return null; }
                };
                const [scopeIndex, graph] = await Promise.all([parse('scope'), parse('graph')]);
                const scopeAccepted = scopeIndex?.schema === HME_SCOPE_INDEX_SCHEMA
                    && Number(scopeIndex.version || 0) === HME_SCOPE_INDEX_VERSION && Array.isArray(scopeIndex.rows);
                const graphAccepted = graph?.schema === HME_GRAPH_INDEX_SCHEMA
                    && Number(graph.version || 0) === HME_GRAPH_INDEX_VERSION && Array.isArray(graph.nodes) && Array.isArray(graph.edges);
                if (scopeIndex?.schema === HME_SCOPE_INDEX_SCHEMA) {
                    cacheHybridScopeIndex(scopeIndex, scope);
                    if (scopeAccepted) hydrateHashIndexFromHybridScopeIndex(scopeIndex);
                }
                if (graphAccepted) cacheHmeGraphIndex(graph, scope);
                return { ok: Boolean(scopeAccepted || graphAccepted), scopeIndex: Boolean(scopeAccepted), graph: Boolean(graphAccepted) };
            };
            const read = async (kind, scopeKey) => {
                try { const storage = await adapter(); return storage ? await storage.get(keyFor(kind, scopeKey)) : null; }
                catch (_) { return null; }
            };
            return Object.freeze({ scheduleWrite, hydrate, keyFor, read });
        })();
        const hmeGraphNeedsSemanticV2Rebuild = (graph = null) => !graph
            || String(graph.schema || '') !== HME_GRAPH_INDEX_SCHEMA
            || Number(graph.version || 0) < HME_GRAPH_INDEX_VERSION
            || !graph.byLayer
            || !graph.byRelation
            || !graph.stats?.layerCounts;
        const ensureHmeGraphIndex = (lorebook = [], options = {}) => {
            if (!isHmeGraphEnabled()) return { ok: false, reason: 'disabled' };
            if (!Array.isArray(lorebook)) return { ok: false, reason: 'invalid_lore' };
            const scopeKey = getHybridScopeKey(options.scopeKey);
            const entries = LibraLoreConsolidator.unpack(lorebook);
            const hmeIndex = options.scopeIndex || findHybridScopeIndexInLore(entries, scopeKey) || getCachedHybridScopeIndex(scopeKey);
            if (!hmeIndex) return { ok: false, reason: 'missing_hme_index' };
            const existing = options.force ? null : (findHmeGraphIndexInLore(entries, scopeKey) || getCachedHmeGraphIndex(scopeKey));
            // ★ freshness 판정에 **엔티티·로어 digest 도 포함**한다 (실측 결함 #6).
            //   종전에는 기억 row digest 만 봤기 때문에 인물이 개명·병합·삭제되거나 로어가 바뀌어도
            //   "변경 없음"으로 판정돼 E1/E2 엣지가 stale 로 남았다.
            //   재구축이 필요하면 `existing` 을 버리고 아래 빌드 경로로 흘려보낸다.
            const crossTypeFresh = (() => {
                if (!existing) return true;
                const inputEntries = hmeGraphInputEntries(Array.isArray(options.lorebook) ? options.lorebook : (Array.isArray(options.entries) ? options.entries : lorebook));
                const source = existing?.source;
                // 빈 문자열은 해당 종류의 원문이 없다는 유효한 검증값이다.
                // 누락·잘못된 형식의 구버전 검증값만 한 번 재구축해 채운다.
                if (!source || !['entityDigest', 'loreDigest', 'relationDigest'].every(key =>
                    Object.prototype.hasOwnProperty.call(source, key) && typeof source[key] === 'string')) return false;
                const cachedEntity = source.entityDigest;
                const cachedLore = source.loreDigest;
                const cachedRelation = source.relationDigest;
                // ★ relation 도 비교한다 — 없으면 relation 만 바뀐 경우 E3 edge 가 stale 로 남는다(P1).
                return cachedEntity === hmeGraphInputDigest(inputEntries, 'entity')
                    && cachedLore === hmeGraphInputDigest(inputEntries, 'lore')
                    && cachedRelation === hmeGraphInputDigest(inputEntries, 'relation');            })();
            const reusableExisting = crossTypeFresh ? existing : null;
            if (reusableExisting && String(reusableExisting?.source?.hmeScopeIndexDigest || '') === String(hmeIndex.digest || '')) {
                const runtimeExisting = ensureHmeGraphRuntimeShape(reusableExisting);
                const staleAnalysis = analyzeHmeGraphStaleEdges(runtimeExisting);
                if (hmeGraphNeedsSemanticV2Rebuild(runtimeExisting)) {
                    const rebuilt = buildHmeGraphIndexFromScopeIndex(hmeIndex, { scopeKey, lorebook });
                    if (rebuilt) {
                        rebuilt.source = {
                            ...(rebuilt.source || {}),
                            rebuildReason: 'semantic_graph_v2_schema',
                            previousSchema: String(runtimeExisting?.schema || ''),
                            previousVersion: Number(runtimeExisting?.version || 0) || 0,
                            previousEdgeCount: hmeGraphEdges(runtimeExisting).length
                        };
                        upsertHmeGraphIndexEntry(entries, rebuilt);
                        lorebook.length = 0;
                        lorebook.push(...entries);
                        cacheHmeGraphIndex(rebuilt, scopeKey);
                        return { ok: true, graph: rebuilt, changed: true, mode: 'rebuilt_for_semantic_graph_v2', staleEdgeAnalysis: staleAnalysis };
                    }
                }
                if (shouldRebuildHmeGraphForStaleEdges(staleAnalysis, scopeKey)) {
                    const rebuilt = buildHmeGraphIndexFromScopeIndex(hmeIndex, { scopeKey, lorebook });
                    if (rebuilt) {
                        const ratio = Number(staleAnalysis.staleRatio.toFixed(4));
                        rebuilt.source = {
                            ...(rebuilt.source || {}),
                            rebuildReason: 'stale_edge_ratio',
                            previousUpdatedAt: Number(runtimeExisting?.updatedAt || 0) || 0,
                            previousEdgeCount: staleAnalysis.total,
                            previousStaleEdgeCount: staleAnalysis.staleCount,
                            previousStaleEdgeRatio: ratio
                        };
                        rebuilt.stats = {
                            ...(rebuilt.stats || {}),
                            staleEdgeCount: 0,
                            rebuiltFromStaleEdgeCount: staleAnalysis.staleCount,
                            rebuiltFromStaleEdgeRatio: ratio
                        };
                        upsertHmeGraphIndexEntry(entries, rebuilt);
                        lorebook.length = 0;
                        lorebook.push(...entries);
                        cacheHmeGraphIndex(rebuilt, scopeKey);
                        markHmeGraphStaleRebuild(scopeKey, staleAnalysis);
                        if (CONFIG.debug) recordRuntimeDebug('log', '[LIBRA][HMEGraph] rebuilt stale graph edges', { scopeHash: getHybridScopeHash(scopeKey), staleEdgeCount: staleAnalysis.staleCount, staleEdgeRatio: ratio });
                        return { ok: true, graph: rebuilt, changed: true, mode: 'rebuilt_for_stale_edges', staleEdgeAnalysis: staleAnalysis };
                    }
                }
                if (HME_GRAPH_STALE_EDGE_POLICY.enabled && HME_GRAPH_STALE_EDGE_POLICY.pruneEnabled && staleAnalysis.staleCount > 0) {
                    const pruned = pruneStaleHmeGraphEdges(runtimeExisting, staleAnalysis);
                    if (pruned.changed && pruned.graph) {
                        upsertHmeGraphIndexEntry(entries, pruned.graph);
                        lorebook.length = 0;
                        lorebook.push(...entries);
                        cacheHmeGraphIndex(pruned.graph, scopeKey);
                        if (CONFIG.debug) recordRuntimeDebug('log', '[LIBRA][HMEGraph] pruned stale graph edges', { scopeHash: getHybridScopeHash(scopeKey), staleEdgeCount: staleAnalysis.staleCount, staleEdgeRatio: Number(staleAnalysis.staleRatio.toFixed(4)) });
                        return { ok: true, graph: pruned.graph, changed: true, mode: 'pruned_stale_edges', staleEdgeAnalysis: staleAnalysis };
                    }
                }
                cacheHmeGraphIndex(runtimeExisting || existing, scopeKey);
                return { ok: true, graph: runtimeExisting || existing, changed: false, mode: 'reused', staleEdgeAnalysis: staleAnalysis };
            }
            const graph = buildHmeGraphIndexFromScopeIndex(hmeIndex, { scopeKey, lorebook });
            if (!graph) return { ok: false, reason: 'graph_build_failed' };
            upsertHmeGraphIndexEntry(entries, graph);
            lorebook.length = 0;
            lorebook.push(...entries);
            cacheHmeGraphIndex(graph, scopeKey);
            return { ok: true, graph, changed: true, mode: 'rebuilt_from_hme_scope_index' };
        };
        const incrementallyPatchHmeGraphIndexRows = (lorebook = [], scopeIndex = null, changedRowIds = [], options = {}) => {
            if (!isHmeGraphEnabled()) return { ok: false, reason: 'disabled' };
            if (!Array.isArray(lorebook) || !scopeIndex || scopeIndex.schema !== HME_SCOPE_INDEX_SCHEMA) {
                return { ok: false, reason: 'invalid_input' };
            }
            const scopeKey = getHybridScopeKey(options.scopeKey || scopeIndex.scopeKey);
            const changedIds = Array.from(new Set((Array.isArray(changedRowIds) ? changedRowIds : [changedRowIds])
                .map(value => String(value || '').trim())
                .filter(Boolean)));
            if (!changedIds.length) return ensureHmeGraphIndex(lorebook, { scopeKey, scopeIndex, force: false });

            const entries = LibraLoreConsolidator.unpack(lorebook);
            const existing = findHmeGraphIndexInLore(entries, scopeKey) || getCachedHmeGraphIndex(scopeKey);
            const runtimeExisting = ensureHmeGraphRuntimeShape(existing);
            if (!runtimeExisting || hmeGraphNeedsSemanticV2Rebuild(runtimeExisting)) {
                return ensureHmeGraphIndex(lorebook, { scopeKey, scopeIndex, force: true });
            }

            const inputEntries = hmeGraphInputEntries(lorebook);
            if (runtimeExisting.source?.entityDigest !== hmeGraphInputDigest(inputEntries, 'entity')
                || runtimeExisting.source?.loreDigest !== hmeGraphInputDigest(inputEntries, 'lore')
                || runtimeExisting.source?.relationDigest !== hmeGraphInputDigest(inputEntries, 'relation')) {
                return ensureHmeGraphIndex(lorebook, { scopeKey, scopeIndex, force: true });
            }
            const rowById = new Map(hmeIndexRows(scopeIndex)
                .map(row => [String(row?.id || '').trim(), row])
                .filter(([id]) => !!id));
            const changedRowSet = new Set(changedIds);
            const previousNodeIds = new Set();
            const retainedNodes = hmeGraphNodes(runtimeExisting).filter(node => {
                const rowId = String(node?.rowId || '').trim();
                if (!changedRowSet.has(rowId)) return true;
                if (node?.id) previousNodeIds.add(String(node.id));
                return false;
            });
            const changedNodes = changedIds
                .map(id => rowById.get(id))
                .map(buildHmeGraphNodeFromRow)
                .filter(Boolean);
            const changedNodeIdSet = new Set(changedNodes.map(node => String(node.id || '')).filter(Boolean));
            previousNodeIds.forEach(id => changedNodeIdSet.add(id));

            const preset = getHmeGraphPreset();
            let nodes = compactHmeGraphNodes([...retainedNodes, ...changedNodes], preset);
            const retainedNodeIds = new Set(nodes.map(node => String(node?.id || '')).filter(Boolean));
            const nodeById = new Map(nodes.map(node => [String(node?.id || ''), node]).filter(([id]) => !!id));
            const buckets = buildHmeGraphBuckets(nodes);
            const entityDf = buildHmeGraphEntityDocumentFrequency(nodes);

            const maxEdges = Math.max(128, Number(preset.maxEdges || 1024) || 1024);
            const structuralRelations = new Set(['mentions_entity', 'described_by_lore', 'relation_record', 'shares_lore_ref']);
            const structuralEdges = buildHmeGraphCrossTypeEdges(nodes, {
                relations: buildHmeGraphRelationMap(entries), entityDf, maxEdges
            });
            const structuralPairs = new Set(structuralEdges.map(edge => [edge.from, edge.to].sort().join('::')));
            const untouchedEdges = hmeGraphEdges(runtimeExisting).filter(edge => {
                const from = String(edge?.from || '');
                const to = String(edge?.to || '');
                if (!retainedNodeIds.has(from) || !retainedNodeIds.has(to)) return false;
                if (structuralRelations.has(edge.relation) || structuralPairs.has([from, to].sort().join('::'))) return false;
                if (Number(edge.fromVersion || 1) !== Number(nodeById.get(from).version || 1)
                    || Number(edge.toVersion || 1) !== Number(nodeById.get(to).version || 1)) return false;
                return !changedNodeIdSet.has(from) && !changedNodeIdSet.has(to);
            });
            const seen = new Set([...structuralPairs, ...untouchedEdges.map(edge => [String(edge?.from || ''), String(edge?.to || '')].sort().join('::'))]);
            const patchedEdges = [];
            for (const node of changedNodes) {
                if (!node?.id || !nodeById.has(String(node.id)) || !graphCanUseNode(node)) continue;
                const localEdges = [];
                for (const otherId of collectHmeGraphNeighbors(node, buckets)) {
                    const other = nodeById.get(String(otherId || ''));
                    if (!other || !graphCanUseNode(other) || String(other.id) === String(node.id)) continue;
                    const pair = [String(node.id), String(other.id)].sort().join('::');
                    if (seen.has(pair)) continue;
                    const signal = hmeGraphEdgeSignal(node, other, { entityDf });
                    const edgeWeightMin = signal.layer === 'signal'
                        ? Math.min(Number(preset.edgeWeightMin || 0), HME_GRAPH_SIGNAL_THRESHOLD * 0.72)
                        : Number(preset.edgeWeightMin || 0);
                    if (signal.weight < edgeWeightMin) continue;
                    localEdges.push({ other, pair, signal });
                }
                localEdges
                    .sort((a, b) => Number(b.signal.weight || 0) - Number(a.signal.weight || 0))
                    .slice(0, HME_GRAPH_EDGE_LIMIT_PER_NODE)
                    .forEach(({ other, pair, signal }) => {
                        seen.add(pair);
                        patchedEdges.push({
                            id: `g_edge_${stableHash(pair)}`,
                            from: String(node.id),
                            to: String(other.id),
                            fromVersion: Number(node.version || 1),
                            toVersion: Number(other.version || 1),
                            layer: signal.layer || 'signal',
                            relation: signal.relation,
                            weight: Number(signal.weight.toFixed(4)),
                            confidence: Number(Math.min(1, signal.confidence || signal.weight + 0.08).toFixed(4)),
                            evidence: signal.evidence,
                            penalties: signal.penalties || [],
                            explanation: signal.explanation || '',
                            usedForRecall: false,
                            score: Number((signal.score || signal.weight || 0).toFixed(4)),
                            components: signal.components || {},
                            boundaryClass: 'public',
                            updatedAt: Date.now()
                        });
                    });
            }
            const edges = [...structuralEdges, ...[...untouchedEdges, ...patchedEdges]
                .sort((a, b) => Number(b.weight || b.score || 0) - Number(a.weight || a.score || 0))
                .slice(0, Math.max(0, maxEdges - structuralEdges.length))];
            const now = Date.now();
            const graph = rebuildHmeGraphRuntimeShape({
                ...runtimeExisting,
                schema: HME_GRAPH_INDEX_SCHEMA,
                version: HME_GRAPH_INDEX_VERSION,
                source: {
                    ...(runtimeExisting.source || {}),
                    derivedFrom: HME_SCOPE_INDEX_COMMENT,
                    hmeScopeIndexDigest: String(scopeIndex.digest || ''),
                    hmeScopeIndexSchema: HME_SCOPE_INDEX_SCHEMA,
                    // ★ 증분 패치는 **엔티티·로어 입력이 변하지 않았다** — 그래프 노드에서 다시
                    //   계산하면 안 된다. `hmeGraphInputDigest` 는 `entry.comment`
                    //   (`lmai_entity`/`lmai_character_lore_cues`)를 찾는데 그래프 노드에는 그 필드가 없다
                    //   → digest 가 **빈 문자열**이 되고, 다음 ensure 에서 불일치로 판정돼
                    //   **매번 full rebuild** 하는 churn 이 생긴다(실측 P2).
                    //   기존 값을 그대로 보존한다.
                    entityDigest: String(runtimeExisting?.source?.entityDigest || ''),
                    loreDigest: String(runtimeExisting?.source?.loreDigest || ''),
                    relationDigest: String(runtimeExisting?.source?.relationDigest || ''),
                    incrementallyPatchedAt: now,
                    incrementallyPatchedRows: changedIds.slice(0, 32)
                },
                scopeKey,
                scopeHash: getHybridScopeHash(scopeKey),
                updatedAt: now,
                nodes,
                edges,
                policy: {
                    ...(runtimeExisting.policy || {}),
                    rawRetention: 'signals_only',
                    authority: 'retrieval_hint_only',
                    defaultInjection: 'merge_existing_sections',
                    maxSeeds: preset.maxSeeds,
                    maxCandidates: preset.maxCandidates,
                    maxNodes: preset.maxNodes,
                    maxEdges: preset.maxEdges,
                    maxHops: preset.maxHops,
                    bonusCap: preset.bonusCap
                }
            });
            if (!graph) return ensureHmeGraphIndex(lorebook, { scopeKey, scopeIndex, force: true });
            upsertHmeGraphIndexEntry(entries, graph);
            lorebook.length = 0;
            lorebook.push(...entries);
            cacheHmeGraphIndex(graph, scopeKey);
            return {
                ok: true,
                graph,
                changed: true,
                mode: 'incremental_row_patch',
                patchedRows: changedIds.length,
                patchedEdges: patchedEdges.length,
                retainedEdges: untouchedEdges.length
            };
        };
        const hydrateHmeGraphIndexFromLore = (lorebook = [], options = {}) => {
            if (!isHmeGraphEnabled()) return false;
            const graph = findHmeGraphIndexInLore(lorebook, getHybridScopeKey(options.scopeKey));
            if (!graph || graph.schema !== HME_GRAPH_INDEX_SCHEMA || Number(graph.version || 0) !== HME_GRAPH_INDEX_VERSION) return false;
            cacheHmeGraphIndex(graph, options.scopeKey);
            return true;
        };
        const getHmeGraphEntryBoost = (entry = null, graphContext = null) => {
            const key = String(getSafeKey(entry) || '').trim();
            return key ? graphContext?.boostByKey?.get?.(key) || null : null;
        };
        const expandHmeGraphRecallCandidates = (filteredEntries = [], allEntriesByKey = new Map(), options = {}) => {
            const preset = getHmeGraphPreset();
            if (!preset.enabled || preset.maxCandidates <= 0 || preset.maxSeeds <= 0) return { ok: false, reason: 'disabled' };
            const scopeKey = getHybridScopeKey(options.scopeKey || MemoryState._activeScopeKey || MemoryState._activeChatId || '');
            if (!options.graph && staleHybridScopeIndexScopes.has(scopeKey) && !getCachedHybridScopeIndex(scopeKey)) {
                // Bounded pools bypass scope preselection but can still require the graph.
                // The original map contains only entries already accepted by recall protection.
                rebuildHybridScopeIndexForRecall(Array.from(allEntriesByKey.values()), { ...options, scopeKey });
            }
            let graph = options.graph || getCachedHmeGraphIndex(scopeKey);
            if (options.graph && options.graph.scopeKey !== scopeKey) return { ok: false, reason: 'graph_scope_mismatch' };
            if (!graph) {
                const scopeIndex = getCachedHybridScopeIndex(scopeKey);
                if (scopeIndex) {
                    graph = buildHmeGraphIndexFromScopeIndex(scopeIndex, { scopeKey, lorebook: options.lorebook || options.entries || [] });
                    cacheHmeGraphIndex(graph, scopeKey);
                }
            } else if (!options.graph) {
                const scopeIndex = getCachedHybridScopeIndex(scopeKey);
                const digestMismatch = scopeIndex && String(graph?.source?.hmeScopeIndexDigest || '') !== String(scopeIndex.digest || '');
                if (scopeIndex && (digestMismatch || hmeGraphNeedsSemanticV2Rebuild(graph))) {
                    const rebuilt = buildHmeGraphIndexFromScopeIndex(scopeIndex, { scopeKey, lorebook: options.lorebook || options.entries || [] });
                    if (rebuilt) {
                        rebuilt.source = {
                            ...(rebuilt.source || {}),
                            rebuildReason: digestMismatch ? 'scope_index_digest_runtime_recall' : 'semantic_graph_v2_runtime_recall',
                            previousSchema: String(graph?.schema || ''),
                            previousVersion: Number(graph?.version || 0) || 0,
                            previousScopeIndexDigest: String(graph?.source?.hmeScopeIndexDigest || '')
                        };
                        cacheHmeGraphIndex(rebuilt, scopeKey);
                        graph = rebuilt;
                    }
                }
            }
            graph = ensureHmeGraphRuntimeShape(graph);
            if (!graph) return { ok: false, reason: 'missing_graph' };
            const nodesById = new Map(hmeGraphNodes(graph).map(node => [node.id, node]));
            const edgesById = new Map(hmeGraphEdges(graph).map(edge => [edge.id, edge]));
            const seedKeys = uniqLimit((filteredEntries || []).map(entry => String(getSafeKey(entry) || '').trim()).filter(Boolean), Math.max(1, preset.maxSeeds));
            const existingKeys = new Set((filteredEntries || []).map(entry => String(getSafeKey(entry) || '').trim()).filter(Boolean));
            const directFocusNames = normalizeHmeEntityNameList(options.directFocusNames || options.focusNames || [], 24);
            const relatedFocusNames = normalizeHmeEntityNameList(options.relatedFocusNames || [], 32);
            const narrativeArcKeys = normalizeHmeGraphSpecificList(options.narrativeArcKeys || [], 12);
            const seedItemsByNodeId = new Map();
            const addSeed = (node = null, score = 0.5, reason = '', chain = []) => {
                if (!graphCanUseNode(node)) return;
                const prev = seedItemsByNodeId.get(node.id);
                const nextScore = Math.max(Number(prev?.score || 0), Number(score || 0));
                seedItemsByNodeId.set(node.id, {
                    node,
                    score: nextScore,
                    reason: reason || prev?.reason || 'seed',
                    chain: chain.length ? chain : (prev?.chain || [`seed:${node.rowId}`]),
                    focusSeed: Boolean(prev?.focusSeed || /^focus:/.test(reason || ''))
                });
            };
            seedKeys.forEach(rowId => addSeed(nodesById.get(graph.byRowId?.[rowId] || ''), 0.62, 'seed:filtered', [`seed:${rowId}`]));
            const addEntitySeeds = (names = [], score = 0.5, reasonPrefix = 'focus') => {
                for (const name of normalizeHmeEntityNameList(names, 48)) {
                    const normalized = normalizeHmeGraphToken(name);
                    const list = graph.byEntity?.[normalized];
                    if (!Array.isArray(list)) continue;
                    list
                        .map(nodeId => nodesById.get(nodeId))
                        .filter(graphCanUseNode)
                        .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || Number(b.turn || 0) - Number(a.turn || 0))
                        .slice(0, 8)
                        .forEach(node => {
                            const recencyBoost = Math.min(0.16, Math.max(0, Number(node.turn || 0)) * 0.004);
                            addSeed(node, score + (Number(node.importance || 0) * 0.18) + recencyBoost, `${reasonPrefix}:${name}`, [`focus:${name}`, `seed:${node.rowId}`]);
                        });
                }
            };
            const addArcSeeds = (arcKeys = [], score = 0.48) => {
                for (const arcKey of arcKeys) {
                    const normalized = normalizeHmeGraphToken(arcKey);
                    const list = graph.byArc?.[normalized];
                    if (!Array.isArray(list)) continue;
                    list
                        .map(nodeId => nodesById.get(nodeId))
                        .filter(graphCanUseNode)
                        .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || Number(b.turn || 0) - Number(a.turn || 0))
                        .slice(0, 6)
                        .forEach(node => addSeed(node, score + (Number(node.importance || 0) * 0.14), `focus:arc:${arcKey}`, [`arc:${arcKey}`, `seed:${node.rowId}`]));
                }
            };
            addEntitySeeds(directFocusNames, 0.74, 'focus:direct-entity');
            addEntitySeeds(relatedFocusNames, 0.50, 'focus:related-entity');
            addArcSeeds(narrativeArcKeys, 0.48);
            const seedItems = Array.from(seedItemsByNodeId.values())
                .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.node?.turn || 0) - Number(a.node?.turn || 0))
                .slice(0, preset.maxSeeds);
            const seeds = seedItems.map(item => item.node).filter(graphCanUseNode);
            if (!seeds.length) return { ok: false, reason: 'empty_seeds' };
            const candidatesByKey = new Map();
            const traces = [];
            const hubTraces = [];
            let frontierPeakAll = 0;
            const push = (node, score, reason, chain = [], edgeMeta = null) => {
                if (!graphCanUseNode(node)) return;
                const rowId = String(node.rowId || '').trim();
                if (!rowId || !allEntriesByKey.has(rowId)) return;
                const boost = Math.min(preset.bonusCap, Math.max(0, Number(score || 0)));
                if (boost <= 0) return;
                const prev = candidatesByKey.get(rowId);
                candidatesByKey.set(rowId, {
                    rowId,
                    nodeId: node.id,
                    boost: Math.max(prev?.boost || 0, boost),
                    graphOnly: !existingKeys.has(rowId),
                    reasons: uniqLimit([...(prev?.reasons || []), reason].filter(Boolean), 8),
                    edgeChain: chain.length ? chain : (prev?.edgeChain || []),
                    edgeLayer: edgeMeta?.layer || prev?.edgeLayer || '',
                    relation: edgeMeta?.relation || prev?.relation || '',
                    confidence: Math.max(Number(prev?.confidence || 0), Number(edgeMeta?.confidence || 0)),
                    graphReason: edgeMeta?.explanation || prev?.graphReason || ''
                });
                if (traces.length < 12) traces.push({
                    rowId,
                    nodeId: node.id,
                    boost: Number(boost.toFixed(4)),
                    reason,
                    edgeChain: chain,
                    viaGraph: true,
                    usedForRecall: true,
                    edgeLayer: edgeMeta?.layer || '',
                    relation: edgeMeta?.relation || '',
                    confidence: Number(Number(edgeMeta?.confidence || 0).toFixed(4)),
                    penalties: edgeMeta?.penalties || [],
                    explanation: edgeMeta?.explanation || ''
                });
                // 허브 경유 경로는 **상한과 별개로** 담는다.
                //   traces 는 12개 상한이라 hop1 의 signal 엣지가 먼저 채우면
                //   정작 중요한 "인물을 거쳐 온 기억"(2홉)이 진단에서 밀려 안 보인다.
                //   그러면 "허브가 안 쓰인다"로 오진한다 — 실측에서 실제로 그렇게 오진했다.
                if (hubTraces.length < 8
                    && (chain || []).some(segment => String(segment).includes('mentions_entity'))) {
                    hubTraces.push({
                        rowId, nodeId: node.id, boost: Number(boost.toFixed(4)),
                        reason, edgeChain: chain, viaGraph: true,
                        edgeLayer: edgeMeta?.layer || '', relation: edgeMeta?.relation || ''
                    });
                }
            };
            for (const seedItem of seedItems) {
                const seed = seedItem.node;
                if (seedItem.focusSeed) {
                    push(seed, Math.min(preset.bonusCap, Math.max(0.06, Number(seedItem.score || 0) * 0.18)), seedItem.reason || 'focus:seed', seedItem.chain || [`seed:${seed.rowId}`], {
                        layer: 'focus',
                        relation: 'focus_entity_seed',
                        confidence: Math.min(1, Math.max(0.35, Number(seedItem.score || 0))),
                        penalties: [],
                        explanation: 'focus-seeded graph recall'
                    });
                }
                const frontier = [{ node: seed, score: Math.max(0.25, Number(seedItem.score || seed.importance || 0.5)), hop: 0, chain: seedItem.chain || [`seed:${seed.rowId}`] }];
                const visited = new Set([seed.id]);
                // frontier 크기 계측 (진단) — 위그로어 frontierCap(128×모드) 이 필요한지 판단하는 근거.
                //   LIBRA 는 시드별 BFS 라 출발 크기가 1 이다. 위그로어는 전체 활성 unit 에서 시작한다.
                let frontierPeak = 0;
                while (frontier.length) {
                    if (frontier.length > frontierPeak) frontierPeak = frontier.length;
                    const item = frontier.shift();
                    if (!item || item.hop >= Math.max(1, preset.maxHops)) continue;
                    const adjacentEdges = (graph.adjacentByNode?.[item.node.id] || [])
                        .map(edgeId => edgesById.get(edgeId))
                        .filter(Boolean)
                        .sort((a, b) => {
                            // 허브 엣지(인물 노드로 가는 것)를 **먼저** 처리한다.
                            //
                            // 왜: hop1 에서 shared_entity/turn_proximity 같은 기억-기억 직접 엣지가
                            //   이웃 9~14개를 먼저 채운다. 그 뒤 인물 노드가 오면 `hop < maxHops`
                            //   를 만족해도 frontier 가 이미 포화돼 허브 경유가 밀린다.
                            //   실측: m_30 의 hop1 이웃은 shared_topic 4 + shared_entity 9 +
                            //   mentions_entity 1 인데, trace 에 mentions_entity 가 하나도 없었다.
                            //   허브는 "여러 기억을 잇는 유일한 경로" 라 우선순위가 높아야 한다.
                            const hubReach = (edge) => {
                                const otherId = edge.from === item.node.id ? edge.to : edge.from;
                                const other = nodesById.get(otherId);
                                return String(other?.nodeType || '') === 'entity' ? 1 : 0;
                            };
                            const hubDelta = hubReach(b) - hubReach(a);
                            if (hubDelta) return hubDelta;
                            const layerDelta = (a.layer === 'meaning' ? 1 : 0) - (b.layer === 'meaning' ? 1 : 0);
                            if (layerDelta) return -layerDelta;
                            return Number(b.weight || 0) - Number(a.weight || 0);
                        });
                    for (const edge of adjacentEdges) {
                        if (!isHmeGraphEdgeFresh(edge, graph)) continue;
                        const nextId = edge.from === item.node.id ? edge.to : edge.from;
                        const nextNode = nodesById.get(nextId);
                        if (!nextNode || !graphCanUseNode(nextNode)) continue;
                        const hop = item.hop + 1;
                        const layer = String(edge.layer || 'signal');
                        const isHubNode = String(nextNode?.nodeType || '') === 'entity';
                        // 허브 노드(entity)는 visited 로 *소진하지 않는다*.
                        //
                        // 왜: hop1 에서 기억-기억 직접 엣지(shared_entity 등 signal)가 이웃 9~14개를
                        //   먼저 visited 로 채운다. 그러면 인물 노드가 뒤로 밀려 방문조차 못 하거나,
                        //   방문해도 허브 경유가 죽는다.
                        //   실측: 그래프에 mentions_entity 30개가 있는데도 trace 는 shared_entity 뿐이었다.
                        //
                        //   허브는 여러 기억이 공유하는 노드라 "한 번만" 규칙이 오히려 손해다 —
                        //   매 시드마다 허브를 통과해야 그 시드와 연결된 *다른* 기억이 드러난다.
                        //   비용은 maxHops·maxCandidates·maxSeeds·EDGE_LIMIT_PER_NODE 가 이미 막는다.
                        if (visited.has(nextNode.id)) continue;
                        if (!isHubNode) visited.add(nextNode.id);
                        const spreadFactor = layer === 'meaning'
                            ? (hop === 1 ? 0.52 : 0.34)
                            : (hop === 1 ? 0.18 : 0.10);
                        const spread = item.score * Number(edge.weight || 0) * spreadFactor;
                        const reason = `graph:${layer}:${edge.relation}:${(edge.evidence || []).slice(0, 3).join(',')}`;
                        const chain = [...item.chain, `${layer}:${edge.relation}:${nextNode.rowId}`].slice(-5);
                        const edgeMeta = {
                            layer,
                            relation: edge.relation || '',
                            confidence: edge.confidence || 0,
                            penalties: edge.penalties || [],
                            explanation: edge.explanation || ''
                        };
                        push(nextNode, spread, reason, chain, edgeMeta);
                        // 허브 경유 전파 (2홉 이상).
                        //
                        // 기존 조건은 `layer === 'meaning'` 만 frontier 에 넣었다. 그런데
                        //   기억-기억 직접 엣지는 대부분 `signal`(shared_entity/turn_proximity)이라
                        //   인물 허브(E1 mentions_entity)로 가는 경로가 실질적으로 쓰이지 못했다.
                        //
                        // 그래서 둘을 나눠 넣는다:
                        //   ① meaning 엣지는 계속 frontier 에 넣는다 (기존 동작 보존)
                        //   ② **허브 노드(entity)** 로 도달했으면 layer 와 무관하게 frontier 에 넣는다.
                        //      허브를 경유해야 "이 인물을 통해 연결된 다른 기억" 이 회상된다 —
                        //      사용자가 요청한 인물↔로어북 파이프라인의 목적 그 자체다.
                        if (hop < preset.maxHops && preset.maxHops > 1 && (layer === 'meaning' || isHubNode)) {
                            frontier.push({ node: nextNode, score: spread, hop, chain });
                        }
                    }
                }
                if (frontierPeak > frontierPeakAll) frontierPeakAll = frontierPeak;
            }
            const graphCandidates = Array.from(candidatesByKey.values()).sort((a, b) => Number(b.boost || 0) - Number(a.boost || 0)).slice(0, preset.maxCandidates);
            const boostByKey = new Map(graphCandidates.map(candidate => [candidate.rowId, candidate]));
            const maxGraphAdditions = Math.max(0, Math.min(Number(preset.maxAdditions || 0) || 0, preset.maxCandidates || 0));
            const graphAdditions = graphCandidates.filter(candidate => candidate.graphOnly).slice(0, maxGraphAdditions);
            const merged = [...filteredEntries];
            for (const candidate of graphAdditions) {
                if (!existingKeys.has(candidate.rowId)) {
                    const entry = allEntriesByKey.get(candidate.rowId);
                    if (entry) {
                        merged.push(entry);
                        existingKeys.add(candidate.rowId);
                    }
                }
            }
            return {
                ok: true,
                entries: merged,
                boostByKey,
                debug: {
                    enabled: true,
                    ok: true,
                    schema: HME_GRAPH_INDEX_SCHEMA,
                    version: HME_GRAPH_INDEX_VERSION,
                    mode: preset.mode,
                    scopeHash: graph.scopeHash || '',
                    nodeCount: graph.stats?.nodeCount || hmeGraphNodes(graph).length,
                    edgeCount: graph.stats?.edgeCount || hmeGraphEdges(graph).length,
                    meaningEdgeCount: Number(graph.stats?.meaningEdgeCount || 0),
                    signalEdgeCount: Number(graph.stats?.signalEdgeCount || 0),
                    staleEdgeCount: Number(graph.stats?.staleEdgeCount || 0),
                    lastStaleEdgeCount: Number(graph.stats?.lastStaleEdgeCount || graph.stats?.rebuiltFromStaleEdgeCount || 0),
                    relationCounts: graph.stats?.relationCounts || {},
                    layerCounts: graph.stats?.layerCounts || {},
                    // 종류별 **보존** 수 (buildHmeGraphStats 가 구축 시 계산한다).
                    //   뷰 API 는 이것보다 적게 담는다(화면 상한) — 구분해서 봐야 오진하지 않는다.
                    nodeTypeCounts: { ...(graph.stats?.nodeTypeCounts || {}) },
                    seedCount: seeds.length,
                    candidateCount: graphCandidates.length,
                    addedCandidates: graphAdditions.length,
                    bonusCap: preset.bonusCap,
                    graphOnlyMaxScore: HME_GRAPH_ONLY_MAX_SCORE,
                    focusSeedCount: seedItems.filter(item => item.focusSeed).length,
                    directFocusNames,
                    relatedFocusNames,
                    narrativeArcKeys,
                    // 시각화/진단용 구조 샘플 (상한 고정 + 디버그 요청 시에만).
                    //   목업·시각화가 *실제 그래프*를 그릴 수 있게 노드 종류·엣지 관계를 노출한다.
                    //   매 회상마다 만들면 비용이 늘므로 `hme_graph_debug=full` 일 때만 담는다.
                    // 종류별로 나눠 담는다 — 앞에서 균일하게 자르면 entity/lore 노드가
                    //   목록 뒤로 밀려 **샘플에 하나도 안 들어온다**(실측: 60개 상한에서 entity 1개).
                    //   시각화가 인물 허브를 그리려면 종류별 보장이 필요하다.
                    nodeSample: hmeGraphSampleRequested() ? hmeGraphSampleNodes(graph) : [],
                    edgeSample: hmeGraphSampleRequested() ? hmeGraphSampleEdges(graph, hmeGraphSampleNodes(graph)) : [],
                    // frontier 최대 크기 — frontierCap(위그로어 128×모드) 이 필요한지 판단하는 근거.
                    //   LIBRA 는 시드별 BFS(출발 1)이고 maxHops 2 라 위그로어(전체 활성에서 출발)와 다르다.
                    frontierPeak: frontierPeakAll,
                    traces,
                    // 허브 경유(2홉) 경로 — traces 상한과 별개로 담는다.
                    hubTraces
                }
            };
        };

        // This source graph is independent of query seeds and visibility decisions.
        // Persisted hints are untrusted: restart verifies both source-derived nodes
        // and deterministic edges before reuse. Warm requests only reconcile source
        // fingerprints; a fresh eligible view gates every traversal endpoint.
        const TypedHmeSourceGraph = (() => {
            const schema = 'libra.hme.typed_source_graph.v1', states = new Map(), pending = new Map(), writeBarriers = new Map();
            let epoch = 0;
            const clear = () => {
                epoch++;
                states.clear();
                pending.clear();
                // An issued host storage call cannot be cancelled. Keep its
                // ordering barrier until it settles, but revoke all RAM commits.
            };
            MemoryState.invalidateTypedHmeSourceGraph = clear;
            const families = ['memory', 'entity', 'world', 'narrative'];
            const list = value => Array.isArray(value) ? value : [];
            const hash = value => SemanticRecallIndex.sourceHash(JSON.stringify(value));
            const stableNode = ({ updatedAt, ...node }) => node;
            const stableEdge = ({ updatedAt, usedForRecall, ...edge }) => edge;
            const graphData = graph => ({ nodes: graph.nodes.map(stableNode), edges: graph.edges.map(stableEdge) });
            const makeNode = (unit, counts, fingerprint) => {
                const record = unit.record || {}, meta = record.meta || {};
                let node;
                // Canonical typed memory must never borrow the active host world's
                // signals. Native world vertices provide its explicit source links.
                if (unit.family === 'memory') node = buildHmeGraphNodeFromRow(buildHybridScopeIndexRow(unit.entry, 0, 0, { canonicalSignals: null }));
                else if (unit.family === 'entity') node = buildHmeGraphEntityNode(record);
                else {
                    const entities = normalizeHmeEntityList([...list(record.entities), ...list(record.entityRefs)], 24);
                    node = buildHmeGraphNodeFromRow({ id: unit.identity, contentHash: unit.persistentContentHash,
                        primaryKind: unit.family, baseBucket: unit.family, subjects: entities,
                        entityRoles: { primary: entities, observer: [], mention: [], inferred: [] },
                        arcKey: record.arcKey || '', turn: Number(record.turn || meta.created || 0),
                        sourceTurnIds: [...list(record.turns), ...list(record.evidenceTurns)].map(Number).filter(n => n > 0),
                        importance: .5, rollbackState: 'active' });
                }
                if (!node) return null;
                const ownRefs = [unit.identity, `${unit.family}:${unit.locator.id}`];
                if (counts.get(unit.entry?.key) === 1) ownRefs.push(unit.entry.key);
                const linkedRefs = list(record.memoryRefs).flatMap(ref => [String(ref), String(ref).startsWith('lmai_memory::') ? String(ref) : `lmai_memory::${ref}`]);
                if (unit.family === 'world' && unit.subtype === 'node' && record.parent) linkedRefs.push(`world:${record.parent}`);
                return { ...node, id: `g_typed_${stableHash(unit.identity + ':' + fingerprint)}`,
                    rowId: unit.identity, nodeType: unit.family, contentHash: unit.persistentContentHash,
                    sourceFingerprint: fingerprint,
                    sourceRefs: [...new Set([...ownRefs, ...linkedRefs, ...(node.sourceRefs || [])])].slice(0, 32) };
            };
            const retainedNodes = (nodes, preset) => {
                const groups = families.map(family => nodes.filter(node => node.nodeType === family).sort(compareHmeGraphNodeRetention));
                const retained = [];
                for (let index = 0; retained.length < preset.maxNodes && groups.some(group => index < group.length); index++)
                    for (const group of groups) if (group[index] && retained.length < preset.maxNodes) retained.push(group[index]);
                return retained;
            };
            const compile = (scopeKey, revision, nodes) => buildHmeGraphIndexFromScopeIndex({
                schema: HME_SCOPE_INDEX_SCHEMA, scopeKey, digest: revision, rows: []
            }, { scopeKey, typedNodes: nodes });
            const payloadFor = (binding, revision, totalNodes, graph) => ({ schema, binding, revision, totalNodes, graph: {
                schema: graph.schema, version: graph.version, scopeKey: graph.scopeKey, nodes: graph.nodes, edges: graph.edges, source: graph.source, policy: graph.policy
            } });
            const persistGraph = async (scopeKey, payload, guard) => {
                const serialized = { ...payload, checksum: hash(payload) };
                if (!guard()) throw new Error('graph_source_invalidated');
                await HmeDerivedCacheStore.scheduleWrite('typed-graph', scopeKey, serialized, { guard });
                if (!guard()) throw new Error('graph_source_invalidated');
                const back = await HmeDerivedCacheStore.read('typed-graph', scopeKey);
                if (!guard()) throw new Error('graph_source_invalidated');
                return typeof back === 'string' && back === JSON.stringify(serialized);
            };
            const maintainNow = async (units, context) => {
                if (context.guard && !context.guard()) throw new Error('graph_source_invalidated');
                const scopeKey = context.scopeKey, preset = getHmeGraphPreset();
                const valid = units.filter(unit => unit?.scopeKey === scopeKey && families.includes(unit.family));
                const counts = new Map();
                for (const unit of valid) counts.set(unit.entry?.key, (counts.get(unit.entry?.key) || 0) + 1);
                // Node builders read the canonical record and locator. Semantic
                // dependency hashes intentionally include POV/worldline views;
                // those request inputs must not rewrite the source graph.
                const sourceRows = valid.map(unit => [unit.identity, hash([unit.persistentContentHash,
                    unit.locator, counts.get(unit.entry?.key)])]);
                if (new Set(sourceRows.map(([id]) => id)).size !== sourceRows.length) throw new Error('graph_identity_collision');
                const binding = { schema, scopeKey, resetGeneration: context.resetGeneration || 0, preset };
                const revision = hash([binding, sourceRows]);
                let state = states.get(scopeKey);
                const report = { mode: 'reused', rebuiltNodes: 0, sourceChanges: 0, removedNodes: 0,
                    persistedReject: '', readbackVerified: false, independentDurabilityRead: false };
                if (state?.revision === revision) {
                    if (!state.readbackVerified) {
                        state.readbackVerified = await persistGraph(scopeKey, payloadFor(binding, revision, state.totalNodes, state.graph), context.guard);
                        report.mode = 'persistence_retried';
                    }
                    return { graph: state.graph, totalNodes: state.totalNodes, report: { ...report, readbackVerified: state.readbackVerified } };
                }
                if (state && hash(state.binding) !== hash(binding)) state = null;
                const sourceById = new Map(sourceRows), unitById = new Map(valid.map(unit => [unit.identity, unit]));
                if (!state) {
                    const raw = await HmeDerivedCacheStore.read('typed-graph', scopeKey);
                    let saved;
                    try { saved = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { report.persistedReject = 'parse'; }
                    if (saved) {
                        const { checksum, ...payload } = saved;
                        if (checksum !== hash(payload)) report.persistedReject = 'checksum';
                        else if (saved.revision !== revision || hash(saved.binding) !== hash(binding)) report.persistedReject = 'source_binding';
                        else if (!Array.isArray(saved.graph?.nodes) || !Array.isArray(saved.graph?.edges)
                            || saved.graph.nodes.length > preset.maxNodes || saved.graph.edges.length > preset.maxEdges
                            || saved.graph.scopeKey !== scopeKey) report.persistedReject = 'shape';
                        else {
                            // The persisted inventory is not an authority. Derive
                            // the complete retained inventory from current source
                            // inputs, including omitted nodes, once at restart.
                            const checked = valid.map(unit => {
                                report.rebuiltNodes++;
                                return makeNode(unit, counts, sourceById.get(unit.identity));
                            }).filter(Boolean);
                            const expectedNodes = retainedNodes(checked, preset);
                            if (saved.totalNodes !== checked.length || hash(expectedNodes.map(stableNode)) !== hash(saved.graph.nodes.map(stableNode))) report.persistedReject = 'source_nodes';
                            else {
                                // Restart is a validation boundary, not a trusted cache
                                // import. Verify the exact deterministic edge set once.
                                const expected = compile(scopeKey, revision, expectedNodes);
                                if (!expected || hash(graphData(expected)) !== hash(graphData(saved.graph))) report.persistedReject = 'source_edges';
                                else {
                                    state = { revision, binding, graph: rebuildHmeGraphRuntimeShape(saved.graph),
                                        nodes: new Map(checked.map(node => [node.rowId, node])), sources: sourceById,
                                        totalNodes: saved.totalNodes, readbackVerified: true };
                                    report.mode = 'restored'; report.readbackVerified = true;
                                }
                            }
                        }
                    }
                    if (report.mode === 'restored') {
                        if (context.guard && !context.guard()) throw new Error('graph_source_invalidated');
                        if (!states.has(scopeKey) && states.size >= 48) states.delete(states.keys().next().value);
                        states.set(scopeKey, state); return { graph: state.graph, totalNodes: state.totalNodes, report };
                    }
                }
                const nodes = new Map(), oldSources = state?.sources || new Map();
                for (const [id, fingerprint] of sourceRows) {
                    const prior = oldSources.get(id) === fingerprint && state?.nodes.get(id);
                    if (prior) nodes.set(id, prior);
                    else { const node = makeNode(unitById.get(id), counts, fingerprint); report.rebuiltNodes++; report.sourceChanges++;
                        if (node) nodes.set(id, node); }
                }
                report.removedNodes = [...oldSources.keys()].filter(id => !sourceById.has(id)).length;
                const graph = compile(scopeKey, revision, retainedNodes([...nodes.values()], preset));
                if (!graph) throw new Error('graph_build_failed');
                report.readbackVerified = await persistGraph(scopeKey, payloadFor(binding, revision, nodes.size, graph), context.guard);
                report.mode = state ? 'updated' : 'built';
                if (context.guard && !context.guard()) throw new Error('graph_source_invalidated');
                // Match the established HME scope cache bound.
                if (!states.has(scopeKey) && states.size >= 48) states.delete(states.keys().next().value);
                states.set(scopeKey, { revision, binding, graph, nodes, sources: sourceById, totalNodes: nodes.size, readbackVerified: report.readbackVerified });
                return { graph, totalNodes: nodes.size, report };
            };
            const maintain = (units, context) => {
                const scopeKey = context.scopeKey;
                const token = Object.freeze({ epoch });
                pending.set(scopeKey, token);
                const guard = () => epoch === token.epoch && pending.get(scopeKey) === token
                    && (typeof context.guard !== 'function' || context.guard());
                const next = (writeBarriers.get(scopeKey) || Promise.resolve()).catch(() => {}).then(() => maintainNow(units, { ...context, guard }));
                writeBarriers.set(scopeKey, next);
                return next.finally(() => {
                    if (pending.get(scopeKey) === token) pending.delete(scopeKey);
                    if (writeBarriers.get(scopeKey) === next) writeBarriers.delete(scopeKey);
                });
            };
            return Object.freeze({ maintain, clear, cachedScopes: () => states.size });
        })();
        const maintainHmeTypedSourceGraph = async (snapshot, options = {}) => {
            if (!isHmeGraphEnabled()) return { ok: false, reason: 'disabled' };
            if (!snapshot?.scopeKey || !Array.isArray(snapshot.canonicalLore)) return { ok: false, reason: 'invalid_source' };
            const units = TypedRecallCorpus.enumerate(snapshot);
            if (units.length > 8192) return { ok: false, reason: 'corpus_bound' };
            const maintained = await TypedHmeSourceGraph.maintain(units, { ...snapshot, guard: options.guard || snapshot.guard });
            return { ok: true, nodes: maintained.totalNodes, maintenance: maintained.report };
        };
        const searchHmeTypedGraphCandidates = async (units = [], seedIdentities = [], context = {}) => {
            const empty = reason => ({ hits: [], trace: { reason, nodes: 0, edges: 0 } });
            if (!isHmeGraphEnabled()) return empty('disabled');
            const scopeKey = String(context.scopeKey || '');
            const preset = getHmeGraphPreset();
            if (!scopeKey || !Array.isArray(units) || units.length > 8192) return empty('corpus_bound');
            const families = ['memory', 'entity', 'world', 'narrative'];
            const valid = units.filter(unit => unit?.scopeKey === scopeKey && families.includes(unit.family));
            const maintained = await TypedHmeSourceGraph.maintain(context.sourceUnits || valid, context);
            const eligible = new Set(valid.filter(unit => {
                // A protected source must not create an indirect association path
                // even when its public formatter could redact the eventual text.
                return JSON.stringify(SecretKnowledgeCore.redactPayloadForViewer(unit.record, context.viewerId || 'main_request')) === JSON.stringify(unit.record);
            }).map(unit => unit.identity));
            const nodes = maintained.graph.nodes.filter(node => eligible.has(node.rowId)), nodeIds = new Set(nodes.map(node => node.id));
            const typedGraph = rebuildHmeGraphRuntimeShape({ ...maintained.graph, nodes,
                edges: maintained.graph.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to)) });
            const typedEntriesByIdentity = new Map(valid.map(unit => [unit.identity, { key: unit.identity }]));
            const seeds = seedIdentities.map(identity => typedEntriesByIdentity.get(identity)).filter(Boolean);
            const expanded = expandHmeGraphRecallCandidates(seeds, typedEntriesByIdentity, { scopeKey, graph: typedGraph });
            const retainedCandidates = new Set((expanded.entries || []).map(entry => entry.key));
            const hits = [...(expanded.boostByKey || new Map()).values()].filter(hit => retainedCandidates.has(hit.rowId) && hit.edgeChain?.length > 1)
                .map(hit => ({ identity: hit.rowId, score: hit.boost,
                    evidence: { scopeKey, corpusRevision: context.corpusRevision, nodeId: hit.nodeId,
                        edgeChain: hit.edgeChain, relation: hit.relation, confidence: hit.confidence } }));
            return { hits, trace: { reason: expanded.ok ? '' : expanded.reason, nodes: nodes.length,
                omittedNodes: maintained.totalNodes - nodes.length, edges: typedGraph.edges.length, discovered: hits.length,
                maintenance: maintained.report } };
        };
