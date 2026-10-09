# LIBRA 정본 기억 · 최신 상태 추적 통합 아키텍처

> ## ⛔ 퇴역 (SUPERSEDED) — 2026-09-21
>
> **이 문서는 LIBRA 2.3.141에서 유효하지 않습니다. 역사적 기록으로만 보존합니다.**
>
> 이 문서는 2.3.1 구현 동기화본이며, 아래 구조는 2.3.36~2.3.141 사이에 **퇴역**했습니다.
>
> | 이 문서가 기술한 것 | 2.3.141 실제 |
> |---|---|
> | §4.1 기억 작성자 4개 (Memory Ariadne → Character ito → World ito → Narrative ito) | **작성자 1개** `librarian` (`STAGE_ORDER = ['librarian']`) |
> | §4.2 상태 추적이 LLM을 호출해 상태를 새로 작성 (4 Observer + 4 Verifier route) | **별도 LLM 호출 0회.** 작성자 응답의 `stateBindings`가 사실(fact)에 결속되어 상태가 파생됨 |
> | §5.1 `libra.canonical_artifact.v3` | `libra.canonical_artifact.v4` (`schema` + `entities` + `facts` + `stateBindings`) |
> | §7.1 ~ §11 Entity Admission decision/receipt + Observer/Verifier | `RETIRED_MEMORY_STAGE_IDS`에 포함 — `LEGACY_ANALYZER_RETIRED` |
>
> 퇴역 목록 (코드 `RETIRED_MEMORY_STAGE_IDS`):
> `ariadne`, `character_ito`, `world_ito`, `plot_ito`, `state_entity_admission`,
> `state_character_observer`, `state_relationship_observer`, `state_world_observer`, `state_narrative_observer`,
> `state_character_verifier`, `state_relationship_verifier`, `state_world_verifier`, `state_narrative_verifier`
>
> **현행 계약**: `LIBRA_Unified_Architecture_v2_20260921.md`
> 이 문서의 §0(문서 지위)·§2(권위 모델)·§3(교체 경계)의 **원칙**은 여전히 유효하며, 현행 문서가 그대로 계승합니다.

## 기억 작성 파이프라인과 상태 추적 멀티 파이프라인의 분리 및 연결 구현 계약

- 문서 상태: LIBRA 2.3.1 구현 동기화본
- 기준 구현: `PROGRAM/plugins/LIBRA.js` 2.3.1
- 작성일: 2026-09-01
- 대상: LIBRA/GRADIA 공통 Canonical Memory, World Manager, Current State Head와 LIBRA 설정 GUI
- 비대상: GRADIA 초안 작성 파이프라인 자체의 내부 알고리즘 변경

---

## 0. 문서의 지위

이 문서는 LIBRA 2.3.1에 반영된 다음 결정을 하나의 구현 계약으로 통합한다.

1. Canonical Memory만 역사적 사실을 누적하는 정본이다.
2. Character, Relationship, World, Narrative는 과거 이력을 누적하는 별도 기억 시스템이 아니라 최신 상태를 물질화한 읽기 모델이다.
3. 상태에 존재하지만 새 정본에서 갱신되지 않은 필드는 그대로 보존한다.
4. 필드 누락은 보존이며 삭제가 아니다.
5. `clear`는 명시적인 상실, 종료, 무효화, 정정 근거가 있을 때만 허용한다.
6. 기억 작성 파이프라인과 상태 추적 파이프라인은 LLM 호출, 프롬프트, preset, cache, receipt, 실패 경계를 분리한다.
7. 상태 추적은 영구 커밋된 정본만 입력 권위로 사용한다.
8. 상태 추적 실패는 정본 커밋을 취소하지 않으며, 다른 상태 도메인의 성공도 막지 않는다.
9. State Head는 정본의 경쟁자가 아니라 정본에서 파생된 최신값 읽기 모델이다.
10. 내러티브 상태는 다음 장면 초안이나 미래 계획을 만들지 않는다. 초안 작성은 Planner와 GRADIA가 담당한다.
11. 새 인물은 일반 상태 관찰과 분리된 Entity Admission 결정과 내구 영수증이 승인한 assertion만 Registry에 들어간다.
12. 사용자 작성 정본은 채택 전에 `maintained_by_user` 또는 `sparse_correction` 상태 처분을 반드시 저장하고, 채택된 새 정본 basis에 다시 결속한다.
13. 상태 재구축이 `partial` 또는 `pending`이면 기존 last-known만 남고 새 Head는 권위를 얻지 않는다.

이 문서는 다음 기존 설계의 상충 부분을 대체한다.

- `LIBRA_World_Manager_Narrative_Design_20260830.md`
- `LIBRA_World_Manager_Narrative_Implementation_Plan_20260830.md`

특히 다음 기존 판단은 LIBRA 2.3.1의 구현 계약이 아니다.

- 추가 LLM 호출 0회를 위해 기억 ito가 상태 패치를 겸하는 구조
- Ariadne artifact 안에서 Current State patch를 직접 작성하는 구조
- Plot ito가 기억 편집과 Narrative State patch를 한 응답에서 함께 생성하는 구조
- Character ito 하나가 인물과 관계 상태 추적을 함께 소유하는 구조

기존 문서는 구현 이력과 마이그레이션 참고 자료로 보존한다. 삭제하거나 소급 수정하지 않는다.

### 0.1 LIBRA 2.3.1 구현 상태와 검증 경계

LIBRA 2.3.1 소스에는 이 문서의 핵심 경계가 다음 계약으로 반영되어 있다.

- 누적 정본 출력: `libra.canonical_artifact.v3`
- 커밋 뒤 상태 실행 권위: `libra.canonical_commit.v1`
- 상태 관찰 출력: `libra.state_observation.v2`
- 최신값 읽기 모델: Current State Head v2 (`libra.continuity_state.v2`)
- 검증된 인물·별칭·관계 endpoint 경계: Entity Registry v2
- 신규 인물 독립 승인: `libra.entity_admission_decision.v1` + `libra.entity_admission_receipt.v1`
- 네 상태 도메인별 Observer와 조건부 Verifier
- candidate에는 상태를 만들지 않고, 채택되어 활성 정본이 된 뒤에만 상태 추적을 예약하는 경계
- 상태 실패가 성공한 정본 커밋과 다른 도메인의 성공을 되돌리지 않는 fail-open 경계
- 수동 정본 편집의 job-local 상태 처분과 post-adoption target-basis 영수증/보정 replay
- archive ID뿐 아니라 archive digest와 정확한 물리 member/transfer route까지 확인하는 replay 경계
- `complete`, `partial`, `pending`, `not_required`를 권위 상태와 분리하여 표시하는 이동·재구축 영수증
- scheduling 전 내구 State tracking journal, startup resume와 provider fan-out 뒤 두 번째 Canonical envelope 검증으로 구성한 Gate W reload 경계
- Input Writer recall 전체에 request-local read-only와 `persistCatalog: false`를 전달하여 catalog 저장과 legacy background upgrade를 모두 막는 경계
- Narrative Direction을 preflight에서 한 번만 읽어 delivery snapshot에 봉인하고, 성공한 3-choice 재생성만 active run/snapshot으로 채택하며 picker가 선택 run의 snapshot을 소유하는 경계
- send capability/readback basis preflight 뒤 snapshot을 마지막으로 재검증하고 물리 `sendChat()` 호출 직후에만 pending receipt를 만드는 Input Writer 전달 경계

GUI도 `기억 → 인물 → 관계 → 세계 → 내러티브`를 하나의 읽기 흐름으로 보여 주되 내부 실행 기록은 기억·상태·초안으로 분리한다. LIBRA와 GRADIA는 같은 기억과 최신 상태 화면을 사용하고, `파이프라인`의 응답/초안 작성 영역에서만 서로 다른 작성 설정을 제공한다.

이 문서의 “구현됨”은 소스 계약이 존재한다는 뜻이다. 배포 판정은 별도의 구문 검사, 계약 회귀, 전체 회귀, manifest/checksum/layout 검증으로 확정하며 실제 RisuAI GUI 클릭, 실제 provider 호출과 비용·지연 특성은 라이브 검증 결과와 구분한다.

---

## 1. 핵심 정의

### 1.1 Canonical Memory

5개의 완료된 U+A 턴을 근거로 작성하고 영구 커밋하는 역사적 정본이다.

Canonical Memory가 답하는 질문:

> 실제로 무슨 일이 있었고, 무엇이 확정되었으며, 무엇이 아직 불확실한가?

Canonical Memory에 포함되는 것:

- 시간순 사건
- 사용자와 등장인물의 행동 주체
- 발언과 선택
- 인물에 관해 새로 확정된 사실
- 관계를 보여 주는 직접 근거
- 세계, 장소, 사물, 조직, 규칙의 변화
- 실제로 열린 문제와 실제로 해결된 문제
- 불확실성
- exact evidence reference와 source quote
- 회상용 검색 표면

Canonical Memory에 포함하지 않는 것:

- State Head를 덮어쓰는 명령
- `set` 또는 `clear` 상태 mutation
- 미래 장면 계획
- 아직 일어나지 않은 사용자 행동
- 추적 편의를 위한 관계 수치 누적
- 별도의 상태 이력

