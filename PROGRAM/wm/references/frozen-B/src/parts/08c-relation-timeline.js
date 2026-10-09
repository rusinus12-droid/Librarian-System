        const normalizeRelationAxis01 = (value, fallback = 0) => normalizeEntity01(value, fallback);
        const buildRelationPullFromAxes = (axes = null) => {
            const source = axes && typeof axes === 'object' ? axes : {};
            const interest = normalizeRelationAxis01(source.interest, 0);
            const love = normalizeRelationAxis01(source.love, 0);
            const lust = normalizeRelationAxis01(source.lust, 0);
            return Math.max(0, Math.min(1, (interest * 0.45) + (love * 0.35) + (lust * 0.2)));
        };
        const normalizeRelationState = (relation = {}) => {
            const source = relation?.state && typeof relation.state === 'object' ? relation.state : {};
            const details = relation?.details && typeof relation.details === 'object' ? relation.details : {};
            const metrics = relation?.metrics && typeof relation.metrics === 'object' ? relation.metrics : {};
            const sentiments = relation?.sentiments && typeof relation.sentiments === 'object' ? relation.sentiments : {};
            const closeness = normalizeNullableRelationScore(source.distance ?? source.closeness ?? details.closeness ?? metrics.closeness);
            const trust = normalizeNullableRelationScore(source.trust ?? details.trust ?? metrics.trust);
            const pull = source.pull ?? buildRelationPullFromAxes(relation?.axes || {});
            const tension = source.tension ?? metrics.tension ?? metrics.currentTension ?? sentiments.currentTension;
            return {
                distance: normalizeRelationAxis01(closeness, 0.3),
                trust: normalizeRelationAxis01(trust, 0.5),
                pull: normalizeRelationAxis01(pull, 0.15),
                tension: normalizeRelationAxis01(tension, 0)
            };
        };
        const createDefaultRelationAxes = (relation = {}) => {
            const state = normalizeRelationState(relation || {});
            return {
                cognition: Math.max(0.08, Math.min(1, 0.18 + (state.trust * 0.45) + (state.distance * 0.18))),
                interest: Math.max(0.08, Math.min(1, 0.14 + (state.pull * 0.72) + (state.tension * 0.08))),
                intimacy: state.distance,
                love: Math.max(0.02, Math.min(1, state.pull * (0.25 + (state.distance * 0.55)))),
                lust: Math.max(0.02, Math.min(1, state.pull * (0.16 + (state.distance * 0.42)))),
                trust: state.trust,
                respect: Math.max(0.08, Math.min(1, (state.trust * 0.68) + 0.12)),
                obedience: 0.08
            };
        };
        const normalizeRelationAxes = (axes = null, relation = {}) => {
            const base = createDefaultRelationAxes(relation || {});
            const source = axes && typeof axes === 'object' && !Array.isArray(axes) ? axes : {};
            const next = { ...base };
            for (const key of Object.keys(next)) {
                next[key] = normalizeRelationAxis01(Object.prototype.hasOwnProperty.call(source, key) ? source[key] : next[key], next[key]);
            }
            return next;
        };
        const normalizeRelationSpeechRankHint = (value = '') => {
            const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
            if (!raw) return '';
            if (['peer', 'peers', 'equal', 'same_level', 'same_rank', '동급', '또래'].includes(raw)) return 'peer';
            if (['entitya_superior', 'a_superior', 'a_superior_to_b', 'a>b', 'a_gt_b', 'entitya_senior', 'a_senior'].includes(raw)) return 'entityA_superior';
            if (['entityb_superior', 'b_superior', 'b_superior_to_a', 'b>a', 'b_gt_a', 'entityb_senior', 'b_senior'].includes(raw)) return 'entityB_superior';
            if (['mutual_honorific', 'both_honorific', 'mutual_polite', '상호존대'].includes(raw)) return 'mutual_honorific';
            if (['mutual_casual', 'both_casual', '상호반말'].includes(raw)) return 'mutual_casual';
            return clampEntityText(raw, 80);
        };
        const normalizeRelationSpeechDynamics = (speechDynamics = null) => {
            const source = speechDynamics && typeof speechDynamics === 'object' && !Array.isArray(speechDynamics) ? speechDynamics : {};
            return {
                rankHint: normalizeRelationSpeechRankHint(source.rankHint || source.hierarchy || source.rank || ''),
                addressAtoB: clampEntityText(source.addressAtoB || source.callAtoB || source.titleAtoB || '', 80),
                addressBtoA: clampEntityText(source.addressBtoA || source.callBtoA || source.titleBtoA || '', 80),
                styleAtoB: clampEntityText(source.styleAtoB || source.formalityAtoB || source.registerAtoB || '', 120),
                styleBtoA: clampEntityText(source.styleBtoA || source.formalityBtoA || source.registerBtoA || '', 120),
                notes: normalizeEntityList(source.notes || source.speechNotes || [], 8, 160)
            };
        };
        const mergeRelationSpeechDynamics = (baseSpeech = {}, incomingSpeech = {}, force = false) => {
            const base = normalizeRelationSpeechDynamics(baseSpeech);
            const incoming = normalizeRelationSpeechDynamics(incomingSpeech);
            const next = { ...base };
            ['rankHint', 'addressAtoB', 'addressBtoA', 'styleAtoB', 'styleBtoA'].forEach(key => {
                if (incoming[key] && (force || !next[key])) next[key] = incoming[key];
            });
            next.notes = normalizeEntityList([...(base.notes || []), ...(incoming.notes || [])], 10, 160);
            return next;
        };
        const mergeRelationAxes = (baseAxes = {}, incomingAxes = {}, relation = {}, options = {}) => {
            const base = normalizeRelationAxes(baseAxes, relation);
            const incoming = incomingAxes && typeof incomingAxes === 'object' && !Array.isArray(incomingAxes) ? incomingAxes : {};
            const next = { ...base };
            for (const key of Object.keys(next)) {
                if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
                const incomingValue = normalizeNullableRelationScore(incoming[key]);
                if (incomingValue == null) continue;
                next[key] = options.forceReplace === false
                    ? normalizeRelationAxis01(incomingValue, next[key])
                    : normalizeRelationAxis01(incomingValue, next[key]);
            }
            return next;
        };

        // ── [RELATION TIMELINE] immutable turn deltas + current projection
        const RELATION_TIMELINE_SCHEMA = 'libra.relation.timeline.v1';
        const RELATION_TIMELINE_LIMIT = 96;
        const RELATION_SCORE_KEYS = Object.freeze(['closeness', 'trust', 'tension', 'risk', 'ambiguity', 'pressure']);
        const RELATION_AXIS_KEYS = Object.freeze(['cognition', 'interest', 'intimacy', 'love', 'lust', 'trust', 'respect', 'obedience']);
        const normalizeRelationEventStatus = (value = '') => {
            const status = String(value || 'active').trim().toLowerCase();
            return ['active', 'superseded', 'retracted', 'deleted', 'invalidated'].includes(status) ? status : 'active';
        };
        const isActiveRelationEvent = (event = null) => normalizeRelationEventStatus(event?.status) === 'active';
        const relationOwnFinite = (source = null, key = '') => {
            if (!source || typeof source !== 'object' || !Object.prototype.hasOwnProperty.call(source, key)) return null;
            return normalizeNullableRelationScore(source[key]);
        };
        const compactRelationScoreMap = (source = null, keys = RELATION_SCORE_KEYS, preserveNullableScores = false) => {
            const out = {};
            if (!source || typeof source !== 'object') return out;
            for (const key of keys) {
                if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
                const value = relationOwnFinite(source, key);
                if (value != null) out[key] = value;
                else if (preserveNullableScores && (key === 'closeness' || key === 'trust') && source[key] == null) out[key] = null;
            }
            return out;
        };
        const compactRelationDeltaMap = (source = null, keys = RELATION_SCORE_KEYS) => {
            const out = {};
            if (!source || typeof source !== 'object') return out;
            for (const key of keys) {
                if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
                const value = Number(source[key]);
                if (Number.isFinite(value) && value !== 0) out[key] = Math.max(-1, Math.min(1, value));
            }
            return out;
        };
        const relationTimelineBaselineFromRecord = (relation = {}) => ({
            scores: {
                closeness: normalizeNullableRelationScore(relation?.details?.closeness ?? relation?.metrics?.closeness),
                trust: normalizeNullableRelationScore(relation?.details?.trust ?? relation?.metrics?.trust),
                tension: normalizeRelationAxis01(relation?.metrics?.tension ?? relation?.sentiments?.currentTension, 0),
                risk: normalizeRelationAxis01(relation?.metrics?.risk, 0),
                ambiguity: normalizeRelationAxis01(relation?.metrics?.ambiguity, 0.65),
                pressure: normalizeRelationAxis01(relation?.metrics?.pressure, 0)
            },
            axes: compactRelationScoreMap(normalizeRelationAxes(relation?.axes || {}, relation), RELATION_AXIS_KEYS),
            relationType: clampEntityText(relation?.relationType || '', 100),
            turn: Math.max(0, Number(relation?.meta?.created || relation?.meta?.updated || 0) || 0),
            source: String(relation?.meta?.source || 'legacy_projection').trim() || 'legacy_projection'
        });
        const normalizeRelationTimelineEvent = (event = {}, relation = {}) => {
            const sourceMessageIds = dedupeTextArray([
                event.sourceMessageId,
                event.messageId,
                event.m_id,
                ...(Array.isArray(event.sourceMessageIds) ? event.sourceMessageIds : [])
            ].map(value => String(value || '').trim()).filter(Boolean)).slice(-8);
            const turn = Math.max(0, Number(event.turn ?? event.sourceTurn ?? event.updatedTurn ?? 0) || 0);
            const sourceAnchor = sourceMessageIds[0]
                || String(event.sourceId || event.s_id || '').trim()
                || `turn:${turn}`;
            const eventText = clampEntityText(event.event || event.summary || event.text || '', 220);
            const canonicalSlot = String(event.canonicalSlot || event.slot || 'current_projection').trim() || 'current_projection';
            const relationId = String(relation?.id || [relation?.entityA, relation?.entityB].filter(Boolean).join('::')).trim();
            const id = String(event.id || '').trim()
                || `relation_delta::${TokenizerEngine.simpleHash(`${relationId}|${sourceAnchor}|${canonicalSlot}`)}`;
            const absolute = event.absolute && typeof event.absolute === 'object' ? event.absolute : {};
            const delta = event.delta && typeof event.delta === 'object' ? event.delta : {};
            return {
                id,
                schema: 'libra.relation.delta.v1',
                canonicalSlot,
                turn,
                sequence: Math.max(0, Number(event.sequence || 0) || 0),
                status: normalizeRelationEventStatus(event.status || event.provenanceStatus),
                source: String(event.source || event.sourceKind || 'relation_update').trim() || 'relation_update',
                sourceId: String(event.sourceId || event.s_id || '').trim(),
                sourceMessageId: sourceMessageIds[0] || '',
                sourceMessageIds,
                sourceRevision: Math.max(0, Number(event.sourceRevision || event.revision || 0) || 0),
                event: eventText,
                sentiment: clampEntityText(event.sentiment || event.eventSentiment || '', 60),
                relationType: clampEntityText(event.relationType || '', 100),
                absolute: {
                    scores: compactRelationScoreMap(absolute.scores || absolute.metrics || absolute, RELATION_SCORE_KEYS, true),
                    axes: compactRelationScoreMap(absolute.axes || {}, RELATION_AXIS_KEYS)
                },
                delta: {
                    scores: compactRelationDeltaMap(delta.scores || delta.metrics || delta, RELATION_SCORE_KEYS),
                    axes: compactRelationDeltaMap(delta.axes || {}, RELATION_AXIS_KEYS)
                },
                supersededBy: String(event.supersededBy || '').trim(),
                reason: clampEntityText(event.reason || event.staleReason || '', 120),
                confidence: normalizeRelationAxis01(event.confidence, 0),
                updatedTurn: Math.max(turn, Number(event.updatedTurn || 0) || 0)
            };
        };
        const foldRelationEventIntoTimelineBaseline = (baseline = {}, event = {}, relation = {}) => {
            if (!isActiveRelationEvent(event)) return baseline;
            const next = {
                ...baseline,
                scores: { ...(baseline.scores || {}) },
                axes: { ...(baseline.axes || {}) }
            };
            for (const key of RELATION_SCORE_KEYS) {
                if (Object.prototype.hasOwnProperty.call(event.absolute?.scores || {}, key)) {
                    next.scores[key] = normalizeNullableRelationScore(event.absolute.scores[key]);
                } else if (Object.prototype.hasOwnProperty.call(event.delta?.scores || {}, key)) {
                    next.scores[key] = applyRelationProjectedDelta(next.scores[key], event.delta.scores[key], key);
                }
            }
            for (const key of RELATION_AXIS_KEYS) {
                if (Object.prototype.hasOwnProperty.call(event.absolute?.axes || {}, key)) {
                    next.axes[key] = normalizeRelationAxis01(event.absolute.axes[key], next.axes[key]);
                } else if (Object.prototype.hasOwnProperty.call(event.delta?.axes || {}, key)) {
                    next.axes[key] = applyRelationProjectedDelta(next.axes[key], event.delta.axes[key], key);
                }
            }
            if (event.relationType) next.relationType = event.relationType;
            next.turn = Math.max(Number(next.turn || 0), Number(event.turn || event.updatedTurn || 0));
            next.source = 'timeline_compaction';
            return next;
        };
        const compactRelationHistoryEvent = (rawEvent = {}, relation = {}) => {
            const event = normalizeRelationTimelineEvent(rawEvent, relation);
            return {
                id: event.id,
                schema: event.schema,
                canonicalSlot: event.canonicalSlot,
                turn: event.turn,
                sequence: event.sequence,
                status: event.status,
                source: event.source,
                sourceId: event.sourceId,
                sourceMessageId: event.sourceMessageId,
                sourceMessageIds: event.sourceMessageIds,
                sourceRevision: event.sourceRevision,
                relationType: event.relationType,
                absolute: event.absolute,
                delta: event.delta,
                supersededBy: event.supersededBy,
                reason: event.reason,
                updatedTurn: event.updatedTurn
            };
        };
        const allRelationTimelineEvents = (timeline = {}) => [
            ...(Array.isArray(timeline.history) ? timeline.history : []),
            ...(Array.isArray(timeline.events) ? timeline.events : [])
        ].sort((a, b) => (a.turn - b.turn) || (a.sequence - b.sequence) || String(a.id || '').localeCompare(String(b.id || '')));
        const compactRelationTimeline = (timeline = {}, relation = {}) => {
            const recent = Array.isArray(timeline.events)
                ? timeline.events.map(event => normalizeRelationTimelineEvent(event, relation)).sort((a, b) => (a.turn - b.turn) || (a.sequence - b.sequence) || a.id.localeCompare(b.id))
                : [];
            const historyById = new Map();
            for (const rawEvent of Array.isArray(timeline.history) ? timeline.history : []) {
                const event = compactRelationHistoryEvent(rawEvent, relation);
                const existing = historyById.get(event.id);
                if (!existing || event.sourceRevision > existing.sourceRevision || event.updatedTurn >= existing.updatedTurn) historyById.set(event.id, event);
            }
            if (recent.length > RELATION_TIMELINE_LIMIT) {
                const removeCount = recent.length - RELATION_TIMELINE_LIMIT;
                for (const rawEvent of recent.slice(0, removeCount)) {
                    const event = compactRelationHistoryEvent(rawEvent, relation);
                    const existing = historyById.get(event.id);
                    if (!existing || event.sourceRevision > existing.sourceRevision || event.updatedTurn >= existing.updatedTurn) historyById.set(event.id, event);
                }
                timeline.events = recent.slice(removeCount);
            } else {
                timeline.events = recent;
            }
            for (const event of timeline.events) historyById.delete(event.id);
            timeline.history = Array.from(historyById.values())
                .sort((a, b) => (a.turn - b.turn) || (a.sequence - b.sequence) || a.id.localeCompare(b.id));
            if (timeline.history.length > 0) {
                timeline.compaction = {
                    compactedEvents: timeline.history.length,
                    throughTurn: Math.max(Number(timeline.compaction?.throughTurn || 0), ...timeline.history.map(event => Number(event.turn || 0))),
                    lastReason: 'reversible_history_compaction',
                    provenanceRetained: true
                };
            } else if (timeline.compaction?.provenanceRetained === true) {
                timeline.compaction = { compactedEvents: 0, throughTurn: 0, lastReason: 'reversible_history_compaction', provenanceRetained: true };
            }
            return timeline;
        };

        const ensureRelationTimeline = (relation = {}, options = {}) => {
            if (!relation || typeof relation !== 'object') return null;
            const raw = relation.relationTimeline && typeof relation.relationTimeline === 'object'
                ? relation.relationTimeline
                : (relation.relation_timeline && typeof relation.relation_timeline === 'object' ? relation.relation_timeline : null);
            const timeline = raw || {
                schema: RELATION_TIMELINE_SCHEMA,
                baseline: relationTimelineBaselineFromRecord(relation),
                history: [],
                events: [],
                projection: {},
                revision: 0
            };
            timeline.schema = RELATION_TIMELINE_SCHEMA;
            if (timeline.baseline && typeof timeline.baseline === 'object') {
                const fallbackBaseline = relationTimelineBaselineFromRecord(relation);
                const rawBaselineScores = timeline.baseline.scores && typeof timeline.baseline.scores === 'object' ? timeline.baseline.scores : {};
                const normalizedBaselineScores = { ...fallbackBaseline.scores };
                for (const key of RELATION_SCORE_KEYS) {
                    if (!Object.prototype.hasOwnProperty.call(rawBaselineScores, key)) continue;
                    if ((key === 'closeness' || key === 'trust') && rawBaselineScores[key] == null) normalizedBaselineScores[key] = null;
                    else {
                        const value = normalizeNullableRelationScore(rawBaselineScores[key]);
                        if (value != null) normalizedBaselineScores[key] = value;
                    }
                }
                timeline.baseline = {
                    ...fallbackBaseline,
                    ...timeline.baseline,
                    scores: normalizedBaselineScores,
                    axes: {
                        ...fallbackBaseline.axes,
                        ...compactRelationScoreMap(timeline.baseline.axes || {}, RELATION_AXIS_KEYS)
                    }
                };
            } else {
                timeline.baseline = relationTimelineBaselineFromRecord(relation);
            }
            const byId = new Map();
            for (const rawEvent of [...(Array.isArray(timeline.history) ? timeline.history : []), ...(Array.isArray(timeline.events) ? timeline.events : [])]) {
                const event = normalizeRelationTimelineEvent(rawEvent, relation);
                const existing = byId.get(event.id);
                if (!existing || event.sourceRevision > existing.sourceRevision || event.updatedTurn >= existing.updatedTurn) byId.set(event.id, event);
            }
            const normalizedAll = Array.from(byId.values())
                .sort((a, b) => (a.turn - b.turn) || (a.sequence - b.sequence) || a.id.localeCompare(b.id));
            timeline.history = normalizedAll.slice(0, Math.max(0, normalizedAll.length - RELATION_TIMELINE_LIMIT)).map(event => compactRelationHistoryEvent(event, relation));
            timeline.events = normalizedAll.slice(-RELATION_TIMELINE_LIMIT);
            compactRelationTimeline(timeline, relation);
            timeline.revision = Math.max(0, Number(timeline.revision || 0) || 0);
            relation.relationTimeline = timeline;
            delete relation.relation_timeline;
            return timeline;
        };
        const applyRelationProjectedDelta = (current, delta, key = '') => {
            const base = normalizeNullableRelationScore(current) ?? (key === 'ambiguity' ? 0.65 : 0);
            const numericDelta = Number(delta);
            if (!Number.isFinite(numericDelta)) return base;
            const scale = key === 'closeness' || key === 'trust' ? RELATION_DELTA_SCALE : 1;
            return Math.max(0, Math.min(1, base + (numericDelta * scale)));
        };
        const recomputeRelationProjection = (relation = {}) => {
            const timeline = ensureRelationTimeline(relation);
            if (!timeline) return relation;
            const baseline = timeline.baseline || relationTimelineBaselineFromRecord(relation);
            const scores = {
                closeness: normalizeNullableRelationScore(baseline?.scores?.closeness),
                trust: normalizeNullableRelationScore(baseline?.scores?.trust),
                tension: normalizeRelationAxis01(baseline?.scores?.tension, 0),
                risk: normalizeRelationAxis01(baseline?.scores?.risk, 0),
                ambiguity: normalizeRelationAxis01(baseline?.scores?.ambiguity, 0.65),
                pressure: normalizeRelationAxis01(baseline?.scores?.pressure, 0)
            };
            const axes = {
                ...normalizeRelationAxes(baseline?.axes || {}, { ...relation, details: { ...(relation.details || {}), closeness: scores.closeness, trust: scores.trust }, metrics: scores })
            };
            let latestRelationType = clampEntityText(baseline?.relationType || relation.relationType || '', 100);
            let lastChangedTurn = Math.max(0, Number(baseline?.turn || 0) || 0);
            for (const event of allRelationTimelineEvents(timeline)) {
                if (!isActiveRelationEvent(event)) continue;
                if (event.relationType) latestRelationType = event.relationType;
                for (const key of RELATION_SCORE_KEYS) {
                    if (Object.prototype.hasOwnProperty.call(event.absolute?.scores || {}, key)) {
                        scores[key] = normalizeNullableRelationScore(event.absolute.scores[key]);
                    } else if (Object.prototype.hasOwnProperty.call(event.delta?.scores || {}, key)) {
                        scores[key] = applyRelationProjectedDelta(scores[key], event.delta.scores[key], key);
                    }
                }
                for (const key of RELATION_AXIS_KEYS) {
                    if (Object.prototype.hasOwnProperty.call(event.absolute?.axes || {}, key)) {
                        axes[key] = normalizeRelationAxis01(event.absolute.axes[key], axes[key]);
                    } else if (Object.prototype.hasOwnProperty.call(event.delta?.axes || {}, key)) {
                        axes[key] = applyRelationProjectedDelta(axes[key], event.delta.axes[key], key);
                    }
                }
                lastChangedTurn = Math.max(lastChangedTurn, event.turn || 0, event.updatedTurn || 0);
            }
            relation.relationType = latestRelationType || relation.relationType || '첫 대면';
            relation.details = relation.details && typeof relation.details === 'object' ? relation.details : {};
            relation.metrics = relation.metrics && typeof relation.metrics === 'object' ? relation.metrics : {};
            relation.sentiments = relation.sentiments && typeof relation.sentiments === 'object' ? relation.sentiments : {};
            relation.details.closeness = scores.closeness;
            relation.details.trust = scores.trust;
            relation.metrics = { ...relation.metrics, ...scores };
            relation.sentiments.currentTension = scores.tension;
            relation.axes = normalizeRelationAxes(axes, relation);
            relation.state = normalizeRelationState({ ...relation, state: { distance: scores.closeness, trust: scores.trust, pull: buildRelationPullFromAxes(relation.axes), tension: scores.tension } });
            relation.currentStatus = relation.currentStatus && typeof relation.currentStatus === 'object' ? relation.currentStatus : {};
            relation.currentStatus.lastChangedTurn = Math.max(Number(relation.currentStatus.lastChangedTurn || 0), lastChangedTurn);
            timeline.projection = {
                scores: { ...scores },
                axes: { ...relation.axes },
                relationType: relation.relationType,
                lastChangedTurn
            };
            return relation;
        };
        const relationUpdateEventFromPatch = (relation = {}, updates = {}, options = {}) => {
            const relationDelta = updates.relationDelta && typeof updates.relationDelta === 'object' ? updates.relationDelta : {};
            const relationAbsolute = updates.relationAbsolute && typeof updates.relationAbsolute === 'object' ? updates.relationAbsolute : {};
            const details = updates.details && typeof updates.details === 'object' ? updates.details : {};
            const metrics = updates.metrics && typeof updates.metrics === 'object' ? updates.metrics : {};
            const sentiments = updates.sentiments && typeof updates.sentiments === 'object' ? updates.sentiments : {};
            const axes = updates.axes && typeof updates.axes === 'object' ? updates.axes : {};
            const axisDeltas = updates.axisDeltas && typeof updates.axisDeltas === 'object' ? updates.axisDeltas : {};
            const absoluteScores = { ...compactRelationScoreMap(relationAbsolute.scores || relationAbsolute.metrics || {}, RELATION_SCORE_KEYS, true) };
            const deltaScores = { ...compactRelationDeltaMap(relationDelta.scores || relationDelta.metrics || relationDelta, RELATION_SCORE_KEYS) };
            const explicitClosenessDelta = updates.closenessDelta ?? details.closenessDelta ?? relationDelta.closeness;
            const explicitTrustDelta = updates.trustDelta ?? details.trustDelta ?? relationDelta.trust;
            const explicitTensionDelta = updates.tensionDelta ?? sentiments.tensionDelta ?? metrics.tensionDelta ?? relationDelta.tension;
            if (Number.isFinite(Number(explicitClosenessDelta)) && Number(explicitClosenessDelta) !== 0) deltaScores.closeness = Math.max(-1, Math.min(1, Number(explicitClosenessDelta)));
            if (Number.isFinite(Number(explicitTrustDelta)) && Number(explicitTrustDelta) !== 0) deltaScores.trust = Math.max(-1, Math.min(1, Number(explicitTrustDelta)));
            if (Number.isFinite(Number(explicitTensionDelta)) && Number(explicitTensionDelta) !== 0) deltaScores.tension = Math.max(-1, Math.min(1, Number(explicitTensionDelta)));
            if (!Object.prototype.hasOwnProperty.call(deltaScores, 'closeness') && Object.prototype.hasOwnProperty.call(details, 'closeness')) {
                const value = relationOwnFinite(details, 'closeness');
                if (value != null || details.closeness == null) absoluteScores.closeness = value;
            }
            if (!Object.prototype.hasOwnProperty.call(deltaScores, 'trust') && Object.prototype.hasOwnProperty.call(details, 'trust')) {
                const value = relationOwnFinite(details, 'trust');
                if (value != null || details.trust == null) absoluteScores.trust = value;
            }
            for (const key of ['closeness', 'trust', 'tension', 'risk', 'ambiguity', 'pressure']) {
                if (Object.prototype.hasOwnProperty.call(deltaScores, key)) continue;
                const value = relationOwnFinite(metrics, key);
                if (value != null) absoluteScores[key] = value;
            }
            if (!Object.prototype.hasOwnProperty.call(deltaScores, 'tension') && Object.prototype.hasOwnProperty.call(sentiments, 'currentTension')) {
                const value = normalizeNullableRelationScore(sentiments.currentTension);
                if (value != null) absoluteScores.tension = value;
            }
            const sourceMessageIds = dedupeTextArray([
                updates.m_id,
                updates.messageId,
                ...(Array.isArray(updates.sourceMessageIds) ? updates.sourceMessageIds : [])
            ].map(value => String(value || '').trim()).filter(Boolean)).slice(-8);
            const currentTurn = Math.max(0, Number(options.currentTurn ?? MemoryState.currentTurn ?? 0) || 0);
            const sourceAnchor = sourceMessageIds[0] || String(updates.s_id || updates.sourceId || '').trim() || `turn:${currentTurn}`;
            const canonicalSlot = String(updates.canonicalFactSlot || 'current_projection').trim() || 'current_projection';
            const id = `relation_delta::${TokenizerEngine.simpleHash(`${relation.id}|${sourceAnchor}|${canonicalSlot}`)}`;
            const event = normalizeRelationTimelineEvent({
                id,
                canonicalSlot,
                turn: currentTurn,
                status: updates.provenanceStatus || updates.status || 'active',
                source: updates.source || options.sourceMode || 'conversation',
                sourceId: updates.s_id || updates.sourceId || '',
                sourceMessageIds,
                sourceRevision: updates.sourceRevision || updates.revision || 0,
                event: updates.event || '',
                sentiment: updates.eventSentiment || '',
                relationType: updates.relationType || '',
                absolute: { scores: absoluteScores, axes: compactRelationScoreMap(relationAbsolute.axes || axes, RELATION_AXIS_KEYS) },
                delta: { scores: deltaScores, axes: compactRelationDeltaMap(relationDelta.axes || axisDeltas, RELATION_AXIS_KEYS) },
                confidence: updates.quality?.confidence ?? updates.confidence ?? 0,
                updatedTurn: currentTurn
            }, relation);
            const hasNumericChange = Object.keys(event.absolute.scores).length || Object.keys(event.absolute.axes).length || Object.keys(event.delta.scores).length || Object.keys(event.delta.axes).length;
            const hasSemanticChange = !!(event.event || event.relationType || updates.currentStatus || updates.dynamics || updates.sentiments?.fromAtoB || updates.sentiments?.fromBtoA);
            return hasNumericChange || hasSemanticChange ? event : null;
        };
        const upsertRelationTimelineEvent = (relation = {}, rawEvent = null) => {
            if (!rawEvent) return { changed: false, event: null };
            const timeline = ensureRelationTimeline(relation);
            const event = normalizeRelationTimelineEvent(rawEvent, relation);
            const recentIndex = timeline.events.findIndex(item => item.id === event.id);
            const historyIndex = (timeline.history || []).findIndex(item => item.id === event.id);
            let changed = false;
            if (recentIndex >= 0) {
                const previous = timeline.events[recentIndex];
                const previousSig = JSON.stringify(previous);
                const next = event.sourceRevision >= previous.sourceRevision ? event : previous;
                timeline.events[recentIndex] = next;
                changed = previousSig !== JSON.stringify(next);
            } else if (historyIndex >= 0) {
                const previous = timeline.history[historyIndex];
                const previousSig = JSON.stringify(previous);
                const next = event.sourceRevision >= previous.sourceRevision ? compactRelationHistoryEvent(event, relation) : previous;
                timeline.history[historyIndex] = next;
                changed = previousSig !== JSON.stringify(next);
            } else {
                timeline.events.push(event);
                changed = true;
            }
            compactRelationTimeline(timeline, relation);
            if (changed) timeline.revision = Math.max(0, Number(timeline.revision || 0)) + 1;
            recomputeRelationProjection(relation);
            return { changed, event };
        };
        const mergeRelationTimelines = (baseRelation = {}, incomingRelation = {}) => {
            const baseTimeline = ensureRelationTimeline(baseRelation);
            const incomingTimeline = ensureRelationTimeline(incomingRelation);
            const baseUpdated = Math.max(0, Number(baseRelation?.meta?.updated || baseTimeline?.baseline?.turn || 0) || 0);
            const incomingUpdated = Math.max(0, Number(incomingRelation?.meta?.updated || incomingTimeline?.baseline?.turn || 0) || 0);
            if ((baseTimeline.events?.length || 0) === 0 && (incomingTimeline.events?.length || 0) === 0 && incomingUpdated >= baseUpdated) {
                baseTimeline.baseline = JSON.parse(JSON.stringify(incomingTimeline.baseline));
            } else if (Number(incomingTimeline?.baseline?.turn || 0) < Number(baseTimeline?.baseline?.turn || 0)) {
                baseTimeline.baseline = JSON.parse(JSON.stringify(incomingTimeline.baseline));
            }
            const byId = new Map();
            for (const rawEvent of [...allRelationTimelineEvents(baseTimeline), ...allRelationTimelineEvents(incomingTimeline)]) {
                const event = normalizeRelationTimelineEvent(rawEvent, baseRelation);
                const current = byId.get(event.id);
                if (!current || event.sourceRevision > current.sourceRevision || event.updatedTurn >= current.updatedTurn) byId.set(event.id, event);
            }
            const mergedEvents = Array.from(byId.values())
                .sort((a, b) => (a.turn - b.turn) || (a.sequence - b.sequence) || a.id.localeCompare(b.id));
            baseTimeline.history = mergedEvents.slice(0, Math.max(0, mergedEvents.length - RELATION_TIMELINE_LIMIT)).map(event => compactRelationHistoryEvent(event, baseRelation));
            baseTimeline.events = mergedEvents.slice(-RELATION_TIMELINE_LIMIT);
            compactRelationTimeline(baseTimeline, baseRelation);
            baseTimeline.revision = Math.max(Number(baseTimeline.revision || 0), Number(incomingTimeline.revision || 0));
            recomputeRelationProjection(baseRelation);
            return baseRelation;
        };
        const retractRelationTimelineEvents = (relation = {}, sourceIds = [], options = {}) => {
            const timeline = ensureRelationTimeline(relation);
            const targets = new Set((Array.isArray(sourceIds) ? sourceIds : [sourceIds]).map(value => String(value || '').trim()).filter(Boolean));
            if (!targets.size) return 0;
            const nextStatus = normalizeRelationEventStatus(options.status || 'retracted');
            const supersededBy = String(options.supersededBy || '').trim();
            const reason = clampEntityText(options.reason || nextStatus, 120);
            let changed = 0;
            let timelineChanged = 0;
            const matchesTargets = values => values.map(value => String(value || '').trim()).filter(Boolean).some(id => targets.has(id));
            for (const event of allRelationTimelineEvents(timeline)) {
                if (!matchesTargets([event.sourceMessageId, ...(event.sourceMessageIds || []), event.sourceId])) continue;
                if (event.status === nextStatus && (!supersededBy || event.supersededBy === supersededBy)) continue;
                event.status = nextStatus;
                event.supersededBy = supersededBy;
                event.reason = reason;
                event.updatedTurn = Math.max(event.updatedTurn || 0, MemoryState.currentTurn || 0);
                changed += 1;
                timelineChanged += 1;
            }
            const inactiveEventTexts = new Set();
            if (Array.isArray(relation?.details?.events)) {
                for (const semanticEvent of relation.details.events) {
                    if (!matchesTargets([semanticEvent?.sourceMessageId, semanticEvent?.messageId, semanticEvent?.m_id])) continue;
                    if (normalizeRelationEventStatus(semanticEvent.status) !== nextStatus || (supersededBy && semanticEvent.supersededBy !== supersededBy)) changed += 1;
                    semanticEvent.status = nextStatus;
                    semanticEvent.supersededBy = supersededBy;
                    semanticEvent.reason = reason;
                    const text = String(semanticEvent.event || semanticEvent.summary || '').trim();
                    if (text) inactiveEventTexts.add(text);
                }
            }
            if (Array.isArray(relation?.eventLedger)) {
                for (const ledgerEvent of relation.eventLedger) {
                    if (!matchesTargets([ledgerEvent?.messageId, ledgerEvent?.sourceMessageId, ledgerEvent?.m_id])) continue;
                    if (normalizeRelationEventStatus(ledgerEvent.status) !== nextStatus || (supersededBy && ledgerEvent.supersededBy !== supersededBy)) changed += 1;
                    ledgerEvent.status = nextStatus;
                    ledgerEvent.supersededBy = supersededBy;
                    ledgerEvent.reason = reason;
                    const text = String(ledgerEvent.summary || '').trim();
                    if (text) inactiveEventTexts.add(text);
                }
            }
            if (Array.isArray(relation?.evidence)) {
                for (const evidence of relation.evidence) {
                    if (!matchesTargets([evidence?.messageId, evidence?.sourceMessageId, evidence?.m_id])) continue;
                    if (normalizeRelationEventStatus(evidence.status) !== nextStatus || (supersededBy && evidence.supersededBy !== supersededBy)) changed += 1;
                    evidence.status = nextStatus;
                    evidence.supersededBy = supersededBy;
                    evidence.reason = reason;
                }
            }
            if (inactiveEventTexts.size && Array.isArray(relation?.dynamics?.recentChanges)) {
                relation.dynamics.recentChanges = relation.dynamics.recentChanges.filter(item => !inactiveEventTexts.has(String(item || '').trim()));
            }
            if (changed) {
                timeline.revision = Math.max(0, Number(timeline.revision || 0)) + 1;
                recomputeRelationProjection(relation);
                relation.relationshipAssessment = buildRelationshipAssessment(relation);
            }
            return timelineChanged || changed;
        };
        const formatRelationAxesText = (axes = {}) => {
            const normalized = normalizeRelationAxes(axes, {});
            return ['cognition', 'interest', 'intimacy', 'love', 'lust', 'trust', 'respect', 'obedience']
                .map(key => `${key}=${normalizeRelationAxis01(normalized[key], 0).toFixed(2)}`)
                .join(' | ');
        };
        const formatRelationSpeechDynamicsText = (relation = {}) => {
            const safeRelation = relation && typeof relation === 'object' ? relation : {};
            const dynamics = normalizeRelationSpeechDynamics(safeRelation.speechDynamics || {});
            const entityA = clampEntityText(safeRelation.entityA || 'A', 60) || 'A';
            const entityB = clampEntityText(safeRelation.entityB || 'B', 60) || 'B';
            return [
                dynamics.rankHint ? `hierarchy=${dynamics.rankHint}` : '',
                dynamics.addressAtoB ? `${entityA}->${entityB} address=${dynamics.addressAtoB}` : '',
                dynamics.addressBtoA ? `${entityB}->${entityA} address=${dynamics.addressBtoA}` : '',
                dynamics.styleAtoB ? `${entityA}->${entityB} style=${dynamics.styleAtoB}` : '',
                dynamics.styleBtoA ? `${entityB}->${entityA} style=${dynamics.styleBtoA}` : '',
                dynamics.notes?.length ? `notes=${dynamics.notes.slice(-3).join(' / ')}` : ''
            ].filter(Boolean).join(' | ');
        };

        const normalizeRelationV2Fields = (relation, options = {}) => {
            if (!relation || typeof relation !== 'object') return relation;
            const details = relation.details && typeof relation.details === 'object' ? relation.details : {};
            const sentiments = relation.sentiments && typeof relation.sentiments === 'object' ? relation.sentiments : {};
            const currentStatus = relation.currentStatus && typeof relation.currentStatus === 'object' ? relation.currentStatus : {};
            const rawCurrentStatusText = typeof relation.currentStatus === 'string' ? relation.currentStatus : '';
            const metrics = relation.metrics && typeof relation.metrics === 'object' ? relation.metrics : {};
            const rawState = relation.state && typeof relation.state === 'object' && !Array.isArray(relation.state) ? relation.state : {};
            const rawAxes = relation.axes && typeof relation.axes === 'object' && !Array.isArray(relation.axes) ? relation.axes : {};
            const rawSpeechDynamics = relation.speechDynamics && typeof relation.speechDynamics === 'object' && !Array.isArray(relation.speechDynamics) ? relation.speechDynamics : {};
            const dynamics = relation.dynamics && typeof relation.dynamics === 'object' && !Array.isArray(relation.dynamics) ? relation.dynamics : {};
            const rawDynamicsItems = typeof relation.dynamics === 'string' || Array.isArray(relation.dynamics) ? relation.dynamics : [];
            const sharedContext = relation.sharedContext && typeof relation.sharedContext === 'object' ? relation.sharedContext : {};
            const hasDetailCloseness = Object.prototype.hasOwnProperty.call(details, 'closeness');
            const hasDetailTrust = Object.prototype.hasOwnProperty.call(details, 'trust');
            const closenessScore = normalizeNullableRelationScore(hasDetailCloseness ? details.closeness : metrics.closeness);
            const trustScore = normalizeNullableRelationScore(hasDetailTrust ? details.trust : metrics.trust);
            relation.details = {
                howMet: clampEntityText(details.howMet || relation.howMet || '', 180),
                duration: clampEntityText(details.duration || relation.duration || '', 120),
                closeness: closenessScore,
                trust: trustScore,
                events: Array.isArray(details.events) ? details.events.slice(-12) : []
            };
            relation.currentStatus = {
                summary: clampEntityText(currentStatus.summary || rawCurrentStatusText || relation.current_state || '', 220),
                publicLayer: clampEntityText(currentStatus.publicLayer || currentStatus.public_layer || '', 160),
                privateLayer: clampEntityText(currentStatus.privateLayer || currentStatus.private_layer || '', 180),
                boundaryState: clampEntityText(currentStatus.boundaryState || currentStatus.boundary_state || '', 140),
                lastChangedTurn: normalizeFiniteNumber(currentStatus.lastChangedTurn ?? currentStatus.last_changed_turn ?? sentiments.lastInteraction, 0)
            };
            relation.metrics = {
                closeness: closenessScore,
                trust: trustScore,
                tension: normalizeEntity01(metrics.tension ?? metrics.currentTension, sentiments.currentTension || 0),
                risk: normalizeEntity01(metrics.risk, 0),
                ambiguity: normalizeEntity01(metrics.ambiguity, closenessScore == null && trustScore == null ? 0.65 : 0),
                pressure: normalizeEntity01(metrics.pressure, 0)
            };
            relation.state = normalizeRelationState({ ...relation, state: rawState, metrics: relation.metrics });
            relation.axes = normalizeRelationAxes(rawAxes, relation);
            relation.state.pull = normalizeRelationAxis01(relation.state.pull, buildRelationPullFromAxes(relation.axes));
            relation.speechDynamics = normalizeRelationSpeechDynamics(rawSpeechDynamics);
            const relationEventItems = collectEntityItems(
                relation.event,
                details.event,
                Array.isArray(details.events) ? details.events.filter(item => normalizeRelationEventStatus(item?.status) === 'active').map(item => item?.event || item?.summary || item?.text || item?.brief || '') : []
            );
            relation.dynamics = {
                fromAtoB: normalizeEntityList(collectEntityItems(dynamics.fromAtoB, dynamics.from_a_to_b, sentiments.fromAtoB ? [sentiments.fromAtoB] : []), 12, 180),
                fromBtoA: normalizeEntityList(collectEntityItems(dynamics.fromBtoA, dynamics.from_b_to_a, sentiments.fromBtoA ? [sentiments.fromBtoA] : []), 12, 180),
                unresolvedIssues: normalizeEntityList(collectEntityItems(
                    dynamics.unresolvedIssues,
                    dynamics.unresolved_issues,
                    dynamics.openIssues,
                    dynamics.open_issues,
                    dynamics.pendingIssues,
                    dynamics.pending_issues,
                    dynamics.issues,
                    dynamics.unresolved,
                    dynamics.pendingQuestions,
                    dynamics.pending_questions,
                    dynamics.openQuestions,
                    dynamics.open_questions,
                    dynamics.tensions,
                    dynamics.openTensions,
                    dynamics.open_tensions,
                    relation.unresolvedIssues,
                    relation.unresolved_issues,
                    relation.openIssues,
                    relation.open_issues,
                    relation.pendingIssues,
                    relation.pending_issues,
                    relation.issues,
                    relation.unresolved
                ), 12, 180),
                recentChanges: normalizeEntityList(collectEntityItems(
                    dynamics.recentChanges,
                    dynamics.recent_changes,
                    dynamics.changes,
                    dynamics.relationshipChanges,
                    dynamics.relationship_changes,
                    dynamics.relationshipDeltas,
                    dynamics.relationship_deltas,
                    dynamics.relationDeltas,
                    dynamics.relation_deltas,
                    dynamics.deltas,
                    relation.recentChanges,
                    relation.recent_changes,
                    relation.changes,
                    relation.relationshipChanges,
                    relation.relationship_changes,
                    relation.relationshipDeltas,
                    relation.relationship_deltas,
                    relation.relationDeltas,
                    relation.relation_deltas,
                    rawDynamicsItems,
                    relationEventItems
                ), 12, 180)
            };
            relation.sharedContext = {
                location: clampEntityText(sharedContext.location || '', 160),
                workplace: clampEntityText(sharedContext.workplace || '', 160),
                privateThreads: normalizeEntityList(sharedContext.privateThreads || sharedContext.private_threads || [], 12, 120),
                notes: normalizeEntityList(sharedContext.notes || [], 12, 180)
            };
            relation.eventLedger = normalizeEntityEpisodeLedger(relation.eventLedger || relation.event_ledger || details.events || [], ENTITY_STORAGE_LIMITS.relationEventLedger);
            relation.evidence = normalizeEntityEvidenceItems(relation.evidence || [], ENTITY_STORAGE_LIMITS.relationEvidence);
            relation.quality = normalizeEntityQuality(relation.quality, relation);
            if (options.skipTimeline !== true) {
                ensureRelationTimeline(relation);
                recomputeRelationProjection(relation);
            }
            relation.relationshipAssessment = buildRelationshipAssessment(relation);
            return relation;
        };

        const mergeRelationV2Fields = (baseRelation, incomingRelation, options = {}) => {
            if (!baseRelation || !incomingRelation) return baseRelation;
            normalizeRelationV2Fields(baseRelation);
            normalizeRelationV2Fields(incomingRelation, { skipTimeline: true });
            const force = options.forceReplace === true;
            const allowVolatileState = options.allowVolatileState !== false;
            const baseStatusTurn = Math.max(0, Number(baseRelation.currentStatus?.lastChangedTurn || 0) || 0);
            const incomingStatusTurn = Math.max(0, Number(incomingRelation.currentStatus?.lastChangedTurn || options.currentTurn || MemoryState.currentTurn || 0) || 0);
            const replaceVolatileStatus = allowVolatileState && (force || incomingStatusTurn >= baseStatusTurn);
            ['summary', 'publicLayer', 'privateLayer', 'boundaryState'].forEach(key => {
                const incomingValue = clampEntityText(incomingRelation.currentStatus?.[key] || '', 220);
                if (!incomingValue) return;
                if (replaceVolatileStatus || isSparseEntityText(baseRelation.currentStatus?.[key])) baseRelation.currentStatus[key] = incomingValue;
            });
            if (allowVolatileState) baseRelation.currentStatus.lastChangedTurn = Math.max(baseStatusTurn, incomingStatusTurn);
            if (incomingRelation.relationTimeline || incomingRelation.relation_timeline) mergeRelationTimelines(baseRelation, incomingRelation);
            if (allowVolatileState) {
                baseRelation.speechDynamics = mergeRelationSpeechDynamics(baseRelation.speechDynamics, incomingRelation.speechDynamics, force);
                ['fromAtoB', 'fromBtoA', 'unresolvedIssues', 'recentChanges'].forEach(key => mergeEntityListField(baseRelation.dynamics, incomingRelation.dynamics, key, 14, 180));
                ['privateThreads', 'notes'].forEach(key => mergeEntityListField(baseRelation.sharedContext, incomingRelation.sharedContext, key, 14, 180));
                ['location', 'workplace'].forEach(key => mergeEntityScalar(baseRelation.sharedContext, incomingRelation.sharedContext, key, { force, max: 160 }));
            }
            baseRelation.eventLedger = normalizeEntityEpisodeLedger([...(baseRelation.eventLedger || []), ...(incomingRelation.eventLedger || [])], ENTITY_STORAGE_LIMITS.relationEventLedger);
            baseRelation.evidence = normalizeEntityEvidenceItems([...(baseRelation.evidence || []), ...(incomingRelation.evidence || [])], ENTITY_STORAGE_LIMITS.relationEvidence);
            if (options.sourceMode || options.m_id) {
                baseRelation.evidence = normalizeEntityEvidenceItems([
                    ...(baseRelation.evidence || []),
                    {
                        sourceKind: options.sourceMode || 'relation_update',
                        turn: options.currentTurn || 0,
                        messageId: options.m_id || '',
                        confidence: normalizeEntity01(incomingRelation.quality?.confidence, 0)
                    }
                ], ENTITY_STORAGE_LIMITS.relationEvidence);
            }
            baseRelation.quality.confidence = Math.max(baseRelation.quality.confidence || 0, incomingRelation.quality.confidence || 0);
            baseRelation.quality.salience = Math.max(baseRelation.quality.salience || 0, incomingRelation.quality.salience || 0);
            baseRelation.quality.importance = Math.max(baseRelation.quality.importance || 0, incomingRelation.quality.importance || 0);
            baseRelation.quality.pressure = Math.max(baseRelation.quality.pressure || 0, incomingRelation.quality.pressure || 0);
            baseRelation.quality.lastUpdatedTurn = Math.max(baseRelation.quality.lastUpdatedTurn || 0, incomingRelation.quality.lastUpdatedTurn || 0, options.currentTurn || 0);
            baseRelation.quality.sourceMix = normalizeEntitySourceMix([...(baseRelation.quality.sourceMix || []), ...(incomingRelation.quality.sourceMix || []), options.sourceMode].filter(Boolean), 12, 64);
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
            recomputeRelationProjection(baseRelation);
            return normalizeRelationV2Fields(baseRelation);
        };

