# GRADIA 외부 기억의 모델 문맥·전송 예산

작성/갱신: 2026-10-15. 대상: GRADIA Shadow/Aide 및 인풋 작성기의 연결된 외부 기억 읽기.

## 읽기와 검색의 역할

GRADIA는 기억의 읽기 소비자다. 현재 `unified_engine` 연결에서 LIBRA에 보내는 query는 통합 검색 엔진의 읽기 API 호출이다. LIBRA의 생성 모델에 답변을 요청하거나 정본·Micro·State·로어를 수정하는 호출이 아니다. native semantic query가 필요하면 설정된 query embedding 정책은 적용될 수 있다.

LIBRA는 공통 엔진이 선택하고 검증한 atomic 근거 묶음을 반환한다. HAYAKU/Flashback은 서버 모드에서는 기존 server logical read, 플러그인 모드에서는 owner 전용 IPC로 자료를 제공하며 GRADIA는 완전한 항목을 선택해 읽는다. LIBRA 원본 전체를 GRADIA에 복사해서 GRADIA의 로어 랭커로 다시 검색하는 구조는 아니다. 두 방식 모두 아래 모델 예산을 사용한다. 최근 챗·플러그인 IPC의 사용 방법과 검증 범위는 [별도 문서](RECENT-CHAT-AND-PLUGIN-IPC-20261015.md)를 따른다.

## 변경 이유

기존 G2 budget factory는 특정 GPT4o-mini 모델·요청 형식에 고정됐고 모델 문맥 128,000토큰을 전체 직렬화 요청의 128,000바이트 제한에도 사용했다. 외부 근거 64KiB 제한도 참조 프로필과 분리돼 있었다. 한국어 등 UTF-8 자료에서는 프로필 예산에 여유가 있어도 요청을 보내기 전에 거절될 수 있었다.

현재 실행은 `sdk/GradiaModelContextBudget.source.js`를 사용한다. 과거 `sdk/GradiaEvidenceBudget.source.js` 및 고정 G2 테스트는 당시 계약을 검증하는 별도 보존 자료다. 과거의 모델 pin과 byte-as-token bound가 현재 GRADIA 실행의 지원 조건은 아니다.

## 별도 예산

| 자원 | 현재 제한과 출처 |
|---|---|
| 외부 코퍼스 | 기본 4MiB / 최대 32MiB. readonly capture의 합산 원문 제한 유지 |
| 메타데이터·raw 읽기 | 기존 합산 metadata 1MiB, raw `7*maxCorpusBytes+2MiB`, reference 개수 제한 유지 |
| 외부 근거 포장 | 참조 수요 프로필에 따라 fast 48,000 / balanced 96,000 / quality 160,000 / custom 240,000자. 제목·출처·escaping을 포함한 근거 블록 한도 |
| 근거 UTF-8 전송 | `min(4MiB, max(64KiB, 프로필 글자 한도*4+8192))`. 기본 balanced는 392,192바이트. token 한도가 아니다 |
| 전체 직렬화 모델 요청 | 별도 자원 상한 16MiB. 모델 문맥 크기에서 byte 한도를 추정하지 않는다 |
| 모델 문맥 | stage preset의 양수 `context_window`, 동일 모델 catalog 정보, Ollama native의 provider context에서 결정. manual과 같은 모델 catalog가 모두 있으면 작은 값을 사용 |
| 출력 예약 | 마지막 실제 payload의 max_tokens / max_completion_tokens / max_output_tokens / maxOutputTokens / num_predict. 16,384 고정 상한을 대입하지 않는다 |
| 안전 여유 | 모델 context의 10%, 최소 256토큰 |

위 근거 포장 한도는 수요 상한이다. 매 요청마다 그만큼 채우는 목표가 아니며, native 참조 자료와 외부 기억을 각각 모델 context만큼 할당하는 것도 아니다. 최종 모델 요청 하나에 들어가는 모든 자료를 합산해 검사한다. 인풋 작성기의 로어 참조 계획 3,200자 및 terminal tail 2,400자는 별도 역할을 유지한다.

## 최종 요청의 선별·검증

