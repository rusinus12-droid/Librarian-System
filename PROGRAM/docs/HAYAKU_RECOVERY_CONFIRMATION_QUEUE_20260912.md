# HAYAKU 3.0.107 복구 승인 대기 보완

- 채팅 저장·결속, 복구, 콜드스타트, 다른 승인창이 진행 중이면 승인 요청을 유지하고 1초 간격으로 작업 종료를 확인한다. 기존 약 15초 제한을 제거했다.
- 스코프와 누락 기록 ID로 중복 예약을 막는다. 승인 요청의 원문 재조회 중 다른 작업이 시작된 경우에도 대기를 이어간다.
- 대기 타이머는 모델을 호출하지 않는다. 기존 승인·최신 원문·누락 여부 검증을 통과해야 복구를 실행한다. UI 표시 불가나 처리할 대상 없음은 반복 호출하지 않는다.
- 백그라운드 설정 해제, 런타임 소유권 상실, 플러그인 종료 시 대기를 해제한다.
- `준비됨`을 `호출 가능 · 모델 연결 미확인`으로 변경했다.

검증: recovery_confirmation_queue, after_request_recovery_journal_runtime, common_admission_runtime, native_otherax_recovery_contract, native_otherax_recovery_runtime, recovery_consent_block 검사 총 6개 통과. 새 검사는 실제 스케줄러 코드를 VM에서 실행하여 장시간 대기, 순차 승인, 중복 방지, 재조회 경쟁, 설정/소유권 취소, 표시 실패 시 반복 방지를 확인한다. 실제 RisuAI 승인창 및 Provider 호출 검증은 수행하지 않았다.
