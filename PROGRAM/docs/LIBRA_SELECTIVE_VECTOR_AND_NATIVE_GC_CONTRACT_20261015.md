# LIBRA 선택적 벡터 페이지와 실제 서버 GC

- 작성일: 2026-10-15 · 버전: 1.0
- 기준: `0e3c39d` 이후 선택적 벡터 저장 접근과 native server GC 구현
- 관련: [설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [현황 §33](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), [다음 과제](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md), [자원 예산](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)

## 1. 구현 및 지원 범위

| 기능 | 실제 구현 | 제한 |
| --- | --- | --- |
| 의미 검색 | 정본 global 벡터를 같은 scorer/frontier의 source 접근 신호로 사용 | Micro·State·로어는 vectorless를 유지. 추가 producer를 구현했다고 표시하지 않음 |
| 벡터 저장 접근 | 유지보수 시 불변 vector page·참조 인덱스를 게시하고 Memory Lane·공통 Cache Manager로 읽기 | 이전 manifest·미구축 코퍼스는 같은 Lane에서 기존 owner vector record를 지연 읽음 |
| native GC | server_only의 실제 SDK→HTTP→SQLite 트랜잭션 및 영속 lease | plugin_only·mirror의 실제 삭제는 계속 차단. 호스트 pluginStorage에는 원자적 CAS/트랜잭션 API가 없음 |
| 원자적 삭제 | namespace 사용권, 현재 참조와 후보 revision/digest를 삭제 트랜잭션에서 검사 | SDK/server를 함께 갱신해야 함. 실제 설치·지원 규모 인증은 별도 |

`byteBounded:false`, `ownerAtomicity:false`, `inventoryComplete:false`, `calibration:unmeasured`는 유지한다. GC의 파생 namespace 원자성과 전체 원본의 atomic snapshot은 별개다.

## 2. 영속 의미 참조 인덱스와 벡터 페이지

`buildMemoryGraphCorpus()`는 저장된 ready 벡터만 읽어 `libra.graph_semantic_directory.v1`을 만든다. 문서·질의 임베딩을 새로 생성하지 않는다. 원본 embedding 공간·본문·profile·revision을 검증하고 원본 벡터의 전체 portable digest를 확인한 뒤 global 표현만 별도 불변 페이지로 저장한다.

- 참조 인덱스: `memory-graph:v1:corpus:semantic-directory:<sha256>`.
- 벡터 페이지: `memory-graph:v1:corpus:vector:<sha256>`. 표현 JSON을 24,576 UTF-16 단위 조각으로 나누고 각각 JSON string array로 저장한다. digest·byte 길이를 ref에 기록한다.
- corpus manifest의 `semanticDirectory`가 참조 인덱스를 가리킨다. directory는 source node/binding, owner vector key/body digest/server revision, profile, global vector page refs를 가진다.
- 원본 벡터는 기존 producer 소유다. 이 기능의 저장과 GC는 원본 정본·Micro·State·로어·producer vector를 수정/삭제하지 않는다.

query는 directory metadata만 먼저 읽는다. 정규화 벡터의 앞 16개 좌표와 나머지 norm으로 cosine의 상한을 구해 접근 순서를 정한다. 상한이 음수이거나 성분별 부호로 0 이하임을 증명하는 경우만 제외한다. 단어 일치 여부로 의미 후보를 잘라내지 않으며 임의 top-k를 완전 검색으로 보고하지 않는다. bounds가 느슨하면 필요한 모든 벡터를 읽을 수 있고, 예산 중단은 partial/미독 cursor로 드러난다.

## 3. 하나의 검색 경로와 최종 증명

`representations` 접근을 공통 Index의 요청별 private reader와 `semantic_access` Lane에 연결한다. `withSemanticReader()`는 요청별 index handle을 만들어 동시 요청이 reader를 덮어쓰지 않게 한다. 실제 읽은 벡터 페이지는 digest/byte를 검증하고 공통 Cache Manager의 reserve·install/acquire·decode·release를 거친다. 질의 벡터와 문서 벡터의 유사도는 기존 Query kernel의 같은 계산을 사용한다. 결과는 같은 source activation·관계 확장·Compiler로 이어진다.

query에는 문서 임베딩 생성이나 durable index 자동 쓰기가 없다. 현재 root/원본·모델/auth 설정·view/reset을 확인하고, 읽은 표현의 원본 vector body SHA와 server revision을 최종 private 검증에서 재확인한다. server ABA·설정 변경·원본 변경·취소·늦은 응답은 전달을 거부한다. 저장된 파생 벡터나 공개 DTO가 발송 권한은 아니다.

Lane의 storage budget은 index/vector page 접근과 byte를 계상한다. owner 원본 재검증·호환 owner record 읽기 및 JSON/retained 비용은 resource ledger가 별도로 계상한다. 두 counter는 실제 네트워크/heap peak가 아니며 서로 겹치는 범주를 합산하지 않는다. 단일 표현에 필요한 페이지 예산이 부족하면 그 접근을 완료하지 않는다. 더 큰 요청 예산으로 재개하며 영속 frontier 세션을 보장하지 않는다.

전체 감사(`verifyMemoryGraphCorpus`)는 선택되지 않은 vector page까지 검증한다. 일반 질의는 요청하지 않은 벡터 페이지를 읽지 않는다. 새 형식은 명시적 corpus 유지보수 구축 후 사용한다.

## 4. 실제 저장소 사용권과 삭제

LIBRA 전용 SDK의 `acquireGraphStorageLease()`와 `/v1/libra/graph-lifecycle`을 연결한다. capability는 `libra-graph-lifecycle.v1`이다. 일반/core3 서버의 같은 repository writer transaction을 사용한다. GRADIA 등 보존 SDK는 교체하지 않는다.

- 사용권은 scope의 `memory-graph-control:v1:root`에 영속 저장하며 최대 32개다. 수명 60초, SDK 갱신 주기 20초다. 동일 acquire requestId는 같은 사용권을 반환한다.
- build/read는 공유 사용권이다. GC는 다른 활성 사용권이 없을 때만 배타 사용권을 얻는다. build/read가 남으면 native API는 `blocked_active_leases`를 반환한다.
- build는 불변 페이지 쓰기 전 획득하고 게시/실패 후 해제한다. read는 query·Classic context·GRADIA receipt의 private 자원 수명에 연결한다. 실패/취소/dispose에서 해제를 시도하고, 응답 손실/연결 종료 후 남은 사용권은 영속 만료로 회수한다.
- 서버는 GC 중 다른 graph namespace 쓰기와 새 build/read를 거부한다. root 게시에는 live build lease가 필요하고, manifest digest 및 모든 참조의 존재를 같은 트랜잭션에서 검사한다. GC 후 늦은 게시가 삭제된 페이지를 참조할 수 없다.
- 사용권 만료 후 assert/renew/삭제/게시를 허용하지 않는다. process-local Map이나 per-root 재읽기로 이 보장을 대신하지 않는다.

이 메타데이터는 LIBRA owner의 저장소 조정 기록이다. 통합 query·GRADIA 읽기에서 정본/상태/원문 및 일반 파생 index를 바꾸지 않는 계약은 유지하지만, 서버 사용권 bookkeeping은 쓰기가 발생한다. GRADIA에는 owner 쓰기 권한을 주지 않는다.

## 5. 도달성 및 회수 대상

서버가 window/corpus root→manifest→page, proof/projection, semantic directory→vector page를 추적한다. 최근 24시간의 자기완결적 `windowSlices` checkpoint도 보존한다. 활성 build/read는 GC 전체를 막으므로 게시 전 작업 페이지와 이전 세대 reader도 보호된다.

실제 삭제는 server_only에서만 실행한다. 후보의 revision/digest, 현재 사용권, 현재 도달성을 삭제와 같은 트랜잭션에서 재확인한다. reachable key·root·원본 namespace·다른 scope 및 위조/만료 token은 삭제할 수 없다. `candidateKeys`를 주면 그 목록 안에서만 회수한다. dry-run은 후보만 보고한다. 완전 inventory 지원 한도는 8,192개 live metadata record이며 초과 시 거부한다. payload는 KV tombstone으로 제거하고 revision 이력은 보존한다. 이전 tombstone은 live inventory 한도를 소비하지 않으며 DB 파일 축소는 기존 저장소 정비 정책을 따른다.

plugin_only/mirror는 `blocked_atomic_gc_unavailable`, `deletedKeys:[]`를 유지한다. local/mirror의 안전한 실제 회수에는 호스트의 원자적 저장 기능 또는 파생 저장소의 별도 transactional backend가 필요하다. 이 한계를 runtime lock으로 숨기지 않는다.

## 6. 검증과 비용 한계

검증 시작점은 다음과 같다.

- `libra_memory_graph_semantic_test.cjs`: eager와 같은 점수/witness, metadata 열기 시 vector I/O 0, exact routing, Lane budget·미독 접근, 공유 cache 해제.
- `libra_memory_graph_vector_lane_runtime_test.cjs`: 실제 writer/저장 벡터 2개→영속 directory/vector page→의미만으로 검색. 선택하지 않은 owner vector body 읽기 0, source currentness, 미요청 손상/전체 감사 및 선택된 손상 거부, GC의 vector page 보존.
- `libra_graph_lifecycle_sqlite_test.cjs`: 독립 SQLite 연결과 별도 Node process의 사용권, 구축·리더·만료/재사용·control 위조·reachable 삭제·늦은 root 게시 거부.
- `authority_core3_runtime.test.cjs`의 graph namespace 검사: 인증된 no-listener core3 handler와 실제 owner coordinator를 통한 lease·회수. 실제 설치 호스트 인증은 아님.
- `libra_memory_graph_native_gc_runtime_test.cjs`: 실제 등록 API→SDK→HTTP→SQLite에서 orphan 회수, live root/proof/최근 대형 checkpoint 보존, plugin_only/mirror 차단.
- 기존 native semantic·corpus·자원·Classic·GRADIA 셰도우/AIDE·인풋 작성기·SDK conditional-batch 회귀를 함께 실행한다.

두 정본의 상세 합성 graph는 기본 JSON/retained 한도를 넘을 수 있어 해당 native vector 시험은 `maxDecodeBytes:128MiB`, `maxRetainedBytes:128MiB`를 명시한다. 전체 감사 대조는 retained 200MiB를 사용한다. 이를 전체 VM·실제 corpus 지원 규모 인증으로 확대하지 않는다. 보유 산식/전체 원본 증명·host/provider·설치·성능 인증은 N01-a/b·N06에 남는다.

## 7. 실행 기록

커널/SDK/core3/평가 영향권 묶음은 Node runner 82건, native semantic·vector Lane·GRADIA·자원·재개·GC 영향권 묶음은 24건이 통과했다(semantic runtime 파일 내부 8개 검사는 별도 출력). 추가로 독립 Node process, 승인된 scope 삭제·namespace reset 경로를 확인했다. SDK에는 진행 중 bootstrap 갱신의 인증된 binding을 기다리는 회귀를 추가했으며 실제 route/DATA/reset 변경 검사는 유지한다.

```bash
node --test PROGRAM/tests/libra_memory_graph_semantic_test.cjs PROGRAM/tests/libra_memory_graph_vector_lane_runtime_test.cjs PROGRAM/tests/libra_memory_graph_native_gc_runtime_test.cjs PROGRAM/tests/libra_graph_lifecycle_sqlite_test.cjs
node --test PROGRAM/tests/authority_core3_runtime.test.cjs PROGRAM/tests/authority_server_writer_inventory.test.cjs PROGRAM/tests/libra_sdk_conditional_batch_v1_test.cjs
node --test PROGRAM/tests/libra_memory_graph_semantic_runtime_test.cjs PROGRAM/tests/libra_memory_graph_resources_runtime_test.cjs PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
node PROGRAM/tools/sync_libra_gradia_unified_read.cjs --check
node PROGRAM/tools/check_sdk_sync.cjs
```

source plugin 빌드의 구문 검사와 SDK/내장 kernel 동기화를 확인한다. 역사적 build size 기준 초과 표시는 reporting-only이며 실제 규모/heap 인증으로 해석하지 않는다. 설치 RisuAI·실제 provider 검색 품질·지원 규모는 N06 후속이다.
