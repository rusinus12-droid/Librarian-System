# HAYAKU · Flashback 현재 상태창

HAYAKU 3.3.7 / Flashback 1.3.7의 상태창은 LIBRA처럼 왼쪽 사이드바 하단에 배치된다. 접기 없이 항상 펼쳐지고 본문 위에 겹치지 않는다. 좁은 화면은 기존 GUI의 사이드바 숨김 규칙을 따른다.

- 공통: 저장 모드, 서버 연결 상태, 이전 미완료·서버 초기화/복원 확인 필요 안내. 저장 행을 누르면 서버 설정으로 이동한다.
- HAYAKU: 적용된 동작 모드 → 설정, Other Ax 실제 테스트 상태 → 관제 화면의 테스트 영역. API 사용 가능만으로 테스트 성공을 표시하지 않는다.
- Flashback: 적용된 리콜 품질 → 리콜 설정, 임베딩 provider·모델/설정 필요 여부 → 임베딩 설정. 모델 설정 표시가 모델 접속 테스트 성공을 의미하지 않는다.
- 저장하지 않은 편집값은 현재 상태에 반영하지 않는다.
- 서버 연결 확인은 읽기 목적의 SDK probe를 사용하며 모델 호출·저장 모드 변경·초기화 승인·자료 이동을 시작하지 않는다. 플러그인 단독 모드는 서버 probe를 하지 않는다.
- 화면이 열려 있을 때 15초 간격으로 다시 확인한다. 최근 연결 검사 결과를 재사용하고, 반복 렌더의 동시 요청을 합친다. '상태 다시 확인'은 새 검사를 요청한다.
- 채팅·저장 모드·주소 변경, 닫기/재열기 후 이전 요청이 늦게 도착해도 현재 표시를 덮어쓰지 않는다. SDK가 무효화한 검사 결과를 서버 미실행으로 오인하지 않는다. 화면을 닫거나 플러그인을 해제하면 타이머와 구독을 정리한다.

공통 구현은 `PROGRAM/tools/memory_suite_current_status.cjs`, 동기화는 `node PROGRAM/tools/sync_current_status.cjs`다. SDK 동기화 검사에서 두 플러그인의 내장 코드 일치를 확인한다.

검증: `PROGRAM/tests/current_status_gui_runtime_test.cjs`의 상태·경합·닫기·실제 GUI 바로가기·미저장 초안 분리 검사 및 LIBRA 디자인 검사 10개 통과. 기존 HAYAKU 설정/패킷/작업공간 및 Flashback GUI 계약, 버전 provenance 검사도 통과했다. 두 플러그인의 release Min 빌드와 Min GUI 검사도 통과했다. 실제 RisuAI 호스트의 시각적 배치 검증이나 실모델 연결 검증은 이 검사에 포함하지 않는다.

검증 로그는 `/tmp/current-status-full-tests.log`, `/tmp/current-status-regression.log`, `/tmp/current-status-min-tests.log`, `/tmp/current-status-final-{hayaku,flashback}.log`에 기록했다. 플러그인별 과거 크기 기준 초과는 빌더의 보고용 경고이며 아티팩트 생성·구문 검사에는 통과했다. LIB 0.5.0 정식 패키지 릴리즈의 기존 실패 2건은 이 UI 변경으로 수정하지 않았다.

LIBRA 2.6.7도 같은 고정 상태창의 간격·테두리·경고 배경·상태 다시 확인 버튼으로 맞췄다. 기존 분석·검색 상태와 설정 바로가기 동작은 유지한다.
