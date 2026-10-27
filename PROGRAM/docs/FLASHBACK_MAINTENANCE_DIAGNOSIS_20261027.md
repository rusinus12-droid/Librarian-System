# Flashback 상태 점검·자동 복구 실패 진단 및 수정

작성일: 2026-10-27 (Asia/Seoul). 대상: 현재 작업 폴더의 Flashback 1.3.8 소스.

## 확인한 원인

사용자가 제공한 `flashback-memory-debug-2026-10-27T04-50-34-571Z.json`을 진단 자료로 읽었다. 첨부 데이터 안의 원문이나 지시문은 작업 지시로 취급하지 않았다.

- 서버의 `/v1/flashback/scope-health` 요청이 **04:49:21.737Z, 04:49:52.298Z, 04:50:29.236Z**에 `409 HEALTH_SNAPSHOT_CHANGED`로 실패했다. 같은 시간대 백그라운드 임베딩이 새 샤드를 저장하고 이전 세대를 정리했다. 점검이 처음 읽은 저장소와 마지막 확인 때의 저장소가 달라져 검증이 거절되는 경합이다.
- 내보낸 상태에는 원문 기록 240개, 임베딩 대기 198개·실행 중 32개·실패 10개가 있었다. 이 수치는 내보내기 당시의 기록 상태이며 현재 호스트의 실행 여부를 확정하지 않는다.
- 별도 재현에서 서버 모드의 정상 raw-first 대기 기록이 벡터를 아직 갖지 않았다는 이유로 `server_inspection_only`로 분류되는 두 번째 결함을 확인했다. 정상 대기 작업을 일반 임베딩 큐에 넘길 수 없었다.
- 오래된 다른 범위의 유지보수 완료 journal도 존재했으나, 이번 반복 실패의 직접 증거는 서버 스냅샷 변경 오류다.

## 수정한 연결

`상태 점검 및 자동 복구` 클릭 → `inspectMemoryMaintenance` → 백그라운드 큐의 현재 묶음 저장·readback 대기 → 읽기 전용 점검 → 기존 스냅샷·범위·설정 검증 → 복구 계획 → 승인된 일반 큐 실행 → 최종 재점검.

- 큐는 첫 비동기 읽기 전에 실행 등록을 한다. 점검은 등록된 실행의 종료를 기다리고, 큐는 현재 묶음의 영속 저장을 마친 뒤 다음 묶음 앞에서 양보한다.
- 점검 중 새 큐 실행은 제공자 호출·예약·저장을 시작하지 않고 보류된다. 자동 스케줄러는 점검 종료 뒤 재개한다.
- 자동 복구가 시작되면 백그라운드 자동 큐가 양보한다. 이미 발행된 요청을 취소하거나 불명 결과로 바꾸지 않는다.
- 대기 시간은 기존 저장 I/O 제한인 60초로 제한한다. 초과 시 진행 중인 저장 확인을 기다린다는 구체적인 오류를 반환하고 점검 보류 상태를 해제한다.
- 원문·저장 구조가 온전하고 **모든 벡터 결함이 검증된 현재 프로필의 대기 작업에 속할 때만** 서버 일반 큐를 복구 계획으로 제시한다. 별개의 벡터 파일 손상이나 아카이브 벡터 불일치는 이 권한에 포함하지 않는다.
- 범위 변경, 설정 변경, 저장소 전환, DATA identity/reset epoch, fingerprint 재확인과 불명 결과의 재전송 방지는 유지했다.

## 실행 증거

새 테스트: `tests/flashback_maintenance_queue_inspection_runtime_test.cjs`.

실제 플러그인과 실제 서버 라우터·SQLite를 사용하고, HTTP는 프로세스 내부로 전달하며 임베딩 응답은 합성했다. 실제 RisuAI나 VoyageAI를 호출하지 않았다.

