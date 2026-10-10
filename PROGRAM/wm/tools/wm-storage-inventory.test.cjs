"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");

const s = require("./wm-storage-test-support.cjs");

const sha = b => crypto.createHash("sha256").update(b).digest("hex");

function factory(opts) {
  const f = s.setup(opts);
  assert.equal(f.missing, undefined, "createWmInventory is required");
  return f;
}

async function opened(opts) {
  const f = factory(opts);
  return {
    ...f,
    snapshot: await f.inventory.open({
      fence: f.fence
    })
  };
}

const key = scope => `LIBRA_DATA::v1::${s.stableHash(scope)}`;

test("wm_inventory_includes_unreferenced_raw_and_orphans", async () => {
  const plugin = s.store(), local = s.store();
  const orphan = "char:c1|chat:orphan|persona:default";
  plugin.data.set(key(s.scope), s.canonical(s.scope));
  plugin.data.set(key(orphan), s.canonical(orphan, [ {
    key: "story",
    comment: "lmai_memory",
    content: "secret story"
  } ]));
  const raw = s.rawRecord(s.scope, "done-unreferenced", {
    analysisStatus: "done"
  });
  plugin.data.set(raw.recordKey, JSON.stringify(raw));
  const cold = s.coldRuntime(local), ctx = {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  }, keys = cold.persistentKeys(ctx);
  const shard = s.seal({
    schema: "libra.persistent_memory_shard.v1",
    version: 1,
    id: "cold1",
    scopeHash: keys.namespace.split(":")[2],
    reason: "memory_gc",
    createdAt: 100,
    turnRange: {
      from: 1,
      to: 1
    },
    entryCount: 1,
    entryIds: [ "memory1" ],
    records: [ {
      id: "memory1",
      entry: {
        key: "memory1",
        comment: "lmai_memory",
        content: "device original full cold text"
      }
    } ],
    bytes: 100
  });
  local.data.set(keys.shard("cold1"), JSON.stringify(shard));
  local.data.set(keys.manifest, JSON.stringify(s.seal({
    schema: "libra.persistent_memory_manifest.v1",
    version: 1,
    scopeHash: shard.scopeHash,
    updatedAt: 100,
    shardCount: 1,
    entryCount: 1,
    shards: [ {
      id: "cold1",
      key: keys.shard("cold1"),
      checksum: shard.checksum,
      bytes: 100,
      entryCount: 1,
      entryIds: [ "memory1" ],
      createdAt: 100,
      turnRange: {
        from: 1,
        to: 1
      }
    } ]
  })));
  const f = await opened({
    plugin: plugin,
    local: local,
    scopes: [ ctx, {
      scopeKey: "char:c1|chat:empty|persona:default",
      chatId: "empty",
      characterId: "c1"
    } ]
  });
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  assert.equal(f.snapshot.complete, true);
  assert.equal(items.some(i => i.domain === "raw"), true);
  assert.equal(items.some(i => i.domain === "orphan"), true);
  assert.equal(items.filter(i => i.domain === "canonical").length, 2);
  assert.equal(items.filter(i => i.domain === "cold").length, 2);
  const payload = await s.readAll(f.inventory, f.snapshot.snapshotId, items.find(i => i.domain === "raw"));
  assert.equal(JSON.parse(payload).recordId, "done-unreferenced");
  assert.equal(JSON.parse(payload).assistantText, raw.assistantText);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).complete, true);
  assert.equal(plugin.calls.writes + local.calls.writes, 0);
});

test("wm_inventory_never_exports_execution_authority", async () => {
  const plugin = s.store(), raw = s.rawRecord(s.scope, "raw1", {
    sourceCapture: {
      apiKey: "SYNTHETIC_PRIVATE",
      headers: {
        Authorization: "CAPTURE_TOKEN"
      },
      lease: {
        nonce: "LEASE_TOKEN"
      }
    },
    status: "observed",
    analysisStatus: "done"
  });
  plugin.data.set(raw.recordKey, JSON.stringify(raw));
  plugin.data.set(raw.recordKey + "::status", JSON.stringify({
    version: 1,
    recordKey: raw.recordKey,
    scopeKey: s.scope,
    rawHash: raw.rawHash,
    patch: {
      analysisStatus: "done",
      status: "completed",
      updatedAt: 150,
      sourceCapture: raw.sourceCapture,
      analysisLease: {
        token: "LEASE_TOKEN"
      },
      approval: {
        token: "APPROVAL_TOKEN"
      }
    }
  }));
  plugin.data.set("wm.private-config", JSON.stringify({
    schema: "wm.private-config.v1",
    apiKey: "PRIVATE_CONFIG",
    authHeaders: {
      Authorization: "AUTH_HEADER"
    },
    connectionToken: "CONNECTION"
  }));
  plugin.data.set("wm.execution-capture", JSON.stringify({
    schema: "wm.execution-capture.v1",
    jobId: "job1",
    capture: {
      raw: "PRIVATE_JOB"
    }
  }));
  plugin.data.set("wm.execution-state", JSON.stringify({
    schema: "wm.execution-state.v1",
    jobId: "job1",
    state: "pending",
    lease: {
      nonce: "LEASE"
    },
    approval: {
      allowed: true
    },
    wal: {
      execute: true
    }
  }));
  const f = await opened({
    plugin: plugin
  });
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  const payloads = [];
  for (const i of items) payloads.push((await s.readAll(f.inventory, f.snapshot.snapshotId, i)).toString());
  const all = payloads.join("\n");
  assert.equal(/SYNTHETIC_PRIVATE|CAPTURE_TOKEN|LEASE_TOKEN|APPROVAL_TOKEN|PRIVATE_CONFIG|AUTH_HEADER|CONNECTION|PRIVATE_JOB/.test(all), false);
  assert.match(all, /user secret story/);
  assert.equal(items.some(i => i.domain === "raw_history"), true);
  assert.equal(f.snapshot.complete, true);
  assert.equal(plugin.data.get(raw.recordKey), JSON.stringify(raw));
});

test("wm_unknown_owned_schema_blocks_completeness", async () => {
  const plugin = s.store([ [ "LIBRA_DATA::v1::future", JSON.stringify({
    schema: "wm.future-canonical.v9",
    scopeKey: s.scope
  }) ] ]);
  const f = await opened({
    plugin: plugin
  });
  const v = await f.inventory.verify(f.snapshot.snapshotId);
  assert.equal(v.complete, false);
  assert.equal(v.errors.some(e => e.code === "unknown_owned_schema"), true);
  assert.equal(plugin.data.size, 1);
});

test("wm_missing_cold_shard_blocks_completeness", async () => {
  const local = s.store(), cold = s.coldRuntime(local), keys = cold.persistentKeys({
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  });
  local.data.set(keys.manifest, JSON.stringify(s.seal({
    schema: "libra.persistent_memory_manifest.v1",
    version: 1,
    scopeHash: keys.namespace.split(":")[2],
    updatedAt: 100,
    shardCount: 1,
    entryCount: 1,
    shards: [ {
      id: "missing",
      key: keys.shard("missing"),
      checksum: "x",
      bytes: 100,
      entryCount: 1,
      entryIds: [ "m" ],
      createdAt: 100,
      turnRange: {
        from: 1,
        to: 1
      }
    } ]
  })));
  const f = await opened({
    local: local
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "missing_cold_shard"), true);
});

