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

## 2차 작업: 안전 계약 완화 (사용자 승인)

사용자가 안전 계약 변경을 허용해 D-1·D-2를 진행했다. 아래 네 변경은 기존 보장을 일부 줄인다. 줄어든 보장을 각 항목에 적었다.

### 변경

1. **owner head 묶음 읽기 4 → 32키.** read frame의 `prefetch`와 닫기 검사(`assertCurrent`)가 서버 get-many를 32키씩, 묶음당 읽기 예약 1개로 보낸다. 묶음 전체 바이트는 계속 계산한다. plugin_only는 그대로다. 줄어든 보장: 키 단위였던 읽기 예약이 묶음 단위가 되어, 키 하나가 크면 예산 초과가 묶음 전체에서 판정된다.
2. **최종 검사는 소비한 기록만 다시 읽는다.** 원천별 본문 다이제스트와 소비 의존성이 있으면 `assertPhysicalCurrentness`가 코퍼스 전체 pin readset 검사를 건너뛴다. 소비한 기록·공유 기록(manifest, registry, State, Lore 매핑)의 본문 대조는 그대로다. 줄어든 보장: 소비하지 않은 원천의 변경은 전달을 막지 않는다.
3. **전달 검사(commit)에서 새로 붙은 Micro를 허용.** 코퍼스를 읽을 때 검증된 Micro가 없던 턴에 새 Micro head만 생긴 경우, 그 차이로 회상을 폐기하지 않는다(`appendedOnlyMicroTurns`). 색인 열기(open)와 빌드는 여전히 정확히 일치해야 한다. 원문 쌍·manifest·registry·정본 창·State·Lore 변경은 계속 거부한다. 줄어든 보장: 회상 도중 생긴 Micro는 이번 전달에 반영되지 않고 다음 회상부터 반영된다.
4. **owner 기록 쓰기가 진행 중 readset을 취소하지 않음.** `fencedMemoryStorageSet/Remove`가 모든 원천 쓰기마다 `memoryGraphCompiler.invalidateAll()`로 진행 중 회상의 readset을 전부 취소했다(`LIBRA_GRAPH_RESOURCE_CLOSED`, closeReason `readset_revoked`). 이 호출을 뺐다. 다른 무효화 경로(복원, 마이그레이션, 생성 빌드 취소 등 `invalidateAll` 호출부 13곳)는 그대로다. 줄어든 보장: 쓰기 즉시 취소 대신 최종 검사의 소비 기록 재읽기에 의존한다.

시도 후 버린 것: 요청 안에서 owner proof 판정 결과를 재사용하는 memo. `libra_worldline_async_isolation_current_modes_test`가 약 50% 확률로 `LIBRA_GRAPH_RESOURCE_CLOSED`로 실패해 제거했다. 1번으로 검증 1회당 왕복이 이미 2회 안팎이라 얻는 것도 적었다.

### 2차 측정 (같은 조건, 3회 중앙값, ms / 전송 호출)

| 모드 | 단계 | 1차 후 | 2차 후 |
|---|---|---:|---:|
| server_only | cold | 3,667 / 272 | 2,692 / 208 |
| server_only | warm | 2,331 / 153 | 1,390 / 92 |
| server_only | 새 Micro 뒤 재빌드 후 | 2,561 / 170 | 1,582 / 104 |
| mirror | cold | 3,684 / 337 | 2,679 / 272 |
| mirror | warm | 2,340 / 153 | 1,400 / 92 |
| mirror | 새 Micro 뒤 재빌드 후 | 2,585 / 171 | 1,599 / 105 |
| plugin_only | 전 단계 | 변화 없음 | 변화 없음 |

수정 전(cee7f55) 대비 server_only 새 턴 뒤 회상은 3,961ms → 1,582ms다. 모든 측정 회상이 `injected=true`, `verified`였다.

회상 도중 이전 턴 Micro가 게시되는 경우: 수정 전 전달 실패(`LIBRA_GRAPH_CORPUS_SOURCE_CHANGED` → `PHYSICAL_READSET_STALE` → `RESOURCE_CLOSED` 순으로 세 겹이 막고 있었다), 수정 후 전달 성공. 신규 `tests/libra_recall_mid_micro_publication_test.cjs`는 HEAD에서 실패, 수정 후 3/3 통과.

### 2차 검증

LIBRA 회귀 40개 중 39개 통과. `libra_phase_d_v5_fault_semantic_recovery_test`, `libra_phase_d_v5_response_loss_recovery_test`, `libra_phase_d_v5_scope_chat_transition_recovery_test`는 수정 전 커밋에서도 간헐적으로 실패한다(각 3회 반복으로 확인). `libra_micro_state_admission_3mode`, `libra_phase_d_a05_action_matrix`, `libra_phase_d_v5_correction_race_recovery`, `libra_phase_d_v5_state_scope_commit_boundary`, `libra_source_edit_final_injection_3mode`, `libra_cold_start_3mode_parity`는 수정 전 커밋에서도 실패한다.

남은 비용: cold 경로 전체 재투영(약 1.1~1.5초)과 회상당 owner proof 검증 3회. 실제 RisuAI에서 다른 기기·클라이언트가 같은 scope를 동시에 쓰는 경우는 시험하지 않았다.

## 3차: 외부 리뷰 반영 (50d822d 보완)

