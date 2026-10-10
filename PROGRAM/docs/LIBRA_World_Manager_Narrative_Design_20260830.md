# LIBRA World Manager Narrative V1
# 설계도
## Story Arc → World Manager / Narrative 통합 설계
### 기준: Librarian System 0.3.14 / LIBRA.js 2.2.8 계열
### 작성일: 2026-08-30

---

# 0. 문서 목적

이 문서는 현재 LIBRA의 독립 `Story Arc` 기능을 제거·축소하는 단순 UI 개편이 아니라,
그 안의 유효한 **현재 서사 연속성 추적 기능**을 World Manager의 네 번째 도메인
**Narrative(내러티브)** 로 재설계하기 위한 확정 설계도다.

핵심 목표는 다음과 같다.

1. World Manager를 다음 네 도메인으로 통일한다.
   - Character
   - Relationship
   - World
   - Narrative
2. Narrative는 `현재까지 실제로 성립한 서사 상태`만 추적한다.
3. Narrative는 Planner와 명확히 분리한다.
4. 5턴 정본 분석 파이프라인을 그대로 활용한다.
5. 정상적인 5턴 분석에서 LLM 호출 횟수를 추가하지 않는다.
6. Ariadne가 Narrative 초안/Seed를 제공하고 Plot ito가 기존 호출 안에서 최종 Narrative Delta를 작성한다.
7. Plot ito가 꺼져 있거나 실패해도 Ariadne 기반 fallback으로 Narrative를 유지한다.
8. Narrative도 Character/Relationship/World와 동일하게 canonical revision, reroll, rollback, worldline, correction, replay에 참여한다.
9. 기존 Story Arc 데이터는 가능한 범위에서 안전하게 마이그레이션한다.
10. 과거 World Manager의 Narrative 장점은 되살리되 lorebook 저장·매턴 누적·별도 서사 DB는 부활시키지 않는다.

---

# 1. 현재 구조 진단

## 1.1 현재 0.3.14 Story Arc

현재 `LIBRA.js`에는 별도 Story Arc 계층이 있다.

주요 구성은 다음과 같다.

- `STORY_ARC_SCHEMA = libra.story_arc.v1`
- scope별 `...:story-arc` 저장
- canonical memory 커밋 뒤 `updateStoryArcAfterCommit()`
- canonical history 기반 `derived` 모드
- 선택적 별도 LLM `Story Arc Director`
- `destination`
- `beats` / next-five soft route
- `beatLedger`
- `continuityState`
  - currentNarrativeState
  - currentPhase
  - centralPressure
  - activeThreads
  - resolvedThreads
  - narrativeLocks
  - openQuestions
  - pendingPromises
  - recentTurningPoints
  - relationshipTrajectories
  - continuityWarnings
  - compressedHistory
- Planner/SGA에 Story Arc prompt 주입
- 별도 Story Arc GUI
  - Current Narrative
  - Direction Settings
  - Advanced & Diagnostics

문제는 이 구조에 `현재 서사 사실`과 `향후 전개 방향`이 함께 존재한다는 점이다.

특히 다음 필드는 Planner 성격이다.

- destination
- next-five beats
- soft route
- doNotForce 일부
- inferred future direction

반면 다음 필드는 World Manager 성격이다.

- current narrative
- active/resolved threads
- promises/questions
- turning points
- narrative locks
- 실제 발생한 beat ledger

따라서 현재 Story Arc는 역할 경계가 섞여 있다.

---

## 1.2 과거 World Manager Narrative에서 되살릴 가치가 있는 개념

과거 `LIBRA_World_manager V3.6.0`의 NarrativeTracker는 다음 핵심 개념을 갖고 있었다.

- storylines
- turnLog
- currentContext
- storyDirection
- openThreads
- ongoingTensions
- summaries
- 5턴 주기 요약

이 중 새 Narrative에서 되살릴 개념:

- `storylines` → `arcs`
- `currentContext` → `arc.summary/context`
- `openThreads` → typed `threads`
- `ongoingTensions` → `centralPressure / momentum`
- 5턴 단위 재평가

되살리지 않을 개념:

