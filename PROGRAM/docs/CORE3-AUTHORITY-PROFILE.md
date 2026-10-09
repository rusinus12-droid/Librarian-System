# Explicit core3 offline authority foundation

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST, 2026-10-08. This supplies genuine offline preparation and initial owner qualification for the current LIB core3 storage owners. It does not activate a live server or qualify a real host. The later bounded normal-constructor integration is described in [CORE3-SERVER-RUNTIME.md](CORE3-SERVER-RUNTIME.md).

## Version and ownership boundary

- Historical v1 remains exactly five owners in its original order: libra, hayaku, flashback, lia, retrace. `OWNERS`, `CONTRACT` and `SCHEMA_VERSION` retain that meaning for old codecs and callers. Its activation marker, schema-1 control database, witness, initial qualification receipt and qualification ID are not relabeled or rewritten.
- New preparation explicitly selects `memory-suite.authority-profile.core3.v2` (`CORE3_AUTHORITY_PROFILE`). Its ordered owners are libra, hayaku, flashback. Missing LIA/RETRACE files are not missing authority owners. WM is a separate storage owner with its own authority and is not enrolled here.
- The new marker is `memory-suite.server-authority-activation.v2`, the control witness is `memory-suite.server-authority.v2`, and the initial receipt is `memory-suite.initial-owner-qualification.v2`. Each carries the exact authorityProfile. The SQLite control schema and user_version are 2, including a fixed checked authority_profile column. Initial receipt scope is `isolated-core3-owner-backend.v2`; its qualification ID is also profile-bound.
- Marker version selects the decoder, never owner count or whichever files happen to exist. A v1 marker still requires all five original bindings. A mismatched explicit profile, wrong marker/receipt version, unsupported profile, or wrong control schema is refused. No in-place v1-to-v2 conversion is implemented.
- Owner schema remains 3 and compact owner write receipts remain v2. Their existing generation, physical binding, owner file binding and fence fields are retained. Source lifecycle coverage is still only `libra.plugin-kv.v1`; HAYAKU/Flashback do not gain a source-closure claim.

## Explicit preparation and qualification API

This is a trusted internal offline path, not a new HTTP endpoint, launcher flag or UI switch.

1. `initializeAuthorityStore` accepts the explicit authorityProfile alongside the existing dataDir, activationId, physicalBinding and ownerBindings. Every selected owner must already have its expected physical file and legacy schema. The initializer does not create owner files. The core3 bindings must contain exactly the three selected owners. It creates only the control store and activation marker after preflight.
2. `bindOwnerStore` verifies the genuine physical owner against that marker. The caller owns unopened/unbound handles until successful binding, after which the owner store controls their lifecycle. A namespace outside the selected profile is rejected.
3. `createInitialOwnerQualifier` also requires the explicit core3 authorityProfile. Omitting it preserves the historical legacy profile, so it cannot silently qualify a core3 store. It requires the genuine control store and a resolver returning the three genuine owner stores.
4. Qualification preflights every selected owner before installing any guards. It installs the existing schema-3 guards, acquires a real `BEGIN IMMEDIATE` owner lock for each selected owner under the control gate, and requires the exact ordered set of live opaque locks before publishing one durable initial receipt. Partial, duplicate, ended or forged locks cannot substitute for the three owners.
5. A repeat qualification reads the retained receipt and checks current owners under locks without reinstalling their baseline. Historical committed outcome remains distinct from current readiness or ordinary pending work. Existing reset/restore exclusion and physical identity checks remain active.

The control store rejects out-of-profile operation namespaces. The coordinator rejects them before invoking the owner resolver. The internal server repository authority branch checks membership before opening SQLite, preventing an attempted retired/WM enrollment from creating a missing file. Existing normal legacy LIA/RETRACE inventory remains read-only or in-memory when absent; this change does not revive retired writers or require retired physical stores for core3 qualification.

## Implemented stage exit and remaining implementation

The stage exit is an explicit core3 offline prepare → bind → genuinely qualify → reopen/replay path, with real per-owner fences and mutation receipts. Structural profile support is not a qualified production host profile.

Default `createMemorySuiteServer` still rejects prepared/qualified authority through its legacy admission. An explicit core3 profile now selects a bounded no-listen constructor that consumes the retained initial receipt and replays genuine simultaneous owner locks before connecting repositories and the ordinary authenticated primitive routes. Startup does not call the initializer or qualifier. All remaining lifecycle/maintenance workflows and live transport stay closed; this is partial implementation, not full server/all-writer qualification. See [the runtime admission and writer matrix](CORE3-SERVER-RUNTIME.md).

Task6 physical DATA replacement/ABA, restore and external-writer closure; Task7 native/routing authority; Task8/8A bounded observation, source/eligibility closure and assert-current; subsequent transport/producer integration all remain open. Historical Task8A source/acceptance matrices remain unchanged and planned NOT RUN. The separate blocked LIB r2 candidate/review is not retried or adopted here.

ActualHostQualified, allWriterOwnership, serverActivation and handoffActivation remain false. Qualified production profiles remain empty. WM sources, settings, C2 handoff, generated Full/Min/metadata and retired-manager roles are not upgraded by this foundation.

## Bounded verification

The new `tests/authority_core3_profile.test.cjs` uses a separate three-store fixture. Its basic checks cover explicit versions, genuine qualification and replay, actual simultaneous SQLite owner locks, rejected invalid lock sets, per-owner mutations/receipts, missing-owner refusal, historical/pending distinction, retired ephemeral inventory, pre-open admission and closed normal startup. A compatibility case uses the unchanged historical fixture to verify v1 marker and initial receipt bytes across reopening and rejected conversion. The existing five-owner nominal test is run unchanged.

These are in-process temporary SQLite checks plus changed-file syntax, with an audited offline guard. They are not deep regression, second-process ownership closure, actual DATA enrollment, crash/platform/filesystem/performance qualification, or independent release acceptance. No real listener, model, credentials, network, Git push/deploy or Library action is involved.

Evidence: RUN/checkpoints/LIB-core3-authority-20261008T1945Z and RUN/reports/task-LIB-core3-authority-report.md.
