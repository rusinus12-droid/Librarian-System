# 최신 인계: 10·11차 개발 적용본

현재 적용 및 잔여 작업은 [10·11차 보고](INTEGRATED_IMPLEMENTATION_10_11.md)와 [잔여 계획](plan_10_11_remaining.md)을 우선한다. 아래 9차 인계는 이력으로 보존한다.

---

# 9차 이후 인계 — 응답 작성기 v2

MemorySuite 0.3.35 / LIBRA 2.3.42 / Storage SDK 1.8.15. 기반은 v1.8 계획과 8차 Librarian이며, 운영 인증이 아닌 개발 지원 범위다. 현재 기능과 제약은 INTEGRATED_IMPLEMENTATION_09.md를 따른다. 이전 INTEGRATED_IMPLEMENTATION_08.md는 역사로 보존했다.

## 연결점

외부 runtime의 `normalizeResponseConsumerPolicy`, `createConsumerOperation`, `reserve/settleConsumerSubmission`, `callConsumerGeneration`, `consumerAwaitHost`가 역할·예산·실제 제출·취소·usage 계약이다. `callLLMWithPreset`의 consumer option은 기존 Librarian 경로와 분리한다. `callSgaProvider`는 기존 guard와 새 operation을 같이 사용한다.

`consumerSourceInventory/loadConsumerReferenceInventory`는 실제 참고자료 캡처/재조회, Core의 `build/assertConsumerReadSet`, `prepareConsumerEvidence`, `consumerEntityProjection`은 consumer 전용 projection이다. 현재 canonical memory producer의 `unifiedStateReadProjection`은 재작성하지 않는다. host selected database 필드의 허용 목록을 넘기지 않는다.

`normalizeBoundSgaPatch/buildSgaPatchBinding`의 schema는 v3이며 모델 측 계약 토큰·참조 연결과 자연어 의미 인증을 혼동하지 않는다. `sgaProtectedAnalysisStage` 및 protected transfer는 rejected directives를 활성 지침에 넣지 않는다. 중량은 profile/Skill을 같은 stage context에서 컴파일한다.

`inspectInputWriterChoices`, `generateLibraInputWriterChoices`, picker의 usable/partial, `translateInputAssistReviewText`와 delivery picker의 editorRevision/hash를 함께 유지한다. 번역 close/cancel 시 논리 취소와 물리 host pending을 구분하고 늦은 비용을 잃지 않는다.

## 다음 우선 작업

1. 허용된 실호스트 및 외부 모델·예산으로 Planner/SHADOW/AIDE/IW/번역 의미 평가를 수행한다. 이번 합성 provider 결과는 지연/정확도 benchmark가 아니다.
2. 새 source readset의 host별 세부 inventory/권한/CBS·자료 부재/정책 변경을 확대 검수한다. 전체 자료 bulk reader가 필요한 host의 비용을 측정하고 직접 item API가 있을 때만 최적화한다. expected digest 복사로 우회 금지.
3. 모델의 per-edit sidecar가 본문 의미와 다를 수 있는 반례를 독립 채점한다. 구조화된 실제 사용자 제약부터 추가 결속하되 자연어를 키워드로 의미 인증하거나 또 다른 상시 Verifier를 넣지 않는다.
4. consumer seed/dependency selection과 required context overflow의 실제 장기세션을 점검한다. 필수 자료를 빼고 completed로 바꾸지 않는다. 선택 완전성과 문맥 누락 없는 packing은 다른 보장이다.
5. OtherAx cancel/queue ownership, direct transport deadline, usage unknown·report 분리를 실호스트에서 검사한다. prefix cache 지원을 추가할 때 capability와 실제 적용/비용을 검증한다. 현재 GUI correction 범위 설명을 유지한다.
6. 기존 제한 server writer/마이그레이션/mirror·다중 writer/영구 archive GC는 별도 미완료. 가드 제거로 지원을 확대하지 않는다.

## 재현

PROGRAM에서 `node tools/check_sdk_sync.cjs`, `node tools/sync_source_edit_consent.cjs --check`, `node tools/sync_source_review.cjs --check`를 실행한다.

새 `libra_input_writer_contract_v2_test`, `libra_response_readset_v2_test`, `libra_planner_consumer_v2_test`, `libra_gradia_consumer_v2_test`, `libra_consumer_transport_v2_test`, `libra_consumer_reference_material_v2_test`의 CJS와 `tests/browser/libra_response_consumers_v2_browser_test.py PROGRAM OUTPUT`를 실행한다. 기존 Writer browser와 Librarian/서버/승계 관련 회귀도 함께 실행한다.

`MEMORY_SUITE_REGRESSION_LOG=<외부/full.log> python run_regression_batch.py`는 전체 시험이다. source 수정 후 최종 hash 고정·전체 검수·공식 빌더·재추출을 다시 해야 한다. 중간 candidate PASS를 최종으로 쓰지 않는다. 최종 보고서의 test classification과 실패 로그를 보존한다. 사용자 DATA/키/폰트/host dependency/로그는 PROGRAM 배포에 넣지 않는다.
