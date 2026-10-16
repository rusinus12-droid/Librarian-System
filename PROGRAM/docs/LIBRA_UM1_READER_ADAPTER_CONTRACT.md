# LIBRA UM1 — 실제 owner reader와 읽기 전용 그래프 투영

- 버전: 1.0 · 2026-10-14.
- 기준: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md) v1.3, [identity 계약](LIBRA_UM1_GRAPH_IDENTITY_CONTRACT.md), 구현 전 HEAD `654803d`.
- 상태: **네 자료의 실제 reader → 공통 그래프 투영과 공개 API 연결 구현. 통합 검색·durable GraphStore·byte cache·Memory Lane·최종 dispatch는 미구현.**
- 구현: [순수 reader 커널](../tools/libra_memory_graph_readers.cjs), [LIBRA.js](../plugins/LIBRA.js)의 `getMemoryGraphProjectionPage`, [factory 조립 도구](../tools/sync_libra_memory_graph.cjs).

## 1. 이번 구현의 범위

이전 normalized fixture가 수작업으로 연결한 정본·Micro·State·lore unit/basis를 이번에는 실제 저장 reader에서 만든다. 읽기 소유권은 기존 LIBRA에 남는다. 새 공개 API는 현재 owner scope의 자료를 명시적으로 요청할 때만 실행한다. normal recall/beforeRequest에 자동 삽입하거나 기존 candidate/ranker를 교체하지 않는다.

private runtime bridge가 원본을 읽고 검증한 JSON snapshot을 순수 `createMemoryGraphReaders({identity, normalizeName, digestClaim})`에 전달한다. 커널은 storage/provider에 접근하지 않고, `libra.node.v1`/`libra.edge.v1` identity 커널을 사용해 Source/Entity/Meaning·basis·edge·unit·coverage를 반환한다. `digestClaim`은 기존 owner의 claim digest 계산이며 새 hash를 기존 증거 digest 대신 쓰지 않는다. runtime은 기존 network factory의 SHA256 primitive를 identity fingerprint로 재사용한다.

현재 reader가 stable source/unit/birth incarnation을 증명하지 못하므로 모든 새 node·basis는 exact snapshot에 결속한 `revision_bound`다. 같은 이름으로 entity를 합치거나 hash label을 physical proof로 승격하지 않는다. registry에서 승인되고 ID가 유일한 현재 entity만 사용한다. 이름으로 Micro 참여자를 연결할 때 승인된 이름/alias가 유일해야 한다.

## 2. 공개 API와 페이지 계약

~~~js
await LIBRA.getMemoryGraphProjectionPage({
  expectedScopeKey,             // 선택 사항: 현재 scope를 확인
  canonicalCursor: '',          // 이전 page의 canonicalNextCursor
  microCursor: '',              // 이전 page의 microNextCursor
  limit: 20,                    // 자료별 canonical record / Micro turn 읽기 수, 최대 50
  nodeLimit: 2048               // 투영 node 작업 상한, 최대 8192
});
~~~

위 표기는 등록 API의 호출 모양이다. 실제 호스트에서 LIBRA API를 얻는 기존 방식은 바꾸지 않는다. 공개 입력은 이 다섯 필드뿐이며 caller-supplied record·proof·source admission은 거부한다. cursor는 scope·logical worldline·restore epoch·capture publication generation·정본 ref 목록·현재 eligible turn 목록에 결속한다. 다른 scope 또는 turn/ref 목록이 바뀐 cursor는 거부한다.

canonical과 Micro는 독립 cursor를 사용한다. `limit`은 source corpus 보존 범위가 아니라 페이지 작업 수다. State와 허용된 lore는 현재 reader가 제공하는 범위를 읽고 같은 `nodeLimit`에 참여한다. 해당 상한은 resident byte 예산이나 전체 corpus traversal 보장이 아니다. node 상한 도달 시 `node_work_budget`, 미독 페이지는 `canonical_pages_unread`/`micro_pages_unread`를 표시한다. 재시작 가능한 node-level continuation은 아직 없으며 작은 node 상한으로 중단된 페이지는 더 큰 예산으로 다시 읽어야 한다.

`inventoryComplete:false`, `exhaustiveOwnerDeltaVerified:false`, `byteBounded:false`를 유지한다. 현재 논리 worldline의 기존 read view/cutoff를 사용하며 arbitrary historical/as-of/viewer input은 받지 않는다. inherited Micro archives는 아직 투영하지 않고 `inherited_micro_projection_not_yet_supported`를 보고한다. 이 API는 발급된 QueryGraphView를 대체하지 않는다.

## 3. 네 자료의 투영 규칙

