# RE:TRACE product GUI mapping

Scope: RE:TRACE only. This records the current product behavior that must stay reachable when the mockup's four destinations (`overview`, `next`, `server`, `diagnostics`) and five Server subtabs (`glance`, `clean`, `backup`, `conn`, `hist`) replace the existing five-tab shell. The RE:TRACE owner remains manager-only; its owner-storage dashboard is read-only.

## Product behavior to destination mapping

| Existing product behavior / source | Mockup destination | Product state/action and required readback | Safety contract |
|---|---|---|---|
| Current chat, compatibility, owner IPC, storage gate, warning summary (`renderOverviewPanel`, `refreshOverview`) | Overview | `inspectTransition`, compatibility suite, `getCurrentContext`, owner storage IPC; rechecks the host chat/character and message fingerprint before publishing results | No automatic full server-scope scan; stale context invalidates prior preview |
| Next-session preflight and new chat (`refreshTransition`, `inspectTransition`, `continueToNextSession`) | Next Session | Refresh preflight, then show current chat/target identity, owner compatibility, storage gate, source counts; run existing create/continue call; show returned target and journal result | Existing confirmation remains; pending handoff retries the same target and transfer, never creates another target; source canonical state, ledger, vectors and binding are not cleared/moved |
| Handoff continuation/recheck (`resumeNextSessionHandoff`, `inspectPendingNextSessionHandoff`) | Next Session result | Display durable journal transferId, target chat ID, per-owner result and verified counts from actual result/readback | `ok` handoff cannot be revalidated; pending result can only retry the same target/transfer; no demo identity or fabricated result |
| Server overview/control (`refreshServerControl`, `renderServerControl`, `handleServerControl`) | Server → Overview | Actual manager readset: summary, plugin rows, recent jobs, result; refresh uses existing manager bridge | Manager API only; no owner-side mutation |
| Server scope catalog/search/filter/pin/pair/delete/retry (`refreshServerScopeManagement`, `renderServerScopeManagement`, `handleServerScopeManagementClick`, `scopeManagerRunDeletion`) | Server → Data management | Search and state filter are local to the current real catalog; cards and counts derive from actual scan; delete, pair, pin, cancel and retry use current scope identity and result reread | Manager-only deletion admission; active scope needs owner proof of local preservation and plugin-only mode; ancestors, unverified/incomplete records, pinned scopes remain blocked; retries reconcile history and do not blindly repeat unknown outcomes |
| Server backup inventory/inspect and restore-plan/execute (`handleServerControl`) | Server → Backups | Inventory, selected backup, checked state, plan expiration/target fingerprint, execute result, and post-action server readset | Restore requires fresh plan and confirmation. Any selection/state change invalidates plan. Existing server data is backed up before restore |
| Portable export/import and restore (`handlePortableTransfer`) | Server → Backup / restore detail | Real file chooser, ZIP upload+inspection, restore preview, transfer progress, download result, restored namespace result and follow-up reconnection state | Never include host chat/Persona/plugin-only material, API keys, or leases; restore re-plans immediately before confirmation and never auto-retries an ambiguous restore |
| Server connection diagnosis (`handleServerControl`, manager diagnose) | Server → Connection | Probe result then manager API/readset diagnostics | Read-only diagnosis; successful connection is not treated as a successful data operation |
| Owner storage dashboard (`refreshMemorySuiteOwnerStorageDashboard`, `renderMemorySuiteOwnerStorageDashboard`) | Server → Connection | Read-only IPC status for Flashback/HAYAKU/LIBRA/LIA; real owner, mode, scope, recovery and sync job readbacks | RE:TRACE does not own or change owner storage mode; unavailable IPC is shown as unknown/error, not success |
| Server history and result detail (`renderServerControl`, `serverControlReadset`) | Server → History | Actual history rows and server result; status filter acts on returned history | Interrupted/unknown actions are inspected before any retry; no automatic replay |
| Diagnostics, IPC registrations/errors, privacy-safe debug export (`renderDiagnosticsPanel`) | Diagnostics | Current in-memory IPC/error state, compatibility and gate readbacks, warnings; export through existing redacted debug path | Do not expose conversation text, Persona data, credentials, or raw scope identifiers |
| Bridge close/reopen, modal, busy state (`closeUi`, `showRetraceDialog`, `setBusy`) | Shared top bar / mockup modal and task tray | Reopen uses current RE:TRACE runtime/session state; dialog actions keep focus and return focus; busy control reflects real operation | Hiding/closing the view is not cancellation or success. Only existing operation-specific cancel/request semantics may cancel work |

## Canonical inner-body replacement (2026-10-13 final pass)

The remaining product view bodies now mount the reference structures and hydrate existing runtime state:

| View | Canonical landmarks | Additional actual product fields |
|---|---|---|
| Next Session | Four preflight check rows, steps, accent action, per-owner result list and same-transfer retry | Compatibility disclosure; storage Gate/transition disclosure |
| Server Overview | Four classification stats; four plugin owner rows; Data and Backup shortcuts | Collapsed server identity, manager-only legacy slot, recent jobs |
| Server Data | Six kind chips with live counts; grouped scope cards, selection toolbar and search | Collapsed read-only inventory/pairing details; actual pagination and scan errors |
| Backups | Export form, restore form with exclusions, reset danger zone | Collapsed ZIP import/upload/cancel and backup-check/plan details |
| Connection | Action card and two response/protocol check rows | Collapsed actual owner IPC storage status and debug export |
| History | Interrupted-work banner, result filter, owner rows, result requery/retry | Actual statuses/errors and backup identities in owner detail lines |
| Diagnostics | Checklist, now-check action, sanitized disclosure | Actual IPC/contract/Gate state |

Reset is in Backups, as in the original reference. Target selection, optional no-backup behavior, owner admission, typed confirmation, fresh empty-state readback and unknown-result revalidation retain the existing API path. Backup remains recommended for session creation; this pass adds no compulsory backup policy. RETRACE stays manager_only. The read-only owner status disclosure is product IPC UI using canonical owner rows; it is not claimed as an independent SDK layout exception.

The sidebar places navigation before its single bottom footer. Server tabs update `aria-selected`, and displayed catalog counts remain unknown until a current scan exists. Static icons include the reference backup/export paths; no prototype store, timer or sample outcome is loaded into product code.



## Verification scope

See [GUI-APPLICATION.md](GUI-APPLICATION.md) for current source hashes, regression summaries and host limits. Raw execution logs, mock/model transcripts and screenshots are kept out of this publication. Existing SDK-owned panels retain their ownership boundary.