### 1.2 Current State Head v2 (`libra.continuity_state.v2`)

활성 정본 체인으로부터 계산한 최신 상태의 materialized view다.

Current State Head가 답하는 질문:

> 지금 마지막으로 확정되거나 마지막으로 알려진 값은 무엇인가?

State Head의 속성:

- scope별 하나
- overwrite-only
- 기억 검색의 정본이 아님
- 별도 사건 timeline이 없음
- 별도 vector가 없음
- 필드별 canonical provenance를 가짐
- 언제든 활성 Canonical Memory 체인에서 재구축 가능

### 1.3 State Observation

새로 커밋된 Canonical Memory와 이전 Head를 비교하여 만든 도메인별 검토 결과다.

State Observation은 다음 두 결과를 분리한다.

- `reviews`: 검토했는지와 변화가 없었는지
- `patches`: 실제로 바뀐 필드만 포함한 희소 변경 후보

### 1.4 Entity Registry v2 (`libra.entity_registry.v2`)

Canonical Memory에 등장한 인물과 세계 엔티티의 안정 ID, 이름, 별칭, 유형을 관리하는 파생 인덱스다.

Entity Registry도 Canonical Memory를 대체하지 않는다. Canonical Memory에서 다시 만들 수 있어야 한다.

### 1.5 Live Tail

마지막 5턴 정본 경계 이후의 완료된 U+A를 요청 단위로만 제공하는 비영구 최신 문맥이다.

Live Tail은 Planner와 GRADIA에서 State Head보다 최신인 overlay로 사용할 수 있지만 State Head에 직접 저장하지 않는다.

---

## 2. 권위 모델

### 2.1 단방향 권위

```text
Exact completed U+A
        │
        ▼
Canonical Memory pipeline
        │ durable commit + readback
        ▼
Canonical Memory
        │ immutable commit envelope
        ▼
State Tracking multi-pipeline
        │ validated sparse patches
        ▼
Current State Head
        │
        ├── Planner
        ├── GRADIA
        ├── Input Writer
        └── LIBRA GUI
```

권위는 `Canonical Memory → State Head` 방향으로만 흐른다.

State Head가 다음 Canonical Memory 작성에 제공될 수 있는 경우에도 역할은 다음으로 제한한다.

- 동명이인 구분
- 기존 안정 ID 확인
- 기존 최신값과 새 evidence의 비교 보조
- 과거 정본 provenance로 이동하기 위한 index

State Head 자체의 값은 새 사건이나 새 사실의 evidence가 될 수 없다.

### 2.2 사실과 파생 해석의 구분

```text
Canonical assertion:
"세아는 왕궁 서쪽 회랑으로 이동했다."

Derived state patch:
character:세아.location = "왕궁 서쪽 회랑"
```

앞 문장은 역사적 사실이다. 뒤 문장은 그 사실을 최신 상태 필드에 반영하는 파생 해석이다.

파생 해석이 잘못되어도 정본 문장은 자동으로 고쳐지지 않는다. 반대로 정본이 revision되면 파생 상태는 재생성되어야 한다.

### 2.3 우선순위

상태 채택 시 우선순위는 다음과 같다.

1. 활성 worldline의 명시적 사용자 정정 또는 선택된 canonical revision
2. 더 새로운 committed Canonical Memory assertion
3. 같은 정본 안의 직접적이고 명확한 assertion
4. 허용된 범위의 보수적 파생 해석
5. 이전 State Head의 last-known 값

모델의 자유 추론, 일반 상식, lore의 단순 언급, 이전 Head 값만으로는 새 상태를 만들 수 없다.

---

## 3. 2.2.13 기준선 진단과 2.3.0 교체 경계

### 3.1 유지할 기반

LIBRA 2.2.13 기준선에서 다음 기반은 2.3.0에도 유지한다.

- exact source quote와 evidence ref의 기계적 binding
- canonical artifact validation
- source digest와 revision binding
- candidate와 committed canonical memory의 구분
- canonical commit readback
- State Head의 overwrite-only 성격
- field-level canonical provenance
- worldline fingerprint
- reroll, rollback, copy, handoff 후 재생성
- State Correction Journal replay
- 상태 실패가 정본을 되돌리지 않는 fail-soft commit 경계

### 3.2 제거할 결합

2.3.0에서 다음 2.2.13 결합을 제거한다.

1. `canonical_artifact.v2.state`
   - Ariadne가 정본 내용과 상태 patch를 동시에 작성한다.
2. 기억 Character ito의 `state_patch`
   - 기억 편집과 인물·관계 상태 추적이 같은 호출에 있다.
3. 기억 World ito의 `state_patch`
   - 기억 편집과 세계 상태 추적이 같은 호출에 있다.
4. 기억 Plot ito의 `narrative_patch`
   - 기억 편집과 Narrative Head 갱신이 같은 호출에 있다.
5. `character_relationship` 결합 도메인
   - 인물과 관계가 함께 성공하거나 함께 실패한다.
6. candidate 정본 단계에서 영구 continuity delta를 먼저 생성하는 순서
   - 상태 sidecar는 committed 정본 이벤트 이후에 생성해야 한다.

### 3.3 2.3.0에서 함께 보강한 문제

- 같은 값을 다시 출력해도 `appliedFields`로 처리되고 provenance가 새것으로 교체되는 문제
- 관계 endpoint 이름만으로 placeholder 인물을 만드는 문제
- 모델의 빈 전체 `clear`가 인물과 연결 관계를 삭제할 수 있는 문제
- Narrative patch가 실질적 no-op이어도 revision과 `updatedThroughTurn`을 올리는 문제
- resolved arc, turning point 등이 Current State Head에 누적되어 두 번째 역사처럼 되는 문제
- `reviewedThrough`와 `changedThrough`가 구분되지 않는 문제

---

## 4. LIBRA 2.3.0 구현 파이프라인

### 4.1 기억 작성 파이프라인

```text
5 TURN exact U+A
  → Memory Ariadne
  → Memory Character ito
  → Memory World ito
  → Memory Narrative ito
  → canonical artifact validation
  → natural-language render validation
  → candidate readback
  → branch/source revalidation
  → committed write + readback
  → canonical commit envelope 발행
```

기억 ito의 역할은 기억 문서를 전문 영역별로 보정하는 것이다.

- Memory Character ito: 인물, 행동 주체, 관계 근거 보정
- Memory World ito: 장소, 사물, 조직, 규칙, 인과 보정
- Memory Narrative ito: 실제 사건 순서, 해결/미해결, 서사적 의미 보정

어떤 기억 ito도 Current State mutation을 출력하지 않는다.

### 4.2 상태 추적 멀티 파이프라인

정본 커밋 envelope를 받은 뒤 별도 작업으로 실행한다.

```text
Canonical Commit Envelope
  → immutable canonical readback
  → independent Entity Admission decision
  → Entity Admission receipt durable readback
  → approved assertion IDs only
  → Entity Registry binding
  → domain observation source compile
  ├── State Character Observer
  ├── State Relationship Observer
  ├── State World Observer
  └── State Narrative Observer
       ↓
  local schema / identity / evidence / no-op gate
       ↓
  high-risk patch only domain verifier
       ↓
  ordered atomic reducer
       ↓
  State Observation readback
       ↓
  Current State Head materialization + readback
```

도메인 observer는 같은 정본을 읽지만 서로 다른 provider route, preset, prompt, cache namespace, receipt를 가진다.

구현 route key:

```text
state_character_observer
state_relationship_observer
state_world_observer
state_narrative_observer

state_character_verifier
state_relationship_verifier
state_world_verifier
state_narrative_verifier
```

기본 provider 편의값은 별도 preset에서 `runLLMModel({ mode: 'otherAx' })`를 사용한다. 기억 작성 preset과 설정을 공유하지 않는다.

신규 인물 승인은 `state_character_verifier` 연결을 `person_admission` 모드로 사용하지만 일반 Character 필드 Verifier와 결과 계약을 공유하지 않는다. 신규 후보별 승인 결정과 `libra.entity_admission_receipt.v1`을 별도 저장하고 읽어야 하며, 이 영수증이 실패하면 기존 Registry는 유지하고 새 인물 assertion은 하나도 승인하지 않는다.

### 4.3 호출 전략

완전 분리에는 상태 전용 호출이 추가된다. 호출 비용은 다음으로 제한한다.

- 정본 커밋 전에는 상태 observer를 실행하지 않는다.
- 도메인 assertion과 검토 대상이 전혀 없으면 로컬 `no_candidates` receipt로 생략할 수 있다.
- 새 인물 후보가 없으면 Entity Admission은 `not_required` receipt로 끝난다.
- 새 인물 후보가 있으면 Entity Admission decision/receipt를 먼저 완성하며 실패 시 신규 등록만 fail-closed한다.
- 실행하는 observer는 도메인별 병렬 처리한다.
- verifier는 고위험 변경 후보가 있을 때만 호출한다.
- transport 실패를 합성 retry로 감추지 않는다.
- 한 도메인의 실패는 다른 도메인의 성공을 취소하지 않는다.

---

