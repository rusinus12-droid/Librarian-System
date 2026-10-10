/* Ordinary WM HTTP connection. Explicit user bootstrap only; startup never issues credentials. */
const WmServerConnection = (() => {
    'use strict';
    const C = typeof WmStorageContracts !== 'undefined' ? WmStorageContracts : require('./wm-storage-contracts.source.js');
    const R = typeof WmStorageRouter !== 'undefined' ? WmStorageRouter : require('./wm-storage-router.source.js');
    const STORAGE_KEY = 'wm.server-connection.v1';
    const SCHEMA = 'wm.server-connection-config.v1';
    const fail = reason => { throw Error(reason); };
    const token = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
    function normalizeUrl(value) {
        if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) fail('connection_url_invalid');
        let url; try { url = new URL(value); } catch { fail('connection_url_invalid'); }
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password
            || url.search || url.hash || url.pathname !== '/') fail('connection_url_invalid');
        return url.origin;
    }
    function validCredential(value) {
        // This is a pre-send scope check, NOT signature verification or authority. The server authenticates it.
        if (typeof value !== 'string' || value.length > 4096 || !/^mscap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
        try {
            const encoded = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(atob(encoded));
            return R.exactData(payload, ['schema', 'pluginId']) && payload.schema === 'memory-suite.capability-token.v1' && payload.pluginId === C.PLUGIN_ID;
        } catch { return false; }
    }
    function createWmServerConnection({storage, fetch: fetcher} = {}) {
        if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') fail('connection_storage_unavailable');
        let observedRaw = undefined, configurationGuard = async () => true;
        const physical = new Set();
        const trackPhysical = promise => {const work=Promise.resolve(promise);physical.add(work);work.finally(()=>physical.delete(work)).catch(()=>{});return work;};
        let disposed = false, revision = 0, queue = Promise.resolve(), flight = null, activeAbort = null;
        const active = () => { if (disposed) fail('connection_disposed'); };
        const invalidate = () => { revision++; activeAbort?.abort(); };
        const serial = fn => { const work = queue.catch(() => {}).then(fn); queue = work.catch(() => {}); return work; };
        async function read() {
            active(); const started = revision; let raw;
            try { raw = await storage.getItem(STORAGE_KEY, {strict:true}); } catch { fail('connection_settings_unavailable'); }
            active(); if (started !== revision) fail('connection_configuration_changed');
            const encoded = raw ?? null;
            if (observedRaw !== undefined && observedRaw !== encoded) invalidate();
            observedRaw = encoded;
            if (raw === null || raw === undefined) return {schema:SCHEMA, baseUrl:'', credential:''};
            try {
                const value = JSON.parse(raw);
                if (!R.exactData(value, ['schema','baseUrl','credential'], ['dataInstanceId']) || value.schema !== SCHEMA
                    || typeof value.baseUrl !== 'string' || typeof value.credential !== 'string'
                    || value.dataInstanceId !== undefined && (typeof value.dataInstanceId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.dataInstanceId))
                    || value.baseUrl && normalizeUrl(value.baseUrl) !== value.baseUrl
                    || value.credential && (!value.baseUrl || !validCredential(value.credential))) fail('invalid');
                return value;
            } catch { fail('connection_settings_invalid'); }
        }
        const publicConfig = value => ({revision, baseUrl:value.baseUrl, credentialSaved:!!value.credential,
            configured:!!value.baseUrl && !!value.credential, transportAvailable:typeof fetcher === 'function'});
        const inspectConfiguration = async () => publicConfig(await read());
        async function write(value) {
            active(); if (!await configurationGuard(value.baseUrl)) fail("connection_route_in_use"); invalidate(); const encoded = JSON.stringify(value);
            try {
                if (await storage.setItem(STORAGE_KEY, encoded) === false || await storage.getItem(STORAGE_KEY, {strict:true}) !== encoded) fail('invalid');
            } catch { fail('connection_settings_unverified'); }
            active(); observedRaw = encoded; return publicConfig(value);
        }
        const saveConfiguration = input => serial(async () => {
            if (!R.exactData(input, ['baseUrl','credential']) || typeof input.credential !== 'string' || typeof input.baseUrl !== 'string') fail('connection_configuration_invalid');
            const baseUrl = normalizeUrl(input.baseUrl.trim()), supplied = input.credential.trim();
            if (supplied && !validCredential(supplied)) fail('connection_credential_invalid');
            const previous = await read();
            // A credential is never silently forwarded to a changed endpoint.
            const credential = supplied || (previous.baseUrl === baseUrl ? previous.credential : '');
            return write({schema:SCHEMA, baseUrl, credential, ...(previous.baseUrl === baseUrl && previous.credential === credential && previous.dataInstanceId ? {dataInstanceId:previous.dataInstanceId} : {})});
        });
        const clearConfiguration = () => serial(() => write({schema:SCHEMA, baseUrl:'', credential:''}));
        async function http(config, path, method, body, signal, maxBytes=131072, authenticated=true) {
            const url=config.baseUrl+path;
            const work=(async()=>{
                let response; try { response=await fetcher(url,{method,headers:{Accept:'application/json','X-Memory-Suite-Plugin':C.PLUGIN_ID,
                    ...(authenticated?{Authorization:'Bearer '+config.credential,...(config.dataInstanceId?{'X-Memory-Suite-Data-Instance':config.dataInstanceId}:{})}:{}),...(body===null?{}:{'Content-Type':'application/json'})},
                    ...(body===null?{}:{body:JSON.stringify(body)}),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',logFetch:false,signal}); }
                catch { fail('server_connection_unavailable'); }
                if(!response||response.redirected||response.url&&response.url!==url)fail('connection_response_invalid');
                if(response.status===401||response.status===403)fail('connection_authentication_failed');
                let raw;
                try {
                    const length=response.headers?.get?.('content-length');
                    if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBytes))fail('invalid');
                    if(typeof response.body?.getReader==='function'){
                        const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),parts=[];let bytes=0;
                        try{while(true){const chunk=await reader.read();if(chunk.done)break;if(Object.prototype.toString.call(chunk.value)!=='[object Uint8Array]'||chunk.value.byteLength>maxBytes-bytes)fail('invalid');bytes+=chunk.value.byteLength;parts.push(decoder.decode(chunk.value,{stream:true}));}parts.push(decoder.decode());raw=parts.join('');}
                        catch{await reader.cancel().catch(()=>{});fail('invalid');}finally{reader.releaseLock();}
                    }else if(typeof response.text==='function')raw=await response.text();
                    else if(typeof response.data==='string')raw=response.data;
                    else if(response.data&&typeof response.data==='object')raw=JSON.stringify(response.data);
                    else if(typeof response.json==='function')raw=JSON.stringify(await response.json());
                    else fail('invalid');
                    if(typeof raw!=='string'||new TextEncoder().encode(raw).length>maxBytes)fail('invalid');
                }catch{fail('connection_response_invalid');}
                let packet;try{packet=JSON.parse(raw);}catch{fail('connection_response_invalid');}
                if(authenticated){
                    if(packet.dataInstanceId !== undefined && (typeof packet.dataInstanceId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(packet.dataInstanceId)))fail('connection_response_invalid');
                    if(config.dataInstanceId){
                        if(packet.dataInstanceId === undefined)fail('connection_response_invalid');
                        if(packet.dataInstanceId !== config.dataInstanceId)fail('connection_data_instance_changed');
                    }
                }
                if(response.status!==200||packet?.ok!==true){if(typeof packet?.error==='string'&&/^wm_[a-z0-9_]+$/.test(packet.error))fail(packet.error.slice(3));fail('server_connection_unavailable');}
                return packet;
            })();physical.add(work);work.finally(()=>physical.delete(work)).catch(()=>{});return work;
        }
        async function request(config, action, signal) {
            const packet=await http(config,'/v1/wm/'+action,'GET',null,signal);
            if(!R.exactData(packet,['ok','result'],['dataInstanceId']))fail('connection_response_invalid');return packet.result;
        }
        const connectUsingBootstrap=input=>serial(async()=>{
            if(!R.exactData(input,['baseUrl','confirmed'])||input.confirmed!==true)fail('connection_access_confirmation_required');
            if(!await configurationGuard(input.baseUrl))fail('connection_route_in_use');
            const baseUrl=normalizeUrl(input.baseUrl.trim()),captured=revision;
            const packet=await http({baseUrl},'/bootstrap','GET',null,null,131072,false);
            if(disposed||captured!==revision)fail('connection_configuration_changed');
            if(packet.schema!=='memory-suite.storage.bootstrap.v1'||packet.protocol?.major!==1||!validCredential(packet.token)
                ||packet.authorization?.schema!=='memory-suite.bootstrap-authorization.v1'||packet.authorization.pluginId!==C.PLUGIN_ID||packet.authorization.namespace!=='wm'
                ||!Array.isArray(packet.authorization.writeNamespaces)||packet.authorization.writeNamespaces.length!==1||packet.authorization.writeNamespaces[0]!=='wm'
                ||packet.capabilities?.['wm.storage.v1']!==true||packet.capabilities?.['wm.inventory.v1']!==true
                ||packet.dataIdentityContract!=='memory-suite.physical-data-identity.v1'||!/^[A-Za-z0-9_-]{32}$/.test(packet.dataInstanceId||''))fail('connection_response_invalid');
            return write({schema:SCHEMA,baseUrl,credential:packet.token,dataInstanceId:packet.dataInstanceId});
        });
        async function requestManual(action,body={}){
            const allowed=['status','begin','chunk','stage-status','seal','activate','list','lookup','read','write'];
            if(!allowed.includes(action)||!R.plainData(body))fail('connection_request_invalid');
            await queue;active();const captured=revision,config=await read();
            if(captured!==revision)fail('connection_configuration_changed');if(!config.baseUrl||!config.credential)fail('connection_configuration_required');
            const packet=await http(config,'/v1/wm/manual/'+action,'POST',{profile:'wm.manual-copy-switch.v1',...body},null,2*1024*1024);
            await read();if(disposed||captured!==revision)fail('connection_configuration_changed');
            if(!R.exactData(packet,['ok','result'],['dataInstanceId']))fail('connection_response_invalid');return packet.result;
        }
        function checkConnection() {
            if (flight) return flight;
            const work = (async () => {
                await queue; active(); const captured = revision, config = await read();
                if (captured !== revision) fail('connection_configuration_changed');
                if (!config.baseUrl || !config.credential) fail('connection_configuration_required');
                if (typeof fetcher !== 'function' || typeof AbortController !== 'function') fail('connection_transport_unavailable');
                const abort = new AbortController(); activeAbort = abort;
                let timer;
                try {
                    const work = (async () => {
                        const capabilities = await request(config, 'capabilities', abort.signal);
                        if (!R.exactData(capabilities, ['schema','owner','protocol','backendId','limits','storage','inventory','externalFenceVerification'])
                            || capabilities.schema !== 'wm.service-capabilities.v1' || capabilities.owner !== 'wm' || capabilities.protocol !== C.PROTOCOL
                            || !token(capabilities.backendId) || capabilities.storage !== true || typeof capabilities.externalFenceVerification !== 'boolean'
                            || !R.plainData(capabilities.limits) || !capabilities.limits || Array.isArray(capabilities.limits) || !Object.keys(capabilities.limits).length
                            || ['maxBodyBytes','maxChunkBytes','maxCanonicalBytes'].some(key => !Object.hasOwn(capabilities.limits,key))
                            || Object.values(capabilities.limits).some(value => !Number.isSafeInteger(value) || value < 1)
                            || !R.exactData(capabilities.inventory, ['chunkReads','put','partialChunkUpload','migrationStaging'])
                            || capabilities.inventory.chunkReads !== true || capabilities.inventory.put !== 'complete_payload_only'
                            || capabilities.inventory.partialChunkUpload !== false || typeof capabilities.inventory.migrationStaging !== 'boolean') fail('connection_response_invalid');
                        if (disposed || revision !== captured || abort.signal.aborted) fail('connection_configuration_changed');
                        const status = await request(config, 'dataset/status', abort.signal);
                        if (!R.exactData(status, ['schema','available','initialized','closed'], ['reason','dataset']) || status.schema !== 'wm.service-status.v1'
                            || status.available !== true || status.closed !== false || typeof status.initialized !== 'boolean') fail('server_connection_unavailable');
                        if (status.initialized) {
                            const data = status.dataset;
                            if (!R.exactData(data, ['identity','route','writerEpoch','inventoryRevision','health'])
                                || !R.exactData(data.identity, ['authorityId','storeId','datasetId','backendId']) || !Object.values(data.identity).every(token)
                                || data.identity.backendId !== capabilities.backendId || !C.validateRoute(data.route).ok
                                || data.route.backendId !== data.identity.backendId || data.route.datasetId !== data.identity.datasetId
                                || !token(data.writerEpoch) || !token(data.inventoryRevision) || !R.exactData(data.health, ['ok']) || data.health.ok !== true) fail('connection_response_invalid');
                        } else if (Object.hasOwn(status, 'dataset')) fail('connection_response_invalid');
                        await read(); active(); if (revision !== captured || abort.signal.aborted) fail('connection_configuration_changed');
                        return {ok:true, backendId:capabilities.backendId, protocol:C.PROTOCOL, limits:Object.fromEntries(['maxBodyBytes','maxChunkBytes','maxCanonicalBytes'].filter(key => Object.hasOwn(capabilities.limits,key)).map(key => [key, capabilities.limits[key]]))};
                    })();
                    const timeout = new Promise((_,reject) => { timer = setTimeout(() => {abort.abort(); reject(Error('connection_timeout'));}, 10000); });
                    return await Promise.race([work, timeout]);
                } finally { clearTimeout(timer); if (activeAbort === abort) activeAbort = null; }
            })();
            flight = work; work.finally(() => { if (flight === work) flight = null; }).catch(() => {}); return work;
        }
        return Object.freeze({inspectConfiguration, saveConfiguration, clearConfiguration, checkConnection, connectUsingBootstrap, requestManual,
            setConfigurationGuard(fn){if(typeof fn!=="function")fail("connection_guard_invalid");configurationGuard=fn;},
            trackPhysical,drain:async()=>{while(physical.size)await Promise.allSettled([...physical]);},
            dispose() { disposed = true; invalidate(); }});
    }
    return Object.freeze({STORAGE_KEY, createWmServerConnection});
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WmServerConnection;
