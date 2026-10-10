# Core3 global storage mode and all-chat migration

Applies to LIBRA, HAYAKU and Flashback with Storage SDK 1.8.25. Each plugin has its own global choice. This does not change another plugin's mode. Preserved SDK consumers are unchanged.

## Discovery and confirmation

The server settings panel exposes one plugin-global mode. Apply first reads the whole host character/chat catalog, raw local/device routing registries, owned physical records, native owner manifests/ledgers/registries and, whenever remote history/source/target requires it, the ordinary owner namespace's paged server keys and values. UI list caps are not inventory limits. Valid detached scopes and legacy aliases remain included.

Discovery is read-only. Missing or denied host APIs, incomplete catalogs, unknown identities/key families, malformed manifests, missing dependencies, ambiguous remote-only source routes, changed snapshots and pagination/response limits block completion. No permission is automatically approved. Credentials, device identity, SDK journals and owner local-control configuration are not copied as conversation payloads.

Preview reports the target endpoint, scope count, legacy override count, directions and concrete blockers. A changed endpoint is admitted only after all source routes have been verified local. Server-backed scopes must first complete the global plugin-only migration at the old endpoint; the system does not silently rebind their DATA. A new endpoint is inspected with existing owner authority before its URL is persisted.

## Durable transition

An immutable, exactly read-back job records observed inventory fingerprints, original routes, source record digests/revisions, endpoint/DATA/reset pins and per-scope checkpoints. Payload bodies and full chat content are not added to the journal. Owner writers are drained and gated through final publication.

Each scope follows its actual source route. Existing forward conflict checks/copy/readback and reverse dependency restore/readback/rollback are reused. Copying does not delete sources. Physical chunk envelopes are retained for rollback; logical hydration is used only for semantic transfer and comparison. Shared dependencies are classified explicitly; matching already-restored records are not written again.

Verified scopes keep a pending explicit-compatible route until all discovered scopes and dependencies are rechecked. Only then does one routing-registry update set the plugin-global target and retire the legacy overrides. Required local/device readback, server publication/readback, settled diagnostics and the final durable journal must all succeed. This is resumable coordination across existing replicas, not a distributed atomic commit or cross-host writer lease.

## Interruption and recovery

- Before effects, cancellation retains the original routes.
- After effects begin, pause drains to a safe checkpoint and preserves sources, actual routes and the incomplete journal. It does not claim a full rollback.
- Restart loads the aggregate job before routed owner I/O, independent of the selected chat. Newly selected chats cannot silently write to local fallback during recovery.
- URL, DATA identity, reset epoch or durable journal tampering blocks resume.
- Source/catalog drift requires a fresh preview and explicit confirmation. A new immutable plan is created only for that confirmed inventory; the superseded journal remains locally preserved. It is never quietly rewritten.
- Completion makes existing verified scopes and new chats inherit this plugin's global mode. Plugin-only completion performs no background reconnect.

The current-scope Sync, Restore and verified local-delete maintenance APIs remain current-scope operations. They do not become implicit whole-plugin migrations.

## Verification boundary

Offline tests use synthetic stores, unmodified owner artifacts and existing server handlers in-process. No listener, model call, real user DATA or host permission grant is required. A synthetic/offline pass does not establish operation in a real Risu host. The previously referenced Risu 2026.6.215 API compatibility and real-model execution remain unverified.
