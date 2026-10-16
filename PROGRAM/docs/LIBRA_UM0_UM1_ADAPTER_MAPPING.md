# LIBRA UM0/UM1 대응표 — 현재 reader schema → 새 adapter 표

- 지위: **F-1/F-2 identity 커널과 실제 네 자료 owner reader의 요청 내 read-only 투영 구현. 나머지 결정·통합 검색/GraphStore/dispatch는 미완료.** [identity 계약](LIBRA_UM1_GRAPH_IDENTITY_CONTRACT.md)과 [reader adapter 계약](LIBRA_UM1_READER_ADAPTER_CONTRACT.md)을 따른다.
- 기준: 설계 문서 **v1.5**(2026-10-14) §3~§9·§11~§14, `WM_HME_ASSOCIATIVE_GRAPH_REVIEW_20261014.md`. §G의 최초 코드 조사 기준은 `9f64f43`; identity `654803d`·실제 reader `611ec1e`·page/cache `ba6a25f` 후 [durable window/generation](LIBRA_UM2_DURABLE_GRAPH_CONTRACT.md)을 연결했다.
- 개정: v3에서 §G의 1차 8건을 코드에서 확인했고, v4에서 남아 있던 4건(passage locator 필드, domainStatus 값 집합, 요청 경로의 saveManifest 호출, analysisStatus별 표현 제한)까지 확정했습니다. §G 표에 12행 전부 기록했습니다.
- 후속: 설계 v1.2의 F-1/F-2·[14개 identity 검증](../tests/libra_memory_graph_identity_test.cjs)에 v1.3의 [11개 reader schema 검증](../tests/libra_memory_graph_reader_contract_test.cjs)·[등록 owner API 검증](../tests/libra_memory_graph_reader_runtime_test.cjs)을 추가했다. plugin_only/server_only 합성 호스트에서 실제 reader/writer를 실행했다. 통합 검색의 actual host·최종 dispatch physical proof 검증은 아직 실행하지 않았다.
- 표기: 심볼은 `plugins/LIBRA.js` 기준이며 줄 번호는 drift할 수 있어 참고용입니다(≈).

## A. 자료 adapter · 그래프 계층 대응표 (§4.5, §5, §7.7, §11)

