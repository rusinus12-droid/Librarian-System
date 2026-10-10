    const CanonicalPacketContract = (() => {
        const SCHEMA = 'libra.canonical_packet.v3';
        const VERSION = 3;
        const CORE_AXES = ['meta', 'memory', 'entity', 'world', 'narrative', 'guards', 'importance'];
        const OPERATIONS = new Set(['add', 'update', 'resolve', 'no_change']);
        const promptShape = JSON.stringify({
            schema: SCHEMA,
            version: VERSION,
            meta: {
                turn: 0,
                sourceMessageIds: [],
                summary_memory: { summary: '', recall: '' },
                node_memory: { nodes: [] },
                audit_cautions: [],
                overpromotion_risks: []
            },
            memory: {
                events: [{ operation: 'add', id: '', summary: '', entities: [], time: '', location: '', eventType: '', targetIds: [], role: 'subject', factStatus: 'unknown', fields: {}, ruleRefs: [], storyClock: null, visibility: {mode:'private',viewers:[]}, evidenceRefs: [{ turn: 0, messageId: '', spanHash: '', snippet: '', sourceKind: 'assistant' }], importance: 0.0, confidence: 0.0 }],
                facts: [{ operation: 'add', id: '', subject: '', slot: '', value: '', evidenceRefs: [{ turn: 0, messageId: '', spanHash: '', snippet: '', sourceKind: 'assistant' }], importance: 0.0, confidence: 0.0 }],
                open_threads: [{ operation: 'add', id: '', summary: '', status: 'open', evidenceRefs: [{ turn: 0, messageId: '', spanHash: '', snippet: '', sourceKind: 'assistant' }], importance: 0.0, confidence: 0.0 }]
            },
            entity: {
                characters: [{ operation: 'add', name: '', aliases: [], identity: {}, profile: {}, visualCanon: {}, currentState: {}, continuity: {}, povKnowledge: {}, evidenceRefs: [{ turn: 0, messageId: '', spanHash: '', snippet: '', sourceKind: 'assistant' }], quality: { confidence: 0.0 } }],
                relations: [{ operation: 'add', entityA: '', entityB: '', relationType: '', currentStatus: {}, dynamics: {}, evidenceRefs: [{ turn: 0, messageId: '', spanHash: '', snippet: '', sourceKind: 'assistant' }], quality: { confidence: 0.0 } }],
                pov_memories: [],
                secrets: [],
                current_state: []
            },
            world: {
                rules: [], places: [], organizations: [], social_rules: [], phenomena: [], systems: {}, physics: {}, exists: {}, active_events: [], offscreen_threads: [],
                state: { time: '', location: '', scene: '', active_events: [], offscreen_threads: [], evidenceRefs: [], storyClock: null }
            },
            narrative: { scene_phase: '', conflict_traces: [], scene_deltas: [], theme_motifs: [], unresolved_threads: [] },
            guards: { continuity_locks: [], audit_cautions: [], overpromotion_risks: [], conflicts: [], uncertain: [] },
            importance: { overall: 0.0, reason: [] }
        });
        const isFinite01 = (value) => value === undefined || value === null || value === ''
            || (Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1);
        const packetOperationValue = (item = {}) => String(item?.operation || '').trim();
        const validateOperation = (item, path, errors, strictV3) => {
            if (!hasObjectShape(item)) {
                if (strictV3) errors.push(`${path}:object_required`);
                return;
            }
            const operation = packetOperationValue(item);
            if (operation && !OPERATIONS.has(operation)) errors.push(`${path}.operation:invalid`);
            if (strictV3 && !operation) errors.push(`${path}.operation:required`);
            if (!isFinite01(item.confidence ?? item.quality?.confidence)) errors.push(`${path}.confidence:out_of_range`);
            if (!strictV3 || operation === 'no_change') return;
            const evidenceRefs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [];
            const hasGroundedRef = evidenceRefs.some(ref => hasObjectShape(ref)
                && String(ref.snippet || '').trim()
                && (Number(ref.turn || 0) > 0 || String(ref.messageId || ref.spanHash || '').trim()));
            if (!hasGroundedRef) errors.push(`${path}.evidenceRefs:grounded_ref_required`);
        };
        const inspect = (packet, options = {}) => {
            const errors = [];
            if (!hasObjectShape(packet)) return { valid: false, errors: ['packet:object_required'], strictV3: false };
            const strictV3 = packet.schema === SCHEMA || Number(packet.version || 0) >= VERSION;
            if (packet.schema && packet.schema !== SCHEMA && options.allowLegacy !== true) errors.push('schema:unsupported');
            const requiredAxes = options.requireCoreAxes === false ? [] : ['meta', 'memory', 'entity', 'world', 'narrative', 'guards', 'importance'];
            for (const key of requiredAxes) if (!hasObjectShape(packet[key])) errors.push(`${key}:object_required`);
            for (const key of CORE_AXES) {
                if (packet[key] != null && !hasObjectShape(packet[key])) errors.push(`${key}:invalid_type`);
            }
            const arrayContracts = [
                ['memory.events', packet.memory?.events], ['memory.facts', packet.memory?.facts], ['memory.open_threads', packet.memory?.open_threads],
                ['entity.characters', packet.entity?.characters], ['entity.relations', packet.entity?.relations], ['entity.pov_memories', packet.entity?.pov_memories],
                ['entity.secrets', packet.entity?.secrets], ['entity.current_state', packet.entity?.current_state],
                ['world.rules', packet.world?.rules], ['world.places', packet.world?.places], ['world.organizations', packet.world?.organizations],
                ['world.social_rules', packet.world?.social_rules], ['world.phenomena', packet.world?.phenomena],
                ['narrative.conflict_traces', packet.narrative?.conflict_traces], ['narrative.scene_deltas', packet.narrative?.scene_deltas],
                ['narrative.theme_motifs', packet.narrative?.theme_motifs], ['narrative.unresolved_threads', packet.narrative?.unresolved_threads]
            ];
            for (const [path, value] of arrayContracts) if (value != null && !Array.isArray(value)) errors.push(`${path}:array_required`);
            (packet.memory?.events || []).forEach((item, index) => {
                validateOperation(item, `memory.events[${index}]`, errors, strictV3);
                if (strictV3 && packetOperationValue(item) !== 'no_change' && !String(item?.summary || item?.text || '').trim()) errors.push(`memory.events[${index}].summary:required`);
            });
            (packet.memory?.facts || []).forEach((item, index) => {
                validateOperation(item, `memory.facts[${index}]`, errors, strictV3);
                if (strictV3 && packetOperationValue(item) !== 'no_change' && !String(item?.value || item?.summary || item?.text || '').trim()) errors.push(`memory.facts[${index}].value:required`);
            });
            (packet.memory?.open_threads || []).forEach((item, index) => {
                validateOperation(item, `memory.open_threads[${index}]`, errors, strictV3);
                if (strictV3 && packetOperationValue(item) !== 'no_change' && !String(item?.summary || item?.text || '').trim()) errors.push(`memory.open_threads[${index}].summary:required`);
            });
            (packet.entity?.characters || []).forEach((item, index) => {
                validateOperation(item, `entity.characters[${index}]`, errors, strictV3);
                if (hasObjectShape(item) && !String(item.name || item.canonicalName || '').trim()) errors.push(`entity.characters[${index}].name:required`);
            });
            (packet.entity?.relations || []).forEach((item, index) => {
                validateOperation(item, `entity.relations[${index}]`, errors, strictV3);
                if (hasObjectShape(item)) {
                    const pair = Array.isArray(item.pair) ? item.pair : [];
                    if (!String(item.entityA || pair[0] || '').trim() || !String(item.entityB || pair[1] || '').trim()) errors.push(`entity.relations[${index}].endpoints:required`);
                }
            });
            if (packet.world?.state != null && !hasObjectShape(packet.world.state)) errors.push('world.state:object_required');
            return { valid: errors.length === 0, errors, strictV3, schema: packet.schema || 'legacy', version: Number(packet.version || 0) || 0 };
        };
        const validate = (packet, options = {}) => inspect(packet, options).valid ? packet : null;
        return { SCHEMA, VERSION, OPERATIONS, promptShape, inspect, validate };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_CanonicalPacketContract = CanonicalPacketContract;
    } catch (_) { /* optional diagnostics only */ }

    const validateTurnMaintenanceJson = (parsed, includeRpLongTermLlm = false) => {
        if (!hasObjectShape(parsed)) return null;
        const allowedKeys = ['narrativeBrief', 'correction', 'storyAuthor', 'director', 'worldAdditional', 'world_additional', 'userDlcTrackerUpdates', 'user_dlc_tracker_updates'];
        if (includeRpLongTermLlm) allowedKeys.push('longTermMemory');
        if (!allowedKeys.some(key => Object.prototype.hasOwnProperty.call(parsed, key))) return null;
        if (!isMeaningfulJsonContractValue(parsed)) return null;
        if (parsed.correction != null && !hasObjectShape(parsed.correction)) return null;
        if (parsed.storyAuthor != null && !hasObjectShape(parsed.storyAuthor)) return null;
        if (parsed.director != null && !hasObjectShape(parsed.director)) return null;
        if (parsed.longTermMemory != null && !hasObjectShape(parsed.longTermMemory)) return null;
        if (parsed.worldAdditional != null && !hasObjectShape(parsed.worldAdditional)) return null;
        if (parsed.world_additional != null && !hasObjectShape(parsed.world_additional)) return null;
        if (parsed.userDlcTrackerUpdates != null && !hasArrayShape(parsed.userDlcTrackerUpdates)) return null;
        if (parsed.user_dlc_tracker_updates != null && !hasArrayShape(parsed.user_dlc_tracker_updates)) return null;
        return parsed;
    };

    const parseTurnMaintenanceJson = (text, includeRpLongTermLlm = false) => validateTurnMaintenanceJson(
        parseValidatedStructuredJson(text, ['narrativeBrief', 'correction', 'storyAuthor', 'director', 'longTermMemory', 'worldAdditional', 'world_additional', 'userDlcTrackerUpdates', 'user_dlc_tracker_updates']),
        includeRpLongTermLlm
    );

    const validateCanonicalAnalysisPacketJson = (packet) => {
        if (!hasObjectShape(packet) || !isMeaningfulJsonContractValue(packet)) return null;
        return CanonicalPacketContract.validate(packet, { allowLegacy: true, requireCoreAxes: true });
    };

    const validateUnifiedAfterRequestJson = (parsed) => {
        if (!hasObjectShape(parsed)) return null;
        const compat = hasObjectShape(parsed.compat) ? parsed.compat : {};
        const canonicalPacket = validateCanonicalAnalysisPacketJson(parsed.canonicalPacket)
            || validateCanonicalAnalysisPacketJson(parsed.packet)
            || validateCanonicalAnalysisPacketJson(parsed.packet_patch)
            || validateCanonicalAnalysisPacketJson(parsed.canonical_packet)
            || validateCanonicalAnalysisPacketJson(parsed);
        const entityExtraction = parsed.entityExtraction || compat.entityExtraction;
        const maintenance = parsed.maintenance || compat.maintenance;
        if (canonicalPacket) return parsed;
        if (!hasObjectShape(entityExtraction) || !hasObjectShape(maintenance)) return null;
        const entityShapeOk = hasArrayShape(entityExtraction.entities)
            || hasArrayShape(entityExtraction.relations)
            || hasArrayShape(entityExtraction.spans)
            || hasObjectShape(entityExtraction.world);
        if (!entityShapeOk) return null;
        if (!validateTurnMaintenanceJson(maintenance, true)) return null;
        return parsed;
    };

    const parseUnifiedAfterRequestJson = (text) => validateUnifiedAfterRequestJson(
        parseValidatedStructuredJson(text, [
            'canonicalPacket', 'canonical_packet', 'packet', 'packet_patch',
            'entityExtraction', 'maintenance', 'compat',
            'meta', 'memory', 'entity', 'world', 'narrative', 'guidance', 'guards', 'importance'
        ])
    );

    const AnalysisResultGuard = (() => {
        const TRUSTED_SOURCE_MODES = new Set([
            'manual',
            'correction',
            'gui_manual_correction',
            'user_correction',
            'manual_world_correction',
            'visual_canon_manual'
        ]);
        const clip = (value = '', max = 180) => {
            const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
            if (!text) return '';
            const limit = Math.max(24, Number(max || 180) || 180);
            return text.length > limit ? `${text.slice(0, limit - 5)} ... ` : text;
        };
        const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const countArray = (value) => Array.isArray(value) ? value.length : 0;
        const hasMeaningfulWorld = (value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            return Object.keys(value).some(key => value[key] !== undefined && value[key] !== null && value[key] !== '');
        };
        const getSourceMode = (result = null, context = {}) => String(
            context?.sourceMode
            || result?.sourceMode
            || result?.source
            || result?.meta?.sourceMode
            || ''
        ).trim();
        const isTrustedManual = (sourceMode = '') => TRUSTED_SOURCE_MODES.has(String(sourceMode || '').trim());
        const summarizeShape = (result = null) => {
            const source = asObject(result);
            const canonicalPacket = asObject(source.canonicalPacket || source.canonical_packet || source.packet || source.packet_patch);
            const maintenance = asObject(source.maintenance);
            return {
                entities: countArray(source.entities),
                relations: countArray(source.relations),
                conflicts: countArray(source.conflicts),
                rejectedEntities: countArray(source.rejectedEntities),
                rejectedRelations: countArray(source.rejectedRelations),
                hasWorld: hasMeaningfulWorld(source.world),
                hasCanonicalPacket: Object.keys(canonicalPacket).length > 0,
                hasMaintenance: Object.keys(maintenance).length > 0,
                degraded: source.degraded === true,
                success: source.success
            };
        };
        const block = (reason = 'blocked', result = null, context = {}) => ({
            allowed: false,
            status: 'blocked',
            reason: clip(reason || 'blocked', 160),
            sourceMode: getSourceMode(result, context),
            domain: clip(context?.domain || '', 80),
            operation: clip(context?.operation || '', 120),
            shape: summarizeShape(result)
        });
        const allow = (status = 'ok', result = null, context = {}) => ({
            allowed: true,
            status,
            reason: '',
            sourceMode: getSourceMode(result, context),
            domain: clip(context?.domain || '', 80),
            operation: clip(context?.operation || '', 120),
            shape: summarizeShape(result)
        });
        const isMergeAllowed = (result = null, context = {}) => {
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
                return block('missing_or_non_object_result', result, context);
            }
            const sourceMode = getSourceMode(result, context);
            if (isTrustedManual(sourceMode)) return allow('trusted_manual', result, context);
            if (result.__libraMergeBlocked === true) {
                return block(result.__libraGuard?.reason || 'already_blocked', result, context);
            }
            if (result.success === false) {
                return block(result.fallbackReason || result.error || result.reason || 'success_false', result, context);
            }
            if (result.degraded === true) {
                return block(result.fallbackReason || result.error || result.reason || 'degraded_result', result, context);
            }
            if (result.fallbackReason && context?.allowFallbackReasonMerge !== true) {
                return block(result.fallbackReason || result.reason || 'fallback_reason_present', result, context);
            }
            if (result.schemaInvalid === true || result.schema_invalid === true || result.wrongJsonShape === true || result.wrong_json_shape === true) {
                return block('schema_invalid', result, context);
            }
            if (result.invalid === true || result.partial === true || result.truncated === true) {
                return block(result.reason || 'partial_or_invalid_result', result, context);
            }
            const canonicalPacket = asObject(result.canonicalPacket || result.canonical_packet || result.packet || result.packet_patch);
            if (Object.keys(canonicalPacket).length > 0) {
                const contract = CanonicalPacketContract.inspect(canonicalPacket, { allowLegacy: true, requireCoreAxes: true });
                if (!contract.valid) return block(`canonical_packet_invalid:${contract.errors.slice(0, 3).join(',')}`, result, context);
            }
            return allow('ok', result, context);
        };
        const markBlocked = (result = null, guard = null) => {
            const source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
            const appliedGuard = guard && typeof guard === 'object' ? guard : isMergeAllowed(source);
            return {
                ...source,
                __libraMergeBlocked: true,
                __libraGuard: appliedGuard,
                success: false
            };
        };
        return {
            isMergeAllowed,
            markBlocked,
            isTrustedManual,
            summarizeShape
        };
    })();
    try {
        if (typeof globalThis !== 'undefined') globalThis.LIBRA_AnalysisResultGuard = AnalysisResultGuard;
    } catch (_) { /* optional diagnostics only */ }

