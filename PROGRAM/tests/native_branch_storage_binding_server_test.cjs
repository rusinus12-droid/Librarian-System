'use strict';
const assert=require('node:assert/strict');
const serverMeta=require('../server/core/host-lineage-metadata.cjs');
const valid={
 schema:'librarian.native_branch_storage_binding.v1',bindingId:'flashback:parent->child:abc',owner:'flashback',
 sourceScopeKey:'memory-suite:flashback:char:c1|chat:parent|persona:default',
 targetScopeKey:'memory-suite:flashback:char:c1|chat:child|persona:default',
 sourceMode:'server_only',targetMode:'server_only',targetModeOrigin:'migrated',
 parentChatId:'parent',targetChatId:'child',lineageDigest:'abc',status:'complete',
 createdAt:'2026-09-16T00:00:00.000Z',committedAt:'2026-09-16T00:00:01.000Z',
 migration:{schema:'memory-suite.native-branch-storage-migration.v1',migrated:true,fromMode:'plugin_only',toMode:'server_only',retainedLocal:true,localItems:2,pluginItems:2,localStorageItems:0,migratedAt:'2026-09-16T00:00:00.500Z'}
};
let passed=0;const check=(name,fn)=>{fn();passed++;console.log('PASS '+name)};
check('binding validator exported',()=>assert.equal(typeof serverMeta.validateNativeBranchStorageBinding,'function'));
check('valid complete binding accepted',()=>serverMeta.validateNativeBranchStorageBinding(valid,{chatId:'child',sourceChatId:'parent'},'flashback'));
check('stored nativeChatCopy binding accepted',()=>serverMeta.validateStoredHostLineage({chatId:'child',nativeChatCopy:{sourceChatId:'parent',storageBinding:valid}},'flashback'));
check('stored LIA nativeBranchState binding accepted',()=>serverMeta.validateStoredHostLineage({chatId:'child',nativeBranchState:{storageBinding:valid}},'flashback'));
for(const [name,patch] of [
 ['wrong owner',{owner:'lia'}],['bad mode',{targetMode:'cloud'}],['same scope',{targetScopeKey:valid.sourceScopeKey}],
 ['same chat',{targetChatId:'parent'}],['missing digest',{lineageDigest:''}],['bad status',{status:'done'}],
 ['complete without timestamp',{committedAt:''}],['migrated without migration',{migration:null}],['wrong migration mode',{migration:{...valid.migration,toMode:'mirror'}}]
]) check(name,()=>assert.throws(()=>serverMeta.validateNativeBranchStorageBinding({...valid,...patch},{chatId:'child',sourceChatId:'parent'},'flashback'),e=>e.code==='NATIVE_BRANCH_STORAGE_BINDING_INVALID'));
check('outer target checked',()=>assert.throws(()=>serverMeta.validateNativeBranchStorageBinding(valid,{chatId:'sibling'},'flashback'),/target_chat_mismatch/));
check('outer source checked',()=>assert.throws(()=>serverMeta.validateNativeBranchStorageBinding(valid,{chatId:'child',sourceChatId:'other'},'flashback'),/source_chat_mismatch/));
console.log(JSON.stringify({test:'native_branch_storage_binding_server',passed}));
