# MAIN_MEMORY_IMPLEMENTATION_RECORD — T03–T07 구현 기록

**작성:** 2026-09-26 · **기준 문서:** `01_INTEGRATION_SPEC.md` · `02_IMPLEMENTATION_PLAN.md` · `03_ACCEPTANCE_TESTS.md` · `MAIN_MEMORY_CONTRACT_DECISIONS.md` v2 · `LIBRARIAN_BENCHMARK_VALIDATION.md`
**기준 커밋:** `d78e427` (T01 까지) → 구현 `61635eb` · `7b45ad1` · `f580178`

이 문서는 **무엇을 실제로 만들었고, 무엇으로 확인했으며, 무엇이 아직 아닌지**를 기록한다. 설계가 아니라 실행의 기록이다.

---

## 1. 커밋

| 커밋 | 내용 |
|---|---|
| `61635eb` | T03 v5 reader · T04 취향·경계 · T05 약속 link · T07 recall closure |
| `7b45ad1` | 경계 판정 결함 수정 + 추출 소스 바인딩 수정 |
| `f580178` | T03b v5 writer + 서버 legacy 가드 수정 |
| `d5c3a4b` | T06 회귀 스위트 + writer schema 거부 + size floor 재측정 |

---

## 2. T03 / T03b — schema 판독·기록 (D02)

### 한 일

| 항목 | 구현 |
|---|---|
| v5 상수 | `UNIFIED_ARTIFACT_SCHEMA_V5 = 'libra.canonical_artifact.v5'` 신규. **`UNIFIED_ARTIFACT_SCHEMA` 는 v4 그대로** |
| 판독 판정 | `UNIFIED_READABLE_ARTIFACT_SCHEMAS` + `unifiedArtifactSchemaReadable(value)` 신규 |
| 읽기 경로 | `unifiedRefIsV4` 를 쓰던 **24곳 + 리터럴 13곳 = 37개 참조 전부**를 readable 판정으로 전환. 별칭 `unifiedRefIsReadableUnified` 추가 |
| dispatch | `continuityLegacyModeForMemory` 에 `LEGACY_CONTINUITY_MODE_STATE_PIPELINE_V5 = 'state_pipeline_v5'` 추가. v5 → State Pipeline, **미지원 미래 schema 는 여전히 `unsupported_artifact`** |
| v5 claim kinds | `character_preference` / `character_boundary` 를 `UNIFIED_CLAIMS` 에 추가 (collection + profile) |
| writer | `artifactSchemaForWrite()` — artifact 가 실제로 가진 schema 를 라벨로 쓴다. **v5 로 라벨링된 것만 v5** |

### 확인한 것

```
libra_main_memory_schema_compatibility_test.cjs
  v4 control      : ok=true,  13 facts           (동작 불변)
  v5 label        : ok=true,  13 facts, render 688 bytes = v4 와 동일
  미래 schema v99 : ok=false, UNIFIED_SCHEMA_INVALID, facts 13 보존 (손실 0)
  A30 부분 수용   : 사실 1개 격리, 무관 사실 유지, admission.status='partial'
  writer 기본     : 라벨 없음 → v4 로 기록
  writer v5       : 라벨 있음 → record·artifact·manifest ref 전부 v5 (일치)
```

`libra_main_memory_mixed_replay_test.cjs` (신규) — **실제로 혼합된 chain**:

```
3모드 전부: refs [v4, v5] · memories [v4, v5] · 이전 v4 record 바이트 불변
           · Head throughTurn 10 (두 구간 모두 replay)
           · turn 번호 정규화 후 두 구간 render 동일
```

### 발견·수정한 결함

**서버 legacy 가드의 의미 오류 (실측으로 발견).** `unifiedRefIsV4` 는 정확히 v4 인지만 보는데, 가드의 주석은 "legacy 기록이 없어야 한다" 였다. 그래서 **v5 typed record 가 legacy 로 분류되어 mirror·server_only 가 `UNIFIED_SERVER_LEGACY_NOT_SUPPORTED` 로 배치 전체를 실패**시켰고, plugin_only 만 성공하는 **조용한 모드 발산**이었다. 가드를 typed 판정(`unifiedRefIsReadableUnified`)으로 고쳤다.

