# HAYAKU 3.0.86 후속 점검

## 첨부 로그의 확정 사실

입력: pasted-text.txt, hayaku_operation_debug_export_v1, 실행 버전 3.0.85. T5와 T10을 선택한 작업은 133.739초 걸렸고 실제 모델 호출은 2회였다. 과거 실패 기록만 보고 호출을 건너뛴 사례가 아니다.

| 구간 | 시간 |
|---|---:|
| 시작부터 T5 model_call까지 | 13.010초 |
| T5 model_call → response_validation | 73.301초 |
| T5 검증·실패 처리 → T10 시작 | 1.944초 |
| T10 시작 → model_call | 6.447초 |
| T10 model_call → response_validation | 37.103초 |
| T10 검증 이후 종료 | 1.934초 |

모델 호출 구간 합계는 110.404초(약 82.6%)다. 이 구간은 제공자 추론만이 아니라 호출·전송·호스트 반환까지 포함한다. 제공자별 대기와 생성 시간을 이 로그만으로 분리할 수 없다. 첫 coverage_scan은 5.378초, T5 evidence_verify 이후 호출까지는 3.271초였다. 초기 설치 중 localPluginStorage.keys 타임아웃도 보이지만 복구 실행 중 지연의 원인으로 단정할 수 없다.

T10의 실제 마지막 오류는 `native_repair_envelope_invalid:native_repair_envelope_top_level_invalid`다. T5는 동일한 일반 실패 코드로 보고되지만 그 구체적 오류는 첨부 로그에 없다. 실패 원문·실제 키 목록도 없어 부가 필드인지 필수 필드 누락인지 판단할 수 없다.

## 수정

- 생성 실패를 `native_repair_awaiting_user_review`로 반환하는 잔여 경로를 `native_repair_generation_failed`와 구체적 오류로 바꿨다. 해당 분석 실행 기록도 failed로 저장한다. 과거 진단은 삭제하지 않지만 일반 누락 조회의 검토 대기 목록을 만들지 않는다. 명시적 재생성은 기존 실패 진단과 관계없이 원문에서 시작한다.
- 기존 채팅에 유효하지 않은 패킷이 있을 때의 문구를 “기억 미저장 · 다시 생성”으로 바꿨다. 이 표시는 반드시 과거 실패 기록 때문에 생기는 것은 아니다.
- 선택 복구 루프의 중복 scope/debt 재조회를 제거했다. 실제 실행 함수의 최신 scope·원문 행·debt·lease 검증과 결과 적용 직전 검증은 유지한다. 실환경 속도 향상은 아직 측정하지 않았다.
- 세부 진행 문구와 phaseTimings를 추가했다. 새 실패 로그는 실제 검증 오류와 응답 구조의 키 목록도 제공한다.
- 필수 schema, packet, grounding이 정확한 경우에만 바깥의 부가 필드를 격리하고 이름을 수용 기록에 남긴다. 필수 구조·근거를 임의로 보충하지 않는다. 실제 T10 응답이 이 조건에 해당하는지는 원문 없이는 알 수 없다.

## 부분 수용 재감사

3.0.84의 구현은 정상 항목을 일반 기억으로 부분 활성화하는 LIBRA 방식과 동일하지 않다. 잘못된 항목·의존 항목을 제거한 뒤 패킷 전체를 검토 후보로 보존한다. 3.0.85에서는 해당 검토 화면까지 폐기되었으므로 이 결과는 진단으로만 남고, 이후 전체 턴을 다시 생성해야 한다.

이번 수정은 부가 봉투 필드만 있는 경우를 정상 수용하지만, 의미 항목이 제외된 부분 패킷을 일반 기억으로 자동 활성화하지 않는다. 그 동작까지 완료했다고 주장하지 않는다. 부분 기억을 검색에 쓰면서 현재 상태·완료 판정을 분리하려면 별도의 상태 적용 계약이 필요하다.

## 검증

관련 테스트 파일 10개 통과: simple_recovery, native_otherax_recovery, record_admission, after_request_recovery_journal, cold_start_batch, native_repair_worldline_race, native_targeted_regeneration, manual_preflight_diagnostics, exact_missing_source_v348, control_desk.

새로 생성한 응답에 부가 봉투 필드가 있어도 실제 모의 원장에 채택되는 경우, 실패 기록이 있는 턴의 새 분석, 퇴역한 검토 상태의 제거를 검사했다. 선택 원문 변경·취소·중복 실행·원문 수정 격리 등 기존 안전 회귀도 통과했다. 실제 RisuAI GUI·제공자 호출·속도 재측정은 수행하지 않았다.
