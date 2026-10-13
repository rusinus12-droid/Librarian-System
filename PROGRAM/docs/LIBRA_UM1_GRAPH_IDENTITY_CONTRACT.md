# LIBRA UM1 — 공통 NodeID·EdgeID와 근거 식별 계약

- 버전: 1.0 · 2026-10-14.
- 기준: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md) v1.2, [UM0/UM1 대응표](LIBRA_UM0_UM1_ADAPTER_MAPPING.md) F-1/F-2, 플러그인 코드 기준 `b5cffc8`(LIBRA.js bytes는 `9f64f43`과 동일).
- 상태: **F-1/F-2의 1차 계약과 normalized identity 커널·합성 투영 fixture 구현. 실제 owner reader·GraphStore·검색/dispatch 연결은 후속 작업.**
- 구현: [libra_memory_graph_identity.cjs](../tools/libra_memory_graph_identity.cjs).
- 근거: [identity 검증](../tests/libra_memory_graph_identity_test.cjs), [네 자료 fixture](../tests/fixtures/libra_memory_graph_identity_fixture.cjs).

## 1. 결정

NodeID는 새 공통 namespace `libra.node.v1:<SHA256>`를 사용한다. 기존 network candidate ID나 physical `memoryKey`를 새 그래프의 유일한 논리 ID로 선택하지 않는다. 기존 ID·키는 owner locator와 migration alias로 보존한다. A1/B1 identity와 권한은 기존 경로에서 계속 사용하며, 이 커널을 추가했다고 기존 posting 키를 변경하지 않는다.

EntityNode·MeaningNode·SourceNode는 같은 namespace 안에서 층·qualified identity로 구분한다. 이름·표현 유사도·physical key·기존 짧은 hash만으로 합치지 않는다. canonical과 Micro가 같은 원문을 인용하더라도 source attachment와 typed correspondence가 증명되기 전에는 별도 의미·근거로 유지한다. EvidenceFamily의 대응·중복 accounting은 후속 reader/selector 작업이다.

EdgeID는 방향 있는 endpoints, predicate, qualified field/조건, 유효 시간과 **정확한 근거 occurrence**로 정의한다. 같은 두 노드 사이의 여러 관계와 서로 다른 근거를 보존한다. 근거의 birth incarnation이 없으면 revision-bound identity를 사용한다. `microRestoreGeneration`은 복원 epoch이며 birth incarnation으로 대체하지 않는다.

## 2. identity와 binding의 분리

| 자료 | 논리 identity | 현재 binding |
| --- | --- | --- |
| SourceNode | owner namespace·origin scope·object UUID·birth incarnation, 또는 revision-bound snapshot | reader owner·scope/worldline/view·restore epoch·revision·physical locator·읽은 body |
| EntityNode | 승인된 registry의 qualified object identity 또는 revision-bound registry record | registry revision·현재 mapping/body·읽기 frame |
| MeaningNode | kind·SourceNode exact identity·unit identity·정확한 anchor/selector | parent source binding + unit의 현재 읽기 body/locator/revision |
| Basis descriptor | kind·SourceNode exact identity·qualified occurrence identity·근거 anchor | source 및 occurrence의 현재 읽기 binding |
| EdgeID | directed endpoints의 exact identity·predicate·qualifier·validTime·basis exact identity | endpoints·basis·edge projection의 bindings |

identity 튜플과 binding 튜플은 키 순서를 정규화하되 array 순서·scalar type을 보존한다. arbitrary object, accessor, cycle, sparse array, 비유한 number, undefined와 negative zero는 거부한다. hash는 SHA256 primitive를 주입하며, exact tuple을 함께 보관해 label 충돌도 거부한다. hash label 자체는 equality의 권위가 아니다.

`stable`은 supplied identity tuple의 형식을 설명한다. 원본 소유자가 그 원자를 실제로 발급·검증했다는 뜻이나 physical proof가 아니다. adapter가 object UUID/birth incarnation을 증명하지 못하면 다음 fallback을 사용한다.

~~~text
revision_bound identity =
  ownerNamespace + originScope + recordKind + recordKey +
  exact revision + nonrewinding restoreEpoch + exact relevant snapshot
~~~

fallback의 revision/epoch/snapshot은 supplied binding과 일치해야 한다. 이 경우 키·내용·revision이 바뀌면 논리 ID가 바뀔 수 있으며 coverage는 `revision_bound`다. 동일 이름·동일 길이·같은 내용 hash로 안정 객체나 유일한 claim을 만들어 내지 않는다.

## 3. 네 자료의 unit과 basis

| 자료 | MeaningNode selector | Edge basis | 현재 adapter에서 부족하면 |
| --- | --- | --- | --- |
| 정본 | 승인된 claim kind·actor/target·predicate/value/polarity/time/certainty·source attachment. 유일 대응 필요 | 실제 fact/claim occurrence·근거 span/basis | tempFactId/index는 revision-bound locator. native birth나 유일 claim identity로 승격하지 않음 |
| Micro | 승인된 claim과 exact role/message/span 또는 source-only excerpt | receipt/source revision·analysis revision·정확한 span과 attachment | receipt revision은 객체 birth가 아님. source-only는 새 fact를 만들지 않음 |
| State | domain·qualified entity/slot·field 또는 owner가 증명한 collection item | fieldEvidence의 canonical/Micro basis 및 별도 correction journal occurrence | 현재값·clear·unknown·last-known/정정 역할은 binding에 보존. head/field/item의 안정 lifetime 증명이 없으면 revision-bound |
| lore | owner entry + passage identity. 안정 passage가 없으면 rendered revision/context/body + 좌표계·start/end | entry/passage occurrence와 현재 activation/mapping dependency | LLI `linkKey`·label·renderedHash만으로 basis를 확정하지 않음. raw offset unavailable은 그대로 유지 |