| 새 인터페이스 (§11) | 대상 의미 | 현재 구현·스키마 (확인) | 변환(투영) 규칙 | 검증 시나리오 |
| --- | --- | --- | --- | --- |
| `describeCoverage(frame)` | 정본·Micro·State·lore 각각의 coverage + source inventory | Micro `libra.micro_network_access.v1`(`coverage`·`identityCoverage`·`rejectedIds`·`ineligibleCandidates`·`policy`·`representation`); 정본 reader `libra.canonical_reader_page.v1`·`…_chapter.v1`; State `head.domainStatus` + `libra.state_observation.v2`; lore는 LLI `status`(entryCount/linkCount/ambiguousCount/allowedLoreCount)와 `basis` | `complete/partial/pending/blocked` + 사유 + 미충족 의존성. 기존 subsystem inventory/revision은 해당 범위의 근거이며 전체 owner inventory·exhaustive delta의 증명은 별도 필요 | V05, V12, V16 |
| `readProjectionPage(cursor, frame, budget)` | MeaningNode 페이지 | A2 `createPagedIndex`(owner-bound token/entity/predicate/time postings, reverse source dependency, exact metadata tuple, packed vector page) — `pageSize=256`, canonical은 physical `memoryKey` | NodeID 기준 페이지 + `representationRefs`; 페이지 넘침은 split/continuation(§7.7) | V10, V13, V17 |
| `readChangeSet(fromRevision, frame)` | 증분 변경분 | `refreshMemoryNetworkIndex` + `manifestRevisionOf(key.manifest(scope))` + `state.microRestoreGeneration`; **부분적 변경 신호 배관 존재**(§G-6) | (revision, epoch) changeset. 목표는 owner가 증명한 exhaustive delta이며 없으면 dirty/partial(§9.3) | V16, V18 |
| `hydrateOriginal(locators, frame, budget)` | 소유자에서 원본 hydration | 정본 reader(`libra.canonical_memory.v1` + artifact v4/v5), Micro(`libra.micro_memory.v1`·`…_head.v1`·receipt), State(`libra.continuity_state.v2`), lore(LLI entry + passage locator) | locator 기반, 소유자 경계 유지. LLI는 **본문을 복사하지 않고**(`bodiesCopied:false`) passage excerpt를 locator에 둠 | V04, V09 |
| `validateConsumedReadSet(privateHandle, frame)` | 최종 물리 검증 | A0/A1 final physical proof + exact raw identity(`buildPairs` 계열), private readset | 유지. **대체 불가** | V06, V09, V12 |
| `GraphStore.prepareGeneration` / `openView(frame)` | SourceGraph 생성·delta·restart 검증·durable publication | 없음(신설). **maintenance 작업**이며 query는 발급된 verified generation만 읽음(§7.7·§9.3) | owner partition, source from/to revision, projection/index policy, nonrewinding restore epoch(`microRestoreGeneration` 계열), publication job token 봉인 | V16, V18 |
| (view cursor) | QueryGraphView: 적격 node/edge page cursor | 없음(신설). 현재는 요청마다 scope·viewer 조건을 recall 경로에서 재평가 | SourceGraph generation + QueryFrame에 결속된 **private issued handle**. page bytes만 공유 가능 | V15, V18 |
| `CacheManager.reserve/pin/release/invalidate/inspect` | 바이트 예산·pin·축출 | 부분 존재. 현재 캐시는 scope 개수 상한(예: `PAIR_REVISION_CACHE_MAX_SCOPES`) | resident/request/build 구분, 전체 source map·revision 검증 자료·queue/write barrier·staging 포함. **개수 상한으로 바이트 상한 주장 금지**(§7.7) | V10, V17 |
| `QueryEngine.retrieve/scoreCandidate` · `EvidenceCompiler.*` | 단일 frontier·평가·선택·출력 | A0의 shortlist + BM25F/dense + RRF + gate, 그리고 lore용 별도 경로(`referenceAuthorityWeight`, `libra.response_lore_rrf.v1`, `libra.memory_lore_rerank.v1`) | §6.2–§6.4 단일 frontier, 개선 시 재평가. BM25F·cosine·exact match는 계산 primitive로만 재사용 | V01–V03, V13, V14 |

## B. 노드·관계 매핑 (§4.1, §4.4)

§A의 다섯 SourceAdapter 메서드는 목표 인터페이스다. 현재 구현은 `getMemoryGraphProjectionPage`와 내부 순수 투영 facade이며 coverage·node/basis·보수적 derivation을 제공한다. `describeCoverage/enumerateChanged/project/readSource/validateConsumedReadSet` 전체 API나 exhaustive delta·최종 readset 인증을 구현했다고 해석하지 않는다.

