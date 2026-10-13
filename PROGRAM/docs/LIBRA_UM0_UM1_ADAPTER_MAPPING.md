# LIBRA UM0/UM1 대응표 초안 — 현재 reader schema → 새 adapter 표

- 지위: **초안. 제안이며 승인 아님.**
- 기준: 소스 `9f64f43`(branch `codex/libra-memory-network-20261013`), 설계 문서 **v1.1**(2026-10-14 갱신) §3~§9·§11~§14, 그리고 `WM_HME_ASSOCIATIVE_GRAPH_REVIEW_20261014.md`.
- 이 개정판(v2)에서 반영: §4.4 **EdgeID exact identity**, §4.5 **SourceGraph / QueryGraphView**, §7.7 **저장·접근 계약**, §9.3 **영속 그래프 검증·최소 변경 게시**, §12.1 **V13–V18**, §14의 **첫 fixture 범위**.
- 표기: **현재 근거**는 확인한 심볼·스키마. **확인 필요**는 코드 정독이 더 필요한 항목(§G). 이 문서는 새 기능을 주장하지 않고 대응 관계와 미정 사항만 기록합니다.

## A. 자료 adapter · 그래프 계층 대응표 (§4.5, §5, §7.7, §11)

| 새 인터페이스 (§11) | 대상 의미 | 현재 구현·스키마 | 현재 식별자 | 변환(투영) 규칙 | 검증 시나리오 |
| --- | --- | --- | --- | --- | --- |
| `describeCoverage(frame)` | 정본·Micro·State·lore 각각의 검색 coverage + source inventory | Micro `libra.micro_network_access.v1`(`coverage`·`identityCoverage`·`rejectedIds`·`ineligibleCandidates`·`policy`·`representation`), 정본 reader(`libra.canonical_reader_page.v1`·`…_chapter.v1`), State `domainStatus`, LLI 상태 | scope, revision | `complete/partial/pending/blocked` + 사유 + 미충족 의존성 | V05, V12, V16 |
| `readProjectionPage(cursor, frame, budget)` | MeaningNode 페이지 | A2 `createPagedIndex`(owner-bound token/entity/predicate/time postings, reverse source dependency, exact metadata tuple, optional packed vector page) | `pageSize=256`, physical `memoryKey` | NodeID 기준 페이지 + `representationRefs`; **페이지 넘침은 split/continuation** (§7.7) | V10, V13, V17 |
| `readChangeSet(fromRevision, frame)` | 증분 변경분 | `refreshMemoryNetworkIndex` + `manifestRevisionOf(key.manifest(scope))` + `state.microRestoreGeneration` | manifest revision, restore generation | (revision, epoch) changeset. 목표는 **owner가 증명한 exhaustive delta**이며 없으면 dirty/partial (§9.3) | V16, V18 |
| `hydrateOriginal(locators, frame, budget)` | 소유자에서 원본 hydration | 정본 reader(`libra.canonical_memory.v1` + artifact v4/v5), Micro(`libra.micro_memory.v1`·`…_head.v1`·receipt), State head, lore entry | locator, revision, scope | locator 기반, 소유자 경계 유지(GRADIA owner-corpus/selection receipt 조건 포함) | V04, V09 |
| `validateConsumedReadSet(privateHandle, frame)` | 최종 물리 검증 | A0/A1 final physical proof + exact raw identity(`buildPairs` 계열), private readset | owner frame·runtime instance·restore epoch·원본 revision/digest | 유지. **대체 불가** | V06, V09, V12 |
| `GraphStore.prepareGeneration(basis, delta, budget)` / `openView(frame)` | SourceGraph 생성·delta·restart 독립 검증·durable publication | 없음(신설). **maintenance 작업**이며 query는 발급된 verified generation만 읽음 (§7.7·§9.3) | — | owner partition, source from/to revision, projection/index policy, nonrewinding restore epoch, publication job token을 봉인 | V16, V18 |
| (view cursor) | QueryGraphView: 적격 node/edge page cursor | 없음(신설). 현재는 요청마다 스코프·viewer 조건을 recall 경로에서 재평가 | — | SourceGraph generation + QueryFrame에 결속된 **private issued handle**. page bytes는 공유 가능하나 적격성·lease·path state는 공유 불가 (§4.5) | V15, V18 |
| `CacheManager.reserve/pin/release/invalidate/inspect` | 바이트 예산·pin·축출 | 부분 존재(캐시·인덱스 상태), byte admission 미완 | — | resident/request/build 구분. 전체 source map·revision 검증 자료·queue/write barrier·staging 포함. **개수 제한(48 scope류)으로 상한 주장 금지** (§7.7) | V10, V17 |
| `QueryEngine.retrieve/scoreCandidate` · `EvidenceCompiler.*` | 단일 frontier·평가·선택·출력 | A0의 shortlist + BM25F/dense + RRF + gate (유지 중) | — | §6.2–§6.4 단일 frontier, 개선 시 재평가. BM25F·cosine·exact match는 **계산 primitive로만 재사용** | V01–V03, V13, V14 |

