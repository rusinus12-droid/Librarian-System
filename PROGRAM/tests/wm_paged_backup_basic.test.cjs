"use strict";

// Synthetic SQLite feature checks only. No server listener or production activation.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const F = require("./helpers/wm-fixture.cjs"), B = require("../server/wm/backup.cjs"), {createWmStore: createWmStore} = require("../server/wm/store.cjs"), {createWmPins: createWmPins} = require("../server/wm/pins.cjs"), E = require("../wm/src/wm-extension-history.source.js");

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.WM_BASIC_CHECKPOINT || os.tmpdir(), "paged-backup-")), databasePath = path.join(dir, "source.sqlite"), identity = F.storeIdentity(), store = createWmStore({
    databasePath: databasePath,
    identity: identity
  }), pins = createWmPins({
    store: store,
    bootId: "backup-source"
  });
  t.after(() => {
    try {
      store.close();
    } catch {}
  });
  const head = store.initializeScope(F.initialization()).receipt.head, receipt = store.beginPageStage(F.signed({
    operationId: "pages-session",
    scope: head.scope,
    expectedHead: head,
    routeGeneration: "route-1",
    writerEpoch: "epoch-a"
  }));
  const owner = {
    profile: "server-pinned-roots-v2",
    async getItem(k) {
      const logicalId = k.replace("wm.cold.extension.", "");
      try {
        return Buffer.from(store.readStagedPage({
          receipt: receipt,
          logicalId: logicalId,
          offset: 0,
          maxBytes: 65536
        }).bytes).toString();
      } catch (e) {
        if (/staged_page_missing/.test(e.message)) return null;
        throw e;
      }
    },
    async setItem(k, v) {
      const p = JSON.parse(v), descriptor = {
        domain: "cold",
        schema: p.schema,
        logicalId: p.logicalId,
        originScope: p.scope,
        bytes: Buffer.byteLength(v),
        sha256: F.sha(Buffer.from(v)),
        dependencies: p.dependencies,
        disposition: null
      };
      store.stagePage(F.signed({
        operationId: "p-" + descriptor.sha256,
        receipt: receipt,
        descriptor: descriptor,
        payload: {
          encoding: "base64",
          data: Buffer.from(v).toString("base64")
        }
      }));
    }
  };
  const history = E.createHistory({
    owner: owner,
    scope: head.scope,
    mode: "server_only",
    profile: owner.profile
  });
  const lock = {
    key: "semantic-lock:one",
    comment: "lmai_extension_lock",
    content: '{"seed":"fixed","roll":17}'
  }, event = {
    key: "event:one",
    comment: "lmai_extension_event",
    extensionPacketId: "packet:one",
    extensionScope: head.scope,
    extensionStatus: "prepared",
    content: '{"result":{"roles":{"tracker":{"value":["frozen result"]}}}}'
  };
  let root = history.empty();
  root = await history.put(root, lock);
  root = await history.put(root, event);
  const raw = JSON.stringify({
    entries: [ history.toRow(root) ],
    seed: 42,
    anchor: -9
  }), manifest = F.seal({
    schema: "wm.generation-roots.v2",
    scope: head.scope,
    generationId: "gen-history",
    canonical: {
      sha256: F.sha(Buffer.from(raw)),
      utf8Bytes: Buffer.byteLength(raw)
    },
    dependencyRoots: [ root.head ],
    baseGenerationId: head.generationId,
    routeGeneration: "route-1",
    writerEpoch: "epoch-a",
    expectedHead: head,
    operationId: "write-history"
  }), input = F.signed({
    operationId: manifest.operationId,
    operation: "normal",
    scope: head.scope,
    expectedHead: head,
    routeGeneration: "route-1",
    writerEpoch: "epoch-a",
    raw: raw,
    manifest: manifest
  }), prepared = store.prepare(input);
  store.publish(prepared);
  const outputDir = path.join(dir, "backup"), backup = B.createWmBackup({
    store: store,
    pins: pins,
    outputDir: outputDir,
    restoreEnabled: true
  });
  return {
    dir: dir,
    databasePath: databasePath,
    identity: identity,
    store: store,
    pins: pins,
    root: root,
    lock: lock,
    event: event,
    input: input,
    prepared: prepared,
    raw: raw,
    outputDir: outputDir,
    backup: backup
  };
}

