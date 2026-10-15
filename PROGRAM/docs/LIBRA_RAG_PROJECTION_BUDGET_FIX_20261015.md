# LIBRA RAG의 projection 예산 결함 수정과 권장값

- 작성일: 2026-10-15 · 버전: 1.0
- 기준: `31b0a42` 이후 projection v2·v1 호환 읽기 수정
- 관련: [자원 계약](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md), [코퍼스 계약](LIBRA_DURABLE_CORPUS_INDEX_CONTRACT_20261014.md), [다음 과제](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)

## 1. 수정한 문제

정본 2개(본문 각각 약 32KB)를 `buildMemoryGraphCorpus({limit:1})`로 구축하면 조회가 전체 projection과 `windowSlices`를 한꺼번에 디코딩했다. JSON 작업 공간 예약이 82,279,432B로 기본 64MiB를 넘었고, Classic은 `injected:false`로 근거 없이 진행했다.

요청별·공유 예산의 기본값은 올리지 않았다. 새 게시물은 `libra.graph_corpus_projection.v2`를 사용한다.

- 조회용 graph의 nodes·edges·bases·units와 canonicalRows를 `pageBytes` 이하 JSON 배열 페이지로 나눈다. 대형 단일 행은 기존 chunk 계약으로 분할·검증·재조립한다.
- 구축용 `windowSlices`는 별도 build/window 디렉터리로 분리한다. 일반 질의는 이 이력을 읽지 않는다. 같은 내용의 페이지는 SHA-256 키로 중복 저장하지 않는다.
- 실제 읽은 페이지는 SHA·byte·행 수를 검증하고 공통 Cache Manager의 reserve/pin/decode/release와 요청 ledger를 거친다. 따로 전체 투영 cache를 만들지 않는다.
- 기존 v1 구축본은 전체 JSON 문법·digest를 검증한 뒤 필요한 top-level 필드만 디코딩한다. 미사용 이력은 객체로 만들지 않는다. 재구축 없이 같은 근거와 Classic 전달이 가능하다. v1의 큰 원본 문자열 전송 비용은 여전히 남으므로 새 페이지 형식은 명시적 재구축으로 사용한다.
- 증분 구축·전체 감사에서만 저장 이력을 연다. source proof·window stamp·원본 최종 검증과 root CAS는 유지한다.

projection 키는 기존 scope의 `memory-graph:v1:corpus:projection:<sha256>`를 사용한다. 작은 디렉터리·행 페이지·구축 이력이 모두 불변 참조다. 일반 조회 진단은 `corpusRead.storage.projection`에 별도 page/byte/cache hit와 `windowRecordsRead:0`을 기록한다. 이 접근은 query frame을 여는 graph snapshot 단계이며 Lane의 index/vector 접근 counter와 구분한다.

## 2. 게시·GC 호환성

실제 server GC와 root 게시 검사는 projection→행 페이지 및 build→window→행 페이지까지 전이 참조를 추적한다. 구축 이력도 현재 root가 참조하면 보존한다. 삭제 요청은 같은 writer transaction에서 현재 도달성을 재검사한다.

새 `libra-graph-projection-pages.v1` capability를 일반/core3 서버에 광고한다. LIBRA SDK는 이를 지원하지 않는 서버에 새 build lease를 요청하지 않고 `LIBRA_GRAPH_PROJECTION_UPGRADE_REQUIRED`로 거부한다. 구형 GC가 새 페이지를 orphan으로 지우는 배치를 방지하기 위한 것이다. 서버와 LIBRA를 함께 갱신한다. 기존 읽기·v1 지원과 GRADIA readonly SDK의 권한은 유지한다.

## 3. 측정과 해석

동일한 직교 벡터 2개 native RAG 회귀에서, 조회의 보수적 예약 추정은 다음과 같다.

| 항목 | 수정 전 | 새 페이지 형식 |
| --- | ---: | ---: |
| JSON 작업 공간 peak | 78.47MiB | 약 0.94MiB |
| 보유 추정 peak | 22.58MiB | 약 7.1MiB |
| durable payload 누적 | 약 2.95MiB | 약 0.55MiB |
| query의 구축 이력 읽기 | 전체 windowSlices 디코딩 | 0개 |
| 기본 Classic 근거 주입 | 실패 | 성공·최종 검증 verified |

`libra_memory_graph_vector_lane_runtime_test.cjs`는 기본 예산에서 의미 검색·미선택 vector body 읽기 0·v2 GC 보존·기존 v1의 같은 근거·Classic 전달까지 검사한다. v1 호환 query는 decode 16MiB/retained 32MiB 대조도 통과한다. corpus kernel은 미사용 이력 손상과 전체 감사, warm page 실제 재검증, v1의 생략된 JSON 문법 검사, 증분/전체 구축 동등성·checkpoint/CAS를 확인한다.

작업 공간·보유 값은 ledger의 보수적인 산식이며 실제 heap·브라우저 전체 사용량이 아니다. 모델과 호스트 경계는 통제된 fixture다. 실제 provider 품질·설치·일반 corpus 규모 인증으로 확대하지 않는다. 세부 규모 대조는 아래 측정 기록을 따른다.

### 규모·구축 방식 대조

같은 native fixture를 정본 1·2·4·8개(5·10·20·40턴)로 늘렸다. 모든 벡터가 같은 방향인 별도 비용 대조이며 앞의 직교 선택성 시험과 구분한다. [원시 측정 요약](measurements/LIBRA_RAG_PROJECTION_BUDGET_20261015.json)을 보관한다.

