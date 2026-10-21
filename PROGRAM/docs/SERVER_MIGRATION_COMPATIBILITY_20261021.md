# 서버 전체 이전의 기존 저장 형식 호환

적용 버전: LIBRA 2.3.193, Flashback 1.0.128, HAYAKU 3.0.163,
Storage SDK 1.8.28. HAYAKU는 공통 저장소 복사 수정만 포함한다.

## 변경 사항

- LIBRA 공유 아카이브의 변경 불가능한 인덱스에는 이전 임베딩 프로필의
  `vectorKey`가 남을 수 있다. 실제 아카이브 기억의 키, ID, revision,
  sourceDigest, archive 바인딩이 일치하면 그 기억 레코드의 현재 벡터 참조를
  사용한다. 현재 벡터는 계속 필수이며, 남아 있는 과거 벡터도 함께 이전한다.
  인덱스 원문과 무결성 digest는 수정하지 않는다. 서버에서 복원할 때도 같은
  참조 규칙을 사용한다.
- LIBRA `libra.local_vector_payload.v1`의 `storageKey`는 벡터 메타데이터를
  가리키는 역참조다. 메타데이터가 정리된 경우에도 payload의 물리 키 해시와
  localKey가 일치하고 기존 스코프를 확인할 수 있으면 원래 바이트를 보존해
  이전한다. 소유자를 확인할 수 없는 payload는 계속 차단한다.
- Flashback의 과거 스코프 레지스트리에 포함된 `flashback_archive_v1:` 항목을
  네이티브 채팅으로 검사하지 않는다. 같은 원본 저장소에 실제 아카이브
  manifest가 있으며 스코프와 archiveOwner/archiveId 바인딩이 맞아야 한다.
- Flashback의 commit 샤드가 없을 때 네이티브 읽기와 동일하게 기존
  `records:shard:` 키를 검사한다. 해당 샤드 자체의 commitId가 manifest와
  정확히 일치해야 하며 raw-page 디렉터리에는 이 대체 규칙을 적용하지 않는다.
- 전체 이전은 플러그인의 기기 저장소 래퍼 초기화 여부와 관계없이, 검사에서
  실제 확인한 plugin/device 저장소를 복사·복원·검증한다. 발견한 기기 벡터를
  복사 단계에서 건너뛰던 문제를 수정했다.

## 실제 누락과 진단

이 패치는 없는 원문이나 벡터를 만들어 내거나 누락 검사를 해제하지 않는다.
Flashback manifest의 commitId가 비어 있고 기존 샤드도 실제로 없으면 여전히
이전을 차단한다. 다른 commit의 샤드나 다른 저장소의 사본으로 임의 대체하지
않는다. 이런 경우 백업 등에서 정확한 데이터를 확보해야 한다.

`이전 검사 상세`의 첫 manifest 의존성 오류에는 `manifestState`를 추가한다.
scopeKey, commitId, count, shardCount, rawPageLayout, 실제 발견한 샤드 수와
최대 32개 저장 키를 포함한다. 대화 본문과 인증 정보는 포함하지 않는다.

## 검증

- `global_owner_discovery_adapters_test.cjs`: 기존 레지스트리, 아카이브 참조,
  로컬 벡터 역참조, 동일 commit 대체 및 실제 누락·변조 차단을 검사한다.
- `storage_global_owner_public_gui_test.cjs`: 실제 플러그인 GUI와 서버 handler로
  플러그인 → 서버 → 재시작 → 플러그인 왕복을 검사한다. LIBRA의 오래된
  아카이브 벡터 인덱스와 메타데이터가 없는 기기 payload, Flashback의 과거
  아카이브 레지스트리와 실제 기록이 든 기존 샤드를 포함하며 바이트 보존을
  확인한다. 외부 모델 호출은 허용하지 않는다.