- **P1 소비 근거 완전성.** 빈 배열·객체도 참이라 기존 조건은 소비 근거 등록의 완전성을 보증하지 않았다. 이제 bundle 항목이 하나 이상이고, 모든 항목이 unit에 대응하고, 각 unit이 본문 다이제스트가 있는 owner 기록(또는 공유 키로 검사되는 State/Lore)으로 해석될 때만 좁은 검사가 단독으로 쓰인다. 하나라도 빠지면 코퍼스 전체 pin readset 검사를 함께 한다. 다이제스트가 없는 원천을 쓰는 경로는 전처럼 전체 검사를 한다.
- **P2 Micro 동시 게시 허용 범위.** 이전 `status=missing`, 지금 `status=verified`이고 이전 기록 키가 없으며 원문 쌍(revision, digest)과 head 키가 같을 때만 허용한다. 기존 기록 교체·다른 상태 변화는 거부한다.
- **P2 32키 묶음 예산.** 자원 관리기는 한 번 실패하면 요청 전체가 실패 상태가 되므로, 수락 전에 묶음 본문 크기를 재고 읽기 한도의 절반을 넘으면 둘로 나눠 다시 읽는다. 키 하나는 기존 값 한도를 그대로 받는다. 남은 차이: `maxReads`는 키가 아니라 묶음 수를 센다(더 느슨해진 방향).
- **50d822d에서 놓친 회귀.** `libra_memory_graph_read_frame_runtime_test`(바이트 동일 서버 ABA)가 소스 고리 문자열 변경으로 실행되지 않고 실패하고 있었다. 고리를 새 줄로 옮겼고 6/6 통과한다. ABA는 묶음 읽기에서도 거부된다.

추가 검사 `tests/libra_recall_mid_micro_publication_test.cjs`(server_only, 3건): 회상 중 Micro 게시 → 전달 성공, 최종 검사 직전 소비한 Micro 본문 변경 → 전달 거부, 게시된 Micro head 교체 → 전달 거부. 소비 본문 다이제스트 비교를 지운 변형에서 두 번째 검사가 실패함을 확인했다. Micro head 교체 검사는 느슨한 허용 조건 변형에서도 통과한다(교체된 head는 이전 상태가 verified라 두 조건 모두 거부). 따라서 이 검사는 P2 조건의 회귀 감지력을 증명하지 않는다.

성능은 2차와 같다(server_only warm 1,401ms / 92회, 새 Micro 뒤 재빌드 후 1,573ms / 104회, 3회 중앙값). LIBRA 회귀 85개 중 수정 전 커밋에서도 실패하는 `libra_memory_graph_resources_runtime_test`, `libra_memory_graph_store_runtime_test`, 간헐 실패 `libra_phase_d_v5_fault_semantic_recovery_test` 외 모두 통과.

리뷰의 `libra_micro_current_observation_state_integration_test.cjs`(6fa89ac) 지적은 타당하다. 이 검사는 플러그인을 실행하지 않는 객체 검사이며 인용 끝 위치도 틀렸다. 이번 작업 범위 밖이라 고치지 않았다. Flashback 비용 패널 표시 우선순위도 같은 이유로 손대지 않았다.

## 4차: 6dccb30 리뷰의 남은 검증 (코드 변경 없음, 검사만 추가)

- **소비 근거 완전성.** `libra_recall_mid_micro_publication_test`에 네 번째 검사를 추가했다. 정상 회상에서 최종 검사가 기록한 내역을 보면, 모든 전달 항목이 해석되어 `consumedProofComplete=true`이고, 소비한 Micro 기록이 재읽기 대상에 들어 있으며, Micro를 포함한 두 종류 이상의 근거가 함께 검사된다. 항목 하나를 강제로 미해석 처리하면 회상 중 Micro 게시 상황에서 전체 pin readset 검사로 돌아가 전달이 거부된다. 이 fixture에는 Lore가 선택되지 않아 정본·Micro·State·Lore 네 종류가 동시에 선택된 경우는 확인하지 못했다.
- **Micro 최초 게시 허용 조건.** `libra_appended_micro_tolerance_unit_test`는 실제 `LIBRA.js`의 `appendedOnlyMicroTurns`를 잘라 실행한다. `missing -> verified`만 허용하고 다음은 거부함을 확인한다: `missing -> stale_source`, missing 상태에서 head만 변경, 원문 revision/digest 변경, head 키 변경, 이전 기록 키 존재, `stale_source -> verified`, 이미 검증된 Micro 교체, 정본 창 변경, 턴 삭제, 턴 쌍·manifest·registry 변경, frame·창 수 변경, Micro 외 가족 변경. 리뷰 전의 느슨한 조건으로 바꾸면 이 검사가 실패한다.
- **32키 묶음 예산.** `libra_owner_batch_budget_unit_test`는 실제 `ownerGetMany`를 실제 자원 관리기와 함께 실행한다. 작은 값 32개는 1회 왕복, 큰 값이 섞이면 나눠 읽고 모든 값이 정확히 돌아오며 바이트가 계산된다. 한도를 넘는 단일 값은 기존처럼 `VALUE_BYTE_BUDGET`으로 실패한다. 나눠 읽는 요청이 실패하면 오류로 끝나고 예약이 모두 반환된다. 처음 묶음 응답을 크기 판단에 쓴 뒤 버리고 다시 읽는 비용은 남아 있다. 실제 쿼리 경로에서는 모든 읽기가 같은 값 한도를 쓰므로, 가장 큰 기록(약 34KB)을 받을 수 있는 한도에서는 head 묶음(합계 약 22KB)이 나뉘지 않았다.

남은 것: 실제 RisuAI 설치 검증, 장기 누적 대화, 다른 기기의 동시 접근, `UNIFIED_RESPONSE_AUTHORITY_CHANGED` 실제 원인, Micro->State 실제 반영 테스트.
