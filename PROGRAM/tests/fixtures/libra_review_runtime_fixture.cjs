'use strict';
// Full shipped LIBRA in the repository VM harness. Synthetic, non-sensitive U+A.
// Model/host/storage are boundary fixtures, not a RisuAI installation.
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./libra_vm_harness.cjs');
const {createRootBoundary}=require('./source_edit_root_boundary.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitRoot=async root=>{for(let i=0;i<500;i++){if(await root.ready())return;await delay(5);}throw Error('review_dialog_timeout');};
const clone=x=>JSON.parse(JSON.stringify(x));
async function fixture(){
 const root=createRootBoundary();
 const chat={id:'preserve-chat',chatId:'preserve-chat',name:'Safety fixture',message:[]};
 for(let n=1;n<=5;n++)chat.message.push({role:'user',chatId:'u'+n,data:'Please describe the office '+n+'.'},
 {role:'assistant',chatId:'a'+n,data:n===1?'Alice signed the office agreement.':'Alice waited in the office '+n+'.'});
 chat.messages=chat.message;
 const character={id:'preserve-char',chaId:'preserve-char',name:'Alice',chatPage:0,chats:[chat]};
 // calls stays a COUNT for the suites that compare it numerically; callArgs records the arguments so
// a suite can tell the Canonical pass apart from the one-turn Micro producer.
 const control={calls:0,callArgs:[],modelFails:false,hooks:{}};
 const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getChar:async()=>character,
 getCharacterFromIndex:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,
 getRootDocument:async()=>root.root,
 getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[character],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},
 addRisuReplacer:async(mode,fn)=>{control.hooks[mode]=fn;return true;},
 runLLMModel:async(...args)=>{control.calls++;control.callArgs.push(args);if(control.modelFails)return {type:'error',result:'synthetic_provider_failure'};
 const quote=chat.message[1].data;return {type:'success',result:JSON.stringify(require('./librarian_event_fixture.cjs')(quote,'t1-a'))};}};
 const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
 const settings=await r.api.getLibraMemorySettings();
 await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
 const first=await r.api.runManualColdStart();assert.equal(first.completed,1,JSON.stringify(first));await r.api.retryPendingUnifiedVectors();
 const manifestKey=[...r.values.keys()].find(k=>k.startsWith('libra')&&k.endsWith(':manifest'));
 assert.ok(manifestKey);
 const getManifest=()=>JSON.parse(r.values.get(manifestKey));
 const oldRef=clone(getManifest().memories['1']),oldBytes=r.values.get(oldRef.key),initialCalls=control.calls;
 // The Canonical pass is the work these suites budget for; the one-turn Micro producer adds its own
 // calls per completed turn, so the initial Canonical count is captured alongside the raw count.
 const {classifyCall}=require('./libra_provider_call_kinds.cjs');
 const initialCanonical=control.callArgs.filter(args=>classifyCall(args)==='canonical').length;
 const decide=async yes=>{await r.sourceEditBoundary();const promise=r.api.reviewSourceEdits();await waitRoot(root);await root.click(yes);return await promise;};
 return {r,chat,control,getManifest,manifestKey,oldRef,oldBytes,initialCalls,initialCanonical,decide};
}
module.exports={fixture,waitRoot,clone};