test("wm_foreign_scope_is_not_resigned", async () => {
  const plugin = s.store([ [ key(s.scope), s.canonical("char:c1|chat:foreign|persona:default") ] ]);
  const f = await opened({
    plugin: plugin
  });
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  assert.equal(f.snapshot.complete, false);
  assert.equal(items.filter(i => i.domain === "canonical").length, 0);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "scope_key_mismatch"), true);
  const mismatch = (await f.inventory.verify(f.snapshot.snapshotId)).errors.find(e => e.code === "scope_key_mismatch");
  assert.deepEqual(Object.keys(mismatch).sort(), [ "code", "domain", "logicalId" ]);
  assert.equal(mismatch.domain, "canonical");
  assert.match(mismatch.logicalId, /^source-[a-f0-9]{64}$/);
});

test("wm_large_unicode_raw_and_cold_chunks_preserve_original_bytes", async () => {
  const plugin = s.store(), local = s.store(), text = "😀한글\0\r\n".repeat(7e5);
  const raw = {
    schema: "wm.raw-turn.v1",
    originScope: s.scope,
    logicalId: "large-raw",
    raw: text,
    provenance: {
      sourceId: "original1",
      observedAt: 100
    }
  };
  const cold = {
    schema: "wm.cold-shard.v1",
    scope: s.scope,
    logicalId: "large-cold",
    raw: text
  };
  plugin.data.set("wm.raw.large", JSON.stringify(raw));
  local.data.set("wm.cold.large", JSON.stringify(cold));
  const f = await opened({
    plugin: plugin,
    local: local
  });
  assert.equal(f.snapshot.complete, true);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  for (const [id, value] of [ [ "large-raw", raw ], [ "large-cold", cold ] ]) {
    const item = items.find(i => i.logicalId === id), expected = Buffer.from(JSON.stringify(value)), out = await s.readAll(f.inventory, f.snapshot.snapshotId, item, 262144);
    assert.deepEqual(out, expected);
    assert.equal(item.sha256, sha(expected));
    assert.equal(item.bytes, expected.length);
  }
});

test("wm_storage_read_and_keys_faults_fail_closed_without_private_errors", async () => {
  for (const fault of [ "keys", "wm.raw.one" ]) {
    const plugin = s.store([ [ "wm.raw.one", JSON.stringify({
      schema: "wm.raw-turn.v1",
      originScope: s.scope,
      logicalId: "one",
      raw: "kept",
      provenance: {
        sourceId: "s",
        observedAt: 1
      }
    }) ] ]);
    plugin.faults.add(fault);
    const f = await opened({
      plugin: plugin
    });
    const v = await f.inventory.verify(f.snapshot.snapshotId);
    assert.equal(v.complete, false);
    assert.equal(/private failure|secret fault/.test(JSON.stringify(v)), false);
    assert.equal(v.errors.length > 0, true);
  }
});

test("wm_known_derived_cache_remains_local_and_is_not_canonical", async () => {
  const plugin = s.store([ [ "wm.derived.one", JSON.stringify({
    schema: "wm.derived-cache.v1",
    scope: s.scope,
    entries: [ {
      raw: "cache"
    } ]
  }) ] ]);
  const f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, true);
  assert.equal((await s.allPages(f.inventory, f.snapshot.snapshotId)).items.some(i => i.domain === "canonical" || i.domain === "raw" || i.domain === "cold"), false);
  assert.equal(plugin.data.size, 1);
});

test("wm_keys_array_cost_and_verification_budgets_are_explicit", async () => {
  const plugin = s.store([ [ "other-plugin-long-key", "x" ] ]);
  const f = await opened({
    plugin: plugin,
    limits: {
      maxKeyListBytes: 3
    }
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "host_key_list_byte_limit"), true);
  assert.equal(f.inventory.capabilities.keysBounded, false);
  const g = await opened({
    plugin: s.store([ [ key(s.scope), s.canonical(s.scope) ], [ "wm.derived.one", JSON.stringify({
      schema: "wm.derived-cache.v1",
      scope: s.scope,
      entries: []
    }) ] ]),
    limits: {
      maxVerificationReads: 1
    }
  });
  assert.equal(g.snapshot.complete, false);
});

test("wm_snapshot_is_immutable_but_source_drift_blocks_verify", async () => {
  const plugin = s.store([ [ key(s.scope), s.canonical(s.scope) ] ]);
  const f = await opened({
    plugin: plugin
  });
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId), before = await s.readAll(f.inventory, f.snapshot.snapshotId, items[0]);
  plugin.data.set(key(s.scope), s.canonical(s.scope, [ {
    key: "n",
    comment: "lmai_memory",
    content: "new"
  } ]));
  assert.deepEqual(await s.readAll(f.inventory, f.snapshot.snapshotId, items[0]), before);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).complete, false);
});

test("wm_cursor_snapshot_binding_replay_and_exact_page_bytes", async () => {
  const plugin = s.store();
  for (let i = 0; i < 3; i++) plugin.data.set("wm.raw." + i, JSON.stringify({
    schema: "wm.raw-turn.v1",
    originScope: s.scope,
    logicalId: "r" + i,
    raw: "x",
    provenance: {
      sourceId: "s" + i,
      observedAt: 1
    }
  }));
  const f = await opened({
    plugin: plugin
  }), g = await f.inventory.open({
    fence: f.fence
  });
  const p = await f.inventory.page({
    snapshotId: f.snapshot.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 2048
  });
  assert.ok(p.nextCursor);
  await assert.rejects(f.inventory.page({
    snapshotId: g.snapshotId,
    cursor: p.nextCursor,
    maxItems: 1,
    maxBytes: 2048
  }));
  const q = await f.inventory.page({
    snapshotId: f.snapshot.snapshotId,
    cursor: p.nextCursor,
    maxItems: 1,
    maxBytes: 2048
  });
  await assert.rejects(f.inventory.page({
    snapshotId: f.snapshot.snapshotId,
    cursor: p.nextCursor,
    maxItems: 1,
    maxBytes: 2048
  }));
  assert.ok(Buffer.byteLength(s.loadInventory().canonicalJson(q)) <= 2048);
  await assert.rejects(f.inventory.page({
    snapshotId: g.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 1
  }));
  assert.equal((await f.inventory.page({
    snapshotId: g.snapshotId,
    cursor: null,
    maxItems: 1,
    maxBytes: 2048
  })).items.length, 1);
});

test("wm_unknown_raw_provenance_is_preserved_locally_and_blocks", async () => {
  const plugin = s.store(), raw = s.rawRecord(s.scope, "unknown", {
    extraProvenance: {
      newAuthority: "SYNTHETIC"
    }
  });
  plugin.data.set(raw.recordKey, JSON.stringify(raw));
  const f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "unsupported_raw_field"), true);
  assert.equal(plugin.data.get(raw.recordKey), JSON.stringify(raw));
});

test("wm_raw_sidecar_without_receipt_blocks_and_wal_is_inert", async () => {
  const plugin = s.store([ [ s.rawKey(s.scope, "gone") + "::status", JSON.stringify({
    version: 1,
    recordKey: s.rawKey(s.scope, "gone"),
    scopeKey: s.scope,
    rawHash: "x",
    patch: {
      status: "done"
    }
  }) ] ]);
  const f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  const g = await opened({
    plugin: s.store([ [ "wm.execution-state", JSON.stringify({
      schema: "wm.execution-state.v1",
      jobId: "job1",
      state: "pending",
      lease: {
        token: "private"
      },
      approval: {
        yes: true
      },
      wal: {
        work: "run"
      }
    }) ] ])
  });
  assert.equal(g.snapshot.complete, true);
  const {items: items} = await s.allPages(g.inventory, g.snapshot.snapshotId);
  const out = JSON.parse(await s.readAll(g.inventory, g.snapshot.snapshotId, items.find(i => i.domain === "raw_history")));
  assert.equal(out.status, "interrupted");
  assert.equal(out.lease, undefined);
});

