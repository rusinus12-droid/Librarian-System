'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8').replace('_test: { maintenanceResultText,','_test: { readRegistry, collectSnapshotScopeCandidates, Runtime, maintenanceResultText,');
(async()=>{let f;try{
f=await createFixture({source});let t=f.api._test;f.character.chatPage=-1;f.host.getCurrentChatIndex=async()=>-1;
const none=await t.resolveCurrentScopeIdentityBundle(false);assert.equal(none.scope.scopeKey,'');assert.equal(none.scope.available,false);const old=JSON.stringify(await t.readRegistry());assert.equal((await t.ensureScopeStorageReady(none.scope,{},{})).reason,'no_active_chat');assert.equal(JSON.stringify(await t.readRegistry()),old);
f.character.chatPage=0;f.host.getCurrentChatIndex=async()=>0;const identity=await t.resolveCurrentScopeIdentityBundle(false);await t.ensureScopeStorageReady(identity.scope,{},{});assert.equal((await t.readRegistry()).scopes.some(x=>x.scopeKey===identity.scope.scopeKey),false,'unused chat never added');await f.dispose();f=null;
const messages=[{role:'user',data:'Open the brass door.',chatId:'u1'},{role:'assistant',data:'A blue lantern illuminates the map.',chatId:'a1'}];
f=await createFixture({source,chat:{id:'copy',chatId:'copy',name:'Original (Copy)',message:messages,messages,bindedPersona:'new-persona'}});t=f.api._test;
f.character.id='Legacy Character ID';f.character.chaId='canonical-character';f.character.name='Character';const original={id:'original',chatId:'original',name:'Original',message:messages,messages,bindedPersona:'old-persona'};f.character.chats.push(original);
const db={personas:[{id:'new-persona',name:'New'},{id:'old-persona',name:'Old'}],selectedPersona:'new-persona'};f.host.getDatabase=async fields=>Object.fromEntries(fields.map(k=>[k,db[k]??null]));
const snap={character:f.character,chat:f.currentChat,db,chatInfo:{charIndex:0,chatIndex:0}},target=t.resolveScopeFromSnapshot(snap),orig=t.resolveScopeFromSnapshot({...snap,chat:original,chatInfo:{charIndex:0,chatIndex:1}});
const legacy={...orig,scopeKey:orig.legacyPersonaScopeKey,scopeIdentityVersion:0,canonicalCharacterId:'',canonicalChatId:'',canonicalScopeId:'',personaId:'old-persona'};
await t.saveAllRecords([{id:'e',hash:'e',type:'response',sourceType:'response',text:messages[1].data,dim:4,vector:[1,0,0,0]}],null,legacy);const before=JSON.stringify(await t.loadScopeManifest(legacy));
const adopted=await t.ensureScopeStorageReady(target,await f.api.loadSettings(),{copyCandidates:t.collectSnapshotScopeCandidates(snap,target)});assert.equal(adopted.adopted,true,'copy-first before visiting original');assert.equal((await t.loadScopeRecords(target.scopeKey)).records.length,1);assert.equal(JSON.stringify(await t.loadScopeManifest(legacy)),before,'original is preserved');
const bad={...target,scopeKey:'other-content',chatId:'other-content',canonicalChatId:'other-content',chatFingerprint:'different',chatTailHash:'different'};assert.equal(await t.findCloneSource(bad,{scopes:[legacy]},{}),null);
console.log('flashback_scope_discovery_runtime_test: PASS');}finally{await f?.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
