# 2026-10-21 작업 기록: 완료·미완 항목

기준 브랜치: `claude/lens-presets-scope-parity` (main 0084adf 기반). 이 문서는 요청받은 작업 중 끝내지 못한 부분과 그 이유를 남긴다.

## 후속 작업: 렌즈·스코프 범위 (2026-10-21)

사용자가 후속 범위를 **렌즈·스코프 완성과 관련 결함 수정**으로 선택했다.
아래의 기존 완료·미완 목록은 `bd98435` 시점의 이력이다. 회귀 실패 32개
전체 정리나 빠른 설정 통합은 이번 후속 작업의 범위가 아니다.

- 렌즈 프리셋 13개 모두를 실제 `runLensForRange` 경로로 실행하는 스크립트
  응답 검증을 추가했다. 각 프리셋의 지시문·원문 참조 전달, 단일 호출과
  근거 채택을 확인한다. 실제 모델 품질 평가를 대신하는 시험은 아니다.
- Chromium에서 1280/390px의 프리셋 13개 표시·ID 중복·버튼 간격을 검사했다.
  LIBRA/HAYAKU 스코프 패널은 320~1440px에서 54개 검사를 통과했다.
- 참조 중인 스코프는 선택·백업할 수 있지만 삭제·정리에서는 제외된다는 안내를
  항상 표시한다. 참조 스코프와 독립 스코프를 함께 선택해 삭제할 때도 제외
  사유를 보여 주고, 참조 데이터 보존과 독립 데이터 삭제를 검증한다.
- 사라진 메뉴 ID를 가리키던 `agents`/`pipeline` 연결을 현재의 기억 분석
  설정으로 연결했다. 전체 플러그인에서 15개 실제 설정 경로, 이전 별칭,
  미저장 초안과 저장 중 이동 차단을 검증한다.
- 전체 이전 시험은 정상적인 Flashback archiveRef 기본 필드 정규화와
  네이티브 레지스트리 항목 추가를 허용한다. 기존 아카이브 항목의 식별자와
  확인 시점의 원문 바이트는 계속 엄격히 보존·왕복 검사한다.
- LIA GUI 실패 두 건은 이 환경의 Node Playwright 미설치로 재현됐다.
  브라우저 의존성을 준비한 뒤 두 시험이 통과했다. LIA 제품 코드는 바꾸지 않았다.
- Flashback 테스트의 정적 소스 관찰 계획을 재생성했다. 기존 독립 관찰 해시와
  콜백/앵커 검증은 유지한다.

검증 결과: 렌즈·스코프·이전 관련 자동 시험 **65개**, 메타데이터·SDK 및
Flashback 관찰 계획/아카이브 시험 **67개**가 모두 통과했다. 스코프 Chromium
검사 **54개**, 렌즈 스튜디오 1280/390px 검사도 통과했다. 전체 회귀 시험이
통과했다는 뜻은 아니며, 아래의 통합 검색·Micro 관련 미완 항목은 별도 작업이다.

후속 버전: LIBRA **2.3.196**, HAYAKU **3.0.166**, Flashback **1.0.131**,
Storage SDK **1.8.31**. 나머지 플러그인의 버전은 이 후속 작업에서 변경하지 않았다.

## 완료

| 항목 | 내용 | 검증 |
|---|---|---|
| 스코프 데이터 관리 선택 불가 | 선택 못 하는 행에 이유 표시, 클릭 시 안내, 비보안(http) 접속 배너. 이어서 Flashback 규칙으로 맞춤: 현재 채팅·서버 저장 스코프를 뺀 모든 플러그인 단독 스코프를 선택할 수 있고, 실행 시점에 행별로 검증해 제외 사유를 보여 준다 | `scope_management_selection_feedback_test`, `owner_scope_management_runtime_test` 통과 |
| 로컬 업데이터 | `업데이트.sh/.bat/.command` 메뉴 4번, `--local-update` (선택 창 또는 `--release-zip`). 기존 program_only / migration_required 적용·롤백 경로 재사용. `core/file-picker.cjs`를 배포 목록에 추가 | `updater_local_package_picker_test` 통과 |
| 릴리즈 빌더 버전 | 서버 코드·정책·안내문·업데이트 매니페스트는 이미 적용. 빠져 있던 저장소 `README.md` 버전 표기를 빌더가 갱신하도록 수정. `--version 0.4.9` 실제 빌드 확인 | `release_builder_version_backend_scope_test` 통과 |
| 렌즈 프리셋 | 8개 추가(몸 상태, 약속·일정, 관계 변화, 소지품, 비밀·지식, 세계관 규칙, 대사 습관, 갈등 곡선), 총 13개 | `libra_custom_memory_lens_runtime_test` 통과 |
| main 실패 테스트 | 87개 중 55개 정상화 (아래 미완 참고) | 병합 트리에서 재실행 |