test("wm_plain_data_rejects_accessors_before_execution", async () => {
  const f = factory(), request = {
    fence: f.fence
  };
  let gets = 0;
  Object.defineProperty(request, "bad", {
    get() {
      gets++;
      return true;
    },
    enumerable: true
  });
  await assert.rejects(f.inventory.open(request));
  assert.equal(gets, 0);
  const g = await opened();
  await assert.rejects(g.inventory.readChunk({
    snapshotId: g.snapshot.snapshotId,
    logicalId: "none",
    offset: Number.MAX_SAFE_INTEGER + 1,
    maxBytes: 1
  }));
});

test("wm_native_read_wrappers_preserve_strict_keys_and_local_faults", async () => {
  const plugin = s.store([ [ "x", "ok" ] ]), local = s.store([ [ "cold", "raw" ] ]), compat = s.nativeRuntime(plugin, local);
  assert.equal(typeof compat.pluginStorage.keys, "function");
  assert.deepEqual(Array.from(await compat.pluginStorage.keys({
    strict: true
  })), [ "x" ]);
  plugin.faults.add("keys");
  await assert.rejects(compat.pluginStorage.keys({
    strict: true
  }));
  local.faults.add("cold");
  await assert.rejects(compat.localPluginStorage.getItem("cold", {
    strict: true
  }));
  assert.equal(typeof compat.localPluginStorage.keys, "function");
});

test("wm_ledger_and_cold_export_methods_use_frozen_all_domain_context", async () => {
  const plugin = s.store(), raw = s.rawRecord(s.scope, "done", {
    analysisStatus: "done"
  });
  plugin.data.set(raw.recordKey, JSON.stringify(raw));
  const f = await opened({
    plugin: plugin
  });
  const readContext = f.inventory.readContext(f.snapshot.snapshotId), ledger = s.ledgerRuntime(plugin), cold = s.coldRuntime(f.local);
  assert.equal(typeof ledger.exportAllPage, "function");
  const p = await ledger.exportAllPage({
    scope: s.scope,
    cursor: null,
    maxItems: 10,
    readContext: readContext
  });
  assert.equal(p.items.some(i => i.domain === "raw"), true);
  assert.equal(typeof cold.exportVerifiedPage, "function");
  const q = await cold.exportVerifiedPage({
    scope: s.scope,
    cursor: null,
    maxItems: 10,
    readContext: readContext
  });
  assert.equal(q.complete, true);
  assert.equal(plugin.calls.writes, 0);
});

test("wm_actual_ledger_writer_records_publication_and_done_sidecar_export", async () => {
  const plugin = s.store(), ledger = s.ledgerRuntime(plugin);
  const h = await ledger.appendObserved({
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1",
    recordId: "actual",
    userText: "original user",
    assistantText: "actual answer",
    requestSequence: 1
  });
  assert.equal(h.ok, true);
  const done = await ledger.markStatus(h, {
    status: "committed",
    analysisStatus: "done",
    analysisStartedAt: 101,
    analysisFinishedAt: 110,
    analysisTurn: 1,
    analysisError: "SYNTHETIC_CREDENTIAL_IN_ERROR",
    pendingParkToken: "SYNTHETIC_PARK_AUTHORITY"
  });
  assert.equal(done.ok, true);
  const writes = plugin.calls.writes, f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, true);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  assert.equal(items.filter(i => i.domain === "raw").length, 1);
  const payloads = [];
  for (const i of items) payloads.push((await s.readAll(f.inventory, f.snapshot.snapshotId, i)).toString());
  assert.equal(/SYNTHETIC_CREDENTIAL_IN_ERROR|SYNTHETIC_PARK_AUTHORITY/.test(payloads.join()), false);
  assert.equal(payloads.some(p => p.includes("analysisFinishedAt")), true);
  assert.equal(plugin.calls.writes, writes);
});

test("wm_actual_cold_writer_checksum_and_full_body_export", async () => {
  const local = s.store(), cold = s.coldRuntime(local), ctx = {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  };
  const result = await cold.commitPersistentMemoryEntries([ {
    key: "m",
    comment: "lmai_memory",
    content: "full cold secret story 😀".repeat(20),
    mode: "normal",
    insertorder: 100,
    alwaysActive: false,
    memo: "memory"
  } ], ctx);
  assert.equal(result.ok, true);
  local.data.set(result.keys.wal, JSON.stringify({
    schema: "libra.persistent_memory_wal.v1",
    version: 1,
    transactionId: "stopped-partial",
    scopeHash: result.keys.namespace.split(":")[2],
    state: "partial_committed",
    createdAt: 100,
    planned: [],
    committedShardIds: [],
    remainingShardIds: []
  }));
  const f = await opened({
    local: local
  });
  assert.equal(f.snapshot.complete, true);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  assert.equal(items.filter(i => i.domain === "cold").length, 2);
  assert.equal(items.filter(i => i.domain === "raw_history").length, 1);
  const shard = items.find(i => i.schema === "libra.persistent_memory_shard.v1"), bytes = await s.readAll(f.inventory, f.snapshot.snapshotId, shard);
  assert.equal(bytes.toString(), local.data.get(result.keys.shard(result.shards[0].id)));
});

test("wm_corrupt_cold_checksum_and_unknown_owned_family_never_complete", async () => {
  const local = s.store(), cold = s.coldRuntime(local), ctx = {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  };
  await cold.commitPersistentMemoryEntries([ {
    key: "m",
    comment: "lmai_memory",
    content: "full body"
  } ], ctx);
  const shardKey = [ ...local.data.keys() ].find(k => k.includes(":shard:")), v = JSON.parse(local.data.get(shardKey));
  v.records[0].entry.content = "altered";
  local.data.set(shardKey, JSON.stringify(v));
  assert.equal((await opened({
    local: local
  })).snapshot.complete, false);
  const plugin = s.store([ [ "wm.future-family", JSON.stringify({
    schema: "wm.raw-turn.v1",
    originScope: s.scope,
    logicalId: "f",
    raw: "unknown ownership",
    provenance: {
      sourceId: "s",
      observedAt: 1
    }
  }) ] ]);
  assert.equal((await opened({
    plugin: plugin
  })).snapshot.complete, false);
});

test("wm_worldline_node_references_and_native_exact_reads", async () => {
  const plugin = s.store(), v = {
    version: "libra_turn_worldline_v1",
    scopeKey: s.scope,
    revision: 1,
    liveHash: "live",
    headTurnNodeId: "n",
    nodes: [ {
      turnNodeId: "n",
      logicalTurnId: "l",
      variantId: "v",
      parentTurnNodeId: "missing",
      pairIndex: 1,
      originalOrdinal: 1,
      activeOrdinal: 1,
      userHash: "u",
      assistantHash: "a",
      userMessageId: "u1",
      assistantMessageId: "a1",
      status: "active",
      supersededBy: "",
      createdAt: 1,
      updatedAt: 1
    } ],
    updatedAt: 1,
    cutoffTurn: null
  };
  plugin.data.set("LIBRA_WORLDLINE::v1::" + s.stableHash(s.scope), JSON.stringify(v));
  const f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "lineage_reference_missing"), true);
  const methods = s.nativeReadMethods(plugin);
  assert.equal(typeof methods.readInventoryCanonical, "function");
  plugin.data.set(key(s.scope), s.canonical(s.scope));
  assert.equal((await methods.readInventoryCanonical(s.scope)).raw, plugin.data.get(key(s.scope)));
  plugin.faults.add(key(s.scope));
  await assert.rejects(methods.readInventoryCanonical(s.scope));
  plugin.faults.clear();
  v.scopeKey = "foreign";
  plugin.data.set("LIBRA_WORLDLINE::v1::" + s.stableHash(s.scope), JSON.stringify(v));
  await assert.rejects(methods.readInventoryWorldline(s.scope));
});

