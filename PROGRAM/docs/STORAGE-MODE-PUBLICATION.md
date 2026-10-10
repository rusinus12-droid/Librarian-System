> Current core3 global-mode contract (Storage SDK 1.8.25): LIBRA, HAYAKU and Flashback now apply their own global choice through strict all-chat discovery and an aggregate resumable job. Legacy explicit routes are included and retired only after complete verification. See [GLOBAL_STORAGE_MODE_ALL_CHAT.md](GLOBAL_STORAGE_MODE_ALL_CHAT.md). Per-scope mechanisms below remain maintenance/compatibility primitives; descriptions of global follower-only application are superseded for these three owners.

# Core-owner persisted mode publication diagnostics

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST. This is a working, persisted diagnostic configuration revision, not the qualified semantic mode epoch required by Task 9 or GRADIA MiB-v2. Overall authority remains PARTIAL.

## Actual owner integration

The common block in both canonical Storage SDKs is identical and enabled independently for `flashback`, `hayaku` and `libra`. Their ordinary owner stores and existing `__memory_suite_internal_scope_routes_v1__:<namespace>` registry are used. There is no new DATA database, remote authority route, cross-owner mode, migration coordinator, or host permission. The three core-owner plugin SDK blocks are synchronized exactly; everything outside those blocks is preserved. LIA, RETRACE, GRADIA and WM source is unchanged. The standard SDK's local-only and manager-only policies cannot create these records or acquire server mode rights.

All current internal registry publishers pass through `writeScopeRegistryLocalImpl`: scope/global setters and removal stamps, legacy mode import, hydration, recovery lock/clear, successful verified migration, failed global follower preservation, plugin-storage retirement and server-scope-deletion preparation. Public `setMode`, `setScopeMode`, `setGlobalMode`, `clearGlobalMode`, `configureConnection` and background connection configuration reach these existing owner paths. `persistMode`, the legacy import argument reset, and `persistServerUrl` additionally bracket their real argument mutation with pending and settled/failed records. Scoped transitions publish draining, mirror, and settled/failed stages through the same sink. Each sink admission advances the separate SDK-instance configuration generation, including hydration/recovery paths outside the public configuration wrapper.

The existing five-owner `migrateWholeData` provider contract is untouched. It still requires its external coordinator, and none is installed by this change. An injected coordinator, direct host writes, old SDKs, other processes and other devices are not authenticated by these records. WM remains a separate storage owner with its existing migration protocol.

## Versioned record

`modePublication` is stored inside the same registry JSON as the mode rows, under schema `memory-suite.mode-publication.v1`:

- `namespace`, `pluginId`: actual SDK owner identity
- `epoch`: newly generated 128-bit random publication identifier
- `revision`: positive safe-integer diagnostic sequence, advanced from the largest valid record observed by this instance and its local allocation counter
- `phase`: `pending`, `settled`, or `failed`
- `reason`: fixed internal publication stage
- `routeDigest`: SHA-256 of the exact bounded semantic configuration projection
- `atomicOwnerQualified:false`: mandatory and never user-overridable

The projection covers owner namespace, whether legacy arguments have been imported, sorted scope IDs/keys, mode, origin, removal stamp, pending target and recovery-lock presence. It contains no source text, message hashes, credentials, URL, model capture or backend receipt. Ordinary labels and unknown metadata are preserved but do not become mode authority. Changes to the whole owner's published configuration conservatively invalidate requests bound to that publication, even when an unrelated scope changed. Old registries with no record remain compatible and explicitly lack persisted-publication evidence.

The existing registry parser and merger preserve unknown top-level and row metadata. A present unsupported/malformed publication record refuses overwrite rather than downgrading it or resetting its version. Safe-integer exhaustion refuses wrap/reset. Registry readback still uses the existing compatibility rule: at least one real plugin/device copy must match the full payload. A partial write can therefore retain the prior public mode-operation behavior while the new observation reports conflict. There is no assertion that both copies committed atomically.

## Read-only interface

