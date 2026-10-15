# LIBRA Unified Memory Engine Evaluation Contract (N06-a)

**Document Version:** 1.1.0
**Date:** 2026-10-15  
**Status:** Synthetic kernel evaluation; native quality and installation acceptance incomplete
**Related Documents:**
- [`LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md`](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md) (§9 N06-a)
- [`LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md`](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)
- [`LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md`](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md)
- Standardized Fixtures: [`PROGRAM/tests/fixtures/libra_unified_memory_eval_cases_v1.json`](../tests/fixtures/libra_unified_memory_eval_cases_v1.json)
- Evaluation Harness: [`PROGRAM/tools/evaluate_libra_unified_memory.cjs`](../tools/evaluate_libra_unified_memory.cjs)
- Acceptance Test Suite: [`PROGRAM/tests/libra_unified_memory_evaluation_test.cjs`](../tests/libra_unified_memory_evaluation_test.cjs)

---

## 0. 현재 측정 범위

runner는 작은 합성 graph와 stub owner currentness로 query→compiler를 실행한다. 실제 source cursor·저장 owner·provider·RisuAI 설치를 호출하지 않는다. 8/8 PASS는 이 fixture의 채택 근거 검사이며 제품 품질·권한·규모의 완성 판정이 아니다. UME-02는 실제 창 밖 owner 읽기를, UME-04는 명시적 제외 없이 정정을 판단하는 능력을, UME-07은 provider 장애를 증명하지 않는다. UME-05에는 실제 future·분기·private 반례를 넣었고 관계는 명시적 fixture edge만 사용한다.

`f8fce44` 후속 수정으로 기대 outcome·requiredFamilies·hasDroppedUnits·흡수·각 예산을 검사한다. 미지원 expected/passCriteria 키나 잘못된 값은 오류로 거부한다. 결과 `checks`는 각 합격 기준을 보고하며 summary의 dispatch는 dispatch check만 집계한다.

lexical ablation은 같은 엔진의 `QueryFrame.ablationMode:lexical_only`로 semantic/entity/predicate seeds와 관계 확장을 끈다. 같은 viewer/asOf/exclusion·consumer 정책의 **최종 admitted bundle**끼리 비교한다. mandatory lore·현재성·출력 예산은 공통 정책으로 유지한다. graph-only/vector-only 반증에서 해당 근거가 사라지는 것을 검사한다. 별도 구형 ranker를 실행하지 않는다.

## 1. 개요 및 목적 (Overview & Purpose)

N06-a는 LIBRA 통합 메모리 엔진(Unified Memory Engine)의 **표준 평가 벤치마크 세트(Standardized Evaluation Benchmark Suite)와 사전 합격 기준(Pass Criteria)**을 정의하고 고정한다.

### 1.1 핵심 원칙
1. **사전 고정(Pre-fixed Gate)**: Gold evidence, 금지 근거(Forbidden Leaks), 기대 채택 결과(Delivery Outcome) 및 소비 정책을 측정 전에 고정하여 평가 편향을 원천 차단한다.
2. **레거시 서빙 미부활**: 구형 서빙 경로(`legacy`, `shadow`의 이중 발송)를 평가를 핑계로 되살리지 않는다. 통합 엔진 단일 실행 하에서 End-to-End로 측정한다 (§10, §13).
3. **신호 절제(Signal Ablation) 계측**: 어휘 전용 신호의 최종 채택 묶음과 전체 신호의 최종 채택 묶음의 중복도(Overlap Ratio) 및 기여도를 격리 계측한다.
4. **미측정 가중치 보존**: N06-b 대규모 실제 모델 공급자 보정 전까지 `calibration: 'unmeasured'` 선언을 정직하게 유지한다.

---

## 2. 표준 평가 시나리오 8종 (Core Benchmark Scenarios)

평가 셋은 다음 8개 합성 사례를 다룬다. 제목의 범주와 실제 검증 범위는 §0의 제한을 따른다:

