# LIBRA UM2 — durable SourceGraph window와 generation 게시·검증

- 버전: 1.0 · 2026-10-14.
- 기준: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md) v1.5, [page/cache 계약](LIBRA_UM2_PAGE_CACHE_CONTRACT.md), 구현 전 HEAD `ba6a25f`.
- 상태: **실제 owner projection window의 불변 pages·generation manifest·root 게시와 재시작/조회 독립 검증을 구현했다. 전체 corpus inventory/delta·adjacency/posting access·Memory Lane/frontier·최종 delivery는 후속 작업이다.**
- 구현: [libra_memory_graph_store.cjs](../tools/libra_memory_graph_store.cjs), [LIBRA.js](../plugins/LIBRA.js)의 maintenance/read API. 기존 저장 소유권·SDK/서버 protocol은 바꾸지 않는다.

## 1. 공개 API와 소유권

~~~js
await LIBRA.buildMemoryGraphGeneration({
  expectedScopeKey, canonicalCursor: '', microCursor: '', limit: 20,
  nodeLimit: 2048, pageBytes: 16384
});
await LIBRA.getMemoryGraphDurablePage({
  expectedScopeKey, canonicalCursor: '', microCursor: '', limit: 20,
  nodeLimit: 2048, pool: 'units', cursor: ''
});
LIBRA.cancelMemoryGraphGenerationBuild();
LIBRA.inspectMemoryGraphStore();
~~~

`buildMemoryGraphGeneration`은 **명시적 maintenance 쓰기**다. normal recall/beforeRequest·GUI·read API가 호출하지 않는다. 새 reader는 generation이 없거나 낡았을 때 이를 만들거나 고치지 않는다. missing/stale를 반환하고, 손상·경합·잘못된 cursor는 거부한다. caller-supplied graph/record/proof/generation은 입력으로 받지 않는다.

원본은 기존 canonical/Micro/State/lore owner reader가 읽고 검증한다. writer는 `libra:v1:scope:<scopeKey>:memory-graph:v1:` 아래의 재생성 가능한 파생 데이터만 쓴다. 정본/State/receipt·correction/recovery journal을 수정하거나 새 사실/임베딩을 만들지 않는다. 실제 지원 모드는 plugin_only와 server_only다. mirror를 이 구현의 publication qualification으로 확대하지 않는다.

## 2. 저장 형식과 window coverage

| record | 내용·key | 게시 역할 |
| --- | --- | --- |
| `libra.graph_durable_page.v1` | privacy partition·pool·codec·rows·UTF8/code-unit size·payload digest·정확한 JSON text. `page:<pool>:<digest>` | 불변 payload; 같은 정확한 record는 재사용, 같은 key의 다른 record는 collision 거부 |
| `libra.graph_generation.v1` | policy·sourceOptions·readerFrame/sourceStamp·coverage·ordered page directory/totals·publication job token. `generation:<manifest digest>` | 모든 page가 준비·readback·재도출 검증을 통과한 뒤 저장하는 불변 manifest |
| `libra.graph_root.v1` | generation/manifestKey·sourceStamp·publicationToken·publication 보장 범위. `root:<window slot>` | **마지막에 게시**하는 현재 window pointer |

window slot은 owner route·logical worldline·viewer·정규화된 source cursor/limit/nodeLimit·projection policy에 결속한다. 서로 다른 source window를 한 root로 덮어 전체 corpus인 것처럼 취급하지 않는다. root와 manifest는 사실 소유자가 아니며 source ownership/lifetime을 발급하지 않는다.

nodes/edges/bases/units를 page/cache의 byte admission으로 나눈다. fixture의 현재 window는 48 nodes·81 edges·27 bases·33 units를 **17개 page**로 보존한다. 전체 source inventory는 여전히 `inventoryComplete:false`이고 State 미해결 근거·미지원 inherited Micro·미독 source page 사유를 유지한다. directory는 최대 48 pages, server conditional batch는 조건+mutation 최대 64개다. 이 상한을 corpus 보존 범위나 family별 top-K로 해석하지 않는다. 초과·큰 row·budget stop은 publication을 실패시키며 이전 root를 보존한다.

## 3. 유지보수 build와 publication