| 대상 | 현재 근거 (확인) | 매핑 메모 |
| --- | --- | --- |
| EntityNode | `UNIFIED_CLAIMS`의 `refType:'person'|'world'` 및 `character_*`·`location`·`containment`·`ownership`·`possession`·`placement` 참조; LLI `entities[]`(`id/name/kind/type/normalized`) | 별칭 해석의 중계점. **동명 자동 병합 금지** |
| MeaningNode | 정본 claim **24종**(v4; v5가 `character_preference`·`character_boundary` 추가 → 총 26종, 도메인 5개 — 코드 실측); Micro claim(≤16/턴); source excerpt(첫 500자); State field/collection(§G-2); lore **LLI entry + passage**(§G-1) | 5턴 묶음·로어 항목 전체를 유일 검색 노드로 쓰지 않음. claim 없는 excerpt에 새 주장 생성 금지 |
| SourceNode | 정본 record(`libra.canonical_memory.v1`), Micro record/head/receipt, State head·fieldEvidence, lore entry(`identity`·`moduleKey`·`source`·`renderedHash`·`rawHash`·`renderedChars`) | provenance·물리 locator·revision/coverage 보존. LLI는 passage locator에 excerpt를 둠 |
| **EdgeID** | runtime은 typed 관계 + exact tuple 비교. 새 normalized 커널의 directed multi-edge identity 구현 | `libra.edge.v1` + exact endpoints/predicate/qualifier/time/basis. occurrence incarnation이 증명되지 않으면 revision-bound. 같은 pair의 다른 predicate은 별개 엣지 |
| 역할(role) feature | canonical fact·Micro claim·State field·lore의 actor/target attachment; lore 측은 `activationRoute`·`alwaysActive`·`hostSelected` | 탐색 적합성 feature이며 물리 proof·사실 confidence 대체 불가. WM 계수(1.0/0.62/0.25/0.08)는 기본값 채택 안 함 |
| mentions / subject_of / target_of | typed actor/target attachment(`actor`·`target`·`refType`); LLI `passages[].mentions[]`(`entityId`·`name`·`ambiguous`·`confirmed` + offsets, 이름당 최대 8) | 대상 연결만. 동명 병합 금지. ambiguity는 `ambiguous[]`와 confirmations로 별도 보존 |
| evidenced_by / derived_from | source span·receipt·State `fieldEvidence`·정정 basis; LLI `passageCount`·`firstStart`·`renderedHash`/`rawHash` | 연결만으로 현재성 인증 불가. partial/unknown lineage 유지 |
| updates / clears / supersedes | field effect(`effect:'remove'`)·revision/lifecycle 전이; State `disposition`(예: `pending_reconciliation`) | 대상·필드·시간 범위 한정 |
| follows / fulfills / reopens | `libra.thread_link_target.v2`, thread claim | typed 의미 유지. `causal_followup`·`resolves_thread` 같은 추정 label의 인과 승격 금지 |
| defines / applies_to | lore 규칙·적용 조건(`libra.lore_link_mapping.v1`); LLI `sourceType`·`moduleKey`·`label` | 설정을 발생 사건으로 승격하지 않음 |
| contradicts | 동일 qualified slot의 비교 가능 값·시점·확실성; State `certainty`(`continuityStateCertainty`) | 우세 claim 자동 확정 금지 |
| semantic_affinity | **없음** — §8 SpaceBinding 도입 이후 성립 | identity·사실·인과를 인증하지 않음 |

## C. 식별자 계층 매핑 (§4.2)

| 새 식별자 | 현재 상태 (확인) | 조치 |
| --- | --- | --- |
| SourceObjectID | `sourceAtoms = ownerNamespace·originScope·objectUUID·birthIncarnation` 입력 인터페이스가 존재(≈44242). 이 선언만으로 실제 reader의 native birth가 증명되지는 않음 | owner가 4원자를 증명한 경우만 stable. 현재 fixture/legacy는 revision-bound exact snapshot |
| ClaimID | `claimKind` + typed actor/target/predicate/value/polarity/time + attachment, exact tuple 비교·충돌 거부 | 결속 유지 |
| **EdgeID** | production 경로에는 없음. normalized 커널에서 `libra.edge.v1` 구현 | F-2 결정: source + exact qualified occurrence/anchor. birth 없으면 revision-bound. epoch를 birth로 사용하지 않음 |
| NodeID | production에는 B1 network candidate ID와 A2 physical `memoryKey` 병존. normalized 커널의 공통 namespace 구현 | F-1 결정: `libra.node.v1`의 source/entity/meaning 층. 기존 ID·키는 locator/migration alias로 유지 |
| RepresentationID | 없음(부분적으로 source text hash·projection version·LLI `renderedHash`/`rawHash`) | §8 SpaceBinding으로 신설 |
| EvidenceBinding | A1/A2가 owner frame·runtime instance·restore epoch(`microRestoreGeneration`)·원본 revision/digest·active mapping을 결속 | 유지·확장 |

