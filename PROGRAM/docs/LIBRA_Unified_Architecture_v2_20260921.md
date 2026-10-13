# LIBRA 통합 아키텍처 v2 — 기억 작성자 단일화와 상태 파생

> **2026-10-13 후속 검색 설계:** [LIBRA 차세대 통합 메모리 엔진](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md)은 정본·Micro·State·로어북의 공통 연결망과 검색, 캐시·Memory Lane·인덱스 재설계를 정의합니다. 아래 v2는 기존 작성·State 파생·소비자 구현의 기록이며, 새 검색 엔진이 이미 구현됐다는 뜻이 아닙니다. State가 정본에서 파생된다는 권한 계약을 유지하면서 State 필드도 검색 노드로 참여시키는 후속 설계입니다.

- 문서 상태: **구현 동기화본** (코드 실측 기준)
- 기준 구현: `PROGRAM/plugins/LIBRA.js` **2.3.141**
- 작성일: 2026-09-21
- 대체 대상: `LIBRA_Canonical_Memory_State_Tracking_Architecture_20260901.md` (2.3.1 동기화본, 퇴역)
- 대상: 기억 작성, 정본 저장, 상태 파생, SGA 응답 파이프라인, 소비자(GUI/Planner/Recall/Input Writer/GRADIA)
- 비대상: GRADIA 초안 작성 내부 알고리즘, Storage SDK 서버 구현

---

## 0. 이 문서의 지위와 검증 경계

### 0.1 무엇이 바뀌었는가

이전 아키텍처(2.3.1)는 기억 작성자를 **4개**(Ariadne + Character/World/Narrative ito)로 두고,
상태 추적을 **별도 LLM 호출**(4 Observer + 4 Verifier)로 수행했다.

2.3.141의 실제 구조는 다르다.

| 이전 (2.3.1) | 현재 (2.3.141) |
|---|---|
| 기억 작성자 4개 | **작성자 1개** — `librarian` |
| 상태 추적이 LLM을 호출해 상태를 새로 작성 | **별도 LLM 호출 0회.** 작성자 응답의 `stateBindings`가 사실에 결속되어 상태가 파생됨 |
| `libra.canonical_artifact.v3` | `libra.canonical_artifact.v4` (`entities` + `facts` + `stateBindings`) |
| Entity Admission decision/receipt 별도 단계 | Entity가 artifact에 포함되어 작성자 응답에서 함께 검증됨 |
| Observer/Verifier 8개 route | **전부 퇴역** (`RETIRED_MEMORY_STAGE_IDS`) |

퇴역 목록 (코드 상수 `RETIRED_MEMORY_STAGE_IDS`, LIBRA.js:1912):

```text
ariadne, character_ito, world_ito, plot_ito, state_entity_admission,
state_character_observer, state_relationship_observer, state_world_observer, state_narrative_observer,
state_character_verifier, state_relationship_verifier, state_world_verifier, state_narrative_verifier
```

퇴역 스테이지를 요청하면 `LEGACY_ANALYZER_RETIRED`가 fail-closed로 반환된다:

> 이전 기억 분석기는 퇴역했습니다. 기존 기록은 보존됩니다. 현재 해석은 교정하거나 필요한 5턴 구간을
> Librarian으로 명시 재분석하세요.

### 0.2 계승되는 원칙

이전 문서의 다음 원칙은 **2.3.141에도 그대로 유효**하며 이 문서가 계승한다.

1. Canonical Memory만 역사적 사실을 누적하는 정본이다.
2. Character·Relationship·World·Narrative 상태는 이력이 아니라 **최신값 materialized view**다.
3. 상태에 존재하지만 새 정본이 갱신하지 않은 필드는 보존한다. 누락은 보존이며 삭제가 아니다.
4. `clear`는 명시적 상실·종료·무효화·정정 근거가 있을 때만 허용한다.
5. 권위는 `Canonical → State Head` 단방향이다. State Head 값은 새 사실의 evidence가 될 수 없다.
6. 상태 실패는 정본 커밋을 취소하지 않는다 (fail-soft).
7. 내러티브 상태는 다음 장면 초안이나 미래 계획을 만들지 않는다.
8. 사용자 작성 정본은 채택 전에 상태 처분을 저장하고 새 basis에 결속한다.

### 0.3 "구현됨"의 뜻

이 문서에서 **구현됨**은 소스 계약이 존재한다는 뜻이다. 다음은 별개다.

- 계약 회귀·전체 회귀 통과
- 실제 RisuAI GUI 클릭 검증
- 실제 provider 호출의 비용·지연 특성
- 실제 모바일 기기 검증

이 문서의 모든 계약 문자열·상수·함수명은 2.3.141 소스에서 실측했다.

---

## 1. 핵심 정의

### 1.1 Canonical Memory (정본)

5개의 완료된 **U+A 턴**을 근거로 작성하고 영구 커밋하는 역사적 정본이다.

답하는 질문: **실제로 무슨 일이 있었고, 무엇이 확정되었으며, 무엇이 아직 불확실한가?**

포함: 시간순 사건, 행동 주체, 발언과 선택, 인물에 관해 확정된 사실, 관계 근거, 세계·장소·사물·조직·규칙의
변화, 열린/해결된 문제, 불확실성, exact evidence reference.

제외: 상태를 덮어쓰는 명령, 미래 장면 계획, 아직 일어나지 않은 사용자 행동, 추적 편의를 위한 수치 누적,
별도 상태 이력.

스키마: `libra.canonical_artifact.v4`

### 1.2 Current State Head

활성 정본 체인에서 계산한 **최신 상태의 materialized view**다.

답하는 질문: **지금 마지막으로 확정되거나 마지막으로 알려진 값은 무엇인가?**

속성: scope별 하나, overwrite-only, 기억 검색의 정본이 아님, 별도 사건 timeline 없음, 별도 vector 없음,
필드별 canonical provenance 보유, 언제든 활성 체인에서 재구축 가능.

스키마: `libra.continuity_state.v2`

### 1.3 State Binding

작성자 응답에서 **사실(fact)을 상태 필드에 결속하는 계약**이다. 이전 아키텍처의
"상태 추적 파이프라인"을 대체한다.

```json
{ "factTempId": "f1", "typedValueField": "condition",
  "stateDomain": "character", "stateField": "condition" }
```

검증: `fact.claimKind` → `UNIFIED_CLAIMS` 계약에서 `{factTempId, typedValueField, stateDomain, stateField}`를
계산하고, binding의 키 집합과 값이 **정확히 일치**해야 한다.

```text
일치          → 정본 binding으로 보존
불일치        → stateBindingIssues에 state_binding_pending:<factTempId> 기록
```

### 1.3.1 진단 이름과 실제 상태 반영은 다르다

**`state_binding_pending`은 "상태가 반영되지 않았다"는 뜻이 아니다.** 읽기 경로
(`unifiedStateBindingsForRead`, LIBRA.js:44633)는 binding이 제거되거나 불일치여도 **유효한 typed
fact에서 binding을 다시 파생**한다.

```text
currentFacts = facts.filter(claimKind에 field가 있고, domain 일치,
                            certainty === 'confirmed', temporalRole === 'current_sequence')
  → 컬렉션·access·affiliation은 개별 유지
  → 비컬렉션: [domain, subjectTempRef, targetTempRef, dimension, field, order] 슬롯으로 그룹화
  → 제공된 binding이 있는 fact를 우선 채택
  → 채택되지 않은 나머지는 supersededFacts로 분리
  → binding이 없는 fact도 재파생되어 바인딩된다
```