## B. 노드·관계 매핑 (§4.1, §4.4)

| 대상 | 현재 근거 | 매핑 메모 |
| --- | --- | --- |
| EntityNode | `UNIFIED_CLAIMS`의 `refType:'person'|'world'`, `character_*`·`location`·`containment`·`ownership`·`possession`·`placement` claim의 참조 | 별칭 해석의 중계점. **동명 자동 병합 금지** |
| MeaningNode | 정본 claim **24종**(v4; v5가 `character_preference`·`character_boundary` 추가 → 총 26종, 도메인 5개 character/event/world/relationship/narrative — 코드 실측), Micro claim(≤16/턴), source excerpt(첫 500자), State field·collection item, lore passage | 5턴 묶음 전체·로어 항목 전체를 유일 검색 노드로 쓰지 않음. claim 없는 excerpt에 새 주장을 만들지 않음 |
| SourceNode | 정본 record(`libra.canonical_memory.v1` + artifact v4/v5), Micro record/head/receipt, State head·correction basis(`libra.micro_state_basis.v1`·`libra.micro_state_field_evidence.v1`), lore entry/module(`libra.lore_link_index.v1`) | provenance·물리 locator·revision/coverage 보존 |
| **EdgeID (v1.1 신설)** | 현재는 typed 관계 구조 + exact tuple 비교(claim 충돌 거부) | **exact identity = 방향 있는 endpoints + predicate + qualified field/적용 조건 + 유효 시간 + basis identity + incarnation.** revision은 별도 binding으로 검증. 같은 두 노드 사이의 `mentions`·`evidenced_by`·`updates`는 **별개 엣지**(unordered endpoint pair를 중복 키로 쓰지 않음) |
| 역할(role) feature | canonical fact·Micro claim·State field·lore 구간의 actor/target attachment | 당사자/관찰자/언급/추정 역할 보존. **탐색 적합성 feature이며 물리 proof·사실 confidence 대체 불가.** WM의 1.0/0.62/0.25/0.08 계수는 기본값으로 채택하지 않음 |
| mentions / subject_of / target_of | typed actor/target attachment(`actor`, `target`, `refType`) | 대상 연결만. 동명 병합 금지 |
| evidenced_by / derived_from | 실제 source span, receipt, State field provenance·정정 basis | 연결만으로 현재성 인증 불가. 불완전 sourceRefs·턴 anchor는 partial/unknown lineage 유지 |
| updates / clears / supersedes | field effect(`effect:'remove'` 등)·revision/lifecycle 전이 | 해당 대상·필드·시간 범위에만 적용 |
| follows / fulfills / reopens | `libra.thread_link_target.v2`, thread claim | typed 의미 유지. `causal_followup`·`resolves_thread` 같은 **추정 label을 인과·lifecycle 엣지로 승격 금지** |
| defines / applies_to | lore 규칙·적용 조건(`libra.lore_link_mapping.v1`) | 설정을 발생 사건으로 승격하지 않음 |
| contradicts | 동일 qualified slot의 비교 가능 값·시점·확실성 | 우세 claim 자동 확정 금지 |
| semantic_affinity | **없음** — §8 SpaceBinding 도입 이후에만 성립 | identity·사실·인과를 인증하지 않음 |

