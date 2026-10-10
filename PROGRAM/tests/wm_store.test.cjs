"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const f = require("./helpers/wm-fixture.cjs"), api = f.loadStore();

function fixture(t, options = {}) {
  assert.equal(typeof api.createWmStore, "function", "A2 required API missing: createWmStore");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-a2-synthetic-")), databasePath = path.join(dir, "wm.sqlite");
  const config = {
    databasePath: databasePath,
    identity: f.storeIdentity(),
    clock: () => 0,
    ...options
  };
  let store = api.createWmStore(config);
  t.after(() => {
    try {
      store.close();
    } catch (_) {}
  });
  return {
    databasePath: databasePath,
    config: config,
    get store() {
      return store;
    },
    reopen() {
      try {
        store.close();
      } catch (_) {}
      store = api.createWmStore(config);
      return store;
    }
  };
}

const head = x => f.sqliteRead(x.databasePath, "SELECT head_json FROM heads WHERE scope=?", "scope-a")[0] && JSON.parse(f.sqliteRead(x.databasePath, "SELECT head_json FROM heads WHERE scope=?", "scope-a")[0].head_json);

const init = x => {
  const r = x.store.initializeScope(f.initialization());
  assert.equal(r.status, "committed");
  return r.receipt.head;
};

const publish = (x, h, opts) => {
  const input = f.storeWrite(h, opts);
  const prepared = x.store.prepare(input);
  return {
    input: input,
    prepared: prepared,
    result: x.store.publish(prepared)
  };
};

const readRoute = x => JSON.parse(f.sqliteRead(x.databasePath, "SELECT route_json FROM dataset_route WHERE singleton=1")[0].route_json);

