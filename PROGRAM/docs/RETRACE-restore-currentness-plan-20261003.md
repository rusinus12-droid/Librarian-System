# RETRACE restore currentness implementation plan

**Goal:** Keep pre-restore server-control responses from overwriting newer results or publishing after the GUI closes.

**Spec:** `C:/Users/rusin/Downloads/LIB-WM-Recovery-Plan-2026-10-02-UPDATED.md`, R01/A02 and S02; delegated RETRACE restore/server handoff scope.

**Architecture:** Preserve the server as backup/restore authority and the existing registered GUI. Give each server-control refresh a generation, and accept results only for its original visible root and current generation. Capture mode/scope/persona/server binding before the query; compare it after the last awaited authority status read, including the physical DATA identity and reset epochs. Add physical restore, reset epoch, immutable source, and restart evidence through the registered GUI against an isolated HTTP server.

**Scope:** Only `plugins/RETRACE.js`, RETRACE tests and this document. Base `2058bce52dd0088c7eae2c7204b849ce581144f1`; no original edits, shared SDK/server changes, external/model/embedding calls, aggregate test command, promotion or build. Existing parser, stable fields, contracts and deadlines remain intact.

## Task 1: Server-control refresh currentness

- [x] Add `tests/retrace_server_control_currentness_test.cjs`: old success and old failure cannot overwrite a newer response; closed/replaced root cannot publish; a current failure still clears old status. Extend to mode/URL/scope/persona/character/chat/binding/DATA/epoch drift, final-await profile drift, and mixed old success/reset refusal.
- [x] Run under the required network/model preload; observe the old-success assertion fail on the base source and the additional context/final-await RED failures.
- [x] Add generation/root/visibility and readset checks in `refreshServerControl`, invalidating its generation when the UI closes or unloads. Keep internal error codes in the error object rather than showing them as product text.
- [x] Run the new test and the four named baseline tests.
- [x] Preserve global control reads without a selected chat using explicit native absence identities. Distinguish indexed/direct null/no-chat from native exceptions, malformed/missing records and invalid indexes; fence absence/selection/profile transitions before/after HTTP.

## Task 2: Registered GUI and physical restore proof

- [x] Add `tests/retrace_server_restore_gui_runtime_test.cjs` with an isolated real HTTP/SQLite server and mock Risu host/DOM. Production callbacks, bridge, backup, restore and rendering remain intact; audit seams only read runtime state/readset values.
- [x] Drive the registered callback, server tab, backup, restore preview, cancel, confirm, and history controls. Compare exact restored namespace values, unaffected namespace/host bytes, old/new epoch reads, and restart readback.
- [x] Hold an actual pre-restore HTTP status reply until the GUI post-restore refresh finishes; assert current status/history survive its late delivery. Verify close, unload and a persona switch during the final authority HTTP await cannot publish the old response.
- [x] Drive real registered UI native null/no-chat global controls, a no-chat-to-selected final-await transition, native read throws and malformed selected-character records against the real loopback HTTP server.
- [x] Run relevant RETRACE regressions and syntax/diff checks. Record PASS/FAIL/UNRUN and exact limitations. Private commit follows final review packet preparation.

Review focus: competing refreshes; stale failures; close/remount; explicit cancellation; storage restart. Native Risu/browser acceptance, portable ZIP restore, complete five-owner global integration, scope scanner currentness, release build/size and performance remain separate gates.

## Task 3: Uncertified partial-batch refusal

- [x] Preserve c989 and its 17-file PASS evidence. Independently reproduce initial HTTP400 status refusal plus held old history across an actual HTTP/SQLite restore; current authority returns the incremented epoch but c989 publishes old history.
- [x] Observe stable-refusal unit and registered-runtime RED failures before implementation.
- [x] Reject the whole dependent batch and clear its preview when initial status is unavailable. Preserve original rejected action errors/cause and existing token/readset guards; add no forced bootstrap or selected-chat prerequisite.
- [x] Verify stable refusal, restore-increment refusal, certified stable partial success, complete positive, native absence, scope, close/unload and all 17 scoped regressions.

Ruling: Root explicitly authorized this narrow follow-up after accepting the actual HTTP/SQLite RED. A fresh authority response cannot prove the epoch of earlier dependent observations when their original status is absent; publication fails closed. The original c989 commit remains preserved, and the follow-up is a new private commit for combined independent review.

Ruling: Execute this authorized delegated unit inline without a new plan approval or subagent. Parent owns independent review/integration. Do not run the prohibited aggregate suite; record that boundary explicitly.

Ruling: Use an ordinary manager bootstrap plus one extra observational manager `status` request, rather than a forced SDK bootstrap. A forced bootstrap invalidated concurrent scanner bootstrap sequences in the real fixture. The current caller never approves reset adoption or changes a server connection choice. Cost: one additional manager status request per refresh; no latency claim.

Ruling: Let the independent namespace scan settle and request a fresh restore preview before this unit's controlled restore. The server correctly rejected a preview whose scan index had changed. Concurrent scanner reset-refusal/SDK availability poisoning is separately preserved and delegated to the shared SDK owner; no gate is bypassed.

Ruling: Native null/no-selection is an explicit stable absence identity. The control reader must not use the generic context reader's caught/fallback errors as evidence of absence. Valid global queries remain permitted, while before/after selection, persona, scope, binding, DATA or epoch drift rejects old results. No SDK connection or reset choice is forced.
