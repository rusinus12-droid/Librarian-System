/* Ordinary WM owner storage under an explicitly weaker manual copy/switch contract.
 * This module never qualifies WmNativeHostGate or manufactures native CAS/fences. */
const WmManualStorage=(()=>{
 'use strict';
 const C=typeof WmStorageContracts!=='undefined'?WmStorageContracts:require('./wm-storage-contracts.source.js');
 const I=typeof WmStorageInventory!=='undefined'?WmStorageInventory:require('./wm-storage-inventory.source.js');
 const PROFILE='wm.manual-copy-switch.v1',ROUTE='WMManual::route::v1',RECEIPT='WMManual::receipt::v1';
 const utf8=v=>new TextEncoder().encode(v),stable=I.canonicalJson,clone=v=>JSON.parse(stable(v)),hash=v=>C.hashBytes(utf8(v));
 const fail=r=>{throw Error(r);},token=v=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
 const b64=bytes=>{let s='';for(let n=0;n<bytes.length;n+=8192)s+=String.fromCharCode(...bytes.subarray(n,n+8192));return btoa(s);};
 const un64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
 const initial=()=>({profile:PROFILE,mode:'plugin_only',generation:null,routeGeneration:'manual-native-initial',datasetId:'wm-native',backendId:'plugin-local',state:'active',server:null});
 const routeView=r=>Object.fromEntries(['mode','routeGeneration','datasetId','backendId','state'].map(k=>[k,r[k]]).concat([['schema',C.ROUTE_SCHEMA]]));
 const same=(a,b)=>stable(a)===stable(b),totals=()=>Object.fromEntries(C.DOMAINS.map(d=>[d,0]));
 async function createWmManualStorage({storage,nativeStores,connection,inventoryFactory,pause=async()=>{}}={}){
  if(!storage||!nativeStores?.plugin||!nativeStores?.local||!connection||typeof inventoryFactory!=='function')fail('manual_options_invalid');
  const local=storage,activeIO=new Set(),knownReads=new Map(),previews=new Map();let serialTail=Promise.resolve(),writeTail=Promise.resolve(),paused=false,reloadRequired=false;
  const serial=fn=>{const p=serialTail.catch(()=>{}).then(fn);serialTail=p.catch(()=>{});return p;};
  const serialWrite=fn=>{const p=writeTail.catch(()=>{}).then(fn);writeTail=p.catch(()=>{});return p;};
  async function readJson(k){const raw=await local.getItem(k,{strict:true});if(raw==null)return null;try{return JSON.parse(raw);}catch{fail('manual_metadata_invalid');}}
  async function writeJson(k,v){const raw=stable(v);if(await local.setItem(k,raw,{strict:true})===false||await local.getItem(k,{strict:true})!==raw)fail('manual_metadata_unverified');}
  async function readRoute(){const r=await readJson(ROUTE);if(r===null)return initial();if(r.profile!==PROFILE||!['plugin_only','server_only'].includes(r.mode)||!C.validateRoute(routeView(r)).ok||r.generation!==null&&!token(r.generation))fail('manual_route_invalid');return r;}
  let loadedRoute=await readRoute(),receipt=await readJson(RECEIPT);
  const pending=e=>!!e&&!['complete','conflict'].includes(e.state);
  if(receipt&&receipt.profile!==PROFILE)fail('manual_receipt_invalid');
  if(pending(receipt)){paused=true;await pause();}
  connection.setConfigurationGuard?.(async baseUrl=>{const r=await readRoute(),e=await readJson(RECEIPT);return r.mode==='plugin_only'&&!pending(e)&&!reloadRequired||!!baseUrl&&(await connection.inspectConfiguration()).baseUrl===baseUrl;});
  async function admission(){if(paused||reloadRequired)fail('manual_work_paused');if(!same(await readRoute(),loadedRoute))fail('manual_route_changed');if(pending(await readJson(RECEIPT)))fail('manual_work_paused');}
  async function own(fn){await admission();if(paused||reloadRequired)fail("manual_work_paused");const p=Promise.resolve().then(fn);activeIO.add(p);try{return await p;}finally{activeIO.delete(p);}}
  async function stop(){paused=true;await pause();await Promise.allSettled([...activeIO]);await connection.drain?.();}
  const recordKey=(g,id,digest)=>'WMManual::data::'+g+'::'+id+'::'+digest,catalogKey=g=>'WMManual::catalog::'+g;
  async function catalog(g){const v=await readJson(catalogKey(g));if(!v||v.profile!==PROFILE||v.generation!==g||!Array.isArray(v.records))fail('manual_catalog_invalid');return v;}
  async function descriptor(space,key,domain,raw,tombstone=false){const bytes=utf8(raw);return {id:await hash(space+'\n'+key),space,key,domain,bytes:bytes.length,sha256:await C.hashBytes(bytes),tombstone};}
  async function checkRecord(d,raw){if(typeof raw!=='string'||utf8(raw).length!==d.bytes||await hash(raw)!==d.sha256)fail('manual_content_mismatch');return raw;}
  async function localRead(g,d){return checkRecord(d,await local.getItem(recordKey(g,d.id,d.sha256),{strict:true}));}
  async function remoteRead(g,d){if(d.bytes===0){if(d.sha256!==await hash(''))fail('manual_content_mismatch');return '';}
   let at=0,parts=[];while(at<d.bytes){const c=await connection.requestManual('read',{generation:g,id:d.id,sha256:d.sha256,offset:at,maxBytes:262144}),b=un64(c.data);if(c.offset!==at||c.sha256!==d.sha256||c.totalBytes!==d.bytes||b.length===0||b.length>262144||at+b.length>d.bytes)fail('manual_chunk_invalid');parts.push(b);at+=b.length;if(c.nextOffset!==(at<d.bytes?at:null))fail('manual_chunk_invalid');}
   const bytes=new Uint8Array(at);let n=0;for(const b of parts){bytes.set(b,n);n+=b.length;}return checkRecord(d,new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  async function serverStatus(){const s=await connection.requestManual('status');if(s.profile!==PROFILE||!s.identity||!token(s.identity.backendId)||!token(s.identity.datasetId)||s.activeId!==null&&!token(s.activeId)||!token(s.revision)||s.allWritersFenced!==false||s.nativeAtomic!==false)fail('manual_server_profile_invalid');return s;}
  function serverMatches(s,r=loadedRoute){return !!r.server&&same(s.identity,r.server.identity)&&s.activeId===r.generation;}
  async function remoteRows(s){const out=[];let cursor=0;do{const p=await connection.requestManual('list',{generation:s.activeId,expectedRevision:s.revision,cursor});if(!Array.isArray(p.records)||p.records.length>128||p.revision!==s.revision||p.nextCursor!==null&&(!Number.isSafeInteger(p.nextCursor)||p.nextCursor<=cursor))fail('manual_inventory_invalid');out.push(...p.records);if(out.length>100000)fail('manual_inventory_capacity');cursor=p.nextCursor;}while(cursor!==null);if(await hash(stable(out.slice().sort((a,b)=>a.id.localeCompare(b.id))))!==s.inventoryDigest)fail('manual_inventory_mismatch');return out;}
  async function get(space,key){if(loadedRoute.generation===null)return nativeStores[space].getItem(key,{strict:true});const kind=I.manualKeyKind(key);if(kind==='private')return nativeStores[space].getItem(key,{strict:true});if(kind==='unknown')fail('manual_record_unsupported');
   if(loadedRoute.generation===null)return nativeStores[space].getItem(key,{strict:true});
   const id=await hash(space+'\n'+key);let d,raw;
   if(loadedRoute.mode==='server_only'){const s=await serverStatus();if(!serverMatches(s))fail('manual_server_identity_changed');const v=await connection.requestManual('lookup',{generation:s.activeId,id});d=v.record;knownReads.set(space+'\n'+key,{revision:v.revision,sha256:d?.sha256??null});if(d)raw=await remoteRead(s.activeId,d);}
   else{const c=await catalog(loadedRoute.generation);d=c.records.find(d=>d.id===id);knownReads.set(space+'\n'+key,{revision:c.revision,sha256:d?.sha256??null});if(d)raw=await localRead(c.generation,d);}
   if(!d||d.tombstone)return null;
   const saved=await readJson('WMManual::private::'+loadedRoute.generation+'::'+id);
   if(saved&&saved.sha256===d.sha256&&typeof saved.wire==='string'){if(I.projectManualRecord(key,saved.wire).raw!==raw)fail('manual_private_binding_invalid');return saved.wire;}return raw;
  }
  async function set(space,key,value,remove=false){if(loadedRoute.generation===null)return remove?nativeStores[space].removeItem(key):nativeStores[space].setItem(key,value,{strict:true});const kind=I.manualKeyKind(key);if(kind==='private')return remove?nativeStores[space].removeItem(key):nativeStores[space].setItem(key,value,{strict:true});if(kind==='unknown')fail('manual_record_unsupported');
   if(loadedRoute.generation===null)return remove?nativeStores[space].removeItem(key):nativeStores[space].setItem(key,value,{strict:true});
   const projected=remove?{raw:'',private:{},kind}:I.projectManualRecord(key,String(value)),d=await descriptor(space,key,kind,projected.raw,remove),id=d.id;
   if(loadedRoute.mode==='server_only'){
    const s=await serverStatus();if(!serverMatches(s))fail('manual_server_identity_changed');const observed=knownReads.get(space+'\n'+key);
    if(observed&&observed.revision!==s.revision){const latest=await connection.requestManual('lookup',{generation:s.activeId,id});if((latest.record?.sha256??null)!==observed.sha256)fail('manual_source_changed');}
    const r=await connection.requestManual('write',{generation:s.activeId,expectedRevision:s.revision,record:d,value:projected.raw,operationId:'wm-manual-'+globalThis.crypto.randomUUID()});if(!r.ok||!same(r.record,d))fail('manual_write_unconfirmed');knownReads.set(space+'\n'+key,{revision:r.revision,sha256:d.sha256});
   }else{
    const c=await catalog(loadedRoute.generation),old=c.records.find(x=>x.id===id),observed=knownReads.get(space+'\n'+key);if(observed&&observed.sha256!==(old?.sha256??null))fail('manual_source_changed');
    if(await local.setItem(recordKey(c.generation,id,d.sha256),projected.raw,{strict:true})===false)fail('manual_write_unconfirmed');await localRead(c.generation,d);
    c.records=c.records.filter(x=>x.id!==id).concat([d]).sort((a,b)=>a.id.localeCompare(b.id));c.revision='local-'+globalThis.crypto.randomUUID();await writeJson(catalogKey(c.generation),c);knownReads.set(space+'\n'+key,{revision:c.revision,sha256:d.sha256});
   }
   // Only same-client private execution metadata is retained locally; never transported.
   await writeJson('WMManual::private::'+loadedRoute.generation+'::'+id,{sha256:d.sha256,wire:remove?null:String(value)});return true;
  }
  const executionKey=k=>typeof k==='string'&&(/^libra:v1:[^:]+:archive:wal$/.test(k)||k.endsWith('::publication')||['wm.execution-capture','wm.execution-state'].includes(k));
  const privateKey=(space,k)=>loadedRoute.generation!==null&&executionKey(k)?'WMManual::execution::'+loadedRoute.generation+'::'+space+'::'+k:k;
  const privateIO=(space,k,fn)=>executionKey(k)?own(()=>fn(privateKey(space,k))):fn(k);
  const wrap=space=>Object.freeze({
   getItem:(k,o={})=>I.manualKeyKind(k)==='private'?privateIO(space,k,key=>nativeStores[space].getItem(key,o)):own(()=>get(space,k)),setItem:(k,v,o={})=>I.manualKeyKind(k)==='private'?privateIO(space,k,key=>nativeStores[space].setItem(key,v,o)):own(()=>serialWrite(()=>set(space,k,v))),removeItem:k=>I.manualKeyKind(k)==='private'?privateIO(space,k,key=>nativeStores[space].removeItem(key)):own(()=>serialWrite(()=>set(space,k,'',true))),
   keys:()=>own(async()=>{if(loadedRoute.generation===null)return nativeStores[space].keys({strict:true});const localKeys=(await nativeStores[space].keys({strict:true})).filter(k=>I.manualKeyKind(k)==='private'&&!executionKey(k)&&!k.startsWith('WMManual::'));
    let ds;if(loadedRoute.mode==='server_only'){const s=await serverStatus();if(!serverMatches(s))fail('manual_server_identity_changed');ds=await remoteRows(s);}else ds=(await catalog(loadedRoute.generation)).records;return [...new Set([...localKeys,...ds.filter(d=>d.space===space&&!d.tombstone).map(d=>d.key)])];}),
   inventoryPhysicalKeys:k=>loadedRoute.generation===null?nativeStores[space].inventoryPhysicalKeys?.(k)||[]:[],readRouteIdentity:()=>loadedRoute.generation===null?nativeStores[space].readRouteIdentity?.()||null:null
  });
  async function capture(){
   const r=await readRoute();let records=[],sourceStamp,sourceCheck;
   if(r.generation!==null){
    let ds;if(r.mode==='server_only'){const s=await serverStatus();if(!serverMatches(s,r))fail('manual_server_identity_changed');ds=await remoteRows(s);sourceStamp={route:r,revision:s.revision,inventoryDigest:s.inventoryDigest};sourceCheck=async()=>{const n=await serverStatus();return n.activeId===s.activeId&&n.revision===s.revision&&n.inventoryDigest===s.inventoryDigest&&same(n.identity,s.identity);};for(const d of ds)records.push({descriptor:d,raw:await remoteRead(r.generation,d)});}
    else{const c=await catalog(r.generation);ds=c.records;sourceStamp={route:r,revision:c.revision,inventoryDigest:await hash(stable(ds))};sourceCheck=async()=>same(await catalog(r.generation),c);for(const d of ds)records.push({descriptor:d,raw:await localRead(r.generation,d)});}
    for(const record of records.slice())if(record.descriptor.space!=='archive'&&!record.descriptor.tombstone){const old=record.raw,p=I.projectManualRecord(record.descriptor.key,old,{historical:true});if(p.raw!==old){const archiveKey='historical-'+await hash(record.descriptor.space+'\n'+record.descriptor.key+'\n'+old),d=await descriptor('archive',archiveKey,record.descriptor.domain,old);if(!records.some(x=>x.descriptor.id===d.id))records.push({descriptor:d,raw:old});record.raw=p.raw;record.descriptor=await descriptor(record.descriptor.space,record.descriptor.key,record.descriptor.domain,p.raw);}}
   }else{
    const inv=inventoryFactory(),snapshot=await inv.open({fence:{routeGeneration:r.routeGeneration}});
    try{if(snapshot.complete!==true)fail('inventory_incomplete');const native=inv.manualRecords(snapshot.snapshotId);for(const row of native)records.push({descriptor:await descriptor(row.space,row.key,row.domain,row.raw),raw:row.raw});
     let cursor=null;do{const page=await inv.page({snapshotId:snapshot.snapshotId,cursor,maxItems:128,maxBytes:262144});if(!page.complete||page.errors?.length)fail('inventory_incomplete');for(const d of page.items){let at=0,parts=[];do{const c=await inv.readChunk({snapshotId:snapshot.snapshotId,logicalId:d.logicalId,offset:at,maxBytes:262144});parts.push(c.bytes);at+=c.bytes.length;if(c.nextOffset===null)break;}while(at<d.bytes);const bytes=new Uint8Array(at);let n=0;for(const b of parts){bytes.set(b,n);n+=b.length;}if(at!==d.bytes||await C.hashBytes(bytes)!==d.sha256)fail('manual_content_mismatch');const raw=stable({descriptor:d,payload:b64(bytes)}),a=await descriptor('archive','inventory-'+d.logicalId,d.domain,raw);records.push({descriptor:a,raw});}cursor=page.nextCursor;}while(cursor!==null);
     const checked=await inv.verify(snapshot.snapshotId);if(!checked.complete||checked.inventoryDigest!==snapshot.inventoryDigest)fail('manual_source_changed');sourceStamp={route:r,inventoryDigest:snapshot.inventoryDigest};
    }finally{await inv.close(snapshot.snapshotId);}
    sourceCheck=null;
   }
   records.sort((a,b)=>a.descriptor.id.localeCompare(b.descriptor.id));if(new Set(records.map(x=>x.descriptor.id)).size!==records.length)fail('manual_inventory_duplicate');
   const descriptors=records.map(x=>x.descriptor),inventoryDigest=await hash(stable(descriptors));if(sourceCheck&&!await sourceCheck())fail('manual_source_changed');
   return {route:r,records,inventoryDigest,sourceFingerprint:await hash(stable(sourceStamp)),sourceStamp};
  }
  const publicState=e=>e?clone(Object.fromEntries(['operationId','requestFingerprint','state','sourceRoute','targetRoute','inventoryDigest','domainCounts','domainBytes','copiedBytes','reason','receipt'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))):null;
  async function save(e,state,reason){e.state=state;if(state==='conflict')reloadRequired=true;if(reason)e.reason=reason;else delete e.reason;await writeJson(RECEIPT,e);await writeJson('WMManual::receipt::'+e.operationId,e);receipt=e;return publicState(e);}
  async function sourceCurrent(e){if(!same(await readRoute(),e.originalRoute))return false;const s=await capture();return s.sourceFingerprint===e.sourceFingerprint&&s.inventoryDigest===e.inventoryDigest;}
  async function inspect({targetMode}={}){
   if(!['plugin_only','server_only'].includes(targetMode))fail('target_mode_invalid');const r=await readRoute(),blockers=[];if(r.mode===targetMode)blockers.push('already_target_mode');if(pending(await readJson(RECEIPT)))blockers.push('migration_pending');
   let snap=null,target=null;try{snap=await capture();}catch(e){blockers.push(/^[a-z0-9_]+$/.test(e.message)?e.message:'inventory_unavailable');}
   try{if(targetMode==='server_only'){target=await serverStatus();if(target.activeId!==null&&(!r.retainedServer||!same({activeId:target.activeId,revision:target.revision,identity:target.identity},r.retainedServer)))blockers.push('destination_existing_data');}else target={identity:{backendId:'plugin-local',datasetId:'wm-native'},activeId:null,revision:'empty'};}catch{blockers.push('server_connection_unavailable');}
   const domainCounts=totals(),domainBytes=totals();for(const row of snap?.records||[]){domainCounts[row.descriptor.domain]++;domainBytes[row.descriptor.domain]+=row.descriptor.bytes;}
   const v={sourceRoute:routeView(r),targetMode,targetBackendId:target?.identity.backendId||'unavailable',domainCounts,domainBytes,requiredStagingBytes:Object.values(domainBytes).reduce((a,b)=>a+b,0),sourcePreserved:true,targetHasExistingData:blockers.includes('destination_existing_data'),complete:!!snap,canStart:blockers.length===0,blockers};
   const previewFingerprint=await hash(stable({...v,sourceFingerprint:snap?.sourceFingerprint??null,target}));previews.set(previewFingerprint,{snapshot:snap,target,view:v});return {previewFingerprint,...v};
  }
  const prepare=input=>serial(async()=>{
   if(!token(input?.operationId)||input.operationId.length>64)fail('migration_input_invalid');const previous=await readJson(RECEIPT);if(previous?.operationId===input.operationId)return publicState(previous);if(pending(previous))fail('migration_pending');
   const p=previews.get(input.previewFingerprint);if(!p?.view.canStart)fail('migration_preview_blocked');await stop();
   let fresh;try{fresh=await capture();if(fresh.sourceFingerprint!==p.snapshot.sourceFingerprint||fresh.inventoryDigest!==p.snapshot.inventoryDigest)fail('preview_changed');}catch(err){reloadRequired=true;throw err;}
   const generation='copy-'+input.operationId,targetRoute={schema:C.ROUTE_SCHEMA,mode:p.view.targetMode,routeGeneration:generation,datasetId:p.target.identity.datasetId,backendId:p.target.identity.backendId,state:'active'};
   const e={profile:PROFILE,operationId:input.operationId,requestFingerprint:input.previewFingerprint,state:'preparing',sourceRoute:routeView(fresh.route),targetRoute,originalRoute:fresh.route,sourceFingerprint:fresh.sourceFingerprint,sourceStamp:fresh.sourceStamp,inventoryDigest:fresh.inventoryDigest,domainCounts:p.view.domainCounts,domainBytes:p.view.domainBytes,copiedBytes:0,index:0,offset:0,generation,target:p.target,records:fresh.records.map(x=>x.descriptor),switchIntent:false};
   await save(e,'preparing');for(const row of fresh.records){const k='WMManual::snapshot::'+e.operationId+'::'+row.descriptor.id,old=await local.getItem(k,{strict:true});if(old!==null&&old!==undefined&&old!==row.raw)fail('manual_snapshot_conflict');if(old==null&&await local.setItem(k,row.raw,{strict:true})===false)fail('manual_snapshot_unverified');await checkRecord(row.descriptor,await local.getItem(k,{strict:true}));}
   if(targetRoute.mode==='server_only'){if(!same((await serverStatus()).identity,e.target.identity))fail('manual_server_identity_changed');await connection.requestManual('begin',{generation,expected:{activeId:p.target.activeId,revision:p.target.revision},records:e.records,inventoryDigest:e.inventoryDigest});}
   else{const existing=await readJson(catalogKey(generation));if(existing&&!same(existing.records,e.records))fail('manual_destination_changed');if(!existing)await writeJson(catalogKey(generation),{profile:PROFILE,generation,revision:'staging',records:e.records,state:'copying'});}
   return save(e,'inventory_frozen');
  });
  const copyNext=({operationId,maxBytes=262144}={})=>serial(async()=>{
   const e=await readJson(RECEIPT);if(!e||e.operationId!==operationId)fail('migration_missing');if(!['inventory_frozen','copying','interrupted'].includes(e.state))return publicState(e);await stop();
   try{if(!await sourceCurrent(e))return save(e,'conflict','manual_source_changed');let budget=Math.min(262144,maxBytes);while(e.index<e.records.length&&budget>0){const d=e.records[e.index],raw=await checkRecord(d,await local.getItem('WMManual::snapshot::'+e.operationId+'::'+d.id,{strict:true})),bytes=utf8(raw);
     if(e.targetRoute.mode==='server_only'){const s=await connection.requestManual('stage-status',{generation:e.generation,id:d.id});if(s.complete){e.index++;e.offset=0;continue;}e.offset=s.offset;const b=bytes.subarray(e.offset,e.offset+budget);await connection.requestManual('chunk',{generation:e.generation,id:d.id,offset:e.offset,data:b64(b)});e.offset+=b.length;e.copiedBytes+=b.length;budget-=b.length;if(e.offset===d.bytes){e.index++;e.offset=0;}}
     else{const key=recordKey(e.generation,d.id,d.sha256),old=await local.getItem(key,{strict:true});if(old!==null&&old!==undefined&&old!==raw)fail('manual_destination_changed');if(old==null&&await local.setItem(key,raw,{strict:true})===false)fail('manual_copy_unverified');await localRead(e.generation,d);e.copiedBytes+=d.bytes;e.index++;budget-=d.bytes;}
     await save(e,'copying');}
    return save(e,e.index===e.records.length?'verifying':'copying');
   }catch(err){return save(e,'interrupted',/^[a-z0-9_]+$/.test(err.message)?err.message:'manual_copy_interrupted');}
  });
  async function verifyDestination(e){
   if(e.targetRoute.mode==='server_only'){if(!same((await serverStatus()).identity,e.target.identity))fail('manual_server_identity_changed');const r=await connection.requestManual('seal',{generation:e.generation,inventoryDigest:e.inventoryDigest});if(r.inventoryDigest!==e.inventoryDigest)fail('manual_inventory_mismatch');for(const d of e.records)await remoteRead(e.generation,d);}
   else{const c=await catalog(e.generation);if(!same(c.records,e.records))fail('manual_inventory_mismatch');for(const d of e.records)await localRead(e.generation,d);c.state='verified';await writeJson(catalogKey(e.generation),c);}
  }
  const verify=operationId=>serial(async()=>{const e=await readJson(RECEIPT);if(!e||e.operationId!==operationId)fail('migration_missing');await stop();try{if(e.index!==e.records.length)fail('manual_copy_incomplete');if(!await sourceCurrent(e))return save(e,'conflict','manual_source_changed');await verifyDestination(e);if(!await sourceCurrent(e))return save(e,'conflict','manual_source_changed');e.copiedBytes=Object.values(e.domainBytes).reduce((a,b)=>a+b,0);return save(e,'cutover_prepared');}catch(err){return save(e,'interrupted',/^[a-z0-9_]+$/.test(err.message)?err.message:'manual_verification_interrupted');}});
  const cutover=(operationId,confirmation={})=>serial(async()=>{
   if(confirmation.confirmed!==true)fail('manual_switch_confirmation_required');const e=await readJson(RECEIPT);if(!e||e.operationId!==operationId)fail('migration_missing');await stop();if(e.state==='complete'){reloadRequired=true;return publicState(e);}
   const current=await readRoute();if(!same(current,e.originalRoute)&&current.generation!==e.generation)return save(e,'conflict','manual_route_changed');
   if(!e.switchIntent&&e.state!=='cutover_prepared')fail('manual_verification_required');
   if(!e.switchIntent){if(!await sourceCurrent(e))return save(e,'conflict','manual_source_changed');await verifyDestination(e);e.switchIntent=true;await save(e,'uncertain','cutover_status_required');}
   try{
    let server=null,retainedServer=null;
    if(e.targetRoute.mode==='server_only'){if(!same((await serverStatus()).identity,e.target.identity))fail('manual_server_identity_changed');const a=await connection.requestManual('activate',{generation:e.generation,expected:{activeId:e.target.activeId,revision:e.target.revision},inventoryDigest:e.inventoryDigest});if(a.activeId!==e.generation||a.inventoryDigest!==e.inventoryDigest)fail('manual_activation_unverified');server={identity:e.target.identity};}
    else{const s=await serverStatus();if(!serverMatches(s,e.originalRoute))fail('manual_source_changed');retainedServer={activeId:s.activeId,revision:s.revision,identity:s.identity};}
    const next={profile:PROFILE,...Object.fromEntries(['mode','routeGeneration','datasetId','backendId','state'].map(k=>[k,e.targetRoute[k]])),generation:e.generation,server,...retainedServer?{retainedServer}:{}};
    const before=await readRoute();if(same(before,e.originalRoute)&&!await sourceCurrent(e))fail('manual_source_changed');if(!same(before,e.originalRoute)&&!same(before,next))fail('manual_route_changed');if(!same(before,next))await writeJson(ROUTE,next);if(!same(await readRoute(),next))fail('manual_route_unverified');
    e.receipt={schema:'wm.migration-receipt.v1',operationId:e.operationId,requestFingerprint:e.requestFingerprint,sourceRoute:e.sourceRoute,targetRoute:e.targetRoute,inventoryDigest:e.inventoryDigest,domainCounts:e.domainCounts,domainBytes:e.domainBytes,sourcePreserved:true,cutoverStatus:'committed',verified:true};reloadRequired=true;return save(e,'complete');
   }catch(err){return save(e,'uncertain',/^[a-z0-9_]+$/.test(err.message)?err.message:'cutover_status_required');}
  });
  const resume=operationId=>serial(async()=>{const e=await readJson(RECEIPT);if(!e||e.operationId!==operationId)fail('migration_missing');await stop();if(e.switchIntent)return save(e,'cutover_prepared','cutover_status_required');if(!await sourceCurrent(e))return save(e,'conflict','manual_source_changed');
   const fresh=await capture();if(fresh.sourceFingerprint!==e.sourceFingerprint||fresh.inventoryDigest!==e.inventoryDigest)return save(e,'conflict','manual_source_changed');
   for(const row of fresh.records){const k='WMManual::snapshot::'+e.operationId+'::'+row.descriptor.id,old=await local.getItem(k,{strict:true});if(old!=null&&old!==row.raw)fail('manual_snapshot_conflict');if(old==null&&await local.setItem(k,row.raw,{strict:true})===false)fail('manual_snapshot_unverified');await checkRecord(row.descriptor,await local.getItem(k,{strict:true}));}
   if(e.targetRoute.mode==='server_only'){if(!same((await serverStatus()).identity,e.target.identity))fail('manual_server_identity_changed');await connection.requestManual('begin',{generation:e.generation,expected:{activeId:e.target.activeId,revision:e.target.revision},records:e.records,inventoryDigest:e.inventoryDigest});}
   else if(!await readJson(catalogKey(e.generation)))await writeJson(catalogKey(e.generation),{profile:PROFILE,generation:e.generation,revision:'staging',records:e.records,state:'copying'});
   e.index=0;e.offset=0;e.copiedBytes=0;return save(e,'copying');});
  const cancel=operationId=>serial(async()=>{const e=await readJson(RECEIPT);if(!e||e.operationId!==operationId)fail('migration_missing');if(e.switchIntent&&!same(await readRoute(),e.originalRoute))return publicState(e);reloadRequired=true;return save(e,'conflict','manual_cancelled_reload_required');});
  return Object.freeze({profile:PROFILE,wrap,inspect,prepare,copyNext,verify,cutover,resume,cancel,
   routeView:async()=>routeView(await readRoute()),readState:async id=>{const e=await readJson(RECEIPT);return e&&(!id||id===e.operationId)?publicState(e):null;},
   isPaused:()=>paused||reloadRequired,needsReload:()=>reloadRequired,isRouted:()=>loadedRoute.generation!==null,
   admission:async()=>{try{await admission();return {ok:true};}catch(e){return {ok:false,reason:e.message};}},
   qualification:()=>({profile:PROFILE,supported:true,allWritersFenced:false,durableRouteCAS:false,restartSafe:false,nativeAtomic:false,sourcePreserved:true}),
   async isTombstone(space,key){if(loadedRoute.generation===null)return false;const id=await hash(space+'\n'+key);if(loadedRoute.mode==='server_only'){const v=await connection.requestManual('lookup',{generation:loadedRoute.generation,id});return v.record?.tombstone===true;}return (await catalog(loadedRoute.generation)).records.find(d=>d.id===id)?.tombstone===true;}
  });
 }
 return Object.freeze({PROFILE,createWmManualStorage});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WmManualStorage;
