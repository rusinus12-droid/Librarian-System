# HAYAKU 정규 패킷 경로 감사 — 3.0.117

작성일: 2026-09-13
대상: `MemorySuite/PROGRAM/plugins/HAYAKU_Locator_Continuity.js`
호스트 원본: `C:\Users\rusin\Downloads\Risuai-2026.8.250 (1)\Risuai-2026.8.250`

## 0. 대상 동일성 확인

선행 검토 문서(`REVIEW.md`)가 명시한 해시와 실제 파일을 대조했습니다.

| 항목 | 값 |
|---|---|
| 버전 | 3.0.117 (`//@version` 3줄) |
| 크기 | 3,448,233 바이트 |
| SHA256 | `b384b96179ce96ff04e1872ed3a008c25bdce6edf22114ff6504f0ec524fd4a5` |
| 선행 문서 기재 해시 | 동일 |

일치하므로 선행 문서의 줄 번호와 측정값은 그대로 유효하며, 이 문서의 줄 번호도 같은 파일을 가리킵니다.

부수 확인: 저장소 `README.md`는 HAYAKU를 3.0.106으로, 세션 기억은 3.0.79로 적고 있어 **둘 다 낡았습니다.** 감사 결론에는 영향이 없으나 표기 갱신이 필요합니다.

## 1. 감사 방법과 범위

선행 문서는 정규 작성 프롬프트와 주입 경로를 읽기 중심으로 검토하고, 오탐 여부와 실제 호스트 전송 변환을 **의도적으로 미확정으로 남겼습니다.** 이 감사는 그 두 칸을 닫는 데 집중했습니다.

수행한 것:

1. **판정 함수의 실측 실행.** 원본에서 `structuredOutputOnlyPattern`·`structuredOutputBanPattern`·`structuredOutputExclusiveExceptionPattern`·`isStructuredOutputOnlyPrompt`를 잘라내 Node에서 실행했습니다. 잘라낸 텍스트가 파일의 문자 그대로의 부분 문자열임을 프로그램으로 확인했으므로(`src.includes(조각) === true`) 테스트한 것은 재현본이 아니라 실제 코드입니다.
2. **호스트 전송 변환의 원본 확인.** RisuAI의 Gemini 요청 빌더 `src/ts/process/request/google.ts`에서 system 역할 행이 최종 요청으로 어떻게 변환되는지 읽었습니다.
3. **주입 조각과 memo의 대응 확인.** 어느 조각에 어느 memo가 붙고, 중복 판정이 무엇을 보는지 대조했습니다.

수행하지 않은 것(미검증):

- 실제 Gemini 요청·응답, 제공자 `finishReason`·토큰 사용량, 실제 사용자 누락률.
- 프롬프트 문구 변경의 모델 준수율 효과.
- 생산 코드 수정. **이 감사는 파일을 하나도 바꾸지 않았습니다.** 조치는 최하단 제안서에만 적었습니다.

## 2. 결론

선행 문서가 "우선 조치는 더 강하게 명령하는 것이 아니라 계약 전달을 증명하는 것"이라고 한 결론에 동의합니다. 다만 이번 감사에서 **전달 이전 단계에 더 큰 구멍**이 확인됐습니다.

패킷 누락의 가장 가능성 높은 원인은 모델의 지시 불이행이 아니라, **HAYAKU가 그 요청에서 아무것도 하지 않기로 스스로 판단한 뒤 그 사실을 정상으로 보고하는 경로**입니다. 그리고 그 판단의 방아쇠는 모델이나 제공자가 아니라 **프리셋과 최근 대화에 들어 있는 낱말**입니다.

| # | 발견 | 등급 | 영향 |
|---|---|---|---|
| F-1 | 구조화 출력 판정 오탐이 요청 전체를 부가 요청으로 만든다 | **확정** | 회상·작성 동시 소실, 채팅 단위로 지속 |
| F-2 | 억제 상태를 진단 필드가 "보존됨"으로 보고한다 | **확정** | 고장과 정상이 구분되지 않음 |
| F-3 | 부분 주입 판정이 memo 하나에 의존한다 | **확정** | 스키마 없는 패킷 강제 → 자기 강화 오진 |
| F-4 | Gemini 전송에서 계약이 system에서 user로 강등된다 | **확정** | 제공자별 강제력 차이, Gemini 특유 |
| F-5 | 예산 계단 뒤에 절벽이 있다 | 설계 | 경계 근처에서 전부/전무 |
| F-6 | 예외 fail-open이 정규 작성까지 제거한다 | 설계 | 앞 단계 실패가 기억 손실로 번짐 |

## 3. F-1 — 구조화 출력 판정 오탐 (확정 · 치명)

### 3.1 무엇이 문제인가

`structuredOutputOnlyPattern`(14955줄)의 첫 갈래가 이렇습니다.

