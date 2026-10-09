'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const snapshotFactory=require('../server/core/flashback-scope-health.cjs');
const ARTIFACTS=process.env.FLASHBACK_SERVER_INSPECTION_ARTIFACTS;if(!ARTIFACTS)throw Error('Set FLASHBACK_SERVER_INSPECTION_ARTIFACTS to actual Full/Min root');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),id='A'.repeat(32),url='http://127.0.0.1:47630',routeKey='__memory_suite_internal_scope_routes_v1__:flashback';
const store=values=>({values:new Map(values),async getItem(k){return this.values.get(k)??null},async setItem(k,v){this.values.set(k,v);return true},async removeItem(k){this.values.delete(k);return true},async keys(){return [...this.values.keys()]}});
(async()=>{const seed=await createFixture({chat:{message:[{role:'user',chatId:'u1',data:'Where is the compass?'},{role:'assistant',chatId:'a1',data:'The amber compass rests in the cedar cabinet.'}]}});let data,scope,chat;
 try{await seed.api.saveSettings({...await seed.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});await seed.api.ingestLiveChatColdStart({scope:'current',canonical:true});scope=await seed.api.resolveCurrentScope(false);data={plugin:[...seed.pluginStorage.values],local:[...seed.host.safeLocalStorage.values]};chat=structuredClone(seed.currentChat);}finally{await seed.dispose()}
 const results=[];
 for(const kind of ['Full','Min']){
  const source=fs.readFileSync(path.join(ARTIFACTS,kind,'plugins/Flashback_Memory.js'),'utf8'),rows=new Map();
  for(const space of ['plugin','local'])for(const [key,value]of data[space])rows.set(space+'\n'+key,{space,key,value,exists:true,tombstone:false,revision:1,digest:sha(JSON.stringify(value)),valueBytes:Buffer.byteLength(JSON.stringify(value)),updatedAt:1});
  const repository={database:{exec(){}},list:(space,prefix,{limit})=>{const found=[...rows.values()].filter(r=>r.space===space&&r.key.startsWith(prefix)).sort((a,b)=>a.key.localeCompare(b.key));return{records:found.slice(0,limit).map(({value,exists,...r})=>r),page:{hasMore:found.length>limit}}},get:(space,key)=>rows.get(space+'\n'+key)||{exists:false,tombstone:false,value:null,revision:0,digest:'',updatedAt:0}};
  const snapshot=snapshotFactory({getRepository:()=>repository,dataInstanceId:id,epochs:()=>({flashback:0}),canRead:()=>true});
  const route={schema:'memory-suite.scope-routing.v1',version:1,namespace:'flashback',legacyGlobalModeImported:true,entries:Object.fromEntries([scope.scopeKey,'__memory_suite_global__'].map(scopeId=>[scopeId,{scopeId,scopeKey:scopeId,mode:'server_only',origin:'user_explicit',updatedAt:1}]))};
  const plugin=store(data.plugin),local=store(data.local);for(const s of [plugin,local])s.values.set(routeKey,JSON.stringify(route));
  let inspecting=false,writes=0,credentialReads=0,retainedReads=0,hostGlobalSettingsReads=0,bootstrapCalls=0,inspectionCalls=0;const setupRequests=[];
  const nativeFetch=async(u,init={})=>{const parsed=new URL(u),name=parsed.pathname;if(inspecting)inspectionCalls++;else setupRequests.push([init.method||'GET',name]);let result;
   if(name==='/bootstrap'){if(inspecting)throw Error('inspection_bootstrap_forbidden');bootstrapCalls++;return new Response(JSON.stringify({ok:true,schema:'memory-suite.storage.bootstrap.v1',url,token:'synthetic-token',protocol:{major:1,minor:0},namespaces:['flashback'],dataInstanceId:id,dataIdentityContract:'memory-suite.physical-data-identity.v1',resetEpochs:{flashback:0},capabilities:Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1','data-instance-binding.v1','flashback-scope-health.v1'].map(k=>[k,true]))}),{status:200})}
   if(name==='/v1/flashback/scope-health')result=await snapshot({namespace:'flashback',roles:['owner']},JSON.parse(init.body));
   else if(name==='/v1/kv/get'){if(inspecting)throw Error('inspection must not consume any ordinary server KV copy');result=repository.get(parsed.searchParams.get('space'),parsed.searchParams.get('key'));}
   else if(name==='/v1/kv/keys')result={records:[],page:{hasMore:false,nextCursor:''}};
   else if(name==='/v1/integrity')result={ok:true,records:rows.size,liveRecords:rows.size,tombstones:0};
   else throw Error('unexpected_fake_request:'+name);
   return new Response(JSON.stringify({ok:true,dataInstanceId:id,result}),{status:200});
  };
  const f=await createFixture({pauseScheduledTimers:true,source,pluginStorage:plugin,safeLocalStorage:local,chat,arguments:{memory_suite_server_url:url},nativeFetch});
  try{
   assert.equal(f.api._test,undefined,'actual release has no test exports');await f.api.loadSettings(true);await new Promise(r=>setTimeout(r,150));assert(bootstrapCalls>0,'normal product setup establishes a certified connection');
   for(const s of [plugin,local]){const get=s.getItem.bind(s);s.getItem=async key=>{if(String(key).includes('embedding_secret')){credentialReads++;throw Error('credential_read_forbidden')}if(key==='vector_rag_memory:settings:v2'){assert.equal(s,plugin);hostGlobalSettingsReads++;return get(key)}if(String(key).startsWith('vector_rag_memory:scope:')||String(key).startsWith('vector_rag_memory:local-vector-shard:')){retainedReads++;throw Error('retained_copy_forbidden')}return get(key)};s.setItem=s.removeItem=async()=>{writes++;throw Error('inspection_write_forbidden')}}
 const originalGetArgument=f.host.getArgument.bind(f.host);f.host.getArgument=async key=>{if(key==='embedding_key'){credentialReads++;throw Error('credential_argument_forbidden')}return originalGetArgument(key)};
   f.host.setArg=f.host.setArgument=async()=>{writes++;throw Error('argument_write_forbidden')};inspecting=true;const before=bootstrapCalls;
   const result=await f.api.inspectMemoryMaintenance();assert.equal(result.inspection.coverage,'server_snapshot');assert.equal(result.inspection.complete,true);assert.equal(result.inspection.snapshotHealthVerified,false);assert.equal(result.storedRecords,1);assert.equal(result.automatic.blocked,true);assert.equal(bootstrapCalls,before);assert.equal(writes,0);assert.equal(credentialReads,0);assert.equal(retainedReads,0);
   await assert.rejects(()=>f.api.runMemoryMaintenance('sync',{preflight:result}));assert.equal(writes,0);assert.equal((await f.api.healthRecovery.previewPhysicalRepair()).allowed,false);assert.equal(writes,0);
   results.push({kind,sha256:sha(source),storedRecords:result.storedRecords,inspectionCalls,bootstrapDuringInspection:bootstrapCalls-before,writes,credentialReads,retainedReads,hostGlobalSettingsReads,setupRequests});
  }finally{await f.dispose()}
 }
 console.log(JSON.stringify({test:'flashback_server_inspection_actual_artifacts',passed:results,liveRequests:0}));
})().catch(e=>{console.error(e);process.exitCode=1});