실측(감독 재현): `f6`의 binding을 **누락**시키거나 `stateField`를 **틀리게** 넣어도
`canonicalBinding: null`, `headStatus: ready`, `ownerApplied: true`였다 — 즉 **상태는 반영**되었고,
불일치 사례에는 `stateBindingIssues: ["state_binding_pending:f6"]`만 남았다.

따라서 진단을 읽을 때 다음을 구분한다.

| 상황 | `headStatus` | `pending[]` | 실제 |
|---|---|---|---|
| 제공된 binding 제거·재파생 | `ready` | `[]` | 상태 **반영됨**. 진단 이름은 pending이지만 보류가 아니다 |
| **상태 fact·binding을 아예 제공하지 않음** | `ready` | `[]` | **pending이 아니다.** 새로 반영되지 않을 뿐, 기존 필드는 일반 **보존** 계약의 대상 |
| 무효 values로 admission **격리** | `partial` | `[{fact, reason:'memory_record_quarantined'}]` | `stateBlocks`에 기록, 나머지 fact는 저장 |
| source-order 그룹 경쟁 탈락 | — | — | `supersededFacts`로 분리 — 반영되지 않지만 conflict가 아니다 |
| dependency·conflict | `partial` | 사유 포함 | **진짜 보류** |
| 유효 fact가 0건 | — | — | canonical 자체가 저장되지 않는 작성 실패 경로 |

**`제공하지 않음`과 `무효로 격리됨`은 다르다.** 전자는 조용한 보존이고, 후자는 진단을 남긴다.

§1.3.1의 재파생은 **유효 fact가 최종 경쟁·dependency 검사를 통과한 경우**에만 반영된다.

`state_binding_pending`을 "미반영"으로 보고하지 않는다. 상태가 반영됐는데 미반영으로 읽히는 보고를
남기지 않기 위해, 진단 소비자는 `pending[]`(진짜 보류)와 `stateBindingIssues`(재파생 신호)를
구분해야 한다.

### 1.4 Live Tail

최근 완료 U+A를 **요청 단위로만** 제공하는 비영구 최신 문맥이다.

**정본 경계와 묶이지 않는다.** `liveTailMaxTurns`(1~4, 기본값 별도)와 `liveTailMaxChars`로 창을 정하고
`pairs.slice(-maxRecentTurns)`로 잘라낸다. 소스 주석이 이를 명시한다 (LIBRA.js:49706~49708):

> One recent completed-dialogue window for every response consumer. Canonical commits and historical gaps
> never add, remove or reorder its source turns.

즉 **정본 커밋이 창을 밀어내지 않고**, 정본의 역사적 공백도 창을 바꾸지 않는다. `classic` route에서는
주입 한도를 넘지 않도록 `min(설정값, CLASSIC_MAX_INJECTION_CHARS - 2600)`로 더 조인다.

Planner·GRADIA에서 State Head보다 최신인 overlay로 쓸 수 있지만 State Head에 저장하지 않는다.
시간순 권위는 State Head에 있고, Live Tail은 whole-turn cap 안의 최근 창이다.

### 1.5 Fact Revision Patch

커밋된 정본을 파괴하지 않고 사실을 추가·교체·철회하는 경로다.
스키마 `libra.fact_revision_patch.v1`, 연산 `add` / `replace` / `retract`.

각 연산은 `expectedDigest`로 대상 사실의 현재 digest를 요구한다 (compare-and-swap).

```text
add      : factId 부재 + expectedDigest 없음
replace  : factId 존재 + expectedDigest === digest(현재 fact)
retract  : factId 존재 + expectedDigest 일치, fact 본문 없음
위반     → UNIFIED_PATCH_OPERATION_INVALID / UNIFIED_PATCH_ADD_EXISTS / UNIFIED_PATCH_FACT_MISMATCH
```

---

## 2. 권위 모델

### 2.1 단방향 권위

```text
정확한 완료 U+A 5턴
        │
        ▼
기억 작성자: librarian  (LLM 호출 1회)
        │  artifact = { schema, entities, facts[], stateBindings[] }
        │   ↓ 검증·격리·admission
        │  durable commit + readback
        ▼
Canonical Memory (libra.canonical_artifact.v4)
        │  stateBindings가 fact에 결속된 것만
        ▼
Current State Head (libra.continuity_state.v2)
        │
        ├── Planner
        ├── GRADIA
        ├── Input Writer
        └── LIBRA GUI
```

**권위는 위에서 아래로만 흐른다.** State Head가 다음 작성에 제공될 수 있는 경우에도 역할은 제한된다:
동명이인 구분, 기존 안정 ID 확인, 기존 최신값과 새 evidence 비교 보조, 과거 정본 provenance index.
State Head 자체의 값은 새 사건의 evidence가 될 수 없다.

### 2.2 사실과 파생 해석의 구분

```text
정본 사실:  "세아는 왕궁 서쪽 회랑으로 이동했다."              (fact, claimKind=location)
파생 상태:  character:세아.locationRef = "왕궁 서쪽 회랑"     (stateBinding)
```

앞은 역사적 사실, 뒤는 그 사실을 최신 상태 필드에 반영하는 파생 해석이다.
파생이 잘못되어도 정본 문장은 자동 수정되지 않는다. 정본이 revision되면 파생 상태는 재생성된다.

### 2.3 우선순위

상태 채택 우선순위:

1. 활성 worldline의 명시적 사용자 정정 또는 선택된 canonical revision
2. 더 새로운 커밋된 정본 사실
3. 같은 정본 안의 직접적이고 명확한 사실
4. 허용 범위의 보수적 파생 해석
5. 이전 State Head의 last-known 값

모델의 자유 추론, 일반 상식, lore 단순 언급, 이전 Head 값만으로는 **새 상태를 만들 수 없다.**

---

## 3. 기억 작성 파이프라인

### 3.1 작성자 단일화

```text
const STAGE_ORDER = Object.freeze([LIBRARIAN_STAGE_ID]);   // = ['librarian']
const UNIFIED_MODES = Object.freeze(['librarian']);
const LIBRARIAN_ENGINE_VERSION = 'libra.unified.v2';
const READABLE_UNIFIED_ENGINE_VERSIONS = ['libra.unified.v1', 'libra.unified.v2'];
```

`runLibraMemoryPipeline`은 `LibraMemoryCore.STAGE_ORDER`를 순회한다. 배열 길이가 1이므로 **논리
작성자(logical stage)는 하나**이며, 그 한 스테이지가 정본과 상태 후보를 함께 산출한다.

**논리 stage · 물리 호출 · 재시도 job은 서로 다른 층이다.** 같은 논리 stage가 한 번의 요청으로 끝난다는
뜻은 아니다.

| 층 | 실제 |
|---|---|
| 논리 stage | 1개 (`librarian`). `STAGE_ORDER` 길이 1 |
| 기본 물리 호출 | **1회**. `generationPolicy.enabled`가 꺼져 있으면 `extraCalls`는 0 |
| 조건부 추가 호출 | `generationPolicy.extraCalls === 1`이고, 첫 응답이 **출력 잘림**(`completionEnvelope.state === 'truncated'` + `terminalObserved`)이며 direct API이고 남은 예산이 있을 때 **1회 추가**. `maxPhysicalCalls = 1 + extraCalls` |
| 실패 배치 재시도 | `autoRetry` — 별도 job. 실패한 5턴 배치는 `manifest.failedBatches`에 내구 기록되고 자동 스캔 대상이 된다 |
| 사용자 명시 재분석 | 정확한 5턴 구간을 지정한 재실행. 자동 복구는 승인을 우회할 수 없다 (v2.3.27 계약) |

