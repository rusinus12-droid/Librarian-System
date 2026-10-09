"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const {DatabaseSync: DatabaseSync} = require("node:sqlite");

const f = require("./helpers/wm-fixture.cjs"), {createWmStore: createWmStore} = f.loadStore();

const pinsPath = path.resolve(__dirname, "../server/wm/pins.cjs");

const api = fs.existsSync(pinsPath) ? require(pinsPath) : {};

function fixture(t, options = {}) {
  assert.equal(typeof api.createWmPins, "function", "A3 required API missing: createWmPins");
  const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wm-a3-synthetic-")), "wm.sqlite");
  let time = 100;
  const clock = () => time;
  const config = {
    databasePath: databasePath,
    identity: f.storeIdentity(),
    clock: clock,
    ...options.storeOptions
  };
  const store = createWmStore(config), pins = api.createWmPins({
    store: store,
    clock: clock,
    bootId: "boot-a",
    ...options.pinOptions
  });
  t.after(() => store.close());
  return {
    databasePath: databasePath,
    store: store,
    pins: pins,
    clock: clock,
    config: config,
    setTime: n => time = n
  };
}

const initialize = (x, scope = "scope-a") => x.store.initializeScope(f.initialization(scope, "initialize-" + scope)).receipt.head;

const publish = (x, h, opts = {}) => x.store.publish(x.store.prepare(f.storeWrite(h, opts))).receipt.head;

function put(x, rows, revision = "inventory-0", id = "inventory-1") {
  const r = x.store.putInventoryItems(f.inventoryWrite({
    items: rows,
    expectedInventoryRevision: revision,
    operationId: id
  }));
  assert.equal(r.status, "committed");
  return r.receipt.inventoryRevision;
}

function row(domain, id, payload = "abc", dependencies = []) {
  const b = Buffer.from(payload);
  return {
    descriptor: {
      ...f.item(domain, id, dependencies),
      bytes: b.length,
      sha256: f.sha(b)
    },
    payload: b
  };
}

const rejected = (work, pattern) => assert.throws(work, e => e.code?.startsWith("WM_") && (!pattern || pattern.test(e.code)));

function chunks(read, id, total, maxBytes = 2) {
  let offset = 0, parts = [], hash;
  do {
    const c = read(id, offset, maxBytes);
    assert.equal(c.offset, offset);
    assert.equal(c.totalBytes, total);
    assert.ok(c.bytes.length <= maxBytes);
    hash ??= c.sha256;
    assert.equal(c.sha256, hash);
    parts.push(Buffer.from(c.bytes));
    const previous = offset;
    offset = c.nextOffset;
    assert.ok(offset === null || offset > previous);
  } while (offset !== null);
  const bytes = Buffer.concat(parts);
  assert.equal(f.sha(bytes), hash);
  return bytes;
}

test("wm_pin_retains_entire_dependency_closure", t => {
  const x = fixture(t), h = initialize(x), raw = row("raw", "raw-original", "원문🌍"), cold = row("cold", "cold-original", "cold\r\n원본", [ "raw-original" ]);
  put(x, [ raw, cold ]);
  const old = publish(x, h, {
    items: [ raw.descriptor, cold.descriptor ],
    raw: "canonical\r\n🌍"
  });
  const p = x.pins.acquire("scope-a");
  assert.deepEqual(p.head, old);
  publish(x, old, {
    operationId: "replace",
    generationId: "replacement",
    raw: "new"
  });
  assert.equal(x.pins.readGeneration(p.lease), "canonical\r\n🌍");
  const pinnedColdBytes = chunks((id, offset, maxBytes) => x.pins.readCompanion({
    lease: p.lease,
    logicalId: id,
    offset: offset,
    maxBytes: maxBytes
  }), "cold-original", cold.payload.length);
  assert.deepEqual(pinnedColdBytes, cold.payload);
  assert.deepEqual(chunks((id, offset, maxBytes) => x.pins.readCompanion({
    lease: p.lease,
    logicalId: id,
    offset: offset,
    maxBytes: maxBytes
  }), "raw-original", raw.payload.length), raw.payload);
  assert.equal(x.pins.head("scope-a", p.lease).leaseValid, true);
  assert.equal(x.pins.head("scope-a", p.lease).head.generationId, "replacement");
  x.pins.release(p.lease);
  rejected(() => x.pins.readGeneration(p.lease));
});

test("wm_expired_or_previous_boot_lease_is_rejected", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        pinTtlMs: 10
      }
    }
  });
  initialize(x);
  const p = x.pins.acquire("scope-a");
  x.setTime(110);
  let expiredRead;
  try {
    x.pins.readGeneration(p.lease);
    expiredRead = {
      ok: true
    };
  } catch {
    expiredRead = {
      ok: false
    };
  }
  assert.equal(expiredRead.ok, false);
  rejected(() => x.pins.head("scope-a", p.lease));
  rejected(() => x.pins.observeHeads([ "scope-a" ], {
    leases: [ p.lease ]
  }));
  rejected(() => x.pins.release(p.lease));
  rejected(() => x.pins.release(p.lease));
  x.setTime(111);
  const fresh = x.pins.acquire("scope-a");
  const reboot = api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-b"
  });
  rejected(() => reboot.readGeneration(fresh.lease));
  rejected(() => x.pins.head("scope-a", fresh.lease));
  rejected(() => reboot.release(fresh.lease));
});