```
\b(?:respond|return|output|emit|provide|answer)\b[\s\S]{0,48}\b(?:only\s+)?(?: ... )?(?:json|xml)\b
```

`only`가 **선택사항**입니다. 그래서 이 정규식은 "JSON만 출력하라"가 아니라 **"출력 계열 낱말이 json·xml 근처 48자 안에 있다"** 를 잡습니다. 별도 갈래인 `\b(?:json|xml)\s+schema\b`와 `(?:유효한|엄격한)\s*(?:json|xml)`은 **단독 언급만으로** 참이 됩니다.

### 3.2 실측 결과

원본 함수를 그대로 실행한 결과입니다.

| 입력 | 판정 |
|---|---|
| `Return only valid JSON.` | 억제 — 의도된 정상 |
| `Do not output any JSON. Narrate in prose only.` | 통과 — 부정문 방어 정상 |
| `절대 JSON으로 응답하지 마. 소설처럼 서술해.` | 통과 — 정상 |
| `Write an immersive scene. Never wrap your answer in JSON.` | 통과 — 정상 |
| `You may provide a JSON block at the end if the user asks for data.` | **억제 (오탐)** |
| `This character is a programmer who designs a json schema for a living.` | **억제 (오탐)** |
| `캐릭터의 상태창은 유효한 JSON 형태를 참고해 작성한다.` | **억제 (오탐)** |
| `상태 요약을 출력할 때 설명 없이 간결하게. 참고: 내부 도구는 json을 쓴다.` | **억제 (오탐)** |
| `응답 형식: 자유 서술. (개발자 메모: response format = json 아님)` | **억제 (오탐)** |
| `이 설정이 유효한 json인지 봐줘` | **억제 (오탐)** |
| `output the stats as json` | **억제 (오탐)** |

부정문 방어는 제대로 동작합니다. 문제는 **반대 방향**입니다 — 선택적 JSON 블록, 캐릭터 설정의 기술 용어, 심지어 "json이 아니다"라는 메모까지 전부 "전체 응답을 JSON으로만 내라"로 읽힙니다.

반대 오류도 있습니다. 한국어 갈래가 `(?:json|xml)\s*만\s*(?:출력|반환|응답)` 형태라 조사를 허용하지 않습니다.

| 입력 | 판정 |
|---|---|
| `상태를 json으로만 출력해` | **통과 (누락)** — 진짜 JSON-only 지시인데 못 잡음 |
| `표를 json 형식으로 줘` | 통과 |
| `json으로 정리해서 출력해줘` | 통과 |

즉 **한국어 진짜 지시는 놓치고, 한국어 우연한 언급은 잡습니다.**

### 3.3 노출 범위가 예상보다 넓다

두 개의 독립된 게이트가 있습니다.

**게이트 1 — 요청 분류(15036줄).** 판정 대상은 `combinedInstructionMessages(messages)`이고, 그 함수(14978줄)는 최근 `CLASSIFY_MESSAGE_SCAN_LIMIT = 24`개 메시지 중 **assistant·model 계열만 제외**합니다. 즉 **system 행뿐 아니라 user 행도 포함**되고, 24개를 `\n\n`으로 이어붙인 뒤 한 덩어리로 검사합니다.

여기서 걸리면 15051·15056줄이 `hardAuxiliary`와 `auxiliary`를 참으로 만들고, 32379줄이 즉시 `sanitizeAuxiliaryMessages`로 빠집니다. 그 함수(32290줄)는 HAYAKU 블록을 걷어내고 되돌려줍니다. **패킷 작성만 멈추는 것이 아니라 기억 회상 주입도 함께 사라집니다.**

메시지를 이어붙이므로 48자 근접 조건이 **메시지 경계를 넘습니다.** 실측:

| 조합 | 판정 |
|---|---|
| `Continue the scene in prose.` (단독) | 통과 |
| `Summarize and output the scene.` + `Also the json file I mentioned is unrelated.` | **억제 (경계 넘은 오탐)** |
| `Write immersive prose. Keep the status board tidy.` + `유효한 json 스펙 좀 알려줘` | **억제 (프리셋+사용자 발화 결합 오탐)** |

**게이트 2 — 출력 계약 판정(15653줄).** `detectOutputContract`는 모든 system·developer 행과 **가장 최근 user 행**을 원천으로 삼아 `structuredData.wholeResponse`를 정합니다. 이 값이 참이면 `packetCoreWriteSuppressed`(31332줄)가 참이 되어 고정 계약(31481줄)·런타임 지시(30514줄)·terminal seal(31537줄)이 **모두 빈 문자열**을 돌려주고, 예산 계획은 `inactive('structured_output_only')`(31780줄)가 됩니다. 이 경우 `memoryBlock`도 `''`이므로 주입기는 `empty_injection`으로 아무것도 넣지 않습니다.

