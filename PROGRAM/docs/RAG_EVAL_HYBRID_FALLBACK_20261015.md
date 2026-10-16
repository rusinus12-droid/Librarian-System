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

## 7. 후속: LIBRA 섹션 벡터 · 한국어 n-gram (측정 후 미적용)

`tools/rag_eval/libra_kernel_eval.cjs`는 실제 LIBRA 질의 커널·컴파일러·롤아웃(`tools/evaluate_libra_unified_memory.cjs`)으로 같은 평가셋을 돌린다. 30턴을 5턴 정본 6개로 묶고 상위 N개 정본에 정답 정본이 들어가는지 본다.

| 모드 (상위 1 / 2 / 3) | 적중률 |
| --- | --- |
| 키워드만 | 50.0% / 56.3% / 62.5% |
| 정본 벡터 1개(현재) | 68.8% / 87.5% / 87.5% |
| + 섹션 벡터 최댓값 | 62.5% / 81.3% / 87.5% |
| + 정본·최고 섹션 평균 | 68.8% / 75.0% / 87.5% |
| 키워드 + 한글 2-gram (키워드만) | 50.0% / 62.5% / 75.0% |
| 벡터 + 한글 2-gram | 62.5% / 87.5% / 87.5% |

- 섹션 벡터를 최댓값으로 쓰면 모든 정본의 점수가 함께 올라가 변별력이 떨어졌다. 평균도 개선이 없었다. 커널과 지속 벡터 페이지 형식은 바꾸지 않았다.
- 한글 2-gram은 키워드 단독일 때만 좋아졌고 실제 운영 방식(벡터 + 키워드)에서는 개선이 없거나 나빠졌다. 토크나이저 버전을 올리면 저장 색인을 다시 만들 때까지 요청별 코퍼스로 검색해 느려지므로 적용하지 않았다.
- 합성 임베더 기준이다. LIBRA의 실제 섹션은 턴 단위가 아니라 요약·사건·인물 같은 측면 단위라 결과가 다를 수 있다. 실제 모델로 다시 잴 수 있도록 평가 도구를 남겼다.

## 8. 후속: HAYAKU 다국어 교차 검색

`tools/rag_eval/hayaku_recall_eval.cjs`는 HAYAKU의 실제 `localRecallRank`(단어 + 2글자 BM25)를 추출해 기억 언어와 질문 언어 조합별로 상위 5개 적중률을 잰다. 영어 기억은 HAYAKU 지시대로 이름을 한글 원래 표기로 유지한다(`translations.en`).

| 기억 / 질문 | 적중률 | 바꿔 말하기 | 결과 0개 질문 |
| --- | --- | --- | --- |
| ko / ko | 75.0% | 60% | 2 |
| en / en | 93.8% | 80% | 0 |
| en / ko | 50.0% | 0% | 8 |
| ko / en | 43.8% | 0% | 9 |
| en + ko 별칭 / ko | 75.0% | 60% | 2 |
| ko + en 별칭 / en | 87.5% | 80% | 0 |
| ko + en 별칭 / ko | 75.0% | 60% | 2 |

- 원인: 기억과 질문의 언어가 다르면 이름 외에는 단어가 겹치지 않는다.
- 이미 있는 장치: `meta.summary_memory.recallAliases`(ko/en/ja/zh 같은 뜻 바꿔 쓰기)는 승인 검증을 거쳐 검색 전용 텍스트로 쓰인다. 그러나 지시문이 "필요할 때 추가(may / when useful)"라 대부분 비어 있을 수 있었다.
- 변경: 일반 턴 패킷 지시에 "always add en and the user's language if different."를, 복구 패킷 지시에 en과 최근 사용자 입력 언어를 항상 넣으라는 문장을 추가했다. 추가 호출·지연·설정은 없다. 출력 토큰이 턴마다 짧은 바꿔 쓰기 1~2개만큼 늘어난다. 새로 쓰는 패킷부터 적용된다.
- 압축형 패킷 지시는 소형 모델용 상한(6,000자)이 있어 문구를 52자로 줄였다(5,934 → 5,986자). 전체 지시는 6,861 → 6,913자다.
- 별칭이 있을 때의 수치는 별칭이 채워졌다고 가정한 것이다. 실제 응답 모델이 지시를 얼마나 따르는지는 측정하지 않았다.
- 남은 한계: 질문에 이름을 로마자로 쓰면("Yuna") 한글 이름과 맞지 않는다. 인물 기록의 aliases에 로마자 표기가 있을 때만 맞는다. 사건·세계 기록 자체에는 별칭이 없고, 같은 턴 요약을 통해 연결 확장으로 닿는다.

회귀 테스트: `tests/rag_eval_hayaku_cross_lingual_test.cjs`(별칭이 교차 언어 적중률을 올리고 같은 언어를 해치지 않으며, 두 지시문에 요구가 남아 있는지 확인).
