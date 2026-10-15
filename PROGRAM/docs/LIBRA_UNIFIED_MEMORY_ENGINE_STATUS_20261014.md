# LIBRA 차세대 통합 메모리 엔진 — 현황·미완료 작업

- 작성일: 2026-10-14 · 갱신일: 2026-10-15 · 문서 버전: 1.12
- 최초 조사 기준: `codex/libra-memory-network-20261013`, [`83caadd3940e121e4d6198bb3619845b59146e91`](https://github.com/rusinus12-droid/Librarian-System/commit/83caadd3940e121e4d6198bb3619845b59146e91)
- 최초 조사 범위: `6320473` 이후 추가된 6개 커밋과 해당 HEAD의 실제 호출 경로·계약·검증 증거
- 현재 코드 확인 기준: `e542ce8` 이후 N01-C2 명시적 보유 예약·수명과 코퍼스 유지보수 admission. 최신 실행·증분 구현은 §19–22, 리뷰·패치는 §23, 원본/저장 읽기·JSON admission과 잔여 작업은 §24–25 및 다음 과제 v1.9을 우선한다.
- 목표 계약: [통합 엔진 설계 v1.18](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [UM0/UM1 대응표](LIBRA_UM0_UM1_ADAPTER_MAPPING.md), [다음 과제 N00–N07](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)
- 결함 증거와 재현: [2026-10-14 코드 리뷰](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261014.md), [2026-10-15 최근 커밋 리뷰·패치](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261015.md)
- 판정: **통합 엔진 미완성. 기본 unified의 Classic·GUI·GRADIA 셰도우/AIDE·인풋 작성기와 최종 private 검증을 제한 연결했다. 전체 owner 구간의 단일 그래프·공통 영속 index를 구축하고 실제 검색에서 재사용한다. 정본 벡터와 질의 임베딩도 같은 frontier를 사용한다. 신규 게시 인덱스는 선택적 저장 페이지로 읽는다. 원본 증분 검증·구축 재개·대형 행 분할도 연결했다. 증명 보장 확대, 총 자원 계상, 실제 설치·품질/규모 검증과 안전한 native GC는 남는다. 기본·유일한 serving 엔진은 unified다. 이전 shortlist/RRF/MMR·catalog 준비·최종 renderer는 제거했다.**

이 문서는 구현한 코드, 실제 연결, 통과한 검증, 미완료 항목을 구분한다. 아래의 미완료 항목은 이 문서 작성으로 해결되지 않는다. 상태·근거는 조사 HEAD에 결속되며 이후 커밋에서는 재확인이 필요하다.

§2–11에는 최초 조사와 후속 구현자의 당시 기록이 포함된다. 최신 실행·증분 판정은 §19–22, 리뷰·남은 작업은 §23–25를 우선한다. §2–18의 기본값·구간 제한·소비자 미연결 설명은 당시 기록이다. 특히 옛 `planner/sga/input_writer` 포맷 검사 기록을 LIBRA의 활성 실행 기능으로 읽지 않는다. 현재 연결 대상은 LIBRA Classic·GUI와 별도 GRADIA의 셰도우·AIDE·인풋 작성기이며, 작성기의 읽기도 별도 미전송 제안 계약으로 제한 연결했다(§17).

## 1. 완성이 의미하는 것

사용자가 요구한 엔진은 정본·Micro·State·로어북이 같은 연결망에 참여하고, 임베딩·키워드·대상·시간·관계가 **하나의 후보 상태·점수·탐색 큐**에서 작동하는 엔진이다. 같은 generation을 공통 인덱스·캐시·Memory Lane으로 읽고, 실제 채택한 근거를 원본 소유자에게 재검증해 소비자에 전달해야 한다.

현재 완료 판정은 [설계 §13](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md#13-이전-계획과-종료-조건)을 충족하지 않는다. 커널 이름, public API, 플러그인 내장, 순수 테스트 통과만으로 UM 단계 전체를 닫지 않는다. 구현 비율을 숫자로 추정하지 않는다.

## 2. 검증 수준과 표현 규칙

| 수준 | 의미 | 현재 증거 |
| --- | --- | --- |
| E0 코드 확인 | 함수·설정·호출 지점이 존재함 | 새 factory 5개가 LIBRA.js에 내장됨 |
| E1 커널 검사 | 직접 주입한 snapshot·owner mock으로 계약 일부 검사 | Index/Lane/Query/Compiler/Rollout의 순수 suite |
| E2 등록 API 검사 | shipped API·실제 storage bridge를 합성 호스트에서 실행 | reader/page/store의 plugin_only·server_only 검사 |
| E3 요청·소비자 통합 검사 | 실제 beforeRequest/활성 소비자가 새 engine을 실행하고 최종 packet·owner 검증·비용을 관찰 | Classic과 GRADIA 셰도우·AIDE·명시적 인풋 작성기의 등록 합성 호스트 경로 검증(§16–17). 실제 설치 인증은 미완; 구형 formatter 검사는 활성 소비자 연결의 증거가 아님 |
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
| M06 | **실제 임베딩 adapter·표현 접근**: `3e589dd`에서 실제 provider/query cache와 저장 정본 global vector를 명시적 unified/Classic의 공통 scorer/frontier에 연결(§13). section·다른 자료의 표현 생산·durable vector page와 실제 모델 품질은 미완 | query/document representation의 text/chunk·공간·task pair·dimension/metric·profile/auth/view/reset를 검사. 누락은 lexical/entity로 남기고 불일치는 격리. query가 역사 문서 임베딩을 자동 시작하지 않음. 다음 과제 N02/N06 |
| M07 | **QueryFrame·native 적격성**: `openView`에서 활성 `EntityNode` 이름/별칭 단일 매칭(`resolvedEntityIds`, 목적어 전용 `target_of` 엔티티 포함)과 다중 엔티티 모호 별칭(`ambiguousAliases`) 분리, `executeMemoryGraphUnifiedQuery`의 `entityRegistry` 자동 주입, `allowedPredecessorWorldlines` 계보 필터 구현 완료(E1/E2) | entity ID/alias ambiguity 해석, scope/owner/native lineage/predecessor/as-of/viewer·lore activation을 owner metadata로 봉인. seed/경유/basis/출력/진단에 동일 적용. source/entity 중계 node도 보호. D01 |
| M08 | **근거 의미·자동 대응**: 동일 턴·동일 주어/주장 어휘 및 명시적 `supersedes`/`derived_from`/`evidenced_by` 기반 정본-Micro 자동 대응(미래 턴·`contradicts`/`reopens` 흡수 금지), 파생 State의 동일 원문 `SourceNode` 중복 계산 제거(`computeIndependentPrimarySources`), `lifecycleStatus` 보존 구현 완료(E1/E2) | owner가 증명한 정본/Micro 동일 사실만 흡수. 동일 원문 파생 자료의 독립 source 중복 계산 방지. 정정·clear/unknown/last-known·충돌 양쪽·증명된 lifecycle 관계를 보존. 미지원 lineage는 coverage로 남김. D05/D07 |
| M09 | **원문 hydration·활성 소비자 adapter**: Classic 최종 전달은 제한 검증. LIBRA Planner·SGA·Input Writer 실행은 퇴역했고 kernel의 옛 formatter 지원과 구분한다. 별도 GRADIA 셰도우/AIDE는 기존 서버 읽기만 연결; 인풋 작성기는 회수 없음. 새 unified reader·선택 영수증 verifier·작성기 세션은 미완 | LIBRA Classic·GUI와 별도 GRADIA의 셰도우·AIDE·인풋 작성기가 자기 권한/예산으로 선택·hydrate하고 실제 채택만 readset에 결속. 인풋 작성기는 미전송 입력 계약을 먼저 정의. M08/D07, 다음 과제 N00/N03/N04 |
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

이 절은 M01 관련 3건을 마감할 당시의 **구현자 기록**이다. 이후 `bad8cdf`의 리뷰(§12)가 이 절의 E3·M04 마감 표현 일부를 반박했으므로 **최신 판정은 §12–14를 우선한다.** 여기서 유지되는 항목과 정정된 항목을 구분해 표시하며, 정정된 항목을 완료로 읽지 않는다.

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
- §12 리뷰의 R1–R8은 위 11.1–11.3(모드 정책·라벨·가중치 표기)을 다루지 않는다(코드·문서 대조). 이 세 항목은 유지된다.

### 11.4 닫지 못한 것 (선행 조건 명시)

| 항목 | 상태 | 선행 조건 |
| --- | --- | --- |
| E3 요청·소비자 통합 | **정정 — 커널 경계 한정이며 미완**. compiler 경계에 검증기는 있었으나 R6에서 **검증 실패가 dispatch를 차단하지 않았고 위조 카운트·개행 주입을 통과**시켰다(현재는 실패 시 `base_request_only` 전환 + `packet: null`). 또 활성 소비자는 **LIBRA Classic·GUI와 별도 GRADIA**이며 `planner`·`sga`·`input_writer`는 퇴역했다 — 커널의 옛 packet 형식 지원은 활성 기능이 아니다. 남은 것: Classic 최종 전달의 실제 호스트 검증과 GRADIA 새 엔진 읽기(N03) | 활성 소비자 각각의 실제 주입·검증, GRADIA 읽기 adapter |
| E4 설치 호스트 인증 | **미실행 — 외부 차단** | 실제 RisuAI 설치 호스트 |
| M04 전체 byte inventory | **정정 — 커널 경계 한정**. R8이 당시 계상의 결함을 지적했다: packet/body를 **문자 수로 계상**했고 미측정값을 **0으로 강제**해 "비용 0"을 주장했다. 현재는 UTF-8 바이트 계상, `characterBudgets` 분리, 미측정은 `null` + `missingMeasurements`이며 `byteBounded:false`가 유지된다. 남은 것: 미계상 범주의 실제 counter·누적 전송량·resident·peak heap 계측 연결(N01) | 미계상 범주 counter + 유계 판정 fixture |
| M14 품질·latency·메모리 수용 수치 | **미실행**. 계수는 코드에서 `calibration:'unmeasured'`로 표기됨 | 고정 평가 세트 + 대표 workload |
| 기본값을 unified로 전환 | **금지(의도적)**. 기본은 `legacy`이고 결과에 `qualification: 'unqualified_until_E3_E4'`가 남는다 | E3·E4·M14 종료 |

### 11.5 변경 파일

`PROGRAM/tools/libra_memory_engine_mode.cjs`(신규), `PROGRAM/tests/libra_memory_engine_mode_test.cjs`(신규), `PROGRAM/tools/libra_memory_graph_query.cjs`, `PROGRAM/plugins/LIBRA.js`(동기화 재생성 포함).

### 11.6 소비자·바이트 마감 (E3·M04)

- **E3 (경계)**: `tools/libra_memory_graph_compiler.cjs`에 `CONSUMER_PACKET_POLICIES`(6 소비자)와 `verifyConsumerPacket()`을 추가하고, `render()`가 `consumerVerification`과 `byteInventory`를 반환하게 했다. 검증 항목은 이 경계가 실제로 확인할 수 있는 것만이다: envelope 스키마, 헤더 `consumer=<id>` 라벨, `characterLength` 정합, 소비자 문자 예산, 항목 수, planner·sga의 `@T` 라인 패밀리, gradia의 `gradiaSelectionReceipt`(그 외 소비자의 불필요한 receipt 금지), 그리고 packet이 스스로 `modelDispatchEligible:true`를 주장하지 않을 것.
- **M04**: `MEMORY_BYTE_CATEGORY_DECISIONS`(12범주)와 `memoryByteInventory()`가 계상값·예산·미계상 사유를 한 구조로 반환한다. `byteBounded`는 **false**로 고정되어 있다 — 전체 API가 유계라고 주장하지 않는다.
- 재현: `node PROGRAM/tests/libra_memory_graph_consumers_test.cjs` → 당시 9 PASS. (이후 §12의 R6 패치가 위조 카운트·개행 주입 검사를 추가해 현재는 **10 PASS**이며, 위 문장의 검사 목록은 그 이전 내용이다.) 구성: 6 소비자 전수 검증 + **음성 대조 6종**(라벨 오타·예산 초과·gradia receipt 누락·비해당 소비자의 receipt·plan_lines를 default로 렌더·dispatch 자기주장·미선언 소비자 거부) + 범주 누락/중복 검사 + NaN 누출 금지 + 플러그인 내장 확인.
- 한계: 이 마감은 **compiler 경계**의 검증이다. 소비자 호스트가 실제로 이 packet을 삽입·hydration하는지는 E3의 남은 절반이며, 실제 GRADIA/Classic/Planner 호스트가 필요하다.

### 11.6.1 정정 — `bad8cdf`가 반박한 부분

| 당시 기록 (§11.6) | 실제 | 현재 |
| --- | --- | --- |
| "6 소비자 전수 검증" | `planner`·`sga`·`input_writer`는 **퇴역**. 커널이 옛 형식을 지원하는 것과 활성 소비자인 것은 다르다 | 활성: Classic·GUI·별도 GRADIA (v1.10 §16) |
| "검증 항목에 dispatch 자기주장 금지 포함" | 검증 실패가 **dispatch를 막지 않았다**. 위조 `units=99`, 개행 주입이 통과 | R6: 실패 시 `base_request_only` 전환 + `packet: null` |
| "12범주에 결정, 4개 계상" | 계상이 **문자 수**였고 미측정을 **0**으로 강제 | R8: UTF-8 바이트, `characterBudgets` 분리, `null` + `missingMeasurements` |
| "경계까지 닫힘" | 그 시점 실제 `beforeRequest` 전달은 private 정본 proof 부재로 실패 | R1·R2가 수정. §12.3이 남은 우선 작업 |

교훈: 이 경계의 검증은 커널이 자기 포맷터로 만든 packet을 자기 검증기로 확인하는 구조라 **자기참조**였고, 실패 경로가 산출물을 실제로 보류하는지는 별도로 확인해야 했다.

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
3. LIBRA Classic·GUI와 별도 GRADIA의 셰도우·AIDE·인풋 작성기를 활성 대상에 맞게 연결한다. LIBRA Planner·SGA·Input Writer는 퇴역했으며 복원 대상이 아니다. GRADIA의 새 reader/owner selection receipt verifier와 인풋 작성기의 미전송 입력 세션 계약은 [다음 과제 N00/N03/N04](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)를 따른다.
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

## 14. 소비자 호출 재검토와 다음 과제

`3e589dd`의 원격 HEAD와 로컬 소스가 일치하는 상태에서 기존 실행 경로를 재검토했다. [다음 과제 문서](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)에 소스 SHA·근거 파일·N00–N07의 우선순위·선행 조건·완료 기준을 기록했다.

| 확인 대상 | 현재 판정 |
| --- | --- |
| LIBRA Planner·SGA·Input Writer | 실행 함수·공개 실행 API·관련 호스트 설정/작성기 버튼 제거. 예전 응답 설정도 Classic으로 정규화. 재시작·GUI·실제 기본 Classic에서 퇴역 helper 호출 없음 |
| 옛 소비자 이름 | 주석/구형 저장 키/descriptor와 kernel packet formatter에 남음. 포맷 검사·이름 존재를 활성 실행 증거로 사용하지 않음 |
| GRADIA 셰도우·AIDE | 기존 서버 read-session과 요청별 근거 전달은 연결. 새 unified kernel을 읽는 adapter와 native owner 선택 영수증 verifier는 미연결 |
| GRADIA 인풋 작성기 | 활성 작성 기능이나 현재 기억 회수 없음·이전 실행 근거 비사용을 검사. 통합 검색 읽기는 미전송 제안의 별도 세션 계약이 필요한 후속 과제 |

실행한 검사는 [퇴역 runtime](../tests/libra_helper_retirement_runtime_test.cjs)·[Classic 권한](../tests/libra_classic_planner_authority_contract_test.cjs) 2개 파일과 [GRADIA 근거 연결](../tests/gradia/evidence-bridge.test.cjs)·[SQLite 읽기](../tests/gradia_readonly_cross_project_test.cjs) 42개 검사이며 모두 통과했다. 이 증거는 기존 경로의 퇴역/읽기 계약을 확인한다. GRADIA의 새 엔진 연결·실제 설치 호스트 인증을 완료한 것은 아니다.

다음 엔진 구현은 전체 기록의 durable index·공통 cache·Memory Lane(N01)이다. 소비자 범위 정리(N00)와 평가 세트 정의(N06)를 함께 준비하고, 자료별 표현(N02), GRADIA 셰도우/AIDE(N03), 인풋 작성기(N04), 안전한 native GC(N05), 인증 이후 legacy 종료(N07)를 추적한다. 문서 수정으로 runtime 소비자 제한·reader·GC를 구현했다고 표시하지 않는다.

## 15. `9a61245` 후 읽기·표현·delta 경계 패치

N01의 원본 목록/continuation/접근 진단, N02의 표현/생산자 선언, N03의 읽기 출처 계약은 부분 구현이다. GRADIA의 실제 unified 공급자와 전체 corpus의 영속 index는 미연결 상태다.

| 리뷰 결함 | 패치 | 검증 범위 |
| --- | --- | --- |
| 통합 SDK 읽기가 저장 모드 변경을 놓침 | provider capture/current 전후의 assertRoute로 기존 reset/connection/취소 검증 복원 | 변경 전 호출 거부와 provider 대기 중 변경·늦은 응답 거부 |
| GRADIA readSource 변경 후 이전 draft 전달 | readSource를 signature에 포함하고 native scope await 뒤에도 binding을 재확인 | capture·draft 이후·최종 scope await 중 source 변경 시 근거/draft 거부, legacy default 정상 |
| 표현 viewer/taskPair/profile 검증 누락 | query와 representation의 해당 binding을 비교하고 vector 채널에서 격리 | 변경/누락된 field 거부와 기존 정상/lexical 참여 |
| 원본 내용 수정을 window 이동으로 오분류 | sourceOptions·policy/partition·readerFrame으로 구간 판정. sourceStamp/explicit base 자체는 이동 사유에서 제외 | 같은 구간 revision/binding 수정과 removal, 실제 cursor/restore/view 이동 보호 |

직접 회귀 3개 파일의 38개 검사와 영향권 SDK·GRADIA·store/continuation·native semantic을 검증한다. 소스 커널/SDK를 재생성되는 내장 변형에 동기화하며 LIA/RETRACE의 고정 변형은 유지한다. 새 공급자·새 producer·전체 inventory/GC/호스트 인증이 완료됐다고 표시하지 않는다. 상세 연결 상태와 재현 범위는 [다음 과제 §12](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md#12-9a61245-리뷰-후-네-결함-패치)를 따른다.


## 16. GRADIA 셰도우·AIDE의 실제 통합 읽기 연결

N03의 공급자 공백을 server_only의 제한 범위에서 연결했다. LIBRA private owner → 실제 unified query/compiler → 인증된 plugin channel → GRADIA 고정 readonly SDK → `openLibEvidenceRun` → SHADOW·AIDE → 최종 beforeRequest 전달 경로다. 구형 Planner·SGA를 복원하지 않으며 GRADIA 인풋 작성기는 여전히 기억 회수를 하지 않는다.

기존 서버 readonly principal의 capture/current는 권한 확인 witness로만 사용한다. 통합 결과는 owner가 발급한 단일 bundle이며 현재성 확인은 서버 권한과 private compiler 원본 검증을 모두 거친다. 다른 owner의 읽기 방식은 `engine.sourceByOwner`에 남긴다. 연결 URL·scope·route·data/reset·원본·소비자 source 변경과 취소는 진행 중인 근거/초안을 무효화한다. 통합 공급자 부재 시 기존 검색으로 대체하지 않는다.

[구체적인 계약·사용 방법·검증](LIBRA_GRADIA_UNIFIED_READ_CONTRACT_20261014.md)에 한계와 검사 경로를 기록한다. 이 절은 §6 M09와 §14의 **GRADIA unified 공급자·선택 영수증 미연결** 설명을 갱신한다. Classic/GRADIA의 E3 연결은 전체 기록을 읽는 durable index(N01), 다른 자료의 벡터 생산(N02), 인풋 작성기(N04), 설치 인증/품질/규모(N06), 기본값 전환(N07)의 완료를 뜻하지 않는다.


## 17. GRADIA 인풋 작성기의 미전송 제안 읽기

N04를 `server_only`의 명시적 작성 버튼에 연결했다. RP/Novel의 선택지 생성과 번역이 독립된 writer consumer를 사용한다. operation ID·제안 SHA-256·기준 native 대화/캐릭터/로어·설정·scope/owner 영수증을 봉인하고, owner의 proposal 지원을 먼저 확인한다. `factAdopted:false`를 유지하여 검색어·생성 선택지를 현재 사건/State로 올리지 않는다.

실제 선택·편집·복사·sendChat 직전에 정확한 출력과 원본/권한을 검사한다. 전송 권한 확인 대기 중의 정본 교체도 전달을 차단한다. 재생성은 이전 영수증을 해제하고 새 세션을 연다. 취소·늦은 응답·native/설정/연결 변경은 초안 전달 권한을 폐기한다. 셰도우 세션·generic checkpoint·static handoff를 통해 권한을 넘기지 않는다. 미연결 작성기는 기존처럼 새 기억 조회 없이 실행한다. 자동 입력 handler 등록은 계속 비활성이다.

[작성기 읽기 계약](LIBRA_GRADIA_INPUT_WRITER_READ_CONTRACT_20261014.md)에 지원 범위와 실제 UI/native 검증을 기록한다. 이 절은 M09와 §14–16의 **작성기 새 읽기 미연결** 설명을 갱신한다. 전체 corpus의 durable index·공통 cache/Memory Lane, 나머지 representation, native GC, 실제 설치·품질/규모 인증과 legacy 전환은 여전히 후속 작업이다.

## 18. 전체 구간 공통 인덱스의 구축과 검색 연결

N01의 두 실제 공백을 연결했다. 첫째, 정본·Micro의 모든 owner cursor 구간을 순회하고 State·로어북·대상·관계를 한 그래프로 통합한다. 둘째, 이 그래프의 공통 index를 page로 게시하고 실제 unified query가 복원해 사용한다. 구간별 결과를 따로 검색한 뒤 순위를 합치지 않는다. 하나의 QueryFrame·scorer·frontier·Memory Lane·근거 Compiler를 유지한다.

명시적 `buildMemoryGraphCorpus()`와 GUI 구축/취소를 추가했다. 게시 인덱스가 있으면 Classic과 별도 GRADIA의 읽기가 이를 사용하며 검색 중 index.compile은 0회다. 없으면 기존 구간 읽기임을 표시하고, 낡거나 오염된 게시 인덱스는 거부한다. query의 자동 재구축·repair·legacy 전환은 하지 않는다. `required` 검사는 인덱스 부재도 거부한다.

커널 suite는 53구간을 사용해 첫 구간 밖 자료, cold/warm/축출/독립 runtime 복원, 수정·오염·중간 실패·예산·취소·외부 namespace 거부를 확인한다. 등록 API와 실제 storage bridge의 두 모드, GRADIA SHADOW/AIDE·인풋 작성기의 합성 native 호스트도 검증한다. 상세 재현·기본 상한·구현과 검증의 경계는 [전체 구간 공통 인덱스 계약](LIBRA_DURABLE_CORPUS_INDEX_CONTRACT_20261014.md)을 따른다.

**완성 판정은 여전히 미완성이다.** native 전체 구간을 현재 자료에서 재투영하고 공통 index 표 전체를 hydrate한다. 저장 shard를 Lane이 직접 선택해서 읽는 비동기 접근, 원본 증분 검증, 전체 workspace/I/O admission, build 재개·증분 교체는 남는다. 여러 64키 readset과 root CAS는 전체 원본의 원자성을 뜻하지 않는다. 따라서 `inventoryComplete:false`, `ownerAtomicity:false`, `byteBounded:false`를 유지한다. N02의 다른 자료 representation, N05 native GC, N06 실제 설치/품질·규모, N07 기본 전환도 닫지 않는다.

## 19. 레거시 검색의 완전 대체

사용자의 “레거시 검색을 새로운 엔진이 완전히 대체” 지시를 적용했다. 기본값만 변경한 것이 아니라 정상 recall·Classic 최종 주입과 GUI 질의를 단일 엔진으로 전환하고, 실행 가능한 기존 dense/sparse/RRF/MMR·catalog shortlist·블록 router·Micro head corpus·A2 cache 준비·옛 Classic renderer를 제거했다. 자동 정본 채택 후 catalog/evidence-link 보조 준비도 종료했다. 원본 쓰기/백업/가져오기와 명시적 근거 inspector는 유지하며 검색기로 재사용하지 않는다.

`legacy`·`shadow` 설정/요청은 출처 기록과 함께 `unified`로 정규화한다. 새·기존 GRADIA 연결과 인풋 작성기의 LIBRA source도 `unified_engine`으로 통일한다. HAYAKU·Flashback의 별도 읽기와 고정 readonly SDK 권한 witness는 LIBRA의 옛 검색 fallback이 아니다.

저장 공통 index가 없는 첫 요청, 원본 변경, tokenizer 버전 변경도 같은 엔진에서 전 구간 원본을 열거해 request-local 공통 index를 사용한다. 유효한 게시 index는 기존처럼 복원한다. 저장 손상이나 route/reset/연결 변경은 덮어 쓰지 않고 거부한다. 최대 구간/byte 상한 초과 역시 레거시나 첫 구간의 complete 검색으로 위장하지 않는다. Classic은 base request, GRADIA는 해당 근거/초안 차단으로 처리한다.

새 local 설치의 미등록 기본 route는 native owner 전용 관찰로 읽으며 route를 생성하지 않는다. native mirror도 물리 서버 검증을 유지한다. 외부 readonly source 계약의 엄격한 route 요구는 그대로 유지한다. GUI의 한글 조사 검색도 공통 lexical tokenizer를 사용한다.

N07의 기본·유일 엔진 전환과 중복 serving 경로 종료는 이 증분에서 수행했다. N01의 선택적 저장 page 접근·증분 원본 검증·전체 workspace/I/O 계상, N02 추가 representation, N05 native 삭제, N06 실제 호스트/품질·규모 인증은 남는다. 전체 엔진을 완성/인증했다고 판정하지 않는다. 검증 명령과 지원 경계는 [전환 계약](LIBRA_UNIFIED_SEARCH_REPLACEMENT_CONTRACT_20261014.md)을 따른다.

## 20. 선택적 저장 인덱스 읽기

N01의 표 전체 hydration을 신규 게시 인덱스에서 종료했다. corpus root/metadata/directory만 연 뒤 같은 Memory Lane과 frontier가 필요한 posting·adjacency·semantic directory 페이지를 비동기로 요청한다. 공통 Cache Manager에서 reserve/pin/decode/release하며 별도 decoded table cache를 두지 않는다. request의 첫 사용은 저장값을 물리 검증하고, 같은 요청의 재사용은 공통 cache로 처리한다. 물리 page/payload byte admission·trace와 pending I/O 취소·root 교체 검증을 연결했다.

고정 160-unit 커널 fixture에서 23페이지·332,423 B가 3페이지·48,952 B로 줄었고 eager와 점수·근거 경로·bundle/packet digest가 일치했다. 실제 등록 LIBRA와 plugin_only/server_only corpus, GRADIA 소비자 경로도 검증한다. 이는 전체 요청 성능이나 실제 설치 인증은 아니다. 읽지 않은 저장 페이지의 손상까지 query가 검사하지 않으므로 등록 API/진단의 전체 인덱스 검증은 별도의 read-only maintenance 작업으로 제공한다.

원본 전체 구간과 최종 native graph는 계속 재투영한다. owner revision/delta의 완전한 증명 없는 생략은 하지 않는다. 원본 증분 검증·build 재개/증분·큰 단일 행 분할·semantic representation 접근·전체 workspace/I/O 계상은 남아 있으며 N01을 닫지 않는다. 이전 manifest의 전체 표 복원 호환과 기본·유일한 unified 엔진은 유지한다. 상세 예산·수용 근거는 [선택적 읽기 계약](LIBRA_SELECTIVE_INDEX_READ_CONTRACT_20261014.md)을 따른다.

## 21. owner 증분 증명 기반 원본 현재성 검증 (N01-A)

N01의 매 질의 전체 구간 재투영을 owner 증분 증명(`N01-A`)으로 대체했다. `buildMemoryGraphCorpus()`가 `proof:`(`libra.graph_corpus_source_proofs.v1`)와 `projection:`(`libra.graph_corpus_projection.v1`) 불변 레코드를 함께 게시하며, `FAMILY_CURRENTNESS_CONTRACTS`가 자료별 보장 범위와 재읽기 필수 범위를 선언한다.

질의 시작과 최종 전달 시 `verifyIncrementalSourceProofs()`가 정본 매니페스트 ref 테이블·엔티티 레지스트리·Micro 턴 페어/헤드·State 헤더/정정 저널·호스트 로어 스냅샷/링크 인덱스를 구간별로 대조한다. 증분 증명이 통과하면 변경되지 않은 과거 구간의 정본·Micro 본문 재읽기를 생략(`nativeReprojectionRequired:false`)하고, 최종 Compiler 발송 직전에는 채택·억제된 소비 readset의 물리 레코드 본문 digest와 조건부 readset만 재확인한다. 명시적 `verifyMemoryGraphCorpus()` 감사는 전체 구간 재투영(`eager_full_reprojection_audit`)을 수행한다.

53구간 커널 suite(`libra_memory_graph_corpus_test.cjs` 14 PASS), 자료별 현재성 계약 suite(`libra_memory_graph_inventory_test.cjs` 12 PASS), 등록 native 런타임(`libra_memory_graph_incremental_currentness_runtime_test.cjs` 1 PASS)에서 미소비 정본 본문 미읽기, 소비 Micro 본문 물리 변조 거부, Lore/State 변경 감지를 확인했다.

## 22. 증분 코퍼스 구축·체크포인트 재개 및 대형 단일 레코드 분할 (N01-B)

N01-B의 두 축을 연결했다. 첫째, `buildMemoryGraphCorpus()`가 이전 게시 세대의 `projection:` 구간 슬라이스와 `verifyIncrementalSourceProofs()`의 `reusableWindows`·`liveWindows`를 대조해 변경되지 않은 과거 구간은 재열거하지 않고 변경·추가된 구간만 열거해 병합한다(`buildMode: 'incremental_reuse'`). `maxWindowsPerStep` 옵션을 지정하면 단계별 `checkpoint:`(`libra.graph_corpus_build_checkpoint.v1`) 불변 레코드를 기록해 부분 root 게시 없이 다음 호출에서 이어받아 완주한다(`buildMode: 'checkpoint_resume'`).

둘째, 단일 인덱스 행(예: 대형 허브 엔티티의 `reverseDependencies`·`directory`·`postings`)이 `pageBytes`를 초과할 때 빌드를 실패시키지 않고 결정론적 청크(`libra.graph_corpus_row_chunk.v1`)로 분할 저장하며, 매니페스트 `ref.splitRow` 연속성 검증과 읽기(전체 복원 및 선택적 `readRows`/`queryPageAsync`) 시 `rowDigest` 검증 후 재조립한다. 청크 변조나 누락은 `PAGE_CORRUPT`로 거부한다. 전체 자원·작업공간·I/O 바이트 예산(N01-C)은 후속 단계다.


## 23. `923580b`까지의 최근 커밋 리뷰와 경계 패치 (2026-10-15)

`25cbd13..923580b`의 9개 커밋을 대조했다. 퇴역 검색을 전제로 한 테스트 정리, State 근거 가독성, N01-A 증분 증명, N01-B 구축 재개/분할은 진척이다. 다만 `31a819e`의 native GC는 owner 차원의 원자적 namespace fence를 구현한 것으로 인정할 수 없다. 프로세스 Map·마지막 root reread·기존 root CAS로는 새 root/reader/build의 시작을 함께 보호하지 못한다.

| 재현한 경계 | 수정 | 검증 |
| --- | --- | --- |
| P1 · 투영 뒤 바뀐 source body를 과거 graph의 baseline으로 저장 | native reader의 최종 논리 재읽기 전에 SHA-256 physical baseline을 캡처하고 구간별 전달·일관성 검사. capture 시 다른 본문이면 게시 거부 | Micro 본문을 graph 투영 뒤 capture 직전에 바꾸면 root 미게시. 복원 후 정상 구축·증분 query 유지 |
| P1 · 삭제 직전 새 root가 참조하는 generation 삭제 | native observer는 fence를 발급하지 않고 destructive adapter를 제거. 실제 sweep은 `blocked_atomic_gc_unavailable`, inventory/dry-run 유지 | plugin_only remove 직전·server_only conditional batch 직전 독립 root 게시를 기준 코드에서 재현. 패치 후 삭제 transport 0·후보 보존 |
| P2 · proof 없는/검증 null인 checkpoint 재사용 | 유효한 owner 검증이 승인한 slice만 재사용. checkpoint payload digest 확인, 읽기/쓰기 attempt 한도 128 일치 | 원본 변경 후 proof 부재/null·payload 변조는 재사용하지 않음. 67회 단일 구간 재개 완료 |
| P2 · 비용 종류 혼동 | 누적 Lane 전송량을 owner 동시 버퍼로 대입하지 않고, 미측정 barrier를 0으로 표시하지 않음 | native packet의 해당 counter는 null·missingMeasurements |

새 proof contract는 `libra.source_proof_contract.v2`다. 이전 v1 게시물은 읽기 호환을 유지하되 native 전체 재투영으로 검증하고 과거 body baseline을 발송 권한에 쓰지 않는다. 이전/검증 불가 checkpoint는 새로 열거하며 query가 저장 repair를 실행하지 않는다.

[리뷰·재현 기록](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261015.md)에 변경 전 실패와 패치 후 실제 검사 범위를 기록한다. N01-A/B는 제한 범위 구현으로 유지한다. 미소비 원본의 head 변경 없는 직접 변조·native ABA·전체 owner 원자성, server_only source 본문 I/O 감소는 증명하지 않았다. N05 실제 삭제는 다시 차단 상태로 명시한다.

**다음 우선 구현은 N01-C(다음 과제 N01-b)의 전체 source/workspace/I/O 계상·admission이다.** N02는 native 정본 global 이외 producer/선택적 접근, N06은 평가 세트·실제 provider·설치/규모 인증이 남는다. N03/N04 연결과 N07 단일 엔진 전환은 이미 수행한 범위다. [다음 과제 v1.7](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)에 선행 조건과 완료 조건을 정리했다.


## 24. 원본/저장 읽기와 JSON workspace admission (N01-C1)

이 절은 N01-C1 당시의 범위다. 보유·수명·코퍼스 유지보수에 대한 후속 구현은 §25를 우선한다.

N01-C의 첫 증분을 실제 native query에 연결했다. scoped 원본 reader·정본 source evidence·최종 source/vector/readset 검증과 corpus root/manifest/proof/projection/page I/O가 요청별 payload byte/read quota와 runtime 공유 pool을 사용한다. JSON record 처리와 분할 재조립도 `measure/encodedSize/stageCost`의 사전 workspace 예약을 거친다. 요청의 scope 복사본/private WeakMap으로 전달하며 전역 current-request나 별도 payload cache를 만들지 않는다.

기본 요청 예산은 source 64 MiB, durable 32 MiB, value 8 MiB, JSON workspace 추정 64 MiB, read 8,192회다. 공유 pool은 I/O allowance 32 MiB·JSON workspace 추정 128 MiB·pending read 8개다. 대기 대신 명시적 backpressure로 거부하며 quota는 최종 재검증에도 이어 적용한다. reader가 중간 오류를 pending으로 잡아도 예산 실패 latch를 최종 native/semantic 경계에서 재확인한다. 취소·복원/store serial·늦은 응답·실패에는 lease를 해제한다.

`diagnostics.resourceAccess`와 `accessTrace.resources`는 API 초기 dispatch 검증 완료 시점의 수용 payload 누적량·시도 수·공유/요청 예약 peak·실패/미측정 범위를 보고한다. I/O allowance는 실제 transport buffer가 아니며 JSON workspace는 실제 heap 측정이 아니다. Lane의 저장 byte와 durable ledger도 중복되는 접근이 있어 합산하지 않는다.

새 자원 커널 8건과 등록 native 5건을 검사한다. 세 저장 모드의 정상/저예산/복구·원본 쓰기/모델 호출 없음, 네 pending query와 추가 요청의 shared backpressure, 취소 후 과거 결과 거부·현재 예약 0, 큰 Micro의 budget 오류가 partial로 가려지지 않음을 확인한다. SDK 실제 HTTP/SQLite observer 회귀와 기존 corpus·semantic·Classic/GUI·GRADIA 통합 경로도 검사한다. 상세 재현은 [N01-C1 계약](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)을 따른다.

**N01-C 전체 완료는 아니다.** scope 결속 전 host context/route bootstrap, host lore/settings·외부 permission witness, HTTP envelope/transport parsing과 oversized 응답의 선할당, 장기 보유 graph/index/representation/private authority, vector hydration·build/publication·전체 VM heap은 남는다. Compiler의 기존 전체 counter를 거짓 계측값으로 채우지 않으며 `byteBounded:false`를 유지한다. 다음은 N01-C2의 장기 보유 데이터·유지보수 admission/release와 owner bounded transport 증명이다. 실제 설치·품질·규모 인증은 N06이다.

## 25. N01-C2 — 명시적 보유 예약·권한 수명·코퍼스 유지보수

`e542ce8`의 I/O/JSON 예산에 별도 retained ledger를 연결했다. 기본 요청 64 MiB·공유 256 MiB·활성 session 32개·10분 만료는 명시적 보유 추정의 초기 profile이다. graph projection, durable proof/projection decode, vector hydration·semantic allowance, index compile·eligibility·선택 작업·private readset/packet, 선택한 저장 행의 재조립에 적용한다. 코퍼스 build/publication·eager audit도 같은 owner read·보유 pool을 사용한다. [자원 예산 계약 v1.1](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)에 산식·실제 예약 지점과 미측정을 명시했다.

공개 query/GUI는 DTO 처리 후 private 실행을 해제하고 Classic은 성공한 UI 검증 문맥에 수명을 이전한다. Classic 실패·supersession·4개 문맥 축출, GRADIA receipt release·취소·연결 해제·현재성 실패·만료·dispose와 compiler 무효화는 권한을 폐기한다. 취소 뒤 query가 늦게 끝나도 실행을 해제한다. 작업 중인 reference는 activity 종료까지 예약을 유지한다. 최종 검증의 재투영은 매 호출의 별도 scope로 계상하고 해제하므로 반복 검증이 보유량을 누적하지 않는다.

검증은 순수 retained/shared/session/expiry/활성 작업·동시 scope 사례, plugin_only/server_only/mirror native query의 예산 실패·DTO 해제, native corpus build/eager audit의 실패·root 보존, 실제 HTTP/SQLite owner receipt의 반복 검증·backpressure·release/dispose/무효화 해제와 기존 semantic·Classic·GRADIA SHADOW/AIDE·인풋 작성기 경로를 포함한다. 등록 fixture/통합 검증이며 실제 RisuAI 설치의 물리적 peak heap 인증은 아니다.

**남음:** 전체 heap·transport/host buffer·미등록 할당·hash/serialization scratch·진단 Store 경로의 전수 계상, 초기 retained 산식/지원 corpus·동시성 profile 검증. `byteBounded:false`, `ownerAtomicity:false`, `inventoryComplete:false`를 유지한다. 다음 구현 우선순위는 N01-c의 저장 접근 cursor·재조립 재개다. 추가 표현 producer, 안전한 원자적 native GC, 설치·품질·규모 인증도 남아 있다.