test("wm_canonical_turn_receipt_capture_and_derived_unknown_schemas_block", async () => {
  for (const entry of [ {
    key: "t",
    comment: "lmai_turn_records",
    content: JSON.stringify({
      version: 1,
      scopeKey: s.scope,
      records: [ {
        sourceReceipt: {
          schema: "wm.prospective-source.v1",
          runtimeLease: {
            nonce: "PRIVATE_RUNTIME_LEASE"
          }
        }
      } ]
    })
  }, {
    key: "d",
    comment: "lmai_projection_typed_recall",
    content: "derived local"
  }, {
    key: "x",
    comment: "lmai_memory_future",
    content: "new schema"
  } ]) {
    const plugin = s.store([ [ key(s.scope), s.canonical(s.scope, [ entry ]) ] ]), f = await opened({
      plugin: plugin
    });
    assert.equal(f.snapshot.complete, false);
    assert.equal((await s.allPages(f.inventory, f.snapshot.snapshotId)).items.some(i => i.domain === "canonical"), false);
  }
});

test("wm_scan_memory_budget_stops_with_incomplete_evidence", async () => {
  const plugin = s.store();
  for (let i = 0; i < 10; i++) plugin.data.set("wm.raw." + i, JSON.stringify({
    schema: "wm.raw-turn.v1",
    originScope: s.scope,
    logicalId: "r" + i,
    raw: "x".repeat(5e3),
    provenance: {
      sourceId: "s" + i,
      observedAt: 1
    }
  }));
  const f = await opened({
    plugin: plugin,
    limits: {
      maxSourceScanBytes: 6e3
    }
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal(plugin.calls.reads <= 2, true);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "source_scan_byte_limit"), true);
});

test("wm_compat_chunks_are_verified_with_root_and_orphans_block", async () => {
  const plugin = s.store(), local = s.store(), compat = s.nativeRuntime(plugin, local), raw = s.canonical(s.scope, [ {
    key: "long",
    comment: "lmai_memory",
    content: "😀 story ".repeat(1e5)
  } ]);
  assert.equal(await compat.pluginStorage.setItem(key(s.scope), raw, {
    strict: true
  }), true);
  const f = await opened({
    plugin: compat.pluginStorage,
    local: compat.localPluginStorage
  });
  assert.equal(f.snapshot.complete, true);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  assert.equal((await s.readAll(f.inventory, f.snapshot.snapshotId, items.find(i => i.domain === "canonical"), 262144)).toString(), raw);
  plugin.data.set(key(s.scope) + "::chunk:v1:unreferenced:0000", "orphan raw");
  const g = await opened({
    plugin: compat.pluginStorage,
    local: compat.localPluginStorage
  });
  assert.equal(g.snapshot.complete, false);
});

test("wm_duplicate_ids_missing_dependencies_and_snapshot_close_fail_closed", async () => {
  const plugin = s.store();
  for (let i = 0; i < 2; i++) plugin.data.set("wm.raw." + i, JSON.stringify({
    schema: "wm.raw-turn.v1",
    originScope: s.scope,
    logicalId: "duplicate",
    raw: "x",
    provenance: {
      sourceId: "s",
      observedAt: 1
    }
  }));
  assert.equal((await opened({
    plugin: plugin
  })).snapshot.complete, false);
  const f = await opened({
    plugin: s.store([ [ "wm.raw-history.one", JSON.stringify({
      schema: "wm.raw-history.v1",
      originScope: s.scope,
      logicalId: "history",
      rawId: "absent",
      status: "failed",
      observedAt: 1
    }) ] ])
  });
  assert.equal(f.snapshot.complete, false);
  await f.inventory.close(f.snapshot.snapshotId);
  await assert.rejects(f.inventory.verify(f.snapshot.snapshotId));
});

test("wm_host_owned_legacy_lore_is_included_without_exporting_host_chat", async () => {
  const source = {
    scopeKey: s.scope,
    sourceIdentity: "fixture-host1",
    revision: "rev1",
    wmLore: [ {
      key: "story",
      comment: "lmai_secret_knowledge",
      content: "the royal secret stays"
    } ],
    lineage: {
      schema: "libra.host.worldline.meta.v1",
      worldlineId: s.scope,
      scopeKey: s.scope,
      parentWorldlineId: "",
      forkTurn: 0,
      forkFingerprint: "",
      createdAt: 1
    }
  }, hostCatalog = {
    async listScopes() {
      return [ {
        scopeKey: s.scope,
        chatId: "chat1",
        characterId: "c1"
      } ];
    },
    async readWmScope() {
      return source;
    }
  };
  const f = await opened({
    hostCatalog: hostCatalog
  });
  assert.equal(f.snapshot.complete, true);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  let found = false;
  for (const item of items) {
    const text = (await s.readAll(f.inventory, f.snapshot.snapshotId, item)).toString();
    if (text.includes("the royal secret stays")) found = true;
    assert.equal(text.includes("personaImage"), false);
  }
  assert.equal(found, true);
  assert.equal(items.some(i => i.domain === "lineage"), true);
});

test("wm_missing_faulting_foreign_or_mutated_host_scope_closes_gate", async () => {
  const catalog = [ {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  } ];
  for (const adapter of [ null, async () => {
    throw Error("PRIVATE_HOST_FAULT");
  }, async () => ({
    scopeKey: "foreign",
    sourceIdentity: "h",
    revision: "r",
    wmLore: [],
    lineage: null
  }) ]) {
    const f = await opened({
      hostCatalog: {
        async listScopes() {
          return catalog;
        },
        ...adapter ? {
          readWmScope: adapter
        } : {}
      }
    });
    assert.equal(f.snapshot.complete, false);
    assert.equal(/PRIVATE_HOST_FAULT/.test(JSON.stringify(await f.inventory.verify(f.snapshot.snapshotId))), false);
  }
  let revision = 0;
  const f = await opened({
    hostCatalog: {
      async listScopes() {
        return catalog;
      },
      async readWmScope() {
        return {
          scopeKey: s.scope,
          sourceIdentity: "h",
          revision: "r" + revision++,
          wmLore: [],
          lineage: null
        };
      }
    }
  });
  assert.equal(f.snapshot.complete, false);
});

test("wm_host_scope_unknown_capture_fields_and_foreign_lore_block", async () => {
  for (const wmLore of [ [ {
    key: "foreign",
    comment: "other_plugin_memory",
    content: "foreign"
  } ], [ {
    key: "a",
    comment: "lmai_memory",
    content: "story",
    privateCapture: {
      apiKey: "PRIVATE_CAPTURE"
    }
  } ] ]) {
    const f = await opened({
      hostCatalog: {
        async listScopes() {
          return [ {
            scopeKey: s.scope,
            chatId: "chat1",
            characterId: "c1"
          } ];
        },
        async readWmScope() {
          return {
            scopeKey: s.scope,
            sourceIdentity: "h",
            revision: "r1",
            wmLore: wmLore,
            lineage: null
          };
        }
      }
    });
    assert.equal(f.snapshot.complete, false);
    assert.equal((await s.allPages(f.inventory, f.snapshot.snapshotId)).items.some(i => i.logicalId.startsWith("host-lore-")), false);
  }
});

