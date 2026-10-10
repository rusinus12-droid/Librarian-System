# LIBRA 2.3.24 ↔ Librarian Book UX v5.8 1:1 대응 감사

- 감사일: 2026-09-04
- 코드 기준: `LIBRA.js` v2.3.24 (`//@version 2.3.24`, `PLUGIN_VERSION='2.3.24'`)
- 예시 GUI 기준: `LIBRA_Librarian_Book_UX_Concept_v5_8_MOBILE_REFINED.html`
- 판정 기준:
  - **완전 대응**: 코드의 데이터/동작/편집 권위가 GUI에서 손실 없이 접근 가능
  - **부분 대응**: 핵심 의미는 대응하지만 일부 필드·작업·진단 경로가 누락
  - **목업 전용**: GUI에 있으나 현재 코드의 동일한 런타임 계약/설정키가 없음
  - **코드 전용**: 코드에는 있으나 예시 GUI에서 접근 경로가 없음

---

## 1. 최종 결론

**현재 상태는 1:1 완전 대응이 아니다.**

다만 다음 영역은 구조적으로 매우 잘 맞는다.

- Canonical Memory를 책처럼 읽는 Reader UX
- Character Current Head를 인물 소개로 재투영하는 UX
- Relationship을 Character 화면에 함께 읽히게 하는 방향
- World Current Head를 세계관 도감으로 재투영하는 UX
- Narrative Arc/Thread를 목차형으로 재투영하는 UX
- Settings Room의 8개 대분류
- Reference 설정의 3개 하위 분류
- LIBRA/GRADIA 메인 모드와 기본 Quick Settings 일부

반대로 아래 4개 코드 페이지군은 예시 GUI에 **독립적 접근 경로가 없다.**

1. Pipeline
2. Agents
3. Custom / Prompt Studio / OOC
4. Execution Logs

그리고 Memory/Character/Relationship/World/Narrative의 **구조 보기 · Evidence · Correction · History**가 Reader 화면에 충분히 연결되지 않았다.

---

## 2. 실제 LIBRA 최상위 GUI 구조

`LIBRA.js`의 `SHARED_SIDEBAR_PAGE_REGISTRY`에는 12개 최상위 페이지가 있다.

1. memory
2. characters
3. relationships
4. world
5. narrative
6. pipeline
7. agents
8. custom
9. ai
10. embedding
11. logs
12. settings

예시 GUI v5.8의 최상위 페이지는 6개다.

1. desk
2. memory
3. people
4. world
5. story
6. settings

이는 반드시 문제가 되는 것은 아니다. UX 재편으로 다음처럼 합칠 수 있다.

- characters + relationships → people
- ai + embedding (+ server) → Quick Settings Drawer
- narrative → story
- 새로운 desk → 기존 Recall/Response/State 데이터를 모은 Reader projection

하지만 **pipeline / agents / custom / logs는 현재 어디에도 온전히 흡수되지 않았다.**

---

## 3. 영역별 대응표

