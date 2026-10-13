# LIBRA product GUI mapping

## Implementation and ownership

`PROGRAM/plugins/LIBRA.js` mounts the original `libra.html` shell, suite/theme CSS, page structures and icons. Original demo handlers, storage, timers and results are excluded. Plugin UI class normalization/adaptation functions and unreachable former panel generators have been removed. The source declares canonical DOM at construction or hydrates an original dialog template. Existing product APIs remain the writers and readback authority.

| Destination | Actual data and controls |
|---|---|
| Desk | Current scoped snapshot, U+A/committed status, current recall/delivery, original spread/leaf/facts/annotations; actual canonical range selection, receipt/Micro actions and readonly status dialog. |
| Memory | Actual paginated rail/chapter/sheet reader, scoped evidence/context, copy edit, regeneration candidate, original versions drawer and inactive-version deletion. Failed reanalysis preserves canonical; candidate approval remains separate. |
| People | Current Head character fields, seven original tabs, directed relationships and evidence; canonical folded domain management; correction Journal, identity merge/split and pending-resolution workflows. |
| World | Original grid/cardlet/filter shape hydrated from current world rows and evidence; canonical rail/sheet management and scoped correction. |
| Story | Six original tabs, real narrative/history/thread data and direction fields; actual draft/save/reset/readback. Structure management resides in a canonical folded expert section. |
| Settings | Original settings navigation and direct canonical controls for every existing destination listed below. Additional fields absent from the prototype reside in newly constructed canonical folds. |

## Settings field/action correspondence

| Route | Actual controls and handlers |
|---|---|
| memory | Performance preset; recent memory/batch limits; recall count/characters/threshold/blend ratios; memory prompt; original recall fold containing scoped maintenance/migration/retention, extraction tuning and dedicated save. Global and dedicated save use existing draft transaction/CAS/readback. |
| pipeline | Librarian enabled, actual provider choice, Prompt Studio; folded maxChars/timeout, Risu references, custom prompt, generation policies, lenses and review; existing NSFW/profile/per-instruction controls and guidance preview are newly constructed canonical folded controls. |
| logs | Memory/state/draft/recall/embedding/rebuild receipt kinds, actual paged listings/details, usage counters, scoped failed-run deletion; current recall details. |
| references | Actual module lore and character exclusion lists with select-all/clear; response lore enable/start/max/count/characters; saved runtime IDs rehydrated from storage. |
| source_edits | The independently owned MemorySuite SourceRule SDK is explicitly mounted through `LibraMemoryCore.mountSourceInputControls`. Its existing field/action/CSS ownership is an exception; LIBRA does not rewrite shared SDK controls. Preview/apply retain consent and source-write guards. |
| embedding | Actual provider/model/key/dimensions/custom headers and connection configuration; rebuild/start/stop/retry, quarantine, verified same-space migration, cache clear, legacy scan, Ollama discovery and existing diagnostics. |
| providers | Actual provider bank selection/add/copy/delete; context/model choices/fetch, format/stream/cache/reasoning/service tiers, Vertex credentials, JSON headers/body and actual connection test. Fixed RisuAI auxiliary preset retains host ownership and its actual connection test. |
| prompts | Current memory Prompt Studio compact active-profile readback plus canonical expert fold for real stage/section/profile structure. Existing save/activate/default/profile operations persist through product settings. |
| transfer | Existing flow/all configuration exporter, explicit optional secrets, import file/JSON, merge/replace and reset handlers. Export omits secrets by default. |
| general | Actual five diagnostic categories, existing debug/search/readback controls in canonical folds and global save/revert. |
| recovery | Actual portable backup validator and three existing restore qualification modes. Restore uses the existing checkpoint/journal/rollback/readback controller. |

## Dialog and job correspondence