test("wm_multi_head_observation_is_one_transaction", t => {
  const x = fixture(t), a = initialize(x), b = initialize(x, "scope-b");
  const staged = x.store.prepare(f.storeWrite(b, {
    operationId: "scope-b-new",
    generationId: "scope-b-new",
    raw: "new-b"
  }));
  const other = new DatabaseSync(x.databasePath);
  other.exec("PRAGMA busy_timeout=0");
  t.after(() => other.close());
  const original = DatabaseSync.prototype.prepare;
  let attempted = false, blocked = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const s = original.call(this, sql);
    if (sql === "SELECT * FROM heads WHERE scope=?") {
      const get = s.get.bind(s);
      s.get = (...args) => {
        const result = get(...args);
        if (args[0] === "scope-a" && !attempted) {
          attempted = true;
          try {
            other.prepare("UPDATE heads SET generation_id=?,head_json=?,head_sha256=? WHERE scope=?").run(staged.head.generationId, f.stable(staged.head), f.sha(Buffer.from(f.stable(staged.head))), "scope-b");
          } catch (e) {
            blocked = /locked|busy/.test(e.message);
          }
        }
        return result;
      };
    }
    return s;
  };
  let observed;
  try {
    observed = x.pins.observeHeads([ "scope-a", "scope-b" ]);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  assert.equal(attempted, true);
  assert.equal(blocked, true);
  const mixedObservationAccepted = observed[0].generationId === a.generationId && observed[1].generationId === staged.head.generationId;
  assert.equal(mixedObservationAccepted, false);
  assert.deepEqual(observed, [ a, b ]);
  const before = f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM heads")[0].n;
  rejected(() => x.pins.observeHeads([ "unknown" ]));
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM heads")[0].n, before);
});

test("wm_inventory_cursor_cannot_cross_snapshot", t => {
  const x = fixture(t);
  initialize(x);
  put(x, [ row("raw", "raw-unlinked"), row("orphan", "orphan-unlinked") ]);
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  }), foreign = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  const page = x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 4096
  });
  assert.ok(page.nextCursor);
  rejected(() => x.pins.readInventoryPage({
    snapshotId: foreign.snapshotId,
    cursor: page.nextCursor,
    maxItems: 1,
    maxBytes: 4096
  }));
  const next = x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: page.nextCursor,
    maxItems: 1,
    maxBytes: 4096
  });
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: page.nextCursor,
    maxItems: 1,
    maxBytes: 4096
  }));
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 4096
  }));
  assert.ok(next.items.length);
  x.pins.closeInventory(s.snapshotId);
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: next.nextCursor,
    maxItems: 1,
    maxBytes: 4096
  }));
});

function allPages(pins, snapshot, maxItems = 2, maxBytes = 4096) {
  let cursor = null, items = [], pages = [];
  do {
    const p = pins.readInventoryPage({
      snapshotId: snapshot.snapshotId,
      cursor: cursor,
      maxItems: maxItems,
      maxBytes: maxBytes
    });
    assert.equal(p.snapshotId, snapshot.snapshotId);
    assert.equal(p.cursor, cursor);
    assert.equal(p.complete, true);
    assert.deepEqual(p.errors, []);
    assert.ok(p.items.length <= maxItems);
    assert.ok(Buffer.byteLength(f.stable(p)) <= maxBytes);
    items.push(...p.items);
    pages.push(p);
    cursor = p.nextCursor;
  } while (cursor !== null);
  return {
    items: items,
    pages: pages
  };
}

test("wm_inventory_all_six_domains_frozen_multi_page_chunk_evidence", t => {
  const x = fixture(t);
  const h = initialize(x), rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push(row("raw", "raw-" + i, "원문" + i + "🌍"));
    rows.push(row("cold", "cold-" + i, "cold-" + i + "\r\n", [ "raw-" + i ]));
  }
  rows.push(row("raw_history", "history-1", "historical"));
  rows.push(row("lineage", "lineage-1", "lineage"));
  rows.push(row("orphan", "orphan-1", "orphan"));
  const rev = put(x, rows);
  const published = publish(x, h, {
    items: rows.slice(0, 8).map(r => r.descriptor),
    raw: "canonical old"
  });
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  put(x, [ row("raw", "raw-later", "later") ], f.sqliteRead(x.databasePath, "SELECT value FROM metadata WHERE key='inventory_revision'")[0].value, "inventory-later");
  publish(x, published, {
    raw: "new",
    operationId: "new-head",
    generationId: "new-head"
  });
  const {items: items, pages: pages} = allPages(x.pins, s);
  assert.ok(pages.length > 5);
  assert.equal(items.length, 12);
  assert.equal(items.some(d => d.logicalId === "raw-later"), false);
  const hash = require("node:crypto").createHash("sha256");
  hash.update("wm.inventory-snapshot.v1\n");
  const counts = Object.fromEntries([ "canonical", "cold", "raw", "raw_history", "lineage", "orphan" ].map(d => [ d, 0 ])), bytes = {
    ...counts
  };
  for (const d of items) {
    hash.update(f.stable(d) + "\n");
    counts[d.domain]++;
    bytes[d.domain] += d.bytes;
    const original = d.domain === "canonical" ? Buffer.from("canonical old") : rows.find(r => r.descriptor.logicalId === d.logicalId).payload;
    const read = chunks((id, offset, maxBytes) => x.pins.readInventoryChunk({
      snapshotId: s.snapshotId,
      logicalId: id,
      offset: offset,
      maxBytes: maxBytes
    }), d.logicalId, d.bytes, 3);
    assert.deepEqual(read, original);
    assert.equal(f.sha(read), d.sha256);
  }
  assert.equal(hash.digest("hex"), s.inventoryDigest);
  assert.deepEqual(counts, s.domainCounts);
  assert.deepEqual(bytes, s.domainBytes);
  rejected(() => x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: "raw-later",
    offset: 0,
    maxBytes: 1
  }));
});

