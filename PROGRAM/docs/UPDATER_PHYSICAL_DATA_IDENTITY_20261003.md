# Updater physical DATA identity and recovery

The current server publishes a 32-character identity under
`memory-suite.physical-data-identity.v1`. The updater previously produced a
24-character token HMAC. That value changes with authentication token rotation
and is shared by copied DATA; it cannot identify the physical server instance.
The existing server formula and seed format remain unchanged.

`UPDATER/core/data-identity.cjs` implements the same contract without requiring
PROGRAM. The ID binds the seed nonce, canonical real root, device and inode.
An alias of one directory has the same identity; an identical copied directory
has another identity. Token rotation does not change authority. The release
builder's exact UPDATER allowlist includes this standalone helper.

`dataInstanceId()` and recovery lookups are read-only. Missing, partial or corrupt
seeds fail without regeneration. A **fresh apply** checks pending journals,
receipt paths/versions and the existing authentication token first. Its explicit
`prepareFreshDataIdentity()` step can bootstrap an absent seed, before checkpoint
creation and before migration's immutable source snapshot. This adds one seed
file to previously unseeded DATA; it is not a claim that such initialization
preserves the entire prior tree byte-for-byte. Existing DATA files are preserved.
Corrupt seeds and invalid tokens fail before updater lock/journal writes.

New journals have engine revision 5, the exact identity contract, and descriptors
containing the ID, canonical-root SHA256, seed-file SHA256, device and inode.
The seed nonce, token and raw absolute root are not copied into these descriptors.
Pending old token24/no-contract journals are preserved and rejected with
`UPDATER_LEGACY_DATA_IDENTITY_REVIEW_REQUIRED` before seed creation, locking,
server control or journal writes. Terminal legacy journals remain history/no-op.
There is no automatic 24-to-32 conversion or alias-equality fallback.

The canonical on-disk journal is authoritative, including when a public rollback
caller supplies an older in-memory snapshot. A supplied snapshot cannot undo a
durable commit or bypass legacy admission. A different operation, alternate
journal path, or supplied-only non-durable journal fails before updater writes.

For a rejected legacy pending journal, preserve the journal, complete instance
and rollback/checkpoint trees. Review their original provenance and physical
DATA ownership before selecting a recovery procedure. Do not replace its ID,
revision, flags or commit markers to bypass admission. Actual older PROGRAM
builds that only publish token24/no-contract health are outside automatic
finalization support; the tests using versioned copies of the current server do
not certify those historical builds.

Directory moves change path authority. Each controlled move records durable
source and destination descriptors **before** rename. Recovery validates the
saved source or saved destination, including inode and seed fingerprint, before
its first mutation. It never derives a new trusted destination from whatever
DATA happens to exist after a crash.

Program-only candidate DATA retains the original directory. Its checkpoint is
a different physical directory. Checkpoint restoration explicitly adopts only
the destination ID recorded before its rename, then records a durable restored
decision before restarting a writable server. Subsequent recovery preserves
writes accepted after that decision.

Migration retains seed bytes for logical continuity, while source DATA,
DATA.next and promoted DATA have distinct physical IDs. The old move, promotion,
quarantine and restoration intents pin each directory transition. Rollback of
the original directory to its original root restores its original ID. Commit
and rollback finalization require the expected version, bound physical ID,
exact contract and live maintenance mode false, whether health already exists
or startup returns it. A committed operation remains forward-only on failure.

Scoped validation includes actual server `/health` producer/consumer matching,
token rotation, copied roots, aliases, missing/corrupt seeds, legacy pending and
terminal journals, invalid fresh input, checkpoint and promotion replacement
attacks, and eight wrong-health finalization negatives. Actual child termination
covers eleven program-only and ten migration rename/decision boundaries.
The existing real HTTP/SQLite/launcher success, candidate failure and committed
live failure cases run unchanged. Packaging verification reopens a ZIP built
with the official file allowlist and requires the engine with PROGRAM absent.

These are Temp fixtures and offline guarded checks. They do not constitute
native multi-platform certification, real user DATA migration, historical
PROGRAM compatibility, or a complete release publication approval. Official
source/release builds and final combined-head metadata are separately verified.
