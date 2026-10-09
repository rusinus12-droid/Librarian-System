# MAIN_MEMORY_CONTRACT_DECISIONS — D01–D06 확정 (v2)

**작업:** T02 of `review_artifacts/LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md`
**게이트:** G2 · **작성:** 2026-09-26 · **v2 근거:** World Maker 원본·벤치마킹 패키지 정독 후 D02/D03/D04 정정

> **v1 을 폐기하고 이 문서를 정본으로 쓴다.** v1 은 `docs/01`·`docs/03` 을 부분만 읽고 작성해 세 곳에서 문서와 어긋났다. §0 에 무엇이 왜 바뀌었는지 남긴다.

## 0. v1 에서 정정한 것

| | v1 (폐기) | v2 (확정) | 근거 |
|---|---|---|---|
| **D02** | v4 유지, v5 보류 | **v5 도입** — 명시적 새 schema | `01` §12 권고 + A31/A39/A41 이 "v4/신형 혼합"을 전제 |
| **D03** | `category:'preference'` 단수, 필드명 `preference` | **`preferences`/`boundaries` typed fact** + 경계는 주체·대상·조건·시점 4축 | `examples/preference_red_probe.cjs` 가 `state.preferences` 배열을 이미 확정 / `01` §8 |
| **D04** | `closureReason` 신규 필드 | **기존 enum 유지 + `01` §7.3 link 종류**(`reaffirm/replace/resolve/reopen/associate`) | `01` §9 "World Maker 의 fulfilled/broken/... 를 현재 enum 에 **무단 추가하지 않는다**" |
| **판정 로직** | "이미 있음" (저장 구조만 보고 판단) | **부재 확인** — 현행 LIBRA 에 `sameSlotIdentity`·`inferPreferenceTopic`·`durableAnchorSimilarity`·`findStatusResolutionMatchIndex` **0건** | World Maker 원본 `L11498`·`L11219`·`L11531`·`L11554` |
| **T07 fixture** | 자작 2배치 | **벤치마킹 패키지 §9.2 의 W0/W1/편집/별칭 fixture** | 부록 C.3 |
| **D04 enum 값** | `['open','resolved','transformed','superseded']` (arc enum 오기) | **`['open','blocked','uncertain','resolved','closed']`** (thread enum) | `LIBRA.js` `L44307` |

**v1 의 오류 패턴:** 파일 목록·섹션 제목·요약만 읽고 **실제 코드와 알고리즘을 확인하지 않았다.** v2 는 각 주장에 파일·줄을 붙인다.

## D01. 세 모드 operation matrix — **확정 (T01 로 구현·검증됨)**

### 선택

| 공개 operation | plugin_only | mirror | server_only | 근거 |
|---|---|---|---|---|
| `rollbackWorldManagerState({throughTurn})` | 성공 | **성공** | **성공** | T01 `8137982` |
| `setWorldManagerWorldline({})` (main 재개) | 성공 | **성공** | **성공** | T01 |
| named logical fork (`worldlineId !== 'main'`) | 거부 | 거부 | 거부 | `UNIFIED_USE_NATIVE_BRANCH_FOR_FORK` — `01` §13.1 "기존 fork 정책은 유지" |
| `prepareSessionHandoff` | 성공 | 거부 | 거부 | `UNIFIED_BACKEND_NOT_SUPPORTED` — 미구현 경계 |
| rollback 중 새 canonical 쓰기 | 해당 없음 | 거부 | 거부 | `UNIFIED_ROLLBACK_VIEW_WRITE_BLOCKED` |
| correction append/suspend/reactivate | 성공 | 성공 | 성공 | 기존 구현 |

### 쓰기 / read-set 키

| 키 | cutoff 변경 시 | 비고 |
|---|---|---|
| `…:state-worldline-meta:v1` | **쓴다** | 서버 모드에서 CAS 조건으로 함께 commit |
| `…:continuity-state` | 쓴다 | replay 결과 Head |
| `…:state-replay-cache:v1` | 쓴다 | 파생 캐시 |
| `…:state-pipeline-receipt:…` | 쓴다 | 파생 영수증 |
| `…:entity-registry:v2` | 쓴다 | replay 결과 |
| `…:manifest` | **쓰지 않는다** | 정본 목록은 view 작업의 대상이 아니다 |

### 이유

