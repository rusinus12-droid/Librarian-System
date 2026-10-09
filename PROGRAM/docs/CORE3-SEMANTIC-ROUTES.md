# Core3 server semantic routes and backend observations

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST, 2026-10-09. This is the independent, no-listen backend composition. RisuAI CORE modifications are prohibited by the user's 02:13 UTC decision. Native all-writer exclusion, native semantic-mode/source authority and strong full-corpus admission remain explicitly unsupported. They are not promised future host modifications.

## Supported boundary

Only an already qualified `memory-suite.authority-profile.core3.v2` DATA instance can use this contract. Initial qualification remains a retained historical receipt; startup does not rerun FIRST or install guards. Legacy five-owner v1 history, retired LIA/RETRACE and independent WM ownership remain unchanged. Both listener entrypoints remain disabled.

A route is a server-owned semantic setting, not evidence of the effective native storage location, completed migration, native identity, host CAS or an external-writer fence. Ordinary KV writes remain ordinary owner writes. A server route receipt cannot upgrade them to a native cutover. Server-side capture requires a selected `server_only` setting, but remains backend-only.

`memory-suite.authority-route.v1` contains namespace, scopeId, scopeKey, mode, safe-integer modeEpoch, overrideKind, dependencyDigest and null transition. Modes are plugin_only/server_only; mirror is not a selectable mode. Explicit scope settings override the reserved global entry; inherited settings use the active global entry; removal records retain their history. The digest covers semantic settings, never URL, token or diagnostic publication revision.

A transition takes an exact previous route or null and an operation ID. The genuine coordinator acquires the exclusive SQLite control gate plus all three actual owner `BEGIN IMMEDIATE` locks, verifies their initial proofs, and atomically publishes the route plus `memory-suite.authority-route-receipt.v1`. Epochs increase, including ABA changes. Same-operation replay returns the original receipt; changed payload or stale previous-route CAS refuses. No previous receipt is deleted. A lost COMMIT ACK is checked using the original operation ID; absence is `uncertain`, not proof of non-application.

Replay reconstructs the retained route chain, validates its physical DATA/generation/initial receipt and owner proofs, and requires an exact match to current rows. Unknown or corrupt lifecycle records fail closed. The reader bounds route rows, receipt count, individual journal size and total retained journal bytes before materialization. Existing observation CPU/memory/event limits apply as additional admission limits; retained history is never pruned to make a read pass.

## Authenticated request path

The normal in-process request handler exposes POST routes under `/v1/authority/`:

- route/read, route/transition and route/status
- libra/observe (specified stored canonical facts)
- libra/observe-closure (complete supported stored-prefix source closure)
- libra/read, libra/current, libra/usage and libra/release

Every request is authenticated using the existing owner capability verifier and requires the exact DATA-instance header. Namespace comes from the authenticated principal. Admin flags, body principals, qualification booleans and copied proof objects do not grant access. Stored-source requests are LIBRA-owner only.

The runtime keeps private branded observer handles. Wire tokens are random, issuer/authentication-token/request/DATA/runtime-bound references, never caller-provided observation objects. SDK handles are also private and request-bound. Currentness compares relevant server route dependencies and source metadata under fresh readonly brackets; it permits unrelated writes and rejects route/source ABA. Capture/read are immutable backend facts. Native authority and recall eligibility remain unavailable/unqualified. This is not the GRADIA MiB-v2 frame protocol or a full-corpus proof.

## Actual SDK consumers

Both canonical SDKs use only their own authenticated, DATA-bound bootstrap result advertising core3 semantic-route support. Actual scoped/global setters and global removal publish through the real endpoint. A repeated unchanged setter can settle its existing pending operation. Server publication IDs are persisted without credentials before sending; response loss uses the same ID and durable status, including a retry after reconnect. An unresolved publication remains pending and does not receive a replacement ID.

The local mode write and server publication are separate stores, not a distributed transaction. Publication failure can occur after local setting readback: the setter reports the pending/indeterminate operation and preserves its journal. It does not claim an atomic native rollback or cutover. Local/default legacy servers never enter this path. Ordinary `inspectModePublication()` still returns semanticModeEpoch null and authorityQualified false. Changing a URL does not publish a semantic epoch and invalidates the current server connection proof.

`inspectServerModeAuthority`, `observeServerCanonicalFacts`, `observeServerSourceClosure`, `readServerObservation`, `assertServerObservationCurrent` and `releaseServerObservation` are backend-only SDK interfaces. Existing native request-local source capture and strong GRADIA admission stay unsupported. No new listener, live host, DATA enrollment, migration, persistent credential or deployment was performed.

## Verification scope

The focused real-SQLite/fake-host test drives the actual handler and all three core SDK owners, route retention/replay/reopen/CAS/locks, global dependencies and ABA, source mutation/currentness, canonical and stored closure reads, owner/request/DATA/handle rejection, and lost-ACK status recovery. Adjacent core3 runtime and ordinary publication basics and syntax/embedded-source checks are recorded in the task checkpoint. No full/deep regression or actual-host/platform/crash qualification is claimed.
