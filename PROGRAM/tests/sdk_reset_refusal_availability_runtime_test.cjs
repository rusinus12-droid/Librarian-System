'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const {createMemorySuiteServer}=require('../server/server.cjs');
const files=['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'];
async function fixture(file,scenario){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sdk-reset-refusal-')),app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false,computeEnabled:false});
 const address=await app.listen(),url='http://127.0.0.1:'+address.port,calls=[],bridges=[],outcomes={};
 const context=vm.createContext({console:{warn(){},log(){},error:console.error},URL,TextEncoder,TextDecoder,AbortController,Headers,Request,Response,crypto:globalThis.crypto,setTimeout,clearTimeout,
  risuai:{getArgument:async name=>name==='memory_suite_server_url'?url:name==='memory_suite_server_mode'?'server_only':'',nativeFetch:async(target,init)=>{const call={route:new URL(target).pathname,status:null};calls.push(call);try{const response=await fetch(target,init);call.status=response.status;if(response.status>=400)call.error=(await response.clone().json()).error;return response;}catch(error){call.transportError=error.message;throw error;}}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk',file),'utf8')+'\nglobalThis.factory=createMemorySuiteStorageBridge;',context);
 const make=namespace=>{const bridge=context.factory({namespace,pluginId:'flashback_hayaku_bridge',pluginPrefixes:[namespace==='hayaku'?'hayaku.v2.':namespace+':'],scopeRouting:false,autoMigratePlugin:false,autoMigrateLocal:false,startupDiagnostics:false,managementButton:false,requestTimeoutMs:8000,bootstrapRequestTimeoutMs:8000});bridges.push(bridge);return bridge;};
 const manager=await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}}).then(r=>r.json());
 const control=async(action,body)=>{const response=await fetch(url+'/v1/manager/control/'+action,{method:'POST',headers:{Authorization:'Bearer '+manager.token,'X-Memory-Suite-Plugin':'flashback_hayaku_bridge','Content-Type':'application/json'},body:JSON.stringify(body)}),payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));return payload.result;};
 const evidence=()=>{if(process.env.SDK_RESET_EVIDENCE_DIR){fs.mkdirSync(process.env.SDK_RESET_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.SDK_RESET_EVIDENCE_DIR,file+'.'+scenario+'.http.json'),JSON.stringify({calls,outcomes},null,2));}};
 return {dir,app,url,calls,outcomes,make,control,evidence,async close(){evidence();for(const bridge of bridges)await bridge.dispose();await app.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(dir).startsWith('sdk-reset-refusal-'));fs.rmSync(dir,{recursive:true,force:true});}};
}
for(const file of files){
 test(file+': actual restore refusal retains epoch fence without poisoning healthy peer/server bootstrap',async()=>{
  const f=await fixture(file,'restore');try{
   const raw={scopeKey:'closed-hayaku',text:'RETAIN_RESTORED_RAW_\uD55C\uAD6D\uC5B4',vector:[0.25,-0.5,0.75]},key='hayaku.v2.ledger.closed-hayaku';
   f.app.repositories.hayaku.mutate({kind:'set',space:'plugin',key,value:raw,expectedRevision:0,operationId:'reset_availability_seed_001'});
   f.app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:v1:peer-retained',value:'HEALTHY_UNSELECTED_PEER_37',expectedRevision:0,operationId:'reset_availability_peer_001'});
   const stale=f.make('hayaku'),manager=f.make('retrace');const old=await stale.bootstrap();await manager.bootstrap();
   const backup=await f.app.createBackup('manual','reset-availability-fixture');f.app.repositories.hayaku.mutate({kind:'set',space:'plugin',key,value:{changed:true},expectedRevision:1,operationId:'reset_availability_change_001'});
   const plan=await f.control('restore-plan',{backupId:backup.result.id,namespaces:['hayaku']});await f.control('restore-execute',{operationId:'reset_availability_restore_001',planId:plan.planId,confirmation:'RESTORE '+plan.planId});
   const epochs=JSON.parse(fs.readFileSync(path.join(f.dir,'config','namespace-reset.json'),'utf8')).epochs;assert.equal(epochs.hayaku,1);
   const refused=error=>error?.status===409&&error.payload?.error==='MEMORY_SUITE_RESET_RECONNECT_REQUIRED';
   await assert.rejects(stale.serverGet('plugin',key),refused);
   assert.equal(f.calls.find(call=>call.status===409)?.error,'MEMORY_SUITE_RESET_RECONNECT_REQUIRED');
   const capture=async action=>{try{return {value:await action()};}catch(error){return {error};}};
   const firstCalls=f.calls.length,repeated=await capture(()=>stale.serverGet('plugin',key)),secondCalls=f.calls.length;
   const peer=f.make('libra'),peerResult=await capture(()=>peer.serverGet('plugin','libra:v1:peer-retained'));
   const freshManager=f.make('retrace'),managerResult=await capture(()=>freshManager.managerControl('status'));
   // No implicit reset acceptance/bootstrap refresh occurs for the stale owner.
   const writeResponse=await fetch(f.url+'/v1/kv/set',{method:'POST',headers:{Authorization:'Bearer '+old.token,'X-Memory-Suite-Plugin':'flashback_hayaku_bridge','X-Memory-Suite-Data-Instance':old.dataInstanceId,'X-Memory-Suite-Reset-Epochs':JSON.stringify(old.resetEpochs),'Content-Type':'application/json'},body:JSON.stringify({namespace:'hayaku',space:'plugin',key,value:'DO_NOT_REUPLOAD_AFTER_RESTORE_57',expectedRevision:1,operationId:'reset_availability_stale_write_001'})}),writePayload=await writeResponse.json();
   for(const [name,result] of Object.entries({repeated,peerResult,managerResult}))f.outcomes[name]=result.error?{message:result.error.message,status:result.error.status??null,code:result.error.code??null,cached:result.error.cached===true}: {ok:true};
   f.outcomes.staleWrite={status:writeResponse.status,error:writePayload.error};
   const db=new DatabaseSync(path.join(f.dir,'stores','hayaku','hayaku.sqlite'),{readOnly:true});try{assert.deepEqual(JSON.parse(db.prepare('SELECT value_json FROM kv WHERE key=?').get(key).value_json),raw);}finally{db.close();}
   assert.ok(refused(repeated.error),repeated.error?.message);assert.equal(secondCalls,firstCalls+1,'stale namespace remains explicitly fenced rather than cached as dead server');
   assert.equal(peerResult.error,undefined,peerResult.error?.message);assert.equal(peerResult.value.value,'HEALTHY_UNSELECTED_PEER_37','a different namespace at the same healthy URL remains reachable');
   assert.equal(managerResult.error,undefined,managerResult.error?.message);assert.equal(managerResult.value.dataInstanceId,manager.serverBinding().dataInstanceId);assert.equal(writeResponse.status,409);assert.equal(writePayload.error,'MEMORY_SUITE_RESET_RECONNECT_REQUIRED');
   assert.equal(f.calls.filter(call=>call.status===409).length,2);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,'config','namespace-reset.json'),'utf8')).epochs,epochs);
  }finally{await f.close();}
 });
 test(file+': actual transport outage still activates shared offline circuit',async()=>{
  const f=await fixture(file,'outage');try{const old=f.make('hayaku');await old.bootstrap();await f.app.close();await assert.rejects(old.serverGet('plugin','missing'),/fetch failed/);const before=f.calls.length;
   await assert.rejects(f.make('retrace').bootstrap(),error=>error.code==='MEMORY_SUITE_SERVER_UNAVAILABLE'&&error.cached===true);assert.equal(f.calls.length,before,'actual outage circuit still suppresses repeated dispatch');
  }finally{await f.close();}
 });
}
