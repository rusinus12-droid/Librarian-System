"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), crypto = require("node:crypto");

const F = require("../../tests/helpers/wm-fixture.cjs"), C = require("../src/wm-storage-contracts.source.js");

const load = file => fs.existsSync(__dirname + "/../src/" + file) ? require("../src/" + file) : {};

const R = load("wm-storage-router.source.js"), N = load("wm-native-storage.source.js");

function store() {
  const data = new Map;
  return {
    data: data,
    async getItem(k) {
      return data.get(k) ?? null;
    },
    async setItem(k, v) {
      data.set(k, v);
    }
  };
}

function journal(s = store()) {
  assert.equal(typeof R.createWmOperationJournal, "function", "durable WM metadata journal is required");
  return R.createWmOperationJournal({
    storage: s
  });
}

function fixture(mode = "plugin_only", opts = {}) {
  assert.equal(typeof R.createWmStorageRouter, "function", "createWmStorageRouter is required");
  let route = {
    ...F.route(),
    mode: mode,
    backendId: mode === "plugin_only" ? "native-a" : "server-a"
  }, h = F.head();
  const calls = {
    local: 0,
    server: 0,
    mutations: 0,
    ui: 0
  }, j = opts.journal || journal();
  function backend(name) {
    return {
      async readCanonical() {
        calls[name]++;
        return {
          ok: true,
          raw: null,
          head: h,
          manifestDigest: F.sha("manifest")
        };
      },
      async current() {
        return {
          ok: true
        };
      },
      async publishBundle(v) {
        calls[name]++;
        calls.mutations++;
        return {
          status: "committed",
          operationId: v.operationId,
          requestFingerprint: await C.fingerprintRequest(v),
          receipt: {
            head: h
          }
        };
      },
      async initializeScope(v) {
        calls[name]++;
        return {
          ok: true,
          raw: null,
          head: h,
          manifestDigest: F.sha("initial")
        };
      },
      async appendRaw(v) {
        calls[name]++;
        return {
          status: "committed",
          operationId: v.record.operationId,
          requestFingerprint: F.sha("raw")
        };
      },
      async updateRawHistory() {
        calls[name]++;
        return {
          status: "committed",
          operationId: "history",
          requestFingerprint: F.sha("history")
        };
      },
      async readCompanion() {
        calls[name]++;
        return {
          bytes: new Uint8Array([ 1 ]),
          offset: 0,
          nextOffset: null,
          totalBytes: 1,
          sha256: F.sha(Buffer.from([ 1 ]))
        };
      },
      async closeRequest() {
        return {
          ok: true
        };
      }
    };
  }
  const local = backend("local"), server = opts.server || backend("server");
  const router = R.createWmStorageRouter({
    routeStore: {
      async read() {
        return route;
      },
      async readReceipt() {
        return null;
      }
    },
    localBackend: local,
    serverBackend: () => server,
    journal: j,
    hostGate: require('./wm-host-gate-fixture.cjs').fixture({initialRoute:route}).gate
  });
  return {
    router: router,
    calls: calls,
    j: j,
    local: local,
    server: server,
    route: () => route,
    drift() {
      route = {
        ...route,
        routeGeneration: "route-2"
      };
    },
    h: h
  };
}

function input(f, handle) {
  const w = F.storeWrite(f.h, {
    operationId: "router-write"
  });
  return {
    handle: handle,
    scope: w.scope,
    expectedHead: w.expectedHead,
    manifest: w.manifest,
    operation: w.operation,
    operationId: w.operationId,
    raw: w.raw
  };
}

test("wm_plugin_only_never_contacts_server", async () => {
  const f = fixture(), h = await f.router.openRequest(), v = await f.router.readCanonical({
    handle: h,
    scope: "scope-a"
  });
  assert.equal(v.ok, true);
  assert.equal((await f.router.publishBundle(input(f, h))).status, "committed");
  assert.equal(f.calls.server, 0);
  assert.equal(f.calls.local, 2);
});

