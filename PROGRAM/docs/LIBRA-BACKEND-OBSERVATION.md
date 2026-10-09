# LIBRA bounded backend observation

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST, 2026-10-08. The genuine Task8A fact-capture stage is implemented. The bounded stored-source graph and modern v4/v5 typed-source stage below are also implemented provisionally. Full Task8A acceptance and full Task8/GRADIA authority are not complete.

## What this proves

`server/authority/observation.cjs` issues an in-process, immutable view of explicitly selected direct canonical LIBRA plugin-KV facts. The source is the actual double-encoded production storage shape: SQLite TEXT containing JSON string text containing the record object. Content is the entire nonempty `memory.text`, never a catalog summary or string slice.

Admission requires the exact live branded authority store, its retained initial qualification receipt, expected authority/control/owner schema, owner guard fingerprint, fence/reset bindings, and fresh ready/no-pending evidence. The marker selects historical legacy5 v1 or explicit core3 v2 decoding. The observer creates no retired physical stores, changes no profile, and cannot qualify/bootstrap/activate an owner. Core3 and historical v1 contracts remain separate.

The binding model is explicitly `qualified-writer-observed-path.v1`. Every capture witness and closure carries that label. It assumes mutations use the qualified coordinator and lifecycle retention. Filesystem identity checks are observations, not file-descriptor-backed physical ABA exclusion, hostile external-writer closure, or permission to operate real DATA.

## One read-only backend path

1. Brand-only control admission does not call the old `readWitness`, `assertAuthorityStore`, ordinary read connection, writer binder or initial qualifier.
2. W0 uses a newly owned readonly SQLite control connection, `query_only=ON`, `busy_timeout=0`, a fresh transaction and UTF-8 encoding admission. Fixed bounded TEXT branches are projected as BLOB and fatally decoded before existing validators use them. Pending intent payloads and route rows are never read.
3. A separate, internally constructed readonly LIBRA connection owns one transaction. The shared pure owner guard/schema verifier operates on that snapshot without writer UDF registration or writable reopening.
4. Fixed metadata reads include live/tombstone/retained-purge/never-present states. Both bounded canonical KV and lifecycle streams contribute to the complete declared inventory. BINARY byte ordering and generated prefix ranges preserve `%`, `_`, colons, non-ASCII and supplementary characters without caller SQL/patterns.
5. Bounded SQL type, byte, object, key-inclusive node and duplicate-key preflight precedes raw source materialization. The conditional materialization query binds size, revision, digest and lifecycle to the same transaction. Exact raw SHA256, strict duplicate/Unicode scanning and full pointer/body identity are then checked.
6. Owner reads end by rollback and conclusive close. W1 is a different fresh control transaction. The complete W0/W1 witnesses must match. A genuine intervening commit retries the entire interval, at most three attempts under one original deadline. No failed attempt issues a handle or partial body list.
7. `assertCurrent` repeats a fresh W0/owner/W1 interval with metadata and complete relevant inventory only. It never reloads source JSON or text. A newer global sequence is accepted if the new interval is coherent and this captured closure is unchanged. Relevant lifecycle/inventory/absence changes revoke the handle; unrelated writes do not.

Main/sidecar path types, links and observed identities are checked before/after owned reads. Nonempty rollback journals and unsupported pending restore/reset evidence refuse. There is no raw database FD, copy/snapshot substitute or cleanup/recovery path. SQLite-managed SHM/readmarks and an engine-created empty WAL remain the logical-read coordination exception. Cross-process protected-byte/fault qualification remains unrun.

### Exact-key SQL projection adjustment

The available Node 24.19.0 / SQLite 3.53.3 engine returned the shadow field for `json_extract('$.text')` when an earlier decoded key contained `text` followed by NUL. The first implementation's engine gate correctly refused all captures. This implementation uses fixed `json_each` with exact `CAST(key AS BLOB)=X'74657874'` instead. Its startup scalar vectors check full NUL narrative length, distinct NUL-containing keys, strict JSON and key-inclusive traversal. Duplicate escaped-equivalent keys are independently rejected in SQL and the strict scanner. The basic fixture checks a shadow key before the real text field. No source rewrite or compatibility fallback occurs. This is an implementation adjustment to the fixed projection, not a claim that SQLite JSON-path extraction is qualified.

## Internal API

