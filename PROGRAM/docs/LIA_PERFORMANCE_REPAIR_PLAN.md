# LIA 0.26.61 performance repair

## Problem

LIA 0.26.60 performed work proportional to the complete chat on every committed assistant output. It rebuilt and hashed every completed user/assistant pair before selecting the one output pair. Ordinary narrative requests also entered Persona Proof and inherited-binding discovery even when the current chat had neither a dynamic Persona nor a Live Persona binding. The emotion-asset after hook repeatedly reopened configuration and asset storage, and the GUI waited for every thumbnail serially before binding the rest of the asset controls.

## Repair order

1. Preserve Live Persona ownership, five-pair cadence, ledger rollback, reroll/Auto Continue revision checks, and durable binding readback.
2. Build and hash only the committed output pair; count prior logical pairs without retaining or hashing their content.
3. Revalidate only the pending five-pair batch immediately before mutation and in the commit guard.
4. Do not schedule the Live Sync check for ordinary pairs below the five-pair threshold when the complete cached binding state proves the current scope and progress.
5. Treat a completely loaded missing binding as a valid negative cache and skip owner discovery when no copy/handoff marker exists.
6. Exit Persona Proof early for an ordinary chat with no dynamic Persona and no enabled Live binding.
7. Cache illustration configuration and the verified empty visual-asset state; check asset availability before reading Persona selection.
8. Load thumbnails only on the asset tab, bind controls immediately, and hydrate at most four thumbnails concurrently.

## Verification criteria

- JavaScript syntax check passes.
- Idle/off Live Sync creates no polling interval and output events do not fetch character/chat state.
- An ordinary beforeRequest performs at most one current character/chat read and no pluginStorage read or write after startup cache population.
- A warmed empty-asset afterRequest performs no host or storage I/O.
- A 500-pair, roughly one-million-character committed-output fixture resolves exact pair 500 in under 80 ms.
- Same-turn revisions remain upserts, and both output-revision and direct-chat mutations invalidate a stale five-pair batch.
- Live Persona binding transaction, shared-server restore, World Lore Compute local/server, and release metadata regressions pass.

## Validation boundary

The automated evidence uses Node VM host mocks and local server fixtures. It proves the implemented call/count, revision, storage, and performance contracts, but it does not substitute for a live RisuAI WebView trace, real provider latency, or device-specific rendering measurements.

## Completed validation

- Full regression batch: 224/224 PASS.
- Long-chat committed-output fixture: pair 500 resolved in 1.85 ms in the final full-suite run; the pre-patch 500-pair fixture measured 158.99 ms on the same host.
- Ordinary no-Live beforeRequest: one character read, one chat read, zero pluginStorage reads, and zero pluginStorage writes after startup cache population.
- Warmed empty-asset afterRequest: zero additional host or storage I/O.
- Manifest and package SHA-256 layout verification: PASS.
