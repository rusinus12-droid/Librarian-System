    // Optional, explicitly injected authority. Native Risu remains unchanged.
    let clearAuthorityReadonlyProof = () => {};
    let disposeAuthorityDerivedCache = () => {};
    let invalidateAuthorityDerivedCache = () => {};
    const WmPortabilityAdapter = WmNativePortability.isAdapter(environment.nativePortabilityAdapter) ? environment.nativePortabilityAdapter
        : environment.nativePortabilityFacilities ? WmNativePortability.createWmNativePortability(environment.nativePortabilityFacilities) : null;
    const WmHostGate = WmNativeHostGate.isGate(environment.nativeHostGate) ? environment.nativeHostGate
        : WmNativeHostGate.createWmNativeHostGate({provider:environment.nativeHostProvider,qualification:environment.nativeHostQualification,portability:WmPortabilityAdapter});
    // Default ordinary WM connection and manual owner-storage profile. The strong
    // host/provider path remains separately injected and never receives manual claims.
    const WmNativeStores = Object.fromEntries(['plugin','local'].map(space => {
        const adapter=space==='plugin'?RisuCompat.pluginStorage:RisuCompat.localPluginStorage;
        return [space,Object.fromEntries(['getItem','setItem','removeItem','keys','inventoryPhysicalKeys','readRouteIdentity'].filter(k=>typeof adapter[k]==='function').map(k=>[k,adapter[k].bind(adapter)]))];
    }));
    const WmConnectionRuntime = !runtimeDetached && !environment.storageRouter && !environment.snapshotAuthority && !environment.storageMigration
        ? WmServerConnection.createWmServerConnection({storage:WmNativeStores.plugin,fetch:(url,init)=>RisuCompat.request(url,init,{timeoutMs:10000,onPhysical:promise=>WmConnectionRuntime.trackPhysical(promise)})}) : null;
    if (WmConnectionRuntime) runtimeDisposers.push(() => WmConnectionRuntime.dispose());
    const WmManualHostCatalog = (()=>{
        const first=(...values)=>values.map(v=>String(v??'').trim()).find(Boolean)||'';
        async function read(){
            const db=await RisuCompat.database.get(['characters','personas','selectedPersona']);
            if(!db||!Array.isArray(db.characters)||!Array.isArray(db.personas))throw Error('host_catalog_unavailable');
            const selected=Number(db.selectedPersona),defaultPersona=Number.isInteger(selected)&&db.personas[selected]?first(db.personas[selected].id,db.personas[selected]._id,'personaIndex:'+selected):'default',rows=[];
            for(const char of db.characters){if(!Array.isArray(char.chats))continue;const characterId=first(char.id,char._id,char.uid,char.uuid,char.key,char.chaId);if(!characterId)throw Error('host_catalog_identity_unavailable');
                for(const chat of char.chats){const chatId=first(chat.id,chat._id,chat.uid,chat.uuid,chat.key,chat.chatId);if(!chatId)throw Error('host_catalog_identity_unavailable');
                    const persona=first(chat.bindedPersona,chat.boundPersonaId,chat.personaId,char.bindedPersona,defaultPersona),scopeKey=LibraDataStorage.scopeKeyFor(char,chat,persona);rows.push({scopeKey,chatId,characterId,char,chat});}}
            rows.sort((a,b)=>a.scopeKey.localeCompare(b.scopeKey));if(new Set(rows.map(r=>r.scopeKey)).size!==rows.length)throw Error('host_catalog_identity_ambiguous');return rows;
        }
        return Object.freeze({listScopes:async()=> (await read()).map(({scopeKey,chatId,characterId})=>({scopeKey,chatId,characterId})),readWmScope:async scope=>{
            const row=(await read()).find(r=>r.scopeKey===scope);if(!row)throw Error('host_scope_missing');
            const lore=[...(Array.isArray(row.char.globalLore)?row.char.globalLore:[]),...(Array.isArray(row.char.lorebook)?row.char.lorebook:[]),...(Array.isArray(row.chat.localLore)?row.chat.localLore:[]),...(Array.isArray(row.chat.lorebook)?row.chat.lorebook:[])];
            const wmLore=LibraLoreConsolidator.unpackRawFromLore(lore).filter(e=>String(e?.comment||'').startsWith('lmai_'));
            const observed=LibraHostLineage.inspect(row.char,row.chat);let lineage=null;
            if(observed?.parentChatId){if(observed.status!=='verified'||observed.pathVerified!==true)throw Error('host_lineage_unverified');lineage={schema:'libra.host.worldline.meta.v1',worldlineId:scope,scopeKey:scope,parentWorldlineId:observed.parentChatId,forkTurn:Number(observed.commonPrefixPairs)||0,forkFingerprint:String(observed.prefixDigest||''),createdAt:0};}
            const revision=await WmStorageContracts.hashBytes(new TextEncoder().encode(WmStorageInventory.canonicalJson({wmLore,lineage})));
            return {scopeKey:scope,sourceIdentity:scope,revision,wmLore,lineage};
        }});
    })();
    const WmManualRuntime = WmConnectionRuntime ? await WmManualStorage.createWmManualStorage({storage:WmNativeStores.plugin,nativeStores:WmNativeStores,connection:WmConnectionRuntime,
        inventoryFactory:()=>WmStorageInventory.createWmInventory({manualProfile:true,nativeStores:WmNativeStores,hostCatalog:WmManualHostCatalog}),
        pause:async()=>{wmManualWorkPaused=true;invalidateLibraRuntimeEpoch();}
    }) : null;
    if(WmManualRuntime)for(const space of ['plugin','local'])Object.assign(space==='plugin'?RisuCompat.pluginStorage:RisuCompat.localPluginStorage,WmManualRuntime.wrap(space));
    // This gate reads the provider's durable pending journal on every admission.
    // A missing provider cannot acquire a pending fence or activate server authority.
    const WmPendingAdmission = Object.freeze({
        forScope: async (scope, operation='ordinary') => {const manual=await WmManualRuntime?.admission();return manual?.ok===false?manual:WmHostGate.checkTarget({scope:String(scope||''),operation});},
        forChat: async (char,chat,operation='ordinary') => {
            const manual=await WmManualRuntime?.admission();if(manual?.ok===false)return manual;
            if (!char || !chat) return WmHostGate.checkTarget({scope:char ? LibraDataStorage.scopeKeyFor(char,chat) : 'global',operation});
            const scope=LibraDataStorage.scopeKeyFor(char,chat), proof=PersonaScopeIdentity.get(char,chat);
            const match=/^char:(.+)\|chat:(.+)\|persona:(.+)$/.exec(scope);
            const targetIdentity=match ? {scope,characterId:match[1],chatId:match[2],personaId:match[3],resetGeneration:proof?.resetGeneration||0} : null;
            return WmHostGate.checkTarget({scope,targetIdentity,operation});
        }
    });
    const WmWriterRuntime = await WmWriterRouting.createWmWriterRuntime({router:environment.storageRouter,historyProfile:environment.pagedHistoryProfile||null});
    if(WmWriterRuntime.enabled)runtimeDisposers.push(()=>{void WmWriterRuntime.dispose();});
    const VersionedCanonicalBridge = (() => {
        if(WmWriterRuntime.enabled)return Object.freeze({...WmWriterRuntime,mode:'authority'});
        const provider=environment.snapshotAuthority;
        if(provider==null)return Object.freeze({mode:'native',openRequest:()=>null,closeRequest:async()=>({ok:true}),finalObservation:async()=>({ok:true}),diagnostics:()=>({retainedBytes:0,requestOwnedBytes:0})});
        if(runtimeDetached)throw new Error('snapshot_authority_detached_unsupported');
        const description=provider.describe?.(),authority=WmSnapshotAuthorityModule.createSnapshotAuthority(provider,{maxPayloadBytes:description?.maxPayloadBytes}),journal=environment.operationJournal;
        if(description?.journalRequired && !journal)throw new Error('snapshot_operation_journal_required');
        if(!authority.ok||typeof provider.observeHeads!=='function'||!description?.capabilities?.includes('atomic_healthy_head_set_observation'))throw new Error('snapshot_authority_unsupported');
        const observeHeads=provider.observeHeads.bind(provider),owners=new WeakMap(),active=new Set(),receipts=new WeakMap();
        const HEAD_KEYS=['protocol','authorityId','storeId','scope','epoch','revision','schema','generationId','sha256','utf8Bytes','tombstone'];
        const sameHead=(a,b)=>{if(!a||!b||typeof a!=='object'||Array.isArray(a))return false;const d=Object.getOwnPropertyDescriptors(a);return Object.keys(d).length===HEAD_KEYS.length&&HEAD_KEYS.every(k=>d[k]&&Object.prototype.hasOwnProperty.call(d[k],'value')&&d[k].value===b[k]);};
        let disposed=false;const attempts=new Map();
        const observeFresh=async scopes=>{
            if(!description?.leasedObservations)return observeHeads(scopes);
            const acquired=[];try{for(const scope of scopes)acquired.push(await provider.acquire(scope));return await observeHeads(scopes,{leases:acquired.map(v=>v.lease)});}finally{await Promise.all(acquired.map(v=>provider.release(v.lease)));}
        };
        const reconcile=async operationId=>{if(!journal||typeof provider.operationStatus!=='function')return {ok:false,reason:'operation_status_unsupported'};const entry=await journal.get(operationId);return entry?provider.operationStatus({operationId,requestFingerprint:entry.requestFingerprint}):{ok:false,reason:'operation_unknown'};};
        const fail=reason=>({ok:false,reason});
        const openRequest=()=>{if(disposed)return null;const owner=Object.freeze({}),state={owner,scopes:new Map(),pending:new Set(),sealed:false,failed:false,cleaned:false,finalized:false,finalPhase:false};owners.set(owner,state);active.add(state);return owner;};
        const issue=(scope,head)=>{const token=Object.freeze({});receipts.set(token,Object.freeze({scope,head}));return token;};
        const source=token=>!disposed&&receipts.get(token);
        const dropOwnedValues=state=>{for(const item of state.scopes.values()){item.raw=undefined;item.bytes=0;}clearAuthorityReadonlyProof(state.owner);};
        const closeRequest=async(owner,retainForFinal=false)=>{
            const state=owners.get(owner);if(!state)return disposed?fail('authority_disposed'):{ok:true};if(state.cleaned)return {ok:true};
            state.sealed=true;await Promise.allSettled([...state.pending]);
            const closed=await Promise.all([...state.scopes.values()].map(item=>authority.close(item.handle)));
            if(closed.some(result=>!result.ok)){state.failed=true;dropOwnedValues(state);return fail('authority_release_unconfirmed');}
            state.cleaned=true;state.finalPhase=retainForFinal&&!state.failed&&!disposed;
            if(!state.finalPhase){dropOwnedValues(state);active.delete(state);}return {ok:true};
        };
        const read=async(scope,owner=null)=>{
            if(disposed)return fail('authority_disposed');
            if(!owner){const temporary=openRequest(),result=await read(scope,temporary),closed=await closeRequest(temporary);return closed.ok?result:fail(closed.reason);}
            const state=owners.get(owner);if(!state||(state.sealed&&!state.finalPhase)||state.failed)return fail('authority_request_invalidated');
            let item=state.scopes.get(scope);
            if(!item){if(state.sealed)return fail('authority_final_scope_changed');if(state.scopes.size>=8){state.failed=true;return fail('authority_scope_budget');}const handle=authority.open(scope);if(!handle){state.failed=true;return fail('authority_scope_invalid');}item={handle,head:null,token:null,raw:undefined,bytes:0};state.scopes.set(scope,item);}
            // Cleanup releases backend pins, not the still-owned immutable value.
            // The final native host/source checks only observe small healthy HEADs.
            if(state.finalPhase){try{const observed=await observeFresh([scope]);if(disposed||state.failed||!owners.has(owner)||!Array.isArray(observed)||observed.length!==1||!sameHead(observed[0],item.head)){state.failed=true;return fail('authority_source_changed');}return {ok:true,raw:item.raw,head:item.head,missing:item.head.tombstone,sourceToken:item.token};}catch(_){state.failed=true;return fail('authority_observation_unavailable');}}
            const pending=authority.read(item.handle);state.pending.add(pending);let result;
            try{result=await pending;}finally{state.pending.delete(pending);}
            if(state.sealed||disposed)return fail('authority_request_invalidated');if(!result.ok){state.failed=true;return result;}
            if(!item.head){item.head=result.head;item.token=issue(scope,result.head);item.raw=result.raw;item.bytes=result.head.utf8Bytes;}
            if(!sameHead(result.head,item.head)){state.failed=true;return fail('authority_source_changed');}return {...result,sourceToken:item.token};
        };
        const finalObservation=async owner=>{
            const state=owners.get(owner);if(!state||disposed||state.failed||state.finalized)return fail('authority_request_invalidated');
            const expected=[...state.scopes.entries()].map(([scope,item])=>({scope,head:item.head}));if(!expected.length||expected.some(x=>!x.head))return fail('authority_source_missing');
            if(description?.leasedObservations){const checked=await authority.observe([...state.scopes.values()].map(item=>item.handle));if(!checked.ok){state.failed=true;return fail('authority_observation_unavailable');}}
            const closed=await closeRequest(owner,true);if(!closed.ok||disposed||state.failed)return fail(closed.reason||'authority_request_invalidated');
            let observed;try{observed=description?.leasedObservations?expected.map(x=>x.head):await observeHeads(expected.map(x=>x.scope));}catch(_){state.failed=true;return fail('authority_observation_unavailable');}
            if(disposed||state.failed||!Array.isArray(observed)||observed.length!==expected.length||new Set(observed.map(x=>x?.scope)).size!==expected.length||expected.some(x=>!sameHead(observed.find(h=>h?.scope===x.scope),x.head))){state.failed=true;return fail('authority_source_changed');}
            state.finalized=true;return {ok:true};
        };
        const finishRequest=owner=>{const state=owners.get(owner);if(!state)return;dropOwnedValues(state);state.finalPhase=false;state.sealed=true;if(state.cleaned){owners.delete(owner);active.delete(state);state.scopes.clear();}};
        const validateSource=(scope,token)=>{const receipt=source(token);return receipt?.scope===scope?{ok:true,head:receipt.head}:fail('authority_write_token_required');};
        const commit=async(scope,token,raw,operation)=>{
            const receipt=validateSource(scope,token);if(!receipt.ok)return receipt;if(typeof globalThis.crypto?.randomUUID!=='function')return fail('authority_operation_id_unavailable');
            const rawSha256=await WmStorageContracts.hashBytes(new TextEncoder().encode(raw??'')),intentFingerprint=await WmStorageContracts.fingerprintRequest({scope,expectedHead:receipt.head,rawSha256,operation});
            if(journal){const pending=(await journal.pending()).find(e=>e.reference?.intentFingerprint===intentFingerprint);if(pending){const status=await reconcile(pending.operationId);return status.status==='committed'?{ok:true,head:status.receipt.head,operationId:status.operationId,reconciled:true}: {ok:false,reason:'commit_uncertain',uncertain:true,operationId:pending.operationId,requestFingerprint:pending.requestFingerprint};}}
            const operationId=attempts.get(intentFingerprint)||globalThis.crypto.randomUUID();attempts.set(intentFingerprint,operationId);
            const result=await authority.commit({scope,expectedHead:receipt.head,raw,operation,operationId});if(result.ok){attempts.delete(intentFingerprint);invalidateAuthorityDerivedCache(scope);}else if(!result.uncertain)attempts.delete(intentFingerprint);return result;
        };
        const currentSource=async(scope,expected)=>{if(disposed)return fail('authority_disposed');try{const observed=await observeFresh([scope]);return !disposed&&Array.isArray(observed)&&observed.length===1&&sameHead(observed[0],expected)?{ok:true}:fail('authority_source_changed');}catch(_){return fail('authority_observation_unavailable');}};
        const matches=(a,b)=>{const one=source(a),two=source(b);return !!one&&!!two&&one.scope===two.scope&&sameHead(one.head,two.head);};
        const dispose=async()=>{disposed=true;disposeAuthorityDerivedCache();const pending=[...active];await Promise.all(pending.map(s=>closeRequest(s.owner)));await authority.dispose();for(const state of pending)finishRequest(state.owner);};
        runtimeDisposers.push(()=>{void dispose();});
        return Object.freeze({mode:'authority',openRequest,read,closeRequest,finalObservation,finishRequest,validateSource,commit,reconcile,currentSource,matches,sameHead,isCleaned:owner=>owners.get(owner)?.cleaned===true,
            diagnostics:()=>({...authority.diagnostics(),requestOwnedBytes:[...active].reduce((n,s)=>n+[...s.scopes.values()].reduce((sum,i)=>sum+i.bytes,0),0),requestOwners:active.size}),dispose});
    })();
