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

test('GRADIA gracefully degrades oversized HAYAKU packets to summary memory and core entity/world state',async()=>{
 const capture={};
 await load({testGlobals:{capture},transformSource:s=>s.replace('  const cleanFlashbackTurnText =','  capture.project = projectHayakuPacketText;\n  const cleanFlashbackTurnText =')});
 const p=createValidPacket();
 p.world.historical_events=[{summary:'ANCIENT_HISTORY_1'},{summary:'ANCIENT_HISTORY_2'}];
 p.world.world_rules=Array.from({length:20},(_,i)=>({text:'LONG_WORLD_RULE_'+i,exceptions:['EXCEPTION_'+i]}));
 p.narrative.scene_deltas=Array.from({length:10},(_,i)=>({before:'BEFORE_'+i,after:'AFTER_'+i}));
 p.planner.payoff_tracker=[{setup:'DEFERRED_SETUP',payoff:'DEFERRED_PAYOFF'}];
 p.meta.false_inferences=['DO_NOT_ASSUME_COMPROMISE'];

 // Explicit fold option produces core summary + entity + world + locks + false_inferences
 const folded=capture.project(JSON.stringify(p),{fold:true});
 assert.ok(folded.includes('Alice-1'),'core entity preserved');
 assert.ok(folded.includes('scene-1'),'core world preserved');
 assert.ok(folded.includes('remains associated'),'continuity locks preserved');
 assert.ok(folded.includes('DO_NOT_ASSUME_COMPROMISE'),'false inferences preserved');
 assert.ok(!folded.includes('ANCIENT_HISTORY_1'),'historical events folded away');
 assert.ok(!folded.includes('LONG_WORLD_RULE_19'),'verbose world rules folded away');
 assert.ok(!folded.includes('DEFERRED_SETUP'),'payoff tracker folded away');

 // Automatic fold triggered when packet projection exceeds maxChars
 const autoFolded=capture.project(JSON.stringify(p),{maxChars:1000});
 assert.ok(autoFolded.includes('Alice-1'),'auto-folded core entity preserved');
 assert.ok(!autoFolded.includes('ANCIENT_HISTORY_1'),'auto-folded non-core leaves omitted to prevent packet drop');
});