worldline meta 키는 `pluginPrefixes:['libra:v1:']` 로 이미 같은 bridge 를 타고, replay commit 이 `conditionKeys` 에 meta 를 포함해 CAS 로 고정한다. 따라서 서버 권위에서도 영속 후조건을 **가정하지 않고 검증**한다. `01` §13.3 "중간 meta 를 먼저 공개하고 replay 가 나중에 실패하는 구조를 서버에 복제하지 않는다" 를 만족한다.

### 반례 (검증 완료)

- `libra_main_memory_state_operations_parity_test.cjs` — turn 0 과 완료 구간 경계(5) 에서 3모드 동일 성공, 재시작 후 cutoff 유지, 재개가 cutoff 를 해제, 정본 바이트·manifest refs 불변.
- 변이 4/4: 가드 재설치 → `UNIFIED_BACKEND_NOT_SUPPORTED`; cutoff 영속 제거 → `UNIFIED_HISTORICAL_HEAD_BLOCKED`; 재개가 cutoff 유지 → 단언 실패; 서버 meta 가드 원복 → `UNIFIED_SERVER_WORLDLINE_NOT_SUPPORTED`.
- A03: named fork 는 3모드 모두 같은 코드로 거부, 데이터·모델 호출 불변.

## D02. schema writer / read compatibility — **확정: v5 도입**

### 선택

**`libra.canonical_artifact.v5` 를 도입한다.** v4 는 바이트·digest·해석을 그대로 유지하고, v5 는 **명시적 dispatch** 로 읽는다.

### 실측 근거 (전수 검색, `01` §12 요구)

| 대상 | 현행 수치 | 의미 |
|---|---|---|
| `UNIFIED_ARTIFACT_SCHEMA` 정의 | `L44170` = `'libra.canonical_artifact.v4'` | 단일 상수 |
| `UNIFIED_ARTIFACT_SCHEMA` 참조 | 37곳 | 전부 갱신 대상 |
| `unifiedRefIsV4` 참조 | 24곳 | **의미 확장 필요** (v4/v5 판별) |
| `canonical_artifact.v4` 문자열 | 13곳 | 하드코딩 제거 대상 |
| v3 호환 경로 | `L11706`, `L34264` (`CANONICAL_ARTIFACT_LEGACY_SCHEMA`) | 유지 |
| engine 판독 | `L34259–34269` `declaredSchema`/`artifactSchema` 분리 (`continuityLegacyModeForMemory`) | **dispatch 중심** |

### 확정 계약

| 경로 | 필수 동작 |
|---|---|
| 기존 v4 읽기 | 원래 해석·바이트·digest 유지. 새 필드 부재로 실패하지 않는다 |
| 새 v5 쓰기 | validator/renderer 통과분만. **reader 배포 전 활성화 금지** |
| v4/v5 혼합 Replay | 구간별 스키마를 정확히 판독. **v4 자동 재분석·의미 추정 금지** |
| 수동 교정 | v5 필드도 같은 Correction journal 을 통해 적용·중단·재활성화 |
| source edit / reroll | 기존 COW revision 교체. 연결 대상이 바뀌면 검증 및 pending 처리가 재현 가능해야 함 |
| portable transfer | 필수 원문/정본/참조가 닫혀 있음. 누락된 target 은 정상 복원으로 처리하지 않음 |
| 다운그레이드 | **지원하지 않는 writer 로 새 데이터를 쓰지 못하게 보호**. 새 정본을 버려 옛 코드가 읽게 만들지 않음 |

### 금지 (`03` A31, `01` §12)

> "상수 하나 변경으로 구형 전체를 legacy 오류로 몰거나 조용히 필드를 삭제하지 않는다"

**`UNIFIED_ARTIFACT_SCHEMA` 상수만 바꾸는 것은 금지**다. reader dispatch·allowlist·validator·renderer 를 함께 바꾼다.

### 배포 순서

```
① v5 reader (읽기 전용) → ② v4/v5 혼합 replay 검증 → ③ v5 writer 활성화 → ④ v5 consumer 갱신
```

reader 가 배포되기 전에 writer 를 켜지 않는다.

### 반례

`libra_main_memory_schema_compatibility_test.cjs` — 고정 v4 bytes, v5, 미지원 미래 schema, dangling link, 미래 revision, 다른 세계선 link. **유효한 사실은 부분 수용**하고 **하나의 불량 optional fact 가 다른 유효 fact 를 버리지 않는지** 검사 (`03` A30).

