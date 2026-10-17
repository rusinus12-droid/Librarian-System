# Compute 백그라운드 Job 실패 정리 · 2026-10-17

기준 `1bfa11c51d85a803fb3ca55cdd069a11b9ba8abc`. Compute SDK 0.3.6 → 0.3.7.

## 문제와 변경

Job 접수 뒤 상태 조회의 503, 결과 digest 또는 현재 binding 검증 실패가 발생하면 `schedulePreparedJob`은 `jobRuns`만 지웠다. `jobContexts`에는 해당 `prepared`가 남아 원본 요청·입력 스냅샷을 플러그인 언로드까지 보관할 수 있었다. 기존 정상 완료와 명시적 종료 상태 처리는 이미 컨텍스트를 해제하고 있었으므로 이 예외 경로에 정리가 필요했다.

이제 접수된 Job의 컨텍스트가 여전히 같은 `prepared`인 경우 `finally`에서 먼저 해제하고, 서버에 최선 노력 방식의 취소를 보낸다. 취소가 실패하거나 응답하지 않더라도 원래 Job 오류가 그대로 전달되고 `jobRuns`도 해제된다. 취소에는 별도의 짧은 **250ms 요청 예산**을 사용하며 원래 Job의 긴 잔여 시간을 사용하지 않는다. 네이티브 전송이 AbortSignal을 무시해도 클라이언트 대기는 타임아웃으로 끝난다.

취소는 Job POST를 실제 접수한 연결의 URL·Compute 토큰을 사용한다. 인증 재시도가 있었다면 실제로 수락된 최신 자격 증명을 기록한다. 이후 URL 변경·새 연결 bootstrap이 있어도 취소 대상은 바뀌지 않는다. 정리 과정에서 새 bootstrap 또는 인증 재시도를 만들지 않으며, 취소 요청에 실패한 입력 본문을 싣지 않는다.

정상 완료, 이미 종료된 Job, 정상 결과를 채택한 뒤 callback만 실패한 경우에는 불필요한 취소를 보내지 않는다. `submitJob`으로 명시적으로 받은 핸들은 일시적인 상태 조회 실패 뒤에도 호출자가 재시도할 수 있다. 자동 정리는 SDK가 내부적으로 소유한 백그라운드 작업에 적용한다.

## 배포 반영

| 항목 | 변경 후 버전 |
|---|---|
| Compute SDK | 0.3.7 |
| Flashback | 1.0.112 |
| HAYAKU | 3.0.144 |
| LIBRA | 2.3.162 |
| LIA | 0.26.84 |

네 플러그인의 Compute 내장본을 공통 소스와 정확하게 동기화했다. 각 Storage SDK 변형의 해시는 기존과 같다. GRADIA·RE:TRACE에는 Compute SDK를 추가하지 않았다. LIBRA의 기존 `retired / unified` 상태와 검색 경로를 재활성화하지 않는다.

## 검증

`compute_background_job_failure_cleanup_test.cjs` **22/22 통과**:

- 상태 503·결과 digest·현재 binding·외부 Job을 가리키는 잘못된 상태 응답에 대해 각각 반복 실패 후 컨텍스트가 해제되는지 검사한다. 해제 여부는 공개 `getJobStatus`가 추가 네트워크 없이 `MEMORY_SUITE_COMPUTE_JOB_CONTEXT_MISSING`을 반환하는 것으로 확인한다.
- 취소 503·잘못된 JSON·헤더 무응답·본문 무응답, 원래 조회 시간 초과에서도 원래 오류와 정리를 보존한다. 10초 원본 예산과 구분해 취소 대기가 짧게 끝나는지 검사한다.
- 취소 응답이 아직 도착하지 않았을 때도 입력 컨텍스트가 먼저 해제된다. 정리 중 dispose도 전송을 abort하고 상태를 되살리지 않는다.
- 동일 입력 요청 합류·실패 뒤 재시도·캐시 적중, `executeCachedOrLocal`의 로컬 답 보존, 다른 동시 Job의 보호, 연결 전환과 토큰 갱신을 검사한다.
- 명시적 Job 핸들의 재시도, 세 종료 상태, 채택 뒤 callback 실패를 검사한다.

수정 전 0.3.6 소스로 같은 검사를 실행하면 **16건 실패·6건 통과**한다. 검사 관찰용 내부 상태나 새로운 제품 debug API 없이 회귀를 탐지한다. 원시 로그는 저장소 밖 `/tmp`에 두었다.

기존 관련 검사도 통과했다: `compute_bridge`, `compute_background_job_cache`, `compute_server_integration`, `compute_token_key_separation`, `compute_late_risu_api_binding`, `sdk_lifecycle_hardening`, `sdk_variant_build` 7건, `compute_sdk_version_independence` 8건, `regression_contract_version_independence` 7건, `compute_four_namespace_product_load`, `hayaku_sparse_rrf_compute_pilot`, `lia_world_lore_compute_pilot`, `storage_compute_scope_policy_runtime`. 버전 독립성 검사의 SDK 주석 치환은 특정 이전 버전 문자열 대신 버전 패턴을 사용해, 이번 버전 상승 뒤에도 실제로 치환·검사되도록 했다.

네 플러그인의 Full 산출물이 생성·구문 검사됐고 소스와 바이트 단위로 일치했다. SDK 동기화 검사도 통과했다. 빌더의 과거 크기 기준 초과는 보고용이며 크기 최적화 성과를 주장하지 않는다.

## 한계

취소 요청의 성공은 보장하지 않는다. 서버 단절·만료된 토큰·취소 실패 때 서버 작업의 최종 정지는 기존 서버 deadline에 의존한다. 클라이언트가 참조를 해제하는 것과 JavaScript 엔진이 실제 메모리를 수거하는 시점은 구분한다. 실제 모델 호출이나 사용자 설치 RisuAI에서의 장시간 메모리 측정은 이번 검증에 포함하지 않는다.
