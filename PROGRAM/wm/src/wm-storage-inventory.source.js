/* Native WM read-only inventory. No route mutation, writer, replay, or host qualification. */
const WmStorageInventory = (() => {
  "use strict";
  const C = typeof WmStorageContracts !== "undefined" ? WmStorageContracts : typeof module !== "undefined" && module.exports ? require("./wm-storage-contracts.source.js") : null;
  const DOMAINS = [ "canonical", "cold", "raw", "raw_history", "lineage", "orphan" ];
  const DEFAULT_LIMITS = Object.freeze({
    maxChunkBytes: 262144,
    maxPageItems: 128,
    maxPageBytes: 262144,
    maxKeyListItems: 1e6,
    maxKeyListBytes: 67108864,
    maxKeyListMemoryBytes: 134217728,
    maxSourceValueBytes: 67108864,
    maxSourceScanBytes: 268435456,
    maxInventoryItems: 1e6,
    maxInventoryBytes: 134217728,
    maxDescriptorBytes: 67108864,
    maxVerificationReads: 2e6,
    maxScopes: 1e5,
    maxSnapshots: 8,
    maxRetainedBytes: 268435456,
    maxErrors: 1024
  });
  const readContexts = new WeakMap;
  const utf8 = s => (new TextEncoder).encode(s);
  const REASONS = new Set([ "byte_total_overflow", "chunk_invalid", "cold_manifest_invalid", "cold_preview_invalid", "cold_preview_without_original", "cold_reference_mismatch", "cold_reference_ambiguous", "cold_scope_mismatch", "cold_scope_unverified", "cold_shard_invalid", "cold_wal_invalid", "compat_chunk_missing", "compat_chunk_ownership_unverified", "dependency_cycle", "dependency_missing", "duplicate_logical_id", "enumerated_record_missing", "fence_context_invalid", "host_catalog_drift", "host_catalog_invalid", "host_catalog_unavailable", "host_key_list_byte_limit", "host_key_list_item_limit", "host_key_list_memory_limit", "host_lineage_unverified", "host_lore_unverified", "host_scope_adapter_missing", "host_scope_drift", "host_scope_read_failed", "host_scope_unverified", "inventory_budget_exceeded", "inventory_cursor_invalid", "inventory_cursor_replay", "inventory_descriptor_invalid", "limits_invalid", "lineage_binding_invalid", "lineage_binding_missing", "lineage_reference_missing", "lineage_scope_unverified", "missing_cold_shard", "native_adapters_required", "non_plain_data", "non_plain_source", "offset_out_of_range", "orphan_compat_chunk", "page_byte_limit", "page_item_byte_limit", "page_limit", "random_source_unavailable", "raw_history_invalid", "raw_identity_invalid", "raw_index_invalid", "raw_integrity_invalid", "raw_publication_invalid", "raw_receipt_missing", "read_context_invalid", "scope_budget_exceeded", "scope_key_mismatch", "scope_hash_collision", "raw_provenance_reference_missing", "scope_unverified", "snapshot_capacity", "snapshot_open_in_progress", "snapshot_item_integrity", "snapshot_item_missing", "snapshot_missing", "source_content_drift", "source_key_drift", "source_scan_byte_limit", "source_value_byte_limit", "storage_adapter_not_strict", "storage_keys_failed", "storage_keys_invalid", "storage_keys_unavailable", "storage_read_failed", "storage_read_unavailable", "storage_value_not_raw_string", "unknown_owned_family", "unknown_owned_schema", "unsupported_canonical_entry", "unsupported_raw_field", "verification_read_budget" ]);
  const error = reason => Object.assign(new Error("WM_" + reason), {
    code: "WM_" + reason
  });
  const nativePrototype = (prototype, name) => {
    if (!prototype) return false;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    const ctor = descriptor && descriptor.value;
    return typeof ctor === "function" && Function.prototype.toString.call(ctor) === "function " + name + "() { [native code] }" && ctor.prototype === prototype;
  };
  function plain(value, seen = new Set) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const p = Object.getPrototypeOf(value), array = Array.isArray(value);
    if (array ? !nativePrototype(p, "Array") : p !== null && (!nativePrototype(p, "Object") || Object.getPrototypeOf(p) !== null)) return false;
    const names = Reflect.ownKeys(value);
    if (array && (names.length !== value.length + 1 || names.some(k => typeof k !== "string" || k !== "length" && !/^(0|[1-9][0-9]*)$/.test(k)))) return false;
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(value, name);
      if (typeof name !== "string" || [ "__proto__", "constructor", "prototype" ].includes(name) || !d || !("value" in d) || name !== "length" && !d.enumerable || !plain(d.value, seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  const keys = (v, allowed, required = []) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(v, k));
  const str = v => typeof v === "string", count = v => Number.isSafeInteger(v) && v >= 0;
  const validScope = v => str(v) && v.trim() === v && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f]/.test(v);
  function canonicalJson(v) {
    if (!plain(v)) throw error("non_plain_data");
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  const freeze = v => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  const clone = v => JSON.parse(JSON.stringify(v));
  const totals = () => Object.fromEntries(DOMAINS.map(d => [ d, 0 ]));
  const stableHash = input => {
    const s = String(input || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
    return Math.abs(h).toString(36);
  };
  const responseHash = s => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(31, h) ^ s.charCodeAt(i) | 0;
    return String(h);
  };
  function checksumText(s) {
    let a = 2166136261, b = 2654435769;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 16777619) >>> 0;
      b = Math.imul(b ^ c + i >>> 0, 2246822507) >>> 0;
      b ^= b >>> 13;
    }
    return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}:${utf8(s).length}`;
  }
  const checksumValid = v => {
    const copy = {
      ...v
    };
    delete copy.checksum;
    return v.checksum === checksumText(JSON.stringify(copy));
  };
  const canonicalKeyFor = s => "LIBRA_DATA::v1::" + stableHash(s);
  const worldlineKeyFor = s => "LIBRA_WORLDLINE::v1::" + stableHash(s);
  const rawKeyFor = (s, id) => `libra.v5.ltm.turn-ledger::${stableHash(s)}::${encodeURIComponent(s)}::record::${encodeURIComponent(id)}`;
  function persistentKeys(c) {
    const h = checksumText([ c.scopeKey || "", c.chatId || "", c.characterId || "", "global" ].join("::")).replace(/[^a-zA-Z0-9:_-]/g, "").replace(/:/g, "-"), namespace = `libra:v1:${h}:archive`;
    return {
      namespace: namespace,
      manifest: namespace + ":manifest",
      wal: namespace + ":wal",
      shard: id => namespace + ":shard:" + String(id).replace(/[^a-zA-Z0-9:_-]/g, "_")
    };
  }
  const RAW_IMMUTABLE = [ "version", "kind", "recordId", "recordKey", "requestId", "scopeKey", "runtimeScopeKey", "canonicalScope", "characterId", "characterIndex", "chatId", "chatIndex", "requestSequence", "requestType", "resetGeneration", "userText", "assistantText", "responseHash", "rawHash", "userBytes", "assistantBytes", "journalSequence", "journalPageNumber", "captureSource", "observedAt" ];
  const RAW_HISTORY = [ "status", "analysisStatus", "observedAt", "updatedAt", "analysisCompletedAt", "analysisFailedAt", "analysisCancelledAt", "analysisRecoveryAttempt", "analysisRecoveryReservedAt", "analysisRecoveryStartedAt", "analysisRecoveryFinishedAt", "analysisRecoveryLastAttemptAt", "completedAt", "failedAt", "discardedAt", "terminalAt", "commitTurn", "turn", "resultHash", "analysisResultHash", "originMessageCount", "mainResponseLanguageTarget", "analysisStartedAt", "analysisFinishedAt", "analysisTurn", "analysisOutcome", "analysisRecoveryStatus", "commitStatus", "turnKey", "deferredAt" ];
  // Explicit source capture/authority fields only. They are never copied, recursively inspected, or logged.
    const RAW_PRIVATE = [ "sourceCapture", "analysisDeadlineAt", "pendingParkToken", "pendingParkResumeToken", "analysisRecoveryLastError", "analysisError", "analysisReason", "skipReason", "deferredReason", "terminalReason", "analysisLease", "requestLease", "lease", "approval", "pendingApproval", "authHeaders", "headers", "apiKey", "connectionToken", "privateModelJobCapture", "modelJobCapture", "capture", "analysisAdmission", "analysisAdmissionGuard", "analysisReservation", "analysisRecoveryOwner", "analysisConsent", "analysisEligible", "replacementEligible" ];
  const CANONICAL_FIELDS = [ "version", "scopeKey", "entryCount", "updatedAt", "entries", "resetGeneration", "inheritedFrom", "hostWorldlineMeta", "reanalysisRevision" ];
  const LORE_FIELDS = [ "extensionScope", "extensionPacketId", "extensionStatus", "key", "comment", "content", "memo", "mode", "insertorder", "alwaysActive", "selective", "secondkey", "activationPercent", "caseSensitive", "regex", "useRegex", "bookVersion", "folder", "id", "uuid", "enabled", "probability", "priority", "constant", "selectiveLogic", "keys", "secondary_keys", "position", "order", "excludeRecursion", "preventRecursion", "delayUntilRecursion", "matchWholeWords" ];
  const LORE_CANONICAL = [ "lmai_analysis_quarantine", "lmai_integrated_packet_journal", "lmai_extension_lock", "lmai_extension_event", "lmai_integrity_scan", "lmai_char_states", "lmai_character_lore_cues", "lmai_direct_memory", "lmai_director", "lmai_entity", "lmai_entity_absorption", "lmai_entity_candidates", "lmai_entity_knowledge_vault", "lmai_entity_relations", "lmai_memory", "lmai_narrative", "lmai_narrative_state", "lmai_recall_feedback", "lmai_relation", "lmai_relation_graph", "lmai_rp_longterm", "lmai_secret_knowledge", "lmai_source_reflection_state", "lmai_story_author", "lmai_time_engine", "lmai_turn_records", "lmai_user", "lmai_user_dlc", "lmai_user_identity", "lmai_world", "lmai_world_additional", "lmai_world_graph", "lmai_world_node", "lmai_world_state", "lmai_world_states", "lmai_cold_archive", "lmai_extension_history" ];
  const LORE_DERIVED = [ "lmai_hme_graph_index", "lmai_hme_index", "lmai_hypa_v3_source", "lmai_projection_active_state", "lmai_projection_boundary_guard", "lmai_projection_recall_bundle", "lmai_projection_typed_recall" ];
  const LORE_UNSUPPORTED = [ "lmai_analysis_quarantine", "lmai_debug_recent", "lmai_integrated_packet_journal", "lmai_integrity_scan", "lmai_rollback_journal", "lmai_rollback_snapshot" ];
  const WORLDLINE_FIELDS = [ "version", "scopeKey", "revision", "liveHash", "headTurnNodeId", "nodes", "updatedAt", "cutoffTurn" ];
  const NODE_FIELDS = [ "turnNodeId", "logicalTurnId", "variantId", "parentTurnNodeId", "pairIndex", "originalOrdinal", "activeOrdinal", "userHash", "assistantHash", "userMessageId", "assistantMessageId", "status", "supersededBy", "createdAt", "updatedAt" ];
  const BINDING_FIELDS = [ "schema", "worldlineId", "scopeKey", "parentWorldlineId", "forkTurn", "forkFingerprint", "createdAt" ];
  const COLD_MANIFEST_FIELDS = [ "schema", "version", "scopeHash", "updatedAt", "shardCount", "entryCount", "shards", "checksum" ];
  const COLD_REF_FIELDS = [ "id", "key", "checksum", "bytes", "entryCount", "entryIds", "createdAt", "turnRange" ];
  const COLD_SHARD_FIELDS = [ "schema", "version", "id", "scopeHash", "reason", "createdAt", "turnRange", "entryCount", "entryIds", "records", "bytes", "checksum" ];
  const COLD_WAL_FIELDS = [ "schema", "version", "transactionId", "scopeHash", "state", "createdAt", "updatedAt", "planned", "committedShardIds", "remainingShardIds", "ackedIds", "failures" ];
  const RAW_NUMBERS = [ "version", "characterIndex", "chatIndex", "requestSequence", "resetGeneration", "userBytes", "assistantBytes", "journalSequence", "journalPageNumber", "observedAt" ];
  const HISTORY_STRINGS = [ "status", "analysisStatus", "mainResponseLanguageTarget", "analysisOutcome", "analysisRecoveryStatus", "commitStatus", "turnKey", "resultHash", "analysisResultHash" ];
  const STATUSES = [ "observed", "pending", "queued", "deferred", "replaying", "awaiting_host_anchor", "blocked_host_source_changed", "running", "deadline", "done", "committed", "completed", "skipped", "terminal", "discarded", "failed", "error", "cancelled", "canceled" ];
  function rawScalarsValid(v) {
    return RAW_IMMUTABLE.filter(k => Object.hasOwn(v, k)).every(k => RAW_NUMBERS.includes(k) ? v[k] === null && [ "characterIndex", "chatIndex" ].includes(k) || count(v[k]) : str(v[k]));
  }
  function historyScalarsValid(v) {
    return RAW_HISTORY.filter(k => Object.hasOwn(v, k)).every(k => HISTORY_STRINGS.includes(k) ? str(v[k]) && (![ "status", "analysisStatus" ].includes(k) || STATUSES.includes(v[k])) : count(v[k]));
  }
  const turnRangeValid = v => keys(v, [ "from", "to" ], [ "from", "to" ]) && count(v.from) && count(v.to);
  const bindingScalarsValid = v => BINDING_FIELDS.every(k => [ "forkTurn", "createdAt" ].includes(k) ? count(v[k]) : str(v[k]));
  const PROSPECTIVE_FIELDS = [ "schema", "state", "requestId", "canonicalScope", "characterId", "chatId", "resetGeneration", "userIds", "assistantIds", "originMessageCount", "bindingAuthority", "analysisEligible", "replacementEligible", "reason" ];
  const LORE_TEXT_FIELDS = [ "extensionScope", "extensionPacketId", "extensionStatus", "key", "comment", "content", "memo", "mode", "secondkey", "bookVersion", "folder", "id", "uuid" ];
  const LORE_NUMBER_FIELDS = [ "insertorder", "activationPercent", "probability", "priority", "selectiveLogic", "position", "order", "delayUntilRecursion" ];
  const LORE_BOOLEAN_FIELDS = [ "alwaysActive", "selective", "caseSensitive", "regex", "useRegex", "enabled", "constant", "excludeRecursion", "preventRecursion", "matchWholeWords" ];
  const LORE_ARRAY_FIELDS = [ "keys", "secondary_keys" ];
  const STRING_LIST = v => Array.isArray(v) && v.every(str);
  function loreMetadataValid(entry) {
    return keys(entry, LORE_FIELDS, [ "comment", "content" ]) && Object.entries(entry).every(([key, value]) => LORE_TEXT_FIELDS.includes(key) ? str(value) : LORE_NUMBER_FIELDS.includes(key) ? count(value) : LORE_BOOLEAN_FIELDS.includes(key) ? typeof value === "boolean" : LORE_ARRAY_FIELDS.includes(key) ? STRING_LIST(value) : false);
  }
  const TURN_STATE_FIELDS = [ "version", "kind", "recordFormat", "scopeKey", "scopeId", "chatId", "updatedAt", "records" ];
  const TURN_RECORD_FIELDS = [ "version", "scopeKey", "chatId", "turn", "turnAnchor", "turnAnchorTurn", "lockedTurn", "finalizedTurn", "turnKey", "userTurnKey", "sourceReceipt", "sourceHash", "aiHash", "messageId", "liveMessageIds", "sourceMessageIds", "messageSignature", "messageSignatureHash", "userPreview", "aiPreview", "memoryKey", "status", "reason", "runtimeMode", "runtimeReliability", "finalizedAt", "updatedAt", "deletedAt", "deletionReason", "supersededAt", "supersededBy", "supersededByHash", "supersededByTurnKey", "supersedeReason" ];
  const TURN_NUMBER_FIELDS = [ "version", "turn", "turnAnchor", "turnAnchorTurn", "lockedTurn", "finalizedTurn", "finalizedAt", "updatedAt", "deletedAt", "supersededAt" ];
  const PROSPECTIVE_UNSUPPORTED_FIELDS = [ "schema", "state", "analysisEligible", "replacementEligible", "reason" ];
  function prospectiveReceiptValid(receipt) {
    if (!keys(receipt, PROSPECTIVE_FIELDS, [ "schema", "state", "analysisEligible", "replacementEligible", "reason" ]) || receipt.schema !== "wm.prospective-source.v1" || receipt.analysisEligible !== false || receipt.replacementEligible !== false || !str(receipt.reason)) return false;
    if (receipt.state === "unsupported") return keys(receipt, PROSPECTIVE_UNSUPPORTED_FIELDS, PROSPECTIVE_UNSUPPORTED_FIELDS);
    if (receipt.state !== "bound" || !keys(receipt, PROSPECTIVE_FIELDS, PROSPECTIVE_FIELDS)) return false;
    return [ "requestId", "canonicalScope", "characterId", "chatId", "bindingAuthority" ].every(key => str(receipt[key])) && validScope(receipt.canonicalScope) && count(receipt.resetGeneration) && count(receipt.originMessageCount) && receipt.originMessageCount > 0 && STRING_LIST(receipt.userIds) && receipt.userIds.length > 0 && STRING_LIST(receipt.assistantIds) && receipt.assistantIds.length > 0 && new Set(receipt.userIds).size === receipt.userIds.length && new Set(receipt.assistantIds).size === receipt.assistantIds.length && receipt.bindingAuthority === "registered_request_and_accepted_host_response" && receipt.reason === "derived_attribution_unproven";
  }
  function turnRecordValid(record) {
    return keys(record, TURN_RECORD_FIELDS) && Object.entries(record).every(([key, value]) => key === "sourceReceipt" ? value === null || prospectiveReceiptValid(value) : TURN_NUMBER_FIELDS.includes(key) ? count(value) && (key !== "version" || value === 1) : [ "liveMessageIds", "sourceMessageIds" ].includes(key) ? STRING_LIST(value) : key === "messageId" && value === null ? true : str(value));
  }
  function turnStateValid(state) {
    return plain(state) && keys(state, TURN_STATE_FIELDS, [ "version", "scopeKey", "records" ]) && state.version === 1 && validScope(state.scopeKey) && Array.isArray(state.records) && state.records.every(turnRecordValid) && Object.entries(state).every(([key, value]) => [ "version", "records", "scopeKey" ].includes(key) ? true : key === "updatedAt" ? count(value) : key === "kind" ? value === "v42_turn_records" : key === "recordFormat" ? value === "compact_v2" : str(value));
  }
  function safeLore(entry) {
    if (!loreMetadataValid(entry) || !LORE_CANONICAL.includes(entry.comment)) return false;
    if (entry.comment === "lmai_turn_records") {
      let state;
      try {
        state = JSON.parse(entry.content);
      } catch (_) {
        return false;
      }
      return turnStateValid(state);
    }
    return true;
  }
  const safeNativeLore = entry => safeLore(entry) || loreMetadataValid(entry) && LORE_DERIVED.includes(entry.comment);
  // These are the exact state/shard/item metadata families produced by
  // ColdArchiveManager.normalizeState/normalizeShard. Narrative strings stay
  // untouched; unrecognized structured metadata prevents export of the frame.
    const PREVIEW_STATE_FIELDS = [ "schema", "version", "kind", "maxShards", "shards", "lastUpdated" ];
  const PREVIEW_SHARD_FIELDS = [ "schema", "id", "domain", "reason", "scopeKey", "chatId", "characterId", "persistentShardId", "createdAt", "updatedAt", "turnRange", "entryCount", "sourceIds", "itemHashes", "entities", "topics", "summary", "items" ];
  const PREVIEW_ITEM_FIELDS = [ "id", "persistentRecordId", "persistentShardId", "turn", "importance", "ttl", "sourceMessageIds", "sourceHash", "hash", "preview", "entities", "topics" ];
  function coldPreviewValid(value) {
    if (!plain(value) || !keys(value, PREVIEW_STATE_FIELDS, [ "schema", "shards" ]) || value.schema !== "libra.cold_archive.v1" || !Array.isArray(value.shards)) return false;
    if (Object.entries(value).some(([key, item]) => [ "schema", "shards" ].includes(key) ? false : key === "version" ? item !== 1 : key === "kind" ? item !== "cold_archive" : !count(item))) return false;
    return value.shards.every(shard => {
      if (!keys(shard, PREVIEW_SHARD_FIELDS, [ "items" ]) || !Array.isArray(shard.items)) return false;
      if (Object.entries(shard).some(([key, item]) => key === "items" ? false : key === "schema" ? item !== "libra.cold_archive.v1" : key === "turnRange" ? !turnRangeValid(item) : [ "createdAt", "updatedAt", "entryCount" ].includes(key) ? !count(item) : [ "sourceIds", "itemHashes", "entities", "topics" ].includes(key) ? !STRING_LIST(item) : !str(item))) return false;
      return shard.items.every(record => keys(record, PREVIEW_ITEM_FIELDS) && Object.entries(record).every(([key, item]) => [ "sourceMessageIds", "entities", "topics" ].includes(key) ? STRING_LIST(item) : key === "turn" ? count(item) : [ "importance", "ttl" ].includes(key) ? typeof item === "number" && Number.isFinite(item) : str(item)));
    });
  }
  const INDEX_FIELDS = [ "version", "scopeKey", "updatedAt", "records", "previousPageKey", "pageCount", "recordCount" ];
  const INDEX_REF_FIELDS = [ "recordKey", "recordId", "observedAt", "responseHash", "rawHash", "journalSequence", "requestSequence" ];
  function nativeIndexValid(row, lookup) {
    const value = row.value;
    if (!keys(value, INDEX_FIELDS, [ "version", "scopeKey", "records" ]) || ![ 1, 2 ].includes(value.version) || !validScope(value.scopeKey) || !Array.isArray(value.records)) return false;
    const root = `libra.v5.ltm.turn-ledger::${stableHash(value.scopeKey)}::${encodeURIComponent(value.scopeKey)}::index`;
    const pageSuffix = row.key.slice(root.length), pageMatch = /^::page::([1-9][0-9]*)$/.exec(pageSuffix);
    if (row.key !== root && (!row.key.startsWith(root) || !pageMatch || !count(Number(pageMatch[1])))) return false;
    if ([ "updatedAt", "pageCount", "recordCount" ].some(key => Object.hasOwn(value, key) && !count(value[key])) || Object.hasOwn(value, "previousPageKey") && !str(value.previousPageKey)) return false;
    if (pageMatch) {
      const number = Number(pageMatch[1]);
      if (value.version !== 2 || value.previousPageKey !== (number === 1 ? "" : root + "::page::" + (number - 1))) return false;
    }
    return value.records.every(ref => {
      if (!keys(ref, INDEX_REF_FIELDS, [ "recordKey", "recordId" ]) || !str(ref.recordId) || ref.recordKey !== rawKeyFor(value.scopeKey, ref.recordId) || Object.entries(ref).some(([key, item]) => [ "observedAt", "journalSequence", "requestSequence" ].includes(key) ? !count(item) : !str(item))) return false;
      const receipt = lookup.get(row.store + "\n" + ref.recordKey)?.value;
      return receipt && receipt.scopeKey === value.scopeKey && receipt.recordKey === ref.recordKey && receipt.recordId === ref.recordId && [ "responseHash", "rawHash", "requestSequence" ].every(key => !Object.hasOwn(ref, key) || ref[key] === receipt[key]);
    });
  }
  const typedFamilyMatches = (key, schema) => key === "lmai_secret_knowledge" || schema === "wm.private-config.v1" && key === "wm.private-config" || schema === "wm.execution-capture.v1" && key === "wm.execution-capture" || schema === "wm.execution-state.v1" && key === "wm.execution-state" || schema === "wm.derived-cache.v1" && key.startsWith("wm.derived.") || schema === "wm.raw-turn.v1" && key.startsWith("wm.raw.") || schema === "wm.raw-history.v1" && key.startsWith("wm.raw-history.") || [ "wm.cold-shard.v1", "wm.cold-manifest.v1", "wm.extension-history-page.v1" ].includes(schema) && key.startsWith("wm.cold.") || schema === "wm.lineage.v1" && key.startsWith("wm.lineage.") || schema === "wm.orphan.v1" && key.startsWith("wm.orphan.");
  const ownedKey = k => /^(?:LIBRA_DATA::|LIBRA_WORLDLINE::|libra\.v[^.]+\.ltm\.turn-ledger::|libra:v[^:]+:|wm\.|lmai_|LMAI_)/.test(k);
  function excludedPrivateRoot(key) {
    const root = key.split("::chunk:v1:")[0];
    return ["LMAI_Config", "wm.server-connection.v1"].includes(root) || ["wm.operation-journal.v1","wm.pending-import.v1","wm.storage-route.v1","wm.migration-journal.v1","wm.handoff-journal.v1"].includes(root) || /^LMAI_DebugRecent_v2::[a-z0-9]+$/.test(root) ? root : null;
  }
  const domainForKey = k => k.startsWith("LIBRA_DATA") ? "canonical" : k.startsWith("LIBRA_WORLDLINE") ? "lineage" : (k.startsWith("libra:v") || k.startsWith("wm.cold.")) ? "cold" : k.includes("turn-ledger") ? "raw" : "orphan";
  const schemaMap = freeze({
    schema: "wm.storage-schema-map.v1",
    owner: "wm",
    pluginId: "libra_world_manager",
    keysBounded: false,
    knownFamilies: [ {
      family: "LMAI_Config|wm.server-connection.v1",
      schema: "WM common settings",
      classification: "private",
      exportOwner: "local_only",
      policy: "exact source settings key; current compatibility chunk ownership checked without reading/exporting their contents; stale/unowned chunks block; no settings, API keys, auth headers, tokens, or preset payload export"
    }, {
      family: "wm.operation-journal.v1|wm.pending-import.v1|wm.storage-route.v1|wm.migration-journal.v1|wm.handoff-journal.v1",
      schema: "WM operational metadata",
      classification: "private",
      exportOwner: "local_only",
      policy: "exact operational roots and current verified compatibility chunks only; excluded from memory payload/digest; retained locally; exclusion never qualifies durability or fencing"
    }, {
      family: "LMAI_DebugRecent_v2::<hash>",
      schema: "libra.debug.plugin-storage.v1",
      classification: "private",
      exportOwner: "local_only",
      policy: "exact debug/job-capture namespace; no diagnostic payload export"
    }, {
      family: "libra:v1:hme-derived:<hash>:scope|graph",
      schema: "libra.hme.scope_index.v1/libra.hme.graph_index.v1-v2",
      classification: "derived",
      exportOwner: "local_only",
      policy: "source-grounded schema and shape; unknown schema/suffix closes completeness; never adopted"
    }, {
      family: "turn-ledger record::publication",
      schema: "legacy publication marker",
      classification: "derived",
      exportOwner: "local_only",
      policy: "validate existing receipt/page binding; never export or replay publication authority"
    }, {
      family: "hostCatalog.readWmScope(scopeKey)",
      schema: "sourceIdentity/revision-bound WM lore and lineage observation",
      classification: "orphan/lineage",
      exportOwner: "wm",
      policy: "WM-only allowlisted lore; exclude other host content; absence/fault/foreign identity/drift closes completeness"
    }, {
      family: "LIBRA_DATA::v1::<stableHash(scope)>",
      schema: "wm.canonical-raw.v1",
      classification: "canonical",
      exportOwner: "wm",
      policy: "exact verified UTF-8 envelope; unsupported/derived embedded state blocks canonical export"
    }, {
      family: "LIBRA_WORLDLINE::v1::<stableHash(scope)>",
      schema: "libra_turn_worldline_v1",
      classification: "lineage",
      exportOwner: "wm",
      policy: "exact bytes and node/binding references verified"
    }, {
      family: "libra.v5.ltm.turn-ledger::<hash>::<encoded scope>::record::<encoded id>",
      schema: "wm.raw-turn.v1",
      classification: "raw",
      exportOwner: "wm",
      policy: "immutable source identity/text/legacy hashes; safe projection excludes private capture and authority"
    }, {
      family: "turn-ledger record::status",
      schema: "wm.raw-history.v1",
      classification: "preserve_inert",
      exportOwner: "wm",
      policy: "safe historical observation only; statuses normalized interrupted; never runnable"
    }, {
      family: "turn-ledger index/index::page::<n>",
      schema: "legacy-index.v1-v2",
      classification: "derived",
      exportOwner: "local_only",
      policy: "validate references; scan keys rather than pending index"
    }, {
      family: "libra:v1:<scopeHash>:archive:manifest",
      schema: "libra.persistent_memory_manifest.v1",
      classification: "cold",
      exportOwner: "wm",
      policy: "exact bytes/checksum/owner/reference closure"
    }, {
      family: "libra:v1:<scopeHash>:archive:shard:<id>",
      schema: "libra.persistent_memory_shard.v1",
      classification: "cold",
      exportOwner: "wm",
      policy: "actual full raw records; never preview fallback"
    }, {
      family: "libra:v1:<scopeHash>:archive:wal",
      schema: "wm.raw-history.v1",
      classification: "preserve_inert",
      exportOwner: "wm",
      policy: "stopped history projection; unknown fields block; no replay"
    }, {
      family: "wm.raw./wm.cold./wm.lineage./wm.orphan.",
      schema: "A1 explicit RECORD_FIELDS",
      classification: "typed",
      exportOwner: "wm",
      policy: "schema and fields must match; origin and raw bytes unchanged"
    }, {
      family: "wm.private-config/wm.execution-capture",
      schema: "wm.private-config.v1/wm.execution-capture.v1",
      classification: "private",
      exportOwner: "local_only",
      policy: "no payload export"
    }, {
      family: "wm.execution-state",
      schema: "wm.execution-state.v1",
      classification: "preserve_inert",
      exportOwner: "wm",
      policy: "jobId source reference plus interrupted status only"
    }, {
      family: "wm.derived./lmai known derived",
      schema: "wm.derived-cache.v1",
      classification: "derived",
      exportOwner: "local_only",
      policy: "preserved locally; not adopted"
    }, {
      family: "unsupported versions of LIBRA_DATA::, LIBRA_WORLDLINE::, libra.v*.ltm.turn-ledger::, libra:v*: and unknown owned family/schema",
      schema: null,
      classification: "unknown",
      exportOwner: "local_only",
      policy: "broad known-family ownership recognition precedes supported-version classification; source preserved and completeness gate closed"
    } ],
    fields: {
      loreText: LORE_TEXT_FIELDS,
      loreNumbers: LORE_NUMBER_FIELDS,
      loreBooleans: LORE_BOOLEAN_FIELDS,
      loreArrays: LORE_ARRAY_FIELDS,
      turnState: TURN_STATE_FIELDS,
      turnRecord: TURN_RECORD_FIELDS,
      turnNumbers: TURN_NUMBER_FIELDS,
      prospective: PROSPECTIVE_FIELDS,
      prospectiveUnsupported: PROSPECTIVE_UNSUPPORTED_FIELDS,
      index: INDEX_FIELDS,
      indexReferences: INDEX_REF_FIELDS,
      coldPreviewState: PREVIEW_STATE_FIELDS,
      coldPreviewShard: PREVIEW_SHARD_FIELDS,
      coldPreviewItem: PREVIEW_ITEM_FIELDS,
      rawImmutable: RAW_IMMUTABLE,
      rawHistory: RAW_HISTORY,
      rawPrivate: RAW_PRIVATE,
      canonical: CANONICAL_FIELDS,
      lore: LORE_FIELDS,
      loreCanonical: LORE_CANONICAL,
      loreDerived: LORE_DERIVED,
      loreUnsupported: LORE_UNSUPPORTED,
      worldline: WORLDLINE_FIELDS,
      node: NODE_FIELDS,
      binding: BINDING_FIELDS,
      coldManifest: COLD_MANIFEST_FIELDS,
      coldRef: COLD_REF_FIELDS,
      coldShard: COLD_SHARD_FIELDS,
      coldWal: COLD_WAL_FIELDS
    }
  });
  // Reuse A1 portable SHA-256 only for exact synchronous canonical-ID validation.
    const sha256Stream = () => {
    const K = new Uint32Array([ 1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298 ]);
    const h = new Uint32Array([ 1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225 ]), tail = new Uint8Array(64), w = new Uint32Array(64);
    let used = 0, total = 0, done = false;
    const r = (x, n) => x >>> n | x << 32 - n;
    const block = (b, off) => {
      for (let i = 0; i < 16; i++) {
        const j = off + 4 * i;
        w[i] = b[j] << 24 | b[j + 1] << 16 | b[j + 2] << 8 | b[j + 3];
      }
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15], y = w[i - 2];
        w[i] = w[i - 16] + (r(x, 7) ^ r(x, 18) ^ x >>> 3) + w[i - 7] + (r(y, 17) ^ r(y, 19) ^ y >>> 10) >>> 0;
      }
      let [a, bv, c, d, e, f, g, v] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = v + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + (e & f ^ ~e & g) + K[i] + w[i] >>> 0, t2 = (r(a, 2) ^ r(a, 13) ^ r(a, 22)) + (a & bv ^ a & c ^ bv & c) >>> 0;
        v = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = bv;
        bv = a;
        a = t1 + t2 >>> 0;
      }
      [ a, bv, c, d, e, f, g, v ].forEach((v, i) => h[i] = h[i] + v >>> 0);
    };
    const update = bytes => {
      if (done) throw Error("portable_hash_finalized");
      total += bytes.length;
      let i = 0;
      if (used) {
        const n = Math.min(64 - used, bytes.length);
        tail.set(bytes.subarray(0, n), used);
        used += n;
        i = n;
        if (used === 64) {
          block(tail, 0);
          used = 0;
        }
      }
      for (;i + 64 <= bytes.length; i += 64) block(bytes, i);
      if (i < bytes.length) {
        tail.set(bytes.subarray(i));
        used = bytes.length - i;
      }
    };
    const hex = () => {
      if (done) throw Error("portable_hash_finalized");
      done = true;
      const end = new Uint8Array(used < 56 ? 64 : 128);
      end.set(tail.subarray(0, used));
      end[used] = 128;
      const view = new DataView(end.buffer);
      view.setUint32(end.length - 8, Math.floor(total / 536870912));
      view.setUint32(end.length - 4, total * 8 >>> 0);
      for (let i = 0; i < end.length; i += 64) block(end, i);
      return Array.from(h, v => v.toString(16).padStart(8, "0")).join("");
    };
    return {
      update: update,
      hex: hex
    };
  };
  const hashSync = bytes => {
    const hash = sha256Stream();
    hash.update(bytes);
    return hash.hex();
  };
  function validateInventoryItem(v) {
    if (!plain(v)) return {
      ok: false,
      reason: "non_plain_data"
    };
    if (v.domain !== "canonical") return C.validateItem(v);
    const projected = C.validateItem({
      ...v,
      domain: "orphan",
      schema: "wm.orphan.v1",
      disposition: null
    });
    if (!projected.ok || v.logicalId !== "canonical-" + hashSync(utf8(v.originScope)) || v.schema !== C.CANONICAL_SCHEMA || !keys(v.disposition, [ "tombstone" ], [ "tombstone" ]) || typeof v.disposition.tombstone !== "boolean" || v.disposition.tombstone && (v.bytes !== 0 || v.sha256 !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" || v.dependencies.length)) return {
      ok: false,
      reason: "canonical_descriptor_invalid"
    };
    return {
      ok: true
    };
  }
  function compareUtf8(a, b) {
    const x = utf8(a), y = utf8(b), end = Math.min(x.length, y.length);
    for (let i = 0; i < end; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
  }
  // Ordinary native-record projection for the separately versioned manual profile.
  // No host/native authority is inferred from these shape checks.
  function manualKeyKind(key) {
    if(typeof key!=='string')return 'unknown';
    if(excludedPrivateRoot(key)||key.startsWith('WMManual::')||key.startsWith('libra:v1:hme-derived:')
      ||key.endsWith('::publication')||/^libra:v1:[^:]+:archive:wal$/.test(key)
      ||['wm.private-config','wm.execution-capture','wm.execution-state'].includes(key)||key.startsWith('wm.derived.'))return 'private';
    if(key.startsWith('LIBRA_DATA::v1::'))return 'canonical';
    if(key.startsWith('LIBRA_WORLDLINE::v1::')||key.startsWith('wm.lineage.'))return 'lineage';
    if(key.startsWith('libra.v5.ltm.turn-ledger::'))return key.endsWith('::status')?'raw_history':'raw';
    if(/^libra:v1:[^:]+:archive:(?:manifest|shard:)/.test(key)||key.startsWith('wm.cold.'))return 'cold';
    if(key.startsWith('wm.raw-history.'))return 'raw_history';if(key.startsWith('wm.raw.'))return 'raw';
    if(key.startsWith('wm.orphan.')||key==='lmai_secret_knowledge')return 'orphan';
    return ownedKey(key)?'unknown':'private';
  }
  function projectManualRecord(key,raw,{historical=false}={}) {
    const kind=manualKeyKind(key);if(kind==='private')return {kind,raw:null,private:null};
    if(kind==='unknown'||typeof raw!=='string')throw error('manual_record_unsupported');
    let value;try{value=JSON.parse(raw);}catch{throw error('manual_record_unsupported');}
    if(!plain(value)||!value||typeof value!=='object'||Array.isArray(value))throw error('manual_record_unsupported');
    let out=value,privateFields={};
    if(key.startsWith('LIBRA_DATA::v1::')){
      if(!keys(value,CANONICAL_FIELDS,['version','scopeKey','entries'])||![1,'1.0'].includes(value.version)||!validScope(value.scopeKey)||!Array.isArray(value.entries)||!value.entries.every(safeNativeLore))throw error('manual_record_unsupported');
      if(value.entries.some(e=>LORE_DERIVED.includes(e.comment))){out={...value,entries:value.entries.filter(safeLore)};if(Object.hasOwn(out,'entryCount'))out.entryCount=out.entries.length;}
      if(Object.hasOwn(value,'reanalysisRevision')){privateFields.reanalysisRevision=value.reanalysisRevision;out={...out};delete out.reanalysisRevision;}
    }else if(key.startsWith('LIBRA_WORLDLINE::v1::')){
      if(!keys(value,WORLDLINE_FIELDS,WORLDLINE_FIELDS.filter(k=>k!=='cutoffTurn'))||value.version!=='libra_turn_worldline_v1'||!Array.isArray(value.nodes)||value.nodes.some(n=>!keys(n,NODE_FIELDS,NODE_FIELDS)))throw error('manual_record_unsupported');
    }else if(key.startsWith('libra.v5.ltm.turn-ledger::')){
      if(key.endsWith('::status')){
        if(!keys(value,['version','recordKey','scopeKey','rawHash','patch'],['version','recordKey','scopeKey','rawHash','patch'])||!keys(value.patch,[...RAW_HISTORY,...RAW_PRIVATE]))throw error('manual_record_unsupported');
        privateFields=Object.fromEntries(RAW_PRIVATE.filter(k=>Object.hasOwn(value.patch,k)).map(k=>[k,value.patch[k]]));
        out={...value,patch:Object.fromEntries(RAW_HISTORY.filter(k=>Object.hasOwn(value.patch,k)).map(k=>[k,value.patch[k]]))};
        if(historical)out.patch={...out.patch,status:'terminal',analysisStatus:'terminal'};
      }else if(/::index(?:::page::[0-9]+)?$/.test(key)){
        if(!keys(value,INDEX_FIELDS,['version','scopeKey','records'])||!Array.isArray(value.records)||value.records.some(r=>!keys(r,INDEX_REF_FIELDS,['recordId','recordKey'])))throw error('manual_record_unsupported');
      }else{
        if(!keys(value,[...RAW_IMMUTABLE,...RAW_HISTORY,...RAW_PRIVATE],['version','kind','recordId','recordKey','scopeKey','userText','assistantText'])||value.kind!=='libra_raw_turn'||value.recordKey!==key||key!==rawKeyFor(value.scopeKey,value.recordId))throw error('manual_record_unsupported');
        privateFields=Object.fromEntries(RAW_PRIVATE.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
        out=Object.fromEntries([...RAW_IMMUTABLE,...RAW_HISTORY].filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
        if(historical)out={...out,status:'terminal',analysisStatus:'terminal'};
      }
    }else if(key.startsWith('libra:v1:')){
      const fields=value.schema==='libra.persistent_memory_manifest.v1'?COLD_MANIFEST_FIELDS:value.schema==='libra.persistent_memory_shard.v1'?COLD_SHARD_FIELDS:null;
      if(!fields||!keys(value,fields,fields)||value.records?.some(r=>!keys(r,['id','entry'],['id','entry'])||!safeLore(r.entry)))throw error('manual_record_unsupported');
    }else if(!typedFamilyMatches(key,value.schema??null)||!['memory','raw','history','cold','lineage','orphan'].includes(C.classifyOwnedRecord({key,schema:value.schema??null,value}).kind)){
      const classified=C.classifyOwnedRecord({key,schema:value.schema??null,value});if(classified.kind==='unknown'||classified.kind==='private'||classified.kind==='derived')throw error('manual_record_unsupported');
    }
    return {kind,raw:out===value?raw:JSON.stringify(out),private:privateFields};
  }
  function createWmInventory({nativeStores: nativeStores, hostCatalog: hostCatalog, classify: classify = C?.classifyOwnedRecord, limits: limits = {}, manualProfile = false} = {}) {
    if (typeof manualProfile !== "boolean") throw error("native_adapters_required");
    const inventoryLore = entry => manualProfile ? safeNativeLore(entry) : safeLore(entry);
    if (!C || !nativeStores || !nativeStores.plugin || !nativeStores.local || !hostCatalog || typeof hostCatalog.listScopes !== "function" || typeof classify !== "function") throw error("native_adapters_required");
    if (!plain(limits) || !keys(limits, Object.keys(DEFAULT_LIMITS)) || Object.values(limits).some(v => !Number.isSafeInteger(v) || v <= 0)) throw error("limits_invalid");
    const L = freeze({
      ...DEFAULT_LIMITS,
      ...limits
    }), snapshots = new Map;
    let retainedBytes = 0, opening = false;
    const hash = s => C.hashBytes(utf8(s)), id = () => {
      if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
      if (typeof require === "function") return require("node:crypto").randomUUID();
      throw error("random_source_unavailable");
    };
    function request(v, fields, required = fields) {
      if (!plain(v) || !keys(v, fields, required)) throw error("non_plain_data");
    }
    const caps = freeze({
      schema: "wm.native-inventory-capabilities.v1",
      limits: L,
      keysBounded: false,
      keyListMemoryAccounting: "UTF-16 key code units * 2 + 16 bytes/key estimate; full host allocation precedes check",
      snapshotStorage: "bounded process memory",
      fenceQualified: false,
      chunkReads: true
    });
    function getSnapshot(snapshotId) {
      if (!str(snapshotId) || !snapshots.has(snapshotId)) throw error("snapshot_missing");
      return snapshots.get(snapshotId);
    }
    const add = (a, b) => {
      if (a > Number.MAX_SAFE_INTEGER - b) throw error("byte_total_overflow");
      return a + b;
    };
    async function openInner(input) {
      request(input, [ "fence" ]);
      request(input.fence, [ "routeGeneration" ]);
      if (!str(input.fence.routeGeneration) || !input.fence.routeGeneration) throw error("fence_context_invalid");
      if (snapshots.size >= L.maxSnapshots) throw error("snapshot_capacity");
      const snapshotId = id(), state = {
        snapshotId: snapshotId,
        scopeRefs: [],
        routeGeneration: input.fence.routeGeneration,
        items: [],
        payloads: new Map,
        errors: [],
        evidence: [],
        keyLists: new Map,
        catalog: null,
        cursors: new Map,
        starts: new Set,
        readCount: 0,
        sourceBytes: 0,
        hostEvidence: [],
        manualHosts: [],
        manualRecords: [],
        bytes: 0,
        descriptorBytes: 0,
        scopeSet: new Set,
        complete: false
      };
      const fail = (code, domain = "orphan", logicalId) => {
        if (!REASONS.has(code)) code = "unknown_owned_schema";
        if (!DOMAINS.includes(domain)) domain = "orphan";
        if (state.errors.length < L.maxErrors) state.errors.push({
          code: code,
          domain: domain,
          ...logicalId ? {
            logicalId: logicalId
          } : {}
        }); else if (state.errors.at(-1)?.code !== "error_budget_exceeded") state.errors.push({
          code: "error_budget_exceeded",
          domain: "orphan"
        });
      };
      const safeId = async (store, key) => "source-" + await hash(store + "\n" + key);
      async function read(store, key) {
        if (++state.readCount > L.maxVerificationReads) throw error("verification_read_budget");
        const adapter = nativeStores[store];
        if (typeof adapter.getItem !== "function") throw error("storage_read_unavailable");
        let raw;
        try {
          raw = await adapter.getItem(key, {
            strict: true
          });
        } catch (_) {
          throw error("storage_read_failed");
        }
        if (raw != null && !str(raw)) throw error("storage_value_not_raw_string");
        if (raw != null && utf8(raw).length > L.maxSourceValueBytes) throw error("source_value_byte_limit");
        state.sourceBytes = add(state.sourceBytes, raw == null ? 0 : utf8(raw).length);
        if (state.sourceBytes > L.maxSourceScanBytes) throw error("source_scan_byte_limit");
        state.evidence.push({
          store: store,
          key: key,
          sha256: raw == null ? null : await hash(raw)
        });
        return raw;
      }
      async function list(store) {
        const adapter = nativeStores[store];
        if (typeof adapter.keys !== "function") throw error("storage_keys_unavailable");
        let out;
        try {
          out = await adapter.keys({
            strict: true
          });
        } catch (_) {
          throw error("storage_keys_failed");
        }
        if (!plain(out) || !Array.isArray(out) || out.some(k => !str(k)) || new Set(out).size !== out.length) throw error("storage_keys_invalid");
        let bytes = 0, memory = 0;
        for (const k of out) {
          bytes = add(bytes, utf8(k).length);
          memory = add(memory, add(k.length * 2, 16));
        }
        if (out.length > L.maxKeyListItems) throw error("host_key_list_item_limit");
        if (bytes > L.maxKeyListBytes) throw error("host_key_list_byte_limit");
        if (memory > L.maxKeyListMemoryBytes) throw error("host_key_list_memory_limit");
        const owned = out.filter(ownedKey).sort();
        state.keyLists.set(store, owned);
        return owned;
      }
      async function append(domain, schema, logicalId, originScope, raw, dependencies = [], disposition = null) {
        if (!validScope(originScope)) {
          fail("scope_unverified", domain, logicalId);
          return;
        }
        const bytes = utf8(raw), descriptor = {
          domain: domain,
          schema: schema,
          logicalId: logicalId,
          originScope: originScope,
          bytes: bytes.length,
          sha256: await C.hashBytes(bytes),
          dependencies: dependencies,
          disposition: disposition
        };
        const valid = validateInventoryItem(descriptor);
        if (!valid.ok) {
          fail("inventory_descriptor_invalid", domain, logicalId);
          return;
        }
        if (state.payloads.has(logicalId)) {
          fail("duplicate_logical_id", domain, logicalId);
          return;
        }
        const total = add(state.bytes, bytes.length), meta = add(state.descriptorBytes, utf8(canonicalJson(descriptor)).length);
        if (state.items.length >= L.maxInventoryItems || total > L.maxInventoryBytes || meta > L.maxDescriptorBytes || add(retainedBytes, add(total, meta)) > L.maxRetainedBytes) {
          fail("inventory_budget_exceeded", domain, logicalId);
          return;
        }
        state.items.push(descriptor);
        state.payloads.set(logicalId, bytes);
        state.bytes = total;
        state.descriptorBytes = meta;
        state.scopeSet.add(originScope);
      }
      let catalog = [];
      try {
        catalog = await hostCatalog.listScopes();
        if (!plain(catalog) || !Array.isArray(catalog) || catalog.length > L.maxScopes || catalog.some(c => !keys(c, [ "scopeKey", "chatId", "characterId" ], [ "scopeKey", "chatId", "characterId" ]) || !validScope(c.scopeKey) || !str(c.chatId) || !str(c.characterId)) || new Set(catalog.map(c => c.scopeKey)).size !== catalog.length) throw error("host_catalog_invalid");
        state.catalog = await hash(canonicalJson(catalog));
      } catch (_) {
        fail("host_catalog_unavailable");
        catalog = [];
      }
      const scopeContexts = new Map(catalog.map(c => [ c.scopeKey, clone(c) ])), hostScopes = new Set(scopeContexts.keys());
      const rows = [], physicalChunks = new Map, referencedChunks = new Set, privateChunks = new Map, privateRoots = new Map;
      let scanStopped = false;
      for (const store of [ "plugin", "local" ]) {
        if (scanStopped) break;
        let listKeys;
        try {
          listKeys = await list(store);
        } catch (e) {
          fail(e.code?.slice(3) || "storage_keys_failed");
          continue;
        }
        for (const key of listKeys) {
          const logicalId = await safeId(store, key);
          const privateRoot = excludedPrivateRoot(key);
          if (privateRoot) {
            const identity = store + "\n" + privateRoot;
            privateRoots.set(identity, {
              store: store,
              key: privateRoot
            });
            if (key !== privateRoot) privateChunks.set(store + "\n" + key, {
              store: store,
              key: key,
              logicalId: logicalId,
              root: privateRoot
            });
            continue;
          }
          try {
            const raw = await read(store, key);
            if (raw == null) {
              fail("enumerated_record_missing", domainForKey(key), logicalId);
              continue;
            }
            let value;
            try {
              value = JSON.parse(raw);
            } catch (_) {
              if (key.includes("::chunk:v1:")) {
                rows.push({
                  store: store,
                  key: key,
                  raw: raw,
                  value: null,
                  logicalId: logicalId,
                  chunk: true
                });
                continue;
              }
              fail("unknown_owned_schema", domainForKey(key), logicalId);
              continue;
            }
            if (!plain(value)) {
              fail("non_plain_source", domainForKey(key), logicalId);
              continue;
            }
            rows.push({
              store: store,
              key: key,
              raw: raw,
              value: value,
              logicalId: logicalId
            });
          } catch (e) {
            fail(e.code?.slice(3) || "storage_read_failed", domainForKey(key), logicalId);
            if (e.code === "WM_verification_read_budget" || e.code === "WM_source_scan_byte_limit") {
              scanStopped = true;
              break;
            }
          }
        }
      }
      // Compatibility chunk roots are resolved by the strict adapter. Enumerated physical
      // chunks still require a valid owning root, including generations left orphaned locally.
            for (const row of rows) {
        if (row.value?.__libraChunkedStorageV1 === true) {
          fail("storage_adapter_not_strict", domainForKey(row.key), row.logicalId);
        }
        if (row.key.includes("::chunk:v1:")) {
          physicalChunks.set(row.store + "\n" + row.key, row);
          row.chunk = true;
        }
      }
      const sourceRowLookup = new Map(rows.map(row => [ row.store + "\n" + row.key, row ]));
      for (const row of rows) {
        if (row.chunk) continue;
        const {key: key, value: v} = row;
        if (!v || typeof v !== "object") continue;
        if (key.startsWith("libra:v1:hme-derived:")) continue;
        if (key.startsWith("LIBRA_DATA::v1::") && v.schema) {
          fail("unknown_owned_schema", "canonical", row.logicalId);
          row.rejected = true;
          continue;
        }
        // Unsupported record fields cannot become exported scope provenance.
        // Discover ownership only from an explicitly supported native/typed form.
                const discoverCanonical = key.startsWith("LIBRA_DATA::v1::") && keys(v, CANONICAL_FIELDS, [ "version", "scopeKey", "entries" ]) && [ 1, "1.0" ].includes(v.version) && Array.isArray(v.entries) && v.entries.every(inventoryLore) && (!v.hostWorldlineMeta || keys(v.hostWorldlineMeta, BINDING_FIELDS, BINDING_FIELDS));
        const discoverWorldline = key.startsWith("LIBRA_WORLDLINE::v1::") && keys(v, WORLDLINE_FIELDS, WORLDLINE_FIELDS.filter(k => k !== "cutoffTurn")) && v.version === "libra_turn_worldline_v1";
        const discoverRaw = key.startsWith("libra.v5.ltm.turn-ledger::") && !key.endsWith("::status") && !key.endsWith("::publication") && v.kind === "libra_raw_turn" && [ 1, 2 ].includes(v.version) && keys(v, [ ...RAW_IMMUTABLE, ...RAW_HISTORY, ...RAW_PRIVATE ], [ "recordId", "recordKey", "scopeKey", "userText", "assistantText" ]) && rawScalarsValid(v) && v.recordKey === key && key === rawKeyFor(v.scopeKey, v.recordId);
        const indexCandidate = key.startsWith("libra.v5.ltm.turn-ledger::") && /::index(?:::page::[0-9]+)?$/.test(key);
        const discoverIndex = indexCandidate && nativeIndexValid(row, sourceRowLookup);
        if (indexCandidate && !discoverIndex) {
          fail("raw_index_invalid", "raw", row.logicalId);
          row.rejected = true;
          continue;
        }
        let discoverTyped = false;
        if (typedFamilyMatches(key, v.schema ?? null)) {
          try {
            const result = classify({
              key: key,
              schema: v.schema ?? null,
              value: v
            });
            discoverTyped = !!result.domain && result.kind !== "unknown";
          } catch (_) {}
        }
        if (!discoverCanonical && !discoverWorldline && !discoverRaw && !discoverIndex && !discoverTyped) continue;
        let scope = v.scopeKey || v.scope || v.originScope;
        if (validScope(scope)) {
          if (key.startsWith("LIBRA_DATA::v1::") && key !== canonicalKeyFor(scope) || key.startsWith("LIBRA_WORLDLINE::v1::") && key !== worldlineKeyFor(scope)) {
            fail("scope_key_mismatch", domainForKey(key), row.logicalId);
            row.rejected = true;
            continue;
          }
          if (!scopeContexts.has(scope)) {
            if (scopeContexts.size >= L.maxScopes) {
              fail("scope_budget_exceeded", "orphan", row.logicalId);
              row.rejected = true;
              continue;
            }
            const match = /^char:(.+)\|chat:(.+)\|persona:(.+)$/.exec(scope);
            scopeContexts.set(scope, {
              scopeKey: scope,
              characterId: v.characterId || (match ? match[1] : ""),
              chatId: v.chatId || (match ? match[2] : "")
            });
          }
        }
      }
      if (scopeContexts.size > L.maxScopes) fail("scope_budget_exceeded");
      const scopeHashes = new Map;
      for (const scope of scopeContexts.keys()) {
        const hashed = canonicalKeyFor(scope);
        if (scopeHashes.has(hashed) && scopeHashes.get(hashed) !== scope) fail("scope_hash_collision", "canonical"); else scopeHashes.set(hashed, scope);
      }
      const coldOwners = new Map;
      for (const ctx of scopeContexts.values()) {
        for (const c of [ ctx, {
          scopeKey: ctx.scopeKey,
          chatId: "",
          characterId: ""
        } ]) {
          const ns = persistentKeys(c).namespace;
          const previous = coldOwners.get(ns);
          if (previous && previous.scopeKey !== c.scopeKey) coldOwners.set(ns, null); else coldOwners.set(ns, c);
        }
      }
      const rawRows = new Map, statusRows = new Map, coldRows = new Map;
      for (const row of rows) {
        if (row.rejected || row.chunk) continue;
        if (row.key.startsWith("libra.v5.ltm.turn-ledger::") && row.key.includes("::record::")) {
          if (row.key.endsWith("::publication")) continue; else if (row.key.endsWith("::status")) statusRows.set(row.store + "\n" + row.key.slice(0, -8), row); else rawRows.set(row.store + "\n" + row.key, row);
        }
        if (row.key.startsWith("libra:v1:")) coldRows.set(row.store + "\n" + row.key, row);
      }
      const coldId = (store, k) => safeId(store, k), canonicalIds = new Map;
      async function loreDependencies(entries, scopeKey) {
        const dependencies = [];
        for (const entry of entries) {
          if (entry.comment === "lmai_extension_history") {
            const root = JSON.parse(entry.content);
            if (root.schema !== "wm.extension-history.v1" || root.version !== 1 || root.scope !== scopeKey || root.profile !== "native-single-runtime-readback-v1"
                || !["ready", "copying", "verifying"].includes(root.phase) || !["head", "records", "pending", "legacyRoot"].every(k => root[k] === null || /^eh-[a-f0-9]{64}$/.test(root[k]))) throw error("extension_history_manifest_invalid");
            for (const name of ["head", "records", "pending", "legacyRoot"]) if (root[name]) dependencies.push(root[name]);
          }
          if (entry.comment === "lmai_turn_records") {
            const turns = JSON.parse(entry.content);
            for (const turn of turns.records) {
              const receipt = turn.sourceReceipt;
              if (receipt?.state !== "bound") continue;
              const originals = [ ...rawRows.values() ].filter(row => row.value.recordId === receipt.requestId && row.value.canonicalScope === receipt.canonicalScope && row.value.characterId === receipt.characterId && row.value.chatId === receipt.chatId);
              if (originals.length !== 1) throw error("raw_provenance_reference_missing");
              dependencies.push("raw-" + await hash(originals[0].key));
            }
          }
          if (entry.comment === "lmai_cold_archive") {
            let preview;
            try {
              preview = JSON.parse(entry.content);
            } catch (_) {
              throw error("cold_preview_invalid");
            }
            if (!coldPreviewValid(preview)) throw error("cold_preview_invalid");
            for (const shard of preview.shards) for (const item of shard.items || []) {
              const shardId = item.persistentShardId || shard.persistentShardId;
              if (!shardId) throw error("cold_preview_without_original");
              const candidates = new Map;
              for (const context of coldOwners.values()) {
                if (context?.scopeKey !== scopeKey) continue;
                const shardKey = persistentKeys(context).shard(shardId);
                for (const store of [ "plugin", "local" ]) {
                  const identity = store + "\n" + shardKey;
                  if (coldRows.has(identity)) candidates.set(identity, coldRows.get(identity));
                }
              }
              if (candidates.size === 0) throw error("missing_cold_shard");
              if (candidates.size !== 1) throw error("cold_reference_ambiguous");
              const original = [ ...candidates.values() ][0];
              dependencies.push(await coldId(original.store, original.key));
            }
          }
        }
        return [ ...new Set(dependencies) ];
      }
      if (typeof hostCatalog.readWmScope !== "function") fail("host_scope_adapter_missing"); else for (const context of scopeContexts.values()) {
        if (!hostScopes.has(context.scopeKey)) continue;
        try {
          if (++state.readCount > L.maxVerificationReads) throw error("verification_read_budget");
          const source = await hostCatalog.readWmScope(context.scopeKey);
          if (!plain(source) || !keys(source, [ "scopeKey", "sourceIdentity", "revision", "wmLore", "lineage" ], [ "scopeKey", "sourceIdentity", "revision", "wmLore", "lineage" ]) || source.scopeKey !== context.scopeKey || !str(source.sourceIdentity) || !source.sourceIdentity || !str(source.revision) || !source.revision || !Array.isArray(source.wmLore)) throw error("host_scope_unverified");
          if (source.wmLore.some(e => !safeLore(e) && !(loreMetadataValid(e) && LORE_DERIVED.includes(e.comment)))) throw error("host_lore_unverified");
          if (source.lineage !== null && (!keys(source.lineage, BINDING_FIELDS, BINDING_FIELDS) || source.lineage.schema !== "libra.host.worldline.meta.v1" || source.lineage.scopeKey !== context.scopeKey || source.lineage.worldlineId !== context.scopeKey || !count(source.lineage.forkTurn) || !count(source.lineage.createdAt) || !bindingScalarsValid(source.lineage))) throw error("host_lineage_unverified");
          const frame = canonicalJson(source), sourceBytes = utf8(frame).length;
          state.sourceBytes = add(state.sourceBytes, sourceBytes);
          if (sourceBytes > L.maxSourceValueBytes || state.sourceBytes > L.maxSourceScanBytes) throw error("source_scan_byte_limit");
          state.hostEvidence.push({
            scopeKey: context.scopeKey,
            sourceIdentity: source.sourceIdentity,
            revision: source.revision,
            sha256: await hash(frame)
          });
          const lore = source.wmLore.filter(e => LORE_CANONICAL.includes(e.comment));
          state.manualHosts.push({scope:context.scopeKey,lore:clone(lore),lineage:clone(source.lineage)});
          if (lore.length) {
            const logicalId = "host-lore-" + await hash(context.scopeKey), wrapper = {
              schema: "wm.orphan.v1",
              originScope: context.scopeKey,
              logicalId: logicalId,
              raw: canonicalJson({
                sourceIdentity: source.sourceIdentity,
                revision: source.revision,
                wmLore: lore
              })
            };
            await append("orphan", "wm.orphan.v1", logicalId, context.scopeKey, JSON.stringify(wrapper), await loreDependencies(lore, context.scopeKey));
          }
          if (source.lineage?.parentWorldlineId) state.scopeRefs.push({
            itemId: "host-lineage-" + await hash(context.scopeKey),
            parentChatId: source.lineage.parentWorldlineId
          });
          if (source.lineage !== null) await append("lineage", "libra.host.worldline.meta.v1", "host-lineage-" + await hash(context.scopeKey), context.scopeKey, canonicalJson(source.lineage));
        } catch (e) {
          fail(e.code?.slice(3) || "host_scope_read_failed", "orphan", "host-" + await hash(context.scopeKey));
        }
      }
      for (const row of rows) {
        if (row.rejected || row.chunk) continue;
        const {store: store, key: key, raw: raw, value: v, logicalId: logicalId} = row;
        try {
          if (key.startsWith("libra:v1:hme-derived:")) {
            const supported = key.endsWith(":scope") && v.schema === "libra.hme.scope_index.v1" && Array.isArray(v.rows) || key.endsWith(":graph") && [ "libra.hme.graph_index.v1", "libra.hme.graph_index.v2" ].includes(v.schema) && Array.isArray(v.nodes) && Array.isArray(v.edges);
            if (!supported) throw error("unknown_owned_schema");
            continue;
          }
          if (key.startsWith("LIBRA_DATA::v1::")) {
            if (!keys(v, CANONICAL_FIELDS, [ "version", "scopeKey", "entries" ]) || ![ 1, "1.0" ].includes(v.version) || !validScope(v.scopeKey) || !Array.isArray(v.entries) || v.entryCount !== undefined && v.entryCount !== v.entries.length || v.resetGeneration !== undefined && !count(v.resetGeneration) || v.updatedAt !== undefined && !count(v.updatedAt)) throw error("unknown_owned_schema");
            const unknown = v.entries.some(e => !inventoryLore(e));
            if (unknown) throw error("unsupported_canonical_entry");
            if (v.hostWorldlineMeta && (!keys(v.hostWorldlineMeta, BINDING_FIELDS, BINDING_FIELDS) || v.hostWorldlineMeta.schema !== "libra.host.worldline.meta.v1" || v.hostWorldlineMeta.scopeKey !== v.scopeKey || !count(v.hostWorldlineMeta.forkTurn) || !count(v.hostWorldlineMeta.createdAt) || !bindingScalarsValid(v.hostWorldlineMeta))) throw error("lineage_binding_invalid");
            const deps = await loreDependencies(v.entries, v.scopeKey);
            if (v.hostWorldlineMeta?.parentWorldlineId) state.scopeRefs.push({
              itemId: "canonical-" + await hash(v.scopeKey),
              parentChatId: v.hostWorldlineMeta.parentWorldlineId
            });
            if (v.inheritedFrom && !v.hostWorldlineMeta) throw error("lineage_binding_missing");
            if (v.inheritedFrom && v.hostWorldlineMeta?.parentWorldlineId !== v.inheritedFrom) throw error("lineage_binding_invalid");
            const cid = "canonical-" + await hash(v.scopeKey);
            canonicalIds.set(v.scopeKey, cid);
            await append("canonical", C.CANONICAL_SCHEMA, cid, v.scopeKey, projectManualRecord(key,raw).raw, [ ...new Set(deps) ], {
              tombstone: false
            });
            continue;
          }
          if (key.startsWith("LIBRA_WORLDLINE::v1::")) {
            if (!keys(v, WORLDLINE_FIELDS, WORLDLINE_FIELDS.filter(k => k !== "cutoffTurn")) || v.version !== "libra_turn_worldline_v1" || !Array.isArray(v.nodes) || !count(v.revision) || !count(v.updatedAt) || !str(v.liveHash) || !str(v.headTurnNodeId) || v.cutoffTurn !== undefined && v.cutoffTurn !== null && !count(v.cutoffTurn) || v.nodes.some(n => !keys(n, NODE_FIELDS, NODE_FIELDS) || !str(n.turnNodeId) || !n.turnNodeId || Object.entries(n).some(([k, x]) => [ "pairIndex", "originalOrdinal", "activeOrdinal", "createdAt", "updatedAt" ].includes(k) ? !count(x) : !str(x)) || ![ "active", "quarantined", "superseded", "detached", "orphaned", "inactive_variant", "detached_branch" ].includes(n.status))) throw error("unknown_owned_schema");
            const ids = new Set(v.nodes.map(n => n.turnNodeId));
            if (ids.size !== v.nodes.length || v.headTurnNodeId && !ids.has(v.headTurnNodeId) || v.nodes.some(n => n.parentTurnNodeId && !ids.has(n.parentTurnNodeId) || n.supersededBy && !ids.has(n.supersededBy))) throw error("lineage_reference_missing");
            await append("lineage", "libra_turn_worldline_v1", logicalId, v.scopeKey, raw);
            continue;
          }
          if (key.startsWith("libra.v5.ltm.turn-ledger::") && key.endsWith("::publication")) {
            const root = key.slice(0, -13);
            if (!keys(v, [ "recordKey", "pageNumber" ], [ "recordKey", "pageNumber" ]) || v.recordKey !== root || !count(v.pageNumber) || !rawRows.has(store + "\n" + root)) throw error("raw_publication_invalid");
            continue;
          }
          if (rawRows.has(store + "\n" + key)) {
            if (!keys(v, [ ...RAW_IMMUTABLE, ...RAW_HISTORY, ...RAW_PRIVATE ], [ "version", "kind", "recordId", "recordKey", "scopeKey", "userText", "assistantText", "rawHash", "responseHash", "userBytes", "assistantBytes" ]) || ![ 1, 2 ].includes(v.version) || v.kind !== "libra_raw_turn") throw error("unsupported_raw_field");
            if (!rawScalarsValid(v)) throw error("raw_identity_invalid");
            if (!str(v.recordId) || key !== rawKeyFor(v.scopeKey, v.recordId) || v.recordKey !== key) throw error("scope_key_mismatch");
            if (!str(v.userText) || !str(v.assistantText) || v.rawHash !== stableHash(JSON.stringify([ v.userText, v.assistantText ])) || v.responseHash !== responseHash(v.assistantText) || v.userBytes !== utf8(v.userText).length || v.assistantBytes !== utf8(v.assistantText).length) throw error("raw_integrity_invalid");
            const rid = "raw-" + await hash(key), safe = Object.fromEntries(RAW_IMMUTABLE.filter(k => Object.hasOwn(v, k)).map(k => [ k, v[k] ]));
            await append("raw", "wm.raw-turn.v1", rid, v.scopeKey, JSON.stringify(safe), [], {
              analysisEligible: false,
              replacementEligible: false
            });
            let history = v;
            const side = statusRows.get(store + "\n" + key);
            if (side) {
              const m = side.value;
              if (!keys(m, [ "version", "recordKey", "scopeKey", "rawHash", "patch" ], [ "version", "recordKey", "scopeKey", "rawHash", "patch" ]) || m.version !== 1 || m.recordKey !== key || m.scopeKey !== v.scopeKey || m.rawHash !== v.rawHash || !keys(m.patch, [ ...RAW_HISTORY, ...RAW_PRIVATE ]) || RAW_IMMUTABLE.some(k => k !== "observedAt" && Object.hasOwn(m.patch, k))) throw error("raw_history_invalid");
              history = {
                ...v,
                ...m.patch
              };
            }
            if (!historyScalarsValid(history)) throw error("raw_history_invalid");
            const h = {
              schema: "wm.raw-history.v1",
              originScope: v.scopeKey,
              logicalId: rid + "-history",
              rawId: rid,
              status: historyStatus(history.analysisStatus || history.status),
              observedAt: count(v.observedAt) ? v.observedAt : 0,
              history: Object.fromEntries(RAW_HISTORY.filter(k => Object.hasOwn(history, k)).map(k => [ k, history[k] ]))
            };
            await append("raw_history", "wm.raw-history.v1", h.logicalId, v.scopeKey, JSON.stringify(h), [ rid ], {
              analysisEligible: false,
              replacementEligible: false
            });
            continue;
          }
          if (statusRows.has(store + "\n" + key.slice(0, -8))) {
            if (!rawRows.has(store + "\n" + key.slice(0, -8))) throw error("raw_receipt_missing");
            continue;
          }
          if (key.startsWith("libra.v5.ltm.turn-ledger::") && /::index(?:::page::[0-9]+)?$/.test(key)) {
            if (!nativeIndexValid(row, sourceRowLookup)) throw error("raw_index_invalid");
            continue;
          }
          if (key.startsWith("libra:v1:")) {
            const ns = key.split(":archive")[0] + ":archive", owner = coldOwners.get(ns);
            if (!owner) throw error("cold_scope_unverified");
            const expected = persistentKeys(owner);
            if (!v || v.scopeHash !== ns.split(":")[2]) throw error("cold_scope_mismatch");
            if (v.schema === "libra.persistent_memory_manifest.v1") {
              if (key !== expected.manifest || !keys(v, COLD_MANIFEST_FIELDS, COLD_MANIFEST_FIELDS) || v.version !== 1 || !checksumValid(v) || !Array.isArray(v.shards) || v.shardCount !== v.shards.length || !count(v.entryCount) || !count(v.updatedAt)) throw error("cold_manifest_invalid");
              const deps = [];
              let entries = 0;
              for (const ref of v.shards) {
                if (!keys(ref, COLD_REF_FIELDS, COLD_REF_FIELDS) || ref.key !== expected.shard(ref.id) || !count(ref.entryCount) || !count(ref.bytes) || !Array.isArray(ref.entryIds) || ref.entryIds.length !== ref.entryCount || ref.entryIds.some(x => !str(x)) || !turnRangeValid(ref.turnRange) || !count(ref.createdAt) || !str(ref.id) || !str(ref.checksum)) throw error("cold_manifest_invalid");
                const shard = coldRows.get(store + "\n" + ref.key);
                if (!shard) throw error("missing_cold_shard");
                if (shard.value.checksum !== ref.checksum || shard.value.id !== ref.id || shard.value.bytes !== ref.bytes || shard.value.entryCount !== ref.entryCount || canonicalJson(shard.value.entryIds) !== canonicalJson(ref.entryIds)) throw error("cold_reference_mismatch");
                deps.push(await coldId(store, ref.key));
                entries = add(entries, ref.entryCount);
              }
              if (entries !== v.entryCount || new Set(deps).size !== deps.length) throw error("cold_manifest_invalid");
              await append("cold", v.schema, logicalId, owner.scopeKey, raw, deps);
              continue;
            }
            if (v.schema === "libra.persistent_memory_shard.v1") {
              if (key !== expected.shard(v.id) || !keys(v, COLD_SHARD_FIELDS, COLD_SHARD_FIELDS) || v.version !== 1 || !checksumValid(v) || !Array.isArray(v.records) || !Array.isArray(v.entryIds) || !turnRangeValid(v.turnRange) || !count(v.bytes) || !count(v.createdAt) || !str(v.reason) || v.entryCount !== v.records.length || v.entryIds.length !== v.records.length || new Set(v.entryIds).size !== v.entryIds.length || v.records.some((r, i) => !keys(r, [ "id", "entry" ], [ "id", "entry" ]) || r.id !== v.entryIds[i] || !safeLore(r.entry) || r.entry.comment !== "lmai_memory")) throw error("cold_shard_invalid");
              await append("cold", v.schema, logicalId, owner.scopeKey, raw);
              continue;
            }
            if (v.schema === "libra.persistent_memory_wal.v1") {
              if (key !== expected.wal || !keys(v, COLD_WAL_FIELDS, [ "schema", "version", "transactionId", "scopeHash", "createdAt", "state", "planned", "committedShardIds", "remainingShardIds" ]) || v.version !== 1 || !str(v.transactionId) || !count(v.createdAt) || ![ "prepared", "shard_write_failed", "manifest_write_failed", "partial_committed" ].includes(v.state) || !Array.isArray(v.planned) || v.planned.some(ref => !keys(ref, [ "id", "key", "checksum", "entryIds" ], [ "id", "key", "checksum", "entryIds" ]) || !str(ref.id) || ref.key !== expected.shard(ref.id) || !str(ref.checksum) || !Array.isArray(ref.entryIds) || ref.entryIds.some(id => !str(id))) || [ "committedShardIds", "remainingShardIds", "ackedIds" ].some(k => Object.hasOwn(v, k) && (!Array.isArray(v[k]) || v[k].some(id => !str(id)))) || v.failures !== undefined && (!Array.isArray(v.failures) || v.failures.some(f => !keys(f, [ "id", "reason" ], [ "id", "reason" ]) || !str(f.id) || !str(f.reason)))) throw error("cold_wal_invalid");
              const h = {
                schema: "wm.raw-history.v1",
                originScope: owner.scopeKey,
                logicalId: logicalId + "-history",
                rawId: logicalId,
                status: "interrupted",
                observedAt: count(v.createdAt) ? v.createdAt : 0,
                history: {
                  sourceSchema: v.schema,
                  transactionId: str(v.transactionId) ? v.transactionId : "",
                  sourceState: v.state,
                  plannedShardIds: v.planned.map(ref => ref.id),
                  committedShardIds: v.committedShardIds,
                  remainingShardIds: v.remainingShardIds,
                  ackedIds: v.ackedIds || [],
                  failedShardIds: (v.failures || []).map(f => f.id)
                }
              };
              await append("raw_history", "wm.raw-history.v1", h.logicalId, owner.scopeKey, JSON.stringify(h), [], {
                analysisEligible: false,
                replacementEligible: false
              });
              continue;
            }
            throw error("unknown_owned_schema");
          }
          const schema = v?.schema ?? null;
          const familyMatches = typedFamilyMatches(key, schema);
          if (!familyMatches) throw error("unknown_owned_family");
          const result = classify({
            key: key,
            schema: schema,
            value: v
          });
          if (result.kind === "unknown") throw error("unknown_owned_schema");
          if (result.kind === "private" || result.kind === "derived") continue;
          const scope = v?.originScope || v?.scope || v?.scopeKey;
          if (schema === "wm.execution-state.v1") {
            const scopeName = validScope(scope) ? scope : "global";
            if (!scopeName) throw error("scope_unverified");
            const h = {
              schema: "wm.raw-history.v1",
              originScope: scopeName,
              logicalId: logicalId + "-history",
              rawId: logicalId,
              status: "interrupted",
              observedAt: 0,
              history: {
                sourceSchema: schema,
                sourceId: v.jobId,
                sourceState: v.state
              }
            };
            await append("raw_history", "wm.raw-history.v1", h.logicalId, scopeName, JSON.stringify(h), [], {
              analysisEligible: false,
              replacementEligible: false
            });
            continue;
          }
          if (key === "lmai_secret_knowledge") {
            const wrapper = {
              schema: "wm.orphan.v1",
              originScope: v.scopeKey,
              logicalId: logicalId,
              raw: raw
            };
            await append("orphan", "wm.orphan.v1", logicalId, v.scopeKey, JSON.stringify(wrapper));
            continue;
          }
          if (!result.domain) throw error("unknown_owned_schema");
          if (schema === "wm.lineage.v1") {
            for (const parentScope of [ v.parentScope, v.continuationOf ]) if (parentScope) state.scopeRefs.push({
              itemId: v.logicalId || logicalId,
              parentScope: parentScope
            });
          }
          const deps = schema === "wm.extension-history-page.v1" ? v.dependencies : schema === "wm.cold-manifest.v1" ? v.shards : schema === "wm.raw-history.v1" ? [ v.rawId ] : [];
          await append(result.domain, schema, v.logicalId || logicalId, scope, raw, deps, [ "raw", "raw_history", "lineage" ].includes(result.domain) ? {
            analysisEligible: false,
            replacementEligible: false
          } : null);
        } catch (e) {
          fail(e.code?.slice(3) || "unknown_owned_schema", domainForKey(key), logicalId);
        }
      }
      for (const observation of state.hostEvidence) {
        try {
          if (++state.readCount > L.maxVerificationReads) throw error("verification_read_budget");
          const current = await hostCatalog.readWmScope(observation.scopeKey);
          if (!plain(current) || await hash(canonicalJson(current)) !== observation.sha256) fail("host_scope_drift");
        } catch (e) {
          fail(e.code?.slice(3) || "host_scope_read_failed");
        }
      }
      // Host scope markers prove discovered empty scopes and WM-owned disconnected scopes;
      // absence is never manufactured into a canonical deletion/tombstone.
            for (const ctx of scopeContexts.values()) {
        if (!hostScopes.has(ctx.scopeKey) || !canonicalIds.has(ctx.scopeKey)) {
          const logicalId = "scope-" + await hash(ctx.scopeKey), record = {
            schema: "wm.orphan.v1",
            originScope: ctx.scopeKey,
            logicalId: logicalId,
            raw: canonicalJson({
              scopeKey: ctx.scopeKey,
              hostListed: hostScopes.has(ctx.scopeKey),
              canonicalPresent: canonicalIds.has(ctx.scopeKey)
            })
          };
          await append("orphan", "wm.orphan.v1", logicalId, ctx.scopeKey, JSON.stringify(record));
        }
      }
      // Private roots are excluded, but current physical chunk ownership still
      // has to be verified. Never read or hash their credential/capture contents.
            const referencedPrivateChunks = new Set;
      for (const root of privateRoots.values()) {
        const chunks = [ ...privateChunks.values() ].filter(chunk => chunk.store === root.store && chunk.root === root.key);
        if (!chunks.length) continue;
        try {
          const method = nativeStores[root.store].inventoryPhysicalKeys;
          if (typeof method !== "function" || !state.keyLists.get(root.store)?.includes(root.key)) throw error("compat_chunk_ownership_unverified");
          const current = await method(root.key);
          if (!plain(current) || !Array.isArray(current) || current.length > L.maxKeyListItems || new Set(current).size !== current.length || current.some(key => !str(key) || !key.startsWith(root.key + "::chunk:v1:"))) throw error("compat_chunk_ownership_unverified");
          for (const key of current) {
            const identity = root.store + "\n" + key;
            if (!privateChunks.has(identity)) throw error("compat_chunk_missing");
            referencedPrivateChunks.add(identity);
          }
        } catch (e) {
          fail(e.code?.slice(3) || "compat_chunk_ownership_unverified", "orphan", await safeId(root.store, root.key));
        }
      }
      for (const [identity, chunk] of privateChunks) if (!referencedPrivateChunks.has(identity)) fail("orphan_compat_chunk", "orphan", chunk.logicalId);
      for (const row of rows) {
        if (row.chunk || row.rejected) continue;
        const chunks = [ ...physicalChunks.values() ].filter(c => c.store === row.store && c.key.startsWith(row.key + "::chunk:v1:"));
        if (!chunks.length) continue;
        const method = nativeStores[row.store].inventoryPhysicalKeys;
        if (typeof method !== "function") {
          fail("compat_chunk_ownership_unverified", domainForKey(row.key), row.logicalId);
          continue;
        }
        try {
          const current = await method(row.key);
          if (!plain(current) || !Array.isArray(current) || current.some(k => !str(k))) throw error("compat_chunk_ownership_unverified");
          for (const k of current) {
            if (!physicalChunks.has(row.store + "\n" + k)) throw error("compat_chunk_missing");
            referencedChunks.add(row.store + "\n" + k);
          }
        } catch (e) {
          fail(e.code?.slice(3) || "compat_chunk_ownership_unverified", domainForKey(row.key), row.logicalId);
        }
      }
      for (const [physical, row] of physicalChunks) if (!referencedChunks.has(physical)) fail("orphan_compat_chunk", domainForKey(row.key), row.logicalId);
      for (const item of state.items.filter(i => i.domain === "canonical")) for (const lineage of state.items.filter(i => i.domain === "lineage" && i.originScope === item.originScope)) if (!item.dependencies.includes(lineage.logicalId)) item.dependencies.push(lineage.logicalId);
      for (const ref of state.scopeRefs) {
        let parentScope = ref.parentScope;
        if (ref.parentChatId) {
          const matches = [ ...scopeContexts.values() ].filter(c => c.chatId === ref.parentChatId || c.scopeKey === ref.parentChatId);
          if (matches.length !== 1) {
            fail("lineage_scope_unverified", "lineage", ref.itemId);
            continue;
          }
          parentScope = matches[0].scopeKey;
        }
        if (!scopeContexts.has(parentScope)) {
          fail("lineage_scope_unverified", "lineage", ref.itemId);
          continue;
        }
        const parentId = canonicalIds.get(parentScope) || "scope-" + await hash(parentScope), item = state.items.find(i => i.logicalId === ref.itemId);
        if (item && !item.dependencies.includes(parentId)) item.dependencies.push(parentId);
      }
      // A second source pass detects drift during the scan. This is evidence,
      // not a replacement for the future qualified host fence/CAS gate.
            if (state.errors.length === 0) for (const row of state.evidence) {
        try {
          if (++state.readCount > L.maxVerificationReads) throw error("verification_read_budget");
          const current = await nativeStores[row.store].getItem(row.key, {
            strict: true
          });
          if (current != null && !str(current) || current != null && utf8(current).length > L.maxSourceValueBytes || (current == null ? null : await hash(current)) !== row.sha256) fail("source_content_drift");
        } catch (e) {
          fail(e.code?.slice(3) || "storage_read_failed");
        }
      }
      if (state.errors.length === 0) {
        try {
          if (++state.readCount > L.maxVerificationReads) throw error("verification_read_budget");
          const current = await hostCatalog.listScopes();
          if (!plain(current) || await hash(canonicalJson(current)) !== state.catalog) fail("host_catalog_drift");
        } catch (e) {
          fail(e.code?.slice(3) || "host_catalog_unavailable");
        }
      }
      if (state.errors.length === 0) for (const [store, expected] of state.keyLists) {
        try {
          const current = await nativeStores[store].keys({
            strict: true
          });
          if (!plain(current) || !Array.isArray(current) || current.some(k => !str(k)) || canonicalJson(current.filter(ownedKey).sort()) !== canonicalJson(expected)) fail("source_key_drift");
        } catch (_) {
          fail("storage_keys_failed");
        }
      }
      for (const item of state.items) for (const dep of item.dependencies) if (!state.payloads.has(dep)) fail("dependency_missing", item.domain, item.logicalId);
      // Reject cycles rather than permitting an apparently complete but unusable closure.
            const graph = new Map(state.items.map(i => [ i.logicalId, i.dependencies ])), visited = new Set, active = new Set;
      for (const start of graph.keys()) {
        const stack = [ [ start, false ] ];
        while (stack.length) {
          const [n, end] = stack.pop();
          if (end) {
            active.delete(n);
            visited.add(n);
            continue;
          }
          if (active.has(n)) {
            fail("dependency_cycle", graph.get(n) ? state.items.find(i => i.logicalId === n).domain : "orphan", n);
            break;
          }
          if (visited.has(n) || !graph.has(n)) continue;
          active.add(n);
          stack.push([ n, true ]);
          for (const d of graph.get(n)) stack.push([ d, false ]);
        }
      }
      // Closure mutations are part of the admitted descriptor bytes, not an
      // uncharged late annotation. Retain dependencies even on an incomplete cut.
            let finalDescriptorBytes = 0;
      for (const item of state.items) {
        if (!validateInventoryItem(item).ok) fail("inventory_descriptor_invalid", item.domain, item.logicalId);
        finalDescriptorBytes = add(finalDescriptorBytes, utf8(canonicalJson(item)).length);
      }
      state.descriptorBytes = finalDescriptorBytes;
      if (state.descriptorBytes > L.maxDescriptorBytes || add(retainedBytes, add(state.bytes, state.descriptorBytes)) > L.maxRetainedBytes) fail("inventory_budget_exceeded");
      state.items.sort((a, b) => {
        if (a.domain === "canonical" && b.domain !== "canonical") return -1;
        if (b.domain === "canonical" && a.domain !== "canonical") return 1;
        const x = a.domain === "canonical" ? a.originScope : a.logicalId, y = b.domain === "canonical" ? b.originScope : b.logicalId;
        return compareUtf8(x, y);
      });
      state.counts = totals();
      state.domainBytes = totals();
      for (const item of state.items) {
        state.counts[item.domain] = add(state.counts[item.domain], 1);
        state.domainBytes[item.domain] = add(state.domainBytes[item.domain], item.bytes);
        freeze(item);
      }
      state.inventoryDigest = await hash("wm.inventory-snapshot.v1\n" + state.items.map(i => canonicalJson(i) + "\n").join(""));
      if(manualProfile){for(const row of rows){
        if(row.chunk||row.rejected||manualKeyKind(row.key)==='private')continue;
        try{const projected=projectManualRecord(row.key,row.raw,{historical:true});state.manualRecords.push({space:row.store,key:row.key,domain:projected.kind,raw:projected.raw});}
        catch{fail('unknown_owned_schema',domainForKey(row.key),row.logicalId);}
      }
      for(const host of state.manualHosts){
        const key=canonicalKeyFor(host.scope);
        if(host.lore.length){
          const existing=state.manualRecords.find(r=>r.space==='plugin'&&r.key===key),value=existing?JSON.parse(existing.raw):{version:1,scopeKey:host.scope,entries:[],entryCount:0,resetGeneration:0,...host.lineage?{hostWorldlineMeta:host.lineage}:{}};
          let changed=!existing;for(const entry of host.lore){const old=value.entries.find(e=>String(e.key||'')===String(entry.key||'')&&String(e.comment||'')===String(entry.comment||''));if(old){if(canonicalJson(old)!==canonicalJson(entry))fail('host_lore_unverified','canonical');}else{value.entries.push(entry);changed=true;}}
          if(changed){value.entryCount=value.entries.length;const raw=JSON.stringify(value);if(existing)existing.raw=raw;else state.manualRecords.push({space:'plugin',key,domain:'canonical',raw});}
        }
      }
      }
      state.complete = state.errors.length === 0;
      retainedBytes = add(retainedBytes, add(state.bytes, state.descriptorBytes));
      snapshots.set(snapshotId, state);
      return freeze({
        snapshotId: snapshotId,
        routeGeneration: state.routeGeneration,
        inventoryDigest: state.inventoryDigest,
        complete: state.complete,
        domainCounts: clone(state.counts),
        domainBytes: clone(state.domainBytes)
      });
    }
    async function open(input) {
      if (opening) throw error("snapshot_open_in_progress");
      opening = true;
      try {
        return await openInner(input);
      } finally {
        opening = false;
      }
    }
    function historyStatus(v) {
      return [ "done", "committed", "completed", "skipped", "terminal", "discarded" ].includes(v) ? "completed" : [ "failed", "error" ].includes(v) ? "failed" : [ "cancelled", "canceled" ].includes(v) ? "cancelled" : "interrupted";
    }
    async function pageInternal(input, filter = "all") {
      request(input, [ "snapshotId", "cursor", "maxItems", "maxBytes" ]);
      const state = getSnapshot(input.snapshotId);
      if (input.cursor !== null && !str(input.cursor) || !Number.isSafeInteger(input.maxItems) || input.maxItems <= 0 || input.maxItems > L.maxPageItems || !Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > L.maxPageBytes) throw error("page_limit");
      let offset = 0;
      if (input.cursor === null) {
        if (state.starts.has(filter)) throw error("inventory_cursor_replay");
      } else {
        const saved = state.cursors.get(input.cursor);
        if (!saved || saved.used || saved.filter !== filter) throw error("inventory_cursor_invalid");
        offset = saved.offset;
      }
      const selection = filter === "all" ? state.items : state.items.filter(i => {
        const [domain, scope] = JSON.parse(filter);
        return (domain === "raw" ? i.domain === "raw" || i.domain === "raw_history" : i.domain === domain) && i.originScope === scope;
      });
      const items = [], nextToken = id();
      let result;
      while (offset + items.length < selection.length && items.length < input.maxItems) {
        const candidate = [ ...items, selection[offset + items.length] ], next = offset + candidate.length < selection.length ? nextToken : null, trial = {
          snapshotId: state.snapshotId,
          cursor: input.cursor,
          nextCursor: next,
          items: candidate,
          complete: state.complete,
          errors: clone(state.errors)
        };
        if (utf8(canonicalJson(trial)).length > input.maxBytes) {
          if (items.length === 0) throw error("page_item_byte_limit");
          break;
        }
        items.push(candidate.at(-1));
      }
      const nextOffset = offset + items.length, nextCursor = nextOffset < selection.length ? nextToken : null;
      result = {
        snapshotId: state.snapshotId,
        cursor: input.cursor,
        nextCursor: nextCursor,
        items: clone(items),
        complete: state.complete,
        errors: clone(state.errors)
      };
      if (utf8(canonicalJson(result)).length > input.maxBytes) throw error("page_byte_limit");
      if (input.cursor === null) state.starts.add(filter); else state.cursors.get(input.cursor).used = true;
      if (nextCursor) state.cursors.set(nextCursor, {
        offset: nextOffset,
        filter: filter,
        used: false
      });
      return freeze(result);
    }
    async function page(input) {
      return pageInternal(input);
    }
    async function readChunk(input) {
      request(input, [ "snapshotId", "logicalId", "offset", "maxBytes" ]);
      const state = getSnapshot(input.snapshotId);
      if (!str(input.logicalId) || !count(input.offset) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > L.maxChunkBytes) throw error("chunk_invalid");
      const bytes = state.payloads.get(input.logicalId), item = state.items.find(i => i.logicalId === input.logicalId);
      if (!bytes || !item) throw error("snapshot_item_missing");
      if (input.offset > bytes.length) throw error("offset_out_of_range");
      if (await C.hashBytes(bytes) !== item.sha256) throw error("snapshot_item_integrity");
      const end = input.offset + Math.min(input.maxBytes, bytes.length - input.offset);
      return {
        bytes: bytes.slice(input.offset, end),
        offset: input.offset,
        nextOffset: end < bytes.length ? end : null,
        totalBytes: bytes.length,
        sha256: item.sha256
      };
    }
    async function verify(snapshotId) {
      const state = getSnapshot(snapshotId), errors = clone(state.errors);
      if (!state.complete) return freeze({
        complete: false,
        inventoryDigest: state.inventoryDigest,
        domainCounts: clone(state.counts),
        domainBytes: clone(state.domainBytes),
        errors: errors
      });
      let reads = 0;
      const fail = code => {
        if (!errors.some(e => e.code === code)) errors.push({
          code: code,
          domain: "orphan"
        });
      };
      for (const [store, expected] of state.keyLists) {
        try {
          const all = await nativeStores[store].keys({
            strict: true
          });
          if (!plain(all) || !Array.isArray(all) || all.some(k => !str(k)) || canonicalJson(all.filter(ownedKey).sort()) !== canonicalJson(expected)) fail("source_key_drift");
        } catch (_) {
          fail("storage_keys_failed");
        }
      }
      try {
        const current = await hostCatalog.listScopes();
        if (!plain(current) || await hash(canonicalJson(current)) !== state.catalog) fail("host_catalog_drift");
      } catch (_) {
        fail("host_catalog_unavailable");
      }
      for (const observation of state.hostEvidence) {
        try {
          if (++reads > L.maxVerificationReads) {
            fail("verification_read_budget");
            break;
          }
          const current = await hostCatalog.readWmScope(observation.scopeKey);
          if (!plain(current) || await hash(canonicalJson(current)) !== observation.sha256) fail("host_scope_drift");
        } catch (_) {
          fail("host_scope_read_failed");
        }
      }
      for (const row of state.evidence) {
        if (++reads > L.maxVerificationReads) {
          fail("verification_read_budget");
          break;
        }
        try {
          const raw = await nativeStores[row.store].getItem(row.key, {
            strict: true
          });
          if (raw != null && !str(raw) || raw != null && utf8(raw).length > L.maxSourceValueBytes || (raw == null ? null : await hash(raw)) !== row.sha256) fail("source_content_drift");
        } catch (_) {
          fail("storage_read_failed");
        }
      }
      for (const item of state.items) {
        const bytes = state.payloads.get(item.logicalId);
        if (!bytes || bytes.length !== item.bytes || await C.hashBytes(bytes) !== item.sha256) fail("snapshot_item_integrity");
      }
      return freeze({
        complete: state.complete && errors.length === 0,
        inventoryDigest: state.inventoryDigest,
        domainCounts: clone(state.counts),
        domainBytes: clone(state.domainBytes),
        errors: errors
      });
    }
    function readContext(snapshotId) {
      getSnapshot(snapshotId);
      const context = freeze({
        snapshotId: snapshotId
      });
      readContexts.set(context, input => {
        getSnapshot(snapshotId);
        return pageInternal({
          snapshotId: snapshotId,
          cursor: input.cursor,
          maxItems: input.maxItems,
          maxBytes: L.maxPageBytes
        }, JSON.stringify([ input.domain, input.scope ]));
      });
      return context;
    }
    async function close(snapshotId) {
      const state = getSnapshot(snapshotId);
      retainedBytes -= state.bytes + state.descriptorBytes;
      snapshots.delete(snapshotId);
    }
    return Object.freeze({
      capabilities: caps,
      manualRecords:snapshotId=>{const s=getSnapshot(snapshotId);if(!s.complete)throw error("inventory_incomplete");return clone(s.manualRecords);},
      open: open,
      page: page,
      readChunk: readChunk,
      verify: verify,
      readContext: readContext,
      close: close
    });
  }
  async function exportDomainPage(input, domain) {
    if (!plain(input) || !keys(input, [ "scope", "cursor", "maxItems", "readContext" ], [ "scope", "cursor", "maxItems", "readContext" ]) || ![ "raw", "cold" ].includes(domain) || !validScope(input.scope) || !readContexts.has(input.readContext)) throw error("read_context_invalid");
    return readContexts.get(input.readContext)({
      ...input,
      domain: domain
    });
  }
  return Object.freeze({
    createWmInventory: createWmInventory,
    manualKeyKind,projectManualRecord,
    createSha256Stream: sha256Stream,
    exportDomainPage: exportDomainPage,
    validateInventoryItem: validateInventoryItem,
    canonicalJson: canonicalJson,
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    schemaMap: schemaMap,
    canonicalKeyFor: canonicalKeyFor,
    worldlineKeyFor: worldlineKeyFor,
    persistentKeys: persistentKeys,
    rawKeyFor: rawKeyFor
  });
})();

if (typeof module !== "undefined" && module.exports) module.exports = WmStorageInventory;
