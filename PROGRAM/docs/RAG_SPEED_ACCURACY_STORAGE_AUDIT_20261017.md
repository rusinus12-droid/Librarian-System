# RAG 속도·정확도 개선과 저장소 점검 (2026-10-17)

대상: LIBRA · HAYAKU · Flashback (플러그인 모드·서버 모드), LIA (플러그인 모드 RAG), GRADIA (플러그인 IPC·통합 엔진 RAG와 응답 반영).
측정은 모두 오프라인 합성 임베더(`tools/rag_eval/synthetic_embedder.cjs`)와 실제 플러그인·실제 서버(`server/server.cjs`, 임시 DATA) 기준이다. 실제 임베딩 제공자·실제 RisuAI 설치 측정이 아니다.

## 1. 요약

| 항목 | 변경 전 | 변경 후 |
| --- | --- | --- |
| LIBRA 회상 1회 (20턴, plugin_only) | 2,748ms | 약 270ms (런타임 색인) |
| LIBRA 회상 1회 (20턴, server_only) | 3,645ms · 서버 요청 913회 | 495ms · 239회 |
| LIBRA server_only, 레거시 모드 인자만 있는 스코프 | 통합 회상 예외(`HEALTH_LOCAL_MODE_REQUIRED`) | 정상 회상, 3-모드 결과 동일 |
| LIBRA 회상 중 백그라운드 쓰기 | `LIBRA_GRAPH_READER_BODY_CHANGED`로 회상 실패 | 새 일관 스냅샷으로 최대 2회 재읽기 |
| Flashback 정확도 (plugin_only) | 93.8% | 100% |
| Flashback 정확도 (server_only, 왕복 10ms, 최근 4턴만 전송) | 75~87.5% (회상 생략 발생) | 100% (가용률) |
| Flashback server_only 질문당 p50 (왕복 10ms) | 284ms | 약 240ms |

## 2. LIBRA

### 2.1 런타임 공통 색인 (속도)
영구 공통 색인은 GUI의 "전체 이력 인덱스 구축"을 눌러야만 만들어지고, 새 정본·Micro가 생기면 낡은 색인은 무시된다. 그래서 대화 중에는 거의 항상 매 회상마다 모든 owner 구간을 다시 열거·투영했다(`request_local_corpus`). 20턴에서 2.7초, 40턴에서 8.3초로 턴 수보다 빠르게 늘었다. 프로파일상 시간의 대부분은 그래프 ID용 SHA-256(회상 1회에 입력 34.5MB, 고유 문자열은 14.8MB)과 정규 JSON 직렬화였다.

변경:
- 색인 없이 회상했거나 Micro 기억이 새로 게시되면 1.5초 뒤 백그라운드에서 같은 공통 색인을 **메모리에만** 구축한다(`volatile_common_index`). 파생 페이지만 메모리에 두고, 원본 기록과 현재성 증명(`verifySourceProofs`)은 영구 색인과 같은 코드로 매 요청 저장소에서 검증한다.
- 저장소에 쓰지 않는다. plugin_only는 이전 세대 색인 페이지를 회수할 수 없어서(측정: 재구축 6회에 약 7.4M자 누적) 영구 색인을 자동 구축하지 않는다.
- owner 원본 쓰기(`fencedMemoryStorageSet/Remove`, 서버 통합 커밋)가 있으면 즉시 폐기하고 재구축을 예약한다. 구축 중 원본 쓰기가 있었다면 결과를 버린다.
- 회상 질의가 진행 중이면 구축이 양보하고 다시 예약된다. 명시적 영구 색인 구축은 진행 중인 런타임 구축을 먼저 멈춘다.
- 진단: `corpusRead.mode = 'volatile_common_index'`, 색인 없이 검색한 경우 `corpusRead.runtimeIndex = absent|building|stale`, 공개 API `inspectVolatileMemoryGraphCorpus()`.
- 한계: 새 턴 직후 백그라운드 구축이 끝나기 전의 첫 회상은 여전히 느리다. 질의가 1.5초보다 촘촘히 이어지면 구축이 계속 양보한다.

