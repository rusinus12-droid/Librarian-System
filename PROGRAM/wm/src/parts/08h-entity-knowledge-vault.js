    const EntityKnowledgeVaultCore = (() => {
        const COMMENT = 'lmai_entity_knowledge_vault';
        const VERSION = 3;
        const MAX_RECORDS_PER_ENTITY = 16;
        const MAX_ACTIVE_PROMPT_RECORDS = 6;
        const MEMORY_TYPES = new Set(['experienced', 'witnessed', 'heard', 'inferred', 'rumor', 'private_thought', 'public_fact']);
        const KNOWLEDGE_STATES = new Set(['known', 'suspected', 'uncertain', 'misunderstood', 'forgotten', 'hidden']);
        const PRIVACY_LEVELS = new Set(['public', 'shared', 'private', 'secret', 'internal']);
        const PRIVATE_THOUGHT_PATTERN = /(?:속으로|마음속으로|속마음|내심|말하지 않고|혼잣말처럼|생각했다|생각하며|생각한다|thought to (?:himself|herself|themself|itself)|internally|inwardly|kept .* to (?:himself|herself|themself)|without saying)/i;
        const RUMOR_PATTERN = /(?:소문|들었다|전해졌다|누가 그러던데|라고 들|라는 말을 들|rumou?r|heard that|they say|word is|it is said)/i;
        const MISUNDERSTOOD_PATTERN = /(?:오해|착각|잘못 알|misunderstood|mistook|wrongly believed|misread)/i;
        const SUSPICION_PATTERN = /(?:의심|수상|숨기고 있|무언가 숨|suspect|suspicious|doubt|seems to be hiding)/i;
        const makeEmptyState = (scopeKey = '', chatId = '') => ({
            version: VERSION,
            scopeKey: String(scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global',
            chatId: String(chatId || getActiveManagedChatId() || '').trim(),
            vaults: {}
        });
        let state = makeEmptyState();
        let activeLorebookRef = null;
        const compact = (value = '', max = 420) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            return text.length > max ? text.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : text;
        };
        const parseJsonObject = (text = '') => {
            try {
                const parsed = JSON.parse(String(text || '{}'));
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch {
                return {};
            }
        };
        const viewerIdForEntity = (name = '') => SecretKnowledgeCore.entityViewerId(name);
        const normalizeMemoryType = (value = '') => {
            const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            return MEMORY_TYPES.has(normalized) ? normalized : 'witnessed';
        };
        const normalizeKnowledgeState = (value = '') => {
            const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            return KNOWLEDGE_STATES.has(normalized) ? normalized : 'known';
        };
        const normalizePrivacy = (value = '') => {
            const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            return PRIVACY_LEVELS.has(normalized) ? normalized : 'private';
        };
        const normalizeEntityId = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return '';
            if (/^entity:/i.test(raw)) return viewerIdForEntity(raw.slice(raw.indexOf(':') + 1));
            return viewerIdForEntity(raw);
        };
        const normalizeEntityIdList = (values = [], limit = 16) => dedupeTextArray(
            (Array.isArray(values) ? values : String(values || '').split(/[,\s|;、，]+/u))
                .map(item => typeof item === 'string' ? item : item?.viewerId || item?.id || item?.name)
                .map(normalizeEntityId)
                .filter(Boolean)
        ).slice(0, Math.max(0, Number(limit || 16)));
        const normalizeLifecycleStatus = (value = '') => {
            const status = String(value || 'active').trim().toLowerCase().replace(/[\s-]+/g, '_');
            return ['active', 'deleted', 'superseded', 'shadowed', 'invalidated', 'archived'].includes(status) ? status : 'active';
        };
        const isLifecycleInactive = (value = '') => normalizeLifecycleStatus(value) !== 'active';
        const normalizeVaultRecord = (raw = {}, fallback = {}) => {
            const source = typeof raw === 'string' ? { text: raw } : (raw && typeof raw === 'object' ? raw : {});
            const ownerEntityId = normalizeEntityId(source.ownerEntityId || fallback.ownerEntityId || fallback.viewerId || '');
            const text = compact(source.text || source.content || source.body || source.summary || fallback.text || '', 360);
            const summary = compact(source.summary || text, 180);
            if (!text && !summary) return null;
            let memoryType = normalizeMemoryType(source.memoryType || fallback.memoryType || 'witnessed');
            let knowledgeState = normalizeKnowledgeState(source.knowledgeState || fallback.knowledgeState || 'known');
            let privacy = normalizePrivacy(source.privacy || fallback.privacy || 'private');
            if (memoryType === 'private_thought') privacy = 'internal';
            if (memoryType === 'public_fact') privacy = 'public';
            if (privacy === 'internal' && memoryType === 'witnessed') memoryType = 'private_thought';
            const visibleFallback = ownerEntityId ? [ownerEntityId] : [];
            const visibleToEntityIds = normalizeEntityIdList(source.visibleToEntityIds || source.visibleTo || fallback.visibleToEntityIds || visibleFallback, 12);
            const deniedToEntityIds = normalizeEntityIdList(source.deniedToEntityIds || source.deniedTo || fallback.deniedToEntityIds || [], 12);
            const uncertain = ['suspected', 'uncertain', 'misunderstood'].includes(knowledgeState);
            let canRevealAsFact = source.canRevealAsFact;
            if (canRevealAsFact == null) canRevealAsFact = ['public', 'shared'].includes(privacy);
            let requiresSuspicionLanguage = source.requiresSuspicionLanguage;
            if (requiresSuspicionLanguage == null) requiresSuspicionLanguage = uncertain;
            if (['private', 'secret', 'internal'].includes(privacy)) canRevealAsFact = false;
            if (uncertain) requiresSuspicionLanguage = true;
            const normalized = {
                id: String(source.id || TokenizerEngine.simpleHash([source.turn || fallback.turn || 0, ownerEntityId, text || summary, source.source || fallback.source || ''].join('|')) || '').trim(),
                turn: Math.max(0, Number(source.turn || fallback.turn || 0) || 0),
                at: Math.max(0, Number(source.at || fallback.at || Date.now()) || Date.now()),
                ownerEntityId,
                ownerEntityName: compact(source.ownerEntityName || fallback.ownerEntityName || '', 80),
                text,
                summary,
                memoryType,
                knowledgeState,
                privacy,
                source: compact(source.source || fallback.source || 'scene-observation', 80),
                evidence: compact(source.evidence || fallback.evidence || '', 140),
                visibleToEntityIds,
                deniedToEntityIds,
                confidence: Math.max(0, Math.min(1, Number(source.confidence ?? fallback.confidence ?? 0.7))),
                canUseInDialogue: source.canUseInDialogue !== false,
                canRevealAsFact: !!canRevealAsFact,
                requiresSuspicionLanguage: !!requiresSuspicionLanguage,
                status: normalizeLifecycleStatus(source.status || fallback.status || 'active')
            };
            if (!normalized.visibleToEntityIds.length && normalized.ownerEntityId) normalized.visibleToEntityIds = [normalized.ownerEntityId];
            return normalized;
        };
        const normalizeVault = (viewerId = '', raw = {}) => ({
            viewerId,
            entityName: compact(raw?.entityName || '', 80),
            schemaVersion: VERSION,
            records: (Array.isArray(raw?.records) ? raw.records : [])
                .map(record => normalizeVaultRecord(record, {
                    ownerEntityId: viewerId,
                    ownerEntityName: raw?.entityName || '',
                    currentTurn: MemoryEngine?.getCurrentTurn?.() || 0
                }))
                .filter(record => record && record.text)
                .slice(-MAX_RECORDS_PER_ENTITY)
        });
        const normalizeState = (raw = {}, scopeKey = '', chatId = '') => {
            const next = { ...makeEmptyState(scopeKey || raw?.scopeKey, chatId || raw?.chatId), ...(raw && typeof raw === 'object' ? raw : {}) };
            const vaults = {};
            for (const [viewerId, vault] of Object.entries(next.vaults || {})) {
                const key = String(viewerId || '').trim();
                if (!key) continue;
                vaults[key] = normalizeVault(key, vault);
            }
            next.version = VERSION;
            next.scopeKey = String(scopeKey || next.scopeKey || 'global').trim() || 'global';
            next.chatId = String(chatId || next.chatId || '').trim();
            next.vaults = vaults;
            return next;
        };
        const loadState = (lorebook = [], options = {}) => {
            activeLorebookRef = Array.isArray(lorebook) ? lorebook : null;
            const scopeKey = String(options?.scopeKey || options?.scopeId || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
            const chatId = String(options?.chatId || getActiveManagedChatId() || '').trim();
            const idx = findManagedScopedEntryIndex(lorebook, COMMENT, scopeKey);
            const entry = idx >= 0 ? lorebook[idx] : null;
            state = entry ? normalizeState(parseJsonObject(entry.content || '{}'), scopeKey, chatId) : makeEmptyState(scopeKey, chatId);
            return state;
        };
        const saveState = (lorebook = [], options = {}) => {
            if (!Array.isArray(lorebook)) return false;
            const scopeKey = String(options?.scopeKey || state.scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
            const chatId = String(options?.chatId || state.chatId || getActiveManagedChatId() || '').trim();
            state = normalizeState(state, scopeKey, chatId);
            const entry = {
                key: buildScopedManagedLoreKey(COMMENT, scopeKey),
                comment: COMMENT,
                content: JSON.stringify(state),
                mode: 'normal',
                insertorder: 7,
                alwaysActive: false
            };
            return upsertManagedScopedEntry(lorebook, COMMENT, entry, scopeKey) >= 0;
        };
        const canViewerAccessRecord = (record = {}, viewerId = '') => {
            const viewer = normalizeEntityId(viewerId);
            if (!viewer) return false;
            const normalized = normalizeVaultRecord(record, { ownerEntityId: record?.ownerEntityId || viewer });
            if (!normalized || isLifecycleInactive(normalized.status)) return false;
            if (normalized.deniedToEntityIds.includes(viewer)) return false;
            if (normalized.privacy === 'public') return true;
            if (normalized.privacy === 'shared') return normalized.visibleToEntityIds.includes(viewer);
            if (['private', 'secret', 'internal'].includes(normalized.privacy)) {
                if (normalized.visibleToEntityIds.includes(viewer)) return true;
                return !normalized.visibleToEntityIds.length && normalized.ownerEntityId === viewer;
            }
            return normalized.ownerEntityId === viewer;
        };
        const pruneRecords = (records = []) => (Array.isArray(records) ? records : [])
            .map(record => normalizeVaultRecord(record))
            .filter(Boolean)
            .sort((a, b) => Number(b.turn || 0) - Number(a.turn || 0) || Number(b.at || 0) - Number(a.at || 0))
            .slice(0, MAX_RECORDS_PER_ENTITY)
            .sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0) || Number(a.at || 0) - Number(b.at || 0));
        const recordObservation = (entityName = '', text = '', meta = {}) => {
            if (MemoryEngine?.CONFIG?.entityKnowledgeVaultEnabled === false) return false;
            const viewerId = viewerIdForEntity(entityName);
            const body = compact(text, 360);
            if (!viewerId || !body) return false;
            const vault = normalizeVault(viewerId, state.vaults?.[viewerId] || { viewerId, entityName, records: [] });
            vault.entityName = compact(entityName || vault.entityName || '', 80);
            const requestedPrivacy = normalizePrivacy(meta.privacy || (meta.memoryType === 'private_thought' ? 'internal' : 'private'));
            const sharedVisible = ['public', 'shared'].includes(requestedPrivacy)
                ? normalizeEntityIdList(meta.visibleToEntityIds || meta.visibleTo || [viewerId], 12)
                : [viewerId];
            const record = normalizeVaultRecord({
                turn: meta.turn || MemoryEngine.getCurrentTurn?.() || 0,
                ownerEntityId: viewerId,
                ownerEntityName: entityName,
                text: body,
                summary: meta.summary || '',
                memoryType: meta.memoryType,
                knowledgeState: meta.knowledgeState,
                privacy: requestedPrivacy,
                visibleToEntityIds: sharedVisible,
                deniedToEntityIds: meta.deniedToEntityIds,
                confidence: meta.confidence,
                canRevealAsFact: meta.canRevealAsFact,
                requiresSuspicionLanguage: meta.requiresSuspicionLanguage,
                source: meta.source || 'scene-observation',
                evidence: meta.evidence || '',
                at: Date.now()
            });
            if (!record) return false;
            if (vault.records.some(prev => prev.id === record.id || compact(prev.text, 360) === record.text)) return false;
            vault.records.push(record);
            vault.records = pruneRecords(vault.records);
            state.vaults = { ...(state.vaults || {}), [viewerId]: vault };
            return true;
        };
        const classifySubjectiveMemory = (name = '', text = '', names = []) => {
            const source = String(text || '');
            const ownerId = viewerIdForEntity(name);
            const participantIds = normalizeEntityIdList(names, 16);
            if (PRIVATE_THOUGHT_PATTERN.test(source)) {
                const nameHit = new RegExp(String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(source);
                return {
                    memoryType: nameHit ? 'private_thought' : 'inferred',
                    knowledgeState: nameHit ? 'known' : 'hidden',
                    privacy: nameHit ? 'internal' : 'secret',
                    visibleToEntityIds: nameHit ? [ownerId] : [],
                    deniedToEntityIds: participantIds.filter(id => id !== ownerId),
                    canRevealAsFact: false,
                    requiresSuspicionLanguage: !nameHit,
                    summary: nameHit ? compact(source, 180) : '',
                    skip: !nameHit
                };
            }
            if (RUMOR_PATTERN.test(source)) return { memoryType: 'rumor', knowledgeState: 'uncertain', privacy: 'private', visibleToEntityIds: [ownerId], canRevealAsFact: false, requiresSuspicionLanguage: true, summary: compact(source, 180) };
            if (MISUNDERSTOOD_PATTERN.test(source)) return { memoryType: 'inferred', knowledgeState: 'misunderstood', privacy: 'private', visibleToEntityIds: [ownerId], canRevealAsFact: false, requiresSuspicionLanguage: true, summary: compact(source, 180) };
            if (SUSPICION_PATTERN.test(source)) return { memoryType: 'inferred', knowledgeState: 'suspected', privacy: 'private', visibleToEntityIds: [ownerId], canRevealAsFact: false, requiresSuspicionLanguage: true, summary: compact(source, 180) };
            return { memoryType: 'experienced', knowledgeState: 'known', privacy: 'shared', visibleToEntityIds: participantIds.length ? participantIds : [ownerId], canRevealAsFact: true, requiresSuspicionLanguage: false, summary: compact(source, 180) };
        };
        const recordTurnForEntities = (entityNames = [], payload = {}, options = {}) => {
            const names = dedupeTextArray((Array.isArray(entityNames) ? entityNames : []).map(name => String(name || '').trim()).filter(Boolean)).slice(0, 12);
            const text = compact(payload.text || payload.summary || [payload.userText, payload.aiText].filter(Boolean).join('\n'), 520);
            if (!names.length || !text) return { changed: false, count: 0 };
            let changed = false;
            let count = 0;
            for (const name of names) {
                const profile = classifySubjectiveMemory(name, text, names);
                if (profile.skip) continue;
                const ok = recordObservation(name, profile.summary || text, {
                    turn: payload.turn || options.turn || MemoryEngine.getCurrentTurn?.() || 0,
                    memoryType: profile.memoryType,
                    knowledgeState: profile.knowledgeState,
                    privacy: profile.privacy,
                    visibleToEntityIds: profile.visibleToEntityIds,
                    deniedToEntityIds: profile.deniedToEntityIds,
                    canRevealAsFact: profile.canRevealAsFact,
                    requiresSuspicionLanguage: profile.requiresSuspicionLanguage,
                    source: options.source || payload.source || 'turn-pov',
                    confidence: options.confidence || 0.66
                });
                if (ok) {
                    changed = true;
                    count += 1;
                }
            }
            return { changed, count };
        };
        const getRecordsForEntity = (entityName = '', limit = 8) => {
            const viewerId = viewerIdForEntity(entityName);
            if (!viewerId) return [];
            const max = Math.max(1, Number(limit || 8));
            return (state.vaults?.[viewerId]?.records || [])
                .map(record => normalizeVaultRecord(record, { ownerEntityId: viewerId }))
                .filter(record => record && canViewerAccessRecord(record, viewerId))
                .sort((a, b) => Number(b.turn || 0) - Number(a.turn || 0) || Number(b.at || 0) - Number(a.at || 0))
                .slice(0, max);
        };
        const formatRecordForPrompt = (record = {}, viewerId = '') => {
            const normalized = normalizeVaultRecord(record, { ownerEntityId: viewerId });
            if (!normalized || !canViewerAccessRecord(normalized, viewerId)) return '';
            const base = SecretKnowledgeCore.redactForViewer(compact(normalized.summary || normalized.text, 260), viewerId);
            if (!base) return '';
            const suffixes = [];
            if (normalized.memoryType === 'private_thought' || normalized.privacy === 'internal') suffixes.push('내면 기억; 타인이 알 수 없음');
            if (normalized.knowledgeState === 'suspected') suffixes.push('의심으로만 표현; 확정하지 말 것');
            if (normalized.knowledgeState === 'uncertain') suffixes.push('불확실함; 추측으로만 표현');
            if (normalized.knowledgeState === 'misunderstood') suffixes.push('오해하고 있음; 객관 사실이 아닐 수 있음');
            if (normalized.knowledgeState === 'hidden') suffixes.push('알지만 숨김; 직접 드러내지 말 것');
            if (!normalized.canRevealAsFact && !suffixes.length) suffixes.push('확정 사실처럼 말하지 말 것');
            return `- ${normalized.turn ? `T${normalized.turn} ` : ''}${base}${suffixes.length ? ` (${suffixes.join('; ')})` : ''}`;
        };
        const buildPrompt = (entityName = '', options = {}) => {
            if (MemoryEngine?.CONFIG?.entityKnowledgeVaultEnabled === false) return '';
            const viewerId = viewerIdForEntity(entityName);
            if (!viewerId) return '';
            const records = getRecordsForEntity(entityName, Math.max(1, Math.min(MAX_ACTIVE_PROMPT_RECORDS, Number(options.limit || MAX_ACTIVE_PROMPT_RECORDS) || MAX_ACTIVE_PROMPT_RECORDS)));
            if (!records.length) return '';
            const lines = [`[Entity Knowledge Vault: ${compact(entityName, 80)}]`];
            records.map(record => formatRecordForPrompt(record, viewerId)).filter(Boolean).forEach(line => lines.push(line));
            lines.push(
                '',
                `Memory Limits: ${compact(entityName, 80)} must not know other entities' private_thought/internal/secret/hidden records, and must not state suspected/uncertain/misunderstood records as objective truth.`
            );
            return SecretKnowledgeCore.redactForViewer(lines.join('\n'), viewerId);
        };
        const buildBoundaryPrompt = (focusNames = []) => {
            if (MemoryEngine?.CONFIG?.entityKnowledgeVaultEnabled === false) return '';
            const names = dedupeTextArray((Array.isArray(focusNames) ? focusNames : [])
                .map(item => typeof item === 'string' ? item : item?.name)
                .map(item => compact(item, 80))
                .filter(Boolean)).slice(0, 8);
            if (!names.length) return '';
            const lines = [];
            for (const name of names) {
                lines.push(`- ${name}: use only ${name}'s own Entity Knowledge Vault, shared/public memory visible to ${name}, and facts ${name} directly witnessed or was explicitly told.`);
                lines.push(`- ${name} must not know other entities' private_thought, internal, secret, hidden, or denied records.`);
                lines.push(`- ${name} must express suspected, uncertain, or misunderstood records as suspicion, confusion, or mistaken belief, not objective truth.`);
            }
            lines.push('- If a fact exists in LIBRA memory but is not visible to a character, the character must not reveal it through dialogue, narration, body reaction, or decision.');
            return ['[Entity POV Memory Boundaries]', ...lines].join('\n');
        };
        const auditResponseKnowledgeBoundary = (text = '', options = {}) => {
            const source = String(text || '');
            if (!source || MemoryEngine?.CONFIG?.entityKnowledgeVaultEnabled === false) return { changed: false, text: source, violations: [], checked: false };
            const focusNames = dedupeTextArray((Array.isArray(options.focusNames) ? options.focusNames : [])
                .map(item => typeof item === 'string' ? item : item?.name)
                .map(item => compact(item, 80))
                .filter(Boolean)).slice(0, 12);
            if (!focusNames.length) return { changed: false, text: source, violations: [], checked: true };
            const protectedRecords = Object.values(state.vaults || {})
                .flatMap(vault => Array.isArray(vault?.records) ? vault.records : [])
                .map(record => normalizeVaultRecord(record))
                .filter(record => record && !isLifecycleInactive(record.status))
                .filter(record => record.memoryType === 'private_thought' || ['secret', 'internal'].includes(record.privacy) || record.knowledgeState === 'hidden')
                .slice(-120);
            if (!protectedRecords.length) return { changed: false, text: source, violations: [], checked: true };
            const replacement = String(options.replacement || '그 사실은 해당 인물의 지식 범위 밖에 머물렀다.').trim() || '그 사실은 해당 인물의 지식 범위 밖에 머물렀다.';
            let out = source;
            const violations = [];
            for (const sentence of String(out).split(/\n+/).flatMap(line => line.match(/[^.!?。！？]+[.!?。！？]?/gu) || [line]).map(v => v.trim()).filter(Boolean)) {
                const mentioned = focusNames.filter(name => sentence.toLowerCase().includes(String(name).toLowerCase()));
                if (!mentioned.length) continue;
                for (const record of protectedRecords) {
                    const recText = compact(record.text || record.summary || '', 900);
                    if (!recText || recText.length < 8 || !sentence.toLowerCase().replace(/\s+/g, '').includes(recText.toLowerCase().replace(/\s+/g, ''))) continue;
                    const unauthorized = mentioned.map(viewerIdForEntity).filter(viewerId => !canViewerAccessRecord(record, viewerId));
                    if (!unauthorized.length) continue;
                    out = out.replace(sentence, replacement);
                    violations.push({ recordId: record.id || '', ownerEntityId: record.ownerEntityId || '', unauthorized: unauthorized.slice(0, 6), privacy: record.privacy || '', knowledgeState: record.knowledgeState || '' });
                    break;
                }
                if (violations.length >= 4) break;
            }
            return { changed: out !== source, text: out, violations, checked: true };
        };
        const renameEntityViewer = (options = {}) => {
            const oldName = compact(options.oldName || '', 80);
            const newName = compact(options.newName || '', 80);
            const oldViewerId = String(options.oldViewerId || '').trim();
            const newViewerId = String(options.newViewerId || '').trim();
            if (!oldName || !newName || !oldViewerId || !newViewerId || oldViewerId === newViewerId) return { changed: false };
            const replaceViewer = (value = '') => String(value || '').trim() === oldViewerId ? newViewerId : String(value || '').trim();
            const rewriteRecord = (record = {}) => {
                const next = { ...record };
                next.ownerEntityId = replaceViewer(next.ownerEntityId || '');
                if (next.ownerEntityId === newViewerId && (!next.ownerEntityName || String(next.ownerEntityName || '').trim() === oldName)) {
                    next.ownerEntityName = newName;
                }
                next.visibleToEntityIds = dedupeTextArray((Array.isArray(next.visibleToEntityIds) ? next.visibleToEntityIds : []).map(replaceViewer).filter(Boolean)).slice(0, 24);
                next.deniedToEntityIds = dedupeTextArray((Array.isArray(next.deniedToEntityIds) ? next.deniedToEntityIds : []).map(replaceViewer).filter(Boolean)).slice(0, 24);
                return normalizeVaultRecord(next, { ownerEntityId: newViewerId, ownerEntityName: newName });
            };
            const vaults = state.vaults && typeof state.vaults === 'object' ? state.vaults : {};
            const oldVault = vaults[oldViewerId] || null;
            const newVault = vaults[newViewerId] || null;
            let changed = false;
            if (oldVault) {
                const mergedRecords = [
                    ...(Array.isArray(newVault?.records) ? newVault.records : []),
                    ...(Array.isArray(oldVault.records) ? oldVault.records : [])
                ].map(rewriteRecord).filter(Boolean);
                vaults[newViewerId] = normalizeVault(newViewerId, {
                    ...(newVault || {}),
                    viewerId: newViewerId,
                    entityName: newName,
                    records: pruneRecords(mergedRecords)
                });
                delete vaults[oldViewerId];
                changed = true;
            }
            for (const [viewerId, vault] of Object.entries(vaults)) {
                if (!vault || typeof vault !== 'object') continue;
                const records = Array.isArray(vault.records) ? vault.records : [];
                const nextRecords = records.map(rewriteRecord).filter(Boolean);
                if (JSON.stringify(nextRecords) !== JSON.stringify(records)) {
                    vaults[viewerId] = normalizeVault(viewerId, { ...vault, records: pruneRecords(nextRecords) });
                    changed = true;
                }
            }
            state.vaults = vaults;
            return { changed };
        };
        const getState = () => state;
        const resetState = (next = null) => {
            state = next && typeof next === 'object' ? normalizeState(safeClone(next), next.scopeKey, next.chatId) : makeEmptyState();
            return state;
        };
        const selfCheck = () => {
            const vaults = Object.values(state.vaults || {}).map((vault, index) => normalizeVault(Object.keys(state.vaults || {})[index] || vault?.viewerId || '', vault));
            const records = vaults.flatMap(vault => vault.records || []).filter(record => !isLifecycleInactive(record.status));
            return {
                ok: true,
                core: 'EntityKnowledgeVaultCore',
                comment: COMMENT,
                schemaVersion: VERSION,
                enabled: MemoryEngine?.CONFIG?.entityKnowledgeVaultEnabled !== false,
                vaults: vaults.length,
                records: records.length,
                privateRecords: records.filter(record => record.privacy === 'private').length,
                secretRecords: records.filter(record => record.privacy === 'secret').length,
                internalRecords: records.filter(record => record.privacy === 'internal' || record.memoryType === 'private_thought').length,
                scopeKey: state.scopeKey || ''
            };
        };
        return Object.freeze({
            COMMENT,
            VERSION,
            schemaVersion: VERSION,
            loadState,
            saveState,
            recordObservation,
            recordTurnForEntities,
            getRecordsForEntity,
            buildPrompt,
            buildBoundaryPrompt,
            auditResponseKnowledgeBoundary,
            renameEntityViewer,
            canViewerAccessRecord,
            formatRecordForPrompt,
            getState,
            resetState,
            selfCheck
        });
    })();

    const hasDeletedTurnTombstonesInLorebook = (lorebook = []) => {
        const entries = Array.isArray(lorebook) ? LibraLoreConsolidator.unpack(lorebook) : [];
        return entries.some(entry => {
            if (!entry || typeof entry !== 'object') return false;
            try {
                const parsed = JSON.parse(entry.content || '{}');
                return parsed?.deletedTurn === true
                    || parsed?.deleted === true
                    || String(parsed?.status || '').toLowerCase() === 'deleted'
                    || String(parsed?.mode || '').toLowerCase().includes('tombstone');
            } catch {
                return /deletedTurn|tombstone|rollback_deleted/i.test(String(entry?.content || ''));
            }
        });
    };
    const deriveMaxConfirmedMemoryTurnFromLorebook = (lorebook = []) => deriveMaxTurnFromLorebook(lorebook);

    const compactTimeFieldText = (value, max = 220) => {
        if (value == null) return '';
        const limit = Math.max(0, Number(max) || 0);
        let text = '';
        if (typeof value === 'string') text = value;
        else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
        else if (Array.isArray(value)) text = value.map(item => compactTimeFieldText(item, Math.max(16, Math.min(limit || 220, 120)))).filter(Boolean).join(' / ');
        else {
            try { text = JSON.stringify(value); }
            catch { text = String(value); }
        }
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!limit || normalized.length <= limit) return normalized;
        return normalized.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
    };
    const normalizeEntityTimeTracking = (tracking, entity = {}) => {
        const source = tracking && typeof tracking === 'object' ? tracking : {};
        const status = entity?.status && typeof entity.status === 'object' ? entity.status : {};
        return {
            currentDate: compactTimeFieldText(source.currentDate || status.currentDate || '', 80),
            currentTime: compactTimeFieldText(source.currentTime || status.currentTime || '', 40),
            lastInteractionDate: compactTimeFieldText(source.lastInteractionDate || source.relationAnchorDate || '', 80),
            lastInteractionTime: compactTimeFieldText(source.lastInteractionTime || '', 40),
            lastIntimacyDate: compactTimeFieldText(source.lastIntimacyDate || source.nsfwAnchorDate || '', 80),
            lastIntimacyTime: compactTimeFieldText(source.lastIntimacyTime || '', 40),
            cycleAnchorDate: compactTimeFieldText(source.cycleAnchorDate || source.lastCycleDate || '', 80),
            cycleAnchorTime: compactTimeFieldText(source.cycleAnchorTime || '', 40),
            notes: compactTimeFieldText(source.notes || source.memo || status.notes || '', 180)
        };
    };
    const stripEntityTimeTracking = (entity) => {
        if (!entity || typeof entity !== 'object') return entity;
        try {
            delete entity.timeTracking;
        } catch {
            entity.timeTracking = undefined;
        }
        return entity;
    };
