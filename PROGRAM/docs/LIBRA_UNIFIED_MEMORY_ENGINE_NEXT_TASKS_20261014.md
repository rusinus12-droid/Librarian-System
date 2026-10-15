# LIBRA 통합 메모리 엔진 — 다음 과제와 완료 기준

- 작성일: 2026-10-14 · 갱신일: 2026-10-15 · 문서 버전: 1.12
- 현재 코드 확인 기준: `codex/libra-memory-network-20261013`, `f8fce44` 리뷰와 후속 결함 수정. 최신 재현·수정은 [리뷰 §5](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261015.md#5-f8fce44-리뷰와-후속-수정)를 따른다.
- 관련: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [현황 §32](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), [선택적 읽기](LIBRA_SELECTIVE_INDEX_READ_CONTRACT_20261014.md), [평가 계약](LIBRA_UNIFIED_MEMORY_EVALUATION_CONTRACT_20261015.md), [GC 계약](LIBRA_STORAGE_LIFECYCLE_GC_CONTRACT_20261015.md)
- 판정: **단일 검색기·활성 소비자 연결은 구현됐다. 저장 재개와 평가 판정의 결함을 수정했으나, 선택적 표현 저장 접근(N01-e/N02), native owner의 원자적 GC(N05), 실제 품질·규모·설치 인증(N06)은 미완료다. 원본 증명 확대·전체 자원 상한(N01-a/b)도 남는다.**

이 문서는 최신 잔여 과제의 기준이다. 이전 버전의 증분별 설명을 현재 상태로 다시 정리했다. 구현 이력과 당시 검증은 [현황 §12–31](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md) 및 각 계약에 보존한다. N01-C1/C2의 현재 범위는 [자원 예산 계약](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)을 따른다. 이전 리뷰·패치 근거는 [2026-10-15 리뷰](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261015.md)와 현황 §23을 따른다. 과제 정의 자체를 구현·검증 완료로 읽지 않는다.

## 0. 전체 작업량과 완성까지의 거리

### 0.1 현재 위치

정본·Micro·State·로어가 하나의 graph/index·scorer/frontier·Memory Lane·Compiler를 사용하며 Classic·GUI·GRADIA 셰도우/AIDE·인풋 작성기에 연결된다. 레거시 serving 대체와 N00의 활성 소비자/역사 포맷 권한 분리는 유지한다.

`f8fce44`의 여러 완료 표기는 실제 연결보다 넓었다. `6689fe4`는 표현 verdict 우선 검사를 추가했지만 native vector 전체 hydration을 제거하지 않았다. `64990aa`는 주입 owner의 GC 계약 테스트이며 native SDK/server fence 구현은 없다. 8개 평가 fixture는 실제 owner·provider·설치 품질 인증을 대체하지 않는다.

### 0.2 남은 과제 묶음

| 묶음 | ID·상태 | 남은 결과물 | 상대 작업량 | 종료 근거 |
| --- | --- | --- | --- | --- |
| 저장 재개 | N01-c · 결함 수정 | 공개 API 간 일회용·기한부 재개 검증을 유지. runtime 재시작 이후 영속 재개는 지원하지 않음 | 유지 검증 | 동일 근거, query/view/access 결속, 만료·취소·실패·정원 초과 시 예약 해제 |
| 원본·대규모 운용 | N01-a/b/d · 부분 구현 | 원본 변경 증명 확대, 전체 자원 상한·선택적 재컴파일 및 지원 규모 검증. N01-d의 구축 동등성/CAS 테스트는 진척으로 인정 | 중간~큼 | 실제 모드별 I/O·retained/peak, 삭제·ABA·복원·경합·취소 대조 |
| 의미 표현 접근 | N01-e/N02 · 미완료 | 지원 표현을 실제 durable page/공통 cache/Lane으로 선택해 읽기. 추가 producer는 명시적 지원 범위로 결정 | 큼 | 불필요한 vector hydration 전후 실제 읽기·예약 비교, 호환성/현재성 검증 |
| 안전한 GC | N05 · native 삭제 차단 | SDK/server·저장 owner의 원자적 namespace fence와 build/reader lease, 실제 schema의 corpus/representation 회수 | 큼 | 독립 publisher·reader·재시작·만료/갱신·늦은 삭제 경합을 실제 owner에서 검증 |
| 품질·실사용 | N06-a/b/c | 합성 평가의 품질 범위 확장, 실제 provider·호스트·규모·소비자 전달의 인증 | 큼 | 고정 SHA/profile·사전 gate·raw 측정·반증 대조 |

N03/N04는 연결 구현 완료이며 실제 설치 검증을 마지막 묶음에 포함한다. Micro·State·로어 모두에 벡터를 의무화하지 않는다. 의도적 vectorless도 같은 검색기에서 유효하다. 완료율·남은 일수는 현재 근거로 산정하지 않는다.

### 0.3 다음 순서

1. N01-e/N02의 native 표현 선택 읽기를 우선 구현하고, 읽기·보유 비용을 실제 경로에서 측정한다.
2. N01-a/b의 증명·전체 상한과 선택적 재컴파일을 지원 profile별로 보강한다.
3. N05는 owner 프로토콜을 먼저 구현·검증한 뒤 삭제를 연결한다. 현재는 `blocked_atomic_gc_unavailable`을 유지한다.
4. N06-a는 단순 fixture PASS에서 실제 품질·반증 사례로 확대하고, N06-b/c는 고정 구현에서 실제 provider·설치·규모를 측정한다.

### 0.4 전체 완료 판정

각 묶음은 아래 세부 절의 완료 기준과 구현 커밋·실제 경로·검증/측정 근거를 함께 남긴 뒤 닫는다. 제한된 지원 profile의 합격과 미지원 범위를 공개하고, 알려진 미완료를 숨긴 채 전체 완료로 표기하지 않는다.

현재 `byteBounded:false`, `ownerAtomicity:false`, `inventoryComplete:false`는 유지한다. 각 보장은 해당 지원 범위의 증거를 확보한 경우에만 개별 변경한다. fixture 통과, query 성공 또는 특정 예산 하나의 구현만으로 전체 규모·품질·설치 인증을 대신하지 않는다. 실제 구현·검증 이력은 [현황 §24–25](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), 세부 종료 기록 방식은 이 문서 §11을 따른다.

## 1. 확인한 실행 범위

| 대상 | 현재 구현·검증 범위 | 남은 범위 |
| --- | --- | --- |
| 단일 검색 | 네 자료가 한 graph/index·scorer/frontier·Memory Lane·Compiler를 사용. 정본 저장 벡터와 질의 임베딩도 같은 평가에 참여 | N01의 접근 비용, N02의 표현 확장, N06의 품질·규모 검증 |
| 영속 인덱스 | 전체 owner cursor 구간 구축·저장·재시작 후 재사용. 신규 manifest는 필요한 저장 페이지만 읽음 | 원본 증명 범위 확대·전체 자원 상한·지원 규모 검증 |
| LIBRA Classic·GUI | 기본 통합 검색과 Classic 최종 전달 연결. GUI 열람 질의는 provider 호출 없이 같은 lexical/graph 경로 사용 | 실제 설치 검증, coverage·실제 채택·비용 표시 점검 |
| GRADIA 셰도우·AIDE | 기본 LIBRA source는 unified_engine. private owner 영수증과 readonly 권한을 거쳐 실제 단계·최종 전달 연결 | 지원 profile에서 실제 설치·성능 인증 |
| GRADIA 인풋 작성기 | 별도 미전송 제안 세션·작성 버튼·생성/번역·선택/편집·복사/전송 검증 연결 | 지원 profile에서 실제 설치·성능 인증 |
| LIBRA Planner·SGA·Input Writer | 제품 실행 함수·공개 API·호스트 등록 퇴역. 커널의 일부 역사 packet 포맷은 보존 | N00의 호환 포맷·권한 계약 정리. 제품 실행 복원은 과제가 아님 |
| 레거시 검색 | 기본·유일한 serving은 unified. 기존 shortlist/RRF/MMR·catalog/블록/Micro head 준비·이전 renderer 실행 제거 | 회귀 방지·실제 호스트 검증. 전환을 새로 구현할 필요 없음 |

GRADIA는 현재 **server_only·readonly 승인·동일 native scope·수락한 data/reset·인증된 plugin channel**이 필요하다. 현재 G2 허용 모델·요청 형식의 제한도 유지한다. LIBRA owner의 plugin_only/mirror 지원을 GRADIA의 지원으로 확대 해석하지 않는다. HAYAKU·Flashback의 별도 서버 읽기는 각 owner의 기능이다.

저장 인덱스가 없거나 auto 모드에서 원본/tokenizer와 맞지 않으면 같은 엔진이 전 구간을 request-local로 읽는다. 저장 손상·권한/route/reset 변경은 거부한다. query가 영속 repair·문서 임베딩을 시작하거나 레거시 검색으로 돌아가지 않는다.

## 2. 과제와 기존 미완료 항목 대응

| ID | 우선순위·현재 상태 | 남은 과제 | 기존 항목 | 선행 조건 |
| --- | --- | --- | --- | --- |
| N00 | 구현 완료 (`0f65798`) | 활성 소비자와 역사 packet 포맷의 발송 권한 분리 완료 | M09/M15 | 현재 퇴역 계약 유지 |
| N01 | P1 · 부분 구현 | 저장 재개 결함 수정, 원본 증명·전체 상한·선택적 표현 접근 남음 | M02–M05 | 원본/예산 계약 |
| N02 | P1 · 부분 구현 | verdict 게이트는 연결, native 선택적 표현 저장 접근·지원 producer 정책 남음 | M06–M08 | N01-e |
| N03 | 연결 완료 | 셰도우·AIDE 실제 설치/지원 profile 인증 | M09/M10 | N06 |
| N04 | 연결 완료 | 별도 인풋 작성기 실제 설치/지원 profile 인증 | M09/M10/M15 | N06 |
| N05 | P1 · native 삭제 차단 | owner fence/lease와 실제 다계층 회수 미구현 | M11 | SDK/server owner 프로토콜 |
| N06 | 부분 구현 | 합성 평가 runner·검사 수정, 실제 품질·규모·설치 인증 남음 | M12/M14 | 고정 profile·raw 측정 |
| N07 | 전환 완료 | 단일 검색·설정 이관 회귀 유지 | M13/M15 | 기존 퇴역 계약 |


## 3. N00 — 활성 소비자와 호환 포맷 (구현 완료)

- `ACTIVE_PRODUCT_CONSUMERS`(`classic`, `gui`, `gradia`)와 `HISTORICAL_FORMAT_ONLY_CONSUMERS`(`planner`, `sga`, `input_writer`)의 권한 경계를 명확히 분리했다.
- 옛 `planner/sga/input_writer` formatter 지원은 저장/분석 포맷 호환을 위한 것일 뿐, 제품 실행 및 모델 발송 권한(`modelDispatchEligible`)을 획득할 수 없도록 컴파일러 및 런타임에서 차단했다.
- 물리적 정본 currentness 검증이 성공하더라도 역사 포맷에 대해서는 `modelDispatchEligible: false`가 유지되며, 스스로 발송 권한을 주장하거나 위조할 수 없다.
- `libra_memory_graph_consumers_test.cjs`에 N00 권한 격리 및 호환성 회귀 검증을 추가했다.

## 4. N01 — 전체 기록의 공통 영속 접근

### N01-a · 부분 구현 · 원본 증명의 보장 확대

`1aa630e`의 N01-A는 owner manifest/ref·registry·Micro pair/head/work·State/정정·호스트 lore를 대조해 변경되지 않은 구간을 재투영하지 않는다. 이번 패치는 **투영과 함께 캡처한 SHA-256 본문 baseline**을 `libra.source_proof_contract.v2`에 결속하고, 이후 capture에서 본문이 달라졌으면 게시를 거부한다. v1 게시물은 전체 native 재투영으로 읽으며 과거 baseline을 새 권한으로 사용하지 않는다. 채택·억제·연결 의존성의 본문은 최종 private 검증으로 확인한다.

**남은 범위:**

- manifest/ref/head가 바뀌지 않은 **미소비 원본의 직접 저장 변조**까지 증분 head 증명이 검출하는 것은 아니다. 저장 키별 강한 revision/digest·존재/tombstone 증명이 필요하면 SDK·서버·capability·readonly 권한·응답 예산까지 실제 연결한다. metadata-only proof API는 아직 없다.
- server_only는 여전히 모든 source key를 여러 64키 조건부 readset으로 캡처·검증하며 SDK가 본문을 읽는다. plugin_only의 미소비 본문 생략을 server_only의 같은 비용 절감으로 일반화하지 않는다.
- native 대화/로어·설정, scope·세계선·restore epoch·data/reset·route/connection은 자체 검증을 유지한다. 원자적 revision이 없는 경로의 A→B→A 감지는 보장하지 않는다. 여러 readset은 전체 원본 atomic snapshot이 아니다.

**완료 기준:** full-reread 대조와 동일 근거/현재성, 저장 모드별 실제 source I/O 감소, 변경·삭제/재생성·ABA·복원·viewer/시간·profile/route/data/reset·await 중 변경/취소/늦은 응답 검증을 갖춘다. 지원하지 않는 owner 범위는 재읽기 또는 명시적 partial/reject로 남긴다. manifest/cache hit·public DTO digest만으로 발송 권한을 만들지 않는다.

### N01-b · P1 · 원본부터 출력까지 자원 계상·admission — N01-C1/C2 부분 연결

현재 `maxStoragePages/maxStorageBytes`는 **인덱스 JSON payload** 접근 예산이다. N01-C1에서는 실제 scoped source reader와 LIBRA SDK readset, corpus root/proof/projection/page 접근에 요청별 byte/read quota와 공유 I/O 예약을 연결했다. JSON 처리/분할 재조립은 공통 page 계층의 workspace 산식으로 미리 예약한다. 실패 latch·취소/late 응답 해제와 `resourceAccess` trace를 추가했다. [계약·실제 검증](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)을 따른다.

**구현 N01-C2:** 명시적 graph/index/semantic/eligibility·private readset·packet 보유 추정을 공통 pool에 예약한다. 코퍼스 build/publication·eager audit, 반복 검증 scope, Classic 문맥 축출·GRADIA receipt 취소/만료/dispose·compiler 무효화의 해제를 연결했다. active 작업은 종료될 때까지 예약을 유지한다.

**남은 N01-b:** 보유 추정 산식의 실제 profile 검증, 미등록 할당/host cache/hash·serialization scratch 및 진단용 단일 구간 Store 유지보수의 계상 확대, Page/Resource pool을 포함한 전체 한도 증명이다. 호스트 context/route bootstrap과 HTTP envelope/transport buffer를 포함한 bounded response/stream protocol도 증명이 필요하다. 현재 I/O 예약 peak나 JSON workspace 추정을 실제 네트워크/heap peak로 사용하지 않는다.

**작업:** 비용 범주별 counter와 admission/backpressure를 실제 읽기·할당 경로에 연결한다. 누적 전송량, 동시에 보유한 resident/staging, peak heap, 문자·token 예산을 분리한다. page cache 외 별도 무계상 full-array/cache 우회를 만들지 않는다.

**완료 기준:** cold/warm/축출/재시작·동시 요청·pending I/O 취소에서 budget 종료가 partial/reject·미독 범위로 드러나고 pin/staging이 해제된다. 미측정은 `null`과 사유로 표시한다. 지원 profile의 전체 상한을 증명하기 전 `byteBounded:false`를 유지한다.

### N01-c · 저장 접근과 분할 재조립 재개 — 결함 수정

`ac1e2a1`의 커서는 같은 `corpus.read` 인스턴스에서만 재개됐고, storage budget stop에서 요청 scope가 남았다. 후속 수정은 runtime 공통 private staging에 완료 행/분할 조각만 보존한다. 공개 DTO에는 원문이나 권한을 넣지 않는다.

- root·partition·generation·index·QueryFrame·logical access·offset/pageBytes에 결속한다. 일회용이며 runtime 재시작·만료·취소 이후 재사용은 거부한다.
- 기본 수명 60초, 최대 16건, 건당 추정 16MiB·전체 64MiB이며 공통 resource pool에도 예약한다. 정원 초과는 명시적 거부다.
- 공개 API를 두 번 호출해 새 reader로 재개하고, 세 저장 모드에서 전체 읽기와 같은 채택 근거 및 완료/취소 후 예약 0을 확인한다.
- 이는 저장 접근의 진행 재개다. 전체 검색 frontier·이전 결과·private 발송 권한을 보존하는 영속 세션은 아니다. 작은 예산에서 매번 전체 검색 완료를 보장하지 않는다.

검증: `libra_memory_graph_selective_index_test.cjs`, `libra_memory_graph_review_f8_runtime_test.cjs`.

### N01-d · 구현 완료 (2026-10-15, `c689559`) · 증분 구축·취소 후 재개·게시

증분 체크포인트 기반 구축과 전체 재구축(`full rebuild`)의 동등성을 확립하고, 취소 및 CAS(Compare-And-Swap) 충돌 복구를 구현했다.

- **전체 재구축 동등성:** 기존 캐시 없이 처음부터 전체 그래프를 재구축한 결과와 증분 체크포인트로 재개한 결과의 인덱스 다이제스트, 디렉터리, 4채널 포스팅이 정확히 일치함을 확인했다 (`libra_memory_graph_corpus_test.cjs`).
- **원자적 CAS 게시:** 다른 퍼블리셔가 루트를 먼저 갱신한 경우 CAS 충돌(`root_conflict`)을 감지하여 덮어쓰지 않고 안전하게 거부한다.
- **취소 및 재개:** 빌드 중 취소되더라도 이전 유효 루트가 손상되지 않으며, 다음 빌드 시 유효한 최근 체크포인트에서 안정적으로 재개한다.

### N01-e · P1 · semantic 접근·관찰의 나머지 연결

`6689fe4`는 `representationDecisions`를 주입 벡터보다 먼저 검사하도록 고쳤다. native bridge는 여전히 canonicalRows를 순회하며 벡터를 hydrate하고, semantic Lane은 directory를 읽는다. 이 게이트를 선택적 vector 저장 읽기의 완료로 취급하지 않는다.

**남은 구현:** 실제 표현 page/ref를 index·공통 cache·Lane에 연결하고, 공간/본문/profile/view/reset 검증과 원본 source access를 유지한다. 선택하지 않은 표현의 실제 I/O·보유 예약이 발생하지 않는 것을 cold/warm/축출·장애·재시작에서 측정한다.

**N01 전체 완료 조건:** 전 구간 도달·현재성·선택적 읽기를 유지하며 N01-a/b/e의 증거를 갖춘다. `nativeReprojectionRequired`, `inventoryComplete`, `ownerAtomicity`, `byteBounded`는 각각의 실제 보장 범위로만 변경한다.

## 5. N02 — 자료별 semantic 표현 — 부분 구현

정본 global 저장 벡터와 실제 질의 임베딩은 같은 scorer/frontier에 참여한다. 다중 family verdict 우선 검사도 연결됐다. 추가 표현 producer와 실제 선택적 저장 접근은 지원 범위를 정해 구현해야 한다. Micro·State·로어에 벡터를 강제하지 않으며 vectorless 참여는 유지한다. 주입 representation fixture의 PASS를 native producer·선택 읽기 구현 증거로 바꾸지 않는다.

## 6. N03 — GRADIA 셰도우·AIDE 연결

**연결 구현 완료, E4 미완료.** native unified query/compiler → private 영수증 → 인증된 channel → 고정 readonly SDK → SHADOW/AIDE → 최종 handoff를 제어된 등록 호스트·SQLite에서 검증했다. 기본 연결·이전 저장 source 이관도 구현됐다.

남은 일은 N06에서 실제 설치의 지원 profile을 검증하고 N01 변경 시 이 소비자의 currentness/예산 회귀를 확인하는 것이다. 원본·source·route/reset·권한 변경·영수증 위조·취소/늦은 응답은 근거와 draft를 무효화해야 한다. 공개 DTO로 권한을 대체하거나 GRADIA에 owner 쓰기 권한을 주지 않는다.

계약·지원 제한: [GRADIA 통합 읽기](LIBRA_GRADIA_UNIFIED_READ_CONTRACT_20261014.md).

## 7. N04 — GRADIA 인풋 작성기의 별도 통합 읽기

**연결 구현 완료, E4 미완료.** 명시적 작성 버튼의 RP/Novel 생성·번역과 선택/편집·복사/전송이 별도 `LibWriterReadConsumer`·operation·proposal hash·기준 native context를 사용한다. 미전송 제안은 `factAdopted:false`이며 셰도우 세션을 빌리지 않는다.

남은 일은 N06의 실제 설치 검증이다. N01 변경 후에도 입력/편집·연결/권한·원본 변경, 재생성·취소·늦은 응답, sendChat 권한 대기 중 변경에서 이전 draft 전달을 차단해야 한다. 선택·복사만으로 정본/State를 쓰거나 자동 입력 handler를 복원하지 않는다.

계약·지원 제한: [인풋 작성기 읽기](LIBRA_GRADIA_INPUT_WRITER_READ_CONTRACT_20261014.md).

## 8. N05 — GC와 수명주기 — native 삭제 차단

`64990aa`의 generic store는 주입 owner가 제공한 fence/build/reader 목록을 처리한다. 전용 7개 mock 테스트는 이 조건부 계약의 증거다. 실제 native owner는 여전히 `fence:null`이며 조건부 삭제 adapter가 없다. SDK/server 프로토콜을 구현하지 않았으므로 N05는 미완료다.

코퍼스 namespace는 전부 보존하며 checkpoint·projection 본문을 작은 store decode 한도로 읽지 않는다. dry-run은 관찰만 수행하고 실제 삭제는 `blocked_atomic_gc_unavailable`, `deletedKeys:[]`다. 표현 자산도 실제 회수하지 않는다.

**다음 구현/완료 기준:** 완전한 durable inventory와 독립 publisher/reader를 포함하는 원자적 namespace fence, build 작업 키·reader lease의 durable 발급/갱신/해제/만료, 실제 corpus `refs/sourceProofs/windowSlices` schema의 도달성·조건부 회수를 구현한다. 두 VM·재시작·새 root 게시·ABA·늦은 응답 경합 검증 뒤에만 native 삭제를 활성화한다. [GC 계약](LIBRA_STORAGE_LIFECYCLE_GC_CONTRACT_20261015.md)을 따른다.

## 9. N06 — 품질·비용·실제 호스트

### N06-a · 합성 평가 기반 연결, 실제 품질 인증은 미완료

8개 fixture와 runner는 존재한다. 후속 수정은 기대 outcome·필수 family·drop·흡수·각 예산을 모두 검사하고 미지원 criterion을 거부한다. 어휘 ablation은 같은 엔진에서 semantic/entity/predicate seed·관계 확장을 끄며 같은 viewer/시점·consumer 정책의 최종 채택 묶음을 비교한다. graph-only/vector-only 반증도 추가했다.

현재 8/8 PASS는 **합성 커널 fixture**의 결과다. UME-02는 owner cursor의 실제 창 밖 읽기를 검증하지 않고, UME-04는 명시적 제외 입력을 포함하며, UME-07은 외부 provider 장애를 호출하지 않는다. UME-05에는 실제 future/다른 세계선/private 반례를 넣었다. native provider 장애·실제 소비자 연결은 별도 회귀로 확인하며 합성 결과를 설치 인증으로 확대하지 않는다.

[평가 계약](LIBRA_UNIFIED_MEMORY_EVALUATION_CONTRACT_20261015.md)에 검사·미측정 범위를 고정한다. 품질 사례 확대, 실제 corpus relevance 정답·signal별 대조·과거 baseline artifact 비교는 남는다. `calibration:unmeasured`를 유지한다.

### N06-b · P1 · 실제 embedding provider와 규모 측정

제어 HTTP 벡터의 계약 검사를 실제 모델의 검색 품질과 구분한다. recall/근거 정확성·현재성 오류·partial, p50/p95 latency·peak memory·원본/인덱스 I/O·cache/pin·provider 호출/실패 비용을 지원 profile에서 측정한다. 선택적 인덱스 fixture의 감소량을 전체 latency/heap/네트워크 개선으로 보고하지 않는다. 기존 대규모 OOM/BLOCKED 기록의 제한은 유지한다.

### N06-c · P1 · 실제 설치 RisuAI 인증

Classic·GUI·GRADIA 셰도우/AIDE·인풋 작성기의 실제 발송/복사/전송, 취소·복원·원본/설정/권한 변경, 재시작·동시 요청을 확인한다. LIBRA owner 저장 모드와 GRADIA server_only 조건을 별도로 기록하고, 지원하지 않는 모델·호스트 채널·규모를 명시한다.

**완료 기준:** 구현 SHA, 실제 host/provider·설정·workload, 사전 합격 수치, raw 측정과 결과가 재현 가능하다. E1 커널·E2 등록 API·E3 합성 소비자 PASS를 E4 설치 인증으로 바꾸지 않는다. profile별 합격과 미지원 범위를 함께 공개한다.

## 10. N07 — 기본값 전환과 중복 경로 종료

`9c03c35`에서 기본·유일한 serving 전환과 기존 실행 제거를 수행했다. `legacy/shadow`는 출처를 기록하며 unified로 정규화하고, GRADIA LIBRA의 이전 logical source도 같은 승인 범위에서 unified로 이관한다.

**남은 유지 조건:** 설정/백업/재시작·진단/GUI 경로가 퇴역 helper나 옛 ranker·catalog 준비·중복 prompt 주입을 재개하지 않는다. cold/stale도 같은 엔진을 쓰고, 손상/권한 오류는 기존 실패 계약을 따른다. 품질·성능 인증은 N06이며 전환을 미구현으로 되돌려 표기하지 않는다.

## 11. 실행 순서·검증·종료 기록

권장 다음 구현은 **N01-e/N02의 실제 선택적 표현 접근**이다. N01-b의 전체 상한 증명, N01-a의 증명 확대와 N01-d의 선택적 재컴파일은 owner 기능·계측 근거에 맞춰 진행한다. N06-a 품질 사례 보강과 N00 회귀를 함께 유지하고, N02는 N01-e와 맞추어 진행한다. N05는 owner 기능을 먼저 구현·검증하고 삭제를 연결한다. N06-b/c의 최종 인증은 해당 변경이 고정된 뒤 수행한다.

기존 회귀 검사의 시작점은 다음과 같다. 아래 명령의 존재는 미래 증분의 완료 증거가 아니며, 실제 실행 결과와 재현 범위는 현황 §23–25 및 리뷰 문서에 기록한다. 후속 구현도 같은 방식으로 근거를 추가한다.

| 변경 경계 | 기존 검사·기록 |
| --- | --- |
| N01 원본/영속 접근 | `libra_memory_graph_corpus_test.cjs`, `libra_memory_graph_corpus_runtime_test.cjs`, `libra_sdk_conditional_batch_v1_test.cjs`, `libra_memory_graph_inventory_store_test.cjs`, `libra_memory_graph_review_boundaries_runtime_test.cjs`, `libra_memory_graph_resources_test.cjs`, `libra_memory_graph_resources_runtime_test.cjs` |
| N01 index/cache/Lane | `libra_memory_graph_selective_index_test.cjs`, `libra_memory_graph_selective_runtime_test.cjs`, `libra_memory_graph_pages_test.cjs`, `libra_memory_graph_query_test.cjs`, `libra_memory_graph_rollout_test.cjs` |
| N02 표현/producer | `libra_memory_graph_representation_test.cjs`, `libra_memory_graph_producer_policy_test.cjs`, `libra_memory_graph_semantic_runtime_test.cjs` |
| N03/N04 소비자 | `libra_gradia_unified_pipeline_runtime_test.cjs`, `libra_input_writer_unified_native_runtime_test.cjs`, `gradia_input_writer_unified_runtime_test.cjs`, `libra_gradia_unified_read_source_test.cjs` |
| N05 게시/GC 경합 | `libra_memory_graph_store_test.cjs`, `libra_memory_graph_patch_contract_test.cjs`, `libra_memory_graph_patch_runtime_test.cjs` |
| N00/N07 전환·퇴역 | `libra_helper_retirement_runtime_test.cjs`, `libra_unified_search_replacement_runtime_test.cjs`, `libra_memory_engine_mode_test.cjs` |

모든 파일은 `PROGRAM/tests/` 기준이다. 실제 변경 경로에 맞는 양성·음성 대조를 추가하고, SDK/커널 변경 시 내장 코드 동기화와 고정 SDK pin을 확인한다. 배포 manifest/checksum도 갱신한다.

과제 마감 시 `ID·수정 커밋·실제 API/소비자 경로·정상/거부 검증·측정값·지원 profile·남은 한계`를 [현황 문서](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)에 기록한다. 전체 완성은 지원 profile에서 설계의 원본/시간/권한·저장/예산·단일 검색·소비자/최종 발송·품질/설치 gate를 증거로 충족할 때 판정한다. 미지원 native 프로토콜 때문에 불가능한 보장은 blocked로 공개한다.

## 12. `9a61245` 리뷰 후 네 결함 패치

이 절은 기존 링크를 보존하는 이력 요약이다. 통합 SDK의 provider 전후 route/reset/connection 검사, GRADIA readSource 봉인, representation의 viewer/taskPair/profileDigest 비교, source 내용 수정과 window identity 분리를 패치했다. 당시 직접 회귀는 세 파일 38개 검사였다. 이후의 실제 공급자·corpus index·선택적 접근·레거시 전환은 [현황 §16–20](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)에서 추적한다.

이전 버전의 “GRADIA unified 공급자 미연결”, “기본값 전환은 후속”, “미독 cursor 질의 도달 미구현”, “표 전체 hydration” 설명은 당시 증분의 한계이며 현재 잔여 과제가 아니다. 반대로 N01의 전체 원자성/총 자원 보장, N02 추가 producer, N05 실제 삭제, N06 E4 인증은 이번 정리로 닫지 않는다. N01-A/B의 구현 진척과 이번 안전 경계 패치는 §4 및 현황 §21–23을 우선한다.


## 13. 동기화 후 6개 스위트 재지정 (퇴역 전제 정리)

`25cbd13`을 로컬에 동기화한 뒤, **통합 전용 정책과 LIBRA owner 읽기 계약이 퇴역시킨 전제를 그대로 들고 있던 스위트 6개**가 실패하는 것을 확인했다(정책 커밋에서 어느 파일도 수정되지 않았다). 삭제 대신 새 정책으로 재지정했다.

| 스위트 | 퇴역한 전제 | 재지정 내용 |
| --- | --- | --- |
| `gradia_readonly_cross_project_test` | SQLite→서버 읽기→SDK→GRA | 픽스처 owner 읽기(`tests/fixtures/libra_owner_unified_read_provider.cjs`)가 같은 `memory-suite.libra-read-session.v1` 봉투로 서빙. SQLite 행 불변·operations 0·교체 후 초안 무효화는 유지하고, 서버 읽기 엔드포인트가 **근거에 전혀 쓰이지 않음**을 단언 |
| `review_readonly_worst_escape_test` | 32MiB NUL + 소형 항목을 서버 읽기로 | 같은 owner 읽기로 서빙. 선택/생략·예산 단언 유지 |
| `composed_reanalysis_gradia_runtime_test` | 위와 같음 + 정본 교체 | owner 읽기가 LIBRA 정본(`fx.getMemory()`)을 읽어 교체가 자연히 반영된다. tag-only 편집은 근거를 유지하고, 서버 읽기 미사용을 단언 |
| `gradia_three_owner_consumer_test` | 서버 읽기 클라이언트가 출처 미보고 | 응답 출처와 `engine.sourceByOwner`를 보고. **LIBRA=통합 엔진, hayaku·flashback=각자의 서버 읽기**임을 단언으로 고정 |
| `tests/gradia/server-read-adapter.test` | 두 픽스처가 출처 미보고 | 서빙한 출처를 보고 |
| `libra_memory_graph_patch_runtime_test` | legacy 선택 시 legacy rescue 실행(양성 컨트롤) | **음성 컨트롤로 전환**: 퇴역 선택은 unified로 이관되고 `retiredSelection: 'legacy'`로 공개되며 rescue는 0회. 변환은 앵커 존재를 스스로 단언해 컨트롤이 조용히 무의미해지지 않게 했다. 물리 원본 변경 거부는 엔진 자체 코드(`CORPUS_SOURCE_CHANGED`)도 수용 |

실측: 6개 통과(`three_owner_consumer` 6, `server-read-adapter` 50, `patch_runtime` 3, `cross_project` 1, `worst_escape` 1, `composed` 1). GRADIA·SDK 계열 9/9, 그래프·정책·표시·N03 계열 32/32, 게이트·체크섬 통과.

## 14. 전수 스윕과 귀속 (전체 회귀는 아직 이르다)

`tests/*.cjs` 전수(1,230개; 레포 배치 대상은 `*_test.cjs`/`*.test.cjs` 1,189개)를 스위트당 150초 제한으로 돌려 **646개까지 확인**한 뒤 중단했다. 기능 작업이 진행 중인 시점의 전체 회귀는 릴리스 관문이고, 지금 필요한 정보는 **귀속**이었기 때문이다.

**귀속 (레포 자체 배치로 검증)**: 실패군을 `main`(`a9549e05`, 브랜치 이전)과 현재 트리에서 **`run_regression_batch.py`로 각각 실행**해 비교했다. 원시 `node` 실행이 아니라 배치의 cwd·환경·타임아웃을 그대로 쓴 비교이며, 표본에서 원시 실행과 같은 결과가 나왔다(방법 차이 때문에 생긴 빨강이 아님).

| 스위트 | main | 현재 | 원인 |
| --- | --- | --- | --- |
| `compute_gui_and_libra_open_latency_contract_test` | PASS | **FAIL** | `MemorySuiteLibraComputeBridge`가 트리에서 사라짐(`9c03c35`). GUI 연결 패널은 여전히 `computeBridge`를 소비 |
| `compute_sdk_version_independence_test` | PASS | **FAIL** | 삭제된 `libra_recall_bm25f_compute_pilot_test.cjs` 참조 |
| `engine_consistency_v2_runtime_test` | PASS | **FAIL** | `debugBuildRecallBm25fInput` 제거(`9c03c35`) |
| `health_shared_owner_adapter_compatibility_test` | PASS | **FAIL** | LIBRA 캐시 repair가 현재 scope 캐시를 삭제하지 않음(다른 owner는 통과) |
| `gradia_three_owner_connection_test` | PASS | **FAIL** | connect·동의 계약 변경 |
| `gradia_three_owner_pipeline_test` | PASS | **FAIL** | owner·payload 계약 변경 |

**환경 클래스(main에서도 실패)**: `build_plugins_refusal_exit_test`는 macOS `/private/var` vs `/var` 경로 문자열 차이, `build_plugins_artifact_libra_readiness_test`는 빌드 산출물 디렉터리 전제조건 부재다. `authority_core3_runtime`·`authority_initial_qualification`·`authority_libra_source_closure`(`.test`)는 main에서도 실제 테스트가 실패한다(`AUTHORITY_QUARANTINED` 등). 즉 **이 머신에서는 main도 초록이 아니다** — 이 머신에 이전 배치 로그(`FULL_TEST_EXECUTION_LOG_*.txt`)가 없어 "main 전체 초록" 주장 자체를 로컬에서 확인할 수는 없었다.

| 뒤집힌 스위트 | 실패 형태 | 유형 |
| --- | --- | --- |
| `engine_consistency_v2_runtime_test` | `debugBuildRecallBm25fInput is not a function` | 퇴역 API 참조 (정책 stale) |
| `compute_sdk_version_independence_test` | 삭제된 `libra_recall_bm25f_compute_pilot_test.cjs`를 실행 | 퇴역 스위트 참조 |
| `compute_gui_and_libra_open_latency_contract_test` | `LibraMemoryCore must explicitly export its closure-owned Compute bridge` | export 계약 변경 — 확인 필요 |
| `gradia_three_owner_connection_test` | UI Connect·동의 v2 단언 실패 | 연결 흐름 변경 — 재지정 필요 |
| `gradia_three_owner_pipeline_test` | payload·owner 변경 단언 실패 | 읽기 경로 변경 — 재지정 필요 |
| `health_shared_owner_adapter_compatibility_test` | 34개 중 1개 (cache repair 범위) | 확인 필요 (실제 결함 가능) |

**추가 결함 (실측·귀속 확인)**: 모델 근거 블록에 내부 식별자·원시 JSON 누출.
`9a61245`에서 항목 0개·누출 0종 → 현재 24항목·7종 id 누출(`ce_person_02c035f3`, `ce_world_*`), 2개 항목은 내부 JSON 통째. 위치는 생성 `tools/libra_memory_graph_readers.cjs:251` (`text: JSON.stringify(items[itemIndex])`)와 전달 `tools/libra_memory_graph_compiler.cjs:266-278`. `libra_input_writer_phase06_authority_runtime_test`의 `doesNotMatch /ce_/` 검사가 이 결함을 잡으므로 **그 스위트는 의도적으로 빨강**이다(옛 문구 단언만 새 문장으로 갱신했고 누출 검사는 약화하지 않았다).

**메모**: `tests/*.cjs` 전체 스윕은 배치 대상이 아닌 도구·수동 하네스까지 실행한다(`apply_libra_phase06_from_baseline.cjs` code=2, `docs/gui-redesign/verification/...` 산출물 생성). 전체 회귀는 레포 자체 도구(`run_regression_batch.py`)로 릴리스 시점에 돌리는 것이 맞다.