### 3.4 지속 시간

프리셋 system 행에 해당 문구가 있으면 **그 채팅에서 영구적으로 매 턴** 발생합니다. 사용자 발화가 방아쇠였다면 그 메시지가 24개 창에 남아 있는 동안(대략 열몇 턴) 계속 발생합니다.

### 3.5 제보와의 관계

이것이 "Gemini에서 패킷 누락이 잦다"에 대한 유력한 대안 설명입니다. **모델이 지시를 어긴 것이 아니라 지시가 애초에 전송되지 않은 것**이고, 조건은 제공자가 아니라 프리셋 문구입니다. 상태창·데이터 블록·도구 설명이 들어간 프리셋을 쓰는 이용자 집단이 특정 제공자에 몰려 있으면 모델별 편차처럼 관측됩니다. 이 감사는 그 상관을 증명하지 않았고, 제보자 프리셋 원문 확인이 필요합니다.

## 4. F-2 — 억제 상태를 진단이 정상으로 보고한다 (확정 · 치명)

33432·33466줄입니다.

```js
runtimeSkeletonPreserved: packetCoreWriteSuppressed(promptSettings) || (packetWriteActive && runtimeSkeletonChars > 0),
completionSealPreserved:  packetCoreWriteSuppressed(promptSettings) || packetWriteActive,
```

억제됐을 때 두 필드가 **참**입니다. 아무것도 주입하지 않은 상태가 "런타임 지시 보존됨 · 완료 지시 보존됨"으로 기록되어, 건강한 요청과 구분되지 않습니다.

작동 로그도 비대칭입니다.

| 비활성 사유 | 작동 로그 |
|---|---|
| `hard_context_exhaustion` | `warn` 기록 (33139줄) + `Memory.lastWarnings` |
| `insufficient_context_budget` | `warn` 기록 (33144줄 이하) |
| `structured_output_only` | **없음** |
| 부가 요청 분류로 우회 | `Memory.lastBeforeRequest.reason`에만 (32290줄) |

가장 발생 확률이 높은 두 경로가 사용자에게 보이는 로그를 남기지 않습니다. 화면의 "작동 로그 0"은 "문제 없음"이 아니라 **"이 종류의 문제는 세지 않는다"** 는 뜻입니다.

이 항목은 F-1을 고치지 않아도 단독으로 가치가 있습니다. 관측이 정직해지면 사용자와 제보자가 스스로 원인을 지목할 수 있습니다.

## 5. F-3 — 부분 주입 판정이 memo 하나에 의존한다 (확정 · 높음)

선행 문서 6.1절이 재현한 결함입니다. 이 감사에서 **어느 조각이 남았을 때 무슨 일이 생기는지**를 확정했습니다.

`hasExistingHayakuRequestInjection`(15140줄)의 첫 검사는 어떤 메시지 하나의 memo가 `RUNTIME_CONTEXT_MEMO`인지입니다. 그런데 그 memo는 두 조각에 붙습니다.

| 조각 | 역할 | memo | 중복 검사 대상 |
|---|---|---|---|
| 고정 계약 (스키마 전체) | system | `hayaku-cache-static-v1` (32149줄) | **아님** |
| 런타임 지시 (상수·lineage) | user | `hayaku-runtime-context-v3` (32125줄) | 예 |
| terminal seal (완료 지시) | system | `hayaku-runtime-context-v3` (32113줄) | 예 |

따라서 부분 입력의 세 경우가 모두 잘못 처리됩니다.

- **런타임 지시만 남은 경우** — "이미 주입됨" 판정. 계약과 seal이 복구되지 않습니다. (선행 문서가 재현한 경우)
- **seal만 남은 경우** — 역시 "이미 주입됨". 모델은 스키마도 lineage 상수도 없이 **"HAYAKU_STATE_PACKET_END로 끝내라"는 명령만** 받습니다. 이 조합이 더 해롭습니다.
- **고정 계약만 남은 경우** — memo가 검사 대상이 아니고, 텍스트 갈래(15146줄)는 본문이 `[HAYAKU PACKET MEMORY]` 또는 `[HAYAKU PACKET WRITE]`로 **시작**할 것을 요구하는데 계약 본문은 캐시 봉투로 시작하므로 걸리지 않습니다. 감지되지 않습니다.

두 번째 경우에는 자기 강화 고리가 생깁니다. 스키마 없이 만들어진 패킷은 파싱에 실패하고, 다음 요청에서 `buildPacketHealthRepairHint`(30494줄)가 `strict JSON syntax and escaping`을 고치라고 지시합니다. **원인은 계약 소실인데 진단은 JSON 문법을 지목**하므로, 반복될수록 잘못된 방향으로 굳습니다.

