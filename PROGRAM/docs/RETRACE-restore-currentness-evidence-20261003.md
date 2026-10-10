# RETRACE restore currentness evidence — 2026-10-03

This private unit fixes stale server-control publication. It does not claim A02/native/full-host/portable restoration complete.

- Clone: `C:/Users/rusin/AppData/Local/Temp/LIB-RETRACE-RestoreNext-20261003`
- Branch: `recovery/retrace-restore-next-20261003`
- Base: `2058bce52dd0088c7eae2c7204b849ce581144f1`
- Original baseline RETRACE SHA-256: `00cc7df50b8ecc03e9763fc1323e95d4d0d7172acfeaf6319e5f28583f9d5575`
- Preserved first-unit commit: `c989115c6bdea763ca60e9cdc847588942a17864`, source SHA-256 `d4623c30c32b4726a3b2871c4da655119c9e24eef6c2784c65b8fff36da35c66`
- Candidate RETRACE SHA-256: `9780513200366e93b2a6dd731073ef8275e9272a5e689659e01b9f4bd865e171`
- Evidence directory: `C:/Users/rusin/AppData/Local/Temp/LIB-RETRACE-RestoreNext-Evidence-20261003`
- Current required preload SHA-256: `de7fc885a50a6a4515819750489340d7e4fff6d0d28b51d3091285f7ecf68d3c`

## Cause and attribution

`registered retrace-main-hamburger callback → showUi/renderShell/bindUi → serverdata tab/refreshActiveTab → refreshRetraceTab → refreshServerControl` starts overlapping control reads. The previous implementation unconditionally published `status/backups/history` after `Promise.allSettled`. An older pre-restore success or failure could overwrite newer state. `closeUi` invalidated only the overview query. The individual SDK requests already check their own binding; that does not make three separately fulfilled responses a current GUI readset after a later scope/profile/backend change.

The fix checks the query generation and original visible root, compares the captured connection settings, character/chat/persona and SDK binding after the last awaited authority read, and verifies the actual DATA identity/reset epochs against a fresh manager status response. A drifted current readset clears obsolete UI results and its restore preview. Current genuine failures still clear obsolete results. Closing and unloading invalidate control reads. No owner records, parser, semantic gold, deadlines, stable source fields, migration semantics or shared SDK/server files are changed.

Global status/backups/history also remain available with no selected chat. The control identity reader calls native APIs directly: indexed `null`/`-1` or direct `null` establish an explicit `no-character`/`no-chat` sentinel. Stable selected-character identity (when present), selected database persona, settings and binding are still captured. A selected index with a missing/malformed record, invalid index, unsupported read, or native/database exception is an unreadable context, never an absence sentinel. Before/after absence, selected character/chat/persona and profile changes invalidate the whole pending readset. The generic overview context reader catches native failures, so it is deliberately not used to establish this authoritative absence proof.

The authorized partial-batch follow-up refuses all dependent publication when the original status observation failed. Without that original observation, a later successful status cannot certify the epoch of previously fulfilled backups/history. The refusal clears the restore preview and old batch through the existing catch path, preserves each original rejected action's error and the initial status cause, and requires no extra bootstrap or selected chat. Certified stable partial results with a fulfilled original status retain the existing behavior.

## RED and GREEN

All Node commands use:

```powershell
$env:NODE_OPTIONS='--require=C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs'
$env:NODE_PATH='C:/Users/rusin/AppData/Local/Temp/LIB-WM-Recovery-20261002/test-deps/node_modules'
```

