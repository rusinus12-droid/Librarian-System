# LIA local storage and legacy recovery

## Scope

LIA-owned live bindings, index/proof, vaults, blueprints, image catalogs/presets and image backup chunks now use the original RisuAI pluginStorage. Existing key names, stored values, and unknown fields are retained. Provider secret storage remains on its existing device/pluginStorage paths. Native Persona DB, chats and original image assets remain host-owned.

The opt-in shared SDK policy is `storagePolicy: 'local_only'`. LIBRA, HAYAKU and Flashback defaults are unchanged. LIA still participates in RE:TRACE next-session handoff as a local-only owner. Shared per-owner handoff helpers permit other owners to use server storage independently.

LIA no longer exposes ordinary server/mirror-mode selection, synchronization, automatic server migration, or server-scope deletion through its panel or IPC. Old routing registry and synchronization-job bytes are retained as historical recovery information, not replayed on startup. Existing server LIA records are retained. No live server migration was executed during this work.

## Explicit recovery

Open LIA's “저장·이전 자료 복구” panel:
1. “이전 서버 자료 검사” reads the existing server namespace using the existing storage SDK authentication. No new credential, server write, tombstone, or mode change is created.
2. It enumerates and rereads the complete supported server inventory, compares record observations and the manifest, stages all records in memory, and validates all indexed Live Persona dependencies and image manifests/chunks before offering publication.
3. The preview shows local conflicts, unsupported server records and retained server tombstones. Differing local values are not overwritten. Scoped index/proof additions preserve nonconflicting local entries and unknown metadata; existing sibling shards are included in the local validation witness.
4. A separate explicit import click publishes through the SDK owner-I/O drain/freeze and verified local write path. All original local values are rechecked before publication. Failure attempts conditional rollback; an unconfirmed result is visibly marked for manual review. No whole-host DB or original host-asset recovery is claimed.

Server tombstones are never applied as local deletions. Unsupported/future schemas, conflicting values, malformed dependencies, incomplete manifests, missing image chunks, changed server observations, and missing safe publication support fail closed or remain explicitly reported. Unindexed but structurally identifiable shards are counted separately, preserved locally, and never assigned to the current chat automatically. Unknown server keys remain on the server; they are not silently deleted or imported as active settings. If the existing server authentication or reset/data-instance review is unavailable, the panel reports the blocker; resolve it through the existing server manager rather than creating a new persistent credential.

This is an explicit in-memory, bounded migration path. It is not a resumable cross-device migration subsystem or an atomic multi-key host-storage transaction. Quota failures or external writes that bypass the plugin's owner gate can require manual review; the original server copy is retained. Do not remove old server data until the user has independently accepted the recovered local result.

## Binding, image, and UI read reduction

No long-lived chat cache was added. Ordinary local data routes no longer resolve a full host context for each key. Image persona selection uses one response-local personas/chat snapshot and avoids reading the full character merely to select a persona. The actual asset registration path retains its recovery checks, deduplicates the same asset within one response, and only deep-clones the character when a registration change is needed. Response/session guards reject superseded image work.

A UI refresh obtains one context, reuses it for binding inspection and module choices, and rejects changed selections and older asynchronous views. One render-local manual analysis plan replaces repeated completed-pair hashing across the page, Pocket Home and action-button setup. Mutation conflict detection, host Persona readback, and explicit manual analysis source guards remain unchanged.

Measured small fake-host fixture counts (not real host latency):
- Enabled attachment + nonempty catalog, no applicable image publication: 12 → 4 host reads
- Warm attachment-off or empty catalog response: 0 → 0
- Managed-binding getContext: 46 → 7, including final selection guards
- Module picker in that refresh: 5 → 0 extra host reads

Actual image publication/recovery still requires its own guarded host/image reads; these counts are not a universal full-response total. Browser/host transport latency and long-running stability/performance were not tested.

## Verification and ownership

Shared Storage SDK and mixed-mode helper are owned and integrated by the RETRACE/common-storage work. LIA owns only the LIA plugin and its tests/docs. All executable checks use the exact pinned Task5B no-network and source-audit preloads, fake-host or in-process data, without HTTP, loopback listeners, models, installations, real user data, or live import. Basic feature checks are recorded in the accompanying evidence, with broader stability/performance intentionally deferred.
