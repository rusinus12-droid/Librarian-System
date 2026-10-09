        const mergeEntityRecords = (baseEntity, incomingEntity) => {
            if (!baseEntity) return incomingEntity;
            if (!incomingEntity) return baseEntity;
            baseEntity.meta = baseEntity.meta || {};
            incomingEntity.meta = incomingEntity.meta || {};
            normalizeEntityV2Fields(baseEntity);
            normalizeEntityV2Fields(incomingEntity);
            const baseDisplayName = normalizeCanonicalDisplayName(baseEntity.name || '');
            const incomingDisplayName = normalizeCanonicalDisplayName(incomingEntity.name || '');
            const baseNameLocked = baseEntity.meta?.nameManualLocked === true;
            const incomingNameLocked = incomingEntity.meta?.nameManualLocked === true;
            const baseHasBilingual = !!extractBilingualNameParts(baseDisplayName);
            const incomingHasBilingual = !!extractBilingualNameParts(incomingDisplayName);
            if (baseNameLocked && baseDisplayName) {
                baseEntity.name = baseDisplayName;
            } else if (incomingNameLocked && incomingDisplayName) {
                baseEntity.name = incomingDisplayName;
            } else if ((!baseHasBilingual && incomingHasBilingual) || (!baseDisplayName && incomingDisplayName)) {
                baseEntity.name = incomingDisplayName;
            } else if (!baseHasBilingual && !incomingHasBilingual && baseDisplayName && incomingDisplayName) {
                // Synthesize bilingual name when merging Korean-only + English-only
                const isBaseKorean = /[가-힣]/.test(baseDisplayName) && !/[A-Za-z]/.test(baseDisplayName);
                const isIncomingKorean = /[가-힣]/.test(incomingDisplayName) && !/[A-Za-z]/.test(incomingDisplayName);
                const isBaseEnglish = /[A-Za-z]/.test(baseDisplayName) && !/[가-힣]/.test(baseDisplayName);
                const isIncomingEnglish = /[A-Za-z]/.test(incomingDisplayName) && !/[가-힣]/.test(incomingDisplayName);
                if (isBaseKorean && isIncomingEnglish) {
                    baseEntity.name = `${baseDisplayName}(${incomingDisplayName})`;
                } else if (isBaseEnglish && isIncomingKorean) {
                    baseEntity.name = `${incomingDisplayName}(${baseDisplayName})`;
                } else if (baseDisplayName) {
                    baseEntity.name = baseDisplayName;
                }
            } else if (baseDisplayName) {
                baseEntity.name = baseDisplayName;
            }
            const aliasSet = new Set([
                ...(Array.isArray(baseEntity.meta.aliases) ? baseEntity.meta.aliases : []),
                ...(Array.isArray(incomingEntity.meta.aliases) ? incomingEntity.meta.aliases : []),
                normalizeBaseName(baseEntity.name || ''),
                normalizeBaseName(incomingEntity.name || ''),
                normalizeCanonicalDisplayName(baseEntity.name || ''),
                normalizeCanonicalDisplayName(incomingEntity.name || '')
            ].filter(Boolean));
            baseEntity.meta.aliases = [...aliasSet];
            baseEntity.meta.nameManualLocked = baseNameLocked || incomingNameLocked || false;
            if (baseEntity.meta.nameManualLocked) {
                baseEntity.meta.nameManualLockedAt = Math.max(
                    normalizeFiniteNumber(baseEntity.meta.nameManualLockedAt, 0),
                    normalizeFiniteNumber(incomingEntity.meta.nameManualLockedAt, 0)
                ) || Date.now();
            }
            baseEntity.meta.nameHistory = normalizeEntityList([
                ...(Array.isArray(baseEntity.meta.nameHistory) ? baseEntity.meta.nameHistory : []),
                ...(Array.isArray(incomingEntity.meta.nameHistory) ? incomingEntity.meta.nameHistory : [])
            ], 24, 180);
            const hiddenNameKeySet = new Set([
                ...(Array.isArray(baseEntity.meta.hiddenNameKeys) ? baseEntity.meta.hiddenNameKeys : []),
                ...(Array.isArray(incomingEntity.meta.hiddenNameKeys) ? incomingEntity.meta.hiddenNameKeys : []),
                ...buildHiddenNameKeys(baseEntity.name || ''),
                ...buildHiddenNameKeys(incomingEntity.name || '')
            ].filter(Boolean));
            baseEntity.meta.hiddenNameKeys = [...hiddenNameKeySet];

            baseEntity.sex = normalizeBiologicalSex(baseEntity.sex || baseEntity.biologicalSex || '');
            incomingEntity.sex = normalizeBiologicalSex(incomingEntity.sex || incomingEntity.biologicalSex || '');
            if (!baseEntity.sex && incomingEntity.sex) baseEntity.sex = incomingEntity.sex;

            for (const key of ['features', 'distinctiveMarks', 'clothing']) {
                baseEntity.appearance = baseEntity.appearance || {};
                incomingEntity.appearance = incomingEntity.appearance || {};
                const merged = new Set([...(baseEntity.appearance[key] || []), ...(incomingEntity.appearance[key] || [])].filter(Boolean));
                baseEntity.appearance[key] = [...merged];
            }
            for (const key of ['traits', 'values', 'fears', 'likes', 'dislikes', 'sexualPreferences']) {
                baseEntity.personality = baseEntity.personality || {};
                incomingEntity.personality = incomingEntity.personality || {};
                const merged = [...(baseEntity.personality[key] || []), ...(incomingEntity.personality[key] || [])].filter(Boolean);
                baseEntity.personality[key] = key === 'traits'
                    ? normalizeEntityTraitList(merged, 18, 180)
                    : [...new Set(merged)];
            }
            if (!baseEntity.personality.sexualOrientation && incomingEntity.personality?.sexualOrientation) {
                baseEntity.personality.sexualOrientation = incomingEntity.personality.sexualOrientation;
            }
            baseEntity.speechStyle = baseEntity.speechStyle || { defaultTone: '', honorificStyle: '', toSuperiors: '', toSubordinates: '', toPeers: '', toYounger: '', notes: [] };
            incomingEntity.speechStyle = incomingEntity.speechStyle || {};
            for (const key of ['defaultTone', 'honorificStyle', 'toSuperiors', 'toSubordinates', 'toPeers', 'toYounger']) {
                if (!baseEntity.speechStyle[key] && incomingEntity.speechStyle?.[key]) {
                    baseEntity.speechStyle[key] = incomingEntity.speechStyle[key];
                }
            }
            baseEntity.speechStyle.notes = dedupeTextArray([
                ...(Array.isArray(baseEntity.speechStyle.notes) ? baseEntity.speechStyle.notes : []),
                ...(Array.isArray(incomingEntity.speechStyle?.notes) ? incomingEntity.speechStyle.notes : [])
            ].filter(Boolean));
            baseEntity.background = baseEntity.background || {};
            incomingEntity.background = incomingEntity.background || {};
            if (!baseEntity.background.origin && incomingEntity.background.origin) baseEntity.background.origin = incomingEntity.background.origin;
            if (!baseEntity.background.occupation && incomingEntity.background.occupation) baseEntity.background.occupation = incomingEntity.background.occupation;
            const mergedHistory = new Set([...(baseEntity.background.history || []), ...(incomingEntity.background.history || [])].filter(Boolean));
            baseEntity.background.history = [...mergedHistory];
            baseEntity.status = baseEntity.status || {};
            incomingEntity.status = incomingEntity.status || {};
            if (!baseEntity.status.currentLocation && incomingEntity.status.currentLocation) baseEntity.status.currentLocation = incomingEntity.status.currentLocation;
            if (!baseEntity.status.currentMood && incomingEntity.status.currentMood) baseEntity.status.currentMood = incomingEntity.status.currentMood;
            if (!baseEntity.status.healthStatus && incomingEntity.status.healthStatus) baseEntity.status.healthStatus = incomingEntity.status.healthStatus;
            baseEntity.status.notes = mergeLimitedStatusNotes(baseEntity.status.notes || '', incomingEntity.status.notes || '', 320, {
                entityName: baseEntity.name || incomingEntity.name || '',
                status: baseEntity.status
            });
            baseEntity.meta.created = Math.min(
                normalizeFiniteNumber(baseEntity.meta.created, Infinity),
                normalizeFiniteNumber(incomingEntity.meta.created, Infinity)
            );
            if (!Number.isFinite(baseEntity.meta.created)) baseEntity.meta.created = 0;
            baseEntity.meta.updated = Math.max(
                normalizeFiniteNumber(baseEntity.meta.updated, 0),
                normalizeFiniteNumber(incomingEntity.meta.updated, 0)
            );
            baseEntity.meta.confidence = Math.max(
                normalizeFiniteNumber(baseEntity.meta.confidence, 0),
                normalizeFiniteNumber(incomingEntity.meta.confidence, 0)
            );
            const baseSourceTurn = Math.max(0, Number(baseEntity.meta?.sourceTurn || baseEntity.currentState?.lastObservedTurn || baseEntity.status?.lastUpdated || 0) || 0);
            const incomingSourceTurn = Math.max(0, Number(incomingEntity.meta?.sourceTurn || incomingEntity.currentState?.lastObservedTurn || incomingEntity.status?.lastUpdated || 0) || 0);
            return mergeEntityV2Fields(baseEntity, incomingEntity, {
                sourceMode: incomingEntity.meta?.source || baseEntity.meta?.source || 'merge',
                currentTurn: incomingSourceTurn,
                allowVolatileState: baseSourceTurn <= 0 || incomingSourceTurn >= baseSourceTurn
            });
        };
        const getEntityDisplayNameScore = (entity) => {
            const displayName = normalizeCanonicalDisplayName(entity?.name || '');
            let score = Math.max(0, displayName.length);
            const nameParts = displayName.split(/[\s·・]+/u).filter(Boolean);
            if (entity?.meta?.nameManualLocked === true) score += 1000;
            if (extractBilingualNameParts(displayName)) score += 100;
            if (nameParts.length >= 2) score += 80;
            else if (/^[가-힣]{3,4}$/.test(normalizeBaseName(displayName))) score += 40;
            return score;
        };
        const normalizePersonalNamePartKey = (value = '') => String(value || '')
            .replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, '')
            .toLocaleLowerCase()
            .trim();
        const splitPersonalDisplayNameParts = (value = '') => normalizeCanonicalDisplayName(value || '')
            .split(/[\s·・]+/u)
            .map(normalizePersonalNamePartKey)
            .filter(Boolean);
        const collectRawEntityNamePartKeys = (entity = {}) => {
            const values = [
                entity?.name,
                ...(Array.isArray(entity?.meta?.aliases) ? entity.meta.aliases : []),
                ...(Array.isArray(entity?.identity?.aliases) ? entity.identity.aliases : [])
            ];
            const keys = new Set();
            for (const value of values) {
                for (const part of splitPersonalDisplayNameParts(value)) keys.add(part);
            }
            return keys;
        };
        const isConfirmedPartialNameOfFullEntity = (partialEntity = {}, fullEntity = {}) => {
            const partialNameParts = splitPersonalDisplayNameParts(partialEntity?.name || '');
            const fullNameParts = splitPersonalDisplayNameParts(fullEntity?.name || '');
            if (partialNameParts.length !== 1 || fullNameParts.length < 2 || fullNameParts.length > 4) return false;
            const partialKeys = collectRawEntityNamePartKeys(partialEntity);
            if (!fullNameParts.includes(partialNameParts[0])) return false;
            return fullNameParts.every(part => partialKeys.has(part));
        };
        const preferVerifiedIncomingFullName = (incomingName = '', resolvedName = '', lorebook = []) => {
            const incomingDisplay = normalizeCanonicalDisplayName(incomingName || '');
            const resolvedDisplay = normalizeCanonicalDisplayName(resolvedName || '');
            if (!incomingDisplay || !resolvedDisplay || incomingDisplay === resolvedDisplay) return resolvedDisplay || incomingDisplay;
            const incomingParts = splitPersonalDisplayNameParts(incomingDisplay);
            const resolvedParts = splitPersonalDisplayNameParts(resolvedDisplay);
            if (incomingParts.length < 2 || resolvedParts.length !== 1) return resolvedDisplay;
            let resolvedEntity = entityCache.get(resolvedDisplay) || null;
            if (!resolvedEntity) {
                resolvedEntity = collectKnownEntities(lorebook).find(entity =>
                    normalizeCanonicalDisplayName(entity?.name || '') === resolvedDisplay
                ) || null;
            }
            if (!resolvedEntity || resolvedEntity?.meta?.nameManualLocked === true) return resolvedDisplay;
            return isConfirmedPartialNameOfFullEntity(resolvedEntity, { name: incomingDisplay })
                ? incomingDisplay
                : resolvedDisplay;
        };
        const shouldForceMergeEntities = (entityA, entityB) => {
            if (!entityA || !entityB) return false;
            if (entityA?.meta?.nameManualLocked === true && entityB?.meta?.nameManualLocked === true) {
                const displayA = normalizeCanonicalDisplayName(entityA?.name || '');
                const displayB = normalizeCanonicalDisplayName(entityB?.name || '');
                if (displayA && displayB && displayA !== displayB) return false;
            }
            if (isConfirmedPartialNameOfFullEntity(entityA, entityB)
                || isConfirmedPartialNameOfFullEntity(entityB, entityA)) return true;
            const aliasesA = new Set(extractEntityAliases(entityA).map(alias => String(alias || '').trim().toLowerCase()).filter(Boolean));
            const aliasesB = new Set(extractEntityAliases(entityB).map(alias => String(alias || '').trim().toLowerCase()).filter(Boolean));
            const shared = [...aliasesA].filter(alias => aliasesB.has(alias));
            if (shared.some(alias => /^[가-힣]{3,4}$/.test(alias))) return true;
            if (shared.some(alias => alias.length >= 5)) return true;

            // Cross-script phonetic matching: Korean ↔ English
            const nameA = String(entityA?.name || '');
            const nameB = String(entityB?.name || '');
            const baseA = normalizeBaseName(nameA);
            const baseB = normalizeBaseName(nameB);
            const isKoreanA = /[가-힣]/.test(baseA);
            const isKoreanB = /[가-힣]/.test(baseB);

            if (isKoreanA !== isKoreanB) {
                const koreanName = isKoreanA ? baseA : baseB;
                const otherName = isKoreanA ? baseB : baseA;
                const romanizedFull = romanizeHangulText(koreanName);
                const otherIdentity = normalizeIdentityToken(otherName);
                if (romanizedFull && otherIdentity && romanizedFull === otherIdentity) return true;

                // Match individual English name parts against Korean short name
                const koreanShort = getKoreanShortName(koreanName);
                if (koreanShort) {
                    const romanizedShort = romanizeHangulText(koreanShort);
                    const otherParts = getEnglishOrJapaneseNameParts(otherName);
                    for (const part of otherParts) {
                        const partIdentity = normalizeIdentityToken(part);
                        if (partIdentity && romanizedShort && partIdentity === romanizedShort) return true;
                    }
                }

                // Match romanized full Korean name against English identity (prefix/suffix)
                if (romanizedFull && otherIdentity) {
                    const shorter = romanizedFull.length <= otherIdentity.length ? romanizedFull : otherIdentity;
                    const longer = romanizedFull.length <= otherIdentity.length ? otherIdentity : romanizedFull;
                    if (shorter.length >= 4 && longer.includes(shorter) && shorter.length >= longer.length * 0.6) return true;
                }
            }

            // Conservative phonetic matching: only allow exact cross-script phonetic identity.
            if (baseA && baseB) {
                const crossScript = (/[가-힣]/.test(baseA) && /[a-z]/i.test(baseB)) || (/[가-힣]/.test(baseB) && /[a-z]/i.test(baseA));
                if (crossScript && isPhoneticallySimilar(baseA, baseB)) return true;
            }

            return false;
        };
        const getEntityCollapseBucketKeys = (key = '', entity = {}) => {
            const keys = new Set();
            const addRaw = (raw = '') => {
                const base = normalizeBaseName(raw);
                if (base) keys.add(`base:${base}`);
                for (const alias of buildAliasCandidates(raw, true)) {
                    if (alias) keys.add(`alias:${alias}`);
                }
                for (const hidden of buildHiddenNameKeys(raw)) {
                    if (hidden) keys.add(`hidden:${hidden}`);
                }
                const shortKo = getKoreanShortName(raw);
                if (shortKo) keys.add(`ko_short:${shortKo}`);
                const identity = normalizeIdentityToken(raw);
                if (identity) keys.add(`identity:${identity}`);
            };
            addRaw(key);
            addRaw(entity?.name || '');
            for (const alias of Array.isArray(entity?.meta?.aliases) ? entity.meta.aliases : []) addRaw(alias);
            for (const hidden of Array.isArray(entity?.meta?.hiddenNameKeys) ? entity.meta.hiddenNameKeys : []) addRaw(hidden);
            return Array.from(keys).slice(0, 64);
        };

        const collapseClearlyDuplicateEntities = () => {
            let mergedAny = false;
            let changed = true;
            let safetyCounter = 0;
            const MAX_COLLAPSE_ITERATIONS = 80;
            const MAX_BUCKET_PAIR_CHECKS = 1600;
            while (changed && safetyCounter < MAX_COLLAPSE_ITERATIONS) {
                changed = false;
                safetyCounter++;
                const entries = Array.from(entityCache.entries());
                const buckets = new Map();
                for (const [key, entity] of entries) {
                    if (!entityCache.has(key)) continue;
                    if (!isPromptVisibleEntityRecord(entity)) continue;
                    for (const bucketKey of getEntityCollapseBucketKeys(key, entity)) {
                        if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
                        const bucket = buckets.get(bucketKey);
                        if (bucket.length < 80) bucket.push([key, entity]);
                    }
                }

                let pairChecks = 0;
                let mergePair = null;
                const orderedBuckets = Array.from(buckets.values()).sort((a, b) => a.length - b.length);
                for (const bucket of orderedBuckets) {
                    if (!Array.isArray(bucket) || bucket.length < 2) continue;
                    for (let i = 0; i < bucket.length; i++) {
                        const [keyA, entityA] = bucket[i];
                        if (!entityCache.has(keyA)) continue;
                        for (let j = i + 1; j < bucket.length; j++) {
                            const [keyB, entityB] = bucket[j];
                            if (keyA === keyB || !entityCache.has(keyB)) continue;
                            pairChecks += 1;
                            if (pairChecks > MAX_BUCKET_PAIR_CHECKS) break;
                            if (!isPromptVisibleEntityRecord(entityA) || !isPromptVisibleEntityRecord(entityB)) continue;
                            if (!shouldForceMergeEntities(entityA, entityB)) continue;
                            mergePair = { keyA, entityA, keyB, entityB };
                            break;
                        }
                        if (mergePair || pairChecks > MAX_BUCKET_PAIR_CHECKS) break;
                    }
                    if (mergePair || pairChecks > MAX_BUCKET_PAIR_CHECKS) break;
                }

                if (!mergePair) break;
                const { keyA, entityA, keyB, entityB } = mergePair;
                const preferA = getEntityDisplayNameScore(entityA) >= getEntityDisplayNameScore(entityB);
                const keepKey = preferA ? keyA : keyB;
                const dropKey = preferA ? keyB : keyA;
                const merged = mergeEntityRecords(
                    safeClone(preferA ? entityA : entityB),
                    safeClone(preferA ? entityB : entityA)
                );
                entityCache.set(keepKey, merged);
                entityCache.delete(dropKey);
                changed = true;
                mergedAny = true;
            }
            if (!mergedAny) return;
            const rebuiltRelations = new Map();
            for (const relation of relationCache.values()) {
                relation.entityA = resolveCanonicalName(relation.entityA || '');
                relation.entityB = resolveCanonicalName(relation.entityB || '');
                relation.id = makeRelationId(relation.entityA || '', relation.entityB || '');
                if (rebuiltRelations.has(relation.id)) {
                    rebuiltRelations.set(relation.id, mergeRelationRecords(rebuiltRelations.get(relation.id), relation));
                } else {
                    rebuiltRelations.set(relation.id, relation);
                }
            }
            relationCache.clear();
            for (const [id, relation] of rebuiltRelations.entries()) {
                relationCache.set(id, relation);
            }
        };
        const pruneEntitiesForReanalysis = (conversationText = '', extractedEntities = [], lorebook = []) => {
            const transcript = String(conversationText || '').trim();
            const extractedSet = new Set(
                (Array.isArray(extractedEntities) ? extractedEntities : [])
                    .map(entity => resolveCanonicalName(entity?.name || '', lorebook))
                    .filter(Boolean)
            );
            const removedNames = [];
            for (const [name, entity] of Array.from(entityCache.entries())) {
                if (entity?.meta?.manualLocked || entity?.meta?.nameManualLocked || isEntityAbsorptionPending(entity)) continue;
                if (extractedSet.has(name)) continue;
                if (transcript && mentionsEntity(transcript, entity)) continue;
                entityCache.delete(name);
                removedNames.push(name);
            }
            if (removedNames.length === 0) return removedNames;
            for (const [relationId, relation] of Array.from(relationCache.entries())) {
                const relationA = resolveCanonicalName(relation?.entityA || '', lorebook);
                const relationB = resolveCanonicalName(relation?.entityB || '', lorebook);
                if (removedNames.includes(relationA) || removedNames.includes(relationB)) {
                    relationCache.delete(relationId);
                }
            }
            return removedNames;
        };
        const pruneBlockedEntries = (lorebook = []) => {
            const removedNames = [];
            for (const [name] of Array.from(entityCache.entries())) {
                if (!isBlockedEntityName(name, lorebook)) continue;
                entityCache.delete(name);
                removedNames.push(name);
            }
            if (removedNames.length > 0) {
                for (const [relationId, relation] of Array.from(relationCache.entries())) {
                    const relationA = resolveCanonicalName(relation?.entityA || '', lorebook);
                    const relationB = resolveCanonicalName(relation?.entityB || '', lorebook);
                    if (removedNames.includes(relationA) || removedNames.includes(relationB) || isBlockedEntityName(relationA, lorebook) || isBlockedEntityName(relationB, lorebook)) {
                        relationCache.delete(relationId);
                    }
                }
            }
            return removedNames;
        };

        const mergeRelationRecords = (baseRelation, incomingRelation) => {
            if (!baseRelation) return incomingRelation;
            if (!incomingRelation) return baseRelation;
            normalizeRelationV2Fields(baseRelation);
            normalizeRelationV2Fields(incomingRelation);
            const baseSourceTurn = Math.max(0, Number(baseRelation.meta?.sourceTurn || baseRelation.currentStatus?.lastChangedTurn || baseRelation.sentiments?.lastInteraction || 0) || 0);
            const incomingSourceTurn = Math.max(0, Number(incomingRelation.meta?.sourceTurn || incomingRelation.currentStatus?.lastChangedTurn || incomingRelation.sentiments?.lastInteraction || 0) || 0);
            const allowVolatileState = baseSourceTurn <= 0 || incomingSourceTurn >= baseSourceTurn;
            if (allowVolatileState && !baseRelation.relationType && incomingRelation.relationType) baseRelation.relationType = incomingRelation.relationType;
            baseRelation.details = baseRelation.details || {};
            incomingRelation.details = incomingRelation.details || {};
            if (!baseRelation.details.howMet && incomingRelation.details.howMet) baseRelation.details.howMet = incomingRelation.details.howMet;
            if (!baseRelation.details.duration && incomingRelation.details.duration) baseRelation.details.duration = incomingRelation.details.duration;
            const mergedEvents = [...(baseRelation.details.events || []), ...(incomingRelation.details.events || [])];
            const eventById = new Map();
            for (const event of mergedEvents) {
                const key = String(event?.id || '').trim() || TokenizerEngine.simpleHash(`${event?.turn || 0}|${event?.event || event?.summary || event?.text || ''}`);
                eventById.set(key, event);
            }
            baseRelation.details.events = Array.from(eventById.values()).slice(-12);
            baseRelation.sentiments = baseRelation.sentiments || {};
            incomingRelation.sentiments = incomingRelation.sentiments || {};
            if (allowVolatileState && incomingRelation.sentiments.fromAtoB) baseRelation.sentiments.fromAtoB = incomingRelation.sentiments.fromAtoB;
            if (allowVolatileState && incomingRelation.sentiments.fromBtoA) baseRelation.sentiments.fromBtoA = incomingRelation.sentiments.fromBtoA;
            baseRelation.sentiments.lastInteraction = Math.max(Number(baseRelation.sentiments.lastInteraction || 0), Number(incomingRelation.sentiments.lastInteraction || 0));
            mergeRelationTimelines(baseRelation, incomingRelation);
            baseRelation.meta = baseRelation.meta || {};
            incomingRelation.meta = incomingRelation.meta || {};
            baseRelation.meta.created = Math.min(
                normalizeFiniteNumber(baseRelation.meta.created, Infinity),
                normalizeFiniteNumber(incomingRelation.meta.created, Infinity)
            );
            if (!Number.isFinite(baseRelation.meta.created)) baseRelation.meta.created = 0;
            baseRelation.meta.updated = Math.max(
                normalizeFiniteNumber(baseRelation.meta.updated, 0),
                normalizeFiniteNumber(incomingRelation.meta.updated, 0)
            );
            baseRelation.meta.confidence = Math.max(
                normalizeFiniteNumber(baseRelation.meta.confidence, 0),
                normalizeFiniteNumber(incomingRelation.meta.confidence, 0)
            );
            baseRelation.relationshipAssessment = buildRelationshipAssessment({
                ...baseRelation,
                relationshipAssessment: {
                    ...(baseRelation.relationshipAssessment || {}),
                    ...(incomingRelation.relationshipAssessment || {}),
                    evidenceCount: Math.max(
                        Number(baseRelation.relationshipAssessment?.evidenceCount || 0),
                        Number(incomingRelation.relationshipAssessment?.evidenceCount || 0),
                        getRelationEvidenceCount(baseRelation)
                    )
                }
            });
            return mergeRelationV2Fields(baseRelation, incomingRelation, {
                sourceMode: incomingRelation.meta?.source || baseRelation.meta?.source || 'merge',
                currentTurn: incomingSourceTurn,
                allowVolatileState
            });
        };

        const buildEntityMentionRegex = (name) => {
            const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const latinName = /^[a-z0-9 .'-]+$/i.test(name);
            if (latinName) {
                return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
            }
            return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?:[이가은는을를와과랑이랑도의께님씨아야]|\\s|$|[.,!?])`, 'iu');
        };

        const mentionsEntity = (text, entityOrName) => {
            const rawText = String(text || '').trim();
            const entity = typeof entityOrName === 'string' ? { name: entityOrName } : (entityOrName || {});
            const candidates = extractEntityAliases(entity)
                .map(alias => normalizeBaseName(alias))
                .filter(alias => alias && alias.length >= 2);
            if (!rawText || candidates.length === 0) return false;

            const tokenSet = new Set(
                TokenizerEngine.tokenize(rawText)
                    .map(token => String(token || '').toLowerCase())
                    .filter(Boolean)
            );
            const compactText = rawText.toLowerCase().replace(/\s+/g, '');

            for (const candidate of candidates) {
                const loweredName = candidate.toLowerCase();
                if (tokenSet.has(loweredName)) return true;
                const compactName = loweredName.replace(/\s+/g, '');
                if (compactName.length >= 2 && compactText.includes(compactName)) {
                    if (buildEntityMentionRegex(candidate).test(rawText)) return true;
                }
                if (buildEntityMentionRegex(candidate).test(rawText)) return true;
            }

            return false;
        };

        const sanitizeEntityPersonalityFields = (personality) => {
            const source = personality && typeof personality === 'object' ? personality : {};
            const sexualOrientationKeywords = [
                '개방적', '보수적', '순결주의', '문란함', '금욕적',
                '이성애', '동성애', '양성애', '무성애', '범성애',
                'open-minded', 'conservative', 'chaste', 'prudish', 'sex-positive',
                'heterosexual', 'straight', 'homosexual', 'gay', 'lesbian', 'bisexual', 'asexual', 'pansexual'
            ];
            const sexualPreferenceKeywords = [
                's성향', 'm성향', '리버스', 'switch', 'dominant', 'submissive', 'dom', 'sub',
                'sadist', 'masochist', 'voyeur', 'exhibitionist', '페티시', 'fetish', 'kink'
            ];
            const matchesKeyword = (value, keywords) => {
                const text = String(value || '').trim().toLowerCase();
                if (!text) return false;
                return keywords.some(keyword => text === keyword || text.includes(keyword));
            };
            const sexualOrientationPatterns = [
                /sexual attitudes?\s*[:\-]\s*([^.;\n]+)/i,
                /sexual orientation\s*[:\-]\s*([^.;\n]+)/i,
                /성관념\s*[:\-]\s*([^.;\n]+)/i
            ];
            const sexualPreferencePatterns = [
                /sexual preferences?\s*[:\-]\s*([^.;\n]+)/i,
                /sexual preference\s*[:\-]\s*([^.;\n]+)/i,
                /성적취향\s*[:\-]\s*([^.;\n]+)/i
            ];
            const fragmentPatterns = [
                /sexual attitudes?\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /sexual orientation\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /성관념\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /sexual preferences?\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /sexual preference\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /성적취향\s*[:\-]\s*[^.;\n]+[.;]?/gi
            ];

            const traitValues = Array.isArray(source.traits) ? source.traits : [];
            const explicitOrientation = typeof source.sexualOrientation === 'string' ? source.sexualOrientation.trim() : (typeof source.sexualAttitude === 'string' ? source.sexualAttitude.trim() : '');
            const explicitPreferences = Array.isArray(source.sexualPreferences)
                ? dedupeTextArray(source.sexualPreferences.map(String).map(v => v.trim()).filter(Boolean))
                : [];

            let parsedOrientation = explicitOrientation;
            const parsedPreferences = [...explicitPreferences];
            const cleanedTraits = [];

            for (const trait of traitValues.map(String).map(v => v.trim()).filter(Boolean)) {
                if (!parsedOrientation) {
                    parsedOrientation = pickLatestExplicitField(trait, sexualOrientationPatterns) || parsedOrientation;
                }
                const extractedPrefs = normalizeDelimitedList(pickLatestExplicitField(trait, sexualPreferencePatterns));
                if (extractedPrefs.length > 0) {
                    parsedPreferences.push(...extractedPrefs);
                }
                const cleanedTrait = stripLabeledFragments(trait, fragmentPatterns);
                if (!cleanedTrait) continue;
                if (!parsedOrientation && matchesKeyword(cleanedTrait, sexualOrientationKeywords)) {
                    parsedOrientation = cleanedTrait;
                    continue;
                }
                if (matchesKeyword(cleanedTrait, sexualPreferenceKeywords)) {
                    parsedPreferences.push(cleanedTrait);
                    continue;
                }
                cleanedTraits.push(cleanedTrait);
            }

            return {
                cleanedTraits: normalizeEntityTraitList(cleanedTraits, 18, 180),
                sexualOrientation: parsedOrientation || '',
                sexualPreferences: dedupeTextArray(parsedPreferences)
            };
        };

        const normalizeEntityShape = (entity) => {
            if (!entity || typeof entity !== 'object') return entity;
            entity.meta = entity.meta || {};
            entity.meta.aliases = Array.isArray(entity.meta.aliases) ? entity.meta.aliases : [];
            entity.meta.hiddenNameKeys = Array.isArray(entity.meta.hiddenNameKeys) ? entity.meta.hiddenNameKeys : [];
            entity.sex = normalizeBiologicalSex(entity.sex || entity.biologicalSex || '');
            if (Object.prototype.hasOwnProperty.call(entity, 'biologicalSex')) delete entity.biologicalSex;
            entity.appearance = entity.appearance || {};
            entity.appearance.features = Array.isArray(entity.appearance.features) ? entity.appearance.features : [];
            entity.appearance.distinctiveMarks = Array.isArray(entity.appearance.distinctiveMarks) ? entity.appearance.distinctiveMarks : [];
            entity.appearance.clothing = Array.isArray(entity.appearance.clothing) ? entity.appearance.clothing : [];
            entity.personality = entity.personality || {};
            entity.personality.traits = Array.isArray(entity.personality.traits) ? entity.personality.traits : [];
            entity.personality.values = Array.isArray(entity.personality.values) ? entity.personality.values : [];
            entity.personality.fears = Array.isArray(entity.personality.fears) ? entity.personality.fears : [];
            entity.personality.likes = Array.isArray(entity.personality.likes) ? entity.personality.likes : [];
            entity.personality.dislikes = Array.isArray(entity.personality.dislikes) ? entity.personality.dislikes : [];
            entity.personality.sexualPreferences = Array.isArray(entity.personality.sexualPreferences) ? entity.personality.sexualPreferences : [];
            entity.personality.sexualOrientation = typeof entity.personality.sexualOrientation === 'string' ? entity.personality.sexualOrientation : '';
            const sanitizedPersonality = sanitizeEntityPersonalityFields(entity.personality);
            entity.personality.traits = sanitizedPersonality.cleanedTraits;
            entity.personality.sexualOrientation = sanitizedPersonality.sexualOrientation || entity.personality.sexualOrientation;
            entity.personality.sexualPreferences = sanitizedPersonality.sexualPreferences;
            entity.speechStyle = normalizeSpeechStyleObject(entity.speechStyle);
            entity.background = entity.background || {};
            entity.background.origin = typeof entity.background.origin === 'string' ? entity.background.origin : '';
            entity.background.occupation = typeof entity.background.occupation === 'string' ? entity.background.occupation : '';
            entity.background.history = Array.isArray(entity.background.history) ? entity.background.history : [];
            entity.background.secrets = Array.isArray(entity.background.secrets) ? entity.background.secrets : [];
            entity.status = entity.status || {};
            entity.status.currentLocation = typeof entity.status.currentLocation === 'string' ? entity.status.currentLocation : '';
            entity.status.currentMood = typeof entity.status.currentMood === 'string' ? entity.status.currentMood : '';
            entity.status.healthStatus = typeof entity.status.healthStatus === 'string' ? entity.status.healthStatus : '';
            entity.status.currentDate = typeof entity.status.currentDate === 'string' ? entity.status.currentDate : '';
            entity.status.currentTime = typeof entity.status.currentTime === 'string' ? entity.status.currentTime : '';
            entity.status.notes = typeof entity.status.notes === 'string' ? entity.status.notes : '';
            entity.status.lastUpdated = Number.isFinite(Number(entity.status.lastUpdated)) ? Number(entity.status.lastUpdated) : 0;
            entity.timeTracking = normalizeEntityTimeTracking(entity.timeTracking, entity);
            entity.visualCanon = normalizeEntityVisualCanon(entity.visualCanon || entity.visual_canon || {}, entity);
            return normalizeEntityV2Fields(entity);
        };

        const getOrCreateEntity = (name, lorebook) => {
            const resolvedName = resolveCanonicalName(name, lorebook);
            const normalizedName = preferVerifiedIncomingFullName(name, resolvedName, lorebook);
            if (!normalizedName) return null;
            if (isBlockedEntityName(normalizedName, lorebook) || isBlockedEntityName(name, lorebook)) return null;

            if (entityCache.has(normalizedName)) return entityCache.get(normalizedName);

            const existing = lorebook.find(e => {
                if (e.comment !== ENTITY_COMMENT) return false;
                try {
                    const parsed = JSON.parse(e.content || '{}');
                    return resolveCanonicalName(parsed.name || '', lorebook) === normalizedName;
                } catch {
                    return false;
                }
            });
            if (existing) {
                try {
                    const profile = normalizeEntityShape(JSON.parse(existing.content));
                    profile.meta = profile.meta || { created: 0, updated: 0, confidence: 0.5, source: '' };
                    if (!Array.isArray(profile.meta.m_ids) && profile.meta.m_id) profile.meta.m_ids = [profile.meta.m_id];
                    profile.meta.aliases = Array.isArray(profile.meta.aliases) ? profile.meta.aliases : [];
                    profile.meta.hiddenNameKeys = Array.isArray(profile.meta.hiddenNameKeys) ? profile.meta.hiddenNameKeys : [];
                    extractNameVariantParts(name).forEach(alias => {
                        if (alias && alias !== normalizedName && !profile.meta.aliases.includes(alias)) {
                            profile.meta.aliases.push(alias);
                        }
                    });
                    buildHiddenNameKeys(name).forEach(key => {
                        if (key && !profile.meta.hiddenNameKeys.includes(key)) {
                            profile.meta.hiddenNameKeys.push(key);
                        }
                    });
                    try {
                        const legacyTracking = normalizeEntityTimeTracking(profile.timeTracking, profile);
                        if (Object.values(legacyTracking).some(Boolean)) {
                            TimeEngine.ingestEntityTracking(profile.name || normalizedName, legacyTracking, profile);
                        }
                        const projection = TimeEngine.projectEntity(profile);
                        if (projection?.currentDate) profile.status.currentDate = projection.currentDate;
                        if (projection?.currentTime) profile.status.currentTime = projection.currentTime;
                    } catch (e) {
                        if (MemoryEngine.CONFIG?.debug) console.warn('[LIBRA] TimeEngine entity bootstrap skipped:', e?.message);
                    }
                    entityCache.set(normalizedName, profile);
                    return profile;
                } catch {}
            }

            const newEntity = {
                id: TokenizerEngine.simpleHash(normalizedName),
                name: normalizedName,
                type: 'character',
                sex: '',
                appearance: { features: [], distinctiveMarks: [], clothing: [] },
                personality: { traits: [], values: [], fears: [], likes: [], dislikes: [], sexualOrientation: '', sexualPreferences: [] },
                speechStyle: { defaultTone: '', honorificStyle: '', toSuperiors: '', toSubordinates: '', toPeers: '', toYounger: '', notes: [] },
                background: { origin: '', occupation: '', history: [], secrets: [] },
                status: { currentLocation: '', currentMood: '', healthStatus: '', currentDate: '', currentTime: '', notes: '', lastUpdated: 0 },
                visualCanon: defaultEntityVisualCanon({ appearance: { features: [], distinctiveMarks: [], clothing: [] } }),
                identity: { age: '', sex: '', occupation: '', affiliation: '', roleInStory: '', summary: '', aliases: [], honorifics: [], source: null },
                profile: {
                    appearance: { features: [], distinctiveMarks: [], clothing: [], confidence: 0 },
                    personality: { traits: [], values: [], fears: [], likes: [], dislikes: [], vulnerabilities: [], boundaries: [], workStyle: '', socialStyle: '', confidence: 0 },
                    speechStyle: { defaultTone: '', honorificStyle: '', pressureMarkers: [], intimacyShift: '', catchphrases: [], notes: [] },
                    psychology: { baseline: '', currentConflict: '', copingStyle: '', notes: [], confidence: 0 }
                },
                currentState: { summary: '', sceneTime: '', location: '', physicalState: [], emotionalState: [], cognitiveFocus: [], activity: '', immediateGoal: '', activeProblems: [], visualState: normalizeCurrentVisualState({}), lastObservedTurn: 0 },
                continuity: { openThreads: [], unresolvedNeeds: [], commitments: [], nextActionHints: [] },
                povKnowledge: { knownToSelf: [], unknownToSelf: [], knownToOthers: [], visibleTo: [], privateExperiences: [], privacy: '' },
                episodeLedger: [],
                stateTimeline: [],
                evidence: [],
                quality: { confidence: 0.5, salience: 0, importance: 0, pressure: 0, lastUpdatedTurn: 0, sourceMix: [], staleness: '', needsReview: false },
                meta: {
                    created: MemoryState.currentTurn,
                    updated: 0,
                    confidence: 0.5,
                    source: '',
                    aliases: Array.from(new Set(extractNameVariantParts(name).filter(alias => alias && alias !== normalizedName))),
                    hiddenNameKeys: buildHiddenNameKeys(name)
                }
            };

            entityCache.set(normalizedName, newEntity);
            return newEntity;
        };

        const hasEntityRecordForRelationEndpoint = (name, lorebook = []) => {
            const normalizedName = resolveCanonicalName(name, lorebook);
            if (!normalizedName) return false;
            if (entityCache.has(normalizedName)) return true;
            return collectKnownEntities(lorebook).some(entity => {
                const entityName = resolveCanonicalName(entity?.name || '', lorebook);
                return entityName === normalizedName;
            });
        };

        const getOrCreateRelation = (nameA, nameB, lorebook, options = {}) => {
            const normalizedA = resolveCanonicalName(nameA, lorebook);
            const normalizedB = resolveCanonicalName(nameB, lorebook);
            if (!normalizedA || !normalizedB || normalizedA === normalizedB) return null;
            if (isBlockedEntityName(normalizedA, lorebook) || isBlockedEntityName(normalizedB, lorebook) || isBlockedEntityName(nameA, lorebook) || isBlockedEntityName(nameB, lorebook)) return null;
            if (!hasEntityRecordForRelationEndpoint(normalizedA, lorebook) || !hasEntityRecordForRelationEndpoint(normalizedB, lorebook)) return null;

            const relationId = makeRelationId(normalizedA, normalizedB, lorebook);
            if (relationCache.has(relationId)) return relationCache.get(relationId);

            const existing = lorebook.find(e => {
                if (e.comment !== RELATION_COMMENT) return false;
                try {
                    const parsed = JSON.parse(e.content || '{}');
                    const parsedA = resolveCanonicalName(parsed.entityA || '', lorebook);
                    const parsedB = resolveCanonicalName(parsed.entityB || '', lorebook);
                    const parsedId = makeRelationId(parsedA || parsed.entityA || '', parsedB || parsed.entityB || '', lorebook);
                    return parsedId === relationId;
                } catch {
                    return false;
                }
            });
            if (existing) {
                try {
                    const relation = JSON.parse(existing.content);
                    relation.meta = relation.meta || { created: 0, updated: 0, confidence: 0.3, source: '' };
                    if (!Array.isArray(relation.meta.m_ids) && relation.meta.m_id) relation.meta.m_ids = [relation.meta.m_id];
                    normalizeRelationV2Fields(relation);
                    relationCache.set(relationId, relation);
                    return relation;
                } catch {}
            }

            const creationTurn = Math.max(0, Number(options.sourceTurn ?? MemoryState.currentTurn ?? 0) || 0);
            const newRelation = {
                id: relationId,
                entityA: normalizedA,
                entityB: normalizedB,
                relationType: '첫 대면',
                details: { howMet: '', duration: '', closeness: null, trust: null, events: [] },
                sentiments: { fromAtoB: '', fromBtoA: '', currentTension: 0, lastInteraction: creationTurn },
                currentStatus: { summary: '', publicLayer: '', privateLayer: '', boundaryState: '', lastChangedTurn: 0 },
                metrics: { closeness: null, trust: null, tension: 0, risk: 0, ambiguity: 0.65, pressure: 0 },
                dynamics: { fromAtoB: [], fromBtoA: [], unresolvedIssues: [], recentChanges: [] },
                sharedContext: { location: '', workplace: '', privateThreads: [], notes: [] },
                eventLedger: [],
                relationTimeline: {
                    schema: RELATION_TIMELINE_SCHEMA,
                    baseline: {
                        scores: { closeness: null, trust: null, tension: 0, risk: 0, ambiguity: 0.65, pressure: 0 },
                        axes: {}, relationType: '첫 대면', turn: creationTurn, source: 'relation_created'
                    },
                    events: [], projection: {}, revision: 0
                },
                evidence: [],
                quality: { confidence: 0.3, salience: 0, importance: 0, pressure: 0, lastUpdatedTurn: 0, sourceMix: [], staleness: '', needsReview: false },
                relationshipAssessment: { stage: 'first_contact', definitionConfidence: 0.08, evidenceCount: 0, label: '첫 대면 · 정의 보류', note: '관계를 정의하기에는 근거가 부족함', inferred: true },
                meta: { created: creationTurn, updated: 0, sourceTurn: 0, confidence: 0.3 }
            };

            relationCache.set(relationId, newRelation);
            return newRelation;
        };

        const makeRenameNameKeys = (values = []) => {
            const keys = new Set();
            const add = (value = '') => {
                const raw = String(value || '').trim();
                if (!raw) return;
                [
                    raw,
                    normalizeCanonicalDisplayName(raw),
                    normalizeBaseName(raw),
                    ...buildAliasCandidates(raw, true),
                    ...buildHiddenNameKeys(raw)
                ].filter(Boolean).forEach(item => {
                    const normalized = String(item || '').trim().toLowerCase();
                    if (!normalized) return;
                    keys.add(normalized);
                    keys.add(normalized.replace(/\s+/g, ''));
                });
            };
            (Array.isArray(values) ? values : [values]).forEach(add);
            return keys;
        };
        const renameNameMatches = (value = '', keySet = new Set()) => {
            if (!keySet || keySet.size === 0) return false;
            const probe = makeRenameNameKeys([value]);
            for (const key of probe) {
                if (keySet.has(key)) return true;
            }
            return false;
        };
        const filterAliasesForRename = (aliases = [], oldNameKeys = new Set(), keepOldNameAsAlias = false) => {
            const out = [];
            for (const alias of Array.isArray(aliases) ? aliases : []) {
                const text = String(alias || '').trim();
                if (!text) continue;
                const oldAlias = renameNameMatches(text, oldNameKeys);
                if (!keepOldNameAsAlias && oldAlias) continue;
                if (!keepOldNameAsAlias && isGenericRoleAliasName(text)) continue;
                if (!out.includes(text)) out.push(text);
            }
            return out;
        };
        const makeEntityAbsorptionId = (sourceName = '', targetName = '') => {
            const source = normalizeCanonicalDisplayName(sourceName || '');
            const target = normalizeCanonicalDisplayName(targetName || '');
            return `lmai_absorb_${stableHash(`${source}=>${target}`)}`;
        };
        const getEntityRecordFromLore = (canonicalName = '', lorebook = []) => {
            const normalized = normalizeCanonicalDisplayName(canonicalName || '');
            if (!normalized) return null;
            const cached = entityCache.get(normalized);
            if (cached) return cached;
            for (const entry of LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])) {
                if (entry?.comment !== ENTITY_COMMENT) continue;
                try {
                    const parsed = normalizeEntityShape(JSON.parse(entry.content || '{}'));
                    const parsedName = resolveCanonicalName(parsed?.name || '', lorebook) || normalizeCanonicalDisplayName(parsed?.name || '');
                    if (parsedName === normalized) return parsed;
                } catch {
                    // Invalid entity entries are ignored by the normal rebuild path too.
                }
            }
            return null;
        };
        const normalizeEntityAbsorptionTask = (task = {}, lorebook = []) => {
            const sourceInput = String(task?.sourceName || task?.source || task?.oldName || '').trim();
            const targetInput = String(task?.targetName || task?.target || task?.newName || '').trim();
            const sourceName = resolveCanonicalName(sourceInput, lorebook) || normalizeCanonicalDisplayName(sourceInput);
            const targetName = resolveCanonicalName(targetInput, lorebook) || normalizeCanonicalDisplayName(targetInput);
            if (!sourceName || !targetName || sourceName === targetName) return null;
            const status = normalizeEntityAbsorptionStatus(task?.status) || 'pending';
            const id = String(task?.id || makeEntityAbsorptionId(sourceName, targetName)).trim();
            return {
                schema: ENTITY_ABSORPTION_SCHEMA,
                id,
                status,
                sourceName,
                targetName,
                sourceOriginalName: String(task?.sourceOriginalName || sourceInput || sourceName).trim(),
                reason: clampEntityText(task?.reason || '', 220),
                requestedAt: normalizeFiniteNumber(task?.requestedAt, Date.now()),
                requestedTurn: normalizeFiniteNumber(task?.requestedTurn, MemoryState.currentTurn || 0),
                appliedAt: normalizeFiniteNumber(task?.appliedAt, 0),
                appliedTurn: normalizeFiniteNumber(task?.appliedTurn, 0),
                cancelledAt: normalizeFiniteNumber(task?.cancelledAt, 0),
                cancelledTurn: normalizeFiniteNumber(task?.cancelledTurn, 0),
                confidence: normalizeEntity01(task?.confidence, 0),
                sourceSnapshot: task?.sourceSnapshot && typeof task.sourceSnapshot === 'object' ? task.sourceSnapshot : null,
                relationSnapshot: Array.isArray(task?.relationSnapshot) ? task.relationSnapshot.slice(0, 16) : [],
                reviewNotes: normalizeEntityList(task?.reviewNotes || [], 8, 220),
                conflicts: normalizeEntityList(task?.conflicts || [], 8, 220)
            };
        };
        const parseEntityAbsorptionTaskEntry = (entry = null, lorebook = []) => {
            if (!entry || entry.comment !== ENTITY_ABSORPTION_COMMENT) return null;
            try {
                return normalizeEntityAbsorptionTask(JSON.parse(entry.content || '{}'), lorebook);
            } catch {
                return null;
            }
        };
        const listEntityAbsorptions = (lorebook = [], options = {}) => {
            const statuses = Array.isArray(options.statuses)
                ? new Set(options.statuses.map(normalizeEntityAbsorptionStatus).filter(Boolean))
                : null;
            const tasks = [];
            for (const entry of LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])) {
                const task = parseEntityAbsorptionTaskEntry(entry, lorebook);
                if (!task) continue;
                if (statuses && !statuses.has(task.status)) continue;
                tasks.push(task);
            }
            if (options.includeEntityMeta !== false) {
                for (const entity of collectKnownEntities(lorebook)) {
                    const meta = getEntityAbsorptionMeta(entity);
                    if (!meta) continue;
                    const task = normalizeEntityAbsorptionTask({
                        ...meta,
                        sourceName: meta.sourceName || entity.name,
                        sourceOriginalName: meta.sourceOriginalName || entity.name
                    }, lorebook);
                    if (!task) continue;
                    if (statuses && !statuses.has(task.status)) continue;
                    if (!tasks.some(existing => existing.id === task.id)) tasks.push(task);
                }
            }
            return tasks;
        };
        const listPendingEntityAbsorptions = (lorebook = [], options = {}) => listEntityAbsorptions(lorebook, {
            ...options,
            statuses: ['pending']
        });
        const upsertEntityAbsorptionTask = (lorebook = [], task = {}) => {
            if (!Array.isArray(lorebook)) return null;
            const normalizedTask = normalizeEntityAbsorptionTask(task, lorebook);
            if (!normalizedTask) return null;
            const entry = {
                key: `lmai_entity_absorption::${normalizedTask.id}`,
                comment: ENTITY_ABSORPTION_COMMENT,
                content: JSON.stringify(normalizedTask, null, 2),
                mode: 'normal',
                insertorder: 55,
                alwaysActive: false
            };
            const existingIdx = lorebook.findIndex(item => {
                if (item?.comment !== ENTITY_ABSORPTION_COMMENT) return false;
                const parsed = parseEntityAbsorptionTaskEntry(item, lorebook);
                return parsed?.id === normalizedTask.id;
            });
            if (existingIdx >= 0) lorebook[existingIdx] = entry;
            else lorebook.push(entry);
            return normalizedTask;
        };
        const filterAliasesForAbsorption = (aliases = [], sourceNameKeys = new Set(), targetName = '') => {
            const target = normalizeCanonicalDisplayName(targetName || '');
            const out = [];
            for (const alias of Array.isArray(aliases) ? aliases : []) {
                const text = String(alias || '').trim();
                if (!text) continue;
                if (target && normalizeCanonicalDisplayName(text) === target) continue;
                if (renameNameMatches(text, sourceNameKeys)) continue;
                if (isGenericRoleAliasName(text)) continue;
                if (!out.includes(text)) out.push(text);
            }
            return out;
        };
        const sanitizeAbsorptionMergeEntity = (entity = {}, targetName = '', sourceNameKeys = new Set()) => {
            const sanitized = safeClone(entity && typeof entity === 'object' ? entity : {});
            sanitized.name = normalizeCanonicalDisplayName(targetName || sanitized.name || '');
            sanitized.meta = sanitized.meta && typeof sanitized.meta === 'object' ? sanitized.meta : {};
            delete sanitized.meta.absorption;
            sanitized.meta.aliases = filterAliasesForAbsorption(sanitized.meta.aliases, sourceNameKeys, sanitized.name);
            sanitized.meta.hiddenNameKeys = Array.isArray(sanitized.meta.hiddenNameKeys)
                ? sanitized.meta.hiddenNameKeys.filter(key => !renameNameMatches(key, sourceNameKeys) && !isGenericRoleAliasName(key))
                : [];
            if (sanitized.identity && typeof sanitized.identity === 'object') {
                sanitized.identity.aliases = filterAliasesForAbsorption(sanitized.identity.aliases, sourceNameKeys, sanitized.name);
            }
            return normalizeEntityShape(sanitized);
        };
        const rewriteRelationsForAbsorption = (sourceNameKeys = new Set(), targetName = '', lorebook = []) => {
            const target = normalizeCanonicalDisplayName(targetName || '');
            if (!target) return { changed: false, rewired: 0, dropped: 0 };
            const rebuiltRelations = new Map();
            let rewired = 0;
            let dropped = 0;
            for (const relation of relationCache.values()) {
                if (!relation || typeof relation !== 'object') continue;
                const nextRelation = safeClone(relation);
                const originalA = String(nextRelation.entityA || '').trim();
                const originalB = String(nextRelation.entityB || '').trim();
                nextRelation.entityA = renameNameMatches(originalA, sourceNameKeys)
                    ? target
                    : (resolveCanonicalName(originalA, lorebook) || originalA);
                nextRelation.entityB = renameNameMatches(originalB, sourceNameKeys)
                    ? target
                    : (resolveCanonicalName(originalB, lorebook) || originalB);
                if (nextRelation.entityA !== originalA || nextRelation.entityB !== originalB) rewired += 1;
                if (!nextRelation.entityA || !nextRelation.entityB || nextRelation.entityA === nextRelation.entityB) {
                    dropped += 1;
                    continue;
                }
                nextRelation.id = makeRelationId(nextRelation.entityA, nextRelation.entityB, lorebook);
                normalizeRelationV2Fields(nextRelation);
                if (rebuiltRelations.has(nextRelation.id)) {
                    rebuiltRelations.set(nextRelation.id, mergeRelationRecords(rebuiltRelations.get(nextRelation.id), nextRelation));
                } else {
                    rebuiltRelations.set(nextRelation.id, nextRelation);
                }
            }
            relationCache.clear();
            for (const [id, relation] of rebuiltRelations.entries()) {
                relationCache.set(id, relation);
            }
            return { changed: rewired > 0 || dropped > 0, rewired, dropped };
        };
        const renameEntity = (oldName = '', newName = '', lorebook = [], options = {}) => {
            const oldInput = normalizeCanonicalDisplayName(oldName || '');
            const newCanonical = normalizeCanonicalDisplayName(newName || '');
            if (!oldInput || !newCanonical) return { ok: false, reason: 'empty_name' };
            if (isBlockedEntityName(newCanonical, lorebook)) return { ok: false, reason: 'blocked_new_name', oldName: oldInput, newName: newCanonical };
            const oldCanonical = resolveCanonicalName(oldInput, lorebook) || oldInput;
            if (!oldCanonical) return { ok: false, reason: 'missing_old_name', oldName: oldInput, newName: newCanonical };
            if (oldCanonical === newCanonical) return { ok: false, reason: 'same_name', oldName: oldCanonical, newName: newCanonical };

            let sourceEntity = entityCache.get(oldCanonical);
            if (!sourceEntity) {
                const existingEntry = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : []).find(entry => {
                    if (entry?.comment !== ENTITY_COMMENT) return false;
                    try {
                        const parsed = JSON.parse(entry.content || '{}');
                        return resolveCanonicalName(parsed.name || '', lorebook) === oldCanonical;
                    } catch {
                        return false;
                    }
                });
                if (existingEntry) {
                    try {
                        sourceEntity = normalizeEntityShape(JSON.parse(existingEntry.content || '{}'));
                    } catch {
                        sourceEntity = null;
                    }
                }
            }
            if (!sourceEntity) return { ok: false, reason: 'entity_not_found', oldName: oldCanonical, newName: newCanonical };

            const previousNames = dedupeTextArray([
                oldInput,
                oldCanonical,
                sourceEntity.name || '',
                normalizeBaseName(oldInput),
                normalizeBaseName(oldCanonical),
                normalizeBaseName(sourceEntity.name || '')
            ].filter(Boolean));
            const oldNameKeys = makeRenameNameKeys(previousNames);
            const keepOldNameAsAlias = shouldKeepOldNameAsAliasForRename(oldInput || oldCanonical, options);
            const lockName = options.lockName !== false;
            const preserveSourceId = options.preserveSourceId === true;
            const sourceEntityId = sourceEntity.id;
            const sourceWasNameLocked = sourceEntity?.meta?.nameManualLocked === true;
            const now = Date.now();
            const sourceForMerge = safeClone(sourceEntity);
            sourceForMerge.name = newCanonical;
            sourceForMerge.meta = sourceForMerge.meta || {};
            sourceForMerge.meta.aliases = filterAliasesForRename(sourceForMerge.meta.aliases, oldNameKeys, keepOldNameAsAlias);
            sourceForMerge.meta.hiddenNameKeys = Array.isArray(sourceForMerge.meta.hiddenNameKeys) ? sourceForMerge.meta.hiddenNameKeys : [];
            if (!keepOldNameAsAlias) {
                sourceForMerge.meta.hiddenNameKeys = sourceForMerge.meta.hiddenNameKeys.filter(key => !renameNameMatches(key, oldNameKeys));
            }
            if (keepOldNameAsAlias) {
                previousNames.forEach(alias => {
                    if (alias && alias !== newCanonical && !sourceForMerge.meta.aliases.includes(alias)) sourceForMerge.meta.aliases.push(alias);
                });
                previousNames.flatMap(name => buildHiddenNameKeys(name)).forEach(key => {
                    if (key && !sourceForMerge.meta.hiddenNameKeys.includes(key)) sourceForMerge.meta.hiddenNameKeys.push(key);
                });
            }
            if (!sourceForMerge.meta.aliases.includes(newCanonical)) sourceForMerge.meta.aliases.push(newCanonical);
            buildHiddenNameKeys(newCanonical).forEach(key => {
                if (key && !sourceForMerge.meta.hiddenNameKeys.includes(key)) sourceForMerge.meta.hiddenNameKeys.push(key);
            });
            sourceForMerge.meta.nameManualLocked = lockName || sourceWasNameLocked;
            if (sourceForMerge.meta.nameManualLocked) {
                sourceForMerge.meta.nameManualLockedAt = sourceForMerge.meta.nameManualLockedAt || now;
            } else {
                delete sourceForMerge.meta.nameManualLockedAt;
            }
            sourceForMerge.meta.nameHistory = normalizeEntityList([
                ...(Array.isArray(sourceForMerge.meta.nameHistory) ? sourceForMerge.meta.nameHistory : []),
                `${oldCanonical} -> ${newCanonical} @T${MemoryState.currentTurn || 0}`
            ], 24, 180);
            sourceForMerge.meta.updated = MemoryState.currentTurn;
            sourceForMerge.meta.source = options.source || 'gui_rename';
            if (sourceForMerge.identity && typeof sourceForMerge.identity === 'object') {
                sourceForMerge.identity.aliases = sourceForMerge.meta.aliases.slice(0, 24);
            }
            normalizeEntityV2Fields(sourceForMerge);

            const existingNew = entityCache.get(newCanonical);
            let renamedEntity = sourceForMerge;
            if (existingNew && existingNew !== sourceEntity) {
                renamedEntity = mergeEntityRecords(safeClone(existingNew), sourceForMerge);
                renamedEntity.name = newCanonical;
                renamedEntity.meta = renamedEntity.meta || {};
                renamedEntity.meta.nameManualLocked = lockName || sourceWasNameLocked || existingNew?.meta?.nameManualLocked === true;
                if (renamedEntity.meta.nameManualLocked) {
                    renamedEntity.meta.nameManualLockedAt = Math.max(normalizeFiniteNumber(renamedEntity.meta.nameManualLockedAt, 0), now);
                } else {
                    delete renamedEntity.meta.nameManualLockedAt;
                }
                renamedEntity.meta.source = options.source || 'gui_rename_merge';
                renamedEntity.meta.aliases = filterAliasesForRename(renamedEntity.meta.aliases, oldNameKeys, keepOldNameAsAlias);
                if (keepOldNameAsAlias) {
                    previousNames.forEach(alias => {
                        if (alias && alias !== newCanonical && !renamedEntity.meta.aliases.includes(alias)) renamedEntity.meta.aliases.push(alias);
                    });
                }
                normalizeEntityV2Fields(renamedEntity);
            }
            if (preserveSourceId && sourceEntityId !== undefined && sourceEntityId !== null && sourceEntityId !== '') {
                renamedEntity.id = sourceEntityId;
            }

            if (entityCache.has(oldCanonical)) entityCache.delete(oldCanonical);
            entityCache.set(newCanonical, renamedEntity);

            const rebuiltRelations = new Map();
            for (const relation of relationCache.values()) {
                if (!relation || typeof relation !== 'object') continue;
                const nextRelation = safeClone(relation);
                if (renameNameMatches(nextRelation.entityA, oldNameKeys)) nextRelation.entityA = newCanonical;
                else nextRelation.entityA = resolveCanonicalName(nextRelation.entityA || '', lorebook) || nextRelation.entityA || '';
                if (renameNameMatches(nextRelation.entityB, oldNameKeys)) nextRelation.entityB = newCanonical;
                else nextRelation.entityB = resolveCanonicalName(nextRelation.entityB || '', lorebook) || nextRelation.entityB || '';
                if (!nextRelation.entityA || !nextRelation.entityB || nextRelation.entityA === nextRelation.entityB) continue;
                nextRelation.id = makeRelationId(nextRelation.entityA, nextRelation.entityB, lorebook);
                if (rebuiltRelations.has(nextRelation.id)) {
                    rebuiltRelations.set(nextRelation.id, mergeRelationRecords(rebuiltRelations.get(nextRelation.id), nextRelation));
                } else {
                    rebuiltRelations.set(nextRelation.id, nextRelation);
                }
            }
            relationCache.clear();
            for (const [id, relation] of rebuiltRelations.entries()) {
                relationCache.set(id, relation);
            }

            return {
                ok: true,
                oldName: oldCanonical,
                newName: newCanonical,
                previousNames,
                aliasKept: keepOldNameAsAlias,
                entity: renamedEntity
            };
        };

        const markEntityAbsorption = (sourceName = '', targetName = '', lorebook = [], options = {}) => {
            const sourceCanonical = resolveCanonicalName(sourceName, lorebook) || normalizeCanonicalDisplayName(sourceName);
            const targetCanonical = resolveCanonicalName(targetName, lorebook) || normalizeCanonicalDisplayName(targetName);
            if (!sourceCanonical || !targetCanonical) return { ok: false, reason: 'empty_name' };
            if (sourceCanonical === targetCanonical) return { ok: false, reason: 'same_entity', sourceName: sourceCanonical, targetName: targetCanonical };
            if (isBlockedEntityName(sourceCanonical, lorebook) || isBlockedEntityName(targetCanonical, lorebook)) {
                return { ok: false, reason: 'blocked_entity', sourceName: sourceCanonical, targetName: targetCanonical };
            }
            const sourceEntity = getEntityRecordFromLore(sourceCanonical, lorebook);
            const targetEntity = getEntityRecordFromLore(targetCanonical, lorebook);
            if (!sourceEntity) return { ok: false, reason: 'source_not_found', sourceName: sourceCanonical, targetName: targetCanonical };
            if (!targetEntity) return { ok: false, reason: 'target_not_found', sourceName: sourceCanonical, targetName: targetCanonical };
            if (isEntityAbsorptionApplied(sourceEntity)) return { ok: false, reason: 'source_already_absorbed', sourceName: sourceCanonical, targetName: targetCanonical };

            const now = Date.now();
            const id = makeEntityAbsorptionId(sourceCanonical, targetCanonical);
            const relationSnapshot = Array.from(relationCache.values())
                .filter(relation => renameNameMatches(relation?.entityA || '', makeRenameNameKeys([sourceCanonical, sourceEntity?.name || '']))
                    || renameNameMatches(relation?.entityB || '', makeRenameNameKeys([sourceCanonical, sourceEntity?.name || ''])))
                .map(relation => safeClone(relation))
                .slice(0, 16);
            const task = upsertEntityAbsorptionTask(lorebook, {
                id,
                status: 'pending',
                sourceName: sourceCanonical,
                targetName: targetCanonical,
                sourceOriginalName: String(sourceName || sourceCanonical).trim(),
                reason: options.reason || '',
                requestedAt: now,
                requestedTurn: MemoryState.currentTurn || 0,
                sourceSnapshot: safeClone(sourceEntity),
                relationSnapshot,
                reviewNotes: ['manual_absorption_requested']
            });
            if (!task) return { ok: false, reason: 'task_create_failed', sourceName: sourceCanonical, targetName: targetCanonical };

            sourceEntity.meta = sourceEntity.meta || {};
            sourceEntity.meta.absorption = {
                schema: ENTITY_ABSORPTION_SCHEMA,
                id: task.id,
                status: 'pending',
                sourceName: sourceCanonical,
                targetName: targetCanonical,
                sourceOriginalName: task.sourceOriginalName,
                requestedAt: now,
                requestedTurn: MemoryState.currentTurn || 0,
                reason: task.reason || ''
            };
            sourceEntity.meta.updated = MemoryState.currentTurn || sourceEntity.meta.updated || 0;
            sourceEntity.quality = sourceEntity.quality || {};
            sourceEntity.quality.needsReview = true;

            targetEntity.meta = targetEntity.meta || {};
            targetEntity.meta.pendingAbsorptionSources = normalizeEntityList([
                ...(Array.isArray(targetEntity.meta.pendingAbsorptionSources) ? targetEntity.meta.pendingAbsorptionSources : []),
                sourceCanonical
            ], 12, 180);
            targetEntity.meta.updated = MemoryState.currentTurn || targetEntity.meta.updated || 0;

            entityCache.set(sourceCanonical, sourceEntity);
            entityCache.set(targetCanonical, targetEntity);
            return { ok: true, id: task.id, sourceName: sourceCanonical, targetName: targetCanonical, task };
        };

        const cancelEntityAbsorption = (sourceName = '', lorebook = [], options = {}) => {
            const sourceCanonical = resolveCanonicalName(sourceName, lorebook) || normalizeCanonicalDisplayName(sourceName);
            if (!sourceCanonical) return { ok: false, reason: 'empty_name' };
            const sourceEntity = getEntityRecordFromLore(sourceCanonical, lorebook);
            const absorption = getEntityAbsorptionMeta(sourceEntity);
            if (!sourceEntity || normalizeEntityAbsorptionStatus(absorption?.status) !== 'pending') {
                return { ok: false, reason: 'not_pending', sourceName: sourceCanonical };
            }
            const task = normalizeEntityAbsorptionTask({
                ...absorption,
                sourceName: absorption.sourceName || sourceCanonical,
                status: 'cancelled',
                cancelledAt: Date.now(),
                cancelledTurn: MemoryState.currentTurn || 0,
                reviewNotes: ['manual_absorption_cancelled']
            }, lorebook);
            if (task) upsertEntityAbsorptionTask(lorebook, task);
            delete sourceEntity.meta.absorption;
            sourceEntity.quality = sourceEntity.quality || {};
            sourceEntity.quality.needsReview = !!options.keepReviewFlag;
            const targetCanonical = task?.targetName || absorption?.targetName || '';
            const targetEntity = targetCanonical ? getEntityRecordFromLore(targetCanonical, lorebook) : null;
            if (targetEntity?.meta) {
                targetEntity.meta.pendingAbsorptionSources = (Array.isArray(targetEntity.meta.pendingAbsorptionSources) ? targetEntity.meta.pendingAbsorptionSources : [])
                    .filter(name => name !== sourceCanonical);
                entityCache.set(targetCanonical, targetEntity);
            }
            entityCache.set(sourceCanonical, sourceEntity);
            return { ok: true, sourceName: sourceCanonical, targetName: targetCanonical, task };
        };

        const applyEntityAbsorption = (planOrTask = {}, lorebook = [], options = {}) => {
            const incomingTask = planOrTask?.task && typeof planOrTask.task === 'object' ? planOrTask.task : planOrTask;
            const normalizedTask = typeof incomingTask === 'string'
                ? listPendingEntityAbsorptions(lorebook).find(task => task.id === incomingTask)
                : normalizeEntityAbsorptionTask(incomingTask, lorebook);
            if (!normalizedTask) return { ok: false, reason: 'task_not_found' };
            if (normalizedTask.status !== 'pending') return { ok: false, reason: 'task_not_pending', id: normalizedTask.id, status: normalizedTask.status };

            const sourceCanonical = resolveCanonicalName(normalizedTask.sourceName, lorebook) || normalizedTask.sourceName;
            const targetCanonical = resolveCanonicalName(normalizedTask.targetName, lorebook) || normalizedTask.targetName;
            const sourceEntity = getEntityRecordFromLore(sourceCanonical, lorebook) || normalizeEntityShape(safeClone(normalizedTask.sourceSnapshot || {}));
            const targetEntity = getEntityRecordFromLore(targetCanonical, lorebook);
            if (!sourceEntity?.name && !sourceCanonical) return { ok: false, reason: 'source_not_found', id: normalizedTask.id };
            if (!targetEntity) return { ok: false, reason: 'target_not_found', id: normalizedTask.id, sourceName: sourceCanonical, targetName: targetCanonical };

            const previousNames = dedupeTextArray([
                normalizedTask.sourceName,
                normalizedTask.sourceOriginalName,
                sourceCanonical,
                sourceEntity.name || '',
                ...(Array.isArray(sourceEntity?.meta?.aliases) ? sourceEntity.meta.aliases : []),
                ...(Array.isArray(sourceEntity?.identity?.aliases) ? sourceEntity.identity.aliases : [])
            ].filter(Boolean));
            const sourceNameKeys = makeRenameNameKeys(previousNames);
            const sanitizedSource = sanitizeAbsorptionMergeEntity(sourceEntity, targetCanonical, sourceNameKeys);
            const rawPatch = planOrTask?.targetPatch || planOrTask?.patch || planOrTask?.targetEntity || planOrTask?.entity || {};
            const sanitizedPatch = rawPatch && typeof rawPatch === 'object' && Object.keys(rawPatch).length > 0
                ? sanitizeAbsorptionMergeEntity(rawPatch, targetCanonical, sourceNameKeys)
                : null;

            const targetBefore = safeClone(targetEntity);
            let mergedEntity = mergeEntityRecords(safeClone(targetEntity), sanitizedSource);
            if (sanitizedPatch) mergedEntity = mergeEntityRecords(mergedEntity, sanitizedPatch);
            mergedEntity.name = targetCanonical;
            mergedEntity.id = targetBefore.id || mergedEntity.id || TokenizerEngine.simpleHash(normalizeName(targetCanonical));
            mergedEntity.meta = mergedEntity.meta || {};
            mergedEntity.meta.absorbedSources = normalizeEntityList([
                ...(Array.isArray(targetBefore?.meta?.absorbedSources) ? targetBefore.meta.absorbedSources : []),
                sourceCanonical
            ], 24, 180);
            mergedEntity.meta.pendingAbsorptionSources = (Array.isArray(mergedEntity.meta.pendingAbsorptionSources) ? mergedEntity.meta.pendingAbsorptionSources : [])
                .filter(name => !previousNames.includes(name) && name !== sourceCanonical);
            mergedEntity.meta.absorptionHistory = normalizeEntityList([
                ...(Array.isArray(targetBefore?.meta?.absorptionHistory) ? targetBefore.meta.absorptionHistory : []),
                `${sourceCanonical} => ${targetCanonical} @T${MemoryState.currentTurn || 0}`
            ], 24, 220);
            mergedEntity.meta.aliases = filterAliasesForAbsorption(mergedEntity.meta.aliases, sourceNameKeys, targetCanonical);
            mergedEntity.meta.hiddenNameKeys = Array.isArray(mergedEntity.meta.hiddenNameKeys)
                ? mergedEntity.meta.hiddenNameKeys.filter(key => !renameNameMatches(key, sourceNameKeys) && !isGenericRoleAliasName(key))
                : [];
            if (targetBefore?.meta?.nameManualLocked === true) {
                mergedEntity.meta.nameManualLocked = true;
                mergedEntity.meta.nameManualLockedAt = targetBefore.meta.nameManualLockedAt || Date.now();
            }
            delete mergedEntity.meta.absorption;
            mergedEntity.meta.source = options.source || 'entity_absorption';
            mergedEntity.meta.updated = MemoryState.currentTurn || mergedEntity.meta.updated || 0;
            normalizeEntityV2Fields(mergedEntity);

            entityCache.delete(sourceCanonical);
            entityCache.set(targetCanonical, mergedEntity);
            const relationRewrite = rewriteRelationsForAbsorption(sourceNameKeys, targetCanonical, lorebook);

            const appliedTask = upsertEntityAbsorptionTask(lorebook, {
                ...normalizedTask,
                status: 'applied',
                appliedAt: Date.now(),
                appliedTurn: MemoryState.currentTurn || 0,
                confidence: normalizeEntity01(planOrTask?.confidence, normalizedTask.confidence || 0),
                conflicts: normalizeEntityList(planOrTask?.conflicts || normalizedTask.conflicts || [], 8, 220),
                reviewNotes: normalizeEntityList([
                    ...(Array.isArray(normalizedTask.reviewNotes) ? normalizedTask.reviewNotes : []),
                    ...(Array.isArray(planOrTask?.reviewNotes) ? planOrTask.reviewNotes : []),
                    `relations:${relationRewrite.rewired}/${relationRewrite.dropped}`
                ], 10, 220)
            });

            return {
                ok: true,
                id: normalizedTask.id,
                sourceName: sourceCanonical,
                targetName: targetCanonical,
                previousNames,
                entity: mergedEntity,
                task: appliedTask,
                relationRewrite
            };
        };

        const updateEntity = (name, updates, lorebook) => {
            if (isBlockedEntityName(name, lorebook)) return null;
            const entity = getOrCreateEntity(name, lorebook);
            if (!entity) return null;
            if (isEntityAbsorptionApplied(entity) || (isEntityAbsorptionPending(entity) && updates?.source !== 'entity_absorption')) return null;
            entity.meta = entity.meta || { created: MemoryState.currentTurn, updated: 0, confidence: 0.5, source: '', aliases: [] };
            entity.meta.aliases = Array.isArray(entity.meta.aliases) ? entity.meta.aliases : [];
            entity.meta.hiddenNameKeys = Array.isArray(entity.meta.hiddenNameKeys) ? entity.meta.hiddenNameKeys : [];
            normalizeEntityV2Fields(entity);
            const sourceTurn = Math.max(0, Number(updates?.sourceTurn ?? updates?.turn ?? MemoryState.currentTurn ?? 0) || 0);
            const priorSourceTurn = Math.max(
                0,
                Number(entity.meta?.sourceTurn || 0) || 0,
                Number(entity.currentState?.lastObservedTurn || 0) || 0,
                Number(entity.status?.lastUpdated || 0) || 0
            );
            const manualVolatileOverride = updates?.allowManualOverride === true && ['gui', 'manual'].includes(String(updates?.source || '').toLowerCase());
            const hasVolatilePatch = !!(updates?.status || updates?.currentState || updates?.current_state || updates?.continuity || updates?.profile?.psychology?.currentConflict);
            const allowVolatileState = manualVolatileOverride || priorSourceTurn <= 0 || sourceTurn >= priorSourceTurn;
            const forceReplace = updates?.forceReplace === true || updates?.source === 'correction';
            const manualProtected = isManualProtected(entity.meta, updates);
            extractNameVariantParts(name).forEach(incomingAlias => {
                if (incomingAlias && incomingAlias !== entity.name && !entity.meta.aliases.includes(incomingAlias)) {
                    entity.meta.aliases.push(incomingAlias);
                }
            });
            buildHiddenNameKeys(name).forEach(hiddenKey => {
                if (hiddenKey && !entity.meta.hiddenNameKeys.includes(hiddenKey)) {
                    entity.meta.hiddenNameKeys.push(hiddenKey);
                }
            });

            const currentTurn = MemoryState.currentTurn;
            const incomingSex = normalizeBiologicalSex(updates.sex || updates.biologicalSex || '');
            if (incomingSex && (forceReplace || !entity.sex)) {
                if (!(manualProtected && entity.sex)) entity.sex = incomingSex;
            }

            if (updates.appearance) {
                for (const key of ['features', 'distinctiveMarks', 'clothing']) {
                    if (Array.isArray(updates.appearance[key])) {
                        const normalizedItems = [...new Set(updates.appearance[key].filter(Boolean))];
                        if (forceReplace) {
                            if (manualProtected && Array.isArray(entity.appearance[key]) && entity.appearance[key].length > 0) continue;
                            entity.appearance[key] = normalizedItems;
                        } else {
                            if (!Array.isArray(entity.appearance[key])) entity.appearance[key] = [];
                            if (manualProtected && entity.appearance[key].length > 0) continue;
                            const newItems = normalizedItems.filter(item => !entity.appearance[key].includes(item));
                            entity.appearance[key].push(...newItems);
                        }
                    }
                }
            }

            if (updates.personality) {
                const sanitizedCurrentPersonality = sanitizeEntityPersonalityFields(entity.personality);
                entity.personality.traits = sanitizedCurrentPersonality.cleanedTraits;
                entity.personality.sexualOrientation = sanitizedCurrentPersonality.sexualOrientation || entity.personality.sexualOrientation;
                entity.personality.sexualPreferences = sanitizedCurrentPersonality.sexualPreferences;

                const sanitizedIncomingPersonality = sanitizeEntityPersonalityFields(updates.personality);
                const incomingPersonality = {
                    ...updates.personality,
                    traits: sanitizedIncomingPersonality.cleanedTraits,
                    sexualOrientation: sanitizedIncomingPersonality.sexualOrientation || updates.personality.sexualOrientation || '',
                    sexualPreferences: sanitizedIncomingPersonality.sexualPreferences
                };

                for (const key of ['traits', 'values', 'fears', 'likes', 'dislikes', 'sexualPreferences']) {
                    if (Array.isArray(incomingPersonality[key])) {
                        const normalizedItems = [...new Set(incomingPersonality[key].filter(Boolean))];
                        if (forceReplace) {
                            if (manualProtected && Array.isArray(entity.personality[key]) && entity.personality[key].length > 0) continue;
                            entity.personality[key] = normalizedItems;
                        } else {
                            if (!Array.isArray(entity.personality[key])) entity.personality[key] = [];
                            if (manualProtected && entity.personality[key].length > 0) continue;
                            const newItems = normalizedItems.filter(item => !entity.personality[key].includes(item));
                            entity.personality[key].push(...newItems);
                        }
                    }
                }
                if (incomingPersonality.sexualOrientation && (forceReplace || !entity.personality.sexualOrientation)) {
                    if (manualProtected && entity.personality.sexualOrientation) {
                    } else {
                    entity.personality.sexualOrientation = incomingPersonality.sexualOrientation;
                    }
                }
            }

            if (updates.speechStyle && typeof updates.speechStyle === 'object') {
                entity.speechStyle = entity.speechStyle || { defaultTone: '', honorificStyle: '', toSuperiors: '', toSubordinates: '', toPeers: '', toYounger: '', notes: [] };
                for (const key of ['defaultTone', 'honorificStyle', 'toSuperiors', 'toSubordinates', 'toPeers', 'toYounger']) {
                    const rawValue = String(updates.speechStyle[key] || '').trim();
                    const nextValue = normalizeSpeechStyleField(key, rawValue);
                    if (!nextValue) continue;
                    const existingValue = String(entity.speechStyle[key] || '').trim();
                    if (manualProtected && existingValue) continue;
                    const isKnownValue = (SPEECH_FIELD_OPTION_MAP[key] || []).some(option => option.value === rawValue);
                    if (rawValue && nextValue !== rawValue && !isKnownValue) {
                        entity.speechStyle.notes = Array.isArray(entity.speechStyle.notes) ? entity.speechStyle.notes : [];
                        if (!(manualProtected && entity.speechStyle.notes.length > 0)) {
                            entity.speechStyle.notes = dedupeTextArray([...(entity.speechStyle.notes || []), `${key}: ${rawValue}`]);
                        }
                    }
                    if (forceReplace || !entity.speechStyle[key]) {
                        entity.speechStyle[key] = nextValue;
                    }
                }
                if (Array.isArray(updates.speechStyle.notes)) {
                    const nextNotes = dedupeTextArray(updates.speechStyle.notes.map(String).map(v => v.trim()).filter(Boolean));
                    entity.speechStyle.notes = Array.isArray(entity.speechStyle.notes) ? entity.speechStyle.notes : [];
                    if (forceReplace) {
                        if (!(manualProtected && entity.speechStyle.notes.length > 0)) entity.speechStyle.notes = nextNotes;
                    } else {
                        if (manualProtected && entity.speechStyle.notes.length > 0) {
                        } else {
                        entity.speechStyle.notes = dedupeTextArray([...(entity.speechStyle.notes || []), ...nextNotes]);
                        }
                    }
                }
            }

            if (updates.background) {
                if (updates.background.origin && (forceReplace || !entity.background.origin)) {
                    if (!(manualProtected && entity.background.origin)) entity.background.origin = updates.background.origin;
                }
                if (updates.background.occupation && (forceReplace || !entity.background.occupation)) {
                    if (!(manualProtected && entity.background.occupation)) entity.background.occupation = updates.background.occupation;
                }
                if (Array.isArray(updates.background.history)) {
                    const normalizedHistory = [...new Set(updates.background.history.filter(Boolean))];
                    if (forceReplace) {
                        if (manualProtected && Array.isArray(entity.background.history) && entity.background.history.length > 0) {
                        } else {
                        entity.background.history = normalizedHistory;
                        }
                    } else {
                        if (!Array.isArray(entity.background.history)) entity.background.history = [];
                        if (manualProtected && entity.background.history.length > 0) {
                        } else {
                        const newHistory = normalizedHistory.filter(h => !entity.background.history.includes(h));
                        entity.background.history.push(...newHistory);
                        }
                    }
                }
            }

            if (updates.status && allowVolatileState) {
                if (updates.status.currentLocation && !(manualProtected && entity.status.currentLocation)) entity.status.currentLocation = updates.status.currentLocation;
                if (updates.status.currentMood && !(manualProtected && entity.status.currentMood)) entity.status.currentMood = normalizeEntityMoodText(updates.status.currentMood, 8);
                if (updates.status.healthStatus && !(manualProtected && entity.status.healthStatus)) entity.status.healthStatus = updates.status.healthStatus;
                if (updates.status.currentDate && !(manualProtected && entity.status.currentDate)) entity.status.currentDate = compactTimeFieldText(updates.status.currentDate, 80);
                if (updates.status.currentTime && !(manualProtected && entity.status.currentTime)) entity.status.currentTime = compactTimeFieldText(updates.status.currentTime, 40);
                if (updates.status.notes) {
                    const incomingNotes = String(updates.status.notes || '').trim();
                    if (incomingNotes && !(manualProtected && entity.status.notes)) {
                        entity.status.notes = mergeLimitedStatusNotes(forceReplace ? '' : entity.status.notes, incomingNotes, 320, {
                            entityName: entity.name || name || '',
                            status: entity.status
                        });
                    }
                }
                entity.status.lastUpdated = sourceTurn;
            }


            if ((updates.visualCanon || updates.visual_canon) && MemoryEngine.CONFIG?.entityVisualCanonEnabled !== false) {
                const incomingVisualCanon = updates.visualCanon || updates.visual_canon || {};
                entity.visualCanon = mergeEntityVisualCanon(entity.visualCanon || {}, incomingVisualCanon, {
                    forceReplace,
                    entity,
                    sourceMode: updates.source || 'conversation'
                });
            }

            mergeEntityV2Fields(entity, updates, {
                forceReplace,
                allowVolatileState,
                sourceMode: updates.source || 'conversation',
                m_id: updates.m_id,
                currentTurn: sourceTurn
            });

            entity.meta.updated = Math.max(Number(entity.meta.updated || 0) || 0, sourceTurn);
            if (hasVolatilePatch && allowVolatileState) entity.meta.sourceTurn = Math.max(priorSourceTurn, sourceTurn);
            if (updates.source) entity.meta.source = updates.source;
            entity.meta.confidence = Math.min(1, entity.meta.confidence + 0.1);
            
            // Sync/Rollback Metadata
            if (updates.s_id != null) entity.meta.s_id = updates.s_id;
            if (updates.m_id != null) addSourceMessageId(entity.meta, updates.m_id);

            try {
                if (!allowVolatileState) return entity;
                const trackingPatch = {
                    ...(updates.timeTracking && typeof updates.timeTracking === 'object' ? updates.timeTracking : {}),
                    currentDate: updates?.status?.currentDate || updates?.timeTracking?.currentDate || entity?.status?.currentDate || '',
                    currentTime: updates?.status?.currentTime || updates?.timeTracking?.currentTime || entity?.status?.currentTime || '',
                    notes: updates?.status?.notes || updates?.timeTracking?.notes || entity?.status?.notes || ''
                };
                TimeEngine.ingestEntityTracking(entity.name || name || '', trackingPatch, entity);
                const projection = TimeEngine.projectEntity(entity);
                if (projection?.currentDate) entity.status.currentDate = projection.currentDate;
                if (projection?.currentTime) entity.status.currentTime = projection.currentTime;
            } catch (e) {
                if (MemoryEngine.CONFIG?.debug) console.warn('[LIBRA] TimeEngine updateEntity skipped:', e?.message);
            }

            return entity;
        };

        const updateRelation = (nameA, nameB, updates, lorebook) => {
            if (isBlockedEntityName(nameA, lorebook) || isBlockedEntityName(nameB, lorebook)) return null;
            const sourceTurn = Math.max(0, Number(updates?.sourceTurn ?? updates?.turn ?? MemoryState.currentTurn ?? 0) || 0);
            const relation = getOrCreateRelation(nameA, nameB, lorebook, { sourceTurn });
            if (!relation) return null;
            normalizeRelationV2Fields(relation);

            const currentTurn = sourceTurn;
            const priorSourceTurn = Math.max(
                0,
                Number(relation.meta?.sourceTurn || 0) || 0,
                Number(relation.currentStatus?.lastChangedTurn || 0) || 0,
                Number(relation.sentiments?.lastInteraction || 0) || 0,
                Number(relation.relationTimeline?.projection?.lastChangedTurn || 0) || 0
            );
            const manualVolatileOverride = updates?.allowManualOverride === true && ['gui', 'manual'].includes(String(updates?.source || '').toLowerCase());
            const allowVolatileState = manualVolatileOverride || priorSourceTurn <= 0 || sourceTurn >= priorSourceTurn;
            const hasVolatilePatch = !!(updates?.relationType || updates?.sentiments || updates?.currentStatus || updates?.dynamics || updates?.sharedContext || updates?.relationDelta || updates?.axisDeltas);
            const forceReplace = updates?.forceReplace === true || updates?.source === 'correction';
            const manualProtected = isManualProtected(relation.meta, updates);

            if (allowVolatileState && updates.relationType && !(manualProtected && relation.relationType)) relation.relationType = updates.relationType;

            if (updates.details) {
                if (updates.details.howMet && !(manualProtected && relation.details.howMet)) relation.details.howMet = updates.details.howMet;
                if (updates.details.duration && !(manualProtected && relation.details.duration)) relation.details.duration = updates.details.duration;
            }

            if (updates.sentiments && allowVolatileState) {
                if (updates.sentiments.fromAtoB && !(manualProtected && relation.sentiments.fromAtoB)) relation.sentiments.fromAtoB = updates.sentiments.fromAtoB;
                if (updates.sentiments.fromBtoA && !(manualProtected && relation.sentiments.fromBtoA)) relation.sentiments.fromBtoA = updates.sentiments.fromBtoA;
            }

            const relationEvent = relationUpdateEventFromPatch(relation, updates, {
                forceReplace,
                sourceMode: updates.source || 'conversation',
                currentTurn
            });
            if (relationEvent) {
                upsertRelationTimelineEvent(relation, relationEvent);
                if (updates.event) {
                    const semanticEvent = {
                        id: relationEvent.id,
                        turn: currentTurn,
                        event: updates.event,
                        sentiment: updates.eventSentiment || 'neutral',
                        sourceMessageId: relationEvent.sourceMessageId || '',
                        status: relationEvent.status || 'active'
                    };
                    const existingEventIndex = relation.details.events.findIndex(item => String(item?.id || '') === semanticEvent.id);
                    if (existingEventIndex >= 0) relation.details.events[existingEventIndex] = semanticEvent;
                    else relation.details.events.push(semanticEvent);
                    relation.details.events = relation.details.events.slice(-12);
                }
            }

            mergeRelationV2Fields(relation, updates, {
                forceReplace,
                allowVolatileState,
                sourceMode: updates.source || 'conversation',
                m_id: updates.m_id,
                currentTurn
            });

            relation.meta.updated = Math.max(Number(relation.meta.updated || 0) || 0, sourceTurn);
            if (hasVolatilePatch && allowVolatileState) relation.meta.sourceTurn = Math.max(priorSourceTurn, sourceTurn);
            if (updates.source) relation.meta.source = updates.source;
            relation.meta.confidence = Math.min(1, Math.max(0.3, Number(relation.meta.confidence || 0.3)) + 0.1);
            relation.sentiments.lastInteraction = Math.max(Number(relation.sentiments.lastInteraction || 0) || 0, sourceTurn);

            // Sync/Rollback Metadata
            if (updates.s_id != null) relation.meta.s_id = updates.s_id;
            if (updates.m_id != null) addSourceMessageId(relation.meta, updates.m_id);

            recomputeRelationProjection(relation);
            relation.speechDynamics = normalizeRelationSpeechDynamics(relation.speechDynamics);
            relation.relationshipAssessment = buildRelationshipAssessment(relation);

            return relation;
        };

        const applyManualRelationProjection = (relation = {}, patch = {}) => {
            if (!relation || typeof relation !== 'object') return relation;
            normalizeRelationV2Fields(relation);
            const currentTurn = Math.max(0, Number(patch.currentTurn ?? MemoryState.currentTurn ?? relation.currentStatus?.lastChangedTurn ?? 0) || 0);
            const sourceMessageId = String(patch.m_id || `gui_relation:${relation.id || makeRelationId(relation.entityA, relation.entityB)}`).trim();
            const currentStatus = patch.currentStatus && typeof patch.currentStatus === 'object' ? patch.currentStatus : {};
            const dynamics = patch.dynamics && typeof patch.dynamics === 'object' ? patch.dynamics : {};
            const updates = {
                relationType: patch.relationType ?? relation.relationType,
                details: {
                    closeness: Object.prototype.hasOwnProperty.call(patch, 'closeness') ? patch.closeness : relation.details?.closeness,
                    trust: Object.prototype.hasOwnProperty.call(patch, 'trust') ? patch.trust : relation.details?.trust
                },
                metrics: patch.metrics && typeof patch.metrics === 'object' ? patch.metrics : {},
                axes: patch.axes && typeof patch.axes === 'object' ? patch.axes : {},
                currentStatus,
                dynamics,
                source: 'gui',
                s_id: String(patch.s_id || 'gui_manual_relation').trim(),
                m_id: sourceMessageId,
                sourceRevision: Math.max(1, Number(patch.sourceRevision || Date.now()) || Date.now()),
                canonicalFactSlot: 'manual_projection',
                forceReplace: true,
                quality: { confidence: 1 }
            };
            const event = relationUpdateEventFromPatch(relation, updates, { forceReplace: true, sourceMode: 'gui', currentTurn });
            if (event) upsertRelationTimelineEvent(relation, event);
            relation.currentStatus = { ...(relation.currentStatus || {}), ...currentStatus, lastChangedTurn: currentTurn };
            relation.dynamics = relation.dynamics && typeof relation.dynamics === 'object' ? relation.dynamics : {};
            if (Array.isArray(dynamics.unresolvedIssues)) relation.dynamics.unresolvedIssues = normalizeEntityList(dynamics.unresolvedIssues, 12, 180);
            if (Array.isArray(dynamics.recentChanges)) relation.dynamics.recentChanges = normalizeEntityList(dynamics.recentChanges, 12, 180);
            relation.meta = relation.meta && typeof relation.meta === 'object' ? relation.meta : {};
            relation.meta.source = 'gui';
            relation.meta.manualLocked = true;
            relation.meta.manualLockedAt = Date.now();
            relation.meta.updated = currentTurn;
            recomputeRelationProjection(relation);
            relation.relationshipAssessment = {
                ...buildRelationshipAssessment(relation),
                label: relation.details?.closeness != null || relation.details?.trust != null ? '수동 정의됨' : '첫 대면 · 정의 보류',
                note: relation.details?.closeness != null || relation.details?.trust != null ? '사용자가 직접 관계 수치를 지정함' : '관계를 정의하기에는 근거가 부족함',
                inferred: false
            };
            return normalizeRelationV2Fields(relation);
        };

        const checkConsistency = (entityName, newInfo, lorebook = []) => {
            const entity = entityCache.get(resolveCanonicalName(entityName, lorebook));
            if (!entity) return { consistent: true, conflicts: [] };

            const conflicts = [];
            if (newInfo.appearance?.features) {
                const opposites = { '키가 큼': ['키가 작음'], '키가 작음': ['키가 큼'], '검은 머리': ['금발', '갈색 머리'], '금발': ['검은 머리', '갈색 머리'], 'tall': ['short'], 'short': ['tall'], 'black hair': ['blonde', 'brown hair'], 'blonde': ['black hair', 'brown hair'], 'brown hair': ['black hair', 'blonde'] };
                const currentFeatures = Array.isArray(entity.appearance.features) ? entity.appearance.features : [];
                for (const feature of newInfo.appearance.features) {
                    if (opposites[feature]) {
                        for (const opp of opposites[feature]) {
                            if (currentFeatures.includes(opp)) {
                                conflicts.push({ type: 'appearance', existing: opp, new: feature, message:`외모 충돌: "${opp}" vs "${feature}"` });
                            }
                        }
                    }
                }
            }

            return { consistent: conflicts.length === 0, conflicts };
        };