## C. 식별자 계층 매핑 (§4.2)

| 새 식별자 | 현재 상태 | 조치 |
| --- | --- | --- |
| SourceObjectID | 소유자 증명 namespace/origin scope/incarnation이 부분적(native identity 없음) | revision-bound partial identity 유지. 새 identity를 만들어 내지 않음 |
| ClaimID | `claimKind` + typed actor/target/predicate/value/polarity/time + attachment (exact tuple 비교·충돌 거부 구현됨) | 결속 유지, 확장만 |
| **EdgeID** | 없음(typed 관계 + tuple 비교로 대체) | §4.4 exact identity 신설. basis identity·incarnation을 어느 심볼에서 얻을지 **확인 필요**(§G-5) |
| NodeID | **두 체계 병존**: B1 Micro postings는 network candidate ID, A2 정본 캐시는 physical `memoryKey` | UM1에서 통일 결정 필요 (F-1) |
| RepresentationID | 없음(부분적으로 source text hash·projection version만) | §8 SpaceBinding으로 신설 |
| EvidenceBinding | A1/A2가 owner frame·runtime instance·restore epoch·원본 revision/digest·active mapping을 결속 | 유지·확장 |

## D. 이중 실행 금지 · 상한 오용 금지

- **retire 후보**(§12.1 V11): catalog shortlist, block, ELI(`libra.evidence_link_index.v1`), LLI(`libra.lore_link_index.v1`), lore ranker(`libra.memory_lore_rerank.v1`·`libra.response_lore_rrf.v1`·`libra.response_lore_full_text_index.v1`), A0의 BM25F/dense scorer + ranked-list fusion + gate 경로.
- **금지**(§7.7): WM의 bucket 40·memory-pair local 8·retained node/edge/seed/candidate 상한을 LIBRA corpus 표현 범위나 **노드 degree 상한으로 옮기지 않음**. 구조 엣지(대상·출처·정정)에 페이지 접근 기회를 먼저 주고, 조밀한 연상 연결은 같은 공통 예산에서 처리. 축출된 entity/lore/오래된 기억도 durable index로 발견되어야 함.
- **금지**(§7.7): query 중 cache miss를 이유로 durable graph cold build/publication 금지. 요청 내 허용은 적격 source page에서의 **임시 투영**뿐.
- **금지**(§6.3): A1의 `pathBonus=0`을 전파 감쇠로 조용히 대체하지 않음.
- **금지**(§9.3): 저장된 checksum·source revision label만으로 원본 일치를 인증하지 않음(owner의 independent snapshot/change-set proof 필요, 없으면 dirty/partial).

## E. 첫 fixture 초안 (§12.1 V01 + §14 v1.1)

§14가 지정한 최소 구성(owner-adapter fixture, 합성·격리):

1. **정본** — 물건 수령 사건(`ownership`/`possession` claim) 1건 + source container. 완결 5턴 범위, artifact v4 계열.
2. **Micro** — 같은 원문 turn의 **양도** claim + exact quote, receipt revision 고정, analysis status 명시.
3. **State** — 현재 소유자 field 값 1개 + **correction basis** 1건. 대조로 명시적 clear 1건, unknown provenance 1건(필드 누락 ≠ 삭제).
4. **lore** — 물건의 **사용 규칙** 항목 1건(`alwaysActive`) + `hostSelected` 항목 1건, passage offset 고정.
5. **공통 연결** — 위 네 자료를 **공통 인물·물건·출처** 노드로 연결.
6. **부속 시나리오**(v1.1 추가) — 같은 pair의 **서로 다른 관계**(예: 같은 인물–물건 쌍에서 `ownership`과 `evidenced_by`), **뒤늦은 강한 경로**, **보호된 중간 노드**, **resident에서 축출된 과거 자료**.
7. **질의** — 네 자료를 모두 필요로 하는 질의 1개 + 한 자료만 필요한 대조 2개.

