"use strict";

// V2 fresh-target rebase. Only the independently copied, unpublished stage changes.
const fs = require("node:fs"), {DatabaseSync: DatabaseSync} = require("node:sqlite"), V = require("./backup_stream.cjs"), C = require("../../sdk/WmStorageContracts.source.js");

const {sha: sha, stable: stable, equal: equal, clone: clone, fail: fail, token: token, digest: digest, meta: meta, put: put, summary: summary, generationSummary: generationSummary} = V;

const hash = v => sha(Buffer.from(stable(v))), without = (v, k) => Object.fromEntries(Object.entries(v).filter(([a]) => a !== k));

const rebaseToken = (p, k, v) => k + "-" + hash({
  authority: p.targetIdentity.authorityId,
  kind: k,
  original: v
}).slice(0, 56);

const rebaseHead = (p, h) => ({
  ...h,
  authorityId: p.targetIdentity.authorityId,
  storeId: p.targetIdentity.storeId,
  epoch: p.targetIdentity.writerEpoch,
  generationId: rebaseToken(p, "generation", h.generationId),
  revision: rebaseToken(p, "revision", h.generationId)
});

const manifestKey = (p, id) => "backup-evidence:import-manifest:" + p.planId + ":" + id;

const cutPrefix = p => "backup-evidence:import-source-cut:" + p.planId + ":";

const headKey = (p, id) => "backup-evidence:import-head:" + p.planId + ":" + id;

const evidenceKey = p => "backup-evidence:cross-store-import:" + p.planId, mapPrefix = p => "backup-evidence:import-map:" + p.planId + ":";