## 5. Canonical Memory 출력 계약

### 5.1 `libra.canonical_artifact.v3`

2.3.0의 현행 artifact는 상태 mutation을 포함하지 않는다.

```json
{
  "schema": "libra.canonical_artifact.v3",
  "chronology": [],
  "characters": [],
  "relationships": [],
  "world": [],
  "openThreads": [],
  "uncertainties": [],
  "recallTerms": []
}
```

각 assertion row에 런타임이 다음 metadata를 결합한다.

```json
{
  "assertionId": "ca_<stable hash>",
  "domain": "character|relationship|world|narrative|event",
  "temporalRole": "current_sequence|historical|flashback|reported|hypothetical|uncertain",
  "certainty": "confirmed|uncertain",
  "evidenceRefs": ["t15-a"],
  "evidenceSpans": [
    {
      "ref": "t15-a",
      "quote": "exact source words",
      "sourceHash": "...",
      "quoteHash": "..."
    }
  ]
}
```

`assertionId`는 모델이 신뢰 경계 밖에서 마음대로 소유하지 않는다. artifact validation 후 런타임이 source digest, row path, normalized content로 생성한다.

### 5.2 시간적 성격

State Tracking은 단순히 마지막 문장을 최신값으로 간주하면 안 된다.

- `current_sequence`: 현재 시간축에서 실제로 발생
- `historical`: 과거 사실 설명
- `flashback`: 현재 장면 안의 회상
- `reported`: 누군가가 전달한 주장
- `hypothetical`: 가정, 계획, 가능성
- `uncertain`: 진위 또는 시점 불명

기본 영구 상태 갱신은 `current_sequence + confirmed` assertion만 허용한다.

`reported`는 지식 상태처럼 보고 사실 자체가 아니라 “누가 무엇을 들었다”를 갱신할 때만 사용할 수 있다.

### 5.3 정본 coverage 원칙

기억 작성 파이프라인은 이후 상태 추적에 필요한 실제 변화를 정본의 domain assertion에 남겨야 한다.

예:

- 이동 → chronology와 character fact
- 부상 → character fact
- 소유권 이전 → chronology와 world/character fact
- 관계 단절 → relationship fact
- 규칙 무효화 → world fact
- 문제 해결 → openThreads 또는 narrative fact

상태 추적기가 원문에서 정본 누락을 발견하더라도 State Head를 독자적으로 갱신하지 않는다. `canonical_coverage_gap` 진단을 만들고 정본 재생성·수정 경로로 돌린다.

---

## 6. Canonical Commit Envelope

정본 write와 readback이 끝난 뒤 다음 이벤트를 발행한다.

```json
{
  "schema": "libra.canonical_commit.v1",
  "scopeKey": "...",
  "worldlineId": "main",
  "memoryId": "mem_...",
  "revision": 3,
  "turnRange": { "start": 11, "end": 15 },
  "sourceDigest": "...",
  "artifactDigest": "...",
  "memoryKey": "...",
  "status": "committed"
}
```

State Tracking orchestrator는 envelope payload의 artifact를 신뢰하지 않고 `memoryKey`를 다시 읽는다.

필수 검증:

- schema와 committed status
- scope key
- worldline
- memory ID
- revision
- turn range
- source digest
- artifact digest
- manifest의 활성 ref
- Current State basis의 exact canonical provenance

불일치 시 어떤 상태 observer도 호출하지 않는다.

공유 archive의 정본을 replay할 때는 manifest ref가 있다는 사실만으로 충분하지 않다. 검증된 archive의 실제 `memoryRefs` 안에서 다음 값이 모두 일치해야 한다.

- 물리 storage key
- archive ID와 archive canonical ID
- memory ID와 revision
- turn range
- source digest와 artifact digest

또한 현재 manifest의 `archiveRef.digest`가 handoff, Portable import 또는 native chat-copy 영수증의 `archiveDigest`와 일치해야 한다. source/target scope와 transfer/import ID까지 맞는 route만 유효하며, 이 결속이 없으면 해당 ref는 Head replay 입력이 아니다.

---

## 7. Entity Registry

### 7.1 두 단계 컴파일

```text
Pass 1: Canonical entity admission
Pass 2: Alias/type/relationship endpoint validation
```

### 7.2 안정 ID 규칙

- 안정 ID는 런타임 소유다.
- 기존 entity의 ID를 모델이 바꿀 수 없다.
- 새 entity 후보는 모델 ID를 버리고 런타임이 발급한다.
- exact ID match를 우선한다.
- 이름·별칭 fallback은 유일한 일치일 때만 허용한다.
- supplied ID와 exact name이 서로 다른 기존 entity를 가리키면 어느 한쪽을 임의 선택하지 않고 `ambiguous_identity`로 격리한다.

### 7.3 인물 검증

다음을 person entity로 만들지 않는다.

- 일반 명사
- 직업·전공만 있는 표현
- 문서 제목
- 관계명
- 조사나 서술어 어간으로 잘못 잘린 표현
- 이름 없는 일회성 군중을 억지로 영구화한 표현

새 인물은 정본의 명시적 character assertion이나 직접 등장한 안정적 이름/호칭에서만 admission 후보가 된다. 후보라는 이유만으로 Registry에 들어가지는 않는다.

Entity Admission은 일반 Character Observer보다 먼저 다음 독립 계약을 실행한다.

1. 런타임이 assertion ID, exact evidence, 이전 Registry와 canonical basis를 묶어 candidate/evidence/basis digest를 만든다.
2. `libra.entity_admission_decision.v1`의 `person_admission` 응답이 세 digest와 모든 후보 assertion ID를 정확히 되돌려 주어야 한다.
3. 각 후보는 `approve`, `reject`, `insufficient_evidence`, `ambiguous_identity` 중 하나로 판정되어야 한다.
4. 런타임이 결정 전체를 다시 검증하고 `libra.entity_admission_receipt.v1`을 물리 저장한 뒤 semantic readback한다.
5. `approvedPersonAssertionIds`에 포함된 assertion만 런타임 ID를 발급받는다.

Provider 실패, schema 오류, 누락 결정, digest 불일치 또는 영수증 readback 실패는 신규 인물 승인 0건으로 끝난다. 이미 검증된 기존 entity는 제거하지 않는다. 단어 denylist는 보조 방어선일 뿐 승인 권위가 아니다.

### 7.4 관계 endpoint

관계 pipeline은 새로운 인물을 만들 수 없다.

관계 patch는 양쪽 endpoint가 모두 validated `person` entity일 때만 허용한다. 동명이인이나 별칭 충돌은 patch를 폐기하고 진단으로 남긴다.

---

## 8. State Observation 계약

### 8.1 `libra.state_observation.v2`

```json
{
  "schema": "libra.state_observation.v2",
  "domain": "character",
  "basis": {
    "scopeKey": "...",
    "worldlineId": "main",
    "memoryId": "mem_...",
    "revision": 3,
    "sourceDigest": "...",
    "artifactDigest": "...",
    "headFingerprint": "...",
    "entityRegistryFingerprint": "..."
  },
  "reviews": [],
  "patches": [],
  "diagnostics": []
}
```

### 8.2 Review receipt

```json
{
  "entityId": "char_001",
  "outcome": "changed|maintained|insufficient_evidence|ambiguous_identity",
  "reviewedFields": ["appearance", "gender", "location"],
  "reason": "compact reason",
  "assertionIds": ["ca_..."]
}
```

의미:

- `changed`: 하나 이상의 patch 후보가 있음
- `maintained`: 검토했지만 실제 변경 없음
- `insufficient_evidence`: 관련 언급은 있으나 채택 근거 부족
- `ambiguous_identity`: 대상 식별 실패

entity omission은 삭제도 유지 판정도 아니다. 단순히 이번 검토 대상이 아니었다는 뜻이다.

### 8.3 Sparse patch

```json
{
  "operation": "upsert|clear_fields|close",
  "entityId": "char_001",
  "expectedRecordHash": "...",
  "expectedFieldHashes": {
    "location": "..."
  },
  "set": {
    "location": "왕궁 서쪽 회랑"
  },
  "clear": [],
  "changeClass": "newly_established|transition|correction|supersession",
  "evidenceByField": {
    "location": {
      "assertionId": "ca_...",
      "memoryId": "mem_...",
      "revision": 3,
      "evidenceRefs": ["t15-a"]
    }
  }
}
```

### 8.4 Omission과 clear

- `set`에 없는 필드: 기존 값 보존
- `clear`에 없는 필드: 기존 값 보존
- entity가 patches에 없음: 기존 entity 보존
- 빈 patches: 정상적인 무변경 결과
- `clear_fields`: 명시적 필드 무효화만
- `close`: 사망, 파괴, 해체, 영구 종료처럼 직접 근거가 있는 lifecycle 전환
- 모델의 빈 전체 `clear`로 entity를 삭제하는 연산은 제공하지 않는다.

---

## 9. 실제 변경 판정

### 9.1 로컬 no-op gate

모델이 값을 출력했다는 이유만으로 변경으로 인정하지 않는다.

적용 전 다음을 비교한다.