| Case ID | 범주 (Category) | 핵심 검증 목표 | Gold Evidence | Forbidden Guard |
|---|---|---|---|---|
| `UME-01` | `multi_family_synthesis` | 4대 자료(정본 역사, Micro 사건, 현재 상태, 세계관 설정)를 단일 질의에서 유기적으로 연결 | `s_key_current`, `l_key_lore`, `c_key_history` | `위치_알수없음`, `분실` |
| `UME-02` | `beyond_first_window` | 기본 윈도우(최근 20턴) 이전의 원거리 과거 기억(턴 2 고대 조약) 정확 도출 | `c_ancient_treaty` | `조약_파기` (역사 왜곡 토큰) |
| `UME-03` | `named_entity_synonym_multilingual` | 한/영 혼용 고유명사 및 별칭(Dr. Evelyn Reed ↔ 에블린 박사 ↔ 그림자 연구원) 식별 및 동일 개체 연결 | `c_evelyn_intro`, `s_evelyn_status` | 타 개체 오결속 차단 |
| `UME-04` | `correction_conflict_unknown` | 과거 폐기/대체된 상태(Superseded) 배제 및 최신 유효 상태(Active) 확정 채택 | `s_bob_current` | `s_bob_stale`, `성문 경비병` (과거 직업) |
| `UME-05` | `temporal_worldline_viewer_isolation` | 분기 세계선(Branch) 및 비공개 열람자 전용 정보의 일반 열람자 질의 유출 완전 차단 | `c_main_event`, `s_main_state` | `분기_세계선`, `비밀_반역` |
| `UME-06` | `mandatory_lore_and_absorption` | 질의 키워드 불일치에도 필수 세계관(Mandatory Lore) 강제 포함 및 상응 정본이 존재하는 동일 사건 Micro의 M08 보수적 흡수 | `l_mandatory_rule`, `c_absorbed_counterpart` | `m_absorbed_unit` (흡수되어 중복 채택 금지) |
| `UME-07` | `vectorless_and_provider_fault` | 벡터가 없는 입력에서 어휘 검색. 실제 공급자 장애는 별도 native 회귀 | `c_lexical_target`, `s_lexical_state` | 벡터 부재로 인한 침묵/실패 차단 |
| `UME-08` | `resource_budget_partial_stop` | 자원 예산 초과(maxUnits=1 등) 시 예산 상한 엄수 및 결정적 Bounded 수렴 | 예산 상한 1개 수렴 | `maxAdmittedUnits: 1`, `renderedCharacterLength <= 200` |

---

## 3. 스키마 명세 (Data & Result Schemas)

### 3.1 벤치마크 정의 스키마 (`libra.unified_memory_eval_cases.v1`)
[`PROGRAM/tests/fixtures/libra_unified_memory_eval_cases_v1.json`](../tests/fixtures/libra_unified_memory_eval_cases_v1.json)에 정의된다.
```json
{
  "schema": "libra.unified_memory_eval_cases.v1",
  "version": 1,
  "caseCount": 8,
  "cases": [
    {
      "id": "UME-01",
      "category": "multi_family_synthesis",
      "label": "4대 자료 복합 연결 (정본·Micro·State·Lore 단일 탐색)",
      "corpus": { "canonical": [...], "micro": [...], "state": [...], "lore": [...] },
      "query": {
        "queryText": "...",
        "asOfTurn": 20,
        "viewerId": "owner_reader",
        "worldlineId": "main",
        "excludedNodeIds": [],
        "consumerPolicy": { "consumer": "classic", "maxCharacters": 4096, "maxUnits": 10 }
      },
      "expected": {
        "goldNodeIds": ["..."],
        "requiredFamilies": ["canonical", "state", "lore"],
        "deliveryOutcome": "complete",
        "modelDispatchEligible": true
      },
      "forbidden": {
        "forbiddenNodeIds": [],
        "forbiddenTokens": []
      },
      "passCriteria": {
        "minGoldRecall": 1.0,
        "maxForbiddenFound": 0
      }
    }
  ]
}
```

