# Bounded read-only server snapshot integration

This integration adds the reviewed owner-only `/v1/flashback/scope-health` endpoint and `inspectFlashbackServerHealthSnapshot({scopeId})` SDK adapter to the current physical-repair + client-probe/UI baseline. It does not add server support to Flashback's existing maintenance UI. That UI remains unsupported for server full-health assessment and physical server repair.

The endpoint inventories bounded selected current-scope plugin/local records using existing repository read transactions. DATA identity, reset epoch, owner authorization, actual byte digests and inventory fingerprint are checked. Limits are 1,000 rows per space, 2 MiB per stored value and 8 MiB total. Unknown, absent, corrupt, oversized or truncated scope evidence is incomplete. Linked archives are excluded and make the source snapshot incomplete. Every response keeps `healthVerified:false`; complete storage capture is not a product-health claim or repair authority.

The SDK uses only an already certified server-only connection and capability. It does not bootstrap, refresh credentials, retry authentication, reconcile settings, migrate, or fall back to local storage. Routing, URL, DATA/reset and connection witnesses are checked before and after reads. `assertCurrent` uses its captured fingerprint, not a caller-editable response fingerprint. Host multi-store observations are not distributed-atomic.

Only the standard SDK changes; LIBRA's specialized SDK remains byte-identical. Existing client-probe status-publication and mounted-UI guards remain present. Outside each embedded Storage SDK region, all five plugin source byte streams remain exactly unchanged, including physical-repair logic and shared Health SDK.

Verification uses synthetic offline stores/transport and production-generated value formats. It does not establish live Risu, actual provider/server acceptance, WM semantic validity, archive decompression/integrity, or a full-project regression pass. The production-format COW check uses the fixture's actual owner ingest path; an earlier separate synthetic host-output event timed out and is not counted as passing.

The combined integration is an unadopted candidate. Prior independent review of the isolated server unit does not approve this combined tree. Exact source/artifact manifests, root diff and execution evidence are retained beside the candidate for separate review.
