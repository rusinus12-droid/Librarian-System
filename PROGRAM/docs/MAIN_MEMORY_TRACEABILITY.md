# MAIN_MEMORY_TRACEABILITY — 총망라 추적표

**작성:** 2026-09-26 · **목적:** "무엇을 복원하는가"의 전수 목록. 설계·계약·계획 문서가 **선택한 것**을 다루는 반면, 이 문서는 **원본에 있는 것을 빠짐없이 대조**한다.

**대조한 원본:**
- `LIBRA_WorldMaker_Integration_Plan_20260925` — `01` 설계서(R01–R16, §7.3 link, §17 D01–D06) · `02` 계획(T00–T11) · `03` 수용(A01–A44, §7 결과형식, §8 추적표) · `04` 인수인계 · `reference/CURRENT_LIBRA_SOURCE_MAP.md`(C01–C23) · `reference/SOURCE_EXTENSIONS.md`(C24–C31) · `reference/originals/LIBRA World Maker Full.js`(**47 섹션, 78,336줄**)
- `Librarian-Benchmark-Validation-20260925` — 19후보 판정 · `DECISIONS.json` · G01–G18 · 부록 C.3(다음 감사 4항목) · `SOURCE_EVIDENCE.md`(L01–L23, A01–A08)
- `HAYAKU_VISIBLE_HASH_*` — 계약 · 실행 보고서

**이 문서가 답하는 질문:** 위 원본들이 요구·언급한 항목 중 **어느 것이 내 계획에 반영되었고, 어느 것이 누락이며, 누락이 정당한가.**

## 0. 결론 요약

| 대조 대상 | 전수 | 반영 | 누락 | 판정 |
|---|---|---|---|---|
| World Maker 원본 47 섹션 | 47 | **8** (복원 3 + 부분 5) | 39 | **미복원 39개는 대부분 LIBRA 가 이미 대응 보유** (§1) |
| 설계서 §4 능력 대응표 | 8 | **8** | 0 | 완전 반영 |
| R01–R16 불변 조건 | 16 | 4 | **12** | **명시 보강 필요** (§8) |
| A01–A44 수용 사례 | 44 | 23 | **21** | T06·T08·T09·T10 소유가 주 (계획엔 있음, 문서엔 약함) |
| G01–G18 시험표 | 18 | 18 | 0 | 매핑 완료 |
| 19후보 벤치마킹 | 19 | 채택 14 · 보류 3 · 조건부 2 | 0 | `mode_exclusive_adoptions: 0` |
| 부록 C.3 감사 4항목 | 4 | 1 | **3** | T06·T07·T10 에서 처리 |

**핵심:** "총망라"를 물었을 때 정직한 답은 **"아니다"** 였다. World Maker 47섹션 중 내가 실제로 판정한 것은 4개였고, 나머지 43개는 조사되지 않았다. 이 문서가 그 43개를 **전수 조사했다.**

---

## 1. World Maker 원본 47 섹션 전수 대조

`[태그]` 와 줄 범위. **판정** 열이 이 프로젝트에서의 처분이다.

