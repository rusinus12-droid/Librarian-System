# 기억 주입 공통 예산과 중복 제거 — 2026-11-19

대상: LIBRA 3.0.8, HAYAKU 4.0.7, Flashback 2.0.6.

## 배경

LIBRA·HAYAKU·Flashback은 각자 요청 전 훅(`beforeRequest`)에서 기억을 요청에 넣는다. 예산이 플러그인마다 따로였고, 같은 문장을 여러 플러그인이 함께 넣어도 걸러지지 않았다.

플러그인 IPC로 한 플러그인이 나머지의 기억을 모아 한 번에 넣는 "통합 리콜"은 채택하지 않았다. RisuAI의 훅 순서는 플러그인이 정할 수 없다. 그래서 조정자가 다른 플러그인에 기억을 물을 때, 그 플러그인의 요청 전 처리가 아직 안 끝났을 수 있다. Flashback의 세계선 동기화와 HAYAKU의 요청 계보·복구 capture 등록이 그런 처리다.

대신 훅 순서와 상관없이 동작하는 두 가지를 넣었다.

## RisuAI 훅 실행 방식 (확인한 근거)

`kwaroran/Risuai` `ea61945` (`PROGRAM/contracts/risuai`의 고정 커밋), `src/ts/process/request/request.ts`:

```ts
for(const replacer of pluginV2.replacerbeforeRequest){
    arg.formated = await replacer(arg.formated, model)
}
```

요청 전 훅은 등록 순서대로 하나씩 실행되고, 각 훅은 앞 훅이 바꾼 메시지 배열을 받는다. v3 API의 `addRisuReplacer`는 함수를 그대로 등록한다. 따라서 뒤에 도는 플러그인은 앞 플러그인의 기억 블록을 볼 수 있다. 어느 플러그인이 먼저 도는지는 알 수 없다.

## 1. 기억 주입 공통 예산

- 설정: `{version:1, enabled, totalChars(1,000~40,000), shares:{libra,hayaku,flashback}}`. 비율은 0~100 정수이고 합이 100이어야 한다. 기본값은 꺼짐이며, 켤 때 처음 보이는 값은 16,000자에 LIBRA 50 · HAYAKU 25 · Flashback 25다.
- 저장: 각 플러그인의 원문 규칙 설정과 같은 저장 항목(`recallBudget` 필드)에 넣는다. 규칙을 저장할 때 예산이 보존되고, 예산을 저장할 때 규칙이 보존된다. 저장된 예산 형식이 잘못됐으면 꺼진 것으로 보고 플러그인은 계속 동작한다.
- 동기화: 원문 규칙 동기화 채널(`memory_suite_source_rules_v1`)에 `describe_budget`·`apply_budget`을 추가했다. 예산이 다른 플러그인에만 보내고, 비교할 때 본 값과 지금 값이 다르면 받는 쪽이 거절한다(`SOURCE_RULE_SYNC_CONFLICT`). 이 기능이 없는 이전 버전은 "이 기능이 없는 버전"으로 표시한다.
- 화면: 원문 태그 필터 편집기 아래의 "기억 주입 공통 예산" 패널. 플러그인별 몫을 글자 수로 보여 주고, Flashback 몫이 800자 미만이면 경고한다. 편집하지 않은 패널은 다른 플러그인이 바꾼 예산을 바로 불러온다. 편집 중이면 초안을 유지하고, 적용을 한 번 더 눌러야 덮어쓴다.
- 적용 (켜져 있을 때 각 플러그인의 자체 예산 대신 몫을 쓴다. 문맥 크기에 맞춘 축소는 그 아래에서 그대로 한다):
  - LIBRA: `recallMaxChars` 대신 사용한다(`unifiedEvidenceCharBudget`, GRADIA 읽기 포함). 블록 전체 상한 20,000자는 유지한다.
  - HAYAKU: 회상 근거 상한(`recallCapChars`)을 몫 이하로 줄인다. 패킷 작성 지침과 장면 상태는 기존처럼 이 예산 밖이다.
  - Flashback: `maxInjectionChars` 대신 사용한다. 800자 미만이면 기존 규칙대로 기억을 넣지 않는다.
