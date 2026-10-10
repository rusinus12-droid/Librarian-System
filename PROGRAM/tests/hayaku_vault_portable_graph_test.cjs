'use strict';
const assert=require('node:assert/strict');const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const r=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Enter the archive.'},{role:'assistant',chatId:'a1',data:hiddenPacketMessage('Alice enters.',createValidPacket())}]});try{
const t=r.hayaku._test,scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope);assert.equal((await t.reconcileObservedChatTopology(scope,snapshot,'portable_test')).durable,true);
const v={...t.emptyRecoveryVault(scope.key),records:[{recordId:'debt-one',scopeKey:scope.key,pairIndex:2,user:{text:'future question'},assistant:{text:'future reply'},status:'deterministic_fallback',createdAt:1,updatedAt:1}]};assert.equal((await t.writeRecoveryVaultDirect(scope.key,v)).durable,true);
const rootKey='hayaku.v2.recovery_vault.'+scope.key;const old=JSON.parse(await r.pluginStorage.getItem(rootKey));
v.records[0].backgroundDecision='declined';assert.equal((await t.writeRecoveryVaultDirect(scope.key,v)).durable,true);const index=JSON.parse(await r.pluginStorage.getItem(rootKey));assert.notEqual(index.debtRefs[0].key,old.debtRefs[0].key);
// A stale snapshot from an interrupted older operation is deliberately corrupt.
await r.pluginStorage.setItem(old.debtRefs[0].key,'{broken stale data');
const portable=await waitFor(()=>r.context.__HAYAKUPortableMemoryBackup,'portable API');const backup=await portable.exportCurrentScope();
assert.ok(backup.records.some(x=>x.key===rootKey));assert.ok(backup.records.some(x=>x.key===index.debtRefs[0].key));assert.equal(backup.records.some(x=>x.key===old.debtRefs[0].key),false,'export current published graph, not retired or uncommitted debt snapshots');
await portable.validateBackup(backup);await r.pluginStorage.removeItem(index.debtRefs[0].key);await assert.rejects(()=>portable.exportCurrentScope(),/shard_missing/);
console.log('hayaku_vault_portable_graph_test: PASS');}finally{await r.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
