/** @typedef {{backend:'native_legacy',handle:object,scope:string,sourceToken:object,expectedRawSha256:string,expectedResetGeneration:number,raw:string,operation:'normal'|'verified',operationId:string}} NativeLegacyPublish
 * @typedef {{ok:boolean,backend?:'native_legacy',verified?:boolean,durableReceipt?:false,operationId?:string,rawSha256?:string,reason?:string,uncertain?:boolean}} NativeLegacyResult
 */
/* Native delegation preserves plugin-only semantics; conditional legacy writes are not atomic authority. */
const WmNativeStorage = (() => {
  "use strict";
  const R = typeof WmStorageRouter !== "undefined" ? WmStorageRouter : require("./wm-storage-router.source.js");
  const C = typeof WmStorageContracts !== "undefined" ? WmStorageContracts : require("./wm-storage-contracts.source.js");
  const token = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v), digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v), hash = raw => C.hashBytes((new TextEncoder).encode(raw ?? ""));
  function createWmNativeBackend({storage: storage, inventory: inventory, hostGate: hostGate, journal: journal} = {}) {
    if (!storage) throw Error("native_storage_required");
    const records = new WeakMap, owners = new WeakMap, defaultOwner = Object.freeze({});
    const call = (name, v) => typeof storage[name] === "function" ? storage[name](v) : Promise.resolve({
      ok: false,
      reason: "native_method_unsupported"
    });
    function support() {
      try {
        const s = storage.describeNativeWriteSupport?.();
        return R.exactData(s, [ "freshContext", "expectedRaw", "readback", "resetBinding", "writers" ]) && [ "freshContext", "expectedRaw", "readback", "resetBinding" ].every(k => s[k] === true) && Array.isArray(s.writers) && s.writers.every(k => [ "normal", "verified" ].includes(k)) && typeof storage.publishLegacy === "function" ? s : null;
      } catch {
        return null;
      }
    }
    async function readCanonical(v) {
      if (!R.exactData(v, [ "scope" ], [ "handle", "route" ])) return {
        ok: false,
        reason: "native_input_invalid"
      };
      const owner = v.handle || defaultOwner;
      let result;
      try {
        result = await call("readCanonical", v);
      } catch {
        return {
          ok: false,
          reason: "native_read_unavailable"
        };
      }
      if (!R.plainData({
        ...result,
        sourceToken: null
      }) || result?.ok !== true || !(result.raw === null || typeof result.raw === "string")) return {
        ok: false,
        reason: "native_read_unavailable"
      };
      const sourceToken = Object.freeze({}), bound = {
        owner: owner,
        scope: v.scope,
        raw: result.raw,
        rawSha256: await hash(result.raw),
        resetGeneration: result.resetGeneration,
        storageToken: result.sourceToken,
        route: v.route
      };
      records.set(sourceToken, bound);
      let owned = owners.get(owner);
      if (!owned) {
        owned = new Set;
        owners.set(owner, owned);
      }
      owned.add(sourceToken);
      return {
        ok: true,
        raw: result.raw,
        head: null,
        manifestDigest: null,
        sourceToken: sourceToken,
        ...Number.isSafeInteger(result.resetGeneration) && result.resetGeneration >= 0 ? {
          resetGeneration: result.resetGeneration
        } : {}
      };
    }
    async function publishLegacy(v) {
      if (!R.exactData(v, [ "handle", "scope", "sourceToken", "expectedRawSha256", "expectedResetGeneration", "raw", "operation", "operationId", "route" ])) return {
        ok: false,
        reason: "native_input_invalid"
      };
      const source = records.get(v.sourceToken), qualified = support();
      if (!source || source.owner !== v.handle || source.scope !== v.scope || !digest(v.expectedRawSha256) || source.rawSha256 !== v.expectedRawSha256 || !Number.isSafeInteger(v.expectedResetGeneration) || source.resetGeneration !== v.expectedResetGeneration || source.resetGeneration < 0 || v.route.mode !== "plugin_only" || source.route && !R.routeEqual(source.route, v.route)) return {
        ok: false,
        reason: "native_source_changed"
      };
      if (!qualified || !qualified.writers.includes(v.operation) || !token(v.operationId) || typeof v.raw !== "string") return {
        ok: false,
        reason: "native_legacy_unsupported"
      };
      try {
        const fresh = await storage.readCanonical({
          scope: v.scope,
          handle: v.handle,
          route: v.route
        });
        if (fresh?.ok !== true || fresh.raw !== source.raw || fresh.resetGeneration !== source.resetGeneration) return {
          ok: false,
          reason: "native_source_changed"
        };
        const written = await storage.publishLegacy({
          scope: v.scope,
          raw: v.raw,
          operation: v.operation,
          operationId: v.operationId,
          expectedRaw: source.raw,
          expectedRawSha256: v.expectedRawSha256,
          expectedResetGeneration: source.resetGeneration,
          sourceToken: source.storageToken
        });
        if (!R.plainData(written) || written?.ok !== true) return {
          ok: false,
          reason: "native_write_rejected",
          ...written?.uncertain ? {
            uncertain: true,
            operationId: v.operationId
          } : {}
        };
        const verified = await storage.readCanonical({
          scope: v.scope,
          handle: v.handle,
          route: v.route
        });
        if (verified?.ok !== true || verified.raw !== v.raw || verified.resetGeneration !== source.resetGeneration) return {
          ok: false,
          reason: "native_readback_unconfirmed",
          uncertain: true,
          operationId: v.operationId
        };
        return {
          ok: true,
          backend: "native_legacy",
          verified: true,
          durableReceipt: false,
          operationId: v.operationId,
          rawSha256: await hash(v.raw)
        };
      } catch {
        return {
          ok: false,
          reason: "native_write_uncertain",
          uncertain: true,
          operationId: v.operationId
        };
      }
    }
    async function current(v = {}) {
      if (!R.exactData(v, [], [ "handle", "route" ])) return {
        ok: false,
        reason: "native_input_invalid"
      };
      const owner = v.handle || defaultOwner;
      try {
        if (typeof storage.current === "function") {
          const result = await storage.current(v);
          if (!result?.ok) return {
            ok: false,
            reason: "native_source_changed"
          };
        }
        for (const sourceToken of owners.get(owner) || []) {
          const source = records.get(sourceToken), fresh = await storage.readCanonical({
            scope: source.scope,
            handle: owner,
            route: source.route
          });
          if (fresh?.ok !== true || fresh.raw !== source.raw || Number.isSafeInteger(source.resetGeneration) && fresh.resetGeneration !== source.resetGeneration) return {
            ok: false,
            reason: "native_source_changed"
          };
        }
        return {
          ok: true
        };
      } catch {
        return {
          ok: false,
          reason: "native_read_unavailable"
        };
      }
    }
    async function closeRequest(v = {}) {
      if (!R.exactData(v, [], [ "handle" ])) return {
        ok: false,
        reason: "native_input_invalid"
      };
      const owner = v.handle || defaultOwner;
      for (const sourceToken of owners.get(owner) || []) records.delete(sourceToken);
      owners.delete(owner);
      return typeof storage.closeRequest === "function" ? storage.closeRequest(v) : {
        ok: true
      };
    }
    return Object.freeze({
      ...Object.fromEntries(["inspectMigrationDestination","beginMigrationStage","stageMigrationChunk","migrationStageStatus","verifyMigrationStage","materializeMigrationStage","verifyMigrationReadback","migrationLimits","fenceMigration"].map(method=>[method,input=>hostGate?.migration?hostGate.migration(method,input):Promise.resolve({ok:false,reason:"native_migration_unsupported"})])),
      describe: () => Object.freeze({
        mode: "plugin_only",
        capabilities: Object.freeze([]),
        atomic: false,
        nativeLegacyConditionalWrite: !!support()
      }),
      readCanonical: readCanonical,
      publishBundle: v => call("publishBundle", v),
      publishLegacy: publishLegacy,
      initializeScope: () => Promise.resolve({
        ok: false,
        reason: "native_initialize_unsupported"
      }),
      readInventoryState:v=>call("readInventoryState",v),
      appendRaw: v => call("appendRaw", v),
      updateRawHistory: v => call("updateRawHistory", v),
      readCompanion: v => typeof inventory?.readChunk === "function" ? inventory.readChunk(v) : call("readCompanion", v),
      current: current,
      closeRequest: closeRequest
    });
  }
  return Object.freeze({
    createWmNativeBackend: createWmNativeBackend
  });
})();

if (typeof module !== "undefined" && module.exports) module.exports = WmNativeStorage;