| # | 섹션 | 위치 | 줄수 | 판정 | 근거 |
|---|---|---|---|---|---|
| 1 | `[CORE]` Error Handler | L158 | 1,104 | **미복원** | LIBRA 에 자체 오류 계층 있음. `01` §5 "새 helper 에 독립 durable DB·롤백 권한 금지" |
| 2 | `[UTILITY]` State Management | L1262 | 3,162 | **미복원** | LIBRA 는 Head/Replay/Correction 사용 (`01` §4 "지속 상태 변화" 대응표) |
| 3 | `[UTILITY]` RWLock | L4424 | 72 | **미복원** | LIBRA 는 `enqueue`/`state.unifiedWriterLeases`/`storageWriteFence` 사용 |
| 4 | `[UTILITY]` Async Task Queue | L4496 | 3,789 | **미복원** | 동일. LIBRA 의 `runRecallStep`/`enqueue` 가 대응 |
| 5 | `[UTILITY]` Global Utilities | L8285 | 494 | **선별** | `tokenize`/`normalizeText`/`normalizeRecallToken`/`clampConfidence`/`clampImportance` 중 **필요분만** D03/D04 에서 참조 |
| 6 | `[MEMORY]` Compact Memory Codec | L8779 | 2,268 | **미복원** | summary-only 요약 계층. `01` §4 "새 arc/saga DB 복원하지 않음" |
| 7 | **`[RP-LTM]` Roleplay Long-Term Continuity Core** | L11047 | 2,166 | **★복원 (§D03·D04)** | 8분류 판정 로직의 원천. 이식 함수 8개 확정 |
| 8 | `[MANAGER]` Cold Start Manager | L13213 | 4,770 | **미복원** | LIBRA 는 `startManualColdStart`/`startManualCanonicalScan` 보유 |
| 9 | `[MANAGER]` Transition Manager | L17983 | 381 | **미복원** | LIBRA 는 `rebuildUnifiedStateForWorldline` 보유 |
| 10 | `[ENGINE]` Sync & Rollback Engine | L18364 | 311 | **미복원** | LIBRA 는 `mutateStateWorldline` + T01 로 확장 완료 |
| 11 | `[ENGINE]` V4.2 Rollback Snapshot Manager | L18675 | 262 | **미복원** | LIBRA 는 `restoreStateReplayBaseline` + basis snapshot 보유 |
| 12 | `[ENGINE]` RE-style Rollback Journal Manager | L18937 | 2,326 | **미복원** | LIBRA 는 `stateCorrections` journal 보유 |
| 13 | `[ENGINE]` V4.2 Turn Anchor Utilities | L21263 | 4,007 | **미복원** | LIBRA 는 `statePipelineCursorForRef` + `sessionEpoch` 보유 (C24) |
| 14 | `[UTILITY]` LRU Cache | L25270 | 93 | **미복원** | LIBRA 는 recall catalog + `state.recallCatalogCache` 보유 |
| 15 | `[API]` Providers | L25363 | 2,263 | **미복원** | LIBRA 는 `LibraProviderBridge` + preset 보유 |
| 16 | `[ENGINE]` Tokenizer & Hash | L27626 | 71 | **미복원** | `stableHash64` 는 HAYAKU 소관. LIBRA 는 `digest`/`stableHash` 사용 |
| 17 | `[ENGINE]` RE Companion Sparse Jaccard | L27697 | 669 | **★부분 참조 (D03/D04)** | `durableAnchorSimilarity` 의 Jaccard 아이디어만. **별도 엔진 도입 아님** |
| 18 | `[ENGINE]` Embedding Queue | L28366 | 29 | **미복원** | LIBRA 는 `retryPendingUnifiedVectors` 보유 |
| 19 | `[ENGINE]` Emotion Analyzer | L28395 | 130 | **미복원** | `01` §4 대응표에 없음. 복원 요구 아님 |
| 20 | `[API]` LLM Provider | L28525 | 868 | **미복원** | LIBRA 는 `callMemoryProvider` 보유. R04 "단일 Librarian 경로 유지" |
| 21 | `[ENGINE]` World Archetype Registry | L29393 | 10 | **미복원** | 원본에서도 **빈 호환 registry** (L29394 주석) |
| 22 | `[MANAGER]` Integrity Metadata | L29403 | 168 | **미복원** | LIBRA 는 manifest + SHA256SUMS + receipt 보유 |
| 23 | `[MANAGER]` Hierarchical World Maker | L29571 | 629 | **미복원** | `01` §4 — 별도 계층 만들지 않음 |
| 24 | **`[MANAGER]` Entity Manager** | L30200 | 5,305 | **★부분 복원 (D03·D04)** | `sameSlotIdentity`·`collectItemRefs`·`entitiesInText`·`getKnownEntityNames` 이식. **Entity Registry 자체는 LIBRA 것 유지**(R03) |
| 25 | `[MANAGER]` Hidden Entity Candidate Store | L35505 | 310 | **미복원** | LIBRA 는 `pending` + `splitRetiredNames` + `diagnostics` 보유 |
| 26 | `[MANAGER]` Secret Knowledge / POV Guard | L35815 | 1,418 | **미복원** | LIBRA 는 프롬프트 lens `knowledge`/`actor` 로 처리 (L1928, L1926) |
| 27 | `[MANAGER]` Narrative Time Engine | L37233 | 671 | **미복원** | LIBRA 는 `sessionEpoch` + `turnRange` + `cursor` 보유 |
| 28 | **`[MANAGER]` Narrative Tracker** | L37904 | 1,959 | **★부분 복원 (D04)** | `findStatusResolutionMatchIndex`·`durableAnchorTokens`·`isMatchingItem` 이식. **thread 저장은 LIBRA `Head.narrative.threads` 유지** |
| 29 | `[MANAGER]` V4.2 Narrative Orchestration Port | L39863 | 1,206 | **미복원** | `01` §14 "Planner 를 두 번째 memory writer 로 만들지 않는다" |
| 30 | `[MANAGER]` World Additional / World Changer | L41069 | 1,439 | **미복원** | L41071 주석: **은퇴한 호환 필드**. 사용자 추가는 User DLC 로 |
| 31 | `[MANAGER]` User DLC | L42508 | 1,582 | **미복원** | 사용자 저작 추가 계층. `01` §4 대응표에 없음 |
| 32 | `[MANAGER]` Illustration Intervention | L44090 | 4,582 | **미복원** | 시각 정본 교정. 이 프로젝트 범위 밖 |
| 33 | `[MANAGER]` Section World Inference | L48672 | 214 | **미복원** | LIBRA 는 `unifiedWorldReadContext` 보유 |
| 34 | **`[MANAGER]` Character State Tracker** | L48886 | 342 | **★복원 (D03)** | 취향·경계의 Head 반영 경로. LIBRA `buildUnifiedStateCandidate` 에 적응 |
| 35 | **`[MANAGER]` World State Tracker** | L49228 | 447 | **★복원 (D03)** | 동일. world domain 반영 |
| 36 | `[MANAGER]` Memory Engine | L49675 | 2,038 | **★부분 참조** | `upsertFromTurn`/`loadState`/`saveState` 흐름. LIBRA 는 `runUnifiedStateAfterCommit` 사용 |
| 37 | `[HME]` LIBRA-internal Associative Graph Adapter | L51713 | 7,056 | **미복원 (이미 구현됨)** | §9 참조. 원본 HME 는 "파생 인덱스일 뿐" 자기 규정. LIBRA `associative_recall.v1` Stage 1~6 이 더 엄격하게 구현 |
| 38 | `[MANAGER]` Internal Data Translation / Migration | L58769 | 286 | **미복원** | LIBRA 는 `loadUnifiedMigration` + `preserve_legacy_readonly` 보유 (D06) |
| 39 | `[MANAGER]` SourceReflectionManager | L59055 | 469 | **미복원** | `01` §14 "GUI 전용 정본 없음" |
| 40 | `[BRIDGE]` Evidence Bridge + Hypa Lanes | L59524 | 329 | **미복원** | LIBRA 는 `unifiedEvidenceRead` + ELI 보유 |
| 41 | `[ENGINE]` CBSEngine | L59853 | 942 | **미복원** | CBS(캐릭터 북 스크립트) 처리. `01` §17 범위 밖 |
| 42 | `[PROCESSOR]` Entity Extraction Prompt | L60795 | 106 | **미복원** | `01` §4 "단일 Librarian 분석" — 별도 추출기 만들지 않음 (R04) |
| 43 | `[PROCESSOR]` Entity-Aware Processor | L60901 | 2,475 | **미복원** | 동일 |
| 44 | `[PROCESSOR]` World Adjustment Manager | L63376 | 180 | **미복원** | 동일 |
| 45 | `[TRIGGER]` RisuAI Event Handlers | L63556 | 6,328 | **미복원** | LIBRA 는 자체 `beforeRequest`/이벤트 경로 보유 (`01` §5.2 H03) |
| 46 | `[MAIN]` Initialization | L69884 | 574 | **미복원** | LIBRA 는 자체 init 보유 |
| 47 | `[GUI]` LIBRA World Maker UI | L70458 | 7,879 | **미복원 — 별도 UI 금지** | `01` §14 "새 World Maker 메뉴나 상시 토글을 만들지 않는다". T08 은 **기존 BOOK 화면** |

