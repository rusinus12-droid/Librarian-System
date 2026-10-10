# 0.3.61 full-project defect review — consolidated (2026-09-17)

Scope: all five plugins, the local storage server, the embedded SDKs and the release tooling.
Method: four read-only static reviews, then **independent re-verification of every top-severity claim
by the parent agent** before recording it. No regression process was started during review (the suite
was running; read-only inspection only).

**Verification tag legend**
- **[verified]** — the parent agent reproduced the cited code/caller chain itself.
- **[adjusted]** — the claim was right in substance but wrong in detail; the correction is stated.
- **[unverified]** — plausible, cited, but not independently confirmed. Treat as a lead, not a finding.

---

## A. Confirmed defects, ranked

| # | Sev | Location | Defect | Verification |
|---|---|---|---|---|
| 1 | **High** | `LIBRA.js:34579-34611` | `resolveStableScopeKey` does a lock-free read-modify-write on the **global** scope registry (`storage.getJson(registryKey)` → mutate → `setJson`). All 4 callers (34625/34630/34659/55434) are unlocked, so two interleaved scope resolutions lose one `registryId`; the orphaned chat then mints a new scope key. `writeScopeRegistryLocal` (6775) is the correct in-repo pattern (re-read+merge inside the turn). | **[verified]** — read/write lines and all 4 callers confirmed unlocked |
| 2 | **High** | `LIBRA.js:45831-45837` | `retryUnifiedServerEmbedding`'s outer `catch` returns the **unchanged input `memory`**, so a failed commit reports success to callers that only read `memory.embedding.status`; the error survives only in `state.lastUnifiedVectorResult.reason`. Covers `storageMutationIndeterminate` and rebase-safety `unifiedAssert` failures. | **[verified]** — the return `memory` and the diagnostic-only write confirmed |
| 3 | **High** | `LIBRA.js:40623-40648` | `persistStateReplayHead` writes the State Head (`key.continuityState`) with **no lock**, and all 8 callers (40734/40782/40796/40827/40846/40854/40883/40896) are unlocked. Two heads computed from independent `loadContinuityState` reads → the later write wins wholesale and the first rebuild's applied deltas are lost. | **[verified]** — callers enumerated, 0 locked |
| 4 | **High** | `Flashback_Memory.js:46237-46244` | Portable `CHAT_MIGRATION` rollback removes the archive scope **after** restoring the target manifest. A crash between the two awaits leaves a live manifest pointing at a deleted archive → `recordCountMismatch` → `assertCompleteScopeLoad` blocks all later writes/maintenance for that scope. Fix: swap the two operations (clean archive first, then restore). | **[verified]** — the two calls and their order confirmed |
| 5 | **High** | `HAYAKU_Locator_Continuity.js:38545` | `writeStorageLedgerDirect` performs **no re-read/merge** of the on-disk ledger (`reconcileStorageSlotHeads(ledgerForWrite, activeRecords, [])` only touches the passed object). A caller that snapshots the ledger outside the queue and writes it inside (notably the pre-mirror path at 42301) silently reverts destructive operations committed in between. | **[verified]** — function body read; no merge/re-read present |
| 6 | **High** | `LIA_Persona_Linker.js:10886-10908` | `writeLivePersonaBinding` is a lock-free read-modify-write of the whole pluginStorage persona store. LIA has **no** pluginStorage lock at all (`withPersonaDatabaseMutationLock` guards the persona DB only). Fork and live-sync use separate in-flight guards that do not exclude each other. | **[unverified]** — helper absence confirmed by the reviewer's scan; not re-run by parent |
| 7 | **High** | `sdk/MemorySuiteStorageClient.libra.source.js` | The LIBRA SDK variant is a hand-maintained fork with **no sync/check tool**; only a version-string guard. It has **removed the entire writer-fence path**: `withFlashbackWriter` appears 0× (vs 5× in the standard SDK) and `fence` 0× (vs 23×), while both files still declare `v1.8.23`. A fence/CAS fix in the standard SDK provably never reaches LIBRA. | **[verified]** — counts and identical version headers re-run by parent |
| 8 | **High** | `server/server.cjs:1747-1750` | CAS degrades to revision-only when `expectedDigest` is empty (`!mutation.expectedDigest \|\| actualDigest === …`), and `normalizeConditionalMutation:1718` accepts `''`. The manager path builds mutations from `body.mutations`, so a non-SDK client can commit over changed bytes whose revision coincidentally matches (e.g. after a restore). | **[verified]** — `!mutation.expectedDigest ||` and the `''` default confirmed |
| 9 | **Med-High** | `tools/check_sdk_sync.cjs` + release gates | **8** embedded-SDK sync tools are referenced by no test or gate: `sync_execution_contract`, `sync_native_branch_storage`, `sync_portable_transfer`, `sync_libra_health`, `sync_search_compute`, `sync_recall_conversation`, `sync_flashback_consent_profile`, `sync_hayaku_consent_profile`. Drift in those SDKs is detected by nothing; the Windows `.bat` advertises a check the build does not run. | **[adjusted]** — reviewer reported 6; parent's enumeration found 8 |
| 10 | **Med** | `server/server.cjs:1747` + `3331/3336/1568` | `/v1/kv/keys` prefix paging is **case-insensitive** (SQLite `LIKE`, no `case_sensitive_like` pragma). A prefix query returns keys outside the prefix, and `nextCursor` is derived from the unfiltered set. Leaks key *names* (clients re-filter with `startsWith`), and pagination correctness depends on it. | **[verified]** — parent reproduced with an in-memory `node:sqlite` probe: prefix `SCOPE-%` returned both `Scope-Alpha:mem` AND `scope-beta:mem` |
| 11 | **Med** | `server/server.cjs:2157-2161` + `2331` | A restore's mandatory pre-restore backup can be satisfied by an **unrelated in-flight auto backup**: `createBackup` coalesces on `backupInFlight` regardless of kind/label, so `preRestoreBackupId` can name a snapshot that does not represent the pre-restore state. The promised rollback copy is not the one reported. | **[unverified]** — cited lines read by reviewer only |
| 12 | **Med** | `Flashback_Memory.js:26817-26829` | Episode-digest feedback loop: the digest includes `updatedAt`, which `saveScopeRecords` always restamps, so episode rebuild → save → digest change → rebuild. Fires from every `force:true` caller. | **[unverified]** — plausible and cited; not reproduced |
| 13 | **Med** | `RETRACE.js:3826-3843` | Mirror-mode server write failure is **fail-open** (`return true`) unless `requireDurableMirror === true`, which only one consumer passes; callers/UI report success for data that never reached the server. | **[unverified]** |
| 14 | **Med** | `RETRACE.js:1848-1883`, `1970`, `2095` | `pruneUntracked` deletes local keys judged only by absence from the server key list; runs automatically on mode change and server-URL change, so a transiently partial server response turns valid local data into a deletion target. | **[unverified]** |
| 15 | **Med** | `Flashback_Memory.js:36907-36908` | `scheduleProgressiveReembedRetry` can never succeed: it requires `options.explicitConsent`, which **no caller passes repo-wide** — while the result still reports `progressiveScheduled`. | **[verified]** — `explicitConsent` occurs exactly once in the file, at the guard itself |
| 16 | **Med** | `HAYAKU:33563` / `LIA:4335` / `LIBRA:34582` server publishes | Scope-registry publishes to the server pass no `expectedRevision` (CAS), and one site is `void` (failure hidden). | **[unverified]** |
| 17 | **Med** | `server/server.cjs:3445/2556/2624` | `/v1/manager/scopes/index` bounds scopes (5000) but not **members**, each of which does a synchronous SQLite read; a 96 MiB body can stall the whole event loop. | **[unverified]** |
| 18 | **Low** | `LIBRA.js:31163`, `52611`, unload `75755-75800` | `state.sgaCheckpointTombstones` only grows — added on discard, deleted only on successful re-store, and **not cleared on unload** (unlike the file's other caches). | **[unverified]** |
| 19 | **Low** | `server/backup_worker.cjs:29` | `PRAGMA busy_timeout` on a `readOnly` connection is a silent no-op (parent-probe class), so the intended cross-process lock protection is absent — currently masked by the maintenance gate. | **[unverified]** |
| 20 | **Low** | `server/server.cjs:3331/3490` | `/v1/admin/backups/import` accepts an arbitrary server-local `archivePath` with no `pathIsInside` containment check (admin-token gated). | **[unverified]** |

## B. Corrections to the reviews (Task 48 rule applied)

The Task 48 lesson generalises: **lexical nesting is not protection — the caller's lock is.** Two
review claims did not survive that test and are recorded here so they are not chased as defects:

- **`LIBRA.js:58793` ("continuity head write 2")** — reported as an unlocked State Head write, but the
  parent's caller check found **all 5 callers are inside `enqueue`** (35706/58829/58876/58909/59003).
  The function is unsafe *by contract* rather than *in practice*: its name says `Unlocked`, and the
  guarantee lives in the caller. Lower risk than reported; the real risk is the sibling at `40648`.
- **`LIBRA.js:45967/46195` ("scan saves the manifest unlocked")** — the save IS inside `scan`'s
  `enqueue`; the open question is whether every *other* writer of the same manifest key agrees on that
  key. Of 29 `saveManifest` sites, **3 are inside a lock and 26 are outside** (parent-verified), but
  "outside" only means the enclosing body has no lock — several of those are reached from locked
  callers. **Not yet classified.** This is the single largest remaining unknown in the review and is
  the right next step for LIBRA, using exactly the Task 48 method.

## C. Verified clean (do not re-audit)

- **Server CAS atomicity** — no `await` between precondition read and apply; both transactions are
  `BEGIN IMMEDIATE` under WAL + `synchronous=FULL`. This is the one class where a defect would have been
  most damaging, and it is genuinely sound.
- **Disk durability** — every live artifact goes through temp-file + `fsync` + `rename` + directory
  `fsync`. Backup snapshots use `VACUUM INTO` (consistent, includes hot WAL) and are integrity-checked
  on the copy. Offline restore has a 5-phase journal that rolls **back**, not forward, on crash.
- **Path traversal** — no request-supplied value reaches an unsanitised path except the admin-gated
  import (#20); ZIP-entry and manifest-reference traversal are defended.
- **Flashback lock discipline** — all 12 `saveTurnWorldline` sites are in-lock or reached from a locked
  caller; **zero same-key nested lock acquisitions across 37 lock sites**, so the non-reentrant
  `withScopeWriteLock` deadlock is unreachable. `adoptSessionHandoff` takes target-only locks (the
  Task 48 fix).
- **LIBRA/Flasback/HAYAKU bounded state** — the main caches, timers, listeners and TTL/Maps are capped
  and cleared on unload; the gaps are named in #18 (and #10/#7 of the LIBRA review).
- **No file I/O in any plugin** — all physical keys are hash/template-built; the
  "escape the data directory" class does not apply to plugin sources, only to `server/`.

## D. Not a defect but worth knowing

- `bridgeHandoffValid` has **no test reference** anywhere (found during Task 48) — the session-handoff
  adoption path was never executed by the 585-test regression. Now covered by
  `tests/flashback_session_handoff_concurrency_test.cjs`.
- The **`-Source.zip` vs runtime `.zip`** profiles ship 1036 vs ~129 files. A test had been asserting a
  file count only the source profile can reach; corrected in Task 48 follow-up.
