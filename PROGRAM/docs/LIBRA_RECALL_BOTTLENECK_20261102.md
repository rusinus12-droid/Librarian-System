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

## 5장: 백그라운드 저장소 읽기 캐시 (cd78b9f 당시 계약; 아래 6장으로 제한)

배경: 읽는 쪽(회상, GRADIA)이 없을 때도 LIBRA 자신의 백그라운드 작업이 8초에 약 2,000회 저장소를 읽었다. 대부분 `source-receipt`, `source-receipt-head` 키를 같은 값으로 반복해서 읽는 것이었다. 이 읽기가 서버 요청 줄을 차지해 GRADIA 읽기가 41초까지 늘어난 것으로 본다.

새 계약:

- **무엇을 캐시하나.** `storage.getVerifiedJson`, `getStoredJson`의 결과를 세션 안에서 기억한다. 자원 예산(resource budget)이 붙은 읽기는 캐시하지 않는다.
- **유효 기간.** 20초, 최대 4,096개.
- **캐시 키.** 저장 모드, 서버 바인딩 세대, `microRestoreGeneration`, `memoryGraphStoreSerial`을 함께 넣는다. 이 중 하나라도 바뀌면 이전 값은 쓰이지 않는다.
- **무효화.** fenced set, fenced remove, `storage.remove`, 그리고 코어의 `commitConditionalBatch` 6곳 앞뒤에서 캐시를 비운다. 근거: 한 세션에서 LIBRA 네임스페이스를 쓰는 주체는 LIBRA 하나다.
- **전달 직전 검사는 항상 새로 읽는다.** `assertConsumedDataCurrent`, `assertUnifiedResponseBoundary`, `validateUnifiedResponseContext`, `verifySourceProofs`, `assertPhysicalCurrentness`, `verifyGradiaMemoryEvidence`는 `freshReadDepth` 안에서 실행되어 캐시를 건너뛴다. 그래서 모델에 전달되는 기억은 지금도 실제 저장소 값과 대조된다.
- **포기한 것.** 다른 기기나 다른 탭이 같은 LIBRA 데이터를 바꾸면, 백그라운드 작업은 최대 20초 동안 옛 값을 볼 수 있다. 이 경우 전달 직전 검사가 거부하고, 작업은 다음 주기에 다시 한다. 틀린 기억이 전달되지는 않지만 그 사이 작업이 헛돌 수 있다.
- **그래프 질의 재시도.** cold 빌드 중 원본이 바뀌어 `LIBRA_GRAPH_CORPUS_SOURCE_BODY_CHANGED` 또는 `LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH:`가 나면 `executeMemoryGraphUnifiedQuery`가 최대 2회 새로 빌드한다. 마감까지 2초 넘게 남았을 때만 한다. 읽기 단계의 torn 코드(`LIBRA_GRAPH_READER_BODY_CHANGED` 등)는 projection 안에서 이미 2회 재시도하므로 바깥에서 다시 재시도하지 않는다. 처음에는 바깥에서도 재시도해 시도가 3×3=9회로 늘었고, `libra_memory_graph_read_frame_runtime_test`가 이를 잡았다.

측정 (server_only, Micro 10개, 이 테스트 환경):

| 항목 | HEAD | 변경 후 |
|---|---|---|
| 읽는 쪽 없이 8초 동안 백그라운드 저장소 읽기 | 2,004회 | 275회 |
| GRADIA 읽기 열기, cold | 2,086ms | 2,037ms |
| GRADIA 읽기 열기, warm | 823ms | 808ms |
| GRADIA 전달 직전 검사, cold / warm | 199 / 124ms | 169 / 109ms |

이 환경에서는 GRADIA 읽기 자체가 거의 그대로다. 측정 중 백그라운드 작업과 겹치지 않았기 때문이다. 실제 사용에서 얻는 효과는 백그라운드 읽기가 약 7분의 1로 줄어 서버 요청 줄이 비는 것이다. 41초 상황이 얼마나 줄었는지는 실제 RisuAI에서 다시 봐야 한다.

