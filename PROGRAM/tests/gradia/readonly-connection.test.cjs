'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom');
const {createMemorySuiteServer,mockFetch,trace}=require('../fixtures/flashback_in_memory_server_fixture.cjs');
const {load}=require('./host.cjs');
const createBus=require('../fixtures/libra_gradia_read_bus.cjs'),createOwner=require('../../tools/libra_gradia_unified_read.cjs');
const PREF='serial_gradation_agents_for_rp:lib_read_connection:v1';
const REG='libra:v1:scope-registry:v1',ROUTE='__memory_suite_internal_scope_routes_v1__:libra';
const wait=async fn=>{const start=Date.now();while(Date.now()-start<6000){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Connection action did not settle');};
async function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gradia-ui-readonly-'));
 if(options.resetEpoch){fs.mkdirSync(path.join(dir,'config'),{recursive:true});fs.writeFileSync(path.join(dir,'config/namespace-reset.json'),JSON.stringify({epochs:{libra:options.resetEpoch},pending:null}));}
 const app=createMemorySuiteServer({dataDir:dir,port:0,autoBackup:false,computeEnabled:false,token:'synthetic-only'}),address=await app.listen(),url=`http://127.0.0.1:${address.port}`;
 const scope={scopeKey:'registered',characterId:'c',chatId:'h'},manifestKey='libra:v1:scope:registered:manifest',key='libra:v1:scope:registered:memory:1:r1';
 const put=(k,value)=>{const json=JSON.stringify(JSON.stringify(value));app.repositories.libra.database.prepare('INSERT OR REPLACE INTO kv(space,key,value_json,deleted,revision,digest,updated_at)VALUES(?,?,?,?,?,?,?)').run('plugin',k,json,0,1,crypto.createHash('sha256').update(json).digest('hex'),1);};
 const ref={status:'committed',key,memoryId:'one',revision:1,sourceDigest:'source',turnRange:{start:1,end:5},sessionEpoch:0};
 put(manifestKey,{schema:'libra.manifest.v1',...scope,branchGuard:{schema:'libra.branch_guard.v1',status:'ready'},memories:{1:ref},inheritedMemories:[]});
 put(key,{schema:'libra.canonical_memory.v1',status:'committed',scopeKey:scope.scopeKey,memoryId:'one',revision:1,sourceDigest:'source',turnRange:ref.turnRange,text:'Existing memory only'});
 const values=new Map([[REG,JSON.stringify({'c::h':scope})],[ROUTE,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',version:1,legacyGlobalModeImported:true,entries:{registered:{scopeId:'registered',scopeKey:'registered',mode:'server_only',origin:'user_explicit',updatedAt:1}}})]]);
 if(options.resetEpoch){const identity=require('../../server/core/data-instance-identity.cjs').readDataInstanceIdentity(dir);values.set('memory_suite_reset_choice.v2.libra',JSON.stringify({schema:'memory-suite.reset-choice.v2',namespace:'libra',url,...identity,dataIdentityCertified:true,resetEpochCertified:true,epoch:options.resetEpoch,choice:'empty'}));}
 const local=new Map();if(options.preference)local.set(PREF,JSON.stringify({...options.preference,url:options.preference.url||url}));
 const bus=createBus(),owner=createOwner({role:'owner',api:bus.api('libra'),fingerprint:v=>crypto.createHash('sha256').update(v).digest('hex'),randomId:()=>crypto.randomUUID(),boundary:async()=>({scope}),query:async()=>{throw Error('Connection inspection must not query memory');},verify:async()=>false});await owner.start();
 const writes=[],requests=[],unloads=[],locals=[];let currentChat={id:'h',message:[]},release,releasePreference,releaseNative,failRevocation=options.failInitialRevocation?1:0,nativeReads=0,currentIndex=0,capturedPlugin,firstPreferenceRead=true;const chatRows={0:currentChat,1:{id:'other',message:[]}};
 const storage={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{writes.push(k);values.set(k,v);},removeItem:async k=>{writes.push(k);values.delete(k);}};
 const localStorage={getItem:async k=>{const value=local.get(k)??null;if(options.disconnectDuringRead&&firstPreferenceRead&&k===PREF){firstPreferenceRead=false;await capturedPlugin.unbindLibReadOnlyClient();}return value;},setItem:async(k,v)=>{locals.push(k);if(failRevocation>0&&JSON.parse(v).explicit===false){failRevocation--;throw Error('SYNTHETIC_LOCAL_WRITE_FAILURE');}if(options.delayPreference&&JSON.parse(v).explicit===true)await new Promise(r=>releasePreference=r);local.set(k,v);},removeItem:async k=>{locals.push(k);local.delete(k);}};
 const transport=async(u,init)=>{requests.push({url:String(u),headers:init?.headers});if(options.delayBootstrap&&String(u).endsWith('/bootstrap'))await new Promise(r=>release=r);if(options.deny)throw Error('SYNTHETIC_DENIED');return mockFetch(u,init);};
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'});
 const host=await load({transformSource:s=>(options.disconnectDuringRead||options.disconnectBeforeStart)?`{let value;Object.defineProperty(globalThis,'__SerialGradationAgentsForRP',{configurable:true,get:()=>value,set:v=>{value=v;__captureApi(v);}});}`+s:s,api:{...(options.ownerUnavailable?{}:bus.api('serial_gradation_agents_for_rp')),pluginStorage:storage,getLocalPluginStorage:async()=>localStorage,nativeFetch:transport,fetch:transport,onUnload:async fn=>unloads.push(fn),showContainer:async()=>{},hideContainer:async()=>{},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>currentIndex,getCharacterFromIndex:async()=>{if(options.delayFinalNative&&++nativeReads===2)await new Promise(r=>releaseNative=r);return {chaId:'c',chats:Object.values(chatRows)};},getCharacter:async()=>({chaId:'c',chats:[currentChat]}),getChatFromIndex:async(_c,index)=>chatRows[index]},testGlobals:{__captureApi:value=>{capturedPlugin=value;if(options.disconnectBeforeStart)void value.unbindLibReadOnlyClient().catch(()=>{});},crypto:crypto.webcrypto,Response,window:dom.window,Element:dom.window.Element,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});
 t.after(async()=>{await owner.dispose();release?.();releasePreference?.();releaseNative?.();await host.plugin.closeSettingsGui();for(const fn of unloads)await fn();dom.window.close();await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const initial={writes:[...writes],locals:[...locals],requests:[...requests]};
 await host.plugin.openSettingsGui();dom.window.document.querySelector('.sidebar [data-go="sources"]').click();
 const doc=dom.window.document;
 const node=selector=>{const n=doc.querySelector(selector);assert.ok(n,selector);return n;};
 const editUrl=v=>{const n=node('#lib-url');n.value=v;n.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 const click=action=>node(action==='inspect'?'#lib-check':`#lib-${action}`).click();
 const status=()=>host.plugin.getLibReadOnlyStatus();
 const connect=async()=>{editUrl(url);click('connect');await wait(()=>['connected','error'].includes(status().connection?.state));return status();};
 const importPayload=async()=>{node('[data-manage-action="import-replace"]').click();const confirm=await wait(()=>doc.querySelector('.overlay.is-open .dialog button.btn--primary'));confirm.click();};
 return {...host,app,url,values,local,writes,locals,requests,initial,doc,node,editUrl,click,connect,importPayload,status,release:()=>release?.(),waiting:()=>!!release,failRevokeOnce:()=>{failRevocation=1;},releasePreference:()=>releasePreference?.(),preferenceWaiting:()=>!!releasePreference,setChat:id=>{currentChat={id,message:[]};chatRows[currentIndex]=currentChat;},switchIndex:()=>{currentIndex=1;currentChat=chatRows[1];},nativeWaiting:()=>!!releaseNative,releaseNative:()=>releaseNative?.(),unload:async()=>{for(const fn of unloads)await fn();},rows:()=>app.repositories.libra.database.prepare('SELECT * FROM kv ORDER BY key').all()};
}
test('fresh startup and unapproved saved URL perform no connection writes or transport',async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:false}});
 assert.deepEqual(h.initial.requests,[]);assert.deepEqual(h.initial.locals,[]);assert.deepEqual(h.initial.writes,[]);
 assert.equal(h.status().connection?.state,'disconnected');assert.ok(h.node('[data-page="sources"] .state-grid > div:nth-child(4)').textContent.includes('모델·문맥 설정 기준'));
});
test('actual Connect and inspect handlers use only bootstrap/capture/current and leave SQLite unchanged',async t=>{
 const h=await fixture(t),before=h.rows(),start=h.writes.length;assert.equal((await h.connect()).connection.state,'connected');
 assert.equal(h.requests.filter(r=>r.url.endsWith('/bootstrap')).length,1);assert.ok(h.requests.every(r=>r.headers['X-Memory-Suite-Plugin']==='serial_gradation_agents_for_rp'));
 h.click('inspect');await wait(()=>h.status().connection?.corpus?.source==='unified_engine');
 assert.equal(h.status().connection.corpus.queried,false);assert.equal(h.status().connection.readSource,'unified_engine');
 assert.ok(h.requests.every(r=>/\/(bootstrap|capture|current)$/.test(r.url)));assert.deepEqual(h.rows(),before);assert.equal(h.app.repositories.libra.database.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
 assert.deepEqual(h.writes.slice(start),[]);assert.deepEqual([...new Set(h.locals)],[PREF]);assert.equal(JSON.parse(h.local.get(PREF)).explicit,true);
 assert.equal(h.status().status,'bound');assert.equal(h.getCalls(),0);assert.equal(h.plugin.createPluginStorageProxy,undefined);assert.equal(h.plugin.configureConnection,undefined);
});
test('missing or ambiguous native registry fails without bootstrap, guesses, or registry mutation',async t=>{
 const h=await fixture(t);for(const registry of [null,{}, {'c::h':{scopeKey:'x',characterId:'c',chatId:'other'}},{'c::h':{scopeKey:'registered',characterId:'c',chatId:'h'},duplicate:{scopeKey:'other',characterId:'c',chatId:'h'}}]){
 h.values.set(REG,JSON.stringify(registry));assert.equal((await h.connect()).connection.state,'error');assert.match(h.status().connection.reason,/LIB_READ_SCOPE/);assert.equal(h.requests.length,0);}
});
test('plugin-only, transitioning, and unreviewed reset reject capture without fallback',async t=>{
 const h=await fixture(t);for(const patch of [{mode:'plugin_only'},{origin:'transition_pending'}]){const r=JSON.parse(h.values.get(ROUTE));Object.assign(r.entries.registered,{mode:'server_only',origin:'user_explicit'},patch);h.values.set(ROUTE,JSON.stringify(r));assert.equal((await h.connect()).connection.state,'error');assert.match(h.status().connection.reason,/LIB_READ_(SERVER_MODE|STORAGE_TRANSITION)/);}
 const r=JSON.parse(h.values.get(ROUTE));Object.assign(r.entries.registered,{mode:'server_only',origin:'user_explicit'});h.values.set(ROUTE,JSON.stringify(r));h.values.set('memory_suite_reset_choice.v2.libra','{}');assert.equal((await h.connect()).connection.state,'error');assert.match(h.status().connection.reason,/LIB_READ_RESET/);assert.equal(h.requests.filter(r=>r.url.endsWith('/capture')).length,0);
});
test('URL change, disconnect, and unload prevent late bootstrap publication',async t=>{
 for(const cancel of ['url','disconnect','unload']){const h=await fixture(t,{delayBootstrap:true});h.editUrl(h.url);h.click('connect');await wait(h.waiting);if(cancel==='url')h.editUrl('http://127.0.0.1:47631');else if(cancel==='unload')await h.unload();else h.click('disconnect');h.release();await new Promise(r=>setTimeout(r,50));assert.notEqual(h.status().status,'bound',cancel);assert.notEqual(h.status().connection.state,'connected',cancel);assert.equal(h.requests.filter(r=>r.url.endsWith('/capture')).length,0);}
});
test('native chat change discards current binding and corpus without automatic reconnection',async t=>{
 const h=await fixture(t);await h.connect();h.setChat('other');await wait(()=>h.status().status!=='bound');assert.equal(h.status().connection.corpus,null);assert.equal(h.requests.filter(r=>r.url.endsWith('/bootstrap')).length,1);assert.match(h.status().connection.reason,/LIB_READ_NATIVE_SCOPE_CHANGED/);
});
test('transport refusal is an explicit terminal state with one bootstrap attempt',async t=>{
 const h=await fixture(t,{deny:true});assert.equal((await h.connect()).connection.state,'error');assert.equal(h.requests.length,1);assert.match(h.status().connection.reason,/LIB_READ_/);assert.notEqual(h.status().status,'bound');
});
test('startup only reuses locally saved explicit connection consent for that exact URL',async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:true}});await wait(()=>h.status().connection?.state==='connected');assert.equal(h.requests.filter(r=>r.url.endsWith('/bootstrap')).length,1);assert.deepEqual(h.initial.locals,[]);
});

test('canceling pending preference persistence cannot restore startup consent',async t=>{
 for(const cancel of ['disconnect','url','unload']){
 const h=await fixture(t,{delayPreference:true});h.editUrl(h.url);h.click('connect');await wait(h.preferenceWaiting);
 if(cancel==='url')h.editUrl('http://127.0.0.1:47631');else if(cancel==='unload'){const unloading=h.unload();h.releasePreference();await unloading;}else h.click('disconnect');
 h.releasePreference();await new Promise(r=>setTimeout(r,50));
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,false,cancel);assert.notEqual(h.status().status,'bound');}
});
test('connection card reports native invalidation as it occurs',async t=>{
 const h=await fixture(t);await h.connect();await wait(()=>h.node('#lib-state').textContent.includes('connected'));
 h.setChat('other');await wait(()=>h.node('#lib-state').textContent.includes('LIB_READ_NATIVE_SCOPE_CHANGED'));
 assert.equal(h.node('#lib-check').disabled,true);
});
test('settings import never imports or retains automatic connection consent',async t=>{
 const h=await fixture(t);await h.connect();await h.plugin.debugNavigateGui('transfer','flow');
 const box=h.doc.querySelector('#mockup-import-text');assert.ok(box);
 box.value=JSON.stringify({runtime:{mode:'off',libReadConnection:{url:h.url,explicit:true}},providerPresets:{offline:{provider:'openai',model:'test-offline',url:'https://api.openai.com/v1/chat/completions'}}});
 box.dispatchEvent(new h.doc.defaultView.Event('input',{bubbles:true}));
 await h.importPayload();
 await wait(()=>h.local.get(PREF)&&JSON.parse(h.local.get(PREF)).explicit===false);
 assert.notEqual(h.status().status,'bound');assert.equal(h.requests.filter(r=>r.url.endsWith('/bootstrap')).length,1);
});
test('non-loopback and credential-bearing URLs never bootstrap',async t=>{
 const h=await fixture(t);for(const url of ['https://example.test','http://user:pass@127.0.0.1:47630','http://127.0.0.1:47630/?token=x']){
 h.editUrl(url);h.click('connect');await wait(()=>h.status().connection.state==='error');assert.equal(h.status().connection.reason,'LIB_READ_SERVER_URL_INVALID');}assert.equal(h.requests.length,0);
});