async function verifyHistory(store, pins, x) {
  const pin = pins.acquire("scope-a"), owner = {
    profile: "server-pinned-roots-v2",
    async getItem(k) {
      return Buffer.from(pins.readCompanion({
        lease: pin.lease,
        logicalId: k.replace("wm.cold.extension.", ""),
        offset: 0,
        maxBytes: 65536
      }).bytes).toString();
    },
    async setItem() {
      throw Error("unchanged semantic record must not write");
    }
  }, h = E.createHistory({
    owner: owner,
    scope: "scope-a",
    mode: "server_only",
    profile: owner.profile
  }), root = h.fromLore(JSON.parse(pins.readGeneration(pin.lease)).entries);
  assert.deepEqual(await h.get(root, x.lock.key), x.lock);
  assert.deepEqual(await h.get(root, x.event.key), x.event);
  assert.deepEqual(await h.put(root, x.lock), root);
  assert.deepEqual(await h.put(root, x.event), root);
  assert.equal((await h.pending(root, {
    limit: 1
  })).rows[0].key, x.event.key);
  await assert.rejects(h.put(root, {
    ...x.lock,
    content: "changed"
  }), /history_lock_immutable/);
  return pin;
}

test("v2 compact capture and same-physical restore preserve complete paged history and dedup", async t => {
  const x = await fixture(t), component = x.backup.capture({
    backupId: "paged"
  });
  assert.equal(component.schema, "wm.backup-component.v2");
  assert.equal(Array.isArray(component.generations), false);
  assert.equal(component.generations.count, 2);
  assert.equal(x.backup.verify(component).ok, true);
  const sourceHash = B.hashFile(path.join(x.outputDir, component.file)), plan = x.backup.prepareRestore({
    operationId: "restore-paged",
    component: component,
    expectedStoreIdentity: x.store.readDatasetState().identity
  }), r = x.backup.applyRestore({
    planId: plan.planId,
    confirmation: plan.confirmation,
    expectedCurrentFingerprint: plan.expectedCurrentFingerprint
  });
  assert.equal(r.status, "committed");
  assert.deepEqual(x.backup.applyRestore({
    planId: plan.planId,
    confirmation: plan.confirmation,
    expectedCurrentFingerprint: plan.expectedCurrentFingerprint
  }), r);
  const target = createWmStore({
    databasePath: x.databasePath,
    identity: x.identity
  });
  t.after(() => target.close());
  const pins = createWmPins({
    store: target,
    bootId: "restored"
  });
  await verifyHistory(target, pins, x);
  assert.equal(target.readDatasetState().route.state, "recovery_required");
  assert.throws(() => target.publish(x.prepared), /historical_operation_not_executable/);
  assert.equal(B.hashFile(path.join(x.outputDir, component.file)), sourceHash);
});