이 감사는 **어떤 생산자가 부분 입력을 만드는지 확정하지 않았습니다.** 호스트 재호출, 다른 플러그인, 전송 변환 중 무엇이든 가능하고 실 로그가 필요합니다. 다만 판정이 **완전성 검사가 아니라 존재 검사**라는 사실은 생산자와 무관하게 결함입니다.

## 6. F-4 — Gemini 전송에서 계약이 user로 강등된다 (확정 · 높음)

선행 문서 8절이 "핵심은 HAYAKU의 후반 system 행이 최종 Gemini systemInstruction/contents로 어떻게 변환되는가"라며 미검증으로 남긴 항목입니다. RisuAI 원본에서 확인했습니다.

`src/ts/process/request/google.ts`:

- 53~56줄: **첫 메시지가 system일 때만** 그 내용이 `systemPrompt`가 되고 배열에서 제거됩니다. 이후 345~350줄에서 `systemInstruction.parts[0].text`로 들어갑니다. 즉 **systemInstruction에는 첫 행 하나만** 들어갑니다.
- 107~119줄: 나머지 system 행은 앞이 user 턴이면 그 턴 본문에 `\nsystem:` + 내용으로 **덧붙고**, 아니면 `"system:" + 내용`인 **user 턴으로 새로 삽입**됩니다.
- 260~281줄: 그 뒤 같은 역할이 연속되면 parts를 합치고 앞 턴에 흡수시킵니다.

HAYAKU는 고정 계약을 `findHayakuStableSystemPrefixBoundary`(32039줄)가 찾은 **선행 system 행 다음**에 넣습니다. 프리셋이 맨 앞에 system 행을 두는 통상적 구성에서 계약은 `formated[0]`이 아니므로, **systemInstruction에 들어가지 못하고 `system:`으로 시작하는 사용자 발화가 됩니다.** terminal seal은 마지막 system 행이므로 바로 앞 user 턴에 흡수되어 **사용자의 실제 대사와 한 덩어리**가 됩니다.

`INJECTED_MESSAGES.json`의 실제 5행 배열로 추적한 결과:

| HAYAKU 출력 | Gemini 최종 형태 |
|---|---|
| 0 system `Continue the scene.` | `systemInstruction` (유일) |
| 1 system 고정 계약 | user 턴, 본문이 `system:`으로 시작 |
| 2 user 런타임 지시 | user 턴 (병합) |
| 3 user `Open the archive.` | user 턴 (병합) |
| 4 system terminal seal | 앞 user 턴 끝에 `\nsystem:` + 내용으로 흡수 |

**위치는 지켜집니다** — seal은 합쳐진 턴의 끝에 남으므로 "FINAL CONTENT MUST END WITH"의 순서 자체는 유효합니다. 잃는 것은 **역할**입니다. OpenAI 호환 경로는 system 행을 그대로 보존하므로 이 강등은 Gemini 경로 특유이고, 동일한 프롬프트가 제공자별로 다른 강제력을 갖는 구조적 이유가 됩니다.

주의할 점: 요청의 첫 행이 system이 **아닌** 구성(예: user 행으로 시작)에서는 경계가 0이 되어 HAYAKU 계약이 `formated[0]`이 되고, 그 결과 **계약이 systemInstruction 전체를 차지**합니다. 즉 레이아웃이 요청 형태에 따라 크게 달라지며, 지금은 어느 쪽이 됐는지 관측되지 않습니다.

`applyGeminiPromptCache`(11405줄)는 본문을 수정하지 않으므로 이 강등의 원인이 아닙니다. 선행 문서 판단과 같습니다.

## 7. F-5 — 예산 계단 뒤의 절벽 (설계 · 중간)

`FINDINGS.json`의 실측 경계입니다.

| cap(문자) | 활성 | 사유 | 프로필 |
|---:|---|---|---|
| 30,000 | 예 | `atomic_contract_complete` | p4-full |
| 6,677 | 예 | `atomic_contract_complete` | p4-critical |
| 6,676 | **아니오** | `insufficient_context_budget` | — |

31782줄이 `atomicMinimumChars > cap`이면 즉시 `inactive`입니다. 1자 차이로 작성이 0이 됩니다.

그리고 계단이 사실상 한 칸입니다. full 6,012자 → compact 5,117자 → critical 5,007자로 **critical이 full의 83%** 이며, 줄어든 것은 예시와 기억 사용 안내뿐입니다. 5,007자 안에는 여섯 축과 약 20개 컬렉션의 필드 규칙이 그대로 남아 있습니다.

실제 최소 필수는 "정확히 하나의 current_snapshot · 봉투 마커 · lineage 상수 정확 복사 · 근거 있는 summary" 정도이며 수백 자로 표현할 수 있습니다. **진짜 비상 계약이 없어서, 여유가 조금 부족한 상황과 전혀 없는 상황이 같은 결과(0)를 냅니다.**