## D03. 취향·경계 current-item 표현 — **확정: v5 typed fact + World Maker 판정 로직 이식**

### 선택

**v5 의 명시 typed fact `character_preference` / `character_boundary`** 를 도입하고, **World Maker 원본의 판정 로직을 이식**한다. 별도 authoritative ledger 는 만들지 않는다 (`01` §4 대응표·§8). 2026-09-26 Phase C 구현 결정으로 원본 `versions[]` 스냅샷 대신 active canonical chain과 기존 correction journal에서 bounded semantic timeline을 파생한다. 이 timeline은 캐시이며 삭제 후 canonical bytes를 바꾸지 않고 재생성한다.

### 실측 근거

| 항목 | 현행 LIBRA | World Maker 원본 |
|---|---|---|
| 취향 분류 | `character_info` → `character_note` (unknown 으로 떨어짐) | **`inferPreferenceKind`** `L11219`: `preference`/`dislike`/`fear`/`boundary`/`medical_or_food_boundary` |
| 대상 추출 | 없음 | **`inferPreferenceTopic`** `L11227`: 정규식 3패턴 + fallback |
| 항목 동일성 | `collection:true` 배열의 **문자열 중복 제거**만 | **`sameSlotIdentity`** `L11498`: `subject + topic` **둘 다** 일치 |
| 후보 매칭 | slot key 완전 일치 | **`durableAnchorSimilarity`** `L11531`: Jaccard, category별 토큰 정규화 |
| 변경 이력 | `fieldEvidence` (단일) | canonical chain에서 파생한 lifecycle timeline; 64-ref 조회 한도, 누락·절단은 partial로 표시 |

**현행 LIBRA 에 `inferPreferenceTopic`·`sameSlotIdentity`·`durableAnchorSimilarity` 는 0건이다.** v1 의 "이미 있음" 판단은 저장 위치(`profile:true` + `collection:true`)만 본 것이고 **판정 로직은 없다.**

### 확정 계약 — 경계는 4축을 보존한다 (`01` §8, `03` A08)

```
"민아가 지호에게만 오늘 자신의 편지를 열지 말라고 명시"
  → subject  : 민아 (당사자)
  → target   : 지호 (대상)
  → act      : 편지 열람 (행위)
  → when     : 오늘 (시점)
  ⇒ 적용 범위를 벗어나면 ★자동 일반화하지 않는다★
```

| 필드 | 필수 | 의미 |
|---|---|---|
| `kind` | 필수 | `preference` / `dislike` / `fear` / `boundary` / `medical_or_food_boundary` |
| `content` | 필수 | 하나의 독립 유지 가능한 문장 |
| `topic` | 필수 | **identity 축** — 취향은 `subject + topic`, 경계는 여기에 scope 4축을 더해 동일 항목 판정 |
| `scope` | 경계만 | `{subjectRef, targetRef, act, when}` 4축. 비어 있는 축은 모름이며 전체 범위로 확장하지 않는다. Ref는 기존 Registry로 해석한다. |
| `effect` | 필수 | `set` / item-specific `remove` / item-specific `clear`; 빈 selector는 전체 삭제가 아니다 |
| semantic timeline | 파생 | canonical chain의 create/reaffirm/replace/remove 및 thread lifecycle link를 재생. 최대 64 canonical refs와 256 events를 읽고 coverage·partial reason을 표시한다. 절단 구간의 첫 값은 `first_observed`다. |

### 금지 (`03` A07·A08·A09)

- **마지막 취향으로 전체 프로필을 덮지 않는다** (A07)
- **행동 한 번을 취향으로 추정하지 않는다** (A07) — "오늘 민트차를 거절했다" ≠ "민트차를 싫어한다"
- **일회적 동의/거절을 영구 취향·모든 관계의 권한으로 바꾸지 않는다** (A08)
- **유사 문자열 전체 삭제·배열 전체 clear 를 하지 않는다** (A09) — 지정 항목만

### 이식할 로직 (원본 줄)

