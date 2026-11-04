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

