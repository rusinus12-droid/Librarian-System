# LIBRA 전체 구간 공통 인덱스 — 구현 계약

- 작성일: 2026-10-14 · 갱신일: 2026-10-15 · 버전: 1.6
- 조사 기준: `89fb341` 이후의 이 증분, N01-A 증분 원본 현재성 검증 및 N01-B 증분 구축·재개·대형 단일 행 분할
- 판정: **여러 원본 구간을 하나의 검색 그래프로 연결하고 공통 인덱스를 영속화·재사용한다. 신규 게시 index의 선택적 페이지 접근, owner 증분 증명(`N01-A`), 증분 구축·체크포인트 재개 및 대형 단일 행 분할(`N01-B`)을 연결했다. 전체 바이트 예산(`N01-C`) 및 대규모 성능 인증은 아직 미완성이다.**

## 1. 실제 사용 경로

`buildMemoryGraphCorpus()`를 명시적으로 실행하면 현재 scope·세계선·복원 epoch·owner view에서 정본/Micro의 owner cursor를 순회한다. 이전 게시 세대와 `projection:`의 구간별 슬라이스가 호환되면(`incremental_reuse`) 변경되지 않은 구간은 재열거하지 않고 변경·추가된 구간만 다시 열거하며, `maxWindowsPerStep` 옵션을 주면 단계별 `checkpoint:` 불변 레코드를 저장해 부분 root 게시 없이 다음 호출에서 이어받아(`checkpoint_resume`) 완주한다. State·로어북·대상 노드와 반복되는 자료는 identity별로 통합하며, 같은 ID의 내용이 구간 사이에서 달라지면 게시를 거부한다. 먼저 끝난 family는 마지막 구간을 유지해 처음으로 돌아가지 않는다. State의 근거가 나중 구간에서 발견되면 그 `derived_from` 관계도 같은 그래프에 참여한다.

합쳐진 그래프로 directory, 양방향 typed adjacency, lexical/entity/predicate/time postings, 역의존 표를 한 번 만든다. 각 표는 공통 page cache의 계상·pin/release를 거쳐 불변 byte page로 저장되며, 단일 행이 `pageBytes`를 초과하는 대형 허브/역의존 행은 결정론적 청크(`libra.graph_corpus_row_chunk.v1`)로 분할 저장하고 읽기 시 `rowDigest` 검증과 함께 재조립한다. 이 저장은 원본 자료나 문서 벡터를 새로 생산하지 않는다. 저장 위치는 해당 scope의 `memory-graph:v1:corpus:` 아래다.

GUI 진단 카드의 **전체 이력 인덱스 구축** 버튼과 등록 API가 같은 maintenance 함수를 호출한다. **인덱스 구축 취소**는 기존 store serial/복원/삭제/unload fence를 사용한다. 함수가 저장한 generation이나 GUI 상태는 모델 전달 권한이 아니다. GUI 버튼의 실제 설치 DOM 동작은 별도 E4 검증 대상이다.

`executeMemoryGraphUnifiedQuery()`의 사용 방식은 다음과 같다.

| 입력 | 동작 |
| --- | --- |
| 기본 `corpusMode:'auto'` | 호환되는 현재 게시 인덱스를 복원. 없으면 모든 owner cursor 구간을 열거한 같은 엔진의 `request_local_corpus`로 검색 |
| `corpusMode:'required'` | 게시 인덱스가 없으면 실패. 저장된 전체 구간 검색의 확인용 API |
| `corpusMode:'window'` 또는 명시적 limit/nodeLimit/cursor | 호출자가 지정한 원본 구간 검색. `required`와 구간 옵션을 함께 주면 거부 |
| 내용·tokenizer 버전이 낡음 | auto는 현재 전 구간 원본에서 같은 엔진으로 검색. required는 실패 |
| 인덱스 손상·route/reset 변경 | 실패. query가 저장 인덱스를 repair하거나 legacy 검색으로 전환하지 않음 |

