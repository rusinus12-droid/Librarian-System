"use strict";

// Only in-process synthetic host data. Exact production closures are evaluated,
// without starting the host, loading a dist build, or using historical test hooks.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");

const contracts = require("../src/wm-storage-contracts.source.js");

function loadInventory() {
  const p = path.join(root, "src/wm-storage-inventory.source.js");
  return fs.existsSync(p) ? require(p) : {};
}

function closure(file, name, end) {
  const s = fs.readFileSync(path.join(root, "src/parts", file), "utf8");
  const start = s.indexOf(`    const ${name} = (() => {`);
  const finish = end ? s.indexOf(end, start) : s.indexOf("\n    })();", start) + 10;
  if (start < 0 || finish <= start) throw Error("fixture_closure_missing");
  return s.slice(start, finish);
}

function evaluate(source, names, globals = {}) {
  const context = vm.createContext({
    console: console,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Uint8Array: Uint8Array,
    crypto: crypto.webcrypto,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    WmPendingAdmission: {forScope:async()=>({ok:true}),forChat:async()=>({ok:true})},
    WmWriterRuntime: {enabled:false},
    VersionedCanonicalBridge: {mode:"native"},
    ...globals
  });
  new vm.Script(source + "\n;globalThis.exports={" + names.join(",") + "};").runInContext(context);
  return context.exports;
}

function store(entries = []) {
  const data = new Map(entries), faults = new Set, calls = {
    reads: 0,
    keys: 0,
    writes: 0
  };
  return {
    data: data,
    faults: faults,
    calls: calls,
    async keys() {
      calls.keys++;
      if (faults.has("keys")) throw Error("secret fault text");
      return [ ...data.keys() ];
    },
    async getItem(k) {
      calls.reads++;
      if (faults.has(k)) throw Error("private failure text");
      return data.get(k) ?? null;
    },
    async setItem(k, v) {
      calls.writes++;
      data.set(k, v);
      return true;
    },
    async removeItem(k) {
      calls.writes++;
      data.delete(k);
      return true;
    }
  };
}

