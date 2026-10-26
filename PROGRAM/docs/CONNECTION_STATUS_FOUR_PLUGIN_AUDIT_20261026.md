# 연결 상태 표시: LIBRA·Flashback·GRADIA·RE:TRACE 점검

하야쿠에서 확인한 “같은 대화와 서버를 다시 확인할 때 직전 표시를 지우는 문제”가 다른 플러그인에도 있는지 조사했다. 작업 기준은 기존 조사 브랜치의 `9948026`이다. 실제 사용자 설치본의 네트워크를 모니터링한 결과가 아니라 코드와 제어된 재현 테스트에 대한 결과다.

| 플러그인 | 조사 결과 | 조치 |
| --- | --- | --- |
| LIBRA | `syncBookCurrentStatus`가 갱신마다 저장 상태를 `확인 중`으로 되돌렸다. 오류 응답에는 성공 응답과 달리 현재 대화 확인도 빠져 있었다. | 같은 화면·열기 세대·스코프·서버 바인딩에서는 직전 표시를 유지한다. 대화가 바뀌거나 화면이 닫힌 뒤의 응답은 무시하고, 무효화된 연결 검사를 접속 실패로 표시하지 않는다. 실제 현재 오류는 경고로 표시한다. |
| Flashback | HAYAKU와 같은 공통 상태 표시 코드를 사용하므로 기존 설치 코드에 같은 문제가 있었다. | 앞선 `57ff68e`에서 공통 원본과 Flashback 삽입본에 이미 수정했다. 이번에는 동기화와 회귀 테스트로 확인했다. |
| GRADIA | 실제 읽기 연결의 `inspect()`는 확인 중 기존 `connected` 상태를 지우지 않는다. 새 연결 시도에서만 `connecting`으로 바뀐다. | 느린 상태 확인에서도 연결 카드가 유지되고 bootstrap이 추가되지 않는 테스트를 보강했다. 제품 코드는 변경하지 않았다. |
| RE:TRACE | 서버 관리 갱신 중 기존 status를 유지하고 loading을 별도로 표시한다. 최신 요청 토큰·화면·호스트·서버 세대를 확인한 뒤 결과를 게시한다. | 대기 중 결과 유지와 실제 실패 시 기존 성공 제거를 기존 현재성 테스트에 추가했다. 제품 코드는 변경하지 않았다. |

GRADIA의 `connected`는 기억 읽기 연결 상태다. 네이티브 채팅, 주소, 권한이 달라지거나 연결 요청이 실제 실패하면 연결을 해제한다. 이 동작은 하야쿠에서 고친 단순 화면 갱신 깜빡임과 구별해야 한다. RE:TRACE의 owner 저장 상태와 서버 관리 화면 역시 각각 owner 응답과 서버 조회 결과를 표시한다.

## LIBRA 수정의 범위

- 같은 표시 문맥에서는 저장 모드나 오류 경고를 임시 `확인 중`으로 덮지 않는다.
- 새 화면·새 대화·새 서버 바인딩에는 이전 표시를 넘겨 쓰지 않는다.
- 성공과 실패 모두 요청 순서·화면 열기 세대·현재 대화·화면 표시 여부를 확인한다.
- `MEMORY_SUITE_CONNECTION_STALE`은 무효화된 검사이므로 기존 결과를 접속 실패로 바꾸지 않는다.
- 실제 서버 사용 불가, 저장 방식 변경 및 전환 필요 상태는 계속 표시한다.
- LIBRA의 `서버 모드` 표시는 적용된 저장 방식이다. 새 서버 통신이 성공했다는 의미로 바꾸지 않았다.

## 검증

`NODE_PATH=/workspace/librarian-cloud/dependencies/node_modules`를 사용해 아래 12개 파일을 실행했고 모두 통과했다.

- `libra_current_status_refresh_runtime_test.cjs`: 스코프/전역 상태 유지, 오래된 성공/실패, 무효화된 검사, 실제 실패, 대화/화면 변경. 수정 전에는 같은 문맥의 상태 유지 검증이 실패했다.
- `libra_server_availability_gui_runtime_test.cjs`: 실제 GUI 오류 경고·복구·명시적 검사 경로.
- `current_status_gui_runtime_test.cjs`: 공통 상태 표시 및 실제 HAYAKU·Flashback·LIBRA GUI, 12개.
- `sdk_probe_status_publication_client_test.cjs`: 표준/LIBRA SDK의 늦은 검사와 실제 실패, 16개.
- `sdk_probe_ui_currentness_client_test.cjs`: 검사 중 URL·모드·화면·연결 변경과 최신 결과 보존, 56개.
- `gradia_three_owner_connection_test.cjs`: 실제 GRADIA 연결 UI와 세 owner 조합, 7개.
- `gradia/readonly-connection.test.cjs`: 연결·재확인·실패·주소/권한/대화 변경과 느린 확인 시 상태 유지, 28개. 임시 localhost 서버와 SQLite를 사용한다.
- `retrace_server_control_currentness_test.cjs`: 늦은 서버 조회, 호스트/서버 변경, 갱신 중 표시 유지, 실제 실패.
- `retrace_server_control_render_test.cjs`, `retrace_server_control_flow_test.cjs`: 상태 화면의 경고·실패·기존 상태 제거 및 렌더링.
- `retrace_diagnostics_storage_gate_freshness_gui_test.cjs`: 마지막 점검 대화 명시, 대화 변경, 이미 로딩 중인 owner 결과 재사용 거부.
- `retrace_storage_recovery_ui_contract_test.cjs`: owner 응답 시간 초과·미설치·복구 필요·오류 표시.

SDK 삽입본 동기화, LIBRA 구문 검사, `git diff --check`도 통과했다. 이 점검으로 실제 사용 환경의 간헐적 네트워크 단절이 모두 해결됐거나 발생하지 않는다고 판단하지 않는다. 배포와 설치본 적용은 포함하지 않는다.