- lorebook의 `lmai_narrative` 저장
- 매턴 persistent turnLog
- 매턴 별도 Narrative LLM 호출
- `storyDirection`을 사실 상태에 저장
- 별도 narrative archive
- 현재 canonical memory와 중복되는 과거 사건 원문/요약 축적

현재 시스템의 5턴 canonical memory가 역사적 사실 저장소 역할을 하므로,
Narrative는 **현재 서사 상태의 materialized view**만 담당한다.

---

# 2. 핵심 불변조건

## 2.1 역사적 정본

Canonical Memory가 역사적 사실의 유일한 누적 정본이다.

Narrative는 Canonical Memory를 대체하지 않는다.

```text
Canonical Memory = 과거에 실제로 무슨 일이 있었는가
Narrative Head    = 그 결과 지금 서사가 어떤 상태인가
Planner           = 다음 응답에서 무엇을 할 것인가
```

---

## 2.2 Narrative ≠ Planner

Narrative에 허용:

- 현재 Arc가 무엇인가
- 현재 갈등이 무엇인가
- 어떤 질문/약속/목표가 아직 열려 있는가
- 무엇이 실제로 해결되었는가
- 어떤 전환점이 이미 발생했는가
- 어떤 설정/복선/의무가 아직 회수되지 않았는가
- 서사의 현재 압력이 증가/완화/전환 중인가

Narrative에 금지:

- 다음 장면에서 누가 무엇을 해야 한다
- 다음 5턴에 반드시 발생할 사건
- 아직 수행되지 않은 사용자 행동
- 미래 사건을 사실처럼 저장
- Plot ito가 원하는 전개를 canon으로 저장

예:

```text
허용:
"세아의 실종 원인은 아직 밝혀지지 않은 핵심 질문이다."

금지:
"다음 장면에서 세연은 폐공장으로 가서 범인을 만난다."
```

금지된 미래 방향은 Planner로 이동한다.

---

## 2.3 추가 정상 LLM 호출 0회

정상 5턴 파이프라인의 호출 수는 늘리지 않는다.

```text
Ariadne
→ Character ito (활성 시)
→ World ito     (활성 시)
→ Plot ito      (활성 시)
```

Narrative를 위해 별도의 `Story Arc Director` 호출을 만들지 않는다.

- Ariadne: 기존 canonical artifact를 이용해 Narrative Seed를 로컬 생성
- Plot ito: 기존 Plot ito 호출의 JSON 출력에 `narrative_patch`를 함께 포함
- Plot ito 비활성/실패: Ariadne Seed를 conservative fallback patch로 승격

따라서 기존 Plot ito를 이미 사용하던 설정에서는 LLM 호출 수가 그대로다.

Plot ito가 꺼진 사용자에게 Narrative 때문에 Plot ito를 자동으로 켜지 않는다.

---

## 2.4 fail-soft

Ariadne 실패만 해당 5턴 canonical memory 전체 실패로 본다.

Character/World/Plot ito 실패는 각각 fail-soft다.

특히 Plot ito 실패 시:

```text
Character/World 성공 결과 보존
Canonical draft 보존
Narrative = Ariadne fallback
메모리 커밋 계속 진행
```

Plot ito의 `canonical edits`가 유효하고 `narrative_patch`만 잘못되었다면:

```text
Plot canonical edit = 채택
Plot narrative patch = 폐기
Narrative = Ariadne fallback
```

Narrative JSON 오류가 정본 메모리 전체를 실패시키면 안 된다.

---

## 2.5 5턴 경계

정식 Narrative Delta는 canonical memory와 같은 5턴 경계에서 확정한다.

```text
T1~T5   → Narrative Delta
T6~T10  → Narrative Delta
T11~T15 → Narrative Delta
```

최신 미완성 1~4턴은 Narrative 정본으로 쓰지 않는다.

Live Tail은 응답 생성 시 별도로 존재하며 Narrative Head를 영구 수정하지 않는다.

---

# 3. 목표 아키텍처

