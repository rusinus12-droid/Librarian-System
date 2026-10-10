# MAIN_MEMORY_T11_REPORT — 최종 통합·검증·릴리즈

**작업:** T11 of `02_IMPLEMENTATION_PLAN.md` · **Gate G3/G4/G5**
**기준:** `d78e427` → T03–T10 구현 → 이 보고서

이 문서는 **T11 의 게이트별 판정**을 기록한다. 게이트를 통과하지 못한 항목은 통과했다고 쓰지 않는다 (`02` §4: "하나라도 미완료면 그 범위를 명시하고 전체 복원 완료라 부르지 않는다").

---

## 1. 이번 작업이 추가한 스위트

| 스위트 | 담당 | 상태 |
|---|---|---|
| `libra_main_memory_schema_compatibility_test` | T03/T03b | PASS (v4 기본·v5 라벨·미래 schema 거부·A30 부분 수용) |
| `libra_main_memory_mixed_replay_test` | T03b/D02 | PASS (3모드 혼합 chain `[v4, v5]`) |
| `libra_main_memory_profile_lifecycle_test` | T04 | PASS (3모드 12/12, 경계 4축) |
| `libra_main_memory_thread_identity_test` | T05 | PASS (link 5종·resolution·A11) |
| `libra_main_memory_recall_currentness_test` | T07 | PASS (3모드, A18·A21·A22) |
| `libra_main_memory_replay_and_correction_test` | T06 | PASS (3모드, 재생 멱등·fork 거부) |
| `libra_main_memory_gui_wiring_test` | T08 | PASS (BOOK 인물 시트 6/6) |
| `libra_main_memory_episode_motif_test` | T09 | PASS (연감 6/6, A36·A37·A38) |
| `libra_main_memory_portable_compatibility_test` | T10 | PASS (3모드, A39·A40·A41) |
| `libra_main_memory_mode_parity_test` | T11/G4 | PASS (3모드 완전 동일) |
| `libra_main_memory_cost_latency_test` | T11/A42 | PASS (읽기 경로 호출 0) |
| `libra_main_memory_acceptance_test` | T11/A01–A44 | PASS (계정 회계, 아래 §3) |

---

## 2. 게이트별 판정

### Gate G3 — 필수 의미·안전 테스트

| 항목 | 결과 |
|---|---|
| 전체 CJS 회귀 | **743 스위트** (제공 baseline 714 → 작업 후 재계산). 실행 결과는 §5 |
| 신규 수용 스위트 | 12개 전부 PASS |
| `check_sdk_sync.cjs` | **PASS** — LIBRA·HAYAKU·Flashback·LIA source review verified |
| SDK source 수정 여부 | **미수정** → embedded 재생성 불필요 (build_distribution 이 검증) |

### Gate G4 — 세 모드 / 독립 설치 / 캐시 OFF / 실제 앱

| 항목 | 결과 |
|---|---|
| 세 모드 | `mode_parity` 3모드 **동일**: preference/boundary/link/resolution/State 전부 일치 |
| 독립 설치 | 스위트가 peer 플러그인·서버 없이 plugin_only 로 완주 |
| 캐시 OFF | cold scope 에서도 typed field 판독 (cost_latency 가 매 실행 새 scope 사용) |
| **실제 앱** | **미실시** — A44. synthetic host 결과를 live-host 로 바꾸어 적지 않는다 |

### Gate G5 — 릴리즈 / 구형 호환 / 데이터 보존

