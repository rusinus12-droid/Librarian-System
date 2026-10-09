"use strict";

// Versioned paged backup: FILE-backed work sets and one bounded row/blob chunk.
// No live staging authority, source mutation, implicit activation or native owner.
const crypto = require("node:crypto"), {DatabaseSync: DatabaseSync} = require("node:sqlite");

const C = require("../../sdk/WmStorageContracts.source.js"), P = require("./pins.cjs");

const SCHEMA = "wm.backup-component.v2", CUT = "wm.backup-cut.v2";

const sha = b => crypto.createHash("sha256").update(b).digest("hex");

const stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v);

const equal = (a, b) => stable(a) === stable(b), clone = v => JSON.parse(JSON.stringify(v));

const fail = r => {
  throw Object.assign(Error(r), {
    code: "WM_" + r,
    statusCode: 409
  });
};

const token = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v), digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

const B = () => require("./backup.cjs");

function exact(v, ks) {
  B().assertPlainData(v);
  if (!v || Array.isArray(v) || Object.keys(v).length !== ks.length || !ks.every(k => Object.hasOwn(v, k))) fail("backup_unknown_field");
}

function add(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a > Number.MAX_SAFE_INTEGER - b) fail("backup_byte_overflow");
  return a + b;
}

const meta = (db, k) => db.prepare("SELECT value FROM metadata WHERE key=?").get(k)?.value;