| 함수 | 원본 | 역할 |
|---|---|---|
| `inferPreferenceKind` | `L11219` | 취향/경계 세부분류 |
| `inferPreferenceTopic` | `L11227` | identity 축 추출 |
| `sameSlotIdentity` | `L11498` | `subject + topic` 2축 판정 |
| `durableAnchorSimilarity` | `L11531` | category별 토큰 필터 + Jaccard |
| `itemMaterialSignature` | `L11351` | 실제 변경 판정 |
| `mergeItemVersions` | `L11338` | 원본 구현 참고. LIBRA는 `versions[]`를 canonical에 복제하지 않고 active chain에서 이력을 파생한다. |

**`01` §7.1 의 "유사도만으로 병합 금지" 는 유사도 *단독* 금지다.** World Maker 는 `isMatchingItem`(`L11539`)에서 `similarity >= 0.74` 또는 `similarity >= 0.54 && overlap > 0` 처럼 **근거와 조합**한다. 이 조합은 계약 위반이 아니다.

### 반례

`libra_main_memory_profile_lifecycle_test.cjs` — "민아는 평소 민트차를 좋아한다"(직접 사실 → 적용) 과 "오늘 민트차를 거절했다"(→ 승격 금지) 를 분리; 항목 하나만 정확히 replace/remove; 같은 값 재확인 시 기존 fieldEvidence 보존; collection 한도 초과 시 silent loss 없음.

## D04. thread 연결 및 종결 사유 — **확정: 기존 enum 유지 + link 종류**

### 선택

**기존 thread status enum 을 그대로 유지**하고(`01` §9 "무단 추가 금지"), **§7.3 의 link 종류**로 연결·종결을 표현한다.

### 실측 근거

```
현행 LIBRA thread status  : ['open','blocked','uncertain','resolved','closed']   L44307
현행 LIBRA thread kind    : ['conflict','promise','question','task','other']     L44305
현행 LIBRA arc status     : ['active','dormant','resolved','superseded']         L1199
World Maker CLOSED_STATUS : ['resolved','closed','fulfilled','broken','cancelled','superseded','inactive']
World Maker ACTIVE_STATUS : ['open','active','pending','ongoing','unresolved','promised']
                          ⇒ ★World Maker 의 값을 LIBRA enum 에 추가하지 않는다★
```

### 확정 계약 (`01` §7.3)

| link | 선행 조건 | 효과 |
|---|---|---|
| `reaffirm` | 같은 대상·같은 값·독립적인 현재 근거 | 역사에는 새 확인 사실. **현재 값의 변경 provenance 는 보존** (R09) |
| `replace` | 같은 항목의 이전 값과 새 값의 변경이 직접 뒷받침 | **정확한 이전 항목만** 대체. 다른 취향·경계는 보존 |
| `resolve` | 같은 열린 약속/과제의 종결 근거가 있음 | 현재 열린 목록에서 종결. **종결 사유와 과거 근거는 이력에 유지** |
| `reopen` | 기존 종료 항목의 재개가 명시됨 | 같은 항목 재개. 비슷한 새 약속은 **새 항목**으로 구분 |
| `associate` | 사건·물건·관계 사이 의미 연결이 원문에 있음 | 검색/이력 연결. **인과·동의·관계 상태를 추가 추론하지 않음** |

### 종결 사유 (기존 enum 안에서)

```
fulfilled  → status 'resolved' + resolution 사유 'fulfilled'
broken     → status 'resolved' + resolution 사유 'broken'    ← ★'resolved' 로 뭉개지 않는다★
cancelled  → status 'closed'   + resolution 사유 'cancelled'
장애만     → status 'blocked'
불명       → status 'uncertain' 또는 기존 open 유지 + pending
재개       → status 'open' + reopen link
```

**`broken` 을 단순 `resolved` 텍스트로 바꾸어 "성공적 이행"처럼 표시하는 것은 금지** (`01` §9).

### 이식할 로직

| 함수 | 원본 | 역할 |
|---|---|---|
| `findStatusResolutionMatchIndex` | `L11554` | **owner + target + anchor 3중 점수**, 참여자 필터, 단일 후보 anchor≥0.2 / 다중 top≥0.34 & gap≥0.12 |
| `isMatchingItem` | `L11539` | 유형별 임계 (commitments/openLoops 는 완화) |
| `durableAnchorTokens` | `L11516` | category별 불용어 제거 (약속/맹세/이행/파기 등) |

### 금지 (`03` A11~A16)