test("v2 fresh import rebases roots and identities, keeps page bytes and same-ID ACK receipt", async t => {
  const x = await fixture(t), component = x.backup.capture({
    backupId: "paged-import"
  }), sourceHash = B.hashFile(path.join(x.outputDir, component.file)), targetPath = path.join(x.dir, "target.sqlite"), importer = B.createWmBackupImport({
    targetPath: targetPath,
    importEnabled: true
  }), request = {
    operationId: "import-paged",
    component: component,
    backupRoot: x.outputDir,
    targetDatasetId: "new-dataset",
    targetBackendId: "new-backend"
  }, plan = importer.prepare(request), args = {
    planId: plan.planId,
    confirmation: plan.confirmation,
    requestFingerprint: plan.requestFingerprint
  }, r = importer.apply(args);
  assert.equal(r.status, "committed");
  assert.equal(r.receipt.sourceInventoryDigest, component.inventoryDigest);
  assert.notEqual(r.receipt.inventoryDigest, component.inventoryDigest);
  assert.equal(r.receipt.activation, false);
  const recordPath = targetPath + ".import-plan.json", record = JSON.parse(fs.readFileSync(recordPath));
  record.phase = "publishing";
  delete record.result;
  fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.deepEqual(B.createWmBackupImport({
    targetPath: targetPath,
    importEnabled: true
  }).apply(args), r);
  const target = createWmStore({
    databasePath: targetPath,
    identity: plan.targetIdentity
  });
  t.after(() => target.close());
  const pins = createWmPins({
    store: target,
    bootId: "imported"
  });
  await verifyHistory(target, pins, x);
  assert.throws(() => target.publish(x.prepared), /historical_operation_not_executable/);
  assert.equal(target.status({
    operationId: x.input.operationId,
    requestFingerprint: x.input.requestFingerprint
  }).receipt.executionAuthority, false);
  assert.equal(B.hashFile(path.join(x.outputDir, component.file)), sourceHash);
  const exported = B.createWmBackup({
    store: x.store,
    pins: x.pins,
    outputDir: path.join(x.dir, "repeat")
  }).capture({
    backupId: "repeat-source"
  });
  assert.equal(exported.inventoryDigest, component.inventoryDigest);
});

test("v2 missing proof or closure rejects before any fresh target is published", async t => {
  const x = await fixture(t), component = x.backup.capture({
    backupId: "bad-source"
  }), file = path.join(x.outputDir, component.file);
  F.sqliteMutate(file, db => db.prepare("DELETE FROM metadata WHERE key LIKE 'root-proof:%'").run());
  const bad = {
    ...component,
    sha256: B.hashFile(file),
    bytes: fs.statSync(file).size
  }, targetPath = path.join(x.dir, "rejected.sqlite"), i = B.createWmBackupImport({
    targetPath: targetPath,
    importEnabled: true
  });
  assert.throws(() => i.prepare({
    operationId: "bad-import",
    component: bad,
    backupRoot: x.outputDir,
    targetDatasetId: "new-dataset",
    targetBackendId: "new-backend"
  }), /root_proof/);
  assert.equal(fs.existsSync(targetPath), false);
});

test("v2 inspector rejects oversized proof metadata before JSON decoding", async t => {
  const x = await fixture(t), c = x.backup.capture({
    backupId: "oversize-proof"
  }), file = path.join(x.outputDir, c.file);
  F.sqliteMutate(file, db => db.prepare("UPDATE metadata SET value=? WHERE key LIKE 'root-proof:%'").run(" ".repeat(65537)));
  assert.throws(() => B.inspectWmBackupFile(file), /backup_metadata_limit/);
});

test("v2 fresh import selection binds the source digest and the distinct target digest", async t => {
  const x = await fixture(t), c = x.backup.capture({
    backupId: "selection"
  }), I = require("../server/wm/import_control.cjs"), fake = {
    status: () => ({
      available: true,
      initialized: false
    }),
    suspendForImportAdoption() {}
  }, control = I.createWmImportControl({
    dataDir: x.dir,
    dataInstanceId: "synthetic-instance",
    restoreEnabled: true,
    service: fake,
    listBackups: () => [ {
      id: c.backupId,
      components: {
        wm: c
      },
      coverage: {
        wm: "included"
      },
      path: x.outputDir
    } ]
  });
  let v = await control.handle({
    command: "prepare",
    operationId: "select-paged-history",
    backupId: c.backupId
  });
  const p = v.plan, request = {
    operationId: p.operationId,
    planId: p.planId,
    requestFingerprint: p.requestFingerprint
  };
  v = await control.handle({
    command: "apply",
    ...request,
    confirmation: p.confirmation
  });
  await control.handle({
    command: "adopt",
    ...request,
    confirmation: v.adoption.confirmation
  });
  const selected = I.resolveWmImportSelection({
    dataDir: x.dir,
    dataInstanceId: "synthetic-instance",
    restoreEnabled: true
  });
  assert.equal(selected.databasePath, p.targetPath);
  assert.deepEqual(selected.serverIdentity, p.targetIdentity);
});