test("wm_canonical_over_four_mib_is_complete_and_negotiated", t => {
  const x = fixture(t), h = initialize(x), raw = "x".repeat(4 * 1024 * 1024 + 1) + "🌍";
  const current = publish(x, h, {
    raw: raw
  });
  const acquired = x.pins.acquire("scope-a");
  assert.deepEqual(acquired.head, current);
  assert.equal(x.pins.readGeneration(acquired.lease), raw);
  assert.equal(x.pins.capabilities.pin.renew, false);
  assert.equal(x.pins.capabilities.limits.maxChunkBytes, 262144);
  assert.equal(x.pins.capabilities.limits.maxPageItems, 128);
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  }), d = allPages(x.pins, s).items[0];
  assert.equal(d.bytes, Buffer.byteLength(raw));
  const c = x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: d.logicalId,
    offset: d.bytes - 4,
    maxBytes: 4
  });
  assert.deepEqual(Buffer.from(c.bytes), Buffer.from("🌍"));
  assert.equal(c.nextOffset, null);
});

test("wm_pin_chunk_corruption_and_membership_fail_closed", t => {
  const x = fixture(t), h = initialize(x), cold = row("cold", "cold-1", "abcdef🌍"), raw = row("raw", "unlinked", "xyz");
  put(x, [ cold, raw ]);
  publish(x, h, {
    items: [ cold.descriptor ]
  });
  const p = x.pins.acquire("scope-a");
  rejected(() => x.pins.readCompanion({
    lease: p.lease,
    logicalId: "unlinked",
    offset: 0,
    maxBytes: 1
  }), /companion_not_in_closure/);
  rejected(() => x.pins.readCompanion({
    lease: p.lease,
    logicalId: "cold-1",
    offset: cold.payload.length + 1,
    maxBytes: 1
  }), /offset_out_of_range/);
  f.sqliteMutate(x.databasePath, db => {
    db.exec("DROP TRIGGER blobs_immutable_update");
    const damaged = Buffer.from(cold.payload);
    damaged[3] ^= 1;
    db.prepare("UPDATE blobs SET payload=? WHERE sha256=?").run(damaged, cold.descriptor.sha256);
  });
  rejected(() => x.pins.readCompanion({
    lease: p.lease,
    logicalId: "cold-1",
    offset: 0,
    maxBytes: 2
  }), /blob_integrity/);
  rejected(() => x.pins.acquire("scope-a"), /blob_integrity/);
});

test("wm_snapshot_chunk_corruption_and_unknown_items_fail_closed", t => {
  const x = fixture(t);
  initialize(x);
  const raw = row("raw", "raw-unlinked", "abcdef");
  put(x, [ raw ]);
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  f.sqliteMutate(x.databasePath, db => {
    db.exec("DROP TRIGGER blobs_immutable_update");
    db.prepare("UPDATE blobs SET payload=? WHERE sha256=?").run(Buffer.from("abcxef"), raw.descriptor.sha256);
  });
  rejected(() => x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: "raw-unlinked",
    offset: 0,
    maxBytes: 1
  }), /blob_integrity/);
  rejected(() => allPages(x.pins, s), /blob_integrity/);
  rejected(() => x.pins.openInventory({
    routeGeneration: "route-1"
  }), /blob_integrity/);
});

test("wm_snapshot_safe_integer_totals_overflow_precedes_payload_allocation", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        maxInventoryBytes: Number.MAX_SAFE_INTEGER
      }
    }
  });
  initialize(x);
  put(x, [ row("raw", "raw-a", "a"), row("raw", "raw-b", "b") ]);
  f.sqliteMutate(x.databasePath, db => {
    db.exec("DROP TRIGGER inventory_items_immutable_update");
    const d = {
      ...f.item("raw", "raw-a"),
      bytes: Number.MAX_SAFE_INTEGER,
      sha256: f.sha(Buffer.from("a"))
    };
    const json = f.stable(d);
    db.prepare("UPDATE inventory_items SET descriptor_json=?,descriptor_sha256=? WHERE logical_id=?").run(json, f.sha(Buffer.from(json)), "raw-a");
  });
  const before = f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM inventory_snapshots")[0].n;
  rejected(() => x.pins.openInventory({
    routeGeneration: "route-1"
  }), /byte_total_overflow/);
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM inventory_snapshots")[0].n, before);
});

test("wm_inventory_streaming_does_not_materialize_full_rows_or_payloads", t => {
  const x = fixture(t);
  initialize(x);
  const rows = Array.from({
    length: 20
  }, (_, i) => row("raw", "raw-" + i, "x".repeat(3e5) + i));
  put(x, rows);
  const original = DatabaseSync.prototype.prepare;
  let boundedScans = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    if (/SELECT payload,utf8_bytes FROM blobs/.test(sql)) {
      const stmt = original.call(this, sql), get = stmt.get.bind(stmt);
      stmt.get = (...args) => {
        const result = get(...args);
        assert.ok(result.payload.length === 0, "Only empty canonical may use complete-data reads in this fixture");
        return result;
      };
      return stmt;
    }
    const stmt = original.call(this, sql);
    if (/FROM (inventory_items|inventory_snapshot_items)/.test(sql)) {
      stmt.all = () => assert.fail("Unbounded inventory materialization");
      if (sql.includes("substr")) boundedScans++;
    }
    return stmt;
  };
  let s, result;
  try {
    s = x.pins.openInventory({
      routeGeneration: "route-1"
    });
    result = allPages(x.pins, s, 3, 4096);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  assert.equal(result.items.length, 21);
  assert.ok(result.pages.length >= 7);
  assert.equal(s.domainBytes.raw, rows.reduce((a, r) => a + r.payload.length, 0));
});

