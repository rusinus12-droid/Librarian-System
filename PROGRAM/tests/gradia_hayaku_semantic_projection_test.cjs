'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./gradia/host.cjs');
const {createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
test('GRADIA preserves all HAYAKU semantic leaves without changing the producer packet',async()=>{
 const capture={};
 await load({testGlobals:{capture},transformSource:s=>s.replace('  const cleanFlashbackTurnText =','  capture.project = projectHayakuPacketText;\n  const cleanFlashbackTurnText =')});
 const p=createValidPacket();p.meta.lineage={request_nonce:'PRIVATE_TRANSPORT_NONCE'};
 p.world.historical_events=[{summary:'PAST',consequence:'PAST_CONSEQUENCE'}];
 p.world.world_rules=Array.from({length:12},(_,i)=>({text:'RULE_'+i,exceptions:['EXCEPTION_'+i],enabled:false}));
 p.world.offscreen_threads=[{summary:'OFFSCREEN',status:'unresolved'}];
 p.narrative.scene_deltas=[{before:'BEFORE',after:'AFTER'}];
 p.planner.payoff_tracker=[{setup:'SETUP',payoff:'PAYOFF',resolved:false}];
 p.entity.secrets=[{text:'SECRET',known_to:['ALICE'],hidden_from:['BOB']}];
 p.entity.characters[0].knowledge=['KNOWLEDGE'];p.meta.false_inferences=['DO_NOT_ASSUME'];
 const raw=JSON.stringify(p),out=capture.project(raw);
 for(const text of ['PAST','PAST_CONSEQUENCE','RULE_11','EXCEPTION_11','OFFSCREEN','unresolved','BEFORE','AFTER','SETUP','PAYOFF','false','SECRET','ALICE','BOB','KNOWLEDGE','DO_NOT_ASSUME']) assert.ok(out.includes(text),text);
 assert.ok(!out.includes('PRIVATE_TRANSPORT_NONCE'));assert.equal(JSON.stringify(p),raw);
 assert.equal(capture.project('plain memory'),'plain memory');assert.equal(capture.project('{"meta":{"schema":"future"}}'),'{"meta":{"schema":"future"}}');
});

test('GRADIA qualifies low-confidence HAYAKU inferences with [추정] prefix while omitting raw confidence metadata',async()=>{
 const capture={};
 await load({testGlobals:{capture},transformSource:s=>s.replace('  const cleanFlashbackTurnText =','  capture.project = projectHayakuPacketText;\n  const cleanFlashbackTurnText =')});
 const p=createValidPacket();
 p.entity.characters.push({name:'민아',current_state:'불안',confidence:0.3});
 p.entity.characters.push({name:'준호',current_state:'침착',confidence:0.85});
 p.entity.relations.push({from:'민아',to:'준호',type:'의심',confidence:0.4});
 p.entity.relations.push({from:'민아',to:'준호',type:'동행',confidence:0.9});
 const out=capture.project(JSON.stringify(p));
 assert.ok(out.includes('[추정] 인물 / characters 2 / name: 민아'),'low confidence character has [추정]');
 assert.ok(out.includes('[추정] 인물 / characters 2 / current_state: 불안'),'low confidence state has [추정]');
 assert.ok(out.includes('인물 / characters 3 / name: 준호') && !out.includes('[추정] 인물 / characters 3'),'high confidence character does not have [추정]');
 assert.ok(out.includes('[추정] 인물 / relations 1 / type: 의심'),'low confidence relation has [추정]');
 assert.ok(out.includes('인물 / relations 2 / type: 동행') && !out.includes('[추정] 인물 / relations 2'),'high confidence relation does not have [추정]');
 assert.ok(!out.includes('confidence: 0.3') && !out.includes('confidence: 0.85'),'raw confidence numbers are not emitted as text leaves');
});

test('GRADIA gracefully degrades oversized HAYAKU packets to summary memory, core entity/world state, rules and secrets',async()=>{
 const capture={};
 await load({testGlobals:{capture},transformSource:s=>s.replace('  const cleanFlashbackTurnText =','  capture.project = projectHayakuPacketText;\n  const cleanFlashbackTurnText =')});
 const p=createValidPacket();
 p.world.historical_events=[{summary:'ANCIENT_HISTORY_1'},{summary:'ANCIENT_HISTORY_2'}];
 p.world.world_rules=Array.from({length:20},(_,i)=>({text:'LONG_WORLD_RULE_'+i,exceptions:['EXCEPTION_'+i]}));
 p.narrative.scene_deltas=Array.from({length:10},(_,i)=>({before:'BEFORE_'+i,after:'AFTER_'+i}));
 p.planner.payoff_tracker=[{setup:'DEFERRED_SETUP',payoff:'DEFERRED_PAYOFF'}];
 p.entity.secrets=[{text:'SECRET_CONSPIRACY',known_to:['ALICE'],hidden_from:['BOB']}];
 p.meta.false_inferences=['DO_NOT_ASSUME_COMPROMISE'];

 // Default projection does not preemptively fold at 8,000 characters; keeps all leaves
 const full=capture.project(JSON.stringify(p));
 assert.ok(full.includes('ANCIENT_HISTORY_1'),'historical events kept in full projection');
 assert.ok(full.includes('BEFORE_0'),'scene deltas kept in full projection');
 assert.ok(full.includes('DEFERRED_SETUP'),'payoff tracker kept in full projection');
 assert.ok(full.includes('LONG_WORLD_RULE_19'),'world rules kept in full projection');
 assert.ok(full.includes('SECRET_CONSPIRACY'),'secrets kept in full projection');

 // Explicit fold option produces core summary + entity + world + locks + false_inferences + rules + secrets
 const folded=capture.project(JSON.stringify(p),{fold:true});
 assert.ok(folded.includes('Alice-1'),'core entity preserved');
 assert.ok(folded.includes('scene-1'),'core world preserved');
 assert.ok(folded.includes('remains associated'),'continuity locks preserved');
 assert.ok(folded.includes('DO_NOT_ASSUME_COMPROMISE'),'false inferences preserved');
 assert.ok(folded.includes('LONG_WORLD_RULE_19'),'world rules preserved in folded projection');
 assert.ok(folded.includes('EXCEPTION_19'),'world rule exceptions preserved in folded projection');
 assert.ok(folded.includes('SECRET_CONSPIRACY'),'entity secrets preserved in folded projection');
 assert.ok(folded.includes('ALICE') && folded.includes('BOB'),'secret disclosure boundaries preserved in folded projection');
 assert.ok(!folded.includes('ANCIENT_HISTORY_1'),'historical events folded away');
 assert.ok(!folded.includes('BEFORE_0'),'scene deltas folded away');
 assert.ok(!folded.includes('DEFERRED_SETUP'),'payoff tracker folded away');

 // Explicit maxChars option triggers fold when projection exceeds cap
 const autoFolded=capture.project(JSON.stringify(p),{maxChars:1000});
 assert.ok(autoFolded.includes('Alice-1'),'explicit maxChars folded core entity preserved');
 assert.ok(!autoFolded.includes('ANCIENT_HISTORY_1'),'explicit maxChars non-core historical events folded away');
});

const acorn=require('../tools/gradia/load-dev-dependency.cjs')('acorn');
const crypto=require('node:crypto');
function instrument(source){
 const ast=acorn.parse(source,{ecmaVersion:'latest'}),found=[];
 function walk(n){
  if(!n||typeof n!=='object')return;
  if(n.type==='ArrowFunctionExpression'&&source.slice(n.start,n.end).includes('shadow_act_disabled'))found.push(n);
  for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);
  else if(v&&typeof v==='object')walk(v);
 }
 walk(ast);
 const n=found.sort((a,b)=>a.end-a.start-(b.end-b.start))[0];
 assert.ok(n,'pipeline arrow function found');
 return source.slice(0,n.start)+'(globalThis.__testPipeline='+source.slice(n.start,n.end)+')'+source.slice(n.end);
}

