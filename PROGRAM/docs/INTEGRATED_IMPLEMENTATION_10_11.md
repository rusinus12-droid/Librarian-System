# MemorySuite 0.3.37 — 통합 설계 10·11차 개발 적용 보고

작성일: 2026-09-08 (한국시간)  
기준: 첨부 `MEMORY_SUITE_INTEGRATED_DESIGN_v1_11_20260907(1).zip` 및 `MemorySuite_0.3.35_INTEGRATED_IMPLEMENTATION_09(2).zip`  
상태: **핵심 코드 적용 / 설계 전체 인수는 부분 완료 / 실제 RisuAI·실제 공급자 검증 NOT_RUN**

## 1. 배포 범위

10차와 11차를 9차 원본에 누적 적용한 단일 개발 합본이다. 별도의 10차 완료본을 입수하거나 병합했다고 주장하지 않는다. 0.3.36 독립 배포본은 만들지 않았다.

| 구성 | 입력 | 이번 합본 |
|---|---:|---:|
| 패키지·서버 표시 버전 | 0.3.35 | 0.3.37 |
| LIBRA | 2.3.42 | 2.3.44 |
| HAYAKU | 3.0.51 | 3.0.53 |
| Flashback | 1.0.32 | 1.0.34 |
| LIA | 0.26.63 | 변경 없음 |
| RE:TRACE | 1.9.67 | 변경 없음 |

LIA·RE:TRACE는 입력본과 바이트 단위로 보존한다. Storage SDK 1.8.15, Compute SDK 0.3.4, 저장 키와 기존 데이터 스키마의 권한 경계를 바꾸지 않는다. 서버 기능 변경은 없으며 버전 표시만 갱신한다.

## 2. 10차 — 공통 생성 계약·OtherAx

`PROGRAM/sdk/MemorySuiteExecutionContract.source.js`를 기준으로 LIBRA·Flashback·HAYAKU에 동일한 순수 계약 코드를 포함했다. 동기화 검사는 `node tools/sync_execution_contract.cjs --check`다. 동일 코드 사용은 Suite 전체 공동 큐나 공동 락을 뜻하지 않는다. 설정·자격 증명·저장소·물리 큐는 owner별로 유지한다.

LIBRA의 실제 `callLLMWithPreset`/공급자 전송 경계에 작업 종류, InvocationPlan, 최종 payload 검증, 물리 요청 예약, CompletionEnvelope를 연결했다. 사용자 extra body를 합친 뒤 상한 초과와 서로 충돌하는 토큰 필드를 검사한다. 기존 명시 cap을 몰래 키우지 않는다. 등록하지 않은 작업을 정본 생성으로 자동 분류하지 않는다.

전송 실패, 결과 불명, 잘림, reasoning-only, 근거·의미 오류는 자동 추가 생성으로 복구하지 않는다. 명시 추가 호출은 기본 0이며 최대 1이다. 실제 완료가 확인된 순수 JSON 형식 오류만 그 슬롯을 사용할 수 있다. 중첩 transient 재시도, 실패 후 추론 OFF 재호출, 실패 후 non-stream 재호출 경로를 제거했다. 정상 GRADIA 단계 호출을 오류 재시도로 합치지는 않는다.

검증된 스트리밍 수신 경로가 없으므로 direct 생성은 **전송 전에 non-stream을 선택**한다. 불완전 SSE 결과를 성공으로 채택하지 않는다. 이 조치는 스트리밍 구현 완료가 아니다. Kimi/DeepSeek 등의 모델별 필드·effort 가드는 URL 전체의 부분 문자열이 아닌 정확한 hostname에 결속한다. 공급자별 동작 검증은 공통 코드/합성 계약 시험 수준이며 해당 모델을 실제 호출해 기능 집행을 인증한 것은 아니다.

