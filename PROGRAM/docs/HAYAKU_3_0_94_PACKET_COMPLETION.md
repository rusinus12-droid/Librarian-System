# HAYAKU 3.0.94

- 정상 구조의 복구 응답을 항목별로 검증한 뒤, 근거가 없는 항목만 제외하고 남은 항목으로 정규 패킷을 구성한다. 정상 요약/의역은 완료를 방해하지 않는다. 유효한 기억이 전혀 없거나 필수 패킷·원문 결속·coverage·저장 검증이 실패하면 완료를 주장하지 않는다.
- 항목 검사 결과를 normalization 후에도 보존한다. 저장 후보 영수증은 source_bound_derived를 지원하며 기존 패킷 해시, 원문/manifest, worker 결속 검증은 유지한다.
- 제외 항목과 derived 필드는 저장 패킷 meta.record_admission에 남는다. 파생/필터링 패킷은 meta.stateAuthority=false이며 인물 상태 병합과 세계 현재 상태 생성 경로를 건너뛴다.
- 기존 부분 기억은 뷰어 전용 목록으로 읽어 패킷 기록에 '이전 부분 기억'으로 표시한다. 원장에 가짜 정규 레코드를 추가하지 않는다. 부분 기억의 원본 저장소는 보존한다.
- 지속되는 작업 결과 표시도 기억 저장 수, 완전 패킷 수, 부분 저장 수를 구분한다.

## 검증

production runtime fixture에서 다음 테스트가 통과했다.

- hayaku_filtered_packet_completion_runtime_test: 근거 누락 항목 1개 제외, 정상 요약 보존, 정규 active 원장 재조회, 누락 턴 해제, 재실행 시 추가 모델 호출 없음.
- hayaku_derived_memory_debug_runtime_test: 정상 요약의 정규 저장 및 원문 인용/인물 검증.
- hayaku_partial_outcome_binding_runtime_test: 비정규 응답의 부분 저장, 소유자 격리, 기존 기록 병합, 배치 성공/실패 구분.
- hayaku_visible_source_admission_runtime_test: 원문 메타데이터 제외, 기존 부분 저장 호환, 제한된 지식의 의존성 격리, 단일/배치 콜드스타트.
- hayaku_response_record_salvage_runtime_test: 비정규/손상 응답의 부분 수용 및 데이터 없는 결과 구분.
- hayaku_simple_recovery_runtime_test: 일반 복구와 추가 호출 차단.

실제 RisuAI/provider 및 GUI 화면 검증은 수행하지 않았다. 이번 시험은 사용자 채팅을 수정하거나 모델에 전송하지 않았다. 기존 부분 기억은 자동으로 완전 패킷으로 승격하지 않으며, 새 복구 실행에서 원문을 확인해 정규 저장한다.