검증: `tests/libra_volatile_corpus_index_runtime_test.cjs` — 두 저장 모드에서 런타임 색인 결과가 요청 내 코퍼스·영구 색인과 같고, 저장소 쓰기가 없으며, 원본 쓰기 후 낡은 색인을 쓰지 않는다.

### 2.2 서버 모드 읽기 경로 버그 (정확도)
라우팅 행이 없고 레거시 인자 `memory_suite_server_mode=server_only`만 있는 스코프에서, 쓰기 경로(`readScopeModeValue`)는 서버를 쓰는데 owner 읽기 경로(`readReadonlyRoute`)는 로컬 기본값 증명만 허용해 통합 회상이 `HEALTH_LOCAL_MODE_REQUIRED`로 실패했다. owner 엔진 읽기는 이제 쓰기 경로와 같은 규칙으로 레거시 인자 모드를 관찰한다(외부 읽기 계약은 그대로). SDK 원본 `sdk/MemorySuiteStorageClient.libra.source.js`와 LIBRA 내장본을 함께 고쳤다.

### 2.3 찢어진 읽기 재시도
그래프 투영의 최종 재확인은 읽는 동안 바뀐 본문을 거부한다. 백그라운드 작업(예: 임베딩 상태 `pending → disabled`)이 겹치면 회상 전체가 실패했다. `BODY_CHANGED`/`LORE_CHANGED`일 때 새 스냅샷을 최대 2회 다시 읽는다. 계속 바뀌는 본문은 여전히 거부한다(`libra_memory_graph_reader_runtime_test` 갱신).

## 3. Flashback

- **회상 무효화 재시도**: manifest·worldline 저장은 진행 중인 회상을 취소한다. 이전 턴의 임베딩 큐가 다음 요청(특히 재생성) 중에 저장하면 회상이 기억 없이 끝났다. 서버 모드처럼 I/O가 느리면 자주 겹친다. 회상 준비 중 무효화(`FLASHBACK_RECALL_EXPIRED`)와 서버 연산 중 기준 변경(`FLASHBACK_SEARCH_BINDING_STALE`, 이전에는 요청 전체 오류)은, 새 요청·채팅 전환·설정 변경이 아닌 한 남은 제한시간 안에서 최대 2회 다시 준비한다.
- **백그라운드 쓰기 양보**: 임베딩 완료 저장과 예약된 에피소드 색인 재구축 저장은 같은 스코프의 회상이 진행 중이면 쓰기 잠금 안에서 최대 8초 기다린다. 회상과 요청 전달은 이 잠금을 쓰지 않는다.
- **서버 왕복 감소**: 검색 기준 확인(요청당 3회)의 채팅 스냅샷·manifest·worldline 읽기를 병렬화.
- **어휘 가중치 기본값 0.08 → 0.12**: 의미 점수에 더하는 키워드 신호 가중치. 0.12가 이 평가셋에서 100%가 되는 최솟값이다(0.15도 100%). 합성 임베더 기준이므로 실제 제공자로 다시 측정하기를 권한다.
- 평가 도구: `--server`(실제 서버·server_only 스코프), `RAG_EVAL_SERVER_RTT_MS`, `--visible N`(호스트가 최근 N턴만 전송; `availableRate`는 주입 또는 보이는 대화에 사실이 있으면 가용), 질문별 회상 생략 사유 표시.

| 조건 | 적중률 | 가용률 | p50 |
| --- | --- | --- | --- |
| plugin_only | 100% | 100% | 68ms |
| plugin_only, 최근 4턴 | 100% | 100% | 59ms |
| server_only, 최근 4턴 | 100% | 100% | 121ms |
| 임베딩 제공자 장애(키워드 대체) | 68.8% | 75% | 56ms |