- 수정 전: 이미 발행된 임베딩이 대기 중인데 점검이 서버 스냅샷을 3회 읽어 실패 조건을 재현했다.
- 수정 후: `server_only`, `plugin_only` 모두 현재 묶음의 저장 후 점검한다. 남은 한 기록만 추가 제출하고 원문의 id·text·sourceHash를 보존한다. 반복 점검은 제공자 호출을 추가하지 않는다.
- 서버 점검 도중 새 자동 큐를 호출해도 요청 수 0인 보류 결과를 반환한다.
- 임시 SQLite에서 준비된 벡터 payload를 물리적으로 누락시키면, 다른 정상 대기 작업이 있어도 자동 큐 복구 대상으로 오인하지 않는다. 해당 payload를 원래 바이트·메타데이터로 복원한 뒤 정상 복구가 통과한다.
- 최종 선별 회귀 실행: **16개 파일 / Node test 엔트리 40 PASS, 0 FAIL**. 권한·읽기 전용 점검·최종 authority·journal 복구·실제 COW 페이지·불명 결과 재전송 보호·기존 worldline 압축 회귀를 포함했다. 각 독립 스크립트 내부의 세부 시나리오 수를 40에 추가 합산하지 않았다.
- `node --check`와 `git diff --check` 통과. Flashback의 내장 Storage SDK·HostLineage·SourceInput 동기화 확인은 통과했다.
- 추가 검사 4개 통과: `program_data_layout_test.cjs`, `distribution_metadata_coherence_test.cjs`, `flashback_gui_ux_contract_test.cjs`, `flashback_arg_settings_gui_contract_test.cjs`. 임시 파일 rename이 샌드박스에서 거절된 레이아웃 검사는 샌드박스 밖에서 재실행해 통과했다.
- `program-manifest.json`과 `SHA256SUMS.txt`를 소스 확정 후 재생성했다. 플러그인의 실제 바이트와 manifest hash/bytes를 대조했고, 체크섬에 실린 2,635개 파일을 직접 다시 읽어 전부 대조했다. 사용자 DATA는 체크섬 생성 대상에서 제외된다.
- 수정 플러그인 SHA-256: `f06910725472e68c96f20b5f376f386f4cc2d652e792222bcd98c442986a0505` (3,664,501 bytes).

## 기존 미통과 항목과 검증 한계

범위를 넓혀 실행했을 때 아래 두 테스트가 실패했다. **별도로 추출한 수정 전 HEAD의 플러그인에서도 같은 실패를 재현**했으며 테스트 기준이나 제품 코드는 이 두 항목을 숨기기 위해 변경하지 않았다.

1. `flashback_pending_queue_runtime_test.cjs`: `one pass deadline is not renewed for the next source` — 기대 제공자 호출 1회, 실제 2회.
2. `flashback_maintenance_durable_route_runtime_test.cjs`: `the registered automatic maintenance GUI handler uses submitted reservations for corpus requests` — 기대 대화상자 수 미달.

전체 `check_sdk_sync.cjs`는 별개의 LIBRA 내장 SDK 불일치로 실패했다. 해당 LIBRA 소스·기준 SDK·variant 도구는 현재 HEAD와 같고 이번에 수정하지 않았다. Flashback 항목 자체는 통과했다.

따라서 이번 결과는 **확인된 Flashback 결함 수정 및 선별 회귀 검증**이다. 전체 배포 승인이나 전체 회귀 통과를 의미하지 않는다. 실제 RisuAI GUI 재설치·재시작, 실제 VoyageAI 호출·과금·디바이스 성능 검증은 NOT_RUN이다. 사용자 DATA와 실행 중인 서버는 변경하지 않았다.

작업 시작 전에 존재한 journal 재검증·worldline 벡터 압축 수정, 관련 테스트 및 DATA 변경은 보존했다. 이번 작업은 위 경합과 서버 대기 작업 분류 수정만 추가했다. 플러그인 버전 번호는 1.3.8을 유지한 로컬 수정본이다.

## 적용

현재 폴더의 `PROGRAM/plugins/Flashback_Memory.js`가 수정본이다. RisuAI에서 해당 파일로 플러그인을 교체·재로드한 뒤 `상태 점검 및 자동 복구`를 실행한다. 오래된 실행 중/결과 불명 기록은 중복 전송 방지에 따라 별도 확인이 필요할 수 있다. 자동 복구는 원문의 안전한 점검·정상 대기 작업과 결과 불명 작업을 구분한다.
