'use strict';

// D4 candidate scale: one real v5 seed is expanded into a coherent stored
// canonical chain. The real candidate consumer scans 100/1000/10000 refs;
// no provider call is repeated for the synthetic rows.
const assert = require('node:assert/strict');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const parse = value => { try { return JSON.parse(value); } catch (_) { return null; } };
const manifestRefIdentity = (api, manifest) => api.debugPhaseDHash({ memories: manifest?.memories || {}, inheritedMemories: manifest?.inheritedMemories || {} });
const changedManifestRefs = (api, before, after) => {
  const rows = [];
  for (const field of ['memories', 'inheritedMemories']) {
    const left = before?.[field] || {}, right = after?.[field] || {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (api.debugPhaseDHash(left[key]) !== api.debugPhaseDHash(right[key])) rows.push({ field, key,
        before: left[key] ? { memoryId: left[key].memoryId || null, revision: left[key].revision ?? null,
          sourceDigest: left[key].sourceDigest || null, artifactDigest: left[key].artifactDigest || null,
          statePipelineStatus: left[key].statePipeline?.receipt?.status || null } : null,
        after: right[key] ? { memoryId: right[key].memoryId || null, revision: right[key].revision ?? null,
          sourceDigest: right[key].sourceDigest || null, artifactDigest: right[key].artifactDigest || null,
          statePipelineStatus: right[key].statePipeline?.receipt?.status || null } : null });
    }
  }
  return rows;
};
const COUNTS = process.env.PHASE_D_CANDIDATE_COUNTS
  ? process.env.PHASE_D_CANDIDATE_COUNTS.split(',').map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0)
  : [100, 1000, 10000];
assert.ok(COUNTS.length > 0, 'candidate scale counts are positive');
const GUARD_PROBE = process.env.PHASE_D_CANDIDATE_GUARD_PROBE === '1';
const SETUP_PROGRESS_COUNTS = new Set([2000, 5000, 8000]);
const DIAGNOSTIC_ONLY = process.env.PHASE_D_CANDIDATE_DIAGNOSTIC_ONLY === '1';
const PAIR_BUILD_DIAGNOSTIC_ONLY = process.env.PHASE_D_PAIR_BUILD_DIAGNOSTIC_ONLY === '1';
const BATCH_SIZE = 5;
const OPEN_SOURCE = '서재에서 준호가 열쇠를 지호에게 건넸고, 지호가 그것을 민아에게 돌려주었다. 오늘 열쇠를 반환하겠다는 약속은 아직 이행되지 않았다.';

// This is the product's existing branchContentHash identity rule (the
// source unit identity is part of the binding, so a placeholder would make
// this fixture prove the wrong contract).
const branchContentHash = value => {
  const body = String(value || '');
  let hashA = 2166136261, hashB = 0x9e3779b9;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    hashA ^= code;
    hashA = Math.imul(hashA, 16777619);
    hashB ^= (code + index) >>> 0;
    hashB = Math.imul(hashB, 2246822519);
    hashB ^= hashB >>> 13;
  }
  return `${(hashA >>> 0).toString(16).padStart(8, '0')}${(hashB >>> 0).toString(16).padStart(8, '0')}:${body.length}`;
};

