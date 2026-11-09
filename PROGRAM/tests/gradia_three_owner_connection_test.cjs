'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom');const {load}=require('./gradia/host.cjs');
const createBus=require('./fixtures/libra_gradia_read_bus.cjs'),startOwnerSelections=require('./fixtures/gradia_owner_selection_stub.cjs');
const ownerIds={libra:'libra',hayaku:'hayaku_locator_continuity',flashback:'flashback_memory'},GRADIA='serial_gradation_agents_for_rp';
const PREF='serial_gradation_agents_for_rp:lib_read_connection:v1',url='http://127.0.0.1:47630',owners=['libra','hayaku','flashback'];
const scopes=Object.fromEntries(owners.map(o=>[o,{scopeKey:o+'-scope',characterId:'c',chatId:'h'}]));
// A missing owner is only known after its describe timeout (3s), so connection waits allow longer.
const wait=async fn=>{const start=Date.now();while(Date.now()-start<8000){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('NOT_SETTLED');};
// GRADIA reads every owner over plugin IPC in every storage mode (3dac4012). Each owner here is the
// real plugin-read owner endpoint answering with its own selection; a missing owner is simply not loaded.
async function fixture(t,{saved,withoutLibra=false,ownerScopes={}}={}){
 const local=new Map(),requests=[],writes=[],unloads=[];if(saved)local.set(PREF,JSON.stringify(saved));
 const store={getItem:async()=>null,setItem:async k=>{writes.push(k);},removeItem:async k=>{writes.push(k);}};
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'});
 const bus=createBus(),running=owners.filter(o=>!(withoutLibra&&o==='libra'));
 const stopOwners=await startOwnerSelections(bus,Object.fromEntries(running.map(o=>[o,{scope:ownerScopes[o]||scopes[o],content:o+' memory'}])));
 const transport=async target=>{requests.push({path:new URL(target).pathname});throw Error('NETWORK FORBIDDEN: GRADIA reads over plugin IPC');};
 const host=await load({api:{...bus.api(GRADIA),pluginStorage:store,getLocalPluginStorage:async()=>({getItem:async k=>local.get(k)??null,setItem:async(k,v)=>local.set(k,v)}),nativeFetch:transport,fetch:transport,onUnload:async fn=>unloads.push(fn),showContainer:async()=>{},hideContainer:async()=>{},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async()=>({chaId:'c',chats:[{id:'h'}]}),getChatFromIndex:async()=>({id:'h',message:[]})},testGlobals:{crypto:crypto.webcrypto,Response,window:dom.window,Element:dom.window.Element,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});
 t.after(async()=>{await host.plugin.closeSettingsGui();for(const f of unloads)await f();await stopOwners();dom.window.close();});
 await host.plugin.openSettingsGui();dom.window.document.querySelector('.sidebar [data-go="sources"]').click();
 const status=()=>host.plugin.getLibReadOnlyStatus(),connect=async()=>{dom.window.document.querySelector('#lib-connect').click();await wait(()=>['connected','error'].includes(status().connection.state));return status();};
 // Owners GRADIA asked, named by the plugin each request was addressed to.
 const asked=(action='describe')=>[...new Set(bus.messages.filter(m=>m.sender===GRADIA&&m.body.kind==='request'&&m.body.action===action).map(m=>Object.keys(ownerIds).find(o=>ownerIds[o]===m.target)))];
 writes.length=0;return{...host,dom,bus,local,requests,writes,status,connect,asked};}
test('explicit UI Connect uses all same-chat owners and saves scoped v2 consent',async t=>{const f=await fixture(t);assert.equal((await f.connect()).connection.state,'connected');assert.deepEqual(f.asked(),owners);assert.deepEqual(Array.from(f.status().connection.activeOwners),owners);const saved=JSON.parse(f.local.get(PREF));assert.equal(saved.schema,'gradia.lib-read-connection.v2');assert.deepEqual(saved.readOwners,owners);assert.equal(saved.readSource,'plugin_ipc');assert.equal(f.writes.length,0);assert.equal(f.requests.length,0);assert(f.dom.window.document.body.textContent.includes('HAYAKU'));});
test('old saved exact-URL consent auto-connects only LIBRA until explicit reconnect',async t=>{const f=await fixture(t,{saved:{schema:'gradia.lib-read-connection.v1',url,explicit:true}});await wait(()=>f.status().connection.state==='connected');assert.deepEqual(f.asked(),['libra']);assert.deepEqual(Array.from(f.status().connection.readOwners),['libra']);await f.connect();assert(f.asked().includes('hayaku'));});
test('plugin IPC connection reads HAYAKU and Flashback without the LIBRA plugin',async t=>{const f=await fixture(t,{withoutLibra:true});const status=(await f.connect()).connection;assert.equal(status.state,'connected',JSON.stringify(status));assert.deepEqual(Array.from(status.activeOwners),['hayaku','flashback']);assert.equal(f.local.has(PREF),true);assert.equal(f.requests.length,0);});
test('choosing plugin IPC in settings connects without the LIBRA plugin',async t=>{
 const f=await fixture(t,{withoutLibra:true}),select=f.dom.window.document.querySelector('#lib-read-source');
 assert.deepEqual([...select.options].map(o=>o.value),['off','plugin_ipc'],'the retired server search option is gone');
 select.value='plugin_ipc';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));const status=(await f.connect()).connection;
 assert.equal(status.state,'connected',JSON.stringify(status));assert.equal(f.requests.length,0);assert.equal(f.local.has(PREF),true);
});
test('an owner answering for another chat is not read and never replaced by a guess',async t=>{const f=await fixture(t,{ownerScopes:{hayaku:{scopeKey:'other',characterId:'c',chatId:'other-chat'}}});const status=(await f.connect()).connection;assert.equal(status.state,'connected',JSON.stringify(status));assert.deepEqual(Array.from(status.activeOwners),['libra','flashback']);});
// Saved grants remain exact: Flashback is loaded and available but was never granted.
test('v2 startup reuses exactly the saved owner subset, never newly available owners',async t=>{const f=await fixture(t,{saved:{schema:'gradia.lib-read-connection.v2',url,explicit:true,readOwners:['libra','hayaku']}});await wait(()=>f.status().connection.state==='connected');assert.deepEqual(f.asked(),['libra','hayaku']);assert.deepEqual(Array.from(f.status().connection.readOwners),['libra','hayaku']);});
test('malformed or unknown saved reader grants never contact an owner',async t=>{for(const readOwners of [[],['unknown-owner'],['hayaku','hayaku'],'hayaku']){const f=await fixture(t,{saved:{schema:'gradia.lib-read-connection.v2',url,explicit:true,readOwners}});await new Promise(r=>setTimeout(r,50));assert.deepEqual(f.asked(),[]);assert.equal(f.requests.length,0);assert.notEqual(f.status().connection.state,'connected');}});
