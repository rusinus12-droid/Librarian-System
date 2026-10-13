# LIBRA UM0/UM1 대응표 초안 — 현재 reader schema → 새 adapter 표

- 지위: **초안. 제안이며 승인 아님.** 설계 문서 v1.1 §14가 요구한 UM0/UM1 대응 작업의 기록입니다.
- 기준: 설계 문서 **v1.1**(2026-10-14) §3~§9·§11~§14, `WM_HME_ASSOCIATIVE_GRAPH_REVIEW_20261014.md`, 플러그인 코드 `9f64f43`(이후 문서 커밋에서 코드 변경 없음).
- 개정: v3에서 §G의 "확인 필요" 8건을 코드에서 실제로 확인해 결과로 바꾸고, 확인된 심볼을 A·B·F에 반영했습니다. 남은 미확인 항목은 §G 끝에 남겼습니다.
- 표기: 심볼은 `plugins/LIBRA.js` 기준이며 줄 번호는 drift할 수 있어 참고용입니다(≈).

## A. 자료 adapter · 그래프 계층 대응표 (§4.5, §5, §7.7, §11)

| 새 인터페이스 (§11) | 대상 의미 | 현재 구현·스키마 (확인) | 변환(투영) 규칙 | 검증 시나리오 |
| --- | --- | --- | --- | --- |
| `describeCoverage(frame)` | 정본·Micro·State·lore 각각의 coverage + source inventory | Micro `libra.micro_network_access.v1`(`coverage`·`identityCoverage`·`rejectedIds`·`ineligibleCandidates`·`policy`·`representation`); 정본 reader `libra.canonical_reader_page.v1`·`…_chapter.v1`; State `head.domainStatus` + `libra.state_observation.v2`; lore는 LLI `status`(entryCount/linkCount/ambiguousCount/allowedLoreCount)와 `basis` | `complete/partial/pending/blocked` + 사유 + 미충족 의존성. **per-source inventory는 이미 존재**(§G-7) → 그 revision id를 coverage 근거로 사용 | V05, V12, V16 |
| `readProjectionPage(cursor, frame, budget)` | MeaningNode 페이지 | A2 `createPagedIndex`(owner-bound token/entity/predicate/time postings, reverse source dependency, exact metadata tuple, packed vector page) — `pageSize=256`, canonical은 physical `memoryKey` | NodeID 기준 페이지 + `representationRefs`; 페이지 넘침은 split/continuation(§7.7) | V10, V13, V17 |
| `readChangeSet(fromRevision, frame)` | 증분 변경분 | `refreshMemoryNetworkIndex` + `manifestRevisionOf(key.manifest(scope))` + `state.microRestoreGeneration`; **부분적 변경 신호 배관 존재**(§G-6) | (revision, epoch) changeset. 목표는 owner가 증명한 exhaustive delta이며 없으면 dirty/partial(§9.3) | V16, V18 |
| `hydrateOriginal(locators, frame, budget)` | 소유자에서 원본 hydration | 정본 reader(`libra.canonical_memory.v1` + artifact v4/v5), Micro(`libra.micro_memory.v1`·`…_head.v1`·receipt), State(`libra.continuity_state.v2`), lore(LLI entry + passage locator) | locator 기반, 소유자 경계 유지. LLI는 **본문을 복사하지 않고**(`bodiesCopied:false`) passage excerpt를 locator에 둠 | V04, V09 |
| `validateConsumedReadSet(privateHandle, frame)` | 최종 물리 검증 | A0/A1 final physical proof + exact raw identity(`buildPairs` 계열), private readset | 유지. **대체 불가** | V06, V09, V12 |
| `GraphStore.prepareGeneration` / `openView(frame)` | SourceGraph 생성·delta·restart 검증·durable publication | 없음(신설). **maintenance 작업**이며 query는 발급된 verified generation만 읽음(§7.7·§9.3) | owner partition, source from/to revision, projection/index policy, nonrewinding restore epoch(`microRestoreGeneration` 계열), publication job token 봉인 | V16, V18 |
| (view cursor) | QueryGraphView: 적격 node/edge page cursor | 없음(신설). 현재는 요청마다 scope·viewer 조건을 recall 경로에서 재평가 | SourceGraph generation + QueryFrame에 결속된 **private issued handle**. page bytes만 공유 가능 | V15, V18 |
| `CacheManager.reserve/pin/release/invalidate/inspect` | 바이트 예산·pin·축출 | 부분 존재. 현재 캐시는 scope 개수 상한(예: `PAIR_REVISION_CACHE_MAX_SCOPES`) | resident/request/build 구분, 전체 source map·revision 검증 자료·queue/write barrier·staging 포함. **개수 상한으로 바이트 상한 주장 금지**(§7.7) | V10, V17 |
| `QueryEngine.retrieve/scoreCandidate` · `EvidenceCompiler.*` | 단일 frontier·평가·선택·출력 | A0의 shortlist + BM25F/dense + RRF + gate, 그리고 lore용 별도 경로(`referenceAuthorityWeight`, `libra.response_lore_rrf.v1`, `libra.memory_lore_rerank.v1`) | §6.2–§6.4 단일 frontier, 개선 시 재평가. BM25F·cosine·exact match는 계산 primitive로만 재사용 | V01–V03, V13, V14 |

