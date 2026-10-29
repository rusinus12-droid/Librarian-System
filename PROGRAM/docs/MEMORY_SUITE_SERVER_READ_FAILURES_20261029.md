# 하야쿠·플래시백 서버 조회 실패와 RE:TRACE 응답 미확인

분석 대상은 2026-10-29 11:53–11:57 사이의 디버그 내보내기 세 개(Flashback 1.3.8, HAYAKU 3.3.8, RE:TRACE 1.12.6), 그리고 `DATA/logs/server-debug*.jsonl`(읽기 전용)이다.

## 결론

플러그인 버전 불일치는 아니었다. `check_sdk_sync`에서 다섯 플러그인의 내장 SDK는 모두 일치했다. RE:TRACE의 승계 계약 검사(`retrace_peer_runtime_compatibility_test`)도 네 소유 플러그인 실제 소스에 대해 통과한다. 원인은 실행 중에 생긴 세 가지 문제다.

### 1. 자동 백업 동안 서버가 읽기까지 거부함 (플래시백 목록 실패)

- 쓰기가 멈추고 45초가 지나면 `change-settled` 자동 백업이 실행된다. 이 백업은 서버 전체를 maintenance 상태로 바꾸고, `/v1/admin/` 외의 모든 요청에 `503 server_maintenance_in_progress`를 돌려줬다. 읽기 요청도 마찬가지였다.
- 11:53:19.396에 시작한 백업(약 1.2초, flashback 107MB·hayaku 12MB·libra 23MB) 동안 Flashback 읽기 28건이 거부됐다. 같은 일이 10:50(18건)과 11:10(4건)에도 있었다. LIBRA의 재분석·자동 복구처럼 쓰기가 많은 작업 뒤에 이런 백업이 자주 생긴다.
- Flashback 수동 편집 목록은 목록을 다 읽은 뒤 manifest를 다시 읽어 변경 여부를 확인한다. 그 재조회가 503으로 실패하자 "목록을 읽는 중 저장 내용이 변경되었습니다" 오류를 띄우고 그대로 멈춰 있었다.

**수정**
- `server.cjs`: `createBackup`이 maintenance를 직접 소유하는 동안에는 `backupReadWindow`를 켜고 읽기 전용 경로(`GET /v1/kv/get`, `GET /v1/kv/keys`, `GET /v1/integrity`, `POST /v1/kv/get-many`)를 그대로 처리한다. 쓰기는 계속 막는다. 백업 작업자는 체크포인트한 DB를 복사하고, 저장소 읽기는 maintenance 플래그를 보지 않는다. 복원·초기화·종료 단계에 들어가면 이 창을 즉시 닫는다.
- 공용 저장 SDK(`MemorySuiteStorageClient*.source.js`, Flashback·HAYAKU·LIBRA에 동기화): 백업 중 쓰기(`/v1/kv/set`·`remove`·`batch`)가 `503 server_maintenance_in_progress`를 받으면 같은 요청을 300ms씩 늘려 가며 최대 5회(약 4.5초) 다시 보낸다. 서버는 이 503을 쓰기 실행 전에 돌려주고 operationId와 조건값도 그대로이므로 재전송해도 안전하다. 그동안은 읽기가 백업 동안 막혀 기다리는 구조가 그 뒤의 쓰기까지 지켜 주고 있었다. 읽기를 열면서 전체 채팅 저장 방식 전환이 백업 중 `MEMORY_SUITE_GLOBAL_PUBLICATION_PENDING`으로 멈추는 문제가 드러났고, 이 재시도로 해결했다. 읽기 503은 재시도하지 않는다. 이를 직접 기다리는 작업(전체 전환의 최종 확인)의 대기·일시정지·취소 화면은 그대로 유지한다.
- `Flashback_Memory.js`: 목록 재조회에서 manifest가 달라 보이면 400ms·800ms 간격으로 두 번까지 다시 읽은 뒤에만 오류를 보여 준다.

### 2. HAYAKU 복사 채팅의 원장 반복 읽기 (HAYAKU `storage_unavailable`)

- 현재 채팅 "New Chat 4 (Copy 3)"은 네이티브 복사본이고, 원본 채팅에는 HAYAKU 원장이 없다(`copy_source_ledger_not_found`).
- `inferCopiedChatSource`는 제목과 메시지 앞부분이 일치하는 후보 채팅을 최대 48개까지 찾고, 각 원장 전체(최대 약 200KB)를 읽어 파싱한다. 그런데 "없음" 결과를 5초만 캐시했고, 동시에 들어온 범위 조회를 하나로 합치지 않았다.
- 서버 로그를 보면 HAYAKU 화면을 열 때마다 0.5초 안에 원장 읽기 200회 이상(약 25MB)이 몰렸다. 6분 동안 원장 읽기는 1,035회였다. 이 정도면 클라이언트가 막혀 HAYAKU 자신의 원장 읽기가 `storage_readback_timeout`이 되고 "현재 채팅 원장을 읽지 못했습니다"가 표시된다.

**수정 (`HAYAKU_Locator_Continuity.js`)**
- 같은 캐시 키·원장 세대의 동시 조회는 한 번의 후보 검사를 함께 기다린다.
- "없음" 결과도 60초 동안 캐시한다. 원장이 하나라도 쓰이면 원장 세대가 바뀌어 기존과 같이 즉시 무효화된다.

### 3. RE:TRACE가 실행 중인 플러그인을 "설치되지 않음"으로 표시

