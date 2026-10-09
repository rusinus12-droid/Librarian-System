# Updater Phase 3 — P0 복구 및 커밋 경계 보강

기준: 2026-09-15 Phase 2 인계 소스. 제품 버전은 0.3.51, 배포 정책은 manual_required를 유지한다. 이 문서는 구현 설명이며 운영 배포 승인서가 아니다. 최종 실행 횟수와 결과는 인계 패키지의 검증 보고서 및 원시 로그를 기준으로 한다.

## 변경 범위

RE:TRACE는 업데이트 감지/알림만 담당한다. 설치·복구는 UPDATER가 담당한다. 다섯 플러그인 payload는 수정하지 않았다. migration_required, DATA.next pair switch와 실제 GitHub 배포는 이번 변경에 포함하지 않았다.

### 복구 상태 결정

UPDATER/core/program-only.cjs는 journal flag와 함께 실제 PROGRAM, rollback/PROGRAM, checkpoint/DATA, quarantine DATA를 확인한다. 이전 PROGRAM의 버전과 신규 journal에 기록한 tree SHA-256을 검증한다. checkpoint DATA가 이미 활성 DATA로 이동된 경우에도 남은 checkpoint-manifest와 활성 DATA 전체 파일을 대조한다. 이전 PROGRAM 부재, 체크포인트 손상, 경로 이탈, 심볼릭 링크, 확인할 수 없는 서버 상태는 성공으로 처리하지 않는다.

- PROGRAM → rollback 직후 기록 전 종료: rollback PROGRAM을 검증하고 복원한다.
- rollback PROGRAM → PROGRAM 직후 기록 전 종료: 복원된 이전 PROGRAM을 검증하고 계속한다.
- DATA quarantine 또는 checkpoint DATA 이동 직후 종료: 실제 경로와 전체 체크포인트 파일 해시를 대조하여 이어간다.
- 완성되지 않은 checkpoint는 활성 DATA를 대체할 수 없다.

### 되돌릴 수 없는 결정

검증 서버 종료 후 `decision=commit`, `committedAt`, `status=committed`를 원자적으로 기록한 다음에만 쓰기 가능한 새 서버를 연다. 이후 health 확인이나 마지막 journal 갱신이 실패해도 이전 DATA로 롤백하지 않는다. 재시작 시 새 DATA를 유지한 채 서버 시작/마무리만 재시도한다.

롤백 역시 PROGRAM/DATA 복원을 검증한 뒤 `rollbackRestoredAt`을 기록하고 이전 쓰기 서버를 연다. 이 경계 이후 재복구는 과거 체크포인트를 다시 덮어쓰지 않는다. 이전 Phase 2 journal에서 새 쓰기 서버가 이미 열린 정황을 확인하면 임의로 DATA를 되돌리지 않고 검토 필요 오류로 중단한다.

### 영속성 및 동시 실행

journal 임시 파일 write → file sync → rename → directory sync 순서를 사용한다. 체크포인트 파일과 완료 manifest도 sync 및 readback을 거친다. 지원하지 않는 directory sync 오류만 플랫폼별로 제한하여 허용하며 다른 I/O 오류는 숨기지 않는다. 이는 모든 OS의 전원 장애 내구성을 인증한 것은 아니다.

UPDATER/operation-lock.sqlite의 OS 파일 잠금을 통해 CLI 전체 처리와 apply/recover의 동시 진입을 막는다. SQLite EXCLUSIVE transaction은 프로세스 강제 종료 후 해제된다. 이 DB는 사용자 DATA가 아니라 updater 제어 메타데이터다.

### 독립 실행기

업데이트.bat / 업데이트.command / 업데이트.sh는 UPDATER 내부 런타임 탐색을 사용한다. Node 22.13 이상 및 node:sqlite를 실제 검사한다. PROGRAM이 이동된 상태에서도 --recover 진입이 가능하도록 PROGRAM 의존 모듈을 지연 로딩한다.

PROGRAM 또는 rollback 내부의 Node를 선택한 경우 독립 UPDATER/_runtime 캐시에 검증 복사하고 짧은 bootstrap 프로세스를 종료한 뒤 updater를 실행한다. Windows의 실행 중 node.exe가 PROGRAM 이름 변경을 막는 위험을 피하기 위한 구조다. Windows BAT 및 macOS/Termux는 아직 실기기 인증 전이다. Termux 공유 저장소는 차단한다. PocketRisu 지원을 확정하지 않는다.

### 실제 서버 검증 격리

updater verification mode에서는 인증 후 manager/reset/portable 처리보다 앞에서 일반 경로를 차단한다. health/bootstrap을 제외하고 관리자 integrity와 shutdown만 허용한다. 기존 maintenance guard도 인증된 관리자 shutdown을 허용하여 검증 서버를 정상 종료할 수 있게 한다. HTTP health 오류만으로 서버 정지를 판단하지 않고 TCP 포트 종료도 확인한다.

## 재현 및 검사

PROGRAM/tests/remote_update_recovery_boundaries_test.cjs: 실제 폴더 rename/journal 불일치와 손상/누락 처리.
PROGRAM/tests/remote_update_commit_boundary_test.cjs: 쓰기 서버 시작 전에 journal 결정이 존재하는지, 결정 후 쓰기 보존.
PROGRAM/tests/remote_update_standalone_recovery_test.cjs: PROGRAM 부재 상태에서 실제 updater CLI --recover.
PROGRAM/tests/remote_update_launchers_contract_test.cjs: Node 검사, 플랫폼 경로 정책, 한글/공백/인자/종료코드.
PROGRAM/tests/remote_update_operation_lock_test.cjs: 동시 프로세스 거절 및 잠금 소유자 SIGKILL 후 복구.
PROGRAM/tests/remote_update_sigkill_recovery_test.cjs: 실제 파일 동작 사이의 11개 SIGKILL 경계. 이 시험의 서버 제어는 결정적 hook이며 실서비스 프로세스 시험과 구별한다.
PROGRAM/tests/remote_update_real_server_runtime_test.cjs: 실제 HTTP/SQLite/launcher 성공, candidate 실패 롤백, commit 후 신규 쓰기 보존.
PROGRAM/tests/remote_update_verify_mode_isolation_test.cjs: 실제 verification 서버의 early-route 차단과 admin shutdown/integrity 허용.
PROGRAM/tests/remote_update_offline_guard_test.cjs: HTTP 500이지만 포트가 열린 서버를 offline으로 오인하지 않음.

실행 예: `node PROGRAM/tests/remote_update_real_server_runtime_test.cjs`. 전체 기존 CJS 회귀 실행기는 PROGRAM/run_regression_batch.py다. 모든 동적 테스트는 임시 설치 루트/임시 DATA를 사용한다.

## 남은 승인 게이트

1. Windows NTFS/portable Node, macOS .command, Linux 대상 배포 환경, Android Termux private storage의 실기기 테스트.
2. PocketRisu 파일시스템·프로세스 capability 조사.
3. 실제 GitHub Release의 exact asset/digest, draft/prerelease 배제, 네트워크 장애 smoke.
4. migration_required의 논리 이관, DATA.next, PROGRAM/DATA pair switch와 pair rollback.
5. 실제 전원 장애, 디스크 오류/공간 소진 및 지원 OS별 지속성 검증. SIGKILL 통과를 전원 장애 인증으로 확대하지 않는다.

릴리스 정책을 program_only로 전환하는 것은 위 승인 절차와 별도 결정이다. 미해결 회귀 실패가 있으면 인계 검증 보고서에 명시한다.
