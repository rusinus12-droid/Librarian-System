# LIBRA World Manager Narrative V1
# 구현 계획서
## Story Arc → World Manager / Narrative 통합
### 기준: Librarian System 0.3.14
### 작성일: 2026-08-30

> **문서 상태 — 2026-09-04:** 역사적 구현 계획. 현재 LIBRA 2.3.24의 활성 backlog로 사용하지 않는다. Story Arc retirement, Narrative State/Direction 분리와 관련 후속 구현은 이후 버전 및 현재 회귀를 기준으로 판정한다. 아래 미체크 항목은 당시 실행 계획의 기록이다.

---

# 0. 구현 목표

현재 `PROGRAM/plugins/LIBRA.js`의 Story Arc를 World Manager Narrative로 이전한다.

정상 분석 호출 수를 늘리지 않는다.

핵심 실행 경로:

```text
Ariadne
→ Narrative Seed(local)
→ Character ito
→ World ito
→ Plot ito + Narrative Patch
→ Canonical Commit
→ Continuity Delta v2
→ World Manager Replay
→ Narrative Current Head
```

---

# 1. 작업 원칙

1. 한 번에 Story Arc 코드를 대량 삭제하지 않는다.
2. 새 Narrative 경로를 먼저 만들고 테스트한 뒤 consumer를 교체한다.
3. 기존 `story-arc` key는 migration 완료 후에도 즉시 삭제하지 않는다.
4. Canonical Memory와 embedding은 이 작업으로 rewrite하지 않는다.
5. 정상 5턴 파이프라인의 provider call count를 증가시키지 않는다.
6. Plot ito 실패는 memory commit을 막지 않는다.
7. Narrative 오류는 Character/World 상태 추적을 막지 않는다.
8. Narrative와 Planner 미래 방향을 절대 같은 schema에 저장하지 않는다.
9. 모든 revision/rollback/worldline 테스트가 통과하기 전 GUI 삭제를 진행하지 않는다.
10. 실제 구현 완료 시 전체 regression을 실행한다.

---

# 2. Phase 0 — 기준선 동결 및 테스트 추가

## 대상

- `PROGRAM/plugins/LIBRA.js`
- `PROGRAM/plugins/RETRACE.js`
- `PROGRAM/tests/`

## 먼저 추가할 회귀 테스트

- 기존 Story Arc current-state 생성
- Story Arc destination 저장
- Planner Story Arc consume
- SGA Story Arc consume
- portable archive/copy Story Arc 처리
- RE:TRACE world manager rebuild
- continuity-state replay v2 현행 테스트
- canonical candidate edit/adopt
- failed ito fail-soft

## 목적

새 Narrative를 구현하다 기존 기능이 사라졌을 때 원인을 즉시 확인하기 위함.

## 완료 조건

변경 전 전체 테스트 PASS snapshot 확보.

---

# 3. Phase 1 — Narrative schema/normalizer 구현

## 3.1 상수 추가

`LIBRA.js` continuity schema 부근에 추가:

```js
NARRATIVE_STATE_SCHEMA = 'libra.narrative_state.v1'
NARRATIVE_SEED_SCHEMA = 'libra.narrative_seed.v1'
NARRATIVE_PATCH_SCHEMA = 'libra.narrative_patch.v1'
NARRATIVE_MIGRATION_SCHEMA = 'libra.story_arc_to_narrative_migration.v1'
```

Continuity:

```js
CONTINUITY_STATE_SCHEMA_V1 = 'libra.continuity_state.v1'
CONTINUITY_STATE_SCHEMA = 'libra.continuity_state.v2'

CONTINUITY_DELTA_SCHEMA_V1 = 'libra.continuity_delta.v1'
CONTINUITY_DELTA_SCHEMA = 'libra.continuity_delta.v2'
```

v1 loader는 read-compatible 유지.

---

## 3.2 Narrative limits

```js
NARRATIVE_MAX_ARCS = 24
NARRATIVE_MAX_THREADS = 96
NARRATIVE_MAX_TURNING_POINTS = 64
NARRATIVE_MAX_LOCKS = 24
NARRATIVE_MAX_MOTIFS = 24
NARRATIVE_PROMPT_MAX_CHARS = 7000
```

---

## 3.3 normalizer

새 함수:

```js
normalizeNarrativeState()
normalizeNarrativeArc()
normalizeNarrativeThread()
normalizeNarrativeTurningPoint()
normalizeNarrativeLock()
normalizeNarrativeMotif()
normalizeNarrativePatch()
```