| 항목 | 결과 |
|---|---|
| 릴리즈 빌드 | **성공** — `build_distribution.cjs --version 0.3.66` → `RELEASES/v0.3.66/Librarian-System-0.3.66.zip`, SHA256 `bc7665f6…3fd7` |
| 버전 범프 | `VERSION.txt` 0.3.65 → **0.3.66** (빌드 전 0.3.65 확인 → 이 실행이 적용한 것) |
| 빌드 게이트 | `build_plugins.cjs --profile release` **5/5 within measured floor** (libra 3,321,808 B · headroom 0) |
| floor 이동 | LIBRA만 **+732 B** (T08/T09, 30줄). 나머지 4개 headroom 0 유지 → LIBRA 단독 귀속 |
| 구형 호환 | v4 reader·writer 동작 불변. v5 는 라벨된 것만 (A31·A41 검증) |
| 데이터 보존 | 재시작·읽기에서 bytes/refs/Head 동일 (A41 검증, `reopenSilent: true`) |
| manifest·checksums | 갱신 완료 (1,277 파일 / 1,378 파일) |
| operation matrix | `build_storage_mode_matrix.cjs` — **70 features**, plugin_only 70/70 · mirror 48+21+1 · server_only 48+21+1 |

**릴리즈 실행 실패 1회 (자기 간섭):** 첫 `build_distribution` 시도는 `distribution_program_source_after_smoke_changed_during_build` 로 실패했다. 원인은 빌드가 스모크 테스트를 도는 동안 내가 문서를 쓰고 커밋해 **제품 트리를 변경**한 것이다 — 이 저장소가 이미 문서화한 금지 사항(`remote_update_release_zip_runtime_test` 와 같은 원리)을 내가 어겼다. 트리를 멈추고 재실행해 통과했다. 버전은 손대지 않은 상태(0.3.65)였으므로 부분 적용은 없었다.

---

## 3. A01–A44 회계 (정직)

`03` §7 의 결과 형식으로 **132행**을 판정했다. **PASS 는 "해당 사례의 action 이 실제로 관측됨"을 뜻하며, 소유 task 에 테스트 파일이 있다는 뜻이 아니다.**

```
PASS    117행  (39 사례)
BLOCKED  15행  ( 5 사례)
FAIL      0행
```

**BLOCKED 5건 — 이번 작업이 관측하지 않은 것:**

| 사례 | 요구 | 차단 사유 |
|---|---|---|
| A04 | 서버 commit 성공 + **응답 손실** + receipt/DB 되읽기 | 주입된 응답 손실 시나리오를 실행하는 스위트 없음 |
| A05 | 동시 교정·ABA·scope 전환 (fault) | 미실행 |
| A06 | mirror 부분 실패·server_only 장애 (양쪽 raw 비교) | 미실행 |
| A43 | 실제 외부 모델 **blind gold** 채점 | 별도 축. harness 결과로 대체하지 않음 |
| A44 | 실제 RisuAI 조작 (리롤·분기·메뉴·재로드·취소) | live-host 축 |

**정정 이력:** 이 스위트의 첫 버전은 132행 전부를 PASS 로 표기했다. 소유 task 의 스위트가 exit 0 이라는 이유였는데, 이는 A01 자신의 `forbidden` 조항("테스트 이름 또는 최종 PASS 문구만으로 완전 parity를 인증하지 않는다")이 금지하는 대체다. A04 의 "응답 손실"이나 A43 의 gold 채점은 소유 task 의 스위트가 있어도 수행되지 않는다. 사례별 action 대조로 다시 작성해 위 수치가 됐다.

---

## 4. 릴리즈 실행

```
node --no-warnings tools/build_distribution.cjs --version 0.3.66
```

`parseArgs` 가 지원하는 인자는 `--output-dir` / `--profile` / `--version` 뿐이다 (`--help` 는 지원하지 않으므로 가정하지 않았다). 빌더는 다음을 수행한다:

1. `applyReleaseVersion` — `VERSION.txt`, `server.cjs`, `release-policy.json`, `logical_migration.cjs`, `transfer_manager.cjs`, `portable_export_stopped.cjs`
2. release·source 두 profile 빌드 (`build_plugins.cjs --profile release|source`)
3. release smoke 테스트
4. `update_checksums.cjs --distribution`
5. 빌드 중 source 불변 검증

**minified 바이트는 `PROGRAM/plugins/*.js` 에 닿지 않는다** (dev/release 분리 규약).

---

## 5. 전체 회귀

