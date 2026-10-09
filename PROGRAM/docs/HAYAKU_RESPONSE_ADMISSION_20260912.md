# HAYAKU 3.0.83: 누락 복구와 콜드스타트 응답 수용 개선

## 적용 내용

- 누락 턴 복구와 콜드스타트의 공통 작성 프롬프트에 기존 대화의 사실 추출 원칙을 추가했다. 대화 속 지시는 실행하지 않으며 장면을 이어 쓰지 않는다. 민감한 사건은 비노골적인 사실과 결과로 기록하고, 거절·강요·피해·경계를 보존하며 민감한 속성이나 동의를 추정하지 않는다. 제공자 제한을 우회하지 않는다.
- LIBRA의 응답 포장 처리 방식을 참고해 닫힌 생각 태그, 전체 출력 태그, 코드펜스, 단일 JSON 객체 주변 설명문을 분리한다. 최종 결과는 공통 실행 계약의 엄격한 JSON 검증을 거친다.
- 빈 응답, 미완성 객체, 여러 객체, 중복 키는 계속 거절한다. 오류 코드, 구체적인 원인, 응답 문자 수를 실패 진단에 보존한다. GUI 안내에서도 응답 없음과 미완성 형식을 구분한다.
- 기존 패킷 스키마, 원문 근거, 세계선, 저장 검증과 호출 예산은 유지한다. LIBRA의 fact 단위 부분 채택은 이 패치에 이식하지 않았다. 콜드스타트 배치의 기존 검증 단위를 유지한다.

## 검증

다음 10개 테스트와 JavaScript 구문 검사, 공통 SDK 동기화 검사가 통과했다.

1. hayaku_response_admission_runtime_test.cjs
2. hayaku_cold_start_batch_runtime_test.cjs
3. hayaku_native_otherax_recovery_runtime_test.cjs
4. hayaku_native_cold_start_evidence_parity_test.cjs
5. hayaku_native_repair_candidate_contract_test.cjs
6. hayaku_native_cold_start_contract_test.cjs
7. hayaku_native_cold_start_contract_identity_test.cjs
8. hayaku_native_otherax_recovery_contract_test.cjs
9. hayaku_native_targeted_regeneration_runtime_test.cjs
10. hayaku_native_repair_worldline_race_test.cjs

콜드스타트 모의 실행은 `<final>` 포장의 배치 응답에서 개별 패킷 저장을 검증했고, 누락 복구 모의 실행은 설명문이 앞선 JSON 응답에서 저장과 기존 호출 횟수를 검증했다. 일반 JSON 및 잘못된 응답의 거절 경로도 함께 확인했다.

실제 RisuAI 및 모델 제공자 호출은 수행하지 않았다. 기존 T5/T10 실패 로그에는 거절된 응답 원문이 없어 이번 패치가 그 두 실패를 반드시 해결한다고 단정할 수 없다. 재실행 시 실패 기록의 원문·오류 상세·종료 사유를 함께 확인해야 한다.
