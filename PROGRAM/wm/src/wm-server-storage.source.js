/* A4-only WM server adapter. Auth/transport holders stay private and are never exported. */
const WmServerStorage = (() => {
  "use strict";
  const C = typeof WmStorageContracts !== "undefined" ? WmStorageContracts : require("./wm-storage-contracts.source.js");
  const R = typeof WmStorageRouter !== "undefined" ? WmStorageRouter : require("./wm-storage-router.source.js");
  const clone = v => JSON.parse(JSON.stringify(v)), utf8 = v => (new TextEncoder).encode(v), stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v);
  const token = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v), digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v), exact = R.exactData;
  const error = reason => {
    throw Object.assign(Error(reason), {
      code: reason
    });
  };
  const REQUIRED = [ "atomic_expected_head_publish", "immutable_verified_generations", "durable_nonreusable_epochs", "all_writer_ownership", "healthy_head_certifies_generation", "atomic_acquire_and_pin", "reader_retention", "commit_status_reconciliation", "atomic_healthy_head_set_observation" ];
  const LEASE_KEYS = [ "schema", "pinId", "nonce", "bootId", "bootGeneration", "authorityId", "storeId", "datasetId", "backendId", "scope", "generationId", "routeGeneration", "writerEpoch", "issuedAt", "expiresAt" ];
  function createWmServerBackend({transport: transport, connection: connection, limits: limits = {}, journal: journal} = {}) {
    if (!transport || typeof transport.request !== "function" || !exact(connection, [ "identity", "route", "writerEpoch", "incarnation", "limits" ]) || !C.validateRoute(connection.route).ok || connection.route.mode !== "server_only" || !token(connection.writerEpoch) || !token(connection.incarnation) || !exact(connection.identity, [ "authorityId", "storeId", "datasetId", "backendId", "routeGeneration", "writerEpoch" ]) || Object.values(connection.identity).some(v => !token(v)) || !journal || typeof journal.begin !== "function" || typeof journal.get !== "function") error("server_options_invalid");
    const trusted = clone(connection), identity = trusted.identity, route = trusted.route;
    const cap = {
      ...trusted.limits
    };
    if (!R.plainData(limits)) error("limits_invalid");
    for (const [k, v] of Object.entries(limits)) {
      if (!Object.hasOwn(cap, k) || !Number.isSafeInteger(v) || v < 1) error("limits_invalid");
      cap[k] = Math.min(cap[k], v);
    }
    if (Object.values(cap).some(v => !Number.isSafeInteger(v) || v < 1)) error("limits_invalid");
    let negotiated = false, negotiating = null, pagedProfile = false;
    const newPrepared = new Set;
    const leases = new Map, reads = new WeakMap, contexts = new WeakMap, defaultOwner = Object.freeze({});
    const uncertain = (id, fp) => ({
      status: "uncertain",
      operationId: id,
      requestFingerprint: fp
    });
    function validHead(h, scope) {
      return C.validateHead(h).ok && h.authorityId === identity.authorityId && h.storeId === identity.storeId && h.scope === scope && h.utf8Bytes <= cap.maxCanonicalBytes;
    }
    function validLease(l) {
      return exact(l, LEASE_KEYS) && l.schema === "wm.pin-lease.v1" && LEASE_KEYS.filter(k => ![ "schema", "scope", "issuedAt", "expiresAt" ].includes(k)).every(k => token(l[k])) && l.authorityId === identity.authorityId && l.storeId === identity.storeId && l.datasetId === identity.datasetId && l.backendId === identity.backendId && l.routeGeneration === route.routeGeneration && typeof l.scope === "string" && Number.isSafeInteger(l.issuedAt) && Number.isSafeInteger(l.expiresAt) && l.expiresAt > l.issuedAt;
    }
    async function call(action, body = {}, method = "POST") {
      if (!R.plainData(body) || utf8(stable(body)).length > cap.maxBodyBytes) error("body_invalid");
      const requestId = "request-" + globalThis.crypto.randomUUID(), path = "/v1/wm/" + action;
      const packet = await transport.request({
        method: method,
        path: path,
        body: clone(body),
        owner: "wm",
        requestId: requestId
      });
      // sender and incarnation are authenticated IPC/transport metadata, never JSON body claims.
            if (!exact(packet, [ "response", "sender", "incarnation" ]) || !exact(packet.sender, [ "owner", "pluginId", "backendId" ]) || packet.sender.owner !== "wm" || packet.sender.pluginId !== C.PLUGIN_ID || packet.sender.backendId !== identity.backendId || packet.incarnation !== trusted.incarnation) error("sender_identity_invalid");
      const response = packet.response;
      if (!exact(response, [ "schema", "requestId", "action", "owner", "payload" ]) || response.schema !== "wm.ipc-response.v1" || response.owner !== "wm" || response.requestId !== requestId || response.action !== action || !exact(response.payload, [ "statusCode", "body" ]) || !Number.isSafeInteger(response.payload.statusCode)) error("response_invalid");
      if (utf8(stable(response.payload.body)).length > cap.maxBodyBytes) error("response_limit");
      const b = response.payload.body;
      if (response.payload.statusCode !== 200 || b?.ok !== true) {
        if (!exact(b, [ "ok", "error" ], [ "operationId", "requestFingerprint", "uncertain" ]) || b.ok !== false || typeof b.error !== "string" || !/^wm_[a-z0-9_]+$/.test(b.error)) error("response_invalid");
        throw Object.assign(Error(b.error), {
          code: b.error,
          operationId: b.operationId,
          requestFingerprint: b.requestFingerprint,
          uncertain: b.uncertain
        });
      }
      if (!exact(b, [ "ok", "result" ])) error("response_invalid");
      return b.result;
    }
    async function checkConnection() {
      const c = await call("capabilities", {}, "GET");
      if (!exact(c, [ "schema", "owner", "protocol", "backendId", "limits", "storage", "inventory", "externalFenceVerification" ]) || c.schema !== "wm.service-capabilities.v1" || c.owner !== "wm" || c.protocol !== C.PROTOCOL || c.backendId !== identity.backendId || c.storage !== true || !exact(c.inventory, [ "chunkReads", "put", "partialChunkUpload", "migrationStaging" ]) || c.inventory.chunkReads !== true || c.inventory.put !== "complete_payload_only" || c.inventory.partialChunkUpload !== false || typeof c.externalFenceVerification !== "boolean") error("capabilities_invalid");
      for (const k of Object.keys(cap)) {
        if (!Number.isSafeInteger(c.limits?.[k]) || c.limits[k] < 1) error("capabilities_invalid");
        cap[k] = Math.min(cap[k], c.limits[k]);
      }
      negotiated = true;
      // Authentication/transport holders and activation capability remain private.
      return {ok:true,backendId:identity.backendId,protocol:C.PROTOCOL,limits:clone(cap)};
    }
    async function connect() {
      if (negotiated) return {ok:true};
      if (negotiating) return negotiating;
      negotiating = checkConnection();
      try { return await negotiating; } finally { negotiating = null; }
    }
    function routeCheck(v) {
      if (!R.routeEqual(v || route, route)) error("route_changed");
    }
    async function dataset() {
      await connect();
      const s = await call(pagedProfile?"history/state":"dataset/status", {}, pagedProfile?"POST":"GET");
      if (!exact(s, [ "schema", "available", "initialized", "closed" ], [ "reason", "dataset" ]) || s.schema !== "wm.service-status.v1" || s.available !== true || s.closed !== false) error("server_unavailable");
      if (s.initialized) {
        const d = s.dataset;
        if (!exact(d, [ "identity", "route", "writerEpoch", "inventoryRevision", "health" ]) || !exact(d.identity, [ "authorityId", "storeId", "datasetId", "backendId" ]) || Object.keys(d.identity).some(k => d.identity[k] !== identity[k]) || !R.routeEqual(d.route, route) || !token(d.writerEpoch) || !token(d.inventoryRevision) || !exact(d.health, [ "ok" ]) || d.health.ok !== true) error("dataset_identity_changed");
        return d;
      }
      return {
        writerEpoch: trusted.writerEpoch,
        inventoryRevision: "inventory-0",
        route: route
      };
    }
    function statusValid(s,id,fp,entry){
      if(!C.validateOperationStatus(s).ok||s.operationId!==id||s.requestFingerprint!==fp)return false;
      if(s.status!=='committed')return true;const ref=entry?.reference;
      if(ref?.kind==='inventory')return exact(s.receipt,['inventoryRevision','writerEpoch','routeGeneration','items','bytes'])&&token(s.receipt.inventoryRevision)&&s.receipt.inventoryRevision!==ref.expectedInventoryRevision&&s.receipt.writerEpoch===ref.writerEpoch&&s.receipt.routeGeneration===ref.routeGeneration&&s.receipt.items===ref.items&&s.receipt.bytes===ref.bytes;
      if(ref?.kind==='initialize')return exact(s.receipt,['head'])&&validHead(s.receipt.head,ref.scope)&&s.receipt.head.tombstone===true&&s.receipt.head.epoch===ref.writerEpoch;
      if(ref?.scope){if(!exact(s.receipt,['head'])||!validHead(s.receipt.head,ref.scope)||s.receipt.head.generationId!==ref.generationId||s.receipt.head.sha256!==ref.rawSha256)return false;return !ref.prepared||R.headEqual(s.receipt.head,ref.prepared.head);}
      return false;
    }
    async function operationStatus(v){
      if(!exact(v,['operationId','requestFingerprint'])||!token(v.operationId)||!digest(v.requestFingerprint))error('status_invalid');
      try{const entry=await journal.get(v.operationId);if(!entry||entry.requestFingerprint!==v.requestFingerprint)return uncertain(v.operationId,v.requestFingerprint);await connect();const s=await call('snapshot/status',v);
        if(!statusValid(s,v.operationId,v.requestFingerprint,entry))return uncertain(v.operationId,v.requestFingerprint);await journal.settle({operationId:v.operationId,status:s});return s;
      }catch{return uncertain(v.operationId,v.requestFingerprint);}
    }
    async function initializeScope(v){
      let operationId,requestFingerprint;
      try{if(!exact(v,['route','scope','operationId','expectedEmpty'],['handle'])||v.expectedEmpty!==true||!token(v.operationId))error('initialize_invalid');
        const owner=v.handle||defaultOwner;const {handle:_,...plainInput}=v;v=clone(plainInput);operationId=v.operationId;routeCheck(v.route);
        const old=await journal.get(operationId);let s;
        if(old){requestFingerprint=old.requestFingerprint;if(!old.reference){await operationStatus({operationId,requestFingerprint});return {ok:false,reason:'initialize_uncertain',uncertain:true,operationId,requestFingerprint};}if(!R.routeEqual(old.route,route)||old.reference.kind!=='initialize'||old.reference.scope!==v.scope)error('operation_identity_conflict');s=await operationStatus({operationId,requestFingerprint});}
        else{const state=await dataset(),input={scope:v.scope,operationId,routeGeneration:route.routeGeneration,writerEpoch:state.writerEpoch,expectedEmpty:true};requestFingerprint=await C.fingerprintRequest(input);input.requestFingerprint=requestFingerprint;
          const reference={kind:'initialize',scope:v.scope,routeGeneration:route.routeGeneration,writerEpoch:state.writerEpoch};await journal.begin({operationId,requestFingerprint,expectedHead:null,route});await journal.bind({operationId,reference});
          try{s=await call('snapshot/initialize',input);}catch{s=uncertain(operationId,requestFingerprint);}if(!statusValid(s,operationId,requestFingerprint,{reference}))s=uncertain(operationId,requestFingerprint);await journal.settle({operationId,status:s});
        }
        if(s.status!=='committed'||!validHead(s.receipt?.head,v.scope))return {ok:false,reason:s.status,uncertain:s.status==='uncertain',operationId,requestFingerprint};
        const read=await readCanonical({handle:owner,scope:v.scope,route});return read.ok&&R.headEqual(read.head,s.receipt.head)?{...read,operationId,requestFingerprint}:{ok:false,reason:'initialized_source_changed',uncertain:true,operationId,requestFingerprint};
      }catch(e){return {ok:false,reason:e.code==='operation_identity_conflict'?'operation_identity_conflict':'initialize_uncertain',...e.code==='operation_identity_conflict'?{}:{uncertain:true},...operationId?{operationId}:{},...requestFingerprint?{requestFingerprint}:{}};}
    }
    async function readInventoryState(v={}){
      if(!exact(v,[],['handle','route']))return {ok:false,reason:'input_invalid'};
      try{routeCheck(v.route||route);const state=await dataset();return {ok:true,routeGeneration:state.route.routeGeneration,writerEpoch:state.writerEpoch,inventoryRevision:state.inventoryRevision};}catch{return {ok:false,reason:'server_unavailable'};}
    }
    async function prepare(input) {
      await connect();
      if (exact(input, [ "scope", "expectedHead", "raw", "operation", "operationId", "rawSha256" ])) {
        if (!validHead(input.expectedHead, input.scope) || !token(input.operationId) || !C.WRITER_OPERATIONS.includes(input.operation) || await C.hashBytes(utf8(input.raw ?? "")) !== input.rawSha256) error("write_invalid");
        const prior=await journal.get(input.operationId),intentFingerprint=await C.fingerprintRequest({scope:input.scope,expectedHead:input.expectedHead,rawSha256:input.rawSha256,operation:input.operation});
        if(prior){if(prior.reference?.intentFingerprint!==intentFingerprint)error('operation_identity_conflict');if(prior.reference.prepared)return clone(prior.reference.prepared);throw Object.assign(Error('prepare_uncertain'),{uncertain:true,operationId:input.operationId,requestFingerprint:prior.requestFingerprint});}
        const writerState=await readInventoryState();if(!writerState.ok)error('server_unavailable');const generationId="generation-"+globalThis.crypto.randomUUID();
        const manifest = {
          schema: C.MANIFEST_SCHEMA,
          scope: input.scope,
          generationId: generationId,
          canonical: {
            sha256: input.rawSha256,
            utf8Bytes: utf8(input.raw ?? "").length
          },
          items: [],
          routeGeneration: route.routeGeneration,
          writerEpoch: writerState.writerEpoch,
          expectedHead: input.expectedHead,
          operationId: input.operationId
        };
        manifest.manifestDigest = await C.manifestDigest(manifest);
        const {rawSha256: _, ...base} = input;
        input = {
          ...base,
          routeGeneration: route.routeGeneration,
          writerEpoch: writerState.writerEpoch,
          manifest: manifest
        };
        input.requestFingerprint = await C.fingerprintRequest(input);
      }
      if (!C.validateOperation(input).ok || await C.fingerprintRequest(input) !== input.requestFingerprint || input.routeGeneration !== route.routeGeneration || !validHead(input.expectedHead, input.scope)) error("write_invalid");
      if (utf8(input.raw ?? "").length > cap.maxCanonicalBytes) error("canonical_limit");
      const old = await journal.get(input.operationId);
      if (old) {
        if (old.requestFingerprint !== input.requestFingerprint) error("operation_identity_conflict");
        const status = await operationStatus({
          operationId: input.operationId,
          requestFingerprint: input.requestFingerprint
        });
        if(input.manifest.schema!==C.ROOT_MANIFEST_SCHEMA){
          if (old.reference?.prepared) return clone(old.reference.prepared);
          throw Object.assign(Error("prepare_uncertain"), {uncertain:true,operationId:input.operationId,requestFingerprint:input.requestFingerprint});
        }
        if(status.status==='committed'||status.status==='conflict')throw Object.assign(Error('prepare_terminal'),{operationId:input.operationId,requestFingerprint:input.requestFingerprint});
      }
      await journal.begin({
        operationId: input.operationId,
        requestFingerprint: input.requestFingerprint,
        expectedHead: input.expectedHead,
        route: route
      });
      const reference = {
        scope: input.scope,
        operation: input.operation,
        rawSha256: input.manifest.canonical.sha256,
        generationId: input.manifest.generationId,
        manifestDigest: input.manifest.manifestDigest,
        ...(input.manifest.schema===C.ROOT_MANIFEST_SCHEMA?{rootManifest:clone(input.manifest)}:{}),
        intentFingerprint: await C.fingerprintRequest({
          scope: input.scope,
          expectedHead: input.expectedHead,
          rawSha256: input.manifest.canonical.sha256,
          operation: input.operation
        })
      };
      await journal.bind({
        operationId: input.operationId,
        reference: reference
      });
      try {
        const p = await call("snapshot/prepare", input);
        if (!R.safePrepared(p) || p.operationId !== input.operationId || p.requestFingerprint !== input.requestFingerprint || p.scope !== input.scope || p.operation !== input.operation || p.rawSha256 !== reference.rawSha256 || !R.headEqual(p.expectedHead, input.expectedHead) || !validHead(p.head, input.scope) || p.head.generationId !== input.manifest.generationId || p.head.sha256 !== reference.rawSha256 || p.head.utf8Bytes !== input.manifest.canonical.utf8Bytes || p.head.tombstone !== (input.raw === null)) error("prepared_invalid");
        await journal.bind({
          operationId: input.operationId,
          reference: {
            ...reference,
            prepared: p
          }
        });
        await journal.settle({
          operationId: input.operationId,
          status: {
            status: "prepared",
            operationId: input.operationId,
            requestFingerprint: input.requestFingerprint,
            receipt: {
              preparedId: p.preparedId
            }
          }
        });
        newPrepared.add(p.operationId);
        return p;
      } catch (e) {
        try{await journal.settle({operationId:input.operationId,status:uncertain(input.operationId,input.requestFingerprint)});}catch{}
        throw Object.assign(Error("prepare_uncertain"), {
          uncertain: true,
          operationId: input.operationId,
          requestFingerprint: input.requestFingerprint
        });
      }
    }
    const publishing = new Map;
    async function publish(p) {
      if (!R.safePrepared(p)) error("prepared_invalid");
      const old = await journal.get(p.operationId);
      if (!old || old.requestFingerprint !== p.requestFingerprint || !old.reference?.prepared || stable(old.reference.prepared) !== stable(p)) error("prepared_identity_conflict");
      if (publishing.has(p.operationId)) return publishing.get(p.operationId);
      if (!newPrepared.delete(p.operationId)) return operationStatus({
        operationId: p.operationId,
        requestFingerprint: p.requestFingerprint
      });
      const work = (async () => {
        try {
          const s = await call("snapshot/publish", p);
          if (!statusValid(s, p.operationId, p.requestFingerprint,old) || s.status === "committed" && !R.headEqual(s.receipt?.head, p.head)) return operationStatus({
            operationId: p.operationId,
            requestFingerprint: p.requestFingerprint
          });
          await journal.settle({
            operationId: p.operationId,
            status: s
          });
          return s;
        } catch {
          return operationStatus({
            operationId: p.operationId,
            requestFingerprint: p.requestFingerprint
          });
        }
      })();
      publishing.set(p.operationId, work);
      try {
        return await work;
      } finally {
        publishing.delete(p.operationId);
      }
    }
    async function publishBundle(v) {
      if (!exact(v, [ ...C.DTO_KEYS.WriteInput, "route" ])) return {
        ok: false,
        reason: "input_invalid"
      };
      v = clone(v);
      const id = v?.operationId, fp = v?.requestFingerprint;
      try {
        routeCheck(v.route);
        const {route: _, ...input} = v;
        if (!C.validateOperation(input).ok || await C.fingerprintRequest(input) !== fp) error("write_invalid");
        const old = await journal.get(id);
        if (old) {
          if (old.requestFingerprint !== fp) error("operation_identity_conflict");
          const status=await operationStatus({operationId:id,requestFingerprint:fp});
          if(input.manifest.schema!==C.ROOT_MANIFEST_SCHEMA||status.status==='committed'||status.status==='conflict')return status;
          const prepared=await prepare(input);return publish(prepared);
        }
        await dataset();
        const p = await prepare(input);
        return await publish(p);
      } catch (e) {
        return {
          status: e.uncertain ? "uncertain" : "conflict",
          operationId: id,
          requestFingerprint: fp
        };
      }
    }
    async function acquire(scope) {
      await connect();
      const a = await call("snapshot/acquire", {
        scope: scope
      });
      if (!exact(a, [ "head", "lease", "manifestDigest" ]) || !validHead(a.head, scope) || !validLease(a.lease) || a.lease.scope !== scope || a.lease.generationId !== a.head.generationId || !digest(a.manifestDigest)) error("acquire_invalid");
      leases.set(a.lease.pinId, clone(a.lease));
      return a;
    }
    async function readGeneration(lease) {
      if (!validLease(lease) || !leases.has(lease.pinId)) error("lease_invalid");
      const v = await call("snapshot/read", {
        lease: lease
      });
      if (!exact(v, [ "raw" ]) || !(v.raw === null || typeof v.raw === "string")) error("generation_invalid");
      return v.raw;
    }
    async function head(scope, lease) {
      if (!validLease(lease) || !leases.has(lease.pinId)) error("lease_invalid");
      const v = await call("snapshot/head", {
        scope: scope,
        lease: lease
      });
      if (!exact(v, [ "head", "leaseValid" ]) || v.leaseValid !== true || !validHead(v.head, scope)) error("head_invalid");
      return v;
    }
    async function release(lease) {
      if (!validLease(lease)) error("lease_invalid");
      const v = await call("snapshot/release", {
        lease: lease
      });
      if (!exact(v, [ "released" ]) || v.released !== true) error("release_invalid");
      leases.delete(lease.pinId);
    }
    async function observeHeads(scopes, options = {}) {
      if (!R.plainData(scopes) || !exact(options, [ "leases" ])) error("observation_invalid");
      const owned = options.leases;
      if (!Array.isArray(scopes) || !Array.isArray(owned) || scopes.length !== owned.length || owned.some(l => !validLease(l) || !leases.has(l.pinId))) error("lease_required");
      const result = await call("snapshot/observe", {
        scopes: scopes,
        leases: owned
      });
      if (!Array.isArray(result) || result.length !== scopes.length || new Set(result.map(h => h.scope)).size !== scopes.length || scopes.some(s => !result.some(h => validHead(h, s)))) error("observation_invalid");
      return result;
    }
    async function readCanonical(v) {
      if (!exact(v, [ "scope" ], [ "handle", "route" ])) return {
        ok: false,
        reason: "input_invalid"
      };
      const {handle: handle = defaultOwner, route: requested = route, scope: scope} = v;
      let acquired;
      try {
        routeCheck(requested);
        await dataset();
        let cut = contexts.get(handle);
        if (!cut) {
          cut = new Map;
          contexts.set(handle, cut);
        }
        if (cut.has(scope)) {
          const old = cut.get(scope), h = await head(scope, old.lease);
          return R.headEqual(h.head, old.head) ? {
            ok: true,
            raw: old.raw,
            head: old.head,
            sourceToken: old.sourceToken,
            manifestDigest: old.manifestDigest
          } : {
            ok: false,
            reason: "source_changed"
          };
        }
        acquired = await acquire(scope);
        const raw = await readGeneration(acquired.lease), bytes = utf8(raw ?? "");
        if (acquired.head.tombstone ? raw !== null : typeof raw !== "string") error("generation_invalid");
        if (bytes.length !== acquired.head.utf8Bytes || await C.hashBytes(bytes) !== acquired.head.sha256) error("generation_invalid");
        const fresh = await head(scope, acquired.lease);
        if (!R.headEqual(fresh.head, acquired.head)) error("source_changed");
        const sourceToken = Object.freeze({});
        reads.set(sourceToken, {
          lease: acquired.lease,
          handle: handle
        });
        const item = {
          ...acquired,
          raw: raw,
          sourceToken: sourceToken
        };
        cut.set(scope, item);
        return {
          ok: true,
          raw: raw,
          head: acquired.head,
          sourceToken: sourceToken,
          manifestDigest: acquired.manifestDigest
        };
      } catch {
        if (acquired?.lease) try {
          await release(acquired.lease);
        } catch {}
        return {
          ok: false,
          reason: "server_unavailable"
        };
      }
    }
    // B3 uses the authenticated complete inventory cut to recover exactly the
    // companion closure named by the observed canonical descriptor. No new wire API.
    async function readBundleItems(v) {
      if(!R.dataProperties(v,['handle','scope','sourceToken','head','route']))return {ok:false,reason:'input_invalid'};
      const bound=reads.get(v.sourceToken);if(!bound||bound.handle!==v.handle||!R.headEqual(contexts.get(v.handle)?.get(v.scope)?.head,v.head))return {ok:false,reason:'source_token_required'};
      let snapshotId;
      try {
        routeCheck(v.route);await connect();const roots=await call('snapshot/roots',{lease:bound.lease});if(roots.manifest?.schema===C.ROOT_MANIFEST_SCHEMA)return {ok:false,reason:'root_bundle_requires_pagination'};const snap=await call('inventory/open',{routeGeneration:route.routeGeneration});
        if(!exact(snap,C.DTO_KEYS.InventorySnapshot)||snap.routeGeneration!==route.routeGeneration||snap.complete!==true||!token(snap.snapshotId)||!C.validateDomainTotals(snap.domainCounts).ok||!C.validateDomainTotals(snap.domainBytes).ok)error('inventory_incomplete');
        snapshotId=snap.snapshotId;const rows=new Map();let cursor=null,count=0;
        do {const page=await call('inventory/page',{snapshotId,cursor,maxItems:cap.maxPageItems,maxBytes:cap.maxPageBytes});
          if(!exact(page,C.DTO_KEYS.InventoryPage)||page.snapshotId!==snapshotId||page.complete!==true||!Array.isArray(page.items)||!Array.isArray(page.errors)||page.errors.length||page.items.length>cap.maxPageItems||page.nextCursor!==null&&!token(page.nextCursor))error('inventory_incomplete');
          for(const d of page.items){if(!exact(d,C.DTO_KEYS.Item)||rows.has(d.logicalId)||++count>cap.maxInventoryItems)error('inventory_invalid');if(d.domain!=='canonical'&&!C.validateItem(d).ok)error('inventory_invalid');rows.set(d.logicalId,d);}
          cursor=page.nextCursor;
        }while(cursor!==null);
        const canonical=rows.get('canonical-'+await C.hashBytes(utf8(v.scope)));
        if(!canonical||canonical.domain!=='canonical'||canonical.originScope!==v.scope||canonical.sha256!==v.head.sha256||canonical.bytes!==v.head.utf8Bytes||canonical.disposition?.tombstone!==v.head.tombstone||!Array.isArray(canonical.dependencies))error('source_changed');
        const items=canonical.dependencies.map(id=>rows.get(id));if(items.some(d=>!d||d.domain==='canonical'))error('dependency_missing');
        const fresh=await current({handle:v.handle,route:v.route});if(!fresh.ok)return fresh;
        return {ok:true,items:clone(items)};
      }catch{return {ok:false,reason:'bundle_items_unavailable'};}
      finally{if(snapshotId)await call('inventory/close',{snapshotId}).catch(()=>{});}
    }

    async function reconcileHistoryWrite({scope,raw,operation,operationId,expectedHead,dependencyRoots,hasNewCompanions}){
      if(!pagedProfile)return {ok:true,found:false};if(!validHead(expectedHead,scope)||!token(operationId)||!Array.isArray(dependencyRoots)||dependencyRoots.length>32||!dependencyRoots.every(token)||typeof hasNewCompanions!=='boolean')return {ok:false,reason:'history_recovery_input_invalid'};
      const rawSha256=await C.hashBytes(utf8(raw??'')),pending=(await journal.pending()).filter(e=>e.reference?.rootManifest&&e.reference.scope===scope&&e.reference.operation===operation&&e.reference.rawSha256===rawSha256);
      const candidates=pending.filter(e=>e.operationId===operationId&&R.headEqual(e.expectedHead,expectedHead)&&stable(e.reference.rootManifest.dependencyRoots)===stable(dependencyRoots)||!hasNewCompanions&&e.reference?.prepared&&R.headEqual(e.reference.prepared.head,expectedHead));
      if(!candidates.length&&!hasNewCompanions&&pending.some(e=>R.headEqual(e.expectedHead,expectedHead)))return {ok:false,reason:'history_recovery_candidate_changed'};
      if(!candidates.length)return {ok:true,found:false};if(candidates.length!==1)return {ok:false,reason:'history_recovery_ambiguous'};const entry=candidates[0],m=entry.reference.rootManifest;
      const input={operationId:entry.operationId,operation,scope,expectedHead:entry.expectedHead,routeGeneration:m.routeGeneration,writerEpoch:m.writerEpoch,raw,manifest:m,requestFingerprint:entry.requestFingerprint,route};
      if(!C.validateOperation(Object.fromEntries(Object.entries(input).filter(([k])=>k!=='route'))).ok)return {ok:false,reason:'history_recovery_identity_conflict'};
      return {found:true,result:await publishBundle(input)};
    }
    async function findCompanions(v){
      if(!R.dataProperties(v,['handle','scope','sourceToken','schema','cursor']))error('input_invalid');const bound=reads.get(v.sourceToken);if(!bound||bound.handle!==v.handle||bound.lease.scope!==v.scope)error('source_token_required');const page=await call('snapshot/find',{lease:bound.lease,schema:v.schema,cursor:v.cursor,maxItems:16,maxBytes:65536});
      if(!exact(page,['generationId','manifestDigest','items','nextCursor'])||page.generationId!==bound.lease.generationId||!digest(page.manifestDigest)||!Array.isArray(page.items)||page.items.length>16||page.items.some(d=>!C.validateItem(d).ok||d.schema!==v.schema)||page.nextCursor!==null&&(typeof page.nextCursor!=='string'||!/^(0|[1-9][0-9]*)$/.test(page.nextCursor)))error('companion_page_invalid');return {ok:true,...page};
    }
    async function enableHistoryProfile(profile) {
      if(profile!=='server-pinned-roots-v2')error('history_profile_invalid');await connect();const caps=await call('history/capabilities');
      if(!exact(caps,['schema','profile','enabled','pageBytes','rootCount','stageTtlMs','runtimeActivation'])||caps.schema!=='wm.paged-history-capabilities.v2'||caps.profile!==profile||caps.enabled!==true||caps.pageBytes!==65536||caps.rootCount!==32||caps.stageTtlMs!==300000||caps.runtimeActivation!==false)error('history_server_dependency_roots_unsupported');pagedProfile=true;return {ok:true};
    }
    async function openHistoryOwner(v) {
      if(!R.dataProperties(v,['handle','scope','sourceToken','head','route']))error('input_invalid');
      const bound=reads.get(v.sourceToken);if(!bound||bound.handle!==v.handle||!R.headEqual(contexts.get(v.handle)?.get(v.scope)?.head,v.head))error('source_token_required');
      routeCheck(v.route);await connect();const caps=await call('history/capabilities');
      if(!exact(caps,['schema','profile','enabled','pageBytes','rootCount','stageTtlMs','runtimeActivation'])||caps.schema!=='wm.paged-history-capabilities.v2'||caps.profile!=='server-pinned-roots-v2'||caps.enabled!==true||caps.pageBytes!==65536||caps.rootCount!==32||caps.runtimeActivation!==false)error('history_server_dependency_roots_unsupported');
      const input={operationId:'wm-page-session-'+await C.hashBytes(utf8(stable({scope:v.scope,head:v.head,routeGeneration:route.routeGeneration,writerEpoch:bound.lease.writerEpoch}))),scope:v.scope,expectedHead:clone(v.head),routeGeneration:route.routeGeneration,writerEpoch:bound.lease.writerEpoch};input.requestFingerprint=await C.fingerprintRequest(input);
      let receipt=null,starting=null,renewal=null;
      async function ensureReceipt(){
        if(receipt)return receipt;if(starting)return starting;
        starting=(async()=>{let value;try{value=await call('history/begin',input);}catch(e){throw Object.assign(Error('history_stage_uncertain'),{operationId:input.operationId,requestFingerprint:input.requestFingerprint,uncertain:true});}
          if(!exact(value,['schema','identity',...Object.keys(input),'issuedAt','expiresAt'])||value.schema!=='wm.page-stage-receipt.v1'||Object.keys(input).some(k=>stable(value[k])!==stable(input[k]))||!exact(value.identity,['authorityId','storeId','datasetId','backendId'])||Object.keys(value.identity).some(k=>value.identity[k]!==identity[k])||!Number.isSafeInteger(value.issuedAt)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt-value.issuedAt!==caps.stageTtlMs)error('stage_receipt_invalid');receipt=value;return value;})();
        try{return await starting;}finally{starting=null;}
      }
      async function renewReceipt(){
        if(renewal)return renewal;const previous=receipt;
        renewal=(async()=>{const input={operationId:'wm-page-renew-'+await C.hashBytes(utf8(previous.operationId+':'+previous.requestFingerprint)),scope:v.scope,expectedHead:clone(v.head),routeGeneration:route.routeGeneration,writerEpoch:previous.writerEpoch,previousReceipt:previous};input.requestFingerprint=await C.fingerprintRequest(input);
          const next=await call('history/renew',input);if(!exact(next,['schema','identity','operationId','requestFingerprint','scope','expectedHead','routeGeneration','writerEpoch','issuedAt','expiresAt'])||next.schema!==previous.schema||stable(next.identity)!==stable(previous.identity)||next.operationId!==input.operationId||next.requestFingerprint!==input.requestFingerprint||next.scope!==previous.scope||!R.headEqual(next.expectedHead,previous.expectedHead)||next.routeGeneration!==previous.routeGeneration||next.writerEpoch!==previous.writerEpoch||next.issuedAt<previous.expiresAt||next.expiresAt-next.issuedAt!==caps.stageTtlMs)error('stage_receipt_invalid');receipt=next;})();
        try{return await renewal;}finally{renewal=null;}
      }
      const logical=key=>{if(typeof key!=='string'||!/^wm\.cold\.extension\.eh-[a-f0-9]{64}$/.test(key))error('history_key_invalid');return key.slice('wm.cold.extension.'.length);};
      const active=()=>{if(!contexts.get(v.handle)?.has(v.scope)||!leases.has(bound.lease.pinId))error('request_closed');};
      async function getItem(key){active();const logicalId=logical(key);let offset=0,total=null,hash=null,parts=[],staged=false;
        do{let wire,requestReceipt=null;try{if(staged){await ensureReceipt();requestReceipt=receipt;}wire=await call(staged?'history/read':'snapshot/companion',staged?{receipt:requestReceipt,logicalId,offset,maxBytes:32768}:{lease:bound.lease,logicalId,offset,maxBytes:32768});}
          catch(e){if(offset===0&&!staged&&e.code==='wm_companion_not_in_closure'){staged=true;continue;}if(offset===0&&staged&&e.code==='wm_stage_receipt_expired'){if(receipt===requestReceipt)await renewReceipt();continue;}if(offset===0&&staged&&e.code==='wm_staged_page_missing')return null;throw e;}
          const chunk=decodeChunk(wire,offset,32768);if(chunk.totalBytes>caps.pageBytes||total!==null&&(chunk.totalBytes!==total||chunk.sha256!==hash))error('history_page_limit');total=chunk.totalBytes;hash=chunk.sha256;parts.push(chunk.bytes);offset=chunk.nextOffset;
        }while(offset!==null);
        const bytes=new Uint8Array(total);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}if(at!==total||await C.hashBytes(bytes)!==hash)error('history_page_readback');active();return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      }
      async function setItem(key,value){active();await ensureReceipt();const pageReceipt=receipt,logicalId=logical(key),bytes=utf8(value);if(typeof value!=='string'||bytes.length>caps.pageBytes)error('history_page_limit');let page;try{page=JSON.parse(value);}catch{error('history_page_invalid');}
        const descriptor={domain:'cold',schema:'wm.extension-history-page.v1',logicalId,originScope:v.scope,bytes:bytes.length,sha256:await C.hashBytes(bytes),dependencies:page.dependencies,disposition:null};if(!C.validateItem(descriptor).ok)error('history_page_invalid');
        const input={operationId:'wm-page-'+await C.hashBytes(utf8(pageReceipt.operationId+':'+logicalId)),receipt:pageReceipt,descriptor,payload:{encoding:'base64',data:base64(bytes)}};input.requestFingerprint=await C.fingerprintRequest(input);let out;
        try{out=await call('history/stage',input);}catch(e){throw Object.assign(Error('history_page_uncertain'),{operationId:input.operationId,requestFingerprint:input.requestFingerprint,uncertain:true});}
        if(!C.validateOperationStatus(out).ok||out.status!=='committed'||out.operationId!==input.operationId||out.requestFingerprint!==input.requestFingerprint||!exact(out.receipt,['schema','stageOperationId','logicalId','sha256','bytes'])||out.receipt.schema!=='wm.page-stage-item.v1'||out.receipt.stageOperationId!==pageReceipt.operationId||out.receipt.logicalId!==logicalId||out.receipt.sha256!==descriptor.sha256||out.receipt.bytes!==descriptor.bytes)error('history_page_receipt_invalid');active();
      }
      return Object.freeze({profile:'server-pinned-roots-v2',getItem,setItem});
    }
    async function current(v = {}) {
      if (!exact(v, [], [ "handle", "route" ])) return {
        ok: false,
        reason: "input_invalid"
      };
      const {handle: handle = defaultOwner, route: requested = route} = v;
      try {
        routeCheck(requested);
        await dataset();
        const cut = contexts.get(handle);
        if (!cut?.size) return {
          ok: true
        };
        const expected = [ ...cut.values() ], observed = await observeHeads(expected.map(v => v.head.scope), {
          leases: expected.map(v => v.lease)
        });
        return expected.every(v => observed.some(h => R.headEqual(h, v.head))) ? {
          ok: true
        } : {
          ok: false,
          reason: "source_changed"
        };
      } catch {
        return {
          ok: false,
          reason: "server_unavailable"
        };
      }
    }
    async function closeRequest(v = {}) {
      if (!exact(v, [], [ "handle" ])) return {
        ok: false,
        reason: "input_invalid"
      };
      const {handle: handle = defaultOwner} = v;
      const cut = contexts.get(handle);
      if (!cut) return {
        ok: true
      };
      let ok = true;
      for (const [scope, v] of cut) {
        try {
          await release(v.lease);
          reads.delete(v.sourceToken);
          cut.delete(scope);
        } catch {
          ok = false;
        }
      }
      if (!cut.size) contexts.delete(handle);
      return {
        ok: ok,
        ...ok ? {} : {
          reason: "release_unconfirmed"
        }
      };
    }
    async function readCompanion(v) {
      if (!exact(v, [ "lease", "logicalId", "offset", "maxBytes" ], [ "handle", "route" ]) || !token(v.logicalId) || !Number.isSafeInteger(v.offset) || v.offset < 0 || !Number.isSafeInteger(v.maxBytes) || v.maxBytes < 1) error("chunk_invalid");
      let lease = v.lease;
      const bound = reads.get(lease);
      if (bound) {
        if (v.handle && bound.handle !== v.handle) error("source_token_invalid");
        lease = bound.lease;
      }
      if (!validLease(lease) || !leases.has(lease.pinId)) error("lease_invalid");
      const maxBytes = Math.min(v.maxBytes, cap.maxChunkBytes), wire = await call("snapshot/companion", {
        lease: lease,
        logicalId: v.logicalId,
        offset: v.offset,
        maxBytes: maxBytes
      });
      return decodeChunk(wire, v.offset, maxBytes);
    }
    function decodeChunk(wire, offset, maxBytes) {
      if (!exact(wire, [ "encoding", "data", "offset", "nextOffset", "totalBytes", "sha256" ]) || wire.encoding !== "base64" || typeof wire.data !== "string" || !digest(wire.sha256) || wire.offset !== offset || !Number.isSafeInteger(wire.totalBytes) || wire.totalBytes < offset || wire.data.length > 4 * Math.ceil(maxBytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wire.data)) error("chunk_invalid");
      const text = globalThis.atob ? atob(wire.data) : Buffer.from(wire.data, "base64").toString("binary"), bytes = Uint8Array.from(text, c => c.charCodeAt(0));
      const encoded = base64(bytes);
      if (encoded !== wire.data || bytes.length > maxBytes || offset > Number.MAX_SAFE_INTEGER - bytes.length || offset + bytes.length > wire.totalBytes || wire.nextOffset !== (offset + bytes.length === wire.totalBytes ? null : offset + bytes.length)) error("chunk_invalid");
      return {
        bytes: bytes,
        offset: offset,
        nextOffset: wire.nextOffset,
        totalBytes: wire.totalBytes,
        sha256: wire.sha256
      };
    }
    function base64(bytes) {
      let result = "";
      for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return globalThis.btoa ? btoa(result) : Buffer.from(bytes).toString("base64");
    }
    async function appendRaw(v) {
      if (!R.dataProperties(v, [ "record" ], [ "route", "handle" ])) return {
        ok: false,
        reason: "input_invalid"
      };
      let {route: requested = route, record: record} = v;
      let id,fp,dispatched=false;
      try {
        routeCheck(requested);
        record = R.copyInventory(record);
        id = record.operationId;
        fp = record.requestFingerprint;
        const top = Object.getOwnPropertyDescriptors(record || {});
        if (!record || Reflect.ownKeys(record).some(k => typeof k !== "string" || !top[k].enumerable || !Object.hasOwn(top[k], "value")) || Object.keys(top).sort().join(",") !== C.DTO_KEYS.InventoryWrite.slice().sort().join(",")) error("inventory_invalid");
        const items = [];
        for (const x of record.items) {
          if (!x || !C.validateItem(x.descriptor).ok || !(x.payload instanceof Uint8Array) || x.payload.byteLength > cap.maxChunkBytes || await C.hashBytes(x.payload) !== x.descriptor.sha256 || x.payload.byteLength !== x.descriptor.bytes) error("complete_payload_limit");
          items.push({
            descriptor: clone(x.descriptor),
            payload: {
              encoding: "base64",
              data: base64(x.payload),
              offset: 0,
              totalBytes: x.payload.byteLength,
              sha256: x.descriptor.sha256
            }
          });
        }
        const projection = {
          ...record,
          items: items.map(x => ({
            descriptor: x.descriptor,
            payload: {
              encoding: "base64",
              data: x.payload.data
            }
          }))
        };
        if (await C.fingerprintRequest(projection) !== fp) error("operation_identity_conflict");
        const old = await journal.get(id);
        if (old) {
          if (old.requestFingerprint !== fp) error("operation_identity_conflict");
          return operationStatus({
            operationId: id,
            requestFingerprint: fp
          });
        }
        await dataset();
        await journal.begin({
          operationId: id,
          requestFingerprint: fp,
          expectedHead: null,
          route: route
        });
        const reference={kind:'inventory',routeGeneration:record.routeGeneration,writerEpoch:record.writerEpoch,expectedInventoryRevision:record.expectedInventoryRevision,items:items.length,bytes:items.reduce((n,x)=>n+x.payload.totalBytes,0)};
        await journal.bind({operationId:id,reference});let s;
        try {dispatched=true;
          s = await call("inventory/put", {
            ...record,
            items: items
          });
        } catch {
          s = await operationStatus({
            operationId: id,
            requestFingerprint: fp
          });
        }
        if (!statusValid(s,id,fp,{reference}))s=uncertain(id,fp);
        await journal.settle({
          operationId: id,
          status: s
        });
        return s;
      }catch{return {status:dispatched?'uncertain':'conflict',operationId:id,requestFingerprint:fp};}
    }
    const updateRawHistory = v => {
      if (!R.dataProperties(v, [ "recordId", "history" ], [ "route", "handle" ])) return Promise.resolve({
        ok: false,
        reason: "input_invalid"
      });
      try {
        const history = R.copyInventory(v.history);
        if (!token(v.recordId) || !history.items.every(x => x.descriptor.domain === "raw_history" && x.descriptor.dependencies.includes(v.recordId))) throw Error("history_identity_invalid");
        return appendRaw({
          route: v.route || route,
          record: history
        });
      } catch {
        return Promise.resolve({
          ok: false,
          reason: "history_identity_invalid"
        });
      }
    };
    async function status(id, fp) {
      const e = await journal.get(id);
      if (!e) return {
        status: "uncertain",
        operationId: id,
        requestFingerprint: fp
      };
      const s = await operationStatus({
        operationId: id,
        requestFingerprint: fp || e.requestFingerprint
      });
      if (s.status !== "committed" || !e.reference?.prepared) return s;
      return {
        ...s,
        operation: e.reference.operation,
        scope: e.reference.scope,
        rawSha256: e.reference.rawSha256,
        expectedHead: e.expectedHead,
        head: s.receipt.head
      };
    }
    // C1 actions are authenticated WM-owner calls. The service separately requires
    // default-disabled activation and a trusted synchronous pending-fence verifier.
    const handoff=async(method,v={})=>{await connect();if(!['capabilities','begin','chunk','stageStatus','verifyStage','materialize','readback','complete','status','abort','rollback'].includes(method))error('handoff_method_invalid');
      if(method==='chunk'){const {bytes,...input}=v,owned=R.copyBytes(bytes);if(owned.length>Math.min(262144,cap.maxMigrationChunkBytes))error('handoff_chunk_limit');return call('handoff/chunk',{...input,payload:{encoding:'base64',data:base64(owned)}});}return call('handoff/'+method,v);};
    const migrationLimits=async()=>{await connect();return {maxChunkBytes:Math.min(cap.maxChunkBytes,cap.maxMigrationChunkBytes),maxPageItems:cap.maxPageItems,maxPageBytes:cap.maxPageBytes};};
    const inspectMigrationDestination=async()=>{await connect();return call('migration/inspect');};
    const beginMigrationStage=async v=>{await connect();return call('migration/begin',v);};
    const migrationStageStatus=async v=>{await connect();return call('migration/status',v);};
    const stageMigrationChunk=async v=>{await connect();const {bytes,...meta}=v;const owned=R.copyBytes(bytes);if(owned.length>Math.min(cap.maxChunkBytes,cap.maxMigrationChunkBytes))error('migration_chunk_limit');return call('migration/chunk',{...meta,payload:{encoding:'base64',data:base64(owned)}});};
    const verifyMigrationStage=v=>call('migration/verify',v),materializeMigrationStage=v=>call('migration/materialize',v),verifyMigrationReadback=v=>call('migration/readback',v);
    const activateMigration=v=>call('dataset/activate',v),migrationActivationStatus=v=>call('snapshot/status',{operationId:v.operationId,requestFingerprint:v.requestFingerprint});
    const fenceMigration=async v=>{const input=clone(v);input.requestFingerprint=await C.fingerprintRequest(input);return call('dataset/fence',input);};
    const migrationInventory=Object.freeze({open:v=>call('inventory/open',v),page:v=>call('inventory/page',v),readChunk:async v=>decodeChunk(await call('inventory/chunk',v),v.offset,v.maxBytes),close:snapshotId=>call('inventory/close',{snapshotId}),verify:async snapshotId=>{const s=await call('dataset/status',{},'GET');return {complete:s.available&&s.dataset?.health?.ok===true,...migrationInventorySnapshots.get(snapshotId)};}});
    const migrationInventorySnapshots=new Map();const openMigrationInventory=async v=>{const s=await migrationInventory.open(v);migrationInventorySnapshots.set(s.snapshotId,s);return s;};
    const openInventory=Object.freeze({...migrationInventory,open:openMigrationInventory});
    const describe = () => Object.freeze({
      protocol: C.PROTOCOL,
      authorityId: identity.authorityId,
      capabilities: Object.freeze(REQUIRED.slice()),
      writers: C.WRITER_OPERATIONS,
      maxPayloadBytes: cap.maxCanonicalBytes,
      partialChunkUpload: false,
      leasedObservations: true,
      journalRequired: true
    });
    return Object.freeze({
      handoff,migrationLimits,inspectMigrationDestination,beginMigrationStage,migrationStageStatus,stageMigrationChunk,verifyMigrationStage,materializeMigrationStage,verifyMigrationReadback,activateMigration,migrationActivationStatus,fenceMigration,migrationInventory:openInventory,
      describe: describe,
      connect: connect,
      checkConnection: checkConnection,
      prepare: prepare,
      publish: publish,
      status: status,
      acquire: acquire,
      readGeneration: readGeneration,
      head: head,
      release: release,
      observeHeads: observeHeads,
      initializeScope: initializeScope,
      readCanonical: readCanonical,
      readBundleItems,openHistoryOwner,enableHistoryProfile,findCompanions,reconcileHistoryWrite,
      publishBundle: publishBundle,
      operationStatus: operationStatus,
      readInventoryState:readInventoryState,
      appendRaw: appendRaw,
      updateRawHistory: updateRawHistory,
      readCompanion: readCompanion,
      current: current,
      closeRequest: closeRequest
    });
  }
  return Object.freeze({
    createWmServerBackend: createWmServerBackend
  });
})();

if (typeof module !== "undefined" && module.exports) module.exports = WmServerStorage;