function stableHash(s) {
  s = String(s || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return Math.abs(h).toString(36);
}

function responseHash(s) {
  let h = 0;
  for (let i = 0; i < (s || "").length; i++) h = Math.imul(31, h) ^ s.charCodeAt(i) | 0;
  return String(h);
}

function checksumText(s) {
  let a = 2166136261, b = 2654435769;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul(b ^ c + i >>> 0, 2246822507) >>> 0;
    b ^= b >>> 13;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}:${Buffer.byteLength(s)}`;
}

function seal(v) {
  return {
    ...v,
    checksum: checksumText(JSON.stringify(v))
  };
}

const scope = "char:c1|chat:chat1|persona:default";

function rawKey(s, id) {
  return `libra.v5.ltm.turn-ledger::${stableHash(s)}::${encodeURIComponent(s)}::record::${encodeURIComponent(id)}`;
}

function rawRecord(s, id, {userText: userText = "user secret story", assistantText: assistantText = "answer 원문 🌍", ...extra} = {}) {
  const key = rawKey(s, id);
  return {
    version: 2,
    kind: "libra_raw_turn",
    recordId: id,
    recordKey: key,
    requestId: id,
    scopeKey: s,
    runtimeScopeKey: s,
    canonicalScope: s,
    characterId: "c1",
    characterIndex: 0,
    chatId: "chat1",
    chatIndex: 0,
    requestSequence: 1,
    requestType: "model",
    resetGeneration: 0,
    userText: userText,
    assistantText: assistantText,
    responseHash: responseHash(assistantText),
    rawHash: stableHash(JSON.stringify([ userText, assistantText ])),
    userBytes: Buffer.byteLength(userText),
    assistantBytes: Buffer.byteLength(assistantText),
    captureSource: "afterRequest",
    observedAt: 100,
    status: "observed",
    analysisStatus: "pending",
    updatedAt: 100,
    originMessageCount: 2,
    sourceCapture: null,
    mainResponseLanguageTarget: "",
    analysisDeadlineAt: 0,
    ...extra
  };
}

function canonical(s, entries = []) {
  return JSON.stringify({
    version: "1.0",
    scopeKey: s,
    entryCount: entries.length,
    updatedAt: 100,
    entries: entries,
    resetGeneration: 0
  });
}

function nativeRuntime(plugin = store(), local = store()) {
  const core = fs.readFileSync(path.join(root, "src/parts/01-core-runtime-compat-state-debug.js"), "utf8");
  const start = core.indexOf("    const RisuCompat = (() => {"), end = core.indexOf("\n    })();", start) + 10;
  const {RisuCompat: RisuCompat} = evaluate(core.slice(start, end), [ "RisuCompat" ], {
    Risuai: {
      pluginStorage: plugin,
      getLocalPluginStorage: async () => local
    },
    safeClone: v => JSON.parse(JSON.stringify(v))
  });
  return RisuCompat;
}

function ledgerRuntime(storage) {
  return evaluate(closure("05f-turn-ledgers.js", "DurableTurnLedger"), [ "DurableTurnLedger" ], {
    WmStorageInventory: loadInventory(),
    RisuCompat: {
      pluginStorage: storage
    },
    stableHash: stableHash,
    TokenizerEngine: {
      simpleHash: s => Number(responseHash(s))
    },
    safeClone: v => JSON.parse(JSON.stringify(v)),
    normalizeRisuIndex: v => Number.isInteger(v) ? v : null,
    normalizeInternalDataLanguageTarget: v => v
  }).DurableTurnLedger;
}

function coldRuntime(storage) {
  return evaluate(closure("09b-archive-integrity.js", "ColdArchiveManager"), [ "ColdArchiveManager" ], {
    WmStorageInventory: loadInventory(),
    RisuCompat: {
      pluginStorage: storage,
      localPluginStorage: {
        getStore: async () => storage
      }
    },
    safeClone: v => JSON.parse(JSON.stringify(v)),
    normalizeLegacyMemoryTurnAnchor: v => Number(v) || 0,
    truncateForLLM: s => s,
    parseMemoryMeta: () => ({})
  }).ColdArchiveManager;
}

function setup({plugin: plugin = store(), local: local = store(), scopes: scopes = [ {
  scopeKey: scope,
  chatId: "chat1",
  characterId: "c1"
} ], limits: limits = {}, fence: fence, hostCatalog: hostCatalog} = {}) {
  const m = loadInventory();
  if (typeof m.createWmInventory !== "function") return {
    missing: true
  };
  const inventory = m.createWmInventory({
    nativeStores: {
      plugin: plugin,
      local: local
    },
    hostCatalog: hostCatalog || {
      async listScopes() {
        return scopes;
      },
      async readWmScope(scopeKey) {
        return {
          scopeKey: scopeKey,
          sourceIdentity: "fixture-host-" + scopeKey,
          revision: "revision-1",
          wmLore: [],
          lineage: null
        };
      }
    },
    classify: contracts.classifyOwnedRecord,
    limits: limits
  });
  return {
    inventory: inventory,
    plugin: plugin,
    local: local,
    fence: fence || {
      routeGeneration: "native-route1"
    }
  };
}

async function allPages(inventory, snapshotId, {maxItems: maxItems = 2, maxBytes: maxBytes = 8192} = {}) {
  let cursor = null, items = [], pages = [];
  do {
    const p = await inventory.page({
      snapshotId: snapshotId,
      cursor: cursor,
      maxItems: maxItems,
      maxBytes: maxBytes
    });
    pages.push(p);
    items.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor);
  return {
    items: items,
    pages: pages
  };
}

async function readAll(inventory, snapshotId, item, maxBytes = 7) {
  let offset = 0, out = [];
  do {
    const c = await inventory.readChunk({
      snapshotId: snapshotId,
      logicalId: item.logicalId,
      offset: offset,
      maxBytes: maxBytes
    });
    out.push(Buffer.from(c.bytes));
    offset = c.nextOffset;
    if (offset === null) break;
  } while (true);
  return Buffer.concat(out);
}

module.exports = {
  root: root,
  contracts: contracts,
  loadInventory: loadInventory,
  store: store,
  setup: setup,
  scope: scope,
  stableHash: stableHash,
  responseHash: responseHash,
  checksumText: checksumText,
  seal: seal,
  rawKey: rawKey,
  rawRecord: rawRecord,
  canonical: canonical,
  nativeRuntime: nativeRuntime,
  ledgerRuntime: ledgerRuntime,
  coldRuntime: coldRuntime,
  allPages: allPages,
  readAll: readAll,
  closure: closure,
  evaluate: evaluate
};

function nativeReadMethods(storage) {
  const src = fs.readFileSync(path.join(root, "src/parts/01f-lore-consolidation.js"), "utf8");
  function fn(name) {
    const start = src.indexOf("        const " + name + " = "), end = src.indexOf("\n        };", start) + 11;
    if (start < 0 || end < start) throw Error("fixture_read_method_missing");
    return src.slice(start, end);
  }
  return evaluate(fn("parseCanonicalReadonlyValue") + "\n" + fn("readInventoryCanonical") + "\n" + fn("readInventoryWorldline"), [ "readInventoryCanonical", "readInventoryWorldline" ], {
    RisuCompat: {
      pluginStorage: storage
    },
    storageKeyFor: s => "LIBRA_DATA::v1::" + stableHash(s),
    worldlineKeyFor: s => "LIBRA_WORLDLINE::v1::" + stableHash(s),
    text: String,
    SCHEMA: "libra_turn_worldline_v1",
    isLibraEntry: e => e.comment.startsWith("lmai_")
  });
}

module.exports.nativeReadMethods = nativeReadMethods;
