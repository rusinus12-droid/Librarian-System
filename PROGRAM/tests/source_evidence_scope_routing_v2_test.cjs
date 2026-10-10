'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const{createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
let passed=0;const check=(v,m)=>{assert.ok(v,m);passed++;};
(async()=>{
 const p=createValidPacket({turn:1,subject:'Alice',summary:'Alice waited in the office.'});const rt=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Wait.'},{role:'assistant',chatId:'a1',data:hiddenPacketMessage('Alice waited in the office.',p)}]});
 try{const t=rt.hayaku._test,scope=await t.currentChatScope();await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'evidence-route-test');
 const keys=[...rt.pluginStorage.values.keys()],ek=keys.find(k=>k.startsWith('hayaku.v2.source-evidence.')),lk=keys.find(k=>k.startsWith('hayaku.v2.ledger.'));
 check(Boolean(ek),'capture writes a routed evidence key');check(Boolean(lk),'ledger root exists');
 const own=await t.memorySuiteHayakuResolveKeyScope({key:ek,currentScope:{scopeId:scope.key,scopeKey:scope.key}});check(own.kind==='scope'&&own.scopeId===scope.key,'evidence is scoped, not global');
 const foreign=await t.memorySuiteHayakuResolveKeyScope({key:ek,currentScope:{scopeId:'foreign'}});check(foreign.kind==='scope'&&foreign.scopeId===scope.key,'old evidence remains in original scope during chat switch');
 const candidates=[{space:'plugin',logicalKey:lk},{space:'plugin',logicalKey:ek}],context={phase:'complete',scope:{scopeKey:scope.key},serverCandidates:candidates,readback:async(_space,key)=>rt.pluginStorage.values.get(key)};
 const good=await t.memorySuiteHayakuValidateRestore(context);check(good.ok,JSON.stringify(good));
 const raw=JSON.parse(rt.pluginStorage.values.get(ek));raw.rows[0].assistantText='tampered';rt.pluginStorage.values.set(ek,JSON.stringify(raw));const bad=await t.memorySuiteHayakuValidateRestore(context);check(!bad.ok&&bad.errors.some(e=>e.code==='hayaku_restore_source_evidence_invalid'),'physical restored evidence digest checked');
 }finally{await rt.dispose();}
 const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8'),a=source.indexOf('const memorySuiteLibraResolveKeyScope = async'),b=source.indexOf('const memorySuiteLibraRestoreObject =',a),c=vm.createContext({});vm.runInContext(source.slice(a,b)+';this.resolve=memorySuiteLibraResolveKeyScope;',c);
 for(const type of ['source-evidence:v1:blob','source-edit-consent:v1']){const r=await c.resolve({key:'libra:v1:scope:char:chat:0:'+type,currentScope:null,registry:{entries:{}}});check(r.kind==='scope'&&r.scopeId==='char:chat:0','LIBRA cold restore scope extraction '+type);}
 console.log(JSON.stringify({test:'source_evidence_scope_routing_v2',passed,environment:'actual HAYAKU routing/restore + actual LIBRA route function'}));
})().catch(e=>{console.error(e);process.exitCode=1});
