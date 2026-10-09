'use strict';
// Explicit WM actions. principal is verified authentication context, never body authority.
const crypto=require('node:crypto');
const C=require('../../sdk/WmStorageContracts.source.js');
const {validateInventoryItem}=require('./pins.cjs');
const token=v=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
const fp=v=>sha(Buffer.from(stable(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='requestFingerprint')))));
const fail=(reason,statusCode=400)=>{throw Object.assign(Error('wm_'+reason),{code:'WM_'+reason,statusCode});};
function plain(value) {
 const active=new Set();function visit(v){
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='string'){if(!v.isWellFormed())fail('non_plain_data');return;}
  if(typeof v==='number'){if(!Number.isFinite(v))fail('non_plain_data');return;}
  if(typeof v!=='object'||active.has(v))fail('non_plain_data');
  const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('non_plain_data');
  active.add(v);const ds=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(v);
  if(array&&ks.length!==v.length+1)fail('non_plain_data');
  for(const k of ks){if(typeof k!=='string')fail('non_plain_data');if(array&&k==='length')continue;const d=ds[k];
   if(!d.enumerable||!Object.hasOwn(d,'value')||['__proto__','constructor','prototype'].includes(k)||!k.isWellFormed()||array&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length))fail('non_plain_data');visit(d.value);
  }active.delete(v);
 }visit(value);return value;
}
const keys=(v,ks)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==ks.length||!ks.every(k=>Object.hasOwn(v,k)))fail('unknown_field');};
const checked=(v,validate)=>{const r=validate(v);if(!r.ok)fail(r.reason);};
const scope=v=>{if(typeof v!=='string'||!v||Buffer.byteLength(v)>1024)fail('scope_invalid');};
const integer=(v,positive=false)=>{if(!Number.isSafeInteger(v)||v<(positive?1:0))fail('integer_invalid');};
const signed=(v,ks)=>{keys(v,ks);if(!token(v.operationId)||!digest(v.requestFingerprint)||fp(v)!==v.requestFingerprint)fail('request_fingerprint_mismatch');};
const LEASE_KEYS=['schema','pinId','nonce','bootId','bootGeneration','authorityId','storeId','datasetId','backendId','scope','generationId','routeGeneration','writerEpoch','issuedAt','expiresAt'];
function lease(v){keys(v,LEASE_KEYS);if(v.schema!=='wm.pin-lease.v1'||!LEASE_KEYS.filter(k=>!['schema','scope','issuedAt','expiresAt'].includes(k)).every(k=>token(v[k])))fail('lease_invalid');scope(v.scope);integer(v.issuedAt);integer(v.expiresAt,true);if(v.expiresAt<=v.issuedAt)fail('lease_invalid');}
function wmPrincipalForPluginId(pluginId){return pluginId===C.PLUGIN_ID?Object.freeze({role:'wm_owner',pluginId:C.PLUGIN_ID,namespaces:Object.freeze(['wm']),access:'write'}):null;}
function isWmPrincipal(p){return !!p&&p.role==='wm_owner'&&p.pluginId===C.PLUGIN_ID&&p.access==='write'&&Array.isArray(p.namespaces)&&p.namespaces.length===1&&p.namespaces[0]==='wm';}
function isManager(p){return p?.pluginId==='flashback_hayaku_bridge'&&((p.role==='manager'&&p.access==='manager')||Array.isArray(p.roles)&&p.roles.includes('manager'));}
const READ_ROUTES=new Set(['capabilities','dataset/status']);
const ACTIONS=new Set(['manual/status','manual/begin','manual/chunk','manual/stage-status','manual/seal','manual/activate','manual/list','manual/lookup','manual/read','manual/write','history/capabilities','history/state','history/renew','history/begin','history/stage','history/read','snapshot/roots','snapshot/closure','snapshot/find','snapshot/initialize','snapshot/acquire','snapshot/read','snapshot/head','snapshot/release','snapshot/observe','snapshot/prepare','snapshot/publish','snapshot/status','snapshot/companion','inventory/open','inventory/page','inventory/chunk','inventory/close','inventory/put','dataset/fence','dataset/activate','migration/inspect','migration/begin','migration/chunk','migration/status','migration/verify','migration/materialize','migration/readback','handoff/capabilities','handoff/begin','handoff/chunk','handoff/stageStatus','handoff/verifyStage','handoff/materialize','handoff/readback','handoff/complete','handoff/status','handoff/abort','handoff/rollback']);
function wireChunk(chunk){return {encoding:'base64',data:Buffer.from(chunk.bytes).toString('base64'),offset:chunk.offset,nextOffset:chunk.nextOffset,totalBytes:chunk.totalBytes,sha256:chunk.sha256};}
function decodeInventory(v,limits){
 keys(v,C.DTO_KEYS.InventoryWrite);if(!token(v.operationId)||!digest(v.requestFingerprint)||!token(v.routeGeneration)||!token(v.writerEpoch)||!token(v.expectedInventoryRevision)||!Array.isArray(v.items)||v.items.length===0)fail('inventory_write_invalid');
 if(v.items.length>limits.maxInventoryBatchItems)fail('inventory_batch_limit',413);
 let total=0;const ids=new Set();
 const items=v.items.map(entry=>{
  keys(entry,['descriptor','payload']);checked(entry.descriptor,C.validateItem);const d=entry.descriptor,p=entry.payload;keys(p,C.DTO_KEYS.WireChunk);
  if(ids.has(d.logicalId))fail('duplicate_logical_id');ids.add(d.logicalId);
  if(p.encoding!=='base64'||typeof p.data!=='string'||!digest(p.sha256))fail('wire_chunk_invalid');integer(p.offset);integer(p.totalBytes);
  if(p.offset!==0)fail('partial_chunk_unsupported');
  if(p.data.length>4*Math.ceil(limits.maxChunkBytes/3))fail('chunk_encoded_limit',413);
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data))fail('base64_invalid');
  const bytes=Buffer.from(p.data,'base64');if(bytes.toString('base64')!==p.data)fail('base64_invalid');
  if(bytes.length>limits.maxChunkBytes)fail('chunk_decoded_limit',413);
  if(bytes.length!==p.totalBytes||d.bytes!==p.totalBytes)fail('chunk_byte_mismatch');
  if(sha(bytes)!==p.sha256||p.sha256!==d.sha256)fail('chunk_digest_mismatch');
  if(total>Number.MAX_SAFE_INTEGER-bytes.length)fail('byte_total_overflow');total+=bytes.length;
  if(total>limits.maxInventoryBatchBytes)fail('inventory_batch_limit',413);
  return {descriptor:d,payload:new Uint8Array(bytes)};
 });
 const projection={...v,items:items.map(x=>({descriptor:x.descriptor,payload:{encoding:'base64',data:Buffer.from(x.payload).toString('base64')}}))};
 if(fp(projection)!==v.requestFingerprint)fail('request_fingerprint_mismatch');return {...v,items};
}
function handleWmRequest({method,path,body={},principal,service}={}){
 const ok=result=>({statusCode:200,body:{ok:true,result}});
 try {
  if(typeof path!=='string'||!path.startsWith('/v1/wm/'))fail('route_not_found',404);
  const action=path.slice('/v1/wm/'.length);
  if(!isWmPrincipal(principal)&&!(isManager(principal)&&action==='dataset/status'))fail('capability_forbidden',403);
  if(!READ_ROUTES.has(action)&&!ACTIONS.has(action))fail('route_not_found',404);
  if(method!==(READ_ROUTES.has(action)?'GET':'POST'))fail('method_not_allowed',405);
  plain(body);const caps=service.capabilities(),limits=caps.limits;
  if(Buffer.byteLength(stable(body))>limits.maxBodyBytes)fail('encoded_body_limit',413);
  if(READ_ROUTES.has(action)){keys(body,[]);return ok(action==='capabilities'?caps:service.status());}
  if(action.startsWith('manual/'))return ok(service.manual(action.slice(7),body));
  if(action.startsWith('handoff/')){
   const method=action.slice('handoff/'.length);
   if(method==='capabilities'){keys(body,[]);return ok(service.handoffCapabilities());}
   const common=['transferId','targetIdentity','operationId','requestFingerprint'];
   if(method==='begin')signed(body,[...common,'sourceIdentity','sourceHead','sourceRoute','targetRoute','sourceFingerprint','payloadDigest','snapshot','domains','expectedTargetHead','sourceItems','pendingReceipt']);
   else keys(body,[...common,...{chunk:['descriptor','offset','payload','pendingReceipt'],stageStatus:['logicalId'],verifyStage:[],materialize:['pendingReceipt'],readback:[],complete:['receipt','pendingReceipt'],status:[],abort:['pendingReceipt'],rollback:['expectedTargetHead','pendingReceipt']}[method]]);
   if(!token(body.transferId)||!token(body.operationId)||!digest(body.requestFingerprint))fail('handoff_identity_invalid');
   if(method==='chunk'){checked(body.descriptor,validateInventoryItem);integer(body.offset);keys(body.payload,['encoding','data']);
    if(body.payload.encoding!=='base64'||typeof body.payload.data!=='string'||body.payload.data.length>4*Math.ceil(limits.maxMigrationChunkBytes/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.payload.data))fail('handoff_chunk_invalid');
    const bytes=Buffer.from(body.payload.data,'base64');if(bytes.toString('base64')!==body.payload.data||bytes.length>limits.maxMigrationChunkBytes)fail('handoff_chunk_invalid');const {payload,...input}=body;return ok(service.handoff(method,{...input,bytes:new Uint8Array(bytes)}));}
   return ok(service.handoff(method,body));
  }
  switch(action){
   case 'history/state':keys(body,[]);return ok(service.historyState());
   case 'history/capabilities':keys(body,[]);return ok(service.historyCapabilities());
   case 'history/begin':signed(body,['operationId','requestFingerprint','scope','expectedHead','routeGeneration','writerEpoch']);return ok(service.beginPageStage(body));
   case 'history/renew':signed(body,['operationId','requestFingerprint','scope','expectedHead','routeGeneration','writerEpoch','previousReceipt']);return ok(service.renewPageStage(body));
   case 'history/stage':signed(body,['operationId','requestFingerprint','receipt','descriptor','payload']);return ok(service.stagePage(body));
   case 'history/read':keys(body,['receipt','logicalId','offset','maxBytes']);return ok(wireChunk(service.readStagedPage(body)));
   case 'snapshot/find':keys(body,['lease','schema','cursor','maxItems','maxBytes']);lease(body.lease);return ok(service.findCompanions(body));
   case 'snapshot/roots':keys(body,['lease']);lease(body.lease);return ok(service.readRootManifest(body.lease));
   case 'snapshot/closure':keys(body,['lease','cursor','maxItems','maxBytes']);lease(body.lease);return ok(service.readClosurePage(body));

   case 'snapshot/initialize':signed(body,['scope','operationId','requestFingerprint','routeGeneration','writerEpoch','expectedEmpty']);scope(body.scope);if(!token(body.routeGeneration)||!token(body.writerEpoch)||body.expectedEmpty!==true)fail('initialize_invalid');return ok(service.initializeScope(body));
   case 'snapshot/prepare':checked(body,C.validateOperation);if(fp(body)!==body.requestFingerprint)fail('request_fingerprint_mismatch');if(Buffer.byteLength(body.raw??'')>limits.maxCanonicalBytes)fail('canonical_limit',413);return ok(service.prepare(body));
   case 'snapshot/publish':keys(body,C.DTO_KEYS.Prepared);checked(body.expectedHead,C.validateHead);checked(body.head,C.validateHead);if(!token(body.preparedId)||!token(body.operationId)||!digest(body.requestFingerprint)||!digest(body.rawSha256)||!C.WRITER_OPERATIONS.includes(body.operation))fail('prepared_invalid');scope(body.scope);return ok(service.publish(body));
   case 'snapshot/status':keys(body,['operationId','requestFingerprint']);if(!token(body.operationId)||!digest(body.requestFingerprint))fail('status_invalid');return ok(service.operationStatus(body));
   case 'snapshot/acquire':keys(body,['scope']);scope(body.scope);return ok(service.acquire(body.scope));
   case 'snapshot/read':keys(body,['lease']);lease(body.lease);return ok({raw:service.readGeneration(body.lease)});
   case 'snapshot/head':keys(body,['scope','lease']);scope(body.scope);lease(body.lease);return ok(service.head(body.scope,body.lease));
   case 'snapshot/release':keys(body,['lease']);lease(body.lease);service.release(body.lease);return ok({released:true});
   case 'snapshot/observe':keys(body,['scopes','leases']);if(!Array.isArray(body.scopes)||!body.scopes.length||body.scopes.length>limits.maxBatchItems||new Set(body.scopes).size!==body.scopes.length||!Array.isArray(body.leases)||body.leases.length!==body.scopes.length)fail('observation_invalid');body.scopes.forEach(scope);body.leases.forEach(lease);return ok(service.observeHeads(body.scopes,{leases:body.leases}));
   case 'inventory/open':keys(body,['routeGeneration']);if(!token(body.routeGeneration))fail('route_generation_invalid');return ok(service.openInventory(body));
   case 'inventory/page':keys(body,['snapshotId','cursor','maxItems','maxBytes']);if(!token(body.snapshotId)||body.cursor!==null&&!token(body.cursor))fail('inventory_cursor_invalid');integer(body.maxItems,true);integer(body.maxBytes,true);if(body.maxItems>limits.maxPageItems||body.maxBytes>limits.maxPageBytes)fail('page_limit',413);const page=service.readInventoryPage(body);page.items.forEach(d=>checked(d,validateInventoryItem));return ok(page);
   case 'inventory/close':keys(body,['snapshotId']);if(!token(body.snapshotId))fail('snapshot_invalid');service.closeInventory(body.snapshotId);return ok({closed:true});
   case 'snapshot/companion':case 'inventory/chunk':{
    const key=action==='snapshot/companion'?'lease':'snapshotId';keys(body,[key,'logicalId','offset','maxBytes']);if(key==='lease')lease(body.lease);else if(!token(body.snapshotId))fail('snapshot_invalid');if(!token(body.logicalId))fail('logical_id_invalid');integer(body.offset);integer(body.maxBytes,true);if(body.maxBytes>limits.maxChunkBytes)fail('chunk_decoded_limit',413);return ok(wireChunk(key==='lease'?service.readCompanion(body):service.readInventoryChunk(body)));
   }
   case 'migration/inspect':keys(body,[]);return ok(service.inspectMigrationDestination());
   case 'migration/begin':signed(body,['operationId','requestFingerprint','sourceRoute','targetRoute','snapshot']);return ok(service.beginMigrationStage(body));
   case 'migration/status':case 'migration/verify':case 'migration/materialize':case 'migration/readback':return ok(service[{'migration/status':'migrationStageStatus','migration/verify':'verifyMigrationStage','migration/materialize':'materializeMigrationStage','migration/readback':'verifyMigrationReadback'}[action]](body));
   case 'migration/chunk':{keys(body,['operationId','requestFingerprint','descriptor','offset','payload']);checked(body.descriptor,validateInventoryItem);integer(body.offset);keys(body.payload,['encoding','data']);if(body.payload.encoding!=='base64'||typeof body.payload.data!=='string'||body.payload.data.length>4*Math.ceil(limits.maxMigrationChunkBytes/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.payload.data))fail('migration_chunk_invalid');const bytes=Buffer.from(body.payload.data,'base64');if(bytes.toString('base64')!==body.payload.data||bytes.length>limits.maxMigrationChunkBytes)fail('migration_chunk_invalid');const {payload,...meta}=body;return ok(service.stageMigrationChunk({...meta,bytes:new Uint8Array(bytes)}));}
   case 'inventory/put':return ok(service.putInventoryItems(decodeInventory(body,limits)));
   case 'dataset/fence':signed(body,C.DTO_KEYS.FenceInput);checked(body.expectedRoute,C.validateRoute);return ok(service.fenceDataset(body));
   case 'dataset/activate':signed(body,C.DTO_KEYS.ActivateInput);checked(body.expectedRoute,C.validateRoute);checked(body.targetRoute,C.validateRoute);if(!digest(body.sealedInventoryDigest))fail('inventory_digest_invalid');return ok(service.activateDataset(body));
  }
 }catch(e){
  const reason=typeof e.code==='string'&&/^WM_[a-z0-9_]+$/.test(e.code)?e.code.slice(3):'storage_unavailable';
  const code=e.statusCode||(/service_closed|storage_unavailable|storage_uncertain|integrity/.test(reason)?503:/lease|conflict|fenced|missing|previous_boot|expired|released/.test(reason)?409:/limit/.test(reason)?413:400);
  return {statusCode:code,body:{ok:false,error:'wm_'+reason,...e.operationId&&token(e.operationId)?{operationId:e.operationId}:{},...e.requestFingerprint&&digest(e.requestFingerprint)?{requestFingerprint:e.requestFingerprint}:{},...reason==='storage_uncertain'?{uncertain:true}:{}}};
 }
}
module.exports=Object.freeze({handleWmRequest,wmPrincipalForPluginId});
