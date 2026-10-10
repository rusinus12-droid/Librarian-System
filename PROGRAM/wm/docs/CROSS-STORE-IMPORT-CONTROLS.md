# WM fresh-target import, recovery and restart-selection controls

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST. This extends CROSS-STORE-IMPORT-CONTRACT.md with explicit manager/UI controls and recovery-only server identity selection. It does not implement native host mapping, owner admission, active-writer cutover or production qualification.

## Existing authority and transport

The existing authenticated RETRACE manager-control route accepts one new `wm-import` action. Its commands are prepare, inspect, apply, recover and adopt. The shared SDK allowlist includes that action; core3 owner roles, LIA local_only, RETRACE manager_only and GRADIA read-only/nonparticipant remain unchanged. A WM namespace principal still cannot enter manager routes. No new token, credential, grant or permission endpoint is created.

The controller is enabled only by the existing trusted constructor option `wmBackupRestoreEnabled === true`. The default remains closed. Request JSON cannot supply the qualification, a source filesystem path, a destination path, target authority, or an activation flag. Server-side backup listing resolves the chosen WM component. Server-side configuration binds a never-created destination under `DATA/migrations/wm-imports/<operationId>/wm.sqlite`.

Prepare verifies the source and durably reserves the original importer plan. Apply uses that same operation/plan/fingerprint and exact IMPORT confirmation. Inspect and the existing status response rediscover durable operations after lost responses or UI restarts. The UI never interprets a timeout as permission to create a replacement plan; a pending prepare reuses its ID, and rediscovered same-backup work is selected instead of silently duplicated.

## Explicit backup-panel workflow

The existing server backup page now exposes:

1. Select an existing WM component backup, or use the existing snapshot ZIP upload/inspection flow to register one.
2. Prepare the separate fresh-target import; display source backup/store, target physical path and full identity, incarnation and operation/plan IDs.
3. Confirm IMPORT to create the independent verified target. The original component, source and existing physical store are preserved.
4. Inspect the same durable operation, or explicitly confirm RECOVER with its observation fingerprint if interrupted.
5. Confirm ADOPT only when the controller reports eligible recovery-only selection. Cancel performs no apply/adopt request.

The panel shows the actual durable phase, selected/restart-required state, recovery-required fencing and preserved interrupted evidence. It does not label an imported or selected store active. Repeated clicks are guarded while reading context or awaiting confirmation. Server/context drift invalidates the UI action before request submission. This is fake-GUI/source evidence, not a visual or real-host qualification.

## Recovery and lock evidence

An apply lock now records its exact plan/operation/fingerprint and Linux process identity: host digest, boot, PID namespace, UID, PID and process start marker. Elapsed time is never evidence of abandonment.

RECOVER requires the exact plan/operation/fingerprint, `RECOVER <planId>` confirmation and the current observation fingerprint. A separate exclusive recovery lock prevents cooperative apply from starting during reconciliation.

- A live owner, legacy/empty lock, foreign host/boot/PID namespace/UID, unreadable owner or unsupported process environment remains blocked. Nothing is blindly removed.
- Only an absent/reused PID proved within the same identified Linux process environment permits preserving the old apply-lock directory at a unique no-overwrite evidence path. It is renamed, never deleted. The exact lock created by the current call is consumed only when its owner record still matches.
- A complete independent source-stage can finish rebase. A complete rebased stage can resume after full readback. A matching published target can reconcile the same receipt.
- Partial/unknown stages and their sidecars stay untouched at the old path. Explicit recovery records them and selects a never-created retry stage using the same plan/operation/target identity/incarnation. A source-linked or other multiply linked stage is never rebased or accepted as an independent unpublished copy.
- Existing/mismatching physical targets are not overwritten. Publishing with neither a target nor a verified stage remains uncertain.
- An interrupted recovery lock itself remains fail-closed for offline review. This version does not recursively steal recovery locks, recover across host reboots, or infer ownership for legacy empty locks.

This is basic synthetic lock/phase reconciliation, not actual process-kill, power-loss, concurrency, container/OS or Windows durability qualification. Hard-link and directory fsync support are still required. Large metadata and operation-list memory bounds are not claimed.

## Recovery-only identity selection

ADOPT is a separate explicit confirmation. It requires the existing trusted restore qualification, a committed import, fresh complete target readback and no currently active WM authority. An unavailable or unexplained current store blocks selection; an initialized current WM store must already be fenced or recovery_required through its existing authority mechanism. The controller does not fence an active source for the user or manufacture owner admission.

A one-time, no-clobber selection record binds the DATA instance, exact import plan and receipt, physical path, identity and recovery_required state. Different selections cannot replace it. A matching saved selection is idempotent. The prepared selection file is retained as evidence. Existing source/default stores are never moved, overwritten or deleted.

The running old service is suspended; open and status paths also detect a published selection marker and fail closed even when the publication acknowledgement/fsync was lost. The user must restart the existing server themselves. No listener is launched by these controls.

On restart, the same trusted qualification must still be present. The selection and original import record must agree. Normal read-only schema/identity preflight plus exact route/epoch, restore-admission, incarnation and inert rebase-evidence binding run before opening the selected path. Target-owned pin/snapshot records accumulated after normal use are allowed by the normal runtime path; the unused-backup verifier is not relaxed. The initial import/adoption closure proof is historical, not a claim that every later byte is immutable or that the store is currently active.

The target stays recovery_required. Existing store historicalExecution guards reject initialization, writes, fencing and activation that would reuse restored authority. No recovery-activation or real native-owner path is added. Pending selection is reported as unsupported WM coverage by a newly created backup, not as WM absent; after restart a backup captures the selected recovery target normally.

The old canonical-path same-store/mixed restore is explicitly unavailable once an import selection exists, including offline planning/admission. It cannot silently restore the old default file while the configured server uses another file. Replacing an already-selected target, resetting the selection, online active-authority cutover, and old same-store restore of selected imports remain separate implementation work.

## Evidence and exit gate

Checkpoint: WM-import-controls-20261008T1906Z. Report: RUN/reports/task-WM-import-controls-report.md.

Only basic in-process SQLite and extracted fake-GUI flows, existing fake-GUI scripts, syntax, SDK consistency and unchanged 759-input WM source assembly were run. Real credentials, live DATA, models, network, listeners, deployment and a full project backup were not used. Full/Min/plugin metadata remain stale. Native owner mapping, all-writer production qualification, actual activation, deep regressions, platform/crash matrices and release qualification remain open.