제공자 장애 시 남는 실패는 겹치는 단어가 없는 바꿔 말하기라 키워드만으로는 찾을 수 없다.

## 4. HAYAKU · LIA · GRADIA

- **HAYAKU**: 저장 모드 패리티·서버 단독 복구 테스트 통과. 검색 커널은 단어+2글자 BM25만 쓴다. 한국어 기억/질문 75%, 실패는 모두 바꿔 말하기(p01, p05, m01, m04). 임베딩이 없으므로 100%에는 기록 작성 시 같은 언어의 동의어·바꿔 말하기 키워드를 `recallAliases`에 넣게 하는 지시가 필요하다. 실제 모델 출력으로 측정해야 하므로 이번에는 바꾸지 않았다.
- **LIA**: RAG는 로어북 재순위(희귀어 BM25F + 정확 앵커 + 보호 등급)다. `lia_world_lore_compute_pilot_test`, `lia_world_lore_compute_server_integration_test`, `lia_feature_parity_test` 통과. 남은 LIA 실패는 Chromium 실행기·릴리즈 산출물이 필요한 GUI 테스트다.
- **GRADIA**: 통합 엔진 경로는 실제 owner 근거 인용문이 모든 단계 프롬프트에 도달함을 검증하는 `libra_gradia_unified_pipeline_runtime_test`, 플러그인 IPC 경로는 `gradia_plugin_read_runtime_test`가 통과한다. 다중 소유자 근거 정렬 평가는 93.8%(p05). 이 경로는 소유자 기억 전체를 시간순으로 받아 BM25로만 재정렬하므로 단어가 겹치지 않는 질문은 구조적으로 찾지 못한다. 100%에는 소유자(Flashback·LIBRA)가 임베딩으로 매긴 순위를 IPC로 받아 쓰는 설계 변경이 필요하다. `gradia_three_owner_connection/pipeline` 테스트는 변경 전부터 `LIB_READ_UNIFIED_UNAVAILABLE`로 실패한다(기본 읽기 출처가 통합 엔진으로 바뀐 뒤 픽스처가 LIBRA IPC 제공자를 두지 않음).

## 5. 메모리 레인 · 인덱스 · 캐시 · 저장소 점검

- 영구 공통 색인: 수동 구축 시 정상(plugin_only 263ms, server_only 1,039ms). plugin_only에서는 매 구축이 전체 구축(재사용 0)이고 이전 페이지가 회수되지 않는다(GC 계약상 plugin_only 파괴적 GC 차단). 자동 구축하지 않은 이유다.
- 런타임 색인 결과 = 영구 색인 결과(두 모드).
- Flashback server_only: 로컬 스코프 키 0, 결과는 plugin_only와 같다. 질문당 서버 요청 약 27회(재시도 포함 시 증가)는 대부분 의도된 현재성 재확인이다.
- LIBRA server_only 회상: 회상 1회에 로컬 라우팅 레지스트리 약 270회, 리셋 선택값 약 230회 읽기(경로 현재성 확인). 호스트 IPC 비용이 큰 환경에서 다음 최적화 대상이다.

## 6. 회귀 결과

변경 전 원본(`HEAD`)과 같은 테스트 목록을 나란히 실행했다.

| 묶음 | 변경 전 | 변경 후 | 차이 |
| --- | --- | --- | --- |
| LIBRA 회상·그래프·통합·서버 (131 + 신규 1) | 101 통과 | 106 통과 | 통과로 바뀜: `libra_recall_3mode_parity`, `libra_unified_server_vector_v1`, `libra_unified_server_writer_v1`, `libra_phase_d_v5_server_only_outage_recovery`, 신규 `libra_volatile_corpus_index_runtime` |
| Flashback·회상·연산 (166) | — | 159 통과 | 남은 7개(`archive_owner_failure`, `bounded_diagnostics_artifact`, `multilingual_probe_wording`, `model_only_retrieval_runtime`, `scope_panels_browser`, `server_inspection_artifact`, `unchanged_reingest_preservation_runtime`)는 변경 전에도 실패. `raw_cow_append_runtime`은 통과로 바뀜 |