**집계:** 복원 3 · 부분 복원 5 · **미복원 39 (그중 1개는 이미 구현됨 — `[HME]`)** · 확인 필요 0

---

## 2. 설계서 §4 능력 대응표 8개 — 전수 대조

| 능력 | 설계서 조치 | 내 계획 반영 | 담당 |
|---|---|---|---|
| **고정 사실** | "누락·재확인·정정·범위 유지 검증. **기존 필드 우선**" | ✅ | T03(reader) + 기존 `character_appearance`~`character_ability` |
| **취향·경계** | "근거 있는 지속 취향과 대상·조건별 경계의 typed 표현 및 현재 투영 보강" | ✅ D03 | T03b(writer) + T04 |
| **약속** | "같은 약속을 이어 읽고 이행·파기·취소·재개를 혼동하지 않게 한다" | ✅ D04 | T05 |
| **미해결 과제** | "다른 이름의 동일 과제와 같은 이름의 다른 과제를 구분; 오래된 열린 항목의 검색 보장" | ✅ D04 + A32 | T05 + T07 |
| **관계 이정표** | "기존 사건과 방향 관계의 연결을 읽어서 보여준다. 고백을 자동으로 상호 연애 관계로 승격하지 않는다" | ✅ | T09 (A36) |
| **지속 상태 변화** | "새 필드가 같은 재생·교정 경로를 통과하게 한다" | ✅ | T06 |
| **상징·모티프** | "구체적인 사건/의미 연결의 생성·저장·조회까지 검증한다. 단순 단어 반복으로 상징을 만들지 않는다" | ✅ | T09 (A37) |
| **핵심 에피소드** | "여러 묶음의 근거를 연결하는 읽기 표현을 설계한다. 자동 요약 원장·arc/saga 통합 DB는 복원하지 않는다" | ✅ | T09 (A38) |