1. 현재 owner reader에서 source projection과 선택한 physical dependency key를 얻는다. source callback은 private bridge이고 공개 DTO가 physical proof를 공급하지 않는다. node/basis/edge binding·unit membership·coverage/view/restore epoch를 sourceStamp에 결속한다.
2. source와 기존 root를 pin한다. server는 기존 SDK의 `captureConditionalReadSet`으로 per-key revision/digest를 캡처한다. local은 exact raw value 비교를 수행한다.
3. byte page를 순서대로 만들고 불변 record를 저장·readback한다. 아직 root를 게시하지 않는다. 기존 동일 page는 쓰지 않고 재사용한다.
4. owner projection을 **다시 읽어 재도출**하고 exact header/payload를 실제 저장 page와 대조한다. source가 바뀌면 abort한다. checksum label만 같다는 이유로 통과시키지 않는다.
5. generation manifest를 저장하고 source/root pin과 page/manifest 기대값을 다시 확인한 뒤 root를 마지막에 게시한다. root readback과 최종 owner projection 확인을 통과해야 API가 `published`를 반환한다.

| 모드 | 실제 publication | 보장 한계 |
| --- | --- | --- |
| server_only | 기존 `prepareConditionalBatch`/`commitConditionalBatch`의 root CAS. source/root pinned readset과 page/manifest 조건을 같은 batch에 결속. endToEndVerified receipt 필요 | root/source-key/page-key predicate의 server 원자성. native lore/text와 전체 owner dependency inventory의 원자성을 인증하지 않음 |
| plugin_only | runtime 내 하나의 active build, source/root/page exact 비교, 기존 fenced storage writer, root-last write/readback | **partial**. 외부 VM/writer의 CAS·monotonic revision·restore atomicity를 만들어 내지 않음 |

서버는 이미 발급한 expected revision을 새 값으로 바꿔 실패한 작업을 재시도하지 않는다. 응답 손실/receipt 복구는 기존 SDK의 동일 operation/payload 규칙을 따른다. local에 새 transaction protocol을 추가하지 않는다. 두 모드 모두 `ownerAtomicity:false`다. source-key pin 목록이 있다는 사실을 exhaustive owner inventory나 native mutation proof로 승격하지 않는다.

한 runtime에서 active maintenance build는 하나다. 취소/restore/scope deletion/unload는 continuation token을 폐기한다. 이미 host에 발행한 쓰기는 취소할 수 없으므로 **write await가 settle할 때까지 active barrier를 유지**하고 새 build를 거부한다. 취소 전에 발행한 immutable page가 나중에 저장될 수 있으나 이후 root 게시를 계속하지 않는다. 이미 root write가 발행된 경우 물리 rollback을 인증하지 않으며 후속 reader의 source 검증이 계속 필요하다.

중간 실패로 저장된 page나 manifest는 orphan으로 남을 수 있다. query가 삭제·repair하지 않는다. 이전 generation manifest/pages와 orphan의 GC/disk quota·exhaustive dependency index는 후속 maintenance gate다. 게시 직후 source가 바뀌어 최종 검증이 실패해도 stale root를 query가 사용하지 않는다.

## 4. query와 restart의 독립 검증

조회는 다음 순서를 모두 수행한다.

1. 현재 owner projection을 새로 읽고 window 위치·sourceStamp를 산출한다. root가 없으면 `missing_generation`, sourceStamp가 바뀌면 `stale_generation`을 반환한다.
2. root/manifest의 schema·policy·partition·frame/sourceOptions·coverage·job token·publication mode·manifest digest를 검증한다. cursor는 현재 root generation과 pool/page 위치를 확인한다.
3. 현재 원본에서 byte directory와 page payload를 다시 만든다. directory의 key/range/cardinality/size/digest가 **재도출된 descriptor와 정확히 같아야** 해당 key를 읽는다. foreign-key redirect·누락/겹침·다른 page split을 허용하지 않는다.
4. 선택 page뿐 아니라 window의 **모든 persisted page**를 물리적으로 읽고 현재 payload와 exact 비교한다. 선택하지 않은 page의 손상도 전체 window 검증을 실패시킨다. warm cache로 이 검증을 생략하지 않는다.
5. root를 다시 읽어 동일 게시인지 확인하고 owner projection을 한 번 더 읽어 현재성 변경을 확인한다. 중간 변화가 있으면 이미 decode한 결과도 전달하지 않는다.