- `createAuthorityObserver({dataDir, control})`
- `observeCanonicalFacts({namespace:'libra', requestId, scopeKey, starts, durationMs})` returns `{handle, summary}`. `starts` is a dense ordered unique list of positive direct manifest slots, not submitted source authority. Every selected pointer must be present and committed and exactly match its stored record.
- `readCaptured({handle, requestId})` returns the same deeply frozen `{summary, items}` object each time, without SQL or whole-capture copying.
- `assertCurrent({handle, requestId})` returns `{status:'current', checkedControlSequence}` on a new coherent interval.
- `getUsage({handle, requestId})` provides a small frozen accounting snapshot without body copies.
- `release({handle, requestId})` is idempotent for this issuer's handle; `close()` retires all captures. Strong issuer ownership and source/view/closure references are dropped on release. Caller-held immutable views remain caller-owned historical values.
- `observeSourceClosure({namespace:'libra', requestId, scopeKey, throughTurn, durationMs})` captures the separately declared supported stored-source prefix. Its immutable `readCaptured` view also has a `receipt`. See the source-profile boundary below.
- `captureCorpus()` always throws `SOURCE_PROOF_UNAVAILABLE`. No HTTP endpoint, SDK producer or logical read-session upgrade is supplied by this phase.

Handle brands are private and bound to this issuer, request and original lifetime. Copies, serialized handles, foreign requests, extra request fields, SQL, callbacks, custom codecs and unsupported namespaces are refused.

## Bounded profile and accounting

This is the separate conservative Task8A profile, not the configurable MiB-v2 corpus producer.

- Each outer row and the entire admitted materialized source unit: at most 1 MiB each. Returned narrative and proof metadata also have separate 1 MiB ceilings.
- Strict JSON: at most 65,536 key-inclusive nodes and depth 32. SQL traversal has an overflow sentinel before materialization; the application scanner repeats the structural/duplicate/Unicode checks.
- At most 8,192 distinct dependency/inventory keys; each key retains the existing 4,096 UTF-16-unit / 12,288 UTF-8-byte bound. Other byte/node/credit caps may admit fewer.
- Per attempt: source metadata at most 1 MiB / 32,768 row events; authority metadata at most 8 MiB / 2,048 row events. Counters accumulate across up to three attempts. Metadata, admitted/materialized outer bytes, hydrated narrative, returned narrative and proof bytes remain distinct.
- One synchronous physical owner transaction per issuer; at most four retained handles; conservative application representation reservation ceiling 64 MiB. Reservations precede large acquisitions/parses and are kept until physical settlement. This does not bound SQLite/VM/native allocations, GC timing or RSS.
- Original duration is mandatory 1–120,000 ms. Checks have at most five seconds and at most eight calls per handle, each with up to three attempts. Deadline equality is expired. BUSY and per-check timeout preserve an otherwise live handle; neither extends its original lifetime.

The accounting implementation is provisional. Exact A08/A09 allocator-spy/maximum-boundary qualification and the amendment's full file-metadata event accounting remain open. Filesystem identity/stat work uses a conservative fixed metadata charge; the existing physical identity helper internally rereads its bounded seed. The ledger must not be advertised as a measured complete heap/I/O audit. Deadline checks bound publication and cannot interrupt a synchronous SQLite instruction.

## Supported fact closure versus remaining implementation

Captured dependencies include the entire consumed stored manifest's exact raw digest, direct selected pointers and full canonical bodies, optional exact worldline-meta/catalog rows (including absence), and complete scope-local canonical lifecycle inventory. Tombstone, retained purge and never-present differ. Purge/recreate cannot reproduce the old retained source version under the qualified writer assumption.

These are backend facts only. `routeAuthority` and `nativeAuthority` are unavailable; `recallEligibility` is unqualified. A fact capture may succeed in a scope that also uses unsupported recall features because it does not certify that scope as a corpus.

Still missing or unqualified:

- Ordinary server startup, every writer/maintenance/lifecycle route, external-writer closure and full physical DATA replacement/restore/ABA support.
- Native identity/lineage, semantic mode/route epoch and request-local source-edit exclusion. Stored branch/worldline and key/prefix deletion facts are now supported only within the bounded backend graph below; route-specific deletion identity and native eligibility remain unavailable.
- Full native Micro source/restore eligibility and unsupported historical archive/typed profiles. The backend v4/v5 approved-input, artifact and renderer proof below does not grant native or current-State authority.
- Warm ranked frontier, larger MiB-v2 producer profile, sealed paging/transport and model-selection/source-currentness integration.
- Full Task8A A01–A17 acceptance, second-process commits, encoding/platform matrix, extreme boundaries, allocator spies, fault/fail-stop and protected-byte qualification. Historical matrix files remain planned NOT RUN; the new basic suites are not their acceptance substitute.

The old `gradia-libra-read-session.cjs` remains unchanged logical evidence. No Task6 physical claim is borrowed from it. Production profiles remain empty; actualHostQualified, allWriterOwnership, serverActivation and handoffActivation remain false. The blocked r2 candidate stays unadopted; Full/Min/generated metadata remain stale.


## Bounded stored-source graph extension · 2026-10-08

