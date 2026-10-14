# LIBRA 전체 구간 공통 인덱스 — 구현 계약

- 작성일: 2026-10-14 · 버전: 1.0
- 조사 기준: `89fb341` 이후의 이 증분
- 판정: **여러 원본 구간을 하나의 검색 그래프로 연결하고 공통 인덱스를 영속화·재사용한다. 대규모 corpus의 선택적 페이지 접근과 원본 증분 검증은 아직 미완성이다.**

## 1. 실제 사용 경로

`buildMemoryGraphCorpus()`를 명시적으로 실행하면 현재 scope·세계선·복원 epoch·owner view에서 정본/Micro의 owner cursor를 끝까지 순회한다. State·로어북·대상 노드와 반복되는 자료는 identity별로 통합하며, 같은 ID의 내용이 구간 사이에서 달라지면 게시를 거부한다. 먼저 끝난 family는 마지막 구간을 유지해 처음으로 돌아가지 않는다. State의 근거가 나중 구간에서 발견되면 그 `derived_from` 관계도 같은 그래프에 참여한다.

합쳐진 그래프로 directory, 양방향 typed adjacency, lexical/entity/predicate/time postings, 역의존 표를 한 번 만든다. 각 표는 공통 page cache의 계상·pin/release를 거쳐 불변 byte page로 저장된다. 이 저장은 원본 자료나 문서 벡터를 새로 생산하지 않는다. 저장 위치는 해당 scope의 `memory-graph:v1:corpus:` 아래다.

GUI 진단 카드의 **전체 이력 인덱스 구축** 버튼과 등록 API가 같은 maintenance 함수를 호출한다. **인덱스 구축 취소**는 기존 store serial/복원/삭제/unload fence를 사용한다. 함수가 저장한 generation이나 GUI 상태는 모델 전달 권한이 아니다. GUI 버튼의 실제 설치 DOM 동작은 별도 E4 검증 대상이다.

`executeMemoryGraphUnifiedQuery()`의 사용 방식은 다음과 같다.

| 입력 | 동작 |
| --- | --- |
| 기본 `corpusMode:'auto'` | 현재 frame의 게시 인덱스가 있으면 사용. 없으면 기존 owner window로 읽고 `corpusRead.reason:'no_published_corpus'` 표시 |
| `corpusMode:'required'` | 게시 인덱스가 없으면 실패. 저장된 전체 구간 검색의 확인용 API |
| `corpusMode:'window'` 또는 명시적 limit/nodeLimit/cursor | 호출자가 지정한 원본 구간 검색. `required`와 구간 옵션을 함께 주면 거부 |
| 인덱스가 낡거나 손상됨 | 실패. query가 인덱스를 재구축하거나 첫 구간/legacy 검색으로 전환하지 않음 |

명시적 unified 모드의 Classic recall/beforeRequest, GRADIA SHADOW/AIDE, GRADIA 인풋 작성기가 이 동일한 경로를 사용한다. GRADIA에는 `engine.corpusRead`를 설명용 metadata로 전달하며 기존 owner 선택 영수증·읽기 출처·제안 봉인·현재성 검사를 유지한다. 전체 이력 인덱스 구축 자체가 기본 검색 모드를 바꾸지는 않는다. 기본값은 여전히 `legacy`다.

## 2. 현재성·무결성·발송 권한

읽을 때 모든 저장 표의 namespace/key·크기·digest·행수·offset과 index metadata를 검사한다. 공통 Index의 `restore()`는 현재 native generation/partition과 결속하고 모듈이 실제로 발급한 객체만 rollout에 전달한다. cold/warm/축출/새 VM 모두 같은 검사를 한다. cache hit가 디스크의 오염을 숨기지 않는다.

owner cursor의 서명에는 runtime publication binding도 들어간다. 저장된 서명을 재시작 후의 내용 식별자로 쓰지 않는다. 매번 새 owner cursor로 순회하고 구간 순서·실제 native 행/frame binding·미독 구간의 유무를 비교한다. 이 수정은 양쪽 저장 모드의 실제 VM 재시작과 커널의 커서 변경·실제 내용 변경 대조 검사로 확인한다.

**저장 인덱스는 관련성을 찾는 자료다. 사실과 발송 권한은 새로 읽은 native graph에서 온다.** query는 전체 owner 구간을 다시 읽고 게시 때의 각 구간 stamp와 대조한다. 최종 Compiler도 현재 native graph의 노드·관계·basis와 실제 원본 저장값, 설정/벡터 의존성을 다시 확인한다. 저장 표의 checksum만으로 원본 근거를 증명하지 않는다.

server_only의 개별 source readset은 기존 SDK 한도인 64키를 유지한다. 전체 자료가 이를 넘으면 여러 readset으로 나누고 모두 최종 검증한다. 이를 전체 자료의 단일 원자적 snapshot으로 부르지 않는다. root 게시의 CAS는 root와 manifest에 한정한다. plugin_only의 root-last 게시도 cross-runtime 원자성을 주장하지 않는다. 게시 전후 전체 구간을 대조하며 뒤늦은 수정은 이후 읽기에서 거부된다. `ownerAtomicity:false`를 유지한다.

