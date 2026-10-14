# LIBRA 통합 메모리 엔진 — 다음 과제와 완료 기준

- 작성일: 2026-10-14 · 문서 버전: 1.0
- 코드·호출 경로 기준: `codex/libra-memory-network-20261013`, [`3e589ddcdb9fa10e7d22f1f38e8d61cd4025f4db`](https://github.com/rusinus12-droid/Librarian-System/commit/3e589ddcdb9fa10e7d22f1f38e8d61cd4025f4db)
- 관련: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [현재 현황](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), [native semantic 계약](LIBRA_UM3_NATIVE_SEMANTIC_CONTRACT.md), [제품 역할·퇴역 계약](PLUGIN-ROLE-AND-STORAGE-DESIGN-20261007.md)
- 판정: **정본 저장 벡터와 질의 임베딩은 하나의 scorer/frontier에 연결됐다. 전체 기록의 영속 접근, GRADIA의 새 엔진 연결, 실제 품질·성능 인증과 기본값 전환은 미완료다.**

이 문서는 소비자 호출 경로 재검토를 반영한 현재 작업 계획이다. 이전 설계·현황 문서에서 LIBRA의 Planner·SGA·Input Writer를 활성 연결 대상으로 적은 부분을 정정한다. 과제 정의는 구현 완료나 배포 자격을 부여하지 않는다.

## 1. 확인한 실행 범위

| 대상 | 코드·검사로 확인한 상태 | 다음 작업의 의미 |
| --- | --- | --- |
| LIBRA Classic | 기억 근거를 전달하는 현재 응답 경로. 명시적 unified 설정의 최종 전달은 등록 합성 호스트에서 검증 | 전체 기록의 통합 검색·실제 호스트 검증으로 확장 |
| LIBRA GUI | 현재 기억 열람·진단 화면은 활성 상태 | 통합 결과·출처·시간·coverage·실제 채택 정보를 읽는 표시 adapter 연결 |
| LIBRA Planner·SGA | 실행 함수와 공개 실행 API 제거. 예전 응답 설정도 Classic으로 정규화 | 실행 경로를 복원하는 과제로 잡지 않음 |
| LIBRA Input Writer | 실행 함수·공개 API·작성기 버튼 등록 제거 | 인풋 작성 기능의 소유자는 별도 GRADIA |
| GRADIA 셰도우·AIDE | 기존 서버 읽기 전용 연결과 요청별 근거 전달 경로가 있음 | 기존 읽기 권한·현재성 계약을 유지하며 새 통합 엔진의 결과를 읽도록 연결 |
| GRADIA 인풋 작성기 | 작성 기능은 활성. 현재 기억 회수를 하지 않으며 이전 실행의 근거도 받지 않도록 검사 | 미전송 입력에 맞는 별도 질의·읽기 세션 계약부터 정의 |

LIBRA의 주석·구형 저장 키·descriptor에 남은 이름은 실행 기능의 증거가 아니다. 단, [현재 compiler](../tools/libra_memory_graph_compiler.cjs)는 `planner/sga/input_writer` packet 형식도 실제 지원한다. 이 커널 포맷 지원과 제품의 활성 실행 경로를 구분해야 한다. 현재 native owner verifier에는 GRADIA 선택 영수증 검증 연결도 없다.

GRADIA의 기존 서버 읽기는 `/v1/<owner>/read-session/capture`·`current`를 사용한다. 셰도우·AIDE의 기존 연결과 새 unified kernel 연결은 별개다. LIBRA의 `shadow` 엔진 비교 모드와 GRADIA의 셰도우 창작 단계도 서로 다른 기능이다. LIBRA query의 plugin_only/server_only 지원을 GRADIA reader의 같은 지원으로 확대 해석하지 않는다.

### 확인 근거

- [LIBRA.js](../plugins/LIBRA.js): 응답 정규화, Classic `beforeRequest`, 공개 API와 GUI 등록 경계.
- [LIBRA 퇴역 검사](../tests/libra_helper_retirement_runtime_test.cjs): 실행 함수·호스트 설정·공개 API 제거, 설정 가져오기/재시작, 실제 GUI와 기본 Classic의 추가 helper 호출 없음.
- [Classic 권한 검사](../tests/libra_classic_planner_authority_contract_test.cjs): 실제 Classic 전달, 원본 비변경과 추가 응답 provider 호출 없음.
- [GRADIA.js](../plugins/GRADIA.js): `runPipeline → openLibEvidenceRun → LibReadConsumer.beginRead` 및 별도 `runInputAssistForContent` 경로.
- [GRADIA 근거 연결 검사](../tests/gradia/evidence-bridge.test.cjs): 셰도우/AIDE의 근거 전달·최종 현재성 검증, 인풋 작성기의 회수 없음·이전 근거 비사용.
- [SQLite → SDK → GRADIA 검사](../tests/gradia_readonly_cross_project_test.cjs): 기존 서버 읽기의 원본·operation 비변경과 원본 교체 후 이전 draft 거부.

기준 소스 SHA-256:

| 파일 | SHA-256 |
| --- | --- |
| `plugins/LIBRA.js` | `886db848464c0eefc3862df8b39e5c41956f17fbe85188a8e90291b66b22abc4` |
| `plugins/GRADIA.js` | `2bfc7e61c0362640896aaa66e59e9bd3e3416646baa6c97003fa6240083b17cb` |

위 기준에서 퇴역·Classic 검사 2개 파일과 GRADIA 검사 42개가 통과했다. 등록/제어 HTTP 호스트와 SQLite 검사이며 실제 설치 RisuAI나 외부 임베딩 모델의 의미 정확도 인증은 아니다.

## 2. 과제와 기존 미완료 항목 대응

| ID | 우선순위·현재 상태 | 과제 | 기존 현황 항목 | 선행 조건 |
| --- | --- | --- | --- | --- |
| N00 | P0 · 문서 정정 완료, runtime 계약 정리 남음 | 활성 소비자와 호환 포맷 분리 | M09/M15 | 현재 퇴역 계약 확인 |
| N01 | P1 · 부분 구현 | 전체 기록의 영속 인덱스·캐시·Memory Lane | M02–M05 | 원본별 inventory/coverage 계약 |
| N02 | P1 · 정본 global 접근만 연결 | 자료별 representation 생산·접근 | M06–M08 | 표현 계약, 전체 접근 완료에는 N01 |
| N03 | P1 · 기존 서버 읽기만 연결 | GRADIA 셰도우·AIDE의 통합 엔진 읽기 | M09/M10 | N00, owner read-session 계약; 전체 접근에는 N01 |
| N04 | P1 · 새 읽기 계약 미정의 | GRADIA 인풋 작성기의 통합 엔진 읽기 | M09/M10/M15 | 미전송 입력 계약, N03의 공통 reader |
| N05 | P1 · native 실제 삭제 차단 | 안전한 GC·게시·읽기 보호 | M11 | exhaustive inventory, storage owner의 원자적 보호 |
| N06 | P1 · 실제 품질/규모 미측정 | 평가·예산·실제 호스트 인증 | M12/M14 | 평가 세트는 먼저 작성; 인증에는 해당 구현 필요 |
| N07 | P2 · 기본값 legacy | 기본값 전환·중복 경로 종료 | M13/M15 | 지원 범위의 N00–N06 합격 |

다음 엔진 구현은 **N01**부터 시작한다. N00의 runtime 소비자 계약 정리와 N06의 고정 평가 세트 정의는 이에 앞서 또는 함께 진행할 수 있다. 제한된 source window를 전체 기록처럼 취급하는 상태에서 소비자 수만 늘려도 corpus coverage 문제는 해결되지 않는다.

## 3. N00 — 활성 소비자와 호환 포맷

현재 활성 소비자 구조는 **LIBRA Classic·GUI와 별도 GRADIA의 셰도우·AIDE·인풋 작성기**다. 인풋 작성기의 메모리 읽기는 목표이며 아직 현재 기능이 아니다.

- 제품 발송용 consumer policy와 순수 커널의 구형 packet formatter를 구분한다. 구형 이름이 들어간 formatter 검사 통과를 실제 소비자 연결 완료로 보고하지 않는다.
- native facade·public API·설정·GUI·백업 가져오기에서 퇴역 기능을 다시 실행시키는 통로가 없는지 확인한다. 호환 포맷을 보존할 경우 용도·범위와 발송 권한을 명시한다.
- GRADIA 내부 단계 이름은 GRADIA가 관리한다. LIBRA의 옛 SGA나 Input Writer 실행기를 그 adapter로 재사용하지 않는다.
- 구형 저장 키·원문·사용자 draft를 일괄 삭제하지 않는다. 무해한 descriptor 정리는 실행 계약 정리와 분리한다.

**완료 기준:** 활성 소비자 목록이 문서·runtime 권한 검사·호스트 등록·테스트에서 일치한다. 구형 설정/백업/공개 API 입력으로 퇴역 helper 호출이 재개되지 않으며 현재 Classic·GUI와 역사 자료의 읽기는 유지된다.

## 4. N01 — 전체 기록의 공통 영속 접근

현재 owner projection window와 메모리 배열 compile을 전체 기록의 인덱스로 바꾼다. 노드·관계·키워드·시간·벡터를 동일 generation에 결속한 영속 shard/page로 저장하고, 하나의 탐색 큐가 필요한 페이지를 요청한다.

- 정본·Micro·State·lore의 inventory, 미독 cursor, delta/tombstone·수정·복원 의존성을 먼저 고정한다. owner가 지원하지 않는 변경 기록을 만들어내지 않는다.
- directory·typed adjacency·lexical/entity/time·semantic access의 shard schema와 tokenizer/DF/degree 범위를 version으로 봉인한다.
- 공통 Cache Manager가 페이지 예산·pin/release·축출·무효화를 관리하고 Memory Lane이 frontier에 필요한 접근 작업을 예약한다. per-query 전체 배열 재구성이나 별도 family cache로 우회하지 않는다.
- source read/JSON·index build·frontier/witness·private readset·동시 I/O·반환 데이터의 계측과 admission/backpressure를 연결한다. 누적 전송량, resident bytes, peak heap, 문자 예산을 구분한다.
- Classic의 최종 전달과 GUI의 열람/진단 adapter를 같은 query 결과에 연결한다. GUI는 근거·시점·미독 영역·실제 채택을 표시하며, 화면용 public DTO에 모델 발송 권한을 부여하지 않는다. source window 밖의 조회와 partial을 GUI에서도 확인할 수 있어야 한다.

**진척 (첫 증분):** 4개 자료의 inventory·미독 cursor·delta/tombstone 계약을 `tools/libra_memory_graph_inventory.cjs`(순수 커널)와 `tests/libra_memory_graph_inventory_test.cjs`(8 PASS, 음성 대조 포함)로 고정했다.

- 지원 등급은 `FAMILY_SUPPORT_PROFILES`가 자료별로 선언하고, 각 선언의 **근거 심볼**을 명시해 스위트가 실제 플러그인에서 그 심볼을 확인한다(사라지면 실패). lore만 tombstone(`removals`·`confirmations`)을 보고할 수 있고, canonical·micro·state에서 사라진 항목은 `unobservableRemoval`로 남는다 — owner가 지원하지 않는 변경 기록을 만들어내지 않는다.
- cursor는 **열거 digest에 결속**된다. 집합이 바뀐 뒤 이전 cursor로 이어받으면 `cursor_stale`로 거부한다(조용한 누락 방지).
- 잘린 page는 전체 family와 diff할 수 없다(`delta_requires_whole_family`). 페이지 밖 항목이 허위 삭제로 보고되는 경로를 막는다. 전체 열거라도 완료 선언이 없으면 `deltaComplete:false`(`coverage_not_declared`)이다.
- **연결 (둘째 증분)**: 생성 게시물이 이제 자기 세대가 **각 자료의 어느 부분을 덮는지** 기록한다. `createMemoryGraphStore`가 inventory 커널을 주입받아 `sourceInventory`(자료별 page + 병합 집합)·`sourceInventoryDeltas`·`sourceInventoryDeltaBasis`를 세대 manifest에 싣고, build 결과·검증된 read가 같은 값을 돌려준다. owner가 보고한 미독 cursor(`coverage.inventory.*NextCursor`)는 `unread`/`ownerCursors`로 그대로 드러난다.
- **창이 바뀐 비교의 안전 규칙**: 미독 cursor의 목적 자체가 "다음 창은 이전 창이 멈춘 곳에서 이어진다"이므로 창이 달라도 delta를 계산한다. 다만 그때 사라진 항목은 tombstone 지원 여부와 무관하게 `unobservableRemoval`(사유 `window_changed`)로만 남기고 `removed`로 부르지 않는다. delta가 없는 경우도 `basis`(`inventory_disabled`·`no_previous_generation`·`previous_generation_without_inventory`·`same_window`·`previous_window`)로 이유를 밝힌다.
- 한 page가 family 전체보다 크면(창이 한 page보다 큼) delta는 `delta_requires_whole_family`로 건너뛰고 `skipped`에 남는다 — 페이지 밖 항목을 삭제로 오인하지 않기 위해서다.
- 재현: `node PROGRAM/tests/libra_memory_graph_inventory_store_test.cjs` → 6 PASS(창 기록·delta·미독 cursor·커널 미주입 시 무주장·알 수 없는 family 무시), `node PROGRAM/tests/libra_memory_graph_inventory_test.cjs` → 10 PASS.
- **여전히 하지 않은 것**: 미독 cursor를 실제 유지보수 열거에 사용해 **최근 창 밖의 오래된 기억을 질의로 발견**하는 것(N01 완료 기준) — 셋째 증분에서 열거·게시까지 연결했고 질의 도달은 남았다, 그리고 실제 읽힌 shard/cache/Lane 경로 관찰이다. 지금 연결은 게시·기록·검증까지다.
- **하지 않은 것**: 이 증분은 계약·검증까지다. 이 inventory/delta를 store generation manifest에 싣고, 미독 cursor를 실제 유지보수 열거에 사용하는 연결은 다음 증분이다. 연결되지 않은 factory를 플러그인에 늘리지 않기 위해 아직 내장하지 않았다.

- **연결 (셋째 증분)**: 게시된 미독 지점이 이제 **실행 가능한 핸들**이다. 세대 기록·빌드 결과·검증된 read가 `nextWindow`(`libra.graph_next_window.v1` — `canonicalCursor`/`microCursor`/`families`/`reason`)를 돌려주고, `buildMemoryGraphGeneration({continueFromPublished:true})`가 그 지점에서 열거를 이어받아 **창 밖(더 오래된) 구간**을 새 세대로 게시한다. 결과에 `continuedFrom`(기준 세대·커서)이 남고 delta basis는 `previous_window`가 된다.
- 창 요청은 세대 신원의 일부이므로 이어받으면 **다른 슬롯**에 게시된다. 그래서 이어받는 빌드는 기준 세대를 명시하고, 저장소가 그 기준을 직접 로드·검증한다(`base_generation_mismatch`로 거부). 호출자가 준 데이터를 신뢰하지 않는다.
- 재현: `node PROGRAM/tests/libra_memory_graph_continuation_runtime_test.cjs` → 3 PASS(게시된 핸들 회수, 이어받아 게시, 미게시 상태에서 이어받기 거부 + 옵션 검증), `node PROGRAM/tests/libra_memory_graph_inventory_store_test.cjs` → 7 PASS(기준 세대 검증 포함).
- **여기서 멈춘 것**: 이어받은 창이 실제 **질의 결과**로 오래된 기억에 도달하는지와, 실제 읽힌 shard/cache/Lane 경로 관찰은 아직이다. 이번 증분은 열거·게시·검증까지다.

**완료 기준:** 최근 window 밖의 오래된 기억을 질의로 발견하고, 실제 읽은 shard/cache/Lane 경로를 관찰할 수 있다. cold/warm/축출/재시작·수정/복원·동시 요청/취소에서 generation과 원본 의존성이 맞는다. 미독 영역·예산 종료는 partial/coverage로 드러나며 전체 상한을 증명하지 못한 측정값으로 `byteBounded:true`를 선언하지 않는다.

## 5. N02 — 자료별 semantic 표현

현재 정본 global vector는 정본 SourceNode의 접근 신호다. 정본의 세부 사건·주장, Micro·State·lore의 표현 단위와 생산 주체를 정의하고 N01의 semantic pages로 읽는다.

- 자료별로 어떤 텍스트를 어떤 producer/명시적 maintenance가 임베딩하는지 정한다. 모든 family가 반드시 벡터를 가져야 한다는 식으로 coverage를 숨기지 않는다.
- RepresentationID, 원문/파생 근거, text hash, 시점·세계선·view, provider/model/task pair·dimension/profile을 결속한다. 정본 전체 벡터를 개별 fact에 복사하지 않는다.
- query는 기존 질의 벡터를 사용하고 representation을 읽는다. 역사 재분석·State 쓰기·문서 자동 재임베딩을 시작하지 않는다.
- 벡터가 없거나 공간이 맞지 않는 자료도 같은 kernel의 lexical/entity/graph 접근으로 참여한다. 별도 dense 순위와 휴리스틱 순위를 병합하는 구조를 다시 만들지 않는다.

**완료 기준:** 각 family의 유효/누락/불일치·과거/미래 표현을 같은 scorer/frontier에서 처리하고 원래 근거로 연결한다. 실제 모델의 검색 정확도와 가중치 calibration은 N06에서 별도로 판정한다.

## 6. N03 — GRADIA 셰도우·AIDE 연결

기존 reader principal, owner 권한, scope/data identity, 요청별 근거·draft 수명주기를 보존하며 owner의 통합 검색 결과를 읽는 adapter를 만든다.

- 기존 server read-session의 원문 선택 경로와 새 엔진 사이에 지원할 요청/응답 계약을 명시한다. in-process API와 server reader가 같은 기능이라고 가정하지 않는다.
- owner가 발급한 선택 영수증·실제 채택 readset과 private 현재성 검증을 연결한다. public DTO나 caller가 적은 digest만으로 발송을 허용하지 않는다.
- 한 실행의 공유 검색 결과에서 셰도우·각 AIDE가 허용된 근거를 예산에 맞게 채택한다. 단계별 visibility/lore 정책을 보존하고 독립 검색·ranker로 결과를 다시 섞지 않는다.
- 각 provider 호출과 최종 draft 전달 전에 원본·scope/세계선·설정·취소·복원·최신 요청 소유권을 확인한다. 이전 실행의 근거를 새 실행이나 인풋 작성기로 넘기지 않는다.
- unsupported 저장/읽기 모드는 명시적으로 보고한다. GRADIA에 owner 쓰기 권한이나 승인되지 않은 로컬 읽기 우회를 추가하지 않는다.

**완료 기준:** native 통합 엔진 → 정식 reader → 실제 셰도우/AIDE prompt → 최종 handoff 경로를 검사한다. 원본 교체·영수증 위조·scope 변경·취소/늦은 응답은 영향을 받은 draft를 거부한다. 정상 경로의 추가 검색·모델 호출과 실제 채택 근거를 측정한다.

## 7. N04 — GRADIA 인풋 작성기의 새 읽기 계약

현재 [회귀 검사](../tests/gradia/evidence-bridge.test.cjs)는 인풋 작성기가 기억 회수를 하지 않고 이전 셰도우 실행의 근거를 받지 않음을 보장한다. 읽기 기능 추가는 이 계약을 명시적으로 바꾸는 작업이다. 검사만 지우거나 셰도우 settings의 private 근거를 전달해서 구현하지 않는다.

- 질의 권한을 `미전송 제안`과 `호스트가 채택한 현재 입력`으로 구분한다. 작성 중인 입력을 이미 일어난 사건·정본·현재 상태로 승격하지 않는다.
- 작성 작업별 operation ID, 제안 텍스트 hash, 기준 대화·scope/세계선/view, 설정·출력 예산, 원본 영수증을 갖는 새 읽기 세션을 정의한다.
- 제안 변경·재생성·scope 전환·취소는 이전 읽기 결과와 draft를 무효화한다. query가 기억·State·역사 임베딩을 쓰지 않도록 한다.
- preview/copy와 실제 send 경계를 구분한다. 사용자 편집 뒤 전달할 정확한 내용과 현재 근거를 재검증하고 이전 draft의 권한을 재사용하지 않는다.
- 인풋 작성기와 이후 셰도우는 각각의 실행 소유권을 갖는다. 공유 캐시 페이지의 재사용과 이전 실행의 private 전달 권한 재사용을 구분한다.

**완료 기준:** 별도 세션의 통합 검색 근거가 실제 작성기 prompt에 들어간다. 제안 변경/재생성·취소·원본 교체·최종 편집/send를 검사하며 이전 실행 근거 비사용과 원본 비변경은 계속 보장한다. 기존 회수 없음 검사는 새 계약의 읽기 가능/불가 조건을 검증하도록 함께 갱신한다.

## 8. N05 — GC와 수명주기

native GC는 inventory 조회와 dry-run이 있어도 실제 삭제가 차단된 상태다. storage owner가 namespace fence와 publisher/build/reader 보호를 같은 원자적 삭제 경계에서 지원해야 한다.

**작업:** 전체 durable inventory·root/manifest/candidate 검증, 게시 중 build 및 reader pin 보호, 삭제 조건과 중단/복구 정책을 구현한다. source 수정·설정/표현 profile 변경·복원·scope 삭제·unload를 generation/cache/Lane/readset 무효화에 연결한다.

**완료 기준:** mark 이후 새 게시·reader 시작·candidate 교체·취소·재시작 경합에서 필요한 page/manifest가 삭제되지 않는다. owner의 원자적 지원이 없으면 sweep은 계속 blocked이며 완료로 표시하지 않는다.

## 9. N06 — 품질·비용·실제 호스트

고정 평가 세트와 지원 profile을 먼저 정의한다. 네 자료를 잇는 질문, 오래된 기억, 고유명사·동의어·다국어, 정정/충돌·unknown, 현재/과거·세계선, mandatory lore를 포함한다.

- gold evidence와 기대 coverage를 기록하고 legacy/unified를 같은 원본 snapshot에서 비교한다. 신호별 ablation으로 semantic·lexical·연결 전파와 가중치를 평가한다.
- 실제 embedding provider의 검색 품질을 제어 HTTP 벡터 검사와 분리해 측정한다. 질의 캐시·provider 실패·timeout에서 호출 비용과 coverage를 관찰한다.
- 지원 corpus 규모·동시성별 latency, peak memory, 실제 I/O·pin/축출·미독 영역을 측정하고 프로필별 합격 수치를 명시한다. 측정 전 수치를 인증값으로 꾸미지 않는다.
- 실제 설치 RisuAI에서 Classic·GUI와 연결된 GRADIA 소비자의 발송·취소·복원·설정 변경을 확인한다. 엔진 비교용 shadow는 최종 prompt를 추가 주입하지 않는다.

**완료 기준:** 구현 SHA·호스트/provider·workload·합격 수치·결과가 재현 가능한 기록에 결속된다. 미지원/미측정 범위를 공개하고 커널/fixture PASS를 실사용 인증으로 바꾸지 않는다.

## 10. N07 — 기본값 전환과 중복 경로 종료

현재 기본값은 legacy다. 지원 범위의 앞선 과제가 합격한 뒤에 전환한다.

**작업:** request 시작의 mode/owner/generation 봉인을 유지하고 기존 shortlist/RRF·중복 cache/index/Lane·별도 family ranker 실행을 종료한다. 필요한 importer와 구형 저장 호환은 보존하고 전환·복구·GUI 진단 정책을 기록한다.

**완료 기준:** 실제 unified 요청에서 중복 ranker·준비 작업·검색 호출·prompt 주입이 없는 것을 trace로 확인한다. 지원 소비자의 품질·예산·최종 현재성 기준을 통과하고, 설정/백업/재시작이 퇴역 helper나 이전 중복 경로를 재활성화하지 않는다.

## 11. 기존 근거의 재현

아래는 §1의 기존 구현 확인 명령이다. N01–N07의 미래 구현 완료를 검증하는 명령은 아니다. Node와 저장소의 기존 개발 의존성, SQLite 서버 검사에 필요한 로컬 연결 환경을 사용한다.

```bash
node --test PROGRAM/tests/libra_helper_retirement_runtime_test.cjs PROGRAM/tests/libra_classic_planner_authority_contract_test.cjs
node --test PROGRAM/tests/gradia/evidence-bridge.test.cjs PROGRAM/tests/gradia_readonly_cross_project_test.cjs
```

후속 작업자는 과제별 실제 변경 경로·source SHA·검사·측정과 남은 gate를 현황 문서에 기록한다. 기능 이름·새 API·포맷터·자기 보고식 bool만으로 과제를 닫지 않는다.
