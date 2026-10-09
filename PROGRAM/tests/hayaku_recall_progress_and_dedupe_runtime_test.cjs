'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const searchKernel=require('../sdk/MemorySuiteSearchKernel.source.cjs');
const source=process.env.HAYAKU_RECALL_TEST_SOURCE;
const runtime=()=>createHayakuRuntime({pluginSourceFile:source,autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only',hayaku_packet_recovery:'false'}});

test('FNV64 preserves historical UTF16 identities across arbitrary values and fallback runtimes',()=>{
  const bytes=fs.readFileSync(source||require('node:path').join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
  const start=bytes.indexOf('  const stableHash64Fallback ='),end=bytes.indexOf('  const hayakuBytesToBase64 =',start);
  assert.ok(start>=0&&end>start);const body=bytes.slice(start,end);
  const run=vm.runInNewContext('const text=x=>String(x);'+body+';({hash:stableHash64,fallback:stableHash64Fallback})');
  const ref=s=>{let h=14695981039346656037n;for(let i=0;i<s.length;i++)h=((h^BigInt(s.charCodeAt(i)))*1099511628211n)&18446744073709551615n;return 'h64'+h.toString(36);};
  const cases=['','\0','\uffff','\ud800','\udfff','a\r\nb','한국어 日本語 中文 العربية Ελληνικά','x'.repeat(131071)];
  let state=0x61a42b79;for(let n=0;n<256;n++){let value='';for(let i=0;i<n;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;value+=String.fromCharCode(state&65535);}cases.push(value);}
  for(const value of cases)assert.equal(run.hash(value),ref(value));
  const noBigInt=vm.runInNewContext('const text=x=>String(x);'+body+';({hash:stableHash64,fallback:stableHash64Fallback})',{BigInt:undefined});
  for(const value of cases.slice(0,20))assert.equal(noBigInt.hash(value),noBigInt.fallback(value));
});

test('expired source preparation cannot advance past unprocessed evidence',async()=>{
  const h=await runtime();try{const t=h.hayaku._test;
  const packets=Array.from({length:100},(_,i)=>{const p=createValidPacket({turn:i+1});p.world.world_rules=[{id:'progress-rule-'+i,summary:'Established reference '+i}];return {raw:JSON.stringify(p),hash:'progress-source-'+i,messageIndex:i*2+1,worldlineOrdinal:i+1};});
  const settings={...h.hayaku.settings(),retrievalCurrentQuery:'',retrievalRecentContext:{topics:[]}},store={index:[],context:{}};
  const first=await t.localRecallPrepareSources(packets,store,settings,'progress-evidence',0);assert.equal(first.processedThisRequest,0);
  const second=await t.localRecallPrepareSources(packets,store,settings,'progress-evidence',Date.now()+10000);
  assert.ok(second.processedThisRequest>0&&second.processedThisRequest<=64);
  assert.ok(store._recallSourceRows.some(row=>row.id==='progress-rule-0'),'the first unprocessed source is still eligible on the next request');
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});

test('preparation around persistence shares the unchanged 64-source request budget',async()=>{
  const h=await runtime();try{const t=h.hayaku._test;
  const packets=Array.from({length:100},(_,i)=>({raw:JSON.stringify(createValidPacket({turn:i+1})),hash:'shared-budget-'+i,messageIndex:i*2+1,worldlineOrdinal:i+1}));
  const settings={...h.hayaku.settings(),retrievalCurrentQuery:'',retrievalRecentContext:{topics:[]}},budget={remaining:64};
  const before=await t.localRecallPrepareSources(packets,{index:[],context:{}},settings,'shared-budget',Date.now()+10000,budget);
  const store={index:[],context:{}},after=await t.localRecallPrepareSources(packets,store,settings,'shared-budget',Date.now()+10000,budget);
  assert.ok(before.processedThisRequest>0);assert.ok(before.processedThisRequest+after.processedThisRequest<=64,'two preparations cannot double the source parse allowance');
  assert.equal(after.processedThisRequest,0);assert.equal(budget.remaining,0);assert.equal(after.indexedCount,64);
  assert.ok(store._recallSourceRows.length>0,'the final pass still verifies and consumes the prepared evidence');
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});

test('axis quota counts deduped memory units while preserving every provenance reference',async()=>{
  const h=await runtime();try{const t=h.hayaku._test,settings={...h.hayaku.settings(),maxItemsPerAxis:1};
  const rows=Array.from({length:6},(_,i)=>({id:'origin-'+i,publicRef:'origin-'+i,packetHash:'proof-'+i,axis:'world',category:'world_rule',publicText:'The established signal has a stable calibration.',score:1,visibility:{privacy:'public'},locator:{sourcePairIndex:3,worldlineOrdinal:3,messageIndex:5}}));
  const store={worldlineHeadOrdinal:3};
  const selected=t.prepareHayakuRecallRows(rows,'stable calibration',settings,store,[],[]),plan=t.selectHayakuEvidencePlan(selected,'stable calibration',settings,8000);
  assert.equal(plan.renderedEntries,1,'duplicate proofs of one memory consume one memory slot');assert.equal(plan.deliveredSources.length,6);
  for(let i=0;i<6;i++)assert.ok(plan.text.includes('proof-'+i));
  const distinct=rows.slice(0,3).map((row,i)=>({...row,publicText:'Distinct established calibration '+String.fromCharCode(65+i)}));
  const bounded=t.selectHayakuEvidencePlan(t.prepareHayakuRecallRows(distinct,'calibration',settings,store,[],[]),'calibration',settings,8000);
  assert.equal(bounded.renderedEntries,1,'distinct memories still obey the unchanged quota');
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});

test('a declared common collection anchor reaches distinct old facts without template flooding',async()=>{
  const h=await runtime();try{const t=h.hayaku._test,settings={...h.hayaku.settings(),maxItemsPerAxis:4,retrievalRecentContext:{topics:[]},hierarchicalEpisodeMemoryEnabled:false};
  const facts=new Map([[0,'Mira rack keeps a cerulean lens.'],[11,'Solenne case stores a brass ratchet.'],[26,'Tovan shelf protects an ivory spindle.']]);
  const rows=Array.from({length:80},(_,i)=>{const summary=facts.get(i)||'Routine entry '+i+' was recorded.';const p=createValidPacket({turn:i+1,summary,subject:'Recorder',scene:'established-scene'});
    p.meta.summary_memory.recallAnchors=['observatory'];p.meta.summary_memory.recallAliases={};
    return t.localRecallRowsFromPacket({raw:JSON.stringify(p),messageIndex:i*2+1,worldlineOrdinal:i+1},'collection-'+i);
  }).flat();
  const store={index:[],_recallSourceRows:rows,context:{},entity:{characters:[]},worldlineHeadOrdinal:80};
  const query='Which observatory records are established?',candidates=t.localRecallCandidates(store,query,settings);
  for(const fact of facts.values())assert.ok(candidates.some(row=>row.category==='summary_memory'&&row.publicText.includes(fact)),'an established old fact survives the bounded candidate frontier');
  const plan=t.selectHayakuEvidencePlan(t.prepareHayakuRecallRows(candidates,query,settings,store,[],[]),query,settings,8000);
  for(const fact of facts.values())assert.ok(plan.text.includes(fact),'the established fact reaches final evidence');
  assert.equal(plan.text.includes('observatory'),false,'retrieval-only anchor is not promoted to evidence');
  const expired=rows.map(row=>row.category==='summary_memory'?{...row,locator:{...row.locator,sourceRevision:'different-raw'}}:row);
  // Legitimate character-gram matches in the original English fact may remain.
  // A stale anchor must give exactly the same ranking as removing that metadata.
  const stale=t.localRecallRank(expired,['observatory']);
  const stripped=rows.map(({_recallSearchAliases,...row})=>row),without=t.localRecallRank(stripped,['observatory']);
  assert.deepEqual(Array.from(stale,row=>row.recordKey),Array.from(without,row=>row.recordKey),'stale anchors have no ranking influence');
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});

test('recent state templates do not monopolize final slots ahead of distinct established facts',async()=>{
  const h=await runtime();try{const t=h.hayaku._test,settings={...h.hayaku.settings(),maxItemsPerAxis:3,retrievalRecentContext:{topics:[]},hierarchicalEpisodeMemoryEnabled:false};
  const facts=new Map([[1,'Elara cabinet holds a vermilion sextant.'],[11,'Fenn alcove preserves a titanium loom.'],[27,'Neris drawer contains an amber dial.']]);
  const packets=Array.from({length:2000},(_,i)=>{const p=createValidPacket({turn:i+1,summary:facts.get(i)||'Routine repository record '+i+' was registered.',subject:'Custodian',scene:'repository'});
    p.meta.summary_memory.recallAnchors=['repository'];p.meta.summary_memory.recallAliases={};
    return {raw:JSON.stringify(p),hash:'selection-source-'+i,messageIndex:i*2+1,worldlineOrdinal:i+1};});
  const store=t.emptyStore();for(const packet of packets.slice(-9))t.ingestPacket(store,packet.raw,packet.hash,packet);
  t.rebuildIndex(store,{settings,deadlineAt:Date.now()+10000});
  const query='Which repository records are established?';settings.retrievalCurrentQuery=query;
  for(let request=0;request<3;request++)await t.localRecallPrepareSources(packets,store,settings,'selection-diversity',Date.now()+10000);
  const rows=t.localRecallCandidates(store,query,settings),plan=t.selectHayakuEvidencePlan(t.prepareHayakuRecallRows(rows,query,settings,store,[],[]),query,settings,8000);
  for(const fact of facts.values())assert.ok(plan.text.includes(fact),'a distinct established fact reaches final evidence despite recently projected state templates');
  assert.ok(rows.length<=48);assert.ok(plan.renderedEntries<=12);assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});

test('local and server ranking agree for held-out names, broad collections and multilingual phrases',async()=>{
  const h=await runtime();try{const t=h.hayaku._test,run=searchKernel();
  const facts=new Map([[2,'Elara cabinet holds a vermilion sextant.'],[19,'Fenn alcove preserves a titanium loom.'],[61,'Neris drawer contains an amber dial.']]);
  const rows=Array.from({length:120},(_,i)=>{
    const summary=facts.get(i)||'Routine inventory '+i+' was registered.';
    const p=createValidPacket({turn:i+1,summary,subject:'Custodian',scene:'heldout-'+i});
    p.meta.summary_memory.recallAnchors=['repository','기록실'];p.meta.summary_memory.recallAliases={};
    return t.localRecallRowsFromPacket({raw:JSON.stringify(p),messageIndex:i*2+1,worldlineOrdinal:i+1},'heldout-source-'+i);
  }).flat();
  const key=row=>[row.packetHash||row.locator?.sourceHash||'',row.axis||'',row.id||row.publicRef||'',row.publicText||''].join('\u0001');
  const corpus={rankingPolicy:'hayaku.evidence-lexical.v1',documents:rows.map(row=>({key:key(row),body:t.localRecallSearchBody(row),evidenceBody:[row.publicText,row.publicProfile].filter(x=>typeof x==='string').join('\n').trim()}))};
  const queries=['Which repository records are established?','Elara cabinet vermilion sextant','What does Neris keep in the drawer?','기록실에 있는 물건','titanium loom','unlisted placeholder'];
  const remote=run({kind:'lexical',owner:'hayaku',corpus,queries:queries.map(query=>[query])});
  for(let i=0;i<queries.length;i++)assert.deepEqual(remote.rankings[i].map(row=>row.key),Array.from(t.localRecallRank(rows,[queries[i]]),key),'the complete rank order matches for '+queries[i]);
  const ranked=t.localRecallRank(rows,[queries[0]]).slice(0,12);
  for(const fact of facts.values())assert.ok(ranked.some(row=>row.category==='summary_memory'&&row.publicText.includes(fact)),'a generic broad collection preserves the held-out established fact');
  assert.throws(()=>run({kind:'lexical',owner:'libra',corpus,queries:[['repository']]}),/search_ranking_owner_invalid/);
  assert.throws(()=>run({kind:'lexical',owner:'hayaku',corpus:{...corpus,rankingPolicy:'unknown'},queries:[['repository']]}),/search_ranking_policy_invalid/);
  const malformed={...corpus,documents:[{...corpus.documents[0],evidenceBody:'different evidence'}]};
  assert.throws(()=>run({kind:'lexical',owner:'hayaku',corpus:malformed,queries:[['repository']]}),/search_evidence_body_invalid/);
  assert.deepEqual(run({kind:'vectors',owner:'flashback',corpus:{vectors:[[1,0],[0,1]]},queries:[[1,0]]}),{kind:'vectors',values:[[1],[0]]});
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});

test('beforeRequest ledger preservation uses the actual authoritative transcript',async()=>{
  const messages=[];for(let turn=1;turn<=3;turn++){
    const p=createValidPacket({turn,summary:'Established testimony '+turn});
    messages.push({role:'user',chatId:'preserve-u'+turn,data:'Question '+turn},{role:'assistant',chatId:'preserve-a'+turn,data:hiddenPacketMessage('Reply '+turn,p)});
  }
  const h=await createHayakuRuntime({pluginSourceFile:source,autoRepair:false,afterRequestAutoRepair:false,messages,arguments:{hayaku_packet_recovery:'false'}});
  try{
    await h.callBeforeRequest([{role:'user',content:'What testimony was established?'}],'model');
    const t=h.hayaku._test,scope=await t.currentChatScope(),ledger=await t.loadStorageLedger(scope);
    const active=ledger.records.filter(r=>r.recordState==='active');assert.equal(active.length,3);
    for(const record of active){
      assert.ok(record.sourceEvidenceRef?.key,'every admitted packet has its original U+A evidence reference');
      const raw=await h.host.pluginStorage.getItem(record.sourceEvidenceRef.key),saved=JSON.parse(raw);
      assert.equal(saved.binding.scopeKey,scope.key);assert.equal(saved.binding.sourceDigest,record.sourceEvidenceRef.sourceDigest);
      assert.equal(saved.rows[0].userRaw,'Question '+record.targetPairIndex);
      assert.equal(saved.rows[0].assistantRaw,messages[record.targetPairIndex*2-1].data);
    }
    assert.ok(h.hayaku.lastDebug().messageRevisionCache.stats.retainedChars>0,'a descriptor without message bodies cannot prune the real authoritative snapshot cache');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
