# 원문 태그 필터 원칙 — 필터는 "보지 마"이지 "바뀌었다"가 아니다 (2026-11-19)

대상: LIBRA 3.0.8 (공유 Source Input 정책은 LIBRA·HAYAKU·Flashback 공통). 기준 코드: `Gradia_Continuity` `fc10f82` 이후.
관련 문서: [SOURCE_RULES_20260914.md](SOURCE_RULES_20260914.md), [SOURCE_IGNORE_TAGS_20260913.md](SOURCE_IGNORE_TAGS_20260913.md).

## 1. 원칙

원문 태그 필터는 원문 중 **분석에서 인식하지 않을 부분**을 정하는 읽기 규칙이다.

1. 필터가 가리키는 내용은 **없는 것으로 본다.** 이 규칙은 앞으로 들어올 원문에도, **이미 저장된 원문과 기록에도 똑같이** 적용한다.
2. 필터를 추가하거나 고치거나 지워도 그것만으로 **원문이 바뀌었다(리비전)고 판단하지 않는다.** 필터는 "바뀐 원문"이라고 판정할 근거가 아니다.
3. 원문이 바뀌었는지는 **양쪽을 같은 필터, 즉 현재 필터로 읽은 결과**를 비교해서만 정한다.
   - 저장된 원문과 지금 원문의 메시지가 같고 raw 바이트도 같다 → 같은 턴 (필터만 바뀜)
   - raw는 달라도 현재 필터를 저장본과 현재본에 모두 적용한 결과가 같다 → 같은 턴 (필터가 안 보는 부분만 바뀜)
   - 현재 필터로 읽어도 다르다 → 그때만 원문 변경
4. 따라서 필터를 바꿔도 기존 영수증, Micro, 렌즈 노트, 정본 기억이 무효가 되거나 다시 분석해야 하는 상태가 되지 않는다. 사용자가 원할 때 직접 원문 재분석을 실행하면 현재 필터로 다시 분석할 수 있다. 이 재분석은 선택 사항이다.

필터를 넣는 목적은 원문에 새 내용(태그)이 붙어도 시스템이 정상 작동하게 하는 것이다. 필터를 넣은 결과로 기존 기록이 고장 나면 원칙에 어긋난다.

## 2. 점검 결과: 기존 설계는 이 원칙을 따르지 않았다

### 근본 원인

LIBRA는 턴 식별값 `completedTurnRevisionId(pair)`와 `sourceDigest([pair])`를 **필터를 적용한 뒤의 텍스트**(`pair.user.text`, `pair.assistant.text`, `sanitizedTextDigests`)로 계산한다. 그런데 필터는 현재 값으로 적용된다. 따라서 필터를 바꾸면 raw가 그대로인 턴도 식별값이 달라지고, 저장된 식별값과 비교하는 모든 곳이 그 턴을 "원문이 바뀐 턴"으로 판정했다.

기존 문서 [SOURCE_RULES_20260914.md](SOURCE_RULES_20260914.md)의 "저장과 기존 기록" 절도 다음과 같이 명시해 이 동작을 의도된 설계로 두었다.

> 새 투영과 기존 기준이 다르면 기존 수정 확인/승인 절차로 남깁니다.

이 문장은 필터 변경을 원문 수정 절차로 보낸다는 뜻이며 위 원칙 2와 정면으로 충돌한다. 이 문서가 그 절을 대체한다.

### 그동안의 땜질

이 문제는 필터를 추가할 때마다 다른 곳에서 다시 드러났고, 매번 호출 경로별 예외를 하나씩 더하는 식으로 고쳤다.

| 커밋 | 내용 | 한계 |
| --- | --- | --- |
| `b47de3d` | 사용자의 태그 규칙에 따라 raw만 바뀐 턴의 Micro 유지 | Micro 경로만 해당 |
| `2332a97` | 태그 규칙만 바뀌면 Micro·렌즈 노트 유지 (`sameCompletedTurnRaw`) | `allowProjectedEquivalent`를 켠 호출에서만 적용 |
| `8c56888` | 후처리·패킷 변경 리비전에서 Micro 유지 | Micro 판정 경로만 해당 |
| `796e35c` | 영수증 상태 행과 State 입장에 `readSameTurnReceipt` 사용 | 호출 3곳만 옵션을 켬. 기본 리더와 영수증 복구는 그대로 엄격 |
| `643b63f` | live recall, 정본 배치, 공백 복구에서 텍스트 등가 영수증 허용 | 같은 옵션을 호출 지점마다 추가 |
| `fc10f82` | 필터 변경 후 정본과 세계선 바인딩 보존 | **검사를 무조건 통과시켜** 증상을 없앰. 실제 원문 변경까지 감지하지 못하게 됨 (아래 표 참조) |

