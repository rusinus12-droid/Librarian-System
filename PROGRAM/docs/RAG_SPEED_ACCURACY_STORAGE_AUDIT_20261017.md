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
| LIBRA 종단 | 실제 LLM 추출(Micro+정규) + Voyage, 질문 16개 | 50% | 56.3% (Micro 의미 표현 시제품 62.5%, 미포함) |
| LIBRA 종단 지연 | 30턴 실제 데이터 | — | 첫 회상 13.9s, 이후 p50 0.76s |
| GRADIA 근거 작성 | 실제 LLM 전 단계, 질문 5개 | — | 완료된 질문은 모두 정답, 2개는 단계 모델 시간 초과 |

- **Flashback**: 회상 준비 중 매니페스트·월드라인 저장이 회상 토큰을 취소해 생략되던 문제를 재시도 + 백그라운드 쓰기 양보로 해결했다(`lexical_weight` 기본 0.12).
- **HAYAKU**: 기록 지시에 같은 언어 바꿔 말하기 2-4개를 추가했다. 남은 실패 1개는 질문 어휘가 기록 어디에도 없는 경우다.
- **LIBRA**: 실제 30턴 데이터가 질의 자원 예산(64MiB)을 넘어 `RETAINED_BYTE_BUDGET`으로 실패했다. 질의 128MiB, 유지보수 192MiB로 올렸다(실측 약 62MiB). 미리보기 회상이 세션을 반납하지 않아 호출마다 약 15MB가 쌓이던 누수를 고쳤다. Micro 기억은 저장된 의미 표현이 없어 바꿔 말한 질문은 어휘로만 닿는다. Micro 문장 벡터를 런타임 캐시에 두고 의미 레인의 추가 표현으로 넣는 시제품은 62.5%까지 올렸지만, 캐시가 프로세스 안에만 있어 재시작 전후 같은 질의의 패킷이 달라진다(`libra_memory_graph_semantic_runtime_test`의 재시작 동일성 계약 위반). 그래서 이번 변경에서 뺐고, 정규 기억처럼 쓰기 시점에 Micro 벡터를 저장하는 설계로 다시 넣어야 한다. 시제품 기준 남은 실패 6개 중 2개(n03, p01)는 내용은 전달됐지만 표현이 바뀌어 문자열 일치 지표가 놓친 경우이고, 4개(p04, p05, m01, m04)는 Micro에 사실이 있으나 순위에 들지 못했다.
- **GRADIA**: 완료된 질문의 SHADOW 초안과 최종 응답이 LIBRA 근거의 사실(준호, 기록회, 공연실 등)을 그대로 썼다. 실패 2개는 약 170초에서 단계 모델 시간 초과였는데, fetch 중단 처리기가 실패 사유를 `LIB_READ_CANCELED`로 덮어써 원인이 가려졌다. 이미 실패한 실행은 원래 사유를 유지하도록 고쳤다(0.25.87).

## 8. 남은 과제

1. LIBRA: Micro 벡터를 쓰기 시점에 저장(정규 기억의 임베딩 큐와 같은 방식)해 의미 레인에 넣기. 그 뒤에도 남는 질문(p04, p05, m01, m04)에는 질의 확장 또는 Micro·정규 순위 융합이 후보다. 문자열 일치 대신 정답 턴 기준 지표도 필요하다.
2. GRADIA: 느린 클라우드 모델에서는 단계 시간 초과가 실제로 발생한다. 단계별 `timeout_ms`를 모델 지연에 맞게 잡아야 한다.
3. LIBRA 그래프 ID 해시 입력 축소(색인 세대 이전 계획 필요).
4. GRADIA 다중 소유자 경로에서 소유자 의미 순위 사용.
