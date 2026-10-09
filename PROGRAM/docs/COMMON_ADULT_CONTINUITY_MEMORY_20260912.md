# LIBRA / HAYAKU 공통 성인 소재 기억 추출

사용자가 제공한 소악마 v15-9B 프리셋은 참고 자료로 확인했다. 프리셋의 성적 묘사 강화 지침을 가져오는 대신, 사용자가 동의한 비노골적 사실 보존 범위를 두 플러그인의 고정 추출 계약에 적용했다.

별도 토글 없이 자동 적용된다. 원문으로 확인되는 성인 사건, 참여자, 관계 변화, 명시된 경계, 이후 연속성에 필요한 영향을 비노골적인 사실로 보존한다. 성인 소재라는 이유만으로 근거 있는 사건을 누락하지 않는다. 동의, 거절, 철회, 불확실성은 참여자와 시점별로 구분한다. 프리셋의 NSFW 설정이나 묘사 강도는 사건·동의·취향의 증거가 될 수 없다. 새 성적 묘사나 장면 전개는 생성하지 않는다.

적용 경로:

- LIBRA: 고정 장기 기억 추출 계약. 사용자 편집 프롬프트와 함께 적용된다.
- HAYAKU: 일반 패킷의 full/compact/critical 계약과 cold_start/incremental_recovery/after_request_recovery의 기본 및 수정 프롬프트.

두 플러그인은 독립 실행을 유지하며 같은 문구를 가진다. 회귀 테스트가 LIBRA 전송 프롬프트와 HAYAKU 각 계약의 문구 일치를 검사한다. 기존 기억 재작성, 저장 형식 변경, 새 API 호출, 제공자 제한 우회는 포함하지 않는다.

검증: 두 소스의 node --check, libra_memory_refusal_prompt_runtime_test.cjs (11개), hayaku_prompt_contract_v4_runtime_test.cjs, libra_custom_prompt_pipeline_lock_runtime_test.cjs 통과. 추가된 계약 길이를 반영해 LIBRA 프롬프트 길이 상한 검사를 11200에서 11800자로 조정했다. 통제된 호스트/응답을 사용한 테스트이며 실제 RisuAI GUI, 실제 모델의 수용 여부나 추출 의미 정확도는 미검증이다.