LIBRA와 HAYAKU의 OtherAx는 호스트 `runLLMModel`을 사용하며 `staticModel`로 설정을 덮어쓰지 않는다. 요청 예산과 호스트 관리 적용값을 구분하고 미보고 usage는 null로 남긴다. 논리 취소 후에도 실제 호출이 종료될 때까지 owner 내부 큐를 유지하며 늦은 결과는 채택하지 않는다. HAYAKU의 정상 packet capture에 새 LLM 호출은 추가하지 않았다. 실패 기록 보존·정확한 실패 구간 복구·사용자 선택 채택 경로를 유지했다.

LIBRA 빠른 설정 → AI 연결에 요청/적용 예산, 호스트 관리, 실제 호출 수와 종료 상태를 보여주는 카드를 추가했다. 모든 owner의 모든 작업창이 같은 수준으로 개편된 것은 아니다.

## 3. 11차 — 임베딩 정합성·호출·보관

### 차원·응답 검증

LIBRA의 `auto → 1` 반복 정규화 결함을 고쳤다. 명시 1차원 벡터를 불량이라고 가정해 일괄 삭제하지 않는다. LIBRA/Flashback 모두 명시 차원, 실제 응답 차원, cache+fresh 합본, 분할/문맥 그룹 합본, query/document 시험 쌍을 검사한다.

중복·누락·음수·범위 밖 응답 인덱스, 숫자 문자열/null/boolean/non-finite 좌표, 0 벡터, Float32 변환 후 overflow/underflow를 반려한다. 유효한 응답 shuffle은 원래 순서로 복원한다. 새 DashScope 시험은 실제 adapter의 `text_index` 경로까지 검사한다. 실패한 벡터 때문에 정상 원문·정본을 삭제하지 않는다.

### 식별·캐시·긴 입력

실제 resolved endpoint, 의미 있는 query/template/model revision, 목적(query/document), scope/source, 권한 epoch, 설정 generation, 문맥 group을 cache/descriptor에 반영했다. 키 회전과 임베딩 공간 변경을 분리한다. Flashback의 base URL과 최종 URL은 실제 순수 request builder가 만드는 endpoint로 식별한다. 로그용 route는 비밀 query를 제거한다.

설정 변경 중 도착한 이전 응답, cache와 fresh의 차원 충돌, coalesced 결과의 차원 충돌은 캐시 기록 전에 차단한다. 긴 입력은 원문을 먼저 나눈 뒤 조각마다 역할 prefix를 붙인다. 기존 조용한 20,000자 절단을 제거하고 tail을 보존한다. 입력·요청의 토큰 추정/바이트/개수 한도를 분리한다. 정규화 OFF인 분할 pooling은 강제로 단위 벡터가 되지 않도록 했다. 추정 토큰은 실제 과금값이 아니다.

### 작업 원장·시험과 유지보수 분리

metadata 조회, split, retry, query/document probe도 물리 요청 원장을 공유한다. HTTP 종료가 확인된 429/5xx만 기존 embedding 재시도 설정과 총예산 안에서 재시도한다. 임베딩 재시도와 LLM extraCalls는 별개다.

Flashback 연결 시험 성공 후 250ms 타이머로 과거 corpus 갱신을 시작하던 경로를 제거했다. 시험은 캐시를 우회하는 probe이며 과거 기억 갱신 승인이 아니다. 유지보수는 범위·원문·설정의 확인 상태에 결속한다. 확인 이후 또는 commit 전 원문/채팅이 바뀌면 결과 적용을 중단한다. archive/local write lock 안에서도 해당 확인을 수행한다.

새 캡처의 기존 hash-first 저장과 설정에 따른 remote 승격은 보존한다. 과거 전체 갱신 권한으로 확대하지 않는다. 인증/인덱스/수치/차원 오류를 성공한 해시 결과로 숨기지 않는다.

### 보관·유실 복구