| 예시 GUI | 실제 코드 기반 | 판정 | 핵심 차이 |
|---|---|---|---|
| 열람대 | Recall viewer + Response result + Live Context + Current Head | 부분 대응 | 코드에 독립 Home/Desk 페이지는 없음. 새 aggregation projection 필요 |
| 기억 서가 | Canonical Reader | 매우 높은 대응 | Reader 자체는 잘 맞음 |
| 기억의 근거 / 기록 계보 | Canonical Context + Evidence Chain | 부분 대응 | 전체 Evidence Drawer, assertion→observation→patch→head 상세가 축약됨 |
| 기억 교정 | Canonical edit/candidate APIs | 부분 대응 | 목업은 DOM 수정. 실제는 edit draft/candidate/resolve/variant 권위 필요 |
| 정본 관리 | Canonical Action Panel / Memories Panel | 코드 전용 | 수동 콜드스타트, 현재 5턴 분석, 실패 재시도, 재생성 후보, 버전 기록 등 누락 |
| 인물 카드함 | Character Current Head | 부분 대응 | 현재 `state` 객체의 임의 필드를 소개형으로 재투영할 일반 projection이 필요 |
| 관계 소개 | Directional Relationship Current Head | 부분 대응 | 실제는 `A → B`, dimension, state, certainty, evidence를 별도 보존. 목업 객체는 이를 단순화 |
| 세계 도감 | World Current Head | 부분 대응 | 임의 kind/state/aliases/evidence를 모두 읽을 generic renderer가 없음 |
| 서사 연감 | Narrative Current Head | 부분 대응 | Arc/Thread는 맞지만 Lock, momentum, phase/status, updatedThroughTurn가 충분히 안 보임 |
| 사서의 여백 | Narrative Direction | 부분 대응 | 실제 필드: goal, completionConditions, doNotForce, softPreferences, locked. 목업은 일부만 노출 |
| 빠른 설정 · LIBRA | Response Mode + Planner | 부분 대응 | Classic→사서 모드 rename은 가능. Planner 언어/상세도/출력예산 누락 |
| 빠른 설정 · GRADIA | Gradia Draft Settings | 부분 대응 | RP/소설, 길이, 언어, 경량/중량, 전달모드는 대응. 소설 Classic/Input-inclusive 누락 |
| GRADIA 문체 변형 | Prompt Studio Easy Config와 일부 개념 유사 | 목업 전용/부분 | `문장 리듬`, `대사 밀도`, `고유 문체 보호`, `변형 강도`라는 동일 런타임 계약은 없음 |
| Ariadne/ito 설정 | Memory Pipeline Agents | 부분 대응 | enable/preset 외 timeout/context/output/order/result workspace가 누락 |
| Shadow/AIDE 설정 | GRADIA stages | 부분 대응 | enable/preset 외 단계별 세부 설정/실행 결과/skill route가 누락 |
| AI 연결 | Provider Panel | 부분 대응 | 기본 연결은 있음. max output, request format, streaming, Flex, extra headers/body, Vertex 등 누락 |
| 임베딩 연결 | Embedding Panel | 높은 대응 | 대부분 맞음. Ollama model discovery 등 일부 누락 |
| 설정실 8개 | Shared Settings Shell 8개 | 완전 대응에 가까움 | 대분류는 정확히 일치. 세부 항목 일부 축약 |
| Prompt Studio/OOC | Shared Custom Shell | 코드 전용 | 예시 GUI에 온전한 페이지/Drawer 없음 |
| Pipeline Workbench | Shared Pipeline Shell | 코드 전용 | 응답 생성/기억 작성/상태 추적 workspace 없음 |
| Agent Workbench | Shared Agent Shell | 코드 전용 | memory/state/draft agent workspace 없음 |
| 실행 기록 | Execution Logs | 코드 전용 | memory/state/draft/recall/input_writer/embedding/rebuild receipt viewer 없음 |

---

## 4. 기억 영역

### 코드에 이미 준비된 것

- `listCanonicalReaderChapters`
- `getCanonicalReaderChapter`
- `getCanonicalEvidenceChain`
- Canonical Reader Rail / Article
- Memory Hub: `read / context / manage`
- 수동 콜드스타트
- 현재 5턴 분석
- 실패 배치 재시도
- Canonical regeneration candidate
- edit draft / candidate comparison / resolve
- variant 선택/삭제
- 버전 기록
- 실행 기록 연결

### 예시 GUI와 맞는 부분

현재 Book UX의 `chapter rail → 장 본문 → margin notes → cross reference`는 Canonical Reader의 데이터 구조를 충분히 활용할 수 있다.

### 부족한 부분

`정본 관리` 기능군이 거의 없다. 현재 `교정` 하나로는 다음 기능을 대체할 수 없다.

- manual cold start
- current five-turn scan
- failed retry
- regeneration candidate
- candidate comparison
- version history
- variant selection/delete
- canonical job progress/cancel/resume

**따라서 기억 화면은 “읽기”는 거의 대응, “관리”는 미대응이다.**

---

## 5. 인물과 관계

### 실제 코드 계약

Character Current Head:

- id
- name
- aliases
- arbitrary `state` object
- correctionProvenance
- evidence

Relationship Current Head:

- subjectId / subjectName
- targetId / targetName
- dimension
- state
- certainty
- correctionProvenance
- evidence

특히 관계는 **방향성 `A → B`가 권위 계약**이다.

### 예시 GUI 문제

예시 GUI의 `people[state.person].relations[]`는 소개용 데이터로는 좋지만 실제 코드 구조를 그대로 담지 않는다.

따라서 본체 구현 시에는:

- Character Head와 Relationship Head를 저장 단계에서 합치면 안 됨
- UI projection 단계에서만 합쳐야 함
- 관계 카드마다 `subject → target`, dimension, certainty, evidence identity를 내부적으로 유지해야 함

즉 **시각적 통합은 가능하지만 데이터 모델 통합은 불가**하다.

---

## 6. 세계

실제 World Current Head는 고정된 LOCATION/FACTION/RULE 3종에 한정되지 않는다.

- id
- name
- kind
- aliases
- arbitrary state
- evidence
- correctionProvenance

예시 GUI의 `장소/세력/규칙` 카드는 좋은 대표 표현이지만, 본체에서는 **알 수 없는 kind와 임의 state field까지 안전하게 읽는 generic world entry renderer**가 필요하다.