- 진단: Flashback `lastRecall.recallBudgetSource`, HAYAKU `lastDebug().peerRecallDedup.budgetSource` (`own_setting` | `memory_suite_shared`).

## 2. 나중에 넣는 플러그인의 중복 제거

`memorySuitePeerRecallIndex(messages, owner)`는 요청에 이미 들어 있는 다른 두 플러그인의 블록을 찾는다.

| 플러그인 | 알아보는 블록 |
|---|---|
| LIBRA | `<LIBRA_CLASSIC_RECALL>…</LIBRA_CLASSIC_RECALL>`, `[LIBRA 장기기억 …]` 메시지 |
| HAYAKU | `[HAYAKU ACTIVE SCENE HEAD]` 또는 언어별 첫 줄(`앞서 확립된 정황:` 등)부터 패킷 작성 지침 앞까지, `[HAYAKU PACKET MEMORY]`, `[VERBATIM PAST EVIDENCE]`, `[HAYAKU CONTINUITY CONTEXT]` |
| Flashback | `[ACTIVE CONTINUITY EVIDENCE]`, `[FLASHBACK EVIDENCE]`, `[VECTOR RAG MEMORY]` |

판단 기준은 "같은 턴"이 아니라 "같은 문장"이다. 같은 턴이라도 LIBRA의 정리된 사실과 Flashback의 원문은 서로 보완하기 때문이다. 항목을 문장 단위로 나눠 비교한다. 비교 전에 목록 기호, 앞쪽 `[T3]` 같은 이름표, `summary:` 같은 짧은 필드 이름, 공백과 문장 부호는 뺀다. 8자 미만 조각은 세지 않는다. 다른 플러그인 블록에 이미 있는 글자가 80% 이상이면 그 항목을 뺀다. 일부만 겹치는 긴 발췌는 남긴다.

- LIBRA: 근거 줄 단위로 뺀다. 줄이 모두 빠진 섹션은 제목도 뺀다. `Runtime.lastPeerRecallDedup = {owners, droppedLines}`.
- HAYAKU: 리콜 항목(entry) 단위로 뺀다. 장면 상태와 패킷 작성 지침은 리콜이 아니므로 그대로 둔다. `lastDebug().peerRecallDedup.droppedEntries`.
- Flashback: 발췌 후보(variant)와 상태 문장 단위로 뺀다. 남는 후보가 없는 항목은 뺀다. `lastRecall.peerRecallDedup.droppedVariants`. Flashback은 원래도 요청에 턴 전체가 이미 보이면 그 턴을 후보에서 뺐다. 새 처리는 턴의 대부분(80% 이상)이 겹치는 경우까지 다룬다.

먼저 넣은 플러그인은 나중 블록을 보지 못하므로, 중복은 항상 나중에 넣는 쪽이 정리한다. 빠진 만큼 예산을 다른 항목으로 다시 채우지는 않는다.

## 검증

`PROGRAM/tests/memory_suite_recall_share_test.cjs` (두 릴리스 workflow에 등록):

- 예산 검증, 기본값 꺼짐, 플러그인별 몫 계산
- 세 플러그인 블록 형식 인식, 자기 블록 제외, 80% 기준, 이름표 제거, 배열형 메시지
- 규칙과 함께 저장·재시작 후 유지, 잘못된 저장값 무시
- 예산 비교와 덮어쓰기 거절, 패널의 적용·다른 플러그인 반영·두 번 확인
- LIBRA 실제 요청 훅: 겹친 줄만 빠지고 비슷한 다른 줄은 남음, 예산을 켜면 블록이 줄고 끄면 원래대로
- Flashback 실제 요청 훅: 일부만 겹치면 남기고 대부분 겹치면 뺌, 몫이 800자 미만이면 기억 없음
- HAYAKU 실제 요청 훅: 겹친 리콜 항목을 빼고 장면 상태는 유지, 몫이 회상 상한이 됨

실제 RisuAI 화면과 실제 모델 응답에서는 확인하지 않았다.
