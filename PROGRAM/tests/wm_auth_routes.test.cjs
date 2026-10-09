'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {EventEmitter} = require('node:events');
const serverApi = require('../server/server.cjs');
const F = require('./helpers/wm-fixture.cjs');
const C = require('../sdk/WmStorageContracts.source.js');
const servicePath = path.resolve(__dirname,'../server/wm/service.cjs');
const httpPath = path.resolve(__dirname,'../server/wm/http.cjs');
const serviceApi = fs.existsSync(servicePath) ? require(servicePath) : {};
const httpApi = fs.existsSync(httpPath) ? require(httpPath) : {};
const master = 'synthetic-test-only-000000000000000000000000';
const wmPlugin = 'libra_world_manager';
function features() {
 assert.equal(typeof serviceApi.createWmService,'function','A4 requires WM service');
 assert.equal(typeof httpApi.handleWmRequest,'function','A4 requires explicit WM dispatcher');
 assert.equal(typeof httpApi.wmPrincipalForPluginId,'function','A4 requires isolated principal');
}
function service(t, options={}) {
 features(); const root=fs.mkdtempSync(path.join(os.tmpdir(),'wm-a4-synthetic-'));
 const s=serviceApi.createWmService({dataDir:root,serverIdentity:F.storeIdentity(),...options});
 t.after(()=>s.close()); return {root,s,db:path.join(root,'stores/wm/wm.sqlite')};
}
function app(t, options={}) {
 features(); const root=fs.mkdtempSync(path.join(os.tmpdir(),'wm-a4-server-synthetic-'));
 const a=serverApi.createMemorySuiteServer({dataDir:root,token:master,autoBackup:false,computeEnabled:false,wmServerIdentity:F.storeIdentity(),...options});
 t.after(async()=>{await a.close();a.server.emit('close');}); return {root,a};
}
async function request(a, method, url, body, headers={}) {
 const req=new EventEmitter();req.method=method;req.url=url;req.headers={host:'localhost',...headers};req.socket={remoteAddress:'127.0.0.1'};req.resume=()=>{};req.destroy=()=>{};
 const res=new EventEmitter();res.writeHead=(statusCode,values)=>{res.statusCode=statusCode;res.headers=values;};res.end=bytes=>{res.body=bytes ? JSON.parse(bytes.toString()) : {};res.emit('finish');};
 const pending=a.server.listeners('request')[0](req,res);
 await new Promise(resolve=>setImmediate(resolve));
 if(body!==undefined){const bytes=Buffer.from(JSON.stringify(body));req.emit('data',bytes);}req.emit('end');
 await pending;return res;
}
async function auth(a,plugin) {
 const r=await request(a,'GET','/bootstrap',undefined,{'x-memory-suite-plugin':plugin});
 assert.equal(r.statusCode,200);return {authorization:'Bearer '+r.body.token,'x-memory-suite-plugin':plugin};
}
const call=(s,p,endpoint,body={},method='POST')=>httpApi.handleWmRequest({method,path:'/v1/wm/'+endpoint,body,principal:p,service:s});
const wm=()=>httpApi.wmPrincipalForPluginId(wmPlugin);
const wireInventory=v=>({...v,items:v.items.map(({descriptor,payload})=>({descriptor,payload:{encoding:'base64',data:Buffer.from(payload).toString('base64'),offset:0,totalBytes:payload.byteLength,sha256:descriptor.sha256}}))});

