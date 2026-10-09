'use strict';
const { load } = require('./libra_recall_test_runtime.cjs');
const assertions = [];
const check = (name, ok, detail) => assertions.push({name, ok: !!ok, detail});
const entry = (id, patch = {}, text = 'Ariel silvergate memory') => ({
  key: 'lmai_memory::' + id, comment: 'lmai_memory',
  content: '[META:' + JSON.stringify({t: 2, ttl: -1, imp: 8, ent: ['Ariel'], ...patch}) + ']\n' + text
});
(async () => {
  const {api, char, chat, store} = await load();
  const ME = api.MemoryEngine, WL = api.LibraTurnWorldline;
  ME.setTurn(10);
  const fixtures = [
    ['expired', {t: 0, ttl: 1}],
    ['deleted', {hme: {rollbackState: 'candidate_deleted', rollbackTombstone: true}}],
    ['hidden', {hme: {hiddenFromPrompt: true}}],
    ['retracted', {provenanceStatus: 'retracted'}],
    ['retracted_whitespace', {provenanceStatus: ' retracted '}],
    ['superseded', {provenanceStatus: 'superseded'}],
    ['rollback_superseded', {hme: {rollbackState: 'superseded'}}],
    ['stale', {hme: {stale: true}}],
    ['inactive', {hme: {active: false}}],
    ['projection_hidden', {projection:{schema:'libra.memory.projection_pointer.v1',hiddenFromPrompt:true}}],
    ['projection_stale', {projection:{schema:'libra.memory.projection_pointer.v1',stale:true}}],
    ['projection_deleted', {projection:{schema:'libra.memory.projection_pointer.v1',rollbackState:'candidate_deleted'}}]
  ];
  for (const [kind, patch] of fixtures) {
    const item = entry(kind, patch);
    const result = await ME.retrieveMemories('Ariel silvergate', 10, [item], {embeddingAllowed:false}, 4);
    check('API_excludes_' + kind, result.length === 0, result.map(x => x.key));
  }
  for (const [kind,flag] of [['hidden',{hiddenFromPrompt:true}],['stale',{stale:true}],['tombstone',{rollbackTombstone:true}],['deleted',{rollbackState:'candidate_deleted'}]]) {
    const compact=entry('legacy-payload-'+kind,{},JSON.stringify({schema:'libra.memory.compact_turn.v1',summary:'Ariel silvergate PAYLOAD_FLAG_CANARY',turn:2,importance:8,mentionedEntityNames:['Ariel'],hybridRow:flag}));
    if (ME.inspectRecallEligibility) check('legacy_payload_inspector_excludes_'+kind,!ME.inspectRecallEligibility(compact,{currentTurn:10}).eligible);
    check('legacy_payload_API_excludes_'+kind,(await ME.retrieveMemories('Ariel silvergate',10,[compact],{embeddingAllowed:false},4)).length === 0);
  }
  check('common_inspector_available', typeof ME.inspectRecallEligibility === 'function');
  if (ME.inspectRecallEligibility) {
    for (const [kind, patch] of fixtures) check('inspector_excludes_' + kind, !ME.inspectRecallEligibility(entry(kind, patch), {currentTurn:10}).eligible);
    check('legacy_active_allowed', ME.inspectRecallEligibility(entry('active'), {currentTurn:10}).eligible);
    check('TTL_boundary_inclusive', ME.inspectRecallEligibility(entry('boundary', {t:8,ttl:2}), {currentTurn:10}).eligible);
    const signed = await ME.prepareMemory({content:'Ariel silvergate signed canary',importance:8}, 2, [], [], null, {id:'signed-chat'}, 'signed-source', {scopeKey:'signed-scope',sourceHash:'signed-source'});
    check('signed_matching_scope_retained', ME.inspectRecallEligibility(signed,{currentTurn:10,scopeKey:'signed-scope'}).eligible);
    check('signed_foreign_scope_excluded', !ME.inspectRecallEligibility(signed,{currentTurn:10,scopeKey:'foreign-scope'}).eligible);
    check('signed_identity_metadata_tamper_excluded', !ME.inspectRecallEligibility({...signed,content:signed.content.replace('signed-source','forged-source')},{currentTurn:10,scopeKey:'signed-scope'}).eligible);
    check('signed_body_tamper_excluded', !ME.inspectRecallEligibility({...signed,content:signed.content.replace('signed canary','tampered canary')},{currentTurn:10,scopeKey:'signed-scope'}).eligible);
    signed.content=signed.content.replace('signed-source','forged-source');
    check('same_object_identity_tamper_excluded', !ME.inspectRecallEligibility(signed,{currentTurn:10,scopeKey:'signed-scope'}).eligible);
    check('same_object_tamper_not_recalled', (await ME.retrieveMemories('Ariel silvergate',10,[signed],{embeddingAllowed:false,scopeKey:'signed-scope'},4)).length === 0);
    const cached = entry('same-id');
    await ME.retrieveMemories('Ariel silvergate', 10, [cached], {embeddingAllowed:false}, 4);
    check('cached_id_fresh_deletion_seen', !ME.inspectRecallEligibility(entry('same-id', {hme:{rollbackTombstone:true}}), {currentTurn:10}).eligible);
    const duplicate = entry('duplicate');
    check('eligible_duplicates_collapsed', ME.filterRecallEligibleEntries([duplicate, {...duplicate}], {currentTurn:10}).entries.length === 1);
    check('ineligible_duplicate_does_not_shadow_live', ME.filterRecallEligibleEntries([entry('duplicate',{hme:{hiddenFromPrompt:true}}), duplicate], {currentTurn:10}).entries[0] === duplicate);
    const hiddenExact = entry('exact-hidden', {hme:{hiddenFromPrompt:true}});
    const liveExact = entry('exact-live');
    const exactRows = [hiddenExact, liveExact].map(value => ({entry:value,text:'Ariel silvergate memory',accepted:false,meta:{t:2},finalScore:0}));
    const exact = ME.__testExactBackfill([], exactRows, ['silvergate'], 4, {}, 10);
    check('exact_rejected_row_cannot_bypass_protection', exact.length === 1 && exact[0].entry.key === liveExact.key);
    let graphCalls = 0, graphSourceProtected = false;
    const graphRuntime = await load({
      transformCode:code=>code.replace('expandHmeGraphRecallCandidates(filtered, allCandidatesByKey, {', 'globalThis.__eligibilityGraphSource(filtered, allCandidatesByKey, {'),
      globals:{__eligibilityGraphSource:(items, sources)=>{
        graphCalls++;
        graphSourceProtected = !sources.has(hiddenExact.key);
        return {ok:true,entries:[...items,hiddenExact],boostByKey:new Map(),debug:{test:true}};
      }}
    });
    const graphME=graphRuntime.api.MemoryEngine;
    graphME.CONFIG.hmeAssociativeGraphMode='light';
    graphME.CONFIG.hmeGraphMinRecallCandidates=0;
    const graphSelected = await graphME.retrieveMemories('Ariel silvergate',10,[liveExact,hiddenExact],{embeddingAllowed:false},4);
    check('graph_boundary_exercised', graphCalls === 1);
    check('graph_source_map_is_protected', graphSourceProtected);
    check('graph_hidden_row_removed_before_detailed_scoring', graphME.getLastRetrievalDebug().filteredCandidates === 1);
    check('graph_expansion_cannot_reintroduce_hidden', !graphSelected.some(row=>row.key===hiddenExact.key));
    const scope='eligibility-worldline';
    const pair=t=>({pairIndex:t,userText:'u'+t,assistantText:'a'+t});
    await WL.observe(scope,[pair(1),pair(2),pair(3)],{now:1000});
    const exclusion=WL.buildDriftExclusion(scope,[pair(1)]);
    check('ephemeral_drift_excluded', !ME.inspectRecallEligibility(entry('drift'), {currentTurn:10,scopeKey:scope,worldlineState:WL.get(scope),ephemeralDriftExclusion:exclusion}).eligible);
    check('drift_other_scope_preserved', ME.inspectRecallEligibility(entry('other'), {currentTurn:10,scopeKey:'other',ephemeralDriftExclusion:exclusion}).eligible);
    const old=WL.get(scope).nodes.find(n=>n.pairIndex===2 && n.assistantHash);
    await WL.observe(scope,[pair(1),{...pair(2),assistantText:'rerolled'}],{now:2000});
    const state=WL.get(scope), live=state.nodes.find(n=>n.pairIndex===2 && ['active','committed','live'].includes(n.status));
    check('rerolled_variant_excluded', !ME.inspectRecallEligibility(entry('reroll',{vh:old?.assistantHash}), {currentTurn:10,scopeKey:scope,worldlineState:state}).eligible, state.nodes);
    if (live) check('live_variant_retained', ME.inspectRecallEligibility(entry('live',{vh:live.assistantHash}), {currentTurn:10,scopeKey:scope,worldlineState:state}).eligible);
  }
  // Actual beforeRequest surface: never rely on an extracted backfill helper.
  char.name='Ariel';
  const invalid=fixtures.map(([kind,patch])=>entry('surface-'+kind,patch,'Ariel SILVERGATE BLOCKED_'+kind));
  chat.localLore=[entry('surface-live',{},'Ariel SILVERGATE LIVE_SENTINEL'),...invalid];
  chat.bindedPersona='default';
  const canonicalScope=api.LibraDataStorage.scopeKeyFor(char,chat);
  store.set(api.LibraDataStorage.storageKeyFor(canonicalScope),JSON.stringify({scopeKey:canonicalScope,entries:chat.localLore}));
  const messages=[];
  for(let i=1;i<=10;i++){messages.push({role:'user',data:'u'+i},{role:'char',data:'a'+i});}
  chat.message=messages;chat.msgs=messages;
  ME.setTurn(10);
  const backfillContexts=[];
  const originalInspector=ME.inspectRecallEligibility;
  ME.inspectRecallEligibility=(value,context)=>{backfillContexts.push(context);return originalInspector(value,context);};
  const output=await api.libraBeforeRequestReplacer([{role:'user',content:'Ariel SILVERGATE'}],'model');
  const injected=JSON.stringify(output);
  check('beforeRequest_live_canary_injected', injected.includes('LIVE_SENTINEL'), {chars:injected.length});
  check('beforeRequest_backfill_receives_scope_context', backfillContexts.length > 0 && backfillContexts.every(value=>value.scopeKey && value.worldlineScopeKey && Object.prototype.hasOwnProperty.call(value,'worldlineState')));
  for(const [kind] of fixtures)check('beforeRequest_excludes_'+kind, !injected.includes('BLOCKED_'+kind));
  const ok=assertions.every(x=>x.ok);
  console.log(JSON.stringify({ok,assertions},null,2));
  process.exit(ok?0:1);
})().catch(error=>{console.error(error);process.exit(1);});
