# GRADIA: bounded LIBRA, HAYAKU and Flashback reads

This extends the existing G2 read-only connection path. It does not create a GRADIA storage owner, enable core3 authority/full-corpus-v2, change RisuAI core, or broaden model support.

## Connection and migration

- A fresh **읽기 전용 연결** requests the fixed reader allowlist `libra`, `hayaku`, `flashback` with `X-Memory-Suite-Read-Owners`. The server signs that exact set into the dedicated GRADIA capability. Write namespaces remain empty.
- Old capability tokens lacking the signed reader set remain LIBRA-only. Supplying a broader request header with an old token cannot expand it.
- Existing `gradia.lib-read-connection.v1` exact-URL startup consent remains LIBRA-only. Explicit reconnect writes v2 consent, including the approved owner set. v2 startup uses only that saved set and exact URL. Imported settings, changed URLs and Disconnect still revoke startup consent.
- Current native character/chat IDs are read twice with stable selected indices. LIBRA uses its exact scope registry. HAYAKU uses its registered SDK routing descriptor. Flashback uses its routing descriptor or existing native v2 scope registry. There is no guessed scope creation or registry repair.
- Only registered server-only scopes are selected. Absent, removed or plugin-only owners are visibly listed as unavailable. HAYAKU global routing without a current-scope descriptor is conservatively unavailable. Ambiguous identities, transitions or unknown registry schemas fail closed.
- Every selected owner must capture successfully. Missing or corrupt selected dependencies invalidate the whole evidence session; GRADIA does not silently use the other selected owners as a partial snapshot.

## Producer adapters

All routes are POST-only and available only to the dedicated GRADIA principal with that signed owner permission:

- `/v1/libra/read-session/{capture,current}`: existing `libra.manifest.v1` and committed canonical-memory references, including approved inherited/predecessor references.
- `/v1/hayaku/read-session/{capture,current}`: `hayaku_storage_ledger_v1/v2` with exact stored scope identity, producer-selected active/historical slot heads and tombstones, complete `hayaku_packet_v1` revision-2 packets, exact referenced capture-raw receipts and verified immutable shared-archive chains. Unbound/superseded records, raw conversation fields in receipts and unrelated recovery/configuration keys are not emitted.
- `/v1/flashback/read-session/{capture,current}`: published v2 manifests and committed raw shards, including verified COW raw-page references and immutable inherited archives. Producer-retained response/episode records are included. Vector shards, embedding credentials, manual/static retired records and unrelated configuration keys are not read as evidence.

Both new adapters use the actual producer hashes, checksums, serialization and archive identities. Archive gzip decoding is bounded before allocation. Read units use rollback-only transactions and metadata/digest consistency checks. Currentness checks use only captured physical dependency metadata, DATA identity and the selected owner's reset epoch. This remains logical currentness, not a physical-ABA authority certificate.

## Evidence and limits

- One combined corpus: 4 MiB default; 32 MiB maximum. Owners receive only the remaining logical corpus budget. No substring truncation.
- Combined committed item limit: 4096. Aggregate metadata admission: 1 MiB. Each owner retains the existing per-item metadata and bounded stored/decompressed-read guards; combined raw-read allowance remains `7 * maxCorpusBytes + 2 MiB`. The facade passes the remaining allowance to the next owner before any value materialization or gzip expansion. These are protocol/read limits, not an exact JavaScript heap bound.
- Updated 2026-10-15: Whole-item capture packing follows the reference profile, then each stage selects a complete-item subset within its configured model context. See [current budget contract](MODEL-CONTEXT-BUDGET-20261015.md). Initial order uses deterministic newest-first round robin across owners. Exact duplicate text is emitted once with every contributing owner/record/key/source retained as provenance.
- Evidence IDs include the owner and a digest of the record ID plus physical key. Separate records in one HAYAKU ledger or Flashback shard remain distinct; equal IDs from different owners or keys cannot collide.
- Every owner is rechecked before evidence use, dispatch and final handoff. A changed owner invalidates the complete influenced draft. A read unavailable before evidence consumption retains the existing native-only fallback, with no external memory in that payload.
- The native-view guard permits only scope enrichment matching the already-bound character/chat pair. Changed IDs, hashes, generations, foreign scopes, completed-turn selection or prompt text remain rejected.
- Updated 2026-10-15: Final text payloads use the configured stage model/context, actual output reserve and separate byte limits; the GPT4o-mini pin is retired. Input token accounting is a disclosed estimate, not exact provider tokenization. This change adds no model calls.

## SDK preservation

Only GRADIA's private preserved Storage SDK received the reader extension and a new explicit pin (`preserved-readonly-three-owner`). LIBRA, HAYAKU, Flashback, LIA and RE:TRACE SDK variants were not synchronized or replaced. Normal LIB server startup/shutdown and transport remain the connection mechanism.

## Verification scope

Focused offline tests exercise actual HAYAKU capture/ledger/archive serialization and actual Flashback save/archive/COW serialization; real in-process server handlers and temporary SQLite; the actual GRADIA UI Connect handler and private SDK; and the emitted G2 model-request body through a synthetic transport. Tests prohibit sockets and external calls. Scope/identity tampering, permission boundaries, old-consent migration, stale owners, CORS preflight, budgets, deduplication and multiple records sharing one physical key are covered.

These fixtures are not an actual RisuAI/browser run and are not a Full/Min release or full repository qualification. The unchanged historical `tests/gradia_suite_test.cjs` currently references a missing preservation directory; the focused run uses an explicit current file list. The unchanged legacy GRADIA-free contract also still expects four RE:TRACE peers, while the current source already includes WM as a fifth peer; that assertion is a known failing historical check. One unchanged adjacent HAYAKU queue-saturation test timed out in a broader adapter run and passed when rerun alone.