- 문자열 NFKC 정규화
- 공백과 줄바꿈 정규화
- enum 정규화
- ID 정규화
- 순서 비의존 set 배열 비교
- 순서 의미가 있는 배열의 안정 비교
- 객체 key 정렬 후 digest 비교

정규화 결과가 같으면:

- patch 제거
- field provenance 유지
- `changedThrough` 유지
- review를 `maintained`로 정규화

### 9.2 구조화 우선

장문 prose 하나를 통째로 덮어쓰기보다 변화 가능 단위를 구조화한다.

```text
appearance.hair
appearance.eyes
appearance.body
appearance.distinguishingMarks
outfit.current
```

머리색만 변하면 `appearance.hair`만 변경한다. 외모 전체 문장을 새로 생성하지 않는다.

### 9.3 필드 정책

#### Identity-locked

예:

- 성별
- 종족
- 출생 정보
- 안정 이름
- 본래 정체성

정정, 변신, 정체 공개처럼 직접적이고 명시적인 근거가 있어야 한다.

#### Slow durable

예:

- 외모
- 직업
- 소속
- 장기 거주지
- 지속 관계 역할

단순 재묘사나 표현 차이로 변경하지 않는다.

#### Dynamic current

예:

- 위치
- 신체 상태
- 현재 소지품
- 현재 목표
- 접근 가능 여부
- 현재 관계 상태
- 세계의 현재 작동 상태

새 정본의 직접 근거로 갱신할 수 있다.

#### Ephemeral

예:

- 순간 표정
- 현재 자세
- 장면 한정 감정
- inner thoughts
- 장면 연출용 상태

기본적으로 영구 Current State Head에 저장하지 않는다. 필요한 경우 Live Tail의 current-scene overlay에만 둔다.

### 9.4 Clear 정책

다음만 `clear` 근거가 된다.

- 물건을 잃거나 넘겼음
- 효과가 종료됨
- 잠금이 해제됨
- 관계 의무가 명시적으로 끝남
- 기존 정보가 오보였음이 확정됨
- 정본 revision이 이전 assertion을 취소함

다음은 clear 근거가 아니다.

- 이번 기억에서 언급되지 않음
- 다른 장면으로 전환됨
- 모델이 출력하지 않음
- 모호한 분위기 변화
- 일반적 시간 경과 추정

---

## 10. 도메인 설계

### 10.1 Character

소유:

- 안정 identity에 연결된 최신 인물 상태
- 위치, 상태, 목표, 지식 경계, 지속 소지품
- 변화가 실제로 확인된 외모·직업·소속

소유하지 않음:

- 과거 사건 history
- 내면 동기 추측
- 장면 한정 inner thoughts
- 관계의 반대 방향 추론

### 10.2 Relationship

인물과 분리된 독립 도메인이다.

키:

```text
(subjectId, targetId, dimension)
```

허용 dimension:

```text
trust
affection
fear
obligation
hostility
distance
cooperation
authority
dependency
knowledge
other
```

관계는 방향성 최신 상태를 저장한다.

- A가 B를 신뢰한다는 근거는 B가 A를 신뢰함을 증명하지 않는다.
- `trust +1` 같은 매턴 수치 누적을 사용하지 않는다.
- 사과, 호의, 갈등만으로 관계 변화가 자동 확정되지 않는다.
- 정본 relationship assertion이나 직접 귀결되는 명시적 상태가 필요하다.

### 10.3 World

소유:

- 장소
- 물건
- 조직
- 규칙
- 환경
- 지속 조건
- 현재 접근성, 소유·보유, 손상, 작동 여부

금지:

- 장면 밖에서 일어났을 법한 자동 사건
- 세계가 살아 있음을 보이기 위한 가짜 진행
- category checklist 채우기
- canonical assertion이 없는 offscreen simulation

### 10.4 Narrative

Narrative는 최신 서사 상태이며 초안 작성기가 아니다.

보존:

- 현재 중심 arc
- 활성 arc의 현재 단계와 중심 압력
- 열린 질문, 약속, 갈등, 의무
- 현재 narrative lock
- 현재 momentum

Current Head에 누적하지 않음:

- 과거 turning point 목록
- 해결된 thread 전체 역사
- 종료된 arc archive
- 실제 사건 beat ledger
- motif의 역사적 누적 카운트
- 다음 장면 계획

thread가 해결되면 current active collection에서 제거하거나 명시적 종료 상태로 전환한 뒤, 장기 이력은 Canonical Memory에서 조회한다.

---

## 11. Observer와 Verifier

### 11.1 Observer 책임

- supplied canonical assertion만 사용
- 이전 Head와 비교
- 모든 supplied candidate에 review receipt 작성
- 실제로 달라진 필드만 patch 후보로 작성
- ambiguous identity를 숨기지 않음
- empty patch를 정상 결과로 허용

### 11.2 Verifier 호출 조건

다음 후보만 verifier로 보낸다.

- Identity-locked 필드 변경
- Slow durable 필드 변경
- `clear_fields`
- `close`
- 이름·ID 충돌
- 기존 canonical provenance와 모순
- 불확실 assertion 기반 변경
- 관계 endpoint 또는 방향성 충돌

### 11.3 Verifier 결과

필드별 결과:

```text
approve
reject
insufficient_evidence
ambiguous_identity
stale_basis
```

Verifier transport/schema 실패는 승인으로 간주하지 않는다. 해당 고위험 필드는 보존한다.

---

## 12. Deterministic Reducer

### 12.1 적용 순서

```text
base Current State Head
→ basis/CAS validation
→ identity binding
→ field-policy validation
→ normalized no-op removal
→ verifier decisions
→ approved sparse patch
→ explicit correction overlay
→ schema validation
→ durable write
→ semantic readback
```

### 12.2 CAS

관찰 결과는 다음 모두와 결합한다.

- scope key
- worldline ID
- canonical memory ID/revision
- source digest
- artifact digest
- base Head fingerprint
- Entity Registry fingerprint
- expected record/field hash
- shared archive를 통한 ref라면 archive ID/digest와 검증된 member/transfer route

관찰 중 Head나 worldline이 바뀌면 결과를 현재 Head에 억지로 적용하지 않는다. 폐기하거나 새 basis로 재실행한다.

### 12.3 원자적 적용 단위

- character identity + aliases
- relationship endpoints + relation row
- world identity + kind
- narrative arc + 그 arc를 참조하는 active thread

의존 그룹의 일부만 적용되어 dangling reference가 생기면 전체 그룹을 거부한다.

### 12.4 provenance

각 필드는 마지막 실제 변경 근거를 유지한다.

```json
{
  "fieldProvenance": {
    "location": {
      "memoryId": "mem_...",
      "revision": 3,
      "assertionId": "ca_...",
      "evidenceRefs": ["t15-a"],
      "changedThroughTurn": 15
    }
  }
}
```

도메인 review metadata는 별도로 둔다.

```json
{
  "reviewedThroughTurn": 20,
  "changedThroughTurn": 15
}
```

---

## 13. 실패 정책

### 13.1 전체 원칙

```text
Canonical Memory commit: 독립적으로 성공
State pipeline scheduling: fail-open
Domain execution: 서로 독립
Field adoption: fail-closed
```

### 13.2 도메인 실패

예:

- Character 실패 → Character last-known 유지
- Relationship 성공 → Relationship 변경 적용
- World 성공 → World 변경 적용
- Narrative 실패 → Narrative last-known 유지

Head 전체를 실패시키지 않는다.

### 13.3 상태 표시

도메인 status:

```text
ready
catching_up
not_updated
partial
empty
disabled
```

`not_updated`는 기존 값이 거짓이라는 뜻이 아니다. 마지막 성공 정본까지만 유효한 last-known이라는 뜻이다.

파이프라인 영수증의 권위는 별도로 해석한다.

```text
complete      → authority: target_canonical_chain
not_required  → authority: not_required
partial       → authority: last_known_non_authoritative
```

`partial` 영수증과 일부 도메인의 성공 기록은 진단·재시도 입력으로 보존할 수 있지만, 전체 target canonical chain을 반영한 Head라고 주장하지 않는다. 체인 재구축 도중 하나라도 terminal row가 빠지거나 partial이면 작업 전 Head와 Registry를 복원하고 `pending: true`를 반환한다.

### 13.4 동일 도메인 순서

같은 도메인에서 T1~T5 처리가 실패한 뒤 T6~T10만 먼저 적용하면 안 된다.

각 도메인은 다음 cursor를 가진다.

```text
reviewedThroughCanonical
changedThroughCanonical
```

다음 실행은 미처리 정본을 순서대로 묶어 catch-up한다.

```text
Character cursor T0
→ T1~T5
→ T6~T10
→ Character cursor T10
```

다른 도메인은 자기 cursor를 독립적으로 진행할 수 있다.

---

## 14. Reroll, Revision, Rollback, Handoff

### 14.1 Candidate

- candidate canonical memory는 active State Head에 반영하지 않는다.
- candidate 단계에서는 State LLM이나 영구 상태 preview를 실행하지 않는다.
- 후보 채택 뒤 committed envelope를 기준으로 정식 상태 추적을 실행한다.
- 사용자 작성 candidate는 채택 전에 job-local 상태 처분을 내구 저장해야 한다. 처분이 없으면 채택은 fail-closed한다.

