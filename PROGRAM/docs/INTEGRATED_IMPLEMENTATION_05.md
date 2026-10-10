# 5차 구현 노트

MemorySuite 0.3.31 / LIBRA 2.3.38. 기준 4차 0.3.30/2.3.37.

이번 코드는 기존 native/RE:TRACE/portable 경로를 대체하지 않고 v4 approved evidence와 correction cursor를 연결한다. legacy prefix는 명시 승인 후 원문 그대로 읽되 과거 상태를 재구성한 것으로 취급하지 않는다. 현재 이름·별칭·병합은 정본 불변의 저널 교정이며 다음 분석 Registry에도 연결된다. 응답 요청은 값 전용 ResponseContext를 통해 같은 canonical/worldline 기준을 읽는다.

기존 HAYAKU/Flashback/LIA/RE:TRACE 본체, 공통 SDK 소스, GRADIA 문장 patch 본류, Provider와 사용자 DATA는 변경하지 않는다. server.cjs 변경은 SERVER_VERSION뿐이다. 인계·범위는 INTEGRATED_IMPLEMENTATION_PLAN.md, 설계 현행 상태는 INTEGRATED_DESIGN_v1_3_STATUS.md, 의미 평가 추적은 WM_ACCEPTANCE_05.md를 따른다.

전체 회귀와 신규 VM/Chromium 검사는 배포 제품 JS를 실행하지만 외부 host/model/storage를 통제한다. 실제 RisuAI 설치·외부 모델 의미 정확도/비용/지연의 증명이 아니다. 최종 수치와 ZIP hash, 중간 실패·수정 기록은 외부 5차 보고서와 증거 ZIP에 제공한다.

## 사용자 동작

네이티브 브랜치는 기존 호스트의 별도 채팅 복사/분기를 사용한다. 분기점이 T7이면 완료된 T1–5 정본만 승계하며 T6–10 전체를 끌어오지 않는다. RE:TRACE/portable은 기존 실행 화면을 사용한다. source evidence가 없거나 변조되면 자동 성공 처리하지 않는다.

구형 세션은 기억 분석 설정의 “기존 기억 보존 전환”에서 범위를 확인한다. 이것은 engine 설정을 몰래 변경하지 않으며 이후 통합 엔진을 명시 선택해야 한다. 예전 기억은 조회되지만 current State에는 미해석 과거가 있음을 표시한다.

인물/세계 프로필의 수정에서 이름·별칭을 교정한다. “동일 항목 병합”에서는 남길 대상을 선택하고 모든 충돌을 확인한 뒤 확정한다. 새 세션 T0에서도 승계된 exact canonical cursor에 사용자 교정을 결속한다. 병합을 중지하면 원래 정본을 다시 재생하지만 임의 split 도구는 아니다.

월드 매니저 rollback은 플러그인의 현재 참고 범위를 되감는 기능이다. RisuAI에 이미 있는 메시지를 삭제하거나 호스트 대화를 되돌리지 않는다. rollback된 view를 새 세션으로 넘기려면 실제 native prefix 사본을 만들거나 main을 명시 reopen한다.

기존 DATA/설정은 백업 후 보존한다. 새 배포의 DATA는 빈 기본 틀이며 기존 DATA 위에 덮지 않는다. 실사용 원본이 아닌 분리 검증 세션에서 설치 경로를 확인한다.

## 추가 작성 경로 회귀

진행 UI가 core 내부 `sgaEnabledStageOrder`를 참조하던 lexical scope 결함을 고쳤다. 같은 순서 helper를 공용 범위에 두며 두 번째 실행 정책을 만들지 않는다. 실제 GRADIA 4 stage/Planner 정상 출력과 실행 중 원문 변경 거절을 새 ResponseContext 검사에 포함했다. 기존 문장 패치 함수는 변경하지 않았다.