const counts = x => Object.fromEntries([ "heads", "generations", "operations", "blobs", "inventory_items" ].map(n => [ n, f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM " + n)[0].n ]));

// Removing the publish CAS or committing head separately from receipt must break this test.
test("wm_publish_has_one_expected_head_winner", t => {
  const x = fixture(t);
  const h = init(x);
  const a = x.store.prepare(f.storeWrite(h, {
    operationId: "write-a",
    generationId: "gen-a"
  }));
  const b = x.store.prepare(f.storeWrite(h, {
    operationId: "write-b",
    generationId: "gen-b",
    raw: "other"
  }));
  assert.deepEqual(head(x), h);
  const results = [ x.store.publish(a), x.store.publish(b) ];
  assert.equal(results.filter(v => v.status === "committed").length, 1);
  assert.equal(results[1].status, "conflict");
  assert.deepEqual(head(x), results[0].receipt.head);
  assert.equal(x.store.readGeneration({
    generationId: "gen-b"
  }).raw, "other");
});

// Replacing durable operation history with only the latest head must break this test.
test("wm_status_survives_later_commit_and_restart", t => {
  const x = fixture(t);
  let h = init(x);
  const first = publish(x, h, {
    operationId: "write-first",
    generationId: "gen-first"
  });
  const firstReceipt = first.result.receipt;
  h = firstReceipt.head;
  assert.equal(publish(x, h, {
    operationId: "write-later",
    generationId: "gen-later",
    raw: "later"
  }).result.status, "committed");
  x.reopen();
  const firstRequest = {
    operationId: first.input.operationId,
    requestFingerprint: first.input.requestFingerprint
  };
  assert.deepEqual(x.store.status(firstRequest).receipt, firstReceipt);
  assert.notDeepEqual(head(x), firstReceipt.head);
  assert.deepEqual(x.store.publish(first.prepared).receipt, firstReceipt);
});

test("wm_scope_initialization_is_explicit_and_atomic", t => {
  const x = fixture(t);
  const before = counts(x);
  assert.throws(() => x.store.readGeneration({
    generationId: "unknown"
  }), /generation_missing/);
  assert.throws(() => x.store.prepare(f.storeWrite(f.head())), /scope_missing/);
  assert.deepEqual(counts(x), before);
  assert.throws(() => x.store.initializeScope(f.signed({
    ...f.initialization(),
    expectedEmpty: false
  })), /initialize_invalid/);
  const a = x.store.initializeScope(f.initialization());
  const b = x.store.initializeScope(f.initialization("scope-a", "initialize-2"));
  assert.equal(a.status, "committed");
  assert.equal(b.status, "conflict");
  assert.equal(a.receipt.head.tombstone, true);
  assert.equal(Object.keys(a.receipt.head).length, 11);
  assert.equal(counts(x).heads, 1);
  assert.deepEqual(x.store.initializeScope(f.initialization()), a);
});

test("wm_same_id_different_payload_is_conflict", t => {
  const x = fixture(t);
  const h = init(x);
  const original = f.storeWrite(h);
  const prepared = x.store.prepare(original);
  const changed = f.storeWrite(h, {
    raw: "different"
  });
  assert.equal(x.store.prepare(changed).status, "conflict");
  assert.equal(x.store.status({
    operationId: original.operationId,
    requestFingerprint: changed.requestFingerprint
  }).status, "conflict");
  const committed = x.store.publish(prepared);
  assert.equal(committed.status, "committed");
  assert.deepEqual(x.store.status({
    operationId: original.operationId,
    requestFingerprint: original.requestFingerprint
  }), committed);
  assert.equal(x.store.initializeScope(f.initialization("scope-other", original.operationId)).status, "conflict");
});

test("wm_epoch_never_reuses_after_restore_or_remove", t => {
  const x = fixture(t);
  let h = init(x);
  const epochs = [ h.epoch ];
  for (const operation of [ "remove", "restore", "reset", "recovery", "migration" ]) {
    const r = publish(x, h, {
      operation: operation,
      operationId: "epoch-" + operation,
      generationId: "gen-" + operation,
      raw: operation === "remove" ? null : "restored"
    }).result;
    assert.equal(r.status, "committed");
    h = r.receipt.head;
    assert.ok(!epochs.includes(h.epoch));
    epochs.push(h.epoch);
    const stale = f.storeWrite(h, {
      operationId: "stale-" + operation,
      generationId: "stale-gen-" + operation,
      writerEpoch: epochs[0]
    });
    assert.throws(() => x.store.prepare(stale), /writer_epoch_conflict/);
  }
  x.reopen();
  assert.equal(head(x).epoch, h.epoch);
  assert.throws(() => api.createWmStore({
    ...x.config,
    identity: {
      ...x.config.identity,
      storeId: "old-backup-store"
    }
  }), /store_identity_mismatch/);
  assert.equal(head(x).epoch, h.epoch);
});

test("wm_corrupt_dependency_never_becomes_healthy", t => {
  const x = fixture(t);
  const h = init(x), d = f.item("cold", "cold-1");
  const inv = f.inventoryWrite({
    items: [ {
      descriptor: d,
      payload: Buffer.from("abc")
    } ]
  });
  assert.equal(x.store.putInventoryItems(inv).status, "committed");
  const input = f.storeWrite(h, {
    items: [ d ]
  });
  const p = x.store.prepare(input);
  f.sqliteMutate(x.databasePath, db => {
    db.exec("DROP TRIGGER blobs_immutable_update");
    db.prepare("UPDATE blobs SET payload=? WHERE sha256=?").run(Buffer.from("BAD"), d.sha256);
  });
  const r = x.store.publish(p);
  assert.equal(r.status, "conflict");
  assert.deepEqual(head(x), h);
  assert.throws(() => x.store.readGeneration({
    generationId: p.head.generationId
  }), /blob_integrity/);
});

test("wm_closure_is_complete_exact_bytes_and_immutable", t => {
  const x = fixture(t);
  const h = init(x), raw = f.item("raw", "raw-a"), cold = f.item("cold", "cold-a", [ "raw-a" ]);
  const input = f.storeWrite(h, {
    items: [ raw, cold ]
  });
  assert.throws(() => x.store.prepare(input), /dependency_missing/);
  const inv = f.inventoryWrite({
    items: [ {
      descriptor: raw,
      payload: Buffer.from("abc")
    }, {
      descriptor: cold,
      payload: new Uint8Array([ 97, 98, 99 ])
    } ]
  });
  assert.equal(x.store.putInventoryItems(inv).status, "committed");
  const p = x.store.prepare(input);
  assert.deepEqual(x.store.readGeneration({
    generationId: p.head.generationId
  }), {
    raw: f.raw,
    manifest: input.manifest
  });
  assert.notEqual(p.rawSha256, input.manifest.manifestDigest);
  f.sqliteMutate(x.databasePath, db => {
    for (const sql of [ "UPDATE blobs SET payload=payload", "DELETE FROM blobs", "UPDATE generations SET manifest_json=manifest_json", "DELETE FROM generations", "DELETE FROM inventory_items", "DELETE FROM generation_items" ]) assert.throws(() => db.exec(sql), /immutable/);
  });
  assert.equal(x.store.publish(p).status, "committed");
});

test("wm_unknown_operation_stays_uncertain_for_thirty_days", t => {
  let now = 0;
  const x = fixture(t, {
    clock: () => now
  });
  init(x);
  const known = f.storeWrite(head(x)), p = x.store.prepare(known);
  const query = {
    operationId: "unknown-id",
    requestFingerprint: "0".repeat(64)
  };
  assert.equal(x.store.status(query).status, "uncertain");
  now = 31 * 864e5;
  x.reopen();
  assert.equal(x.store.status(query).status, "uncertain");
  assert.equal(x.store.status({
    operationId: p.operationId,
    requestFingerprint: p.requestFingerprint
  }).status, "prepared");
  assert.equal(counts(x).operations, 2);
});

test("wm_prepared_dto_cannot_rewrite_stored_intent", t => {
  const x = fixture(t);
  const h = init(x), p = x.store.prepare(f.storeWrite(h));
  assert.equal(x.store.publish({
    ...p,
    rawSha256: "f".repeat(64)
  }).status, "conflict");
  assert.equal(x.store.publish({
    ...p,
    head: {
      ...p.head,
      scope: "foreign"
    }
  }).status, "conflict");
  assert.deepEqual(head(x), h);
  assert.equal(x.store.publish(p).status, "committed");
});

test("wm_inventory_only_write_has_durable_receipt_and_fence", t => {
  const x = fixture(t);
  const d = f.item("orphan", "orphan-a");
  const req = f.inventoryWrite({
    items: [ {
      descriptor: d,
      payload: Buffer.from("abc")
    } ]
  });
  const first = x.store.putInventoryItems(req);
  assert.equal(first.status, "committed");
  assert.equal(counts(x).heads, 0);
  x.reopen();
  assert.deepEqual(x.store.status({
    operationId: req.operationId,
    requestFingerprint: req.requestFingerprint
  }), first);
  assert.deepEqual(x.store.putInventoryItems(req), first);
  const stale = f.inventoryWrite({
    operationId: "inventory-stale",
    items: [],
    expectedInventoryRevision: "inventory-0"
  });
  assert.equal(x.store.putInventoryItems(stale).status, "conflict");
  const fence = x.store.fenceDataset(f.signed({
    operationId: "fence-1",
    expectedRoute: f.storeRoute()
  }));
  assert.equal(fence.status, "committed");
  const after = f.inventoryWrite({
    operationId: "inventory-after",
    expectedInventoryRevision: first.receipt.inventoryRevision,
    items: [ {
      descriptor: f.item("raw", "new-raw"),
      payload: Buffer.from("abc")
    } ]
  });
  assert.equal(x.store.putInventoryItems(after).status, "conflict");
  assert.equal(counts(x).inventory_items, 1);
});

test("wm_inventory_rejects_duplicate_foreign_invalid_bytes_and_private_fields", t => {
  const x = fixture(t);
  for (const make of [ () => [ {
    descriptor: f.item(),
    payload: Buffer.from("BAD")
  } ], () => [ {
    descriptor: f.item(),
    payload: new Uint16Array([ 97 ])
  } ], () => [ {
    descriptor: {
      ...f.item(),
      apiKey: "fake"
    },
    payload: Buffer.from("abc")
  } ], () => [ {
    descriptor: f.item(),
    payload: Buffer.from("abc")
  }, {
    descriptor: f.item(),
    payload: Buffer.from("abc")
  } ], () => [ {
    descriptor: {
      ...f.item("cold"),
      originScope: "foreign"
    },
    payload: Buffer.from("abc")
  } ], () => [ {
    descriptor: {
      ...f.item(),
      dependencies: [ "missing" ]
    },
    payload: Buffer.from("abc")
  } ] ]) {
    const items = make();
    const req = f.inventoryWrite({
      items: items
    });
    assert.throws(() => x.store.putInventoryItems(req), /inventory_|invalid_bytes|dependency_|scope_missing|item_invalid/);
  }
  assert.equal(counts(x).inventory_items, 0);
});

test("wm_plain_input_rejects_accessors_without_invocation", t => {
  const x = fixture(t);
  let calls = 0;
  const input = f.initialization();
  Object.defineProperty(input, "scope", {
    enumerable: true,
    get() {
      calls++;
      return "scope-a";
    }
  });
  assert.throws(() => x.store.initializeScope(input), /non_plain_data/);
  assert.equal(calls, 0);
  const h = init(x);
  const p = x.store.prepare(f.storeWrite(h));
  const forged = {
    ...p
  };
  Object.defineProperty(forged, "head", {
    enumerable: true,
    get() {
      calls++;
      return p.head;
    }
  });
  assert.throws(() => x.store.publish(forged), /non_plain_data/);
  assert.equal(calls, 0);
});

test("wm_fence_is_durable_and_rejects_prepared_stale_writer", t => {
  const x = fixture(t);
  const h = init(x), p = x.store.prepare(f.storeWrite(h));
  const request = f.signed({
    operationId: "fence-1",
    expectedRoute: f.storeRoute()
  });
  const fenced = x.store.fenceDataset(request);
  assert.equal(fenced.status, "committed");
  assert.equal(readRoute(x).state, "fenced");
  assert.equal(x.store.publish(p).status, "conflict");
  assert.deepEqual(head(x), h);
  x.reopen();
  assert.deepEqual(x.store.status({
    operationId: request.operationId,
    requestFingerprint: request.requestFingerprint
  }), fenced);
  assert.deepEqual(x.store.fenceDataset(request), fenced);
});

test("wm_activate_rejects_json_boolean_or_unverified_source_fence", t => {
  const x = fixture(t);
  init(x);
  const fence = x.store.fenceDataset(f.signed({
    operationId: "fence-1",
    expectedRoute: f.storeRoute()
  }));
  const target = {
    ...f.storeRoute(),
    routeGeneration: "route-2"
  };
  for (const sourceFenceReceipt of [ {
    fenced: true
  }, fence.receipt, {
    ...fence.receipt,
    writerEpoch: "old-epoch"
  } ]) {
    const req = f.signed({
      operationId: "activate-" + Object.keys(sourceFenceReceipt).length,
      expectedRoute: readRoute(x),
      targetRoute: target,
      sealedInventoryDigest: "0".repeat(64),
      sourceFenceReceipt: sourceFenceReceipt
    });
    assert.equal(x.store.activateDataset(req).status, "conflict");
  }
  assert.equal(readRoute(x).state, "fenced");
});

test("wm_limits_are_explicit_and_canonical_is_not_fixed_to_four_mib", t => {
  const x = fixture(t, {
    limits: {
      maxCanonicalBytes: 6 * 1024 * 1024,
      maxInventoryBatchBytes: 1024,
      maxInventoryBatchItems: 3
    }
  });
  const h = init(x), raw = "x".repeat(4 * 1024 * 1024 + 1);
  const p = x.store.prepare(f.storeWrite(h, {
    raw: raw
  }));
  assert.equal(x.store.publish(p).status, "committed");
  assert.equal(x.store.readGeneration({
    generationId: p.head.generationId
  }).raw.length, raw.length);
  const y = fixture(t, {
    limits: {
      maxCanonicalBytes: 10
    }
  });
  assert.throws(() => y.store.prepare(f.storeWrite(init(y))), /canonical_limit/);
  assert.equal(counts(y).generations, 1);
});

test("wm_schema_is_wal_full_foreign_keys_and_has_all_a2_tables", t => {
  const x = fixture(t);
  const tables = f.sqliteRead(x.databasePath, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
  for (const name of [ "metadata", "blobs", "inventory_items", "generations", "generation_items", "heads", "operations", "dataset_route", "pins", "inventory_snapshots" ]) assert.ok(tables.includes(name), name);
  assert.equal(f.sqliteRead(x.databasePath, "PRAGMA journal_mode")[0].journal_mode, "wal");
  assert.equal(f.sqliteRead(x.databasePath, "PRAGMA integrity_check")[0].integrity_check, "ok");
});

for (const method of [ "prepare", "publish" ]) for (const phase of [ "before", "after" ]) for (const kind of [ "crash", "disk_full" ]) test(`wm_${method}_${phase}_commit_${kind}_is_atomic`, t => {
  const x = fixture(t);
  const h = init(x), input = f.storeWrite(h);
  let p;
  if (method === "publish") p = x.store.prepare(input);
  let caught;
  const injected = f.faultSqlite({
    sqlPattern: /^COMMIT$/,
    phase: phase,
    kind: kind
  }, () => {
    try {
      return method === "prepare" ? x.store.prepare(input) : x.store.publish(p);
    } catch (e) {
      caught = e;
    }
  });
  assert.equal(injected.hit, true);
  if (method === "prepare") assert.match(caught.message, /storage_uncertain/); else assert.equal(injected.result.status, "uncertain");
  x.reopen();
  const status = x.store.status({
    operationId: input.operationId,
    requestFingerprint: input.requestFingerprint
  });
  if (phase === "after") {
    assert.equal(status.status, method === "prepare" ? "prepared" : "committed");
    if (method === "publish") assert.deepEqual(head(x), status.receipt.head); else assert.deepEqual(head(x), h);
  } else {
    assert.equal(status.status, method === "prepare" ? "uncertain" : "prepared");
    assert.deepEqual(head(x), h);
  }
  assert.equal(f.sqliteRead(x.databasePath, "PRAGMA integrity_check")[0].integrity_check, "ok");
  assert.equal(counts(x).heads, 1);
});

test("wm_real_sqlite_full_rolls_back_staging_without_half_head", t => {
  const x = fixture(t);
  const h = init(x);
  const req = f.storeWrite(h, {
    raw: "q".repeat(1024 * 1024)
  });
  const limit = f.limitSqlitePages(() => assert.throws(() => x.store.prepare(req), e => e.message === "storage_uncertain" && e.storageCode === 13));
  assert.ok(limit.pages > 0);
  x.reopen();
  assert.deepEqual(head(x), h);
  assert.equal(x.store.status({
    operationId: req.operationId,
    requestFingerprint: req.requestFingerprint
  }).status, "uncertain");
  assert.equal(counts(x).generations, 1);
});

test("wm_local_verified_activation_is_atomic_rotates_route_and_epoch", t => {
  const x = fixture(t);
  const h = init(x);
  const fenceInput = f.signed({
    operationId: "fence-activate",
    expectedRoute: f.storeRoute()
  });
  const fenced = x.store.fenceDataset(fenceInput);
  const targetRoute = {
    ...f.storeRoute(),
    routeGeneration: "route-2"
  };
  const req = f.signed({
    operationId: "activate-good",
    expectedRoute: readRoute(x),
    targetRoute: targetRoute,
    sealedInventoryDigest: fenced.receipt.inventoryDigest,
    sourceFenceReceipt: fenced.receipt
  });
  const result = x.store.activateDataset(req);
  assert.equal(result.status, "committed");
  assert.deepEqual(readRoute(x), targetRoute);
  assert.notEqual(result.receipt.writerEpoch, fenced.receipt.writerEpoch);
  assert.throws(() => x.store.prepare(f.storeWrite(h, {
    operationId: "old-writer",
    generationId: "old-writer-gen"
  })), /route_generation_conflict/);
  const current = f.storeWrite(h, {
    operationId: "current-writer",
    generationId: "current-writer-gen",
    writerEpoch: result.receipt.writerEpoch,
    routeGeneration: "route-2"
  });
  assert.equal(x.store.publish(x.store.prepare(current)).status, "committed");
  x.reopen();
  assert.deepEqual(x.store.status({
    operationId: req.operationId,
    requestFingerprint: req.requestFingerprint
  }), result);
  assert.deepEqual(x.store.activateDataset(req), result);
});

test("wm_external_fence_verifier_requires_typed_bound_proof", t => {
  let calls = 0;
  const x = fixture(t, {
    verifySourceFenceReceipt: (receipt, context) => {
      calls++;
      return true;
    }
  });
  init(x);
  const fenced = x.store.fenceDataset(f.signed({
    operationId: "local-fence",
    expectedRoute: f.storeRoute()
  }));
  const request = f.signed({
    operationId: "foreign-activate",
    expectedRoute: readRoute(x),
    targetRoute: {
      ...f.storeRoute(),
      routeGeneration: "route-2"
    },
    sealedInventoryDigest: fenced.receipt.inventoryDigest,
    sourceFenceReceipt: {
      schema: "wm.dataset-fence-receipt.v1",
      operationId: "foreign-fence",
      requestFingerprint: "1".repeat(64),
      identity: {
        authorityId: "other-authority",
        storeId: "other-store",
        datasetId: "dataset-a",
        backendId: "other-server"
      },
      sourceRoute: {
        ...f.storeRoute(),
        backendId: "other-server"
      },
      route: {
        ...f.storeRoute(),
        backendId: "other-server",
        state: "fenced"
      },
      writerEpoch: "foreign-epoch",
      inventoryRevision: "foreign-inventory",
      inventoryDigest: fenced.receipt.inventoryDigest
    }
  });
  assert.equal(x.store.activateDataset(request).status, "conflict");
  assert.equal(calls, 1);
  assert.equal(readRoute(x).state, "fenced");
});

test("wm_verifier_malformed_proof_never_invokes_getters", t => {
  let calls = 0;
  const x = fixture(t, {
    verifySourceFenceReceipt: () => Object.defineProperty({}, "ok", {
      enumerable: true,
      get() {
        calls++;
        return true;
      }
    })
  });
  init(x);
  const fenced = x.store.fenceDataset(f.signed({
    operationId: "local-fence-proof",
    expectedRoute: f.storeRoute()
  }));
  const receipt = {
    schema: "wm.dataset-fence-receipt.v1",
    operationId: "foreign-fence",
    requestFingerprint: "1".repeat(64),
    identity: {
      authorityId: "other-authority",
      storeId: "other-store",
      datasetId: "dataset-a",
      backendId: "other-server"
    },
    sourceRoute: {
      ...f.storeRoute(),
      backendId: "other-server"
    },
    route: {
      ...f.storeRoute(),
      backendId: "other-server",
      state: "fenced"
    },
    writerEpoch: "foreign-epoch",
    inventoryRevision: "foreign-inventory",
    inventoryDigest: fenced.receipt.inventoryDigest
  };
  const req = f.signed({
    operationId: "activate-proof-accessor",
    expectedRoute: readRoute(x),
    targetRoute: {
      ...f.storeRoute(),
      routeGeneration: "route-2"
    },
    sealedInventoryDigest: fenced.receipt.inventoryDigest,
    sourceFenceReceipt: receipt
  });
  assert.equal(x.store.activateDataset(req).status, "conflict");
  assert.equal(calls, 0);
});

test("wm_store_two_connections_share_expected_head_cas", t => {
  const x = fixture(t);
  const other = api.createWmStore(x.config);
  t.after(() => other.close());
  const h = init(x), a = x.store.prepare(f.storeWrite(h, {
    operationId: "conn-a",
    generationId: "conn-gen-a"
  })), b = other.prepare(f.storeWrite(h, {
    operationId: "conn-b",
    generationId: "conn-gen-b"
  }));
  const winner = other.publish(b), loser = x.store.publish(a);
  assert.equal(winner.status, "committed");
  assert.equal(loser.status, "conflict");
  assert.deepEqual(head(x), winner.receipt.head);
  assert.deepEqual(x.store.status({
    operationId: b.operationId,
    requestFingerprint: b.requestFingerprint
  }), winner);
});

test("wm_corrupt_receipt_is_uncertain_and_never_not_applied", t => {
  const x = fixture(t);
  const h = init(x), first = publish(x, h);
  f.sqliteMutate(x.databasePath, db => {
    db.exec("DROP TRIGGER operations_terminal_immutable");
    db.prepare("UPDATE operations SET response_json=? WHERE operation_id=?").run("{}", first.input.operationId);
  });
  const query = {
    operationId: first.input.operationId,
    requestFingerprint: first.input.requestFingerprint
  };
  assert.equal(x.store.status(query).status, "uncertain");
  x.reopen();
  assert.equal(x.store.status(query).status, "uncertain");
  assert.deepEqual(head(x), first.result.receipt.head);
});

test("wm_inventory_payload_intrinsics_ignore_shadow_metadata", t => {
  const x = fixture(t), payload = new Uint8Array([ 97, 98, 99 ]), d = f.item();
  const input = f.inventoryWrite({
    items: [ {
      descriptor: d,
      payload: payload
    } ]
  });
  let calls = 0;
  for (const key of [ "length", "byteLength", "byteOffset", "buffer", Symbol.toStringTag ]) Object.defineProperty(payload, key, {
    get() {
      calls++;
      throw Error("untrusted");
    }
  });
  assert.equal(x.store.putInventoryItems(input).status, "committed");
  assert.equal(calls, 0);
  assert.throws(() => x.store.putInventoryItems({
    ...input,
    items: [ {
      descriptor: d,
      payload: new Proxy(new Uint8Array([ 97, 98, 99 ]), {})
    } ]
  }), /invalid_bytes/);
});

// Corruption and missing dependencies are fail-closed even when test-only SQL bypasses triggers.
test("wm_missing_dependency_never_publishes_or_reads_healthy", t => {
  const x = fixture(t), h = init(x), d = f.item("raw", "missing-after-stage");
  assert.equal(x.store.putInventoryItems(f.inventoryWrite({
    items: [ {
      descriptor: d,
      payload: Buffer.from("abc")
    } ]
  })).status, "committed");
  const p = x.store.prepare(f.storeWrite(h, {
    items: [ d ]
  }));
  f.sqliteMutate(x.databasePath, db => {
    db.exec("PRAGMA foreign_keys=OFF; DROP TRIGGER blobs_immutable_delete");
    db.prepare("DELETE FROM blobs WHERE sha256=?").run(d.sha256);
  });
  assert.equal(x.store.publish(p).status, "conflict");
  assert.deepEqual(head(x), h);
  assert.throws(() => x.store.readGeneration({
    generationId: p.head.generationId
  }), /blob_integrity/);
});

for (const method of [ "initializeScope", "putInventoryItems", "fenceDataset", "activateDataset" ]) for (const phase of [ "before", "after" ]) test(`wm_${method}_${phase}_commit_response_loss_is_atomic`, t => {
  const x = fixture(t);
  let input, before;
  switch (method) {
   case "initializeScope":
    input = f.initialization();
    break;

   case "putInventoryItems":
    input = f.inventoryWrite({
      items: [ {
        descriptor: f.item(),
        payload: Buffer.from("abc")
      } ]
    });
    break;

   case "fenceDataset":
    init(x);
    input = f.signed({
      operationId: "fence-loss",
      expectedRoute: f.storeRoute()
    });
    break;

   case "activateDataset":
    init(x);
    {
      const fenced = x.store.fenceDataset(f.signed({
        operationId: "fence-before-activate",
        expectedRoute: f.storeRoute()
      }));
      input = f.signed({
        operationId: "activate-loss",
        expectedRoute: readRoute(x),
        targetRoute: {
          ...f.storeRoute(),
          routeGeneration: "route-2"
        },
        sealedInventoryDigest: fenced.receipt.inventoryDigest,
        sourceFenceReceipt: fenced.receipt
      });
    }
    break;
  }
  before = {
    counts: counts(x),
    route: readRoute(x)
  };
  const injected = f.faultSqlite({
    sqlPattern: /^COMMIT$/,
    phase: phase,
    kind: "crash"
  }, () => x.store[method](input));
  assert.equal(injected.hit, true);
  assert.equal(injected.result.status, "uncertain");
  x.reopen();
  const status = x.store.status({
    operationId: input.operationId,
    requestFingerprint: input.requestFingerprint
  });
  assert.equal(status.status, phase === "after" ? "committed" : "uncertain");
  if (phase === "before") {
    assert.deepEqual(counts(x), before.counts);
    assert.deepEqual(readRoute(x), before.route);
  } else {
    assert.deepEqual(x.store[method](input), status);
    if (method === "initializeScope") assert.equal(counts(x).heads, 1);
    if (method === "putInventoryItems") assert.equal(counts(x).inventory_items, 1);
    if (method === "fenceDataset") assert.equal(readRoute(x).state, "fenced");
    if (method === "activateDataset") assert.equal(readRoute(x).routeGeneration, "route-2");
  }
});

test("wm_head_identity_must_match_its_generation", t => {
  const x = fixture(t), h = init(x);
  const changed = {
    ...h,
    revision: "forged-revision"
  };
  f.sqliteMutate(x.databasePath, db => {
    const json = f.stable(changed);
    db.prepare("UPDATE heads SET head_json=?,head_sha256=? WHERE scope=?").run(json, f.sha(Buffer.from(json)), h.scope);
  });
  assert.throws(() => x.store.prepare(f.storeWrite(changed)), /head_generation_integrity/);
  assert.throws(() => x.store.fenceDataset(f.signed({
    operationId: "fence-forged-head",
    expectedRoute: f.storeRoute()
  })), /head_generation_integrity/);
  assert.equal(counts(x).generations, 1);
});

test("wm_generation_rows_must_match_stored_write_and_prepared_intent", t => {
  const x = fixture(t), h = init(x), p = x.store.prepare(f.storeWrite(h));
  f.sqliteMutate(x.databasePath, db => {
    db.exec("DROP TRIGGER generations_immutable_update");
    const row = db.prepare("SELECT prepared_json FROM generations WHERE generation_id=?").get(p.head.generationId);
    const forged = JSON.parse(row.prepared_json);
    forged.head.tombstone = true;
    const json = f.stable(forged);
    db.prepare("UPDATE generations SET prepared_json=?,prepared_sha256=? WHERE generation_id=?").run(json, f.sha(Buffer.from(json)), p.head.generationId);
  });
  assert.throws(() => x.store.readGeneration({
    generationId: p.head.generationId
  }), /generation_integrity/);
  assert.equal(x.store.publish(p).status, "conflict");
  assert.deepEqual(head(x), h);
});

for (const method of [ "prepare", "publish" ]) for (const kind of [ "crash", "disk_full" ]) test(`wm_${method}_before_transaction_${kind}_has_no_partial_state`, t => {
  const x = fixture(t), h = init(x), input = f.storeWrite(h);
  let p;
  if (method === "publish") p = x.store.prepare(input);
  const before = counts(x);
  let caught;
  const injected = f.faultSqlite({
    sqlPattern: /^BEGIN IMMEDIATE$/,
    phase: "before",
    kind: kind
  }, () => {
    try {
      return method === "prepare" ? x.store.prepare(input) : x.store.publish(p);
    } catch (e) {
      caught = e;
    }
  });
  assert.equal(injected.hit, true);
  if (method === "prepare") assert.match(caught.message, /storage_uncertain/); else assert.equal(injected.result.status, "uncertain");
  x.reopen();
  assert.deepEqual(counts(x), before);
  assert.deepEqual(head(x), h);
  assert.equal(x.store.status({
    operationId: input.operationId,
    requestFingerprint: input.requestFingerprint
  }).status, method === "prepare" ? "uncertain" : "prepared");
});

test("wm_external_typed_source_fence_proof_can_activate_only_bound_inventory", t => {
  let calls = 0;
  const x = fixture(t, {
    verifySourceFenceReceipt: (receipt, context) => {
      calls++;
      assert.equal(context.sealedInventoryDigest, receipt.inventoryDigest);
      return {
        ok: true,
        sourceIdentity: receipt.identity,
        sourceRoute: receipt.route,
        operationId: receipt.operationId,
        requestFingerprint: receipt.requestFingerprint,
        writerEpoch: receipt.writerEpoch,
        inventoryDigest: receipt.inventoryDigest
      };
    }
  });
  init(x);
  const fenced = x.store.fenceDataset(f.signed({
    operationId: "external-target-fence",
    expectedRoute: f.storeRoute()
  }));
  const sourceFenceReceipt = {
    schema: "wm.dataset-fence-receipt.v1",
    operationId: "source-fence",
    requestFingerprint: "2".repeat(64),
    identity: {
      authorityId: "source-authority",
      storeId: "source-store",
      datasetId: "dataset-a",
      backendId: "source-backend"
    },
    sourceRoute: {
      ...f.storeRoute(),
      backendId: "source-backend"
    },
    route: {
      ...f.storeRoute(),
      backendId: "source-backend",
      state: "fenced"
    },
    writerEpoch: "source-epoch",
    inventoryRevision: "source-inventory",
    inventoryDigest: fenced.receipt.inventoryDigest
  };
  const input = f.signed({
    operationId: "external-activate",
    expectedRoute: readRoute(x),
    targetRoute: {
      ...f.storeRoute(),
      routeGeneration: "route-2"
    },
    sealedInventoryDigest: fenced.receipt.inventoryDigest,
    sourceFenceReceipt: sourceFenceReceipt
  });
  assert.equal(x.store.activateDataset(input).status, "committed");
  assert.equal(calls, 1);
  assert.equal(readRoute(x).routeGeneration, "route-2");
});

test("wm_store_connection_uses_full_durability_and_foreign_keys", t => {
  const observed = f.inspectSqlitePragmas(() => fixture(t));
  assert.deepEqual(observed.pragmas, {
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1
  });
});

test("wm_unknown_fence_schema_cannot_reach_trusted_verifier", t => {
  let calls = 0;
  const x = fixture(t, {
    verifySourceFenceReceipt: receipt => {
      calls++;
      return {
        ok: true,
        sourceIdentity: receipt.identity,
        sourceRoute: receipt.route,
        operationId: receipt.operationId,
        requestFingerprint: receipt.requestFingerprint,
        writerEpoch: receipt.writerEpoch,
        inventoryDigest: receipt.inventoryDigest
      };
    }
  });
  init(x);
  const fenced = x.store.fenceDataset(f.signed({
    operationId: "unknown-schema-target-fence",
    expectedRoute: f.storeRoute()
  }));
  const sourceFenceReceipt = {
    ...fenced.receipt,
    schema: "wm.dataset-fence-receipt.v99",
    identity: {
      ...fenced.receipt.identity,
      storeId: "foreign-store"
    }
  };
  const request = f.signed({
    operationId: "activate-unknown-fence-schema",
    expectedRoute: readRoute(x),
    targetRoute: {
      ...f.storeRoute(),
      routeGeneration: "route-2"
    },
    sealedInventoryDigest: fenced.receipt.inventoryDigest,
    sourceFenceReceipt: sourceFenceReceipt
  });
  assert.equal(x.store.activateDataset(request).status, "conflict");
  assert.equal(calls, 0);
  assert.equal(readRoute(x).state, "fenced");
});

test("wm_initialization_does_not_recreate_a_lost_known_scope", t => {
  const x = fixture(t);
  init(x);
  f.sqliteMutate(x.databasePath, db => db.exec("DELETE FROM heads"));
  const result = x.store.initializeScope(f.initialization("scope-a", "reinitialize-lost-scope"));
  assert.equal(result.status, "conflict");
  assert.equal(result.receipt.reason, "scope_not_empty");
  assert.equal(counts(x).heads, 0);
  assert.equal(counts(x).generations, 1);
});

test("wm_foreign_database_schema_is_rejected_without_wm_tables", t => {
  const x = fixture(t);
  const foreignPath = path.join(path.dirname(x.databasePath), "foreign-owner.sqlite");
  f.sqliteMutate(foreignPath, db => {
    db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)");
    db.prepare("INSERT INTO kv VALUES (?,?)").run("protected", "synthetic-core-data");
  });
  assert.throws(() => api.createWmStore({
    ...x.config,
    databasePath: foreignPath
  }), /store_foreign_schema/);
  assert.deepEqual(f.sqliteRead(foreignPath, "SELECT * FROM kv").map(r => ({
    ...r
  })), [ {
    key: "protected",
    value: "synthetic-core-data"
  } ]);
  assert.deepEqual(f.sqliteRead(foreignPath, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name), [ "kv" ]);
});

test("wm_inventory_rejects_hidden_array_entries", t => {
  const x = fixture(t);
  const request = f.inventoryWrite({
    items: [ {
      descriptor: f.item(),
      payload: Buffer.from("abc")
    } ]
  });
  Object.defineProperty(request.items, "0", {
    enumerable: false
  });
  assert.throws(() => x.store.putInventoryItems(request), /non_plain_data/);
  assert.equal(counts(x).inventory_items, 0);
});

// A2 review F1: neither the independently negotiated total nor exact boundary may be bypassed.
test("wm_F1_canonical_only_obeys_smaller_total_generation_limit", t => {
  for (const limits of [ {
    maxCanonicalBytes: 1024,
    maxGenerationBytes: 8
  }, {
    maxGenerationBytes: 8
  } ]) {
    const x = fixture(t, {
      limits: limits
    }), h = init(x), before = counts(x);
    const excessive = f.storeWrite(h, {
      operationId: "F1-over",
      generationId: "F1-gen-over",
      raw: "123456789"
    });
    assert.throws(() => x.store.prepare(excessive), /generation_limit/);
    assert.deepEqual(head(x), h);
    assert.deepEqual(counts(x), before);
    assert.equal(x.store.status({
      operationId: excessive.operationId,
      requestFingerprint: excessive.requestFingerprint
    }).status, "uncertain");
    const exact = f.storeWrite(h, {
      operationId: "F1-exact",
      generationId: "F1-gen-exact",
      raw: "12345678"
    }), p = x.store.prepare(exact), committed = x.store.publish(p);
    assert.equal(committed.status, "committed");
    assert.equal(x.store.readGeneration({
      generationId: p.head.generationId
    }).raw, "12345678");
  }
});

test("wm_F1_generation_total_includes_companion_bytes_at_exact_boundary", t => {
  const x = fixture(t, {
    limits: {
      maxCanonicalBytes: 1024,
      maxGenerationBytes: 8
    }
  }), h = init(x), item = f.item("raw", "F1-raw");
  assert.equal(x.store.putInventoryItems(f.inventoryWrite({
    items: [ {
      descriptor: item,
      payload: Buffer.from("abc")
    } ]
  })).status, "committed");
  const before = counts(x), over = f.storeWrite(h, {
    operationId: "F1-companion-over",
    generationId: "F1-companion-gen-over",
    raw: "123456",
    items: [ item ]
  });
  assert.throws(() => x.store.prepare(over), /generation_limit/);
  assert.deepEqual(head(x), h);
  assert.deepEqual(counts(x), before);
  const exact = f.storeWrite(h, {
    operationId: "F1-companion-exact",
    generationId: "F1-companion-gen-exact",
    raw: "12345",
    items: [ item ]
  }), p = x.store.prepare(exact);
  assert.equal(x.store.publish(p).status, "committed");
  assert.equal(x.store.readGeneration({
    generationId: p.head.generationId
  }).raw, "12345");
});

// A2 review F2: corruption of A must never select B as a durable mutation target.
test("wm_F2_corrupted_generation_input_cannot_terminalize_other_operation", t => {
  const x = fixture(t), h = init(x), a = x.store.prepare(f.storeWrite(h, {
    operationId: "F2-A",
    generationId: "F2-gen-A",
    raw: "alpha"
  })), b = x.store.prepare(f.storeWrite(h, {
    operationId: "F2-B",
    generationId: "F2-gen-B",
    raw: "bravo"
  }));
  const beforeB = x.store.status({
    operationId: b.operationId,
    requestFingerprint: b.requestFingerprint
  }), beforeBRow = f.sqliteRead(x.databasePath, "SELECT * FROM operations WHERE operation_id=?", b.operationId);
  f.sqliteMutate(x.databasePath, db => {
    db.exec("DROP TRIGGER generations_immutable_update");
    const other = db.prepare("SELECT input_json FROM generations WHERE generation_id=?").get(b.head.generationId);
    db.prepare("UPDATE generations SET input_json=? WHERE generation_id=?").run(other.input_json, a.head.generationId);
  });
  const result = x.store.publish(a);
  assert.equal(result.operationId, a.operationId);
  assert.equal(result.requestFingerprint, a.requestFingerprint);
  assert.notEqual(result.status, "committed");
  assert.deepEqual(head(x), h);
  assert.deepEqual(x.store.status({
    operationId: b.operationId,
    requestFingerprint: b.requestFingerprint
  }), beforeB);
  assert.deepEqual(f.sqliteRead(x.databasePath, "SELECT * FROM operations WHERE operation_id=?", b.operationId), beforeBRow);
  assert.throws(() => x.store.readGeneration({
    generationId: a.head.generationId
  }), /generation_integrity/);
  assert.equal(x.store.publish(b).status, "committed");
  x.reopen();
  assert.equal(x.store.status({
    operationId: b.operationId,
    requestFingerprint: b.requestFingerprint
  }).status, "committed");
  assert.notEqual(x.store.status({
    operationId: a.operationId,
    requestFingerprint: a.requestFingerprint
  }).status, "committed");
});

test("wm_F2_rehashed_foreign_or_malformed_intent_cannot_target_unrelated_history", t => {
  for (const corruption of [ "foreign-rehashed", "malformed-json" ]) {
    const x = fixture(t), h = init(x), a = x.store.prepare(f.storeWrite(h, {
      operationId: "F2-rehashed-A",
      generationId: "F2-rehashed-gen-A",
      raw: "alpha"
    })), b = x.store.prepare(f.storeWrite(h, {
      operationId: "F2-rehashed-B",
      generationId: "F2-rehashed-gen-B",
      raw: "bravo"
    }));
    const before = counts(x), beforeB = x.store.status({
      operationId: b.operationId,
      requestFingerprint: b.requestFingerprint
    }), beforeBRow = f.sqliteRead(x.databasePath, "SELECT * FROM operations WHERE operation_id=?", b.operationId);
    f.sqliteMutate(x.databasePath, db => {
      db.exec("DROP TRIGGER generations_immutable_update");
      const other = db.prepare("SELECT input_json FROM generations WHERE generation_id=?").get(b.head.generationId);
      const json = corruption === "foreign-rehashed" ? other.input_json : "{malformed";
      db.prepare("UPDATE generations SET input_json=?,input_sha256=? WHERE generation_id=?").run(json, f.sha(Buffer.from(json)), a.head.generationId);
    });
    const result = x.store.publish(a);
    assert.equal(result.operationId, a.operationId);
    assert.equal(result.requestFingerprint, a.requestFingerprint);
    assert.notEqual(result.status, "committed");
    assert.deepEqual(head(x), h);
    assert.deepEqual(x.store.status({
      operationId: b.operationId,
      requestFingerprint: b.requestFingerprint
    }), beforeB);
    assert.deepEqual(f.sqliteRead(x.databasePath, "SELECT * FROM operations WHERE operation_id=?", b.operationId), beforeBRow);
    assert.equal(counts(x).operations, before.operations);
    assert.equal(x.store.publish(b).status, "committed");
  }
});

test("wm_F1_lower_reopened_generation_ceiling_guards_publish_and_read", t => {
  const x = fixture(t, {
    limits: {
      maxCanonicalBytes: 1024,
      maxGenerationBytes: 1024
    }
  }), h = init(x), large = x.store.prepare(f.storeWrite(h, {
    operationId: "F1-prior-stage",
    generationId: "F1-prior-gen",
    raw: "123456789"
  })), exact = x.store.prepare(f.storeWrite(h, {
    operationId: "F1-lower-exact",
    generationId: "F1-lower-exact-gen",
    raw: "12345678"
  }));
  x.config.limits = {
    maxCanonicalBytes: 1024,
    maxGenerationBytes: 8
  };
  x.reopen();
  assert.throws(() => x.store.readGeneration({
    generationId: large.head.generationId
  }), /generation_limit/);
  const result = x.store.publish(large);
  assert.equal(result.status, "conflict");
  assert.equal(result.operationId, large.operationId);
  assert.deepEqual(head(x), h);
  assert.equal(x.store.publish(exact).status, "committed");
  assert.equal(x.store.readGeneration({
    generationId: exact.head.generationId
  }).raw, "12345678");
});
