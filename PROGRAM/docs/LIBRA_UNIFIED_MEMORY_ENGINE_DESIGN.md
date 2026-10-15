# LIBRA 차세대 통합 메모리 엔진 설계

- 문서 버전: 1.19 · 작성일: 2026-10-13 · 갱신일: 2026-10-15
- 상태: **통합 엔진이 기본·유일한 검색기로 기존 검색을 대체했다. Classic·GUI·GRADIA 셰도우/AIDE·인풋 작성기는 같은 검색기를 사용한다. 신규 게시 인덱스의 선택적 저장 page 접근을 연결했다. 증분 원본 검증·구축 재개를 연결했으며, 증명 보장 확대·전체 자원 계상·안전한 native GC·실제 설치/품질·규모 인증은 미완성이다.**
- 현재 코드 확인 기준: codex/libra-memory-network-20261013, `1e331fc`의 N01-C2까지. 원본 증분 검증·구축 재개·대형 행 분할을 제한 연결했다. 원본 baseline은 proof v2에 결속하고 v1은 전체 native 검증으로 읽는다. 실제 GC 삭제는 owner 원자적 fence 부재로 차단한다. 원본/저장 I/O·JSON·명시적 보유 예약과 코퍼스 유지보수·권한별 해제는 [N01-C1/C2 계약](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)으로 부분 연결했다. 최신 판정은 [현황 §21–25](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), 전체 잔여 작업량·완료 조건은 [다음 과제 v1.10](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md), 재현 결함은 [리뷰](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261015.md)를 따른다. 이번 문서 갱신은 구현 완료 범위를 확대하지 않는다.
- N03 연결 계약: [GRADIA 통합 읽기](LIBRA_GRADIA_UNIFIED_READ_CONTRACT_20261014.md). server_only·인증된 호스트 채널·기존 readonly 권한·private owner 영수증을 유지한다. 인풋 작성기는 [별도 N04 읽기 계약](LIBRA_GRADIA_INPUT_WRITER_READ_CONTRACT_20261014.md)으로 연결하며, 실제 설치 인증은 후속 과제다.
- 비교 기준: main, a9549e0505989a1187f510b9596ab98a44352c04
- 참고 구현: 첨부 `LIBRA_World_Manager.js` v6.0.0의 HME. [검토 기록·source fingerprint](WM_HME_ASSOCIATIVE_GRAPH_REVIEW_20261014.md)에 구현 경로와 적용 범위를 고정
- 목표: **정본·Micro·상태 추적·로어북을 하나의 연결망과 탐색·평가 과정으로 통합하고, 기존 캐시·Memory Lane·인덱스를 그 구조에 맞게 재설계한다.**

## 1. 문서의 역할과 기존 계약

이 문서는 차세대 검색 엔진의 목표 아키텍처와 구현 수용 기준을 정의한다. 기존 A1/A2/B1을 완성된 통합 엔진으로 재해석하지 않는다. 검색의 실제 제어 경로를 교체하는 작업과 캐시·레인·인덱스 교체는 같은 구현 범위다.

| 기존 문서 | 활용·갱신 관계 |
| --- | --- |
| [LIBRA_MEMORY_NETWORK_CONTRACT.md](LIBRA_MEMORY_NETWORK_CONTRACT.md) | A1/A2/B1의 구현·증명 경계 유지. 후속 통합 설계는 이 문서를 참조 |
| [LIBRA_MEMORY_NETWORK_ACCEPTANCE.md](LIBRA_MEMORY_NETWORK_ACCEPTANCE.md) | 과거 A2 측정은 해당 snapshot의 증거로 보존. 새 엔진 성능 인증으로 승격하지 않음 |
| [LIBRA_Unified_Architecture_v2_20260921.md](LIBRA_Unified_Architecture_v2_20260921.md) | 정본 작성·State 파생·출처 권한·소비자 계약 유지. 검색·파생 인덱스의 후속 설계는 이 문서 |
| [MAIN_MEMORY_CONTRACT_DECISIONS.md](MAIN_MEMORY_CONTRACT_DECISIONS.md) | typed fact, lifecycle, 사용자 정정, 현재/과거·분기, schema reader/writer 호환 계약 유지 |
| [SOURCE_EDIT_DETECTION_RETIREMENT_20261006.md](SOURCE_EDIT_DETECTION_RETIREMENT_20261006.md) | 자동 원문 변경 탐지·역사 재분석을 복원하지 않음. 남아 있는 검증 비용과 호스트 한계 유지 |
| [PLUGIN-ROLE-AND-STORAGE-DESIGN-20261007.md](PLUGIN-ROLE-AND-STORAGE-DESIGN-20261007.md) | 기존 저장 소유권·읽기 소비자 역할 유지. 검색 인덱스가 새 정본 소유자가 되지 않음 |
| [MAIN_MEMORY_TRACEABILITY.md](MAIN_MEMORY_TRACEABILITY.md) §9 | 이전 World Maker HME의 복원 판단을 보존하고, 새 WM 첨부본의 재사용 원칙과 적용 범위를 갱신 |
| [WM_HME_ASSOCIATIVE_GRAPH_REVIEW_20261014.md](WM_HME_ASSOCIATIVE_GRAPH_REVIEW_20261014.md) | 새 WM의 연결·검증·검색 제어를 대조한 정적 코드 검토. LIBRA 구현 완료나 호스트 성능 증거로 사용하지 않음 |
| [LIBRA_UM0_UM1_ADAPTER_MAPPING.md](LIBRA_UM0_UM1_ADAPTER_MAPPING.md) | 현재 reader schema → 새 adapter 표. F-1/F-2 identity 계약·normalized fixture 구현과 남은 결정/연결 gate |
| [LIBRA_UM1_GRAPH_IDENTITY_CONTRACT.md](LIBRA_UM1_GRAPH_IDENTITY_CONTRACT.md) | 공통 NodeID/EdgeID·basis·binding 1차 계약, 순수 커널과 14개 검증. production 검색 완료 증거와 구분 |
| [LIBRA_UM1_READER_ADAPTER_CONTRACT.md](LIBRA_UM1_READER_ADAPTER_CONTRACT.md) | 실제 정본·Micro·State·lore reader 연결, 공개 read-only projection page, 역할/근거/coverage 및 실제 등록 API의 합성 호스트 검증 |
| [LIBRA_UM2_PAGE_CACHE_CONTRACT.md](LIBRA_UM2_PAGE_CACHE_CONTRACT.md) | F-3/F-4의 첫 경계: 공통 payload byte admission·pin/LRU·partition·staging/decode와 실제 owner projection page 접근. 전체 heap·durable generation·Lane 완료와 구분 |
| [LIBRA_UM2_DURABLE_GRAPH_CONTRACT.md](LIBRA_UM2_DURABLE_GRAPH_CONTRACT.md) | 유지보수 전용 불변 page/manifest·root-last/CAS 게시, 현재 원본/전체 window page 재도출 검증·재시작·취소 barrier. exhaustive corpus/delta·final delivery 완료와 구분 |
| [LIBRA_UM3_NATIVE_SEMANTIC_CONTRACT.md](LIBRA_UM3_NATIVE_SEMANTIC_CONTRACT.md) | native provider/query cache·저장 정본 projection 벡터의 source access·단일 frontier·최종 vector/config 검증. 품질/전체 corpus/다른 자료 representation은 후속 |
| [LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md) | 현재 연결/검증 수준, 미완료 D01–D08/M01–M15, 완료 gate·작업 순서의 기준 |
| [LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md) | 퇴역 기능·현재 소비자 호출 재검토와 N00–N07의 우선순위·선행 조건·완료 기준 |
| [LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261014.md](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261014.md) | `83caadd`의 호출 경로와 재현된 8개 결함, 저장소 기준의 재현 명령 |

문서의 새 검색 계약은 기존 출력 캡·Memory Lane routing·독립 순위 병합을 영구 유지하라는 뜻이 아니다. 해당 검색 정책은 아래 전환 단계에서 명시적으로 교체한다. 반면 정본·State writer의 의미, 원문 채택·재분석 동의, 저장소 권한은 계속 보존한다. 실제 학습형 GNN, 자동 온라인 가중치 학습, ANN은 초기 구현의 필수 조건으로 두지 않는다.

## 2. 현재 구현과 해결할 문제

### 2.1 기준 snapshot의 상태

| 영역 | ca40d76에서 확인한 구현 | 차세대 엔진에서 필요한 변화 |
| --- | --- | --- |
| 정본 검색 | catalog → shortlist → hydration → dense/sparse/exact/forced → RRF → gate/packing | 공통 노드와 단일 탐색·평가로 이전 |
| A1 레지스트리 | 정본 기억 단위 후보, 내부 claim ID, exact identity/binding, private lease | 의미 단위·대상·출처·관계와 네 자료 adapter로 확장 |
| A2 인덱스 | paged metadata preparation, dependency invalidation, 비용 계측 | 실제 후보 발견과 탐색에서 사용하는 durable shard/index로 전환 |
| B1 Micro | 독립 lexical 접근, 검증된 원문 hydration, 제한된 typed correspondence | 같은 그래프·검색 정책으로 이전, 표현 coverage 보존 |
| State | 최신값 materialized view, field provenance, 기존 ELI | State 필드를 검색 노드로 투영하고 근거에 연결 |
| 로어북 | 별도 response lore BM25F/RRF/선택과 LLI | 설정·정의·규칙 구간을 공통 검색 노드와 평가로 이전 |
| Memory Lane | 정본 catalog의 24-entry 블록, 96-entry 활성 기준, 최대 6개 선택 블록과 보호/fallback 규칙 | 네 자료를 다루는 페이지 접근·탐색 스케줄러로 대체 |
| 캐시 | catalog·Micro head·ELI·LLI·block·lore token·query vector 등에 분산 | 공통 바인딩·예산·무효화 규약 아래 역할별 cache pool로 재구성 |

A2의 runtime items에는 벡터가 없고, 준비한 paged index가 기존 canonical shortlist/scorer를 대체하지 않는다. factory의 scanDense는 합성 접근 계측 도구다. State 파생, lore 평가, 기존 RRF와 연상 확장의 주요 함수는 main과 동일하다.

같은 합성 자료의 실제 beforeRequest 비교에서는 연상 OFF의 최종 packet이 동일했고, ON에서는 main의 private canonical proof 손실이 네트워크 브랜치에서 수정됐다. 이는 기반 재사용의 근거이며 통합 검색의 품질·성능 완료 증거는 아니다.

### 2.2 요구사항

| ID | 필수 요구 |
| --- | --- |
| U01 | 네 자료가 모두 하나의 후보·관계·탐색 공간에 참여 |
| U02 | 임베딩·키워드·인물·시간·관계를 단일 검색 정책의 신호로 처리 |
| U03 | 한 후보의 여러 접근·표현·순환 경로가 relevance나 독립 증거 수를 중복 증폭하지 않음 |
| U04 | 사건·현재 상태·배경 설정·사용자 정정의 의미와 권한을 보존 |
| U05 | 현재/과거, native branch, predecessor, 사용자·viewer 범위의 적격성을 일관되게 적용 |
| U06 | 캐시·Memory Lane·인덱스를 재설계하고 기존 경로의 이중 계산을 종료 |
| U07 | corpus 접근 범위와 캐시/작업/출력 예산을 구분. 오래된 기억을 조용히 제외하지 않음 |
| U08 | 수정·복원·취소·동시 publication·프로필 변경에서 오래된 작업을 게시하지 않음 |
| U09 | query가 원문 재분석·State 쓰기·역사 문서 임베딩을 자동 시작하지 않음 |
| U10 | 최종 출력이 사용한 실제 근거와 의존성을 재검증하고 coverage·비용을 관찰 가능하게 함 |