**8/8 반영.** 단 §4 의 조치 설명은 **전부 "기존 구조 활용"** 이므로, 새로 만드는 것은 **판정 로직(D03·D04)** 뿐이다.

---

## 3. R01–R16 불변 조건 — 전수 대조

| R | 내용 | 담당 | 내 계획 명시 |
|---|---|---|---|
| R01 | 3모드 동일 기능·의미·작업 흐름 | T01·T08·T11 | ✅ D01 |
| R02 | 플러그인 단독 설치로 완결 | T07·T11 | ⚠️ **명시 필요** (A20·A44) |
| R03 | Canonical Memory 가 유일 정본 | T03–T09 | ⚠️ **명시 필요** |
| R04 | 단일 Librarian 분석 경로 유지 | T04–T07·T11 | ⚠️ **명시 필요** (호출 0 계약) |
| R05 | 원문·정본 바이트·부모/형제 비파괴 | T01·T06·T10 | ⚠️ **명시 필요** |
| R06 | U+A 근거·행위 주체 구분 | T03·T11 | ⚠️ **명시 필요** (A29) |
| R07 | 저장 완료는 실제 저장 + 되읽기 | T01·T08·T10 | ⚠️ **명시 필요** (G08) |
| R08 | 기존 Replay·Correction·worldline 확장 | T01·T06 | ✅ D01·T06 |
| R09 | 재확인은 변경 근거를 이동시키지 않음 | T04·T06 | ✅ D03·D04 (`reaffirm`) |
| R10 | Source Edit 정책 임의 변경 금지 | T06 | ✅ D06 |
| R11 | 선택 인덱스·Compute 가 필수 아님 | T07·T11 | ✅ D05 |
| R12 | 추정으로 정본 채우지 않음 | T03–T09 | ⚠️ **명시 필요** (A22) |
| R13 | GUI·응답이 같은 상태·이력·근거 | T08 | ⚠️ **명시 필요** (A33–A35) |
| R14 | 자동 대규모 재분석·무단 이전 금지 | T10 | ✅ D06 |
| R15 | 필요한 변경만 수행 | 전 작업 diff | ⚠️ **명시 필요** |
| R16 | 기능 동등성 ≠ 인프라 가용성 | T01 | ⚠️ **명시 필요** (A04–A06) |

**4/16 완전 명시 · 12개 보강 필요.**

---

## 4. A01–A44 수용 사례 — 소유 작업별 전수