### 14.2 Revision

정본 revision이 교체되면 기존 revision의 state observation은 inactive/invalid derived cache가 된다.

영향 turn부터 다음을 다시 수행한다.

- Entity Registry reconcile
- 도메인 observation replay
- State Correction Journal reconcile
- Current State Head rebuild

### 14.3 Reroll과 rollback

- source digest 불일치 관찰은 채택하지 않는다.
- active canonical ref보다 뒤의 field provenance를 제거한다.
- 같은 canonical prefix에 해당하는 상태만 보존한다.
- ambiguous parent/worldline은 fail-closed한다.

### 14.4 Copy와 RE:TRACE handoff

- source scope key를 target에 그대로 쓰지 않는다.
- canonical identity를 target scope에 rebind한 뒤 상태를 재생성한다.
- Entity Registry와 Head fingerprint도 target scope 기준으로 다시 계산한다.
- handed-off Head는 최적화용 seed일 뿐, target canonical chain과 semantic readback이 맞아야 채택한다.
- source Head seed는 진단용으로만 읽고 target Head로 그대로 저장하지 않는다.
- 공유 archive ref는 exact member identity와 archive digest가 source/target transfer marker에 결속되어야 한다.

상태 이동 영수증은 다음 세 권위 중 하나를 기록한다.

```text
continuityRequired: false
continuityRebuildPending: false
continuityStateAuthority: not_required

continuityRequired: true
continuityRebuildPending: true
continuityStateAuthority: none_pending

continuityRequired: true
continuityRebuildPending: false
continuityStateAuthority: target_canonical_chain
```

두 번째 상태에서는 기억/manifest/archive 이동 자체는 내구 완료될 수 있지만 Current State Head는 아직 권위가 없다. catch-up이 끝나기 전까지 마지막으로 검증된 target 상태만 사용한다.

Portable import readback은 이 구분을 그대로 따른다. 상태 추적이 꺼져 `not_required`이면 Head를 요구하지 않는다. `none_pending`이면 manifest에 저장된 exact pending receipt와 rebuild 결과를 확인하되 Head 존재는 선택 사항이며, 존재하더라도 권위로 채택하지 않는다. `target_canonical_chain`일 때만 현재 Head의 semantic readback을 완료 조건으로 요구한다.

Portable import가 상태 파생물을 갱신하기 전에는 `main`만이 아니라 State Worldline Meta와 활성 Canonical ref에서 식별되는 모든 known logical worldline의 `state-pipeline-receipt`와 4개 domain `state-observation`을 선캡처한다. import가 실패하면 공유 Head/Registry/Correction/Replay 키와 함께 이 월드라인별 sidecar도 역순으로 복원하고 readback한다. 비활성 worldline의 파생물까지 원래 값으로 돌아오지 않으면 rollback 완료로 판정하지 않는다.

### 14.5 Gate W reload journal과 쓰기 직전 재검증

Post-commit State 작업은 manifest 저장과 provider 실행보다 먼저 내구 journal에 scheduling 사실을 기록한다. journal은 실행 attempt와 boot를 구분하고, startup은 live-boundary marker를 먼저 지우지 않은 채 미완료 작업을 resume한다. 완료 결과가 semantic readback될 때만 marker를 지운다.

Observer provider fan-out이 끝났더라도 그 응답을 바로 권위 파생물로 저장하지 않는다. Registry, Observation, Head와 receipt를 쓰기 직전에 active scope/worldline과 committed Canonical envelope를 다시 읽는다. source/artifact/manifest identity가 달라졌다면 해당 observer 결과를 `stale`로 버리고 기존 정본과 Head를 보존한다.

이 Gate는 다음 focused 자동시험에서 채택 범위를 확인했다.

- `libra_state_tracking_reload_gate_contract_test.cjs`
- `libra_post_commit_state_orchestrator_contract_test.cjs`
- `libra_world_manager_worldline_transaction_rc2_test.cjs`
- `libra_state_rebuild_transfer_contract_test.cjs`
- `libra_canonical_job_runtime_test.cjs`
- `libra_portable_cross_chat_restore_runtime_test.cjs`

이 검증은 LIBRA 내부의 deterministic derived key와 identity/readback 경계를 증명한다. provider 호출 직후 프로세스가 중단되어 외부 provider가 같은 요청을 다시 받을 가능성까지 제거하지는 않는다. 실제 provider의 외부 부작용 idempotency와 live reload는 별도 검증 항목이다.

---

## 15. Rebuild와 파생 Delta 보관

### 15.1 정본 우선 재구축

Current State Head 재구축의 최종 입력은 활성 Canonical Memory 체인이다.

```text
active canonical refs in order
→ canonical artifacts
→ validated entity bindings
→ state observations/deltas
→ corrections
→ Current State Head
```

### 15.2 State Delta의 지위

memory별 sparse State Delta를 저장할 수 있다. 단 다음 조건을 지킨다.

- Canonical Memory와 1:1로 binding
- recall/search 대상으로 사용하지 않음
- 사용자에게 과거 상태 정본으로 제시하지 않음
- schema/compiler version이 달라지면 무효화 가능
- canonical artifact에서 재생성 가능
- active chain이 아니면 Head 권위가 없음

즉 State Delta는 누적되는 두 번째 기억이 아니라 replay를 빠르게 하기 위한 disposable compiler cache다.

엄격한 물리적 비누적 모드가 필요하면 checkpoint 이전 Delta를 compact할 수 있지만, rollback 비용과 재실행 비용이 증가한다.

### 15.3 재생성 입력

상태 Delta가 없을 때 전체 raw transcript를 자유롭게 재해석하지 않는다.

우선순위:

1. committed typed canonical artifact
2. artifact에 binding된 exact evidence span
3. 이전 field provenance가 가리키는 canonical assertion
4. legacy memory text fallback

legacy fallback 결과는 낮은 신뢰 상태로 표시하고 정상 v3 artifact migration 대상으로 남긴다.

---

## 16. 사용자 정정

### 16.1 사실 정정

실제 사건이나 사실이 잘못되었으면 Canonical Memory revision을 수정해야 한다.

```text
canonical edit
→ new committed revision
→ state observations invalidation
→ rebuild
```

### 16.2 파생 해석 정정

정본은 맞지만 Current State 해석만 틀렸다면 State Correction Journal을 사용할 수 있다.

예:

- 정본에는 일시 방문으로 기록되어 있는데 상태가 장기 거주지로 잘못 해석됨
- 관계 사건은 맞지만 방향성 dimension이 잘못 연결됨

Correction은 다음을 가져야 한다.

- target domain/entity/field
- prior expected hash
- correction value 또는 clear
- anchor turn/worldline
- user authority marker
- readback

실제 사실을 수정해야 하는데 State Correction만 영구 사용하여 정본과 충돌시키지 않는다.

### 16.3 사용자 작성 정본의 필수 상태 처분

`수정`으로 만든 사용자 작성 candidate는 상태 LLM preview를 만들지 않는다. 대신 후보 채택 전에 다음 중 하나를 사용자가 명시한다.

- `maintained_by_user`: 정본 문구는 바뀌었지만 기존 최신 상태값은 변하지 않았다고 확인한다.
- `sparse_correction`: 실제로 달라진 상태 필드만 희소 보정으로 작성한다.

이 선택은 일반 correction을 미리 활성 Head에 쓰는 연산이 아니라 canonical job과 candidate에 함께 저장되는 intent다. intent는 job ID, candidate ID/key, memory ID/revision, source digest, 사용자 편집 content/authority hash, target, patch와 intent digest에 결속되고 candidate와 job 양쪽 readback을 통과해야 한다. 편집 본문을 다시 저장하면 이전 intent는 폐기되며 다시 선택해야 한다.

채택 순서는 다음과 같다.

```text
manual candidate + durable job-local intent
→ canonical adoption transaction
→ active manifest/record durable readback
→ adopted target canonical basis fingerprint 계산
→ maintained receipt 또는 sparse correction 생성
→ correction overlay 1회 replay
→ Head/receipt semantic readback
```

`maintained_by_user`는 값을 다시 쓰지 않고 enabled domain의 review cursor를 새 정본으로 전진시키며 `manual_maintained` 영수증을 남긴다. `sparse_correction`은 post-adoption basis에 correction ID를 결정론적으로 결속하고 한 번만 적용한 뒤 `manual_correction_replayed` 영수증을 남긴다. 동일 intent와 basis의 재개·rebuild는 기존 영수증/correction을 재검증하여 중복 적용하지 않는다.

### 16.4 과거 정본 편집의 정확한 시점 Head

과거 5턴 슬롯을 편집할 때 최신 Current State Head를 잘라 쓰지 않는다. 최신 Head에는 대상 이후의 덮어쓰기·명시적 clear·신규 인물·관계·Narrative와 미래 correction이 이미 섞여 있으므로, 증거 ref만 가지치기해서는 과거 상태를 복원할 수 없다.

LIBRA는 활성 정본 체인의 시작부터 편집 대상 ref까지 기존의 내구 산출물만 읽기 전용으로 재생하여 서로 다른 두 snapshot을 만든다.