const put = (db, k, v) => db.prepare("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, typeof v === "string" ? v : stable(v));

function summary(kind) {
  const h = crypto.createHash("sha256");
  h.update("wm.backup-" + kind + ".v2\n");
  let count = 0;
  return {
    add(v) {
      h.update(stable(v) + "\n");
      count = add(count, 1);
    },
    finish() {
      return {
        count: count,
        sha256: h.digest("hex")
      };
    }
  };
}

function validSummary(v) {
  exact(v, [ "count", "sha256" ]);
  if (!Number.isSafeInteger(v.count) || v.count < 0 || !digest(v.sha256)) fail("backup_summary_invalid");
}

function validComponent(v) {
  exact(v, [ ...B().COMPONENT_KEYS, "contentInventory", "heads", ...Object.hasOwn(v,"manual")?["manual"]:[] ]);
  if(Object.hasOwn(v,"manual"))require("./manual.cjs").validateManualSummary(v.manual);
  exact(v.sourceStoreIdentity, [ "authorityId", "storeId", "datasetId", "backendId", "routeGeneration", "writerEpoch" ]);
  if (v.schema !== SCHEMA || typeof v.backupId !== "string" || !v.backupId || !Object.values(v.sourceStoreIdentity).every(token) || !token(v.snapshotId) || !digest(v.inventoryDigest) || !digest(v.sha256) || !Number.isSafeInteger(v.bytes) || v.bytes < 0) fail("backup_component_invalid");
  for (const k of [ "generations", "rawInventory", "operationHistory", "contentInventory", "heads" ]) validSummary(v[k]);
  if (typeof v.file !== "string" || !v.file || v.file.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(v.file) || v.file.split("/").some(p => !p || p === "." || p === "..")) fail("backup_file_unsafe");
  return v;
}

function isPaged(db) {
  return !!db.prepare("SELECT 1 n FROM generations WHERE json_extract(manifest_json,'$.schema')=? LIMIT 1").get(C.ROOT_MANIFEST_SCHEMA);
}

function safeMeta(k) {
  return require("./manual.cjs").isManualMetadataKey(k) || [ "identity", "schema", "writer_epoch", "inventory_revision", "backup-cut", "restore-admission", "pin_boot_generation" ].includes(k) || [ "used:", "used-route:", "handoff-copy:", "migration-canonical:", "migration-empty:", "backup-evidence:", "restore-historical-operation:", "root-proof:", "backup-cut-item:" ].some(p => k.startsWith(p));
}

function context(db) {
  const one = (s, ...a) => db.prepare(s).get(...a), iterate = (s, ...a) => db.prepare(s).iterate(...a), run = (s, ...a) => db.prepare(s).run(...a);
  function blob(hash, bytes, returnBytes = false) {
    if (!digest(hash) || !Number.isSafeInteger(bytes) || bytes < 0) fail("backup_blob_invalid");
    const row = one("SELECT utf8_bytes,length(payload) n FROM blobs WHERE sha256=?", hash);
    if (!row || row.utf8_bytes !== bytes || row.n !== bytes) fail("backup_blob_missing");
    const h = crypto.createHash("sha256");
    for (let offset = 0; offset < bytes; offset += 262144) {
      const p = one("SELECT substr(payload,?,?) b FROM blobs WHERE sha256=?", offset + 1, Math.min(262144, bytes - offset), hash);
      h.update(p.b);
    }
    if (h.digest("hex") !== hash) fail("backup_blob_digest");
    if (returnBytes) {
      if (bytes > 65536) fail("backup_page_limit");
      return bytes ? Buffer.from(one("SELECT payload FROM blobs WHERE sha256=?", hash).payload) : Buffer.alloc(0);
    }
  }
  function descriptor(id) {
    const bound = one("SELECT length(CAST(descriptor_json AS BLOB)) n FROM inventory_items WHERE logical_id=?", id);
    if (!bound) return null;
    if (bound.n > 65536) fail("backup_descriptor_limit");
    const r = one("SELECT * FROM inventory_items WHERE logical_id=?", id), d = JSON.parse(r.descriptor_json);
    if (sha(Buffer.from(r.descriptor_json)) !== r.descriptor_sha256 || !C.validateItem(d).ok || d.logicalId !== id || d.sha256 !== r.blob_sha256) fail("backup_inventory_integrity");
    return d;
  }
  function owned(d) {
    if (![ "wm.extension-history-page.v1", "wm.dependency-root.v1" ].includes(d.schema)) return;
    const bytes = blob(d.sha256, d.bytes, true), p = JSON.parse(bytes.toString("utf8"));
    if (d.domain !== "cold" || d.disposition !== null || d.dependencies.length > 128 || p.schema !== d.schema || p.scope !== d.originScope || !equal(p.dependencies, d.dependencies)) fail("backup_page_integrity");
    if (d.schema === "wm.extension-history-page.v1") {
      exact(p, [ "schema", "scope", "logicalId", "raw", "dependencies" ]);
      if (typeof p.raw !== "string" || p.logicalId !== d.logicalId || "eh-" + sha(Buffer.from(JSON.stringify([ p.scope, p.raw, p.dependencies ]))) !== d.logicalId) fail("backup_history_page_integrity");
    } else {
      exact(p, [ "schema", "scope", "generationId", "manifestDigest", "kind", "dependencies" ]);
      if (!token(p.generationId) || !digest(p.manifestDigest) || ![ "generation", "legacy-bridge" ].includes(p.kind) || "root-" + sha(bytes) !== d.logicalId) fail("backup_root_page_integrity");
    }
    return p;
  }
  function proof(m) {
    const raw = meta(db, "root-proof:" + m.generationId);
    if (raw === undefined) fail("backup_root_proof_missing");
    const p = JSON.parse(raw);
    exact(p, [ "schema", "generationId", "manifestDigest", "rootId", "count", "bytes", "closureDigest", "seal" ]);
    const {seal: seal, ...v} = p;
    if (p.schema !== "wm.root-closure-proof.v1" || sha(Buffer.from(stable(v))) !== seal || p.generationId !== m.generationId || p.manifestDigest !== m.manifestDigest || !token(p.rootId) || !digest(p.closureDigest) || !Number.isSafeInteger(p.count) || p.count < 1 || !Number.isSafeInteger(p.bytes) || p.bytes < 0) fail("backup_root_proof_integrity");
    return p;
  }
  db.exec("PRAGMA temp_store=FILE; CREATE TEMP TABLE IF NOT EXISTS backup_walk(id TEXT PRIMARY KEY,state INTEGER NOT NULL) STRICT; CREATE TEMP TABLE IF NOT EXISTS backup_stack(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,exit INTEGER NOT NULL) STRICT;");
  function walk(start, {generationId: generationId = null, scope: scope = null, reset: reset = true} = {}) {
    if (reset) db.exec("DELETE FROM backup_walk; DELETE FROM backup_stack;");
    run("INSERT INTO backup_stack(id,exit) VALUES (?,0)", start);
    while (true) {
      const row = one("SELECT * FROM backup_stack ORDER BY seq DESC LIMIT 1");
      if (!row) break;
      run("DELETE FROM backup_stack WHERE seq=?", row.seq);
      const state = one("SELECT state FROM backup_walk WHERE id=?", row.id)?.state;
      if (row.exit) {
        run("UPDATE backup_walk SET state=2 WHERE id=?", row.id);
        continue;
      }
      if (state === 1) fail("backup_dependency_cycle");
      if (state === 2) continue;
      const d = descriptor(row.id);
      if (!d) fail("backup_dependency_missing");
      if (scope && d.originScope !== scope && (![ "raw", "raw_history", "lineage" ].includes(d.domain) || d.disposition === null)) fail("backup_scope_mismatch");
      if (generationId && !one("SELECT 1 n FROM generation_items WHERE generation_id=? AND logical_id=?", generationId, d.logicalId)) fail("backup_generation_closure");
      run("INSERT INTO backup_walk VALUES (?,1)", d.logicalId);
      run("INSERT INTO backup_stack(id,exit) VALUES (?,1)", d.logicalId);
      for (const id of d.dependencies) run("INSERT INTO backup_stack(id,exit) VALUES (?,0)", id);
    }
  }
  function rootClosure(m) {
    const p = proof(m), d = descriptor(p.rootId);
    if (!d) fail("backup_root_proof_integrity");
    const page = owned(d);
    if (page?.kind !== "generation" || page.generationId !== m.generationId || page.manifestDigest !== m.manifestDigest || page.scope !== m.scope) fail("backup_root_manifest_binding");
    let base = null;
    if (m.baseGenerationId) {
      const g = one("SELECT manifest_json FROM generations WHERE generation_id=?", m.baseGenerationId);
      if (!g) fail("backup_expected_head_closure");
      const bm = JSON.parse(g.manifest_json);
      if (bm.schema === C.ROOT_MANIFEST_SCHEMA) base = proof(bm).rootId; else {
        base = page.dependencies[0];
        let next = base, ordinal = bm.items.length, seen = 0;
        while (next) {
          if (++seen > bm.items.length + 1) fail("backup_root_bridge_integrity");
          const bd = descriptor(next), bp = bd && owned(bd);
          if (bp?.kind !== "legacy-bridge" || bp.generationId !== bm.generationId || bp.manifestDigest !== bm.manifestDigest || bp.scope !== m.scope) fail("backup_root_bridge_integrity");
          const batch = Math.min(127, ordinal % 127 || 127), items = ordinal ? bm.items.slice(ordinal - batch, ordinal).map(d => d.logicalId) : [];
          const hasPrior = ordinal > items.length;
          if (!equal(bp.dependencies.slice(hasPrior ? 1 : 0), items)) fail("backup_root_bridge_integrity");
          next = hasPrior ? bp.dependencies[0] : null;
          ordinal -= items.length;
        }
        if (ordinal !== 0) fail("backup_root_bridge_integrity");
      }
    }
    if (!equal(page.dependencies, [ ...base ? [ base ] : [], ...m.dependencyRoots ])) fail("backup_root_manifest_binding");
    walk(p.rootId, {
      generationId: m.generationId,
      scope: m.scope
    });
    const h = crypto.createHash("sha256");
    h.update("wm.root-closure.v1\n");
    let count = 0, total = 0;
    for (const row of iterate("SELECT * FROM generation_items WHERE generation_id=? ORDER BY ordinal", m.generationId)) {
      const d = descriptor(row.logical_id);
      if (!d || row.ordinal !== count++ || row.descriptor_json !== stable(d) || row.blob_sha256 !== d.sha256 || !one("SELECT 1 n FROM backup_walk WHERE id=?", d.logicalId)) fail("backup_generation_closure");
      blob(d.sha256, d.bytes);
      owned(d);
      h.update(stable(d) + "\n");
      total = add(total, d.bytes);
    }
    if (count !== p.count || count !== one("SELECT count(*) n FROM backup_walk").n || total !== p.bytes || h.digest("hex") !== p.closureDigest) fail("backup_root_closure_integrity");
  }
  return {
    one: one,
    iterate: iterate,
    run: run,
    blob: blob,
    descriptor: descriptor,
    owned: owned,
    proof: proof,
    walk: walk,
    rootClosure: rootClosure
  };
}

function generationSummary(row, m) {
  return {
    scope: m.scope,
    generationId: m.generationId,
    manifestDigest: m.manifestDigest,
    rawSha256: m.canonical.sha256,
    utf8Bytes: m.canonical.utf8Bytes
  };
}

function canonical(db, h, m, proof) {
  const d = {
    domain: "canonical",
    schema: C.CANONICAL_SCHEMA,
    logicalId: "canonical-" + sha(Buffer.from(h.scope)),
    originScope: h.scope,
    bytes: h.utf8Bytes,
    sha256: h.sha256,
    dependencies: m.schema === C.ROOT_MANIFEST_SCHEMA ? [ proof(m).rootId ] : m.items.map(d => d.logicalId),
    disposition: {
      tombstone: h.tombstone
    }
  };
  const preserved = meta(db, "migration-canonical:" + sha(Buffer.from(h.scope)));
  if (preserved !== undefined) {
    const v = JSON.parse(preserved);
    if (equal(v.head, h) && !equal(v.descriptor, d)) fail("backup_canonical_cut");
  }
  return d;
}

function currentCut(db, {write: write = false, snapshotId: snapshotId, sourceStoreIdentity: sourceStoreIdentity} = {}) {
  const x = context(db), hash = crypto.createHash("sha256"), heads = summary("heads"), counts = Object.fromEntries(C.DOMAINS.map(d => [ d, 0 ])), bytes = Object.fromEntries(C.DOMAINS.map(d => [ d, 0 ]));
  hash.update("wm.inventory-snapshot.v1\n");
  let n = 0;
  function item(d) {
    if (write) put(db, "backup-cut-item:" + String(n).padStart(16, "0"), d);
    hash.update(stable(d) + "\n");
    counts[d.domain] = add(counts[d.domain], 1);
    bytes[d.domain] = add(bytes[d.domain], d.bytes);
    n++;
  }
  for (const row of x.iterate("SELECT * FROM heads ORDER BY scope")) {
    const h = JSON.parse(row.head_json), g = JSON.parse(x.one("SELECT manifest_json FROM generations WHERE generation_id=?", h.generationId).manifest_json);
    heads.add(h);
    const empty = meta(db, "migration-empty:" + sha(Buffer.from(h.scope)));
    if (!(h.tombstone && empty !== undefined && equal(JSON.parse(empty), h))) item(canonical(db, h, g, x.proof));
  }
  for (const row of x.iterate("SELECT logical_id FROM inventory_items ORDER BY logical_id")) item(x.descriptor(row.logical_id));
  const inventoryDigest = hash.digest("hex"), cut = {
    schema: CUT,
    sourceStoreIdentity: sourceStoreIdentity,
    snapshot: {
      snapshotId: snapshotId,
      routeGeneration: sourceStoreIdentity?.routeGeneration,
      inventoryDigest: inventoryDigest,
      domainCounts: counts,
      domainBytes: bytes,
      complete: true
    },
    heads: heads.finish(),
    inventoryCount: n
  };
  if (write) put(db, "backup-cut", cut);
  return cut;
}

function enforceRowBounds(db) {
  // Canonical/legacy rows retain finite compatibility limits; pages and structural
  // metadata have small independent ceilings. No bound scales with store length.
  const rules = [ [ "metadata", "length(CAST(key AS BLOB))>1024 OR length(CAST(value AS BLOB))>CASE WHEN key='backup-cut' THEN 16384 WHEN key LIKE 'root-proof:%' OR key LIKE 'backup-evidence:import-map:%' OR key LIKE 'backup-evidence:import-head:%' THEN 16384 WHEN key LIKE 'backup-cut-item:%' OR key LIKE 'backup-evidence:import-source-cut:%' THEN 65536 WHEN key LIKE 'backup-evidence:import-manifest:%' THEN 134217728 ELSE 100663296 END", "backup_metadata_limit" ], [ "generations", "length(CAST(manifest_json AS BLOB))>134217728 OR length(CAST(input_json AS BLOB))>536870912 OR length(CAST(prepared_json AS BLOB))>65536 OR json_extract(manifest_json,'$.canonical.utf8Bytes')>67108864", "backup_generation_row_limit" ], [ "operations", "length(CAST(response_json AS BLOB))>134217728", "backup_operation_row_limit" ], [ "heads", "length(CAST(head_json AS BLOB))>16384", "backup_head_row_limit" ], [ "inventory_items", "length(CAST(descriptor_json AS BLOB))>65536", "backup_descriptor_limit" ], [ "generation_items", "length(CAST(descriptor_json AS BLOB))>65536", "backup_descriptor_limit" ] ];
  for (const [table, condition, reason] of rules) if (db.prepare("SELECT 1 n FROM " + table + " WHERE " + condition + " LIMIT 1").get()) fail(reason);
}

function inspectDb(db, {restored: restored = false} = {}) {
  enforceRowBounds(db);
  require("./service.cjs").admitExistingSchema(db);
  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get() || meta(db, "schema") !== "wm.sqlite.v1") fail("backup_sqlite_integrity");
  const x = context(db), identity = JSON.parse(meta(db, "identity") || "null");
  exact(identity, [ "authorityId", "storeId", "datasetId", "backendId", "routeGeneration", "writerEpoch" ]);
  if (!Object.values(identity).every(token)) fail("backup_identity_invalid");
  for (const table of [ "pins", "inventory_snapshots", "inventory_snapshot_items" ]) if (x.one("SELECT count(*) n FROM " + table).n) fail("backup_live_lease_forbidden");
  for (const row of x.iterate("SELECT key FROM metadata")) if (!safeMeta(row.key)) fail("backup_operational_metadata_forbidden");
  const cut = JSON.parse(meta(db, "backup-cut") || "null");
  exact(cut, [ "schema", "sourceStoreIdentity", "snapshot", "heads", "inventoryCount" ]);
  if (cut.schema !== CUT || cut.snapshot.complete !== true) fail("backup_cut_invalid");
  const routeRow = x.one("SELECT * FROM dataset_route WHERE singleton=1"), route = JSON.parse(routeRow?.route_json || "null");
  if (!routeRow || sha(Buffer.from(routeRow.route_json)) !== routeRow.route_sha256 || !C.validateRoute(route).ok) fail("backup_route_integrity");
  if (!restored && !equal(cut.sourceStoreIdentity, {
    ...identity,
    routeGeneration: route.routeGeneration,
    writerEpoch: meta(db, "writer_epoch")
  })) fail("backup_identity_binding");
  for (const row of x.iterate("SELECT sha256,utf8_bytes FROM blobs ORDER BY sha256")) x.blob(row.sha256, row.utf8_bytes);
  const rawInventory = summary("raw-inventory"), contentInventory = summary("content-inventory");
  for (const row of x.iterate("SELECT logical_id FROM inventory_items ORDER BY logical_id")) {
    const d = x.descriptor(row.logical_id);
    x.blob(d.sha256, d.bytes);
    x.owned(d);
    if ([ "raw", "raw_history" ].includes(d.domain)) rawInventory.add(d);
    if (d.schema !== "wm.dependency-root.v1") contentInventory.add(d);
    x.walk(d.logicalId, {
      reset: false
    });
  }
  db.exec("DELETE FROM backup_walk; DELETE FROM backup_stack;");
  const generations = summary("generations");
  for (const row of x.iterate("SELECT * FROM generations ORDER BY generation_id")) {
    const m = JSON.parse(row.manifest_json), intent = JSON.parse(row.input_json), p = JSON.parse(row.prepared_json);
    B().assertPlainData(intent);
    exact(p, C.DTO_KEYS.Prepared);
    if (!C.validateManifest(m).ok || sha(Buffer.from(row.input_json)) !== row.input_sha256 || sha(Buffer.from(row.prepared_json)) !== row.prepared_sha256 || m.generationId !== row.generation_id || m.scope !== row.scope || m.manifestDigest !== row.manifest_digest || m.canonical.sha256 !== row.raw_sha256 || !equal(intent.manifest, m) || intent.scope !== m.scope || intent.operationId !== m.operationId || intent.routeGeneration !== m.routeGeneration || intent.writerEpoch !== m.writerEpoch || !equal(intent.expectedHead, m.expectedHead) || !token(p.preparedId) || p.operationId !== intent.operationId || p.requestFingerprint !== intent.requestFingerprint || p.operation !== intent.operation || p.scope !== intent.scope || !equal(p.expectedHead, intent.expectedHead) || p.rawSha256 !== m.canonical.sha256 || !C.validateHead(p.head).ok || p.head.authorityId !== identity.authorityId || p.head.storeId !== identity.storeId || p.head.generationId !== m.generationId || p.head.scope !== m.scope || p.head.sha256 !== m.canonical.sha256 || p.head.utf8Bytes !== m.canonical.utf8Bytes || p.head.tombstone !== (intent.raw === null)) fail("backup_generation_integrity");
    if (intent.operation === "initialize") {
      if (sha(Buffer.from(stable({
        scope: intent.scope,
        operationId: intent.operationId,
        routeGeneration: intent.routeGeneration,
        writerEpoch: intent.writerEpoch,
        expectedEmpty: true
      }))) !== intent.requestFingerprint || !equal(p.head, intent.expectedHead) || m.items?.length !== 0) fail("backup_initial_generation");
    } else if (!C.validateOperation(intent).ok) fail("backup_write_intent_invalid");
    if (sha(Buffer.from(intent.raw === null ? "" : intent.raw)) !== m.canonical.sha256 || Buffer.byteLength(intent.raw === null ? "" : intent.raw) !== m.canonical.utf8Bytes) fail("backup_raw_integrity");
    x.blob(m.canonical.sha256, m.canonical.utf8Bytes);
    const expected = x.one("SELECT prepared_json FROM generations WHERE generation_id=?", intent.expectedHead.generationId);
    if (!expected || !equal(JSON.parse(expected.prepared_json).head, intent.expectedHead)) fail("backup_expected_head_closure");
    if (m.schema === C.ROOT_MANIFEST_SCHEMA) x.rootClosure(m); else {
      let n = 0;
      for (const r of x.iterate("SELECT * FROM generation_items WHERE generation_id=? ORDER BY ordinal", m.generationId)) {
        const d = m.items[n];
        if (!d || r.ordinal !== n++ || r.logical_id !== d.logicalId || r.blob_sha256 !== d.sha256 || !equal(JSON.parse(r.descriptor_json), d) || !equal(x.descriptor(d.logicalId), d)) fail("backup_generation_closure");
      }
      if (n !== m.items.length) fail("backup_generation_closure");
    }
    generations.add(generationSummary(row, m));
  }
  for (const row of x.iterate("SELECT key FROM metadata WHERE key LIKE 'root-proof:%'")) if (!x.one("SELECT 1 n FROM generations WHERE generation_id=? AND json_extract(manifest_json,'$.schema')=?", row.key.slice(11), C.ROOT_MANIFEST_SCHEMA)) fail("backup_root_proof_orphan");
  for (const row of x.iterate("SELECT * FROM heads ORDER BY scope")) {
    const h = JSON.parse(row.head_json), g = x.one("SELECT prepared_json FROM generations WHERE generation_id=?", row.generation_id);
    if (sha(Buffer.from(row.head_json)) !== row.head_sha256 || row.scope !== h.scope || row.generation_id !== h.generationId || !g || !equal(JSON.parse(g.prepared_json).head, h)) fail("backup_head_integrity");
  }
  const actual = currentCut(db, {
    snapshotId: cut.snapshot.snapshotId,
    sourceStoreIdentity: cut.sourceStoreIdentity
  });
  if (!equal(actual, cut)) fail("backup_inventory_digest");
  let count = 0;
  const cutHash = crypto.createHash("sha256");
  cutHash.update("wm.inventory-snapshot.v1\n");
  for (const row of x.iterate("SELECT key,value FROM metadata WHERE key LIKE 'backup-cut-item:%' ORDER BY key")) {
    if (row.key !== "backup-cut-item:" + String(count++).padStart(16, "0")) fail("backup_cut_inventory_invalid");
    const d = JSON.parse(row.value);
    if (!P.validateInventoryItem(d).ok) fail("backup_cut_inventory_invalid");
    cutHash.update(stable(d) + "\n");
  }
  if (count !== cut.inventoryCount || cutHash.digest("hex") !== cut.snapshot.inventoryDigest) fail("backup_cut_inventory_incomplete");
  const operations = summary("operations");
  for (const r of x.iterate("SELECT * FROM operations ORDER BY operation_id")) {
    const v = JSON.parse(r.response_json);
    if (sha(Buffer.from(r.response_json)) !== r.response_sha256 || !C.validateOperationStatus(v).ok || v.operationId !== r.operation_id || v.requestFingerprint !== r.request_fingerprint || v.status !== r.status) fail("backup_operation_integrity");
    operations.add({
      operationId: r.operation_id,
      requestFingerprint: r.request_fingerprint,
      kind: r.kind,
      status: r.status,
      responseDigest: r.response_sha256,
      historical: true,
      executionAuthority: false
    });
  }
  verifyEvidence(db, x);
  const manual=require("./manual.cjs").inspectManualBackup(db);
  return {
    ...manual?{manual}:{},
    componentSchema: SCHEMA,
    heads: cut.heads,
    sourceStoreIdentity: cut.sourceStoreIdentity,
    snapshotId: cut.snapshot.snapshotId,
    inventoryDigest: cut.snapshot.inventoryDigest,
    generations: generations.finish(),
    rawInventory: rawInventory.finish(),
    contentInventory: contentInventory.finish(),
    operationHistory: operations.finish(),
    domains: Object.fromEntries(C.DOMAINS.map(d => [ d, {
      count: cut.snapshot.domainCounts[d],
      bytes: cut.snapshot.domainBytes[d],
      complete: true
    } ])),
    historicalEvidenceRows: x.one("SELECT count(*) n FROM metadata WHERE key LIKE 'backup-evidence:%'").n,
    admission: restored ? JSON.parse(meta(db, "restore-admission") || "null") : null
  };
}