## B. 노드·관계 매핑 (§4.1, §4.4)

| 대상 | 현재 근거 (확인) | 매핑 메모 |
| --- | --- | --- |
| EntityNode | `UNIFIED_CLAIMS`의 `refType:'person'|'world'` 및 `character_*`·`location`·`containment`·`ownership`·`possession`·`placement` 참조; LLI `entities[]`(`id/name/kind/type/normalized`) | 별칭 해석의 중계점. **동명 자동 병합 금지** |
| MeaningNode | 정본 claim **24종**(v4; v5가 `character_preference`·`character_boundary` 추가 → 총 26종, 도메인 5개 — 코드 실측); Micro claim(≤16/턴); source excerpt(첫 500자); State field/collection(§G-2); lore **LLI entry + passage**(§G-1) | 5턴 묶음·로어 항목 전체를 유일 검색 노드로 쓰지 않음. claim 없는 excerpt에 새 주장 생성 금지 |
| SourceNode | 정본 record(`libra.canonical_memory.v1`), Micro record/head/receipt, State head·fieldEvidence, lore entry(`identity`·`moduleKey`·`source`·`renderedHash`·`rawHash`·`renderedChars`) | provenance·물리 locator·revision/coverage 보존. LLI는 passage locator에 excerpt를 둠 |
| **EdgeID (v1.1)** | 현재는 typed 관계 구조 + exact tuple 비교(claim 충돌 거부). **incarnation 후보 확보**: `sourceAtoms=['ownerNamespace','originScope','objectUUID','birthIncarnation']`(≈44242) | exact identity = 방향 endpoints + predicate + qualified field/조건 + 유효 시간 + basis identity + **incarnation**. revision은 별도 binding. 같은 pair의 다른 predicate은 별개 엣지 |
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
| SourceObjectID | `sourceAtoms = ownerNamespace·originScope·objectUUID·birthIncarnation`(≈44242). 메시지 번호·producer tempFactId는 incarnation을 세울 수 없음(코드 주석) | 그 4원자를 그대로 사용. revision-bound partial identity도 유지 |
| ClaimID | `claimKind` + typed actor/target/predicate/value/polarity/time + attachment, exact tuple 비교·충돌 거부 | 결속 유지 |
| **EdgeID** | 없음. incarnation 후보는 `birthIncarnation`, epoch 후보는 `microRestoreGeneration` | §4.4 신설. basis identity는 F-2에서 결정 |
| NodeID | **두 체계 병존**: B1 Micro postings는 network candidate ID, A2 정본 캐시는 physical `memoryKey` | UM1에서 통일 결정 필요 (F-1) |
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
2. **Micro** — 같은 turn의 **양도** claim + exact quote, `receiptRevisionId` 고정, `analysisStatus` 명시.
3. **State** — 현재 소유자 field 값 1건 + `fieldEvidence`/correction basis 1건. 대조: 명시적 clear 1건, evidence 없는 field(unknown provenance) 1건.
4. **lore** — 물건 **사용 규칙** LLI entry 1건(`alwaysActive`) + `hostSelected` 1건, passage locator·offset 고정.
5. **공통 연결** — 네 자료를 공통 인물·물건·출처 노드로 연결.
6. **부속 시나리오**(v1.1) — 같은 pair의 서로 다른 관계, 뒤늦은 강한 경로, 보호된 중간 노드, resident에서 축출된 과거 자료.
7. **질의** — 네 자료를 모두 필요로 하는 질의 1개 + 한 자료만 필요한 대조 2개.

