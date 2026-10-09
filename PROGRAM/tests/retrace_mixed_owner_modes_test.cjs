'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const section=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert(start>=0&&end>start);return source.slice(start,end)};
const sandbox={MEMORY_SUITE_OWNER_STATUS_ORDER:['flashback','hayaku','libra','lia'],HANDOFF_STORAGE_MODES:['plugin_only','server_only'],HANDOFF_STORAGE_DESTINATIONS:['plugin_only','server_only','per_owner'],MEMORY_SUITE_OWNER_GATE_SCHEMA:'retrace.memory_suite_owner_storage_gate.v1',HANDOFF_STORAGE_POLICY_SCHEMA:'memory-session-bridge-storage-policy-v1',text:x=>String(x??''),clone:x=>x==null?x:JSON.parse(JSON.stringify(x)),stableHash64:x=>crypto.createHash('sha256').update(x).digest('hex'),Date,console};
vm.createContext(sandbox);
vm.runInContext(section('  const memorySuiteOwnerStorageGateFromRows =','  const inspectMemorySuiteOwnerStorageGate =')+section('  const handoffStoragePolicyFromGate =','  const renderHandoffStorageGate =')+'\nglobalThis.gate=memorySuiteOwnerStorageGateFromRows;globalThis.policy=handoffStoragePolicyFromGate;globalThis.matches=handoffStoragePolicyMatchesGate;',sandbox);
(async()=>{
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteHandoffTargetStorage.source.js'),'utf8')+'\nglobalThis.prepareTarget=prepareMemorySuiteHandoffTargetStorage;',sandbox);
vm.runInContext(section('  const ensurePendingHandoffStorageConfiguration =','  const performPendingNextSessionHandoff =')+'\nglobalThis.ensureTarget=ensurePendingHandoffStorageConfiguration;',sandbox);
for(let bits=0;bits<8;bits++){
 const rows=['flashback','hayaku','libra'].map((owner,i)=>({owner,mode:bits&(1<<i)?'server_only':'plugin_only',installed:true,connected:true,supported:true}));rows.push({owner:'lia',mode:'plugin_only',installed:true,connected:true,supported:true,storagePolicy:'local_only'});
 const server=Object.fromEntries(rows.filter(row=>row.mode==='server_only').map(row=>[row.owner,{verified:true,result:'ok'}]));
 const gate=sandbox.gate(rows,server);assert.equal(gate.ready,true,`core owner mode combination ${bits} must be allowed with local LIA`);
 const policy=sandbox.policy(gate,1);assert.equal(sandbox.matches(policy,gate),true);assert.deepEqual(JSON.parse(JSON.stringify(policy.participants)),rows.map(({owner,mode})=>({owner,mode})));
 const target='target-chat',transfer='test-transfer',prepared=[],states=new Map(rows.map(row=>[row.owner,'plugin_only']));
 const marker={sourceChatId:'source-chat',targetChatId:target,transferId:transfer,targetStorageMode:gate.commonMode,targetStoragePolicy:policy,handoffJournal:{transferId:transfer,state:'pending_storage_configuration'}};
 const api={getCharacter:async()=>({chatPage:0,chats:[{id:target,memorySessionBridge:marker}]}),getCurrentChatIndex:async()=>0};
 for(const owner of ['flashback','hayaku','libra','lia']){
  const storage={getConnectionSettings:async()=>({scope:{scopeId:owner+'-target',chatId:target},mode:states.get(owner)}),setScopeMode:async(_scope,mode)=>{states.set(owner,mode)}};
  const name={flashback:'requestFlashbackIpc',hayaku:'requestHayakuIpc',libra:'requestLibraIpc',lia:'requestLiaIpc'}[owner];
  sandbox[name]=async(action,payload)=>{assert.equal(action,'memory_suite_prepare_handoff_target');assert.equal(payload.mode,rows.find(row=>row.owner===owner).mode);prepared.push(owner);return await sandbox.prepareTarget(api,storage,owner,payload)};
 }
 sandbox.inspectMemorySuiteOwnerStorageGate=async()=>gate;sandbox.memorySuiteModeLabel=value=>value;let journal;
 sandbox.persistNextSessionHandoffJournal=async(_target,_transfer,value)=>{journal=value};
 const result=await sandbox.ensureTarget({targetChatId:target,bridge:marker,journal:{transferId:transfer,storageDestination:gate.commonMode,storagePolicy:policy}});
 assert.equal(result.verified,true);assert.deepEqual(prepared,['flashback','hayaku','libra','lia']);assert.equal(journal.state,'pending_owner_handoffs');
 for(const row of rows){assert.equal(states.get(row.owner),row.mode);assert.equal(result.owners[row.owner].requestedMode,row.mode);}
 if(bits){const failed=structuredClone(server),owner=Object.keys(server)[0];failed[owner].verified=false;assert.equal(sandbox.gate(rows,failed).ready,false,'a failing server owner is never marked successful');}
}
console.log('retrace_mixed_owner_modes_test: PASS (8 core combinations, 32 actual target-helper calls, local LIA, per-owner readback)');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