버전: LIBRA 2.3.195, HAYAKU 3.0.165, Flashback 1.0.130, LIA 0.26.92, RE:TRACE 1.9.92, GRADIA 0.25.94, Storage SDK 1.8.30.

## 미완 1: 아직 실패하는 테스트 (32개)

main에서 실패하던 87개 중 55개를 고쳤다(낡은 테스트를 현재 계약으로 갱신, 퇴역 계약으로 전환, 환경 한계 SKIP, 일부 제품 결함 수정). 사용자 요청으로 여기서 중단했다. 아래는 마지막 실행(4개 병렬) 결과이며, 일부는 부하 때문에 실패했을 수 있다. 단독 재실행으로 가려야 한다.

- `flashback_archive_owner_failure_test.cjs` — not ok 1 - archive reserved reject never crosses the document wire
- `lia_reopen_evolution_gui_test.cjs` — AssertionError [ERR_ASSERTION]: mounted Chromium runner passes; inspect preserved stdout/stderr
- `libra_associative_final_proof_test.cjs` — AssertionError [ERR_ASSERTION]: graph OFF delivers the eight direct shortlist memories
- `lia_manual_analysis_regression_test.cjs` — AssertionError [ERR_ASSERTION]: mounted_ui command passes; inspect preserved stdout/stderr
- `libra_external_settings_sidebar_runtime_test.cjs` — AssertionError [ERR_ASSERTION]: const migrateCustomWorkshopSelection =
- `libra_gradia_ranked_frontier_basic.test.cjs` — not ok 1 - explicit ranked profile exposes bounded 80-row metadata frontier while ordinary hydration remains 32
- `libra_live_tail_planner_dialogue_source_test.cjs` — AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
- `libra_live_tail_supply_measurement_test.cjs` — AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
- `libra_main_memory_portable_compatibility_test.cjs` — AssertionError [ERR_ASSERTION]: 568 witness: pinned product and fixture file hashes
- `libra_main_memory_recall_successor_delivery_test.cjs` — AssertionError [ERR_ASSERTION]: plugin_only: one validated later closure fact actually reaches the returned block
- `libra_main_memory_thread_lifecycle_boundary_matrix_test.cjs` — AssertionError [ERR_ASSERTION]: the actual Recall closure includes accepted outcomes from the later canonical batch
- `libra_main_memory_thread_lifecycle_transfer_test.cjs` — AssertionError [ERR_ASSERTION]: the keyless target resolves in the native child prefix
- `libra_main_memory_thread_lifecycle_e2e_test.cjs` — AssertionError [ERR_ASSERTION]: the accepted v5 successor reaches the sealed, returned Classic request after entity and summary ch
- `libra_main_memory_letter_lifecycle_105turn_test.cjs` — AssertionError [ERR_ASSERTION]: the historical delivered rows exclude the later T105 fulfillment
- `libra_micro_manual_archive_3mode_test.cjs` — Error: LIBRA_GRAPH_READER_SCOPE_CHANGED
- `libra_micro_multi_predecessor_state_3mode_test.cjs` — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- `libra_memory_graph_store_runtime_test.cjs` — AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
- `libra_micro_portable_predecessor_3mode_test.cjs` — AssertionError [ERR_ASSERTION]: plugin_only: the previous chat's Micro detail reaches Recall after restart
- `libra_phase_d_a11_same_title_promises_test.cjs` — AssertionError [ERR_ASSERTION]: plugin_only Recall verifies the accepted fulfillment as linked evidence
- `libra_micro_timeline_t1t3t5_test.cjs` — AssertionError [ERR_ASSERTION]: plugin_only: the frontier reports the analytically produced turns (got [])
- `libra_network_registry_parity_test.cjs` — AssertionError [ERR_ASSERTION]: actual normal hook must pass candidates through the registry
- `libra_micro_recall_3mode_test.cjs` — AssertionError [ERR_ASSERTION]: generic Micro event and typed canonical possession remain distinct despite matching text/quote
- `libra_q04_reopen_budget_test.cjs` — AssertionError [ERR_ASSERTION]: large reopen delivered
- `libra_receipt_sparse_micro_frontier_test.cjs` — AssertionError [ERR_ASSERTION]: retired Micro-frontier is not reported by the unified route
- `libra_phase_d_candidate_context_scale_synthetic_test.cjs` — AssertionError [ERR_ASSERTION]: focused event-loop stall sentinel: 10,000-ref candidate processing should deliver a 5ms cancellati
- `libra_source_edit_settled_admission_runtime_test.cjs` — AssertionError [ERR_ASSERTION]: handoff_budget_spent: changed, missing or unsettled authority suppresses every Classic block
- `libra_unified_identity_split_v1_test.cjs` — Error: UNIFIED_SPLIT_SOURCE_UNRESOLVED
- `source_turn_registered_runtime_test.cjs` — not ok 5 - registered LIBRA unavailable Micro enumeration never reports a complete zero
- `storage_global_owner_public_gui_test.cjs` — AssertionError [ERR_ASSERTION]: 설정 적용 시작 실패
- `libra_phase_d_candidate_context_scale_test.cjs` — TIMEOUT libra_phase_d_candidate_context_scale_test.cjs TIMEOUT
- `libra_phase_d_timeline_caps_test.cjs` — TIMEOUT libra_phase_d_timeline_caps_test.cjs TIMEOUT
- `remote_update_release_zip_runtime_test.cjs` — AssertionError [ERR_ASSERTION]: startup preserves seeded field vector_rag_memory:scope:1p41uyl:manifest:v2/archiveRef

