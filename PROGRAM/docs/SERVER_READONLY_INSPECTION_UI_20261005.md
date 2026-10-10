# Flashback read-only server inspection

This candidate connects the existing maintenance inspection UI to certified current-scope server snapshots. It does not add server repair, bootstrap a connection, refresh authentication, synchronize credentials, migrate storage, or invoke a model provider.

## Actual settings authority

Flashback's owner resolver classifies the exact key `vector_rag_memory:settings:v2` as `kind:'global'`. The ordinary SDK get/set path keeps that kind **host-local in every scope mode**. The `__memory_suite_global__` registry row governs scope-mode inheritance; it does not turn this settings key into a server-owned value. Settings are also excluded from per-scope migration.

`inspectFlashbackGlobalSettingsSnapshot()` therefore requires the actual owner classifier's exact global-key result and reads only the raw host pluginStorage settings key. It retains physical store identity, value, lifecycle and generation witnesses, returns cloned data, and rechecks those witnesses. It never reads a server settings copy or a credential key. A stale server KV settings copy has no authority even if its revision and digest are valid.

This exact authoritative host-global settings read is distinct from retained-local corpus fallback. Current-scope server records and vector sidecars come only from the certified server snapshot; local copies of that corpus are never consulted. Invalid, failed or oversized settings reads never become defaults. Documented defaults are available only after certified host absence or a valid settings envelope.

## Scope inspection

The adopted snapshot backend and response contract are unchanged. The client snapshot helper additionally retains an owner-authority epoch and rejects an already-invalid initial proof before returning it. They require an already-certified physical DATA identity, reset epoch, current URL/connection and strict server-only routing, and retain the original inventory fingerprint for revalidation. The new inspection-only context creates private cloned readers for certified current-scope values, with exact scope/key constraints and no routed/cached/local-corpus fallback.

Host character/chat/persona/source/lineage, argument settings, embedding generation, global settings and server inventory are rechecked around asynchronous inspection. Final route evidence is reread after the last host await, and retained synchronous fences run immediately before journal issuance and inspection publication. Supported owner configuration, registry and exact-settings writes advance an authority epoch, including ABA transitions. These are bounded observations, not an atomic distributed snapshot or a guarantee about later live-host changes; unobservable external raw-store ABA with no version/event cannot be certified.

`inspection.coverage` is `server_snapshot`. `snapshotHealthVerified` remains false: complete capture is not product health. The existing owner checker decodes actual shards, audits and hydrates physical vector sidecars, compares current sources and computes sanitizer/profile/episode diagnostics. Its result is reported separately as `storageSourceHealthy`.

Credential keys and the credential argument are not read by server inspection. Required credential evidence is unverified, not confirmed absent. Provider readiness is never tested. Unknown readiness is not rendered as damaged storage.

Linked archives, unsupported keys, incomplete inventory, oversized/omitted records and unverified settings remain incomplete. The dialog explains missing coverage rather than displaying placeholder counts as normal. Current-chat writers emit plain shards; real archive gzip wrappers are tested through the production decoder separately. Direct capture of a gzip wrapper is not linked-archive traversal or semantic verification.

## Journal admission and restart safety

The actual ordinary SDK setter first short-circuits to its local physical setter when the current scope is local. Only otherwise does it resolve a shared journal into its mirror route. Unrelated server scopes therefore do not block current-local inspection or repair.

Every server inspection plan remains blocked for execution. Legacy maintenance admission independently proves the current scope is local before journaling. Its journal writer is pinned to the physical local store, revalidates the actual current-scope route and authoritative settings inside the existing same-key mutation tail, and uses a per-mutation expiry guard. A queued or expired admission cannot later choose an ordinary routed/server writer. A new ordinary operation explicitly clears only a settled predecessor’s physicalRepair metadata and binds its first journal to the verified execution scope. A late active/unknown marker is checked inside the tail, preserving both its bytes and immediate in-memory retry block. Other legacy execution stages remain unchanged.

Physical repair keeps its original mutation tail and per-mutation guards. Startup recovery now first reads only the exact physical local journal key through that same tail. A valid physical-repair marker is restored in memory without a routed read or rewrite. Original persisted bytes and active/unknown state survive later mode changes, remote tombstones and restarts. Interrupted running work is displayed as abandoned in memory, while its physical uncertainty remains unresolved. A marker from another scope grants no current-scope authority and does not clear the unresolved operation.

Malformed markers, corrupt JSON or an unverified pinned read block new physical/legacy embedding work until recovery can be verified. Valid settled physical markers do not create a new block. Ordinary valid non-physical journals retain their existing recovery behavior. No new automatic release or marker-clearing action is introduced.

## Offline evidence

Tests use synthetic host/repository/transport and product-emitted values. An actual adopted public path reproduced two local journal attempts before authority rejection; no server mutation was inferred from those counts. Another adopted public repair plus SDK restart reproduced a remote tombstone deleting a physical unresolved marker and allowing a new preview after return to local mode. Corrected tests preserve the marker and keep retry blocked.

Public Full/Min tests use unmodified built artifacts with no test exports. Fixture setup establishes an existing certified connection; inspection then forbids bootstrap, ordinary server-KV reads, credential reads, retained-local corpus reads and writes. Virtual fixture timers isolate inspection from unrelated scheduled work. Retained local physical-repair regressions use their existing timer behavior. No live server, user DATA, credentials or provider is accessed.

Actual RisuAI execution was not performed. This is an informational limitation, not a required RC acceptance gate; synthetic code defects, races and regressions remain acceptance criteria. No live-provider/server/permission action was authorized or performed.