추가 호출의 예산은 별도다: `initialTotal 65,536`, `recoveryTotal 98,304`, `extraCalls===1`일 때
`aggregateOutput 163,840` / `aggregateInput 240,000`.

job의 `engineVersion`이 `LIBRARIAN_ENGINE_VERSION`과 다르면 `retiredAnalyzerError`로 거부된다.

### 3.2 프롬프트 조립 (`executeUnifiedStage`)

입력 순서(LIBRA.js:44550):

```text
system:
  unifiedPromptContract()
  [ANALYSIS PROFILE — subordinate to the evidence and output contract]
  compiled.profileBody
  analysisNsfw                          ← buildNsfwGuidanceBlock(settings, 'analysis')

user:
  optionalReference                     ← buildAriadneReferenceContext(batch)
  [READ-ONLY LAST-KNOWN STATE; NOT CURRENT EVENT EVIDENCE]
  optionalState                         ← unifiedStateReadProjection(basis.head)
  [State applied through turn N; missing or pending earlier ranges are unknown, not empty facts.]
  [COMPACT MEMORY OUTPUT] ... Use {factTempId} for State bindings. ...
  exactSource                           ← [EXACT FIVE U+A] t{n}-u / t{n}-a 5쌍
```

핵심 계약:

- 이전 State Head는 **읽기 전용**으로 전달된다. 현재 사건의 evidence가 아니다.
- 적용 범위는 `throughTurn`으로 명시되며, 누락·보류 구간은 **빈 사실이 아니라 미지**로 표기된다.
- `{factTempId}`로 상태 결속을 지시한다.
- 출력은 compact JSON이며 분석·체크리스트·반복 설명을 금지한다.

### 3.3 컨텍스트 압력 처리

```text
pressure() = promptWindow > 0 &&
             estimateContextTokensFromText(system + user) + outputReserve + 256 > promptWindow
```

압력이 있으면 다음 순서로 **선택적으로 생략**하고 `promptBudget.optionalOmitted`에 기록한다:

1. `reference` (Ariadne 참조)
2. `previous_state`

`exactSource`는 생략 대상이 아니다 — 근거는 항상 전달된다.

출력 예산: `resolveProviderOutputBudget` + `generationPolicy`. RisuAI aux provider는 자체 예산을 쓴다.

### 3.4 출력 캡 압력 진단

출력 사용률이 예산의 95% 이상이면 `libra.output_cap_pressure.v1`을 기록한다:

> completion_near_output_cap: reduce memoryBatchSize or raise the generation-policy output budget;
> artifacts at >=95% cap risk silent truncation that looks like a stop

호출 파라미터: `temp 0.1`, `jsonMode: true`, `structuredTask: true`, `forceNonStreaming`(정책),
`disableCanonicalRecovery: true`, `attemptType: 'initial'`.

### 3.5 응답 검증과 admission

```text
1. artifact = pick(value, ['schema','entities','facts','stateBindings'])
   └ 계약 외 필드는 droppedFields[{path, reason:'unsupported_field'}]로 기록 (조용히 버리지 않음)
2. schema !== UNIFIED_ARTIFACT_SCHEMA → 검증 중단
3. unifyWrappedFactValues(fact, issues)          ← values_claim_wrapper_unwrapped 언랩
4. quarantineUnifiedProviderRecords(artifact, batch)  ← 근거 없는 레코드 격리
   └ libra.record_admission.v1 { status, rejected[], droppedFields[], normalizedFields[], stateBlocks[] }
5. stateBindings 계약 검증 (§1.3)
6. artifact.stateBindings = 통과한 binding만
```

### 3.6 실패 정책 — 정본 작성 실패와 상태 파생 실패는 다르다

**정본 작성 실패는 fail-hard다.** `runLibraMemoryPipeline`(LIBRA.js:61144~61150)은 librarian
스테이지가 실패하면 `optionalFailures`에 넣지 않고 **그대로 throw**한다:

```js
} catch (error) {
  if (stageName === LIBRARIAN_STAGE_ID || !stageDraft(currentStage) || error?.name === 'AbortError' || job.signal?.aborted) throw error;
  optionalFailures.push(...);
}
```

즉 `optionalFailures`는 **이미 작성자가 있어야 성립하는 보조 단계**를 위한 것이며, 작성자 자신의 실패를
fail-soft로 일반화할 수 없다.

**정본 저장 이후의 파생 실패는 fail-soft다** (§5). 정본 커밋을 취소하지 않고 다른 도메인 성공도
막지 않는다. 이 둘을 같은 "fail-soft"로 묶지 않는다.

재시도 층:

| 경로 | 조건 |
|---|---|
| 조건부 추가 호출 | `extraCalls === 1` + 출력 잘림 + 예산 (§3.1 표) |
| 실패 배치 autoRetry | `manifest.failedBatches`에 기록된 5턴 배치의 자동 재스캔 |
| 사용자 명시 재분석 | 정확한 5턴 구간 지정. 자동 복구는 승인을 우회할 수 없다 (v2.3.27 계약) |

### 3.7 work 레코드

스키마 `libra.memory_work.v1`. 필드: `scopeKey`, `memoryId`, `turnRange`, `sourceDigest`,
`sourcePairs`, `engineVersion`, `engineMode`, `unifiedBasis`, `policySnapshot`, `revision`, `runId`,
`stageIndex`. `sourceDigest`·`revision` 불일치 시 새 run을 시작한다.

---

## 4. 정본 출력 계약 — `libra.canonical_artifact.v4`

### 4.1 최상위

```json
{ "schema": "libra.canonical_artifact.v4",
  "entities": [], "facts": [], "stateBindings": [] }
```

### 4.2 네 계층을 혼동하지 않는다

같은 개체가 계층마다 **다른 모양**을 갖는다. 아래는 실측한 각 계층의 실제 형태다.

| 계층 | entity | fact |
|---|---|---|
| **① 모델 출력** (admission 입력) | `{tempId, name, type('person'\|'world'), kind, evidenceSpans}` | `{tempFactId, domain, subjectTempRef, targetTempRef?, dimension?, claimKind, values{<claim.value>: …}, text, temporalRole, certainty, evidenceSpans, dependsOn?, effect?}` |
| **② 정본** (`canonical_artifact.v4`) | **①과 같은 필드만.** 런타임 식별자를 붙이지 않는다 | ①과 같은 필드. `effect`는 생략 가능하며 실행에서 `set`으로 해석된다 |
| **③ Entity Registry** (`entity_registry.v2`, **별도 파생 경로**) | `{id, type, kind, name, aliases[], validated, admission, …}`, `byId`, `fingerprint` | — (entity만) |
| **④ State Head** (`continuity_state.v2`) | `characters[]` / `world[]` row: `{id, name, kind, aliases, state{}, fieldEvidence{}, clearedFieldEvidence?, evidence, certainty}` | — (state 필드로 투영) |

**⚠ ② 정본에는 `ce_*` id가 들어가지 않는다.** 실측: 정상 fixture를 public job으로 커밋하고
`getMemory().canonicalArtifact`를 읽으면 entity는 `{tempId, name, type, kind, evidenceSpans}`뿐이다.
`ce_*`는 **③ Registry**에서 별도로 생성된다 (LIBRA.js:44682 `ce_${e.type}_${stableHash(...)}`).

Registry 필드를 모델 출력에 넣으면 **strict 검증은 거부**한다:

```text
strict:   UNIFIED_UNKNOWN_FIELD:entity.id
admission: droppedFields: [{ path: 'entities[7].id', reason: 'unsupported_field' }]  ← 조용히 제거 후 커밋
```