1. owner 현재성과 native 입력/선택/설정/권한을 확인한다.
2. 모델 builder가 실제로 만든 요청을 검사한다. 외부 근거가 정확히 한 번 들어가고 native system/user 텍스트가 기대한 값인지 확인한다.
3. 외부 근거만 제거한 base 요청을 계산한다. 현재 입력, 로어·캐릭터 참조, 공유 prefix, 이전 초안, provider 구조화 스키마와 옵션을 포함한다. base 자체가 출력 예약·안전 여유와 함께 문맥을 초과하면 거절한다.
4. 남은 모델 문맥에 완전한 근거 항목을 순서대로 넣는다. 하나만으로도 들어가지 않는 항목은 건너뛰고 남은 후보에서 prefix를 찾는다. LIBRA owner bundle은 하나의 atomic item이며 내부를 자르지 않는다. 선택할 완전한 항목이 하나도 없으면 dispatch하지 않는다.
5. 선택한 근거를 실제 최종 body에 넣고 예산을 다시 검사한다. 원본을 다시 확인한 뒤 그 정확한 body·route·method·provider/model에 private budget witness를 결속한다.
6. 실제 전송 직전에 현재성과 같은 envelope를 확인한다. 단계마다 같은 원본 capture에서 필요한 subset을 사용하며 capture 전체의 owner 현재성은 계속 검사한다. 이전 단계/초안에 영향을 준 원본이 바뀌어도 후속 전달을 차단한다.

Ollama의 외부 근거 경로에서는 종전 native prompt 중간 절단을 사용하지 않는다. native 텍스트는 보존하고 공통 문맥 검사에서 외부 근거 항목만 줄인다. 미연결 native 흐름은 기존 provider 동작을 따른다. 추가 model retry, 조용한 native-only 전환, 근거/초안 영속화는 도입하지 않는다.

### 2026-10-22 갱신 — 요청 중복 생략과 공유 prefix 캐시

- 4단계에서 남은 근거 항목 중, 공백을 정규화했을 때 본문 전체가 이미 그 요청 base에 그대로 들어 있는 항목은 해당 호출에서 뺀다. 화자 라벨 줄과 턴 구분선은 비교에서 제외하며, 40자 미만 항목은 빼지 않는다. 예를 들어 최근 대화 창에 이미 있는 턴의 Flashback 기록이 여기에 해당한다. 비교는 호출마다 따로 하므로, 같은 기록이 일부 단계 프롬프트에만 있으면 그 단계에서만 빠진다. 모든 항목이 중복이면 항목이 비어 있는 근거 블록을 보낸다. `modelSelection.duplicateItems`가 생략 수를 보고하고, `omittedItems`에는 문맥 부족으로 빠진 항목만 센다.
- 근거가 연결된 실행에서도 공유 참조 prefix(로어·캐릭터 참조)의 prompt cache를 유지한다. 근거 블록은 항상 마지막 user 메시지 끝에 있어 모든 cache breakpoint 뒤에 놓인다. meter는 system 쪽 part에 붙은 정확한 두 표식(`cache_control: {type:"ephemeral"}`, `prompt_cache_breakpoint: {mode:"explicit"}`)만 허용하고 framing으로 계산한다. user part의 표식, 다른 값, Gemini `cachedContent`는 계속 거절한다. 근거 실행은 cache 필드를 거절당해도 다시 보낼 수 없으므로, cache 필드는 1st-party OpenAI(`api.openai.com`)와 Anthropic(`api.anthropic.com`) endpoint에만 보낸다.
- 같은 모델의 여러 단계가 같은 shared prefix를 보내면, 단계당 호출이 한 번이어도 모든 provider에서 cache 대상으로 계획한다. 종전에는 Gemini/Vertex만 해당했다.

## 요청 형식과 토큰 추정의 범위

