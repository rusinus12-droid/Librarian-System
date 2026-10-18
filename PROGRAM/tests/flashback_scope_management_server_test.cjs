'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {createMemorySuiteServer}=require('../server/server.cjs');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'fb-management-server-'));let app,f,offline=false;try{
app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:root,autoBackup:false});const url='http://127.0.0.1:'+(await app.listen()).port;
const code=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8').replace('_test: { maintenanceResultText,','_test: { deleteSelectedScopeStorages,scopeKeys,clearVerificationForTest:()=>Runtime.guiStorageVerificationByScope.clear(),maintenanceResultText,');
f=await createFixture({source:code,exposeStorageBridge:true,arguments:{memory_suite_server_url:url},nativeFetch:async(u,i)=>{if(offline&&String(u).includes('/v1/kv/'))return new Response(JSON.stringify({error:'TEST_STORE_UNAVAILABLE'}),{status:503});return fetch(u,i);}});
const b=f.context.__fixtureStorageBridge,t=f.api._test,c=await b.getConnectionSettings({force:true});await b.setScopeMode(c.scope,'server_only');assert.equal((await b.getConnectionSettings({scope:c.scope,force:true})).mode,'server_only');
const current=(await t.resolveCurrentScopeIdentityBundle(false)).scope;await t.saveAllRecords([{id:'m',hash:'m',type:'response',sourceType:'response',text:'Real SQLite memory',dim:4,vector:[1,0,0,0]}],null,current);
const key=t.scopeKeys.manifest(current.scopeKey);assert.equal(JSON.parse(app.repositories.flashback.get('plugin',key).value).count,1);
f.currentChat.id='another';f.currentChat.chatId='another';f.currentChat.name='Another';await t.resolveCurrentScopeIdentityBundle(false);const next=await b.getConnectionSettings({force:true});await b.setScopeMode(next.scope,'server_only');
t.clearVerificationForTest();offline=true;const failed=await t.deleteSelectedScopeStorages([current.scopeKey]);assert.equal(failed.deleted,0);assert.equal(JSON.parse(app.repositories.flashback.get('plugin',key).value).count,1);
offline=false;t.clearVerificationForTest();const blocked=await t.deleteSelectedScopeStorages([current.scopeKey]);assert.equal(blocked.deleted,0,JSON.stringify(blocked));assert.equal(blocked.protected,1);assert.match(blocked.protectedReasons.join(' '),/RE:TRACE.*서버 데이터 관리/);assert.equal(app.repositories.flashback.get('plugin',key).exists,true);
console.log('flashback_scope_management_server_test: PASS HTTP/SQLite, offline and online owner deletion preserve server originals; RE:TRACE required');
}finally{await f?.dispose();await app?.close();fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