// Test-only exports keep the product API unchanged while exercising the real
// closure-owned candidate builder and source-evidence verifier.
const candidateProbeTransform = source => {
  const coreAnchor = "      debugResolveRecallContinuityClosure: args => resolveRecallContinuityClosure(args),";
  assert.equal(source.includes(coreAnchor), true, 'candidate core export anchor exists');
  const candidateBuilderAnchor = '    const buildContinuityCandidateContext = async (basis,batch,signal=null) => {';
  assert.equal(source.includes(candidateBuilderAnchor), true, 'candidate sequence probe anchor exists');
  source = source.replace(candidateBuilderAnchor, `    let __phaseDPreparationSequence=0;
${candidateBuilderAnchor}`);
  const buildPairsAnchor = '    const buildPairs = (chat, cacheKeyInput = \'\') => {';
  assert.equal(source.includes(buildPairsAnchor), true, 'pair-build stage probe anchor exists');
  source = source.replace(buildPairsAnchor, `${buildPairsAnchor}
      const __phaseDPairBuildSignal=globalThis.__phaseDPairBuildSignal;
      __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_snapshot:start');`);
  const projectionsAnchor = `      const projections = rawMessages.map((raw, index) => {
        const projection = pairRevisionProjectionWithCache(raw, index, cache, sourceTagKey, observation);
        seenKeys.push(projection.key);
        return projection;
      });`;
  assert.equal(source.includes(projectionsAnchor), true, 'pair projection stage probe anchor exists');
  source = source.replace(projectionsAnchor, `      __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_snapshot:end');
      __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_projection:start');
${projectionsAnchor}
      __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_projection:end');`);
  const observationAnchor = "      finalizePairRevisionObservation(cache, seenKeys);\n      retainPairRevisionObservation(cache, projections);\n      const sequence = projections.map((projection, index) => `${index}\\u0001${projection.key}\\u0001${projection.signature}\\u0001${projection.rawPayloadDigest}\\u0001${projection.sanitizedTextDigest}`);\n      // A digest is not an exact raw witness. Misses (including uncached\n      // over-budget rows) rebuild pairs even if their hash strings collide.\n      if (observation.allUnchanged && cache.pairs && pairRevisionSequenceEqual(cache.sequence, sequence)) {\n        state.pairRevisionCacheStats.lastObservationHash = cache.observationHash;\n        state.pairRevisionCacheStats.pairReuses += 1;\n        return cache.pairs;\n      }\n      const observationHash = branchContentHash(sequence.join('\\u001e'));";
  assert.equal(source.includes(observationAnchor), true, 'current bounded pair observation stage probe anchor exists');
  const observedCurrent=observationAnchor.replace('        return cache.pairs;', "        __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_observation:end');\n        return cache.pairs;");
  source = source.replace(observationAnchor, `      __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_observation:start');
${observedCurrent}
      __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_observation:end');`);
  const pairLoopAnchor = '      for (const projection of projections) {';
  assert.equal(source.includes(pairLoopAnchor), true, 'pair assembly stage probe anchor exists');
  source = source.replace(pairLoopAnchor, `      __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_assembly:start');
${pairLoopAnchor}`);
  const pairLoopEndAnchor = `        pairs.push(pair);
        pendingUser = null;
      }
      cache.sequence = sequence;`;
  assert.equal(source.includes(pairLoopEndAnchor), true, 'pair assembly completion probe anchor exists');
  source = source.replace(pairLoopEndAnchor, `        pairs.push(pair);
        pendingUser = null;
      }
      __phaseDPairBuildSignal?.__phaseDStageEvent?.('candidate_build_pairs_assembly:end');
      cache.sequence = sequence;`);
  const diagnosticsAnchor = "      const diagnostics={schema:'libra.analysis_candidate_preparation.v1',refsAvailable:0";
  assert.equal(source.includes(diagnosticsAnchor), true, 'candidate sequence diagnostic anchor exists');
  source = source.replace(diagnosticsAnchor,
    "      const diagnostics={testPreparationSequence:++__phaseDPreparationSequence,schema:'libra.analysis_candidate_preparation.v1',refsAvailable:0");
  const basisReadAnchor = '        const manifestSnapshot=await storage.getJson(key.manifest(context.scope),null);';
  assert.equal(source.includes(basisReadAnchor), true, 'basis manifest read probe anchor exists');
  source = source.replace(basisReadAnchor, `        options.onCandidateStage?.('basis_manifest_getJson:start');
        const manifestSnapshot=await storage.getJson(key.manifest(context.scope),null);
        options.onCandidateStage?.('basis_manifest_getJson:end');`);
  const basisIdentityAnchor = `        const canonicalSelection=basis.manifestIdentityMode==='canonical_selection_v1';
        const identity=options.cooperativeManifestIdentity
          ? await (canonicalSelection?unifiedCanonicalSelectionManifestIdentityCooperative(manifestSnapshot,options):unifiedManifestIdentityCooperative(manifestSnapshot,options))
          : (canonicalSelection?unifiedCanonicalSelectionManifestIdentity(manifestSnapshot):unifiedManifestIdentity(manifestSnapshot));`;
  assert.equal(source.includes(basisIdentityAnchor), true, 'basis identity probe anchor exists');
  source = source.replace(basisIdentityAnchor, `        options.onCandidateStage?.('basis_manifest_identity:start');
        const canonicalSelection=basis.manifestIdentityMode==='canonical_selection_v1';
        const identity=options.cooperativeManifestIdentity
          ? await (canonicalSelection?unifiedCanonicalSelectionManifestIdentityCooperative(manifestSnapshot,options):unifiedManifestIdentityCooperative(manifestSnapshot,options))
          : (canonicalSelection?unifiedCanonicalSelectionManifestIdentity(manifestSnapshot):unifiedManifestIdentity(manifestSnapshot));
        options.onCandidateStage?.('basis_manifest_identity:end');`);
  const abortAnchor = "      const abortCandidatePreparation=()=>{\n        if(signal?.aborted";
  assert.equal(source.includes(abortAnchor), true, 'candidate cancellation probe anchor exists');
  source = source.replace(abortAnchor, `      let __phaseDScanStartedAt=0;\n      const abortCandidatePreparation=()=>{\n        if(signal?.aborted`);
  const contextAnchor = `      const context=await resolveContext();
      await yieldCandidatePreparation();abortCandidatePreparation();
      await assertUnifiedBasis(context,basis,'thread_candidate_context',true,{
        cooperativeManifestIdentity:true,
        yieldIfNeeded:yieldCandidatePreparation,
        checkAbort:abortCandidatePreparation
      });
      await yieldCandidatePreparation();abortCandidatePreparation();
      const pairPreparation=await countCandidatePairsCooperative(context.chat,{
        yieldIfNeeded:yieldCandidatePreparation,
        checkAbort:abortCandidatePreparation
      });
      const completedPairCount=pairPreparation.completedPairCount;
      const currentManifest=await storage.getJson(key.manifest(context.scope),null);
      const manifestIdentityOptions={
        yieldIfNeeded:yieldCandidatePreparation,
        checkAbort:abortCandidatePreparation
      };
      const currentManifestIdentity=basis.manifestIdentityMode==='canonical_selection_v1'
        ? await unifiedCanonicalSelectionManifestIdentityCooperative(currentManifest,manifestIdentityOptions)
        : await unifiedManifestIdentityCooperative(currentManifest,manifestIdentityOptions);
      unifiedAssert(currentManifestIdentity===basis.manifestDigest,'UNIFIED_THREAD_CANDIDATE_CHAIN_CHANGED');
      await yieldCandidatePreparation();abortCandidatePreparation();
      const manifest=normalizeManifestReadSnapshot(currentManifest,context.scope,completedPairCount,true);
      await yieldCandidatePreparation();abortCandidatePreparation();`;
  assert.equal(source.includes(contextAnchor), true, 'candidate pre-scan stage probe anchor exists');
  source = source.replace(contextAnchor, `      let __phaseDStageStartedAt=Date.now();
      const context=await resolveContext();
      diagnostics.testContextResolveElapsedMs=Date.now()-__phaseDStageStartedAt;
      await yieldCandidatePreparation();abortCandidatePreparation();
      __phaseDStageStartedAt=Date.now();signal?.__phaseDStageEvent?.('basis_assertion:start');signal?.__phaseDOnManifestProcessing?.();
      await assertUnifiedBasis(context,basis,'thread_candidate_context',true,{
        cooperativeManifestIdentity:true,yieldIfNeeded:yieldCandidatePreparation,checkAbort:abortCandidatePreparation,
        onCandidateStage:stage=>signal?.__phaseDStageEvent?.(stage)
      });
      signal?.__phaseDStageEvent?.('basis_assertion:end');
      diagnostics.testBasisCheckElapsedMs=Date.now()-__phaseDStageStartedAt;
      await yieldCandidatePreparation();abortCandidatePreparation();
      __phaseDStageStartedAt=Date.now();signal?.__phaseDStageEvent?.('candidate_build_pairs:start');
      const pairPreparation=await countCandidatePairsCooperative(context.chat,{
        yieldIfNeeded:yieldCandidatePreparation,checkAbort:abortCandidatePreparation,
        onStage:stage=>{signal?.__phaseDStageEvent?.(stage);if(stage==='candidate_build_pairs_projection:start')signal?.__phaseDOnPairBuild?.();},
        onProjection:count=>{if(signal)signal.__phaseDProjectionCount=count;signal?.__phaseDOnPairProjection?.(count);},
        afterYield:()=>signal?.__phaseDPairBuildYield?.()
      });
      diagnostics.testPairBuildElapsedMs=Date.now()-__phaseDStageStartedAt;
      signal?.__phaseDStageEvent?.('candidate_build_pairs:end');
      if(signal?.__phaseDAfterManifestSnapshot)await signal.__phaseDAfterManifestSnapshot();
      __phaseDStageStartedAt=Date.now();
      signal?.__phaseDStageEvent?.('latest_manifest_getJson:start');
      const currentManifest=await storage.getJson(key.manifest(context.scope),null);
      signal?.__phaseDStageEvent?.('latest_manifest_getJson:end');
      signal?.__phaseDStageEvent?.('latest_manifest_identity:start');
      const currentManifestIdentityOptions={yieldIfNeeded:yieldCandidatePreparation,checkAbort:abortCandidatePreparation};
      const currentIdentity=basis.manifestIdentityMode==='canonical_selection_v1'
        ? await unifiedCanonicalSelectionManifestIdentityCooperative(currentManifest,currentManifestIdentityOptions)
        : await unifiedManifestIdentityCooperative(currentManifest,currentManifestIdentityOptions);
      signal?.__phaseDStageEvent?.('latest_manifest_identity:end');
      diagnostics.testManifestIdentityRecheckElapsedMs=Date.now()-__phaseDStageStartedAt;
      unifiedAssert(currentIdentity===basis.manifestDigest,'UNIFIED_THREAD_CANDIDATE_CHAIN_CHANGED');
      await yieldCandidatePreparation();abortCandidatePreparation();
      signal?.__phaseDStageEvent?.('candidate_manifest_normalization:start');signal?.__phaseDOnManifestNormalization?.();__phaseDStageStartedAt=Date.now();
      const manifest=normalizeManifestReadSnapshot(currentManifest,context.scope,pairPreparation.completedPairCount,true);
      diagnostics.testManifestNormalizationElapsedMs=Date.now()-__phaseDStageStartedAt;
      signal?.__phaseDStageEvent?.('candidate_manifest_normalization:end');
      await yieldCandidatePreparation();abortCandidatePreparation();
      `);
  const freshnessAnchor='      pairPreparation.assertCurrentSource();';
  assert.equal(source.includes(freshnessAnchor),true,'actual product source-freshness checkpoint anchor exists');
  source=source.replace(freshnessAnchor, `      __phaseDStageStartedAt=Date.now();signal?.__phaseDStageEvent?.('candidate_build_pairs_freshness:start');
      signal?.__phaseDOnSourceFreshness?.();
      pairPreparation.assertCurrentSource();
      diagnostics.testPairSourceFreshnessElapsedMs=Date.now()-__phaseDStageStartedAt;
      signal?.__phaseDStageEvent?.('candidate_build_pairs_freshness:end');`);
  assert.equal((source.match(/pairPreparation\.assertCurrentSource\(\);/g)||[]).length,1,'test instrumentation preserves exactly one product freshness pass');
  const scanAnchor = '      const lifecycles=new Map(),lineage=[];';
  assert.equal(source.includes(scanAnchor), true, 'candidate scan stage probe anchor exists');
  source = source.replace(scanAnchor, `      signal?.__phaseDStageEvent?.('candidate_ref_scan:start');
${scanAnchor}`);
  const refsAnchor = '      diagnostics.refsAvailable=refs.length;';
  assert.equal(source.includes(refsAnchor), true, 'candidate refs availability probe anchor exists');
  const refsSelectionAnchor = `      const refs=fullContinuityRefs(manifest).filter(ref=>unifiedInheritedRef(ref)
        ||Number(ref?.sessionEpoch||0)<currentEpoch
        ||(Number(ref?.sessionEpoch||0)===currentEpoch&&Number(ref?.turnRange?.end||0)<batchStart));`;
  assert.equal(source.includes(refsSelectionAnchor), true, 'candidate ref selection probe anchor exists');
  source = source.replace(refsSelectionAnchor, `      __phaseDStageStartedAt=Date.now();
${refsSelectionAnchor}
      diagnostics.testRefSelectionElapsedMs=Date.now()-__phaseDStageStartedAt;
      ${refsAnchor}
      diagnostics.testPreScanElapsedMs=Date.now()-diagnostics.startedAt;__phaseDScanStartedAt=Date.now();`);
  const cancelRecordAnchor = '          diagnostics.cancelObserved=true;';
  assert.equal(source.includes(cancelRecordAnchor), true, 'candidate cancellation timing anchor exists');
  source = source.replace(cancelRecordAnchor, `${cancelRecordAnchor}\n          diagnostics.testPreScanElapsedMs=__phaseDScanStartedAt?__phaseDScanStartedAt-diagnostics.startedAt:Date.now()-diagnostics.startedAt;\n          diagnostics.testScanElapsedMs=__phaseDScanStartedAt?Date.now()-__phaseDScanStartedAt:0;`);
  const loadMemoryAnchor = `        const memory=await loadMemoryRef(ref);\n        unifiedAssert(memory,'UNIFIED_THREAD_CANDIDATE_MEMORY_MISSING');`;
  assert.equal(source.includes(loadMemoryAnchor), true, 'candidate memory-read timing anchor exists');
  source = source.replace(loadMemoryAnchor, `        const __phaseDMemoryReadStartedAt=Date.now();
        const memory=await loadMemoryRef(ref);
        diagnostics.testMemoryReadElapsedMs=(diagnostics.testMemoryReadElapsedMs||0)+(Date.now()-__phaseDMemoryReadStartedAt);
        diagnostics.testMemoryReadMaxMs=Math.max(diagnostics.testMemoryReadMaxMs||0,Date.now()-__phaseDMemoryReadStartedAt);
        unifiedAssert(memory,'UNIFIED_THREAD_CANDIDATE_MEMORY_MISSING');`);
  const evidenceReadAnchor = `        const approved=await unifiedEvidenceRead(memory);\n        unifiedAssert(ref.memoryId===memory.memoryId`;
  assert.equal(source.includes(evidenceReadAnchor), true, 'candidate source-evidence timing anchor exists');
  source = source.replace(evidenceReadAnchor, `        const __phaseDEvidenceReadStartedAt=Date.now();
        const approved=await unifiedEvidenceRead(memory);
        diagnostics.testEvidenceReadElapsedMs=(diagnostics.testEvidenceReadElapsedMs||0)+(Date.now()-__phaseDEvidenceReadStartedAt);
        diagnostics.testEvidenceReadMaxMs=Math.max(diagnostics.testEvidenceReadMaxMs||0,Date.now()-__phaseDEvidenceReadStartedAt);
        unifiedAssert(ref.memoryId===memory.memoryId`);
  const scanEndAnchor = '      const rows=[...lifecycles.values()]';
  assert.equal(source.includes(scanEndAnchor), true, 'candidate scan completion timing anchor exists');
  source = source.replace(scanEndAnchor, '      diagnostics.testScanElapsedMs=Date.now()-__phaseDScanStartedAt;\n'+scanEndAnchor);
  source = source.replace(coreAnchor, `${coreAnchor}
      debugPhaseDHash: value => digest(value),
      debugPhaseDBuildPairsOnly: async signalValue => {
        const context=await resolveContext();
        signalValue?.__phaseDStageEvent?.('candidate_build_pairs:start');signalValue?.__phaseDOnPairBuild?.();
        globalThis.__phaseDPairBuildSignal=signalValue;
        let pairCount;
        try { pairCount=buildPairs(context.chat,context.scope.scopeKey).length; }
        finally { globalThis.__phaseDPairBuildSignal=null; }
        signalValue?.__phaseDStageEvent?.('candidate_build_pairs:end');
        await new Promise(resolve=>setTimeout(resolve,0));
        return {pairCount,cancelled:signalValue?.aborted===true};
      },
      debugPhaseDCountCandidatePairsForMessages: async messageRows => {
        const chat={message:messageRows};
        const expected=buildPairs(chat,'phase-d-candidate-pair-count-parity').length;
        const result=await countCandidatePairsCooperative(chat,{
            yieldIfNeeded:()=>new Promise(resolve=>setTimeout(resolve,0)),
            checkAbort:()=>{},
        });
        result.assertCurrentSource();
        return {expectedPairCount:expected,actualPairCount:result.completedPairCount};
      },
      debugPhaseDCountCandidatePairsWithMutation: async messageRows => {
        const chat={message:messageRows};
        const cacheKey='phase-d-candidate-pair-count-no-cache';
        const cacheExistedBefore=state.pairRevisionCaches.has(cacheKey);
        let changed=false,result=null,error=null;
        result=await countCandidatePairsCooperative(chat,{
          yieldIfNeeded:()=>new Promise(resolve=>setTimeout(resolve,0)),
          checkAbort:()=>{},
          afterYield:()=>{
            if(changed)return;
            changed=true;
            messageRows[0].data=messageRows[0].data==='old text'?'new text':'old text';
          }
        });
        try { result.assertCurrentSource(); } catch (caught) { error=caught.message; }
        return {error,changed,cacheExistedBefore,cacheExistsAfter:state.pairRevisionCaches.has(cacheKey),pairCount:result.completedPairCount};
      },
      debugPhaseDPairRevisionCacheSnapshot: async () => {
        const scopeKey=state.lastResolvedContext?.scope?.scopeKey||'',cache=state.pairRevisionCaches.get(scopeKey)||null;
        return {exists:!!cache,entryCount:Number(cache?.entries?.size||0),
          retainedChars:Number(cache?.retainedChars||0),sequenceDigest:digest(cache?.sequence||[]),pairsDigest:digest(cache?.pairs||null)};
      },
      debugPhaseDManifestIdentityCooperative: async value => await unifiedManifestIdentityCooperative(value),
      debugPhaseDNormalizeReadManifest: async (value,observedTurnValue=0) => {
        const context=await resolveContext();
        return clone(normalizeManifestReadSnapshot(clone(value),context.scope,Number(observedTurnValue||0),true));
      },
      debugPhaseDManifestRevision: async () => {
        const context=await resolveContext();
        return manifestRevisionOf(key.manifest(context.scope));
      },
      debugPhaseDSourceDigest: value => sourceDigest(value),
      debugPhaseDRender: value => renderUnifiedArtifact(value),
      debugPhaseDValidateArtifact: (artifactValue, batchValue) => validateUnifiedArtifact(artifactValue, batchValue, {allowLegacyProfileStrings:true}),
      debugPhaseDSourceEvidencePut: async (scopeValue, unitValue, rowsValue) => {
        const store=createMemorySuiteSourceEvidence({owner:'libra',keyPrefix:s=>\`libra:v1:scope:\${s}:source-evidence:v1:\`,read:async keyValue=>storage.getStoredJson(keyValue,null),write:async(keyValue,rawValue)=>storage.setJson(keyValue,JSON.parse(rawValue))});
        return await store.put(scopeValue,unitValue,rowsValue,{normalizationVersion:'phase-d4-synthetic-v1'});
      },
      debugPhaseDPrepareCandidateBasis: async batchValue => {
        const context=await resolveContext(),pairs=buildPairs(context.chat,context.scope.scopeKey),manifest=await loadManifest(context.scope,pairs.length);
        return clone(await captureUnifiedBasis(context,manifest,batchValue,{}));
      },
      debugPhaseDExpectedLineageDigest: async refsValue => {
        const lineage=[];
        for(const ref of refsValue){const memory=await loadMemoryRef(ref);unifiedAssert(memory,'UNIFIED_PHASE_D_EXPECTED_LINEAGE_MEMORY_MISSING');lineage.push(unifiedThreadTargetCursor(ref,memory,'main').canonicalOriginKey);}
        return digest(lineage);
      },
      debugPhaseDReadManifest: async () => {
        const context=await resolveContext(),pairs=buildPairs(context.chat,context.scope.scopeKey),manifest=await loadManifest(context.scope,pairs.length);
        return clone(manifest);
      },
      debugPhaseDReadStoredManifest: async () => {
        const context=await resolveContext();
        return clone(await storage.getStoredJson(key.manifest(context.scope),null));
      },
      debugPhaseDReadStoredManifestSnapshot: async () => {
        const context=await resolveContext(),manifestKey=key.manifest(context.scope);
        const revisionBefore=manifestRevisionOf(manifestKey);
        const manifest=await storage.getStoredJson(manifestKey,null);
        const revisionAfter=manifestRevisionOf(manifestKey);
        return {key:manifestKey,manifest:clone(manifest),revisionBefore,revisionAfter};
      },
      debugPhaseDReadStoredManifestRaw: async () => {
        const context=await resolveContext(),manifestKey=key.manifest(context.scope);
        return {key:manifestKey,raw:await LibraProviderBridge.storage.getItem(manifestKey)};
      },
      debugPhaseDManifestStorageDiagnostic: async () => {
        const context=await resolveContext(),manifestKey=key.manifest(context.scope);
        const revisionBeforeRaw=manifestRevisionOf(manifestKey);
        const raw=await LibraProviderBridge.storage.getItem(manifestKey);
        const revisionAfterRaw=manifestRevisionOf(manifestKey);
        const rawParsed=parseStoredJson(raw,manifestKey,null);
        const revisionBeforeDecoded=manifestRevisionOf(manifestKey);
        const decoded=await storage.getStoredJson(manifestKey,null);
        const revisionAfterDecoded=manifestRevisionOf(manifestKey);
        const rawSignatures=asArray(rawParsed?.branchGuard?.batchSignatures);
        const decodedSignatures=asArray(decoded?.branchGuard?.batchSignatures);
        return {key:manifestKey,revisionBeforeRaw,revisionAfterRaw,revisionBeforeDecoded,revisionAfterDecoded,
          rawBytes:typeof raw==='string'?raw.length:null,rawDigest:digest(typeof raw==='string'?raw:String(raw)),
          rawParsedDigest:digest(rawParsed),decodedDigest:digest(decoded),rawParsedDecodedEqual:JSON.stringify(rawParsed)===JSON.stringify(decoded),
          rawSignatureCount:rawSignatures.length,decodedSignatureCount:decodedSignatures.length,
          rawSignatures,decodedSignatures};
      },
      debugPhaseDWriteMemory: async (keyValue,memoryValue) => await storage.setJson(keyValue,clone(memoryValue)),
      debugPhaseDWriteManifestRefs: async refsValue => {
        const context=await resolveContext(),pairs=buildPairs(context.chat,context.scope.scopeKey),manifest=await loadManifest(context.scope,pairs.length);
        manifest.memories=Object.fromEntries(refsValue.map(ref=>[String(ref.turnRange.start),clone(ref)]));
        const last=refsValue.at(-1); manifest.frontiers={...manifest.frontiers,observedTurn:last.turnRange.end,committedTurn:last.turnRange.end,contiguousCommittedTurn:last.turnRange.end,firstGapStartTurn:0,contiguousMemoryCount:refsValue.length};
        manifest.branchGuard=normalizeBranchGuard({schema:BRANCH_GUARD_SCHEMA,status:BRANCH_GUARD_READY,
          batchSignatures:branchBatchSignaturesForPairs(pairs),verifiedStarts:[],observedTurns:pairs.length,
          completeBatches:completeBatchStarts(pairs).length,lastFullAuditAt:Date.now(),updatedAt:nowIso()});
        return clone(await saveManifest(context.scope,manifest));
      },
      debugPhaseDBootstrapBranchGuard: async () => {
        const context=await resolveContext(),pairs=buildPairs(context.chat,context.scope.scopeKey),manifest=await loadManifest(context.scope,pairs.length);
        state.branchPairSignatureCache.delete(context.scope.scopeKey);
        manifest.branchGuard=defaultBranchGuard();
        await saveManifest(context.scope,manifest);
        const reconciliation=await reconcileCanonicalBranchBeforeRecall(context,{pairs,reason:'before_request_fast'});
        const updated=await loadManifest(context.scope,pairs.length);
        return {reconciliation:clone(reconciliation),branchGuard:clone(updated.branchGuard),
          recallEligibleStarts:listRecallCurrentMemoryRefs(updated).map(ref=>Number(ref.turnRange.start)),
          committedStarts:fullContinuityRefs(updated).map(ref=>Number(ref.turnRange.start))};
      },
      debugPhaseDSetReadyBranchGuard: async () => {
        const context=await resolveContext(),pairs=buildPairs(context.chat,context.scope.scopeKey),manifest=await loadManifest(context.scope,pairs.length);
        manifest.branchGuard=normalizeBranchGuard({schema:BRANCH_GUARD_SCHEMA,status:BRANCH_GUARD_READY,
          batchSignatures:branchBatchSignaturesForPairs(pairs),verifiedStarts:[],observedTurns:pairs.length,
          completeBatches:completeBatchStarts(pairs).length,lastFullAuditAt:Date.now(),updatedAt:nowIso()});
        refreshCanonicalFrontiers(manifest,pairs.length);
        return clone(await saveManifest(context.scope,manifest));
      },
      debugPhaseDExpectedBranchSignatures: async turnCount => {
        const context=await resolveContext(),pairs=buildPairs(context.chat,context.scope.scopeKey);
        return branchBatchSignaturesForPairs(pairs.slice(0,Math.max(0,Number(turnCount||0))));
      },
      debugPhaseDBuildCandidateFromBasis: async (basisValue,batchValue,signalValue=null) => {
        try {
          const result=await buildContinuityCandidateContext(basisValue,batchValue,signalValue);
          return {candidates:clone(result.candidates),block:String(result.block||''),diagnostics:clone(result.diagnostics)};
        } catch(error) {
          return {error:{name:String(error?.name||''),message:String(error?.message||error)},diagnostics:clone(error?.candidatePreparation||Runtime.lastMemoryCandidatePreparation||null)};
        }
      },`);
  const publicAnchor = "    async debugResolveRecallContinuityClosure(args={}) { return safeClone(await LibraMemoryCore.debugResolveRecallContinuityClosure(args)); },";
  assert.equal(source.includes(publicAnchor), true, 'candidate public export anchor exists');
  return source.replace(publicAnchor, `${publicAnchor}
    debugPhaseDHash(value) { return LibraMemoryCore.debugPhaseDHash(value); },
    async debugPhaseDBuildPairsOnly(signal) { return safeClone(await LibraMemoryCore.debugPhaseDBuildPairsOnly(signal)); },
    async debugPhaseDCountCandidatePairsForMessages(rows) { return safeClone(await LibraMemoryCore.debugPhaseDCountCandidatePairsForMessages(rows)); },
    async debugPhaseDCountCandidatePairsWithMutation(rows) { return safeClone(await LibraMemoryCore.debugPhaseDCountCandidatePairsWithMutation(rows)); },
    async debugPhaseDPairRevisionCacheSnapshot() { return safeClone(await LibraMemoryCore.debugPhaseDPairRevisionCacheSnapshot()); },
    async debugPhaseDManifestIdentityCooperative(value) { return await LibraMemoryCore.debugPhaseDManifestIdentityCooperative(value); },
    async debugPhaseDNormalizeReadManifest(value,observedTurn=0) { return safeClone(await LibraMemoryCore.debugPhaseDNormalizeReadManifest(value,observedTurn)); },
    async debugPhaseDManifestRevision() { return await LibraMemoryCore.debugPhaseDManifestRevision(); },
    debugPhaseDSourceDigest(value) { return LibraMemoryCore.debugPhaseDSourceDigest(value); },
    debugPhaseDRender(value) { return LibraMemoryCore.debugPhaseDRender(value); },
    debugPhaseDValidateArtifact(artifactValue,batchValue) { return safeClone(LibraMemoryCore.debugPhaseDValidateArtifact(artifactValue,batchValue)); },
    async debugPhaseDSourceEvidencePut(scopeValue,unitValue,rowsValue) { return safeClone(await LibraMemoryCore.debugPhaseDSourceEvidencePut(scopeValue,unitValue,rowsValue)); },
    async debugPhaseDPrepareCandidateBasis(batchValue=[]) { return safeClone(await LibraMemoryCore.debugPhaseDPrepareCandidateBasis(batchValue)); },
    async debugPhaseDExpectedLineageDigest(refsValue=[]) { return safeClone(await LibraMemoryCore.debugPhaseDExpectedLineageDigest(refsValue)); },
    async debugPhaseDReadManifest() { return safeClone(await LibraMemoryCore.debugPhaseDReadManifest()); },
    async debugPhaseDReadStoredManifest() { return safeClone(await LibraMemoryCore.debugPhaseDReadStoredManifest()); },
    async debugPhaseDReadStoredManifestSnapshot() { return safeClone(await LibraMemoryCore.debugPhaseDReadStoredManifestSnapshot()); },
    async debugPhaseDReadStoredManifestRaw() { return safeClone(await LibraMemoryCore.debugPhaseDReadStoredManifestRaw()); },
    async debugPhaseDManifestStorageDiagnostic() { return safeClone(await LibraMemoryCore.debugPhaseDManifestStorageDiagnostic()); },
    async debugPhaseDWriteMemory(keyValue,memoryValue) { return safeClone(await LibraMemoryCore.debugPhaseDWriteMemory(keyValue,memoryValue)); },
    async debugPhaseDWriteManifestRefs(refsValue=[]) { return safeClone(await LibraMemoryCore.debugPhaseDWriteManifestRefs(refsValue)); },
    async debugPhaseDBootstrapBranchGuard() { return safeClone(await LibraMemoryCore.debugPhaseDBootstrapBranchGuard()); },
    async debugPhaseDSetReadyBranchGuard() { return safeClone(await LibraMemoryCore.debugPhaseDSetReadyBranchGuard()); },
    async debugPhaseDExpectedBranchSignatures(turnCount=0) { return safeClone(await LibraMemoryCore.debugPhaseDExpectedBranchSignatures(turnCount)); },
    async debugPhaseDBuildCandidateFromBasis(basisValue,batchValue=[],signalValue=null) { return safeClone(await LibraMemoryCore.debugPhaseDBuildCandidateFromBasis(basisValue,batchValue,signalValue)); },`);
};