### 2.3 WM HME 검토에 따른 설계 결정

첨부본에는 기존 `memory/entity/lore` 그래프와 새 `TypedHmeSourceGraph`의 `memory/entity/world/narrative` 그래프가 공존한다. 새 typed 경로는 원본 그래프를 영속 유지하고 요청별 적격 부분 그래프를 만든다. 그러나 검색 제어는 휴리스틱 검색과 별도 semantic 검색 → 양쪽 시드의 그래프 확장 → 휴리스틱 점수 반영 → RRF → 다양성/MMR 선택이다. 자료 identity를 공유하는 것과 하나의 검색 정책을 실행하는 것을 구분한다.

| WM에서 확인한 구현 | 차세대 LIBRA 결정 | 반영 절 |
| --- | --- | --- |
| 인물 허브·역할별 연결·빈도 억제 | 공통 EntityNode와 의미 단위 연결에 적용. 가중치 수치는 별도 calibration | §4.4, §6.3 |
| 영속 원본 그래프 + 요청별 적격 그래프 | SourceGraph generation + 발급된 QueryGraphView로 분리. 전체 부분 그래프 복사 대신 적격 페이지 cursor 사용 | §4.5, §7 |
| restart 때 현재 원본에서 노드·엣지 재계산 | 독립 검증을 통과한 derived generation만 사용. 검증 비용과 불완전 범위를 기록 | §9.3 |
| epoch·최신 작업 token·scope별 write barrier | 원본 partition과 publication 작업의 경합 계약에 적용. 원자성은 storage owner의 별도 증명 필요 | §9.3 |
| 시드별 최대 2홉 BFS·graph bonus·두 순위의 RRF | 공통 초기 활성화·개선 시 재평가·단일 frontier와 scoreCandidate로 교체 | §6.2–§6.4 |
| bounded graph·scope 개수 캐시·변경 시 엣지 재컴파일 | exhaustive durable shards·공통 byte cache·페이지 스케줄러·역의존 delta 게시로 재설계 | §7, §9 |
| 조회 중 derived cold build 저장 허용 | 준비·검증·durable 게시를 유지보수 경로로 분리. 요청 내 임시 투영은 읽기 전용 | §7.7 |

HME 전체 엔진을 재도입하거나 기존 `bonusCap`으로 relevance/근거 gate를 우회하지 않는다. 연결·검증 원칙과 필요한 계산 primitive를 활용하되 LIBRA 소유권·typed 의미·단일 검색 제어 계약 아래 구현한다.

### 2.4 v1.3의 구현 진척

`getMemoryGraphProjectionPage()`는 LIBRA의 실제 owner reader를 통해 네 자료를 읽고 공통 identity 커널로 투영한다. 정본 fact·검증된 Micro claim/source-only excerpt·State field/item/정정·허용된 lore rendered passage를 보존하고, 승인된 entity와 정확한 근거를 연결한다. 호출자는 원본 record·proof를 공급하지 않는다. 선택한 저장 본문·State 읽기 뷰·정정 record와 lore를 재확인하며 저장이나 provider/document embedding 호출을 시작하지 않는다.

등록된 공개 API를 합성 호스트에서 실행한 plugin_only/server_only fixture는 각각 48-node/81-edge, 정본 13·Micro 1·State 17·lore 2 unit을 반환했다. 동일 span의 다른 Micro claim은 owner claim digest로 구별하고 유일 대응이 없으면 State derivation을 만들지 않는다. 별도 실제 writer 시나리오에서 사용자 정정·명시적 clear, 실제 producer 실패에서 source-only 500자 표현도 검증했다.

이는 **owner reader 연결과 투영의 검증**이다. 실제 설치 호스트 qualification, viewer/as-of QueryGraphView, 최종 물리 dispatch proof, 단일 frontier/scorer, durable graph·공통 byte cache·Lane 전환은 완료하지 않았다. page의 `inventoryComplete:false`, `byteBounded:false`, `modelDispatchEligible:false`와 미해결 근거 사유를 유지한다. 기존 normal recall/beforeRequest는 새 API를 자동 호출하지 않는다. 세부 계약과 재현 명령은 [reader adapter 계약](LIBRA_UM1_READER_ADAPTER_CONTRACT.md)에 고정한다.

### 2.5 v1.4의 구현 진척

`getMemoryGraphAccessPage()`는 검증된 owner projection을 nodes/edges/bases/units의 연속 byte page로 읽는다. 공통 캐시는 역할별 payload binding·privacy partition과 전체 resident/request/staging 예산을 관리한다. 불변 payload는 generation이 달라도 재사용하며, 같은 NodeID의 binding 변화·coverage/view·restore epoch는 현재 snapshot cursor를 바꾼다. 작은 page보다 큰 항목은 누락하지 않고 같은 위치의 cursor와 stopReason을 반환한다.

pin backpressure·LRU 재조회·강제 digest 충돌·finally 해제·partition quota를 순수 suite에서 검증하고, 실제 등록 API의 plugin_only/server_only 합성 호스트에서 네 자료의 33개 unit 순회와 cold/warm 일치를 검증한다. 실제 portable restore boundary와 scope 삭제/unload에 cache 무효화가 연결된다. 조회 중 durable write/provider 호출은 시작하지 않는다.

이번 byte admission은 **파생 page cache와 managed decode/staging**에 한정한다. 원본 reader의 전체 projection workspace·반환값 보관·VM overhead는 미계상이며 전체 API는 `byteBounded:false`다. warm hit에서도 원본 검증·투영·encoding을 수행한다. snapshot generation label은 durable root의 독립 검증이나 QueryGraphView 권한이 아니다. 세부 범위와 다음 gate는 [UM2 page/cache 계약](LIBRA_UM2_PAGE_CACHE_CONTRACT.md)에 기록한다.

### 2.6 v1.5의 구현 진척

`buildMemoryGraphGeneration()`은 명시적 maintenance API에서 현재 owner projection window를 durable pages·generation manifest·root로 게시한다. query의 `getMemoryGraphDurablePage()`는 저장된 root를 읽고 현재 원본에서 window 전체의 directory/payload를 다시 도출해 모든 physical page와 대조한다. generation이 없거나 낡으면 missing/stale를 반환하고 쓰기·repair·분석을 시작하지 않는다. raw DTO의 ID/verified 필드가 publication 또는 delivery 권한을 공급하지 않는다.

합성 native host의 실제 등록 API에서 두 저장 모드 모두 48 nodes·81 edges·27 bases·33 units를 17개 page로 게시·재읽는다. server_only는 기존 SDK의 source/root readset과 page/manifest 조건을 결속한 root CAS, plugin_only는 runtime 내 직렬 root-last/readback의 partial 보장이다. 새 VM에서는 이전 RAM verified 상태를 신뢰하지 않는다. 중간 실패·오염·취소/복원·독립 publisher 경합을 [durable 계약](LIBRA_UM2_DURABLE_GRAPH_CONTRACT.md)과 재현 suite에 기록한다.

`durableGenerationVerified:true`는 **현재 owner projection window의 전체 persisted pages** 검증에 한정한다. 전체 owner inventory/delta·native mutation atomicity·viewer/as-of QueryGraphView·최종 dispatch를 뜻하지 않는다. `inventoryComplete:false`, `ownerAtomicity:false`, `modelDispatchEligible:false`, 전체 `byteBounded:false`와 actual-host 미인증 한계를 유지한다. 기존 normal recall·A2 preparation/ranker 경로는 아직 이전하지 않았다.

### 2.7 v1.6의 커널 추가와 v1.7의 현황 정정

UM1 reader·durable store의 경계 결함(`node_work_budget` 누락, 고아 `SourceNode` 생성, 빈 배열 `[]` State 필드 분류, `reuseInitial` 중복 읽기, 공개 API `safeClone` 대칭성)을 수정하고, UM2–UM6의 5개 핵심 모듈(`Index`, `Lane`, `Query`, `Compiler`, `Rollout`)을 구현해 `LIBRA.js`에 동기화·내장했다.

- **UM2 공통 접근 커널**: 메모리 배열의 directory/typed adjacency·lexical/entity/predicate/time postings·역의존 표, 5역할 Lane과 GC helper를 추가했다. 실제 durable index/page cache와 새 검색의 접근 연결, exhaustive inventory/delta·전체 byte 계상은 미완료다. source 변경 postings/DF 누락과 GC 게시 경합 결함을 확인했다.
- **UM3 단일 검색 커널**: QueryFrame·issued view, lexical/entity/predicate와 주입된 numeric semantic score, 단일 frontier·strongest-path/witness를 구현했다. 실제 임베딩/SpaceBinding·native viewer/lineage·공통 page 접근은 미연결이다. 실제 Micro 형식의 미래 턴 유입과 잘린 coverage의 complete 판정 결함을 확인했다. 기존 순수 fixture PASS를 실제 요청의 V01–V04/V15 완료로 해석하지 않는다.
- **UM4 근거 컴파일러 커널**: 후보 선택, caller correspondenceMap 기반 Micro 흡수, 역할 라벨·private readset 및 graph binding 대조를 구현했다. 실제 대응·독립 근거·충돌 보존·소비자 adapter/hydration은 별도 gate다. 물리 검증 선택 사항, await 중 readset 폐기, 최종 출력 예산 초과 결함을 확인했다. `validateConsumedReadSet`의 존재만으로 최종 owner/dispatch 연결이 완료되지 않는다.
- **UM5–UM6 전환 커널**: mode seal·shadow 비교·base-request 결과·legacy fence helper와 V05 helper를 추가했다. 실제 beforeRequest/recall의 모드 선택과 legacy 실행 지점에는 연결되지 않았다. V05는 존재하지 않는 점수/digest 필드를 비교하고 실제 cache hit/LRU·독립 restart를 실행하지 않아 완료 증거로 사용할 수 없다.

**기존 조사 기록(§14–15 이전):** `D01`–`D08`의 커널·경계 결함 8건은 수리되어 순수/합성 호스트 회귀 스위트(E1/E2)와 등록 공개 API(`executeMemoryGraphUnifiedQuery`)에서 검증됐다. 다만 일반 회상(`beforeRequest`/`LibraMemoryCore.recall`)과 전체 소비자 어댑터·실제 임베딩/durable shard 전환(`M01`–`M15`)은 아직 기존 검색기를 사용한다. [현황·미완료 작업](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)의 E0–E4, D01–D08(해결), M01–M15, G1–G6를 현재 상태로 사용하고 [코드 리뷰](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261014.md)의 재현 근거를 따른다. 엔진 자체의 미완료와 실제 설치 호스트/원본 revision API 한계를 분리한다.

### 2.8 v1.13 — 전체 구간 인덱스의 실제 검색 연결