테스트 변경:

- `libra_recall_mid_micro_publication_test` 네 번째 검사를 타이밍 경쟁 대신 FULL_PIN seam으로 전체 pin 검사 횟수를 세도록 바꿨다. 이전 강제 경우는 HEAD에서도 실패했다(바꾼 키가 pin 집합에 없었다).
- `libra_gradia_unified_pipeline_runtime_test`는 모델 프롬프트에 `owner_issued_evidence_bundle`이 있는지 확인하고 있었다. 76b1a5d에서 저장 메타데이터를 모델 입력에서 뺐으므로, 이제 LIBRA owner 표시가 있고 이 내부 라벨은 없는지 확인한다.

회귀: memory_graph, recall, gradia 계열 88개 통과. 원래 HEAD에서도 실패하던 테스트(위 장들과 동일)는 제외했다.

## 6장: 2026-11-03 리뷰 후 보완 (f9e7b7b 당시; 아래 7장으로 확장)

### Git 기준

`git ls-remote`로 확인한 현재 개발 브랜치 `claude/libra-recall-bottleneck-20261102`의 원격과 로컬 HEAD는 모두 `cd78b9f3c281ecef736d7e89d3e6a6853c6c1037`였다. 원격 main은 `659a296ff5a929880c2e6a735a7828c58bfec24c`이며 `353225b`까지의 PR #25 병합이다. 개발 브랜치의 후속 세 커밋은 아직 main에 없다. 두 브랜치를 fetch하여 포함 관계만 확인했으며 병합·push는 하지 않았다.

### 변경

- GRADIA의 HAYAKU 투영은 entity/world/narrative/planner의 모든 의미 leaf와 요약·추론 주의·발화 경계를 경로를 붙인 문장으로 전달한다. 과거 사건, 세계 규칙과 예외, 장면 밖 흐름, 장면 변화, 복선 회수, 지식·비밀의 공개 범위 및 목록 뒷부분을 보존한다. HAYAKU 생산자·저장 계약은 변경하지 않는다. lineage 등 전송 메타데이터는 제외하고 기존 전체 근거 예산을 적용한다. 출력이 커지면 전체 항목 선택 예산에서 제외될 수 있으며 모든 패킷이 항상 모델에 들어간다는 보장은 아니다.
- 세션 캐시는 `plugin_only`의 예산 없는 `getVerifiedJson`에만 남긴다. `server_only`·`mirror`와 범위가 불명확한 `getStoredJson`은 캐시하지 않는다. 외부 서버 쓰기를 세션 무효화만으로 추적할 수 없기 때문이다. 따라서 5장의 서버 백그라운드 읽기 86.3% 감소 수치는 이번 후보의 성능 보장이 아니다.
- 항목당 64 KiB, 전체 4 MiB의 UTF-16 직렬화 payload 상한과 기존 4,096개 상한을 적용한다. 키·signature 크기도 계산한다. 실제 JS heap 상한을 측정한 수치는 아니다. 캐시 접근/삽입 때 만료 항목 전체를 정리한다. 유휴 중 즉시 제거하는 타이머는 추가하지 않았다.
- 로컬 캐시는 기존 20초 TTL과 쓰기 무효화, 연결 세대·복원 세대 분리, 전달 직전 물리 검증 우회를 유지한다. 여러 실제 RisuAI 탭이 plugin-only 저장소를 공유하는 경우의 외부 변경 통지는 이번 검사 범위에 포함되지 않는다.

### 검증

