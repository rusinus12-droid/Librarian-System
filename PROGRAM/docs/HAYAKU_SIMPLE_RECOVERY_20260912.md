# HAYAKU 3.0.85 누락 기억 생성 흐름

## 변경

- afterRequest의 1회 Other Ax 복구와 성공 응답의 채팅 패킷 삽입·정규 캡처 경로를 유지한다.
- 1차 실패 기록이 사용자 확인창을 우회하지 않는다. 확인창은 기억 생성 / 나중에를 제공하고 추가 AI 비용을 안내한다. 기존의 턴별 결정·표시 기록을 유지해 반복 질문을 막는다.
- 승인 또는 수동 누락 복구는 원문에서 새로 생성한다. 이전 실패 응답과 그 전체 진단을 요청에 다시 넣지 않는다. 기존 유효한 후보의 저장 재시도 경로는 유지한다.
- 실패 결과를 대상으로 하는 자동 유료 재분석과 타이머를 비활성화했다. 기존 retry_once 설정도 실행되지 않으며 관련 설정 컨트롤은 제거했다.
- 실패 복구 화면과 후보 채택·편집·추가 분석 동작을 폐기했다. 외부 호환 API의 기존 해결 요청은 폐기 사유를 반환하며 AI를 호출하거나 데이터를 변경하지 않는다.
- 실패 기록은 삭제하지 않는다. 작동 로그에서 최근 10개 원문·진단을 읽기 전용으로 불러올 수 있고, 기존 읽기 API도 유지한다.
- 실패 기록과 연결된 턴도 일반 누락 복구 대상에 남는다. 명시적으로 승인한 재생성은 기존 실패 상태 때문에 차단되지 않는다.
- 원문·세계선 재검증, 저장 읽기 검증, 복구된 턴의 중복 생성 방지, 콜드스타트의 정상 체크포인트 재사용은 유지한다. 서버 저장 경로는 기존 저장 모드 정책을 따른다.

## 감사와 검증

관련 테스트 파일 15개 통과: simple_recovery, after_request_recovery_journal, native_otherax_recovery, cold_start_batch, failed_analysis_vault, record_admission, native_targeted_regeneration, native_repair_worldline_race, review_hardening, failed_auto_recovery, failed_analysis_resolution, failed_recovery_ui_contract, settings_gui_transaction, storage_eventual_confirmation, storage_reconciliation_journal_fault.

기존 자동 재분석·후보 해결·실패 화면 테스트는 폐기된 동작의 성공을 기대하지 않고, 새 비활성화 계약을 검증하도록 갱신했다. 기존 테스트 원본은 작업 폴더의 _backups/pre-retirement-*에 보존했다. 누락 턴이 실패 큐에 숨겨져야 한다는 예전 기대값도 일반 복구 가능 상태로 갱신했다.

새 런타임 테스트는 legacy retry_once 설정, 첫 생성 실패, 진단의 durable 재조회, 폐기 API의 호출 차단, 일반 누락 목록 노출, 실패 원문이 포함되지 않은 새 생성, 실제 모의 원장 채택, 기존 진단 보존, 완료 턴 중복 호출 차단을 검증한다. afterRequest 확인 경로 테스트도 legacy retry_once 설정으로 실행했다.

JavaScript 구문·SDK 동기화 및 패키지 해시를 별도 검사한다. 실제 RisuAI UI의 확인창 표시 및 제공자 호출, 운영 비용·성공률은 검증하지 않았다. 전체 프로젝트 회귀 테스트를 모두 실행한 것은 아니다.
