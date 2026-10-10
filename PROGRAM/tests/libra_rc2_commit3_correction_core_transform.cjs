'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };
  const replaceRange = (label, start, end, replacement) => {
    const from = source.indexOf(start);
    if (from < 0) throw new Error(`${label}:start_missing`);
    if (source.indexOf(start, from + start.length) >= 0) throw new Error(`${label}:start_not_unique`);
    const to = source.indexOf(end, from + start.length);
    if (to < 0) throw new Error(`${label}:end_missing`);
    source = `${source.slice(0, from)}${replacement}${source.slice(to)}`;
    labels.push(label);
  };

  rep('narrative_head_correction_provenance_normalization',
`    out.source = __libraNarrativeText(src.source, 80) || 'normalized';
    out.revision = Number(src.revision || 0);`,
`    out.source = __libraNarrativeText(src.source, 80) || 'normalized';
    out.revision = Number(src.revision || 0);
    out.provenance = src.provenance && typeof src.provenance === 'object' ? __libraNarrativeClone(src.provenance) : {};
    out.correctionProvenance = src.correctionProvenance && typeof src.correctionProvenance === 'object' ? __libraNarrativeClone(src.correctionProvenance) : null;`);
  rep('narrative_arc_correction_provenance_normalization',
`            lastTurn: Number(item.lastTurn || item.updatedTurn || out.updatedThroughTurn || 0),
            evidence: item.evidence && typeof item.evidence === 'object' ? __libraNarrativeClone(item.evidence) : {}`,
`            lastTurn: Number(item.lastTurn || item.updatedTurn || out.updatedThroughTurn || 0),
            evidence: item.evidence && typeof item.evidence === 'object' ? __libraNarrativeClone(item.evidence) : {},
            provenance: item.provenance && typeof item.provenance === 'object' ? __libraNarrativeClone(item.provenance) : {},
            correctionProvenance: item.correctionProvenance && typeof item.correctionProvenance === 'object' ? __libraNarrativeClone(item.correctionProvenance) : null`);
  rep('narrative_thread_correction_provenance_normalization',
`            resolvedTurn: Number(item.resolvedTurn || 0),
            evidence: item.evidence && typeof item.evidence === 'object' ? __libraNarrativeClone(item.evidence) : {}`,
`            resolvedTurn: Number(item.resolvedTurn || 0),
            evidence: item.evidence && typeof item.evidence === 'object' ? __libraNarrativeClone(item.evidence) : {},
            provenance: item.provenance && typeof item.provenance === 'object' ? __libraNarrativeClone(item.provenance) : {},
            correctionProvenance: item.correctionProvenance && typeof item.correctionProvenance === 'object' ? __libraNarrativeClone(item.correctionProvenance) : null`);
  rep('narrative_turning_correction_provenance_normalization',
`            throughTurn: Number(item.throughTurn || item.turn || out.updatedThroughTurn || 0),
            evidence: item.evidence && typeof item.evidence === 'object' ? __libraNarrativeClone(item.evidence) : {}`,
`            throughTurn: Number(item.throughTurn || item.turn || out.updatedThroughTurn || 0),
            evidence: item.evidence && typeof item.evidence === 'object' ? __libraNarrativeClone(item.evidence) : {},
            provenance: item.provenance && typeof item.provenance === 'object' ? __libraNarrativeClone(item.provenance) : {},
            correctionProvenance: item.correctionProvenance && typeof item.correctionProvenance === 'object' ? __libraNarrativeClone(item.correctionProvenance) : null`);
  rep('narrative_lock_correction_provenance_normalization',
`        return { id: __libraNarrativeText(item.id, 120) || __libraNarrativeId('lock', summary, index), summary: summary, status: item.status === 'released' ? 'released' : 'active', evidence: item.evidence && typeof item.evidence === 'object' ? __libraNarrativeClone(item.evidence) : {} };`,
`        return { id: __libraNarrativeText(item.id, 120) || __libraNarrativeId('lock', summary, index), summary: summary, status: item.status === 'released' ? 'released' : 'active', evidence: item.evidence && typeof item.evidence === 'object' ? __libraNarrativeClone(item.evidence) : {}, provenance: item.provenance && typeof item.provenance === 'object' ? __libraNarrativeClone(item.provenance) : {}, correctionProvenance: item.correctionProvenance && typeof item.correctionProvenance === 'object' ? __libraNarrativeClone(item.correctionProvenance) : null };`);
  rep('narrative_motif_correction_provenance_normalization',
`        return { id: __libraNarrativeText(item.id, 120) || __libraNarrativeId('motif', summary, index), summary: summary, count: Math.max(2, Number(item.count || 2)), lastTurn: Number(item.lastTurn || out.updatedThroughTurn || 0) };`,
`        return { id: __libraNarrativeText(item.id, 120) || __libraNarrativeId('motif', summary, index), summary: summary, count: Math.max(2, Number(item.count || 2)), lastTurn: Number(item.lastTurn || out.updatedThroughTurn || 0), provenance: item.provenance && typeof item.provenance === 'object' ? __libraNarrativeClone(item.provenance) : {}, correctionProvenance: item.correctionProvenance && typeof item.correctionProvenance === 'object' ? __libraNarrativeClone(item.correctionProvenance) : null };`);

  replaceRange('correction_journal_semantic_readback',
    '    const normalizeStateCorrectionStatus = value =>',
    '    const loadStateWorldlineMeta = async scope =>',
`    const normalizeStateCorrectionStatus = value => STATE_CORRECTION_STATUSES.includes(string(value || '')) ? string(value) : 'active';
    const stateStoredValueDigest = value => digest(stableReferenceJson(value ?? null));
    const stateCorrectionFailure = (code, message = code) => {
      const error = new Error(message);
      error.code = code;
      return error;
    };
    const assertStateStoredValue = async (storageKey, expected, code) => {
      const actual = await storage.getJson(storageKey, null);
      if (stateStoredValueDigest(actual) !== stateStoredValueDigest(expected)) throw stateCorrectionFailure(code);
      return actual;
    };
    const restoreStateStoredValue = async (storageKey, previous, code) => {
      if (previous == null) await storage.remove(storageKey);
      else await storage.setJson(storageKey, previous);
      return await assertStateStoredValue(storageKey, previous ?? null, code);
    };
    const loadStateCorrectionJournal = async (scope, options = {}) => {
      const loaded = await storage.getJson(key.stateCorrections(scope), null);
      if (loaded == null) return stateCorrectionDefaultStore(scope);
      if (loaded?.schema !== STATE_CORRECTION_STORE_SCHEMA || string(loaded.scopeKey || '') !== string(scope?.scopeKey || '')) {
        if (options.strict === true) throw stateCorrectionFailure('STATE_CORRECTION_JOURNAL_INVALID');
        return stateCorrectionDefaultStore(scope);
      }
      if (options.strict === true && asArray(loaded.records).some(row => row?.schema !== STATE_CORRECTION_EVENT_SCHEMA
        || string(row?.scopeKey || '') !== string(scope?.scopeKey || '')
        || !STATE_CORRECTION_STATUSES.includes(string(row?.status || '')))) throw stateCorrectionFailure('STATE_CORRECTION_JOURNAL_INVALID');
      return {
        ...stateCorrectionDefaultStore(scope), ...clone(loaded),
        records: asArray(loaded.records).map(row => ({ ...clone(row), schema: STATE_CORRECTION_EVENT_SCHEMA, status: normalizeStateCorrectionStatus(row?.status) })),
        migratedLegacyOverrideIds: asArray(loaded.migratedLegacyOverrideIds).map(string)
      };
    };
    const saveStateCorrectionJournal = async (scope, storeValue) => {
      const store = { ...stateCorrectionDefaultStore(scope), ...clone(storeValue), schema: STATE_CORRECTION_STORE_SCHEMA, scopeKey: string(scope.scopeKey), updatedAt: nowIso() };
      store.revision = Math.max(0, Number(store.revision || 0)) + 1;
      store.records = asArray(store.records).map(row => ({ ...clone(row), schema: STATE_CORRECTION_EVENT_SCHEMA, scopeKey: string(scope.scopeKey), status: normalizeStateCorrectionStatus(row?.status) }));
      store.migratedLegacyOverrideIds = Array.from(new Set(asArray(store.migratedLegacyOverrideIds).map(string).filter(Boolean)));
      const storageKey=key.stateCorrections(scope); const previous=await storage.getJson(storageKey,null);
      try {
        await storage.setJson(storageKey, store);
        const readback = await assertStateStoredValue(storageKey, store, 'STATE_CORRECTION_JOURNAL_READBACK_FAILED');
        if (readback?.schema !== STATE_CORRECTION_STORE_SCHEMA
          || string(readback.scopeKey || '') !== string(scope.scopeKey)
          || Number(readback.revision || 0) !== Number(store.revision || 0)) throw stateCorrectionFailure('STATE_CORRECTION_JOURNAL_READBACK_FAILED');
        return readback;
      } catch(error) {
        try { await restoreStateStoredValue(storageKey,previous,'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'); }
        catch(rollbackError) { throw stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE',compact(rollbackError?.message||rollbackError,300)); }
        throw error;
      }
    };
`);

  rep('strict_correction_journal_migration',
`      if (legacy?.schema !== CONTINUITY_OVERRIDE_SCHEMA || !asArray(legacy.overrides).length) return await loadStateCorrectionJournal(scope);
      let store = await loadStateCorrectionJournal(scope);`,
`      if (legacy?.schema !== CONTINUITY_OVERRIDE_SCHEMA || !asArray(legacy.overrides).length) return await loadStateCorrectionJournal(scope,{strict:true});
      let store = await loadStateCorrectionJournal(scope,{strict:true});`);

  rep('strict_worldline_meta_loader',
`    const loadStateWorldlineMeta = async scope => {
      const loaded = await storage.getJson(key.stateWorldlineMeta(scope), null);
      if (loaded?.schema !== STATE_WORLDLINE_META_SCHEMA || string(loaded.scopeKey || '') !== string(scope?.scopeKey || '')) return stateWorldlineDefaultMeta(scope);`,
`    const loadStateWorldlineMeta = async (scope, options = {}) => {
      const loaded = await storage.getJson(key.stateWorldlineMeta(scope), null);
      if (loaded == null) return stateWorldlineDefaultMeta(scope);
      if (loaded?.schema !== STATE_WORLDLINE_META_SCHEMA || string(loaded.scopeKey || '') !== string(scope?.scopeKey || '')) {
        if (options.strict === true) throw stateCorrectionFailure('STATE_WORLDLINE_META_INVALID');
        return stateWorldlineDefaultMeta(scope);
      }
      if (options.strict === true) {
        const activeId=string(loaded.activeWorldlineId||''); const lines=asObject(loaded.worldlines);
        if (!activeId || !lines[activeId] || string(lines[activeId]?.id||'')!==activeId
          || Object.entries(lines).some(([idValue,row])=>!row||typeof row!=='object'||string(row.id||'')!==string(idValue))) throw stateCorrectionFailure('STATE_WORLDLINE_META_INVALID');
      }`);
  rep('worldline_meta_semantic_readback',
`    const saveStateWorldlineMeta = async (scope, metaValue) => {
      const meta = { ...stateWorldlineDefaultMeta(scope), ...clone(metaValue), schema: STATE_WORLDLINE_META_SCHEMA, scopeKey: string(scope.scopeKey), updatedAt: nowIso() };
      meta.revision = Math.max(0, Number(meta.revision || 0)) + 1;
      await storage.setJson(key.stateWorldlineMeta(scope), meta);
      const readback = await storage.getJson(key.stateWorldlineMeta(scope), null);
      if (readback?.schema !== STATE_WORLDLINE_META_SCHEMA || Number(readback.revision || 0) !== Number(meta.revision || 0)) throw new Error('state_worldline_meta_readback_failed');
      return readback;
    };`,
`    const saveStateWorldlineMeta = async (scope, metaValue) => {
      const meta = { ...stateWorldlineDefaultMeta(scope), ...clone(metaValue), schema: STATE_WORLDLINE_META_SCHEMA, scopeKey: string(scope.scopeKey), updatedAt: nowIso() };
      meta.revision = Math.max(0, Number(meta.revision || 0)) + 1;
      const storageKey=key.stateWorldlineMeta(scope); const previous=await storage.getJson(storageKey,null);
      try {
        await storage.setJson(storageKey,meta);
        const readback=await assertStateStoredValue(storageKey,meta,'STATE_WORLDLINE_META_READBACK_FAILED');
        if (readback?.schema!==STATE_WORLDLINE_META_SCHEMA || string(readback.scopeKey||'')!==string(scope.scopeKey) || Number(readback.revision||0)!==Number(meta.revision||0)) throw stateCorrectionFailure('STATE_WORLDLINE_META_READBACK_FAILED');
        return readback;
      } catch(error) {
        try { await restoreStateStoredValue(storageKey,previous,'STATE_WORLDLINE_META_ROLLBACK_FAILED'); }
        catch(rollbackError) { throw stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE',compact(rollbackError?.message||rollbackError,300)); }
        throw error;
      }
    };`);

  rep('invalid_narrative_correction_fails_closed',
`      if (patch.narrative && typeof patch.narrative === 'object') {
        const narrativePatch = __libraNarrativeNormalizePatch(patch.narrative);
        if (narrativePatch.ok) {
          head.narrative = __libraNarrativeApplyPatch(head.narrative, narrativePatch.patch, Number(correction?.anchor?.throughTurn || head?.throughTurn || 0));
          head.narrative.correctionProvenance = provenance;
        }
      }`,
`      if ((targetDomain === 'head' || targetDomain === 'narrative') && patch.narrative && typeof patch.narrative === 'object') {
        const narrativePatch = __libraNarrativeNormalizePatch(patch.narrative);
        if (!narrativePatch.ok) throw stateCorrectionFailure('STATE_CORRECTION_NARRATIVE_PATCH_INVALID', compact(narrativePatch.reason || 'state_correction_narrative_patch_invalid', 300));
        head.narrative = __libraNarrativeApplyPatch(head.narrative, narrativePatch.patch, Number(correction?.anchor?.throughTurn || head?.throughTurn || 0));
        for (const keyName of ['arcs','threads','locks','motifs','turningPoints']) {
          const touched=new Set(asArray(narrativePatch.patch?.[keyName]).map(row=>string(row?.id||'')).filter(Boolean));
          head.narrative[keyName]=asArray(head.narrative?.[keyName]).map(row=>touched.has(string(row?.id||''))?{...row,correctionProvenance:clone(provenance)}:row);
        }
        head.narrative.correctionProvenance = provenance;
      }`);

  rep('correction_target_domain_guard_characters',
`      const charById = new Map(asArray(head.characters).map(row => [string(row.id), row]));
      const charByName = new Map(asArray(head.characters).flatMap(row => [row.name, ...asArray(row.aliases)].map(name => [continuityStateNameKey(name), row])));
      if (Array.isArray(patch.characters)) {`,
`      const targetDomain=string(correction?.target?.domain||'head');
      const charById = new Map(asArray(head.characters).map(row => [string(row.id), row]));
      const charByName = new Map(asArray(head.characters).flatMap(row => [row.name, ...asArray(row.aliases)].map(name => [continuityStateNameKey(name), row])));
      if ((targetDomain === 'head' || targetDomain === 'characters') && Array.isArray(patch.characters)) {`);
  rep('correction_target_domain_guard_relationships',
`      if (Array.isArray(patch.relationships)) {`,
`      if ((targetDomain === 'head' || targetDomain === 'relationships') && Array.isArray(patch.relationships)) {`);
  rep('correction_target_domain_guard_world',
`      if (Array.isArray(patch.world)) {`,
`      if ((targetDomain === 'head' || targetDomain === 'world') && Array.isArray(patch.world)) {`);

  rep('continuity_rebuild_reconcile_respects_preview',
`          const journal = await reconcileStateCorrectionStatuses({ scope: context.scope, manifest, finalTurn: Number(ref?.turnRange?.end || 0), worldlineId: meta.activeWorldlineId || 'main' });`,
`          const journal = await reconcileStateCorrectionStatuses({ scope: context.scope, manifest, finalTurn: Number(ref?.turnRange?.end || 0), worldlineId: meta.activeWorldlineId || 'main', persist });`);
  rep('continuity_rebuild_reapplies_narrative_corrections',
`      if (head) {
        head.narrative = __libraNarrativeNormalizeState(narrativeHead);
        const narrativeRef = refs.slice().reverse().find(Boolean) || null;
        const narrativeEvidence = continuityEvidenceForRef(narrativeRef);
        head.domainStatus = { ...asObject(head.domainStatus), narrative: { status: head.narrative.updatedThroughTurn > 0 ? 'ready' : 'empty', sessionEpoch: Number(narrativeEvidence?.sessionEpoch || 0), throughTurn: Number(head.narrative.updatedThroughTurn || 0), reason: head.narrative.source === 'ariadne_seed' ? 'ariadne_seed_fallback' : '', evidence: narrativeEvidence, attemptedEvidence: null } };
      }`,
`      if (head) {
        head.narrative = __libraNarrativeNormalizeState(narrativeHead);
        const narrativeRef = refs.slice().reverse().find(Boolean) || null;
        const narrativeEvidence = continuityEvidenceForRef(narrativeRef);
        head.domainStatus = { ...asObject(head.domainStatus), narrative: { status: head.narrative.updatedThroughTurn > 0 ? 'ready' : 'empty', sessionEpoch: Number(narrativeEvidence?.sessionEpoch || 0), throughTurn: Number(head.narrative.updatedThroughTurn || 0), reason: head.narrative.source === 'ariadne_seed' ? 'ariadne_seed_fallback' : '', evidence: narrativeEvidence, attemptedEvidence: null } };
        try {
          const meta=await loadStateWorldlineMeta(context.scope); const activeId=string(meta.activeWorldlineId||'main');
          const finalTurn=Number(narrativeRef?.turnRange?.end||0);
          const journal=await reconcileStateCorrectionStatuses({scope:context.scope,manifest,finalTurn,worldlineId:activeId,persist});
          for (const ref of refs) {
            const through=Number(ref?.turnRange?.end||0);
            for (const correction of correctionsForAnchor(journal,through,activeId).filter(row=>string(row?.target?.domain||'head')==='narrative'||(string(row?.target?.domain||'head')==='head'&&!!row?.after?.narrative))) head=applyCorrectionProfilePatch(head,correction);
          }
          head.worldlineId=activeId;
        } catch(error) { warnings.push({startTurn:Number(narrativeRef?.turnRange?.start||0),reason:\`state_narrative_correction_replay_failed:\${compact(error?.message||error,300)}\`}); }
      }`);

  replaceRange('correction_replay_transaction',
    '    const reconcileStateCorrectionStatuses = async',
    '    const setStateWorldline = async',
`    const stateHeadCorrectionIds = headValue => {
      const head = asObject(headValue);
      const ids = new Set();
      const collect = row => {
        const correctionId = string(row?.correctionProvenance?.correctionId || '');
        if (correctionId) ids.add(correctionId);
      };
      asArray(head.characters).forEach(collect);
      asArray(head.relationships).forEach(collect);
      asArray(head.world).forEach(collect);
      collect(head.narrative);
      for (const keyName of ['arcs','threads','locks','motifs','turningPoints']) asArray(head?.narrative?.[keyName]).forEach(collect);
      return ids;
    };
    const stateHeadHasCorrection = (headValue, correctionId, domain = 'head') => {
      const head = asObject(headValue); const idValue = string(correctionId || '');
      if (!idValue) return false;
      const has = rows => asArray(rows).some(row => string(row?.correctionProvenance?.correctionId || '') === idValue);
      if (domain === 'characters') return has(head.characters);
      if (domain === 'relationships') return has(head.relationships);
      if (domain === 'world') return has(head.world);
      if (domain === 'narrative') return string(head?.narrative?.correctionProvenance?.correctionId || '') === idValue
        || ['arcs','threads','locks','motifs','turningPoints'].some(keyName => has(head?.narrative?.[keyName]));
      return stateHeadCorrectionIds(head).has(idValue);
    };
    const reconcileStateCorrectionStatuses = async ({ scope, manifest, finalTurn = Number.POSITIVE_INFINITY, worldlineId = 'main', persist = true }) => {
      let store = await migrateLegacyContinuityOverrides(scope, manifest);
      let changed=false;
      for (const rec of asArray(store.records)) {
        if (rec.status === 'deleted' || rec.status === 'superseded') continue;
        if (string(rec.worldlineId || 'main') !== string(worldlineId || 'main')) continue;
        const anchorTurn=Math.max(0,Number(rec?.anchor?.throughTurn||0));
        const expected=correctionBasisFingerprintForTurn(manifest,anchorTurn);
        let next='active';
        if (anchorTurn > Number(finalTurn)) next='dormant_after_rollback';
        else if (rec.basisFingerprint && string(rec.basisFingerprint)!==string(expected)) next='suspended';
        if (rec.status!==next) { rec.status=next; rec.updatedAt=nowIso(); changed=true; }
      }
      if (changed && persist) store=await saveStateCorrectionJournal(scope,store);
      return store;
    };
    const correctionsForAnchor = (store, anchorTurn, worldlineId='main') => asArray(store?.records)
      .filter(rec => rec.status==='active' && string(rec.worldlineId||'main')===string(worldlineId||'main') && Number(rec?.anchor?.throughTurn||0)===Number(anchorTurn||0))
      .sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')) || string(a.correctionId||'').localeCompare(string(b.correctionId||'')));
    const applyStateCorrectionsAtAnchor = (head, store, anchorTurn, worldlineId='main') => {
      let next=clone(head); const applied=[];
      for (const correction of correctionsForAnchor(store,anchorTurn,worldlineId)) {
        next=applyCorrectionProfilePatch(next,correction);
        const domain=string(correction?.target?.domain||'head');
        if (!stateHeadHasCorrection(next,correction.correctionId,domain)) throw stateCorrectionFailure('STATE_CORRECTION_NOT_APPLIED', \`state_correction_not_applied:\${string(correction.correctionId||'')}\`);
        applied.push(correction.correctionId);
      }
      return { head:next, applied };
    };
    const normalizeStateCorrectionPayload = ({ patch, target, head, manifest, anchorTurn }) => {
      const domain=string(target?.domain||'head').toLowerCase();
      if (!['head','characters','relationships','world','narrative'].includes(domain)) throw stateCorrectionFailure('STATE_CORRECTION_TARGET_INVALID');
      const mode=string(target?.mode || (domain==='narrative'?'narrative_patch':'profile_patch'));
      const requested=clone(asObject(patch));
      if (stableReferenceJson(requested).length > 262144) throw stateCorrectionFailure('STATE_CORRECTION_PATCH_TOO_LARGE');
      const normalizedTarget={...clone(asObject(target)),domain,mode};
      if (domain==='narrative') {
        const narrative=asObject(requested.narrative || requested);
        const result=__libraNarrativeNormalizePatch(narrative);
        if (!result.ok) throw stateCorrectionFailure('STATE_CORRECTION_NARRATIVE_PATCH_INVALID',compact(result.reason||'state_correction_narrative_patch_invalid',300));
        return {target:normalizedTarget,patch:{narrative:clone(result.patch)}};
      }
      const characterById=new Map(asArray(head?.characters).map(row=>[string(row?.id||''),row]));
      const characterByName=new Map(asArray(head?.characters).flatMap(row=>[row?.name,...asArray(row?.aliases)].map(name=>[continuityStateNameKey(name),row])));
      const characterCurrent=row=>(row?.id&&characterById.get(string(row.id)))||characterByName.get(continuityStateNameKey(row?.name))||null;
      const validateCharacters=rows=>asArray(rows).length>0 && asArray(rows).every(row=>!!characterCurrent(row)||!!string(row?.name||''));
      const charactersChange=rows=>asArray(rows).some(row=>{const current=characterCurrent(row);if(!current)return true;return stateStoredValueDigest({name:compact(row?.name||current.name,180),aliases:continuityStateAliases(row?.aliases??current.aliases),state:normalizeContinuityStateSet(row?.state)})!==stateStoredValueDigest({name:compact(current.name,180),aliases:continuityStateAliases(current.aliases),state:normalizeContinuityStateSet(current.state)});});
      const worldById=new Map(asArray(head?.world).map(row=>[string(row?.id||''),row]));
      const worldByName=new Map(asArray(head?.world).flatMap(row=>[row?.name,...asArray(row?.aliases)].map(name=>[continuityStateNameKey(name),row])));
      const worldCurrent=row=>(row?.id&&worldById.get(string(row.id)))||worldByName.get(continuityStateNameKey(row?.name))||null;
      const validateWorld=rows=>asArray(rows).length>0 && asArray(rows).every(row=>!!worldCurrent(row)||!!string(row?.name||''));
      const worldChange=rows=>asArray(rows).some(row=>{const current=worldCurrent(row);if(!current)return true;return stateStoredValueDigest({kind:compact(row?.kind||current.kind||'other',80),name:compact(row?.name||current.name,180),aliases:continuityStateAliases(row?.aliases??current.aliases),state:normalizeContinuityStateSet(row?.state)})!==stateStoredValueDigest({kind:compact(current.kind||'other',80),name:compact(current.name,180),aliases:continuityStateAliases(current.aliases),state:normalizeContinuityStateSet(current.state)});});
      const validateRelationships=rows=>asArray(rows).length>0 && asArray(rows).every(row=>{
        const subject=characterById.get(string(row?.subjectId||'')) || characterByName.get(continuityStateNameKey(row?.subjectName));
        const targetRow=characterById.get(string(row?.targetId||'')) || characterByName.get(continuityStateNameKey(row?.targetName));
        return !!subject && !!targetRow && subject.id!==targetRow.id;
      });
      const relationshipsChange=rows=>asArray(rows).some(row=>{const subject=characterById.get(string(row?.subjectId||''))||characterByName.get(continuityStateNameKey(row?.subjectName));const targetRow=characterById.get(string(row?.targetId||''))||characterByName.get(continuityStateNameKey(row?.targetName));if(!subject||!targetRow)return false;const dimension=CONTINUITY_STATE_RELATION_DIMENSIONS.includes(string(row?.dimension||''))?string(row.dimension):'other';const current=asArray(head?.relationships).find(item=>(row?.id&&string(item?.id||'')===string(row.id))||(item?.subjectId===subject.id&&item?.targetId===targetRow.id&&item?.dimension===dimension));if(!current)return true;return stateStoredValueDigest({subjectId:subject.id,targetId:targetRow.id,dimension,state:compact(row?.state??current.state??'',800)})!==stateStoredValueDigest({subjectId:current.subjectId,targetId:current.targetId,dimension:current.dimension,state:compact(current.state||'',800)});});
      if (domain==='characters') {
        if (!validateCharacters(requested.characters)) throw stateCorrectionFailure('STATE_CORRECTION_PATCH_INVALID');
        if (!charactersChange(requested.characters)) throw stateCorrectionFailure('STATE_CORRECTION_NO_CHANGE');
        return {target:normalizedTarget,patch:{characters:clone(requested.characters)}};
      }
      if (domain==='relationships') {
        if (!validateRelationships(requested.relationships)) throw stateCorrectionFailure('STATE_CORRECTION_PATCH_INVALID');
        if (!relationshipsChange(requested.relationships)) throw stateCorrectionFailure('STATE_CORRECTION_NO_CHANGE');
        return {target:normalizedTarget,patch:{relationships:clone(requested.relationships)}};
      }
      if (domain==='world') {
        if (!validateWorld(requested.world)) throw stateCorrectionFailure('STATE_CORRECTION_PATCH_INVALID');
        if (!worldChange(requested.world)) throw stateCorrectionFailure('STATE_CORRECTION_NO_CHANGE');
        return {target:normalizedTarget,patch:{world:clone(requested.world)}};
      }
      if (domain==='head') {
        const valid=(requested.characters&&validateCharacters(requested.characters)&&charactersChange(requested.characters))
          || (requested.relationships&&validateRelationships(requested.relationships)&&relationshipsChange(requested.relationships))
          || (requested.world&&validateWorld(requested.world)&&worldChange(requested.world))
          || (requested.narrative&&__libraNarrativeNormalizePatch(requested.narrative).ok);
        if (!valid) throw stateCorrectionFailure('STATE_CORRECTION_PATCH_INVALID');
      }
      return {target:normalizedTarget,patch:requested};
    };
    const stateCorrectionPreflight = async ({ context, manifest, patch, target, anchorTurn, basisFingerprint, worldlineId, supersedes = '' }) => {
      const meta=await loadStateWorldlineMeta(context.scope,{strict:true});
      const activeId=string(worldlineId||meta.activeWorldlineId||'main');
      if (!meta.worldlines?.[activeId]) throw stateCorrectionFailure('STATE_CORRECTION_WORLDLINE_NOT_FOUND');
      if (activeId!==string(meta.activeWorldlineId||'main')) throw stateCorrectionFailure('STATE_CORRECTION_WORLDLINE_NOT_ACTIVE');
      const turn=Math.max(0,Number(anchorTurn||0));
      const boundary=continuityStateRefs(manifest).find(ref=>Number(ref.end||0)===turn);
      if (!turn || !boundary) throw stateCorrectionFailure('STATE_CORRECTION_ANCHOR_NOT_COMMITTED');
      const expectedBasis=correctionBasisFingerprintForTurn(manifest,turn);
      if (basisFingerprint && string(basisFingerprint)!==string(expectedBasis)) throw stateCorrectionFailure('STATE_CORRECTION_BASIS_MISMATCH');
      const head=await storage.getJson(key.continuityState(context.scope),null);
      if (!head || head.schema!==CONTINUITY_STATE_SCHEMA || string(head.scopeKey||'')!==string(context.scope.scopeKey)) throw stateCorrectionFailure('STATE_CORRECTION_CURRENT_HEAD_MISSING');
      if (string(head.worldlineId||meta.activeWorldlineId||'main')!==activeId) throw stateCorrectionFailure('STATE_CORRECTION_HEAD_WORLDLINE_MISMATCH');
      if (Number(head.throughTurn||0)!==turn) throw stateCorrectionFailure('STATE_CORRECTION_HEAD_ANCHOR_MISMATCH');
      if (string(head?.basis?.sourceFingerprint||'')!==string(expectedBasis)) throw stateCorrectionFailure('STATE_CORRECTION_HEAD_BASIS_MISMATCH');
      const normalized=normalizeStateCorrectionPayload({patch,target,head,manifest,anchorTurn:turn});
      const boundaryFingerprint=stateReplayBoundaryFingerprint({scope:context.scope,manifest,meta,worldlineId:activeId});
      return {meta,activeId,turn,expectedBasis,head,normalized,supersedes:string(supersedes||''),boundaryFingerprint};
    };
    const stateReplayBoundaryFingerprint = ({scope,manifest,meta,worldlineId}) => digest(stableReferenceJson({
      scopeKey:string(scope?.scopeKey||''),worldlineId:string(worldlineId||meta?.activeWorldlineId||'main'),activeWorldlineId:string(meta?.activeWorldlineId||'main'),metaRevision:Number(meta?.revision||0),
      worldline:(()=>{const row=asObject(meta?.worldlines?.[string(worldlineId||meta?.activeWorldlineId||'main')]);return {id:string(row.id||''),parentId:row.parentId==null?null:string(row.parentId),forkTurn:Number(row.forkTurn||0),cutoffTurn:row.cutoffTurn==null?null:Number(row.cutoffTurn),active:row.active!==false};})(),branchGuard:clone(manifest?.branchGuard||{}),
      refs:[...asArray(manifest?.inheritedMemories),...Object.values(asObject(manifest?.memories))]
        .filter(ref=>ref?.status==='committed'&&ref?.key)
        .map(ref=>({key:string(ref.key),deltaKey:string(ref.continuityDeltaKey||ref.deltaKey||''),memoryId:string(ref.memoryId||''),revision:Number(ref.revision||0),sourceDigest:string(ref.sourceDigest||''),sessionEpoch:Number(ref.sessionEpoch||0),turnRange:clone(asObject(ref.turnRange)),status:string(ref.status||'')}))
        .sort((a,b)=>a.sessionEpoch-b.sessionEpoch||Number(a.turnRange?.start||0)-Number(b.turnRange?.start||0))
    }));
    const loadStateReplayBoundaryFingerprint = async ({context,pairs,worldlineId}) => {
      const manifest=await loadManifest(context.scope,asArray(pairs).length); const meta=await loadStateWorldlineMeta(context.scope,{strict:true});
      return stateReplayBoundaryFingerprint({scope:context.scope,manifest,meta,worldlineId});
    };
    const stateReplayFingerprint = ({manifest,store,worldlineId,cutoffTurn}) => digest(stableReferenceJson({worldlineId,cutoffTurn,refs:continuityStateRefs(manifest),corrections:asArray(store?.records).map(row=>({correctionId:row.correctionId,worldlineId:row.worldlineId,anchor:clone(row.anchor),basisFingerprint:row.basisFingerprint,target:clone(row.target),after:clone(row.after),policy:row.policy,status:row.status,updatedAt:row.updatedAt})),branchGuard:clone(manifest?.branchGuard||{})}));
    const stateCorrectionReplayJournalDigest = store => digest(stableReferenceJson({scopeKey:string(store?.scopeKey||''),records:asArray(store?.records),migratedLegacyOverrideIds:asArray(store?.migratedLegacyOverrideIds)}));
    const assertStateReplayJournalUnchanged = async (scope,expectedDigest) => {
      const current=await loadStateCorrectionJournal(scope,{strict:true});
      if (stateCorrectionReplayJournalDigest(current)!==string(expectedDigest||'')) throw stateCorrectionFailure('STATE_REPLAY_JOURNAL_CHANGED');
      return current;
    };
    const recordStateReplayError = async (scope,error,contextValue={}) => {
      const keyName=key.stateReplayErrors(scope); const existing=await storage.getJson(keyName,{schema:STATE_REPLAY_ERROR_SCHEMA,scopeKey:string(scope.scopeKey),records:[]}); const rec={at:nowIso(),message:compact(error?.message||error,700),code:compact(error?.code||'STATE_REPLAY_FAILED',120),context:clone(contextValue)}; existing.schema=STATE_REPLAY_ERROR_SCHEMA; existing.scopeKey=string(scope.scopeKey); existing.records=[...asArray(existing.records),rec].slice(-64); existing.updatedAt=nowIso(); await storage.setJson(keyName,existing); return rec;
    };
    const restoreStateReplayBaseline = async ({scope,head,journal,cache,meta=null,includeMeta=false,expectedHead=undefined,expectedCache=undefined,guardDerived=false,lastContinuityState=undefined,snapshotContinuityState=undefined}) => {
      const failures=[];
      const entries=[
        {storageKey:key.stateCorrections(scope),previous:journal,code:'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'},
        {storageKey:key.continuityState(scope),previous:head,expected:expectedHead,derived:true,code:'STATE_REPLAY_HEAD_ROLLBACK_FAILED'},
        {storageKey:key.stateReplayCache(scope),previous:cache,expected:expectedCache,derived:true,code:'STATE_REPLAY_CACHE_ROLLBACK_FAILED'}
      ];
      if (includeMeta) entries.unshift({storageKey:key.stateWorldlineMeta(scope),previous:meta,code:'STATE_WORLDLINE_META_ROLLBACK_FAILED'});
      for (const entry of entries) {
        try {
          if (guardDerived && entry.derived) {
            const current=await storage.getJson(entry.storageKey,null); const currentDigest=stateStoredValueDigest(current);
            const matchesExpected=entry.expected!==undefined && currentDigest===stateStoredValueDigest(entry.expected??null);
            if (currentDigest!==stateStoredValueDigest(entry.previous??null) && !matchesExpected) throw stateCorrectionFailure('STATE_REPLAY_ROLLBACK_CONFLICT');
          }
          await restoreStateStoredValue(entry.storageKey,entry.previous,entry.code);
        }
        catch(error) { failures.push({code:string(error?.code||entry.code),message:compact(error?.message||error,300)}); }
      }
      if (failures.length) {
        const error=stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE','state_correction_rollback_incomplete');
        error.failures=failures;
        throw error;
      }
      state.lastContinuityState=clone(lastContinuityState===undefined?head:lastContinuityState);
      if (sameSnapshotScope(state.snapshot?.scope,scope)) state.snapshot.continuityState=clone(snapshotContinuityState===undefined?head:snapshotContinuityState);
      return true;
    };
    const assertStateReplayHead = async ({scope,expected,worldlineId,replayFingerprint}) => {
      const raw=await assertStateStoredValue(key.continuityState(scope),expected,'STATE_REPLAY_HEAD_READBACK_FAILED');
      if (!raw || raw.schema!==CONTINUITY_STATE_SCHEMA
        || string(raw.scopeKey||'')!==string(scope.scopeKey)
        || string(raw.worldlineId||'')!==string(worldlineId)
        || string(raw?.basis?.replayFingerprint||'')!==string(replayFingerprint)
        || string(raw?.basis?.sourceFingerprint||'')!==string(expected?.basis?.sourceFingerprint||'')
        || Number(raw.throughTurn||0)!==Number(expected?.throughTurn||0)) throw stateCorrectionFailure('STATE_REPLAY_HEAD_READBACK_FAILED');
      return raw;
    };
    const rebuildCurrentStateForWorldlineUnlocked = async ({ context=null, manifest=null, pairs=null, worldlineId='', cutoffTurn=null, persist=true, reason='manual_rebuild', requiredBoundaryFingerprint='' }={}) => {
      const liveContext=context||await resolveContext(); const livePairs=Array.isArray(pairs)?pairs:buildPairs(liveContext.chat,liveContext?.scope?.scopeKey||''); const liveManifest=manifest||await loadManifest(liveContext.scope,livePairs.length);
      const previousHead=await storage.getJson(key.continuityState(liveContext.scope),null);
      const previousJournal=await storage.getJson(key.stateCorrections(liveContext.scope),null);
      const previousCache=await storage.getJson(key.stateReplayCache(liveContext.scope),null);
      const previousLastContinuityState=clone(state.lastContinuityState);
      const previousSnapshotContinuityState=sameSnapshotScope(state.snapshot?.scope,liveContext.scope)?clone(state.snapshot?.continuityState):undefined;
      let attemptedHead=undefined; let attemptedCache=undefined;
      try {
        const meta=await loadStateWorldlineMeta(liveContext.scope,{strict:true}); const activeId=string(worldlineId||meta.activeWorldlineId||'main'); const line=asObject(meta.worldlines?.[activeId]);
        if (!meta.worldlines?.[activeId]) throw stateCorrectionFailure('STATE_WORLDLINE_NOT_FOUND');
        const boundaryFingerprint=stateReplayBoundaryFingerprint({scope:liveContext.scope,manifest:liveManifest,meta,worldlineId:activeId});
        if (requiredBoundaryFingerprint && string(requiredBoundaryFingerprint)!==string(boundaryFingerprint)) throw stateCorrectionFailure('STATE_REPLAY_BOUNDARY_CHANGED');
        const effectiveCutoff=cutoffTurn==null?(line.cutoffTurn==null?Number.POSITIVE_INFINITY:Number(line.cutoffTurn)):Number(cutoffTurn);
        let store=await reconcileStateCorrectionStatuses({scope:liveContext.scope,manifest:liveManifest,finalTurn:effectiveCutoff,worldlineId:activeId,persist});
        const replayJournalDigest=stateCorrectionReplayJournalDigest(store);
        if (persist) await assertStateReplayJournalUnchanged(liveContext.scope,replayJournalDigest);
        const refs=fullContinuityRefs(liveManifest).filter(ref=>Number(ref?.turnRange?.end||0)<=effectiveCutoff);
        let head=emptyContinuityState(liveContext.scope,null,'state_replay'); const appliedCorrections=[]; let appliedDeltas=0;
        for (const ref of refs) {
          const memory=await loadMemoryRef(ref); if(!memory) throw stateCorrectionFailure('STATE_REPLAY_MEMORY_MISSING',\`state_replay_memory_missing:\${Number(ref?.turnRange?.start||0)}\`);
          const delta=await loadContinuityDelta(liveContext.scope,memory); if(!delta) throw stateCorrectionFailure('STATE_REPLAY_DELTA_MISSING',\`state_replay_delta_missing:\${Number(ref?.turnRange?.start||0)}\`);
          const through=Number(ref?.turnRange?.end||0); const prefixManifest=clone(liveManifest);
          prefixManifest.inheritedMemories=asArray(liveManifest.inheritedMemories).filter(item=>Number(item?.turnRange?.end||0)<=through);
          prefixManifest.memories=Object.fromEntries(Object.entries(asObject(liveManifest.memories)).filter(([,item])=>Number(item?.turnRange?.end||0)<=through && item?.status==='committed'));
          const preview=await updateContinuityStateAfterCommit({context:liveContext,manifest:prefixManifest,memory,delta,dryRun:true,baseHead:head}); if(preview?.head) head=preview.head; appliedDeltas+=1;
          const corrected=applyStateCorrectionsAtAnchor(head,store,through,activeId); head=corrected.head; appliedCorrections.push(...corrected.applied);
        }
        const replayFingerprint=stateReplayFingerprint({manifest:liveManifest,store,worldlineId:activeId,cutoffTurn:Number.isFinite(effectiveCutoff)?effectiveCutoff:null});
        const appliedBasisRefs=continuityStateRefs(liveManifest).filter(ref=>Number(ref.end||0)<=effectiveCutoff);
        head.basis={sourceFingerprint:continuityStateFingerprint(appliedBasisRefs),sourceCount:refs.length,replayFingerprint};
        head.worldlineId=activeId; head.updatedAt=nowIso();
        let durableHead=clone(head);
        if(persist){
          await assertStateReplayJournalUnchanged(liveContext.scope,replayJournalDigest);
          const beforeWriteBoundary=await loadStateReplayBoundaryFingerprint({context:liveContext,pairs:livePairs,worldlineId:activeId});
          if (string(beforeWriteBoundary)!==string(requiredBoundaryFingerprint||boundaryFingerprint)) throw stateCorrectionFailure('STATE_REPLAY_BOUNDARY_CHANGED');
          attemptedHead=clone(head);
          await storage.setJson(key.continuityState(liveContext.scope),head);
          durableHead=await assertStateReplayHead({scope:liveContext.scope,expected:head,worldlineId:activeId,replayFingerprint});
          const cache={schema:STATE_REPLAY_CACHE_SCHEMA,scopeKey:string(liveContext.scope.scopeKey),worldlineId:activeId,fingerprint:replayFingerprint,throughTurn:Number(durableHead.throughTurn||0),appliedDeltas,appliedCorrections:clone(appliedCorrections),reason,updatedAt:nowIso()};
          attemptedCache=clone(cache);
          await storage.setJson(key.stateReplayCache(liveContext.scope),cache);
          await assertStateStoredValue(key.stateReplayCache(liveContext.scope),cache,'STATE_REPLAY_CACHE_READBACK_FAILED');
          const finalJournal=await assertStateReplayJournalUnchanged(liveContext.scope,replayJournalDigest);
          if (stateReplayFingerprint({manifest:liveManifest,store:finalJournal,worldlineId:activeId,cutoffTurn:Number.isFinite(effectiveCutoff)?effectiveCutoff:null})!==replayFingerprint) throw stateCorrectionFailure('STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH');
          const afterWriteBoundary=await loadStateReplayBoundaryFingerprint({context:liveContext,pairs:livePairs,worldlineId:activeId});
          if (string(afterWriteBoundary)!==string(requiredBoundaryFingerprint||boundaryFingerprint)) throw stateCorrectionFailure('STATE_REPLAY_BOUNDARY_CHANGED');
          state.lastContinuityState=clone(durableHead);
          if(sameSnapshotScope(state.snapshot?.scope,liveContext.scope)) state.snapshot.continuityState=clone(durableHead);
        }
        return {ok:true,head:clone(durableHead),worldlineId:activeId,appliedDeltas,appliedCorrections,reason,replayFingerprint,replayJournalDigest};
      } catch(error) {
        let rollbackError=null;
        if (persist) {
          try { await restoreStateReplayBaseline({scope:liveContext.scope,head:previousHead,journal:previousJournal,cache:previousCache,expectedHead:attemptedHead,expectedCache:attemptedCache,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH'].includes(string(error?.code||'')),lastContinuityState:previousLastContinuityState,snapshotContinuityState:previousSnapshotContinuityState}); }
          catch(failure) { rollbackError=failure; }
        }
        const surfaced=rollbackError||error;
        await recordStateReplayError(liveContext.scope,surfaced,{reason,worldlineId,cutoffTurn,rollbackIncomplete:!!rollbackError}).catch(()=>{});
        return {ok:false,error:compact(surfaced?.message||surfaced,700),code:string(surfaced?.code||(rollbackError?'STATE_CORRECTION_ROLLBACK_INCOMPLETE':'STATE_REPLAY_FAILED')),head:clone(previousHead),restoredPrevious:persist&&!rollbackError,rollbackIncomplete:!!rollbackError,reason};
      }
    };
    const rebuildCurrentStateForWorldline = async (options={}) => {
      const initial=options.context||await resolveContext(); const expectedScopeKey=string(initial?.scope?.scopeKey||'');
      return await enqueue(expectedScopeKey,async()=>{
        assertPortableMemoryIdle();
        if (state.disposed || state.deletingScopes.has(expectedScopeKey)) throw stateCorrectionFailure('STATE_REPLAY_SCOPE_UNAVAILABLE');
        const context=await resolveContext();
        if (string(context?.scope?.scopeKey||'')!==expectedScopeKey) throw stateCorrectionFailure('STATE_REPLAY_SCOPE_CHANGED');
        return await rebuildCurrentStateForWorldlineUnlocked({...options,context});
      });
    };
    const rollbackStateCorrectionMutation = async ({scope,baseline,error,operation,correctionId=''}) => {
      if (error?.rollbackIncomplete===true || string(error?.code||'')==='STATE_CORRECTION_ROLLBACK_INCOMPLETE') {
        try { await restoreStateStoredValue(key.stateCorrections(scope),baseline.journal,'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'); }
        catch(_) {}
        await recordStateReplayError(scope,error,{operation,correctionId,rollbackIncomplete:true}).catch(()=>{});
        throw stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE',compact(error?.message||error,700));
      }
      let rollbackError=null;
      try { await restoreStateReplayBaseline({scope,head:baseline.head,journal:baseline.journal,cache:baseline.cache,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH'].includes(string(error?.code||'')),lastContinuityState:baseline.lastContinuityState,snapshotContinuityState:baseline.snapshotContinuityState}); }
      catch(failure) { rollbackError=failure; }
      const surfaced=rollbackError||error;
      await recordStateReplayError(scope,surfaced,{operation,correctionId,rollbackIncomplete:!!rollbackError}).catch(()=>{});
      if (rollbackError) throw rollbackError;
      const failed=stateCorrectionFailure('STATE_CORRECTION_TRANSACTION_FAILED',compact(error?.message||error,700));
      failed.cause=error;
      throw failed;
    };
    const appendStateCorrection = async ({ patch = {}, anchorTurn = 0, basisFingerprint = '', worldlineId = '', target = null, policy = 'point_in_time_override', supersedes = '' } = {}) => {
      const initial=await resolveContext(); const expectedScopeKey=string(initial?.scope?.scopeKey||'');
      return await enqueue(expectedScopeKey,async()=>{
        assertPortableMemoryIdle();
        if (state.disposed || state.deletingScopes.has(expectedScopeKey)) throw stateCorrectionFailure('STATE_CORRECTION_SCOPE_UNAVAILABLE');
        const context=await resolveContext(); if(string(context?.scope?.scopeKey||'')!==expectedScopeKey) throw stateCorrectionFailure('STATE_CORRECTION_SCOPE_CHANGED');
        const pairs=buildPairs(context.chat,context?.scope?.scopeKey||''); const manifest=await loadManifest(context.scope,pairs.length);
        let store=await migrateLegacyContinuityOverrides(context.scope,manifest);
        const baseline={journal:await storage.getJson(key.stateCorrections(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
        const preflight=await stateCorrectionPreflight({context,manifest,patch,target,anchorTurn,basisFingerprint,worldlineId,supersedes});
        const correctionId=id('state_correction'); let mutationStarted=false;
        try {
          if (preflight.supersedes) {
            const old=asArray(store.records).find(row=>string(row.correctionId||'')===preflight.supersedes);
            if (!old) throw stateCorrectionFailure('STATE_CORRECTION_SUPERSEDED_RECORD_NOT_FOUND');
            if (string(old.worldlineId||'main')!==preflight.activeId) throw stateCorrectionFailure('STATE_CORRECTION_SUPERSEDED_WORLDLINE_MISMATCH');
            if (!['deleted','superseded'].includes(old.status)) { old.status='superseded'; old.supersededBy=correctionId; old.updatedAt=nowIso(); }
          }
          const rec={schema:STATE_CORRECTION_EVENT_SCHEMA,correctionId,scopeKey:string(context.scope.scopeKey),worldlineId:preflight.activeId,anchor:{throughTurn:preflight.turn},basisFingerprint:preflight.expectedBasis,target:clone(preflight.normalized.target),before:null,after:clone(preflight.normalized.patch),policy,status:'active',createdAt:nowIso(),updatedAt:nowIso()};
          store.records.push(rec); mutationStarted=true; await saveStateCorrectionJournal(context.scope,store);
          const replay=await rebuildCurrentStateForWorldlineUnlocked({context,manifest,pairs,reason:'state_correction_added',persist:true,worldlineId:preflight.activeId,requiredBoundaryFingerprint:preflight.boundaryFingerprint});
          if (!replay?.ok) { const error=stateCorrectionFailure(replay?.code||'STATE_CORRECTION_REPLAY_FAILED',replay?.error||'state_correction_replay_failed'); error.rollbackIncomplete=replay?.rollbackIncomplete===true; throw error; }
          const finalJournal=await loadStateCorrectionJournal(context.scope,{strict:true}); const durable=asArray(finalJournal.records).find(row=>string(row.correctionId||'')===correctionId);
          if (!durable || durable.status!=='active') throw stateCorrectionFailure('STATE_CORRECTION_JOURNAL_POSTCONDITION_FAILED');
          const line=asObject(preflight.meta.worldlines?.[preflight.activeId]); const cutoff=line.cutoffTurn==null?null:Number(line.cutoffTurn);
          if (stateCorrectionReplayJournalDigest(finalJournal)!==string(replay.replayJournalDigest||'') || stateReplayFingerprint({manifest,store:finalJournal,worldlineId:preflight.activeId,cutoffTurn:cutoff})!==string(replay.replayFingerprint||'')) throw stateCorrectionFailure('STATE_CORRECTION_JOURNAL_POSTCONDITION_FAILED');
          if (!asArray(replay.appliedCorrections).includes(correctionId) || !stateHeadHasCorrection(replay.head,correctionId,preflight.normalized.target.domain)) throw stateCorrectionFailure('STATE_CORRECTION_HEAD_POSTCONDITION_FAILED');
          return {...clone(durable),ok:true,correction:clone(durable),replay:{ok:true,worldlineId:replay.worldlineId,appliedDeltas:replay.appliedDeltas,appliedCorrections:clone(replay.appliedCorrections),replayFingerprint:replay.replayFingerprint},head:clone(replay.head),currentHead:clone(replay.head)};
        } catch(error) {
          if (!mutationStarted) throw error;
          return await rollbackStateCorrectionMutation({scope:context.scope,baseline,error,operation:'append',correctionId});
        }
      });
    };
    const setStateCorrectionStatus = async (correctionId,status) => {
      if (!STATE_CORRECTION_STATUSES.includes(string(status||''))) throw stateCorrectionFailure('STATE_CORRECTION_STATUS_INVALID');
      const normalized=string(status); const initial=await resolveContext(); const expectedScopeKey=string(initial?.scope?.scopeKey||'');
      return await enqueue(expectedScopeKey,async()=>{
        assertPortableMemoryIdle();
        if (state.disposed || state.deletingScopes.has(expectedScopeKey)) throw stateCorrectionFailure('STATE_CORRECTION_SCOPE_UNAVAILABLE');
        const context=await resolveContext(); if(string(context?.scope?.scopeKey||'')!==expectedScopeKey) throw stateCorrectionFailure('STATE_CORRECTION_SCOPE_CHANGED');
        const pairs=buildPairs(context.chat,context?.scope?.scopeKey||''); const manifest=await loadManifest(context.scope,pairs.length);
        let store=await migrateLegacyContinuityOverrides(context.scope,manifest);
        const baseline={journal:await storage.getJson(key.stateCorrections(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
        const rec=asArray(store.records).find(row=>string(row.correctionId||'')===string(correctionId||'')); if(!rec) throw stateCorrectionFailure('STATE_CORRECTION_NOT_FOUND','state_correction_not_found');
        const meta=await loadStateWorldlineMeta(context.scope,{strict:true}); const activeId=string(meta.activeWorldlineId||'main');
        if (!meta.worldlines?.[string(rec.worldlineId||'main')]) throw stateCorrectionFailure('STATE_CORRECTION_WORLDLINE_NOT_FOUND');
        if (string(rec.worldlineId||'main')!==activeId) throw stateCorrectionFailure('STATE_CORRECTION_WORLDLINE_NOT_ACTIVE');
        const boundaryFingerprint=stateReplayBoundaryFingerprint({scope:context.scope,manifest,meta,worldlineId:activeId});
        let mutationStarted=false;
        try {
          rec.status=normalized; rec.updatedAt=nowIso(); mutationStarted=true; await saveStateCorrectionJournal(context.scope,store);
          const replay=await rebuildCurrentStateForWorldlineUnlocked({context,manifest,pairs,reason:'state_correction_status_changed',persist:true,worldlineId:activeId,requiredBoundaryFingerprint:boundaryFingerprint});
          if (!replay?.ok) { const error=stateCorrectionFailure(replay?.code||'STATE_CORRECTION_REPLAY_FAILED',replay?.error||'state_correction_replay_failed'); error.rollbackIncomplete=replay?.rollbackIncomplete===true; throw error; }
          const finalJournal=await loadStateCorrectionJournal(context.scope,{strict:true}); const durable=asArray(finalJournal.records).find(row=>string(row.correctionId||'')===string(correctionId||''));
          if (!durable || durable.status!==normalized) throw stateCorrectionFailure('STATE_CORRECTION_STATUS_POSTCONDITION_FAILED');
          const line=asObject(meta.worldlines?.[activeId]); const cutoff=line.cutoffTurn==null?null:Number(line.cutoffTurn);
          if (stateCorrectionReplayJournalDigest(finalJournal)!==string(replay.replayJournalDigest||'') || stateReplayFingerprint({manifest,store:finalJournal,worldlineId:activeId,cutoffTurn:cutoff})!==string(replay.replayFingerprint||'')) throw stateCorrectionFailure('STATE_CORRECTION_STATUS_POSTCONDITION_FAILED');
          const applied=asArray(replay.appliedCorrections).includes(string(correctionId||''));
          if ((normalized==='active'&&!applied) || (normalized!=='active'&&applied)) throw stateCorrectionFailure('STATE_CORRECTION_STATUS_REPLAY_MISMATCH');
          return {...clone(durable),ok:true,correction:clone(durable),replay:{ok:true,worldlineId:replay.worldlineId,appliedDeltas:replay.appliedDeltas,appliedCorrections:clone(replay.appliedCorrections),replayFingerprint:replay.replayFingerprint},head:clone(replay.head),currentHead:clone(replay.head)};
        } catch(error) {
          if (!mutationStarted) throw error;
          return await rollbackStateCorrectionMutation({scope:context.scope,baseline,error,operation:'status',correctionId:string(correctionId||'')});
        }
      });
    };
`);

  replaceRange('worldline_replay_transaction',
    '    const setStateWorldline = async',
    '    const portableLineageSnapshot = async',
`    const mutateStateWorldline = async ({operation='set',worldlineId='',parentId='main',forkTurn=0,cutoffTurn=null,throughTurn=0}={}) => {
      const initial=await resolveContext(); const expectedScopeKey=string(initial?.scope?.scopeKey||'');
      return await enqueue(expectedScopeKey,async()=>{
        assertPortableMemoryIdle();
        if (state.disposed || state.deletingScopes.has(expectedScopeKey)) throw stateCorrectionFailure('STATE_WORLDLINE_SCOPE_UNAVAILABLE');
        const context=await resolveContext(); if(string(context?.scope?.scopeKey||'')!==expectedScopeKey) throw stateCorrectionFailure('STATE_WORLDLINE_SCOPE_CHANGED');
        const pairs=buildPairs(context.chat,context?.scope?.scopeKey||''); const manifest=await loadManifest(context.scope,pairs.length);
        const baseline={meta:await storage.getJson(key.stateWorldlineMeta(context.scope),null),journal:await storage.getJson(key.stateCorrections(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
        let meta=await loadStateWorldlineMeta(context.scope,{strict:true}); let activeId=''; let effectiveCutoff=null; let mutationStarted=false;
        try {
          if (operation==='rollback') {
            activeId=string(worldlineId||meta.activeWorldlineId||'main');
            if (!meta.worldlines?.[activeId]) throw stateCorrectionFailure('STATE_WORLDLINE_NOT_FOUND');
            const turn=Math.max(0,Number(throughTurn||0));
            if (turn && !continuityStateRefs(manifest).some(ref=>Number(ref.end||0)===turn)) throw stateCorrectionFailure('STATE_WORLDLINE_ROLLBACK_ANCHOR_NOT_COMMITTED');
            meta.worldlines[activeId]={...clone(meta.worldlines[activeId]),cutoffTurn:turn,updatedAt:nowIso()}; effectiveCutoff=turn;
          } else {
            activeId=string(worldlineId||'main'); const parent=string(parentId||'main');
            if (!meta.worldlines?.[activeId]) {
              if (activeId!=='main'&&!meta.worldlines?.[parent]) throw stateCorrectionFailure('STATE_WORLDLINE_PARENT_NOT_FOUND');
              const fork=Math.max(0,Number(forkTurn||0));
              if (fork&&!continuityStateRefs(manifest).some(ref=>Number(ref.end||0)===fork)) throw stateCorrectionFailure('STATE_WORLDLINE_FORK_ANCHOR_NOT_COMMITTED');
              meta.worldlines[activeId]={id:activeId,parentId:activeId==='main'?null:parent,forkTurn:fork,cutoffTurn:cutoffTurn==null?null:Math.max(0,Number(cutoffTurn||0)),active:true,createdAt:nowIso(),updatedAt:nowIso()};
            } else {
              meta.worldlines[activeId]={...clone(meta.worldlines[activeId]),cutoffTurn:cutoffTurn==null?meta.worldlines[activeId].cutoffTurn:Math.max(0,Number(cutoffTurn||0)),updatedAt:nowIso()};
            }
            effectiveCutoff=meta.worldlines[activeId].cutoffTurn;
          }
          meta.activeWorldlineId=activeId; mutationStarted=true; const savedMeta=await saveStateWorldlineMeta(context.scope,meta);
          const boundaryFingerprint=stateReplayBoundaryFingerprint({scope:context.scope,manifest,meta:savedMeta,worldlineId:activeId});
          const replay=await rebuildCurrentStateForWorldlineUnlocked({context,manifest,pairs,worldlineId:activeId,cutoffTurn:effectiveCutoff,reason:operation==='rollback'?'worldline_rollback':'worldline_switch',persist:true,requiredBoundaryFingerprint:boundaryFingerprint});
          if (!replay?.ok) { const error=stateCorrectionFailure(replay?.code||'STATE_WORLDLINE_REPLAY_FAILED',replay?.error||'state_worldline_replay_failed'); error.rollbackIncomplete=replay?.rollbackIncomplete===true; throw error; }
          const finalMeta=await loadStateWorldlineMeta(context.scope,{strict:true});
          if (stateStoredValueDigest(finalMeta)!==stateStoredValueDigest(savedMeta) || string(finalMeta.activeWorldlineId||'')!==activeId) throw stateCorrectionFailure('STATE_WORLDLINE_META_POSTCONDITION_FAILED');
          return {...clone(replay),meta:clone(finalMeta)};
        } catch(error) {
          if (!mutationStarted) throw error;
          let rollbackError=null;
          try { await restoreStateReplayBaseline({scope:context.scope,head:baseline.head,journal:baseline.journal,cache:baseline.cache,meta:baseline.meta,includeMeta:true,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH','STATE_CORRECTION_ROLLBACK_INCOMPLETE'].includes(string(error?.code||'')),lastContinuityState:baseline.lastContinuityState,snapshotContinuityState:baseline.snapshotContinuityState}); }
          catch(failure) { rollbackError=failure; }
          const surfaced=rollbackError||error; await recordStateReplayError(context.scope,surfaced,{operation:'worldline_'+operation,worldlineId:activeId,rollbackIncomplete:!!rollbackError}).catch(()=>{});
          if (rollbackError || error?.rollbackIncomplete===true) throw stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE',compact(surfaced?.message||surfaced,700));
          throw stateCorrectionFailure('STATE_WORLDLINE_TRANSACTION_FAILED',compact(error?.message||error,700));
        }
      });
    };
    const setStateWorldline = async (options={}) => await mutateStateWorldline({...options,operation:'set'});
    const rollbackStateWorldline = async (options={}) => await mutateStateWorldline({...options,operation:'rollback'});

`);

  return { source, labels };
};
