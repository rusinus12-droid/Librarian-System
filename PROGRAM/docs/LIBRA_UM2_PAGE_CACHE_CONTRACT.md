# LIBRA UM2 — 공통 byte 캐시와 검증된 투영 페이지 접근

- 버전: 1.0 · 2026-10-14.
- 기준: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md) v1.4, [owner reader 계약](LIBRA_UM1_READER_ADAPTER_CONTRACT.md), 구현 전 HEAD `611ec1e`.
- 상태: **실제 reader 투영에 공통 accounted-byte page cache·pin/eviction·view cursor를 연결했다. durable SourceGraph generation/index·원본 읽기 전체 예산·Memory Lane/frontier 전환은 후속 작업이다.**
- 구현: [libra_memory_graph_pages.cjs](../tools/libra_memory_graph_pages.cjs), [LIBRA.js](../plugins/LIBRA.js)의 `getMemoryGraphAccessPage`/`inspectMemoryGraphPages`.

## 1. F-3/F-4의 첫 구현 경계

기존 네 자료 owner reader는 현재 source page를 읽고 재검증한다. 이번 변경은 그 결과의 nodes/edges/bases/units를 작은 JSON page로 읽는 공통 facade를 제공한다. normal recall/beforeRequest는 이 경로를 자동 호출하지 않는다. 새 캐시는 원본·authoritative State·correction/recovery journal·provider cache를 소유하지 않는다.

F-3의 첫 계상 범위는 **파생 JSON payload·exact cache binding/control metadata·request/view와 decode lease·serialization/hash/validation staging**이다. F-4의 첫 경계는 query의 요청 내 투영·RAM cache admission만 허용하고 durable build/publication을 시작하지 않는 것이다. 기존 legacy query의 파생 catalog/manifest 쓰기 이전이나 전체 source map·writer barrier 비용 계상까지 완료했다고 보고하지 않는다.

## 2. 공개 읽기 API

~~~js
await LIBRA.getMemoryGraphAccessPage({
  expectedScopeKey,
  canonicalCursor: '', microCursor: '', limit: 20, nodeLimit: 2048,
  pool: 'units',           // nodes | edges | bases | units
  cursor: '',             // 반환한 nextCursor
  pageBytes: 16384         // items 배열의 UTF8 JSON 한도: 256–65536
});
LIBRA.inspectMemoryGraphPages();
~~~

실제 API 획득 방식은 기존 등록 API와 같다. caller가 graph·record·proof·generation을 공급할 수 없다. canonical/Micro의 source cursor와 derived row cursor는 별개다. 먼저 실제 `getMemoryGraphProjectionPage`를 실행하므로 cache hit에서도 선택한 owner body와 view를 재검증한다.

generation은 현재 readerFrame의 owner/scope/view/restore epoch, coverage, ordered node/basis/edge의 issued identity와 binding, unit membership에 결속한 snapshot label이다. 같은 NodeID의 binding 변화도 label을 바꾼다. row cursor는 이 label·pool·offset에 결속하고 현재 row 목록에서 검증한다. `pageBytes`를 바꾸어도 같은 현재 위치에서 이어 읽을 수 있다.

이 label은 **durable generation의 독립 검증이나 발급된 QueryGraphView의 권한이 아니다.** `durableGenerationVerified:false`, `modelDispatchEligible:false`, 기존 native identity-only/actual-host 미인증 한계를 유지한다. serialized label/cursor를 physical proof로 사용하지 않는다.

## 3. admission과 페이지 선택

| 예산 | 초기 runtime 기본값 | 계상하는 자료 |
| --- | --- | --- |
| Resident | 전체 4 MiB | immutable page JSON의 UTF16 bytes + exact binding/key/partition + 고정 control charge |
| Partition | partition당 1 MiB, 전체 resident와 함께 적용 | owner route·scope·viewer로 격리한 resident pages |
| Active request | 전체 1 MiB, 요청당 512 KiB | request/view descriptor·reservation/lease control·decode 작업의 보수적 계상 |
| Build/validation staging | 전체 2 MiB | 사전 예약한 encoding·JSON validation parse·UTF8/SHA workspace·metadata |
| Serialized page | 기본 16 KiB, 최대 64 KiB | **items 배열**의 UTF8 JSON bytes. 반환 envelope/cursor/coverage의 크기는 포함하지 않음 |