갱신한 테스트: `libra_memory_graph_reader_runtime_test`(1회 변경은 재읽기, 계속 변경은 거부), `libra_recall_3mode_parity_test`(코퍼스와 관련된 질의), `rag_eval_flashback_floor_test`(정상 100%, server_only 가용률 100%, 회상 생략 없음), 소스 문자열 치환 픽스처 2개(`flashback_append_cost_fixture`, `flashback_finish_attribution_fixture`)의 앵커.

Flashback 최종 확인 단계(준비 후 원본·URL·호스트 변경)는 재시도하지 않고 이전처럼 그 요청의 근거를 취소한다. 대신 백그라운드 임베딩 완료·에피소드 색인 재구축 저장이 같은 스코프의 회상이 끝날 때까지 쓰기 잠금 안에서 최대 8초 기다린다.

## 7. 실제 제공자 측정 (Voyage `voyage-4-large`, Ollama `deepseek-v4.1-flash:cloud`)

키는 환경 변수로만 넘겼고 저장소에는 들어가지 않는다. 평가 도구는 `tools/rag_eval/`에 있다.

| 대상 | 측정 | 변경 전 | 변경 후 |
| --- | --- | --- | --- |
| Flashback plugin_only | 실제 Voyage 임베딩, 질문 16개 적중률 | 93.8% | 100% |
| Flashback server_only (RTT 10ms) | 같은 조건 | 68.8% (회상 생략) | 100% |
| HAYAKU | 실제 LLM이 쓴 `recallAliases` + 실제 `localRecallRank` top-5 | 81.3% | 93.8% |
| LIBRA 커널 | Voyage 벡터 top-3 | — | 93.8% (섹션 벡터 추가 이득 없음) |
| LIBRA 종단 | 실제 LLM 추출(Micro+정규) + Voyage, 질문 16개 | 50% | 93.8% (2.3.156, 남은 1개도 내용은 전달) |
| LIBRA 종단 지연 | 30턴 실제 데이터 | — | 첫 회상 약 10~14s, 이후 p50 약 1.0s |
| GRADIA 근거 작성 | 실제 LLM 전 단계, 질문 5개 | — | 최종 응답 4/5 정답, 1개는 단계 모델 시간 초과(120s) |

- **Flashback**: 회상 준비 중 매니페스트·월드라인 저장이 회상 토큰을 취소해 생략되던 문제를 재시도 + 백그라운드 쓰기 양보로 해결했다(`lexical_weight` 기본 0.12).
- **HAYAKU**: 기록 지시에 같은 언어 바꿔 말하기 2-4개를 추가했다. 남은 실패 1개는 질문 어휘가 기록 어디에도 없는 경우다.
- **LIBRA**: 실제 30턴 데이터가 질의 자원 예산(64MiB)을 넘어 `RETAINED_BYTE_BUDGET`으로 실패했다. 질의 128MiB, 유지보수 192MiB로 올렸다(실측 약 62MiB). 미리보기 회상이 세션을 반납하지 않아 호출마다 약 15MB가 쌓이던 누수를 고쳤다. 정확도 개선은 7.1절에 정리했다(56.3% → 93.8%). 런타임 캐시에만 둔 Micro 벡터 시제품은 재시작 전후 패킷이 달라져(재시작 동일성 계약 위반) 저장 레코드 방식으로 다시 구현했다.
- **GRADIA**: 완료된 질문의 SHADOW 초안과 최종 응답이 LIBRA 근거의 사실(준호, 기록회, 공연실 등)을 그대로 썼다. 실패 2개는 약 170초에서 단계 모델 시간 초과였는데, fetch 중단 처리기가 실패 사유를 `LIB_READ_CANCELED`로 덮어써 원인이 가려졌다. 이미 실패한 실행은 원래 사유를 유지하도록 고쳤다(0.25.87).

