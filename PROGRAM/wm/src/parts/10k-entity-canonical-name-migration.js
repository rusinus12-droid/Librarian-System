    const EntityCanonicalNameMigration = (() => {
        const SCHEMA = 'libra.entity_canonical_name_migration.v1';
        const MIN_AUTO_SCORE = 6;
        const MAX_SOURCE_CHARS = 480000;
        const MAX_CONVERSATION_EVIDENCE_CHARS = 240000;
        const GENERIC_NAME_TOKENS = new Set([
            'character', 'lorebook', 'description', 'personality', 'scenario', 'profile', 'identity', 'name', 'full', 'canonical',
            '캐릭터', '인물', '이름', '성명', '설명', '설정', '프로필', '학생', '선생님', '교사', '학교', '학원', '교실',
            '여자', '남자', '소녀', '소년', '친구', '동료', '그녀', '그는', '현재', '정보', '관계', '세계관', '사용자'
        ]);
        const normalizeText = (value = '') => String(value || '')
            .normalize('NFKC')
            .replace(/[“”"'`‘’()[\]{}]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const normalizeKey = (value = '') => normalizeText(value).toLocaleLowerCase().replace(/[·・._'’\-\s]+/g, '');
        const escapeRegExp = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hasStandaloneNameMention = (text = '', name = '') => {
            const raw = String(text || '');
            const parts = splitNameParts(name);
            if (!raw || !parts.length) return false;
            const namePattern = parts.map(escapeRegExp).join('[\\s·・._\-]+');
            const particle = '(?:에게서|으로는|에게는|에서는|께서는|으로도|에게|에서|으로|께서|까지|부터|처럼|보다|은|는|이|가|을|를|와|과|로|도|만|께|님|씨|から|まで|より|さん|さま|様|は|が|を|に|へ|と|で|の|も)';
            const boundary = '[^\\p{L}\\p{M}\\p{N}_]';
            return new RegExp(`(^|${boundary})${namePattern}(?=$|${boundary}|${particle}(?=$|${boundary}))`, 'iu').test(raw);
        };
        const collectConversationEvidence = (chat = null, options = {}) => {
            if (!chat || typeof chat !== 'object') return '';
            let messages = [];
            try {
                messages = typeof getChatMessages === 'function'
                    ? getChatMessages(chat)
                    : (chat.msgs || chat.messages || chat.message || chat.log || chat.mes || chat.chat || []);
            } catch (_) {
                messages = chat.msgs || chat.messages || chat.message || [];
            }
            const limit = Math.max(20, Math.min(320, Number(options.maxConversationMessages || 180) || 180));
            const chunks = [];
            let total = 0;
            for (const message of (Array.isArray(messages) ? messages : []).slice(-limit).reverse()) {
                let text = '';
                try { text = Utils.getMemorySourceText(Utils.getMessageText(message)); } catch (_) { text = String(message?.content || message?.text || message?.data || ''); }
                text = String(text || '').trim();
                if (!text) continue;
                const remaining = MAX_CONVERSATION_EVIDENCE_CHARS - total;
                if (remaining <= 0) break;
                chunks.push(text.slice(0, remaining));
                total += Math.min(text.length, remaining);
            }
            return chunks.reverse().join('\n');
        };
        const NARRATIVE_REFERENCE_FIELDS = new Set([
            'summary', 'text', 'description', 'brief', 'lastdistinctevent', 'scenesummary', 'event', 'snippet',
            'detail', 'details', 'note', 'notes', 'title', 'label', 'claim', 'delta', 'activity', 'reason', 'scene',
            'directive', 'activationcondition', 'resolutioncriteria', 'currentarc', 'narrativegoal', 'primarytension',
            'activetensions', 'openquestions', 'payoffcandidates', 'beatreason', 'nextbeats', 'donotresolveyet',
            'guardrails', 'relationstatesignals', 'environmentpressures', 'userintentalignment', 'scenemandate',
            'requiredoutcomes', 'forbiddenmoves', 'emphasis', 'staginginstructions', 'dialogueinstructions',
            'pacinginstructions', 'continuitylocks', 'authorplaninputs', 'worldmanagerinputs', 'endingrequirement',
            'sourcebasis', 'instruction', 'prompt', 'currentvalue', 'currentsnapshot', 'scenarioBands', 'statussummary',
            'publiclayer', 'privatelayer', 'boundarystate', 'howmet', 'lastinteraction', 'currentconflict', 'baseline',
            'copingstyle', 'immediategoal', 'activeproblems', 'openthreads', 'unresolvedneeds', 'commitments',
            'nextactionhints', 'history', 'secrets', 'visibleState', 'inferredState'
        ].map(key => String(key).toLowerCase()));
        const replaceCanonicalNameInText = (value = '', oldName = '', newName = '') => {
            const original = String(value ?? '');
            const oldText = String(oldName || '').trim();
            const newText = String(newName || '').trim();
            if (!original || !oldText || !newText || normalizeKey(oldText) === normalizeKey(newText)) return original;
            const protectedValues = [];
            const protectedPrefix = '\uE000LIBRA_CANON_';
            const newPattern = escapeRegExp(newText).replace(/\\ /g, '\\s+');
            let next = original.replace(new RegExp(newPattern, 'giu'), match => {
                const index = protectedValues.push(match) - 1;
                return `${protectedPrefix}${index}\uE001`;
            });
            const oldPattern = escapeRegExp(oldText).replace(/\\ /g, '\\s+');
            const particle = '(?:에게서|으로는|에게는|에서는|께서는|으로도|에게|에서|으로|께서|까지|부터|처럼|보다|은|는|이|가|을|를|와|과|로|도|만|께|님|씨|から|まで|より|さん|さま|様|は|が|を|に|へ|と|で|の|も)';
            const boundary = '[^\\p{L}\\p{M}\\p{N}_]';
            next = next.replace(new RegExp(`(^|${boundary})(${oldPattern})(?=$|${boundary}|${particle}(?=$|${boundary}))`, 'giu'), (_match, prefix) => `${prefix}${newText}`);
            if (protectedValues.length) {
                next = next.replace(new RegExp(`${protectedPrefix}(\\d+)\\uE001`, 'gu'), (_match, index) => protectedValues[Number(index)] || '');
            }
            return next;
        };
        const rewriteNarrativeReferences = (root = null, oldName = '', newName = '') => {
            if (VersionedCanonicalBridge.mode === "authority" && !WmWriterRuntime.enabled) throw new Error("authority_upstream_writer_unsupported");
            let replacements = 0;
            const visit = (value, key = '') => {
                if (typeof value === 'string') {
                    if (!NARRATIVE_REFERENCE_FIELDS.has(String(key || '').toLowerCase())) return value;
                    const next = replaceCanonicalNameInText(value, oldName, newName);
                    if (next !== value) replacements += 1;
                    return next;
                }
                if (Array.isArray(value)) return value.map(item => visit(item, key));
                if (!value || typeof value !== 'object') return value;
                for (const [childKey, childValue] of Object.entries(value)) value[childKey] = visit(childValue, childKey);
                return value;
            };
            visit(root, '');
            return { changed: replacements > 0, replacements };
        };
        const stripKoreanParticle = (value = '') => {
            const raw = String(value || '').trim();
            if (!/^[가-힣]{2,10}$/.test(raw)) return raw;
            const particles = ['에게서', '으로는', '에게는', '에서는', '에게', '에서', '으로', '께서', '까지', '부터', '처럼', '보다', '의', '은', '는', '이', '가', '을', '를', '와', '과', '로', '도', '만', '께', '님', '씨'];
            for (const suffix of particles) {
                if (raw.endsWith(suffix) && raw.length - suffix.length >= 1) return raw.slice(0, -suffix.length);
            }
            return raw;
        };
        const splitNameParts = (value = '') => normalizeText(value)
            .split(/[\s·・]+/u)
            .map(part => stripKoreanParticle(part).replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}.'’\-]+$/gu, '').trim())
            .filter(Boolean);
        const normalizeCandidate = (value = '', partialName = '') => {
            const parts = splitNameParts(value);
            const partialParts = splitNameParts(partialName);
            if (parts.length < 2 || parts.length > 4 || partialParts.length !== 1) return '';
            const partialKey = normalizeKey(partialParts[0]);
            if (!partialKey || !parts.some(part => normalizeKey(part) === partialKey)) return '';
            if (parts.some(part => GENERIC_NAME_TOKENS.has(String(part || '').toLocaleLowerCase()))) return '';
            if (parts.some(part => /^\d+$/.test(part) || part.length > 32)) return '';
            const candidate = parts.join(' ');
            return candidate.length >= 3 && candidate.length <= 100 ? candidate : '';
        };
        const collectCandidateMentions = (value = '', partialName = '') => {
            const text = String(value || '');
            const partial = splitNameParts(partialName)[0] || '';
            if (!text || !partial) return [];
            const escaped = escapeRegExp(partial);
            const token = "[\\p{L}\\p{M}][\\p{L}\\p{M}.'’\\-]{0,31}";
            const candidates = new Set();
            const add = (candidate) => {
                const normalized = normalizeCandidate(candidate, partial);
                if (normalized) candidates.add(normalized);
            };
            for (const pattern of [
                new RegExp(`(${escaped})\\s+(${token})`, 'giu'),
                new RegExp(`(${token})\\s+(${escaped})`, 'giu')
            ]) {
                let match;
                let guard = 0;
                while ((match = pattern.exec(text)) && guard++ < 80) add(`${match[1]} ${match[2]}`);
            }
            return [...candidates];
        };
        const collectDeclaredNameCandidates = (value = '', partialName = '') => {
            const text = String(value || '');
            const candidates = new Set();
            const pattern = /(?:canonical[_ -]?name|full[_ -]?name|display[_ -]?name|name|이름|성명)\s*[:=]\s*["'“”‘’]?([^\n,;|}\]]{2,120})/giu;
            let match;
            let guard = 0;
            while ((match = pattern.exec(text)) && guard++ < 40) {
                const candidate = normalizeCandidate(match[1], partialName);
                if (candidate) candidates.add(candidate);
            }
            return [...candidates];
        };
        const hasExplicitNameField = (text = '', candidate = '') => {
            if (!text || !candidate) return false;
            const escaped = escapeRegExp(candidate).replace(/\\ /g, '\\s+');
            return new RegExp(`(?:canonical[_ -]?name|full[_ -]?name|display[_ -]?name|name|이름|성명)\\s*[:=]\\s*["'\\s]*${escaped}(?=$|["',;|}\\]])`, 'iu').test(String(text || ''));
        };
        const collectEntityAliases = (entity = {}) => dedupeTextArray([
            entity?.name,
            ...(Array.isArray(entity?.meta?.aliases) ? entity.meta.aliases : []),
            ...(Array.isArray(entity?.identity?.aliases) ? entity.identity.aliases : [])
        ].map(item => normalizeText(item)).filter(Boolean));
        const hasAliasCoverage = (entity = {}, candidate = '', partialName = '') => {
            const partialKey = normalizeKey(partialName);
            const otherParts = splitNameParts(candidate).filter(part => normalizeKey(part) !== partialKey);
            if (!otherParts.length) return false;
            const aliasKeys = collectEntityAliases(entity).map(alias => normalizeKey(alias)).filter(Boolean);
            return otherParts.every(part => {
                const partKey = normalizeKey(part);
                return aliasKeys.some(alias => alias === partKey || alias.includes(partKey) || partKey.includes(alias));
            });
        };
        const buildManagedEvidenceText = (lore = []) => {
            const chunks = [];
            let total = 0;
            for (const entry of LibraLoreConsolidator.unpack(Array.isArray(lore) ? lore : [])) {
                if (!/^lmai_(?:memory|narrative|story_author|director|world_additional|user_dlc|character_state)/.test(String(entry?.comment || ''))) continue;
                const text = String(entry?.content || '');
                if (!text) continue;
                const remaining = MAX_SOURCE_CHARS - total;
                if (remaining <= 0) break;
                chunks.push(text.slice(0, remaining));
                total += Math.min(text.length, remaining);
            }
            return chunks.join('\n');
        };
        const isEligiblePartialEntity = (entity = {}, lore = []) => {
            const name = normalizeText(entity?.name || '');
            if (!name || splitNameParts(name).length !== 1) return false;
            if (entity?.meta?.nameManualLocked === true) return false;
            if (entity?.meta?.absorption?.status === 'pending' || entity?.meta?.absorption?.status === 'applied') return false;
            if (EntityManager.isBlockedEntityName?.(name, lore)) return false;
            if (normalizeKey(name) === normalizeKey('User') || normalizeKey(name) === normalizeKey('사용자')) return false;
            return true;
        };
        const normalizeCuePayload = (sourcePayload = {}) => {
            if (Array.isArray(sourcePayload)) return { cues: sourcePayload, sourceHash: '' };
            return {
                cues: Array.isArray(sourcePayload?.cues) ? sourcePayload.cues : [],
                sourceHash: String(sourcePayload?.sourceHash || '').trim()
            };
        };
        const plan = (lore = [], sourcePayload = {}, options = {}) => {
            const payload = normalizeCuePayload(sourcePayload);
            const cues = payload.cues.slice(0, 240);
            const managedEvidence = buildManagedEvidenceText(lore);
            const conversationEvidence = String(options.conversationEvidenceText || '').slice(-MAX_CONVERSATION_EVIDENCE_CHARS);
            const entities = Array.from(EntityManager.getEntityCache?.()?.values?.() || []);
            const plans = [];
            const rejected = [];
            for (const entity of entities) {
                if (!isEligiblePartialEntity(entity, lore)) continue;
                const oldName = normalizeText(entity.name || '');
                const candidates = new Map();
                const register = (candidateRaw, cue = {}, location = 'text') => {
                    const candidate = normalizeCandidate(candidateRaw, oldName);
                    if (!candidate || normalizeKey(candidate) === normalizeKey(oldName)) return;
                    const key = normalizeKey(candidate);
                    if (!key) return;
                    const row = candidates.get(key) || {
                        candidate,
                        occurrences: 0,
                        sources: new Set(),
                        labelEvidence: false,
                        explicitEvidence: false,
                        characterNameEvidence: false
                    };
                    row.occurrences += 1;
                    row.sources.add(`${cue.sourceType || 'source'}:${cue.sourceId || cue.id || cue.sourceLabel || ''}`);
                    const sourceLabel = String(cue.sourceLabel || cue.label || '');
                    const cueText = String(cue.text || cue.content || '');
                    if (location === 'label' || normalizeKey(sourceLabel).includes(key)) row.labelEvidence = true;
                    if (hasExplicitNameField(cueText, candidate)) row.explicitEvidence = true;
                    if (String(cue.sourceType || '').toLowerCase() === 'character_card' && String(cue.sourceId || '').toLowerCase() === 'name') row.characterNameEvidence = true;
                    candidates.set(key, row);
                };
                for (const cue of cues) {
                    const label = String(cue?.sourceLabel || cue?.label || '');
                    const text = String(cue?.text || cue?.content || '');
                    collectCandidateMentions(label, oldName).forEach(candidate => register(candidate, cue, 'label'));
                    collectCandidateMentions(text, oldName).forEach(candidate => register(candidate, cue, 'text'));
                    collectDeclaredNameCandidates(text, oldName).forEach(candidate => register(candidate, cue, 'declared_name'));
                }
                const scored = Array.from(candidates.values()).map(row => {
                    const aliasCoverage = hasAliasCoverage(entity, row.candidate, oldName);
                    const managedEvidenceFound = hasStandaloneNameMention(managedEvidence, row.candidate);
                    const conversationEvidenceFound = hasStandaloneNameMention(conversationEvidence, row.candidate);
                    const canonicalSourceEvidence = row.labelEvidence || row.explicitEvidence || row.characterNameEvidence;
                    const score = Math.min(2, row.occurrences)
                        + Math.min(3, row.sources.size)
                        + (row.labelEvidence ? 5 : 0)
                        + (row.explicitEvidence ? 5 : 0)
                        + (row.characterNameEvidence ? 6 : 0)
                        + (aliasCoverage ? 5 : 0)
                        + (managedEvidenceFound ? 3 : 0)
                        + (conversationEvidenceFound ? 3 : 0);
                    return {
                        candidate: row.candidate,
                        score,
                        aliasCoverage,
                        managedEvidence: managedEvidenceFound,
                        conversationEvidence: conversationEvidenceFound,
                        canonicalSourceEvidence,
                        labelEvidence: row.labelEvidence,
                        explicitEvidence: row.explicitEvidence,
                        characterNameEvidence: row.characterNameEvidence,
                        sourceCount: row.sources.size,
                        sources: [...row.sources].slice(0, 8)
                    };
                }).sort((a, b) => (b.score - a.score) || (b.sourceCount - a.sourceCount) || a.candidate.localeCompare(b.candidate));
                const top = scored[0];
                const second = scored[1];
                if (!top || top.score < Number(options.minScore || MIN_AUTO_SCORE)) {
                    if (scored.length) rejected.push({ oldName, reason: 'insufficient_evidence', candidates: scored.slice(0, 3) });
                    continue;
                }
                const uniqueLead = !second
                    || top.score - second.score >= 3
                    || (top.aliasCoverage && !second.aliasCoverage && top.score > second.score);
                if (!uniqueLead) {
                    rejected.push({ oldName, reason: 'ambiguous_candidates', candidates: scored.slice(0, 4) });
                    continue;
                }
                if (!top.canonicalSourceEvidence) {
                    rejected.push({ oldName, reason: 'missing_canonical_source_evidence', candidates: scored.slice(0, 3) });
                    continue;
                }
                if (!top.characterNameEvidence && !top.aliasCoverage && !top.managedEvidence && !top.conversationEvidence) {
                    rejected.push({ oldName, reason: 'uncorroborated_canonical_candidate', candidates: scored.slice(0, 3) });
                    continue;
                }
                const existingTarget = entities.find(candidate => normalizeKey(candidate?.name) === normalizeKey(top.candidate));
                if (existingTarget?.meta?.nameManualLocked === true && !top.aliasCoverage && !top.explicitEvidence && !top.labelEvidence) {
                    rejected.push({ oldName, reason: 'locked_target_without_identity_link', candidates: scored.slice(0, 3) });
                    continue;
                }
                plans.push({
                    schema: SCHEMA,
                    oldName,
                    newName: top.candidate,
                    score: top.score,
                    confidence: Math.min(0.99, 0.7 + top.score * 0.025),
                    sourceHash: payload.sourceHash,
                    evidence: {
                        aliasCoverage: top.aliasCoverage,
                        managedEvidence: top.managedEvidence,
                        conversationEvidence: top.conversationEvidence,
                        canonicalSourceEvidence: top.canonicalSourceEvidence,
                        labelEvidence: top.labelEvidence,
                        explicitEvidence: top.explicitEvidence,
                        characterNameEvidence: top.characterNameEvidence,
                        sources: top.sources
                    },
                    sourceCreatedTurn: Number(entity?.meta?.created || 0) || 0,
                    sourceId: entity?.id
                });
            }
            const targetWinners = new Map();
            for (const item of plans) {
                const key = normalizeKey(item.newName);
                const current = targetWinners.get(key);
                if (!current || item.score > current.score || (item.score === current.score && item.sourceCreatedTurn < current.sourceCreatedTurn)) {
                    targetWinners.set(key, item);
                }
            }
            return { schema: SCHEMA, sourceHash: payload.sourceHash, plans, targetWinners: [...targetWinners.values()], rejected };
        };
        const propagateReferences = (lore = [], renameResult = {}, context = {}) => {
            if (VersionedCanonicalBridge.mode === "authority" && !WmWriterRuntime.enabled) throw new Error("authority_upstream_writer_unsupported");
            const oldName = String(renameResult.oldName || '').trim();
            const newName = String(renameResult.newName || '').trim();
            if (!oldName || !newName) return { changed: false };
            const previousNames = renameResult.previousNames || [oldName];
            const oldViewerId = SecretKnowledgeCore?.entityViewerId?.(oldName) || `entity:${oldName}`;
            const newViewerId = SecretKnowledgeCore?.entityViewerId?.(newName) || `entity:${newName}`;
            const renameContext = { oldName, newName, oldViewerId, newViewerId, previousNames, source: 'canonical_name_migration' };
            const results = {};
            try { results.secret = SecretKnowledgeCore?.renameEntityReferences?.(renameContext); } catch (_) {}
            try { results.vault = EntityKnowledgeVaultCore?.renameEntityViewer?.(renameContext); } catch (_) {}
            try { results.time = TimeEngine?.renameEntityAnchor?.(oldName, newName, { oldKey: oldName.toLowerCase(), newKey: newName.toLowerCase() }); } catch (_) {}
            try { results.narrative = NarrativeTracker?.renameEntityReferences?.(oldName, newName, renameContext); } catch (_) {}
            try { results.author = StoryAuthor?.renameEntityReferences?.(oldName, newName, renameContext); } catch (_) {}
            try { results.director = Director?.renameEntityReferences?.(oldName, newName, renameContext); } catch (_) {}
            try { results.worldAdditional = WorldAdditionalCore?.renameEntityReferences?.(oldName, newName, renameContext); } catch (_) {}
            try { results.userDlc = UserDlcCore?.renameEntityReferences?.(oldName, newName, renameContext); } catch (_) {}
            try { results.characterState = CharacterStateTracker?.renameEntityKey?.(oldName, newName, renameContext); } catch (_) {}
            const narrativeStateTargets = {
                entities: Array.from(EntityManager.getEntityCache?.()?.values?.() || []),
                relations: Array.from(EntityManager.getRelationCache?.()?.values?.() || []),
                secretKnowledge: SecretKnowledgeCore?.getState?.(),
                entityKnowledge: EntityKnowledgeVaultCore?.getState?.(),
                time: TimeEngine?.getState?.(),
                narrative: NarrativeTracker?.getState?.(),
                author: StoryAuthor?.getState?.(),
                director: Director?.getState?.(),
                worldAdditional: WorldAdditionalCore?.getState?.(),
                userDlc: UserDlcCore?.getState?.(),
                characterState: CharacterStateTracker?.getState?.(),
                worldState: WorldStateTracker?.getState?.()
            };
            for (const [label, state] of Object.entries(narrativeStateTargets)) {
                if (!state) continue;
                try { results[`${label}Narrative`] = rewriteNarrativeReferences(state, oldName, newName); } catch (_) {}
            }
            try {
                results.memory = MemoryEngine?.renameEntityReferencesInLore?.(lore, oldName, newName, {
                    ...renameContext,
                    scopeKey: context.scopeKey || MemoryState._activeScopeKey || '',
                    currentTurn: MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0,
                    rewriteAliases: false,
                    structuredOnly: false
                });
            } catch (_) {}
            try { results.rpContinuity = RPContinuityCore?.renameEntityReferences?.(lore, oldName, newName); } catch (_) {}
            return { changed: Object.values(results).some(result => result?.changed === true), results };
        };
        const applyPlans = (lore = [], migrationPlan = {}, options = {}) => {
            if (VersionedCanonicalBridge.mode === "authority" && !WmWriterRuntime.enabled) throw new Error("authority_upstream_writer_unsupported");
            const plans = Array.isArray(migrationPlan) ? migrationPlan : (migrationPlan?.plans || []);
            const applied = [];
            const skipped = [];
            const seenTargets = new Set();
            const ordered = plans.slice().sort((a, b) => (b.score - a.score) || (a.sourceCreatedTurn - b.sourceCreatedTurn));
            for (const item of ordered) {
                const targetKey = normalizeKey(item.newName);
                const targetBefore = EntityManager.getEntityCache?.().get(item.newName);
                const sourceBefore = EntityManager.getEntityCache?.().get(item.oldName);
                const preserveSourceId = !seenTargets.has(targetKey) && (!targetBefore
                    || Number(sourceBefore?.meta?.created || 0) <= Number(targetBefore?.meta?.created || Number.MAX_SAFE_INTEGER));
                const renameResult = EntityManager.renameEntity(item.oldName, item.newName, lore, {
                    source: 'canonical_name_migration',
                    keepOldNameAsAlias: true,
                    lockName: false,
                    preserveSourceId
                });
                if (!renameResult?.ok) {
                    skipped.push({ ...item, reason: renameResult?.reason || 'rename_failed' });
                    continue;
                }
                seenTargets.add(targetKey);
                const migratedEntity = renameResult.entity;
                migratedEntity.meta = migratedEntity.meta || {};
                migratedEntity.meta.canonicalNameMigration = {
                    schema: SCHEMA,
                    from: item.oldName,
                    to: item.newName,
                    score: item.score,
                    confidence: item.confidence,
                    sourceHash: item.sourceHash || '',
                    evidence: item.evidence || {},
                    appliedTurn: MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0,
                    appliedAt: Date.now()
                };
                migratedEntity.meta.source = 'canonical_name_migration';
                const propagation = options.propagate === false ? { changed: false, results: {} } : propagateReferences(lore, renameResult, options);
                applied.push({ ...renameResult, score: item.score, confidence: item.confidence, propagation, preserveSourceId });
            }
            return { schema: SCHEMA, changed: applied.length > 0, applied, skipped };
        };
        const saveMigratedState = async (lore = [], context = {}) => {
            if (VersionedCanonicalBridge.mode === "authority" && !WmWriterRuntime.enabled) throw new Error("authority_upstream_writer_unsupported");
            const char = context.char || null;
            const chat = context.chat || null;
            const scopeKey = context.scopeKey || getChatRuntimeScopeKey(chat, char);
            const chatId = String(context.chatId || chat?.id || '').trim();
            const lease = context.runtimeLease || RuntimeStateLease.capture(scopeKey);
            const steps = [
                () => EntityManager.saveToLorebook(char, chat, lore),
                () => SecretKnowledgeCore.saveState(lore, { scopeKey, chatId }),
                () => EntityKnowledgeVaultCore.saveState(lore, { scopeKey, chatId }),
                () => TimeEngine.saveState(lore, { scopeKey, chatId }),
                () => NarrativeTracker.saveState(lore), () => StoryAuthor.saveState(lore),
                () => Director.saveState(lore), () => WorldAdditionalCore.saveState(lore),
                () => UserDlcCore.saveState(lore), () => CharacterStateTracker.saveState(lore),
                () => WorldStateTracker.saveState(lore)
            ];
            for (const save of steps) {
                RuntimeStateLease.assertCurrent(lease);
                await save();
                RuntimeStateLease.assertCurrent(lease);
            }
            MemoryEngine.rebuildIndex(lore);
            if (context.persist === true) {
                const result = await persistLoreToActiveChat(chat, lore, { reason: 'entity-canonical-name-migration', runtimeLease: lease,expectedSource:context.expectedSource,operation:'migration' });
                RuntimeStateLease.assertCurrent(lease);
                if (!result?.ok) throw new Error('migration_persist_failed');
                return result;
            }
            return { ok: true, persisted: false };
        };
        const run = async (context = {}) => {
            if(WmWriterRuntime.enabled){const scope=LibraDataStorage.scopeKeyFor(context.char,context.chat);context={...context,expectedSource:context.expectedSource||WmWriterRuntime.latestSource(scope)};const fresh=await WmWriterRuntime.requireFresh(scope,context.expectedSource);if(!fresh.ok)throw Error(fresh.reason);}
            if (VersionedCanonicalBridge.mode === "authority" && !WmWriterRuntime.enabled) throw new Error("authority_upstream_writer_unsupported");
            const lease = context.runtimeLease || RuntimeStateLease.capture(context.scopeKey || getChatRuntimeScopeKey(context.chat, context.char));
            RuntimeStateLease.assertCurrent(lease);
            const lore = Array.isArray(context.lore) ? context.lore : [];
            if (!lore.length && !(EntityManager.getEntityCache?.()?.size > 0)) return { schema: SCHEMA, changed: false, applied: [], skipped: [], rejected: [] };
            try { UserDlcCore?.loadState?.(lore, { scopeKey: context.scopeKey || '', chatId: context.chatId || '' }); } catch (_) {}
            const knownEntityNames = Array.from(EntityManager.getEntityCache?.()?.keys?.() || []);
            const sourcePayload = context.sourcePayload || CharacterLoreCueIndex.buildPayload(context.char || null, context.chat || null, {
                knownEntityNames,
                maxCues: 160
            });
            const conversationEvidenceText = context.conversationEvidenceText || collectConversationEvidence(context.chat || null, context);
            const migrationPlan = plan(lore, sourcePayload, { ...context, conversationEvidenceText });
            if (!migrationPlan.plans.length) {
                return { ...migrationPlan, changed: false, applied: [], skipped: [] };
            }
            const result = applyPlans(lore, migrationPlan, { ...context, propagate: context.propagate !== false });
            let persistResult = { ok: true, persisted: false };
            if (result.changed && context.save !== false) persistResult = await saveMigratedState(lore, { ...context, runtimeLease: lease });
            return { ...migrationPlan, ...result, persistResult };
        };
        const api = Object.freeze({ SCHEMA, plan, applyPlans, propagateReferences, rewriteNarrativeReferences, collectConversationEvidence, saveMigratedState, run });
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_EntityCanonicalNameMigration = api;
        return api;
    })();