test("v2 multi-generation import retains mixed raw history, orphan pages, empty scopes and re-export", async t => {
  const x = await fixture(t), items = [ "raw", "raw_history", "lineage", "orphan" ].map(domain => {
    const payload = Buffer.from("exact " + domain + "\r\n🌍"), descriptor = {
      ...F.item(domain, "mixed-" + domain, domain === "raw_history" ? [ "mixed-raw" ] : []),
      bytes: payload.length,
      sha256: F.sha(payload)
    };
    return {
      descriptor: descriptor,
      payload: payload
    };
  });
  const raw = JSON.stringify({
    version: 1,
    kind: "unpublished",
    data: {
      still: "preserved"
    }
  }), id = "eh-" + F.sha(Buffer.from(JSON.stringify([ "scope-a", raw, [] ]))), text = JSON.stringify({
    schema: "wm.extension-history-page.v1",
    scope: "scope-a",
    logicalId: id,
    raw: raw,
    dependencies: []
  });
  items.push({
    descriptor: {
      domain: "cold",
      schema: "wm.extension-history-page.v1",
      logicalId: id,
      originScope: "scope-a",
      bytes: Buffer.byteLength(text),
      sha256: F.sha(Buffer.from(text)),
      dependencies: [],
      disposition: null
    },
    payload: Buffer.from(text)
  });
  x.store.putInventoryItems(F.inventoryWrite({
    operationId: "mixed-items",
    expectedInventoryRevision: x.store.readLifecycleState().inventoryRevision,
    items: items
  }));
  const head = x.pins.acquire("scope-a").head, manifest = F.seal({
    ...x.input.manifest,
    generationId: "gen-history-2",
    operationId: "write-history-2",
    expectedHead: head,
    baseGenerationId: head.generationId,
    dependencyRoots: [ x.root.head, ...items.slice(0, 4).map(v => v.descriptor.logicalId) ]
  }), next = F.signed({
    ...x.input,
    operationId: manifest.operationId,
    expectedHead: head,
    manifest: manifest
  });
  x.store.publish(x.store.prepare(next));
  x.store.initializeScope(F.initialization("scope-empty", "empty-init"));
  const before = x.backup.currentFingerprint(), c = x.backup.capture({
    backupId: "mixed"
  });
  assert.equal(c.generations.count, 4);
  assert.equal(c.rawInventory.count, 2);
  const pth = path.join(x.dir, "mixed-target.sqlite"), i = B.createWmBackupImport({
    targetPath: pth,
    importEnabled: true
  }), p = i.prepare({
    operationId: "mixed-import",
    component: c,
    backupRoot: x.outputDir,
    targetDatasetId: "mixed-target",
    targetBackendId: "mixed-backend"
  }), r = i.apply({
    planId: p.planId,
    confirmation: p.confirmation,
    requestFingerprint: p.requestFingerprint
  });
  assert.equal(r.status, "committed");
  assert.equal(x.backup.currentFingerprint(), before);
  const source = F.sqliteRead(path.join(x.outputDir, c.file), "SELECT descriptor_json FROM inventory_items WHERE json_extract(descriptor_json,'$.schema')<>'wm.dependency-root.v1' ORDER BY logical_id"), target = F.sqliteRead(pth, "SELECT descriptor_json FROM inventory_items WHERE json_extract(descriptor_json,'$.schema')<>'wm.dependency-root.v1' ORDER BY logical_id");
  assert.deepEqual(target, source);
  const s = createWmStore({
    databasePath: pth,
    identity: p.targetIdentity
  });
  t.after(() => s.close());
  const pins = createWmPins({
    store: s,
    bootId: "mixed-reopen"
  });
  await verifyHistory(s, pins, x);
  assert.equal(pins.readGeneration(pins.acquire("scope-empty").lease), null);
  const out = path.join(x.dir, "target-reexport"), backup = B.createWmBackup({
    store: s,
    pins: pins,
    outputDir: out
  }), exported = backup.capture({
    backupId: "re-export"
  });
  assert.equal(backup.verify(exported).ok, true);
  assert.equal(exported.inventoryDigest, r.receipt.inventoryDigest);
  assert.deepEqual(exported.contentInventory, c.contentInventory);
  assert.deepEqual(exported.rawInventory, c.rawInventory);
});