const scope={scopeKey:'bound-scope',characterId:'character-library',chatId:'chat-evening'};
const character={chaId:scope.characterId,name:'Archivist',desc:'The archivist keeps the blue door.',personality:'Calm.',
 globalLore:[],chats:[{id:scope.chatId,localLore:[]}],chatPage:0};
const messages=()=>[
 {role:'user',messageId:'turn-u-101',content:'The archivist opened the door.'},
 {role:'assistant',messageId:'turn-a-102',generationInfo:{generationId:'generation-a-2'},content:'The archivist waited.'},
 {role:'user',messageId:'turn-u-103',content:'Continue the scene.'}
];

async function stagePipelineFixture({items,quickProfile='fast'}){
 const prompts=[];
 const host=await load({
  transformSource:instrument,
  testGlobals:{crypto:crypto.webcrypto},
  api:{
   getCharacter:async()=>character,
   nativeFetch:async(url,init)=>{
    prompts.push(JSON.parse(init.body));
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:'OK'},finish_reason:'stop'}]})};
   }
  }
 });
 await host.hooks.beforeRequest(messages(),'model');
 const owners=[...new Set(items.map(item=>item.owner))];
 const client={
  schema:'memory-suite.memory-read-client.v1',pluginId:'serial_gradation_agents_for_rp',
  openReadSession:async(_scope,options)=>({
   source:'unified_engine',
   snapshot:{
    schema:'memory-suite.memory-read-session.v1',scope,readOnly:true,complete:true,
    owners,items:items.map(item=>({...item,source:{namespace:item.owner,revision:1}})),
    evidenceRevision:'b'.repeat(64),
    corpusBytes:items.reduce((sum,item)=>sum+Buffer.byteLength(item.content),0),
    maxCorpusBytes:options.maxCorpusBytes
   },
   assertCurrentSync:()=>true,assertCurrent:async()=>true
  })
 };
 host.plugin.bindLibReadOnlyClient(client,{scope});
 const settings={
  ...host.plugin.getRuntime().settings,
  inputAssistMode:'off',enableShadowAct:true,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,
  multiPipelineMode:'lightweight',mode:'lite',failureMode:'hard',loreActivationMode:'off',
  quickProfile,defaultPresetName:'offline',
  presets:{
   offline:{
    provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'test',model:'test',
    request_format:'chat_completions',context_window:128000,max_tokens:4096,stream:false
   }
  }
 };
 const r=await host.pipeline(messages(),'model',settings);
 const status=host.plugin.getLibReadOnlyStatus();
 r.closeEvidence();
 const userText=prompts.map(p=>p.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n')).join('\n');
 return {status,userText,ok:r.ok};
}