test('failed consent revocation stays retryable through a later Disconnect',async t=>{
 const h=await fixture(t);await h.connect();h.failRevokeOnce();h.click('disconnect');
 await wait(()=>h.doc.body.textContent.includes('LIB_READ_PREFERENCE_UNAVAILABLE'));
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,true,'simulate durable write failure');
 h.click('disconnect');await wait(()=>JSON.parse(h.local.get(PREF)).explicit===false);
 assert.notEqual(h.status().status,'bound');
});
test('existing accepted reset witness is required and remains unchanged',async t=>{
 const h=await fixture(t,{resetEpoch:2}),key='memory_suite_reset_choice.v2.libra',original=h.values.get(key);
 assert.equal((await h.connect()).connection.state,'connected');assert.equal(h.values.get(key),original);
 const bad=JSON.parse(original);bad.epoch=1;h.values.set(key,JSON.stringify(bad));
 assert.equal((await h.connect()).connection.state,'error');assert.equal(h.status().connection.reason,'LIB_READ_RESET_REVIEW_REQUIRED');
});
test('normal loopback URL with a trailing slash is canonicalized before Connect',async t=>{
 const h=await fixture(t);h.editUrl(h.url+'/');h.click('connect');await wait(()=>h.status().connection.state==='connected');assert.equal(h.status().connection.url,h.url);
});

