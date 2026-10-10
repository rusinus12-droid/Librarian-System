# Librarian System 0.3.21 · BOOK_UX V5.18
## 네이티브 브랜치 원문 검증 패치 및 검증 보고

작성일: 2026-09-05

## 1. 배포 상태

인계 문서를 계획으로 취급하고 입력 패키지 0.3.20에서 실제 코드를 수정했다. 이번 수정본에서 **전체 회귀 스크립트 256개를 실행해 256개 통과, 실패 0개, 시간 초과 0개**를 확인했다. 기존 스크립트 248개와 신규 스크립트 8개를 합친 수이며, 개별 assertion 개수나 실제 브라우저 시험 횟수가 아니다.

실제 RisuAI 브라우저·외부 모델·모바일에서의 수용 시험은 수행하지 않았다. 이 배포를 ‘모든 실환경 동작 검증 완료’라고 주장하지 않는다. 아래 미검증/잔여 항목도 배포 범위의 일부로 읽어야 한다.

| 구성 | 이전 | 이번 배포 |
|---|---|---|
| Librarian System / 서버 | 0.3.20 | 0.3.21 |
| BOOK_UX 패치 단계 | V5.17 | V5.18 |
| LIBRA | 2.3.27 | 2.3.28 |
| HAYAKU | 3.0.44 | 3.0.45 |
| Flashback | 1.0.27 | 1.0.28 |
| LIA | 0.26.62 | 0.26.63 |
| RE:TRACE | 1.9.66 | 1.9.67 |
| Storage SDK / Compute SDK | 1.8.14 / 0.3.4 | 유지 |
| Host Lineage SDK | 없음 | 1.0.0 |

Storage/Compute SDK의 버전과 저장 프로토콜은 이번 호스트 분기 보완 때문에 임의 변경하지 않았다. 새 Host Lineage SDK는 원문 관찰/검증용으로서 LLM 호출·네트워크·별도 영속 메모리 권위를 만들지 않는다.

## 2. 호스트에서 실제로 확인한 동작

RisuAI2026.8.250의 네이티브 분기는 현재 chat을 snapshot한 뒤 **새 chat ID**를 만들고 선택 메시지까지 복사한다. 부모 chat ID·이름·분기 메시지 ID를 담은 `specialcomment::branchedfrom` 댓글이 뒤에 붙는다. 원본의 부가 필드도 함께 복제되므로 오래된 `copiedFromChatId`가 남을 수 있다. chats 앞에 새 항목을 넣기 때문에 chatIndex는 고정 ID가 아니다.

리롤은 같은 chat에서 마지막 메시지 data를 바꾸거나 suffix를 교체한다. 동일 message ID를 유지하는 경로가 있다. 단일 삭제는 splice, 이후 메시지 되돌림은 slice로 기존 배열을 바꾼다. 원문 편집도 data 변경이다. output listener는 모델 출력 확정 시점의 snapshot을 제공하는 API이지 모든 분기·선택·삭제의 전용 이벤트가 아니다.

호스트 ZIP과 추출 파일 586개를 SHA-256으로 대조했고 변경은 0개다. 호스트를 빌드/실행한 결과는 아니다. 정확한 함수와 줄 범위는 `HOST_RISU_2026_8_250_AUDIT.md`에 기록했다.

## 3. 수정 사항

### 공통 분기 식별과 U+A 계산

마지막8개 메시지에만 의존하지 않고 전체 메시지에서 마지막의 실제 disabled/comment 분기 표식을 찾는다. 일반 대화에 인용된 표식 문자열은 증거로 취급하지 않는다. 중첩 분기, 이름에 `::`가 들어가는 경우, 잘못된 표식, 중복 부모/분기 ID, 조상 경로 단절, 자기 참조를 구별한다.

부모와 자식의 공통 원문은 역할·메시지 ID·본문·disabled/comment·화자 정보를 정확 비교한다. 진단용 digest만 같다고 승계하지 않는다. 불명확한 부모 관계는 미검증으로 남기고 다른 후보로 조용히 우회하지 않는다. 직계 부모 prefix 검증과 전체 조상 경로 검증은 별도 필드다.