판정: (a) 같은 frontier에서 네 자료 발견, (b) 정확한 provenance, (c) unknown/clear/last-known 구분, (d) 최종 dispatch 물리 proof 검증, (e) 부적격·보호 자료가 seed·중간 경유에서 제외, (f) 미실행 범위를 PASS로 적지 않음.

연결 시나리오: V01, V13, V14, V15, V17.

## F. 구현 전에 기록해야 할 결정

1. **NodeID 통일 방향** — network candidate ID와 physical `memoryKey` 중 durable key와 binding을 각각 무엇으로 둘지.
2. **EdgeID의 basis identity** — claim/field evidence·Micro receipt·LLI `linkKey`/`identity` 중 어느 것을 basis로 삼을지(incarnation은 `birthIncarnation` 사용 가능, §G-5).
3. **byte admission 계상 범위** — 전체 source map·revision 검증 자료·queue/write barrier·staging을 어떤 counter로 계상하고 어떤 축출 정책에 연결할지.
4. **maintenance / query 경계** — SourceGraph build·delta·restart 검증·publication을 어느 경로로 옮길지. 현재 `persistRecallCatalog`·`saveManifest` 경로를 유지보수로 이동하는 범위(§G-8).
5. **역의존성 인덱스 통합** — 현재 subsystem별 무효화(`invalidate*`·`manifestRevisionOf`·LLI upgrade·deep audit)를 어떤 단일 열거로 합칠지(§G-6).
6. **역할 가중치·전파 감쇠·정지 tolerance** — 고정 평가 세트 ablation으로 결정. WM 수치 이식 금지.
7. **lore 활성 조건의 소비자 정책 표현** — 현재 `alwaysActive`(force)와 `referenceAuthorityWeight`의 `lore_host_selected:1.50`(bonus)가 병존. §5.3대로 **필수 inclusion 조건**으로 옮기고 bonus 모사를 제거하는 범위(§G-3).
8. **SpaceBinding 최소 필드 집합과 무효화 시점** — §8 튜플 중 1차 범위, restore/import 포함.
9. **fixture 배치·명명** — `tests/libra_*` 관례, 실제 registered hook과 합성 fixture 구분 표기.
10. **retire·shadow 순서** — 동일 snapshot 고정 하에 UM5/UM6에서 기존 경로 실행을 끊는 시점(§13).

## G. 코드 확인 결과 (v3에서 채운 항목)