- `beforeTargetHead`: 편집 대상 ref 직전의 정확한 상태. 희소 patch의 유효성, no-op, 관계 endpoint와 변경 전 값 검증에 사용한다.
- `throughOriginalTargetHead`: 교체되기 전 활성 ref까지 적용한 정확한 상태. GUI가 낸 scope-local ID를 유일한 정본 이름으로 바꾸는 데만 사용한다.

v3 정본은 logical/archive binding, artifact digest, Entity Admission receipt, state pipeline receipt, domain Observation과 Verifier digest를 모두 재검증한다. 이전 사용자 정본은 manual disposition receipt와 correction binding을 검증하고, v2 호환 정본은 이미 저장된 Delta만 `dryRun`으로 적용한다. 이 경로는 Provider를 호출하거나 누락된 receipt/Delta를 생성하거나 Registry·Head·correction journal을 저장하지 않는다. 필요한 sidecar가 없거나 훼손되었으면 최신 Head로 폴백하지 않고 상태 처분 저장 전에 실패한다.

ID와 이름이 함께 오면 같은 entity를 가리켜야 하고, 이름·alias는 정확히 하나의 entity로 해소되어야 한다. 따라서 대상 이후에 처음 등장한 인물, 모호한 별칭, ID/이름 불일치와 자기 자신을 향한 관계는 자동 재표적화되지 않는다. manifest, correction journal, active worldline, candidate와 canonical job은 snapshot 계산 전후 readback/CAS로 다시 확인하며, 후보 채택 직전에도 같은 시점 검증을 반복한다.

---

## 17. Planner, GRADIA, Recall과의 관계

### 17.1 Recall

Recall의 반환 본문은 Canonical Memory다.

State Head는 다음 목적으로만 recall 선택을 보조할 수 있다.

- 현재 상태 필드 provenance가 가리키는 정본을 보호 후보로 올림
- 현재 인물 ID와 별칭으로 canonical 검색 query 보강
- 관계 endpoint의 canonical source 찾기

State Head의 파생 값을 canonical quote처럼 직접 주입하지 않는다.

### 17.2 Planner

Planner 입력:

- recalled Canonical Memory
- Current State Head
- Live Tail
- 현재 사용자 input

우선순위:

```text
current input / terminal scene / Live Tail
> newer committed canonical assertion
> Current State Head last-known
> older recalled canonical memory
```

Planner는 미래 계획을 작성할 수 있지만 State Head에 쓰지 않는다.

4개 도메인의 evidence가 모두 존재할 때만 그중 가장 이른 evidence를 안전한 State 경계로 사용한다. 일부 도메인이 누락되어 `pending`이지만 안전한 경계를 계산할 수 없으면, recalled Canonical을 임의로 과거 계층에 내리지 않고 모두 `newer committed canonical assertion` 계층으로 승격한다. 이 보수적 분류는 불완전한 last-known Head가 정본보다 우선하는 것을 막으며, 안전한 경계가 다시 생기면 기존의 exact 시점 분할로 돌아간다.

### 17.3 GRADIA

GRADIA도 같은 Canonical Memory와 State Head를 볼 수 있다.

차이는 기억을 제공하는 방식과 초안 작성 pipeline에만 있다. State Tracking 자체를 GRADIA 전용으로 복제하지 않는다.

GRADIA 초안이 곧바로 State Head를 수정하지 않는다. 완성된 응답이 5턴 정본에 채택된 뒤 동일한 상태 pipeline을 거친다.

### 17.4 Input Writer

Input Writer는 Canonical/State를 갱신하는 파이프라인이 아니라 현재 입력을 돕는 request-local 읽기 전용 소비자다. preflight, prompt build와 candidate generation 중 Canonical, manifest, Entity Registry, Current State Head와 State sidecar를 저장·정정하지 않는다. recall 호출에는 request-local read-only와 `persistCatalog: false`를 끝까지 전달하여 canonical ref가 실제로 있는 cold-read에서도 recall catalog `setJson`과 legacy background upgrade scheduling을 0으로 유지한다. 이전 Story Arc를 Input Writer authority 또는 Current Narrative로 migration하지도 않는다.

사실 자료의 순서는 다음과 같이 고정한다.

```text
composer/user brief + terminal scene/Live Tail
> State보다 새로운 committed Canonical
> Current State Head + factual Current Narrative State
> historical Canonical
```

`pending`, `partial` 또는 last-known State는 새로운 committed Canonical을 덮는 current fact가 아니다. 안전한 State 경계가 없으면 Canonical 전체를 newer 계층으로 올리는 보수 규칙을 Input Writer에도 적용한다. Narrative Direction, Author Note와 Lore는 위 사실 계층 다음의 creative reference이며 사실 권위를 얻지 않는다.

candidate generation 시 Narrative Direction을 preflight에서 한 번만 읽고 다음 identity와 함께 하나의 봉인된 delivery snapshot으로 만든다. 재생성은 정확히 세 후보를 만든 성공 run일 때만 outer preflight/run을 교체하며, picker 결과의 `selectedRunId`와 `deliverySnapshot`이 같은 run을 가리켜야 한다. 실패한 재생성은 화면에 남은 이전 후보와 그 후보의 snapshot을 바꾸지 않는다.

```text
scope / character / chat
+ active physical and logical worldline / worldline meta revision
+ canonical refs, frontier, branch guard and manifest digest
+ current State authority, Head and factual Narrative State digest
+ transcript/live-tail digest
```

insert/send 직전에 snapshot을 현재 값과 다시 비교한다. 불일치하면 자동 insert/send는 `stale`로 fail-closed하지만 candidate 본문과 copy/manual-paste 경로는 보존한다. send는 host API와 chat readback basis를 먼저 확보하고, 그 preflight 동안 권위가 바뀌지 않았는지 snapshot을 다시 검증한 다음에만 물리 `sendChat()`을 호출한다. pending receipt는 이 물리 호출이 반환한 Promise를 관찰하기 시작한 뒤에만 생성한다. 자동 전달은 delivery cycle mutex와 결정론적 idempotency key를 공유하며, `delivered`, `rejected`, `user_delivered_response_failed`, `ambiguous` readback이 난 cycle을 재전송하지 않는다.

`sendChat()`은 응답 생성 완료까지 기다리는 composer input handler가 아니다. user message dispatch Promise와 실제 chat readback, 이후 assistant 응답의 late resolve/reject를 따로 관찰한다. modal이 닫힌 뒤의 rejection도 소비하여 unhandled rejection을 만들지 않고 실행 기록을 갱신한다.

현재 공식 RisuAI Plugin API에는 composer text setter가 없다. 명시적 native setter capability가 실제로 제공될 때만 이를 사용하고, 없으면 copy와 수동 paste로 전환한다. SafeDOM에서 textarea를 찾아 value/text/event를 변조하는 방식은 native insertion도 성공 readback도 아니므로 사용하지 않는다.

위 계약의 focused/static/mock 검증과 실제 RisuAI GUI·provider 검증은 분리한다. 전자가 통과해도 hamburger 실행, native capability, 채팅 readback과 provider late settlement의 live 동작을 통과한 것으로 간주하지 않는다.

---

## 18. GUI 반영 원칙

### 18.1 한 흐름으로 보이기

내부 pipeline은 분리하지만 GUI에서는 다음 흐름으로 이해되어야 한다.

```text
기억에 기록됨
→ 인물/관계/세계/내러티브의 최신 상태에 반영됨
→ Planner 또는 GRADIA가 활용함
```

### 18.2 화면 소유권

공통 사이드바는 홈 화면 없이 다음 12개 페이지를 고정 순서로 제공한다.

1. `기억`: Canonical Memory 열람·검색·정정과 리콜
2. `인물`: Character Current Head
3. `관계`: 방향별 Relationship Current Head
4. `세계`: World Current Head
5. `내러티브`: 현재 활성 Arc·열린 Thread·Lock·momentum과 그 정본 근거
6. `파이프라인`: 응답 생성, 기억 작성, 상태 추적의 분리된 실행 경계
7. `에이전트`: 기억·상태·현재 초안 에이전트 설정과 신규 인물 승인 연결
8. `커스텀`: 기억·상태·현재 초안 프롬프트, OOC와 주입 설정
9. `AI 연결`: provider/model preset 추가·복제·편집
10. `임베딩 연결`: 다국어 리콜 연결, task/prefix/custom HTTP 등 고급 설정과 재구축
11. `실행 기록`: 기억·상태·초안·리콜·Input Writer 기록의 분리된 조회
12. `설정`: Input Writer, 참고 자료, 기억·리콜, 상태, 서버·저장, 백업·복구, 데이터 이동, 일반·진단

LIBRA와 GRADIA 전환은 이 12개 공통 페이지를 갈아 끼우지 않는다. 둘은 같은 Canonical Memory, Current State Head, 연결, 실행 기록과 설정을 본다. 차이는 `파이프라인 > 응답 생성`과 초안 에이전트/프롬프트에서만 나타난다.

- LIBRA: Classic/Planner 응답, Planner 작성 언어와 `서사 방향` 설정
- GRADIA: 소설/RP 초안, 분량·작성 언어·단계·Skill·출력 설정