### 3.2 평가 결과 스키마 (`libra.unified_memory_evaluation_result.v1`)
[`PROGRAM/tools/evaluate_libra_unified_memory.cjs`](../tools/evaluate_libra_unified_memory.cjs) 실행 시 출력된다.
```json
{
  "schema": "libra.unified_memory_evaluation_result.v1",
  "evaluationVersion": 2,
  "evidenceScope": "synthetic_kernel_fixtures_not_native_owner_or_production_acceptance",
  "timestamp": "ISO-8601",
  "wallMs": 42,
  "totalCases": 8,
  "passedCases": 8,
  "failedCases": 0,
  "allPassed": true,
  "summaryMetrics": {
    "averageGoldRecall": 1.0,
    "totalForbiddenLeaks": 0,
    "allDispatchEligibleAsExpected": true
  },
  "results": [ ... ]
}
```

---

## 4. 합격 판정 게이트 (Pass Criteria & Acceptance Gates)

모든 시나리오는 다음 게이트를 **전부 통과(All Passed)**해야 최종 합격으로 판정된다:

1. **Gold Evidence Recall $\ge 1.0$**:
   - 정의된 모든 `goldNodeIds`가 최종 채택 항목(`bundle.items`)에 포함되어야 함.
2. **Forbidden Leaks $== 0$**:
   - `forbiddenNodeIds`에 지정된 노드가 채택되지 않아야 함.
   - `forbiddenTokens`에 지정된 문자열이 렌더링된 텍스트(`packet.renderedText`)에 전혀 포함되지 않아야 함.
3. **M08 Conservative Absorption**:
   - 상응 정본이 존재하는 Micro 단위(`m_absorbed_unit`)는 `bundle.suppressedMicroIds`에 등록되어 렌더링에서 제외되어야 함 (`UME-06`).
4. **Budget Boundary Enforcement**:
   - `maxAdmittedUnits` 및 `maxCharactersStrict`를 단 1단위/1자도 초과하지 않아야 함 (`UME-08`).
5. **Model Dispatch Eligibility Conformance**:
   - 활성 소비자(`classic`, `gui`, `gradia`)의 완전 유효 패킷만 모델 발송 자격을 획득해야 하며, 역사적 포매터(`planner`, `sga`, `input_writer`)는 발송 권한이 차단되어야 함 (N00 연계).

6. **선언된 결과와 자료 범위**:
   - `deliveryOutcome` 일치, `requiredFamilies`가 실제 채택 항목에 존재, `hasDroppedUnits`와 `bundle.budget.droppedUnits > 0`의 일치.
   - expected와 passCriteria에 각각 선언한 단위 상한을 모두 적용한다. `mustAbsorbMicro:true`는 비어 있지 않은 기대 suppressed ID와 실제 억제를 요구한다.
   - 미지원 criterion은 `LIBRA_EVAL_UNSUPPORTED_CRITERION`으로 거부한다.

---

## 5. 실행 및 검증 방법 (Execution & Verification)

### 5.1 CLI 실행
```bash
/usr/local/bin/node PROGRAM/tools/evaluate_libra_unified_memory.cjs
```
- 8개 시나리오를 전수 수행하고 JSON 결과를 stdout으로 출력한다.
- 불합격 항목이 1건이라도 존재할 경우 exit code 1로 종료된다.

### 5.2 자동화 계약 테스트
```bash
/usr/local/bin/node PROGRAM/tests/libra_unified_memory_evaluation_test.cjs
```
- 스키마 검증, 8/8 합격 게이트 검증, M08 흡수 검증, 음성 대조(금지 토큰 유출 감지 및 누락 감지)를 전수 수행한다.

---

## 6. 결론 및 후속 연계 (Conclusion & Next Steps)

- **N06-a 부분 구현**: 합성 fixture 8종·runner와 8개 검사 그룹을 유지한다. 실제 corpus의 품질 정답·signal별 기여·실제 owner 반증 사례 확대는 남는다.
- **N06-b 연계**: 실제 임베딩 공급자(Gemini, OpenAI, 로컬 모델 등) 연동 시 본 벤치마크 세트를 기반으로 실제 검색 정밀도/재현율 및 레이턴시/메모리 비용을 측정한다.
- **N06-c 연계**: 실제 설치 RisuAI 호스트 환경에서 본 시나리오 기반의 E4 종단 인증을 수행한다.