State의 동일 qualified field는 lifetime이 증명된 경우 값을 바꿔도 같은 NodeID를 가질 수 있다. 값·certainty·clear/unknown·correction basis는 binding과 관련 엣지를 바꾼다. 자료가 없다는 것을 명시적 clear로 바꾸지 않는다.

canonical/Micro의 typed meaning과 source attachment가 바뀌면 다른 의미 단위다. rendering만 바뀌고 동일 stable unit이 증명되면 NodeID는 유지하고 binding/RepresentationID를 바꾼다. **현재 raw record에서 stable unit을 자동 도출하는 adapter는 이 커밋에 없다.**

## 4. 커널 API와 권한 경계

~~~text
createMemoryGraphIdentity({fingerprint})
  source({identity, binding})
  entity({identity, binding})
  meaning({source, kind, identity, anchor, binding})
  basis({source, kind, identity, anchor, binding})
  edge({from, to, predicate, qualifier, validTime, basis, binding})
  sameIdentity(left, right), sameBinding(left, right), clear(), inspect()
~~~

source/entity/meaning/basis/edge를 frozen descriptive handle로 발급하고 exact tuple은 factory 내부에 둔다. 같은 factory가 발급한 endpoint·source·basis만 결합한다. JSON clone이나 foreign factory handle은 거부한다. unit/basis의 owner namespace·origin scope는 source와 같아야 하며, edge 구성 시 owner/scope/worldline/view/restore frame을 섞지 않는다. 출력 handle에는 source body·secret·opaque physical proof를 담지 않는다.

`association` basis는 `semantic_affinity`에만 사용할 수 있다. 추정 causal/lifecycle label로 claim·정정·현재 상태를 인증하지 않는다. 다른 basis도 owner의 사실 검증을 대신하지 않는다. predicate 목록은 통합 설계 §4.4에 한정한다.

이 handle은 storage read capability나 최종 model dispatch 허가가 아니다. 현재성·nonrewinding epoch·scope 전환·취소·source eligibility는 실제 owner/QueryGraphView가 별도로 검증해야 한다. `clear()`는 이 커널의 handle registry만 폐기한다. durable publication, SourceGraph restart 검증, private physical readset, QueryGraphView authority는 구현하지 않았다. serialized ID를 직접 재신뢰하는 importer도 없다.

이 커널은 memory-only reference implementation이다. retained exact tuple/binding 자료를 무제한 production 캐시로 채택하지 않는다. `inspect()`는 `byteBounded:false`, `runtimeIntegrated:false`, `authority:descriptive_only`를 반환한다. F-3의 byte admission·pin·eviction 및 GraphStore에서의 exact identity 충돌 검증·reissue가 후속 gate다.

## 5. 첫 fixture와 검증 범위

fixture에는 네 자료 종류를 표현하는 **13개 node, 19개 edge**가 있다. 정본 소유 사건, Micro의 임시 양도, State의 ownerRef/holderRef와 correction basis, lore 사용 규칙을 공통 인물·물건에 연결한다. State correction journal은 별도 source occurrence이므로 source object는 다섯 개다. 소유와 실제 보유를 구분한다.

원본은 현재 reader schema를 참고한 합성 record다. owner가 native incarnation을 증명했다는 가정은 하지 않으며 모든 fixture node를 revision-bound로 발급한다. stable ID 동작은 별도의 owner-attested synthetic cases에서 검증한다. 연결성 검사는 투영 구조의 검사이며 실제 질문의 relevance·단일 frontier 검색·현재성 판정·최종 proof 실행을 뜻하지 않는다.

검증 명령:

~~~sh
node PROGRAM/tests/libra_memory_graph_identity_test.cjs
~~~

14개 검증: 비어 있지 않은 네 자료 연결, 논리/physical 분리, namespace/scope/birth 차이, legacy revision binding, typed anchor 변화, 동명이인/source-only 역할 분리, source partition, State unknown/clear binding 구분, 다중 predicate/방향/시간/basis, 근거 incarnation, clone/foreign/frame/clear 거부, association 승격 거부, JSON 정규화, 강제 identity/binding hash 충돌의 atomic 거부.

V01의 **투영·식별 전제**, V14의 **관계 identity 전제**만 검증했다. V01의 검색·dispatch, V13의 전파, V15의 viewer 적격성/비공개 중간 경유, V16–V18의 durable/cache/publication gate는 미실행이다. 기존 A1 `pathBonus=0`와 scorer는 변경하지 않았다.

## 6. 다음 구현 gate

1. 실제 canonical/Micro/State/lore reader가 owner-read snapshot과 normalized unit/basis를 만들도록 연결한다. duplicate claim·동명·rendered coordinates·coverage를 보존한다.
2. stable source/unit/occurrence의 발급 근거를 adapter별로 기록하고, 부족한 자료는 revision-bound로 유지한다. inventory label 존재를 exhaustive owner delta proof로 승격하지 않는다.
3. F-3/F-4의 byte admission·maintenance/query 경계를 확정하고 SourceGraph generation reader에 붙인다. 그 전에는 현행 production posting 키와 독립 ranker를 교체하지 않는다.
4. 같은 fixture를 실제 registered hook·owner physical readset 검증으로 확장하고, UM3에서 단일 frontier 검색/전파를 구현한다.
