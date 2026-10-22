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

일반 디버그 내보내기에는 마지막 전체 이전 검사 결과가 누락되어 있었다.
공통 SDK에서 마지막 검사 결과의 허용된 메타데이터만 메모리에 보관하고
`memorySuite.migrationPreview`로 내보내도록 보완했다. 플러그인 단독 모드에서
서버 진단을 생략하거나 현재 선택 채팅이 달라도 실패 정보가 포함된다.
새 검사는 이전 결과를 교체하며, 내보내기는 원본/저장 경로를 수정하지 않는다.

## 검증

- `global_owner_discovery_adapters_test.cjs`: 174개 시나리오 통과. 오래된
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
- `libra_global_archive_evidence_restore_test.cjs`: 9개 시나리오 통과.
- `storage_global_allchat_job_test.cjs`: 3개 소유자의 전체 이전과 불완전한
  호스트 목록 차단 통과.
- `server_diagnostics_export_test.cjs`, SDK 동기화/진단 계약 검사 통과.
- 기존 Flashback 저장 로더 55항목, raw page 참조 26개 시나리오,
  portable vector sidecar 검사 통과.

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
사용자 호스트의 플러그인 교체나 실제 기억/벡터 재생성, 배포 ZIP 발행은 수행하지 않았다.