- `gradia_hayaku_semantic_projection_test`: 누락됐던 의미 영역, 중첩 조건, false 값, 12번째 규칙, 비밀 공개 범위, 원본 불변성 및 알 수 없는 스키마 통과.
- `libra_verified_read_cache_test`: hit, TTL 만료, 결과 복사, 쓰기/삭제 무효화, 읽기와 쓰기 경합, 서버 연결 세대·복원 세대 변경, fresh 우회, raw 읽기 우회, 항목당·전체 payload 예산, 만료 일괄 정리, 호출별 fallback 통과.
- `libra_shared_cache_external_write_test`: server_only/mirror 양쪽에서 반복 읽기 뒤 TTL 안에 외부 서버 쓰기를 수행한다. server_only는 새 값을, mirror의 불일치는 오류를 반환한다. 양쪽 복제본 갱신 후에는 새 값을 읽는다. 실제 정본 생산자 대기 중 추가 외부 Head 변경을 넣으면 오래된 후보 게시가 막히고, 재시작한 bridge에서도 외부 값이 유지된다. 공유 모드에 stale cache hit 자체를 허용하지 않는 방향으로 수정했다.
- 기존 three-owner 소비/모델 전달, RP 원문 결속, 분석 중 GRADIA 읽기, 회상 중 Micro 게시와 소비 근거 변경 검사 및 서버 writer/State 원자성 검사도 실행한다. 서버 fixture는 실제 제품 request handler와 디스크 SQLite를 쓰지만 HTTP 전송은 내부 dispatch이며 RisuAI/모델은 통제한다.
- 실행 환경의 기본 임시 폴더에서 rename EPERM이 발생하여 임시 경로를 `.development/cache-review-temp`로 옮겼다. jsdom은 기존 `PROGRAM/build-support/node_modules`를 NODE_PATH로 지정했다. 소스의 안전 검사를 약화시키지 않았다.

실제 RisuAI GUI, 실제 공급자, 장기 사용·기기 성능, 전체 회귀/CI 및 서버 캐시 우회 후 경합 지연 재측정은 수행하지 않았다. 공개 릴리스·배포도 하지 않았다.

## 7장: Micro·렌즈·정본·State 공통 캐시 재사용과 게시 보호

`cd78b9f`의 Map·20초 TTL·복사 반환·쓰기 무효화·최종 fresh 검사 구조를 유지하면서 `f9e7b7b`의 서버 모드 전체 캐시 우회를 대체했다. TTL은 보관 정책이고 현재성의 권한은 새 저장소 관측이다.

