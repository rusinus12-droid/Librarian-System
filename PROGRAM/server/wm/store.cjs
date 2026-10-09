"use strict";

// WM-only SQLite authority. No HTTP, authentication, generic KV, models or live-data discovery.
const {DatabaseSync: DatabaseSync} = require("node:sqlite");

const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");

const C = require("../../sdk/WmStorageContracts.source.js");

const P = require("./pins.cjs");
const B = require("./backup.cjs");

/** @typedef {{authorityId:string,storeId:string,datasetId:string,backendId:string,routeGeneration:string,writerEpoch:string}} StoreIdentity */
/**
 * Trusted verifier, injected by the server/coordinator, never obtained from request JSON.
 * @callback SourceFenceVerifier
 * @param {DatasetFenceReceipt} receipt
 * @param {{targetIdentity:Object,expectedRoute:Object,targetRoute:Object,sealedInventoryDigest:string}} context
 * @returns {{ok:true,sourceIdentity:Object,sourceRoute:Object,operationId:string,requestFingerprint:string,writerEpoch:string,inventoryDigest:string}|{ok:false,reason:string}}
 * It must synchronously verify the source's durable fence, current identity/epoch/route,
 * exact operation fingerprint and sealed inventory. Boolean/Promise/uncertain results reject.
 * A4/B5 own authenticated coordinator wiring; injecting a verifier is not host qualification.
 * @typedef {{schema:'wm.dataset-fence-receipt.v1',operationId:string,requestFingerprint:string,identity:Object,sourceRoute:Object,route:Object,writerEpoch:string,inventoryRevision:string,inventoryDigest:string}} DatasetFenceReceipt
 */ const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

const stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v);

const omit = (v, key) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== key));

const fingerprint = v => sha(Buffer.from(stable(omit(v, "requestFingerprint"))));

const equal = (a, b) => stable(a) === stable(b), clone = v => JSON.parse(JSON.stringify(v));

const token = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v), digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

const fail = reason => {
  const e = Error(reason);
  e.code = "WM_" + reason;
  throw e;
};

// Descriptor traversal prevents getters/toJSON/functions/symbols from running before validation.
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
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (a && keys.length !== v.length + 1) fail("non_plain_data");
    for (const k of keys) {
      if (typeof k !== "string") fail("non_plain_data");
      if (a && k === "length") continue;
      const d = ds[k];
      if (!d.enumerable || !Object.hasOwn(d, "value") || [ "__proto__", "constructor", "prototype" ].includes(k) || !k.isWellFormed() || a && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length)) fail("non_plain_data");
      visit(d.value);
    }
    active.delete(v);
  }
  visit(value);
  return value;
}

function keys(v, required) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== required.length || !required.every(k => Object.hasOwn(v, k))) fail("unknown_field");
}

function checked(v, validator) {
  const r = validator(v);
  if (!r.ok) fail(r.reason);
}

function request(v, required) {
  plain(v);
  keys(v, required);
  if (!token(v.operationId) || !digest(v.requestFingerprint) || fingerprint(v) !== v.requestFingerprint) fail("request_fingerprint_mismatch");
}

const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype), typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get, typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength").get, typedSet = typedPrototype.set;

function ownedBytes(value) {
  try {
    if (typedTag.call(value) !== "Uint8Array") fail("invalid_bytes");
    const copy = new Uint8Array(typedLength.call(value));
    typedSet.call(copy, value);
    return Buffer.from(copy);
  } catch (_) {
    fail("invalid_bytes");
  }
}

const identityKeys = [ "authorityId", "storeId", "datasetId", "backendId", "routeGeneration", "writerEpoch" ];

const physicalIdentity = i => Object.fromEntries([ "authorityId", "storeId", "datasetId", "backendId" ].map(k => [ k, i[k] ]));

const DEFAULT_LIMITS = Object.freeze({
  maxCanonicalBytes: 64 * 1024 * 1024,
  maxGenerationBytes: 128 * 1024 * 1024,
  maxInventoryBatchBytes: 32 * 1024 * 1024,
  maxInventoryBatchItems: 128,
  maxMigrationBytes: 8 * 1024 * 1024 * 1024,
  maxMigrationItems: 1000000,
  maxMigrationChunkBytes: 262144
});

const SCHEMA_DDL = `\nCREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;\nCREATE TABLE IF NOT EXISTS blobs(sha256 TEXT PRIMARY KEY,utf8_bytes INTEGER NOT NULL CHECK(utf8_bytes>=0),payload BLOB NOT NULL CHECK(length(payload)=utf8_bytes)) STRICT;\nCREATE TABLE IF NOT EXISTS inventory_items(logical_id TEXT PRIMARY KEY,descriptor_json TEXT NOT NULL,descriptor_sha256 TEXT NOT NULL,blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256)) STRICT;\nCREATE TABLE IF NOT EXISTS generations(generation_id TEXT PRIMARY KEY,scope TEXT NOT NULL,raw_sha256 TEXT NOT NULL REFERENCES blobs(sha256),manifest_json TEXT NOT NULL,manifest_digest TEXT NOT NULL,input_json TEXT NOT NULL,input_sha256 TEXT NOT NULL,prepared_json TEXT NOT NULL,prepared_sha256 TEXT NOT NULL) STRICT;\nCREATE TABLE IF NOT EXISTS generation_items(generation_id TEXT NOT NULL REFERENCES generations(generation_id),ordinal INTEGER NOT NULL,logical_id TEXT NOT NULL REFERENCES inventory_items(logical_id),descriptor_json TEXT NOT NULL,blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),PRIMARY KEY(generation_id,ordinal),UNIQUE(generation_id,logical_id)) STRICT;\nCREATE TABLE IF NOT EXISTS heads(scope TEXT PRIMARY KEY,generation_id TEXT NOT NULL REFERENCES generations(generation_id),head_json TEXT NOT NULL,head_sha256 TEXT NOT NULL) STRICT;\nCREATE TABLE IF NOT EXISTS operations(operation_id TEXT PRIMARY KEY,request_fingerprint TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('prepared','committed','conflict')),prepared_id TEXT UNIQUE,response_json TEXT NOT NULL,response_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;\nCREATE TABLE IF NOT EXISTS dataset_route(singleton INTEGER PRIMARY KEY CHECK(singleton=1),route_json TEXT NOT NULL,route_sha256 TEXT NOT NULL) STRICT;\nCREATE TABLE IF NOT EXISTS pins(pin_id TEXT PRIMARY KEY,scope TEXT NOT NULL,generation_id TEXT NOT NULL REFERENCES generations(generation_id),boot_id TEXT NOT NULL,expires_at INTEGER NOT NULL,lease_json TEXT NOT NULL) STRICT;\nCREATE TABLE IF NOT EXISTS inventory_snapshots(snapshot_id TEXT PRIMARY KEY,route_generation TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;\nCREATE TABLE IF NOT EXISTS inventory_snapshot_items(snapshot_id TEXT NOT NULL REFERENCES inventory_snapshots(snapshot_id),ordinal INTEGER NOT NULL,logical_id TEXT NOT NULL,descriptor_json TEXT NOT NULL,descriptor_sha256 TEXT NOT NULL,blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),source_generation_id TEXT REFERENCES generations(generation_id),PRIMARY KEY(snapshot_id,ordinal),UNIQUE(snapshot_id,logical_id)) STRICT;\n`;

function immutableDdl() {
  return [ "blobs", "inventory_items", "generations", "generation_items", "inventory_snapshot_items" ].map(table => `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'wm_immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'wm_immutable'); END;`).join("\n") + `\nCREATE TRIGGER IF NOT EXISTS operations_terminal_immutable BEFORE UPDATE ON operations WHEN OLD.status IN ('committed','conflict') BEGIN SELECT RAISE(ABORT,'wm_immutable_receipt'); END; CREATE TRIGGER IF NOT EXISTS operations_immutable_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT,'wm_immutable_receipt'); END;`;
}

