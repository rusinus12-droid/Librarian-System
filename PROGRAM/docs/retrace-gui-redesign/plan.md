# RE:TRACE GUI 재설계 구현 계획

## 현재 문제

- `RETRACE.js`의 기존 UI는 `renderShell()` 한 함수가 탭 이동마다 전체 DOM을 다시 생성한다. 이 때문에 스크롤, 포커스, 지연 조회 상태가 사라지고 서버 데이터처럼 큰 패널도 불필요하게 재구성된다.
- 탐색 구조가 다음 세션과 Owner별 데이터 뷰어 중심이라, 사용자가 처음 열었을 때 호환성·저장 Gate·현재 스코프 상태를 한 화면에서 파악하기 어렵다.
- 모바일에서는 세로 아이콘 레일만 남아 현재 스코프와 메뉴 의미가 사라진다.
- 실제 서버 상태는 네 Owner의 IPC와 서버 integrity 결과에서만 판정해야 한다. GUI가 임의의 연결 수치나 정상 상태를 만들면 안 된다.

## 앞선 논의와 고정 경계

- `RETRACE_GUI_UX_Prototype.html`을 Flashback GUI의 정보 구조와 상호작용 패턴을 참고한 시각 본보기로 사용한다.
- RE:TRACE는 호환성 허브와 읽기 전용 뷰어, 다음 세션 승계, 서버 데이터 관리만 맡는다.
- LIBRA·HAYAKU·Flashback·LIA의 정본 소유권, Owner IPC allowlist, handoff prepare/adopt/verify, fail-closed 저장 Gate, 서버 삭제 증명 절차는 변경하지 않는다.
- LIA는 별도 데이터 뷰어를 만들지 않고 호환성 및 저장 상태 참여자로만 표시한다.
- 서버 상태는 `refreshMemorySuiteOwnerStorageDashboard()`와 기존 서버 scope manager의 실제 결과만 표시한다. 정적 샘플 수치나 가짜 성공 상태는 넣지 않는다.

## 수정 순서

1. GUI 탭 메타데이터와 기본 `overview` 탭을 추가한다.
2. 기존 패널 DOM을 유지한 채 `hidden`, `aria-selected`, `tabindex`만 갱신하는 부분 탭 전환을 도입한다.
3. 실제 `inspectTransition()`, 호환성 검사, Owner 저장 상태 결과를 조합한 개요 화면을 추가한다.
4. 민감 원문을 표시하지 않는 IPC/진단 요약과 기존 프라이버시 안전 디버그 내보내기를 진단 탭에 배치한다.
5. 키보드 방향키/Home/End, `role=tablist/tab/tabpanel`, `:focus-visible`과 모바일 가로 탐색을 추가한다.
6. RE:TRACE 버전·매니페스트·계약 테스트·체크섬을 동기화한다.

## 검증 기준

- 탭 클릭이 `renderShell()`을 다시 호출하지 않고 기존 패널 노드와 스크롤을 보존한다.
- 개요 새로고침은 토큰으로 오래된 비동기 응답을 폐기하며, 서버 스코프 전체 스캔을 자동 실행하지 않는다.
- 개요 및 저장 상태는 실제 Owner IPC 응답만 사용하고, 미설치·미응답 Owner를 성공으로 표현하지 않는다.
- provider 설정/자격 증명 UI와 LIA 데이터 뷰어가 다시 생기지 않는다.
- 기존 다음 세션, 세 Owner 뷰어, 서버 데이터 관리, 저장 상태, 디버그 내보내기 버튼 ID와 이벤트 계약을 유지한다.
- RE:TRACE 대상 테스트와 전체 회귀 테스트가 통과하고, 배포 매니페스트·SHA-256 목록이 실제 파일과 일치한다.
- 자동 테스트는 정적/모의 호스트 계약만 증명한다. 실제 RisuAI GUI, 라이브 Owner IPC, 서버 연결·삭제 동작은 별도 수동 검증으로 남긴다.

## 수정 전 기준

- `MemorySuite/PROGRAM/plugins/RETRACE.js` SHA-256: `57C908799298174E773D6A9CB2494F9AD476F562D77BECCDEDBCC8E711AC4B51`
- `MemorySuite/PROGRAM/docs/RETRACE_GUI_UX_Prototype.html` SHA-256: `FC00D117A35C889410F58442929F271CDAE16B30475BB90BCBBBCB3B4752BE40`

## 구현 결과

- RE:TRACE 1.9.65에 기본 `개요`, 기존 다음 세션·세 Owner 뷰어, 서버 데이터·저장 상태, 새 `연결 진단`을 포함한 8개 탭 작업 공간을 반영했다.
- 탭 전환은 셸을 다시 만들지 않고 기존 panel의 `hidden`과 ARIA 상태만 바꾼다.
- 개요는 `inspectTransition()`, `inspectCompatibilitySuite()`, `refreshMemorySuiteOwnerStorageDashboard()`를 사용하며 서버 inventory opt-in은 호출하지 않는다.
- 좁은 화면에서는 레이블이 보이는 가로 탐색을 사용하고 방향키·Home·End 이동과 `focus-visible`을 제공한다.
- 실제 Owner/storage/handoff/server deletion 구현은 변경하지 않았다.

## 자동 검증 결과

- `node --check RETRACE.js`: PASS
- RE:TRACE 대상 계약·동작 테스트 11개: 11 PASS
- `retrace_gui_ux_contract_test.cjs`: PASS
- `program_data_layout_test.cjs`: PASS
- 매니페스트와 `SHA256SUMS.txt`의 RE:TRACE SHA-256 readback: 일치
- 전체 181개 회귀 실행 시 162 PASS, 19 FAIL, 0 TIMEOUT이었다. 실행 도중 별도 HAYAKU GUI 작업이 소스를 3.0.25에서 3.0.26으로 바꾸어 18개가 HAYAKU 버전/구 GUI 계약 불일치로 실패했고, 1개는 변경 중 스냅샷의 manifest hash 불일치였다. 마지막 항목은 매니페스트 재생성 후 단독 PASS를 확인했다. HAYAKU 파일과 그 테스트는 이 작업에서 수정하지 않았다.
- 실제 RisuAI fullscreen 렌더, 라이브 Owner IPC, 라이브 Librarian System 서버 연결·삭제는 수행하지 않았다.