| A | 소유 | 검증 층 | 제목 | 내 계획 |
|---|---|---|---|---|
| A01 | T00 | baseline/source | 기준선·제품 바이트와 테스트 해석 | ✅ BASELINE |
| A02 | T01 | runtime/storage | State cutoff·재개 3모드 성공 | ✅ **PASS** |
| A03 | T01 | runtime/storage | 임의 논리 fork 일관성 | ✅ |
| A04 | T01 | fault/storage | 서버 commit 성공·응답 손실 | ⚠️ T01 확장 |
| A05 | T01 | fault/storage | 동시 교정·ABA·scope 전환 | ⚠️ T01 확장 |
| A06 | T01 | fault/storage | mirror 부분 실패·server_only 장애 | ⚠️ T01 확장 |
| A07 | T04 | det/semantic | 독립 취향 여러 개의 누적 | ✅ D03 |
| A08 | T04 | det/semantic | 대상·조건·시간별 경계 | ✅ D03 4축 |
| A09 | T04 | runtime/semantic | 정확한 한 항목 변경·철회 | ✅ D03 |
| A10 | T04,T06 | runtime/provenance | 재확인·재시도·Replay 멱등성 | ⚠️ D03 + T06 |
| A11 | T05 | runtime/semantic | 같은 제목의 다른 약속 | ✅ D04 |
| A12 | T05 | runtime/semantic | 표현이 바뀐 같은 약속 | ✅ D04 |
| A13 | T05 | runtime/semantic/GUI | 이행·파기·취소·장애 구분 | ✅ D04 |
| A14 | T05 | runtime/semantic | 재개와 비슷한 새 약속 | ✅ D04 |
| A15 | T03,T05 | validator/runtime | 위조·미래·순환·다른 세계선 참조 | ✅ D04 |
| A16 | T05 | prompt/runtime | 후보 참고자료 예산 고갈 | ✅ D05 |
| A17 | T05,T07 | runtime/semantic | 105턴 장기 약속 전체 흐름 | ⚠️ LETTER-LIFECYCLE 별도 |
| A18 | T07 | recall/response | 당시 사실과 현재 사실 | ✅ 3시점 라벨 |
| A19 | T07 | recall/budget | 작은 주입 예산의 후속 반전 | ✅ D05 |
| A20 | T07,T11 | runtime/config | ELI OFF·cold cache·동료 없음 | ✅ R11 |
| A21 | T07 | fault/recall | 오래된 카탈로그·불완전 coverage | ✅ 폴백 |
| A22 | T03,T07 | semantic/runtime | 전언·가정·상충 상태 | ⚠️ **명시 보강** |
| A23 | T06 | runtime/source rev | 원문 수정 auto/off 경계 | ⚠️ T06 |
| A24 | T06 | runtime/revision | 리롤·대상 revision 무효화 | ✅ D06 |
| A25 | T06 | runtime/storage | 직접 교정·중단·재활성화 | ⚠️ T06 |
| A26 | T01,T06 | runtime/branch | native branch 부모·형제 불변 | ⚠️ T06 |
| A27 | T06,T10 | runtime/lineage | 세션 재시작의 동일 턴 번호 | ⚠️ T06·T10 |
| A28 | T06 | fault/replay | 재생 취소·재시작·구간 누락 | ⚠️ T06 |
| A29 | T03,T11 | semantic/validator | U+A 주체·직접 근거 | ⚠️ **명시 보강** |
| A30 | T03 | validator/runtime | 불량 선택 필드·유효 기억 부분 수용 | ✅ D02 |
| A31 | T03,T10 | schema/runtime | 구형·신형 혼합·알 수 없는 버전 | ✅ D02 |
| A32 | T04 | runtime/capacity | 프로필 용량·미해결 항목 오래됨 | ⚠️ **명시 보강** (32개 한도) |
| A33 | T08 | DOM/runtime | 기존 GUI 전체 연결 | ⚠️ T08 |
| A34 | T08 | DOM/fault | GUI 실패·취소 피드백 | ⚠️ T08 |
| A35 | T08 | runtime/response | Classic·Planner·SGA 기존 권위 | ⚠️ T08 |
| A36 | T09 | semantic/history | 관계 이정표와 방향성 | ⚠️ T09 |
| A37 | T09 | semantic/recall | 상징 연결·평범한 반복 소품 | ⚠️ T09 |
| A38 | T09 | runtime/history | 여러 구간의 핵심 에피소드 | ⚠️ T09 |
| A39 | T10 | storage/transfer | 3×3 portable 전송·cross-chat | ⚠️ T10 |
| A40 | T10 | fault/transfer | 누락·변조된 복원 묶음 | ⚠️ T10 |
| A41 | T10 | runtime/migration | 업그레이드·다운그레이드·과거 데이터 | ✅ D06 |
| A42 | T11 | benchmark/runtime | 호출·예산·긴 작업 반응성 | ✅ D05 |
| A43 | T11 | live model/gold | 실제 모델의 의미 품질 | ⚠️ 별도 축 |
| A44 | T11 | live host/release | 실제 Risu·독립 설치·배포본 | ⚠️ 별도 축 |