`observeSourceClosure` is a new backend-only consumer of the same branded, readonly observer. It is not a GRADIA corpus producer or a route/native authority adapter. `captureCorpus` remains unconditionally unavailable, including when a caller supplies purported native or mode proof. The ordinary logical reader and ordinary LIBRA recall behavior are unchanged.

### Declared unit and supported body profiles

The fixed `libra.stored-scope-prefix.v1` unit consists of committed stored current canonical slots admitted by the stored branch guard and declared `throughTurn`, committed inherited canonical members, local stored-host-worldline/session-zero Micro heads through that prefix, and active inherited Micro members. `throughTurn` is a requested bound, not an assertion about the native chat. It must be 1–8,192. The existing separate 1 MiB serialized-source, narrative and proof limits still apply, so a smaller bound may already be unavailable. No accepted unit is silently truncated to fit.

- Canonical content is the entire nonempty `memory.text`. Direct slots, same-scope predecessor records and explicit shared-archive members have fixed locators and exact identity/range checks.
- Micro claims use the full production renderer's validated claims and exact quotes, including every claim. The 600-character summary is never read as evidence.
- Minimum-source-bound Micro uses the full renderer for the verified declared source span. It does not claim that the span is the whole source turn.
- A bounded SQL projection measures the exact Micro rendered UTF-8 byte count before source materialization. It covers local records and embedded Micro archive records; aggregate narrative admission precedes rendering. Stored strings that would require a different trim/coercion representation are unsupported rather than silently normalized.
- Source JSON remains the single pinned double-encoded object codec. Stored legacy FNV-style LIBRA digests are checked as schema identities, never presented as cryptographic hashes. Every consumed physical row and returned body is independently bound by SHA256.

The fixed source codec is now `libra.plugin-json-string.source-closure.v2`. Selected modern v4/v5 canonical records use the typed contract below. Unknown artifact/engine/normalization versions, incomplete linked evidence, invalid artifacts, changed render text or missing required raw/lineage dependencies reject the entire unit. Plain text without an artifact remains supported; a declared legacy v2/v3 artifact is not silently treated as proven typed content.

### One complete graph or unavailable

The capture reads the actual manifest; it does not manufacture a default manifest or accept one from the caller. Required Micro record, receipt, receipt-head and work links must all be present and coherent. Receipt revision/source digests and exact message/role/offset spans are validated. A logically tombstoned source head refuses even if its physical KV row is live. Stored work publication digests are checked; the live runtime token/restore generation and current native source are deliberately not asserted.

The scope's complete bounded KV plus retained-lifecycle inventory protects head/record membership, durable absence, purge history and restore-marker changes. No ordinary `storage.keys()` fallback is used. Live incomplete portable-restore or import journals refuse. Terminal Micro restore markers are retained as dependencies. Scope-wide inventory is deliberately coarse: an unrelated write inside that scope can revoke it.

Canonical archive traversal has a bounded cycle/depth check, full layer manifests, parent-link agreement, delta/record/root digests, membership and inherited-session projection. Each archive namespace has a complete bounded KV/lifecycle inventory. Explicit v1/v2 integrity profiles are parsed, but historical forms missing the required explicit chain fields are unavailable. Only v2 was exercised in this stage's basic fixture. No missing layer is replaced by an empty list.

Inherited Micro archives validate their complete embedded record inventory, archive digest, owner schemas and record/receipt/head/work relationships using pinned production pure validators. The full selected body is rendered from the actual archive record and receipt, not the head's search projection. Superseded stored Micro members have explicit exclusions; missing dependencies are failures. Source-only dependencies remain proof metadata and never become model text.

Stored branch guard and conditional unified-worldline cutoff decisions are recorded. Host worldline identity is derived from the stored manifest's character/chat/scope strings and checked against its stored metadata. This proves consistency of stored fields, not that those fields identify the current native host.

### Deletion and currentness

Capture rejects an existing exact-key deletion fence or a relevant deleted-scope prefix. The server's non-KV deletion tables have no per-key retained source stamp. Currentness therefore uses the immutable owner-receipt suffix as a conservative barrier: any intervening LIBRA maintenance/fence operation revokes the graph, including an insert/delete sequence that returns the deletion tables to identical bytes. Unrelated completed KV/batch writes outside the recorded inventories may advance the control sequence without invalidating the graph. Unknown, malformed or over-budget receipt history cannot prove currentness.

Receipt suffix reads are bounded by 8,192 entries and 1 MiB aggregate metadata, with overflow refusal. They never read ordinary operation result bodies or source bodies. Exact currentness still uses a fresh W0/owner/W1 interval and the original handle lifetime/check limits. An immutable captured view is returned by reference on repeated reads; no later body reload or whole-corpus clone occurs. The exposed receipt includes membership, exclusions, dependency/lifecycle facts, bounded inventories and content descriptors. Its `complete` field applies only to this named backend unit/profile.