- Original range dialog: only completed five U+A pairs per boundary are eligible. Current incomplete tail is disabled. Actual inventory supplies saved/missing/failed/current-source status and source/identity digests; selected reanalysis and regeneration call existing APIs.
- Original job-memory body: preparing, running, cancel_requested, awaiting_edit, awaiting_choice, adopting, interrupted and every terminal state remain visible or recoverable from the same-job tray across destinations. Progress is actual batch counters; stages reflect actual controller stages. Demo results are removed before mount. Terminal errors/results remain available until explicit dismissal. Historical terminal jobs are not announced as new runs.
- Original comparison body: actual old/candidate text and revision identity; manual authority still requires persisted explicit state disposition before adoption. Before-state and sparse correction controls live in a new canonical fold. Candidate keep/adopt/later call the existing decision API with current job/scope checks.
- Original five recovery kinds: current state replay, correction lifecycle, rollback/rebuild, receipt recovery and Micro retry. Eligibility comes from actual statuses/boundaries, with target identity/status recheck before dispatch. Receipt/Micro operations use their existing revision/sourceDigest-aware APIs. Recovery-job stages/results are driven by real promises and readback, without simulated progress or unsupported cancellation.
- Original correction list and correction body: actual status/lifecycle/paging, selected record/domain/scope, existing Journal/replay/provenance/readback. Pending-evidence selection transfers actual fact identities into the required field-correction flow; selecting alone cannot resolve a fact.
- Original identity merge body: actual partner selection, previewDigest/conflict review and existing merge readback; split's existing fact-assignment controls are constructed in the canonical expert fold. No new automatic assignment policy.
- Original status body: actual U+A, saved canonical frontier, pending turns, Current Head frontier/status, partial canonical segments and segments awaiting state application.
- Original margin-reset body: text describes the existing immediate persistence/readback operation accurately rather than retaining the demo's unsaved-draft claim.
- Product overlays contain keyboard Tab/Shift+Tab, Escape follows the existing decline/minimize behavior, and focus returns to the launching control. Embedded local portable confirmation and restore-mode callbacks decline with their existing `false`/empty-string results. Shared SDK code is unchanged.

## Protection boundaries

All canonical/candidate/correction/replay/backup writes still use product APIs. Current chat/scope/branch and target identity are rechecked before mutation. The optional `deleteCurrentScope.expectedScopeKey` guard additionally checks the asynchronously resolved context before entering its existing deletion controller. Cleanup policy and WM backend logic are unchanged. No actual API keys, user-data fixtures or paid-provider requests are used.

## Named GUI function inventory