필수 방어:

- forbidden prototype keys
- depth 제한
- array 상한
- text char 상한
- stable ID 정규화
- status enum
- phase enum
- evidence normalization
- unknown extra field drop

## 완료 조건

악성/깨진 JSON, 과대 배열, unknown status가 head를 깨지 못함.

---

# 4. Phase 2 — Continuity Head v2

## 수정 함수

현행:

```js
emptyContinuityState()
normalizeContinuityStateHead()
pruneContinuityStateHeadToRefs()
updateContinuityStateAfterCommit()
rebuildContinuityForManifest()
```

## 변경

기존:

```js
characters
relationships
world
```

추가:

```js
narrative
domainStatus.narrative
```

## v1 migration normalization

v1 state를 읽으면:

```js
narrative = emptyNarrativeState()
domainStatus.narrative = { status:'empty', reason:'legacy_v1_head' }
```

로 정상화.

기존 Character/Relationship/World 데이터 byte-semantic 유지.

## 완료 조건

0.3.14의 기존 continuity-state를 읽었을 때 기존 세 도메인이 변하지 않음.

---

# 5. Phase 3 — Ariadne Narrative Seed

## patch point

현행:

```js
callAriadne()
```

Ariadne typed artifact validation 성공 후:

```js
const narrativeSeed = buildNarrativeSeedFromCanonicalArtifact(artifact, batch)
```

추가.

stageObject에 work-stage field:

```js
narrativeSeed
```

추가.

receipt에는 전체 Seed를 저장하지 않는다.

diagnostic summary만 저장:

```js
narrativeSeedMeta
```

---

## 새 함수

```js
buildNarrativeSeedFromCanonicalArtifact(artifact, batch)
narrativeSeedToFallbackPatch(seed, previousNarrative)
```

## Seed 작성 규칙

- openThreads status 유지
- resolved 명시만 resolved
- uncertainty 확정 금지
- chronology에서 event 후보 생성
- 관계/세계 변화는 candidate pressure만
- future language 생성 금지

## 완료 조건

Ariadne provider contract/schema를 변경하지 않고 Seed가 생성됨.

---

# 6. Phase 4 — Memory ito 실행 순서 정리

## 현재 위험

현행 설정은 Plot ito가 Character/World보다 먼저 실행되는 순서를 허용한다.

Narrative finalizer로 사용하려면 Plot ito가 terminal이어야 한다.

## 구현

Memory Pipeline의 effective order를 다음 규칙으로 normalize:

```js
nonPlot = configuredOrder.filter(id => id !== 'plot_ito')
effective = [...nonPlot, 'plot_ito']
```

단:

- Plot 비활성 → 추가하지 않음
- Character/World 비활성 → 제외
- SGA AIDE order는 변경하지 않음

GUI에서도 Memory Pipeline의 Plot ito 순서 이동 제어는 제거/잠금.

## 완료 조건

Narrative enabled + Plot enabled 상태에서 Plot은 항상 마지막 provider call.

---

# 7. Phase 5 — Plot Narrative Finalization Packet

## patch point

현행:

```js
itoPrompts(stageName, batch, draft, loreContext)
callIto(stageName, batch, previousStage)
```

Plot 전용 options 추가:

```js
narrativeContext
```

## build 함수

```js
buildPlotNarrativeFinalizationPacket({
  scope,
  manifest,
  previousNarrative,
  ariadneSeed,
  characterStage,
  worldStage,
  currentDraft,
  batch
})
```

포함:

- Previous Narrative Head
- Ariadne Seed
- effective Character/Relationship patch
- effective World patch
- optional Narrative Continuity Recall
- current canonical draft

## prompt budget

Packet은 구조화 compact.

권장 soft max:

```text
6,000~8,000 chars
```

초과 시 우선순위:

1. open threads
2. active arcs
3. current pressure
4. relevant locks
5. recent turning points
6. recall evidence
7. old resolved history

## 완료 조건

긴 채팅에서도 Plot prompt가 이전 Narrative 전체 history를 무제한 포함하지 않음.

---

# 8. Phase 6 — Plot ito JSON contract 확장

## 현행

`SERIAL_DRAFT_PATCH_SCHEMA`

## 변경

Plot stage에서만 optional:

```json
"narrative_patch": {}
```

추가.

Character/World ito schema는 그대로.

## parser

```js
normalizeAidePatchResult()
```