test('wm_capability_cannot_access_legacy_kv',async t=>{
 const {a}=app(t),h=await auth(a,wmPlugin);
 for(const namespace of serverApi.NAMESPACES){
  const get=await request(a,'GET',`/v1/kv/get?namespace=${namespace}&space=plugin&key=sample`,undefined,h);
  assert.equal(get.statusCode,403,namespace+' read');
  for(const action of ['set','remove'])assert.equal((await request(a,'POST','/v1/kv/'+action,{namespace,space:'plugin',key:'sample',value:'denied',operationId:'denied-'+action},h)).statusCode,403,namespace+' '+action);
 }
});
test('legacy_capabilities_cannot_write_wm',async t=>{
 const {a}=app(t);
 for(const plugin of ['flashback_memory','hayaku_locator_continuity','libra','lia_persona_linker','flashback_hayaku_bridge','serial_gradation_agents_for_rp']){
  const h=await auth(a,plugin);
  assert.equal((await request(a,'POST','/v1/wm/snapshot/initialize',F.initialization(),h)).statusCode,403,plugin);
 }
});
test('wm_generic_kv_and_manager_bypass_are_denied',async t=>{
 const {a}=app(t);
 for(const plugin of [wmPlugin,'flashback_hayaku_bridge','libra']){
  const h=await auth(a,plugin);
  assert.equal((await request(a,'GET','/v1/kv/get?namespace=wm&space=plugin&key=head',undefined,h)).statusCode,403);
  for(const action of ['set','remove','batch'])assert.equal((await request(a,'POST','/v1/kv/'+action,{namespace:'wm',space:'plugin',key:'head',value:'denied'},h)).statusCode,403);
 }
 const h=await auth(a,'flashback_hayaku_bridge');
 const status=await request(a,'GET','/v1/wm/dataset/status',undefined,h);assert.equal(status.statusCode,200);
 assert.equal(status.body.result.initialized,false);assert.equal(JSON.stringify(status.body).includes('head'),false);
 for(const route of ['snapshot/acquire','snapshot/read','snapshot/status','inventory/open','dataset/activate'])assert.equal((await request(a,'POST','/v1/wm/'+route,{},h)).statusCode,403);
 const deniedReset=await request(a,'POST','/v1/manager/reset/plan',{namespaces:['wm']},h);
 assert.equal(deniedReset.statusCode,500);assert.equal(deniedReset.body.error,'reset_invalid_namespaces');
});
test('wm_does_not_join_legacy_five_owner_migration',async t=>{
 const {a,root}=app(t);const health=await request(a,'GET','/health');
 assert.deepEqual(serverApi.NAMESPACES,['flashback','hayaku','libra','lia','retrace']);
 assert.equal(serverApi.principalForPluginId('flashback_hayaku_bridge:peer:libra_world_manager'),null);
 assert.deepEqual(Object.keys(a.repositories),serverApi.NAMESPACES);
 assert.deepEqual(health.body.legacyNamespaces,serverApi.NAMESPACES);
 assert.deepEqual(health.body.supportedStorageOwners,['flashback','hayaku','libra','wm']);
 assert.equal(fs.existsSync(path.join(root,'stores/wm')),false);
 const manager=await auth(a,'flashback_hayaku_bridge');
 const status=await request(a,'GET','/v1/manager/control/status',undefined,manager);
 assert.equal(status.statusCode,200);assert.deepEqual(status.body.result.legacyNamespaces,serverApi.NAMESPACES);assert.equal(status.body.result.wm.initialized,false);
});
test('wm_bootstrap_grants_storage_without_compute',async t=>{
 const {a,root}=app(t);const r=await request(a,'GET','/bootstrap',undefined,{'x-memory-suite-plugin':wmPlugin});
 assert.equal(r.statusCode,200);assert.deepEqual(r.body.authorization.readNamespaces,['wm']);assert.deepEqual(r.body.authorization.writeNamespaces,['wm']);
 assert.equal(r.body.capabilities['wm.storage.v1'],true);assert.equal(Object.keys(r.body.capabilities).some(k=>k.startsWith('compute')||k.startsWith('kv.')),false);
 assert.equal(fs.existsSync(path.join(root,'runtime-token.txt')),false);
 assert.equal((await request(a,'POST','/v1/compute/bootstrap',{}, {'x-memory-suite-plugin':wmPlugin})).statusCode,403);
});
test('wm_trusted_principal_ignores_body_claims',t=>{
 const {s,db}=service(t);const fake={role:'owner',pluginId:'libra',namespaces:['wm'],access:'write'};
 assert.equal(call(s,fake,'snapshot/initialize',{...F.initialization(),principal:wm()}).statusCode,403);
 assert.equal(call(s,null,'snapshot/initialize',F.initialization()).statusCode,403);assert.equal(fs.existsSync(db),false);
 assert.equal(httpApi.wmPrincipalForPluginId('wm'),null);assert.equal(httpApi.wmPrincipalForPluginId('libra'),null);
 assert.deepEqual(wm(),{role:'wm_owner',pluginId:wmPlugin,namespaces:['wm'],access:'write'});
});
test('wm_lazy_capabilities_and_status_do_not_create_store',t=>{
 const {s,db}=service(t);
 for(const endpoint of ['capabilities','dataset/status'])assert.equal(call(s,wm(),endpoint,{},'GET').statusCode,200);
 assert.equal(fs.existsSync(db),false);assert.equal(s.status().initialized,false);
});
test('wm_snapshot_initialize_prepare_publish_read_and_status_dispatch',t=>{
 const {s}=service(t),p=wm();const init=call(s,p,'snapshot/initialize',F.initialization());assert.equal(init.statusCode,200);assert.equal(init.body.result.status,'committed');
 const old=init.body.result.receipt.head||init.body.result.receipt;assert.equal(C.validateHead(old).ok,true);
 const input=F.storeWrite(old,{raw:'hello\r\n🌍 password token story words'});const prep=call(s,p,'snapshot/prepare',input);assert.equal(prep.statusCode,200);
 const pub=call(s,p,'snapshot/publish',prep.body.result);assert.equal(pub.statusCode,200);assert.equal(pub.body.result.status,'committed');
 const pin=call(s,p,'snapshot/acquire',{scope:'scope-a'}).body.result;
 assert.deepEqual(Object.keys(pin.head).sort(),C.HEAD_KEYS.slice().sort());
 assert.equal(call(s,p,'snapshot/read',{lease:pin.lease}).body.result.raw,input.raw);
 assert.equal(call(s,p,'snapshot/head',{scope:'scope-a',lease:pin.lease}).body.result.leaseValid,true);
 assert.equal(call(s,p,'snapshot/observe',{scopes:['scope-a'],leases:[pin.lease]}).body.result[0].sha256,pin.head.sha256);
 const status=call(s,p,'snapshot/status',{operationId:input.operationId,requestFingerprint:input.requestFingerprint});assert.deepEqual(status.body.result,pub.body.result);
 assert.equal(call(s,p,'snapshot/release',{lease:pin.lease}).statusCode,200);
 assert.equal(call(s,p,'snapshot/read',{lease:pin.lease}).statusCode,409);
});
test('wm_handler_authentication_binds_plugin_claim',async t=>{
 const {a}=app(t),h=await auth(a,wmPlugin);
 const init=await request(a,'POST','/v1/wm/snapshot/initialize',F.initialization(),h);assert.equal(init.statusCode,200);
 assert.equal((await request(a,'POST','/v1/wm/snapshot/acquire',{scope:'scope-a'},{...h,'x-memory-suite-plugin':'libra'})).statusCode,403);
 assert.equal((await request(a,'GET','/v1/wm/dataset/status',undefined,{authorization:'Bearer '+master,'x-memory-suite-admin':'1'})).statusCode,403);
});
test('wm_inventory_put_page_and_chunk_preserve_original_bytes',t=>{
 const {s}=service(t),p=wm();const bytes=Buffer.from([0,255,128,13,10]);const d={...F.item('raw','binary-raw'),bytes:bytes.length,sha256:F.sha(bytes)};
 const input=F.inventoryWrite({items:[{descriptor:d,payload:bytes}]});assert.equal(call(s,p,'inventory/put',wireInventory(input)).statusCode,200);
 const snapshot=call(s,p,'inventory/open',{routeGeneration:'route-1'}).body.result;
 const page=call(s,p,'inventory/page',{snapshotId:snapshot.snapshotId,cursor:null,maxItems:128,maxBytes:262144});assert.equal(page.statusCode,200);assert.deepEqual(page.body.result.items,[d]);
 const chunk=call(s,p,'inventory/chunk',{snapshotId:snapshot.snapshotId,logicalId:d.logicalId,offset:0,maxBytes:3});assert.equal(chunk.statusCode,200);
 assert.deepEqual(Buffer.from(chunk.body.result.data,'base64'),bytes.subarray(0,3));assert.equal(chunk.body.result.sha256,d.sha256);assert.equal(chunk.body.result.nextOffset,3);
 assert.equal(call(s,p,'inventory/close',{snapshotId:snapshot.snapshotId}).statusCode,200);
});
test('wm_tombstone_inventory_descriptor_passes_snapshot_validator',t=>{
 const {s}=service(t),p=wm();call(s,p,'snapshot/initialize',F.initialization());const snap=call(s,p,'inventory/open',{routeGeneration:'route-1'}).body.result;
 const page=call(s,p,'inventory/page',{snapshotId:snap.snapshotId,cursor:null,maxItems:128,maxBytes:262144}).body.result;
 assert.equal(page.items[0].domain,'canonical');assert.deepEqual(page.items[0].disposition,{tombstone:true});
 assert.equal(call(s,p,'inventory/chunk',{snapshotId:snap.snapshotId,logicalId:page.items[0].logicalId,offset:0,maxBytes:1}).body.result.data,'');
});
test('wm_routes_reject_nonplain_unknown_fields_and_bad_digest_before_store_creation',t=>{
 const {s,db}=service(t);let reads=0;const v={};Object.defineProperty(v,'scope',{enumerable:true,get(){reads++;return 'scope-a';}});
 for(const payload of [v,{...F.initialization(),principal:wm()},{...F.initialization(),requestFingerprint:'0'.repeat(64)}])assert.equal(call(s,wm(),'snapshot/initialize',payload).statusCode,400);
 assert.equal(reads,0);assert.equal(fs.existsSync(db),false);
 const bad=F.storeWrite(F.head());bad.manifest.canonical.sha256='0'.repeat(64);assert.equal(call(s,wm(),'snapshot/prepare',bad).statusCode,400);assert.equal(fs.existsSync(db),false);
});
test('wm_routes_reject_unknown_action_method_and_partial_wire_chunk',t=>{
 const {s,db}=service(t),p=wm();assert.equal(call(s,p,'snapshot/reset').statusCode,404);assert.equal(call(s,p,'snapshot/acquire',{},'GET').statusCode,405);
 const v=wireInventory(F.inventoryWrite({items:[{descriptor:F.item(),payload:Buffer.from('abc')}]}));v.items[0].payload.offset=1;assert.equal(call(s,p,'inventory/put',v).body.error,'wm_partial_chunk_unsupported');assert.equal(fs.existsSync(db),false);
});
test('wm_transport_limits_are_negotiated_and_encoded_decoded_limits_separate',t=>{
 const {s,db}=service(t,{limits:{maxChunkBytes:2,maxBodyBytes:1000,maxPageItems:1}}),p=wm();const caps=call(s,p,'capabilities',{},'GET').body.result;
 assert.equal(caps.limits.maxChunkBytes,2);assert.equal(caps.limits.maxPageItems,1);assert.ok(caps.limits.maxCanonicalBytes>4*1024*1024);
 const v=wireInventory(F.inventoryWrite({items:[{descriptor:F.item(),payload:Buffer.from('abc')}]}));assert.equal(call(s,p,'inventory/put',v).statusCode,413);assert.equal(fs.existsSync(db),false);
 assert.equal(call(s,p,'snapshot/acquire',{scope:'x'.repeat(1001)}).statusCode,413);assert.equal(fs.existsSync(db),false);
});
test('wm_inventory_wire_rejects_noncanonical_base64_length_hash_and_fingerprint',t=>{
 const {s,db}=service(t),p=wm();const original=wireInventory(F.inventoryWrite({items:[{descriptor:F.item(),payload:Buffer.from('abc')}]}));
 for(const mutate of [v=>v.items[0].payload.data='YWJj!',v=>v.items[0].payload.totalBytes=4,v=>v.items[0].payload.sha256='0'.repeat(64),v=>v.requestFingerprint='0'.repeat(64)]){const v=F.clone(original);mutate(v);assert.equal(call(s,p,'inventory/put',v).statusCode,400);}
 assert.equal(fs.existsSync(db),false);
});
test('wm_dataset_fence_activate_and_durable_status_dispatch',t=>{
 const {s}=service(t),p=wm();call(s,p,'snapshot/initialize',F.initialization());
 const fence=call(s,p,'dataset/fence',F.signed({operationId:'fence-1',expectedRoute:F.storeRoute()}));assert.equal(fence.body.result.status,'committed');
 const receipt=fence.body.result.receipt;const state=call(s,p,'dataset/status',{},'GET').body.result;assert.deepEqual(state.dataset.route,receipt.route);assert.equal(state.dataset.writerEpoch,receipt.writerEpoch);
 const targetRoute={...receipt.route,state:'active',routeGeneration:'route-2'};
 const activate=F.signed({operationId:'activate-1',expectedRoute:receipt.route,targetRoute,sealedInventoryDigest:receipt.inventoryDigest,sourceFenceReceipt:receipt});
 assert.equal(call(s,p,'dataset/activate',activate).body.result.status,'committed');assert.deepEqual(call(s,p,'dataset/status',{},'GET').body.result.dataset.route,targetRoute);
 assert.equal(call(s,p,'snapshot/initialize',F.initialization('stale','stale-init')).body.result.status,'conflict');
 const unknown=call(s,p,'snapshot/status',{operationId:'never-used',requestFingerprint:'0'.repeat(64)});assert.equal(unknown.body.result.status,'uncertain');
});
test('wm_dataset_state_is_readonly_and_reopen_preserves_current_route',t=>{
 const {s,root,db}=service(t),p=wm();call(s,p,'snapshot/initialize',F.initialization());
 const f=call(s,p,'dataset/fence',F.signed({operationId:'state-fence',expectedRoute:F.storeRoute()})).body.result;
 s.close();const before=F.sha(fs.readFileSync(db));
 const store=F.loadStore().createWmStore({databasePath:db,identity:F.storeIdentity()});t.after(()=>store.close());
 assert.equal(typeof store.readDatasetState,'function');const a=store.readDatasetState(),b=store.readDatasetState();assert.deepEqual(a,b);assert.deepEqual(a.route,f.receipt.route);store.close();assert.equal(F.sha(fs.readFileSync(db)),before);
 const reopened=serviceApi.createWmService({dataDir:root,serverIdentity:F.storeIdentity()});t.after(()=>reopened.close());assert.deepEqual(reopened.status().dataset.route,f.receipt.route);
});
test('wm_unavailable_keeps_core3_available',async t=>{
 features();const root=fs.mkdtempSync(path.join(os.tmpdir(),'wm-a4-corruption-'));fs.mkdirSync(path.join(root,'stores/wm'),{recursive:true});const db=path.join(root,'stores/wm/wm.sqlite');fs.writeFileSync(db,'synthetic corrupt WM db');const before=F.sha(fs.readFileSync(db));
 const a=serverApi.createMemorySuiteServer({dataDir:root,token:master,autoBackup:false,computeEnabled:false,wmServerIdentity:F.storeIdentity()});t.after(async()=>{await a.close();a.server.emit('close');});
 const h=await auth(a,wmPlugin);assert.equal((await request(a,'POST','/v1/wm/snapshot/acquire',{scope:'scope-a'},h)).statusCode,503);
 for(const plugin of ['flashback_memory','hayaku_locator_continuity','libra']){const p=await auth(a,plugin);const ns=serverApi.principalForPluginId(plugin).namespace;assert.equal((await request(a,'GET',`/v1/kv/get?namespace=${ns}&space=plugin&key=sample`,undefined,p)).statusCode,200);}
 assert.equal(a.integrityAll().ok,true);assert.equal(F.sha(fs.readFileSync(db)),before);assert.equal((await request(a,'GET','/health')).body.wm.available,false);
});
test('wm_newer_schema_is_unavailable_without_transform',t=>{
 features();const root=fs.mkdtempSync(path.join(os.tmpdir(),'wm-a4-newer-')),db=path.join(root,'stores/wm/wm.sqlite');const st=F.loadStore().createWmStore({databasePath:db,identity:F.storeIdentity()});st.close();F.sqliteMutate(db,d=>d.prepare("UPDATE metadata SET value='wm.sqlite.v99' WHERE key='schema'").run());const before=F.sha(fs.readFileSync(db));
 const s=serviceApi.createWmService({dataDir:root,serverIdentity:F.storeIdentity()});t.after(()=>s.close());assert.equal(s.status().available,false);assert.equal(call(s,wm(),'snapshot/acquire',{scope:'scope-a'}).statusCode,503);s.close();assert.equal(F.sha(fs.readFileSync(db)),before);
});
test('wm_existing_roles_and_retired_writers_are_unchanged',async t=>{
 const {a}=app(t);
 for(const plugin of ['lia_persona_linker','flashback_hayaku_bridge']){const h=await auth(a,plugin),ns=serverApi.principalForPluginId(plugin).namespace;assert.equal((await request(a,'POST','/v1/kv/set',{namespace:ns,space:'plugin',key:'legacy-write',value:'no'},h)).statusCode,403);}
 assert.deepEqual(serverApi.principalForPluginId('serial_gradation_agents_for_rp').writeNamespaces,[]);assert.deepEqual(serverApi.principalForPluginId('serial_gradation_agents_for_rp').readNamespaces,['libra']);
 assert.deepEqual(serverApi.principalForPluginId('flashback_hayaku_bridge').readNamespaces,serverApi.NAMESPACES);
 assert.deepEqual(serverApi.principalForPluginId('flashback_hayaku_bridge').writeNamespaces,[]);
});
test('wm_service_close_blocks_new_usage_and_preserves_data',t=>{
 const {s,db}=service(t);call(s,wm(),'snapshot/initialize',F.initialization());s.close();assert.equal(fs.existsSync(db),true);assert.equal(call(s,wm(),'snapshot/acquire',{scope:'scope-a'}).statusCode,503);
});