test('unload waits for in-flight consent write and its compensating revocation',async t=>{
 const h=await fixture(t,{delayPreference:true});h.editUrl(h.url);h.click('connect');await wait(h.preferenceWaiting);
 let finished=false;const pending=h.unload().then(()=>{finished=true;});
 await new Promise(r=>setTimeout(r,25));assert.equal(finished,false);
 h.releasePreference();await pending;assert.equal(JSON.parse(h.local.get(PREF)).explicit,false);
});
test('chat change during preference persistence cannot briefly publish the old binding',async t=>{
 const h=await fixture(t,{delayPreference:true});h.editUrl(h.url);h.click('connect');await wait(h.preferenceWaiting);
 h.setChat('other');h.releasePreference();await wait(()=>h.status().connection.state!=='connecting');
 assert.notEqual(h.status().status,'bound');await wait(()=>JSON.parse(h.local.get(PREF)).explicit===false);
});

test('Disconnect during initial consent read durably suppresses later startup consent',async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:true},disconnectDuringRead:true});
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,false);assert.equal(h.requests.length,0);assert.notEqual(h.status().status,'bound');
});
test('native selection changing during final fixed-index reads is rejected before bootstrap',async t=>{
 const h=await fixture(t,{delayFinalNative:true});h.editUrl(h.url);h.click('connect');await wait(h.nativeWaiting);
 h.switchIndex();h.releaseNative();await wait(()=>h.status().connection.state==='error');assert.equal(h.requests.length,0);assert.notEqual(h.status().status,'bound');
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
 assert.equal(h.requests.length,0);await wait(()=>JSON.parse(h.local.get(PREF)).explicit===false);assert.notEqual(h.status().status,'bound');
});