에서 Plot `narrative_patch`를 분리 검증.

중요:

```text
canonical edits validation
≠
narrative patch validation
```

Narrative patch validation 실패가 canonical edits를 무효화하면 안 된다.

## 결과

stage object:

```js
narrativePatch
narrativePatchStatus
```

receipt에는 full prompt-internal data 대신 compact meta.

---

# 9. Phase 7 — Plot 실패 fallback

Pipeline 완료 시 effective narrative patch 결정:

```js
if (plotStage?.narrativePatchValid)
    use plot patch
else
    use narrativeSeedToFallbackPatch(ariadneSeed)
```

domain status:

```text
ready      / plot_ito
fallback   / ariadne_seed
failed     / no_safe_narrative_patch
empty      / no_narrative_change
```

## 완료 조건

Plot provider timeout/refusal/invalid JSON에도 canonical memory commit 성공.

---

# 10. Phase 8 — Continuity Delta v2

## 수정

현행:

```js
continuityDeltaFromStageObjects()
continuityDeltaFromCanonicalArtifact()
saveContinuityDelta()
loadContinuityDelta()
```

추가:

```js
narrativePatch
domains.narrative
```

## v1 읽기

기존 delta v1은:

```js
narrativePatch = null
domains.narrative = legacy_empty
```

로 취급.

## 완료 조건

기존 delta v1 history replay가 깨지지 않음.

---

# 11. Phase 9 — Narrative Replay

## 새 함수

```js
applyNarrativePatch()
applyNarrativeArcOperation()
applyNarrativeThreadOperation()
applyNarrativeTurningPointOperation()
applyNarrativeLockOperation()
applyNarrativeMotifOperation()
```

## 규칙

- omission = keep
- explicit resolve만 resolve
- stable ID 우선
- ID 없을 때 semantic match는 매우 보수적
- resolved old thread head retention은 bounded
- superseded 기록은 delta/history에서 추적
- head에 무한 history 축적 금지

## replay 순서

각 canonical boundary:

```text
characterPatch
relationshipPatch
worldPatch
narrativePatch
correction events
```

## 완료 조건

같은 delta 집합을 여러 번 replay해 동일 fingerprint/head 생성.

---

# 12. Phase 10 — Correction Journal Narrative 지원

## 현행

0.3.14:

```text
state-corrections:v2
```

## 권장

기존 journal을 유지하면서 event domain에 `narrative` 추가.

새 key를 만들지 않아도 됨.

이유:

- 하나의 World Manager correction time axis 유지
- rollback/worldline lifecycle 재사용
- migration 부담 감소

## 지원 operation

```text
update_summary
upsert_arc
set_arc_status
upsert_thread
set_thread_status
upsert_lock
remove_lock_explicit
upsert_turning_point
delete_explicit
```

## 완료 조건

Narrative correction도 기존 active/suspended/dormant/superseded/deleted lifecycle을 사용.

---

# 13. Phase 11 — Story Arc migration

## 새 함수

```js
migrateStoryArcToNarrativeIfNeeded()
storyArcToNarrativeState()
storyArcDestinationToPlannerDirection()
```

## migration 시점

scope load 직후 즉시 무거운 작업을 하지 않는다.

다음 시점 중 하나에서 lazy migration:

- World Manager 열기
- Narrative가 필요한 Planner/SGA 요청
- canonical commit 후
- explicit rebuild

## migration 절차

1. Narrative head 존재 여부 확인
2. legacy story-arc 읽기
3. factual fields 변환
4. explicit user destination 별도 Planner key 변환
5. new head 저장
6. readback 검증
7. marker 저장
8. old story-arc write 금지

## marker

```text
...:story-arc-migration:v1
```

## 실패

기존 story-arc 삭제 금지.
새 head 덮어쓰기 금지.

---

# 14. Phase 12 — Story Arc Director 제거

삭제/비활성 대상:

```text
STORY_ARC_STAGE_ID provider route
Story Arc Director call
story_arc_preset
storyArcUpdateMode = director
refineStoryArcWithDirector()
별도 Director rebuild button
```

단계적으로 제거.

첫 구현에서는 compatibility wrapper로 남겨도 되지만 runtime에서 provider call하면 안 된다.

## 완료 조건

정상 canonical commit 시 Story Arc/Narrative 때문에 별도 provider call이 0회.

---

# 15. Phase 13 — Story Arc factual engine 대체

현행:

```js
storyArcRecord()
storyArcDerivedFromMemory()
deriveStoryArcFromCanonicalHistory()
updateStoryArcAfterCommit()
rebuildStoryArc()
ensureStoryArcForResponse()
storyArcPromptBlock()
```

대체:

```js
getWorldManagerNarrative()
rebuildWorldManagerNarrative()
ensureNarrativeForResponse()
narrativePromptBlock()
```

중요:

`deriveStoryArcFromCanonicalHistory()`의 유용한 call-free narrative recall/분류 로직은
전부 버리지 말고 다음으로 재사용:

```js
NarrativeContinuityRecall
legacy migration helper
fallback seed matching
```

---

# 16. Phase 14 — Commit path 통합

현행 canonical commit 이후:

```text
save continuity delta
update continuity state
update Story Arc
```

변경:

```text
save continuity delta v2
  └─ narrativePatch 포함

rebuild/advance World Manager Head
  ├─ Character
  ├─ Relationship
  ├─ World
  └─ Narrative

Story Arc post-commit writer 없음
```

## 완료 조건

한 canonical revision에 World Manager side product가 두 번 작성되지 않음.

---

# 17. Phase 15 — Candidate edit / regeneration

## 현행 관련 구간

- candidate generation
- canonical edit
- state-only rebuild
- adoption
- `updateStoryArcAfterCommit()` 호출

## 변경

candidate side product:

```text
character state delta
world state delta
narrative delta
```

manual edit 시:

```js
callContinuityDeltaProvider(character_ito)
callContinuityDeltaProvider(world_ito)
callNarrativeDeltaProvider(plot_ito)
```

`callNarrativeDeltaProvider()`는 특수 재분석용.

정상 5턴 commit에는 호출하지 않음.

## adoption

candidate 채택 후:

```text
old revision delta superseded
candidate delta active
World Manager replay
```

별도 Story Arc rebuild 호출 제거.

---

# 18. Phase 16 — Planner consumer 교체

## 현행

```js
storyArcPromptBlock()
mergeStoryArcIntoPlanner()
evidencePacket.story_arc
```

## 변경

```js
narrativePromptBlock()
mergeNarrativeIntoPlanner()
evidencePacket.narrative_state
```

Narrative → Planner로 제공:

- current summary
- open threads
- active arc
- locks
- turning points
- pending promises/questions

제공 금지:

- future beats
- recommended route

Planner가 현재 user input을 보고 next beats를 새로 작성.

---

# 19. Phase 17 — SGA consumer 교체

현행:

```text
story_arc
storyArc meta
Story Arc continuity locks
```

변경:

```text
narrative_state
Narrative revision/fingerprint
Narrative locks
```

Material Use Manifest도:

```text
storyArc
→ narrative
```

으로 전환.

한시적으로 old field alias를 읽을 수 있으나 새 run에는 new field만 기록.

---

# 20. Phase 18 — Input Writer / 기타 consumer 점검

`storyArc` 문자열 전체 검색 후 다음 분류:

1. Planner runtime
2. SGA runtime
3. Input Writer
4. diagnostics
5. GUI
6. backup/restore
7. migration
8. comments/tests

각 runtime consumer가 future Story Arc beats에 의존하고 있다면 Planner direction으로 변경.

Classic recall은 변경하지 않는다.

---

# 21. Phase 19 — GUI 재구성

## sidebar

`Story Arc` 제거.

`World Manager` 추가/확장.

## section routing

legacy:

```text
story_arc_current
story_arc_direction
story_arc_advanced
```

redirect:

```text
world_manager_narrative
planner_narrative_direction
world_manager_narrative_advanced
```

## Narrative panel 함수

신규:

```js
buildWorldManagerPanel()
buildWorldManagerOverviewPanel()
buildWorldManagerCharacterPanel()
buildWorldManagerRelationshipPanel()
buildWorldManagerWorldPanel()
buildWorldManagerNarrativePanel()
buildWorldManagerHistoryPanel()
```

## Narrative 화면 첫 렌더

전체 delta history 로딩 금지.

첫 렌더:

```text
Current Head only
```

History/Correction은 lazy load.

---

# 22. Phase 20 — Planner Direction UI

Story Arc Direction Settings를 Planner로 이동.

storage:

```text
...:planner-narrative-direction:v1
```

권장 fields:

```json
{
  "goal": "",
  "completionConditions": [],
  "doNotForce": [],
  "locked": false,
  "source": "user"
}
```