### Contracts still needed before any corpus can succeed

1. A genuine native boundary provider binding current character/chat/scope, original/completed-turn revisions, host lineage and the same request's native projection. A caller-provided object or saved receipt alone is insufficient.
2. A genuine owner route/mode-epoch provider and route-specific deletion identity, with issuer/request affinity and authoritative currentness. The observer's backend brand cannot manufacture this.
3. Request-local source-edit exclusions, active Micro runtime/restore state and exact typed canonical/legacy eligibility. Durable manifests are not a substitute for in-flight host state.
4. The real ranked MiB-v2 producer, immutable paging and selection receipts, plus qualification of the fixed typed codec and any unsupported historical profile. This prefix reader is not a ranked frontier, model-selection proof or transport implementation.

Ordinary server/all-writer/lifecycle integration and physical DATA/ABA/external-writer guarantees remain separate gaps. No schema/guard/writer binder was changed. The new maintenance barrier relies on the already-qualified coordinator and immutable retained receipts; it is not hostile-writer or physical ABA protection. Core3-v2, historical five-owner-v1 and separate WM ownership are preserved; r2 is unadopted. Basic in-process synthetic checks and syntax are the only verification for this stage. Full A01–A17, independent, second-process, fault, platform, extreme-budget and real-host qualification remain unrun.


## Modern typed canonical source closure · 2026-10-08

`libra-typed-codec.cjs` contains fixed value-only production v4/v5 entity/fact/dependency/State-binding validators, v5 same-batch and cross-batch thread validators, and the exact unified-to-v3 text renderer. They are pinned to `plugins/LIBRA.js` SHA256 `30db8554f5c529490d3d17047776d1de29bb19a21733257e75df9c81227baa37`. There is no runtime extraction, eval, plugin startup, model call, writer load or caller codec. The approved-input fingerprint matches the pure SourceReview SDK. The unused decorative quote/source hashes are omitted from evidence-membership helpers; the production NFKC/whitespace/substring and quote-length semantics are retained. This validates the production structural/evidence contract, not independent truth or natural-language entailment.

- Exact artifact/ref schema and digest agreement, record-admission digest, supported engine version and optional archive origin/evidence digests are checked. v4 keeps its old claim set; v5 preferences, boundaries and thread enums retain their distinct contracts. No provider repair/coercion or field dropping runs during reads.
- Approved source evidence requires its actual derived key, complete owner/scope/unit/range binding, five ordered U+A pairs, identity derived from scope/worldline/message IDs, source/pair digests, payload digest and known normalization version. Both the full artifact and approved source rows are retained in the immutable receipt with SHA256 descriptors; they never become extra model text.
- The entire stored canonical text must equal the production renderer. The existing SQL full-text byte admission and strict bounded double-encoded storage preflight run first. Artifact arrays/size limits and separate conservative normalization/renderer scratch reservation precede validation/rendering. An exact non-materializing JSON byte/node/depth preflight counts repeated references again before encoding the whole proof. The limits remain 1 MiB source, narrative and proof each, and 64 MiB managed credit. These are conservative implementation limits, not measured RSS qualification.
- Every recorded raw reference closes its immutable completed-turn receipt and exact receipt/capture variant. Packet SHA256, UTF-8 lengths/digests, segment enums/ordering, source revisions and role/message payload bindings are checked. A newer stored variant cannot replace the consumed variant. Records predating raw-reference recording retain an explicit `not-recorded-historical` fact; a present but incomplete raw list or missing referenced row is unavailable. No native/current-source check is manufactured.
- Historical basis descriptors are never execution capabilities. A present basis snapshot must match its versioned descriptor and digest; an absent snapshot is retained as durable absence because production explicitly collects it after State work. Its removal does not invalidate approved-input/render semantics or prove State readiness. Snapshot presence changes invalidate captured currentness.
- Typed archive transfers close both target and original approved evidence, preserve the source's raw provenance and validate the transfer binding. The complete stored canonical ordering supplies v5 accepted thread target origin, prior fact, participant, transition and lineage checks, including same-batch source order. Exact target references and lineage are retained in the receipt. Missing or unproven targets fail the whole unit.

All `captureCorpus` requests still fail. Native identity/completed/current original source, semantic mode/owner-route epoch, request-local source edits, live Micro/restore eligibility, ordinary server/all-writer/lifecycle integration and physical ABA remain unavailable. No profile or activation was opened; Full/Min/generated metadata remain stale. Only basic synthetic SQLite fixtures and changed-path syntax are checked in this stage, with full A01–A17, deep/independent/actual-host qualification deferred.
