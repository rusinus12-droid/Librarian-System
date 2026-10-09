# Librarian System 0.3.15 — LIBRA World Manager Narrative V1 구현 감사

> **문서 상태 — 2026-09-04:** 역사적 감사 기록. 아래의 “후속 Phase” 목록은 2026-08-30 당시 상태이며 현재 LIBRA 2.3.24의 미구현 목록으로 간주하지 않는다. 현재 상태는 최신 코드·회귀와 2.3.x 연속 계획의 최신 체크포인트를 우선한다.

기준: Librarian System 0.3.14 / LIBRA 2.2.8
작성: 2026-08-30

## 이번 빌드에서 실제 구현된 범위

- World Manager Current Head에 `narrative` 네 번째 도메인 추가.
- Ariadne의 검증된 Canonical Artifact에서 `libra.narrative_seed.v1` Seed를 로컬 생성.
- Plot ito 기존 호출의 JSON 계약에 선택적 `libra.narrative_patch.v1` 추가. Narrative 때문에 정상 5턴 파이프라인의 LLM 호출 수를 늘리지 않음.
- Plot Narrative patch는 canonical edit patch와 별도 검증. Narrative patch가 없거나 잘못되어도 canonical patch 자체는 유지 가능.
- Plot patch가 없을 때 Ariadne Seed를 보수적 Narrative fallback delta로 사용.
- 기존 continuity delta/state schema 이름은 portable/restore 호환성 때문에 v1을 유지하면서 `narrativePatch`, `domains.narrative`, `head.narrative`, `domainStatus.narrative`를 additive field로 추가.
- Current Head 갱신은 기존 `updateContinuityStateAfterCommit()` 트랜잭션 안에서 수행. 별도 fail-open storage writer를 사용하지 않음.
- `rebuildContinuityForManifest()`에서 활성 canonical refs 전체의 Narrative delta를 재생하여 reroll/rollback/fromStart 재구축에서 Narrative가 stale하지 않도록 함.
- 오래된 delta에 Narrative가 없고 canonical memory에 `canonicalArtifact`가 있으면 별도 LLM 호출 없이 Ariadne fallback Narrative를 재구성.
- 기존 State Correction Journal의 profile patch에 `narrative` patch 적용 지원.
- 공개 API: `getWorldManagerNarrative`, `addWorldManagerNarrativeCorrection`, `setWorldManagerNarrativeCorrectionStatus`, `rebuildWorldManagerNarrative` 추가.
- 기존 Story Arc post-commit은 Narrative가 존재하는 경우 World Manager Narrative의 zero-LLM compatibility projection을 저장하고 `llmCalls: 0`으로 종료. 기존 Story Arc 저장 데이터 자체는 삭제하지 않음.
- World Manager GUI에 `내러티브 계층`, 현재 요약, active Arc, open Thread 표시 추가. History 전체를 첫 렌더에 읽지 않음.
- package metadata를 0.3.15로 정합화.

## 보존한 기존 계약

- LIBRA 내부 플러그인 버전 `2.2.8` 유지.
- `const callAriadne`, `const itoPrompts`, `const updateContinuityStateAfterCommit`, `const rebuildContinuityForManifest` 등 기존 함수 선언/호출 경로 유지.
- 기존 Character/Relationship/World 상태 패치 로직 유지.
- portable-copy의 continuity write 실패가 전체 adoption을 중단하고 rollback하도록 기존 트랜잭션 경계 유지.
- Story Arc legacy key를 삭제하거나 덮어써서 마이그레이션하지 않음.

## 이번 초기 구현에서 아직 compatibility 단계인 부분

다음은 설계서의 후속 Phase에서 완전 이전할 항목이며 이번 빌드에서 임의 삭제하지 않았다.

- 독립 Story Arc 사이드바/설정 화면의 완전 제거 및 World Manager/Planner로 최종 재배치.
- Planner `Narrative Direction` 전용 UI/storage의 완전한 분리.
- Planner/SGA consumer의 필드명을 `story_arc`에서 `narrative_state`로 전면 전환. 현재는 기존 consumer가 zero-LLM Story Arc compatibility projection을 통해 동일 데이터를 받는다.
- 기존 Story Arc 저장본의 명시적 lazy migration marker 및 factual/future 데이터 완전 분해 마이그레이션.
- manual canonical edit용 Plot narrative-only 재분석 전용 호출 경로.

위 항목은 데이터 삭제 없이 단계적으로 전환하기 위해 보류했다.

## 검증

### 기존 회귀 — 연속 21개 PASS

- libra_1.0.74_regression_test
- libra_ariadne_only_defaults_test
- libra_canonical_artifact_v2_contract_test
- libra_canonical_artifact_v2_runtime_test
- libra_canonical_job_runtime_test
- libra_canonical_variant_job_gui_contract_test
- libra_classic_provenance_rescue_contract_test
- libra_classic_provenance_rescue_runtime_test
- libra_continuity_curation_contract_test
- libra_gradia_detailed_results_behavior_test
- libra_gradia_family_gui_contract_test
- libra_gradia_runtime_hardening_behavior_test
- libra_gradia_runtime_skill_contract_test
- libra_gradia_structured_pipeline_v2_behavior_test
- libra_gui_first_open_cold_cache_test
- libra_gui_ux_1.0.132_test
- libra_inference_budget_contract_test
- libra_input_writer_delivery_contract_test
- libra_large_result_lazy_render_contract_test
- libra_latest_state_tracking_contract_test
- libra_long_chat_pair_revision_cache_test

### 추가 핵심 회귀 PASS

- libra_pipeline_scope_navigation_quick_settings_test
- libra_portable_cross_chat_restore_runtime_test
- libra_portable_memory_ui_behavior_test
- libra_prompt_injection_navigation_test
- libra_prompt_studio_ooc_default_targets_test
- libra_protected_product_transfer_test
- libra_provider_budget_runtime_test
- libra_public_brand_internal_contract_test
- libra_world_manager_replay_v2_contract_test
- libra_writing_mode_live_work_ui_contract_test
- librarian_system_brand_contract_test
- libra_world_manager_narrative_v1_contract_test (신규)
- retrace_server_handoff_test

### 패키지 검증

- `node --check PROGRAM/plugins/LIBRA.js`
- ZIP CRC
- 새 ZIP 재추출 후 핵심 회귀 재실행
- SHA-256 sidecar 생성

## 이전 실패 링크의 원인

이전 0.3.15 링크는 빌드 결과 파일이 없는데도 링크가 먼저 제시된 오류였다. 첫 자동 패처는 객체 반환형 `emptyContinuityState`를 탐색하지 못했고, 이후 wrapper 방식 시도는 기존 정적 함수 계약과 portable-copy 트랜잭션 경계를 훼손했다. 본 재빌드는 wrapper를 폐기하고 0.3.14 원본 함수 본문에 additive integration을 적용했다.