즉 strict 계약과 provider admission은 **다른 관용도**를 갖는다 (§4.3 참조).

### 4.3 세 단계를 구분한다 — provider 원본 → 정규화/격리 → strict 검증

**strict 계약이 모델의 admission 입력이라고 쓰면 틀린다.** 실제 provider 경로는 정규화를 먼저 거친다.

```text
provider 응답 (raw)
      │
      ▼
① quarantineUnifiedProviderRecords(artifact, batch)
      │  근거 없는 레코드 분리 + admission 기록
      ▼
② normalizeUnifiedProviderFact(fact, contract, entities, admission, index)   LIBRA.js:43582
      │  text가 비면 typed 값에서 파생 → normalizedFields에 text_from_typed_value 기록
      │  domain이 비거나 claimKind와 같으면 contract.domain으로 보정 → domain_from_claim_kind
      ▼
③ validateUnifiedFactRecord / validateUnifiedEntityRecord   (strict)
      │  위반은 throw → 격리로 이어짐
      ▼
정본 저장
```

실측 차이 (감독 재현, 13개 fact):

| 입력 변형 | strict 검증 | 실제 저장 |
|---|---|---|
| `text` 전부 제거 | **실패** `UNIFIED_FACT_SEMANTICS_INVALID` | **성공** 13개 모두 저장, Head `ready`, `normalizedTextCount: 13` |
| `f6.values` 제거 | 실패 `UNIFIED_OBJECT_REQUIRED:values` | **f6 격리** (`memory_record_quarantined`), Head `partial`, 나머지 12개 저장 |
| `entity.id` 추가 | 실패 `UNIFIED_UNKNOWN_FIELD:entity.id` | **성공** `droppedFields`로 제거 후 커밋 |
| `kind: 'other'` | 통과 | 통과 |

즉 **필수 저장 계약**(strict)과 **허용되는 provider 원본**(정규화가 보완)을 구분해야 한다.

### 4.3.1 strict 검증 계약 (코드 실측)

```text
entity (validateUnifiedEntityRecord, LIBRA.js:43521)
  unifiedKeys(e, ['tempId','name','type','kind','evidenceSpans'])
  tempId 중복 불가 · name 필수 · type ∈ {person, world}
  person  → kind는 비었거나 'person'
  world   → kind ∈ {location, object, organization, rule, environment, condition, thread, other}
  evidenceSpans 필수, quote 안에 name이 실제로 들어 있어야 함

fact (validateUnifiedFactRecord, LIBRA.js:43528)
  unifiedKeys(f, ['tempFactId','domain','subjectTempRef','targetTempRef','dimension',
                  'claimKind','values','text','temporalRole','certainty','evidenceSpans',
                  'dependsOn','effect'])
  claimKind가 UNIFIED_CLAIMS에 있고 contract.domain === f.domain
  text 필수 · temporalRole은 6종 중 하나
  subject 필수 (UNIFIED_SUBJECT_DANGLING)
  character·relationship → subject.type === 'person'   (UNIFIED_PERSON_REQUIRED)
  world·narrative        → subject.type === 'world'    (UNIFIED_WORLD_REQUIRED)
  values는 contract.value 키 하나만 (unifiedKeys(f.values, [contract.value]))
  dependsOn은 없거나 배열(≤20)  (UNIFIED_DEPENDENCY_INVALID)
  effect는 없거나 유효값 — 생략 시 실행에서 'set'으로 해석
```

**모델에게 권장하는 스키마**는 위에서 `text`와 `values`를 **둘 다** 제공하는 것이다. `text` 생략은
저장이 가능하더라도 파생 텍스트(`은빛 열쇠 · ownership: 민아`)가 되므로 근거 서술의 품질이 떨어진다.

`ce_*` 접두 식별자는 **런타임이 만든다** — `stableHash(scopeKey : type : kind : identityKey)`.
모델은 `tempId`만 쓴다. 같은 id가 다시 오면 별칭과 assertionId를 **병합**하고 entity 중복을 만들지 않는다.

**fact의 `values`와 `text`**: `values`는 claim에 맞는 typed 값이고, `text`는 근거 원문에 결속된 서술이다.
둘 다 필요하다. `text`만 있고 `values`가 없으면 `unifiedKeys(f.values, [contract.value])`에서 거부된다.

**비관계 fact의 `targetTempRef`·`dimension`**: `relationship` 도메인을 제외하면 사용하지 않는다.
관계 fact의 슬롯 키는 `[subjectId, targetId, dimension]`이고, 그 외는 `[domain, subjectTempRef, '', '',
field]` 형태다.

### 4.4 `UNIFIED_CLAIMS` — 24개 claim kind, 5도메인

| 도메인 | 개수 | claim kind |
|---|---|---|
| `character` | 12 | `character_note`, `location`, `character_state`, `character_appearance`, `character_background`, `character_personality`, `character_speech`, `character_habit`, `character_ability`, `character_goal`, `knowledge`, `affiliation` |
| `world` | 9 | `scene_time`, `containment`, `management`, `ownership`, `possession`, `placement`, `access`, `rule`, `world_state` |
| `event` | 1 | `event` |
| `relationship` | 1 | `relationship` |
| `narrative` | 1 | `thread` |

참조 타입(`refType`): `person` / `world`.
컬렉션 필드(`collection: true`, `profile: true`): appearance, background, personality, speech, habits,
abilities, knowledge — 각 항목이 독립적으로 유지된다.
`access`·`affiliation`도 컬렉션 규칙을 따른다.

### 4.5 시간적 성격 (`temporalRole`)

| 값 | 뜻 |
|---|---|
| `current_sequence` | 현재 시간축에서 실제로 발생 |
| `historical` | 과거 사실 설명 |
| `flashback` | 현재 장면 안의 회상 |
| `reported` | 누군가 전달한 주장 |
| `hypothetical` | 가정·계획·가능성 |
| `uncertain` | 진위 또는 시점 불명 |

영구 상태 갱신은 **`current_sequence` + `certainty: confirmed`** 사실만 허용한다.

### 4.6 정본 coverage 원칙

상태 파생에 필요한 변화를 정본 사실로 남겨야 한다: 이동 → location, 부상 → character_state,
소유권 이전 → ownership/possession, 관계 단절 → relationship, 규칙 무효화 → rule, 문제 해결 → thread.

작성자가 원문에서 누락을 발견해도 State Head를 독자 갱신하지 않는다. `canonical_coverage_gap` 진단을
만들고 정본 재생성 경로로 돌린다.

---

## 5. 상태 파생과 Current State Head

### 5.1 파생 경로

```text
artifact.stateBindings  (fact에 결속된 것만)
        │
        ▼
confirmed + current_sequence 사실만 대상
        │  컬렉션·access·affiliation은 개별 유지 (충돌 규칙 없음)
        ▼
비컬렉션 fact: [domain, subjectTempRef, targetTempRef, dimension, claimKind] 슬롯으로 그룹화
        │  evidenceSpan의 ref(t{n}-u|a) → 순서값 = n*2 + (a?1:0)
        │  가장 최근 근거를 가진 fact가 슬롯을 차지 (supersededFacts로 분리)
        ▼
Current State Head  (libra.continuity_state.v2)
        │  field-level canonical provenance 보존
        ▼
unifiedStateReadProjection(head)  → 다음 작성 호출의 읽기 전용 입력
```

### 5.2 필드 정책

