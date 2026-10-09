> Current core3 global-mode contract (Storage SDK 1.8.25): LIBRA, HAYAKU and Flashback now apply their own global choice through strict all-chat discovery and an aggregate resumable job. Legacy explicit routes are included and retired only after complete verification. See [GLOBAL_STORAGE_MODE_ALL_CHAT.md](GLOBAL_STORAGE_MODE_ALL_CHAT.md). Per-scope mechanisms below remain maintenance/compatibility primitives; descriptions of global follower-only application are superseded for these three owners.

# 저장 모드 전환 계약

2026-09-30부터 정식 운영 모드는 `plugin_only`와 `server_only` 두 가지다. `mirror`는 두 저장 위치를 오가는 과정에서만 사용하는 전환 단계이며 새 전역·스코프 설정의 최종 목적지가 될 수 없다.

| 상태 | 정본과 동작 | 완료 조건 |
| --- | --- | --- |
| 플러그인 단독 | pluginStorage 정본, Librarian 서버 없이 동작 | 운영 상태 |
| 플러그인 → 서버 전환, 미러 단계 | 기존 pluginStorage 정본 유지, 충돌 사전 검사와 대상 서버 저장·재조회 | 대상 범위와 namespace 무결성 검증 후 서버 단독 기록 |
| 서버 단독 | 서버 DATA 정본, 서버 장애 시 정본 I/O 보류 | 운영 상태 |
| 서버 → 플러그인 전환, 미러 단계 | 기존 서버 정본 유지, 대상 범위·의존 자료 복원과 로컬 재조회 | 전체 복원 검증 후 플러그인 단독 기록 |
| 기존 미러 설정 | 호환 경로로 자료를 보존하며 `migrationRequired:true` 표시 | 사용자가 두 단독 모드 중 목적지를 선택해 검증 완료 |

전환 중 공개 `mode`는 기존 정본의 모드를 유지한다. `storagePhase:'mirror'`와 `transition`이 이동 방향과 실제 진행 상태를 표시한다. 공용 SDK의 `getStorageModeContract()`와 서버 `/bootstrap`의 `storageModeContract`가 `memory-suite.storage-mode-contract.v2`를 제공한다. `setMode`, `setScopeMode`, `setGlobalMode`, `configureConnection`, `startConnectionConfigurationJob`은 미러 및 과거 미러 별칭을 목적지로 받으면 `MEMORY_SUITE_MIRROR_TRANSITION_ONLY`로 거부한다.

전환 준비의 `transition.phase:'draining'`에서는 기존 정본으로 owner 자료 I/O를 계속 처리한다. 접수된 작업의 내부 저장 호출과 준비 중 추가로 접수된 작업까지 반복해서 기다린다. 이때 다른 설정 변경과 인계는 보류한다. 모든 작업과 쓰기 큐가 비면 중간 비동기 대기 없이 `transition.phase:'mirror'`로 변경하고 스냅샷 이동을 시작한다. 이 복사·검증 단계의 공용 브리지 owner 자료 I/O는 `MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS`로 보류된다. 이 잠금은 namespace 안의 공유 자료도 보호한다. 주소·credential·일반 UI 설정은 별도 로컬 영역을 유지한다. 전환 완료 시 이전 저장소의 자료를 자동 삭제하지 않는다. 복구용 자료와 삭제 기능은 별도로 관리한다.

이동 실패 시 새 목적지 모드를 성공으로 기록하지 않는다. 서버 → 로컬 복원이 실패하면 기존 복구 필수 잠금과 rollback/readback 계약을 유지하며 서버 단독으로 복구를 재시도한다. 전역 설정을 바꾸면서 이동하지 못한 스코프는 기존 모드와 미완료 목적지를 기록하여 검증하지 않은 저장소로 자동 라우팅하지 않는다. 배경 전환은 기존 내구성 sync-job journal로 재개한다. 프로세스 중단으로 사라지는 메모리 내 미러 단계 자체를 정식 모드로 저장하지 않는다.

기존 미러 설정은 임의로 한쪽 단독 모드로 변환하지 않는다. 플러그인 단독으로 완료할 때 LIBRA는 서버 정본을 복원하는 기존 계약을 유지한다. 공용 일반 경로에서 플러그인 단독으로 완료할 때는 양쪽의 충돌을 쓰기 전에 확인하고 서버에만 있는 자료까지 복원한다. 충돌이 있으면 사용자가 원인을 해결한 뒤 전환을 다시 실행한다. 기존 미러에서 서버 단독으로 완료하는 경로는 기존 동기화·무결성 검증 정책을 유지한다.

RE:TRACE의 신규 세션 인계와 신규 Native Branch 준비는 단독 모드에서 전환이 완료되어야 허용한다. 기존 미러 설정·활성 전환·미완료 배경 전환은 인계를 차단한다. 과거 저장 레코드의 `mirror` 값, 전송 진단 헤더, 내부 공유 메타데이터의 복사·복구 경로는 하위 호환을 위해 해석 가능하게 둔다. 데이터 복사본이 존재한다는 사실은 정식 미러 운영 모드를 의미하지 않는다.

과거 `3mode` 테스트와 지원표의 `mirror` 열은 퇴역 전 동작 및 기존 미러 자료의 호환 회귀 근거다. 새 운영 모드의 지원 범위는 두 단독 모드로 판정하고 전환 검증은 별도 계약 테스트로 판정한다. 과거 감사·릴리즈 기록은 당시 근거로 보존한다.

실행 근거는 `storage_mirror_transition_retirement_test.cjs`, 전역 설정·mounted panel·배경 작업·RE:TRACE gate·인계 대상 준비 테스트에 둔다. 로컬 HTTP/SQLite와 합성 RisuAI/모델 테스트는 실제 RisuAI 호스트 또는 실제 모델 검증을 대신하지 않는다.
