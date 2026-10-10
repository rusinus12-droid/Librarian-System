'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createHayakuRuntime,createStore,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');

// Four distinct admitted facts remain authoritative across append and passive
// edits. Current explicit-reanalysis policy requires adoption before A1 can
// replace A0; it also forbids blacking out unrelated approved archive facts.
// Keeping all labels in tests must not put them in production.
const facts={A0:'Aurora vault contains amethyst calibration spindle BENCH_A0.',A1:'Aurora vault contains silver calibration spindle BENCH_A1.',B0:'Borealis shelf contains cobalt tuning prism BENCH_B0.',C0:'Cirrus case contains jade alignment ring BENCH_C0.',D1:'Dawn drawer contains garnet indexing pin BENCH_D1.'};
const queries=['What does Aurora vault contain?','What does Borealis shelf contain?','What does Cirrus case contain?','What does Dawn drawer contain?','Which archive entries are established?'];
const packet=(turn,key)=>{const p=createValidPacket({turn,summary:key?facts[key]:'Routine archive entry '+turn+' has been recorded.',subject:'Archivist',scene:'archive'});p.world.world_rules=[{id:'fact-'+turn,summary:p.meta.summary_memory.summary}];return p;};
const pair=(turn,key)=>{const p=packet(turn,key);return[{role:'user',chatId:'u'+turn,data:'Archive completed entry '+turn+'.'},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage('Entry '+turn+' completed: '+p.meta.summary_memory.summary,p)}];};

async function observe(){
  const pluginStorage=createStore();await pluginStorage.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
  let messages=Array.from({length:10},(_,i)=>pair(i+1,i===0?'A0':i===4?'B0':i===8?'C0':null)).flat();
  const h=await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_RECALL_TEST_SOURCE,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,failedRecoveryAutomation:'off',arguments:{hayaku_packet_recovery:'false'},pluginStorage,messages,chatId:'benchmark-main',llmResponder:async()=>{throw Error('ARCHIVE_TEST_FORBIDDEN_MODEL');}});
  const results=[];
  try{
    await waitFor(()=>h.replacers.has('beforeRequest'),'registered archive beforeRequest');
    for(let panel=0;panel<5;panel++)for(const query of queries)await h.callBeforeRequest([{role:'user',content:query}],'model');
    messages.push(...pair(11,'D1'));h.setMessages(messages);
    for(const phase of ['add','edit']){
      if(phase==='edit'){messages[messages.findIndex(m=>m.chatId==='a1')]=pair(1,'A1')[1];h.setMessages(messages);}
      for(const query of queries){
        const before=JSON.stringify(messages),started=performance.now();const output=await h.callBeforeRequest([{role:'user',content:query}],'model'),wallMs=performance.now()-started;
        assert.equal(JSON.stringify(messages),before,'recall cannot alter canonical transcript');
        if(query===queries[4]){
          const context=output.filter(row=>row.memo==='hayaku-runtime-context-v3').map(row=>String(row.content||'')).join('\n');
          const expected=['BENCH_A0','BENCH_B0','BENCH_C0','BENCH_D1']; // Passive source edits do not adopt replacement canon.
          const debug=h.hayaku.lastDebug();
          results.push({phase,wallMs,stageMs:debug.lastBeforeRequest?.stages,context,expected,missing:expected.filter(marker=>!context.includes(marker)),delivery:debug.lastRecallDelivery,rows:debug.lastBeforeRequest?.viewerRecall?.rows||debug.lastViewerRecall?.rows||[]});
        }
      }
    }
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
  if(process.env.HAYAKU_ARCHIVE_OBSERVATION)fs.writeFileSync(process.env.HAYAKU_ARCHIVE_OBSERVATION,JSON.stringify(results,null,2));
  return results;
}

let observed;
test.before(async()=>{observed=await observe();});
for(const phase of ['add','edit'])test(phase+': all four established archive facts reach the registered hook within unchanged axis ceilings',()=>{
  const result=observed.find(row=>row.phase===phase);
  assert.deepEqual(result.missing,[],'missing established facts: '+result.missing.join(', '));
  assert.ok(result.context.length>0);
  if(phase==='edit')assert.equal(result.context.includes('BENCH_A1'),false,'a passively pasted carrier cannot replace approved facts without explicit adoption');
});