for(const timing of ['disconnectBeforeStart','disconnectDuringRead'])test(`failed ${timing} revocation remains retryable after startup settles`,async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v1',explicit:true},[timing]:true,failInitialRevocation:true});
 assert.equal(h.requests.length,0,'canceled startup must not bootstrap');
 assert.equal(h.status().connection.reason,'LIB_READ_PREFERENCE_UNAVAILABLE','failed revocation is visible');
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,true,'first synthetic revocation failed');
 const writes=h.locals.length;await h.plugin.unbindLibReadOnlyClient();
 assert.equal(JSON.parse(h.local.get(PREF)).explicit,false,'retry must persist revocation even after startup clears pending state');
 assert.ok(h.locals.length>writes,'retry must make a new persistence attempt');
 assert.equal(h.requests.length,0);assert.notEqual(h.status().status,'bound');
});

test('old saved read-source choices migrate to the unified engine and the old search option is absent',async t=>{
 const h=await fixture(t,{preference:{schema:'gradia.lib-read-connection.v2',explicit:true,readOwners:['libra'],readSource:'server_logical_read'}});
 await wait(()=>h.status().connection?.state==='connected');assert.equal(h.status().connection.readSource,'unified_engine');
 assert.deepEqual([...h.node('#lib-read-source').options].map(o=>o.value),['unified_engine','plugin_ipc']);
});
test('missing unified owner support cannot fall back to server logical memory',async t=>{
 const h=await fixture(t,{ownerUnavailable:true});assert.equal((await h.connect()).connection.state,'error');
 assert.match(h.status().connection.reason,/LIB_READ_UNIFIED_UNAVAILABLE/);assert.notEqual(h.status().status,'bound');
});

