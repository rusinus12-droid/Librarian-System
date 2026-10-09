# MAIN_MEMORY_IMPLEMENTATION_PLAN — 확정 설계

**기준:** `review_artifacts/LIBRA_WorldMaker_Integration_Plan_20260925` (T00~T11) + `Librarian-Benchmark-Validation-20260925` (G01~G18)
**작성:** 2026-09-26 · **설계자:** Hermes (감독 검토 대기)
**계약:** D01–D06 은 `MAIN_MEMORY_CONTRACT_DECISIONS.md` v2 로 확정

이 문서는 논의를 종결하고 **실행 순서와 각 작업의 경계**를 확정한다. 계약 값은 v2 문서가 정본이고, 이 문서는 **무엇을 어떤 순서로 어떤 증거와 함께** 하는지를 정한다.

## 1. 현재 상태 (실측)

| 항목 | 상태 |
|---|---|
| HEAD | `ee6a5dd` · `f7a7167` (T11 보고) · `167a832` (release 0.3.66) · `27c26f8` (읽기 카테고리 계약) · `8042e27` (T11 게이트) · `e911a60` (T10) · `4b5e31e` (T09) · `bfd0169` (T08) · `6097601`/`86f23fe` (T06) |
| T00 기준선 | **완료** — 18/18 PASS, `/tmp/_t00_baseline` |
| T01 State 3모드 | **완료** — `8137982`, A02 충족, 변이 4/4 |
| HAYAKU visible hash | **완료** — `c5d9469`, G01 통과 (`hayaku_visible_hash_reuse_runtime_test.cjs`: warm `calls:18, longBodyCalls:0`) |
| D01–D06 계약 | **완료** — `MAIN_MEMORY_CONTRACT_DECISIONS.md` v2 |
| 회귀 | **743/743 FAIL 0** (신규 12 스위트 포함) · 빌드 게이트 5/5 within floor (libra 3,321,808 B) |
| T03 v5 reader | **완료** — `61635eb`. v5 판독(v4 동일 render 688B) + 미지원 차단 + A30 부분 수용 |
| T03b v5 writer | **완료** — `f580178`. v5 라벨만 v5 로 기록, 기본 v4. 혼합 replay 3모드 검증 |
| T04 취향·경계 | **완료** — `61635eb`/`7b45ad1`. World Maker 판정 로직 이식, 경계 4축, 3모드 12/12 |
| T05 약속 lifecycle | **완료** — `61635eb`. link 5종 + resolution, A11 참여자 매칭 |
| T06 Replay·Source Edit·세계선 | **완료** — `86f23fe`. 재생 멱등·재확인·correction 경로·fork 거부, 3모드 |
| T07 recall closure | **완료** — `61635eb`. §7.2 시그니처 + recall 경로 연결, 3모드 |
| T08 GUI(BOOK) | **완료** — `bfd0169`. 선호·경계 그룹+탭, 인물 시트 6/6 |
| T09 관계·상징·에피소드 | **완료** — `4b5e31e`. `arcs`·`relations` 탭, 연감 6/6 |
| T10 portable·재시작·다운그레이드 | **완료** — `e911a60`. 재개방 무음·bytes 보존, 3모드 |
| T11 최종 게이트 | **완료** — `8042e27`/`ee6a5dd`. 회귀 743/743, release 0.3.66, 수용 회계 117/15/0 |
| A01~A44 | **판정 완료** — 132행 중 PASS 117(39사례) · BLOCKED 15(A04·A05·A06·A43·A44) · FAIL 0. `libra_main_memory_acceptance_test.cjs` 가 사례별 action 대조로 산출 |

**제 T04·T07 테스트를 `tests/pending_implementation/` 로 이동했다.** 둘 다 RED 를 기대하고 작성했는데 배치가 FAIL 로 집계해 진짜 회귀 신호를 가렸다. `run_regression_batch.py` 는 `tests/*.cjs` 만 스캔하므로 이동하면 제외된다. 구현 시점에 `tests/` 로 되돌린다.