LIBRA portable vector와 Flashback sidecar/immutable archive 포맷을 유지한다. 구형 출처 불명 remote 벡터는 보존하되 새 공간으로 인증하지 않는다. sidecar가 없으면 원문과 vectorRef는 남기고 missing을 표시한다.

Flashback의 임시 hash 검색은 최대 128개 cache entry, 262,144자 작업 범위, 항목당 65,536자 제한을 갖는 runtime overlay다. 원격 벡터와 다른 공간의 cosine을 섞지 않고 별도 후보 순위를 RRF에 합친다. 호환되는 원격 벡터가 복원되면 같은 owner의 임시 overlay를 정리한다. 이 경로는 heuristic 후보 생성에 연결돼 있으며, heuristic을 끈 전체 경로의 동등한 복구 성능은 인증하지 않았다.

## 4. 검증과 해석

| 검증 | 결과와 범위 |
|---|---|
| 기존+신규 전체 CJS 회귀 | **309/309 PASS**, 최종 플러그인 해시 고정. 외부 네트워크 모델 호출 없음. |
| 공통 계약 추가 시험 | 70개 검사 PASS. 순수 계약 검증이며 실제 모델 인증 아님. |
| 실제 LIBRA generation gateway 추가 시험 | 12개 검사 PASS. 실제 caller에 제어된 direct/OtherAx 응답 주입. |
| 실제 Flashback adapter/owner/overlay 추가 시험 | 9개 검사 PASS. 순수 core에만 국한되지 않음. |
| 수정 전후 관측 16개 | 수정 후 16/16 PASS. 14개 수정 기대값과 2개 보존 불변조건. |
| 실제 LIBRA DOM / offline host | 390/768/1024/1440px: 카드 표시, 바깥 가로 overflow 0, pageerror 0. |
| 실제 RisuAI/OtherAx 설치·실모델 의미 평가 | **NOT_RUN**, 외부 모델 호출 0회. |

전체 기준 306개에 새 스크립트 3개를 더해 총309개다. 이전 병렬 실행에서는 compute server 시험 한 개가 job-not-ready(425)를 받아 실패했다. 동일 코드의 분리 실행은 PASS였고, 최종 전체 실행은 compute 시험을 순차 실행한 뒤 나머지를 병렬 검사했다. assertion과 제품 로직을 완화하거나 자동 재시도해 통과시킨 것이 아니다. 입력 원본 전체의 초기 별도 PROGRAM 복사에서는 설치 루트 의존 4개가 실패했으나, 원래 ZIP 루트 구조를 유지해 재실행한 4개는 모두 통과했다. 이를 제품 결함 4개를 고친 것으로 집계하지 않는다.

기준 설계의 16개 관측은 원본에서 재현한 후, 수정 후 기대값을 별도 시험으로 바꿨다. 원본 결함이 그대로 발생하는 시험을 통과시킨 것을 수정 성공으로 세지 않았다. EA-11은 공간 혼합 금지의 보존 시험이며 EA-12는 durable hydrate의 missing 보존을 확인한다. 새 runtime overlay의 실제 생성·해제는 별도 Flashback 실행 시험으로 확인한다.

전체 스크립트 개수와 설계 인수 조건 437개(기존 377+임베딩 60)는 다른 수치다. 전체 CJS 통과가 437개 설계 계약의 완료나 모델 의미 품질을 뜻하지 않는다.

기존 시험 중 자동 두 번째 호출을 전제로 한 expectation은 새 정책에 맞춰 변경했다. HAYAKU cold-start/실패 vault는 기본 1회와 실패 자료 보존을 검사한다. 완전 종료한 형식 오류의 명시 추가 1회 시험은 terminal 증거를 가진 fixture로 유지한다. reasoning-only/unknown-result 시험은 추가 0회를 요구한다. raw/source 보존·명시 채택·owner 구분 검사를 제거해 통과시킨 것이 아니다. 버전 일치 검사도 새 실제 버전으로 갱신했다.