- **서버 재사용.** 기존 `/v1/kv/get-many`에 선택적 `knownValues`를 추가했다. revision/digest/exists/tombstone이 현재 SQLite metadata와 모두 같을 때만 본문 없이 `unchanged`를 반환한다. 변경·삭제·없던 키의 생성·같은 값 ABA는 새 관측으로 처리한다. 권한·reset 검사·pagination·응답 크기 제한은 기존 경로를 사용한다. 구버전 서버가 이 옵션을 무시하면 전체 최신 값을 읽는 경로로 동작한다.
- **동시 읽기.** 같은 키·mode/binding/restore/store 세대·자체 write sequence의 읽기는 하나의 flight를 공유한다. 서로 다른 키는 최대 32개씩 묶는다. flight/queue는 256개로 제한하고 초과 시 일반 읽기로 돌아간다. flight는 20초 후 교체할 수 있고 이전 요청의 늦은 정리가 새 flight를 삭제하지 않는다. fresh/resource-budget 읽기는 이 공유 경로에 합류하지 않는다.
- **native 및 raw 읽기.** plugin_only는 실제 owner bytes를 읽고 이전 bytes와 같을 때만 JSON decode를 재사용한다. getStoredJson도 실제 raw 읽기 뒤 순수 decode를 재사용한다. host가 durable revision을 주지 않는 상황에서 TTL만으로 외부 탭의 원천 변경을 숨기지 않는다.
- **모든 원천 가족.** 검증한 원천이 달라지면 기존 `noteMemoryGraphSourceWrite`와 snapshot source epoch 경로로 파생 view를 무효화한다. Micro/렌즈/정본/State를 키 종류에 따라 제외하지 않는다. 기존 keys 열거 경로도 캐시하지 않는다. 자체 set/remove 및 조건부 batch 앞뒤의 무효화를 유지한다.
- **렌즈 정의와 결과 구별.** 렌즈 결과 Head/records뿐 아니라 runtime-settings에 저장되는 공통 렌즈 정의도 다룬다. 기존 3초 registry TTL로 정의 변경을 숨기지 않고, 실제 설정 bytes와 lifecycle이 같을 때 정규화 결과만 재사용한다. 정의 저장과 관측된 변경 모두 파생 원천 view에 알린다.
- **Micro 게시.** source receipt·source Head·raw capture·work와 기존/누락 Micro Head의 원래 revision을 게시 검사 전에 pin한다. 서버에서는 Micro record와 Head를 같은 조건부 batch로 게시한다. 원천을 새 revision으로 다시 맞춰 오래된 후보를 통과시키지 않는다. 조건 충돌은 stale_source이며 부분 record/Head를 남기지 않는다. mirror의 서버 원자성과 로컬 복제 검증은 구별하며 로컬 복제 미검증을 성공 처리하지 않는다. 정본/State의 기존 readset/CAS와 최종 전달 검사를 유지한다.
- **메모리.** 전체 보관 payload 4 MiB·4,096개 상한을 유지한다. 항목당 상한은 128 KiB다. mirror에서 실제 State Head의 decoded 값과 exact-local-byte witness를 함께 계산하면 기존 64 KiB로는 재사용하지 못했기 때문에, 항목당 허용량만 제한적으로 늘렸다. raw witness·pin도 바이트 예산에 포함한다. 별도 registry 정규화 캐시도 128 KiB 이내에서만 보관한다. 이는 heap 전체 상한이 아니다.
- **변경 범위.** 서버는 DB schema 변경 없이 metadata 조회를 재사용한다. Storage SDK는 공유 릴리스 버전 1.8.35를 유지하고 LIBRA 전용 source variant에 호환 옵션을 추가하여 LIBRA embed에만 동기화했다. 기존 릴리스 메타데이터는 공통 SDK 버전의 일치를 요구하며 전용 variant의 정확한 내용은 SHA로 구분한다. 다른 다섯 플러그인의 SDK/생산자 계약은 보존했다. GRADIA의 HAYAKU 의미 보존 패치는 유지했다.

### 검증과 측정 범위

새 회귀는 `libra_source_family_cache_test`, `libra_micro_publication_cache_race_test`, `server_conditional_read_cache_test`다. 기존 캐시 검사는 새 물리 bytes 관측 후 decode 재사용을 확인하도록 갱신했다. schema를 해석하지 않는 저장소 가족 검사는 별도로 표시하고, 실제 API로 렌즈 생성·추가 분석, 정본 5→10턴 append, State correction을 warm cache 위에서 수행해 재시작 후에도 확인했다. 렌즈 정의의 외부 수정도 기존 TTL 안에서 감지한다. Micro는 실제 producer가 조건부 commit에 도달한 직후 원천 Head를 ABA 변경하여 record/Head 모두 게시되지 않는 것을 확인한다.

실제 localhost HTTP/SQLite에서는 조건부 읽기의 새 키 생성·ABA·응답 예산·namespace 권한과 기존 조건부 게시/SDK 호환 회귀를 실행했다. 별도의 내부 dispatch fixture에서는 GRADIA three-owner 전달, 분석 중 읽기, Micro 동시 게시, 소비 근거 변경, 렌즈 의미 검색, State/정본 writer 회귀를 실행했다. fixture의 synthetic 모델 호출은 실제 공급자 실행이 아니다.

최종 Node test runner 결과는 제품/fixture 선별 회귀 46/46, 실제 localhost HTTP·SDK 회귀 12/12 통과다. SDK variant 동기화 검사와 소스 문법 검사도 통과했다. 전체 저장소 회귀 또는 릴리스 gate 통과를 뜻하지 않는다.

