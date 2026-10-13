# HAYAKU GUI mapping

Status: implementation candidate; local synthetic-host verification only. This is not RisuAI or release-build evidence.

## Mockup destination to product capability

| Mockup destination | Product source and state owner | New GUI location and adapter | Existing write/action contract |
|---|---|---|---|
| Continuity control (`overview`) | `viewerRenderOverview`, `viewerRenderContinuityLine`; `Memory.ledgerViewer.ledger`, `continuitySnapshot`, last viewer recall, operation log | Original mockup banner, four metrics, route, recall and recent-activity cards; no fixture data in product source | Read-only reconciliation and route navigation use `refreshLedgerViewer`, `viewerSetTab`; route selection binds to record IDs or Recovery |
| Packets (`packets`, with Worldline as an internal view) | `viewerRenderRecords`, `viewerRenderRecordDetail`, `viewerRenderWorldline`, `viewerRenderPacketAuthoring`; ledger records, slot heads, worldline and exact request receipts | Original `Memory ledger` page head, action segment, filter cluster, `.pk-layout`, `.pk-row`, four detail tabs, and orphan fold. Worldline remains an internal segment using the same selected ledger item. | Existing record regeneration, atomic variant reselection, JSON export, and orphan cleanup retain their product guards and confirmations. Product-only provenance/hash/evidence fields are under canonical Binding, not a fifth tab. |
| Section maintenance (`recovery`) | `nativeRecoveryStatus`, `viewerRenderNativeRecovery`, `viewerRenderSourceEditConsent`, `viewerRenderFailedRecovery`, `viewerRunNativeColdStart`, `hayakuHealthRecovery`, portable backup host | Original `Section maintenance` page head, four-tab/panel hierarchy, status/action cards, auto-recovery summaries, and Portable JSON card. Product panel hooks use canonical `data-subpanel` vocabulary. | Target/owner/source revalidation, confirmation before model work, existing Other Ax call path, source-edit consent, delete/adopt/manual/LLM repair, cold-start limits, cancellation, cache-only repair, and portable JSON export/restore remain product-owned. Batch selector is per-run; persisted default remains Settings-owned. |
| Server connection (`server`) | `viewerMountServerConnection`; `MemorySuiteStorageBridge` and `MemorySuiteHayakuComputeBridge` | Original `Connection` page head and `.grid.g2`; the shared SDK-owned connection panel is mounted inside its product card. | SDK owns storage and compute connection settings; HAYAKU supplies its existing title, description and compute bridge. This panel is an independently rendered SDK surface. |
| Settings (`settings`) | `viewerRenderSettings`, `viewerCollectSettingsDraft`, `viewerApplySettingsTransaction`; `HAYAKU_GUI_SETTING_SPECS` (43 argument fields) | Literal original four-section `.st-layout` / `.st-nav` page body from `hayaku.html`, with nonvisual hooks wired to product ARG controls; source tracking and consent stay under Recovery → reanalysis as in the product mapping | Draft, Apply, Cancel, global and per-section defaults, argument writes, complete raw/effective readback and rollback stay on the existing transaction path |
| Operation history (`logs`) | `viewerRenderOperationLog`, `viewerRenderSwallowedDiag`, debug JSON copy/show/export | Original `Session log` page head, `.search`, `.list`, diagnostic card and JSON disclosure panel | Reads product operation log and diagnostic recorder; explicit debug export actions remain explicit |

## Boundaries

- The view shell and shared styles are sourced from `PROGRAM/docs/gui-redesign/hayaku.html`, `assets/suite.css`, and `assets/themes.css`. Product actions are adapters to existing HAYAKU functions.
- Worldline is a subview of Packets and does not add a seventh destination.


## Verification scope

See [GUI-APPLICATION.md](GUI-APPLICATION.md) for current source hashes, regression summaries and host limits. Raw execution logs, mock/model transcripts and screenshots are kept out of this publication. Existing SDK-owned panels retain their ownership boundary.
