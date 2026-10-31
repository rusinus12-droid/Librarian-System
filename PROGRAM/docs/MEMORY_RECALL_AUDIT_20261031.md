# 기억 회상 감사 — 2026-10-31 라이브 기록

근거: `gradia-debug-2026-10-31 (3).json`, `libra-debug-2026-10-31 (1).json` (같은 턴).
모든 시각은 파일의 epoch(ms)이며 UTC 기준이다. 턴 14 / scopeKey `963560b0_24:0`.

## 1. 미크로 기억 작성 실패 — 원인은 "계획 미승인"

런타임 기록이 사유를 직접 말한다.

| 근거 | 값 |
|---|---|
| `operationalHealth.captureBackend.lastMicroPublication` | turn 14, `status: unknown`, `reason: micro_work_missing`, `queueWaitMs: 34225` |
| `operationalHealth.captureBackend.microQueuedJobs / capacity` | `0 / 64` — 큐 넘침 아님 |
| `captureBackend.backend` | `script_output_legacy`, `fallbackReason: runtime_failover:chat_output_silent_after_request` |
| `captureBackend.observedRuns / silentFailovers` | `1 / 1` — chat-output v3 리스너는 이 턴의 출력을 관찰하지 못했다 |
| `lastMemoryAfterRequest` (1793410502518) | `blockedReason: capture_backend:chat_output_v3` |
| `lastMemoryScanSchedule` (1793410704568) | `reason: risu_output`, `finishedAt` 1793410794099 |

연쇄는 이렇다.

1. `CHAT_OUTPUT_V3` 리스너가 출력 커밋을 보지 못해 `CHAT_OUTPUT_HEALTH_GRACE_MS`(5s) 뒤
   `activateLegacyBackendAfterSilentV3` 로 폴백한다.
2. 폴백 이후 캡처 경로는 `captureSource='completed_pair_reconcile'` 뿐이다. 미크로 work journal은
   `persistCompletedTurnReceipt` 안에서 `admitMicroPlan === true` 일 때만 예약되는데, 이 값은
   `freshMainAfterRequestPair()` 의 결과다.
3. 그 함수는 `Date.now() - health.at > 120000` 이면 false 였다. afterRequest는 1793410502518,
   스캔 실행은 1793410704568 → **202초**. 창(120초)을 넘겨 계획이 거부됐다.
4. 계획이 없으니 `produceMicroForTurn` 은 `micro_work_missing` 을 돌려주고, 해당 턴은 원문(raw
   receipt)만 남는다. `analysisStatus` 가 비고 `microFrontier.lastKnownTurn` 이 0인 이유다.

즉 이번 턴의 사유는 **큐 용량 초과도, 분석 불가도 아니고 "계획 미승인(micro_work_missing)"** 이다.
멀티스테이지 초안이 105초(파이프라인 총 105.3초) 걸리는 이 환경에서 120초 창은 구조적으로 너무 짧다.

## 2. GRADIA의 LIB 읽기 실패 — 코드가 다른 두 실패

| 경로 | 코드 | 근거 |
|---|---|---|
| 입력 보조(writer) | `LIB_READ_MODEL_CONTEXT_UNAVAILABLE` | `warnings`: `input_writer_memory_unavailable …` (1793410303326), `inputAssistSend.memory` |
| 본문 생성 | `LIB_READ_UNIFIED_UNAVAILABLE` | `finalDraftMeta.libReadStatus: unavailable`, `externalEvidence: false` |

### 2-a. writer: 문맥 한도를 못 구해 3초를 쓰고 포기

`libModelContextProfile()` 는 manual(`context_window`)·catalog(`metadata_model_id` 일치)·
provider 기본값 중 하나가 없으면 `null` 을 돌려주고, 리더는 이를 즉시 `LIB_READ_MODEL_CONTEXT_UNAVAILABLE`
로 처리한다. 이 프리셋(`ollama_cloud` + `deepseek-v4.1-flash:1017-cloud`)은

- `modeForProvider('ollama_cloud')` = `openai_compat` 이라 `providerDefault` 가 0,
- 카탈로그 조회는 `item.id === modelId` 완전일치라 `:1017-cloud` 접미사 때문에 매칭 실패

