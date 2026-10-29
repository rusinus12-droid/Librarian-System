# 리콜·자동 후처리·GRADIA 예산 패치 — 2026-10-30

## 범위와 근거

10월 29일 15:33 UTC 요청의 LIBRA/HAYAKU/Flashback 디버그와 콘솔 및 GRADIA 설정을 근거로 수정했다. 사용자 DATA와 실행 중인 RisuAI 프리셋은 변경하지 않았다. 이전 Flashback 유지보수 패치는 보존했다.

## 변경과 실제 연결

- **GRADIA**: `deepseek-v4.1-flash:1017-cloud` 및 같은 V4.1 Flash 계열을 64k 대신 1M 문맥으로 추정한다. 수동/카탈로그 문맥 설정은 우선한다. 사용자 설정의 출력 16,384토큰과 20,039자 Skill이 이제 24,000자 상한 안에 들어간다. Input Assist의 참고자료 선택과 최종 프롬프트 조립이 단계 `max_chars`를 사용한다. 12,000자 설정에서 8,800자 이상의 로어북 항목 끝까지 전달되고, 6,000자로 줄이면 제외되는 것을 확인했다. 근거: https://ollama.com/library/deepseek-v4.1-flash:1017-cloud
- **HAYAKU**: 원문과 세계선을 확인해 요청 계보를 만들면, 리콜 저장소 publication 전에 복구용 capture를 등록한다. 이후 readset 검증 거부가 나더라도 기존 afterRequest의 단일 otherAX 복구 기회가 남는다. 복구 전후 이전 대화 prefix와 사용자 메시지 식별자를 확인한다. 원문이 바뀌면 호출하지 않고, 반복 afterRequest도 재전송하지 않는다. 읽기 검증 실패에 세부 `authorityFailure`를 기록한다. 백그라운드 유료 복구는 활성화하지 않았다.
- **LIBRA 모드 검증**: 일시적인 `unsettled`/`conflict`만 최대 두 번 재관찰한다(40/80ms 대기). 스코프/서버 권한 경계를 넘지 않으며 여전히 안정되지 않거나 malformed/mismatch인 정보는 거부한다. 진단에 게시 상태와 시도 횟수를 남긴다. SDK 원본과 LIBRA 내장본이 일치한다.
- **LIBRA 자동 Micro**: 새 회귀에서 대체 스캔으로 원문은 저장되지만 최초 Micro 작업 예약이 없어 `micro_work_missing`으로 끝나는 경로를 재현했다. beforeRequest에서 저장한 새 사용자 입력과 이전 완료 대화의 해시, main afterRequest 응답 해시가 현재 완료 턴과 일치할 때만 새 receipt에 최초 작업을 예약한다. 기존 receipt의 잃어버린 작업 기록을 복원하거나 과거 불명 시도를 재전송하지 않는다. 출력 이벤트와 별도로 main completion을 동기화하고, 늦은 호스트 저장에는 한 번 더 확인한다. 보조 요청은 main 완료 증거를 덮어쓰지 않는다. 스코프 삭제는 대기 중인 완료 확인을 무효화한다. 이 경로는 검증 가능한 새 append 턴을 대상으로 하며, 출처를 입증하지 못하는 reroll/이전 런타임 작업에 자동 호출 권한을 추가하지 않는다.
- **LIBRA 지연**: 미수신 출력 이벤트의 전환 대기를 30초에서 5초로 줄였다. 이미 저장된 Micro의 선택적 벡터 준비가 다음 분석을 막는 대기를 최대 15초에서 1초로 줄였다. 채팅별 분석 직렬화와 provider 실행 기록은 유지한다.
- **Flashback**: beforeRequest 세계선 동기화의 분할 저장소를 최대 네 개씩 읽는다. 원문/벡터 검증과 순서는 유지한다. lock 진입·각 읽기·저장 경계에서 준비 제한 시간을 확인해, 시간 초과 후 늦게 끝난 준비 작업이 계속 저장하지 않게 한다. 실패 진단에 manifest/lock/records/worldline 단계의 진행·소요 시간을 보존한다.

## 검증과 한계

회귀 테스트는 실제 프로덕션 함수/훅과 통제된 호스트·모델 경계를 실행한다. HAYAKU는 실제 ledger 쓰기 도중 읽기 권한을 바꿔 리콜 거부와 응답 후 단일 복구를 확인했다. LIBRA는 임시 HTTP/SQLite 서버에서 원문·Micro를 재조회했다. 늦은 호스트 저장, 보조 요청 끼어들기, 후속 legacy 턴, 요청 후 사용자 편집을 확인했다. Flashback은 다섯 분할 이상의 원문/벡터 결과가 직렬 읽기와 동일하고, 취소 후 다음 읽기 묶음을 시작하지 않는지 확인했다.

초기 관련 11개 테스트 파일에서 106건이 통과했다. LIBRA의 추가 검증 결과는 작업 로그 `.test-output-libra-final-regression.log`와 `.test-output-libra-three-mode-completion.log`에 있다. `libra_capture_durable_priority_test.cjs`의 대기열 포화 1건과 `libra_micro_stage_retry_test.cjs` 내부 30건 중 24건은 폐기된 `resumeNeverStartedMicro`/재시도 API를 호출해 `LIBRA_REANALYSIS_ENTRY_RETIRED`로 실패한다. 수정 전 HEAD 파일에서도 같은 25건이 실패하고, Micro 파일은 양쪽 모두 6/30 통과로 일치했다. 해당 폐기 API를 다시 활성화하거나 테스트를 약화하지 않았다.

실제 RisuAI GUI/제공자 호출/사용자 장치 성능은 재실행하지 않았다. 과거 로그의 LIBRA 게시 불일치 세부 유형과 HAYAKU readset의 정확한 변경 항목은 아직 확정할 수 없다. 이번 패치는 재현한 자동 처리 단절을 고치고, 지속되는 권한 문제는 우회하지 않고 세부 사유를 기록한다.

재현 파일:
- `PROGRAM/tests/gradia/model-context-heuristic.test.cjs`
- `PROGRAM/tests/gradia/input-assist-reference-cap.test.cjs`
- `PROGRAM/tests/hayaku_after_request_recovery_journal_runtime_test.cjs`
- `PROGRAM/tests/libra_read_context_basic.test.cjs`
- `PROGRAM/tests/libra_capture_lifecycle_accuracy_test.cjs`
- `PROGRAM/tests/flashback_worldline_preparation_reads_test.cjs`