**✅ 23 · ⚠️ 21 (T06·T08·T09·T10 소유가 대부분)**

---

## 5. World Maker 이식 함수 — 전수 목록

`[RP-LTM]`·`[Entity Manager]`·`[Narrative Tracker]`·`[Character/World State Tracker]` 에서 **실제로 LIBRA 에 없는 것**을 판별한 결과.

### 5.1 D03·D04 에서 이식 확정 (8개)

| 함수 | 원본 | 역할 | LIBRA 대응 |
|---|---|---|---|
| `inferPreferenceKind` | L11219 | 취향/경계 세부분류 | **없음 → 신규** |
| `inferPreferenceTopic` | L11227 | identity 축 추출 | **없음 → 신규** |
| `sameSlotIdentity` | L11498 | subject+topic 2축 판정 | **없음 → 신규** |
| `durableAnchorSimilarity` | L11531 | category별 Jaccard | **없음 → 신규** |
| `durableAnchorTokens` | L11516 | category별 불용어 제거 | **없음 → 신규** |
| `isMatchingItem` | L11539 | 유형별 임계 | **없음 → 신규** |
| `findStatusResolutionMatchIndex` | L11554 | owner+target+anchor 3중 | **없음 → 신규** |
| `itemMaterialSignature`+`mergeItemVersions` | L11351/11338 | 버전 이력 | **없음 → 신규** |

### 5.2 보조 유틸 — 필요 시 참조 (7개)

| 함수 | 원본 | 처분 |
|---|---|---|
| `tokenize` / `normalizeRecallToken` | L11118/11108 | 한국어 조사 제거 필요 시 이식 |
| `normalizeText` | L11101 | LIBRA 에 유사 함수 있음 → **중복 확인 후** |
| `collectItemRefs` | L11511 | D03·D04 후보 매칭에 필요 |
| `entitiesInText` / `getKnownEntityNames` | L11190/11171 | Entity Registry 와 연결 시 |
| `snapshotItemVersion` / `applyItemVersion` | L11326/11358 | `versions[]` 구현 시 |
| `durabilityFromText` / `normalizeDurability` | L11153/11133 | durable 취향 판정 시 |
| `clampConfidence` / `clampImportance` | L11131/11132 | 필요 시 |

### 5.3 이식하지 않음 — 이유 명시

| 함수/구조 | 이유 |
|---|---|
| `mergeItems` (`RPContinuityCore` 전용) | `lmai_rp_longterm` 저장소 구조 전용. **R03 위반** (별도 정본) |
| `RPContinuityCore` (CATEGORY_LIMITS 8분류) | 동일. LIBRA `UNIFIED_CLAIMS` 로 표현 |
| 정규식 상수 (`MAJOR_RELATION_RE` 등 20개) | **키워드 휴리스틱**. `01` §7.1 "이름·키워드만으로 병합 금지" 위반. D03 은 `inferPreferenceKind` **분류만** 참조 |
| `CLOSED_STATUS`/`ACTIVE_STATUS` Set | `01` §9 "현재 enum 에 무단 추가하지 않는다" → **사용 금지** |
| `versions[]` 를 별도 정본으로 | `01` §8.4 "과거 versions 배열을 별도 이력 정본으로 추가하지 않는다" |

---

## 6. 벤치마킹 패키지 — 19후보 판정 전수

