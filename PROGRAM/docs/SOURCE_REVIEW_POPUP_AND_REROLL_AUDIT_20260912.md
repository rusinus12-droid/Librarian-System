# 원문 수정 확인창과 리롤 감사

## 확인

LIBRA/HAYAKU/Flashback은 각각 config.prompt를 통해 자기 iframe의 showMemorySuiteSourceReview를 실행한다. 동의 SDK의 ask 함수는 custom prompt를 먼저 호출하므로 그 뒤 SafeDOM fallback의 root marker 직렬화는 이 경로에 적용되지 않는다. source_edit_multi_owner_dialog_test는 fallback만 시험한다. 이 시험 통과로 현재 세 iframe의 동시 팝업을 방지한다고 볼 수 없다.

세 창은 각기 다른 저장소의 갱신 승인을 요청한다. Flashback은 해당 원문을 교체 저장하고 임베딩 갱신을 예약한다. LIBRA/HAYAKU 기억 분석과 동일한 작업 세 번이라는 뜻은 아니다. 이번 감사에서는 실제 모델 호출 중복이나 비용을 측정하지 않았다.

리롤은 현재도 별도로 구현되어 있다. Flashback의 pending.mode=reroll 및 finalize/reconcile, HAYAKU의 reroll/unreroll/rollback 세계선 조정, LIBRA의 reroll/branch digest 변경에 따른 in-flight 무효화가 남아 있다. 원문 수정 동의는 기존 기억과 현재 본문 간 차이를 처리하는 별도 계층이다. Flashback beforeRequest는 수정 감지 후 finalized capture reconciliation을 실행하므로, 리롤과 원문 수정의 경합 가능성을 검토해야 한다. 첨부 화면만으로 해당 변경이 수동 편집인지 리롤인지 확정할 수 없다.

## 권장 통합 방식 — 이번에는 미구현

- 공통 관리창에서 변경 턴을 한 번 보여 주고 플러그인별 수행 작업·진행·오류를 나눈다.
- 동일 범위/원문 revision의 변경 알림만 묶는다. 각 플러그인의 승인 fingerprint와 쓰기 권한, 원문 재확인, 저장 재조회는 유지한다.
- 기존 리롤 finalize가 진행 중이면 판정을 보류하고, 완료 후 최신 저장 내용으로 다시 비교한다. 이미 반영된 revision은 재분석하지 않는다.
- 팝업 직렬화만으로는 서로 다른 엔진의 연산을 줄이지 못한다. 확인 UI의 중복과 동일 엔진의 동일 revision 중복 실행을 구분해 막아야 한다.

## 적용한 GUI 수정

Flashback 1.0.63: 현재 vrmDesign 팔레트에 맞춰 원문 확인창을 크림색/짙은 갈색 텍스트/벽돌색 강조로 변경. 안정된 최대 창 높이, 스크롤 본문, 브랜드 표기와 '수정된 원문을 확인해 주세요' 제목 적용. 비교/선택/동의 동작은 유지.

공통 SourceReview 원본을 수정하고 세 내장본을 동기화했다. Flashback 전용 theme 조건이므로 다른 두 플러그인의 외관은 그대로다.

source_review_consent_v12 15개, source_edit_multi_owner_dialog 2개 통과. 후자는 fallback 검증에 한정된다. 실제 RisuAI 화면 시각 검증과 세 iframe 통합 팝업 검증은 미수행.