const sourceRowsForBatch = (start, templateRows = null) => Array.from({ length: BATCH_SIZE }, (_, index) => {
  const turn = start + index;
  const template = templateRows?.[index];
  return {
    turn,
    userMessageId: `t${turn}-u`, assistantMessageId: `t${turn}-a`,
    userText: template?.userText || `합성 사용자 발화 ${turn}`,
    assistantText: template?.assistantText || (turn === start + 4 ? OPEN_SOURCE : `합성 응답 ${turn}`),
    userRaw: template?.userRaw || template?.userText || `합성 사용자 발화 ${turn}`,
    assistantRaw: template?.assistantRaw || template?.assistantText || (turn === start + 4 ? OPEN_SOURCE : `합성 응답 ${turn}`),
    rawAvailable: template?.rawAvailable === true, projectionLabel: 'Phase D synthetic canonical scale'
  };
});

const batchForRows = rows => rows.map(row => ({
  turn: row.turn,
  user: { chatId: row.userMessageId, text: row.userText },
  assistant: { chatId: row.assistantMessageId, text: row.assistantText }
}));

const chatIndexes = new WeakMap();
const appendSourceRowsToChat = (f, rows) => {
  let byId = chatIndexes.get(f);
  if (!byId) {
    byId = new Map(f.chat.message.map((message, index) => [String(message.chatId || ''), index]));
    chatIndexes.set(f, byId);
  }
  for (const row of rows) {
    for (const [role, data, chatId] of [['user', row.userText, row.userMessageId], ['assistant', row.assistantText, row.assistantMessageId]]) {
      const at = byId.get(String(chatId));
      if (at === undefined) {
        byId.set(String(chatId), f.chat.message.length);
        f.chat.message.push({ role, data, chatId });
      } else {
        f.chat.message[at].role = role;
        f.chat.message[at].data = data;
      }
    }
  }
  f.chat.messages = f.chat.message;
};

const adjustArtifact = (seedArtifact, offset) => {
  const value = clone(seedArtifact);
  value.schema = 'libra.canonical_artifact.v5';
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
      if (span.ref === `t${offset + 5}-a` && row.tempFactId === 'f12') span.quote = OPEN_SOURCE;
    }
  }
  const thread = value.facts.find(fact => fact.tempFactId === 'f12');
  if (thread) {
    thread.values.thread = {
      summary: '오늘 열쇠 반환 약속', status: 'open', kind: 'promise',
      participants: [{ role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }]
    };
    thread.text = '오늘 열쇠 반환 약속은 아직 이행되지 않았다.';
  }
  return value;
};

const manifestWithRefs = (manifest, refs) => ({
  ...clone(manifest), memories: Object.fromEntries(refs.map(ref => [String(ref.turnRange.start), clone(ref)])),
  frontiers: { ...clone(manifest.frontiers || {}), observedTurn: refs.at(-1).turnRange.end,
    committedTurn: refs.at(-1).turnRange.end, contiguousCommittedTurn: refs.at(-1).turnRange.end,
    contiguousMemoryCount: refs.length }, updatedAt: new Date().toISOString()
});

const delayMetrics = histogram => histogram.count ? {
  status: 'sampled', sampleCount: histogram.count,
  minMs: histogram.min / 1e6, meanMs: histogram.mean / 1e6,
  p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6
} : { status: 'insufficient_sample', sampleCount: 0, minMs: null, meanMs: null, p99Ms: null, maxMs: null };

const firstArrayDifference = (leftValue,rightValue) => {
  const left=Array.isArray(leftValue)?leftValue:[],right=Array.isArray(rightValue)?rightValue:[];
  const limit=Math.max(left.length,right.length);
  for(let index=0;index<limit;index+=1)if(left[index]!==right[index])return {index,left:left[index]??null,right:right[index]??null,leftLength:left.length,rightLength:right.length};
  return null;
};

const memoryMetrics = (before, after) => ({
  heapUsedBeforeBytes: before.heapUsed, heapUsedAfterBytes: after.heapUsed,
  heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
  rssBeforeBytes: before.rss, rssAfterBytes: after.rss, rssDeltaBytes: after.rss - before.rss
});

const waitForStableManifest = async (api, label, manifestKey = '') => {
  const instrument = String(label).includes('10000');
  const readStartedAt=performance.now();
  let previous=await api.debugPhaseDReadStoredManifestSnapshot();
  assert.equal(previous?.key,manifestKey,`${label}: stability reads the exact stored manifest key used by the consumer`);
  let previousValue=JSON.stringify(previous?.manifest),consecutive=0;
  if (instrument) console.log(JSON.stringify({record:'candidate_context_manifest_stability_progress',label,attempt:0,
    stage:'initial_semantic_read_complete',elapsedMs:performance.now()-readStartedAt,serializedChars:previousValue?.length||0,
    revisionBefore:previous?.revisionBefore,revisionAfter:previous?.revisionAfter,manifestKey:previous?.key,source:'storage.getStoredJson'}));
  for (let attempt=0;attempt<100&&consecutive<10;attempt+=1) {
    await new Promise(resolve=>setTimeout(resolve,10));
    const startedAt=performance.now();
    const next=await api.debugPhaseDReadStoredManifestSnapshot();
    assert.equal(next?.key,manifestKey,`${label}: every stability read uses the exact stored manifest key`);
    const nextValue=JSON.stringify(next?.manifest);
    const revisionStable=next?.revisionBefore===next?.revisionAfter&&next?.revisionAfter===previous?.revisionAfter;
    consecutive=nextValue===previousValue&&revisionStable?consecutive+1:0;
    if (instrument) console.log(JSON.stringify({record:'candidate_context_manifest_stability_progress',label,attempt:attempt+1,
      stage:'semantic_read_and_revision_complete',elapsedMs:performance.now()-startedAt,stableChecks:consecutive,
      serializedChars:nextValue?.length||0,revisionBefore:next?.revisionBefore,revisionAfter:next?.revisionAfter}));
    previous=next;previousValue=nextValue;
  }
  assert.ok(consecutive>=10,`${label}: getStoredJson snapshot and manifest revision stabilize for ten consecutive 10ms checks before measurement`);
  if (instrument) console.log(JSON.stringify({record:'candidate_context_manifest_stability_complete',label,
    elapsedMs:performance.now()-readStartedAt,stableChecks:consecutive,manifestRevision:previous?.revisionAfter,
    parsedFromProductRead:true,manifestKey:previous?.key}));
  assert.ok(previous?.manifest&&typeof previous.manifest==='object',`${label}: stable semantic read produced the manifest snapshot used by subsequent assertions`);
  return {manifest:previous.manifest,raw:previousValue,revision:previous.revisionAfter,stableChecks:consecutive};
};

const createStageProbe = signal => {
  let currentStage = 'candidate_entry';
  const stageStarts = new Map(), elapsedByStageMs = {};
  signal.__phaseDStageEvent = label => {
    const at = performance.now();
    if (label.endsWith(':start')) {
      currentStage = label.slice(0, -6);
      stageStarts.set(currentStage, at);
    } else if (label.endsWith(':end')) {
      const stage = label.slice(0, -4), started = stageStarts.get(stage);
      if (started !== undefined) elapsedByStageMs[stage] = at - started;
      currentStage = `${stage}_complete`;
    } else currentStage = label;
  };
  return {
    current: () => currentStage,
    elapsedByStageMs: () => ({ ...elapsedByStageMs }),
    elapsedAtCurrentStage: () => {
      const started = stageStarts.get(currentStage);
      return started === undefined ? null : performance.now() - started;
    }
  };
};

const measureCandidate = async (api, basis, batch) => {
  if (typeof global.gc === 'function') global.gc();
  const memoryBefore = process.memoryUsage();
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const controller = new AbortController(), stageProbe = createStageProbe(controller.signal);
  const started = performance.now();
  const result = await api.debugPhaseDBuildCandidateFromBasis(basis, batch, controller.signal);
  const elapsedMs = performance.now() - started;
  loopDelay.disable();
  const memoryAfter = process.memoryUsage();
  return { result, elapsedMs, stageTimingsMs: stageProbe.elapsedByStageMs(),
    memory: memoryMetrics(memoryBefore, memoryAfter), eventLoopDelay: delayMetrics(loopDelay) };
};