## 8. F-6 — 예외 fail-open이 작성까지 제거한다 (설계 · 중간)

33683줄 `catch`는 요청을 중단시키지 않기 위해 기존 메시지에서 HAYAKU 아티팩트를 걷어냅니다. 그 지점은 저장·세계선·리콜 처리를 모두 지난 뒤이므로, **앞 단계의 사소한 실패가 정규 작성까지 함께 없앱니다.** 33716줄에서 `Memory.store = emptyStore()`도 실행되어 그 턴의 재구성 상태가 비워집니다.

선행 문서의 경고에 동의합니다 — catch에서 아무 lineage로 패킷을 만들게 하면 잘못된 턴에 저장될 수 있습니다. scope·turn·nonce가 확정된 경우와 확정되지 않은 경우를 분리해야 하며, 이는 구현 전 설계가 필요한 항목입니다.

## 9. 미확정으로 남긴 것

- **실제 Gemini 누락률과 원인 기여도.** F-1이 제보를 설명할 수 있다는 것과 실제로 설명한다는 것은 다릅니다. 제보자 프리셋 원문, 모델 ID, `finishReason`, 토큰 사용량이 필요합니다.
- **`current_chat_indexes_invalid`.** 첨부 화면에 보이는 값입니다. 9971줄에서 캐릭터·채팅 인덱스가 정수가 아니고 직접 선택 폴백도 실패했을 때 스코프를 `confident:false`로 반환하는 경로입니다. 캐릭터나 채팅을 선택하지 않은 상태의 정상 반응일 수 있어 결함으로 단정하지 않습니다. 다만 같은 화면에서 Flashback은 스코프를 잡고 HAYAKU는 못 잡은 비대칭이므로, 실제 채팅을 열어둔 상태에서 재현되는지 확인할 값이 있습니다.
- **프롬프트 구성 변경의 준수율 효과.** 선행 문서 7절의 가설(필수·선택 계층화, 출력 마감 순서)에 조건부로 동의하나, **F-1~F-4를 고치기 전에 A/B를 하면 안 됩니다.** 지금 준수율을 재면 "프롬프트가 나빠서 안 썼다"와 "프롬프트가 도착하지 않았다"가 섞여 어느 쪽인지 알 수 없습니다.
- **부분 입력의 생산자.** F-3의 방아쇠를 만드는 주체.

## 10. 재현 절차

F-1은 아래로 그대로 재현됩니다. 원본에서 판정 함수를 잘라내 실행하므로 재현본 오차가 없습니다.

```js
// node probe.cjs
const fs = require('fs');
const p = '<...>/MemorySuite/PROGRAM/plugins/HAYAKU_Locator_Continuity.js';
const src = fs.readFileSync(p, 'utf8');
const L = src.split(/\r?\n/);
const grab = n => { const i = L.findIndex(l => l.includes(n)); if (i < 0) throw new Error('miss ' + n); return L[i]; };
const only = grab('const structuredOutputOnlyPattern =');
const ban  = grab('const structuredOutputBanPattern =');
const exc  = grab('const structuredOutputExclusiveExceptionPattern =');
const s    = L.findIndex(l => l.includes('const isStructuredOutputOnlyPrompt = value =>'));
const fn   = L.slice(s, s + 7).join('\n');
for (const t of [only, ban, exc, fn]) if (!src.includes(t)) throw new Error('not verbatim');
const text = v => (v == null ? '' : String(v));
const isOnly = new Function('text', [only, ban, exc, fn, 'return isStructuredOutputOnlyPrompt;'].join('\n'))(text);

// 게이트 1은 최근 24개 비-assistant 메시지를 '\n\n'으로 이어붙여 검사한다
console.log(isOnly('You may provide a JSON block at the end if the user asks for data.')); // true (오탐)
console.log(isOnly('캐릭터의 상태창은 유효한 JSON 형태를 참고해 작성한다.'));                  // true (오탐)
console.log(isOnly('상태를 json으로만 출력해'));                                          // false (누락)
console.log(isOnly(['Summarize and output the scene.',
                    'Also the json file I mentioned is unrelated.'].join('\n\n')));       // true (경계 넘은 오탐)
```

F-4는 `src/ts/process/request/google.ts`의 53~56줄과 107~119줄, 260~281줄, 345~350줄을 읽으면 확인됩니다. 실제 요청 본문으로 증명하려면 해당 함수의 반환 직전에 `contents`와 `systemInstruction`을 덤프해야 하며, 이는 호스트 소스 수정이므로 이번에 하지 않았습니다.

F-3은 선행 문서 6.1절 절차와 `FINDINGS.json`의 `duplicatePartial`로 재현됩니다. seal만 남기는 변형은 같은 절차에서 제거 대상을 바꾸면 됩니다.