| Function | Destination(s) | Source line |
|---|---|---|
| `buildStageResultPanel` | settings | 71100 |
| `buildLibrarianConfigurationReviewPanel` | settings | 72318 |
| `buildApprovedInstructionFields` | settings | 72347 |
| `buildLibrarianAnalyzerPanel` | settings | 72354 |
| `buildTransferTab` | settings | 72723 |
| `buildDebugTab` | settings | 72924 |
| `showDebugExportText` | settings | 72930 |
| `buildBookRecallSettingsPanel` | settings | 73287 |
| `buildLibraClassicPanel` | settings | 73325 |
| `buildLibraLiveContextSettingsPanel` | settings | 73390 |
| `buildGenerationPolicyPanel` | settings | 73415 |
| `buildAssociativeRecallPanel` | memory, settings | 73542 |
| `buildLibraRecallViewerPanel` | memory, settings | 73695 |
| `buildLibraRecallPanel` | memory, settings | 73814 |
| `showCanonicalRangeDrawer` | desk, memory | 73876 |
| `buildBookMemoryModelSummary` | desk | 73933 |
| `buildBookMemoryProgressPanel` | desk | 73984 |
| `buildCanonicalActionPanel` | memory | 74027 |
| `showCanonicalVariantDialog` | memory | 74038 |
| `buildLibraMemoriesPanel` | memory | 74080 |
| `buildLibraServerScopeHealthPanel` | settings | 74156 |
| `buildLibraPromptStudioPanel` | desk, memory, people, settings, story, world | 74574 |
| `buildLibraServerConnectionPanel` | settings | 74755 |
| `buildLibraMemoryRestorePanel` | settings | 74781 |
| `buildLibraHubTabs` | desk, memory, people, settings, story, world | 74820 |
| `openCanonicalReaderCorrection` | memory | 75021 |
| `buildCanonicalEvidenceChainView` | memory | 75034 |
| `buildCanonicalEvidenceDrawer` | memory | 75058 |
| `buildLibraReferenceHubPanel` | settings | 75083 |
| `buildWorldManagerSnapshotNotice` | desk, memory, people, settings, story, world | 75309 |
| `openWorldManagerCorrectionEditor` | desk, memory, people, settings, story, world | 75428 |
| `buildUnifiedWorldStateEditor` | desk, memory, people, settings, story, world | 75533 |
| `buildWorldManagerIdentityMerge` | desk, memory, people, settings, story, world | 75585 |
| `buildWorldManagerIdentitySplit` | desk, memory, people, settings, story, world | 75646 |
| `buildUnifiedLegacySelectionPanel` | settings | 75697 |
| `buildUnifiedRetentionPanel` | settings | 75724 |
| `buildWorldManagerCorrectionEditor` | desk, memory, people, settings, story, world | 75744 |
| `openApprovedCorrectionDialog` | desk, memory, people, settings, story, world | 75818 |
| `buildWorldManagerArticleDetail` | desk, memory, people, settings, story, world | 75894 |
| `buildWorldManagerRecordBrowser` | desk, memory, people, settings, story, world | 75941 |
| `buildWorldManagerCharactersCurrentPanel` | desk, memory, people, settings, story, world | 75957 |
| `buildWorldManagerRelationshipsCurrentPanel` | desk, memory, people, settings, story, world | 75970 |
| `buildWorldManagerWorldCurrentPanel` | desk, memory, people, settings, story, world | 75983 |
| `buildWorldManagerHistoryDetailView` | settings | 76056 |
| `openWorldManagerReplacementCorrection` | desk, memory, people, settings, story, world | 76132 |
| `buildWorldManagerStalledCorrectionNotice` | desk, memory, people, settings, story, world | 76185 |
| `buildWorldManagerCorrectionsPanel` | desk, memory, people, settings, story, world | 76193 |
| `buildWorldManagerHistoryCorrectionsPanel` | settings | 76227 |
| `buildWorldManagerDiagnosticsPanel` | settings | 76262 |
| `buildWorldManagerDomainShell` | desk, memory, people, settings, story, world | 76272 |
| `buildWorldManagerCharactersPanel` | desk, memory, people, settings, story, world | 76278 |
| `buildWorldManagerRelationshipsPanel` | desk, memory, people, settings, story, world | 76279 |
| `buildWorldManagerWorldPanel` | desk, memory, people, settings, story, world | 76280 |
| `buildWorldManagerNarrativeCurrentPanel` | desk, memory, people, settings, story, world | 76282 |
| `buildWorldManagerNarrativePanel` | desk, memory, people, settings, story, world | 76386 |
| `buildLibraSafeHealthControls` | settings | 76509 |
| `buildOperationalHealthPanel` | settings | 76537 |
| `buildStateReplayMaintenancePanel` | settings | 76689 |
| `buildStateTrackingAvailabilityPanel` | settings | 76717 |
| `buildCanonicalJobsPanel` | settings | 76873 |
| `buildExecutionReceiptPanel` | memory, settings | 76919 |
| `buildSharedExecutionLogsPanel` | memory, settings | 76943 |
| `buildAnalysisInputPanel` | settings | 76955 |
| `buildSwallowedDiagPanel` | settings | 76961 |
| `buildDiagnosticLogList` | settings | 77074 |
| `buildDiagnosticLogSection` | settings | 77149 |
| `buildGeneralSettingsPanel` | settings | 77162 |
| `buildBookMemoryRail` | memory | 77277 |
| `buildBookTurnEvidenceSection` | memory | 77309 |
| `buildBookMemoryReadingSheet` | memory | 77344 |
| `buildBookMemoryReaderProjection` | memory | 77375 |
| `buildBookSaveBar` | settings | 77383 |
| `openBookMemoryAdvancedSettings` | settings | 77391 |
| `buildBookJobSummary` | desk | 77393 |
| `buildBookHostLineagePanel` | desk | 77613 |
| `buildBookReceiptRecoveryPanel` | desk | 77740 |
| `buildApprovedAuxiliaryConnection` | settings | 77850 |
| `buildApprovedProviderExpertFields` | settings | 77863 |
| `buildApprovedEmbeddingOperations` | settings | 77909 |
| `buildApprovedMockupSettingsPanel` | settings | 77930 |
| `buildBookQuickLibraResponsePanel` | settings | 78128 |
| `buildBookQuickMemoryAgentsPanel` | settings | 78134 |
| `buildBookQuickSettingsDrawer` | settings | 78169 |
| `createApprovedRecoveryOverlay` | desk, memory, people, settings, story, world | 78420 |
| `confirmApprovedOperation` | desk, memory, people, settings, story, world | 78430 |
| `openApprovedPendingDialog` | people | 78452 |
| `openApprovedStateDialog` | desk, memory, people, settings, story, world | 78470 |
| `openApprovedRecoveryJob` | desk, memory, people, settings, story, world | 78480 |
| `openApprovedRecoveryDialog` | desk, memory, people, settings, story, world | 78501 |
| `openApprovedCorrectionsDialog` | desk, memory, people, settings, story, world | 78566 |
| `buildApprovedRecoveryActions` | settings | 78574 |
| `createApprovedMockupApp` | desk, memory, people, settings, story, world | 78578 |
| `openApprovedPromptDialog` | desk, memory, people, settings, story, world | 78648 |
| `buildApprovedMockupDesk` | desk | 78691 |
| `buildApprovedMockupMemory` | memory | 78747 |
| `buildApprovedMockupSettings` | settings | 78763 |
| `buildApprovedMockupPeople` | people | 78816 |
| `buildApprovedMockupWorld` | world | 78895 |
| `buildApprovedMockupStory` | story | 78938 |
| `buildApprovedMockupDestinationDetail` | desk, memory, people, settings, story, world | 78992 |
| `showSettingsGui` | desk, memory, people, settings, story, world | 79471 |
| `openSettings` | desk, memory, people, settings, story, world | 79552 |