재시작 시 serialized ID·stored checksum·RAM의 이전 verified flag를 재신뢰하지 않는다. source snapshot·directory·payload를 독립적으로 재도출하는 같은 reader를 사용한다. restore epoch가 달라진 오래된 root/cursor는 거부하며 자동 rebuild하지 않는다.

통과한 `durableGenerationVerified:true`의 범위는 **`current_owner_projection_window_all_persisted_pages`**다. 전체 corpus·viewer/as-of QueryGraphView·native incarnation·최종 model dispatch의 proof가 아니다. `inventoryComplete:false`, `ownerAtomicity:false`, `modelDispatchEligible:false`와 기존 readerValidation의 actual-host 미인증·native identity-only 한계를 유지한다.

## 5. byte·I/O 계상과 비용

page/cache component의 resident/request/staging admission을 유지한다. 파생 문자열을 encode하고 저장/읽기 검증을 수행할 때 reservation을 유지하며 finally에서 stage·pin·request를 해제한다. root/manifest size와 page header를 제한하고, SDK가 반환한 record의 길이를 확인한 뒤 store의 JSON parser staging을 예약한다. header를 신뢰해 무제한 page decode를 시작하지 않는다.

기존 SDK가 raw value를 반환하는 동안의 전체 transport allocation은 bounded streaming read가 아니다. source projection workspace·source pin의 raw 값·consumer 반환값·실제 VM/GC heap도 전체 예산 qualification 밖이다. **`ownerTransportBounded:false`, 전체 API의 `byteBounded:false`**를 유지한다. cache component의 `durableStoreImplemented:false`는 그 component 단독의 역할이고, store 진단의 `durableStoreImplemented:true`와 구분한다.

현재는 매 query 전체 window를 재검증하고 owner projection을 반복한다. pageReads/writes/reuses·validations·build/publication/rejection counts를 관찰하지만 warm-zero나 설치 host의 latency/accuracy를 주장하지 않는다. trusted exhaustive delta와 bounded owner read가 마련돼야 반복 검증을 줄일 수 있다.

## 6. 검증과 재현

~~~sh
node PROGRAM/tests/libra_memory_graph_store_test.cjs
node PROGRAM/tests/libra_memory_graph_store_runtime_test.cjs
node PROGRAM/tests/libra_memory_graph_assembly_test.cjs
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
~~~

순수 suite 12개: missing/read-only와 root-last, fresh store restart, binding/실제 projection 변화, warm cache·비선택 page 오염, 재계산 checksum의 원본 인증 불가, partial writes/기존 root 보존, 준비 중 source 변경, 취소 write barrier, root/source-pin conflict, foreign-key redirect, oversized record, 최종 source 변경 시 결과 폐기.

등록 API suite는 실제 writer/producer와 shipped API, plugin storage 또는 실제 SDK+HTTP/SQLite를 사용한 **합성 native host**다. 각 모드의 17-page 게시·33-unit 전체 순회·query writes/provider calls 0·새 VM의 독립 재시작 검증·비선택 lore page 오염 거부를 확인한다. plugin_only는 실제 pending host write 취소/barrier와 portable restore 뒤 stale read-only를, server_only는 실제 final batch 경합의 독립 publisher 승리·old cursor 거부·새 root 검증을 확인한다.

재시작 fixture는 SDK 초기 configuration fence가 이동하면 새로운 read-only capture로 준비를 재시도한다. `READ_ROUTE_CHANGED` guard를 약화하거나 기존 handle을 재사용하지 않는다. query 부작용 측정은 이 fixture 준비가 끝난 뒤 수행한다. 실제 설치 host qualification·native text mutation authority·final physical dispatch는 아직 수행하지 않았다.

## 7. 다음 gate

durable node/source directory·typed adjacency와 entity/predicate/time/lexical posting 접근을 같은 page/generation/cache 계약에 연결하고, exhaustive source-window inventory와 reverse dependency/delta·tombstone을 구현한다. maintenance GC와 source/frontier/in-flight/write barrier의 전체 byte inventory도 필요하다. Memory Lane은 이 접근을 공통 frontier의 작업 순서로 조정해야 한다. 새 durable store의 존재만으로 legacy A2 preparation loop·독립 ranker·캐시가 이전됐다고 판정하지 않는다.
