'use strict';
// registerUnchangedBaseline and automatic source-edit journal enrollment were
// retired. Exercise the actual replacement: read-only SourceInput readiness,
// followed by independently guarded admission and publication in the registered
// request hook. Whole readset/reconciliation coverage also remains in
// hayaku_inline_ledger_readset_runtime_test.cjs; explicit provider work remains
// in hayaku_source_review_v2_test.cjs and source_* owner reanalysis suites.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {physicalStore,digest}=require('./fixtures/hayaku_inline_physical_store.cjs');
const evidence=process.env.HAYAKU_PREPARATION_EVIDENCE||fs.mkdtempSync(path.join(os.tmpdir(),'LIB-HAYAKU-First-Hook-SourceInput-'));
const source=process.env.HAYAKU_PREPARATION_SOURCE||path.resolve(__dirname,'../plugins/HAYAKU_Locator_Continuity.js');
const sourceSHA=digest(fs.readFileSync(source)),PREFS='hayaku.v2.settings.source-tracking.v1',receipts=[];
const messages=()=>Array.from({length:3},(_,i)=>{
 const turn=i+1,summary=turn===1?'Aurora vault contains amethyst calibration spindle FIRST_DEFAULT_OLD.':'Routine entry '+turn+'.';
 const packet=createValidPacket({turn,subject:'Archivist',scene:'archive',summary});packet.world.world_rules=[{id:'fact-'+turn,summary}];
 return [{role:'user',chatId:'u'+turn,data:'Archive entry '+turn+'.'},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage(summary,packet)}];
}).flat().concat({role:'system',chatId:'tail',data:'Unselected control tail'});
const recall=output=>output.filter(row=>row.memo==='hayaku-runtime-context-v3').map(row=>String(row.content||'')).join('\n');
async function fixture(name,preferences){
 const root=path.join(evidence,name),store=await physicalStore(path.join(root,'plugin')),safe=await physicalStore(path.join(root,'device'));
 if(preferences!==undefined)await store.setItem(PREFS,JSON.stringify(preferences));
 const rows=messages(),h=await createHayakuRuntime({pluginSourceFile:source,pluginStorage:store,safeLocalStorage:safe,messages:rows,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,failedRecoveryAutomation:'off',arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('IMPLICIT_MODEL_FORBIDDEN');}});
 await waitFor(()=>h.host.unloadHandlers.length>0,'complete installation');
 return {h,store,rows,root};
}
async function record(f,name,extra={}){
 const inventory=await f.store.inventory();assert(!inventory.some(row=>row.key.startsWith('hayaku.v2.source-edit.')),'ordinary hooks must never enroll retired journals');assert.equal(f.h.llmCalls.length,0);assert.equal(f.h.fetchCalls.length,0);
 const receipt={name,sourceSHA,sourceBytesSHA:digest(JSON.stringify(f.h.chat.message)),inventory,modelCalls:f.h.llmCalls.length,...extra};receipts.push(receipt);fs.writeFileSync(path.join(f.root,'receipt.json'),JSON.stringify(receipt,null,2));
}
for(const [name,prefs]of [['absent',undefined],['legacy-auto',{mode:'auto',epoch:7,sourceRuleEpoch:9,future:{keep:true}}],['explicit-input',{mode:'off',epoch:7,sourceRuleEpoch:9,ignoredTags:['thoughts'],sourceRules:{version:1,ignoredTags:['thoughts'],sourceTags:[],unwrapTags:[],controls:[]},externalRulesVersion:1,future:{keep:true}}]])test('first registered hook '+name+' preserves source and preferences while delivering durable canonical recall',async()=>{
 const f=await fixture(name,prefs);try{
  const before=JSON.stringify(f.rows),preferences=await f.store.getItem(PREFS),policy=f.h.hayaku._test.getHayakuSourceInput();
  await policy.ready();assert.equal(await f.store.getItem(PREFS),preferences,'readiness is read-only');
  const input=[{role:'user',content:'What does Aurora vault contain?'}],first=await f.h.callBeforeRequest(input,'model'),debug=f.h.hayaku.lastDebug();
  assert.equal(debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,true,'same first request durably admits the actual packet corpus');assert(recall(first).includes('FIRST_DEFAULT_OLD'),'actual final request delivers the eligible rare-query fact');
  assert.equal(JSON.stringify(f.h.chat.message),before);assert.equal(await f.store.getItem(PREFS),preferences,'first hook preserves opaque legacy preferences');
  await f.h.callAfterRequest('Unchanged output.','model');const second=await f.h.callBeforeRequest(input,'model');assert(recall(second).includes('FIRST_DEFAULT_OLD'));assert.equal(JSON.stringify(f.h.chat.message),before);assert.equal(await f.store.getItem(PREFS),preferences);
  await record(f,name,{firstDurable:true,firstDelivery:true,secondDelivery:true,preferenceBytes:preferences});
 }finally{await f.h.dispose();}
});
for(const mutation of ['none','body','tail','input','scope','preferences'])test('first admitted evidence write '+mutation+' retains its original request authority',async()=>{
 const f=await fixture('held-'+mutation,{mode:'auto',epoch:7,future:{keep:true}});let gate,pending;
 try{
  const originalPrefs=await f.store.getItem(PREFS),input=[{role:'user',content:'What does Aurora vault contain?'}];gate=f.store.arm('evidence','write');pending=f.h.callBeforeRequest(input,'model');
  let timer;try{await Promise.race([gate.entered,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('PHYSICAL_GATE_NOT_REACHED')),3000))]);}finally{clearTimeout(timer);}
  if(mutation==='body'){const packet=createValidPacket({turn:1,subject:'Archivist',summary:'Different current source FIRST_DEFAULT_NEW.'});f.rows[1]={...f.rows[1],data:hiddenPacketMessage('Different current source FIRST_DEFAULT_NEW.',packet)};f.h.setMessages(f.rows);}
  if(mutation==='tail'){f.rows.at(-1).data='Changed unselected tail';f.h.setMessages(f.rows);}
  if(mutation==='input')input[0].content='Find a different object.';
  if(mutation==='scope')f.h.chat.id=f.h.chat.chatId='different-host-scope';
  if(mutation==='preferences')await f.store.setItem(PREFS,JSON.stringify({mode:'auto',epoch:7,ignoredTags:['changed-policy'],future:{keep:true}}));
  gate.release();const output=await pending,commit=f.h.hayaku.lastDebug().lastBeforeRequest?.authoritativeLedger?.reconcileCommit;
  if(mutation==='none'){assert.equal(commit?.durable,true);assert(recall(output).includes('FIRST_DEFAULT_OLD'));assert.equal(await f.store.getItem(PREFS),originalPrefs);}
  else{assert.notEqual(commit?.durable,true,'changed frame never receives a durable acknowledgement');assert(!recall(output).includes('FIRST_DEFAULT_OLD'),'pre-await source cannot publish recall after authority changes');}
  await record(f,'held-'+mutation,{commit,delivery:recall(output).includes('FIRST_DEFAULT_OLD'),mutation});
 }finally{gate?.release();await pending?.catch(()=>{});await f.h.dispose();}
});
test.after(()=>{fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify({sourceSHA,evidence,cases:receipts.length,receipts},null,2));console.log(JSON.stringify({sourceSHA,evidence,cases:receipts.length}));});
