# Bounded committed-extension batches and transport attempts

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST. This closes the bounded oversized-batch/progress and committed-extension attempt-accounting slice. Overall E04/E08 and production qualification remain partial.

## Work selection and progress

The existing selector first partitions canonical evidence by the tracker's declared visibility. Within that partition, trackers sharing an evidence ID form an indivisible component. A shared user-bundle label alone does not merge independent evidence. This is a local complete-evidence grouping rule, not a new dependency graph or source authority. All supplied evidence and definitions stay whole.

Components are deterministically packed in tracker-ID order. The current maxTrackersPerAnalysis, 5,200-character definition ceiling, and the existing common AI input/output preflight remain authoritative. The exact execution prompt renderer also decides whether a proposed pack fits. Several independent small components can therefore advance instead of waiting forever as one oversized permission group. One oversized component remains explicitly waiting, and does not stop another fitting component from being prepared. No definition, evidence body or shared occurrence is cut to fit.

One existing interpretation slot handles at most one unfinished chunk per maintenance pass. The existing separate generation role, provider retry policy, AI pause and zero-model time/structured-only rules remain. No proposed 2-call, 8-turn, 8k/2k-token or 4/12-candidate defaults were installed. Packing, journaling and UI inspection do not call a model.

The existing extension event stores the chunk plan. Each successful chunk uses the existing immutable staged-result role, and is saved through the current canonical owner before the maintenance pass completes. Later passes and reloaded runtimes reuse saved roles. Chunk identity encodes exact membership; a repack cannot silently use another chunk's result. Old unsplit and permission-partitioned prepared results retain their prior guard and role identity. There is no automatic replay of an interrupted dispatch.

The recovery view shows completed chunks versus the planned total and explicitly identifies oversized work. Completed chunks mean saved interpretation results. They are applied through the existing event consumer after all required chunks are ready; an oversized component can still hold final application. A never-completed plan may be recomputed after definition/limit changes, while frozen results continue to require their original dependency guard. Arbitrary edits to already prepared dependencies remain a separate recovery decision.

## Durable transport accounting

Only committed-extension tracker/generation dispatches participate in this new ledger. Other canonical, direct-add/manual-analysis and embedding paths keep their existing behavior; this is not a claim that all WM jobs now share one cost ledger.

The current common provider forwards a journal observer to its existing transport. Immediately before every actual transport request, including HTTP/network retries, provider fallback requests and their retries, it must persist a dispatch reservation. An observer persistence failure stops that request and cannot trigger a provider retry. The observer is also awaited for observed response, transport error, or cancellation/deadline before dispatch. Authentication/model-list/embedding requests are not model-attempt records.

Every record binds:

- Existing extension event/job ID, captured packet ID/revision/scope and source fingerprint
- Exact interpretation permission/chunk role, or the existing world role
- Logical request generation, incremented only by the existing explicit user-retry action
- Monotonic event attempt sequence, common profile/provider/model, invocation and transport retry index

No credentials, endpoint URL, prompt body or provider response body is copied into the ledger. Small immutable reservation and completion records use the existing extension-lock namespace and owner. The event stores bounded aggregate counters. Paged history keeps these records in the same cold/index roots and migration/backup closure; no new storage owner or whole-history in-memory ledger is introduced. Exact attempt reads load only the requested records.

A dispatch reservation is not proof of remote acceptance or billing. A crash after reservation but before an observed completion leaves `dispatch_outcome_unknown`. A response record proves only that a response was observed; a transport error does not prove that the remote model did no work. Explicit user retry keeps the same job/captured source, creates a distinct request-generation identity, retains all earlier records and may repeat an externally uncertain operation. Exactly-once external execution is not promised.

The UI distinguishes reserved dispatches, observed responses, transport errors, known pre-dispatch cancellations and unresolved outcomes. Older batch-level `attempts` values remain separately labeled as legacy counts of unknown transport cardinality. Restart, queue re-registration and explicit retry do not reset the new counters. This accounts for attempts; it does not introduce a new spending limit or claim metered currency/token billing.

## Verification boundary

Focused fake-provider, real assembled maintenance/journal, reload, legacy-result, permission-group, UI and native-paged tests plus source assembly/syntax only. Synthetic provider calls are in-process and cannot reach the network. Real models, actual host DATA, native/server all-writer concurrency, billing accuracy, adversarial crash matrices, global RSS, whole-feature parity, deep regression and release qualification remain untested. Actual activation stays false; production profiles remain empty; distribution Full/Min and generated release metadata remain stale.