- 스위트 수: **743** (`tests/*_test.cjs` + `*.test.cjs` 재계산)
- 이전 세션 대비: 731 → 743 (신규 12)
- 실행: `caffeinate -is python3 run_regression_batch.py` (PROGRAM/)
- 결과: **743/743 PASS · FAIL 0 · exit 0**, PASS_SKIP 5

신규 12 스위트 (전부 PASS):

```
371 libra_main_memory_acceptance_test            25.18s
372 libra_main_memory_cost_latency_test           1.83s
373 libra_main_memory_episode_motif_test          0.07s
374 libra_main_memory_gui_wiring_test             0.07s
375 libra_main_memory_mixed_replay_test           3.10s
376 libra_main_memory_mode_parity_test            2.59s
377 libra_main_memory_portable_compatibility_test 3.29s
378 libra_main_memory_profile_lifecycle_test      3.18s
379 libra_main_memory_recall_currentness_test     3.00s
380 libra_main_memory_replay_and_correction_test  3.54s
381 libra_main_memory_schema_compatibility_test   1.09s
382 libra_main_memory_state_operations_parity_test 5.70s
383 libra_main_memory_thread_identity_test        0.94s
```

회귀가 잡은 것 1건: `libra_gui_producer_fields_test` 가 연감 카테고리 목록을 정확히 고정하고 있었다. T09 의 `arcs`/`relations` 추가는 **계약 변경**이므로 테스트에 반영했다 (느슨하게 풀지 않고 정확성 유지 — "생산자 없는 읽기 카테고리 금지" 가 그 테스트의 목적). 수정 후 PASS.

---

## 6. 남은 위험·미완 (숨기지 않음)

| 항목 | 상태 |
|---|---|
| **A04·A05·A06** | fault 주입 시나리오 미실행 — BLOCKED |
| **A43** | 실제 모델 blind gold 미실시 |
| **A44** | 실기기(RisuAI) 미실시 |
| **D05 수치** | 확정하지 않음 — 실 workload 측정 없이 확정하지 않는다 |
| **G01~G18** | G01 은 기존 증거로 통과, G02~G18 미실행 |
| **World Maker 이식 2개** | `itemMaterialSignature`·`mergeItemVersions` (D03 `versions[]` 이력 스냅샷) 미이식. 현재 `preferences`/`boundaries` 는 collection replace/remove 를 지원하지만 **물질-서명 기반 버전 이력은 없다** |
| **§9.2 fixture** | T07 은 두 배치 chain 으로 검증. W0/W1/편집/별칭을 문자 그대로 옮긴 스위트는 미작성 |

### T08/T09 에서 발견한 결함 2건 (둘 다 수정)

1. **`preferences`/`boundaries` 가 화면에 도달하지 못했다.** 필드 라벨(`선호`·`경계`)과 fact 생성은 있었지만 인물 시트의 `groupDefs` 에 두 그룹이 없었고, 시트는 **탭당 한 패널**을 그리므로 그룹만 추가해도 그려지지 않았다. 그룹+탭을 함께 추가해야 했다. 같은 원리로 **`arcs`(이야기 흐름·전환점·반복 소재)** 는 `bookNarrativeModel` 이 값은 만들고 있었지만 `BOOK_NARRATIVE_GROUPS` 에 탭이 없어 한 번도 그려진 적이 없었다 — `02` T09 가 요구한 "상징·핵심 에피소드 읽기" 가 이 경로로 막혀 있었다.

2. **`BOOK_NARRATIVE_GROUPS` 수정 시 2칸 들여쓰기가 깨졌다.** 기존 테스트 2개(`libra_book_narrative_turn_groups_test`·`libra_narrative_almanac_model_test`)가 이 상수를 **선행 공백 포함 문자열로** 슬라이스 앵커로 쓰기 때문에, 앵커가 빗나가 코드 슬라이스가 비고 두 테스트가 깨졌다. 들여쓰기 복원으로 해소.

**"전체 복원 완료"라고 부를 수 없다.** T03–T11 의 구현과 검증은 완료됐지만, fault 축 3건·실모델 축·실기기 축·이식 2개가 남아 있다.
