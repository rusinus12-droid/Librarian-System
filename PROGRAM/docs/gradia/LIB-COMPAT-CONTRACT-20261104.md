# GRADIA와 LIB 플러그인의 독립 연동 계약

2026-11-04 확정, 2026-11-07 단순화 반영. 대상: GRADIA, LIBRA, HAYAKU, Flashback.

GRADIA는 LIBRA, HAYAKU, Flashback(이하 LIB)의 기억을 조회해 초안 작성에 활용하되, 각 기억 플러그인은 GRADIA의 존재나 실행 상태와 무관하게 자체 검색 및 최종 모델 직접 주입을 독립적으로 수행한다.

## 규칙

### 1. 검색과 예산은 일반 모드와 같다

일반 모드는 플러그인이 자기 Before Request 훅에서 기억을 검색해 주입하는 동작이다.

- 각 플러그인은 자기 설정과 자기 검색 방식으로 검색한다.
- GRADIA는 플러그인에게 예산이나 몫을 정해 주지 않는다.

### 2. GRADIA의 기억 예산은 받아들이는 총량의 최댓값이다

- `memory_budget_chars`와 작업 규모의 기억 값은 GRADIA가 LIB에서 받아 쓸 수 있는 전체 상한이다.
- 플러그인이 넘긴 프롬프트를 GRADIA가 잘라내지 않는다.
- 전체 상한에 들어가지 않는 소유자는 통째로 제외한다.

### 3. 선택한 기억은 선택한 그대로 쓴다

- 선택이 끝난 뒤 저장소가 바뀌어도 기억을 빼지 않고 초안을 버리지 않는다. 백그라운드 작업의 쓰기가 초안을 없애면 안 되기 때문이다.
- 그 결과, 선택 뒤에 바뀐 내용은 그 턴의 응답에 반영되지 않을 수 있다. 일반 모드와 같은 동작이며, 의도한 것이다.
- 2026-11-04 외부 리뷰는 무효화된 기억으로 쓴 초안을 재사용하지 말라고 권고했다. 사용자가 이 권고를 채택하지 않았다.

### 4. 소유자의 성공과 실패는 독립이다

- 소유자마다 읽기 세션과 제한 시간을 따로 둔다.
- 한 소유자의 실패는 그 소유자만 제외한다. 다른 소유자의 읽기를 멈추지 않는다.
- 실행 전체를 멈추는 것은 소유자와 무관한 실패뿐이다. 이 실행의 취소, 현재 채팅의 변경이 여기에 속한다.

### 5. 독립 실행과 기억 전달

- LIBRA, HAYAKU, Flashback은 GRADIA가 실행 중이더라도 자체 기억 검색과 RisuAI `beforeRequest` 훅을 통한 최종 모델 직접 주입을 생략하지 않는다.
- GRADIA는 외부 기억을 조회해 초안을 작성하고 기존 초안 전달 경로로 초안만 전달한다.
- GRADIA는 소유자의 자체 검색·주입을 제어(`attach` 알림 등)하지 않으며, 초안 작성에 사용한 기억을 별도의 `<MEMORY_RECALL>` 블록으로 최종 모델에 재전달하지 않는다.
- 기억의 이중 검색(초안 작성용 조회 + 플러그인 자체 리콜) 및 중복 전달 가능성은 정상 동작으로 허용한다.

## 구현 방식

### 요청 조건의 전달

플러그인 채널은 요청당 64KB로 제한되어 있고, 초과하면 소유자가 응답 없이 버린다. 그래서 요청 내용을 보내지 않고 숫자만 보낸다.

| 필드 | 뜻 |
|---|---|
| `recentChatTurns` | 응답 요청에 들어 있는 assistant 턴 수 |
| `requestChars` | 응답 요청의 전체 글자 수 |

소유자는 자기가 가진 채팅에서 같은 범위의 요청을 재구성해 평소 검색을 돌린다. 턴 수는 최근 챗과의 중복 제거와 문맥 검색에 쓰고, 글자 수는 문맥 압박 판단에 쓴다.

채널 요청에 채팅 원문을 넣지 않는다. 긴 채팅에서 모든 소유자의 응답이 끊긴 결함(2026-11-04 재현)이 여기서 나왔다.

### 코드 위치

| 내용 | 위치 |
|---|---|
| 소유자별 독립 세션 | `plugins/GRADIA.js` `createIndependentOwnerReadClient` |
| 선택 뒤 재검증 생략 | `plugins/GRADIA.js` `createLibServerReadConsumer`의 `holdSelection` |
| 전체 상한 초과 처리 | 같은 함수의 `onOwnerOmitted` |
| 요청 조건 전달 | `tools/gradia_plugin_read.cjs` `runHints` |
| 소유자의 재구성 | HAYAKU `hayakuRecallRequestFor`, Flashback `selectFlashbackRecallPrompt`, LIBRA `captureGradiaMemoryEvidenceOnce` |

### 검증하는 테스트

- `tests/gradia_plugin_read_runtime_test.cjs`: 실제 세 플러그인에서 일반 모드와 같은 기억을 고르는지, 저장소가 바뀌어도 초안이 남는지
- `tests/gradia_three_owner_pipeline_test.cjs`: 소유자별 실패 격리, 상한 초과 시 통째 제외
- `tests/gradia_plugin_mode_long_chat_test.cjs`: 긴 채팅과 큰 저장소
- `tests/gradia_owner_handback_test.cjs`: GRADIA가 멈출 때 소유자의 복구

## 회귀 검사 계약 정리 (2026-11-06)

- 공개 `rewriteInput()`은 네이티브 문맥만 쓰는 API다. 연결된 기억 클라이언트의 실패나 그 콜백에서만 발생하는 채팅 변경을 이 API의 오류로 기대하지 않는다. 대화형 Input Writer도 LIB 기억을 읽지 않으며, 네이티브 문맥·기억 미사용·취소 검사는 `gradia_input_writer_unified_runtime_test.cjs`에서 수행한다.
- 서버 스냅샷에 HAYAKU·Flashback 행이 있어도 실행 중인 소유자의 자체 검색 응답이 없으면 제외한다. 소유자를 제공하지 않는 테스트는 LIBRA 전달과 두 소유자의 제외를 함께 확인한다. 실제 세 소유자 전달은 `gradia_three_owner_pipeline_test.cjs`에서 확인한다.
- 프롬프트 중복 제거 테스트는 실행 중인 소유자의 항목을 사용한다. 소유자가 없어 제외된 항목을 중복 제거 결과로 오인하지 않는다.
- 이전 게시 게이트의 20회 실패는 중복 실행을 포함한 12개 테스트였다. 이 중 네이티브 저장 모드 행렬 1개는 단독 실행에서 재현되지 않았으므로 전체 게이트에서도 확인해야 한다.

## 알려진 한계

- 요청을 재구성하므로 RisuAI가 프롬프트 단계에서 바꾼 내용은 소유자에게 보이지 않는다.
- `requestChars`는 크기만 맞출 뿐 내용까지 같게 하지는 않는다.
- 서버 모드에서 LIBRA 이외 소유자의 읽기 세션을 여는 도중에 원본이 바뀌면, 그 턴에 그 소유자만 제외될 수 있다.
