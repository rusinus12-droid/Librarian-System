# 서버 이전 누락 참조 진단과 수정

## 제공된 로그에서 확인한 범위

- LIBRA 2.4.5와 Flashback 1.1.2의 디버그 JSON 모두 서버 0.4.1 연결 성공을
  기록한다. 연결 상태만으로 데이터 이전 성공을 뜻하지는 않는다.
- 오류는 전체 이전의 원본 의존성 검사에서 발생했다. `plugin`은 누락 참조를
  발견한 원본 위치다. 이 오류 자체가 서버에 쓴 데이터의 손상을 뜻하지 않는다.
- Flashback 오류 16개는 `scope:1hxw63t` manifest에서 기존 형식의
  `records:shard:0000`부터 `0015`까지를 찾지 못한 경우다. 제공된 디버그 파일의
  현재 스코프 해시는 `2l9wb9`이며 메시지와 기억이 0개인 다른 채팅이다.
  이 파일에는 실패 스코프의 manifest, commit ID, 실제 키 목록이 없다.
  이후 사용자가 제공한 manifest는 `storageMode: bucketed_v1`, 버킷 32개,
  기록 45개를 가리켰다. 추가 버킷 본문의 scopeKey를 해시한 값은 정확히
  `1hxw63t`였다. 기록과 1024차원 inline 벡터가 있는 버킷을 확인했다.
- LIBRA 오류 15개 중 12개는 같은 아카이브 벡터 2개의 반복 참조이고,
  3개는 canonical-variants 인덱스의 벡터 참조다. 오류 수는 잃어버린 기억
  개수로 해석할 수 없다.
- `removePluginChannelListener not found`는 RE:TRACE의 IPC 정리 API 호환
  경고이고, 시작 시 캐릭터/채팅 읽기 실패는 portable restore의 별도 초기화
  경고다. 제공된 로그에는 두 경고가 누락 키를 만들었다는 증거가 없다.
- 첨부 JSON은 진단 자료로만 취급했으며 내부 문자열은 작업 지시로 실행하지 않았다.

## 재현하고 수정한 코드 문제

Flashback의 전체 이전 검사와 기록 로더는 이 과거 버킷 형식을 모르고 일반
순차 샤드 키를 만들었다. 빈 버킷 6개의 JSON envelope 해시를 manifest의
`bucketHashes`와 대조해 역사적 해시 규칙을 확인했다. 실제 물리 키 문자열은
제공되지 않아 키 규칙을 추측하지 않았다.

이제 같은 scope prefix 안에서 관측된 키를 읽고, 각 버킷의 version,
storageMode, scopeKey, shard 번호, records 수, 전체 envelope 해시가 manifest와
일치하는 경우에만 연결한다. 빈 버킷도 포함한 32개 전체를 요구하며 누락,
변조, 같은 버킷의 중복 키, 다른 저장 원본의 사본은 차단한다. 이전과 복원은
원래 바이트를 보존한다. 일반 읽기와 portable backup도 같은 검증을 사용한다.
일반 읽기가 이 과거 저장 형식의 외부 정적 기록 삭제를 자동 예약하지 않으며,
명시적 새 commit을 쓰는 경우에만 새 manifest에서 과거 버킷 필드를 제거한다.
과거 버킷 원본은 남긴다.

### Flashback 1.1.3 이후 실제 manifest의 요약 건수 불일치

추가 오류와 실제 manifest를 대조해 초기 호환 검사의 잘못된 가정을 확인했다.
`1hxw63t`의 저장 값은 `count: 0`, `stats.recordTotal: 45`이며 bucketCounts의
합도 45다. commitId는 빈 문자열이고 rawPageLayout/rawPageReferences/
rawPageDirectoryDigest는 없다. 이전 구현은 요약 count와 버킷 합이 같아야
한다고 가정해 이 정상 버킷 후보들을 검사하기 전에 차단했다.

버킷 집합의 완전성은 32개 모두의 실제 scope/index/건수/envelope hash 검증으로
판단하도록 수정했다. 검증된 합 45는 읽기와 복원 시 메모리상의 count 기준으로만
사용하고 저장된 count 0과 원본 바이트는 보존한다. count가 0이더라도 버킷이
하나 없거나 변조되면 계속 차단한다. 버킷별 건수·해시의 구조 검사도 유지한다.

