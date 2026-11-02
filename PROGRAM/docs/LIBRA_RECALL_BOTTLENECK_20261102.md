# 2026-11-02 LIBRA 회상 병목: 새 턴 뒤 색인 유실과 전달 거부

## 범위

`codex/gradia-native-reference-binding`(cee7f55) 위에서 작업했다. 이미 반영된 GRADIA 결속, 경계 진단(`lastResponseBoundaryFailure`, `lastCorpusColdReason`), 원문 병렬 읽기, Micro 현재 상태 관찰은 그대로 둔다. 검색 엔진·색인·캐시를 새로 만들지 않았다. 측정은 실제 hook·엔진과 임시 HTTP/SQLite 서버를 쓴 통제 측정이며 실제 RisuAI 설치 검증이 아니다.

## A. 원인

### 1. 새 Micro 뒤 런타임 공통 색인이 다시 만들어지지 않음 (수정)

LIBRA에는 이미 런타임 공통 색인(volatile common index)이 있다. cold 회상 뒤 백그라운드에서 만들어지고, 다음 회상은 이를 읽어 전체 코퍼스 재투영을 피한다. 새 기록이 쓰이면 `noteMemoryGraphSourceWrite`가 색인을 버리고 1.5초 뒤 재빌드를 예약한다.

문제는 `yieldVolatileMemoryGraphCorpusBuild`였다. 회상이 시작될 때 이 함수가 예약된 재빌드 타이머를 지우고, 진행 중인 빌드는 양보시킨다. 양보한 빌드의 catch 경로는 `yieldRequested`가 켜져 있으면 다시 예약하지 않고 끝난다. 그 결과 새 Micro 뒤 회상이 한 번 지나가면 색인을 다시 만들 주체가 사라지고, 다음 기록이 쓰일 때까지 **모든 회상이 cold 경로(`request_local_corpus`)로 전체 창을 다시 투영**한다.

재현: 수정 전 mirror·server_only에서 새 Micro 뒤 `inspectVolatileMemoryGraphCorpus()`가 `builds=1, scheduled=false, building=false, failures=0`으로 멈췄다. 오류가 남지 않는 조용한 유실이다.

### 2. 회상 자신이 쓰는 경계 기록이 색인을 버림 (수정)

회상은 그래프 조회 전에 `before_pending_boundary_arm`에서 `pending-live-boundaries:v1`을 쓴다. 이 키는 `PREFIX:scope:` 아래라서 `noteMemoryGraphSourceWrite`가 원천 기록 변경으로 보고 막 만든 색인을 버렸다. 이 기록은 요청 생명주기 기록이며 그래프 투영이 읽지 않는다(`loadPendingBoundaryStore` 호출부는 경계 관리 코드뿐이다). 1번만 고치면 색인은 다시 만들어지지만, 새 턴 뒤 첫 회상이 이 키를 쓰면서 곧바로 버려 여전히 cold로 간다. 두 수정 모두 있어야 재현 시나리오가 통과한다(각각 단독 적용 시 실패 확인).

### 3. 회상 도중 이전 턴 Micro 게시 → 전달 거부 (원인 특정, 수정 보류)

이전 턴 Micro 분석(실제로는 모델 호출 수~수십 초)이 회상 도중 끝나 게시되면 전달이 거부된다. 재현에서 회상은 `injected=false`, `failOpen=true`로 끝났고 수정 전에는 `errorCode`가 빈 값이었다. 진단을 보강한 뒤 확인한 사유는 다음과 같다.

`admission = { dispatchReason: 'LIBRA_GRAPH_CORPUS_SOURCE_CHANGED', stopReason: 'projection_coverage_incomplete', deliveryOutcome: 'base_request_only' }`

원천 증명은 창(최대 20턴) 단위다. 아직 head가 없던 턴에 새 Micro head가 생기면 그 창 전체가 변경으로 판정된다. 선택된 기억이 그 Micro를 소비하지 않았어도 전체 회상이 폐기된다. 회상이 오래 걸릴수록(실사용 36초 사례) 이 겹침 확률이 커진다. 1번 수정으로 회상 시간이 줄어 겹침 창도 줄지만 원인은 남는다.

수정하지 않은 이유: 창 단위 원천 증명(`verifyIncrementalSourceProofs`)의 판정 단위를 바꾸거나 Micro 게시를 회상 큐(`enqueue(scopeKey)`)에 묶어야 한다. 둘 다 원천 현재성 계약을 바꾸는 일이라 이 작업의 검증 범위 안에서 안전성을 입증할 수 없었다. 아래 제안 D-1에 남긴다.

`UNIFIED_RESPONSE_AUTHORITY_CHANGED`는 이 재현에서 나오지 않았다. 경계 비교 필드는 원문 전사, manifest, continuity-state 전체, registry, State 세계선 meta, migration, 서사 방향, 설정, 메모리 정책, 저장 모드다. 실제 세션에서 어느 필드가 바뀌었는지는 이미 추가된 `lastResponseBoundaryFailure.changedFields`로 다음 설치 로그에서 확인해야 한다. 근거 없이 비교 필드를 줄이지 않았다.

### HAYAKU·Flashback과의 구조 차이 (이번 측정에서 확인한 범위)

- HAYAKU는 검색에 외부 임베딩 호출이 없고 요청 내 투영·검색 특성을 재사용한다. 마지막 readset 검증은 1회다(2026-10-31 문서).
- Flashback은 최종 기준이 바뀌면 같은 요청 안에서 최대 두 번 다시 준비한다.
- LIBRA는 한 회상에서 owner proof 검증을 세 번 한다: 색인 열기(`open`), 선택 직후 dispatch 자격 부여(D02), 최종 소비자. 각 검증은 read frame을 열어 heads를 미리 읽고, 닫을 때 같은 키를 다시 물리적으로 읽는다. 3 Micro fixture에서 최종 소비자 한 번이 약 110개 키를 4개씩 순차 왕복으로 읽었다. 턴 수에 비례해 늘어난다. 이 반복은 현재 계약(D02, 최종 물리 검증, read frame 닫기 검사)이 요구하는 것이라 제거하지 않았다.