분류 메모:
- `libra_main_memory_*`, `libra_micro_*`, `libra_q04_*`, `libra_phase_d_*`, `libra_receipt_*` 계열: 통합 검색 엔진 교체(9c03c35)로 퇴역한 옛 closure·Micro frontier 경로를 겨냥한 낡은 테스트가 대부분이다. 현재 계약으로 다시 쓰거나 퇴역 계약으로 전환해야 한다. 일부는 `LIBRA_GRAPH_READER_SCOPE_CHANGED`, 핸들 무효화 같은 실제 읽기 경로 결함일 수 있어 확인이 필요하다.
- `libra_phase_d_candidate_context_scale_*`, `libra_phase_d_timeline_caps_test`: 성능·시간 초과. 단독 실행과 시간 상한 조정이 필요하다.
- `storage_global_owner_public_gui_test`, `remote_update_release_zip_runtime_test`: 이 테스트들은 시드된 `archiveRef` 보존 확인에서 실패한다. 전체 빌드에 의존하는 테스트라 먼저 `storage_global_owner_public_gui_test` 원인을 분리해야 한다.
- `lia_*_gui_test`, `lia_manual_analysis_regression_test`: 실제 Chromium 실행기 결과를 확인해야 한다.
- 이전 감사에서 확인했지만 처리하지 못한 것: Flashback의 `lastRecall` 누락 가능성, `selectBookExternalSettings('agents')`가 존재하지 않는 'pipeline'을 가리키는 별칭.

## 미완 2: 요청했지만 하지 못했거나 보류한 것

- **리브라 설정 퇴역 완료 (2026-10-22 후속 요청)**: 빠른 설정 서랍·상단 버튼·초기 자동 안내·중복 AI 연결 폼을 제거했다. 연결은 기존 AI 프리셋과 임베딩 설정에서 관리한다. 최근 대화 직접 주입 UI와 응답 덧붙이기를 제거했으며, 과거 활성화 설정을 불러와도 재활성화되지 않는다. 검색 질의를 위한 대화 읽기는 퇴역한 주입 설정과 분리했으며 Micro 기억 생성·검색은 유지한다. 실제 Micro 전달 및 원문 미주입을 플러그인·미러·서버 단독 모드에서 검증했다. 추가 점검에서 검색용 대화가 읽기 전용 ResponseContext의 terminal_scene으로 재노출되는 경로를 차단했다. 검색 전용 투영과 완료 턴 영수증 검증은 유지한다. 왼쪽 하단 현재 상태에서 정식 설정으로 이동한다. 기존 저장 데이터·인증 정보는 삭제하지 않는다.
- **렌즈 프리셋 실측**: 몸 상태 렌즈만 실제 모델로 측정했다. 나머지 7개는 정의 형태와 슬롯 순환만 검사했다. 추가한 이유 외에 모델 응답 품질은 미확인이다.
- **스코프 패널 브라우저 검증**: 실제 Chromium 기반 `owner_scope_management_browser_test.py`는 이번 변경(Flashback 방식 선택 규칙) 후 실행하지 못했다. jsdom 기반 테스트만 통과했다. 사용자가 실제로 어느 저장 모드에서 선택이 안 됐는지는 확인하지 못했다.
- **로컬 업데이터 실기 확인**: 파일 선택 창(Windows/macOS/Linux)은 가짜 실행기로만 검증했다. 실제 창을 띄운 시험과 실제 ZIP 적용(이관 포함)의 사람 손 확인은 하지 못했다. 파일 이름이 공식 형식이 아니면 거부한다.
- **릴리즈 빌더**: 실제 빌드는 `source` 프로필의 `offline_candidate`로만 돌렸다. 정식 배포 프로필 전체 빌드는 하지 않았다.
- **서버 저장 스코프**: 스코프 데이터 관리 화면은 서버에 저장되는 스코프를 설계상 삭제하지 않는다(RE:TRACE 서버 관리에서 처리).