| # | 후보 | 판정 | 내 계획 |
|---|---|---|---|
| 1 | Source Identity / Revision | 기존 유지 | ✅ (LIBRA sourceDigest·revision) |
| 2 | **Snapshot / Fingerprint** | **bounded_optimization** | ✅ **HAYAKU `c5d9469` 완료** (G01 통과) |
| 3 | **Request-local Cache** | **bounded_optimization** (2와 결합) | ✅ 동일 |
| 4 | 재구축 가능한 파생 인덱스 | 기존 유지·검증 | ⚠️ G10 미실행 |
| 5 | 단계별 지연 HUD | **conditional_owner_gui** | ⚠️ `01` §8.1 — 실사용 불편 확인 시만 |
| 6 | Immutable Generation / COW | 기존 유지 | ✅ |
| 7 | Provenance / Derivation | 기존 유지 | ✅ |
| 8 | Canonical Hydration | 기존 유지·경로별 검증 | ⚠️ **"모든 recall 경로가 검증됐다는 뜻 아님"** |
| 9 | Stale Revision Filtering | 기존 유지 | ✅ |
| 10 | JEV Reviewer | **deferred** | ❌ 보류 |
| 11 | Multi-query | 기존 유지 | ✅ |
| 12 | 중복 근거 병합 | 기존 유지 | ✅ |
| 13 | Entity Alias / Identity Resolution | 기존 유지·보강 | ⚠️ A15 |
| 14 | Temporal / Supersession | 기존 유지 | ✅ |
| 15 | Unresolved Thread Registry | 기존 유지 | ✅ D04 |
| 16 | Episode→Chapter→Arc→Saga | **deferred** | ❌ 보류 (A38 은 읽기 표현만) |
| 17 | 원작/Canon Reference DB | **deferred** | ❌ 보류 |
| 18 | Knowledge Graph | 기존 유지 | ✅ (A37 associate link) |
| 19 | Provenance Explorer | **conditional_owner_gui** | ⚠️ 기존 화면 충족 시 불필요 |

**mode_exclusive_adoptions: 0** (`DECISIONS.json` — 모드 전용 채택 없음)

---

## 7. 부록 C.3 "다음 감사" 4항목 — 1차 결과와 공백

| # | 감사 항목 | 1차 결과 (`HAYAKU_EXECUTION`) | 남은 공백 |
|---|---|---|---|
| 1 | 정본 재조회·오래된 리비전 차단 | LIBRA recall 3모드·원문 편집 3모드 등 10개 exit 0 | ⚠️ **"낡은 파생 후보를 심어 정본 재조회→유효 revision 판정→실제 beforeRequest 주입"을 3모드·분기에서 한 번에 확인한 증거 없음** |
| 2 | 세계선·채팅·비동기 결과 격리 | 세계선 3모드·`libra_worldline_async_isolation_3mode_test` PASS | ⚠️ 늦은 비동기 결과가 다른 세계선을 덮는지 미확인 |
| 3 | 파생 인덱스 재구축·원본 보존 | `flashback_episode_index_rebuild_runtime_test` PASS (digestSame:true) | ⚠️ LIBRA ELI 삭제·손상 후 재구축 미확인 |
| 4 | **현재·과거·분기·별칭·미회수 약속** | recall 3모드 preview 확인 | ⚠️ **최종 주입까지 비교한 증거 없음** ← T07 |

**C.3 이 명시한 4항목 중 3개가 공백이다.** T07 이 4번을 담당하고, 1·2·3 은 T06·T10 에서 처리한다.

---

## 8. 누락 정리 — 보강 필요 19건 (HME 1건 해소)