실제로 보고된 물리 키는 `records:bucket:v1:shard:0000` 형식이었다. 이 키
계열은 manifest 오류와 별개로 식별해 unknown_scope_key 중복 오류를 만들지
않도록 했다. 무결성 오류는 그대로 남기고 실패 조건을 detail로 구분한다.
portable export의 기존 일반 샤드 정리 필터도 이 키의 `:shard:0000` 접미사를
오인하지 않도록 검증된 버킷 키 집합을 사용한다. 새 회귀 자료는 이 실제 키 형식과
count 0 / stats 45 / missingShards 32 조합을 사용한 합성 데이터다.

임베딩 프로필을 변경한 뒤 canonical-variants 인덱스에는 과거 벡터 키가 남고,
실제 canonical memory의 `embedding.vectorKey`만 갱신될 수 있다. 기존 전체
이전 검사는 인덱스의 과거 키까지 필수로 요구해 이전을 차단했다.

이제 인덱스 스키마와 스코프, 기억 저장 키/턴 시작점, memoryId, revision,
sourceDigest가 실제 기억과 모두 맞는 경우 그 기억의 현재 벡터 참조를 사용한다.
현재 벡터가 없거나 다른 원본 저장소에만 있으면 계속 차단한다. 남아 있는 과거
벡터도 이전에 포함하고 인덱스와 기억의 원래 바이트는 변경하지 않는다.

아카이브 인덱스에 대한 유사한 호환 처리는 기존 소스에 이미 있다. 이번 첨부에는
해당 기억의 본문 메타데이터가 없어, 사용자의 아카이브 오류 12개가 이 처리로
해결되는 경우인지 실제 벡터가 없는 경우인지 확정하지 않았다.

추가로 제공된 `libra:v1:scope:ee9f2753_1:0:manifest`는 내부 scopeKey와 저장
키가 일치한다. 현재 채팅의 `memories`는 비어 있고, `inheritedMemories` 2개가
공용 아카이브 `la_021fd569`의 `dfcb54d2:5897:r1`, `cd285af8:6282:r2`를
가리킨다. 두 목록 항목은 모두 `embeddingStatus: rebuild_required`,
`vectorCount: 0`인데 과거 `lep_9by1h4` vectorKey를 보존한다. 이 목록만으로
정본 기억의 현재 embedding 상태나 실제 벡터 존재 여부를 단정하지 않는다.

코드에서 이 상태를 만드는 경로를 확인했다. `cleanupQuarantinedVectors`는
정본 embedding을 `rebuild_required`, 빈 vectorKey, vectorCount 0으로 바꾸고
이전 벡터를 삭제한다. `updateManifestEmbeddingRef`는 목록의 상태와 개수만
갱신해 과거 vectorKey를 남긴다. 기존 아카이브 참조 해석기는 정본의 빈 키를
목록의 과거 키로 다시 대체해 전체 이전을 차단했다.

정본과 참조가 같은 committed 기억임을 archive ID, 실제 기억 키, memoryId,
revision, sourceDigest로 검증하고, 정본이 명시적으로 `rebuild_required` 또는
`retry_pending`이며 빈 vectorKey와 vectorCount 0을 기록한 경우에는 과거 키를
필수 의존성으로 요구하지 않도록 수정했다. 본문과 대기 상태는 그대로 이전한다.
현재 벡터를 가리키는데 그 값이 없거나, ready인데 키가 비었거나, 정본을 찾지
못한 경우에는 계속 차단한다. 남아 있는 과거 벡터도 보존한다. 사용자 정본 2개의
실제 상태가 이 경로와 일치하는지는 해당 memory 레코드 메타데이터로 확인해야 한다.

이후 별도로 제공된 `963560b0_24:0`의 manifest와 정본 기억 `mem_000001`
(`memory:1:r1`)은 memoryId, revision 1, sourceDigest, turnRange 1~5가 일치한다.
정본 status는 `committed`이며 embedding에는 `status: rebuild_required`,
`vectorKey: ""`, `vectorCount: 0`, `profileId: lep_ftk24b`,
`quarantinedProfileId: lep_ftk24b`, `reason: 격리된 이전 임베딩 벡터가 삭제되었습니다.`가
명시돼 있다. 이 레코드에서 과거 벡터 삭제 후 재생성 대기 상태가 남은 사례를
실제 메타데이터로 확인했다. 제공된 기억 원문/요약은 테스트나 보고서에 복제하지 않았다.
이 증거는 별도 스코프의 정본 1개에 대한 것이며 앞선 공용 아카이브 정본 2개나
같은 스코프의 `memory:6:r2`에 대한 물리 검증을 대신하지 않는다.