test("wm_pin_nonce_scope_generation_and_boot_reuse_are_rejected", t => {
  const x = fixture(t);
  initialize(x);
  initialize(x, "scope-b");
  const a = x.pins.acquire("scope-a");
  for (const change of [ {
    nonce: "nonce-forged"
  }, {
    scope: "scope-b"
  }, {
    generationId: "generation-forged"
  }, {
    bootGeneration: "boot-forged"
  }, {
    expiresAt: a.lease.expiresAt + 1
  } ]) rejected(() => x.pins.readGeneration({
    ...a.lease,
    ...change
  }));
  rejected(() => x.pins.head("scope-b", a.lease));
  api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-b"
  });
  const back = api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-a"
  });
  rejected(() => back.readGeneration(a.lease), /lease_mismatch/);
  const fresh = back.acquire("scope-a");
  assert.notEqual(fresh.lease.bootGeneration, a.lease.bootGeneration);
});

test("wm_same_boot_restart_invalidates_old_lease_and_snapshot", t => {
  const x = fixture(t);
  initialize(x);
  const lease = x.pins.acquire("scope-a").lease, s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  x.store.close();
  const reopened = createWmStore(x.config);
  t.after(() => reopened.close());
  const pins = api.createWmPins({
    store: reopened,
    clock: x.clock,
    bootId: "boot-a"
  });
  rejected(() => pins.readGeneration(lease));
  rejected(() => pins.release(lease));
  rejected(() => pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 4096
  }));
  rejected(() => pins.closeInventory(s.snapshotId));
  assert.notEqual(pins.acquire("scope-a").lease.bootGeneration, lease.bootGeneration);
});

test("wm_epoch_rotation_invalidates_leases_and_inventory", t => {
  const x = fixture(t), h = initialize(x), lease = x.pins.acquire("scope-a").lease, s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  publish(x, h, {
    operation: "reset",
    raw: "reset"
  });
  rejected(() => x.pins.readGeneration(lease), /lease_lifecycle_conflict/);
  rejected(() => x.pins.release(lease), /lease_lifecycle_conflict/);
  rejected(() => x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: "missing",
    offset: 0,
    maxBytes: 1
  }), /snapshot_lifecycle_conflict/);
  rejected(() => x.pins.closeInventory(s.snapshotId), /snapshot_lifecycle_conflict/);
});

test("wm_inventory_expiry_close_and_route_validation", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        inventoryTtlMs: 10
      }
    }
  });
  initialize(x);
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  x.setTime(110);
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 4096
  }), /snapshot_expired/);
  rejected(() => x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: "missing",
    offset: 0,
    maxBytes: 1
  }), /snapshot_expired/);
  rejected(() => x.pins.closeInventory(s.snapshotId), /snapshot_expired/);
  rejected(() => x.pins.openInventory({
    routeGeneration: "foreign-route"
  }), /route_generation_conflict/);
});

test("wm_capability_limits_are_intersection_and_fail_explicitly", t => {
  const x = fixture(t, {
    storeOptions: {
      limits: {
        maxCanonicalBytes: 8,
        maxInventoryBatchItems: 2
      }
    },
    pinOptions: {
      limits: {
        maxCanonicalBytes: 100,
        maxBatchItems: 100,
        maxChunkBytes: 4,
        maxPageItems: 2,
        maxPageBytes: 1024,
        maxActivePins: 1,
        maxSnapshots: 1
      }
    }
  });
  const h = initialize(x);
  publish(x, h, {
    raw: "12345678"
  });
  assert.equal(x.pins.capabilities.limits.maxCanonicalBytes, 8);
  assert.equal(x.pins.capabilities.limits.maxBatchItems, 2);
  const l = x.pins.acquire("scope-a").lease;
  rejected(() => x.pins.acquire("scope-a"), /pin_capacity/);
  x.pins.release(l);
  assert.ok(x.pins.acquire("scope-a"));
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  rejected(() => x.pins.openInventory({
    routeGeneration: "route-1"
  }), /snapshot_capacity/);
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 3,
    maxBytes: 1024
  }), /page_limit/);
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 1025
  }), /page_limit/);
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 1
  }), /page_item_byte_limit/);
  const d = allPages(x.pins, s, 1, 1024).items[0];
  rejected(() => x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: d.logicalId,
    offset: 0,
    maxBytes: 5
  }), /chunk_limit/);
  assert.deepEqual(Buffer.from(x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: d.logicalId,
    offset: 1,
    maxBytes: 4
  }).bytes), Buffer.from("2345"));
});

test("wm_non_plain_and_unsafe_requests_reject_without_getters", t => {
  const x = fixture(t);
  initialize(x);
  const l = x.pins.acquire("scope-a").lease;
  let called = 0;
  const forged = {
    ...l
  };
  Object.defineProperty(forged, "nonce", {
    enumerable: true,
    get() {
      called++;
      return l.nonce;
    }
  });
  rejected(() => x.pins.readGeneration(forged), /non_plain_data/);
  assert.equal(called, 0);
  rejected(() => x.pins.acquire(""));
  rejected(() => x.pins.observeHeads([ "scope-a", "scope-a" ]));
  rejected(() => x.pins.observeHeads([ "scope-a" ], {
    leases: []
  }));
  for (const offset of [ -1, .5, Number.MAX_SAFE_INTEGER + 1 ]) rejected(() => x.pins.readCompanion({
    lease: l,
    logicalId: "any",
    offset: offset,
    maxBytes: 1
  }), /chunk_invalid/);
  for (const maxBytes of [ 0, .5, Number.MAX_SAFE_INTEGER + 1 ]) rejected(() => x.pins.readCompanion({
    lease: l,
    logicalId: "any",
    offset: 0,
    maxBytes: maxBytes
  }));
  rejected(() => api.createWmPins({
    store: x.store,
    bootId: "boot-a",
    limits: {
      unknown: 1
    }
  }));
  assert.equal(called, 0);
});