| Evidence | Result |
|---|---|
| `currentness-red.log` | EXIT 1, old success replaced post-restore status with pre-restore status |
| `readset-red.log` | EXIT 1, mode drift still published fulfilled old results |
| `final-await-red.log` | EXIT 1, persona drift during the final HTTP await was not rejected |
| `context-error-code-red.log` | EXIT 1, newly introduced context error lacked its separate machine-readable code |
| `hidden-start-red.log` | EXIT 1, a completed physical action started a fresh query after the UI was closed |
| `absent-context-red.log` | EXIT 1, explicit native no-character prevented global control reads |
| `registered-restore-red.log` | EXIT 1 against frozen base source; actual held pre-restore HTTP epoch 0 replaced GUI epoch 1 |
| `partial-batch-unit-red.log` | EXIT 1 on c989, initial status refusal published old dependent backup observations |
| `partial-batch-runtime-red.log` | EXIT 1 on c989, stable actual HTTP400 status refusal published dependent backups |
| `final-native-scoped-results.json` | Preserved first-unit 17 PASS with 36 currentness cases |
| `final-partial-retrace_server_control_currentness_test.cjs.log` | EXIT 0, 39 cases including uncertified partial refusal and certified partial success |
| `final-partial-retrace_server_restore_gui_runtime_test.cjs.log` | EXIT 0, registered GUI, real HTTP/SQLite restore/restart/native controls and partial-batch faults |
| `final-partial-scoped-results.json` | 17 named scoped files EXIT 0; aggregate suite intentionally UNRUN |
| `syntax-results.json` | 4 changed JS files syntax EXIT 0; `git diff --check` EXIT 0 |
| `final-partial-network-guard.jsonl` | Not created: 0 guard events; actual model/embedding calls 0 |

Base runtime RED command:

```powershell
$env:RETRACE_SOURCE_FILE='C:/Users/rusin/AppData/Local/Temp/LIB-RETRACE-RestoreNext-Evidence-20261003/base-RETRACE.js'
node Librarian-System/PROGRAM/tests/retrace_server_restore_gui_runtime_test.cjs
```

The frozen base file was extracted byte-for-byte with `git show 2058bce5:Librarian-System/PROGRAM/plugins/RETRACE.js` through Node `execFileSync`, without editing the original checkout. Candidate commands omit `RETRACE_SOURCE_FILE`.

The 17 scoped commands are `node Librarian-System/PROGRAM/tests/<name>` for: `retrace_server_control_currentness_test.cjs`, `retrace_server_restore_gui_runtime_test.cjs`, `retrace_server_control_flow_test.cjs`, `retrace_server_control_navigation_test.cjs`, `retrace_server_control_render_test.cjs`, `retrace_server_handoff_test.cjs`, `retrace_scope_refresh_cache_test.cjs`, `retrace_scope_manager_contract_test.cjs`, `retrace_gui_ux_contract_test.cjs`, `retrace_offline_gui_contract_test.cjs`, `native_branch_retrace_gui_scope_test.cjs`, `retrace_delete_controls_test.cjs`, `retrace_owner_discovery_timeout_test.cjs`, `retrace_namespace_snapshot_runtime_test.cjs`, `retrace_u1_all_owners_owner_writer_test.cjs`, `retrace_u1_public_handoff_test.cjs`, and `retrace_dynamic_owner_gate_behavior_test.cjs`.

## Physical proof and boundaries

The new runtime test executes the full RETRACE body and its real registered callback, DOM events, confirmation dialog, bridge and server restore code. The Risu API is a standalone mock host and the DOM is jsdom; no native Risu/browser acceptance is implied. Browser-global fetch is absent in this mock host; server transport uses the real host `nativeFetch` routed only to its isolated loopback server. The optional GitHub release notice therefore makes no request.

The fixture creates a server backup through the GUI, changes a selected `hayaku` namespace record, proves preview and cancellation do not mutate it, and confirms a fresh restore preview. It compares every payload field after restore, a fresh owner HTTP read, SQLite/server restart, and a fresh plugin registered GUI reading durable restore history. This namespace fixture is storage proof; it does not claim its custom record schema is an actual HAYAKU canonical ledger. Separate existing four-owner writer/readers and public handoff tests pass.

The same full-plugin realm switches actual native fixture methods to `null` character selection and `-1` chat selection, reaches the real final HTTP status authority, and publishes current global status/history. A no-chat-to-selected transition during that held authority response clears the old readset. Native selection exceptions and malformed character objects surface as failures and never publish absent-selection results. These controls simulate supported native API values; native Risu acceptance itself remains UNRUN.

