'use strict';
// FEATURE-FIRST nominal synthetic owner flows. No actual model, host, transport or server.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const helper=path.join(__dirname,'libra_management_gui_integration_test.cjs'),harness=new Module(helper,module);
harness.filename=helper;harness.paths=Module._nodeModulePaths(__dirname);harness._compile(fs.readFileSync(helper,'utf8').replace('EntityManager,TimeEngine,EntityCandidateCore','EntityManager,TimeEngine,IntegratedAnalysisJournal,TurnMaintenanceOptimizer,runTurnMaintenanceRecord,HierarchicalWorldManager,EntityCandidateCore'),helper);
const open=store=>harness.exports.loadGui({store,observeCommonAnalysis:true,...(!store?{beforeHydrate:async({store,key})=>{const d=JSON.parse(store.get(key));d.entries.push({key:'mira',comment:'lmai_entity',content:JSON.stringify({id:'mira',name:'Mira',type:'character',age:24})});store.set(key,JSON.stringify(d));}}:{})});
const scope=f=>f.api.getChatRuntimeScopeKey(f.control.chat,f.control.char),lore=f=>f.api.MemoryEngine.getLorebook(f.control.char,f.control.chat);
const stored=f=>JSON.parse(f.canonicalPayload().entries.find(row=>row.comment==='lmai_user_dlc').content);
const tracker=(f,id='count',extra={})=>f.api.UserDlcCore.registerEntityTracker({id,targetIds:['mira'],displayName:'Mira',label:id,instruction:'Track only exact committed facts.',valueType:'number',currentValue:'0',enabled:true,trackingEnabled:true,updateMode:'relevant',...extra}).item;
const definition=(processor='counter',extra={})=>({processor,field:'delta',eventTypes:['counter_delta_observed'],visibility:{mode:'public',viewers:[]},...extra});
const packet=(n,{event,clock,plain=false}={})=>({meta:{turn:n,sourceMessageIds:['m'+n]},memory:{events:event?[{operation:'add',summary:'Mira event',id:'occ'+n,eventType:'counter_delta_observed',targetIds:['mira'],role:'subject',factStatus:'direct',fields:{delta:1},visibility:{mode:'public',viewers:[]},evidenceRefs:[{messageId:'m'+n,turn:n,snippet:'Mira explicitly changes the count.'}],...event}]:[]},entity:plain?{characters:[{name:'Mira',currentState:'Mira is ready.'}]}:{},world:{state:clock?{storyClock:{calendarId:'story',day:clock,current:true,evidenceRefs:[{messageId:'m'+n,turn:n,snippet:'Current story day '+clock}]}}:{}},narrative:{},guards:{},importance:{}});
async function save(f,l=lore(f)){await f.api.UserDlcCore.saveState(l);const saved=await f.api.persistLoreToActiveChat(f.control.chat,l,{reason:'synthetic-deterministic-stage'});assert(saved.ok&&saved.canonicalVerified);f.api.MemoryEngine.setLorebook(f.control.char,f.control.chat,l);return saved;}
async function source(f,p){const l=lore(f),j=f.api.IntegratedAnalysisJournal,rec=j.recordPacket(l,p,{turn:p.meta.turn,turnKey:'t'+p.meta.turn,scopeKey:scope(f),sourceMessageIds:p.meta.sourceMessageIds});await j.saveState(l);const saved=await save(f,l),token=j.issueCommittedSource(l,rec.entry.extensionSource,saved);assert(token);return {l,token,source:rec.entry.extensionSource,context:{lorebook:l,scopeKey:scope(f),committedSourceToken:token,turn:p.meta.turn}};}
async function calculate(f,p){const a=f.api,j=a.IntegratedAnalysisJournal,x=await source(f,p);const out=await a.TurnMaintenanceOptimizer.runCommittedExtensions(x.token,{...a.MemoryEngine.CONFIG,useLLM:false},{lorebook:x.l});assert.equal(out.worldAdditional,null);const result=a.UserDlcCore.applyCommittedCalculations(x.context);assert(j.setExtensionOutcome(x.l,x.token,result.waiting.length?'waiting':'processed',result.waiting[0]?.reason || ''));await j.saveState(x.l);await save(f,x.l);return {result,...x};}
function setup(f,t,d){return f.api.UserDlcCore.configureExecution(t.id,d,{approved:true,lorebook:lore(f)});}
const until=async(fn,label)=>{const end=Date.now()+9000;while(!fn()){assert(Date.now()<end,label);await new Promise(r=>setTimeout(r,5));}};

