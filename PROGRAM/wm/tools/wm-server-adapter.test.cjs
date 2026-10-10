"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const F = require("../../tests/helpers/wm-fixture.cjs"), C = require("../src/wm-storage-contracts.source.js");

const A = fs.existsSync(__dirname + "/../src/wm-server-storage.source.js") ? require("../src/wm-server-storage.source.js") : {};

const R = fs.existsSync(__dirname + "/../src/wm-storage-router.source.js") ? require("../src/wm-storage-router.source.js") : {};

const {createWmService: createWmService} = require("../../server/wm/service.cjs"), H = require("../../server/wm/http.cjs");

function fixture(t, opts = {}) {
  assert.equal(typeof A.createWmServerBackend, "function", "A4 server adapter required");
  assert.equal(typeof R.createWmOperationJournal, "function", "durable journal required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-b2-synthetic-")), service = createWmService({
    dataDir: root,
    serverIdentity: F.storeIdentity(),
    limits: opts.limits || {}
  });
  t.after(() => service.close());
  const data = opts.data || new Map, journal = R.createWmOperationJournal({
    storage: {
      async getItem(k) {
        return data.get(k) ?? null;
      },
      async setItem(k, v) {
        data.set(k, v);
      }
    }
  });
  const calls = [], state = {
    loss: false,
    statusLoss: false,
    mutate: null,
    incarnation: "synthetic-boot-1"
  };
  const connection = {
    identity: F.storeIdentity(),
    route: F.storeRoute(),
    writerEpoch: "epoch-a",
    incarnation: "synthetic-boot-1",
    limits: service.capabilities().limits
  };
  const transport = {
    async request(v) {
      calls.push(v);
      const out = H.handleWmRequest({
        method: v.method,
        path: v.path,
        body: v.body,
        principal: H.wmPrincipalForPluginId("libra_world_manager"),
        service: service
      });
      if (v.path.endsWith("/publish") && state.loss) throw Error("lost ACK");
      if (v.path === "/v1/wm/snapshot/status" && state.statusLoss) throw Error("status unavailable");
      const packet = {
        response: {
          schema: "wm.ipc-response.v1",
          requestId: v.requestId,
          action: v.path.slice("/v1/wm/".length),
          owner: "wm",
          payload: out
        },
        sender: {
          owner: "wm",
          pluginId: "libra_world_manager",
          backendId: "server-a"
        },
        incarnation: state.incarnation
      };
      return state.mutate ? state.mutate(packet, v) : packet;
    }
  };
  const create = () => A.createWmServerBackend({
    transport: transport,
    connection: connection,
    limits: connection.limits,
    journal: R.createWmOperationJournal({
      storage: {
        async getItem(k) {
          return data.get(k) ?? null;
        },
        async setItem(k, v) {
          data.set(k, v);
        }
      }
    })
  });
  return {
    backend: create(),
    create: create,
    service: service,
    journal: journal,
    data: data,
    calls: calls,
    state: state,
    connection: connection,
    root: root
  };
}

async function initialized(f) {
  const r = await f.backend.initializeScope({
    route: F.storeRoute(),
    scope: "scope-a",
    operationId: "adapter-init",
    expectedEmpty: true
  });
  assert.equal(r.ok, true);
  return r.head;
}

const winput = (h, operationId = "adapter-write", raw = F.raw) => ({
  ...F.storeWrite(h, {
    operationId: operationId,
    raw: raw
  }),
  route: F.storeRoute()
});

test("wm_adapter_status_checks_fingerprint", async t => {
  const f = fixture(t), h = await initialized(f), w = winput(h);
  const r = await f.backend.publishBundle(w);
  assert.equal(r.status, "committed");
  const original = w.requestFingerprint;
  f.state.mutate = (p, v) => {
    if (v.path.endsWith("/status")) p.response.payload.body.result.requestFingerprint = F.sha("foreign");
    return p;
  };
  assert.equal((await f.backend.operationStatus({
    operationId: w.operationId,
    requestFingerprint: original
  })).status, "uncertain");
});

