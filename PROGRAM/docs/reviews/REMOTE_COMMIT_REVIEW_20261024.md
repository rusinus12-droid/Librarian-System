# Recent remote commit review — 2026-10-24

Base: `origin/main` at `cd6763f` (the initial review began at `613acc9`). Review covers the changes since `dcb331d`, including storage cleanup, GUI recovery, read sessions and release synchronization. Changes are prepared on `fix/libra-server-availability-warning`; main is not modified by this patch.

## Findings and fixes

- **LIBRA connection warning (`0b7ea99`, integration with `437854f`):** `serverUnavailable` was set on failure but never cleared on success. Any availability error was described as proof that the server process was stopped. A successful live snapshot now clears stale warnings, obsolete GUI requests cannot republish failures, the recovery destination uses the new server sidebar, and an explicit observational connection retry resumes deferred initialization. A local-only scope keeps its applied mode label. The retry does not adopt a changed server identity or change storage routes.
- **Global duplicate cleanup (`5dbead5`):** legacy mirror exceptions were eligible for cleanup under a global server default. Local values could change after verification, and chunk artifacts could be removed even when a projected deletion retained a shared root. Cleanup now requires live server-only routing, quiesces owner proxy writes, rechecks routes/recovery gates and both copies before deletion, and retains chunks when their root remains. Verification failures no longer all claim that the server process is stopped. Changes are synchronized to LIBRA, HAYAKU and Flashback.
- **LIA GUI selection (`f213671`):** the standby fallback swallowed `LIA_VIEW_SELECTION_CHANGED` as well as unavailable selection. A selection change now invalidates the old snapshot; unavailable selection still permits the read-only standby view.
- **GRADIA empty read sessions (`774e107`):** capture accepted a deleted root as an empty session, but currentness validation rejected that session's tombstone metadata. All three owner read adapters now validate absent roots and versioned tombstones distinctly and invalidate evidence when data reappears.

The later RE:TRACE visible-selection delimiter fix (`cd6763f`) is incorporated unchanged; it converts checkbox wire identities to the existing internal selection-key format.

## Verification

Regression coverage exercises actual production function declarations, real HTTP/SQLite storage cleanup, and the three read-session adapters. Covered cases include restored connectivity, failed retry, stale GUI replies, local-only mode, mirror overrides, a local edit after verification, writer admission during cleanup, retained shared-root chunks, changed chat selection, and empty/tombstoned root currentness.

Existing GUI lifecycle, storage-dismissal, connection panel, SDK synchronization, LIA GUI, and owner read-session regression checks were also run. Full and Min plugin artifacts are built with the repository release builder. Historical artifact size baselines are reporting-only; the build log reports size warnings separately from build/syntax success.

Actual RisuAI browser connectivity on the user's machine is not reproduced by these synthetic hosts. A running server can still be unreachable from a host/container; the updated warning distinguishes failed access from a stopped process.

## Follow-up — 2026-10-25

The cleanup transport still consulted the legacy mode argument after the global registry had certified `server_only`. That argument intentionally remains `plugin_only`, causing `memory_suite_server_not_enabled` even against a responsive server. Global verification and its final readback now use the same observational transport permission as scope verification, after enforcing the effective global/per-scope modes. Server identity, reset review, integrity and copy-equality gates remain enforced. Transport/integrity errors preserve their underlying reason in the visible diagnostic. The new global-mode cleanup regression drives the real two-click panel without an active chat and checks that server records remain byte-for-byte unchanged for all three owners.
