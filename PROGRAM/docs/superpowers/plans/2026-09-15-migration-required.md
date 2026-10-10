# Migration Required Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `migration_required` updater path that rebuilds `DATA.next` through the existing logical migration engine and atomically switches PROGRAM/DATA as one recoverable pair.

**Architecture:** The old PROGRAM exports stopped DATA into the existing logical migration ZIP format. The new PROGRAM imports that archive into a clean release DATA template, then offline-restores it into `DATA.next` while preserving destination-owned runtime identity. Only after candidate verification are PROGRAM and DATA renamed as a pair; a durable commit or rollback-restored decision is written before any writable server is exposed.

**Tech Stack:** CommonJS, Node.js >= 22.13, node:sqlite, existing Librarian logical migration/restore engine.

**Spec:** Approved chat design on 2026-09-15: Old PROGRAM logical export -> New PROGRAM DATA.next rebuild -> PROGRAM/DATA pair switch.

## Global Constraints

- Existing `program_only` behavior must remain unchanged.
- Existing DATA must not be mutated during logical export or DATA.next construction.
- Runtime token and compute signing identity remain destination-owned.
- `migrationAux` settings must be applied by offline restore with rollback coverage.
- PROGRAM and DATA must never be accepted as a mixed-version committed pair.
- No writable server may be exposed before durable commit/rollback-restored state.
- Official release policy remains `manual_required` until separate release approval.

---

### Task 1: Offline migration metadata transaction

**Files:**
- Modify: `PROGRAM/server/server.cjs`
- Test: `PROGRAM/tests/offline_migration_aux_restore_test.cjs`

**Interfaces:**
- Consumes: `backup.migrationAux`, `installMigrationMetadata`, `verifyAuxiliary`, `rollbackMigrationMetadata`.
- Produces: `restoreBackupOffline()` applies portable settings in the same rollback boundary as DB/catalog replacement.

- [ ] Write a failing test that imports a logical migration backup into a stopped DATA tree and verifies allowlisted settings are restored while host/port remain destination-owned.
- [ ] Run the test and verify failure because offline restore ignores migrationAux.
- [ ] Stage/apply migration metadata during offline restore, persist enough journal state for crash rollback, verify it before COMMITTED, and roll it back on failure/recovery.
- [ ] Re-run the focused restore tests.

### Task 2: DATA.next logical rebuild

**Files:**
- Create: `UPDATER/core/migration-required.cjs`
- Test: `PROGRAM/tests/remote_update_migration_data_next_test.cjs`

**Interfaces:**
- Consumes: `receipt.programNext`, `receipt.releaseDataTemplate`, old `portable_export_stopped.exportStopped`, new `logical_migration.importLogicalMigration`, new PROGRAM `restoreBackupOffline`.
- Produces: `buildMigratedDataNext({rootDir,receipt,...})` returning archive/import/identity verification metadata.

- [ ] Write a failing test that creates stopped old DATA with live/tombstone records, settings, runtime token and signing key, then requests migration DATA.next.
- [ ] Verify the test fails because the migration module does not exist.
- [ ] Copy clean release DATA to `.update/DATA.next`, preserve host/port and runtime identities, logical-export old DATA read-only, logical-import with the new PROGRAM, restore into DATA.next, and verify namespace counts/integrity/identity.
- [ ] Assert original DATA fingerprints are unchanged.

### Task 3: Pair switch, rollback, and recovery

**Files:**
- Modify: `UPDATER/core/migration-required.cjs`
- Modify: `UPDATER/updater.cjs`
- Test: `PROGRAM/tests/remote_update_migration_required_apply_test.cjs`
- Test: `PROGRAM/tests/remote_update_migration_required_recovery_test.cjs`

**Interfaces:**
- Produces: `applyMigrationRequired`, `rollbackMigrationRequired`, `recoverInterruptedMigrationRequired`, `recoverInterruptedUpdate` dispatcher.

- [ ] Write failing tests for success, candidate failure, PROGRAM/DATA rename interruptions, rollback interruptions, and commit-after-write preservation.
- [ ] Verify expected failures against missing dispatcher/pair state machine.
- [ ] Add migration journal fields for rollback PROGRAM/DATA, PROGRAM.next/DATA.next, source/destination identities and pair flags.
- [ ] Stop old server, build DATA.next, rename old pair to rollback, activate new pair, verify in maintenance mode, commit before writable restart.
- [ ] Reconcile filesystem state during recovery and restore the old pair together before writing rollbackRestoredAt.
- [ ] Dispatch `migration_required` from updater local/prepared apply and recover either policy.

### Task 4: Distribution and regression validation

**Files:**
- Modify: `PROGRAM/docs/UPDATER_PHASE4_MIGRATION_IMPLEMENTATION.md`
- Modify: `PROGRAM/docs/NEXT_WORK.md`
- Regenerate: `PROGRAM/program-manifest.json`, root `SHA256SUMS.txt`

**Interfaces:**
- Produces: reproducible Phase 4 source + verification evidence.

- [ ] Run focused new tests and existing program_only tests.
- [ ] Build a `migration_required` fixture release outside the source, prepare/apply it to an isolated install, and verify rollback/readback.
- [ ] Run the full regression batch and record any unrelated/environmental failures without weakening assertions.
- [ ] Regenerate manifest/checksums after the final code change and re-run distribution coherence tests.

## 2026-09-15 실행 상태

- Task 1 완료: offline restore의 `migrationAux` 적용/검증/rollback 경계를 구현하고 crash-recovery 회귀를 추가했다.
- Task 2 완료: 구 PROGRAM logical export → 신 PROGRAM `DATA.next` 재구성 경로를 구현했다. 원본 DATA tree hash 불변과 runtime identity 승계를 검증했다.
- Task 3 완료: PROGRAM/DATA pair switch, rollback, recovery dispatcher 및 commit 이후 DATA 보존을 구현했다. 실제 child-process SIGKILL 10개 경계를 검증했다.
- Task 4 부분 완료: focused 회귀 18/18 PASS, 실제 migration-required Release ZIP 정상 적용 PASS, 후보 서버 실패 강제 롤백 PASS, 정식 `manual_required` build PASS. 전체 CJS 일괄 회귀는 실행 환경의 장시간 test-process 관리 제한 때문에 완주 결과를 만들지 못했으므로 정식 release gate 완료로 간주하지 않는다.
- 정식 source 정책은 의도적으로 `manual_required`를 유지한다. `migration_required` Release는 fixture에서만 생성한다.