- **overwrite-only** — 이력 누적 없음
- **보존** — 새 정본이 갱신하지 않은 필드는 그대로 유지. 누락 ≠ 삭제
- **provenance** — 각 필드는 그것을 만든 canonical fact를 가리킨다
- **no-op 억제 (구현 확인)** — 의미상 같은 값이면 provenance를 바꾸지 않는다.
  `changedThroughTurn`도 전진하지 않고, `reviewedThroughTurn`만 진행한다.

  | branch | 동등성 판정 | 보존·갱신 대상 | 근거 |
  |---|---|---|---|
  | scalar·컬렉션·relation (state 필드) | `statePipelineSemanticEqual(c.field, row.state[c.field], nextValue)` | 같으면 state·`fieldEvidence`·`fieldCorrectionProvenance`·`clearedFieldEvidence`·`clearedFieldCorrectionProvenance`를 **모두 두고** `continue` | LIBRA.js:44809 부근 |
  | **narrative (thread)** | thread **값 필드** signature — `id, title, summary, status, kind, interpretation` (근거는 **제외**) | 같으면 Head를 아예 건드리지 않고 `continue`. `kind`/`interpretation`만 바뀌어도 **실제 변경**으로 처리 | LIBRA.js:44765·44774 부근 |
  | event (chronology) | `memoryId:revision:tempFactId:epoch` id | 중복 삽입 방지 (no-op 억제 대상 아님 — append-only) | LIBRA.js:44820 부근 |

  **no-op 판정은 Head를 변경하기 전에 한다.** 서사 branch는 후보 배열(`nextThreads`)을 만들어
  signature를 비교한 뒤에만 `head.narrative.threads`에 쓴다 — `asArray`가 live 배열을 반환하므로
  "쓰고 나서 비교"하면 근거가 이미 덮인 뒤가 된다(실측 결함).

  **사용자 correction provenance도 같은 규칙을 따른다.** no-op은 `fieldCorrectionProvenance`를
  지우지 않고, 실제 변경·clear는 기존 정책대로 처리한다(LIBRA.js:44811–44812는 `continue` 뒤).

  회귀: `tests/libra_unified_noop_provenance_runtime_test.cjs` — 10 케이스
  (scalar no-op/변경/재반복 3, narrative no-op/변경/kind-only 3, 컬렉션 no-op/추가 2,
  relationship no-op 1, correction provenance no-op+변경 1)
- **실제 변경·clear** — 새 근거를 기록하고 `changedThroughTurn`을 전진시킨다. admission·revision
  검증을 그대로 통과해야 하므로 no-op 가드가 잘못된 근거를 영구 보존하는 우회가 되지 않는다
- **clear 제한** — 명시적 근거(상실·종료·무효화·정정)가 있을 때만

### 5.3 domainStatus

도메인별로 `{ status, throughTurn, reviewedThroughTurn, changedThroughTurn, reason, evidence }`을
기록한다. **내부 저장형과 읽기 투영형은 다르다.**

**내부 저장형** (`buildUnifiedStateCandidate`, LIBRA.js:44806~44808)의 실측 상태값은 **`ready` /
`not_updated`**다. `complete` / `partial` / `pending` / `not_required`가 아니다.

| 필드 | 뜻 |
|---|---|
| `status` | `ready` — 이 도메인이 이번 커밋에서 검토됨 / `not_updated` — `reason: 'unified_bindings_pending'`으로 보류됨 |
| `throughTurn` | 이 도메인이 반영한 마지막 턴 |
| `reviewedThroughTurn` | **검토**한 마지막 턴 (값이 안 바뀌어도 전진) |
| `changedThroughTurn` | **실제 값이 바뀐** 마지막 턴 (no-op이면 유지 — §5.2) |
| `reviewedThroughCanonical` / `changedThroughCanonical` | 같은 구분의 정본 커서 |
| `reason` | `integrated_evidence_checked` 등 |
| `evidence` / `attemptedEvidence` | 이 판정에 쓴 정본 근거 |

Head 전체의 `status`는 `domainPending.size ? 'partial' : 'ready'`다 (LIBRA.js:44813).

**읽기 투영형** (`unifiedStateReadProjection`, 45389)은 위를
`{status, throughTurn, reason}`으로 **축약**해 돌려준다 — `reviewedThroughTurn`·`changedThroughTurn`
커서는 소비자에게 전달되지 않는다.

### 5.4 읽기 투영 (`unifiedStateReadProjection`)

다음 작성 호출에 전달되는 형태로 변환한다:

- 내부 식별자(`id`, `scopeKey`, `artifactDigest`, `sourceDigest`, `hash`, `memoryId`, `revision`,
  `fieldEvidence`)를 제거한다
- `*Ref` 접미사를 제거하고 참조를 **이름으로 해석**한다
- `ce_` / `cs_rel_` 접두 문자열은 이름으로 치환, 미상이면 `'unknown'`
- `domainStatus`를 `{status, throughTurn, reason}`으로 축약한다

---

## 6. 커밋과 봉투

정본 write + readback이 끝나면 커밋 이벤트를 발행한다. 상태 파생은 **커밋 이후에만** 시작한다.

검증 없이 상태를 만들지 않는다. 불일치가 있으면 상태 갱신을 보류하고 정본은 유지한다 (fail-soft).

정본 replay 시에는 manifest ref의 존재만으로 충분하지 않다. 물리 storage key, archive ID,
memory ID, revision, turn range, source digest, artifact digest가 모두 일치해야 하며,
handoff·portable import·native chat-copy 영수증의 `archiveDigest`와도 일치해야 한다.

관련 스키마:

```text
libra.unified_lineage.v1               계보
libra.unified_migration.v1             이전 이식
libra.unified_retention_preview.v1     보존 미리보기
libra.unified_identity_merge.v1        정체성 병합
libra.unified_identity_split.v1        정체성 분리
libra.response_context.v1              응답 문맥 (읽기 전용)
libra.state_tracking_journal.v1        상태 추적 journal
libra.state_correction_store.v1        사용자 정정 저장소
libra.state_correction_patch.v2        정정 패치
libra.state_worldline_meta.v1          worldline 메타
libra.state_replay_cache.v1            재생 캐시
```

---

## 7. 사용자 정정

### 7.1 사실 정정

정본을 직접 편집한다. 편집은 exact-revision 사용자 동의(v2.3.27)를 요구하며,
정확한 5턴 구간 선택·재시도·cold start·candidate 재생성을 지원한다.

### 7.2 파생 해석 정정

State Head를 직접 고치지 않는다. 정정 이벤트를 저장하고(`libra.state_correction.v1`),
**정정 journal을 Head에 적용한다** — 정본 bytes는 건드리지 않는다.

```text
사용자 정정 저장 (libra.state_correction.v1 / _store.v1)
        │
        ▼
applyStateCorrectionsAtAnchor(head, store, anchorTurn, worldlineId, anchorRef)   LIBRA.js:59409
        │  correctionsForAnchor(store, anchorTurn, worldlineId, anchorRef)
        │  stateHeadHasCorrection(...) — 이미 적용된 정정은 건너뜀 (재적용 방지)
        ▼
finalizeUnifiedPendingState(corrected.head)                                      LIBRA.js:45208 (replay)
        │
        ▼
Head 갱신 + appliedCorrections 누적
```

**정본 bytes 보존을 검증하는 회귀가 있다.** 사용자 정본 편집(§7.1)과 파생 상태 정정(§7.2)은 별개
경로이므로, 파생 정정으로 정본이 수정됐다고 보고하지 않는다.

### 7.3 사용자 작성 정본의 필수 상태 처분

채택 전에 `maintained_by_user` 또는 `sparse_correction` 처분을 **반드시 저장**하고,
채택된 새 정본 basis에 다시 결속한다. post-adoption target-basis 영수증과 보정 replay를 남긴다.

