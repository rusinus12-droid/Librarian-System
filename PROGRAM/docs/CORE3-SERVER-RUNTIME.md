# Qualified core3 no-listen server candidate

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST, 2026-10-08. This closes the bounded normal-constructor/repository/request-handler integration gap. It does not close all server lifecycle writers, Task6 host ownership, Task7/9 native/mode routing, full Task8 source eligibility, or production activation.

## 2026-10-09 scope update

The independent backend now supports versioned server semantic route receipts and authenticated backend observation handles through the existing no-listen request handler. See [the precise contract and limits](CORE3-SEMANTIC-ROUTES.md). Historical restrictions below still apply except for that explicitly described route/observation subset. These server settings do not certify native routing or native writer exclusion. RisuAI CORE changes are prohibited; dependent native/strong full-corpus features are explicitly unsupported, rather than promised host-modification work.

## Admission and usage boundary

An internal caller may select `createMemorySuiteServer({dataDir, authorityProfile: CORE3_AUTHORITY_PROFILE, autoBackup:false, computeEnabled:false})`. There is no CLI flag, automatic migration, activation toggle or HTTP enrollment endpoint. Selection alone is insufficient:

1. Open the actual existing control store and its private brand; require the exact stored core3-v2 marker/control/profile and physical DATA/control/owner file bindings.
2. Require the retained, structurally verified v2 initial qualification receipt and a ready witness. Missing receipt, preparing/pending state, wrong profile, missing owner or corrupt evidence refuse. Caller-supplied qualified/ready/host booleans have no authority.
3. Bind all three real schema-3 owner stores and preflight every owner. Under the real exclusive control gate, require REPLAY, acquire all three live `BEGIN IMMEDIATE` owner locks, and revalidate the exact original receipt. FIRST is refused. Startup never calls the initializer, installs guards, invokes the qualifier, creates a new qualification receipt, or alters the old receipt.
4. Retained reset bytes must agree with the original qualification; pending restore/reset or changed evidence refuses. Each repository write checks current physical/profile/receipt/reset/restore evidence before intent publication and again inside the actual owner transaction. A request whose body arrives later cannot reuse an earlier admission.
5. LIA and RETRACE are outside the selected profile. Existing stores open read-only after orphan-authority admission; missing stores use an in-memory schema. Retired maintenance reopening is disabled for this runtime. WM is a separate owner and is not instantiated or enrolled here.

All permitted writes still use the genuine coordinator and existing compact receipts, source lifecycle and durable result retention. Qualified owner handles stay private; the exposed database for an active owner is a distinct SQLite read-only connection. No ordinary result is promoted to native route/host/recall authority.

The returned `authorityRuntime` describes `isolated-core3-server-candidate.v1`, not a deployable host. Both `app.listen()` and `app.server.listen()` reject with `AUTHORITY_HOST_PROFILE_UNQUALIFIED`. The real request handler can be driven by an owned in-process fixture without listening. This is a functioning integration candidate, not transport qualification.

## Writer and lifecycle coverage

