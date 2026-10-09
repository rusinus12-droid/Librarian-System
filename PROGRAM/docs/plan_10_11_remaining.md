2026-09-08 / 0.3.41: 아래 기능 공백의 현재 구현은 [잔여 기능 패치](EMBEDDING_CONTRACT_PATCH_0.3.41.md)를 기준으로 한다. 예산 opt-in·증액 복구·5종 bounded stream·HAYAKU extra1·same-space metadata 이전·유지보수 UI가 연결되었다. 아래 목록은 이전 이력이며 실서비스 및 437조건 전수 인수와 구분한다.

# 10·11차 잔여 구현·실환경 인수 계획

2026-09-08 보완: 0.3.40의 [임베딩 계약 패치](EMBEDDING_CONTRACT_PATCH_0.3.40.md)에서 아래 계획 중 성공 batch의 owner-local checkpoint/readback/재시작 재개, 물리 pending 추적, heuristic OFF 복구 검색, contextual 그룹·차원·provenance 및 reported truncation 검사를 구현했다. 아래 0.3.37 기준 내용은 당시 계획 이력이며, 실제 전체 GUI·실서비스·설계 437조건 인수는 계속 남아 있다. 출력 예산 opt-in 이전과 검증된 streaming은 이번 패치 범위가 아니다.

기준: MemorySuite 0.3.37 / LIBRA 2.3.44 / HAYAKU 3.0.53 / Flashback 1.0.34.
9차 원본과 통합 설계 v1.11로 핵심 계약은 실제 caller에 적용했다. 아래는 남은 항목이며 완료로 승격하지 않는다.

## 우선순위 1 — 설정과 출력 예산의 opt-in 이전

- `sdk/MemorySuiteExecutionContract.source.js`의 `TASK_DEFAULTS`, `invocationPlan`과 LIBRA `resolveProviderOutputBudget`, `callLLMWithPreset`, canonical operation aggregate를 함께 추적한다.
- 신규 설치에만 새 가시 여유/추론 여유/총생성 기본값을 적용하고 기존 명시 cap·OFF·모델·effort는 그대로 둔다. 사용자 이전 버튼은 이전/이후 값과 늘어나는 총 요청 상한을 보여준 뒤 저장/readback한다.
- cap 확대 복구는 최초+추가의 합계 예산, 동일 source binding, 실제 증가한 applied cap이 증명된 경우에만 여는 선택 경로로 구현한다. 기본 extra0은 유지한다.
- 종료 조건: 작은 cap/큰 cap, context 부족, 강제 추론, 기존 설정 멱등 이전, canonical/SGA/consumer 모든 경로를 실제 gateway에서 검사.

## 우선순위 2 — provider 수신과 실제 capability 검증

- 현재 direct route의 `streamingValidated`는 false다. `submitGenerationRequest`와 각 공급자 parser에 UTF-8/SSE/JSON 임의 경계, usage가 늦게 오는 경우, finish/refusal/reasoning-only/no-finish를 다루는 완전 수신기를 연결한 뒤에만 true로 바꾼다.
- 승인된 endpoint/model/key-reference/최대 비용으로 Moonshot/DeepSeek/OpenRouter/GLM/OpenAI/Anthropic/Gemini/Ollama를 개별 검증한다. 알 수 없는 alias를 공식 route로 인증하지 않는다.
- `callRisuAuxiliary`/HAYAKU `runNativeOtherAx`의 host plain string, terminal 없는 success, 논리 취소 뒤 physical pending, allowPlugins 재귀를 실제 RisuAI 버전에서 확인한다. 전 Suite 공동 락은 구현하지 않았으므로 owner 동시 실행을 그와 혼동하지 않는다.

## 우선순위 3 — HAYAKU GUI와 임베딩 유지보수 전체 연결

- `executeNativeAnalysisAttempt`의 explicit extraCalls=1을 cold-start/failed-analysis GUI의 별도 사용자 정책에 연결한다. 실제 caller가 동일 ledger를 전달하고 완전 종료한 JSON 형식 오류에만 적용하는지 시험한다. 기본1회 primary를 old2회로 되돌리지 않는다.
- Flashback `runMemoryMaintenance`/`runProgressiveReembedding`의 요청 상한·사용한 probe 수·partial/pending·현재 source binding을 기존 기억 유지보수 UI에 일관되게 표시한다. 단순 연결 시험에서 과거 작업을 시작하는 타이머는 다시 넣지 않는다.
- `embedTexts`의 partial success batch를 저장 가능한 checkpoint로 분리하되 source/group/space/auth를 검증한다. 작업 재개 시 이미 검증한 성공 batch를 다시 전송하지 않는다. 실패 후보는 정상 캐시나 정본에 먼저 쓰지 않는다.
- runtime hash overlay는 heuristic 후보 생성 경로에 연결돼 있다. heuristic OFF인 dense-only/후속 rerank 경로에서도 missing raw 후보가 사라지지 않는지 실제 recall 경로 시험을 추가한다.

## 우선순위 4 — 설계 인수 매핑과 GUI/의미 평가

설계 437개와 실행 스크립트 309개는 다른 registry다. 다음은 자동시험 PASS만으로 충족했다고 볼 수 없는 주요 임베딩 ID다.

| ID | 남은 확인 |
|---|---|
| EID-04/09/10 | base/final·권한 회전의 모든 provider/owner 조합과 공식 same-space 예외 이전. 현재는 보수적으로 분리. |
| EIN-08/10 | segment map의 durable provenance와 reported truncation을 모든 수신기에서 검증. |
| EIO-04/06/08 | 실제 host 중간 source 변경, 성공 batch durable resume, 물리 요청 pending 표시. |
| EIM-01/08/10 | 근거 있는 same-space metadata-only 이전, 원격 복원 후 전체 recall·branch/server 시나리오. |
| EIG-01/02/03/07 | 세 owner 실제 DOM의 test/rebuild/cancel/rerender/scope/save/readback 4폭 전수 검수와 export redaction 점검. |
| EIG-09 | 독립 주석 corpus로 recall@k·누락·비용·지연·언어 차이 실측. 사용자 승인 자료와 예산 필요. |

LIBRA AI 연결 카드 4폭 확인은 완료했지만 위 전체 DOM 인수와 동일하지 않다. 원문 재분석 확인과 네이티브 branch 경계를 약화해 PASS시키지 않는다.

## 최종 검증 기준

수정 후 버전/manifest/checksum을 갱신하고 모든 기존+신규 시험을 최종 소스로 다시 실행한다. 기대값을 바꾸면 변경 이유와 유지되는 보호 조건을 기록한다. 공식 빌더 후 재추출하여 모든 PROGRAM 바이트가 검증 소스와 일치하는지 확인한다. 실제 모델/host 미검증과 코드 미구현을 구분해서 남긴다.

