    // [MANAGER] Hierarchical World Maker
    // ══════════════════════════════════════════════════════════════
    const HierarchicalWorldManager = (() => {
        let profile = null;
        // 동시 활성 위치 상한 — 위치가 많아도 주입이 폭발하지 않게.
        const WORLD_ACTIVE_NODE_CAP = 16;
        const WORLD_GRAPH_COMMENT = "lmai_world_graph";
        const WORLD_NODE_COMMENT = "lmai_world_node";
        const REMOVED_WORLD_GRAPH_COMMENTS = new Set([WORLD_GRAPH_COMMENT, WORLD_NODE_COMMENT]);

        const removeWorldGraphEntries = (lorebook) => {
            if (!Array.isArray(lorebook)) return 0;
            let removed = 0;
            for (let i = lorebook.length - 1; i >= 0; i--) {
                if (REMOVED_WORLD_GRAPH_COMMENTS.has(String(lorebook[i]?.comment || ''))) {
                    lorebook.splice(i, 1);
                    removed += 1;
                }
            }
            return removed;
        };

        const createDefaultProfile = () => ({
            version: '6.0',
            rootId: null,
            global: {
                multiverse: false,
                dimensionTravel: false,
                timeTravel: false,
                metaNarrative: false,
                virtualReality: false,
                dreamWorld: false,
                reincarnationPossession: false,
                systemInterface: false
            },
            nodes: new Map(),
            activePath: [],
            activeNodes: [],
            interference: { level: 0, recentEvents: [] },
            meta: { created: Date.now(), updated: 0, complexity: 1 }
        });

        const createDefaultRootNode = () => ({
            id: 'world_main',
            name: '주요 세계',
            layer: 'dimension',
            parent: null,
            children: [],
            isActive: true,
            isPrimary: true,
            accessCondition: null,
            rules: {
                exists: { mythical_creatures: [], non_human_races: [] },
                systems: {},
                setting: { places: [], organizations: [], socialRules: [] },
                physics: { special_phenomena: [] },
                inheritance: { mode: 'extend', exceptions: [] },
                ruleMeta: {
                    schema: 'libra.world.rule_meta.v1',
                    metaphysics: {
                        magic: { state: 'unknown', explicitness: 'none', emitPolicy: 'silent', evidence: [] },
                        ki: { state: 'unknown', explicitness: 'none', emitPolicy: 'silent', evidence: [] },
                        supernatural: { state: 'unknown', explicitness: 'none', emitPolicy: 'silent', evidence: [] }
                    },
                    systems: {},
                    consistencyWarnings: [],
                    autoDemotions: []
                }
            },
            dimensional: null,
            connections: [],
            meta: { created: Date.now(), updated: 0, source: 'default', notes: '', worldSummary: '', classification: '', worldMetadata: {} }
        });

        const normalizeNodeMap = (nodes) => {
            if (nodes instanceof Map) return nodes;
            if (Array.isArray(nodes)) {
                try { return new Map(nodes.filter(item => Array.isArray(item) && item.length >= 2)); }
                catch { return new Map(); }
            }
            if (nodes && typeof nodes === 'object') {
                try { return new Map(Object.entries(nodes)); }
                catch { return new Map(); }
            }
            return new Map();
        };

        const ensureProfile = () => {
            if (!profile || typeof profile !== 'object') {
                profile = createDefaultProfile();
            }
            profile.nodes = normalizeNodeMap(profile.nodes);
            profile.global = (profile.global && typeof profile.global === 'object') ? profile.global : createDefaultProfile().global;
            profile.activePath = Array.isArray(profile.activePath) ? profile.activePath : [];
            // 복수 활성 위치 — 세포들이 여러 위치에 있을 수 있다(사용자 설계).
            // 비어 있으면 activePath 를 따른다(하위 호환: 위치 1곳이면 종전과 완전히 동일).
            profile.activeNodes = Array.isArray(profile.activeNodes)
                ? profile.activeNodes.map(v => String(v || '').trim()).filter(v => v && profile.nodes.has(v)).slice(0, WORLD_ACTIVE_NODE_CAP)
                : [];
            if (profile.activeNodes.length === 0 && profile.activePath.length > 0) {
                profile.activeNodes = profile.activePath.slice(-1);
            }
            profile.interference = (profile.interference && typeof profile.interference === 'object') ? profile.interference : { level: 0, recentEvents: [] };
            profile.interference.recentEvents = Array.isArray(profile.interference.recentEvents) ? profile.interference.recentEvents : [];
            profile.meta = (profile.meta && typeof profile.meta === 'object') ? profile.meta : { created: Date.now(), updated: 0, complexity: 1 };
            if (profile.nodes.size === 0) {
                profile.rootId = null;
                profile.activePath = [];
                return profile;
            }
            if (!profile.rootId || !profile.nodes.has(profile.rootId)) {
                profile.rootId = profile.nodes.keys().next().value || null;
            }
            if (profile.activePath.length === 0 && profile.rootId) {
                profile.activePath = [profile.rootId];
            }
            return profile;
        };

        // 노드 ID 는 결정적이고 충돌하지 않아야 한다.
        // 결함 이력: `node_${Date.now()}` 는 같은 밀리초에 같은 ID 를 만들어
        // profile.nodes.set() 이 앞 노드를 조용히 덮어썼다(실측: 3갈래 생성 → 노드 2개).
        // 멀티노드(여러 위치 동시 활성)가 이 결함에 정확히 걸린다.
        // HME(10c)가 stableHash 로 그래프 노드 ID 를 만드는 관례를 따른다.
        let worldNodeSeq = 0;
        const buildWorldNodeId = () => {
            ensureProfile();
            let candidate = '';
            let guard = 0;
            do {
                worldNodeSeq += 1;
                const suffix = (typeof stableHash === 'function')
                    ? String(stableHash(`${Date.now()}|${worldNodeSeq}|${profile.nodes.size}`)).replace(/^-/, 'n')
                    : `${Date.now().toString(36)}_${worldNodeSeq.toString(36)}`;
                candidate = `node_${suffix}`;
                guard += 1;
            } while (profile.nodes.has(candidate) && guard < 64);
            return candidate;
        };
        const deepMerge = (target, source) => {
            const result = { ...target };
            for (const key in source) {
                if (Array.isArray(source[key])) {
                    result[key] = [...new Set([...(Array.isArray(result[key]) ? result[key] : []), ...source[key]])];
                } else if (source[key] && typeof source[key] === 'object') {
                    const nextTarget = (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) ? result[key] : {};
                    result[key] = deepMerge(nextTarget, source[key]);
                } else {
                    result[key] = source[key];
                }
            }
            return result;
        };

        const deepClone = safeClone;

        const sanitizeNodeWorldRules = (node = null) => {
            if (!node || typeof node !== 'object') return node;
            const meta = node.meta && typeof node.meta === 'object' ? node.meta : {};
            const sourceText = [
                meta.classification,
                meta.worldSummary,
                meta.notes,
                meta.userWorldCorrection,
                meta.worldMetadata?.classification,
                meta.worldMetadata?.summary,
                meta.worldMetadata?.description,
                meta.worldMetadata?.tech,
                meta.worldMetadata?.sourceText,
                meta.worldMetadata?.userWorldCorrection,
                collectWorldRuleEvidenceText(node.rules || {})
            ].map(value => String(value || '').trim()).filter(Boolean).join('\n');
            node.rules = sanitizeWorldRuleUpdateForPolicy(node.rules || {}, sourceText);
            return node;
        };

        const serializeWorldNode = (node = {}) => ({
            id: String(node?.id || '').trim(),
            name: String(node?.name || '').trim() || '주요 세계',
            layer: String(node?.layer || '').trim() || 'dimension',
            parent: node?.parent || null,
            children: Array.isArray(node?.children) ? node.children.map(value => String(value || '').trim()).filter(Boolean).slice(0, 64) : [],
            isActive: node?.isActive === true,
            isPrimary: node?.isPrimary !== false,
            accessCondition: node?.accessCondition || null,
            rules: sanitizeWorldRuleUpdateForPolicy(node?.rules || {}, collectWorldRuleEvidenceText(node?.rules || {})),
            dimensional: node?.dimensional && typeof node.dimensional === 'object' ? safeClone(node.dimensional) : null,
            connections: Array.isArray(node?.connections) ? safeClone(node.connections).slice(0, 64) : [],
            meta: node?.meta && typeof node.meta === 'object' ? safeClone(node.meta) : { created: Date.now(), updated: 0, source: 'llm_analysis', notes: '', worldSummary: '', classification: '', worldMetadata: {} }
        });

        const serializeWorldProfile = () => {
            ensureProfile();
            const nodes = Array.from(profile.nodes.entries())
                .slice(0, 64)
                .map(([id, node]) => [String(id || node?.id || '').trim(), serializeWorldNode({ ...node, id: String(id || node?.id || '').trim() })])
                .filter(([id, node]) => id && node && node.id);
            return {
                schema: 'libra.world.graph.compact.v2',
                version: '6.1',
                rootId: String(profile.rootId || '').trim() || (nodes[0] ? nodes[0][0] : null),
                global: profile.global && typeof profile.global === 'object' ? safeClone(profile.global) : createDefaultProfile().global,
                nodes,
                activePath: Array.isArray(profile.activePath) ? profile.activePath.map(value => String(value || '').trim()).filter(Boolean).slice(0, 16) : [],
                activeNodes: Array.isArray(profile.activeNodes) ? profile.activeNodes.map(value => String(value || '').trim()).filter(Boolean).slice(0, WORLD_ACTIVE_NODE_CAP) : [],
                interference: profile.interference && typeof profile.interference === 'object' ? safeClone(profile.interference) : { level: 0, recentEvents: [] },
                meta: profile.meta && typeof profile.meta === 'object' ? safeClone(profile.meta) : { created: Date.now(), updated: 0, complexity: 1 }
            };
        };

        const hydrateWorldProfile = (rawProfile = null) => {
            const next = createDefaultProfile();
            const source = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
            const rawNodes = Array.isArray(source.nodes)
                ? source.nodes
                : (source.nodes && typeof source.nodes === 'object' ? Object.entries(source.nodes) : []);
            for (const entry of rawNodes) {
                const id = Array.isArray(entry) ? String(entry[0] || '').trim() : String(entry?.id || '').trim();
                const node = Array.isArray(entry) ? entry[1] : entry;
                if (!id || !node || typeof node !== 'object') continue;
                next.nodes.set(id, sanitizeNodeWorldRules(serializeWorldNode({ ...node, id })));
            }
            if (next.nodes.size === 0) {
                const root = createDefaultRootNode();
                next.rootId = root.id;
                next.nodes.set(root.id, root);
                next.activePath = [root.id];
            } else {
                next.rootId = String(source.rootId || '').trim();
                if (!next.rootId || !next.nodes.has(next.rootId)) next.rootId = next.nodes.keys().next().value || null;
                next.activePath = Array.isArray(source.activePath)
                    ? source.activePath.map(value => String(value || '').trim()).filter(value => next.nodes.has(value)).slice(0, 16)
                    : [];
                if (next.activePath.length === 0 && next.rootId) next.activePath = [next.rootId];
                next.activeNodes = Array.isArray(source.activeNodes)
                    ? source.activeNodes.map(v => String(v || '').trim()).filter(v => v && next.nodes.has(v)).slice(0, WORLD_ACTIVE_NODE_CAP)
                    : [];
                if (next.activeNodes.length === 0 && next.activePath.length > 0) next.activeNodes = next.activePath.slice(-1);
            }
            next.global = source.global && typeof source.global === 'object' ? safeClone(source.global) : next.global;
            next.interference = source.interference && typeof source.interference === 'object' ? safeClone(source.interference) : next.interference;
            next.interference.recentEvents = Array.isArray(next.interference?.recentEvents) ? next.interference.recentEvents.slice(-10) : [];
            next.meta = source.meta && typeof source.meta === 'object' ? safeClone(source.meta) : next.meta;
            profile = next;
            updateComplexity();
            return ensureProfile();
        };

        const loadWorldGraph = (lorebook, force = false) => {
            if (profile && !force) return profile;
            const unpacked = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : []);
            const entry = unpacked.find(item => String(item?.comment || '') === WORLD_GRAPH_COMMENT);
            if (entry) {
                try {
                    const parsed = JSON.parse(entry.content || '{}');
                    return hydrateWorldProfile(parsed);
                } catch (error) {
                    recordRuntimeDebug('warn', '[LIBRA] World graph parse failed; rebuilding empty root:', error?.message || error);
                }
            }
            return hydrateWorldProfile(null);
        };

        const getEffectiveRules = (nodeId) => {
            ensureProfile();
            const node = profile.nodes.get(nodeId);
            if (!node) return null;

            const parentChain = [];
            const visited = new Set();
            let currentId = node.parent;
            
            visited.add(nodeId); // 현재 노드 등록
            while (currentId) {
                if (visited.has(currentId)) {
                    recordRuntimeDebug('warn', `[LIBRA] Circular reference detected in world graph at node: ${currentId}`);
                    break;
                }
                visited.add(currentId);
                const parentNode = profile.nodes.get(currentId);
                if (parentNode) {
                    parentChain.unshift(parentNode);
                    currentId = parentNode.parent;
                } else break;
            }

            let effectiveRules = { exists: {}, systems: {}, physics: {}, custom: {} };
            for (const parent of parentChain) {
                effectiveRules = mergeRules(effectiveRules, parent.rules, parent.rules?.inheritance?.mode || 'extend');
            }
            effectiveRules = mergeRules(effectiveRules, node.rules, node.rules?.inheritance?.mode || 'extend');
            return effectiveRules;
        };

        const mergeRules = (base, overlay, mode) => {
            if (!overlay) return base;
            if (mode === 'override' || mode === 'isolate') return deepClone(overlay);
            return deepMerge(base, overlay);
        };

        const getCurrentRules = () => {
            if (!profile) return null;
            ensureProfile();
            if (profile.activePath.length === 0) return null;
            const currentId = profile.activePath[profile.activePath.length - 1];
            return getEffectiveRules(currentId);
        };
        const getCurrentNode = () => {
            if (!profile) return null;
            ensureProfile();
            if (!Array.isArray(profile.activePath) || profile.activePath.length === 0) return null;
            const currentId = profile.activePath[profile.activePath.length - 1];
            return profile.nodes.get(currentId) || null;
        };
        const getUserWorldCorrection = () => {
            const currentNode = getCurrentNode();
            const text = String(
                currentNode?.meta?.userWorldCorrection
                || currentNode?.meta?.worldMetadata?.userWorldCorrection
                || ''
            ).trim();
            return text;
        };
        const formatUserWorldCorrectionForPrompt = () => '';

        const buildPathToNode = (nodeId) => {
            ensureProfile();
            const path = [];
            const visited = new Set();
            let currentId = nodeId;
            while (currentId) {
                if (visited.has(currentId)) {
                    recordRuntimeDebug('warn', `[LIBRA] Circular reference detected while building active path: ${currentId}`);
                    break;
                }
                visited.add(currentId);
                const node = profile.nodes.get(currentId);
                if (!node) break;
                path.unshift(currentId);
                currentId = node.parent;
            }
            return path;
        };

        const changeActivePath = (newNodeId, transition = null) => {
            ensureProfile();
            const node = profile.nodes.get(newNodeId);
            if (!node) return { success: false, reason: 'Node not found' };

            const oldPath = [...profile.activePath];
            const newPath = buildPathToNode(newNodeId);
            if (newPath.length === 0) return { success: false, reason: 'Unable to build path' };
            profile.activePath = newPath;
            // 주 초점이 바뀌면 복수 활성 목록도 그 지점으로 맞춘다(단일 위치 동작 보존).
            // 여러 위치를 유지하려면 changeActivePath 뒤에 setActiveNodes 를 부른다.
            profile.activeNodes = newPath.slice(-1);
            syncActiveNodeFlags();

            if (transition) {
                profile.interference.recentEvents.push({
                    type: 'dimension_shift',
                    from: oldPath,
                    to: [...profile.activePath],
                    method: transition.method,
                    turn: MemoryState.currentTurn
                });
                if (profile.interference.recentEvents.length > 10) {
                    profile.interference.recentEvents.shift();
                }
                profile.interference.level = Math.min(1, profile.interference.recentEvents.length / 10);
            }

            return { success: true, oldPath, newPath: profile.activePath, node };
        };

        const popActivePath = () => {
            ensureProfile();
            if (profile.activePath.length <= 1) return { success: false, reason: 'Cannot pop root' };
            const removedId = profile.activePath.pop();
            const removedNode = profile.nodes.get(removedId);
            if (removedNode) removedNode.isActive = false;
            profile.activeNodes = profile.activePath.slice(-1);
            syncActiveNodeFlags();
            return { success: true, removedNode, currentPath: profile.activePath };
        };

        // 활성 위치를 노드 플래그에 반영한다. activePath(주 초점)와 activeNodes(복수)를 함께 켠다.
        const syncActiveNodeFlags = () => {
            ensureProfile();
            const activeSet = new Set([...profile.activePath, ...(profile.activeNodes || [])]);
            for (const [, worldNode] of profile.nodes) worldNode.isActive = activeSet.has(worldNode.id);
        };
        const normalizeActiveNodeIds = (ids = []) => {
            ensureProfile();
            return Array.from(new Set((Array.isArray(ids) ? ids : [ids])
                .map(v => String(v || '').trim())
                .filter(v => v && profile.nodes.has(v))))
                .slice(0, WORLD_ACTIVE_NODE_CAP);
        };
        const setActiveNodes = (ids = []) => {
            ensureProfile();
            profile.activeNodes = normalizeActiveNodeIds(ids);
            if (profile.activeNodes.length === 0 && profile.activePath.length > 0) {
                profile.activeNodes = profile.activePath.slice(-1);
            }
            syncActiveNodeFlags();
            return { success: true, activeNodes: [...profile.activeNodes] };
        };
        const addActiveNode = (nodeId) => setActiveNodes([...(profile?.activeNodes || []), nodeId]);
        const removeActiveNode = (nodeId) => setActiveNodes((profile?.activeNodes || []).filter(v => v !== String(nodeId || '').trim()));
        const getActiveNodes = () => {
            ensureProfile();
            return [...(profile.activeNodes || [])];
        };
        // 이름으로 노드를 찾는다 — **정확 일치만**. 부분 일치는 발명의 시작이 된다(5.2.8 오작동의 형태).
        // 세포(인물)가 어느 개체(세계)에 속하는가 — 4단계.
        //   location 은 휘발성(04:119)이라 소속을 위치에서 파생할 수 없다. 명시적으로 해석한다.
        //   ★ 규칙 텍스트는 돌려주지 않는다 — 세계 규칙은 세계 블록이 매 턴 내고 있다.
        //     인물 컨텍스트에 또 넣으면 5단계에서 끊은 중복이 돌아온다.
        //   ★ 자명한 값은 내지 않는다: 루트(주요 세계)뿐이면 빈 문자열.
        //     (규칙이 0개면 세계 블록이 빈 것과 같은 원칙)
        const resolveEntityWorldName = (options = {}) => {
            try {
                const p = ensureProfile();
                if (!p || !p.nodes) return '';
                const rootId = String(p.rootId || '');
                const nodeOf = (id) => (p.nodes instanceof Map ? p.nodes.get(id) : null);
                const nameOf = (id) => String(nodeOf(id)?.name || '').trim();
                const isRoot = (id) => !!rootId && String(id || '') === rootId;
                // 최상위 세계(개체) 이름 — 루트 바로 아래 단계까지 올라간다.
                const topWorldName = (id) => {
                    let cur = String(id || '');
                    let name = '';
                    let guard = 0;
                    while (cur && !isRoot(cur) && guard++ < 64) {
                        const own = nameOf(cur);
                        if (own) name = own;
                        const parent = String(nodeOf(cur)?.parent || '');
                        if (!parent || isRoot(parent)) break;
                        cur = parent;
                    }
                    return name;
                };
                // 1) 장소가 노드 이름과 **정확히** 일치하면 그 장소가 속한 세계
                //    (부분 일치는 발명의 시작이라 하지 않는다 — findNodeByName 도 정확 일치만 한다)
                const byLocation = findNodeByName(String(options.location || '').trim());
                if (byLocation && byLocation.id && !isRoot(byLocation.id)) {
                    const named = topWorldName(byLocation.id) || String(byLocation.name || '').trim();
                    if (named) return named;
                }
                // 2) 아니면 지금 장면의 세계. 루트뿐이면 빈 값.
                const activeId = String(options.activeNodeId || getCurrentNode()?.id || '');
                if (activeId && !isRoot(activeId)) return topWorldName(activeId) || nameOf(activeId);
                return '';
            } catch (_) { return ''; }
        };

        // 승격된 규칙을 **내용으로 찾아** 제거한다 (강등 경로).
        //   deepMerge 는 배열을 `new Set` 합집합으로 만들므로 updateNode 로는 제거할 수 없다.
        //   또 GUI 저장이 custom 키를 rule_1..N 으로 재부여하므로 키로는 찾을 수 없다.
        const removeWorldRuleByText = (nodeId, text) => {
            const target = String(text || '').replace(/\s+/g, ' ').trim();
            if (!nodeId || !target) return { removed: 0, changed: false };
            const node = profile?.nodes instanceof Map ? profile.nodes.get(String(nodeId)) : null;
            if (!node) return { removed: 0, changed: false };
            let removed = 0;
            const custom = node.rules?.custom;
            if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
                for (const key of Object.keys(custom)) {
                    const value = custom[key];
                    if (Array.isArray(value)) {
                        const next = value.filter(item => {
                            const same = String(item || '').replace(/\s+/g, ' ').trim() === target;
                            if (same) removed += 1;
                            return !same;
                        });
                        if (next.length === 0) delete custom[key];
                        else custom[key] = next;
                    } else if (String(value || '').replace(/\s+/g, ' ').trim() === target) {
                        delete custom[key];
                        removed += 1;
                    }
                }
            }
            if (removed > 0) {
                node.meta = node.meta && typeof node.meta === 'object' ? node.meta : {};
                node.meta.updated = Date.now();
            }
            return { removed, changed: removed > 0 };
        };

        const findNodeByName = (name) => {
            ensureProfile();
            const target = String(name || '').trim();
            if (!target) return null;
            for (const [, node] of profile.nodes) {
                if (String(node?.name || '').trim() === target) return node;
            }
            return null;
        };

        // 현재 턴을 얻는다 — 없으면 0(불명). 상속 판정이 이 값으로 노드를 자른다.
        const currentTurnForStamp = () => {
            try {
                const memoryTurn = (typeof MemoryEngine !== 'undefined' && MemoryEngine)
                    ? MemoryEngine.getCurrentTurn?.() : null;
                if (Number.isFinite(Number(memoryTurn)) && Number(memoryTurn) > 0) return Number(memoryTurn);
                const stateTurn = (typeof MemoryState !== 'undefined' && MemoryState) ? MemoryState.currentTurn : null;
                if (Number.isFinite(Number(stateTurn)) && Number(stateTurn) > 0) return Number(stateTurn);
            } catch (_) {}
            return 0;
        };
        const createNode = (config) => {
            ensureProfile();
            const id = config.id || buildWorldNodeId();
            const parentId = config.parent;

            if (parentId) {
                const parent = profile.nodes.get(parentId);
                if (!parent) return { success: false, reason: 'Parent not found' };
            }

            const node = {
                id,
                name: config.name || '새로운 세계',
                layer: config.layer || 'dimension',
                parent: parentId,
                children: [],
                isActive: false,
                isPrimary: config.isPrimary || false,
                accessCondition: config.accessCondition || null,
                rules: config.rules || { exists: {}, systems: {}, setting: { places: [], organizations: [], socialRules: [] }, physics: {}, inheritance: { mode: 'extend', exceptions: [] } },
                dimensional: config.dimensional || null,
                connections: config.connections || [],
                meta: {
                    created: Date.now(),
                    // ★ `created` 는 **시각**(ms)이다 — 분기 상속의 forkTurn(턴 번호)과 단위가 다르다.
                    //   상속 판정이 이걸 턴으로 읽으면 정상 노드를 전부 삭제한다(실측 P0).
                    //   그래서 **턴 전용 필드**를 따로 남긴다.
                    createdTurn: currentTurnForStamp(),
                    updated: 0,
                    source: config.source || 'user',
                    notes: config.notes || '',
                    worldSummary: config.worldSummary || '',
                    classification: config.classification || '',
                    worldMetadata: config.worldMetadata && typeof config.worldMetadata === 'object' ? safeClone(config.worldMetadata) : {}
                }
            };
            sanitizeNodeWorldRules(node);

            profile.nodes.set(id, node);
            if (parentId) {
                const parent = profile.nodes.get(parentId);
                // 같은 id 가 이미 있으면 다시 넣지 않는다 — 순회 시 유령 참조/무한 재귀 방지.
                if (parent && !parent.children.includes(id)) parent.children.push(id);
            }

            updateComplexity();
            return { success: true, node };
        };

        const updateNode = (nodeId, updates) => {
            ensureProfile();
            const node = profile.nodes.get(nodeId);
            if (!node) return { success: false, reason: 'Node not found' };

            if (updates.name) node.name = updates.name;
            if (updates.rules) node.rules = sanitizeWorldRuleUpdateForPolicy(deepMerge(node.rules, updates.rules), collectWorldRuleEvidenceText(updates.rules));
            if (updates.dimensional) node.dimensional = { ...node.dimensional, ...updates.dimensional };
            if (updates.connections) node.connections = [...node.connections, ...updates.connections];
            if (updates.meta && typeof updates.meta === 'object') node.meta = deepMerge(node.meta || {}, updates.meta);
            sanitizeNodeWorldRules(node);
            node.meta.updated = Date.now();

            return { success: true, node };
        };

        const updateComplexity = () => {
            ensureProfile();
            const nodeCount = profile.nodes.size;
            const connectionCount = Array.from(profile.nodes.values()).reduce((sum, n) => sum + (n.connections?.length || 0), 0);
            profile.meta.complexity = 1 + Math.log2(nodeCount + 1) + (connectionCount * 0.1);
        };

        const _saveWorldGraphUnsafe = (lorebook) => {
            if (!Array.isArray(lorebook)) return;
            removeWorldGraphEntries(lorebook);
            const payload = serializeWorldProfile();
            lorebook.push({
                key: LibraLoreKeys?.worldGraph ? LibraLoreKeys.worldGraph() : 'lmai_world_graph::compact',
                comment: WORLD_GRAPH_COMMENT,
                content: JSON.stringify(payload),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            });
        };

        const saveWorldGraph = async (char, chat, lorebook) => {
            await loreLock.writeLock();
            try {
                _saveWorldGraphUnsafe(lorebook);
            } finally {
                loreLock.writeUnlock();
            }
        };

        // ★ 세계 규칙도 리롤·롤백을 탄다 (§5-6 — 기억·RP-LTM·엔티티와 대칭).
        //   판정 로직은 게이트가 **실행할 수 있는 자리**에 둔다(파이프라인에 숨기지 않는다).
        const applyRuleWorldlineFilter = (rules = [], state = null, meta = null) => {
            const list = Array.isArray(rules) ? rules : [];
            // worldline 상태가 없으면 종전과 **완전히 동일**(fail-open, 하위 호환).
            if (!state || list.length === 0) return { rules: list, excluded: 0, excludedTurns: [] };
            // ★ 상태 해석은 **이미 있는 판정 함수**를 그대로 쓴다 — 리롤/롤백 구분 규칙을 복제하지 않는다.
            //   엔티티 필터를 고른 이유: 턴 도장(`meta.created`)만 보므로 어댑터가 단순하다
            //   (기억 필터는 응답 지문까지 보므로 가짜 엔트리를 만들면 오판 위험이 있다).
            const excludedTurns = (() => {
                try {
                    const WL = (typeof LibraTurnWorldline !== 'undefined' && LibraTurnWorldline)
                        || (typeof globalThis !== 'undefined' ? globalThis.LibraTurnWorldline : null);
                    if (WL && typeof WL.filterSupersededEntityRecords === 'function') {
                        const probe = WL.filterSupersededEntityRecords(
                            list.map((text) => ({ name: String(text || ''), meta: { created: Number((meta && meta[text]) || 0) || 0 } })),
                            state
                        );
                        const keptNames = new Set((probe?.items || []).map(item => String(item?.name || '')));
                        return new Set(list.filter(text => !keptNames.has(String(text || ''))));
                    }
                } catch (_) {}
                return null;
            })();
            if (!excludedTurns || excludedTurns.size === 0) return { rules: list, excluded: 0, excludedTurns: [] };
            const droppedTurns = [];
            const kept = list.filter((rule) => {
                if (!excludedTurns.has(String(rule || ''))) return true;
                const turn = Number((meta && meta[rule]) || 0) || 0;
                if (turn && !droppedTurns.includes(turn)) droppedTurns.push(turn);
                return false;
            });
            return { rules: kept, excluded: list.length - kept.length, excludedTurns: droppedTurns };
        };
        // 출처 턴 매핑을 모은다 — 노드별 `rules.ruleMeta.promotedRules`(텍스트 → 턴).
        const promotedRuleTurns = () => {
            const out = {};
            try {
                const nodes = (profile && profile.nodes instanceof Map) ? profile.nodes.values() : [];
                for (const node of nodes) {
                    const meta = node?.rules?.ruleMeta?.promotedRules;
                    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
                        for (const [text, turn] of Object.entries(meta)) {
                            const key = String(text || '').trim();
                            const t = Number(turn) || 0;
                            if (key && t && !out[key]) out[key] = t;
                        }
                    }
                }
            } catch (_) {}
            return out;
        };
        //   `options.worldlineState` 를 주면 리롤·롤백된 턴의 승격 규칙을 **프롬프트에서 뺀다**.
        //   주지 않으면 종전과 바이트 단위로 동일하다 (하위 호환 — 호출부 5곳이 그대로 동작한다).
        const formatForPrompt = (options = {}) => {
            if (!profile) return '';
            ensureProfile();

            const compactWorldList = (values = [], limit = 10) => dedupeTextArray(
                (Array.isArray(values) ? values : [values])
                    .flatMap(value => splitImportedWorldRuleFragments(String(value || '')))
                    .map(value => String(value || '').trim())
                    .filter(value => value && !isStructuralWorldScalar(value))
            ).slice(0, limit);
            const compactCustomRules = (custom = {}, limit = 10) => {
                const normalized = normalizeWorldCustomRules(custom);
                const out = [];
                for (const [key, value] of Object.entries(normalized)) {
                    for (const fragment of splitImportedWorldRuleFragments(value)) {
                        const text = String(fragment || '').trim();
                        if (!text || isStructuralWorldScalar(text)) continue;
                        out.push(/^rule_\d+$/i.test(String(key || '').trim()) ? text : `${key}: ${text}`);
                    }
                }
                return dedupeTextArray(out).slice(0, limit);
            };

            const parts = [];
            parts.push('【세계관 구조 / World Structure】');

            const globalFeatures = [];
            if (profile.global.multiverse) globalFeatures.push('멀티버스/Multiverse');
            if (profile.global.dimensionTravel) globalFeatures.push('차원 이동 가능/Dimension Travel');
            if (profile.global.timeTravel) globalFeatures.push('시간 여행 가능/Time Travel');
            if (profile.global.metaNarrative) globalFeatures.push('메타 서술/Meta Narrative');
            if (profile.global.virtualReality) globalFeatures.push('가상현실/Virtual Reality');
            if (profile.global.dreamWorld) globalFeatures.push('꿈 세계/Dream World');
            if (profile.global.reincarnationPossession) globalFeatures.push('회귀·환생·빙의/Reincarnation or Possession');
            if (profile.global.systemInterface) globalFeatures.push('시스템 인터페이스/System Interface');
            if (globalFeatures.length > 0) parts.push(`구조/Structure: ${globalFeatures.join(', ')}`);

            if (profile.activePath.length > 0) {
                parts.push('\n[현재 위치 / Current Location]');
                for (let i = 0; i < profile.activePath.length; i++) {
                    const node = profile.nodes.get(profile.activePath[i]);
                    if (node) {
                        const indent = '  '.repeat(i);
                        const active = i === profile.activePath.length - 1 ? ' ← 현재/Current' : '';
                        parts.push(`${indent}${node.name}${active}`);
                    }
                }
            }

            // 복수 활성 위치 — 세포들이 여러 곳에 있으면 그 위치들을 모두 알린다.
            // 1곳이면 종전과 동일한 출력을 유지한다(하위 호환).
            const activeNodeIdsForPrompt = (() => {
                ensureProfile();
                const ids = Array.isArray(profile.activeNodes) && profile.activeNodes.length > 0
                    ? profile.activeNodes
                    : profile.activePath.slice(-1);
                return Array.from(new Set(ids)).filter(id => profile.nodes.has(id)).slice(0, WORLD_ACTIVE_NODE_CAP);
            })();
            const multiLocation = activeNodeIdsForPrompt.length > 1;
            if (multiLocation) {
                parts.push('\n[활성 위치 / Active Locations]');
                for (const id of activeNodeIdsForPrompt) {
                    const n = profile.nodes.get(id);
                    if (n) parts.push(`  - ${n.name}${id === profile.activePath[profile.activePath.length - 1] ? ' ← 주 초점/Primary' : ''}`);
                }
            }

            const currentNodeId = profile.activePath[profile.activePath.length - 1];
            const currentNode = currentNodeId ? profile.nodes.get(currentNodeId) : null;
            const currentMeta = currentNode?.meta || {};
            const worldSummaryLines = [];
            const classification = String(currentMeta.classification || currentMeta.worldMetadata?.classification || '').trim();
            const worldSummary = String(currentMeta.worldSummary || currentMeta.worldMetadata?.summary || '').trim();
            const worldDescription = String(currentMeta.worldMetadata?.description || '').trim();
            const worldTechMemo = String(currentMeta.worldMetadata?.tech || '').trim();
            const worldNotes = String(currentMeta.notes || currentMeta.worldMetadata?.notes || '').trim();
            const userWorldCorrection = String(currentMeta.userWorldCorrection || currentMeta.worldMetadata?.userWorldCorrection || '').trim();
            if (classification) worldSummaryLines.push(`분류/Classification: ${classification}`);
            if (worldSummary) worldSummaryLines.push(`요약/Summary: ${truncateForLLM(worldSummary, 700, ' ... ')}`);
            if (worldDescription) worldSummaryLines.push(`설명/Description: ${truncateForLLM(worldDescription, 500, ' ... ')}`);
            if (worldTechMemo) worldSummaryLines.push(`기술 메모/Tech Note: ${truncateForLLM(worldTechMemo, 360, ' ... ')}`);
            if (worldNotes) worldSummaryLines.push(`노트/Notes: ${truncateForLLM(worldNotes, 360, ' ... ')}`);
            if (userWorldCorrection) worldSummaryLines.push(`수동 보정/User Correction: ${truncateForLLM(userWorldCorrection, 600, ' ... ')}`);
            if (worldSummaryLines.length > 0) {
                parts.push('\n[세계관 코덱스 / World Codex]');
                parts.push(...worldSummaryLines.map(line => `  ${line}`));
            }

            const currentRules = sanitizeWorldRuleUpdateForPolicy(getCurrentRules(), collectWorldRuleEvidenceText(getCurrentRules()));
            // 위치별 규칙 — 활성 위치마다 유효 규칙을 따로 낸다(1곳이면 종전과 동일).
            const ruleScopes = multiLocation
                ? activeNodeIdsForPrompt.map(id => ({ id, name: String(profile.nodes.get(id)?.name || '').trim() }))
                : [{ id: currentNodeId, name: '' }];
            for (const scope of ruleScopes) {
                // TDZ 주의: 여기서 바깥 currentRules 를 참조하면(삼항식이라도) 같은 이름의
                // const 를 아래에서 선언하므로 'Cannot access before initialization' 이 난다.
                // 루프 안에서는 scopeRules 하나만 쓴다.
                const scopeRules = multiLocation
                    ? sanitizeWorldRuleUpdateForPolicy(getEffectiveRules(scope.id), collectWorldRuleEvidenceText(getEffectiveRules(scope.id)))
                    : sanitizeWorldRuleUpdateForPolicy(getCurrentRules(), collectWorldRuleEvidenceText(getCurrentRules()));
                if (!scopeRules) continue;
                parts.push(multiLocation
                    ? `\n[위치: ${scope.name} / Location: ${scope.name}]\n  (이 위치에서 유효한 규칙 / Rules in effect here)`
                    : '\n[현재 세계 규칙 / Current World Rules]');
                const currentRules = scopeRules;
                const exists = currentRules.exists || {};
                const existingElements = [];
                if (shouldEmitWorldPresentRule(currentRules, 'magic')) existingElements.push('마법/Magic');
                if (shouldEmitWorldPresentRule(currentRules, 'ki')) existingElements.push('기(氣)/Ki');
                if (shouldEmitWorldPresentRule(currentRules, 'supernatural')) existingElements.push('초자연/Supernatural');
                existingElements.push(...compactWorldList(exists.mythical_creatures, 8));
                existingElements.push(...compactWorldList(exists.non_human_races, 8));
                if (existingElements.length > 0) parts.push(`  존재/Exists: ${existingElements.join(', ')}`);

                const absentElements = [];
                if (shouldEmitWorldAbsentRule(currentRules, 'magic')) absentElements.push('마법 없음/No magic');
                if (shouldEmitWorldAbsentRule(currentRules, 'ki')) absentElements.push('기 없음/No ki');
                if (shouldEmitWorldAbsentRule(currentRules, 'supernatural')) absentElements.push('초자연 없음/No supernatural');
                if (absentElements.length > 0) parts.push(`  부재/Absent: ${absentElements.join(', ')}`);

                const systems = currentRules.systems || {};
                const activeSystems = [];
                if (systems.leveling) activeSystems.push('레벨/Level');
                if (systems.skills) activeSystems.push('스킬/Skill');
                if (systems.stats) activeSystems.push('스탯/Stats');
                if (systems.classes) activeSystems.push('직업/Class');
                if (systems.guilds) activeSystems.push('길드/Guild');
                if (systems.factions) activeSystems.push('세력/Faction');
                if (activeSystems.length > 0) parts.push(`  시스템/Systems: ${activeSystems.join(', ')}`);

                const inactiveSystems = [];
                if (shouldEmitWorldInactiveSystem(currentRules, 'leveling')) inactiveSystems.push('레벨/Level');
                if (shouldEmitWorldInactiveSystem(currentRules, 'skills')) inactiveSystems.push('스킬/Skill');
                if (shouldEmitWorldInactiveSystem(currentRules, 'stats')) inactiveSystems.push('스탯/Stats');
                if (shouldEmitWorldInactiveSystem(currentRules, 'classes')) inactiveSystems.push('직업/Class');
                if (inactiveSystems.length > 0) parts.push(`  비활성 시스템/Inactive Systems: ${inactiveSystems.join(', ')}`);

                if (exists.technology) {
                    parts.push(`  기술/Technology: ${exists.technology}`);
                }
                const setting = normalizeWorldSettingRules(currentRules.setting);
                if (setting.places.length > 0) {
                    parts.push(`  장소·시설/Places: ${setting.places.join(', ')}`);
                }
                if (setting.organizations.length > 0) {
                    parts.push(`  조직/Organizations: ${setting.organizations.join(', ')}`);
                }
                if (setting.socialRules.length > 0) {
                    parts.push('  사회·문화 규칙/Social Rules:');
                    parts.push(...setting.socialRules.slice(0, 10).map(rule => `    - ${rule}`));
                }
                const physics = currentRules.physics || {};
                if (!isDefaultWorldGravity(physics.gravity) && physics.gravity) {
                    parts.push(`  중력/Gravity: ${physics.gravity}`);
                }
                if (!isDefaultWorldTimeFlow(physics.time_flow || physics.timeFlow) && (physics.time_flow || physics.timeFlow)) {
                    parts.push(`  시간 흐름/Time Flow: ${physics.time_flow || physics.timeFlow}`);
                }
                if (!isDefaultWorldSpace(physics.space) && physics.space) {
                    parts.push(`  공간/Space: ${physics.space}`);
                }
                if (physics.dimensionStability) {
                    parts.push(`  차원 안정성/Dimension Stability: ${physics.dimensionStability}`);
                }
                const phenomena = compactWorldList(physics.special_phenomena, 8);
                if (phenomena.length > 0) {
                    parts.push(`  현상/Phenomena: ${phenomena.join(', ')}`);
                }
                const customRules = compactCustomRules(currentRules.custom, 10);
                // ★ 세계 규칙도 리롤·롤백을 탄다 (§5-6). 승격 출처 턴이 물러난 규칙은 프롬프트에서 뺀다.
                //   `rule_N` 접두는 정화기가 재부여하므로 **본문 텍스트**로 턴을 찾는다.
                const ruleTurns = promotedRuleTurns();
                const ruleFilter = applyRuleWorldlineFilter(
                    customRules.map(rule => String(rule).replace(/^rule_\d+:\s*/i, '').trim()),
                    options.worldlineState || null,
                    ruleTurns
                );
                if (ruleFilter.rules.length > 0) {
                    parts.push('  추가 규칙/Custom Rules:');
                    parts.push(...ruleFilter.rules.map(rule => `    - ${rule}`));
                }
            }   // ← 위치별 반복 종료

            if (currentNode?.connections?.length > 0) {
                const connections = compactWorldList(currentNode.connections.map(item => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item === 'object') return item.name || item.id || item.target || JSON.stringify(item);
                    return '';
                }), 6);
                if (connections.length > 0) {
                    parts.push('\n[세계 연결 / World Connections]');
                    parts.push(`  ${connections.join(', ')}`);
                }
            }

            if (profile.interference.level > 0.5) {
                parts.push('\n⚠️ 차원 간섭도 높음 - 세계 간 영향 가능 / High dimensional interference - cross-world effects possible');
            }

            const meaningfulLines = parts
                .map(line => String(line || '').trim())
                .filter(line => line
                    && !/^【세계관 구조\s*\/\s*World Structure】$/i.test(line)
                    && !/^\[(현재 위치\s*\/\s*Current Location|세계관 코덱스\s*\/\s*World Codex|현재 세계 규칙\s*\/\s*Current World Rules|세계 연결\s*\/\s*World Connections)\]$/i.test(line)
                    && !/^주요 세계\s*←\s*현재\/Current$/i.test(line));
            if (meaningfulLines.length === 0) return '';
            return parts.join('\n');
        };
        // 게이트·호출부가 **실행할 수 있는 자리**에 worldline 인식 판정을 노출한다.
        const formatForPromptWithWorldline = (worldlineState = null) =>
            formatForPrompt({ worldlineState: worldlineState || null });

        const withTemporaryState = callback => {
            const previous = profile;
            try {
                profile = previous ? { ...safeClone(previous), nodes: new Map([...previous.nodes].map(([id, node]) => [id, safeClone(node)])) } : null;
                const result = callback();
                if (result && typeof result.then === 'function') throw new Error('management_prepare_must_be_synchronous');
                return result;
            } finally { profile = previous; }
        };
        // Stable extension versions belong to the existing canonical graph owner.
        // Historical versions are provenance, never a second active authority.
        const readExtensionGraph = (lorebook, allowEmpty = false) => {
            const rows = LibraLoreConsolidator.unpackRawFromLore(lorebook).filter(row => row?.comment === WORLD_GRAPH_COMMENT);
            if (!rows.length && allowEmpty) {
                const root = createDefaultRootNode();
                return { schema: 'libra.world.graph.compact.v2', version: '6.1', rootId: root.id,
                    nodes: [[root.id, root]], activePath: [root.id], activeNodes: [root.id], meta: {} };
            }
            if (rows.length !== 1) return null;
            let graph; try { graph = JSON.parse(rows[0].content); } catch (_) { return null; }
            if (graph?.schema !== 'libra.world.graph.compact.v2' || !Array.isArray(graph.nodes)) return null;
            const seen = new Set();
            for (const pair of graph.nodes) {
                if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] || seen.has(pair[0]) || pair[1]?.id !== pair[0]) return null;
                seen.add(pair[0]);
            }
            return graph;
        };
        const extensionRuleVersion = (nodeId, ruleId, ordinal, text) => SemanticRecallIndex.sourceHash(JSON.stringify({ nodeId, ruleId, ordinal, text }));
        const listSavedCustomRuleReferences = (lorebook = []) => {
            const graph = readExtensionGraph(lorebook); if (!graph) return [];
            const result = [];
            for (const [nodeId, node] of graph.nodes) {
                const custom = node.rules?.custom;
                if (!custom || typeof custom !== 'object' || Array.isArray(custom)) continue;
                const stableBodies = new Set();
                for (const [ruleId, record] of Object.entries(node.meta?.extensionRules || {})) {
                    const version = record?.versions?.find(v => v.version === record.currentVersion);
                    if (!version || version.version !== extensionRuleVersion(nodeId, ruleId, version.ordinal, version.text)) continue;
                    if (Object.values(custom).filter(body => body === version.text).length !== 1) continue;
                    stableBodies.add(version.text);
                    result.push({ nodeId, ruleId, version: version.version, text: version.text,
                        label: `${node.name || nodeId} · ${version.text}`, origin: record.origin,
                        bundleId: record.bundleId, itemId: record.itemId });
                }
                for (const [ruleId, value] of Object.entries(custom)) {
                    if (!ruleId || typeof value !== 'string' || !value.trim() || stableBodies.has(value)) continue;
                    result.push({ nodeId, ruleId,
                        version: SemanticRecallIndex.sourceHash(JSON.stringify({ nodeId, ruleId, value, updated: node.meta?.updated || 0 })),
                        text: value, label: `${node.name || nodeId} · ${value}` });
                }
            }
            return result;
        };
        const extensionRuleDestination = (lorebook, nodeId = '') => {
            const graph = readExtensionGraph(lorebook, true); if (!graph) return null;
            const selected = nodeId || (graph.activePath?.length ? graph.activePath[graph.activePath.length - 1] : graph.rootId);
            return graph.nodes.find(([id]) => id === selected)?.[1] || null;
        };
        const adoptCommittedExtensionRule = (lorebook, plan, context = {}) => WmExtensionHistory.run((function* () {
            const source = IntegratedAnalysisJournal.readCommittedSource(context.committedSourceToken);
            if (!source || !(yield IntegratedAnalysisJournal.verifyCommittedSource(context.committedSourceToken, lorebook, context.scopeKey))
                || !source.evidence.some(row => row.id.startsWith('world.rules.') && row.text === plan.text)) return null;
            const graph = readExtensionGraph(lorebook), node = graph?.nodes.find(([id]) => id === plan.nodeId)?.[1];
            if (!node || Object.values(node.rules?.custom || {}).filter(text => text === plan.text).length !== 1) return null;
            const stable = listSavedCustomRuleReferences(lorebook).find(ref => ref.nodeId === node.id && ref.text === plan.text && ref.ruleId.startsWith('extension_rule_'));
            if (stable) return { itemId: plan.itemId, nodeId: stable.nodeId, ruleId: stable.ruleId, version: stable.version };
            if (!/^extension_rule_[a-f0-9]{64}$/.test(plan.ruleId || '') || node.meta?.extensionRules?.[plan.ruleId]) return null;
            node.meta ||= {}; node.meta.extensionRules ||= {};
            const version = extensionRuleVersion(node.id, plan.ruleId, 1, plan.text);
            node.meta.extensionRules[plan.ruleId] = { ruleId: plan.ruleId, bundleId: plan.bundleId, itemId: plan.itemId, origin: 'committed_canonical_integration',
                currentVersion: version, versions: [{ ordinal: 1, version, text: plan.text, scopeKey: context.scopeKey,
                    sourcePacketId: source.packetId, sourcePacketRevision: source.revision, turn: source.turn, at: Date.now() }] };
            const index = lorebook.findIndex(row => row?.comment === WORLD_GRAPH_COMMENT);
            if (index < 0) return null;
            lorebook[index] = { ...lorebook[index], content: JSON.stringify(graph) };
            return { itemId: plan.itemId, nodeId: node.id, ruleId: plan.ruleId, version };
        })());
        const publishExtensionRules = (lorebook, plans, context = {}) => {
            const read = context.ownerRead;
            if (context.approved !== true || !read?.ok || !LibraDataStorage.isVerifiedReadonlyEntries(read.entries)
                || LibraDataStorage.verifiedReadonlySourceBinding(read.entries)?.scopeKey !== context.ownerScope) throw Error('canonical_owner_confirmation_required');
            const graph = readExtensionGraph(lorebook, true); if (!graph) throw Error('canonical_graph_unavailable');
            const refs = [];
            for (const plan of plans) {
                const node = graph.nodes.find(([id]) => id === plan.nodeId)?.[1];
                if (!node || !/^extension_rule_[a-f0-9]{64}$/.test(plan.ruleId || '')) throw Error('canonical_rule_identity_changed');
                const lines = normalizeWorldCanonTextList(plan.text, 12);
                if (lines.length !== 1 || lines[0] !== plan.text) throw Error('canonical_rule_text_requires_review');
                node.rules ||= {}; node.meta ||= {}; node.meta.extensionRules ||= {};
                const custom = { ...(node.rules.custom || {}) }, existing = node.meta.extensionRules[plan.ruleId];
                if (existing) {
                    const current = existing.versions?.find(v => v.version === existing.currentVersion);
                    if (!current) throw Error('canonical_rule_version_unavailable');
                    const currentKeys = Object.keys(custom).filter(key => custom[key] === current.text);
                    if (currentKeys.length !== 1) throw Error('canonical_rule_changed');
                    if (current.text === plan.text) { refs.push({ itemId: plan.itemId, nodeId: node.id, ruleId: plan.ruleId, version: current.version }); continue; }
                    if (plan.expectedVersion !== current.version) throw Error('canonical_rule_revision_requires_review');
                    custom[currentKeys[0]] = plan.text;
                } else {
                    if (plan.expectedVersion) throw Error('canonical_rule_missing');
                    const same = listSavedCustomRuleReferences(lorebook).find(ref => ref.nodeId === node.id && ref.text === plan.text && ref.ruleId.startsWith('extension_rule_'));
                    if (same) { refs.push({ itemId: plan.itemId, nodeId: same.nodeId, ruleId: same.ruleId, version: same.version }); continue; }
                    if (!Object.values(custom).includes(plan.text)) custom[`extension_${plan.ruleId}`] = plan.text;
                }
                const rules = sanitizeWorldRuleUpdateForPolicy({ ...node.rules, custom }, plan.text);
                if (Object.values(rules.custom || {}).filter(text => text === plan.text).length !== 1) throw Error('canonical_rule_normalization_changed');
                const ordinal = existing ? existing.versions.length + 1 : 1;
                const version = extensionRuleVersion(node.id, plan.ruleId, ordinal, plan.text);
                node.rules = rules;
                node.meta.extensionRules[plan.ruleId] = { ...(existing || { ruleId: plan.ruleId, bundleId: plan.bundleId, itemId: plan.itemId, origin: plan.origin }),
                    currentVersion: version, versions: [...(existing?.versions || []), { ordinal, version, text: plan.text,
                        sourceRequest: plan.request, approval: 'explicit_preview_apply', scopeKey: context.scopeKey, turn: plan.turn, at: Date.now() }] };
                refs.push({ itemId: plan.itemId, nodeId: node.id, ruleId: plan.ruleId, version });
            }
            const entry = { key: LibraLoreKeys?.worldGraph ? LibraLoreKeys.worldGraph() : 'lmai_world_graph::compact', comment: WORLD_GRAPH_COMMENT,
                content: JSON.stringify(graph), mode: 'normal', insertorder: 6, alwaysActive: false };
            const index = lorebook.findIndex(row => row?.comment === WORLD_GRAPH_COMMENT);
            if (index >= 0) lorebook[index] = entry; else lorebook.push(entry);
            return refs;
        };
        return {
            loadWorldGraph, listSavedCustomRuleReferences, extensionRuleDestination, publishExtensionRules, adoptCommittedExtensionRule,
            withTemporaryState,
            getCurrentRules,
            getEffectiveRules,
            changeActivePath,
            popActivePath,
            createNode,
            updateNode,
            saveWorldGraph,
            saveWorldGraphUnsafe: _saveWorldGraphUnsafe,
            formatForPrompt,
            formatForPromptWithWorldline,
            applyRuleWorldlineFilter,
            promotedRuleTurns,
            getCurrentNode,
            getUserWorldCorrection,
            formatUserWorldCorrectionForPrompt,
            getProfile: () => profile,
            resetState: () => { profile = null; },
            getActivePath: () => profile?.activePath || [],
            getActiveNodes,
            setActiveNodes,
            addActiveNode,
            removeActiveNode,
            findNodeByName,
            removeWorldRuleByText,
            resolveEntityWorldName,
            WORLD_TEMPLATES
        };
    })();
    // ── 승격 브리지 (개편 마무리) ──
    // 기억을 세계 규칙으로 올리고(승격) 되돌린다(강등). **사용자 조작 경로 전용** —
    // 자동 승격은 금지다(5.2.8 오작동의 형태). 턴 처리·유지보수에서 이 함수를 부르지 않는다.
    //
    // 회상 제외는 **기존 수단을 재사용**한다: meta.provenanceStatus='retracted' →
    // hbm.rollbackState='candidate_deleted' → 10i 회상 필터가 후보에서 제외. 새 축을 만들지 않는다.
    const WorldPromotionBridge = (() => {
        const normalizePromotedText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

        const promote = (options = {}) => {
            const nodeId = String(options.nodeId || '').trim();
            const text = normalizePromotedText(options.text);
            const memoryMeta = (options.memoryMeta && typeof options.memoryMeta === 'object') ? { ...options.memoryMeta } : {};
            // ★ 출처 턴을 기록한다 — 규칙 본문에는 도장이 없어서, 이게 없으면 그 턴이
            //   리롤·롤백돼도 규칙이 영원히 남는다(기억·RP-LTM·엔티티는 이미 걸러진다).
            //   ★ 키(`rule_N`)가 아니라 **텍스트**로 매핑한다: `sanitizeWorldRuleUpdateForPolicy`
            //   가 custom 키를 재부여하므로(01a:352-356) 키는 안정적이지 않다.
            //   demote 가 `removeWorldRuleByText` 를 쓰는 것과 같은 이유다.
            const sourceTurn = Number(
                memoryMeta.turn || memoryMeta.t || memoryMeta.finalizedTurn
                || memoryMeta.turnAnchorTurn || memoryMeta.sourceTurn || 0
            ) || 0;
            // 실패 시 기억을 회상에서 빼지 않는다(원자성) — 먼저 검증한다.
            if (!nodeId || !text) return { ok: false, reason: 'invalid_input', memoryMeta, locator: null };
            const profile = HierarchicalWorldManager.getProfile?.();
            const node = profile?.nodes instanceof Map ? profile.nodes.get(nodeId) : null;
            if (!node) return { ok: false, reason: 'node_not_found', memoryMeta, locator: null };
            try {
                const nodeName = String(node.name || '').trim();
                if (!nodeName) return { ok: false, reason: 'node_unnamed', memoryMeta, locator: null };
                const current = node.rules && typeof node.rules === 'object' ? node.rules : {};
                const custom = current.custom && typeof current.custom === 'object' && !Array.isArray(current.custom) ? current.custom : {};
                const already = Object.values(custom)
                    .flatMap(value => Array.isArray(value) ? value : [value])
                    .some(value => normalizePromotedText(value) === text);
                if (!already) {
                    const nextKey = `rule_${Object.keys(custom).length + 1}`;
                    HierarchicalWorldManager.updateNode(nodeId, { rules: { custom: { [nextKey]: text } } });
                }
                // 강등이 찾을 수 있게 **내용**을 기록한다(키는 GUI 저장이 재부여한다).
                const locator = { nodeId, nodeName, text };
                // ★ 출처 턴을 노드에 남긴다 (텍스트 → 턴). `ruleMeta` 는 정화기가 **보존**한다(01a:391).
                if (sourceTurn) {
                    try {
                        const existingMeta = (node.rules && typeof node.rules === 'object' && node.rules.ruleMeta
                            && typeof node.rules.ruleMeta === 'object') ? node.rules.ruleMeta : {};
                        const promotedRules = { ...(existingMeta.promotedRules && typeof existingMeta.promotedRules === 'object'
                            ? existingMeta.promotedRules : {}), [text]: sourceTurn };
                        HierarchicalWorldManager.updateNode(nodeId, { rules: { ruleMeta: { promotedRules } } });
                    } catch (_) {}
                }
                return {
                    ok: true,
                    locator,
                    alreadyThere: already,
                    memoryMeta: {
                        ...memoryMeta,
                        provenanceStatus: 'retracted',
                        promotedTo: locator,
                        promotedAt: Date.now()
                    }
                };
            } catch (error) {
                return { ok: false, reason: `promote_failed:${String(error?.message || error).slice(0, 80)}`, memoryMeta, locator: null };
            }
        };

        const demote = (options = {}) => {
            const memoryMeta = (options.memoryMeta && typeof options.memoryMeta === 'object') ? { ...options.memoryMeta } : {};
            const locator = (options.locator && typeof options.locator === 'object') ? options.locator : (memoryMeta.promotedTo || {});
            const nodeId = String(options.nodeId || locator.nodeId || '').trim();
            const text = normalizePromotedText(locator.text || options.text);
            try {
                const result = (nodeId && text && typeof HierarchicalWorldManager.removeWorldRuleByText === 'function')
                    ? HierarchicalWorldManager.removeWorldRuleByText(nodeId, text)
                    : { removed: 0, changed: false };
                delete memoryMeta.provenanceStatus;
                delete memoryMeta.promotedTo;
                delete memoryMeta.promotedAt;
                return { ok: true, removed: result.removed, memoryMeta };
            } catch (error) {
                // 제거에 실패하면 승격 표시를 남긴다(규칙이 아직 세계에 있으므로 일관).
                return { ok: false, reason: `demote_failed:${String(error?.message || error).slice(0, 80)}`, removed: 0, memoryMeta };
            }
        };

        return { promote, demote };
    })();
    if (typeof globalThis !== 'undefined') globalThis.WorldPromotionBridge = WorldPromotionBridge;

    // ══════════════════════════════════════════════════════════════