test("wm_unknown_commit_reuses_same_operation_id", async t => {
  const f = fixture(t), h = await initialized(f), w = winput(h);
  f.state.loss = true;
  f.state.statusLoss = true;
  const first = await f.backend.publishBundle(w);
  assert.equal(first.status, "uncertain");
  const originalPublishes = f.calls.filter(v => v.path.endsWith("/publish")).length;
  const pending = await f.journal.pending();
  assert.equal(pending[0].operationId, w.operationId);
  const reloaded = f.create();
  f.state.statusLoss = false;
  const reconciled = await reloaded.publishBundle(w);
  assert.equal(reconciled.status, "committed");
  assert.equal(f.calls.filter(v => v.path.endsWith("/publish")).length - originalPublishes, 0);
  assert.equal((await f.journal.pending()).length, 0);
});

test("wm_adapter_lost_ack_receipt_survives_later_head", async t => {
  const f = fixture(t), h = await initialized(f), w = winput(h);
  f.state.loss = true;
  f.state.statusLoss = true;
  assert.equal((await f.backend.publishBundle(w)).status, "uncertain");
  f.state.loss = false;
  f.state.statusLoss = false;
  const current = f.service.status().dataset;
  const pin = f.service.acquire("scope-a"), later = F.storeWrite(pin.head, {
    operationId: "later-write",
    generationId: "later-generation"
  });
  f.service.release(pin.lease);
  f.service.publish(f.service.prepare(later));
  const result = await f.create().operationStatus({
    operationId: w.operationId,
    requestFingerprint: w.requestFingerprint
  });
  assert.equal(result.status, "committed");
  assert.notEqual(result.receipt.head.generationId, f.service.acquire("scope-a").head.generationId);
});

test("wm_adapter_initial_scope_and_leased_observation_are_real", async t => {
  const f = fixture(t), h = await initialized(f);
  assert.equal(C.validateHead(h).ok, true);
  const r = await f.backend.readCanonical({
    route: F.storeRoute(),
    scope: "scope-a"
  });
  assert.equal(r.ok, true);
  assert.equal(r.raw, null);
  assert.equal((await f.backend.current()).ok, true);
  const observe = f.calls.find(v => v.path.endsWith("/observe"));
  assert.equal(observe.body.leases.length, 1);
  assert.ok(observe.body.leases[0].pinId);
  await f.backend.closeRequest();
});

test("wm_adapter_four_mib_is_negotiated_not_permanent", async t => {
  const f = fixture(t), h = await initialized(f), raw = "🌍".repeat(11e5), r = await f.backend.publishBundle(winput(h, "large", raw));
  assert.equal(r.status, "committed");
  assert.ok(f.backend.describe().maxPayloadBytes > 4 * 1024 * 1024);
  assert.equal((await f.backend.readCanonical({
    handle: Object.freeze({}),
    route: F.storeRoute(),
    scope: "scope-a"
  })).raw, raw);
});

for (const fault of [ "schema", "owner", "sender", "incarnation", "requestId", "head" ]) test("wm_adapter_rejects_foreign_response_" + fault, async t => {
  const f = fixture(t);
  await initialized(f);
  f.state.mutate = (p, v) => {
    if (fault === "schema") p.response.schema = "unknown";
    if (fault === "owner") p.response.owner = "libra";
    if (fault === "sender") p.sender.pluginId = "libra";
    if (fault === "incarnation") p.incarnation = "foreign-boot";
    if (fault === "requestId") p.response.requestId = "foreign";
    if (fault === "head" && v.path.endsWith("/acquire")) p.response.payload.body.result.head.storeId = "foreign";
    return p;
  };
  assert.equal((await f.backend.readCanonical({
    handle: Object.freeze({}),
    route: F.storeRoute(),
    scope: "scope-a"
  })).ok, false);
});

test("wm_adapter_rejects_null_expected_head_and_route_drift", async t => {
  const f = fixture(t), h = await initialized(f), before = f.calls.length;
  await assert.rejects(f.backend.prepare({
    ...F.storeWrite(h),
    expectedHead: null
  }));
  const r = await f.backend.publishBundle({
    ...winput(h),
    route: {
      ...F.storeRoute(),
      routeGeneration: "old"
    }
  });
  assert.equal(r.status, "conflict");
  assert.equal(f.calls.filter(v => v.path.endsWith("/publish")).length, 0);
});

test("wm_adapter_unknown_status_never_claims_not_applied", async t => {
  const f = fixture(t);
  assert.equal((await f.backend.operationStatus({
    operationId: "unknown",
    requestFingerprint: F.sha("unknown")
  })).status, "uncertain");
});

