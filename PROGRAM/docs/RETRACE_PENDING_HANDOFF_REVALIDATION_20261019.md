# RE:TRACE 미완료 승계의 완료 재검증 수정

기준은 main `b20d544`, RE:TRACE 1.9.84이며 수정 버전은 **1.9.85**이다.

## 문제

다음 세션 승계가 LIA 성공·HAYAKU 미완료 상태로 남은 뒤 HAYAKU 저장이 복구되면, GUI의 세션 탭 새로고침은 HAYAKU만 새로 검사했다. 다른 플러그인의 성공 여부는 이전 journal의 `verified` 값을 재사용했다. 그 사이 대상 채팅의 Persona를 변경하면 현재 LIA 검사는 `LIA handoff current target binding mismatch.`로 거부하지만 journal은 `completed`가 될 수 있었다.

## 수정

- 전달받은 GUI preview 대신 현재 대상 채팅의 봉인된 journal을 다시 읽고 target·transfer·활성 채팅을 확인한다. 이미 완료된 journal은 오래된 preview로 다시 열지 않는다.
- 완료 판정 전에 모든 필수 owner를 읽기 전용으로 재검증한다. Flashback은 원본 fingerprint와 대상 manifest·아카이브 메타데이터, HAYAKU는 대상 ledger·아카이브·원본 보존 증명, LIBRA는 준비된 아카이브 식별자와 대상 owner 검증 응답을 확인한다.
- Flashback 저장 검증은 GUI용 compact manifest를 증명으로 사용하지 않는다. 그 요약은 `copyExpectedRecordCount`, `handoffContract`, `sourcePreservationRequired`를 생략하며 레지스트리 요약으로 대체될 수도 있다. 실제 대상 manifest와 아카이브 메타데이터를 다시 읽어 정상 승계를 잘못 차단하거나 레지스트리의 오래된 성공을 신뢰하지 않게 한다.
- 다른 owner의 읽기와 저장 정책 확인 뒤에 LIA owner를 다시 호출하여 현재 Persona 연결과 분기 scope·transfer·저장 digest를 검증한다. 과거 adoption 응답은 분기 식별자를 전달하는 용도로만 보존한다.
- 현재 검증이 실패하면 해당 owner를 미검증으로 기록하고 미완료를 유지한다. 읽기 검사로 Persona를 다시 연결하거나 owner adoption·모델 호출을 실행하지 않는다. 사용자가 연결·데이터를 복구하면 같은 대상과 transfer를 다시 검사하여 완료할 수 있다.
- 검사 중 다른 재시도가 journal을 갱신했다면 expected journal digest가 불일치하므로 저장을 거부한다. 최신 재시도 기록을 과거 GUI 결과로 덮어쓰지 않는다.

이 변경은 미완료 journal의 자동 재검증에 적용된다. 완료된 승계를 계속 감시하는 기능이나 여러 플러그인 저장소를 아우르는 원자적 트랜잭션을 추가한 것은 아니다.

## 검증

`retrace_pending_handoff_revalidation_runtime_test.cjs`는 실제 다섯 플러그인 런타임과 공개 `continueToNextSession`을 사용한다. 실제 대상 HAYAKU ledger 쓰기에 테스트 호스트 오류를 주입해 미완료 journal을 만든 뒤, 실제 HAYAKU owner가 지연 완료하도록 한다. 제품 함수는 대체하지 않는다.

검사 항목은 다음과 같다.

1. 대상 Persona 변경 후 과거 LIA 성공으로 완료하지 않는다.
2. Flashback 대상 manifest 변경 후 과거 성공으로 완료하지 않는다.
3. LIBRA 대상 transfer 변경 후 과거 성공으로 완료하지 않는다.
4. HAYAKU 대상 아카이브 개수 변경 후 과거 성공으로 완료하지 않는다.
5. 다른 owner의 실제 검증 응답 도중 Persona가 변경돼도 마지막 LIA 검사로 차단한다.
6. 동시 재시도의 journal 갱신을 보존한다.
7. 데이터를 복구하면 원본·대상·transfer를 유지하며 네 owner를 다시 검증해 완료한다. 이 과정에서 owner adoption과 모델 호출은 0회다.

같은 회귀를 수정 전 1.9.84 바이트로 실행하면 첫 Persona 변경 검사에서 실패한다. 정상 GUI 네 owner 승계·원본 보존·재시작 조회와 기존 공개 API 실패 보호 검사도 실행한다. Full/Min 배포 바이트에 같은 지연 완료 회귀를 적용한다.

## 한계

호스트 저장소·채팅과 모델 생성 결과는 합성이며 외부 실모델은 호출하지 않는다. 기존 GUI 검사는 실제 제품 이벤트를 합성 DOM에서 실행하므로 사용자 RisuAI 앱의 시각 배치나 실제 RPC 지연 실측을 뜻하지 않는다. 서버 SDK 계약 검사와 혼합 저장 모드 검사는 전체 네 owner의 server_only 승계 완료 검증과 구분한다.

직전 구현 조사에서 관측한 LIBRA의 native child 회상 사전 검사 실패와 `LIBRA_GRAPH_READER_SCOPE_CHANGED`는 이번 완료 판정 패치의 수정 범위에 포함하지 않는다. Micro의 최종 회상 품질을 이 패치의 통과 결과로 보증하지 않는다. 로그·원본 합성 스냅샷·이전 플러그인 바이트는 저장소 밖 비공개 경로에 보관한다.
