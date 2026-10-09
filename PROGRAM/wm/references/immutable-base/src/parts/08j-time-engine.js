    const TimeEngine = (() => {
        const STATE_COMMENT = 'lmai_time_engine';
        const defaultState = () => ({
            currentDate: '',
            currentTime: '',
            lastSceneDate: '',
            lastSceneTime: '',
            currentLabel: '',
            lastSceneLabel: '',
            sceneTurn: 0,
            notes: '',
            updatedAt: 0,
            entityAnchors: {}
        });

        let engineState = defaultState();

        const normalizeEntityKey = (entityName = '', entity = null) => {
            const raw = String(entityName || entity?.name || entity?.id || '').trim();
            return raw ? raw.toLowerCase() : '';
        };
        const STORY_DATE_PATTERN = /(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/g;
        const STORY_KR_DATE_PATTERN = /(\d{1,6})년\s*(\d{1,2})월\s*(\d{1,2})일/g;
        const normalizeStoryDateToken = (year, month, day) => {
            const y = Number(year);
            const m = Number(month);
            const d = Number(day);
            if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
            if (m < 1 || m > 12 || d < 1 || d > 31) return '';
            const parsed = new Date(y, m - 1, d, 9, 0, 0, 0);
            if (Number.isNaN(parsed.getTime())) return '';
            if (parsed.getFullYear() !== y || parsed.getMonth() !== (m - 1) || parsed.getDate() !== d) return '';
            return LibraTimeParser.formatDateLocal(parsed);
        };
        const extractStoryDateFromText = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return '';
            const direct = LibraTimeParser.parseDateText(raw);
            if (direct) return LibraTimeParser.formatDateLocal(direct);
            let latest = '';
            for (const match of raw.matchAll(STORY_DATE_PATTERN)) {
                const normalized = normalizeStoryDateToken(match[1], match[2], match[3]);
                if (normalized) latest = normalized;
            }
            for (const match of raw.matchAll(STORY_KR_DATE_PATTERN)) {
                const normalized = normalizeStoryDateToken(match[1], match[2], match[3]);
                if (normalized) latest = normalized;
            }
            return latest;
        };
        const deriveStoryAnchorDate = (lorebook = null) => {
            const candidates = [];
            const pushCandidate = (value) => {
                const normalized = extractStoryDateFromText(value);
                if (normalized) candidates.push(normalized);
            };
            pushCandidate(engineState.currentDate);
            pushCandidate(engineState.lastSceneDate);
            for (const anchor of Object.values(engineState.entityAnchors || {})) {
                if (!anchor || typeof anchor !== 'object') continue;
                pushCandidate(anchor.currentDate);
                pushCandidate(anchor.lastInteractionDate);
                pushCandidate(anchor.lastIntimacyDate);
                pushCandidate(anchor.cycleAnchorDate);
            }
            const sourceLore = Array.isArray(lorebook) ? lorebook : [];
            if (sourceLore.length > 0) {
                const scanFrom = Math.max(0, sourceLore.length - 160);
                for (let i = sourceLore.length - 1; i >= scanFrom; i--) {
                    const entry = sourceLore[i];
                    if (!entry) continue;
                    const meta = (typeof MemoryEngine !== 'undefined' && typeof MemoryEngine.getCachedMeta === 'function')
                        ? (MemoryEngine.getCachedMeta(entry) || {})
                        : {};
                    pushCandidate(meta?.currentDate);
                    pushCandidate(meta?.lastSceneDate);
                    pushCandidate(meta?.sourceDate);
                    pushCandidate(meta?.summary);
                    const rawContent = typeof entry?.content === 'string'
                        ? entry.content
                        : JSON.stringify(entry?.content || '');
                    pushCandidate(rawContent);
                }
            }
            if (!candidates.length) return '';
            candidates.sort((a, b) => String(a).localeCompare(String(b)));
            return candidates[candidates.length - 1] || '';
        };
        const getFallbackBaseDate = (entity = {}) => {
            const status = entity?.status && typeof entity.status === 'object' ? entity.status : {};
            return LibraTimeParser.buildDateFromState(engineState.currentDate, engineState.currentTime)
                || LibraTimeParser.buildDateFromState(engineState.lastSceneDate, engineState.lastSceneTime)
                || LibraTimeParser.parseDateText(status.currentDate)
                || LibraTimeParser.parseDateText(deriveStoryAnchorDate())
                || null;
        };
        const makeCanonicalAnchor = ({
            currentDate = '',
            currentTime = '',
            lastInteractionDate = '',
            lastInteractionTime = '',
            lastIntimacyDate = '',
            lastIntimacyTime = '',
            cycleAnchorDate = '',
            cycleAnchorTime = '',
            notes = '',
            parserMeta = null
        } = {}) => ({
            currentDate: compactTimeFieldText(currentDate, 80),
            currentTime: compactTimeFieldText(currentTime, 40),
            lastInteractionDate: compactTimeFieldText(lastInteractionDate, 80),
            lastInteractionTime: compactTimeFieldText(lastInteractionTime, 40),
            lastIntimacyDate: compactTimeFieldText(lastIntimacyDate, 80),
            lastIntimacyTime: compactTimeFieldText(lastIntimacyTime, 40),
            cycleAnchorDate: compactTimeFieldText(cycleAnchorDate, 80),
            cycleAnchorTime: compactTimeFieldText(cycleAnchorTime, 40),
            notes: compactTimeFieldText(notes, 180),
            parserMeta: parserMeta && typeof parserMeta === 'object' ? {
                input: compactTimeFieldText(parserMeta.input || '', 120),
                normalized: compactTimeFieldText(parserMeta.normalized || '', 120),
                type: compactTimeFieldText(parserMeta.type || '', 40),
                confidence: Number(parserMeta.confidence || 0) || 0,
                ambiguous: !!parserMeta.ambiguous,
                assumedTime: !!parserMeta.assumedTime
            } : null
        });
        const resolveAnchorField = (primaryValue, fallbackDate = '', fallbackTime = '', entity = {}) => {
            const raw = compactTimeFieldText(primaryValue || fallbackDate || '', 120);
            if (!raw && !fallbackTime) {
                return { date: '', time: '', parserMeta: null };
            }
            const directDate = LibraTimeParser.parseDateText(raw);
            const directTime = LibraTimeParser.parseTimeText(fallbackTime);
            if (directDate) {
                if (directTime) {
                    directDate.setHours(directTime.hour, directTime.minute, directTime.second, 0);
                }
                return {
                    date: LibraTimeParser.formatDateLocal(directDate),
                    time: directTime ? LibraTimeParser.formatTimeLocal(directDate) : compactTimeFieldText(fallbackTime || '', 40),
                    parserMeta: null
                };
            }
            const fallbackBaseDate = getFallbackBaseDate(entity);
            const resolved = fallbackBaseDate
                ? LibraTimeParser.resolveTextTarget(raw, fallbackBaseDate)
                : null;
            if (resolved?.target) {
                return {
                    date: resolved.target.date || '',
                    time: resolved.target.time || '',
                    parserMeta: {
                        input: raw,
                        normalized: resolved.normalized || raw,
                        type: resolved.type || 'absolute',
                        confidence: resolved?.meta?.confidence || 0,
                        ambiguous: !!resolved?.meta?.ambiguous,
                        assumedTime: !!resolved?.meta?.assumedTime
                    }
                };
            }
            return {
                date: compactTimeFieldText(fallbackDate || raw, 80),
                time: compactTimeFieldText(fallbackTime || '', 40),
                parserMeta: null
            };
        };
        const normalizeAnchor = (tracking, entity = {}) => {
            const source = tracking && typeof tracking === 'object' ? tracking : {};
            const normalized = normalizeEntityTimeTracking(tracking, entity);
            const current = resolveAnchorField(
                source.currentDate || source.currentDateText || source.currentDatePrompt || '',
                normalized.currentDate || '',
                source.currentTime || ''
            );
            const interaction = resolveAnchorField(
                source.lastInteractionDate || source.relationAnchorDate || source.lastInteractionText || '',
                normalized.lastInteractionDate || '',
                source.lastInteractionTime || ''
            );
            const intimacy = resolveAnchorField(
                source.lastIntimacyDate || source.nsfwAnchorDate || source.lastIntimacyText || '',
                normalized.lastIntimacyDate || '',
                source.lastIntimacyTime || ''
            );
            const cycle = resolveAnchorField(
                source.cycleAnchorDate || source.lastCycleDate || source.cycleAnchorText || '',
                normalized.cycleAnchorDate || '',
                source.cycleAnchorTime || ''
            );
            return makeCanonicalAnchor({
                currentDate: current.date,
                currentTime: current.time,
                lastInteractionDate: interaction.date,
                lastInteractionTime: interaction.time,
                lastIntimacyDate: intimacy.date,
                lastIntimacyTime: intimacy.time,
                cycleAnchorDate: cycle.date,
                cycleAnchorTime: cycle.time,
                notes: normalized.notes || source.notes || source.memo || '',
                parserMeta: current.parserMeta || interaction.parserMeta || intimacy.parserMeta || cycle.parserMeta || null
            });
        };
        const normalizeState = (state) => {
            const source = state && typeof state === 'object' ? state : {};
            const next = {
                currentDate: compactTimeFieldText(source.currentDate || source.lastSceneDate || '', 80),
                currentTime: compactTimeFieldText(source.currentTime || '', 40),
                lastSceneDate: compactTimeFieldText(source.lastSceneDate || source.currentDate || '', 80),
                lastSceneTime: compactTimeFieldText(source.lastSceneTime || source.currentTime || '', 40),
                currentLabel: compactTimeFieldText(source.currentLabel || source.sceneTimeLabel || source.currentSceneTimeLabel || '', 160),
                lastSceneLabel: compactTimeFieldText(source.lastSceneLabel || source.sceneTimeLabel || source.currentLabel || '', 160),
                sceneTurn: Math.max(0, Number(source.sceneTurn || 0)),
                notes: compactTimeFieldText(source.notes || source.memo || '', 180),
                updatedAt: Math.max(0, Number(source.updatedAt || 0)),
                entityAnchors: {}
            };
            const rawAnchors = source.entityAnchors && typeof source.entityAnchors === 'object' ? source.entityAnchors : {};
            for (const [key, value] of Object.entries(rawAnchors)) {
                const normalizedKey = normalizeEntityKey(key);
                if (!normalizedKey) continue;
                next.entityAnchors[normalizedKey] = normalizeAnchor(value, {});
            }
            return next;
        };
        const ensureAnchor = (entityName = '', entity = null) => {
            const key = normalizeEntityKey(entityName, entity);
            if (!key) return [null, null];
            if (!engineState.entityAnchors[key]) {
                engineState.entityAnchors[key] = normalizeAnchor({}, entity || {});
            }
            return [key, engineState.entityAnchors[key]];
        };
        const getObservedSceneTurn = (lorebook = null) => {
            const hasDeletedTurnTombstones = hasDeletedTurnTombstonesInLorebook(lorebook);
            const memoryTurn = hasDeletedTurnTombstones ? 0 : Number(typeof MemoryEngine !== 'undefined' && typeof MemoryEngine?.getCurrentTurn === 'function'
                ? MemoryEngine.getCurrentTurn()
                : 0);
            const narrativeTurn = Number(Array.isArray(NarrativeTracker?.getState?.()?.turnLog)
                ? Math.max(0, ...NarrativeTracker.getState().turnLog
                    .filter(entry => entry?.deletedTurn !== true && entry?.needsReinterpretation !== true)
                    .map(entry => Number(entry?.sceneTurn || entry?.turn || 0))
                    .filter(Number.isFinite))
                : 0);
            const loreTurn = Number(Array.isArray(lorebook) && typeof deriveMaxConfirmedMemoryTurnFromLorebook === 'function'
                ? deriveMaxConfirmedMemoryTurnFromLorebook(lorebook)
                : 0);
            return Math.max(0, memoryTurn, narrativeTurn, loreTurn);
        };
        const syncSceneTurn = (lorebook = null) => {
            const observedSceneTurn = getObservedSceneTurn(lorebook);
            const hasDeletedTurnTombstones = hasDeletedTurnTombstonesInLorebook(lorebook);
            engineState.sceneTurn = hasDeletedTurnTombstones
                ? Math.max(0, Number(observedSceneTurn || 0))
                : Math.max(0, Number(engineState.sceneTurn || 0), observedSceneTurn);
            return engineState.sceneTurn;
        };
        const ensureMinimumClockState = (lorebook = null) => {
            syncSceneTurn(lorebook);
            if (engineState.currentDate) return false;
            const hasAnchors = Object.values(engineState.entityAnchors || {}).some(anchor => {
                if (!anchor || typeof anchor !== 'object') return false;
                return !!(
                    anchor.currentDate
                    || anchor.lastInteractionDate
                    || anchor.lastIntimacyDate
                    || anchor.cycleAnchorDate
                );
            });
            if (!hasAnchors && Number(engineState.sceneTurn || 0) <= 0) return false;
            const fallbackDate = deriveStoryAnchorDate(lorebook);
            if (!fallbackDate) return false;
            engineState.currentDate = fallbackDate;
            engineState.lastSceneDate = engineState.lastSceneDate || fallbackDate;
            engineState.updatedAt = Date.now();
            return true;
        };
        const bootstrapStateFromLorebook = (lorebook = null) => {
            const sourceLore = Array.isArray(lorebook) ? LibraLoreConsolidator.unpack(lorebook) : [];
            if (!sourceLore.length) return false;
            let changed = false;
            for (const entry of sourceLore) {
                if (String(entry?.comment || '') !== 'lmai_entity') continue;
                let content = null;
                try {
                    content = typeof entry?.content === 'string' ? JSON.parse(entry.content) : entry?.content;
                } catch (_) {
                    content = null;
                }
                if (!content || typeof content !== 'object') continue;
                const entityName = String(content?.name || content?.id || '').trim();
                if (!entityName) continue;
                const legacyTracking = {
                    currentDate: content?.timeTracking?.currentDate || content?.status?.currentDate || '',
                    currentTime: content?.timeTracking?.currentTime || content?.status?.currentTime || '',
                    lastInteractionDate: content?.timeTracking?.lastInteractionDate || '',
                    lastInteractionTime: content?.timeTracking?.lastInteractionTime || '',
                    lastIntimacyDate: content?.timeTracking?.lastIntimacyDate || '',
                    lastIntimacyTime: content?.timeTracking?.lastIntimacyTime || '',
                    cycleAnchorDate: content?.timeTracking?.cycleAnchorDate || '',
                    cycleAnchorTime: content?.timeTracking?.cycleAnchorTime || '',
                    notes: content?.timeTracking?.notes || content?.status?.notes || ''
                };
                if (!Object.values(legacyTracking).some(Boolean)) continue;
                const before = JSON.stringify(engineState.entityAnchors?.[normalizeEntityKey(entityName)] || {});
                ingestEntityTracking(entityName, legacyTracking, content);
                const after = JSON.stringify(engineState.entityAnchors?.[normalizeEntityKey(entityName)] || {});
                if (before !== after) changed = true;
            }
            if (ensureMinimumClockState(sourceLore)) changed = true;
            return changed;
        };
        const loadState = (lorebook, options = {}) => {
            const sourceLore = Array.isArray(lorebook) ? lorebook : [];
            const scopeKey = String(options?.scopeKey || getActiveManagedRuntimeScopeKey()).trim() || 'global';
            const idx = findManagedScopedEntryIndex(sourceLore, STATE_COMMENT, scopeKey);
            const entry = idx >= 0 ? sourceLore[idx] : null;
            if (entry) {
                try {
                    const parsed = JSON.parse(entry.content);
                    engineState = normalizeState(parsed?.engineState && typeof parsed.engineState === 'object' ? parsed.engineState : parsed);
                } catch (e) {
                    console.warn('[LIBRA] Time engine parse failed:', e?.message);
                    engineState = defaultState();
                }
            } else {
                engineState = defaultState();
            }
            syncSceneTurn(sourceLore);
            bootstrapStateFromLorebook(sourceLore);
            ensureMinimumClockState(sourceLore);
            return engineState;
        };
        const saveState = async (lorebook, options = {}) => {
            syncSceneTurn(lorebook);
            const scopeKey = String(options?.scopeKey || getActiveManagedRuntimeScopeKey()).trim() || 'global';
            const chatId = String(options?.chatId || getActiveManagedChatId() || '').trim();
            const entry = {
                key: buildScopedManagedLoreKey(STATE_COMMENT, scopeKey),
                comment: STATE_COMMENT,
                content: JSON.stringify({
                    scopeKey,
                    chatId,
                    engineState
                }),
                mode: 'normal',
                insertorder: 7,
                alwaysActive: false
            };
            upsertManagedScopedEntry(lorebook, STATE_COMMENT, entry, scopeKey);
        };
        const resetState = (nextState = null) => {
            engineState = nextState ? normalizeState(nextState) : defaultState();
            return engineState;
        };
        const getState = () => engineState;
        const ingestEntityTracking = (entityName = '', tracking = {}, entity = {}) => {
            syncSceneTurn();
            const [key, anchor] = ensureAnchor(entityName, entity);
            const normalized = normalizeAnchor(tracking, entity);
            if (!key || !anchor) {
                if (normalized.currentDate) {
                    engineState.currentDate = normalized.currentDate;
                    engineState.currentTime = normalized.currentTime || engineState.currentTime || '';
                    engineState.lastSceneDate = normalized.currentDate;
                    engineState.lastSceneTime = normalized.currentTime || engineState.lastSceneTime || '';
                    engineState.updatedAt = Date.now();
                }
                ensureMinimumClockState();
                return normalized;
            }
            engineState.entityAnchors[key] = makeCanonicalAnchor({
                currentDate: normalized.currentDate || anchor.currentDate || '',
                currentTime: normalized.currentTime || anchor.currentTime || '',
                lastInteractionDate: normalized.lastInteractionDate || anchor.lastInteractionDate || '',
                lastInteractionTime: normalized.lastInteractionTime || anchor.lastInteractionTime || '',
                lastIntimacyDate: normalized.lastIntimacyDate || anchor.lastIntimacyDate || '',
                lastIntimacyTime: normalized.lastIntimacyTime || anchor.lastIntimacyTime || '',
                cycleAnchorDate: normalized.cycleAnchorDate || anchor.cycleAnchorDate || '',
                cycleAnchorTime: normalized.cycleAnchorTime || anchor.cycleAnchorTime || '',
                notes: normalized.notes || anchor.notes || '',
                parserMeta: normalized.parserMeta || anchor.parserMeta || null
            });
            const effectiveCurrentDate = normalized.currentDate || engineState.currentDate || '';
            if (effectiveCurrentDate) {
                engineState.currentDate = effectiveCurrentDate;
                engineState.currentTime = normalized.currentTime || engineState.currentTime || '';
                engineState.lastSceneDate = effectiveCurrentDate;
                engineState.lastSceneTime = normalized.currentTime || engineState.lastSceneTime || '';
            }
            ensureMinimumClockState();
            engineState.updatedAt = Date.now();
            return engineState.entityAnchors[key];
        };
        const ingestLiveTurn = (entityNames = [], liveDate = '', notes = '', options = {}) => {
            syncSceneTurn();
            const sceneTimeLabel = compactTimeFieldText(
                options?.sceneTimeLabel
                || options?.timeLabel
                || options?.rawSceneTime
                || '',
                160
            );
            const sceneTimeText = compactTimeFieldText(
                [
                    sceneTimeLabel,
                    liveDate,
                    options?.sceneDate || '',
                    options?.sceneTime || ''
                ].filter(Boolean).join(' '),
                220
            );
            const storyAnchorDate = deriveStoryAnchorDate();
            const baseDate = LibraTimeParser.buildDateFromState(engineState.currentDate, engineState.currentTime)
                || LibraTimeParser.buildDateFromState(engineState.lastSceneDate, engineState.lastSceneTime)
                || LibraTimeParser.parseDateText(storyAnchorDate)
                || null;
            const resolved = LibraTimeParser.resolveTextTarget(
                sceneTimeText || `${engineState.currentDate || ''} ${engineState.currentTime || ''}`.trim(),
                baseDate
            );
            const normalizedDate = compactTimeFieldText(
                resolved?.target?.date
                || options?.sceneDate
                || liveDate
                || engineState.currentDate
                || engineState.lastSceneDate
                || storyAnchorDate
                || '',
                80
            );
            const normalizedTime = compactTimeFieldText(resolved?.target?.time || options?.sceneTime || engineState.currentTime || '', 40);
            if (!normalizedDate) return 0;
            let changed = 0;
            engineState.currentDate = normalizedDate;
            engineState.currentTime = normalizedTime;
            engineState.lastSceneDate = normalizedDate;
            engineState.lastSceneTime = normalizedTime;
            if (sceneTimeLabel || sceneTimeText) {
                const label = sceneTimeLabel || sceneTimeText;
                engineState.currentLabel = label;
                engineState.lastSceneLabel = label;
            }
            engineState.notes = compactTimeFieldText(notes || engineState.notes || '', 180);
            for (const entityName of (Array.isArray(entityNames) ? entityNames : [])) {
                const [key, anchor] = ensureAnchor(entityName);
                if (!key || !anchor) continue;
                const nextAnchor = makeCanonicalAnchor({
                    ...anchor,
                    currentDate: normalizedDate,
                    currentTime: normalizedTime,
                    lastInteractionDate: normalizedDate,
                    lastInteractionTime: normalizedTime,
                    notes: anchor.notes || engineState.notes || '',
                    parserMeta: resolved?.meta ? {
                        input: compactTimeFieldText(liveDate || '', 120),
                        normalized: compactTimeFieldText(resolved.normalized || sceneTimeText || liveDate || '', 120),
                        type: compactTimeFieldText(resolved.type || 'absolute', 40),
                        confidence: resolved?.meta?.confidence || 0,
                        ambiguous: !!resolved?.meta?.ambiguous,
                        assumedTime: !!resolved?.meta?.assumedTime
                    } : (anchor.parserMeta || null)
                });
                const before = JSON.stringify(anchor);
                const after = JSON.stringify(nextAnchor);
                engineState.entityAnchors[key] = nextAnchor;
                if (before !== after) changed++;
            }
            engineState.updatedAt = Date.now();
            return changed;
        };
        const getProjection = (entityName = '', entity = {}) => {
            syncSceneTurn();
            const key = normalizeEntityKey(entityName, entity);
            const anchor = key ? (engineState.entityAnchors[key] || {}) : {};
            const fallback = normalizeAnchor(entity?.timeTracking || {}, entity);
            const status = entity?.status && typeof entity.status === 'object' ? entity.status : {};
            const normalized = normalizeEntityTimeTracking({
                currentDate: anchor.currentDate || engineState.currentDate || fallback.currentDate || status.currentDate || '',
                lastInteractionDate: anchor.lastInteractionDate || fallback.lastInteractionDate || engineState.lastSceneDate || '',
                lastIntimacyDate: anchor.lastIntimacyDate || fallback.lastIntimacyDate || '',
                cycleAnchorDate: anchor.cycleAnchorDate || fallback.cycleAnchorDate || '',
                notes: anchor.notes || fallback.notes || engineState.notes || ''
            }, entity);
            normalized.currentTime = compactTimeFieldText(anchor.currentTime || engineState.currentTime || fallback.currentTime || status.currentTime || '', 40);
            normalized.lastInteractionTime = compactTimeFieldText(anchor.lastInteractionTime || fallback.lastInteractionTime || engineState.lastSceneTime || '', 40);
            normalized.lastIntimacyTime = compactTimeFieldText(anchor.lastIntimacyTime || fallback.lastIntimacyTime || '', 40);
            normalized.cycleAnchorTime = compactTimeFieldText(anchor.cycleAnchorTime || fallback.cycleAnchorTime || '', 40);
            normalized.parserMeta = anchor.parserMeta || fallback.parserMeta || null;
            return normalized;
        };
        const projectEntity = (entity = {}) => {
            if (!entity || typeof entity !== 'object') return normalizeEntityTimeTracking({}, {});
            syncSceneTurn();
            const projection = getProjection(entity?.name || '', entity);
            entity.status = entity.status && typeof entity.status === 'object' ? entity.status : {};
            if (projection.currentDate) entity.status.currentDate = projection.currentDate;
            if (projection.currentTime) entity.status.currentTime = projection.currentTime;
            stripEntityTimeTracking(entity);
            return projection;
        };
        const mergeTimeAnchors = (target = {}, source = {}) => makeCanonicalAnchor({
            currentDate: target.currentDate || source.currentDate || '',
            currentTime: target.currentTime || source.currentTime || '',
            lastInteractionDate: target.lastInteractionDate || source.lastInteractionDate || '',
            lastInteractionTime: target.lastInteractionTime || source.lastInteractionTime || '',
            lastIntimacyDate: target.lastIntimacyDate || source.lastIntimacyDate || '',
            lastIntimacyTime: target.lastIntimacyTime || source.lastIntimacyTime || '',
            cycleAnchorDate: target.cycleAnchorDate || source.cycleAnchorDate || '',
            cycleAnchorTime: target.cycleAnchorTime || source.cycleAnchorTime || '',
            notes: compactTimeFieldText(dedupeTextArray([target.notes, source.notes].filter(Boolean)).join(' | '), 180),
            parserMeta: target.parserMeta || source.parserMeta || null
        });
        const renameEntityAnchor = (oldName = '', newName = '', options = {}) => {
            const oldKey = String(options.oldKey || normalizeEntityKey(oldName)).trim();
            const newKey = String(options.newKey || normalizeEntityKey(newName)).trim();
            if (!oldKey || !newKey || oldKey === newKey) return { changed: false };
            const anchors = engineState.entityAnchors && typeof engineState.entityAnchors === 'object' ? engineState.entityAnchors : {};
            const oldAnchor = anchors[oldKey];
            if (!oldAnchor) return { changed: false };
            const newAnchor = anchors[newKey];
            anchors[newKey] = newAnchor ? mergeTimeAnchors(newAnchor, oldAnchor) : normalizeAnchor(oldAnchor, {});
            delete anchors[oldKey];
            engineState.entityAnchors = anchors;
            engineState.updatedAt = Date.now();
            return { changed: true };
        };
        const selfCheck = (context = {}) => {
            const scopeKey = String(context?.scopeKey || context?.scopeId || getActiveManagedRuntimeScopeKey()).trim() || 'global';
            const lorebook = Array.isArray(context?.lorebook) ? context.lorebook : null;
            const warnings = [];
            const anchors = engineState?.entityAnchors && typeof engineState.entityAnchors === 'object'
                ? engineState.entityAnchors
                : {};
            const anchorEntries = Object.entries(anchors);
            const anchorCount = anchorEntries.length;
            const datedAnchorCount = anchorEntries.filter(([, anchor]) => !!(
                anchor?.currentDate
                || anchor?.lastInteractionDate
                || anchor?.lastIntimacyDate
                || anchor?.cycleAnchorDate
            )).length;
            const currentDate = String(engineState?.currentDate || '').trim();
            const currentTime = String(engineState?.currentTime || '').trim();
            const lastSceneDate = String(engineState?.lastSceneDate || '').trim();
            const lastSceneTime = String(engineState?.lastSceneTime || '').trim();
            const currentLabel = String(engineState?.currentLabel || '').trim();
            const lastSceneLabel = String(engineState?.lastSceneLabel || '').trim();
            const parsedCurrentDate = currentDate ? LibraTimeParser.parseDateText(currentDate) : null;
            const parsedLastSceneDate = lastSceneDate ? LibraTimeParser.parseDateText(lastSceneDate) : null;
            if (currentDate && !parsedCurrentDate) warnings.push('currentDate is not parser-readable');
            if (lastSceneDate && !parsedLastSceneDate) warnings.push('lastSceneDate is not parser-readable');
            if (currentTime && !LibraTimeParser.parseTimeText(currentTime)) warnings.push('currentTime is not HH:mm[:ss]');
            if (lastSceneTime && !LibraTimeParser.parseTimeText(lastSceneTime)) warnings.push('lastSceneTime is not HH:mm[:ss]');
            if (!currentDate && datedAnchorCount > 0) warnings.push('entity anchors exist but canonical currentDate is empty');
            let storage = null;
            if (lorebook) {
                const idx = findManagedScopedEntryIndex(lorebook, STATE_COMMENT, scopeKey);
                const entry = idx >= 0 ? lorebook[idx] : null;
                storage = {
                    present: idx >= 0,
                    index: idx,
                    scopeKey: getManagedScopedEntryScope(entry) || '',
                    legacyCompatible: !!entry && !getManagedScopedEntryScope(entry)
                };
                if (!entry && (currentDate || lastSceneDate || anchorCount > 0 || Number(engineState?.sceneTurn || 0) > 0)) {
                    warnings.push('runtime time state has data but scoped lore entry is missing');
                }
            }
            return {
                ok: warnings.length === 0,
                degraded: warnings.length > 0,
                source: 'time_engine',
                scopeKey,
                parserAvailable: !!LibraTimeParser?.parse,
                globalExported: typeof globalThis === 'undefined' || globalThis.LIBRA_TimeEngine === TimeEngine,
                hasCanonicalClock: !!(currentDate || currentTime || lastSceneDate || lastSceneTime || currentLabel || lastSceneLabel),
                currentDate,
                currentTime,
                currentLabel,
                lastSceneDate,
                lastSceneTime,
                lastSceneLabel,
                sceneTurn: Math.max(0, Number(engineState?.sceneTurn || 0)),
                anchorCount,
                datedAnchorCount,
                updatedAt: Number(engineState?.updatedAt || 0),
                updatedAgeMs: Number(engineState?.updatedAt || 0) > 0 ? Math.max(0, Date.now() - Number(engineState.updatedAt || 0)) : null,
                storage,
                warnings: normalizeRuntimeList(warnings, 24, 180)
            };
        };

        const withTemporaryState = callback => {
            const previous = engineState;
            try {
                engineState = safeClone(previous);
                const result = callback();
                if (result && typeof result.then === 'function') throw new Error('management_prepare_must_be_synchronous');
                return result;
            } finally { engineState = previous; }
        };
        return {
            withTemporaryState,
            loadState, saveState, resetState, getState,
            ingestEntityTracking, ingestLiveTurn, getProjection, projectEntity,
            renameEntityAnchor,
            selfCheck,
            parse: LibraTimeParser.parse,
            resolveTextTarget: LibraTimeParser.resolveTextTarget,
            getStoryAnchorDate: (lorebook = null) => deriveStoryAnchorDate(lorebook)
        };
    })();
    if (typeof globalThis !== 'undefined') {
        globalThis.LIBRA_TimeParser = LibraTimeParser;
        globalThis.LIBRA_TimeEngine = TimeEngine;
        globalThis.LIBRA_getEntityTimeProjection = (entityOrName, maybeEntity = null) => {
            const entity = maybeEntity && typeof maybeEntity === 'object'
                ? maybeEntity
                : (entityOrName && typeof entityOrName === 'object' ? entityOrName : {});
            const entityName = typeof entityOrName === 'string' ? entityOrName : (entity?.name || '');
            return TimeEngine.getProjection(entityName, entity);
        };
    }

    const buildTemporalPrecisionPrompt = (focusEntities = [], options = {}) => {
        const focusNames = (Array.isArray(focusEntities) ? focusEntities : [])
            .map(item => String(item?.name || item || '').trim())
            .filter(Boolean);
        const timeState = TimeEngine.getState?.() || {};
        const currentClock = [timeState.currentDate, timeState.currentTime].map(v => String(v || '').trim()).filter(Boolean).join(' ');
        const lastSceneClock = [timeState.lastSceneDate, timeState.lastSceneTime].map(v => String(v || '').trim()).filter(Boolean).join(' ');
        const currentLabel = String(timeState.currentLabel || '').trim() || currentClock;
        const lastSceneLabel = String(timeState.lastSceneLabel || '').trim() || lastSceneClock;
        const lines = [
            '[시간 정밀도 / Temporal Precision]',
            '특정 사실, 사건, 약속, 만남, 상태 변화의 시점을 말할 때는 "어제", "최근", "전날", "저번에", "last time", "yesterday"만 단독으로 쓰지 마세요.',
            '시간 엔진에 날짜/시각 anchor가 있으면 상대 표현 대신 정확한 날짜/시각을 우선 쓰고, 필요할 때만 괄호로 상대 표현을 덧붙이세요. 예: "YYYY-MM-DD 밤(어제)"',
            '정확한 날짜가 없으면 추측해서 만들지 말고, "정확한 날짜는 확정되지 않았지만"처럼 불확실성을 유지하세요.'
        ];
        if (currentLabel) lines.push(`canonical_now: ${currentLabel}`);
        if (currentLabel && currentClock && currentLabel !== currentClock) lines.push(`canonical_now_normalized: ${currentClock}`);
        if (lastSceneLabel) lines.push(`last_scene_time: ${lastSceneLabel}`);
        if (lastSceneLabel && lastSceneClock && lastSceneLabel !== lastSceneClock) lines.push(`last_scene_time_normalized: ${lastSceneClock}`);
        const sceneTurn = Math.max(0, Number(timeState.sceneTurn || 0));
        if (sceneTurn > 0) lines.push(`scene_turn: ${sceneTurn}`);
        const notes = String(timeState.notes || '').replace(/\s+/g, ' ').trim();
        if (notes) lines.push(`time_notes: ${truncateForLLM(notes, 180, ' ... ')}`);

        const anchors = timeState.entityAnchors && typeof timeState.entityAnchors === 'object'
            ? timeState.entityAnchors
            : {};
        const maxAnchors = Math.max(0, Number(options?.maxEntityAnchors || 5));
        const selectedKeys = [];
        const pushKey = (key) => {
            const normalized = String(key || '').trim().toLowerCase();
            if (!normalized || selectedKeys.includes(normalized) || !anchors[normalized]) return;
            selectedKeys.push(normalized);
        };
        focusNames.forEach(pushKey);
        Object.keys(anchors).sort().forEach(key => {
            if (selectedKeys.length >= maxAnchors) return;
            pushKey(key);
        });
        for (const key of selectedKeys.slice(0, maxAnchors)) {
            const anchor = anchors[key] || {};
            const entityNow = [anchor.currentDate, anchor.currentTime].map(v => String(v || '').trim()).filter(Boolean).join(' ');
            const interaction = [anchor.lastInteractionDate, anchor.lastInteractionTime].map(v => String(v || '').trim()).filter(Boolean).join(' ');
            const intimacy = [anchor.lastIntimacyDate, anchor.lastIntimacyTime].map(v => String(v || '').trim()).filter(Boolean).join(' ');
            if (entityNow) lines.push(`entity_time.${key}: ${entityNow}`);
            if (interaction) lines.push(`entity_last_interaction.${key}: ${interaction}`);
            if (intimacy) lines.push(`entity_last_intimacy.${key}: ${intimacy}`);
        }

        return lines.join('\n');
    };
