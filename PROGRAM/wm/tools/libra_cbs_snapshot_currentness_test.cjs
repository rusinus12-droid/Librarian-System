'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./libra_recall_test_runtime.cjs');
let networkCalls=0;
const noNetwork=async()=>{networkCalls++;throw new Error('No network/model transport in CBS regression');};
test.after(()=>assert.equal(networkCalls,0));
async function fixture(){
 const f=await load({globals:{fetch:noNetwork},transformCode(code){const i=code.lastIndexOf('\n})();');return code.slice(0,i)+'\n;globalThis.__CBS_CURRENT__={CBSEngine,CharacterLoreCbsPreResolver,CharacterLoreCueIndex};\n'+code.slice(i);}});
 f.context.risuai.nativeFetch=noNetwork;
 const {CBSEngine:cbs,CharacterLoreCbsPreResolver:resolver,CharacterLoreCueIndex:cue}=f.context.__CBS_CURRENT__;
 f.api.MemoryEngine.CONFIG.cbsEnabled=true;f.char.name='Mira';f.char.lorebook=[{id:'native-origin',key:'Mira origin',comment:'native definition',content:'Mira remembers the amber observatory stair.'}];
 f.chat.localLore=[{key:'lmai_memory::1',comment:'lmai_memory',content:'Synthetic managed memory.'}];
 const ctx={char:f.char,chat:f.chat};await resolver.resolve(ctx);assert(resolver.peek(ctx));
 return {...f,cbs,resolver,cue,ctx,text:()=>JSON.stringify(cue.buildPayload(f.char,f.chat))};
}
function holdCompletedResolution(f){
 const original=f.cbs.preResolveCharacterLore;let unlock,entered;
 const gate=new Promise(r=>unlock=r),ready=new Promise(r=>entered=r);
 f.cbs.preResolveCharacterLore=async context=>{const result=await original(context);entered();await gate;return result;};
 return {ready,unlock};
}
test('CBS-on native edits and deletions reach actual normalizer without another resolver',async()=>{
 const f=await fixture();f.char.lorebook[0].content='Mira remembers the cobalt botanical bridge.';
 await f.api.MemoryEngine.normalizeLoreStorage(f.char,f.chat);let text=JSON.stringify(f.chat.localLore);
 assert(text.includes('cobalt botanical bridge'));assert(!text.includes('amber observatory stair'));
 await f.resolver.resolve(f.ctx);f.char.lorebook=[];
 await f.api.MemoryEngine.normalizeLoreStorage(f.char,f.chat);text=JSON.stringify(f.chat.localLore);
 assert(!text.includes('cobalt botanical bridge'));assert(!text.includes('amber observatory stair'));
});
test('resolution finishing after native deletion cannot resurrect its old source',async()=>{
 const f=await fixture(),hold=holdCompletedResolution(f),work=f.resolver.resolve(f.ctx);await hold.ready;
 f.char.lorebook=[];hold.unlock();await work;assert.equal(f.resolver.peek(f.ctx),null);assert(!f.text().includes('amber observatory stair'));
});
test('same-scope late completion after a newer native edit cannot replace current cue text',async()=>{
 const f=await fixture(),hold=holdCompletedResolution(f),work=f.resolver.resolve(f.ctx);await hold.ready;
 f.char.lorebook[0].content='Mira remembers the cobalt botanical bridge.';hold.unlock();await work;
 assert.equal(f.resolver.peek(f.ctx),null);assert(f.text().includes('cobalt botanical bridge'));assert(!f.text().includes('amber observatory stair'));
});
test('late resolver result cannot be rebound to a different chat scope',async()=>{
 const f=await fixture(),hold=holdCompletedResolution(f),work=f.resolver.resolve(f.ctx);await hold.ready;
 f.chat.id='different-chat';hold.unlock();await work;
 assert.equal(f.resolver.peek(f.ctx),null,'captured source proof includes its original chat scope');
});
test('late resolver result cannot cross a runtime reset generation',async()=>{
 const f=await fixture(),hold=holdCompletedResolution(f),work=f.resolver.resolve(f.ctx);await hold.ready;
 f.api.MemoryState.initVersion++;f.api.MemoryState.cbsResolvedCharacterLoreByScope.clear();hold.unlock();await work;
 assert.equal(f.resolver.peek(f.ctx),null,'captured source proof includes runtime generation');
});
test('CBS switched off during resolve cannot reuse late cached entries',async()=>{
 const f=await fixture(),hold=holdCompletedResolution(f),work=f.resolver.resolve(f.ctx);await hold.ready;
 f.api.MemoryEngine.CONFIG.cbsEnabled=false;f.char.lorebook=[];hold.unlock();await work;
 assert.equal(f.resolver.peek(f.ctx),null);assert(!f.text().includes('amber observatory stair'));
});
test('unchanged CBS macros still resolve and cue builds perform one validation without re-resolving',async()=>{
 const f=await fixture();f.char.lorebook[0].content='{{char}} remembers the violet orchard.';await f.resolver.resolve(f.ctx);
 let resolutions=0,validations=0;const resolve=f.cbs.preResolveCharacterLore,source=f.cbs.getCharacterLoreSourceSignature;
 f.cbs.preResolveCharacterLore=(...args)=>{resolutions++;return resolve(...args);};
 f.cbs.getCharacterLoreSourceSignature=(...args)=>{validations++;return source(...args);};
 const text=f.text();assert(text.includes('Mira remembers the violet orchard.'));assert(!text.includes('{{char}}'));assert.equal(resolutions,0);assert.equal(validations,1);
});