통제된 동일 State Head 50회 helper 읽기에서 server_only/mirror 모두 f9e7b7b의 응답 1,281,950 bytes가 후보의 58,235 bytes로 줄었다(약 95.5%). 같은 키의 동시 50회 읽기는 서버 요청 50→1회다. **순차 50회는 현재성 확인 때문에 여전히 서버 요청 50회이며, cd78b9f의 1회 요청과 동등하다고 주장하지 않는다.** cd78b9f는 이 비교의 TTL 안 외부 변경을 일반 읽기에서 보지 못했고 후보는 확인했다. 시간 수치는 내부 dispatch 환경의 값이므로 실제 네트워크/호스트 지연 보장이 아니다.

실제 RisuAI GUI, 실제 공급자, 다중 기기 장기 운용 및 기존 8초 background+GRADIA 경합 workload의 성능 재측정은 남아 있다. 렌즈 저장 전체를 다중 writer 원자적 트랜잭션으로 전환한 것은 아니며, 이번 변경은 캐시가 생략하던 원천 관측과 Micro 게시 경계를 보호한다. 커밋·push·배포는 수행하지 않았다.

## 8장: 75b0859 P2 리뷰 검증 — 외부 쓰기·flight 포화·8초 경합

### 진행 중인 읽기와 외부 쓰기

`libra_read_flight_boundary_test.cjs`는 첫 번째 물리 읽기가 완료된 서버 응답을 host transport에 전달하기 직전에 멈춘다. Micro source pin은 먼저 완료하고 실제 공유 helper의 응답만 멈춘다. 외부 writer가 SQLite 값을 바꾼 뒤 두 번째 helper 호출을 시작하고, 같은 key와 같은 entry 객체에 합류했음을 관측한 다음 응답을 풀어 준다. 관련 없는 background 호출도 증가시킬 수 있는 전역 coalesced 수치만으로 합류를 판정하지 않는다. native host도 첫 getItem의 원래 bytes를 보관한 뒤 같은 순서를 재현한다.

- native와 server_only의 늦은 호출은 이전 관측을 받을 수 있다. 이 helper를 호출 시점 최신성을 보장하는 독립적인 선형화 읽기로 해석해서는 안 된다. 다음 fresh 읽기는 새 값을 본다.
- 실제 producer가 만든 result_ready 작업과 분석 결과를 그대로 Micro 게시 함수에 다시 전달했다. source pin 뒤의 공유 flight에 외부 쓰기를 삽입하자 `stale_source / micro_publication_basis_changed`로 거부됐다. 기존 Micro 본문·Head의 bytes와 revision은 그대로였다.
- 실제 State 승인 함수에서도 원래 Head를 빌리는 순서를 재현했다. 닫는 검사는 `stale_basis / state_basis_changed_after_admission`으로 거부하고 외부 Head를 보존했다. 이후 새로운 원천에서 유효한 승인이 만들어질 수는 있지만, 승인된다면 새 basisDigest에 결속됨을 확인했다. State 승인의 저장소 전체 원자성을 새로 주장하는 검사는 아니다.
- mirror의 두 번째 호출은 새로 읽은 local bytes와 첫 서버 관측이 달라 `LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH`로 거부됐다. Micro와 State의 첫 호출에 대한 게시/승인 방어도 확인했다.

이 검증에서는 잘못된 Micro 재게시·State 승인을 확인하지 못했다. 공유 방식과 게시 경계는 변경하지 않았다. 검증 경계는 실제 제품 함수·서버 handler·디스크 SQLite와 통제된 in-process HTTP/RisuAI host다.

### 다른 키 256개가 끝나지 않는 장애

native ownerLegacyRead는 legacy getItem을 그대로 기다리며 독립적인 timeout이 없다. 서버 SDK는 기본 30초 caller timeout과 AbortSignal을 갖지만, 물리 drain/호스트의 실제 취소와는 구별된다.

