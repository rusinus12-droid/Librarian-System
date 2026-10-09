# LIBRA request-local readonly source context

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST. This is an owner-issued request snapshot and source-capture admission boundary. It is not a completed Task8/9 native authority, a strong source closure, or a GRADIA MiB-v2 corpus producer. Strong admission remains unsupported.

## Actual connection

`LibraMemoryCore` constructs one private issuer with its actual host API, existing source normalizer, Host Lineage marker parser, private manifest publication counter and actual LIBRA storage bridge. Public callers can supply only request ID and duration. They cannot supply a character, source pairs, scope, mode, proof, epoch, verifier or backend observer. Each handle is an opaque object in that issuer's WeakMap; serialization, cloning, another instance, or another request ID cannot reproduce its brand.

The storage bridge likewise issues and validates its own opaque route handle. It reads the existing LIBRA scope mapping and selected scope/global routing rows directly from the actual local plugin/device stores. It does not call mode import/default initialization, scope creation, ordinary routed `get`, bootstrap, synchronization, repair or a writer. Missing mapping, malformed/unknown mode, ambiguous equal-version physical copies, transition, removal or unresolved reset is unavailable. `server_only` can be observed locally without contacting a server; that observation does not establish server authority.

The recorded route epoch is explicitly `sdk-instance-configuration-generation`, from the existing private `wholeDataInventoryEpoch`. A real SDK configuration admission changes that generation even if values return to their previous state. It is not the durable all-writer semantic mode epoch. `semanticModeEpoch` is always null and `authorityQualified` is false. A caller/stored `modeEpoch` field cannot change this. The route summary additionally carries the independently validated `modePublication` diagnostic from existing owner registry bytes. It binds observed persisted publication changes across SDK instances without granting atomic owner authority. Absent legacy records remain absent; pending, malformed, conflicting and mismatching records refuse capture. See [the common persisted-publication contract](STORAGE-MODE-PUBLICATION.md).

## Interfaces

All methods are available on the existing LIBRA owner API. This is an in-process boundary, not an authenticated GRADIA IPC/HTTP protocol.

- `captureReadonlySourceContext({requestId, durationMs})` returns `{handle, summary}`. The request ID is 1–240 ASCII letters, numbers or `._:-`; duration is an integer 1–120000 ms.
- `readCapturedReadonlySource({handle, requestId})` returns the same immutable `{summary, pairs, lineage}` view. No host or stored body reread occurs. The pair source is the full captured final normalized source for this bounded snapshot, not canonical memory or a backend receipt.
- `assertReadonlySourceContextCurrent({handle, requestId})` performs one explicit host read and reobserves the relevant route. Success is `request-local-current`, with `originalTextCompared:false`, `semanticModeEpoch:null`, and `actualHostQualified:false`.
- `admitReadonlySourceCapture({handle, requestId})` first performs that explicit check, then returns `unsupported / SOURCE_PROOF_UNAVAILABLE`. Reasons are `host_mutation_authority_unavailable`, `semantic_mode_epoch_unavailable`, and `authenticated_backend_binding_unavailable`. It does not load or relabel the backend observer and never calls a corpus producer.
- `releaseReadonlySourceContext({handle, requestId})` releases issued ownership. `cancelReadonlySourceContext({requestId})` also cancels an in-flight capture. Unload disposes every request.

SDK methods are `observeReadonlyRoute`, `assertReadonlyRouteCurrent`, and `releaseReadonlyRouteObservation`. They accept only the issuer's own route handle for currentness/release. Caller-provided JSON hashes or truth flags are not authority.

## Source and native identity policy

Capture calls the real selected-character host API once. Only actual `character.chaId`, selected `chat.id`, and unique native `message.chatId` values are accepted. No titles, indices, UUID fabrication, current-context cache, or fallback IDs become proof. Selection requires the actual `chatPage`; unsupported native shapes remain unavailable.

Completed pairs follow the existing consecutive-user/assistant accumulation and source-normalization rules. The new path does not use or populate the long-lived pair-revision cache. It retains the completed normalized source and bounded identity descriptors, not a full character/chat snapshot. A new explicit capture reads the then-final source. It does not automatically reanalyze or publish anything.

Currentness compares native message IDs/order/roles/flags, selected character/chat, greeting selection and native branch parent/fork structure. Native identity replacement, deletion, scope change or relevant publication change revokes the handle. It does not read, normalize, hash or compare ordinary source text. Ordinary edits and inserted illustration tags do not revoke the captured source. The private manifest publication generation is separate from native identity and original source text; durable worldline/deletion dependencies remain the backend observer's responsibility and are not inferred here.

Native branch markers are structural identity carriers, so the existing marker parser reads disabled comment markers. Parent/fork ID position and native prefix identity must match; parent/child narrative text is never compared in this path. The returned lineage is deliberately `identity-observed`, with `sourcePrefixVerified:false` and `inheritanceEligible:false`. This cannot grant the existing native-copy inheritance authority.

## Bounded ownership and qualification limits

- At most four issued or physically pending requests. Cancellation, expiry and unload keep an unfinished physical operation's slot until its promise actually settles; late results are discarded and late route handles retired.
- Duration is a validity deadline checked at each boundary; a host/storage promise may remain physically pending beyond it. This foundation does not yet provide the MiB-v2 five-second callback-return guarantee.
- No timers, continuous polling, automatic original-text tracking, or background reanalysis. Explicit checks are limited to 64 per issued context; concurrent checks on one context reject.
- At most 4096 host chat IDs, 64 lineage nodes and 16384 native rows across the selected identity path. Identity metadata has a conservative 1 MiB UTF-16 reservation bound, counting JSON escaping on bounded individual descriptors before serializing the complete identity. Source input/projection is capped at 2 Mi UTF-16 code units, and malformed Unicode is unsupported. Stored JSON observations reject strings above 1 Mi code units before parsing.
- These bounds are a provisional local snapshot profile. They do not replace the MiB-v2 configurable content/proof/wire limits, authoritative pre-read size admission or endpoint credit ledger. The host API itself still returns a whole host object, and pluginStorage does not offer authoritative pre-read sizes. No heap/RSS or host-snapshot allocation guarantee is claimed.
- The explicit host sample and asynchronous route read are not an atomic host/backend interval. The current host exposes no qualified mutation generation to this path. External native/route ABA and all-writer closure remain unproven; ordinary text edits are intentionally outside this snapshot's invalidation contract.

Remaining gates: certified host native identity/mutation provenance; durable semantic mode/owner-route epoch and all-writer coverage; authenticated binding to the genuine backend observation/closure handle; physical DATA/reset/ABA/external-writer qualification and full runtime/lifecycle admission; live Micro eligibility; warm ranked frontier; immutable MiB-v2 corpus/transport, owner selection receipts and qualified model dispatch. Backend typed closure, original recall and all activation flags are unchanged.

## Basic verification and source assembly

`node --test --test-concurrency=1 tests/libra_read_context_basic.test.cjs` runs the bounded fake-host checks only. It does not use actual host data, models, credentials, a listener or network. The checkpoint records RED/GREEN logs and exact command hashes. No deep/full regression, independent review, live-host/platform/performance qualification or production activation is implied.

`node tools/sync_embedded_sdk.cjs --plugin LIBRA.js` updates the existing LIBRA-only storage embed. `node tools/sync_libra_read_context.cjs` updates this owner context embed, and its `--check` mode verifies exact byte identity. Existing `check_sdk_sync.cjs` checks the storage/lineage/source-policy embeds. The fixed seventeen typed backend codec segments remain byte-identical. Generated Full/Min and release metadata remain stale.