test('wm_prepare_response_loss_preserves_operation_identity_and_uncertainty',t=>{
 const {s,root}=service(t),p=wm();const init=call(s,p,'snapshot/initialize',F.initialization()).body.result;
 const input=F.storeWrite(init.receipt.head||init.receipt,{operationId:'lost-prepare',generationId:'lost-generation'});
 const result=F.faultSqlite({sqlPattern:/^COMMIT$/,phase:'after'},()=>call(s,p,'snapshot/prepare',input));assert.equal(result.hit,true);
 assert.equal(result.result.statusCode,503);assert.equal(result.result.body.uncertain,true);assert.equal(result.result.body.operationId,input.operationId);assert.equal(result.result.body.requestFingerprint,input.requestFingerprint);
 const reopened=serviceApi.createWmService({dataDir:root,serverIdentity:F.storeIdentity()});t.after(()=>reopened.close());
 assert.equal(call(reopened,p,'snapshot/status',{operationId:input.operationId,requestFingerprint:input.requestFingerprint}).body.result.status,'prepared');
});
test('wm_legacy_whole_DATA_integrity_failure_still_stops_startup',t=>{
 const {a,root}=app(t);a.server.emit('close');const libra=path.join(root,'stores/libra/libra.sqlite');
 const file=fs.existsSync(libra)?libra:path.join(root,'stores/libra.sqlite');fs.writeFileSync(file,'synthetic corrupt core3 database');
 assert.throws(()=>serverApi.createMemorySuiteServer({dataDir:root,token:master,autoBackup:false,computeEnabled:false}),{code:'AUTHORITY_QUARANTINED',statusCode:503});
});
test('wm_core3_writer_data_hashes_do_not_change_during_WM_operations',async t=>{
 const {a,root}=app(t);const hashes={};
 for(const [plugin,namespace,key] of [['flashback_memory','flashback','vector_rag_memory:wm-isolation'],['hayaku_locator_continuity','hayaku','hayaku:wm-isolation'],['libra','libra','libra:v1:wm-isolation']]){
  const h=await auth(a,plugin);const set=await request(a,'POST','/v1/kv/set',{namespace,space:'plugin',key,value:{story:'owner stays unchanged'},operationId:'core3-wm-isolation-'+namespace,expectedRevision:0},h);assert.equal(set.statusCode,200,JSON.stringify(set.body));
  a.repositories[namespace].checkpoint();hashes[namespace]=F.sha(fs.readFileSync(path.join(root,'stores',namespace,namespace+'.sqlite')));
 }
 const h=await auth(a,wmPlugin);assert.equal((await request(a,'POST','/v1/wm/snapshot/initialize',F.initialization(),h)).statusCode,200);
 const acquired=await request(a,'POST','/v1/wm/snapshot/acquire',{scope:'scope-a'},h);assert.equal(acquired.statusCode,200);
 for(const namespace of serverApi.ACTIVE_STORAGE_NAMESPACES){a.repositories[namespace].checkpoint();assert.equal(F.sha(fs.readFileSync(path.join(root,'stores',namespace,namespace+'.sqlite'))),hashes[namespace]);}
});
test('wm_dataset_status_rejects_dangling_inventory_dependency',t=>{
 const {s,db}=service(t),p=wm();const d=F.item();assert.equal(call(s,p,'inventory/put',wireInventory(F.inventoryWrite({items:[{descriptor:d,payload:Buffer.from('abc')}]}))).statusCode,200);
 const broken={...d,dependencies:['missing-data']},json=F.stable(broken);
 F.sqliteMutate(db,database=>{database.exec('DROP TRIGGER inventory_items_immutable_update');database.prepare('UPDATE inventory_items SET descriptor_json=?,descriptor_sha256=? WHERE logical_id=?').run(json,F.sha(Buffer.from(json)),d.logicalId);});
 assert.equal(call(s,p,'dataset/status',{},'GET').body.result.available,false);
});
function wmDirectoryEvidence(root) {
 const dir=path.join(root,'stores/wm');
 return Object.fromEntries(fs.readdirSync(dir).sort().map(name=>[name,F.sha(fs.readFileSync(path.join(dir,name)))]));
}
for(const [name,damage] of [
 ['missing_heads',db=>db.exec('DROP TABLE heads')],
 ['missing_operations',db=>db.exec('DROP TABLE operations')],
 ['missing_immutable_trigger',db=>db.exec('DROP TRIGGER blobs_immutable_update')],
 ['incompatible_table',db=>db.exec('ALTER TABLE heads ADD COLUMN foreign_field TEXT')],
 ['unexpected_trigger',db=>db.exec('CREATE TRIGGER unknown_wm_trigger AFTER INSERT ON operations BEGIN SELECT 1; END')]
])test('wm_A4_F1_existing_'+name+'_fails_closed_without_repair',async t=>{
 const {s,root,db}=service(t);assert.equal(call(s,wm(),'snapshot/initialize',F.initialization()).statusCode,200);s.close();
 F.sqliteMutate(db,damage);const mainBefore=F.sha(fs.readFileSync(db));
 const {DatabaseSync}=require('node:sqlite');const probe=new DatabaseSync(db,{readOnly:true});assert.equal(probe.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 const schemaBefore=probe.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();probe.close();
 // SQLite read-only WAL inspection itself establishes operational sidecars.
 const before=wmDirectoryEvidence(root);
 const a=serverApi.createMemorySuiteServer({dataDir:root,token:master,autoBackup:false,computeEnabled:false,wmServerIdentity:F.storeIdentity()});t.after(async()=>{await a.close();a.server.emit('close');});
 assert.equal(a.wmService.status().available,false,name);
 assert.equal((await request(a,'GET','/health')).body.wm.available,false);
 const h=await auth(a,wmPlugin);assert.equal((await request(a,'POST','/v1/wm/snapshot/acquire',{scope:'scope-a'},h)).statusCode,503);
 const core=await auth(a,'libra');assert.equal((await request(a,'GET','/v1/kv/get?namespace=libra&space=plugin&key=existing-schema-safety',undefined,core)).statusCode,200);
 await a.close();a.server.emit('close');assert.equal(F.sha(fs.readFileSync(db)),mainBefore,'damaged main DB bytes must remain unchanged');
 assert.deepEqual(F.sqliteRead(db,'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name'),schemaBefore,'missing or incompatible schema must remain unchanged');
 assert.deepEqual(wmDirectoryEvidence(root),before,'read-only baseline and final WM files must remain unchanged');
});
test('wm_A4_F2_raised_body_limit_matches_integrated_reader_ceiling',async t=>{
 const maxActual=96*1024*1024;const {a,root}=app(t,{wmLimits:{maxBodyBytes:128*1024*1024}});const h=await auth(a,wmPlugin);
 const caps=await request(a,'GET','/v1/wm/capabilities',undefined,h);assert.equal(caps.statusCode,200);assert.equal(caps.body.result.limits.maxBodyBytes,maxActual);
 const over=await request(a,'POST','/v1/wm/snapshot/acquire',undefined,{...h,'content-length':String(maxActual+1)});
 assert.equal(over.statusCode,413);assert.equal(over.body.error,'wm_encoded_body_limit');assert.equal(over.body.maxBytes,caps.body.result.limits.maxBodyBytes);
 assert.equal(fs.existsSync(path.join(root,'stores/wm/wm.sqlite')),false);
});
test('wm_A4_F2_smaller_body_limit_matches_integrated_reader_boundary',async t=>{
 const {a,root}=app(t,{wmLimits:{maxBodyBytes:512}});const h=await auth(a,wmPlugin);const caps=await request(a,'GET','/v1/wm/capabilities',undefined,h);
 const over=await request(a,'POST','/v1/wm/snapshot/acquire',undefined,{...h,'content-length':'513'});assert.equal(over.statusCode,413);assert.equal(over.body.maxBytes,caps.body.result.limits.maxBodyBytes);assert.equal(caps.body.result.limits.maxBodyBytes,512);
 assert.equal(fs.existsSync(path.join(root,'stores/wm/wm.sqlite')),false);
});
test('wm_A4_R2_sqliteX_trigger_rejects_before_boot_mutation',async t=>{
 const {s,root,db}=service(t);assert.equal(call(s,wm(),'snapshot/initialize',F.initialization()).statusCode,200);s.close();
 F.sqliteMutate(db,database=>database.exec('CREATE TRIGGER sqliteXevil AFTER UPDATE ON metadata BEGIN DELETE FROM heads; END'));
 const mainBefore=F.sha(fs.readFileSync(db));const schemaBefore=F.sqliteRead(db,'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name');
 const headsBefore=F.sqliteRead(db,'SELECT * FROM heads ORDER BY scope');assert.equal(headsBefore.length,1);
 const before=wmDirectoryEvidence(root);
 const a=serverApi.createMemorySuiteServer({dataDir:root,token:master,autoBackup:false,computeEnabled:false,wmServerIdentity:F.storeIdentity()});t.after(async()=>{await a.close();a.server.emit('close');});
 assert.equal(a.wmService.status().available,false,'sqliteXevil must be rejected before any pin boot write');
 const wmHeaders=await auth(a,wmPlugin);assert.equal((await request(a,'POST','/v1/wm/snapshot/acquire',{scope:'scope-a'},wmHeaders)).statusCode,503);
 const core=await auth(a,'libra');assert.equal((await request(a,'GET','/v1/kv/get?namespace=libra&space=plugin&key=sqlite-prefix-safety',undefined,core)).statusCode,200);
 await a.close();a.server.emit('close');
 assert.equal(F.sha(fs.readFileSync(db)),mainBefore);assert.deepEqual(F.sqliteRead(db,'SELECT * FROM heads ORDER BY scope'),headsBefore);
 assert.deepEqual(F.sqliteRead(db,'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name'),schemaBefore);assert.deepEqual(wmDirectoryEvidence(root),before);
});
test('wm_A4_R2_sqlite_autoindexes_do_not_block_valid_store_reopen',t=>{
 const {s,root,db}=service(t);assert.equal(call(s,wm(),'snapshot/initialize',F.initialization()).statusCode,200);s.close();
 const indexes=F.sqliteRead(db,"SELECT name FROM sqlite_master WHERE type='index'");assert.ok(indexes.some(value=>value.name.startsWith('sqlite_autoindex_')));
 const headsBefore=F.sqliteRead(db,'SELECT * FROM heads ORDER BY scope');
 const reopened=serviceApi.createWmService({dataDir:root,serverIdentity:F.storeIdentity()});t.after(()=>reopened.close());
 assert.equal(reopened.status().available,true);assert.equal(call(reopened,wm(),'snapshot/acquire',{scope:'scope-a'}).statusCode,200);
 assert.deepEqual(F.sqliteRead(db,'SELECT * FROM heads ORDER BY scope'),headsBefore);
});