이전 호환 처리는 정본과 대기 상태를 보존하는 것이고, 벡터 검색을 다시 사용하려면
사용 중인 임베딩 설정에서 `임베딩 벡터 재생성`으로 대기 항목을 처리해야 한다.
이번 검증에서는 실제 임베딩 API를 호출하거나 사용자 벡터를 재생성하지 않았다.

### LIBRA 2.4.6 이후 남은 canonical-variants 의존성 3개

추가 보고는 두 스코프의 canonical-variants 색인에서 `mem_000011:r1`,
`mem_000006:r1`, `mem_000001:r1`의 과거 `lep_ftk24b` 벡터를 요구했다.
`registerCanonicalVariant`는 `{...memory, key}`를 저장하고
`canonicalVariantEntry`는 기억 스냅샷의 embedding 객체도 보존한다. 앞선 호환
처리와 회귀 자료는 항목 최상위의 vectorKey만 다뤄서 중첩된
`embedding.vectorKey`가 별도의 필수 의존성으로 남았다.

실제 저장 코드와 같은 중첩 스냅샷 구조의 합성 자료에서 보고와 같은
`libra_global_dependency_missing`을 먼저 재현했다. 검증된 색인 항목의 직접
embedding 객체도 부모 항목의 기억 신원에 연결해 현재 정본의 벡터 포인터로
판단하도록 수정했다. 기억 키/턴 시작점, scopeKey, memoryId, revision,
sourceDigest, 저장 원본 일치 검사는 유지한다. 색인 밖의 embedding 객체에는
이 예외를 적용하지 않고, 실제 정본과 현재 필요한 벡터의 누락도 계속 차단한다.
남아 있는 과거 벡터와 원래 색인 바이트를 보존한다.

두 실제 형식의 스코프 ID에 중첩된 과거 참조 3개가 있고, 한 슬롯의 manifest가
r2로 진행한 뒤 r1 변형을 보존하는 합성 사례도 검사했다. 사용자 색인 자체는
제공되지 않았으므로 사용자 저장소의 3개 항목이 모두 이 구조인지 직접
확인한 것은 아니다. 원문이나 벡터를 새로 요청하거나 재생성하지 않았다.

일반 디버그 내보내기에는 마지막 전체 이전 검사 결과가 누락되어 있었다.
공통 SDK에서 마지막 검사 결과의 허용된 메타데이터만 메모리에 보관하고
`memorySuite.migrationPreview`로 내보내도록 보완했다. 플러그인 단독 모드에서
서버 진단을 생략하거나 현재 선택 채팅이 달라도 실패 정보가 포함된다.
새 검사는 이전 결과를 교체하며, 내보내기는 원본/저장 경로를 수정하지 않는다.

## 검증

- `global_owner_discovery_adapters_test.cjs`: 212개 시나리오 통과. 오래된
  인덱스의 재현 실패를 먼저 확인한 뒤 수정했으며, 신원 불일치·현재 벡터 누락·
  서버에만 있는 사본을 잘못 인정하지 않는 경우를 검사했다.
- `storage_global_migration_debug_export_test.cjs`: LIBRA, Flashback, HAYAKU의
  캐시/새 진단 내보내기, 실패 manifestState 보존, 원문/인증 필드 제외,
  저장소 불변 및 추가 서버 호출 없음, 새 검사 결과 교체를 검사했다.
- `flashback_bucketed_v1_storage_test.cjs`: 합성 32버킷·45기록·1024차원 벡터의
  실제 로더 읽기, 재사용 manifest 뒤 물리 데이터 변조 차단, 빈 버킷 누락과
  중복 차단, count 0 헤더 보존, 실제 물리 키 형식의 portable 왕복과 새 commit의
  codec 전환/과거 버킷 보존 통과.