기본·유일한 unified의 Classic recall/beforeRequest·GUI 검색, GRADIA SHADOW/AIDE, GRADIA 인풋 작성기가 이 동일한 경로를 사용한다. GRADIA에는 `engine.corpusRead`를 설명용 metadata로 전달하며 기존 owner 선택 영수증·읽기 출처·제안 봉인·현재성 검사를 유지한다. 별도 인덱스 구축이나 opt-in은 기본 검색의 선행 조건이 아니다. 현재 기본·유일한 검색기와 실패 계약은 [전환 계약](LIBRA_UNIFIED_SEARCH_REPLACEMENT_CONTRACT_20261014.md)을 따른다.

## 2. 현재성·무결성·발송 권한

manifest의 namespace/key·크기·행수·offset·routing과 index metadata를 검증하고, 필요한 저장 page만 읽어 내용 digest·행수·routing을 대조한다. 이전 manifest와 명시적 전체 검증은 모든 표를 복원한다. 최신 계약은 [선택적 읽기](LIBRA_SELECTIVE_INDEX_READ_CONTRACT_20261014.md)를 따른다. 공통 Index의 `restore()`는 현재 native generation/partition과 결속하고 모듈이 실제로 발급한 객체만 rollout에 전달한다. cold/warm/축출/새 VM 모두 실제 사용하는 페이지를 검증한다. 요청의 첫 사용에서 cache hit가 디스크의 오염을 숨기지 않으며, 안 읽은 페이지의 손상은 전체 검증에서 검사한다.

owner cursor의 서명에는 runtime publication binding도 들어간다. 저장된 서명을 재시작 후의 내용 식별자로 쓰지 않는다. 매번 새 owner cursor로 순회하고 구간 순서·실제 native 행/frame binding·미독 구간의 유무를 비교한다. 이 수정은 양쪽 저장 모드의 실제 VM 재시작과 커널의 커서 변경·실제 내용 변경 대조 검사로 확인한다.

**저장 인덱스는 관련성을 찾는 자료다. 사실과 발송 권한은 owner가 검증한 현재성 증명과 소비된 물리 레코드 재확인에서 온다.** `buildMemoryGraphCorpus()`는 `proof:`(`libra.graph_corpus_source_proofs.v1`)와 `projection:`(`libra.graph_corpus_projection.v1`) 불변 레코드를 함께 게시하며, `verifyIncrementalSourceProofs()`(`N01-A`)가 정본 매니페스트 ref 테이블·엔티티 레지스트리·Micro 턴 페어/헤드·State 헤더/정정 저널·호스트 로어 스냅샷/링크 인덱스를 구간별로 대조한다. 증분 증명이 통과하면 변경되지 않은 과거 구간의 정본·Micro 본문 전체 재읽기를 생략하되(`nativeReprojectionRequired:false`), 최종 Compiler 발송 직전에는 채택·억제된 소비 readset의 물리 레코드 본문 digest와 조건부 readset을 반드시 재확인한다. 명시적 `verifyMemoryGraphCorpus()` 감사는 전체 구간 재투영(`eager_full_reprojection_audit`)을 수행한다.

server_only의 개별 source readset은 기존 SDK 한도인 64키를 유지한다. 전체 자료가 이를 넘으면 여러 readset으로 나누고 모두 최종 검증한다. 이를 전체 자료의 단일 원자적 snapshot으로 부르지 않는다. root 게시의 CAS는 root와 manifest에 한정한다. plugin_only의 root-last 게시도 cross-runtime 원자성을 주장하지 않는다. 게시 전후 전체 구간을 대조하며 뒤늦은 수정은 이후 읽기에서 거부된다. `ownerAtomicity:false`를 유지한다.

새 원본 구간·revision·삭제·복원·세계선 변경 후에는 기존 인덱스가 그대로 현재 자료를 대표한다고 간주하지 않는다. native cursor/frame/stamp 또는 최종 원본 검증이 이를 거부한다. 동일 frame의 낡은 저장 인덱스는 명시적 재구축으로 교체할 수 있다. query의 auto는 새 원본의 request-local corpus를 검색하고 저장하지 않는다. required는 누락/불일치를 거부한다.

## 3. 자원과 부분 결과