const measureCandidateCancellation = async (api, basis, batch, refCount) => {
  const dueMs = 5, controller = new AbortController(), stageProbe = createStageProbe(controller.signal), scheduledAt = performance.now();
  let deliveredAt = null, abortAt = null, timerDeliveryPhase = null, refsScannedAtTimer = null, stageTimingsAtTimer = null;
  const timer = setTimeout(() => { deliveredAt = performance.now(); timerDeliveryPhase = stageProbe.current();
    refsScannedAtTimer = api.getRuntime().lastMemoryCandidatePreparation?.refsScanned ?? null;
    stageTimingsAtTimer = { ...stageProbe.elapsedByStageMs(), activeStageElapsedMs: stageProbe.elapsedAtCurrentStage() };
    controller.abort(); abortAt = performance.now(); }, dueMs);
  if (typeof global.gc === 'function') global.gc();
  const memoryBefore = process.memoryUsage();
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const started = performance.now();
  const result = await api.debugPhaseDBuildCandidateFromBasis(basis, batch, controller.signal);
  const finishedAt = performance.now();
  clearTimeout(timer);
  loopDelay.disable();
  const memoryAfter = process.memoryUsage();
  const timerWasDelivered = deliveredAt !== null;
  if (timerWasDelivered) {
    assert.equal(result.error?.name, 'AbortError', 'timer-delivered candidate cancellation is surfaced as AbortError');
    assert.equal(result.diagnostics?.cancelObserved, true, 'candidate cancellation observes the internal signal');
    assert.ok(Number(result.diagnostics?.refsScanned || 0) < refCount, 'candidate cancellation stops before the full ref scale');
  } else {
    assert.equal(result.error, undefined, 'completion before abort timer is successful');
  }
  const timerDeliveryDelayRawMs = timerWasDelivered ? deliveredAt - (scheduledAt + dueMs) : null;
  return {
    outcome: timerWasDelivered ? 'aborted-during-call' : 'completed-before-abort',
    timerRequestedDelayMs: dueMs,
    timerDeliveryDelayRawMs,
    timerDeliveryDelayMs: timerDeliveryDelayRawMs === null ? null : Math.max(0, timerDeliveryDelayRawMs),
    timerDeliveryPhase, refsScannedAtTimer, stageTimingsAtTimer,
    abortToCompletionMs: timerWasDelivered ? finishedAt - abortAt : null,
    elapsedMs: finishedAt - started,
    refsScanned: result.diagnostics?.refsScanned ?? null,
    factsInspected: result.diagnostics?.factsInspected ?? null,
    testPreScanElapsedMs: result.diagnostics?.testPreScanElapsedMs ?? null,
    testScanElapsedMs: result.diagnostics?.testScanElapsedMs ?? null,
    testMemoryReadElapsedMs: result.diagnostics?.testMemoryReadElapsedMs ?? null,
    testMemoryReadMaxMs: result.diagnostics?.testMemoryReadMaxMs ?? null,
    testEvidenceReadElapsedMs: result.diagnostics?.testEvidenceReadElapsedMs ?? null,
    testEvidenceReadMaxMs: result.diagnostics?.testEvidenceReadMaxMs ?? null,
    testPreScanStagesMs: Object.fromEntries(['testContextResolveElapsedMs','testBasisCheckElapsedMs','testPairBuildElapsedMs','testManifestLoadElapsedMs','testManifestIdentityElapsedMs','testRefSelectionElapsedMs']
      .map(key => [key, result.diagnostics?.[key] ?? null])),
    cancelObserved: result.diagnostics?.cancelObserved === true,
    memory: memoryMetrics(memoryBefore, memoryAfter), eventLoopDelay: delayMetrics(loopDelay)
  };
};

const measureCancellationDuringPairBuild = async (api, basis, batch, refCount) => {
  const dueMs = 5, controller = new AbortController(), stageProbe = createStageProbe(controller.signal);
  let requestedAt = null, deliveredAt = null, abortAt = null, timer = null, timerDeliveryPhase = null;
  let refsScannedAtTimer = null, stageTimingsAtTimer = null, projectionsAtTimer = null;
  controller.signal.__phaseDOnPairBuild = () => {
    requestedAt = performance.now();
    timer = setTimeout(() => {
      deliveredAt = performance.now(); timerDeliveryPhase = stageProbe.current();
      refsScannedAtTimer = api.getRuntime().lastMemoryCandidatePreparation?.refsScanned ?? null;
      projectionsAtTimer = controller.signal.__phaseDProjectionCount ?? null;
      stageTimingsAtTimer = { ...stageProbe.elapsedByStageMs(), activeStageElapsedMs: stageProbe.elapsedAtCurrentStage() };
      controller.abort(); abortAt = performance.now();
    }, dueMs);
  };
  const before = process.memoryUsage(), loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const started = performance.now();
  const result = await api.debugPhaseDBuildCandidateFromBasis(basis, batch, controller.signal);
  const finishedAt = performance.now();
  if (timer) clearTimeout(timer);
  loopDelay.disable();
  const after = process.memoryUsage();
  assert.notEqual(requestedAt, null, 'pair-build cancellation timer is armed at the candidate pair-build boundary');
  assert.notEqual(deliveredAt, null, 'pair-build cancellation timer is delivered');
  const timerDeliveryDelayRawMs = deliveredAt - (requestedAt + dueMs);
  const timerDeliveryDelayMs = Math.max(0, timerDeliveryDelayRawMs);
  console.log(JSON.stringify({ record: 'candidate_context_pair_build_cancel_probe', timerRequestedDelayMs: dueMs,
    timerDeliveryDelayRawMs, timerDeliveryDelayMs, timerDeliveryPhase, projectionsAtTimer, refsScannedAtTimer, stageTimingsAtTimer,
    testPairBuildElapsedMs: result.diagnostics?.testPairBuildElapsedMs ?? null,
    eventLoopDelay: delayMetrics(loopDelay) }));
  assert.ok(timerDeliveryDelayMs <= 100,
    `focused pair-build event-loop sentinel: a 5ms timer should be delivered within 100ms; observed ${timerDeliveryDelayMs.toFixed(3)}ms late`);
  assert.equal(result.error?.name, 'AbortError', 'pair-build timer cancellation is observed before ref scanning');
  assert.equal(result.diagnostics?.cancelObserved, true, 'pair-build cancellation is reflected in diagnostics');
  assert.ok(Number(result.diagnostics?.refsScanned || 0) < refCount, 'pair-build cancellation stops before scanning the canonical refs');
  assert.ok(Number(projectionsAtTimer || 0) >= 128, 'pair-count cancellation is delivered after the first 128-message cooperative projection chunk');
  return {
    scheduledAtPairBuild: true, timerRequestedDelayMs: dueMs,
    timerDeliveryDelayRawMs, timerDeliveryDelayMs, abortToCompletionMs: finishedAt - abortAt,
    timerDeliveryPhase, projectionsAtTimer, refsScannedAtTimer, stageTimingsAtTimer,
    elapsedMs: finishedAt - started, refsScanned: result.diagnostics?.refsScanned ?? null,
    testPairBuildElapsedMs: result.diagnostics?.testPairBuildElapsedMs ?? null,
    cancelObserved: result.diagnostics?.cancelObserved === true,
    memory: memoryMetrics(before, after), eventLoopDelay: delayMetrics(loopDelay)
  };
};

const measureCancellationDuringSourceFreshness = async (api,basis,batch,refCount) => {
  const dueMs=5,controller=new AbortController(),stageProbe=createStageProbe(controller.signal);
  let requestedAt=null,dueAt=null,deliveredAt=null,abortAt=null,timer=null,timerDeliveryPhase=null;
  let freshnessStartedAt=null,freshnessEndedAt=null,refsScannedAtTimer=null,stageTimingsAtTimer=null;
  controller.signal.__phaseDOnSourceFreshness=()=>{
    requestedAt=performance.now();dueAt=requestedAt+dueMs;freshnessStartedAt=requestedAt;
    timer=setTimeout(()=>{
      deliveredAt=performance.now();timerDeliveryPhase=stageProbe.current();
      refsScannedAtTimer=api.getRuntime().lastMemoryCandidatePreparation?.refsScanned??null;
      stageTimingsAtTimer={...stageProbe.elapsedByStageMs(),activeStageElapsedMs:stageProbe.elapsedAtCurrentStage()};
      controller.abort();abortAt=performance.now();
    },dueMs);
  };
  const originalStageEvent=controller.signal.__phaseDStageEvent;
  controller.signal.__phaseDStageEvent=label=>{
    originalStageEvent?.(label);
    if(label==='candidate_build_pairs_freshness:end')freshnessEndedAt=performance.now();
  };
  const before=process.memoryUsage(),loopDelay=monitorEventLoopDelay({resolution:1});loopDelay.enable();
  const started=performance.now();
  const result=await api.debugPhaseDBuildCandidateFromBasis(basis,batch,controller.signal);
  const finishedAt=performance.now();if(timer)clearTimeout(timer);loopDelay.disable();
  const timerDelivered=deliveredAt!==null;
  assert.notEqual(requestedAt,null,'freshness-phase timer is armed inside the actual product current-source check');
  assert.notEqual(freshnessEndedAt,null,'actual product current-source check completes with its stage marker');
  assert.equal(dueAt<=freshnessEndedAt,true,'5ms cancellation is requested while the synchronous freshness pass is still executing');
  assert.equal(timerDelivered,true,'freshness-phase cancellation timer is eventually delivered');
  assert.equal(result.error?.name,'AbortError','timer cancellation is observed at the next cooperative product checkpoint');
  assert.equal(result.diagnostics?.cancelObserved,true,'freshness-phase timer cancellation is recorded by product diagnostics');
  assert.ok(Number(result.diagnostics?.refsScanned||0)<refCount,'freshness-phase cancellation stops before all candidate refs are scanned');
  const timerDeliveryDelayRawMs=deliveredAt-dueAt;
  const resultRow={scheduledDuringActualFreshness:true,timerRequestedDelayMs:dueMs,timerDeliveryDelayRawMs,
    timerDeliveryDelayMs:Math.max(0,timerDeliveryDelayRawMs),timerDeliveryPhase,requestedDuringFreshness:true,
    freshnessDurationMs:freshnessEndedAt-freshnessStartedAt,dueTimeOverlappedFreshness:true,
    refsScannedAtTimer,stageTimingsAtTimer,abortToCompletionMs:finishedAt-abortAt,
    elapsedMs:finishedAt-started,refsScanned:result.diagnostics?.refsScanned??null,
    testPairSourceFreshnessElapsedMs:result.diagnostics?.testPairSourceFreshnessElapsedMs??null,
    eventLoopDelay:delayMetrics(loopDelay),memory:memoryMetrics(before,process.memoryUsage()),
    evidenceBoundary:'timer scheduled during actual synchronous product freshness checkpoint; delivery occurs at next product await/checkpoint'};
  console.log(JSON.stringify({record:'candidate_context_source_freshness_cancellation',...resultRow}));
  return resultRow;
};

const measureCancellationDuringManifestLoad = async (api, basis, batch, refCount) => {
  const dueMs = 5, controller = new AbortController(), stageProbe = createStageProbe(controller.signal);
  let requestedAt = null, deliveredAt = null, abortAt = null, timer = null, timerDeliveryPhase = null, refsScannedAtTimer = null, stageTimingsAtTimer = null;
  controller.signal.__phaseDOnManifestProcessing = () => {
    requestedAt = performance.now();
    timer = setTimeout(() => { deliveredAt = performance.now(); timerDeliveryPhase = stageProbe.current();
      refsScannedAtTimer = api.getRuntime().lastMemoryCandidatePreparation?.refsScanned ?? null;
      stageTimingsAtTimer = { ...stageProbe.elapsedByStageMs(), activeStageElapsedMs: stageProbe.elapsedAtCurrentStage() };
      controller.abort(); abortAt = performance.now(); }, dueMs);
  };
  const before = process.memoryUsage(), loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const started = performance.now();
  const result = await api.debugPhaseDBuildCandidateFromBasis(basis, batch, controller.signal);
  const finishedAt = performance.now();
  if (timer) clearTimeout(timer);
  loopDelay.disable();
  const after = process.memoryUsage();
  assert.notEqual(requestedAt, null, 'manifest-processing cancellation probe is armed before current-manifest validation');
  assert.notEqual(deliveredAt, null, 'manifest-processing timer is delivered');
  const timerDeliveryDelayRawMs = deliveredAt - (requestedAt + dueMs);
  const timerDeliveryDelayMs = Math.max(0, timerDeliveryDelayRawMs);
  assert.ok(timerDeliveryDelayMs <= 100,
    `focused event-loop stall sentinel: 10,000-ref candidate processing should deliver a 5ms cancellation timer within 100ms; historical same-host loadManifest observed 5.735–9.068s delay`);
  assert.equal(result.error?.name, 'AbortError', 'manifest-processing timer is observed by candidate preparation');
  assert.equal(result.diagnostics?.cancelObserved, true, 'manifest-processing cancellation is reflected in diagnostics');
  assert.ok(Number(result.diagnostics?.refsScanned || 0) < refCount, 'manifest-processing cancellation stops before ref scanning');
  return {
    scheduledAtManifestProcessing: true, timerRequestedDelayMs: dueMs,
    timerDeliveryDelayRawMs, timerDeliveryDelayMs, abortToCompletionMs: finishedAt - abortAt,
    timerDeliveryPhase, refsScannedAtTimer, stageTimingsAtTimer,
    elapsedMs: finishedAt - started, refsScanned: result.diagnostics?.refsScanned ?? null,
    testPreScanElapsedMs: result.diagnostics?.testPreScanElapsedMs ?? null,
    testManifestNormalizationElapsedMs: result.diagnostics?.testManifestNormalizationElapsedMs ?? null,
    testPreScanStagesMs: Object.fromEntries(['testContextResolveElapsedMs','testBasisCheckElapsedMs','testPairBuildElapsedMs','testManifestNormalizationElapsedMs','testManifestIdentityRecheckElapsedMs','testRefSelectionElapsedMs']
      .map(key => [key, result.diagnostics?.[key] ?? null])),
    cancelObserved: result.diagnostics?.cancelObserved === true,
    memory: memoryMetrics(before, after), eventLoopDelay: delayMetrics(loopDelay)
  };
};

