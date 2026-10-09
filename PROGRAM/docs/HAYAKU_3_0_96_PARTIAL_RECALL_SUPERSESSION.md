# HAYAKU 3.0.96

부분 기억 리콜 전에 현재 원문 스냅샷과 원장을 결속하고 exactHayakuTurnCoverage로 완료 턴을 확인한다. 현재 원문/세계선에 유효한 패킷이 있는 턴은 부분 기억 후보를 만들지 않는다. 단순 턴 번호 일치나 오래된 감사 사본만으로 제외하지 않는다.

부분 기억 저장소는 수정하거나 삭제하지 않는다. 유효한 정규 패킷이 없는 턴은 기존 원문 결속·접근 범위 검사를 거쳐 계속 검색된다. 원장을 확인할 수 없으면 해당 요청의 부분 기억 주입을 생략한다.

검증: hayaku_partial_recall_supersession_runtime_test, hayaku_response_record_salvage_runtime_test 통과. 복구 전 검색, 정규 복구 후 제외, 저장 내용 불변, 추가 모델 호출 없음 확인. 실제 RisuAI/provider 실행은 미검증.
