# LIBRA·HAYAKU 리콜 차단과 Flashback 성공 비교

첨부된 LIBRA 2.6.8, Flashback 1.3.8 로그와 앞서 받은 HAYAKU 3.3.8 로그를 진단 자료로 비교했다. 수정은 `investigate/hayaku-connection-recovery-20261026`에서 앞선 복구 저장 수정에 이어 진행했다. 사용자 기억을 삭제하거나 재분석하지 않았으며, 외부 모델 API를 호출하지 않았다.

## 같은 요청 구간에서 보인 차이

| 플러그인 | 확인된 결과 | 진단 |
| --- | --- | --- |
| LIBRA | 선택 0·주입 0 | `unified_graph_query` 단계에서 `READ_ROUTE_RESET_UNAVAILABLE`. 전체 30초 예산 중 약 2.1초에 종료됐고, 이 요청은 시간 초과가 아니다. |
| HAYAKU | 검색 전에 중단 | 원장 재검증이 `HAYAKU_READSET_AUTHORITY_CHANGED`로 거부됐다. `lastViewerRecall`, `lastSparseSearch`도 비어 있다. |
| Flashback | 후보 12개 중 4개·3,970자 반환 | `delivery.stage=returned_to_hook`, `knownUniqueOriginalTurns=2`. 실제 요청 반환까지 확인된다. |

Flashback은 같은 서버의 자기 저장소에서 자료를 읽었다. 최근 메시지 5개로 만든 Voyage `voyage-4-large`의 1,024차원 벡터와 sparse/exact 후보를 결합했다. 대화 임베딩 모드는 `semantic_embedding`, 폴백은 없고, 리콜 당시 원문 레코드 13개 중 해당 세계선 등에 맞는 후보 12개를 구성했다. `peerDataUsed=false`이고 독립 모드이므로 LIBRA나 HAYAKU의 기억을 대신 사용한 성공이 아니다. 요청 훅 전체 시간은 약 3.4초였다.

따라서 이 구간을 세 플러그인의 공통 서버 장애나 임베딩 제공자 장애로 설명할 수 없다. LIBRA와 HAYAKU는 검색 결과의 유사도를 계산하기 전에 각자의 읽기 검증에서 중단됐다.

## LIBRA의 초기화 확인 기록과 리콜

기존 읽기 경로는 `memory_suite_reset_choice.v2.libra`가 비어 있지 않으면 무조건 `READ_ROUTE_RESET_UNAVAILABLE`을 발생시켰다. 정상적으로 서버 초기화를 확인한 뒤 남은 기록도 같은 방식으로 거부됐다. 일반 서버 읽기는 이미 인증된 확인 기록을 사용하는데, 소유 플러그인의 리콜 경로만 이를 미해결 초기화로 취급했다.

소유 플러그인 읽기에 한해 다음 조건을 확인한 기존 기록을 허용한다.

- 이미 수락된 서버 연결이 존재하고 데이터 식별자가 인증돼 있다.
- 저장된 확인 기록의 namespace·서버 주소·물리 DATA ID·인증 계약·초기화 세대가 일치한다.
- 현재 설정 주소도 같은 서버이고, 선택 스코프가 삭제 대상으로 기록되지 않았다.
- 플러그인 로컬 복사본을 서버 정본으로 인정하지 않는다.

읽기 핸들은 확인 기록 자체도 묶어 두므로 기록이 중간에 바뀌면 무효화된다. 새 연결, 초기화 수락, 마이그레이션이나 저장은 관측 과정에서 실행하지 않는다. 외부 읽기 경로는 기존 차단 조건을 유지한다.

첨부에는 초기화 확인 기록 본문이 없어 사용자의 기록이 위 조건을 만족하는지는 직접 확인하지 못했다. 정상 확인 기록을 넣은 재현 테스트는 수정 전에 실패하고 수정 후 성공한다. 다른 서버·다른 DATA·다른 세대·잘못된 선택·삭제된 스코프는 계속 거부된다.

SDK 동기화 과정에서는 최신 main의 LIBRA 삽입본에만 있던 로컬 설정 저장 정책을 SDK 원본에도 반영했다. 기존 `MemorySuiteConfigStorageBridge`의 오프라인 설정 저장을 보존했고, 앞선 조사에서 보고된 SDK 원본/삽입본 불일치도 해소됐다.

## HAYAKU의 자체 저장과 호스트 DB 재검증

HAYAKU는 읽은 자료가 그대로인지 확인하면서 `getDatabase()`의 전체 반환값을 비교했다. 호스트 DB에 pluginStorage가 들어 있으면 HAYAKU 자신의 증거·원장 저장도 그 DB를 바꾼다. 원문과 설정이 같아도 자기 저장 때문에 `HAYAKU_READSET_AUTHORITY_CHANGED`가 재현됐다. 다른 플러그인의 저장도 같은 종류의 불필요한 변경을 만들 수 있다.