| 설정 | 기본값 | 허용 범위 |
| --- | --- | --- |
| 구간당 limit | 20 | 1–50 |
| 구간당 nodeLimit | 2048 | 1–8192 |
| maxWindows | 64 | 1–128 |
| maxWindowsPerStep | 무제한(일괄) | 1–maxWindows (지정 시 단계별 체크포인트) |
| maxSerializedBytes | 4 MiB | 64 KiB–8 MiB |
| pageBytes | 8 KiB | 512 B–16 KiB |
| 저장 index page 수 | 최대 512 | 고정 상한 |

`maxSerializedBytes`는 중복을 제거한 graph 행들의 JSON byte 합과 저장 index page byte 합에 **각각** 적용한다. 원본 본문, canonical row, Map/Set, 컴파일 중간값, 반환값, VM heap의 총량 제한이 아니다. JSON 원본 parse도 이 값으로 admission하는 것은 아니다. 디렉터리 manifest는 128 KiB 이하다. 한 행이 `pageBytes`보다 크면 결정론적 청크(`libra.graph_corpus_row_chunk.v1`)로 분할하고 `splitRow` 메타데이터와 `rowDigest`로 연속성·무결성을 검증하며, 청크 메타데이터 자체가 페이지 한도를 넘거나 청크가 손상되면 숨기지 않고 게시·읽기를 거부한다.

구축의 window/byte/page 예산이 부족하면 마지막 구간을 전체 자료처럼 게시하지 않는다. 이전 root는 유지되고, 이미 쓴 불변 page는 나중 재사용하거나 별도 GC 대상이 된다. 중간 쓰기가 끝날 때까지 build barrier를 유지하며 취소 후 새 build가 그 쓰기와 겹치지 않는다.

모든 cursor를 순회했다는 사실과 전체 owner inventory/delta를 증명했다는 사실은 다르다. 미지원 inherited Micro, 읽기 실패, node 예산 등 원본 coverage를 보존하고 `inventoryComplete:false`, `exhaustiveOwnerDeltaVerified:false`, `byteBounded:false`를 유지한다. query의 Lane/frontier/출력 예산에 따른 partial도 그대로 전달한다.

owner가 보고한 원본 읽기 실패는 `coverage.sourceReadFailures`로 보존한다. 마지막 구간까지 순회했더라도 새롭거나 미지원인 실패 사유를 이름 목록에서 놓쳐 `complete`로 올리지 않는다. 전 구간의 실패를 모아 query·접근 trace·GUI 진단에 전달한다. State의 알려지지 않은 근거나 모호한 이름 같은 의미상의 주석과 실제 원본을 읽지 못한 경우를 구분한다.

## 4. 검증과 남은 종료 조건

- 순수 corpus suite 14건: 53구간의 단일 인덱스, N01-A 53구간 증분 owner 증명(무재열거 검증·자료별 변이 거부·오염된 proof/projection 거부), N01-B 증분 구축(단일 창 수정·신규 창 추가 시 변경 없는 창 슬라이스 재사용 및 `maxWindowsPerStep` 다단계 체크포인트 재개), N01-B 대형 단일 행(`pageBytes:512`) 분할·재조립·변조 거부, cold/warm/축출/독립 runtime 복원, fresh 커서와 실제 내용 변경 구분, 첫 구간 밖 수정, warm 상태의 디스크 오염, 게시 실패·예산·취소, 외부 namespace 참조 거부, 잘못된 partition/generation/digest 거부.
- 등록 API suite 및 N01-A/N01-B 런타임: plugin_only/server_only의 실제 native reader·storage bridge로 첫 구간 밖 Micro 검색, 미소비 정본 본문 미읽기 및 소비된 Micro 본문 물리 변조 거부, Lore/State 변경 거부, 다단계 체크포인트 재개·신규 턴 추가 시 증분 창 재사용·대형 단일 행 분할(`pageBytes:2048`) 후 질의/전체 감사 통과.
- native 벡터 fixture: 어휘가 겹치지 않는 질의의 음성 대조와 저장 정본 벡터의 단일 frontier 참여, 질의 호출 1회/warm 0회, 실제 Classic beforeRequest의 최종 전달·검증. 30턴의 서버 fixture에서는 여러 64키 이하 readset을 관찰하고 원본을 읽지 못한 구간을 partial로 유지한다. 외부 모델 품질 측정은 아니다.
- 실제 GRADIA 합성 호스트: 저장 인덱스를 거친 SHADOW/AIDE와 명시적 인풋 작성기 전달 및 원본 수정 후 전달 차단. 실제 설치된 RisuAI나 외부 모델 품질 인증을 뜻하지 않는다.