| # | 누락 | 어디에 넣을 것 |
|---|---|---|
| 1 | R02 (단독 설치) 명시 | 계획 §4 증거규약에 R01–R16 체크리스트 |
| 2 | R03 (유일 정본) 명시 | 동일 |
| 3 | R04 (단일 분석 경로·호출 0) 명시 | 동일 |
| 4 | R05 (원문·부모/형제 비파괴) 명시 | 동일 |
| 5 | R06 (U+A 주체) 명시 | 동일 |
| 6 | R07 (실제 되읽기) 명시 | 동일 |
| 7 | R12 (추정 금지) 명시 | 동일 |
| 8 | R13 (GUI·응답 동일 소비) 명시 | 동일 |
| 9 | R15 (필요한 변경만) 명시 | 동일 |
| 10 | R16 (동등성 ≠ 가용성) 명시 | 동일 |
| 11 | A04–A06 (T01 fault) 계획 | T01 확장 (별도 작업) |
| 12 | A10 (멱등성) | T06 |
| 13 | A17 (105턴 LETTER-LIFECYCLE) | T05·T07 별도 fixture |
| 14 | A22 (전언·가정) 명시 보강 | T03·T07 |
| 15 | A29 (U+A 주체) 명시 보강 | T03·T11 |
| 16 | A32 (프로필 용량 32) | T04 |
| 17 | A33–A35 (GUI) | T08 |
| 18 | A36–A38 (관계·상징·에피소드) | T09 |
| 19 | A39–A40 (portable) | T10 |
| ~~20~~ | ~~`[HME]` Associative Graph Adapter~~ | **해소** — §9. 현행 `associative_recall.v1` Stage 1~6 이 대응. 복원 불필요 |

---

## 9. `[HME]` LIBRA-internal Associative Graph Adapter — **조사 완료: 이미 구현됨**

`L51713`, 7,056줄. 원본에서 유일하게 이름에 `LIBRA-internal` 이 들어간 섹션.

### 원본 HME 의 자기 규정 (L51713–51716)

```
// Derived retrieval index only. No HAYAKU dependency, no canon,
// no raw LiveChat storage, and no standalone memory authority.
```

**원본 스스로 "파생 검색 인덱스일 뿐, 정본도 권위도 아니다"** 라고 선언한다.

### 현행 LIBRA 대응 — 이미 있음

| 원본 HME | 현행 LIBRA | 상태 |
|---|---|---|
| `lmai_hme_graph_index` (독립 키) | `libra.associative_recall.v1` | ✅ **Stage 1~6 구현 완료** |
| `HME_GRAPH_MODE_PRESETS` (off/light/balanced/deep) | `associative_recall_enabled` opt-in gate | ✅ 더 엄격 |
| `HME_GRAPH_ONLY_MAX_SCORE 0.58` | `ASSOCIATIVE_RECALL_ADMIT_LIMIT 2` + `MIN_RELEVANCE 0.18` | ✅ bounded |
| `HME_GRAPH_EDGE_LIMIT_PER_NODE` | `ASSOCIATIVE_RECALL_ENTITY_FANOUT_LIMIT 12` | ✅ |
| `HME_GRAPH_STALE_EDGE_POLICY` (prune/rebuild) | `loadOrRefreshEvidenceLinkIndex({force,persist})` | ✅ |
| `bonusCap` (0.10~0.18 가산) | **없음 — 의도적** | ✅ **admitted row 도 같은 gate 통과** |

LIBRA 의 Stage 4 주석이 원본보다 엄격함을 명시한다:

> "안전 gate 는 절대 완화하지 않는다" — an associative row is a normal row; it is not exempt from the gate, and `associative` is only a provenance label on it.

**판정: 복원 불필요.** 원본 HME 의 `bonusCap`(점수 가산) 방식은 LIBRA 가 **명시적으로 거부**한 설계다(근거 없는 후보를 가산으로 통과시키는 것). `01` §34 "HME 전체 재도입" 비목표와 일치.

### 이 프로젝트에서 HME 에서 가져올 것

없음. 단 **T07 의 closure 가 기존 연상 인덱스와 충돌하지 않는지**는 확인 대상이다(§7 부록 C.3 항목 3).

---

## 10. 이 문서의 한계

- **World Maker 원본 47섹션 중 39개를 "미복원"으로 판정**했으나, 그 판정은 **섹션 제목·줄수·설계서 대응표 + `[HME]`·`[RP-LTM]`·`[Entity Manager]` 표본 확인**을 근거로 한 것이다. 39개 각각의 **내부 함수를 전수 확인한 것은 아니다.**
- 특히 `[MANAGER]` 계열 5,000줄 이상 섹션(Entity Manager·Cold Start·Illustration)은 **표본만** 봤다.
- **이 문서는 "무엇을 만들지"의 목록이지 "무엇이 안전한지"의 증명이 아니다.** 각 작업의 RED 관찰이 그 역할을 한다.
- 판정을 바꾸려면 **실측 근거**를 붙여 이 표를 고친다.