test("wm_nested_raw_identity_and_cold_range_authority_fields_block_without_export", async () => {
  const plugin = s.store(), raw = s.rawRecord(s.scope, "nested", {
    requestId: {
      apiKey: "NESTED_PRIVATE"
    }
  });
  plugin.data.set(raw.recordKey, JSON.stringify(raw));
  const f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  for (const i of items) assert.equal((await s.readAll(f.inventory, f.snapshot.snapshotId, i)).toString().includes("NESTED_PRIVATE"), false);
  const local = s.store(), cold = s.coldRuntime(local), ctx = {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  };
  const result = await cold.commitPersistentMemoryEntries([ {
    key: "m",
    comment: "lmai_memory",
    content: "original"
  } ], ctx);
  const k = result.keys.shard(result.shards[0].id), v = JSON.parse(local.data.get(k));
  v.turnRange = {
    from: 1,
    to: 2,
    apiKey: "NESTED_COLD_PRIVATE"
  };
  delete v.checksum;
  local.data.set(k, JSON.stringify(s.seal(v)));
  const g = await opened({
    local: local
  });
  assert.equal(g.snapshot.complete, false);
  const out = await s.allPages(g.inventory, g.snapshot.snapshotId);
  for (const i of out.items) assert.equal((await s.readAll(g.inventory, g.snapshot.snapshotId, i)).toString().includes("NESTED_COLD_PRIVATE"), false);
});

test("wm_parent_scope_lineage_closure_and_legacy_key_family_gate", async () => {
  const plugin = s.store([ [ "wm.lineage.one", JSON.stringify({
    schema: "wm.lineage.v1",
    scope: s.scope,
    parentScope: "char:c1|chat:missing|persona:default",
    continuationOf: null
  }) ] ]);
  assert.equal((await opened({
    plugin: plugin
  })).snapshot.complete, false);
  const g = await opened({
    plugin: s.store([ [ "LMAI_FutureMemory", JSON.stringify({
      schema: "future-memory",
      raw: "preserve"
    }) ] ])
  });
  assert.equal(g.snapshot.complete, false);
  const f = await opened({
    plugin: s.store([ [ "LMAI_Config", "PRIVATE_CONFIG_RAW" ], [ "LMAI_DebugRecent_v2::known", JSON.stringify({
      schema: "libra.debug.plugin-storage.v1",
      turns: [ {
        capture: "PRIVATE_CAPTURE"
      } ]
    }) ] ])
  });
  assert.equal(f.snapshot.complete, true);
  for (const i of (await s.allPages(f.inventory, f.snapshot.snapshotId)).items) assert.equal(/PRIVATE_CONFIG_RAW|PRIVATE_CAPTURE/.test((await s.readAll(f.inventory, f.snapshot.snapshotId, i)).toString()), false);
});

test("wm_open_detects_source_change_during_host_read_before_complete", async () => {
  const plugin = s.store([ [ key(s.scope), s.canonical(s.scope) ] ]);
  let n = 0;
  const f = await opened({
    plugin: plugin,
    hostCatalog: {
      async listScopes() {
        return [ {
          scopeKey: s.scope,
          chatId: "chat1",
          characterId: "c1"
        } ];
      },
      async readWmScope() {
        if (n++ === 0) plugin.data.set(key(s.scope), s.canonical(s.scope, [ {
          key: "n",
          comment: "lmai_memory",
          content: "changed during scan"
        } ]));
        return {
          scopeKey: s.scope,
          sourceIdentity: "h",
          revision: "r1",
          wmLore: [],
          lineage: null
        };
      }
    }
  });
  assert.equal(f.snapshot.complete, false);
});

test("wm_export_context_cannot_be_forged_or_reused_after_close", async () => {
  const ledger = s.ledgerRuntime(s.store()), cold = s.coldRuntime(s.store()), fake = {
    snapshotId: "fake",
    exportDomainPage: async () => ({
      complete: true,
      items: [],
      errors: []
    })
  };
  await assert.rejects(ledger.exportAllPage({
    scope: s.scope,
    cursor: null,
    maxItems: 1,
    readContext: fake
  }));
  await assert.rejects(cold.exportVerifiedPage({
    scope: s.scope,
    cursor: null,
    maxItems: 1,
    readContext: fake
  }));
  const f = await opened(), context = f.inventory.readContext(f.snapshot.snapshotId);
  await f.inventory.close(f.snapshot.snapshotId);
  await assert.rejects(ledger.exportAllPage({
    scope: s.scope,
    cursor: null,
    maxItems: 1,
    readContext: context
  }));
});