**record 라벨 불일치.** v5 artifact 를 저장하면서 record 의 `artifactSchema` 는 v4 로 남아, **artifact 와 라벨이 서로 모순**되는 상태였다. `artifactSchemaForWrite()` 로 일치시켰다.

---

## 3. T04 — 취향·경계 (D03)

### 이식한 World Maker 로직

| 원본 | 적응 |
|---|---|
| `inferPreferenceKind` (L11219) | `character_preference` / `character_boundary` 분류 |
| `inferPreferenceTopic` (L11227) | identity 축 (`topic`) |
| `sameSlotIdentity` (L11498) | `subject + topic` 2축 동일성 |
| `durableAnchorSimilarity` (L11531) | Jaccard — **단독 사용 금지**, 근거와 조합 |
| `unifiedBoundaryScope` (신규) | 주체·대상·행위·시점 4축 |

### 확인한 것

```
libra_main_memory_profile_lifecycle_test.cjs — 3모드 12/12
  직접 취향 → state.preferences 도달
  경계 → state.boundaries 도달, 4축 보존:
        주체=민아 대상=지호 행위=편지를 열 시점=오늘
  경계가 preference 로 저장되지 않음
  미분류 category → profile 로 추정되지 않음 (memory-only)
  일회적 사건 → 취향으로 승격되지 않음
  무관 habit 보존
  재확인 → state·fieldEvidence 바이트 동일 (R09)
```

### 발견·수정한 결함

**World Maker 원본 정규식이 스펙의 예시 문장을 놓친다.** 원본의 경계 판정은 `지 마`(공백)를 요구하는데, `03` A08 이 **경계 사례로 명시한 문장**은 `열지 말라고` 다. 그래서 그 문장이 **일반 취향으로 분류되어 `state.preferences` 에 들어갔다.** `지 말` / `말라고` / `하지 않` / `않도록` 을 추가했다.

교차 검증: `경계 7/7` (이전 6/7). A08 단언을 테스트에 넣어 재발을 막았다.

### Phase C 보정 — canonical-derived item history

2026-09-26 승인 구현에서 원본 `versions[]` 스냅샷은 canonical에 추가하지 않는다. History API가 선택된 active worldline/cursor까지 최대 64개 canonical ref를 다시 읽고 기존 Correction Journal의 동일 cursor/worldline 레코드를 함께 적용해 create/reaffirm/replace/remove 및 thread resolved/reopen lifecycle을 파생한다. timeline은 regenerable projection이며 History와 BOOK에 partial coverage를 표시한다. 절단된 prefix의 첫 관측은 생성 시점으로 단정하지 않고 `first_observed`로 구분한다. Existing v4/v5 canonical bytes는 읽기 호환으로만 유지한다.

Profile canonical items are structured `{content, topic, kind}`; boundaries add Registry-resolved `scope:{subjectRef,targetRef,act,when}`. Preference identity is resolved subject + topic; boundary identity additionally includes all four scope axes. Exact selectors govern profile remove/clear; empty selectors do not clear a collection. BOOK correction editing uses human-readable names for boundary scope and maps a chosen existing person back through the Registry before appending a correction.

---

## 4. T05 — 약속 lifecycle (D04)

### 한 일

- link 5종 `reaffirm` / `replace` / `resolve` / `reopen` / `associate` 상수화
- `resolution` 사유: `fulfilled` / `broken` / `cancelled` / `superseded` / `completed` / `withdrawn`
- **status enum 무변경**: `broken` = `status:'resolved'` + `resolution:'broken'`
- `findThreadResolutionMatchIndex` 이식 (owner + target + anchor 3중 점수, 참여자 필터)
- provider admission 의 `pick` 목록에 `link` / `resolution` 추가 — **누락 시 조용히 탈락**하던 지점

### 확인한 것

```
libra_main_memory_thread_identity_test.cjs
  link·resolution 저장 유지
  broken ≠ fulfilled (같은 resolved status, 다른 사유)
  open thread 가 closure 사유 주장 → 거부 (UNIFIED_THREAD_RESOLUTION_REQUIRES_CLOSED_STATUS)
  미지원 link → 거부 (UNIFIED_THREAD_LINK_INVALID)
  미지원 사유 → 거부 (UNIFIED_THREAD_RESOLUTION_INVALID)
  A11: 같은 제목·다른 참여자 → matcher 가 index 0 선택 (제목만으로 병합 안 함)
```