새 원본 구간·revision·삭제·복원·세계선 변경 후에는 기존 인덱스가 그대로 현재 자료를 대표한다고 간주하지 않는다. native cursor/frame/stamp 또는 최종 원본 검증이 이를 거부한다. 동일 frame의 낡은 인덱스는 명시적 재구축으로 교체한다. 다른 frame에서 인덱스가 없으면 `auto`는 구간 검색임을 표시하고 `required`는 거부한다.

## 3. 자원과 부분 결과

| 설정 | 기본값 | 허용 범위 |
| --- | --- | --- |
| 구간당 limit | 20 | 1–50 |
| 구간당 nodeLimit | 2048 | 1–8192 |
| maxWindows | 64 | 1–128 |
| maxSerializedBytes | 4 MiB | 64 KiB–8 MiB |
| pageBytes | 8 KiB | 512 B–16 KiB |
| 저장 index page 수 | 최대 512 | 고정 상한 |

`maxSerializedBytes`는 중복을 제거한 graph 행들의 JSON byte 합과 저장 index page byte 합에 **각각** 적용한다. 원본 본문, canonical row, Map/Set, 컴파일 중간값, 반환값, VM heap의 총량 제한이 아니다. JSON 원본 parse도 이 값으로 admission하는 것은 아니다. 디렉터리 manifest는 128 KiB 이하다. 한 행이 page 예산보다 크면 숨기지 않고 게시를 거부한다.

구축의 window/byte/page 예산이 부족하면 마지막 구간을 전체 자료처럼 게시하지 않는다. 이전 root는 유지되고, 이미 쓴 불변 page는 나중 재사용하거나 별도 GC 대상이 된다. 중간 쓰기가 끝날 때까지 build barrier를 유지하며 취소 후 새 build가 그 쓰기와 겹치지 않는다.

모든 cursor를 순회했다는 사실과 전체 owner inventory/delta를 증명했다는 사실은 다르다. 미지원 inherited Micro, 읽기 실패, node 예산 등 원본 coverage를 보존하고 `inventoryComplete:false`, `exhaustiveOwnerDeltaVerified:false`, `byteBounded:false`를 유지한다. query의 Lane/frontier/출력 예산에 따른 partial도 그대로 전달한다.

owner가 보고한 원본 읽기 실패는 `coverage.sourceReadFailures`로 보존한다. 마지막 구간까지 순회했더라도 새롭거나 미지원인 실패 사유를 이름 목록에서 놓쳐 `complete`로 올리지 않는다. 전 구간의 실패를 모아 query·접근 trace·GUI 진단에 전달한다. State의 알려지지 않은 근거나 모호한 이름 같은 의미상의 주석과 실제 원본을 읽지 못한 경우를 구분한다.

## 4. 검증과 남은 종료 조건

- 순수 corpus suite 11건: 53구간의 단일 인덱스, cold/warm/축출/독립 runtime 복원, fresh 커서와 실제 내용 변경 구분, 첫 구간 밖 수정, warm 상태의 디스크 오염, 게시 실패·예산·취소, 외부 namespace 참조 거부, 잘못된 partition/generation/digest 거부.
- 등록 API suite: plugin_only/server_only의 실제 native reader·storage bridge로 첫 구간 밖 Micro 검색, 최종 private 검증, 읽기 중 저장/분석 호출 없음, 재시작·수정 거부.
- native 벡터 fixture: 어휘가 겹치지 않는 질의의 음성 대조와 저장 정본 벡터의 단일 frontier 참여, 질의 호출 1회/warm 0회, 실제 Classic beforeRequest의 최종 전달·검증. 30턴의 서버 fixture에서는 여러 64키 이하 readset을 관찰하고 원본을 읽지 못한 구간을 partial로 유지한다. 외부 모델 품질 측정은 아니다.
- 실제 GRADIA 합성 호스트: 저장 인덱스를 거친 SHADOW/AIDE와 명시적 인풋 작성기 전달 및 원본 수정 후 전달 차단. 실제 설치된 RisuAI나 외부 모델 품질 인증을 뜻하지 않는다.

주요 재현 명령은 다음과 같다. native suite는 로컬 테스트 서버와 기존 테스트 의존성이 필요하다.

```bash
node --test PROGRAM/tests/libra_memory_graph_corpus_test.cjs
node --test PROGRAM/tests/libra_memory_graph_corpus_runtime_test.cjs
node --test PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs
node --test PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
node PROGRAM/tools/sync_libra_gradia_unified_read.cjs --check
node PROGRAM/tools/check_sdk_sync.cjs
```

**N01은 닫히지 않았다.** 원본 전체 재투영과 공통 index 표 전체 hydration이 아직 필요하다. Lane은 복원한 공통 표의 query page를 읽으며 저장 shard를 직접 비동기 탐색하는 구조까지 이행하지 않았다. 다음 구현은 owner의 증분/근거 계약에 맞춘 원본 검증, 선택적 durable index·벡터 page 접근, build 재개·증분 교체와 전체 workspace/I/O admission이다. 현재 byte 합이나 `indexBuildsDuringQuery:0`을 전체 heap 제한·warm I/O 절감·대규모 성능 합격으로 사용하지 않는다.

N02의 다른 family 벡터 생산, N05의 안전한 실제 삭제, N06의 실제 호스트 품질·성능 측정, N07의 기본값 전환도 각각의 gate를 유지한다. 벡터가 없는 자료는 현재도 동일 검색기의 lexical/entity/graph 경로로 참여한다.