test("v2 capture/import does not materialize whole inventory, generation or operation row arrays", async t => {
  const x = await fixture(t), {DatabaseSync: DatabaseSync} = require("node:sqlite"), probe = new DatabaseSync(":memory:"), proto = Object.getPrototypeOf(probe.prepare("SELECT 1")), original = proto.all;
  probe.close();
  proto.all = function(...args) {
    if (/FROM\s+(?:main\.)?(inventory_items|generations|operations|metadata)\b/i.test(this.sourceSQL)) throw Error("whole metadata array forbidden");
    return original.apply(this, args);
  };
  try {
    const c = x.backup.capture({
      backupId: "bounded"
    }), i = B.createWmBackupImport({
      targetPath: path.join(x.dir, "bounded.sqlite"),
      importEnabled: true
    }), p = i.prepare({
      operationId: "bounded-import",
      component: c,
      backupRoot: x.outputDir,
      targetDatasetId: "bounded-target",
      targetBackendId: "bounded-backend"
    });
    assert.equal(i.apply({
      planId: p.planId,
      confirmation: p.confirmation,
      requestFingerprint: p.requestFingerprint
    }).status, "committed");
    assert(Buffer.byteLength(JSON.stringify(c)) < 4096);
  } finally {
    proto.all = original;
  }
});

test("v2 preserved canonical cut cannot replace the actual head blob with a rehashed dangling descriptor", async t => {
  const x = await fixture(t), c = x.backup.capture({
    backupId: "false-canonical"
  }), file = path.join(x.outputDir, c.file);
  F.sqliteMutate(file, db => {
    const row = db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'backup-cut-item:%' AND json_extract(value,'$.domain')='canonical'").get(), d = {
      ...JSON.parse(row.value),
      sha256: "f".repeat(64)
    }, head = JSON.parse(db.prepare("SELECT head_json FROM heads WHERE scope=?").get("scope-a").head_json);
    db.prepare("INSERT INTO metadata VALUES (?,?)").run("migration-canonical:" + F.sha(Buffer.from("scope-a")), F.stable({
      head: head,
      descriptor: d
    }));
    db.prepare("UPDATE metadata SET value=? WHERE key=?").run(F.stable(d), row.key);
    const h = require("node:crypto").createHash("sha256");
    h.update("wm.inventory-snapshot.v1\n");
    for (const r of db.prepare("SELECT value FROM metadata WHERE key LIKE 'backup-cut-item:%' ORDER BY key").iterate()) h.update(F.stable(JSON.parse(r.value)) + "\n");
    const cut = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='backup-cut'").get().value);
    cut.snapshot.inventoryDigest = h.digest("hex");
    db.prepare("UPDATE metadata SET value=? WHERE key='backup-cut'").run(F.stable(cut));
  });
  assert.throws(() => B.inspectWmBackupFile(file), /backup_canonical_cut/);
});