test("wm_native_snapshot_order_matches_a3_utf8_binary_and_validator", async () => {
  const plugin = s.store(), scopes = [ "char:c|chat:|persona:default", "char:c|chat:😀|persona:default" ];
  for (const scope of scopes) plugin.data.set(key(scope), s.canonical(scope));
  const f = await opened({
    plugin: plugin,
    scopes: scopes.map(scopeKey => ({
      scopeKey: scopeKey,
      characterId: "c",
      chatId: scopeKey.split("|")[1].slice(5)
    }))
  }), {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId);
  const canonical = items.filter(i => i.domain === "canonical");
  assert.deepEqual(canonical.map(i => i.originScope), scopes.slice().sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const expected = sha(Buffer.from("wm.inventory-snapshot.v1\n" + items.map(i => s.loadInventory().canonicalJson(i) + "\n").join("")));
  assert.equal(f.snapshot.inventoryDigest, expected);
  const a3 = require("../../server/wm/pins.cjs");
  for (const item of items) assert.equal(a3.validateInventoryItem(item).ok, true);
  for (const change of [ {
    logicalId: ""
  }, {
    sha256: "g".repeat(64)
  }, {
    originScope: "bad\n"
  } ]) {
    const item = {
      ...canonical[0],
      ...change
    };
    assert.equal(s.loadInventory().validateInventoryItem(item).ok, a3.validateInventoryItem(item).ok);
  }
});

test("wm_concurrent_open_is_serial_admitted_and_source_snapshot_limits_close", async () => {
  const f = factory({
    limits: {
      maxSnapshots: 1
    }
  });
  const results = await Promise.allSettled([ f.inventory.open({
    fence: f.fence
  }), f.inventory.open({
    fence: f.fence
  }) ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const snapshot = results.find(r => r.status === "fulfilled").value;
  await f.inventory.close(snapshot.snapshotId);
  assert.equal((await f.inventory.open({
    fence: f.fence
  })).complete, true);
});

test("wm_native_plain_prototypes_and_browser_snapshot_parity", async () => {
  const f = factory(), custom = Object.assign(Object.create(Object.create(null)), {
    fence: f.fence
  });
  await assert.rejects(f.inventory.open(custom));
  const scopes = [];
  Object.setPrototypeOf(scopes, {
    length: 0
  });
  const g = await opened({
    hostCatalog: {
      async listScopes() {
        return scopes;
      },
      async readWmScope() {
        throw Error("unused");
      }
    }
  });
  assert.equal(g.snapshot.complete, false);
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path"), source = fs.readFileSync(path.join(s.root, "src/wm-storage-contracts.source.js"), "utf8") + "\n" + fs.readFileSync(path.join(s.root, "src/wm-storage-inventory.source.js"), "utf8") + "\nWmStorageInventory;";
  const web = vm.runInNewContext(source, {
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Uint8Array: Uint8Array,
    Uint32Array: Uint32Array,
    DataView: DataView,
    crypto: crypto.webcrypto
  });
  const plugin = s.store([ [ key(s.scope), s.canonical(s.scope) ] ]), hostCatalog = {
    async listScopes() {
      return [ {
        scopeKey: s.scope,
        chatId: "chat1",
        characterId: "c1"
      } ];
    },
    async readWmScope() {
      return {
        scopeKey: s.scope,
        sourceIdentity: "fixture-host1",
        revision: "rev1",
        wmLore: [],
        lineage: null
      };
    }
  };
  const browser = web.createWmInventory({
    nativeStores: {
      plugin: plugin,
      local: s.store()
    },
    hostCatalog: hostCatalog,
    classify: s.contracts.classifyOwnedRecord
  }), node = s.loadInventory().createWmInventory({
    nativeStores: {
      plugin: plugin,
      local: s.store()
    },
    hostCatalog: hostCatalog,
    classify: s.contracts.classifyOwnedRecord
  }), b = await browser.open({
    fence: f.fence
  }), n = await node.open({
    fence: f.fence
  });
  assert.equal(b.complete, true);
  assert.equal(n.inventoryDigest, b.inventoryDigest);
  const {items: items} = await s.allPages(browser, b.snapshotId);
  for (const i of items) {
    assert.equal(web.validateInventoryItem(i).ok, true);
    assert.equal(sha(await s.readAll(browser, b.snapshotId, i)), i.sha256);
  }
});

test("wm_domain_export_rejects_outer_accessors_before_getter_runs", async () => {
  let gets = 0;
  const f = await opened(), input = {
    scope: s.scope,
    cursor: null,
    maxItems: 1,
    readContext: f.inventory.readContext(f.snapshot.snapshotId)
  };
  Object.defineProperty(input, "scope", {
    enumerable: true,
    get() {
      gets++;
      return s.scope;
    }
  });
  for (const obj of [ s.ledgerRuntime(s.store()), s.coldRuntime(s.store()) ]) await assert.rejects((obj.exportAllPage || obj.exportVerifiedPage)(input));
  assert.equal(gets, 0);
});

test("wm_unknown_schema_cannot_turn_unverified_scope_fields_into_exported_provenance", async () => {
  const plugin = s.store([ [ "wm.future", JSON.stringify({
    schema: "wm.future.v99",
    scope: "SYNTHETIC_SCOPE_CREDENTIAL",
    apiKey: "PRIVATE"
  }) ] ]), f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  for (const item of (await s.allPages(f.inventory, f.snapshot.snapshotId)).items) assert.equal((await s.readAll(f.inventory, f.snapshot.snapshotId, item)).toString().includes("SYNTHETIC_SCOPE_CREDENTIAL"), false);
});

test("wm_unknown_key_family_and_scope_budget_do_not_export_unverified_scopes", async () => {
  const f = await opened({
    plugin: s.store([ [ "wm.future-family", JSON.stringify({
      schema: "wm.raw-turn.v1",
      originScope: "SYNTHETIC_SCOPE_AUTHORITY",
      logicalId: "r",
      raw: "story",
      provenance: {
        sourceId: "s",
        observedAt: 1
      }
    }) ] ])
  });
  assert.equal(f.snapshot.complete, false);
  for (const i of (await s.allPages(f.inventory, f.snapshot.snapshotId)).items) assert.equal(i.originScope === "SYNTHETIC_SCOPE_AUTHORITY", false);
  const plugin = s.store();
  const other = "char:c1|chat:extra|persona:default";
  plugin.data.set(key(other), s.canonical(other));
  const g = await opened({
    plugin: plugin,
    limits: {
      maxScopes: 1
    }
  });
  assert.equal(g.snapshot.complete, false);
  assert.equal(g.snapshot.domainCounts.canonical, 0);
});

test("wm_finalized_turn_receipt_requires_original_raw_dependency", async () => {
  const receipt = {
    schema: "wm.prospective-source.v1",
    state: "bound",
    requestId: "r1",
    canonicalScope: s.scope,
    characterId: "c1",
    chatId: "chat1",
    resetGeneration: 0,
    userIds: [ "u" ],
    assistantIds: [ "a" ],
    originMessageCount: 1,
    bindingAuthority: "registered_request_and_accepted_host_response",
    analysisEligible: false,
    replacementEligible: false,
    reason: "derived_attribution_unproven"
  };
  const entry = {
    key: "turns",
    comment: "lmai_turn_records",
    content: JSON.stringify({
      version: 1,
      scopeKey: s.scope,
      records: [ {
        sourceReceipt: receipt
      } ]
    })
  };
  const plugin = s.store([ [ key(s.scope), s.canonical(s.scope, [ entry ]) ] ]);
  assert.equal((await opened({
    plugin: plugin
  })).snapshot.complete, false);
  const raw = s.rawRecord(s.scope, "r1");
  plugin.data.set(raw.recordKey, JSON.stringify(raw));
  const f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, true);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId), canonical = items.find(i => i.domain === "canonical"), original = items.find(i => i.domain === "raw");
  assert.equal(canonical.dependencies.includes(original.logicalId), true);
});

test("wm_legacy_hashed_scope_collision_blocks_ownership_completeness", async () => {
  const a = "char:c|chat:Aa|persona:default", b = "char:c|chat:BB|persona:default";
  assert.equal(s.stableHash(a), s.stableHash(b));
  const f = await opened({
    plugin: s.store([ [ key(a), s.canonical(b) ] ]),
    scopes: [ {
      scopeKey: a,
      characterId: "c",
      chatId: "Aa"
    }, {
      scopeKey: b,
      characterId: "c",
      chatId: "BB"
    } ]
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "scope_hash_collision"), true);
});

test("wm_open_detects_scope_catalog_change_during_capture", async () => {
  const scopes = [ {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  } ];
  const f = await opened({
    hostCatalog: {
      async listScopes() {
        return scopes;
      },
      async readWmScope(scopeKey) {
        if (scopes.length === 1) scopes.push({
          scopeKey: "char:c1|chat:new|persona:default",
          characterId: "c1",
          chatId: "new"
        });
        return {
          scopeKey: scopeKey,
          sourceIdentity: "h" + scopeKey,
          revision: "r1",
          wmLore: [],
          lineage: null
        };
      }
    }
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "host_catalog_drift"), true);
});

// Independent B1 review round 1: source-grounded counterexamples, no live host.
function r1Receipt(extra = {}) {
  return {
    schema: "wm.prospective-source.v1",
    state: "bound",
    requestId: "r1",
    canonicalScope: s.scope,
    characterId: "c1",
    chatId: "chat1",
    resetGeneration: 0,
    userIds: [ "u" ],
    assistantIds: [ "a" ],
    originMessageCount: 1,
    bindingAuthority: "registered_request_and_accepted_host_response",
    analysisEligible: false,
    replacementEligible: false,
    reason: "derived_attribution_unproven",
    ...extra
  };
}

function r1Turns(receipt, extra = {}) {
  return {
    key: "turns",
    comment: "lmai_turn_records",
    content: JSON.stringify({
      version: 1,
      scopeKey: s.scope,
      updatedAt: 1,
      records: receipt ? [ {
        sourceReceipt: receipt
      } ] : [],
      ...extra
    })
  };
}

function r1Host(wmLore, lineage = null) {
  return {
    async listScopes() {
      return [ {
        scopeKey: s.scope,
        chatId: "chat1",
        characterId: "c1"
      } ];
    },
    async readWmScope() {
      return {
        scopeKey: s.scope,
        sourceIdentity: "fixture-host-r1",
        revision: "r1",
        wmLore: wmLore,
        lineage: lineage
      };
    }
  };
}

async function r1NoSentinel(f, sentinel) {
  for (const item of (await s.allPages(f.inventory, f.snapshot.snapshotId)).items) {
    assert.equal((await s.readAll(f.inventory, f.snapshot.snapshotId, item)).toString().includes(sentinel), false);
  }
}

function r1Worldline(scope = s.scope) {
  return {
    version: "libra_turn_worldline_v1",
    scopeKey: scope,
    revision: 0,
    liveHash: "",
    headTurnNodeId: "",
    nodes: [],
    updatedAt: 1,
    cutoffTurn: null
  };
}

async function r1Cold() {
  const local = s.store(), cold = s.coldRuntime(local), ctx = {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  };
  const result = await cold.commitPersistentMemoryEntries([ {
    key: "m1",
    comment: "lmai_memory",
    content: "full original secret story"
  } ], ctx);
  assert.equal(result.ok, true);
  return {
    local: local,
    result: result
  };
}

function r1Preview(id) {
  return {
    key: "preview",
    comment: "lmai_cold_archive",
    content: JSON.stringify({
      schema: "libra.cold_archive.v1",
      shards: [ {
        items: [ {
          persistentShardId: id,
          preview: "short preview"
        } ]
      } ]
    })
  };
}

test("B1_R1_F1_cold_memo_nested_authority_stays_local", async () => {
  const local = s.store(), cold = s.coldRuntime(local), entry = {
    key: "m",
    comment: "lmai_memory",
    content: "full secret story",
    memo: {
      apiKey: "R1_COLD_PRIVATE",
      lease: {
        nonce: "R1_LEASE"
      }
    }
  };
  const result = await cold.commitPersistentMemoryEntries([ entry ], {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  });
  assert.equal(result.ok, true);
  const before = [ ...local.data ], f = await opened({
    local: local
  });
  assert.equal(f.snapshot.complete, false);
  await r1NoSentinel(f, "R1_COLD_PRIVATE");
  assert.deepEqual([ ...local.data ], before);
});

for (const [name, receipt] of [ [ "reason", {
  schema: "wm.prospective-source.v1",
  state: "unsupported",
  analysisEligible: false,
  replacementEligible: false,
  reason: {
    apiKey: "R1_RECEIPT_PRIVATE"
  }
} ], [ "userIds", r1Receipt({
  userIds: [ {
    apiKey: "R1_RECEIPT_PRIVATE"
  } ]
}) ] ]) test("B1_R1_F1_receipt_" + name + "_nested_authority_stays_local", async () => {
  const plugin = s.store(), raw = s.rawRecord(s.scope, "r1");
  plugin.data.set(raw.recordKey, JSON.stringify(raw));
  plugin.data.set(key(s.scope), s.canonical(s.scope, [ r1Turns(receipt) ]));
  const before = [ ...plugin.data ], f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  await r1NoSentinel(f, "R1_RECEIPT_PRIVATE");
  assert.deepEqual([ ...plugin.data ], before);
  const g = await opened({
    plugin: s.store([ [ raw.recordKey, JSON.stringify(raw) ] ]),
    hostCatalog: r1Host([ r1Turns(receipt) ])
  });
  assert.equal(g.snapshot.complete, false);
  await r1NoSentinel(g, "R1_RECEIPT_PRIVATE");
});

test("B1_R1_F1_turn_state_updatedAt_nested_authority_stays_local", async () => {
  const entry = r1Turns(null, {
    updatedAt: {
      apiKey: "R1_STATE_PRIVATE"
    }
  }), plugin = s.store([ [ key(s.scope), s.canonical(s.scope, [ entry ]) ] ]), before = [ ...plugin.data ], f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  await r1NoSentinel(f, "R1_STATE_PRIVATE");
  assert.deepEqual([ ...plugin.data ], before);
  const g = await opened({
    hostCatalog: r1Host([ entry ])
  });
  assert.equal(g.snapshot.complete, false);
  await r1NoSentinel(g, "R1_STATE_PRIVATE");
});

test("B1_R1_F2_host_cold_preview_requires_original_and_dependency", async () => {
  const missing = await opened({
    hostCatalog: r1Host([ r1Preview("missing") ])
  });
  assert.equal(missing.snapshot.complete, false);
  assert.equal((await missing.inventory.verify(missing.snapshot.snapshotId)).errors.some(e => e.code === "missing_cold_shard"), true);
  const {local: local, result: result} = await r1Cold(), f = await opened({
    local: local,
    hostCatalog: r1Host([ r1Preview(result.shards[0].id) ])
  });
  assert.equal(f.snapshot.complete, true);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId), host = items.find(i => i.logicalId.startsWith("host-lore-")), shard = items.find(i => i.schema === "libra.persistent_memory_shard.v1");
  assert.equal(host.dependencies.includes(shard.logicalId), true);
});