- **제목·임베딩 유사도만으로 두 약속을 합치지 않는다** (A11) — "동일 제목은 동일성의 충분조건이 아니다"
- **이름만 같다고 무조건 합치지 않는다** (A12) — 불확실하면 **연결만 pending**
- **`broken` 을 성공 이행처럼 표시하지 않는다** (A13), **장애를 종결로 처리하지 않는다**
- **Head 에서 종결 항목이 빠졌다고 재개를 새 항목으로 만들지 않는다** (A14)
- **문자열 모양만 맞는 참조를 수용하거나 다른 revision 으로 자동 리다이렉트하지 않는다** (A15)

### 반례

`libra_main_memory_thread_identity_test.cjs`, `libra_main_memory_candidate_boundary_test.cjs` — 이름이 바뀐 동일 과제, 수신자만 다른 약속, 파기≠이행, 재개≠새 약속, 모호한 종결.

### v5 런타임 권한 배선 (Phase B, 2026-09-26)

- `lifecycleId` 와 `participantIds` 는 LIBRA 가 정본으로 만든다. `owner` 는 이행 의무가 있는 행위자, `target` 은 약속의 수신자·수혜자를 뜻한다.
- 정본 `linkStatus` 는 `new | accepted | pending` 이다. `accepted` 에만 `libra.thread_link_target.v2` 대상이 있고, `pending` 은 `linkPendingReason` 을 가진 독립 정본 사실로 남으며 선행 State 를 닫지 않는다.
- v2 대상은 `lifecycleId`, `canonicalOriginKey`, keyless cursor(정본 origin, revision, source/artifact digest, turn range, worldline, session epoch), `factId`, 참여자 역할, lineage digest, link 종류, 대상 상태를 봉인한다. 실제 저장 키는 대상에 넣지 않는다.
- 모델에는 한 요청에서만 유효한 별칭, 짧은 요약, 역할이 붙은 참여자 이름만 전달한다. 정본 식별자, `personId`, cursor, fact ID, 저장 키는 프롬프트에 보내지 않으며 요청 별칭은 저장 정본에서 제거한다.
- State 는 lifecycle 별 최신 상태를 투영한다. 종결 항목은 현재 열린 목록에서 빠져도 정본 사실과 History 에 남는다. 명시적 `reopen` 은 같은 lifecycle 을 다시 연다. 비슷한 새 약속은 별도 lifecycle 이다.
- Recall 은 v5 `accepted` 대상만 closure 권한으로 사용한다. origin/ref/body schema 및 artifact digest, 활성 prefix revision, lifecycle·참여자·종류·전이, anchor 와 직접 근거를 다시 확인한다. 증명이 거부되거나 불완전하면 해당 행을 closure 로 표시하지 않고 currentness 는 `last-known`/`unknown` 으로 둔다.
- v4 와 lifecycle 필드가 없는 과거 v5 는 기존 읽기 의미를 유지한다. 자동으로 새 lifecycle 링크를 추론하지 않는다.

현재 실행 근거는 [Phase B4 구현 기록](MAIN_MEMORY_PHASE_B4_IMPLEMENTATION_RECORD.md)의 파일별·모드별 표를 따른다. 그 표가 충족하지 않은 원본 A11–A16 조건을 완료로 승격하지 않는다.

## D05. 후보·closure 예산 및 성능 — **확정: 총예산 유지, coverage 명시**

### 선택

**총예산을 늘리지 않는다.** `01` §15 "정확한 5 U+A 원문을 후보 참고자료 때문에 줄이지 않는다".

### 확정 계약 (`01` §11, `03` A19·A21)

| 조건 | 동작 |
|---|---|
| 예산 여유 | 완결된 근거 묶음 우선 |
| 예산 부족 | 오래된 값만 남기고 반전·종결을 자르지 않는다. 묶음 단위로 줄인다 |
| closure 미완료 | currentness 를 `last-known` 또는 `unknown` 으로 명시 |
| 캐시 cold/miss | 동일 논리 결과 |
| ELI OFF | 동일 결과. 인덱스는 가속일 뿐 정확성 필수 조건이 아니다 |
| dense embedding 부재 | lexical/정본 경로 유지 |

Recall 의 일반 탐색과 대상 prefix 증명은 하나의 총량 한도를 공유한다: 최대 48 refs, 최대 240 facts. closure 의 target proof 도 같은 `readContinuityRef` 캐시·한도 안에서 읽고, 취소 신호는 읽기 완료 후 다음 ref 전에 확인한다. 증명 budget 이 부족하거나 중단되면 초과 읽기 없이 target 을 거부하고 `last-known` 및 원인을 기록한다. 이 수치는 Recall reader 한정이다. producer 후보 생성은 visible 40 을 만들기 전에 refs 를 전체 탐색하므로 동일한 성능·취소 보장을 주장하지 않는다.