test("v2 recovery readback rejects internally rehashed removal of current heads", async t => {
  const x = await fixture(t), c = x.backup.capture({
    backupId: "head-binding"
  }), file = path.join(x.dir, "head-target.sqlite"), i = B.createWmBackupImport({
    targetPath: file,
    importEnabled: true
  }), p = i.prepare({
    operationId: "head-import",
    component: c,
    backupRoot: x.outputDir,
    targetDatasetId: "head-target",
    targetBackendId: "head-backend"
  });
  i.apply({
    planId: p.planId,
    confirmation: p.confirmation,
    requestFingerprint: p.requestFingerprint
  });
  const V = require("../server/wm/backup_stream.cjs");
  F.sqliteMutate(file, db => {
    db.exec("DELETE FROM heads");
    db.exec("DELETE FROM metadata WHERE key LIKE 'backup-cut-item:%'");
    const prior = JSON.parse(V.meta(db, "backup-cut")), cut = V.currentCut(db, {
      write: true,
      snapshotId: prior.snapshot.snapshotId,
      sourceStoreIdentity: p.targetIdentity
    }), key = "backup-evidence:cross-store-import:" + p.planId, e = JSON.parse(V.meta(db, key)), a = JSON.parse(V.meta(db, "restore-admission"));
    e.targetInventoryDigest = cut.snapshot.inventoryDigest;
    a.inventoryDigest = cut.snapshot.inventoryDigest;
    a.rebaseEvidenceDigest = F.sha(Buffer.from(F.stable(e)));
    V.put(db, key, e);
    V.put(db, "restore-admission", a);
  });
  assert.throws(() => require("../server/wm/backup_rebase.cjs").verifyImportedFile(file, p, c), /import_head_mapping_invalid/);
});

test("v2 retains the same inert handoff-stage provenance fields as v1", async t => {
  const x = await fixture(t), fields = {
    transferId: "transfer-synthetic",
    sourceIdentity: {
      storeId: "source"
    },
    targetIdentity: {
      storeId: "target"
    },
    sourceHead: x.input.expectedHead,
    sourceRoute: F.storeRoute(),
    targetRoute: {
      ...F.storeRoute(),
      backendId: "target"
    },
    payloadDigest: "a".repeat(64),
    domains: {
      cold: {
        count: 1,
        bytes: 4,
        complete: true
      }
    }
  }, stage = {
    operationId: "pending-handoff",
    requestFingerprint: "b".repeat(64),
    state: "materialized",
    kind: "handoff",
    snapshot: {
      snapshotId: "synthetic"
    },
    copiedBytes: 4,
    itemCount: 1,
    ...fields
  };
  F.sqliteMutate(x.databasePath, db => db.prepare("INSERT INTO metadata VALUES (?,?)").run("migration-stage:pending-handoff", F.stable(stage)));
  const c = x.backup.capture({
    backupId: "handoff-evidence"
  }), e = JSON.parse(F.sqliteRead(path.join(x.outputDir, c.file), "SELECT value FROM metadata WHERE key='backup-evidence:migration-stage:pending-handoff'")[0].value);
  assert.equal(e.inert, true);
  for (const [k, v] of Object.entries(fields)) assert.deepEqual(e[k], v);
  assert.equal(F.sqliteRead(path.join(x.outputDir, c.file), "SELECT count(*) n FROM metadata WHERE key LIKE 'migration-stage:%'")[0].n, 0);
});

