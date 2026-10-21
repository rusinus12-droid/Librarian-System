const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createMemorySuiteServer}=require('../server/server.cjs');
// The Compute SDK is retired from HAYAKU (ef640ca): composite recall ranks locally and
// synchronously, so there is no remote round trip during which the chat, ledger or
// worldline could move under a search binding. This test keeps the binding audit on the
// server-backed storage path: search must stay read-only, make zero Compute calls and
// give the same rows as the plugin_only path.
(async()=>{const root=fs.mkdtempSync(path.join(require('os').tmpdir(),'hayaku-binding-regression-'));
const anchor='  const searchIndexCompositeRecall = async (store, query, settings = Memory.settings, owner = {}) => {';
const original=fs.readFileSync(path.resolve(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
assert.equal(original.split(anchor).length,2,'composite recall entry point is present exactly once');
assert.match(original,/const searchIndexCompositeRecall = async \(store, query, settings = Memory\.settings, owner = \{\}\) => \{\n    const rows=localRecallCandidates\(store,query,settings,null\);\n    return prepareHayakuRecallRows\(rows,query,settings,store,\[\],\[\]\);\n  \};/,'composite recall is local and has no remote await window');
const source=original.replace(anchor,'  globalThis.__auditBridge=MemorySuiteStorageBridge; globalThis.__auditReadLedger = scope => RisuCompat.getStorageItem(storageLedgerStorageKey(scope), null); globalThis.__auditCache = value => value ? (Memory.authoritativeLedgerCache=value) : Memory.authoritativeLedgerCache;\n'+anchor);
const file=path.join(root,'instrumented.js');fs.writeFileSync(file,source);
const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:path.join(root,'server'),autoBackup:false});const address=await app.listen();let h,local;const calls=[];
try{const packet=createValidPacket({turn:1});const messages=[{role:'user',data:'Find Alice',chatId:'u1'},{role:'assistant',data:hiddenPacketMessage('Alice found the archive.',packet),chatId:'a1'}];
h=await createHayakuRuntime({autoRepair:false,pluginSourceFile:file,messages:JSON.parse(JSON.stringify(messages)),arguments:{memory_suite_server_mode:'server_only',memory_suite_server_url:`http://127.0.0.1:${address.port}`},nativeFetch:async(url,init)=>{calls.push(new URL(url).pathname);return fetch(url,init);}});
const mode=await h.context.__auditBridge.getScopeMode();assert.equal(mode.mode,'server_only');assert.equal(mode.migrationRequired,false);
// Establish the real server storage binding before admitting the request frame.
await h.hayaku._test.loadStorageLedger(await h.hayaku._test.currentChatScope());
assert.ok(calls.length>0,'server_only storage binding goes through the server');
const beforeCalls=calls.length;
const requestResult=await h.hayaku._test.handleBeforeRequest([{role:'user',content:'Find Alice in the archive'}],'model');
console.log('full beforeRequest routes',JSON.stringify(calls.slice(beforeCalls)));
assert.ok(requestResult.length>1,JSON.stringify(h.hayaku.lastDebug().lastBeforeRequest));assert.equal(h.llmCalls.length,0);
const t=h.hayaku._test,s=h.hayaku.settings(),scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope),worldline=t.reconcileTurnWorldline(null,snapshot,scope),storageSnapshot=t.storageBackedSnapshot(snapshot,[]);
const store=t.emptyStore(),raw=JSON.stringify(packet);t.ingestPacket(store,raw,'source',{messageIndex:1});t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+10000});await t.localRecallPrepareSources([{raw,hash:'source',messageIndex:1}],store,s,scope.key,Date.now()+10000);
h.context.__auditCache({scopeKey:scope.key,chatSnapshotHash:storageSnapshot.chatSnapshotHash,worldline,packets:[]});
const owner={scope,snapshot,worldline};
const beforeCache=JSON.stringify(h.context.__auditCache());
const beforeLedger=JSON.stringify(await h.context.__auditReadLedger(scope));
const searchCallsBefore=calls.length;
const first=await t.searchIndexCompositeRecall(store,'Alice',s,owner);
const second=await t.searchIndexCompositeRecall(store,'Alice',s,owner);
const firstRows=Object.values(first||{}).filter(Array.isArray).flat();
assert.ok(firstRows.length>0,'composite recall returns rows for the stored packet');
assert.ok(firstRows.some(row=>/Alice/.test(JSON.stringify(row))),'composite recall finds the queried entity');
assert.deepEqual(second,first,'repeated search on an unchanged binding is deterministic');
assert.equal(calls.length,searchCallsBefore,'composite recall performs no server round trip');
assert.equal(JSON.stringify(h.context.__auditCache()),beforeCache,'search never rewrites the authoritative ledger cache');
assert.equal(JSON.stringify(await h.context.__auditReadLedger(scope)),beforeLedger,'search never writes the durable ledger');

// Same rows as the plugin_only path for the same store and query.
local=await createHayakuRuntime({autoRepair:false,messages:JSON.parse(JSON.stringify(messages)),arguments:{memory_suite_server_mode:'plugin_only'}});
const lt=local.hayaku._test,ls=local.hayaku.settings(),lscope=await lt.currentChatScope();
const lstore=lt.emptyStore();lt.ingestPacket(lstore,raw,'source',{messageIndex:1});lt.rebuildIndex(lstore,{settings:ls,deadlineAt:Date.now()+10000});await lt.localRecallPrepareSources([{raw,hash:'source',messageIndex:1}],lstore,ls,lscope.key,Date.now()+10000);
// Ingestion wall-clock stamps (numeric *At fields) differ between the two runtimes; everything else must match.
const withoutClock=value=>JSON.parse(JSON.stringify(value,(key,v)=>/At$/.test(key)&&typeof v==='number'?undefined:v));
assert.deepEqual(withoutClock(await lt.searchIndexCompositeRecall(lstore,'Alice',ls,{})),withoutClock(first),'server-backed storage policy ranks exactly like plugin_only');

const out={revisionBefore:worldline.revision,revisionAfter:h.context.__auditCache().worldline.revision,rawAndStorageHashesDiffer:snapshot.chatSnapshotHash!==storageSnapshot.chatSnapshotHash,chatUnchanged:t.authoritativeChatSnapshot((await t.currentChatScope()).chatMessages,scope).chatSnapshotHash===snapshot.chatSnapshotHash,httpRoutes:calls,computeCalls:calls.filter(route=>route.includes('/compute/')).length,externalModelCalls:h.llmCalls.length+local.llmCalls.length};
assert.equal(out.revisionAfter,out.revisionBefore);assert.equal(out.chatUnchanged,true);assert.equal(out.computeCalls,0,'retired Compute SDK is never called');assert.equal(out.externalModelCalls,0);
fs.writeFileSync(path.join(root,'patched-result.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
}finally{await h?.dispose();await local?.dispose();await app.close();assert.equal(path.dirname(root),path.resolve(require('os').tmpdir()));fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