test("B1_R1_F2_host_bound_turn_requires_original_and_dependency", async () => {
  const entry = r1Turns(r1Receipt()), missing = await opened({
    hostCatalog: r1Host([ entry ])
  });
  assert.equal(missing.snapshot.complete, false);
  const raw = s.rawRecord(s.scope, "r1"), f = await opened({
    plugin: s.store([ [ raw.recordKey, JSON.stringify(raw) ] ]),
    hostCatalog: r1Host([ entry ])
  });
  assert.equal(f.snapshot.complete, true);
  const {items: items} = await s.allPages(f.inventory, f.snapshot.snapshotId), host = items.find(i => i.logicalId.startsWith("host-lore-")), original = items.find(i => i.domain === "raw");
  assert.equal(host.dependencies.includes(original.logicalId), true);
});

for (const [name, future] of [ [ "canonical", "LIBRA_DATA::v2::future" ], [ "worldline", "LIBRA_WORLDLINE::v2::future" ], [ "raw", "libra.v6.ltm.turn-ledger::future" ], [ "cold", "libra:v2:future:archive:manifest" ] ]) test("B1_R1_F3_future_" + name + "_owned_version_blocks_open_and_drift", async () => {
  const value = JSON.stringify({
    schema: "wm.future.v2",
    scopeKey: s.scope,
    content: "preserve original"
  }), plugin = s.store([ [ future, value ], [ "other_plugin::v2::future", "unrelated" ] ]), f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await s.allPages(f.inventory, f.snapshot.snapshotId)).items.some(i => i.schema === "wm.future.v2"), false);
  assert.equal(plugin.data.get(future), value);
  const p = s.store(), g = await opened({
    plugin: p
  });
  assert.equal(g.snapshot.complete, true);
  p.data.set(future, value);
  assert.equal((await g.inventory.verify(g.snapshot.snapshotId)).complete, false);
  assert.equal(p.data.get(future), value);
});

test("B1_R1_F4_foreign_index_scope_never_becomes_orphan_provenance", async () => {
  const foreign = "char:c1|chat:foreign-index|persona:default", ledger = s.ledgerRuntime(s.store()), indexKey = ledger.indexKey(s.scope), value = JSON.stringify({
    version: 2,
    scopeKey: foreign,
    records: []
  }), plugin = s.store([ [ indexKey, value ] ]), f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await s.allPages(f.inventory, f.snapshot.snapshotId)).items.some(i => i.originScope === foreign), false);
  assert.equal(plugin.data.get(indexKey), value);
});