### 7.4 과거 정본 편집의 정확한 시점 Head

과거 revision을 편집하면 그 시점 이후 상태를 재생성한다. 재생성 입력은
검증된 이식 artifact·evidence와 description·Persona 평가 문맥이다.

---

## 8. SGA 응답 파이프라인

기억 파이프라인과 **별개**다. 같은 턴의 응답 초안을 개선한다.

### 8.1 스테이지

```text
sga_shadow
  → sga_character_aide
  → sga_world_aide
  → sga_plot_aide
  → sga_length_correction
```

주입 마커: `[LIBRA SGA DRAFT — CURRENT TURN ONLY]`

### 8.2 응답 patch 계약

- 스키마 `libra.sga_patch.v3`, 필수: `schema`, `stage`, `ok`, `analysis`,
  `continuity_locks`, `user_agency_locks`, `do_not_reveal`, `edits`, `binding`, `edit_links`
- binding: `libra.sga_edit_binding.v1` — `{schema, token}`. token은 요청 basis의 것과 정확히 일치해야 한다
- edit_links: 편집마다 **정확히 하나**. `editIndex` 중복 불가, `domain`은 basis의 domain과 일치,
  `entityRefs`/`evidenceRefs`/`constraintRefs`의 모든 id는 basis에 **실재**해야 한다
- `evidenceRefs`는 비어 있을 수 없다
- immutable 제약은 `preserve` 외 연산 불가
- 내부 식별자 누출(`consumerInternalIdLeak`) 시 거부

```text
normalizeBoundSgaPatch(stageId, raw, basis) → null 이면 거부
bindingValidation = { structural, referential, declaredConstraintEffects,
                      naturalLanguageMeaning: 'not_certified' }
```

### 8.3 적용과 수용

```text
applied  = applyDraftPatchOperations(prompts.document, patch.edits)
accepted = isAcceptedAidePatchApplication(patch, applied) && isCompleteDraftText(applied.draft)
changed  = accepted && stableDraftHash(nextDraft) !== stableDraftHash(draft)
safeNoop = patch && accepted && isSafeAidePatchNoop(patch, applied)
```

`applyDraftPatchOperations`는 **문서 객체**를 받는다. 문자열을 주면 새로 분할해
블록 id·hash를 잃는다.

skip 사유: `target_not_found` / `target_hash_mismatch` / `replacement_unchanged` /
`duplicate_existing_block`. 마지막 둘만 수용 가능한 skip이다.

드래프트 문서: `libra_draft_patch_document_v1` — `prefix` + `blocks[{id, hash, text, separatorAfter}]`.
프롬프트 렌더링은 마커당 `\n` + 본문 + `\n` 조인이다.

### 8.4 부속 계약

```text
libra.sga_shadow.v2                       그림자 분석
libra.sga_private_analysis.v2             비공개 분석 — **모델 입력에는 붙는다** (§8.5)
libra.sga_response_engine.v2              응답 엔진
libra.sga_length_correction.v2            길이 교정
libra.sga_run.v2                          실행 기록
libra.sga_runtime_algorithm.v4            런타임 알고리즘
libra.sga_same_turn_finalization.v1       동일 턴 확정 커널
libra.sga_user_agency_ledger.v1           사용자 주체성 원장
libra.sga_commitment_guard.v1             약속 보호
libra.sga.material_usage.v1               재료 사용 manifest
libra.sga_draft_checkpoint.v1             드래프트 체크포인트
libra.sga_prompt_profile.v1               프롬프트 프로파일
libra.sga_narrative_dynamics.v1           내러티브 동학
libra.sga_dynamic_skill_router.v1         동적 스킬 라우터
libra.sga_skill_compiler.v1               스킬 컴파일러
libra.sga_prompt_spec_compiler.v1         프롬프트 스펙 컴파일러
libra.sga_curated_skills.v1               큐레이션 스킬 라이브러리
libra.sga_shared_authority.v1             공유 권위 (basis의 부모)
libra.sga_protected_analysis_transfer.v1  보호 분석 전달
libra.prompt_runtime_lock.v1              프롬프트 런타임 잠금
```

### 8.5 비공개 분석은 모델 입력에 붙는다

`attachSgaPrivateAnalysisToPrompts(prompts, analysis)` (LIBRA.js:53609)는 stage의 **user prompt에
분석 JSON을 붙인다.** 호출 위치는 `54188`(shadow)과 `54428`(AIDE)이다.

블록 표식: `[BOUNDED PRIVATE ANALYSIS — ADVISORY, NEVER EXPOSE]`

**"사용자에게 숨긴다"와 "모델 입력에서 제외한다"는 다르다.**

| 층 | 실제 |
|---|---|
| 모델 입력 | **포함**된다. stage user prompt 뒤에 붙는다 |
| 사용자 가시 응답 | 노출되지 않는다 (표식이 "NEVER EXPOSE") |
| 최종 전달 | accepted heavyweight 분석은 최종 transfer에도 들어갈 수 있다 |

따라서 "비공개"를 "프롬프트에 안 들어감"으로 읽지 않는다. 이 분석은 **advisory**이며 evidence
계약이 그것을 상위한다.

### 8.6 SGA guard의 자원 수명

`createSgaRunGuard` (LIBRA.js:51888)는 다음을 소유한다.

| 자원 | 생성 시점 | 해제 |
|---|---|---|
| `controller` + 180초 deadline timer | guard 생성 직후 (`51914`) — `sgaRunTimeoutMs` 30,000~300,000, 기본 180,000 | `releaseSgaRunGuardResources` / 정상 종료 / 취소 |
| `consumerOperation` | `createConsumerOperation` 성공 시 (`51925`) | `externalCleanup` |
| 예산·토큰 한도 | guard 생성 시 | 자원 아님 |

**생성 실패 경로**: `createConsumerOperation`은 미완료 host 요청이 있으면
`CONSUMER_HOST_REQUEST_STILL_PENDING`으로 **자기 자원을 만들기 전에** throw한다. 이때 deadline timer는
이미 armed 상태이므로 guard가 스스로 해제한 뒤 예외를 전파한다. 그렇지 않으면 거부된 요청마다
180초 타이머가 하나씩 남는다.

호출자(`runSgaPipeline`)는 guard를 **try/finally 밖에서** 만든다(`54134` 대 `54137`). 따라서 정리는
guard 내부에서 해야 한다 — 호출자에게 반환되지 않는 실패 경로에서는 호출자가 정리할 수 없다.

**pending-host gate는 계약이다.** 중복 호출을 허용하거나 gate를 제거해서 자원 문제를 해결하지 않는다.
성공·취소·deadline·생성 실패의 정리 경로를 구분한다.

회귀: `tests/libra_sga_guard_timer_release_runtime_test.cjs`

---

## 9. 소비자

권위 사슬의 끝에서 State Head를 읽는 컴포넌트다. **누구도 상태를 쓰지 않는다.**

### 9.1 Recall (회상)

정본에서 근거를 검색해 프롬프트에 넣는다. 검색 기법은 §11 참조.
Input Writer recall은 **request-local read-only**로 동작한다. 실제 옵션명은 두 층이다:

| 위치 | 옵션 | 값 |
|---|---|---|
| 호출부 (LIBRA.js:50681) | `queryBundle.persistRecallCatalog` | `false` |
| catalog 로더 (LIBRA.js:49299) | `loadOrRefreshRecallCatalog(..., { persist: persistRecallCatalog })` | 위 값이 전달됨 |