실제 plugin 실행 검사에서 **분기 안내 댓글이 assistant 응답으로 집계되는 결함**을 발견했다. LIBRA/HAYAKU/Flashback/LIA의 U+A 계산과 관련 캐시에서 disabled/comment 메시지를 제외했다. 호스트 댓글을 삭제한 것이 아니라 기억 계산에서 제외한 것이다.

### LIBRA: 연속 5턴 정본만 승계

기존처럼 뒤쪽에서 다시 일치하는 구간을 독립적으로 채택하지 않고, 처음부터 연속으로 일치하는 공통 prefix 안의 완성된 5턴 정본만 후보로 삼는다. 7완성턴에서 분기하면 1–5 정본만 승계할 수 있고 6–7은 새 정본이 아니다. 실제 정본이 없거나 원문 digest가 맞지 않으면 ‘승계 가능 범위’만으로 완료 처리하지 않는다.

네이티브 표식의 직계 부모를 오래된 copy metadata보다 우선하고, 저장 활성화·완료 표식 전 부모/자식의 현재 원문과 scope를 다시 확인한다. 부모의 현재 Story Arc/Head를 과거 분기의 상태로 그대로 복사하지 않는다. 정본 전달 뒤 상태 계층 복원은 기존 파이프라인을 사용하고 실패/보류를 구별한다. 이 상태 복원은 설정에 따라 기존 State observer 호출을 할 수 있으며, 정본 승계 자체와 Ariadne 재분석은 별개다.

### HAYAKU: 분기 전 실제 응답 패킷만

검증된 부모와 완성 U+A prefix를 기준으로 복구 패킷과 lineage rebase 범위를 제한했다. 원문/owner 검증을 통과한 실제 패킷을 사용하며, 부모가 이후 생성한 패킷이나 user에서 끝난 불완성 턴은 새 branch의 완료 패킷으로 세지 않는다. 이전 자료를 삭제하거나 증거 없는 scaffold 패킷을 새로 만드는 수정은 아니다.

### Flashback: 저장된 원문과 대조한 뒤 완료

부모 shard의 실제 U+A와 새 branch의 공통 원문을 대조한다. 완전한 사용자+assistant 그룹만 가져오고 source shard checksum을 재검증한다. 부모의 미래 live episode index는 승계하지 않는다. source 검증·worldline 저장·manifest 활성화·durable readback 순서를 적용했고, 복사 도중 원문이 달라지면 완료 manifest가 생기지 않도록 했다.

실패 시 비활성 staging shard/metadata가 남을 가능성과 모든 실패 지점의 공간 회수는 별도 잔여 항목이다. 원본 shard와 source commit은 보존한다.

### LIA: 최신 부모 Head 대신 과거 checkpoint

새 분기의 범위에 해당하는 연속 처리 ledger와 fingerprint를 검증해 liveState/coreOverlay를 복원한다. 부모의 최신 Persona Head를 과거 분기에 복사하지 않는다. parent owner가 확인되어 fork를 만드는 경로에서 과거 근거가 없으면 target Persona를 분리하되 일시정지/미검증 상태로 둔다.

분석 중 처리 batch보다 앞선 원문이 수정되는 경우도 antecedent fingerprint로 감지한다. 다른 Character의 binding을 가져오지 않는다. 다만 **부모 binding 자체를 찾을 수 없는 경우** 및 **이전 버전이 이미 만든 current-scope binding의 migration**은 자동 교정 완료 범위가 아니다. 아래 잔여 항목을 참조한다.

### RE:TRACE: 실제 현재 scope와 늦은 화면 결과 분리

Overview 비동기 결과를 채택하기 전에 최신 Character/chat ID와 원문 revision을 다시 읽는다. 분기를 옮겼거나 원문이 바뀌었다면 이전 화면의 READY/호환성 결과를 새 화면에 표시하지 않는다. 다음 세션 생성은 기존 fresh Character 기반 target-only writer를 유지했고, 원본/형제 세션 변경 보존·write/readback 실패 검사를 다시 실행했다. handoff metadata의 source lineage와 target lineage를 혼동하지 않는다.

### 서버와 GUI