Phase B4 의 48-ref/240-fact 및 취소 경계는 실제 저장된 lifecycle 정본/ref 를 seed 로 삼은 경계 helper fixture 로 확인했다. 이는 10k-ref Recall workload benchmark 나 producer 후보 생성 성능 검증이 아니다. A16 의 “선택적 후보가 prompt budget 을 압박할 때 후보와 alias map 을 함께 줄이며 정확한 5 U+A 를 보존”하는 조건도 별도 producer-pressure 검증이 필요하다.

### 결과 기록 형식 (`03` §7)

```json
{ "case_id": "A19", "mode": "plugin_only", "status": "NOT_RUN",
  "implementation_commit": null, "command": null, "exit_code": null,
  "observed": null, "evidence_files": [], "limitations": [] }
```

**허용 결과: `NOT_RUN`, `PASS`, `FAIL`, `BLOCKED`, `TIMEOUT`, `SKIP`, `EXIT_UNVERIFIED`.**
`PASS` 에는 **명령·exit0·semantic oracle 비교·해당 evidence 가 있어야** 한다. 일부 assertions 가 PASS 라도 **최종 exit 를 모르면 `EXIT_UNVERIFIED`** (`03` §7).

### G01–G18 매핑 (벤치마킹 부록 C.2)

| 적용 경로 | 신규 검증 | 기존 증거 재사용 |
|---|---|---|
| recall closure (T07) | **G01**(warm 재해시 0), **G18**(현재/과거/분기/별칭 fixture) | — |
| 캐시·invalidation | **G02**(같은 ID·길이 편집), **G03**(role/tag 변경), **G06**(축출·재시작) | — |
| 리비전·세계선 | **G04**(삭제·삽입·롤백·리롤), **G05**(분기·전환) | `libra_dual_worldline_3mode_parity_test` |
| 저장·복구 | **G07**(모드 변경), **G08**(readback 실패), **G09**(취소 후 늦은 응답) | — |
| 인덱스 | **G10**(인덱스 삭제·낡은 signature) | `libra_evidence_link_index_*` |
| 정책 | **G11**(auto/off), **G12**(plugin_only 서버 차단), **G13**(mirror/server_only), **G15**(동료 미설치) | `libra_source_edit_consent_3mode_parity_test` |
| Compute·GUI | **G14**(Compute 실패·버전), **G16**(GUI 취소·재열기) | — |
| 불변성 | **G17**(payload 바이트·식별값 보존) | `flashback_*` |

**기존 증거를 재사용할 때는 대상 변경의 영향 여부를 적고, 미실행을 PASS 로 합산하지 않는다** (부록 C.2).

### 수치는 T07 착수 시 측정한다

`01` §15: "T00 에서 기준을 측정하고 T02 결정표에 허용 예산을 수치로 확정한다" — **T00 측정은 완료**(18/18 PASS). 수치 확정은 T07 에서 실제 workload 로 한다. **측정 없는 예산 확정은 근거를 만들지 못한다.**

### 금지 (`03` A19·A42)

- **앞쪽 옛 문장만 자르고 종결·반전 근거를 버리지 않는다** (A19)
- **성능을 맞추려고 특정 모드의 후보·기억 기능을 줄이지 않는다** (A42)
- **빈 인덱스 결과를 "후속 변경 없음"의 증거로 취급하지 않는다** (A21)

### 반례

`libra_main_memory_recall_currentness_test.cjs` — W0/W1/편집/별칭 fixture(§9.2)로 현재/과거 질문 분리; 예산 밖 종결 사실이 현재 의무로 주입되지 않음; 매우 작은 prompt budget; source revision 변경; ELI OFF 동일성.

## D06. 링크 없는 과거 기록 처리 — **확정: 자동 추론 금지, 기존 읽기 유지**

### 선택

새 schema·새 링크가 없는 기존 v4 기록은 **자동 재분석·자동 추론하지 않는다.** 기존 읽기를 그대로 유지한다.

### 실측 근거