## 11. 선행 검토 문서와의 관계

`REVIEW.md`(2026-09-13)는 이 감사의 출발점이며 결론이 상충하지 않습니다. 달라진 점만 적습니다.

| 선행 문서 | 이 감사 |
|---|---|
| 6.3절: 오탐 검토 필요, 이번에 오탐 확정하지 않음 | **오탐 7건·누락 3건 실측 확정.** 원인은 `only`의 선택성과 단독 언급 갈래 |
| 6절 표: `structured_output_only`는 "형식 충돌 회피 의도" | 의도는 타당하나 **결과가 패킷 작성이 아니라 HAYAKU 전체 우회**이며, 창이 24개 메시지·user 행 포함 |
| 8절: Gemini 변환은 미검증 | **호스트 원본으로 확정.** 첫 행만 systemInstruction, 나머지 system은 user로 강등·병합 |
| 6.1절: 부분 주입 시 static·terminal 없음 | **memo 공용 구조 확정.** seal만 남는 조합이 더 해롭고, static은 감지 자체가 불가 |
| 9절 우선순위: 전달 완전성 → 관측 통일 → 프롬프트 A/B | 순서 동의. 단 **관측을 먼저** 고칠 것을 권합니다(F-2가 나머지 조사를 방해함) |

선행 문서가 "이미 있는 것을 개선으로 제안하지 말라"고 한 경계도 유지했습니다. summary-only 허용, 선택적 grounding, 런타임 상수 분리는 이미 구현돼 있으므로 아래 제안에 포함하지 않았습니다.

---

# 권장 패치 제안서

지시에 따라 **어떤 코드도 수정하지 않았습니다.** 아래는 제안이며, 각 항목에 위험도·효과·전제·검증 방법을 함께 적었습니다. 순서는 권장 착수 순서입니다.

## P-1. 억제·비활성 상태를 정직하게 보고 (위험 낮음 · 효과 큼 · 관측)

**왜 먼저인가.** F-2를 고치지 않으면 나머지 조사가 전부 추측이 됩니다. 사용자도 제보자도 "지금 HAYAKU가 이 채팅에서 꺼져 있다"는 사실을 알 방법이 없습니다.

**무엇을.**

1. 33432·33466줄의 `packetCoreWriteSuppressed(...) ||` 단축을 제거하고, 억제 상태를 별도 값으로 보고합니다. 참/거짓 두 값이 아니라 `preserved | suppressed_by_output_contract | absent` 같은 3상태가 맞습니다.
2. `structured_output_only`와 부가 요청 우회에도 `pushOperationLog(..., 'warn')`과 `Memory.lastWarnings` 기록을 추가합니다. 다른 두 비활성 사유는 이미 그렇게 합니다.
3. 로그 본문에 **판정 근거**를 남깁니다 — 어느 역할·어느 인덱스의 어떤 문구가 걸렸는지(문구는 앞뒤 40자 정도로 절단). 원문 전량은 남기지 않습니다.
4. GUI에 상태를 노출합니다. 원장 뷰어 상단 배너에 "이 채팅에서 연속성 기록이 꺼져 있습니다 — 프리셋의 `…json…` 문구 때문입니다"를 띄우고, 작동 로그 탭에 사유별 집계를 추가합니다. 이번 세션에 만든 진단 카드 자리를 그대로 쓸 수 있습니다.

**전제.** 없음. 기존 진단 필드의 의미만 바뀌므로 소비하는 곳(GUI·하니스·테스트)을 함께 갱신해야 합니다.

**검증.** 억제 fixture에서 `runtimeSkeletonPreserved`가 더 이상 참이 아님을 단정하고, 작동 로그에 warn 1건이 남는지 확인. 정상 fixture에서는 warn 0건 유지.

## P-2. 구조화 출력 판정 교정 (위험 낮음~중간 · 효과 매우 큼)

**무엇을.**

1. **배타성을 필수로.** 첫 갈래에서 `(?:only\s+)?`의 선택성을 제거하고, 배타 표현(`only` / `nothing but` / `~만` / `のみ`) 또는 호스트가 선언한 출력 형식 메타데이터가 있을 때만 `wholeResponse`를 참으로 둡니다. 단독 언급 갈래(`json schema`, `유효한 json`)는 **형식 감지(`formats`)에만** 쓰고 전체 응답 판정에서 분리합니다.
2. **한국어 조사 허용.** `(?:json|xml)\s*만` → `(?:json|xml)\s*(?:으로|로|만)*\s*만` 류로 조사 사이를 허용해 `json으로만 출력해`를 잡습니다. 지금은 진짜 지시를 놓칩니다.
3. **메시지 경계를 넘지 않게.** 게이트 1이 24개 메시지를 `\n\n`으로 이어붙인 뒤 검사하므로 근접 조건이 경계를 넘습니다. **메시지 단위로 검사하고 결과를 합치는** 방식으로 바꿉니다.
4. **역할별 권한 분리.** 출력 계약을 정할 수 있는 것은 system·developer 행과 최신 사용자 제어 텍스트입니다. 지난 사용자 발화 23개가 계약을 정하지 못하게 창을 좁힙니다.
5. **오탐 시 실패 방향을 바꿉니다.** 확신이 없으면 HAYAKU를 끄는 대신, 패킷 배치를 보수적으로(기계 판독 블록 밖, 꼬리) 두고 작성은 유지하는 쪽이 손실이 적습니다. 기억을 잃는 것보다 형식이 어긋날 위험이 작습니다.