source coverage 체크리스트(각 자료): revision/digest, 읽은 span·offset, coverage 상태, 미충족 의존성, 미실행 항목.

판정: (a) 네 자료가 **같은 frontier**에서 발견, (b) 각 결과에 정확한 provenance, (c) unknown/clear/last-known 구분, (d) 최종 dispatch에서 물리 proof 검증, (e) 부적격·보호 자료가 seed·중간 경유에서 제외, (f) 실행 못 한 범위를 PASS로 적지 않음.

연결할 시나리오: **V01**(네 자료 단일 요청), **V13**(재평가·설명 일치), **V14**(같은 pair 다중 관계 보존), **V15**(보호 중간 노드 제외), **V17**(축출된 저빈도 자료 발견).

## F. 구현 전에 기록해야 할 결정

1. **NodeID 통일 방향** — network candidate ID와 physical `memoryKey` 중 무엇을 durable key로 두고 무엇을 binding으로 둘지(현재 두 체계 공존).
2. **EdgeID의 basis identity / incarnation 출처** — 현재 심볼에서 무엇을 basis로 삼고 incarnation을 어떻게 계산할지(§4.4).
3. **byte admission 범위** — §7.7이 요구하는 항목(전체 source map, revision 검증 자료, queue·write barrier·staging)을 어떤 counter로 계상하고 어떤 축출 정책으로 연결할지.
4. **maintenance / query 경계 구현 위치** — SourceGraph build·delta·restart 검증·publication을 어느 경로(유지보수 루틴 vs 서버 작업)로 옮길지. 현재 조회 중 파생 쓰기가 있는지 **확인 필요**(§G-8).
5. **역의존성 인덱스 범위** — body·alias·relation·State correction·lore activation 변화에서 영향을 받는 node/edge/posting/statistics 열거를 어느 심볼 기준으로 만들지(§9.3).
6. **역할(role) 가중치·전파 감쇠·정지 tolerance** — 고정 평가 세트 ablation으로 정함(§12.2). WM 수치 이식 금지.
7. **SpaceBinding 최소 필드 집합과 무효화 시점** — §8 튜플 중 1차 범위, restore/import 포함.
8. **lore 활성 조건의 소비자 정책 위치** — 필수 inclusion 조건을 어느 소비자 adapter가 소유하는지.
9. **fixture 배치·명명** — `tests/libra_*` 관례, 실제 registered hook과 합성 fixture의 구분 표기.
10. **retire·shadow 순서** — 동일 snapshot 고정 하에 UM5/UM6에서 기존 경로 실행을 끊는 시점(§13).

## G. 확인 필요 (이번 초안에서 단정하지 않은 것)

1. LLI 레코드가 passage offset·우선순위·적용 범위를 어떤 필드명으로 보관하는지.
2. State의 `disposition`/`pending`/`lastKnown`/`unknown`이 필드 단위로 어떻게 구분 저장되는지(필드 단위 provenance 서술은 소스 주석에서 확인, 정확한 필드명은 미확인).
3. `alwaysActive`·`hostSelected`/`host_selected`의 판정 위치(소비자 정책 vs lore 데이터).
4. Micro receipt revision ↔ 정본 revision 대응이 코드에서 어디까지 강제되는지.
5. **EdgeID**에 넣을 basis identity·incarnation 후보 심볼.
6. State correction·alias·relation 변화 신호를 현재 코드에서 어디서 관측 가능한지(§9.3 역의존성 열거의 입력).
7. 정본/Micro/State/lore별 **source inventory**를 지금 무엇으로 계산할 수 있는지(§9.3 검증의 전제).
8. 현재 recall 경로에 **조회 중 파생 쓰기**(cache-derived publication)가 실제로 있는지 — 있으면 §7.7에 따라 유지보수 경로로 분리 대상.