OpenAI-compatible Chat Completions, Responses, Anthropic Messages, Gemini/Vertex Gemini 텍스트, Ollama native 텍스트 payload를 해석한다. 실제 stage 모델과 context metadata를 사용하며 GPT4o-mini 이름을 요구하지 않는다. context metadata 누락, 비정상 출력 설정, 모델/route 변경, multimodal text가 아닌 입력과 unresolved cached-content 참조는 거절한다. arbitrary extra-body override 및 backend bridge에 대한 기존 근거 경계는 유지한다.

현재 meter는 **`unicode-text-estimate-plus-framing`**이다. ASCII 3자당 1토큰, BMP 비ASCII 문자당 1토큰, astral codepoint당 2토큰으로 추정하고 메시지 framing 및 나머지 스키마·옵션을 추가한다. 이는 실제 provider tokenizer 계측이나 보장된 상계가 아니다. UTF-8 byte 수를 token 수로 표시하지 않으며, 출력 예약은 추정 출력 목표가 아닌 실제 payload 값을 쓴다. provider의 실제 tokenizer 및 모델의 숨은 schema 변환 비용 때문에 여전히 context 오류가 날 수 있고, 이때 근거가 포함된 실행은 실패를 전달한다. exact tokenizer/provider count adapter와 실제 설치/모델 부하 검증은 별도 과제다.

`getLibReadOnlyStatus().modelSelection`은 활성 실행의 마지막 dispatch에 대해 선택/누락 항목 수, 모델 context, 추정 입력 토큰, 실제 출력 예약, 안전 여유, 전체 요청/근거 바이트, meter 종류를 제공한다. 원문·질의·source ID·route·credential을 담지 않으며 종료·실패 시 폐기한다. 기존 `selection`은 capture 포장 선택 통계이므로 마지막 모델 subset의 통계와 구분한다.

## 재현

- `tests/gradia/model-context-budget.test.cjs`: 단위 분리, 큰 한국어 입력·근거, 5개 요청 형식, 실제 출력 예약, schema 비용, 자원 상한의 parse 전 거절, payload 변조·digest await 중 변경 검사.
- `tests/gradia_external_model_budget_runtime_test.cjs`: 실제 writer UI·provider builder로 Chat Completions/Responses/Gemini/Claude/Ollama 전달, 64KiB보다 큰 atomic 근거와 128,000바이트보다 큰 요청, 작은 context의 atomic 거절/완전 항목 subset, source 변경 시 전달 차단, catalog/manual cap 검사.
- 기존 writer·source 계약·3-owner SDK·owner receipt·native LIBRA→Shadow/Aide 및 writer 회귀를 실행한다. 실제 native server/SQLite 테스트와 합성 host/model 응답을 구분한다. 실제 외부 provider를 호출했다는 의미는 아니다.
- `node PROGRAM/tools/sync_gradia_model_budget.cjs [--write]`로 portable source와 GRADIA 내장을 검사/생성한다.

### 이번 실행 결과

- 새 예산·작성기·다중 owner consumer·source 계약 묶음: **50/50 통과**.
- 기존 evidence bridge·readonly UI·server adapter·보존 G2 budget 호환 묶음: **145/145 통과**. server adapter가 가져오는 bridge 검사도 포함한 실행 개수다.
- 최신 Min artifact의 공개 작성기 경로: **9/9 통과**.
- native LIBRA→Shadow/Aide 및 인풋 작성기: 통제된 병렬 재실행 **2/2 통과**, Shadow/Aide 단독 재실행 **1/1 통과**. 원본 변경 이후 후속 모델/전달 차단을 검사했다.
- Full·Min 생성/구문 검사, source/embed 및 readonly channel 동기화 검사 통과. 역사적 크기 기준 초과는 빌드 도구의 보고 항목이며 실제 호스트 성능 인증을 뜻하지 않는다.

다른 큰 회귀 묶음과 동시에 실행한 최초 native 조합에서는 두 번째 Shadow/Aide 요청의 예상 거절이 관측되지 않은 경우가 한 번 있었다. 이후 원래 코드와 수정 코드의 두 native 시나리오 재실행은 각각 2/2 통과했다. 이 결과만으로 최초 실패 원인이나 부하 환경의 시간 제한 동작을 확정하지 않는다. 실제 RisuAI 부하·외부 provider 검증은 남아 있다.