**위험.** 진짜 JSON-only 요청에서 패킷을 쓰면 프리셋의 출력 형식이 깨질 수 있습니다. 그래서 5번은 **배타성이 불확실할 때만** 적용해야 하고, 명시적 배타 선언에서는 지금처럼 완전히 억제해야 합니다.

**전제.** P-1이 먼저 들어가야 교정 전후를 비교할 수 있습니다.

**검증.** 이 문서 3.2·3.3절의 입력 21개를 회귀 테스트로 고정합니다. 오탐 7건이 통과로, 누락 3건이 억제로 바뀌고, 의도된 4건(정상 억제 1 + 부정문 3)은 그대로여야 합니다. 기존 `hayaku_prompt_contract_v4_runtime_test.cjs`의 `Return only valid JSON.` 억제도 유지.

## P-3. 중복 판정을 조각 집합 검사로 (위험 중간 · 효과 큼)

**무엇을.**

1. `hasExistingHayakuRequestInjection`을 존재 검사에서 **완전성 검사**로 바꿉니다. 판정 기준은 세 조각(고정 계약·런타임 지시·terminal seal)의 **집합**, 현재 요청의 `lineage`(`request_nonce`·`logical_turn_id`·`turn_owner_key`), `packet_schema_rev`, 계약 해시(`contractCoreHash`, 31508줄에 이미 있음)입니다.
2. 조각마다 **고유 memo**를 부여합니다. 지금은 런타임 지시와 seal이 `hayaku-runtime-context-v3`를 공유해 서로를 가립니다.
3. 현재 요청의 부분 주입이면 **누락 조각만 보충**하거나 소유한 조각을 걷어내고 한 세트로 재조립합니다. 다른 nonce·다른 scope의 조각은 재사용하지 않고 제거합니다.
4. 훅 반환 직전에 **실제 메시지 배열을 다시 읽어** 조각의 존재·길이·역할·인덱스를 확인하고 그 결과를 기록합니다. 계획 단계의 `active === true`만으로 전달 성공을 기록하지 않습니다.

**위험.** 잘못 만들면 이중 주입이 됩니다. 계약 해시와 nonce를 함께 보면 막을 수 있지만, reroll·이어쓰기·같은 요청 재호출을 각각 회귀 검증해야 합니다.

**전제.** P-1의 정직한 관측이 있으면 부분 주입이 실제로 언제 발생하는지 현장에서 셀 수 있습니다.

**검증.** 세 가지 부분 입력(런타임만·seal만·계약만)을 각각 넣어 반환이 정확히 한 세트가 되는지 확인. 완전 입력에서는 조각 수가 늘지 않아야 합니다(idempotence).

## P-4. Gemini 전송에서의 계약 위치 전략 (위험 중간 · 효과 큼 · 설계 필요)

**무엇을.** 선택지가 세 가지이고, 어느 쪽이든 먼저 **관측**해야 합니다.

- (a) 고정 계약을 첫 system 행에 **병합**해 `systemInstruction`에 들어가게 합니다. 프리셋 본문을 건드리므로 캐시 접두부가 흔들리고, 호스트 프리셋 소유권과 충돌할 수 있습니다.
- (b) 강등을 전제로 문구를 설계합니다. user 발화로 읽히더라도 유효하도록 계약 서두를 다듬습니다. 호스트를 건드리지 않는다는 장점이 있습니다.
- (c) 제공자 경로를 감지해 배치를 달리합니다. 가장 정확하지만 호스트 내부 판정에 의존하므로 취약합니다.

**전제.** 요청마다 "계약이 최종적으로 어느 역할·어느 위치에 도착했는가"를 기록하는 관측이 먼저 필요합니다. 지금은 요청 형태에 따라 계약이 `systemInstruction` 전체가 되기도 하고 user 발화가 되기도 하는데(6절 마지막), 어느 쪽이었는지 알 수 없습니다.

**검증.** 제공자별로 최종 요청 본문의 조각 해시·역할·인덱스를 대조합니다. 지원되지 않는 호스트에서는 "검증 불가"로 표시하고 성공으로 기록하지 않습니다.

