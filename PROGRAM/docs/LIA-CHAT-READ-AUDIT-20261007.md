# LIA chat-read audit, 2026-10-07

Scope: LIA 0.26.83, source SHA-256 `7aa74e80c633e6afbe149a00b088eb0b91c3df9fdcdbacd5ade73fedc433f1c9`. This is a bounded source audit plus small offline fake-host call-count checks, not a latency benchmark. No live RisuAI data, model, network, optimization, stress test, or product change was used.

## Findings

Ordinary Live Persona automatic tracking is already retired in this candidate. The proof before/after functions return their input, automatic scheduling returns false, and initialization registers only the independent emotion-image afterRequest hook. The older version-history comments describe retired behavior and do not establish a currently active poll.

A real repeated host-read path remains in the emotion-image hook when attachment is enabled and the catalog is nonempty. One eligible response performs 12 host API calls in the measured fixture:

| Read | Calls |
|---|---:|
| getDatabase (personas, selectedPersona) | 3 |
| getCurrentCharacterIndex | 2 |
| getCharacterFromIndex (full character) | 2 |
| getCurrentChatIndex | 2 |
| getChatFromIndex (full chat) | 3 |

Call path:
1. afterRequest → handlePersonaEmotionAssetAfterRequest → readPersonaVisualAssetStore → pluginStorage proxy scopedGetImpl → resolveCurrentScope → memorySuiteLiaCurrentScope → getLiveRuntimeContext: 5 host calls.
2. afterRequest → PersonaSelectionManager.read → getLiveRuntimeContext: another 5.
3. PersonaSelectionManager.read rereads getDatabase, then PersonaBindingManager.read rereads getChatFromIndex: another 2.

The warmed disabled-attachment and warmed empty-catalog paths both measured **zero host calls** per response. A cold config/catalog read still goes through the storage proxy and is a separate case; the zero count must not be generalized to cold startup or nonempty catalogs.

## UI reads

One getContext call with the fixture's managed binding and nonempty catalog measured 46 host calls: getDatabase/current-character-index/full-character/current-chat-index each 9, full-chat 10. One initial context read accounts for 5; eight pluginStorage reads each resolve the current scope through another complete 5-call host read; binding inspection rereads the chat once. The captured stacks show scopedGetImpl → resolveCurrentScope → memorySuiteLiaCurrentScope → getLiveRuntimeContext, including the provider-secret backup read.

refreshPreview separately calls refreshModulePicker, whose getActiveModulesForPicker reads another 5 host values. Thus those two measured phases sum to 51 for this fixture, before any other UI/action-specific work. This is not a universal every-click count: DOM presence, cache warmth, data contents, missing-host fallbacks, and enabled modules change the path.

renderPreview also invokes collectCompletedTurnPairs(ctx.chat), which scans the current transcript and builds/hashes each completed pair. That is a UI render cost, not the ordinary manual-only request tracker. Changing tabs by activateTab itself does not call getContext; action wrappers that call refreshPreview do.

## Timers, host copies, and required guards

- getLiveRuntimeContext performs 5 normal host calls, using up to three awaited stages. Missing getCharacterFromIndex can add a getCharacter fallback. Each bounded call has an 1800 ms timeout. These bounds do not measure actual host response time.
- The active SDK server panel has a 1-second UI job-status refresh. This is not evidence of a 1-second transcript poll.
- Log persistence and debug snapshots use deferred timeouts; IPC setup can retry after 500 ms until registration is available. No active Live Persona repeating chat scan was found.
- Main badge refresh is event/action driven and returns immediately without main-DOM permission. A refresh without a supplied snapshot can obtain another full context.
- PersonaBindingManager.write deliberately rereads the chat before and after setChatToIndex and checks the expected old binding. These are mutation safety reads, separate from avoidable read-only selection duplication.
- Persona-array mutation deliberately reads the whole personas collection initially, again for conflict detection, optionally again after an asynchronous commit guard, and finally for readback. These guards protect unrelated personas and must not be removed as a simple read-count optimization.
- Explicit health inspection snapshots clone the chat/profile as a currentness witness. It is not called from the ordinary emotion-image response hook.
- Host methods may serialize whole character/chat payloads. The fixture returns in-memory objects, so transport serialization, device memory pressure, and real perceived lag remain unmeasured.

## Source anchors

All line numbers are in the unchanged source above:
- 13200–13215: getLiveRuntimeContext, 5 host calls
- 14121–14151: binding read/write/readback
- 14638–14643, 14668–14679: retired proof tracking and retained image hook
- 14682–14689: selection context plus duplicate DB/chat reads
- 15318–15321: automatic scheduling disabled
- 15378–15423: getContext and durable-store reads
- 21023: full completed-pair scan during renderPreview
- 22145–22152: image catalog read and warmed empty fast path
- 25102–25117: eligible emotion-image response path
- 26925–26936, 26951–26968: preview and separate module picker context
- 28682–28693: explicit health witness reads and clone
- SDK scopedGetImpl line 4189 onward (embedded line 5657 onward): current scope resolution occurs before the local-only short circuit, including excluded keys.

## Reproduction

Run `tests/lia_chat_read_count_audit.cjs` with the exact Task5B no-network and source-audit preloads. Evidence `chat-read-counts.json` includes observed counts and captured call stacks; `chat-read-counts.stderr` is empty after the successful run. No network-audit log was generated, meaning no blocked network attempt was observed. This audit does not authorize or implement optimization.

## Bounded implementation follow-up

The original audit above remains pinned to its unchanged source hash. The later candidate uses the reviewed local-only SDK route, response-local selection, UI context reuse, and final selection/result guards. A fresh small count run (`chat-read-counts-after.json`) measured 4 host reads in the same nonempty-catalog/no-applicable-publication fixture, 7 for getContext, and zero extra picker reads when passed that context. The standalone picker API still performs its normal 5 reads; only the same-refresh call reuses context. Actual matching image publication/recovery can perform additional guarded reads. No real-host speedup percentage is claimed.
