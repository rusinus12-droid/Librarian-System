# Task 48 — Flashback unlocked-manifest triage (2026-09-17)

Re-derived with `tools/audit_flashback_manifest_locks.cjs` (46 call sites, 9 unprotected), then
classified each site by **whether a concurrent writer can actually reach the same revision**.
That is the question Task 48 Step 2 asks, and the static audit tool cannot answer it on its own: it
only knows the enclosing function body, so a save nested inside a helper looks "unprotected" even
when every caller already holds the scope lock.

The decisive rule: a save is serialized **iff its caller holds `withScopeWriteLock` on the same key**.
`withFlashbackWriter` is a fence-session manager, not a mutex.

## Triage result

| Line | Function | Caller holds the scope lock? | Verdict |
|---|---|---|---|
| `:19287` | `saveScopeRecordsCore` | **No** — reached via `saveScopeRecords` (`:19093`), which only wraps `withFlashbackWriter`. The scope lock lives in its callers (`saveAllRecords` `:22601`, etc.), so this entry point is reachable unlocked. | **REAL RACE** |
| `:22409` | `adoptSessionHandoff` | **No** — `adoptSessionHandoff` has no lock in its own body; callers `ensureScopeStorageReady` (`:20433`) and `registerMemoryBridgeIpc` (`:36201`) hold no lock either. | **REAL RACE** |
| `:22479` | `adoptSessionHandoff` | same as above | **REAL RACE** |
| `:22518` | `adoptSessionHandoff` | same as above — also the rollback path, so a lost update here strands the target in a half-adopted state | **REAL RACE** |
| `:25962` | `commitFlashbackSourceReplacement` | **Yes** — its only caller is `upsertRecords` (`:23482`), inside `withScopeWriteLock(scope.scopeKey)` opened at `:23478`. | safe (no change needed) |
| `:25967` | `commitFlashbackSourceReplacement` | same as above | safe |
| `:25973` | `commitFlashbackSourceReplacement` | same as above | safe |
| `:46121` | `installFlashbackPortableMemoryBackup` | Runs once during plugin install/load (`:46992`), not on a recall/capture path. Not concurrent with a user writer. | safe (no change needed) |
| `:46124` | `installFlashbackPortableMemoryBackup` | same as above | safe |

**So the genuinely racing set is 4 sites, not 9** — `saveScopeRecordsCore:19287` and the three
`adoptSessionHandoff` sites. The other five were already protected by their callers or are
install-time only. This corrects the Task 48 table, which listed all nine as racing.

## Why the audit tool reports nine

`tools/audit_flashback_manifest_locks.cjs` computes brace ranges and asks only whether a save line is
inside a `withScopeWriteLock` **block body**. It is correct for what it measures and remains the right
tool to regenerate line numbers. It is not a call-graph tool, so it cannot see that a nested save is
reached only from a locked caller. Step 2 of the plan exists precisely to close that gap.

## Deadlock constraint (must hold before wrapping anything)

`withScopeWriteLock` is **non-reentrant**: it chains on a Promise stored in `sharedScopeWriteLocks`
keyed by scope, so entering it again for the same key from inside a block already holding that key
deadlocks. Verified safe to add a lock in the two target areas:

- `adoptSessionHandoff` callers (`ensureScopeStorageReady` at `:20433`, `registerMemoryBridgeIpc` at
  `:36201`) hold **no** lock, and `ensureScopeStorageReady`'s own five call sites (`:20516`, `:26301`,
  `:26330`, `:26444`, `:37683`) also hold no lock.
- The lock must be taken on the **target** scope key. The internal helpers lock **different** keys and
  run to completion before the target is written — `createImmutableFlashbackHandoffArchive` locks
  `sourceScopeKey` (`:20983`) and `writeFlashbackHandoffReceipt` locks `'flashback_handoff_ledger_v2'`
  (`:20752`). Lock order is therefore source → (released) → target → ledger, with no nesting on the
  same key.

## Coverage gap found while triaging

`bridgeHandoffValid` — the flag that routes `ensureScopeStorageReady` into `adoptSessionHandoff`
(`:20432`) — has **no reference in any test file** in `tests/`. The session-handoff adoption path was
therefore not exercised by the 585-test regression at all, which is why an unlocked writer there went
unnoticed. A forced-concurrency test for these sites is new coverage, not a regression guard.