### 7.1 LIBRA 2.3.156: Micro 의미 표현과 레인 예산

실제 데이터에서 남은 실패를 추적하니 원인이 세 겹이었다.

1. **Micro에는 저장된 의미 표현이 없었다.** 바꿔 말한 질문은 Micro 사실에 어휘로만 닿았다. 이제 Micro 출판 직후(또는 `retryPendingUnifiedVectors`) 각 Micro 출처의 주장 문장을 임베딩해 `micro-vector:<공간>:<본문 해시>` 키에 저장한다. 회상은 저장된 벡터를 읽기만 하고 문서를 임베딩하지 않으며(`libra_memory_graph_semantic_runtime_test`의 계약), 재시작 후에도 같은 패킷을 낸다(`libra_micro_representation_vectors_runtime_test`). 2.3.156은 질의 전에 별도 캐시에서 가장 가까운 8개를 골랐으나, 2.3.157은 이 선별을 제거해 회귀를 만들었다(아래 7.2). 2.3.158은 전체 후보의 코사인 비교와 top-8 선별을 복구하고, 선택된 실제 저장 키를 Memory Lane에서 재검증한다(7.3). 스코프 삭제는 접두사 삭제라 함께 지워지고, 저장 감사 허용 목록에 `micro-vector`를 추가했다. 출판 보고는 이 저장을 최대 15초 기다린다(느린 제공자는 보고만 늦춘다).
2. **레인 저장 예산이 벡터로 바닥났다.** 1024차원 벡터 하나가 약 22KB라 정규 10개 + Micro 몇 개만으로 기본 256KB를 넘어, 어휘가 겹치지 않는 질문은 항목 0개로 끝났다(p01, p04, p05, m04는 Micro 작업 전에도 0개). 의미 레인이 준비된 질의는 저장 예산을 `256KB + 3 × 표현 예산`(기본 1MiB), 페이지 128, 결과 512KB로 잡는다.
3. **의미로만 닿은 출처의 점수가 이름 일치보다 항상 낮았다.** 출처 접근 점수가 가중합의 의미 항(0.32)만 받아 코사인 0.75도 약 0.2였고, 이름이 겹친 항목(약 0.42)에 밀렸다. 어휘·개체 신호가 없는 출처 접근은 유사도 × 역할 가중치를 그대로 점수로 쓴다.

| 단계 | 적중률 | 이름·숫자 | 바꿔 말하기 | 혼합 |
| --- | --- | --- | --- | --- |
| 2.3.155 | 56.3% | 83% | 40% | 40% |
| + Micro 저장 벡터 | 62.5% | — | — | — |
| + 레인 예산 | 81.3% | 83% | 100% | 60% |
| + 출처 접근 점수 (2.3.156) | 93.8% | 100% | 100% | 80% |

남은 m01은 "조개 목걸이를 건넸"라는 문자열을 기대하지만 전달된 기억은 "작은 조개 목걸이를 당신이 소지하게 되었다"로, 사실은 전달됐다. 회상 p50은 약 0.77s에서 약 1.0s로 늘었다(더 큰 레인 예산과 Micro 선택).

### 7.2 LIBRA 2.3.157: 결함 보완과 함께 발생한 검색 회귀

이 버전은 검색 성능 회귀가 확인되어 병합 기준으로 삼을 수 없다. 아래 예산·현재성 검사는 통과했지만, 많은 벡터 중 후반부에 있는 의미상 정답을 찾는 회귀 검사가 누락됐다.

