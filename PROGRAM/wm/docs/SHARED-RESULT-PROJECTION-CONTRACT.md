# Shared WM result projection

Fixed delivery 4, FEATURE-FIRST. This is a read-only consumer adapter, not a new storage owner, source authority, character-knowledge engine, or analyzer.

## Consumers

- A request-local opaque snapshot captures current WM result rows once. Cards, final response, and enabled Story Author/Director consume the same value, classification, currentness, visibility and story-clock/effect semantics for the captured scope and exact scene focus. Each emitted row identifies that snapshot version.
- Final response uses the existing section/token budgets. Planner input replaces its prior raw tracker/WA block inside the existing request; it does not add an analysis call. Dedicated permission-partitioned committed analysis and its result/attempt accounting remain separate and unchanged. Canonical extraction receives neither raw extension results nor result-bearing stored planner prose.
- Private results, including fictional reproductive results, are management-only. A matching character/viewer name does not grant writer, director or response access. Public output requires the current result's public permission and exact current-scene target match. Unknown is not false, absent, or a negative observation.
- Existing tracker classifications remain `observed`, `interpretation`, `derived`, or `simulated`; their underlying calculation and legacy observed history are not rewritten. Canonical observation and fictional simulation axes remain distinct.

## Legacy results

Old WA, world-item and one-off result schemas do not retain a permission-scoped committed result proof. Their prose, findings, compatibility labels, `manualInjection` toggles and public-looking fields cannot manufacture that proof. They are projected as `unverified`, current value `unknown`, management-only, with explicitly labeled retained content on their existing cards. Storage, history, source text and old observed values are preserved. This delivery deliberately does not migrate or reanalyze them or invent a new legacy authorization schema.

All legacy result-to-response wrappers pass through the shared adapter. No fallback to every target, raw one-off summary, or parallel legacy output path is permitted. User-authored definitions and dedicated analysis workflows retain their storage and editing behavior; an injection toggle requests use but does not bypass currentness/privacy checks.

## Late changes

- The final host-request boundary rechecks the captured result view after awaited preparation. A changed scope, permission, result or relevant freshness state returns the original opaque host payload without WM injection.
- The existing planner call checks the same captured view at queued admission and each provider transport reservation, including retries/fallbacks. A late change prevents the next send; it does not retry or reanalyze.
- Stored planner output retains only the result-version identifier in existing planner provenance. It is withheld when that identifier no longer matches the current result view or scene focus. Deleted results do not restore old planner permission. Scene diagnostics, handoff inputs and heuristic refresh also exclude stale stored planner content; a new result version cannot restamp an old private copy. Old unstamped planner output is not treated as proof that it was isolated from existing extension results.

## Verification boundary

Focused fake-owner, fake-payload/transport and management-card tests, source-only assembly and syntax. Provider retry checks use the actual phase-string observer contract and fake transport; known original fixture errors and RED results are retained. Effect-clock advancement retains its existing result semantics through the corresponding committed clock source, without rewriting the original observed event. No actual host/model, broad regression, privacy-taint/export campaign, concurrent out-of-band writer/ABA proof, full release build or production authority qualification is implied. Full/Min and release metadata remain stale.
