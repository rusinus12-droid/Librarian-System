# Source detection retirement: bounded candidate

Status: partial, unadopted. The automatic source-consent detector and its request/background/UI scheduling are retired. Whole-history authority/worldline guards listed below are not yet replaced, so this candidate does not claim that all retrospective raw-source scanning is gone.

## Retired paths

- Shared SDK request/start detection, timer implementation, automatic baseline-registration path, automatic mode selector, and load-time migration writes.
- Persisted auto/notify/silent/off normalize to explicit_only in memory. Only an existing explicit settings save writes the normalized value.
- LIBRA request preparation timer and branch source-consent observation. Branch quick signatures now use native message IDs and identity quality rather than text/length.
- HAYAKU request source-history preparation/journal observation, request consent inspection/reload, idle transcript poll/start, historical text mutation classifier and its dead helpers.
- Flashback request source-edit snapshot and source-consent observation during worldline synchronization.

## Preserved behavior

The same verified native source IDs keep analyzed facts eligible until explicit replacement. LIBRA independently verifies the stored canonical payload and exact U+A slot IDs. Its preservation receipt distinguishes verified stable identities from legacy identity unknown; matching fallback IDs preserve already approved facts but do not establish native ownership. HAYAKU uses one unambiguous approved packet identity, respects tombstones and newer generated packet hashes, and preserves stored facts when a visible source edit removes an embedded carrier. Unstable or ambiguous existing source identity is unresolved rather than silently remapped. Flashback preserves one active confirmed source group for the same native IDs; inherited, retired, provisional, and ambiguous groups are not substituted.

The explicit source-view button is read-only. Selected preview/apply still refresh source, use a one-use ticket, and reject source/scope changes, cancellation, newer requests, busy state, and late source changes during model work. Existing analyzers and replacement transactions are reused. No normal detector path dispatches a model.

Independent provider/storage, scope/worldline, native identity, reset/tombstone, secret/POV, and final publication checks are not removed.

## Unresolved full-history proof paths

1. HAYAKU RisuCompat.literalHostAuthority, captureHayakuReadset, and hayakuReadsetRead still serialize/compare chat.message and whole character/chat/database snapshots. They are in-flight authority guards, not edit journals. Replacing them safely needs native topology/metadata plus bounded fresh-source proofs for newly captured pairs. Blind removal could admit stale evidence or ledger commits.
2. Flashback synchronizeFlashbackTurnWorldline computes observedLiveHash using flashbackLiveWorldlineHash before the stored-identity projection. This still compares historical pair content for worldline/cache admission. Its topology-only replacement must preserve known generation, rollback, and commit invalidations.
3. LIBRA's settled explicit-repair publication helper reads source again only when an explicit task is already running; it is not an automatic detector. New canonical batch/selected reanalysis freshness checks remain bounded to their operation.

An unannounced same-native-ID reroll with no authoritative generation/packet event cannot be distinguished from an ordinary text edit without a content detector. No guarantee of detecting that ambiguity is made.

## Coverage and verification boundary

LIA has no corresponding automatic historical edit detector; RE:TRACE's edit checks belong to explicit transfer/concurrent-write protection. Neither product changes here. WM has a separate retirement overlay.

Fresh offline tests cover SDK/DOM migration, native identity/timer controls, actual registered request hooks, source-carrier removal, explicit owner apply and cancellation, late source change, scope change, rollback/identity/corrupt-payload recall controls, and additive source-turn receipts. No real model, server, credentials, installation, main-branch merge, release, or adoption is claimed. Full/Min artifact builds and independent integration review remain parent-owned.

## V2 independent-review corrections

A fresh explicit view now projects a new changed revision over an older applied/failed journal slot without writing the journal. The prior task/event remains visible as history; only the current revision is selectable. Repeated preview/apply and one-use ticket rules remain enforced.

LIBRA full/background audits now verify current approved native ownership before computing a source digest or considering historical reactivation. Editing the same native source IDs back to older text cannot roll the canonical back. Changed native ownership and incomplete/removed batches still take the independent branch/rollback path. The real scheduled callback is exercised after isolating fixture bootstrap scheduling; direct reviewer reproductions are also rerun.

## V3 explicit historical reversion and identity classification

A committed same-slot approved canonical takes precedence over a historical-text match in manual source snapshots. After explicit r1 → r2, editing the same slot back to r1 keeps r2 active during ordinary auditing; a fresh explicit preview/apply can then create r3 from the current r1 text. Historical equality alone no longer supersedes that selection as a response variant. The one-use ticket, selected-source refresh, predecessor retention and late-edit/scope/identity rejection remain active.

LIBRA preservation now returns native_identity_verified only when all current pair segments carry stable identities, the batch IDs are non-fallback and unique, and stored slot IDs, scope and canonical integrity match. Missing, synthetic index or duplicated batch identities return legacy_identity_unknown under the unchanged-slot preservation policy. This classification is request diagnostics only; there is no metadata/schema migration or background journal write. Merged segments require every constituent message to have stable identity.

Unknown identity does not establish native ownership or authorize automatic reanalysis. Mere source-text edits do not deactivate legacy approved facts. Known different IDs, missing/incomplete batches, scope changes and independent integrity failures retain their existing controls. A same-count replacement or unannounced reroll with only reused/fallback IDs cannot be proven from these observations; the policy makes no native-identity guarantee and does not invent text-based edit detection.
