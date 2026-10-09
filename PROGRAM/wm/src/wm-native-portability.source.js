/* Native portability adapter. This is product-owned byte materialization, not a host
 * implementation or qualification. The injected owner owns cross-executor exclusion,
 * native scope binding, route CAS and restore admission. No production owner is supplied. */
const WmNativePortability = (() => {
  'use strict';
  const C = typeof WmStorageContracts !== 'undefined' ? WmStorageContracts : require('./wm-storage-contracts.source.js');
  const I = typeof WmStorageInventory !== 'undefined' ? WmStorageInventory : require('./wm-storage-inventory.source.js');
  const adapters = new WeakSet(), utf8 = value => new TextEncoder().encode(value);
  const stable = I.canonicalJson, clone = value => JSON.parse(stable(value)), same = (a,b) => stable(a) === stable(b);
  const fail = reason => ({ok:false,reason}), reject = reason => { throw Object.assign(Error(reason), {portabilityReason:reason}); };
  const token = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const plain = value => {try { return C.validateOperationStatus({status:'uncertain',operationId:'data',requestFingerprint:'0'.repeat(64),receipt:value}).reason !== 'non_plain_data'; } catch { return false; }};
  const exact = (value, required, optional=[]) => plain(value) && value && typeof value === 'object' && !Array.isArray(value)
    && required.every(k=>Object.hasOwn(value,k)) && Object.keys(value).every(k=>required.includes(k)||optional.includes(k));
  const frame = (value,required,optional=[],opaque=[]) => {if(!value||typeof value!=='object'||Array.isArray(value))return null;const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);if(!required.every(k=>Object.hasOwn(ds,k))||keys.some(k=>typeof k!=='string'||!ds[k].enumerable||!Object.hasOwn(ds[k],'value')||!required.includes(k)&&!optional.includes(k)))return null;const data=Object.fromEntries(keys.map(k=>[k,opaque.includes(k)?null:ds[k].value]));return exact(data,required,optional)?Object.fromEntries(keys.map(k=>[k,ds[k].value])):null;};
  const add = (a,b) => {if(!count(a)||!count(b)||a>Number.MAX_SAFE_INTEGER-b)reject('native_byte_total_overflow');return a+b;};
  const zeros = () => Object.fromEntries(C.DOMAINS.map(d=>[d,0]));
  const identityKeys = ['authorityId','storeId','datasetId','backendId'];
  const limitKeys = ['maxChunkBytes','maxPageItems','maxPageBytes','maxItems','maxTotalBytes','maxItemBytes'];
  const CORE_METHODS = Object.freeze(['describePortability','runExclusive','verifyOwnership','inspectDestination','beginInstallation',
    'writeItemChunk','readItemChunk','sealInstallation','readInstallation','reopenScope','readRoute','verifyMigrationDecision','reconcileRoute']);
  const RESTORE_METHODS = Object.freeze(['inspectRestore','verifyRestoreConfirmation','fenceRestore','readRetainedRestoreSource','finishRestore']);
  const encode = bytes => {let text='';for(let n=0;n<bytes.length;n+=8192)text+=String.fromCharCode(...bytes.subarray(n,n+8192));return btoa(text);};
  const decode = text => {if(typeof text!=='string')reject('native_chunk_corrupt');let raw;try{raw=atob(text);}catch{reject('native_chunk_corrupt');}const b=Uint8Array.from(raw,c=>c.charCodeAt(0));if(encode(b)!==text)reject('native_chunk_corrupt');return b;};
  const snapshotValid = s => exact(s,C.DTO_KEYS.InventorySnapshot) && token(s.snapshotId) && token(s.routeGeneration) && digest(s.inventoryDigest)
    && s.complete===true && C.validateDomainTotals(s.domainCounts).ok && C.validateDomainTotals(s.domainBytes).ok;
  const identityValid = id => exact(id,identityKeys) && identityKeys.every(k=>token(id[k]));
  const scopeSet = rows => [...new Set(rows.map(r=>r.descriptor.originScope))].sort();

  function createWmNativePortability({storage=null,owner=null,inventory=null,clock=Date.now}={}) {
    function inspect({restore=false,capture=false}={}) {
      const missing=CORE_METHODS.filter(name=>typeof owner?.[name]!=='function');
      if(restore)missing.push(...RESTORE_METHODS.filter(name=>typeof owner?.[name]!=='function'));
      if(!storage || ['getItem','setItem','describePortabilityStorage'].some(k=>typeof storage[k]!=='function'))missing.push('isolatedDurableStorage');
      if(capture && (!inventory || ['open','page','readChunk','verify','close'].some(k=>typeof inventory[k]!=='function')))missing.push('sourceInventory');
      if(missing.length)return {ok:false,reason:'native_owner_facilities_missing',missing,actualHostQualified:false};
      try {
        const d=owner.describePortability(),store=storage.describePortabilityStorage();
        if(!exact(d,['schema','identity','limits'])||d.schema!=='wm.native-owner.v1'||!identityValid(d.identity)
          ||!exact(d.limits,limitKeys)||limitKeys.some(k=>!Number.isSafeInteger(d.limits[k])||d.limits[k]<1))return fail('native_owner_contract_invalid');
        if(!exact(store,['schema','namespace','isolatedFromMemoryInventory'])||store.schema!=='wm.native-portability-store.v1'
          ||!token(store.namespace)||store.isolatedFromMemoryInventory!==true)return fail('native_staging_storage_not_isolated');
        return {ok:true,schema:'wm.native-portability-adapter.v1',identity:clone(d.identity),limits:{...clone(d.limits),
          maxChunkBytes:Math.min(C.DEFAULT_CHUNK_BYTES,d.limits.maxChunkBytes),maxPageItems:Math.min(C.DEFAULT_PAGE_ITEMS,d.limits.maxPageItems)},actualHostQualified:false};
      } catch {return fail('native_owner_contract_unavailable');}
    }
    const key = async (family,id) => 'wm.native-portability.v1:'+family+':'+await C.hashBytes(utf8(id));
    async function read(k){const raw=await storage.getItem(k,{strict:true});if(raw===null)return null;if(typeof raw!=='string')reject('native_store_corrupt');let v;try{v=JSON.parse(raw);}catch{reject('native_store_corrupt');}if(!plain(v))reject('native_store_corrupt');return v;}
    async function write(k,value,{immutable=false}={}){const raw=stable(value),before=await storage.getItem(k,{strict:true});if(immutable&&before!==null&&before!==raw)reject('native_immutable_conflict');if(before!==raw)await storage.setItem(k,raw,{strict:true});if(await storage.getItem(k,{strict:true})!==raw)reject('native_store_readback_unconfirmed');}
    async function ownership(handle,input){if(await owner.verifyOwnership({handle,...input?{input:clone(input)}:{}})!==true)reject('native_owner_exclusion_unconfirmed');}
    async function exclusive(input,body,features={}) {
      const cap=inspect(features);if(!cap.ok)return cap;
      if(!plain(input)||!token(input.operationId)||!digest(input.requestFingerprint))return fail('native_operation_identity_invalid');
      try {
        let entered=false,completed=false,value;
        await owner.runExclusive(clone(input),async handle=>{if(entered)reject('native_owner_callback_repeated');entered=true;
          await ownership(handle,input);const result=await body(handle,cap);await ownership(handle,input);value=result;completed=true;return result;});
        if(!completed)reject('native_owner_callback_missing');return value;
      } catch(error) {return {ok:false,reason:error.portabilityReason||'native_owner_operation_uncertain',uncertain:true};}
    }
    async function stage(input){const s=await read(await key('stage',input.operationId));if(!s||s.schema!=='wm.native-stage.v1')reject('native_stage_missing');
      if(s.input.requestFingerprint!==input.requestFingerprint)reject('native_operation_identity_conflict');
      if(!Array.isArray(s.items)||new Set(s.items.map(r=>r.descriptor?.logicalId)).size!==s.items.length)reject('native_stage_corrupt');return s;}
    const saveStage = s => writeStage(s);
    async function writeStage(s){await write(await key('stage',s.input.operationId),s);}
    async function validateStageInput(v,cap){
      if(!exact(v,['operationId','requestFingerprint','sourceRoute','targetRoute','snapshot'])||!token(v.operationId)||!digest(v.requestFingerprint)
        ||!C.validateRoute(v.sourceRoute).ok||!C.validateRoute(v.targetRoute).ok||v.targetRoute.mode!=='plugin_only'||!snapshotValid(v.snapshot)
        ||v.snapshot.routeGeneration!==v.sourceRoute.routeGeneration||v.targetRoute.backendId!==cap.identity.backendId||v.targetRoute.datasetId!==cap.identity.datasetId
        ||await C.fingerprintRequest(v)!==v.requestFingerprint)reject('native_stage_input_invalid');
      const size=C.DOMAINS.reduce((n,d)=>add(n,v.snapshot.domainBytes[d]),0),items=C.DOMAINS.reduce((n,d)=>add(n,v.snapshot.domainCounts[d]),0);
      if(size>cap.limits.maxTotalBytes||items>cap.limits.maxItems)reject('native_stage_capacity');
    }
    async function begin(v,handle,cap,{backup=false,restorePlan=null}={}){
      await validateStageInput(v,cap);const existing=await read(await key('stage',v.operationId));
      if(existing){if(!same(existing.input,v))reject('native_operation_identity_conflict');return {ok:true,copiedBytes:existing.copiedBytes};}
      if(!backup){const destination=await owner.inspectDestination({handle,input:clone(v),restorePlan});
        if(destination?.ok!==true||destination.backendId!==cap.identity.backendId||destination.datasetId!==cap.identity.datasetId)reject('native_destination_unconfirmed');
        if(destination.targetHasExistingData!==false&&!restorePlan)reject('native_destination_existing_data');
        if(!count(destination.availableBytes)||destination.availableBytes<C.DOMAINS.reduce((n,d)=>add(n,v.snapshot.domainBytes[d]),0))reject('native_destination_capacity');}
      await saveStage({schema:'wm.native-stage.v1',input:clone(v),kind:backup?'backup':restorePlan?'restore':'migration',restorePlanId:restorePlan?.planId||null,state:'copying',items:[],copiedBytes:0,installation:null});return {ok:true,copiedBytes:0};
    }
    async function putChunk(s,v,cap){
      const d=v.descriptor;if(!I.validateInventoryItem(d).ok||d.bytes>cap.limits.maxItemBytes||!count(v.offset)
        ||!(v.bytes instanceof Uint8Array)||v.bytes.length>cap.limits.maxChunkBytes||v.offset+v.bytes.length>d.bytes||(!v.bytes.length&&d.bytes!==0))reject('native_chunk_invalid');
      const bytes=new Uint8Array(v.bytes),sha256=await C.hashBytes(bytes);let row=s.items.find(r=>r.descriptor.logicalId===d.logicalId);
      if(row&&!same(row.descriptor,d))reject('native_descriptor_conflict');
      if(row&&v.offset<row.offset || row&&d.bytes===0&&row.chunks.length){const old=row.chunks.find(c=>c.offset===v.offset);if(!old||old.bytes!==bytes.length||old.sha256!==sha256)reject('native_chunk_conflict');return {ok:true,copiedBytes:s.copiedBytes,offset:row.offset,complete:row.offset===d.bytes};}
      if(s.state!=='copying'||v.offset!==(row?.offset||0))reject('native_chunk_offset_conflict');
      if(!row){if(s.items.length>=cap.limits.maxItems)reject('native_stage_capacity');row={descriptor:clone(d),offset:0,chunks:[]};s.items.push(row);}
      const total=add(s.copiedBytes,bytes.length);if(total>cap.limits.maxTotalBytes)reject('native_stage_capacity');
      const k=await key('chunk',s.input.operationId+'\n'+d.logicalId+'\n'+v.offset);
      await write(k,{encoding:'base64',data:encode(bytes),offset:v.offset,bytes:bytes.length,sha256},{immutable:true});
      row.chunks.push({key:k,offset:v.offset,bytes:bytes.length,sha256});row.offset=add(row.offset,bytes.length);s.copiedBytes=total;await saveStage(s);
      return {ok:true,copiedBytes:total,offset:row.offset,complete:row.offset===d.bytes};
    }
    async function storedChunk(chunk,cap){const r=await read(chunk.key);if(!exact(r,['encoding','data','offset','bytes','sha256'])||r.encoding!=='base64'||r.data.length>Math.ceil(cap.limits.maxChunkBytes/3)*4)reject('native_chunk_corrupt');
      const b=decode(r.data);if(r.offset!==chunk.offset||b.length!==chunk.bytes||b.length!==r.bytes||r.sha256!==chunk.sha256||await C.hashBytes(b)!==chunk.sha256)reject('native_chunk_corrupt');return b;}
    async function verifyRows(s,cap,readBytes){
      if(s.items.length>cap.limits.maxItems)reject('native_stage_capacity');const ids=new Map(),counts=zeros(),bytes=zeros(),allHash=I.createSha256Stream();allHash.update(utf8('wm.inventory-snapshot.v1\n'));
      for(const row of s.items){const d=row.descriptor;if(!I.validateInventoryItem(d).ok||ids.has(d.logicalId)||d.bytes>cap.limits.maxItemBytes||row.offset!==d.bytes)reject('native_item_incomplete');ids.set(d.logicalId,d);
        const hash=I.createSha256Stream();let offset=0;for(const chunk of row.chunks){if(chunk.offset!==offset||!count(chunk.bytes)||chunk.bytes>cap.limits.maxChunkBytes)reject('native_chunk_sequence_invalid');const b=await readBytes(row,chunk);if(!(b instanceof Uint8Array)||b.length!==chunk.bytes)reject('native_payload_readback_invalid');hash.update(b);offset=add(offset,b.length);}
        if(offset!==d.bytes||hash.hex()!==d.sha256)reject('native_payload_integrity');counts[d.domain]=add(counts[d.domain],1);bytes[d.domain]=add(bytes[d.domain],d.bytes);allHash.update(utf8(stable(d)+'\n'));}
      const visiting=new Set(),done=new Set();for(const id of ids.keys()){const stack=[[id,false]];while(stack.length){const [next,exit]=stack.pop();if(exit){visiting.delete(next);done.add(next);continue;}if(visiting.has(next))reject('native_dependency_cycle');if(done.has(next))continue;const d=ids.get(next);if(!d)reject('native_dependency_missing');visiting.add(next);stack.push([next,true]);for(const dep of d.dependencies)stack.push([dep,false]);}}
      if(allHash.hex()!==s.input.snapshot.inventoryDigest||!same(counts,s.input.snapshot.domainCounts)||!same(bytes,s.input.snapshot.domainBytes))reject('native_inventory_mismatch');
      if(C.DOMAINS.reduce((n,d)=>add(n,bytes[d]),0)!==s.copiedBytes)reject('native_byte_total_mismatch');return {ok:true,inventoryDigest:s.input.snapshot.inventoryDigest,domainCounts:counts,domainBytes:bytes};
    }
    const verifyStage = (s,cap) => verifyRows(s,cap,(row,chunk)=>storedChunk(chunk,cap));
    async function readback(s,handle,cap,active=false){
      if(!s.installation)reject('native_installation_missing');const input={stage:clone(s.input),installation:clone(s.installation),active};
      const actual=await owner.readInstallation({handle,...input});const descriptors=s.items.map(r=>r.descriptor);
      if(!exact(actual,['ok','installationId','items','route','writerEpoch'])||actual.ok!==true||actual.installationId!==s.installation.installationId||actual.writerEpoch!==s.installation.writerEpoch
        ||!same(actual.items,descriptors)||!same(actual.route,active?s.input.targetRoute:s.installation.route))reject('native_installation_readback_mismatch');
      const result=await verifyRows(s,cap,async(row,chunk)=>{const r=await owner.readItemChunk({handle,...input,descriptor:clone(row.descriptor),offset:chunk.offset,maxBytes:chunk.bytes});
        if(r?.ok!==true||r.offset!==chunk.offset||r.totalBytes!==row.descriptor.bytes||r.sha256!==row.descriptor.sha256)return null;return r.bytes;});
      // Reopen every discovered scope through the owner's real native consumer path.
      // Logical descriptor readback alone never counts as reopen proof.
      for(const scope of scopeSet(s.items)){const canonical=s.items.find(r=>r.descriptor.domain==='canonical'&&r.descriptor.originScope===scope)?.descriptor||null;
        const reopened=await owner.reopenScope({handle,...input,scope});if(reopened?.ok!==true||reopened.scope!==scope||reopened.installationId!==s.installation.installationId)reject('native_scope_reopen_unconfirmed');
        if(!canonical){if(reopened.raw!==null||reopened.canonicalPresent!==false)reject('native_empty_scope_reopen_mismatch');}
        else {const raw=canonical.disposition.tombstone?null:reopened.raw;if(reopened.canonicalPresent!==true||reopened.raw!==raw||!(raw===null||typeof raw==='string')
          ||await C.hashBytes(utf8(raw??''))!==canonical.sha256||utf8(raw??'').length!==canonical.bytes)reject('native_scope_reopen_mismatch');}}
      return {...result,sealedInventoryDigest:await C.fingerprintRequest({installation:s.installation,inventoryDigest:result.inventoryDigest}),route:clone(actual.route),scopesReopened:scopeSet(s.items).length};
    }
    async function materialize(s,handle,cap,restorePlan=null){
      await verifyStage(s,cap);if(s.kind==='backup')reject('native_backup_not_installable');
      if(!s.installation){const initialized=await owner.beginInstallation({handle,input:clone(s.input),restorePlan});
        if(initialized?.ok!==true)reject('native_installation_not_prepared');
        for(const row of s.items)for(const chunk of row.chunks){await ownership(handle);const bytes=await storedChunk(chunk,cap);
          const written=await owner.writeItemChunk({handle,input:clone(s.input),descriptor:clone(row.descriptor),offset:chunk.offset,bytes});if(written?.ok!==true)reject('native_installation_write_unconfirmed');}
        const installation=await owner.sealInstallation({handle,input:clone(s.input),items:clone(s.items.map(r=>r.descriptor)),restorePlan});
        if(!exact(installation,['ok','installationId','route','writerEpoch'])||installation.ok!==true||!token(installation.installationId)||!token(installation.writerEpoch)
          ||!same(installation.route,{...s.input.targetRoute,state:s.kind==='restore'?'recovery_required':'fenced'}))reject('native_installation_seal_invalid');
        s.installation=clone(installation);s.state='materialized';await saveStage(s);}
      return readback(s,handle,cap,false);
    }
    async function migration(method,value={}) {
      const cap=inspect();if(!cap.ok)return cap;
      if(method==='migrationLimits')return clone(cap.limits);
      if(method==='inspectMigrationDestination'){try{const d=await owner.inspectDestination({handle:null,input:null,restorePlan:null});return d?.ok===true?{...clone(d),activationEnabled:false,ownerIntegrationAvailable:true}:fail('native_destination_unconfirmed');}catch{return fail('native_destination_unavailable');}}
      const methods=['beginMigrationStage','stageMigrationChunk','migrationStageStatus','verifyMigrationStage','materializeMigrationStage','verifyMigrationReadback'];if(!methods.includes(method))return fail('native_migration_method_unsupported');
      value=method==='stageMigrationChunk'?frame(value,['operationId','requestFingerprint','descriptor','offset','bytes'],[],['bytes']):frame(value,['operationId','requestFingerprint'],['sourceRoute','targetRoute','snapshot','logicalId','active']);
      if(!value)return fail('native_input_invalid');
      const rawBytes=method==='stageMigrationChunk'?value.bytes:null, v={...value};if(method==='stageMigrationChunk')delete v.bytes;
      return exclusive({operationId:v.operationId,requestFingerprint:v.requestFingerprint,purpose:'migration'},async(handle,limits)=>{
        if(method==='beginMigrationStage')return begin(v,handle,limits);
        const s=await stage(v);if(s.kind!=='migration')reject('native_stage_kind_mismatch');for(const k of ['sourceRoute','targetRoute','snapshot'])if(Object.hasOwn(v,k)&&!same(v[k],s.input[k]))reject('native_stage_context_mismatch');
        if(method==='stageMigrationChunk')return putChunk(s,{...v,bytes:rawBytes},limits);
        if(method==='migrationStageStatus'){const row=s.items.find(r=>r.descriptor.logicalId===v.logicalId);return {ok:true,state:s.state,copiedBytes:s.copiedBytes,offset:row?.offset||0,complete:!!row&&row.offset===row.descriptor.bytes};}
        if(method==='verifyMigrationStage')return verifyStage(s,limits);
        if(method==='materializeMigrationStage')return materialize(s,handle,limits);
        return readback(s,handle,limits,v.active===true);
      });
    }
    async function reconcileMigration(v){
      if(!exact(v,['operationId','sourceRoute','targetRoute','status','receipt'])||!C.validateRoute(v.sourceRoute).ok||!C.validateRoute(v.targetRoute).ok
        ||!C.validateOperationStatus(v.status).ok||v.status.status!=='committed'||!exact(v.receipt,C.DTO_KEYS.MigrationReceipt)
        ||v.receipt.operationId!==v.operationId||!same(v.receipt.sourceRoute,v.sourceRoute)||!same(v.receipt.targetRoute,v.targetRoute)
        ||v.receipt.sourcePreserved!==true||v.receipt.verified!==true||v.receipt.cutoverStatus!=='committed'||!digest(v.receipt.inventoryDigest)||!C.validateDomainTotals(v.receipt.domainCounts).ok||!C.validateDomainTotals(v.receipt.domainBytes).ok) return fail('native_route_receipt_invalid');
      const intent={operationId:v.operationId,sourceRoute:v.sourceRoute,targetRoute:v.targetRoute,inventoryDigest:v.receipt.inventoryDigest,domainCounts:v.receipt.domainCounts,domainBytes:v.receipt.domainBytes,sourcePreserved:true};
      if(await C.fingerprintRequest(intent)!==v.receipt.requestFingerprint)return fail('native_route_fingerprint_invalid');
      return exclusive({operationId:v.operationId,requestFingerprint:v.receipt.requestFingerprint,purpose:'route-reconciliation'},async(handle,cap)=>{
        if(await owner.verifyMigrationDecision({handle,input:clone(v)})!==true)reject('native_route_decision_unverified');
        if(v.targetRoute.mode==='plugin_only'){const s=await read(await key('stage',v.operationId+':stage'));if(!s||!same(s.input.sourceRoute,v.sourceRoute)||!same(s.input.targetRoute,v.targetRoute)
          ||s.input.snapshot.inventoryDigest!==v.receipt.inventoryDigest)reject('native_route_stage_mismatch');await readback(s,handle,cap,false);}
        const observed=await owner.readRoute();if(!same(observed,v.sourceRoute)&&!same(observed,v.targetRoute))reject('native_route_changed');
        if(!same(observed,v.targetRoute)){const result=await owner.reconcileRoute({handle,input:clone(v)});if(result?.ok!==true)reject('native_route_reconciliation_unconfirmed');}
        if(!same(await owner.readRoute(),v.targetRoute))reject('native_route_readback_unconfirmed');
        await write(await key('decision',v.operationId),{schema:'wm.native-route-evidence.v1',input:clone(v),executionAuthority:false},{immutable:true});return {ok:true};
      });
    }
    const componentFields=['schema','backupId','sourceIdentity','sourceRoute','snapshot','items','componentDigest'];
    async function validateComponent(component,cap){if(!exact(component,componentFields)||component.schema!=='wm.native-backup-component.v1'||!token(component.backupId)
      ||!identityValid(component.sourceIdentity)||!C.validateRoute(component.sourceRoute).ok||component.sourceRoute.mode!=='plugin_only'||!snapshotValid(component.snapshot)
      ||!Array.isArray(component.items)||component.items.length>cap.limits.maxItems||component.items.some(d=>!I.validateInventoryItem(d).ok)||!digest(component.componentDigest))reject('native_backup_component_invalid');
      const body=clone(component);delete body.componentDigest;if(await C.fingerprintRequest(body)!==component.componentDigest)reject('native_backup_component_digest_mismatch');}
    async function backupRecord(backupId,cap){const b=await read(await key('backup',backupId));if(!b)reject('native_backup_missing');await validateComponent(b.component,cap);const s=await stage(b.stage);if(!same(s.items.map(r=>r.descriptor),b.component.items)||!same(s.input.snapshot,b.component.snapshot))reject('native_backup_manifest_mismatch');await verifyStage(s,cap);return {b,s};}
    async function captureBackup(v){
      if(!exact(v,['backupId','sourceRoute'])||!token(v.backupId)||!C.validateRoute(v.sourceRoute).ok||v.sourceRoute.mode!=='plugin_only')return fail('native_backup_input_invalid');
      const id='backup-'+await C.hashBytes(utf8(v.backupId)),operation={operationId:id,requestFingerprint:await C.fingerprintRequest(v),purpose:'backup-capture'};
      return exclusive(operation,async(handle,cap)=>{
        const old=await read(await key('backup',v.backupId));if(old){const verified=await backupRecord(v.backupId,cap);if(!same(old.component.sourceRoute,v.sourceRoute))reject('native_backup_identity_conflict');return {ok:true,component:clone(verified.b.component)};}
        if(!same(await owner.readRoute(),v.sourceRoute))reject('native_backup_source_route_changed');
        const snap=await inventory.open({fence:{routeGeneration:v.sourceRoute.routeGeneration}});if(!snapshotValid(snap))reject('native_backup_inventory_incomplete');
        try {const input={operationId:id,sourceRoute:clone(v.sourceRoute),targetRoute:{...v.sourceRoute,backendId:cap.identity.backendId,datasetId:cap.identity.datasetId},snapshot:clone(snap)};input.requestFingerprint=await C.fingerprintRequest(input);
          const existing=await read(await key('stage',id));if(existing && existing.input.snapshot.inventoryDigest!==snap.inventoryDigest)reject('native_backup_source_changed');
          const used=existing?.input||input;await begin(used,handle,cap,{backup:true});const s=await stage(used);let cursor=null;const cursors=new Set();
          do {const page=await inventory.page({snapshotId:snap.snapshotId,cursor,maxItems:cap.limits.maxPageItems,maxBytes:cap.limits.maxPageBytes});if(page.complete!==true||page.errors?.length||!Array.isArray(page.items))reject('native_backup_inventory_incomplete');
            for(const d of page.items){let row=s.items.find(r=>r.descriptor.logicalId===d.logicalId);if(row&&!same(row.descriptor,d))reject('native_backup_source_changed');let offset=row?.offset||0;
              if(row&&offset===d.bytes)continue;
              do {const chunk=await inventory.readChunk({snapshotId:snap.snapshotId,logicalId:d.logicalId,offset,maxBytes:cap.limits.maxChunkBytes});if(chunk.offset!==offset||chunk.totalBytes!==d.bytes||chunk.sha256!==d.sha256)reject('native_backup_source_chunk_invalid');await putChunk(s,{descriptor:d,offset,bytes:chunk.bytes},cap);offset+=chunk.bytes.length;}while(offset<d.bytes);}
            cursor=page.nextCursor;if(cursor!==null){if(typeof cursor!=='string'||cursors.has(cursor))reject('native_inventory_cursor_invalid');cursors.add(cursor);}
          }while(cursor!==null);
          const fresh=await inventory.verify(snap.snapshotId);if(fresh.complete!==true||fresh.inventoryDigest!==snap.inventoryDigest||!same(await owner.readRoute(),v.sourceRoute))reject('native_backup_source_changed');
          await verifyStage(s,cap);s.state='sealed';await saveStage(s);
          const component={schema:'wm.native-backup-component.v1',backupId:v.backupId,sourceIdentity:cap.identity,sourceRoute:clone(v.sourceRoute),snapshot:clone(s.input.snapshot),items:clone(s.items.map(r=>r.descriptor))};component.componentDigest=await C.fingerprintRequest(component);
          await write(await key('backup',v.backupId),{component,stage:{operationId:s.input.operationId,requestFingerprint:s.input.requestFingerprint}},{immutable:true});return {ok:true,component};
        }finally{await inventory.close(snap.snapshotId);}
      },{capture:true});
    }
    async function prepareRestore(v){
      if(!exact(v,['operationId','backupId','expiresAt'])||!token(v.operationId)||!token(v.backupId)||typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt))||Date.parse(v.expiresAt)<=clock())return fail('native_restore_input_invalid');
      const requestFingerprint=await C.fingerprintRequest(v);
      return exclusive({operationId:v.operationId,requestFingerprint,purpose:'restore-prepare'},async(handle,cap)=>{
        const existing=await read(await key('restore-plan',v.operationId));if(existing){if(existing.requestFingerprint!==requestFingerprint)reject('native_restore_identity_conflict');return {ok:true,plan:clone(existing.plan)};}
        const {b}=await backupRecord(v.backupId,cap);if(!same(b.component.sourceIdentity,cap.identity))reject('native_cross_physical_restore_unsupported');
        const current=await owner.inspectRestore({handle});if(current?.ok!==true||!digest(current.fingerprint)||!C.validateRoute(current.route).ok||current.route.mode!=='plugin_only'
          ||!token(current.writerEpoch)||!token(current.incarnation)||!same(current.identity,cap.identity))reject('native_restore_state_unconfirmed');
        const plan={planId:'native-restore-'+await C.hashBytes(utf8(v.operationId)),operationId:v.operationId,backupId:v.backupId,expectedStoreIdentity:clone(cap.identity),expectedCurrentFingerprint:current.fingerprint,
          expiresAt:v.expiresAt,requiredBytes:C.DOMAINS.reduce((n,d)=>add(n,b.component.snapshot.domainBytes[d]),0),verifiedInventoryDigest:b.component.snapshot.inventoryDigest};
        await write(await key('restore-plan',v.operationId),{schema:'wm.native-restore-plan.v1',requestFingerprint,plan,componentDigest:b.component.componentDigest,previous:clone(current),state:'prepared',receipt:null},{immutable:true});return {ok:true,plan};
      },{restore:true});
    }
    async function applyRestore(v){
      v=frame(v,['operationId','planId','confirmation'],[],['confirmation']);if(!v||!token(v.operationId)||typeof v.planId!=='string')return fail('native_restore_input_invalid');
      const cap=inspect({restore:true});if(!cap.ok)return cap;let planRecord;try{planRecord=await read(await key('restore-plan',v.operationId));}catch{return fail('native_restore_plan_unavailable');}
      if(!planRecord||planRecord.plan.planId!==v.planId)return fail('native_restore_plan_missing');
      return exclusive({operationId:v.operationId,requestFingerprint:planRecord.requestFingerprint,purpose:'restore-apply'},async(handle,limits)=>{
        const record=await read(await key('restore-plan',v.operationId)),plan=record.plan;
        if(record.state==='complete')return {ok:true,receipt:clone(record.receipt)};
        if(Date.parse(plan.expiresAt)<=clock())reject('native_restore_plan_expired');
        if(await owner.verifyRestoreConfirmation({handle,plan:clone(plan),confirmation:v.confirmation})!==true)reject('native_restore_confirmation_required');
        const {b,s:backupStage}=await backupRecord(plan.backupId,limits);if(b.component.componentDigest!==record.componentDigest||!same(plan.expectedStoreIdentity,limits.identity))reject('native_restore_backup_changed');
        if(record.state==='prepared'){const current=await owner.inspectRestore({handle});if(current?.fingerprint!==plan.expectedCurrentFingerprint||!same(current.route,record.previous.route))reject('native_restore_target_changed');record.state='fencing';await write(await key('restore-plan',v.operationId),record);}
        // Owner must durably return the same lifecycle for a repeated operation.
        const targetRoute={...record.previous.route,routeGeneration:'restore-'+await C.hashBytes(utf8(v.operationId)),state:'recovery_required'};
        const fence=await owner.fenceRestore({handle,plan:clone(plan),targetRoute});
        if(fence?.ok!==true||!same(fence.route,targetRoute)||!token(fence.writerEpoch)||!token(fence.incarnation)||fence.writerEpoch===record.previous.writerEpoch||fence.incarnation===record.previous.incarnation)reject('native_restore_fresh_lifecycle_unconfirmed');
        if(record.lifecycle&&!same(record.lifecycle,fence))reject('native_restore_lifecycle_changed');record.lifecycle=clone(fence);record.state='installing';await write(await key('restore-plan',v.operationId),record);
        const input={operationId:v.operationId+':restore',sourceRoute:b.component.sourceRoute,targetRoute,snapshot:b.component.snapshot};input.requestFingerprint=await C.fingerprintRequest(input);
        await begin(input,handle,limits,{restorePlan:plan});const s=await stage(input);
        if(s.state==='copying')for(const row of backupStage.items)for(const chunk of row.chunks)await putChunk(s,{descriptor:row.descriptor,offset:chunk.offset,bytes:await storedChunk(chunk,limits)},limits);
        const readbackResult=await materialize(s,handle,limits,plan);if(s.installation.writerEpoch!==fence.writerEpoch)reject('native_restore_epoch_mismatch');
        const retained=await owner.readRetainedRestoreSource({handle,plan:clone(plan),lifecycle:clone(fence)});if(retained?.ok!==true||retained.fingerprint!==plan.expectedCurrentFingerprint)reject('native_restore_previous_store_unconfirmed');
        const finished=await owner.finishRestore({handle,plan:clone(plan),installation:clone(s.installation),lifecycle:clone(fence),readback:readbackResult});
        if(finished?.ok!==true||!same(await owner.readRoute(),targetRoute))reject('native_restore_recovery_admission_unconfirmed');
        record.receipt={schema:'wm.native-restore-receipt.v1',operationId:v.operationId,planId:plan.planId,backupId:plan.backupId,componentDigest:record.componentDigest,inventoryDigest:plan.verifiedInventoryDigest,
          route:targetRoute,writerEpoch:fence.writerEpoch,incarnation:fence.incarnation,sourcePreserved:true,previousStoreRetained:true,admission:'recovery_required',historicalExecutionAuthority:false,scopesReopened:readbackResult.scopesReopened};
        record.state='complete';await write(await key('restore-plan',v.operationId),record);return {ok:true,receipt:clone(record.receipt)};
      },{restore:true});
    }
    async function importBackup(method,v){
      v=method==='beginImport'?frame(v,['component']):method==='importChunk'?frame(v,['backupId','logicalId','offset','bytes'],[],['bytes']):frame(v,['backupId'],['logicalId']);
      if(!v)return fail('native_backup_import_input_invalid');const cap=inspect();if(!cap.ok)return cap;
      let component,reference;try{if(method==='beginImport'){await validateComponent(v.component,cap);component=clone(v.component);}else{if(!token(v.backupId))reject('native_backup_import_input_invalid');reference=await read(await key('backup-import',v.backupId));if(!reference)reject('native_backup_import_missing');component=reference.component;await validateComponent(component,cap);}}
      catch(error){return fail(error.portabilityReason||'native_backup_import_unavailable');}
      const operationId='backup-'+await C.hashBytes(utf8(component.backupId));
      return exclusive({operationId,requestFingerprint:component.componentDigest,purpose:'backup-import'},async(handle,limits)=>{
        const input={operationId,sourceRoute:component.sourceRoute,targetRoute:{...component.sourceRoute,backendId:limits.identity.backendId,datasetId:limits.identity.datasetId},snapshot:component.snapshot};input.requestFingerprint=await C.fingerprintRequest(input);
        if(method==='beginImport'){const old=await read(await key('backup',component.backupId));if(old&&old.component.componentDigest!==component.componentDigest)reject('native_backup_identity_conflict');
          await begin(input,handle,limits,{backup:true});await write(await key('backup-import',component.backupId),{component,stage:{operationId,requestFingerprint:input.requestFingerprint}},{immutable:true});return {ok:true,backupId:component.backupId};}
        const s=await stage(reference.stage);
        if(method==='importStatus'){const row=s.items.find(r=>r.descriptor.logicalId===v.logicalId);return {ok:true,state:s.state,copiedBytes:s.copiedBytes,offset:row?.offset||0,complete:!!row&&row.offset===row.descriptor.bytes};}
        if(method==='importChunk'){const descriptor=component.items.find(d=>d.logicalId===v.logicalId);if(!descriptor)reject('native_backup_import_item_unknown');
          const ordinal=s.items.findIndex(r=>r.descriptor.logicalId===v.logicalId);if(ordinal<0&&component.items[s.items.length]?.logicalId!==v.logicalId)reject('native_backup_import_order_invalid');
          return putChunk(s,{descriptor,offset:v.offset,bytes:v.bytes},limits);}
        if(!same(s.items.map(r=>r.descriptor),component.items))reject('native_backup_import_manifest_mismatch');await verifyStage(s,limits);s.state='sealed';await saveStage(s);
        await write(await key('backup',component.backupId),{component,stage:reference.stage},{immutable:true});return {ok:true,component:clone(component)};
      });
    }
    async function backup(method,v={}){
      if(['beginImport','importChunk','importStatus','sealImport'].includes(method))return importBackup(method,v);
      if(method==='capture')return captureBackup(v);if(method==='prepareRestore')return prepareRestore(v);if(method==='applyRestore')return applyRestore(v);
      const cap=inspect();if(!cap.ok)return cap;if(!plain(v)||!token(v.backupId))return fail('native_backup_input_invalid');
      try{const {b,s}=await backupRecord(v.backupId,cap);if(method==='verify')return {ok:true,coverage:{owner:'wm',mode:'plugin_only',domains:[...C.DOMAINS],complete:true},inventoryDigest:b.component.snapshot.inventoryDigest,component:clone(b.component)};
        if(method==='readChunk'){const row=s.items.find(r=>r.descriptor.logicalId===v.logicalId);if(!row||!count(v.offset)||!Number.isSafeInteger(v.maxBytes)||v.maxBytes<1||v.maxBytes>cap.limits.maxChunkBytes||v.offset>row.descriptor.bytes)reject('native_backup_chunk_input_invalid');
          const end=Math.min(row.descriptor.bytes,v.offset+v.maxBytes),out=new Uint8Array(end-v.offset);for(const chunk of row.chunks)if(chunk.offset<end&&chunk.offset+chunk.bytes>v.offset){const bytes=await storedChunk(chunk,cap),start=Math.max(chunk.offset,v.offset),stop=Math.min(chunk.offset+chunk.bytes,end);out.set(bytes.subarray(start-chunk.offset,stop-chunk.offset),start-v.offset);}
          return {ok:true,bytes:out,offset:v.offset,nextOffset:end===row.descriptor.bytes?null:end,totalBytes:row.descriptor.bytes,sha256:row.descriptor.sha256};}
        return fail('native_backup_method_unsupported');
      }catch(error){return fail(error.portabilityReason||'native_backup_unavailable');}
    }
    const adapter=Object.freeze({inspect,migration,reconcileMigration,backup,isForProvider:provider=>provider===owner||provider?.nativePortabilityOwner===owner,activationDefault:false,actualHostQualified:false});adapters.add(adapter);return adapter;
  }
  return Object.freeze({createWmNativePortability,isAdapter:value=>adapters.has(value),ownerSchema:'wm.native-owner.v1',requiredOwnerMethods:CORE_METHODS,requiredRestoreMethods:RESTORE_METHODS,qualifiedProductionProfiles:Object.freeze([])});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WmNativePortability;