const measureCancellationDuringManifestNormalization = async (api, basis, batch, refCount) => {
  const dueMs = 5, controller = new AbortController(), stageProbe = createStageProbe(controller.signal);
  let requestedAt = null, deliveredAt = null, abortAt = null, timer = null, timerDeliveryPhase = null, refsScannedAtTimer = null, stageTimingsAtTimer = null;
  controller.signal.__phaseDOnManifestNormalization = () => {
    requestedAt = performance.now();
    timer = setTimeout(() => { deliveredAt = performance.now(); timerDeliveryPhase = stageProbe.current();
      refsScannedAtTimer = api.getRuntime().lastMemoryCandidatePreparation?.refsScanned ?? null;
      stageTimingsAtTimer = { ...stageProbe.elapsedByStageMs(), activeStageElapsedMs: stageProbe.elapsedAtCurrentStage() };
      controller.abort(); abortAt = performance.now(); }, dueMs);
  };
  const before = process.memoryUsage(), loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const started = performance.now();
  const result = await api.debugPhaseDBuildCandidateFromBasis(basis, batch, controller.signal);
  const finishedAt = performance.now();
  if (timer) clearTimeout(timer);
  loopDelay.disable();
  const after = process.memoryUsage();
  assert.notEqual(requestedAt, null, 'normalization timer is armed at the candidate manifest normalizer');
  assert.notEqual(deliveredAt, null, 'normalization timer is delivered');
  const timerDeliveryDelayRawMs = deliveredAt - (requestedAt + dueMs);
  const timerDeliveryDelayMs = Math.max(0, timerDeliveryDelayRawMs);
  assert.ok(timerDeliveryDelayMs <= 100,
    `focused event-loop stall sentinel: manifest normalization delivers a 5ms timer within 100ms; observed ${timerDeliveryDelayMs.toFixed(3)}ms late`);
  assert.equal(result.error?.name, 'AbortError', 'normalization timer is observed before candidate ref scanning');
  assert.equal(result.diagnostics?.cancelObserved, true, 'normalization cancellation is reflected in diagnostics');
  assert.ok(Number(result.diagnostics?.refsScanned || 0) < refCount,
    'normalization cancellation stops before completing the candidate ref scan');
  return {
    scheduledAtManifestNormalization: true, timerRequestedDelayMs: dueMs,
    timerDeliveryDelayRawMs, timerDeliveryDelayMs, abortToCompletionMs: finishedAt - abortAt,
    timerDeliveryPhase, refsScannedAtTimer, stageTimingsAtTimer,
    elapsedMs: finishedAt - started, refsScanned: result.diagnostics?.refsScanned ?? null,
    testManifestNormalizationElapsedMs: result.diagnostics?.testManifestNormalizationElapsedMs ?? null,
    cancelObserved: result.diagnostics?.cancelObserved === true,
    memory: memoryMetrics(before, after), eventLoopDelay: delayMetrics(loopDelay)
  };
};

const assertManifestReadParity = async (api, storage, manifestKey, rawManifest, observedTurn) => {
  const oddJsonShape = {
    memories: { first: { omitted: undefined, nonFinite: Infinity }, omitted: undefined },
    inheritedMemories: [undefined, null]
  };
  const streamedIdentity = await api.debugPhaseDManifestIdentityCooperative(oddJsonShape);
  const canonicalIdentity = api.debugPhaseDHash({ memories: oddJsonShape.memories, inherited: oddJsonShape.inheritedMemories });
  assert.equal(streamedIdentity, canonicalIdentity, 'cooperative manifest identity matches JSON.stringify omission/null behavior');

  const variant = clone(rawManifest);
  const starts = Object.keys(variant.memories || {}).sort((a, b) => Number(a) - Number(b));
  assert.ok(starts.length >= 3, 'manifest parity fixture has enough current refs to form a gap');
  const gapKey = starts[1];
  delete variant.memories[gapKey];
  const inheritedTemplate = clone(rawManifest.memories[starts.at(-1)]);
  variant.inheritedMemories = [...(variant.inheritedMemories || []), {
    ...inheritedTemplate, sessionEpoch: -1, inheritedSessionHistory: true
  }];
  variant.branchGuard = { ...(variant.branchGuard || {}), schema: 'libra.branch_guard.v1',
    status: 'bootstrap_pending', verifiedStarts: [Number(starts[0])] };
  variant.frontiers = { ...(variant.frontiers || {}), observedTurn: 0 };
  const originalBytes = JSON.stringify(variant);
  const originalRawManifest = clone(rawManifest);
  try {
    await api.debugPhaseDWriteMemory(manifestKey, variant);
    const loadedByProduct = await api.debugPhaseDReadManifest();
    const normalizedCandidateSnapshot = await api.debugPhaseDNormalizeReadManifest(variant, observedTurn);
    assert.deepEqual(normalizedCandidateSnapshot, loadedByProduct,
      'candidate snapshot normalization matches loadManifest for gap, bootstrap guard, and inherited refs');
    assert.equal(normalizedCandidateSnapshot.frontiers.observedTurn, observedTurn,
      'candidate snapshot normalization refreshes observedTurn from the current chat');
    assert.equal(normalizedCandidateSnapshot.frontiers.firstGapStartTurn, Number(gapKey),
      'candidate snapshot normalization preserves the current contiguous gap');
    assert.equal(normalizedCandidateSnapshot.branchGuard.status, 'bootstrap_pending',
      'candidate snapshot normalization keeps bootstrap pending');
    assert.equal(normalizedCandidateSnapshot.inheritedMemories.at(-1).inheritedSessionHistory, true,
      'candidate snapshot normalization keeps inherited refs');
    assert.equal(JSON.stringify(variant), originalBytes, 'candidate normalization leaves its raw input unchanged');

    const unsupported = { ...variant, schema: 'libra.manifest.future' };
    await api.debugPhaseDWriteMemory(manifestKey, unsupported);
    await assert.rejects(api.debugPhaseDReadManifest(), /지원하지 않는 LIBRA manifest schema/,
      'loadManifest continues to reject unsupported manifest schemas');
    await assert.rejects(api.debugPhaseDNormalizeReadManifest(unsupported, observedTurn), /지원하지 않는 LIBRA manifest schema/,
      'candidate normalization rejects the same unsupported manifest schema');
  } finally {
    await api.debugPhaseDWriteMemory(manifestKey, originalRawManifest);
  }
  return { streamedIdentityParity: true, gapStart: Number(gapKey), observedTurn,
    bootstrapStatus: 'bootstrap_pending', inheritedRefCount: variant.inheritedMemories.length,
    unsupportedSchemaRejectedByBothReadPaths: true, rawInputUnchanged: JSON.stringify(variant) === originalBytes };
};

const assertCandidateManifestRecheck = async (api, manifestKey, manifestSnapshot, basis, batch) => {
  const controller = new AbortController();
  let mutationRan = false;
  controller.signal.__phaseDAfterManifestSnapshot = async () => {
    const changed = clone(manifestSnapshot), firstRef = Object.values(changed.memories || {})[0];
    firstRef.summary = `${firstRef.summary || ''} stale-read-probe`;
    await api.debugPhaseDWriteMemory(manifestKey, changed);
    mutationRan = true;
  };
  let result;
  try {
    result = await api.debugPhaseDBuildCandidateFromBasis(basis, batch, controller.signal);
    assert.equal(mutationRan, true, 'manifest mutation occurred between candidate snapshot normalization and currentness recheck');
    assert.equal(result.error?.message, 'UNIFIED_THREAD_CANDIDATE_CHAIN_CHANGED',
      'candidate stage rejects a manifest that changes after its first verified snapshot');
    assert.equal(result.diagnostics?.refsScanned, 0, 'stale manifest is rejected before candidate ref scanning');
  } finally {
    await api.debugPhaseDWriteMemory(manifestKey, manifestSnapshot);
  }
  return { mutationBetweenReadsRejected: true, refsScanned: result.diagnostics?.refsScanned ?? null };
};

const assertCandidateUsesLatestBranchGuard = async (api, manifestKey, manifestSnapshot, basis, batch) => {
  const controller = new AbortController();
  let mutationRan = false;
  const firstRef = Object.values(manifestSnapshot.memories || {})[0];
  controller.signal.__phaseDAfterManifestSnapshot = async () => {
    const changed = clone(manifestSnapshot);
    changed.branchGuard = { ...(changed.branchGuard || {}), schema: 'libra.branch_guard.v1',
      status: 'bootstrap_pending', verifiedStarts: [Number(firstRef.turnRange.start)] };
    await api.debugPhaseDWriteMemory(manifestKey, changed);
    mutationRan = true;
  };
  let result;
  try {
    result = await api.debugPhaseDBuildCandidateFromBasis(basis, batch, controller.signal);
    assert.equal(mutationRan, true, 'branchGuard-only update occurred between the verified basis read and current snapshot read');
    assert.equal(result.error, undefined, `branchGuard-only update preserves the unchanged canonical identity (${JSON.stringify(result.error || {})})`);
    assert.equal(result.diagnostics?.branchGuardStatus, 'bootstrap_pending',
      'candidate preparation normalizes the newest raw branchGuard snapshot');
    assert.equal(result.diagnostics?.candidateTargetsFiltered, Object.keys(manifestSnapshot.memories || {}).length - 1,
      'only the current branchGuard verified start remains eligible as a candidate target');
    assert.equal(result.diagnostics?.partial, true, 'candidate reports incomplete coverage during bootstrap verification');
    assert.ok(result.diagnostics?.partialReasons?.includes('branch_guard_pending'),
      'candidate coverage identifies the bootstrap-pending branchGuard reason');
    assert.match(result.block, /THREAD CANDIDATE COVERAGE INCOMPLETE/,
      'candidate prompt states that bootstrap-filtered coverage is incomplete');
  } finally {
    await api.debugPhaseDWriteMemory(manifestKey, manifestSnapshot);
  }
  return { latestBranchGuardObserved: result.diagnostics.branchGuardStatus,
    targetsFiltered: result.diagnostics.candidateTargetsFiltered, partial: result.diagnostics.partial,
    refsScanned: result.diagnostics.refsScanned };
};