## D. 이중 실행 금지 · 상한 오용 금지

- **retire 후보**(§12.1 V11): catalog shortlist, block, ELI(`libra.evidence_link_index.v1`), LLI(`libra.lore_link_index.v1`), lore ranker(`libra.memory_lore_rerank.v1`·`libra.response_lore_rrf.v1`·`libra.response_lore_full_text_index.v1`), A0의 BM25F/dense + RRF + gate.
- **금지**(§7.7): WM bucket 40·memory-pair local 8·retained node/edge/seed/candidate 상한을 corpus 표현 범위나 노드 degree 상한으로 옮기지 않음. 구조 엣지에 페이지 기회 우선, 연상 연결은 같은 예산. 축출된 자료도 durable index로 발견.
- **금지**(§7.7): query 중 cache miss를 이유로 durable graph cold build/publication 금지. 요청 내 허용은 적격 source page의 임시 투영뿐. → **현재 위반 상태 확인**(§G-8).
- **금지**(§6.3): A1의 `pathBonus=0`을 전파 감쇠로 조용히 대체하지 않음.
- **금지**(§9.3): 저장 checksum·source revision label만으로 원본 일치 인증 금지.

## E. 첫 fixture 초안 (§12.1 V01 + §14 v1.1)

1. **정본** — 물건 수령 사건(`ownership`/`possession`) 1건 + source container(완결 5턴, artifact v4 계열).
2. **Micro** — 완결 정본 5턴 뒤 turn 6의 **임시 양도** claim + exact quote, source/analysis revision 고정, `analysisStatus` 명시. ownership과 possession을 구분.
3. **State** — 현재 소유자 field 값 1건 + `fieldEvidence`/correction basis 1건. 대조: 명시적 clear 1건, evidence 없는 field(unknown provenance) 1건.
4. **lore** — 물건 **사용 규칙** LLI entry 1건(`alwaysActive`) + `hostSelected` 1건, passage locator·offset 고정.
5. **공통 연결** — 네 자료를 공통 인물·물건·출처 노드로 연결.
6. **부속 시나리오**(v1.1) — 같은 pair의 서로 다른 관계, 뒤늦은 강한 경로, 보호된 중간 노드, resident에서 축출된 과거 자료.
7. **질의** — 네 자료를 모두 필요로 하는 질의 1개 + 한 자료만 필요한 대조 2개.

판정: (a) 같은 frontier에서 네 자료 발견, (b) 정확한 provenance, (c) unknown/clear/last-known 구분, (d) 최종 dispatch 물리 proof 검증, (e) 부적격·보호 자료가 seed·중간 경유에서 제외, (f) 미실행 범위를 PASS로 적지 않음.

연결 시나리오: V01, V13, V14, V15, V17.

최초 [normalized fixture](../tests/fixtures/libra_memory_graph_identity_fixture.cjs)는 13개 node·19개 edge의 투영·identity 연결을 검증한다. 추가 [owner reader fixture](../tests/fixtures/libra_memory_graph_reader_fixture.cjs)는 실제 writer/producer로 자료를 생성하고 shipped API로 읽는다. plugin_only/server_only 각각 48개 node·81개 edge가 연결되며 State correction journal은 별도 source occurrence다. standalone reader에 host-selected 요청 정보가 없으면 lore의 `hostSelected:null`을 보존한다. 아직 단일 frontier 검색·전파·보호 경유·cache 축출·최종 dispatch proof는 실행하지 않았고, 이를 V01/V13/V15/V17 완료로 보고하지 않는다.

## F. 구현 전에 기록해야 할 결정

