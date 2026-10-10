# WM paged backup and restore v2

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST. Basic synthetic SQLite verification only. Actual activation/native owner, whole-feature E11/AC03, whole-plugin RSS, Windows durability, concurrency and crash qualification remain open.

## Version dispatch

- Existing `wm.backup-component.v1` generation/inventory arrays and capture/restore/import behavior retain their separate path. Legacy-only stores still export v1. The legacy explicit assertion continues rejecting root manifests.
- Stores containing `wm.generation-roots.v2` export `wm.backup-component.v2`. The component is a small manifest containing count/SHA-256 summaries for generations, current heads, raw inventory, nonstructural content inventory and operation history. It does not hold whole-store arrays.
- Existing 11-table `wm.sqlite.v1` schema and immutable triggers are unchanged. The cut is `wm.backup-cut.v2`; descriptors are separate ordered `backup-cut-item:` metadata rows. Live pins, snapshots, execution stage/lease records and source staging authority are excluded. Page receipts and handoff staging provenance remain inert evidence.
- Existing component-bundle dispatch accepts either component version. No full-project or live-user backup is performed by this change.

## Capture and readback

Capture compares the pinned snapshot with the complete current cut inside the existing SQLite transaction and copies admitted rows into a separate component file. Every blob is hashed in at most 256-KiB chunks. Descriptors, generations, heads, cut records, operations and provenance are iterated. FILE-backed SQLite scratch tables hold dependency frontier/visited state; no complete inventory, generation, mapping or closure JavaScript array is introduced on the v2 path.

Readback checks schema, triggers, integrity/FKs, immutable descriptors/blobs, all current and historical generations, intent/Prepared/expected-head binding, exact canonical projection, all root proofs and reachable closure membership, cycles, missing/foreign descendants, proof digest/bytes, operation receipts and independently materialized handoff chunks. The current-head summary and source cut digest are bound into the component.

History pages stay at 65,536 bytes with at most 128 direct dependencies; descriptors/cut items are at most 65,536 bytes; root/import mapping metadata are at most 16,384 bytes. Existing canonical payloads retain their 64-MiB limit. Compatibility rows are finitely bounded: legacy manifest/source-manifest 128 MiB, encoded intent 512 MiB, receipt 128 MiB and other metadata 96 MiB. Limits fail closed, never truncate or silently drop records. A mixed legacy generation may still require one bounded legacy JSON row/items list in memory. These are store-size-independent row limits, not a small-RSS or constant-time guarantee. Verification remains proportional to retained data and repeated closure readback can be expensive.

## Same-physical restore

The existing separately enabled restore plan/confirmation installs a verified independent stage only for the same physical identity. Route/writer/boot incarnation rotates; every historical operation is fenced. Paged data, proofs and current cut remain byte-exact. The target remains `recovery_required`. A committed retry returns the same receipt; unchanged publication ACK loss uses the existing journal/readback path. No writer activation is supplied.

## Explicit fresh-target import

The existing separately enabled, confirmed fresh-target importer handles v2. Source files and live source data are never changed. The staged target rebases generation, Head, Prepared and operation identity while preserving every content-addressed history page, all raw/canonical payloads, scopes, semantic keys, indexes, frozen results and orphan/source-provenance records.

Structural generation/legacy-bridge roots are rebuilt for the target identity; original structural records remain preserved. Closure proofs, canonical dependencies and the target inventory digest are recomputed. `plan.inventoryDigest` and `receipt.sourceInventoryDigest` refer to the source; `receipt.inventoryDigest` and admission inventoryDigest refer to the target. They are intentionally different when structural roots change. Restart selection validates both independently.

Original manifests, source heads, source cut descriptors and generation mappings are retained as bounded per-row inert evidence. Verification checks source summaries/cut against the component, derives every target manifest deterministically (including dependencyRoots and baseGenerationId), binds current target heads to the component’s original head summary, verifies all original inventory descriptors remain present, and ties every generated operation marker to the actual rebased operation. A self-consistent rehashed stage cannot substitute missing/older current heads, omit reachable history roots, or attest unrelated inert operation IDs.

Old source operations and receipts remain queryable historical evidence, never execution authority. Same-ID prepared/staged/publishing/committed reconciliation and no-clobber publication retain existing behavior. Existing targets are never overwritten, stage cleanup does not delete source data, and incomplete or changed recovery evidence remains uncertain/rejected. SQLite staging, file publication and receipt persistence are separate phases (`wholeTransferAtomic:false`).

## Verification boundary

Focused basics cover capture, same-physical restore, fresh import, restart selection, exact history/result/pending lookup, semantic-lock and unchanged-event dedup, mixed raw history/orphans/empty scopes, multi-generation roots, target re-export, source immutability, saved lost-ACK reconciliation, no whole metadata `.all()` calls, byte limits and targeted corruption/rebase counterexamples. Existing v1 backup/import/bundle/control and root-owner basic cases are preservation checks.

No models, providers, listeners, live DATA, credentials, network, Git/push/deploy, Library, real native owner, actual-host qualification or Full/Min/release refresh is included. The fixture’s recovery-readable owner is not activation or all-writer admission. All higher-level production qualification remains provisional.