test("v2 recovery rejects a self-consistent target that drops source dependency roots", async t => {
  const x = await fixture(t), c = x.backup.capture({
    backupId: "intent-binding"
  }), file = path.join(x.dir, "intent-target.sqlite"), i = B.createWmBackupImport({
    targetPath: file,
    importEnabled: true
  }), p = i.prepare({
    operationId: "intent-import",
    component: c,
    backupRoot: x.outputDir,
    targetDatasetId: "intent-target",
    targetBackendId: "intent-backend"
  });
  i.apply({
    planId: p.planId,
    confirmation: p.confirmation,
    requestFingerprint: p.requestFingerprint
  });
  const V = require("../server/wm/backup_stream.cjs");
  F.sqliteMutate(file, db => {
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('generations','generation_items')").all();
    for (const tr of triggers) db.exec("DROP TRIGGER " + tr.name);
    const row = db.prepare("SELECT g.* FROM generations g JOIN heads h USING(generation_id) WHERE h.scope='scope-a'").get(), old = JSON.parse(row.manifest_json), m = F.seal({
      ...old,
      dependencyRoots: [],
      baseGenerationId: null
    }), intent = F.signed({
      ...JSON.parse(row.input_json),
      manifest: m
    }), prepared = {
      ...JSON.parse(row.prepared_json),
      requestFingerprint: intent.requestFingerprint
    };
    db.prepare("UPDATE generations SET manifest_json=?,manifest_digest=?,input_json=?,input_sha256=?,prepared_json=?,prepared_sha256=? WHERE generation_id=?").run(F.stable(m), m.manifestDigest, F.stable(intent), F.sha(Buffer.from(F.stable(intent))), F.stable(prepared), F.sha(Buffer.from(F.stable(prepared))), m.generationId);
    const body = F.stable({
      schema: "wm.dependency-root.v1",
      scope: m.scope,
      generationId: m.generationId,
      manifestDigest: m.manifestDigest,
      kind: "generation",
      dependencies: []
    }), hash = F.sha(Buffer.from(body)), d = {
      domain: "cold",
      schema: "wm.dependency-root.v1",
      logicalId: "root-" + hash,
      originScope: m.scope,
      bytes: Buffer.byteLength(body),
      sha256: hash,
      dependencies: [],
      disposition: null
    };
    db.prepare("INSERT INTO blobs VALUES (?,?,?)").run(hash, d.bytes, Buffer.from(body));
    db.prepare("INSERT INTO inventory_items VALUES (?,?,?,?)").run(d.logicalId, F.stable(d), F.sha(Buffer.from(F.stable(d))), hash);
    db.prepare("DELETE FROM generation_items WHERE generation_id=?").run(m.generationId);
    db.prepare("INSERT INTO generation_items VALUES (?,?,?,?,?)").run(m.generationId, 0, d.logicalId, F.stable(d), hash);
    const proof = {
      schema: "wm.root-closure-proof.v1",
      generationId: m.generationId,
      manifestDigest: m.manifestDigest,
      rootId: d.logicalId,
      count: 1,
      bytes: d.bytes,
      closureDigest: F.sha(Buffer.from("wm.root-closure.v1\n" + F.stable(d) + "\n"))
    };
    V.put(db, "root-proof:" + m.generationId, {
      ...proof,
      seal: F.sha(Buffer.from(F.stable(proof)))
    });
    const prefix = "backup-evidence:import-map:" + p.planId + ":", mapping = db.prepare("SELECT key,value FROM metadata WHERE substr(key,1,?)=? AND json_extract(value,'$.target.generationId')=?").get(prefix.length, prefix, m.generationId), v = JSON.parse(mapping.value);
    v.target.manifestDigest = m.manifestDigest;
    V.put(db, mapping.key, v);
    db.exec("DELETE FROM metadata WHERE key LIKE 'backup-cut-item:%'");
    const prior = JSON.parse(V.meta(db, "backup-cut")), cut = V.currentCut(db, {
      write: true,
      snapshotId: prior.snapshot.snapshotId,
      sourceStoreIdentity: p.targetIdentity
    }), key = "backup-evidence:cross-store-import:" + p.planId, e = JSON.parse(V.meta(db, key)), a = JSON.parse(V.meta(db, "restore-admission")), sum = V.summary("import-mappings");
    for (const r of db.prepare("SELECT value FROM metadata WHERE substr(key,1,?)=? ORDER BY key").iterate(prefix.length, prefix)) sum.add(JSON.parse(r.value));
    e.mappings = sum.finish();
    e.targetInventoryDigest = cut.snapshot.inventoryDigest;
    a.inventoryDigest = cut.snapshot.inventoryDigest;
    a.rebaseEvidenceDigest = F.sha(Buffer.from(F.stable(e)));
    V.put(db, key, e);
    V.put(db, "restore-admission", a);
    for (const tr of triggers) db.exec(tr.sql);
  });
  assert.throws(() => require("../server/wm/backup_rebase.cjs").verifyImportedFile(file, p, c), /import_manifest_mapping_invalid/);
});