수치는 이 구현의 조정 가능한 초기 defaults이며 성능 acceptance 목표가 아니다. pool별 독립 cap·자료별 top-K를 두지 않는다. nodes/edges/bases/units의 payload는 역할별 binding으로 구별하고 같은 전체 resident 예산을 공유한다. posting/vector/query-feature pool은 아직 연결하지 않았다.

JSON 값은 큰 payload를 stringify하기 전에 depth≤32의 bounded traversal로 측정한다. UTF8 JSON bytes, UTF16 code units, 구조 token 수를 계산하고 control/lone surrogate/astral 문자를 실제 JSON 표현과 맞춘다. getter·toJSON·cycle·sparse array를 실행하지 않는다. staging은 문자열/해시/검증 parse를 만들기 전에 예약하고, decode lease도 반환 page parse 전에 요청 예산에 계상한다.

현재 계상식은 resident에 `512 + 2×(JSON text + exact tuple + key + partition 문자열 길이)`, request decode에 `1024 + 8×JSON code units + 64×구조 tokens`를 사용한다. staging은 UTF8 bytes×12, code units×4, tokens×192와 bounded hash/control 여유를 합친다. 빈 object/array의 delimiter도 validation 비용에 포함한다. 이는 conservative accounted bytes이며 JS의 실제 heap 전체를 측정하는 식이 아니다. hash fallback/validation 비용을 숨기지 않는다.

page는 byte·request decode·staging·최소 resident admission 한도 내에서 연속 row를 선택한다. row 하나가 현재 page 한도를 넘으면 `row_exceeds_page`로 **같은 offset/cursor를 반환**하고 삭제하거나 다음 row로 건너뛰지 않는다. page boundary나 예산 때문에 아직 읽지 못한 row는 nextCursor로 이어 읽는다. 자동 반복 소비자는 stopReason과 진전 여부를 확인해야 한다. 빈 budget stop은 예산 조정 없이 무한 재시도하지 않는다.

한 row가 최대 지원 page에도 들어가지 않는 경우는 explicit partial이다. field/item을 자동 분해해 새 의미나 안정 item identity를 만들지 않는다. 큰 row의 추가 chunk/continuation 계약은 후속 작업이다. `owner_projection_page_end`는 현재 source projection page의 끝이며 전체 owner corpus의 complete 판정이 아니다.

## 4. payload 재사용·pin·축출·무효화

cache binding은 exact privacy partition·pool·codec·payload digest·row cardinality다. view generation을 payload key에 무조건 붙이지 않으므로 새 view에서 같은 bytes를 재사용할 수 있다. 원본 issuer가 발급한 현재 snapshot의 membership과 cursor는 매 요청 별도로 확인한다. cache hit가 오래된 source/proof를 되살리지 않는다.

payload digest/key 충돌은 exact binding tuple과 실제 JSON text를 비교해 거부한다. 현재 경로는 이미 읽은 owner snapshot에서 page를 encode/hash하고 기존 text와 비교한 뒤 hit를 인정한다. 따라서 warm hit에서도 owner reads·projection·generation hashing·page encoding/validation이 남는다. warm-zero 또는 전체 source 검증 제거를 주장하지 않는다.

LRU는 unpinned pages만 축출한다. partition quota를 먼저 맞추고 전체 resident를 맞출 후보를 계산한다. admission과 decode 예산이 모두 통과한 뒤 축출하므로 실패한 admission이 기존 유효 page를 먼저 없애지 않는다. pinned pages 때문에 자리를 만들 수 없으면 `pin_backpressure`로 중단한다. eviction은 cache payload만 제거하고 source owner를 지우지 않는다. cold reload와 hit의 row 내용은 동일해야 한다.