test("wm_adapter_partial_upload_limit_fails_closed_and_read_chunk_exact", async t => {
  const f = fixture(t, {
    limits: {
      maxChunkBytes: 2
    }
  });
  await initialized(f);
  const r = await f.backend.appendRaw({
    route: F.storeRoute(),
    record: F.inventoryWrite({
      items: [ {
        descriptor: F.item(),
        payload: new Uint8Array(Buffer.from("abc"))
      } ]
    })
  });
  assert.equal(r.status, "conflict");
  assert.equal(f.calls.filter(v => v.path.endsWith("/inventory/put")).length, 0);
  assert.equal(f.backend.describe().partialChunkUpload, false);
});

async function bridge(f) {
  const vm = require("node:vm");
  const context = vm.createContext({
    console: console,
    crypto: require("node:crypto").webcrypto,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Uint8Array: Uint8Array,
    environment: {
      snapshotAuthority: f.backend,
      operationJournal: f.journal
    },
    WmNativePortability: require('../src/wm-native-portability.source.js'),
    WmNativeHostGate: require('../src/wm-native-host-gate.source.js'),
    WmWriterRouting: require('../src/wm-writer-routing.source.js'),
    RisuCompat: {pluginStorage: {}, localPluginStorage: {}},
    runtimeDetached: false,
    runtimeDisposers: []
  });
  await new vm.Script(`(async()=>{const WmSnapshotAuthorityModule=(()=>{const module={exports:{}};${fs.readFileSync(__dirname + "/../src/wm-versioned-snapshot.cjs", "utf8")};return module.exports;})();\n${fs.readFileSync(__dirname + "/../src/wm-storage-contracts.source.js", "utf8")}\n${fs.readFileSync(__dirname + "/../src/versioned-canonical-bridge.source.js", "utf8")}\nglobalThis.bridge=VersionedCanonicalBridge;})()`).runInContext(context);
  return context.bridge;
}

test("wm_adapter_snapshot_provider_compatibility_uses_real_a4", async t => {
  const f = fixture(t), h = await initialized(f), authority = require("../src/wm-versioned-snapshot.cjs").createSnapshotAuthority(f.backend, {
    maxPayloadBytes: f.backend.describe().maxPayloadBytes
  });
  const r = await authority.commit({
    scope: "scope-a",
    expectedHead: h,
    raw: F.raw,
    operation: "normal",
    operationId: "compat"
  });
  assert.equal(r.ok, true);
});

test("wm_bridge_uncertain_reload_preserves_original_id_and_status_only", async t => {
  const f = fixture(t);
  await initialized(f);
  const b = await bridge(f), read = await b.read("scope-a");
  assert.equal(read.ok, true);
  f.state.loss = true;
  f.state.statusLoss = true;
  const first = await b.commit("scope-a", read.sourceToken, F.raw, "normal");
  assert.equal(first.uncertain, true);
  assert.ok(first.operationId);
  const publishes = f.calls.filter(v => v.path.endsWith("/publish")).length;
  const next = f.create(), other = await bridge({
    ...f,
    backend: next
  });
  f.state.statusLoss = false;
  const before = await other.read("scope-a");
  const pending = await f.journal.pending();
  const result = await other.reconcile(first.operationId);
  assert.equal(result.status, "committed");
  assert.equal(result.operationId, first.operationId);
  assert.equal(f.calls.filter(v => v.path.endsWith("/publish")).length, publishes);
});

test("wm_bridge_final_observation_supplies_live_request_leases", async t => {
  const f = fixture(t);
  await initialized(f);
  const b = await bridge(f), owner = b.openRequest();
  assert.equal((await b.read("scope-a", owner)).ok, true);
  assert.equal((await b.finalObservation(owner)).ok, true);
  const observations = f.calls.filter(v => v.path.endsWith("/observe"));
  assert.ok(observations.length);
  assert.equal(observations.at(-1).body.leases.length, 1);
  b.finishRequest(owner);
});

test("wm_acquire_digest_matches_durable_pin_and_immutable_manifest", async t => {
  const f = fixture(t), h = await initialized(f), a = await f.backend.acquire("scope-a");
  const db = path.join(f.serviceRoot || "", "");
  const acquireCall = f.calls.filter(v => v.path.endsWith("/acquire")).at(-1);
  assert.ok(a.manifestDigest);
  assert.notEqual(a.manifestDigest, a.head.sha256);
  const p = await f.backend.prepare(F.storeWrite(h, {
    operationId: "digest-write"
  }));
  assert.equal((await f.backend.publish(p)).status, "committed");
  const b = await f.backend.acquire("scope-a");
  assert.notEqual(a.manifestDigest, b.manifestDigest);
  assert.equal(b.head.generationId, p.head.generationId);
  assert.deepEqual(Object.keys(b.head).sort(), C.HEAD_KEYS.slice().sort());
  await f.backend.release(a.lease);
  await f.backend.release(b.lease);
});