```text
                       ┌────────────────────────────┐
                       │    5 TURN EXACT U+A        │
                       └─────────────┬──────────────┘
                                     │
                                     ▼
                       ┌────────────────────────────┐
                       │          Ariadne           │
                       │ Canonical Artifact / Draft │
                       └─────────────┬──────────────┘
                                     │
                    local compile    │
                                     ▼
                       ┌────────────────────────────┐
                       │  Ariadne Narrative Seed    │
                       │   (work-stage only)        │
                       └─────────────┬──────────────┘
                                     │
                    ┌────────────────┴─────────────────┐
                    ▼                                  ▼
          ┌──────────────────┐               ┌──────────────────┐
          │  Character ito   │               │    World ito     │
          │ char/relation    │               │   world state    │
          └────────┬─────────┘               └────────┬─────────┘
                   └────────────────┬──────────────────┘
                                    ▼
                       ┌────────────────────────────┐
                       │          Plot ito          │
                       │ canonical plot refinement  │
                       │ + Narrative finalization   │
                       └─────────────┬──────────────┘
                                     │
                                     ▼
                ┌──────────────────────────────────────────┐
                │      Canonical Commit Side Products      │
                │                                          │
                │ characterPatch                           │
                │ relationshipPatch                        │
                │ worldPatch                               │
                │ narrativePatch                           │
                └─────────────────────┬────────────────────┘
                                      │
                                      ▼
                       ┌────────────────────────────┐
                       │ World Manager Delta Journal│
                       │  one delta / canonical rev │
                       └─────────────┬──────────────┘
                                     │
                   User Corrections  │  Worldline/Rollback
                            ─────────┼─────────
                                     ▼
                       ┌────────────────────────────┐
                       │ Deterministic Replay       │
                       └─────────────┬──────────────┘
                                     ▼
              ┌────────────────────────────────────────┐
              │       WORLD MANAGER CURRENT HEAD       │
              │ Character | Relationship | World       │
              │             Narrative                  │
              └────────────────────────────────────────┘
```

---

# 4. World Manager 데이터 소유권

| 도메인 | 1차 작성 | 정밀화 | 최종 Head 생성 |
|---|---|---|---|
| Character | Ariadne artifact state | Character ito | Replay |
| Relationship | Ariadne artifact state | Character ito | Replay |
| World | Ariadne artifact state | World ito | Replay |
| Narrative | Ariadne Narrative Seed | Plot ito | Replay |

사용자 수정은 별도 Correction Journal에서 모든 도메인보다 나중에 적용한다.

---

# 5. Ariadne Narrative Seed

## 5.1 Canonical Artifact schema를 즉시 깨지 않는다

Ariadne의 현재 typed canonical artifact에는 이미 다음 정보가 있다.

- chronology
- characters
- relationships
- world
- openThreads
- uncertainties
- recallTerms
- state

따라서 정상 파이프라인에서 Ariadne에게 별도 출력 필드를 강제하지 않는다.

대신 검증 완료된 Ariadne artifact에서 로컬로 다음 `Narrative Seed`를 컴파일한다.

```json
{
  "schema": "libra.narrative_seed.v1",
  "turnRange": { "start": 1, "end": 5 },
  "windowSummary": "...",
  "events": [],
  "openThreads": [],
  "resolvedThreads": [],
  "relationshipChanges": [],
  "worldChanges": [],
  "candidatePressures": [],
  "candidateArcLinks": [],
  "source": "ariadne_canonical_artifact"
}
```

Seed는 work-stage 데이터다.

영구 저장하지 않는다.

---

## 5.2 Seed 생성 원칙

- chronology를 사건 후보로 사용
- `openThreads.status=open` → openThreads
- `openThreads.status=resolved` → resolvedThreads
- relationship 변화 → 관계 기반 narrative pressure 후보
- world 변화 → 서사 조건 변화 후보
- uncertainty는 확정 thread로 승격하지 않음
- 현재 5턴에 없는 과거 thread는 자동 해결하지 않음
- 새 Arc 이름을 로컬 휴리스틱으로 과도하게 창작하지 않음

Plot ito가 없을 때 fallback은 최대한 보수적으로 적용한다.

---

# 6. Plot ito Narrative Finalizer

## 6.1 Plot ito는 Narrative가 활성인 메모리 파이프라인에서 terminal stage다

현재 메모리 ito 순서를 사용자가 바꿀 수 있어도,
Narrative 최종화가 활성화된 경우 Plot ito는 마지막에 실행해야 한다.

