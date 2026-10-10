"use strict";

// Typed private store integration only. No SQL/DB handle or generic callback is exported.
const C = require("../../sdk/WmStorageContracts.source.js");

const crypto = require("node:crypto");

const bindings = new WeakMap;

const DEFAULT_LIMITS = Object.freeze({
  pinTtlMs: 3e5,
  inventoryTtlMs: 3e5,
  maxChunkBytes: 262144,
  maxPageItems: 128,
  maxPageBytes: 262144,
  maxBatchItems: 128,
  maxBatchBytes: 33554432,
  maxCanonicalBytes: 67108864,
  maxGenerationItems: 65536,
  maxInventoryItems: 1e6,
  maxInventoryBytes: 1099511627776,
  maxActivePins: 1024,
  maxSnapshots: 32
});

const LEASE_KEYS = Object.freeze([ "schema", "pinId", "nonce", "bootId", "bootGeneration", "authorityId", "storeId", "datasetId", "backendId", "scope", "generationId", "routeGeneration", "writerEpoch", "issuedAt", "expiresAt" ]);

const fail = reason => {
  const e = Error(reason);
  e.code = "WM_" + reason;
  throw e;
};

const token = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v);

const scope = v => typeof v === "string" && v.length > 0 && v.isWellFormed() && Buffer.byteLength(v) <= 1024;

function plain(value) {
  const active = new Set;
  function visit(v) {
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "string") {
      if (!v.isWellFormed()) fail("non_plain_data");
      return;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) fail("non_plain_data");
      return;
    }
    if (typeof v !== "object" || active.has(v)) fail("non_plain_data");
    const a = Array.isArray(v), p = Object.getPrototypeOf(v);
    if (a ? p !== Array.prototype : p !== Object.prototype && p !== null) fail("non_plain_data");
    active.add(v);
    const ds = Object.getOwnPropertyDescriptors(v), ks = Reflect.ownKeys(v);
    if (a && ks.length !== v.length + 1) fail("non_plain_data");
    for (const k of ks) {
      if (typeof k !== "string") fail("non_plain_data");
      if (a && k === "length") continue;
      const d = ds[k];
      if (!d.enumerable || !Object.hasOwn(d, "value") || [ "__proto__", "constructor", "prototype" ].includes(k) || a && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length)) fail("non_plain_data");
      visit(d.value);
    }
    active.delete(v);
  }
  visit(value);
  return value;
}

function keys(v, ks) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== ks.length || !ks.every(k => Object.hasOwn(v, k))) fail("unknown_field");
}

function lease(v) {
  plain(v);
  keys(v, LEASE_KEYS);
  if (v.schema !== "wm.pin-lease.v1" || !LEASE_KEYS.filter(k => ![ "schema", "scope", "issuedAt", "expiresAt" ].includes(k)).every(k => token(v[k])) || !scope(v.scope) || ![ v.issuedAt, v.expiresAt ].every(n => Number.isSafeInteger(n) && n >= 0) || v.expiresAt <= v.issuedAt) fail("lease_invalid");
}

function positive(n, name) {
  if (!Number.isSafeInteger(n) || n <= 0) fail(name + "_invalid");
}

function chunk(v, idKey) {
  plain(v);
  keys(v, [ idKey, "logicalId", "offset", "maxBytes" ]);
  if (idKey === "lease") lease(v.lease); else if (!token(v.snapshotId)) fail("snapshot_invalid");
  if (!token(v.logicalId) || !Number.isSafeInteger(v.offset) || v.offset < 0) fail("chunk_invalid");
  positive(v.maxBytes, "max_bytes");
}