const heldoutFacts=['Vesper alcove holds a porcelain compass.','Iona cabinet keeps a tungsten lens.','Ravel drawer protects a sapphire ratchet.','Sable case contains a linen spindle.'];
function rowsForRepresentation(overrides={}){
  const facts=heldoutFacts.map((body,i)=>({id:'heldout-'+i,publicRef:'heldout-'+i,packetHash:'heldout-source-'+i,axis:'narrative',category:'summary_memory',publicText:'summary: '+body,score:.9-i*.01,visibility:{privacy:'public'},locator:{sourceHash:'heldout-source-'+i,sourceScope:'same-chat',sourcePairIndex:i+1,worldlineOrdinal:i+1,messageIndex:i*2+1}}));
  const alternate={...facts[2],id:'actual-world-representation',publicRef:'actual-world-representation',axis:'world',category:'world_rule',score:.2,...overrides};
  const clocks=Array.from({length:3},(_,i)=>({id:'clock-'+i,publicRef:'clock-'+i,packetHash:'clock-source-'+i,axis:'world',category:'current_state',publicText:'location: observatory / time: shift-'+i,score:.95-i*.01,visibility:{privacy:'public'},locator:{sourceHash:'clock-source-'+i,sourceScope:'same-chat',sourcePairIndex:10+i,worldlineOrdinal:10+i,messageIndex:19+i*2}}));
  return {facts,alternate,rows:[...clocks,...facts,alternate]};
}
async function planRows(rows,settingsPatch={},prepareControl,capChars=8000){
  const h=await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_RECALL_TEST_SOURCE,autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only',hayaku_packet_recovery:'false'}});
  try{
    const t=h.hayaku._test,settings={...h.hayaku.settings(),maxItemsPerAxis:3,...settingsPatch},store={worldlineHeadOrdinal:12};
    const selected=t.prepareHayakuRecallRows(rows,'observatory records',settings,store,[],[]);
    if(prepareControl)prepareControl(t.prepareHayakuEvidenceUnits(selected,'observatory records',settings));
    const result=t.selectHayakuEvidencePlan(selected,'observatory records',settings,capChars);
    assert.ok(result.text.length<=capChars,'actual rendered character cap remains enforced');
    const axisCounts={entity:new Set(),world:new Set(),narrative:new Set(),planner:new Set()};
    for(const unit of result.plan.units)for(const origin of unit.origins||[])axisCounts[origin.axis].add(unit.id);
    for(const [axis,ids]of Object.entries(axisCounts))assert.ok(ids.size<=3,axis+' actual source-axis quota stays unchanged');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);return result;
  }finally{await h.dispose();}
}
test('held-out facts can use an admitted equivalent world representation without inventing a source axis',async()=>{
  const fixture=rowsForRepresentation(),before=JSON.stringify(fixture.rows),result=await planRows(fixture.rows);
  for(const fact of heldoutFacts)assert.ok(result.text.includes(fact),'held-out fact survives: '+fact);
  assert.ok(result.plan.units.some(unit=>unit.origins.some(origin=>origin.row.id==='actual-world-representation')));
  assert.deepEqual(result.deliveredSources.map(source=>source.sourceKey).sort(),result.plan.units.flatMap(unit=>unit.rowIds).sort(),'delivery source proofs belong to the actual chosen representations');
  assert.equal(result.deliveredRowKeys.some(key=>result.droppedRowKeys.includes(key)),false,'relocated source cannot be reported both delivered and dropped');
  assert.deepEqual([...result.deliveredRowKeys,...result.droppedRowKeys].sort(),Array.from(result.selectedRowKeys).sort(),'all admitted representations are accounted for');
  assert.equal(JSON.stringify(fixture.rows),before,'canonical source candidates stay immutable');
});
test('representation relocation retains explicit unique-turn temporal quotas',async()=>{
  const fixture=rowsForRepresentation();
  const policy={status:'active',fingerprint:'held-out-explicit-policy',shortMaxAge:2,mediumMaxAge:5,quotas:{short:1,medium:0,long:2}};
  const result=await planRows(fixture.rows,{temporalRecallPolicy:policy});
  assert.equal(result.plan.temporalQuota.allowed,true);
  for(const [lane,quota]of Object.entries(policy.quotas))assert.ok(result.plan.temporalQuota.delivered[lane]<=quota);
  assert.ok(heldoutFacts.filter(body=>result.text.includes(body)).length<=2,'distinct long-term turns remain bounded after relocation');
});
test('relocation cannot manufacture capacity beyond the actual rendered character cap',async()=>{
  const fixture=rowsForRepresentation(),result=await planRows(fixture.rows,{},undefined,300);
  assert.ok(heldoutFacts.some(body=>!result.text.includes(body)),'not all four complete memories fit this fixed budget');
});
test('a protected latest-state alternative cannot be reassigned as ordinary evidence',async()=>{
  const fixture=rowsForRepresentation(),result=await planRows(fixture.rows,{},prepared=>{
    const alternative=prepared.units.find(unit=>unit.origins.some(origin=>origin.row.id==='actual-world-representation'));
    assert.ok(alternative);
    alternative.lane='latest_state';
  });
  assert.equal(result.plan.discarded.some(row=>row.reason==='equivalent_source_representation'),false);
});
test('four distinct narrative-only memories cannot exceed the three-unit ceiling',async()=>{
  const {facts}=rowsForRepresentation(),result=await planRows(facts);
  assert.equal(result.plan.units.length,3);assert.equal(heldoutFacts.filter(fact=>result.text.includes(fact)).length,3);
});
test('existing raw recovery evidence keeps its original budget and supports rows without structured origins',async()=>{
  const h=await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_RECALL_TEST_SOURCE,autoRepair:false,arguments:{hayaku_packet_recovery:'false'}});
  try{
    const raw={id:'held-out-verbatim',text:'Verbatim archive source remains verbatim.',pairIndex:2,role:'assistant',score:.4};
    const result=h.hayaku._test.selectHayakuEvidencePlan({rawRecoveryEvidence:[raw]},'archive',h.hayaku.settings(),8000);
    assert.ok(result.text.includes(raw.text));assert.equal(result.rawRenderedEntries,1);
    assert.deepEqual(Array.from(result.rawDeliveredIds),[raw.id]);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
test('an alternate representation in an atomic dependency cannot be delivered without its budget-excluded companion',async()=>{
  const fixture=rowsForRepresentation();
  const companion={...fixture.alternate,id:'atomic-companion',publicRef:'atomic-companion',packetHash:'companion-source',publicText:'summary: '+('Companion reference stays complete. '.repeat(300)),locator:{sourceHash:'companion-source',sourceScope:'same-chat',sourcePairIndex:4,worldlineOrdinal:4,messageIndex:7}};
  const result=await planRows([...fixture.rows,companion],{},prepared=>{
    const alternative=prepared.units.find(unit=>unit.origins.some(origin=>origin.row.id==='actual-world-representation'));
    const partner=prepared.units.find(unit=>unit.origins.some(origin=>origin.row.id==='atomic-companion'));
    assert.ok(alternative&&partner);
    prepared.requirements.push({id:'held-out-atomic',ids:[...alternative.rowIds,...partner.rowIds],priority:0,linked:false,atomic:true});
    // Exercise the existing prepared contract boundary. No runtime producer
    // currently supplies this requirement; this is an explicit pure contract control.
    partner.body+='\n'+('Non-optional companion source body. '.repeat(300));
  });
  const delivered=result.plan.units.flatMap(unit=>unit.origins.map(origin=>origin.row.id));
  assert.equal(delivered.includes('actual-world-representation'),false);
  assert.equal(result.plan.requirements.find(row=>row.id==='held-out-atomic').status,'unmet');
});
for(const [name,overrides]of [
  ['another raw revision',{packetHash:'different-revision'}],
  ['another source revision with the same raw hash',{locator:{sourceHash:'heldout-source-2',sourceScope:'same-chat',sourcePairIndex:3,worldlineOrdinal:3,messageIndex:5,sourceRevision:'new-revision'}}],
  ['another source pair with the same ordinal',{locator:{sourceHash:'heldout-source-2',sourceScope:'same-chat',sourcePairIndex:8,worldlineOrdinal:3,messageIndex:5}}],
  ['another message with the same ordinal',{locator:{sourceHash:'heldout-source-2',sourceScope:'same-chat',sourcePairIndex:3,worldlineOrdinal:3,messageIndex:15}}],
  ['another session epoch',{locator:{sourceHash:'heldout-source-2',sourceScope:'same-chat',sourcePairIndex:3,worldlineOrdinal:3,messageIndex:5,sessionEpoch:'next-epoch'}}],
  ['another source time',{sourceTime:'later-observation'}],
  ['another temporal boundary',{temporal:{observedAt:'later-observation',knownAt:'later-known-time'}}],
  ['another visibility boundary',{visibility:{privacy:'private',ownerEntityId:'other-observer'}}],
  ['another observation',{locator:{sourceHash:'heldout-source-2',sourceScope:'same-chat',sourcePairIndex:8,worldlineOrdinal:8,messageIndex:15}}]
])test('representation relocation rejects '+name,async()=>{
  const fixture=rowsForRepresentation(overrides),result=await planRows(fixture.rows);
  assert.equal(result.plan.discarded.some(row=>row.reason==='equivalent_source_representation'),false);
});