- 별도 숫자 벡터 캐시와 질의 전 top-8 선별을 제거했다. 조회는 Micro의 실제 영속 키·본문 해시·공간 해시·턴 정보만 Memory Lane에 넘기며, 선택된 페이지의 벡터는 정본과 같은 검증 읽기, I/O·디코딩·보관 예산, 공통 Cache Manager를 사용한다. 예산으로 탐색이 중단되면 미완료로 보고한다.
- Micro 저장 본문과 서버 revision을 최종 전달 및 보관한 응답 문맥의 검증 의존성에 포함한다. 삭제·변경·서버 ABA를 캐시된 숫자 배열로 대체할 수 없다. 256KiB 값 예산을 넘는 2MiB 벡터 레코드는 조회를 거부한다.
- 백그라운드 벡터 생성은 Micro가 없는 페이지도 건너뛰어 owner의 `microNextCursor`가 끝날 때까지 순회한다. 앞선 50턴에 Micro가 없어도 60턴의 정상 기억을 벡터화한다. 생성 작업도 maintenance 자원 관리와 스코프·복원 세대·설정 현재성 검사를 사용한다. 진단용 키 목록에는 숫자 배열을 저장하지 않는다.
- 런타임 인덱스는 구축 전체의 원본 증명이 변경되면 새 프레임에서 최대 2회 다시 구축한다. 명시적으로 중단된 구축을 실패로 집계하지 않는다. `sourceChangeRetries`로 재시도를 별도 표시한다.
- 최종 검증 중 읽기 집합이 취소되면 이미 거부된 `base_request_only` 결과를 그대로 반환한다. 닫힌 자원 세션에 표시 권한을 다시 보관하려다 예외를 내지 않으며, 취소된 근거에는 전달 권한을 부여하지 않는다. 명시적 취소·복원 세대 변경에 대한 거부는 유지한다.

회귀: `libra_micro_vector_authority_runtime_test`(플러그인·서버·미러의 삭제·변경·서버 ABA, 값/표현/레인 예산, 읽기 집합 취소, 60턴 Micro), `libra_memory_graph_semantic_test`(지연 읽기·저장 의존성; 검색 적중률 검증은 미포함), `libra_volatile_corpus_index_runtime_test`(두 모드의 전체 구축 재시도). 외부 제공자 적중률과 실제 RisuAI 지연은 이번 패치에서 재측정하지 않았다. 위 7.1 수치는 2.3.156 측정치다.

### 7.3 LIBRA 2.3.158: 정확 코사인 top-8 복구

기준 브랜치는 Claude `d335f1b`, 회귀를 도입한 후속 브랜치는 Codex `9d7eb4f`다. 2.3.157은 모든 Micro 참조를 등록 순서로 레인에 넣어, 1,024차원 30개 중 30번째만 정답인 경우 앞의 26개가 표현 예산을 소진했다. 벡터 기능을 삭제한 것은 아니지만 실질적인 의미 검색 능력을 떨어뜨렸다.

수정은 전체 적격 Micro 후보를 정확 코사인으로 비교한 뒤 상위 8개를 선별하는 2.3.156의 동작을 복구한다. 별도의 전체 숫자 배열 캐시는 만들지 않는다. 원본 읽기·단일 값·디코딩·최대 읽기 횟수는 기존 질의 자원 세션이 제한하고, 비교용 벡터는 한 번에 하나씩 보관한 후 해제한다. 상위 후보의 ID·점수·본문 digest만 남긴다. 이 원본 스캔 예산과 선택된 표현을 읽는 레인 예산은 별개이며, 둘 다 제한된다. 스캔 자원 예산을 초과하면 완전한 선별로 가장하지 않고 질의를 거부한다.

선택된 후보는 실제 저장 키로 다시 읽으며 선별 당시 digest와 비교한다. 이후 기존 원본 본문·서버 revision 검증을 유지하므로 삭제·변조·서버 ABA를 오래된 캐시로 통과시키지 않는다. 질의 임베딩은 선별과 레인이 같은 promise를 공유하며, 회상에서 문서 임베딩을 새로 만들지 않는다. 너무 작은 표현·레인 예산에서는 스캔과 모델 요청을 시작하지 않는다. 빈 Micro 구간 순회, 런타임 인덱스 재시도 등 2.3.157의 독립적인 수정은 유지한다.

