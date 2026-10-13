# Six-product GUI application

This change applies the finalized mockups to LIBRA, HAYAKU, Flashback, GRADIA, LIA and RE:TRACE. WM and the separate LIBRA retrieval-engine project are excluded. Product assembly inputs remain `PROGRAM/plugins/*.js`; generated Full/Min files must not replace these inputs.

The product screens use the approved layout, colors, typography and component structure. Existing SDK-owned storage, source-input and portable-backup panels retain their ownership boundary. The sample stores, timers and simulated results in `assets/suite.js` are mockup behavior only.

## Preserved product contracts

| Product | Owner | Connected behavior |
|---|---|---|
| LIBRA | writer | Completed five-turn ranges, explicit reanalysis, guarded candidates and versions, people/world/story/evidence, settings, five recovery paths, OOC drafts and explicit save |
| HAYAKU | writer | Recovery and Cold Start, packet/worldline/JSON views, failed-record repair, candidate comparison and selection, settings readback/rollback, real target and call estimates |
| Flashback | writer | Read-only diagnosis, consent and cost planning, source/archive recovery, protected deletion, inspected-file restore, embedding compatibility and migration |
| GRADIA | LIB reader | Novel/RP contracts, original/candidate selection, stage settings, OOC/results, materials/Skills, providers/models and existing expert controls |
| LIA | local_only | Four generation modes, candidates/materials, locked fields and original/translation, versions/images/assets, independent library save, Persona adoption and chat binding |
| RE:TRACE | manager_only | Next-session handoff, owner-specific results, copy classification/preservation/pairing/deletion, backup/restore/reset and unknown-result protection |

Product function, field, route and test correspondence is recorded in the six `*-PRODUCT-MAPPING.md` files. Actions keep their captured target/scope, confirmation and save ownership. Existing search APIs are connected to the GUI; no new retrieval algorithm is introduced here.

## Remaining mockup findings

All 19 previously partial/open items have individual mockup fixes and product acceptance coverage. Historical findings and earlier public audit records are retained as historical evidence, not rewritten as new successes.

| ID | Current connection or protection |
|---|---|
| LIA-18 | Concept input feeds actual candidate generation; processed candidates cannot be reused |
| LIB-16 | File selection and inspection determine recovery eligibility; the inspected target is retained |
| S-LIB-3 | Minimizing/reopening retains the real job and candidate result without duplicate execution |
| HY-S1 | Failed-record deletion/cleanup refreshes actual lists, counts and empty state |
| GR-S1 | Provider add/duplicate/select follows existing secret and save rules |
| RT-S1 | Closing/minimizing hides the job; explicit cancellation remains a separate operation |
| RT-S2 | Transfer ID, target and owner receipts come from the actual operation |
| S-LIA-1 | Confirmed Visual Lock fields cannot be edited; Neutral regeneration follows the existing reset rule |
| S-LIA-3 | Live Persona state is read from Persona/binding storage with default/foreign-owner protection |
| S-LIA-4 | Original and translation views retain separate values and unsaved state |
| S-LIA-5 | Material limits/profile options have real draft, save, revert and readback paths |
| S-LIA-6 | Blueprint/JSON content identifies the selected Persona |
| S-LIB-4 | Per-person evidence counts/frontier come from the same actual snapshot |
| S-LIB-5 | Banner, status and list projections use actual job/receipt state |
| HY-S2 | Ledger failures constrain actions; packet/log search uses actual data |
| HY-S3 | Saved enable settings determine chips and execution eligibility |
| FB-S1 | Explicit/provider/profile vector dimensions determine compatibility, not model-name guesses |
| GR-S2 | Skill validation, priority and search follow the existing product rules |
| GR-S3 | Immediate effects and pending-save/revert behavior are distinguished |

The approved follow-up LIA header fix uses the same single-line subtitle rule in mockup and product below a 640px app container. Fonts, colors, layout and full DOM text are retained. The four bottom routes remain reachable; container widths 639/640/641 and the 390px dirty-savebar case were checked.

## Local verification and publication scope

The private implementation verification used isolated synthetic host/storage/model fixtures, not real user data, credentials or paid providers. It included:

- LIBRA: 74 maintained commands; original OOC assertions, public recovery, portable queue, paired recall save/revert/readback and redraw-safe drawers.
- HAYAKU: 19 Node commands, 17 header checks and three browser suites, including 143 workspace assertions. A pinned pre-fix control reproduced the zero-target cost display.
- Flashback: 28 maintained commands; the archive-owner suite passed 56 cases after correcting a stale observer label using the pinned callback fingerprint. Historical source/output pins are unchanged.
- GRADIA: 72 Node cases and canonical/semantic browser flows, including the retained expert controls.
- LIA: 36 backend cases plus three migrated real-browser UI flows, reopen/asset recovery and 13 header widths with 52 bottom-route clicks.
- RE:TRACE: 42 maintained files, 52 cases, plus responsive and local HTTP/SQLite checks.
- Shared owner/source-input tests: actual storage transitions, restart/reverse/readback and explicit-selection guards. Retired automatic source-edit modes do not start analysis or consent UI.

These are different, overlapping units and are not summed into a project-wide total. Initial failures, migrations and detailed runtime traces remain private. This publication contains necessary reproducible test source and normal source-integrity metadata, not raw mock/model/prompt outputs, screenshots or private Library references.

Actual RisuAI, Windows/WebView, physical mobile keyboards, screen readers and paid models are unverified. Full/Min generation and syntax checks are not installation or release verification. No version bump, deployment, tag or main-branch merge is included. The existing cleanup restoration and SDK source boundaries are preserved.

The separate LIBRA performance patch was not integrated because its input download was unavailable. Flashback/HAYAKU performance integration remains on hold. The project-wide R1–R5/D1 audit and deployment are separate work.

## Reproduction

Install the repository's declared test/build dependencies and provide Chromium as required by the browser resolver. Representative commands from repository root:

```sh
node PROGRAM/tests/gui_final_design_tokens_test.cjs
node PROGRAM/tests/gui_shared_theme_runtime_test.cjs
node PROGRAM/tests/server_connection_gui_contract_test.cjs
node PROGRAM/tests/storage_global_owner_public_gui_test.cjs
node PROGRAM/tests/hayaku_existing_packet_cold_start_gui_test.cjs
node PROGRAM/tests/lia_manual_analysis_regression_test.cjs
node PROGRAM/tests/browser/libra_header_mode_authority_browser_test.cjs
```

Build official profiles in a disposable source copy using `PROGRAM/tools/build_plugins.cjs --profile source|release --plugin PRODUCT --out OUTPUT`. Keep generated artifacts and execution output outside the publication commit.