test('settings applies the server mode through the real read-only connection and saves verified consent',async t=>{
 const h=await fixture(t);await h.plugin.debugNavigateGui('management','flow');
 const field=h.node('#lib-settings-url');field.value=h.url;field.dispatchEvent(new h.doc.defaultView.Event('input',{bubbles:true}));
 h.node('[data-lib-mode-choice="unified_engine"]').click();
 assert.equal(h.requests.length,0,'selecting a mode cannot connect');
 assert.equal(h.status().connection.state,'disconnected');
 h.node('[data-lib-read-action="connect"]').click();await wait(()=>h.status().connection.state==='connected');
 assert.equal(h.status().connection.readSource,'unified_engine');
 assert.match(h.node('[data-lib-mode-status]').textContent,/현재 적용: 서버 모드/);
 const saved=JSON.parse(h.local.get(PREF));assert.equal(saved.readSource,'unified_engine');assert.equal(saved.explicit,true);
 assert.equal(h.requests.filter(r=>r.url.endsWith('/bootstrap')).length,1);
 h.node('[data-lib-mode-choice="plugin_ipc"]').click();
 assert.match(h.node('[data-lib-mode-status]').textContent,/현재 적용: 서버 모드.*선택: 플러그인 모드.*적용 필요/);
 assert.equal(h.status().connection.readSource,'unified_engine','an unapplied selection must not relabel the active binding');
 assert.equal(h.node('#lib-read-source').value,'plugin_ipc','both connection views share the selection');
 h.node('[data-lib-read-action="disconnect"]').click();await wait(()=>JSON.parse(h.local.get(PREF)).explicit===false);
 assert.match(h.node('[data-lib-mode-status]').textContent,/연결 없음/);assert.equal(h.status().status,'unavailable');
});

test('a failed settings mode switch reports no active connection and never falls back to the previous server',async t=>{
 const h=await fixture(t,{ownerUnavailable:true});await h.plugin.debugNavigateGui('management','flow');
 h.node('[data-lib-mode-choice="plugin_ipc"]').click();
 assert.equal(h.requests.length,0);assert.equal(h.node('[data-lib-server-field]').hidden,true);
 h.node('[data-lib-read-action="connect"]').click();await wait(()=>h.status().connection.state==='error');
 assert.match(h.node('[data-lib-mode-status]').textContent,/연결 없음.*LIB_READ_/);
 assert.equal(h.status().status,'unavailable');assert.equal(h.requests.length,0,'plugin mode must not bootstrap the server');
 assert.equal(h.node('[data-lib-read-action="check"]').disabled,true);
});