자동 inferred destination은 persistent directive로 마이그레이션하지 않는다.

---

# 23. Phase 21 — Handoff / portable archive / restore

검색 대상:

```text
storyArcSeed
storyArc
key.storyArc
STORY_ARC_SCHEMA
```

## 새 계약

Narrative는 continuity delta v2에 포함.

따라서 handoff 핵심은:

- deltas 포함 검증
- correction journal 포함
- worldline meta 포함
- current head는 rebuild 가능 materialized view

Planner user direction만 별도 transferable directive.

## RE:TRACE

현재 `rebuildWorldManagerState()` bridge를 유지.

handoff 성공 후 narrative도 같은 replay로 재구축.

---

# 24. Phase 22 — Backup / recovery / scope deletion

다음 계약 갱신:

- backup export
- restore preflight
- portable graph validation
- rollback journal
- scope delete
- orphan detection
- checksum/build manifest

legacy `story-arc`는 migration backup으로 인식하되
신규 active product로 인식하지 않는다.

---

# 25. Phase 23 — Public API

추가:

```js
getWorldManagerNarrative
rebuildWorldManagerNarrative
addWorldManagerNarrativeCorrection
setWorldManagerNarrativeCorrectionStatus
getWorldManagerNarrativeHistory
```

deprecated adapter:

```js
getStoryArc
rebuildStoryArc
setStoryArcDestination
```

`setStoryArcDestination`은 Planner direction API로 redirect.

---

# 26. Phase 24 — 테스트 매트릭스

## A. 정상 파이프라인

- Ariadne only
- Ariadne + Character
- Ariadne + World
- Ariadne + Character + World
- Ariadne + Plot
- Ariadne + Character + World + Plot

확인:

- call count 증가 없음
- Plot enabled 시 terminal
- narrative source 정확

---

## B. 실패

- Character failure
- World failure
- Plot failure
- Plot invalid narrative JSON
- Plot valid canonical edits + invalid narrative patch
- storage write failure
- replay failure

확인:

- Ariadne 성공 정본 유실 없음
- 기존 정상 Head 보존
- error journal 기록

---

## C. Narrative 의미

- 새 thread 생성
- 기존 thread 유지
- omission으로 resolve되지 않음
- explicit resolve
- transformed thread
- 새 Arc
- dormant Arc 재활성
- turning point
- narrative lock
- repeated motif만 motif 승격

---

## D. revision

- same 5-turn reroll
- candidate adopt
- restore old revision
- manual canonical edit
- narrative-only reanalysis failure

---

## E. worldline

- branch at T10
- parent narrative inherited through T10
- child T11~ independent
- worldline switch
- rollback
- rollback 후 correction dormant
- forward branch 재활성

---

## F. correction

- summary edit
- thread status edit
- arc title edit
- lock edit
- basisFingerprint mismatch → suspended
- delete → replay exclude

---

## G. Story Arc migration

입력 Story Arc 각각 테스트:

- activeThreads
- resolvedThreads
- openQuestions
- pendingPromises
- locks
- turning points
- user locked destination
- inferred destination
- beats
- actual beat ledger

검증:

- factual/future 경계가 지켜짐
- inferred future가 Narrative fact가 되지 않음

---

## H. 소비자

- Planner
- SGA SHADOW
- Character AIDE
- World AIDE
- Plot AIDE
- Input Writer
- Classic no-op

---

## I. handoff

- same chat restore
- cross-chat copy
- archive handoff
- RE:TRACE next session
- original source data unchanged

---

# 27. 성능 검증

## 필수 계약

- 정상 5턴 LLM call count 변화 없음
- Response path에서 full canonical history scan 금지
- Narrative Current Head bounded
- History tab lazy load
- Plot packet bounded
- no recursive nested provider call
- replay는 delta 기반
- GUI first open에서 narrative history 전부 stringify 금지

## benchmark

다음 데이터 크기:

```text
40 turns
160 turns
400 turns
1000 turns synthetic
```

측정:

- World Manager open latency
- Narrative tab open latency
- replay time
- storage reads/writes
- prompt chars
- heap growth
- reroll latency

---

# 28. 코드 검색 체크리스트

구현 완료 전 `LIBRA.js`에서 다음 문자열을 전체 검색한다.

```text
STORY_ARC_
storyArc
story_arc
Story Arc
StoryArc
key.storyArc
storyArcSeed
mergeStoryArcIntoPlanner
storyArcPromptBlock
updateStoryArcAfterCommit
rebuildStoryArc
buildLibraStoryArcPanel
```