→ 프로파일 없음. 그리고 그 앞에서 `listProviderModels` 를 3초 기다린다. 입력 보조 스테이지가
4.3초 걸린 것(`stageTrace` input_assist `elapsedMs: 4336`)이 이 3초 대기와 일치한다.
결과적으로 writer 는 기억을 전혀 못 받는다(원문만으로 선택지 생성).

### 2-b. response: 남은 사유는 아직 기록되지 않는다

`LIB_READ_UNIFIED_UNAVAILABLE` 은 LIBRA 쪽 실패를 리더가 하나로 접은 코드다. 후보 지점:

- `captureGradiaMemoryEvidence` 의 `graph.modelDispatchEligible !== true`
- LIBRA `query`/`verify` 안에서 던져진 `LIBRA_GRAPH_*` 오류(리더 `catch` → `LIB_READ_UNIFIED_UNAVAILABLE`)
- `assertCurrent()` false

이 턴의 LIBRA 클래식 회상은 **같은 패킷 검증을 통과했다**(`finalVerification.status: verified`,
`verifiedNodeCount: 23`, `modelDispatchEligible: true`). 즉 그래프 자체는 유효했고, GRADIA 읽기
경로(consumer=`gradia`, `gradiaSelectionReceipt`, lens 스냅샷)에서만 실패했다. 이번 라운드에서는
그 지점을 **기록**하도록 고쳤다(아래 4절). 다음 턴 디버그에서 `lastGradiaUnifiedRead.code` 가 원인을 말한다.

## 3. LIBRA 회상 엔진·렌즈·통합 점검

### 3-a. 시간 분포 (총 18,294ms / 예산 90,000ms, 타임아웃 0)

| 단계 | 시작(ms) | 소요(ms) | 비고 |
|---|---|---|---|
| before_context | 0 | 1,065 | |
| before_branch_reconcile | 1,067 | 147 | |
| before_receipt_dialogue | 2,975 | 1,206 | 앞에 **1,761ms** 미계측 |
| graph_owner_frame / corpus_context / corpus_read | 4,252 | 344 / 75 / 187 | |
| *(미계측)* | 4,858 | **3,852** | pin readset + 소스 본문 순차 읽기 |
| native_query_embedding | 8,917 | 514 | 쿼리 임베딩 1회 |
| graph_select_and_validate | 9,437 | 4,056 | retrieve+compile+render |
| lens_recall | 13,494 | 339 | |
| unified_response_boundary | 13,834 | 193 | |
| unified_query_receipts | 14,027 | 827 | |
| unified_final_consumer | 14,854 | **3,438** | `validatePacket` 재검증 |

계측된 합 12,391ms, 나머지 5,903ms 는 라벨이 없다. 그중 최대가 3,852ms(pin 읽기 구간)로,
`captureConditionalReadSet` 뒤 `readRawSource` 를 **핀 소스마다 순차 await** 하는 루프다
(`LIBRA.js` `executeMemoryGraphUnifiedQueryOnce`). 순차 I/O 를 병렬화하면 줄일 수 있는 후보지만,
`pinnedValues.push` 가 append 방식이고 `resources` 회계가 진행 중 값에 의존하므로
`async-throughput-optimization` 기준(직렬 베이스라인 측정 → 순서 독립성 증명)을 먼저 만족해야 한다.
이번에는 **측정만** 넣었다(`diagnostics.sourcePin`). 캐시는 문제가 없다:
`pairRevisionCache` hits 34,777 / misses 28, `branchFastCacheScopes` 1.

### 3-b. 렌즈는 "리콜 코드에 연결돼 있으나 후보 0"

`lastMemoryRecallViewer.lensRecall` = `enabled: true`, `budgetChars: 880`, `usedChars: 0`,
`injectedItems: []`, `skippedCandidates: []`, `perLensBudgets: []`,
`semantic: { status: 'ready', profileId: 'mep_…', scored: 0, missingVectors: 0 }`.

`recallLensMemories` 의 해당 반환은 `withCandidates.length === 0` 분기다
(`enabled:true, semantic` 포함). 즉 **활성 렌즈는 있으나 그 렌즈의 레코드가 0건**이었다.
`loadLensRecordsMap` 이 실패하면 `.catch(() => ({}))` 로 조용히 비었기 때문에, 이번 기록만으로는
"레코드가 없다"와 "저장소를 못 읽었다"를 구분할 수 없었다 — 그 구분을 계측으로 남긴다.