75b0859에서 서로 다른 키의 native 요청 256개를 멈추고 flight 나이만 20초 넘긴 뒤 새 키를 읽었다. 이전 키들을 다시 요청하지 않으면 Map은 256개 그대로이고 새 키의 동시 두 읽기는 둘 다 fallback했다. 원래 작업을 완료시키면 Map은 비워졌다. 이는 256개로 제한된 registry의 admission 복구 문제이며 독립적인 무한 메모리 누수의 증거는 아니다.

수정은 각 local/server 읽기 시작 시 만료된 전체 flight를 registry에서 제거하는 것뿐이다. 추가 timer·cache·호스트 요청 취소는 도입하지 않았다. 아직 유효한 flight 256개가 차 있을 때의 fallback은 유지한다. 원래 요청은 실제로 완료될 때까지 살아 있을 수 있으며 늦은 cleanup의 entry identity 검사를 유지한다. `flightExpirations`·`flightFallbacks`로 분리 관측한다.

수정 후에는 만료된 256개가 정리되고 새 키의 동시 읽기가 하나로 합쳐진다. 옛 요청들을 나중에 완료시켜도 새 pending flight는 남는다. 새 포화 회귀를 원래 75b0859 소스로 실행하면 `2 !== 1`로 실패하므로, 검사 자체가 누락된 정리를 구분하는 것도 확인했다. flight 경계 6건과 기존 캐시·원천 가족·Micro 게시·회상 회귀를 합친 선택 검사 22/22가 통과했다.

### 8초 요청 수와 실제 읽기 시간 비교

원래 측정 스크립트는 버전 관리된 소스나 현재 evidence에서 찾지 못했다. 따라서 기존 문서의 server_only·실제 producer Micro 10개·8초 조건을 기존 graph reader fixture로 재구성했다. 이를 과거 측정의 완전히 동일한 실행이라고 표현하지 않는다. 재실행 도구는 `tools/libra_read_contention_benchmark.cjs`다.

측정 팔은 두 개다. idle은 추가 지연 없이 8초간 백그라운드만 관찰한다. contention은 같은 fixture의 transport에 요청당 5ms와 단일 FIFO slot을 넣고 250ms 뒤 실제 GRADIA owner evidence capture/verify를 시작한다. 첫 capture가 끝난 뒤 두 번째 capture를 실행한다. 두 번째 capture는 8초 창 밖이며, 첫 capture가 실패했다면 진정한 warm 상태라고 단정할 수 없다. metadata/본문 읽기와 제어·쓰기 요청 모두 세고, KV 읽기는 별도 기록했다. 실제 socket·RisuAI·provider latency 측정은 아니다.

| commit | idle 8초 요청 수 (1차 / 역순 재실행) | 그중 KV get/get-many |
|---|---:|---:|
| 캐시 전 76b1a5d | 1,886 / 미실행 | 1,817 |
| cd78b9f | 275 / 275 | 203 / 203 |
| 75b0859 | 1,642 / 1,642 | 1,572 / 1,572 |

idle의 응답량은 cd78b9f 약 1.49 MB, 75b0859 약 3.63 MB였다. Head 한 개의 반복 읽기에서 측정한 95.5% 전송량 감소를 이 전체 백그라운드 workload에 적용할 수 없음을 확인했다.

| contention의 owner capture | cd78b9f 1차 / 역순 | 75b0859 1차 / 역순 |
|---|---|---|
| 첫 capture | 12.994s / 12.999s, 모두 전달 가능·검증 성공 | 34.172s 성공 / 23.866s 뒤 `LIBRA_GRAPH_COMPILER_PHYSICAL_READSET_STALE` |
| 두 번째 capture | 2.848s / 2.834s, 모두 성공 | 8.629s / 36.763s, 모두 성공 |

