'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex'),clone=x=>JSON.parse(JSON.stringify(x));
async function fixture(){
 const r=await runtime(null,{transformCode:code=>code.replace('globalThis.__QUEUE_TEST__={','globalThis.__QUEUE_TEST__={cue:CharacterLoreCueIndex,sourceHints:CharacterEntitySourceHintBridge,')});
 r.api.MemoryEngine.CONFIG.cbsEnabled=false;
 const char={id:'native-reference-a',name:'Mira',lorebook:[{id:'native-origin',key:'Mira origin',comment:'native definition',content:'Mira remembers the amber observatory stair.'}]};
 const chat={id:'native-reference-chat-a',localLore:[]};
 const {cue,sourceHints}=r.context.__QUEUE_TEST__;cue.ensureLocalLoreEntry(char,chat);
 const read=()=>sourceHints.build(char,chat,'Mira origin observatory',{allowQueryEmbedding:false});
 return {r,char,chat,cue,sourceHints,read};
}
test('the internal lore hint consumer uses updated native body despite a persisted cue and CBS disabled',async()=>{
 const f=await fixture();assert((await f.read()).block.includes('amber observatory stair'));
 f.char.lorebook[0].content='Mira remembers the cobalt botanical bridge.';
 const before=hash({char:f.char,chat:f.chat}),result=await f.read();
 assert(result.block.includes('cobalt botanical bridge'));assert(!result.block.includes('amber observatory stair'));
 assert.equal(hash({char:f.char,chat:f.chat}),before,'read-only reference consumption preserves source and stored data');
 assert.equal(f.r.state.calls.length,0);
});
test('deleted native source text cannot survive through an old derived lore cue',async()=>{
 const f=await fixture();f.char.lorebook=[];const before=hash({char:f.char,chat:f.chat});
 assert(!(await f.read()).block.includes('amber observatory stair'));
 assert.equal(hash({char:f.char,chat:f.chat}),before);assert.equal(f.r.state.calls.length,0);
});
test('a copied cue from another character/chat cannot provide foreign source body',async()=>{
 const f=await fixture(),char={id:'native-reference-b',name:'Lyra',lorebook:[{id:'native-b',key:'Lyra origin',comment:'native definition',content:'Lyra maintains the violet orchard pavilion.'}]};
 const chat={id:'native-reference-chat-b',localLore:clone(f.chat.localLore)},before=hash({char,chat});
 const result=await f.sourceHints.build(char,chat,'Lyra origin orchard',{allowQueryEmbedding:false});
 assert(result.block.includes('violet orchard pavilion'));assert(!result.block.includes('amber observatory stair'));
 assert.equal(hash({char,chat}),before);assert.equal(f.r.state.calls.length,0);
});
test('an unchanged claimed source hash cannot authorize a forged persisted cue body',async()=>{
 const f=await fixture(),entry=f.chat.localLore.find(e=>e.comment==='lmai_character_lore_cues'),payload=JSON.parse(entry.content);
 const cue=payload.cues.find(c=>c.sourceType==='character_lorebook');cue.text='Mira FORGED_EXTERNAL_SOURCE_BODY';entry.content=JSON.stringify(payload);
 const before=hash({char:f.char,chat:f.chat}),result=await f.read();
 assert(result.block.includes('amber observatory stair'));assert(!result.block.includes('FORGED_EXTERNAL_SOURCE_BODY'));
 assert.equal(hash({char:f.char,chat:f.chat}),before);assert.equal(f.r.state.calls.length,0);
});
test('an explicit zero internal reference budget emits no native source block',async()=>{
 const f=await fixture(),before=hash({char:f.char,chat:f.chat});
 const result=await f.sourceHints.build(f.char,f.chat,'Mira origin',{limit:0,allowQueryEmbedding:false});
 assert.equal(result.count,0);assert.equal(result.block,'');assert.equal(result.items.length,0);
 assert.equal(hash({char:f.char,chat:f.chat}),before);assert.equal(f.r.state.calls.length,0);
});
test('the cue search endpoint honors an explicit zero result limit',async()=>{
 const f=await fixture(),before=hash({char:f.char,chat:f.chat});
 const result=await f.cue.search(f.char,f.chat,'Mira origin',{limit:0,cbsPreResolve:false,allowQueryEmbedding:false});
 assert.equal(result.count,0);assert.equal(result.items.length,0);assert.equal(result.vectorUsed,false);
 assert.equal(hash({char:f.char,chat:f.chat}),before);assert.equal(f.r.state.calls.length,0);
});