또한 실제 코드의 각 도메인은 다음 탭을 가진다.

- 현재 상태
- 구조 보기
- 정본 근거 · 교정

예시 GUI에는 구조/raw와 correction/history 접근이 부족하다.

---

## 7. 내러티브

### 실제 Current Narrative

- summary
- momentum
- arcs
- threads
- locks
- updatedThroughTurn

Arc/Thread/Lock은 각각 status/type/phase 등의 구조 데이터를 가진다.

### 실제 Narrative Direction

- goal
- completionConditions[]
- doNotForce[]
- softPreferences[]
- locked
- revision / scope identity

### 예시 GUI

목차형 Arc/Thread UX는 매우 적합하다.

하지만 1:1 대응을 위해서는 최소한 다음을 추가해야 한다.

- Lock
- momentum
- Arc status/phase
- Thread type/status
- updated-through-turn
- completionConditions
- softPreferences
- locked toggle
- direction reset

---

## 8. 열람대

열람대는 **코드에 그대로 존재하는 페이지가 아니다.**

현재 LIBRA는 Home dashboard를 제거하고 Memory 중심 workspace로 재편되어 있다.

그러나 열람대에 필요한 데이터 seam은 이미 있다.

- `getLastRecall()` / Recall Viewer
- Runtime.lastMemoryRecallViewer
- Planner result / Classic result / GRADIA result
- Live Tail / Live Context
- Current State snapshot
- final injection result

따라서 열람대는 **새 데이터를 만드는 기능이 아니라 기존 read-only seam을 조합하는 projection**으로 구현 가능하다.

판정: **구현 가능하지만 현재 코드와 direct 1:1 page는 아님.**

---

## 9. 빠른 설정 · LIBRA

예시 GUI:

- 사서 모드
- 플래너 모드
- Planner preset
- Input Writer mode/preset
- Ariadne/itos enable + preset

실제 코드:

- `responseFamily='libra'`
- `libraResponseMode='classic' | 'planner'`
- Planner preset
- Planner output language
- Planner detail level
- Planner output budget
- Input Writer mode
- Memory agent slots

따라서:

- **사서 모드 = Classic**으로 명칭만 바꾸는 것은 안전
- Planner의 language/detail/output budget을 Quick 또는 Advanced에 반드시 남겨야 함

---

## 10. 빠른 설정 · GRADIA

### 대응되는 것

- 소설 / RP
- 길이
- 작성 언어
- 경량 / 중량
- 중량: 초안만 / 초안+분석
- Shadow/AIDE 구조

### 코드에 있는데 GUI에 없는 것

- 소설 초안 방식: Classic / Input-inclusive
- GRADIA Stages workspace
- Skill Router
- Output panel
- Results panel

### GUI에 있는데 현재 코드와 동일 계약이 없는 것

- 작성 방향: 균형 / 인물·관계 / 사건 진행 / 분위기·세계
- 문체 프리셋
- 문장 리듬
- 대사 밀도
- 고유 문체 보호
- 문체 변형 강도

코드에는 Prompt Studio Easy Config의 `sga` style이 존재한다.

- balanced
- dialogue
- descriptive
- proactive
- slow_burn
- emotional

따라서 예시 GUI의 ROKI형 문체 제어를 그대로 쓰려면 둘 중 하나가 필요하다.

1. GUI를 현재 Easy Config 계약에 맞춰 수정
2. 새 runtime settings contract를 실제 LIBRA에 구현

현재 상태에서 그대로 저장키를 만들면 **목업 전용 설정**이 된다.

---

## 11. Pipeline / Agents / Custom / Logs

### Pipeline

실제 하위 페이지:

- 응답 생성
- 기억 작성
- 상태 추적

예시 GUI에는 없음.

### Agents

실제 하위 페이지:

- 기억 작성
- 상태 추적
- LIBRA 응답 / GRADIA 초안

Quick Settings의 enable/preset만으로는 대체되지 않는다.

### Custom

실제 하위 페이지:

- 기억 프롬프트
- 상태 추적 프롬프트
- Planner/GRADIA 초안 프롬프트
- OOC Builder

예시 GUI에는 온전한 대응이 없다.

### Execution Logs

실제 종류:

- memory
- state
- draft
- recall
- input_writer
- embedding
- rebuild

예시 GUI에는 Execution Receipt archive가 없다.

**이 네 영역이 현재 1:1 대응의 가장 큰 공백이다.**

---

## 12. AI 연결

예시 GUI는 Provider preset의 기본적인 부분은 대응한다.

대응됨:

- preset name
- provider
- Base URL
- model
- API key
- model list
- reasoning preset / effort / budget

현재 코드에 있으나 예시 GUI에서 빠진 고급 계약 예:

- 최대 출력 토큰
- 요청 형식
- streaming
- Flex
- extra HTTP headers
- extra request body
- Vertex credential / service account 계열
- provider별 고급 옵션

따라서 AI Drawer도 **부분 대응**이다.

---

## 13. 임베딩 연결

높은 대응도를 보인다.

대응됨:

- provider
- endpoint
- API key
- model
- dimensions
- batch size
- timeout
- query/document task
- query/document prefix
- Custom HTTP
- response vector path
- error path
- custom headers/template
- vector regeneration
- multilingual recall diagnostic

누락 예:

- Ollama model discovery / capability UI 일부

---

## 14. 설정실

예시 GUI의 8개 설정 분류는 실제 `SHARED_SETTINGS_HUB_SECTIONS`와 정확히 일치한다.

- input_writer
- references
- memory
- state
- server
- recovery
- transfer
- general

또한 References 하위 구조도 실제 코드와 일치한다.

- modules
- character_lore_exclusions
- response_materials

이 부분은 현재 예시 GUI에서 **가장 1:1 대응이 잘 된 영역**이다.

---

## 15. 편집 권위 문제

예시 GUI의 `saveEditMode()`는 현재 목업 객체와 DOM을 직접 바꾼다.

실제 LIBRA에서는 이 방식으로 구현하면 안 된다.

### Canonical Memory

다음 API/경로를 사용해야 한다.

- createCanonicalEditDraft
- saveCanonicalEditDraft
- getCanonicalCandidateComparison
- resolveCanonicalCandidate
- selectCanonicalVariant
- deleteCanonicalVariant
- saveCanonicalManualStateDisposition

### Character / Relationship / World / Narrative Current Head

Correction Journal / World Manager correction API를 사용해야 한다.

직접 Current Head를 덮어쓰면 안 된다.

### Narrative Direction

- getPlannerNarrativeDirection
- setPlannerNarrativeDirection

의 scope/revision/readback 경로를 사용해야 한다.

즉 **예시 GUI의 편집 경험은 사용할 수 있지만 save handler는 전부 실제 권위 API로 교체해야 한다.**

---

## 16. 1:1 완전 대응을 위한 필수 패치 목록

### A. 유지해도 되는 UX

- Reading Desk
- Book-style Memory Reader
- Character + Relationship integrated reading view
- World Guide
- Narrative TOC
- Settings Room
- Quick Settings Drawer

### B. 반드시 추가해야 하는 관리 Drawer / Workbench

1. Memory 관리대
   - read / context / manage
   - cold start / current 5-turn / failed retry
   - regenerate / candidate / variant / history

2. Character/Relationship/World/Narrative 상세 Drawer
   - current
   - structure/raw
   - evidence
   - correction journal/history

3. Narrative Direction 전체 필드
   - goal
   - completion conditions
   - do-not-force
   - soft preferences
   - lock

4. Pipeline Workbench
   - response generation
   - memory pipeline
   - state tracking

5. Agent Workbench
   - memory
   - state
   - draft

6. Custom Workbench
   - memory prompt
   - state prompt
   - Planner/GRADIA prompt
   - OOC Builder
   - GRADIA Skill Router

7. Execution Archive
   - memory/state/draft/recall/input writer/embedding/rebuild

8. Provider Advanced
   - source의 고급 provider field 전체

### C. 예시 GUI에서 수정하거나 코드에 새로 구현해야 하는 항목

- GRADIA 작성 방향 4분류
- ROKI형 문체 프리셋
- 문장 리듬
- 대사 밀도
- 고유 문체 보호
- 문체 변형 강도

현재 코드의 Easy Prompt/Skill/Narrative Dynamics에 매핑할지, 새 runtime contract로 구현할지 먼저 확정해야 한다.

---

# 최종 판정

**현재 v5.8 예시 GUI는 “LIBRA의 새로운 Reader UX 설계”로는 충분히 타당하다. 그러나 LIBRA 2.3.24 코드베이스 전체와 1:1 완전 대응되지는 않는다.**

가장 큰 차이는 다음 세 가지다.

1. 실제 코드의 관리/진단/작업대 기능이 GUI에서 생략됨
2. 실제 Current Head/Evidence/Correction 구조가 읽기 좋은 문장으로 축약되며 일부 구조 필드를 잃음
3. 예시 GUI의 일부 GRADIA 문체 제어는 현재 코드에 동일한 설정 계약이 없음

따라서 본체 이식 전에 **“예시 GUI를 코드에 맞춰 줄이는 것”보다, 현재 Book UX를 유지한 채 누락된 코드 기능을 2·3차 Drawer/Workbench로 연결하는 방식**이 가장 적합하다.
