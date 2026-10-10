/* Trusted native capability admission. There are no qualified production profiles here.
 * A qualification resolver is executable integration code, never a wire DTO or UI flag.
 * Provider handles must enforce the fence in every executor, including older clients. */
const WmNativeHostGate = (() => {
  'use strict';
  const C = typeof WmStorageContracts !== 'undefined' ? WmStorageContracts : require('./wm-storage-contracts.source.js');
  const P = typeof WmNativePortability !== 'undefined' ? WmNativePortability : require('./wm-native-portability.source.js');
  const gates = new WeakSet();
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = reason => ({ok:false,reason});
  const token = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const plain = value => {
    try { return C.validateOperationStatus({status:'uncertain',operationId:'plain',requestFingerprint:'0'.repeat(64),receipt:value}).reason !== 'non_plain_data'; }
    catch { return false; }
  };
  const exact = (value, required, optional=[]) => plain(value) && value && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value,key)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
  const stable = value => Array.isArray(value) ? '['+value.map(stable).join(',')+']' : value && typeof value==='object' ? '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}' : JSON.stringify(value);
  const same = (left,right) => stable(left) === stable(right);
  const frame = (input, required, optional=[], opaque=[]) => {
    if (!input || typeof input!=='object' || Array.isArray(input)) return null;
    const properties=Object.getOwnPropertyDescriptors(input), names=Reflect.ownKeys(input);
    if (!required.every(key=>Object.hasOwn(properties,key)) || names.some(key=>typeof key!=='string' || !properties[key].enumerable || !Object.hasOwn(properties[key],'value') || !required.includes(key)&&!optional.includes(key))) return null;
    const value=Object.fromEntries(names.map(key=>[key,properties[key].value]));
    return exact(Object.fromEntries(names.map(key=>[key,opaque.includes(key)?null:properties[key].value])),required,optional)?value:null;
  };
  const validIdentity = value => exact(value,['scope','characterId','chatId','personaId','resetGeneration'])
    && ['scope','characterId','chatId','personaId'].every(key => typeof value[key] === 'string' && value[key].length > 0)
    && Number.isSafeInteger(value.resetGeneration) && value.resetGeneration >= 0
    && value.scope === `char:${value.characterId}|chat:${value.chatId}|persona:${value.personaId}`;
  const REQUIRED_METHODS = Object.freeze(['describeBuild','acquireFence','verifyFence','captureInventory','verifyMigrationReceipt','publishRoute','status',
    'markTargetPending','verifyPending','readTargetPending','verifyImportAuthorization','verifyTargetReceipt','releaseTarget','guard','fenceReceipt','verifyFenceReceipt']);
  const GUARANTEES = Object.freeze(['inventoryComplete','allWritersFenced','durableRouteCAS','restartSafe','pendingImportFence','operationalJournalExcluded']);
  const unsupported = reason => Object.freeze({supported:false,profileId:null,qualifiedBuildHash:null,inventoryComplete:false,
    allWritersFenced:false,durableRouteCAS:false,restartSafe:false,reason});

  function createWmNativeHostGate({provider=null,qualification=null,portability=null}={}) {
    const fences = new WeakMap(), pendingTokens = new WeakMap(), importTokens = new WeakMap();
    // Empty by default. A future real profile needs independent evidence and a trusted resolver.
    function inspect() {
      if (!provider) return unsupported('native_host_provider_missing');
      if (typeof qualification !== 'function') return unsupported('native_host_profile_unqualified');
      if (REQUIRED_METHODS.some(method => typeof provider[method] !== 'function')) return unsupported('native_host_methods_missing');
      if (!provider.hostCatalog || ['listScopes','readWmScope'].some(method => typeof provider.hostCatalog[method] !== 'function')) return unsupported('native_host_catalog_missing');
      try {
        const build=provider.describeBuild(), qualified=qualification(provider,build);
        if (!exact(build,['profileId','buildHash','incarnation']) || !(typeof build.profileId==='string' && /^[A-Za-z0-9:_.-]{1,128}$/.test(build.profileId)) || !digest(build.buildHash) || !token(build.incarnation)) return unsupported('native_host_build_unverified');
        if (!exact(qualified,['profileId','qualifiedBuildHash',...GUARANTEES]) || qualified.profileId!==build.profileId || qualified.qualifiedBuildHash!==build.buildHash
          || GUARANTEES.some(key => qualified[key] !== true)) return unsupported('native_host_guarantees_unqualified');
        return Object.freeze({supported:true,profileId:build.profileId,qualifiedBuildHash:build.buildHash,inventoryComplete:true,
          allWritersFenced:true,durableRouteCAS:true,restartSafe:true,reason:'qualified_provider'});
      } catch { return unsupported('native_host_qualification_unavailable'); }
    }
    const incarnation = () => provider.describeBuild().incarnation;
    async function verifyFence(fence) {
      const state=fences.get(fence); if (!state || state.closed) return fail('native_fence_invalid');
      if (!inspect().supported) return fail('native_host_unqualified');
      try {
        if (incarnation()!==state.incarnation) return fail('native_fence_incarnation_changed');
        const verified=await provider.verifyFence({handle:state.handle,operationId:state.operationId,requestFingerprint:state.requestFingerprint,expectedRoute:clone(state.expectedRoute)});
        return verified?.ok===true ? {ok:true,state} : fail('native_fence_unconfirmed');
      } catch { return fail('native_fence_unavailable'); }
    }
    async function acquireFence(input) {
      if (!exact(input,['operationId','expectedRoute']) || !token(input.operationId) || !C.validateRoute(input.expectedRoute).ok) return fail('native_fence_input_invalid');
      if (!inspect().supported) return fail('native_host_unqualified');
      const expectedRoute=clone(input.expectedRoute),requestFingerprint=await C.fingerprintRequest({operationId:input.operationId,expectedRoute});
      try {
        const buildIncarnation=incarnation(),handle=await provider.acquireFence({operationId:input.operationId,requestFingerprint,expectedRoute});
        if (!handle || typeof handle !== 'object' || handle.ok===false) return fail('native_fence_not_acquired');
        const fence=Object.freeze({});fences.set(fence,{handle,operationId:input.operationId,requestFingerprint,expectedRoute,incarnation:buildIncarnation,closed:false,snapshot:null});
        const verified=await verifyFence(fence);if (!verified.ok) {fences.get(fence).closed=true;return verified;}return fence;
      } catch { return {...fail('native_fence_uncertain'),uncertain:true,operationId:input.operationId,requestFingerprint}; }
    }
    async function captureInventory(fence) {
      const before=await verifyFence(fence);if (!before.ok) return before;
      try {
        const snapshot=await provider.captureInventory({handle:before.state.handle,expectedRoute:clone(before.state.expectedRoute)});
        if (!exact(snapshot,C.DTO_KEYS.InventorySnapshot) || !token(snapshot.snapshotId) || snapshot.routeGeneration!==before.state.expectedRoute.routeGeneration
          || !digest(snapshot.inventoryDigest) || snapshot.complete!==true
          || ['domainCounts','domainBytes'].some(key => !exact(snapshot[key],C.DOMAINS) || C.DOMAINS.some(domain => !Number.isSafeInteger(snapshot[key][domain]) || snapshot[key][domain]<0))) return fail('native_inventory_incomplete');
        const after=await verifyFence(fence);if (!after.ok) return after;
        after.state.snapshot=clone(snapshot);return clone(snapshot);
      } catch { return fail('native_inventory_unavailable'); }
    }
    const uncertain = (operationId,requestFingerprint) => ({status:'uncertain',operationId,requestFingerprint});
    async function status(input) {
      if (!exact(input,['operationId','requestFingerprint']) || !token(input.operationId) || !digest(input.requestFingerprint)) return fail('native_status_input_invalid');
      if (!inspect().supported) return uncertain(input.operationId,input.requestFingerprint);
      try {
        const result=await provider.status(clone(input));
        if (!C.validateOperationStatus(result).ok || result.operationId!==input.operationId || result.requestFingerprint!==input.requestFingerprint) return uncertain(input.operationId,input.requestFingerprint);
        if (result.status==='not_applied' && (typeof provider.verifyNotApplied!=='function' || await provider.verifyNotApplied({status:clone(result)})!==true)) return uncertain(input.operationId,input.requestFingerprint);
        return clone(result);
      } catch { return uncertain(input.operationId,input.requestFingerprint); }
    }
    async function publishRoute(input) {
      // The opaque fence is intentionally excluded from plain-data validation.
      input=frame(input,['fence','expectedRoute','nextRoute','receipt'],[],['fence']);if(!input)return fail('native_route_input_invalid');
      const before=await verifyFence(input.fence);if (!before.ok) return before;
      const state=before.state;
      if (!C.validateRoute(input.expectedRoute).ok || !C.validateRoute(input.nextRoute).ok || !same(input.expectedRoute,state.expectedRoute)
        || input.nextRoute.state!=='active' || input.nextRoute.routeGeneration===state.expectedRoute.routeGeneration || !plain(input.receipt) || !state.snapshot) return fail('native_route_input_invalid');
      const receipt=input.receipt;
      if(!exact(receipt,C.DTO_KEYS.MigrationReceipt) || receipt.schema!=='wm.migration-receipt.v1' || receipt.operationId!==state.operationId
        || !same(receipt.sourceRoute,state.expectedRoute) || !same(receipt.targetRoute,input.nextRoute) || receipt.inventoryDigest!==state.snapshot.inventoryDigest
        || !C.validateDomainTotals(receipt.domainCounts).ok || !C.validateDomainTotals(receipt.domainBytes).ok
        || !same(receipt.domainCounts,state.snapshot.domainCounts) || !same(receipt.domainBytes,state.snapshot.domainBytes)
        || receipt.sourcePreserved!==true || receipt.verified!==true || typeof receipt.cutoverStatus!=='string')return fail('native_migration_receipt_invalid');
      const requestFingerprint=await C.fingerprintRequest({operationId:state.operationId,sourceRoute:state.expectedRoute,targetRoute:input.nextRoute,inventoryDigest:state.snapshot.inventoryDigest,domainCounts:state.snapshot.domainCounts,domainBytes:state.snapshot.domainBytes,sourcePreserved:true});
      if(receipt.requestFingerprint!==requestFingerprint)return fail('native_migration_fingerprint_mismatch');
      if(state.publishFingerprint && state.publishFingerprint!==requestFingerprint)return {status:'conflict',operationId:state.operationId,requestFingerprint};
      state.publishFingerprint=requestFingerprint;
      // Provider owns durable CAS and authenticates the inventory/target receipt; JSON flags are insufficient.
      try {
        if(await provider.verifyMigrationReceipt({handle:state.handle,requestFingerprint,expectedRoute:clone(state.expectedRoute),nextRoute:clone(input.nextRoute),inventory:clone(state.snapshot),receipt:clone(receipt)})!==true)return fail('native_migration_receipt_unverified');
        const result=await provider.publishRoute({handle:state.handle,operationId:state.operationId,requestFingerprint,fenceRequestFingerprint:state.requestFingerprint,
          expectedRoute:clone(state.expectedRoute),nextRoute:clone(input.nextRoute),receipt:clone(input.receipt),inventory:clone(state.snapshot)});
        if (!C.validateOperationStatus(result).ok || result.operationId!==state.operationId || result.requestFingerprint!==requestFingerprint) return uncertain(state.operationId,requestFingerprint);
        if (result.status==='committed') state.closed=true;
        return clone(result);
      } catch { return uncertain(state.operationId,requestFingerprint); }
    }
    async function sourceFenceReceipt(fence) {
      const verified=await verifyFence(fence);if (!verified.ok) return verified;
      if(!verified.state.snapshot)return fail('native_inventory_required');
      try {const receipt=await provider.fenceReceipt({handle:verified.state.handle,operationId:verified.state.operationId,requestFingerprint:verified.state.requestFingerprint});
        if (!plain(receipt) || await provider.verifyFenceReceipt(receipt,{expectedRoute:clone(verified.state.expectedRoute),inventory:clone(verified.state.snapshot)})!==true) return fail('native_fence_receipt_unverified');
        return {ok:true,receipt:clone(receipt)};
      } catch { return fail('native_fence_receipt_unavailable'); }
    }
    async function verifySourceFenceReceipt(receipt,context) {
      if (!inspect().supported || !plain(receipt) || !plain(context)) return false;
      try {return await provider.verifyFenceReceipt(clone(receipt),clone(context))===true;}catch{return false;}
    }
    async function verifyMigrationFence(fence){const value=await verifyFence(fence);return value.ok?{ok:true}:fail(value.reason);}
    async function migration(method,input={}){if(!inspect().supported)return fail('native_host_unqualified');if(P.isAdapter(portability)){if(!portability.isForProvider(provider))return fail('native_portability_owner_binding_missing');const result=await portability.migration(method,input);if(method==='inspectMigrationDestination'&&result?.ok===true)return {...result,activationEnabled:true};return result;}if(typeof provider.migration!=='function')return fail('native_migration_unsupported');try{return await provider.migration(method,input);}catch{return {...fail('native_migration_uncertain'),uncertain:true};}}
    async function reconcileMigration(input){if(inspect().supported&&plain(input)&&P.isAdapter(portability))return portability.isForProvider(provider)?portability.reconcileMigration(input):fail('native_portability_owner_binding_missing');if(!inspect().supported||!plain(input)||typeof provider.reconcileMigration!=='function')return fail('native_route_reconciliation_unsupported');try{return await provider.reconcileMigration(clone(input));}catch{return {...fail('native_route_reconciliation_uncertain'),uncertain:true};}}
    async function nativeBackup(method,input={}) {if(!inspect().supported)return fail('native_host_unqualified');if(!P.isAdapter(portability))return fail('native_backup_materializer_unsupported');if(!portability.isForProvider(provider))return fail('native_portability_owner_binding_missing');return portability.backup(method,input);}
    const nativePortabilitySupport=()=>P.isAdapter(portability)?portability.inspect():fail('native_owner_facilities_missing');
    async function markTargetPending(input) {
      if (!exact(input,['transferId','targetIdentity']) || !token(input.transferId) || !validIdentity(input.targetIdentity)) return fail('pending_target_input_invalid');
      if (!inspect().supported) return fail('native_host_unqualified');
      try {
        // Must durably journal AND acquire the WM owner fence before returning a handle.
        const targetIdentity=clone(input.targetIdentity),buildIncarnation=incarnation(),handle=await provider.markTargetPending({transferId:input.transferId,targetIdentity});
        if (!handle || typeof handle!=='object' || handle.ok===false) return fail('pending_target_not_acquired');
        const pendingToken=Object.freeze({});pendingTokens.set(pendingToken,{handle,transferId:input.transferId,targetIdentity,incarnation:buildIncarnation,closed:false});
        const verified=await verifyPending(pendingToken);if (!verified.ok) return verified;return pendingToken;
      } catch { return {...fail('pending_target_uncertain'),uncertain:true}; }
    }
    async function verifyPending(pendingToken) {
      const state=pendingTokens.get(pendingToken);if (!state || state.closed) return fail('pending_token_invalid');
      if (!inspect().supported) return fail('native_host_unqualified');
      try {
        if (incarnation()!==state.incarnation) return fail('pending_token_incarnation_changed');
        const result=await provider.verifyPending({handle:state.handle,transferId:state.transferId,targetIdentity:clone(state.targetIdentity)});
        return result?.ok===true ? {ok:true,state} : fail('pending_fence_unconfirmed');
      } catch { return fail('pending_fence_unavailable'); }
    }
    async function authorizeImport(input) {
      input=frame(input,['pendingToken','receipt'],[],['pendingToken']);if(!input)return fail('import_authorization_invalid');
      const verified=await verifyPending(input.pendingToken);if (!verified.ok) return verified;
      const state=verified.state,receipt=input.receipt;
      if (!exact(receipt,['schema','authorizationId','transferId','sourceIdentity','targetIdentity','sourceFingerprint']) || receipt.schema!=='wm.verified-import-authorization.v1' || !token(receipt.authorizationId) || !digest(receipt.sourceFingerprint) || !token(receipt.transferId) || receipt.transferId!==state.transferId || !validIdentity(receipt.sourceIdentity) || !validIdentity(receipt.targetIdentity)
        || !same(receipt.targetIdentity,state.targetIdentity) || receipt.sourceIdentity.scope===state.targetIdentity.scope) return fail('import_identity_invalid');
      try {
        const accepted=await provider.verifyImportAuthorization({handle:state.handle,transferId:state.transferId,targetIdentity:clone(state.targetIdentity),receipt:clone(receipt)});
        if (accepted?.ok!==true) return fail('import_authorization_unverified');
        const importToken=Object.freeze({});importTokens.set(importToken,{pendingToken:input.pendingToken,transferId:state.transferId,targetIdentity:clone(state.targetIdentity)});return {ok:true,importToken};
      } catch { return fail('import_authorization_unavailable'); }
    }
    async function checkTarget(input={}) {
      input=frame(input,['scope'],['targetIdentity','operation','importToken','route'],['importToken']);if(!input)return fail('pending_target_input_invalid');
      const {scope,targetIdentity=null,operation='ordinary',importToken=null,route=null}=input;
      if (typeof scope!=='string' || !scope || targetIdentity!==null && (!validIdentity(targetIdentity) || targetIdentity.scope!==scope)) return fail('pending_target_input_invalid');
      if (!provider || typeof provider.readTargetPending!=='function') return {ok:true,pendingSupported:false};
      try {
        const observed=await provider.readTargetPending({scope,targetIdentity:targetIdentity && clone(targetIdentity)});
        if (!exact(observed,['state'],['transferId','targetIdentity']) || !['clear','pending'].includes(observed.state)) return fail('pending_target_unknown');
        if (observed.state==='pending') {
          if (!token(observed.transferId) || !validIdentity(observed.targetIdentity) || observed.targetIdentity.scope!==scope) return fail('pending_target_unknown');
          if (targetIdentity && !same(targetIdentity,observed.targetIdentity)) return fail('pending_target_identity_changed');
          const imported=importTokens.get(importToken);
          if (operation!=='import' || !imported || imported.transferId!==observed.transferId || !same(imported.targetIdentity,observed.targetIdentity)) return fail('target_import_pending');
          const verified=await verifyPending(imported.pendingToken);if (!verified.ok) return verified;
          const admitted=await provider.guard({scope,targetIdentity:clone(observed.targetIdentity),operation:'import',importHandle:verified.state.handle,route:route && clone(route)});
          return admitted?.ok===true ? {ok:true,verifiedImport:true} : fail('import_fence_unconfirmed');
        }
        if (importToken) return fail('import_target_not_pending');
        if (inspect().supported) {
          const admitted=await provider.guard({scope,targetIdentity:targetIdentity && clone(targetIdentity),operation,route:route && clone(route)});
          return admitted?.ok===true ? {ok:true} : fail('native_writer_fenced');
        }
        return {ok:true,pendingSupported:true};
      } catch { return fail('pending_target_unavailable'); }
    }
    async function releaseTarget(input) {
      input=frame(input,['pendingToken','targetHead','receipt'],[],['pendingToken']);if(!input || !C.validateHead(input.targetHead).ok)return fail('pending_release_input_invalid');
      const verified=await verifyPending(input.pendingToken);if (!verified.ok) return verified;
      const state=verified.state;
      if (input.targetHead.scope!==state.targetIdentity.scope) return fail('pending_target_identity_changed');
      const receipt=input.receipt;
      if(!exact(receipt,C.DTO_KEYS.WmHandoffReceipt) || receipt.schema!=='wm.handoff-materialized-receipt.v1' || receipt.transferId!==state.transferId
        || !validIdentity(receipt.sourceIdentity) || !validIdentity(receipt.targetIdentity) || !same(receipt.targetIdentity,state.targetIdentity)
        || receipt.sourceIdentity.scope===state.targetIdentity.scope || !C.validateHead(receipt.sourceHead).ok || receipt.sourceHead.scope!==receipt.sourceIdentity.scope
        || !same(receipt.targetHead,input.targetHead) || !C.validateRoute(receipt.sourceRoute).ok || !C.validateRoute(receipt.targetRoute).ok
        || !digest(receipt.sourceFingerprintBefore) || receipt.sourceFingerprintBefore!==receipt.sourceFingerprintAfter
        || receipt.sourcePreserved!==true || receipt.sourceMutated!==false || receipt.sourceCompacted!==false || receipt.copyMode!=='materialized'
        || !Number.isSafeInteger(receipt.physicalCopies) || receipt.physicalCopies<1 || !digest(receipt.payloadDigest) || receipt.usable!==true
        || !exact(receipt.domains,C.DOMAINS) || C.DOMAINS.some(domain=>!exact(receipt.domains[domain],['count','bytes','digest','complete'])
          || !Number.isSafeInteger(receipt.domains[domain].count) || receipt.domains[domain].count<0 || !Number.isSafeInteger(receipt.domains[domain].bytes)
          || receipt.domains[domain].bytes<0 || !digest(receipt.domains[domain].digest) || receipt.domains[domain].complete!==true))return fail('pending_target_receipt_invalid');
      try {
        // Provider validates the verified materialized receipt and actual target Head,
        // then atomically clears the durable journal/fence. No delete-on-timeout fallback.
        const verifiedReceipt=clone(receipt),targetHead=clone(input.targetHead);
        if (await provider.verifyTargetReceipt({handle:state.handle,transferId:state.transferId,targetIdentity:clone(state.targetIdentity),targetHead,receipt:verifiedReceipt})!==true) return fail('pending_target_receipt_unverified');
        const result=await provider.releaseTarget({handle:state.handle,transferId:state.transferId,targetIdentity:clone(state.targetIdentity),targetHead,receipt:verifiedReceipt});
        if (result?.ok!==true) return {...fail('pending_release_unconfirmed'),uncertain:result?.uncertain===true};
        const observed=await provider.readTargetPending({scope:state.targetIdentity.scope,targetIdentity:clone(state.targetIdentity)});
        if (!exact(observed,['state']) || observed.state!=='clear') return {...fail('pending_release_unconfirmed'),uncertain:true};
        state.closed=true;return {ok:true};
      } catch {return {...fail('pending_release_uncertain'),uncertain:true};}
    }
    // C1 scope materialization is distinct from B5 whole-dataset migration.
    // No production provider currently implements/qualifies this seam. In particular,
    // content-addressed migration blobs are not evidence of independent target copies.
    const HANDOFF_METHODS=Object.freeze(['sourceState','registerSource','pendingProof','begin','stageStatus','chunk','verifyStage','materialize','readback','status','abort','rollback','completion','releaseSource']);
    function handoffCapabilities() {
      if(!inspect().supported || typeof provider.handoff!=='function' || typeof provider.describeHandoffCapabilities!=='function')return fail('handoff_scope_materializer_unavailable');
      try {
        const value=provider.describeHandoffCapabilities();
        if(!exact(value,['schema','modes','limits','freshTargetCAS','independentMaterializedUnits','durableStatus','durableReadback','conditionalRollback'])
          || value.schema!=='wm.handoff-provider.v1' || !Array.isArray(value.modes) || !value.modes.length || new Set(value.modes).size!==value.modes.length
          || value.modes.some(mode=>!['plugin_only','server_only'].includes(mode))
          || !exact(value.limits,['maxChunkBytes','maxPageItems','maxPageBytes','maxItems','maxTotalBytes','maxCanonicalBytes'])
          || Object.values(value.limits).some(n=>!Number.isSafeInteger(n)||n<1)
          || ['freshTargetCAS','independentMaterializedUnits','durableStatus','durableReadback','conditionalRollback'].some(k=>value[k]!==true))return fail('handoff_scope_materializer_unqualified');
        return {ok:true,...clone(value)};
      }catch{return fail('handoff_scope_materializer_unavailable');}
    }
    async function handoff(method,value) {
      const cap=handoffCapabilities();if(!cap.ok)return cap;
      value=frame(value,['input'],['sourceFence','pendingToken','bytes'],['sourceFence','pendingToken','bytes']);
      if(!HANDOFF_METHODS.includes(method)||!value||!plain(value.input))return fail('handoff_provider_input_invalid');
      const input=clone(value.input),needsSource=['sourceState','registerSource','begin','materialize','releaseSource'].includes(method),needsPending=['pendingProof','begin','stageStatus','chunk','verifyStage','materialize','readback','abort','rollback'].includes(method);
      let source=null,pending=null;
      if(value.sourceFence){source=await verifyFence(value.sourceFence);if(!source.ok)return source;if(input.sourceRoute&&!same(input.sourceRoute,source.state.expectedRoute))return fail('handoff_source_route_changed');}
      if(needsSource&&!source)return fail('handoff_source_fence_required');
      if(value.pendingToken){pending=await verifyPending(value.pendingToken);if(!pending.ok)return pending;
        if(input.transferId!==pending.state.transferId||input.targetIdentity&&!same(input.targetIdentity,pending.state.targetIdentity))return fail('handoff_pending_identity_changed');}
      if(needsPending&&!pending)return fail('handoff_pending_token_required');
      if(input.sourceRoute&&!cap.modes.includes(input.sourceRoute.mode))return fail('handoff_mode_unsupported');
      let bytes;
      if(method==='chunk'){
        if(!(value.bytes instanceof Uint8Array)||value.bytes.byteLength>Math.min(262144,cap.limits.maxChunkBytes))return fail('handoff_chunk_invalid');
        bytes=new Uint8Array(value.bytes);
      }else if(Object.hasOwn(value,'bytes'))return fail('handoff_provider_input_invalid');
      try {
        const result=await provider.handoff(method,{input,sourceFenceHandle:source?.state.handle||null,pendingHandle:pending?.state.handle||null,...bytes?{bytes}:{}});
        if(!plain(result))return fail('handoff_provider_result_invalid');
        return clone(result);
      }catch{return {...fail('handoff_provider_uncertain'),uncertain:true};}
    }
    async function check(input={}) {
      input=frame(input,['route'],['write','scope','operation','importToken'],['importToken']);if(!input)return fail('native_gate_input_invalid');
      const {route,write=false,scope=null,operation='ordinary',importToken=null}=input;
      if (!C.validateRoute(route).ok || route.state!=='active') return fail('route_changed');
      if (route.mode==='server_only' && !inspect().supported) return fail('native_host_unqualified');
      if (scope) return checkTarget({scope,operation,importToken,route});
      if (inspect().supported) {
        try {const result=await provider.guard({scope:null,targetIdentity:null,operation:write?'write':'read',route:clone(route)});return result?.ok===true?{ok:true}:fail('native_writer_fenced');}
        catch {return fail('native_writer_fence_unavailable');}
      }
      return {ok:true};
    }
    const gate=Object.freeze({inspect,acquireFence,captureInventory,publishRoute,status,verifyMigrationFence,migration,reconcileMigration,nativeBackup,nativePortabilitySupport,markTargetPending,authorizeImport,releaseTarget,checkTarget,check,
      sourceFenceReceipt,verifySourceFenceReceipt,handoffCapabilities,handoff,qualifiedProfiles:Object.freeze([]),hostCatalog:provider?.hostCatalog || null});
    gates.add(gate);return gate;
  }
  return Object.freeze({createWmNativeHostGate,isGate:gate=>gates.has(gate),validIdentity,requiredProviderMethods:REQUIRED_METHODS,requiredGuarantees:GUARANTEES,
    qualifiedProductionProfiles:Object.freeze([]),operationalKeys:Object.freeze(['wm.operation-journal.v1','wm.pending-import.v1','wm.storage-route.v1'])});
})();
if (typeof module!=='undefined' && module.exports) module.exports=WmNativeHostGate;