브라우저 시험은 실제 LIBRA JS가 생성한 DOM을 offline host fixture에서 열었다. 390/768/1024/1440px에서 새 AI 연결 카드가 보이고 외부 가로 overflow가 없으며 pageerror가 없음을 확인한다. 실제 RisuAI 설치 시험이나 Flashback/HAYAKU의 전체 상호작용 시험과 동일하지 않다.

외부 모델 호출은 0회다. endpoint·키·비용 예산과 독립 평가 자료의 승인이 없으므로 실모델 호출을 임의로 수행하지 않았다. recall@k, 실제 과금·지연, provider별 강제 추론 동작, 호스트에서의 동시 owner 실행은 NOT_RUN이다.

## 5. 아직 끝나지 않은 항목

| 항목 | 상태와 후속 경계 |
|---|---|
| 새 B/R/T 기본값의 신규 설치·명시 opt-in 이전 | 기본 정책 표와 실제 cap 가드는 존재하지만 전체 설정 이전 UI/적용은 미구현. 기존 cap 보존. |
| 스트리밍 end-to-end 수신 | 미구현. 검증되지 않은 direct stream은 전송 전에 non-stream으로 고정. |
| 잘림 뒤 조건 개선 재생성 | 미개방. 실제 cap 증가·총예산·동일 source를 증명한 선택 경로를 추가해야 함. |
| HAYAKU 명시 형식 복구 최대1 GUI | core 실행 옵션은 있지만 모든 cold-start/복구 GUI 경유 연결은 미구현. 기본 자동 추가0 유지. |
| 중단된 임베딩 작업의 durable batch resume | 개별 call 내부 bounded retry 외에 성공 batch checkpoint를 재시작 간 재사용하는 새 경로는 미구현. |
| 임베딩/유지보수 전체 GUI 계약 | 기존 기능 분리와 일부 진단 적용. 모든 요청/실제값·pending·범위 전환·저장 readback의 4폭 검증은 미완료. |
| 독립 의미 평가·실제 호스트 | NOT_RUN. 합성 벡터/응답 결과로 대체하지 않음. |

구체적 함수와 종료 조건은 `plan_10_11_remaining.md`에 기록했다. 이 합본을 10차·11차 전체 설계가 100% 완료된 안정 인증본으로 표시하지 않는다.

## 6. 설치·보존

기존 서버를 종료하고 DATA와 플러그인 설정을 백업한다. 기존 **DATA는 그대로 두고 PROGRAM만 교체**한다. RisuAI에는 `PROGRAM/plugins`의 LIBRA/HAYAKU/Flashback JS를 기존 플러그인에 덮어 설치한다. LIA/RE:TRACE는 코드가 같으므로 재설치가 필수는 아니다. 새 ZIP의 빈 DATA 틀을 기존 DATA 위에 덮어쓰지 않는다.

모델/endpoint를 바꿨다고 과거 기억을 자동으로 전부 다시 만들지 않는다. 새 descriptor로 호환성을 입증하지 못한 벡터는 dense 사용이 제한될 수 있으므로, 필요한 범위만 별도 승인하여 재임베딩한다. 원문이나 정본 자체의 재생성으로 대체하지 않는다.

## 7. 재현

```sh
cd PROGRAM
node tools/sync_execution_contract.cjs --check
node tests/execution_embedding_contract_v1_test.cjs
node tests/generation_gateway_v1_test.cjs
node tests/flashback_embedding_execution_v1_test.cjs
python run_regression_batch.py
node tools/update_manifest.cjs
node tools/update_checksums.cjs
node tools/build_distribution.cjs --output-dir /absolute/empty/release-directory
```

전체 시험의 각 실행 로그, 수정 전후 16개 관측, 최종 JS 해시, 빌더 보고 및 재추출 대조 결과는 별도의 검증 ZIP에 보관한다. 제품 ZIP에는 사용자 기억·사용자 키·폰트 파일·개별 실행 로그를 넣지 않는다.
