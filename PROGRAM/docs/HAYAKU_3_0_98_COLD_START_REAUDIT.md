# HAYAKU 3.0.98 패치 및 재감사

## 패치

1. 배치의 내부 패킷 형식/정규화 실패에도 salvageNativeResponseRecords를 연결했다. 부분 기억 저장의 saved/durable 결과를 오류 결과에 전달한다.
2. 검증된 턴이 있으면 실패 턴이 남아 있어도 해당 패킷들을 정규 콜드스타트 원장에 먼저 채택한다. completed=false, failedChunks와 completedChunks를 구분한다. 실패 턴은 체크포인트에 남으며 자동 추가 호출을 도입하지 않았다.
3. 설정으로 허용된 추가 재시도 성공 시 진단 저장 후 바로 정상 결과로 처리한다. 이전 실패 이력만으로 사용자 검토 대기로 돌리던 분기를 제거했다.
4. 재감사 중 부분 채택 후 기존 기억 차단 조건 때문에 재개가 막히는 결함을 발견했다. 동일 원문 sourceHash 및 현재 원장 transferId와 일치하는 partial run만 기본 재개를 허용한다.
5. 부분 채택은 이전 epoch 데이터를 보존하고 현재 run의 성공 집합을 갱신한다. 완료 턴 판정은 활성 cold-start epoch를 사용한다. 전체 완료 시 기존 baseline 채택 계약을 유지한다.

## 재감사 결과

- 이전 추가 메타데이터 사례: 단일 3개 / 배치 6개 정상 부분 기억 저장 및 물리 재조회 성공. 비정규 응답의 부분 수용은 단일·배치 동일.
- 2턴 중 1턴 실패: 성공 턴 1개를 정규 원장에 영속 채택. 전체 완료는 false, awaitingUserReview=false.
- 같은 실행 재개: 성공 1턴 재사용, 실패 1턴만 추가 호출, 최종 원장 2개. 중복 없음.
- extraCalls=1 명시 조건: 첫 응답 실패 후 두 번째 정상 응답을 검토 대기 없이 수용. 총 2회로 제한.
- 저장소 두 곳에서 원장 쓰기를 false로 거부: 채택 실패, 정규 원장 기록 0개. 성공 오판 없음.
- 단일/배치 근거 수용, 손상된 형제 응답, 다른 턴 근거 차단, 5턴/10턴 저장, 부분 기억 중복 리콜 방지 회귀 시험 통과.

시험: hayaku_cold_start_partial_adoption_audit_runtime_test, hayaku_cold_start_grounded_admission_runtime_test, hayaku_cold_start_batch_runtime_test, hayaku_partial_recall_supersession_runtime_test.

직전 감사의 세 결함과 재개 차단 결함은 위 범위에서 해결됨. 제품 코드에 대해 격리된 runtime fixture와 저장 실패 주입으로 확인했으며, 실제 RisuAI/provider/GUI는 미검증이다. 모든 응답이 완전 패킷이 된다는 보장은 아니다. 항목의 근거가 없거나 내부 구조를 부분적으로만 복원할 수 있는 응답은 부분 기억/실패로 남을 수 있다.