test("wm_adapter_raw_history_and_companion_roundtrip_is_server_only", async t => {
  const f = fixture(t), h = await initialized(f), payload = new Uint8Array(Buffer.from("abc")), d = F.item(), raw = F.inventoryWrite({
    operationId: "raw-put",
    items: [ {
      descriptor: d,
      payload: payload
    } ]
  });
  assert.equal((await f.backend.appendRaw({
    route: F.storeRoute(),
    record: raw
  })).status, "committed");
  const history = {
    ...F.item("raw_history", "history-1", [ "raw-1" ]),
    bytes: 3
  }, data = F.inventoryWrite({
    operationId: "history-put",
    expectedInventoryRevision: f.service.status().dataset.inventoryRevision,
    items: [ {
      descriptor: history,
      payload: payload
    } ]
  });
  assert.equal((await f.backend.updateRawHistory({
    route: F.storeRoute(),
    recordId: "raw-1",
    history: data
  })).status, "committed");
  const m = F.storeWrite(h, {
    operationId: "raw-manifest",
    items: [ d, history ]
  });
  assert.equal((await f.backend.publishBundle({
    ...m,
    route: F.storeRoute()
  })).status, "committed");
  const r = await f.backend.readCanonical({
    handle: Object.freeze({}),
    route: F.storeRoute(),
    scope: "scope-a"
  });
  const chunk = await f.backend.readCompanion({
    lease: r.sourceToken,
    logicalId: "raw-1",
    offset: 0,
    maxBytes: 2
  });
  assert.deepEqual(Buffer.from(chunk.bytes), Buffer.from("ab"));
  assert.equal(chunk.nextOffset, 2);
});

test("wm_acquire_digest_is_bound_to_actual_sqlite_pin_and_manifest", async t => {
  const f = fixture(t);
  await initialized(f);
  const a = await f.backend.acquire("scope-a"), db = path.join(f.root, "stores/wm/wm.sqlite"), g = F.sqliteRead(db, "SELECT manifest_json FROM generations WHERE generation_id=?", a.head.generationId)[0], pin = F.sqliteRead(db, "SELECT lease_json FROM pins WHERE pin_id=?", a.lease.pinId)[0];
  assert.equal(JSON.parse(g.manifest_json).manifestDigest, a.manifestDigest);
  assert.equal(JSON.parse(pin.lease_json).manifestDigest, a.manifestDigest);
  assert.equal(await C.manifestDigest(JSON.parse(g.manifest_json)), a.manifestDigest);
});

test("wm_corrupted_generation_never_returns_mixed_digest_head", async t => {
  const f = fixture(t);
  await initialized(f);
  const db = path.join(f.root, "stores/wm/wm.sqlite");
  F.sqliteMutate(db, s => {
    s.exec("DROP TRIGGER generations_immutable_update");
    s.prepare("UPDATE generations SET manifest_digest=?").run("0".repeat(64));
  });
  assert.equal((await f.backend.readCanonical({
    handle: Object.freeze({}),
    route: F.storeRoute(),
    scope: "scope-a"
  })).ok, false);
});

test("wm_router_real_adapter_canonical_raw_history_and_companions", async t => {
  const f = fixture(t), router = R.createWmStorageRouter({
    routeStore: {
      async read() {
        return F.storeRoute();
      },
      async readReceipt() {
        return null;
      }
    },
    localBackend: {
      readCanonical() {
        throw Error("local forbidden");
      }
    },
    serverBackend: () => f.backend,
    journal: f.journal,
    hostGate: require('./wm-host-gate-fixture.cjs').fixture({initialRoute:F.storeRoute()}).gate
  }), handle = await router.openRequest(), initial = await router.initializeScope({
    handle: handle,
    scope: "scope-a",
    operationId: "router-real-init",
    expectedEmpty: true
  });
  assert.equal(initial.ok, true);
  const bytes = new Uint8Array(Buffer.from("abc")), d = F.item(), record = F.inventoryWrite({
    operationId: "router-raw",
    items: [ {
      descriptor: d,
      payload: bytes
    } ]
  });
  assert.equal((await router.appendRaw({
    handle: handle,
    record: record
  })).status, "committed");
  const w = F.storeWrite(initial.head, {
    operationId: "router-real-write",
    items: [ d ]
  });
  assert.equal((await router.publishBundle({
    handle: handle,
    scope: w.scope,
    expectedHead: w.expectedHead,
    manifest: w.manifest,
    operation: w.operation,
    operationId: w.operationId,
    raw: w.raw
  })).status, "committed");
  const next = await router.openRequest(), r = await router.readCanonical({
    handle: next,
    scope: "scope-a"
  });
  assert.equal(r.raw, w.raw);
  const c = await router.readCompanion({
    handle: next,
    lease: r.sourceToken,
    logicalId: "raw-1",
    offset: 0,
    maxBytes: 3
  });
  assert.equal(Buffer.from(c.bytes).toString(), "abc");
  await router.closeRequest(handle);
  await router.closeRequest(next);
});

