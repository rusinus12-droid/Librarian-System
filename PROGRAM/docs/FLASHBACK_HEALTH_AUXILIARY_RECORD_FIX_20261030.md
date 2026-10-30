# Flashback 서버 점검 관리 기록 호환성 패치 — 2026-10-30

사용자가 제공한 Flashback 1.3.8 진단 파일과 현재 코드·읽기 전용 DATA 조회를 대조했다. 원인은 현재 채팅에 보존된 `source-edit-consent:v1` 기록을 서버 스냅샷 점검기가 지원하지 않는 항목으로 취급한 것이다. 이번 작업은 패치와 동종 결함 조사이며, 설치·릴리즈·사용자 데이터 복구 작업은 수행하지 않았다.

## 수정 결과

| 경로 | 확인한 결함과 수정 |
| --- | --- |
| 서버 스냅샷 → Flashback 점검 | 서버와 플러그인 양쪽에서 정확한 `source-edit-consent:v1` 키를 허용한다. 원래의 소유 범위·digest·revision·용량·현재성 검증을 통과해야 한다. |
| 서버 벡터 복구 | 같은 동의 기록으로 `REPAIR_UNSUPPORTED_SCOPE_RECORD`가 발생하는 경로도 재현하고 수정했다. 해당 기록은 읽기 집합과 현재성 검증에 포함되며 복구가 그 내용을 변경하지 않는다. |
| 벡터 복구 → 다음 상태 점검 | 서버가 직접 생성하는 `server_physical_repair:v2` 및 정확한 작업 ID 형식의 기록은 기억 본문 검사 대상에서 제외한다. 메타데이터는 전체 inventory fingerprint에 남아 동시 변경을 감지한다. 복구 본문이나 복구 권한을 점검 결과에 승격하지 않는다. |
| 미완료 반환 → 디버그 내보내기 | 조기 반환도 마지막 점검 요약에 남긴다. 원문을 보유하지 않고, 반환 plan·debug 객체와 내부 진단 기록 사이에 가변 참조를 공유하지 않는다. |
| 미완료 반환 → 진단 창 | 공통 배너를 구성한 뒤에도 구체적인 미완료 사유를 표시한다. 미확인 수치를 0으로 표시하거나 복구 버튼을 활성화하지 않는다. |

임의의 다른 키를 일괄 허용하지 않았다. 알 수 없는 항목, 타 범위의 동의 기록, digest 불일치, 누락 샤드, 상한 초과, 서버/설정/호스트 변경은 기존 차단 조건을 유지한다.

## 다른 플러그인 조사

| 제품 | 조사한 실제 경로 | 이번과 같은 결함 |
| --- | --- | --- |
| LIBRA | `owner-scope-health.cjs` → `MemorySuiteLibraHealth.source.js` → `getServerScopeHealth()` | 발견하지 못했다. 보조 기록은 inventory에 남고 구조 검사 대상이 아닌 본문은 읽지 않는다. 보존된 동의 기록을 추가한 서버 전용·미러 모드 시험이 통과했다. |
| HAYAKU | `inspectHayakuMaintenance()` → 실제 원장·패킷·Recovery Vault의 지정 키와 참조 읽기 | 발견하지 못했다. 같은 범위의 추가 관리 기록을 넣은 점검·복구 시험에서 해당 기록과 채팅 원문이 보존됐다. |
| LIA | `MemorySuiteLiaHealth.source.js` → 실제 owner wiring 및 전체 플러그인 VM | 발견하지 못했다. 정해진 index/binding 키를 읽으며 보조 기록 때문에 전체 점검을 차단하지 않는다. |
| RE:TRACE | `MemorySuiteRetraceHealth.source.js` → 실제 owner wiring 및 전체 플러그인 VM | 발견하지 못했다. 정해진 자체 관리 키와 호스트 journal을 읽는다. 추가 보조 기록 및 저장·캐시 보호 시험이 통과했다. |
| GRADIA | 보존된 읽기 전용 SDK 및 서버 read-session consumer | Flashback 전용 점검의 호출자는 아니다. SDK에 같은 함수 선언이 있어도 `namespace !== 'flashback'` 차단이 있고 이 경로를 자체 점검기로 사용하지 않는다. 서버 읽기 전용 경로를 별도 검증했다. |

이는 위 점검 경로의 조사 결과이며 각 제품 전체의 무결성을 보증하는 판정은 아니다. 다른 플러그인의 제품 코드는 변경하지 않았고, 관련 호환성 검증만 추가했다.

## 실행 증거