## P-5. 진짜 비상 계약 추가 (위험 낮음~중간 · 효과 중간)

**무엇을.** full·compact·critical 아래에 **minimal** 프로필을 하나 더 둡니다. 남길 것은 "정확히 하나의 current_snapshot · 봉투 마커 두 개 · 여섯 축 · lineage 상수 정확 복사 · 근거 있는 summary 하나면 완전한 패킷"이고, 컬렉션 필드 규칙과 예시는 뺍니다. 목표는 수백 자입니다.

**남기면 안 되는 것.** 근거 보존, 지식 경계, 성인 사실의 비노골적 보존은 축약 대상이 아닙니다. 이 세 가지를 뺀 minimal은 만들지 않습니다.

**위험.** minimal에서 만들어진 패킷의 스키마 준수율이 낮을 수 있습니다. 그러나 지금은 같은 상황에서 **아무것도 저장되지 않으므로** 하한이 개선됩니다.

**검증.** cap을 6,676 → 3,000 → 1,000으로 낮추며 `active`가 유지되는지, minimal 패킷이 파싱·수용을 통과하는지 확인.

## P-6. 예외 시 최소 작성 fallback (위험 중간 · 효과 중간 · 설계 필요)

**무엇을.** 리콜 준비와 작성 계약 준비를 분리합니다. `catch`에 도달했을 때 scope·lineage·출력 계약·호스트 한도가 **모두 확정된 경우에만** minimal 작성 지시를 살립니다. 하나라도 불확실하면 지금처럼 정리하고 통과시킵니다.

**금지.** 식별자가 불확실한 상태에서 패킷 작성을 강제하거나 임의 lineage로 저장하는 방식. 잘못된 턴에 기억이 붙는 것은 기억이 없는 것보다 나쁩니다.

**전제.** P-5의 minimal 프로필. P-3의 조각 재조립.

**검증.** 각 단계에서 의도적으로 예외를 던져(저장·세계선·리콜) 확정 상태에서만 fallback이 뜨는지, 불확실 상태에서는 뜨지 않는지 확인.

## P-7. 실패 단계 관측 필드 통일 (위험 낮음 · 효과 중간)

선행 문서 9절의 제안을 그대로 채택하되, 이번 감사에서 확인된 상태를 추가합니다. 요청마다 `requestId / scope / lineage / contractHash`를 연결하고 아래를 구분합니다.

```
excluded_by_request_policy
suppressed_by_output_contract      ← 판정 근거(역할·인덱스·문구 발췌) 필수
suppressed_by_context_budget
before_request_failed
partial_contract_detected          ← 어느 조각이 있었고 어느 조각이 없었는지
complete_contract_returned_to_host ← 반환 배열 재확인 결과
provider_contract_verified | provider_contract_unknown
response_no_packet | response_truncated | malformed_packet
semantic_admission_failed | storage_failed | binding_pending | active_memory
```

기존 필드는 별칭으로 유지합니다. 기본 로그에는 조각 해시·길이·마커 수·판정 사유·역할·인덱스만 남기고 원문은 명시적으로 내보낸 익명화 사례에만 포함합니다.

## P-8. 검증 도구 영구화 (위험 없음 · 효과 중간)

10절의 재현 스크립트를 `MemorySuite/PROGRAM/tools/hayaku_output_contract_probe.cjs`로 영구화합니다. 원본에서 판정 함수를 잘라내 실행하고 부분 문자열 동일성을 검사하는 구조이므로, 정규식이 수정될 때마다 오탐·누락 표가 즉시 갱신됩니다. 기존 검증 도구 8종과 같은 위치·같은 호출 규약(`node <도구> "<플러그인 경로>"`)을 씁니다.

## P-9. 표기 갱신 (위험 없음)

`README.md`의 HAYAKU 버전 3.0.106을 3.0.117로 갱신합니다. LIBRA·Flashback·서버 버전도 함께 대조해야 합니다.

## 착수하지 말아야 할 것

- **프롬프트 문구 A/B를 먼저 하는 것.** F-1~F-4가 남아 있으면 준수율 측정이 "안 썼다"와 "못 받았다"를 섞습니다.
- **Gemini 전용 강경 문장 추가, 대문자 증량, 캐시 일괄 해제, 전체 응답 JSON 강제, 재시도 증량.** 선행 문서 8절 판단에 동의합니다. 근거 없는 우선안입니다.
- **정규식 키워드 목록에 제공자 이름이나 특정 프리셋 문구를 추가하는 것.** 오탐의 원인은 목록의 누락이 아니라 판정 기준(배타성)의 부재입니다.
- **HAYAKU 36639~36980줄 저널 보호 구간 수정.** 의도된 fail-closed 구간입니다.