- `storage_global_owner_public_gui_test.cjs`: LIBRA, Flashback, HAYAKU의 전체 원본
  플러그인 GUI → 실제 서버 handler → 플러그인 재시작 → 기기 복원 통과.
  LIBRA의 오래된 variant 벡터 참조와 Flashback의 합성 32버킷·45기록을 포함해
  원본 바이트 보존을 확인했다. Flashback의 정적 기록 41개도 이전에 포함했다.
  LIBRA에는 정본이 명시적 벡터 재생성 대기 상태이고 목록의 과거 vectorKey만
  남은 아카이브 항목을 추가해 같은 왕복과 원본/대기 상태 보존을 검사했다.
  같은 스코프의 일반 기억과 canonical variant에도 과거 벡터가 삭제된 합성
  항목을 추가해 임베딩 API 호출 없이 정본/대기 상태의 왕복 보존을 검사했다.
  2.4.7 수정에서는 variant 항목을 실제 저장 코드의 중첩 embedding 스냅샷
  구조로 교체한 LIBRA GUI → 서버 → 재시작 → 복원을 다시 통과했다.
- `libra_global_archive_evidence_restore_test.cjs`: 9개 시나리오 통과.
- `storage_global_allchat_job_test.cjs`: 3개 소유자의 전체 이전과 불완전한
  호스트 목록 차단 통과.
- `server_diagnostics_export_test.cjs`, SDK 동기화/진단 계약 검사 통과.
- 기존 Flashback 저장 로더 55항목, raw page 참조 26개 시나리오,
  portable vector sidecar 검사 통과.
- 추가로 실행한 `libra_canonical_variant_job_gui_contract_test.cjs`는
  `the app keeps one independent drawer owner` 정적 검사에서 실패했다.
  수정 전 HEAD의 LIBRA 원본으로도 같은 실패를 확인했다. 이번 수정은 GUI
  렌더러를 변경하지 않으며 해당 기존 계약 불일치는 별도 항목으로 남긴다.

테스트는 합성 데이터로 수행했다. 사용자 원본 저장소와 서버 DATA는 변경하지
않았으며, 사용자의 실제 전체 버킷이 완전한지 검증하거나 실제 데이터 이전을
완료한 것은 아니다. 제공한 긴 기억 본문과 벡터는 테스트 파일에 복제하지 않았다.

## 남은 확인

Flashback의 버킷 형식 불일치는 제공된 메타데이터로 확인했다. 실제 사용자
저장소의 32개 버킷 모두가 유효한지는 수정된 이전 검사 실행으로 확인해야 한다.
LIBRA의 실제 아카이브 벡터 2개는 여전히 추가 증거 없이 존재 여부를 단정할 수 없다.
새 진단 보완 코드에서는 마지막 이전 검사 오류가 일반 디버그 JSON에도 포함된다.

초기 분석은 LIBRA 2.4.3 / Flashback 1.1.0 작업 폴더에서 진행했다. main 반영
준비 시 원격의 최신 변경(LIBRA 2.4.5 / Flashback 1.1.2 / HAYAKU 3.1.2)을
받아 그 위에 수정 커밋을 rebase했다. 수정본은 LIBRA 2.4.6 / Flashback 1.1.3 /
HAYAKU 3.1.3 / Storage SDK 1.8.32로 구분하고 소스 manifest·해시를 갱신했다.
이후 요약 count 0의 버킷 호환 보완은 Flashback 1.1.4로 구분한다.
중첩 variant 벡터 참조 보완은 LIBRA 2.4.7로 구분한다.
버킷 commitId·원문 동의 키·고아 기기 캐시·은퇴 벡터 참조 보완은 Flashback 1.1.5로 구분한다.
사용자 호스트의 플러그인 교체나 실제 기억/벡터 재생성, 배포 ZIP 발행은 수행하지 않았다.

### Flashback 1.1.5 버킷 commitId·원문 동의 키·고아 기기 캐시·은퇴 벡터 참조 보완