function verifyEvidence(db, x) {
  for (const row of x.iterate("SELECT key,value FROM metadata WHERE key LIKE 'backup-evidence:migration-item:%'")) {
    const v = JSON.parse(row.value);
    if (!P.validateInventoryItem(v.descriptor).ok || !Number.isSafeInteger(v.offset) || v.offset < 0 || v.offset > v.descriptor.bytes || !Array.isArray(v.chunks)) fail("backup_staged_evidence");
    let offset = 0;
    for (const c of v.chunks) {
      if (c.offset !== offset || !Number.isSafeInteger(c.bytes) || c.bytes < 0 || c.bytes > 32 * 1024 * 1024) fail("backup_staged_evidence");
      x.blob(c.sha256, c.bytes);
      offset = add(offset, c.bytes);
    }
    if (offset !== v.offset) fail("backup_staged_evidence");
  }
  for (const row of x.iterate("SELECT key,value FROM metadata WHERE key LIKE 'handoff-copy:%' AND key NOT LIKE '%:chunk:%' ORDER BY key")) {
    const v = JSON.parse(row.value);
    if (v.schema !== "wm.handoff-copy.v1" || !P.validateInventoryItem(v.descriptor).ok || !Array.isArray(v.chunks)) fail("backup_materialized_copy_invalid");
    let total = 0;
    const h = crypto.createHash("sha256");
    for (const key of v.chunks) {
      const c = JSON.parse(meta(db, key) || "null");
      if (!c || c.encoding !== "base64" || c.offset !== total || !Number.isSafeInteger(c.bytes) || c.bytes < 0 || c.bytes > 32 * 1024 * 1024) fail("backup_materialized_chunk");
      const b = Buffer.from(c.data, "base64");
      if (b.length !== c.bytes || b.toString("base64") !== c.data || sha(b) !== c.sha256) fail("backup_materialized_chunk");
      h.update(b);
      total = add(total, b.length);
    }
    if (total !== v.descriptor.bytes || h.digest("hex") !== v.descriptor.sha256) fail("backup_materialized_copy_digest");
  }
}