test("wm_server_only_never_falls_back_to_local", async () => {
  const f = fixture("server_only", {
    server: {
      async readCanonical() {
        throw Error("unavailable private text");
      }
    }
  }), h = await f.router.openRequest(), before = {
    text: "host original"
  };
  const copy = JSON.stringify(before);
  assert.equal((await f.router.readCanonical({
    handle: h,
    scope: "scope-a"
  })).ok, false);
  assert.equal(f.calls.local, 0);
  assert.equal(f.calls.mutations, 0);
  assert.equal(f.calls.ui, 0);
  assert.equal(JSON.stringify(before), copy);
});

test("wm_route_drift_rejects_late_writer", async () => {
  const f = fixture(), h = await f.router.openRequest();
  await f.router.readCanonical({
    handle: h,
    scope: "scope-a"
  });
  f.drift();
  assert.equal((await f.router.publishBundle(input(f, h))).reason, "route_changed");
  assert.equal(f.calls.mutations, 0);
});

test("wm_route_handles_and_source_tokens_are_private", async () => {
  const f = fixture(), h = await f.router.openRequest(), v = await f.router.readCanonical({
    handle: h,
    scope: "scope-a"
  });
  assert.deepEqual(Object.keys(h), []);
  assert.deepEqual(Object.keys(v.sourceToken), []);
  assert.equal((await f.router.current({})).ok, false);
  assert.equal((await f.router.closeRequest(h)).ok, true);
  assert.equal((await f.router.current(h)).ok, false);
  assert.equal((await f.router.validateSource({
    handle: h,
    scope: "scope-a",
    sourceToken: v.sourceToken
  })).ok, false);
});

test("wm_route_drift_during_read_drops_late_canonical", async () => {
  const f = fixture("server_only");
  f.server.readCanonical = async () => {
    f.drift();
    return {
      ok: true,
      raw: "late",
      head: f.h,
      manifestDigest: F.sha("x")
    };
  };
  const h = await f.router.openRequest();
  assert.equal((await f.router.readCanonical({
    handle: h,
    scope: "scope-a"
  })).ok, false);
});

test("wm_router_initialization_is_explicit_and_returns_genuine_head", async () => {
  const f = fixture("server_only"), h = await f.router.openRequest();
  const r = await f.router.initializeScope({
    handle: h,
    scope: "scope-a",
    operationId: "init-explicit",
    expectedEmpty: true
  });
  assert.equal(C.validateHead(r.head).ok, true);
  assert.ok(r.sourceToken);
  assert.equal(f.calls.server, 1);
});

test("wm_router_unknown_input_rejects_without_getter_execution", async () => {
  const f = fixture(), h = await f.router.openRequest();
  let n = 0;
  const v = {
    handle: h
  };
  Object.defineProperty(v, "scope", {
    enumerable: true,
    get() {
      n++;
      return "scope-a";
    }
  });
  assert.equal((await f.router.readCanonical(v)).ok, false);
  assert.equal(n, 0);
  assert.equal(f.calls.local, 0);
});

test("wm_router_final_observation_and_companions_use_selected_backend", async () => {
  const f = fixture("server_only"), h = await f.router.openRequest();
  const read = await f.router.readCanonical({
    handle: h,
    scope: "scope-a"
  });
  assert.equal((await f.router.current(h)).ok, true);
  await f.router.appendRaw({
    handle: h,
    record: {
      operationId: "raw"
    }
  });
  await f.router.updateRawHistory({
    handle: h,
    recordId: "raw",
    history: {
      status: "done"
    }
  });
  await f.router.readCompanion({
    handle: h,
    lease: read.sourceToken,
    logicalId: "raw",
    offset: 0,
    maxBytes: 1
  });
  assert.equal(f.calls.local, 0);
  assert.equal(f.calls.server, 4);
});

test("wm_journal_reload_retains_only_bound_metadata", async () => {
  const s = store(), j = journal(s), route = F.storeRoute(), entry = {
    operationId: "op1",
    requestFingerprint: F.sha("intent"),
    expectedHead: F.head(),
    route: route
  };
  await j.begin(entry);
  await j.settle({
    operationId: "op1",
    status: {
      status: "uncertain",
      operationId: "op1",
      requestFingerprint: entry.requestFingerprint
    }
  });
  const reloaded = journal(s), pending = await reloaded.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operationId, "op1");
  assert.equal(pending[0].requestFingerprint, entry.requestFingerprint);
  assert.equal(JSON.stringify([ ...s.data.values() ]).includes("rawText"), false);
  await assert.rejects(j.begin({
    ...entry,
    requestFingerprint: F.sha("different")
  }));
});