`796e35c` 이후에도 기본 경로인 `readActiveCompletedTurnReceipt`(옵션 없음)는 필터만 바뀐 턴을 `stale_source / current_pair_revision_changed`로 판정했다. 그래서 영수증 복구(`recheckReceiptRecovery`)가 그 턴을 다시 캡처해 **새 리비전 영수증을 썼다.** 필터만 바뀌었는데 원문이 바뀐 것으로 기록한 것이다. Micro는 그 뒤 "이전 텍스트 등가 영수증에서 이어받기"로 살아남았고, 회귀 테스트도 이 동작을 정답으로 고정하고 있었다 (`the raw change still makes a new receipt`, `turn 6 Micro record is carried across recapture`).

즉 기존 설계는 "필터 변경 = 리비전, 다만 일부 호출이 예외로 봐 준다"였다. 원칙은 그 반대다.

### 반대 방향의 고장: `fc10f82`

`fc10f82`는 필터 변경 뒤 정본이 막히는 증상을 없애려고 정본 판정을 사실상 끄는 방식을 썼다.

| 위치 | `fc10f82`의 변경 | 결과 |
| --- | --- | --- |
| `libraCanonicalSlotPreservationKind` | 메시지 ID가 달라도 "user·assistant가 있으면" 같은 슬롯으로 인정 | 리롤이나 분기로 **다른 메시지가 된 턴도** 기존 정본을 유지 |
| `unifiedLiveBatchMatchesCanonical` | 어떤 경로든 `return true`. 라이브 채팅이 배치보다 짧아도(메시지 삭제) `true` | 롤백과 삭제를 감지하지 못함 |
| State 재생(`rebuildUnifiedStateForWorldline`) | `UNIFIED_REPLAY_SOURCE_CHANGED` 단언을 경고로 바꾸고 `matched=true` 강제 | 원문이 바뀐 배치로도 State를 재생 |
| Flashback 유지보수 diff | 같은 pair index의 그룹이 있으면 무조건 `unchanged` | 실제 본문 수정이 "변경 없음"으로 보임 |
| HAYAKU 원장 바인딩 | 메시지 ID만 같으면 본문 해시가 달라도 같은 기록으로 인정 | HAYAKU 코드 주석이 금지하는 동작이다 ("cached rerolls can preserve chatId while replacing the response body ... message identity alone must never bind") |

저장소 테스트가 이미 이 고장을 잡고 있었다. 최신 원격 코드에서 `libra_text_equivalent_revision_test`의 "changed chatId slot still fails replay"와 `changed_native_id` 보존 테스트 2건이 실패한다.

필터를 넣어서 기록이 고장 나는 것도, 고장을 숨기려고 검사를 끄는 것도 원칙 위반이다. 원칙은 **현재 필터가 보는 변경은 정확히 잡고, 보지 않는 변경만 무시하는 것**이다.

## 3. 이번 수정: 판정 규칙 하나

`PROGRAM/plugins/LIBRA.js`에 판정 함수 하나를 두고, 저장된 턴이 아직 현재 턴인지 결정하는 리더가 **옵션과 관계없이 기본으로** 이 함수를 쓰게 했다.

```js
// 저장본과 현재본을 모두 현재 필터로 읽어 비교한다.
sameTurnUnderCurrentFilter(stored, current)
  = 역할(user, assistant)마다 메시지 ID가 같고
    ( raw 바이트 다이제스트가 같다                                         // 필터만 바뀜
      || 정규화한 텍스트가 같다
      || cleanMessageText(role, stored.text)를 정규화한 결과 == 현재 텍스트 )  // 저장본에도 현재 필터 적용
```