75b0859의 첫 successful capture 뒤 verify는 0.870s, cd78b9f는 0.217s였다. 실패한 첫 시도를 더 빠른 성공으로 집계하지 않았다. 8초 contention 창의 background 요청 수는 cd78b9f 346/334, 75b0859 355/365였으며, 이 수만 비교하면 backlog가 처리되는 데 걸린 긴 시간과 전체 query latency를 놓친다. queue wait와 요청 수·bytes·parser 비용은 결과 JSON에 분리했다.

**판정:** 이 통제된 workload에서 75b0859는 cd78b9f의 백그라운드 요청 절감과 경합 읽기 성능을 유지하지 못했다. 반복 전송과 decode 감소는 일부 입증됐지만 병목 해결은 미완료이며, 앞선 좁은 측정만으로 성능 개선을 주장할 수 없다. 정상 요청이 20초 미만인 위 비교는 이번 registry 만료 정리의 효과를 측정한 것이 아니다.

이번에는 이 결과를 근거로 새 캐시 계층을 추가하거나 최신성·최종 검증을 완화하지 않았다. 다음 성능 변경은 실제 백그라운드 작업 경계 안의 중복 검증을 추적하고, Micro·렌즈·정본·State의 소비 readset과 최종 게시 조건을 유지한 상태에서 수행해야 한다. 실제 RisuAI/다중 기기와 전체 릴리스 회귀는 별도다. 결과 원본은 `.development/evidence/contention8-results.json`, `contention8-repeat-results.json`, flight 결과는 `flight-review-after-fix.log`이며 로컬 evidence로 남겼다.

## 9장: 백그라운드 작업 안의 관측 재사용과 닫는 검증

`cd78b9f`의 반복 관측 재사용을 명시적인 작업 경계로 제한해서 복원했다. 기존 session cache와 owner read frame을 사용하며 별도의 영속 캐시는 만들지 않았다. receipt 재조정, Micro 생산, 인물 span, Canonical 원문/후보 읽기, 자동 State 승인 전 Micro 읽기, snapshot에 한정한다. 일반 helper와 resource-budgeted 회상/GRADIA 읽기는 기존 물리 검증을 유지한다.

작업은 TTL 안 resident bytes와 revision을 임시 관측으로 빌릴 수 있지만, 이 값만으로 결과를 반환하거나 저장하지 않는다. 실제로 소비한 키만 닫을 때 32개 단위로 서버 revision/digest/exists/tombstone을 확인한다. native/mirror는 local bytes도 실제로 재관측한다. Micro·렌즈·정본·State의 기존 키뿐 아니라 없던 키의 추가, 삭제, 서버 ABA도 같은 검증 대상이다. Lens runtime settings는 별도 원래 bytes witness를 확인한다. 변경이 발견되면 resident cache를 비우고 해당 작업을 거부한다.

`setVerifiedJson`은 쓰기 전에 해당 작업의 원래 관측을 검증한다. 쓰는 동안 재사용을 중단하고 실제 저장·readback이 성공한 키만 새 관측으로 진행한다. 다른 의존성은 다음 쓰기/반환 시 다시 검사한다. 다른 작업의 쓰기는 기존 viewer를 중단하지만 그 viewer의 오래된 관측이 정상 writer를 거부하지는 않는다. 공유 프레임은 finally에서 닫는다. Micro 본문+Head의 최종 원자 CAS와 원래 source/work/target pin은 유지한다. 무관한 요청의 전역 fresh depth가 백그라운드의 명시적 작업 경계까지 개별 읽기로 바꾸지 않으며, 각 작업의 닫는 검증 자체는 물리 읽기다.

동일 classified 인물 span의 본문·Head가 이미 일치하고 전체 inventory 검증도 통과하면 재저장을 생략한다. 새 provider 호출이나 Head revision 증가 없이 중복 완료한다.

### 재측정

도구의 `--commits=working-tree`로 미커밋 소스를 직접 읽고 SHA-256을 기록한다. 8장의 동일 통제 fixture이며 live RisuAI/network 측정은 아니다. 초기 실험에서 첫 읽기 41~43초 회귀가 나와 그 상태를 최종 결과로 채택하지 않았고, 동일 inventory 재저장 제거 후 다시 측정했다.