---

## 5. T07 — recall closure (D05)

### 한 일

`01` §7.2 시그니처 그대로:

```javascript
resolveRecallContinuityClosure({ selectedFacts, manifest, head, readFact, budget, signal })
  -> Promise<{ facts, currentness, closureComplete, diagnostics }>
```

**recall 경로에 연결**: 선택된 사실의 slot 을 active canonical chain 의 **이후 artifact** 에서 찾아 닫는다. `packRecallCandidates` 는 동기이므로 그 **뒤**(비동기 구간)에서 실행하고, 결과를 `result.diagnostics.recallContinuityClosure` 로 전달한다.

`01` §11 준수:
- 새 유사도 엔진 아님 — 기존 선택 결과의 유효성 확인
- index/ELI 없이도 동작 (정본 read 만 사용)
- 예산 부족·read 실패를 "이후 변경 없음"으로 보고하지 않음
- ref 상한 48 / fact 상한 240 (무제한 역사 스캔 금지)

### 확인한 것

```
libra_main_memory_recall_currentness_test.cjs — 3모드
  A18: 약속 배치(T1-5, open) + 이행 배치(T6-10, resolved) 두 artifact 에 걸쳐
       recall 이 후속(이행)을 볼 수 있다         successorVisible=true
  A21: currentness 라벨이 payload 에 있다        hasCurrentnessLabel=true
  A22: reported/hypothetical 이 검증된 closure 로 승격되지 않음
  모델 호출 0 (closure 자체는 추가 생성 호출 없음)
```

closure 자체의 정직성도 직접 확인:
```
완전히 걸을 수 있는 chain → currentness='current', closureComplete=true, reads>0
read 실패                → closureComplete=false, 'read_failed' 명명
예산 정지                → closureComplete=false, 'closure_budget' 명명
abort                    → closureComplete=false, 'aborted' 명명
```

---

## 6. T06 — Replay·Source Edit·세계선

`libra_main_memory_replay_and_correction_test.cjs` (신규).

| 단언 | 결과 |
|---|---|
| A10 재생 멱등성 — 이미 커밋된 구간 재실행 | `completed=0`, ref 수 불변, State·provenance 불변 |
| A10 재확인 — 같은 값을 다시 확정 | State 불변 (R09) |
| A25 Correction 경로 — 새 필드를 가진 record | `listWorldManagerCorrections` 가 응답 |
| A26 branch — named logical fork | 문서화된 코드로 거부, **부모 State 불변** |
| record 정합성 | 모든 record 의 라벨 = artifact schema (모순 없음) |

3모드 전부 동일. 모델 호출은 배치당 1회(정상 분석)뿐이며 경로 자체는 추가 호출 0.

### 여기서 발견한 결함 2건 (전부 이번 작업이 만든 것)

**writer 가 모르는 schema 를 조용히 v4 로 바꿔 저장했다.** `schema:'unknown'` 이 v4 로 재라벨되어 **수용**되었고, `libra_record_quarantine_runtime_test` 의 "wrong root schema remains a failure without automatic model repair" 가 `1 !== 0` 으로 실패했다. 읽을 수 없는 schema 는 이제 **거부**한다(`UNIFIED_SCHEMA_INVALID:<선언값>`) — 라벨을 바꿔 통과시키지 않는다.

**구현이 배포 artifact 를 floor 위로 밀어올렸다.** `build_plugins.cjs --profile release` 실측 `libra 3321076 B OVER-FLOOR floor 3311014 headroom -10062` → `remote_update_release_zip_runtime_test` 가 `build_distribution` 을 통해 실패. floor 를 **실측값 3,321,076 B** 로 옮기고 증가 귀속을 주석에 기록했다. 나머지 4개 artifact 는 자기 floor 그대로(headroom 0)이므로 **증가분이 LIBRA 단독임이 귀속**된다. 재측정 후 `5/5 within floor`.

## 7. 시험 인프라에서 고친 것

**두 스위트가 소스를 잘라 VM 에서 컴파일**하는데, 그 조각이 새 판정 함수를 호출하게 되어 컨텍스트에 선언이 필요했다. 단순 주입이 아니라 `tests/fixtures/librarian_production_bindings.cjs` 가 **배포 소스에서** schema 상수와 판정 함수를 **추출해 주입**하도록 고쳤다 — 테스트 사본이 production 과 다른 판단을 할 수 없게.