test("v2 recovery binds inert operation markers to the actual rebased generation intent", async t => {
  const x = await fixture(t), c = x.backup.capture({
    backupId: "operation-binding"
  }), file = path.join(x.dir, "operation-target.sqlite"), i = B.createWmBackupImport({
    targetPath: file,
    importEnabled: true
  }), p = i.prepare({
    operationId: "operation-import",
    component: c,
    backupRoot: x.outputDir,
    targetDatasetId: "operation-target",
    targetBackendId: "operation-backend"
  });
  i.apply({
    planId: p.planId,
    confirmation: p.confirmation,
    requestFingerprint: p.requestFingerprint
  });
  const V = require("../server/wm/backup_stream.cjs");
  F.sqliteMutate(file, db => {
    const prefix = "backup-evidence:import-map:" + p.planId + ":", row = db.prepare("SELECT key,value FROM metadata WHERE substr(key,1,?)=? LIMIT 1").get(prefix.length, prefix), m = JSON.parse(row.value);
    db.prepare("DELETE FROM metadata WHERE key=?").run("restore-historical-operation:" + F.sha(Buffer.from(m.targetOperationId)));
    m.sourceOperationId = "unrelated-source-operation";
    m.targetOperationId = "import-op-" + F.sha(Buffer.from(F.stable({
      authority: p.targetIdentity.authorityId,
      kind: "import-op",
      original: m.sourceOperationId
    }))).slice(0, 56);
    V.put(db, "restore-historical-operation:" + F.sha(Buffer.from(m.targetOperationId)), "1");
    V.put(db, row.key, m);
    const sum = V.summary("import-mappings");
    for (const r of db.prepare("SELECT value FROM metadata WHERE substr(key,1,?)=? ORDER BY key").iterate(prefix.length, prefix)) sum.add(JSON.parse(r.value));
    const key = "backup-evidence:cross-store-import:" + p.planId, e = JSON.parse(V.meta(db, key)), a = JSON.parse(V.meta(db, "restore-admission"));
    e.mappings = sum.finish();
    a.rebaseEvidenceDigest = F.sha(Buffer.from(F.stable(e)));
    V.put(db, key, e);
    V.put(db, "restore-admission", a);
  });
  assert.throws(() => require("../server/wm/backup_rebase.cjs").verifyImportedFile(file, p, c), /import_manifest_mapping_invalid/);
});

test("v2 backup also binds manual native-record history without changing strong roots",async t=>{const x=await fixture(t),profile="wm.manual-copy-switch.v1",value=JSON.stringify({version:1,scopeKey:"scope-a",entries:[]}),d={id:F.sha(Buffer.from("plugin\nLIBRA_DATA::v1::x")),space:"plugin",key:"LIBRA_DATA::v1::x",domain:"canonical",bytes:Buffer.byteLength(value),sha256:F.sha(Buffer.from(value)),tombstone:false},inventoryDigest=F.sha(Buffer.from(F.stable([d]))),expected={activeId:null,revision:"empty"};const call=(a,b={})=>x.store.manual(a,{profile,...b});call("begin",{generation:"manual-paged",records:[d],inventoryDigest,expected});call("chunk",{generation:"manual-paged",id:d.id,offset:0,data:Buffer.from(value).toString("base64")});call("seal",{generation:"manual-paged",inventoryDigest});call("activate",{generation:"manual-paged",inventoryDigest,expected});const component=x.backup.capture({backupId:"manual-with-paged"});assert.equal(component.schema,"wm.backup-component.v2");assert.equal(component.manual.profile,profile);assert.equal(x.backup.verify(component).ok,true);const stagePath=path.join(x.dir,"manual-stage.sqlite");B.stageWmRestoreFile({component,backupRoot:x.outputDir,stagePath,expectedStoreIdentity:component.sourceStoreIdentity,operationId:"manual-v2-restore",planId:"manual-v2-plan"});assert.deepEqual(B.inspectWmBackupFile(stagePath,{restored:true}).manual,component.manual);});