### Literal assets, retired HTML and exceptions

Original `suite.css`, `themes.css`, and LIBRA inline CSS are included verbatim. Fourteen dialog templates match the parsed original DOM exactly (empty-attribute serialization is normalized by HTML parsing). Original Settings navigation/layout is retained with its body slot cleared before actual control hydration. The original app is hydrated after prototype/demo destinations, handlers, values and unused overlays are removed. The plugin GUI region contains zero `normalizeApprovedMockupProductClasses`, `adaptApprovedMockup`, `sga-card`, `sga-grid`, `libra-book-desk-view`, and `libra-book-drawer-backdrop` tokens; canonical field/fold/rail/sheet/dialog constructors declare their classes directly. New expert fields absent from the original prototype use canonical collapsed folds. This absence audit does not falsely classify technical root IDs or independently owned SDK implementations as product renderers.

The genuine shared SDK exceptions are the MemorySuite SourceRule input/consent controls, the independently owned MemorySuite server connection/scope tools, and the portable backup controller. LIBRA maps their launch/mount destinations and applies approved product wrappers/keyboard handling locally; it does not rewrite common SDK storage/protocol/consent/cleanup ownership. RisuAI auxiliary connection/model controls and its native platform confirmation retain host ownership.


## Verification scope

See [GUI-APPLICATION.md](GUI-APPLICATION.md) for current source hashes, regression summaries and host limits. Raw execution logs, mock/model transcripts and screenshots are kept out of this publication. Existing SDK-owned panels retain their ownership boundary.