| 항목 | 실측값 |
|---|---|
| Source Edit 정책 | auto/off — 현행 유지 (설계서 R10) |
| `UNIFIED_MIGRATION_SCHEMA` | `preserve_legacy_readonly`, `automaticReanalysis:false` (L45167–45170) |
| legacy coverage | `applyUnifiedLegacyCoverage` 로 coverage 만 표시 |

### 확정 계약

| 상황 | 동작 |
|---|---|
| 업그레이드만 | LLM 호출 0, 과거 덮어쓰기 0 |
| GUI 열기·재시작 | LLM 호출 0 |
| 링크 없는 구형 기록 | 그대로 읽는다. coverage 로 표현 |
| 명시적 재분석 | 사용자 승인 경로만. 기존 source edit consent 유지 |
| World Maker 데이터 | 자동 import 금지 — `01` §16 "옛 `lmai_rp_longterm` 의 현재 값만 있으면 실제 원문 사건으로 수입하지 않는다" |

v4 및 lifecycle 필드가 없는 v5 에서는 새 lifecycle identity 를 생성하거나 과거 link 를 다시 해석하지 않는다. typed closure gate 는 v5 lifecycle metadata 가 있는 정본에만 적용하고, 기존 revision bytes 와 v4 thread binding 의미를 보존한다. 검증된 v4 호환 반례는 `libra_main_memory_v4_thread_binding_compat_test.cjs` 에서 기록한다.

### 금지 (`03` A41)

- **옛 lmai_rp_longterm 을 근거 없이 current canon 으로 수입하지 않는다**
- **신형을 삭제해 downgrade 하지 않는다**
- **`off` 에서도 몰래 재분석하지 않는다**

### 반례

`libra_main_memory_portable_compatibility_test.cjs` — 기존 v4 만 있는 사용자의 업그레이드/GUI/재시작에서 모델 호출 0 과 bytes 동일; 문제 있는 bundle 을 정상으로 활성화하지 않고 누락 대상을 보고.

---

## 게이트 G2 판정

| 결정 | 선택 | 이유 | 소비 함수 | 반례 테스트 |
|---|---|---|---|---|
| D01 | 3모드 view 지원 + fork 경계 유지 | meta 키가 이미 서버 라우팅 + CAS 고정 | `mutateStateWorldline`, `requireUnifiedStorageBackend` | `libra_main_memory_state_operations_parity_test.cjs` **(PASS)** |
| D02 | **v5 도입**, v4 불변 | A31/A39/A41 이 신형 전제 | `unifiedRefIsV4`, `continuityLegacyModeForMemory` `L34256`, `prepareUnifiedMemoryArtifact`, `validateUnifiedFactRecord` | `libra_main_memory_schema_compatibility_test.cjs` |
| D03 | **typed fact + 판정 로직 이식, canonical-derived history** | 판정 로직이 현행 0건; original `versions[]`는 canonical authority를 중복 | `inferPreferenceKind`, `inferPreferenceTopic`, exact item reducer, History API | `libra_main_memory_semantic_history_test.cjs` |
| D04 | 기존 enum + link 5종 | `01` §9 "무단 추가 금지" | `findStatusResolutionMatchIndex`, thread patch | `libra_main_memory_thread_identity_test.cjs` |
| D05 | 총예산 유지 + coverage 명시 | 측정 없는 예산 확정은 근거 없음 | `unifiedFactExcerpt`, recall assembly | `libra_main_memory_recall_currentness_test.cjs` |
| D06 | 자동 추론 금지 | R10·R14 | migration/consent 경로 | `libra_main_memory_portable_compatibility_test.cjs` |

**G2 조건:** "계약이 승인되지 않으면 T03 이후 writer 코드를 활성화하지 않는다" — D01 만 구현 완료이고 **D02 의 writer 는 이 문서로 계약이 확정되었으므로 T03 에서 활성화한다.** 단 **reader 배포가 writer 보다 먼저**여야 한다(D02 배포 순서).

## 미확정으로 남기는 것

- **D05 의 수치** — T07 착수 시 측정.
- **G01–G18 의 실행 결과** — 매핑만 확정. 실행은 해당 작업에서.
- **실기기 검증** — `03` §7 이 요구하는 대로 `unverified` 로 둔다. VM·harness 성공을 live-host 통과로 바꾸어 적지 않는다.
- **A43(실제 모델 품질)**, **A44(실제 RisuAI)** — 별도 실행 축. 이 문서의 범위가 아니다.