## 2. 작업 순서 (확정)

```
T03  v5 reader (읽기 전용)                    ✅ 완료 61635eb
     ↓
T03b v5 writer + normalizer + validator + renderer   ← 다음 (reader 배포 확인됨)
     ↓
T04  취향·경계  = World Maker 판정 로직 이식   ✅ 완료 61635eb
     ↓
T05  약속 lifecycle = link 5종 + resolution   ✅ 완료 61635eb
     ↓
T06  Replay·Source Edit·세계선 통합 (기존 경로 확장)  ✅ 완료 86f23fe
     ↓
T07  recall closure = §7.2 시그니처 그대로     ✅ 완료 61635eb
     ↓
T08  BOOK GUI 연결 (기존 화면)
T09  관계 이정표·상징·에피소드 읽기
T10  portable·재시작·다운그레이드
T11  A01~A44 실행 + G01~G18 + 최종 게이트
```

**T03 을 reader/writer 로 쪼갠다.** `01` §12 "reader 배포 전에 writer 를 활성화하지 않는다"를 순서로 강제한다.

## 3. 각 작업의 확정 범위

### T03 — v5 reader (다음 작업)

**목표:** v5 를 **읽을 수 있게** 만들되 **쓰지 않는다.**

| 할 것 | 파일·지점 |
|---|---|
| v5 상수 추가 | `UNIFIED_ARTIFACT_SCHEMA_V5` (신규), **`UNIFIED_ARTIFACT_SCHEMA` 는 v4 로 유지** |
| dispatch 확장 | `continuityLegacyModeForMemory` (`L34256`) — v5 → 신규 mode `LEGACY_CONTINUITY_MODE_STATE_PIPELINE_V5` |
| `unifiedRefIsV4` 의미 확장 | 24곳 — v4 **또는** v5 를 "읽을 수 있는 정본"으로. 이름은 유지(`unifiedRefIsReadableUnified`) 별칭 추가 |
| allowlist 확장 | `validateUnifiedFactRecord` (`L44269`) — v5 전용 claim kind 수용 |
| 부분 수용 | 하나의 불량 optional fact 가 다른 유효 fact 를 버리지 않게 (`03` A30) |
| 미지원 미래 schema | `LEGACY_CONTINUITY_MODE_UNSUPPORTED` 유지 — **데이터 손실 없이 차단** |

**쓰지 않는 것:** `UNIFIED_ARTIFACT_SCHEMA` 상수 값, v5 writer 경로, 프롬프트 출력 계약.

**RED (먼저 관찰):**
```
libra_main_memory_schema_compatibility_test.cjs
  - 고정 v4 bytes 읽기 → digest 불변
  - v5 artifact 읽기 → 현재는 UNSUPPORTED 로 떨어짐 (RED)
  - 미지원 미래 schema → 차단, 데이터 손실 0
  - dangling link → 해당 연결만 격리, 독립 사실 보존
```

**GREEN 조건:** v4 bytes 100% 동일 + v5 부분 수용 + 미지원 차단 + **writer 호출 0**.

### T03b — v5 writer

reader GREEN 확인 후에만 착수. `prepareUnifiedMemoryArtifact`·`renderUnifiedArtifact`·`validateUnifiedCanonicalRenderedText` 를 v5 로 확장하고, **v5 로 라벨링된 것만** v5 로 쓴다.

### T04 — 취향·경계

**D03 계약대로 World Maker 판정 로직을 이식한다.** 원본 함수를 그대로 복사하지 않고 **LIBRA 의 `UNIFIED_CLAIMS` 와 Head 구조에 맞춰 적응**시킨다.