**모드별 권위 혼동 2건.** `snapshot.getHead()` / `getMemory()` / `getManifest()` 는 **서버**를 읽는다. `plugin_only` 에서는 서버가 비어 있어 **정상 동작이 실패로 보였다.** 테스트가 모드별 실제 권위를 읽도록 `headOf` / `memoryOf` / `manifestOf` 를 도입했다.

**잘못된 enum 1건.** T04 테스트가 `certainty:'reported'` 를 썼는데, `reported` 는 `temporalRole` 값이다. certainty enum 은 `confirmed/uncertain/conflict/unknown` 이며, 이 오류가 배치의 State 적용을 통째로 막고 있었다.

---

## 8. 검증 상태

| 스위트 | 결과 |
|---|---|
| `libra_main_memory_schema_compatibility_test` | GREEN (reader·writer·부분수용·미래 schema) |
| `libra_main_memory_mixed_replay_test` | GREEN (3모드 혼합 chain) |
| `libra_main_memory_profile_lifecycle_test` | GREEN (3모드 12/12) |
| `libra_main_memory_thread_identity_test` | GREEN |
| `libra_main_memory_recall_currentness_test` | GREEN (3모드) |
| `libra_main_memory_replay_and_correction_test` | GREEN (3모드, T06) |
| `libra_record_quarantine_runtime_test` | GREEN (15/15, writer schema 거부 후) |
| `build_plugins.cjs --profile release` | **5/5 within floor** |
| `libra_legacy_continuity_migration_gate_test` | GREEN (v5 경로 단언 추가) |
| `libra_232_reader_performance_fixture_test` | GREEN |
| `libra_canonical_artifact_v2_runtime_test` | GREEN |
| 전체 회귀 | **736 스위트** (731 + 신규 5) |

---

## 9. 아직 아닌 것 (정직하게)

| 항목 | 상태 |
|---|---|
| **T06** | **완료** — 전용 스위트 3모드 GREEN (재생 멱등·correction 경로·fork 거부) |
| **T08~T11** | 미착수. GUI·관계·상징·portable·최종 게이트 |
| **A01~A44 132행** | `NOT_RUN` 유지. 각 스위트가 자기 사유를 실행하지만 **공식 결과 행은 갱신하지 않았다** |
| **G01~G18** | 매핑만. G01 은 기존 증거로 통과, 나머지 미실행 |
| **D05 수치** | 미확정 — 실제 workload 측정 없이 확정하지 않는다 |
| **A43/A44** | 실모델·실기기 축. harness 결과로 대체하지 않는다 |
| **`03` §9.2 fixture** | T07 은 두 배치 chain 으로 검증. §9.2 의 W0/W1/편집/별칭을 **문자 그대로** 옮긴 스위트는 미작성 |
| **실기기** | `unverified` |

**"구현 완료"라고 말할 수 있는 범위는 T03·T03b·T04·T05·T06·T07 이다.** T08~T11 은 미착수다.

---

## 10. 이 기록을 읽는 방법

- 각 주장에는 파일 이름이 붙어 있다. 그 스위트를 직접 실행하면 같은 결과가 나온다.
- **모든 수치는 실측**이며, 실패를 성공으로 바꾼 곳은 없다. 결함 2건(경계 분류, 서버 가드)은 **원본·계약을 근거로 고친 것**이지 테스트를 느슨하게 만든 것이 아니다.
- 옛 동작을 고정하던 단언은 **동작이 바뀐 이유를 적고 고쳤다**(legacy gate 의 v5 케이스, mixed replay 의 라벨 단언).
- `NOT_RUN` 을 `PASS` 로 합산하지 않았다.


## Phase C focused verification — 2026-09-26

The scoped C1–C3 implementation was exercised by the following focused gates. Every listed command exited 0; complete stdout and file hashes are retained in the external Phase C worker evidence packet.