Root's independent partial-batch hypothesis was reproduced on frozen c989 with a real loopback HTTP fault proxy. An initial status HTTP400 (`fixture_status_refused`) is a non-outage failure; old history is held after the physical upstream read. A real restore advances epoch 0 to 1 and exact raw SQLite readback passes, while the final authority HTTP200 observes epoch 1. c989 still publishes the old history without the restore operation. Evidence is independently preserved at `C:/Users/rusin/AppData/Local/Temp/LIB-RETRACE-PartialBatch-Independent-Review-20261003/partial-batch-http-red.{json,log}`; JSON SHA-256 `d5f007372267aa80ab3c33b1e04e05294f53a0f39bdb3bfbc53041183aefbe53`. The sole original epoch comparison was skipped because `results[0]` was rejected; connection readset identity does not certify those old observations' epochs.

The new runtime regression executes both a stable original-status HTTP400 refusal and another refusal with a physically held old history while a second actual restore increments epoch 1 to 2. It proves that neither batch publishes, the preview is cleared, current authority/history remain reachable, every restored raw SQLite payload field matches, the unselected namespace and original host bytes stay unchanged, and later complete positive refreshes still work. The first restore remains driven by real registered GUI confirmation; the second fault-control restore is initiated through the actual management bridge as fixture setup. No mock producer supplies the history or SQLite result.

Restored payload SHA-256: `efa30aa256ba2dde5b4dd1ed2b263d58c1e9959a694dd8fdf8df385c0a0f8cde`. Immutable mock host original SHA-256: `e97bdf85a42341480f18dd29b4bc08b2e5d1c5e20bd7425d0915aee4cb83ceed`. Reset epoch advances exactly 0→1; old owner HTTP reads and writes receive 409, fresh owner reads every original field, and an unselected LIBRA namespace remains unchanged. No reset choice is approved automatically.

## Remaining shared failure and UNRUN gates

`shared-poison-observation.log` remains **FAIL/EXIT 1**, separately preserved rather than counted as a final passing test. Its real HTTP/SQLite probe uses a frozen base plus the earlier token-only UI fence (`token-only-RETRACE.js`, SHA `e9488007823f60b2e3f9c285547b347099cbad96b0a38d9fc800c7bbb3dde4f3`) and read-only transport/normalizer instrumentation. It reproduces a concurrent namespace scan crossing restore: real `/v1/kv/keys?namespace=hayaku` replies 409 `MEMORY_SUITE_RESET_RECONNECT_REQUIRED`, then the embedded shared SDK matches `reconnect` against the `econn` availability regex and stores URL-wide `MEMORY_SUITE_SERVER_UNAVAILABLE` in `sharedBootstrapFailures`. Subsequent same-runtime control reads fail before HTTP. `shared-poison-http.jsonl` and `shared-poison-causal.jsonl` retain exact payloads, stack, and cache-before/cache-after values. Canonical SDK owner has a separate narrow fix; it is not included in this product-only commit. `MEMORY_SUITE_CONNECTION_STALE` classification was also observed and remains separate.

The final product test lets the independent scanner settle and creates a fresh preview after it changes server scope indexes. A correctly stale preview was previously refused by the server with 409; the fixture requests a new preview and preserves that gate. An initial fixture comparison of an absent epoch as `undefined + 1` failed with NaN and was corrected to the protocol's numeric zero. An attempted forced SDK bootstrap caused an initial `MEMORY_SUITE_CONNECTION_STALE` due to concurrent bootstrap sequencing; the implemented caller uses ordinary bootstrap and an observational status read instead.

Native GUI/accessibility acceptance, portable ZIP/full-host restoration, complete five-owner global/all-chat integration, namespace scanner currentness across restore, model/embedding/provider execution, aggregate suite, build/release-size checks, main integration/push and performance measurements are UNRUN or owned by the parent/shared owners. This unit adds one extra manager status request per control refresh and makes no latency claim. Parent independent review, backup/bundle restoration, build and promotion remain pending.
