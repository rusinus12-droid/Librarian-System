# Flashback 1.0.62 — 고정 프레임 및 보관함 내부 탭

필름 보관함의 응답 원문과 스코프 관리를 별도의 내부 탭으로 분리했다. 한 번에 한 패널만 표시하며 원문 열기/편집 컨트롤과 스코프 삭제/검사 컨트롤을 각 패널에 배치했다. 외부 화면의 원문 보기 동작은 보관함의 응답 원문 탭으로 이동한다. 내부 탭 선택은 현재 GUI 실행 중 유지하고 키보드 좌우/Home/End 탐색과 ARIA 선택 상태를 제공한다.

창은 1180×790을 기준으로 viewport에서 24px 여백을 제외한 범위로만 축소한다. 높이 계산을 부모의 불확정 100%에서 viewport 기준으로 변경하고, 내부 grid/flex의 최소 크기와 스크롤 경계를 지정했다. 현상 기록과 고급 설정을 포함한 모든 화면은 동일한 외부 프레임을 공유한다. 긴 내용은 패널 내부에서 스크롤한다.

실제 소스 렌더러에 가상 데이터를 넣은 브라우저 측정:

| 환경 | 응답 원문 | 스코프 관리 | 현상 기록 | 고급 설정 |
|---|---|---|---|---|
| 1280×900 viewport | 1180×790 | 1180×790 | 1180×790 | 1180×790 |
| 390×844 viewport | 366×790 | 366×790 | 366×790 | 366×790 |

관련 테스트 13개 통과. 신규 flashback_storage_subtabs_runtime_test는 배타적 표시, ARIA, 탭 상태, 원문 진입 연결 및 원문/스코프 컨트롤 분리를 검사한다. 기존 전체 tabpanel 개수 기대값은 주 화면 8개 + 내부 패널 2개로 갱신했다. RisuAI 실제 호스트 재검증은 수행하지 않았다.

작업공간 design_samples/continuity-recall/implemented/의 fixed-frame-scopes.jpg, fixed-frame-logs.jpg, fixed-frame-advanced.jpg 및 fixed-frame-tests.json에 검증 자료를 저장했다. 이전 버전은 _backups/flashback-fixed-frame-20260912/에 보존했다.
