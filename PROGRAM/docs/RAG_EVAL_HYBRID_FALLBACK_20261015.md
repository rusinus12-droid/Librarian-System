# RAG 개선: 평가 도구 · Flashback 하이브리드/키워드 대체 · GRADIA 관련도 정렬 (2026-10-15)

목표는 "빠르면서 정확한 RAG"다. 개선 효과를 숫자로 확인할 수 있도록 평가 도구를 먼저 만들고, 그 도구로 측정하면서 바꿨다.

## 1. 평가 도구

| 파일 | 역할 |
| --- | --- |
| `tests/fixtures/rag_eval_ko_v1.json` | 30턴 한국어 RP 대화와 질문 16개(이름·숫자 6, 바꿔 말하기 5, 혼합 5). 질문마다 정답 턴과 전달돼야 할 문자열 |
| `tools/rag_eval/flashback_rag_eval.cjs` | 수정하지 않은 `Flashback_Memory.js`를 가짜 RisuAI 호스트에서 실행한다. 실제 beforeRequest/afterRequest/output 훅으로 대화를 저장하고, 질문마다 실제 회상 주입 결과를 검사한다. 적중률, 질문 유형별 적중률, 지연 p50/p95, 주입 글자 수, 임베딩 호출 수를 출력 |
| `tools/rag_eval/gradia_evidence_eval.cjs` | `GRADIA.js`의 실제 정렬·포장 함수를 추출해, 같은 평가셋으로 만든 세 소유자 코퍼스에서 이전 최신순 방식과 비교. 근거 4,096개 포장 시간도 측정 |
| `tools/rag_eval/synthetic_embedder.cjs` | 오프라인 합성 임베더. 동의어는 같은 개념으로 묶고, 이름·숫자는 약한 글자 3-gram 신호만 준다. **실제 모델 품질 주장이 아니다.** |

```bash
# 오프라인(합성 임베더)
node tools/rag_eval/flashback_rag_eval.cjs
node tools/rag_eval/gradia_evidence_eval.cjs

# 실제 임베딩 모델(OpenAI 호환 엔드포인트)
RAG_EVAL_EMBED_URL=https://api.openai.com/v1 RAG_EVAL_EMBED_KEY=sk-... \
RAG_EVAL_EMBED_MODEL=text-embedding-3-small node tools/rag_eval/flashback_rag_eval.cjs --json report.json

# 장애 상황: 질문 단계에서 제공자 503(error) 또는 10초 지연(slow)
RAG_EVAL_QUERY_FAILURE=error node tools/rag_eval/flashback_rag_eval.cjs
# 설정 비교: --arg lexical_weight=0.15
```

자신의 대화로 평가하려면 같은 형식의 JSON을 만들어 첫 인자로 넘긴다. 가장 최근 턴은 프롬프트에 이미 보이므로 회상 정답으로 쓰지 않는다.

## 2. Flashback

### 하이브리드 순위
실제 임베딩을 쓰는 기본 모드에서 BM25·정확 일치 후보는 벡터가 없는 기록에만 만들어졌고, 최종 점수도 코사인만 썼다. 이름·숫자처럼 일반 임베딩이 흐리게 표현하는 단서를 놓쳤다.

- 키워드 후보(BM25, 정확 일치, 장면 문맥 BM25)를 벡터가 있는 기록에도 만든다. 후보 선택은 dense와 키워드의 순위 융합(RRF) 순서다.
- 최종 점수 = 의미 유사도 + `lexical_weight`(기본 0.08) × 키워드 신호. 키워드 신호는 정확 일치 1, BM25 순위 r(≤8)은 1/√r이다. 기존 `lexical_weight` 설정이 의미 모드에서도 적용된다.
- 근거 검사: 의미 유사도가 최소 점수 이상이거나, 키워드 신호가 0.5 이상(정확 일치 또는 BM25 상위 4위)이면 통과한다.
- 질의 임베딩 호출 수는 그대로 요청당 1회다. 해시 복구 후보는 계속 사용하지 않는다.

### 임베딩 장애 시 키워드 대체
이전에는 질의 임베딩이 실패하면 기억을 하나도 넣지 않았다. 느린 제공자는 훅 제한시간(20초)까지 기다린 뒤 검색을 건너뛰었다.

- 질의 임베딩에 별도 시간 예산을 둔다: 훅 제한시간의 25%, 1.5~4초(기본 4초).
- 실패하거나 예산을 넘기면 그 요청은 BM25·정확 일치로 기억을 찾는다. 기록 승인 검사(프로필, 준비된 임베딩 영수증, 원문 결속)는 그대로 적용한다. 대기 중·원문 변경 기록은 들어가지 않는다.
- 한 번 실패하면 60초 동안 질의 임베딩을 건너뛰고 바로 키워드 검색을 쓴다. 임베딩이 성공하거나 임베딩 설정이 바뀌면 해제된다.
- 진단은 `modelReadiness.status = 'lexical_fallback'`, `reason = query_failed | query_timeout | query_cooldown`, `ready = false`다. 의미 검색 성공으로 표시하지 않는다. 기억 현상실에 "키워드 검색으로 대체" 안내가 나온다.
- 저장소 쓰기, 재임베딩, 해시 벡터 생성은 하지 않는다. `heuristicRecall=false`이면 이전처럼 `query_failed`로 기억 없이 진행한다.