| 자료 | 실제 읽기 경로 | 투영과 근거 |
| --- | --- | --- |
| 정본 | `canonicalReaderRefs` → `loadMemoryRef` → typed artifact의 `unifiedEvidenceRead` | v4/v5의 승인된 claim contract·fact·subject/target·evidence spans를 보존. record/ref의 memoryId·revision·sourceDigest 일치 필요. tempFactId 중복은 건너뛰고 ambiguity 보고 |
| Micro | `readActiveMicroMemory` → `microRecallMemoryFromRecord` | active receipt/head/work/record 및 analysis/span 검증 후 claim 또는 source-only excerpt. source/analysis revision·sourceDigest·role/message·UTF-16 offset·exactQuote 보존 |
| State | raw head + `loadContinuityStateForResponse` + strict correction journal | 현재/last-known authority·certainty·domainStatus·head basis/throughTurn을 보존. scalar field 또는 revision-bound array item. provenance가 없는 값은 `state_unprovenanced`; 누락을 clear로 만들지 않음 |
| lore | `loadRisuContextSnapshot` → `loreLinkAllowedEntries` + 직접 `buildLoreLinkIndex` | 이름 연결이 없는 허용 lore도 passage node로 투영. 본문은 rendered window의 정확한 slice. activation/mapping dependency와 rendered 좌표·raw offset 불가 상태 보존 |

정본의 알 수 없는 legacy artifact는 record text의 `source_excerpt`와 source-only basis로 남기고 `typed_schema_unavailable`을 보고한다. 새 claim을 추출하지 않는다. typed fact의 entity mapping/evidence가 부족하면 해당 연결을 만들지 않고 사유를 표시한다.

Micro의 producer 제한은 유지한다. 검증된 claim은 최대 16개이고 최소 원문 결속 fallback은 기존 **첫 500자** excerpt다. `minimum_source_bound`에서 supplied claim을 가져오거나 source-only node를 fact로 바꾸지 않는다. 이 500자는 전체 원문 검색 coverage가 아니다.

State의 `derived_from`은 이미 기록된 근거 포인터의 유일 대응에만 만든다. 정본은 exact memoryId/revision/assertionId/sourceDigest·entity/field(relationship은 subject/target/dimension)가 일치해야 한다. Micro는 state_admitted evidence의 receipt/source/analysis/claim digest와 role/message/offset/quote가 일치해야 한다. 한 span의 다른 claim은 구별하고 동일 claim의 여러 occurrence는 미해결로 남긴다. source-only excerpt는 State claim derivation 대상이 아니다. admission decision 자체의 최종 physical proof는 이 연결로 인증하지 않는다.

사용자 정정은 현재 scope/worldline의 active correction record를 찾고 compiled patch의 대상·field·실제 set 값 또는 clear가 맞아야 `state_correction` basis로 연결한다. 정정이 덮어쓴 정본 field evidence를 현재값의 derivation으로 연결하지 않는다. 값과 clear가 동시에 있으면 충돌로 보고한다. array item은 현재 revision의 index selector이며 안정적인 item lifetime을 주장하지 않는다. 복잡한 narrative/thread·item lineage와 page 밖 근거의 완전한 대응은 후속 작업이다.

lore의 locator `excerpt`는 기존 320자 compactMiddle 표현이며 실제 passage text 대신 사용하지 않는다. `coordinateSpace:'rendered'`의 start/end로 현재 rendered 본문을 읽고 raw offset을 만들어 내지 않는다. entity 이름 reference는 현재 LLI의 `name_reference`와 `reference`/`confirmed` resolution이 허용할 때만 `mentions`로 연결한다. removal·held ambiguity·충돌하는 confirmation을 passage의 confirmed 플래그로 우회하지 않는다. 이름 언급을 적용 규칙이나 발생 사건으로 승격하지 않는다.

standalone owner reader에 실제 request host-selected lore가 없으면 `hostSelected:null`, `hostSelectionAvailable:false`를 보존한다. 선택된 요청 경로를 입증한 입력만 true다. priority/position/mode/alwaysActive는 native metadata로 남기고 relevance bonus를 만들지 않는다. 기존 LLI의 상한·모호한 연결은 source inventory 완전성으로 해석하지 않는다.

## 4. 읽기·현재성·권한 경계

1. 기존 read-only source context issuer로 현재 scope/route/publication을 capture한다. 저장된 명시 route가 없으면 `READ_ROUTE_MODE_UNAVAILABLE`로 끝낸다. 조회를 위해 scope/route 저장소를 초기화하지 않는다.
2. 기존 owner reader로 page를 읽고 선택된 manifest·registry·canonical body·Micro read 결과·raw State/head·State response view·worldline metadata·correction root/records·lore mapping을 private readback 목록에 둔다.
3. 투영 후 해당 읽기를 다시 실행해 exact relevant JSON을 비교하고, 허용 lore의 native body/rendering/activation도 다시 비교한다. 중간 본문 변경은 `LIBRA_GRAPH_READER_BODY_CHANGED`, lore 변경은 `LIBRA_GRAPH_READER_LORE_CHANGED`로 결과를 거부한다. 없는 correction journal의 reader가 만드는 root timestamp는 identity가 아니므로 비교에서는 제외하며 실제 저장 root는 별도로 확인한다.
4. restore epoch/dispose와 captured source context의 현재성을 다시 확인한다. 반환 뒤에는 request-local identity handle registry를 clear하고 capture handle을 release한다.