각 occurrence를:

```text
migrated
compatibility-only
legacy-quarantine
test/comment only
```

중 하나로 분류.

설명 없이 active runtime Story Arc writer가 남아 있으면 완료 아님.

---

# 29. 구현 순서 요약

```text
[1] baseline tests
[2] Narrative schemas
[3] Continuity Head v2
[4] Ariadne Seed
[5] Plot terminal order
[6] Plot Narrative Packet
[7] Plot narrative_patch
[8] Ariadne fallback
[9] Delta v2
[10] Replay
[11] Correction
[12] Story Arc migration
[13] Story Arc Director retire
[14] Commit path
[15] Candidate edit
[16] Planner
[17] SGA
[18] Other consumers
[19] GUI
[20] Planner Direction
[21] Handoff/restore
[22] API
[23] Regression/performance
[24] Packaging
```

---

# 30. 완료 판정 기준

다음 조건을 모두 만족해야 구현 완료로 판정한다.

- [ ] World Manager에 Character/Relationship/World/Narrative 네 도메인이 표시된다.
- [ ] Story Arc standalone hub가 신규 runtime에서 제거되었다.
- [ ] Ariadne 성공 시 Narrative Seed가 생성된다.
- [ ] Plot ito 활성 시 기존 호출 안에서 Narrative Delta가 생성된다.
- [ ] Plot ito가 Narrative enabled memory pipeline의 terminal stage다.
- [ ] Plot 실패 시 Ariadne fallback이 동작한다.
- [ ] Plot Narrative 오류가 canonical memory commit을 막지 않는다.
- [ ] 정상 5턴 provider call count가 증가하지 않는다.
- [ ] Narrative Delta가 continuity delta revision에 결합된다.
- [ ] replay로 동일 Narrative Head를 결정론적으로 재구성할 수 있다.
- [ ] reroll/rollback/worldline이 Narrative에도 적용된다.
- [ ] user Narrative correction이 correction journal을 사용한다.
- [ ] Story Arc factual state가 Narrative로 안전하게 migration된다.
- [ ] Story Arc future direction은 Planner로 이동한다.
- [ ] inferred future route가 Narrative fact로 이관되지 않는다.
- [ ] Planner/SGA가 Story Arc 대신 Narrative를 사용한다.
- [ ] Classic recall은 기존 동작을 유지한다.
- [ ] native copy / portable restore / RE:TRACE handoff가 Narrative를 보존한다.
- [ ] 원본 세션 데이터가 handoff 과정에서 삭제/이동되지 않는다.
- [ ] 기존 0.3.14 Character/Relationship/World state regression이 없다.
- [ ] 전체 test suite PASS.
- [ ] ZIP CRC/SHA-256 검증 PASS.

---

# 31. 구현 시 가장 먼저 피해야 할 실수

1. Story Arc 코드를 먼저 삭제하고 Narrative를 나중에 만드는 것
2. Narrative에 future beats를 그대로 옮기는 것
3. Plot ito를 별도 추가 호출하는 것
4. Plot 실패 때문에 canonical memory를 버리는 것
5. 기존 open thread를 이번 5턴에 안 나왔다는 이유로 resolve하는 것
6. Narrative history를 Head에 무한 누적하는 것
7. Narrative를 별도 lorebook/별도 archive로 다시 만드는 것
8. Character/World state와 Narrative에서 같은 사실을 서로 다른 형태로 중복 누적하는 것
9. manual edit 후 stale narrative delta를 자동 활성화하는 것
10. RE:TRACE handoff에서 source session Narrative/delta를 이동하거나 삭제하는 것

---

# 32. 최종 구현 방향

기존 Story Arc를 그대로 `Narrative`라고 rename하지 않는다.

다음처럼 재배치한다.

```text
Story Arc factual continuity
        ↓
World Manager Narrative

Story Arc future direction
        ↓
Planner Narrative Direction

Story Arc Director call
        ↓
삭제

Ariadne artifact
        ↓
Narrative Seed

Plot ito existing call
        ↓
Narrative Delta

Delta + Correction + Worldline
        ↓
World Manager Replay
        ↓
Narrative Current Head
```

이 순서대로 구현하면 현재 0.3.14의 canonical/revision/replay 구조를 깨지 않고
예전 World Manager Narrative의 장점을 현대 LIBRA 구조 안에서 되살릴 수 있다.
