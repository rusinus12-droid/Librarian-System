/* WM route ownership and metadata-only operation journal. No connection or mode activation. */
const WmStorageRouter = (() => {
  "use strict";
  const C = typeof WmStorageContracts !== "undefined" ? WmStorageContracts : require("./wm-storage-contracts.source.js");
  const G = typeof WmNativeHostGate !== 'undefined' ? WmNativeHostGate : require('./wm-native-host-gate.source.js');
  const clone = v => JSON.parse(JSON.stringify(v)), stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v);
  const fail = reason => ({
    ok: false,
    reason: reason
  }), token = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v), digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  // Reuse A1's plain-data gate without reading a caller accessor.
    const plain = v => {
    try {
      C.classifyOwnedRecord({
        key: "",
        schema: "wm.unknown.v1",
        value: v
      });
      return C.validateOperationStatus({
        status: "uncertain",
        operationId: "plain",
        requestFingerprint: "0".repeat(64),
        receipt: v
      }).reason !== "non_plain_data";
    } catch {
      return false;
    }
  };
  const nativeRecord = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto === null) return true;
    const ctor = Object.getOwnPropertyDescriptor(proto, "constructor")?.value;
    return typeof ctor === "function" && Function.prototype.toString.call(ctor) === "function Object() { [native code] }" && ctor.prototype === proto && Object.getPrototypeOf(proto) === null;
  };
  const dataProperties = (value, required, optional = []) => {
    if (!nativeRecord(value)) return false;
    const ds = Object.getOwnPropertyDescriptors(value);
    return required.every(k => Object.hasOwn(ds, k)) && Reflect.ownKeys(value).every(k => typeof k === "string" && ds[k].enumerable && Object.hasOwn(ds[k], "value") && (required.includes(k) || optional.includes(k)));
  };
  const exact = (v, required, optional = []) => plain(v) && v && typeof v === "object" && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k)) && Reflect.ownKeys(v).every(k => typeof k === "string" && (required.includes(k) || optional.includes(k)));
  const headEqual = (a, b) => C.validateHead(a).ok && C.validateHead(b).ok && C.HEAD_KEYS.every(k => a[k] === b[k]);
  const routeEqual = (a, b) => C.validateRoute(a).ok && C.validateRoute(b).ok && stable(a) === stable(b);
  const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype), typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get, typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength").get, typedSet = typedPrototype.set;
  function copyBytes(value) {
    if (typedTag.call(value) !== "Uint8Array") throw Error("bytes_invalid");
    const bytes = new Uint8Array(typedLength.call(value));
    typedSet.call(bytes, value);
    return bytes;
  }
  function copyInventory(value) {
    const ds = Object.getOwnPropertyDescriptors(value || {});
    if (!nativeRecord(value) || Reflect.ownKeys(value).some(k => typeof k !== "string" || !ds[k].enumerable || !Object.hasOwn(ds[k], "value")) || Object.keys(ds).sort().join(",") !== C.DTO_KEYS.InventoryWrite.slice().sort().join(",")) throw Error("inventory_invalid");
    const list = ds.items.value, ad = Object.getOwnPropertyDescriptors(list || {}), ctor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(list) || {}, "constructor")?.value;
    if (!Array.isArray(list) || typeof ctor !== "function" || Function.prototype.toString.call(ctor) !== "function Array() { [native code] }" || Reflect.ownKeys(list).length !== list.length + 1) throw Error("inventory_invalid");
    const items = [];
    for (let i = 0; i < list.length; i++) {
      const d = ad[i];
      if (!d?.enumerable || !Object.hasOwn(d, "value")) throw Error("inventory_invalid");
      const row = d.value, rd = Object.getOwnPropertyDescriptors(row || {});
      if (!nativeRecord(row) || Reflect.ownKeys(row).length !== 2 || !rd.descriptor?.enumerable || !rd.payload?.enumerable || !Object.hasOwn(rd.descriptor, "value") || !Object.hasOwn(rd.payload, "value") || !C.validateItem(rd.descriptor.value).ok) throw Error("inventory_invalid");
      items.push({
        descriptor: clone(rd.descriptor.value),
        payload: copyBytes(rd.payload.value)
      });
    }
    const meta = Object.fromEntries(Object.keys(ds).filter(k => k !== "items").map(k => [ k, ds[k].value ]));
    if (!plain({
      ...meta,
      items: items.map(x => ({
        descriptor: x.descriptor,
        payload: null
      }))
    })) throw Error("inventory_invalid");
    return {
      ...clone(meta),
      items: items
    };
  }
  function safePrepared(v) {
    return exact(v, C.DTO_KEYS.Prepared) && C.validateHead(v.expectedHead).ok && C.validateHead(v.head).ok && token(v.preparedId) && token(v.operationId) && digest(v.requestFingerprint) && digest(v.rawSha256) && C.WRITER_OPERATIONS.includes(v.operation) && v.scope === v.head.scope && v.scope === v.expectedHead.scope;
  }
  function safeReference(v) {
    if(exact(v,['kind','scope','routeGeneration','writerEpoch'])&&v.kind==='initialize')return typeof v.scope==='string'&&v.scope.length>0&&token(v.routeGeneration)&&token(v.writerEpoch);
    if(exact(v,['kind','routeGeneration','writerEpoch','expectedInventoryRevision','items','bytes'])&&v.kind==='inventory')return token(v.routeGeneration)&&token(v.writerEpoch)&&token(v.expectedInventoryRevision)&&Number.isSafeInteger(v.items)&&v.items>=0&&Number.isSafeInteger(v.bytes)&&v.bytes>=0;
    return exact(v, [ "scope", "operation", "rawSha256", "generationId", "manifestDigest", "intentFingerprint" ], [ "prepared", "rootManifest" ]) && (!v.rootManifest || C.validateRootManifest(v.rootManifest).ok) && typeof v.scope === "string" && C.WRITER_OPERATIONS.includes(v.operation) && digest(v.rawSha256) && token(v.generationId) && digest(v.manifestDigest) && digest(v.intentFingerprint) && (!v.prepared || safePrepared(v.prepared));
  }
  function safeReceipt(v) {
    return exact(v, [ "head" ]) && C.validateHead(v.head).ok || exact(v, [ "preparedId" ]) && token(v.preparedId) || exact(v, [ "reason" ]) && typeof v.reason === "string" && /^[a-z0-9_]{1,128}$/.test(v.reason) || exact(v, [ "inventoryRevision", "writerEpoch", "routeGeneration", "items", "bytes" ]) && token(v.inventoryRevision) && token(v.writerEpoch) && token(v.routeGeneration) && Number.isSafeInteger(v.items) && v.items >= 0 && Number.isSafeInteger(v.bytes) && v.bytes >= 0;
  }
  /** Persist only IDs/digests/state/route and canonical references. Storage durability and
   * multi-executor exclusion must be qualified by B4, never inferred from readback. */  function createWmOperationJournal({storage: storage, key: key = "wm.operation-journal.v1", maxEntries: maxEntries = 1e4} = {}) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || key !== "wm.operation-journal.v1" || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw Error("journal_options_invalid");
    let lane = Promise.resolve();
    const serial = work => {
      const p = lane.then(work);
      lane = p.catch(() => {});
      return p;
    };
    function valid(e) {
      return exact(e, [ "operationId", "requestFingerprint", "expectedHead", "route", "status" ], [ "reference", "receipt" ]) && token(e.operationId) && digest(e.requestFingerprint) && (e.expectedHead === null || C.validateHead(e.expectedHead).ok) && C.validateRoute(e.route).ok && [ "prepared", "committed", "conflict", "uncertain", "not_applied" ].includes(e.status) && (!e.reference || safeReference(e.reference)) && (!e.receipt || safeReceipt(e.receipt));
    }
    async function read() {
      const raw = await storage.getItem(key, {
        strict: true
      });
      if (raw === null) return [];
      if (typeof raw !== "string") throw Error("journal_unavailable");
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw Error("journal_corrupt");
      }
      if (!exact(data, [ "schema", "entries" ]) || data.schema !== "wm.operation-journal.v1" || !Array.isArray(data.entries) || data.entries.length > maxEntries || data.entries.some(e => !valid(e)) || new Set(data.entries.map(e => e.operationId)).size !== data.entries.length) throw Error("journal_corrupt");
      return data.entries;
    }
    async function write(entries) {
      const raw = stable({
        schema: "wm.operation-journal.v1",
        entries: entries
      });
      await storage.setItem(key, raw, {
        strict: true
      });
      if (await storage.getItem(key, {
        strict: true
      }) !== raw) throw Error("journal_readback_failed");
    }
    const get = id => serial(async () => clone((await read()).find(e => e.operationId === id) || null));
    const begin = v => serial(async () => {
      if (!exact(v, [ "operationId", "requestFingerprint", "expectedHead", "route" ]) || !valid({
        ...v,
        status: "uncertain"
      })) throw Error("journal_entry_invalid");
      const entries = await read(), old = entries.find(e => e.operationId === v.operationId);
      if (old) {
        if (old.requestFingerprint !== v.requestFingerprint || !routeEqual(old.route, v.route) || stable(old.expectedHead) !== stable(v.expectedHead)) throw Error("operation_identity_conflict");
        return clone(old);
      }
      if (entries.length >= maxEntries) throw Error("journal_capacity");
      const e = {
        ...clone(v),
        status: "uncertain"
      };
      entries.push(e);
      await write(entries);
      return clone(e);
    });
    const bind = v => serial(async () => {
      if (!exact(v, [ "operationId", "reference" ]) || !safeReference(v.reference)) throw Error("journal_reference_invalid");
      const entries = await read(), e = entries.find(e => e.operationId === v.operationId);
      if (!e) throw Error("journal_operation_missing");
      if (e.reference && stable({
        ...e.reference,
        prepared: null
      }) !== stable({
        ...v.reference,
        prepared: null
      })) throw Error("operation_identity_conflict");
      e.reference = clone(v.reference);
      await write(entries);
    });
    const settle = v => serial(async () => {
      if (!exact(v, [ "operationId", "status" ]) || !C.validateOperationStatus(v.status).ok || v.operationId !== v.status.operationId || v.status.receipt && !safeReceipt(v.status.receipt)) throw Error("journal_status_invalid");
      const entries = await read(), e = entries.find(e => e.operationId === v.operationId);
      if (!e || e.requestFingerprint !== v.status.requestFingerprint) throw Error("operation_identity_conflict");
      if ([ "committed", "conflict", "not_applied" ].includes(e.status) && stable({
        status: e.status,
        receipt: e.receipt || null
      }) !== stable({
        status: v.status.status,
        receipt: v.status.receipt || null
      })) throw Error("journal_terminal_conflict");
      e.status = v.status.status;
      if (v.status.receipt) e.receipt = clone(v.status.receipt);
      await write(entries);
    });
    const pending = () => serial(async () => clone((await read()).filter(e => [ "prepared", "uncertain" ].includes(e.status))));
    return Object.freeze({
      begin: begin,
      bind: bind,
      settle: settle,
      pending: pending,
      get: get,
      capabilities: Object.freeze({
        metadataOnly: true,
        atomicAcrossExecutors: false
      })
    });
  }
  function createWmStorageRouter({routeStore: routeStore, localBackend: localBackend, serverBackend: serverBackend, journal: journal, hostGate: hostGate} = {}) {
    if (!routeStore || typeof routeStore.read !== "function" || typeof routeStore.readReceipt !== "function" || !localBackend || !journal) throw Error("router_options_invalid");
    const owners = new WeakMap, tokens = new WeakMap;
    let migrationJournal=null;
    const migrationBackend=mode=>mode==="plugin_only"?localBackend:typeof serverBackend==="function"?serverBackend():serverBackend;
    const setMigrationJournal=value=>{if(migrationJournal&&migrationJournal!==value)throw Error("migration_journal_conflict");migrationJournal=value;};
    async function migrationAdmission(){try{return !migrationJournal||(await migrationJournal.pending()).length===0;}catch{return false;}}
    async function reconcileMigration(input){if(!G.isGate(hostGate))return fail("native_host_unqualified");const result=await hostGate.reconcileMigration(input);if(result?.ok!==true)return result;return R_routeEqual(await routeStore.read(),input.targetRoute)?{ok:true}:fail("route_receipt_unreconciled");}
    const R_routeEqual=routeEqual;
    const backend = s => s.route.mode === "plugin_only" ? localBackend : s.backend || (s.backend = typeof serverBackend === "function" ? serverBackend() : serverBackend);
    async function check(handle, write = false, detail = {}) {
      if(!await migrationAdmission())return fail("migration_receipt_reconciliation_required");
      const s = owners.get(handle);
      if (!s || s.closed) return fail("request_closed");
      let route;
      try {
        route = await routeStore.read();
      } catch {
        return fail("route_unavailable");
      }
      if (!routeEqual(route, s.route) || route.state !== "active") return fail("route_changed");
      if (G.isGate(hostGate)) {
        try {
          const g = await hostGate.check({
            route: clone(s.route),
            write: write, ...Object.fromEntries(Object.entries(detail).filter(([,value])=>value!==undefined))
          });
          if (!g?.ok) return fail(g?.reason || "host_gate_rejected");
          if (!detail.scope) for (const [scope,source] of s.scopes) {
            const imported=tokens.get(source.sourceToken)?.importToken;
            const admission=await hostGate.check({route:clone(s.route),write,scope,operation:imported?'import':(write?'ordinary':'read'),...imported?{importToken:imported}:{}});
            if(!admission?.ok)return fail(admission?.reason||'host_gate_rejected');
          }
        } catch {
          return fail("host_gate_unavailable");
        }
      } else if (s.route.mode === "server_only") return fail("host_unqualified");
      return {
        ok: true
      };
    }
    async function openRequest() {
      if(!await migrationAdmission())return null;
      const route = await routeStore.read();
      if (!C.validateRoute(route).ok || route.state !== "active") return null;
      const handle = Object.freeze({});
      owners.set(handle, {
        route: clone(route),
        backend: null,
        closed: false,
        scopes: new Map
      });
      return handle;
    }
    async function current(handle) {
      const c = await check(handle);
      if (!c.ok) return c;
      const s = owners.get(handle), b = backend(s);
      if (!b) return fail("backend_unavailable");
      try {
        if (typeof b.current === "function") {
          const r = await b.current({
            handle: handle,
            route: s.route
          });
          if (!r?.ok) return r;
        }
        return check(handle);
      } catch {
        return fail("backend_unavailable");
      }
    }
    function frame(v, required, optional = []) {
      if (!nativeRecord(v)) return null;
      const ds = Object.getOwnPropertyDescriptors(v);
      if (Reflect.ownKeys(v).some(k => typeof k !== "string" || !Object.hasOwn(ds[k], "value") || !ds[k].enumerable) || !required.every(k => Object.hasOwn(ds, k)) || Reflect.ownKeys(v).some(k => !required.includes(k) && !optional.includes(k))) return null;
      const handle = ds.handle?.value, payload = Object.fromEntries(Object.keys(ds).filter(k => k !== "handle").map(k => [ k, ds[k].value ]));
      if (!plain(payload)) {
        try {
          for (const name of [ "record", "history" ]) if (Object.hasOwn(payload, name)) {
            const owned = copyInventory(payload[name]);
            payload[name] = owned;
          }
          const projection = {
            ...payload
          };
          for (const name of [ "record", "history" ]) if (projection[name]?.items) projection[name] = {
            ...projection[name],
            items: projection[name].items.map(x => ({
              descriptor: x.descriptor,
              payload: null
            }))
          };
          if (!plain(projection)) return null;
        } catch {
          return null;
        }
      }
      return {
        handle: handle,
        payload: payload
      };
    }
    async function readCanonical(v) {
      const f = frame(v, [ "handle", "scope" ], ["importToken"]);
      if (!f) return fail("input_invalid");
      const detail={scope:f.payload.scope,operation:f.payload.importToken?"import":"read",importToken:f.payload.importToken};
      const c = await check(f.handle,false,detail);
      if (!c.ok) return c;
      const s = owners.get(f.handle);
      let r;
      try {
        r = await backend(s).readCanonical({
          ...f.payload,
          handle: f.handle,
          route: clone(s.route)
        });
      } catch {
        return fail("backend_unavailable");
      }
      const after = await check(f.handle,false,detail);
      if (!after.ok) return after;
      if (!r?.ok) return fail(r?.reason || "canonical_unavailable");
      if (r.head !== null && (!C.validateHead(r.head).ok || r.head.scope !== f.payload.scope)) return fail("head_invalid");
      const rawSha256 = await C.hashBytes((new TextEncoder).encode(r.raw ?? "")), freshRoute = await check(f.handle,false,detail);
      if (!freshRoute.ok) return freshRoute;
      const sourceToken = Object.freeze({});
      tokens.set(sourceToken, {
        handle: f.handle,
        scope: f.payload.scope,
        head: r.head,
        rawSha256: rawSha256,
        resetGeneration: r.resetGeneration, importToken:f.payload.importToken || null,
        backendToken: r.sourceToken,
        route: clone(s.route)
      });
      s.scopes.set(f.payload.scope, {
        head: r.head,
        sourceToken: sourceToken
      });
      return {
        ok: true,
        raw: r.raw,
        head: r.head,
        sourceToken: sourceToken,
        manifestDigest: r.manifestDigest
      };
    }
    async function validateSource(v) {
      const f = frame(v, [ "handle", "scope", "sourceToken" ]);
      if (!f) return fail("source_token_required");
      const t = tokens.get(f.payload.sourceToken);
      if (!t || t.handle !== f.handle || t.scope !== f.payload.scope) return fail("source_token_required");
      const c = await check(f.handle,false,{scope:t.scope,operation:t.importToken?"import":"read",importToken:t.importToken});
      return c.ok ? {
        ok: true,
        head: t.head
      } : c;
    }
    async function publishNativeLegacy(v) {
      const f = frame(v, [ "backend", "handle", "scope", "sourceToken", "expectedRawSha256", "expectedResetGeneration", "raw", "operation", "operationId" ]);
      if (!f || f.payload.backend !== "native_legacy") return fail("native_input_invalid");
      const c = await check(f.handle, true,{scope:f.payload.scope,operation:"ordinary"});
      if (!c.ok) return c;
      const state = owners.get(f.handle), p = f.payload, t = tokens.get(p.sourceToken);
      if (state.route.mode !== "plugin_only") return fail("native_mode_required");
      if (!t || t.handle !== f.handle || t.scope !== p.scope || t.rawSha256 !== p.expectedRawSha256 || t.resetGeneration !== p.expectedResetGeneration) return fail("native_source_changed");
      const selected = backend(state);
      if (typeof selected.publishLegacy !== "function") return fail("native_legacy_unsupported");
      let result;
      try {
        const {backend: _, ...input} = p;
        result = await selected.publishLegacy({
          ...input,
          handle: f.handle,
          sourceToken: t.backendToken,
          route: state.route
        });
      } catch {
        return {
          ok: false,
          reason: "native_write_uncertain",
          uncertain: true,
          operationId: p.operationId
        };
      }
      const after = await check(f.handle);
      return after.ok ? result : {
        ok: false,
        reason: after.reason,
        uncertain: true,
        operationId: p.operationId
      };
    }
    async function publishBundle(v) {
      if (Object.getOwnPropertyDescriptor(v || {}, "backend")?.value === "native_legacy") return publishNativeLegacy(v);
      const f = frame(v, [ "handle", "scope", "expectedHead", "manifest", "operation", "operationId", "raw" ],["importToken"]);
      if (!f) return fail("input_invalid");
      const detail={scope:f.payload.scope,operation:f.payload.operation,importToken:f.payload.importToken};
      const c = await check(f.handle, true,detail);
      if (!c.ok) return c;
      const s = owners.get(f.handle), {importToken:_,...p} = f.payload, ref = s.scopes.get(p.scope);
      if (!ref || !(p.expectedHead === null && ref.head === null || headEqual(p.expectedHead, ref.head))) return fail("source_head_required");
      const input = {
        ...p,
        routeGeneration: s.route.routeGeneration,
        writerEpoch: p.manifest?.writerEpoch
      };
      input.requestFingerprint = await C.fingerprintRequest(input);
      if (!C.validateOperation(input).ok) return fail("write_invalid");
      if (p.manifest.routeGeneration !== s.route.routeGeneration) return fail("route_changed");
      const finalGate = await check(f.handle, true,detail);
      if (!finalGate.ok) return finalGate;
      let r;
      try {
        r = await backend(s).publishBundle({
          ...input,
          route: clone(s.route)
        });
      } catch {
        return {
          status: "uncertain",
          operationId: p.operationId,
          requestFingerprint: input.requestFingerprint
        };
      }
      const after = await check(f.handle);
      return after.ok ? r : {
        status: "uncertain",
        operationId: p.operationId,
        requestFingerprint: input.requestFingerprint
      };
    }
    async function initializeScope(v) {
      const f = frame(v, [ "handle", "scope", "operationId", "expectedEmpty" ],["importToken"]);
      if (!f || f.payload.expectedEmpty !== true) return fail("initialize_invalid");
      const detail={scope:f.payload.scope,operation:f.payload.importToken?"import":"initialize",importToken:f.payload.importToken};
      const c = await check(f.handle, true,detail);
      if (!c.ok) return c;
      const s = owners.get(f.handle),{importToken:_,...payload}=f.payload;
      let r;
      try {
        r = await backend(s).initializeScope({
          ...payload,
          handle:f.handle,
          route: clone(s.route)
        });
      } catch {
        return {ok:false,reason:"initialize_uncertain",uncertain:true,operationId:f.payload.operationId};
      }
      const after = await check(f.handle);
      if (!after.ok) return {ok:false,reason:after.reason,uncertain:true,operationId:f.payload.operationId,...digest(r?.requestFingerprint)?{requestFingerprint:r.requestFingerprint}:{}};
      if(!r?.ok)return {ok:false,reason:r?.reason||"initialize_uncertain",...r?.uncertain?{uncertain:true}:{},operationId:f.payload.operationId,...digest(r?.requestFingerprint)?{requestFingerprint:r.requestFingerprint}:{}};
      if (!C.validateHead(r.head).ok || r.head.scope !== f.payload.scope) return fail("initialize_invalid");
      const sourceToken = Object.freeze({});
      tokens.set(sourceToken, {
        handle: f.handle,
        scope: f.payload.scope,
        head: r.head, importToken:f.payload.importToken || null,
        backendToken: r.sourceToken,
        route: clone(s.route)
      });
      s.scopes.set(f.payload.scope, {
        head: r.head,
        sourceToken: sourceToken
      });
      return {
        ...r,
        sourceToken: sourceToken
      };
    }
    async function invoke(name, v, keys) {
      const f = frame(v, [ "handle", ...keys ],["importToken","targetScope"]);
      if (!f) return fail("input_invalid");
      const c = await check(f.handle, !["readCompanion","readInventoryState"].includes(name));
      if (!c.ok) return c;
      const s = owners.get(f.handle);
      const contexts=name==='readCompanion'?[tokens.get(f.payload.lease)?.scope]:f.payload.targetScope?[f.payload.targetScope]:[...new Set((f.payload.record?.items||f.payload.history?.items||[]).map(row=>row.descriptor.originScope))];
      for(const scope of contexts){const admitted=await check(f.handle,name!=="readCompanion",{scope,operation:f.payload.importToken?"import":name,importToken:f.payload.importToken});if(!admitted.ok)return admitted;}
      const {importToken:_,targetScope:__,...payload}=f.payload;
      if (name === "readCompanion") {
        const t = tokens.get(f.payload.lease);
        if (!t || t.handle !== f.handle) return fail("source_token_required");
        payload.lease = t.backendToken || f.payload.lease;
      }
      try {
        const r = await backend(s)[name]({
          ...payload,
          handle: f.handle,
          route: clone(s.route)
        });
        const after = await check(f.handle);
        return after.ok ? r : after;
      } catch {
        return fail("backend_unavailable");
      }
    }
    // B3: request-owned writer contexts. Staging does not advance the canonical head.
    const writes = new WeakMap;
    async function readRoute(v) {
      const f=frame(v,['handle']);if(!f)return fail('input_invalid');
      const c=await check(f.handle);return c.ok?{ok:true,route:clone(owners.get(f.handle).route)}:c;
    }
    async function readBundleItems(v) {
      const f=frame(v,['handle','scope','sourceToken']);if(!f)return fail('input_invalid');
      const valid=await validateSource(v);if(!valid.ok)return valid;
      const t=tokens.get(f.payload.sourceToken),s=owners.get(f.handle),b=backend(s);
      if(typeof b.readBundleItems!=='function')return fail('bundle_items_unsupported');
      try {const r=await b.readBundleItems({handle:f.handle,scope:t.scope,sourceToken:t.backendToken,head:t.head,route:clone(s.route)});
        const currentResult=await current(f.handle);return currentResult.ok?r:currentResult;
      }catch{return fail('bundle_items_unavailable');}
    }
    async function reconcileHistoryWrite(v){
      const f=frame(v,['handle','scope','raw','operation','operationId','expectedHead','dependencyRoots','hasNewCompanions']);if(!f)return fail('input_invalid');const gate=await check(f.handle,true,{scope:f.payload.scope,operation:f.payload.operation});if(!gate.ok)return gate;const s=owners.get(f.handle),b=backend(s);if(s.route.mode!=='server_only'||typeof b.reconcileHistoryWrite!=='function')return fail('history_profile_unsupported');return b.reconcileHistoryWrite(f.payload);
    }
    async function findCompanions(v){
      const f=frame(v,['handle','scope','sourceToken','schema','cursor']);if(!f)return fail('input_invalid');const valid=await validateSource({handle:f.handle,scope:f.payload.scope,sourceToken:f.payload.sourceToken});if(!valid.ok)return valid;const s=owners.get(f.handle),t=tokens.get(f.payload.sourceToken),b=backend(s);if(typeof b.findCompanions!=='function')return fail('companion_pagination_unsupported');return b.findCompanions({handle:f.handle,scope:t.scope,sourceToken:t.backendToken,schema:f.payload.schema,cursor:f.payload.cursor});
    }
    async function enableHistoryProfile({handle,profile}) {
      const gate=await check(handle);if(!gate.ok)return gate;const s=owners.get(handle),b=backend(s);if(s.route.mode!=='server_only'||typeof b.enableHistoryProfile!=='function')return fail('history_server_dependency_roots_unsupported');return b.enableHistoryProfile(profile);
    }
    async function openHistoryOwner(v) {
      const f=frame(v,['handle','scope','sourceToken']);if(!f)return fail('input_invalid');
      const source=await validateSource(v);if(!source.ok)return source;const s=owners.get(f.handle),t=tokens.get(f.payload.sourceToken),b=backend(s);
      if(s.route.mode!=='server_only'||typeof b.openHistoryOwner!=='function')return fail('history_server_dependency_roots_unsupported');
      const gate=await check(f.handle,true,{scope:t.scope,operation:'normal'});if(!gate.ok)return gate;
      const owner=await b.openHistoryOwner({handle:f.handle,scope:t.scope,sourceToken:t.backendToken,head:t.head,route:clone(s.route)});
      if(!owner||typeof owner.getItem!=='function'||typeof owner.setItem!=='function')return fail('history_owner_unavailable');
      const current=async(write)=>{const g=await check(f.handle,write,{scope:t.scope,operation:'normal'});if(!g.ok)throw Error(g.reason);};
      return Object.freeze({profile:'server-pinned-roots-v2',getItem:async key=>{await current(false);const result=await owner.getItem(key);await current(false);return result;},setItem:async(key,value)=>{await current(true);const result=await owner.setItem(key,value);await current(true);return result;}});
    }
    async function beginWrite(v) {
      const f=frame(v,['handle','scope','operation','expectedSource'],['importToken','dependencyRoots','operationId']);if(!f||!C.WRITER_OPERATIONS.includes(f.payload.operation))return fail('write_input_invalid');
      const source=await validateSource({handle:f.handle,scope:f.payload.scope,sourceToken:f.payload.expectedSource});if(!source.ok)return source;
      const gate=await check(f.handle,true,{scope:f.payload.scope,operation:f.payload.operation,importToken:f.payload.importToken});if(!gate.ok)return gate;
      const observed=await current(f.handle);if(!observed.ok)return observed;
      const s=owners.get(f.handle),t=tokens.get(f.payload.expectedSource);
      if(s.route.mode==='plugin_only'&&!['normal','verified'].includes(f.payload.operation))return fail('native_writer_unsupported');
      const rootMode=f.payload.dependencyRoots!==undefined;
      if(rootMode&&(!Array.isArray(f.payload.dependencyRoots)||f.payload.dependencyRoots.length>32||!f.payload.dependencyRoots.every(token)||new Set(f.payload.dependencyRoots).size!==f.payload.dependencyRoots.length||s.route.mode!=='server_only'||!token(f.payload.operationId)))return fail('root_manifest_invalid');
      let items=[];
      if(s.route.mode==='server_only'&&!rootMode){
        const found=await readBundleItems({handle:f.handle,scope:t.scope,sourceToken:f.payload.expectedSource});
        if(found?.ok!==true)return found;if(!Array.isArray(found.items)||found.items.some(i=>!C.validateItem(i).ok))return fail('bundle_items_invalid');items=clone(found.items);
      }
      if(typeof globalThis.crypto?.randomUUID!=='function')return fail('operation_id_unavailable');
      const context=Object.freeze({});writes.set(context,{handle:f.handle,source:f.payload.expectedSource,scope:t.scope,operation:f.payload.operation,importToken:f.payload.importToken||null,operationId:rootMode?f.payload.operationId:'wm-write-'+globalThis.crypto.randomUUID(),generationId:rootMode?'generation-'+await C.hashBytes(new TextEncoder().encode(f.payload.operationId)):'generation-'+globalThis.crypto.randomUUID(),dependencyRoots:rootMode?clone(f.payload.dependencyRoots):null,items:new Map(items.map(i=>[i.logicalId,i])),staged:new Map(),closed:false,result:null});return context;
    }
    async function stageDependency(v) {
      if(!dataProperties(v,['writeContext','item','bytes']))return fail('dependency_input_invalid');
      const w=writes.get(v.writeContext);if(!w||w.closed||w.result)return fail('write_context_closed');
      const gate=await check(w.handle,true,{scope:w.scope,operation:w.operation,importToken:w.importToken});if(!gate.ok)return gate;
      try {if(!C.validateItem(v.item).ok)return fail('dependency_invalid');const item=clone(v.item),bytes=copyBytes(v.bytes);
        if(item.bytes!==bytes.byteLength||item.sha256!==await C.hashBytes(bytes))return fail('dependency_digest_mismatch');
        const old=w.items.get(item.logicalId);if(old&&stable(old)!==stable(item))return fail('dependency_identity_conflict');
        if(owners.get(w.handle).route.mode==='plugin_only')return fail('native_dependency_unsupported');
        if(w.dependencyRoots&&w.items.size>=32&&!w.items.has(item.logicalId))return fail('root_manifest_limit');
        w.items.set(item.logicalId,item);w.staged.set(item.logicalId,{descriptor:item,payload:bytes});return {ok:true};
      }catch{return fail('dependency_invalid');}
    }
    async function commitWrite(v) {
      if(!dataProperties(v,['writeContext','raw'],['manifest']))return fail('write_input_invalid');
      const w=writes.get(v.writeContext);if(!w||w.closed)return fail('write_context_closed');if(w.result&&(!w.dependencyRoots||!['uncertain','prepared'].includes(w.result.status)))return w.result;
      if(w.busy)return fail('write_in_progress');w.busy=true;
      try {
        if(w.dependencyRoots&&w.publishInput&&w.result)return w.result=await publishBundle(w.publishInput);
        const valid=await validateSource({handle:w.handle,scope:w.scope,sourceToken:w.source});if(!valid.ok)return valid;
        const observed=await current(w.handle);if(!observed.ok)return observed;
        const t=tokens.get(w.source),s=owners.get(w.handle);
        if(s.route.mode==='plugin_only')return w.result=await publishNativeLegacy({backend:'native_legacy',handle:w.handle,scope:w.scope,sourceToken:w.source,expectedRawSha256:t.rawSha256,expectedResetGeneration:t.resetGeneration,raw:v.raw,operation:w.operation,operationId:w.operationId});
        if(w.operation==='remove'?v.raw!==null:typeof v.raw!=='string')return fail('write_input_invalid');
        const metadata=await invoke('readInventoryState',{handle:w.handle},[]);if(!metadata?.ok)return metadata;
        const rawBytes=new TextEncoder().encode(v.raw??'');
        const manifest={schema:C.MANIFEST_SCHEMA,scope:w.scope,generationId:w.generationId,canonical:{sha256:await C.hashBytes(rawBytes),utf8Bytes:rawBytes.byteLength},items:w.operation==='remove'?[]:[...w.items.values()].sort((a,b)=>a.logicalId<b.logicalId?-1:a.logicalId>b.logicalId?1:0),routeGeneration:s.route.routeGeneration,writerEpoch:metadata.writerEpoch,expectedHead:clone(t.head),operationId:w.operationId};
        if(w.dependencyRoots){manifest.schema=C.ROOT_MANIFEST_SCHEMA;delete manifest.items;manifest.dependencyRoots=w.operation==='remove'?[]:[...new Set([...w.dependencyRoots,...w.items.keys()])].sort();manifest.baseGenerationId=w.operation==='remove'?null:t.head.generationId;}
        manifest.manifestDigest=await C.manifestDigest(manifest);if(!C.validateManifest(manifest).ok)return fail('manifest_invalid');
        if(v.manifest!==undefined&&stable(v.manifest)!==stable(manifest))return fail('manifest_context_mismatch');
        if(w.staged.size){
          const record=w.inventoryInput||(w.inventoryInput={operationId:w.operationId+':dependencies',routeGeneration:s.route.routeGeneration,writerEpoch:metadata.writerEpoch,expectedInventoryRevision:metadata.inventoryRevision,items:[...w.staged.values()]});
          if(!record.requestFingerprint){const encode=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return globalThis.btoa?globalThis.btoa(text):Buffer.from(bytes).toString('base64');};record.requestFingerprint=await C.fingerprintRequest({...record,items:record.items.map(i=>({descriptor:i.descriptor,payload:{encoding:'base64',data:encode(i.payload)}}))});}
          // A1 InventoryWrite fingerprint hashes descriptor+decoded payload projection.
          const staged=await invoke('appendRaw',{handle:w.handle,record,...w.importToken?{importToken:w.importToken,targetScope:w.scope}:{}},['record']);
          if(staged?.status!=='committed'){w.result=staged?.status==='uncertain'?staged:{ok:false,reason:staged?.reason||'dependency_not_committed',operationId:record.operationId};return w.result;}
        }
        const fresh=await current(w.handle);if(!fresh.ok)return fresh;
        w.publishInput={handle:w.handle,scope:w.scope,expectedHead:t.head,manifest,operation:w.operation,operationId:w.operationId,raw:v.raw,...w.importToken?{importToken:w.importToken}:{}};w.result=await publishBundle(w.publishInput);return w.result;
      } finally {w.busy=false;}
    }
    async function abortWrite(context) {const w=writes.get(context);if(!w)return fail('write_context_invalid');if(w.busy)return fail('write_in_progress');w.closed=true;w.staged.clear();return {ok:true};}

    async function closeRequest(handle) {
      const s=owners.get(handle);if(!s||s.cleanupConfirmed)return {ok:true};
      s.closed=true;s.scopes.clear();
      try{const selected=s.backend||(s.route.mode==='plugin_only'?localBackend:null);const result=selected&&typeof selected.closeRequest==='function'?await selected.closeRequest({handle}):{ok:true};
        if(result?.ok!==true)return fail(result?.reason||'close_unconfirmed');s.cleanupConfirmed=true;return {ok:true};
      }catch{return fail('close_unconfirmed');}
    }
    return Object.freeze({
      migrationBackend,setMigrationJournal,reconcileMigration,readMigrationRoute:async()=>{const route=await routeStore.read();if(!C.validateRoute(route).ok)throw Error("route_invalid");return clone(route);},
      readRoute, readBundleItems, openHistoryOwner, enableHistoryProfile, findCompanions, reconcileHistoryWrite, beginWrite, stageDependency, commitWrite, abortWrite,
      openRequest: openRequest,
      current: current,
      readCanonical: readCanonical,
      publishBundle: publishBundle,
      initializeScope: initializeScope,
      validateSource: validateSource,
      readInventoryState: v => invoke("readInventoryState",v,[]),
      appendRaw: v => invoke("appendRaw", v, [ "record" ]),
      updateRawHistory: v => invoke("updateRawHistory", v, [ "recordId", "history" ]),
      readCompanion: v => invoke("readCompanion", v, [ "lease", "logicalId", "offset", "maxBytes" ]),
      closeRequest: closeRequest
    });
  }
  return Object.freeze({
    createWmStorageRouter: createWmStorageRouter,
    createWmOperationJournal: createWmOperationJournal,
    plainData: plain,
    dataProperties: dataProperties,
    exactData: exact,
    copyBytes: copyBytes,
    copyInventory: copyInventory,
    safePrepared: safePrepared,
    headEqual: headEqual,
    routeEqual: routeEqual
  });
})();

if (typeof module !== "undefined" && module.exports) module.exports = WmStorageRouter;