test("wm_canonical_empty_and_tombstone_snapshot_evidence_are_distinct", t => {
  const x = fixture(t), h = initialize(x), initial = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  const initialItem = allPages(x.pins, initial).items[0];
  assert.deepEqual(initialItem.disposition, {
    tombstone: true
  });
  publish(x, h, {
    raw: ""
  });
  const empty = x.pins.openInventory({
    routeGeneration: "route-1"
  }), emptyItem = allPages(x.pins, empty).items[0];
  assert.deepEqual(emptyItem.disposition, {
    tombstone: false
  });
  assert.equal(initialItem.sha256, emptyItem.sha256);
  assert.notEqual(initial.inventoryDigest, empty.inventoryDigest);
});

test("wm_snapshot_capacity_counts_earlier_longer_ttl", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        maxSnapshots: 1,
        inventoryTtlMs: 1e3
      }
    }
  });
  initialize(x);
  x.pins.openInventory({
    routeGeneration: "route-1"
  });
  x.setTime(200);
  const short = api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-a",
    limits: {
      maxSnapshots: 1,
      inventoryTtlMs: 10
    }
  });
  rejected(() => short.openInventory({
    routeGeneration: "route-1"
  }), /snapshot_capacity/);
});

test("wm_snapshot_corrupt_complete_and_foreign_dataset_cursor_are_rejected", t => {
  const x = fixture(t), y = fixture(t);
  initialize(x);
  initialize(y);
  put(x, [ row("raw", "a"), row("raw", "b") ]);
  put(y, [ row("raw", "a"), row("raw", "b") ]);
  const sx = x.pins.openInventory({
    routeGeneration: "route-1"
  }), sy = y.pins.openInventory({
    routeGeneration: "route-1"
  }), first = x.pins.readInventoryPage({
    snapshotId: sx.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 4096
  });
  rejected(() => y.pins.readInventoryPage({
    snapshotId: sy.snapshotId,
    cursor: first.nextCursor,
    maxItems: 1,
    maxBytes: 4096
  }));
  rejected(() => y.pins.readInventoryChunk({
    snapshotId: sx.snapshotId,
    logicalId: "a",
    offset: 0,
    maxBytes: 1
  }), /snapshot_missing/);
  f.sqliteMutate(x.databasePath, db => {
    const row = db.prepare("SELECT snapshot_json FROM inventory_snapshots WHERE snapshot_id=?").get(sx.snapshotId), state = JSON.parse(row.snapshot_json);
    state.snapshot.complete = false;
    db.prepare("UPDATE inventory_snapshots SET snapshot_json=? WHERE snapshot_id=?").run(f.stable(state), sx.snapshotId);
  });
  rejected(() => x.pins.readInventoryPage({
    snapshotId: sx.snapshotId,
    cursor: first.nextCursor,
    maxItems: 1,
    maxBytes: 4096
  }), /record_integrity/);
});

test("wm_frozen_digest_is_portable_across_physical_identities", t => {
  const x = fixture(t), y = fixture(t, {
    storeOptions: {
      identity: {
        ...f.storeIdentity(),
        authorityId: "authority-other",
        storeId: "store-other"
      }
    }
  });
  const a = initialize(x), b = initialize(y), r = row("raw", "raw-shared", "portable🌍");
  put(x, [ r ]);
  put(y, [ r ]);
  publish(x, a, {
    items: [ r.descriptor ],
    generationId: "generation-a",
    raw: "same"
  });
  publish(y, b, {
    items: [ r.descriptor ],
    generationId: "generation-b",
    raw: "same"
  });
  const sx = x.pins.openInventory({
    routeGeneration: "route-1"
  }), sy = y.pins.openInventory({
    routeGeneration: "route-1"
  });
  assert.equal(sx.inventoryDigest, sy.inventoryDigest);
  assert.deepEqual(sx.domainBytes, sy.domainBytes);
  const fx = x.store.fenceDataset(f.signed({
    operationId: "fence-x",
    expectedRoute: f.storeRoute()
  })), fy = y.store.fenceDataset(f.signed({
    operationId: "fence-y",
    expectedRoute: f.storeRoute()
  }));
  assert.equal(fx.status, "committed");
  assert.equal(fy.status, "committed");
  assert.notEqual(fx.receipt.inventoryDigest, fy.receipt.inventoryDigest);
  assert.notEqual(fx.receipt.inventoryDigest, sx.inventoryDigest);
});

test("wm_expiry_during_final_observation_or_chunk_scan_is_rejected", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        pinTtlMs: 10,
        inventoryTtlMs: 10
      }
    }
  });
  initialize(x);
  const r = row("raw", "unlinked", "abcdef");
  put(x, [ r ]);
  const l = x.pins.acquire("scope-a").lease, s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  const original = DatabaseSync.prototype.prepare;
  let triggered = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const stmt = original.call(this, sql);
    if (sql === "SELECT * FROM heads WHERE scope=?") {
      const get = stmt.get.bind(stmt);
      stmt.get = (...args) => {
        const result = get(...args);
        if (!triggered) {
          triggered = true;
          x.setTime(110);
        }
        return result;
      };
    }
    return stmt;
  };
  try {
    rejected(() => x.pins.observeHeads([ "scope-a" ], {
      leases: [ l ]
    }), /lease_expired/);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  const y = fixture(t, {
    pinOptions: {
      limits: {
        pinTtlMs: 10,
        inventoryTtlMs: 10
      }
    }
  });
  initialize(y);
  put(y, [ r ]);
  const sy = y.pins.openInventory({
    routeGeneration: "route-1"
  });
  triggered = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const stmt = original.call(this, sql);
    if (sql.includes("substr(payload")) {
      const get = stmt.get.bind(stmt);
      stmt.get = (...args) => {
        const result = get(...args);
        if (!triggered) {
          triggered = true;
          y.setTime(110);
        }
        return result;
      };
    }
    return stmt;
  };
  try {
    rejected(() => y.pins.readInventoryChunk({
      snapshotId: sy.snapshotId,
      logicalId: "unlinked",
      offset: 0,
      maxBytes: 1
    }), /snapshot_expired/);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
});