test("wm_journal_rejects_unknown_private_fields_and_fault_before_send", async () => {
  const j = journal();
  await assert.rejects(j.begin({
    operationId: "op",
    requestFingerprint: F.sha("x"),
    expectedHead: F.head(),
    route: F.route(),
    apiKey: "SYNTHETIC"
  }));
  const broken = journal({
    async getItem() {
      throw Error("private");
    },
    async setItem() {}
  });
  await assert.rejects(broken.begin({
    operationId: "op",
    requestFingerprint: F.sha("x"),
    expectedHead: F.head(),
    route: F.route()
  }));
});

test("wm_native_backend_preserves_native_semantics_without_atomic_advertisement", async () => {
  assert.equal(typeof N.createWmNativeBackend, "function", "native facade required");
  let writes = 0;
  const backend = N.createWmNativeBackend({
    storage: {
      async readCanonical() {
        return {
          ok: true,
          raw: "native",
          head: null,
          manifestDigest: null
        };
      },
      async publishBundle() {
        writes++;
        return {
          status: "committed",
          operationId: "native",
          requestFingerprint: F.sha("n")
        };
      }
    },
    inventory: {},
    journal: journal()
  });
  assert.equal(backend.describe().capabilities.includes("atomic_expected_head_publish"), false);
  assert.equal((await backend.readCanonical({
    scope: "scope-a"
  })).raw, "native");
  await backend.publishBundle({
    operationId: "native"
  });
  assert.equal(writes, 1);
});

test("wm_build_installs_backend_and_inventory_seam_once", async () => {
  const {code: code} = await require("./build-portable.cjs").assemblePortableSource();
  for (const name of [ "WmStorageContracts", "WmStorageInventory", "WmStorageRouter", "WmNativeStorage", "WmServerStorage" ]) assert.equal(code.split("const " + name + "=").length - 1 + code.split("const " + name + " =").length - 1, 1, name + " must be installed once");
  new (require("node:vm").Script)(code);
});

test("wm_router_companion_requires_request_owned_source_token", async () => {
  const f = fixture("server_only"), h = await f.router.openRequest(), read = await f.router.readCanonical({
    handle: h,
    scope: "scope-a"
  });
  const other = await f.router.openRequest();
  assert.equal((await f.router.readCompanion({
    handle: other,
    lease: read.sourceToken,
    logicalId: "raw",
    offset: 0,
    maxBytes: 1
  })).ok, false);
  assert.equal((await f.router.readCompanion({
    handle: h,
    lease: {},
    logicalId: "raw",
    offset: 0,
    maxBytes: 1
  })).ok, false);
});

test("wm_journal_never_overwrites_corrupt_or_private_persisted_entries", async () => {
  const s = store();
  s.data.set("wm.operation-journal.v1", JSON.stringify({
    schema: "wm.operation-journal.v1",
    entries: [ {
      operationId: "op",
      requestFingerprint: F.sha("x"),
      expectedHead: F.head(),
      route: F.route(),
      status: "uncertain",
      apiKey: "SYNTHETIC"
    } ]
  }));
  const before = s.data.get("wm.operation-journal.v1");
  await assert.rejects(journal(s).pending());
  assert.equal(s.data.get("wm.operation-journal.v1"), before);
});

test("wm_router_rejects_nonplain_outer_request_prototype", async () => {
  const f = fixture(), handle = await f.router.openRequest(), input = Object.assign(Object.create({
    foreign: true
  }), {
    handle: handle,
    scope: "scope-a"
  });
  assert.equal((await f.router.readCanonical(input)).ok, false);
  assert.equal(f.calls.local, 0);
});