| Gate | Coverage | Result |
|---|---|---|
| `libra_main_memory_v5_producer_contract_test.cjs` | structured v5 producer contract | GREEN |
| `libra_main_memory_boundary_scope_matrix_test.cjs` | plugin_only, mirror, server_only; same topic with distinct scope, fail-closed empty selector, malformed selector rejection | GREEN, 3/3 modes |
| `libra_main_memory_semantic_history_test.cjs` | plugin_only, mirror, server_only; exact State and actual Input Writer Recall packet, selector remains pending, item-scoped correction, evidence ordering, cursor and partial-aware History, cold replay | GREEN, 3/3 modes |
| `libra_main_memory_legacy_boundary_read_compat_test.cjs` | stored legacy v5 boundary strings remain readable in State and History and survive replay byte-for-byte | GREEN, 3/3 modes |
| `libra_main_memory_gui_wiring_test.cjs` | BOOK History lifecycle/coverage plus correction editor display and typed round-trip | GREEN |
| `libra_main_memory_profile_lifecycle_test.cjs` | structured profile fields and prior profile behavior | GREEN, 3/3 modes |
| `libra_main_memory_replacement_and_removal_test.cjs` | exact preference replacement/removal and sibling preservation | GREEN, 3/3 modes |
| `libra_main_memory_replay_and_correction_test.cjs` | replay/correction impact paths | GREEN, 3/3 modes |
| `libra_main_memory_schema_compatibility_test.cjs` | v4/v5 compatibility and future-schema rejection | GREEN |
| `libra_main_memory_thread_lifecycle_e2e_test.cjs` | real producer path across two batches, History lifecycle, and model-free replay | GREEN |

Semantic-history cold replay explicitly deleted the derived timeline/cache keys from the local and server stores, called the public `rebuildWorldManagerState()`, and verified successful replay with `providerCalls=0`. It compared canonical artifact bytes and full memory wrapper bytes only after the asynchronous embedding metadata had settled; both were unchanged across that replay. The earlier observed wrapper transition from embedding `pending` to `disabled` was produced by the background embedding task before replay, not attributed to replay.

All three modes exercised controlled local fixtures; no live external model or host was used. The GUI check uses the shipped BOOK renderer with a DOM stand-in. The temporary removal of the legacy-string compatibility branch was a mutation control that demonstrated the compatibility assertion detects branch loss; it was not an original-baseline product RED. The 240-fact saturation boundary belongs to Phase D and was not tested here. Full regression remains paused by the user; these focused results do not claim whole-product or release acceptance.

### Revision 2 — Recall closure operation identity

The independent closure check on frozen source 643112ca…71e666 found that the real three-batch State removed c_b_jiho_today, but Recall did not append c_b_remove_jiho. In the tracked test, the pre-fix plugin_only reproduction exited 1 with readCount=3, refsScanned=3, chainComplete=true, unresolvedSelected=0, and closureCount=0; the stored turn-11 fact had the exact structured boundary scope. The defect was the equality check: the removal selector's content equaled the earlier set content, so the operation was mistaken for a reaffirmation.

The fix compares structured v5 profile set / remove / exact clear operations together with the item value, and carries that typed transition into Recall's internal duplicate filter. Only structured preference/boundary items use this comparison; legacy strings and generic collection facts retain the previous equality and deduplication path. Empty profile selectors remain quarantined and have no cross-artifact identity. Internal transition keys stay in runtime comparison only; rendered evidence continues to use the canonical fact text.

The tracked libra_main_memory_semantic_history_test.cjs now reproduces the four closure boundaries using committed producer facts and the real Registry: same-scope boundary removal is included; a same-content set reaffirmation is not a successor; removal for the same topic but another target/time is not linked; and preference replacement remains included. Its three-mode run also exercises the public Input Writer packet and confirms it sees the current Head, preserves the remaining scoped boundary, and leaves the empty selector pending.

Revision 2 impact gates, all exit 0: producer contract; boundary scope matrix (3 modes); semantic history/Recall (3 modes); legacy boundary bytes (3 modes); BOOK GUI; profile lifecycle (3 modes); replacement/removal (3 modes); replay/correction (3 modes); generic Recall currentness (3 modes); schema compatibility; and thread lifecycle History. The separate 240-fact saturation test and full paused regression remain out of scope. The supervisor reran the independent closure probe against source c0a58813…8cf8 and test f1dc5937…e9ca; all three modes exited 0 with exact Jiho removal linked, Junho scope isolated, and preference replacement linked. Raw output and execution receipt are retained as supervisor-closure-green-3mode.log and supervisor-closure-green-3mode-execution.json in the external Phase C evidence directory.