- 같은 시간대에 RE:TRACE에서 호스트 호출(`getCurrentCharacterIndex`)까지 1.8초 제한을 넘겼다. 네 플러그인의 IPC 시간 초과는 1·2번 때문에 호스트가 혼잡해진 결과다. LIBRA는 `ping`·`capabilities`에는 응답했고 `inspect`만 5초를 넘겼다.
- 그런데 호환 계약 검사는 응답이 늦은 플러그인을 `not_installed`("설치/연결되지 않았습니다")로 분류했다. 바로 위 줄의 "리스너 등록 · 응답 미확인"과 서로 맞지 않았고, 승계에 필요한 플러그인이면 승계가 막혔다.

**수정 (`RETRACE.js`)**
- 최근 10분 안에 응답했던 플러그인이 지금 시간 초과로 응답하지 못하면 `owner_unresponsive`("응답 지연", 실행 중이지만 바쁨)로 분류한다. HAYAKU·LIA에도 마지막 응답 시각을 기록한다.
- 진단 화면 배지를 "응답 지연"과 "응답 미확인"으로 구분하고 안내 문구를 나눴다. 플러그인 이름과 버전·사유를 줄을 바꿔 표시한다.

## 검증

- `server_backup_read_window_test.cjs`: 실제 서버와 임시 DATA에서 백업 작업자의 결과 전달을 붙잡아 백업 중임을 보장한다. 이 상태에서 get·keys·get-many는 200, set은 503을 반환하고, 백업이 끝나면 쓰기가 재개되는지 확인한다. 수정 전 서버에서는 읽기가 503이라 실패한다.
- `hayaku_copied_chat_source_read_coalescing_test.cjs`: 원본 원장이 없는 복사 채팅에서 동시 조회 6회가 원장 읽기 1회로 합쳐지고, 반복 조회가 캐시를 쓰는지 확인한다. 수정 전 코드에서는 같은 조건에서 메모리 부족(4GB)으로 실패한다.
- `storage_global_maintenance_wait_test.cjs`(24개 통과): 실제 백업 중 전체 전환 사례에서 최종 확인 읽기가 더는 대기하지 않고(`observed === false`) 세 범위 확인까지 끝나는 것으로 기대값을 바꿨다. 수정 전에는 백업이 읽기를 막았기 때문에 대기가 관찰됐다.
- 저장 클라이언트 묶음 56개 중 실패 6개(`storage_global_fresh_health_authority`, `storage_global_owner_public_gui`, `storage_mode_owner_parity_audit`, `storage_mode_publication_basic`, `storage_mode_special_parity_gates`, `storage_transition_gui_recovery`)는 직전 커밋 코드에서도 똑같이 실패하는 기존 실패다.
- 실제 RisuAI 호스트와 사용자 DATA를 쓰는 서버에서는 실행하지 않았다.

## 후속: 플래시백 필름 보관함 (12:58·13:06 디버그)

- **응답 원문·세계선이 열리지 않음:** 현재 채팅(New Chat 4 (Copy 3))에는 저장된 Flashback 기억이 없어 manifest가 없다. `emptyManifest()`가 읽을 때마다 `updatedAt`을 현재 시각으로 채우기 때문에, 목록·세계선을 읽은 앞뒤의 manifest 동일성 비교가 항상 "변경됨"이 됐다. 그래서 재시도해도 "목록을 읽는 중 저장 내용이 변경되었습니다"로 끝났다. 저장된 manifest가 없을 때는 시각 대신 `absent`와 scopeKey로 동일성을 비교하도록 바꿨다.
- **스코프 레지스트리 4MB 초과(콘솔의 미러 쓰기 오류):** `rememberScope({...meta, ...manifest})`가 manifest 전체를 넘기면서, 레지스트리 항목마다 그 스코프의 `shardSummaries`(최대 약 98KB)가 함께 저장됐다. 레지스트리가 4.27MB가 되어 서버 단일 값 제한(4MB)을 넘었고 미러 쓰기가 실패했다. 이제 레지스트리를 쓰고 읽을 때 manifest 전용 필드(`shardSummaries`·`records`·`items`)를 뺀다. 현재 서버 레지스트리 기준으로 4.0MB가 170KB로 줄어든다. 줄어든 레지스트리는 다음 레지스트리 쓰기 때 저장된다.
- **스코프 정리에 현재 스코프가 없거나 위에 오지 않음:** 목록이 `updatedAt` 순으로만 정렬됐고, 아직 기억이 없는 현재 스코프는 레지스트리에도 없었으며 '기억 저장소' 보기에서 걸러졌다. 이제 표시할 때 현재 스코프를 항상 맨 위에 두고, 목록에 없으면 현재 채팅 정보로 행을 만들어 기본 보기에서도 보이게 했다.
- **채팅방 전환 속도:** 채팅을 전환할 때마다 4MB 레지스트리를 읽고 다시 썼다. 레지스트리 축소로 이 비용이 크게 줄어든다. 또 원본 벡터 복구가 필요한 복사 채팅은 범위를 확인할 때마다(약 17초 간격, 화면 갱신마다) 원본 스코프 전체를 읽은 뒤에야 복제를 중단했다. 이제 같은 원본 commit에서 실패한 결과를 10분 동안 기억해 다시 읽지 않는다. 오류 자체는 그대로 알린다. 원본을 복구하면 commit이 바뀌어 즉시 다시 시도한다.

검증: `flashback_empty_scope_and_registry_size_test.cjs`는 manifest 읽기에 몇 ms 지연을 넣은 저장소로 실행한다. 수정 전 코드에서는 실제 증상과 같은 "목록을 읽는 중 저장 내용이 변경되었습니다" 오류로 실패한다. 클론 벡터 복구 관련 테스트 4개와 저장소 열람 테스트는 통과한다. Flashback 테스트 154개 중 실패 12개는 직전 커밋에서도 똑같이 실패하거나(10개) 외부 산출물 디렉터리가 필요하다(2개).