GRADIA 읽기 경로(`gradiaLensReadSnapshot`)는 같은 lens 저장소를 **fail-open 없이** 읽는다.
렌즈 읽기 한 번이 실패하면 정본 읽기 전체가 `LIB_READ_UNIFIED_UNAVAILABLE` 로 죽는다(2-b의 유력 후보).

### 3-c. 정본·상태 추적·미크로·로어 통합 상태

이번 턴 실제 주입 행: `lore 11 + canonical 3 = 14`. 미크로 0, 렌즈 0. **상태 추적 산출물도 0**이다.

| 레인 | 이번 턴 | 근거 |
|---|---|---|
| 정본(canonical) | 주입 3 | rows 중 3, `finalVerification.verifiedNodeCount 23` |
| 로어(lore) | 주입 11 | rows 중 11 |
| 미크로 | **주입 0** | 1절 — 검증된 미크로 기억이 생성되지 않음(`microFrontier.analysisStatus: unavailable`) |
| 상태 추적 | **주입 0** | 주입문(`lastInjection`)에 state 투영 라인이 없다. 저널도 `pending 1` |
| 렌즈 | 형식상 참여, 산출 0 | 3-b |

상태 추적은 제품에 **레인으로 존재한다**: 리더가 `family: 'state'` 노드를 만들고
(`state_current` / `state_last_known` / `user_corrected` 역할), continuity state head 의
`fieldEvidence` 가 있는 필드만 노드가 된다. 즉 "이 기능이 꺼져 있다"가 아니라
**이 턴에는 그 레인이 산출물을 내지 못했다**가 정확한 진술이다.

그 이유로 확인된 것과 아닌 것을 구분하면:

- 확인됨: 저널 리플레이가 `pending 1`, `UNIFIED_EDIT_REPLAY_FAILED:UNIFIED_SERVER_LEGACY_NOT_SUPPORTED`.
  `requireUnifiedStorageBackend` 의 `fullContinuityRefs(saved).every(unifiedRefIsReadableUnified)` 단언이
  커밋된 ref 중 unified 판독 불가 아티팩트 스키마(v4 계열) 하나 때문에 state 파이프라인 진행을 막는다.
  `storyArc.continuityState.updatedThroughTurn` 도 0 이다.
- **확인되지 않음**: head 자체가 비었는지, head 는 있는데 `fieldEvidence` 없는 필드만 남아 노드가
  스킵됐는지, 노드는 만들어졌으나 순위/예산에서 탈락했는지. 리더는 이 셋을 서로 다른 사유
  (`state_view_unavailable` / `field_provenance_unknown` / 순위 탈락)로 계산하지만
  `graph.coverage.families` 를 디버그로 내보내지 않아 **기록만으로는 판별할 수 없다**.
  이번 라운드에서 그 값을 `delivery.familyInventory` + `laneCoverage.stateUnits/stateReasons` 로 노출한다.

## 4. 이번에 바꾼 것