서버에 선택적인 `librarian.host_lineage.v1` metadata 검증을 추가했다. owner/Character/chat, 숫자 범위, 경로 마지막 ID, canonical prefix 일관성을 검사한다. 서버는 실제 원문을 읽은 검증자가 아니며 metadata를 저장했다고 승계 권위가 생기지 않는다. 기존 opaque/legacy payload 호환, 정상 인증, plugin_only/mirror/server_only 정책, reference-v2 비활성화를 유지했다.

기존 BOOK_UX의 실제 읽기 화면/보조 작업대에 readonly 분기 상태를 연결했다. 새롭다고 보이기 위한 가짜 전환/복구 버튼은 추가하지 않았다.

| 실제 GUI 진입점 | 읽기/검증 경로 | 표시 및 결과 연결 |
|---|---|---|
| LIBRA `buildBookHostLineagePanel` | 현재 snapshot / native copy / scope 재검증 | 부모·분기점·공통구간, 실제 정본 승계/상태 보류와 구별 |
| HAYAKU `viewerRenderHostLineage` | currentChatScope / 실제 worldline ledger | 실제 owner scope의 검증 상태 |
| Flashback Overview `fbHostLineage` | fresh scope / manifest의 copy 결과 | 부모·범위, 재사용 GUI root에서도 현재 scope로 갱신 |
| LIA Persona sidepanel | 실제 runtime context / scope binding | 분기 관계; 상세 checkpoint/paused receipt는 binding 및 status API로 확인 |
| RE:TRACE Overview | getCurrentContext / preview / 최신 원문 재확인 | 이전 branch의 늦은 결과 폐기, 실제 handoff 저장 판정과 분리 |

이 표는 코드 연결 검사이지 브라우저 픽셀/클릭 시험표가 아니다. 각 플러그인 `getHostLineageStatus` read API도 현재 scope를 읽으며 저장 명령으로 동작하지 않는다.

## 4. 원문 수정 동의와 데이터 보존

승인 문구는 “원문이 수정된 것을 감지했습니다. 재분석을 진행하시겠습니까?”를 유지한다. source revision이 바뀐 리롤/편집을 자동 승인으로 취급하는 새 예외를 추가하지 않았다. 동의 state machine, SafeElement dialog의 승인·취소·Escape·키보드·바깥 클릭·dispose 경로와 기존 복구/늦은 저장 검사도 이번 전체 실행에 포함된다.

기존 메모리/정본 수동 교정/원본 채팅/형제 채팅/owner 저장 경계를 삭제하거나 리셋하지 않는다. canonical과 상태 계층은 구별하고, LIBRA외 owner의 데이터로 LIBRA 정본을 대신 만들지 않는다.

## 5. 실제 실행 결과

| 실행 | 스크립트 수 | 결과 | 의미 |
|---|---:|---|---|
| 입력 0.3.20 기준선 재실행 | 248 | 248통과 | 이번 환경의 기준선; 신규 패치 통과 수로 전용하지 않음 |
| 첫 수정본·manifest 재생성 전 | 248 | 247통과 / 1실패 | `program_data_layout_test.cjs` SHA 불일치. 소스 변경 후 구 manifest였던 중간 결과도 증거 ZIP에 보존 |
| 최종 수정 코드 | 256 | **256통과 / 실패0 / 시간초과0** | 기존248 + 신규8 스크립트 |

신규8개는 다음과 같다.

| 스크립트 | 검사 범위 / 방법 |
|---|---|
| `native_branch_host_lineage_test.cjs` | 실제 SDK, 오래된/중첩 marker·동일ID 원문변경·중복부모·불완전턴 등25개 named case |
| `native_branch_libra_prefix_test.cjs` | 실제 selector 함수, 5턴경계·뒤쪽 재일치·원문 digest 경계 |
| `native_branch_libra_runtime_test.cjs` | 전체 LIBRA plugin VM, 실제 canonical 생성/분기 승계/readback; host/storage/model 경계만 대체 |
| `native_branch_hayaku_runtime_test.cjs` | 전체 HAYAKU plugin VM, 실제 packet 저장/검증·branch 범위·부모 변경 |
| `native_branch_flashback_runtime_test.cjs` | 전체 Flashback plugin VM, 실제 U+A shard 복사·저장확인·복사 중 원문 변경 fault |
| `native_branch_lia_runtime_test.cjs` | 전체 LIA plugin VM의 실제 checkpoint projection/batch guard, 잘못된 owner·missing ledger·늦은 antecedent 변경 |
| `native_branch_retrace_gui_scope_test.cjs` | 실제 Overview 함수 + 경계 fault, 현재 scope 유지/branch전환/원문변경 |
| `native_branch_server_metadata_test.cjs` | 실제 서버 validator13개 case; 이 신규 테스트 자체는 HTTP E2E가 아님 |

