    // Exact graph witnesses belong only to native-JSON roots in one synchronous pass.
    // No input is frozen. A mismatch revokes reuse without traversing new children.
    const TypedChecksumWitness = (() => {
        // Capture trusted reflection functions once; callbacks cannot replace
        // the checker mid-pass, and the hot loop avoids VM-global lookups.
        const own = Object.prototype.hasOwnProperty;
        const getDescriptor = Object.getOwnPropertyDescriptor;
        const getPrototype = Object.getPrototypeOf;
        const ownKeys = Reflect.ownKeys;
        const sameValue = Object.is;
        const freeze = Object.freeze;
        function capture(root,budget={nodes:4096,properties:32768}){
         if(!root||typeof root!=='object')return null;
         const rows=[],seen=new WeakSet(),pending=[root];
         while(pending.length){
          const object=pending.pop();if(seen.has(object))continue;seen.add(object);
          if(budget.nodes--<=0)return null;
          const keys=ownKeys(object);if(keys.length>budget.properties){budget.properties=0;return null;}budget.properties-=keys.length;
          const slots=[];
          for(const key of keys){const d=getDescriptor(object,key);if(!d||!own.call(d,'value'))return null;slots.push(key,d.value,d.writable,d.enumerable,d.configurable);if(d.value&&typeof d.value==='object')pending.push(d.value);}
          rows.push(freeze({object,prototype:getPrototype(object),slots:freeze(slots)}));
         }
         return freeze({root,rows:freeze(rows)});
        }
        function matches(witness){
         if(!witness)return false;
         for(const row of witness.rows){
          
          if(getPrototype(row.object)!==row.prototype)return false;
          const keys=ownKeys(row.object),slots=row.slots;
          if(keys.length*5!==slots.length)return false;
          for(let i=0;i<keys.length;i++){
           const at=i*5;if(keys[i]!==slots[at])return false;
           const d=getDescriptor(row.object,keys[i]);
           if(!d||!own.call(d,'value')||!sameValue(d.value,slots[at+1])||d.writable!==slots[at+2]||d.enumerable!==slots[at+3]||d.configurable!==slots[at+4])return false;
          }
         }
         return true;
        }
        return freeze({ capture, matches });
    })();
    // Resident canonical recall units. This layer reads lore; it never persists it.
    // Closure-private consumer entry point; public corpus APIs retain full units.
    let enumerateTypedConsumerBindings = null;
    let withTypedRecallValidationBatch = null;
    let refreshProductionWithOwnedHydration = null;
    const TypedRecallCorpus = (() => {
        const VERSIONS = Object.freeze({ memory: 'memory.v1', entity: 'entity.v2', world: 'world.v2', narrative: 'narrative.v2' });
        const COMMENTS = Object.freeze({ memory: 'lmai_memory', entity: 'lmai_entity', worldGraph: 'lmai_world_graph', worldStates: 'lmai_world_states', worldAdditional: 'lmai_world_additional', narrative: 'lmai_narrative' });
        let generation = 0;
        const issuedSnapshots = new WeakSet();
        const consumerBindingPasses = new WeakSet();
        const isIssuedSnapshot = snapshot => issuedSnapshots.has(snapshot);
        const sourceHandles = new WeakMap();
        // Non-enumerable observation state: never changes expression/dependency hashes.
        const worldRuleStarts = new WeakMap();
        const canonicalSourceHandle = snapshot => sourceHandles.get(snapshot) || null;
        const immutableContentProofs = new WeakMap(), persistentMemoryProofs = new WeakMap();
        const contentProof = (entry, key, value, compute) => {
            if (!Object.isFrozen(entry)) return compute(value);
            let proofs = immutableContentProofs.get(entry);
            if (!proofs) { proofs = new Map(); immutableContentProofs.set(entry, proofs); }
            const raw = JSON.stringify(value), prior = proofs.get(key);
            if (prior?.raw === raw) return prior.hash;
            const hash = compute(value); proofs.set(key, { raw, hash }); return hash;
        };
        const str = value => String(value == null ? '' : value).trim();
        const list = value => Array.isArray(value) ? value : [];
        const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const hash = value => `${String(value).length}:${stableHash(String(value))}`;
        const digest = value => hash(JSON.stringify(value));
        // One synchronous enumeration owns these derived reads. A later binding or
        // eligibility pass gets fresh parsing and integrity checks, even for the
        // same snapshot. Only frozen canonical entries may participate.
        const nativeJsonParser = JSON.parse;
        const nativeIntegrityValidator = IntegrityMetaManager.validateIntegrityMeta;
        // Admission only: legacy/unsupported roots cannot reuse a checksum yet.
        // Inspect native-owned data without invoking inherited/accessor metadata.
        // Later callbacks may add integrity; those roots still validate normally.
        const hasOwnChecksumIntegrity = (() => {
            const getDescriptor = Object.getOwnPropertyDescriptor, isArray = Array.isArray;
            const own = Object.prototype.hasOwnProperty, apply = Reflect.apply;
            const data = (value, key) => {
                if (!value || typeof value !== 'object' || isArray(value)) return null;
                const descriptor = getDescriptor(value, key);
                return descriptor && apply(own, descriptor, ['value']) ? descriptor.value : null;
            };
            return record => data(data(data(record, 'meta'), 'integrity'), 'schema') === 'libra.integrity_meta.v1';
        })();
        const checksumPass = () => ({ witnesses: new WeakMap(), checksums: new WeakMap(),
            budget: { nodes: 4096, properties: 32768 } });
        let readPass = null, validationBatch = null, validationBatchDepth = 0;
        // Ownership is established at native JSON parse, before callbacks. Exact
        // witnesses keep mutable/custom paths compatible without caching verdicts.
        withTypedRecallValidationBatch = (snapshot, run, allowReuse = true) => {
            const previous = validationBatch;
            validationBatchDepth++;
            validationBatch = allowReuse && isIssuedSnapshot(snapshot)
                ? { snapshot, ...checksumPass() } : null;
            try { return run(); }
            finally { validationBatch = previous; validationBatchDepth--; }
        };
        const parse = entry => {
            const cache = readPass?.entries.has(entry) ? readPass.parsed : null;
            if (cache?.has(entry)) return cache.get(entry);
            let record = null, parser = null;
            try { parser = JSON.parse; record = Reflect.apply(parser, JSON, [str(entry?.content)]); } catch (_) {}
            if (cache && parser === nativeJsonParser && record && typeof record === 'object' && hasOwnChecksumIntegrity(record)) {
                // Never build/rebuild a witness after callbacks have observed this
                // root, or for a graph returned by a custom parser.
                const proof = TypedChecksumWitness.capture(record, readPass.proofs.budget);
                if (proof) readPass.proofs.witnesses.set(record, proof);
            }
            if (cache) cache.set(entry, record);
            return record;
        };
        const uid = (scope, family, subtype, id) => JSON.stringify([scope, family, subtype, id]);
        // Persistent row inputs exclude only this audit timestamp. No generic
        // created/updated/turn/checksum/scope fields are stripped from unit records.
        const persistentRecord = (value, path = []) => {
            if (Array.isArray(value)) return value.map(item => persistentRecord(item, path));
            if (!value || typeof value !== 'object') return value;
            return Object.fromEntries(Object.entries(value).filter(([key]) => !(key === 'updatedAt' && path.at(-1) === 'integrity' && path.at(-2) === 'meta'))
                .map(([key, item]) => [key, persistentRecord(item, [...path, key])]));
        };
        const persistentMemory = entry => {
            if (Object.isFrozen(entry) && persistentMemoryProofs.has(entry)) return persistentMemoryProofs.get(entry);
            const value = ({ ...entry, content: str(entry?.content).replace(/\[META:(\{[^\r\n]*\})\]/, (match, raw) => {
            try { return `[META:${JSON.stringify(persistentRecord({ meta: JSON.parse(raw) }).meta)}]`; } catch (_) { return match; }
            }) });
            if (Object.isFrozen(entry)) persistentMemoryProofs.set(entry, freezeDeep(value));
            return value;
        };
        const persistentDigest = value => SemanticRecallIndex.sourceHash(JSON.stringify(persistentRecord(value)));
        const freezeDeep = (value, seen = new WeakSet()) => {
            if (!value || typeof value !== 'object' || seen.has(value)) return value;
            seen.add(value);
            for (const nested of Object.values(value)) freezeDeep(nested, seen);
            return Object.freeze(value);
        };
        // Snapshot data has no mutable collection methods, including cross-realm Set/Map.
        const immutableCopy = value => {
            if (!value || typeof value !== 'object') return value;
            const kind = Object.prototype.toString.call(value);
            if (kind === '[object Set]') return freezeDeep(Array.from(value, immutableCopy));
            if (kind === '[object Map]') return freezeDeep(Array.from(value, ([key, item]) => [immutableCopy(key), immutableCopy(item)]));
            if (Array.isArray(value)) return freezeDeep(value.map(immutableCopy));
            return freezeDeep(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableCopy(item)])));
        };
        const memoryDriftContext = snapshot => snapshot.ephemeralDriftExclusion
            ? { ...snapshot.ephemeralDriftExclusion, turns: new Set(list(snapshot.ephemeralDriftExclusion.turns)) } : null;
        const deny = reason => ({ eligible: false, reason });
        const allow = () => ({ eligible: true, reason: '' });
        const blocked = value => value === true;
        const forbidden = record => {
            const fields = [record, record?.meta, record?.provenance, record?.projection].map(object);
            if (fields.some(item => blocked(item.hiddenFromPrompt) || blocked(item.stale) || blocked(item.rollbackTombstone) || item.active === false || item.tombstone === true)) return 'inactive';
            if (fields.some(item => ['retracted', 'superseded'].includes(str(item.provenanceStatus || item.status).toLowerCase()))) return 'provenance';
            if (fields.some(item => ['candidate_deleted', 'superseded'].includes(str(item.rollbackState).toLowerCase()))) return 'rollback';
            return '';
        };
        const signed = (record, domain, snapshot) => {
            const scopes = [record?.scopeKey, record?.scopeId, record?.runtimeScopeId, record?.engineState?.scopeKey, record?.meta?.scopeKey].map(str).filter(Boolean);
            if (scopes.some(scope => scope !== snapshot.scopeKey && scope !== snapshot.worldlineScopeKey)) return { ok: false, reason: 'scope_mismatch' };
            const pass = readPass?.snapshot === snapshot ? readPass.proofs
                : validationBatch?.snapshot === snapshot ? validationBatch : null;
            const descriptor = Object.getOwnPropertyDescriptor(IntegrityMetaManager, 'validateIntegrityMeta');
            // Preserve ordinary call evaluation: select the method before evaluating
            // context getters, then use that selected method for this invocation.
            const validator = IntegrityMetaManager.validateIntegrityMeta;
            const context = { domain, scopeKey: snapshot.scopeKey };
            const proof = pass?.witnesses.get(record);
            if (proof && descriptor?.value === nativeIntegrityValidator && validator === nativeIntegrityValidator) {
                return validateOwnedTypedRecallIntegrity(record, context, pass.checksums, value => {
                    if (value === record && pass.witnesses.get(record) === proof && TypedChecksumWitness.matches(proof)) return true;
                    // Never requalify a graph after a callback changed its witness.
                    pass.witnesses.delete(record);
                    pass.checksums.delete(record);
                    return false;
                });
            }
            return Reflect.apply(validator, IntegrityMetaManager, [record, context]);
        };
        const redact = (text, viewerId) => SecretKnowledgeCore.redactForViewer(str(text), viewerId || 'planner');
        const selected = (value, maxDepth = 3) => {
            if (maxDepth < 0 || value == null) return [];
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [str(value)].filter(Boolean);
            if (Array.isArray(value)) return value.flatMap(item => selected(item, maxDepth - 1));
            if (typeof value !== 'object') return [];
            return Object.entries(value).filter(([key]) => !/(?:secret|private|pov|hidden|integrity|meta|timestamp|created|updated)/i.test(key))
                .flatMap(([key, item]) => selected(item, maxDepth - 1).map(text => `${key}: ${text}`));
        };
        const trim = (parts, family, snapshot, limits = {}) => {
            const max = Math.max(64, Math.min(16000, Number(limits.maxCharsByType?.[family] ?? limits.maxChars ?? 800) || 800));
            const source = parts.map(item => redact(item, snapshot.viewerId)).filter(Boolean).join('\n');
            return { text: source.slice(0, max), version: VERSIONS[family], trim: { originalChars: source.length, maxChars: max, truncated: source.length > max } };
        };
        const exclusion = (unit, terms = {}) => {
            const excluded = object(terms);
            if (list(excluded.identities).includes(unit.identity) || list(excluded.memoryIds).includes(unit.locator.id) && unit.family === 'memory') return true;
            if (unit.family === 'entity' && list(excluded.entityNames).some(name => [unit.record?.name, ...list(unit.record?.meta?.aliases), ...list(unit.record?.aliases), ...list(unit.record?.profile?.aliases), ...list(unit.record?.identity?.aliases)]
                .some(alias => entityAliasKey(name) === entityAliasKey(alias)))) return true;
            return false;
        };
        const liveTurn = (turn, snapshot) => {
            const n = Number(turn);
            const state = snapshot.worldlineEligibilityState || snapshot.worldlineState;
            if (!(n > 0) || !state) return true;
            return LibraTurnWorldline.filterSupersededEntityRecords([{ meta: { created: n } }], state).items.length > 0;
        };
        const lore = snapshot => list(snapshot?.canonicalLore);
        const uniqueEntry = (snapshot, comment, family) => {
            const found = lore(snapshot).filter(item => item?.comment === comment);
            if (found.length > 1) {
                if (!snapshot.diagnostics.some(item => item.reason === 'singleton_collision' && item.family === family && item.comment === comment))
                    snapshot.diagnostics.push({ family, reason: 'singleton_collision', comment, count: found.length });
                return null;
            }
            return found[0] || null;
        };
        const worldGraph = snapshot => {
            const entry = uniqueEntry(snapshot, COMMENTS.worldGraph, 'world');
            const graph = parse(entry);
            if (!graph || typeof graph !== 'object') return null;
            const rawNodes = list(graph.nodes).filter(item => Array.isArray(item) && item.length === 2);
            const counts = new Map();
            for (const [id] of rawNodes) counts.set(str(id), (counts.get(str(id)) || 0) + 1);
            return { entry, graph, rawNodes, nodes: new Map(rawNodes.filter(([id]) => counts.get(str(id)) === 1).map(([id, node]) => [str(id), node])) };
        };
        const worldChain = (id, nodes) => {
            const chain = [], seen = new Set();
            let next = str(id);
            while (next && nodes.has(next) && !seen.has(next)) {
                seen.add(next);
                const node = nodes.get(next);
                chain.unshift(node);
                next = str(node?.parent);
            }
            return { chain, cycle: !!next && seen.has(next), missingParent: !!next && !nodes.has(next) };
        };
        // Matches HierarchicalWorldManager's deepMerge / override / isolate semantics,
        // using only the captured graph rather than the active manager profile.
        const mergeWorldRules = (base, overlay) => {
            const result = { ...base };
            for (const [key, value] of Object.entries(object(overlay))) {
                if (Array.isArray(value)) result[key] = [...new Set([...list(result[key]), ...value])];
                else if (value && typeof value === 'object') result[key] = mergeWorldRules(object(result[key]), value);
                else result[key] = value;
            }
            return result;
        };
        const effectiveWorld = (candidate, snapshot) => {
            const chain = worldChain(candidate.id, candidate.source.nodes).chain;
            let rules = { exists: {}, systems: {}, physics: {}, custom: {} }, contributing = [];
            for (const node of chain) {
                const overlay = node?.rules;
                const replace = ['isolate', 'override'].includes(str(overlay?.inheritance?.mode));
                if (replace) { rules = safeClone(overlay); contributing = []; }
                else if (overlay) rules = mergeWorldRules(rules, overlay);
                contributing.push(node);
            }
            const promoted = object(rules?.ruleMeta?.promotedRules);
            const ruleLines = selected({ exists: rules.exists, systems: rules.systems, setting: rules.setting, physics: rules.physics, custom: rules.custom }, 4);
            const safeRules = ruleLines.filter(line => {
                const matching = Object.entries(promoted).find(([text]) => line.includes(text));
                return !matching || liveTurn(matching[1], snapshot);
            });
            const expression = {
                chain, rules,
                parts: [...contributing.flatMap(node => [str(node?.name), str(node?.meta?.worldSummary), str(node?.meta?.notes)]), ...safeRules].filter(Boolean)
            };
            try { worldRuleStarts.set(expression, expression.parts.length - safeRules.length); } catch (_) {}
            return expression;
        };
        const entityAliasKey = name => str(name).normalize('NFKC').toLowerCase();
        // The legacy EntityManager resolver reads its active cache/shadow even when lore
        // is passed. Resolve exact canonical aliases inside this snapshot, fail on ambiguity.
        const resolveScopedEntityAlias = (name, snapshot) => {
            const key = entityAliasKey(name);
            if (!key) return null;
            if (readPass?.snapshot === snapshot) {
                if (!readPass.aliases) {
                    const aliases = new Map();
                    for (const record of lore(snapshot).filter(row => row?.comment === COMMENTS.entity).map(parse)) {
                        if (!record || !signed(record, 'entity', snapshot).ok || !EntityManager.isPromptVisibleEntityRecord(record)
                            || forbidden(record) || !liveTurn(record.meta?.created, snapshot)) continue;
                        const keys = new Set([record.name, ...list(record.meta?.aliases), ...list(record.aliases),
                            ...list(record.profile?.aliases), ...list(record.identity?.aliases)].map(entityAliasKey).filter(Boolean));
                        for (const alias of keys) aliases.set(alias, aliases.has(alias) ? null : record);
                    }
                    readPass.aliases = aliases;
                }
                const record = readPass.aliases.get(key);
                return record && str(record.id) ? record : null;
            }
            const records = lore(snapshot).filter(row => row?.comment === COMMENTS.entity).map(parse)
                .filter(record => record && signed(record, 'entity', snapshot).ok
                    && EntityManager.isPromptVisibleEntityRecord(record) && !forbidden(record)
                    && liveTurn(record.meta?.created, snapshot))
                .filter(record => [record.name, ...list(record.meta?.aliases), ...list(record.aliases), ...list(record.profile?.aliases), ...list(record.identity?.aliases)]
                    .some(alias => entityAliasKey(alias) === key));
            return records.length === 1 && str(records[0].id) ? records[0] : null;
        };
        const relatedRelations = (entity, snapshot) => {
            const cache = readPass?.snapshot === snapshot ? readPass.relations : null;
            const id = str(entity.id);
            if (cache?.has(id)) return cache.get(id);
            const relations = lore(snapshot).filter(row => row?.comment === 'lmai_relation')
                .map(entry => ({ entry, record: parse(entry) }))
                .filter(({ record }) => record && [record.entityA, record.entityB].some(name => str(resolveScopedEntityAlias(name, snapshot)?.id) === id))
                .filter(({ record }) => signed(record, 'relation', snapshot).ok && !forbidden(record) && liveTurn(record.meta?.created, snapshot));
            if (cache) cache.set(id, relations);
            return relations;
        };
        const narrativeProjection = (record, snapshot) => {
            const itemTurns = item => [item?.turn, item?.sourceTurn, item?.upToTurn, item?.meta?.sourceTurn, item?.meta?.created, item?.provenance?.turn, ...list(item?.turns), ...list(item?.evidenceTurns)]
                .map(Number).filter(turn => Number.isFinite(turn) && turn > 0);
            const fields = ['phase', 'primaryConflict', 'continuityBrief', 'currentContext', 'keyPoints', 'activeThreads', 'unresolvedQuestions', 'recentEvents'];
            const evidenceTurns = list(record.evidenceTurns).map(Number).filter(turn => Number.isFinite(turn) && turn > 0);
            const turns = [...list(record.turns).map(Number), ...evidenceTurns,
                ...fields.flatMap(field => (Array.isArray(record[field]) ? record[field] : [record[field]]).flatMap(itemTurns))]
                .filter(turn => Number.isFinite(turn) && turn > 0);
            const mixed = turns.some(turn => !liveTurn(turn, snapshot));
            const projected = { name: record.name, arcKey: record.arcKey }, omittedFields = [];
            let liveEvidence = !mixed;
            for (const field of fields) {
                const value = record[field];
                if (value == null) continue;
                if (!mixed) { projected[field] = value; continue; }
                const items = Array.isArray(value) ? value : [value];
                const kept = items.filter(item => { const anchors = itemTurns(item); return anchors.length && anchors.every(turn => liveTurn(turn, snapshot)); });
                if (kept.length) { projected[field] = Array.isArray(value) ? kept : kept[0]; liveEvidence = true; }
                if (kept.length !== items.length) omittedFields.push(field);
            }
            projected.evidenceTurns = evidenceTurns.filter(turn => liveTurn(turn, snapshot));
            if (projected.evidenceTurns.length) liveEvidence = true;
            if (projected.evidenceTurns.length !== evidenceTurns.length) omittedFields.push('evidenceTurns');
            const memoryRefs = list(record.memoryRefs).filter(id => {
                const rows = lore(snapshot).filter(row => row?.comment === COMMENTS.memory && [str(row.key), str(row.key).replace(/^lmai_memory::/, '')].includes(str(id)));
                return rows.length === 1 && MemoryEngine.inspectRecallEligibility(rows[0], {
                    scopeKey: snapshot.scopeKey, worldlineScopeKey: snapshot.worldlineScopeKey, worldlineState: snapshot.worldlineState,
                    currentTurn: snapshot.currentTurn, ephemeralDriftExclusion: memoryDriftContext(snapshot)
                }).eligible;
            });
            if (memoryRefs.length) liveEvidence = true;
            return { record: projected, memoryRefs, liveEvidence, partial: mixed ? { omittedFields, reason: 'narrative_partial_provenance' } : null };
        };

        const adapters = {
            memory: {
                enumerate: snapshot => lore(snapshot).filter(row => row?.comment === COMMENTS.memory).map(entry => ({ entry, record: entry, id: str(entry.key).replace(/^lmai_memory::/, ''), subtype: 'entry' })),
                identity: (candidate, snapshot) => ({ identity: uid(snapshot.scopeKey, 'memory', 'entry', candidate.id), locator: { family: 'memory', subtype: 'entry', id: candidate.id, entryKey: candidate.entry.key } }),
                eligibility: (unit, snapshot) => MemoryEngine.inspectRecallEligibility(unit.entry, { scopeKey: snapshot.scopeKey, worldlineScopeKey: snapshot.worldlineScopeKey, worldlineState: snapshot.worldlineState, currentTurn: snapshot.currentTurn, ephemeralDriftExclusion: memoryDriftContext(snapshot) }),
                representation: (candidate, snapshot, limits) => {
                    const max = Number(limits.maxCharsByType?.memory ?? limits.maxChars ?? 800) || 800;
                    const text = CompactMemoryCodec.buildRecallScoringTextFromEntry(candidate.entry, max) || CompactMemoryCodec.buildSearchTextFromEntry(candidate.entry);
                    return trim([text], 'memory', snapshot, limits);
                },
                dependency: candidate => digest(candidate.entry.content),
                sourceRefs: candidate => [candidate.entry.key]
            },
            entity: {
                enumerate: snapshot => lore(snapshot).filter(row => row?.comment === COMMENTS.entity).map(entry => ({ entry, record: parse(entry), subtype: 'canonical' }))
                    .filter(item => item.record && typeof item.record === 'object').map(item => ({ ...item, id: str(item.record.id) })),
                identity: (candidate, snapshot) => ({ identity: uid(snapshot.scopeKey, 'entity', 'canonical', candidate.id), locator: { family: 'entity', subtype: 'canonical', id: candidate.id, entryKey: candidate.entry.key } }),
                eligibility: (unit, snapshot) => {
                    const record = unit.record;
                    const integrity = signed(record, 'entity', snapshot);
                    if (!integrity.ok) return deny(`integrity:${integrity.reason}`);
                    if (!str(record.name) || EntityManager.isBlockedEntityName(record.name, lore(snapshot))) return deny('blocked_name');
                    if (!EntityManager.isPromptVisibleEntityRecord(record)) return deny('absorption');
                    const reason = forbidden(record);
                    if (reason) return deny(reason);
                    if (!liveTurn(record.meta?.created, snapshot)) return deny('worldline');
                    return allow();
                },
                representation: (candidate, snapshot, limits) => {
                    const record = candidate.record;
                    const parts = [record.name, ...list(record.meta?.aliases), record.identity?.summary, record.identity?.roleInStory,
                        record.currentState?.summary, record.currentState?.location, ...selected(record.currentState?.physicalState, 2),
                        ...selected(record.currentState?.emotionalState, 2), record.continuity?.summary, record.status?.notes];
                    for (const { record: relation } of relatedRelations(record, snapshot)) parts.push(
                        `관계 ${str(relation.entityA)} ↔ ${str(relation.entityB)}`,
                        relation.relationType, relation.currentStatus?.summary, relation.currentStatus?.publicLayer,
                        relation.currentStatus?.boundaryState, relation.event
                    );
                    return trim(parts, 'entity', snapshot, limits);
                },
                dependency: (candidate, snapshot) => digest([candidate.record, relatedRelations(candidate.record, snapshot).map(item => item.record), snapshot.worldlineRevision]),
                sourceRefs: (candidate, snapshot) => [candidate.entry.key, ...relatedRelations(candidate.record, snapshot).map(item => item.entry.key)]
            },
            world: {
                enumerate: snapshot => {
                    const out = [];
                    const source = worldGraph(snapshot);
                    if (source) for (const [id, node] of source.rawNodes) out.push({ id: str(id), record: node, parentRecord: source.graph, entry: source.entry, subtype: 'node', source });
                    const stateEntry = uniqueEntry(snapshot, COMMENTS.worldStates, 'world');
                    const state = parse(stateEntry);
                    if (state && typeof state === 'object') {
                        for (const item of list(state.turnLog)) out.push({ id: str(item?.turn), record: item, parentRecord: state, entry: stateEntry, subtype: 'state_turn' });
                        for (const item of list(state.consolidated)) out.push({
                            // A consolidation can emit both periodic and critical rows at one turn.
                            // Preserve explicit IDs; duplicate IDs (or duplicate legacy type/turns)
                            // still reach the common identity-collision rejection below.
                            id: str(item?.id) || (str(item?.upToTurn ?? item?.turn)
                                ? JSON.stringify([str(item?.type), str(item?.upToTurn ?? item?.turn)]) : ''),
                            record: item, parentRecord: state, entry: stateEntry, subtype: 'state_summary'
                        });
                    }
                    const additionalEntry = uniqueEntry(snapshot, COMMENTS.worldAdditional, 'world');
                    const additional = parse(additionalEntry);
                    // Only persisted fact rows, never directives or their activation controls.
                    for (const item of list(additional?.worldCodex)) out.push({ id: str(item?.id), record: item, parentRecord: additional, entry: additionalEntry, subtype: 'codex_fact' });
                    return out;
                },
                identity: (candidate, snapshot) => ({ identity: uid(snapshot.scopeKey, 'world', candidate.subtype, candidate.id), locator: { family: 'world', subtype: candidate.subtype, id: candidate.id, entryKey: candidate.entry.key } }),
                eligibility: (unit, snapshot) => {
                    if (unit.locator.subtype === 'node') {
                        const integrity = signed(unit.parentRecord, 'world', snapshot);
                        if (!integrity.ok) return deny(`integrity:${integrity.reason}`);
                        const graph = worldGraph(snapshot);
                        const chain = graph && worldChain(unit.locator.id, graph.nodes);
                        if (!chain || chain.cycle || chain.missingParent) return deny('world_parent');
                        for (const node of chain.chain) {
                            const reason = forbidden(node);
                            if (reason) return deny(reason);
                            if (!liveTurn(node?.meta?.created, snapshot)) return deny('worldline');
                        }
                        return allow(); // isActive selects the current place; it does not bar recall.
                    }
                    const integrity = signed(unit.parentRecord, 'world', snapshot);
                    if (!integrity.ok) return deny(`integrity:${integrity.reason}`);
                    if (unit.locator.subtype === 'codex_fact') {
                        const parentScope = str(getManagedScopedEntryScope(unit.entry, unit.parentRecord));
                        if (parentScope && parentScope !== snapshot.scopeKey) return deny('scope');
                        const fact = unit.record;
                        if (fact.injectionDisabled === true || list(unit.parentRecord?.deletedItemKeys).some(key => key === `codex:id:${fact.id}` || key === `codex:sig:${fact.signature}`)) return deny('codex_disabled');
                        if (!str(fact.content) || !['world_identity', 'world_laws', 'world_limits', 'world_geography', 'world_history', 'world_society'].includes(str(fact.subject)) || fact.directive || fact.type) return deny('codex_not_fact');
                        if (!liveTurn(fact.updatedTurn || fact.createdTurn, snapshot)) return deny('worldline');
                    }
                    const reason = forbidden(unit.record);
                    if (reason) return deny(reason);
                    if (unit.locator.subtype === 'state_summary') {
                        const end = Number(unit.record?.upToTurn || unit.record?.turn || 0);
                        const start = Number(unit.record?.firstTurn || unit.record?.fromTurn || 1);
                        const state = snapshot.worldlineEligibilityState || snapshot.worldlineState;
                        if (end > 0 && start > 0 && Array.from(LibraTurnWorldline.buildSupersededTurnSet(state).superseded)
                            .some(turn => turn >= start && turn <= end)) return deny('worldline_range');
                    }
                    if (!liveTurn(unit.record?.turn || unit.record?.upToTurn, snapshot)) return deny('worldline');
                    return allow();
                },
                representation: (candidate, snapshot, limits) => candidate.subtype === 'node'
                    ? trim(effectiveWorld(candidate, snapshot).parts, 'world', snapshot, limits)
                    : candidate.subtype === 'codex_fact'
                    ? trim([candidate.record.scope?.type, candidate.record.scope?.id, candidate.record.subject, candidate.record.content], 'world', snapshot, limits)
                    : candidate.subtype === 'state_summary'
                    ? trim([candidate.record.description, ...selected(candidate.record.changes, 2),
                        candidate.record.reason, ...selected(candidate.record.entities, 2)], 'world', snapshot, limits)
                    : trim([candidate.record.worldSummary, candidate.record.currentLocation, candidate.record.currentScene,
                        ...selected(candidate.record.ruleHighlights, 2), ...selected(candidate.record.activeEvents, 2),
                        ...selected(candidate.record.notes, 2)], 'world', snapshot, limits),
                dependency: (candidate, snapshot) => candidate.subtype === 'node'
                    ? digest([effectiveWorld(candidate, snapshot), snapshot.worldlineRevision, snapshot.viewerId, VERSIONS.world])
                    : digest([candidate.parentRecord?.meta?.integrity, candidate.parentRecord?.scopeKey, candidate.parentRecord?.deletedItemKeys, candidate.record, snapshot.worldlineRevision]),
                sourceRefs: candidate => candidate.subtype === 'node'
                    ? [candidate.entry.key, ...worldChain(candidate.id, candidate.source.nodes).chain.map(node => str(node.id)).filter(Boolean)]
                    : [candidate.entry.key]
            },
            narrative: {
                enumerate: snapshot => {
                    const entry = uniqueEntry(snapshot, COMMENTS.narrative, 'narrative');
                    const state = parse(entry);
                    return list(state?.storylines).map(record => ({ entry, record, parentRecord: state, id: str(record?.id), subtype: 'storyline' }));
                },
                identity: (candidate, snapshot) => ({ identity: uid(snapshot.scopeKey, 'narrative', 'storyline', candidate.id), locator: { family: 'narrative', subtype: 'storyline', id: candidate.id, entryKey: candidate.entry.key } }),
                eligibility: (unit, snapshot) => {
                    const integrity = signed(unit.parentRecord, 'narrative', snapshot);
                    if (!integrity.ok) return deny(`integrity:${integrity.reason}`);
                    const reason = forbidden(unit.record);
                    if (reason) return deny(reason);
                    const turns = list(unit.record.turns).map(Number).filter(turn => turn > 0);
                    if (turns.length && !turns.some(turn => liveTurn(turn, snapshot))) return deny('worldline');
                    if (!narrativeProjection(unit.record, snapshot).liveEvidence) return deny('narrative_partial_provenance');
                    return allow();
                },
                representation: (candidate, snapshot, limits) => {
                    const projection = narrativeProjection(candidate.record, snapshot);
                    const record = projection.record;
                    return { ...trim([record.name, record.arcKey, record.phase, record.primaryConflict, record.continuityBrief,
                        record.currentContext, ...selected(record.keyPoints, 2), ...selected(record.activeThreads, 3),
                        ...selected(record.unresolvedQuestions, 2), ...selected(record.recentEvents, 2),
                        ...selected(record.evidenceTurns, 1)], 'narrative', snapshot, limits), partial: projection.partial };
                },
                dependency: (candidate, snapshot) => digest([candidate.parentRecord?.meta?.integrity, candidate.record,
                    list(candidate.record.memoryRefs).map(id => lore(snapshot).filter(row => row?.comment === COMMENTS.memory && [str(row.key), str(row.key).replace(/^lmai_memory::/, '')].includes(str(id)))), snapshot.worldlineRevision]),
                sourceRefs: (candidate, snapshot) => { const projection = narrativeProjection(candidate.record, snapshot); return [candidate.entry?.key, ...projection.memoryRefs, ...list(projection.record.evidenceTurns)].filter(Boolean); }
            }
        };
        for (const [family, adapter] of Object.entries(adapters)) {
            // Aggregate signatures validate the whole container on every request;
            // sibling checksum/turn changes are not this unit's expression inputs.
            adapter.persistentDependency = (candidate, snapshot) => family === 'memory' ? persistentDigest(persistentMemory(candidate.entry))
                : family === 'entity' ? persistentDigest([candidate.record, relatedRelations(candidate.record, snapshot).map(item => item.record)])
                : family === 'world' ? candidate.subtype === 'node'
                    ? persistentDigest([effectiveWorld(candidate, snapshot), snapshot.viewerId, VERSIONS.world])
                    : persistentDigest([candidate.parentRecord?.scopeKey, candidate.parentRecord?.deletedItemKeys, candidate.record])
                : persistentDigest([candidate.record, narrativeProjection(candidate.record, snapshot),
                    list(candidate.record.memoryRefs).map(id => lore(snapshot).filter(row => row?.comment === COMMENTS.memory && [str(row.key), str(row.key).replace(/^lmai_memory::/, '')].includes(str(id))).map(persistentMemory))]);
            adapter.resolve = (locator, snapshot) => {
                if (locator?.family && locator.family !== family) return null;
                const found = adapter.enumerate(snapshot).filter(candidate => candidate.id === locator?.id && candidate.subtype === locator?.subtype);
                return found.length === 1 ? found[0] : null;
            };
            const buildRepresentation = adapter.representation;
            adapter.representation = (candidate, snapshot, limits = {}) => ({ ...buildRepresentation(candidate, snapshot, limits), dependencyHash: adapter.dependency(candidate, snapshot) });
            const checkEligibility = adapter.eligibility;
            adapter.eligibility = (unit, snapshot, exclusions = {}) => {
                if (!unit || unit.scopeKey !== snapshot?.scopeKey) return deny('scope');
                if (exclusion(unit, exclusions)) return deny('user_exclusion');
                return checkEligibility(unit, snapshot);
            };
            adapter.heuristic = (query, unit) => {
                const queryTokens = new Set(TokenizerEngine.tokenize(str(query))), documentTokens = new Set(TokenizerEngine.tokenize(unit.text));
                const overlap = [...queryTokens].filter(token => documentTokens.has(token));
                const score = queryTokens.size && documentTokens.size ? overlap.length / Math.sqrt(queryTokens.size * documentTokens.size) : 0;
                return { rawScore: score, evidence: { lexicalOverlap: overlap.length, matchedTokens: overlap, signal: 'typed_lexical_cosine_v1' } };
            };
            adapter.admission = (candidate, unit, snapshot, policy) => DualRecallEngine.admit(candidate, unit, snapshot, policy);
            adapter.formatter = (unit, snapshot, options = {}) => {
                if (!inspect(unit, snapshot, options.exclusions || {}).eligible) return [];
                const current = resolveConsumerBinding(unit.identity, snapshot);
                return [{ family, identity: current.identity, text: redact(current.text, snapshot.viewerId), roles: current.roles, sourceRefs: current.sourceRefs }];
            };
        }
        const capture = (char, chat, options = {}) => {
            const scopeKey = str(getChatRuntimeScopeKey(chat, char));
            if (!scopeKey) throw new Error('typed_recall_requires_scope');
            const worldlineScopeKey = str(LibraDataStorage.scopeKeyFor(char, chat, null)) || scopeKey;
            const fromLore = LibraLoreConsolidator.unpack(list(chat?.localLore), { raw: true });
            let scopedShadow = [];
            // Never use active-scope unpack. Only this explicitly addressed resident scope.
            if (typeof LibraDataStorage.isHydrated === 'function' && typeof LibraDataStorage.getShadowEntries === 'function'
                && LibraDataStorage.isHydrated(worldlineScopeKey)) scopedShadow = LibraDataStorage.getShadowEntries(worldlineScopeKey);
            const seen = new Set(fromLore.map(entry => str(entry?.key)));
            const foreignHost = fromLore.filter(entry => !LibraDataStorage.isLibraEntry(entry));
            const canonicalLore = options.verifiedCanonicalEntries !== undefined && !foreignHost.length
                && LibraDataStorage.isVerifiedReadonlyEntries(options.verifiedCanonicalEntries)
                ? options.verifiedCanonicalEntries
                : safeClone(options.verifiedCanonicalEntries !== undefined
                    ? [...foreignHost, ...list(options.verifiedCanonicalEntries)]
                    : [...fromLore, ...list(scopedShadow).filter(entry => !seen.has(str(entry?.key)))]);
            const worldlineState = options.worldlineState === undefined ? LibraTurnWorldline.get(worldlineScopeKey) : options.worldlineState;
            const worldlineEligibilityState = LibraTurnWorldline.withRequestExclusion(worldlineState,
                options.ephemeralDriftExclusion, worldlineScopeKey);
            const snapshot = {
                scopeKey, branchId: str(chat?.branchId || chat?.meta?.branchId),
                worldlineScopeKey, worldlineState: safeClone(worldlineState),
                worldlineEligibilityState: worldlineEligibilityState === worldlineState ? null : safeClone(worldlineEligibilityState),
                worldlineRevision: digest(worldlineState || {}), corpusRevision: digest(canonicalLore),
                requestGeneration: ++generation, resetGeneration:Number(options.resetGeneration??PersonaScopeIdentity.get(char,chat)?.resetGeneration??0), currentTurn: Number(options.currentTurn ?? MemoryState.currentTurn ?? 0),
                viewerId: str(options.viewerId || 'planner'), ephemeralDriftExclusion: immutableCopy(options.ephemeralDriftExclusion || null),
                canonicalLore, diagnostics: []
            };
            freezeDeep(snapshot.canonicalLore);
            freezeDeep(snapshot.worldlineState);
            freezeDeep(snapshot.worldlineEligibilityState);
            const sourceBinding = LibraDataStorage.verifiedReadonlySourceBinding(canonicalLore);
            if (sourceBinding?.scopeKey === worldlineScopeKey && sourceBinding.resetGeneration === snapshot.resetGeneration) {
                sourceHandles.set(snapshot, Object.freeze({ schema: 'libra.typed_canonical_source_handle.v1',
                    scopeKey, worldlineScopeKey, resetGeneration: snapshot.resetGeneration,
                    corpusRevision: snapshot.corpusRevision, entryCount: canonicalLore.length }));
            }
            issuedSnapshots.add(snapshot);
            return Object.freeze(snapshot);
        };
        const refreshProductionCore = async (options = {}, capsule = null) => {
            const guard=options.guard||(()=>true), expected=options.admission;
            if(!guard())throw new Error('request_invalidated');
            const char=await RisuCompat.getCharacter(),chat=char?await getActiveChatForCharacter(char,null,{authorityRequest:options.authorityRequest}):null;
            if(!chat||!guard())throw new Error('canonical_target_unavailable');
            const ownedHostEligible=capsule?isOwnedHydrationHostEligible(char,chat):false;
            const admission=capsule?await OwnedHydrationValidation.prepare(capsule,char,chat):await LibraDataStorage.preparePersonaContext(char,chat,{authorityRequest:options.authorityRequest});
            if(!admission.ok||!guard())throw new Error(admission.reason||'request_invalidated');
            if(expected&&['scopeKey','runtimeScopeKey','resetGeneration'].some(k=>admission[k]!==expected[k]))throw new Error('canonical_identity_changed');
            if(options.branchId!==undefined&&str(chat.branchId||chat.meta?.branchId)!==options.branchId)throw new Error('canonical_branch_changed');
            const observation=capsule?await OwnedHydrationValidation.read(capsule,admission.scopeKey):null;
            const canonical=capsule?observation.read:await LibraDataStorage.readVerified(admission.scopeKey, { readonly: true, authorityRequest:options.authorityRequest });
            if(!canonical.ok||canonical.resetGeneration!==admission.resetGeneration||!guard())throw new Error(canonical.reason||'canonical_generation_changed');
            if(capsule&&!['issued','missing'].includes(observation.status))throw new Error('validation_source_stale');
            const freshChar=await RisuCompat.getCharacter(),freshChat=freshChar?await getActiveChatForCharacter(freshChar,null,{authorityRequest:options.authorityRequest}):null;
            if(!freshChat||!guard()||getChatRuntimeScopeKey(freshChat,freshChar)!==admission.runtimeScopeKey
                ||str(freshChat.branchId||freshChat.meta?.branchId)!==str(chat.branchId||chat.meta?.branchId))throw new Error('canonical_identity_changed');
            const hydrationContext={char,chat,scopeKey:admission.scopeKey,
                runtimeScopeKey:admission.runtimeScopeKey,runtimeChatId:admission.chatId,canonicalEnvelopeVerified:true};
            const inspected=capsule?OwnedHydrationValidation.inspect(capsule,observation,canonical.entries,hydrationContext,
                ownedHostEligible&&isOwnedHydrationHostEligible(char,chat)&&isOwnedHydrationHostEligible(freshChar,freshChat))
                :LibraDataStorage.inspectHydrationEntries(canonical.entries,hydrationContext);
            if(!inspected.ok)throw new Error('canonical_provenance_unverified');
            const pairs=LibraTurnWorldline.buildTopologyPairs(freshChat);
            return capture(freshChar,freshChat,{...options,resetGeneration:canonical.resetGeneration,verifiedCanonicalEntries:inspected.entries,
                ephemeralDriftExclusion:LibraTurnWorldline.buildDriftExclusion(admission.scopeKey,pairs)});
        };
        const refreshProduction = async (options = {}) => refreshProductionCore(options);
        refreshProductionWithOwnedHydration = (capsule, options = {}) => refreshProductionCore(options, capsule);
        const enumerate = (snapshot, policy = {}) => {
            if (!snapshot?.scopeKey || !Array.isArray(snapshot.canonicalLore)) return [];
            const previousPass = readPass;
            readPass = Object.isFrozen(snapshot.canonicalLore) && snapshot.canonicalLore.every(Object.isFrozen)
                ? { snapshot, entries: new Set(snapshot.canonicalLore), parsed: new WeakMap(), aliases: null, relations: new Map(),
                    proofs: consumerBindingPasses.has(policy) && validationBatch?.snapshot === snapshot ? validationBatch : checksumPass() }
                : null;
            try {
            // A targeted read must not erase diagnostics for unrelated families.
            // Full corpus enumeration owns resetting the complete diagnostic view.
            if (!Array.isArray(policy.bindingIdentities)) snapshot.diagnostics.length = 0;
            const all = [], counts = new Map();
            // Binding checks still enumerate candidate identities to detect collisions,
            // but only rebuild the representations required by this independent pass.
            // No derived map or representation survives into a later validity pass.
            const bound = Array.isArray(policy.bindingIdentities) ? new Set(policy.bindingIdentities) : null;
            const boundFamilies = bound && new Set([...bound].map(identity => {
                try { const parts=JSON.parse(identity); return parts[0]===snapshot.scopeKey ? parts[1] : null; } catch (_) { return null; }
            }));
            for (const [family, adapter] of Object.entries(adapters)) {
                if (boundFamilies && !boundFamilies.has(family)) continue;
                for (const candidate of adapter.enumerate(snapshot)) {
                    if (!candidate?.entry || !str(candidate.id)) {
                        snapshot.diagnostics.push({ family, reason: 'missing_identity', entryKey: candidate?.entry?.key || '' });
                        continue;
                    }
                    const { identity, locator } = adapter.identity(candidate, snapshot);
                    if (bound && !bound.has(identity)) continue;
                    counts.set(identity, (counts.get(identity) || 0) + 1);
                    const representation = adapter.representation(candidate, snapshot, policy.representation || {});
                    const sourceRefs = adapter.sourceRefs(candidate, snapshot);
                    const unit = {
                        identity, family, subtype: candidate.subtype, locator, record: candidate.record, entry: candidate.entry,
                        parentRecord: candidate.parentRecord || null, scopeKey: snapshot.scopeKey,
                        contentHash: contentProof(candidate.entry, family + ':' + candidate.subtype + ':' + candidate.id + ':content', candidate.record, digest), dependencyHash: representation.dependencyHash,
                        ...(consumerBindingPasses.has(policy) ? {} : {
                        persistentContentHash: contentProof(candidate.entry, family + ':' + candidate.subtype + ':' + candidate.id + ':persistent', family === 'memory' ? persistentMemory(candidate.record) : candidate.record, persistentDigest),
                        persistentDependencyHash: family === 'memory'
                            ? contentProof(candidate.entry, 'memory:persistent-dependency', persistentMemory(candidate.entry), persistentDigest)
                            : adapter.persistentDependency(candidate, snapshot) }),
                        representationVersion: representation.version, text: representation.text, trim: representation.trim,
                        partial: representation.partial || null,
                        roles: family === 'narrative' ? ['continuity', 'evidence'] : family === 'world' ? ['world_rule', 'world_state'] : family === 'entity' ? ['entity_state', 'relation'] : ['memory_evidence'],
                        sourceRefs, lineage: family === 'narrative' ? { parentIds: [candidate.record?.meta?.repairedFromStorylineId, ...list(candidate.record?.meta?.mergedFromStorylineIds)].map(str).filter(Boolean) } : null
                    };
                    all.push(unit);
                    if (unit.partial) snapshot.diagnostics.push({ family, reason: unit.partial.reason, identity, omittedFields: unit.partial.omittedFields });
                }
            }
            const collisions = new Set([...counts].filter(([, count]) => count > 1).map(([identity]) => identity));
            for (const unit of all) if (collisions.has(unit.identity)) snapshot.diagnostics.push({ family: unit.family, reason: 'identity_collision', identity: unit.identity, entryKey: unit.entry.key });
            return all.filter(unit => !collisions.has(unit.identity));
            } finally { readPass = previousPass; }
        };
        // Observation only. Canonical record anchors are not original source spans.
        // Reuse the existing projection/inheritance rules; never alter representation.
        const observeAnchors = (unit, snapshot, body) => {
            const anchors = [], sourceBindings = [], reasons = ['source_lineage_incomplete'];
            const ordinal = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value
                : typeof value === 'string' && /^(?:T)?[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value.replace(/^T/, '')))
                    ? Number(value.replace(/^T/, '')) : null;
            const add = (value, semantic, evidencePath, extra = {}) => {
                const n = ordinal(value);
                if (n && liveTurn(n, snapshot) && anchors.length < 64) anchors.push({ semantic, ordinal: n, raw: value,
                    evidencePath, scopeKey: snapshot.scopeKey, sourceSpanVerified: false, ...extra });
            };
            if (unit.family === 'memory') {
                const meta = MemoryEngine.parseMeta(unit.entry.content);
                add(meta.t, 'memory_record_anchor', 'entry.content.META.t');
                const binding = {};
                for (const key of ['s_id', 'chatId', 'sourceHash', 'turnKey', 'userTurnKey', 'messageSignature']) {
                    if (typeof meta[key] === 'string' && meta[key] && meta[key].length <= 1024) binding[key] = meta[key];
                }
                if (Array.isArray(meta.sourceMessageIds) && meta.sourceMessageIds.length > 0 && meta.sourceMessageIds.length <= 64
                    && meta.sourceMessageIds.every(id => typeof id === 'string' && id && id.length <= 1024)) binding.sourceMessageIds = meta.sourceMessageIds.slice();
                if (Object.keys(binding).length) sourceBindings.push({ evidencePath: 'entry.content.META', ...binding });
                if (!anchors.length) reasons.push('record_anchor_missing');
            } else if (unit.family === 'entity') {
                // Relations can be clipped out; sourceRefs are dependencies only.
                reasons.push('field_lineage_missing', 'merged_record_anchor_only');
            } else if (unit.family === 'world' && unit.subtype === 'node') {
                const source = worldGraph(snapshot);
                if (source) {
                    const effective = effectiveWorld({ id: unit.locator.id, source }, snapshot);
                    const chain = effective.chain;
                    let start = 0;
                    chain.forEach((node, i) => { if (['override', 'isolate'].includes(str(node.rules?.inheritance?.mode))) start = i; });
                    const ruleStart = worldRuleStarts.get(effective);
                    const ruleParts = Number.isInteger(ruleStart) ? effective.parts.slice(ruleStart).map((line,i) => ({ line, partIndex: ruleStart + i })) : [];
                    for (const [text, turn] of Object.entries(object(effective.rules.ruleMeta?.promotedRules)).slice(0,64)) {
                        if (!text || text.length > 16000 || !ordinal(turn) || !liveTurn(ordinal(turn), snapshot)) continue;
                        // Match only the rule occurrence produced by the existing
                        // expression assembly. Identical names/summaries are not rules.
                        const matches = ruleParts.filter(part => part.line.includes(text));
                        if (matches.length !== 1) continue;
                        const priorParts = effective.parts.slice(0,matches[0].partIndex).map(part => redact(part,snapshot.viewerId)).filter(Boolean);
                        const line = redact(matches[0].line,snapshot.viewerId);
                        const ruleOffset = priorParts.join('\n').length + (priorParts.length ? 1 : 0);
                        if (!line.includes(text) || body.slice(ruleOffset,ruleOffset + line.length) !== line) continue;
                        const owners = chain.slice(start).filter(node => Object.prototype.hasOwnProperty.call(object(node.rules?.ruleMeta?.promotedRules), text));
                        const owner = owners.at(-1);
                        if (!owner || owner.rules.ruleMeta.promotedRules[text] !== turn) continue;
                        const index = list(source.graph.nodes).findIndex(row => Array.isArray(row) && row[1] === owner);
                        if (index < 0) continue;
                        const offset = ruleOffset + line.indexOf(text);
                        add(turn, 'promoted_rule_anchor', `entry.content.nodes[${index}][1].rules.ruleMeta.promotedRules[${JSON.stringify(text)}]`,
                            { bodySpan: { start: offset, end: offset + text.length } });
                    }
                }
                reasons.push('node_field_lineage_missing');
            } else if (unit.family === 'world') {
                if (unit.subtype === 'state_turn') add(unit.record.turn, 'world_state_observation_anchor', 'record.turn');
                if (unit.subtype === 'state_summary') {
                    add(unit.record.turn ?? unit.record.upToTurn, 'world_summary_observation_anchor', unit.record.turn != null ? 'record.turn' : 'record.upToTurn');
                    reasons.push('summary_input_lineage_not_persisted');
                } else reasons.push('field_lineage_missing');
            } else if (unit.family === 'narrative') {
                list(unit.record.evidenceTurns).slice(0,64).forEach((value,i) => add(value,
                    'narrative_record_evidence_anchor', `record.evidenceTurns[${i}]`));
                reasons.push('record_links_not_text_span_lineage');
                if (unit.partial) reasons.push('narrative_partial_provenance');
            }
            return { anchors, sourceBindings, reasons, completeSourceCount: null,
                coverage: anchors.length || sourceBindings.length ? 'partial' : 'unknown' };
        };
        const enumerateBindings = (snapshot, policy, identities) => enumerate(snapshot, { ...policy, bindingIdentities: identities });
        const resolve = (identity, snapshot) => enumerateBindings(snapshot, {}, [identity]).find(unit => unit.identity === identity) || null;
        enumerateTypedConsumerBindings = (snapshot, policy, identities) => {
            // Only this freshly allocated policy object carries the capability.
            // No source, unit, verdict or ambient mode survives this synchronous pass.
            const options = { ...policy, bindingIdentities: Array.isArray(identities) ? identities : [] };
            consumerBindingPasses.add(options);
            try {
                return validationBatchDepth
                    ? enumerate(snapshot, options)
                    : withTypedRecallValidationBatch(snapshot, () => enumerate(snapshot, options));
            }
            finally { consumerBindingPasses.delete(options); }
        };
        const resolveConsumerBinding = (identity, snapshot) => enumerateTypedConsumerBindings(snapshot, {}, [identity]).find(unit => unit.identity === identity) || null;
        const inspect = (unit, snapshot, exclusions = {}) => {
            if (!unit || !snapshot || unit.scopeKey !== snapshot.scopeKey) return deny('scope');
            if (exclusion(unit, exclusions)) return deny('user_exclusion');
            const adapter = adapters[unit.family];
            if (!adapter) return deny('unknown_type');
            const current = resolveConsumerBinding(unit.identity, snapshot);
            if (!current || current.contentHash !== unit.contentHash || current.dependencyHash !== unit.dependencyHash) return deny('stale_generation');
            return adapter.eligibility(current, snapshot);
        };
        const deriveLineage = (before, after) => {
            if (!before?.scopeKey || before.scopeKey !== after?.scopeKey) return { links: [], diagnostics: [{ reason: 'scope_mismatch' }] };
            const oldUnits = enumerate(before), newUnits = enumerate(after);
            const oldIds = new Set(oldUnits.map(unit => unit.identity));
            const newById = new Map(newUnits.map(unit => [unit.identity, unit]));
            const links = [], diagnostics = [];
            const add = (from, candidates, reason) => {
                const unique = [...new Set(candidates.map(unit => unit.identity))];
                if (unique.length === 1) links.push({ from: from.identity, to: unique[0], reason });
                else if (unique.length > 1) diagnostics.push({ reason: 'ambiguous_lineage', identity: from.identity, candidates: unique });
            };
            const overlap = (left, right) => list(left).some(value => list(right).some(other => String(value) === String(other)));
            for (const old of oldUnits) {
                if (old.family === 'entity' && inspect(old, before).eligible && !inspect(newById.get(old.identity), after).eligible) {
                    const successorName = str(newById.get(old.identity)?.record?.meta?.absorption?.targetName || old.record?.meta?.absorption?.targetName);
                    if (successorName) add(old, newUnits.filter(unit => unit.family === 'entity' && unit.identity !== old.identity && str(unit.record?.name) === successorName && inspect(unit, after).eligible), 'entity_absorption');
                }
                if (old.family === 'narrative' && !newById.has(old.identity)) {
                    add(old, newUnits.filter(unit => unit.family === 'narrative'
                        && (overlap(old.record?.turns, unit.record?.turns)
                            || list(unit.lineage?.parentIds).includes(old.locator.id))), 'narrative_merge');
                }
            }
            for (const next of newUnits) {
                if (next.family !== 'narrative' || oldIds.has(next.identity)) continue;
                const parents = oldUnits.filter(old => old.family === 'narrative'
                    && (list(next.lineage?.parentIds).includes(old.locator.id)
                        || overlap(old.record?.turns, next.record?.turns)));
                if (parents.length === 1) links.push({ from: parents[0].identity, to: next.identity, reason: 'narrative_split' });
                else if (parents.length > 1) diagnostics.push({ reason: 'ambiguous_lineage', identity: next.identity, parents: parents.map(item => item.identity) });
            }
            return { links, diagnostics };
        };
        return Object.freeze({ capture, isIssuedSnapshot, canonicalSourceHandle, refreshProduction, enumerate, enumerateBindings, resolve, inspect, deriveLineage, observeAnchors, adapters, VERSIONS });
    })();