주요 재현 명령은 다음과 같다. native suite는 로컬 테스트 서버와 기존 테스트 의존성이 필요하다.

```bash
node --test PROGRAM/tests/libra_memory_graph_corpus_test.cjs PROGRAM/tests/libra_memory_graph_incremental_currentness_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_corpus_runtime_test.cjs
node --test PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs
node --test PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
node PROGRAM/tools/sync_libra_gradia_unified_read.cjs --check
node PROGRAM/tools/check_sdk_sync.cjs
```

**N01은 아직 전체 완료가 아니다.** N01-A로 owner 증분 현재성 증명과 미소비 과거 구간 본문 재읽기 생략을, N01-B로 증분 구축·체크포인트 재개와 대형 단일 행 분할을 연결했으며, 다음 구현은 전체 자원·작업공간·I/O 바이트 예산(N01-C)이다. 현재 byte 합이나 `indexBuildsDuringQuery:0`을 전체 heap 제한·대규모 성능 합격으로 사용하지 않는다.

N07의 serving 전환은 수행했다. N02의 다른 family 표현 정책/생산·접근, N05의 안전한 실제 삭제, N06의 실제 호스트 품질·성능 측정은 여전히 미완료다. 벡터가 없는 자료는 현재도 동일 검색기의 lexical/entity/graph 경로로 참여한다.


## 5. 2026-10-15 증명·재개·GC 경계 보강

원본 body baseline은 graph 투영과 함께 캡처한 SHA-256으로 결속한다(`libra.source_proof_contract.v2`). 구간 간 같은 source key의 baseline이 달라지거나 proof capture에서 물리 본문이 달라지면 게시를 거부한다. v1 proof는 저장 읽기 호환을 유지하면서 전체 native 재투영 경로로 검증하며 과거 body baseline을 새 발송 권한으로 사용하지 않는다. 다시 유지보수 구축한 v2 세대부터 증분 재투영 생략을 사용한다.

checkpoint는 payload digest와 현재 owner 검증을 모두 만족한 slice만 재사용한다. proof 부재·null·변조·이전 계약은 새 열거로 처리한다. checkpoint key의 존재 자체나 불변 저장 API 호출은 source 현재성 증거가 아니다. checkpoint attempt 읽기/쓰기 상한은 기준 root별 128개이며, 변경/실패로 소진하면 `CHECKPOINT_BUDGET`으로 거부하고 단계 제한 없는 full build로 새 root를 게시할 수 있다.

native GC는 owner namespace의 원자적 publisher/build/reader 보호 기능이 없어 실제 삭제를 차단한다. 런타임 Map이나 per-root 조건부 batch를 atomic fence로 간주하지 않는다. inventory/dry-run은 유지하며 corpus/checkpoint/표현 전체의 도달성·원자적 삭제는 N05 후속이다. 상세 재현은 [리뷰](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261015.md)를 따른다.


## 6. 질의 중 owner I/O·JSON admission

N01-C1은 actual query의 root/manifest/proof/projection/page payload 접근을 요청의 durable byte/read quota에 계상하고 shared I/O allowance를 사전 예약한다. record JSON 처리와 분할 행의 결합·재조립은 공통 workspace 산식을 사용한다. 낮은 예산·shared backpressure·취소에서 저장 repair나 다른 검색으로 우회하지 않는다. 상세 설정·counter 단위·미측정 범위는 [자원 예산 계약](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)을 따른다. maintenance build/publication과 장기 보유 graph/index/표현은 아직 이 예산의 전체 보장 범위가 아니다.