`cleanMessageText`는 현재 채팅 원문에 쓰는 것과 같은 투영이다. 사용자 규칙이 있으면 `memorySuiteCanonicalSource`를, 없으면 기존 정리 경로를 쓴다. 저장된 텍스트는 저장 당시 필터로 이미 한 번 정리되어 있다. 여기에 현재 필터를 한 번 더 적용하면 현재 필터가 보지 않는 부분은 양쪽에서 똑같이 사라진다. 사용자 제안을 그대로 옮긴 방식이다. 이전 원문에 새로 필터가 생긴 태그가 있으면 그 태그를 없는 것으로 보고 비교한다.

적용 지점은 다음과 같다.

- `readActiveCompletedTurnReceipt`: **기본 경로**에서 필터만 바뀐 턴을 `verified`로 판정하고 기존 영수증을 그대로 쓴다. 영수증 복구도 이 리더를 쓰므로 **새 리비전을 쓰지 않는다.** `allowProjectedEquivalent`(`readSameTurnReceipt`)는 HAYAKU 패킷의 줄 단위 덧붙임 허용 용도로만 남는다.
- `readVerifiedCompletedTurnRawPacket`: 같은 판정을 기본으로 쓰고, 필터 등가일 때는 원문 패킷의 구조만 비교한다.
- `isTextEquivalentCompletedTurn`: 이 판정을 포함한다. 이 함수를 쓰는 Micro 이어받기, State 입장, recall, 정본 입력이 모두 같은 규칙을 따른다.

정본(5턴 배치)은 원래 정책대로 **같은 U+A 메시지 ID**로 판정한다(`libraCanonicalSlotPreservationKind`). 메시지 ID는 필터와 무관하므로 필터 변경만으로는 항상 통과하고, 리롤·분기·롤백은 통과하지 못한다. 이번 수정은 `fc10f82`가 LIBRA에서 끈 다음 검사를 이 판정으로 되돌렸다.

- `libraCanonicalSlotPreservationKind`의 ID 일치 조건
- `unifiedLiveBatchMatchesCanonical`의 무조건 `true`
- State 재생의 `matched=true` 강제와, 단언을 경고로 바꾼 두 곳

리비전 계산식(`completedTurnRevisionId`)은 바꾸지 않았다. 계산식을 바꾸면 이미 저장된 모든 영수증, Micro, 렌즈 기록의 식별값이 한꺼번에 어긋난다. 그러면 이번 수정이 막으려던 일괄 무효화가 그대로 다시 일어난다. 기존 저장 데이터는 마이그레이션이나 재작성 없이 그대로 쓰인다.

### 지켜지는 것

- 현재 필터가 **보는** 부분이 바뀌면(실제 본문 수정) 지금처럼 `stale_source`로 판정하고 새 분석이 필요하다.
- 메시지 ID가 바뀌거나(리롤·분기), 메시지가 삭제되거나, 턴 경계가 바뀌면 다른 턴으로 판정한다. 정본 재생은 `UNIFIED_REPLAY_SOURCE_CHANGED`로 막힌다.
- 필터 변경은 여전히 요청이나 처리 중에는 거부한다(`SOURCE_IGNORE_TAGS_BUSY`). 검토 화면에서 확인한 규칙 키가 실행 직전에 바뀌면 재확인을 요구한다(`reviewed.rulesKey`). 이 검사는 한 번의 명시적 작업이 같은 조건으로 실행되게 막는 장치이고, 저장된 기록을 무효화하지 않는다.

## 4. 검증

`PROGRAM/tests/libra_text_equivalent_revision_test.cjs`가 원칙을 직접 고정한다.

| 경우 | 기대 |
| --- | --- |
| 삽화 추가 (기본 필터가 삽화를 제외) | 같은 턴. 기본 리더 `verified`, 복구 후에도 영수증 리비전 그대로, Micro `verified`, 모델 호출 0회 |
| 저장된 규칙이 있는 상태에서 삽화 추가 | 같은 턴 |
| 이미 필터된 상태창 내용만 변경 (HP 10 → 9) | 같은 턴 |
| **기존 원문에 있던 태그에 필터를 새로 추가** | 같은 턴 (이번 사용자 보고 사례) |
| **그 필터를 다시 제거** | 같은 턴 |
| live recall 중 삽화 추가 (턴 6) | 영수증 리비전 그대로, recall과 State 유지 |
| 정본 커밋 뒤 삽화 추가 → State 재생 | 통과 |
| **정본 커밋 뒤 태그 필터 추가 → State 재생** | 통과 |
| 정본 커밋 뒤 리롤 (chatId 변경) → State 재생 | `UNIFIED_REPLAY_SOURCE_CHANGED`로 실패 (최신 원격에서는 `fc10f82` 때문에 통과해 버렸음) |
| 필터가 보는 줄이 덧붙음 (`[상태창: HP 100]`, 규칙 없음) | 원문 변경 → 재캡처 후 줄 단위 등가로 Micro 이어받기 |
| 실제 본문 수정 | 원문 변경, 새 분석 필요 |

