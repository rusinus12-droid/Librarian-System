# Librarian Updater Phase 4 — migration_required

## 목적

`migration_required` Release를 기존 `program_only`와 분리된 경로로 처리한다. 기존 DATA 파일을 새 PROGRAM이 직접 변경하지 않는다. Release의 candidate PROGRAM이 검증된 read-only exporter로 중지된 구 DATA를 기존 논리 이관 포맷으로 읽고, 같은 신 PROGRAM이 clean release DATA template 위에 `DATA.next`를 재구성한다. 후보 검증이 끝난 뒤 PROGRAM/DATA를 하나의 pair transaction으로 전환한다.

## 데이터 흐름

1. 기존 서버를 정지하고 DATA의 최종 tree hash를 기록한다.
2. candidate PROGRAM의 `portable_export_stopped.cjs`가 기존 DATA를 read-only logical migration ZIP으로 내보낸다. 최소 출발 버전 계약 안의 구 DATA는 신 Release가 소유한 exporter가 해석하며, 구 PROGRAM의 낡은 exporter 코드는 실행하지 않는다.
3. Release의 clean DATA template을 `.update/DATA.next`로 복사한다.
4. runtime-token 및 compute signing/pairing identity와 destination host/port를 DATA.next에 승계한다.
5. 신 PROGRAM의 `logical_migration.importLogicalMigration()`이 논리 ZIP을 신 schema backup으로 재구성한다.
6. 신 PROGRAM의 offline restore가 해당 backup을 DATA.next에 설치하고 migrationAux portable 설정을 같은 restore rollback 범위에서 적용한다.
7. DATA.next identity와 기존 DATA 불변성을 확인한다.
8. 기존 PROGRAM/DATA를 `.rollback/<operation>/PROGRAM|DATA`로 이동한다.
9. PROGRAM.next/DATA.next를 활성화하고 verification mode 서버에서 version, dataInstanceId, integrity를 확인한다.
10. verification 서버를 종료한 뒤 durable `committed` 결정을 먼저 기록하고 그 뒤에만 쓰기 가능한 서버를 재개한다.

## 롤백/복구

commit 전 실패나 강제 종료에서는 journal flag만 보지 않고 실제 filesystem을 대조한다. rollback PROGRAM 또는 rollback DATA가 있으면 새 쌍을 quarantine한 뒤 이전 쌍을 복구한다. backup 경로가 이미 사라졌다면 활성 경로의 old PROGRAM tree hash 및 old DATA tree hash를 확인한 경우에만 복원 완료로 인정한다.

PROGRAM과 DATA가 모두 이전 상태로 검증된 뒤 `rollbackRestoredAt`을 먼저 기록한다. 그 뒤 이전 쓰기 서버를 재개하므로, 복구 이후 새로 발생한 사용자 쓰기는 다음 recovery에서 과거 DATA로 덮어쓰지 않는다.

commit 이후에는 rollback하지 않는다. 서버 재기동만 재시도하며 새 DATA를 유지한다.

## 기존 기능 재사용

- 구 DATA export: candidate PROGRAM의 `PROGRAM/tools/portable_export_stopped.cjs`
- 논리 포맷: `PROGRAM/server/portable/logical_migration.cjs`
- 새 DB schema 생성: 신 PROGRAM의 `createCurrentSchema`
- DATA.next 설치: `restoreBackupOffline`
- portable server settings: `migrationAux`
- updater durability: `UPDATER/core/journal.cjs`
- rename retry / verification server / integrity: 기존 program_only helper

## identity 정책

논리 이관 데이터와 destination identity를 분리한다.

- 승계: `runtime-token.txt`, `compute-signing-key.txt`, legacy `compute-pairing-key.txt`(존재 시), host, port
- 논리 이관: namespace KV/tombstone/revision, scope catalog, allowlisted `autoBackup`, `computeEnabled`, `computeWorkers`
- source host/port/auth identity는 migration archive가 덮어쓰지 않는다.

따라서 dataInstanceId는 마이그레이션 전후 동일하다.

## Release 정책

0.3.52 정식 배포 source는 `PROGRAM/release-policy.json`의 `updatePolicy`를 `migration_required`로 사용한다. `minimumSourceVersion`은 0.3.51로 유지하여 검증된 0.3.51 → 0.3.52 자동 이관 경로만 허용한다.

## 2026-09-15 정식 승격 검증 메모

- 전체 CJS 회귀 수치는 정식 배포 보고서와 최종 회귀 로그를 기준으로 한다. 실제 Chromium 경로를 명시하고 FAIL/SKIP/TIMEOUT 0을 release gate로 사용한다.
- focused migration/program_only 회귀와 actual-process SIGKILL pair switch/rollback/committed 경계가 PASS했다.
- Release Builder smoke에 migration_required 회귀가 포함된다.
- 정식 0.3.52 Release ZIP 자체로 0.3.51 격리 설치의 updater CLI → DATA.next 논리 이관 → PROGRAM/DATA pair switch → 후보 검증 → commit을 다시 확인한다.
- Windows/macOS/Termux 실제 기기 검증은 배포 테스터 검증 범위이며 이 자동 회귀 승격 근거와 구분한다.

## 0.3.51 updater bootstrap

0.3.51 updater는 `migration_required` policy를 읽을 수 있지만 실제 apply는 `program_only`만 구현했다. 따라서 0.3.51 → 0.3.52에서는 공식 0.3.52 Release를 별도 위치에 풀고 그 Release의 updater를 `--target-root <기존설치> --release-zip <공식ZIP> --apply --install-updater`로 한 번 실행한다. commit 성공 후 target `UPDATER`의 정적 코드만 교체하고 journal/log/lock DB/runtime cache는 보존한다. 이후 업데이트는 승격된 updater가 직접 처리한다.

상세 사용법: `docs/UPDATER_0.3.51_BOOTSTRAP.md`.