허용:

```text
Ariadne → Character → World → Plot
Ariadne → World → Character → Plot
```

금지:

```text
Ariadne → Plot → Character → World
```

이유:
Plot ito가 최종 Character/Relationship/World 변화까지 본 뒤 Narrative를 확정해야 하기 때문이다.

SGA 내부 AIDE 순서와 Memory Pipeline ito 순서는 별개다.

---

## 6.2 Plot ito에 전달할 Narrative Finalization Packet

Plot ito의 기존 프롬프트에 다음 read-only 블록을 추가한다.

```text
[NARRATIVE FINALIZATION PACKET]

Previous Narrative Head
- 직전 canonical boundary의 Narrative current state

Ariadne Narrative Seed
- 이번 5턴에서 관찰된 서사 변화 후보

Effective Character/Relationship State Patch
- Character ito 성공 시 ito 결과
- 실패/비활성 시 Ariadne artifact state fallback

Effective World State Patch
- World ito 성공 시 ito 결과
- 실패/비활성 시 Ariadne artifact state fallback

Narrative Continuity Recall (optional/local)
- 기존 canonical memories에서 현재 thread 식별에 필요한 소수 근거

Current Canonical Draft
- Character/World ito 적용이 끝난 현재 memory draft
```

Plot ito는 이 Packet을 사용하지만,
새 사건의 근거는 여전히 정확한 현재 5턴 U+A로 제한한다.

과거 Narrative Head는 "계속 열려 있는지 확인할 대상"이지 새 사건 증거가 아니다.

---

# 7. Narrative 데이터 모델

## 7.1 World Manager Head 확장

내부적으로 `continuity-state`를 World Manager Head로 계속 사용할 수 있다.

권장 schema:

```text
libra.continuity_state.v2
```

storage key는 호환성을 위해 유지:

```text
libra:v1:scope:<scopeKey>:continuity-state
```

구조:

```json
{
  "schema": "libra.continuity_state.v2",
  "scopeKey": "...",
  "throughTurn": 25,
  "characters": [],
  "relationships": [],
  "world": [],
  "narrative": {
    "schema": "libra.narrative_state.v1",
    "summary": "",
    "primaryArcId": "",
    "arcs": [],
    "threads": [],
    "turningPoints": [],
    "locks": [],
    "motifs": [],
    "momentum": "",
    "updatedThroughTurn": 25
  },
  "domainStatus": {
    "characters": {},
    "relationships": {},
    "world": {},
    "narrative": {}
  },
  "basis": {},
  "updatedAt": ""
}
```

---

## 7.2 Arc

```json
{
  "id": "arc_xxx",
  "title": "실종 사건",
  "status": "active",
  "phase": "developing",
  "summary": "세아의 실종 원인을 추적하는 과정이 현재 중심 서사다.",
  "centralPressure": "세연과 수사 관계자의 불신이 커지고 있다.",
  "participants": ["char_seyeon", "char_sea"],
  "worldRefs": ["world_school"],
  "firstTurn": 6,
  "lastTurn": 20,
  "evidence": {}
}
```

권장 status:

```text
active
dormant
resolved
superseded
```

권장 phase:

```text
emerging
developing
escalating
turning
aftermath
resolved
```

phase는 서사 이론을 강제하기 위한 값이 아니다.
현재 진행 정도를 압축 표시하기 위한 메타데이터다.

---

## 7.3 Thread

```json
{
  "id": "thread_xxx",
  "arcId": "arc_xxx",
  "type": "question",
  "status": "open",
  "summary": "세아가 왜 사라졌는가?",
  "participants": ["char_sea"],
  "introducedTurn": 8,
  "updatedTurn": 20,
  "resolvedTurn": 0,
  "evidence": {}
}
```

type:

```text
conflict
question
promise
goal
mystery
obligation
consequence
setup
other
```

status:

```text
open
resolved
transformed
superseded
```

중요:

**현재 5턴에서 언급되지 않았다는 이유로 open → resolved 하지 않는다.**

---

## 7.4 Turning Point

이미 발생한 중요한 전환만 저장한다.