`inspectModePublication()` accepts no arguments. It reads actual existing plugin/device stores directly, without mode import, registry initialization, default generation, bootstrap, synchronization, repair, network, timers or writes. It reports:

- `observed`: supported, matching settled record copies and route digests
- `absent`: supported legacy registry or empty store with no publication record
- `unsettled`: matching pending or failed record
- `conflict`: differing or missing physical record copies
- `malformed`, `mismatch`, `limit`, `unavailable`, `changed`, `disposed`, `busy`, or `unsupported_owner`: explicit inability to observe the requested unit

Every result includes a separate `instanceGeneration`, `semanticModeEpoch:null`, `atomicOwnerQualified:false`, `authorityQualified:false`, and `host_atomic_owner_capability_unavailable`. `observed` means a self-consistent record was read from the real owner store; it does not prove exclusive ownership or trustworthy provenance. A caller JSON object, qualification flag, host CAS lookalike, random identifier, digest or successful readback cannot upgrade it.

At most four direct inspections may be physically pending. Their slots are held until actual storage promises settle, including disposal. Reads occur sequentially, preventing an early failure from releasing a slot while another read remains in flight. At most two distinct physical stores are read. JSON input is capped at 1 Mi UTF-16 code units; projection has at most 8192 rows, 512 Ki UTF-16 code units and 1 MiB encoded bytes. These are local post-read bounds, not an authoritative host pre-read quota or a wall-clock callback deadline. Writing new records needs WebCrypto random values and SHA-256. Missing primitives or invalid/exhausted records fail explicitly rather than inventing an epoch.

## LIBRA request-local integration

The readonly route issuer uses the same physical registry bytes it already sampled. Its summary now contains `modePublication`, separately from `routeEpoch.kind:'sdk-instance-configuration-generation'` and `semanticModeEpoch:null`. A legacy absent record does not create one. A supported persisted record binds request currentness across different SDK instances or reloads; observed epoch replacement, including value-returning publications, invalidates the old request. Pending, malformed, mismatching or conflicting evidence refuses capture/currentness. Final instance/store checks run after the final asynchronous store-identity read.

This is a finite usable change detector and diagnostic record, not a strong source proof. The host does not expose a qualified atomic owner transaction/CAS capability, and no new adapter is invented here. Ordinary get/set cannot prevent races, lost concurrent writes, rollback/replay of a previous whole record, direct external changes or cross-process ABA. Local counters and random IDs do not create a global monotonic epoch. Hydration republishes merged local configuration as a new unqualified diagnostic record; imported metadata is not adopted as authority.

`admitReadonlySourceCapture` remains `SOURCE_PROOF_UNAVAILABLE` for missing host-mutation authority, semantic mode epoch and authenticated backend binding. Backend control `authority_routes.mode_epoch` is not populated or connected. All existing core3/retired-owner constraints, native/source-text policy, typed backend closure, recall, Micro eligibility and corpus/selection gates are unchanged. Source text/tag edits do not trigger comparison, rejection, polling or reanalysis.

## Migration and verification limits

Only `plugin_only` and `server_only` remain operational choices. `mirror` stays compatibility/transition state, never a new final destination. Invalid choices and invalid URLs are rejected before diagnostic persistence. A failed migration retains its previous effective route; failed global followers retain their pending target rather than following an unverified destination. No actual data is deleted or moved by the new observer. A failed stage remains explicit until an existing successful owner publication supersedes it; this is not a recovery/resume engine.

The bounded verification consists of 25 actual-SDK in-memory-host checks and 21 LIBRA owner-context checks (including the prior 19 cases), plus syntax and exact core-owner embed checks. Fake transport may deliberately report offline through an in-memory host method; no network primitive, live server, listener, model, credential, actual DATA or actual host configuration is used. Successful live migration, multi-process qualification, full lifecycle/transport admission, platform/performance, full/deep regression and MiB-v2 capacity/callback proofs are not claimed. Generated Full/Min/release metadata remains stale.