test("wm_router_inventory_rejects_nonplain_rows_and_owns_intrinsic_bytes", async () => {
  const d = F.item(), payload = new Uint8Array(Buffer.from("abc")), v = F.inventoryWrite({
    items: [ {
      descriptor: d,
      payload: payload
    } ]
  });
  const row = v.items[0];
  v.items[0] = Object.assign(Object.create({
    foreign: true
  }), row);
  assert.throws(() => R.copyInventory(v));
  const valid = F.inventoryWrite({
    items: [ row ]
  });
  let observed = 0;
  Object.defineProperty(payload, "byteLength", {
    get() {
      observed++;
      return 0;
    }
  });
  Object.defineProperty(payload, "subarray", {
    get() {
      observed++;
      throw Error("spoof");
    }
  });
  assert.equal(R.copyInventory(valid).items[0].payload.length, 3);
  assert.equal(observed, 0);
});

async function nativeFixture(options = {}) {
  const scope = "scope-a", state = {
    raw: JSON.stringify({
      resetGeneration: 7,
      value: "before"
    }),
    resetGeneration: 7,
    fresh: true
  }, calls = {
    writes: 0,
    server: 0
  };
  const storage = {
    describeNativeWriteSupport() {
      return {
        freshContext: true,
        expectedRaw: true,
        readback: true,
        resetBinding: true,
        writers: [ "normal", "verified" ]
      };
    },
    async readCanonical() {
      return {
        ok: true,
        raw: state.raw,
        head: null,
        manifestDigest: null,
        resetGeneration: state.resetGeneration
      };
    },
    async publishLegacy(v) {
      if (!state.fresh || v.expectedRaw !== state.raw || v.expectedResetGeneration !== state.resetGeneration) return {
        ok: false,
        reason: "native_source_changed"
      };
      calls.writes++;
      state.raw = options.badReadback ? "wrong-readback" : v.raw;
      return {
        ok: true
      };
    }
  };
  if (options.unsupported) delete storage.describeNativeWriteSupport;
  const native = N.createWmNativeBackend({
    storage: storage,
    inventory: {},
    journal: journal()
  }), router = R.createWmStorageRouter({
    routeStore: {
      async read() {
        return F.route();
      },
      async readReceipt() {
        return null;
      }
    },
    localBackend: native,
    serverBackend() {
      calls.server++;
      throw Error("server forbidden");
    },
    journal: journal(),
    hostGate: {
      async check() {
        return {
          ok: true
        };
      }
    }
  }), handle = await router.openRequest(), read = await router.readCanonical({
    handle: handle,
    scope: scope
  });
  return {
    state: state,
    calls: calls,
    router: router,
    handle: handle,
    read: read,
    input: {
      backend: "native_legacy",
      handle: handle,
      scope: scope,
      sourceToken: read.sourceToken,
      expectedRawSha256: F.sha(state.raw),
      expectedResetGeneration: 7,
      raw: JSON.stringify({
        resetGeneration: 7,
        value: "after"
      }),
      operation: "normal",
      operationId: "native-legacy-write"
    }
  };
}

test("wm_native_legacy_preserves_existing_conditional_write_without_fake_head", async () => {
  const f = await nativeFixture(), r = await f.router.publishBundle(f.input);
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.durableReceipt, false);
  assert.equal(f.read.head, null);
  assert.equal(f.calls.writes, 1);
  assert.equal(f.calls.server, 0);
});

test("wm_native_legacy_stale_source_and_forged_or_cross_request_tokens_reject", async () => {
  for (const fault of [ "raw", "reset", "forged", "foreign", "context" ]) {
    const f = await nativeFixture();
    if (fault === "raw") f.state.raw = "changed";
    if (fault === "reset") f.state.resetGeneration++;
    if (fault === "forged") f.input.sourceToken = {};
    if (fault === "foreign") f.input.handle = await f.router.openRequest();
    if (fault === "context") f.state.fresh = false;
    assert.equal((await f.router.publishBundle(f.input)).ok, false, fault);
    assert.equal(f.calls.writes, 0, fault);
    assert.equal(f.calls.server, 0);
  }
});

test("wm_native_legacy_unsupported_or_unconfirmed_readback_never_claims_success", async () => {
  for (const options of [ {
    unsupported: true
  }, {
    badReadback: true
  } ]) {
    const f = await nativeFixture(options), r = await f.router.publishBundle(f.input);
    assert.equal(r.ok, false);
    assert.equal(f.calls.server, 0);
    if (options.badReadback) {
      assert.equal(r.uncertain, true);
      assert.equal(r.operationId, f.input.operationId);
    } else assert.equal(f.calls.writes, 0);
  }
});
