# LIBRA 원본·JSON·보유 데이터의 자원 예산 — N01-C1/C2

- 작성일: 2026-10-15 · 버전: 1.4
- 기준: `e542ce8` 이후 N01-C2 보유 예약·권한 수명·코퍼스 유지보수 증분
- 판정: **owner 본문 I/O·JSON 처리와 명시적으로 계상한 graph/index/표현/private 근거의 보유 예약·해제를 연결했다. 코퍼스 build/publication·eager audit도 같은 pool을 사용한다. 전체 원본/HTTP/VM 상한은 미완료다. `byteBounded:false`를 유지한다.**
- 관련: [전체 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [현황 §25](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), [남은 과제](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)

## 1. 실제 연결 경로

`libra_memory_graph_resources.cjs`를 LIBRA에 내장한다. engine runtime에 공유 admission pool 하나를 만들고 각 통합 질의는 별도 ledger를 연다. 요청별 scope 복사본과 private WeakMap으로 reader에 전달하며 현재 요청을 전역 변수로 바꾸지 않는다. payload를 별도 cache로 보관하거나 원본 소유권을 가져오지 않는다. JSON 크기·token preflight·workspace 산식은 기존 공통 page 계층의 `measure/encodedSize/stageCost`를 사용한다. Cache Manager의 page reserve/pin/release와 Memory Lane의 예산도 유지한다.

실제 적용 범위는 다음과 같다.

- native scope가 결속된 manifest·정본·검증된 Micro/State·정정/세계선·로어 링크 reader의 저장 본문 읽기와 parse/clone. 정본 source evidence도 같은 scope reader를 사용한다.
- corpus root/manifest/proof/projection·선택한 저장 page의 본문 I/O. JSON record parse와 분할 행의 결합/재조립도 workspace admission을 통과한다. 인덱스 page 자체의 decode는 기존 Cache Manager가 관리한다.
- source baseline/최종 물리 읽기 및 정본 벡터 record의 저장 접근. embedding provider의 요청 예산은 기존 semantic ledger가 담당한다.
- LIBRA SDK 변형의 `captureConditionalReadSet/assertConditionalReadSet`에 private `readObserver`를 전달한다. observer는 실제 remoteGet 전에 lease를 예약하고, 받은 row의 value를 검사한 뒤 SDK의 실제 revision/digest/ABA 검증을 실행한다. validation을 observer의 반환값으로 대체하지 않는다. 실패·SDK 거부·취소에도 `finally`로 workspace/I/O lease를 해제한다.

GRADIA·LIA·RETRACE의 고정 SDK는 유지한다. source observer는 LIBRA 변형에만 추가했으며 서버 쓰기 API·승인·scope/route·data/reset·최종 private Compiler 권한을 변경하지 않는다. Classic·GUI·GRADIA가 사용하는 실제 owner query에 기본값으로 적용된다. GUI에 새 승인/선택 절차를 추가하지 않는다.

## 2. 예산과 실행

등록 API `executeMemoryGraphUnifiedQuery()`, `buildMemoryGraphCorpus()`, `verifyMemoryGraphCorpus()`는 선택적인 `resourceBudget`을 받는다. 각 값은 양의 정수이고, 알 수 없는 설정은 거부한다.

| 요청 설정 | 기본값 | 의미 |
| --- | --- | --- |
| `maxSourceBytes` | 64 MiB | 관찰·수용한 원본 value payload의 누적 UTF-8 byte |
| `maxDurableBytes` | 32 MiB | 관찰·수용한 파생 저장 value payload의 누적 UTF-8 byte |
| `maxValueBytes` | 8 MiB | 한 읽기의 수용 payload 및 읽기 전 예약의 상한 |
| `maxDecodeBytes` | 64 MiB | 요청의 동시에 예약한 JSON 처리 workspace 추정 byte |
| `maxRetainedBytes` | 64 MiB | 명시적 retained lease의 동시 보유 추정 byte |
| `maxReads` | 8,192 | budget 계층의 owner load 호출 수 |

byte 설정은 최대 256 MiB, 읽기 수는 최대 65,536이다. `maxValueBytes`는 공유 I/O pool의 32 MiB를 넘을 수 없다. 공유 pool은 I/O 예약 32 MiB, JSON workspace 추정 128 MiB, pending read 8개, retained 추정 256 MiB, 활성 resource session 32개다. session은 생성 후 10분에 만료한다. 이 값은 실사용 성능 인증값이 아닌 초기 admission profile이다. 기본 8 MiB를 예약하는 read 네 개면 32 MiB가 차므로 다섯 번째는 거부될 수 있다.

읽기 전에 해당 누적 예산의 남은 분량과 `maxValueBytes` 중 작은 값을 예약한다. pending read가 이미 예약한 누적 분량도 공제해 동시에 같은 quota를 소비하지 못하게 한다. shared pool이 부족하면 기다림 없이 `IO_BACKPRESSURE`로 거부한다. 받은 value가 cap보다 크면 수용·owner JSON 처리 전에 거부한다. source/durable 누적 byte와 read 수는 같은 요청의 최종 현재성 재검증에도 이어서 적용된다.

UTF-8 문자열 value는 문자열 바깥에 JSON 따옴표를 더해 계상하지 않는다. object value는 JSON payload 크기를 재고, 없는 value는 0이다. 같은 본문을 다시 읽은 횟수도 누적한다. 이는 SDK가 넘긴 value payload의 크기이며 HTTP envelope·header·실제 네트워크 전송량과 다르다.

JSON record를 처리할 때는 encoded text의 byte/code unit/token 상한으로 workspace를 먼저 예약한다. 요청 또는 shared pool이 부족하면 `JSON.parse`/해당 callback을 실행하지 않는다. 분할 행은 결합 작업과 재조립한 JSON 처리에도 예약을 적용한다. 이 계상은 보수적 workspace 산식이며 실제 heap 관측값이 아니다.

## 3. 실패·취소·최종 권한

`SOURCE_BYTE_BUDGET`, `DURABLE_BYTE_BUDGET`, `VALUE_BYTE_BUDGET`, `READ_COUNT_BUDGET`, `DECODE_WORKSPACE_BUDGET`, `DECODE_BACKPRESSURE`, `IO_BACKPRESSURE`는 `LIBRA_GRAPH_RESOURCE_` 접두사로 보고한다. 일부 reader가 오류를 unavailable/pending으로 변환하더라도 예산 실패는 ledger에 남는다. native 경계와 semantic 호출 전·결과 반환 전에 재확인해 실패한 요청이 다른 검색이나 전달 가능한 partial로 바뀌지 않게 한다.

API query는 거부된다. 일반 Classic의 기존 실패 계약은 base request 유지이며 GRADIA의 해당 근거/초안은 최종 검증 실패로 차단한다. 뒤늦은 응답과 취소/restore/store serial 변경은 결과로 채택하지 않는다. 모든 lease는 실패 경로에서도 해제된다. 한 요청의 quota 실패가 다른 요청의 ledger를 오염시키지 않으며, pending lease가 정리되면 shared pool을 새 요청이 다시 사용할 수 있다.

ledger는 raw body나 모델 전달 권한을 보관하지 않는다. private owner verifier가 유지하는 동안 같은 요청의 누적 한도는 재검증에도 적용된다. 공개 trace/DTO의 복사본은 기존과 같이 private 권한이 아니다.

## 4. 관찰과 미측정 범위

`diagnostics.resourceAccess`와 `accessTrace.resources`는 `libra.graph_resource_access.v2`을 보고한다. snapshot은 API query가 초기 dispatch 검증을 마친 시점이다. 이후 Classic/GRADIA의 최종 handoff 재검증 비용까지 소급해 완료 계측이라고 부르지 않는다.

| 값 | 정확한 의미 |
| --- | --- |
| `sourceBytes/durableBytes` | 성공적으로 수용한 value의 누적 byte. 반복 읽기 포함 |
| `reads` | budget 계층의 owner load 호출 수. 내부 transport 재시도/route bootstrap HTTP 횟수는 미측정 |
| `reservedIoBytes/peakReservedIoBytes` | 현재/최대 payload allowance 예약. 실제 transport buffer가 아님 |
| `decodeBytes/peakDecodeBytes` | 현재/최대 JSON workspace 예약 추정. 실제 heap이 아님 |
| `inFlightReads/peakInFlightReads` | 현재/최대 해당 요청의 pending read |
| `rejectedPayloadLowerBoundBytes` | cap 초과를 확인하며 센 거부 payload byte의 하한. 전체 응답 크기는 아닐 수 있음 |
| `retainedBytes/peakRetainedBytes`, `retainedLeases`, `retainedByCategory` | 명시적 보유 예약의 현재값·peak·lease 수·범주별 합. 실측 heap이 아님 |
| `closed/closeReason/activities` | 권한 종료와 아직 unwind 중인 작업. 종료된 작업의 예약도 active 작업이 끝나기 전까지 유지될 수 있음 |
| `pool` | runtime 공유 pool의 현재값·runtime 누적 peak·한도 |
| `failure` | 해당 ledger의 terminal 예산 실패 사유 |

Lane의 저장 page byte와 여기의 durable byte는 일부 동일 접근을 측정하므로 합산하지 않는다. Compiler의 기존 전체 `source_read_json/owner_io_in_flight/write_barrier` 계측이 완성됐다고 바꾸지 않는다. 실제로 모르는 값은 기존처럼 null·missingMeasurements다.

이번 증분의 미측정·미보장 범위는 명시적으로 남긴다.

- budget scope를 결속하기 전의 native context/readonly capture·route bootstrap, 호스트 chat/lore/settings 자체의 전송/할당과 외부 readonly permission witness.
- HTTP body/envelope parsing, transport buffer 및 스트리밍. 현재 host/SDK는 value 전체를 받은 뒤 크기를 알 수 있다. 예약보다 큰 응답이 host 내부에 먼저 할당되는 것을 막는 프로토콜은 아직 없다.
- 명시적 예약 밖의 할당, hash/serialization scratch, 호스트/SDK cache, 전체 VM heap. 검사 전 이미 호출자가 만든 query DTO, 호스트 원본과 JSON 직렬화의 선행 할당도 물리적으로 제한하지 않는다. 명시적 retained 추정을 전수 heap 계측으로 승격하지 않는다.
- 진단용 단일 구간 `buildMemoryGraphGeneration`/page inspector는 기존 Store/Page 자체 예산을 유지하며, 이번 코퍼스 유지보수 ledger가 전부 연결된 경로가 아니다.
- shared page-cache workspace와 이 admission pool의 합을 포함한 전체 memory ceiling, 지원 corpus·동시성별 실제 품질/규모·설치 호스트 인증.

**N01-C2는 아래 명시적 할당·수명 경로에 연결했다.** owner의 bounded response/stream protocol, 미등록 할당과 전체 지원 profile 상한은 별도의 증명이 필요하다. `byteBounded:false`, `ownerAtomicity:false`, `inventoryComplete:false`는 유지한다.

## 5. 검증 근거

새 순수 suite는 UTF-8/누적·분리 계상, 수용 전 초과 거부, read quota 사전 중단, dense JSON preflight, 동시 I/O·workspace backpressure, 중복 quota 사용 금지, 취소/late 응답·callback 실패 해제, 실패 latch를 검사한다.

등록 native suite는 plugin_only/server_only/mirror에서 저장 corpus를 검색한다. source/durable/read/decode 예산을 각각 낮추면 거부하고, 정상 예산의 재실행은 같은 bundle을 반환한다. 원본 쓰기·문서/응답 provider 호출·서버 batch 증가가 없다. 네 query를 실제 root 읽기에서 대기시켜 추가 query가 shared admission으로 거부되는지 확인하고, 취소 후 이전 query가 전부 거부되며 새 query의 pool 현재값은 0인지 검사한다. 큰 Micro 본문 오류가 reader의 catch에 가려지지 않는 음성 대조도 포함한다.

SDK suite는 실제 HTTP/SQLite의 read observer 예약·해제와 기존 route/revision/digest/ABA 거부를 확인한다. native semantic·corpus·replacement·GRADIA의 기존 통합 suite도 별도로 확인한다. 제어된 fixture이며 실제 RisuAI 설치/외부 모델 품질/네트워크 peak heap 인증이 아니다.

```bash
node --test PROGRAM/tests/libra_memory_graph_resources_test.cjs PROGRAM/tests/libra_memory_graph_resources_runtime_test.cjs
node --test PROGRAM/tests/libra_sdk_conditional_batch_v1_test.cjs PROGRAM/tests/libra_memory_graph_corpus_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_corpus_test.cjs PROGRAM/tests/libra_memory_graph_selective_index_test.cjs
node --test PROGRAM/tests/libra_unified_search_replacement_runtime_test.cjs PROGRAM/tests/libra_memory_graph_semantic_runtime_test.cjs
node --test PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs
```

## 6. N01-C2의 보유 예약과 수명

보유 회계는 I/O allowance·JSON workspace와 구분한다. `retain(value,label,copies)`는 공통 `measure/encodedSize`의 UTF-16 code unit·JSON 값/token 수를 이용해 `(4096 + codeUnits × 2 + tokens × 64) × copies`를 예약한다. `reserveRetained(bytes,label)`는 이미 정한 표현 allowance 등을 예약한다. 이 산식은 초기 회계 profile이며 엔진별 객체 overhead를 실측해 증명한 값이 아니다. 반복 참조·복사까지 보수적으로 중복 계상할 수 있다. JSON workspace의 더 큰 `stageCost` 산식을 보유 heap 값으로 재사용하지 않는다.

실제 예약 지점은 다음과 같다.

- native projection의 원본 묶음 → graph 생성·복사, cold merged graph, durable proof/projection의 decode 전 encoded 내용.
- query 신호의 native JSON 변환, portable vector hydration 전 allowance와 hydrated readback, semantic representation allowance, owner lookup Map와 pinned source/conditional readset.
- index compile 전 입력 allowance 및 생성한 table, eligibility view, 선택 작업, compiler private readset과 발급 packet. 일부 생성 결과의 계상은 생성 후 공개/보관 전에 이루어지므로 임시 할당 전부를 사전 차단하지는 않는다.
- 선택적 index page를 모으는 동안의 행과 split 재조립 결과. index page 생성 소비가 끝나면 해당 scope를 닫는다. Cache Manager/Lane의 기존 별도 예산을 대체하지 않는다.
- 코퍼스 build/publication의 graph/index·checkpoint/proof/projection/manifest 직렬화 입력·서버 publication batch, eager audit. 정상·실패·취소의 `finally`에서 유지보수 session을 닫는다. 각 명시적 할당·쓰기 준비 전에 예산을 검사하며 원본이나 다른 검색기로 우회하지 않는다. 이미 쓴 immutable 파생 페이지는 남을 수 있다. root 게시 후 readback의 I/O 한도가 소진되면 이미 게시한 root를 되돌렸다고 보고하지 않는다. publication의 기존 CAS/readback 보장과 비용 계상은 별개다.

`RETAINED_BYTE_BUDGET`, `RETAINED_VALUE_BUDGET`, `RETAINED_BACKPRESSURE`, `SESSION_BACKPRESSURE`도 terminal resource 실패다. 공개 trace는 DTO이고, `inspectMemoryGraphStore().resources`는 현시점 pool 진단이다.

권한별 해제는 다음과 같다.

| 수명 | 해제 경계 |
| --- | --- |
| 공개 query API/GUI 검색 | DTO 복사 또는 검색 metadata 추출 후 private 실행 해제 |
| Classic | 실패·supersession은 미전달 실행 해제, 성공은 UI 검증 문맥으로 이전. 4개 graph 문맥 또는 전체 256개 token 축출 때 해제 |
| GRADIA 셰도우/AIDE·작성기 | receipt release·취소·연결 해제·owner dispose·현재성 실패·10분 만료. query가 취소 뒤 늦게 끝나도 그 실행을 해제 |
| compiler/restore/store serial 무효화 | `invalidateAll`은 발급한 readset의 session·packet·native authority를 폐기. 명시적 취소/unload는 미발급 session도 종료 |
| 반복/동시 최종 검증 | 호출마다 별도 scope. 검증용 재투영은 해당 scope에 예약하며 `finally`에서 해제 |

종료는 즉시 권한을 취소하지만 실행 중인 query·검증·유지보수가 아직 값을 참조하면 보유 예약을 유지한다. 그 작업의 activity가 끝나야 최종 drain한다. 실제 pending I/O·JSON workspace 역시 실제 `finally` 전에는 반환하지 않는다. 타이머 종료를 강제 GC나 transport abort로 해석하지 않는다.

검증은 retained 공유 한도·실패 latch·idempotent release·session 제한·만료/무효화 중 active 작업·겹친 validation scope를 포함한다. native 3모드의 정상·낮은 retained 예산, 공개 DTO 후 pool 0, 코퍼스 build/eager audit 실패 후 root 보존·pool 0, Classic 5개 요청의 4개 문맥 제한·축출된 context 거부·예약 해제, 실제 owner receipt의 반복 검증·동시 session 거부·release/dispose/무효화 후 pool 0을 검사한다. GRADIA의 취소 후 late query·응답 예산 실패·만료도 release callback까지 확인한다. 실제 설치 호스트의 heap/규모 인증은 별도다.

## 7. 저장 접근 continuation의 별도 수명

storage budget stop은 요청 scope를 항상 닫는다. 요청을 넘겨 보존할 재조립 행/조각은 corpus runtime의 private 일회용 staging에만 넣는다. 별도 ledger로 공통 pool에 예약하며 원본/권한 cache로 사용하지 않는다. 기본 수명 60초, 최대 16건, 건당 retained 추정 16MiB·전체 64MiB다. count/byte/pool 정원이 부족하면 저장하지 않고 거부한다.

완료·소비·만료·취소/unload·실패 시 staging ledger를 해제한다. claim은 await 전에 일회용으로 소비하며 replay/동시 재개를 거부한다. 잘못된 다른 query/view/access cursor는 정상 lease를 소비하지 않는다. `inspectMemoryGraphStore().corpus.storageStaging`은 현재 개수·계상 byte·한도를 보고한다. partial 공개 반환 뒤 공통 pool에는 이 reachable staging만 남을 수 있으며, 성공적으로 끝난 일반 공개 질의는 기존처럼 private authority를 유지하지 않는다.

회귀: `libra_memory_graph_review_f8_runtime_test.cjs`의 세 저장 모드 공개 API 재개·완료/취소 해제·결속·만료·후속 실패, `libra_memory_graph_selective_index_test.cjs`의 독립 reader 재개·정원·만료·root/재시작 거부. 추정 예약이며 물리 heap 상한 인증은 아니다.

## 8. 선택적 벡터 페이지와 서버 사용권

정본 global vector의 파생 불변 페이지가 공통 cache staging/pin/decode 및 요청별 durable/source/retained admission을 사용한다. 의미 접근은 Lane의 같은 storage 예산에 참여한다. 원본 벡터 최종 검증과 과거 형식의 owner record 접근은 source 예산으로 별도 계상한다. query가 문서 임베딩이나 durable index를 자동 생성하지 않는다.

server_only의 private query·Classic context·GRADIA receipt와 build 수명은 서버의 영속 lease에 연결한다. 종료/실패/취소/dispose에서 해제하며 연결 단절/응답 손실은 서버 만료로 정리한다. 이는 owner bookkeeping 쓰기다. source 불변성과 readonly consumer 권한은 유지한다. 지원 모드/명시적 큰 합성 profile과 전체 상한 미완료 범위는 [구현 계약](LIBRA_SELECTIVE_VECTOR_AND_NATIVE_GC_CONTRACT_20261015.md)을 따른다.


## 9. projection v2·기존 v1의 기본 RAG 예산 수정

`31b0a42` 이후 조회용 graph/canonicalRows를 공통 캐시의 행 페이지로 분할하고 구축 이력을 별도 디렉터리에 보관한다. query는 windowSlices를 열지 않으며 기존 v1도 미사용 이력을 디코딩하지 않는다. 기본 source/durable/decode/retained quota는 유지한다. [projection 예산 수정·권장값](LIBRA_RAG_PROJECTION_BUDGET_FIX_20261015.md)의 구현·측정·지원 한계와 일반 query 64/64MiB·구축 구간 20 권장을 따른다. projection bootstrap은 Lane의 index/vector page budget과 다른 단계이며 같은 resource ledger에 계상한다.