test('GRADIA pipeline delivery Case A: preserves full rich semantic information (world rules, secrets, past history) when packet fits model budget',async()=>{
 const p=createValidPacket();
 p.world.world_rules=[{text:'RULE_CASE_A',exceptions:['EXCEPTION_CASE_A']}];
 p.entity.secrets=[{text:'SECRET_CASE_A',known_to:['ALICE_A'],hidden_from:['BOB_A']}];
 p.world.historical_events=[{summary:'HISTORICAL_ARCHIVE_CASE_A'}];
 p.narrative.scene_deltas=[{before:'DELTA_BEFORE_CASE_A',after:'DELTA_AFTER_CASE_A'}];
 p.planner.payoff_tracker=[{setup:'PAYOFF_SETUP_CASE_A',payoff:'PAYOFF_PAYOFF_CASE_A'}];

 const res=await stagePipelineFixture({
  items:[{owner:'hayaku',id:'h-case-a',key:'h-case-a',content:JSON.stringify(p)}]
 });
 assert.equal(res.ok,true);
 assert.equal(res.status.selection.selectedItems,1);
 assert.equal(res.status.selection.omittedItems,0);
 assert.ok(res.userText.includes('RULE_CASE_A'),'world rule present in prompt');
 assert.ok(res.userText.includes('EXCEPTION_CASE_A'),'world rule exception present in prompt');
 assert.ok(res.userText.includes('SECRET_CASE_A'),'secret present in prompt');
 assert.ok(res.userText.includes('ALICE_A') && res.userText.includes('BOB_A'),'secret boundaries present in prompt');
 assert.ok(res.userText.includes('HISTORICAL_ARCHIVE_CASE_A'),'historical archive present in prompt');
 assert.ok(res.userText.includes('DELTA_BEFORE_CASE_A'),'scene deltas present in prompt');
 assert.ok(res.userText.includes('PAYOFF_SETUP_CASE_A'),'payoff tracker present in prompt');
});