function capture({db: db, snapshot: snapshot, outputPath: outputPath, schemaDdl: schemaDdl, immutableDdl: immutableDdl, transaction: transaction, now: now, physicalIdentity: physicalIdentity, route: route, epoch: epoch}) {
  enforceRowBounds(db);
  const dest = new DatabaseSync(outputPath);
  try {
    dest.exec(schemaDdl);
  } finally {
    dest.close();
  }
  db.prepare("ATTACH DATABASE ? AS wm_backup").run(outputPath);
  try {
    transaction(() => {
      const s = JSON.parse(db.prepare("SELECT snapshot_json FROM inventory_snapshots WHERE snapshot_id=?").get(snapshot.snapshotId)?.snapshot_json || "null");
      if (!s || s.status !== "active" || s.writerEpoch !== epoch() || s.snapshot.routeGeneration !== route().routeGeneration || !equal(s.snapshot, snapshot) || now() >= s.expiresAt) fail("backup_snapshot_stale");
      const identity = {
        ...physicalIdentity,
        routeGeneration: route().routeGeneration,
        writerEpoch: epoch()
      }, cut = currentCut(db, {
        snapshotId: snapshot.snapshotId,
        sourceStoreIdentity: identity
      });
      if (cut.snapshot.inventoryDigest !== snapshot.inventoryDigest || !equal(cut.snapshot.domainCounts, snapshot.domainCounts) || !equal(cut.snapshot.domainBytes, snapshot.domainBytes)) fail("backup_cut_changed");
      for (const table of [ "blobs", "inventory_items", "generations", "generation_items", "heads", "operations", "dataset_route" ]) db.exec("INSERT INTO wm_backup." + table + " SELECT * FROM main." + table);
      const insert = db.prepare("INSERT INTO wm_backup.metadata VALUES (?,?)");
      for (const row of db.prepare("SELECT key,value FROM metadata ORDER BY key").iterate()) {
        if ([ "backup-cut", "pin_boot_generation" ].includes(row.key) || row.key.startsWith("backup-cut-item:")) continue;
        if (safeMeta(row.key)) insert.run(row.key, row.value); else if (row.key.startsWith("page-stage-item:") || row.key.startsWith("migration-item:")) insert.run("backup-evidence:" + row.key, row.value); else if (row.key.startsWith("migration-stage:")) {
          const v = JSON.parse(row.value);
          insert.run("backup-evidence:" + row.key, stable({
            schema: "wm.backup-operation-evidence.v1",
            inert: true,
            operationId: v.operationId,
            requestFingerprint: v.requestFingerprint,
            state: v.state,
            kind: v.kind || "migration",
            snapshot: v.snapshot,
            copiedBytes: v.copiedBytes,
            itemCount: v.itemCount,
            ...v.transferId ? {
              transferId: v.transferId,
              sourceIdentity: v.sourceIdentity,
              targetIdentity: v.targetIdentity,
              sourceHead: v.sourceHead,
              sourceRoute: v.sourceRoute,
              targetRoute: v.targetRoute,
              payloadDigest: v.payloadDigest,
              domains: v.domains
            } : {},
            ...v.receipt ? {
              receipt: v.receipt
            } : {}
          }));
        }
      }
      let n = 0;
      for (const row of db.prepare("SELECT ordinal,descriptor_json FROM inventory_snapshot_items WHERE snapshot_id=? ORDER BY ordinal").iterate(snapshot.snapshotId)) {
        if (row.ordinal !== n) fail("backup_cut_inventory_invalid");
        insert.run("backup-cut-item:" + String(n++).padStart(16, "0"), row.descriptor_json);
      }
      if (n !== cut.inventoryCount) fail("backup_cut_inventory_incomplete");
      insert.run("backup-cut", stable(cut));
    });
  } finally {
    db.exec("DETACH DATABASE wm_backup");
    const out = new DatabaseSync(outputPath);
    try {
      out.exec(immutableDdl);
    } finally {
      out.close();
    }
  }
}