| # | 질문 | 확인 결과 |
| --- | --- | --- |
| 1 | LLI 레코드가 passage offset·우선순위·적용 범위를 어떻게 보관하나 | index = `schema`·`buildVersion`(`shared_person_boundary_v2`)·`scopeKey`·`status`(entryCount/linkCount/ambiguousCount/entityNameCount/allowedLoreCount/buildMs/builtAt/removals/confirmations)·`basis`(registryFingerprint/loreSelectionDigest/loreSettingsScope/mappingsDigest)·`entities[]`·`entries[]`·`links[]`·`ambiguous[]`·`bodiesCopied:false`. entry = `identity`·`label`·`sourceType`·`moduleKey`·`source`·`renderedHash`·`rawHash`·`renderedChars`·`passages[]`; passage = locator + `entityCount`·`linked`·`reason:'passage_entity_limit'`·`mentions[](entityId,name,ambiguous,confirmed,offsets≤8)`; links는 entity별 `passageCount`·`firstStart`. 상한: ENTRY 512·LINK 4096·PASSAGE_ENTITY 12·MIN_NAME 2자. **priority/position은 LLI가 아니라 host lore 선택 entry(`priority`·`position`·`mode`·`alwaysActive`·`activationKey`)에 있음** |
| 2 | State의 current/last-known/clear/unknown 구분 | 단일 enum이 아니라 **조합**: `libra.continuity_state.v2`(characters/relationships/world) + `normalizeContinuityFieldEvidence`의 `fieldEvidence` + `continuityStateCertainty` + `head.domainStatus`(`inferDomainStatus`, `normalizeContinuityDomainStatus`의 attemptedEvidence/evidence/sessionEpoch/throughTurn) + `disposition`(예: `pending_reconciliation`). 필드 누락 시 fieldEvidence 항목을 삭제(≈35829) — "누락 ≠ 삭제" 구현 |
| 3 | alwaysActive / hostSelected 판정 위치 | 데이터 측 로드 시 별칭 다중 인정(≈19291: alwaysActive·always_active·constant·forceActivation·force_activation 등). 명시 활성 경로 존재(≈19734 `effectiveForceState==='activate' || alwaysActive`). host 선택은 `reuseRisuSelectedLorebooks(...).activeLore`(≈21904). **다만 `referenceAuthorityWeight`에 `lore_host_selected:1.50`·`author_note:1.75`·`lore_direct:1.48` 등 relevance 가중치가 병존** → §5.3의 "bonus로 모사하지 않음"은 아직 충족 안 됨(F-7) |
| 4 | Micro receipt revision ↔ 정본 revision 강제 범위 | key 파생에 `receiptRevisionId`(+`analysisRevisionId`) 포함(`microWork`·`microMemory`·`microStateAdmission`·`personSpanInventory`); `sourceInventoryHead.receiptRevisionId !== source.receipt.revisionId`면 거부(≈40745); `analysisStatus`는 `verified`/`minimum_source_bound` 분기 처리 |
| 5 | EdgeID basis identity·incarnation 후보 | incarnation = `birthIncarnation`(sourceAtoms 4원자, ≈44242). epoch = `microRestoreGeneration`. "메시지 번호·tempFactId는 incarnation을 세울 수 없다"는 코드 주석 존재 |
| 6 | 변경 신호 관측 지점 | `manifestRevisionOf`(11곳)·`invalidate`/`invalidated`/`invalidateDependencies`·`deepAuditDue`/`deepAuditScheduled`·LLI `upgradeInFlight`(+30s 지연)·`PAIR_REVISION_CACHE_MAX_SCOPES`. **subsystem별로 흩어져 있음** → 통합 역의존성 열거 필요 |
| 7 | source inventory를 지금 계산할 수 있나 | 가능. `inventoryRevisionId`(58곳)·`personInventory`·`personSpanInventory`·`sourceInventory`/`consumerSourceInventory`·`wholeDataInventoryEpoch`·`inventoryFingerprint`·`inventoryStatus`·`collectGlobalInventory`·`sourceInventoryHead` |
| 8 | 조회 중 파생 쓰기가 실제로 있나 | **있음.** `persistRecallCatalog`가 read-only가 아니면 기본 true(≈60904)이고 `loadOrRefreshRecallCatalog(..., {persist})`(≈61022)로 조회 중 파생 catalog를 저장. `saveManifest`(38곳)는 stale revision 기반 게시를 거부하는 가드를 갖지만, A2 경계 시험은 정상 hook 진행 중 실제 검증된 publication을 관측 → §7.7에 따라 유지보수 경로로 분리 대상 |

**아직 미확인으로 남긴 것**: (a) LLI `loreLinkPassageLocator`의 정확한 필드명(start/end/passage id), (b) `inferDomainStatus`가 실제로 만들어내는 값 집합, (c) `saveManifest` 게시 중 어느 호출이 정상 요청 경로에서 실제로 발생하는지의 전수 목록(§G-8의 후속), (d) `analysisStatus`별로 어떤 표현 제한이 적용되는지의 상세.
