# LIBRA 원본·저장 읽기와 JSON 작업공간 예산 — N01-C1

- 작성일: 2026-10-15 · 버전: 1.0
- 기준: `dbb6f21` 이후 N01-C의 첫 증분
- 판정: **관찰한 owner 본문 읽기와 일시적 JSON 처리에 실제 admission·계측·공유 예약·해제를 연결했다. 전체 원본/HTTP/VM 및 장기 보유 데이터의 자원 상한은 미완료다. `byteBounded:false`를 유지한다.**
- 관련: [전체 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [현황 §24](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), [남은 과제](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)

## 1. 실제 연결 경로

`libra_memory_graph_resources.cjs`를 LIBRA에 내장한다. engine runtime에 공유 admission pool 하나를 만들고 각 통합 질의는 별도 ledger를 연다. 요청별 scope 복사본과 private WeakMap으로 reader에 전달하며 현재 요청을 전역 변수로 바꾸지 않는다. payload를 별도 cache로 보관하거나 원본 소유권을 가져오지 않는다. JSON 크기·token preflight·workspace 산식은 기존 공통 page 계층의 `measure/encodedSize/stageCost`를 사용한다. Cache Manager의 page reserve/pin/release와 Memory Lane의 예산도 유지한다.

실제 적용 범위는 다음과 같다.

- native scope가 결속된 manifest·정본·검증된 Micro/State·정정/세계선·로어 링크 reader의 저장 본문 읽기와 parse/clone. 정본 source evidence도 같은 scope reader를 사용한다.
- corpus root/manifest/proof/projection·선택한 저장 page의 본문 I/O. JSON record parse와 분할 행의 결합/재조립도 workspace admission을 통과한다. 인덱스 page 자체의 decode는 기존 Cache Manager가 관리한다.
- source baseline/최종 물리 읽기 및 정본 벡터 record의 저장 접근. embedding provider의 요청 예산은 기존 semantic ledger가 담당한다.
- LIBRA SDK 변형의 `captureConditionalReadSet/assertConditionalReadSet`에 private `readObserver`를 전달한다. observer는 실제 remoteGet 전에 lease를 예약하고, 받은 row의 value를 검사한 뒤 SDK의 실제 revision/digest/ABA 검증을 실행한다. validation을 observer의 반환값으로 대체하지 않는다. 실패·SDK 거부·취소에도 `finally`로 workspace/I/O lease를 해제한다.

GRADIA·LIA·RETRACE의 고정 SDK는 유지한다. source observer는 LIBRA 변형에만 추가했으며 서버 쓰기 API·승인·scope/route·data/reset·최종 private Compiler 권한을 변경하지 않는다. Classic·GUI·GRADIA가 사용하는 실제 owner query에 기본값으로 적용된다. GUI에 새 승인/선택 절차를 추가하지 않는다.

## 2. 예산과 실행

등록 API `executeMemoryGraphUnifiedQuery()`는 선택적인 `resourceBudget`을 받는다. 각 값은 양의 정수이고, 알 수 없는 설정은 거부한다.

| 요청 설정 | 기본값 | 의미 |
| --- | --- | --- |
| `maxSourceBytes` | 64 MiB | 관찰·수용한 원본 value payload의 누적 UTF-8 byte |
| `maxDurableBytes` | 32 MiB | 관찰·수용한 파생 저장 value payload의 누적 UTF-8 byte |
| `maxValueBytes` | 8 MiB | 한 읽기의 수용 payload 및 읽기 전 예약의 상한 |
| `maxDecodeBytes` | 64 MiB | 요청의 동시에 예약한 JSON 처리 workspace 추정 byte |
| `maxReads` | 8,192 | budget 계층의 owner load 호출 수 |

byte 설정은 최대 256 MiB, 읽기 수는 최대 65,536이다. `maxValueBytes`는 공유 I/O pool의 32 MiB를 넘을 수 없다. 공유 pool은 I/O 예약 32 MiB, JSON workspace 추정 128 MiB, pending read 8개다. 이 값은 실사용 성능 인증값이 아닌 초기 admission profile이다. 기본 8 MiB를 예약하는 read 네 개면 32 MiB가 차므로 다섯 번째는 거부될 수 있다.

읽기 전에 해당 누적 예산의 남은 분량과 `maxValueBytes` 중 작은 값을 예약한다. pending read가 이미 예약한 누적 분량도 공제해 동시에 같은 quota를 소비하지 못하게 한다. shared pool이 부족하면 기다림 없이 `IO_BACKPRESSURE`로 거부한다. 받은 value가 cap보다 크면 수용·owner JSON 처리 전에 거부한다. source/durable 누적 byte와 read 수는 같은 요청의 최종 현재성 재검증에도 이어서 적용된다.

UTF-8 문자열 value는 문자열 바깥에 JSON 따옴표를 더해 계상하지 않는다. object value는 JSON payload 크기를 재고, 없는 value는 0이다. 같은 본문을 다시 읽은 횟수도 누적한다. 이는 SDK가 넘긴 value payload의 크기이며 HTTP envelope·header·실제 네트워크 전송량과 다르다.

JSON record를 처리할 때는 encoded text의 byte/code unit/token 상한으로 workspace를 먼저 예약한다. 요청 또는 shared pool이 부족하면 `JSON.parse`/해당 callback을 실행하지 않는다. 분할 행은 결합 작업과 재조립한 JSON 처리에도 예약을 적용한다. 이 계상은 보수적 workspace 산식이며 실제 heap 관측값이 아니다.

## 3. 실패·취소·최종 권한

`SOURCE_BYTE_BUDGET`, `DURABLE_BYTE_BUDGET`, `VALUE_BYTE_BUDGET`, `READ_COUNT_BUDGET`, `DECODE_WORKSPACE_BUDGET`, `DECODE_BACKPRESSURE`, `IO_BACKPRESSURE`는 `LIBRA_GRAPH_RESOURCE_` 접두사로 보고한다. 일부 reader가 오류를 unavailable/pending으로 변환하더라도 예산 실패는 ledger에 남는다. native 경계와 semantic 호출 전·결과 반환 전에 재확인해 실패한 요청이 다른 검색이나 전달 가능한 partial로 바뀌지 않게 한다.

API query는 거부된다. 일반 Classic의 기존 실패 계약은 base request 유지이며 GRADIA의 해당 근거/초안은 최종 검증 실패로 차단한다. 뒤늦은 응답과 취소/restore/store serial 변경은 결과로 채택하지 않는다. 모든 lease는 실패 경로에서도 해제된다. 한 요청의 quota 실패가 다른 요청의 ledger를 오염시키지 않으며, pending lease가 정리되면 shared pool을 새 요청이 다시 사용할 수 있다.

ledger는 raw body나 모델 전달 권한을 보관하지 않는다. private owner verifier가 유지하는 동안 같은 요청의 누적 한도는 재검증에도 적용된다. 공개 trace/DTO의 복사본은 기존과 같이 private 권한이 아니다.

## 4. 관찰과 미측정 범위

`diagnostics.resourceAccess`와 `accessTrace.resources`는 `libra.graph_resource_access.v1`을 보고한다. snapshot은 API query가 초기 dispatch 검증을 마친 시점이다. 이후 Classic/GRADIA의 최종 handoff 재검증 비용까지 소급해 완료 계측이라고 부르지 않는다.

| 값 | 정확한 의미 |
| --- | --- |
| `sourceBytes/durableBytes` | 성공적으로 수용한 value의 누적 byte. 반복 읽기 포함 |
| `reads` | budget 계층의 owner load 호출 수. 내부 transport 재시도/route bootstrap HTTP 횟수는 미측정 |
| `reservedIoBytes/peakReservedIoBytes` | 현재/최대 payload allowance 예약. 실제 transport buffer가 아님 |
| `decodeBytes/peakDecodeBytes` | 현재/최대 JSON workspace 예약 추정. 실제 heap이 아님 |
| `inFlightReads/peakInFlightReads` | 현재/최대 해당 요청의 pending read |
| `rejectedPayloadLowerBoundBytes` | cap 초과를 확인하며 센 거부 payload byte의 하한. 전체 응답 크기는 아닐 수 있음 |
| `pool` | runtime 공유 pool의 현재값·runtime 누적 peak·한도 |
| `failure` | 해당 ledger의 terminal 예산 실패 사유 |

Lane의 저장 page byte와 여기의 durable byte는 일부 동일 접근을 측정하므로 합산하지 않는다. Compiler의 기존 전체 `source_read_json/owner_io_in_flight/write_barrier` 계측이 완성됐다고 바꾸지 않는다. 실제로 모르는 값은 기존처럼 null·missingMeasurements다.

이번 증분의 미측정·미보장 범위는 명시적으로 남긴다.

- budget scope를 결속하기 전의 native context/readonly capture·route bootstrap, 호스트 chat/lore/settings 자체의 전송/할당과 외부 readonly permission witness.
- HTTP body/envelope parsing, transport buffer 및 스트리밍. 현재 host/SDK는 value 전체를 받은 뒤 크기를 알 수 있다. 예약보다 큰 응답이 host 내부에 먼저 할당되는 것을 막는 프로토콜은 아직 없다.
- 반환된 graph/projection/canonical rows/Map·frontier·private authority의 장기 보유량, index.compile 중간 데이터, portable vector hydration, hash/serialization scratch, build/publication, 전체 VM heap. 기존 부분 예산을 전체 상한으로 승격하지 않는다.
- shared page-cache workspace와 이 admission pool의 합을 포함한 전체 memory ceiling, 지원 corpus·동시성별 실제 품질/규모·설치 호스트 인증.

**다음 N01-C2는 장기 보유 graph/index/representation·private readset과 유지보수 작업의 admission/release다.** owner의 bounded response/stream protocol은 별도의 증명이 필요하다. `byteBounded:false`, `ownerAtomicity:false`, `inventoryComplete:false`는 유지한다.

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
