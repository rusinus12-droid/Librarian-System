# LIBRA 차세대 통합 메모리 엔진 — 현황·미완료 작업

- 작성일: 2026-10-14 · 문서 버전: 1.2
- 최초 조사 기준: `codex/libra-memory-network-20261013`, [`83caadd3940e121e4d6198bb3619845b59146e91`](https://github.com/rusinus12-droid/Librarian-System/commit/83caadd3940e121e4d6198bb3619845b59146e91)
- 범위: `6320473` 이후 추가된 6개 커밋과 해당 HEAD의 실제 호출 경로·계약·검증 증거
- 현재 기준: `bad8cdf`의 8건 안전성·전달 패치와 이후 native semantic bridge. §12–13이 기존 조사표와 §11의 완료 표현을 갱신한다.
- 목표 계약: [통합 엔진 설계 v1.9](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [UM0/UM1 대응표](LIBRA_UM0_UM1_ADAPTER_MAPPING.md)
- 결함 증거와 재현: [2026-10-14 코드 리뷰](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261014.md)
- 판정: **통합 엔진 미완성. 명시적 unified 설정의 실제 Classic beforeRequest 전달과 최종 private 검증은 등록 API 합성 호스트에서 연결·검증했다. 기본값은 legacy다. 실제 임베딩 adapter·저장 정본 벡터를 단일 frontier에 연결했다. 실제 설치 호스트, 전체 corpus의 durable index 접근, 나머지 소비자 삽입, 품질·규모 검증과 안전한 native GC 삭제는 남아 있다.**

이 문서는 구현한 코드, 실제 연결, 통과한 검증, 미완료 항목을 구분한다. 아래의 미완료 항목은 이 문서 작성으로 해결되지 않는다. 상태·근거는 조사 HEAD에 결속되며 이후 커밋에서는 재확인이 필요하다.

## 1. 완성이 의미하는 것

사용자가 요구한 엔진은 정본·Micro·State·로어북이 같은 연결망에 참여하고, 임베딩·키워드·대상·시간·관계가 **하나의 후보 상태·점수·탐색 큐**에서 작동하는 엔진이다. 같은 generation을 공통 인덱스·캐시·Memory Lane으로 읽고, 실제 채택한 근거를 원본 소유자에게 재검증해 소비자에 전달해야 한다.

현재 완료 판정은 [설계 §13](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md#13-이전-계획과-종료-조건)을 충족하지 않는다. 커널 이름, public API, 플러그인 내장, 순수 테스트 통과만으로 UM 단계 전체를 닫지 않는다. 구현 비율을 숫자로 추정하지 않는다.

## 2. 검증 수준과 표현 규칙

| 수준 | 의미 | 현재 증거 |
| --- | --- | --- |
| E0 코드 확인 | 함수·설정·호출 지점이 존재함 | 새 factory 5개가 LIBRA.js에 내장됨 |
| E1 커널 검사 | 직접 주입한 snapshot·owner mock으로 계약 일부 검사 | Index/Lane/Query/Compiler/Rollout의 순수 suite |
| E2 등록 API 검사 | shipped API·실제 storage bridge를 합성 호스트에서 실행 | reader/page/store의 plugin_only·server_only 검사 |
| E3 요청·소비자 통합 검사 | 실제 beforeRequest/각 소비자가 새 engine을 실행하고 최종 packet·owner 검증·비용을 관찰 | 새 통합 엔진에는 미실행. 이전 엔진의 parity 증거와 구분 |
| E4 설치 호스트 인증 | 실제 RisuAI 설치·지원 workload에서 품질·시간·메모리·호환성 측정 | 미실행 |

표현은 `제한 범위 연결·검증`, `커널 구현`, `미연결`, `결함 확인`, `미검증`, `호스트 지원 없음`으로 구분한다. E1의 `modelDispatchEligible:true` 반환이나 자기 보고식 비용 플래그는 E3/E4 증거가 아니다.

## 3. 현재 실행되는 경로

| 경로 | 조사 HEAD에서 실제 동작 |
| --- | --- |
| 일반 회상·beforeRequest | 기존 catalog/shortlist/hydration/dense·sparse/RRF/gate/packing과 기존 Micro/lore 경로 사용 |
| `getMemoryGraphProjectionPage` | 실제 owner reader에서 네 자료를 읽어 요청 내 공통 노드·관계로 투영. 공개 DTO는 최종 발송 권한을 부여하지 않음 |
| `getMemoryGraphAccessPage` | fresh owner projection을 공통 payload cache의 연속 byte page로 접근. warm에도 원본 검증·투영·encoding 수행 |
| `buildMemoryGraphGeneration` | 명시적 maintenance 호출로 선택된 projection window의 불변 pages·manifest·root 게시 |
| `getMemoryGraphDurablePage` | fresh source에서 window 전체를 재도출해 모든 persisted page와 대조. missing/stale를 query에서 build/repair하지 않음 |
| 새 단일 검색·shadow·legacy fence | tools의 직접 호출 테스트에서 실행. LIBRA의 normal recall/소비자 경로에는 연결되지 않음 |

정적 확인: [LIBRA.js](../plugins/LIBRA.js)의 `createLibraMemoryGraphIndex/Lane/Query/Compiler/Rollout`은 각각 선언 1개이며 해당 factory 호출은 0개다. 공개 recall은 기존 `LibraMemoryCore.recall`을 사용한다. 새 engine 선택 설정·private runtime facade·소비자 연결과 기존 실행 지점의 fence 적용이 필요하다.

## 4. 구성 요소별 현 주소

| 구성 요소 | 현재 구현·검증 | 남아 있는 경계 |
| --- | --- | --- |
| Identity·원본 소유권 | 공통 Source/Entity/Meaning·directed multiedge, exact binding, private issued handle. 실제 reader는 revision-bound | owner가 증명하지 않은 stable UUID/birth를 발명하지 않음. 안정 lifetime·미지원 inherited Micro는 별도 지원 계약 |
| 네 자료 reader | 실제 정본/Micro/State/lore, source-only·정정·clear·부분 근거 보존. E2 | 전체 corpus 열거·native 시간/visibility/lineage metadata·원본 크기 admission 확장. D01 |
| Page/cache | accounted resident/request/staging, partition, pin/LRU, 복원·삭제·unload 무효화. E2 | source workspace·index·frontier·queue·I/O·반환값 등 전체 계상, 새 검색의 page cache 사용 |
| Durable GraphStore | 현재 window의 nodes/edges/bases/units flat pages·manifest/root·재시작 재검증. E2 | exhaustive inventory/delta/tombstone·공통 접근 인덱스와 jobs. GC 커널은 D03 결함·runtime 미연결 |
| Common Index | 메모리 배열의 directory/typed adjacency/postings/reverse dependency. E1 | durable index paging·공통 cache·versioned tokenizer/DF/degree·정확한 delta. D06 |
| Memory Lane | 5개 역할 이름·page/byte 예산·동일 access coalescing·unread cursor. E1 | 실제 I/O·pin·frontier와 연동. 현재 Query는 전체 adjacency 접근을 먼저 drain하며 semantic/context 역할의 실사용 없음 |
| Query | lexical/entity/predicate 신호·단일 점수·strongest-path frontier·witness. E1 | native 적격성·실제 임베딩·공통 page 접근·전체 L0 예산·source coverage. D01/D05 |
| Semantic access | 외부에서 주입한 `queryVectors[nodeId]` 숫자를 semantic score로 사용 | query/document 벡터·RepresentationID·SpaceBinding·provider/profile/metric 호환 검사가 새 경로에 없음 |
| EvidenceCompiler | 후보 선택, caller `correspondenceMap`에 따른 흡수, 평문 역할 라벨, private readset. E1 | 실제 대응/독립 근거·충돌/정정 의미·원문 hydration·소비자별 packet·발송 경계. D02/D04/D07 |
| Rollout | mode seal·shadow 지표·base-request 결과·legacy fence helper. E1 | actual request 모드 봉인·실제 legacy 실행 차단·측정 기반 shadow/cutover. D08 |
| 호스트·성능 | 새 설치 호스트 인증 없음 | 지원 profile·품질/latency/메모리 합격 수치·원본 revision API 지원 범위 |

`durableGenerationVerified:true`는 `current_owner_projection_window_all_persisted_pages`에 한정한다. `inventoryComplete:false`, `ownerAtomicity:false`, `ownerTransportBounded:false`, 전체 API의 `byteBounded:false`, 최종 dispatch 미연결 한계를 유지한다. plugin_only의 root-last/readback은 runtime 내 partial 보장이고 server CAS도 native lore/원문 mutation 전체의 원자성을 증명하지 않는다.

## 5. 먼저 해결할 결함 — D01–D08

이 표의 8건은 조사 HEAD(`83caadd`)에서 재현됐으며, 후속 수리 커밋에서 커널·런타임 경계를 수정하고 E1/E2 회귀 테스트로 검증했다. 실제 ordinary recall(`beforeRequest`) 전환과 자동 GC 연결은 M01–M15 gate에 속한다.

| ID·우선순위 | 재현한 동작 | 수리 내용 및 검증 증거 (상태: 해결) |
| --- | --- | --- |
| D01 · P1 · 시간 | native Micro의 turn은 record/head/receipt에 있고 span에는 없음. plugin_only/server_only에서 turn 6이 asOfTurn 3에 반환 | **해결 (E1/E2)**: `libra_memory_graph_readers.cjs`에서 owner 검증된 `record.turn`/`sessionEpoch`를 Micro unit에 보존하고, `libra_memory_graph_query.cjs`의 `openView`에서 미래 unit·자식 전체가 미래인 `SourceNode`·미래 basis 엣지를 차단. `libra_memory_graph_query_test.cjs` 및 등록 API(`executeMemoryGraphUnifiedQuery`) E2 테스트로 검증 |
| D02 · P1 · 물리 검증 | `assertPhysicalCurrentness` 없이 이전 graph만 반환해도 발송 가능 true | **해결 (E1/E2)**: `libra_memory_graph_compiler.cjs`의 `validateConsumedReadSet`에서 `assertPhysicalCurrentness` 콜백을 필수로 강제(누락 시 `LIBRA_GRAPH_COMPILER_PHYSICAL_VERIFIER_REQUIRED` 거부). `libra_memory_graph_compiler_test.cjs`에서 검증 |
| D03 · P1 · GC | mark 뒤 다른 publisher가 root B를 게시하면 B의 manifest 삭제 | **해결 (E1)**: `libra_memory_graph_store.cjs`의 `collectGarbage`에서 `owner.capture` 핀·manifest/root 무결성 확인 및 각 삭제 직전 `verifyRootsUnchanged()`로 동시 게시 감지 시 즉시 중단(`status: 'aborted_concurrent_mutation'`, 활성 manifest 보존). `libra_memory_graph_index_test.cjs`에서 검증 |
| D04 · P1 · 폐기 | `currentGraph()` 대기 중 `invalidateAll()`을 실행해도 기존 readset이 verified | **해결 (E1/E2)**: `validateConsumedReadSet`의 모든 `await` 직후 및 최종 반환 직전 `assertHandleActive()`(핸들·`revoked`·`compilerEpoch`) 재확인. `LIBRA.js`의 `noteMicroRestoreBoundary`·`deleteCurrentScope`·`cancelMemoryGraphGenerationBuild`·`unload`에 `memoryGraphCompiler.invalidateAll()` 연결 |
| D05 · P2 · coverage | `nodeLimit:5`로 세 family가 `node_work_budget`에 걸려도 query complete | **해결 (E1/E2)**: `libra_memory_graph_query.cjs`에서 `traversalComplete`와 `sourceCoverageComplete`(`node_work_budget`, `*_pages_unread`, 미독 커서 등)를 분리해 원본 투영 절단 시 `complete: false`, `stopReason: 'projection_coverage_incomplete'`, Rollout `deliveryOutcome: 'partial'` 반환 |
| D06 · P2 · 역의존성 | source 변경의 affectedPostingKeys가 비고 DF refresh false | **해결 (E1)**: `libra_memory_graph_index.cjs`의 `compile` 및 `affectedByChanges`에서 `source:` / `node:` → `postingKeys`·`edgeIds` 전이 확장을 수행하고 `lexical:` 포함 시 `requiresGlobalDfRefresh: true` 반환 |
| D07 · P2 · 출력 예산 | maxCharacters 32, body 31인데 packet 129자 | **해결 (E1/E2)**: `libra_memory_graph_compiler.cjs`에서 `formatPacketText`(헤더·역할 라벨·번호·줄바꿈 포함) 기준으로 `select` 예산을 판정하여 `usedCharacters === packet.characterLength <= maxCharacters` 보장 및 실제 채택된 정본 기준으로만 Micro 흡수 |
| D08 · P2 · V05 | 존재하지 않는 bestActivation/bundleDigest/packetDigest 비교로 통과 | **해결 (E1)**: `bundle.bundleDigest`·`packet.packetDigest` 생성 및 `c.score`·`winningWitness` 비교로 수정하고, `index.compile`을 `pages.page()` 캐시 경로에 연결해 실제 cold miss / warm hit / partition eviction / 독립 팩토리 재시작을 `verifyColdWarmEvictionDeterminism`에서 검증 |

모든 결함은 수정 커밋·회귀 검사·증거 수준을 함께 기록한 뒤 닫는다. 현재 테스트가 PASS인 상태는 M01–M15의 전체 통합 완료 조건을 대신하지 않는다.

## 6. 구현·연결 미완료 작업 — M01–M15

`미연결`은 코드가 일부 존재하지만 실제 소유자/요청 경로에 적용되지 않았다는 뜻이다. 아래 항목은 D01–D08과 별개의 작업이며, helper를 추가하거나 bool 진단을 반환하는 것만으로 닫지 않는다.

| ID | 작업과 현재 공백 | 완료 조건·선행 항목 |
| --- | --- | --- |
| M01 | **실제 engine coordinator**: 등록 API(`executeMemoryGraphUnifiedQuery`) 및 `LibraMemoryCore.recall`(`previewUnifiedMemoryRecall`, `unifiedEngineMode: 'unified' \| 'shadow' \| 'legacy'`) 연결 완료(E2/E3); 기본 설정 전환은 호스트 인증(M14) 이후 적용 | request 시작에 mode·owner/scope/worldline/view/epoch를 봉인하고 실제 beforeRequest/명시적 recall이 해당 facade 실행. 소비자에 단일 결과 전달. D01/D02/D04/D05 이후 읽기 전용 연결부터 검증 |
| M02 | **전체 SourceGraph inventory·maintenance**: manifest·`store.build`/`read`에 `unreadRegions`(`canonicalNextCursor`, `microNextCursor`, `hasUnreadSourceWindows`, `exhaustiveDeltaSupported: false`) 기록 완료(E1/E2); 전체 corpus 자동 열거·delta job은 미완 | 승인된 source window들을 cursor로 열거하고 미독 region을 기록. delta/tombstone/복원/불완전 게시·큰 row 처리를 maintenance jobs에 연결. 48 pages/64 conditions 상한을 조용한 corpus 제외로 바꾸지 않음 |
| M03 | **실제 durable 공통 인덱스**: `index.compile`에 `tokenizerVersion`·`projectionSchema`·`dfScope`·`tableDigests` 결속 및 `queryPage`의 공통 `pages` 캐시 연동(`cacheHit` 보고) 완료(E1/E2); 영속 인덱스 샤드 분리는 미완 | node/source·방향/predicate adjacency·entity/slot/time·lexical·semantic index를 generation/schema/tokenizer/representation과 결속해 공통 page/cache로 읽음. 전체 corpus DF·degree의 범위와 digest 검증. D06/M02 |
| M04 | **전체 byte inventory·Cache Manager**: `query.retrieve`에 `l0WorkspaceBytes`/`maxWorkspaceBytes`(`workspace_byte_budget`) 계상 및 `queryPage`의 `pages` pin/release 연동 완료(E1/E2); source read/JSON·전역 힙 전체 계상은 미완 | source read/JSON, L0 후보·witness, index page, frontier/Lane, readset, I/O/in-flight/write barrier의 소유·예산·pin·release를 기록. 동시 요청·고차수·축출·취소에서 admission/backpressure 검증. 전체 heap bounded 주장에는 별도 측정 필요 |
| M05 | **탐색과 통합된 Memory Lane**: 초기 전체 adjacency drain 제거, frontier pop 시 `anchorNodeId`별 `graph_neighborhood` 요청·5개 역할(`query_anchor_access`/`temporal_state_access`/`semantic_access`/`graph_neighborhood`/`context_expansion`) 예산 공유·`resumeCursors` generation/digest 검증(`LIBRA_GRAPH_LANE_CURSOR_STALE`) 완료(E1/E2) | 활성 frontier가 필요한 anchor 페이지를 요청하고 결과에 따라 다음 작업 갱신. lexical/entity/time/semantic/context가 같은 예산을 공유. 축출된 과거 자료 발견, structural 우선 기회, partial/재개 정책과 cursor generation 검증. M03/M04 |
| M06 | **실제 임베딩 adapter·표현 접근**: `sealQueryFrame`·`retrieve`에 `semanticSpace`(`spaceId`/`provider`/`model`/`dimension`/`metric`/`profileDigest`)·`queryEmbedding`·`documentRepresentations` 코사인/내적 유사도 평가 및 불일치 공간 격리(`incompatible_isolated`, 배경 재임베딩 미실행) 구현 완료(E1/E2); 일반 회상 파이프라인 임베딩 브리지 직결은 미완 | query/document representation의 text/chunk·공간·task pair·dimension/metric·profile/auth/view/reset를 검사하고 실제 semantic feature를 공통 scorer/frontier로 공급. 누락은 lexical/entity로 남기고 불일치는 격리. query가 역사 문서 임베딩을 자동 시작하지 않음 |
| M07 | **QueryFrame·native 적격성**: `openView`에서 활성 `EntityNode` 이름/별칭 단일 매칭(`resolvedEntityIds`, 목적어 전용 `target_of` 엔티티 포함)과 다중 엔티티 모호 별칭(`ambiguousAliases`) 분리, `executeMemoryGraphUnifiedQuery`의 `entityRegistry` 자동 주입, `allowedPredecessorWorldlines` 계보 필터 구현 완료(E1/E2) | entity ID/alias ambiguity 해석, scope/owner/native lineage/predecessor/as-of/viewer·lore activation을 owner metadata로 봉인. seed/경유/basis/출력/진단에 동일 적용. source/entity 중계 node도 보호. D01 |
| M08 | **근거 의미·자동 대응**: 동일 턴·동일 주어/주장 어휘 및 명시적 `supersedes`/`derived_from`/`evidenced_by` 기반 정본-Micro 자동 대응(미래 턴·`contradicts`/`reopens` 흡수 금지), 파생 State의 동일 원문 `SourceNode` 중복 계산 제거(`computeIndependentPrimarySources`), `lifecycleStatus` 보존 구현 완료(E1/E2) | owner가 증명한 정본/Micro 동일 사실만 흡수. 동일 원문 파생 자료의 독립 source 중복 계산 방지. 정정·clear/unknown/last-known·충돌 양쪽·증명된 lifecycle 관계를 보존. 미지원 lineage는 coverage로 남김. D05/D07 |
| M09 | **원문 hydration·소비자 adapter**: 소비자별(`planner`/`sga` `@T<turn>` 태그, `hydrateSourceQuotes` 원문 인용 부착, `gradia` 선택 영수증 검증) 포맷터와 `select` 예산 판정을 일원화하고 실제 채택 항목만 readset에 결속 완료(E1/E2); 호스트 `beforeRequest` 전체 소비자 배선은 미완 | Classic/Planner/SGA/Input Writer/GUI/GRADIA가 실제 packet/표시 정책과 출력 예산으로 선택·hydrate. 실제 남은 출력만 consumed readset에 결속. GRADIA owner receipt와 corpus 검증 유지. M08/D07 |
| M10 | **최종 private owner 검증**: 물리 콜백 필수화(D02), `executeMemoryGraphUnifiedQuery`의 원본 스토리지 키 핀(`pinnedValues` + `conditionalReadSet`) 재검증 및 `validateConsumedReadSet`에서 `requiredEdgeBindings`·`requiredBasisBindings` 실시간 대조 완료(E1/E2) | native source/head/registry/correction/lore 및 witness basis/edge와 흡수된 Micro 의존성을 최종 경계에서 검증. SDK readset/lease·restore/route/삭제 fence 사용. unsupported owner 기능을 graph 플래그로 대체하지 않음. D02/D04/M01/M09 |
| M11 | **유지보수·무효화·GC 연결**: `fencedMemoryStorageSet`(비-`memory-graph:v1:` source write)·`noteMicroRestoreBoundary`·`deleteCurrentScope`·`cancelMemoryGraphGenerationBuild`·`unload`에서 `memoryGraphCompiler.invalidateAll()` 및 `pages` 무효화 연결, 등록 API `collectMemoryGraphGarbage` 노출 완료(E1/E2) | 실제 source mutation/설정/profile/복원/삭제/unload에서 대상 generation·page/representation/query hints와 in-flight 작업을 무효화. query에서 durable build/repair를 실행하지 않음. SDK/runtime의 취소·게시·sweep 증거. D03/D06 |
| M12 | **실제 shadow·V05 평가**: `LibraMemoryCore.recall`(`unifiedEngineMode: 'shadow'`)에서 실제 owner 투영 그래프와 legacy 선택 결과를 `runShadowComparison`으로 비교(`shadowInjectedIntoModelPrompt: false`, `doubleInjection: false`, `additionalModelCalls: 0`) 및 `verifyColdWarmEvictionDeterminism` 검증 완료(E1/E2) | 동일 snapshot과 호환 vector에서 legacy/unified 결과를 관찰·비교. packet 주입·provider/model 호출·source write를 실제 trace로 계측. 품질/의도된 차이와 불변식 회귀 구분. cold/warm/실제 LRU/새 VM restart 판정. D08/M01–M10 |
| M13 | **legacy 경로 종료**: `LibraMemoryCore.recall`(`unifiedEngineMode: 'unified'`)에서 요청 시작 시 `sealRequestMode('unified')`·`createLegacyExecutionFence`를 봉인하고 기존 catalog/shortlist/A2/RRF 실행 없이(`legacyRankerExecuted: false`, `cleanCutoverVerified: true`) 단일 패킷 반환 검증 완료(E2); 전체 호스트 기본 전환은 M14 이후 | 지원 unified 요청에서 기존 shortlist/독립 ranker·중복 catalog/block/ELI/LLI/lore cache·A2 재구성 호출 0을 실제 trace로 확인. 필요 호환 importer/legacy-mode 지원·GUI 진단 의미를 문서화. M12 합격 이후 |
| M14 | **지원 profile·호스트/품질/성능 인증**: 수용 수치와 실제 설치 검증 없음 | 두 저장 모드·실제 소비자·restore/변경/경합의 supported profile을 정의. 대표 고정 질의·연결 질문·과거/정정·오래된 자료로 품질/latency/메모리/읽기/호출 비용과 회귀 기준 기록. actual RisuAI 증거와 blocked 범위를 공개 |
| M15 | **진단·계약·릴리스 문서 정합성**: v1.6의 완료 표현과 과거 계약이 충돌 | 요청별 generation/policy/공간/coverage/미탐색 region/witness/실제 채택·검증·비용을 설명. importer·backup/restore·source 소유 경계를 고정. 각 단계 변경마다 manifest/checksum과 구현/검증 범위를 갱신 |

현재 고정 score/역할/전파 계수는 품질 인증값이 아니다. M06/M12/M14에서 같은 평가 세트로 calibration과 ablation을 해야 한다. ANN·학습형 GNN·자동 온라인 가중치 학습은 초기 완성의 필수 항목에 추가하지 않는다.

## 7. 검증 공백과 완료 gate

| Gate | 필요한 관찰·검사 | 현재 판정 |
| --- | --- | --- |
| G1 원본·시간·권한 | 실제 producer/reader의 native 형식, 서로 다른 viewer/as-of/native lineage, 미래·보호 중계, source-only/clear/correction | D01 및 M07/M08 미완료 |
| G2 저장·범위·예산 | 전체 source inventory·durable 공통 index 접근, source 변경 delta/DF·동시 GC/pub·full managed byte admission | D03/D05/D06 및 M02–M05/M11 미완료 |
| G3 semantic 통합 | 실제 query/representation 벡터·호환 공간·missing/invalid profile와 공통 scorer·frontier | M06 미연결 |
| G4 소비자·최종 발송 | 등록 beforeRequest·모든 소비자, 실제 예산/hydration·흡수·원본 수정/취소/복원 중 dispatch 거부 | D02/D04/D07 및 M01/M09/M10 미완료 |
| G5 결정성·shadow | 실제 hit/LRU/독립 VM의 score/witness/bundle/packet, 동일 snapshot baseline·gold와 trace | D08/M12 미완료 |
| G6 전환·품질 | actual unified 요청의 legacy 이중 실행 0, supported workload 수치·설치 호스트 인증 | M13/M14 미완료 |

조사 HEAD에서 기존 그래프 테스트 **9개 파일** 및 등록 reader/pages/store의 두 저장 모드 runtime 검사는 PASS였다. E1 검색 테스트의 Micro evidence는 native producer에 없는 `turn`을 추가했고, V05는 없는 digest를 비교했으며, GC는 concurrent publisher를 검사하지 않았다. 따라서 해당 PASS를 G1–G6 전체 합격으로 승격하지 않는다.

## 8. 작업 순서와 중단 없이 진행할 수 있는 범위

1. **정확성 경계 수리** — D01–D08을 native 형식·경합·실제 출력 기준으로 수정하고 회귀 검사. 특히 D02/D04가 열린 상태에서 dispatch를 연결하지 않고 D03이 열린 상태에서 자동 sweep을 연결하지 않는다.
2. **공통 저장·접근 완성** — M02–M05/M11. generation과 shard/index/cache/Lane의 같은 접근 계약, source delta와 예산·release 검증.
3. **단일 검색의 실제 호출 연결** — M01/M06–M10. 지원 owner/view 범위의 private facade와 소비자를 먼저 합성 등록 경로에서 연결·검증. 이후 실제 shadow 모드를 사용한다.
4. **비교·인증·전환** — M12/M14에서 수치와 supported profile을 고정하고, 합격 범위에 engine selection을 적용한 다음 M13의 중복 경로 종료를 확인한다. M15는 각 단계와 함께 진행한다.

미지원 host 프로토콜은 별도 blocked 항목으로 기록한다. 이를 이유로 이미 가능한 커널 수리·page 접근·합성 통합 검사를 미루지 않는다. 호스트 기능을 얻지 못한 범위는 비용을 기록한 보수적 재읽기 또는 명시적 partial/reject로 남기며, 지원하지 않는 원자성·stable identity·zero warm scan을 선언하지 않는다.

## 9. 호스트 한계와 엔진 자체 미완료의 구분

| 구분 | 항목 | 처리 |
| --- | --- | --- |
| 엔진 자체 | D01–D08, 실제 요청 연결, 공통 인덱스/cache/Lane, 임베딩/소비자/legacy 종료 | 저장소의 구현·등록 API 회귀 검사로 해결할 작업 |
| owner/SDK 기능 | native source identity-only revision, 크기 header·bounded stream/delta, cross-VM CAS·native lore mutation 전체의 원자성 | 지원 여부와 보장 범위 명시. 추가 프로토콜 없이는 partial/exact reread; 발명한 proof 금지 |
| 실행 환경·측정 | 실제 RisuAI qualification, 대표 workload·장비별 비용 | 실측 전 미검증 유지. 작은 bounded 진단부터 단계적 scale |

기존 actual 100k OOM/BLOCKED 기록과 과거 재실행/heap 증액 제한은 그대로 보존한다. 이 문서는 무제한 대형 검사나 호스트 API 변경을 승인하는 문서가 아니다.

## 10. 완료 판정과 추적 방식

초기 지원 profile에서 G1–G6가 증거로 충족되고, 정상 요청이 **네 자료 → 공통 index/cache/Lane → 한 frontier/scorer → 실제 출력 → private owner 검증**을 거쳐 전달하며 legacy 이중 실행이 0일 때 통합 엔진 완료로 판정한다. 지원하지 않는 owner/view/규모는 공개된 partial/blocked 범위로 관리하고 지원 profile의 완료와 섞지 않는다.

각 D/M 항목을 닫을 때 `수정 커밋`, `API/호출 경로`, `회귀 검사·검증 수준`, `원본/파생 데이터 변경`, `지원 profile/남은 한계`를 기록한다. v1.6의 함수 존재/PASS 표기는 최초 커널 구현 이력으로 보존하고, 현재 완료 상태는 이 현황표와 위 gate로 갱신한다.

## 11. 마감 기록 (2026-10-14)

이 절은 M01 관련 3건을 마감하면서 **닫은 것**과 **닫지 못한 것**을 구분해 기록한다. 닫힌 항목에는 재현 명령이 있고, 닫히지 않은 항목에는 선행 조건을 적는다. 닫지 못한 것을 PASS로 적지 않는다.

### 11.1 닫힘 — 라우팅 모드의 단일 출처·검증·기록 (M01 1차)

- `PROGRAM/tools/libra_memory_engine_mode.cjs` 신규. `legacy|shadow|unified`만 허용하고, **미지정이면 기본 `legacy`**(사유를 `DEFAULT_MODE_OPEN_GATES = [E3, E4]`로 명시), 값이 있는데 목록에 없으면 `LIBRA_MEMORY_ENGINE_MODE_INVALID`로 **거부**한다(legacy로 조용히 강등하지 않음). 해석 결과는 `{mode, source, declared, defaultApplied, qualification}`을 갖는 `libra.memory_engine_decision.v1`이다.
- 라벨이 아니라 기록: recall의 세 경로(legacy·shadow·unified) 결과 모두 `diagnostics.memoryEngine`을 갖는다. legacy·shadow는 legacy-base 결과에, unified는 통합 결과에 스탬프된다.
- 정책 블록은 `PROGRAM/plugins/LIBRA.js`에 내장되며, `tests/libra_memory_engine_mode_test.cjs`가 마커 블록을 정규화 비교해 드리프트를 막는다(음성 대조: 한 글자 바꾼 사본은 불일치로 판정).
- 재현: `node PROGRAM/tests/libra_memory_engine_mode_test.cjs` → 10 PASS.

### 11.2 닫힘 — 하드코딩 라벨 제거

- `const engineMode='librarian',unified=true;`를 삭제했다. 캐노니컬 파이프라인의 `unified`는 이제 `isReadableUnifiedEngineVersion(UNIFIED_ENGINE_VERSION)`에서 **파생**한다. 이 경로는 `LEGACY_JOB_REVIEW_REQUIRED` 가드 뒤에 있어 항상 참이지만, 엔진 식별자에서 유도되므로 엔진 버전이 바뀔 때 `unified ? … : 'legacy'` 분기가 죽은 코드로 남아 거짓 라벨을 쓸 수 있었던 경로가 사라진다.
- 검사: 같은 스위트가 리터럴 재도입을 부재 단언으로 금지한다.

### 11.3 닫힘 — 랭킹 계수의 출처 표기

- 가중치를 `tools/libra_memory_graph_query.cjs`의 `MEMORY_ENGINE_SCORE_WEIGHTS`(frozen)로 명명하고 `calibration: 'unmeasured'`를 스스로 선언하게 했다. 값과 연산 순서는 이전과 동일하다(동작 불변).
- 이 영역의 원본은 도구 소스다: 내장 영역(44700–48399)은 `tools/sync_libra_memory_graph.cjs`가 재생성하며, 직접 플러그인만 고치면 다음 동기화에서 되돌려진다. 편집 후 `--check`가 `changed:false`인지 확인해야 한다.
- 남은 것: 실제 calibration·ablation은 **M14**이며 이 절로 닫히지 않는다.

### 11.4 닫지 못한 것 (선행 조건 명시)

| 항목 | 상태 | 선행 조건 |
| --- | --- | --- |
| E3 요청·소비자 통합 | **경계까지 닫힘**. recall 진입점이 라우팅을 실행하고, compiler 경계가 6개 소비자 각각의 packet 정책을 검증한다(헤더 라벨·문자 예산·plan_lines 포맷·gradia receipt·dispatch 자기주장 금지). 남은 것: 소비자 **호스트측** hydration(Classic·Planner·SGA·Input Writer·GUI·GRADIA 실제 삽입) | 각 소비자 호스트의 실제 packet 삽입부 |
| E4 설치 호스트 인증 | **미실행 — 외부 차단** | 실제 RisuAI 설치 호스트 |
| M04 전체 byte inventory | **선언까지 닫힘**. 12개 범주 전부에 결정이 있다: 4개는 계상(rendered_packet·bundle_body·l0_candidate_workspace·lane_page_payload), 8개는 사유와 함께 미계상. `byteBounded:false` 유지. 남은 것: 미계상 범주의 실제 counter 구현과 유계 주장 | 미계상 8범주 counter + 유계 판정 fixture |
| M14 품질·latency·메모리 수용 수치 | **미실행**. 계수는 코드에서 `calibration:'unmeasured'`로 표기됨 | 고정 평가 세트 + 대표 workload |
| 기본값을 unified로 전환 | **금지(의도적)**. 기본은 `legacy`이고 결과에 `qualification: 'unqualified_until_E3_E4'`가 남는다 | E3·E4·M14 종료 |

### 11.5 변경 파일

`PROGRAM/tools/libra_memory_engine_mode.cjs`(신규), `PROGRAM/tests/libra_memory_engine_mode_test.cjs`(신규), `PROGRAM/tools/libra_memory_graph_query.cjs`, `PROGRAM/plugins/LIBRA.js`(동기화 재생성 포함).

### 11.6 소비자·바이트 마감 (E3·M04)

- **E3 (경계)**: `tools/libra_memory_graph_compiler.cjs`에 `CONSUMER_PACKET_POLICIES`(6 소비자)와 `verifyConsumerPacket()`을 추가하고, `render()`가 `consumerVerification`과 `byteInventory`를 반환하게 했다. 검증 항목은 이 경계가 실제로 확인할 수 있는 것만이다: envelope 스키마, 헤더 `consumer=<id>` 라벨, `characterLength` 정합, 소비자 문자 예산, 항목 수, planner·sga의 `@T` 라인 패밀리, gradia의 `gradiaSelectionReceipt`(그 외 소비자의 불필요한 receipt 금지), 그리고 packet이 스스로 `modelDispatchEligible:true`를 주장하지 않을 것.
- **M04**: `MEMORY_BYTE_CATEGORY_DECISIONS`(12범주)와 `memoryByteInventory()`가 계상값·예산·미계상 사유를 한 구조로 반환한다. `byteBounded`는 **false**로 고정되어 있다 — 전체 API가 유계라고 주장하지 않는다.
- 재현: `node PROGRAM/tests/libra_memory_graph_consumers_test.cjs` → 9 PASS. 구성: 6 소비자 전수 검증 + **음성 대조 6종**(라벨 오타·예산 초과·gradia receipt 누락·비해당 소비자의 receipt·plan_lines를 default로 렌더·dispatch 자기주장·미선언 소비자 거부) + 범주 누락/중복 검사 + NaN 누출 금지 + 플러그인 내장 확인.
- 한계: 이 마감은 **compiler 경계**의 검증이다. 소비자 호스트가 실제로 이 packet을 삽입·hydration하는지는 E3의 남은 절반이며, 실제 GRADIA/Classic/Planner 호스트가 필요하다.

### 11.7 변경 파일 (E3·M04)

`PROGRAM/tools/libra_memory_graph_compiler.cjs`(정책표·검증기·인벤토리, 도구가 원본), `PROGRAM/tests/libra_memory_graph_consumers_test.cjs`(신규), `PROGRAM/plugins/LIBRA.js`(동기화 재생성), `PROGRAM/docs/LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md`.


## 12. `8d0b640` 리뷰의 8건 패치와 현재 제한

§11의 “E3 경계 닫힘”, “4개 바이트 범주 계상”은 당시 구현자의 마감 기록이다. 실제 `beforeRequest`는 private 정본 proof가 없는 새 객체를 이전 packet builder에 전달해 실패했고, planner 검증 실패가 dispatch를 차단하지 않았다. 바이트 표에는 문자 수와 누락된 L0/Lane의 0이 들어갔다. 아래는 그 재현을 수정한 현재 계약이며 전체 엔진 완료 판정은 아니다.

| 리뷰 ID | 수정한 동작 | 회귀 증거 |
| --- | --- | --- |
| R1 | unified 결과를 기존 정본 DTO로 재해석하지 않고 실제 Classic 요청에 역할을 보존한 packet으로 전달. 내부 WeakMap에 보관한 issuance/owner verifier로 **주입 직전** packet·원본 의존성을 검증. 원래 요청 deadline, 최신 요청 소유권, 응답 경계, 주입 위치·전체 문자 예산과 명시적 Live Tail/receipt 검증 유지 | 등록 `beforeRequest`에서 두 저장 모드의 실제 주입; legacy 양성 대조; recall 후 Micro 변경 시 원래 요청 보존; 이전 요청이 새 요청 진단을 덮어쓰지 않는 경합; 명시적 최근 대화 주입 |
| R2 | 정본의 실제 `evidenceSpans.ref` (`t5-a`, `t2-u`)에서 주장별 시간 도출. 여러 근거는 가장 늦은 턴까지 필요. 미래 노드·연결·basis를 제외하고 시점 불명 정본은 과거 질의에서 제외하며 `historicalCanonicalUnavailable` 및 partial coverage 공개 | 두 저장 모드에서 같은 T1–5 batch의 T5 사실 제외·T3 사실 유지; 복수 참조·불명 참조·witness 경로 검사 |
| R3 | GC가 SDK의 전체 durable key 목록으로 루트를 찾음. RAM knownKeys나 caller candidateKeys만으로 mark를 완료하지 않음. 완전한 owner inventory가 없으면 `blocked_incomplete_inventory` | 재시작 후 실제 루트 재발견, caller가 활성 page만 넘겨도 삭제 없음·durable read verified |
| R4 | sweep에 owner의 원자적 namespace fence와 conditional delete를 요구. 루트뿐 아니라 새 publisher·진행 중 build·reader pin의 보호가 삭제와 같은 연산에 속해야 함. 현재 native bridge는 해당 기능이 없어 `blocked_atomic_gc_unavailable`, `deletedKeys:[]` 반환 | store의 마지막 확인 후 publisher가 새 루트를 게시하는 경합에서 조건부 삭제 거부; 새 manifest/read 보존; fence 없는 owner 삭제 금지 |
| R5 | 단어 overlap·같은 턴·같은 인물·단순 derived_from/증거 edge·caller correspondenceMap으로 Micro를 흡수하지 않음. adapter가 발급한 유일한 scalar claim의 주체·domain·field·set/clear·값·시제·확실성·정확한 원문 위치/내용 digest가 같고 정본이 실제 채택될 때만 흡수 | 동일 native-shaped scalar 원문/값의 양성 대조; 부정문·다른 값/대상/원문·중복 claim 보존; 정본이 예산 때문에 탈락하면 Micro 유지; 흡수한 Micro 의존성도 최종 검증 |
| R6 | planner/sga의 모르는 시점은 `@time_unknown`으로 표시. 줄바꿈을 escaped text로 렌더하고 헤더 항목/출처 수를 정확히 확인. 빈 packet은 정상 빈 결과. verification 실패는 base_request_only로 전환하고 dispatch 차단. public JSON clone에 private 권한 없음 | native 정본·State·lore가 포함된 5 소비자 packet 검증; malformed header·format·receipt·clone·invalidate 음성 대조; rollout에서 실제 verification 실패 강제 후 packet/dispatch 거부 |
| R7 | index compile/query가 staging·request·resident·integrity·disposed 실패를 원래 배열/JSON 복사로 우회하지 않음. 큰 행 재시도도 설정된 page ceiling과 기존 admission 안에서만 실행 | 256-byte staging 실패, decode 무결성 실패, dispose 후 query 모두 결과를 내지 않고 명시적 거부; lease/pin/staging 누수 없음; 큰 행의 정상 accounted decode |
| R8 | packet/body는 UTF-8 encoded byte 수. L0는 query의 accounted estimate, Lane은 누적 payload 전송량과 실제 예산을 연결. 문자 예산은 `characterBudgets`로 분리하고 미측정값은 null·missingMeasurements로 표시 | 한글 native packet의 Buffer.byteLength와 일치; L0/Lane 실제 diagnostics·예산 일치; 누락 계측을 0으로 주장하지 않는 음성 대조 |

### 12.1 GC adapter 계약과 안전한 제한

store의 `captureGCInventory(prefix)`는 owner가 완전한 key 목록과 namespace fence를 제공하는 경계다. `deleteConditional({key, expectedRaw, prefix, inventory, roots})`는 그 fence, candidate 값, 루트의 동일성을 원자적으로 확인하고 삭제해야 한다. 이름만 같은 함수나 루트별 reread로 원자성을 주장할 수 없다. 진행 중 publisher/build와 reader가 보호되지 않는 adapter는 fence를 제공하면 안 된다.

등록 native API는 full SDK inventory로 **dry-run mark와 후보 조회**를 지원한다. plugin_only·server_only 모두 현재 원자적 namespace GC 프로토콜이 없으므로 실제 sweep을 보류한다. 이는 기존의 위험한 삭제를 막은 패치이며 **native GC 기능 완료가 아니다**. 원본·소스·State에는 쓰지 않는다. 이 계약을 추가할 다음 작업에는 restart·새 루트 생성·build/read pin·ABA·삭제 직전 경합 검사가 필요하다.

### 12.2 검증 명령과 수준

PROGRAM 디렉터리에서 Node 24로 실행한다.

```bash
node --test tests/libra_memory_graph_*test.cjs tests/libra_memory_engine_mode_test.cjs
node --check plugins/LIBRA.js
node tools/sync_libra_memory_graph.cjs --check
node tests/program_data_layout_test.cjs
node tools/build_plugins.cjs --plugin libra --profile source --no-minify --out /tmp/libra-memory-patch-build
```

새 직접 재현은 `tests/libra_memory_graph_patch_contract_test.cjs`, `tests/libra_memory_graph_patch_runtime_test.cjs`에 있다. runtime suite는 실제 등록 API·SDK bridge·source writer·beforeRequest를 사용하며 provider와 설치 호스트는 fixture다. 두 저장 모드의 등록 경로 증거는 E2/E3 일부이며 실제 RisuAI E4와 구분한다. manifest/checksum·내장 동기화도 갱신한다.

### 12.3 남은 우선 작업

1. native embedding 연결은 §13에서 1차 구현했다. 실제 provider 평가·calibration과 다른 자료의 representation 생산/접근은 남아 있다.
2. 현재 projection window의 메모리 내 배열 compile에서 전체 corpus의 durable index/shard 탐색으로 이전한다. source reader·index build·private readset·동시 I/O를 포함한 peak 예산을 계측한다.
3. Planner·SGA·Input Writer·GUI·GRADIA의 실제 삽입 경계를 연결한다. GRADIA는 owner selection receipt verifier 없이 dispatch를 허용하지 않는다.
4. storage owner에 namespace GC fence와 publisher/build/reader 보호 프로토콜을 구현한 뒤 native sweep을 활성화한다.
5. 실제 설치 호스트·평가 세트·규모/latency/메모리 수용 기준을 검증하고 legacy 기본값 전환·중복 경로 종료를 결정한다.

M04의 `countedBytes`는 서로 다른 논리 계측값의 합이다. packet/body는 중첩하고 Lane은 누적 전송량이므로 peak heap이나 전체 유계 증거로 읽지 않는다. `byteBounded:false`, 미계상 8범주, unmeasured calibration, default legacy는 유지한다.


## 13. Native 임베딩 연결

`bad8cdf` 이후 [native semantic 계약](LIBRA_UM3_NATIVE_SEMANTIC_CONTRACT.md)을 구현했다. 현재 상태는 §12.3의 “실제 제공자 연결 미완료”를 갱신한다. 외부 모델 품질·실제 설치 호스트·전체 corpus 전환의 완료는 아니다.

- 기존 제공자 설정/adapter/query cache와 request ledger를 사용해 질의 벡터를 생성한다. native projection source의 저장 global 벡터와 실제 task pair·해석된 차원·profile/descriptor·projection text/payload·record scope/revision을 대조한다.
- source representation을 공통 scoreCandidate·하나의 frontier에 넣고 원래 evidence/entity/derivation 연결로 확장한다. 정본 global vector를 개별 fact vector로 복사하지 않는다. Micro·State·lore는 공통 typed/lexical/graph 접근으로 참여한다. query 중 document embedding/reanalysis/State writes는 0이다.
- 질의 캐시의 scope/worldline/restore/view·auth/config epoch를 보존한다. warm/restart/coalescing·OpenAI·Cohere의 search_query/search_document와 auto dimensions를 등록 fixture에서 확인한다.
- source와 server vector readset은 provider 대기 이전에 캡처한다. 사용한 실제 vector body와 설정 binding도 최종 private dispatch에 검증한다. provider 실패/timeout은 동일 kernel의 lexical/graph 조회로 처리하되 원본이 바뀌면 augmentation을 거부한다.
- representation budget 탈락을 result와 bundle의 partial/queryComplete에 함께 반영한다. standalone shadow는 warm cache만 읽고 새 embedding을 제출하지 않는다.
- plugin_only/server_only가 지원 profile이다. mirror는 기존 readonly owner 계약에 따라 embedding 제출 전에 명시적으로 거부된다. 기본 모드는 legacy다.

새 검사는 `tests/libra_memory_graph_semantic_test.cjs`, `tests/libra_memory_graph_semantic_runtime_test.cjs`다. 실제 등록 API·native writer·SDK/adapter와 controlled HTTP 응답을 사용하며 실제 외부 embedding 모델의 의미 정확도는 측정하지 않았다. 이번 벡터 재사용 범위는 **정본 global projection**이고, section/다른 자료의 새 벡터 생산·durable semantic pages·전체 corpus 인덱스·다른 소비자·GC·E4/M14는 미완료다. representationBytes는 채택한 numeric workspace의 계상 추정이며 전체 peak heap의 상한이 아니다.