test("wm_generation_item_and_canonical_limits_preflight_before_full_reads", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        maxGenerationItems: 1,
        maxCanonicalBytes: 4
      }
    }
  }), h = initialize(x), rows = [ row("raw", "a", ""), row("raw", "b", "") ];
  put(x, rows);
  publish(x, h, {
    items: rows.map(r => r.descriptor),
    raw: "abcde"
  });
  const original = DatabaseSync.prototype.prepare;
  let fullRead = false;
  DatabaseSync.prototype.prepare = function(sql) {
    if (sql === "SELECT * FROM generations WHERE generation_id=?") fullRead = true;
    return original.call(this, sql);
  };
  try {
    rejected(() => x.pins.acquire("scope-a"), /pin_limit/);
    assert.equal(fullRead, false);
    fullRead = false;
    rejected(() => x.pins.openInventory({
      routeGeneration: "route-1"
    }), /pin_limit/);
    assert.equal(fullRead, false);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
});

test("wm_inventory_item_byte_and_expiry_overflow_caps_leave_no_snapshots", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        maxInventoryItems: 1
      }
    }
  });
  initialize(x);
  put(x, [ row("raw", "unlinked", "abc") ]);
  rejected(() => x.pins.openInventory({
    routeGeneration: "route-1"
  }), /inventory_item_limit/);
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM inventory_snapshots")[0].n, 0);
  const byteLimited = api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-a",
    limits: {
      maxInventoryBytes: 2
    }
  });
  rejected(() => byteLimited.openInventory({
    routeGeneration: "route-1"
  }), /inventory_byte_limit/);
  x.setTime(Number.MAX_SAFE_INTEGER);
  rejected(() => x.pins.acquire("scope-a"), /expiry_overflow/);
  rejected(() => byteLimited.openInventory({
    routeGeneration: "route-1"
  }), /expiry_overflow/);
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM pins")[0].n, 0);
});

test("wm_snapshot_and_pin_storage_failures_rollback_and_are_sanitized", t => {
  for (const method of [ "acquire", "openInventory" ]) {
    const x = fixture(t);
    initialize(x);
    let failure;
    try {
      f.faultSqlite({
        sqlPattern: /^COMMIT$/,
        kind: "disk_full"
      }, () => method === "acquire" ? x.pins.acquire("scope-a") : x.pins.openInventory({
        routeGeneration: "route-1"
      }));
    } catch (e) {
      failure = e;
    }
    assert.equal(failure?.code, "WM_storage_unavailable");
    assert.equal(failure.message, "storage_unavailable");
    assert.equal(f.sqliteRead(x.databasePath, method === "acquire" ? "SELECT COUNT(*) n FROM pins" : "SELECT COUNT(*) n FROM inventory_snapshots")[0].n, 0);
  }
});

test("wm_snapshot_item_validator_preserves_imported_inert_raw", t => {
  const x = fixture(t);
  initialize(x);
  const r = row("raw", "inert-raw", "原文🌍");
  r.descriptor.originScope = "foreign-origin";
  r.descriptor.disposition = {
    analysisEligible: false,
    replacementEligible: false
  };
  put(x, [ r ]);
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  }), items = allPages(x.pins, s).items;
  for (const d of items) assert.deepEqual(api.validateInventoryItem(d), {
    ok: true
  });
  const raw = items.find(d => d.logicalId === "inert-raw");
  assert.equal(raw.originScope, "foreign-origin");
  assert.deepEqual(raw.disposition, {
    analysisEligible: false,
    replacementEligible: false
  });
  assert.deepEqual(chunks((id, offset, maxBytes) => x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: id,
    offset: offset,
    maxBytes: maxBytes
  }), raw.logicalId, raw.bytes), r.payload);
  assert.equal(api.validateInventoryItem({
    ...raw,
    disposition: {
      analysisEligible: true,
      replacementEligible: false
    }
  }).ok, false);
  const canonical = items.find(d => d.domain === "canonical");
  assert.equal(api.validateInventoryItem({
    ...canonical,
    logicalId: "fake"
  }).ok, false);
  assert.equal(api.validateInventoryItem({
    ...canonical,
    disposition: {
      tombstone: "true"
    }
  }).ok, false);
});

test("wm_leased_chunk_expiring_during_blob_scan_is_rejected", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        pinTtlMs: 10
      }
    }
  }), h = initialize(x), r = row("cold", "cold-time", "abcdef");
  put(x, [ r ]);
  publish(x, h, {
    items: [ r.descriptor ]
  });
  const lease = x.pins.acquire("scope-a").lease, original = DatabaseSync.prototype.prepare;
  let triggered = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const stmt = original.call(this, sql);
    if (sql.includes("substr(payload")) {
      const get = stmt.get.bind(stmt);
      stmt.get = (...args) => {
        const out = get(...args);
        if (!triggered) {
          triggered = true;
          x.setTime(110);
        }
        return out;
      };
    }
    return stmt;
  };
  try {
    rejected(() => x.pins.readCompanion({
      lease: lease,
      logicalId: r.descriptor.logicalId,
      offset: 0,
      maxBytes: 1
    }), /lease_expired/);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
});

test("wm_snapshot_logical_id_collision_is_explicit_and_atomic", t => {
  const x = fixture(t);
  initialize(x);
  put(x, [ row("raw", "canonical-" + f.sha(Buffer.from("scope-a")), "collision") ]);
  const before = f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM inventory_snapshots")[0].n;
  rejected(() => x.pins.openInventory({
    routeGeneration: "route-1"
  }), /inventory_logical_id_conflict/);
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM inventory_snapshots")[0].n, before);
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM inventory_snapshot_items")[0].n, 0);
});