test('normal maintenance routes committed structured counter with AI paused and same occurrence is never recounted',async()=>{const f=await open();try{
 const a=f.api,t=tracker(f);setup(f,t,definition());await save(f);let calls=0;f.common.LLMProvider.call=async()=>{calls++;throw Error('no model');};
 const p=packet(1,{event:{id:'stable-occurrence',fields:{delta:2}}});
 const out=await a.runTurnMaintenanceRecord({char:f.control.char,chat:f.control.chat,chatId:f.control.chat.id,scopeKey:scope(f),aiResponse:'not an extension evidence source',turnForMaintenance:1,m_id:'m1',maintenanceConfig:{...a.MemoryEngine.CONFIG,useLLM:false,rpLongTermMemoryEnabled:false},targetContext:{chatId:f.control.chat.id,characterId:f.control.char.id,characterIndex:0,chatIndex:0,scopeKey:scope(f)},turnState:{m_id:'m1',anchorMeta:{turnKey:'t1'},analysisPending:false,involvedEntities:[],entitiesToConsolidate:[],precomputedMaintenance:{canonicalPacket:p,entityExtraction:null,worldAdditional:null,userDlcTrackerUpdates:[],correctionReviewed:true,correction:null}}});
 assert.equal(out.extension.status,'done',JSON.stringify(out));assert.equal(stored(f).entityTrackers[0].currentValue,'2');assert.equal(calls,0);
 await calculate(f,packet(2,{event:{id:'stable-occurrence',fields:{delta:2}}}));assert.equal(stored(f).entityTrackers[0].currentValue,'2');assert.equal(f.canonicalPayload().entries.filter(row=>row.comment==='lmai_extension_lock').length,1);
 const pending=await source(f,packet(3,{event:{}}));setup(f,a.UserDlcCore.getState().entityTrackers[0],definition());const held=a.UserDlcCore.applyCommittedCalculations(pending.context);assert.equal(held.waiting[0].reason,'definition_applies_to_later_packets');assert.equal(a.UserDlcCore.getState().entityTrackers[0].currentValue,'2');
 }finally{f.close();}});

test('explicit versioned item-use effect advances and expires by story day without AI',async()=>{const f=await open();try{
 const a=f.api,l=lore(f);l.push({key:'lmai_world_graph::compact',comment:'lmai_world_graph',content:JSON.stringify({schema:'libra.world.graph.compact.v2',version:'6.1',rootId:'world_main',nodes:[['world_main',{id:'world_main',name:'Main',rules:{custom:{rule_1:'Using a ward grants a three-day shield.'}},meta:{created:1,updated:1}}]],activePath:['world_main']})});
 const ref=a.HierarchicalWorldManager.listSavedCustomRuleReferences(l)[0];assert(ref);const t=tracker(f,'ward',{valueType:'boolean',currentValue:'unknown'});
 a.UserDlcCore.configureExecution(t.id,definition('effect',{field:'mana',eventTypes:['item_use_observed'],itemRef:'ward',durationDays:3,operation:'allow',ruleRefs:[ref]}),{approved:true,lorebook:l});await save(f,l);
 const first=await calculate(f,packet(1,{clock:10,event:{eventType:'item_use_observed',fields:{itemRef:'ward',used:true,mana:4},ruleRefs:[ref],storyClock:{calendarId:'story',day:10}}}));assert.equal(first.result.waiting.length,0);assert.equal(stored(f).entityTrackers[0].executionState.effect.endDay,13);
 await calculate(f,packet(2,{clock:12}));assert.equal(stored(f).entityTrackers[0].executionState.effect.active,true);
 await calculate(f,packet(3,{clock:13}));const current=stored(f).entityTrackers[0];assert.equal(current.executionState.effect.active,false);assert.equal(current.executionState.value,'expired');assert.equal(current.currentValue,'true','old observed/application value preserved separately');
 const projection=a.UserDlcCore.getTrackerProjection(a.UserDlcCore.getState().entityTrackers[0],{audience:'management',lorebook:lore(f)});assert.equal(projection.value,'expired');assert.equal(projection.classification,'derived');
 const absent=await calculate(f,packet(4,{event:{eventType:'item_use_observed',fields:{itemRef:'ward',used:false},ruleRefs:[ref],storyClock:{calendarId:'story',day:14}}}));assert.equal(absent.result.waiting[0].reason,'actual_item_use_unavailable');
 }finally{f.close();}});