Current Narrative는 이미 성립한 현재 서사 상태만 표시한다. 사용자가 앞으로의 전개를 지시하는 Planner `서사 방향`은 Current Narrative에 저장하거나 섞지 않고 LIBRA 작성 설정으로 별도 보관한다.

Input Writer는 `설정 > Input Writer`에서 동작 방식만 구성한다. 실제 입력 작성은 설정 GUI 안의 실행 버튼이 아니라 RisuAI 햄버거 메뉴에서 여는 독립 입력창으로 수행한다.

`파이프라인 > 상태 추적`과 `에이전트 > 상태 추적`은 모두 `신규 인물 승인` 카드를 첫 단계로 표시한다. 이 카드는 Character Verifier AI 연결을 `person_admission` 모드로 공유하지만 일반 필드 Verifier와 별도의 decision/receipt를 사용하고 실패 시 신규 등록을 막는다는 점을 명시한다.

기억의 사용자 작성 정본 비교창은 `편집 이후 상태 결정 · 필수`를 표시한다. 사용자는 `상태 변화 없음` 또는 `상태 보정 작성`을 저장해야 하며, 후자를 선택한 경우에만 희소 patch 입력창이 열린다. 이 intent의 내구 readback 전에는 `후보 채택` 버튼이 비활성화된다.

### 18.3 상태 정보 표현

거대한 현황판을 만들지 않는다.

필요한 상태만 해당 화면의 문맥 안에서 작게 표시한다.

- 마지막 실제 변경 근거
- last-known 여부
- 현재 도메인이 정본보다 뒤처졌는지
- 사용자가 수정할 수 있는 필드

`reviewedThrough`가 진행되었다는 이유만으로 엔티티가 갱신된 것처럼 표시하지 않는다.

첫 화면은 `기억`이며, 메모리 수·현재 세계·초안 작업공간을 한데 모은 홈 현황판이나 우측 상태 레일을 만들지 않는다. 로딩 화면도 제품명과 `기억을 여는 중`만 표시한다.

---

## 19. 설정 구조

### 19.1 기억 작성 설정

```text
memory.ariadne
memory.character_ito
memory.world_ito
memory.narrative_ito
```

각각:

- enabled
- provider route/preset
- model
- temperature/output budget
- prompt profile
- additional instructions
- fail-soft 여부

### 19.2 상태 추적 설정

```text
state.enabled
state.character
state.relationship
state.world
state.narrative
state.verification
state_character_verifier
  ├── field_verification
  └── person_admission
```

각 도메인:

- observer enabled
- provider route/preset
- default `otherAx`
- review candidate limit
- output budget
- dynamic/slow field policy
- conditional verifier enabled
- 신규 인물 승인 enabled와 `person_admission`에 사용할 Character Verifier preset
- catch-up concurrency

기억 작성 ito의 활성 여부가 같은 이름의 상태 observer를 자동으로 끄거나 켜지 않는다.

### 19.3 Pipeline 실행 기록

기억 pipeline receipt와 상태 pipeline receipt를 별도 schema로 저장한다.

- memory run: canonical 문서 작성 과정
- state run: committed memory를 최신 상태로 반영한 과정

두 기록은 `memoryId + revision`으로 연결하되 한 JSON 객체에 섞지 않는다.

### 19.4 AI·Embedding·Input Writer 설정 소유권

- AI 연결은 preset 추가·복제·삭제, provider/model/temperature/output 설정을 소유한다.
- 기본 RisuAI 보조 모델 preset은 `runLLMModel({ mode: 'otherAx' })`로 연결되며 단계별 preset을 비워 둔 경우의 편의 기본값이다.
- Embedding 연결은 provider 기본값뿐 아니라 질의/문서 task, prefix, 차원·정규화, custom HTTP 요청 계약과 재구축 진단을 유지한다.
- Input Writer 설정은 작성 모드, 후보 수, 프롬프트·자료 사용과 전달 방식을 소유하지만 실행 결과 화면을 겸하지 않는다.
- Planner 작성 언어·서사 방향과 GRADIA 작성 언어·분량은 각자의 응답 생성 설정이 소유한다.

---

## 20. 보안과 신뢰 경계

- Canonical artifact와 recalled text는 상태 observer에게 데이터로 제공하며 내부 명령으로 실행하지 않는다.
- custom prompt가 evidence binding, stable ID ownership, omission-preserve, clear 정책을 해제할 수 없다.
- 모델 출력의 `__proto__`, `constructor`, 과도한 depth/array/text를 제거한다.
- unknown schema/enum/field를 drop 또는 reject한다.
- 모델이 제공한 scope/worldline/memory ID를 권위로 신뢰하지 않는다.
- provider response가 canonical memory를 수정하거나 다시 쓰도록 허용하지 않는다.
- verifier의 실패를 승인으로 간주하지 않는다.

---

## 21. LIBRA 2.3.1 구현 계약 요약

다음 구현 영역은 2.3.1 코드에 반영된 계약을 기능 경계별로 정리한 것이다. v1/v2 읽기 호환은 유지하지만 기존 파생 Delta/Head를 새 schema 권위로 그대로 승격하지 않고 활성 정본 체인, 독립 Entity Admission 영수증, 사용자 correction을 기준으로 재구축한다. 배포 증거는 22장의 회귀시험과 package manifest/checksum/layout 검증으로 별도 확인한다.

### 구현 영역 0 — 기준선과 회귀 고정 [회귀 기준]

- 현행 canonical artifact/commit/state replay 테스트 확보
- 현재 plugin version과 schema fingerprint 기록
- 인물/관계 오염 fixture 확보
- 같은 값 재출력 provenance drift fixture 확보
- 전체 `clear` 공격 fixture 확보

현행 검증 기준:

- 변경 전 기능과 알려진 결함이 각각 테스트로 재현됨

### 구현 영역 1 — v3 Canonical artifact [구현]

- artifact에서 mutation용 `state` 제거
- assertion ID와 temporalRole 추가
- exact evidence binding 유지
- Memory ito 출력에서 state/narrative patch 제거
- v2 read compatibility 유지

현행 검증 기준:

- 기억 pipeline 결과만으로 canonical memory가 정상 커밋됨
- 상태 tracking을 꺼도 canonical artifact가 완전함

### 구현 영역 2 — Entity Registry v2 [구현]

- validated entity admission
- independent decision/receipt와 fail-closed 신규 승인
- alias/type normalization
- ambiguous identity quarantine
- relationship endpoint validation
- registry fingerprint

현행 검증 기준:

- 일반 명사/전공/표제/서술어 오염 0
- 동명이인 자동 병합 0
- invalid relationship endpoint 0

### 구현 영역 3 — State Observation v2 [구현]

- reviews와 patches 분리
- 네 도메인 observer route 추가
- field-policy compiler
- normalized no-op gate
- conditional verifier

현행 검증 기준:

- 무변경 정본에서 patch 0
- 실제 변경 필드만 patch됨

### 구현 영역 4 — Reducer와 Head schema 갱신 [구현]

- character/relationship 도메인 분리
- reviewedThrough/changedThrough 분리
- field provenance 유지
- full-record model delete 제거
- Narrative current-only 구조

현행 검증 기준:

- 외모 미변경 시 byte-semantic 보존
- 관계 실패가 인물 성공을 막지 않음
- Narrative가 과거 history를 축적하지 않음

### 구현 영역 5 — Post-commit orchestrator [구현]

- committed envelope 발행
- 정본 readback 뒤 state scheduling
- domain cursor와 catch-up
- CAS/stale observation 폐기
- state readback

현행 검증 기준:

- 정본 실패 시 state 호출 0
- state 실패 시 canonical commit 유지
- T5 실패 후 T10 단독 적용 방지

### 구현 영역 6 — Rebuild, correction, migration [구현]

- active canonical chain replay
- v1/v2 Delta 무효화·재생성
- correction replay
- manual `maintained_by_user|sparse_correction` target-basis receipt/replay
- reroll/rollback/copy/handoff
- archive digest binding과 pending/non-authoritative transfer receipt
- Story Arc를 Current Narrative나 Input Writer authority로 migration하지 않는 경계

현행 검증 기준:

- 같은 활성 정본과 correction에서 semantic-equal Head 재생성
- invalid old entity/relationship가 부활하지 않음

### 구현 영역 7 — GUI와 설정 [구현]

- 기억 pipeline과 상태 pipeline preset 분리
- Character/Relationship/World/Narrative 화면을 Current Head에 연결
- 실행 기록 분리
- last-known/stale 표시
- Pipeline/Agents 상태 화면의 Entity Admission 카드
- 수동 정본 편집의 필수 상태 처분 GUI
- 기존 GRADIA UI 경로 불변 확인

현행 검증 기준:

- 사용자는 기억에서 최신 상태로 이어지는 한 흐름으로 이해할 수 있음
- 불필요한 상태 현황판 없이 각 도메인 화면에서 근거를 확인할 수 있음

### 구현 영역 8 — Gate W와 Input Writer 권위 전달 [구현, focused 검증 완료]