`buildMemoryGraphCorpus()`가 정본/Micro owner cursor를 순회하고 State·로어북·대상·관계를 하나의 그래프로 통합해 공통 index 표를 불변 page로 게시한다. unified query는 현재 frame의 게시 인덱스를 복원해 기존 단일 scorer/frontier/Lane/Compiler에서 사용한다. Classic과 별도 GRADIA SHADOW/AIDE·인풋 작성기가 같은 경로를 사용하며, 임베딩은 기존 정본 source-access 표현을 유지한다. GUI의 명시적 구축/취소와 `corpusRead` 진단을 연결했다.

이는 N01의 실제 전체 구간 검색·저장 표 재사용 증분이다. 모든 원본 구간의 native 재투영과 표 전체 hydration, 대규모 선택적 shard 접근·증분 원본 검증·전체 자원 계상은 남아 있다. 여러 SDK readset과 root CAS는 전체 owner 원자성이 아니다. 당시 기본값은 `legacy`였으며, v1.14에서 유일한 `unified`로 전환했다. 실제 설치/품질 gate는 계속 미인증이다. 최신 제한·상한·수용 근거는 [전체 구간 공통 인덱스 계약](LIBRA_DURABLE_CORPUS_INDEX_CONTRACT_20261014.md)과 [현황 §18](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md#18-전체-구간-공통-인덱스의-구축과-검색-연결)을 따른다. 앞의 v1.3–v1.7 설명은 당시 구현 기록이다.

### 2.9 v1.14 — 기본·유일한 통합 검색

정상 회상·Classic 최종 주입·GUI 검색·GRADIA LIBRA 읽기는 통합 엔진만 실행한다. 저장 인덱스가 없거나 내용/표현 버전이 낡으면 현재 원본의 모든 owner cursor 구간을 읽어 같은 공통 index와 frontier로 검색한다. 저장 인덱스 repair·문서 벡터 생산·legacy 검색을 시작하지 않는다. 손상·권한/route/reset 변경·취소·예산 실패는 명시적 실패 또는 base request로 처리한다. [전환 계약](LIBRA_UNIFIED_SEARCH_REPLACEMENT_CONTRACT_20261014.md)과 [현황 §19](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md#19-레거시-검색의-완전-대체)를 현재 기준으로 적용한다. 이전 절의 모드 선택·준비 작업 설명은 당시 기록이다.

### 2.10 v1.15 — 선택적 저장 인덱스 읽기

Memory Lane의 seed/frontier가 필요한 저장 index page를 비동기로 요청한다. Query/Lane은 하나의 generator 알고리즘을 동기/비동기 driver로 실행하며 별도 ranker를 추가하지 않는다. 신규 manifest의 키 범위와 실제 페이지를 대조하고 공통 Cache Manager·물리 payload 예산으로 읽는다. 원본 전체 재투영/최종 native 검증은 유지한다. [선택적 읽기 계약](LIBRA_SELECTIVE_INDEX_READ_CONTRACT_20261014.md)과 [현황 §20](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md#20-선택적-저장-인덱스-읽기)을 최신 기준으로 적용한다.

## 3. 전체 아키텍처

~~~mermaid
flowchart TD
    C[정본 소유자] --> AD[자료별 읽기 adapter]
    M[Micro·receipt 소유자] --> AD
    S[State·정정·entity registry 소유자] --> AD
    L[호스트 로어북 소유자] --> AD
    AD --> G[SourceGraph: 공통 노드·관계 투영]
    G --> D[버전된 durable 파생 shard·인덱스]
    D --> CP[페이지·표현·질의 cache pools]
    D --> GV[QueryGraphView: 발급 generation·적격 cursor]
    Q --> GV
    GV --> QE
    Q[질의·문맥·scope·as-of] --> QE[단일 Query Engine]
    CP <--> ML[Memory Lane: 페이지 접근·탐색 스케줄러]
    ML <--> QE
    QE --> ES[근거 묶음 선택]
    ES --> HY[소유자에서 원본 hydration]
    HY --> PK[소비자별 packet 조립·실제 예산 admission]
    PK --> V[최종 의존성·현재성 검증]
    V --> OUT[검증된 결과 전달·모델 요청]
~~~

중앙 엔진은 후보 생성·활성화·확장·평가·선택·작업 예산을 소유한다. 자료 adapter는 독립 top-K나 최종 순위·출력 예산을 소유하지 않는다. cache miss나 인덱스 부재도 같은 엔진의 읽기 전략에서 처리한다.

storage/provider 접근과 coroutine scheduling은 runtime adapter가 담당한다. 그래프 투영·평가 커널은 입력 snapshot에 대해 순수하게 동작하며, 기존 createMemoryNetwork의 원문 비변경·private capability 경계를 이어 간다.

## 4. 공통 그래프 모델

### 4.1 노드의 세 층

| 층 | 종류 | 검색·출력 역할 |
| --- | --- | --- |
| EntityNode | 승인된 인물·조직·물건·장소·개념 | 질의의 대상, 별칭 해석, 연결의 중계점 |
| MeaningNode | canonical fact/event, micro claim, source excerpt, State field/item, lore definition/rule/passage | 실제 질문에 필요한 의미 단위와 후보 |
| SourceNode | 정본 record, Micro receipt/body/head, State head/correction basis, lore entry/module | provenance, 물리 locator, revision·coverage |

EntityNode와 SourceNode는 연결·접근의 중계점이다. 실제 자료 출력은 적격한 MeaningNode와 그 source span/basis를 선택해 만든다. source container의 높은 유사도를 모든 child claim의 직접 유사도라고 복사하지 않는다.

정본 5턴 묶음 전체와 로어북 항목 전체만을 유일한 검색 노드로 삼지 않는다. 기존 구조화 fact·claim·field와 offset을 보존한 lore 구간으로 의미 단위를 만든다. claim이 없는 원문 excerpt에는 새 주장을 만들지 않는다. 문맥 보존을 위해 source container 노드도 남긴다.

초기 adapter는 이미 저장된 구조화 정보와 승인된 원문 표현만 사용한다. 새로운 claim 추출·동명이인 해결을 위해 query 도중 LLM을 호출하지 않는다.

### 4.2 식별자·의미·현재성 분리

- SourceObjectID는 소유자가 증명한 namespace/origin scope/UUID/birth incarnation으로 정의한다. 메시지 번호·같은 이름·내용 hash가 안정 객체 identity를 대신하지 않는다.
- ClaimID는 출처와 typed actor/target/predicate/value/polarity/time/certainty/attachment에 결속한다. 현행 exact tuple 비교와 충돌 거부를 유지한다.
- NodeID는 source/claim 또는 qualified State field/lore passage identity를 참조한다. 동일 주장에 대한 서로 다른 표현을 별도 독립 사건으로 세지 않는다.
- RepresentationID는 실제 검색 텍스트·projection version·chunk layout·embedding space에 결속한다.
- EvidenceBinding은 소유자·scope·worldline/as-of·실행 instance·nonrewinding restore/reset epoch·원본 revision/digest·활성 mapping을 결속한다.
- 안정 anchor가 없는 legacy는 revision-bound partial identity로 유지한다. 새 그래프를 만든다는 이유로 native identity나 대응 claim을 만들어 내지 않는다.

동일 의미의 다른 출처는 별개 evidence다. 같은 원문의 정본/Micro/State는 정확한 출처와 유일한 typed 대응이 확인될 때 하나의 EvidenceFamily로 연결한다. 이 family는 중복 accounting 단위이며 자체 권한을 발급하지 않는다. 출처 미확정·반복 quote·split/merge·동명 ambiguity는 별개로 남는다.

UM1의 1차 결정은 [graph identity 계약](LIBRA_UM1_GRAPH_IDENTITY_CONTRACT.md)을 따른다. NodeID는 세 층의 공통 `libra.node.v1` namespace를 사용하고, physical `memoryKey`와 기존 network candidate ID는 locator/alias로 유지한다. 안정 source/unit lifetime을 증명하지 못하면 exact revision/restore epoch/snapshot에 묶인 partial identity를 사용한다. normalized 커널은 identity 형식만 검증하며 owner proof를 발급하지 않는다.

### 4.3 제안된 MeaningNode 자료

~~~text
MeaningNode {
  schema, nodeId, kind, sourceId, claimId?,
  typedMeaning?, entityRefs[], sourceAttachment,
  temporalView, semanticRole, epistemicStatus,
  identityCoverage, representationCoverage,
  representationRefs[], bindingRef, dependencyRefs[]
}
~~~

위 자료는 파생 metadata다. JSON의 verified/proof/current 플래그로 물리 권한을 대신하지 않는다. 원본 row, issued lease와 consumed readset는 해당 runtime의 private 객체로 유지한다. 진단에는 opaque proof나 secret을 내보내지 않는다.

### 4.4 관계 종류

| 관계 | 만들 수 있는 근거 | 탐색·권한 의미 |
| --- | --- | --- |
| mentions / subject_of / target_of | 승인된 entity·typed fact/claim attachment | 대상 연결. 동명 자동 병합 금지 |
| evidenced_by / derived_from | 실제 source span, receipt, State field provenance·정정 basis | 출처 추적. 단순 연결만으로 현재성을 인증하지 않음 |
| updates / clears / supersedes | 승인된 field effect·revision/lifecycle 전이 | 해당 대상·필드·시간 범위의 갱신. 다른 필드까지 덮어쓰지 않음 |
| follows / fulfills / reopens | 소유자가 승인한 temporal/lifecycle link | 기존 typed 의미 유지. dependsOn을 인과로 해석하지 않음 |
| defines / applies_to | 명시적 lore 정의·규칙과 확정 대상·적용 조건 | 설정의 적격성·설명 연결. 설정을 발생 사건으로 바꾸지 않음 |
| contradicts | 동일 qualified slot의 비교 가능한 값·시점·확실성 | 충돌 표시. 우세 claim 자동 확정 금지 |
| semantic_affinity | 호환 공간의 실제 표현 유사도 | 검색 접근 신호. identity·사실·인과·관계 상태를 인증하지 않음 |

엣지마다 owner/scope/view binding, 생성 근거, 방향, 적용 시점, dependency와 coverage를 보존한다. similarity 모든 쌍의 O(N²) edge를 영구 생성하지 않는다. 저장된 typed adjacency와 필요할 때 계산하는 의미 접근을 함께 사용한다.

EdgeID의 exact identity에는 방향 있는 endpoints, predicate, qualified field/적용 조건, 유효 시간, basis identity와 incarnation을 포함한다. revision은 별도 binding으로 검증한다. 같은 두 노드 사이의 `mentions`·`evidenced_by`·`updates` 등은 별개 엣지다. unordered endpoint pair나 이름 일치로 관계를 한 개로 합치지 않는다. 역방향 탐색은 해당 predicate의 허용 규칙을 명시하고, inverse 탐색을 실제 역방향 사건의 증거로 출력하지 않는다.

대상 연결에는 소유자가 승인한 당사자·관찰자·언급·추정 역할을 보존한다. 주체/대상 attachment가 있는 canonical fact, Micro claim, State field와 lore 구간이 같은 EntityNode에 연결될 수 있다. 역할은 탐색 적합성의 feature이며 물리 proof나 사실 confidence를 대체하지 않는다. WM의 1.0/0.62/0.25/0.08 계수를 기본값으로 채택하지 않는다.

단어·시간 근접·공유 주제에서 추정한 관계는 검색용 association으로 명시한다. `causal_followup`·`resolves_thread` 같은 추정 label을 승인된 인과·lifecycle 엣지로 승격하지 않는다. 불완전 sourceRefs·턴 anchor에는 partial/unknown lineage를 남긴다.

### 4.5 원본 연결망과 질문별 그래프 뷰

SourceGraph는 승인된 원본 snapshot·projection schema·안정/partial identity·명시적 source dependencies를 기준으로 생성한다. 같은 authorized partition 안의 질문이 바뀌었다는 이유로 원본 엣지나 durable generation을 다시 쓰지 않는다. 원본 소유권·세계선 lineage·유효 시점·visibility 근거는 원본 그래프에 보존한다.

QueryGraphView는 SourceGraph generation과 QueryFrame에 결속된 private issued handle이다. scope·native branch·as-of·viewer·lore activation·semantic role에 맞는 node/edge pages를 읽는 cursor를 제공한다. 캐시 page bytes는 공유할 수 있지만 적격성 판정·lease·path state는 요청에 귀속한다. 질문별로 원본 전체를 복제·필터링하여 별도 graph Map을 만들지 않는다.

보호되거나 해당 view에 부적격한 자료는 출력뿐 아니라 seed·중간 노드·edge 확장에서도 제외한다. 나중에 출력문을 redaction하는 것으로 비공개 경유를 허용하지 않는다. 적격성 metadata를 확인한 뒤 읽기 작업을 예약하며, 접근 불가 자료의 이름·관계·개수·진단으로 간접 정보를 노출하지 않는다. 필요한 적격성·근거를 증명할 수 없는 영역은 unknown/unavailable로 보고한다.

| WM 자료·원칙 | LIBRA 투영 책임 | 대응 시 보존할 의미 |
| --- | --- | --- |
| memory와 entity 허브 | canonical/Micro의 MeaningNode + 공통 EntityNode | source/claim attachment, 인물 identity·역할·원문 근거 |
| entity current state·relation | State field/item + 승인된 canonical relation/lifecycle | 현재값·정정·last-known과 발생 사건을 구분 |
| world rule·state·codex | 기존 lore passage/rule + State 또는 canonical world fact | 적용 설정·상태 이력·관찰 사실을 각각 보존 |
| narrative memoryRefs·arc/thread | 기존 승인 자료의 문맥·source/typed lifecycle 연결 | 새 narrative 정본·자동 요약 원장을 생성하지 않음 |
| 기존 entity–lore 연결 | lore adapter의 공통 대상·정의·적용 엣지 | 활성 조건·안정 entry identity·동명 ambiguity |
| WM typed 경로에 독립 adapter가 없는 Micro·일반 lore | LIBRA의 두 adapter를 직접 구현 | source-only·receipt·passage coverage까지 독립 발견 가능 |

이 표는 개념 대응이다. WM 데이터를 자동 import하거나 서로 다른 네 자료 종류를 일대일로 치환하는 계약이 아니다. 실제 LIBRA reader schema와 source ownership은 UM1에서 별도로 고정한다.

## 5. 네 자료 adapter

### 5.1 정본과 Micro

정본은 기존 schema dispatch와 record admission을 통과한 fact/event 및 source container를 투영한다. legacy record의 의미를 새 schema로 추정 변환하거나 자동 재분석하지 않는다.

Micro는 claim과 exact source span, receipt revision·analysis status를 투영한다. minimum_source_bound는 source-only로 유지한다. 완결된 승인 턴과 허용된 predecessor 범위만 읽는다. producer의 16-claim·claim/quote 길이 및 source-only 첫 500자 같은 현행 표현 제한은 coverage로 기록한다. 전체 턴을 검색했다는 주장을 하려면 별도 source representation 계약과 명시적 생성·검증 작업이 필요하다.

### 5.2 State

State 필드·collection item은 **검색 노드**이며, 현재 값·last-known·clear·pending/unknown을 구분한다. head의 전체 throughTurn과 개별 field의 근거 시점도 구분한다. 값을 만든 canonical fact 또는 사용자 correction journal에 연결한다. 해당 근거가 없으면 unknown provenance로 표시하고, State 값을 새 사건의 증거로 사용하지 않는다.

기존 State writer·replay·correction transaction은 유지한다. 검색은 State를 쓰지 않는다. 과거 질문에는 owner가 이미 검증한 historical view가 있으면 사용하고, 없으면 현재 head를 과거값으로 돌려 쓰지 않는다. 적격한 역사 fact/lifecycle 근거로 답할 수 있는 범위와 State view의 unavailable 범위를 별도로 보고한다.

필드 누락은 삭제가 아니다. 명시적 clear와 확인 불가를 구분한다. user_corrected 값은 사용자 정정이라는 역할과 근거를 보존한다.

### 5.3 로어북

character/module/chat lore의 entry identity, body revision, passage offsets, 키·별칭·활성 조건·우선순위·설정 적용 범위를 투영한다. 실제 occurrence·source ownership이 불명확한 entry는 이름·내용 hash만으로 다른 자료와 합치지 않는다.

always-active/host-selected/명시적 activation 규칙은 소비자 정책의 필수 inclusion 조건으로 이전한다. 큰 relevance 보너스로 모사하지 않는다. lore 설정을 현재 사건 또는 인물의 관찰된 상태로 승격하지 않는다. 현재 user input·Author Note의 지시 역할과 lore 데이터의 역할도 분리한다.

호스트가 lore mutation revision을 제공하지 않는 경우, 허용된 읽기 adapter의 검증 fallback을 유지한다. lore가 변경됐음을 추정하거나 감지했다는 주장을 캐시 hit만으로 만들지 않는다.

## 6. 하나의 검색·활성화 과정

### 6.1 질의와 적격성

QueryFrame은 질의·안전하게 선택한 문맥, entity 해석/ambiguity, intent, owner/scope/native lineage, temporal cursor, viewer/POV, engine policy, tokenizer/projection/embedding profile을 봉인한다.

scope·worldline·as-of·viewer·source role 조건을 후보 발견·관계 확장·출력에 일관되게 적용한다. 권한 없는 자료를 읽은 뒤 점수에서 제외하는 방식으로 우회하지 않는다. 미래 사건·현재 head를 과거 근거로 사용하지 않는다. adapter metadata의 적격성 판정 뒤에도 최종 physical proof는 필수다.

### 6.2 접근 신호와 공통 평가

키워드 posting, 호환 벡터, entity/predicate/time 접근은 NodeID/RepresentationID와 raw feature를 내보낸다. 각 경로가 독립 final top-K/RRF를 계산한 뒤 합치는 구조를 종료한다. posting/page cursor와 bounded buffers로 신호를 공통 후보 테이블에 공급한다.

단일 scoreCandidate는 같은 후보에 semantic similarity, 전역 DF에 따른 lexical match, entity/slot match, temporal·질문 역할 적합성을 적용한다. missing embedding은 unavailable feature로 기록하며 후보를 자동 제외하지 않는다. 권한 검증 성공과 relevance를 같은 의미의 점수로 취급하지 않는다.

BM25F·cosine·exact match를 계산 primitive로 재사용할 수 있다. calibrator와 가중치는 versioned engine policy에 속한다. 후보 subset마다 DF를 다시 계산하거나 한 채널의 임의 scale을 다른 채널에 직접 더하지 않는다. 단계별 query intent 해석 실패와 calibration 범위도 진단한다.

### 6.3 초기 활성화 전파 제안

초기 버전은 설명 가능한 감쇠된 strongest-path 전파를 사용한다. 이는 A1의 pathBonus=0을 바꾼 완료 구현이 아니라, 후속 엔진에서 검증할 제안이다.

~~~text
s_q(v) = calibrated direct relevance in [0, 1]
a_q(v) = max(
  s_q(v),
  max over eligible incoming edges (u,e,v):
    a_q(u) * lambda * w_q(e) * targetFit_q(v)
)
0 <= lambda < 1; 0 <= w_q(e), targetFit_q(v) <= 1
~~~

질문 의도·관계 종류·시간·대상 적합성에 따라 w와 targetFit을 계산한다. 같은 entity에 연결됐다는 이유만으로 모든 사건을 중요하게 만들지 않는다. 높은 degree의 중계점은 query-conditioned fan-out과 비증폭 normalization을 적용한다. relation 방향을 무시한 무한 왕복을 허용하지 않는다.

여러 경로의 점수를 단순 합산하지 않는다. 더 약한 경로·순환은 activation을 높이지 못하고, 같은 family의 다중 표현은 한 logical evidence로 accounting한다. 독립 출처의 corroboration은 실제 출처 분리를 확인한 설명 feature로만 기록하며, 초기 버전에서는 popularity·조회 빈도로 가중치를 자동 학습하지 않는다.

scoreCandidate가 direct/propagated feature와 candidate role을 함께 관리한다. 별도 graph scorer가 기존 scorer 결과에 임의 bonus를 추가하는 경로는 두지 않는다. 근거의 고정값·숫자 계수는 §12의 calibration gate에서 확정한다.

WM의 시드별 FIFO BFS와 first-visit visited 규칙을 초기 전파 커널로 사용하지 않는다. 모든 직접 신호와 그래프 접근은 같은 frontier에 작업을 넣고, 이미 처리한 node라도 activation이 개선되면 같은 정책으로 다시 평가한다.

~~~text
offer(v, value, witness):
  reject unless v and witness are eligible in the issued view
  if value strictly improves bestActivation(v):
    atomically update activation + winning path + dependencies + pathVersion
    enqueue v with its current pathVersion in the common frontier

pop(v, version):
  discard stale queue items whose version no longer matches
  read eligible outgoing edge pages through Memory Lane
  offer each target with the attenuated value and its extended witness
~~~

위 offer/pop은 의미 설명용이다. epsilon·부동소수 비교·동점의 결정 순서는 versioned numeric policy로 정한다. 같은 activation의 설명 경로를 교체할 경우에도 점수·근거·dependency를 일관되게 유지한다. 점수는 최댓값을 보존하면서 edgeChain만 약한 최신 경로로 덮어쓰는 갱신은 허용하지 않는다.

고정 최대 2홉을 전체 접근 범위로 삼지 않는다. 정당한 3홉 이상 연결도 동일 예산 안에서 탐색할 수 있다. hop/work 제한이나 tolerance로 남은 영향 평가를 생략하면 stopReason과 traversal coverage에 반영한다. 감쇠·동일값 재확장 금지와 versioned queue로 순환 증폭을 막고, bounded working set 한계에 닿으면 partial을 반환한다.

### 6.4 단일 frontier와 종료

우선순위 큐에는 candidate와 아직 읽지 않은 page/region cursor가 함께 들어간다. 가장 유용한 후보·연결·페이지를 한 controller가 방문한다. hydration 후보 수와 출력 개수는 별도 예산이다.

complete는 선언한 scope/view의 적격 접근 스트림을 소진했거나, **증명 가능한 score upper bound**로 남은 영역이 선택 결과를 바꾸지 못함을 확인했을 때만 사용한다. centroid·sketch·heuristic confidence만으로 unseen region을 완료 처리하지 않는다.

deadline, request bytes, hydration/proof budget, unavailable shard, dirty index, 지원되지 않는 binding으로 멈추면 partial/degraded와 unread cursor/region·stopReason을 반환한다. page exhaustion, index coverage, representation coverage, traversal completion, final delivery completion은 각각 다른 상태다.

complete 판정은 node의 최초 방문이나 그래프의 화면 표본 소진과 무관하다. 미처리 activation 개선, unread adjacency/direct-access cursor, 수치 tolerance의 남은 영향까지 포함한다. 처리 순서·cold/warm page 도착 순서가 달라도 동일 declared-complete 결과와 결정적 winning witness를 반환해야 한다.

## 7. 캐시·Memory Lane·인덱스의 공동 재설계

### 7.1 기억·저장 계층

| 계층 | 내용 | 수명·소유권 |
| --- | --- | --- |
| L0 Request Workspace | query frame, frontier, bounded candidate/activation table, 설명 경로, issued readset | 요청·취소 경계까지. finally에서 pin/작업 해제 |
| L1 Resident Cache Pools | node/edge/posting/vector pages, 표현·질의 feature, 검증 전 locator | 전체 resident byte 예산 아래 공유. 캐시가 권한을 발급하지 않음 |
| L2 Durable Derived Store | 공통 graph shards, index manifest, reverse dependencies, statistics, embedding representation pages | 소유자 원본에서 재생성 가능. generation 단위 publication |
| L3 Source Owners | canonical/Micro/receipt, State·registry·correction, native lore | 기존 소유·transaction 유지. L1 eviction이 L3를 삭제하지 않음 |

위 L0–L3는 데이터 수명 계층이다. 기존 interactive/background/maintenance compute scheduling lane과 혼동하지 않는다.

### 7.2 Cache Manager와 바이트 예산

v1.4의 첫 구현은 [UM2 page/cache 계약](LIBRA_UM2_PAGE_CACHE_CONTRACT.md)의 파생 JSON pages·request decode lease·staging admission이다. 아래 목록은 **최종 전체 엔진 요구사항**이며, source map/frontier/I/O/write barrier·durable bounded owner read는 아직 구현 완료로 판정하지 않는다.

한 cache manager가 예산·pin·eviction·invalidation·계측을 통제하고, payload pool은 역할별로 나눈다. 모든 자료를 한 Map에 모으는 설계가 아니다.

- residentBudgetBytes, requestBudgetBytes, buildStagingBudgetBytes, ioPageBytes를 admission 전에 예약한다.
- node/edge/posting/vector/query/session/cursor·in-flight coalescing·serialization/decompression staging을 모두 accounting 범위에 포함한다.
- typed-array의 실제 bytes, 문자열·metadata의 보수적 accounted bytes, 측정되지 않은 JS/runtime overhead를 분리한다. UTF8 JSON bytes를 실제 heap 전체라고 부르지 않는다.
- cold page header의 크기를 먼저 확인하고 bounded read/decode한다. 로딩 후 초과를 발견하는 방식만으로 메모리 상한을 주장하지 않는다.
- pin된 request pages와 capability registry의 예산을 별도로 기록한다. pin이 eviction을 막으면 새 admission을 중단하고 backpressure·partial을 보고한다.
- eviction은 recency·재로딩 비용·크기를 고려하되 scope별 quota와 전체 budget을 함께 적용한다. scope 개수 제한만으로 byte bounded라고 주장하지 않는다.
- cache hit는 정확한 binding과 generation이 맞을 때만 인정한다. eviction/cold reload 전후 논리 결과가 동일해야 한다.

frontier·visited·path provenance를 요청마다 corpus 크기만큼 무제한 유지하지 않는다. 페이지 cursor와 bounded working set을 사용하고, 지원되지 않는 spill이나 메모리 초과 시 명시적 budget stop을 반환한다. request-local read-only 경로는 이 문제를 해결하려고 durable query 중간 결과를 저장하지 않는다.

### 7.3 역할별 캐시

| Pool | key의 필수 축 | 정책 |
| --- | --- | --- |
| Node/Edge/Postings | exact owner partition, projection/index schema, immutable page ID/digest | 새 view의 generation·manifest membership은 따로 확인. 불변 page bytes는 generation 간 재사용 가능 |
| Vector Representation | representation ID·실제 text/chunk binding·space/metric/precision | 다른 모델·표현·reset의 vector reuse 거부 |
| Query Feature/Embedding | exact query formatting/context identity, space/task pair, auth/config generation, privacy partition | 동일 요청 coalescing도 bytes·cancel ownership·waiter 수 accounting |
| State/Lore Projection | head/field/correction basis 또는 lore entry/body/activation revision, temporal view | source currentness와 publication dependency 유지 |
| Query Plan | QueryFrame·policy·entity/temporal interpretation version | 상태 결과를 고정값으로 몰래 재사용하지 않음 |
| Result Hint | 위 키와 실제 dependencies, coverage, policy | 후보 ID/설명 hint만 재사용. 최종 physical proof와 packet budget은 매 요청 재확인 |

secret credential 값은 persistent key·diagnostic에 저장하지 않는다. 인증 generation/issuer handle로 credential 변경을 구분한다. scope·viewer·lore configuration이 다른 요청은 적절한 privacy partition으로 분리한다.

작은 delta마다 모든 page key에 새 graph generation을 붙여 전체 cache miss를 만드는 방식은 피한다. immutable payload 재사용과 issued view/lease의 현재성은 분리한다. source·DF·degree·activation policy가 바뀌면 관련 평가/hint를 무효화하되, 새 manifest가 같은 page content binding을 확인한 payload는 재사용할 수 있다. 복원 뒤 같은 bytes를 재사용해도 이전 readset 권한은 되살리지 않는다.

provider/model metadata·토큰 캐시는 provider owner의 수명 규칙을 유지한다. State replay/correction cache와 복구 journal은 State transaction의 소유권을 유지한다. 중앙 cache manager의 일반 eviction으로 journal·authoritative State를 삭제하지 않는다.

### 7.4 차세대 Memory Lane

Memory Lane은 **공통 frontier의 페이지 접근과 작업 순서를 정하는 스케줄러**로 재정의한다. 정본 전용 block ranker나 별도 검색 엔진으로 남기지 않는다.

| Lane 역할 | 읽는 것 | 최종 순위·corpus 제외 권한 |
| --- | --- | --- |
| query anchor access | lexical/entity/predicate/time posting pages | 없음 |
| semantic access | 호환 representation/vector pages | 없음 |
| graph neighborhood | 활성 frontier에 연결된 typed edge·node pages | 없음 |
| temporal/state access | 해당 view의 State/lifecycle/provenance pages | 없음 |
| context expansion | 선택된 의미 단위의 original source/passage 문맥 | 없음 |

lane 종류는 I/O 필요를 설명하며 네 자료에 각각 독립 top-K·고정 출력 몫을 배정하지 않는다. 동일 page/node가 여러 lane에서 요청되면 한 번 읽고 같은 candidate에 연결한다.

catalog의 24-entry block과 6-block 선택은 현행 기준선의 정책이다. 새 정책에 상수 그대로 옮기지 않는다. entity/time/locality·posting 구조에 맞춰 shard/page를 설계하고, 이전 sketch/centroid는 읽기 우선순위 hint로 재사용할 수 있다. exact upper bound가 없으면 읽지 않은 블록을 relevance 없음으로 인증할 수 없다.

단일 controller가 deadline과 bytes·proof 예산을 배분한다. background build/prefetch는 interactive 요청에 자원을 양보하고 source/graph generation이 달라지면 게시하지 않는다. 미리 읽기는 corpus reanalysis나 역사 임베딩을 시작하지 않는다.

### 7.5 공통 durable 인덱스

v1.5는 현재 owner projection window의 nodes/edges/bases/units flat pages와 generation manifest/root를 구현했다. v1.6은 배열 기반 공통 index와 reverse dependency 커널을 추가했다. 이 index를 durable shards·공통 cache로 읽는 실제 query 연결, exhaustive source inventory·정확한 delta·vector access는 미완료다. 저장된 flat edge page나 메모리 배열을 완성된 durable graph traversal index로 보고하지 않는다. 현재 결함·연결 gate는 [현황 M02–M06](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)에 고정한다.

| 인덱스 | 단위와 필요 계약 |
| --- | --- |
| Node/Source directory | 안정/partial ID → source locator·representation·dependency·coverage |
| Typed adjacency | 방향·predicate·view·edge basis로 paging. high-degree node도 전체 materialization 금지 |
| Lexical postings | unit/family identity·field TF·전역 DF·언어/tokenizer version. 오래된 posting도 접근 가능 |
| Entity/predicate/time | 승인 identity와 qualified slot/time cursor. 동일 이름의 후보를 확정 entity로 바꾸지 않음 |
| State/lifecycle | field basis·clear·current/last-known·종결/재개·correction provenance |
| Lore passage/activation | entry·원문 offset·활성 조건·consumer policy·설정 적용 범위 |
| Semantic representation | 호환 공간별 packed pages·metric·precision·text/chunk binding |
| Reverse dependency | source/head/registry/correction/lore/vector 변화 → 영향을 받는 node/edge/shard/query hint |
| Region statistics | complete coverage와 generation에 결속된 DF·degree·upper-bound 자료 |

index manifest는 generation, schema/projection/tokenizer/policy binding, complete owner/view coverage, shard checksums·sizes, pending/deleted IDs와 publication basis를 담는다. 자료 하나의 존재 여부를 전체 corpus completeness로 확대하지 않는다.

변경은 base snapshot + exhaustive delta/tombstone으로 적용하고 reader에는 old-complete 또는 new-complete generation을 게시한다. 준비 중인 root를 complete로 공개하지 않는다. 로컬에서는 새 root last-write/readback, 서버에서는 기존 conditional batch/CAS 등 지원되는 소유자 메커니즘을 사용한다. 원자 publication 증명이 불가능한 adapter는 partial로 남는다.

### 7.6 기존 구조의 이전·폐기 표

| 기존 구조/함수 | 새 책임 | 이전 완료 조건 |
| --- | --- | --- |
| recallCatalogCache / loadOrRefreshRecallCatalog | 공통 node/source directory + representation pages | query·GUI reader가 공통 read model을 사용; 기존 schema import가 닫힘 |
| microRecallHeadCache / durable networkEvidence | Micro source/projection pages | receipt/head binding·pending coverage·독립 source-only 접근 동등 검증 |
| recallCatalogBlockCache / buildRecallCatalogBlockIndex / routeRecallCatalogBlocks | Memory Lane region/page directory·읽기 hint | 정본 전용 pre-filter 종료, unseen coverage·재시작 결과 검증 |
| memoryNetworkIndexes의 A2 metadata cache | 실제 durable graph/index reader | preparation-only 이중 loop 제거, 실제 query 접근을 계측 |
| evidenceLinkIndexCache / getEvidenceLinkIndex | typed adjacency·State provenance | 현행 권한/현재·역사 의미 보존; 512-memory/20k-fact legacy 표현 cap을 전체 graph cap으로 옮기지 않음 |
| loreLinkIndexCache / getLoreLinkIndex | lore/entity edge와 source directory | approved mapping과 ambiguity 유지, 공통 query에 참여 |
| ResponseLoreIndexCache / lore token·linear query caches | lore representation/posting/query feature pools | 별도 corpus tokenization·ranking 반복 종료 |
| embedding queryCache/queryInFlight | query/vector pool + 기존 provider adapter | profile/auth/cancel isolation과 physical call 예산 유지 |
| pairRevisionCaches / raw source fence | owner/currentness adapter의 bounded read cache | trusted native mutation/topology 증명 확보 전 전체 검증 제거 금지 |
| continuity read cache / State replay cache | 요청 provenance pool / State-owner replay cache | read-only와 transaction 소유를 분리하고 correction·rollback 보존 |
| consumer/GUI/GRADIA result hints | sealed dependency-aware hint/read model | cache hit마다 정책·최종 readset 재검증. GUI의 Memory Lane 진단 의미를 version으로 구분 |

provider 인증 캐시, generation job journal, backup/restore transaction은 그래프 cache로 합치지 않는다. 다만 어떤 저장 bytes·pin·in-flight 작업을 새 engine budget이 담당하는지 inventory에 기록한다.

### 7.7 HME 경험을 반영한 저장·접근 계약

WM의 bucket 40, memory-pair local 선택 8, retained node/전체 edge/시드/후보 상한은 참고 구현의 비용 정책이다. local 8은 모든 노드의 최종 degree 상한도 아니다. 이 값을 차세대 원본 corpus나 durable adjacency의 표현 범위로 옮기지 않는다. 필요한 구조 엣지는 적격 자료를 완전 열거한 shard/page에 보존하고, 아직 근거를 만들 수 없는 관계는 coverage로 표시한다.

대상·출처·정정 등 구조 연결에 페이지 접근 기회를 먼저 부여하고, 조밀한 연상 연결은 같은 공통 작업 예산에서 처리한다. 페이지가 넘치면 split/continuation으로 이어 읽으며, 허브·종류별 cache reservation은 resident 유지 정책으로만 사용한다. cache에서 밀린 entity/lore/오래된 기억도 durable index를 통해 발견할 수 있어야 한다. source family별 고정 top-K나 영구 제외 quota를 만들지 않는다.

SourceGraph 구축·delta 적용·restart 독립 검증·durable publication은 maintenance 작업이다. query는 발급된 verified generation을 읽으며, 없는 projection을 허용된 source page에서 요청 내 임시 투영할 수 있다. query 중 캐시 miss를 핑계로 durable graph cold build/write를 실행하지 않는다. 지원 범위를 읽기 전용 fallback으로 해결할 수 없으면 partial을 반환한다. 자동 원문 재분석·State 쓰기·역사 임베딩도 시작하지 않는다.

graph states뿐 아니라 전체 source map, revision 검증 자료, queue·write barrier·serialization/readback staging도 공통 inventory와 byte admission에 포함한다. 48개 scope 같은 개수 제한만으로 그래프 메모리 상한을 주장하지 않는다. high-degree adjacency는 paged access를 사용하며 작업 순서는 Memory Lane이 공통 frontier와 조정한다.

## 8. 임베딩 공간과 표현 계약

SpaceBinding은 provider endpoint/adapter semantics, model/version, document/query task·instruction pair, dimensions, normalization/metric, profile/config generation, projection/chunk version, precision, viewer/privacy/reset generation을 식별한다. query와 document의 task 문자열이 무조건 같아야 하는 것이 아니라 **해당 provider가 정의한 호환 task pair**여야 한다.

실제 vector가 만들어진 text·chunk/layout과 binding을 확인한다. 같은 차원, 같은 logical claim ID 또는 내용 일부 겹침은 재사용의 충분조건이 아니다. 기존 whole-memory/section vector를 새 fact vector라고 이름만 바꾸지 않는다. 해당 source/container representation의 접근 신호로 사용하고, 그 근거가 연결된 child unit으로 전달되는 경로를 기록한다.

vector가 없는 State/lore/Micro도 typed/lexical/graph 접근으로 검색할 수 있다. 새 representation 생성은 기존 허용된 producer 작업 또는 명시적 embedding 작업에 속한다. query 중 missing document vector를 채우려고 embedding을 호출하지 않는다.

정확한 paged O(Nd) dense access를 초기 검증 기준으로 허용한다. ANN/sketch로 corpus를 제외하려면 별도 approximation·coverage·품질 수용 계약을 먼저 정의한다. 기존 저장 precision을 몰래 변경하지 않는다.

## 9. 갱신·무효화·동시성

### 9.1 소유자 변경 신호

warm 전체 검증 비용을 줄이려면 원본 소유자가 정확한 fromRevision/toRevision, exhaustive changedIDs/deletedIDs와 publication/restore generation을 증명해야 한다. manifest 한 키의 revision이나 메모리 안의 counter만으로 외부 body 수정까지 포괄한다고 가정하지 않는다.

plugin host·native lore에 trusted revision API가 없는 경우 exact fallback 검증을 유지하고 비용·coverage를 보고한다. server per-key metadata/paged enumeration도 owner-wide change-set의 완전성을 자동 보장하지 않는다. 지원되지 않는 fast path는 BLOCKED이며 기존 안전 검증을 생략해 warm-zero를 만들지 않는다.

### 9.2 주요 이벤트

| 이벤트 | 처리 |
| --- | --- |
| canonical/Micro 채택·revision·delete | 영향받는 source/node/edge/posting/vector representation/hint 무효화 |
| State/correction/alias merge·split | field·entity mapping·adjacency·관련 query plan/result hint 무효화 |
| lore 본문·activation·module 변경 | 해당 passage와 적용 edge·policy view 무효화 |
| model/profile/viewer/auth 변경 | 해당 space/query pool·in-flight publish 거부 |
| scope/native branch/predecessor view 변경 | 새 exact partition/query frame. 기존 작업을 새 scope에 게시하지 않음 |
| restore/reset A → B → A | nonrewinding runtime generation으로 이전 lease/result를 계속 거부 |
| 취소·중단·build conflict | reservation/pin 해제. 변경 중 shard는 partial/dirty; verified 전체 refresh 전 complete 거부 |

source mutation과 query 중 publication을 분리해 검증한다. 원본 내용·적격성·query space·선택 dependency가 동일함을 소유자 증명으로 확인할 수 있는 순수 derived publication은 새 요청 전체를 불필요하게 취소하지 않는 방향으로 설계한다. 증명이 없으면 기존 보수적 binding 거부를 유지한다. retry는 원래 deadline/예산 안의 bounded operation이며 새로운 모델 호출이나 무제한 재시도를 만들지 않는다.

### 9.3 영속 그래프 검증·경합·최소 변경 게시

WM typed 그래프의 재시작 검증처럼 저장된 checksum·source revision label만으로 현재 원본과의 일치를 인증하지 않는다. owner의 independent snapshot/change-set proof가 있는 경우 exact source inventory·coverage·projection dependencies를 검증한다. 그러한 증명이 없으면 현재 원본에서 필요한 node/edge 투영을 bounded 단계로 재도출해 검증하며, 확인하지 못한 영역은 dirty/unverified로 남긴다. 전체 재도출 비용을 cache hit나 warm-zero로 숨기지 않는다.

새 build에는 owner partition, source from/to revision, projection/index policy, nonrewinding restore epoch와 publication job token을 봉인한다. partition별 게시 순서를 유지하고 작업 전후에 token과 basis를 확인한다. scope clear가 이미 발행된 host write를 취소할 수 없으면 그 작업의 순서 barrier는 settle까지 유지한다. RAM handle과 root 게시 권한은 즉시 폐기한다. 실제 durable 원자성·stale write 방지는 owner CAS/transaction 또는 검증된 ordered root publication에 달려 있으며, token만으로 완료 주장하지 않는다.

node 재사용 fingerprint가 맞아도 관련 edge·전역 DF/degree·평가 hint의 영향 범위를 따로 검증한다. reverse dependency index는 body·alias·relation·State correction·lore activation 변화에서 영향을 받는 node/edge/posting/statistics를 열거한다. 국소 변경에는 해당 shards만 새로 준비하고 나머지 불변 pages는 새 manifest membership으로 재사용한다. 전역 통계나 normalization이 변하면 관련 shard/hint까지 넓혀 갱신한다. dependency 열거가 불완전하면 보수적 rebuild와 그 비용·coverage를 보고한다.

WM warm path의 전체 source fingerprint 계산과 수정 시 retained edge 전체 compile은 검증 fallback의 참고 사례다. 차세대 최적화의 완료 조건은 owner가 증명한 exhaustive delta로 반복 작업을 줄이고, 실제 query/read 경로에서 증명하는 것이다.

## 10. 선택·출력·최종 근거 검증

검색 결과는 top-K 텍스트 배열에 그치지 않고, 질문을 설명하는 EvidenceBundle을 반환한다. 선택된 meaning node, source span, State basis/lore role, temporal interpretation, conflict/unknown, closure dependency와 representation coverage를 포함한다.

한 공통 선택기가 query coverage·관련성·문맥·중복·출력 예산을 다룬다. 소비자별 instruction/required lore/current input 계약을 존중하되 별도 검색을 다시 실행해 결과를 섞지 않는다. 활성 연결 대상은 **LIBRA Classic·GUI와 별도 GRADIA의 셰도우·AIDE·인풋 작성기**다. LIBRA의 Planner·SGA·Input Writer 실행 기능은 퇴역했다. kernel에 남은 구형 packet 포맷은 활성 제품 소비자나 실행 권한의 증거가 아니다. GRADIA의 기존 owner-corpus/selection receipt 조건을 우회하지 않는다.

GRADIA 셰도우·AIDE의 기존 서버 읽기와 새 통합 엔진 연결은 구분한다. GRADIA 인풋 작성기는 현재 기억 회수를 하지 않으므로, 미전송 제안·작성 작업별 읽기 세션·최종 편집/send 검증을 먼저 정의해야 한다. 이전 셰도우 실행의 private 근거를 작성기에 넘기지 않는다. 세부 범위와 완료 기준은 [다음 과제 N00/N03/N04](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)를 따른다.

정본/Micro 대응이 확인돼도 실제 정본 출력이 budget에서 탈락하면 Micro를 억제하지 않는다. 억제된 claim의 source·entity·State/lore dependency도 private readset에 보존한다. 여러 자료가 같은 원문에 의존하면 독립 supporting source로 중복 계산하지 않는다.

최종 렌더링의 실제 admission을 반영해 readset을 완성하고, model dispatch/send 경계에서 원본 owner의 physical body·revision·scope/view·runtime generation을 검증한다. packet 조립이 먼저 수행되더라도 최종 검증 후에만 외부 전달한다. stale 근거는 전달하지 않으며 기존 base model 요청 경로를 보존한다.

## 11. 제안된 인터페이스와 관찰 자료

아래 이름은 설계용이며 현재 제품 API가 아니다.

~~~text
SourceAdapter.describeCoverage(frame)
SourceAdapter.readProjectionPage(cursor, frame, budget)
SourceAdapter.readChangeSet(fromRevision, frame)
SourceAdapter.hydrateOriginal(locators, frame, budget)
SourceAdapter.validateConsumedReadSet(privateHandle, frame)

GraphStore.prepareGeneration(basis, delta, budget)
GraphStore.openView(frame) -> issued QueryGraphView
GraphStore.readNodePage/readEdgePage/readPostingPage/readVectorPage(view, cursor)
CacheManager.reserve/pin/release/invalidate/inspect
MemoryLane.nextAccess(frontier, view, query, budget)
QueryEngine.retrieve(queryFrame, view, adapters, budget)
QueryEngine.scoreCandidate(candidate, features, policy)
EvidenceCompiler.select/render/validate(bundle, consumerPolicy)
~~~

view/continuation cursor는 발급 instance·generation·QueryFrame에 결속된 opaque handle이다. JSON clone/변경된 query/stale cursor를 권한으로 인정하지 않는다. 물리 데이터·proof capability를 public graph serialization에 넣지 않는다.

진단에는 engine/policy/schema version, exact snapshot identity의 비밀 없는 요약, source/representation/index/traversal/delivery coverage, scanned nodes/edges/vectors/dot terms, candidate merges, page reads/hits/misses, warm validation/hash/parse, resident/request/pinned/staging accounted bytes·unmeasured overhead, cancellation/backpressure/stopReason을 포함한다.

요청별 counters는 request ID/operation context에 귀속한다. 동시 요청을 lifetime-all-scopes counter 차분으로 개별 비용이라고 보고하지 않는다. lexical/semantic/graph/temporal 접근 설명은 남기되 과거 별도 ranker가 계속 실행됐다는 뜻으로 사용하지 않는다.

winning activation·pathVersion·edge basis·dependency를 묶어 설명한다. 적격 corpus와 index coverage, 실제 방문 node/edge, 누락·미탐색 region, hub 경유, 화면 표본을 별도 필드로 보고한다. 표본의 node/edge 끝점을 맞추고 `sampleCoverage`를 명시한다. 표본에서 인물/로어가 안 보이는 것을 전체 연결 부재로 판정하지 않는다. 공개 진단은 viewer가 알 수 있는 자료와 허용된 집계만 포함한다.

## 12. 검증과 성능 gate

### 12.1 수용 시나리오

| ID | 확인할 동작 | 요구 연결 |
| --- | --- | --- |
| V01 | 정본 수령 → Micro 양도 → State 현재 소유자 → lore 사용 규칙을 한 요청에서 검색 | U01,U02,U04 |
| V02 | 표현이 다른 의미 질의, embedding 없는 source-only, 오래된 최소 빈도 기억도 접근 | U02,U07 |
| V03 | 동일 출처 여러 표현/경로, 반복 quote, 동명이인, hub/cycle가 relevance·증거 수를 중복 증폭하지 않음 | U03 |
| V04 | 현재/과거/분기/predecessor·viewer 혼합, unknown/clear/last-known을 정확히 구분 | U04,U05 |
| V05 | cold/warm/eviction/restart·shard 삭제 후 동일한 complete 논리 결과; partial은 명시 | U06,U07 |
| V06 | 같은 ID·길이 body 수정, correction·alias·lore activation, profile·space 변경 무효화 | U05,U08 |
| V07 | restore ABA, cancellation, 동시 writer, pure derived publication, busy request와 late publish | U08 |
| V08 | query 중 reanalysis/State write/document embedding 0; 허용된 query embedding만 호출 | U09 |
| V09 | 최종 budget 탈락·중복 억제·선택 source/registry/lore 변화의 실제 dispatch 거부 | U03,U10 |
| V10 | 바이트 admission·pin pressure·큰 단일 page·high-degree adjacency·cursor/visited 증가·강제 종료 정리 | U06,U07,U08 |
| V11 | 이전 catalog/block/ELI/LLI/lore ranker가 unified 정상 요청에서 이중 실행되지 않음 | U06 |
| V12 | plugin_only/server_only 결과·proof 동등성, 지원하지 않는 host 기능은 BLOCKED 명시 | U05,U08,U10 |
| V13 | 직접 신호·먼저 도달한 약한 경로 뒤 더 강한 경로가 발견되면 재평가; 3홉 연결·cycle·동점·페이지 순서에서도 결과/설명 일치 | U02,U03,U07,U10 |
| V14 | 같은 endpoints의 여러 predicate·방향·시간·basis를 보존; 추정 association을 인과·정정·현재 상태로 승격하지 않음 | U03,U04,U05 |
| V15 | 보호·타 분기·미래 자료를 seed·중간 경유·진단에서도 제외; 서로 다른 viewer/as-of 요청이 source graph를 다시 쓰지 않음 | U04,U05,U09,U10 |
| V16 | checksum이 맞는 오래되거나 일부 누락된 저장 그래프도 source inventory/edge 검증에서 거부; restart 미검증 영역은 dirty/partial | U07,U08,U10 |
| V17 | 인물 허브·구조 엣지·오래된 low-frequency source가 resident 축출/조밀한 연상 후에도 durable page로 발견; 실제 bytes와 unread coverage 보고 | U01,U06,U07 |
| V18 | query cold miss의 durable graph write/publication 0; owner delta·취소/clear·late storage settle 이후 현재 generation만 게시 | U06,U08,U09,U10 |

각 시나리오는 owner-adapter fixture, 실제 registered hook/consumer packet, 가능해진 시점의 실제 호스트 검증을 구분한다. mirror는 migration evidence로 유지한다. 기존 typed lifecycle/schema/State correction·source admission·final-proof 회귀도 이어 간다.

### 12.2 평가 기준과 미확정 수치

semantic retrieval 평가 세트에는 네 자료 연결 질문, 단일 자료 질문, 명시적 과거·현재·비교, 오래된 사건, 한글 별칭, 충돌/모르는 사실을 포함한다. 정답 node/span·현재성·필요 provenance를 고정하고 main 및 ca40d76 legacy 경로와 비교한다.

측정 항목은 evidence recall/precision·필요 연결 도달률·최종 grounded answer·잘못된 현재성/authority 승격·불필요 중복·반응 지연·event-loop stall·cold/warm I/O·hash/parse·steady-state heap/peak RSS/external/arrayBuffers·pin/staging이다. 합성 vector scan이나 page allocation bytes만으로 실제 품질/성능을 인증하지 않는다.

| 결정 | 확정 방법 |
| --- | --- |
| direct feature calibration·전파 감쇠·edge type weight·정지 tolerance | 고정 평가 세트의 source binding·정답 근거와 ablation |
| resident/request/build byte defaults·page layout | 지원 호스트/기기의 실제 측정과 pressure/cancel 재현 |
| latency·품질 합격 수치 | 동일 장비·source/profile의 legacy 기준선 측정 후 versioned qualification profile에 기록 |
| trusted owner/native/lore change-set protocol | 지원되는 API와 모든 writer·restore·외부 수정 경계의 증명 |
| ANN·학습형 edge/scorer | 별도 후속 설계·approximation/학습 자료·설명/권한 검증 |

WM의 role weight·meaning threshold·spread factor·preset은 ablation 비교 자료로 기록한다. 코드에 존재한다는 이유만으로 LIBRA 기본값이나 검색 품질 인증으로 사용하지 않는다. V13–V18에는 HME에서 확인한 first-visit·동일 pair 병합·약한 경로의 설명 덮어쓰기·조회 중 derived write·restart 일부 누락을 재현하는 차세대 fixture를 포함한다.

수치가 미확정인 동안 설계 존재와 제품 성능 인증을 구분한다. 현재 A2의 actual 100k OOM/BLOCKED와 warm 전체 검증 비용을 그대로 기록한다. 큰 corpus는 small bounded diagnostic → 실제 source workload의 단계적 scale 순서로 검증하며, 기존 금지된 100k 재실행/heap 증액을 이 문서가 승인하지 않는다.

## 13. 이전 계획과 종료 조건

| 단계 | 산출물 | 다음 단계 gate | 기존 단계와의 관계 |
| --- | --- | --- | --- |
| UM0 기준 고정 | 현재 source/hash·호환/실패·질의 평가 세트·cache/index/lane inventory | 현재 증거와 목표를 구분, 모든 기존 구조의 소유·크기·invalidation 확인 | A0/A1/A2/B1 보존 |
| UM1 공통 모델 | 세 층 노드·edge·family·QueryFrame·State/lore adapter 계약 | 네 자료와 ambiguity·current/past 역할 fixture | A1/B1 확장, 기존에 비어 있던 네 자료 통합 명세 |
| UM2 저장·메모리 기반 | durable shards·공통 indexes·cache manager·새 Memory Lane·space binding | 실제 read/query 사용, bytes·coverage·atomic generation·source protocol gate | A2 재설계 + B2 |
| UM3 단일 검색 커널 | feature calibration·전파·공통 frontier·scoreCandidate/retrieve | V01–V04·V10, 기존 scorer에 graph bonus를 더하는 경로 없음 | C2/D1의 구체화 |
| UM4 소비자·검증 통합 | EvidenceBundle·모든 consumer adapter·physical readset | V06–V09·V12 및 현재성/State/GRADIA 회귀 | D1 후속 전달 경계 |
| UM5 품질 인증 | 고정 snapshot/offline 평가·실제 workload qualification | 합격 수치·지원 profile·unresolved BLOCKED 공개 | C2/D2 검증 |
| UM6 기존 경로 종료 | 중복 cache/index/Memory Lane/ranker 제거·호환 importer/진단 문서 | V05,V11; 실제 unified 요청의 이중계산 0 | 전환 완료 조건 |

새 설계의 acceptance를 기존 source-identical packet parity로만 정의하지 않는다. State/lore를 직접 검색하고 정당한 연결을 추가하므로 일부 결과는 의도적으로 달라진다. 보존해야 할 불변식과 개선해야 할 평가 결과를 각각 판정한다.

전환 초기의 비교 경로는 source snapshot을 고정해 사용한다. main의 알려진 연상 proof 결함을 정상 기대값으로 채택하지 않는다. shadow는 결과를 실제로 두 번 주입하지 않으며 같은 호환 query vector·source view를 공유할 수 있을 때만 공유한다. 검증을 위해 추가 모델 호출·공간 변경이 필요하면 별도 명시적 작업으로 기록한다.

실제 요청은 unified 경로만 봉인한다. `legacy`·`shadow`는 호환 입력으로 unified로 이관하며, 실행 선택지로 제공하지 않는다. unified 중간 실패가 기존 독립 ranker를 몰래 실행하고 complete를 붙이는 fallback을 만들지 않는다. 동일 unified 엔진의 bounded source-page fallback 또는 명시적 partial/기존 base request를 사용한다.

**완료 판정:** 네 자료가 실제 공통 탐색에 참여하고, 캐시·Memory Lane·인덱스가 같은 generation/byte/coverage 계약으로 동작하며, unified 정상 요청에서 기존 독립 후보/순위/캐시 재구성이 종료돼야 한다. 레지스트리·API 이름 추가, 인덱스 준비 또는 검색 결과의 마지막 병합만으로 완료 처리하지 않는다.

`83caadd`에서는 UM1 reader의 제한 범위와 UM2 payload cache/durable window API에 등록 합성 호스트 증거가 있다. UM2 common index/Lane와 UM3–UM6 신규 커널은 실제 통합 요청에 미연결이며 위 단계 gate를 닫지 않았다. 현재 판정은 [현황 §7의 G1–G6](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md#7-검증-공백과-완료-gate)로 추적한다.

## 14. 구현 시작 전 기록할 결정

현재 실제 네 자료 reader·공통 page/cache에 [durable window/generation 게시·독립 reader](LIBRA_UM2_DURABLE_GRAPH_CONTRACT.md)를 연결했고, 별도로 Index/Lane/Query/Compiler/Rollout 커널을 내장했다. 다음 우선 작업은 [현황 D01–D08](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)의 시간·물리 검증·폐기·GC·coverage·역의존·출력·V05 결함 수리다. 이어 M02–M05/M11에서 exhaustive inventory와 durable 공통 index/cache/Lane·byte/delta 접근을 연결하고, M01/M06–M10에서 실제 embedding·QueryFrame·소비자·private owner dispatch를 연결한다. 사용자의 완전 대체 지시에 따라 v1.14에서 기존 serving ranker·준비 작업·최종 renderer를 제거했다. qualification은 레거시 복귀 gate가 아닌 새 엔진의 독립 인증 과제로 남는다. 안정 lifetime·미지원 inherited Micro·page 밖 근거·host protocol 한계는 별도 coverage/partial로 유지한다.

WM 검토를 반영한 첫 fixture는 정본의 물건 수령 사건, Micro의 양도 원문/claim, State의 현재 소유자와 correction basis, lore의 사용 규칙을 공통 인물·물건·출처에 연결한다. 같은 pair의 서로 다른 관계, 뒤늦은 강한 경로, 보호된 중간 노드, resident에서 축출된 과거 자료를 함께 둔다. 이 자료로 adapter coverage와 graph/kernel 계약을 먼저 검증한 뒤 cache/Lane/index 구현으로 확장한다.

UM0 inventory에는 참고 WM source fingerprint·두 그래프 경로·두 검색 경로의 경계·원본 권위·restart 검증 비용을 기록한다. UM1은 §4.5의 개념 대응을 실제 LIBRA reader/owner schema로 치환한다. UM2는 §7.7/§9.3의 byte admission·maintenance publication·exhaustive delta gate를, UM3/UM4는 V13–V18의 단일 전파·적격 경유·설명/출력 검증을 완료한다. 이전 HME의 복원 비목표를 통합 설계의 재사용 원칙까지 금지하는 것으로 확대하지 않는다.

각 구현 단계는 source SHA, kernel/policy/schema version, 원본·파생 데이터의 변화, 실제 등록 훅/packet, cache/lane/index 이전 완료 표와 남은 gate를 저장소 안의 재현 가능한 증거에 기록한다. 임시 실행 환경 절대경로만을 문서의 유일한 검증 근거로 사용하지 않는다.

## 15. 변경 기록

| 버전·일자 | 변경 |
| --- | --- |
| 1.0 · 2026-10-13 | 네 자료·단일 검색·캐시·Memory Lane·공통 인덱스의 최초 통합 설계 |
| 1.1 · 2026-10-14 | WM HME 검토 반영: 역할/다중 관계, 원본/요청 뷰 분리, activation 재평가·설명 정합성, exhaustive page 접근, maintenance 게시·restart 검증·변경 가드, V13–V18 추가 |
| 1.1 · 2026-10-14 | UM0/UM1 대응표 초안([LIBRA_UM0_UM1_ADAPTER_MAPPING.md](LIBRA_UM0_UM1_ADAPTER_MAPPING.md)) 연결. §1 문서 목록·§14에서 참조. 설계 결정이 아니며 열린 항목을 포함 |
| 1.2 · 2026-10-14 | 공통 NodeID·EdgeID/basis·binding 1차 계약과 normalized 커널·합성 13-node/19-edge fixture, 14개 identity 검증 구현. 실제 reader/검색/dispatch gate는 미완료 |
| 1.3 · 2026-10-14 | 네 자료의 실제 owner reader와 공개 read-only graph projection page 구현. 등록 API의 plugin_only/server_only 합성 호스트, source-only·정정·clear·본문 경합·cursor/route 및 11개 schema 계약 검증. 검색·durable/cache/Lane·dispatch는 후속 gate |
| 1.4 · 2026-10-14 | 공통 accounted-byte JSON page cache·pin/LRU·partition·staging/decode admission과 실제 owner projection access API. snapshot/binding/restore cursor·예산 stop·13개 순수 검사·실제 등록 API/portable restore 검증. 전체 heap·durable SourceGraph/generation·Lane/검색은 후속 gate |
| 1.5 · 2026-10-14 | durable owner-window pages·generation manifest/root-last/서버 CAS와 전체 window source/payload 재도출 reader. 12개 순수 계약 검사·실제 등록 API/재시작·오염·취소 barrier·portable restore·서버 publisher 경합 검증. exhaustive corpus/delta·공통 access index·Lane/검색/dispatch는 후속 gate |
| 1.6 · 2026-10-14 | UM1 reader 수정 및 UM2–UM6 커널 추가·LIBRA.js 내장, 9개 그래프 테스트 파일 통과. 최초 완료 표현은 v1.7에서 실제 호출·증거 범위에 맞춰 정정 |
| 1.7 · 2026-10-14 | `83caadd`의 실제 요청 미연결·임베딩/공통 접근/소비자/legacy 미완료를 명시. 현황표 E0–E4·D01–D08·M01–M15·G1–G6와 저장소 재현 리뷰 추가. 미래 Micro/검증·폐기/GC/coverage·역의존/출력/V05 결함과 host 한계를 분리. runtime 수정은 포함하지 않음 |
| 1.8 · 2026-10-14 | private 최종 전달·시간·구조화 대응·원자적 GC·byte admission의 강화된 실행 경계 반영 |
| 1.9 · 2026-10-14 | 정본 global projection 벡터와 실제 provider/query cache를 단일 scorer/frontier에 연결한 native semantic 범위 반영 |
| 1.10 · 2026-10-14 | LIBRA Planner·SGA·Input Writer 퇴역과 별도 GRADIA 소비자 경계를 정정. 기존 셰도우/AIDE 서버 읽기와 새 엔진 연결, 인풋 작성기의 새 세션 계약을 구분하고 N00–N07 작업 계획 연결. runtime 변경 없음 |
| 1.14 · 2026-10-14 | 사용자 완전 대체 지시에 따라 unified를 기본·유일 검색기로 전환. cold/stale 전체 구간 검색, Classic/GUI/GRADIA 기본 연결, 기존 serving ranker·준비·renderer·UI 제어 종료. 실제 설치/규모 인증은 별도 미완 |
| 1.15 · 2026-10-14 | 신규 게시 공통 index의 선택적 비동기 저장 page 접근·Cache Manager·물리 payload admission/trace와 전체 read-only audit 연결. 단일 Query/Lane 알고리즘·native 원본 재검증 유지 |

## 14. 리뷰 후 강화한 실행 경계 (v1.8)

- **최종 소비자**: 통합 packet의 public DTO는 전달 권한이 아니다. 발급한 packet과 readset의 private identity를 실제 주입 직전에 검사하고 물리적 원본·restore/scope/owner·최신 요청 소유권을 확인한다. 소비자 포맷 검증 실패는 dispatch를 차단한다. Classic wrapper와 명시적 최근 대화까지 전체 출력 예산 안에 있어야 한다.
- **과거 적격성**: canonical native evidence 참조에서 주장별 시간을 보존한다. 복수 근거의 가장 늦은 턴, unknown 시간, basis·중간 연결까지 적격성에 반영한다. 불명 근거를 과거 사실로 보내면서 complete를 주장하지 않는다.
- **중복 통합**: lexical 유사성은 검색 신호다. Micro 제거 권한은 동일하고 유일한 구조화 의미·원문 occurrence에 결속된 owner correspondence에서만 나온다. 초기 자동 흡수는 확인된 character/world scalar set/clear 범위이고, reference·collection·profile·모호한 claim은 독립 근거로 남긴다.
- **GC**: full durable inventory와 원자적 namespace fence는 별개 조건이다. 삭제는 진행 중 build/publisher·reader pin·루트와 candidate 값을 같은 원자적 경계에서 보호해야 한다. native bridge가 지원하지 않으면 dry-run만 가능하고 sweep은 명시적으로 blocked다.
- **캐시/예산**: admission 실패 후 원래 배열이나 무계상 JSON clone으로 우회하지 않는다. 지원하는 page ceiling 안에서 admission을 재시도하거나 오류/partial을 공개한다. UTF-8 payload bytes·accounted workspace estimate·누적 전송량·문자 예산을 구분하고 미측정값을 0으로 채우지 않는다.

이 강화는 §13의 전체 완료 gate를 대체하지 않는다. 기본 모드와 실제 호스트 qualification은 [현재 현황](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)에 따른다.


## 15. Native semantic 접근 구현 (v1.9)

[UM3 native semantic 계약](LIBRA_UM3_NATIVE_SEMANTIC_CONTRACT.md)에 따라 현재 정본 global projection의 저장 벡터와 기존 제공자 질의 벡터를 실제 unified/Classic 경로에 연결했다. global vector의 의미 범위는 정본 SourceNode에 유지하고, 동일 scorer/frontier에서 원래 관계를 확장한다. 개별 claim/다른 자료에 벡터를 복사하지 않는다. 실제 저장 projection·task pair/차원·설정/권한 epoch와 물리적 vector readset을 보존한다.

이 경로는 query 중 문서 벡터를 만들지 않는다. 공간/문서 벡터가 없으면 공통 lexical/graph 경로로 검색하고, representation 예산 탈락은 partial, 원본/설정 변경은 base request 보존으로 처리한다. source 전체 벡터가 과거 조회보다 미래를 포함하면 해당 semantic 접근을 제외한다. 기존 query cache·coalescing은 request scope/worldline/restore/view에 결속한다.

지원은 plugin_only/server_only의 등록 fixture에서 검증했고 mirror readonly owner·실제 provider 품질/설치 호스트·전체 corpus/durable representation pages와 §13의 기본값 전환 gate는 남아 있다. 최신 증거는 [현황 §13](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md#13-native-임베딩-연결)을 따른다.

## 16. 현재 소비자와 다음 과제 (v1.10)

`3e589dd`의 호출 경로 재검토와 기존 퇴역·Classic 2파일/GRADIA 42검사에서 LIBRA의 Planner·SGA·Input Writer 실행 제거를 확인했다. 구형 설정/백업·호환 포맷에 이름이 남는 것과 실제 helper 호출은 구분한다. [제품 역할 계약](PLUGIN-ROLE-AND-STORAGE-DESIGN-20261007.md)의 퇴역 결정을 유지한다.

다음 엔진 구현 우선순위는 전체 기록의 durable shard/index와 공통 Cache Manager·Memory Lane 연결이다. 그 위에서 자료별 semantic 표현, 별도 GRADIA의 읽기 adapter·private 선택 영수증 검증, 인풋 작성기 세션, native GC, 품질/호스트 인증과 legacy 종료를 진행한다. 상세 산출물·선행 조건·완료 기준은 [N00–N07 계획](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)에 결속한다. 이 문서 갱신은 그 과제들의 구현 완료가 아니다.
