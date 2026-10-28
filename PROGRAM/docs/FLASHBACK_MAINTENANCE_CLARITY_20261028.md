# Flashback 점검·복구 설명 정합성 개선

작업 브랜치: `codex/flashback-maintenance-clarity` (local main 기준).

상단 **상태 점검 및 자동 복구** 주 버튼 → 읽기 전용 점검 → 진단 팝업에서 복구 실행을 선택하는 흐름을 유지한다. 기존 별도 브랜치 전체를 병합하지 않고 결과 표시 개선만 다시 구현했다.

- 오래된 ‘상태만 진단’ 안내를 실제 진입점 명칭으로 교체한다.
- 결과 요약·배지와 문제 수치 강조를 추가한다. 승인·실행 단계를 점검만으로 완료 처리하지 않는다.
- 항목명과 값을 함께 구성해 재임베딩 상태 이후의 상세 제목이 밀리지 않도록 한다. 표시 문장을 해석하는 정규식은 사용하지 않는다.
- 예정 작업·호출·자격·저장 모드는 펼쳐 보여주고 긴 기술 정보만 접는다. 추가 복구 주 버튼은 만들지 않는다.
- 점검 호출과 복구 호출을 구분하며 서버 복구 비용을 0원으로 단정하지 않는다. 미검증 자격을 확인됨으로 표시하지 않는다.
- 계획 카드와 진단 팝업은 생산된 계획의 healthy·complete·blocked·strategy를 따른다. 누락 턴 0만으로 정상 판정을 추정하지 않는다. 미완료 서버 점검 수치는 0 대신 미확인으로 표시한다.
- 점검 결과 내부에 20px 간격을 두고 수동 작업 선택·실행을 별도 카드로 분리한다. 수동 실행 버튼은 보조 버튼 스타일과 12px 간격을 사용해 상단 통합 버튼의 위계를 유지한다.
- 수동 아카이브 작업의 버튼·확인창·진행·결과 명칭을 ‘이전 세션 응답 벡터 복구’로 맞춘다.
- 복구 엔진·저장·큐·실시간 작업창 실행 함수는 변경하지 않는다.

## 검증 범위

합성 저장소/제공자를 이용한 집중 검증 18개:

- `flashback_maintenance_plan_presentation_test.cjs`: 4개. 실제 표시 함수의 항목 정렬, 주 버튼 유지, 미완료/차단/임베딩 상태, 허용된 진단 액션.
- `flashback_maintenance_live_job_gui_test.cjs`: 6개. 등록된 DOM 이벤트로 점검·복구·실패·중지·최소화·종료와 저장 결과 확인.
- `flashback_maintenance_live_job_server_gui_test.cjs`: 2개. 로컬 테스트 서버에서 서버 누락 턴 동기화와 대기 임베딩 복구 후 저장 재조회.
- `flashback_maintenance_queue_inspection_runtime_test.cjs`: 2개. 서버/로컬에서 진행 중 요청을 기다린 뒤 점검하고 큐를 재개.
- `flashback_maintenance_pending_embedding_test.cjs`: 3개. 미완료 상태 판정과 큐 복구.
- `flashback_maintenance_readonly_inspection_test.cjs`: 1개. 점검 중 쓰기·네트워크 호출 없음.

Chromium에서 실제 생산 렌더러의 합성 상태를 PC·390px 모바일로 렌더링했다. 모바일 계획 카드의 clientWidth/scrollWidth는 모두 271px, 본문 폭은 뷰포트와 같은 390px이다. 캡처용 PC 프레임 높이만 늘렸다.

`flashback_maintenance_outcome_gui_runtime_test.cjs`는 3개 중 1개 통과, 2개 실패했다. 변경 전 main 소스를 별도로 읽어 같은 테스트를 실행해도 동일한 위치와 값(대화창 수 0/2, healthy undefined/true)으로 실패했다. 기존 검증 결손으로 남기며 이번 변경의 통과 근거로 계산하지 않는다.

서버 테스트는 샌드박스 임시 파일 rename EPERM 발생 후 권한 제한 밖에서 재실행해 통과했다. 외부 제공자 요청은 하지 않았다. 실제 RisuAI 호스트, 실제 모델 사용량·과금, 전체 회귀 및 배포 검증은 수행하지 않았다.

무관한 파일의 기존 메타데이터 차이를 포함하지 않도록 이번 변경 파일의 manifest/checksum 항목만 갱신한다.
