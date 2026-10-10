# GRADIA LIB read-only connection

Approved bounded design: `docs/LIB-GRADIA-READONLY-CONNECTION-NEXT-20261007.md` in the workspace root. Implementation resumed with the user's explicit approval at 2026-10-07 21:01 UTC. This change is not a release or deployment approval.

## Product behavior

The GRADIA References page contains a small **LIB 기억 읽기** card, separate from model/backend hosting. The card provides a loopback HTTP URL, Connect, Disconnect, and a model-free current-memory count/byte check. It never displays the full corpus, credentials, or management APIs.

A private bridge embeds the existing canonical standard Storage SDK and HostLineage source. GRADIA embeds no Compute SDK. Management registration, startup diagnostics, and both auto-migration options are disabled. Its private host adapter denies writes and admits only the existing GRA-principal bootstrap and LIBRA capture/current routes. The SDK and server source were not changed.

The resolver reads the existing shared `libra:v1:scope-registry:v1`. It requires one exact native character/chat match and rechecks both current indexes and native IDs. Missing/ambiguous registry, unsupported native identity, missing local routing storage, non-server-only route, transitions, and unaccepted reset review fail closed. It never scans DATA, creates a scope, guesses a scope key, or accepts a reset on the owner's behalf.

Connect first validates the native scope, bootstraps the existing readonly principal once, then validates capture/current before binding. Disconnect, URL edit, settings import, chat change, and unload invalidate old binding, evidence, corpus summary, and pending connection generations. A 500 ms local-only watcher supplements fresh checks at connection and read boundaries. Chat changes do not automatically reconnect.

Explicit same-URL startup consent is a device-local GRADIA preference, separate from exported/imported settings. It contains only schema, URL and a boolean, not a token or persistent server grant. Fresh installation, unapproved startup, and import alone never bootstrap. Failed consent revocation remains retryable and is visible. Unload waits for the pending preference tail and compensating revocation.

## Verification record

Final runtime verification: source 278/278; Full 35/35; Min 34 passed and one explicit source-only skip; Full and Min each loaded all six plugins; offline reader/policy/legacy/mixed-owner checks 18/18. The focused connection suite is 23/23. GRADIA Full is 2,995,740 bytes and Min is 1,646,258 bytes. The builder reports growth above its historical baselines; these are reporting-only, not a performance acceptance.

Final results and exact hashes are recorded in `.development/readonly-connection-fix-20261007T2158Z/STATUS.json` and the immutable connection checkpoint named there. The directory contains the RED/GREEN logs, final source/Full/Min runs, package checks, and review record.

The focused suite uses the real settings GUI handlers, existing SDK, server request handler and SQLite, with synthetic in-process transport. Network and listener guards remain active. The tests inspect unchanged SQLite KV rows and zero operation rows. Accepted reset witnesses are preexisting synthetic fixtures; GRADIA does not create them.

The existing provider G2 profile remains limited to official OpenAI Chat Completions, `gpt-4o-mini-2024-07-18`, and validated text-field combinations. Corpus limits remain 4 MiB default / 32 MiB explicit maximum, with a 64 KiB evidence-block limit and whole-item selection. A successful memory connection does not assert compatibility with other models.

## Review fixes and remaining limits

Independent static review found four Important lifecycle defects. Each was reproduced before fixing:

1. Retrying a failed preference revocation now actually retries, including cancellation during startup's saved-preference read. Import failure is surfaced.
2. Unload awaits pending consent persistence and its compensating revocation.
3. Native scope is revalidated after preference persistence, before publishing a binding.
4. Native selected indexes are checked again after the final fixed-index identity reads.

Deferred minor: reconstructing the card while Connect is pending can briefly re-enable the Connect button. Generation guards still supersede the prior operation; no authority is expanded.

Real RisuAI terminates plugin hosts after a maximum one-second unload wait. A device-storage stall or forced host termination beyond that window cannot be made crash-proof with the existing plugin storage API. Tests verify the awaited normal lifecycle, not a live-host crash or persistent-storage outage guarantee. This limitation does not permit stale runtime binding publication.

Actual RisuAI/Windows/provider/network validation, broad adversarial/performance stabilization, and the full project release gate remain unrun. No real listener, model call, credentials, persistent access grant, distribution ZIP, source/backup deletion, or main merge was performed. The other five plugin sources, three core server writers, LIA local-only policy, RETRACE manager/handoff, and pending common-input r2 were preserved. Shared r2 remains unapplied and its independent review remains blocked.

## Final combined-state follow-up (GRA-RR-1)

A subsequent independent review found one remaining startup-specific combination: Disconnect before/during saved-consent loading plus a failed first false write lost the uncertainty needed to retry. Both new tests failed against the previous frozen revision. The product fix is one executable assignment retaining possible saved consent before any attempted revocation; only the existing verified latest-revision false write clears it.

The final narrow source delta was independently read-reviewed at SHA-256 `508e121a24a50288e5e3c8e72d982b44f1144ec204f9c83d38c345406cb4c823`, matching the new Full build input. The review addendum is preserved as `.development/readonly-connection-fix-20261007T2158Z/INDEPENDENT-REVIEW-ADDENDUM.md`. The reviewer read RED/GREEN evidence but did not execute tests or accept the rebuilt artifacts. Author source/Full/Min results are recorded separately.

The old checkpoint is retained unchanged for history and is not retroactively cleared. Latest checkpoint: `/workspace/shared/lib-gradia-integration-checkpoints-20261007/lib-gra-readonly-connection-fix-20261007T2158Z`. No wider scope, permissions, model support, shared-r2 work, or performance gate was added.