1. **NodeID 통일 방향 — 1차 결정·normalized 구현 완료.** 공통 `libra.node.v1` exact logical tuple을 사용하고, physical key·기존 candidate ID는 binding/alias로 유지. [계약 §1–§2](LIBRA_UM1_GRAPH_IDENTITY_CONTRACT.md)와 actual reader 연결 gate를 따름.
2. **EdgeID의 basis identity — 1차 결정·normalized 구현 완료.** source + qualified occurrence identity + exact anchor. canonical claim·Micro span·State evidence/correction·lore passage를 각각 보존. 증명된 birth가 없으면 revision-bound; LLI linkKey나 receipt revision/restore epoch를 birth로 승격하지 않음.
3. **byte admission — 첫 파생 page/cache 범위 구현.** payload/exact binding·request/view/decode lease·serialization/hash/validation staging을 공통 예산과 partition quota·pin/LRU에 계상한다. [UM2 계약](LIBRA_UM2_PAGE_CACHE_CONTRACT.md) 참조. 전체 source map·L0/frontier·revision readset·I/O/coalescing·queue/write barrier 계상은 남아 있으며 전체 heap bounded를 주장하지 않는다.
4. **maintenance / query — window 단위 durable 게시·검증 연결.** 명시적 maintenance API에서만 불변 pages/manifest와 root-last/서버 CAS를 게시한다. query는 현재 source window를 재도출해 전체 stored pages를 검증하며 missing/stale/오염을 쓰기로 repair하지 않는다. [durable 계약](LIBRA_UM2_DURABLE_GRAPH_CONTRACT.md) 참조. exhaustive corpus/delta·reverse dependency·GC와 기존 `persistRecallCatalog`·`saveManifest`의 유지보수 이전은 남아 있다(§G-8).
5. **역의존성 인덱스 통합** — 현재 subsystem별 무효화(`invalidate*`·`manifestRevisionOf`·LLI upgrade·deep audit)를 어떤 단일 열거로 합칠지(§G-6).
6. **역할 가중치·전파 감쇠·정지 tolerance** — 고정 평가 세트 ablation으로 결정. WM 수치 이식 금지.
7. **lore 활성 조건의 소비자 정책 표현** — 현재 `alwaysActive`(force)와 `referenceAuthorityWeight`의 `lore_host_selected:1.50`(bonus)가 병존. §5.3대로 **필수 inclusion 조건**으로 옮기고 bonus 모사를 제거하는 범위(§G-3).
8. **SpaceBinding 최소 필드 집합과 무효화 시점** — §8 튜플 중 1차 범위, restore/import 포함.
9. **fixture 배치·명명 — normalized/실제 등록 API의 합성 fixture 구현.** `tests/fixtures/libra_memory_graph_identity_fixture.cjs`, `tests/libra_memory_graph_identity_test.cjs`; 추가 `tests/fixtures/libra_memory_graph_reader_fixture.cjs`, `tests/libra_memory_graph_reader_contract_test.cjs`, `tests/libra_memory_graph_reader_runtime_test.cjs`, `tests/libra_memory_graph_assembly_test.cjs`. actual-host qualification·최종 physical readset suite는 후속 단계이며 등록 API의 합성 호스트 검증과 구분.
10. **retire·shadow 순서** — 동일 snapshot 고정 하에 UM5/UM6에서 기존 경로 실행을 끊는 시점(§13).

## G. 코드 확인 결과 (v3에서 채운 항목)