function rebaseStage(file, plan, component) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA temp_store=FILE; PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    const x = V.context(db), triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('generations','generation_items')").all();
    for (const t of triggers) db.exec('DROP TRIGGER "' + t.name + '"');
    db.exec("CREATE TEMP TABLE rebase_generations(source_id TEXT PRIMARY KEY,target_id TEXT,done INTEGER NOT NULL DEFAULT 0) STRICT; INSERT INTO rebase_generations(source_id) SELECT generation_id FROM generations;");
    for (const id of x.iterate("SELECT source_id FROM rebase_generations ORDER BY source_id")) {
      const row = x.one("SELECT * FROM generations WHERE generation_id=?", id.source_id), oldManifest = JSON.parse(row.manifest_json), oldIntent = JSON.parse(row.input_json), oldPrepared = JSON.parse(row.prepared_json), expectedHead = rebaseHead(plan, oldIntent.expectedHead), head = rebaseHead(plan, oldPrepared.head), operationId = rebaseToken(plan, "import-op", oldIntent.operationId), m = {
        ...oldManifest,
        generationId: head.generationId,
        expectedHead: expectedHead,
        operationId: operationId,
        routeGeneration: plan.targetIdentity.routeGeneration,
        writerEpoch: plan.targetIdentity.writerEpoch
      };
      if (m.schema === C.ROOT_MANIFEST_SCHEMA) m.baseGenerationId = m.baseGenerationId === null ? null : rebaseToken(plan, "generation", m.baseGenerationId);
      m.manifestDigest = hash(without(m, "manifestDigest"));
      const intent = {
        ...oldIntent,
        operationId: operationId,
        expectedHead: expectedHead,
        manifest: m,
        routeGeneration: plan.targetIdentity.routeGeneration,
        writerEpoch: plan.targetIdentity.writerEpoch
      };
      intent.requestFingerprint = hash(intent.operation === "initialize" ? {
        scope: intent.scope,
        operationId: operationId,
        routeGeneration: intent.routeGeneration,
        writerEpoch: intent.writerEpoch,
        expectedEmpty: true
      } : without(intent, "requestFingerprint"));
      const prepared = {
        ...oldPrepared,
        preparedId: rebaseToken(plan, "prepared", oldPrepared.preparedId),
        operationId: operationId,
        expectedHead: expectedHead,
        head: head,
        requestFingerprint: intent.requestFingerprint
      };
      if (!C.validateManifest(m).ok || intent.operation !== "initialize" && !C.validateOperation(intent).ok) fail("import_rebased_generation_invalid");
      const inputJson = stable(intent), preparedJson = stable(prepared);
      x.run("UPDATE generations SET generation_id=?,manifest_json=?,manifest_digest=?,input_json=?,input_sha256=?,prepared_json=?,prepared_sha256=? WHERE generation_id=?", head.generationId, stable(m), m.manifestDigest, inputJson, sha(Buffer.from(inputJson)), preparedJson, sha(Buffer.from(preparedJson)), row.generation_id);
      x.run("UPDATE generation_items SET generation_id=? WHERE generation_id=?", head.generationId, row.generation_id);
      x.run("UPDATE rebase_generations SET target_id=?,done=? WHERE source_id=?", head.generationId, m.schema === C.ROOT_MANIFEST_SCHEMA ? 0 : 1, row.generation_id);
      put(db, "restore-historical-operation:" + sha(Buffer.from(operationId)), "1");
      const oldProof = meta(db, "root-proof:" + row.generation_id);
      if (oldProof !== undefined) {
        put(db, "backup-evidence:import-source-proof:" + plan.planId + ":" + row.generation_id, oldProof);
        x.run("DELETE FROM metadata WHERE key=?", "root-proof:" + row.generation_id);
      }
      put(db, manifestKey(plan, row.generation_id), oldManifest);
      put(db, headKey(plan, head.generationId), oldPrepared.head);
      put(db, mapPrefix(plan) + row.generation_id, {
        sourceHead: oldPrepared.head,
        source: generationSummary(row, oldManifest),
        target: generationSummary(row, m),
        sourceOperationId: oldIntent.operationId,
        targetOperationId: operationId,
        sourceInputDigest: row.input_sha256,
        sourcePreparedDigest: row.prepared_sha256
      });
    }
    // Rebuild only structural roots. Original content-addressed history pages and all
    // source structural/provenance bytes are retained, never rewritten or compacted.
        const roots = require("./dependency-roots.cjs").createDependencyRoots({
      C: C,
      crypto: require("node:crypto"),
      db: db,
      one: x.one,
      iterate: x.iterate,
      run: x.run,
      meta: k => meta(db, k),
      setMeta: (k, v) => put(db, k, v),
      sha: sha,
      stable: stable,
      equal: equal,
      clone: clone,
      fail: fail,
      token: token,
      digest: digest,
      keys: (v, ks) => {
        if (!v || Object.keys(v).length !== ks.length || !ks.every(k => Object.hasOwn(v, k))) fail("import_root_unknown_field");
      },
      checked: (v, validate) => {
        if (!validate(v).ok) fail("import_root_invalid");
      },
      blob: (h, n, chunk) => x.blob(h, n, !chunk),
      storeBlob: (bytes, h) => {
        const old = x.one("SELECT utf8_bytes FROM blobs WHERE sha256=?", h);
        if (old) {
          x.blob(h, old.utf8_bytes);
          if (old.utf8_bytes !== bytes.length) fail("import_root_blob_conflict");
        } else x.run("INSERT INTO blobs VALUES (?,?,?)", h, bytes.length, bytes);
      }
    });
    while (x.one("SELECT 1 n FROM rebase_generations WHERE done=0")) {
      let progress = false;
      for (const row of x.iterate("SELECT target_id FROM rebase_generations WHERE done=0 ORDER BY target_id")) {
        const m = JSON.parse(x.one("SELECT manifest_json FROM generations WHERE generation_id=?", row.target_id).manifest_json);
        if (m.baseGenerationId && !x.one("SELECT 1 n FROM rebase_generations WHERE target_id=? AND done=1", m.baseGenerationId)) continue;
        x.run("DELETE FROM generation_items WHERE generation_id=?", m.generationId);
        roots.buildClosure(m);
        x.run("UPDATE rebase_generations SET done=1 WHERE target_id=?", m.generationId);
        progress = true;
      }
      if (!progress) fail("import_generation_dependency_cycle");
    }
    for (const row of x.iterate("SELECT * FROM heads ORDER BY scope")) {
      const h = rebaseHead(plan, JSON.parse(row.head_json)), json = stable(h);
      x.run("UPDATE heads SET generation_id=?,head_json=?,head_sha256=? WHERE scope=?", h.generationId, json, sha(Buffer.from(json)), row.scope);
    }
    for (const row of x.iterate("SELECT key,value FROM metadata WHERE key LIKE 'migration-canonical:%' OR key LIKE 'migration-empty:%' ORDER BY key")) {
      const v = JSON.parse(row.value);
      put(db, row.key, row.key.startsWith("migration-empty:") ? rebaseHead(plan, v) : {
        ...v,
        head: rebaseHead(plan, v.head)
      });
    }
    for (const row of x.iterate("SELECT operation_id FROM operations")) put(db, "restore-historical-operation:" + sha(Buffer.from(row.operation_id)), "1");
    const identity = plan.targetIdentity, route = {
      schema: C.ROUTE_SCHEMA,
      mode: "server_only",
      datasetId: identity.datasetId,
      backendId: identity.backendId,
      routeGeneration: identity.routeGeneration,
      state: "recovery_required"
    }, routeJson = stable(route);
    x.run("UPDATE dataset_route SET route_json=?,route_sha256=? WHERE singleton=1", routeJson, sha(Buffer.from(routeJson)));
    put(db, "identity", identity);
    put(db, "writer_epoch", identity.writerEpoch);
    put(db, "restore-historical-operation:" + sha(Buffer.from(plan.operationId)), "1");
    put(db, "inventory_revision", rebaseToken(plan, "inventory", component.inventoryDigest));
    put(db, "pin_boot_generation", rebaseToken(plan, "boot", plan.planId));
    for (const v of Object.values(identity)) put(db, "used:" + v, "1");
    const oldCut = JSON.parse(meta(db, "backup-cut"));
    for (const row of x.iterate("SELECT key,value FROM metadata WHERE key LIKE 'backup-cut-item:%' ORDER BY key")) put(db, cutPrefix(plan) + row.key.slice("backup-cut-item:".length), row.value);
    x.run("DELETE FROM metadata WHERE key LIKE 'backup-cut-item:%'");
    const cut = V.currentCut(db, {
      write: true,
      snapshotId: rebaseToken(plan, "snapshot", component.snapshotId),
      sourceStoreIdentity: identity
    }), mappings = summary("import-mappings");
    for (const row of x.iterate("SELECT value FROM metadata WHERE substr(key,1,?)=? ORDER BY key", mapPrefix(plan).length, mapPrefix(plan))) mappings.add(JSON.parse(row.value));
    const evidence = {
      schema: "wm.import-rebase-evidence.v2",
      planId: plan.planId,
      operationId: plan.operationId,
      sourceComponentSha256: component.sha256,
      sourceStoreIdentity: component.sourceStoreIdentity,
      sourceSnapshotId: component.snapshotId,
      sourceHeads: oldCut.heads,
      targetIdentity: identity,
      sourceInventoryDigest: component.inventoryDigest,
      targetInventoryDigest: cut.snapshot.inventoryDigest,
      mappings: mappings.finish(),
      historical: true,
      executionAuthority: false
    };
    put(db, evidenceKey(plan), evidence);
    put(db, "restore-admission", {
      schema: "wm.restore-admission.v1",
      operationId: plan.operationId,
      planId: plan.planId,
      incarnation: plan.incarnation,
      state: "recovery_required",
      historicalAuthority: false,
      sourceSnapshotId: component.snapshotId,
      inventoryDigest: cut.snapshot.inventoryDigest,
      sourceInventoryDigest: component.inventoryDigest,
      importSchema: "wm.cross-store-import.v1",
      sourceComponentSha256: component.sha256,
      rebaseEvidenceDigest: hash(evidence)
    });
    for (const t of triggers) db.exec(t.sql);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    db.close();
  }
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function verifyImportedFile(file, plan, component, expectedFileHash) {
  const B = require("./backup.cjs");
  if (expectedFileHash && B.hashFile(file) !== expectedFileHash) fail("import_target_digest_changed");
  const checked = B.inspectWmBackupFile(file, {
    restored: true
  }), db = new DatabaseSync(file, {
    readOnly: true
  });
  try {
    const a = checked.admission, identity = JSON.parse(meta(db, "identity")), e = JSON.parse(meta(db, evidenceKey(plan)) || "null"), route = JSON.parse(db.prepare("SELECT route_json FROM dataset_route WHERE singleton=1").get().route_json);
    if (!equal(identity, plan.targetIdentity) || !equal(checked.sourceStoreIdentity, identity) || route.state !== "recovery_required" || route.routeGeneration !== identity.routeGeneration || route.datasetId !== identity.datasetId || route.backendId !== identity.backendId || meta(db, "writer_epoch") !== identity.writerEpoch || !a || a.importSchema !== "wm.cross-store-import.v1" || a.operationId !== plan.operationId || a.planId !== plan.planId || a.incarnation !== plan.incarnation || a.state !== "recovery_required" || a.historicalAuthority !== false || a.sourceComponentSha256 !== component.sha256 || a.sourceInventoryDigest !== component.inventoryDigest || a.inventoryDigest !== checked.inventoryDigest || !e || e.schema !== "wm.import-rebase-evidence.v2" || e.executionAuthority !== false || e.historical !== true || e.planId !== plan.planId || e.operationId !== plan.operationId || e.sourceComponentSha256 !== component.sha256 || e.sourceInventoryDigest !== component.inventoryDigest || e.targetInventoryDigest !== checked.inventoryDigest || !equal(e.sourceStoreIdentity, component.sourceStoreIdentity) || !equal(e.targetIdentity, identity) || hash(e) !== a.rebaseEvidenceDigest || checked.generations.count !== component.generations.count || !equal(checked.rawInventory, component.rawInventory) || !equal(checked.contentInventory, component.contentInventory) || !equal(checked.operationHistory, component.operationHistory) || !equal(checked.manual??null, component.manual??null)) fail("import_target_binding_invalid");
    const mappings = summary("import-mappings"), sources = summary("generations");
    let n = 0;
    for (const row of db.prepare("SELECT key,value FROM metadata WHERE substr(key,1,?)=? ORDER BY key").iterate(mapPrefix(plan).length, mapPrefix(plan))) {
      const v = JSON.parse(row.value), g = db.prepare("SELECT * FROM generations WHERE generation_id=?").get(v.target.generationId), m = g && JSON.parse(g.manifest_json);
      if (!C.validateHead(v.sourceHead).ok || v.sourceHead.generationId !== v.source.generationId || !equal(JSON.parse(meta(db, headKey(plan, v.target.generationId)) || "null"), v.sourceHead) || !equal(JSON.parse(g?.prepared_json || "null")?.head, rebaseHead(plan, v.sourceHead)) || row.key !== mapPrefix(plan) + v.source.generationId || v.target.generationId !== rebaseToken(plan, "generation", v.source.generationId) || v.targetOperationId !== rebaseToken(plan, "import-op", v.sourceOperationId) || !g || !equal(generationSummary(g, m), v.target) || v.source.scope !== v.target.scope || v.source.rawSha256 !== v.target.rawSha256 || v.source.utf8Bytes !== v.target.utf8Bytes || !meta(db, "restore-historical-operation:" + sha(Buffer.from(v.targetOperationId)))) fail("import_generation_mapping_invalid");
      const original = JSON.parse(meta(db, manifestKey(plan, v.source.generationId)) || "null");
      if (!C.validateManifest(original).ok || v.sourceOperationId !== original.operationId || v.targetOperationId !== m.operationId || original.manifestDigest !== v.source.manifestDigest || !equal(generationSummary(null, original), v.source)) fail("import_manifest_mapping_invalid");
      const derived = {
        ...original,
        generationId: v.target.generationId,
        expectedHead: rebaseHead(plan, original.expectedHead),
        operationId: rebaseToken(plan, "import-op", original.operationId),
        routeGeneration: plan.targetIdentity.routeGeneration,
        writerEpoch: plan.targetIdentity.writerEpoch
      };
      if (derived.schema === C.ROOT_MANIFEST_SCHEMA) derived.baseGenerationId = derived.baseGenerationId === null ? null : rebaseToken(plan, "generation", derived.baseGenerationId);
      derived.manifestDigest = hash(without(derived, "manifestDigest"));
      if (!equal(derived, m)) fail("import_manifest_mapping_invalid");
      sources.add(v.source);
      mappings.add(v);
      n++;
    }
    if (n !== component.generations.count || !equal(sources.finish(), component.generations) || !equal(mappings.finish(), e.mappings)) fail("import_generation_mapping_invalid");
    const sourceCutHash = require("node:crypto").createHash("sha256");
    sourceCutHash.update("wm.inventory-snapshot.v1\n");
    let ordinal = 0;
    const ctx = V.context(db);
    for (const row of db.prepare("SELECT key,value FROM metadata WHERE substr(key,1,?)=? ORDER BY key").iterate(cutPrefix(plan).length, cutPrefix(plan))) {
      if (row.key !== cutPrefix(plan) + String(ordinal++).padStart(16, "0")) fail("import_source_cut_invalid");
      const d = JSON.parse(row.value);
      if (!require("./pins.cjs").validateInventoryItem(d).ok || d.domain !== "canonical" && !equal(ctx.descriptor(d.logicalId), d)) fail("import_source_cut_invalid");
      sourceCutHash.update(stable(d) + "\n");
    }
    if (sourceCutHash.digest("hex") !== component.inventoryDigest) fail("import_source_cut_invalid");
    const sourceHeads = summary("heads");
    for (const row of db.prepare("SELECT head_json FROM heads ORDER BY scope").iterate()) {
      const targetHead = JSON.parse(row.head_json), original = JSON.parse(meta(db, headKey(plan, targetHead.generationId)) || "null");
      if (!C.validateHead(original).ok || !equal(rebaseHead(plan, original), targetHead)) fail("import_head_mapping_invalid");
      sourceHeads.add(original);
    }
    if (!equal(sourceHeads.finish(), component.heads) || !equal(e.sourceHeads, component.heads)) fail("import_head_mapping_invalid");
    for (const row of db.prepare("SELECT operation_id FROM operations").iterate()) if (!meta(db, "restore-historical-operation:" + sha(Buffer.from(row.operation_id)))) fail("import_source_operation_authority");
    return checked;
  } finally {
    db.close();
  }
}

module.exports = {
  rebaseStage: rebaseStage,
  verifyImportedFile: verifyImportedFile
};