function fingerprint(db) {
  const h = crypto.createHash("sha256");
  h.update("wm.backup-fingerprint.v2\n");
  for (const [table, order] of [ [ "metadata", "key" ], [ "inventory_items", "logical_id" ], [ "generations", "generation_id" ], [ "generation_items", "generation_id,ordinal" ], [ "heads", "scope" ], [ "operations", "operation_id" ], [ "dataset_route", "singleton" ] ]) for (const row of db.prepare("SELECT * FROM " + table + (table === "metadata" ? " WHERE key NOT LIKE 'pin_%' AND key NOT LIKE 'backup-cut%'" : "") + " ORDER BY " + order).iterate()) h.update(table + "\n" + stable(row) + "\n");
  return h.digest("hex");
}

module.exports = {
  SCHEMA: SCHEMA,
  CUT: CUT,
  validComponent: validComponent,
  isPaged: isPaged,
  safeMeta: safeMeta,
  context: context,
  currentCut: currentCut,
  inspectDb: inspectDb,
  capture: capture,
  fingerprint: fingerprint,
  summary: summary,
  generationSummary: generationSummary,
  meta: meta,
  put: put,
  stable: stable,
  sha: sha,
  equal: equal,
  clone: clone,
  fail: fail,
  token: token,
  digest: digest
};