| # | 질문 | 확인 결과 |
| --- | --- | --- |
| 1 | LLI 레코드가 passage offset·우선순위·적용 범위를 어떻게 보관하나 | index = `schema`·`buildVersion`(`shared_person_boundary_v2`)·`scopeKey`·`status`(entryCount/linkCount/ambiguousCount/entityNameCount/allowedLoreCount/buildMs/builtAt/removals/confirmations)·`basis`(registryFingerprint/loreSelectionDigest/loreSettingsScope/mappingsDigest)·`entities[]`·`entries[]`·`links[]`·`ambiguous[]`·`bodiesCopied:false`. entry = `identity`·`label`·`sourceType`·`moduleKey`·`source`·`renderedHash`·`rawHash`·`renderedChars`·`passages[]`; passage = locator + `entityCount`·`linked`·`reason:'passage_entity_limit'`·`mentions[](entityId,name,ambiguous,confirmed,offsets≤8)`; links는 entity별 `passageCount`·`firstStart`. 상한: ENTRY 512·LINK 4096·PASSAGE_ENTITY 12·MIN_NAME 2자. **priority/position은 LLI가 아니라 host lore 선택 entry(`priority`·`position`·`mode`·`alwaysActive`·`activationKey`)에 있음** |
| 2 | State의 current/last-known/clear/unknown 구분 | 단일 enum이 아니라 **조합**: `libra.continuity_state.v2`(characters/relationships/world) + `normalizeContinuityFieldEvidence`의 `fieldEvidence` + `continuityStateCertainty` + `head.domainStatus`(`inferDomainStatus`, `normalizeContinuityDomainStatus`의 attemptedEvidence/evidence/sessionEpoch/throughTurn) + `disposition`(예: `pending_reconciliation`). 필드 누락 시 fieldEvidence 항목을 삭제(≈35829) — "누락 ≠ 삭제" 구현 |
| 3 | alwaysActive / hostSelected 판정 위치 | 데이터 측 로드 시 별칭 다중 인정(≈19291: alwaysActive·always_active·constant·forceActivation·force_activation 등). 명시 활성 경로 존재(≈19734 `effectiveForceState==='activate' || alwaysActive`). host 선택은 `reuseRisuSelectedLorebooks(...).activeLore`(≈21904). **다만 `referenceAuthorityWeight`에 `lore_host_selected:1.50`·`author_note:1.75`·`lore_direct:1.48` 등 relevance 가중치가 병존** → §5.3의 "bonus로 모사하지 않음"은 아직 충족 안 됨(F-7) |
| 4 | Micro receipt revision ↔ 정본 revision 강제 범위 | key 파생에 `receiptRevisionId`(+`analysisRevisionId`) 포함(`microWork`·`microMemory`·`microStateAdmission`·`personSpanInventory`); `sourceInventoryHead.receiptRevisionId !== source.receipt.revisionId`면 거부(≈40745); `analysisStatus`는 `verified`/`minimum_source_bound` 분기 처리 |
| 5 | EdgeID basis identity·incarnation 후보 | sourceAtoms에 `birthIncarnation`을 받는 인터페이스가 있다(≈44242). 실제 native lifetime 발급 증명은 별도이고, 없으면 revision-bound. `microRestoreGeneration`은 epoch로만 사용. "메시지 번호·tempFactId는 incarnation을 세울 수 없다"는 코드 주석 존재 |
| 6 | 변경 신호 관측 지점 | `manifestRevisionOf`(11곳)·`invalidate`/`invalidated`/`invalidateDependencies`·`deepAuditDue`/`deepAuditScheduled`·LLI `upgradeInFlight`(+30s 지연)·`PAIR_REVISION_CACHE_MAX_SCOPES`. **subsystem별로 흩어져 있음** → 통합 역의존성 열거 필요 |
| 7 | source inventory를 지금 계산할 수 있나 | 가능. `inventoryRevisionId`(2026-10-14 재측정 44곳; 이후 커밋에서 수가 변동)·`personInventory`·`personSpanInventory`·`sourceInventory`/`consumerSourceInventory`·`wholeDataInventoryEpoch`·`inventoryFingerprint`·`inventoryStatus`·`collectGlobalInventory`·`sourceInventoryHead` |
| 8 | 조회 중 파생 쓰기가 실제로 있나 | **있음.** `persistRecallCatalog`가 read-only가 아니면 기본 true(≈60904)이고 `loadOrRefreshRecallCatalog(..., {persist})`(≈61022)로 조회 중 파생 catalog를 저장. `saveManifest`(호출 33곳, §G-11)는 stale revision 기반 게시를 거부하는 가드를 갖지만, A2 경계 시험은 정상 hook 진행 중 실제 검증된 publication을 관측 → §7.7에 따라 유지보수 경로로 분리 대상 |
| 9 | `loreLinkPassageLocator`의 정확한 필드명 | `{locatorVersion:lore_reference_locator.v1, coordinateSpace:rendered, renderedHash, rawHash:(빈 값), rawOffsetAvailable:false, start, end, heading, excerpt: compactMiddle(passage.text, 320), rawOffsetUnavailableReason:cbs_rendered_text_only}`(≈57484). offset은 **rendered 좌표계**이고 raw offset은 제공되지 않음. excerpt는 320자 |
| 10 | `inferDomainStatus`가 만드는 값 집합 | `normalizeContinuityDomainStatus`(≈35586) 반환 = `{status, source, sessionEpoch, throughTurn, reason, evidence, attemptedEvidence}`. `status`는 고정 enum이 아니라 **80자 이하 자유 문자열**이고 기본값은 `empty`. 상위 continuity state의 `status`만 `[ready, partial, empty]`로 제한(기본 `partial`), `narrativeStatusFallback`은 `ready`(≈35754). 같은 검색에서 보이는 `current`·`pending`·`missing`·`unavailable`은 **다른 schema의 status**이므로 domainStatus 값으로 단정하지 않음 |
| 11 | 정상 요청 경로에서 실제로 실행되는 `saveManifest` | 호출 지점 **33곳**의 감싸는 선언까지 확인. 요청 경로에서 도달하는 것은 **파생 벡터 flush 1곳**: `scheduleUnifiedDerivedVectors`(≈55247) → `setTimeout(...,0)` → `void flushUnifiedDerivedVectors(context)`(await하지 않음) → 내부 `await saveManifest(live.scope, manifest)`(≈55233, 실패 시 ref 롤백, 긍정 증거 `rowStatus===ready`일 때만 반영). 소스 주석(≈65830–65835)이 callee closure의 유일한 enqueue가 setTimeout(0)+void라고 명시. `reconcileCanonicalBranchBeforeRecall*`는 branch audit·`scan`·`eligibleStarts`에서 호출되고 저장은 조건부(`if (changed || branchGuardChanged)`, ≈43516). 나머지 31곳은 canonical job stage·portable import·migration·실패 정리 경로 |
| 12 | `analysisStatus`별 표현 제한 | `minimumSourceBoundMicro`(≈48798): `exactQuote = row.text.slice(0,500)`, `claims: []`, `authority: source_only`, `excerpt:{role, messageId, startOffset:0, endOffset:exactQuote.length, exactQuote}` → **500자 제한이 offset에 구조적으로 새겨짐**(endOffset=500). `projectMicro`(≈44306)는 `verified`/`minimum_source_bound` 외 status를 `TypeError(LIBRA_NETWORK_MICRO_ANALYSIS_STATUS)`로 거부하고, `verified`는 claims 사용과 span 정합(`exactQuote.length === endOffset - startOffset`)을 요구하며, `minimum_source_bound`는 `[record.excerpt]`만 사용해 projection `kind=source_only`·`authority=source_only`가 됨 |

**§G 조사 기록 유지.** F-1/F-2·F-9와 실제 owner reader·공통 page/cache의 첫 범위를 구현했다. F-3/F-4의 전체 inventory/maintenance 이전, F-5–F-8/F-10·단일 검색·최종 physical readset/dispatch 검증은 남아 있다. 기존 legacy query의 파생 쓰기는 유지보수 이전 대상이며 새 명시적 read-only API와 구분한다. 코드에 필드 이름이 존재하는 것과 원본 권위·coverage를 증명하는 것은 구분한다. 줄 번호는 개정 시 drift할 수 있으므로 심볼 이름으로 재확인하세요.