/** Snapshot-only canonical projection; A1 validateItem remains the unchanged companion validator. */ function validateInventoryItem(value) {
  try {
    plain(value);
    keys(value, C.DTO_KEYS.Item);
    if (value.domain !== "canonical") return C.validateItem(value);
    if (value.schema !== C.CANONICAL_SCHEMA || !scope(value.originScope) || value.logicalId !== "canonical-" + crypto.createHash("sha256").update(Buffer.from(value.originScope)).digest("hex") || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !Array.isArray(value.dependencies) || !value.dependencies.every(token) || new Set(value.dependencies).size !== value.dependencies.length) fail("inventory_canonical_invalid");
    keys(value.disposition, [ "tombstone" ]);
    if (typeof value.disposition.tombstone !== "boolean" || value.disposition.tombstone && (value.bytes !== 0 || value.sha256 !== crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"))) fail("inventory_canonical_invalid");
    return {
      ok: true
    };
  } catch (e) {
    return {
      ok: false,
      reason: e.code?.startsWith("WM_") ? e.message : "inventory_item_invalid"
    };
  }
}

function registerStore(store, backend) {
  if (bindings.has(store)) fail("store_already_registered");
  bindings.set(store, backend);
}

/**
 * Durable leases bind physical identity, boot generation/nonce, scope/generation, route/epoch and TTL.
 * Expiry, release, reboot and lifecycle drift throw sanitized WM_* errors. v1 has no renewal.
 * Final observations use observeHeads(scopes,{leases}) to reject every expired request pin.
 * @param {{store:Object,clock?:()=>number,bootId:string,limits?:Object}} options
 * @returns {{capabilities:Object,acquire:Function,head:Function,readGeneration:Function,readCompanion:Function,release:Function,observeHeads:Function,openInventory:Function,readInventoryPage:Function,readInventoryChunk:Function,closeInventory:Function}}
 */ function createWmPins({store: store, clock: clock = Date.now, bootId: bootId, limits: limits = {}} = {}) {
  const backend = bindings.get(store);
  if (!backend) fail("pin_store_invalid");
  if (typeof clock !== "function" || !token(bootId)) fail("pin_options_invalid");
  plain(limits);
  if (Object.keys(limits).some(k => !Object.hasOwn(DEFAULT_LIMITS, k))) fail("limits_invalid");
  const configured = {
    ...DEFAULT_LIMITS,
    ...limits
  };
  Object.values(configured).forEach(n => positive(n, "limit"));
  const api = backend.create({
    clock: clock,
    bootId: bootId,
    limits: configured
  });
  return Object.freeze({
    capabilities: api.capabilities,
    acquire(s) {
      if (!scope(s)) fail("scope_invalid");
      return api.acquire(s);
    },
    head(s, l) {
      if (!scope(s)) fail("scope_invalid");
      lease(l);
      return api.head(s, l);
    },
    readGeneration(l) {
      lease(l);
      return api.readGeneration(l);
    },
    findCompanions(v) {plain(v);keys(v,['lease','schema','cursor','maxItems','maxBytes']);lease(v.lease);if(typeof v.schema!=='string'||v.cursor!==null&&(typeof v.cursor!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.cursor)))fail('closure_cursor_invalid');positive(v.maxItems,'max_items');positive(v.maxBytes,'max_bytes');return api.findCompanions(v);},
    readRootManifest(l) {lease(l);return api.readRootManifest(l);},
    readClosurePage(v) {plain(v);keys(v,['lease','cursor','maxItems','maxBytes']);lease(v.lease);if(v.cursor!==null&&(typeof v.cursor!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.cursor)))fail('closure_cursor_invalid');positive(v.maxItems,'max_items');positive(v.maxBytes,'max_bytes');return api.readClosurePage(v);},
    readCompanion(v) {
      chunk(v, "lease");
      return api.readCompanion(v);
    },
    release(l) {
      lease(l);
      return api.release(l);
    },
    observeHeads(scopes, options) {
      plain(scopes);
      if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > api.capabilities.limits.maxBatchItems || !scopes.every(scope) || new Set(scopes).size !== scopes.length) fail("scopes_invalid");
      if (options !== undefined) {
        plain(options);
        keys(options, [ "leases" ]);
        if (!Array.isArray(options.leases) || options.leases.length !== scopes.length) fail("observation_leases_invalid");
        options.leases.forEach(lease);
      }
      return api.observeHeads(scopes, options);
    },
    openInventory(v) {
      plain(v);
      keys(v, [ "routeGeneration" ]);
      if (!token(v.routeGeneration)) fail("route_generation_invalid");
      return api.openInventory(v);
    },
    readInventoryPage(v) {
      plain(v);
      keys(v, [ "snapshotId", "cursor", "maxItems", "maxBytes" ]);
      if (!token(v.snapshotId) || v.cursor !== null && !token(v.cursor)) fail("inventory_cursor_invalid");
      positive(v.maxItems, "max_items");
      positive(v.maxBytes, "max_bytes");
      return api.readInventoryPage(v);
    },
    readInventoryChunk(v) {
      chunk(v, "snapshotId");
      return api.readInventoryChunk(v);
    },
    closeInventory(id) {
      if (!token(id)) fail("snapshot_invalid");
      return api.closeInventory(id);
    }
  });
}

module.exports = Object.freeze({
  createWmPins: createWmPins,
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  registerStore: registerStore,
  validateInventoryItem: validateInventoryItem
});