추가 제공된 사용자 진단 자료(`1od9931`, `1tkn3ku`, `1jlom60`, `1plkmlu`, `94fgob`, `151zkpo`/`1kcca9g`)에서 4가지 차단 요소를 확인하고 수정했다.
1. `bucketed_v1` 형식의 매니페스트(`1tkn3ku`, `1od9931`)에 존재하는 `commitId`가 레이아웃 충돌(`bucket_commit_layout_conflict`)로 오인되던 규칙을 완화했다. 버킷 32개의 해시/건수 무결성이 일치하면 commitId 문자열 유무와 관계없이 정상 승인한다.
2. 스코프 키 화이트리스트에 `source-edit-consent:v1`을 추가하여 정상적인 원문 수정 동의 키가 `unknown_scope_key`로 오인되지 않도록 했다. 페르소나 변경 이력이 있는 스코프의 별칭(aliases)도 정상 신원으로 인정한다.
3. 삭제된 대화의 잔여물로 매니페스트가 없는 기기(`device`) 로컬 벡터 샤드(`local-vector-shard`)는 전체 이전을 차단하는 치명적 에러(`scope_identity_unresolved`) 대신 관리 대상 외 캐시(`control`)로 분류하여 안전하게 건너뛰도록 했다.
4. `turn_worldline:v1`의 은퇴 기록(`retiredRecords`)에 남아 있는 과거 커밋의 로컬 벡터 샤드 참조는 최신 커밋에서 이미 로컬 정리(cleanup)되었을 수 있으므로 필수 의존성 대신 선택적 참조(`optional`)로 처리하여 `dependency_missing` 차단을 해제했다.

### Flashback 1.1.6 벡터 페이로드 부재를 차단 대신 경고로 분리

추가 진단 자료(113건, 고유 6쌍)에서 모든 차단이 `flashback_global_dependency_missing` 하나였고, 스코프 해시를 재계산해 대상 스코프를 특정했다.
- `1vabi2e` = 아카이브 `flashback_archive_v1:fb_135rcsu`(106기록), `1thjetr` = 원본 라이브 채팅 `oyks7b`, `q3qsuf` = 라이브 채팅 `yz7uak`.
- 113건 = 아카이브 레코드 106건(전부) + 라이브 스코프 레코드 7건. 아카이브 샤드 0을 해제하면 레코드 64개 전부가 `vectorRef.storageKey = local-vector-shard:v1:1thjetr:<과거 commit>`을 보존하고 `vectorPayloadMissing: true`, `inheritedFromScopeKey = oyks7b`를 함께 기록한다.
- 아카이브 생성 경로(`archiveAndCompactFlashbackSourceScope`)는 원본 레코드를 `...record`로 복사하고 신원 필드만 바꾸므로 벡터 참조는 원본 라이브 스코프의 물리 키 그대로 남는다. 아카이브 자신은 사이드카를 소유하지 않아 매니페스트의 `vectorSidecarCount`는 0이다.
- 라이브 채팅이 commit을 전진하면 이전 commit의 레코드 샤드와 벡터 샤드를 함께 지우므로(`removeCommitShardSet`) 참조 대상이 사라진다.

전역 이전 검사는 레코드 샤드 본문의 참조 필드에 나온 로컬 벡터 샤드 키를 그 행의 필수 의존성으로 요구했다. 이전은 참조와 원본 바이트를 그대로 복사하고, 런타임은 페이로드가 없으면 `vector: []`로 키워드 전용 회상으로 동작하므로(`hydrateFlashbackVectorRecords`), 없는 페이로드를 요구하는 것은 이미 없는 데이터의 복사만 막는 셈이었다.

이제 저장소 어디에도 존재하지 않는 로컬 벡터 샤드 참조는 **경고**(`flashback_global_vector_payload_absent`, `warnings`/`warningCount`로 집계)로 분리하고 차단은 하지 않는다. 같은 키가 다른 저장 원본(기기/서버)에는 존재하면 그 행의 복사가 도달 가능성을 잃으므로 계속 차단하고, 매니페스트가 자신의 commit에 대해 `vectorSidecarCount`를 선언했는데 사이드카가 없으면 기존 `vector_dependency_count_invalid`가 계속 차단한다. 매니페스트·레코드 샤드·아카이브 같은 구조 의존성은 그대로 필수다. 남아 있는 벡터와 원본 바이트는 변경하지 않는다.