즉 호출자가 넘기는 이름은 `persistRecallCatalog`이고, catalog에 내려가는 이름은 `persist`다.
이 경로로 catalog 저장과 legacy background upgrade가 모두 막힌다.

### 9.2 Planner

State Head + Live Tail을 읽어 다음 반응을 계획한다. 계획은 상태를 만들지 않는다.

### 9.3 GRADIA

초안 작성 파이프라인. LIBRA와 같은 기억·상태 화면을 공유하되 **작성 설정만** 다르다.

### 9.4 Input Writer

Narrative Direction을 preflight에서 한 번만 읽어 delivery snapshot에 봉인한다.
성공한 3-choice 재생성만 active run/snapshot으로 채택하고, picker가 선택 run의 snapshot을 소유한다.
전달 경계: send capability/readback basis preflight → snapshot 재검증 →
물리 `sendChat()` 호출 직후에만 pending receipt 생성.

### 9.5 Evidence Link Index (증거 연결 색인) — Stage 1

정본 사실·scope entity registry·State Head를 **읽어서** 투영한 읽기 전용 색인이다.
소비자는 아직 없다(Stage 1). 목적은 회상 점수에 개입하는 것이 아니라, 어떤 사실이 어느
기억·근거에 결속되어 있는지를 재계산 없이 조회할 수 있게 하는 것이다.

| 항목 | 값 |
|---|---|
| schema | `libra.evidence_link_index.v1` |
| buildVersion | `readonly_projection_v1` |
| 저장 키 | `libra:v1:scope:<scopeKey>:evidence-link-index:v1` |
| 진입점 | `LibraMemoryCore.getEvidenceLinkIndex()` / `__LIBRA__.getEvidenceLinkIndex()` |
| opt-in | `//@arg evidence_link_index_enabled` (`true`일 때만 build·저장·timer) |
| 진단 | `Runtime.lastEvidenceLinkIndexDiagnostics` |
| 한도 | `EVIDENCE_LINK_INDEX_MEMORY_LIMIT` 512 기억, `EVIDENCE_LINK_INDEX_FACT_LIMIT` 20,000 fact |
| 갱신 | 커밋 후 `scheduleEvidenceLinkIndexUpgrade` (지연 30초, recall catalog와 동일 패턴) |

**현재와 역사를 분리한다.** 역사는 정본 사실에서만 만든다. 현재 view는 Head의 `fieldEvidence`를
**인용**할 뿐 재계산하지 않는다. Head는 정본으로 승격되지 않는다(§14.6·§14.7).

**식별자 층.** artifact `tempId`(정본 내부) / registry `ce_*`(해석 결과) / 소비자 `actor_1`
(프롬프트 노출) 중 색인은 `ce_*`와 `factKey`만 담는다. 해석은 `buildUnifiedStateCandidate`와
같은 규칙을 **읽기 전용으로** 따른다: override → `splitRetiredNames` → type+nameKey 일치 →
`matches.length>1` 또는 `mergedIds` 없는 id 재사용은 거부 → 없으면
`ce_${type}_${stableHash(...)}` 파생. 영속 registry는 절대 변경하지 않는다.
현재 확정 사실이 참조하지 않는 entity에는 ID를 발급하지 않고 `not_currently_referenced`로 남긴다.

**금지 추론.** clique, 전이적 친구 관계, `dependsOn`을 인과로 해석, 동명 병합, 정본/lore 본문이나
vector payload 복사, 무제한 dependency 폐포, 역사 fact를 현재 관계로 승격 — 모두 이 색인의
비대상이다. 값이 같은 이전 fact는 provenance를 바꾸지 않는다(§14.14). `dependsOn`은 값이
아니라 필드로만 남는다.

**실패 정책.** 파생·재생성 가능하므로 fail-open이다. 저장 실패는 build 결과를 그대로 반환하고
`status.persisted=false`·`partial=true`·reason `persist_failed`로 알린다. 읽을 수 없는 기억은
`memory_unavailable`로 표시하고 나머지를 계속 색인하며 `totalMemoryCount`에는 계속 센다.
부분 색인은 조용히 잘리지 않고 `memory_limit` reason과 `partial`로 드러난다.

---

## 10. GUI

### 10.1 한 흐름, 분리된 실행 기록

`기억 → 인물 → 관계 → 세계 → 내러티브`를 하나의 읽기 흐름으로 보여 주되,
내부 실행 기록은 **기억 / 상태 / 초안**으로 분리한다.

### 10.2 페이지 (`BOOK_SIDEBAR_PAGE_REGISTRY`)

| id | 라벨 | note |
|---|---|---|
| `desk` | 현재 열람대 | 이번 턴 · 리콜 · 작성 결과 |
| `memory` | 기억 서가 | 정본 장기기억 · 누적 역사 |
| `people` | 인물 카드함 | 월드 매니저 · 현재 상태 |
| `world` | 세계 도감 | 월드 매니저 · 현재 상태 |
| `story` | 서사 연감 | 월드 매니저 · 현재 내러티브 |
| `writing` | 작성실 | 응답 · 인풋 · 서사 방향 |
| `settings` | 설정 | 연결 · 기억 · 저장 |

섹션: `people=[profile, characters, relationships]`, `story=[toc, direction, structure, evidence]`,
`world=[guide, details]`, `settings=[settings, pipeline, agents, custom, logs]`,
`writing quick=[response, input_writer, memory_agents]`,
`GRADIA draft=[quick, stages, skills, output, results]`, `LIBRA draft=[mode, direction, results]`

### 10.3 상태 표시

표시 전용이다. GUI는 상태를 쓰지 않는다.
`complete`/`partial`/`pending`/`not_required`를 권위 상태와 분리해 보여준다.

---

## 11. 설정

### 11.1 기억 작성

preset·provider·turn window·batch 크기·generation policy·출력 예산.

### 11.2 상태 파생

별도 설정 없음 — 작성자 응답의 `stateBindings`가 유일한 경로다.
정정·재생성 정책만 `stateTrackingMode`로 노출된다.

### 11.3 리콜 — 선언값과 프리셋 유효값은 다르다

`DEFAULT_SETTINGS`는 **선언값**이고, `performancePreset`이 그 위에 **유효값**을 덮는다. 둘을 구분하지
않으면 잘못된 기본값을 인용하게 된다.

프리셋 식별자는 `light` / `balanced` / `heavy` / **`maximum`**이다.

`DEFAULT_SETTINGS`는 `recallMaxChars`를 **리터럴이 아니라 참조**로 선언한다
(LIBRA.js:31355 `PERFORMANCE_PRESETS.balanced.recallMaxChars`)이므로 선언값과 `balanced` 유효값이
**같다**.

| 키 | `light` | `balanced` (= `DEFAULT_SETTINGS` 선언값) | `heavy` |
|---|---|---|---|
| `recallMaxMemories` | 6 | **12** | 20 |
| `candidateLimit` | 40 | **80** | 160 |
| `gateHighCosine` | 0.50 | **0.42** | 0.35 |
| `gateSparse` | 0.18 | **0.12** | 0.08 |
| `recallMaxChars` | 3,000 | **5,000** | 8,000 |
| `excerptSentenceWindow` | 2 | 3 | 4 |
| `maxSectionsPerMemory` | 3 | 4 | 5 |
| `maxSpansPerSection` | 3 | 4 | 6 |
| `semanticSpanScoreFloorRatio` | 0.34 | 0.28 | 0.22 |

### 11.3.1 서로 다른 세 가지 한도

혼동하기 쉬운 세 값을 분리한다.