| Writer or entrypoint | Selected core3 behavior |
| --- | --- |
| KV set/remove; ordinary operations receipt | Existing coordinator `kv` intent, same owner transaction and durable readback; exact replay returns retained result |
| Public conditional set/remove/check batch | Existing coordinator `batch` intent; authenticated handler validates exact preconditions and namespace access |
| Internal conditional purge/remove/rewrite | Existing coordinator `batch` or `maintenance` intent; relevant LIBRA lifecycle changes retained |
| Internal owned-scope tombstone/key/scope seal | `maintenance` intent over the actual KV and deletion-fence tables; a low-level primitive only, not a verified backup or complete manager delete workflow |
| Ordinary receipt cleanup | Explicit `maintainReceipts()` and existing threshold cleanup use their own coordinator `maintenance` intent; authority evidence remains retained |
| Flashback writer acquire/renew/release | Existing coordinator `fence` intent; protected data write verifies that fence inside its owner transaction |
| Preconnected or returned raw SQL writes | No permit; existing authority triggers refuse ordinary raw DML, and the returned active-owner handle is read-only for DDL as well |
| Legacy schema creation, metadata stamping, migration/recovery | Skipped for selected core3; genuine preexisting guards/schema required |
| Token/signing-key persistence, portable settings loading | No persistent credential or settings write; in-memory token only if none is supplied; compute must be disabled |
| Diagnostic journal | Existing bounded/redacted ring, memory-only; no log directory, flush or rotation writes |
| Namespace reset/epoch advancement | Closed; read-only epochs come from the actual control witness |
| Backup/create/scrub/export/import, online restore, WAL checkpoint, VACUUM/export | Closed; direct APIs and request routes refuse before filesystem publication or recovery |
| Scope catalog/index/pin and manager/owner delete workflows | Closed; no catalog, backup, job journal or deletion-plan mutation |
| Manager control startup/recovery and portable-transfer startup cleanup | Not constructed; no automatic journal rewrite or expired-transfer deletion |
| Physical repair and native-archive repair workflows | Closed, even where a lower-level repository mutation could be coordinated; the workflow's native/backup/route proof is not established |
| WM/import selection/compute workers | Not constructed or enabled in the selected runtime; normal legacy service remains separate and unchanged |
| GRADIA logical read-session / corpus / route-native proof | Closed for this composition; backend observer/source-proof APIs and their strong-proof denial remain unchanged |
| Shutdown | Close only, no auto-backup; no-listen close conclusively releases runtime/control/owner handles |

The runtime has a fixed positive route allowlist. Unknown methods/routes fail before reading a body. Allowed normal paths are health/bootstrap, KV get/keys/get-many/set/remove/batch, core3 operation lookup, integrity/admin integrity, Flashback writer commands and authenticated shutdown. Existing capability authentication, namespace authorization and request limits still apply. WM and strong GRADIA bootstrap requests refuse. Bootstrap omits backup, restore, scope deletion, handoff, storage-mode and strong-reader capabilities; `storageModeContract` is null and core3 schema version is reported as 3. Retired namespaces remain inventory, not writable owners.

## What remains unavailable

- Actual-host/second-process external-writer exclusion, physical replacement/ABA, crash/platform/filesystem qualification, full reset/restore/cutover/maintenance closure.
- Native current character/chat/source revision, request-local edits, original-source comparison, semantic owner route/mode epoch and live Micro/restore/current-State eligibility. Request headers, supplied scope/mode, SQL facts and caller booleans cannot certify these.
- Full corpus capture, ranked producer, sealed MiB-v2 paging/selection and Task9 transport/native admission. Existing strong corpus requests remain `SOURCE_PROOF_UNAVAILABLE`.
- Persistent production runtime settings or a qualified listener/provider. `actualHostQualified`, `allWriterOwnership`, `serverActivation` and `handoffActivation` remain false; qualified production profiles remain empty.

The historical control gate maps some domain messages containing “blocked” to AUTHORITY_BUSY; this stage preserves that historical behavior. Such a denied write remains aborted, never a success, and selected-runtime authority errors carry HTTP 503. It is not evidence of actual lock contention or a retry-success promise.

## Bounded verification

`tests/authority_core3_runtime.test.cjs` uses actual temporary core3 SQLite preparation and qualification, real coordinator receipts, and the normal request callback without a network listener. It checks admission and simultaneous locks, per-owner authenticated write/batch/fence/replay, internal maintenance/purge/seals/cleanup, read-only SQL exposure, existing and absent retired inventory, lifecycle/unknown-route denial before body reads, no ancillary startup files, delayed-body currentness, restart/close, invalid stored evidence, reduced bootstrap and unchanged default legacy behavior.

Final evidence is in RUN/checkpoints/LIB-core3-runtime-20261008T2145Z and RUN/reports/task-LIB-core3-runtime-report.md. The bounded check set is 14 new runtime checks, 10 unchanged profile checks, one unchanged historical five-owner nominal check and three changed/new CJS syntax checks. No full/deep regression, independent review, actual host/data, second-process, listener, network, provider/model, Git/push/deploy, Library or Full/Min build was run. Generated artifacts remain stale. Old v1/source-proof files, historical Task8A matrices, cancelled work-log pair, unadopted r2 and WM sources remain preserved.