| 대상 | idle 8초 요청 | 첫 owner capture | 반복 capture |
|---|---:|---:|---:|
| `cd78b9f` 재실행 | 275 (KV 203) | 13.160s | 2.860s |
| `75b0859` 이전 반복 측정 | 1,642 (KV 1,572) | 34.172s 성공 또는 torn read 실패 | 성공 후 8.629s |
| 수정본 1차 | 600 (KV 559) | 22.932s | 3.018s |
| 수정본 2차 | 519 (KV 484) | 24.767s | 3.003s |
| 최종 소스 확인 | 585 (KV 544) | 29.392s | 3.029s |

수정본의 두 capture/verify 모두 전달 가능·검증 성공이며 verify는 약 0.216~0.218초였다. idle 요청은 75b0859 대비 약 63~68% 줄었지만 cd78b9f의 275회/첫 읽기 13초에는 도달하지 못했다. idle 응답량도 약 2.63~2.92MB로 cd78b9f의 약 1.49MB보다 크다. 마지막 재실행의 contention 전체 background 요청은 1,024회로, 첫 8초 창의 411회만 보고 작업 전체 요청이 그만큼이라고 해석하지 않는다. 75b0859 동시 재실행에서는 첫 capture가 8.336초 뒤 unavailable로 실패하고 다음 capture가 13.350초 후 성공했다. 실패 시간을 성공 latency와 비교하지 않는다. 요청 감소와 반복 읽기 개선은 입증됐고, 예전 성능의 완전 복원은 남아 있다.

최종 소스 확인은 capture/verify 모두 성공했고, 첫 읽기는 여전히 변동이 크다. 중간의 동일 동작 소스 확인에서는 17.883초도 관측했지만 빠른 값만 최종 성능으로 채택하지 않는다. snapshot의 미게시/교체된 반환 경로까지 닫는 검증을 추가한 최종 소스는 `c2233b285f034028953c9189c99a0f0dbd4378a2171c8ae788ed995597e5cf94`이며 `.development/evidence/job-cache-shipped-source.json`에 일치하는 SHA와 결과가 있다. 이 최종 실행의 전체 background 요청은 1,383회다.

원본 반복 자료는 `.development/evidence/job-cache-idempotent.json`, `job-cache-final-comparison.json`, 실패도 포함한 비교는 `job-cache-contention3.json`이다. 첫 두 반복의 동작 소스 SHA는 `d2ea78ec599509229ae37841999b7d7e4a885c11838fb681645274c0ccd85f51`이다.

### 회귀 경계

작업 관측/네이티브 bytes/4개 원천 가족/없는 키 추가/서버 ABA/저장 전 거부/자기 쓰기 후 다른 의존성 변경/다른 writer와 viewer/프레임 정리/동일 실제 classified Micro의 무재저장을 검사했다. flight 6건, Micro 원자 게시, 소비한 회상 본문·Head 변경, mid-publication 회상, owner read-frame ABA/oversized fallback, 32-key budget, GRADIA scan 경합, 기존 source-family/cache 검사를 합친 선택 회귀는 38/38 통과했다. 서버 writer 테스트의 내부 12 시나리오도 통과했다. 실제 RisuAI GUI/provider/다중 기기, 전체 릴리스 suite는 실행하지 않았다.

`libra_micro_state_admission_3mode_test.cjs:82`의 viewer 승인 표시는 여전히 실패한다: durable 승인 요약은 admitted 1/pending 2이나 viewer가 admitted 2/pending 1로 표시한다. 원본 `75b0859`를 harness에 직접 주입해 같은 실패를 재현했고, 이번 cache 변경의 신규 회귀로 분류하지 않았다. 테스트의 기대값은 변경하지 않았다. 이를 전체 State 회귀 통과라고 보고하지 않는다.