test('permission partitions stage one interpretation per pass and private output never reaches public prompt',async()=>{const f=await open();try{
 const a=f.api,j=a.IntegratedAnalysisJournal,pub=tracker(f,'public',{valueType:'text',currentValue:'unknown'}),priv=tracker(f,'private',{valueType:'text',currentValue:'unknown'});
 setup(f,pub,definition('semantic',{field:'',eventTypes:[]}));setup(f,priv,definition('semantic',{field:'',eventTypes:['private_observation'],visibility:{mode:'private',viewers:['mira']}}));await save(f);
 let calls=0;const users=[];f.common.LLMProvider.isConfigured=()=>true;f.common.LLMProvider.call=async(c,system,user)=>{calls++;users.push(user);const source=JSON.parse(user.split('[Committed canonical packet — sole update evidence]\n')[1].split('\n\n')[0]);const isPrivate=source.evidence.some(e=>e.text==='PRIVATE_CANARY');return {content:JSON.stringify({userDlcTrackerUpdates:[{trackerId:isPrivate?'private':'public',packetId:source.packetId,packetRevision:source.revision,evidenceRefs:[source.evidence.find(e=>isPrivate?e.text==='PRIVATE_CANARY':e.text.includes('ready')).id],value:isPrivate?'PRIVATE_RESULT':'ready',confidence:'likely',dbCompatibility:'compatible'}]})};};
 const p=packet(1,{plain:true,event:{eventType:'private_observation',fields:{},visibility:{mode:'private',viewers:['mira']},evidenceRefs:[{turn:1,messageId:'m1',snippet:'PRIVATE_CANARY'}]}});let x=await source(f,p);
 const lifecycle=()=>({lorebook:x.l,beforeRole:async role=>{assert(j.reserveExtensionRole(x.l,x.token,role));await save(f,x.l);},afterRole:async(role,value,guard)=>{assert(j.stageExtensionRole(x.l,x.token,role,value,guard));await save(f,x.l);}});
 const first=await a.TurnMaintenanceOptimizer.runCommittedExtensions(x.token,{...a.MemoryEngine.CONFIG,useLLM:true},lifecycle());assert(first.skipped);assert.equal(calls,1);assert(!users[0].includes('PRIVATE_CANARY'));assert(!users[0].includes('"trackerId":"private"'));
 assert(j.setExtensionOutcome(x.l,x.token,'waiting',first.reason));await j.saveState(x.l);const saved=await save(f,x.l);x.token=j.issueCommittedSource(x.l,x.source,saved);assert(x.token);x.context.committedSourceToken=x.token;
 const second=await a.TurnMaintenanceOptimizer.runCommittedExtensions(x.token,{...a.MemoryEngine.CONFIG,useLLM:true},lifecycle());assert.equal(second.skipped,undefined);assert.equal(calls,2);assert(users[1].includes('PRIVATE_CANARY'));assert.equal(second.userDlcTrackerUpdates.length,2);
 const applied=a.UserDlcCore.applyTrackerUpdates(second.userDlcTrackerUpdates,x.context);assert.equal(applied.evaluated,2);assert(j.markExtensionApplied(x.l,x.token));await j.saveState(x.l);await save(f,x.l);
 const prompt=a.UserDlcCore.formatTargetAnalysesForPrompt(['Mira'],3200,{lorebook:x.l});assert(prompt.includes('ready'));assert(!prompt.includes('PRIVATE_RESULT'));assert.equal(a.UserDlcCore.getTrackerProjection(a.UserDlcCore.getState().entityTrackers.find(t=>t.id==='private'),{audience:'management',lorebook:x.l}).value,'PRIVATE_RESULT');
 }finally{f.close();}});

test('archive retains more than the old forty locks, bounds decoded cache, and deduplicates after new runtime',async()=>{const f=await open();let fresh;try{
 const t=tracker(f);setup(f,t,definition());for(let n=1;n<=55;n++) await calculate(f,packet(n,{event:{}}));
 assert.equal(stored(f).entityTrackers[0].currentValue,'55');assert.equal(f.canonicalPayload().entries.filter(row=>row.comment==='lmai_extension_lock').length,55);
 const stats=f.api.IntegratedAnalysisJournal.semanticLockStats();assert(stats.decodedEntries<=stats.decodedLimit);assert.equal(stats.physicalColdPaging,false);
 fresh=await open(f.store);await calculate(fresh,packet(56,{event:{id:'occ1'}}));assert.equal(stored(fresh).entityTrackers[0].currentValue,'55');
 }finally{fresh?.close();f.close();}});