/**
 * @param {{databasePath:string,identity:StoreIdentity,clock?:()=>number,limits?:Object,verifySourceFenceReceipt?:SourceFenceVerifier}} options
 * Initial route is server dataset state only. It does not change a client's global plugin_only route.
 * Identity is immutable creation identity. Current epoch/route are durable lifecycle state, never restored from caller values.
 */ function createWmStore({databasePath: databasePath, identity: identity, clock: clock = Date.now, limits: limits = {}, verifySourceFenceReceipt: verifySourceFenceReceipt, verifyHandoffFence} = {}) {
  plain(identity);
  keys(identity, identityKeys);
  if (!identityKeys.every(k => token(identity[k]))) fail("store_identity_invalid");
  identity = clone(identity);
  plain(limits);
  if (Object.keys(limits).some(k => !Object.hasOwn(DEFAULT_LIMITS, k))) fail("limits_invalid");
  limits = {
    ...DEFAULT_LIMITS,
    ...limits
  };
  if (!Object.values(limits).every(n => Number.isSafeInteger(n) && n > 0)) fail("limits_invalid");
  if (typeof clock !== "function" || verifySourceFenceReceipt !== undefined && typeof verifySourceFenceReceipt !== "function") fail("store_options_invalid");
  if (typeof databasePath !== "string" || !databasePath || databasePath === ":memory:") fail("database_path_invalid");
  fs.mkdirSync(path.dirname(databasePath), {
    recursive: true
  });
  const restoreJournal=databasePath+'.restore-journal.json';
  if(fs.existsSync(restoreJournal)&&JSON.parse(fs.readFileSync(restoreJournal,'utf8')).phase!=='COMMITTED')fail('restore_recovery_required');
  const db = new DatabaseSync(databasePath);
  let closed = false, migrationWriting = null, handoffWriting = null, handoffEngine = null;
  const now = () => {
    const n = clock();
    if (!Number.isSafeInteger(n) || n < 0) fail("clock_invalid");
    return n;
  };
  function usable() {
    if (closed) fail("store_closed");
  }
  function transaction(work) {
    usable();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch (_) {}
      throw e;
    }
  }
  const one = (sql, ...args) => db.prepare(sql).get(...args), all = (sql, ...args) => db.prepare(sql).all(...args), iterate = (sql, ...args) => db.prepare(sql).iterate(...args), run = (sql, ...args) => db.prepare(sql).run(...args);
  const meta = key => one("SELECT value FROM metadata WHERE key=?", key)?.value;
  const setMeta = (key, value) => run("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value));
  function fresh(prefix) {
    let value;
    do {
      value = prefix + "-" + crypto.randomUUID();
    } while (meta("used:" + value) !== undefined);
    run("INSERT INTO metadata(key,value) VALUES (?,?)", "used:" + value, "1");
    return value;
  }
  function route() {
    const row = one("SELECT route_json,route_sha256 FROM dataset_route WHERE singleton=1");
    if (!row || sha(Buffer.from(row.route_json)) !== row.route_sha256) fail("route_integrity");
    const r = JSON.parse(row.route_json);
    checked(r, C.validateRoute);
    return r;
  }
  function setRoute(r) {
    const json = stable(r);
    run("INSERT INTO dataset_route VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET route_json=excluded.route_json,route_sha256=excluded.route_sha256", json, sha(Buffer.from(json)));
  }
  function epoch() {
    return meta("writer_epoch");
  }
  function statusValue(status, id, fp, receipt) {
    return {
      status: status,
      operationId: id,
      requestFingerprint: fp,
      ...receipt ? {
        receipt: receipt
      } : {}
    };
  }
  function operation(id, fp) {
    const row = one("SELECT * FROM operations WHERE operation_id=?", id);
    if (!row) return null;
    if (row.request_fingerprint !== fp) return statusValue("conflict", id, fp, {
      reason: "operation_id_conflict"
    });
    if (sha(Buffer.from(row.response_json)) !== row.response_sha256) fail("receipt_integrity");
    const result = JSON.parse(row.response_json);
    checked(result, C.validateOperationStatus);
    if (result.operationId !== id || result.requestFingerprint !== fp || result.status !== row.status) fail("receipt_integrity");
    return result;
  }
  function saveOperation(input, kind, result, preparedId = null) {
    const json = stable(result);
    run("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?)", input.operationId, input.requestFingerprint, kind, result.status, preparedId, json, sha(Buffer.from(json)), now());
    return result;
  }
  function finishOperation(input, result) {
    const json = stable(result);
    run("UPDATE operations SET status=?,response_json=?,response_sha256=? WHERE operation_id=? AND request_fingerprint=? AND status='prepared'", result.status, json, sha(Buffer.from(json)), input.operationId, input.requestFingerprint);
    return result;
  }
  function conflict(input, reason, kind) {
    const result = statusValue("conflict", input.operationId, input.requestFingerprint, {
      reason: reason
    });
    const old = operation(input.operationId, input.requestFingerprint);
    return old?.status === "prepared" ? finishOperation(input, result) : old || saveOperation(input, kind, result);
  }
  function storeBlob(bytes, hash) {
    const row = one("SELECT payload,utf8_bytes FROM blobs WHERE sha256=?", hash);
    if (row) {
      if (row.utf8_bytes !== bytes.length || sha(row.payload) !== hash || !Buffer.from(row.payload).equals(bytes)) fail("blob_integrity");
      return;
    }
    run("INSERT INTO blobs VALUES (?,?,?)", hash, bytes.length, bytes);
  }
  function blob(hash, size, chunkBytes) {
    if (chunkBytes) {
      const meta = one("SELECT utf8_bytes,length(payload) AS payload_bytes FROM blobs WHERE sha256=?", hash);
      if (!meta || meta.utf8_bytes !== size || meta.payload_bytes !== size) fail("blob_integrity");
      const h = crypto.createHash("sha256");
      for (let offset = 0; offset < size; ) {
        const amount = Math.min(chunkBytes, size - offset);
        const part = one("SELECT substr(payload,?,?) AS bytes FROM blobs WHERE sha256=?", offset + 1, amount, hash);
        if (!part || part.bytes.length !== amount) fail("blob_integrity");
        h.update(part.bytes);
        offset += amount;
      }
      if (h.digest("hex") !== hash) fail("blob_integrity");
      return;
    }
    const row = one("SELECT payload,utf8_bytes FROM blobs WHERE sha256=?", hash);
    if (!row || row.utf8_bytes !== size || row.payload.length !== size || sha(row.payload) !== hash) fail("blob_integrity");
    return Buffer.from(row.payload);
  }
  function inventoryDescriptor(id, chunkBytes) {
    const row = one("SELECT * FROM inventory_items WHERE logical_id=?", id);
    if (!row) return null;
    if (sha(Buffer.from(row.descriptor_json)) !== row.descriptor_sha256) fail("inventory_integrity");
    const d = JSON.parse(row.descriptor_json);
    checked(d, C.validateItem);
    if (d.logicalId !== id || d.sha256 !== row.blob_sha256) fail("inventory_integrity");
    if(meta('handoff-copy:'+sha(Buffer.from(id)))!==undefined)readHandoffCopy(d,0,0);else blob(d.sha256, d.bytes, chunkBytes);
    return d;
  }
  function closure(manifest, chunkBytes) {
    if (roots.isRoot(manifest)) { if(manifest.canonical.utf8Bytes>limits.maxCanonicalBytes)fail("canonical_limit"); return manifest.canonical.utf8Bytes; }
    let total = manifest.canonical.utf8Bytes;
    if (total > limits.maxCanonicalBytes) fail("canonical_limit");
    if (total > limits.maxGenerationBytes) fail("generation_limit");
    for (const d of manifest.items) {
      if (total > Number.MAX_SAFE_INTEGER - d.bytes) fail("byte_total_overflow");
      total += d.bytes;
      if (total > limits.maxGenerationBytes) fail("generation_limit");
      const stored = inventoryDescriptor(d.logicalId, chunkBytes);
      if (!stored) fail("dependency_missing");
      if (!equal(stored, d)) fail("inventory_descriptor_conflict");
    }
    return total;
  }
  function head(scope, chunkBytes, maxItems, maxCanonical, certify = true) {
    const row = one("SELECT * FROM heads WHERE scope=?", scope);
    if (!row) return null;
    if (sha(Buffer.from(row.head_json)) !== row.head_sha256) fail("head_integrity");
    const h = JSON.parse(row.head_json);
    checked(h, C.validateHead);
    if (h.scope !== scope || h.generationId !== row.generation_id || h.authorityId !== identity.authorityId || h.storeId !== identity.storeId) fail("head_integrity");
    if (maxCanonical !== undefined && h.utf8Bytes > maxCanonical) fail("pin_limit");
    const generation = verifyGeneration(h.generationId, chunkBytes, maxItems, maxCanonical);
    if(certify&&roots.isRoot(generation.manifest))roots.verifyClosure(generation.manifest,true);
    if (!equal(generation.prepared.head, h)) fail("head_generation_integrity");
    return h;
  }
  function setHead(h) {
    const json = stable(h);
    run("INSERT INTO heads VALUES (?,?,?,?) ON CONFLICT(scope) DO UPDATE SET generation_id=excluded.generation_id,head_json=excluded.head_json,head_sha256=excluded.head_sha256", h.scope, h.generationId, json, sha(Buffer.from(json)));
  }
  function verifyGeneration(id, chunkBytes, maxItems, maxCanonical) {
    if (maxItems !== undefined) {
      const bounds = one("SELECT json_array_length(manifest_json,'$.items') AS n FROM generations WHERE generation_id=?", id);
      if (bounds && bounds.n!==null && (!Number.isSafeInteger(bounds.n) || bounds.n < 0 || bounds.n > maxItems)) fail("pin_limit");
      if (bounds?.n!==null && one("SELECT COUNT(*) AS n FROM generation_items WHERE generation_id=?", id).n > maxItems) fail("pin_limit");
    }
    if (maxCanonical !== undefined) {
      const bounds = one("SELECT json_extract(manifest_json,'$.canonical.utf8Bytes') AS n FROM generations WHERE generation_id=?", id);
      if (bounds && (!Number.isSafeInteger(bounds.n) || bounds.n < 0 || bounds.n > maxCanonical)) fail("pin_limit");
    }
    const row = one("SELECT * FROM generations WHERE generation_id=?", id);
    if (!row) fail("generation_missing");
    if (sha(Buffer.from(row.input_json)) !== row.input_sha256 || sha(Buffer.from(row.prepared_json)) !== row.prepared_sha256) fail("generation_integrity");
    const m = JSON.parse(row.manifest_json);
    checked(m, C.validateManifest);
    if (m.generationId !== id || m.scope !== row.scope || m.canonical.sha256 !== row.raw_sha256 || m.manifestDigest !== row.manifest_digest) fail("generation_integrity");
    const intent = JSON.parse(row.input_json), prepared = JSON.parse(row.prepared_json);
    plain(intent);
    plain(prepared);
    keys(prepared, C.DTO_KEYS.Prepared);
    if (!C.validateHead(prepared.head).ok || !token(prepared.preparedId) || !equal(intent.manifest, m) || intent.scope !== m.scope || intent.operationId !== m.operationId || intent.routeGeneration !== m.routeGeneration || intent.writerEpoch !== m.writerEpoch || !equal(intent.expectedHead, m.expectedHead) || prepared.operationId !== intent.operationId || prepared.requestFingerprint !== intent.requestFingerprint || prepared.operation !== intent.operation || prepared.scope !== intent.scope || !equal(prepared.expectedHead, intent.expectedHead) || prepared.rawSha256 !== m.canonical.sha256 || prepared.head.generationId !== id || prepared.head.scope !== m.scope || prepared.head.authorityId !== identity.authorityId || prepared.head.storeId !== identity.storeId || prepared.head.sha256 !== m.canonical.sha256 || prepared.head.utf8Bytes !== m.canonical.utf8Bytes || prepared.head.tombstone !== (intent.raw === null)) fail("generation_integrity");
    if (intent.operation === "initialize") {
      const initial = {
        scope: intent.scope,
        operationId: intent.operationId,
        routeGeneration: intent.routeGeneration,
        writerEpoch: intent.writerEpoch,
        expectedEmpty: true
      };
      if (fingerprint(initial) !== intent.requestFingerprint || !equal(prepared.head, intent.expectedHead) || m.items.length !== 0) fail("generation_integrity");
    } else if (!C.validateOperation(intent).ok) fail("generation_integrity");
    closure(m, chunkBytes);
    if (roots.isRoot(m)) roots.verifyClosure(m);
    else {
    const items = all("SELECT * FROM generation_items WHERE generation_id=? ORDER BY ordinal", id);
    if (items.length !== m.items.length) fail("generation_integrity");
    for (let i = 0; i < items.length; i++) if (items[i].ordinal !== i || items[i].logical_id !== m.items[i].logicalId || items[i].blob_sha256 !== m.items[i].sha256 || !equal(JSON.parse(items[i].descriptor_json), m.items[i])) fail("generation_integrity");
    }
    const raw = blob(m.canonical.sha256, m.canonical.utf8Bytes).toString("utf8");
    if (sha(Buffer.from(raw)) !== m.canonical.sha256) fail("raw_integrity");
    return {
      row: row,
      manifest: m,
      prepared: prepared,
      raw: raw
    };
  }
  function historicalExecution(input) {
    if (meta("restore-historical-operation:" + sha(Buffer.from(input.operationId))) !== undefined) fail("historical_operation_not_executable");
    if (meta("restore-admission") !== undefined && route().state !== "active") fail("restore_recovery_required");
  }
  function checkWriteFence(input) {
    historicalExecution(input);
    const r = route();
    if (r.state !== "active" && !(migrationWriting && meta("migration-owner") === migrationWriting)) fail("dataset_fenced");
    if (r.routeGeneration !== input.routeGeneration) fail("route_generation_conflict");
    if (epoch() !== input.writerEpoch) fail("writer_epoch_conflict");
    if(input.scope){const pending=meta('handoff-target:'+sha(Buffer.from(input.scope)));if(pending!==undefined){const row=JSON.parse(pending);if(row.state==='pending'&&handoffWriting!==row.operationId)fail('handoff_target_pending');}}
  }
  function inventoryDigest() {
    const hash = crypto.createHash("sha256");
    hash.update("wm.dataset-inventory.v1\n");
    for (const row of iterate("SELECT logical_id FROM inventory_items ORDER BY logical_id")) {
      const d = inventoryDescriptor(row.logical_id);
      hash.update(stable(d) + "\n");
    }
    for (const row of iterate("SELECT scope FROM heads ORDER BY scope")) {
      const h = head(row.scope);
      verifyGeneration(h.generationId);
      hash.update(stable(h) + "\n");
    }
    return hash.digest("hex");
  }
  function putGeneration(input, p) {
    const raw = Buffer.from(input.raw === null ? "" : input.raw), m = input.manifest;
    storeBlob(raw, m.canonical.sha256);
    const inputJson = stable(input), preparedJson = stable(p);
    run("INSERT INTO generations VALUES (?,?,?,?,?,?,?,?,?)", m.generationId, input.scope, m.canonical.sha256, stable(m), m.manifestDigest, inputJson, sha(Buffer.from(inputJson)), preparedJson, sha(Buffer.from(preparedJson)));
    if(roots.isRoot(m)) roots.buildClosure(m);
    else m.items.forEach((d, i) => run("INSERT INTO generation_items VALUES (?,?,?,?,?)", m.generationId, i, d.logicalId, stable(d), d.sha256));
  }
  const roots = require('./dependency-roots.cjs').createDependencyRoots({C,crypto,one,iterate,run,db,meta,setMeta,sha,stable,equal,clone,fail,keys,plain,request,token,digest,checked,transaction,identity,physicalIdentity,epoch,route,now,operation,saveOperation,statusValue,checkWriteFence,head,stageHead:scope=>head(scope,undefined,undefined,undefined,false),blob,storeBlob,inventoryDescriptor});
  try {
    const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row => row.name);
    const wmTables = [ "metadata", "blobs", "inventory_items", "generations", "generation_items", "heads", "operations", "dataset_route", "pins", "inventory_snapshots", "inventory_snapshot_items" ];
    if (tables.some(name => !wmTables.includes(name))) fail("store_foreign_schema");
    db.exec("PRAGMA temp_store=FILE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    transaction(() => {
      db.exec(SCHEMA_DDL);
      const existing = meta("identity");
      if (existing !== undefined) {
        if (existing !== stable(identity)) fail("store_identity_mismatch");
        if (meta("schema") !== "wm.sqlite.v1") fail("store_schema_mismatch");
        route();
        if (!token(epoch())) fail("epoch_integrity");
        return;
      }
      if (wmTables.some(name => one("SELECT COUNT(*) n FROM " + name).n)) fail("store_identity_missing");
      setMeta("identity", stable(identity));
      setMeta("schema", "wm.sqlite.v1");
      setMeta("writer_epoch", identity.writerEpoch);
      setMeta("inventory_revision", "inventory-0");
      setMeta("used:" + identity.writerEpoch, "1");
      setMeta("used-route:" + identity.routeGeneration, "1");
      setRoute({
        schema: C.ROUTE_SCHEMA,
        mode: "server_only",
        routeGeneration: identity.routeGeneration,
        datasetId: identity.datasetId,
        backendId: identity.backendId,
        state: "active"
      });
    });
    db.exec(immutableDdl());
  } catch (e) {
    try {
      db.close();
    } catch (_) {}
    throw e;
  }
  function uncertain(input) {
    return statusValue("uncertain", input.operationId, input.requestFingerprint);
  }
  // A3 private typed adapter. Every observation/pin/snapshot transition shares a DB transaction.
    let currentPinBoot, pinClockWatermark = -1;
  function createPinsBackend({clock: pinClock, bootId: bootId, limits: requested}) {
    function pinTransaction(work) {
      try {
        return transaction(work);
      } catch (e) {
        if (e.code?.startsWith("WM_")) throw e;
        fail("storage_unavailable");
      }
    }
    const pinLimits = Object.freeze({
      ...requested,
      maxCanonicalBytes: Math.min(requested.maxCanonicalBytes, limits.maxCanonicalBytes),
      maxBatchItems: Math.min(requested.maxBatchItems, limits.maxInventoryBatchItems),
      maxBatchBytes: Math.min(requested.maxBatchBytes, limits.maxInventoryBatchBytes)
    });
    const pinNow = () => {
      const n = pinClock();
      if (!Number.isSafeInteger(n) || n < 0) fail("clock_invalid");
      if (n < pinClockWatermark) fail("clock_regression");
      pinClockWatermark = n;
      return n;
    };
    const expiry = (issued, ttl) => {
      if (issued > Number.MAX_SAFE_INTEGER - ttl) fail("expiry_overflow");
      return issued + ttl;
    };
    let storeBootGeneration;
    pinTransaction(() => {
      if (!currentPinBoot || currentPinBoot.bootId !== bootId || meta("pin_boot_generation") !== currentPinBoot.generation) currentPinBoot = {
        bootId: bootId,
        generation: "boot-" + crypto.randomUUID()
      };
      storeBootGeneration = currentPinBoot.generation;
      setMeta("pin_boot_id", bootId);
      setMeta("pin_boot_generation", storeBootGeneration);
    });
    const capabilities = Object.freeze({
      schema: "wm.pin-capabilities.v1",
      protocol: C.PROTOCOL,
      limits: pinLimits,
      pin: Object.freeze({
        ttlMs: pinLimits.pinTtlMs,
        renew: false,
        reacquireAfterExpiry: true
      }),
      inventory: Object.freeze({
        ttlMs: pinLimits.inventoryTtlMs,
        cursorReplay: false,
        chunkReads: true
      })
    });
    function boot() {
      if (meta("pin_boot_id") !== bootId || meta("pin_boot_generation") !== storeBootGeneration) fail("previous_boot");
    }
    function add(a, b) {
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a > Number.MAX_SAFE_INTEGER - b) fail("byte_total_overflow");
      return a + b;
    }
    function saved(record) {
      const value = omit(record, "seal");
      return {
        ...value,
        seal: sha(Buffer.from(stable(value)))
      };
    }
    function decoded(json) {
      let value;
      try {
        value = JSON.parse(json);
        plain(value);
      } catch (_) {
        fail("record_integrity");
      }
      if (!digest(value.seal) || sha(Buffer.from(stable(omit(value, "seal")))) !== value.seal) fail("record_integrity");
      return value;
    }
    function storePin(record) {
      run("UPDATE pins SET lease_json=? WHERE pin_id=?", stable(saved(record)), record.lease.pinId);
    }
    function leaseFresh(lease) {
      boot();
      const n = pinNow();
      if (n < lease.issuedAt || n >= lease.expiresAt) fail("lease_expired");
      if (route().routeGeneration !== lease.routeGeneration || epoch() !== lease.writerEpoch) fail("lease_lifecycle_conflict");
    }
    function pinned(lease) {
      boot();
      const row = one("SELECT * FROM pins WHERE pin_id=?", lease.pinId);
      if (!row) fail("lease_missing");
      const record = decoded(row.lease_json);
      if (record.schema !== "wm.pin-record.v1" || !equal(record.lease, lease) || row.scope !== lease.scope || row.generation_id !== lease.generationId || row.boot_id !== lease.bootId || row.expires_at !== lease.expiresAt || lease.bootId !== bootId || lease.bootGeneration !== storeBootGeneration || !equal(physicalIdentity(lease), physicalIdentity(identity))) fail("lease_mismatch");
      if (record.status !== "active") fail("lease_released");
      const n = pinNow();
      if (n < lease.issuedAt || n >= lease.expiresAt) fail("lease_expired");
      if (route().routeGeneration !== lease.routeGeneration || epoch() !== lease.writerEpoch) fail("lease_lifecycle_conflict");
      const generation = verifyGeneration(lease.generationId, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes);
      if (!equal(generation.prepared.head, record.head) || generation.manifest.manifestDigest !== record.manifestDigest) fail("pin_integrity");
      if ((generation.manifest.items?.length||0) > pinLimits.maxGenerationItems || generation.manifest.canonical.utf8Bytes > pinLimits.maxCanonicalBytes) fail("pin_limit");
      leaseFresh(lease);
      return {
        record: record,
        generation: generation
      };
    }
    function descriptorOnly(id) {
      const row = one("SELECT * FROM inventory_items WHERE logical_id=?", id);
      if (!row) return null;
      if (sha(Buffer.from(row.descriptor_json)) !== row.descriptor_sha256) fail("inventory_integrity");
      let d;
      try {
        d = JSON.parse(row.descriptor_json);
      } catch (_) {
        fail("inventory_integrity");
      }
      checked(d, C.validateItem);
      if (d.logicalId !== id || d.sha256 !== row.blob_sha256) fail("inventory_integrity");
      return d;
    }
    function verifyBlob(hash, size) {
      if (!digest(hash) || !Number.isSafeInteger(size) || size < 0) fail("blob_integrity");
      const r = one("SELECT utf8_bytes,length(payload) AS payload_bytes FROM blobs WHERE sha256=?", hash);
      if (!r || r.utf8_bytes !== size || r.payload_bytes !== size) fail("blob_integrity");
      const h = crypto.createHash("sha256");
      for (let offset = 0; offset < size; ) {
        const length = Math.min(pinLimits.maxChunkBytes, size - offset);
        const piece = one("SELECT substr(payload,?,?) AS bytes FROM blobs WHERE sha256=?", offset + 1, length, hash);
        if (!piece || piece.bytes.length !== length) fail("blob_integrity");
        h.update(piece.bytes);
        offset += length;
      }
      if (h.digest("hex") !== hash) fail("blob_integrity");
    }
    function readChunk(d, offset, maxBytes) {
      if (maxBytes > pinLimits.maxChunkBytes) fail("chunk_limit");
      if (offset > d.bytes) fail("offset_out_of_range");
      if(meta('handoff-copy:'+sha(Buffer.from(d.logicalId)))!==undefined)return readHandoffCopy(d,offset,maxBytes);
      verifyBlob(d.sha256, d.bytes);
      const amount = Math.min(maxBytes, d.bytes - offset);
      // SQLite substr on an empty BLOB returns NULL; the verified zero-byte slice is explicit.
            if (amount === 0) return {
        bytes: new Uint8Array(0),
        offset: offset,
        nextOffset: null,
        totalBytes: d.bytes,
        sha256: d.sha256
      };
      const row = one("SELECT substr(payload,?,?) AS bytes FROM blobs WHERE sha256=?", offset + 1, amount, d.sha256);
      if (!row || row.bytes.length !== amount) fail("blob_integrity");
      return {
        bytes: Uint8Array.from(row.bytes),
        offset: offset,
        nextOffset: offset + amount === d.bytes ? null : offset + amount,
        totalBytes: d.bytes,
        sha256: d.sha256
      };
    }
    function knownEmpty(h) { const value=meta("migration-empty:"+sha(Buffer.from(h.scope)));return h.tombstone && value!==undefined && equal(JSON.parse(value),h); }
    function canonicalDescriptor(h, g) {
      const preserved=meta("migration-canonical:"+sha(Buffer.from(h.scope)));if(preserved!==undefined){const row=JSON.parse(preserved);if(equal(row.head,h))return clone(row.descriptor);}
      return {
        domain: "canonical",
        schema: C.CANONICAL_SCHEMA,
        logicalId: "canonical-" + sha(Buffer.from(h.scope)),
        originScope: h.scope,
        bytes: h.utf8Bytes,
        sha256: h.sha256,
        dependencies: roots.isRoot(g.manifest) ? [roots.proof(g.manifest).rootId] : g.manifest.items.map(d => d.logicalId),
        disposition: {
          tombstone: h.tombstone
        }
      };
    }
    function writeSnapshot(state) {
      run("UPDATE inventory_snapshots SET snapshot_json=? WHERE snapshot_id=?", stable(saved(state)), state.snapshot.snapshotId);
    }
    function snapshotState(id) {
      boot();
      const row = one("SELECT * FROM inventory_snapshots WHERE snapshot_id=?", id);
      if (!row) fail("snapshot_missing");
      const state = decoded(row.snapshot_json);
      if (state.schema !== "wm.inventory-state.v1" || state.snapshot.snapshotId !== id || state.snapshot.routeGeneration !== row.route_generation || state.bootId !== bootId || state.bootGeneration !== storeBootGeneration || !equal(state.identity, physicalIdentity(identity))) fail("snapshot_integrity");
      if (state.status !== "active") fail("snapshot_closed");
      const n = pinNow();
      if (n < state.issuedAt || n >= state.expiresAt) fail("snapshot_expired");
      if (route().routeGeneration !== state.snapshot.routeGeneration || epoch() !== state.writerEpoch) fail("snapshot_lifecycle_conflict");
      if (!C.validateDomainTotals(state.snapshot.domainCounts).ok || !C.validateDomainTotals(state.snapshot.domainBytes).ok || !digest(state.snapshot.inventoryDigest) || state.snapshot.complete !== true || !Number.isSafeInteger(state.totalItems) || state.totalItems < 0 || !Number.isSafeInteger(state.nextOrdinal) || state.nextOrdinal < 0 || state.nextOrdinal > state.totalItems || state.nextCursor !== null && !token(state.nextCursor)) fail("snapshot_integrity");
      return state;
    }
    function snapshotDescriptor(row) {
      if (!row || sha(Buffer.from(row.descriptor_json)) !== row.descriptor_sha256) fail("snapshot_item_integrity");
      const d = JSON.parse(row.descriptor_json);
      if (d.logicalId !== row.logical_id || d.sha256 !== row.blob_sha256) fail("snapshot_item_integrity");
      if (row.source_generation_id !== null) {
        const g = verifyGeneration(row.source_generation_id, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes);
        if (!equal(d, canonicalDescriptor(g.prepared.head, g))) fail("snapshot_item_integrity");
      } else {
        const original = descriptorOnly(d.logicalId);
        if (!original || !equal(original, d)) fail("snapshot_item_integrity");
      }
      return d;
    }
    return {
      capabilities: capabilities,
      acquire(scope) {
        return pinTransaction(() => {
          boot();
          const pending=meta('handoff-target:'+sha(Buffer.from(scope)));if(pending!==undefined&&JSON.parse(pending).state==='pending')fail('handoff_target_pending');
          const h = head(scope, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes);
          if (!h) fail("scope_missing");
          const g = verifyGeneration(h.generationId, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes);
          if ((g.manifest.items?.length||0) > pinLimits.maxGenerationItems || h.utf8Bytes > pinLimits.maxCanonicalBytes) fail("pin_limit");
          const issuedAt = pinNow(), expiresAt = expiry(issuedAt, pinLimits.pinTtlMs);
          const count = one("SELECT COUNT(*) AS n FROM pins WHERE boot_id=? AND expires_at>? AND json_extract(lease_json,'$.status')='active' AND json_extract(lease_json,'$.lease.bootGeneration')=? AND json_extract(lease_json,'$.lease.routeGeneration')=? AND json_extract(lease_json,'$.lease.writerEpoch')=?", bootId, issuedAt, storeBootGeneration, route().routeGeneration, epoch()).n;
          if (count >= pinLimits.maxActivePins) fail("pin_capacity");
          const lease = {
            schema: "wm.pin-lease.v1",
            pinId: "pin-" + crypto.randomUUID(),
            nonce: "nonce-" + crypto.randomUUID(),
            bootId: bootId,
            bootGeneration: storeBootGeneration,
            ...physicalIdentity(identity),
            scope: scope,
            generationId: h.generationId,
            routeGeneration: route().routeGeneration,
            writerEpoch: epoch(),
            issuedAt: issuedAt,
            expiresAt: expiresAt
          };
          const record = saved({
            schema: "wm.pin-record.v1",
            lease: lease,
            head: h,
            manifestDigest: g.manifest.manifestDigest,
            status: "active"
          });
          run("INSERT INTO pins VALUES (?,?,?,?,?,?)", lease.pinId, scope, h.generationId, bootId, expiresAt, stable(record));
          return {
            head: clone(h),
            lease: clone(lease),
            // Same verified immutable generation and transaction as Head + pin.
            manifestDigest: g.manifest.manifestDigest
          };
        });
      },
      head(scope, lease) {
        return pinTransaction(() => {
          pinned(lease);
          if (scope !== lease.scope) fail("lease_scope_conflict");
          const h = head(scope, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes);
          if (!h) fail("scope_missing");
          leaseFresh(lease);
          return {
            head: h,
            leaseValid: true
          };
        });
      },
      readGeneration(lease) {
        return pinTransaction(() => {
          const {generation: generation} = pinned(lease);
          return generation.prepared.head.tombstone ? null : generation.raw;
        });
      },
      readCompanion({lease: lease, logicalId: logicalId, offset: offset, maxBytes: maxBytes}) {
        return pinTransaction(() => {
          if (maxBytes > pinLimits.maxChunkBytes) fail("chunk_limit");
          const {generation: generation} = pinned(lease);
          const row = roots.isRoot(generation.manifest) ? one("SELECT descriptor_json FROM generation_items WHERE generation_id=? AND logical_id=?",lease.generationId,logicalId) : null;
          const d = roots.isRoot(generation.manifest) ? (row ? roots.descriptor(logicalId) : null) : generation.manifest.items.find(d => d.logicalId === logicalId);
          if(row && row.descriptor_json!==stable(d))fail("root_closure_integrity");
          if (!d) fail("companion_not_in_closure");
          const chunk = readChunk(d, offset, maxBytes);
          leaseFresh(lease);
          return chunk;
        });
      },
      readClosurePage({lease,cursor,maxItems,maxBytes}) {
        return pinTransaction(()=>{
          if(maxItems>pinLimits.maxPageItems||maxBytes>pinLimits.maxPageBytes)fail('page_limit');
          const {generation}=pinned(lease),m=generation.manifest;
          const start=cursor===null?0:Number(cursor);if(!Number.isSafeInteger(start)||start<0||cursor!==null&&String(start)!==cursor)fail('closure_cursor_invalid');
          const total=one('SELECT COUNT(*) n FROM generation_items WHERE generation_id=?',lease.generationId).n;if(start>total)fail('closure_cursor_invalid');
          const items=[];let ordinal=start;
          for(const row of iterate('SELECT * FROM generation_items WHERE generation_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?',lease.generationId,start,maxItems)){
            const d=roots.descriptor(row.logical_id);if(!d||row.ordinal!==ordinal||row.descriptor_json!==stable(d))fail('root_closure_integrity');
            const candidate={generationId:lease.generationId,manifestDigest:m.manifestDigest,items:[...items,d],nextCursor:ordinal+1===total?null:String(ordinal+1),proof:roots.isRoot(m)?roots.proof(m):null};
            if(Buffer.byteLength(stable(candidate))>maxBytes){if(!items.length)fail('page_item_byte_limit');break;}items.push(d);ordinal++;
          }
          const result={generationId:lease.generationId,manifestDigest:m.manifestDigest,items,nextCursor:ordinal===total?null:String(ordinal),proof:roots.isRoot(m)?roots.proof(m):null};if(Buffer.byteLength(stable(result))>maxBytes)fail('page_byte_limit');leaseFresh(lease);return result;
        });
      },
      findCompanions({lease,schema,cursor,maxItems,maxBytes}) {
        return pinTransaction(()=>{if(!Object.hasOwn(C.ITEM_SCHEMA_DOMAINS,schema)||maxItems>pinLimits.maxPageItems||maxBytes>pinLimits.maxPageBytes)fail('page_limit');const {generation}=pinned(lease),start=cursor===null?-1:Number(cursor);if(!Number.isSafeInteger(start)||start< -1||cursor!==null&&String(start)!==cursor)fail('closure_cursor_invalid');const items=[];let last=start;
          for(const row of iterate("SELECT * FROM generation_items WHERE generation_id=? AND ordinal>? AND json_extract(descriptor_json,'$.schema')=? ORDER BY ordinal LIMIT ?",lease.generationId,start,schema,maxItems)){const d=roots.descriptor(row.logical_id);if(!d||row.descriptor_json!==stable(d))fail('root_closure_integrity');if(Buffer.byteLength(stable({items:[...items,d]}))+512>maxBytes){if(!items.length)fail('page_item_byte_limit');break;}items.push(d);last=row.ordinal;}
          const more=one("SELECT 1 found FROM generation_items WHERE generation_id=? AND ordinal>? AND json_extract(descriptor_json,'$.schema')=? LIMIT 1",lease.generationId,last,schema);const result={generationId:lease.generationId,manifestDigest:generation.manifest.manifestDigest,items,nextCursor:more?String(last):null};if(Buffer.byteLength(stable(result))>maxBytes)fail('page_byte_limit');leaseFresh(lease);return result;});
      },
      readRootManifest(lease) {return pinTransaction(()=>{const {generation}=pinned(lease);if(!roots.isRoot(generation.manifest))return {schema:'wm.root-source.v1',baseGenerationId:lease.generationId,manifest:null,proof:null};return {schema:'wm.root-source.v1',baseGenerationId:lease.generationId,manifest:clone(generation.manifest),proof:roots.proof(generation.manifest)};});},
      release(lease) {
        return pinTransaction(() => {
          const {record: record} = pinned(lease);
          record.status = "released";
          storePin(record);
        });
      },
      observeHeads(scopes, options) {
        return pinTransaction(() => {
          boot();
          // A1 stable JSON of the complete typed wire request includes any supplied lease array.
                    const observationRequest = options === undefined ? {
            scopes: scopes
          } : {
            scopes: scopes,
            options: options
          };
          if (Buffer.byteLength(stable(observationRequest)) > pinLimits.maxBatchBytes) fail("batch_limit");
          if (options) options.leases.forEach((l, i) => {
            pinned(l);
            if (l.scope !== scopes[i]) fail("lease_scope_conflict");
          });
          const heads = scopes.map(scope => {
            const h = head(scope, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes);
            if (!h) fail("scope_missing");
            return h;
          });
          // Check again after all I/O: expiry during a final observation is never a healthy ACK.
                    if (options) options.leases.forEach(l => pinned(l));
          if (Buffer.byteLength(stable(heads)) > pinLimits.maxBatchBytes) fail("batch_limit");
          if (options) {
            // Complete all DB/closure work first, then check every lease at one common time.
            boot();
            const finalRouteGeneration = route().routeGeneration, finalWriterEpoch = epoch();
            const finalTime = pinNow();
            for (const lease of options.leases) {
              if (finalTime < lease.issuedAt || finalTime >= lease.expiresAt) fail("lease_expired");
              if (lease.routeGeneration !== finalRouteGeneration || lease.writerEpoch !== finalWriterEpoch) fail("lease_lifecycle_conflict");
            }
          }
          return heads;
        });
      },
      openInventory({routeGeneration: routeGeneration}) {
        return pinTransaction(() => {
          boot();
          if (route().routeGeneration !== routeGeneration) fail("route_generation_conflict");
          const issuedAt = pinNow(), expiresAt = expiry(issuedAt, pinLimits.inventoryTtlMs);
          const count = one("SELECT COUNT(*) AS n FROM inventory_snapshots WHERE json_extract(snapshot_json,'$.expiresAt')>? AND json_extract(snapshot_json,'$.status')='active' AND json_extract(snapshot_json,'$.bootGeneration')=? AND json_extract(snapshot_json,'$.snapshot.routeGeneration')=? AND json_extract(snapshot_json,'$.writerEpoch')=?", issuedAt, storeBootGeneration, route().routeGeneration, epoch()).n;
          if (count >= pinLimits.maxSnapshots) fail("snapshot_capacity");
          const domainCounts = Object.fromEntries(C.DOMAINS.map(d => [ d, 0 ])), domainBytes = Object.fromEntries(C.DOMAINS.map(d => [ d, 0 ]));
          let totalItems = 0, totalBytes = 0;
          function countItem(d) {
            totalItems = add(totalItems, 1);
            totalBytes = add(totalBytes, d.bytes);
            domainCounts[d.domain] = add(domainCounts[d.domain], 1);
            domainBytes[d.domain] = add(domainBytes[d.domain], d.bytes);
            if (totalItems > pinLimits.maxInventoryItems) fail("inventory_item_limit");
            if (totalBytes > pinLimits.maxInventoryBytes) fail("inventory_byte_limit");
          }
          // Metadata preflight is streamed before payload scans, so overflow never hides behind allocation.
                    for (const r of iterate("SELECT scope FROM heads ORDER BY scope")) {
            const h = head(r.scope, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes), g = verifyGeneration(h.generationId, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes);
            if (h.utf8Bytes > pinLimits.maxCanonicalBytes || (g.manifest.items?.length||0) > pinLimits.maxGenerationItems) fail("pin_limit");
            if (!knownEmpty(h)) countItem(canonicalDescriptor(h, g));
          }
          for (const r of iterate("SELECT logical_id FROM inventory_items ORDER BY logical_id")) countItem(descriptorOnly(r.logical_id));
          const snapshotId = "snapshot-" + crypto.randomUUID();
          const snapshot = {
            snapshotId: snapshotId,
            routeGeneration: routeGeneration,
            inventoryDigest: "0".repeat(64),
            complete: true,
            domainCounts: domainCounts,
            domainBytes: domainBytes
          };
          const state = {
            schema: "wm.inventory-state.v1",
            snapshot: snapshot,
            identity: physicalIdentity(identity),
            bootId: bootId,
            bootGeneration: storeBootGeneration,
            writerEpoch: epoch(),
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            status: "active",
            totalItems: totalItems,
            nextOrdinal: 0,
            nextCursor: null,
            started: false,
            finished: false
          };
          run("INSERT INTO inventory_snapshots VALUES (?,?,?,?)", snapshotId, routeGeneration, stable(saved(state)), issuedAt);
          let ordinal = 0;
          const hash = crypto.createHash("sha256");
          hash.update("wm.inventory-snapshot.v1\n");
          function include(d, generationId) {
            if (one("SELECT 1 AS found FROM inventory_snapshot_items WHERE snapshot_id=? AND logical_id=?", snapshotId, d.logicalId)) fail("inventory_logical_id_conflict");
            if (!P.validateInventoryItem(d).ok) fail("inventory_descriptor_invalid");
            verifyBlob(d.sha256, d.bytes);
            const json = stable(d);
            hash.update(json + "\n");
            run("INSERT INTO inventory_snapshot_items VALUES (?,?,?,?,?,?,?)", snapshotId, ordinal++, d.logicalId, json, sha(Buffer.from(json)), d.sha256, generationId);
          }
          for (const r of iterate("SELECT scope FROM heads ORDER BY scope")) {
            const h = head(r.scope, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes), g = verifyGeneration(h.generationId, pinLimits.maxChunkBytes, pinLimits.maxGenerationItems, pinLimits.maxCanonicalBytes);
            if (!knownEmpty(h)) include(canonicalDescriptor(h, g), h.generationId);
          }
          for (const r of iterate("SELECT logical_id FROM inventory_items ORDER BY logical_id")) {
            const d = descriptorOnly(r.logical_id);
            for (const id of d.dependencies) if (!descriptorOnly(id)) fail("dependency_missing");
            include(d, null);
          }
          if (ordinal !== totalItems) fail("snapshot_integrity");
          snapshot.inventoryDigest = hash.digest("hex");
          writeSnapshot(state);
          snapshotState(snapshotId);
          return clone(snapshot);
        });
      },
      readInventoryPage({snapshotId: snapshotId, cursor: cursor, maxItems: maxItems, maxBytes: maxBytes}) {
        return pinTransaction(() => {
          if (maxItems > pinLimits.maxPageItems || maxBytes > pinLimits.maxPageBytes) fail("page_limit");
          const state = snapshotState(snapshotId);
          if (state.finished || cursor !== state.nextCursor || state.started && cursor === null) fail("inventory_cursor_replay");
          const rows = iterate("SELECT * FROM inventory_snapshot_items WHERE snapshot_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?", snapshotId, state.nextOrdinal, maxItems);
          const items = [];
          let nextOrdinal = state.nextOrdinal;
          // A single page array is bounded by both negotiated count and encoded-byte ceilings.
                    for (const row of rows) {
            if (row.ordinal !== nextOrdinal) fail("snapshot_item_integrity");
            const d = snapshotDescriptor(row);
            verifyBlob(d.sha256, d.bytes);
            const candidate = {
              snapshotId: snapshotId,
              cursor: cursor,
              nextCursor: nextOrdinal + 1 === state.totalItems ? null : "cursor-" + "x".repeat(36),
              items: [ ...items, d ],
              complete: state.snapshot.complete,
              errors: []
            };
            if (Buffer.byteLength(stable(candidate)) > maxBytes) {
              if (items.length === 0) fail("page_item_byte_limit");
              break;
            }
            items.push(d);
            nextOrdinal++;
          }
          if (nextOrdinal === state.nextOrdinal && nextOrdinal < state.totalItems) fail("snapshot_item_missing");
          const nextCursor = nextOrdinal === state.totalItems ? null : "cursor-" + crypto.randomUUID();
          snapshotState(snapshotId);
          const page = {
            snapshotId: snapshotId,
            cursor: cursor,
            nextCursor: nextCursor,
            items: items,
            complete: state.snapshot.complete,
            errors: []
          };
          if (Buffer.byteLength(stable(page)) > maxBytes) fail("page_byte_limit");
          state.nextOrdinal = nextOrdinal;
          state.nextCursor = nextCursor;
          state.started = true;
          state.finished = nextCursor === null;
          writeSnapshot(state);
          return page;
        });
      },
      readInventoryChunk({snapshotId: snapshotId, logicalId: logicalId, offset: offset, maxBytes: maxBytes}) {
        return pinTransaction(() => {
          if (maxBytes > pinLimits.maxChunkBytes) fail("chunk_limit");
          snapshotState(snapshotId);
          const row = one("SELECT * FROM inventory_snapshot_items WHERE snapshot_id=? AND logical_id=?", snapshotId, logicalId);
          if (!row) fail("snapshot_item_missing");
          const chunk = readChunk(snapshotDescriptor(row), offset, maxBytes);
          snapshotState(snapshotId);
          return chunk;
        });
      },
      closeInventory(snapshotId) {
        return pinTransaction(() => {
          const state = snapshotState(snapshotId);
          state.status = "closed";
          writeSnapshot(state);
        });
      }
    };
  }

  const migrationKey=id=>'migration-stage:'+id;
  function stageState(v) { if(meta("restore-admission")!==undefined)fail("historical_stage_not_executable"); const ds=Object.getOwnPropertyDescriptors(v||{});if(!v||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).some(k=>typeof k!=="string"||!ds[k].enumerable||!Object.hasOwn(ds[k],"value")))fail("non_plain_data");plain(Object.fromEntries(Object.keys(ds).map(k=>[k,k==="bytes"?null:ds[k].value])));if(!token(v.operationId)||!digest(v.requestFingerprint))fail('migration_identity_invalid');const raw=meta(migrationKey(v.operationId));if(raw===undefined)fail('migration_stage_unknown');const s=JSON.parse(raw);if(s.requestFingerprint!==v.requestFingerprint)fail('operation_identity_conflict');return s; }
  function stageItems(s){return all("SELECT value FROM metadata WHERE substr(key,1,?)=? ORDER BY key",('migration-item:'+sha(Buffer.from(s.operationId))+':').length,'migration-item:'+sha(Buffer.from(s.operationId))+':').map(r=>JSON.parse(r.value)).sort((a,b)=>a.ordinal-b.ordinal);}
  function saveStage(s){setMeta(migrationKey(s.operationId),stable(s));}
  function verifyStage(s){const rows=stageItems(s),counts=Object.fromEntries(C.DOMAINS.map(d=>[d,0])),bytes=Object.fromEntries(C.DOMAINS.map(d=>[d,0])),hash=crypto.createHash('sha256');hash.update('wm.inventory-snapshot.v1\n');const ids=new Map(rows.map(r=>[r.descriptor.logicalId,r.descriptor]));
    for(const row of rows){const d=row.descriptor;if(!P.validateInventoryItem(d).ok||row.offset!==d.bytes)fail('migration_item_incomplete');const payloadHash=crypto.createHash('sha256');let size=0;for(const chunk of row.chunks){const data=blob(chunk.sha256,chunk.bytes);payloadHash.update(data);size+=data.length;}if(size!==d.bytes||payloadHash.digest('hex')!==d.sha256)fail('migration_payload_integrity');for(const id of d.dependencies)if(!ids.has(id))fail('dependency_missing');counts[d.domain]++;if(bytes[d.domain]>Number.MAX_SAFE_INTEGER-d.bytes)fail('byte_total_overflow');bytes[d.domain]+=d.bytes;hash.update(stable(d)+'\n');}
    const active=new Set(),done=new Set();for(const id of ids.keys()){const stack=[[id,false]];while(stack.length){const [next,exit]=stack.pop();if(exit){active.delete(next);done.add(next);continue;}if(active.has(next))fail('dependency_cycle');if(done.has(next))continue;active.add(next);stack.push([next,true]);for(const dep of ids.get(next).dependencies)stack.push([dep,false]);}}
    if(hash.digest('hex')!==s.snapshot.inventoryDigest||!equal(counts,s.snapshot.domainCounts)||!equal(bytes,s.snapshot.domainBytes))fail('migration_inventory_mismatch');return {rows,counts,bytes};
  }
  function migrationPayload(row){const d=row.descriptor;if(d.bytes>limits.maxGenerationBytes)fail('migration_item_capacity');return Buffer.concat(row.chunks.map(c=>blob(c.sha256,c.bytes)),d.bytes);}
  function installHandoffCopy(row){
    const d=row.descriptor,key='handoff-copy:'+sha(Buffer.from(d.logicalId)),old=meta(key);
    if(old!==undefined){const copy=JSON.parse(old);if(!equal(copy.descriptor,d))fail('handoff_copy_conflict');readHandoffCopy(d,0,0);return;}
    const chunks=[];
    for(const chunk of row.chunks){const payload=blob(chunk.sha256,chunk.bytes),chunkKey=key+':chunk:'+chunk.offset;
      // Independent byte records. Source/shared blob references are not the target representation.
      run('INSERT INTO metadata(key,value) VALUES (?,?)',chunkKey,stable({encoding:'base64',data:payload.toString('base64'),offset:chunk.offset,bytes:payload.length,sha256:sha(payload)}));chunks.push(chunkKey);}
    run('INSERT INTO metadata(key,value) VALUES (?,?)',key,stable({schema:'wm.handoff-copy.v1',descriptor:d,chunks}));
  }
  function readHandoffCopy(d,offset,maxBytes){
    const value=meta('handoff-copy:'+sha(Buffer.from(d.logicalId)));if(value===undefined)fail('handoff_copy_missing');const copy=JSON.parse(value);
    if(copy.schema!=='wm.handoff-copy.v1'||!equal(copy.descriptor,d)||!Array.isArray(copy.chunks)||!Number.isSafeInteger(offset)||offset<0||offset>d.bytes||!Number.isSafeInteger(maxBytes)||maxBytes<0)fail('handoff_copy_integrity');
    const hash=crypto.createHash('sha256'),parts=[];let total=0;const end=Math.min(d.bytes,offset+maxBytes);
    for(const key of copy.chunks){const raw=meta(key);if(raw===undefined)fail('handoff_copy_missing');const chunk=JSON.parse(raw),payload=Buffer.from(chunk.data,'base64');
      if(chunk.encoding!=='base64'||chunk.offset!==total||payload.length!==chunk.bytes||payload.length>limits.maxMigrationChunkBytes||payload.toString('base64')!==chunk.data||sha(payload)!==chunk.sha256)fail('handoff_copy_integrity');
      hash.update(payload);if(maxBytes&&total<end&&total+payload.length>offset)parts.push(payload.subarray(Math.max(0,offset-total),Math.min(payload.length,end-total)));total+=payload.length;}
    if(total!==d.bytes||hash.digest('hex')!==d.sha256)fail('handoff_copy_integrity');const bytes=Buffer.concat(parts);return {bytes:Uint8Array.from(bytes),offset,nextOffset:offset+bytes.length===d.bytes?null:offset+bytes.length,totalBytes:d.bytes,sha256:d.sha256};
  }
  const handoffCall=(method,value)=>handoffEngine[method](value);
  let manualStore = null;
  const store = Object.freeze({
    manual(action,input) { if(meta("restore-admission")!==undefined)fail("restore_recovery_required");if(route().state!=="active")fail("dataset_fenced");if(!manualStore)manualStore=require("./manual.cjs").createManualStore({transaction,meta,setMeta,all,storeBlob,blob,sha,stable,fresh,fail,identity,limits});return manualStore(action,input); },
    beginPageStage:roots.beginPageStage,renewPageStage:roots.renewPageStage,stagePage:roots.stagePage,readStagedPage:roots.readStagedPage,
    beginHandoffStage:v=>handoffCall('begin',v),stageHandoffChunk:v=>handoffCall('chunk',v),handoffStageStatus:v=>handoffCall('stageStatus',v),verifyHandoffStage:v=>handoffCall('verify',v),
    materializeHandoffStage:v=>handoffCall('materialize',v),verifyHandoffReadback:v=>handoffCall('readback',v),completeHandoff:v=>handoffCall('complete',v),handoffStatus:v=>handoffCall('status',v),abortHandoffStage:v=>handoffCall('abort',v),rollbackHandoff:v=>handoffCall('rollback',v),
    inspectMigrationDestination() {return transaction(()=>{const existing=one('SELECT COUNT(*) n FROM heads').n+one('SELECT COUNT(*) n FROM inventory_items').n;return {ok:true,backendId:identity.backendId,datasetId:identity.datasetId,targetHasExistingData:existing>0,availableBytes:limits.maxMigrationBytes,activationEnabled:false,route:clone(route())};});},
    beginMigrationStage(v) {request(v,['operationId','requestFingerprint','sourceRoute','targetRoute','snapshot']);checked(v.sourceRoute,C.validateRoute);checked(v.targetRoute,C.validateRoute);keys(v.snapshot,C.DTO_KEYS.InventorySnapshot);if(!token(v.snapshot.snapshotId)||!digest(v.snapshot.inventoryDigest)||v.snapshot.complete!==true||!C.validateDomainTotals(v.snapshot.domainCounts).ok||!C.validateDomainTotals(v.snapshot.domainBytes).ok)fail('migration_snapshot_invalid');
      return transaction(()=>{const old=meta(migrationKey(v.operationId));if(old!==undefined){const s=stageState(v);if(!equal(s.sourceRoute,v.sourceRoute)||!equal(s.targetRoute,v.targetRoute)||s.snapshot.inventoryDigest!==v.snapshot.inventoryDigest)fail('operation_identity_conflict');return {ok:true,copiedBytes:s.copiedBytes};}
        if(v.targetRoute.mode!=='server_only'||v.targetRoute.datasetId!==identity.datasetId||v.targetRoute.backendId!==identity.backendId||one('SELECT COUNT(*) n FROM heads').n||one('SELECT COUNT(*) n FROM inventory_items').n||meta('migration-owner')!==undefined)fail('destination_existing_data');let n=0,b=0;for(const d of C.DOMAINS){n+=v.snapshot.domainCounts[d];if(b>Number.MAX_SAFE_INTEGER-v.snapshot.domainBytes[d])fail('byte_total_overflow');b+=v.snapshot.domainBytes[d];}if(n>limits.maxMigrationItems||b>limits.maxMigrationBytes)fail('migration_capacity');
        const current=route();if(current.state!=='active')fail('dataset_fenced');setRoute({...current,state:'fenced'});setMeta('writer_epoch',fresh('epoch'));setMeta('migration-owner',v.operationId);saveStage({...clone(v),copiedBytes:0,itemCount:0,state:'copying',targetFenceRoute:route()});return {ok:true,copiedBytes:0};});},
    migrationStageStatus(v) {plain(v);keys(v,Object.hasOwn(v,'logicalId')?['operationId','requestFingerprint','logicalId']:['operationId','requestFingerprint']);return transaction(()=>{const s=stageState(v);if(!v.logicalId)return {ok:true,copiedBytes:s.copiedBytes,state:s.state};if(!token(v.logicalId))fail('logical_id_invalid');const raw=meta('migration-item:'+sha(Buffer.from(s.operationId))+':'+v.logicalId),r=raw===undefined?null:JSON.parse(raw);return {ok:true,copiedBytes:s.copiedBytes,offset:r?.offset||0,complete:!!r&&r.offset===r.descriptor.bytes};});},
    stageMigrationChunk(v) {const ds=Object.getOwnPropertyDescriptors(v||{});if(!v||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).some(k=>typeof k!=='string'||!ds[k].enumerable||!Object.hasOwn(ds[k],'value'))||!ds.bytes)fail('migration_chunk_invalid');const payload=ownedBytes(ds.bytes.value),metaInput={...v,bytes:null};plain(metaInput);keys(metaInput,['operationId','requestFingerprint','descriptor','offset','bytes']);if(!P.validateInventoryItem(v.descriptor).ok||!Number.isSafeInteger(v.offset)||v.offset<0||payload.length>limits.maxMigrationChunkBytes||v.offset>Number.MAX_SAFE_INTEGER-payload.length||v.offset+payload.length>v.descriptor.bytes||payload.length===0&&v.descriptor.bytes!==0)fail('migration_chunk_invalid');
      return transaction(()=>{const s=stageState(v);if(s.kind==='handoff'&&handoffWriting!==s.operationId)fail('handoff_action_required');const key='migration-item:'+sha(Buffer.from(s.operationId))+':'+v.descriptor.logicalId,old=meta(key),row=old===undefined?{descriptor:clone(v.descriptor),ordinal:s.itemCount,offset:0,chunks:[]}:JSON.parse(old);if(!equal(row.descriptor,v.descriptor))fail('migration_descriptor_conflict');const hash=sha(payload);if(v.offset<row.offset){const prior=row.chunks.find(c=>c.offset===v.offset);if(!prior||prior.sha256!==hash||prior.bytes!==payload.length)fail('migration_chunk_conflict');return {ok:true,copiedBytes:s.copiedBytes,offset:row.offset,complete:row.offset===row.descriptor.bytes};}if(s.state!=='copying'||(s.kind==='handoff'?JSON.parse(meta('handoff-target:'+sha(Buffer.from(s.targetIdentity.scope)))||'null')?.operationId!==s.operationId:meta('migration-owner')!==s.operationId)||!equal(route(),s.targetFenceRoute)||v.offset!==row.offset)fail('migration_stage_conflict');if(old===undefined){s.itemCount++;if(s.itemCount>limits.maxMigrationItems)fail('migration_capacity');}storeBlob(payload,hash);row.chunks.push({offset:v.offset,bytes:payload.length,sha256:hash});row.offset+=payload.length;if(s.copiedBytes>Number.MAX_SAFE_INTEGER-payload.length)fail('byte_total_overflow');s.copiedBytes+=payload.length;if(s.copiedBytes>limits.maxMigrationBytes)fail('migration_capacity');setMeta(key,stable(row));saveStage(s);return {ok:true,copiedBytes:s.copiedBytes,offset:row.offset,complete:row.offset===row.descriptor.bytes};});},
    verifyMigrationStage(v) {return transaction(()=>{const s=stageState(v);if(s.kind==='handoff')fail('handoff_action_required');verifyStage(s);return {ok:true,inventoryDigest:s.snapshot.inventoryDigest,domainCounts:s.snapshot.domainCounts,domainBytes:s.snapshot.domainBytes};});},
    materializeMigrationStage(v) {const s=transaction(()=>{const s=stageState(v);if(s.kind==='handoff')fail('handoff_action_required');verifyStage(s);return s;});if(s.state==='materialized')return {ok:true};if(meta('migration-owner')!==s.operationId||!equal(route(),s.targetFenceRoute))fail('migration_stage_conflict');
      migrationWriting=s.operationId;try{const rows=stageItems(s),canonical=rows.filter(r=>r.descriptor.domain==='canonical'),scopes=new Set(rows.map(r=>r.descriptor.originScope));
        for(const scope of scopes){const initial={scope,operationId:s.operationId+':init:'+sha(Buffer.from(scope)).slice(0,24),routeGeneration:route().routeGeneration,writerEpoch:epoch(),expectedEmpty:true};initial.requestFingerprint=fingerprint(initial);const existing=head(scope);if(!existing){const result=store.initializeScope(initial);if(result.status!=='committed')fail('migration_scope_initialization');}}
        transaction(()=>{for(const row of rows.filter(r=>r.descriptor.domain!=='canonical')){const d=row.descriptor,bytes=migrationPayload(row);storeBlob(bytes,d.sha256);const existing=inventoryDescriptor(d.logicalId);if(existing&&!equal(existing,d))fail('migration_descriptor_conflict');if(!existing){const json=stable(d);run('INSERT INTO inventory_items VALUES (?,?,?,?)',d.logicalId,json,sha(Buffer.from(json)),d.sha256);}}setMeta('inventory_revision',fresh('inventory'));});
        for(const row of canonical){const d=row.descriptor,operationId=s.operationId+':canonical:'+sha(Buffer.from(d.originScope)).slice(0,24),existing=one('SELECT request_fingerprint FROM operations WHERE operation_id=?',operationId);if(existing){const result=store.status({operationId,requestFingerprint:existing.request_fingerprint});if(result.status!=='committed')fail('migration_canonical_uncertain');continue;}
          const expectedHead=head(d.originScope),ids=new Set(),stack=[...d.dependencies];while(stack.length){const id=stack.pop();if(ids.has(id))continue;ids.add(id);const item=inventoryDescriptor(id);if(!item)fail('dependency_missing');stack.push(...item.dependencies);}const items=[...ids].map(id=>inventoryDescriptor(id)).sort((a,b)=>Buffer.compare(Buffer.from(a.logicalId),Buffer.from(b.logicalId)));const raw=d.disposition.tombstone?null:migrationPayload(row).toString('utf8');
          const manifest={schema:C.MANIFEST_SCHEMA,scope:d.originScope,generationId:fresh('generation'),canonical:{sha256:d.sha256,utf8Bytes:d.bytes},items,routeGeneration:route().routeGeneration,writerEpoch:epoch(),expectedHead,operationId};manifest.manifestDigest=sha(Buffer.from(stable(manifest)));const input={operationId,operation:raw===null?'remove':'migration',scope:d.originScope,expectedHead,routeGeneration:route().routeGeneration,writerEpoch:epoch(),raw,manifest};input.requestFingerprint=fingerprint(input);const prepared=store.prepare(input),result=store.publish(prepared);if(result.status!=='committed')fail('migration_canonical_uncommitted');transaction(()=>setMeta('migration-canonical:'+sha(Buffer.from(d.originScope)),stable({head:result.receipt.head,descriptor:d})));}
        transaction(()=>{for(const scope of scopes)if(!canonical.some(r=>r.descriptor.originScope===scope)){const marker=rows.find(r=>r.descriptor.originScope===scope&&r.descriptor.logicalId==='scope-'+sha(Buffer.from(scope)));if(!marker)fail('migration_empty_scope_unproven');const body=JSON.parse(migrationPayload(marker).toString('utf8')),absence=JSON.parse(body.raw);if(body.schema!=='wm.orphan.v1'||absence.scopeKey!==scope||absence.canonicalPresent!==false)fail('migration_empty_scope_unproven');const h=head(scope);if(!h.tombstone)fail('migration_empty_scope_conflict');setMeta('migration-empty:'+sha(Buffer.from(scope)),stable(h));}s.state='materialized';saveStage(s);});return {ok:true};
      }finally{migrationWriting=null;}},
    verifyMigrationReadback(v) {return transaction(()=>{const s=stageState(v);if(s.kind==='handoff')fail('handoff_action_required');const verified=verifyStage(s);if(s.state!=='materialized')fail('migration_not_materialized');for(const row of verified.rows){const d=row.descriptor;if(d.domain==='canonical'){const h=head(d.originScope),g=verifyGeneration(h.generationId);if(h.sha256!==d.sha256||h.utf8Bytes!==d.bytes||h.tombstone!==d.disposition.tombstone||!equal(JSON.parse(meta("migration-canonical:"+sha(Buffer.from(h.scope)))||"null")?.descriptor,d))fail('migration_readback_mismatch');}else{if(!equal(inventoryDescriptor(d.logicalId),d))fail('migration_readback_mismatch');blob(d.sha256,d.bytes,limits.maxMigrationChunkBytes);}}
       const expectedScopes=new Set(verified.rows.map(r=>r.descriptor.originScope));if(one('SELECT COUNT(*) n FROM heads').n!==expectedScopes.size||one('SELECT COUNT(*) n FROM inventory_items').n!==verified.rows.filter(r=>r.descriptor.domain!=='canonical').length)fail('migration_readback_extra');return {ok:true,inventoryDigest:s.snapshot.inventoryDigest,domainCounts:verified.counts,domainBytes:verified.bytes,sealedInventoryDigest:inventoryDigest(),route:clone(route())};});},

    // A4-R21: read-only current lifecycle/health, no initialization or authority mutation.
    assertLegacyBackupSupported(){usable();if(one("SELECT 1 found FROM generations WHERE json_extract(manifest_json,'$.schema')=? LIMIT 1",C.ROOT_MANIFEST_SCHEMA))fail('paged_history_backup_requires_streaming_v2');return true;},
    readLifecycleState() {
      return transaction(()=>{if(meta('schema')!=='wm.sqlite.v1'||meta('identity')!==stable(identity)||!token(epoch())||!token(meta('inventory_revision')))fail('dataset_integrity');const current=route();return {identity:physicalIdentity(identity),route:clone(current),writerEpoch:epoch(),inventoryRevision:meta('inventory_revision'),health:{ok:true},...(meta('restore-admission')!==undefined?{restoreAdmission:JSON.parse(meta('restore-admission'))}:{})};});
    },
    readDatasetState() {
      usable();
      db.exec("BEGIN");
      try {
        if (one("PRAGMA integrity_check")?.integrity_check !== "ok" || meta("schema") !== "wm.sqlite.v1" || meta("identity") !== stable(identity) || !token(epoch()) || !token(meta("inventory_revision"))) fail("dataset_integrity");
        const current = route();
        for (const row of iterate("SELECT scope FROM heads ORDER BY scope")) head(row.scope);
        for (const row of iterate("SELECT logical_id FROM inventory_items ORDER BY logical_id")) {
          const descriptor = inventoryDescriptor(row.logical_id, 262144);
          for (const dependency of descriptor.dependencies) if (!inventoryDescriptor(dependency, 262144)) fail("dependency_integrity");
        }
        const result = {identity:physicalIdentity(identity),route:clone(current),writerEpoch:epoch(),inventoryRevision:meta("inventory_revision"),health:{ok:true},...(meta("restore-admission")!==undefined?{restoreAdmission:JSON.parse(meta("restore-admission"))}:{})};
        db.exec("COMMIT");
        return result;
      } catch (error) { try { db.exec("ROLLBACK"); } catch (_) {} throw error; }
    },
    initializeScope(input) {
      request(input, [ "scope", "operationId", "requestFingerprint", "routeGeneration", "writerEpoch", "expectedEmpty" ]);
      if (typeof input.scope !== "string" || !input.scope.isWellFormed() || !input.scope || Buffer.byteLength(input.scope) > 1024 || input.expectedEmpty !== true || !token(input.routeGeneration) || !token(input.writerEpoch)) fail("initialize_invalid");
      try {
        return transaction(() => {
          historicalExecution(input);
          const previous = operation(input.operationId, input.requestFingerprint);
          if (previous) return previous;
          try {
            checkWriteFence(input);
          } catch (e) {
            if (e.code?.startsWith("WM_")) return conflict(input, e.message, "initialize");
            throw e;
          }
          if (head(input.scope) || one("SELECT generation_id FROM generations WHERE scope=? LIMIT 1", input.scope)) return conflict(input, "scope_not_empty", "initialize");
          const h = {
            protocol: C.PROTOCOL,
            authorityId: identity.authorityId,
            storeId: identity.storeId,
            scope: input.scope,
            epoch: epoch(),
            revision: fresh("revision"),
            schema: C.CANONICAL_SCHEMA,
            generationId: fresh("generation"),
            sha256: sha(Buffer.alloc(0)),
            utf8Bytes: 0,
            tombstone: true
          };
          const manifest = {
            schema: C.MANIFEST_SCHEMA,
            scope: input.scope,
            generationId: h.generationId,
            canonical: {
              sha256: h.sha256,
              utf8Bytes: 0
            },
            items: [],
            routeGeneration: input.routeGeneration,
            writerEpoch: input.writerEpoch,
            expectedHead: h,
            operationId: input.operationId
          };
          manifest.manifestDigest = sha(Buffer.from(stable(manifest)));
          const synthetic = {
            operationId: input.operationId,
            requestFingerprint: input.requestFingerprint,
            operation: "initialize",
            scope: input.scope,
            expectedHead: h,
            routeGeneration: input.routeGeneration,
            writerEpoch: input.writerEpoch,
            raw: null,
            manifest: manifest
          };
          const p = {
            preparedId: fresh("prepared"),
            operationId: input.operationId,
            operation: "initialize",
            scope: input.scope,
            rawSha256: h.sha256,
            expectedHead: h,
            head: h,
            requestFingerprint: input.requestFingerprint
          };
          putGeneration(synthetic, p);
          setHead(h);
          return saveOperation(input, "initialize", statusValue("committed", input.operationId, input.requestFingerprint, {
            head: h
          }));
        });
      } catch (e) {
        if (e.code?.startsWith("WM_")) throw e;
        return uncertain(input);
      }
    },
    prepare(input) {
      checked(input, C.validateOperation);
      input = clone(input);
      try {
        return transaction(() => {
          historicalExecution(input);
          const previous = operation(input.operationId, input.requestFingerprint);
          if (previous) {
            if (previous.status === "conflict") return previous;
            const op = one("SELECT prepared_id FROM operations WHERE operation_id=?", input.operationId);
            if (!op.prepared_id) return statusValue("conflict", input.operationId, input.requestFingerprint, {
              reason: "operation_kind_conflict"
            });
            const g = one("SELECT prepared_json,prepared_sha256 FROM generations WHERE generation_id=?", input.manifest.generationId);
            if (!g || sha(Buffer.from(g.prepared_json)) !== g.prepared_sha256) fail("generation_integrity");
            return JSON.parse(g.prepared_json);
          }
          checkWriteFence(input);
          const h = head(input.scope);
          if (!h) fail("scope_missing");
          verifyGeneration(h.generationId);
          if (!equal(h, input.expectedHead)) fail("expected_head_conflict");
          closure(input.manifest);
          if (one("SELECT generation_id FROM generations WHERE generation_id=?", input.manifest.generationId)) return conflict(input, "generation_id_conflict", "write");
          const nextEpoch = [ "reset", "remove", "restore", "migration", "recovery", "branch" ].includes(input.operation) ? fresh("epoch") : epoch();
          const nextHead = {
            protocol: C.PROTOCOL,
            authorityId: identity.authorityId,
            storeId: identity.storeId,
            scope: input.scope,
            epoch: nextEpoch,
            revision: fresh("revision"),
            schema: C.CANONICAL_SCHEMA,
            generationId: input.manifest.generationId,
            sha256: input.manifest.canonical.sha256,
            utf8Bytes: input.manifest.canonical.utf8Bytes,
            tombstone: input.raw === null
          };
          const p = {
            preparedId: fresh("prepared"),
            operationId: input.operationId,
            operation: input.operation,
            scope: input.scope,
            rawSha256: nextHead.sha256,
            expectedHead: input.expectedHead,
            head: nextHead,
            requestFingerprint: input.requestFingerprint
          };
          putGeneration(input, p);
          saveOperation(input, "write", statusValue("prepared", input.operationId, input.requestFingerprint, {
            preparedId: p.preparedId
          }), p.preparedId);
          return p;
        });
      } catch (e) {
        if (e.code?.startsWith("WM_")) throw e;
        const error = Error("storage_uncertain");
        error.operationId = input.operationId;
        error.requestFingerprint = input.requestFingerprint;
        error.storageCode = e.errcode ?? e.code;
        throw error;
      }
    },
    publish(input) {
      plain(input); historicalExecution(input);
      plain(input);
      keys(input, C.DTO_KEYS.Prepared);
      if (!token(input.operationId) || !digest(input.requestFingerprint)) fail("prepared_invalid");
      try {
        return transaction(() => {
          historicalExecution(input);
          const previous = operation(input.operationId, input.requestFingerprint);
          if (!previous) return uncertain(input);
          if (previous.status !== "prepared") return previous;
          const row = one("SELECT * FROM generations WHERE generation_id=?", input.head?.generationId);
          if (!row) return statusValue("conflict", input.operationId, input.requestFingerprint, {
            reason: "prepared_mismatch"
          });
          if (sha(Buffer.from(row.prepared_json)) !== row.prepared_sha256) fail("generation_integrity");
          const stored = JSON.parse(row.prepared_json);
          if (!equal(stored, input)) return statusValue("conflict", input.operationId, input.requestFingerprint, {
            reason: "prepared_mismatch"
          });
          try {
            // Authenticate all persisted intent/manifest/Prepared bindings before
            // selecting a scope or using intent fields for fence/CAS decisions.
            const verified = verifyGeneration(row.generation_id);
            if(roots.isRoot(verified.manifest))roots.verifyClosure(verified.manifest,true);
            const intent = JSON.parse(verified.row.input_json);
            if (intent.operationId !== input.operationId || intent.requestFingerprint !== input.requestFingerprint || previous.receipt?.preparedId !== input.preparedId) fail("generation_integrity");
            checkWriteFence(intent);
            const current = head(intent.scope);
            if (!current || !equal(current, intent.expectedHead)) return conflict(input, "expected_head_conflict", "write");
            verifyGeneration(current.generationId);
          } catch (e) {
            // Only the verified publication identity may terminalize a receipt.
            // A corrupt intent must never select another operation's row.
            if (e.code?.startsWith("WM_")) return conflict(input, e.message, "write");
            throw e;
          }
          if (stored.head.epoch !== epoch()) setMeta("writer_epoch", stored.head.epoch);
          setHead(stored.head);
          setMeta("inventory_revision", fresh("inventory"));
          return finishOperation(input, statusValue("committed", input.operationId, input.requestFingerprint, {
            head: stored.head
          }));
        });
      } catch (_) {
        return uncertain(input);
      }
    },
    status(input) {
      plain(input);
      keys(input, [ "operationId", "requestFingerprint" ]);
      if (!token(input.operationId) || !digest(input.requestFingerprint)) fail("status_invalid");
      try {
        usable();
        const result=operation(input.operationId, input.requestFingerprint);
        if(result&&meta("restore-historical-operation:"+sha(Buffer.from(input.operationId)))!==undefined)return {...result,receipt:{...(result.receipt||{}),historical:true,executionAuthority:false,restoredIncarnation:JSON.parse(meta("restore-admission")||"null")?.incarnation||null}};
        return result || uncertain(input);
      } catch (_) {
        return uncertain(input);
      }
    },
    readGeneration(input) {
      plain(input);
      keys(input, [ "generationId" ]);
      if (!token(input.generationId)) fail("generation_id_invalid");
      return transaction(() => {
        const result = verifyGeneration(input.generationId);
        const p = JSON.parse(result.row.prepared_json);
        return {
          raw: p.head.tombstone ? null : result.raw,
          manifest: result.manifest
        };
      });
    },
    putInventoryItems(input) {
      // Validate containers without traversing byte views or invoking caller accessors.
      const top = Object.getOwnPropertyDescriptors(input ?? {});
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(k => typeof k !== "string" || !top[k].enumerable || !Object.hasOwn(top[k], "value"))) fail("non_plain_data");
      keys(input, C.DTO_KEYS.InventoryWrite);
      const descriptors = [];
      const container = {
        ...input,
        items: []
      };
      plain(container);
      if (!Array.isArray(input.items) || Object.getPrototypeOf(input.items) !== Array.prototype) fail("non_plain_data");
      const arrayDs = Object.getOwnPropertyDescriptors(input.items);
      if (Reflect.ownKeys(input.items).length !== input.items.length + 1) fail("non_plain_data");
      for (let i = 0; i < input.items.length; i++) {
        const d = arrayDs[i];
        if (!d || !d.enumerable || !Object.hasOwn(d, "value")) fail("non_plain_data");
        const item = d.value, ds = Object.getOwnPropertyDescriptors(item ?? {});
        if (!item || Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(item).some(k => typeof k !== "string" || !ds[k].enumerable || !Object.hasOwn(ds[k], "value"))) fail("non_plain_data");
        keys(item, [ "descriptor", "payload" ]);
        plain(item.descriptor);
        checked(item.descriptor, C.validateItem);
        const targetPending=meta('handoff-target:'+sha(Buffer.from(item.descriptor.originScope)));if(targetPending!==undefined&&JSON.parse(targetPending).state==='pending')fail('handoff_target_pending');
        descriptors.push({
          descriptor: clone(item.descriptor),
          payload: ownedBytes(item.payload)
        });
      }
      const normalized = {
        ...container,
        items: descriptors.map(x => ({
          descriptor: x.descriptor,
          payload: {
            encoding: "base64",
            data: x.payload.toString("base64")
          }
        }))
      };
      request(normalized, C.DTO_KEYS.InventoryWrite);
      if (!token(input.routeGeneration) || !token(input.writerEpoch) || !token(input.expectedInventoryRevision)) fail("inventory_invalid");
      if (descriptors.length > limits.maxInventoryBatchItems) fail("inventory_item_limit");
      const ids = new Map;
      let bytes = 0;
      for (const x of descriptors) {
        const d = x.descriptor;
        if (ids.has(d.logicalId)) fail("inventory_duplicate_logical_id");
        ids.set(d.logicalId, d);
        if (bytes > Number.MAX_SAFE_INTEGER - d.bytes) fail("byte_total_overflow");
        bytes += d.bytes;
        if (bytes > limits.maxInventoryBatchBytes) fail("inventory_byte_limit");
        if (x.payload.length !== d.bytes || sha(x.payload) !== d.sha256) fail("inventory_payload_integrity");
      }
      try {
        return transaction(() => {
          historicalExecution(input);
          const previous = operation(input.operationId, input.requestFingerprint);
          if (previous) return previous;
          try {
            checkWriteFence(input);
          } catch (e) {
            if (e.code?.startsWith("WM_")) return conflict(input, e.message, "inventory");
            throw e;
          }
          if (meta("inventory_revision") !== input.expectedInventoryRevision) return conflict(input, "inventory_revision_conflict", "inventory");
          for (const {descriptor: d} of descriptors) {
            if (d.domain === "cold" && !head(d.originScope)) fail("scope_missing");
            for (const dep of d.dependencies) if (!ids.has(dep) && !inventoryDescriptor(dep)) fail("dependency_missing");
            const old = inventoryDescriptor(d.logicalId);
            if (old && !equal(old, d)) return conflict(input, "inventory_descriptor_conflict", "inventory");
          }
          const active = new Set, done = new Set;
          for (const id of ids.keys()) {
            const stack = [ [ id, false ] ];
            while (stack.length) {
              const [next, exit] = stack.pop();
              if (exit) {
                active.delete(next);
                done.add(next);
                continue;
              }
              if (active.has(next)) fail("dependency_cycle");
              if (done.has(next)) continue;
              active.add(next);
              stack.push([ next, true ]);
              const descriptor = ids.get(next) || inventoryDescriptor(next);
              if (!descriptor) fail("dependency_missing");
              for (const dependency of descriptor.dependencies) stack.push([ dependency, false ]);
            }
          }
          for (const x of descriptors) {
            const d = x.descriptor;
            storeBlob(x.payload, d.sha256);
            if (!one("SELECT logical_id FROM inventory_items WHERE logical_id=?", d.logicalId)) {
              const json = stable(d);
              run("INSERT INTO inventory_items VALUES (?,?,?,?)", d.logicalId, json, sha(Buffer.from(json)), d.sha256);
            }
          }
          const revision = fresh("inventory");
          setMeta("inventory_revision", revision);
          return saveOperation(input, "inventory", statusValue("committed", input.operationId, input.requestFingerprint, {
            inventoryRevision: revision,
            writerEpoch: epoch(),
            routeGeneration: route().routeGeneration,
            items: descriptors.length,
            bytes: bytes
          }));
        });
      } catch (e) {
        if (e.code?.startsWith("WM_")) throw e;
        return uncertain(input);
      }
    },
    fenceDataset(input) {
      request(input, C.DTO_KEYS.FenceInput);
      checked(input.expectedRoute, C.validateRoute);
      try {
        return transaction(() => {
          historicalExecution(input);
          const previous = operation(input.operationId, input.requestFingerprint);
          if (previous) return previous;
          const current = route();
          if (!equal(current, input.expectedRoute) || current.state !== "active") return conflict(input, "route_conflict", "fence");
          const fenced = {
            ...current,
            state: "fenced"
          };
          const sealed = inventoryDigest();
          setRoute(fenced);
          setMeta("writer_epoch", fresh("epoch"));
          const receipt = {
            schema: "wm.dataset-fence-receipt.v1",
            operationId: input.operationId,
            requestFingerprint: input.requestFingerprint,
            identity: physicalIdentity(identity),
            sourceRoute: current,
            route: fenced,
            writerEpoch: epoch(),
            inventoryRevision: meta("inventory_revision"),
            inventoryDigest: sealed
          };
          return saveOperation(input, "fence", statusValue("committed", input.operationId, input.requestFingerprint, receipt));
        });
      } catch (e) {
        if (e.code?.startsWith("WM_")) throw e;
        return uncertain(input);
      }
    },
    activateDataset(input) {
      request(input, C.DTO_KEYS.ActivateInput);
      checked(input.expectedRoute, C.validateRoute);
      checked(input.targetRoute, C.validateRoute);
      if (!digest(input.sealedInventoryDigest)) fail("inventory_digest_invalid");
      try {
        return transaction(() => {
          historicalExecution(input);
          const previous = operation(input.operationId, input.requestFingerprint);
          if (previous) return previous;
          const current = route();
          if (!equal(current, input.expectedRoute) || current.state !== "fenced" || input.targetRoute.state !== "active" || input.targetRoute.datasetId !== identity.datasetId || input.targetRoute.backendId !== identity.backendId || input.targetRoute.mode !== "server_only" || input.targetRoute.routeGeneration === current.routeGeneration || meta("used-route:" + input.targetRoute.routeGeneration)) return conflict(input, "activation_route_conflict", "activate");
          const sealed = inventoryDigest();
          if (sealed !== input.sealedInventoryDigest) return conflict(input, "inventory_digest_conflict", "activate");
          const receipt = input.sourceFenceReceipt;
          try {
            keys(receipt, [ "schema", "operationId", "requestFingerprint", "identity", "sourceRoute", "route", "writerEpoch", "inventoryRevision", "inventoryDigest" ]);
            keys(receipt.identity, [ "authorityId", "storeId", "datasetId", "backendId" ]);
            if (receipt.schema !== "wm.dataset-fence-receipt.v1" || !token(receipt.operationId) || !digest(receipt.requestFingerprint) || !token(receipt.writerEpoch) || !token(receipt.inventoryRevision) || !digest(receipt.inventoryDigest) || !Object.values(receipt.identity).every(token)) fail("source_fence_unverified");
            checked(receipt.sourceRoute, C.validateRoute);
            checked(receipt.route, C.validateRoute);
            if (receipt.sourceRoute.state !== "active" || !equal(receipt.route, {
              ...receipt.sourceRoute,
              state: "fenced"
            }) || receipt.route.datasetId !== receipt.identity.datasetId || receipt.route.backendId !== receipt.identity.backendId) fail("source_fence_unverified");
          } catch (_) {
            return conflict(input, "source_fence_unverified", "activate");
          }
          let verified = false;
          if (receipt && receipt.schema === "wm.dataset-fence-receipt.v1" && equal(receipt.identity, physicalIdentity(identity))) {
            const stored = operation(receipt.operationId, receipt.requestFingerprint);
            verified = stored?.status === "committed" && one("SELECT kind FROM operations WHERE operation_id=?", receipt.operationId)?.kind === "fence" && equal(stored.receipt, receipt) && equal(receipt.route, current) && receipt.writerEpoch === epoch() && receipt.inventoryRevision === meta("inventory_revision") && receipt.inventoryDigest === sealed;
          } else if (verifySourceFenceReceipt) {
            const context = {
              targetIdentity: physicalIdentity(identity),
              expectedRoute: current,
              targetRoute: input.targetRoute,
              sealedInventoryDigest: sealed
            };
            let proof;
            try {
              proof = verifySourceFenceReceipt(clone(receipt), clone(context));
              plain(proof);
              keys(proof, [ "ok", "sourceIdentity", "sourceRoute", "operationId", "requestFingerprint", "writerEpoch", "inventoryDigest" ]);
            } catch (_) {
              proof = undefined;
            }
            verified = proof?.ok === true && typeof proof === "object" && !Array.isArray(proof) && equal(proof.sourceIdentity, receipt?.identity) && equal(proof.sourceRoute, receipt?.route) && proof.operationId === receipt?.operationId && proof.requestFingerprint === receipt?.requestFingerprint && proof.writerEpoch === receipt?.writerEpoch && proof.inventoryDigest === sealed && digest(proof.requestFingerprint) && token(proof.operationId) && token(proof.writerEpoch);
          }
          if (!verified) return conflict(input, "source_fence_unverified", "activate");
          setMeta("used-route:" + input.targetRoute.routeGeneration, "1");
          setMeta("writer_epoch", fresh("epoch"));
          setRoute(input.targetRoute);
          return saveOperation(input, "activate", statusValue("committed", input.operationId, input.requestFingerprint, {
            route: clone(input.targetRoute),
            writerEpoch: epoch(),
            inventoryDigest: sealed,
            sourceFenceOperationId: receipt.operationId
          }));
        });
      } catch (e) {
        if (e.code?.startsWith("WM_")) throw e;
        return uncertain(input);
      }
    },
    close() {
      if (!closed) {
        try {
          db.close();
        } catch (_) {}
        closed = true;
      }
    }
  });
  handoffEngine=require('./handoff.cjs').createWmHandoffStore({C,P,limits,plain,keys,request,transaction,meta,setMeta,sha,stable,fingerprint,fresh,head,route,epoch,store,stageState,stageItems,saveStage,verifyStage,migrationPayload,
    authorityId:identity.authorityId,storeId:identity.storeId,verifyPendingProof:verifyHandoffFence,
    hasScopeHistory:scope=>!!one('SELECT 1 n FROM generations WHERE scope=? LIMIT 1',scope),hasScopeInventory:scope=>all('SELECT descriptor_json FROM inventory_items').some(row=>JSON.parse(row.descriptor_json).originScope===scope),
    withWrite:(id,fn)=>{const old=handoffWriting;handoffWriting=id;try{return fn();}finally{handoffWriting=old;}},installCopy:installHandoffCopy,readCopy:readHandoffCopy,inventoryDescriptor,
    putCompanion:d=>{const old=inventoryDescriptor(d.logicalId);if(old){if(!equal(old,d))fail('handoff_descriptor_conflict');return;}const copy=readHandoffCopy(d,0,d.bytes);storeBlob(Buffer.from(copy.bytes),d.sha256);const json=stable(d);run('INSERT INTO inventory_items VALUES (?,?,?,?)',d.logicalId,json,sha(Buffer.from(json)),d.sha256);}
  });
  // C3 typed backup bridge. SQL stays private; only a pinned cut and staged
  // replacement lifecycle are exposed. Historical authority is never reactivated.
  B.registerStore(store, {
    databasePath, identity:clone(identity), schemaDdl:SCHEMA_DDL, immutableDdl:immutableDdl(),
    currentFingerprint:()=>transaction(()=>require('./backup_stream.cjs').isPaged(db)?require('./backup_stream.cjs').fingerprint(db):sha(Buffer.from(stable({identity,route:route(),writerEpoch:epoch(),inventoryRevision:meta("inventory_revision"),inventoryDigest:inventoryDigest(),operations:all("SELECT operation_id,request_fingerprint,status,response_sha256 FROM operations ORDER BY operation_id"),manual:all("SELECT key,value FROM metadata WHERE substr(key,1,7)='manual:' ORDER BY key"),stages:all("SELECT key,value FROM metadata WHERE key LIKE 'migration-%' OR key LIKE 'handoff-%' ORDER BY key")})))),
    capture({snapshot,outputPath}) {
      usable();require("./manual.cjs").inspectManualBackup(db);if(require('./backup_stream.cjs').isPaged(db))return require('./backup_stream.cjs').capture({db,snapshot,outputPath,schemaDdl:SCHEMA_DDL,immutableDdl:immutableDdl(),transaction,now,physicalIdentity:physicalIdentity(identity),route,epoch});store.assertLegacyBackupSupported();
      const dest=new DatabaseSync(outputPath);
      try{dest.exec(SCHEMA_DDL);}finally{dest.close();}
      db.prepare("ATTACH DATABASE ? AS wm_backup").run(outputPath);
      try { return transaction(()=>{
        const state=JSON.parse(meta("pin_boot_generation")===undefined?"null":one("SELECT snapshot_json FROM inventory_snapshots WHERE snapshot_id=?",snapshot.snapshotId)?.snapshot_json||"null");
        if(!state||state.status!=="active"||state.writerEpoch!==epoch()||state.snapshot.routeGeneration!==route().routeGeneration||!equal(state.snapshot,snapshot)||now()>=state.expiresAt)fail("backup_snapshot_stale");
        // Compare the entire current cut with the immutable snapshot, including
        // empty scope Heads, before SQLite copies any component rows.
        const hash=crypto.createHash("sha256");hash.update("wm.inventory-snapshot.v1\n");
        const descriptors=[];
        for(const row of iterate("SELECT scope FROM heads ORDER BY scope")){const h=head(row.scope),g=verifyGeneration(h.generationId);const empty=meta("migration-empty:"+sha(Buffer.from(h.scope))),preserved=meta("migration-canonical:"+sha(Buffer.from(h.scope)));if(!(h.tombstone&&empty!==undefined&&equal(JSON.parse(empty),h)))descriptors.push(preserved!==undefined&&equal(JSON.parse(preserved).head,h)?clone(JSON.parse(preserved).descriptor):{domain:"canonical",schema:C.CANONICAL_SCHEMA,logicalId:"canonical-"+sha(Buffer.from(h.scope)),originScope:h.scope,bytes:h.utf8Bytes,sha256:h.sha256,dependencies:g.manifest.items.map(d=>d.logicalId),disposition:{tombstone:h.tombstone}});}
        for(const row of iterate("SELECT logical_id FROM inventory_items ORDER BY logical_id"))descriptors.push(inventoryDescriptor(row.logical_id,262144));
        for(const d of descriptors)hash.update(stable(d)+"\n");
        if(hash.digest("hex")!==snapshot.inventoryDigest)fail("backup_cut_changed");
        for(const row of iterate("SELECT generation_id FROM generations ORDER BY generation_id"))verifyGeneration(row.generation_id,262144);
        for(const table of ["blobs","inventory_items","generations","generation_items","heads","operations","dataset_route"])db.exec("INSERT INTO wm_backup."+table+" SELECT * FROM main."+table);
        const insert=db.prepare("INSERT INTO wm_backup.metadata(key,value) VALUES (?,?)");
        for(const row of iterate("SELECT key,value FROM metadata ORDER BY key")){
          if(require("./manual.cjs").isManualMetadataKey(row.key)||["identity","schema","writer_epoch","inventory_revision"].includes(row.key)||row.key.startsWith("used:")||row.key.startsWith("used-route:")||row.key.startsWith("handoff-copy:")||row.key.startsWith("migration-canonical:")||row.key.startsWith("migration-empty:"))insert.run(row.key,row.value);
          else if(row.key.startsWith("migration-stage:")){
            const v=JSON.parse(row.value),evidence={schema:"wm.backup-operation-evidence.v1",inert:true,operationId:v.operationId,requestFingerprint:v.requestFingerprint,state:v.state,kind:v.kind||"migration",snapshot:v.snapshot,copiedBytes:v.copiedBytes,itemCount:v.itemCount,...v.transferId?{transferId:v.transferId,sourceIdentity:v.sourceIdentity,targetIdentity:v.targetIdentity,sourceHead:v.sourceHead,sourceRoute:v.sourceRoute,targetRoute:v.targetRoute,payloadDigest:v.payloadDigest,domains:v.domains}: {},...v.receipt?{receipt:v.receipt}: {}};
            insert.run("backup-evidence:"+row.key,stable(evidence));
          } else if(row.key.startsWith("migration-item:"))insert.run("backup-evidence:"+row.key,row.value);
          else if(row.key.startsWith("backup-evidence:")||row.key.startsWith("restore-historical-operation:"))insert.run(row.key,row.value);
        }
        insert.run("backup-cut",stable({schema:"wm.backup-cut.v1",snapshot,sourceStoreIdentity:{...physicalIdentity(identity),routeGeneration:route().routeGeneration,writerEpoch:epoch()},heads:all("SELECT head_json FROM heads ORDER BY scope").map(r=>JSON.parse(r.head_json)),inventory:descriptors}));
        return {identity:{...physicalIdentity(identity),routeGeneration:route().routeGeneration,writerEpoch:epoch()}};
      }); } finally {db.exec("DETACH DATABASE wm_backup");const out=new DatabaseSync(outputPath);try{out.exec(immutableDdl());}finally{out.close();}}
    },
    fenceRestore({operationId,planId}) {return transaction(()=>{setRoute({...route(),routeGeneration:fresh("route"),state:"recovery_required"});setMeta("writer_epoch",fresh("epoch"));setMeta("pin_boot_generation",fresh("boot"));setMeta("restore-admission",stable({schema:"wm.restore-admission.v1",incarnation:fresh("incarnation"),operationId,planId,state:"recovery_required",historicalAuthority:false}));return {ok:true};});}
  });
  P.registerStore(store, {
    create: createPinsBackend
  });
  return store;
}

module.exports = Object.freeze({
  createWmStore: createWmStore,
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  SCHEMA_DDL: SCHEMA_DDL
});