회귀 확인: 관련 LIBRA·공유 규칙·Flashback 테스트 26개 파일을 최신 원격 코드(`fc10f82`)와 이번 수정에 같은 조건으로 실행했다.

| 대상 | 통과 / 전체 |
| --- | --- |
| 최신 원격 | 108 / 136 |
| 이번 수정 | 110 / 136 |

이번 수정에서 새로 생긴 실패는 없다. 추가로 통과한 2건은 `changed_native_id` 보존 거부 테스트다(`direct full/background guard`, `preservation ownership classification`). 나머지 26건은 두 쪽에서 같은 목록으로 실패하며, 이번 변경 전부터 실패하던 것이다.

## 5. 아직 이 원칙으로 바꾸지 않은 곳

| 위치 | 현재 동작 | 필요한 일 |
| --- | --- | --- |
| Flashback 유지보수 diff (`fc10f82`) | 같은 pair index면 본문이 달라도 `unchanged` | `sameMaintenanceTurnText` 비교에 현재 필터를 저장본에도 적용하는 방식으로 바꾸고, slot 무조건 일치는 제거해야 한다. 그러면 필터 변경만 무시하고 실제 수정은 감지한다. |
| Flashback `ruleChangedTurns` 문구 | 필터 변경 턴을 "변경된 턴(수정/롤백 감지)"에 포함해 표시 | 기록을 무효화하지는 않는다. 다만 "태그 규칙 반영(선택)"으로 분리 표시해야 한다. |
| HAYAKU 원장 바인딩 (`fc10f82`) | 메시지 ID만 같으면 본문 해시가 달라도 같은 기록 | HAYAKU는 본문 해시(`assistantVisibleHash`)만 저장하므로 저장본에 현재 필터를 다시 적용할 수 없다. 원문 raw 해시를 함께 저장하고 "raw 동일 또는 현재 필터 투영 동일"로 판정해야 한다. 그 전까지 `fc10f82`의 ID 단독 바인딩은 캐시된 리롤을 잘못 묶을 위험이 있다. |
| LIBRA `verifyLibraHandoffSourceBranchesReadOnly` (RETRACE 인계) | 정본 ref의 `sourceDigest`를 정확히 비교하고, 다르면 `LIBRA_HANDOFF_SOURCE_BRANCH_MISMATCH` | 필터 변경 뒤 인계가 막힐 수 있다. 정본과 같은 ID 기반 슬롯 판정(`libraCanonicalSlotPreservationKind`)으로 바꿔야 한다. |
| LIBRA 대기 중 재생 트랜잭션 (`fc10f82`) | 커밋 실패 시 트랜잭션을 지우고 재구성 | 필터와 무관한 변경이다. 이번 수정 범위 밖이라 그대로 두었다. |

## 6. 앞으로의 규칙 (개발 지침)

- 저장된 기록과 현재 채팅을 비교하는 새 코드는 `completedTurnRevisionId(pair) !== stored.revisionId`나 `sourceDigest([pair]) !== stored.sourceDigest`를 직접 쓰지 않는다. `sameTurnUnderCurrentFilter`(또는 이를 포함하는 `isTextEquivalentCompletedTurn`)를 쓰고, 정본 배치는 `libraCanonicalSlotPreservationKind`를 쓴다.
- 증상을 없애려고 검사를 무조건 통과시키지 않는다. 필터 변경만 통과시키고 실제 변경은 잡는 판정을 쓴다.
- 정확한 식별값 비교는 **같은 작업 안에서** 현재본과 현재본을 비교하는 경우(모델 호출 중에 원문이 바뀌었는지 보는 가드 등)에만 쓴다. 이때 필터는 작업 중 바뀌지 않는다(busy 가드).
- 필터를 추가해 기존 기록이 무효가 되거나 재분석 대상이 되거나 새 리비전이 생긴다면 그것은 버그다. 경로별 예외를 더하지 말고 위 판정 함수로 통일한다.