test("wm_source_runtime_server_unavailable_preserves_host_originals", async t => {
  assert.ok(process.env.WM_B2_BUILD_ROOT, "checkpoint source Full/Min build root is required for this test");
  const {runtime: runtime, request: request} = require("./integration-runtime.cjs");
  for (const profile of [ "Full", "Min" ]) {
    const f = fixture(t);
    await initialized(f);
    f.state.mutate = p => ({
      ...p,
      incarnation: "foreign"
    });
    const provider = {
      ...f.backend,
      __testJournal: f.journal
    };
    const r = await runtime(provider, {
      dist: process.env.WM_B2_BUILD_ROOT + "/" + profile + "/LIBRA_World_Manager.js",
      transformCode(code) {
        return code.replace("snapshotAuthority: globalThis.__SNAPSHOT_PROVIDER__", "snapshotAuthority: globalThis.__SNAPSHOT_PROVIDER__, operationJournal: globalThis.__SNAPSHOT_PROVIDER__.__testJournal");
      }
    });
    let writes = 0, success = 0;
    for (const name of [ "setChatToIndex", "setCharacter" ]) if (typeof r.host[name] === "function") r.host[name] = async () => {
      writes++;
      return true;
    };
    for (const name of [ "showAlert", "alert" ]) if (typeof r.host[name] === "function") r.host[name] = async () => {
      success++;
    };
    const original = JSON.stringify(r.chat.message), out = await r.api.libraBeforeRequestReplacer(request(), "model");
    assert.equal(JSON.stringify(r.chat.message), original);
    assert.equal(writes, 0);
    assert.equal(success, 0);
    assert.equal(JSON.stringify(out).includes("Historical reference;"), false);
    assert.equal(r.state.calls.length, 0);
  }
});

test("wm_adapter_rejects_outer_accessors_without_running_them", async t => {
  const f = fixture(t), h = await initialized(f);
  let getters = 0;
  const raw = {};
  Object.defineProperty(raw, "record", {
    enumerable: true,
    get() {
      getters++;
      return null;
    }
  });
  const write = {};
  Object.defineProperty(write, "operationId", {
    enumerable: true,
    get() {
      getters++;
      return "forged";
    }
  });
  const read = {};
  Object.defineProperty(read, "scope", {
    enumerable: true,
    get() {
      getters++;
      return "scope-a";
    }
  });
  const before = f.calls.length;
  assert.equal((await f.backend.appendRaw(raw)).ok, false);
  assert.equal((await f.backend.publishBundle(write)).ok, false);
  assert.equal((await f.backend.readCanonical(read)).ok, false);
  assert.equal(getters, 0);
  assert.equal(f.calls.length, before);
});

for (const [name, field] of [ [ "initializeScope", "operationId" ], [ "current", "handle" ], [ "closeRequest", "handle" ], [ "readCompanion", "lease" ], [ "updateRawHistory", "history" ], [ "observeHeads", "leases" ] ]) test("wm_adapter_plain_frame_" + name, async t => {
  const f = fixture(t);
  await initialized(f);
  let getters = 0;
  const v = {};
  Object.defineProperty(v, field, {
    enumerable: true,
    get() {
      getters++;
      return {};
    }
  });
  const before = f.calls.length;
  try {
    await (name === "observeHeads" ? f.backend[name]([ "scope-a" ], v) : f.backend[name](v));
  } catch {}
  assert.equal(getters, 0);
  assert.equal(f.calls.length, before);
});