기존 서버/저장 모드·장애·복구·scope 전환·source edit consent·durable commit·UI lifecycle 회귀도 함께 실행했다. 신규 test와 오래된 test의 PASS 문자열을 합해 assertion 수를 부풀리지 않았다. production JS와 새 SDK/서버 파일의 SHA는 `TESTED_PRODUCTION_SHA256.json`, 전체 로그는 `FINAL_V518_REGRESSION.txt`에 있다.

## 6. 아직 검증하지 못한 점과 남은 작업

실제 RisuAI 실행 화면에서 branch/reroll/rollback을 클릭하며 모든 owner와 외부 모델을 통합 시험하지 않았다. SafeElement 실제 rendering, iOS/Android UI, 장시간 실제 대화, 모바일 메모리·성능 수치도 없다. 자동 fixture의 성공을 이 시험의 성공으로 대체하지 않는다.

LIA parent binding이 소실되었거나 접근할 수 없으면 `no_inherited_live_owner`로 정지할 수 있다. 호스트가 복사한 `bindedPersona`까지 자동으로 안전한 target-only Persona로 교정했다는 보장은 없다. 기존 current-scope binding을 새 규칙으로 무조건 재작성하지도 않는다. 이 부분은 별도 비파괴 migration/격리 작업이 필요하다.

Flashback 실패 staging 자료의 모든 회수 지점, 원본/형제 동시 writer의 실제 경합, raw backup/import로 metadata를 가져온 뒤의 실제 서버 통합 시험은 추가 확인 대상이다. 서버 validator만으로 호스트 원문 일치가 증명되지는 않는다.

RisuAI get/set에는 이 코드가 사용할 수 있는 host-level compare-and-swap이 없으므로 마지막 fresh read와 write 사이의 전역 원자성을 보장하지 않는다. 이번 패치는 재검증·scope 격리·실패 판정·durable readback을 강화한 것이지 전역 잠금을 구현한 것이 아니다.

정확한 후속 절차와 함수 진입점은 `CONTINUATION_V518.md`에 남겼다.

## 7. 업데이트 방법

서버를 종료하고 기존 DATA 전체를 백업한다. **기존 DATA는 그대로 유지하고 PROGRAM만 교체**한다. RisuAI에는 `PROGRAM/plugins`의 5개 JS를 각각 기존 플러그인 대신 교체 설치한 뒤 서버/RisuAI를 재시작한다. ZIP의 빈 DATA는 신규 설치용이며 기존 DATA 위에 덮어쓰지 않는다.

StorageSDK/프로토콜을 새 이름으로 갈아치워 기존 기록을 고립시키는 배포가 아니다. old source history/수동 정본을 삭제하고 다시 시작할 필요가 있다는 안내도 하지 않는다. 최초 실사용 확인은 복제한 테스트 DATA에서 수행하는 편이 안전하다.

## 8. 배포 검증 자료

배포 builder는 최종 manifest와 전체 SHA를 재생성하고 clean DATA, canonical5개 JS, 실행 스크립트 권한, UTF-8 파일명, private data 제외, release smoke7개를 검사한다. 실제 배포 결과와 새 디렉터리 추출 검사 수치는 별도 검증 ZIP의 `DISTRIBUTION_BUILD_REPORT.json` / `FRESH_EXTRACTION_VERIFICATION.json`를 기준으로 한다. 이 문서를 쓰는 시점의 예정 수치를 결과처럼 기입하지 않았다.