test("B1_R1_F4_index_reference_cannot_claim_another_raw_scope", async () => {
  const foreign = "char:c1|chat:actual-foreign|persona:default", raw = s.rawRecord(foreign, "foreign1"), ledger = s.ledgerRuntime(s.store()), plugin = s.store([ [ raw.recordKey, JSON.stringify(raw) ], [ ledger.indexKey(s.scope), JSON.stringify({
    version: 2,
    scopeKey: s.scope,
    records: [ {
      recordKey: raw.recordKey,
      recordId: raw.recordId
    } ]
  }) ] ]), f = await opened({
    plugin: plugin
  });
  assert.equal(f.snapshot.complete, false);
  assert.equal((await f.inventory.verify(f.snapshot.snapshotId)).errors.some(e => e.code === "raw_index_invalid"), true);
});

test("B1_R1_F5_final_closure_descriptor_and_retention_bytes_are_admitted", async () => {
  const parent = "char:c1|chat:parent|persona:default", binding = {
    schema: "libra.host.worldline.meta.v1",
    worldlineId: s.scope,
    scopeKey: s.scope,
    parentWorldlineId: "parent",
    forkTurn: 1,
    forkFingerprint: "fork",
    createdAt: 1
  }, envelope = JSON.parse(s.canonical(s.scope));
  envelope.inheritedFrom = "parent";
  envelope.hostWorldlineMeta = binding;
  const plugin = s.store([ [ key(s.scope), JSON.stringify(envelope) ], [ key(parent), s.canonical(parent) ], [ "LIBRA_WORLDLINE::v1::" + s.stableHash(s.scope), JSON.stringify(r1Worldline()) ] ]), scopes = [ {
    scopeKey: s.scope,
    chatId: "chat1",
    characterId: "c1"
  }, {
    scopeKey: parent,
    chatId: "parent",
    characterId: "c1"
  } ], baseline = await opened({
    plugin: plugin,
    scopes: scopes
  }), {items: items} = await s.allPages(baseline.inventory, baseline.snapshot.snapshotId);
  const json = s.loadInventory().canonicalJson, finalBytes = items.reduce((n, i) => n + Buffer.byteLength(json(i)), 0), preBytes = items.reduce((n, i) => n + Buffer.byteLength(json(i.domain === "canonical" ? {
    ...i,
    dependencies: []
  } : i)), 0), ceiling = Math.floor((preBytes + finalBytes) / 2);
  assert.equal(preBytes < ceiling && ceiling < finalBytes, true);
  const f = await opened({
    plugin: plugin,
    scopes: scopes,
    limits: {
      maxDescriptorBytes: ceiling
    }
  });
  assert.equal(f.snapshot.complete, false);
  const fItems = (await s.allPages(f.inventory, f.snapshot.snapshotId)).items;
  assert.equal(fItems.find(i => i.domain === "canonical" && i.originScope === s.scope).dependencies.length, 2);
  const payloadBytes = Object.values(baseline.snapshot.domainBytes).reduce((a, b) => a + b, 0), g = await opened({
    plugin: plugin,
    scopes: scopes,
    limits: {
      maxRetainedBytes: payloadBytes + ceiling
    }
  });
  assert.equal(g.snapshot.complete, false);
  const gId = g.snapshot.snapshotId;
  await g.inventory.close(gId);
  const h = await g.inventory.open({
    fence: g.fence
  });
  assert.equal(h.complete, false, "closing releases exact charged footprint, with no capacity drift");
  assert.deepEqual(h.domainCounts, baseline.snapshot.domainCounts);
  assert.deepEqual(h.domainBytes, baseline.snapshot.domainBytes);
});

test("B1_R1_F6_private_current_chunks_are_local_only_and_stale_chunks_block", async () => {
  const plugin = s.store(), local = s.store(), compat = s.nativeRuntime(plugin, local), privateValue = JSON.stringify({
    apiKey: "R1_PRIVATE_CHUNK_SECRET",
    capture: "x".repeat(6e5)
  });
  assert.equal(await compat.pluginStorage.setItem("LMAI_Config", privateValue, {
    strict: true
  }), true);
  const before = [ ...plugin.data ], reads = [], originalRead = plugin.getItem;
  plugin.getItem = async k => {
    reads.push(k);
    return originalRead(k);
  };
  const f = await opened({
    plugin: compat.pluginStorage,
    local: compat.localPluginStorage
  });
  assert.equal(f.snapshot.complete, true);
  await r1NoSentinel(f, "R1_PRIVATE_CHUNK_SECRET");
  assert.equal(reads.some(k => k.startsWith("LMAI_Config::chunk:v1:")), false);
  assert.deepEqual([ ...plugin.data ], before);
  plugin.data.set("LMAI_Config::chunk:v1:stale:0000", "stale private");
  const g = await opened({
    plugin: compat.pluginStorage,
    local: compat.localPluginStorage
  });
  assert.equal(g.snapshot.complete, false);
  assert.equal((await g.inventory.verify(g.snapshot.snapshotId)).errors.some(e => e.code === "orphan_compat_chunk"), true);
});

test("B1_R1_F7_foreign_key_errors_have_exact_domain_and_opaque_identity", async () => {
  for (const domain of [ "canonical", "lineage" ]) {
    const foreign = "char:c1|chat:foreign-error|persona:default", stored = domain === "canonical" ? s.canonical(foreign) : JSON.stringify(r1Worldline(foreign)), physical = domain === "canonical" ? key(s.scope) : "LIBRA_WORLDLINE::v1::" + s.stableHash(s.scope), f = await opened({
      plugin: s.store([ [ physical, stored ] ])
    });
    assert.equal(f.snapshot.complete, false);
    const v = await f.inventory.verify(f.snapshot.snapshotId), e = v.errors.find(e => e.code === "scope_key_mismatch");
    assert.deepEqual(Object.keys(e).sort(), [ "code", "domain", "logicalId" ]);
    assert.equal(e.domain, domain);
    assert.match(e.logicalId, /^source-[a-f0-9]{64}$/);
    const page = await f.inventory.page({
      snapshotId: f.snapshot.snapshotId,
      cursor: null,
      maxItems: 128,
      maxBytes: 262144
    });
    assert.deepEqual(page.errors.find(x => x.code === "scope_key_mismatch"), e);
    assert.equal(v.errors.every(x => s.contracts.DOMAINS.includes(x.domain)), true);
  }
});

for (const destination of [ "canonical", "host" ]) test("B1_R1_F1_preview_nested_metadata_" + destination + "_stays_local", async () => {
  const {local: local, result: result} = await r1Cold(), entry = r1Preview(result.shards[0].id), preview = JSON.parse(entry.content);
  preview.shards[0].items[0].sourceMessageIds = [ {
    apiKey: "R1_PREVIEW_PRIVATE"
  } ];
  entry.content = JSON.stringify(preview);
  const plugin = s.store(destination === "canonical" ? [ [ key(s.scope), s.canonical(s.scope, [ entry ]) ] ] : []), before = [ ...plugin.data ], f = await opened({
    plugin: plugin,
    local: local,
    ...destination === "host" ? {
      hostCatalog: r1Host([ entry ])
    } : {}
  });
  assert.equal(f.snapshot.complete, false);
  await r1NoSentinel(f, "R1_PREVIEW_PRIVATE");
  assert.deepEqual([ ...plugin.data ], before);
});
