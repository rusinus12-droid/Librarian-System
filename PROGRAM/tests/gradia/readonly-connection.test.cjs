'use strict';
// GRADIA's read-only memory connection. Since 3dac4012 (GRADIA 0.29.2) every owner answers GRADIA
// over plugin IPC in every storage mode, so the connection contract is checked against real
// plugin-read owner endpoints: GRADIA never contacts the memory server, never writes owner storage,
// and saves only its own local consent. Server-only contracts are kept below as retired skips.
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom');
const {load}=require('./host.cjs');
const createBus=require('../fixtures/libra_gradia_read_bus.cjs'),startOwnerSelections=require('../fixtures/gradia_owner_selection_stub.cjs');
const PREF='serial_gradation_agents_for_rp:lib_read_connection:v1',GRADIA='serial_gradation_agents_for_rp';
const URL_SAVED='http://127.0.0.1:47630',owners=['libra','hayaku','flashback'];
const scope={scopeKey:'registered',characterId:'c',chatId:'h'};
const RETIRED='retired in GRADIA 0.29.2 (3dac4012): GRADIA no longer reads through the memory server; ';
const wait=async fn=>{const start=Date.now();while(Date.now()-start<8000){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Connection action did not settle');};
async function fixture(t,options={}){
 const local=new Map();if(options.preference)local.set(PREF,JSON.stringify({...options.preference,url:options.preference.url||URL_SAVED}));
 const bus=createBus();let mutated=false;
 const stopOwners=options.ownerUnavailable?async()=>{}:await startOwnerSelections(bus,Object.fromEntries(owners.map(o=>[o,{scope,content:o+' memory',onQuery:()=>{throw Error('Connection inspection must not query memory');}}])),{isMutated:()=>mutated});
 const writes=[],requests=[],unloads=[],locals=[];let currentChat={id:'h',message:[]},releasePreference,releaseNative,failRevocation=options.failInitialRevocation?1:0,nativeReads=0,currentIndex=0,capturedPlugin,firstPreferenceRead=true,describeHold=null;const chatRows={0:currentChat,1:{id:'other',message:[]}};
 const storage={getItem:async()=>null,setItem:async k=>{writes.push(k);},removeItem:async k=>{writes.push(k);}};
 const localStorage={getItem:async k=>{const value=local.get(k)??null;if(options.disconnectDuringRead&&firstPreferenceRead&&k===PREF){firstPreferenceRead=false;await capturedPlugin.unbindLibReadOnlyClient();}return value;},setItem:async(k,v)=>{locals.push(k);if(failRevocation>0&&JSON.parse(v).explicit===false){failRevocation--;throw Error('SYNTHETIC_LOCAL_WRITE_FAILURE');}if(options.delayPreference&&JSON.parse(v).explicit===true)await new Promise(r=>releasePreference=r);local.set(k,v);},removeItem:async k=>{locals.push(k);local.delete(k);}};
 // GRADIA has no reason to touch the network for memory: any request is recorded and refused.
 const transport=async u=>{requests.push({url:String(u)});throw Error('NETWORK FORBIDDEN: GRADIA reads over plugin IPC');};
 // GRADIA's own channel endpoint. A held describe models an owner that has not answered yet.
 const channel=bus.api(GRADIA),gradiaApi={...channel,postPluginChannelMessage:async(target,name,message)=>{
  if(describeHold&&message?.kind==='request'&&message.action==='describe'){const hold=describeHold;hold.enter();await hold.promise;}
  return channel.postPluginChannelMessage(target,name,message);}};
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'});
 const host=await load({transformSource:s=>(options.disconnectDuringRead||options.disconnectBeforeStart)?`{let value;Object.defineProperty(globalThis,'__SerialGradationAgentsForRP',{configurable:true,get:()=>value,set:v=>{value=v;__captureApi(v);}});}`+s:s,api:{...(options.ownerUnavailable?{}:gradiaApi),pluginStorage:storage,getLocalPluginStorage:async()=>localStorage,nativeFetch:transport,fetch:transport,onUnload:async fn=>unloads.push(fn),showContainer:async()=>{},hideContainer:async()=>{},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>currentIndex,getCharacterFromIndex:async()=>{if(options.delayFinalNative&&++nativeReads===2)await new Promise(r=>releaseNative=r);return {chaId:'c',chats:Object.values(chatRows)};},getCharacter:async()=>({chaId:'c',chats:[currentChat]}),getChatFromIndex:async(_c,index)=>chatRows[index]},testGlobals:{__captureApi:value=>{capturedPlugin=value;if(options.disconnectBeforeStart)void value.unbindLibReadOnlyClient().catch(()=>{});},crypto:crypto.webcrypto,Response,window:dom.window,Element:dom.window.Element,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});
 t.after(async()=>{describeHold?.release?.();releasePreference?.();releaseNative?.();await host.plugin.closeSettingsGui();for(const fn of unloads)await fn();await stopOwners();dom.window.close();});
 const initial={writes:[...writes],locals:[...locals],requests:[...requests],asked:bus.messages.filter(m=>m.sender===GRADIA).length};
 await host.plugin.openSettingsGui();dom.window.document.querySelector('.sidebar [data-go="sources"]').click();
 const doc=dom.window.document;
 const node=selector=>{const n=doc.querySelector(selector);assert.ok(n,selector);return n;};
 const click=action=>node(action==='inspect'?'#lib-check':`#lib-${action}`).click();
 const status=()=>host.plugin.getLibReadOnlyStatus();
 const connect=async()=>{click('connect');await wait(()=>['connected','error'].includes(status().connection?.state));return status();};
 const importPayload=async()=>{node('[data-manage-action="import-replace"]').click();const confirm=await wait(()=>doc.querySelector('.overlay.is-open .dialog button.btn--primary'));confirm.click();};
 // Requests GRADIA sent to owners, by action.
 const asked=action=>bus.messages.filter(m=>m.sender===GRADIA&&m.body.kind==='request'&&(!action||m.body.action===action));
 const holdDescribe=()=>{let release,enter;const promise=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enter=resolve);describeHold={promise,enter,release:()=>{describeHold=null;release();}};return describeHold;};
 return {...host,bus,local,writes,locals,requests,initial,doc,node,click,connect,importPayload,status,asked,holdDescribe,
  failRevokeOnce:()=>{failRevocation=1;},releasePreference:()=>releasePreference?.(),preferenceWaiting:()=>!!releasePreference,
  setChat:id=>{currentChat={id,message:[]};chatRows[currentIndex]=currentChat;},switchIndex:()=>{currentIndex=1;currentChat=chatRows[1];},
  nativeWaiting:()=>!!releaseNative,releaseNative:()=>releaseNative?.(),mutateOwners:()=>{mutated=true;},unload:async()=>{for(const fn of unloads)await fn();}};
}
test('fresh startup and unapproved saved consent perform no connection writes or owner reads',async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:false}});
 assert.deepEqual(h.initial.requests,[]);assert.deepEqual(h.initial.locals,[]);assert.deepEqual(h.initial.writes,[]);assert.equal(h.initial.asked,0);
 assert.equal(h.status().connection?.state,'disconnected');assert.ok(h.node('[data-page="sources"] .state-grid > div:nth-child(4)').textContent.includes('모델·문맥 설정 기준'));
});
test('actual Connect and inspect use only owner describes and never touch the network or owner storage',async t=>{
 const h=await fixture(t),start=h.writes.length;assert.equal((await h.connect()).connection.state,'connected');
 assert.ok(h.asked().every(m=>m.body.action==='describe'),'connecting only asks owners to describe their scope');
 h.click('inspect');await wait(()=>h.status().connection?.corpus?.source==='plugin_ipc');
 assert.equal(h.status().connection.corpus.queried,false);assert.equal(h.status().connection.readSource,'plugin_ipc');
 assert.ok(h.asked().every(m=>m.body.action==='describe'),'inspection does not query memory');
 assert.deepEqual(h.requests,[]);assert.deepEqual(h.writes.slice(start),[]);assert.deepEqual([...new Set(h.locals)],[PREF]);assert.equal(JSON.parse(h.local.get(PREF)).explicit,true);
 assert.equal(h.status().status,'bound');assert.equal(h.getCalls(),0);assert.equal(h.plugin.createPluginStorageProxy,undefined);assert.equal(h.plugin.configureConnection,undefined);
});
test('missing or ambiguous native registry fails without bootstrap, guesses, or registry mutation',{skip:RETIRED+'owners resolve their own scope and GRADIA reads no server scope registry (an owner answering for another chat is covered in gradia_three_owner_connection_test)'},()=>{});
test('an owner whose storage boundary is changing is not read and nothing replaces it',async t=>{
 const h=await fixture(t);h.mutateOwners();assert.equal((await h.connect()).connection.state,'error');
 assert.match(h.status().connection.reason,/LIB_READ_/);assert.equal(h.asked('select').length,0);assert.deepEqual(h.requests,[]);assert.notEqual(h.status().status,'bound');
});
test('disconnect and unload prevent a late owner answer from publishing a binding',async t=>{
 for(const cancel of ['disconnect','unload']){const h=await fixture(t),hold=h.holdDescribe();h.click('connect');await hold.entered;
  if(cancel==='unload')await h.unload();else h.click('disconnect');hold.release();await new Promise(r=>setTimeout(r,50));
  assert.notEqual(h.status().status,'bound',cancel);assert.notEqual(h.status().connection.state,'connected',cancel);assert.equal(h.asked('select').length,0);}
});
test('native chat change discards current binding and corpus without automatic reconnection',async t=>{
 const h=await fixture(t);await h.connect();const describes=h.asked('describe').length;h.setChat('other');await wait(()=>h.status().status!=='bound');
 assert.equal(h.status().connection.corpus,null);assert.match(h.status().connection.reason,/LIB_READ_NATIVE_SCOPE_CHANGED/);
 await new Promise(r=>setTimeout(r,100));assert.equal(h.asked('describe').length,describes,'no automatic reconnection');
});
test('transport refusal is an explicit terminal state with one bootstrap attempt',{skip:RETIRED+'there is no server transport to refuse; a missing owner is covered by "missing owner support cannot fall back"'},()=>{});
test('startup only reuses locally saved explicit connection consent for that exact URL',async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:true}});await wait(()=>h.status().connection?.state==='connected');
 assert.deepEqual(h.initial.locals,[]);assert.deepEqual(h.requests,[]);
 const other=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:true,url:'http://127.0.0.1:47630/'}});
 await new Promise(r=>setTimeout(r,100));assert.notEqual(other.status().connection.state,'connected','consent saved for a different spelling is not reused');
});
test('canceling pending preference persistence cannot restore startup consent',async t=>{
 for(const cancel of ['disconnect','unload']){
 const h=await fixture(t,{delayPreference:true});h.click('connect');await wait(h.preferenceWaiting);
 if(cancel==='unload'){const unloading=h.unload();h.releasePreference();await unloading;}else h.click('disconnect');
 h.releasePreference();await new Promise(r=>setTimeout(r,50));
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,false,cancel);assert.notEqual(h.status().status,'bound');}
});
test('connection card reports native invalidation as it occurs',async t=>{
 const h=await fixture(t);await h.connect();await wait(()=>h.node('#lib-state').textContent.includes('connected'));
 h.setChat('other');await wait(()=>h.node('#lib-state').textContent.includes('LIB_READ_NATIVE_SCOPE_CHANGED'));
 assert.equal(h.node('#lib-check').disabled,true);
});
test('settings import never imports or retains automatic connection consent',async t=>{
 const h=await fixture(t);await h.connect();const describes=h.asked('describe').length;await h.plugin.debugNavigateGui('transfer','flow');
 const box=h.doc.querySelector('#mockup-import-text');assert.ok(box);
 box.value=JSON.stringify({runtime:{mode:'off',libReadConnection:{url:URL_SAVED,explicit:true}},providerPresets:{offline:{provider:'openai',model:'test-offline',url:'https://api.openai.com/v1/chat/completions'}}});
 box.dispatchEvent(new h.doc.defaultView.Event('input',{bubbles:true}));
 await h.importPayload();
 await wait(()=>h.local.get(PREF)&&JSON.parse(h.local.get(PREF)).explicit===false);
 assert.notEqual(h.status().status,'bound');assert.equal(h.asked('describe').length,describes,'imported consent never connects');
});
test('non-loopback and credential-bearing URLs never bootstrap',{skip:RETIRED+'the server URL field is disabled and no connection uses a URL'},()=>{});
test('failed consent revocation stays retryable through a later Disconnect',async t=>{
 const h=await fixture(t);await h.connect();h.failRevokeOnce();h.click('disconnect');
 await wait(()=>h.doc.body.textContent.includes('LIB_READ_PREFERENCE_UNAVAILABLE'));
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,true,'simulate durable write failure');
 h.click('disconnect');await wait(()=>JSON.parse(h.local.get(PREF)).explicit===false);
 assert.notEqual(h.status().status,'bound');
});
test('existing accepted reset witness is required and remains unchanged',{skip:RETIRED+'server data-reset witnesses belong to the owners\' own storage, which GRADIA no longer reads'},()=>{});
test('normal loopback URL with a trailing slash is canonicalized before Connect',{skip:RETIRED+'the server URL field is disabled and no connection uses a URL'},()=>{});
test('unload waits for in-flight consent write and its compensating revocation',async t=>{
 const h=await fixture(t,{delayPreference:true});h.click('connect');await wait(h.preferenceWaiting);
 let finished=false;const pending=h.unload().then(()=>{finished=true;});
 await new Promise(r=>setTimeout(r,25));assert.equal(finished,false);
 h.releasePreference();await pending;assert.equal(JSON.parse(h.local.get(PREF)).explicit,false);
});
test('chat change during preference persistence cannot briefly publish the old binding',async t=>{
 const h=await fixture(t,{delayPreference:true});h.click('connect');await wait(h.preferenceWaiting);
 h.setChat('other');h.releasePreference();await wait(()=>h.status().connection.state!=='connecting');
 assert.notEqual(h.status().status,'bound');await wait(()=>JSON.parse(h.local.get(PREF)).explicit===false);
});
test('Disconnect during initial consent read durably suppresses later startup consent',async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:true},disconnectDuringRead:true});
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,false);assert.equal(h.asked().length,0);assert.notEqual(h.status().status,'bound');
});
test('native selection changing during final fixed-index reads is rejected before binding',async t=>{
 const h=await fixture(t,{delayFinalNative:true});h.click('connect');await wait(h.nativeWaiting);
 h.switchIndex();h.releaseNative();await wait(()=>h.status().connection.state==='error');assert.deepEqual(h.requests,[]);assert.notEqual(h.status().status,'bound');
});
test('import reports a failed auto-connect revocation instead of silently accepting it',async t=>{
 const h=await fixture(t);await h.connect();h.failRevokeOnce();await h.plugin.debugNavigateGui('transfer','flow');
 const box=h.doc.querySelector('#mockup-import-text');box.value=JSON.stringify({runtime:{mode:'off'},providerPresets:{offline:{provider:'openai',model:'test-offline',url:'https://api.openai.com/v1/chat/completions'}}});box.dispatchEvent(new h.doc.defaultView.Event('input',{bubbles:true}));
 await h.importPayload();
 await wait(()=>h.doc.body.textContent.includes('LIB_READ_PREFERENCE_UNAVAILABLE'));
 assert.notEqual(h.status().status,'bound');assert.equal(JSON.parse(h.local.get(PREF)).explicit,true);
});
test('Disconnect before startup preference loading suppresses that startup and saved consent',async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:true},disconnectBeforeStart:true});
 await wait(()=>JSON.parse(h.local.get(PREF)).explicit===false);assert.equal(h.asked().length,0);assert.notEqual(h.status().status,'bound');
});
for(const timing of ['disconnectBeforeStart','disconnectDuringRead'])test(`failed ${timing} revocation remains retryable after startup settles`,async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:true},[timing]:true,failInitialRevocation:true});
 assert.equal(h.asked().length,0,'canceled startup must not contact an owner');
 assert.equal(h.status().connection.reason,'LIB_READ_PREFERENCE_UNAVAILABLE','failed revocation is visible');
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,true,'first synthetic revocation failed');
 const writes=h.locals.length;await h.plugin.unbindLibReadOnlyClient();
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,false,'retry must persist revocation even after startup clears pending state');
 assert.ok(h.locals.length>writes,'retry must make a new persistence attempt');
 assert.equal(h.asked().length,0);assert.notEqual(h.status().status,'bound');
});
test('old saved server read-source choices migrate to plugin IPC and the server option is absent',async t=>{
 for(const readSource of ['server_logical_read','unified_engine']){
  const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v2',explicit:true,readOwners:['libra'],readSource}});
  await wait(()=>h.status().connection?.state==='connected');assert.equal(h.status().connection.readSource,'plugin_ipc',readSource);
  assert.deepEqual([...h.node('#lib-read-source').options].map(o=>o.value),['off','plugin_ipc']);assert.deepEqual(h.requests,[]);}
});
test('missing owner support cannot fall back to a server read',async t=>{
 const h=await fixture(t,{ownerUnavailable:true});assert.equal((await h.connect()).connection.state,'error');
 // Memory owners are optional (GRADIA 0.26.15): with no owner channel there is no owner scope to
 // resolve, and nothing may stand in for the missing owners.
 assert.match(h.status().connection.reason,/LIB_READ_(?:PLUGIN_OWNERS|OWNER)_UNAVAILABLE/);
 assert.deepEqual(h.requests,[],'no network read may replace the missing owners');
 assert.notEqual(h.status().status,'bound');
});
test('settings applies plugin IPC through the real read-only connection and saves verified consent',async t=>{
 const h=await fixture(t);await h.plugin.debugNavigateGui('references','flow');
 assert.equal(h.node('#lib-url').disabled,true,'the server URL is not used');
 const select=h.node('#lib-read-source');select.value='plugin_ipc';select.dispatchEvent(new h.doc.defaultView.Event('change',{bubbles:true}));
 assert.equal(h.asked().length,0,'selecting a mode cannot connect');
 assert.equal(h.status().connection.state,'disconnected');
 h.node('#lib-connect').click();await wait(()=>h.status().connection.state==='connected');
 assert.equal(h.status().connection.readSource,'plugin_ipc');
 const saved=JSON.parse(h.local.get(PREF));assert.equal(saved.readSource,'plugin_ipc');assert.equal(saved.explicit,true);
 select.value='off';select.dispatchEvent(new h.doc.defaultView.Event('change',{bubbles:true}));
 assert.equal(h.status().connection.readSource,'plugin_ipc','an unapplied selection must not relabel the active binding');
 assert.equal(h.node('#lib-read-source').value,'off');
 h.node('#lib-disconnect').click();await wait(()=>JSON.parse(h.local.get(PREF)).explicit===false);
 assert.equal(h.status().status,'unavailable');assert.deepEqual(h.requests,[]);
});
test('a failed settings mode switch reports no active connection and never falls back to a server',async t=>{
 const h=await fixture(t,{ownerUnavailable:true});await h.plugin.debugNavigateGui('references','flow');
 const select=h.node('#lib-read-source');select.value='plugin_ipc';select.dispatchEvent(new h.doc.defaultView.Event('change',{bubbles:true}));
 assert.equal(h.requests.length,0);assert.equal(h.node('#lib-url').disabled,true);
 h.node('#lib-connect').click();await wait(()=>h.status().connection.state==='error');
 assert.equal(h.status().status,'unavailable');assert.equal(h.requests.length,0,'plugin mode must not contact the server');
 assert.equal(h.node('#lib-check').disabled,true);
});
test('pending explicit inspection retains the connected card and does not reconnect',async t=>{
 const h=await fixture(t);await h.connect();const before=JSON.stringify(h.local.get(PREF)),hold=h.holdDescribe();
 try{h.click('inspect');await hold.entered;assert.equal(h.status().connection.state,'connected');
 assert.match(h.node('#lib-state').textContent,/connected/);
 }finally{hold.release();}
 await wait(()=>h.status().connection.corpus?.source==='plugin_ipc');
 assert.equal(h.status().connection.state,'connected');assert.equal(JSON.stringify(h.local.get(PREF)),before,'inspection does not reconnect or re-consent');
});
test('settings memory check displays progress and its result in the owning card',async t=>{
 const h=await fixture(t);await h.connect();await h.plugin.debugNavigateGui('references','flow');
 const hold=h.holdDescribe(),button=h.node('#lib-check');button.click();await hold.entered;
 try{assert.equal(button.disabled,true);assert.match(button.textContent,/확인 중/);}
 finally{hold.release();}
 await wait(()=>h.status().connection.lastInspection?.ok);
 assert.match(h.node('#lib-state').textContent,/connected/);
 assert.equal(h.node('#lib-check').disabled,false);
 assert.equal(h.asked('select').length,0,'a check never reads memory');
});
test('a failed memory check displays the refusal beside its button',async t=>{
 const h=await fixture(t);await h.connect();await h.plugin.debugNavigateGui('references','flow');
 h.setChat('replaced');h.node('#lib-check').click();
 await wait(()=>h.status().connection.lastInspection?.ok===false);
 assert.match(h.node('#lib-state').textContent,/LIB_READ_NATIVE_SCOPE_CHANGED/);
});