```json
{
  "id": "turning_xxx",
  "summary": "준호가 마지막 목격자였음이 밝혀졌다.",
  "importance": "core",
  "throughTurn": 20,
  "evidence": {}
}
```

미래 예상 전환점은 저장 금지.

---

## 7.5 Narrative Lock

현재 Story Arc의 narrativeLocks 개념을 계승한다.

용도:

- 해결되지 않은 갈등을 함부로 해결하지 않기
- 아직 알려지지 않은 정보를 특정 인물이 이미 아는 것처럼 쓰지 않기
- 이미 발생한 중요한 결과를 되돌리지 않기
- payoff가 필요한 setup을 추적하기

Lock은 `해야 할 미래 사건`이 아니라 `현재 성립한 연속성 제약`이어야 한다.

---

## 7.6 Motif

반복적으로 직접 관찰된 경우만 선택적으로 저장한다.

- 상징
- 반복되는 행동/이미지
- 반복되는 관계 패턴

한 번 등장한 장식적 요소를 motif로 승격하지 않는다.

---

# 8. Narrative Delta

## 8.1 Continuity Delta에 네 번째 도메인 추가

권장:

```text
libra.continuity_delta.v2
```

예:

```json
{
  "schema": "libra.continuity_delta.v2",
  "memoryId": "...",
  "revision": 1,
  "turnRange": { "start": 16, "end": 20 },

  "characterPatch": {},
  "worldPatch": {},

  "narrativePatch": {
    "schema": "libra.narrative_patch.v1",
    "domain": "narrative",
    "source": "plot_ito",
    "summary": {},
    "arcs": [],
    "threads": [],
    "turningPoints": [],
    "locks": [],
    "motifs": []
  },

  "domains": {
    "character_relationship": {},
    "world": {},
    "narrative": {
      "status": "ready",
      "source": "plot_ito"
    }
  }
}
```

---

## 8.2 Narrative Patch operation

기본 operation:

```text
upsert
resolve
transform
supersede
clear_explicit
```

`delete because omitted`는 없다.

Plot ito는 현재 5턴에서 직접 성립한 변화만 Delta로 작성한다.

이전 Head의 모든 Arc/Thread를 매번 다시 출력할 필요가 없다.

---

# 9. Plot ito 출력 계약

기존 Plot ito의 serial patch JSON에 optional `narrative_patch`를 추가한다.

```json
{
  "schema": "libra.serial_draft_patch.v2",
  "stage": "plot_ito",
  "ok": true,
  "analysis": {},
  "domain": {},
  "rewrite_directives": [],
  "do_not_reveal": [],
  "pov_limits": [],
  "beats": [],
  "edits": [],
  "narrative_patch": {
    "schema": "libra.narrative_patch.v1",
    "domain": "narrative",
    "summary": {},
    "arcs": [],
    "threads": [],
    "turningPoints": [],
    "locks": [],
    "motifs": []
  }
}
```

Narrative patch의 신규 주장/변화에는 현재 5턴의 evidenceRefs/evidenceSpans를 요구한다.

기존 Head에서 계속 유지되는 thread를 단순 유지하기 위해 매번 evidence를 복사할 필요는 없다.

---

# 10. Plot 실패/비활성 fallback

## 10.1 Plot ito 비활성

Ariadne Narrative Seed를 로컬 `narrative_patch`로 변환한다.

source:

```text
ariadne_seed
```

보수적 fallback이므로:

- open/resolved thread는 artifact에 명시된 것만
- 새 Arc 과대 승격 금지
- turning point 과대 승격 금지
- motif 생성 금지
- 기존 open thread는 omission으로 해결하지 않음

---

## 10.2 Plot ito 실패

Canonical Memory는 이전 성공 stage draft를 사용한다.

Narrative는 Ariadne fallback.

domainStatus:

```json
{
  "status": "fallback",
  "source": "ariadne_seed",
  "reason": "plot_ito_failed"
}
```

---

# 11. Narrative Replay

Narrative는 별도 임의 상태 DB로 만들지 않고 기존 World Manager Replay에 참여한다.

```text
T1~5 delta
  Character
  Relationship
  World
  Narrative

→ boundary correction

T6~10 delta
  Character
  Relationship
  World
  Narrative

→ boundary correction
```