request/lease/reservation은 factory가 발급한 private handle로 관리한다. clone·foreign·close/invalidate된 handle은 거부한다. finally에서 stage·pin·request를 해제하고 WeakMap 발급 기록을 제거한다. runtime의 실제 portable restore boundary는 즉시 page cache를 invalidate하며, 같은 A bytes가 돌아와도 이전 handle/cursor는 복원 epoch를 넘지 못한다. 현재 scope 삭제는 보수적으로 이 runtime의 모든 graph pages를 invalidate한다. unload는 dispose한다.

## 5. 진단의 범위

`inspectMemoryGraphPages()`는 pool별 pages/accounted bytes, 전체 resident/request/staging 현재값·peak, pins/pinned resident bytes, hit/miss/eviction/budget-stop·encoding/staging validation parse/decode·generation 횟수를 반환한다. 원본 body·비밀값·opaque source proof를 출력하지 않는다. 카운터는 이 runtime의 누적 값이며 동시 owner 요청의 비용 attribution을 인증하지 않는다.

`accountedByteBounded:true`는 위 managed component의 admission 계상에 한정한다. **`actualHeapBounded:false`, `sourceReaderWorkspaceAccounted:false`, `callerRetainedOutputsAccounted:false`, 전체 API의 `byteBounded:false`**를 유지한다. source reader의 이미 생성된 전체 projection, legacy cache, 반환 DTO를 소비자가 계속 보관한 메모리, VM/GC·Map/object overhead·실제 host transport는 이 component의 상한에 포함되지 않는다. complete engine memory bound로 확대하지 않는다.

## 6. 검증

~~~sh
node PROGRAM/tests/libra_memory_graph_pages_test.cjs
node PROGRAM/tests/libra_memory_graph_pages_runtime_test.cjs
node PROGRAM/tests/libra_memory_graph_reader_runtime_test.cjs
node PROGRAM/tests/libra_memory_graph_assembly_test.cjs
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
~~~

순수 suite의 13개 검사는 Unicode/JSON 사전 계측, getter·cycle 등 거부, nested empty container의 validation 예약, 전체 supplied row 순회, generation 간 불변 payload 재사용, LRU 재조회 동등성, pin backpressure, request/staging/resident admission·finally 해제, privacy partition quota, 역할별 pool, 강제 digest 충돌, handle 폐기/ABA, binding/coverage/epoch generation을 검증한다.

등록 API suite는 기존 actual writer/producer로 만든 plugin_only/server_only 합성 호스트에서 shipped API를 호출한다. 현재 projection의 33개 unit을 네 자료 모두 포함해 순회하고, cold/warm 일치·owner rereads 유지·모든 role pool·다른 pool/scope/caller graph 거부·작은 page 재시도·조회 writes/provider calls 0을 검증한다. plugin_only에서는 동일 key/revision의 독립 body 변경에 따른 cursor 거부, 실제 portable backup/restore 뒤 cache 폐기·old cursor 거부를 추가 검증한다. backup/restore 자체의 쓰기는 조회 부작용 측정 구간과 구분한다.

기존 owner reader/assembly·network projection/assembly·실제 beforeRequest graph OFF/ON/server_only parity·lore regression과 source-profile build도 유지한다. 합성 host의 wiring/safety 검증이며 실제 설치 host·모델 relevance·성능 envelope qualification은 아니다.

## 7. 남은 UM2 gate

후속 [durable graph 계약](LIBRA_UM2_DURABLE_GRAPH_CONTRACT.md)에서 이 cache에 owner projection-window의 불변 pages·manifest/root-last/서버 CAS와 전체 window 독립 재도출 reader를 연결했다. 다음은 source read header/size·bounded hydration·exhaustive inventory/delta와 공통 access index·reverse dependency다. trusted owner API가 없는 범위는 비용을 기록한 exact fallback/partial로 남긴다.

그 뒤 L0 frontier/candidate/설명/readset과 pending I/O/coalescing·cancellation·writer barrier를 같은 byte inventory에 넣고, Memory Lane이 공통 page 접근·작업 순서를 관리하도록 연결한다. 현재 API의 ordered row cursor는 최종 Memory Lane/단일 retrieval controller가 아니다. 기존 A2 preparation loop·legacy caches/rankers 종료는 actual unified query gate에서 판정한다.