### 시도했다가 넣지 않은 것
현재 입력만의 벡터를 같은 호출에 함께 넣어 `max(문맥 질의, 현재 입력)`을 쓰는 방식은 이 평가셋에서 차이가 없어 넣지 않았다. 1.0.49에서 고정 혼합을 일부러 뺀 이력도 있다. 실제 모델로 측정할 후보로 남긴다.

## 3. GRADIA 다중 소유자 근거

- 이전: HAYAKU·Flashback(과 LIBRA) 근거를 관련도 없이 최신순 라운드로빈으로 예산을 채웠다. 대화가 길면 오래된 관련 기억이 밀려났다.
- 현재(`orderLibEvidenceCandidates`): 소유자마다 최신 2개를 먼저 넣어 장면 연속성을 지킨다. 나머지는 현재 입력에 대한 BM25 점수 순이다(한글·한자·가나는 2글자 단위, 그 밖의 단어는 통째로). 겹치는 단어가 없는 항목은 이전처럼 최신순 라운드로빈이다. 모델 호출은 없다.
- 포장(`createLibEvidencePacker`): 이전에는 후보를 하나 넣을 때마다 근거 전체를 다시 렌더링했다(O(n²)). 지금은 항목마다 한 번만 직렬화·측정한다. 이스케이프가 글자 단위라 크기가 더해지는 구조이며, 마지막에 실제 렌더러로 한 번 검증한다. 무작위 300회 비교에서 결정이 완전히 같다.

## 4. 측정 결과 (합성 임베더, 오프라인)

| 대상 | 변경 전 | 변경 후 |
| --- | --- | --- |
| Flashback 정상 | 81.3% (이름 질문 3개 실패) | 93.8% (이름·숫자 100%, 바꿔 말하기 100%) |
| Flashback 제공자 장애(503) | 0% · 기억 없음 | 68.8% · p50 60ms(첫 요청만 약 2.3초) |
| Flashback 제공자 10초 지연 | 0% · 최대 20초 대기 후 생략 | 68.8% · 첫 요청만 약 4초 |
| GRADIA 정답 근거 포함률(예산 = 코퍼스의 1/4) | 68.8% | 93.8% |
| GRADIA 근거 4,096개 포장 | 6,463ms | 19ms (결정 동일) |

`lexical_weight=0`이면 81.3%(변경 전과 같음), `0.15`이면 100%다. 합성 임베더에 대한 과적합을 피하려고 기본값 0.08은 바꾸지 않았다. 실제 모델로 측정한 뒤 조정을 권장한다. 남은 실패 m01("유나가 준 선물")은 "선물"과 "목걸이를 건넸다"를 합성 임베더가 연결하지 못해서 생긴다.

## 5. 바뀐 테스트 계약

의도적으로 바꾼 동작에 맞춰 다음 단언을 갱신했다.

- "의미 모드에서 sparse/exact 후보 0개" → 해시 복구 후보는 0개, 키워드 후보는 허용·요구
- "질의 실패 시 기억 없음(`query_failed`)" → `lexical_fallback`, 승인된 기록만, 쓰기 없음, GUI 안내

대상: `flashback_feature_parity_test`, `recall_keyword_features_runtime_test`, `helpers/unload_recall_contract_fixture`, `flashback_model_only_retrieval_runtime_test`, `flashback_bounded_diagnostics_artifact_test`, `flashback_context_recall_runtime_test`, `flashback_episode_index_rebuild_injection_negative_test`.

새 테스트: `tests/gradia_evidence_relevance_order_test.cjs`, `tests/rag_eval_flashback_floor_test.cjs`(정상 ≥ 0.9, 장애 ≥ 0.6, 장애 p50 < 1초).

## 6. 확인 범위와 한계

- Flashback 관련 테스트 202개와 GRADIA 관련 테스트 56개를 변경 전 코드와 나란히 실행했다. 남은 실패는 모두 변경 전에도 같은 개수로 실패한다.
- `gradia_three_owner_*` 테스트는 변경 전에도 `LIB_READ_UNIFIED_UNAVAILABLE`로 실패한다. GRADIA 다중 소유자 경로는 추출한 실제 함수 테스트와 평가 도구로만 확인했다.
- 모든 수치는 합성 임베더 기준이다. 실제 제공자와 실제 RisuAI 설치에서는 측정하지 않았다.