## B. 패치

`PROGRAM/plugins/LIBRA.js`(Node latin1 바이트 보존 치환)

1. `yieldVolatileMemoryGraphCorpusBuild`: 대기 중이거나 진행 중이던 빌드를 양보시킨 경우 재빌드를 다시 예약한다. 타이머는 발화 시점에 진행 중인 회상·읽기가 있으면 다시 미루므로 foreground 우선권은 유지된다.
2. `noteMemoryGraphSourceWrite`: `:pending-live-boundaries:v1` 키는 색인을 버리지 않는다. 색인을 읽을 때 원천 증명 검사는 그대로라서, 판단이 틀렸더라도 낡은 색인은 읽기 단계에서 거부된다(이 함수 주석이 밝힌 기존 계약).
3. 전달 거부 진단: `LIBRA_GRAPH_CONSUMER_UNAVAILABLE`에 `code`와 `admission`(dispatchReason, stopReason, deliveryOutcome)을 붙여 `lastMemoryInjectionMeta`에 남긴다. GRADIA 읽기 경로가 이미 하던 방식과 같다. 원문·설정·기억 값은 기록하지 않는다.

유지한 계약: 원천 증명·read frame 닫기 검사·D02·최종 소비자 물리 검증·응답 경계·ABA·scope/worldline·restore epoch 검사는 바꾸지 않았다. 병렬 읽기 배치 크기(최대 4)도 바꾸지 않았다.

## C. 성능 비교

같은 fixture(5턴 정본 + Micro 3개, 이후 Micro 1개 추가), 서버 전송당 10ms 지연, 모드별 3회 반복의 중앙값이다. 원자료는 `docs/measurements/LIBRA_RECALL_BOTTLENECK_20261102.json`.

| 모드 | 단계 | 수정 전 | 수정 후 |
|---|---|---:|---:|
| server_only | 새 Micro 뒤 색인 재빌드 후 회상 | 색인 재빌드 안 됨, cold 3,961ms / 300회 | 2,561ms / 170회 |
| mirror | 같은 조건 | 색인 재빌드 안 됨, cold 4,011ms / 301회 | 2,585ms / 171회 |
| plugin_only | 같은 조건 | 재빌드되나 경계 기록이 버림, cold 392ms | 95ms |
| 전 모드 | cold / warm / 새 Micro 직후 | 변화 없음 | 변화 없음 |

- 실사용 RP에서는 매 턴 Micro가 추가된다. 수정 전에는 새 턴 뒤 모든 회상이 cold 경로였고, 수정 후에는 Micro 게시 1.5초 뒤 색인이 다시 만들어져 다음 회상이 이를 쓴다. 이번 fixture의 재빌드는 `full_build`였다.
- Micro 게시 직후(1.5초 안) 회상은 여전히 cold다. 사용자 입력 간격이 이보다 짧으면 이 경로를 탄다.
- 모든 측정 회상이 `injected=true`, `finalVerification=verified`였다(경쟁 재현 제외).
- 3회 반복이라 p50만 보고한다. p95는 표본이 부족하다.

## D. 미해결

- **D-1(제안, 미적용):** 회상 도중 이전 턴 Micro 게시로 `LIBRA_GRAPH_CORPUS_SOURCE_CHANGED` 전달 거부. 선택지: (a) owner proof 판정에서 "head 없음 → 새로 게시됨"인 턴이 선택 결과의 소비 근거가 아니면 창 전체 무효화에서 분리, (b) Micro head 게시를 회상과 같은 scope 큐에 넣어 회상 중 게시를 뒤로 미룸. (a)는 원천 현재성 계약 변경, (b)는 큐 교착 검토가 필요하다.
- **D-2:** 회상당 owner proof 검증 3회와 read frame 닫기 재읽기, 4키 순차 배치. 턴 수에 선형으로 늘어나며 warm 2.3초의 대부분(전송 왕복 약 150회)을 차지한다. 배치 상한 조정(P4)은 자원 예약 방식(키당 `maxValueBytes`)과 함께 검토해야 한다.
- **D-3:** `UNIFIED_RESPONSE_AUTHORITY_CHANGED` 실제 변경 필드는 실사용 로그로 확인해야 한다.
- 실제 RisuAI 설치, 실제 모델 호출, 장기 누적 채팅 규모 측정은 하지 않았다.

## E. 검증

- 신규 `tests/libra_volatile_index_after_new_turn_test.cjs`(plugin_only, server_only): 수정 전 실패(`runtime index was not rebuilt`), 수정 후 2/2 통과.
- 통과: `libra_volatile_corpus_index_runtime_test`, `libra_recall_background_priority_test`, `libra_recall_verification_budget_test`, `libra_recall_read_efficiency_test`(3모드), `libra_parallel_source_pin_regression_test`, `libra_memory_graph_incremental_currentness_runtime_test`, `libra_phase_d_response_boundary_identity_test`, `libra_micro_final_injection_3mode_test`, `libra_worldline_async_isolation_3mode_test`, `libra_phase_d_v5_aba_correction_recovery_test`.
- `libra_cold_start_3mode_parity_test`는 수정 전 cee7f55에서도 같은 방식으로 실패한다. 이번 변경과 무관하며 검사를 완화하지 않았다.
- HAYAKU·Flashback·GRADIA 소스는 바꾸지 않았다.
