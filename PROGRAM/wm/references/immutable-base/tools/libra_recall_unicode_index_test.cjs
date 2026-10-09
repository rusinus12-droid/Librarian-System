'use strict';
const fs=require('fs');
const {load}=require('./libra_recall_test_runtime.cjs');
const assertions=[];
const check=(name,ok,detail)=>assertions.push({name,ok:!!ok,detail});
const clone=value=>JSON.parse(JSON.stringify(value));
const hooks=code=>code.replace('            inspectRecallEligibility,',
  '            __testUnicodeIndex:{extractExactRecallAnchors,getExactAnchorHits,buildHybridScopeIndexFromEntries,reconcileHybridScopeIndexEntries,parseHybridScopeIndexEntry,cacheHybridScopeIndex,getCachedHybridScopeIndex,buildPersistedHybridScopeIndex,queryHybridScopeIndex,cacheHmeGraphIndex,getCachedHmeGraphIndex,HmeDerivedCacheStore},\n            inspectRecallEligibility,');
const entry=(id,text)=>({key:'unicode::'+id,comment:'lmai_memory',content:'[META:'+JSON.stringify({t:2,ttl:-1,imp:8,ent:['アリエル','张伟']})+']\n'+text});
(async()=>{
  const {api,store}=await load({transformCode:hooks});
  const ME=api.MemoryEngine, H=ME.__testUnicodeIndex;
  const examples=[
    ['English','  ARIEL_A-17!!  ','ariel_a 17'],
    ['Korean',' 아리엘, 서울 12 ','아리엘 서울 12'],
    ['Japanese','アリエル 東京','アリエル 東京'],
    ['Chinese','张伟 北京１２','张伟 北京12'],
    ['fullwidth','ＡＲＩＥＬ ｱﾘｴﾙ １２','ariel アリエル 12'],
    ['combining_composable','Cafe\u0301','café'],
    ['combining_noncomposable','q\u0307','q\u0307'],
    ['Indic_marks','नमस्ते','नमस्ते'],
    ['unicode_numbers','١٢٣ 四十二','١٢٣ 四十二'],
    ['mixed','아리엘 Ariel アリエル 张伟 42','아리엘 ariel アリエル 张伟 42'],
    ['punctuation','Ａriel / 東京。北京!','ariel 東京 北京']
  ];
  for(const [kind,input,expected] of examples){
    for(const [lane,normalizer] of [['anchor',ME.normalizeRecallAnchorCached],['scope',ME.normalizeHmeIndexTermCached],['graph',ME.normalizeHmeGraphTokenCached]]){
      const actual=normalizer(input);check(kind+'_'+lane,actual===expected,{actual,expected});
      check(kind+'_'+lane+'_repeat',normalizer(input)===actual);
    }
  }
  const anchors=H.extractExactRecallAnchors('アリエル 東京 张伟 北京');
  check('exact_extractor_keeps_Japanese',anchors.includes('アリエル') && anchors.includes('東京'),anchors);
  check('exact_extractor_keeps_Chinese',anchors.includes('张伟') && anchors.includes('北京'),anchors);
  check('exact_hits_keep_script_distinction',H.getExactAnchorHits(['東京','北京'],'東京で会った').join('|')==='東京');
  const memories=[entry('jp','アリエル 東京 銀の門'),entry('zh','张伟 北京 银色城门')];
  const original=JSON.stringify(memories);
  const fresh=H.buildHybridScopeIndexFromEntries(memories,{scopeKey:'unicode-index',currentTurn:10});
  check('fresh_scope_version',fresh.version>=2,fresh.version);
  check('fresh_Japanese_terms',fresh.rows[0].indexTerms.some(term=>term.includes('東京')),fresh.rows[0].indexTerms);
  check('fresh_Chinese_terms',fresh.rows[1].indexTerms.some(term=>term.includes('北京')),fresh.rows[1].indexTerms);
  const legacy=clone(fresh);legacy.version=1;
  legacy.digest=String(api.TokenizerEngine.simpleHash(legacy.rows.map(row=>`${row.id}:${row.contentHash}:${row.rollbackState}:${row.stale?1:0}`).sort().join('|')));
  legacy.rows.forEach(row=>{row.indexTerms=['lost'];row.entityKeys=['lost'];row.topicKeys=['lost'];row.hotIndexVersion=1;row.hotIndex={...row.hotIndex,version:1};});
  delete legacy.inverted;
  check('lore_loader_rejects_old_scope_version',H.parseHybridScopeIndexEntry({comment:'lmai_hme_index',content:JSON.stringify(legacy)})===null);
  check('persist_rejects_old_scope_version',H.buildPersistedHybridScopeIndex(legacy)===null);
  H.cacheHybridScopeIndex(legacy,'unicode-index');
  check('runtime_loader_rejects_old_scope_version',H.getCachedHybridScopeIndex('unicode-index')===null);
  const reconciled=H.reconcileHybridScopeIndexEntries(memories,legacy,{scopeKey:'unicode-index',currentTurn:10});
  check('same_hash_legacy_rows_rebuilt',reconciled.changed && reconciled.index.version>=2 && !reconciled.index.rows.some(row=>row.indexTerms.includes('lost')),reconciled.mode);
  check('rebuilt_digest_invalidates_graph',reconciled.index.digest!==legacy.digest);
  const query=H.queryHybridScopeIndex(memories,{scopeKey:'unicode-index',currentTurn:10,query:'東京',topK:1});
  check('read_path_rebuilds_rejected_index',query.ok && H.getCachedHybridScopeIndex('unicode-index')?.version>=2,query.reason);
  check('read_path_has_original_Japanese_term',H.getCachedHybridScopeIndex('unicode-index')?.rows[0].indexTerms.some(term=>term.includes('東京')));
  check('canonical_memories_unchanged',JSON.stringify(memories)===original);
  const graph=ME.buildHmeGraphIndexFromScopeIndexForTest(fresh,{scopeKey:'unicode-index'});
  check('fresh_graph_version',graph.version>=4,graph.version);
  const oldGraph=clone(graph);oldGraph.version=3;
  check('old_graph_requires_rebuild',ME.hmeGraphNeedsRebuildForTest(oldGraph));
  H.cacheHmeGraphIndex(oldGraph,'unicode-graph-old');
  check('runtime_loader_rejects_old_graph',H.getCachedHmeGraphIndex('unicode-graph-old')===null);
  H.cacheHmeGraphIndex(oldGraph,'unicode-index');
  check('late_old_graph_does_not_replace_fresh',H.getCachedHmeGraphIndex('unicode-index')?.version>=4);
  // Actual pluginStorage loader, including versionless data from older installations.
  const persistedScope='unicode-persisted';
  store.set(H.HmeDerivedCacheStore.keyFor('scope',persistedScope),JSON.stringify({...legacy,scopeKey:persistedScope}));
  store.set(H.HmeDerivedCacheStore.keyFor('graph',persistedScope),JSON.stringify({...oldGraph,scopeKey:persistedScope}));
  const loaded=await H.HmeDerivedCacheStore.hydrate(persistedScope);
  check('persistent_loader_reports_rejection',loaded.scopeIndex===false && loaded.graph===false);
  check('persistent_loader_rejects_old_scope',H.getCachedHybridScopeIndex(persistedScope)===null);
  check('persistent_loader_rejects_old_graph',H.getCachedHmeGraphIndex(persistedScope)===null);
  const restore=ME.ensureHybridScopeIndex(memories.slice(),{scopeKey:persistedScope,currentTurn:10});
  check('restore_rebuilds_scope_from_canonical',restore.ok && restore.index.version>=2 && restore.index.rows.some(row=>row.indexTerms.includes('東京')));
  check('restore_rebuilds_graph_from_scope',H.getCachedHmeGraphIndex(persistedScope)?.version>=4);
  const noVersion=clone(legacy);delete noVersion.version;
  check('lore_loader_rejects_versionless_index',H.parseHybridScopeIndexEntry({comment:'lmai_hme_index',content:JSON.stringify(noVersion)})===null);
  check('canonical_memories_still_unchanged',JSON.stringify(memories)===original);
  const scope='unicode-public-path';
  const corpus=[entry('public-jp','アリエル 東京 銀の門'),...Array.from({length:63},(_,i)=>entry('noise-'+i,'ordinary unrelated record number '+i))];
  const canonicalBefore=JSON.stringify(corpus);
  const stale=H.buildHybridScopeIndexFromEntries(corpus,{scopeKey:scope,currentTurn:10});
  stale.version=1;stale.rows.forEach(row=>{row.indexTerms=['lost'];row.hotIndexVersion=1;});delete stale.inverted;
  store.set(H.HmeDerivedCacheStore.keyFor('scope',scope),JSON.stringify(stale));
  api.MemoryState._activeScopeKey=scope;
  const selected=await ME.retrieveMemories('アリエル 東京',10,corpus,{embeddingAllowed:false,scopeKey:scope},4);
  check('public_recall_rebuilds_persisted_old_index',H.getCachedHybridScopeIndex(scope)?.version>=2);
  check('public_recall_preserves_Japanese_target',selected.some(item=>item.key==='unicode::public-jp'),selected.map(item=>item.key));
  const scopeDebug=ME.getLastRetrievalDebug()?.hybridMemoryEngine?.scopeIndex;
  check('public_recall_uses_scope_index',scopeDebug?.mode==='scope_index_preselect' && scopeDebug.selectedRows < corpus.length,scopeDebug);
  check('public_recall_keeps_canonical_input',JSON.stringify(corpus)===canonicalBefore);
  const boundedScope='unicode-bounded-graph';
  const bounded=corpus.slice(0,27);
  const boundedBefore=JSON.stringify(bounded);
  const boundedStale=H.buildHybridScopeIndexFromEntries(bounded,{scopeKey:boundedScope,currentTurn:10});
  boundedStale.version=1;
  store.set(H.HmeDerivedCacheStore.keyFor('scope',boundedScope),JSON.stringify(boundedStale));
  store.set(H.HmeDerivedCacheStore.keyFor('graph',boundedScope),JSON.stringify({...oldGraph,scopeKey:boundedScope}));
  api.MemoryState._activeScopeKey=boundedScope;
  await ME.retrieveMemories('アリエル 東京',10,bounded,{embeddingAllowed:false,scopeKey:boundedScope},4);
  check('bounded_pool_bypasses_scope_preselection',ME.getLastRetrievalDebug()?.hybridMemoryEngine?.scopeIndex?.mode==='bounded_pool_bypass');
  check('bounded_graph_path_rebuilds_stale_scope',H.getCachedHybridScopeIndex(boundedScope)?.version>=2);
  check('bounded_graph_path_rebuilds_stale_graph',H.getCachedHmeGraphIndex(boundedScope)?.version>=4);
  check('bounded_graph_rebuild_keeps_canonical_input',JSON.stringify(bounded)===boundedBefore);
  for(const count of [64,27]){
    const crossScope='unicode-cross-type-'+count;
    const candidates=corpus.slice(0,count);
    const entity={key:'lmai_entity::Ariel',comment:'lmai_entity',content:JSON.stringify({name:'Ariel',type:'character',identity:{aliases:[],summary:'Ariel guards the silvergate.'},meta:{created:1}})};
    const fullLore=[...candidates,entity];
    const fullBefore=JSON.stringify(fullLore);
    const scopeIndex=H.buildHybridScopeIndexFromEntries(candidates,{scopeKey:crossScope,currentTurn:10});
    const fullGraph=ME.buildHmeGraphIndexFromScopeIndexForTest(scopeIndex,{scopeKey:crossScope,lorebook:fullLore});
    check('cross_type_positive_control_'+count,fullGraph.nodes.some(node=>node.nodeType==='entity'),fullGraph.nodes.map(node=>node.nodeType));
    const outdated=clone(scopeIndex);outdated.version=1;
    if(count===27)fullGraph.version=3;
    store.set(H.HmeDerivedCacheStore.keyFor('scope',crossScope),JSON.stringify(outdated));
    store.set(H.HmeDerivedCacheStore.keyFor('graph',crossScope),JSON.stringify(fullGraph));
    api.MemoryState._activeScopeKey=crossScope;
    await ME.retrieveMemories('アリエル 東京',10,candidates,{embeddingAllowed:false,scopeKey:crossScope,[count===27?'recallFeedbackLorebook':'effectiveLorebook']:fullLore},4);
    check('read_rebuild_preserves_entity_nodes_'+count,H.getCachedHmeGraphIndex(crossScope)?.nodes.some(node=>node.nodeType==='entity'));
    check('read_rebuild_preserves_full_canonical_lore_'+count,JSON.stringify(fullLore)===fullBefore);
  }
  const result={ok:assertions.every(item=>item.ok),assertions};
  if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:result.ok,assertions:assertions.length,failed:assertions.filter(item=>!item.ok)},null,2));
  process.exit(result.ok?0:1);
})().catch(error=>{console.error(error);process.exit(1);});