Current Head는 항상 다음으로 재생성 가능해야 한다.

```text
Active Canonical Deltas
+ Worldline
+ Rollback cutoff
+ User Corrections
= World Manager Current Head
```

---

# 12. 사용자 Correction

Narrative 편집은 canonical memory나 narrative delta를 직접 고치지 않는다.

Correction Event로 남긴다.

예:

```json
{
  "domain": "narrative",
  "atTurn": 20,
  "operation": "update_thread",
  "targetId": "thread_xxx",
  "patch": {
    "type": "question",
    "status": "open",
    "summary": "..."
  }
}
```

기존 0.3.14 Correction lifecycle을 동일하게 사용한다.

```text
active
suspended
dormant_after_rollback
superseded
deleted
```

basisFingerprint가 달라지면 자동 `suspended`.

Rollback 뒤의 correction은 `dormant_after_rollback`.

---

# 13. Reroll / Rollback / Worldline

## Reroll

같은 5턴의 새 canonical revision이 채택되면:

```text
old narrative delta → superseded
new narrative delta → active
replay
```

## Rollback

cutoff 뒤 Narrative Delta를 replay에서 제외한다.

해당 이후 사용자 Narrative Correction은 삭제하지 않고 휴면시킨다.

## Worldline

부모 worldline의 Narrative Delta를 분기 지점까지만 상속한다.

이후 자식 worldline은 독립 Narrative Delta를 쌓는다.

---

# 14. 수동 Canonical Memory 편집

수동 정본 수정은 특히 중요하다.

기존 0.3.14는 Character/World 상태 전용 재분석 경로를 갖고 있다.

Narrative에도 동일한 전략을 추가한다.

```text
사용자 canonical candidate 편집
→ canonical text 저장
→ Character state-only reanalysis
→ World state-only reanalysis
→ Plot narrative-only reanalysis (필요 시)
→ candidate comparison
→ 사용자 채택
```

이 `Plot narrative-only` 호출은 정상 5턴 파이프라인의 추가 호출이 아니다.

수동 정본 수정/과거 revision 복원처럼 기존 Narrative Delta가 stale해진 특수 작업에만 실행한다.

실패하면 candidate는 review_required 상태로 남기고 활성 정본은 자동으로 오염시키지 않는다.

---

# 15. Story Arc → Narrative 마이그레이션

| Story Arc v1 | 새 위치 | 처리 |
|---|---|---|
| summary | Narrative.summary | 이관 |
| currentNarrativeState | Narrative.summary / primary Arc summary | 이관 |
| currentPhase | Arc.phase | 정규화 후 이관 |
| centralPressure | Arc.centralPressure | 이관 |
| activeThreads | Narrative.threads(open) | 이관 |
| resolvedThreads | Narrative.threads(resolved) | 이관 |
| narrativeLocks | Narrative.locks | 이관 |
| openQuestions | threads(type=question) | 이관 |
| pendingPromises | threads(type=promise) | 이관 |
| recentTurningPoints | turningPoints | 이관 |
| relationshipTrajectories | Relationship cross-reference | 사실 중복 저장 최소화 |
| continuityWarnings | Diagnostics | 메인 상태에서 분리 |
| compressedHistory | 직접 이관 안 함 | Canonical/Delta history 사용 |
| destination.goal | Planner Narrative Direction | user/user_locked만 이관 |
| destination.completionConditions | Planner Narrative Direction | user/user_locked만 이관 |
| destination.doNotForce | Planner constraints | user/user_locked만 이관 |
| inferred destination | 이관 안 함 | 미래 추론을 사실로 만들지 않음 |
| planned beats | Planner soft route | 사용자 명시 정보만 보존 |
| beatLedger(actual) | Narrative turning points / actual ledger | 실제 발생분만 이관 |
| narrativeRecall | Narrative diagnostics | 로직 재사용 |
| Director mode | 제거 | Plot ito가 담당 |
| Story Arc preset | 제거 | Plot ito preset 사용 |

---

# 16. Legacy Story Arc 처리 정책

기존 `...:story-arc`를 즉시 삭제하지 않는다.