- 실제 사용자 DATA의 같은 `commitId`를 읽기 전용으로 재조회하고 패치된 서버 점검 함수를 실행했다. 관리 기록을 삭제하거나 숨기지 않고 `snapshot_complete`, 6개 records/values, `skipped: []`가 됐다. 이는 해당 시점의 서버 스냅샷 검사이며 현재 RisuAI 대화·임베딩 제공자의 정상 판정은 아니다.
- 동의 기록, 타 범위 기록, digest 손상, revision 변경, 자체 복구 작업 기록, 알 수 없는 키, 읽기·권한·설정·호스트 변경을 포함한 서버 스냅샷/SDK/공개 점검 경로를 검증했다.
- 새 `flashback_server_inspection_consent_runtime_test.cjs`는 배포 서버 요청 처리기와 SQLite를 실행한다. HTTP 전송만 프로세스 내부 fixture이며 실제 소켓·사용자 DATA·외부 제공자를 사용하지 않는다. 동의 기록 보존, 미확인 항목 차단, 실제 `debugState()`의 미완료 사유 보존과 참조 분리를 확인한다.
- 인증된 서버 복구 요청 처리기와 실제 SQLite를 사용하는 공개 복구 시험에서 동의 기록이 있는 채로 원래 벡터를 복구하고 다음 상태 점검까지 완료되는 것을 확인했다. 기존 백업 증거·보안·경쟁·메타데이터 시험도 실행했다.
- 실제 Flashback GUI 코드를 Chromium iframe에서 실행했다. 1296×1200, 390×844에서 미완료 사유 표시, 4개 미확인 수치, 복구 버튼 비활성, 가로 넘침 없음, 확인 버튼 동작을 확인했다. 호스트는 fixture이며 실제 RisuAI GUI 검증은 아니다.
- 기존 서버 GUI 점검·누락 턴 동기화·대기 임베딩 처리 경로도 합성 제공자 응답으로 검증했다. 실제 임베딩 호출과 과금은 발생시키지 않았다.
- 선택한 기능·회귀 시험 26개 파일이 최종 실행에서 모두 통과했다. GRADIA read-adapter 파일은 포함된 기존 timeout 시험들로 최초 60초 실행 제한에 걸렸으나, 제한 없이 재실행해 58개 시험 모두 통과했다. LIBRA는 sandbox의 localhost 통신 차단 후 해당 로컬 시험만 권한을 조정해 서버 전용·미러 모드 모두 통과했다.

재현 전의 실패와 패치 후 통과를 확인했다. 상세 실행 로그와 Chromium 캡처는 로컬 `.development/evidence/flashback-health-20261030/`에 있다. 전체 회귀와 릴리즈 ZIP 검증은 수행하지 않았다.

## 별도로 발견한 기존 검사 실패

`node PROGRAM/tools/check_sdk_sync.cjs`는 LIA·RE:TRACE·GRADIA의 `preserved_storage_sdk_changed`를 보고한다. 세 파일을 각각 `git show HEAD:...`와 바이트 비교했고 모두 현재 파일과 같으며, HEAD 소스에도 동일한 기존 pin 불일치가 재현된다. 이번 패치에서 이 SDK나 pin을 수정하지 않았다. Flashback·HAYAKU·LIBRA의 검사 대상 SDK는 일치했다. 따라서 전체 SDK 동기화 검사를 통과했다고 보고하지 않는다.

`distribution_metadata_coherence_test.cjs`는 통과했다. `program_data_layout_test.cjs`는 현재 소스 체크아웃 루트의 `.claude`, 기존 `.test-output-*.log`, 이번 로컬 증거용 `.development` 등 때문에 배포물 전용 루트 목록 검사를 통과하지 못했다. 이를 통과시키기 위해 사용자 로그를 지우거나 검사를 완화하지 않았다. 깨끗한 배포물에서 이 gate를 통과했다는 주장은 하지 않는다.

매니페스트와 SHA256 목록은 최종 파일로 재생성했다. 재생성 과정에서 HEAD에 이미 추적되지만 기존 매니페스트에는 빠져 있던 보고서·시험 5개도 목록에 반영됐으며, 해당 파일 내용은 변경하지 않았다.

## 적용 범위

제품 수정은 Flashback 플러그인과 서버의 점검·복구 모듈에 한정된다. 기존 `DATA/data-layout.json` 변경을 보존했으며 사용자 DATA에 쓰기·이관·재구축을 수행하지 않았다. 버전 상승·배포·커밋은 하지 않았다. 로컬 소스 패치를 실제 사용 환경에 반영하려면 Librarian 서버를 재시작하고 패치된 Flashback 파일을 다시 불러온 뒤 상태 점검을 실행해야 한다.