호스트 DB에서는 리콜이 사용하는 모델·컨텍스트 예산·페르소나 필드를 명시적으로 읽는다. 선택된 캐릭터와 전체 대화 원문, 요청 입력, 설정 인수, 입력 규칙, 저장 모드·주소·초기화 기록·저장소 제공자 및 원장 헤드의 기존 검증은 유지한다. 이미 별도로 검증하는 플러그인 저장 바이트를 전체 DB에서 중복 비교하지 않는다.

자기 pluginStorage를 DB에 포함하는 재현 테스트가 수정 전과 동일한 오류를 냈고, 수정 후 원장 저장과 리콜 주입이 완료됐다. 사용자 로그는 세부 비교 항목을 남기지 않아 해당 사용 환경의 모든 거부가 이 원인이라고 단정하지는 않는다.

## `UNIFIED_REPLAY_ARTIFACT_MISMATCH`는 별도 미해결 항목

이 오류는 LIBRA가 저장된 정본과 저장 근거를 다시 검증할 때 발생한다. 시작 시 상태 추적 복구 2건이 이 오류로 남아 있으며, 리콜의 `READ_ROUTE_RESET_UNAVAILABLE`과는 다른 경로다.

기존 오류는 다음 검사를 하나로 묶었다.

1. 완성된 원문 5쌍인가.
2. 저장 근거로 다시 계산한 원문 해시가 같은가.
3. 원문 메시지 ID와 턴 목록이 같은가.
4. 정본 artifact와 인용 근거가 현재 읽기 계약을 만족하는가.
5. artifact를 다시 표시한 텍스트가 저장된 표시 텍스트와 같은가.

검사를 유지하면서 오류에 실패 단계(`:sourcePairs`, `:artifactValidation`, `:renderedText` 등)를 추가했다. 디버그 JSON의 `lastUnifiedReplayValidation`에는 기억 ID·revision·턴 범위·통과한 검사와 실패 단계·검증 코드만 기록한다. 원문이나 기억 본문을 추가로 노출하지 않는다. 불일치를 무시하거나 정본/State를 자동으로 덮어쓰지 않는다.

첨부 LIBRA JSON에는 해당 `canonicalArtifact`, `text`, `sourcePairs`, 연결된 `sourceEvidenceRef` 본문이 없다. 따라서 정확한 실패 항목과 기존 기억의 수리 방법은 아직 확정할 수 없다. 다음 진단에는 실패한 기억의 정본·근거가 포함된 메모리 백업, 또는 수정본에서 오류를 다시 발생시킨 뒤의 `lastUnifiedReplayValidation`이 필요하다. 첨부의 정규화·부분 저장 경고만으로 실패한 정본을 재구성할 수는 없다.

## 검증 결과

아래 8개 테스트 파일을 실행해 모두 통과했다. 합성 대화와 제어된 모델 응답을 사용했고, HTTP 검증은 임시 localhost 서버와 SQLite에서 실행했다.

- `libra_owner_reset_recall_route_test.cjs`: 인증된 초기화 확인 기록·읽기 중 변경·외부 읽기·다른 DATA/주소/세대·삭제된 스코프, 6개.
- `hayaku_host_database_recall_runtime_test.cjs`: 실제 등록된 beforeRequest 훅에서 자기 저장 이후 리콜 완료, 1개.
- `libra_unified_replay_diagnostic_runtime_test.cjs`: 표시 텍스트와 메시지 ID 불일치 구분, 정본·State·모델 호출 수 보존.
- `libra_unified_world_replay_v2_test.cjs`: 재검증·손상 근거 거부·재시작·실패 보존, 21개.
- `libra_read_context_basic.test.cjs`: 읽기 핸들·네이티브 ID·전환·스토리지 변경·외부 경계, 21개.
- `libra_offline_server_settings_save_test.cjs`: 기존 오프라인 설정 저장 유지.
- `hayaku_inline_ledger_readset_runtime_test.cjs`: 원문·선택·예산·설정·저장소·동시 요청·전환·삭제 검증, 38개.
- `libra_memory_graph_reader_runtime_test.cjs`: 로컬/서버에서 정본·단일 턴 기억·상태·로어 그래프 읽기, 읽기 중 저장·모델 호출 0회.

SDK 동기화, 두 플러그인 구문 검사 및 `git diff --check`도 통과했다. 전체 제품 회귀·실제 사용자 DATA 수리·배포·사용자 설치본 적용을 완료했다고 판단하지 않는다.
