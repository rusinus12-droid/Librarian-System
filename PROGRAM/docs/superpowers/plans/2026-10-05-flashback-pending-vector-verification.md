# Pending-vector candidate verification contract

Status: isolated, unadopted candidate. No real RisuAI host or provider validation.

## Implemented boundary

The existing advanced reembed selection now previews an opaque common-controller physical_storage_repair action. It freezes the eligible, already-durable pending groups in the current verified local scope. The existing embedding queue/reservation/engine performs the work. The physical route never prepares migration, seeds excluded legacy uncertain registry entries, rebuilds raw sources, or embeds an archive.

The private execution context carries strict local readers through boundary checks, source/worldline/registry reads, commit allocation, candidate readback and manifest publication. It retains the existing local shared scope mutex. Generic server writer admission is not entered by this private local capability. Caller-provided booleans cannot obtain it.

Execution uses one shared request ledger, query preflight and document requests without retry. Requests have actual invocation IDs; document receipts bind only their own durable attempt and jobs. Checkpoint reuse does not create a new request. Settings and credential reads are read-only, including legacy setting shapes.

Strict local writes reuse the existing shared same-key mutation tail. Normal captures therefore wait for a timed-out physical host mutation to actually settle. Each write has its own admission lifetime, checked before and after the authority read following any predecessor wait. A queued write whose caller expired cannot issue later, even while sibling work keeps the overall operation alive. Actual effect rows are created only at the host invocation; late settlement cannot promote a sealed result.

The journal, individual candidate writes, manifest publications and provider requests are recorded independently. Candidate receipts retain an unknown result even when a sibling write succeeds later. Manifest receipts remain available when reservation fails before returning its proof. Cancellation cannot erase an already-issued host write. Exact deeply frozen, per-execution controller-sealed results survive screen invalidation without status promotion.

An unresolved physical preflight or interrupted physical journal blocks new physical and legacy queue/maintenance entry points, including after restart. The existing explicit durable unknown-attempt acknowledgement capability remains separately validated; merely setting a public retry flag is insufficient. Read-only inspection remains available. Automatic reconciliation or unlocking of ambiguous preflight outcomes is not implemented by this candidate.

## Count meanings and limits

- eligibleSources / eligibleRecords: locally durable pending groups and their candidate record count from the verified preview.
- completed / pending / failed / unknown: disjoint record counts for this selected execution, not all owner data. Unknown target IDs derive only from unconfirmed document-provider requests or unconfirmed completion publications, excluding verified completed jobs. A preflight, journal, candidate, or reservation effect can be unknown without labeling unsubmitted vectors unknown. Normal deduplicated/split batches map back through original input positions; contextual batches retain sourceIndex.
- excludedSources: pre-existing failed, uncertain, legacy/migration-required or blocked source groups excluded from this execution.
- archivePending: retained legacy field name. It is the total recordCount on the linked archive reference, used only as an exclusion count. It is NOT a verified count of pending archive-vector jobs. Archive contents are not repaired by this action.
- finalVerification.complete is execution verification. healthy remains null; no whole-store healthy verdict is implied.
- Local host readback provides evidence, not a distributed transaction or cross-runtime compare-and-swap. Unknown outcomes retain prior/new generations. Server conditional commits, result lookup, reconnect/reverse migration, archive embedding and provider-specific live certification remain outside scope.

## Test evidence

The candidate-root report and logs contain exact commands and aggregate outcomes. Tests use fake hosts/stores/providers and existing disposable loopback test servers. Full and Min artifacts are built from this source and tested only through their public API, with test exports absent. The project-wide broad regression is reported separately from focused passing gates; pre-existing failures and timing-sensitive cases are not suppressed or represented as a full-suite pass.

TDD evidence covers missing physical action, false journal acknowledgement, unknown transport classification, post-digest cancellation, excluded registry seeding, legacy unresolved-result bypass, concurrent candidate outcome aggregation, and the strict internal reader/writer boundary. A fresh independent review found the latter three blockers; their targeted regressions were observed failing before fixes.