test("wm_canonical_only_negotiated_limit_is_checked_before_materialization", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        maxCanonicalBytes: 4
      }
    }
  }), h = initialize(x);
  publish(x, h, {
    raw: "abcde"
  });
  const original = DatabaseSync.prototype.prepare;
  let materialized = false;
  DatabaseSync.prototype.prepare = function(sql) {
    if (sql === "SELECT * FROM generations WHERE generation_id=?") materialized = true;
    return original.call(this, sql);
  };
  try {
    rejected(() => x.pins.acquire("scope-a"), /pin_limit/);
    assert.equal(materialized, false);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
});

test("wm_expired_capacity_reacquisition_and_final_head_ttl", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        pinTtlMs: 10,
        maxActivePins: 1,
        inventoryTtlMs: 10,
        maxSnapshots: 1
      }
    }
  });
  initialize(x);
  const old = x.pins.acquire("scope-a").lease, s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  x.setTime(110);
  const current = x.pins.acquire("scope-a").lease;
  assert.notEqual(current.pinId, old.pinId);
  assert.ok(x.pins.openInventory({
    routeGeneration: "route-1"
  }));
  rejected(() => x.pins.release(old), /lease_expired/);
  rejected(() => x.pins.closeInventory(s.snapshotId), /snapshot_expired/);
  assert.equal(x.pins.head("scope-a", current).leaseValid, true);
});

test("wm_batch_byte_cap_is_negotiated_and_observation_bounded", t => {
  const x = fixture(t, {
    storeOptions: {
      limits: {
        maxInventoryBatchBytes: 1024
      }
    },
    pinOptions: {
      limits: {
        maxBatchBytes: 2048
      }
    }
  });
  initialize(x);
  assert.equal(x.pins.capabilities.limits.maxBatchBytes, 1024);
  assert.equal(x.pins.observeHeads([ "scope-a" ]).length, 1);
  const small = api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-a",
    limits: {
      maxBatchBytes: 8
    }
  });
  rejected(() => small.observeHeads([ "scope-a" ]), /batch_limit/);
});

test("wm_observed_expiry_cannot_be_resurrected_by_clock_rollback", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        pinTtlMs: 10,
        inventoryTtlMs: 10
      }
    }
  });
  initialize(x);
  const l = x.pins.acquire("scope-a").lease, s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  x.setTime(110);
  rejected(() => x.pins.readGeneration(l), /lease_expired/);
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 4096
  }), /snapshot_expired/);
  x.setTime(105);
  rejected(() => x.pins.readGeneration(l), /lease_expired|clock_regression/);
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 4096
  }), /snapshot_expired|clock_regression/);
});

// A3 independent-review regressions. All fixtures remain synthetic and socket-free.
test("wm_F1_staggered_leases_share_one_final_freshness_time", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        pinTtlMs: 10
      }
    }
  });
  const a = initialize(x), b = initialize(x, "scope-b");
  const la = x.pins.acquire("scope-a").lease;
  x.setTime(105);
  const lb = x.pins.acquire("scope-b").lease;
  x.setTime(109);
  const original = DatabaseSync.prototype.prepare;
  let bScans = 0, advanced = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const stmt = original.call(this, sql);
    if (sql === "SELECT * FROM generations WHERE generation_id=?") {
      const get = stmt.get.bind(stmt);
      stmt.get = (...args) => {
        const result = get(...args);
        if (args[0] === b.generationId && ++bScans === 3) {
          advanced = true;
          x.setTime(110);
        }
        return result;
      };
    }
    return stmt;
  };
  try {
    rejected(() => x.pins.observeHeads([ "scope-a", "scope-b" ], {
      leases: [ la, lb ]
    }), /lease_expired/);
    assert.equal(advanced, true);
    assert.equal(bScans, 3);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  assert.equal(x.pins.head("scope-b", lb).leaseValid, true);
  rejected(() => x.pins.head("scope-a", la), /lease_expired/);
});

test("wm_F2_healthy_remove_retains_and_inventories_companions", t => {
  const x = fixture(t), h = initialize(x), raw = row("raw", "retained-raw", "原文🌍"), cold = row("cold", "retained-cold", "cold\r\n", [ "retained-raw" ]);
  put(x, [ raw, cold ]);
  const removed = publish(x, h, {
    operation: "remove",
    raw: null,
    items: [ raw.descriptor, cold.descriptor ]
  });
  assert.equal(removed.tombstone, true);
  const lease = x.pins.acquire("scope-a").lease;
  assert.equal(x.pins.readGeneration(lease), null);
  assert.deepEqual(chunks((logicalId, offset, maxBytes) => x.pins.readCompanion({
    lease: lease,
    logicalId: logicalId,
    offset: offset,
    maxBytes: maxBytes
  }), raw.descriptor.logicalId, raw.payload.length), raw.payload);
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  }), {items: items} = allPages(x.pins, s, 1, 4096), canonical = items.find(d => d.domain === "canonical");
  assert.deepEqual(canonical.disposition, {
    tombstone: true
  });
  assert.deepEqual(canonical.dependencies, [ raw.descriptor.logicalId, cold.descriptor.logicalId ]);
  assert.deepEqual(api.validateInventoryItem(canonical), {
    ok: true
  });
  assert.equal(s.domainCounts.raw, 1);
  assert.equal(s.domainCounts.cold, 1);
  const hash = require("node:crypto").createHash("sha256");
  hash.update("wm.inventory-snapshot.v1\n");
  for (const d of items) {
    hash.update(f.stable(d) + "\n");
    const data = chunks((logicalId, offset, maxBytes) => x.pins.readInventoryChunk({
      snapshotId: s.snapshotId,
      logicalId: logicalId,
      offset: offset,
      maxBytes: maxBytes
    }), d.logicalId, d.bytes);
    assert.deepEqual(data, d.domain === "canonical" ? Buffer.alloc(0) : d.domain === "raw" ? raw.payload : cold.payload);
  }
  assert.equal(hash.digest("hex"), s.inventoryDigest);
  const empty = publish(x, removed, {
    operationId: "empty-after-remove",
    generationId: "empty-after-remove",
    raw: "",
    writerEpoch: removed.epoch
  });
  const next = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  assert.notEqual(next.inventoryDigest, s.inventoryDigest);
  assert.equal(empty.tombstone, false);
  assert.deepEqual(allPages(x.pins, next).items.find(d => d.domain === "canonical").disposition, {
    tombstone: false
  });
});