이는 owner reader projection의 재확인이다. `readerValidation.storedSelectedBodiesRechecked:true`는 저장 본문/선택한 reader 뷰의 비교이며 원본 native text나 전체 독립 dependency/readset의 최종 delivery 인증을 뜻하지 않는다. 기존 issuer가 보고하는 native identity-only 한계, `actualHostQualified:false`, `originalTextCompared:false`, `nativeSourceCaptureAdmission:'unsupported'`를 유지한다. `authority:'descriptive_only'`와 **`modelDispatchEligible:false`**는 공개 ID·DTO·verified 필드로 우회할 수 없다.

이 경로는 catalog persistence·LLI upgrade/persistence loader를 호출하지 않는다. query-triggered analysis·document embedding·State patch/replay·generation publication을 시작하지 않는다. 기존 legacy normal query에서 파생 쓰기가 존재하는 사실은 별도의 F-4 이전 대상이며 이번 명시적 read-only 경로 검증으로 해결됐다고 보고하지 않는다.

## 5. 재현 가능한 검증

~~~sh
node PROGRAM/tests/libra_memory_graph_identity_test.cjs
node PROGRAM/tests/libra_memory_graph_reader_contract_test.cjs
node PROGRAM/tests/libra_memory_graph_reader_runtime_test.cjs
node PROGRAM/tests/libra_memory_graph_assembly_test.cjs
node PROGRAM/tools/sync_libra_memory_network.cjs --check
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
~~~

- identity suite: 기존 14개 투영·식별·binding·충돌/권한 검증.
- reader schema suite: 11개. 네 자료·정본 ID ambiguity/legacy·Micro span/head/source-only·State 누락/근거/revision·Micro claim digest/cardinality·lore exact rendered window/removed ambiguity·cross-scope/count-budget를 검증한다. 순수 JSON fixture이며 physical proof 검증으로 보고하지 않는다.
- 등록 owner API suite: 기존 실제 writer와 chat listener/Micro producer를 실행해 자료를 생성한 뒤 shipped `getMemoryGraphProjectionPage()`를 호출한다. mock model·합성 native host이며 test-only graph assembly로 API를 대체하지 않는다. route 설정은 테스트 준비 단계의 명시 저장이다.
- assembly suite: 두 graph factory의 정확한 embedding, 누락·stale·중복·reversed marker·잘못된 insertion anchor 및 builder의 fail-closed를 검증한다.

| 등록 API 시나리오 | 확인한 결과 |
| --- | --- |
| plugin_only / server_only | 각각 48 node·81 edge; canonical 13, Micro 1, State 17, lore 2 unit; endpoint·entity·기록된 derivation 연결 |
| 조회 부작용 | 측정 구간 provider 호출 0, plugin storage write 0, server mutation batch 0; actual Micro/head와 State/head 보존 |
| 사용자 정정 / clear | 실제 correction writer로 set/clear 후 해당 journal basis·역할·명시적 clear 보존; 옛 canonical derivation 없음 |
| producer 실패 | 실제 fallback source-only excerpt 500자, claim/fact 승격 없음 |
| 읽기 경합 / 저장 route 없음 | 실제 선택 canonical 저장 본문을 중간 변경하면 거부; route 없음에서도 write/초기화 0 |
| scope/options/page | foreign scope·supplied records 거부; node 상한 partial, Micro cursor continuation 및 turn 목록 변경 후 old cursor 거부 |

기존 network projection/assembly/Micro lexical·LLI·registered beforeRequest parity 회귀도 실행한다. 기존 graph OFF/ON와 server_only packet/scorer 보존은 migration 회귀 증거이며 새 통합 검색 품질의 acceptance가 아니다. source-profile LIBRA build는 factory 동기화와 생성물 syntax를 검증한다.

## 6. 다음 gate

후속 [UM2 page/cache 계약](LIBRA_UM2_PAGE_CACHE_CONTRACT.md)은 첫 계상/읽기 경계를, [durable 계약](LIBRA_UM2_DURABLE_GRAPH_CONTRACT.md)은 window 단위 불변 page/generation·maintenance 게시·독립 reader를 구현했다. 원본 projection API의 descriptive `readerFrame`과 private physical-key collector는 physical proof를 부여하지 않는다. 다음은 공통 access index·exhaustive inventory/delta·전체 source/L0/I/O budget와 Memory Lane 연결이다. count cap으로 byte 예산을 대체하지 않는다. 그 뒤 UM3에서 단일 candidate/frontier/scorer·improved-path reevaluation을 구현한다. final viewer/as-of eligibility·physical readset/dispatch와 실제 설치 호스트 qualification은 별도 gate다. F-3–F-8/F-10 전체를 첫 durable window 구현으로 닫지 않는다.