- State tracking journal을 scheduling 전에 내구 저장하고 startup resume 뒤 semantic readback
- provider fan-out 뒤 파생물 쓰기 전 committed Canonical envelope 재검증
- Input Writer의 read-only manifest/State view와 사실·창작 reference 분리
- request-local recall의 catalog 저장·legacy background upgrade 0
- 한 번 읽은 Narrative Direction과 scope/worldline/manifest/State/transcript를 봉인한 delivery snapshot
- 성공한 3-choice 재생성만 outer run/snapshot으로 commit하고 picker 선택 run의 snapshot을 전달
- delivery cycle mutex/idempotency, send preflight → final snapshot revalidation → 물리 `sendChat()` 순서와 late settlement/chat readback
- native composer setter 부재 시 copy/manual-paste만 제공하고 SafeDOM mutation 금지

현행 검증 기준:

- Gate W는 14.5에 적은 focused Gate 범위에서 통과함
- Phase06 기본 계약과 post-adoption 보강은 22.8의 focused 시험에서 통과함. 실제 committed Canonical ref fixture에서도 Input Writer durable write는 0임
- 전체 회귀와 manifest/checksum/layout 배포 검증은 focused 판정과 분리하여 릴리스 gate에서 확인함
- 실제 RisuAI GUI와 실제 provider 호출은 live 검증 전까지 미확인으로 유지함

---

## 22. 회귀시험 매트릭스

### 22.1 Canonical 경계

- candidate는 State Head를 변경하지 않음
- committed readback 전 observer 호출 0
- source digest mismatch 폐기
- artifact digest mismatch 폐기
- custom prompt가 locked evidence contract를 무효화하지 못함
- 사용자 작성 candidate가 상태 처분 없이 채택되지 않음
- 상태 처분 intent가 job/candidate/source/content authority에 정확히 결속됨

### 22.2 무변경 보존

- 성별 미언급 → 기존 성별과 provenance 유지
- 외모 미언급 → 기존 외모와 provenance 유지
- 같은 외모 표현 반복 → no-op
- 이름만 언급 → 상세 상태 변경 0
- 관계 언급 없음 → 관계 유지
- 세계 항목 언급 없음 → 세계 유지
- thread 언급 없음 → 자동 해결 금지

### 22.3 실제 변경

- 위치 이동 → location만 변경
- 머리색 변신 → appearance.hair만 변경
- 소지품 양도 → holder/possessions 원자적 변경
- 관계 단절 → 해당 방향·dimension만 변경/종료
- 다리 붕괴 → world condition/access 변경
- 문제 해결 → active narrative thread 제거 또는 resolve

### 22.4 Identity

- exact ID 정상
- unique alias 정상
- 동명이인 → ambiguous
- 잘못된 supplied ID/name 충돌 → 자동 선택 금지
- 관계가 unknown endpoint를 통해 placeholder 인물 생성하지 않음
- 일반 명사를 person으로 등록하지 않음
- Entity Admission decision의 basis/candidate/evidence digest 불일치 승인 0
- admission provider/schema/readback 실패 시 신규 인물 0, 기존 Registry 보존

### 22.5 Failure isolation

- Character provider 실패 + World 성공
- Relationship verifier 실패 + Character 성공
- Narrative malformed JSON + 다른 도메인 성공
- provider timeout/transport 실패 시 기존 Head 보존
- no-op observer 결과가 정상 ready review가 됨

### 22.6 순서와 재생성

- T5 domain 실패 후 T10 catch-up
- reroll source 변경
- rollback prefix 복원
- canonical revision 교체
- cross-chat copy rebind
- RE:TRACE handoff rebase
- correction journal replay
- missing Delta rebuild
- 공유 archive member·archive digest·transfer route 불일치 replay 차단
- incomplete rebuild가 이전 Head/Registry를 복원하고 pending/non-authoritative로 남음
- Portable pending receipt는 Head 없이 readback 가능하고 Head 권위를 주장하지 않음
- Portable import 실패가 main과 모든 known logical worldline의 receipt/4-domain observation을 정확히 복원함
- manual maintained/correction receipt가 post-adoption basis에서 한 번만 replay됨
- 과거 수동 편집이 `beforeTargetHead`와 `throughOriginalTargetHead`를 분리하여 대상 이후 신규 인물·덮어쓰기·clear·Narrative·correction을 보지 않음
- 과거 시점 sidecar 누락·digest 훼손·모호한 alias·ID/name 충돌·manifest/journal/worldline/job CAS 실패가 무Provider·무파생쓰기 상태로 fail-closed

### 22.7 Narrative/Planner 경계

- Narrative가 미래 사건을 저장하지 않음
- Planner 결과가 State Head를 직접 수정하지 않음
- GRADIA draft가 State Head를 직접 수정하지 않음
- 일부 State 도메인 evidence가 누락된 pending Head에서 recalled Canonical 전체가 State보다 앞선 계층에 놓임
- 4개 도메인의 안전한 경계가 있으면 경계 이후 정본만 newer 계층에 놓이는 기존 분할이 유지됨
- resolved history가 Current Narrative에 무한 누적되지 않음

### 22.8 Input Writer read-only authority와 delivery

- `libra_input_writer_delivery_contract_test.cjs`: sealed snapshot, stale, cycle mutex/idempotency와 failure-preserve 계약
- `libra_input_writer_phase06_authority_runtime_test.cjs`: factual authority 순서, factual Narrative State와 creative Narrative Direction/Author Note/Lore 분리, 실제 provider payload
- `libra_input_writer_phase06_delivery_runtime_test.cjs`: double-click, stale identity, delayed `sendChat()` resolve/reject와 chat readback 분류
- `libra_input_writer_phase06_gui_contract_test.cjs`: hamburger/modal, cancel/copy, native-unavailable와 manual-paste 경계, SafeDOM mutation 부재
- `libra_input_writer_phase06_no_mutation_runtime_test.cjs`: preflight/prompt/generation 중 Canonical/State/Registry/manifest durable mutation 0
- `libra_input_writer_phase06_post_adoption_p1_test.cjs`: 성공 재생성 snapshot 소유권, request-local catalog/legacy write 0, 단일 Narrative Direction binding, send preflight/재검증/물리 호출 순서
- 위 focused 자동시험은 LIBRA 2.3.1 정본에 대해 PASS함
- 위 자동시험과 별개로 실제 RisuAI GUI, native capability와 실제 provider late settlement는 미검증으로 유지

---

## 23. LIBRA 2.3.1 구현 적합성 판정

현재 소스와 배포 산출물은 다음 조건을 모두 만족해야 이 2.3.1 구현 계약에 적합하다.

1. 기억 작성 응답에 state mutation이 없다.
2. 상태 observer는 committed canonical envelope 이후에만 실행된다.
3. Character, Relationship, World, Narrative가 독립적으로 실패하고 복구된다.
4. 모든 Head 필드가 canonical assertion provenance를 가진다.
5. 같은 값 재출력은 필드 변경으로 계산되지 않는다.
6. 누락 필드는 보존되고 명시적 clear만 삭제한다.
7. 관계 endpoint는 validated person만 허용한다.
8. Narrative Head는 현재 활성 상태만 보유한다.
9. Live Tail은 요청 단위 overlay로만 존재한다.
10. candidate/reroll/rollback/revision/handoff에서 stale state가 채택되지 않는다.
11. 상태 실패가 canonical commit을 되돌리지 않는다.
12. State Head를 삭제한 뒤 활성 Canonical Memory와 corrections로 재구축할 수 있다.
13. 기억만 누적 정본이며 State Delta와 Head는 disposable derived data다.
14. Planner와 GRADIA는 같은 기억/상태 기반을 사용하되 초안 작성 pipeline만 다르게 동작한다.
15. GUI는 기억과 World Manager가 한 흐름으로 연결되어 보이되 내부 실행 기록은 분리된다.
16. 신규 인물은 독립 Admission decision/receipt가 승인한 assertion만 Registry에 들어간다.
17. 수동 정본 편집은 필수 상태 처분과 post-adoption basis 영수증 없이는 완료되지 않는다.
18. partial/pending 이동·재구축은 target Head 권위를 주장하지 않는다.
19. Gate W는 scheduling 전 내구 journal과 provider fan-out 뒤 Canonical envelope 재검증을 모두 수행한다.
20. Input Writer는 request-local 권위 자료를 쓰지 않고, 선택 후보가 소유한 snapshot을 send preflight 뒤 다시 검증한 다음 물리 전달한다.

---

## 24. 최종 불변문

```text
Canonical Memory는 과거에 실제로 무엇이 있었는지 누적한다.

State Tracking은 그 정본을 읽어 현재 무엇이 참인지 계산한다.

변하지 않은 값은 다시 쓰지 않는다.
누락된 값은 지우지 않는다.
모호한 값은 채택하지 않는다.
다른 도메인의 실패 때문에 유효한 도메인을 버리지 않는다.
새 인물 승인이 실패하면 기존 Registry를 보존하고 신규 등록만 막는다.
부분 재구축 결과는 Current Head 권위로 승격하지 않는다.

Current State Head는 정본의 경쟁자가 아니다.
정본을 빠르고 안전하게 현재형으로 읽기 위한 파생된 최신 상태다.
```