test('GRADIA pipeline delivery Case B: degrades oversized packet to folded version in prompt, preserving world rules and secrets while shedding verbose archives',async()=>{
 const p=createValidPacket();
 p.world.world_rules=[{text:'RULE_CASE_B',exceptions:['EXCEPTION_CASE_B']}];
 p.entity.secrets=[{text:'SECRET_CASE_B',known_to:['ALICE_B'],hidden_from:['BOB_B']}];
 // Make full projection ~55,000 characters so it exceeds the 48,000 char cap of 'fast' profile
 p.world.historical_events=Array.from({length:110},(_,i)=>({summary:'VERBOSE_HISTORICAL_LOG_'+i+'_'+'H'.repeat(450)}));
 p.narrative.scene_deltas=Array.from({length:10},(_,i)=>({before:'DELTA_BEFORE_'+i,after:'DELTA_AFTER_'+i}));

 const res=await stagePipelineFixture({
  items:[{owner:'hayaku',id:'h-case-b',key:'h-case-b',content:JSON.stringify(p)}],
  quickProfile:'fast'
 });
 assert.equal(res.ok,true);
 assert.equal(res.status.selection.selectedItems,1);
 assert.equal(res.status.selection.omittedItems,0);
 // Essential world rules, secrets, and core entities must be preserved
 assert.ok(res.userText.includes('RULE_CASE_B'),'world rule preserved in folded prompt');
 assert.ok(res.userText.includes('EXCEPTION_CASE_B'),'world rule exception preserved in folded prompt');
 assert.ok(res.userText.includes('SECRET_CASE_B'),'secret preserved in folded prompt');
 assert.ok(res.userText.includes('ALICE_B') && res.userText.includes('BOB_B'),'secret boundaries preserved in folded prompt');
 assert.ok(res.userText.includes('Alice-1'),'core character preserved in folded prompt');
 // Bulky historical archives and scene deltas must be shed
 assert.ok(!res.userText.includes('VERBOSE_HISTORICAL_LOG_0'),'verbose historical archives shed from prompt');
 assert.ok(!res.userText.includes('DELTA_BEFORE_0'),'scene deltas shed from prompt');
});

test('GRADIA pipeline delivery Case C: safely omits packet when even folded version exceeds budget, recording omittedItems',async()=>{
 const p=createValidPacket();
 // Even in folded mode, world rules are preserved. 110 world rules each ~450 chars = ~55,000 chars > 48,000 char budget
 p.world.world_rules=Array.from({length:110},(_,i)=>({text:'OVERSIZED_WORLD_RULE_'+i+'_'+'R'.repeat(450),exceptions:['EX_'+i]}));

 const res=await stagePipelineFixture({
  items:[
   {owner:'libra',id:'libra-anchor',key:'libra-anchor',content:'LIBRA_ANCHOR_MEMORY'},
   {owner:'hayaku',id:'h-case-c',key:'h-case-c',content:JSON.stringify(p)}
  ],
  quickProfile:'fast'
 });
 assert.equal(res.ok,true);
 assert.equal(res.status.selection.selectedItems,1,'only the fitting anchor is selected');
 assert.equal(res.status.selection.omittedItems,1,'oversized packet is safely omitted');
 assert.ok(res.userText.includes('LIBRA_ANCHOR_MEMORY'),'fitting anchor memory delivered to prompt');
 assert.ok(!res.userText.includes('OVERSIZED_WORLD_RULE_0'),'oversized packet omitted from prompt');
});