test('unknown and hypothetical inputs stay waiting and a changed locked occurrence requires review',async()=>{const f=await open();try{
 const t=tracker(f);setup(f,t,definition());let x=await calculate(f,packet(1,{event:{factStatus:'hypothesis'}}));assert.equal(x.result.waiting[0].reason,'evidence_unavailable');assert.equal(stored(f).entityTrackers[0].currentValue,'0');
 x=await calculate(f,packet(2,{event:{id:'locked'}}));assert.equal(stored(f).entityTrackers[0].currentValue,'1');x=await calculate(f,packet(3,{event:{id:'locked',fields:{delta:99}}}));assert.equal(x.result.waiting[0].reason,'locked_occurrence_changed_requires_review');assert.equal(stored(f).entityTrackers[0].currentValue,'1');
 x=await calculate(f,packet(4,{event:{id:'',evidenceRefs:[]}}));assert.equal(x.result.waiting[0].reason,'occurrence_lineage_unavailable');
 const unknown=tracker(f,'unknown',{currentValue:'unknown'});setup(f,unknown,definition());x=await calculate(f,packet(5,{event:{}}));assert(x.result.waiting.some(item=>item.trackerId==='unknown' && item.reason==='counter_baseline_unknown'));
 }finally{f.close();}});

test('same projection withholds stale and off-scene results from response while management explains waiting',async()=>{const f=await open();try{
 const t=tracker(f);setup(f,t,definition());await calculate(f,packet(1,{event:{}}));const a=f.api;
 assert(a.UserDlcCore.formatTargetAnalysesForPrompt(['Mira'],3200,{lorebook:lore(f)}).includes('"value":"1"'));
 assert.equal(a.UserDlcCore.formatTargetAnalysesForPrompt(['Elsewhere'],3200,{lorebook:lore(f)}),'');
 const next=await source(f,packet(2,{event:{}}));const item=a.UserDlcCore.getState().entityTrackers[0],projection=a.UserDlcCore.getTrackerProjection(item,{audience:'management',lorebook:next.l});assert.equal(projection.status,'waiting');assert.equal(projection.value,'unknown');assert.equal(a.UserDlcCore.formatTargetAnalysesForPrompt(['Mira'],3200,{lorebook:next.l}),'');
 }finally{f.close();}});

test('same-card calculator editing persists explicit values without enabling stopped tracking',async()=>{let f=await open(),fresh;try{
 tracker(f,'stopped',{enabled:false,trackingEnabled:false,updateMode:'manual'});await save(f);const store=f.store;f.close();f=await open(store);
 const box=f.overlay.querySelector('[data-execution-editor="stopped"]');assert(box);box.querySelector('[data-execution-processor]').value='counter';box.querySelector('[data-execution-events]').value='counter_delta_observed';box.querySelector('[data-execution-field]').value='delta';await f.click('[data-execution-save="stopped"]');await until(()=>stored(f).entityTrackers[0].executionDefinition?.processor==='counter','calculator saved');fresh=await open(f.store);const t=fresh.api.UserDlcCore.getState().entityTrackers[0];assert.equal(t.executionDefinition.durationDays,null);assert.equal(t.executionDefinition.operand,null);assert.equal(t.enabled,false);assert.equal(t.currentValue,'0');
 }finally{fresh?.close();f.close();}});

test('registered state adapter copies explicit false while absent facts remain unknown',async()=>{const f=await open();try{
 const t=tracker(f,'door',{valueType:'boolean',currentValue:'unknown'});setup(f,t,definition('state',{field:'open',eventTypes:['state_observed']}));
 await calculate(f,packet(1,{event:{eventType:'state_observed',fields:{open:false}}}));assert.equal(stored(f).entityTrackers[0].currentValue,'false');assert.equal(stored(f).entityTrackers[0].executionState.classification,'observed');
 const next=await calculate(f,packet(2,{event:{eventType:'state_observed',fields:{}}}));assert.equal(next.result.waiting[0].reason,'state_evidence_unavailable');assert.equal(f.api.UserDlcCore.getTrackerProjection(f.api.UserDlcCore.getState().entityTrackers[0],{audience:'management',lorebook:lore(f)}).value,'unknown');
 }finally{f.close();}});
