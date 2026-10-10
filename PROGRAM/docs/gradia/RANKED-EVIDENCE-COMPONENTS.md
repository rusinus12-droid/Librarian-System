# GRADIA ranked evidence component slice

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST. The mechanical slice is implemented; overall MiB-v2 authority and production integration remain PARTIAL. No real strong admission, native/backend/mode authority or end-to-end qualification is claimed.

## Owner profile

LIBRA's private `gradiaRankedOwnerProfile` now composes:

- `gradiaRankedMetadata`: an exact existing-cache-key, cache-only vector lookup and the explicit `gradia.ranked-metadata.v2` shortlist profile. Cold, expired, mismatched or in-flight cache state is unavailable; it never calls an embedder, joins pending work, refreshes the catalog, updates cache statistics or truncates the query. Query text is separately Unicode/UTF-8 bounded.
- The existing ordered forced/latent union plus remaining catalog rows, owner-key deduplication, preset cap, score/end-turn ordering and temporal-anchor insertion. Presets remain 40/80/160/320; a missing scored catalog does not become the ordinary fallback. Ordinary hydration, prompt packing and MMR count arguments are unchanged.
- Actual local dense/BM25 helpers and an extracted byte-identical forced/temporal/RRF/gate formula block shared with ordinary recall. Whole canonical memory text survives this scoring path. More hydrated rows may change corpus-relative scoring statistics.
- `LibraGradiaRankedProducer.source.js`: a private size-admitting-reader interface reserves application credit before body materialization, verifies the complete semantic profile/text/hash, charges hydrated narrative bytes even for ineligible candidates, and reports exact prefix coverage. The unread suffix records first key/count/ordered-key hash. One unfit body stops the prefix rather than being partially returned or skipped.

The producer accepts no more than the preset frontier plus two separately admitted associative additions. Extra additions require the private owner's explicit existing-opt-in capability. The current private wrapper only supplies the direct metadata frontier; qualified associative metadata expansion remains part of the missing owner adapter. Ordinary associative recall and its existing opt-in/max-two policy are unchanged. Corpus limits never expand underlying search.

These interfaces are internal composition seams, not public authority endpoints. The existing readonly-source admission, SDK and server denials remain unchanged. No caller flag, ordinary get/set result or diagnostic mode publication is promoted to source authority.

## Shared complete-item render and selection

`sdk/GradiaEvidenceRender.v2.source.js` provides contract `gradia.evidence-render.v2`:

- Full item text, stable field order, JSON/HTML-delimiter escaping and exact preallocation UTF-8/UTF-16 accounting; malformed surrogate input is unavailable.
- All-or-nothing named semantic groups. No raw substring truncation, excerpt, summary or new semantic subunit is produced.
- The existing MMR formula, owner-computed similarity matrix, near-duplicate penalty, forced exception and score floor. Input corpus and rankings stay immutable.

`sdk/gradia/GradiaEvidenceSelection.source.js` retains verified immutable source strings by reference, hashes complete bodies, and selects independently for each of up to eight stage/phase calls. Selection uses the existing local `GradiaEvidenceBudget` helper against the actual serialized final payload. Complete groups/items that do not fit are omitted with recorded reasons; an entirely omitted selection leaves the native payload unchanged. No model call or new recall is performed.

Selection proposals bind corpus/request/issuer/manifest, stage/phase, pinned renderer, MMR policy, complete item/source hashes, omissions, rendered hash and the exact payload-budget witness. The private owner binder independently rerenders from its retained items before issuing a mechanical receipt. Dispatch checks the locally issued immutable payload witness and fresh owner receipt; finalization rechecks every consumed stage receipt, including earlier selections reduced or omitted in a later stage. Closing while a bind is unfinished retains declared credit until settlement.

The existing meter remains the narrow dated GPT-4o-mini plain-text Chat Completions component. Its witness explicitly says `content-bound-plus-framing-estimate`. This work does not upgrade that estimate into qualified token accounting, add AIDE/native-schema support, choose another model or alter G2.

## Source pinning

`node tools/sync_gradia_ranked_evidence.cjs --write` embeds the canonical protocol/credit/frames/render and endpoint-specific component source into LIBRA and GRADIA. `node tools/sync_gradia_ranked_evidence.cjs --check` rejects any byte mismatch; each source has a SHA256 pin. Renderer bytes in both plugins are identical. Optional `--upstream-render PATH` checks an independently supplied GRADIA source copy without modifying it.

This ACTIVE checkout has no separately editable GRADIA/src upstream source. The external project's transfer/rebuild was not performed; reference/pristine trees were not edited. These component embeds are not Full/Min release generation.

## Basic evidence and remaining work

Focused offline checks exercise real LIBRA algorithms with a synthetic catalog spanning 2,000 turns: the warm balanced profile hydrates 80 complete records from its 80-record frontier, above the old 48/8-KiB limits. This is a fake size-admitting owner and synthetic cache fixture, not real native-host capture or production evidence delivery. Separate components cover Unicode accounting, MMR, 60 inspected/59 eligible rows with rejected-byte charging, a budget-stopped prefix, per-stage capacities, complete groups, owner rerendering, empty selection and pending-bind credit.

Two selected existing G2 nominal checks verify disconnected/default behavior and one unchanged SHADOW pipeline request using fake transport. No real model/provider/network/listener/DATA is used.

Still unavailable: qualified authoritative pre-body source/proof adapter, full physical nested-I/O/deadline/lifecycle integration, complete source/group closure, immutable paged owner capture transport/admission, native/mode/authenticated backend authority, and a ready v2 per-stage branch in the live GRADIA pipeline. Factories are embedded, but G2 is not routed into these components. The strong route remains closed. No deep/full/actual-host/multi-process/32-MiB/performance/heap or independent qualification campaign was run. Full/Min/generated release metadata remains stale.
