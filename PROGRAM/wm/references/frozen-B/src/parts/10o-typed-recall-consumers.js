    // Production policy is an operational default, explicitly not calibrated model quality.
    const productionRecallPolicyValid = p => p?.schema === 'libra.typed-recall.production-policy.v1'
        && p.mode === 'production' && typeof p.version === 'string' && !!p.version
        && ['heuristicDepth','semanticDepth'].every(k => Number.isInteger(p[k]) && p[k] >= 1 && p[k] <= 32)
        && Number.isInteger(p.queryBudgetMs) && p.queryBudgetMs >= 1 && p.queryBudgetMs <= 1500
        && Number.isInteger(p.rrf?.k) && p.rrf.k >= 1 && p.rrf.k <= 1000
        && ['memory','entity','world','narrative'].every(f => {
            const a=p.admission?.[f],c=p.calibration?.[f];
            return a && Number.isFinite(a.heuristicMinScore) && a.heuristicMinScore >= 0
                && Number.isFinite(a.semanticMinScore) && a.semanticMinScore >= -1 && a.semanticMinScore <= 1
                && Number.isFinite(a.semanticMinMargin) && a.semanticMinMargin >= 0 && a.semanticMinMargin <= 2
                && a.semanticMinLexicalOverlap === 0 && c && Number.isFinite(c.scale) && Number.isFinite(c.offset);
        });
    const validateProductionRecallSettings = (config = {}) => {
        const errors=[], numeric=(id,value,lo,hi,int=false)=>{if(!Number.isFinite(value)||value<lo||value>hi||(int&&!Number.isInteger(value)))errors.push(id);};
        if(config.dualRecallMode!==undefined&&!['legacy','shadow','dual'].includes(config.dualRecallMode))errors.push('sdual-mode');
        for(const [key,id,hi]of [['dualRecallHeuristicDepth','sdual-hdepth',32],['dualRecallSemanticDepth','sdual-sdepth',32],['dualRecallRrfK','sdual-rrf',1000],['dualRecallQueryBudgetMs','sdual-budget',1500]])if(config[key]!==undefined)numeric(id,config[key],1,hi,true);
        const e=config.embed||{};
        if(e.dimension!==undefined&&e.dimension!==null&&e.dimension!=='')numeric('sedimension',e.dimension,1,8192,true);
        if(e.modelRevision!==undefined&&(typeof e.modelRevision!=='string'||e.modelRevision.length>256))errors.push('serevision');
        if(config.dualRecallAdmission!==undefined&&config.dualRecallAdmission!==null){
            try{const a=typeof config.dualRecallAdmission==='string'?JSON.parse(config.dualRecallAdmission):config.dualRecallAdmission;
                if(!a||typeof a!=='object'||Array.isArray(a))throw new Error('admission');
                for(const family of ['memory','entity','world','narrative']){const row=a[family];if(row===undefined)continue;if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('admission');
                    for(const [key,suffix,lo,hi]of [['heuristicMinScore','heuristic',0,Number.MAX_VALUE],['semanticMinScore','semantic',-1,1],['semanticMinMargin','margin',0,2]])if(row[key]!==undefined)numeric('sdual-'+family+'-'+suffix,row[key],lo,hi);
                    if(row.semanticMinLexicalOverlap!==undefined&&row.semanticMinLexicalOverlap!==0)errors.push('sdual-'+family+'-lexical');
                }
            }catch(_){errors.push('dualRecallAdmission');}
        }
        return errors;
    };
    // Only policies copied here are known immutable, getter-free production data.
    const ownedTypedRecallPolicies = new WeakSet();
    const buildProductionRecallConfiguration = (config = {}) => {
        const integer=(n,fb,lo,hi)=>Number.isInteger(Number(n)) && Number(n)>=lo && Number(n)<=hi ? Number(n) : fb;
        const families=['memory','entity','world','narrative'], mode=['legacy','shadow','dual'].includes(config.dualRecallMode) ? config.dualRecallMode : 'dual';
        const defaults=Object.fromEntries(families.map(f=>[f,{heuristicMinScore:0.001,semanticMinScore:0.8,semanticMinMargin:0,semanticMinLexicalOverlap:0}]));
        let admission=defaults, policyReason='';
        if(config.dualRecallAdmission !== undefined && config.dualRecallAdmission !== null){
            try {
                const raw=typeof config.dualRecallAdmission==='string' ? JSON.parse(config.dualRecallAdmission) : config.dualRecallAdmission;
                if(!raw || Array.isArray(raw) || typeof raw!=='object')throw new Error('invalid_admission');
                const next=Object.fromEntries(families.map(f=>[f,{...defaults[f],...(raw[f] || {})}]));
                const valid=families.every(f=>{const a=next[f];return Number.isFinite(a.heuristicMinScore)&&a.heuristicMinScore>=0
                    &&Number.isFinite(a.semanticMinScore)&&a.semanticMinScore>=-1&&a.semanticMinScore<=1
                    &&Number.isFinite(a.semanticMinMargin)&&a.semanticMinMargin>=0&&a.semanticMinMargin<=2&&a.semanticMinLexicalOverlap===0;});
                if(!valid)throw new Error('invalid_admission'); admission=next;
            }catch(_){policyReason='invalid_admission';}
        }
        const policy={schema:'libra.typed-recall.production-policy.v1',mode:'production',version:'production-operational-v1',
            calibrationLabel:'uncalibrated operational default',heuristicDepth:integer(config.dualRecallHeuristicDepth,32,1,32),
            semanticDepth:integer(config.dualRecallSemanticDepth,32,1,32),queryBudgetMs:integer(config.dualRecallQueryBudgetMs,1500,1,1500),
            maxCorpusUnits:2048,rrf:{k:integer(config.dualRecallRrfK,60,1,1000)},admission,
            calibration:Object.fromEntries(families.map(f=>[f,{scale:1,offset:0}])),packing:{maxItems:6,maxRefill:6},
            diversity:{maxItems:6,lambda:0.8,crossRolePenalty:0.2,arcPenalty:0.03,maxPerArc:6,typeCaps:{}},
            storage:{maxRowBytes:65536,maxJobBytes:1048576,maxExpectedBytes:8388608,maxExpectedRows:2048},
            background:{maxCalls:16,maxRows:32,maxBytes:1048576,maxMillis:10000}};
        const embed=config.embed || {};let provider=null,reason=policyReason || (validateProductionRecallSettings(config).length?'invalid_recall_settings':'');
        if(!reason){
            if(embed.enabled!==true)reason='embedding_disabled';
            else if(!['ollama','openai'].includes(embed.provider))reason='unsupported_provider';
            else if(!Number.isInteger(Number(embed.dimension)) || Number(embed.dimension)<1 || Number(embed.dimension)>8192)reason='embedding_dimension_unknown';
            else if(typeof embed.modelRevision!=='string' || !embed.modelRevision.trim() || embed.modelRevision.length>256)reason='embedding_revision_unknown';
            else if(!isProviderProfileConfigured(embed))reason='embedding_profile_unconfigured';
            else {
                try {
                    const descriptor={provider:embed.provider,model:String(embed.model||'').trim(),modelRevision:embed.modelRevision.trim(),
                        endpoint:embed.provider==='ollama' ? ollamaApiUrl(embed.url,'/api/embed') : normalizeOpenAICompatUrl(embed.url,'/v1/embeddings'),
                        dimension:Number(embed.dimension),queryMode:'input',documentMode:'input',options:embed.provider==='ollama'?{truncate:false}:{}};
                    descriptor.spaceFingerprint='production:'+SemanticRecallIndex.sourceHash(JSON.stringify(descriptor));
                    provider=StrictRecallEmbeddingTransport.snapshot({...descriptor,key:String(embed.key||'')});
                }catch(_){reason='embedding_configuration_invalid';}
            }
        }
        const signature=SemanticRecallIndex.sourceHash(JSON.stringify({mode,policy,provider:provider?SemanticRecallIndex.providerDescriptor(provider):null,reason}));
        const ownedPolicy = TypedSemanticRuntime.copy(policy);
        ownedTypedRecallPolicies.add(ownedPolicy);
        return Object.freeze({mode,policy:ownedPolicy,provider,signature,production:true,
            readiness:TypedSemanticRuntime.copy({semanticConfigured:!!provider,semanticReady:false,status:provider?'uninitialized':'heuristic_only',
                reason:reason || 'index_coverage_not_observed',coverageBasis:'not_observed',independentDurabilityRead:false,
                calibrationLabel:'uncalibrated operational default'})});
    };

    // Atomic typed consumers. A section receipt binds the captured union; it is
    // never a new retrieval surface. Required baseline is independent of recall.
    const TypedRecallConsumers = (() => {
        const receipts = new WeakMap(), outputs = new WeakMap();
        // Diagnostic sidecars only: never part of a unit, receipt, prompt or storage.
        const packedObservations = new WeakMap(), deliveries = new WeakMap(), deliveredTexts = new WeakMap();
        const copy = value => TypedSemanticRuntime.copy(value);
        const estimate = text => TokenizerEngine.estimateTokens(text, 'simple');
        const bounded = (n, fallback, cap) => Number.isInteger(n) && n >= 0 ? Math.min(n, cap) : fallback;
        // Receipts prove a source binding. Formatting always resolves the current
        // canonical unit, so keeping whole entries/parents here duplicates sources.
        const unitBinding = unit => unit && ({
            ...Object.fromEntries(['identity', 'family', 'subtype', 'locator', 'contentHash', 'dependencyHash',
                'representationVersion', 'text', 'roles', 'sourceRefs'].map(key => [key, unit[key]])),
            record: { arcKey: unit.record?.arcKey, meta: { arcKey: unit.record?.meta?.arcKey } }
        });
        const sectionBinding = row => ({ ...row, ...(row.unit ? { unit: unitBinding(row.unit) } : {}),
            ...(row.bindings ? { bindings: row.bindings.map(unitBinding) } : {}) });
        const compose = ({ baseline = [], selection = [], union = selection, snapshot, policy, requestGuard = () => true }) => {
            if (!snapshot?.scopeKey || !(['fixture', 'shadow'].includes(policy?.mode) || productionRecallPolicyValid(policy))) throw new Error('consumer_policy_required');
            if (baseline.length > 256 || selection.length > 64 || union.length > 64) throw new Error('consumer_sections_bound');
            const sections = copy([
                ...baseline.map(row => ({ ...sectionBinding(row), kind: 'baseline', required: row.required !== false })),
                ...selection.map(row => ({ ...sectionBinding(row), key: 'typed:' + row.identity, kind: 'recall', required: false }))
            ]);
            receipts.set(sections, { snapshot: copy(Object.fromEntries(['scopeKey', 'branchId', 'viewerId',
                'worldlineRevision', 'currentTurn', 'ephemeralDriftExclusion'].map(key => [key, snapshot[key]]))),
                policy: copy(policy), union: copy(union.map(sectionBinding)), requestGuard });
            return { sections, trace: { baseline: baseline.length, selected: selection.length, union: union.length } };
        };
        const finalize = ({ sections, currentSnapshot, mode = 'direct', budget = {}, policy }) => {
            const receipt = receipts.get(sections), trace = { status: 'ready', drops: [], refill: [], chars: 0, tokens: 0, blocks: [], projectionEvidence: 'derived_payload_only' };
            const protectedDrops = [], result = { ok: true, directBlocks: [], projectionEntries: [], trace, protectedDrops };
            const stop = status => { result.ok = false; trace.status = status; result.directBlocks = []; result.projectionEntries = []; trace.tokens = trace.chars = 0; return result; };
            if (!receipt) return stop('unverified_sections');
            if (!['direct', 'projection', 'hybrid'].includes(mode)) return stop('consumer_mode');
            const getSnapshot = () => typeof currentSnapshot === 'function' ? currentSnapshot() : currentSnapshot;
            const limits = { maxTokens: bounded(budget.maxTokens, 0, 100000), maxChars: bounded(budget.maxChars, 0, 400000) };
            const maxItems = bounded(receipt.policy.packing?.maxItems, receipt.policy.diversity?.maxItems || 4, 64);
            const maxRefill = bounded(receipt.policy.packing?.maxRefill, 64, 64);
            const seen = new Set(), blocks = [], selectedIds = new Set(sections.filter(s => s.kind === 'recall').map(s => s.identity));
            const frame = snapshot => snapshot && ['scopeKey', 'branchId', 'viewerId'].every(k => snapshot[k] === receipt.snapshot[k]);
            const binding = (unit, snapshot, identityMap) => {
                if (!frame(snapshot)) return { reason: 'scope_branch_viewer' };
                const current = identityMap.get(unit?.identity);
                const hard = TypedRecallCorpus.adapters[current?.family]?.eligibility(current, snapshot, policy?.exclusions || receipt.policy.exclusions || {});
                if (!hard?.eligible) return { reason: hard?.reason || 'canonical_missing' };
                if (['identity', 'family', 'subtype', 'contentHash', 'dependencyHash', 'representationVersion', 'text'].some(k => current[k] !== unit[k])
                    || JSON.stringify(current.locator) !== JSON.stringify(unit.locator)
                    || JSON.stringify(current.roles) !== JSON.stringify(unit.roles) || JSON.stringify(current.sourceRefs) !== JSON.stringify(unit.sourceRefs)) return { reason: 'stale_binding' };
                return { current };
            };
            const drop = (section, reason) => {
                const d = { identity: section.unit?.identity || section.identity || section.key, kind: section.kind, reason };
                trace.drops.push(d); if (section.required) protectedDrops.push(d);
            };
            const valid = section => {
                if (!receipt.requestGuard()) return { reason: 'request_invalidated' };
                const snapshot = getSnapshot();
                if (!frame(snapshot)) return { reason: 'scope_branch_viewer' };
                return withTypedRecallValidationBatch(snapshot, () => {
                // This lookup and pure parent checksums exist only within this one
                // validity pass. Never share them across format/final/verified.
                let identityMap;
                const canonical = () => {
                    if (!identityMap) {
                        identityMap = new Map();
                        const units = receipt.policy.mode === 'production'
                            ? enumerateTypedConsumerBindings(snapshot, receipt.policy, (section.unit ? [section.unit] : section.bindings || []).map(unit => unit.identity))
                            : TypedRecallCorpus.enumerate(snapshot, receipt.policy);
                        for (const unit of units) {
                            if (!identityMap.has(unit.identity)) identityMap.set(unit.identity, unit);
                        }
                    }
                    return identityMap;
                };
                if (!section.unit) {
                    // Native controls/baseline are opaque formatter output. Bind every
                    // contributing unit and generation, never infer truth from text.
                    if (snapshot.worldlineRevision !== receipt.snapshot.worldlineRevision || snapshot.currentTurn !== receipt.snapshot.currentTurn
                        || JSON.stringify(snapshot.ephemeralDriftExclusion) !== JSON.stringify(receipt.snapshot.ephemeralDriftExclusion)) return { reason: 'baseline_generation' };
                    for (const unit of section.bindings || []) { const v = binding(unit, snapshot, canonical()); if (v.reason) return v; }
                    return { snapshot };
                }
                return { ...binding(section.unit, snapshot, canonical()), snapshot };
                }, policy === undefined || ownedTypedRecallPolicies.has(policy));
            };
            const format = section => {
                const before = valid(section); if (before.reason) { drop(section, before.reason); return null; }
                let text = SecretKnowledgeCore.redactForViewer(section.text || '', before.snapshot.viewerId), unit = before.current;
                if (unit) {
                    const formatted = TypedRecallCorpus.adapters[unit.family].formatter(unit, before.snapshot, { exclusions: policy?.exclusions || receipt.policy.exclusions || {} });
                    if (!Array.isArray(formatted) || !formatted.length) { drop(section, 'formatter_empty'); return null; }
                    text = formatted.map(b => b.text).filter(Boolean).join('\n');
                    const authority = section.kind === 'baseline' ? 'Protected current baseline' : 'Historical reference; current baseline rules take precedence';
                    text = `[${authority} | ${unit.family} | identity=${unit.identity} | roles=${unit.roles.join(',')} | sources=${JSON.stringify(unit.sourceRefs)}]\n${text}`;
                }
                const after = valid(section); if (after.reason) { drop(section, after.reason); return null; }
                if (!text.trim()) { drop(section, 'formatter_empty'); return null; }
                return { key: section.key, kind: section.kind, required: section.required, identity: unit?.identity || section.key,
                    family: unit?.family || section.family || 'control', roles: unit?.roles || section.roles || ['protected_control'], sourceRefs: unit?.sourceRefs || section.sourceRefs || [section.key],
                    slot: section.slot || (unit?.family === 'world' || unit?.family === 'entity' ? 'othersInfo' : 'memory'), text, section };
            };
            const add = section => {
                const block = format(section); if (!block) return false;
                const identity = JSON.stringify([block.identity, block.roles, block.sourceRefs]);
                if (seen.has(identity)) { drop(section, 'duplicate_identity_role_source'); return false; }
                const text = [...blocks.map(b => b.text), block.text].join('\n\n'), tokens = estimate(text);
                if (text.length > limits.maxChars || tokens > limits.maxTokens) { drop(section, 'budget'); return false; }
                seen.add(identity); blocks.push(block); return true;
            };
            for (const section of sections.filter(s => s.kind === 'baseline')) add(section);
            let recalls = 0;
            for (const section of sections.filter(s => s.kind === 'recall')) {
                if (recalls >= maxItems) { drop(section, 'packing_depth'); continue; }
                if (add(section)) recalls++;
            }
            // Revalidate before the diversity cutoff. A rejected replacement must
            // not consume a lane slot and hide a later valid union member.
            if (recalls < Math.min(maxItems, selectedIds.size) && maxRefill) {
                const rejected = new Set(trace.drops.map(d => d.identity));
                const processed = new Set(selectedIds), candidates = [];
                trace.refillAttempts = 0;
                for (const row of receipt.union) {
                    if (rejected.has(row.identity)) continue;
                    if (!processed.has(row.identity)) {
                        if (trace.refillAttempts >= maxRefill) break;
                        processed.add(row.identity); trace.refillAttempts++;
                        const section = { ...row, key: 'typed:' + row.identity, kind: 'recall', required: false };
                        const v = valid(section);
                        if (v.reason) { drop(section, v.reason); rejected.add(row.identity); continue; }
                    } else if (!selectedIds.has(row.identity)) continue;
                    if (!candidates.some(c => c.identity === row.identity)) candidates.push(row);
                }
                // Each unsuccessful add removes one candidate, so this loop is
                // bounded by the captured union (64), including formatter races.
                while (recalls < maxItems) {
                    const diversity = DualRecallEngine.selectDiverse(candidates.filter(row => !rejected.has(row.identity)), { ...receipt.policy,
                        diversity: { ...receipt.policy.diversity, maxItems, preferredIdentities: blocks.filter(b => b.kind === 'recall').map(b => b.identity) } });
                    trace.refillDiversity = diversity.trace;
                    const row = diversity.items.find(row => !blocks.some(b => b.kind === 'recall' && b.identity === row.identity));
                    if (!row) break;
                    if (add({ ...row, key: 'typed:' + row.identity, kind: 'recall', required: false })) { recalls++; trace.refill.push(row.identity); }
                    else rejected.add(row.identity);
                }
            }
            // A later formatter can invalidate an earlier block. Recheck the entire
            // final set immediately before emitting either consumer payload.
            const observed = [];
            let observationChars = 0;
            const final = blocks.filter(block => {
                const v = valid(block.section);
                if (v.reason) { drop(block.section, v.reason); return false; }
                // Use the exact unit/snapshot of this existing validation pass.
                // A diagnostic failure cannot remove a valid block or alter output.
                try {
                    const body = v.current ? block.text.slice(block.text.indexOf('\n') + 1) : block.text;
                    const provenance = v.current ? TypedRecallCorpus.observeAnchors(v.current, v.snapshot, body)
                        : { anchors: [], sourceBindings: [], completeSourceCount: null,
                            coverage: 'unknown', reasons: ['opaque_baseline_dependencies_not_evidence'] };
                    const observation = { identity: block.identity, family: block.family, kind: block.kind, slot: block.slot,
                        ...provenance, bodyOffset: v.current ? block.text.indexOf('\n') + 1 : 0,
                        dependencyRefs: block.sourceRefs.slice(0,64), dependencyRefsTruncated: block.sourceRefs.length > 64,
                        binding: v.current ? Object.fromEntries(['contentHash','dependencyHash','representationVersion','locator'].map(k => [k,v.current[k]])) : null,
                        frame: Object.fromEntries(['scopeKey','branchId','viewerId','worldlineRevision','currentTurn'].map(k => [k,v.snapshot[k]])) };
                    const chars = JSON.stringify(observation).length;
                    if (chars > 8192 || observationChars + chars > 262144) observed.push(null);
                    else { observationChars += chars; observed.push(observation); }
                } catch (_) { observed.push(null); }
                return true;
            });
            if (!receipt.requestGuard()) return stop('request_invalidated');
            const text = final.map(b => b.text).join('\n\n'); trace.chars = text.length; trace.tokens = estimate(text);
            trace.blocks = final.map(({ identity, family, roles, sourceRefs, kind }) => ({ identity, family, roles, sourceRefs, kind }));
            const publicBlocks = final.map(({ section, ...block }) => block);
            if (mode !== 'projection') result.directBlocks = publicBlocks;
            if (mode !== 'direct') result.projectionEntries = publicBlocks.map((block, i) => ({
                key: 'LIBRA_TYPED_' + SemanticRecallIndex.sourceHash(JSON.stringify([receipt.snapshot.scopeKey, block.identity, block.roles, block.sourceRefs])),
                comment: 'lmai_projection_typed_recall', memo: 'LIBRA_PROJECTION', content: block.text, mode: 'constant', insertorder: 983 + i,
                alwaysActive: true, selective: false, useRegex: false, secondkey: '', depth: 0,
                typedProjectionOwner: { schema: 'libra.typed-projection.owner.v1', scopeKey: receipt.snapshot.scopeKey,
                    branchId: receipt.snapshot.branchId, viewerId: receipt.snapshot.viewerId,
                    identity: block.identity, roles: block.roles, sourceRefs: block.sourceRefs }
            }));
            if (protectedDrops.length) { result.ok = false; trace.status = 'protected_core_lost'; }
            const immutable = copy(result);
            outputs.set(immutable, () => immutable.ok === true && immutable.protectedDrops.length === 0
                && receipt.requestGuard() && final.every(block => !valid(block.section).reason));
            try { packedObservations.set(immutable, copy({ mode, frame: Object.fromEntries(['scopeKey','branchId','viewerId','worldlineRevision','currentTurn'].map(k => [k,receipt.snapshot[k]])), blocks: observed })); } catch (_) {}
            return immutable;
        };
        const unavailableObservation = reason => ({ schema: 'libra.final-delivery-observation.v1', status: 'unavailable',
            reason, emittedBlockCount: null, completeSourceCount: null, knownAnchorCount: null, blocks: [] });
        // Caller owns the existing successful return boundary. No extra canonical
        // read, formatter, model call, persistence or mutation is performed here.
        const observeDelivery = (output, payload, current = true, admission = null) => {
            try {
                if (!payload || typeof payload !== 'object') return;
                if (!current) { deliveries.set(payload, copy({ ...unavailableObservation('request_not_current'), status: 'aborted' })); return; }
                const packed = packedObservations.get(output);
                if (!packed || !output?.ok) return;
                if (packed.mode !== 'direct') { deliveries.set(payload, copy(unavailableObservation('not_direct_hook_delivery'))); return; }
                const metadata = packed.blocks;
                const messages = extractRequestMessageContainer(payload).messages;
                const used = new Map(), blocks = [];
                for (let i = 0; i < output.directBlocks.length; i++) {
                    const block = output.directBlocks[i], text = String(block.text || '').trim();
                    let span = null;
                    for (let j = 0; j < messages.length; j++) {
                        const content = messages[j]?.content;
                        if (typeof content !== 'string' || !/^\[LIBRA [^\n]* Injection\]\n/.test(content)) continue;
                        let start = content.indexOf(text, content.indexOf('\n') + 1);
                        const occupied = used.get(j) || [];
                        while (start >= 0 && occupied.some(s => start < s.end && start + text.length > s.start)) start = content.indexOf(text, start + 1);
                        if (start < 0 || !text) continue;
                        span = { messageIndex: j, start, end: start + text.length };
                        used.set(j, [...occupied, span]); break;
                    }
                    if (!span) { deliveries.set(payload, copy(unavailableObservation('final_payload_mismatch'))); return; }
                    blocks.push({ ...(metadata[i] || { identity: block.identity.length <= 4096 ? block.identity : null, family: block.family, kind: block.kind, slot: block.slot,
                        anchors: [], sourceBindings: [], completeSourceCount: null, coverage: 'unknown', reasons: ['metadata_unavailable'] }),
                        outputOrdinal: blocks.length, chars: text.length, span });
                }
                blocks.sort((a,b) => a.span.messageIndex - b.span.messageIndex || a.span.start - b.span.start);
                blocks.forEach((block,i) => { block.outputOrdinal = i; });
                deliveredTexts.set(payload, blocks.map(b => messages[b.span.messageIndex].content.slice(b.span.start,b.span.end)));
                deliveries.set(payload, copy({ schema: 'libra.final-delivery-observation.v1', status: 'delivered',
                    frame: packed.frame, requestFrame: admission ? Object.fromEntries(['scopeKey','runtimeScopeKey','resetGeneration'].map(k => [k,admission[k]])) : null,
                    emittedBlockCount: blocks.length, completeSourceCount: blocks.length === 0 ? 0 : null,
                    knownAnchorCount: new Set(blocks.flatMap(b => b.anchors.map(a => JSON.stringify([a.scopeKey,a.ordinal])))).size, blocks }));
            } catch (_) { /* Observation must never affect a returned prompt. */ }
        };
        const deliveryObservation = payload => {
            try {
                const observation = deliveries.get(payload);
                if (!observation) return copy(unavailableObservation('no_observed_successful_return'));
                if (observation.status === 'delivered') {
                    const messages = extractRequestMessageContainer(payload).messages, texts = deliveredTexts.get(payload);
                    if (!texts || observation.blocks.some((b,i) => typeof messages[b.span.messageIndex]?.content !== 'string'
                        || messages[b.span.messageIndex].content.slice(b.span.start,b.span.end) !== texts[i]))
                        return copy(unavailableObservation('returned_payload_changed'));
                }
                return observation;
            } catch (_) { return copy(unavailableObservation('observation_unavailable')); }
        };
        const verified = output => outputs.get(output)?.() === true;
        return Object.freeze({ compose, finalize, verified, observeDelivery, deliveryObservation });
    })();

    // Read-only inspection of externally present derived entries. This predicate
    // neither proves a product host write nor authorizes cleanup/prompt deletion.
    const TypedRecallProjectionLifecycle = (() => {
        const owned = (entry, scopeKey) => {
            const owner = entry?.typedProjectionOwner;
            return entry?.comment === 'lmai_projection_typed_recall' && entry.memo === 'LIBRA_PROJECTION'
                && owner?.schema === 'libra.typed-projection.owner.v1' && owner.scopeKey === scopeKey
                && typeof owner.identity === 'string' && Array.isArray(owner.roles) && Array.isArray(owner.sourceRefs)
                && entry.key === 'LIBRA_TYPED_' + SemanticRecallIndex.sourceHash(JSON.stringify([scopeKey, owner.identity, owner.roles, owner.sourceRefs]));
        };
        const strip = (lore, scopeKey) => (Array.isArray(lore) ? lore : []).filter(entry => !owned(entry, scopeKey));
        const assertHostBoundary = (char, chat) => {
            const scopeKey = getChatRuntimeScopeKey(chat, char);
            const found = (chat?.localLore || []).filter(entry => owned(entry, scopeKey));
            if (!found.length) return;
            const report = { ok: false, status: 'host_projection_consumption_unverified', residualOwned: found.length,
                safetyFailure: false, hostConsumption: 'unverified', rawChatWrites: 0 };
            TypedRecallRollout.recordCleanup(report);
            // Host lore preassembly does not prove this plugin wrote a projection
            // there. Report an externally seeded row without blocking the response
            // or rewriting user chat/prompt text.
            return report;
        };
        const retire = async ({ char, chat, target }) => {
            const report = { ok: false, status: '', removed: 0, residualOwned: 0, setAcknowledged: false, readbackVerified: false,
                hostConsumption: 'unverified', safetyFailure: false, rawChatWrites: 0,
                writerContract: 'no verified field-scoped lore update API; whole-chat cleanup disabled' };
            const fail = status => ({ ...report, status, safetyFailure: true });
            if (!char || !chat) return fail('cleanup_target_unavailable');
            const scopeKey = getChatRuntimeScopeKey(chat, char);
            report.residualOwned = (chat.localLore || []).filter(entry => owned(entry, scopeKey)).length;
            if (!target || !Number.isInteger(target.characterIndex) || !Number.isInteger(target.chatIndex)
                || target.characterIndex < 0 || target.chatIndex < 0 || !RisuCompat.has('getCharacterFromIndex')
                || !RisuCompat.has('getChatFromIndex')) return fail('host_cleanup_api_unavailable');
            let hostChar, hostChat;
            try { hostChar = await RisuCompat.getCharacterFromIndex(target.characterIndex); hostChat = await RisuCompat.getChatFromIndex(target.characterIndex, target.chatIndex); }
            catch (_) { return fail('host_read_failed'); }
            if (!hostChar || !hostChat || String(hostChar.id || hostChar.chaId || '') !== target.characterId
                || String(hostChat.id || '') !== target.chatId || getChatRuntimeScopeKey(hostChat, hostChar) !== scopeKey) return fail('host_cleanup_scope_changed');
            report.residualOwned = Math.max(report.residualOwned, (hostChat.localLore || []).filter(entry => owned(entry, scopeKey)).length);
            if (report.residualOwned) return fail('host_field_cleanup_unavailable');
            return { ...report, ok: true, status: 'host_no_owned', readbackVerified: true };
        };
        return Object.freeze({ owned, strip, retire, assertHostBoundary });
    })();

    // Shared registered consumer activation. Fixture entry remains explicitly separate;
    // production activation never embeds documents on the request path.
    const TypedRecallRollout = (() => {
        let fixture = null, serial = 0, requests = 0, last = null, coverage = null;
        const scopes = new Set(), cfg = () => MemoryEngine.CONFIG;
        const mode = () => ['legacy', 'shadow', 'dual'].includes(cfg().dualRecallMode) ? cfg().dualRecallMode : 'dual';
        const available = () => fixture && mode() !== 'legacy' && cfg().dualRecallPolicyVersion === fixture.policy.version;
        const lifecycle=new Map();let schedulerTimer=null,schedulerRunning=0;
        const schedulerView=()=>({maxScopes:64,queueCap:64,running:schedulerRunning,queued:[...lifecycle.values()].filter(s=>s.pending).length,
            scopes:[...lifecycle].map(([scope,s])=>({scope,running:s.running,pending:!!s.pending,coalesced:s.coalesced,slices:s.slices,last:s.last,reason:s.reason}))});
        const cancelAll=()=>{
            if(schedulerTimer!==null){clearTimeout(schedulerTimer);schedulerTimer=null;}
            for(const [scope,s]of lifecycle){s.pending=null;SemanticRecallJobs.pause(scope);}
        };
        const productionGuard=(selected,scope)=>fixture===selected&&available()&&isLibraRuntimeEpochActive()
            &&String(MemoryState._activeScopeKey||MemoryState._activeChatId||'')===scope;
        const refreshJob=async(selected,snapshot)=>{
            const guard=()=>productionGuard(selected,snapshot.scopeKey);
            const fresh=await TypedRecallCorpus.refreshProduction({admission:{scopeKey:snapshot.worldlineScopeKey,runtimeScopeKey:snapshot.scopeKey,resetGeneration:snapshot.resetGeneration??0},
                branchId:snapshot.branchId,guard,currentTurn:MemoryEngine.getCurrentTurn(),viewerId:snapshot.viewerId});
            if(!guard())throw new Error('production_job_invalidated');return fresh;
        };
        const arm=()=>{if(schedulerTimer!==null||schedulerRunning||![...lifecycle.values()].some(s=>s.pending))return;
            schedulerTimer=setTimeout(()=>{schedulerTimer=null;void pump();},0);};
        const pump=async()=>{
            if(schedulerRunning)return;
            const next=[...lifecycle].find(([,s])=>s.pending);if(!next)return;
            const [scope,s]=next,item=s.pending;s.pending=null;s.running=true;schedulerRunning=1;
            try{
                const selected=item.selected,snapshot=await refreshJob(selected,item.snapshot);
                SemanticRecallJobs.resume(scope);
                const runtime=TypedSemanticRuntime.state(scope);
                runtime.operationGuard=()=>productionGuard(selected,scope);
                runtime.beforePublish=async()=>{try{const fresh=await refreshJob(selected,snapshot);return TypedSemanticRuntime.install(runtime,fresh);}catch(_){return false;}};
                runtime.schedulePersist=(after,reason)=>schedule(after,reason);
                const result=await SemanticRecallJobs.backfill(snapshot,selected.provider,selected.policy,{explicit:true,budget:selected.policy.background});
                s.last=TypedSemanticRuntime.copy(result);s.slices++;
                if(fixture===selected&&result.readiness)coverage={...result.readiness,reason:result.readiness.reason||'background_coverage',coverage:result.readiness.coverage||null};
                if(!s.pending&&productionGuard(selected,scope)&&result.remaining>0&&!result.diagnostics?.length&&(result.calls>0||result.written>0))
                    s.pending={snapshot,selected};
            }catch(error){s.last={ok:false,complete:false,calls:0,diagnostics:[{reason:String(error?.message||'background_failed')}]};}
            finally{s.running=false;schedulerRunning=0;arm();}
        };
        const schedule=(snapshot,reason='scope_activation')=>{
            const selected=fixture;
            if(!selected?.production||!selected.provider||!available())return {ok:false,reason:'semantic_unconfigured',calls:0};
            if(!snapshot?.scopeKey||!snapshot.worldlineScopeKey)return {ok:false,reason:'scope_unavailable',calls:0};
            if(!lifecycle.has(snapshot.scopeKey)){
                if(lifecycle.size>=64||(!scopes.has(snapshot.scopeKey)&&scopes.size>=64))return {ok:false,reason:'production_scope_bound',calls:0};
                lifecycle.set(snapshot.scopeKey,{pending:null,running:false,coalesced:0,slices:0,last:null,reason});
                if(!scopes.has(snapshot.scopeKey)){scopes.add(snapshot.scopeKey);SemanticRecallJobs.configure(snapshot.scopeKey,selected.provider,selected.policy);}
            }
            const s=lifecycle.get(snapshot.scopeKey),runtime=TypedSemanticRuntime.state(snapshot.scopeKey);
            if(s.pending)s.coalesced++;
            const captured=TypedSemanticRuntime.capture(snapshot);if(!TypedSemanticRuntime.install(runtime,captured))return {ok:false,reason:'stale_snapshot',calls:0};
            s.pending={snapshot:captured,selected};s.reason=reason;runtime.schedulePersist=(after,r)=>schedule(after,r);
            arm();return {ok:true,scheduled:true,calls:0};
        };
        const activateCurrent=async(reason='startup')=>{
            const selected=fixture;if(!selected?.production||!selected.provider||!available()||!MemoryState.isInitialized)return {ok:false,reason:'semantic_unconfigured'};
            try{const snapshot=await TypedRecallCorpus.refreshProduction({guard:()=>fixture===selected&&available()&&isLibraRuntimeEpochActive(),
                currentTurn:MemoryEngine.getCurrentTurn(),viewerId:'main_request'});return schedule(snapshot,reason);}
            catch(_){return {ok:false,reason:'canonical_activation_unavailable'};}
        };
        const configureFixture = (provider, policy) => {
            if (policy?.mode !== 'fixture' || !policy.version) return { ok: false, reason: 'explicit_fixture_policy_required' };
            const p = StrictRecallEmbeddingTransport.snapshot(provider), pol = TypedSemanticRuntime.copy(policy);
            cancelAll();serial++; for (const scope of scopes) SemanticRecallJobs.pause(scope);
            fixture = Object.freeze({ provider: p, policy: pol, production:false, readiness:{semanticConfigured:true,semanticReady:false,status:'fixture'} }); cfg().dualRecallPolicyVersion = pol.version;
            for (const scope of scopes) SemanticRecallJobs.configure(scope, p, pol);
            return { ok: true, productionEligible: false };
        };
        const configureProduction = config => {
            const selected=buildProductionRecallConfiguration(config);
            cancelAll();serial++;last=null;coverage=null;for(const scope of scopes)SemanticRecallJobs.pause(scope);
            fixture=selected;cfg().dualRecallMode=selected.mode;cfg().dualRecallPolicyVersion=selected.policy.version;
            for(const scope of scopes)if(selected.provider)SemanticRecallJobs.configure(scope,selected.provider,selected.policy);
            void activateCurrent('settings_change');
            return {ok:true,productionEligible:selected.mode!=='legacy',readiness:selected.readiness,signature:selected.signature};
        };
        const setMode = value => {
            if (!['legacy', 'shadow', 'dual'].includes(value)) return { ok: false, reason: 'invalid_mode' };
            if (value !== 'legacy' && !fixture) return { ok: false, reason: 'fixture_unconfigured' };
            serial++; cfg().dualRecallMode = value;
            if(value==='legacy')cancelAll();else if(fixture.production)void activateCurrent('mode_change');
            for (const scope of scopes) value === 'legacy' ? SemanticRecallJobs.pause(scope) : SemanticRecallJobs.resume(scope);
            return { ok: true, mode: value, productionEligible: fixture?.production === true && value !== 'legacy' };
        };
        const begin = () => {
            if (!available()) return null;
            const nonce = ++serial, selected = fixture, selectedMode = mode(); requests++;
            return Object.freeze({ mode: selectedMode, provider: selected.provider, policy: selected.policy,
                guard: () => nonce === serial && fixture === selected && available() && mode() === selectedMode });
        };
        const retrieve = async (handle, query, snapshot) => {
            if (!handle?.guard()) return { selection: [], union: [], reason: 'rollout_disabled', requestGuard: () => false };
            const scope = snapshot.scopeKey;
            if (!scopes.has(scope)) {
                if (scopes.size >= 64) throw new Error('rollout_scope_bound');
                scopes.add(scope); if(handle.provider)SemanticRecallJobs.configure(scope, handle.provider, handle.policy);
            }
            const runtime = TypedSemanticRuntime.state(scope);
            if(!fixture.production)runtime.operationGuard = () => available();
            SemanticRecallJobs.resume(scope);
            if(fixture.production&&!lifecycle.has(scope))schedule(snapshot,'scope_activation');
            const result = await DualRecallEngine.retrieve(query, snapshot, handle.provider, handle.policy);
            if (!handle.guard()) return { selection: [], union: [], reason: 'rollout_disabled', requestGuard: () => false };
            coverage=result.trace?.lanes?.semantic || null;
            const guard = result.requestGuard || (() => handle.guard());
            return { ...result, requestGuard: () => handle.guard() && guard() };
        };
        const record = record => { last = record; };
        const inspect = () => TypedSemanticRuntime.copy({ mode: mode(), requests, productionEligible: fixture?.production === true && mode() !== 'legacy',
            signature:fixture?.signature || '',readiness:fixture ? {...fixture.readiness,...(coverage ? {semanticReady:coverage.status==='ready',status:coverage.status,
                reason:fixture.provider ? coverage.reason : fixture.readiness.reason,coverage:coverage.coverage || null,coverageBasis:'current_expected_resident_snapshot',independentDurabilityRead:false}: {})} : {semanticConfigured:false,semanticReady:false,status:'unconfigured'},scheduler:schedulerView(),last });
        // Retained observer snapshots preserve every JSON field and the existing
        // detached/frozen contract. Equal large strings share backing storage only
        // inside this one copy; the temporary pool never becomes runtime state.
        const copyRetainedObserver = value => {
            const strings = new Map();
            const freeze = node => {
                if (node && typeof node === 'object') {
                    for (const key of Object.keys(node)) {
                        const item = node[key];
                        if (typeof item === 'string' && item.length >= 1024) {
                            const previous = strings.get(item);
                            if (previous !== undefined) node[key] = previous;
                            else strings.set(item, item);
                        } else if (item && typeof item === 'object') freeze(item);
                    }
                    Object.freeze(node);
                }
                return node;
            };
            return freeze(JSON.parse(JSON.stringify(value)));
        };
        const recordCleanup = cleanup => { last = copyRetainedObserver({ ...(last || {}), projectionCleanup: cleanup }); };
        return Object.freeze({ buildProductionRecallConfiguration, validateProductionRecallSettings, configureProduction, configureFixture, setMode, begin, retrieve, record, recordCleanup, inspect,schedule,activateCurrent,cancelAll });
    })();