const run = async () => {
  const snapshot = await serverFixture({ mode: 'plugin_only', transformSource: candidateProbeTransform });
  try {
    const f = snapshot.f, api = f.r.api, storage = f.r.context.risuai.pluginStorage;
    if (PAIR_BUILD_DIAGNOSTIC_ONLY) {
      const pairCount = 50005;
      f.chat.message = Array.from({ length: pairCount * 2 }, (_, index) => {
        const turn = Math.floor(index / 2) + 1, user = index % 2 === 0;
        return { role: user ? 'user' : 'assistant', chatId: `d4_pair_${turn}_${user ? 'u' : 'a'}`,
          data: user ? `synthetic user source ${turn}` : `synthetic assistant source ${turn}` };
      });
      const controller = new AbortController(), stageProbe = createStageProbe(controller.signal);
      let requestedAt = null, deliveredAt = null, abortAt = null;
      controller.signal.__phaseDOnPairBuild = () => {
        requestedAt = performance.now();
        setTimeout(() => { deliveredAt = performance.now(); controller.abort(); abortAt = performance.now(); }, 5);
      };
      const loopDelay=monitorEventLoopDelay({resolution:1}), started=performance.now();loopDelay.enable();
      const result=await api.debugPhaseDBuildPairsOnly(controller.signal);
      const elapsedMs=performance.now()-started;loopDelay.disable();
      const timerDeliveryDelayRawMs=deliveredAt===null?null:deliveredAt-(requestedAt+5);
      assert.equal(result.pairCount,pairCount,'direct pair-build probe reconstructs every expected U+A pair');
      console.log(JSON.stringify({record:'candidate_context_pair_build_diagnostic_only',messageCount:f.chat.message.length,
        pairCount:result.pairCount,elapsedMs,timerRequestedDelayMs:5,timerDeliveryDelayRawMs,
        timerDeliveryDelayMs:timerDeliveryDelayRawMs===null?null:Math.max(0,timerDeliveryDelayRawMs),
        abortToReturnMs:abortAt===null?null:performance.now()-abortAt,stageTimingsMs:stageProbe.elapsedByStageMs(),
        eventLoopDelay:delayMetrics(loopDelay),fixture:'100010 alternating synthetic user/assistant messages; no canonical refs or provider call'}));
      return;
    }
    f.chat.message.find(row => row.chatId === 't5-a').data = OPEN_SOURCE;
    f.control.artifact = adjustArtifact(artifact(), 0);
    f.control.onCall = () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
    const seedRun = await f.run();
    assert.equal(seedRun.completed, 1, 'real v5 seed canonical run commits');
    const pairCountParityCases = [
      { name: 'alternating', rows: [
        { role: 'user', chatId: 'parity-u1', data: 'question' },
        { role: 'assistant', chatId: 'parity-a1', data: 'answer' }
      ], expected: 1 },
      { name: 'consecutive-users', rows: [
        { role: 'human', chatId: 'parity-u1', data: 'first' },
        { role: 'user', chatId: 'parity-u2', data: 'second' },
        { role: 'assistant', chatId: 'parity-a1', data: 'answer' }
      ], expected: 1 },
      { name: 'leading-assistant', rows: [
        { role: 'assistant', chatId: 'parity-a0', data: 'orphan' },
        { role: 'user', chatId: 'parity-u1', data: 'question' },
        { role: 'char', chatId: 'parity-a1', data: 'answer' }
      ], expected: 1 },
      { name: 'empty-and-tag-only', rows: [
        { role: 'user', chatId: 'parity-u0', data: '' },
        { role: 'assistant', chatId: 'parity-a0', data: '[LBDATA START]carrier[LBDATA END]' },
        { role: 'user', chatId: 'parity-u1', data: 'question' },
        { role: 'assistant', chatId: 'parity-a1', data: '<lb-stage>carrier</lb-stage>' }
      ], expected: 0 },
      { name: 'disabled-and-comment', rows: [
        { role: 'user', chatId: 'parity-u1', data: 'question' },
        { role: 'assistant', chatId: 'parity-a0', data: 'disabled', disabled: true },
        { role: 'assistant', chatId: 'parity-a1', data: 'answer' },
        { role: 'user', chatId: 'parity-u2', data: 'question 2' },
        { role: 'assistant', chatId: 'parity-a2', data: 'comment', isComment: true }
      ], expected: 1 },
      { name: 'nested-msg-and-role-aliases', rows: [
        { msg: { role: 'player', chatId: 'parity-u1', data: 'question' } },
        { msg: { speakerType: 'model', chatId: 'parity-a1', data: 'answer' } }
      ], expected: 1 }
    ];
    for (const testCase of pairCountParityCases) {
      const parity = await api.debugPhaseDCountCandidatePairsForMessages(testCase.rows);
      assert.equal(parity.expectedPairCount, testCase.expected, `${testCase.name}: sync pair oracle has expected count`);
      assert.equal(parity.actualPairCount, parity.expectedPairCount, `${testCase.name}: cooperative pair count matches buildPairs`);
    }
    const mutationRows = Array.from({ length: 256 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', chatId: `pair_mutation_${index}`,
      data: index === 0 ? 'old text' : `body ${index}`
    }));
    const mutationCacheBefore = await api.debugPhaseDPairRevisionCacheSnapshot();
    const mutationResult = await api.debugPhaseDCountCandidatePairsWithMutation(mutationRows);
    assert.equal(mutationResult.changed, true, 'same-object/same-length source edit occurs during a cooperative yield');
    assert.equal(mutationResult.error, 'UNIFIED_THREAD_CANDIDATE_SOURCE_CHANGED', 'the cooperative count rejects an in-place body edit before returning');
    assert.equal(mutationResult.cacheExistedBefore, false, 'pair-count path has no dedicated persistent cache scope');
    assert.equal(mutationResult.cacheExistsAfter, false, 'source-change rejection publishes no pair-cache state');
    const mutationCacheAfter = await api.debugPhaseDPairRevisionCacheSnapshot();
    assert.deepEqual(mutationCacheAfter, mutationCacheBefore,
      'candidate pair-count preparation leaves live cache entries, sequence, and pairs unchanged');
    mutationRows[0].data = 'old text';
    const mutationRetry = await api.debugPhaseDCountCandidatePairsForMessages(mutationRows);
    assert.equal(mutationRetry.actualPairCount, mutationRetry.expectedPairCount,
      'retry after the rejected mutation matches a fresh synchronous pair build');
    console.log(JSON.stringify({ record: 'candidate_pair_count_parity_and_stale_source',
      cases: pairCountParityCases.map(({name,expected}) => ({name,expected})), mutationResult,
      retryPairCount: mutationRetry.actualPairCount, pairRevisionCacheUnchanged: true,
      boundary: 'candidate consumer uses only completed-pair count; no shared pair cache is read or written' }));
    const manifestKey = [...snapshot.local.keys()].find(key => /:manifest$/.test(key));
    const initialManifest = parse(await storage.getItem(manifestKey));
    assert.ok(initialManifest?.memories?.['1'], 'seed manifest is readable');
    const seedRef = initialManifest.memories['1'];
    const seedMemory = parse(await storage.getItem(seedRef.key));
    assert.equal(seedMemory?.artifactSchema, 'libra.canonical_artifact.v5', 'seed is a typed v5 memory');
    const seedEvidence = parse(await storage.getItem(seedMemory.sourceEvidenceRef.key));
    assert.equal(Array.isArray(seedEvidence?.rows) && seedEvidence.rows.length, BATCH_SIZE,
      'seed approved source evidence rows are available as the synthetic template');
    let seedHistory = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      seedHistory = await api.getWorldManagerHistoryDetail({ memoryId: seedRef.memoryId, revision: seedRef.revision });
      const status = String(seedHistory?.provenance?.statePipeline?.receipt?.status || '');
      if (['complete', 'not_required'].includes(status) || (status === 'partial' && seedHistory?.provenance?.statePipeline?.receipt?.completedAt)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const seedStateStatus = String(seedHistory?.provenance?.statePipeline?.receipt?.status || '');
    const seedStateReceipt = seedHistory?.provenance?.statePipeline?.receipt || null;
    const seedReceiptSettled = ['complete', 'not_required'].includes(seedStateStatus)
      || (seedStateStatus === 'partial' && typeof seedStateReceipt?.completedAt === 'string' && !!seedStateReceipt.completedAt);
    assert.ok(seedReceiptSettled,
      `seed public History receipt settles before synthetic manifest writes: ${seedStateStatus || 'missing'}`);
    let lastStableManifest = await api.debugPhaseDReadStoredManifest(), stableManifestChecks = 0;
    for (let attempt = 0; attempt < 30 && stableManifestChecks < 10; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const next = await api.debugPhaseDReadStoredManifest();
      stableManifestChecks = JSON.stringify(next) === JSON.stringify(lastStableManifest) ? stableManifestChecks + 1 : 0;
      lastStableManifest = next;
    }
    assert.ok(stableManifestChecks >= 10, `seed public receipt has a stable manifest for ten consecutive 10ms checks`);
    const settledSeedManifestDigest = api.debugPhaseDHash(lastStableManifest);
    console.log(JSON.stringify({ record: 'candidate_context_seed_settled', statePipelineStatus: seedStateStatus,
      statePipelineCompletedAt: seedStateReceipt?.completedAt || null, statePipelineReceiptStatusIsPass: ['complete','not_required'].includes(seedStateStatus),
      stableManifestChecks, manifestDigest: settledSeedManifestDigest, publicReceiptDigest: seedStateReceipt?.receiptDigest || '' }));
    const seedRows = seedEvidence.rows;
    const scopeKey = initialManifest.scopeKey;
    const allRefs = [seedRef];
    const results = [], setupStarted = performance.now();
    let chatSetupElapsedMs = 0, canonicalSetupElapsedMs = 0;
    const measureAtCount = async count => {
      const nextRefs = allRefs.slice(0, count);
      const writtenManifest = await api.debugPhaseDWriteManifestRefs(nextRefs);
      const storedImmediatelyAfterWrite = await api.debugPhaseDReadStoredManifest();
      const productImmediatelyAfterWrite = await api.debugPhaseDReadManifest();
      console.log(JSON.stringify({ record: 'candidate_context_manifest_write', count,
        returnedRefs: Object.keys(writtenManifest?.memories || {}).length,
        storedRefs: Object.keys(storedImmediatelyAfterWrite?.memories || {}).length,
        productRefs: Object.keys(productImmediatelyAfterWrite?.memories || {}).length,
        storedManifestDigest: api.debugPhaseDHash(storedImmediatelyAfterWrite),
        storedManifestRefIdentity: manifestRefIdentity(api, storedImmediatelyAfterWrite) }));
      if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'manifest_write_complete',atMs:performance.now()-setupStarted}));
      const start = count * BATCH_SIZE + 1;
      const candidateRows = sourceRowsForBatch(start, seedRows), candidateBatch = batchForRows(candidateRows);
      const chatSetupStarted = performance.now();
      appendSourceRowsToChat(f, candidateRows);
      chatSetupElapsedMs += performance.now() - chatSetupStarted;
      const expectedMessageCount = 2 * (count * BATCH_SIZE + BATCH_SIZE);
      assert.equal(f.chat.message.length, expectedMessageCount, `${count}: host transcript has the expected U+A message count`);
      assert.equal(new Set(f.chat.message.map(message => String(message.chatId || ''))).size, expectedMessageCount,
        `${count}: host transcript has unique message ids after adding the live candidate batch`);
      if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'post_write_stability_barrier_start',atMs:performance.now()-setupStarted}));
      const settledManifest = await waitForStableManifest(api, `${count}`,manifestKey);
      if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'post_write_stability_barrier_complete',atMs:performance.now()-setupStarted}));
      const manifestBeforeParity = settledManifest.manifest;
      const normalizationParity = count === 100
        ? await assertManifestReadParity(api, storage, manifestKey, manifestBeforeParity, expectedMessageCount / 2)
        : null;
      if (GUARD_PROBE && count === 100) {
        const bootstrap = await api.debugPhaseDBootstrapBranchGuard();
        assert.equal(bootstrap.branchGuard.status, 'bootstrap_pending', 'legacy bootstrap reconciliation remains fail-closed and pending');
        assert.equal(bootstrap.committedStarts.length, count, 'all synthetic committed refs still exist after product reconciliation');
        assert.equal(bootstrap.recallEligibleStarts.length, 1, 'product bootstrap verifies only the latest existing canonical batch; the live candidate batch has no ref yet');
        assert.deepEqual(bootstrap.branchGuard.verifiedStarts, bootstrap.recallEligibleStarts,
          'recall eligibility is exactly the product reconciliation verifiedStarts');
        const probeBasis = await api.debugPhaseDPrepareCandidateBasis(candidateBatch);
        const bootstrapManifest = await api.debugPhaseDReadStoredManifest();
        const lifecycleAudit = [];
        for (const ref of Object.values(bootstrapManifest.memories)) {
          const memory = parse(await storage.getItem(ref.key));
          const fact = memory?.canonicalArtifact?.facts?.find(row => row.claimKind === 'thread');
          lifecycleAudit.push({ start: Number(ref.turnRange.start), status: ref.status,
            lifecycleId: fact?.values?.thread?.lifecycleId || null, linkStatus: fact?.values?.thread?.linkStatus || null,
            domain: fact?.domain || null, certainty: fact?.certainty || null, temporalRole: fact?.temporalRole || null });
        }
        const probe = await api.debugPhaseDBuildCandidateFromBasis(probeBasis, candidateBatch);
        assert.equal(probe.error, undefined, `branch-guard bootstrap candidate preparation succeeds: ${JSON.stringify(probe.error || {})}`);
        const verifiedStarts = new Set(bootstrap.recallEligibleStarts);
        const candidateStarts = Array.from(probe.candidates, candidate => Number(candidate.ref?.turnRange?.start));
        const unverifiedCandidateStarts = candidateStarts.filter(startTurn => !verifiedStarts.has(startTurn));
        console.log(JSON.stringify({ record: 'candidate_context_bootstrap_guard_probe',
          guardStatus: bootstrap.branchGuard.status, verifiedStarts: bootstrap.branchGuard.verifiedStarts,
          committedRefCount: bootstrap.committedStarts.length, recallEligibleRefCount: bootstrap.recallEligibleStarts.length,
          lifecycleAuditCount: lifecycleAudit.length, distinctLifecycleIds: new Set(lifecycleAudit.map(row => row.lifecycleId)).size,
          lifecycleAudit: lifecycleAudit.slice(0,3), candidateCount: candidateStarts.length, unverifiedCandidateStarts,
          candidateTargetsFiltered: probe.diagnostics?.candidateTargetsFiltered ?? null,
          candidateBranchGuardStatus: probe.diagnostics?.branchGuardStatus || null,
          candidateContextPartial: probe.diagnostics?.partial === true,
          candidatePartialReasons: probe.diagnostics?.partialReasons || [],
          coverageWarningPresent: /THREAD CANDIDATE COVERAGE INCOMPLETE/.test(probe.block) }));
        assert.deepEqual(unverifiedCandidateStarts, [],
          `candidate aliases must not expose bootstrap-unverified refs (${JSON.stringify({candidateStarts,verifiedStarts:[...verifiedStarts]})})`);
        assert.deepEqual(candidateStarts, Array.from(bootstrap.recallEligibleStarts),
          'the product-verified tail candidate remains exposed as a positive control');
        assert.equal(probe.diagnostics?.candidateTargetsFiltered, count - bootstrap.recallEligibleStarts.length,
          'unverified current refs are excluded from target aliases while still scanned');
        assert.equal(probe.diagnostics?.branchGuardStatus, 'bootstrap_pending',
          'diagnostics identify the guard state that filtered targets');
        assert.equal(probe.diagnostics?.partial, true,
          'bootstrap filtering is reported as incomplete context, not as an empty historical index');
        assert.ok(probe.diagnostics?.partialReasons?.includes('branch_guard_pending'),
          'the incomplete reason identifies bootstrap guard verification');
        assert.match(probe.block, /THREAD CANDIDATE COVERAGE INCOMPLETE/,
          'the provider context states that a missing alias is not evidence of absence or newness');
        const verifiedCandidate = probe.candidates[0];
        const verifiedCandidateIndex = nextRefs.findIndex(ref => ref.memoryId === verifiedCandidate?.ref?.memoryId);
        assert.ok(verifiedCandidateIndex >= 0, 'verified tail alias maps to its exact canonical ref');
        const verifiedExpectedLineage = await api.debugPhaseDExpectedLineageDigest(nextRefs.slice(0, verifiedCandidateIndex + 1));
        assert.equal(verifiedCandidate.lineageDigest, verifiedExpectedLineage,
          'verified tail alias keeps the exact full canonical prefix lineage proof');
        await api.debugPhaseDSetReadyBranchGuard();
      }
      const basisStarted = performance.now();
      const basis = await api.debugPhaseDPrepareCandidateBasis(candidateBatch);
      const basisPreparationElapsedMs = performance.now() - basisStarted;
      if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'candidate_basis_preparation_complete',atMs:performance.now()-setupStarted,elapsedMs:basisPreparationElapsedMs}));
      const manifestBeforeRecheck = await api.debugPhaseDReadStoredManifest();
      const manifestRecheck = count === 100
        ? await assertCandidateManifestRecheck(api, manifestKey, manifestBeforeRecheck, basis, candidateBatch)
        : null;
      const branchGuardRecheck = count === 100
        ? await assertCandidateUsesLatestBranchGuard(api, manifestKey, manifestBeforeRecheck, basis, candidateBatch)
        : null;
      let sourceMutationProbe = null;
      if (count === 100) {
        const staleTarget=f.chat.message[0], originalText=staleTarget.data;
        const changedText=`${originalText[0]==='X'?'Y':'X'}${originalText.slice(1)}`;
        const controller=new AbortController();let mutated=false;
        controller.signal.__phaseDPairBuildYield=()=>{if(mutated)return;mutated=true;staleTarget.data=changedText;};
        const cacheBefore=await api.debugPhaseDPairRevisionCacheSnapshot();
        const manifestBytesBefore=JSON.stringify(await api.debugPhaseDReadStoredManifest());
        const manifestRevisionBefore=await api.debugPhaseDManifestRevision();
        let staleResult;
        try { staleResult=await api.debugPhaseDBuildCandidateFromBasis(basis,candidateBatch,controller.signal); }
        finally { staleTarget.data=originalText; }
        const cacheAfter=await api.debugPhaseDPairRevisionCacheSnapshot();
        const manifestBytesAfter=JSON.stringify(await api.debugPhaseDReadStoredManifest());
        const manifestRevisionAfter=await api.debugPhaseDManifestRevision();
        assert.equal(mutated,true,'same-object/same-length source edit is injected during candidate pair-count yield');
        assert.equal(staleResult.error?.message,'UNIFIED_THREAD_CANDIDATE_SOURCE_CHANGED',
          'candidate builder rejects a source edit during cooperative counting');
        assert.equal(staleResult.diagnostics?.refsScanned,0,'stale source is rejected before canonical ref scanning');
        assert.deepEqual(cacheAfter,cacheBefore,'stale source rejection leaves shared pair revision cache untouched');
        assert.equal(manifestBytesAfter,manifestBytesBefore,'stale source rejection does not mutate manifest bytes');
        assert.equal(manifestRevisionAfter,manifestRevisionBefore,'stale source rejection does not change manifest/CAS revision');
        sourceMutationProbe={error:staleResult.error,refsScanned:staleResult.diagnostics?.refsScanned,
          mutationSameLength:changedText.length===originalText.length,sharedPairCacheUnchanged:true,
          manifestBytesUnchanged:manifestBytesAfter===manifestBytesBefore,manifestRevisionBefore,manifestRevisionAfter};
        console.log(JSON.stringify({record:'candidate_context_same_id_same_length_stale_source',count,...sourceMutationProbe}));
      }
      const setup = { totalElapsedMs: performance.now() - setupStarted,
        canonicalStorageElapsedMs: canonicalSetupElapsedMs, chatAppendElapsedMs: chatSetupElapsedMs,
        candidateBasisPreparationElapsedMs: basisPreparationElapsedMs,
        postTranscriptManifestStableChecks: settledManifest.stableChecks,
        sourcePairsInHostChat: count * BATCH_SIZE + BATCH_SIZE };
      for (const measurement of ['first-measurement', 'repeated-measurement']) {
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'measurement_iteration_start',measurement,atMs:performance.now()-setupStarted}));
        const preReadyManifest = await api.debugPhaseDReadStoredManifest();
        const preReadyRevision = await api.debugPhaseDManifestRevision();
        let stageStartedAt=performance.now();
        const readyManifest = await api.debugPhaseDSetReadyBranchGuard();
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'ready_branch_guard_complete',measurement,atMs:performance.now()-setupStarted,elapsedMs:performance.now()-stageStartedAt}));
        const readyStorageDiagnostic = count===100 ? await api.debugPhaseDManifestStorageDiagnostic() : null;
        const postReadyManifest = await api.debugPhaseDReadStoredManifest();
        const postReadyRevision = await api.debugPhaseDManifestRevision();
        stageStartedAt=performance.now();
        const expectedCurrentSignatures = await api.debugPhaseDExpectedBranchSignatures((count + 1) * BATCH_SIZE);
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'expected_current_signatures_complete',measurement,atMs:performance.now()-setupStarted,elapsedMs:performance.now()-stageStartedAt}));
        if (readyStorageDiagnostic) console.log(JSON.stringify({record:'candidate_context_ready_guard_storage_diagnostic',
          key:readyStorageDiagnostic.key,revisionBeforeReady:preReadyRevision,revisionAfterReady:postReadyRevision,
          diagnosticRevisionRange:[readyStorageDiagnostic.revisionBeforeRaw,readyStorageDiagnostic.revisionAfterRaw,readyStorageDiagnostic.revisionBeforeDecoded,readyStorageDiagnostic.revisionAfterDecoded],
          rawBytes:readyStorageDiagnostic.rawBytes,rawDigest:readyStorageDiagnostic.rawDigest,rawParsedDigest:readyStorageDiagnostic.rawParsedDigest,
          decodedDigest:readyStorageDiagnostic.decodedDigest,rawParsedDecodedEqual:readyStorageDiagnostic.rawParsedDecodedEqual,
          rawSignatureCount:readyStorageDiagnostic.rawSignatureCount,decodedSignatureCount:readyStorageDiagnostic.decodedSignatureCount,
          firstRawDecodedSignatureDifference:firstArrayDifference(readyStorageDiagnostic.rawSignatures,readyStorageDiagnostic.decodedSignatures),
          firstRawExpectedSignatureDifference:firstArrayDifference(readyStorageDiagnostic.rawSignatures,expectedCurrentSignatures),
          firstDecodedExpectedSignatureDifference:firstArrayDifference(readyStorageDiagnostic.decodedSignatures,expectedCurrentSignatures)}));
        assert.deepEqual(readyManifest.branchGuard?.batchSignatures, expectedCurrentSignatures,
          `${count}: branch reconciliation baseline includes exact host signatures through the live candidate batch`);
        const readyFrontiers = readyManifest.frontiers || {};
        assert.equal(Number(readyFrontiers.observedTurn), (count + 1) * BATCH_SIZE,
          `${count}: branch reconciliation baseline observes the current candidate batch`);
        const rawBeforeLoadRead = JSON.stringify(postReadyManifest);
        const revisionBeforeLoadRead = postReadyRevision;
        stageStartedAt=performance.now();
        const loadedManifestBeforeMeasure = await api.debugPhaseDReadManifest();
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'load_manifest_read_complete',measurement,atMs:performance.now()-setupStarted,elapsedMs:performance.now()-stageStartedAt}));
        const loadedRefsBeforeMeasure = Object.keys(loadedManifestBeforeMeasure?.memories || {}).length;
        const rawAfterLoadRead = JSON.stringify(await api.debugPhaseDReadStoredManifest());
        const revisionAfterLoadRead = await api.debugPhaseDManifestRevision();
        assert.equal(rawAfterLoadRead, rawBeforeLoadRead,
          `${count}: loadManifest fixture read leaves raw stored bytes unchanged before baseline`);
        assert.equal(revisionAfterLoadRead, revisionBeforeLoadRead,
          `${count}: loadManifest fixture read leaves manifest/CAS revision unchanged before baseline`);
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'pre_measurement_stability_barrier_start',measurement,atMs:performance.now()-setupStarted}));
        const settledBeforeMeasure = await waitForStableManifest(api, `${count}: pre-${measurement} loadManifest read`,manifestKey);
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'pre_measurement_stability_barrier_complete',measurement,atMs:performance.now()-setupStarted}));
        const manifestBeforeMeasure = settledBeforeMeasure.manifest;
        const storedRefsBeforeMeasure = Object.keys(manifestBeforeMeasure?.memories || {}).length;
        const canonicalJobStatusBeforeMeasure = await api.getCanonicalJobStatus({});
        const canonicalJobActive = canonicalJobStatusBeforeMeasure?.cancellable === true
          || ['queued', 'running', 'cancel_requested', 'cancelling'].includes(String(canonicalJobStatusBeforeMeasure?.state || ''));
        assert.equal(canonicalJobActive, false,
          `${count}: no canonical job remains active before the candidate measurement (${JSON.stringify(canonicalJobStatusBeforeMeasure)})`);
        assert.equal(Number(manifestBeforeMeasure?.frontiers?.observedTurn), (count + 1) * BATCH_SIZE,
          `${count}: stored baseline frontier matches the current host transcript after normalization`);
        const baselineSignatureDifference=firstArrayDifference(manifestBeforeMeasure?.branchGuard?.batchSignatures,expectedCurrentSignatures);
        if(baselineSignatureDifference&&count===100) console.log(JSON.stringify({record:'candidate_context_stored_baseline_signature_mismatch',
          measurement,manifestRevision:manifestRevisionBeforeMeasure,stableChecks:settledBeforeMeasure.stableChecks,
          branchGuardStatus:manifestBeforeMeasure?.branchGuard?.status,observedTurn:manifestBeforeMeasure?.frontiers?.observedTurn,
          actualSignatureCount:manifestBeforeMeasure?.branchGuard?.batchSignatures?.length||0,expectedSignatureCount:expectedCurrentSignatures.length,
          firstDifference:baselineSignatureDifference,readyStorageDiagnostic:readyStorageDiagnostic?{rawDigest:readyStorageDiagnostic.rawDigest,
            decodedDigest:readyStorageDiagnostic.decodedDigest,rawParsedDecodedEqual:readyStorageDiagnostic.rawParsedDecodedEqual,
            rawFirstDifference:firstArrayDifference(readyStorageDiagnostic.rawSignatures,expectedCurrentSignatures),
            decodedFirstDifference:firstArrayDifference(readyStorageDiagnostic.decodedSignatures,expectedCurrentSignatures)}:null}));
        assert.deepEqual(manifestBeforeMeasure?.branchGuard?.batchSignatures, expectedCurrentSignatures,
          `${count}: stored baseline signatures stay aligned with all current complete host batches`);
        assert.equal(manifestBeforeMeasure?.branchGuard?.status, 'ready',
          `${count}: baseline branch reconciliation is complete and ready before candidate measurement`);
        const manifestBeforeMeasureDigest = api.debugPhaseDHash(manifestBeforeMeasure);
        const manifestBeforeMeasureBytes = JSON.stringify(manifestBeforeMeasure);
        const manifestRevisionBeforeMeasure = await api.debugPhaseDManifestRevision();
        assert.equal(manifestRevisionBeforeMeasure, settledBeforeMeasure.revision,
          `${count}: stored revision remains stable through pre-measurement barrier`);
        console.log(JSON.stringify({ record: 'candidate_context_pre_measurement_barrier', count, measurement,
          seedToReadyMutation: { rawBytesChanged: JSON.stringify(preReadyManifest) !== JSON.stringify(postReadyManifest),
            revisionBefore: preReadyRevision, revisionAfter: postReadyRevision },
          loadManifestReadPreservedBytes: rawAfterLoadRead === rawBeforeLoadRead,
          loadManifestReadPreservedRevision: revisionAfterLoadRead === revisionBeforeLoadRead,
          observedTurn: manifestBeforeMeasure.frontiers?.observedTurn,
          branchGuardStatus: manifestBeforeMeasure.branchGuard?.status,
          branchSignatureCount: manifestBeforeMeasure.branchGuard?.batchSignatures?.length,
          expectedCurrentSignatureCount: expectedCurrentSignatures.length,
          exactCurrentSignatures: JSON.stringify(manifestBeforeMeasure.branchGuard?.batchSignatures) === JSON.stringify(expectedCurrentSignatures),
          canonicalJobState: canonicalJobStatusBeforeMeasure?.state || null,
          canonicalJobCompletedAt: canonicalJobStatusBeforeMeasure?.completedAt || null,
          manifestRevision: manifestRevisionBeforeMeasure, stableChecks: settledBeforeMeasure.stableChecks }));
        const storedManifest = await api.debugPhaseDReadStoredManifest();
        const storedCount = Object.keys(storedManifest?.memories || {}).length;
        assert.equal(storedCount, count, `${count}: durable logical manifest ref count before ${measurement}`);
        assert.equal(storedRefsBeforeMeasure, count, `${count}: stored logical manifest ref count before ${measurement}`);
        assert.equal(loadedRefsBeforeMeasure, count, `${count}: product loadManifest ref count before ${measurement}`);
        assert.equal(manifestBeforeMeasure?.branchGuard?.status, 'ready', `${count}: every synthetic canonical source batch has a fresh branch-guard signature`);
        assert.ok(manifestBeforeMeasure?.branchGuard?.batchSignatures?.length >= count
          &&manifestBeforeMeasure?.branchGuard?.batchSignatures?.length <= count+1,
          `${count}: branch guard covers committed batches and may include the live candidate batch`);
        stageStartedAt=performance.now();
        const expectedCommittedSignatures = await api.debugPhaseDExpectedBranchSignatures(count * BATCH_SIZE);
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'expected_committed_signatures_complete',measurement,atMs:performance.now()-setupStarted,elapsedMs:performance.now()-stageStartedAt}));
        assert.deepEqual(manifestBeforeMeasure.branchGuard.batchSignatures.slice(0,count), expectedCommittedSignatures,
          `${count}: each committed synthetic batch signature matches its exact host source rows`);
        const expectedCanonicalRanges = Array.from({length:count},(_,index)=>({start:index*BATCH_SIZE+1,end:(index+1)*BATCH_SIZE}));
        assert.deepEqual(Object.values(manifestBeforeMeasure.memories).map(ref=>({start:Number(ref.turnRange.start),end:Number(ref.turnRange.end)})),
          expectedCanonicalRanges, `${count}: canonical synthetic refs form the exact contiguous 5-turn ranges`);
        assert.equal(manifestBeforeMeasure.frontiers.contiguousCommittedTurn,count*BATCH_SIZE,`${count}: contiguous frontier follows canonical refs`);
        assert.equal(manifestBeforeMeasure.frontiers.contiguousMemoryCount,count,`${count}: frontier ref count matches canonical refs`);
        assert.ok([0,count*BATCH_SIZE+1].includes(Number(manifestBeforeMeasure.frontiers.firstGapStartTurn||0)),
          `${count}: first gap is either absent or exactly the uncommitted candidate start`);
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'candidate_consumer_start',measurement,atMs:performance.now()-setupStarted}));
        const measured = await measureCandidate(api, basis, batchForRows(candidateRows));
        if (count===10000) console.log(JSON.stringify({record:'candidate_context_setup_stage',stage:'candidate_consumer_complete',measurement,
          atMs:performance.now()-setupStarted,consumerElapsedMs:measured.elapsedMs,eventLoopMaxMs:measured.eventLoopDelay.maxMs,
          preScan:measured.result?.diagnostics?.testPreScanStagesMs||null}));
        const manifestAfterMeasure = await api.debugPhaseDReadStoredManifest();
        const manifestAfterMeasureDigest = api.debugPhaseDHash(manifestAfterMeasure);
        const manifestAfterMeasureBytes = JSON.stringify(manifestAfterMeasure);
        const manifestRevisionAfterMeasure = await api.debugPhaseDManifestRevision();
        const refIdentityBefore = manifestRefIdentity(api, manifestBeforeMeasure);
        const refIdentityAfter = manifestRefIdentity(api, manifestAfterMeasure);
        const changedRefs = changedManifestRefs(api, manifestBeforeMeasure, manifestAfterMeasure);
        const manifestAfterMeasureCount = Object.keys(manifestAfterMeasure?.memories || {}).length;
        const loadedManifestAfterMeasure = await api.debugPhaseDReadManifest();
        const loadedRefsAfterMeasure = Object.keys(loadedManifestAfterMeasure?.memories || {}).length;
        const storedRefsAfterMeasure = Object.keys(manifestAfterMeasure?.memories || {}).length;
        const manifestSnapshot = { storedManifestDigestBefore: manifestBeforeMeasureDigest, storedManifestDigestAfter: manifestAfterMeasureDigest,
          manifestRawBytesUnchanged: manifestBeforeMeasureBytes === manifestAfterMeasureBytes,
          manifestRevisionBefore: manifestRevisionBeforeMeasure, manifestRevisionAfter: manifestRevisionAfterMeasure,
          manifestRefIdentityBefore: refIdentityBefore, manifestRefIdentityAfter: refIdentityAfter, changedRefs,
          frontiersBefore: manifestBeforeMeasure?.frontiers || null, frontiersAfter: manifestAfterMeasure?.frontiers || null,
          storedRefsBefore: storedCount, storedRefsAfter: storedRefsAfterMeasure,
          productLoadedRefsBefore: loadedRefsBeforeMeasure, productLoadedRefsAfter: loadedRefsAfterMeasure };
        console.log(JSON.stringify({ record: 'candidate_context_manifest_snapshot', count, measurement, ...manifestSnapshot }));
        assert.equal(refIdentityAfter, refIdentityBefore,
          `${count}: candidate preparation leaves canonical ref identity unchanged across ${measurement}: ${JSON.stringify(manifestSnapshot)}`);
        assert.equal(manifestAfterMeasureBytes, manifestBeforeMeasureBytes,
          `${count}: candidate preparation leaves stored manifest bytes unchanged across ${measurement}`);
        assert.equal(manifestRevisionAfterMeasure, manifestRevisionBeforeMeasure,
          `${count}: candidate preparation leaves the in-process manifest/CAS revision unchanged`);
        assert.equal(loadedRefsAfterMeasure, count,
          `${count}: product loadManifest preserves ref count across ${measurement}: ${JSON.stringify(manifestSnapshot)}`);
        const value = measured.result;
        assert.equal(value.error, undefined, `${count}: candidate preparation completed ${JSON.stringify(value.error || {})}`);
        assert.equal(value.diagnostics.refsAvailable, count, `${count}: candidate refsAvailable is exact (storedManifest=${storedCount})`);
        assert.equal(value.diagnostics.refsScanned, count, `${count}: candidate refsScanned is exact`);
        assert.ok(value.diagnostics.factsInspected >= count, `${count}: candidate facts inspected is recorded`);
        assert.ok(value.diagnostics.visibleCount <= 40, `${count}: visible candidates stay bounded at forty`);
        assert.equal(value.diagnostics.lineageDigestsComputed, value.diagnostics.visibleCount,
          `${count}: lineage prefix digests are computed only for visible candidates`);
        assert.equal(value.diagnostics.partial, false, `${count}: coherent synthetic chain is not marked partial`);
        if (count === 100 && measurement === 'first-measurement') {
          assert.ok(value.candidates.length > 0, '100-ref chain exposes a representative candidate');
          for (const candidate of value.candidates) {
            const candidateIndex = nextRefs.findIndex(ref => ref.memoryId === candidate.ref?.memoryId);
            assert.ok(candidateIndex >= 0, 'candidate points to one exact canonical ref');
            const expectedLineageDigest = await api.debugPhaseDExpectedLineageDigest(nextRefs.slice(0, candidateIndex + 1));
            assert.equal(candidate.lineageDigest, expectedLineageDigest,
              'deferred candidate lineage digest matches the original exact canonical prefix');
          }
        }
        const row = { count, measurement, setup, normalizationParity, manifestRecheck, branchGuardRecheck, manifestStoredDigestBefore: manifestBeforeMeasureDigest,
          manifestStoredDigestAfter: manifestAfterMeasureDigest, manifestRefIdentityBefore: refIdentityBefore,
          manifestRefIdentityAfter: refIdentityAfter, manifestChangedRefCount: changedRefs.length,
          manifestRawBytesUnchanged: manifestAfterMeasureBytes === manifestBeforeMeasureBytes,
          preMeasurementManifestStableChecks: settledBeforeMeasure.stableChecks,
          manifestRevisionBefore: manifestRevisionBeforeMeasure, manifestRevisionAfter: manifestRevisionAfterMeasure,
          manifestFrontiersBefore: manifestBeforeMeasure?.frontiers || null,
          manifestFrontiersAfter: manifestAfterMeasure?.frontiers || null,
          manifestRefCountAfter: manifestAfterMeasureCount,
          refsAvailable: value.diagnostics.refsAvailable,
          refsScanned: value.diagnostics.refsScanned, factsInspected: value.diagnostics.factsInspected,
          visibleCount: value.diagnostics.visibleCount, consumerElapsedMs: measured.elapsedMs,
          manifestStageTimingsMs: measured.stageTimingsMs,
          diagnosticsElapsedMs: value.diagnostics.elapsedMs, testPreScanElapsedMs: value.diagnostics.testPreScanElapsedMs,
          testScanElapsedMs: value.diagnostics.testScanElapsedMs,
          testMemoryReadElapsedMs: value.diagnostics.testMemoryReadElapsedMs ?? null,
          testMemoryReadMaxMs: value.diagnostics.testMemoryReadMaxMs ?? null,
          testEvidenceReadElapsedMs: value.diagnostics.testEvidenceReadElapsedMs ?? null,
          testEvidenceReadMaxMs: value.diagnostics.testEvidenceReadMaxMs ?? null,
          testPreScanStagesMs: Object.fromEntries(['testContextResolveElapsedMs','testBasisCheckElapsedMs','testPairBuildElapsedMs','testManifestNormalizationElapsedMs','testManifestIdentityRecheckElapsedMs','testPairSourceFreshnessElapsedMs','testRefSelectionElapsedMs']
            .map(key => [key, value.diagnostics[key] ?? null])), cancelObserved: value.diagnostics.cancelObserved,
          sourceMutationProbe,
          memory: measured.memory, eventLoopDelay: measured.eventLoopDelay };
        results.push(row);
        console.log(JSON.stringify({ record: 'candidate_context_scale_progress', ...row }));
      }
      if (count === Math.max(...COUNTS)) {
        const cancellation = await measureCandidateCancellation(api, basis, batchForRows(candidateRows), count);
        results.push({ count, cancellation });
        console.log(JSON.stringify({ record: 'candidate_context_scale_cancellation', count, ...cancellation }));
        const pairBuildCancellation = await measureCancellationDuringPairBuild(api, basis, batchForRows(candidateRows), count);
        results.push({ count, pairBuildCancellation });
        console.log(JSON.stringify({ record: 'candidate_context_pair_build_cancellation', count, ...pairBuildCancellation }));
        const manifestLoadCancellation = await measureCancellationDuringManifestLoad(api, basis, batchForRows(candidateRows), count);
        results.push({ count, manifestLoadCancellation });
        console.log(JSON.stringify({ record: 'candidate_context_manifest_processing_cancellation', count, ...manifestLoadCancellation }));
        const manifestNormalizationCancellation = await measureCancellationDuringManifestNormalization(api, basis, batchForRows(candidateRows), count);
        results.push({ count, manifestNormalizationCancellation });
        console.log(JSON.stringify({ record: 'candidate_context_manifest_normalization_cancellation', count, ...manifestNormalizationCancellation }));
        if(count>=10000){
          const sourceFreshnessCancellation = await measureCancellationDuringSourceFreshness(api, basis, batchForRows(candidateRows), count);
          results.push({ count, sourceFreshnessCancellation });
        }
      }
    };
    for (let index = 1; index < Math.max(...COUNTS); index += 1) {
      const start = 1 + index * BATCH_SIZE, end = start + BATCH_SIZE - 1;
      const rows = sourceRowsForBatch(start, seedRows), batch = batchForRows(rows);
      const storageSetupStarted = performance.now();
      const sourceDigest = api.debugPhaseDSourceDigest(batch);
      const identity = branchContentHash(JSON.stringify([scopeKey, 'main', batch.map(pair => [pair.user.chatId, pair.assistant.chatId])]));
      const sourceEvidenceRef = await api.debugPhaseDSourceEvidencePut(scopeKey,
        { key: String(start), start, end, sourceDigest, identity }, rows);
      const chatSetupStarted = performance.now();
      appendSourceRowsToChat(f, rows);
      const hostAppendElapsedMs = performance.now() - chatSetupStarted;
      chatSetupElapsedMs += hostAppendElapsedMs;
      const canonicalArtifact = adjustArtifact(seedMemory.canonicalArtifact, start - 1);
      if (GUARD_PROBE) {
        const threadFact = canonicalArtifact.facts.find(fact => fact.claimKind === 'thread');
        assert.ok(threadFact?.values?.thread, `${start}: branch-guard probe thread fact exists`);
        const seedThread = seedMemory.canonicalArtifact.facts.find(fact => fact.claimKind === 'thread');
        threadFact.values.thread.participantIds = clone(seedThread?.values?.thread?.participantIds || []);
        threadFact.values.thread.lifecycleId = `d4_lifecycle_${start}`;
        threadFact.values.thread.linkStatus = 'new';
        delete threadFact.values.thread.linkTarget;
        delete threadFact.values.thread.linkPendingReason;
        delete threadFact.values.thread.link;
      }
      const validation = api.debugPhaseDValidateArtifact(canonicalArtifact, batch);
      assert.equal(validation.ok, true, `${start}: synthetic artifact validation ${JSON.stringify(validation)}`);
      const memoryKey = `libra:v1:scope:${scopeKey}:memory:${start}:r1`;
      const memoryId = `mem_d4_${String(start).padStart(6, '0')}`;
      const memory = { ...clone(seedMemory), memoryId, key: memoryKey, scopeKey, revision: 1,
        sourceDigest, sourcePairs: batch.map(pair => ({ turn: pair.turn, userChatId: pair.user.chatId, assistantChatId: pair.assistant.chatId })),
        sourceEvidenceRef, turnRange: { start, end }, artifactSchema: 'libra.canonical_artifact.v5',
        canonicalArtifact, artifactDigest: api.debugPhaseDHash(canonicalArtifact),
        artifactValidation: { ...clone(seedMemory.artifactValidation || {}), sourceDigest },
        text: api.debugPhaseDRender(canonicalArtifact), status: 'committed',
        unifiedOrigin: { scopeKey, memoryId, revision: 1, sourceDigest, artifactDigest: api.debugPhaseDHash(canonicalArtifact), turnRange: { start, end } },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      if (start === 6) {
        const storedEvidence = parse(await storage.getItem(sourceEvidenceRef.key));
        const projected = storedEvidence?.rows?.map(row => ({turn:row.turn,user:{chatId:row.userMessageId,text:row.userText},assistant:{chatId:row.assistantMessageId,text:row.assistantText}}));
        console.log(JSON.stringify({debugSyntheticRead:{sourceRef:sourceEvidenceRef,recordBinding:storedEvidence?.binding,
          sourceDigest:api.debugPhaseDSourceDigest(batch),recordDigest:storedEvidence?.binding?.sourceDigest,
          projectedDigest:projected ? api.debugPhaseDSourceDigest(projected) : '',memoryDigest:memory.sourceDigest,
          sourcePairsMatch:projected ? api.debugPhaseDHash(projected.map(pair => ({turn:pair.turn,userChatId:pair.user.chatId,assistantChatId:pair.assistant.chatId}))) === api.debugPhaseDHash(memory.sourcePairs) : false,
          renderMatch:memory.text === api.debugPhaseDRender(memory.canonicalArtifact), validation}}));
      }
      await api.debugPhaseDWriteMemory(memoryKey, memory);
      canonicalSetupElapsedMs += performance.now() - storageSetupStarted - hostAppendElapsedMs;
      const ref = { ...clone(seedRef), memoryId, key: memoryKey, revision: 1, sourceDigest,
        status: 'committed', artifactSchema: 'libra.canonical_artifact.v5', artifactDigest: memory.artifactDigest,
        turnRange: { start, end }, sourceEvidenceRef, summary: seedRef.summary, createdAt: memory.createdAt, updatedAt: memory.updatedAt };
      allRefs.push(ref);
      if (SETUP_PROGRESS_COUNTS.has(allRefs.length)) {
        const usage = process.memoryUsage();
        console.log(JSON.stringify({ record: 'candidate_context_setup_progress', refsBuilt: allRefs.length,
          elapsedMs: performance.now() - setupStarted, canonicalStorageElapsedMs: canonicalSetupElapsedMs,
          chatAppendElapsedMs: chatSetupElapsedMs, heapUsedBytes: usage.heapUsed, rssBytes: usage.rss }));
      }
      if (!DIAGNOSTIC_ONLY && COUNTS.includes(allRefs.length)) await measureAtCount(allRefs.length, performance.now() - setupStarted);
    }
    if (DIAGNOSTIC_ONLY) {
      const count=Math.max(...COUNTS), writtenManifest=await api.debugPhaseDWriteManifestRefs(allRefs);
      assert.equal(Object.keys(writtenManifest?.memories || {}).length,count,'diagnostic-only cancellation uses the full coherent manifest');
      const candidateRows=sourceRowsForBatch(count*BATCH_SIZE+1,seedRows),candidateBatch=batchForRows(candidateRows);
      appendSourceRowsToChat(f,candidateRows);
      const expectedMessageCount=2*(count*BATCH_SIZE+BATCH_SIZE);
      assert.equal(f.chat.message.length,expectedMessageCount,'diagnostic-only transcript matches every synthetic source pair');
      const basis=await api.debugPhaseDPrepareCandidateBasis(candidateBatch);
      const cancellation=await measureCandidateCancellation(api,basis,candidateBatch,count);
      const pairBuildCancellation=await measureCancellationDuringPairBuild(api,basis,candidateBatch,count);
      console.log(JSON.stringify({test:'libra_phase_d_candidate_context_scale_synthetic',diagnosticOnly:true,count,
        setupElapsedMs:performance.now()-setupStarted,providerCalls:f.control.calls.length,cancellation,pairBuildCancellation,
        boundary:'test-only diagnostic call measures cancellation pre-scan stages on a coherent 10000-ref actual candidate chain'}));
    }
    console.log(JSON.stringify({
      test: 'libra_phase_d_candidate_context_scale_synthetic', passed: results.length,
      results, providerCalls: f.control.calls.length,
      baselineAndThreshold: { currentSourceRunIsCandidatePreparationBaseline: true,
        compatibleEarlierCandidatePreparationBaseline: false, numericRegressionThreshold: 'not set; one host/process run cannot establish a threshold',
        genericRecallClosureBaseline: 'separate workload and not compared with candidate preparation' },
      gcExposed: typeof global.gc === 'function',
      boundary: 'actual buildContinuityCandidateContext over one valid v5 seed plus coherent stored source-evidence/canonical refs at 100/1000/10000; setup time and consumer time are separate; synthetic storage boundary, no provider repetition or live model'
    }));
  } finally { await snapshot.cleanup(); }
      };

run().catch(error => { console.error(error); process.exitCode = 1; });
