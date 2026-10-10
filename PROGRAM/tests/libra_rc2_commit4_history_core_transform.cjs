'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };

  rep('world_manager_history_and_correction_paged_core',
`    const migrateLegacyContinuityOverrides = async (scope, manifest) => {`,
`    const WORLD_MANAGER_HISTORY_DEFAULT_LIMIT = 20;
    const WORLD_MANAGER_HISTORY_MAX_LIMIT = 50;
    const WORLD_MANAGER_HISTORY_DOMAINS = Object.freeze(['all','characters','relationships','world','narrative']);
    const normalizeWorldManagerHistoryDomain = value => {
      const raw=string(value||'all').trim().toLowerCase().replace(/[\\s-]+/g,'_');
      const aliases={character:'characters',character_relationship:'characters',relationship:'relationships',relations:'relationships',story:'narrative'};
      const normalized=aliases[raw]||raw;
      if (!WORLD_MANAGER_HISTORY_DOMAINS.includes(normalized)) throw stateCorrectionFailure('WORLD_MANAGER_HISTORY_DOMAIN_INVALID');
      return normalized;
    };
    const worldManagerPageLimit = value => Math.max(1,Math.min(WORLD_MANAGER_HISTORY_MAX_LIMIT,Math.floor(Number(value)||WORLD_MANAGER_HISTORY_DEFAULT_LIMIT)));
    const worldManagerCursorSignature = (identity,offset) => digest(stableReferenceJson({identity,offset:Number(offset||0)}));
    const worldManagerEncodeCursor = (kind,offset,identity) => String(kind)+':'+String(offset)+':'+worldManagerCursorSignature(identity,offset);
    const worldManagerDecodeCursor = (kind,cursor,identity,total,code) => {
      if (!cursor) return 0;
      const match=new RegExp('^'+String(kind)+':(\\\\d+):(.+)$').exec(string(cursor));
      const offset=match?Number(match[1]):-1;
      if (!match || !Number.isSafeInteger(offset) || offset<0 || offset>Number(total||0) || match[2]!==worldManagerCursorSignature(identity,offset)) throw stateCorrectionFailure(code);
      return offset;
    };
    const worldManagerHistoryRefs = (scope,manifest) => Object.values(asObject(manifest?.memories)).filter(ref=>ref?.status==='committed'&&ref?.key).map(ref=>{
      const derivedDeltaKey=key.continuityDelta(scope,ref.memoryId,ref.revision); const explicitDeltaKey=string(ref.continuityDeltaKey||ref.deltaKey||'');
      if (explicitDeltaKey&&explicitDeltaKey!==derivedDeltaKey) throw stateCorrectionFailure('WORLD_MANAGER_HISTORY_DELTA_KEY_INVALID');
      return {
        key:string(ref.key||''),memoryId:string(ref.memoryId||''),revision:Number(ref.revision||0),sourceDigest:string(ref.sourceDigest||''),
        turnRange:clone(asObject(ref.turnRange)),sessionEpoch:Number(ref.sessionEpoch||0),status:string(ref.status||'committed'),
        summary:compact(ref.summary||'',500),updatedAt:string(ref.updatedAt||ref.createdAt||''),deltaKey:explicitDeltaKey||derivedDeltaKey
      };
    }).sort((a,b)=>b.sessionEpoch-a.sessionEpoch||Number(b.turnRange?.end||0)-Number(a.turnRange?.end||0)||b.revision-a.revision);
    const loadWorldManagerHistoryDelta = async (scope,ref,{required=false}={}) => {
      if (!ref?.deltaKey) {
        if (required) throw stateCorrectionFailure('WORLD_MANAGER_HISTORY_DELTA_MISSING');
        return null;
      }
      const delta=await storage.getJson(ref.deltaKey,null);
      if (delta==null) {
        if (required) throw stateCorrectionFailure('WORLD_MANAGER_HISTORY_DELTA_MISSING');
        return null;
      }
      if (delta.schema!==CONTINUITY_DELTA_SCHEMA
        || string(delta.memoryId||'')!==string(ref.memoryId||'')
        || Number(delta.revision||0)!==Number(ref.revision||0)
        || string(delta.sourceDigest||'')!==string(ref.sourceDigest||'')
        || stableReferenceJson(asObject(delta.turnRange))!==stableReferenceJson(asObject(ref.turnRange))) throw stateCorrectionFailure('WORLD_MANAGER_HISTORY_DELTA_IDENTITY_MISMATCH');
      return delta;
    };
    const worldManagerHistoryDomainProjection = deltaValue => {
      const delta=asObject(deltaValue); const domains=asObject(delta.domains);
      const characterBlock=asObject(delta.characterPatch); const characterPatch=asObject(characterBlock.patch);
      const worldBlock=asObject(delta.worldPatch); const worldPatch=asObject(worldBlock.patch); const narrativePatch=asObject(delta.narrativePatch);
      const statusFor=(domainRow,block,present)=>string(domainRow?.status||'')||(present?(block?.ok===false?'failed':'ready'):'empty');
      const characterPresent=Object.prototype.hasOwnProperty.call(delta,'characterPatch')||!!domains.character_relationship;
      const worldPresent=Object.prototype.hasOwnProperty.call(delta,'worldPatch')||!!domains.world;
      const narrativePresent=Object.prototype.hasOwnProperty.call(delta,'narrativePatch')||!!domains.narrative;
      return {
        characters:{present:characterPresent,status:statusFor(domains.character_relationship,characterBlock,characterPresent),count:asArray(characterPatch.characters).length},
        relationships:{present:characterPresent,status:statusFor(domains.character_relationship,characterBlock,characterPresent),count:asArray(characterPatch.relationships).length},
        world:{present:worldPresent,status:statusFor(domains.world,worldBlock,worldPresent),count:asArray(worldPatch.world).length},
        narrative:{present:narrativePresent,status:statusFor(domains.narrative,narrativePatch,narrativePresent),count:asArray(narrativePatch.arcs).length+asArray(narrativePatch.threads).length+asArray(narrativePatch.turningPoints).length+asArray(narrativePatch.locks).length+asArray(narrativePatch.motifs).length,source:string(domains.narrative?.source||narrativePatch.source||'')}
      };
    };
    const worldManagerNarrativeSummary = deltaValue => {
      const summary=asObject(asObject(deltaValue).narrativePatch).summary;
      if (typeof summary==='string') return compact(summary,500);
      return compact(summary?.value||summary?.text||'',500);
    };
    const worldManagerHistoryItem = (ref,delta) => ({
      memoryId:ref.memoryId,revision:ref.revision,turnRange:clone(ref.turnRange),status:ref.status,
      deltaStatus:delta?'ready':'missing',domains:worldManagerHistoryDomainProjection(delta),
      narrativeSummary:worldManagerNarrativeSummary(delta)||ref.summary,updatedAt:string(delta?.createdAt||ref.updatedAt||''),sourceDigest:ref.sourceDigest
    });
    const listWorldManagerHistory = async ({domain='all',limit=20,cursor=''}={}) => {
      const normalizedDomain=normalizeWorldManagerHistoryDomain(domain); const pageLimit=worldManagerPageLimit(limit);
      const context=await resolveContext(); const pairs=buildPairs(context.chat,context?.scope?.scopeKey||''); const manifest=await loadManifest(context.scope,pairs.length);
      const refs=worldManagerHistoryRefs(context.scope,manifest);
      const identity={scopeKey:string(context.scope.scopeKey),domain:normalizedDomain,refs:refs.map(ref=>({memoryId:ref.memoryId,revision:ref.revision,sourceDigest:ref.sourceDigest,deltaKey:ref.deltaKey,status:ref.status,turnRange:ref.turnRange,sessionEpoch:ref.sessionEpoch}))};
      const offset=worldManagerDecodeCursor('wmh1',cursor,identity,refs.length,'WORLD_MANAGER_HISTORY_CURSOR_INVALID');
      const pageRefs=refs.slice(offset,offset+pageLimit);
      const rows=await Promise.all(pageRefs.map(async ref=>{
        const delta=await loadWorldManagerHistoryDelta(context.scope,ref);
        const item=worldManagerHistoryItem(ref,delta);
        return item;
      }));
      const nextOffset=offset+pageRefs.length; const hasMore=nextOffset<refs.length;
      return clone({items:rows,nextCursor:hasMore?worldManagerEncodeCursor('wmh1',nextOffset,identity):'',hasMore,scanned:pageRefs.length,limit:pageLimit,domain:normalizedDomain});
    };
    const getWorldManagerHistoryDetail = async ({memoryId='',revision=0,sourceDigest=''}={}) => {
      const wantedId=string(memoryId||''); const wantedRevision=Number(revision||0);
      if (!wantedId || !wantedRevision) throw stateCorrectionFailure('WORLD_MANAGER_HISTORY_IDENTITY_MISSING');
      const context=await resolveContext(); const pairs=buildPairs(context.chat,context?.scope?.scopeKey||''); const manifest=await loadManifest(context.scope,pairs.length);
      const matches=worldManagerHistoryRefs(context.scope,manifest).filter(ref=>ref.memoryId===wantedId&&ref.revision===wantedRevision&&(!sourceDigest||ref.sourceDigest===string(sourceDigest)));
      if (matches.length!==1) throw stateCorrectionFailure(matches.length?'WORLD_MANAGER_HISTORY_IDENTITY_AMBIGUOUS':'WORLD_MANAGER_HISTORY_NOT_FOUND');
      const ref=matches[0]; const delta=await loadWorldManagerHistoryDelta(context.scope,ref,{required:true});
      return clone({memoryId:ref.memoryId,revision:ref.revision,turnRange:clone(ref.turnRange),item:worldManagerHistoryItem(ref,delta),delta,canonicalMemory:{key:ref.key,memoryId:ref.memoryId,revision:ref.revision,sourceDigest:ref.sourceDigest,turnRange:clone(ref.turnRange)}});
    };
    const normalizeWorldManagerCorrectionDomain = value => {
      const raw=string(value||'all').trim().toLowerCase().replace(/[\\s-]+/g,'_');
      const aliases={character:'characters',character_relationship:'characters',relationship:'relationships',relations:'relationships',story:'narrative'};
      const normalized=aliases[raw]||raw;
      if (![...WORLD_MANAGER_HISTORY_DOMAINS,'head'].includes(normalized)) throw stateCorrectionFailure('WORLD_MANAGER_CORRECTION_DOMAIN_INVALID');
      return normalized;
    };
    const normalizeWorldManagerCorrectionFilter = value => {
      const normalized=string(value||'all').trim().toLowerCase();
      if (normalized!=='all'&&!STATE_CORRECTION_STATUSES.includes(normalized)) throw stateCorrectionFailure('WORLD_MANAGER_CORRECTION_STATUS_INVALID');
      return normalized;
    };
    const listWorldManagerCorrections = async ({domain='all',status='all',limit=20,cursor=''}={}) => {
      const normalizedDomain=normalizeWorldManagerCorrectionDomain(domain); const normalizedStatus=normalizeWorldManagerCorrectionFilter(status); const pageLimit=worldManagerPageLimit(limit);
      const context=await resolveContext(); const store=await loadStateCorrectionJournal(context.scope,{strict:true});
      const filtered=asArray(store.records).filter(row=>(normalizedDomain==='all'||string(row?.target?.domain||'head')===normalizedDomain)&&(normalizedStatus==='all'||string(row?.status||'')===normalizedStatus))
        .slice().sort((a,b)=>String(b?.createdAt||'').localeCompare(String(a?.createdAt||''))||Number(b?.anchor?.throughTurn||0)-Number(a?.anchor?.throughTurn||0));
      const identity={scopeKey:string(context.scope.scopeKey),domain:normalizedDomain,status:normalizedStatus,revision:Number(store.revision||0),journalDigest:digest(stableReferenceJson({records:asArray(store.records),migratedLegacyOverrideIds:asArray(store.migratedLegacyOverrideIds)}))};
      const offset=worldManagerDecodeCursor('wmc1',cursor,identity,filtered.length,'WORLD_MANAGER_CORRECTION_CURSOR_INVALID');
      const items=filtered.slice(offset,offset+pageLimit); const nextOffset=offset+items.length; const hasMore=nextOffset<filtered.length;
      return clone({items,nextCursor:hasMore?worldManagerEncodeCursor('wmc1',nextOffset,identity):'',hasMore,total:filtered.length,limit:pageLimit,domain:normalizedDomain,status:normalizedStatus});
    };
    const getWorldManagerRuntimeMeta = async () => {
      const context=await resolveContext();
      const [meta,journal,replayCache,replayErrors]=await Promise.all([
        loadStateWorldlineMeta(context.scope,{strict:true}),loadStateCorrectionJournal(context.scope,{strict:true}),
        storage.getJson(key.stateReplayCache(context.scope),null),storage.getJson(key.stateReplayErrors(context.scope),null)
      ]);
      if (replayCache!=null&&(replayCache.schema!==STATE_REPLAY_CACHE_SCHEMA||string(replayCache.scopeKey||'')!==string(context.scope.scopeKey))) throw stateCorrectionFailure('WORLD_MANAGER_REPLAY_CACHE_INVALID');
      if (replayErrors!=null&&(replayErrors.schema!==STATE_REPLAY_ERROR_SCHEMA||string(replayErrors.scopeKey||'')!==string(context.scope.scopeKey))) throw stateCorrectionFailure('WORLD_MANAGER_REPLAY_ERROR_STORE_INVALID');
      const correctionCounts=Object.fromEntries(STATE_CORRECTION_STATUSES.map(statusValue=>[statusValue,asArray(journal.records).filter(row=>row?.status===statusValue).length]));
      correctionCounts.total=asArray(journal.records).length;
      const activeId=string(meta.activeWorldlineId||'main'); const errors=asArray(replayErrors?.records);
      return clone({
        scopeKey:string(context.scope.scopeKey),
        worldline:{activeWorldlineId:activeId,revision:Number(meta.revision||0),current:clone(meta.worldlines?.[activeId]||null)},
        replayCache:replayCache?{worldlineId:string(replayCache.worldlineId||''),fingerprint:string(replayCache.fingerprint||''),throughTurn:Number(replayCache.throughTurn||0),appliedDeltas:Number(replayCache.appliedDeltas||0),appliedCorrectionsCount:asArray(replayCache.appliedCorrections).length,reason:string(replayCache.reason||''),updatedAt:string(replayCache.updatedAt||'')}:null,
        correctionCounts,lastReplayError:errors.length?{at:string(errors[errors.length-1]?.at||''),code:string(errors[errors.length-1]?.code||''),message:compact(errors[errors.length-1]?.message||'',700)}:null
      });
    };

    const migrateLegacyContinuityOverrides = async (scope, manifest) => {`);

  rep('export_world_manager_history_core',
`      loadStateCorrectionJournal, appendStateCorrection, setStateCorrectionStatus, rebuildCurrentStateForWorldline, loadStateWorldlineMeta, setStateWorldline, rollbackStateWorldline,`,
`      loadStateCorrectionJournal, appendStateCorrection, setStateCorrectionStatus, rebuildCurrentStateForWorldline, loadStateWorldlineMeta, setStateWorldline, rollbackStateWorldline,
      listWorldManagerHistory, getWorldManagerHistoryDetail, listWorldManagerCorrections, getWorldManagerRuntimeMeta,`);

  rep('public_world_manager_history_api',
`    async getWorldManagerCorrections() { const context=await LibraMemoryCore.resolveContext(); return safeClone(await LibraMemoryCore.loadStateCorrectionJournal(context.scope)); },`,
`    async getWorldManagerCorrections() { const context=await LibraMemoryCore.resolveContext(); return safeClone(await LibraMemoryCore.loadStateCorrectionJournal(context.scope)); },
    async listWorldManagerHistory(options = {}) { return safeClone(await LibraMemoryCore.listWorldManagerHistory(options)); },
    async getWorldManagerHistoryDetail(options = {}) { return safeClone(await LibraMemoryCore.getWorldManagerHistoryDetail(options)); },
    async listWorldManagerCorrections(options = {}) { return safeClone(await LibraMemoryCore.listWorldManagerCorrections(options)); },
    async getWorldManagerRuntimeMeta() { return safeClone(await LibraMemoryCore.getWorldManagerRuntimeMeta()); },`);

  return { source, labels };
};