검증은 실제 제공된 아카이브 샤드 0을 그대로 넣어 수행했다. 수정 전에는 `shard:0000`에서 `162k7zd:0000` 34건·`162k7zd:0001` 30건이 재현되어 제공된 113건과 건수까지 일치했고, 수정 후 같은 입력에서 해당 의존성 차단이 사라지고 `warningCount` 64가 집계되었다. 참조된 사이드카를 인벤토리에 넣으면 경고도 0이 되고, 다른 저장 원본에만 존재하는 경우와 선언된 사이드카가 없는 경우는 회귀 검사에서 계속 차단됨을 확인했다. `global_owner_discovery_adapters_test.cjs`(220 시나리오)와 이전·진단·GUI 회귀를 통과했다.

### Flashback 1.1.7 읽기·복원 호환과 SDK 1.8.33 경고 전달

1.1.5의 이전 검사는 bucketed_v1 manifest에 남은 commitId를 허용했지만,
실제 읽기와 복원은 버킷 envelope에도 같은 commitId가 있어야 한다고 검사했다.
합성 32버킷·45기록에 과거 commitId를 넣으면 이전 검사는 통과하고 실제 읽기는
0기록/손상 32샤드, 복원은 flashback_shard_commit_mismatch로 실패했다.
이제 이 형식은 검증된 전체 버킷 디렉터리와 envelope 해시를 기준으로 읽고
복원한다. manifest의 과거 commitId와 count 0을 포함한 원본 바이트를 보존한다.
일반 commit 샤드의 commit 일치 검사와 버킷 누락·변조 차단은 유지한다.

1.1.6의 누락 벡터 경고 정책도 복원 검증과 연결했다. 실제 페이로드가 없고,
복원 원본 후보에도 없으며, 현재 commit의 필수 사이드카로 선언되지 않은
Flashback 벡터 키의 참조는 원문·과거 참조·대기 상태를 그대로 복원하며 경고와 누락 건수를
반환한다. 원본 후보에 존재하는데 목적지에 없거나, 실제 값이 손상됐거나,
읽기에 실패하거나, 현재 commit의 사이드카 선언과 개수가 맞지 않으면 계속
실패한다. 쓰기/유지보수의 엄격한 vector audit verified 기준은 바꾸지 않았다.
원문 checksum, scope/commit, manifest 통계와 아카이브 member digest 검사도 유지한다.

공통 SDK는 warnings/warningCount를 전체 이전 요약, 일반 디버그 내보내기,
작업 계획과 완료 결과에 전달한다. 전환 확인 화면, 상세 진단과 완료 카드에서
경고를 볼 수 있고, 완료 경고는 플러그인 재시작 후에도 남는다. 허용된 진단
메타데이터만 전달하며 목록은 최대 256개로 제한하고 전체 건수는 보존한다.
저장 키 외에 기억 본문이나 인증 필드를 추가로 내보내지 않는다.

Flashback 1.1.7, LIBRA 2.4.8, HAYAKU 3.1.4가 SDK 1.8.33을 포함한다.
GRADIA/LIA/RE:TRACE의 보존된 SDK 변형은 기존 pin으로 검증한다.

회귀 검증은 합성 자료를 사용했다. 버킷 테스트는 비어 있지 않은 과거 commitId의
실제 읽기·물리 복원·portable 왕복을 검사한다. 새
flashback_missing_vector_restore_test.cjs는 누락 벡터의 경고 복원과 정상 벡터,
복사 누락/손상/읽기 실패/잘못된 저장소 참조/필수 사이드카 누락/원문 checksum 실패를 구분한다.
첨부 구조와 같은 합성 아카이브 64기록과 누락 참조 34/30건의 member digest 및
원본 바이트 보존, 변조된 아카이브 차단도 검사한다. 실제 GUI → 서버 → 재시작 →
기기 복원에는 과거 commitId 버킷과 벡터 누락 기록을 함께 넣고 확인 화면·
완료 카드·작업 진단의 경고를 검사한다. 실제 사용자 데이터와 벡터는 변경하지 않았다.

이 수정은 이전을 막던 차단만 해제하며, 이미 사라진 벡터 페이로드를 복구하지 않는다. 해당 113건은 이전 후에도 키워드 전용으로 남으며 벡터 회상에 다시 쓰려면 임베딩 재생성이 필요하다. 사용자 저장소의 실제 113건이 모두 이 경로인지(특히 라이브 스코프 7건은 자기 commit의 사이드카를 가리킨다)는 각 시점 매니페스트의 `vectorSidecarCount`로 확인해야 한다.