| 이식 | 원본 | LIBRA 적응 |
|---|---|---|
| `inferPreferenceKind` | `L11219` | v5 claim kind `character_preference` / `character_boundary` 로 매핑 |
| `inferPreferenceTopic` | `L11227` | `topic` 필드 (identity 축) |
| `sameSlotIdentity` | `L11498` | `subject + topic` 2축으로 같은 항목 판정 |
| `durableAnchorSimilarity` | `L11531` | 후보 매칭 (근거 + 유사도 조합) |
| `itemMaterialSignature` | `L11351` | 실제 변경 판정 |
| `mergeItemVersions` | `L11338` | 원본 참고. LIBRA는 canonical에 `versions[]`를 복제하지 않고 active canonical chain + Correction Journal로 최대 64-ref semantic timeline을 파생한다. 절단·누락은 History API/BOOK에서 partial과 `first_observed`로 표시한다. |

**경계 4축:** `{subject, target, act, when}` 보존. 범위 밖은 자동 일반화 금지 (`03` A08).

**RED:** `libra_main_memory_profile_lifecycle_test.cjs` (이미 작성, `pending_implementation/` 에 있음) — 5개 항목 검사.

### T05 — 약속 lifecycle

| 이식 | 원본 |
|---|---|
| `findStatusResolutionMatchIndex` | `L11554` — owner+target+anchor 3중, 참여자 필터 |
| `isMatchingItem` | `L11539` — 유형별 임계 |
| `durableAnchorTokens` | `L11516` — category별 불용어 제거 |

**link 5종:** `reaffirm`/`replace`/`resolve`/`reopen`/`associate` (`01` §7.3).
**종결 사유:** 기존 enum 안에서 `resolution` 필드로 구분. **`broken` ≠ `resolved`**.

**RED:** `libra_main_memory_thread_identity_test.cjs` + `libra_main_memory_candidate_boundary_test.cjs`.

### T06 — Replay·Source Edit·세계선

기존 `buildUnifiedReplayCandidate`(`L45603`) 재사용. v5 사실·link 검증을 연결. **read path 에서 LLM 호출 0.** 링크 대상 무효화 시 자동 리다이렉트 금지 (`03` A24).

### T07 — recall closure

**`01` §7.2 의 시그니처를 그대로 구현한다:**
```
resolveRecallContinuityClosure({ selectedFacts, manifest, head, readFact, budget, signal })
  -> Promise<{ facts, currentness, closureComplete, diagnostics }>
```

**fixture 는 벤치마킹 §9.2 를 쓴다** (LETTER-LIFECYCLE 105턴이 아니라):
```
W0: T1 열쇠→서랍 / T2 열쇠→주머니 + 지도 약속 / T3 아직 안 돌려줌
W1: T1 뒤 분기, 열쇠→금고
편집: T1 같은 ID, '서랍'→'금고'
별칭: 미라와 다른 인물 둘 다 '선생님'
```

**A18 의 3시점 동시 라벨:** `through105 fulfilled; through40 open; child45 cancelled`.

**카탈로그 슬롯 요약 + 정본 폴백:** 정상 경로에서 정본 read 0회, 카탈로그에 슬롯 없으면 정본 재조회로 폴백 (A21 이 요구하는 "미확인 → last-known/unknown").

### T08~T11

문서 `02` 의 정의를 그대로 따른다. **A01~A44 실행은 T11 에서** 하되, 각 작업이 자기 소유 사례를 그 시점에 이미 실행해 둔다.

## 4. 증거 규약

**모든 작업이 남기는 것** (`02` §4 보고 형식):
```
작업 ID / 기준 commit·소스 해시:
변경 파일 및 소비 인터페이스:
실패 재현 사례 / 실제 실패 출력:      ← RED 명령 + exit code
수정 후 테스트 명령 / exit code / assertion 수:
세 모드 결과 / unsupported 또는 skip:
provider calls / 정본·부모·형제 해시:
새 schema/데이터 migration 영향:
남은 위험 / 다음 작업 입력:
```

**결과 기록** (`03` §7): `NOT_RUN`/`PASS`/`FAIL`/`BLOCKED`/`TIMEOUT`/`SKIP`/`EXIT_UNVERIFIED`.
`PASS` 에는 **명령·exit0·semantic oracle 비교·evidence** 가 있어야 한다. 최종 exit 를 모르면 `EXIT_UNVERIFIED`.

