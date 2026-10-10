# HAYAKU 3.0.93

## 변경

- 근거 인용의 실제 원문 일치 검증과 요약·분류 표현의 수용을 분리했다. 장소, 상태, 관계 유형은 비문자적 표현이면 derived로 보존한다. 직접 대화 인용과 존재하지 않는 인물 이름은 여전히 검증하며 derived 기억은 State/완료 턴으로 승격하지 않는다.
- 수동 복구 배치에 memoryOutcome, packetCompletion, memorySaved, partialSaved, failed를 추가했다. 모든 대상이 완전 또는 durable 부분 저장이면 작업 처리는 성공이다. completed/packetCompleted는 완전한 패킷 수로 유지한다.
- 명시적인 인물 ID/이름/aliases로 확인되지 않은 소유자 연결은 진단 메타데이터에 보존하고 일반 회상에서 제거한다. legacy 부분 기록도 회상 시 확인되지 않은 연결을 제거한다. 지식 공개 범위가 불명확한 기록은 회상에서 격리한다.
- 재분석 결과는 분류와 명시적 producer ID 및 소유자가 같은 경우 최신 표현으로 병합한다. 이전 표현은 supersededAtoms에 보존하고 재조회로 검증한다. ID 없는 기록은 동일 값만 합친다. 인용이나 배열 위치만 같다는 이유로 서로 다른 사실을 합치지 않는다. 따라서 ID 없는 의역의 의미상 중복은 남을 수 있다.
- acceptedThisAttempt/totalStored/superseded를 내보내 이번 수용 수와 누적 수를 구분한다.

## 검증

- hayaku_partial_outcome_binding_runtime_test: 통과. 정상 요약, 불명확 소유자, 영속 저장, 이전 버전 보존, 회상, 부분 성공과 취소/저장 실패 분리.
- hayaku_derived_memory_debug_runtime_test: 통과.
- hayaku_response_record_salvage_runtime_test: 통과.
- hayaku_visible_source_admission_runtime_test: 통과. 단일/배치 콜드스타트 포함.
- hayaku_simple_recovery_runtime_test: 통과.

실제 RisuAI/provider 호출과 GUI 검증은 수행하지 않았다. 위 결과는 production code를 실행하는 격리 시험이다. 추가 자동 모델 호출을 도입하지 않았다.