| 위치 | 변경 | 이유 |
|---|---|---|
| `LIBRA.js` | `TURN_BINDING_FRESHNESS_MS = 900000` 도입, 120초 창 4곳 교체 | 결속은 다이제스트가 하고 시간은 상한일 뿐 — 105초 파이프라인이 계획을 잃지 않게 |
| `LIBRA.js` | `mainAfterRequestPairProof()` 로 사유 분리(`boundary_expired`, `user_source_changed` …) | `admitMicroPlan:false` 하나로는 무엇이 틀렸는지 알 수 없음 |
| `LIBRA.js` | `state.lastMicroPlanRefusal` 기록 + `lastMicroPublication.planRefusal` 노출 | `micro_work_missing`이 "왜"인지 런타임이 말하게 |
| `LIBRA.js` | `recallLensMemories`: 렌즈별 `lensReads`(레코드 수/저장소 상태), `emptyReason`, 신규 스킵 사유 `lens_storage_unavailable` | 렌즈 미참여 사유를 기록으로 판별 |
| `LIBRA.js` | `gradiaLensReadSnapshot`: `LIB_READ_STALE/BUDGET/CANCELED/NATIVE_SCOPE_CHANGED` 만 치명, 나머지 렌즈 오류는 canonical-only 로 강등(`lensStatus`, `lensReason`) | 비정본 렌즈 저장소 오류가 정본 근거까지 지우지 않게 |
| `LIBRA.js` | `state.lastGradiaUnifiedRead`(ok/code/purpose/elapsed/lensStatus) 기록·디버그 노출 | `LIB_READ_UNIFIED_UNAVAILABLE` 의 실제 원인 보존 |
| `LIBRA.js` | delivery `laneCoverage`(canonical/lore/micro/lens/stateBases/verifiedNodes) | "네 레인이 전부 참여했나"를 한 줄로 |
| `LIBRA.js` | `delivery.familyInventory` + `laneCoverage.stateUnits/stateRecords/stateReasons` (= `graph.coverage.families`) | 상태 추적 미참여가 "head 없음"인지 "증거 없는 필드"인지 "순위 탈락"인지 판별 |
| `LIBRA.js` | `diagnostics.sourcePin`(keys, readsets, readsetMs, bodyReadMs) | 3,852ms 미계측 구간의 정체 |
| `LIBRA.js` | `UNIFIED_SERVER_LEGACY_NOT_SUPPORTED` 메시지에 차단 ref 목록 | 상태 추적 pending 의 원인 특정 |
| `GRADIA.js` | `libCatalogContextLimit`(leaf-id 매칭) + Ollama 게이트웨이 기본 문맥 + 실패 10분 캐시 | writer 문맥 프로파일 null 및 3초 재시도 제거 |
| `GRADIA.js` | `Runtime.lastLibReadDiagnostic` / `lastInputWriterReadDiagnostic` (purpose/status/code/stage/elapsed) | 실패 지점·소요를 디버그에 남김 |

버전: LIBRA `2.6.11`, GRADIA `0.28.6`.

## 5. 검증

- `node --check` 두 플러그인 통과.
- 관련 시험: `gradia_input_writer_context_preflight_test`(10/10), `gradia/model-context-*`(전부),
  `source_turn_accounting_test`(15/15 묶음), `api_v3_capture_health_failover_test`,
  `libra_lens_semantic_recall_runtime_test`, `gradia_input_writer_unified_runtime_test`,
  `libra_micro_*`, `libra_consumed_micro_freshness_runtime_test`, `libra_associative_recall_test`.
- 회귀 판정: 동일 5개 시험 파일을 stash 전/후로 실행해 **실패 이름 집합 동일**(7건, 신규 0).
  `libra_gradia_lens_ipc_runtime_test` 의 `server_only` 실패는 변경 전에도 동일하게 실패한다(기존 베이스라인).
- `plugin_version_byte_provenance_test` 는 실패하지만 기존 베이스라인이다:
  `docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json` 의 `currentRelease` 행이
  flashback 1.3.9 / hayaku 3.3.9 / libra 2.6.9 / gradia 0.28.3 으로, **이번 커밋 이전(HEAD~1) 바이트와도
  이미 불일치**한다(lia·retrace 는 일치). 릴리스 시점에 갱신되는 산출물이라 이번 변경과 무관하다.

## 6. 다음 턴에서 확인할 것

1. `operationalHealth.captureBackend.lastMicroPublication.planRefusal` 가 비었는지(=계획 승인됨),
   `status` 가 `verified` 로 바뀌는지.
2. `lastGradiaUnifiedRead.code` / `stage` — response 읽기 실패의 실제 코드.
3. `laneCoverage.micro` > 0, `laneCoverage.lens`/`lensRecall.lensReads[].records`,
   `laneCoverage.stateUnits` + `stateReasons`(= `familyInventory.state.reasons`):
   `state_view_unavailable` 면 head 없음, `field_provenance_unknown` 면 증거 없는 필드뿐,
   비어 있고 units>0 이면 레인 정상·이번 질의에서 미선택.
4. `lastMemoryPendingBoundaryRecovery.stateTrackingRecovery.entries[].error` 에 찍히는 차단 ref.
5. `lastMemoryRecallRuntime.phases` 에서 사라져야 할 미계측 구간(3,852ms) → `diagnostics.sourcePin`.