| 통제된 엔진 회귀 사례 | 2.3.157 동작 | 2.3.158 동작 |
| --- | --- | --- |
| 30개 중 마지막 의미상 정답 검색 | 실패 | 성공 |
| 레인에 채택된 표현 | 26개 후 예산 중단 | 상위 8개 |
| 표현 예산 사용량 | 258,048 bytes | 92,160 bytes |
| 질의 임베딩 호출 | 1 | 1 |
| 저장 벡터 읽기 | 26 | 30개 비교 + 8개 재검증 |

이 표는 통제된 1,024차원 벡터 실험이다. 실제 Voyage/Ollama 정확도·속도 재측정 결과가 아니다. 원본 검증 스캔의 I/O 비용이 추가되므로 기존 7.1의 93.8%·p50 약 1.0초를 새 버전의 측정치로 인용하면 안 된다. 실제 모델 환경에서 같은 질문·데이터로 재측정해야 한다. 사용자가 제공자 인증을 제공했지만 현재 환경 프록시가 해당 도메인 접속을 403으로 차단한다. 비밀값은 저장소 밖에만 보관하며, 허용 도메인 설정 후 같은 데이터로 비교할 수 있다.

동일한 30개 Micro 저장 스냅샷을 이용한 plugin_only 종단 비교도 통과했다. 네 번의 조회에서 두 버전 모두 정답 패킷을 전달했다. 수정본 지연은 `[6589, 5680, 4006, 4085]ms`, Claude 기준은 `[4569, 4136, 4085, 4086]ms`였다. 첫 조회를 제외한 3회 중앙값은 각각 4085ms와 4086ms다. 합성 제공자 벡터·VM 호스트에서 단 한 차례 비교한 값이며, 최초 조회는 출판 직후와 재시작 직후로 준비 상태가 달라 직접적인 콜드 성능 비교로 해석하지 않는다. 실모델 성능 동등성을 입증하는 수치는 아니다.

검증 결과: 엔진 회귀 검사, native 30-source 비교, authority 6사례, semantic 9사례 및 semantic runtime 8사례, 재시작 2모드, 자원 관리 14사례, 조립·데이터 레이아웃 검사가 통과했다. 다중 턴 테스트의 초기 15초 출판 대기는 동시 부하에서 시간 초과가 발생해 이 대규모 fixture만 60초로 변경했고, 최종 실행에서는 출판과 정답 전달을 모두 검증했다. 제품의 시간 제한은 바꾸지 않았다.

회귀 검사는 `libra_micro_vector_ranking_regression_test.cjs`(후반 정답, 단일 질의 임베딩, 선택 후 본문 변경 거부), `libra_micro_vector_ranking_runtime_test.cjs`(실제 플러그인에서 30개 Micro 출판·정답 RAG 패킷 전달; `LIBRA_COMPARE_PLUGIN`으로 같은 저장 스냅샷의 이전 버전 비교), `libra_micro_vector_authority_runtime_test.cjs`(기존 권한/예산 검사), 기존 semantic/runtime/restart 검사로 구성한다.

## 8. 남은 과제

1. LIBRA: 평가 지표를 문자열 일치에서 정답 턴 기준으로 바꾸기. 늘어난 회상 지연(p50 약 1.0s) 줄이기. 출처 접근 점수 보정(`calibration: 'unmeasured'`)을 다른 임베딩 모델로도 측정.
2. GRADIA: 느린 클라우드 모델에서는 단계 시간 초과가 실제로 발생한다. 단계별 `timeout_ms`를 모델 지연에 맞게 잡아야 한다.
3. LIBRA 그래프 ID 해시 입력 축소(색인 세대 이전 계획 필요).
4. GRADIA 다중 소유자 경로에서 소유자 의미 순위 사용.
