const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createMemorySuiteServer}=require('../server/server.cjs');
(async()=>{const root=fs.mkdtempSync(path.join(require('os').tmpdir(),'hayaku-binding-regression-'));
let source=fs.readFileSync(path.resolve(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');source=source.replace('  const validateCurrentHayakuSparseRrfBinding = async submitted => {','  globalThis.__auditBridge=MemorySuiteStorageBridge; globalThis.__auditWriteLedger = (scope, value) => RisuCompat.setStorageItem(storageLedgerStorageKey(scope), JSON.stringify(value)); globalThis.__auditCache = value => value ? (Memory.authoritativeLedgerCache=value) : Memory.authoritativeLedgerCache;\n  const validateCurrentHayakuSparseRrfBinding = async submitted => {');const file=path.join(root,'instrumented.js');fs.writeFileSync(file,source);
const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'server'),autoBackup:false});const address=await app.listen();let h;let afterCompute=null;const calls=[];
try{const packet=createValidPacket({turn:1});h=await createHayakuRuntime({autoRepair:false,pluginSourceFile:file,messages:[{role:'user',data:'Find Alice',chatId:'u1'},{role:'assistant',data:hiddenPacketMessage('Alice found the archive.',packet),chatId:'a1'}],arguments:{memory_suite_server_mode:'server_only',memory_suite_server_url:`http://127.0.0.1:${address.port}`},nativeFetch:async(url,init)=>{calls.push(new URL(url).pathname);const result=await fetch(url,init);if(String(url).includes("/compute/execute")&&afterCompute)await afterCompute();return result;}});
const mode=await h.context.__auditBridge.getScopeMode();assert.equal(mode.mode,'server_only');assert.equal(mode.migrationRequired,false);
// Establish the real server storage binding before admitting the request frame.
await h.hayaku._test.loadStorageLedger(await h.hayaku._test.currentChatScope());
const beforeCalls=calls.length;
const requestResult=await h.hayaku._test.handleBeforeRequest([{role:'user',content:'Find Alice in the archive'}],'model');
console.log('full beforeRequest routes',JSON.stringify(calls.slice(beforeCalls)));
assert.ok(requestResult.length>1,JSON.stringify(h.hayaku.lastDebug().lastBeforeRequest));assert.ok(calls.slice(beforeCalls).includes('/v1/compute/execute'));assert.equal(h.llmCalls.length,0);
const t=h.hayaku._test,s=h.hayaku.settings(),scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope),worldline=t.reconcileTurnWorldline(null,snapshot,scope),storageSnapshot=t.storageBackedSnapshot(snapshot,[]);
const store=t.emptyStore(),raw=JSON.stringify(packet);t.ingestPacket(store,raw,'source',{messageIndex:1});t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+10000});await t.localRecallPrepareSources([{raw,hash:'source',messageIndex:1}],store,s,scope.key,Date.now()+10000);
h.context.__auditCache({scopeKey:scope.key,chatSnapshotHash:storageSnapshot.chatSnapshotHash,worldline,packets:[]});let error=null;try{await t.searchIndexCompositeRecall(store,'Alice',s,{scope,snapshot,worldline});}catch(e){error=e.message;}
const owner={scope,snapshot,worldline};
const beforeCache=JSON.stringify(h.context.__auditCache());
await t.searchIndexCompositeRecall(store,'Alice',s,owner);
assert.equal(JSON.stringify(h.context.__auditCache()),beforeCache);

const originalMessages=JSON.parse(JSON.stringify(scope.chatMessages));
afterCompute=()=>{h.setMessages([{role:'user',data:'edited during request',chatId:'changed'}]);afterCompute=null;};
await assert.rejects(()=>t.searchIndexCompositeRecall(store,'Alice',s,owner),/HAYAKU_SEARCH_BINDING_STALE/);
h.setMessages(originalMessages);

afterCompute=async()=>{afterCompute=null;await h.context.__auditWriteLedger(scope,{revision:999,records:[],testCommit:'during-search'});};
await assert.rejects(()=>t.searchIndexCompositeRecall(store,'Alice',s,owner),/HAYAKU_SEARCH_BINDING_STALE/);
afterCompute=()=>{afterCompute=null;h.context.__auditCache({...h.context.__auditCache(),worldline:{...worldline,revision:worldline.revision+1}});};
await assert.rejects(()=>t.searchIndexCompositeRecall(store,'Alice',s,owner),/HAYAKU_SEARCH_BINDING_STALE/);
h.context.__auditCache({scopeKey:scope.key,chatSnapshotHash:storageSnapshot.chatSnapshotHash,worldline,packets:[]});
afterCompute=()=>{afterCompute=null;throw Error('simulated network failure');};
await t.searchIndexCompositeRecall(store,'Alice',s,owner);
const out={error,revisionBefore:worldline.revision,revisionAfter:h.context.__auditCache().worldline.revision,rawAndStorageHashesDiffer:snapshot.chatSnapshotHash!==storageSnapshot.chatSnapshotHash,chatUnchanged:t.authoritativeChatSnapshot((await t.currentChatScope()).chatMessages,scope).chatSnapshotHash===snapshot.chatSnapshotHash,httpRoutes:calls,externalModelCalls:h.llmCalls.length};assert.equal(error,null);assert.equal(out.revisionAfter,out.revisionBefore);assert.equal(out.chatUnchanged,true);fs.writeFileSync(path.join(root,'patched-result.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
}finally{await h?.dispose();await app.close();assert.equal(path.dirname(root),path.resolve(require('os').tmpdir()));fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
