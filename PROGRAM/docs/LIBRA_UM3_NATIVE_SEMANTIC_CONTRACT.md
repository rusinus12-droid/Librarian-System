# LIBRA UM3 — native 임베딩 연결 계약

- 작성일: 2026-10-14 · 버전: 1.0
- 기준: `bad8cdf` 이후 native semantic bridge 구현
- 구현: `tools/libra_memory_graph_semantic.cjs`, `tools/libra_memory_graph_query.cjs`, `tools/libra_memory_graph_rollout.cjs`, `plugins/LIBRA.js`
- 관련: [통합 엔진 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [현황 §13](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md#13-native-임베딩-연결)
- 판정: **실제 제공자 어댑터·저장 벡터·질의 캐시를 등록 unified query와 Classic beforeRequest에 연결했다. 저장소/HTTP 호스트는 회귀 fixture이며 외부 모델의 검색 품질이나 실제 RisuAI 설치 qualification을 완료한 것은 아니다.**

## 1. 실행 경로와 표현 범위

owner reader가 정본·Micro·State·허용 lore를 같은 그래프로 읽는다. native semantic bridge는 현재 정본 기록의 기존 `libra.embedding_projection.v2` global 벡터를 검증해 **그 정본의 SourceNode**에 결속한다. 저장된 벡터가 임베딩한 것은 `buildMemoryRetrievalProjection()`의 summary·section·recall-key projection이다. 각 fact의 독립 벡터로 복사하거나 동일 근거 수를 늘리지 않는다.

저장 벡터와 호환되는 질의 벡터는 기존 `EmbeddingProviderRegistry`의 실제 제공자 어댑터와 query cache로 얻는다. SourceNode를 동일 `scoreCandidate`로 평가해 **기존의 한 frontier**에 offer하고, `evidenced_by`의 역방향·대상·파생 관계를 따라 canonical fact·State·Micro·lore로 확장한다. 별도 dense 순위·RRF나 legacy scorer를 실행하지 않는다. 최종 출력은 원래 의미 노드이며 projection/source 자체를 새 사실로 출력하지 않는다.

초기 native 벡터 범위는 **정본 global projection**이다. section 벡터의 세부 접근, Micro·State·lore의 새 벡터 생산과 durable semantic vector pages는 이후 작업이다. 벡터 없는 자료는 동일 그래프의 typed·lexical·entity 접근과 연결 확장으로 계속 참여한다.

## 2. admission과 공간 호환성

| 검사 | 계약 |
| --- | --- |
| 소유자/참조 | 현재 owner가 읽은 canonical record와 vector의 scopeKey·memoryId·revision 일치. record의 ready vectorKey만 읽고 graph SourceNode가 해당 recordKey에 유일하게 연결되어야 함 |
| projection | 현재 원본에서 projection을 다시 도출. projectionVersion, global textHash, embedding metadata textHash/vectorHash와 저장 벡터 metadata 일치 |
| payload | 유한한 숫자·차원 일치·nonzero 벡터. portable Float32 payload는 **캡처한 실제 저장 본문에서** 해독하고 payload digest 검사. 다른 본문을 로컬 캐시에서 대체하지 않음. legacy local-only payload는 이번 경로에서 새로 복원하지 않음 |
| space | 저장 profileId·provider·model·embeddingDescriptor를 현재 설정과 실제 해석한 dimensions의 `profileFor()`에 대조. 질의 응답도 같은 profile/provider/model/dimension이어야 함 |
| task pair | queryTask와 documentTask는 제공자가 정의한 호환 pair로 결속. 문자열이 같은 것을 요구하지 않음. Cohere search_query/search_document·auto dimensions를 등록 API fixture에서 검사 |
| 시간 | global projection은 여러 턴을 포함. 과거 조회에서 turnRange.end가 조회 턴보다 늦거나 불명확하면 그 벡터를 사용하지 않음. 과거 fact의 typed/lexical 접근은 유지. kernel에서도 source representation의 temporalEndTurn을 검사 |
| 비용 | `maxRepresentationBytes` 안에서 채택한 numeric representation workspace를 추정 계상. 저장 JSON·decode transient·SDK buffers·전체 VM heap의 상한은 주장하지 않음 |

없는 벡터·공간 불일치·손상·예산 탈락은 `diagnostics.nativeSemantic.rejected`에 사유를 기록한다. 소스 원문이나 정본/State를 수정해 해결하지 않는다. 질의 중 document embedding·원문 재분석·역사 자동 재임베딩은 0이다.

## 3. 질의 호출·캐시·예산

등록 `executeMemoryGraphUnifiedQuery()`와 명시적 unified의 일반 recall이 native bridge를 사용한다. 저장된 제공자 설정을 직접 읽고, 호환 representation이 없거나 embedding disabled면 질의 제공자도 호출하지 않는다. 이 read 경로는 `loadEmbeddingSettings()`의 자동 migration 예약을 이용하지 않는다.

기존 query cache는 provider descriptor·endpoint/실행 형식·질의 텍스트·auth epoch·cache epoch를 포함한다. native bridge는 owner·scope·세계선·restore epoch·viewer/view를 추가 scope identity로 전달한다. 같은 범위의 동시 질의는 transport를 coalesce하고, warm hit·새 key/settings generation·restart를 회귀 검사한다. 문서 벡터와 질의 캐시는 서로 다른 역할이다.

```js
await api.executeMemoryGraphUnifiedQuery({
  expectedScopeKey,
  queryInput: { queryText, asOfTurn: null },
  semanticPolicy: {
    mode: 'native',                 // native | disabled; 기본 native
    maxRepresentationBytes: 262144, // 4096..16777216
    queryBudgetMs: 3500             // 250..3500; 원래 요청 deadline 안에서만
  }
});
```

실제 제공자 작업은 request-local execution ledger로 최대 16 wire submissions를 제한한다. 실패/재시도·캐시·coalescing 비용을 lifetime counter 차분으로 계산하지 않는다. `additionalEmbeddingCalls`와 `nativeSemantic.queryRequestCount`는 해당 요청 ledger의 embedding submissions다. LLM helper 수와 구분한다. queryBudgetMs는 adapter timeout보다 짧을 수 있으며 child cancellation과 Promise deadline을 함께 적용한다. 물리적 종료가 불명확한 호출을 실제 취소 성공으로 표현하지 않는다.

query embedding 실패·timeout이면 동일 unified kernel을 vector 없이 실행한다. **최종 owner/source 검증도 통과해야 전달한다.** 기다리는 동안 manifest·원본·설정이 바뀌었으면 base_request_only/원래 요청 보존이 맞는 결과다. 다른 엔진으로 강등하거나 실패한 semantic 검색을 성공했다고 보고하지 않는다.

호환 vector가 representation byte budget 때문에 제외되면 조회는 partial이다. `semanticCoverageComplete:false`, `queryComplete:false`, `bundle.queryComplete:false`, `stopReason:'semantic_representation_byte_budget'`를 기록하고 채택된 근거만 전달한다. 없는 embedding feature와 예산으로 미접근한 representation을 구분한다.

shadow API는 **warm query-cache lookup만** 허용한다. cold miss에서 제공자를 호출하지 않는다. 일반 legacy-base shadow 비교의 추가 LLM/embedding 호출을 새로 활성화하지 않는다.

호환성을 위해 기존 public queryInput에 semanticSpace/queryEmbedding/documentRepresentations/queryVectors를 명시하면 caller supplied 경로가 남는다. `nativeSemantic.status:'caller_supplied'`, `authority:'unverified_relevance_signals'`로 구분하며 native adapter가 검증한 벡터로 표시하지 않는다. 이 입력은 최종 원본 권한을 부여하지 않는다. 순수 kernel의 injected-vector 검사와 native 제공자 검사를 구분한다.

## 4. 최종 currentness와 dispatch

- source readset을 query provider 대기 **이전**에 캡처한다. server_only의 vector readset도 읽기 시점에 별도로 캡처해 대기 중 revision/ABA를 감지한다.
- 선택한 native representation의 저장 본문을 다시 읽고, portable decode가 사용한 캡처 본문과 정확히 일치하는지 확인한다. mirror의 body/namespace 원자성을 새로 주장하지 않는다.
- 최종 owner verifier는 source pin·사용한 vector body·설정/credential binding·scope/worldline/restore·취소/폐기 경계를 재검증한다. query 제공자 호출이 끝난 것만으로 전달 권한을 주지 않는다.
- Classic beforeRequest는 발급한 private packet을 **주입 직전** 다시 검증한다. 변경된 vector·원본·설정, JSON clone, 폐기된 handle은 전달을 거부하고 원래 요청을 보존한다.

이번 profile의 등록 graph reader는 plugin_only와 server_only를 지원한다. mirror는 기존 readonly source owner 계약의 `READ_ROUTE_MODE_UNAVAILABLE` 제한을 유지하며 embedding 제출 이전에 거부된다. 이를 성공 profile로 표시하지 않는다. 두 지원 모드의 실제 설치 환경 원자성/크기 한계는 기존 reader·durable 문서와 같다.

## 5. 검증과 다음 경계

PROGRAM에서 Node 24로 실행한다.

```bash
node tests/libra_memory_graph_semantic_test.cjs
node tests/libra_memory_graph_semantic_runtime_test.cjs
node --test tests/libra_memory_graph_*test.cjs tests/libra_memory_engine_mode_test.cjs
node --test tests/libra_unified_recall_vector_v1_test.cjs tests/libra_unified_server_vector_v1_test.cjs tests/execution_embedding_contract_v1_test.cjs
node --check plugins/LIBRA.js
node tools/sync_libra_memory_graph.cjs --check
```

순수 검사는 서로 직교하는 두 문서 벡터의 검색 차이·source witness·잘못된 owner/profile/text/payload·시간·byte budget을 검사한다. 등록 fixture는 native writer가 만든 저장 벡터를 읽고 실제 OpenAI/Cohere 어댑터를 통과하는 controlled HTTP 응답으로 source activation·네 자료 참여·Classic injection·warm/restart·coalescing·auth/prefix 변경·벡터 손상/최종 변경·provider 실패/timeout을 검사한다. 고정 숫자 벡터로 wiring을 증명하며 실제 언어 의미의 검색 품질을 증명하지 않는다.

남은 작업은 전체 corpus durable index/shard/vector page 접근, representation 생산의 자료별 계약, 실제 provider 평가·calibration·규모/latency/peak memory, 다른 소비자 삽입, native GC와 실제 설치 호스트 qualification이다. 기본 모드는 legacy를 유지한다.