1. Narrative v1이 없는 scope에서만 migration 시도
2. Story Arc 읽기
3. Narrative Head/Correction/Planner Direction으로 변환
4. read-back 검증
5. `story-arc-migration:v1` marker 기록
6. 이후 Story Arc는 runtime write 중지
7. 기존 key는 read-only quarantine으로 남김
8. 별도 cleanup은 이후 버전에서 수동/명시적으로만 수행

목표는 데이터 안전성과 rollback 가능성이다.

---

# 17. Narrative Recall

현재 Story Arc의 call-free Narrative Recall 로직은 폐기하지 않고 재사용한다.

새 역할:

```text
Narrative Continuity Recall
```

목적:

- 과거와 동일한 thread인지 확인
- 오래된 promise/question 재등장 매칭
- arc stable ID 유지 보조
- 비슷한 사건을 새 Arc로 중복 생성하는 것을 방지

권위:

```text
현재 5턴 직접 증거 > Current Narrative Head > Narrative Recall
```

Recall이 새 사건을 만들 수는 없다.

정상 응답 생성 경로에서 전체 canonical history를 반복 읽지 않도록 캐시/기존 recall catalog를 사용한다.

---

# 18. Planner로 이동할 Story Arc 기능

Story Arc의 Direction Settings는 World Manager Narrative에 남기지 않는다.

Planner에 새 영역:

```text
Planner
└─ 서사 방향
   ├─ 사용자 방향
   ├─ 완료 조건
   ├─ 피해야 할 전개
   └─ 선택적 soft route
```

이 데이터는 사실 상태가 아니라 user directive다.

Narrative Head는 Planner가 참고하지만,
Planner의 미래 계획은 Narrative에 역주입되지 않는다.

---

# 19. 응답 생성 주입

## Planner

기존 Story Arc prompt 대신 Narrative prompt를 받는다.

주입 내용:

- current summary
- active arcs
- open threads
- important narrative locks
- recent turning points
- unresolved promises/questions

`recommended next beats`는 Narrative에서 제공하지 않는다.

그것은 Planner가 현재 사용자 입력을 보고 생성한다.

---

## SGA / GRADIA 계층

기존 `story_arc` material을 `narrative_state`로 교체한다.

- SHADOW: 전체 compact Narrative
- Character AIDE: 관련 Arc/Thread 최소 subset
- World AIDE: world-linked Arc/Thread 최소 subset
- Plot AIDE: narrative subset + locks + turning points

Narrative는 direct evidence와 current input보다 높은 권위가 아니다.

---

## Classic

기본 동작 변경 없음.

Classic은 기존 canonical recall만 사용한다.

World Manager Narrative를 직접 주입하지 않는다.

---

# 20. GUI

## 20.1 Sidebar

기존:

```text
Home
Memory
Prompts
Story Arc
References
Connections
Settings & Diagnostics
```

변경:

```text
Home
Memory
World Manager
Prompts
References
Connections
Settings & Diagnostics
```

Story Arc standalone hub 제거.

legacy deep link:

```text
story_arc*
→ world_manager / narrative
```

---

## 20.2 World Manager 내부

```text
World Manager
├─ 개요
├─ 인물
├─ 관계
├─ 세계
├─ 내러티브
└─ 기록 / 교정
```

---

## 20.3 Narrative 화면

상단:

- Narrative 상태
- 확정 TURN
- source badge
  - Plot ito
  - Ariadne fallback
- current worldline

본문:

### 현재 내러티브
- overall summary
- primary arc
- phase
- current pressure / momentum

### 진행 중 Arc
- 제목
- 상태
- 관련 인물
- 핵심 압력

### 열린 Thread
- 갈등
- 질문
- 약속
- 목표
- 미해결 결과

### 최근 전환점

### Narrative Locks

편집 버튼은 Correction Event를 생성한다.

정본/Delta 직접 수정 금지.

---

## 20.4 Story Arc 기존 Direction UI

World Manager로 가져오지 않는다.

Planner의 `서사 방향` 페이지로 이동한다.

---

## 20.5 Advanced

Narrative 고급/진단에서는 다음만 제공:

- source memory/revision
- delta source
- plot/fallback 상태
- correction provenance
- replay fingerprint
- migration state
- narrative recall diagnostics

별도 Story Arc Director preset/UI는 제거한다.

---

# 21. 저장량 / 성능 제한

Current Narrative Head는 bounded state다.

권장 상한:

```text
arcs               24
threads            96
turningPoints      64
locks              24
motifs             24
Narrative prompt   7,000 chars soft cap
Plot narrative JSON 약 800~1,200 output tokens 목표
```

오래된 resolved item을 Head에 무한 누적하지 않는다.

과거 정보는 canonical memories / narrative deltas에서 복원 가능하다.

GUI는 모든 Delta를 첫 화면에서 로딩하지 않는다.

- Head 우선
- History 탭을 열 때 delta lazy load
- 상세 correction도 선택 시 로드

---

# 22. API

새 public API 권장:

```js
__LIBRA__.getWorldManagerNarrative()
__LIBRA__.rebuildWorldManagerNarrative()
__LIBRA__.addWorldManagerNarrativeCorrection()
__LIBRA__.setWorldManagerNarrativeCorrectionStatus()
__LIBRA__.getWorldManagerNarrativeHistory()
```

기존:

```js
getStoryArc()
rebuildStoryArc()
setStoryArcDestination()
```

처리:

- `getStoryArc()` / `rebuildStoryArc()`는 한시적 compatibility adapter
- `setStoryArcDestination()`은 Planner Narrative Direction API로 redirect
- 신규 코드에서는 사용 금지

---

# 23. Handoff / RE:TRACE / Portable Restore

Narrative는 continuity delta v2 안에 포함되므로,
별도 Story Arc seed를 정본 상태로 전달하지 않는다.

전달 대상:

- canonical memories
- active manifest
- continuity/narrative deltas
- world manager corrections
- worldline meta
- Planner의 명시적 user narrative direction

RE:TRACE handoff 완료 후 기존과 동일하게:

```text
rebuildWorldManagerState()
```

를 호출하면 Character/Relationship/World/Narrative가 한 번에 재생성된다.

원본 세션 데이터는 삭제/이동/compact하지 않는다.

---

# 24. 권위 순서

Narrative 관련 충돌 시:

```text
1. 현재 사용자 입력 / 현재 직접 U+A 증거
2. 현재 5턴 canonical artifact
3. 사용자 World Manager Correction
4. 활성 canonical Narrative Delta
5. Current Narrative Head
6. Narrative Recall
7. Lore/reference
8. Planner의 미래 제안
```

Planner 제안이 Narrative fact를 덮어쓰면 안 된다.

---

# 25. 완료 상태의 최종 구조

```text
LIBRA

Canonical Memory
├─ 5턴 사실 기록
├─ retrieval projection
└─ embedding

World Manager
├─ Character
├─ Relationship
├─ World
└─ Narrative
    ├─ Arcs
    ├─ Threads
    ├─ Turning Points
    ├─ Locks
    └─ Momentum

World Manager Replay
├─ Canonical Delta
├─ Correction Journal
├─ Worldline
└─ Rollback

Planner
├─ Current input
├─ Live Tail
├─ Canonical recall
├─ World Manager
└─ Narrative Direction (future/user directive)

SGA
└─ compact World Manager / Narrative reference
```

---

# 26. 최종 결정 요약

이 설계에서 Story Arc는 다음처럼 해체된다.

```text
Story Arc의 현재 서사 추적
→ World Manager / Narrative

Story Arc의 미래 방향·soft route
→ Planner

Story Arc Director 별도 LLM
→ 제거

Ariadne
→ Narrative Seed

Plot ito
→ Narrative Final Delta

Replay
→ Narrative Current Head
```

이 방식은 과거 World Manager Narrative의 유용한 `storyline / current context /
open threads / ongoing tensions` 개념을 되살리면서도,
현재 LIBRA의 더 강한 canonical 5-turn / revision / replay / worldline 구조를 유지한다.

가장 중요한 원칙은 다음 한 문장이다.

> Narrative는 미래를 계획하는 계층이 아니라, 현재까지 실제로 형성된 이야기의 상태를 추적하는 World Manager의 네 번째 축이다.
