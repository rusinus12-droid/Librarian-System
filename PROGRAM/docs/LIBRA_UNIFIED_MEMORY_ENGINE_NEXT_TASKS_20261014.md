# LIBRA 통합 메모리 엔진 — 다음 과제와 완료 기준

- 작성일: 2026-10-14 · 문서 버전: 1.3
- 최초 코드·호출 경로 확인 기준: `codex/libra-memory-network-20261013`, [`3e589ddcdb9fa10e7d22f1f38e8d61cd4025f4db`](https://github.com/rusinus12-droid/Librarian-System/commit/3e589ddcdb9fa10e7d22f1f38e8d61cd4025f4db)
- 관련: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [현재 현황](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), [native semantic 계약](LIBRA_UM3_NATIVE_SEMANTIC_CONTRACT.md), [제품 역할·퇴역 계약](PLUGIN-ROLE-AND-STORAGE-DESIGN-20261007.md)
- 판정: **정본 저장 벡터와 질의 임베딩은 하나의 scorer/frontier에 연결됐다. GRADIA 셰도우·AIDE의 명시적 통합 읽기도 제한 범위에서 연결했다. 인풋 작성기의 별도 미전송 제안 세션도 제한 범위에서 연결했다. 전체 기록의 영속 접근, 실제 품질·성능 인증과 기본값 전환은 미완료다.**

이 문서는 소비자 호출 경로 재검토를 반영한 현재 작업 계획이다. 이전 설계·현황 문서에서 LIBRA의 Planner·SGA·Input Writer를 활성 연결 대상으로 적은 부분을 정정한다. 과제 정의는 구현 완료나 배포 자격을 부여하지 않는다.

## 1. 확인한 실행 범위

| 대상 | 코드·검사로 확인한 상태 | 다음 작업의 의미 |
| --- | --- | --- |
| LIBRA Classic | 기억 근거를 전달하는 현재 응답 경로. 명시적 unified 설정의 최종 전달은 등록 합성 호스트에서 검증 | 전체 기록의 통합 검색·실제 호스트 검증으로 확장 |
| LIBRA GUI | 현재 기억 열람·진단 화면은 활성 상태 | 통합 결과·출처·시간·coverage·실제 채택 정보를 읽는 표시 adapter 연결 |
| LIBRA Planner·SGA | 실행 함수와 공개 실행 API 제거. 예전 응답 설정도 Classic으로 정규화 | 실행 경로를 복원하는 과제로 잡지 않음 |
| LIBRA Input Writer | 실행 함수·공개 API·작성기 버튼 등록 제거 | 인풋 작성 기능의 소유자는 별도 GRADIA |
| GRADIA 셰도우·AIDE | 기존 서버 읽기 전용 연결과 요청별 근거 전달 경로가 있음 | server_only·호스트 채널을 통한 통합 읽기 연결. 실제 설치 인증과 전체 corpus 접근은 남음 |
| GRADIA 인풋 작성기 | 명시적 작성 버튼에서 별도 미전송 제안 세션으로 통합 읽기 연결. 셰도우 근거·전달 권한 비재사용 | 실제 설치 인증·대규모 성능 측정은 남음 |

LIBRA의 주석·구형 저장 키·descriptor에 남은 이름은 실행 기능의 증거가 아니다. 단, [현재 compiler](../tools/libra_memory_graph_compiler.cjs)는 `planner/sga/input_writer` packet 형식도 실제 지원한다. 이 커널 포맷 지원과 제품의 활성 실행 경로를 구분해야 한다. native owner verifier에는 이번 N03에서 private GRADIA 선택 영수증 검증을 연결했다. 공개 query API가 임의로 영수증 권한을 발급하지는 않는다.

GRADIA의 기존 서버 읽기는 `/v1/<owner>/read-session/capture`·`current`를 사용한다. 셰도우·AIDE의 기존 연결과 새 unified kernel 연결은 별개다. LIBRA의 `shadow` 엔진 비교 모드와 GRADIA의 셰도우 창작 단계도 서로 다른 기능이다. LIBRA query의 plugin_only/server_only 지원을 GRADIA reader의 같은 지원으로 확대 해석하지 않는다.

### 확인 근거

- [LIBRA.js](../plugins/LIBRA.js): 응답 정규화, Classic `beforeRequest`, 공개 API와 GUI 등록 경계.
- [LIBRA 퇴역 검사](../tests/libra_helper_retirement_runtime_test.cjs): 실행 함수·호스트 설정·공개 API 제거, 설정 가져오기/재시작, 실제 GUI와 기본 Classic의 추가 helper 호출 없음.
- [Classic 권한 검사](../tests/libra_classic_planner_authority_contract_test.cjs): 실제 Classic 전달, 원본 비변경과 추가 응답 provider 호출 없음.
- [GRADIA.js](../plugins/GRADIA.js): `runPipeline → openLibEvidenceRun → LibReadConsumer.beginRead` 및 별도 `runInputAssistForContent` 경로.
- [GRADIA 근거 연결 검사](../tests/gradia/evidence-bridge.test.cjs): 셰도우/AIDE의 근거 전달·최종 현재성 검증, 인풋 작성기의 회수 없음·이전 근거 비사용.
- [SQLite → SDK → GRADIA 검사](../tests/gradia_readonly_cross_project_test.cjs): 기존 서버 읽기의 원본·operation 비변경과 원본 교체 후 이전 draft 거부.

최초 퇴역/호출 검사 기준(`3e589dd`)의 소스 SHA-256:

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
| N03 | P1 · 제한 범위 통합 읽기 연결 | GRADIA 셰도우·AIDE의 통합 엔진 읽기 | M09/M10 | N00, owner read-session 계약; 전체 접근에는 N01 |
| N04 | P1 · 미전송 제안 읽기 제한 연결 | GRADIA 인풋 작성기의 통합 엔진 읽기 | M09/M10/M15 | 미전송 입력 계약, N03의 공통 reader |
| N05 | P1 · native 실제 삭제 차단 | 안전한 GC·게시·읽기 보호 | M11 | exhaustive inventory, storage owner의 원자적 보호 |
| N06 | P1 · 실제 품질/규모 미측정 | 평가·예산·실제 호스트 인증 | M12/M14 | 평가 세트는 먼저 작성; 인증에는 해당 구현 필요 |
| N07 | P2 · 기본값 legacy | 기본값 전환·중복 경로 종료 | M13/M15 | 지원 범위의 N00–N06 합격 |

### N03 진척 — 실제 owner 공급자·GRADIA 연결

- LIBRA private owner가 `executeMemoryGraphUnifiedQuery`를 실행하고, 선택 영수증·compiler 원본 검증을 거친 근거 묶음을 발급한다. 인증된 RisuAI plugin channel에서 요청자의 plugin ID를 확인한다. 공개 전역 객체를 읽기 권한으로 쓰지 않는다.
- GRADIA의 고정 SDK를 검토된 최소 범위로 확장했다. 기존 서버의 readonly principal·route·reset·data identity 검사는 유지한다. 서버 원문은 권한 확인 witness에만 쓰고 통합 검색의 결과로 대신 전달하지 않는다. HAYAKU·Flashback은 기존 읽기를 유지하며 `engine.sourceByOwner`로 구분한다.
- GUI 자료 화면에서 **LIBRA 검색 → 통합 메모리 검색 → 연결**로 선택한다. 공개 `connectUnifiedLibReadOnly(url)`도 같은 실제 연결 경로다. 새 질문을 질의로 전달하고 한 번 발급한 근거를 SHADOW·AIDE 네 단계가 공유한다. 소스 변경·권한 철회·취소·연결 변경 시 진행 중인 근거와 초안을 폐기한다.
- `source: unified_engine`, generation, owner corpus digest, 선택 영수증, `queryComplete`, `deliveryOutcome`, `windowRead`, `nextWindow`를 보존한다. 캡처한 bundle의 `complete:true`를 전체 corpus 검색 완료로 해석하지 않는다.
- 통합 공급자가 없거나 읽기 권한이 없으면 거부한다. 기존 기본 연결의 source는 `server_logical_read`로 유지한다. 기존 고정 SDK를 공통 writer SDK로 교체하지 않았으며 LIA·RETRACE pin도 유지한다.
- 검증과 상세 계약: [GRADIA 통합 읽기 계약](LIBRA_GRADIA_UNIFIED_READ_CONTRACT_20261014.md). 등록 호스트의 실제 LIBRA·SQLite·GRADIA beforeRequest를 사용한다. 실제 설치 RisuAI 인증(E4), 전체 corpus의 영속 접근(N01), 미전송 인풋 작성기(N04), 기본값 전환(N07)은 닫지 않는다.

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
- 재현: `node PROGRAM/tests/libra_memory_graph_inventory_store_test.cjs` → 당시 6 PASS(창 기록·delta·미독 cursor·커널 미주입 시 무주장·알 수 없는 family 무시). 셋째 증분에서 기준 세대 검증 1건이 추가되어 현재 **7 PASS**, `node PROGRAM/tests/libra_memory_graph_inventory_test.cjs` → 10 PASS.
- **여전히 하지 않은 것**: 미독 cursor를 실제 유지보수 열거에 사용해 **최근 창 밖의 오래된 기억을 질의로 발견**하는 것(N01 완료 기준) — 셋째 증분에서 열거·게시까지 연결했고 질의 도달은 남았다, 그리고 실제 읽힌 shard/cache/Lane 경로 관찰이다. 지금 연결은 게시·기록·검증까지다.
- **하지 않은 것**: 이 증분은 계약·검증까지다. 이 inventory/delta를 store generation manifest에 싣고, 미독 cursor를 실제 유지보수 열거에 사용하는 연결은 다음 증분이다. 연결되지 않은 factory를 플러그인에 늘리지 않기 위해 아직 내장하지 않았다.

- **연결 (셋째 증분)**: 게시된 미독 지점이 이제 **실행 가능한 핸들**이다. 세대 기록·빌드 결과·검증된 read가 `nextWindow`(`libra.graph_next_window.v1` — `canonicalCursor`/`microCursor`/`families`/`reason`)를 돌려주고, `buildMemoryGraphGeneration({continueFromPublished:true})`가 그 지점에서 열거를 이어받아 **창이 덮지 않은 나머지 구간**을 새 세대로 게시한다. 결과에 `continuedFrom`(기준 세대·커서)이 남고 delta basis는 `previous_window`가 된다.
- 창 요청은 세대 신원의 일부이므로 이어받으면 **다른 슬롯**에 게시된다. 그래서 이어받는 빌드는 기준 세대를 명시하고, 저장소가 그 기준을 직접 로드·검증한다(`base_generation_mismatch`로 거부). 호출자가 준 데이터를 신뢰하지 않는다.
- 재현: `node PROGRAM/tests/libra_memory_graph_continuation_runtime_test.cjs` → 3 PASS(게시된 핸들 회수, 이어받아 게시, 미게시 상태에서 이어받기 거부 + 옵션 검증), `node PROGRAM/tests/libra_memory_graph_inventory_store_test.cjs` → 7 PASS(기준 세대 검증 포함).
- **여기서 멈춘 것**: 이어받은 창이 실제 **질의 결과**로 이어지는지, 그리고 실제 읽힌 shard/cache/Lane 경로 관찰은 아직이다. 이번 증분은 열거·게시·검증까지다.
- **검증하지 않은 표현 정정**: 앞선 커밋 메시지와 이 문서 초판은 이어받은 구간을 "더 오래된 구간"이라고 적었다. 실제로 확인한 것은 "창이 덮지 않은 나머지 구간"까지이며, 그 구간이 시간상 어느 방향인지는(자료별 정렬 순서에 따른다) 측정하지 않았다. `mgm1`/`mgc1` 커서는 owner가 준 다음 위치를 그대로 이어받을 뿐이고, 방향은 이 계층이 정하지 않는다.

- **연결 (넷째 증분) — 질의 도달**: 질의도 자기 창을 말하고, 주인이 준 커서로 창 밖 구간을 읽을 수 있다. recall의 통합 분기와 통합 질의가 `unifiedWindow`(`limit`/`canonicalCursor`/`microCursor`)를 받아 owner 커서를 그대로 전달하고, 결과의 `windowRead`(`libra.graph_query_window.v1` — limit·커서·owner inventory·`projectionComplete`)와 `nextWindow`가 어느 창을 읽었고 어디가 남았는지 밝힌다.
- **측정한 방향 (이번에 실제로 확인)**: fixture·plugin_only 합성 호스트에서 기본 창(`limit 1`)은 turn 0–5를 읽고 turn 6의 Micro 기억이 **없으며** `deliveryOutcome: partial`·`microRead 0`·다음 커서 `mgm1:1`을 낸다. 주인 커서 `mgm1:5`로 이어받으면 turn 0–**6**을 읽어 그 Micro 기억이 **나오고** `deliveryOutcome: complete`·`microRead 1`·다음 커서 없음이 된다. 즉 커서는 자료의 자체 순서를 **앞쪽(턴 번호가 커지는 방향)** 으로 진행한다 — 이번에 측정한 사실이며, 일반화는 하지 않는다.
- **함께 고친 결함**: 질의 경로에 창 크기 검증이 없어 `limit: 51` 같은 요청이 조용히 통과했다(저장소 경로는 1–50으로 검증한다). 이제 `limit` 1–50·`nodeLimit` 1–8192·커서 문자열 길이를 검증하고 위반은 `LIBRA_GRAPH_QUERY_LIMIT_INVALID`/`NODELIMIT_INVALID`로 거부한다.
- 재현: `node PROGRAM/tests/libra_memory_graph_query_window_runtime_test.cjs` → 4 PASS(창 보고, 창 밖 기억의 질의 도달, 남은 커서 반환, 위조·범위 밖 커서 거부).

- **연결 (다섯째 증분) — 읽은 경로 관찰**: 질의 결과에 `accessTrace`(`libra.graph_access_trace.v1`)를 노출했다. 이 호출이 **이미 계산한 값만** 묶은 서술이며 새 계측은 없다: Lane이 읽은 page/byte 수와 **역할별 분해**(`query_anchor_access`·`graph_neighborhood`·`temporal_state_access`·`semantic_access`·`context_expansion`), cache hit·coalesced 요청·미독 cursor, frontier step·재평가·요청된 인접 anchor, L0 workspace byte(예산 대비 초과 여부), 그리고 coverage/중단 사유. recall 진단에도 같은 trace를 싣는다.
- **실측 예 (fixture·plugin_only)**: 기본 질의 = lane 46 pages·99,083 bytes / 262,144, `graph_neighborhood` 37 pages·89,123 bytes, `query_anchor_access` 9 pages·9,960 bytes, frontier 40 step·인접 anchor 37, workspace 46,496 / 262,144 초과 없음, `frontier_exhausted`. 소예산(`maxPages:1, maxBytes:512, pageBytes:256`) 질의 = **delivery `partial`·`stopReason lane_page_count_budget`·lane.complete false·1 page·196 bytes** — 예산 중단이 trace에 그대로 드러난다.
- **권한 없음**: trace는 `authority: descriptive_only`이고 `modelDispatchEligible` 필드를 갖지 않는다. 발송 가능 여부는 별도 dispatch 검증에서만 나온다.
- 재현: `node PROGRAM/tests/libra_memory_graph_access_trace_runtime_test.cjs` → 4 PASS(경로 보고, 커널 진단과의 일치, 예산 중단 가시성, 권한 없음).
- **이 증분으로 N01의 관찰 가능한 기준은 채워졌다**: ① 창 밖 기억의 질의 도달(넷째 증분, 실측) ② 실제 읽은 shard/cache/Lane 경로 관찰(다섯째 증분) ③ 미독·예산 종료가 partial/coverage로 드러남(③은 두 증분의 음성 대조) ④ `byteBounded:true`를 선언하지 않음(inventory 집합이 `byteBounded:false` 고정).
- **N01에서 남은 것**: GUI 화면에 이 trace·시점·미독 영역을 표시하는 adapter, 그리고 cold/warm/축출/재시작·수정/복원·동시/취소 축은 기존 스위트(V05·store 12종)가 덮지만 이번 증분에서 재측정하지는 않았다. 실제 설치 호스트 인증은 E4/N06이다.

- **연결 (여섯째 증분) — GUI 표시**: 진단 화면에 `읽은 경로 · 시점 · 미독` 카드를 추가하고, 표시 전용 DTO `getMemoryRecallDiagnosticsView()`(`libra.recall_diagnostics_view.v1`, `authority: display_only`)를 공개 API와 GUI가 공유한다. 카드는 창(limit·정본/Micro 읽음 대비 전체·투영 미완), 읽은 경로(page 수·byte/예산·cache hit·frontier step·작업 byte·중단 사유), 역할별 분해, 채택(건수·family·억제 Micro·packet 문자/예산), **미독 구역**(owner cursor·lane cursor·next_window), 서빙 엔진을 표시한다. 상태는 `data-recall-diagnostics-state`로 `absent`/`partial`/`complete`를 드러낸다.
- **권한 없음(음성 대조)**: DTO에 `modelDispatchEligible`·`dispatchVerification`·`authorized` 같은 필드가 없고 직렬화 결과에도 발송 허가가 나타나지 않는다. 화면은 발송 권한을 부여할 수 없다.
- 재현: `node PROGRAM/tests/libra_recall_diagnostics_view_test.cjs` → 4 PASS.
- **검증 공백 (닫지 못한 것)**: 이 카드의 **렌더된 DOM 검증은 하지 못했다**. 다른 GUI 스위트가 쓰는 jsdom 하네스는 이 진단 섹션에 도달하지 못하며(옆의 기존 카드 `마지막 실행 상태`도 같은 하네스에서 렌더되지 않는다), 어떤 클릭 경로로도 그 화면이 만들어지지 않았다. 따라서 현재 검증은 ① DTO 동작(absent/partial/complete·미독·채택·무권한) ② 카드가 그 DTO를 읽어 훅과 각 줄을 만든다는 소스 수준 확인까지다. 실제 렌더 증명에는 이 섹션을 여는 별도 하네스가 필요하다.

**완료 기준:** 최근 window 밖의 오래된 기억을 질의로 발견하고, 실제 읽은 shard/cache/Lane 경로를 관찰할 수 있다. cold/warm/축출/재시작·수정/복원·동시 요청/취소에서 generation과 원본 의존성이 맞는다. 미독 영역·예산 종료는 partial/coverage로 드러나며 전체 상한을 증명하지 못한 측정값으로 `byteBounded:true`를 선언하지 않는다.

## 5. N02 — 자료별 semantic 표현

현재 정본 global vector는 정본 SourceNode의 접근 신호다. 정본의 세부 사건·주장, Micro·State·lore의 표현 단위와 생산 주체를 정의하고 N01의 semantic pages로 읽는다.

- 자료별로 어떤 텍스트를 어떤 producer/명시적 maintenance가 임베딩하는지 정한다. 모든 family가 반드시 벡터를 가져야 한다는 식으로 coverage를 숨기지 않는다.
- RepresentationID, 원문/파생 근거, text hash, 시점·세계선·view, provider/model/task pair·dimension/profile을 결속한다. 정본 전체 벡터를 개별 fact에 복사하지 않는다.
- query는 기존 질의 벡터를 사용하고 representation을 읽는다. 역사 재분석·State 쓰기·문서 자동 재임베딩을 시작하지 않는다.
- 벡터가 없거나 공간이 맞지 않는 자료도 같은 kernel의 lexical/entity/graph 접근으로 참여한다. 별도 dense 순위와 휴리스틱 순위를 병합하는 구조를 다시 만들지 않는다.

**진척 (첫 증분):** 자료별 표현 계약을 `tools/libra_memory_graph_representation.cjs`(순수 커널)와 `tests/libra_memory_graph_representation_test.cjs`(7 PASS)로 고정했다.

- **선언**: `REPRESENTATION_UNITS`가 자료별 표현 단위·생산 주체·유지보수 경로·임베딩할 텍스트를 선언한다. canonical = `source_global_projection`(owner projection, vectorToday true), micro·state·lore = **`none_declared`(vectorToday false)** — 없는 coverage를 침묵으로 두지 않는다. 이 선언은 shipped semantic bridge의 `vectorlessFamilies: ['micro','state','lore']`와 일치한다(스위트가 실제 소스에서 확인).
- **식별**: `representationId()`가 (family, unit key, source basis, text hash, viewpoint{worldline·restoreEpoch·asOfTurn·viewer}, space{spaceId·provider·model·dimension·metric·taskPair·profileDigest}) 튜플을 digest로 묶는다. **벡터 바이트를 담지 않는다** — 정본 global vector는 원본 source 노드에 결속된 채로 둔다. 불완전한 binding은 `unit_key_required`·`text_hash_required`·`space_binding_incomplete`로 거부한다.
- **분류**: `valid`·`missing`·`foreign_space`(provider/model/dimension/metric 불일치)·`out_of_view`(과거·미래 시점, 다른 세계선, 다른 restore epoch)·`stale_basis`(원본 basis 변경)로 나누고 사유를 남긴다.
- **참여**: `planRepresentationAccess()`는 벡터가 없거나 공간이 다르거나 stale한 단위도 **같은 커널의 lexical/entity/predicate/graph 채널**로 참여시킨다(`separateDenseRanker:false`, `heuristicMergeLayer:false`). 벡터 채널은 선언된 생산자가 있는 자료의 유효 단위에만 열린다. coverage 5종이 unit 수와 합이 맞고, 하나라도 유효하지 않으면 `vectorCoverageComplete:false`, `byteBounded:false`다. 계획은 **아무것도 생산하지 않는다**(`jobsStarted:0`·`writes:0`, 임베딩 호출 금지 검사 포함).
- **표시 연결**: 진단 표시 DTO와 카드가 선언 표와 **실제 상태**를 함께 보여준다. 실측(fixture·plugin_only): `status: no_compatible_representations`, `admitted 0`, `rejected ['representation_missing']`, `vectorlessFamilies ['micro','state','lore']`, `backgroundEmbeddingStarted false`. 표현 payload(벡터)는 표시 DTO에 들어가지 않는다.
- **여기서 멈춘 것**: ① micro·state·lore의 **실제 벡터 생산자**는 아직 없다(이 계약은 생산자를 만들지 않는다 — 유지보수 정책 결정 필요) ② 계획을 **scorer/frontier의 입력으로 소비**하는 연결은 아직이다(현재 질의 커널은 벡터 없는 자료를 이미 lexical/entity 채널로 처리하지만, 이 계획을 점수 입력으로 받지는 않는다) ③ 가중치 calibration은 N06.

**진척 (둘째 증분) — 표현 계약을 scorer 입력으로 소비**: 계약이 장식이 아니라 점수의 입력이 되었다.

- **커널**: `sealQueryFrame`이 `representationDecisions`(nodeId → `{status, reason}`)를 받고, `resolveSemanticFeature`가 **주입된 표현(documentRepresentations)보다 먼저** 계획을 본다. `valid`가 아니면 의미 점수를 부여하지 않고 `semanticFeatureStatus: incompatible_isolated`·계약 사유·`gatedByPlan: true`로 남긴다. 진단에 `planDecisionCount`·`planGatedCount`·`planGatedReasons`가 추가된다.
- **플러그인**: semantic bridge의 `rejected[]`와 자료 선언을 per-node 판정으로 만들어 질의에 넘긴다(`embedding_space_mismatch`→`foreign_space`, `representation_outside_temporal_view`→`out_of_view`, 선언된 생산자가 없는 자료→`no_representation_producer_declared`, 채택된 정본→`valid`). 새 어휘를 만들지 않고 계약 어휘로 옮긴다.
- **실측**(fixture·plugin_only, 사용할 수 있는 임베딩 없음): 판정 33건 = 차단 33건(정본 13건 `representation_missing` + micro·state·lore 20건 `no_representation_producer_declared`), `compatibleCount 0`, 그럼에도 답변은 `complete`이며 read trace의 `query_anchor_access` pages > 0이다 — 벡터 없는 자료가 **같은 커널의 lexical/entity/predicate/graph**로 참여한다.
- 재현: `node PROGRAM/tests/libra_memory_graph_scorer_representation_test.cjs` → 4 PASS(전수 차단·사유 어휘·벡터 없이 전달·계획이 주입보다 먼저라는 규칙 순서).
- **측정하지 않은 것(명시)**: **양성 경로** — 쓸 수 있는 임베딩이 있는 호스트에서 `valid` 판정이 실제로 의미 점수를 받고 점수가 올라가는지는 이 fixture에 임베딩이 없어 확인하지 않았다. 이번 증분이 증명한 것은 "계약을 어긴 표현은 점수를 못 받는다"와 "그래도 답은 나온다"까지다.

**진척 (셋째 증분) — 벡터 생산자 정책**: "어떤 자료가 벡터를 갖나"를 결정으로 기록하고 게이트로 강제했다.

- **먼저 실제 코드를 확인했다**: 살아 있는 임베딩 경로에 도달하는 것은 **정본 owner source projection 하나뿐**(`buildCanonicalCommitEnvelope` + `buildMemoryRetrievalProjection` → `embedMemory`)이며 micro·state·lore는 도달하지 않는다. 그래서 선언(`vectorToday: false`)은 실제 코드와 일치한다.
- `PRODUCER_POLICIES`: canonical은 `authorized: true`·`activation: explicit_maintenance_only`. micro·state·lore는 `authorized: false`이며 **무엇을 임베딩할지(textUnit)** 와 **무엇이 갖춰져야 하는지(precondition 3항목)** 를 명시한다 — micro: 현재 revision이 유지될 때만 재임베딩하는 유지보수 API·예산·미커밋 분석에서 조립할 수 없는 영수증 텍스트 / state: certainty·disposition이 드러나는 텍스트와 철회 필드 규칙 / lore: tombstone을 아는 유지보수 경로와 revision을 견디는 passage locator.
- `mayEmbed({family, trigger, hasOwnerBasis})`: 선언된 생산자 + `explicit_maintenance` + 실제 owner basis일 때만 허용. `query`·`write`·`load`·`session_start`·`boot`·`prefetch`는 **모든 자료에서** 거부(`trigger_not_maintenance`), 생산자가 없는 자료는 유지보수 트리거라도 거부(`producer_not_authorized`), basis 없는 정본은 `owner_basis_required`, 모르는 자료는 이름으로 실패.
- **게이트가 실제 임베딩 경로에 있다**: `embedMemory`가 provider 호출 **직전에** 정책을 보고, 거부되면 `status: 'skipped'`로 남기고 기록(`state.lastVectorProducerRefusal`)한 뒤 임베딩하지 않는다. 선언 표와 정책이 어긋나지 않도록 `vectorToday`와 `authorized`가 같은지 스위트가 검사한다.
- 실측: canonical+maintenance+owner basis만 `allowed: true`, 나머지 7개 조합은 전부 거부(사유 포함). 화면에는 정책이 선언 옆에 표시된다(authorized `['canonical']`, unauthorized `['micro','state','lore']`, 금지 트리거 6종).
- 재현: `node PROGRAM/tests/libra_memory_graph_producer_policy_test.cjs` → 5 PASS. **임베딩 경로 회귀 4종 PASS**(`libra_explicit_embedding_lifecycle` 4, `libra_unified_recall_vector_v1` 7, `libra_embedding_vector_3mode_parity`, `libra_memory_graph_semantic_runtime` 8) — 게이트가 정상 정본 임베딩을 막지 않는다는 증거.
- **측정하지 않은 것(명시)**: 플러그인 쪽 **거부 분기는 런타임으로 실행되지 않았다.** 공개 API로 비정본 문서 임베딩을 요청할 수 없기 때문이며, 그것이 바로 지키려는 성질이다. 거부는 커널 수준에서만 실행·검증했다.

**완료 기준:** 각 family의 유효/누락/불일치·과거/미래 표현을 같은 scorer/frontier에서 처리하고 원래 근거로 연결한다. 실제 모델의 검색 정확도와 가중치 calibration은 N06에서 별도로 판정한다.

## 6. N03 — GRADIA 셰도우·AIDE 연결

기존 reader principal, owner 권한, scope/data identity, 요청별 근거·draft 수명주기를 보존하며 owner의 통합 검색 결과를 읽는 adapter를 만든다.

- 기존 server read-session의 원문 선택 경로와 새 엔진 사이에 지원할 요청/응답 계약을 명시한다. in-process API와 server reader가 같은 기능이라고 가정하지 않는다.
- owner가 발급한 선택 영수증·실제 채택 readset과 private 현재성 검증을 연결한다. public DTO나 caller가 적은 digest만으로 발송을 허용하지 않는다.
- 한 실행의 공유 검색 결과에서 셰도우·각 AIDE가 허용된 근거를 예산에 맞게 채택한다. 단계별 visibility/lore 정책을 보존하고 독립 검색·ranker로 결과를 다시 섞지 않는다.
- 각 provider 호출과 최종 draft 전달 전에 원본·scope/세계선·설정·취소·복원·최신 요청 소유권을 확인한다. 이전 실행의 근거를 새 실행이나 인풋 작성기로 넘기지 않는다.
- unsupported 저장/읽기 모드는 명시적으로 보고한다. GRADIA에 owner 쓰기 권한이나 승인되지 않은 로컬 읽기 우회를 추가하지 않는다.

**완료 기준:** native 통합 엔진 → 정식 reader → 실제 셰도우/AIDE prompt → 최종 handoff 경로를 검사한다. 원본 교체·영수증 위조·scope 변경·취소/늦은 응답은 영향을 받은 draft를 거부한다. 정상 경로의 추가 검색·모델 호출과 실제 채택 근거를 측정한다.

## 7. N04 — GRADIA 인풋 작성기의 별도 통합 읽기

**제한 범위 연결·검증:** 기존 자료 화면에서 통합 읽기에 연결한 후 명시적 인풋 작성 버튼을 사용한다. `server_only`, 동일 native scope, readonly principal과 기존 G2 예산 profile을 유지한다. 자동 input handler와 beforeRequest 입력 가로채기를 등록하지 않는다.

- 별도 `LibWriterReadConsumer`와 작업별 operation ID를 사용한다. 원래 제안의 SHA-256·기준 native context digest·scope/세계선이 owner 영수증과 결속된다. `input_writer_proposal`, `factAdopted:false`를 owner가 검증하고, 제안·선택·복사만으로 기억/State를 쓰지 않는다.
- 실제 RP/Novel 작성기 prompt에 owner 근거가 들어간다. 최초 생성/번역은 같은 세션을 사용하고 재생성은 이전 영수증을 해제한 새 작업이다. 셰도우의 private 세션을 가져오지 않는다.
- 선택과 최종 편집본의 복사/전송 직전에 원본·native 대화/설정·연결/권한과 정확한 출력 내용을 다시 검증한다. sendChat 권한 확인을 기다린 뒤에도 검사한다. 취소·원본 교체·연결/입력 변경·늦은 응답은 이전 근거와 초안 전달을 차단한다.
- 근거·선택지·파생 입력은 generic runtime/provider 진단·저장·체크포인트·다음 실행의 static handoff에 보관하지 않는다. 선택지/편집 UI만 작업 중 private 결과를 사용한다. 복사한 텍스트를 나중에 직접 보내는 일은 새 host 입력이며 과거 읽기 권한을 전달하지 않는다.
- 공급자의 `input_writer_proposal` 지원을 확인한다. 연결 없는 기존 작성기는 기억 조회를 시작하지 않으며, 기존 [회귀 검사](../tests/gradia/evidence-bridge.test.cjs)는 **셰도우 근거 비사용**을 계속 검사한다.

[작성기 통합 읽기 계약·검증](LIBRA_GRADIA_INPUT_WRITER_READ_CONTRACT_20261014.md)에 실제 UI와 LIBRA/SQLite 통합 경로, 지원 model/payload 한계, 재현 명령을 기록한다. E4 설치 인증과 전체 corpus 접근(N01)은 이 연결 완료에 포함하지 않는다.

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

## 12. `9a61245` 리뷰 후 네 결함 패치

`9a61245`까지의 N01/N02/N03 증분에서 확인한 네 결함을 수정했다. 기준 커밋에서 회귀 검사의 실패를 확인한 뒤 runtime과 내장 코드를 함께 갱신했다.

| 경계 | 수정한 계약 | 회귀 검사 |
| --- | --- | --- |
| N03 통합 reader | provider의 capture/current 전후에 기존 route·reset·connection·취소 fence를 검사. 변경된 저장 경계의 늦은 응답을 거부 | 모드 변경 전후, provider 대기 중 reset/connection 변경 |
| N03 GRADIA 소비자 | 정규화한 readSource를 요청 시작에 봉인하고 native scope 검증 await 전후에 재검증. 불일치는 근거/draft 폐기 | source 변경·늦은 capture·마지막 scope await, 구형 기본값 정상 전달 |
| N02 표현 | 동일 spaceId라도 taskPair/profileDigest 불일치는 foreign_space. viewerId 변경·누락은 out_of_view이고 vector 채널 제외 | task pair/profile 변경·누락, viewer 변경·누락, 동일 binding 정상 경로 |
| N01 inventory delta | 조회 sourceOptions·owner/view/restore frame으로 구간을 비교. sourceStamp 변화와 explicit base 지정만으로 window_changed를 만들지 않음 | 동일 구간 revision/binding 수정·lore removal, 실제 cursor/restore/view 이동 |

직접 회귀는 `libra_gradia_unified_read_source_test.cjs`(18), `libra_memory_graph_representation_test.cjs`(9), `libra_memory_graph_inventory_store_test.cjs`(11)의 38개 검사다. 영향권 SDK/GRADIA pipeline·durable store·continuation·native semantic 검사와 내장 코드·패키지 정합성도 함께 확인한다.

SDK 원본 수정은 HAYAKU·Flashback에 내장했고, GRADIA는 소비자의 async/sync binding 검사를 수정했다. GRADIA·LIA·RETRACE의 고정 SDK 해시는 유지한다. LIBRA에는 수정한 store/representation 커널을 동기화한다.

이 패치는 N01의 전체 영속 인덱스, N02의 추가 벡터 생산자, N03의 실제 통합 reader 공급자를 연결한 것이 아니다. native GC와 설치 호스트/실제 모델 품질 gate도 계속 남는다. 구간 내 delta가 수정돼도 bounded source inventory의 `deltaComplete:false`를 전체 기록의 완료로 바꾸지 않는다.