**미실행과 범위 밖을 별도 보고한다** (`02` §4). 미실행을 PASS 로 합산하지 않는다.

## 5. 이번에 확정하지 않는 것

| 항목 | 이유 |
|---|---|
| D05 수치 (후보·closure 상한, 지연 허용) | T07 에서 실제 workload 로 측정 |
| G01~G18 실행 결과 | 매핑만 확정. 해당 작업에서 실행 |
| 실기기 검증 (RisuAI 진행·취소·재열기) | `unverified` 로 표시. VM 성공을 live 통과로 바꾸지 않는다 |
| A43(실제 모델 품질) · A44(실제 RisuAI) | 별도 실행 축 |
| World Maker 데이터 자동 import | `01` §16 금지. 별도 작업 |

## 6. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| v5 도입이 74개 참조 지점을 건드린다 | reader 를 먼저 켜고 writer 는 뒤. v4 는 손대지 않음 |
| World Maker 로직 이식이 LIBRA 구조와 어긋난다 | 원본을 복사하지 않고 `UNIFIED_CLAIMS`·Head 구조에 적응. 각 이식 함수마다 반례 테스트 |
| T04/T05 가 기존 profile/thread 소비 지점을 깬다 | 기존 enum 유지 + 필드 추가. 기존 테스트 전부 회귀 |
| 회귀가 오래 걸려 피드백이 느리다 | 작업별 집중 테스트 먼저, 전체 회귀는 커밋 단위로 |
| 이전 판단(v1)이 또 틀릴 수 있다 | v2 는 모든 주장에 파일·줄. 판단은 **실측 후** 기록 |

## 6b. T03–T07 에서 확정한 구현 사실 (실측)

| 항목 | 실측 |
|---|---|
| v5 판독 | v5 artifact 가 v4 twin 과 **동일한 688 bytes 로 render** — "읽을 수 있다"가 gate 개방이 아니라 동일 결과임을 확인 |
| v5 writer | 여전히 v4. `UNIFIED_ARTIFACT_SCHEMA` 값 불변, v5 는 어디서도 쓰이지 않음 |
| 미지원 미래 schema | `UNIFIED_SCHEMA_INVALID` 로 차단 + 제공된 facts 13개 전부 보존 (손실 0) |
| A30 부분 수용 | 불량 fact 1개 격리, 무관 fact 유지, `admission.status='partial'`, 격리 사유 명명 |
| 취향 판정 | `category:'preference'` → `character_preference` + topic `민트차`. 판정 결과가 Head `state.preferences` 에 도달 |
| 경계 4축 | `[범위: 주체=… 대상=… 행위=… 시점=…]` 로 보존. 근거 없는 축은 빈 값 (추정 금지) |
| broken ≠ fulfilled | `status:'resolved'` + `resolution:'broken'`. A13 충족 |
| A11 참여자 매칭 | 같은 제목·다른 참여자 → matcher 가 index 0 선택 (제목만으로 병합 안 함) |
| R09 멱등성 | 재확인 배치 후 state·fieldEvidence **바이트 동일** |
| recall closure | `currentness: 'current'`, readCount 2, **모델 호출 0**. 현재성 라벨이 diagnostics 로 전달 |
| 회귀 오염 제거 | 4개 테스트를 `tests/` 로 복귀 → 전체 스위트 735 |

## 7. 즉시 다음 행동

1. **회귀 완료 대기** (진행 중) — 이동 전 목록 기준 FAIL 1 은 이동한 테스트. 다음 배치부터 정상.
2. **T03 RED 테스트 작성** — `libra_main_memory_schema_compatibility_test.cjs`
3. **T03 RED 관찰** — v5 artifact 가 현재 `UNSUPPORTED` 로 떨어지는지 확인
4. **T03 reader 구현** — dispatch 확장, writer 는 켜지 않음
5. **T03 GREEN + 변이** — v4 불변 · v5 수용 · 미지원 차단 각각 검출
6. 커밋 → 매니페스트 → 다음