| 이름 | 값 | 뜻 |
|---|---|---|
| `balanced.recallMaxChars` | **5,000** | `balanced` 프리셋의 리콜 문자 예산 |
| `RECALL_MAX_DYNAMIC_CHARS` | **12,000** (LIBRA.js:31255) | 동적 리콜이 도달할 수 있는 **최대치** |
| `DEFAULT_RESPONSE_LORE_MAX_CHARS` | **12,000** (1627) | **별도 lore 설정**의 기본값 |
| `MAX_RESPONSE_LORE_CHARS` | **24,000** (1629) | 그 lore 설정의 **상한** |
| `MIN_RESPONSE_LORE_CHARS` | 2,400 (1628) | 그 lore 설정의 하한 |

`3,000`은 **`light` 프리셋**의 값이며 `balanced` 기본값이 아니다.

`DEFAULT_SETTINGS` 전체 39키:

```text
recallMaxMemories, recallMaxChars, recallQueryMessages, recallSimilarityWeight, recallRecencyWeight,
recallDynamicBudgetVersion, continuationTailMessages,
candidateLimit, rrfK(52), evidenceGate, gateHighCosine, gateExactAnchor(0.14), gateSparse,
mmrEnabled, mmrLambda(0.72), lexicalFallback, sectionVectors,
excerptSentenceWindow, semanticSpanScoreFloorRatio, maxSectionsPerMemory, maxSpansPerSection,
forceCurrentScene, storyArc*×7, auto*×4, runDetailRetention, runReceiptRetention, internalLanguage
```

**이 표는 `balanced`의 9개 키만 확인한 것이다.** 나머지 키의 프리셋별 최종 유효값은 이번 검수가
확인하지 않았다.

### 11.4 레거시 키

`two_call_ito`, `turn_window`, `max_recent_chars`, `stage_timeout_ms`, `shadow_include_risu_context`,
`shadow_risu_context_max_chars`는 **레거시 스테이지 런타임 키**다
(`LEGACY_STAGE_RUNTIME_KEYS`). 퇴역 스테이지의 이름과 함께 남아 있다.

### 11.5 실행 기록

`runDetailRetention`, `runReceiptRetention`으로 보존량을 제한한다.
스테이지 추적은 `Runtime.stageTrace`에 기록된다.
evidence link index의 마지막 build 진단은 `Runtime.lastEvidenceLinkIndexDiagnostics`에 남는다(§9.5).
이 값은 **읽기 전용 진단**이며 회상·프롬프트·상태에 쓰이지 않는다.

---

## 12. 보안과 신뢰 경계

- 모델은 안정 ID를 소유하지 않는다 — `assertionId`, `entity.id`는 런타임이 digest로 생성한다
- evidence quote는 exact source와 `sourceHash`/`quoteHash`로 기계적 결속한다
- 내부 식별자가 출력으로 누출되면 거부한다 (`consumerInternalIdLeak`)
- SGA patch는 binding token 없이는 수용되지 않는다
- handoff·portable import·native chat-copy는 영수증의 transfer/import ID까지 확인한다
- `getRuntime()`은 `redactPublicSecrets`를 거쳐 반환된다
- `prompt_runtime_lock.v1`이 프롬프트 계약의 우선순위를 고정한다

---

## 13. 실패 정책

| 상황 | 동작 |
|---|---|
| **작성자(librarian) 실패** | **throw (fail-hard)** — `optionalFailures`로 흡수하지 않는다 (§3.6) |
| artifact schema 불일치 | 검증 중단, 정본 미커밋 |
| 근거 없는 레코드 | 격리 + `record_admission.v1`에 기록 |
| `stateBindings` 계약 불일치 | `stateBindingIssues`에 `state_binding_pending:<id>` 기록. **유효 fact면 재파생되어 상태는 반영될 수 있다** (§1.3.1) |
| 상태 fact를 **제공하지 않음** | `pending[]`은 비고 `headStatus`는 그대로. **보류가 아니라 보존** — 기존 필드는 일반 보존 계약을 따른다 (§1.3.1) |
| 무효 record로 **admission 격리** | `stateBlocks`에 `memory_record_quarantined` 기록, 나머지 fact는 저장 (**미제공과 다른 경로**) |
| 유효 fact가 **0건** | canonical 자체가 저장되지 않는 **작성 실패** (아래 '작성자 실패' 행과 구분: 격리 0건은 커밋 실패로 이어진다) |
| dependency·conflict로 인한 **실제 보류** | `pending[]`에 사유 기록 — **진짜 보류** |
| 정본 저장 이후 상태 파생 실패 | 정본 커밋 유지 (fail-soft). 다른 도메인 성공도 취소하지 않음 |
| 퇴역 스테이지 요청 | `LEGACY_ANALYZER_RETIRED` fail-closed |
| 출력 캡 95%↑ | `output_cap_pressure.v1` 진단 |
| SGA binding 불일치 | patch 거부, 드래프트 유지 |
| **SGA guard 생성 실패** | deadline timer를 해제하고 예외를 그대로 전파. pending-host gate는 유지 (§8.6) |
| SGA 중복 요청 | `CONSUMER_HOST_REQUEST_STILL_PENDING`으로 거부. provider 제출 0회 추가 |

---

## 14. 불변문

1. 역사적 사실을 누적하는 정본은 **Canonical Memory 하나**다.
2. 기억 작성자의 **논리 stage는 `librarian` 하나**다. 물리 호출은 기본 1회이며, 출력 잘림과 예산
   조건에서 `extraCalls`로 1회 추가될 수 있다. 논리 stage·물리 호출·재시도 job을 같은 층으로 세지 않는다.
3. 상태는 **별도 LLM 없이** 작성자 응답의 `stateBindings`가 사실에 결속되어 파생된다.
4. Character·Relationship·World·Narrative 상태는 이력이 아니라 **최신값 읽기 모델**이다.
5. 상태 필드 누락은 **보존**이며 삭제가 아니다.
6. 권위는 `Canonical → State Head` **단방향**이다.
7. State Head 값은 **새 사실의 evidence가 될 수 없다.**
8. 정본 **작성** 실패는 fail-hard다. 정본 **저장 이후**의 상태 파생 실패만 정본 커밋을 취소하지 않는다.
9. `clear`는 명시적 근거가 있을 때만 허용한다.
10. 퇴역 스테이지는 **fail-closed**로 거부되고, 기존 기록은 보존된다.
11. 내러티브 상태는 다음 장면 초안이나 미래 계획을 만들지 않는다.
12. 사용자 작성 정본은 채택 전에 상태 처분을 저장하고 새 basis에 결속한다.
13. 이전 State Head는 **읽기 전용 입력**이며, 누락·보류 구간은 미지이지 빈 사실이 아니다.
14. **의미상 같은 값은 provenance를 바꾸지 않는다.** scalar·컬렉션·relation·narrative thread에
   적용된다. reviewed frontier만 진행하고, 실제 변경·clear만 새 근거를 쓴다. event(chronology)는
   append-only이므로 이 규칙의 대상이 아니다.
15. **실패한 구성은 스스로 자원을 해제한다.** guard 생성 중 예외가 나도 이미 만든 타이머를 남기지 않는다.
16. **진단 이름은 실제 상태가 아니다.** `state_binding_pending`은 "미반영"을 뜻하지 않는다.
17. **Evidence Link Index는 파생·재생성 가능한 읽기 전용 투영이다.** 회상 점수·패킹에 참여하지
    않고, 정본·State Head·영속 registry를 쓰지 않으며, 실패하면 기본 경로를 그대로 둔다(fail-open).
    역사는 정본 fact에서만 만들고 현재 view는 Head를 **인용**할 뿐이며, Head는 정본으로 승격되지 않는다.