test("wm_F3_complete_leased_observation_request_obeys_exact_byte_cap", t => {
  const x = fixture(t);
  initialize(x);
  const lease = x.pins.acquire("scope-a").lease, scopes = [ "scope-a" ], options = {
    leases: [ lease ]
  };
  const requestBytes = Buffer.byteLength(f.stable({
    scopes: scopes,
    options: options
  })), heads = x.pins.observeHeads(scopes), responseBytes = Buffer.byteLength(f.stable(heads));
  assert.ok(requestBytes > responseBytes);
  const tooSmall = api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-a",
    limits: {
      maxBatchBytes: requestBytes - 1
    }
  }), original = DatabaseSync.prototype.prepare;
  let generationReads = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    if (/FROM generations\b/.test(sql)) generationReads++;
    return original.call(this, sql);
  };
  try {
    rejected(() => tooSmall.observeHeads(scopes, options), /batch_limit/);
    assert.equal(generationReads, 0);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  const exact = api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-a",
    limits: {
      maxBatchBytes: requestBytes
    }
  });
  assert.deepEqual(exact.observeHeads(scopes, options), heads);
  const ordinaryBytes = Buffer.byteLength(f.stable({
    scopes: scopes
  }));
  const tiny = api.createWmPins({
    store: x.store,
    clock: x.clock,
    bootId: "boot-a",
    limits: {
      maxBatchBytes: ordinaryBytes - 1
    }
  });
  rejected(() => tiny.observeHeads(scopes), /batch_limit/);
});

test("wm_F4_exact_final_page_budget_uses_actual_null_cursor", t => {
  const x = fixture(t);
  initialize(x);
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  }), descriptor = JSON.parse(f.sqliteRead(x.databasePath, "SELECT descriptor_json FROM inventory_snapshot_items WHERE snapshot_id=?", s.snapshotId)[0].descriptor_json);
  const expected = {
    snapshotId: s.snapshotId,
    cursor: null,
    nextCursor: null,
    items: [ descriptor ],
    complete: true,
    errors: []
  }, exactBytes = Buffer.byteLength(f.stable(expected));
  rejected(() => x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: exactBytes - 1
  }), /page_item_byte_limit/);
  const retained = JSON.parse(f.sqliteRead(x.databasePath, "SELECT snapshot_json FROM inventory_snapshots WHERE snapshot_id=?", s.snapshotId)[0].snapshot_json);
  assert.equal(retained.started, false);
  assert.equal(retained.nextOrdinal, 0);
  assert.deepEqual(x.pins.readInventoryPage({
    snapshotId: s.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: exactBytes
  }), expected);
});

test("wm_F5_epoch_invalidated_readers_do_not_occupy_fresh_capacity", t => {
  const x = fixture(t, {
    pinOptions: {
      limits: {
        maxActivePins: 1,
        maxSnapshots: 1
      }
    }
  }), h = initialize(x), old = x.pins.acquire("scope-a").lease, s = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  const reset = publish(x, h, {
    operation: "reset",
    raw: "reset"
  });
  rejected(() => x.pins.readGeneration(old), /lease_lifecycle_conflict/);
  rejected(() => x.pins.release(old), /lease_lifecycle_conflict/);
  rejected(() => x.pins.closeInventory(s.snapshotId), /snapshot_lifecycle_conflict/);
  const fresh = x.pins.acquire("scope-a").lease;
  assert.equal(fresh.writerEpoch, reset.epoch);
  assert.equal(x.pins.readGeneration(fresh), "reset");
  const next = x.pins.openInventory({
    routeGeneration: "route-1"
  });
  assert.equal(next.complete, true);
  assert.notEqual(next.snapshotId, s.snapshotId);
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM pins")[0].n, 2);
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM inventory_snapshots")[0].n, 2);
  assert.equal(f.sqliteRead(x.databasePath, "SELECT COUNT(*) n FROM inventory_snapshot_items WHERE snapshot_id=?", s.snapshotId)[0].n, 1);
  assert.equal(x.store.readGeneration({
    generationId: h.generationId
  }).raw, null);
});

test("wm_F2_empty_original_blob_and_end_offset_return_empty_chunk", t => {
  const x = fixture(t);
  initialize(x);
  const raw = row("raw", "end-offset", "abc");
  put(x, [ raw ]);
  const s = x.pins.openInventory({
    routeGeneration: "route-1"
  }), d = allPages(x.pins, s).items.find(d => d.domain === "canonical");
  const end = x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: raw.descriptor.logicalId,
    offset: raw.payload.length,
    maxBytes: 1
  });
  assert.equal(end.bytes.length, 0);
  assert.equal(end.offset, 3);
  assert.equal(end.nextOffset, null);
  assert.equal(end.totalBytes, 3);
  assert.equal(end.sha256, raw.descriptor.sha256);
  const c = x.pins.readInventoryChunk({
    snapshotId: s.snapshotId,
    logicalId: d.logicalId,
    offset: 0,
    maxBytes: 1
  });
  assert.ok(c.bytes instanceof Uint8Array);
  assert.equal(c.bytes.length, 0);
  assert.equal(c.totalBytes, 0);
  assert.equal(c.nextOffset, null);
  assert.equal(c.sha256, f.sha(Buffer.alloc(0)));
});