| 정본 | 구축 구간 | 기본 조회 decode/retained peak | 결과 |
| --- | ---: | ---: | --- |
| 1 | 1 | 0.83 / 6.12MiB | complete·발송 가능 |
| 2 | 1 | 0.93 / 7.04MiB | complete·Classic 주입·전체 감사 성공 |
| 4 | 20 | 1.44 / 8.82MiB | 검색·발송 가능, 기본 탐색 예산에서는 partial |
| 8 | 20 | 2.33 / 12.35MiB | 검색·Classic 주입 가능, 기본 탐색 예산에서는 partial |

각 query는 decode 16MiB/retained 32MiB 대조도 통과했다. 기본 구간 20의 구축 보유 peak는 정본 4개에서 13.55MiB, 8개에서 26.86MiB였다. 반면 구간 1의 순차 확장 구축은 4/8개에서 기본 retained 64MiB에 거부됐으며, 별도 8개 구간 1 구축은 retained 128MiB에서 peak 107.23MiB로 성공했다. fresh 구축과 이전 이력을 읽는 증분 구축의 비용은 다르다. 구간 1의 2개 정본 전체 감사도 peak 60.38MiB여서 유지보수에는 여유를 둔다.

query projection의 P1을 수정했어도 모든 구축·감사의 자료 크기가 64MiB 이내라는 보장은 없다. 실패 guard와 N01-b의 전체 자원 과제는 유지한다. `dispatch:true`와 전체 탐색 완료를 구분하고 partial은 그대로 보고한다.

## 4. 권장 예산

| 용도 | JSON decode | retained | 권장 운용 |
| --- | ---: | ---: | --- |
| 일반 RAG·Classic·GRADIA | **64MiB** | **64MiB** | 현재 기본값 유지. 재현 결함 때문에 상향할 필요 없음 |
| 메모리 여유가 적은 직접 query API | 16MiB | 32MiB | 측정한 작은 fixture에서 통과한 선택값. 실제 자료가 커지면 명시적 거부 가능 |
| 세밀한 구간 구축·전체 감사 | 64MiB부터 | **128MiB** | 구축의 보유 비용을 별도로 측정. 질의의 기본값을 같이 올리지 않음 |

일반 구축은 `limit:20`, `pageBytes:8192`를 권한다. `limit`는 owner 열거의 구간 크기이며 전체 이력을 최근 20턴으로 제한하는 검색 옵션이 아니다. `limit:1`은 세밀한 재개/회귀가 필요한 경우 사용하며 구간 수 증가에 따른 구축 비용을 확인한다. checkpoint의 전체 이력 표현·미등록 할당·전체 자원 상한은 N01-b에 남는다.

기타 기본 quota는 source 누적 64MiB, durable 누적 32MiB, 단일 값 8MiB, 읽기 8,192회다. 누적 I/O와 동시에 보유하는 메모리를 혼동하지 않는다. 일반 RAG 출력은 `unifiedMaxUnits:24`, `recallMaxChars:5000`을 시작값으로 권한다. 문자 수는 모델 token 수가 아니다.

검색 Lane의 기본은 논리 페이지 64개·256KiB이며 index/vector의 물리 저장 한도도 기본적으로 이를 따른다. 정본 8개 대조의 `lane_page_count_budget`는 RAM 부족과 별개였다. 128페이지·512KiB, 저장 128페이지·1MiB 대조도 발송 가능한 partial로 종료했다. 따라서 큰 RAM quota가 탐색 완료를 보장한다고 권하지 않는다. 더 넓은 탐색은 직접 query API에서 필요한 경우에만 늘리고 queryComplete·stopReason을 확인한다. 이 예산은 projection bootstrap의 누적 payload와 별도다.

공유 pool은 retained 256MiB·decode 128MiB·I/O 예약 32MiB다. 요청별 retained를 128MiB로 늘렸다고 여러 유지보수를 동시에 실행할 수 있는 것은 아니다. 구축·감사는 한 번에 하나씩 실행하고 Classic/GRADIA 문맥이 살아 있는 경우도 고려한다. Classic은 내부 기본 ledger를 사용하므로 직접 query API의 사용자 예산과 구분한다.

권장값은 실패 guard를 없애는 설정이 아니다. 더 큰 자료에서는 ledger의 실패 범주·peak·partial을 보고 범위를 조정한다. `byteBounded:false`, `ownerAtomicity:false`, `inventoryComplete:false`는 유지한다.


## 5. 회귀 검증

커널·독립 SQLite·SDK·core3·재개 영향권 48항목, native GC/현재성/자원/벡터 13항목, Classic·GRADIA·native semantic 소비자 10항목이 통과했다. 일부 파일은 내부 사례를 별도 집계한다. source plugin 빌드의 구문 검사와 SDK/내장 커널 동기화도 확인했다.

```bash
node --test PROGRAM/tests/libra_memory_graph_corpus_test.cjs PROGRAM/tests/libra_graph_lifecycle_sqlite_test.cjs PROGRAM/tests/libra_sdk_conditional_batch_v1_test.cjs
node --test PROGRAM/tests/libra_memory_graph_vector_lane_runtime_test.cjs PROGRAM/tests/libra_memory_graph_native_gc_runtime_test.cjs PROGRAM/tests/libra_memory_graph_incremental_currentness_runtime_test.cjs PROGRAM/tests/libra_memory_graph_resources_runtime_test.cjs
node --test PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs PROGRAM/tests/libra_memory_graph_semantic_runtime_test.cjs
```
