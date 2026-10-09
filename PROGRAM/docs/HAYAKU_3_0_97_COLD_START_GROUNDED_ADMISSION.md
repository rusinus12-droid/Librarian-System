# HAYAKU 3.0.97

단일 콜드스타트도 누락 복구와 같은 envelope/항목별 근거 검사/정상 항목 구성/coverage 검사 경로를 사용한다. 프롬프트는 packet과 grounding을 요청한다. 요약과 분류는 정확한 인용과 구분하고, 파생 해석은 State 권한을 얻지 않는다.

배치는 각 unitOrdinal에 packet 및 grounding을 연결한다. 바깥 wrapper가 달라지거나 일부 JSON이 손상되어도 파싱 가능한 명시적 unitOrdinal의 패킷을 처리한다. 배열 순서로 턴 번호를 추측하지 않는다. 중복 ordinal은 격리한다. 각 항목의 인용은 해당 unit의 원문에만 대조하며 다른 턴의 원문을 근거로 쓰지 않는다.

응답 형식 문제나 근거 없는 항목이 전체 정상 기록을 버리는 원인이 되지 않도록, 같은 prepareNativePacketRecords를 통해 정상 항목만 패킷으로 구성한다. 유효한 항목이 전혀 없는 턴은 실패 진단과 기존 보존 경로로 남긴다. 추가 자동 모델 호출을 도입하지 않았다.

배치 전체에서 실패 턴이 남으면 콜드스타트 전체 완료는 주장하지 않는다. 성공한 턴은 검증된 체크포인트에 영속 보존되며 재개 시 재사용된다. 전체 콜드스타트의 정규 원장 채택은 기존 완료/범위/원문 호환성/물리 재조회 검증을 유지한다.

## 검증

- hayaku_cold_start_grounded_admission_runtime_test: 단일/배치 정상 요약, 잘못된 항목 격리, wrapper/손상된 형제 응답 복원, 다른 턴 인용 거부, 단일 원장 저장 재조회.
- hayaku_cold_start_batch_runtime_test: 5턴/10턴 배치 원장 저장. fixture를 새 grounding 계약에 맞춰 갱신.
- hayaku_filtered_packet_completion_runtime_test: 기존 누락 복구 정규 완료 유지.
- hayaku_partial_recall_supersession_runtime_test: 복구된 턴의 이전 부분 기억 중복 리콜 방지 유지.
- hayaku_simple_recovery_runtime_test: 기존 복구 및 추가 모델 호출 차단 유지.

모두 통과. 실제 RisuAI/provider/GUI 검증은 미수행. 기존 데이터와 저장 체크포인트를 삭제하지 않았다.
